/**
 * 拼豆项目的编解码：网格压缩、进度位图、统计、对账。
 *
 * 全是纯函数，不碰 wx / 不做 IO —— 这样能在 Node 里完整测（tools/test-project.js）。
 *
 * 两个存储要点：
 *  1. 网格压成「用到的 hex 列表 + 每格的 Uint16 下标」。0xFFFF 表示外部/空白格。
 *     比存 N*M 个 {key,color} 对象小一个量级。
 *  2. 进度是「每格 1 位」的位图。**末字节多余的填充位必须保持 0** ——
 *     否则两个语义相同的位图 base64 不相等，比对/去重会失效。
 */
const { bytesToBase64, base64ToBytes } = require('./binary');

/** 外部/空白格在 cells 里的下标 */
const EXTERNAL_INDEX = 0xffff;

const TRANSPARENT_KEY = 'ERASE';
const TRANSPARENT_COLOR = '#FFFFFF';

function isBlankCell(cell) {
  return !cell || cell.isExternal || cell.key === TRANSPARENT_KEY;
}

// ---------------- 位图 ----------------

function bitmapByteLength(total) {
  return Math.ceil(total / 8);
}

function createBitmap(total) {
  return new Uint8Array(bitmapByteLength(total));
}

function setBit(bm, index, value) {
  const byte = index >> 3;
  const mask = 1 << (index & 7);
  if (value) bm[byte] |= mask;
  else bm[byte] &= ~mask;
}

function getBit(bm, index) {
  return (bm[index >> 3] & (1 << (index & 7))) !== 0;
}

/** 统计置 1 的位数。只数前 total 位，填充位不计。 */
function countBits(bm, total) {
  let n = 0;
  const fullBytes = total >> 3;
  for (let i = 0; i < fullBytes; i++) {
    let b = bm[i];
    // 汉明权重
    b = b - ((b >> 1) & 0x55);
    b = (b & 0x33) + ((b >> 2) & 0x33);
    n += (b + (b >> 4)) & 0x0f;
  }
  for (let i = fullBytes * 8; i < total; i++) {
    if (getBit(bm, i)) n++;
  }
  return n;
}

// ---------------- 进度 ----------------

function packProgress(bm) {
  return bytesToBase64(bm);
}

/**
 * 解进度位图。长度对不上时补齐到 total 需要的字节数：
 * 数据被截断也**不抛异常**，宁可少读出几格，也好过整个页面崩掉。
 */
function unpackProgress(str, total) {
  const need = bitmapByteLength(total);
  const bytes = base64ToBytes(str);
  if (bytes.length === need) return bytes;
  const out = new Uint8Array(need);
  out.set(bytes.subarray(0, Math.min(bytes.length, need)));
  return out;
}

// ---------------- 网格 ----------------

/**
 * @returns {{hexes: string[], cells: Uint16Array}}
 */
function packGrid(grid, dims) {
  const N = dims.N;
  const M = dims.M;
  const hexes = [];
  const indexOfHex = new Map();
  const cells = new Uint16Array(N * M);

  for (let j = 0; j < M; j++) {
    const row = grid[j];
    for (let i = 0; i < N; i++) {
      const cell = row[i];
      if (isBlankCell(cell)) {
        cells[j * N + i] = EXTERNAL_INDEX;
        continue;
      }
      const hex = cell.color;
      let idx = indexOfHex.get(hex);
      if (idx === undefined) {
        idx = hexes.length;
        hexes.push(hex);
        indexOfHex.set(hex, idx);
      }
      cells[j * N + i] = idx;
    }
  }

  return { hexes, cells };
}

