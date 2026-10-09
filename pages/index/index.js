const store = require('../../utils/store');
const projectStore = require('../../utils/projectStore');

const app = getApp();

Page({
  data: {
    colorSystem: 'MARD',
    paletteSummary: '',
    hasProjects: false,
    projectCount: 0,
    topPercent: 0,
  },

  onShow() {
    const settings = store.getSettings();
    const projects = projectStore.listProjects();
    const top = projects[0];
    this.setData({
      colorSystem: settings.colorSystem,
      paletteSummary: this.buildPaletteSummary(settings),
      hasProjects: projects.length > 0,
      projectCount: projects.length,
      topPercent: top && top.total ? Math.round((top.done / top.total) * 100) : 0,
    });
  },

  onOpenProjects() {
    wx.navigateTo({ url: '/pages/projects/index' });
  },

  buildPaletteSummary(settings) {
    const sel = settings.paletteSelections;
    if (!sel) return '';
    const total = Object.keys(sel).length;
    const picked = Object.keys(sel).filter((k) => sel[k]).length;
    if (picked === total) return '';
    return `当前已选 ${picked}/${total} 色`;
  },

  onPickImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'], // 原图可能 20MB+，压缩版做颜色识别足够且省内存
      camera: 'back',
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        const path = file.tempFilePath;
        wx.getImageInfo({
          src: path,
          success: (info) => {
            store.setPickedImage({
              path,
              width: info.width,
              height: info.height,
            });
            // 换了新图，旧结果作废
            app.globalData.result = null;
            wx.navigateTo({
              url: '/pages/editor/index?src=' + encodeURIComponent(path),
            });
          },
          fail: () => {
            wx.showToast({ title: '图片读取失败，请换一张', icon: 'none' });
          },
        });
      },
      fail: (err) => {
        // 用户主动取消不报错
        if (err && err.errMsg && err.errMsg.indexOf('cancel') !== -1) return;
        wx.showToast({ title: '选择图片失败', icon: 'none' });
      },
    });
  },

  onOpenPalette() {
    wx.navigateTo({ url: '/pages/palette/index' });
  },

});
