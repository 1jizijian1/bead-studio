const projectStore = require('../../utils/projectStore');
const codec = require('../../utils/projectCodec');
const canvasHelper = require('../../utils/canvasHelper');
const gridImage = require('../../utils/gridImage');
const cardImage = require('../../utils/cardImage');

const BLANK_COLOR = '#FFFFFF';

/** 卡片里那张图纸缩略图，每格渲染多少像素 */
const THUMB_CELL_PX = 8;

Page({
  data: {
    ready: false,
    rendering: false,
    name: '',
    statsText: '',
    cardSrc: '',
    hasPhoto: false,
    /** 隐藏画布的 CSS 尺寸 */
    tw: 1,
    th: 1,
  },

  onLoad(options) {
    this.projectId = options && options.id;
  },

  async onReady() {
    if (!this.projectId) return this.bail('没有指定项目');
    const p = projectStore.loadProject(this.projectId);
    if (!p) return this.bail('项目不存在或已损坏');

    this.p = p;
    this.dims = p.dims;
    this.cells = p.cells;
    this.hexes = p.hexes;

    const stats = codec.countProgressFromCells(this.hexes, this.cells, p.bitmap);
    this.beadTotal = stats.beadTotal;
    this.colorCount = this.hexes.length;

    // 之前打卡过就有照片路径（存在索引的 meta.cover 里）
    const meta = projectStore.getProjectMeta(this.projectId) || {};
    this.coverPath = meta.cover || null;

    this.setData({
      ready: true,
      name: p.name,
      statsText: `${p.dims.N}×${p.dims.M} · ${this.beadTotal} 颗 · ${this.colorCount} 色`,
      hasPhoto: !!this.coverPath,
    });

    await this.render();
  },

  bail(msg) {
    wx.showToast({ title: msg, icon: 'none' });
    setTimeout(() => wx.navigateBack(), 900);
  },

  // ---------- 出图 ----------

  /** 把图纸渲染成一张缩略图（用来放进打卡卡片） */
  async renderPatternThumb() {
    const cellPx = THUMB_CELL_PX;
    const w = this.dims.N * cellPx;
    const h = this.dims.M * cellPx;
    if (w !== this.data.tw || h !== this.data.th) {
      await new Promise((r) => this.setData({ tw: w, th: h }, r));
    }
    const info = await canvasHelper.selectNode('#thumb', this);
    if (!info || !info.node) throw new Error('拿不到缩略图画布');

    const cells = this.cells;
    const hexes = this.hexes;
    const N = this.dims.N;
    const EXT = codec.EXTERNAL_INDEX;

    // 打卡图要展示**完整图纸**，所以不套用进度页的单色模式
    return gridImage.renderToImage(info.node, {
      dims: this.dims,
      cellPx,
      getColor: (i, j) => {
        const idx = cells[j * N + i];
        return idx === EXT ? BLANK_COLOR : hexes[idx];
      },
    });
  },

  async render() {
    if (!this.p || this._rendering) return;
    this._rendering = true;
    this.setData({ rendering: true });

    try {
      const patternPath = await this.renderPatternThumb();

      const info = await canvasHelper.selectNode('#card', this);
      if (!info || !info.node) throw new Error('拿不到卡片画布');
      const canvas = info.node;

      // 照片和图纸都按 Image 加载（canvas.createImage，小程序没有全局 Image）
      let photoImg = null;
      if (this.coverPath) {
        try {
          photoImg = await canvasHelper.loadImage(canvas, this.coverPath);
        } catch (e) {
          console.warn('照片加载失败，卡片将不显示照片', e);
        }
      }
      let patternImg = null;
      try {
        patternImg = await canvasHelper.loadImage(canvas, patternPath);
      } catch (e) {
        console.warn('图纸缩略图加载失败', e);
      }

      const d = new Date();
      const cardSrc = await cardImage.renderCheckinCard(canvas, {
        name: this.p.name,
        dims: this.dims,
        beadTotal: this.beadTotal,
        colorCount: this.colorCount,
        dateText: `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`,
        photoImg,
        patternImg,
      });

      this.setData({ cardSrc, rendering: false, hasPhoto: !!photoImg });
    } catch (e) {
      console.error('打卡图生成失败', e);
      this.setData({ rendering: false });
      wx.showToast({ title: (e && e.message) || '打卡图生成失败', icon: 'none' });
    } finally {
      this._rendering = false;
    }
  },

  // ---------- 交互 ----------

  onPickPhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      sizeType: ['compressed'],
      camera: 'back',
      success: async (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        wx.showLoading({ title: '保存照片…', mask: true });
        try {
          // 临时路径重启就失效，必须拷进 USER_DATA_PATH
          this.coverPath = await projectStore.saveCover(this.projectId, file.tempFilePath);
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: (e && e.message) || '照片保存失败', icon: 'none' });
          return;
        }
        wx.hideLoading();
        this.setData({ hasPhoto: true });
        this.render();
      },
      fail: (err) => {
        if (err && err.errMsg && err.errMsg.indexOf('cancel') !== -1) return;
        wx.showToast({ title: '选择照片失败', icon: 'none' });
      },
    });
  },

  onPreviewCard() {
    if (!this.data.cardSrc) return;
    wx.previewImage({ urls: [this.data.cardSrc] });
  },

  async onSaveCard() {
    if (!this.data.cardSrc) {
      wx.showToast({ title: '还没有打卡图', icon: 'none' });
      return;
    }
    await canvasHelper.saveToAlbum(this.data.cardSrc);
  },

  onShareCard() {
    if (!this.data.cardSrc) {
      wx.showToast({ title: '还没有打卡图', icon: 'none' });
      return;
    }
    if (wx.showShareImageMenu) {
      wx.showShareImageMenu({ path: this.data.cardSrc });
    } else {
      wx.previewImage({ urls: [this.data.cardSrc] });
      wx.showToast({ title: '长按图片可转发给好友', icon: 'none', duration: 2000 });
    }
  },

  onBack() {
    wx.navigateBack();
  },
});
