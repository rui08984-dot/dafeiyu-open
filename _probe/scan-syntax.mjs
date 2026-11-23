// scan-syntax.mjs —— 全量语法检查（2026-11-13）
//
// 为什么要有它：check-all 里的语法清单原来是**手工维护**的，结果
// driver.js / assets-bridge.js / vts-server.mjs / tts-processor.js —— 今天改过的
// 四个文件全都不在清单里。手工清单一定会漏，而且漏的总是刚改的那个。
//
// 这里改成自动发现：main.js + js/** + petbridge/** + plugins/**（排除 node_modules/lib/libs）。
// 并行跑 `node --check`（8 路），138 个文件约 3 秒（顺序跑要 15 秒）。
//
// 用法：node _probe/scan-syntax.mjs [--quiet]
// 退出码：有失败 → 1

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const quiet = process.argv.includes('--quiet');
const CONCURRENCY = 8;
const SKIP_DIRS = new Set(['node_modules', 'lib', 'libs', '.git', 'dist', 'build', '_archive']);

function walk(dir, out, depth = 0) {
  if (depth > 6) return out;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const targets = [];
for (const rel of ['main.js', 'js', 'petbridge', 'plugins', 'js/plugins']) {
  const p = path.join(APP, rel);
  if (!fs.existsSync(p)) continue;
  const st = fs.statSync(p);
  if (st.isDirectory()) walk(p, targets);
  else if (/\.(js|mjs|cjs)$/.test(p)) targets.push(p);
}
const files = [...new Set(targets)];

// 假绿防护（2026-11-14）：APP 不存在时 targets 为空 → 下面会打出「通过 0 / 失败 0」
// 然后退出 0 —— 看起来全绿，其实一个文件都没查。实测过：把远端内容解到临时目录跑，
// 语法扫描「通过」，但 4 项单测红，很容易让人以为语法没问题。
if (files.length < 50) {
  console.log('语法扫描只找到 ' + files.length + ' 个文件 —— 应用仓库可能没就位：' + APP);
  console.log('  clone：git clone <她的仓库> _incoming/my-neuro');
  process.exit(1);
}

function checkOne(file) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--check', file], { timeout: 30000 }, (err, _so, se) => {
      if (!err) return resolve(null);
      const msg = String(se || err.message || '').split('\n').filter(Boolean).slice(0, 3).join(' ');
      resolve({ file: path.relative(APP, file), msg: msg.slice(0, 240) });
    });
  });
}

const failures = [];
const queue = files.slice();
async function worker() {
  while (queue.length) {
    const f = queue.shift();
    const bad = await checkOne(f);
    if (bad) failures.push(bad);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

if (!quiet) {
  for (const f of failures) console.log('  FAIL ' + f.file + '\n       ' + f.msg);
}
console.log('语法扫描 ' + files.length + ' 个文件：通过 ' + (files.length - failures.length) + ' / 失败 ' + failures.length);
process.exit(failures.length ? 1 : 0);
