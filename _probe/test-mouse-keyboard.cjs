#!/usr/bin/env node
/**
 * 鼠标双击/拖拽/键盘/整屏 补测（2026-11-10 三十九轮，用户要求）。
 * 用带文件名的记事本（标题唯一），避免误伤用户窗口。
 */
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'pet-core', 'target', 'release', 'pet-core.exe');
const { runGameAction } = require(path.join(ROOT, '_incoming/my-neuro/live-2d/plugins/community/dispatch/game-control.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TITLE = 'zcode-mouse-verify';

function listWindows() {
  try {
    return JSON.parse(execFileSync(CORE, [], {
      input: JSON.stringify({ cmd: 'windows', max: 200 }), timeout: 5000, maxBuffer: 8 * 1024 * 1024,
    }).toString()).windows || [];
  } catch (e) { return []; }
}

const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + detail);
};

(async () => {
  const seed = path.join(ROOT, '_probe', 'out', TITLE + '.txt');
  fs.mkdirSync(path.dirname(seed), { recursive: true });
  fs.writeFileSync(seed, 'seed line\n', 'utf8');

  const before = new Set(listWindows().map((w) => Number(w.hwnd)));
  const child = spawn('C:/Windows/System32/notepad.exe', [seed], { stdio: 'ignore' });
  let hit = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(200);
    hit = listWindows().find((w) => !before.has(Number(w.hwnd)) && !w.iconic && String(w.title || '').includes(TITLE));
    if (hit) break;
  }
  if (!hit) { rec('启动记事本', false, '没等到窗口'); process.exit(1); }
  rec('启动记事本', true, 'hwnd=' + hit.hwnd + ' title="' + hit.title + '"');

  const target = TITLE;

  const t1 = await runGameAction('type_text', '大肥鱼键盘测试 ABC 123', target, {}, {});
  await sleep(700);
  const ed1 = await runGameAction('edit_text', '', target, {}, {}).catch(() => null);
  const read1 = String((ed1 && ed1.text) || '');
  rec('type_text 键盘输入', /ABC 123/.test(read1), 'readback=' + JSON.stringify(read1.slice(0, 40)) + ' effect=' + (t1.effect || '?'));

  const box = await runGameAction('snapshot', '', target, {}, {}).catch(() => null);
  const els = (box && box.elements) || [];
  const editEl = els.find((e) => /edit|document/i.test(String(e.type)))
    || els.find((e) => Number.isFinite(e.x) && Number.isFinite(e.y) && e.x > 0 && e.y > 0);
  if (editEl) {
    const dbl = await runGameAction('mouse', 'double_click ' + editEl.x + ',' + editEl.y, target, {}, {});
    rec('mouse double_click', dbl.ok !== false, 'effect=' + (dbl.effect || '?') + ' via=' + (dbl.via || '-') + ' err=' + String(dbl.error || '').slice(0, 50));
    const dr = await runGameAction('mouse', 'drag ' + (editEl.x - 100) + ',' + editEl.y + ',' + (editEl.x + 100) + ',' + editEl.y + ',400', target, {}, {});
    rec('mouse drag 拖选', dr.ok !== false, 'effect=' + (dr.effect || '?') + ' via=' + (dr.via || '-'));
  } else {
    rec('mouse double_click', false, 'snapshot 没元素（' + els.length + '）');
  }

  const k1 = await runGameAction('press_key', 'ctrl+a', target, {}, {});
  await sleep(300);
  const k2 = await runGameAction('press_key', 'ctrl+c', target, {}, {});
  rec('press_key ctrl+a / ctrl+c', k1.ok !== false && k2.ok !== false, 'a=' + (k1.effect || '?') + ' c=' + (k2.effect || '?'));

  await runGameAction('press_key', 'enter', target, {}, {});
  await runGameAction('type_text', '第二行中文', target, {}, {});
  await sleep(600);
  const ed2 = await runGameAction('edit_text', '', target, {}, {}).catch(() => null);
  rec('enter + 中文输入', /第二行/.test(String((ed2 && ed2.text) || '')), 'readback=' + JSON.stringify(String((ed2 && ed2.text) || '').slice(0, 50)));

  try {
    const bmp = path.join(ROOT, '_probe', 'out', 'fullscreen-verify.bmp');
    const r = JSON.parse(execFileSync(CORE, [], {
      input: JSON.stringify({ cmd: 'screen_shot', path: bmp }),
      timeout: 15000, maxBuffer: 8 * 1024 * 1024,
    }).toString());
    const st = fs.statSync(bmp);
    rec('整屏截图', !!r.ok && st.size > 500000, r.width + '×' + r.height + ' ' + Math.round(st.size / 1024) + 'KB');
  } catch (e) {
    rec('整屏截图', false, String(e).slice(0, 80));
  }

  const byHwnd = await runGameAction('type_text', ' hwnd', String(hit.hwnd), {}, {});
  rec('focus 传 hwnd（bug#5 验证）', byHwnd.effect !== 'not_sent', 'effect=' + (byHwnd.effect || '?') + ' err=' + String(byHwnd.error || '').slice(0, 60));

  try { execFileSync('taskkill', ['/PID', String(hit.pid), '/F'], { timeout: 5000 }); } catch (e) { /* ignore */ }
  try { child.kill(); } catch (e) { /* ignore */ }

  console.log('\n--- 汇总 ---');
  const pass = results.filter((r) => r.ok).length;
  console.log('PASS ' + pass + ' / ' + results.length);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.log('ERROR', e && e.message); process.exit(2); });
