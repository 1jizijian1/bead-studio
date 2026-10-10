/**
 * 把网格渲染成**图片**显示，而不是直接画在可见的 canvas 上。
 *
 * 为什么这么做：
 *   本项目环境里 `<canvas type="2d">` 出现了「内容确实画上去了
 *   （getImageData 能回读到正确的颜色）、节点稳定、位置尺寸都对，
 *   但屏幕上永远不显示」的情况 —— 编辑器和进度页都中招，
 *   排查了 8 轮，排除了颜色/时序/节点替换/overflow/wx:if/视口尺寸。
 *
 *   而 `canvasToTempFilePath` 是好的（导出图纸一直正常），
 *   所以改成：**渲染到隐藏画布 → 导出成图片 → 用 <image> 显示**。
 *   这条路径和「导出图纸」用的是同一套机制，绕开了画布显示问题。
 *
 * 代价：改一次内容要重新导出（约 50~200ms），所以：
 *   - 换色号 / 切显示模式 → 立刻重渲染
 *   - 点格子标记 → **防抖 350ms 后再重渲染**（连着点只渲染一次）
 */
const gridCanvas = require('./gridCanvas');
const canvasHelper = require('./canvasHelper');

/** 缩放档位：每格渲染成多少像素（越大越清晰、导出越慢） */
const ZOOM_STEPS = [1, 2, 3, 4];
/** 基础每格像素 */
const BASE_CELL_PX = 6;

function cellPxForZoom(zoom) {
  return BASE_CELL_PX * zoom;
}

/**
 * 渲染并导出成图片。
 * @param canvasNode 隐藏 canvas 的节点
 * @param {object} opts { dims, cellPx, getColor, bg }
 * @returns {Promise<string>} 临时文件路径
 */
async function renderToImage(canvasNode, opts) {
  const dims = opts.dims;
  const cellPx = opts.cellPx;
  const w = Math.max(1, Math.round(dims.N * cellPx));
  const h = Math.max(1, Math.round(dims.M * cellPx));

  canvasNode.width = w;
  canvasNode.height = h;
  const ctx = canvasNode.getContext('2d');
  if (!ctx) throw new Error('拿不到隐藏画布的 2d context');

  // 复用绘制内核。dpr=1、视图为单位变换 —— 画布上就是「一格 cellPx 像素」
  gridCanvas.draw(ctx, {
    cssW: w,
    cssH: h,
    dpr: 1,
    dims,
    view: { scale: 1, tx: 0, ty: 0 },
    bg: opts.bg || '#ffffff',
    getColor: opts.getColor,
    // 网格线很重要：只看当前色时背景是白的，**没有网格线就没法数格子定位**。
    // 所以门槛放到每格 3px（再小就糊成灰的了）。
    gridLines: cellPx >= 3 ? { color: 'rgba(0, 0, 0, 0.18)', width: 0.6, minCellPx: 3 } : null,
    border: { color: 'rgba(0, 0, 0, 0.3)', width: 1 },
  });

  return canvasHelper.exportCanvasToFile(canvasNode, w, h);
}

/**
 * 把手指位置换算成格子坐标。
 * @param clientX,clientY 视口坐标（touches[0].clientX/clientY）
 * @param rect 图片当前的 boundingClientRect（会随滚动变化）
 */
function hitTest(clientX, clientY, rect, dims) {
  if (!rect || !rect.width || !rect.height) return { i: -1, j: -1, inside: false };
  const cw = rect.width / dims.N;
  const ch = rect.height / dims.M;
  const i = Math.floor((clientX - rect.left) / cw);
  const j = Math.floor((clientY - rect.top) / ch);
  return { i, j, inside: i >= 0 && i < dims.N && j >= 0 && j < dims.M };
}

/** 查一个节点的屏幕位置和尺寸 */
function queryRect(selector, comp) {
  return new Promise((resolve) => {
    const q = comp ? wx.createSelectorQuery().in(comp) : wx.createSelectorQuery();
    q.select(selector)
      .boundingClientRect()
      .exec((res) => resolve(res && res[0] ? res[0] : null));
  });
}

module.exports = {
  ZOOM_STEPS,
  BASE_CELL_PX,
  cellPxForZoom,
  renderToImage,
  hitTest,
  queryRect,
};
