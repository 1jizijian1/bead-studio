/**
 * 全局颜色合并（去杂色）。
 *
 * 网页版实现在 page.tsx:915-1014，**不是 BFS 区域合并**，而是：
 *   1. 统计每种颜色出现次数
 *   2. 按频率降序排
 *   3. 双重循环：高频 i vs 低频 j，若 Oklab 距离 < 阈值，把 j 整体并入 i
 *
 * 网页版每接受一次合并就从头扫一遍 M×N（三重循环），是最大性能瓶颈。
 * 这里改成「key -> 扁平下标数组」索引，只改被合并色的格子：
 *   O(k² × N × M)  ->  O(k² + N×M)
 */
const { oklabDistance } = require('./oklab');
const { TRANSPARENT_KEY } = require('./pixelation');

/**
 * @param {Array<Array<{key:string,color:string,isExternal?:boolean}>>} data 会被**原地修改**
 * @param {{N:number,M:number}} dims
 * @param {Array<{key:string,hex:string,rgb:object,_oklab:object}>} palette 来自 nearest.createMapper 的 palette
 * @param {number} threshold 0-100，与 Oklab×100 直接比较
 * @returns {{mergedCount:number, order:string[]}} mergedCount = 被并入的颜色种数
 */
function globalMerge(data, dims, palette, threshold) {
  const N = dims.N;
  const M = dims.M;

  const byHex = new Map();
  for (let i = 0; i < palette.length; i++) byHex.set(palette[i].hex, palette[i]);

  // 建索引：key -> [扁平下标...]，并统计次数
  const indexByKey = new Map();
  const counts = new Map();
  const total = N * M;
  for (let k = 0; k < total; k++) {
    const j = (k / N) | 0;
    const i = k - j * N;
    const cell = data[j][i];
    if (!cell || cell.isExternal || cell.key === TRANSPARENT_KEY) continue;
    let arr = indexByKey.get(cell.key);
    if (!arr) {
      arr = [];
      indexByKey.set(cell.key, arr);
    }
    arr.push(k);
    counts.set(cell.key, (counts.get(cell.key) || 0) + 1);
  }

  const order = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map((e) => e[0]);

  const replaced = new Set();

  for (let i = 0; i < order.length; i++) {
    const hi = order[i];
    if (replaced.has(hi)) continue;
    const hiColor = byHex.get(hi);
    if (!hiColor) continue;

    for (let j = i + 1; j < order.length; j++) {
      const lo = order[j];
      if (replaced.has(lo)) continue;
      const loColor = byHex.get(lo);
      if (!loColor) continue;

      if (oklabDistance(hiColor._oklab, loColor._oklab) >= threshold) continue;

      replaced.add(lo);

      const loIdx = indexByKey.get(lo) || [];
      for (let t = 0; t < loIdx.length; t++) {
        const k = loIdx[t];
        const jj = (k / N) | 0;
        const ii = k - jj * N;
        data[jj][ii] = { key: hi, color: hiColor.hex, isExternal: false };
      }

      // 把 lo 的下标并入 hi，保证后续比较仍覆盖这些格子
      let hiIdx = indexByKey.get(hi);
      if (!hiIdx) {
        hiIdx = [];
        indexByKey.set(hi, hiIdx);
      }
      for (let t = 0; t < loIdx.length; t++) hiIdx.push(loIdx[t]);
      indexByKey.delete(lo);
    }
  }

  return { mergedCount: replaced.size, order };
}

module.exports = { globalMerge };
