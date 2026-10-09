/**
 * 算法层 Node 单测（不依赖小程序环境）。
 *
 * 用法："C:\Users\727\Desktop\node\node.exe" tools/test.js
 */
const assert = require('assert');

const { hexToRgb, colorDistance, getOklab } = require('../utils/oklab');
const palette = require('../utils/palette');
const { createMapper } = require('../utils/nearest');
const px = require('../utils/pixelation');
const { globalMerge } = require('../utils/merge');
const { removeBackground } = require('../utils/background');
const { excludeColor } = require('../utils/exclude');
const { computeStats, cloneGrid } = require('../utils/stats');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function makeImage(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = fn(x, y);
      const i = (y * w + x) * 4;
      data[i] = p[0];
      data[i + 1] = p[1];
      data[i + 2] = p[2];
      data[i + 3] = p.length > 3 ? p[3] : 255;
    }
  }
  return { data, width: w, height: h };
}

const RED = { key: '#FF0000', hex: '#FF0000', rgb: { r: 255, g: 0, b: 0 } };
const BLUE = { key: '#0000FF', hex: '#0000FF', rgb: { r: 0, g: 0, b: 255 } };
const WHITE = { key: '#FFFFFF', hex: '#FFFFFF', rgb: { r: 255, g: 255, b: 255 } };
const BLACK = { key: '#000000', hex: '#000000', rgb: { r: 0, g: 0, b: 0 } };
const SMALL_PALETTE = [RED, BLUE, WHITE, BLACK];

console.log('\n[oklab]');
ok('hexToRgb 正确解析', () => {
  assert.deepStrictEqual(hexToRgb('#FAF4C8'), { r: 0xfa, g: 0xf4, b: 0xc8 });
  assert.strictEqual(hexToRgb('zzz'), null);
});
ok('黑到白的 Oklab 距离 = 100（与网页版语义一致）', () => {
  const d = colorDistance(BLACK.rgb, WHITE.rgb);
  assert.ok(Math.abs(d - 100) < 0.01, `expected ~100, got ${d}`);
});
ok('同色距离为 0', () => {
  assert.strictEqual(colorDistance(RED.rgb, RED.rgb), 0);
});

console.log('\n[palette]');
ok('全量调色板 291 色，key 就是 hex', () => {
  const full = palette.buildFullPalette();
  assert.strictEqual(full.length, 291);
  assert.strictEqual(full[0].key, full[0].hex);
});
ok('hex -> 色号换算', () => {
  assert.strictEqual(palette.getDisplayColorKey('#FAF4C8', 'MARD'), 'A01');
  assert.strictEqual(palette.getDisplayColorKey('#FAF4C8', '咪小窝'), '77');
  assert.strictEqual(palette.getDisplayColorKey('#123456', 'MARD'), '?');
});
ok('色号 -> hex 反查', () => {
  assert.strictEqual(palette.convertColorKeyToHex('A01', 'MARD'), '#FAF4C8');
});
ok('sortColorKeys：先字母后数字', () => {
  const list = ['B2', 'A10', 'A2', 'ZG1', 'A1'];
  list.sort(palette.sortColorKeys);
  assert.deepStrictEqual(list, ['A1', 'A2', 'A10', 'B2', 'ZG1']);
});

