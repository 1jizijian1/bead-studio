/**
 * 颜色统计。移植自 page.tsx:1021-1036 / 1262-1275 / 1392-1410。
 *
 * 统计键是 **hex（大写）**，不是色号 —— 网页版就用 hex，
 * 排除颜色、重映射白名单都依赖它。
 */
const { TRANSPARENT_KEY } = require('./pixelation');

/**
 * @returns {{colorCounts:Object, totalBeadCount:number, initialGridColorKeys:Set<string>}}
 *   colorCounts: { '#RRGGBB': { count, color } }
 */
function computeStats(data, dims) {
  const colorCounts = {};
  let totalBeadCount = 0;

  for (let j = 0; j < dims.M; j++) {
    const row = data[j];
    for (let i = 0; i < dims.N; i++) {
      const cell = row[i];
      if (!cell || cell.isExternal || cell.key === TRANSPARENT_KEY) continue;
      const hex = cell.color.toUpperCase();
      let entry = colorCounts[hex];
      if (!entry) {
        entry = { count: 0, color: hex };
        colorCounts[hex] = entry;
      }
      entry.count++;
      totalBeadCount++;
    }
  }

  return {
    colorCounts,
    totalBeadCount,
    initialGridColorKeys: new Set(Object.keys(colorCounts)),
  };
}

/** 深拷贝一份网格（改数据前先拷贝，保留原图便于回退） */
function cloneGrid(data, dims) {
  const out = new Array(dims.M);
  for (let j = 0; j < dims.M; j++) {
    const row = data[j];
    const nr = new Array(dims.N);
    for (let i = 0; i < dims.N; i++) {
      const c = row[i];
      nr[i] = c ? { key: c.key, color: c.color, isExternal: !!c.isExternal } : c;
    }
    out[j] = nr;
  }
  return out;
}

/** 依赖色号的排序：把 colorCounts 的 hex 键转成色号后排序，返回 [{hex, key, color, count}] */
function sortedColorStats(colorCounts, colorSystem, getDisplayColorKey, sortColorKeys) {
  const list = Object.keys(colorCounts).map((hex) => ({
    hex,
    key: getDisplayColorKey(hex, colorSystem),
    color: colorCounts[hex].color,
    count: colorCounts[hex].count,
  }));
  list.sort((a, b) => sortColorKeys(a.key, b.key));
  return list;
}

module.exports = { computeStats, cloneGrid, sortedColorStats };
