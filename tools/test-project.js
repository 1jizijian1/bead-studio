/**
 * 拼豆进度模式：纯逻辑层测试（不依赖小程序环境）。
 *
 * 用法："C:\Users\727\Desktop\node\node.exe" tools/test-project.js
 *
 * 这里的测试策略：**拿 Node 的 Buffer 当标准答案**去对拍手写的 base64，
 * 这是「小程序没有 Buffer」这个约束换来的白捡的测试能力。
 */
const assert = require('assert');
const crypto = require('crypto');

const binary = require('../utils/binary');
const codec = require('../utils/projectCodec');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('\n[binary base64 —— 拿 Node Buffer 对拍]');

ok('各种长度的往返都和 Buffer 一致', () => {
  const sizes = [0, 1, 2, 3, 4, 5, 6, 7, 1000, 65537];
  for (const n of sizes) {
    const bytes = crypto.randomBytes(n);
    const mine = binary.bytesToBase64(bytes);
    const oracle = Buffer.from(bytes).toString('base64');
    assert.strictEqual(mine, oracle, `长度 ${n} 编码不一致`);
    assert.deepStrictEqual(
      Array.from(binary.base64ToBytes(mine)),
      Array.from(bytes),
      `长度 ${n} 解码不一致`
    );
  }
});

ok('长度 1/2 的补位分支正确（= 和 ==）', () => {
  assert.strictEqual(binary.bytesToBase64(new Uint8Array([0xff])), Buffer.from([0xff]).toString('base64'));
  assert.strictEqual(binary.bytesToBase64(new Uint8Array([1, 2])), Buffer.from([1, 2]).toString('base64'));
  assert.ok(binary.bytesToBase64(new Uint8Array([1])).endsWith('=='));
  assert.ok(binary.bytesToBase64(new Uint8Array([1, 2])).endsWith('='));
});

ok('解码容忍换行/空格/缺失补位', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const s = Buffer.from(bytes).toString('base64');
  const withNoise = s.slice(0, 4) + '\n' + s.slice(4);
  assert.deepStrictEqual(Array.from(binary.base64ToBytes(withNoise)), Array.from(bytes));
  assert.deepStrictEqual(Array.from(binary.base64ToBytes(s.replace(/=/g, ''))), Array.from(bytes));
});

ok('空输入和垃圾输入不抛异常', () => {
  assert.strictEqual(binary.base64ToBytes('').length, 0);
  assert.strictEqual(binary.base64ToBytes(null).length, 0);
  assert.strictEqual(binary.base64ToBytes('!!!!').length, 0);
  assert.doesNotThrow(() => binary.base64ToBytes('中文乱码abc'));
});

console.log('\n[进度位图]');

ok('setBit/getBit 读写一致', () => {
  const total = 2040;
  const bm = codec.createBitmap(total);
  const marks = [];
  for (let t = 0; t < 1000; t++) {
    const i = Math.floor(Math.random() * total);
    const v = Math.random() < 0.5;
    codec.setBit(bm, i, v);
    marks[i] = v;
  }
  for (let i = 0; i < total; i++) {
    assert.strictEqual(codec.getBit(bm, i), !!marks[i], `第 ${i} 位不对`);
  }
});

ok('countBits 正确，且不数填充位', () => {
  for (const total of [1, 7, 8, 9, 2040, 50700, 50703]) {
    const bm = codec.createBitmap(total);
    let expect = 0;
    for (let i = 0; i < total; i++) {
      if (i % 3 === 0 && i % 7 !== 0) {
        codec.setBit(bm, i, 1);
        expect++;
      }
    }
    assert.strictEqual(codec.countBits(bm, total), expect, `total=${total}`);
  }
});

ok('末字节填充位必须为 0（否则等价位图的 base64 不相等）', () => {
  const total = 2043; // 不是 8 的倍数，末字节有 4 个填充位
  const a = codec.createBitmap(total);
  const b = codec.createBitmap(total);
  for (let i = 0; i < total; i++) {
    codec.setBit(a, i, i % 2 === 0);
    codec.setBit(b, i, i % 2 === 0);
  }
  assert.strictEqual(codec.packProgress(a), codec.packProgress(b), '两个等价位图应产生相同 base64');
  // 直接确认填充位是 0
  const lastByte = a[a.length - 1];
  for (let bit = total % 8; bit < 8; bit++) {
    assert.strictEqual((lastByte >> bit) & 1, 0, `填充位 ${bit} 应为 0`);
  }
});

