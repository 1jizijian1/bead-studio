const store = require('../../utils/store');
const paletteUtil = require('../../utils/palette');

Page({
  data: {
    colorSystem: 'MARD',
    colorSystems: paletteUtil.COLOR_SYSTEMS,
    colors: [],
    selectedCount: 0,
    total: 0,
  },

  onLoad() {
    const settings = store.getSettings();
    const full = paletteUtil.buildFullPalette();
    const sel = settings.paletteSelections;

    // 没有保存过勾选就默认全选
    this.selections = {};
    const colors = full.map((c) => {
      const hex = c.hex.toUpperCase();
      const selected = sel ? sel[hex] !== false : true;
      this.selections[hex] = selected;
      return {
        hex,
        key: paletteUtil.getDisplayColorKey(hex, settings.colorSystem),
        selected,
      };
    });

    this.setData({
      colorSystem: settings.colorSystem,
      colors,
      total: colors.length,
      selectedCount: colors.filter((c) => c.selected).length,
    });
  },

  onColorSystemChange(e) {
    const colorSystem = e.currentTarget.dataset.system;
    if (colorSystem === this.data.colorSystem) return;
    // 只换显示色号，不动勾选
    const colors = this.data.colors.map((c) => ({
      hex: c.hex,
      key: paletteUtil.getDisplayColorKey(c.hex, colorSystem),
      selected: c.selected,
    }));
    this.setData({ colorSystem, colors });
  },

  onToggle(e) {
    const index = e.currentTarget.dataset.index;
    const colors = this.data.colors;
    const item = colors[index];
    const selected = !item.selected;
    this.selections[item.hex] = selected;

    // 只更新这一项，避免 291 项整体重渲染
    this.setData({
      [`colors[${index}].selected`]: selected,
      selectedCount: this.data.selectedCount + (selected ? 1 : -1),
    });
  },

  onSelectAll() {
    this.setAll(true);
  },

  onSelectNone() {
    this.setAll(false);
  },

  onInvert() {
    const colors = this.data.colors.map((c) => {
      const selected = !c.selected;
      this.selections[c.hex] = selected;
      return { hex: c.hex, key: c.key, selected };
    });
    this.setData({
      colors,
      selectedCount: colors.filter((c) => c.selected).length,
    });
  },

  setAll(value) {
    const colors = this.data.colors.map((c) => {
      this.selections[c.hex] = value;
      return { hex: c.hex, key: c.key, selected: value };
    });
    this.setData({
      colors,
      selectedCount: value ? colors.length : 0,
    });
  },

  onSave() {
    if (this.data.selectedCount === 0) {
      wx.showToast({ title: '至少保留一种颜色', icon: 'none' });
      return;
    }
    store.updateSettings({
      colorSystem: this.data.colorSystem,
      paletteSelections: Object.assign({}, this.selections),
    });
    wx.showToast({ title: '已保存', icon: 'success' });
    setTimeout(() => wx.navigateBack(), 500);
  },
});
