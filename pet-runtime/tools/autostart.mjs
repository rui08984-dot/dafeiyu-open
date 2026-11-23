// autostart.mjs — ⚠ DEPRECATED（2026-11-21）—— 请勿再用于新逻辑。
//
// 历史：本脚本往「启动目录」写 大肥鱼桌宠.cmd 实现开机自启。
// 现状（三套实现并存 → 只认一套）：唯一实现是 autostart.cjs（HKCU Run 键 `DaFeiYu`），
// 主进程托盘 / doctor / launcher 都只认它。本文件保留只是为了兼容旧文档/旧命令，
// install/remove/status 全部转发给 autostart.cjs，**不再碰启动目录**。
//
// 三套实现的去向：
//   · autostart.cjs        → 唯一实现（HKCU\...\Run\DaFeiYu）
//   · autostart.mjs（本文件）→ deprecated，转发
//   · main.js 里的 Startup .cmd 逻辑 → 仅用于「清理旧文件」，不再作为判据
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const helper = join(here, 'autostart.cjs');

const action = String(process.argv[2] || 'status').toLowerCase();
const map = { install: 'on', remove: 'off', status: 'status', on: 'on', off: 'off' };
const cmd = map[action];

console.error('[autostart.mjs] DEPRECATED：开机自启已统一为 HKCU Run `DaFeiYu`（pet-runtime/tools/autostart.cjs）。' +
  (cmd ? '本次已转发：' + action + ' → ' + cmd : ''));

if (!cmd) {
  console.log('usage: node tools/autostart.mjs status|install|remove   （已废弃，转发到 autostart.cjs）');
  process.exit(2);
}

const r = spawnSync('node', [helper, cmd], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(typeof r.status === 'number' ? r.status : 1);
