/**
 * 杂色清理（按空间连通性去噪）。
 *
 * 原仓库 README / CLAUDE.md **描述过**这个算法：
 *   「使用 BFS 从未访问单元格出发，将相邻单元格聚合为连通区域，
 *     统一设置为区域内出现次数最多的色号」
 * 但**代码里没有实现** —— 真实代码只做了全局按频率的颜色归并（见 merge.js），
 * 那种做法完全不看空间位置，所以清不掉孤立的单格杂点。
 *
 * 这里把文档描述的思路补上：找**空间上连通**的小色块，把小到不合理的块
 * 并进它周围的主导色。拼豆图纸干不干净，主要就看这一步。
 *
 * 复杂度 O(N*M)，对 300x300 也就几毫秒。
 */
const { TRANSPARENT_KEY } = require('./pixelation');

function isSolid(data, k, N) {
  const j = (k / N) | 0;
  const c = data[j][k - j * N];
  return c && !c.isExternal && c.key !== TRANSPARENT_KEY ? c : null;
}

/**
 * @param {Array} data 网格，**原地修改**
 * @param {{N:number,M:number}} dims
 * @param {number} minSize 小于这个格数的连通块会被并入周围颜色；<=1 表示不处理
 * @param {number} [passes=3] 最多迭代几轮（并掉一批后可能又冒出新的小块）
 * @returns {{cellsChanged:number, regionsRemoved:number}}
 */
function despeckle(data, dims, minSize, passes) {
  if (!minSize || minSize <= 1) return { cellsChanged: 0, regionsRemoved: 0 };

  const N = dims.N;
  const M = dims.M;
  const total = N * M;
  const maxPass = passes || 3;

  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);
  const region = new Int32Array(total);

  let cellsChanged = 0;
  let regionsRemoved = 0;

  for (let pass = 0; pass < maxPass; pass++) {
    visited.fill(0);
    let removedThisPass = 0;

    for (let s = 0; s < total; s++) {
      if (visited[s]) continue;
      const seed = isSolid(data, s, N);
      if (!seed) {
        visited[s] = 1;
        continue;
      }

      const colorKey = seed.key;
      let sp = 0;
      let rp = 0;
      stack[sp++] = s;
      visited[s] = 1;

      // ---- 收集同色连通块 ----
      while (sp > 0) {
        const k = stack[--sp];
        region[rp++] = k;
        const j = (k / N) | 0;
        const i = k - j * N;

        if (i > 0) {
          const n = k - 1;
          const c = visited[n] ? null : isSolid(data, n, N);
          if (c && c.key === colorKey) {
            visited[n] = 1;
            stack[sp++] = n;
          }
        }
        if (i < N - 1) {
          const n = k + 1;
          const c = visited[n] ? null : isSolid(data, n, N);
          if (c && c.key === colorKey) {
            visited[n] = 1;
            stack[sp++] = n;
          }
        }
        if (j > 0) {
          const n = k - N;
          const c = visited[n] ? null : isSolid(data, n, N);
          if (c && c.key === colorKey) {
            visited[n] = 1;
            stack[sp++] = n;
          }
        }
        if (j < M - 1) {
          const n = k + N;
          const c = visited[n] ? null : isSolid(data, n, N);
          if (c && c.key === colorKey) {
            visited[n] = 1;
            stack[sp++] = n;
          }
        }
      }

      if (rp >= minSize) continue;

      // ---- 小块：找它周围（区域外）出现最多的颜色 ----
      // key -> { count, color }
      const counts = new Map();
      for (let t = 0; t < rp; t++) {
        const k = region[t];
        const j = (k / N) | 0;
        const i = k - j * N;
        const neighbors = [
          i > 0 ? k - 1 : -1,
          i < N - 1 ? k + 1 : -1,
          j > 0 ? k - N : -1,
          j < M - 1 ? k + N : -1,
        ];
        for (let q = 0; q < 4; q++) {
          const n = neighbors[q];
          if (n < 0) continue;
          const c = isSolid(data, n, N);
          if (!c || c.key === colorKey) continue; // 只要区域外、且不是本色的邻居
          const entry = counts.get(c.key);
          if (entry) entry.count++;
          else counts.set(c.key, { count: 1, color: c.color });
        }
      }

      if (counts.size === 0) continue; // 四周都是空白，保留原样

      let bestKey = null;
      let bestHex = null;
      let bestCount = -1;
      counts.forEach((entry, key) => {
        if (entry.count > bestCount) {
          bestCount = entry.count;
          bestKey = key;
          bestHex = entry.color;
        }
      });

      for (let t = 0; t < rp; t++) {
        const k = region[t];
        const j = (k / N) | 0;
        const i = k - j * N;
        data[j][i] = { key: bestKey, color: bestHex, isExternal: false };
      }
      cellsChanged += rp;
      regionsRemoved++;
      removedThisPass++;
    }

    if (removedThisPass === 0) break;
  }

  return { cellsChanged, regionsRemoved };
}

module.exports = { despeckle };
