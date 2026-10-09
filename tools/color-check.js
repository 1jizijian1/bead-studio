/**
 * 定位「暖调丢失」：比较
 *   A. 原图平均色
 *   B. 逐格取「原始代表色」（未经调色板映射）的平均色
 *   C. 映射到调色板后的平均色
 * 如果 B 已经变冷 -> 采样/代表色算法的问题；
 * 如果 B 正常而 C 变冷 -> 调色板映射的问题。
 */
const fs = require('fs');
const png = require('./png');
const palette = require('../utils/palette');
const px = require('../utils/pixelation');
const { createMapper } = require('../utils/nearest');

const DIR =
  'C:/Users/727/xwechat_files/wxid_8snr5v7j6xs112_dec4/temp/RWTemp/2026-10/9e20f478899dc29eb19741386f9343c8/';
const img = png.decode(fs.readFileSync(DIR + 'd789f7974f002f7ba462d18cfa3365fa.png'));

function show(label, r, g, b) {
  console.log(
    `${label}: (${r.toFixed(1)}, ${g.toFixed(1)}, ${b.toFixed(1)})  R-G=${(r - g).toFixed(1)}  G-B=${(g - b).toFixed(1)}`
  );
}

// A. 原图
let ar = 0;
let ag = 0;
let ab = 0;
for (let i = 0; i < img.width * img.height; i++) {
  ar += img.data[i * 4];
  ag += img.data[i * 4 + 1];
  ab += img.data[i * 4 + 2];
}
const n = img.width * img.height;
show('A 原图          ', ar / n, ag / n, ab / n);

// 采样到长边 1600
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
const imageData = { data: sampled, width: sw, height: sh };

const N = 100;
const M = Math.max(1, Math.round((N * sh) / sw));

for (const mode of ['dominant', 'average']) {
  const g = px.calculatePixelGrid(imageData, sw, sh, N, M, createMapper([{ key: '#000000', hex: '#000000', rgb: { r: 0, g: 0, b: 0 } }]), mode);

  // B. 代表色（原始 RGB，未经映射）—— 重新算一遍拿原始值
  const cellW = sw / N;
  const cellH = sh / M;
  let br = 0;
  let bg = 0;
  let bb = 0;
  let cnt = 0;
  for (let j = 0; j < M; j++) {
    const startY = Math.floor(j * cellH);
    const endY = Math.min(sh, Math.ceil((j + 1) * cellH));
    for (let i = 0; i < N; i++) {
      const startX = Math.floor(i * cellW);
      const endX = Math.min(sw, Math.ceil((i + 1) * cellW));
      const rep = px.cellRepresentativeColor(
        sampled,
        sw,
        startX,
        startY,
        Math.max(1, endX - startX),
        Math.max(1, endY - startY),
        mode
      );
      if (!rep) continue;
      br += rep.r;
      bg += rep.g;
      bb += rep.b;
      cnt++;
    }
  }
  show(`B 代表色[${mode}]   `, br / cnt, bg / cnt, bb / cnt);

  // C. 映射到调色板后
  const mapper = createMapper(palette.buildFullPalette());
  const mapped = px.calculatePixelGrid(imageData, sw, sh, N, M, mapper, mode);
  let cr = 0;
  let cg = 0;
  let cb = 0;
  let cc = 0;
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < N; i++) {
      const cell = mapped.data[j][i];
      if (cell.isExternal) continue;
      const h = cell.color;
      cr += parseInt(h.slice(1, 3), 16);
      cg += parseInt(h.slice(3, 5), 16);
      cb += parseInt(h.slice(5, 7), 16);
      cc++;
    }
  }
  show(`C 映射后[${mode}]   `, cr / cc, cg / cc, cb / cc);
  console.log('');
  void g;
}
