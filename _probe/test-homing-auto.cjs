#!/usr/bin/env node
/**
 * homing 自动补偿真账实测（2026-11-10 三十八轮）。
 *
 * 场景：先 snapshot 一个窗口（记 rect+hwnd），把窗口挪走 150,100，
 *       再用**旧坐标** click_at —— 应该自动 +dx,+dy 并报 homed.applied=true。
 * 用自开的唯一标题记事本，全程只碰自己开的窗口。
 */
const { spawn, execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'pet-core', 'target', 'release', 'pet-core.exe');
const { runGameAction } = require(path.join(ROOT, '_incoming/my-neuro/live-2d/plugins/community/dispatch/game-control.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TITLE = 'homing-test';

function listWindows() {
  try {
    return JSON.parse(execFileSync(CORE, [], {
      input: JSON.stringify({ cmd: 'windows', max: 200 }), timeout: 5000, maxBuffer: 8 * 1024 * 1024,
    }).toString()).windows || [];
  } catch (e) { return []; }
}

(async () => {
  const before = new Set(listWindows().map((w) => Number(w.hwnd)));
  const child = spawn('C:/Windows/System32/notepad.exe', [path.join(__dirname, 'out', 'homing-test.txt')], { stdio: 'ignore' });

  let hit = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(200);
    hit = listWindows().find((w) => !before.has(Number(w.hwnd)) && !w.iconic && String(w.title || '').includes(TITLE));
    if (hit) break;
  }
  if (!hit) {
    console.log('FAIL 没等到 homing-test 窗口');
    try { process.kill(child.pid); } catch (e) { /* ignore */ }
    process.exit(1);
  }
  console.log('锁定:', hit.hwnd, JSON.stringify(hit.title), '起来时 rect=');

  // 先聚焦 + snapshot（UIA_SNAPSHOT_STATE 记录 rect/hwnd/pid）
  await runGameAction('focus_window', TITLE, '', {}, {}).catch(() => null);
  await sleep(400);
  const snap = await runGameAction('snapshot', TITLE, '', {}, {});
  console.log('snapshot:', snap.ok, '元素', (snap.elements || []).length);

  // 取快照时的窗口矩形（用 pet-core windows 拿，和 snapshot 内部同一来源）
  const w1 = listWindows().find((w) => Number(w.hwnd) === Number(hit.hwnd));
  console.log('移动前 rect:', w1.x, w1.y, w1.w, w1.h);

  // 挪走 +150,+100（用 SetWindowPos，不动鼠标）
  const ps = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class M{[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int ht,uint f);}';` +
    `[M]::SetWindowPos([IntPtr]${hit.hwnd},[IntPtr]::Zero,${w1.x + 150},${w1.y + 100},${w1.w},${w1.h},0x0004)`;
  execFileSync('C:/Program Files/PowerShell/7/pwsh.exe', ['-NoProfile', '-Command', ps], { timeout: 15000 });
  await sleep(600);
  const w2 = listWindows().find((w) => Number(w.hwnd) === Number(hit.hwnd));
  console.log('移动后 rect:', w2.x, w2.y, '（应 +150,+100）');

  // 用**旧坐标**点：取旧窗口中心偏内一点（避免点标题栏）
  // 用靠近左上角的旧坐标：窗口很大时中心点移动后仍落在新矩形内，判据会（正确地）不补偿
  const oldX = Math.round(w1.x + 60);
  const oldY = Math.round(w1.y + 140);
  const r = await runGameAction('click_at', oldX + ',' + oldY, TITLE, {}, {}).catch((e) => ({ error: e.message }));
  console.log('click_at 旧坐标(' + oldX + ',' + oldY + '):', JSON.stringify({
    ok: r.ok, effect: r.effect, homed: r.homed, detail: String(r.detail || r.error || '').slice(0, 140),
  }, null, 1));

  const pass = !!(r.homed && r.homed.applied === true);
  console.log('结论:', pass ? 'PASS —— 旧坐标被自动补偿 (+' + r.homed.dx + ',+' + r.homed.dy + ')' : 'FAIL —— 没触发自动补偿');

  // 清场
  try { execFileSync('taskkill', ['/PID', String(hit.pid), '/F'], { timeout: 5000 }); } catch (e) { /* ignore */ }
  try { child.kill(); } catch (e) { /* ignore */ }
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('ERROR', e && e.message); process.exit(2); });
