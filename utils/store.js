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
const size = require('./size');

const SETTINGS_KEY = 'beadSettings';

/**
 * 设置结构版本。改了默认值语义就要 +1，让老用户的旧值被丢弃、重新取默认。
 *
 * v2：颜色合并阈值默认值从 30 改成 8（30 会把照片合并成一团近黑，见 constants.js 的说明）。
 *     老用户存过 30，不迁移的话改了默认也没用。
 * v3：默认格子数从 100 改成 300（100 档照片细节丢太多）。
 * v4：参数从「横轴格子数」改成「成品宽度(cm) + 豆距(mm)」——
 *     拼豆的人想的是成品多大，不是横轴多少格。granularity 变成派生量，不再存。
 */
const SETTINGS_VERSION = 4;

const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  colorSystem: constants.DEFAULT_COLOR_SYSTEM,
  /** 成品宽度（厘米） */
  widthCm: size.DEFAULT_WIDTH_CM,
  /** 豆距（毫米）：5 标准豆 / 2.6 迷你豆 */
  beadPitch: size.DEFAULT_BEAD_PITCH,
  threshold: constants.DEFAULT_THRESHOLD,
  minRegion: constants.DEFAULT_MIN_REGION,
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

  if (saved && saved.version !== SETTINGS_VERSION) {
    // 参数默认值变过：只保留与语义无关的用户选择（色号体系、自定义色板、导出选项）
    saved = {
      paletteSelections: saved.paletteSelections,
      colorSystem: saved.colorSystem,
      downloadOptions: saved.downloadOptions,
    };
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
