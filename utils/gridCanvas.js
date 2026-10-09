/**
 * 网格画布：编辑器预览和拼豆进度页共用的绘制 + 视图数学。
 *
 * 这个模块是从 `pages/editor/index.js` 原来的 `redraw()` 抽出来的，
 * **绘制语句逐条保持一致**（tools/render-grid.js 用「记录全部绘制调用的假 ctx」
 * 做逐调用比对，保证抽出来之后编辑器画面一个像素都没变）。
 *
 * 三条约定，别破：
 *  1. 本模块自己管 transform：setTransform(1..) → scale(dpr) → translate(tx,ty) → scale(scale)。
 *     调用方不要预先设 ctx 变换。
 *  2. 线宽/补偿量都是「屏幕 px」语义，模块内部除以 view.scale 补偿，缩放时线不会变粗。
 *  3. 只画可见范围内的格子，并按绘制色批量 fillRect（fillStyle 只切几次）。
 */
const DEFAULT_MIN_SCALE = 1;
const DEFAULT_MAX_SCALE = 12;

/** N x M 网格铺满 cssW x cssH 时，每格的 css 尺寸 */
function cellSize(cssW, cssH, dims) {
  return { cw: cssW / dims.N, ch: cssH / dims.M };
}

/** 当前视口能看到的格子范围（已 clamp 到网格内） */
function visibleRange(view, cssW, cssH, dims) {
  const { cw, ch } = cellSize(cssW, cssH, dims);
  const left = -view.tx / view.scale;
  const top = -view.ty / view.scale;
  return {
    i0: Math.max(0, Math.floor(left / cw)),
    i1: Math.min(dims.N - 1, Math.ceil((left + cssW / view.scale) / cw)),
    j0: Math.max(0, Math.floor(top / ch)),
    j1: Math.min(dims.M - 1, Math.ceil((top + cssH / view.scale) / ch)),
  };
}

/**
 * 屏幕 CSS px -> 格子坐标。
 * 注意：`sx/sy` 是相对 canvas 的 **css px**（小程序 tap 的 `e.detail.x/y` 就是这个），
 * **不要再乘 dpr**。
 */
function screenToCell(sx, sy, view, cssW, cssH, dims) {
  if (!dims || dims.N <= 0 || dims.M <= 0) return { i: -1, j: -1, inside: false };
  const { cw, ch } = cellSize(cssW, cssH, dims);
  const gx = (sx - view.tx) / view.scale;
  const gy = (sy - view.ty) / view.scale;
  const i = Math.floor(gx / cw);
  const j = Math.floor(gy / ch);
  return { i, j, inside: i >= 0 && i < dims.N && j >= 0 && j < dims.M };
}

/** 把视图夹回合法范围（原地改）。缩放 ≥1 时内容总比画布大，tx/ty 落在 [画布-内容, 0] */
function clampView(view, cssW, cssH, minScale, maxScale) {
  const min = minScale === undefined ? DEFAULT_MIN_SCALE : minScale;
  const max = maxScale === undefined ? DEFAULT_MAX_SCALE : maxScale;
  view.scale = Math.max(min, Math.min(max, view.scale));
  const minTx = cssW - cssW * view.scale;
  const minTy = cssH - cssH * view.scale;
  view.tx = Math.min(0, Math.max(minTx, view.tx));
  view.ty = Math.min(0, Math.max(minTy, view.ty));
  return view;
}

/**
 * 以屏幕点 (ax, ay) 为锚点缩放到 nextScale（原地改 view）。
 * `baseView` 是手势开始时的视图 —— 锚点在内容坐标里的位置要保持不动，
 * 所以要基于「手势开始的变换」去算，不能基于当前 view。
 */
function zoomTo(view, ax, ay, baseView, nextScale, cssW, cssH, minScale, maxScale) {
  const min = minScale === undefined ? DEFAULT_MIN_SCALE : minScale;
  const max = maxScale === undefined ? DEFAULT_MAX_SCALE : maxScale;
  const next = Math.max(min, Math.min(max, nextScale));
  const gx = (ax - baseView.tx) / baseView.scale;
  const gy = (ay - baseView.ty) / baseView.scale;
  view.scale = next;
  view.tx = ax - gx * next;
  view.ty = ay - gy * next;
  clampView(view, cssW, cssH, min, max);
  return view;
}

