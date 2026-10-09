/**
 * 同色连通区域（4 邻接）。
 *
 * 进度模式里「长按 = 标记整块」要用它：按下某格，找出属于同一色、且互相连通的整片格子。
 *
 * 实现照 `utils/cleanup.js` 里 despeckle 的写法：平铺的 typed array + 显式栈，
 * 不用递归（大色块会爆栈）。**缓冲区复用**，靠 stamp（代次）代替每次 `fill(0)`。
 *
 * 注意是 **4 邻接**：对角线相邻**不算**连通。这是最容易写错的地方，测试里专门钉住了。
 */
const TRANSPARENT_KEY = 'ERASE';

function isBlank(cell) {
  return !cell || cell.isExternal || cell.key === TRANSPARENT_KEY;
}

/**
 * 建一个绑定到固定网格尺寸的查找器（缓冲区只分配一次）。
 * @param {{N:number,M:number}} dims
 */
function createRegionFinder(dims) {
  const N = dims.N;
  const M = dims.M;
  const total = N * M;

  const seen = new Uint32Array(total);
  const stack = new Int32Array(total);
  const out = new Int32Array(total);
  let stamp = 0;

  /**
   * 找出 (startRow, startCol) 所在的整片同色连通区域。
   *
   * ⚠️ 返回的 `cells` 是**复用的内部缓冲**，只有效到下一次 `find` 调用。
   * 调用方要用就立刻拷走或立刻消费，别存起来。
   *
   * @returns {{cells: Int32Array, count: number, key: string}}
   *   cells 是扁平下标（j*N+i），前 count 个有效。起点是空白格时 count = 0。
   */
  function find(grid, startRow, startCol) {
    if (startRow < 0 || startRow >= M || startCol < 0 || startCol >= N) {
      return { cells: out, count: 0, key: '' };
    }
    const startCell = grid[startRow] && grid[startRow][startCol];
    if (isBlank(startCell)) {
      return { cells: out, count: 0, key: '' };
    }

    // stamp 用尽就整体清一遍（实际不可能跑到，但别留溢出隐患）
    if (stamp >= 0xffffffff) {
      seen.fill(0);
      stamp = 0;
    }
    stamp++;
    const mark = stamp;
    const key = startCell.key;

    let sp = 0;
    let op = 0;
    const start = startRow * N + startCol;
    stack[sp++] = start;
    seen[start] = mark;

    while (sp > 0) {
      const k = stack[--sp];
      out[op++] = k;

      const j = (k / N) | 0;
      const i = k - j * N;
      // 上
      if (j > 0) {
        const n = k - N;
        if (seen[n] !== mark) {
          const c = grid[j - 1][i];
          if (!isBlank(c) && c.key === key) {
            seen[n] = mark;
            stack[sp++] = n;
          }
        }
      }
      // 下
      if (j < M - 1) {
        const n = k + N;
        if (seen[n] !== mark) {
          const c = grid[j + 1][i];
          if (!isBlank(c) && c.key === key) {
            seen[n] = mark;
            stack[sp++] = n;
          }
        }
      }
      // 左
      if (i > 0) {
        const n = k - 1;
        if (seen[n] !== mark) {
          const c = grid[j][i - 1];
          if (!isBlank(c) && c.key === key) {
            seen[n] = mark;
            stack[sp++] = n;
          }
        }
      }
      // 右
      if (i < N - 1) {
        const n = k + 1;
        if (seen[n] !== mark) {
          const c = grid[j][i + 1];
          if (!isBlank(c) && c.key === key) {
            seen[n] = mark;
            stack[sp++] = n;
          }
        }
      }
    }

    return { cells: out, count: op, key };
  }

  return { find, dims };
}

module.exports = { createRegionFinder, isBlank };
