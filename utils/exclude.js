/**
 * 颜色排除与重映射。移植自 page.tsx:1173-1303。
 *
 * 排除某颜色时：
 *   1. 重映射白名单 = 初始网格出现过的 hex，减去本次排除的、再减去其它已排除的
 *   2. 白名单为空 → 禁止排除（否则整图会没有颜色可用）
 *   3. 把该颜色的格子整体替换为白名单里 Oklab 最近的颜色
 *
 * 恢复颜色不在这里 —— 恢复是「重置排除集合 + 整图重算」，由页面重新走一遍
 * 像素化 + 合并流程。
 */
const { findClosestDirect } = require('./nearest');
const { TRANSPARENT_KEY } = require('./pixelation');
const { cloneGrid } = require('./stats');

/**
 * @param {Array} data 网格
 * @param {{N:number,M:number}} dims
 * @param {Object} opts
 * @param {string} opts.hexKey 要排除的 hex（大写）
 * @param {Set<string>} opts.initialGridColorKeys 初始网格出现过的 hex
 * @param {Set<string>} opts.excludedColorKeys 当前已排除的 hex
 * @param {Array} opts.fullPalette 全量调色板（含 rgb）
 * @returns {{ok:boolean, reason?:string, data?:Array, remappedCount:number, targetSize:number}}
 */
function excludeColor(data, dims, opts) {
  const hexKey = opts.hexKey.toUpperCase();
  const initialGridColorKeys = opts.initialGridColorKeys;
  const excludedColorKeys = opts.excludedColorKeys;
  const fullPalette = opts.fullPalette;

  if (!initialGridColorKeys || initialGridColorKeys.size === 0) {
    return { ok: false, reason: '无法排除颜色，初始颜色数据尚未准备好。', remappedCount: 0, targetSize: 0 };
  }

  // 1. 白名单 = 初始颜色 - 本次排除的 - 其它已排除的
  const potential = new Set(initialGridColorKeys);
  potential.delete(hexKey);
  excludedColorKeys.forEach((k) => potential.delete(k));

  const remapTargetPalette = fullPalette.filter((c) => potential.has(c.hex.toUpperCase()));

  if (remapTargetPalette.length === 0) {
    return {
      ok: false,
      reason: '无法排除该颜色：图中最初存在的其他颜色也已被排除，请先恢复部分颜色。',
      remappedCount: 0,
      targetSize: 0,
    };
  }

  const excludedColorData = fullPalette.find((p) => p.hex.toUpperCase() === hexKey);
  if (!excludedColorData) {
    return { ok: false, reason: '无法排除颜色，缺少必要数据。', remappedCount: 0, targetSize: 0 };
  }

  // 2. 整体重映射
  const next = cloneGrid(data, dims);
  let remappedCount = 0;
  for (let j = 0; j < dims.M; j++) {
    for (let i = 0; i < dims.N; i++) {
      const cell = next[j][i];
      if (cell && !cell.isExternal && cell.color.toUpperCase() === hexKey) {
        const rep = findClosestDirect(remapTargetPalette, excludedColorData.rgb);
        next[j][i] = { key: rep.key, color: rep.hex, isExternal: false };
        remappedCount++;
      }
    }
  }

  return { ok: true, data: next, remappedCount, targetSize: remapTargetPalette.length };
}

module.exports = { excludeColor, TRANSPARENT_KEY };
