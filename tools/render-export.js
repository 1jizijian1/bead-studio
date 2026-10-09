/**
 * 把「导出图纸」在 Node 里真的渲染成 PNG，用于不开模拟器就检查排版。
 *
 * 做法：用一个 Canvas2D 的软渲染 shim 顶上 ctx，把 drawPattern 画进一块像素缓冲。
 * 文字不做字形渲染（省事），但会在每个 fillText 的锚点画一个小方块，
 * 用来确认文字位置没跑出画布。
 *
 * 用法："C:\Users\727\Desktop\node\node.exe" tools/render-export.js [N] [阈值] [杂色]
 */
const fs = require('fs');
const png = require('./png');
const palette = require('../utils/palette');
const { createMapper } = require('../utils/nearest');
const px = require('../utils/pixelation');
const { globalMerge } = require('../utils/merge');
const { despeckle } = require('../utils/cleanup');
const { computeStats } = require('../utils/stats');
const constants = require('../utils/constants');
const { planExport, drawPattern } = require('../utils/exportPattern');

const DIR =
  'C:/Users/727/xwechat_files/wxid_8snr5v7j6xs112_dec4/temp/RWTemp/2026-10/9e20f478899dc29eb19741386f9343c8/';
// 默认跑那张游戏截图；换图只要给环境变量 SRC 一个路径
const SRC = process.env.SRC || DIR + 'd789f7974f002f7ba462d18cfa3365fa.png';
const OUT_PNG = process.env.OUT || 'C:/Users/727/Desktop/小程序/bead-studio/tools/export-preview.png';

// ---------- Canvas2D 软渲染 shim ----------
function createCtx2D(w, h) {
  const buf = Buffer.alloc(w * h * 4, 255);
  const setPx = (x, y, r, g, b) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return;
    const o = (yi * w + xi) * 4;
    buf[o] = r;
    buf[o + 1] = g;
    buf[o + 2] = b;
    buf[o + 3] = 255;
  };

  let fillStyle = '#000000';
  let strokeStyle = '#000000';
  let lineWidth = 1;
  let fontSize = 12;
  let textAlign = 'left';
  let textBaseline = 'alphabetic';
  const path = [];
  let cur = null;

  const parseColor = (c) => {
    if (typeof c !== 'string') return [0, 0, 0];
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(c);
    if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    const rgba = /rgba?\(([^)]+)\)/.exec(c);
    if (rgba) {
      const p = rgba[1].split(',').map((s) => parseFloat(s.trim()));
      return [p[0], p[1], p[2]];
    }
    return [0, 0, 0];
  };

  const drawLine = (x0, y0, x1, y1, color, width) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    const half = Math.max(0, (width - 1) / 2);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = x0 + (x1 - x0) * t;
      const cy = y0 + (y1 - y0) * t;
      for (let dy = -Math.ceil(half); dy <= Math.ceil(half); dy++) {
        for (let dx = -Math.ceil(half); dx <= Math.ceil(half); dx++) setPx(cx + dx, cy + dy, ...color);
      }
    }
  };

  return {
    _buf: buf,
    _w: w,
    _h: h,
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(v) {
      fillStyle = v;
    },
    get strokeStyle() {
      return strokeStyle;
    },
    set strokeStyle(v) {
      strokeStyle = v;
    },
    get lineWidth() {
      return lineWidth;
    },
    set lineWidth(v) {
      lineWidth = v;
    },
    get font() {
      return fontSize + 'px';
    },
    set font(v) {
      const m = /(\d+(?:\.\d+)?)px/.exec(String(v));
      fontSize = m ? parseFloat(m[1]) : 12;
    },
    get textAlign() {
      return textAlign;
    },
    set textAlign(v) {
      textAlign = v;
    },
    get textBaseline() {
      return textBaseline;
    },
    set textBaseline(v) {
      textBaseline = v;
    },
    imageSmoothingEnabled: true,

    fillRect(x, y, rw, rh) {
      const c = parseColor(fillStyle);
      for (let yy = Math.round(y); yy < Math.round(y + rh); yy++) {
        for (let xx = Math.round(x); xx < Math.round(x + rw); xx++) setPx(xx, yy, ...c);
      }
    },
    strokeRect(x, y, rw, rh) {
      const c = parseColor(strokeStyle);
      drawLine(x, y, x + rw, y, c, lineWidth);
      drawLine(x + rw, y, x + rw, y + rh, c, lineWidth);
      drawLine(x + rw, y + rh, x, y + rh, c, lineWidth);
      drawLine(x, y + rh, x, y, c, lineWidth);
    },
    clearRect() {},
    beginPath() {
      path.length = 0;
    },
    moveTo(x, y) {
      cur = [x, y];
    },
    lineTo(x, y) {
      if (cur) path.push([cur[0], cur[1], x, y]);
      cur = [x, y];
    },
    stroke() {
      const c = parseColor(strokeStyle);
      for (const [x0, y0, x1, y1] of path) drawLine(x0, y0, x1, y1, c, lineWidth);
    },
    fill() {},
    measureText(t) {
      return { width: String(t).length * fontSize * 0.58 };
    },
    // 不做字形渲染，画个小方块标出锚点位置
    fillText(text, x, y) {
      const s = String(text);
      const wpx = s.length * fontSize * 0.58;
      let left = x;
      if (textAlign === 'center') left = x - wpx / 2;
      else if (textAlign === 'right') left = x - wpx;
      const size = Math.max(2, Math.round(fontSize * 0.35));
      const c = parseColor(fillStyle);
      for (let yy = 0; yy < size; yy++) {
        for (let xx = 0; xx < Math.min(wpx, size * 2); xx++) {
          setPx(left + xx, y - size / 2 + yy, ...c);
        }
      }
    },
    createLinearGradient() {
      return { addColorStop: () => {} };
    },
    save() {},
    restore() {},
    translate() {},
    scale() {},
    setTransform() {},
  };
}

