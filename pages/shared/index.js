/**
 * 好友分享过来的图纸。
 * 从云数据库读 → 渲染预览 → 一键存进「我的拼豆」→ 就能自己拼了。
 */
const codec = require('../../utils/projectCodec');
const canvasHelper = require('../../utils/canvasHelper');
const gridImage = require('../../utils/gridImage');
const projectStore = require('../../utils/projectStore');
const cloud = require('../../utils/cloud');

const PREVIEW_CELL_PX = 6;

Page({
  data: {
    loading: true,
    error: '',
    name: '',
    statsText: '',
    previewSrc: '',
    saving: false,
    saved: false,
    savedId: '',
    /** 隐藏画布的 CSS 尺寸 */
    pw: 1,
    ph: 1,
  },

  onLoad(options) {
    this.shareId = options && options.id;
  },

  onReady() {
    this.load();
  },

  async load() {
    if (!this.shareId) return this.fail('分享链接不完整');

    if (!cloud.isReady()) {
      return this.fail('这个小程序还没开通云开发，暂时看不了分享的图纸');
    }

    const res = await cloud.fetchPattern(this.shareId);
    if (!res.ok) {
      return this.fail(
        res.reason === 'fetch_failed'
          ? '读取失败，可能是网络问题，稍后再试'
          : '图纸不存在或已被删除'
      );
    }

    const doc = res.data;
    if (!doc || !doc.dims || !doc.hexes || !doc.cells) return this.fail('图纸数据不完整');

    this.doc = doc;
    this.dims = doc.dims;
    try {
      this.cells = codec.unpackCells(doc.cells, doc.dims.N * doc.dims.M);
    } catch (e) {
      return this.fail('图纸数据损坏');
    }
    if (this.cells.length !== doc.dims.N * doc.dims.M) return this.fail('图纸数据不完整');

    this.setData({
      loading: false,
      name: doc.name || '拼豆图纸',
      statsText: `${doc.dims.N}×${doc.dims.M} · ${doc.beadTotal || '?'} 颗 · ${
        (doc.hexes || []).length
      } 色`,
    });

    await this.renderPreview();
  },

  fail(msg) {
    this.setData({ loading: false, error: msg });
  },

  async renderPreview() {
    const cellPx = PREVIEW_CELL_PX;
    const w = this.dims.N * cellPx;
    const h = this.dims.M * cellPx;
    await new Promise((r) => this.setData({ pw: w, ph: h }, r));

    try {
      const info = await canvasHelper.selectNode('#preview', this);
      if (!info || !info.node) throw new Error('拿不到渲染画布');

      const cells = this.cells;
      const hexes = this.doc.hexes;
      const N = this.dims.N;
      const EXT = codec.EXTERNAL_INDEX;

      const src = await gridImage.renderToImage(info.node, {
        dims: this.dims,
        cellPx,
        getColor: (i, j) => {
          const idx = cells[j * N + i];
          return idx === EXT ? '#FFFFFF' : hexes[idx];
        },
      });
      this.setData({ previewSrc: src });
    } catch (e) {
      console.error('预览出图失败', e);
    }
  },

  /** 存进「我的拼豆」——之后就能进进度页自己拼了 */
  onSave() {
    if (this.data.saving || this.data.saved) return;
    this.setData({ saving: true });

    try {
      const grid = codec.unpackGrid(this.dims, this.doc.hexes, this.cells);
      const res = projectStore.createFromGrid({
        grid,
        dims: this.dims,
        colorSystem: this.doc.colorSystem || 'MARD',
        name: this.doc.name || '分享的图纸',
        thumb: codec.makeThumb(grid, this.dims, 32, 18),
      });

      if (!res.ok) {
        this.setData({ saving: false });
        const msg =
          res.reason === 'too_many'
            ? '你的拼豆项目已经满了（12 个），先删掉几个再保存'
            : res.reason === 'too_big'
            ? '这张图纸太大，本地存不下'
            : '保存失败，可能是存储空间不足';
        wx.showModal({ title: '保存不了', content: msg, showCancel: false });
        return;
      }

      this.setData({ saving: false, saved: true, savedId: res.id });
      wx.showToast({ title: '已存进我的拼豆', icon: 'success' });

      setTimeout(() => {
        wx.redirectTo({ url: `/pages/craft/index?id=${res.id}` });
      }, 800);
    } catch (e) {
      console.error('保存分享图纸失败', e);
      this.setData({ saving: false });
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/index/index' }) });
  },
});
