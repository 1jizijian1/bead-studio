/**
 * 「完成打卡」卡片生成。
 *
 * 和出图一样：画进**隐藏画布** → `canvasToTempFilePath` 导出成图片。
 * （本项目环境里可见 canvas 不显示，见 utils/gridImage.js 顶部说明。）
 *
 * 卡片 720x1080（2:3），竖版 —— 适合发朋友圈 / 聊天。
 */
const canvasHelper = require('./canvasHelper');

const W = 720;
const H = 1080;
const PAD = 48;

/** 按短边裁切填满目标框（不变形），加圆角 */
function drawCoverImage(ctx, img, x, y, w, h, radius) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;

  ctx.save();
  canvasHelper.roundRect(ctx, x, y, w, h, radius);
  ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

/** 把图按比例装进框里（完整显示，不裁切），返回画在哪 */
function drawContainImage(ctx, img, x, y, w, h) {
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
}

/**
 * @param canvasNode 隐藏 canvas 节点
 * @param {object} opts
 *   { name, dims, beadTotal, colorCount, dateText, photoImg, patternImg }
 *   photoImg / patternImg 是 `canvas.createImage()` 加载好的 Image（可能为 null）
 * @returns {Promise<string>} 卡片图片的临时路径
 */
async function renderCheckinCard(canvasNode, opts) {
  canvasNode.width = W;
  canvasNode.height = H;
  const ctx = canvasNode.getContext('2d');
  if (!ctx) throw new Error('拿不到卡片画布 context');

  // ---- 底：淡紫渐变 ----
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#EEF2FF');
  grad.addColorStop(0.55, '#FFFFFF');
  grad.addColorStop(1, '#F5F3FF');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // ---- 标题 ----
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#1F2937';
  ctx.font = 'bold 46px sans-serif';
  ctx.fillText('拼豆完成 🎉', PAD, 76);

  ctx.fillStyle = '#6B7280';
  ctx.font = '26px sans-serif';
  ctx.fillText(
    `${opts.dims.N}×${opts.dims.M} · ${opts.beadTotal} 颗 · ${opts.colorCount} 色`,
    PAD,
    142
  );

  // ---- 主图：有照片就用照片，没有就把图纸放大 ----
  const boxY = 210;
  const boxW = W - PAD * 2;
  const boxH = 560;

  ctx.save();
  ctx.shadowColor = 'rgba(17, 24, 39, 0.16)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = '#FFFFFF';
  canvasHelper.roundRect(ctx, PAD, boxY, boxW, boxH, 28);
  ctx.fill();
  ctx.restore();

  const inner = 16;
  const ix = PAD + inner;
  const iy = boxY + inner;
  const iw = boxW - inner * 2;
  const ih = boxH - inner * 2;

  if (opts.photoImg) {
    drawCoverImage(ctx, opts.photoImg, ix, iy, iw, ih, 20);
  } else if (opts.patternImg) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(ix, iy, iw, ih);
    drawContainImage(ctx, opts.patternImg, ix, iy, iw, ih);
  } else {
    ctx.fillStyle = '#F3F4F6';
    canvasHelper.roundRect(ctx, ix, iy, iw, ih, 20);
    ctx.fill();
  }

  // ---- 底部：图纸缩略图 + 日期 ----
  const footY = boxY + boxH + 44;
  const thumbBox = 132;

  if (opts.photoImg && opts.patternImg) {
    // 有照片时，右下角放一张图纸小图做对照
    ctx.fillStyle = '#FFFFFF';
    canvasHelper.roundRect(ctx, PAD, footY, thumbBox, thumbBox, 16);
    ctx.fill();
    ctx.save();
    canvasHelper.roundRect(ctx, PAD + 8, footY + 8, thumbBox - 16, thumbBox - 16, 12);
    ctx.clip();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(PAD + 8, footY + 8, thumbBox - 16, thumbBox - 16);
    drawContainImage(ctx, opts.patternImg, PAD + 8, footY + 8, thumbBox - 16, thumbBox - 16);
    ctx.restore();
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = '#9CA3AF';
  ctx.font = '24px sans-serif';
  ctx.fillText(opts.dateText, W - PAD, footY + 24);

  ctx.fillStyle = '#6B7280';
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(`${opts.beadTotal} 颗豆子`, W - PAD, footY + 68);

  // ---- 品牌 ----
  ctx.textAlign = 'center';
  ctx.fillStyle = '#C7D2FE';
  ctx.font = '22px sans-serif';
  ctx.fillText('拼豆图纸生成器', W / 2, H - 58);

  return canvasHelper.exportCanvasToFile(canvasNode, W, H);
}

module.exports = { renderCheckinCard, CARD_W: W, CARD_H: H };
