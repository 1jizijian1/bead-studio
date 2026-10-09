/**
 * 成品尺寸换算。
 *
 * 拼豆的人心里想的是「我要拼多大 / 用几块板」，不是「横轴多少格」。
 * 这一层负责把格子数翻译成物理尺寸和拼豆板数量，反过来也支持按尺寸定格子数。
 *
 * 豆距（相邻两颗豆中心距）= 豆子直径：
 *   5mm   —— 标准豆（midi，最常见）
 *   2.6mm —— 迷你豆（mini，成品只有一半大小）
 * 一块标准拼豆板是 29×29 个钉。
 */
const BEAD_PITCHES = [
  { value: 5, label: '5mm', desc: '标准豆，最常见' },
  { value: 2.6, label: '2.6mm', desc: '迷你豆，成品约一半大' },
];

const DEFAULT_BEAD_PITCH = 5;

/** 一块标准拼豆板的边长（钉数） */
const BOARD_SIZE = 29;

/** 成品宽度范围（厘米）。下限约等于 10 格，上限约等于 300 格（5mm 豆） */
const WIDTH_MIN_CM = 5;
const WIDTH_MAX_CM = 150;
const DEFAULT_WIDTH_CM = 30;

/** 超过这么多块板就提醒一下：这是个大工程 */
const BOARD_WARN_COUNT = 20;

/** 成品宽度(cm) + 豆距(mm) -> 横轴格子数 N */
function columnsForWidth(widthCm, pitchMm) {
  const pitchCm = pitchMm / 10;
  return Math.max(1, Math.round(widthCm / pitchCm));
}

/** 横轴格子数 N + 豆距(mm) -> 成品宽度(cm) */
function widthForColumns(N, pitchMm) {
  return (N * pitchMm) / 10;
}

/**
 * 描述成品。
 * @param {{N:number,M:number}} dims 网格尺寸
 * @param {number} pitchMm 豆距（毫米）
 */
function describeSize(dims, pitchMm) {
  const N = dims.N;
  const M = dims.M;
  const pitchCm = pitchMm / 10;

  const widthCm = N * pitchCm;
  const heightCm = M * pitchCm;
  const boardsW = Math.max(1, Math.ceil(N / BOARD_SIZE));
  const boardsH = Math.max(1, Math.ceil(M / BOARD_SIZE));
  const boardCount = boardsW * boardsH;

  return {
    widthCm,
    heightCm,
    boardsW,
    boardsH,
    boardCount,
    /** 是否大得不像手工项目 */
    tooBig: boardCount > BOARD_WARN_COUNT,
    gridText: `${N} × ${M} 格`,
    sizeText: `${widthCm.toFixed(1)} × ${heightCm.toFixed(1)} cm`,
    boardText: `${boardCount} 块板`,
    pitchText: BEAD_PITCHES.filter((p) => p.value === pitchMm).map((p) => p.label)[0] || '',
  };
}

module.exports = {
  BEAD_PITCHES,
  DEFAULT_BEAD_PITCH,
  BOARD_SIZE,
  BOARD_WARN_COUNT,
  WIDTH_MIN_CM,
  WIDTH_MAX_CM,
  DEFAULT_WIDTH_CM,
  columnsForWidth,
  widthForColumns,
  describeSize,
};
