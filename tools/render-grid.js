/**
 * 绘制回归锁：确认把 `redraw()` 抽成 `gridCanvas.draw()` 之后，
 * **绘制调用序列一字不差**。
 *
 * 为什么要有这个：抽取前那段代码是已经在模拟器里验证过可用的，
 * 抽的时候改了已验证的代码，没有自动化覆盖就是裸奔。
 * 这里用一个「记录所有绘制调用的假 ctx」，把「原来的内联实现」和
 * 「新的共享模块」跑同一组场景，逐调用比对（含浮点参数，不做容差）。
 *
 * 用法："C:\Users\727\Desktop\node\node.exe" tools/render-grid.js
 */
const assert = require('assert');
const gridCanvas = require('../utils/gridCanvas');
const constants = require('../utils/constants');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

/** 记录所有绘制调用的假 ctx */
function createRecorder() {
  const calls = [];
  const ctx = {
    _fillStyle: '',
    _strokeStyle: '',
    _lineWidth: 1,
    get fillStyle() {
      return this._fillStyle;
    },
    set fillStyle(v) {
      this._fillStyle = v;
      calls.push(['fillStyle', v]);
    },
    get strokeStyle() {
      return this._strokeStyle;
    },
    set strokeStyle(v) {
      this._strokeStyle = v;
      calls.push(['strokeStyle', v]);
    },
    get lineWidth() {
      return this._lineWidth;
    },
    set lineWidth(v) {
      this._lineWidth = v;
      calls.push(['lineWidth', v]);
    },
    setTransform: (...a) => calls.push(['setTransform', ...a]),
    clearRect: (...a) => calls.push(['clearRect', ...a]),
    fillRect: (...a) => calls.push(['fillRect', ...a]),
    strokeRect: (...a) => calls.push(['strokeRect', ...a]),
    beginPath: () => calls.push(['beginPath']),
    moveTo: (...a) => calls.push(['moveTo', ...a]),
    lineTo: (...a) => calls.push(['lineTo', ...a]),
    stroke: () => calls.push(['stroke']),
    scale: (...a) => calls.push(['scale', ...a]),
    translate: (...a) => calls.push(['translate', ...a]),
  };
  return { ctx, calls };
}

/**
 * 重构前 `pages/editor/index.js` 里 `redraw()` 的**逐字拷贝**
 * （只把 `this.xxx` 换成 env.xxx）。这是比对的基准，**不要"顺手优化"它**。
 */
function legacyDraw(ctx, env) {
  const cssW = env.cssW;
  const cssH = env.cssH;
  const dpr = env.dpr;
  const N = env.dims.N;
  const M = env.dims.M;
  const view = env.view;
  const grid = env.grid;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cssW * dpr, cssH * dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cssW * dpr, cssH * dpr);

  ctx.scale(dpr, dpr);
  ctx.translate(view.tx, view.ty);
  ctx.scale(view.scale, view.scale);

  const cw = cssW / N;
  const ch = cssH / M;

  const left = -view.tx / view.scale;
  const top = -view.ty / view.scale;
  const i0 = Math.max(0, Math.floor(left / cw));
  const i1 = Math.min(N - 1, Math.ceil((left + cssW / view.scale) / cw));
  const j0 = Math.max(0, Math.floor(top / ch));
  const j1 = Math.min(M - 1, Math.ceil((top + cssH / view.scale) / ch));

  const byColor = new Map();
  for (let j = j0; j <= j1; j++) {
    const row = grid[j];
    for (let i = i0; i <= i1; i++) {
      const cell = row[i];
      const color = cell.isExternal ? constants.EXTERNAL_CELL_COLOR : cell.color;
      let arr = byColor.get(color);
      if (!arr) {
        arr = [];
        byColor.set(color, arr);
      }
      arr.push(i, j);
    }
  }

  const bleed = 0.5 / view.scale;
  byColor.forEach((coords, color) => {
    ctx.fillStyle = color;
    for (let t = 0; t < coords.length; t += 2) {
      ctx.fillRect(coords[t] * cw, coords[t + 1] * ch, cw + bleed, ch + bleed);
    }
  });

  if (cw * view.scale >= 4) {
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.16)';
    ctx.lineWidth = 0.6 / view.scale;
    ctx.beginPath();
    for (let i = i0; i <= i1 + 1; i++) {
      const x = i * cw;
      ctx.moveTo(x, j0 * ch);
      ctx.lineTo(x, (j1 + 1) * ch);
    }
    for (let j = j0; j <= j1 + 1; j++) {
      const y = j * ch;
      ctx.moveTo(i0 * cw, y);
      ctx.lineTo((i1 + 1) * cw, y);
    }
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.lineWidth = 1 / view.scale;
  ctx.strokeRect(0, 0, cssW, cssH);
}

