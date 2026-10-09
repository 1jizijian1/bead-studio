/**
 * 把原仓库的 colorSystemMapping.json 转成小程序能安全 require 的 JS 模块。
 * 小程序对 require('*.json') 的支持在不同基础库/打包器上不一致，统一转 JS。
 *
 * 用法（Node 不在 PATH，用绝对路径）：
 *   "C:\Users\727\Desktop\node\node.exe" tools/json2js.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../perler-beads/src/app/colorSystemMapping.json');
const DEST = path.resolve(__dirname, '../data/colorSystemMapping.js');

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));

const keys = Object.keys(raw);
const lines = keys.map((hex) => {
  const m = raw[hex];
  // 色号里有中文键（漫漫/盼盼/咪小窝），必须加引号
  const parts = Object.keys(m).map((k) => `"${k}":${JSON.stringify(m[k])}`);
  return `  ${JSON.stringify(hex)}:{${parts.join(',')}}`;
});

const out =
  '// 本文件由 tools/json2js.js 从 perler-beads/src/app/colorSystemMapping.json 自动生成，勿手改。\n' +
  `// ${keys.length} 条：hex -> { MARD, COCO, 漫漫, 盼盼, 咪小窝 }\n` +
  'module.exports = {\n' +
  lines.join(',\n') +
  '\n};\n';

fs.writeFileSync(DEST, out, 'utf8');
console.log(`写入 ${DEST}`);
console.log(`条目数：${keys.length}`);