ok('进度往返一致，截断输入不抛异常', () => {
  const total = 2040;
  const bm = codec.createBitmap(total);
  for (let i = 0; i < total; i += 5) codec.setBit(bm, i, 1);
  const back = codec.unpackProgress(codec.packProgress(bm), total);
  assert.deepStrictEqual(Array.from(back), Array.from(bm));

  // 截断一半
  const short = codec.packProgress(bm).slice(0, 20);
  const partial = codec.unpackProgress(short, total);
  assert.strictEqual(partial.length, codec.bitmapByteLength(total), '应补齐到需要长度');
  assert.doesNotThrow(() => codec.unpackProgress('', total));
  assert.doesNotThrow(() => codec.unpackProgress(null, total));
});

console.log('\n[网格打包]');

function makeTestGrid() {
  // 3 色 + 外部格 + 一整行空白
  const A = '#FAF4C8';
  const B = '#8D614C';
  const C = '#324BCA';
  const dims = { N: 4, M: 3 };
  const blank = { key: 'ERASE', color: '#FFFFFF', isExternal: true };
  const cell = (hex) => ({ key: hex, color: hex });
  const grid = [
    [cell(A), cell(A), cell(B), blank],
    [cell(B), cell(C), blank, blank],
    [blank, blank, blank, blank],
  ];
  return { grid, dims, A, B, C };
}

ok('往返一致（含 3 色、外部格、整行空白）', () => {
  const { grid, dims, A, B, C } = makeTestGrid();
  const packed = codec.packGrid(grid, dims);

  assert.strictEqual(packed.cells.length, dims.N * dims.M);
  assert.strictEqual(packed.hexes.length, 3, '只应记录用到的 3 种颜色');
  assert.deepStrictEqual(packed.hexes.slice().sort(), [A, B, C].sort());

  const back = codec.unpackGrid(dims, packed.hexes, packed.cells);
  assert.strictEqual(back.length, dims.M);
  assert.strictEqual(back[0][0].color, A);
  assert.strictEqual(back[1][1].color, C);
  assert.strictEqual(back[0][3].isExternal, true, '外部格应还原成 isExternal');
  assert.strictEqual(back[0][3].key, 'ERASE');
  assert.strictEqual(back[2][0].isExternal, true, '整行空白应全还原成外部格');
});

ok('ERASE 格与 isExternal 格都映射到哨兵值', () => {
  const dims = { N: 3, M: 1 };
  const grid = [
    [
      { key: 'ERASE', color: '#FFFFFF', isExternal: true },
      { key: 'ERASE', color: '#FFFFFF' }, // 只带 key 没有 isExternal
      { key: '#FAF4C8', color: '#FAF4C8' },
    ],
  ];
  const packed = codec.packGrid(grid, dims);
  assert.strictEqual(packed.cells[0], codec.EXTERNAL_INDEX);
  assert.strictEqual(packed.cells[1], codec.EXTERNAL_INDEX, 'key=ERASE 也该算空白');
  assert.strictEqual(packed.cells[2], 0);
  assert.strictEqual(packed.hexes.length, 1);
});

ok('cells 下标越界时按空白处理（不崩）', () => {
  const dims = { N: 2, M: 1 };
  const cells = new Uint16Array([0, 999]); // 999 越界
  const back = codec.unpackGrid(dims, ['#FAF4C8'], cells);
  assert.strictEqual(back[0][0].color, '#FAF4C8');
  assert.strictEqual(back[0][1].isExternal, true);
});

