/**
 * 最近色查询（Oklab 空间）。
 *
 * 为什么不用量化 LUT：一开始按计划做了 5-bit RGB 量化查表，实测发现
 *   - 直接搜索 90000 次（300x300 网格最坏情况）只要 65ms
 *   - LUT 建表 + 查询共 47ms，只省 ~18ms
 *   - 但量化会把 291 个色号里的 13 个错配到**极其相近的邻居色**
 *     （如 #F7F8A2 -> #EEFCA5）。拼豆要按色号买豆子，错配是实打实的问题，
 *     而且会导致结果与网页版对不上。
 * 所以弃用 LUT，直接搜索：同样快、精确、且与网页版逻辑一致。
 *
 * 加速靠 `oklab.js` 里的整数键缓存（同一颜色重复查询直接命中）。
 */
const { getOklab, oklabDistance } = require('./oklab');

/** 给调色板项预计算 Oklab（只做一次，供逐格查询复用） */
function withOklab(palette) {
  return palette.map((c) => ({
    key: c.key,
    hex: c.hex,
    rgb: c.rgb,
    _oklab: getOklab(c.rgb.r, c.rgb.g, c.rgb.b),
  }));
}

/** 在**已预计算**的调色板上找最近色，返回调色板下标 */
function closestIndex(prepared, r, g, b) {
  const target = getOklab(r, g, b);
  let bestIdx = 0;
  let bestD = Infinity;
  for (let i = 0; i < prepared.length; i++) {
    const d = oklabDistance(target, prepared[i]._oklab);
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
      if (d === 0) break; // 完全匹配，提前退出
    }
  }
  return bestIdx;
}

/**
 * 直接线性搜索最近色（用于调用次数少、或没有预计算调色板的场景）。
 * @param {Array<{key,hex,rgb}>} palette
 * @param {{r,g,b}} rgb
 */
function findClosestDirect(palette, rgb) {
  if (!palette || palette.length === 0) {
    return { key: 'ERR', hex: '#000000', rgb: { r: 0, g: 0, b: 0 } };
  }
  const target = getOklab(rgb.r, rgb.g, rgb.b);
  let best = palette[0];
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const po = p._oklab || getOklab(p.rgb.r, p.rgb.g, p.rgb.b);
    const d = oklabDistance(target, po);
    if (d < bestD) {
      bestD = d;
      best = p;
      if (d === 0) break;
    }
  }
  return { key: best.key, hex: best.hex, rgb: best.rgb };
}

/**
 * 建一个映射器，供 `pixelation.calculatePixelGrid` 逐格调用。
 * @param {Array<{key,hex,rgb}>} palette
 */
function createMapper(palette) {
  const pal = withOklab(palette);
  return {
    palette: pal,
    /** (r,g,b) -> 调色板下标 */
    lookupIndex(r, g, b) {
      return closestIndex(pal, r, g, b);
    },
    /** (r,g,b) -> { key, hex, rgb } */
    lookup(r, g, b) {
      const p = pal[closestIndex(pal, r, g, b)];
      return { key: p.key, hex: p.hex, rgb: p.rgb };
    },
  };
}

module.exports = { createMapper, findClosestDirect, withOklab, closestIndex };