// ---------- 跑流程 ----------
// 默认对齐 App 的出厂设置：成品宽 30cm + 5mm 标准豆 -> 60 格
const defaultN = parseInt(process.argv[2] || '60', 10);
const N = defaultN;
const THRESHOLD = parseFloat(process.argv[3] || String(constants.DEFAULT_THRESHOLD));
const MIN_REGION = parseInt(process.argv[4] || String(constants.DEFAULT_MIN_REGION), 10);

if (!fs.existsSync(SRC)) {
  console.error(`找不到源图：${SRC}`);
  console.error('用环境变量指定一张图，例如：SRC=D:/test.png node.exe tools/render-export.js');
  process.exit(1);
}
const img = png.decode(fs.readFileSync(SRC));
const maxEdge = 1600;
const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
const sw = Math.round(img.width * scale);
const sh = Math.round(img.height * scale);
const sampled = Buffer.alloc(sw * sh * 4);
for (let y = 0; y < sh; y++) {
  const sy = Math.min(img.height - 1, Math.floor(y / scale));
  for (let x = 0; x < sw; x++) {
    const sx = Math.min(img.width - 1, Math.floor(x / scale));
    const s = (sy * img.width + sx) * 4;
    const d = (y * sw + x) * 4;
    sampled[d] = img.data[s];
    sampled[d + 1] = img.data[s + 1];
    sampled[d + 2] = img.data[s + 2];
    sampled[d + 3] = img.data[s + 3];
  }
}

const M = Math.max(1, Math.round((N * sh) / sw));
const mapper = createMapper(palette.buildFullPalette());
const grid = px.calculatePixelGrid({ data: sampled, width: sw, height: sh }, sw, sh, N, M, mapper, constants.DEFAULT_MODE);
globalMerge(grid.data, grid.dims, mapper.palette, THRESHOLD);
despeckle(grid.data, grid.dims, MIN_REGION);

const stats = computeStats(grid.data, grid.dims);
const options = Object.assign({}, constants.DEFAULT_DOWNLOAD_OPTIONS);
const plan = planExport(grid.dims, options, constants.MAX_EXPORT_EDGE, Object.keys(stats.colorCounts).length);

console.log(`网格 ${N}x${M}，颜色 ${Object.keys(stats.colorCounts).length} 种`);
console.log(`导出画布 ${plan.w}x${plan.h}，每格 ${plan.cell}px，tooSmall=${plan.tooSmall}`);

const ctx = createCtx2D(plan.w, plan.h);
drawPattern(ctx, {
  grid: grid.data,
  dims: grid.dims,
  options,
  colorSystem: 'MARD',
  colorCounts: stats.colorCounts,
  totalBeadCount: stats.totalBeadCount,
  plan,
});

fs.writeFileSync(OUT_PNG, png.encode(plan.w, plan.h, ctx._buf));
console.log(`已写出 ${OUT_PNG}`);