ok('cells 走完整 base64 路径往返一致（含 >255 的下标）', () => {
  // 这条是回归测试：一开始直接把 Uint16Array 丢给 bytesToBase64，
  // 它按元素取低 8 位、**高字节被静默丢掉**，色板超 255 色就会错。
  // 之前的往返测试没抓到，因为它绕过了 base64 直接传数组。
  const dims = { N: 300, M: 2 };
  const hexes = [];
  for (let i = 0; i < 291; i++) hexes.push('#' + (0x100000 + i * 997).toString(16).slice(1));

  const cells = new Uint16Array(dims.N * dims.M);
  for (let i = 0; i < cells.length; i++) {
    cells[i] = i < 291 ? i : codec.EXTERNAL_INDEX; // 覆盖 0..290 和 0xFFFF
  }

  const b64 = codec.packCells(cells);
  // 每格 2 字节，base64 长度应是 ceil(n*2/3)*4
  const expectedLen = Math.ceil((cells.length * 2) / 3) * 4;
  assert.strictEqual(b64.length, expectedLen, `base64 长度应是 ${expectedLen}，实际 ${b64.length}`);

  const back = codec.unpackCells(b64, cells.length);
  assert.deepStrictEqual(Array.from(back), Array.from(cells), '含 0xFFFF 和高下标也要还原一致');
  assert.strictEqual(back[290], 290);
  assert.strictEqual(back[291], codec.EXTERNAL_INDEX);
});

ok('unpackCells：数据被截断时按能读出的部分返回', () => {
  const cells = new Uint16Array([1, 2, 3, 4, 5, 6]);
  const b64 = codec.packCells(cells);
  const truncated = b64.slice(0, 8); // 只够 6 字节 = 3 个下标
  const back = codec.unpackCells(truncated, cells.length);
  assert.ok(back.length <= cells.length);
  assert.deepStrictEqual(Array.from(back.subarray(0, 3)), [1, 2, 3]);
});

ok('hashGrid：同输入同输出，改一格就变', () => {
  const { grid, dims } = makeTestGrid();
  const p1 = codec.packGrid(grid, dims);
  const p2 = codec.packGrid(grid, dims);
  assert.strictEqual(codec.hashGrid(p1.hexes, p1.cells), codec.hashGrid(p2.hexes, p2.cells));

  const changed = new Uint16Array(p1.cells);
  changed[0] = changed[0] === 0 ? 1 : 0;
  assert.notStrictEqual(
    codec.hashGrid(p1.hexes, p1.cells),
    codec.hashGrid(p1.hexes, changed)
  );
});

console.log('\n[统计与对账]');

ok('countProgress 不把外部格算进去', () => {
  const { grid, dims, A, B, C } = makeTestGrid();
  const total = dims.N * dims.M;
  const bm = codec.createBitmap(total);

  // 只把 A 的两格标完成
  codec.setBit(bm, 0, 1);
  codec.setBit(bm, 1, 1);

  const st = codec.countProgress(grid, dims, bm);
  assert.strictEqual(st.beadTotal, 5, '3 色共 5 个豆格（4x3=12 减去 7 个空白）');
  assert.strictEqual(st.doneTotal, 2);

  const find = (hex) => st.colors.find((c) => c.hex === hex);
  assert.strictEqual(find(A).total, 2);
  assert.strictEqual(find(A).done, 2);
  assert.strictEqual(find(B).total, 2);
  assert.strictEqual(find(B).done, 0);
  assert.strictEqual(find(C).total, 1);
  assert.strictEqual(st.colors.length, 3, '不应包含空白格');
});

ok('reconcileProgress：尺寸不符则全清并标记 dropped', () => {
  const { grid, dims } = makeTestGrid();
  const wrong = codec.createBitmap(999); // 长度对不上
  codec.setBit(wrong, 0, 1);
  const r = codec.reconcileProgress(wrong, grid, dims);
  assert.strictEqual(r.dropped, true);
  assert.strictEqual(codec.countBits(r.bm, dims.N * dims.M), 0, '应全清');
});

ok('reconcileProgress：尺寸对但图纸变了 → 清掉落在空白格上的位', () => {
  const dims = { N: 4, M: 3 };
  const blank = { key: 'ERASE', color: '#FFFFFF', isExternal: true };
  const cell = (hex) => ({ key: hex, color: hex });
  // 现在只有 (0,0) 和 (0,1) 是豆格，其他全空白
  const grid = [
    [cell('#FAF4C8'), cell('#FAF4C8'), blank, blank],
    [blank, blank, blank, blank],
    [blank, blank, blank, blank],
  ];
  const bm = codec.createBitmap(dims.N * dims.M);
  codec.setBit(bm, 0, 1); // 豆格，保留
  codec.setBit(bm, 1, 1); // 豆格，保留
  codec.setBit(bm, 2, 1); // 现在是空白，应清掉
  codec.setBit(bm, 5, 1); // 现在是空白，应清掉

  const r = codec.reconcileProgress(bm, grid, dims);
  assert.strictEqual(r.dropped, false);
  assert.strictEqual(r.changed, 2);
  assert.strictEqual(codec.getBit(r.bm, 0), true);
  assert.strictEqual(codec.getBit(r.bm, 1), true);
  assert.strictEqual(codec.getBit(r.bm, 2), false);
  assert.strictEqual(codec.getBit(r.bm, 5), false);
});

