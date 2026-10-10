const projectStore = require('../../utils/projectStore');
const codec = require('../../utils/projectCodec');
const gridCanvas = require('../../utils/gridCanvas');
const canvasHelper = require('../../utils/canvasHelper');
const paletteUtil = require('../../utils/palette');
const { createRegionFinder } = require('../../utils/connectedRegion');

/** 长按判定：在 touchend 时按按住时长判断，**不设定时器** ——
 *  这样长按后继续拖动就自然变成平移，不需要处理 touchcancel。 */
const LONG_PRESS_MS = 420;
const MOVE_TOLERANCE = 6;
/** 单块超过这么多格，长按标记前先确认（避免误标一整片背景） */
const BIG_REGION_CONFIRM = 500;
/**
 * 恢复「上次在拼的色号」的最低占比门槛。
 * 低于这个占比就不恢复、直接换成剩余最多的 —— 否则单色模式下
 * 整张画布几乎全是淡灰，看着像没画（这个坑踩过两次了）。
 */
const MIN_CURRENT_SHARE = 0.05;
const MAX_UNDO = 50;

/**
 * 预计算的显示色。
 *
 * 「只看当前色」时非当前色淡成一张**淡彩图**：整张图案的轮廓还在，
 * 当前色号是清晰的那一层，一眼就能找到要摆的位置。
 *
 * ⚠️ 淡出目标**不能和空白格同色**。
 * 之前这里往 #F3F4F6 混，而空白格也是 #F3F4F6 —— 结果整张画布糊成一片浅灰，
 * 看着就像「没有图片」。现在淡出用浅灰 #e5e7eb、空白格用纯白，两者分得开。
 */
const FADE_T = 0.62;
/**
 * 0.55 是量出来的：0.72 时淡出来的颜色是 rgb(225,226,225)，
 * 在白底上肉眼几乎看不出（学员就是因此以为「没有图片」）。
 */
