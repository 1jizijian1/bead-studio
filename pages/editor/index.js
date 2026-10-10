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
const size = require('../../utils/size');
const gridImage = require('../../utils/gridImage');
const exportPattern = require('../../utils/exportPattern');
const projectStore = require('../../utils/projectStore');
const codec = require('../../utils/projectCodec');

const app = getApp();

Page({
  data: {
    boxH: 360,
    imgW: 300,
    imgH: 300,
    previewSrc: '',
    /** 隐藏渲染画布的 CSS 尺寸（要和 backing store 一致） */
    rw: 1,
    rh: 1,
    dims: { N: 0, M: 0 },
    colorList: [],
    totalBeadCount: 0,

    widthCm: size.DEFAULT_WIDTH_CM,
    widthMin: size.WIDTH_MIN_CM,
    widthMax: size.WIDTH_MAX_CM,
    beadPitch: size.DEFAULT_BEAD_PITCH,
    pitches: size.BEAD_PITCHES,
    sizeText: '',
    boardText: '',
    gridText: '',
    tooBig: false,

    threshold: constants.DEFAULT_THRESHOLD,
    thresholdMin: constants.THRESHOLD_MIN,
    thresholdMax: constants.THRESHOLD_MAX,

    minRegion: constants.DEFAULT_MIN_REGION,
    minRegionMin: constants.MIN_REGION_MIN,
    minRegionMax: constants.MIN_REGION_MAX,
    speckleText: '',

    zoom: 1,
    zoomSteps: gridImage.ZOOM_STEPS,

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

    // 图片宽高比：把「横轴格子数」换算成「纵向格子数」，用于尺寸预估
    this.aspect = picked && picked.width ? picked.height / picked.width : 1;

    this.grid = null;
    this.dims = null;
    this.mapper = null;
    this.stats = null;
    this.excludedColorKeys = new Set();
    this.initialGridColorKeys = new Set();
    this.bgSnapshot = null;
    this.sample = null;
    // 本次编辑会话对应的项目 id。
    // ⚠️ 调参 / 去背景 / 排除色**都不清空它** —— 由 cellsHash 决定是「复用」还是
    // 「覆盖并重置进度」。这样反复拖滑块再进拼豆模式不会攒出一堆孤儿项目。
    this.currentProjectId = null;

    this.touch = null;

    const mode = constants.MODES.find((m) => m.value === settings.mode) || constants.MODES[0];
    this.setData({
      widthCm: settings.widthCm,
      widthMax: this.maxWidthForPitch(settings.beadPitch),
      beadPitch: settings.beadPitch,
      threshold: settings.threshold,
      minRegion: settings.minRegion,
      speckleText: this.speckleLabel(settings.minRegion),
      mode: settings.mode,
      modeDesc: mode.desc,
      colorSystem: settings.colorSystem,
    });
    this.updateSizeReadout();

    if (!this.src) {
      wx.showToast({ title: '没有可用的图片', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
    }
  },

  async onReady() {
    if (!this.src) return;
    const info = canvasHelper.getWindowInfo();
    this.boxW = info.windowWidth - 24;
    this.boxH = Math.max(240, Math.round(info.windowHeight * 0.42));
    this.setData({ boxH: this.boxH });
    await this.generate();
  },

  // ---------- 尺寸换算 ----------

  /** 豆距越大，同样格数成品越大；滑块上限要跟着豆距走，否则会顶到格子数上限 */
  maxWidthForPitch(pitchMm) {
    return Math.min(
      size.WIDTH_MAX_CM,
      Math.round((constants.GRANULARITY_MAX * pitchMm) / 10)
    );
  },

  /** 「成品宽度 + 豆距」-> 网格尺寸 */
  computeDims(widthCm, pitchMm) {
    const N = Math.max(
      constants.GRANULARITY_MIN,
      Math.min(constants.GRANULARITY_MAX, size.columnsForWidth(widthCm, pitchMm))
    );
    const M = Math.max(1, Math.round(N * this.aspect));
    return { N, M };
  },

  /** 刷新「30×17 cm · 6 块板」这行实时读数 */
  updateSizeReadout(widthCm, pitchMm, dims) {
    const w = widthCm === undefined ? this.data.widthCm : widthCm;
    const p = pitchMm === undefined ? this.data.beadPitch : pitchMm;
    const d = dims || this.computeDims(w, p);
    const info = size.describeSize(d, p);
    this.setData({
      sizeText: info.sizeText,
      boardText: info.boardText,
      gridText: info.gridText,
      tooBig: info.tooBig,
    });
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
      // 格子数由「成品宽度 + 豆距」派生，不再是用户直接调的参数
      const planned = this.computeDims(settings.widthCm, settings.beadPitch);
      const N = planned.N;
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
      this.renderPreview();
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
    // 尺寸读数用真实网格尺寸（不是预估），排除色/去背景后总数变了也要跟着更新
    this.updateSizeReadout(undefined, undefined, this.dims);
  },

  // ---------- 绘制 ----------

  // ---------- 预览出图 ----------

  /**
   * 预览渲染成图片显示（不用 canvas 直接显示 —— 
   * 本项目环境里 <canvas type="2d"> 内容画上去了但屏幕不显示，两个页面都中招）。
   * 见 utils/gridImage.js 顶部的说明。
   */
  async renderPreview() {
    if (!this.grid || this._rendering) return;
    this._rendering = true;
    try {
      const cellPx = this.previewCellPx();
      const w = Math.max(1, Math.round(this.dims.N * cellPx));
      const h = Math.max(1, Math.round(this.dims.M * cellPx));

      // 先给隐藏画布定 CSS 尺寸（要和 backing store 一致），再取节点
      if (w !== this.data.rw || h !== this.data.rh) {
        await new Promise((r) => this.setData({ rw: w, rh: h }, r));
      }
      const info = await canvasHelper.selectNode("#render", this);
      if (!info || !info.node) throw new Error("拿不到渲染画布节点");

      const grid = this.grid;
      const src = await gridImage.renderToImage(info.node, {
        dims: this.dims,
        cellPx,
        getColor: (i, j) => {
          const cell = grid[j][i];
          return cell.isExternal ? constants.EXTERNAL_CELL_COLOR : cell.color;
        },
      });
      this.setData({ previewSrc: src, imgW: w, imgH: h });
    } catch (e) {
      console.error("预览出图失败", e);
      wx.showToast({ title: (e && e.message) || "预览出图失败", icon: "none" });
    } finally {
      this._rendering = false;
    }
  },

  /** 每格渲染多少像素：让整张图在 zoom=1 时完整放进框里 */
  previewCellPx() {
    const boxW = this.boxW || 340;
    const boxH = this.boxH || 360;
    const base = Math.max(2, Math.floor(Math.min(boxW / this.dims.N, boxH / this.dims.M)));
    return base * this.data.zoom;
  },

  // ---------- 手势 ----------

  onTouchStart(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (!t) return;
    this.touch = { x: t.clientX, y: t.clientY };
  },

  async onTouchEnd(e) {
    const start = this.touch;
    this.touch = null;
    if (!start || !this.grid) return;
    const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
    if (!t) return;
    // 移动过就是在滚动，不算点击
    if (Math.abs(t.clientX - start.x) > 8 || Math.abs(t.clientY - start.y) > 8) return;

    const rect = await gridImage.queryRect(".preview-img", this);
    const hit = gridImage.hitTest(t.clientX, t.clientY, rect, this.dims);
    if (!hit.inside) return;
    const cell = this.grid[hit.j][hit.i];
    const settings = store.getSettings();
    this.setData({
      tip: {
        color: cell.color,
        key: cell.isExternal ? "空白" : paletteUtil.getDisplayColorKey(cell.color, settings.colorSystem),
        isExternal: !!cell.isExternal,
      },
    });
  },

  onZoomChange(e) {
    const zoom = Number(e.currentTarget.dataset.zoom);
    if (!zoom || zoom === this.data.zoom) return;
    this.setData({ zoom }, () => this.renderPreview());
  },

  onCloseTip() {
    this.setData({ tip: null });
  },

  // ---------- 参数 ----------

  onWidthChanging(e) {
    const widthCm = e.detail.value;
    this.setData({ widthCm }); // 拖动中只更新读数和预览尺寸，不重算
    this.updateSizeReadout(widthCm);
  },

  onWidthChange(e) {
    const widthCm = e.detail.value;
    this.setData({ widthCm });
    store.updateSettings({ widthCm });
    this.generate();
  },

  onPitchChange(e) {
    const beadPitch = parseFloat(e.currentTarget.dataset.pitch);
    if (beadPitch === this.data.beadPitch) return;
    // 换豆距会改变格子数与滑块上限，把宽度夹到新上限内
    const widthMax = this.maxWidthForPitch(beadPitch);
    const widthCm = Math.min(this.data.widthCm, widthMax);
    this.setData({ beadPitch, widthMax, widthCm });
    store.updateSettings({ beadPitch, widthCm });
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
    this.renderPreview();
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
    this.renderPreview();
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
    this.renderPreview();
    wx.showToast({ title: `已排除，重映射 ${res.remappedCount} 格`, icon: 'none' });
  },

  // ---------- 拼豆进度 ----------

  /**
   * 进入拼豆进度模式。
   *
   * 项目是**生成那一刻的快照**：之后在编辑器里改参数不影响已经建好的项目。
   * 同一个会话里改完再进来，靠 cellsHash 判断「复用旧项目」还是「覆盖重置进度」，
   * 避免拖几次滑块就攒出一堆孤儿项目。
   */
  async onStartProgress() {
    if (!this.grid || this.busy) return;
    const settings = store.getSettings();
    const packed = codec.packGrid(this.grid, this.dims);
    const hash = codec.hashGrid(packed.hexes, packed.cells);

    let id = this.currentProjectId;

    if (id && !projectStore.getProjectMeta(id)) {
      id = null; // 项目被删掉了，当新的建
      this.currentProjectId = null;
    }

    if (id) {
      if (projectStore.getCellsHash(id) !== hash) {
        const meta = projectStore.getProjectMeta(id);
        if (meta && meta.done > 0) {
          const ok = await new Promise((resolve) => {
            wx.showModal({
              title: '图纸改动了',
              content: '这张图纸的拼豆进度会被重置，图纸本身也会换成现在这版。继续吗？',
              confirmText: '继续',
              success: (m) => resolve(m.confirm),
              fail: () => resolve(false),
            });
          });
          if (!ok) return;
        }
        const res = projectStore.overwrite(id, {
          grid: this.grid,
          dims: this.dims,
          colorSystem: settings.colorSystem,
          settings,
        });
        if (!res.ok) return this.warnSave(res.reason);
      }
    } else {
      const now = new Date();
      const res = projectStore.createFromGrid({
        grid: this.grid,
        dims: this.dims,
        colorSystem: settings.colorSystem,
        settings,
        name: `${this.dims.N}×${this.dims.M} · ${now.getMonth() + 1}月${now.getDate()}日`,
        thumb: codec.makeThumb(this.grid, this.dims, 32, 18),
      });
      if (!res.ok) return this.warnSave(res.reason);
      id = res.id;
      this.currentProjectId = id;
    }

    wx.navigateTo({ url: `/pages/craft/index?id=${id}` });
  },

  warnSave(reason) {
    const texts = {
      too_many: ['项目太多了', '最多存 12 个拼豆项目。先删掉几个不再拼的，再开新的。', '去管理'],
      too_big: ['图纸太大', '这张图纸的进度存不下。把成品宽度调小一些再试。', '知道了'],
      quota: ['存储空间不足', '进度没能保存。可以删掉不再拼的项目腾出空间。', '去管理'],
    };
    const t = texts[reason] || texts.quota;
    wx.showModal({
      title: t[0],
      content: t[1],
      confirmText: t[2],
      success: (m) => {
        if (m.confirm && reason !== 'too_big') {
          wx.navigateTo({ url: '/pages/projects/index' });
        }
      },
    });
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
    } else if (plan.cellNumbersDropped) {
      // 格子太密，格内色号画不下会自动省略 —— 提示一下，别让人以为导出坏了
      const modal = await new Promise((resolve) => {
        wx.showModal({
          title: '格内色号已省略',
          content: `图纸 ${this.dims.N}×${this.dims.M} 格子太密，每格只有 ${plan.cell}px，色号写不下会被省略。想带着色号导出的话，把格子数降到 200 以内。仍要导出吗？`,
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
