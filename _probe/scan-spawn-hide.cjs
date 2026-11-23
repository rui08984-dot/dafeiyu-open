// 扫描所有子进程调用，报告缺少 windowsHide 的（Windows 上会闪黑窗）。
// 用法：node _probe/scan-spawn-hide.cjs [root...]
//
// 2026-11-13 修两处「门禁自己骗人」：
//   ① 原来只取调用行往后 10 行找 windowsHide。main.js:973 的 windowsHide 正好在
//      第 10 行（983），slice(i, i+10) 取到 982 就停了 —— 差一行误报成「缺」。
//      现在改成括号配对，取整个调用表达式。
//   ② 原来不区分生产/dev，全按同一个数报。现在分两类，**只有生产缺了才算失败**
//      （dev 工具用 stdio:'inherit' 有意显示输出，不许 windowsHide 的要求套不上）。
const fs = require('fs');
const path = require('path');

const roots = process.argv.slice(2);
if (!roots.length) roots.push('_incoming/my-neuro/live-2d', 'pet-runtime');

// dev/工具脚本：允许没有 windowsHide（它们本来就要把输出打到终端）
// ⚠ 用 (^|[\\/]) 而不是直接 [\\/]：相对路径可能就以 pet-runtime\ 开头，没有前导分隔符。
const DEV_HINTS = [
  /(^|[\\/])pet-runtime[\\/]tools[\\/]/,
  /(^|[\\/])pet-runtime[\\/]\.state[\\/]/,
  /(^|[\\/])_archive[\\/]/,
  /(^|[\\/])_probe[\\/]/,
  /build-and-deploy-/,
];
const isDev = (rel) => DEV_HINTS.some((re) => re.test(rel));

function walk(d, out = []) {
  let ents;
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 从调用行开始按括号配对取出整个调用表达式（字符串里的括号会误判，够用即可）。 */
function callSpan(lines, start) {
  let depth = 0;
  let began = false;
  for (let i = start; i < lines.length && i < start + 60; i++) {
    const line = lines[i];
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (ch === '(') { depth += 1; began = true; }
      else if (ch === ')') depth -= 1;
    }
    if (began && depth <= 0) return lines.slice(start, i + 1).join('\n');
  }
  return lines.slice(start, start + 12).join('\n');
}

let total = 0;
const prodMissing = [];
const devMissing = [];

for (const root of roots) {
  for (const f of walk(path.resolve(root))) {
    const rel = path.relative(process.cwd(), f);
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\b(spawn|spawnSync|execFile|execFileSync)\s*\(/.test(line)) return;
      total += 1;
      const span = callSpan(lines, i);
      if (/windowsHide/.test(span)) return;
      const rec = rel + ':' + (i + 1) + '  ' + line.trim().slice(0, 100);
      (isDev(rel) ? devMissing : prodMissing).push(rec);
    });
  }
}

if (prodMissing.length) {
  console.log('【生产代码】缺 windowsHide（会闪黑窗）：');
  for (const r of prodMissing) console.log('  ✗ ' + r);
}
if (devMissing.length) {
  console.log('【dev/工具脚本】缺 windowsHide（允许，stdio:inherit 要看输出）：');
  for (const r of devMissing) console.log('  · ' + r);
}
console.log('--- 子进程调用 ' + total + ' 处：生产缺 ' + prodMissing.length + ' 处 / dev 缺 ' + devMissing.length + ' 处');
process.exit(prodMissing.length ? 1 : 0);