console.log('\n[阈值默认值校准]');
// 这是踩过的坑：网页版默认阈值 30 在 ×100 的 Oklab 尺度上太激进，
// 会把照片合并成一团近黑。这组断言把「可用区间」钉死，防止再改回去。
ok('默认阈值落在色板相邻间距和「可辨颜色差」之间', () => {
  const { withOklab } = require('../utils/nearest');
  const { oklabDistance } = require('../utils/oklab');
  const constants = require('../utils/constants');
  const pal = withOklab(palette.buildFullPalette());
  const byHex = {};
  pal.forEach((p) => (byHex[p.hex] = p));

  // 每个色到最近邻色的距离，取中位数 = 色板的典型相邻间距
  const nn = pal.map((p, i) => {
    let best = Infinity;
    pal.forEach((q, j) => {
      if (i !== j) best = Math.min(best, oklabDistance(p._oklab, q._oklab));
    });
    return best;
  });
  nn.sort((a, b) => a - b);
  const medianGap = nn[Math.floor(nn.length / 2)];

  assert.ok(
    constants.DEFAULT_THRESHOLD > medianGap,
    `默认阈值 ${constants.DEFAULT_THRESHOLD} 应大于色板相邻间距中位数 ${medianGap.toFixed(2)}，否则起不到去杂色作用`
  );

  // 人眼明确可辨的两种颜色不该被默认阈值合并
  const distinct = oklabDistance(byHex['#5D722A']._oklab, byHex['#8D614C']._oklab); // 绿 vs 棕
  assert.ok(
    constants.DEFAULT_THRESHOLD < distinct,
    `默认阈值 ${constants.DEFAULT_THRESHOLD} 必须小于「绿 vs 棕」的距离 ${distinct.toFixed(1)}，否则会把绿植并进棕色`
  );
  assert.ok(
    constants.DEFAULT_THRESHOLD < 33,
    '默认阈值必须小于「中棕 vs 深黑」的 33.5，否则整张暗调照片会塌成一个颜色'
  );
});

console.log('\n[nearest]');
ok('最近色映射正确', () => {
  const mapper = createMapper(SMALL_PALETTE);
  assert.strictEqual(mapper.lookup(255, 0, 0).hex, '#FF0000');
  assert.strictEqual(mapper.lookup(0, 0, 255).hex, '#0000FF');
  assert.strictEqual(mapper.lookup(250, 5, 8).hex, '#FF0000');
  assert.strictEqual(mapper.lookup(255, 255, 255).hex, '#FFFFFF');
  assert.strictEqual(mapper.lookup(3, 2, 6).hex, '#000000');
});
ok('291 个调色板颜色全部精确映射到自己（杜绝色号偏移）', () => {
  const full = palette.buildFullPalette();
  const mapper = createMapper(full);
  const bad = full.filter((c) => mapper.lookup(c.rgb.r, c.rgb.g, c.rgb.b).hex !== c.hex);
  assert.strictEqual(
    bad.length,
    0,
    `有 ${bad.length} 个色号被错配：${bad.map((b) => b.hex).join(',')}`
  );
});

console.log('\n[pixelation]');
ok('8x8 左红右蓝 -> 2x2 网格', () => {
  const img = makeImage(8, 8, (x) => (x < 4 ? [255, 0, 0] : [0, 0, 255]));
  const mapper = createMapper(SMALL_PALETTE);
  const res = px.calculatePixelGrid(img, 8, 8, 2, 2, mapper, 'dominant');
  assert.deepStrictEqual(res.dims, { N: 2, M: 2 });
  assert.strictEqual(res.data[0][0].color, '#FF0000');
  assert.strictEqual(res.data[0][1].color, '#0000FF');
  assert.strictEqual(res.data[1][0].color, '#FF0000');
});
ok('dominant 取众数，average 取均值', () => {
  // 一格 4 像素：3 红 1 蓝
  const img = makeImage(2, 2, (x, y) => (x === 1 && y === 1 ? [0, 0, 255] : [255, 0, 0]));
  const mapper = createMapper(SMALL_PALETTE);
  const dom = px.calculatePixelGrid(img, 2, 2, 1, 1, mapper, 'dominant');
  const avg = px.calculatePixelGrid(img, 2, 2, 1, 1, mapper, 'average');
  assert.strictEqual(dom.data[0][0].color, '#FF0000'); // 众数是红
  assert.strictEqual(avg.data[0][0].color, '#FF0000'); // 均值 (191,0,64) 最近仍是红
});
ok('全透明格 -> isExternal', () => {
  const img = makeImage(2, 2, () => [0, 0, 0, 0]);
  const mapper = createMapper(SMALL_PALETTE);
  const res = px.calculatePixelGrid(img, 2, 2, 1, 1, mapper, 'dominant');
  assert.strictEqual(res.data[0][0].isExternal, true);
  assert.strictEqual(res.data[0][0].key, 'ERASE');
});
ok('M = round(N * 高/宽) 由调用方推导（此处验证非方形图）', () => {
  const img = makeImage(8, 4, (x) => (x < 4 ? [255, 0, 0] : [0, 0, 255]));
  const mapper = createMapper(SMALL_PALETTE);
  const N = 2;
  const M = Math.max(1, Math.round((N * 4) / 8)); // = 1
  const res = px.calculatePixelGrid(img, 8, 4, N, M, mapper, 'dominant');
  assert.deepStrictEqual(res.dims, { N: 2, M: 1 });
});

