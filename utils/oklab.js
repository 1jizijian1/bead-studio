/**
 * Oklab 颜色空间与色距计算。
 *
 * 移植自 perler-beads/src/utils/pixelation.ts。
 * 关键：网页版用的**不是** RGB 欧氏距离，而是 Oklab 欧氏距离 ×100，
 * 所以「相似度阈值 0-100」是跟这个 ×100 的值直接比的。照抄别改。
 *
 * 纯 CommonJS，Node 和小程序都能 require（方便单测）。
 */

/** '#RRGGBB' -> {r,g,b}；非法返回 null */
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return null;
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}

function srgbChannelToLinear(channel) {
  const n = channel / 255;
  return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

/** sRGB(0-255) -> Oklab */
function rgbToOklab(r, g, b) {
  const lr = srgbChannelToLinear(r);
  const lg = srgbChannelToLinear(g);
  const lb = srgbChannelToLinear(b);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    A: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    B: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  };
}

// 用整数键缓存，比网页版的 `${r},${g},${b}` 字符串键快（几十万次查询时明显）
const oklabCache = new Map();

function oklabKey(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

/** 带缓存的 rgb -> Oklab */
function getOklab(r, g, b) {
  const k = oklabKey(r, g, b);
  let v = oklabCache.get(k);
  if (v === undefined) {
    v = rgbToOklab(r, g, b);
    oklabCache.set(k, v);
  }
  return v;
}

/** 两个已算好的 Oklab 之间的距离（×100，与网页版一致） */
function oklabDistance(a, b) {
  const dl = a.L - b.L;
  const da = a.A - b.A;
  const db = a.B - b.B;
  return Math.sqrt(dl * dl + da * da + db * db) * 100;
}

/** {r,g,b} 之间的距离（×100） */
function colorDistance(rgb1, rgb2) {
  return oklabDistance(getOklab(rgb1.r, rgb1.g, rgb1.b), getOklab(rgb2.r, rgb2.g, rgb2.b));
}

module.exports = {
  hexToRgb,
  rgbToOklab,
  getOklab,
  oklabDistance,
  colorDistance,
};
