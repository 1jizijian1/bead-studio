const store = require('../../utils/store');
const constants = require('../../utils/constants');
const canvasHelper = require('../../utils/canvasHelper');
const paletteUtil = require('../../utils/palette');
const { createMapper } = require('../../utils/nearest');
const px = require('../../utils/pixelation');
const { globalMerge } = require('../../utils/merge');
const { computeStats, cloneGrid, sortedColorStats } = require('../../utils/stats');
const { removeBackground } = require('../../utils/background');
const { excludeColor } = require('../../utils/exclude');
const { despeckle } = require('../../utils/cleanup');
const exportPattern = require('../../utils/exportPattern');

const app = getApp();

Page({
  data: {
    previewW: 320,
    previewH: 320,
    dims: { N: 0, M: 0 },
    colorList: [],
    totalBeadCount: 0,

    granularity: constants.DEFAULT_GRANULARITY,
    granularityMin: constants.GRANULARITY_MIN,
    granularityMax: constants.GRANULARITY_MAX,

    threshold: constants.DEFAULT_THRESHOLD,
    thresholdMin: constants.THRESHOLD_MIN,
    thresholdMax: constants.THRESHOLD_MAX,

    minRegion: constants.DEFAULT_MIN_REGION,
    minRegionMin: constants.MIN_REGION_MIN,
    minRegionMax: constants.MIN_REGION_MAX,
    speckleText: '',

    zoom: 1,
    zoomText: '1.0×',

    modes: constants.MODES,
    mode: constants.DEFAULT_MODE,
    modeDesc: '',

    colorSystems: paletteUtil.COLOR_SYSTEMS,
    colorSystem: constants.DEFAULT_COLOR_SYSTEM,

    busy: false,
    busyText: '',
    progressPercent: 0,
    tip: null,

    exportCssW: 0,
    exportCssH: 0,
  },

  // ---------- 生命周期 ----------

  onLoad(options) {
    const settings = store.getSettings();
    const picked = store.getPickedImage();
    this.src = options.src ? decodeURIComponent(options.src) : picked && picked.path;
    this.resume = options.resume === '1';

    this.grid = null;
    this.dims = null;
    this.mapper = null;
    this.stats = null;
    this.excludedColorKeys = new Set();
    this.initialGridColorKeys = new Set();
    this.bgSnapshot = null;
    this.sample = null;

    // 视图变换（缩放/平移），不改画布元素尺寸，只改内部的 transform
    this.view = { scale: 1, tx: 0, ty: 0 };
    this.touch = null;

    const mode = constants.MODES.find((m) => m.value === settings.mode) || constants.MODES[0];
    this.setData({
      granularity: settings.granularity,
      threshold: settings.threshold,
      minRegion: settings.minRegion,
      speckleText: this.speckleLabel(settings.minRegion),
      mode: settings.mode,
      modeDesc: mode.desc,
      colorSystem: settings.colorSystem,
    });

    if (!this.src) {
      wx.showToast({ title: '没有可用的图片', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
    }
  },

  async onReady() {
    if (!this.src) return;

    // 画布尺寸必须在 setData 之后、渲染完成后再取节点，否则 size 是 0
    const img = store.getPickedImage();
    const aspect = img && img.width ? img.height / img.width : 1;
    const info = canvasHelper.getWindowInfo();
    const availW = info.windowWidth - 24;
    const availH = Math.round(info.windowHeight * 0.52);
    let w = availW;
    let h = Math.round(w * aspect);
    if (h > availH) {
      h = availH;
      w = Math.round(h / aspect);
    }

    await new Promise((resolve) => this.setData({ previewW: w, previewH: h }, resolve));

    try {
      this.display = await canvasHelper.initDisplayCanvas('#preview', this);
    } catch (e) {
      wx.showToast({ title: e.message || '画布初始化失败', icon: 'none' });
      return;
    }

    await this.generate();
  },

  // ---------- 生成 ----------

  getActivePalette() {
    const settings = store.getSettings();
    const full = paletteUtil.buildFullPalette();
    const sel = settings.paletteSelections;
    const excluded = this.excludedColorKeys;
    return full.filter((c) => {
      const hex = c.hex.toUpperCase();
      if (excluded.has(hex)) return false;
      if (sel && sel[hex] === false) return false;
      return true;
    });
  },

  async ensureSample() {
    if (this.sample) return this.sample;
    this.sample = await canvasHelper.sampleImageData(this.src, constants.MAX_IMAGE_EDGE);
    return this.sample;
  },

  async generate() {
    const settings = store.getSettings();
    this.setData({ busy: true, busyText: '正在识别颜色…', progressPercent: 0 });

    try {
      const sample = await this.ensureSample();
      const N = settings.granularity;
      const M = Math.max(1, Math.round((N * sample.sampleH) / sample.sampleW));

      const activePalette = this.getActivePalette();
      if (activePalette.length === 0) {
        this.setData({ busy: false });
        wx.showToast({ title: '可用颜色为空，请恢复部分排除的颜色', icon: 'none' });
        return;
      }

      const mapper = createMapper(activePalette);

      let lastShown = -1;
      const grid = await px.calculatePixelGridChunked(
        sample.imageData,
        sample.sampleW,
        sample.sampleH,
        N,
        M,
        mapper,
        settings.mode,
        (p) => {
          const percent = Math.round(p * 100);
          // 节流：变化超过 8% 才 setData 一次
          if (percent - lastShown >= 8 || percent === 100) {
            lastShown = percent;
            this.setData({ progressPercent: percent, busyText: `正在识别颜色… ${percent}%` });
          }
        }
      );

      this.setData({ progressPercent: 100, busyText: '正在合并相近颜色…' });
      // 分片让出主线程，让上面的 setData 能真正渲染
      await new Promise((r) => setTimeout(r, 0));

      globalMerge(grid.data, grid.dims, mapper.palette, settings.threshold);

      // 杂色清理：按空间连通性把小碎块并进周围主导色。
      // 原仓库 README 描述过这一步但代码里没有，是让图纸「不脏」的关键。
      this.setData({ busyText: '正在清理杂色…' });
      await new Promise((r) => setTimeout(r, 0));
      despeckle(grid.data, grid.dims, settings.minRegion);

      this.mapper = mapper;
      this.activePalette = mapper.palette;
      this.grid = grid.data;
      this.dims = grid.dims;

      this.refreshStats();
      this.redraw();
      this.setData({ busy: false });

      app.globalData.result = {
        grid: this.grid,
        dims: this.dims,
        src: this.src,
        excluded: Array.from(this.excludedColorKeys),
        initialGridColorKeys: Array.from(this.initialGridColorKeys),
      };
    } catch (e) {
      console.error(e);
      this.setData({ busy: false });
      wx.showToast({ title: e.message || '处理失败', icon: 'none' });
    }
  },

  /** 重算统计 + 颜色清单（不改网格） */
  refreshStats() {
    const stats = computeStats(this.grid, this.dims);
    // 首次生成时记录「初始网格颜色」，排除色的重映射白名单要用它；
    // 去背景会重置它（与网页版一致）
    if (this.initialGridColorKeys.size === 0) {
      this.initialGridColorKeys = stats.initialGridColorKeys;
    }
    this.stats = stats;
    this.renderStats();
  },

  renderStats() {
    const settings = store.getSettings();
    const stats = this.stats;
    const list = sortedColorStats(
      stats.colorCounts,
      settings.colorSystem,
      paletteUtil.getDisplayColorKey,
      paletteUtil.sortColorKeys
    ).map((item) =>
      Object.assign({}, item, { excluded: this.excludedColorKeys.has(item.hex.toUpperCase()) })
    );

    this.setData({
      colorList: list,
      totalBeadCount: stats.totalBeadCount,
      dims: this.dims,
    });
  },

  // ---------- 绘制 ----------

  redraw() {
    if (!this.display || !this.grid) return;
    const { ctx, cssW, cssH, dpr } = this.display;
    const N = this.dims.N;
    const M = this.dims.M;
    const view = this.view;

    // 每次重绘都从单位矩阵开始，自己叠 dpr 和视图变换（别依赖 initDisplayCanvas 里那一次 scale）
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cssW * dpr, cssH * dpr);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cssW * dpr, cssH * dpr);

    ctx.scale(dpr, dpr);
    ctx.translate(view.tx, view.ty);
    ctx.scale(view.scale, view.scale);

    const cw = cssW / N;
    const ch = cssH / M;

    // 只画可见范围内的格子：放大后能省掉绝大部分绘制
    const left = -view.tx / view.scale;
    const top = -view.ty / view.scale;
    const i0 = Math.max(0, Math.floor(left / cw));
    const i1 = Math.min(N - 1, Math.ceil((left + cssW / view.scale) / cw));
    const j0 = Math.max(0, Math.floor(top / ch));
    const j1 = Math.min(M - 1, Math.ceil((top + cssH / view.scale) / ch));

    // 按颜色批量绘制：fillStyle 只切几次，而不是每格一次
    const byColor = new Map();
    for (let j = j0; j <= j1; j++) {
      const row = this.grid[j];
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

    // 补一点点宽度防止缩放后出现缝隙；随放大倍数缩小补偿量
    const bleed = 0.5 / view.scale;
    byColor.forEach((coords, color) => {
      ctx.fillStyle = color;
      for (let t = 0; t < coords.length; t += 2) {
        ctx.fillRect(coords[t] * cw, coords[t + 1] * ch, cw + bleed, ch + bleed);
      }
    });

    // 屏幕上每格不足 4px 就不画网格线，否则整片糊成灰的
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

    // 外框
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.lineWidth = 1 / view.scale;
    ctx.strokeRect(0, 0, cssW, cssH);
  },

  // ---------- 缩放 / 平移 ----------

  clampView() {
    const { cssW, cssH } = this.display;
    const s = this.view.scale;
    const minTx = cssW - cssW * s;
    const minTy = cssH - cssH * s;
    this.view.tx = Math.min(0, Math.max(minTx, this.view.tx));
    this.view.ty = Math.min(0, Math.max(minTy, this.view.ty));
  },

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
      this.moved = true;
    }
  },

  onTouchMove(e) {
    const t = this.touch;
    const touches = e.touches || [];
    if (!t || !this.display) return;

    if (t.mode === 'pan' && touches.length === 1) {
      const dx = touches[0].x - t.x;
      const dy = touches[0].y - t.y;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) this.moved = true;
      this.view.tx = t.tx + dx;
      this.view.ty = t.ty + dy;
      this.clampView();
      this.redraw();
    } else if (t.mode === 'pinch' && touches.length >= 2) {
      const a = touches[0];
      const b = touches[1];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (t.dist < 1) return;
      const next = Math.max(1, Math.min(12, (t.scale * dist) / t.dist));
      // 以两指中点为锚点：该点在内容坐标系里的位置保持不变
      const gx = (t.cx - t.tx) / t.scale;
      const gy = (t.cy - t.ty) / t.scale;
      this.view.scale = next;
      this.view.tx = t.cx - gx * next;
      this.view.ty = t.cy - gy * next;
      this.clampView();
      this.redraw();
    }
  },

  onTouchEnd() {
    this.touch = null;
    if (!this.display) return;
    const s = this.view.scale;
    if (Math.abs(this.data.zoom - s) > 0.001) {
      this.setData({ zoom: s, zoomText: s.toFixed(1) + '×' });
    }
  },

  onResetZoom() {
    this.view = { scale: 1, tx: 0, ty: 0 };
    this.setData({ zoom: 1, zoomText: '1.0×' });
    this.redraw();
  },

  onCanvasTap(e) {
    if (!this.grid || !this.display) return;
    if (this.moved) return; // 刚才是在拖动/缩放，不算点击
    const detail = e.detail || {};
    const touch = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    // bindtap 的 e.detail.x/y 已经是相对 canvas 的 CSS px，不要再乘 dpr
    const sx = typeof detail.x === 'number' ? detail.x : touch ? touch.x : NaN;
    const sy = typeof detail.y === 'number' ? detail.y : touch ? touch.y : NaN;
    if (isNaN(sx) || isNaN(sy)) return;

    const { cssW, cssH } = this.display;
    const view = this.view;
    // 屏幕坐标 -> 内容坐标（逆变换）
    const gx = (sx - view.tx) / view.scale;
    const gy = (sy - view.ty) / view.scale;

    const i = Math.floor(gx / (cssW / this.dims.N));
    const j = Math.floor(gy / (cssH / this.dims.M));
    if (i < 0 || i >= this.dims.N || j < 0 || j >= this.dims.M) return;

    const cell = this.grid[j][i];
    const settings = store.getSettings();
    this.setData({
      tip: {
        color: cell.color,
        key: cell.isExternal ? '空白' : paletteUtil.getDisplayColorKey(cell.color, settings.colorSystem),
        isExternal: !!cell.isExternal,
      },
    });
  },

  onCloseTip() {
    this.setData({ tip: null });
  },

  // ---------- 参数 ----------

  onGranularityChanging(e) {
    this.setData({ granularity: e.detail.value }); // 拖动中只更新数字，不重算
  },

  onGranularityChange(e) {
    const granularity = e.detail.value;
    this.setData({ granularity });
    store.updateSettings({ granularity });
    this.generate();
  },

  onThresholdChanging(e) {
    this.setData({ threshold: e.detail.value });
  },

  onThresholdChange(e) {
    const threshold = e.detail.value;
    this.setData({ threshold });
    store.updateSettings({ threshold });
    this.generate();
  },

  speckleLabel(v) {
    return v <= 1 ? '不清理（保留所有小碎块）' : `小于 ${v} 格的碎块会并入周围颜色`;
  },

  onMinRegionChanging(e) {
    const minRegion = e.detail.value;
    this.setData({ minRegion, speckleText: this.speckleLabel(minRegion) });
  },

  onMinRegionChange(e) {
    const minRegion = e.detail.value;
    this.setData({ minRegion, speckleText: this.speckleLabel(minRegion) });
    store.updateSettings({ minRegion });
    this.generate();
  },

  onModeChange(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.mode) return;
    const found = constants.MODES.find((m) => m.value === mode);
    this.setData({ mode, modeDesc: found ? found.desc : '' });
    store.updateSettings({ mode });
    this.generate();
  },

  onColorSystemChange(e) {
    const colorSystem = e.currentTarget.dataset.system;
    if (colorSystem === this.data.colorSystem) return;
    this.setData({ colorSystem });
    store.updateSettings({ colorSystem });
    this.renderStats(); // 只影响显示色号，不需要重算网格
  },

  // ---------- 去背景 ----------

  onRemoveBackground() {
    if (!this.grid) return;
    const snapshot = {
      grid: cloneGrid(this.grid, this.dims),
      colorCounts: this.stats.colorCounts,
      totalBeadCount: this.stats.totalBeadCount,
      initialGridColorKeys: new Set(this.initialGridColorKeys),
    };

    const res = removeBackground(this.grid, this.dims);
    if (!res.ok) {
      wx.showToast({ title: res.reason, icon: 'none' });
      return;
    }

    this.bgSnapshot = snapshot;
    this.grid = res.data;
    // 与网页版一致：去背景后重置「初始网格颜色」
    this.stats = computeStats(this.grid, this.dims);
    this.initialGridColorKeys = this.stats.initialGridColorKeys;
    this.renderStats();
    this.redraw();
    wx.showToast({ title: `已移除 ${res.removed} 格背景`, icon: 'none' });
  },

  onUndoBackground() {
    if (!this.bgSnapshot) {
      wx.showToast({ title: '没有可撤销的操作', icon: 'none' });
      return;
    }
    this.grid = this.bgSnapshot.grid;
    this.initialGridColorKeys = this.bgSnapshot.initialGridColorKeys;
    this.stats = computeStats(this.grid, this.dims);
    this.bgSnapshot = null;
    this.renderStats();
    this.redraw();
  },

  // ---------- 排除颜色 ----------

  onToggleColor(e) {
    const hex = e.currentTarget.dataset.hex;
    if (!this.grid) return;

    if (this.excludedColorKeys.has(hex)) {
      // 恢复：从排除集合移除后整图重算（与网页版行为一致）
      this.excludedColorKeys.delete(hex);
      this.generate();
      return;
    }

    const res = excludeColor(this.grid, this.dims, {
      hexKey: hex,
      initialGridColorKeys: this.initialGridColorKeys,
      excludedColorKeys: this.excludedColorKeys,
      fullPalette: paletteUtil.buildFullPalette(),
    });

    if (!res.ok) {
      wx.showToast({ title: res.reason, icon: 'none' });
      return;
    }

    this.grid = res.data;
    this.excludedColorKeys.add(hex);
    this.stats = computeStats(this.grid, this.dims);
    this.renderStats();
    this.redraw();
    wx.showToast({ title: `已排除，重映射 ${res.remappedCount} 格`, icon: 'none' });
  },

  // ---------- 导出 ----------

  async onExport() {
    if (!this.grid) {
      wx.showToast({ title: '还没有生成图纸', icon: 'none' });
      return;
    }
    const settings = store.getSettings();
    const colorCount = Object.keys(this.stats.colorCounts).length;
    const plan = exportPattern.planExport(
      this.dims,
      settings.downloadOptions,
      constants.MAX_EXPORT_EDGE,
      colorCount
    );

    if (plan.tooSmall) {
      const modal = await new Promise((resolve) => {
        wx.showModal({
          title: '格子比较密',
          content: `图纸 ${this.dims.N}×${this.dims.M}，格内色号会比较小、不易辨认。建议降低格子数，或关闭「格内色号」。仍要导出吗？`,
          confirmText: '仍要导出',
          success: resolve,
          fail: () => resolve({ confirm: false }),
        });
      });
      if (!modal.confirm) return;
    }

    this.setData({ busy: true, busyText: '正在绘制图纸…', progressPercent: 100 });
    // 显示尺寸设成和输出一致（元素在屏幕外，不影响观感），
    // 避免「元素尺寸 ≠ backing store」在某些机型上出问题
    this.setData({ exportCssW: plan.w, exportCssH: plan.h });
    await new Promise((r) => setTimeout(r, 60));

    let filePath;
    try {
      const { canvas, ctx } = await canvasHelper.initExportCanvas('#export', this, plan.w, plan.h);
      exportPattern.drawPattern(ctx, {
        grid: this.grid,
        dims: this.dims,
        options: settings.downloadOptions,
        colorSystem: settings.colorSystem,
        colorCounts: this.stats.colorCounts,
        totalBeadCount: this.stats.totalBeadCount,
        plan,
      });
      filePath = await canvasHelper.exportCanvasToFile(canvas, plan.w, plan.h, this);
      this.setData({ busy: false });
    } catch (e) {
      console.error(e);
      this.setData({ busy: false });
      wx.showToast({ title: e.message || '导出失败', icon: 'none' });
      return;
    }

    // 先让用户选做什么，再执行 —— 之前在 previewImage 之后再弹 actionSheet，
    // 两个弹层会打架
    const action = await new Promise((resolve) => {
      wx.showActionSheet({
        itemList: ['保存到相册', '预览大图', '分享给好友'],
        success: (r) => resolve(r.tapIndex),
        fail: () => resolve(-1),
      });
    });

    if (action === 0) {
      await canvasHelper.saveToAlbum(filePath);
    } else if (action === 1) {
      wx.previewImage({ urls: [filePath] });
    } else if (action === 2) {
      if (wx.showShareImageMenu) {
        wx.showShareImageMenu({ path: filePath });
      } else {
        wx.showToast({ title: '当前微信版本不支持分享图片', icon: 'none' });
      }
    }
  },
});
