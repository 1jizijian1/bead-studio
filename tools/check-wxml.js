/**
 * 静态检查：WXML 模板里引用的变量，是否都在对应 Page 的 data 里声明。
 *
 * 为什么需要：小程序跑不起来的时候，模板引用了不存在的字段是常见低级错误，
 * 而它只在运行时报一句很含糊的错。这个脚本不用模拟器就能提前抓出来。
 *
 * 用法："C:\Users\727\Desktop\node\node.exe" tools/check-wxml.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function collectDataFields(js) {
  // 抓 Page({ data: { ... } }) 的顶层字段（4 空格缩进）
  const m = /data:\s*\{([\s\S]*?)\n  \},/.exec(js);
  if (!m) return null;
  const fields = new Set();
  const re = /^\s{4}([A-Za-z_$][\w$]*)\s*:/gm;
  let mm;
  while ((mm = re.exec(m[1]))) fields.add(mm[1]);
  return fields;
}

function collectTemplateVars(wxml) {
  const vars = new Set();
  const re = /\{\{([^}]+)\}\}/g;
  let v;
  while ((v = re.exec(wxml))) {
    // 先剥掉字符串字面量 —— 它们不是变量（如 class 三元里的 'cell-off'）
    const expr = v[1].replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
    const ids = expr.match(/[A-Za-z_$][\w$]*/g) || [];
    for (const id of ids) {
      if (['true', 'false', 'null', 'undefined', 'item', 'index', 'wx'].includes(id)) continue;
      const idx = expr.indexOf(id);
      if (idx > 0 && expr[idx - 1] === '.') continue; // 属性访问，不是根变量
      vars.add(id);
    }
  }
  return vars;
}

const pagesDir = path.join(ROOT, 'pages');
const pages = fs
  .readdirSync(pagesDir)
  .filter((d) => fs.existsSync(path.join(pagesDir, d, 'index.wxml')));

let failed = 0;
for (const p of pages) {
  const wxmlPath = path.join(pagesDir, p, 'index.wxml');
  const jsPath = path.join(pagesDir, p, 'index.js');
  const wxml = fs.readFileSync(wxmlPath, 'utf8');
  const js = fs.readFileSync(jsPath, 'utf8');

  const fields = collectDataFields(js);
  if (!fields) {
    console.log(`✗ pages/${p}：解析不到 Page 的 data 块`);
    failed++;
    continue;
  }

  const vars = collectTemplateVars(wxml);
  const missing = [...vars].filter((x) => !fields.has(x));
  if (missing.length) {
    console.log(`✗ pages/${p}：模板引用了 data 里没有的字段 -> ${missing.join(', ')}`);
    failed++;
  } else {
    console.log(`✓ pages/${p}：模板 ${vars.size} 个变量全在 data 里`);
  }
}

if (failed) {
  console.error(`\n${failed} 个页面有问题`);
  process.exit(1);
}
console.log('\n全部通过');