console.log('\n[merge]');
ok('相近色按阈值并入高频色', () => {
  // 造一个 4x4：12 格 #FF0000，4 格 #FF0010（与红很近）
  const nearRedHex = '#FF0010';
  const nearRed = { key: nearRedHex, hex: nearRedHex, rgb: { r: 255, g: 0, b: 16 } };
  const pal = [RED, nearRed, BLUE];
  const mapper = createMapper(pal);
  const dims = { N: 4, M: 4 };
  const data = [];
  for (let j = 0; j < 4; j++) {
    const row = [];
    for (let i = 0; i < 4; i++) {
      row.push(j === 3 && i < 4 ? { key: nearRedHex, color: nearRedHex } : { key: '#FF0000', color: '#FF0000' });
    }
    data.push(row);
  }
  const before = computeStats(data, dims);
  assert.ok(before.colorCounts[nearRedHex], '合并前应有 nearRed');

  const { mergedCount } = globalMerge(data, dims, mapper.palette, 30);
  assert.strictEqual(mergedCount, 1);
  const after = computeStats(data, dims);
  assert.strictEqual(after.colorCounts[nearRedHex], undefined, '合并后 nearRed 应消失');
  assert.strictEqual(after.totalBeadCount, 16);
});
ok('阈值 0 时不合并任何颜色', () => {
  const nearRedHex = '#FF0010';
  const nearRed = { key: nearRedHex, hex: nearRedHex, rgb: { r: 255, g: 0, b: 16 } };
  const mapper = createMapper([RED, nearRed, BLUE]);
  const dims = { N: 2, M: 1 };
  const data = [[{ key: '#FF0000', color: '#FF0000' }, { key: nearRedHex, color: nearRedHex }]];
  const { mergedCount } = globalMerge(data, dims, mapper.palette, 0);
  assert.strictEqual(mergedCount, 0);
});

console.log('\n[size 成品尺寸]');
const sizeUtil = require('../utils/size');

ok('成品宽度 -> 横轴格子数（5mm 豆）', () => {
  assert.strictEqual(sizeUtil.columnsForWidth(30, 5), 60);
  assert.strictEqual(sizeUtil.columnsForWidth(15, 5), 30);
  assert.strictEqual(sizeUtil.columnsForWidth(150, 5), 300);
});

ok('迷你豆 2.6mm 同样宽度格子更多', () => {
  assert.strictEqual(sizeUtil.columnsForWidth(30, 2.6), 115);
  const std = sizeUtil.describeSize({ N: 60, M: 34 }, 5);
  const mini = sizeUtil.describeSize({ N: 115, M: 65 }, 2.6);
  // 两种豆拼出来的成品应该差不多大
  assert.ok(Math.abs(std.widthCm - mini.widthCm) < 1, `${std.widthCm} vs ${mini.widthCm}`);
});

ok('格子数 <-> 宽度 可以来回换算', () => {
  for (const pitch of [5, 2.6]) {
    for (const w of [10, 30, 60]) {
      const N = sizeUtil.columnsForWidth(w, pitch);
      const back = sizeUtil.widthForColumns(N, pitch);
      assert.ok(Math.abs(back - w) <= pitch / 10, `pitch=${pitch} w=${w} 回算出 ${back}`);
    }
  }
});