console.log('\n[连通区域]');
const { createRegionFinder } = require('../utils/connectedRegion');

const hexCell = (hex) => ({ key: hex, color: hex });
const BLANK = { key: 'ERASE', color: '#FFFFFF', isExternal: true };
const A = '#FAF4C8';
const B = '#324BCA';

ok('2x2 方块 + 对角相邻的一格 → 对角不算连通', () => {
  const dims = { N: 3, M: 3 };
  const grid = [
    [hexCell(A), hexCell(A), hexCell(B)],
    [hexCell(A), hexCell(A), BLANK],
    [BLANK, BLANK, BLANK],
  ];
  const f = createRegionFinder(dims);
  const r = f.find(grid, 0, 0);
  // 4 邻接下，2x2 方块是 4 格；右上的 B 和方块对角相邻，不该连进来
  assert.strictEqual(r.count, 4, '对角相邻不能算连通');
  assert.strictEqual(r.key, A);
});

ok('环形（3x3 中间挖空）→ 8 格', () => {
  const dims = { N: 3, M: 3 };
  const grid = [
    [hexCell(A), hexCell(A), hexCell(A)],
    [hexCell(A), hexCell(B), hexCell(A)],
    [hexCell(A), hexCell(A), hexCell(A)],
  ];
  const f = createRegionFinder(dims);
  assert.strictEqual(f.find(grid, 0, 0).count, 8);
  assert.strictEqual(f.find(grid, 1, 1).count, 1, '中间那格是独立的一块');
});

ok('单格 → 1；从空白格起 → 0', () => {
  const dims = { N: 3, M: 3 };
  const grid = [
    [hexCell(A), BLANK, BLANK],
    [BLANK, BLANK, BLANK],
    [BLANK, BLANK, BLANK],
  ];
  const f = createRegionFinder(dims);
  assert.strictEqual(f.find(grid, 0, 0).count, 1);
  assert.strictEqual(f.find(grid, 0, 1).count, 0);
  assert.strictEqual(f.find(grid, 0, 1).key, '');
});

ok('不同颜色各自成块', () => {
  const dims = { N: 2, M: 1 };
  const grid = [[hexCell(A), hexCell(B)]];
  const f = createRegionFinder(dims);
  assert.strictEqual(f.find(grid, 0, 0).count, 1);
  assert.strictEqual(f.find(grid, 0, 1).count, 1);
  assert.strictEqual(f.find(grid, 0, 1).key, B);
});

ok('连续调用 1000 次结果不变（缓冲区复用没有残留状态）', () => {
  const dims = { N: 4, M: 4 };
  const grid = [];
  for (let j = 0; j < 4; j++) {
    const row = [];
    for (let i = 0; i < 4; i++) row.push(hexCell(i < 2 ? A : B));
    grid.push(row);
  }
  const f = createRegionFinder(dims);
  const first = f.find(grid, 0, 0).count;
  for (let t = 0; t < 1000; t++) {
    assert.strictEqual(f.find(grid, 0, 0).count, first, `第 ${t} 次结果变了`);
    assert.strictEqual(f.find(grid, 0, 3).count, 8, `第 ${t} 次另半区结果变了`);
  }
});

ok('大片同色跨越整个网格', () => {
  const dims = { N: 20, M: 20 };
  const grid = [];
  for (let j = 0; j < 20; j++) {
    const row = [];
    for (let i = 0; i < 20; i++) row.push(hexCell(A));
    grid.push(row);
  }
  const f = createRegionFinder(dims);
  const r = f.find(grid, 0, 0);
  assert.strictEqual(r.count, 400);
  // 从中间起也应是同一整块
  assert.strictEqual(f.find(grid, 10, 10).count, 400);
});

