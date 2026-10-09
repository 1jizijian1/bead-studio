const projectStore = require('../../utils/projectStore');
const codec = require('../../utils/projectCodec');
const gridCanvas = require('../../utils/gridCanvas');
const canvasHelper = require('../../utils/canvasHelper');
const paletteUtil = require('../../utils/palette');
const { createRegionFinder } = require('../../utils/connectedRegion');
const constants = require('../../utils/constants');

/** 长按判定：在 touchend 时按按住时长判断，**不设定时器** ——
 *  这样长按后继续拖动就自然变成平移，不需要处理 touchcancel。 */
const LONG_PRESS_MS = 420;
const MOVE_TOLERANCE = 6;
/** 单块超过这么多格，长按标记前先确认（避免误标一整片背景） */
const BIG_REGION_CONFIRM = 500;
const MAX_UNDO = 50;

/** 预计算的显示色：非当前色灰掉、只看当前色时更淡、已完成变暗 */
const FADE_T = 0.62;
const FADE_STRONG_T = 0.88;
const DONE_T = 0.55;

Page({
  data: {
    ready: false,
    name: '',
    dims: { N: 0, M: 0 },
    progressPercent: 0,
    doneText: '',
    colorList: [],
    currentKey: '',
    currentSwatch: '',
    focusOnly: false,
    zoom: 1,
    canvasW: 300,
    canvasH: 300,
    undoCount: 0,
    saveError: false,
  },

  // ---------- 生命周期 ----------

  onLoad(options) {
    this.projectId = options && options.id;
    this.view = { scale: 1, tx: 0, ty: 0 };
    this.touch = null;
    this.moved = false;
    this.undoStack = [];
  },

  async onReady() {
    if (!this.projectId) {
      this.bail('没有指定项目');
      return;
    }

    const p = projectStore.loadProject(this.projectId);
    if (!p) {
      this.bail('项目不存在或已损坏');
      return;
    }

    this.model = p;
    this.dims = p.dims;
    this.bitmap = p.bitmap;
    this.cells = p.cells;
    this.hexes = p.hexes;
    this.colorSystem = p.colorSystem || 'MARD';
    this.regionFinder = createRegionFinder(p.dims);
    this.undoStack = [];

    // 顺序要紧：recount 出每种色的总数/已完成数 -> 才能选「当前色」-> 才能建颜色表
    // （buildColorTables 里会按 currentColor 算 currentIdx）
    this.recount();
    this.currentColor =
      p.currentColor && this.hexes.indexOf(p.currentColor) >= 0
        ? p.currentColor
        : this.firstUnfinishedColor();
    this.buildColorTables();

    if (p.dropped) {
      wx.showToast({ title: '图纸尺寸变了，进度已重置', icon: 'none', duration: 2500 });
    } else if (p.changed) {
      wx.showToast({ title: '图纸有改动，部分进度已清理', icon: 'none', duration: 2500 });
    }

    // 先量出画布容器的真实可用区域，再定画布 CSS 尺寸，最后才取 canvas 节点。
    // （.canvas-wrap 是 flex:1 + min-height:0，高度由布局决定，不会被里面的画布撑开）
    const area = await new Promise((resolve) => {
      wx.createSelectorQuery()
        .in(this)
        .select('.canvas-wrap')
        .fields({ size: true })
        .exec((res) => resolve(res && res[0] ? res[0] : null));
    });
    const info = canvasHelper.getWindowInfo();
    const availW = area && area.width ? area.width - 12 : info.windowWidth - 36;
    const availH = area && area.height ? area.height - 12 : info.windowHeight - 340;
    const box = gridCanvas.fitBox(availW, Math.max(120, availH), this.dims.M / this.dims.N);
    this.cssW = box.w;
    this.cssH = box.h;
    await new Promise((r) => this.setData({ canvasW: box.w, canvasH: box.h }, r));

    try {
      this.display = await canvasHelper.initDisplayCanvas('#pattern', this);
    } catch (e) {
      this.bail(e.message || '画布初始化失败');
      return;
    }

    this.restoreView(p.view);
    this.refreshColorList();
    this.setData({ ready: true, name: p.name });
    this.redraw();
  },

  onHide() {
    this.flush();
  },

  onUnload() {
    this.flush();
    this.model = null;
  },

  /** 不拦用户离开（不调 enableAlertBeforeUnload）。进度是自动保存的，
   *  加拦截反而让人以为「不点确认就丢了」。⚠️ 别「好心」加上。 */
  flush() {
    if (!this.model) return;
    const ok = projectStore.flushSync();
    // 若还有挂着没写下去的数据，也一并交给 store
    if (this.dirty) {
      projectStore.markDirty(this.projectId, {
        bitmap: this.bitmap,
        view: this.view,
        currentColor: this.currentColor,
      });
      projectStore.flushSync();
      this.dirty = false;
    }
    void ok;
  },

  bail(msg) {
    wx.showToast({ title: msg, icon: 'none' });
    setTimeout(() => wx.navigateBack(), 900);
  },

  // ---------- 颜色表 ----------

  /** 预计算：色号、灰版、更淡版、完成版。渲染时每格只查表，不做颜色运算 */
  buildColorTables() {
    const n = this.hexes.length;
    this.solid = new Array(n);
    this.faded = new Array(n);
    this.faint = new Array(n);
    this.done = new Array(n);
    this.keys = new Array(n);

    for (let i = 0; i < n; i++) {
      const hex = this.hexes[i];
      this.solid[i] = hex;
      this.faded[i] = paletteUtil.mixHex(hex, '#9ca3af', FADE_T);
      this.faint[i] = paletteUtil.mixHex(hex, '#f3f4f6', FADE_STRONG_T);
      this.done[i] = paletteUtil.mixHex(hex, '#111827', DONE_T);
      this.keys[i] = paletteUtil.getDisplayColorKey(hex, this.colorSystem);
    }
    this.currentIdx = this.hexes.indexOf(this.currentColor);
  },

  recount() {
    const c = codec.countProgressFromCells(this.hexes, this.cells, this.bitmap);
    this.beadTotal = c.beadTotal;
    this.doneTotal = c.doneTotal;
    this.colorTotal = c.colorTotal;
    this.colorDone = c.colorDone;
  },

  firstUnfinishedColor() {
    for (let i = 0; i < this.hexes.length; i++) {
      if (this.colorDone[i] < this.colorTotal[i]) return this.hexes[i];
    }
    return this.hexes[0] || '';
  },

  /** 色号列表：顺序固定（按色号排），**不要把完成的挪到后面** ——
   *  边拼边重排会让人失去空间感。 */
  refreshColorList() {
    const order = [];
    for (let i = 0; i < this.hexes.length; i++) order.push(i);
    order.sort((a, b) => paletteUtil.sortColorKeys(this.keys[a], this.keys[b]));

    const list = order.map((i) => ({
      idx: i,
      hex: this.hexes[i],
      key: this.keys[i],
      total: this.colorTotal[i],
      done: this.colorDone[i],
      isDone: this.colorDone[i] >= this.colorTotal[i],
      isCurrent: this.hexes[i] === this.currentColor,
    }));

    const curIdx = this.currentIdx >= 0 ? this.currentIdx : 0;
    this.setData({
      colorList: list,
      currentKey: this.keys[curIdx],
      currentSwatch: this.hexes[curIdx],
      doneText: `${this.doneTotal} / ${this.beadTotal}`,
      progressPercent: this.beadTotal ? Math.round((this.doneTotal / this.beadTotal) * 100) : 0,
    });
  },

  // ---------- 渲染 ----------

  /** 只更新当前色那行的进度，避免整块数组重发 */
  patchColorProgress(idx) {
    const list = this.data.colorList;
    for (let k = 0; k < list.length; k++) {
      if (list[k].idx === idx) {
        const patch = {};
        patch[`colorList[${k}].done`] = this.colorDone[idx];
        patch[`colorList[${k}].isDone`] = this.colorDone[idx] >= this.colorTotal[idx];
        this.setData(patch);
        return;
      }
    }
  },

  redraw() {
    if (!this.display) return;
    const { ctx, cssW, cssH, dpr } = this.display;
    const N = this.dims.N;
    const cells = this.cells;
    const bitmap = this.bitmap;
    const curIdx = this.currentIdx;
    const focus = this.data.focusOnly;
    const solid = this.solid;
    const faded = this.faded;
    const faint = this.faint;
    const doneColors = this.done;
    const EXTERNAL = constants.EXTERNAL_CELL_COLOR;
    const EXT_IDX = codec.EXTERNAL_INDEX;

    gridCanvas.draw(ctx, {
      cssW,
      cssH,
      dpr,
      dims: this.dims,
      view: this.view,
      bg: '#ffffff',
      getColor: (i, j) => {
        const k = j * N + i;
        const idx = cells[k];
        if (idx === EXT_IDX) return EXTERNAL;
        if (codec.getBit(bitmap, k)) return doneColors[idx];
        if (idx === curIdx) return solid[idx];
        return focus ? faint[idx] : faded[idx];
      },
      gridLines: { color: 'rgba(0, 0, 0, 0.14)', width: 0.6, minCellPx: 5 },
      border: { color: 'rgba(0, 0, 0, 0.3)', width: 1 },
    });
  },

  // ---------- 视口 ----------

  restoreView(saved) {
    if (!saved || !saved.scale) return;
    // 换机型/转屏后按画布尺寸等比换算 —— 不存 cssW/cssH 的话，
    // 用旧画布语义去 clamp 会把位置甩到角上（不越界但体验差）
    const kx = saved.cssW ? this.cssW / saved.cssW : 1;
    const ky = saved.cssH ? this.cssH / saved.cssH : 1;
    this.view = {
      scale: Math.max(1, Math.min(12, saved.scale)),
      tx: (saved.tx || 0) * kx,
      ty: (saved.ty || 0) * ky,
    };
    gridCanvas.clampView(this.view, this.cssW, this.cssH);
  },

  viewSnapshot() {
    return {
      scale: this.view.scale,
      tx: this.view.tx,
      ty: this.view.ty,
      cssW: this.cssW,
      cssH: this.cssH,
    };
  },

  // ---------- 手势 ----------

  onTouchStart(e) {
    const touches = e.touches || [];
    this.moved = false;
    if (touches.length === 1) {
      this.touch = {
        mode: 'pan',
        x: touches[0].x,
        y: touches[0].y,
        tx: this.view.tx,
        ty: this.view.ty,
        t0: Date.now(),
      };
    } else if (touches.length >= 2) {
      const a = touches[0];
      const b = touches[1];
      this.touch = {
        mode: 'pinch',
        dist: Math.hypot(b.x - a.x, b.y - a.y),
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
        scale: this.view.scale,
        tx: this.view.tx,
        ty: this.view.ty,
      };
      this.moved = true; // 双指一定是手势，不是点击
    }
  },

  onTouchMove(e) {
    const t = this.touch;
    const touches = e.touches || [];
    if (!t || !this.display) return;

    if (t.mode === 'pan' && touches.length === 1) {
      const dx = touches[0].x - t.x;
      const dy = touches[0].y - t.y;
      if (Math.abs(dx) > MOVE_TOLERANCE || Math.abs(dy) > MOVE_TOLERANCE) this.moved = true;
      const prevTx = this.view.tx;
      const prevTy = this.view.ty;
      this.view.tx = t.tx + dx;
      this.view.ty = t.ty + dy;
      gridCanvas.clampView(this.view, this.cssW, this.cssH);
      // 缩放为 1 时内容正好铺满，拖动不会改变视图 —— 别白白重绘
      if (this.view.tx !== prevTx || this.view.ty !== prevTy) this.redraw();
    } else if (t.mode === 'pinch' && touches.length >= 2) {
      const a = touches[0];
      const b = touches[1];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (t.dist < 1) return;
      gridCanvas.zoomTo(
        this.view,
        t.cx,
        t.cy,
        { scale: t.scale, tx: t.tx, ty: t.ty },
        (t.scale * dist) / t.dist,
        this.cssW,
        this.cssH
      );
      this.redraw();
    }
  },

  onTouchEnd(e) {
    const t = this.touch;
    this.touch = null;

    if (this.display && Math.abs(this.data.zoom - this.view.scale) > 0.001) {
      this.setData({ zoom: this.view.scale });
    }
    if (!t || t.mode !== 'pan' || this.moved) return;

    const ct = e.changedTouches && e.changedTouches[0];
    if (!ct) return;

    const hit = gridCanvas.screenToCell(ct.x, ct.y, this.view, this.cssW, this.cssH, this.dims);
    if (!hit.inside) return;

    if (Date.now() - t.t0 >= LONG_PRESS_MS) this.toggleRegion(hit.i, hit.j);
    else this.toggleCell(hit.i, hit.j);
  },

  onResetZoom() {
    this.view = { scale: 1, tx: 0, ty: 0 };
    this.setData({ zoom: 1 });
    this.redraw();
  },

  // ---------- 标记 ----------

  isBlankAt(i, j) {
    return this.cells[j * this.dims.N + i] === codec.EXTERNAL_INDEX;
  },

  toggleCell(i, j) {
    if (this.isBlankAt(i, j)) {
      wx.vibrateShort({ type: 'light' });
      wx.showToast({ title: '这里是空白格', icon: 'none', duration: 800 });
      return;
    }
    const k = j * this.dims.N + i;
    const into = !codec.getBit(this.bitmap, k);
    this.applyCells(Int32Array.of(k), into);
  },

  /** 长按：标记整个同色连通区域 */
  toggleRegion(i, j) {
    if (this.isBlankAt(i, j)) {
      wx.vibrateShort({ type: 'light' });
      wx.showToast({ title: '这里是空白格', icon: 'none', duration: 800 });
      return;
    }

    // 找连通区域前先转成二维网格（连通区域用的是 grid 语义）
    const r = this.regionFinder.find(this.flatGrid(), i, j);
    if (r.count === 0) return;

    const into = !codec.getBit(this.bitmap, r.cells[0]);
    const apply = () => {
      // find 返回的是复用缓冲，要立刻拷走
      const list = new Int32Array(r.count);
      for (let t = 0; t < r.count; t++) list[t] = r.cells[t];
      this.applyCells(list, into);
      wx.vibrateShort({ type: 'medium' });
    };

    if (r.count > BIG_REGION_CONFIRM) {
      wx.showModal({
        title: '这一块很大',
        content: `这一块有 ${r.count} 颗豆子，确认要一次性全部标记为「${into ? '已拼' : '未拼'}」吗？`,
        confirmText: '确认',
        success: (m) => {
          if (m.confirm) apply();
        },
      });
    } else {
      apply();
    }
  },

  /**
   * 连通区域模块吃的是 grid（二维对象数组）。这里现搭一个**只含 key 的轻量网格**，
   * 避免每次长按都把整个项目解包一遍。
   */
  flatGrid() {
    if (this._gridCache && this._gridCacheCells === this.cells.length) return this._gridCache;
    const N = this.dims.N;
    const M = this.dims.M;
    const g = new Array(M);
    for (let j = 0; j < M; j++) {
      const row = new Array(N);
      for (let i = 0; i < N; i++) {
        const idx = this.cells[j * N + i];
        row[i] =
          idx === codec.EXTERNAL_INDEX
            ? { key: 'ERASE', color: '#FFFFFF', isExternal: true }
            : { key: this.hexes[idx], color: this.hexes[idx] };
      }
      g[j] = row;
    }
    this._gridCache = g;
    this._gridCacheCells = this.cells.length;
    return g;
  },

  /** 统一的落笔入口：幂等、增量更新计数、压撤销栈、节流落盘 */
  applyCells(indices, into) {
    const buf = this.bitmap;
    const N = this.dims.N;
    const changed = [];
    const prev = [];
    let delta = 0;

    for (let t = 0; t < indices.length; t++) {
      const k = indices[t];
      const was = codec.getBit(buf, k);
      if (was === into) continue; // 幂等
      const idx = this.cells[k];
      // 越界写 Int32Array 是静默忽略的，这里挡一下免得计数悄悄错掉
      if (idx === codec.EXTERNAL_INDEX || idx >= this.hexes.length) continue;
      codec.setBit(buf, k, into);
      if (into) this.colorDone[idx]++;
      else this.colorDone[idx]--;
      delta += into ? 1 : -1;
      changed.push(k);
      prev.push(was ? 1 : 0);
    }
    if (changed.length === 0) return;

    this.doneTotal += delta;

    // 撤销栈：记下改了哪些格、原来是什么状态、以及受影响的颜色
    const touched = new Set();
    for (let t = 0; t < changed.length; t++) touched.add(this.cells[changed[t]]);
    this.undoStack.push({
      indices: changed,
      prev,
      touched: Array.from(touched),
      colorDonePrev: Array.from(touched).map((i) => this.colorDone[i]),
      delta,
    });
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();

    this.redraw();
    this.setData({
      doneText: `${this.doneTotal} / ${this.beadTotal}`,
      progressPercent: this.beadTotal
        ? Math.round((this.doneTotal / this.beadTotal) * 100)
        : 0,
      undoCount: this.undoStack.length,
    });
    if (this.currentIdx >= 0) this.patchColorProgress(this.currentIdx);

    this.markDirty();

    // 这个色拼完了 → 自动跳到下一个未完成色
    const curIdx = this.currentIdx;
    if (curIdx >= 0 && this.colorDone[curIdx] >= this.colorTotal[curIdx] && this.beadTotal !== this.doneTotal) {
      wx.vibrateShort({ type: 'medium' });
      this.advanceColor();
    }
  },

  /** 自动跳到下一个未完成色（保留原版这个好设计） */
  advanceColor() {
    const n = this.hexes.length;
    for (let step = 1; step <= n; step++) {
      const i = (this.currentIdx + step) % n;
      if (this.colorDone[i] < this.colorTotal[i]) {
        this.setCurrent(this.hexes[i], i);
        return;
      }
    }
  },

  setCurrent(hex, idx) {
    this.currentColor = hex;
    this.currentIdx = idx;
    const list = this.data.colorList;
    const patch = { currentKey: this.keys[idx], currentSwatch: hex };
    for (let k = 0; k < list.length; k++) {
      const isCur = list[k].idx === idx;
      if (list[k].isCurrent !== isCur) patch[`colorList[${k}].isCurrent`] = isCur;
    }
    this.setData(patch);
    this.redraw();
    this.markDirty();
  },

  onColorTap(e) {
    const idx = e.currentTarget.dataset.idx;
    if (idx === undefined || idx === this.currentIdx) return;
    this.setCurrent(this.hexes[idx], idx);
  },

  onToggleFocus() {
    this.setData({ focusOnly: !this.data.focusOnly });
    this.redraw();
  },

  onUndo() {
    const a = this.undoStack.pop();
    if (!a) {
      wx.showToast({ title: '没有可撤销的操作', icon: 'none' });
      return;
    }
    for (let t = 0; t < a.indices.length; t++) {
      codec.setBit(this.bitmap, a.indices[t], a.prev[t] === 1);
    }
    for (let t = 0; t < a.touched.length; t++) {
      this.colorDone[a.touched[t]] = a.colorDonePrev[t];
    }
    this.doneTotal -= a.delta;

    this.redraw();
    this.setData({
      doneText: `${this.doneTotal} / ${this.beadTotal}`,
      progressPercent: this.beadTotal
        ? Math.round((this.doneTotal / this.beadTotal) * 100)
        : 0,
      undoCount: this.undoStack.length,
    });
    if (this.currentIdx >= 0) this.patchColorProgress(this.currentIdx);
    this.markDirty();
  },

  markDirty() {
    this.dirty = true;
    projectStore.markDirty(this.projectId, {
      bitmap: this.bitmap,
      view: this.viewSnapshot(),
      currentColor: this.currentColor,
    });
    this.setData({ saveError: !!projectStore.getLastError() });
  },

  onReset() {
    wx.showModal({
      title: '重置进度',
      content: '会把这张图纸的已拼进度全部清空，图纸本身不受影响。确定吗？',
      confirmText: '重置',
      confirmColor: '#dc2626',
      success: (m) => {
        if (!m.confirm) return;
        this.bitmap.fill(0);
        this.colorDone.fill(0);
        this.doneTotal = 0;
        this.undoStack = [];
        this.redraw();
        this.refreshColorList();
        this.setData({ undoCount: 0 });
        this.markDirty();
        projectStore.flushSync();
        wx.showToast({ title: '进度已重置', icon: 'success' });
      },
    });
  },

  onBack() {
    this.flush();
    wx.navigateBack();
  },
});