ok('成品尺寸与拼豆板数量', () => {
  const info = sizeUtil.describeSize({ N: 60, M: 34 }, 5);
  assert.strictEqual(info.widthCm, 30);
  assert.strictEqual(info.heightCm, 17);
  // 60 格要 3 块板宽（29*2=58 不够），34 格要 2 块板高
  assert.strictEqual(info.boardsW, 3);
  assert.strictEqual(info.boardsH, 2);
  assert.strictEqual(info.boardCount, 6);
  assert.strictEqual(info.tooBig, false);
  assert.strictEqual(info.sizeText, '30.0 × 17.0 cm');
});

ok('N=300 会被标记为「大工程」', () => {
  const info = sizeUtil.describeSize({ N: 300, M: 169 }, 5);
  assert.strictEqual(info.boardsW, 11);
  assert.strictEqual(info.boardsH, 6);
  assert.strictEqual(info.boardCount, 66);
  assert.strictEqual(info.tooBig, true);
  assert.strictEqual(info.widthCm, 150);
});

ok('1 块板是小件，不会被提醒', () => {
  const info = sizeUtil.describeSize({ N: 29, M: 29 }, 5);
  assert.strictEqual(info.boardCount, 1);
  assert.strictEqual(info.tooBig, false);
});

console.log('\n[cleanup 杂色清理]');
const { despeckle } = require('../utils/cleanup');
const cellOf = (hex) => ({ key: hex, color: hex });

function makeSolidField(N, M, hex) {
  const g = [];
  for (let j = 0; j < M; j++) {
    const row = [];
    for (let i = 0; i < N; i++) row.push(cellOf(hex));
    g.push(row);
  }
  return g;
}

ok('孤立单格被并入周围颜色', () => {
  const dims = { N: 5, M: 5 };
  const g = makeSolidField(5, 5, '#AAAAAA');
  g[2][2] = cellOf('#BBBBBB'); // 正中间一个孤点
  const r = despeckle(g, dims, 2);
  assert.strictEqual(g[2][2].color, '#AAAAAA', '孤点应被并入');
  assert.strictEqual(r.cellsChanged, 1);
  assert.strictEqual(r.regionsRemoved, 1);
});

ok('够大的色块保留不动', () => {
  const dims = { N: 5, M: 5 };
  const g = makeSolidField(5, 5, '#AAAAAA');
  // 2x2 的块（4 格），阈值 2 时不该被动
  g[1][1] = cellOf('#BBBBBB');
  g[1][2] = cellOf('#BBBBBB');
  g[2][1] = cellOf('#BBBBBB');
  g[2][2] = cellOf('#BBBBBB');
  const r = despeckle(g, dims, 2);
  assert.strictEqual(r.cellsChanged, 0, '2x2 的块不该被清掉');
  assert.strictEqual(g[1][1].color, '#BBBBBB');
});

ok('阈值调高时 2x2 也会被并入', () => {
  const dims = { N: 5, M: 5 };
  const g = makeSolidField(5, 5, '#AAAAAA');
  g[1][1] = cellOf('#BBBBBB');
  g[1][2] = cellOf('#BBBBBB');
  g[2][1] = cellOf('#BBBBBB');
  g[2][2] = cellOf('#BBBBBB');
  const r = despeckle(g, dims, 5);
  assert.strictEqual(r.cellsChanged, 4);
  assert.strictEqual(g[1][1].color, '#AAAAAA');
});

ok('minSize <= 1 时不做任何事', () => {
  const dims = { N: 3, M: 3 };
  const g = makeSolidField(3, 3, '#AAAAAA');
  g[1][1] = cellOf('#BBBBBB');
  const before = JSON.stringify(g);
  const r = despeckle(g, dims, 1);
  assert.strictEqual(r.cellsChanged, 0);
  assert.strictEqual(JSON.stringify(g), before);
});

