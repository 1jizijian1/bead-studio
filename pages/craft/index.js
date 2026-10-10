const projectStore = require('../../utils/projectStore');
const codec = require('../../utils/projectCodec');
const canvasHelper = require('../../utils/canvasHelper');
const gridImage = require('../../utils/gridImage');
const paletteUtil = require('../../utils/palette');
const { createRegionFinder } = require('../../utils/connectedRegion');

/** 长按判定：在 touchend 时按按住时长判断，**不设定时器** */
const LONG_PRESS_MS = 420;
/** 手指移动超过这么多像素就算「在滚动」，不算点击 */
const MOVE_TOLERANCE = 8;
/** 单块超过这么多格，长按标记前先确认 */
const BIG_REGION_CONFIRM = 500;
const MAX_UNDO = 50;
/** 恢复「上次在拼的色号」的最低占比门槛 */
const MIN_CURRENT_SHARE = 0.05;
/** 点格子标记后，隔这么久再重渲染图片（连着点只渲染一次） */
const RERENDER_DEBOUNCE = 350;

/**
 * 预计算的显示色。
 * 「只看当前色」时**其他色号直接不画**（和空白格一样是白底）——
 * 图纸上只剩当前色号的豆子，一眼就能找到该摆哪。
 * 关掉之后是「显示全部色」：所有色保留但整体压暗，用来看整体效果。
 *
 * ⚠️ 压暗目标**不能和空白格同色** —— 之前往 #F3F4F6 混、而空白格也是 #F3F4F6，
 * 整张图糊成一片浅灰，看着就像「没有图片」。
 */
const FADE_T = 0.62;
const DONE_T = 0.55;
const BLANK_COLOR = '#FFFFFF';