function unpackGrid(dims, hexes, cells) {
  const N = dims.N;
  const M = dims.M;
  const grid = new Array(M);
  const blank = { key: TRANSPARENT_KEY, color: TRANSPARENT_COLOR, isExternal: true };

  for (let j = 0; j < M; j++) {
    const row = new Array(N);
    for (let i = 0; i < N; i++) {
      const idx = cells[j * N + i];
      if (idx === EXTERNAL_INDEX || idx >= hexes.length) {
        row[i] = { key: blank.key, color: blank.color, isExternal: true };
      } else {
        const hex = hexes[idx];
        // 注意：项目里 key 就是 hex（和调色板一致），不是店家色号
        row[i] = { key: hex, color: hex };
      }
    }
    grid[j] = row;
  }
  return grid;
}

/**
 * cells（Uint16Array）<-> base64。
 *
 * **不能直接把 Uint16Array 丢给 bytesToBase64**：那个函数按元素遍历取低 8 位，
 * 高字节会被静默丢掉（色板超过 255 色时下标就会溢出）。
 * 这里显式按小端拆成字节，跨设备也一致。
 */
function packCells(cells) {
  const bytes = new Uint8Array(cells.length * 2);
  for (let i = 0; i < cells.length; i++) {
    bytes[i * 2] = cells[i] & 0xff;
    bytes[i * 2 + 1] = (cells[i] >> 8) & 0xff;
  }
  return bytesToBase64(bytes);
}

function unpackCells(str, expectedLength) {
  const bytes = base64ToBytes(str);
  const n = Math.min(Math.floor(bytes.length / 2), expectedLength || Infinity);
  const cells = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    cells[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
  }
  return cells;
}

/**
 * 生成纯数据的缩略图，给项目列表用。
 *
 * 不用「画进 canvas 导出成图片」：那要落文件、会有孤儿文件、还不能在 Node 里测。
 * 32x18 = 576 字节 -> base64 768 字符，比一张 4KB 的 PNG data URI 还小，
 * 而且是纯数据，能直接断言。
 *
 * @returns {{w, h, hexes: string[], cells: string}} cells 里 **0 = 空白**，1..n = hexes[n-1]
 */
function makeThumb(grid, dims, tw, th) {
  const cells = new Uint8Array(tw * th);
  const hexes = [];
  const indexOfHex = new Map();

  for (let y = 0; y < th; y++) {
    const j0 = Math.floor((y * dims.M) / th);
    const j1 = Math.max(j0 + 1, Math.floor(((y + 1) * dims.M) / th));
    for (let x = 0; x < tw; x++) {
      const i0 = Math.floor((x * dims.N) / tw);
      const i1 = Math.max(i0 + 1, Math.floor(((x + 1) * dims.N) / tw));

      // 取该小块的众数色（同 pixelation 的 dominant 思路）
      const counts = new Map();
      for (let j = j0; j < j1; j++) {
        const row = grid[j];
        for (let i = i0; i < i1; i++) {
          const c = row[i];
          if (isBlankCell(c)) continue;
          counts.set(c.color, (counts.get(c.color) || 0) + 1);
        }
      }

      let bestHex = null;
      let bestCount = 0;
      counts.forEach((n, hex) => {
        if (n > bestCount) {
          bestCount = n;
          bestHex = hex;
        }
      });
      if (bestHex === null) continue; // 0 = 空白

      let idx = indexOfHex.get(bestHex);
      if (idx === undefined) {
        hexes.push(bestHex);
        idx = hexes.length; // 1-based，0 留给空白
        indexOfHex.set(bestHex, idx);
      }
      cells[y * tw + x] = idx;
    }
  }

  return { w: tw, h: th, hexes, cells: bytesToBase64(cells) };
}

/** 解缩略图，给列表页画小画布用 */
function unpackThumb(thumb) {
  const cells = base64ToBytes(thumb.cells || '');
  return { w: thumb.w, h: thumb.h, hexes: thumb.hexes || [], cells };
}

/**
 * 网格内容指纹，用来判断「图纸换了但尺寸没变」。
 *
 * ⚠️ **必须把 hexes 一起算进去**：cells 里存的是「第几次遇到的颜色」的下标，
 * 下标是按首次遇到的顺序分配的。所以
 *   [A,B,A,B] -> 下标 [0,1,0,1] + hexes [A,B]
 *   [B,A,B,A] -> 下标 [0,1,0,1] + hexes [B,A]
 * **下标数组完全一样**，只哈希下标会把两张颜色相反的图判成同一张 ——
 * 到时编辑器会误判「图纸没变」而复用旧项目，拼出来的图跟预览不一样。
 */
