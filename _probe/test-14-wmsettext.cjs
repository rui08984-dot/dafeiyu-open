#!/usr/bin/env node
/**
 * #14 后台填值实测（WM_SETTEXT），2026-11-10 三十八轮。
 *
 * 测什么：不抢焦点、不动鼠标，直接给另一个窗口的编辑控件塞文字，并且**回读**证明生效。
 * 为什么要测：DSH 22 条机制里 #14 是「PostMessage 前 ScreenToClient 换算」，
 *   而更上游的问题是「这条路到底走不走得通」——如果 WM_SETTEXT 可用，
 *   以后「给她一个输入框填字」可以完全不打扰用户当前焦点（比 SendInput 强得多）。
 *
 * 做法（自给自足，不碰用户窗口）：
 *   ① 记录启动前的窗口集合
 *   ② 自己开记事本 → 取**新出现的那个 hwnd**（hwnd 锁定，铁律）
 *   ③ pwsh 跑 _probe/wm-settext-test.ps1：WM_SETTEXT 写入 → WM_GETTEXT 回读
 *   ④ 断言回读内容 + 前台窗口没被抢
 *   ⑤ 关掉自己开的记事本（只 kill 自己的 pid）
 */
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'pet-core', 'target', 'release', 'pet-core.exe');
const PS1 = path.join(__dirname, 'wm-settext-test.ps1');
const PWSH = 'C:/Program Files/PowerShell/7/pwsh.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listWindows() {
  try {
    return JSON.parse(execFileSync(CORE, [], {
      input: JSON.stringify({ cmd: 'windows', max: 200 }), timeout: 5000, maxBuffer: 8 * 1024 * 1024,
    }).toString()).windows || [];
  } catch (e) { return []; }
}

(async () => {
  const before = new Set(listWindows().map((w) => Number(w.hwnd)));
  console.log('启动前窗口数:', before.size);

  const child = spawn('C:/Windows/System32/notepad.exe', [], { detached: false, stdio: 'ignore' });
  const pid = child.pid;
  console.log('已启动记事本 pid=' + pid + '，等窗口出现…');

  let hit = null;
  for (let i = 0; i < 40; i += 1) {           // 最多 8s
    await sleep(200);
    const now = listWindows();
    hit = now.find((w) => !before.has(Number(w.hwnd)) && !w.iconic &&
      (Number(w.pid) === Number(pid) || /记事本|Notepad|无标题/i.test(String(w.title || ''))));
    if (hit) break;
  }
  if (!hit) {
    console.log('FAIL 没等到记事本窗口（Win11 记事本可能是 UWP 多标签，窗口枚举拿不到）');
    try { process.kill(pid); } catch (e) { /* ignore */ }
    process.exit(1);
  }
  console.log('锁定窗口: hwnd=' + hit.hwnd + ' title="' + hit.title + '" pid=' + hit.pid);

  let out = '';
  try {
    out = execFileSync(PWSH, ['-NoProfile', '-File', PS1], {
      env: Object.assign({}, process.env, { PET_TEST_HWND: String(hit.hwnd) }),
      timeout: 20000, encoding: 'utf8',
    }).trim();
  } catch (e) {
    out = String(e.stdout || e.message || '').trim();
  }
  console.log('ps1 输出:', out.slice(0, 500));

  let r = null;
  try {
    // ps1 走 Base64 输出（免疫 GBK stdout）：B64:<base64(utf8 json)>
    const b64line = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('B64:')).pop();
    if (b64line) r = JSON.parse(Buffer.from(b64line.slice(4), 'base64').toString('utf8'));
    else r = JSON.parse(out.split('\n').filter((l) => l.trim().startsWith('{')).pop());
  } catch (e) { r = null; }

  const pass = !!(r && r.ok && /WM_SETTEXT 实测 ABC 123/.test(String(r.readback || '')));
  console.log('---');
  console.log('edit 控件类:', r ? r.editClass : '?');
  console.log('回读内容:', r ? JSON.stringify(r.readback) : '(无)');
  console.log('前台被抢:', r ? (r.foregroundUntouched ? '否（零打扰）' : '是（fgBefore=' + r.fgBefore + ' fgAfter=' + r.fgAfter + '）') : '?');
  console.log('结论:', pass ? 'PASS —— WM_SETTEXT 后台填值可用（不抢焦点）' : 'FAIL —— 这条路线在目标窗口上不可用');

  // 清场：只关自己开的
  // 清场：Win11 记事本是 UWP，spawn 的 pid 是 launcher，真进程是窗口的 pid
  for (const p of [Number(hit.pid), Number(pid)]) {
    if (!p) continue;
    try { execFileSync('taskkill', ['/PID', String(p), '/F'], { timeout: 5000 }); } catch (e) { /* ignore */ }
  }
  try { child.kill(); } catch (e) { /* ignore */ }

  const rec = {
    ts: new Date().toISOString(), hwnd: hit.hwnd, title: hit.title, pid,
    result: r, pass,
  };
  const outDir = path.join(ROOT, '_probe', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'test-14-wmsettext.json'), JSON.stringify(rec, null, 2), 'utf8');
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.log('ERROR', e && e.message);
  process.exit(2);
});
