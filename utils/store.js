/**
 * 状态存取。
 *
 * 分三层，别混用：
 *   1. 大对象（网格数据、统计）-> getApp().globalData.result，**绝不过 setData/storage**
 *      9 万格的网格序列化后好几 MB，setData 单次上限 1MB、storage 单 key 上限 1MB，必爆。
 *   2. 用户偏好（色号体系/参数/导出选项）-> globalData + wx.setStorageSync
 *   3. 页面间小参数 -> URL query（调用方自己 encodeURIComponent）
 */
const constants = require('./constants');

const SETTINGS_KEY = 'beadSettings';

const DEFAULT_SETTINGS = {
  colorSystem: constants.DEFAULT_COLOR_SYSTEM,
  granularity: constants.DEFAULT_GRANULARITY,
  threshold: constants.DEFAULT_THRESHOLD,
  mode: constants.DEFAULT_MODE,
  /** hex -> boolean，自定义色板勾选；缺省表示全选 */
  paletteSelections: null,
  downloadOptions: Object.assign({}, constants.DEFAULT_DOWNLOAD_OPTIONS),
};

function loadSettings() {
  let saved = null;
  try {
    saved = wx.getStorageSync(SETTINGS_KEY);
  } catch (e) {
    console.warn('读取设置失败', e);
  }
  const merged = Object.assign({}, DEFAULT_SETTINGS, saved || {});
  merged.downloadOptions = Object.assign(
    {},
    constants.DEFAULT_DOWNLOAD_OPTIONS,
    (saved && saved.downloadOptions) || {}
  );
  return merged;
}

function saveSettings(settings) {
  try {
    wx.setStorageSync(SETTINGS_KEY, settings);
  } catch (e) {
    console.warn('保存设置失败', e);
  }
  const app = getApp();
  if (app) app.globalData.settings = settings;
}

/** 页面里取设置：优先 globalData，退回 storage，再退回默认 */
function getSettings() {
  const app = getApp();
  if (app && app.globalData.settings) return app.globalData.settings;
  const s = loadSettings();
  if (app) app.globalData.settings = s;
  return s;
}

/** 更新设置的一部分并落盘 */
function updateSettings(patch) {
  const next = Object.assign({}, getSettings(), patch);
  if (patch && patch.downloadOptions) {
    next.downloadOptions = Object.assign({}, getSettings().downloadOptions, patch.downloadOptions);
  }
  saveSettings(next);
  return next;
}

function setResult(result) {
  getApp().globalData.result = result;
}

function getResult() {
  return getApp().globalData.result;
}

function setPickedImage(img) {
  getApp().globalData.pickedImage = img;
}

function getPickedImage() {
  return getApp().globalData.pickedImage;
}

module.exports = {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  getSettings,
  updateSettings,
  setResult,
  getResult,
  setPickedImage,
  getPickedImage,
};