const FADE_STRONG_T = 0.55;
/** 淡出目标：浅灰。**不能等于 BLANK_COLOR** */
const FADE_STRONG_TARGET = '#e5e7eb';
const DONE_T = 0.55;
/** 空白格：纯白，让它退到后面去 */
const BLANK_COLOR = '#FFFFFF';

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
    /** 还剩多少颗没拼（这个色号） */
    currentRemain: 0,
    currentTotal: 0,
    currentDone: 0,
    currentPercent: 0,
    /**
     * 默认**只显示当前色号**（其他色淡掉）。
     * 这个工具的定位是「按色号分批拼」的辅助：倒出一盒 A01，
     * 一眼看到它所有的位置，摆完换下一盒。
     * 在纸质图纸上找出分散的几十处同一个色号是最难受的一步。
     */
    singleColor: true,
    zoom: 1,
    canvasW: 300,
    canvasH: 300,
    wrapH: 300,
    undoCount: 0,
    saveError: false,
    debugProbe: '',
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
    // 恢复上次在拼的色号，但**只有它还剩足够多**才恢复。
    // 踩过的坑：老版本会把「编码时第一个遇到的颜色」（可能只占 0.2%）存下来，
    // 恢复它会让单色模式下整张画布几乎全是淡灰，看着像没画。
    // 太小就直接换成剩余最多的色号。
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

    // 尺寸从**窗口高度**算，不再依赖容器测量 ——
    // 结构和编辑器页（画布显示正常）对齐：整页普通文档流，不是 flex + 100vh。
    const info = canvasHelper.getWindowInfo();
    const box = gridCanvas.fitBox(
      info.windowWidth - 24,
      Math.max(200, info.windowHeight - 370),
      this.dims.M / this.dims.N
    );
    this.cssW = box.w;
    this.cssH = box.h;
    await new Promise((r) =>
      this.setData({ name: p.name, canvasW: box.w, canvasH: box.h, wrapH: box.h }, r)
    );

    try {
      this.display = await canvasHelper.initDisplayCanvas('#pattern', this);
    } catch (e) {
      this.bail(e.message || '画布初始化失败');
      return;
    }

    this.restoreView(p.view);
    this.refreshColorList();
    // 关掉加载遮罩，**在渲染回调里再画** —— 避免页面更新发生在绘制之后
    this.setData({ ready: true }, () => {
      this.redraw();
    });

    // 【临时诊断 + 尝试自修复】
    // 重新取一次 canvas 节点，和首次取的比对：
    //   不是同一个对象 → 页面更新把节点换掉了，我们一直在往脱离文档的旧节点上画
    //   是同一个       → 节点没问题，得换别的思路
    // 如果是前者，就用新节点重新初始化并重绘 —— 屏幕上应该立刻出现绿方块。
    const self = this;
    setTimeout(function () {
      if (!self.display) return;
      wx.createSelectorQuery()
        .in(self)
        .select('#pattern')
        .fields({ node: true, size: true })
        .exec(function (res) {
          const info = res && res[0];
          if (!info || !info.node) {
            self.setData({ debugProbe: '重取节点失败 · ' + (self.data.debugProbe || '') });
            return;
          }
          const same = info.node === self.display.canvas;
          const mark = function (d, tag) {
            self.display = d;
            self.redraw();
            const c = d.ctx;
            const cv = d.canvas;
            c.setTransform(1, 0, 0, 1, 0, 0);
            c.fillStyle = '#00FF00';
            c.fillRect(cv.width - 70, cv.height - 70, 60, 60);
            self.setData({
              debugProbe:
                tag + ' · 尺寸 ' + cv.width + '×' + cv.height + ' · ' + (self.data.debugProbe || ''),
            });
          };
          if (same) {
            mark(self.display, '节点没变（同一个对象）');
          } else {
            canvasHelper.initDisplayCanvas('#pattern', self).then(function (d) {
              mark(d, '★节点被换过！已用新节点重绘');
            });
          }
        });
    }, 1500);
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
      this.faint[i] = paletteUtil.mixHex(hex, FADE_STRONG_TARGET, FADE_STRONG_T);
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
   *
   * 不用 `hexes[0]`：那是「编码时第一个遇到的颜色」，纯属任意 ——
   * 实测抽中一个只有 13 颗（占 0.2%）的色号，单色模式下整张画布
   * 99.8% 都是淡灰，看着就跟没画一样。
   * 先拼大色块也符合实际工序。
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
    if (best >= 0) return this.hexes[best];
    return this.hexes[0] || '';
  },

  /** 色号列表：顺序固定（按色号排），**不要把完成的挪到后面** ——
   *  边拼边重排会让人失去空间感。顺带记下排序后的顺序，供「上一个/下一个色」用。 */
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

  /** 顶部「正在拼 XX · 还剩 N 颗」那一块的字段 */
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

  // ---------- 渲染 ----------

  /** 只更新当前色那行的进度 + 顶部那一块，避免整块数组重发 */
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

  redraw() {
    if (!this.display) return;
    const { ctx, cssW, cssH, dpr } = this.display;
    const N = this.dims.N;
    const cells = this.cells;
    const bitmap = this.bitmap;
    // 正常情况下 currentIdx 一定有效；万一颜色表对不上，退回 0 也比整张画布空白强
    const curIdx = this.currentIdx >= 0 ? this.currentIdx : 0;
    // singleColor 开启时其他色号淡到几乎看不见 —— 当前色的位置一眼跳出来
    const focus = this.data.singleColor;
    const solid = this.solid;
    const faded = this.faded;
    const faint = this.faint;
    const doneColors = this.done;
    const EXTERNAL = BLANK_COLOR;
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
      // minCellPx 放到 3：80x80 的图在手机上每格约 4.4px，原来 5 的门槛导致
      // 一条网格线都不画，整块画布看着更空
      gridLines: { color: 'rgba(0, 0, 0, 0.16)', width: 0.6, minCellPx: 3 },
      border: { color: 'rgba(0, 0, 0, 0.3)', width: 1 },
    });

    // 【临时诊断】定位完就删。
    // 1) 在画布左上角画一个品红方块 —— 用户看得见就说明画布本身能显示，
    //    看不见就说明问题在「画布没显示出来」而不是「颜色不对」。
    // 2) 回读 9 个点的颜色，数有多少不是白的。
    // 3) 查画布在屏幕上的真实位置和尺寸。
    if (!this._probed) {
      this._probed = true;
      const canvas = this.display.canvas;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#FF00FF';
      ctx.fillRect(4, 4, 44, 44);

      let nonWhite = 0;
      const samples = [];
      try {
        for (let gy = 1; gy <= 3; gy++) {
          for (let gx = 1; gx <= 3; gx++) {
            const x = Math.floor((canvas.width * gx) / 4);
            const y = Math.floor((canvas.height * gy) / 4);
            const px = ctx.getImageData(x, y, 1, 1).data;
            samples.push(`${px[0]},${px[1]},${px[2]}`);
            if (px[0] < 250 || px[1] < 250 || px[2] < 250) nonWhite++;
          }
        }
      } catch (e) {
        samples.push('回读失败:' + (e.message || e));
      }

      const remain = this.colorTotal[curIdx] - this.colorDone[curIdx];
      const share = this.beadTotal ? ((remain / this.beadTotal) * 100).toFixed(1) : '0';

      wx.createSelectorQuery()
        .in(this)
        .select('#pattern')
        .boundingClientRect()
        .exec((res) => {
          const r = res && res[0] ? res[0] : {};
          this.setData({
            debugProbe:
              `非白点 ${nonWhite}/9 [${samples.join(' | ')}] · ` +
              `canvas ${canvas.width}×${canvas.height} · ` +
              `屏幕 ${Math.round(r.left || 0)},${Math.round(r.top || 0)} 尺寸 ${Math.round(r.width || 0)}×${Math.round(r.height || 0)} · ` +
              `当前色 ${this.keys[curIdx]} 剩 ${remain}（${share}%）`,
          });
        });
    }
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
    const patch = this.currentColorPatch();
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

  /** 按色号顺序切到上一个/下一个（分批拼的自然操作：倒一盒、拼完、换下一盒） */
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
    this.setData({ singleColor: !this.data.singleColor });
    this.redraw();
  },

  /**
   * 「这个色拼完了」：把当前色号**剩下没拼的格子一次性标完**，然后跳到下一个色号。
   *
   * 这是分批拼法的核心加速 —— 盯着只剩当前色的图纸把豆子摆完，
   * 然后一个按钮收尾，不用回头一颗颗打勾。
   */
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
        if (!m.confirm) return;
        this.markWholeColor(idx);
      },
    });
  },

  /** 把某个色号剩下所有格子标为已拼（可撤销） */
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

    // 交给 applyCells 统一处理：它会压撤销栈、更新计数、节流落盘，
    // 并且因为这个色已经拼完而**自动跳到下一个未完成色**（不用在这里再跳一次）
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
