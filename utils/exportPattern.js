/**
 * 导出图纸绘制。移植自 perler-beads/src/utils/imageDownloader.ts 的 downloadImage。
 *
 * 与网页版的差异（刻意的）：
 *  - 网页版的品牌水印、官网二维码、@七卡瓦 / 小红书标识，默认关掉（options.branding）
 *  - 网页版「预估高度」和「实际绘制」用的常量不一致，这里统一由 computeLayout 出，
 *    避免最后再复制一次画布
 *
 * 关键约束：导出画布尺寸必须 clamp。N=100 时 30px/格已经 3000px 宽，
 * 加上坐标轴和清单区就破 4000，会**静默输出空白图**。
 */
const constants = require('./constants');
const { getDisplayColorKey, sortColorKeys } = require('./palette');
const { getContrastColor } = require('./canvasHelper');

const TITLE_BAR_HEIGHT = 80;
const AXIS_LABEL_SIZE = 30;
const STATS_PADDING = 20;
const STATS_FONT_SIZE = 13;
const SWATCH_SIZE = 18;
const STATS_ROW_HEIGHT = 26;
const STATS_TITLE_HEIGHT = 30;
const STATS_FOOTER_HEIGHT = 30;
const STATS_TOP_MARGIN = 24;

/**
 * 统一算排版。planExport 和 drawPattern 都用它，保证画布尺寸和实际绘制一致。
 * @param {{N:number,M:number}} dims
 * @param {object} options 导出选项
 * @param {number} cell 每格像素
 * @param {number} colorCount 颜色种数（决定清单行数）
 */
function computeLayout(dims, options, cell, colorCount, colsOverride) {
  const N = dims.N;
  const M = dims.M;
  const showCoords = !!options.showCoordinates;
  const showCellNumbers = !!options.showCellNumbers;
  const includeStats = !!options.includeStats;

  const axisLabelSize = showCoords ? AXIS_LABEL_SIZE : 0;
  const extraLR = showCoords ? Math.max(20, STATS_FONT_SIZE * 2) : 0;
  const extraTB = showCoords ? Math.max(15, STATS_FONT_SIZE) : 0;

  const gridWidth = N * cell;
  const gridHeight = M * cell;

  // 宽度不依赖清单高度，可以先定
  const w = gridWidth + axisLabelSize * 2 + extraLR * 2;

  let statsCols = 0;
  let statsRows = 0;
  let itemWidth = 0;
  let statsHeight = 0;
  if (includeStats) {
    // 调用方漏传 colorCount 时兜底成 1，否则清单区高度会算成 0，
    // 但 includeStats 仍是 true，绘制时就会把清单画到画布外面去
    const count = colorCount > 0 ? colorCount : 1;
    const availableStatsWidth = w - STATS_PADDING * 2;
    statsCols = colsOverride || Math.max(1, Math.min(4, Math.floor(availableStatsWidth / 250)));
    itemWidth = Math.floor(availableStatsWidth / statsCols);
    statsRows = Math.ceil(count / statsCols);
    statsHeight =
      STATS_TOP_MARGIN + STATS_TITLE_HEIGHT + statsRows * STATS_ROW_HEIGHT + STATS_FOOTER_HEIGHT + STATS_PADDING;
  }

  const h = TITLE_BAR_HEIGHT + gridHeight + axisLabelSize * 2 + extraTB * 2 + statsHeight;

  return {
    cell,
    w,
    h,
    N,
    M,
    axisLabelSize,
    gridWidth,
    gridHeight,
    titleBarHeight: TITLE_BAR_HEIGHT,
    extraLR,
    extraTB,
    statsHeight,
    statsCols,
    statsRows,
    itemWidth,
    showCoords,
    showCellNumbers,
    includeStats,
    /** 格内色号字号：随格子缩放，太小就不画 */
    cellFontSize: Math.max(6, Math.floor(cell * 0.4)),
    canDrawCellNumbers: showCellNumbers && cell >= 12,
    /** 用户开了格内色号，但格子太小画不下 —— 导出前要提示，别让人以为坏了 */
    cellNumbersDropped: showCellNumbers && cell < 12,
    gridInterval: options.gridInterval || 10,
    gridLineColor: options.gridLineColor || '#555555',
  };
}

/**
 * 规划导出尺寸，必要时缩小格子以适配上限。
 * @param {{N:number,M:number}} dims
 * @param {object} options
 * @param {number} maxEdge 单边上限
 * @param {number} colorCount 颜色种数
 */