/** 把一个宽高比塞进可用区域，返回该用多大的画布（css px） */
function fitBox(availW, availH, aspect) {
  let w = availW;
  let h = Math.round(w * aspect);
  if (h > availH) {
    h = availH;
    w = Math.round(h / aspect);
  }
  return { w, h };
}

/**
 * 画一帧。
 *
 * @param ctx 2D context
 * @param {object} o
 *   @param cssW,cssH,dpr
 *   @param dims {N,M}
 *   @param view {scale,tx,ty}
 *   @param bg        底色；传 null 表示不铺底（透明层用）
 *   @param getColor  (i, j) => string | null   返回 null 表示这格不画
 *   @param gridLines | null  {color, width, minCellPx}
 *   @param border    | null  {color, width}
 */
function draw(ctx, o) {
  const cssW = o.cssW;
  const cssH = o.cssH;
  const dpr = o.dpr;
  const view = o.view;
  const dims = o.dims;
  const N = dims.N;
  const M = dims.M;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cssW * dpr, cssH * dpr);

  if (o.bg) {
    ctx.fillStyle = o.bg;
    ctx.fillRect(0, 0, cssW * dpr, cssH * dpr);
  }

  ctx.scale(dpr, dpr);
  ctx.translate(view.tx, view.ty);
  ctx.scale(view.scale, view.scale);

  const { cw, ch } = cellSize(cssW, cssH, dims);
  const r = visibleRange(view, cssW, cssH, dims);
  const getColor = o.getColor;

  // 按颜色批量绘制：fillStyle 只切几次，而不是每格一次
  const byColor = new Map();
  for (let j = r.j0; j <= r.j1; j++) {
    for (let i = r.i0; i <= r.i1; i++) {
      // 回调返回**颜色字符串**（或 null 表示不画）。
      // 刻意不返回对象：5 万格就是每帧 5 万次分配，拖动时 GC 会抖。
      const color = getColor(i, j);
      if (!color) continue;
      let arr = byColor.get(color);
      if (!arr) {
        arr = [];
        byColor.set(color, arr);
      }
      arr.push(i, j);
    }
  }

  // 补一点点宽度防止缩放后出现缝隙；随放大倍数缩小补偿量
  const bleed = 0.5 / view.scale;
  byColor.forEach((coords, color) => {
    ctx.fillStyle = color;
    for (let t = 0; t < coords.length; t += 2) {
      ctx.fillRect(coords[t] * cw, coords[t + 1] * ch, cw + bleed, ch + bleed);
    }
  });

  // 屏幕上每格不足 minCellPx 就不画网格线，否则整片糊成灰的
  const gl = o.gridLines;
  if (gl && cw * view.scale >= gl.minCellPx) {
    ctx.strokeStyle = gl.color;
    ctx.lineWidth = gl.width / view.scale;
    ctx.beginPath();
    for (let i = r.i0; i <= r.i1 + 1; i++) {
      const x = i * cw;
      ctx.moveTo(x, r.j0 * ch);
      ctx.lineTo(x, (r.j1 + 1) * ch);
    }
    for (let j = r.j0; j <= r.j1 + 1; j++) {
      const y = j * ch;
      ctx.moveTo(r.i0 * cw, y);
      ctx.lineTo((r.i1 + 1) * cw, y);
    }
    ctx.stroke();
  }

  if (o.border) {
    ctx.strokeStyle = o.border.color;
    ctx.lineWidth = o.border.width / view.scale;
    ctx.strokeRect(0, 0, cssW, cssH);
  }
}

module.exports = {
  DEFAULT_MIN_SCALE,
  DEFAULT_MAX_SCALE,
  cellSize,
  visibleRange,
  screenToCell,
  clampView,
  zoomTo,
  fitBox,
  draw,
};