/** 抽出后的新实现，配置与编辑器一致 */
function newDraw(ctx, env) {
  const grid = env.grid;
  gridCanvas.draw(ctx, {
    cssW: env.cssW,
    cssH: env.cssH,
    dpr: env.dpr,
    dims: env.dims,
    view: env.view,
    bg: '#ffffff',
    getColor: (i, j) => {
      const cell = grid[j][i];
      return cell.isExternal ? constants.EXTERNAL_CELL_COLOR : cell.color;
    },
    gridLines: { color: 'rgba(0, 0, 0, 0.16)', width: 0.6, minCellPx: 4 },
    border: { color: 'rgba(0, 0, 0, 0.35)', width: 1 },
  });
}

/** 造一张测试网格：有实色、有外部格 */
function makeGrid(N, M, seed) {
  const palette = ['#FAF4C8', '#324BCA', '#8D614C', '#1D1414', '#5D722A', '#E6C9B7'];
  const grid = [];
  for (let j = 0; j < M; j++) {
    const row = [];
    for (let i = 0; i < N; i++) {
      const v = (i * 7 + j * 13 + seed) % 11;
      if (v === 10) row.push({ key: 'ERASE', color: '#FFFFFF', isExternal: true });
      else row.push({ key: palette[v % palette.length], color: palette[v % palette.length] });
    }
    grid.push(row);
  }
  return grid;
}

const SCENARIOS = [
  { name: '60x34 默认视图（scale=1）', N: 60, M: 34, dpr: 2, cssW: 351, cssH: 197, view: { scale: 1, tx: 0, ty: 0 }, seed: 0 },
  { name: '60x34 放大 3 倍并平移', N: 60, M: 34, dpr: 2, cssW: 351, cssH: 197, view: { scale: 3, tx: -320, ty: -150 }, seed: 1 },
  { name: '60x34 放大到 12 倍（极限）', N: 60, M: 34, dpr: 3, cssW: 351, cssH: 197, view: { scale: 12, tx: -2000, ty: -900 }, seed: 2 },
  { name: '300x169 大图（格子很小，不该画网格线）', N: 300, M: 169, dpr: 2, cssW: 351, cssH: 197, view: { scale: 1, tx: 0, ty: 0 }, seed: 3 },
  { name: '300x169 放大 4 倍（该画网格线）', N: 300, M: 169, dpr: 2, cssW: 351, cssH: 197, view: { scale: 4, tx: -1200, ty: -600 }, seed: 4 },
  { name: '10x10 小图', N: 10, M: 10, dpr: 1, cssW: 300, cssH: 300, view: { scale: 1, tx: 0, ty: 0 }, seed: 5 },
  { name: '非整数 dpr（部分安卓机）', N: 60, M: 34, dpr: 2.75, cssW: 333, cssH: 200, view: { scale: 1.7, tx: -88.5, ty: -42.25 }, seed: 6 },
  { name: '视图被夹到边界外（越界输入）', N: 60, M: 34, dpr: 2, cssW: 351, cssH: 197, view: { scale: 2, tx: 500, ty: 500 }, seed: 7 },
];

console.log('\n[绘制调用逐条比对]');

