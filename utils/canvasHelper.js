/**
 * 小程序 Canvas 2D 封装：取节点、加载图、采样、导出、保存相册。
 *
 * 这一层专门隔离小程序 Canvas 与浏览器 Canvas 的差异，踩过的坑都写在注释里：
 *  - 取节点必须在 onReady 之后（onLoad 时 size 还是 0，画布宽度会变成 0）
 *  - 没有全局 Image，只能用 canvas.createImage()
 *  - 采样要在离屏画布做，否则会污染显示画布且尺寸对不上
 *  - 导出必须用页面里真实的 <canvas type="2d"> 节点，不支持离屏画布
 */

/** 兼容新旧基础库取窗口信息 */
function getWindowInfo() {
  if (wx.getWindowInfo) return wx.getWindowInfo();
  return wx.getSystemInfoSync();
}

function getPixelRatio() {
  return getWindowInfo().pixelRatio || 1;
}

/** 取 canvas 节点。在自定义组件里必须传 comp。 */
function selectNode(selector, comp) {
  return new Promise((resolve) => {
    const query = comp ? wx.createSelectorQuery().in(comp) : wx.createSelectorQuery();
    query
      .select(selector)
      .fields({ node: true, size: true })
      .exec((res) => {
        if (res && res[0] && res[0].node) resolve(res[0]);
        else resolve(null);
      });
  });
}

/**
 * 初始化**显示**画布：按 dpr 放大 backing store，并 scale(dpr)，之后所有坐标都用 CSS px。
 * @returns {{canvas, ctx, dpr, cssW, cssH}}
 */
async function initDisplayCanvas(selector, comp) {
  const info = await selectNode(selector, comp);
  if (!info) {
    // 最常见的两个原因写进报错里，省得下次还要查一遍
    throw new Error(
      `找不到画布节点 ${selector}。可能原因：① 外层有 wx:if，节点还没渲染出来（要先 setData 再取节点）；` +
        `② 在 onLoad 里取的（此时还没有尺寸，要用 onReady）；③ 选择器写错了`
    );
  }
  const canvas = info.node;
  const dpr = getPixelRatio();
  const cssW = info.width;
  const cssH = info.height;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { canvas, ctx, dpr, cssW, cssH };
}

/**
 * 初始化**导出**画布：1:1 物理像素，不做 dpr 缩放，
 * 保证输出与网页版一致（30px/格）。
 */
async function initExportCanvas(selector, comp, w, h) {
  const info = await selectNode(selector, comp);
  if (!info) throw new Error(`找不到导出画布节点：${selector}`);
  const canvas = info.node;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // 导出图不需要平滑，颜色要实心
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

/** 用指定 canvas 的 createImage 加载图片（小程序没有全局 Image） */
function loadImage(canvas, src) {
  return new Promise((resolve, reject) => {
    const img = canvas.createImage();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败，请换一张试试'));
    img.src = src; // 必须先绑 onload 再赋 src
  });
}

/**
 * 采样：把原图缩到长边 <= maxEdge 后取像素数据。
 *
 * 为什么要离屏：显示画布的 backing store 是 cssW*dpr，跟图片原始尺寸不同，
 * 直接 getImageData(0,0,原图宽,原图高) 会越界或读到缩放后的像素，还会污染预览。
 *
 * @returns {{imageData, sampleW, sampleH, sourceW, sourceH}}
 *   imageData.data 是 RGBA；sampleW/H 是实际采样尺寸（用它算网格边界）
 */
function sampleImageData(src, maxEdge) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src,
      success: (info) => {
        const longEdge = Math.max(info.width, info.height);
        const scale = Math.min(1, maxEdge / longEdge);
        const w = Math.max(1, Math.round(info.width * scale));
        const h = Math.max(1, Math.round(info.height * scale));

        let off;
        try {
          off = wx.createOffscreenCanvas({ type: '2d', width: w, height: h });
        } catch (e) {
          reject(new Error('当前微信版本过低，不支持离屏画布（需 2.16.1+）'));
          return;
        }

        loadImage(off, src)
          .then((img) => {
            const ctx = off.getContext('2d');
            ctx.clearRect(0, 0, w, h);
            // 用 img 自身的宽高算绘制尺寸：canvas 加载后已按 EXIF 矫正方向，
            // 可能与 getImageInfo 的宽高不同。按比例缩放可保证不被拉伸。
            const s = Math.min(w / img.width, h / img.height);
            const dw = Math.max(1, Math.round(img.width * s));
            const dh = Math.max(1, Math.round(img.height * s));
            ctx.drawImage(img, 0, 0, dw, dh);
            const imageData = ctx.getImageData(0, 0, dw, dh);
            resolve({
              imageData,
              sampleW: dw,
              sampleH: dh,
              sourceW: img.width,
              sourceH: img.height,
            });
          })
          .catch(reject);
      },
      fail: () => reject(new Error('读取图片信息失败')),
    });
  });
}

