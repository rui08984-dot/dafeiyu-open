// scripts/install-hooks.mjs —— 把 scripts/hooks/* 装到 .git/hooks/
//
// 为什么钩子不直接放 .git/hooks：那个目录**不入库**，换机器就没了。
// 放 scripts/hooks/ 入库，clone 后跑一次这个脚本就装好。
//
// 用法：node scripts/install-hooks.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'scripts', 'hooks');
const DST = path.join(ROOT, '.git', 'hooks');

if (!fs.existsSync(path.join(ROOT, '.git'))) {
  console.error('这里不是 git 仓库根（找不到 .git/）');
  process.exit(1);
}
if (!fs.existsSync(SRC)) {
  console.error('找不到 scripts/hooks/');
  process.exit(1);
}
fs.mkdirSync(DST, { recursive: true });

let n = 0;
for (const name of fs.readdirSync(SRC)) {
  const src = path.join(SRC, name);
  if (!fs.statSync(src).isFile()) continue;
  const dst = path.join(DST, name);
  fs.copyFileSync(src, dst);
  try { fs.chmodSync(dst, 0o755); } catch (e) { /* Windows 上 chmod 可能是空操作，git 仍然能跑 */ }
  console.log('  装好 ' + name);
  n += 1;
}

console.log(`\n${n} 个钩子已装到 .git/hooks/ —— 之后 git commit 会自动跑。`);
console.log('跳过检查：git commit --no-verify');