ok('四个边界角都不越界', () => {
  const dims = { N: 5, M: 4 };
  const grid = [];
  for (let j = 0; j < 4; j++) {
    const row = [];
    for (let i = 0; i < 5; i++) row.push(hexCell(A));
    grid.push(row);
  }
  const f = createRegionFinder(dims);
  assert.strictEqual(f.find(grid, 0, 0).count, 20, '左上');
  assert.strictEqual(f.find(grid, 0, 4).count, 20, '右上');
  assert.strictEqual(f.find(grid, 3, 0).count, 20, '左下');
  assert.strictEqual(f.find(grid, 3, 4).count, 20, '右下');
});

ok('越界起点返回空而不是崩', () => {
  const dims = { N: 3, M: 3 };
  const grid = [[hexCell(A)]];
  const f = createRegionFinder(dims);
  assert.strictEqual(f.find(grid, -1, 0).count, 0);
  assert.strictEqual(f.find(grid, 0, 99).count, 0);
  assert.strictEqual(f.find(grid, 99, 99).count, 0);
});

console.log('\n[缩略图]');

ok('makeThumb：上半 A 色、下半 B 色', () => {
  const dims = { N: 4, M: 4 };
  const grid = [];
  for (let j = 0; j < 4; j++) {
    const row = [];
    for (let i = 0; i < 4; i++) row.push(hexCell(j < 2 ? A : B));
    grid.push(row);
  }
  const t = codec.makeThumb(grid, dims, 4, 2);
  assert.strictEqual(t.w, 4);
  assert.strictEqual(t.h, 2);
  assert.strictEqual(t.hexes.length, 2);
  const cells = codec.unpackThumb(t).cells;
  assert.strictEqual(cells[0], cells[3], '第一行的四格应是同一个色');
  assert.strictEqual(cells[4], cells[7], '第二行的四格应是同一个色');
  assert.notStrictEqual(cells[0], cells[4], '上下两行的色应不同');
});

ok('makeThumb：全空白 -> 全是 0，且不产生 hexes', () => {
  const dims = { N: 3, M: 3 };
  const grid = [];
  for (let j = 0; j < 3; j++) grid.push([BLANK, BLANK, BLANK]);
  const t = codec.makeThumb(grid, dims, 3, 3);
  assert.strictEqual(t.hexes.length, 0);
  assert.deepStrictEqual(Array.from(codec.unpackThumb(t).cells), new Array(9).fill(0));
});

console.log('\n[项目存储]');

// 可注入的内存 storage
function createMemoryStorage() {
  const m = new Map();
  const st = {
    writes: 0,
    failNext: false,
    getSync: (k) => (m.has(k) ? m.get(k) : ''),
    setSync: (k, v) => {
      if (st.failNext) {
        st.failNext = false;
        throw new Error('setStorageSync:fail exceed storage limit');
      }
      st.writes++;
      m.set(k, v);
    },
    removeSync: (k) => {
      m.delete(k);
    },
    allKeys: () => Array.from(m.keys()),
    usage: () => ({ currentSizeKB: 100, limitSizeKB: 10240 }),
    // 测试用的后门
    _raw: m,
  };
  return st;
}

function makeProjectGrid(N, M) {
  const grid = [];
  for (let j = 0; j < M; j++) {
    const row = [];
    for (let i = 0; i < N; i++) row.push(hexCell(i % 2 === 0 ? A : B));
    grid.push(row);
  }
  return grid;
}

const store = require('../utils/projectStore');

ok('建档后索引里有 1 项，done/total 正确', () => {
  const mem = createMemoryStorage();
  store.__setStorage(mem);
  const dims = { N: 4, M: 2 };
  const res = store.createFromGrid({ grid: makeProjectGrid(4, 2), dims, name: '测试图纸' });
  assert.strictEqual(res.ok, true, res.reason);

  const list = store.listProjects();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, '测试图纸');
  assert.strictEqual(list[0].total, 8);
  assert.strictEqual(list[0].done, 0);
  assert.strictEqual(list[0].colorCount, 2);
  assert.deepStrictEqual(list[0].dims, dims);
});