function planExport(dims, options, maxEdge, colorCount) {
  let cell = constants.EXPORT_CELL_SIZE;
  let layout = computeLayout(dims, options, cell, colorCount);

  if (Math.max(layout.w, layout.h) > maxEdge) {
    // 逐步缩小格子直到塞得下
    for (cell = constants.EXPORT_CELL_SIZE - 1; cell >= 2; cell--) {
      layout = computeLayout(dims, options, cell, colorCount);
      if (Math.max(layout.w, layout.h) <= maxEdge) break;
    }
  }

  // 格子缩到最小仍然超高：颜色特别多时，清单区本身可能就有几百像素高。
  // 这时把清单列数逐级加宽来压高度（列数越多，行数越少）。
  if (options.includeStats && layout.h > maxEdge) {
    for (let cols = layout.statsCols + 1; cols <= 8; cols++) {
      const attempt = computeLayout(dims, options, cell, colorCount, cols);
      layout = attempt;
      if (attempt.h <= maxEdge) break;
    }
  }

  layout.tooSmall = cell < constants.EXPORT_CELL_SIZE_MIN;
  return layout;
}

/** 在画布上把整张图纸画出来 */
function drawPattern(ctx, params) {
  const grid = params.grid;
  const dims = params.dims;
  const options = params.options || {};
  const colorSystem = params.colorSystem;
  const colorCounts = params.colorCounts || {};
  const totalBeadCount = params.totalBeadCount || 0;
  const layout = params.plan;
  const branding = !!options.branding;

  const N = dims.N;
  const M = dims.M;
  const cell = layout.cell;
  const W = layout.w;
  const H = layout.h;

  ctx.imageSmoothingEnabled = false;

  // ---- 底色 ----
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const originX = layout.extraLR + layout.axisLabelSize;
  const originY = layout.titleBarHeight + layout.extraTB + layout.axisLabelSize;

  // ---- 标题栏 ----
  ctx.fillStyle = '#1f2937';
  ctx.fillRect(0, 0, W, layout.titleBarHeight);

  if (branding) {
    const brandW = Math.floor(layout.titleBarHeight * 0.8);
    const grad = ctx.createLinearGradient(0, 0, brandW, layout.titleBarHeight);
    grad.addColorStop(0, '#6366f1');
    grad.addColorStop(1, '#8b5cf6');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, brandW, layout.titleBarHeight);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.max(16, Math.floor(layout.titleBarHeight * 0.34))}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('拼豆图纸', brandW + 16, layout.titleBarHeight / 2);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.max(18, Math.floor(layout.titleBarHeight * 0.4))}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('拼豆图纸', 24, layout.titleBarHeight / 2);

    ctx.font = `${STATS_FONT_SIZE}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillText(
      `${N} × ${M} · 共 ${totalBeadCount} 颗 · ${colorSystem} 色号`,
      W - 24 - ctx.measureText(`${N} × ${M} · 共 ${totalBeadCount} 颗 · ${colorSystem} 色号`).width,
      layout.titleBarHeight / 2
    );
  }

  // ---- 坐标轴 ----
  if (layout.showCoords) {
    const ax = layout.axisLabelSize;
    ctx.fillStyle = '#f5f5f5';
    // 四边色带
    ctx.fillRect(originX, originY - ax, layout.gridWidth, ax); // 上
    ctx.fillRect(originX, originY + layout.gridHeight, layout.gridWidth, ax); // 下
    ctx.fillRect(originX - ax, originY, ax, layout.gridHeight); // 左
    ctx.fillRect(originX + layout.gridWidth, originY, ax, layout.gridHeight); // 右

    ctx.strokeStyle = '#aaaaaa';
    ctx.lineWidth = 1;
    ctx.strokeRect(originX - ax + 0.5, originY - ax + 0.5, layout.gridWidth + ax * 2 - 1, ax);
    ctx.strokeRect(originX - ax + 0.5, originY + layout.gridHeight + 0.5, layout.gridWidth + ax * 2 - 1, ax - 1);

    ctx.fillStyle = '#333333';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const interval = Math.max(1, layout.gridInterval);
    for (let i = 0; i < N; i++) {
      if (i === 0 || i === N - 1 || (i + 1) % interval === 0) {
        const cx = originX + (i + 0.5) * cell;
        ctx.fillText(String(i + 1), cx, originY - ax / 2);
        ctx.fillText(String(i + 1), cx, originY + layout.gridHeight + ax / 2);
      }
    }
    for (let j = 0; j < M; j++) {
      if (j === 0 || j === M - 1 || (j + 1) % interval === 0) {
        const cy = originY + (j + 0.5) * cell;
        ctx.fillText(String(j + 1), originX - ax / 2, cy);
        ctx.fillText(String(j + 1), originX + layout.gridWidth + ax / 2, cy);
      }
    }
  }

  // ---- 格子 ----
  for (let j = 0; j < M; j++) {
    const row = grid[j];
    const y = originY + j * cell;
    for (let i = 0; i < N; i++) {
      const cellData = row[i];
      const x = originX + i * cell;

      if (cellData.isExternal) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x, y, cell, cell);
        continue;
      }

      ctx.fillStyle = cellData.color;
      ctx.fillRect(x, y, cell, cell);

      if (layout.canDrawCellNumbers) {
        ctx.fillStyle = getContrastColor(cellData.color);
        ctx.font = `bold ${layout.cellFontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(getDisplayColorKey(cellData.color, colorSystem), x + cell / 2, y + cell / 2);
      }
    }
  }

  // ---- 每格细边框 ----
  if (cell >= 6) {
    ctx.strokeStyle = '#dddddd';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const x = originX + i * cell + 0.5;
      ctx.moveTo(x, originY);
      ctx.lineTo(x, originY + layout.gridHeight);
    }
    for (let j = 0; j <= M; j++) {
      const y = originY + j * cell + 0.5;
      ctx.moveTo(originX, y);
      ctx.lineTo(originX + layout.gridWidth, y);
    }
    ctx.stroke();
  }

  // ---- 分隔网格线 ----
  if (options.showGrid && cell >= 3) {
    const interval = Math.max(1, layout.gridInterval);
    ctx.strokeStyle = layout.gridLineColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = interval; i < N; i += interval) {
      const x = originX + i * cell;
      ctx.moveTo(x, originY);
      ctx.lineTo(x, originY + layout.gridHeight);
    }
    for (let j = interval; j < M; j += interval) {
      const y = originY + j * cell;
      ctx.moveTo(originX, y);
      ctx.lineTo(originX + layout.gridWidth, y);
    }
    ctx.stroke();
  }

  // ---- 外框 ----
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(originX, originY, layout.gridWidth, layout.gridHeight);

  // ---- 采购清单 ----
  if (layout.includeStats) {
    drawStats(ctx, {
      layout,
      colorCounts,
      totalBeadCount,
      colorSystem,
      originY,
      branding,
    });
  }
}