for (const sc of SCENARIOS) {
  ok(`${sc.name}：新旧实现调用序列完全一致`, () => {
    const env = {
      cssW: sc.cssW,
      cssH: sc.cssH,
      dpr: sc.dpr,
      dims: { N: sc.N, M: sc.M },
      view: { scale: sc.view.scale, tx: sc.view.tx, ty: sc.view.ty },
      grid: makeGrid(sc.N, sc.M, sc.seed),
    };

    const a = createRecorder();
    legacyDraw(a.ctx, env);

    const b = createRecorder();
    newDraw(b.ctx, env);

    assert.ok(a.calls.length > 0, '不该是空的');
    assert.strictEqual(
      b.calls.length,
      a.calls.length,
      `调用条数不同：新 ${b.calls.length} vs 旧 ${a.calls.length}`
    );

    for (let k = 0; k < a.calls.length; k++) {
      assert.deepStrictEqual(
        b.calls[k],
        a.calls[k],
        `第 ${k} 条调用不同：\n  新 ${JSON.stringify(b.calls[k])}\n  旧 ${JSON.stringify(a.calls[k])}`
      );
    }
  });
}

console.log('\n[视图数学]');

ok('clampView：缩放夹到 [1,12]，位移夹回边界', () => {
  const v = { scale: 99, tx: 500, ty: 500 };
  gridCanvas.clampView(v, 300, 200);
  assert.strictEqual(v.scale, 12);
  assert.strictEqual(v.tx, 0);
  assert.strictEqual(v.ty, 0);

  const v2 = { scale: 2, tx: -9999, ty: -9999 };
  gridCanvas.clampView(v2, 300, 200);
  assert.strictEqual(v2.tx, 300 - 600);
  assert.strictEqual(v2.ty, 200 - 400);

  const v3 = { scale: 0.1, tx: 0, ty: 0 };
  gridCanvas.clampView(v3, 300, 200);
  assert.strictEqual(v3.scale, 1, '缩放下限是 1');
});

ok('screenToCell：与手算一致，越界返回 inside=false', () => {
  const view = { scale: 1, tx: 0, ty: 0 };
  const dims = { N: 60, M: 34 };
  const hit = gridCanvas.screenToCell(150, 100, view, 300, 170, dims);
  // cw = 300/60 = 5, ch = 170/34 = 5 -> i = floor(150/5) = 30, j = floor(100/5) = 20
  assert.deepStrictEqual(hit, { i: 30, j: 20, inside: true });

  assert.strictEqual(gridCanvas.screenToCell(-1, 10, view, 300, 170, dims).inside, false);
  assert.strictEqual(gridCanvas.screenToCell(99999, 10, view, 300, 170, dims).inside, false);

  // 放大 2 倍、平移 (-50, -20) 后，屏幕 (150,100) 对应内容坐标 ((150+50)/2, (100+20)/2) = (100, 60)
  const zoomed = { scale: 2, tx: -50, ty: -20 };
  assert.deepStrictEqual(gridCanvas.screenToCell(150, 100, zoomed, 300, 170, dims), {
    i: 20,
    j: 12,
    inside: true,
  });
});

ok('zoomTo：锚点在内容坐标里保持不动', () => {
  const base = { scale: 1, tx: 0, ty: 0 };
  const cssW = 300;
  const cssH = 200;
  const ax = 150;
  const ay = 100;

  // 锚点当前对应内容坐标
  const gx = (ax - base.tx) / base.scale;
  const gy = (ay - base.ty) / base.scale;

  const view = { scale: 1, tx: 0, ty: 0 };
  gridCanvas.zoomTo(view, ax, ay, base, 2, cssW, cssH);
  assert.strictEqual(view.scale, 2);
  // 放大后，同一内容坐标应仍落在屏幕同一点
  const sxAfter = view.tx + gx * view.scale;
  const syAfter = view.ty + gy * view.scale;
  assert.ok(Math.abs(sxAfter - ax) < 1e-9, `锚点 x 漂了：${sxAfter} vs ${ax}`);
  assert.ok(Math.abs(syAfter - ay) < 1e-9, `锚点 y 漂了：${syAfter} vs ${ay}`);
});

ok('fitBox：宽图按宽度、高图按高度', () => {
  assert.deepStrictEqual(gridCanvas.fitBox(300, 200, 0.5), { w: 300, h: 150 });
  // 竖图：351 * (1080/1920) 之类
  const tall = gridCanvas.fitBox(300, 200, 2);
  assert.strictEqual(tall.h, 200);
  assert.strictEqual(tall.w, 100);
});

console.log(`\n全部通过：${passed} 项\n`);