ok('超过 12 个项目 -> too_many（不自动淘汰）', () => {
  const mem = createMemoryStorage();
  store.__setStorage(mem);
  const dims = { N: 2, M: 2 };
  for (let i = 0; i < store.MAX_PROJECTS; i++) {
    const r = store.createFromGrid({ grid: makeProjectGrid(2, 2), dims });
    assert.strictEqual(r.ok, true, `第 ${i + 1} 个应成功`);
  }
  const over = store.createFromGrid({ grid: makeProjectGrid(2, 2), dims });
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.reason, 'too_many');
  assert.strictEqual(store.listProjects().length, store.MAX_PROJECTS, '不该有自动淘汰');
});

ok('超过格数上限 -> too_big', () => {
  const mem = createMemoryStorage();
  store.__setStorage(mem);
  const res = store.createFromGrid({
    grid: [[hexCell(A)]],
    dims: { N: 1000, M: 1000 }, // 100 万格
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'too_big');
});

ok('写失败 -> 返回 quota，且不留下半个项目', () => {
  const mem = createMemoryStorage();
  store.__setStorage(mem);
  mem.failNext = true;
  const res = store.createFromGrid({ grid: makeProjectGrid(4, 2), dims: { N: 4, M: 2 } });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'quota');
  assert.strictEqual(store.listProjects().length, 0, '索引不该被污染');
  assert.strictEqual(mem.allKeys().length, 0, '不该留孤儿 key');
});

ok('删除项目后索引干净、数据 key 也没了', () => {
  const mem = createMemoryStorage();
  store.__setStorage(mem);
  const { id } = store.createFromGrid({ grid: makeProjectGrid(4, 2), dims: { N: 4, M: 2 } });
  assert.strictEqual(store.listProjects().length, 1);
  store.deleteProject(id);
  assert.strictEqual(store.listProjects().length, 0);
  const leftovers = mem
    .allKeys()
    .filter((k) => k.indexOf('beadProject_') === 0 || k.indexOf('beadProgress_') === 0);
  assert.deepStrictEqual(leftovers, [], '不该留下数据/进度 key（索引 key beadProjects 本身留着没问题）');
});

ok('僵尸索引（数据 key 没了）会被自动剔除', () => {
  const mem = createMemoryStorage();
  store.__setStorage(mem);
  const { id } = store.createFromGrid({ grid: makeProjectGrid(4, 2), dims: { N: 4, M: 2 } });
  // 手工把数据 key 删掉，模拟被系统清理
  mem.removeSync('beadProject_' + id);
  assert.strictEqual(store.listProjects().length, 0, '僵尸条目应被剔除');
});

ok('loadProject 解包正确，进度可读', () => {
  const mem = createMemoryStorage();
  store.__setStorage(mem);
  const dims = { N: 4, M: 2 };
  const { id } = store.createFromGrid({ grid: makeProjectGrid(4, 2), dims, name: 'P1' });

  const p = store.loadProject(id);
  assert.strictEqual(p.name, 'P1');
  assert.deepStrictEqual(p.dims, dims);
  assert.strictEqual(p.grid.length, 2);
  assert.strictEqual(p.grid[0][0].color, A);
  assert.strictEqual(p.bitmap.length, codec.bitmapByteLength(8));
  assert.strictEqual(codec.countBits(p.bitmap, 8), 0);
  assert.strictEqual(p.dropped, false);

  // 标两格完成再读
  codec.setBit(p.bitmap, 0, 1);
  codec.setBit(p.bitmap, 1, 1);
  store.markDirty(id, { bitmap: p.bitmap, view: { scale: 2, tx: -10, ty: -5, cssW: 300, cssH: 150 }, currentColor: A });
  store.flushSync();

  const p2 = store.loadProject(id);
  assert.strictEqual(codec.countBits(p2.bitmap, 8), 2);
  assert.deepStrictEqual(p2.view, { scale: 2, tx: -10, ty: -5, cssW: 300, cssH: 150 });
  assert.strictEqual(p2.currentColor, A);
  assert.strictEqual(store.getProjectMeta(id).done, 2, '索引里的 done 也要更新');
});

ok('loadProject 遇到残缺数据返回 null，不崩', () => {
  const mem = createMemoryStorage();
  store.__setStorage(mem);
  mem.setSync('beadProject_broken', { v: 1, dims: { N: 4, M: 2 }, hexes: [A], cells: '' });
  assert.strictEqual(store.loadProject('broken'), null);
  assert.strictEqual(store.loadProject('不存在'), null);
});