/**
 * 把页面里的导出画布导成临时文件。
 * @param {object} [opts] { destWidth, destHeight, fileType, quality }
 *   内容安全接口限制图片 ≤1MB，所以送检时要用缩小版（见 utils/contentCheck.js）
 */
function exportCanvasToFile(canvas, w, h, comp, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath(
      {
        canvas, // type=2d 必须传 canvas 节点，不是 canvasId
        x: 0,
        y: 0,
        width: w,
        height: h,
        destWidth: o.destWidth || w,
        destHeight: o.destHeight || h,
        fileType: o.fileType || 'png',
        quality: o.quality === undefined ? 1 : o.quality,
        success: (res) => resolve(res.tempFilePath),
        fail: (err) => reject(new Error((err && err.errMsg) || '导出图片失败')),
      },
      comp
    );
  });
}

/**
 * 保存到相册（含授权与降级）。
 * @returns {Promise<boolean>} 是否保存成功；失败时已降级为预览
 */
async function saveToAlbum(filePath) {
  const setting = await new Promise((resolve) => {
    wx.getSetting({ success: resolve, fail: () => resolve({ authSetting: {} }) });
  });

  const granted = setting.authSetting && setting.authSetting['scope.writePhotosAlbum'];
  if (!granted) {
    try {
      await new Promise((resolve, reject) => {
        wx.authorize({ scope: 'scope.writePhotosAlbum', success: resolve, fail: reject });
      });
    } catch (e) {
      // 用户之前拒绝过，引导去设置页
      const modal = await new Promise((resolve) => {
        wx.showModal({
          title: '需要相册权限',
          content: '请在设置中开启「添加到相册」，才能保存图纸',
          confirmText: '去设置',
          success: resolve,
          fail: () => resolve({ confirm: false }),
        });
      });
      if (modal.confirm) wx.openSetting();
      return false;
    }
  }

  try {
    await new Promise((resolve, reject) => {
      wx.saveImageToPhotosAlbum({ filePath, success: resolve, fail: reject });
    });
    wx.showToast({ title: '已保存到相册', icon: 'success' });
    return true;
  } catch (e) {
    // 保存失败就预览大图，用户可以长按保存
    wx.previewImage({ urls: [filePath] });
    return false;
  }
}

/**
 * 圆角矩形路径。部分机型/基础库没有 ctx.roundRect，
 * 直接用会在导出标题栏时崩掉，所以自己拼。
 */
function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** 高对比文字色：Luma > 0.5 用黑字，否则白字 */
function getContrastColor(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return '#000000';
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luma > 0.5 ? '#000000' : '#FFFFFF';
}

module.exports = {
  getWindowInfo,
  getPixelRatio,
  selectNode,
  initDisplayCanvas,
  initExportCanvas,
  loadImage,
  sampleImageData,
  exportCanvasToFile,
  saveToAlbum,
  roundRect,
  getContrastColor,
};
