/**
 * 用小程序里同一套算法，在 Node 里跑真实原图，并导出成 PNG 便于肉眼比对。
 * 目的：把「算法错」和「小程序 Canvas 采样错」分开。
 */
const fs = require('fs');
const png = require('./png');
const palette = require('../utils/palette');
const { createMapper } = require('../utils/nearest');
const px = require('../utils/pixelation');
const { globalMerge } = require('../utils/merge');
const { computeStats } = require('../utils/stats');

const DIR =
  'C:/Users/727/xwechat_files/wxid_8snr5v7j6xs112_dec4/temp/RWTemp/2026-10/9e20f478899dc29eb19741386f9343c8/';
const SRC = DIR + 'd789f7974f002f7ba462d18cfa3365fa.png';
const OUT_PNG = 'C:/Users/727/Desktop/小程序/bead-studio/tools/repro-result.png';

// 命令行参数：N、阈值、模式
const N = parseInt(process.argv[2] || '100', 10);
const THRESHOLD = parseFloat(process.argv[3] || '8');
const MODE = process.argv[4] || 'dominant';
const MIN_REGION = parseInt(process.argv[5] || '0', 10);

const img = png.decode(fs.readFileSync(SRC));
console.log(`原图 ${img.width}x${img.height}`);

// ---- 模拟小程序里的采样：缩到长边 <=1600 ----
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
// 注意：真实小程序是 drawImage 缩放（带平滑），这里是最近邻，先看趋势
const imageData = { data: sampled, width: sw, height: sh };

const M = Math.max(1, Math.round((N * sh) / sw));
console.log(`采样 ${sw}x${sh} -> 网格 ${N}x${M}  模式=${MODE} 阈值=${THRESHOLD}`);

const full = palette.buildFullPalette();
const mapper = createMapper(full);

const grid = px.calculatePixelGrid(imageData, sw, sh, N, M, mapper, MODE);
console.log(`合并前颜色数：${Object.keys(computeStats(grid.data, grid.dims).colorCounts).length}`);

globalMerge(grid.data, grid.dims, mapper.palette, THRESHOLD);

if (MIN_REGION > 1) {
  const { despeckle } = require('../utils/cleanup');
  const r = despeckle(grid.data, grid.dims, MIN_REGION);
  console.log(`杂色清理(最小色块 ${MIN_REGION})：改 ${r.cellsChanged} 格，清掉 ${r.regionsRemoved} 个小块`);
}

const stats = computeStats(grid.data, grid.dims);
console.log(`合并后颜色数：${Object.keys(stats.colorCounts).length}，总格 ${stats.totalBeadCount}`);

// ---- 渲染成 PNG 供肉眼比对（每格 8px） ----
const cellPx = 8;
const W = N * cellPx;
const H = M * cellPx;
const out = Buffer.alloc(W * H * 4, 255);
const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
for (let j = 0; j < M; j++) {
  for (let i = 0; i < N; i++) {
    const c = grid.data[j][i];
    let rgb;
    if (c.isExternal) rgb = [243, 244, 246];
    else rgb = hexToRgb(c.color);
    for (let y = 0; y < cellPx; y++) {
      for (let x = 0; x < cellPx; x++) {
        const d = ((j * cellPx + y) * W + i * cellPx + x) * 4;
        out[d] = rgb[0];
        out[d + 1] = rgb[1];
        out[d + 2] = rgb[2];
        out[d + 3] = 255;
      }
    }
  }
}
fs.writeFileSync(OUT_PNG, png.encode(W, H, out));
console.log(`已写出 ${OUT_PNG} (${W}x${H})`);

// ---- 结果的明度分布，和原图对比 ----
const buckets = new Array(10).fill(0);
let n = 0;
for (let i = 0; i < W * H; i++) {
  const lum = 0.2126 * out[i * 4] + 0.7152 * out[i * 4 + 1] + 0.0722 * out[i * 4 + 2];
  buckets[Math.min(9, Math.floor(lum / 25.6))]++;
  n++;
}
console.log('结果明度分布(0暗->9亮):', buckets.map((v) => ((v * 100) / n).toFixed(1) + '%').join(' '));

// 统计用的颜色 Top 10
const sorted = Object.keys(stats.colorCounts)
  .map((hex) => ({ hex, ...stats.colorCounts[hex] }))
  .sort((a, b) => b.count - a.count)
  .slice(0, 10);
console.log('用量前 10 的颜色：');
sorted.forEach((c, i) => {
  console.log(`  ${i + 1}. ${c.hex}  ${c.count} 颗`);
});