ok('overwrite：图纸换了则覆盖并重置进度', () => {
  const mem = createMemoryStorage();
  store.__setStorage(mem);
  const dims = { N: 4, M: 2 };
  const { id } = store.createFromGrid({ grid: makeProjectGrid(4, 2), dims });

  const p = store.loadProject(id);
  codec.setBit(p.bitmap, 0, 1);
  codec.setBit(p.bitmap, 1, 1);
  store.markDirty(id, { bitmap: p.bitmap });
  store.flushSync();
  assert.strictEqual(store.getProjectMeta(id).done, 2);

  // 换一张完全不同的图纸
  const grid2 = [];
  for (let j = 0; j < 2; j++) grid2.push([hexCell(B), hexCell(B), BLANK, BLANK]);
  const res = store.overwrite(id, { grid: grid2, dims });
  assert.strictEqual(res.ok, true, res.reason);
  assert.strictEqual(store.listProjects().length, 1, '应是覆盖而不是新建');

  const p2 = store.loadProject(id);
  assert.strictEqual(codec.countBits(p2.bitmap, 8), 0, '进度应清零');
  assert.strictEqual(store.getProjectMeta(id).done, 0);
  assert.strictEqual(store.getProjectMeta(id).total, 4, '空白格不计入总豆数');
});

ok('hashGrid：同图同指纹', () => {
  const mem = createMemoryStorage();
  store.__setStorage(mem);
  const dims = { N: 4, M: 2 };
  const { id } = store.createFromGrid({ grid: makeProjectGrid(4, 2), dims });
  const h1 = store.getCellsHash(id);
  const packed = codec.packGrid(makeProjectGrid(4, 2), dims);
  assert.strictEqual(h1, codec.hashGrid(packed.hexes, packed.cells), '同一张图指纹应一致');
});

ok('hashGrid：颜色对调的图必须指纹不同（回归）', () => {
  // 这条是回归测试：一开始只哈希 cells 下标，但下标是按「首次遇到的顺序」分配的，
  //   [A,B,A,B] -> 下标 [0,1,0,1] + hexes [A,B]
  //   [B,A,B,A] -> 下标 [0,1,0,1] + hexes [B,A]
  // 下标数组完全相同！只哈希下标会把两张颜色相反的图判成同一张，
  // 编辑器就会误判「图纸没变」复用旧项目，导致拼出来的图跟预览不一样。
  const dims = { N: 4, M: 2 };
  const p1 = codec.packGrid(makeProjectGrid(4, 2), dims); // 行内 A,B,A,B
  const swapped = [];
  for (let j = 0; j < 2; j++) swapped.push([hexCell(B), hexCell(A), hexCell(B), hexCell(A)]);
  const p2 = codec.packGrid(swapped, dims);

  assert.deepStrictEqual(Array.from(p1.cells), Array.from(p2.cells), '前提：下标数组确实相同');
  assert.notDeepStrictEqual(p1.hexes, p2.hexes, '前提：颜色列表不同');
  assert.notStrictEqual(
    codec.hashGrid(p1.hexes, p1.cells),
    codec.hashGrid(p2.hexes, p2.cells),
    '颜色对调必须产生不同指纹'
  );
});

ok('renameProject', () => {
  const mem = createMemoryStorage();
  store.__setStorage(mem);
  const { id } = store.createFromGrid({ grid: makeProjectGrid(4, 2), dims: { N: 4, M: 2 } });
  assert.strictEqual(store.renameProject(id, '新名字'), true);
  assert.strictEqual(store.getProjectMeta(id).name, '新名字');
});

console.log('\n[规模与性能]');