function drawStats(ctx, p) {
  const layout = p.layout;
  const W = layout.w;
  const colorCounts = p.colorCounts;
  const colorSystem = p.colorSystem;

  const keys = Object.keys(colorCounts).sort((a, b) =>
    sortColorKeys(getDisplayColorKey(a, colorSystem), getDisplayColorKey(b, colorSystem))
  );

  // 网格底部 -> 下坐标带 -> 下留白 -> 清单区
  const top = p.originY + layout.gridHeight + layout.axisLabelSize + layout.extraTB + STATS_TOP_MARGIN;

  ctx.fillStyle = '#111827';
  ctx.font = `bold ${STATS_FONT_SIZE + 2}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('采购清单', STATS_PADDING, top);

  const rightText = `共 ${keys.length} 色 / ${p.totalBeadCount} 颗`;
  ctx.font = `${STATS_FONT_SIZE}px sans-serif`;
  ctx.fillStyle = '#6b7280';
  ctx.textAlign = 'right';
  ctx.fillText(rightText, W - STATS_PADDING, top + 2);

  // 分隔线
  const lineY = top + STATS_TITLE_HEIGHT - 6;
  ctx.strokeStyle = '#dddddd';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(STATS_PADDING, lineY + 0.5);
  ctx.lineTo(W - STATS_PADDING, lineY + 0.5);
  ctx.stroke();

  const startY = top + STATS_TITLE_HEIGHT;
  ctx.textBaseline = 'middle';

  for (let index = 0; index < keys.length; index++) {
    const hex = keys[index];
    const row = Math.floor(index / layout.statsCols);
    const col = index % layout.statsCols;
    const itemX = STATS_PADDING + col * layout.itemWidth;
    const rowY = startY + row * STATS_ROW_HEIGHT + SWATCH_SIZE / 2;

    // 色块
    ctx.fillStyle = hex;
    ctx.fillRect(itemX, rowY - SWATCH_SIZE / 2, SWATCH_SIZE, SWATCH_SIZE);
    ctx.strokeStyle = '#cccccc';
    ctx.lineWidth = 1;
    ctx.strokeRect(itemX + 0.5, rowY - SWATCH_SIZE / 2 + 0.5, SWATCH_SIZE - 1, SWATCH_SIZE - 1);

    // 色号
    ctx.fillStyle = '#333333';
    ctx.font = `600 ${STATS_FONT_SIZE}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(getDisplayColorKey(hex, colorSystem), itemX + SWATCH_SIZE + 5, rowY);

    // 数量
    ctx.font = `${STATS_FONT_SIZE}px sans-serif`;
    ctx.textAlign = 'right';
    const countX = layout.statsCols === 1 ? W - STATS_PADDING : itemX + layout.itemWidth - 10;
    ctx.fillText(`${colorCounts[hex].count} 颗`, countX, rowY);
  }

  // 总计
  const footerY = startY + layout.statsRows * STATS_ROW_HEIGHT + STATS_FOOTER_HEIGHT / 2;
  ctx.fillStyle = '#111827';
  ctx.font = `bold ${STATS_FONT_SIZE + 1}px sans-serif`;
  ctx.textAlign = 'right';
  ctx.fillText(`总计：${p.totalBeadCount} 颗`, W - STATS_PADDING, footerY);
}

module.exports = { planExport, computeLayout, drawPattern };