Page({
  data: {
    ready: false,
    rendering: false,
    name: '',
    dims: { N: 0, M: 0 },
    progressPercent: 0,
    doneText: '',
    colorList: [],
    currentKey: '',
    currentSwatch: '',
    currentRemain: 0,
    currentTotal: 0,
    currentDone: 0,
    currentPercent: 0,
    /** 默认只显示当前色号（其他色淡成淡彩图）—— 这个工具的定位就是按色号分批拼 */
    singleColor: true,
    zoom: 1,
    zoomSteps: gridImage.ZOOM_STEPS,
    boxH: 320,
    imgW: 300,
    imgH: 300,
    patternSrc: '',
    /** 隐藏渲染画布的 CSS 尺寸（和 backing store 一致） */
    rw: 1,
    rh: 1,
    undoCount: 0,
    saveError: false,
  },

  // ---------- 生命周期 ----------

  onLoad(options) {
    this.projectId = options && options.id;
    this.undoStack = [];
    this.touch = null;
    this._renderTimer = null;
  },

  async onReady() {
    if (!this.projectId) return this.bail('没有指定项目');
    const p = projectStore.loadProject(this.projectId);
    if (!p) return this.bail('项目不存在或已损坏');

    this.model = p;
    this.dims = p.dims;
    this.bitmap = p.bitmap;
    this.cells = p.cells;
    this.hexes = p.hexes;
    this.colorSystem = p.colorSystem || 'MARD';
    this.regionFinder = createRegionFinder(p.dims);
    this.undoStack = [];

    // 顺序要紧：recount -> 选当前色 -> 建颜色表
    this.recount();
    const savedIdx = p.currentColor ? this.hexes.indexOf(p.currentColor) : -1;
    const savedShare =
      savedIdx >= 0 && this.beadTotal
        ? (this.colorTotal[savedIdx] - this.colorDone[savedIdx]) / this.beadTotal
        : 0;
    this.currentColor =
      savedShare >= MIN_CURRENT_SHARE ? p.currentColor : this.firstUnfinishedColor();
    this.buildColorTables();

    if (p.dropped) {
      wx.showToast({ title: '图纸尺寸变了，进度已重置', icon: 'none', duration: 2500 });
    } else if (p.changed) {
      wx.showToast({ title: '图纸有改动，部分进度已清理', icon: 'none', duration: 2500 });
    }

    // 算显示尺寸：让整张图纸在 zoom=1 时完整放进框里
    const info = canvasHelper.getWindowInfo();
    const boxW = info.windowWidth - 24;
    const boxH = Math.max(220, info.windowHeight - 420);
    this.basePx = Math.max(
      2,
      Math.floor(Math.min(boxW / this.dims.N, boxH / this.dims.M))
    );

    this.setData({ name: p.name, boxH, dims: p.dims });
    this.refreshColorList();
    this.setData({ ready: true });
    await this.render();
  },

  onHide() {
    this.flush();
  },

  onUnload() {
    this.flush();
    if (this._renderTimer) clearTimeout(this._renderTimer);
    this.model = null;
  },

  /**
   * 不拦用户离开（不调 enableAlertBeforeUnload）。进度是自动保存的，
   * 加拦截反而让人以为「不点确认就丢了」。⚠️ 后人别「好心」加上。
   *
   * 这里的 flush 是**第二道保险** —— 每次改动其实已经实时落盘了（见 markDirty）。
   */
  flush() {
    if (!this.model) return;
    projectStore.flushSync();
  },

  bail(msg) {
    wx.showToast({ title: msg, icon: 'none' });
    setTimeout(() => wx.navigateBack(), 900);
  },

  // ---------- 颜色表 ----------

  buildColorTables() {
    const n = this.hexes.length;
    this.solid = new Array(n);
    this.faded = new Array(n);
    this.done = new Array(n);
    this.keys = new Array(n);

    for (let i = 0; i < n; i++) {
      const hex = this.hexes[i];
      this.solid[i] = hex;
      this.faded[i] = paletteUtil.mixHex(hex, '#9ca3af', FADE_T);
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

  /**
   * 默认选中**剩余颗数最多**的色号。
   * 不用 `hexes[0]`：那是「编码时第一个遇到的颜色」，纯属任意 ——
   * 抽中一个占比 0.2% 的色号会让单色模式下整张图看着像没画。
   */
  firstUnfinishedColor() {
    let best = -1;
    let bestRemain = 0;
    for (let i = 0; i < this.hexes.length; i++) {
      const remain = this.colorTotal[i] - this.colorDone[i];
      if (remain > bestRemain) {
        bestRemain = remain;
        best = i;
      }
    }
    return best >= 0 ? this.hexes[best] : this.hexes[0] || '';
  },

  refreshColorList() {
    const order = [];
    for (let i = 0; i < this.hexes.length; i++) order.push(i);
    order.sort((a, b) => paletteUtil.sortColorKeys(this.keys[a], this.keys[b]));
    this.sortedIdx = order;

    const list = order.map((i) => ({
      idx: i,
      hex: this.hexes[i],
      key: this.keys[i],
      total: this.colorTotal[i],
      done: this.colorDone[i],
      isDone: this.colorDone[i] >= this.colorTotal[i],
      isCurrent: this.hexes[i] === this.currentColor,
    }));

    this.setData(
      Object.assign(
        {
          colorList: list,
          doneText: `${this.doneTotal} / ${this.beadTotal}`,
          progressPercent: this.beadTotal
            ? Math.round((this.doneTotal / this.beadTotal) * 100)
            : 0,
        },
        this.currentColorPatch()
      )
    );
  },

  currentColorPatch() {
    const idx = this.currentIdx >= 0 ? this.currentIdx : 0;
    const total = this.colorTotal ? this.colorTotal[idx] : 0;
    const done = this.colorDone ? this.colorDone[idx] : 0;
    return {
      currentKey: this.keys[idx],
      currentSwatch: this.hexes[idx],
      currentTotal: total,
      currentDone: done,
      currentRemain: Math.max(0, total - done),
      currentPercent: total ? Math.round((done / total) * 100) : 0,
    };
  },

  patchColorProgress(idx) {
    const patch = {};
    if (idx === this.currentIdx) Object.assign(patch, this.currentColorPatch());
    const list = this.data.colorList;
    for (let k = 0; k < list.length; k++) {
      if (list[k].idx === idx) {
        patch[`colorList[${k}].done`] = this.colorDone[idx];
        patch[`colorList[${k}].isDone`] = this.colorDone[idx] >= this.colorTotal[idx];
        break;
      }
    }
    if (Object.keys(patch).length) this.setData(patch);
  },

  // ---------- 出图 ----------

  cellPx() {
    return (this.basePx || 4) * this.data.zoom;
  },

  /** 每格的显示色。这是「画什么」的全部逻辑，出图时逐格调用 */
  makeColorFn() {
    const N = this.dims.N;
    const cells = this.cells;
    const bitmap = this.bitmap;
    const curIdx = this.currentIdx >= 0 ? this.currentIdx : 0;
    const focus = this.data.singleColor;
    const solid = this.solid;
    const faded = this.faded;
    const doneColors = this.done;
    const EXTERNAL = BLANK_COLOR;
    const EXT_IDX = codec.EXTERNAL_INDEX;

    return (i, j) => {
      const k = j * N + i;
      const idx = cells[k];
      if (idx === EXT_IDX) return EXTERNAL;
      if (codec.getBit(bitmap, k)) return doneColors[idx];
      if (idx === curIdx) return solid[idx];
      // 只看当前色：**其他色号一律不画**（和空白格一样白），
      // 图纸上就只剩当前色号的豆子 —— 一眼看到该摆哪
      return focus ? EXTERNAL : faded[idx];
    };
  },

  /** 渲染成图片。隐藏画布只用来出图，不参与显示 */
  async render() {
    if (!this.model || this._rendering) return;
    this._rendering = true;
    this.setData({ rendering: true });

    try {
      const cellPx = this.cellPx();
      const w = Math.max(1, Math.round(this.dims.N * cellPx));
      const h = Math.max(1, Math.round(this.dims.M * cellPx));

      // 先给隐藏画布定 CSS 尺寸（要和 backing store 一致），渲染回调后再取节点
      if (w !== this.data.rw || h !== this.data.rh) {
        await new Promise((r) => this.setData({ rw: w, rh: h }, r));
      }

      const info = await canvasHelper.selectNode('#render', this);
      if (!info || !info.node) throw new Error('拿不到隐藏画布节点');

      const src = await gridImage.renderToImage(info.node, {
        dims: this.dims,
        cellPx,
        getColor: this.makeColorFn(),
      });

      this.setData({ patternSrc: src, imgW: w, imgH: h, rendering: false });
    } catch (e) {
      console.error('出图失败', e);
      this.setData({ rendering: false });
      wx.showToast({ title: (e && e.message) || '出图失败', icon: 'none' });
    } finally {
      this._rendering = false;
    }
  },

  /** 点格子后的重渲染：防抖，连着点只渲染一次 */
  scheduleRender() {
    if (this._renderTimer) clearTimeout(this._renderTimer);
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      this.render();
    }, RERENDER_DEBOUNCE);
  },

  onZoomChange(e) {
    const zoom = Number(e.currentTarget.dataset.zoom);
    if (!zoom || zoom === this.data.zoom) return;
    this.setData({ zoom }, () => this.render());
  },

  // ---------- 手势 ----------

  onTouchStart(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (!t) return;
    this.touch = { x: t.clientX, y: t.clientY, t0: Date.now() };
  },

  async onTouchEnd(e) {
    const start = this.touch;
    this.touch = null;
    if (!start) return;

    const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
    if (!t) return;

    // 手指移动过就是在滚动，不算点击
    if (
      Math.abs(t.clientX - start.x) > MOVE_TOLERANCE ||
      Math.abs(t.clientY - start.y) > MOVE_TOLERANCE
    ) {
      return;
    }

    const rect = await gridImage.queryRect('.pattern-img', this);
    const hit = gridImage.hitTest(t.clientX, t.clientY, rect, this.dims);
    if (!hit.inside) return;

    if (Date.now() - start.t0 >= LONG_PRESS_MS) this.toggleRegion(hit.i, hit.j);
    else this.toggleCell(hit.i, hit.j);
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

  toggleRegion(i, j) {
    if (this.isBlankAt(i, j)) {
      wx.vibrateShort({ type: 'light' });
      wx.showToast({ title: '这里是空白格', icon: 'none', duration: 800 });
      return;
    }

    const r = this.regionFinder.find(this.flatGrid(), i, j);
    if (r.count === 0) return;

    const into = !codec.getBit(this.bitmap, r.cells[0]);
    const apply = () => {
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

  /** 连通区域模块吃二维网格；这里缓存一份轻量网格，避免每次长按都重建 */
  flatGrid() {
    if (this._gridCache) return this._gridCache;
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
    return g;
  },

  /** 统一的落笔入口：幂等、增量计数、压撤销栈、节流落盘、防抖重渲染 */
  applyCells(indices, into) {
    const buf = this.bitmap;
    const changed = [];
    const prev = [];
    let delta = 0;

    for (let t = 0; t < indices.length; t++) {
      const k = indices[t];
      const was = codec.getBit(buf, k);
      if (was === into) continue;
      const idx = this.cells[k];
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

    this.setData({
      doneText: `${this.doneTotal} / ${this.beadTotal}`,
      progressPercent: this.beadTotal
        ? Math.round((this.doneTotal / this.beadTotal) * 100)
        : 0,
      undoCount: this.undoStack.length,
    });
    if (this.currentIdx >= 0) this.patchColorProgress(this.currentIdx);
    this.scheduleRender();
    this.markDirty();

    const curIdx = this.currentIdx;
    if (
      curIdx >= 0 &&
      this.colorDone[curIdx] >= this.colorTotal[curIdx] &&
      this.beadTotal !== this.doneTotal
    ) {
      wx.vibrateShort({ type: 'medium' });
      this.advanceColor();
    }
  },

  /** 自动跳到下一个未完成色（原版的好设计，保留） */
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
    const patch = this.currentColorPatch();
    for (let k = 0; k < list.length; k++) {
      const isCur = list[k].idx === idx;
      if (list[k].isCurrent !== isCur) patch[`colorList[${k}].isCurrent`] = isCur;
    }
    this.setData(patch);
    this.render(); // 换了当前色，图要重出
    this.markDirty();
  },

  onColorTap(e) {
    const idx = e.currentTarget.dataset.idx;
    if (idx === undefined || idx === this.currentIdx) return;
    this.setCurrent(this.hexes[idx], idx);
  },

  stepColor(delta) {
    const order = this.sortedIdx;
    if (!order || !order.length) return;
    let pos = order.indexOf(this.currentIdx);
    if (pos < 0) pos = 0;
    const next = order[(pos + delta + order.length) % order.length];
    this.setCurrent(this.hexes[next], next);
  },

  onPrevColor() {
    this.stepColor(-1);
  },

  onNextColor() {
    this.stepColor(1);
  },

  onToggleSingleColor() {
    this.setData({ singleColor: !this.data.singleColor }, () => this.render());
  },

  /** 「这盒拼完了」：把当前色号剩下的格子一次性标完，并自动跳下一个色号 */
  onFinishColor() {
    const idx = this.currentIdx;
    if (idx < 0) return;
    const remain = this.colorTotal[idx] - this.colorDone[idx];
    if (remain <= 0) {
      this.stepColor(1);
      return;
    }
    wx.showModal({
      title: `拼完 ${this.keys[idx]}`,
      content: `把 ${this.keys[idx]} 剩下没拼的 ${remain} 颗都标成已拼，然后跳到下一个色号。确定吗？`,
      confirmText: '拼完了',
      success: (m) => {
        if (m.confirm) this.markWholeColor(idx);
      },
    });
  },

  markWholeColor(idx) {
    const cells = this.cells;
    const list = new Int32Array(cells.length);
    let n = 0;
    for (let k = 0; k < cells.length; k++) {
      if (cells[k] === idx && !codec.getBit(this.bitmap, k)) list[n++] = k;
    }
    if (n === 0) {
      this.stepColor(1);
      return;
    }
    // applyCells 会压撤销栈、更新计数、并在该色拼完时自动跳下一个色号
    this.applyCells(list.subarray(0, n), true);
    wx.vibrateShort({ type: 'medium' });
    wx.showToast({ title: `${this.keys[idx]} 标为已拼`, icon: 'none' });
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

    this.setData({
      doneText: `${this.doneTotal} / ${this.beadTotal}`,
      progressPercent: this.beadTotal
        ? Math.round((this.doneTotal / this.beadTotal) * 100)
        : 0,
      undoCount: this.undoStack.length,
    });
    if (this.currentIdx >= 0) this.patchColorProgress(this.currentIdx);
    this.scheduleRender();
    this.markDirty();
  },

  /**
   * 每次改动**立刻同步落盘**。
   *
   * 不要改回「节流 + onHide 落盘」：用户直接杀掉小程序时 `onHide` 不一定触发
   * （开发者工具和真机都一样），节流窗口里的改动就丢了。
   * 进度数据才 1~9KB、同步写约 1ms，不值得为它做节流。
   */
  markDirty() {
    const ok = projectStore.saveNow(this.projectId, {
      bitmap: this.bitmap,
      view: null,
      currentColor: this.currentColor,
    });
    this.setData({ saveError: !ok });
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
        this.refreshColorList();
        this.setData({ undoCount: 0 });
        this.render();
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