ok('300x169（50700 格）的打包/解包/统计耗时可接受', () => {
  const N = 300;
  const M = 169;
  const dims = { N, M };
  const hexesSrc = [];
  for (let i = 0; i < 14; i++) hexesSrc.push('#' + (0x100000 + i * 4096).toString(16).slice(1));

  const grid = [];
  for (let j = 0; j < M; j++) {
    const row = [];
    for (let i = 0; i < N; i++) {
      const hex = hexesSrc[(i * 7 + j * 13) % 14];
      row.push({ key: hex, color: hex });
    }
    grid.push(row);
  }

  let t = Date.now();
  const packed = codec.packGrid(grid, dims);
  const tPack = Date.now() - t;

  t = Date.now();
  const cellsB64 = codec.packCells(packed.cells);
  const tB64 = Date.now() - t;

  t = Date.now();
  const back = codec.unpackGrid(dims, packed.hexes, packed.cells);
  const tUnpack = Date.now() - t;

  const bm = codec.createBitmap(N * M);
  t = Date.now();
  const st = codec.countProgress(back, dims, bm);
  const tCount = Date.now() - t;

  console.log(
    `      打包 ${tPack}ms | cells转base64 ${tB64}ms | 解包 ${tUnpack}ms | 统计 ${tCount}ms`
  );
  console.log(
    `      图纸 base64 ${(cellsB64.length / 1024).toFixed(1)}KB（${N}x${M} = ${N * M} 格 x 2 字节）`
  );
  assert.strictEqual(st.beadTotal, N * M);
  assert.ok(tPack < 3000 && tUnpack < 3000, '耗时不正常');
});

console.log('\n[节流落盘]');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await (async () => {
    const mem = createMemoryStorage();
    store.__setStorage(mem);
    store.__setThrottleMs(40);

    const dims = { N: 4, M: 2 };
    const { id } = store.createFromGrid({ grid: makeProjectGrid(4, 2), dims });
    const base = mem.writes;

    // 连着改 5 次，中间不等待
    const bm = codec.createBitmap(8);
    for (let k = 1; k <= 5; k++) {
      for (let i = 0; i < k; i++) codec.setBit(bm, i, 1);
      store.markDirty(id, { bitmap: bm });
    }
    assert.strictEqual(store.__pendingCount(), 1, '应只有一个待落盘的条目');

    await sleep(120); // 等节流定时器到点

    // 一次 markDirty 落盘会写 progress + 索引两个 key
    const writes = mem.writes - base;
    assert.ok(writes <= 3, `应只落盘一次（最多 3 个 key 写入），实际写了 ${writes} 次`);

    const p = store.loadProject(id);
    assert.strictEqual(codec.countBits(p.bitmap, 8), 5, '落盘的是最新数据');
  })();
  passed++;
  console.log('  ✓ 连续 markDirty 只落盘一次，且写的是最新数据');

  await (async () => {
    const mem = createMemoryStorage();
    store.__setStorage(mem);
    store.__setThrottleMs(5000); // 故意设很长

    const dims = { N: 4, M: 2 };
    const { id } = store.createFromGrid({ grid: makeProjectGrid(4, 2), dims });
    const bm = codec.createBitmap(8);
    codec.setBit(bm, 3, 1);
    store.markDirty(id, { bitmap: bm });
    assert.strictEqual(codec.countBits(store.loadProject(id).bitmap, 8), 0, '还没到点，不该写');

    store.flushSync(); // onHide 走这条
    assert.strictEqual(codec.countBits(store.loadProject(id).bitmap, 8), 1, 'flushSync 应立即写');
    assert.strictEqual(store.__pendingCount(), 0, 'flushSync 后不该还挂着待写数据');
  })();
  passed++;
  console.log('  ✓ flushSync 立即落盘，不等节流定时器');

  await (async () => {
    const mem = createMemoryStorage();
    store.__setStorage(mem);
    store.__setThrottleMs(40);

    const dims = { N: 4, M: 2 };
    const { id } = store.createFromGrid({ grid: makeProjectGrid(4, 2), dims });
    const bm = codec.createBitmap(8);
    codec.setBit(bm, 2, 1);

    mem.failNext = true; // 下一次写失败（模拟配额满）
    store.markDirty(id, { bitmap: bm });
    await sleep(120);

    assert.strictEqual(store.getLastError() && store.getLastError().reason, 'quota');
    assert.strictEqual(store.__pendingCount(), 1, '失败的数据应挂回去等重试，不丢');

    mem.failNext = false;
    store.flushSync(); // 重试
    assert.strictEqual(codec.countBits(store.loadProject(id).bitmap, 8), 1, '重试后应写成功');
    assert.strictEqual(store.getLastError(), null, '成功后错误状态应清掉');
  })();
  passed++;
  console.log('  ✓ 落盘失败不丢数据，flushSync 能重试成功');

  store.__setThrottleMs(1500); // 还原，别影响别的

  console.log(`\n全部通过：${passed} 项\n`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
