const fs = require('fs');
const png = require('./png');

const DIR =
  'C:/Users/727/xwechat_files/wxid_8snr5v7j6xs112_dec4/temp/RWTemp/2026-10/9e20f478899dc29eb19741386f9343c8/';
const SRC = DIR + 'd789f7974f002f7ba462d18cfa3365fa.png'; // 1920x1080 原图
const OUT = DIR + '94380b758dde2ddba0be31719102fa71.png'; // 350x233 结果截图

function stats(img, label) {
  const { width, height, data } = img;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  let alpha0 = 0;
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3];
    if (a < 128) {
      alpha0++;
      continue;
    }
    r += data[i * 4];
    g += data[i * 4 + 1];
    b += data[i * 4 + 2];
    n++;
  }
  console.log(`\n[${label}] ${width}x${height}  有效像素 ${n}  透明/半透明 ${alpha0}`);
  console.log(`  平均 RGB: (${(r / n).toFixed(1)}, ${(g / n).toFixed(1)}, ${(b / n).toFixed(1)})`);

  const buckets = new Array(10).fill(0);
  for (let i = 0; i < width * height; i++) {
    if (data[i * 4 + 3] < 128) continue;
    const lum = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    buckets[Math.min(9, Math.floor(lum / 25.6))]++;
  }
  console.log('  明度分布(0暗->9亮):', buckets.map((v) => ((v * 100) / n).toFixed(1) + '%').join(' '));
}

stats(png.decode(fs.readFileSync(SRC)), '原图');
stats(png.decode(fs.readFileSync(OUT)), '小程序结果截图');
