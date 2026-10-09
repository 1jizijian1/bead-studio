/**
 * 全局常量与默认参数。单点定义，别在页面里散落魔法数字。
 *
 * 默认值对齐网页版实测行为：上传新图后 granularity 重置为 100、
 * similarityThreshold 30、模式 dominant、色号体系 MARD。
 */

module.exports = {
  /** 横轴切割数量（格子数）范围与默认值 */
  GRANULARITY_MIN: 10,
  GRANULARITY_MAX: 300,
  DEFAULT_GRANULARITY: 100,

  /** 颜色合并相似度阈值（与 Oklab 距离×100 直接比较） */
  THRESHOLD_MIN: 0,
  THRESHOLD_MAX: 100,
  DEFAULT_THRESHOLD: 30,

  MODES: [
    { value: 'dominant', label: '卡通', desc: '取色块主导色，边缘干净' },
    { value: 'average', label: '真实', desc: '取区域内均值，保留渐变' },
  ],
  DEFAULT_MODE: 'dominant',

  DEFAULT_COLOR_SYSTEM: 'MARD',

  /** 导出图纸选项 */
  DEFAULT_DOWNLOAD_OPTIONS: {
    showGrid: true,
    gridInterval: 10,
    showCoordinates: true,
    showCellNumbers: true,
    gridLineColor: '#555555',
    includeStats: true,
    /** 网页版的水印/二维码/小红书标识：小程序版默认关掉 */
    branding: false,
  },

  GRID_INTERVAL_MIN: 5,
  GRID_INTERVAL_MAX: 20,

  GRID_LINE_COLORS: [
    { name: '深灰', value: '#555555' },
    { name: '红', value: '#FF0000' },
    { name: '蓝', value: '#0000FF' },
    { name: '绿', value: '#008000' },
    { name: '紫', value: '#800080' },
    { name: '橙', value: '#FFA500' },
  ],

  /** 采样时原图长边上限：4000x3000 原图 getImageData 要 48MB，低端机会闪退 */
  MAX_IMAGE_EDGE: 1600,

  /** 导出画布单边上限：iOS 常见 GL 纹理上限 4096，留足余量 */
  MAX_EXPORT_EDGE: 3000,

  /** 网页版固定 30px/格 */
  EXPORT_CELL_SIZE: 30,
  /** 格子过小时的下限，低于它就提示用户 */
  EXPORT_CELL_SIZE_MIN: 6,

  TRANSPARENT_KEY: 'ERASE',
  /** 预览里外部背景格的填充色（对齐网页版 PixelatedPreviewCanvas） */
  EXTERNAL_CELL_COLOR: '#F3F4F6',
};