function hashGrid(hexes, cells) {
  let h = 2166136261;
  for (let k = 0; k < hexes.length; k++) {
    const s = hexes[k];
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  for (let i = 0; i < cells.length; i++) {
    h ^= cells[i];
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// ---------------- 统计 ----------------

/**
 * 按网格 + 位图算进度。
 * **必须排除外部/空白格**（原版就是因为漏了 `isExternal` 导致总豆数偏大）。
 * @returns {{beadTotal:number, doneTotal:number, colors: Array<{hex,total,done}>}}
 */
function countProgress(grid, dims, bm) {
  const N = dims.N;
  const M = dims.M;
  const byHex = new Map();
  let beadTotal = 0;
  let doneTotal = 0;

  for (let j = 0; j < M; j++) {
    const row = grid[j];
    for (let i = 0; i < N; i++) {
      const cell = row[i];
      if (isBlankCell(cell)) continue;
      const k = j * N + i;
      const done = getBit(bm, k);
      beadTotal++;
      if (done) doneTotal++;

      let entry = byHex.get(cell.color);
      if (!entry) {
        entry = { hex: cell.color, total: 0, done: 0 };
        byHex.set(cell.color, entry);
      }
      entry.total++;
      if (done) entry.done++;
    }
  }

  return { beadTotal, doneTotal, colors: Array.from(byHex.values()) };
}

/**
 * 和 countProgress 同口径，但直接吃 `cells`（Uint16）而不是网格对象数组。
 * 进度页持有的是 cells —— 每次点击都重建 N*M 个对象太浪费。
 * @returns {{beadTotal, doneTotal, colorTotal:Int32Array, colorDone:Int32Array}}
 */
function countProgressFromCells(hexes, cells, bm) {
  const colorTotal = new Int32Array(hexes.length);
  const colorDone = new Int32Array(hexes.length);
  let beadTotal = 0;
  let doneTotal = 0;

  for (let k = 0; k < cells.length; k++) {
    const idx = cells[k];
    if (idx === EXTERNAL_INDEX || idx >= hexes.length) continue;
    colorTotal[idx]++;
    beadTotal++;
    if (getBit(bm, k)) {
      colorDone[idx]++;
      doneTotal++;
    }
  }

  return { beadTotal, doneTotal, colorTotal, colorDone };
}

// ---------------- 对账 ----------------

/**
 * 进度与图纸对不上时兜底。
 *  - dims 不一致（位图长度对不上）→ 全清，dropped = true
 *  - dims 一致但图纸内容变了 → 把落在空白格上的位清掉，豆格上的保留
 * @returns {{bm:Uint8Array, changed:number, dropped:boolean}}
 */
function reconcileProgress(bm, grid, dims) {
  const total = dims.N * dims.M;

  if (bm.length !== bitmapByteLength(total)) {
    return { bm: createBitmap(total), changed: -1, dropped: true };
  }

  const next = new Uint8Array(bm);
  let changed = 0;
  const N = dims.N;
  const M = dims.M;

  for (let j = 0; j < M; j++) {
    const row = grid[j];
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (getBit(next, k) && isBlankCell(row[i])) {
        setBit(next, k, 0);
        changed++;
      }
    }
  }

  return { bm: next, changed, dropped: false };
}

module.exports = {
  EXTERNAL_INDEX,
  TRANSPARENT_KEY,
  bitmapByteLength,
  createBitmap,
  setBit,
  getBit,
  countBits,
  packProgress,
  unpackProgress,
  packGrid,
  unpackGrid,
  packCells,
  unpackCells,
  makeThumb,
  unpackThumb,
  hashGrid,
  countProgress,
  countProgressFromCells,
  reconcileProgress,
};
