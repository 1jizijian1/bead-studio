/**
 * 导出绘制的冒烟测试：用假的 canvas context 跑一遍 drawPattern，
 * 检查有没有画出画布边界（网页版就存在「预估高度」和「实际绘制」对不上的 bug）。
 *
 * 用法："C:\Users\727\Desktop\node\node.exe" tools/test-export.js
 */
const assert = require('assert');
const { planExport, drawPattern } = require('../utils/exportPattern');
const paletteUtil = require('../utils/palette');
const constants = require('../utils/constants');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

/** 记录所有绘制动作和坐标的假 ctx */
function makeMockCtx() {
  const ops = [];
  const record = (name) => (...args) => ops.push({ name, args });
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    imageSmoothingEnabled: true,
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    clearRect: record('clearRect'),
    fillText: record('fillText'),
    measureText: (t) => ({ width: String(t).length * 6 }),
    beginPath: () => ops.push({ name: 'beginPath', args: [] }),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: () => ops.push({ name: 'stroke', args: [] }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
  };
  return { ctx, ops };
}

/** 绘制动作里出现的最大 x / y */
function maxExtent(ops) {
  let maxX = 0;
  let maxY = 0;
  const bump = (x, y) => {
    if (typeof x === 'number' && isFinite(x)) maxX = Math.max(maxX, x);
    if (typeof y === 'number' && isFinite(y)) maxY = Math.max(maxY, y);
  };
  for (const op of ops) {
    const a = op.args;
    if (op.name === 'fillRect' || op.name === 'strokeRect' || op.name === 'clearRect') {
      bump(a[0] + a[2], a[1] + a[3]);
    } else if (op.name === 'fillText') {
      bump(a[1], a[2]);
    } else if (op.name === 'moveTo' || op.name === 'lineTo') {
      bump(a[0], a[1]);
    }
  }
  return { maxX, maxY };
}

/** 造一张 N x M 的假网格 */
function makeGrid(N, M, colorCount) {
  const full = paletteUtil.buildFullPalette();
  const grid = [];
  for (let j = 0; j < M; j++) {
    const row = [];
    for (let i = 0; i < N; i++) {
      const c = full[(i + j * N) % Math.min(colorCount, full.length)];
      row.push({ key: c.hex, color: c.hex, isExternal: false });
    }
    grid.push(row);
  }
  return grid;
}

const options = Object.assign({}, constants.DEFAULT_DOWNLOAD_OPTIONS);

console.log('\n[planExport 尺寸 clamp]');

ok('小图用默认 30px/格，不缩水', () => {
  const plan = planExport({ N: 60, M: 40 }, options, constants.MAX_EXPORT_EDGE, 12);
  assert.strictEqual(plan.cell, 30);
  assert.strictEqual(plan.tooSmall, false);
  assert.ok(plan.w <= constants.MAX_EXPORT_EDGE, `w=${plan.w}`);
  assert.ok(plan.h <= constants.MAX_EXPORT_EDGE, `h=${plan.h}`);
});

ok('N=100（默认粒度）会自动缩格以适配上限', () => {
  const plan = planExport({ N: 100, M: 100 }, options, constants.MAX_EXPORT_EDGE, 20);
  // 100 格 x 30px = 3000px，加上坐标轴和留白就有 3112px，必然超上限 —— 正是 clamp 要解决的
  assert.ok(plan.cell < 30, `应缩小格子，实际 cell=${plan.cell}`);
  assert.ok(plan.w <= constants.MAX_EXPORT_EDGE, `w=${plan.w}`);
  assert.ok(plan.h <= constants.MAX_EXPORT_EDGE, `h=${plan.h}`);
});

ok('大图自动缩小格子且不超过上限', () => {
  for (const n of [150, 200, 300]) {
    const plan = planExport({ N: n, M: n }, options, constants.MAX_EXPORT_EDGE, 40);
    assert.ok(
      Math.max(plan.w, plan.h) <= constants.MAX_EXPORT_EDGE,
      `N=${n} 时 ${plan.w}x${plan.h} 超上限`
    );
    assert.ok(plan.cell >= 2, `N=${n} 时 cell=${plan.cell} 太小`);
  }
});

ok('格子过小时置 tooSmall', () => {
  const plan = planExport({ N: 300, M: 300 }, options, 1200, 60);
  assert.strictEqual(plan.tooSmall, true);
  assert.ok(Math.max(plan.w, plan.h) <= 1200);
});