ok('外部（空白）格不会被当成邻居颜色，也不会被改', () => {
  const dims = { N: 5, M: 5 };
  const g = makeSolidField(5, 5, '#AAAAAA');
  // 中间一列挖成外部
  for (let j = 0; j < 5; j++) {
    g[j][2] = { key: 'ERASE', color: '#FFFFFF', isExternal: true };
  }
  // 右侧放一个孤点，四周只有左边是 #AAAAAA
  g[2][3] = cellOf('#BBBBBB');
  const r = despeckle(g, dims, 2);
  assert.strictEqual(g[2][3].color, '#AAAAAA', '应并入左侧的 A');
  assert.strictEqual(g[0][2].isExternal, true, '外部格不能被改动');
  assert.strictEqual(r.cellsChanged, 1);
});

console.log('\n[background]');
ok('白边红心 -> 白背景被移除', () => {
  const img = makeImage(8, 8, (x, y) => {
    const inner = x >= 2 && x <= 5 && y >= 2 && y <= 5;
    return inner ? [255, 0, 0] : [255, 255, 255];
  });
  const mapper = createMapper(SMALL_PALETTE);
  const grid = px.calculatePixelGrid(img, 8, 8, 4, 4, mapper, 'dominant');
  const stats0 = computeStats(grid.data, grid.dims);
  assert.strictEqual(stats0.totalBeadCount, 16);

  const res = removeBackground(grid.data, grid.dims);
  assert.strictEqual(res.ok, true, res.reason);
  assert.strictEqual(res.targetKey, '#FFFFFF');
  const stats1 = computeStats(res.data, grid.dims);
  assert.strictEqual(stats1.totalBeadCount, 4, '只应剩中间 2x2 红');
  assert.deepStrictEqual(Object.keys(stats1.colorCounts), ['#FF0000']);
  // 原网格不被修改
  assert.strictEqual(computeStats(grid.data, grid.dims).totalBeadCount, 16);
});

console.log('\n[exclude]');
// 注意：重映射白名单是「初始网格里出现过的 hex」，而这些 hex 必然来自调色板，
// 所以测试必须用真实色板里的 hex（纯 #FF0000 / #0000FF 不在 291 色里）。
const fullPalette = palette.buildFullPalette();
const { findClosestDirect } = require('../utils/nearest');
const REAL_RED = findClosestDirect(fullPalette, { r: 255, g: 0, b: 0 }).hex;
const REAL_BLUE = findClosestDirect(fullPalette, { r: 0, g: 0, b: 255 }).hex;
const REAL_GREEN = findClosestDirect(fullPalette, { r: 0, g: 255, b: 0 }).hex;
const cell = (hex) => ({ key: hex, color: hex });

ok(`真实色板 hex：红=${REAL_RED} 蓝=${REAL_BLUE} 绿=${REAL_GREEN}`, () => {
  assert.notStrictEqual(REAL_RED, REAL_BLUE);
  assert.notStrictEqual(REAL_BLUE, REAL_GREEN);
});

ok('排除颜色后重映射到白名单内颜色，总数不变', () => {
  const dims = { N: 2, M: 2 };
  const data = [[cell(REAL_RED), cell(REAL_BLUE)], [cell(REAL_BLUE), cell(REAL_BLUE)]];
  const res = excludeColor(data, dims, {
    hexKey: REAL_RED,
    initialGridColorKeys: new Set([REAL_RED, REAL_BLUE]),
    excludedColorKeys: new Set(),
    fullPalette,
  });
  assert.strictEqual(res.ok, true, res.reason);
  assert.strictEqual(res.remappedCount, 1);
  const s = computeStats(res.data, dims);
  assert.strictEqual(s.totalBeadCount, 4, '总数不变，只是换了颜色');
  assert.strictEqual(s.colorCounts[REAL_RED], undefined, '被排除的红色应消失');
  assert.strictEqual(s.colorCounts[REAL_BLUE].count, 4);
  // 原网格不被修改
  assert.strictEqual(computeStats(data, dims).colorCounts[REAL_RED].count, 1);
});

