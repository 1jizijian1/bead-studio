/**
 * 一键去背景。移植自 page.tsx:1306-1411。
 *
 * 注意：网页版**没有**固定的背景色号表（README 里说的 T1/H1 是旧设计，代码里不存在）。
 * 真实做法是：
 *   1. 统计四条边上出现最多的颜色 key
 *   2. 从四条边出发，对 key 等于它的格子做栈式洪水填充
 *   3. 填到的格子标记为「外部」（key=ERASE, isExternal=true）
 */
const { TRANSPARENT_KEY, transparentColorData } = require('./pixelation');
const { cloneGrid } = require('./stats');

/**
 * @returns {{ok:boolean, reason?:string, data?:Array, removed:number, targetKey?:string}}
 *   成功时 data 是**新的**网格（原网格不动）
 */
function removeBackground(data, dims) {
  const N = dims.N;
  const M = dims.M;

  // 1. 统计四条边上的颜色频率
  const borderCounts = new Map();
  const countBorderCell = (row, col) => {
    const cell = data[row] && data[row][col];
    if (!cell || cell.isExternal || cell.key === TRANSPARENT_KEY) return;
    borderCounts.set(cell.key, (borderCounts.get(cell.key) || 0) + 1);
  };
  for (let col = 0; col < N; col++) {
    countBorderCell(0, col);
    if (M > 1) countBorderCell(M - 1, col);
  }
  for (let row = 1; row < M - 1; row++) {
    countBorderCell(row, 0);
    if (N > 1) countBorderCell(row, N - 1);
  }

  if (borderCounts.size === 0) {
    return { ok: false, reason: '边缘没有可识别的背景颜色。', removed: 0 };
  }

  // 2. 取边缘出现最多的 key
  let targetKey = '';
  let maxCount = -1;
  borderCounts.forEach((count, key) => {
    if (count > maxCount) {
      maxCount = count;
      targetKey = key;
    }
  });

  // 3. 从边缘洪水填充
  const next = cloneGrid(data, dims);
  const visited = new Array(M);
  for (let j = 0; j < M; j++) visited[j] = new Array(N).fill(false);
  const stack = [];

  const pushIfTarget = (row, col) => {
    if (row < 0 || row >= M || col < 0 || col >= N || visited[row][col]) return;
    const cell = next[row][col];
    if (!cell || cell.isExternal || cell.key !== targetKey) return;
    visited[row][col] = true;
    stack.push(row * N + col);
  };

  for (let col = 0; col < N; col++) {
    pushIfTarget(0, col);
    if (M > 1) pushIfTarget(M - 1, col);
  }
  for (let row = 1; row < M - 1; row++) {
    pushIfTarget(row, 0);
    if (N > 1) pushIfTarget(row, N - 1);
  }

  if (stack.length === 0) {
    return { ok: false, reason: '未找到可去除的背景区域。', removed: 0, targetKey };
  }

  let removed = 0;
  while (stack.length > 0) {
    const k = stack.pop();
    const row = (k / N) | 0;
    const col = k - row * N;
    next[row][col] = transparentColorData();
    removed++;
    pushIfTarget(row - 1, col);
    pushIfTarget(row + 1, col);
    pushIfTarget(row, col - 1);
    pushIfTarget(row, col + 1);
  }

  return { ok: true, data: next, removed, targetKey };
}

module.exports = { removeBackground };