ok('关闭坐标轴和清单后图纸变小', () => {
  const bare = Object.assign({}, options, { showCoordinates: false, includeStats: false, showCellNumbers: false });
  const withAll = planExport({ N: 60, M: 40 }, options, constants.MAX_EXPORT_EDGE, 12);
  const without = planExport({ N: 60, M: 40 }, bare, constants.MAX_EXPORT_EDGE, 12);
  assert.ok(without.w < withAll.w, '关坐标轴后宽度应该变小');
  assert.ok(without.h < withAll.h, '关清单后高度应该变小');
});

ok('漏传 colorCount 时仍为清单区预留高度（回归）', () => {
  // editor 曾经漏传 colorCount，导致清单高度算成 0 却仍要绘制 -> 清单被画到画布外
  const noStats = planExport(
    { N: 40, M: 40 },
    Object.assign({}, options, { includeStats: false }),
    constants.MAX_EXPORT_EDGE,
    10
  );
  const withStatsOmittedCount = planExport({ N: 40, M: 40 }, options, constants.MAX_EXPORT_EDGE);
  const withOne = planExport({ N: 40, M: 40 }, options, constants.MAX_EXPORT_EDGE, 1);
  assert.ok(
    withStatsOmittedCount.h > noStats.h,
    `开了清单却没预留高度：${withStatsOmittedCount.h} vs 无清单 ${noStats.h}`
  );
  assert.strictEqual(withStatsOmittedCount.h, withOne.h, '漏传 colorCount 应与传 1 等价（兜底成 1 行）');
});

console.log('\n[drawPattern 不越界]');

const CASES = [
  { name: '60x40 默认', N: 60, M: 40, colors: 12, opts: options, maxEdge: 3000 },
  { name: '100x100 默认粒度', N: 100, M: 100, colors: 20, opts: options, maxEdge: 3000 },
  { name: '200x200 大图（clamp）', N: 200, M: 200, colors: 40, opts: options, maxEdge: 3000 },
  { name: '300x300 极限', N: 300, M: 300, colors: 60, opts: options, maxEdge: 3000 },
  { name: '无坐标轴无清单', N: 80, M: 60, colors: 8, opts: Object.assign({}, options, { showCoordinates: false, includeStats: false }), maxEdge: 3000 },
  { name: '单色', N: 30, M: 30, colors: 1, opts: options, maxEdge: 3000 },
];

for (const c of CASES) {
  ok(`${c.name}：绘制范围在画布内`, () => {
    const grid = makeGrid(c.N, c.M, c.colors);
    const colorCounts = {};
    let total = 0;
    for (let j = 0; j < c.M; j++) {
      for (let i = 0; i < c.N; i++) {
        const hex = grid[j][i].color;
        if (!colorCounts[hex]) colorCounts[hex] = { count: 0, color: hex };
        colorCounts[hex].count++;
        total++;
      }
    }
    const plan = planExport({ N: c.N, M: c.M }, c.opts, c.maxEdge, Object.keys(colorCounts).length);
    const { ctx, ops } = makeMockCtx();

    drawPattern(ctx, {
      grid,
      dims: { N: c.N, M: c.M },
      options: c.opts,
      colorSystem: 'MARD',
      colorCounts,
      totalBeadCount: total,
      plan,
    });

    const { maxX, maxY } = maxExtent(ops);
    assert.ok(ops.length > 0, '应该产生了绘制动作');
    assert.ok(maxX <= plan.w + 1, `画到了 x=${maxX}，但画布宽只有 ${plan.w}`);
    assert.ok(maxY <= plan.h + 1, `画到了 y=${maxY}，但画布高只有 ${plan.h}`);
    // 也不该留下大片空白：画到的高度应接近画布高度
    assert.ok(maxY >= plan.h * 0.75, `maxY=${maxY} 远小于画布高 ${plan.h}，可能有布局算错`);
  });
}

console.log('\n[色号标注]');
ok('每格都写了对应店家色号', () => {
  const grid = makeGrid(4, 3, 3);
  const colorCounts = { '#FAF4C8': { count: 12, color: '#FAF4C8' } };
  const plan = planExport({ N: 4, M: 3 }, options, 3000, 1);
  const { ctx, ops } = makeMockCtx();
  drawPattern(ctx, {
    grid,
    dims: { N: 4, M: 3 },
    options,
    colorSystem: 'MARD',
    colorCounts,
    totalBeadCount: 12,
    plan,
  });
  const texts = ops.filter((o) => o.name === 'fillText').map((o) => o.args[0]);
  assert.ok(texts.includes('A01'), `应包含 MARD 色号 A01，实际文本：${texts.slice(0, 10).join(',')}`);
});

console.log(`\n全部通过：${passed} 项\n`);