ok('白名单会被清空时禁止排除', () => {
  const dims = { N: 1, M: 1 };
  const data = [[cell(REAL_RED)]];
  const res = excludeColor(data, dims, {
    hexKey: REAL_RED,
    initialGridColorKeys: new Set([REAL_RED]), // 图里只有这一种色
    excludedColorKeys: new Set(),
    fullPalette,
  });
  assert.strictEqual(res.ok, false);
  assert.ok(/无法排除/.test(res.reason));
});

ok('其它已排除的颜色不进白名单', () => {
  const dims = { N: 2, M: 1 };
  const data = [[cell(REAL_RED), cell(REAL_BLUE)]];
  const res = excludeColor(data, dims, {
    hexKey: REAL_RED,
    initialGridColorKeys: new Set([REAL_RED, REAL_BLUE, REAL_GREEN]),
    excludedColorKeys: new Set([REAL_GREEN]), // 绿已被排除
    fullPalette,
  });
  assert.strictEqual(res.ok, true, res.reason);
  const s = computeStats(res.data, dims);
  assert.strictEqual(s.colorCounts[REAL_GREEN], undefined, '不应重映射到已排除的绿');
  assert.strictEqual(s.colorCounts[REAL_BLUE].count, 2);
});

console.log('\n[异步]');
(async () => {
  await (async () => {
    const img = makeImage(32, 16, (x, y) => (((x >> 2) + (y >> 2)) % 2 ? [255, 0, 0] : [0, 0, 255]));
    const mapper = createMapper(SMALL_PALETTE);
    const syncRes = px.calculatePixelGrid(img, 32, 16, 8, 4, mapper, 'dominant');
    let progressCalls = 0;
    let lastProgress = 0;
    const asyncRes = await px.calculatePixelGridChunked(
      img, 32, 16, 8, 4, mapper, 'dominant',
      (p) => { progressCalls++; lastProgress = p; }
    );
    assert.deepStrictEqual(asyncRes.data, syncRes.data, '分片版结果应与同步版一致');
    // onProgress 是「每个时间片一次」，不是每行一次；小图一片算完所以可能只回调一次
    assert.ok(progressCalls >= 1, '至少回调一次进度');
    assert.strictEqual(lastProgress, 1, '最后一次进度必须是 1');
  })();
  passed++;
  console.log('  ✓ 分片版结果与同步版一致');

  console.log('\n[性能]');
  await (async () => {
    const full = palette.buildFullPalette();
    let t = Date.now();
    const mapper = createMapper(full);
    const lutMs = Date.now() - t;

    const img = makeImage(800, 800, (x, y) => [(x * 7) % 256, (y * 13) % 256, ((x + y) * 3) % 256]);
    t = Date.now();
    const res = px.calculatePixelGrid(img, 800, 800, 100, 100, mapper, 'dominant');
    const pxMs = Date.now() - t;

    t = Date.now();
    globalMerge(res.data, res.dims, mapper.palette, 30);
    const mergeMs = Date.now() - t;

    console.log(`      预计算调色板: ${lutMs}ms | 像素化 100x100: ${pxMs}ms | 合并: ${mergeMs}ms`);
    const stats = computeStats(res.data, res.dims);
    console.log(`      用了 ${Object.keys(stats.colorCounts).length} 种颜色，共 ${stats.totalBeadCount} 颗`);
    assert.ok(lutMs < 5000 && pxMs < 5000 && mergeMs < 5000, '耗时明显超出预期');
  })();
  passed++;
  console.log('  ✓ 全量 291 色建表 + 100x100 网格像素化耗时（见上方日志）');

  console.log(`\n全部通过：${passed} 项\n`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
