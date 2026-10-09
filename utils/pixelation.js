/**
 * 像素化：把原图切成 N×M 网格，每格取代表色，再映射到调色板。
 *
 * 移植自 perler-beads/src/utils/pixelation.ts 的 calculateCellRepresentativeColor
 * 与 calculatePixelGrid，算法逻辑逐行照搬，只把「浏览器 CanvasRenderingContext2D」
 * 换成纯 ImageData（{data, width, height}），因为小程序里采样在离屏画布做完后
 * 只需要像素数组。
 */
const MODE_DOMINANT = 'dominant';
const MODE_AVERAGE = 'average';

const TRANSPARENT_KEY = 'ERASE';
/** 外部/空白格的统一表示，与网页版 pixelEditingUtils.ts 一致 */
function transparentColorData() {
  return { key: TRANSPARENT_KEY, color: '#FFFFFF', isExternal: true };
}

/**
 * 算一格的代表色。
 * @returns {r,g,b} 或 null（格内没有不透明像素）
 */
function cellRepresentativeColor(data, imgWidth, startX, startY, width, height, mode) {
  const endX = startX + width;
  const endY = startY + height;
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let pixelCount = 0;

  // dominant 模式用「值 -> 次数」；用 Map 存整数键比字符串键快
  let counts = null;
  let dominantR = 0;
  let dominantG = 0;
  let dominantB = 0;
  let maxCount = 0;

  if (mode === MODE_DOMINANT) counts = new Map();

  for (let y = startY; y < endY; y++) {
    let index = (y * imgWidth + startX) * 4;
    for (let x = startX; x < endX; x++, index += 4) {
      if (data[index + 3] < 128) continue; // 忽略透明像素
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      pixelCount++;

      if (mode === MODE_AVERAGE) {
        rSum += r;
        gSum += g;
        bSum += b;
      } else {
        const k = (r << 16) | (g << 8) | b;
        const c = (counts.get(k) || 0) + 1;
        counts.set(k, c);
        if (c > maxCount) {
          maxCount = c;
          dominantR = r;
          dominantG = g;
          dominantB = b;
        }
      }
    }
  }

  if (pixelCount === 0) return null;

  if (mode === MODE_AVERAGE) {
    return {
      r: Math.round(rSum / pixelCount),
      g: Math.round(gSum / pixelCount),
      b: Math.round(bSum / pixelCount),
    };
  }
  return { r: dominantR, g: dominantG, b: dominantB };
}

/**
 * 计算整张网格。
 * @param {{data:Uint8ClampedArray|Uint8Array, width:number, height:number}} imageData 采样图
 * @param {number} imgW 采样图宽
 * @param {number} imgH 采样图高
 * @param {number} N 横向格数
 * @param {number} M 纵向格数
 * @param {{lookup:(r:number,g:number,b:number)=>{key:string,hex:string}}} mapper 最近色映射
 * @param {string} mode 'dominant' | 'average'
 * @param {(j:number)=>void} [onRow] 每算完一行回调（用于分片/进度）
 * @returns {{data: Array<Array<{key:string,color:string,isExternal?:boolean}>>, dims:{N:number,M:number}}}
 */
function calculatePixelGrid(imageData, imgW, imgH, N, M, mapper, mode, onRow) {
  const src = imageData.data;
  const cellW = imgW / N;
  const cellH = imgH / M;
  const data = new Array(M);

  for (let j = 0; j < M; j++) {
    const row = new Array(N);
    const startY = Math.floor(j * cellH);
    const endY = Math.min(imgH, Math.ceil((j + 1) * cellH));
    const cellHeight = Math.max(1, endY - startY);

    for (let i = 0; i < N; i++) {
      const startX = Math.floor(i * cellW);
      const endX = Math.min(imgW, Math.ceil((i + 1) * cellW));
      const cellWidth = Math.max(1, endX - startX);

      const rep = cellRepresentativeColor(src, imgW, startX, startY, cellWidth, cellHeight, mode);
      if (rep) {
        const p = mapper.lookup(rep.r, rep.g, rep.b);
        row[i] = { key: p.key, color: p.hex };
      } else {
        row[i] = transparentColorData();
      }
    }
    data[j] = row;
    if (onRow) onRow(j);
  }

  return { data, dims: { N, M } };
}

/**
 * 分片版：每片最多占用 budgetMs 毫秒，然后 setTimeout(0) 让出主线程，
 * 避免小程序 UI 冻结（小程序没有可靠的 Web Worker 替代）。
 * @param {number} [budgetMs=16]
 * @param {(progress:number)=>void} [onProgress] 0~1
 */
function calculatePixelGridChunked(imageData, imgW, imgH, N, M, mapper, mode, onProgress, budgetMs) {
  const budget = budgetMs || 16;
  return new Promise((resolve) => {
    const src = imageData.data;
    const cellW = imgW / N;
    const cellH = imgH / M;
    const data = new Array(M);
    let j = 0;

    function step() {
      const deadline = Date.now() + budget;
      while (j < M && Date.now() < deadline) {
        const row = new Array(N);
        const startY = Math.floor(j * cellH);
        const endY = Math.min(imgH, Math.ceil((j + 1) * cellH));
        const cellHeight = Math.max(1, endY - startY);

        for (let i = 0; i < N; i++) {
          const startX = Math.floor(i * cellW);
          const endX = Math.min(imgW, Math.ceil((i + 1) * cellW));
          const cellWidth = Math.max(1, endX - startX);

          const rep = cellRepresentativeColor(src, imgW, startX, startY, cellWidth, cellHeight, mode);
          if (rep) {
            const p = mapper.lookup(rep.r, rep.g, rep.b);
            row[i] = { key: p.key, color: p.hex };
          } else {
            row[i] = transparentColorData();
          }
        }
        data[j] = row;
        j++;
      }

      if (onProgress) onProgress(j / M);
      if (j < M) {
        setTimeout(step, 0);
      } else {
        resolve({ data, dims: { N, M } });
      }
    }

    step();
  });
}

module.exports = {
  MODE_DOMINANT,
  MODE_AVERAGE,
  TRANSPARENT_KEY,
  transparentColorData,
  cellRepresentativeColor,
  calculatePixelGrid,
  calculatePixelGridChunked,
};
