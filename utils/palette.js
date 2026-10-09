/**
 * 色板数据与色号换算。
 *
 * 移植自 perler-beads/src/utils/colorSystemUtils.ts + page.tsx:66-81。
 *
 * 重要：调色板项的 `key` 就是 **hex 本身**（不是色号）。
 * MARD / COCO 等店家色号是导出/展示时用 getDisplayColorKey(hex, 色号体系) 反查的。
 * 网页版就这样，别把 key 当色号用。
 */
const { hexToRgb } = require('./oklab');
const colorSystemMapping = require('../data/colorSystemMapping');

const COLOR_SYSTEMS = ['MARD', 'COCO', '漫漫', '盼盼', '咪小窝'];
const DEFAULT_COLOR_SYSTEM = 'MARD';

/** 所有 hex（大写），291 个 */
function getAllHexValues() {
  return Object.keys(colorSystemMapping);
}

/** MARD 色号 -> hex */
function getMardToHexMapping() {
  const out = {};
  Object.keys(colorSystemMapping).forEach((hex) => {
    const mard = colorSystemMapping[hex].MARD;
    if (mard) out[mard] = hex;
  });
  return out;
}

/**
 * 全量调色板：[{ key: hex, hex, rgb }]，与网页版 fullBeadPalette 结构一致。
 * key === hex，是刻意的（见文件头注释）。
 */
function buildFullPalette() {
  const mardToHex = getMardToHexMapping();
  const out = [];
  Object.keys(mardToHex).forEach((mardKey) => {
    const hex = mardToHex[mardKey];
    const rgb = hexToRgb(hex);
    if (!rgb) {
      console.warn(`Invalid hex "${hex}" for MARD key "${mardKey}". Skipping.`);
      return;
    }
    out.push({ key: hex, hex, rgb });
  });
  return out;
}

/** hex -> 指定色号体系的色号；查不到返回 '?' */
function getDisplayColorKey(hexValue, colorSystem) {
  if (!hexValue || hexValue === 'ERASE' || hexValue === '?') return hexValue;
  const mapping = colorSystemMapping[hexValue.toUpperCase()];
  if (mapping && mapping[colorSystem]) return mapping[colorSystem];
  return '?';
}

/** 色号 -> hex（在指定体系里反查）；本来已是 hex 就原样返回大写 */
function convertColorKeyToHex(displayKey, colorSystem) {
  if (displayKey && displayKey.charAt(0) === '#' && displayKey.length === 7) {
    return displayKey.toUpperCase();
  }
  const all = Object.keys(colorSystemMapping);
  for (let i = 0; i < all.length; i++) {
    if (colorSystemMapping[all[i]][colorSystem] === displayKey) return all[i];
  }
  return displayKey;
}

/**
 * 色号排序：先按字母前缀，再按数字。移植自 page.tsx:46 sortColorKeys。
 * 不匹配 /^([A-Z]+)(\d+)$/ 的（如 ZG1、T1）退回 localeCompare。
 */
function sortColorKeys(a, b) {
  const re = /^([A-Z]+)(\d+)$/;
  const ma = a.match(re);
  const mb = b.match(re);

  if (ma && mb) {
    if (ma[1] !== mb[1]) return ma[1].localeCompare(mb[1]);
    return parseInt(ma[2], 10) - parseInt(mb[2], 10);
  }
  return a.localeCompare(b);
}

/**
 * 两个 hex 之间线性插值，t=0 取 a、t=1 取 b。
 * 进度页用它预计算「灰掉的颜色」「已完成变暗的颜色」——
 * 预计算成字符串后，渲染时每格只是查表，不用做任何颜色运算。
 */
function mixHex(a, b, t) {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  if (!pa || !pb) return a;
  const r = Math.round(pa.r + (pb.r - pa.r) * t);
  const g = Math.round(pa.g + (pb.g - pa.g) * t);
  const bl = Math.round(pa.b + (pb.b - pa.b) * t);
  const to2 = (v) => (v < 16 ? '0' : '') + v.toString(16);
  return ('#' + to2(r) + to2(g) + to2(bl)).toUpperCase();
}

/** 把调色板整体转到某个色号体系（key 变成色号）。仅用于展示，算法里用不到。 */
function convertPaletteToColorSystem(palette, colorSystem) {
  return palette.map((c) => {
    const mapping = colorSystemMapping[c.hex];
    if (mapping && mapping[colorSystem]) {
      return Object.assign({}, c, { key: mapping[colorSystem] });
    }
    return c;
  });
}

module.exports = {
  COLOR_SYSTEMS,
  DEFAULT_COLOR_SYSTEM,
  getAllHexValues,
  getMardToHexMapping,
  buildFullPalette,
  getDisplayColorKey,
  convertColorKeyToHex,
  convertPaletteToColorSystem,
  sortColorKeys,
  mixHex,
};
