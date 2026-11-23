#!/usr/bin/env node
/**
 * _probe/mobile-emulate.mjs —— 手机真机仿真（3003 遥控 / 3004 直播台）
 *
 * 没有真手机也能锁住三类问题：viewport/DPI、横向溢出、触摸（真 touch 事件路径）、
 * 画框语言（圆角/毛玻璃）。用本机 Chrome headless + CDP 设备仿真：
 *   390×844 @ DPR 3 + touch emulation（接近主流安卓机）
 *
 * 断言：
 *   ① DPR=3、无横向滚动
 *   ② .card / button / textarea / input 圆角 ≤3.5px、无毛玻璃
 *   ③ 触摸注入真的能聚焦输入框（touchStart/touchEnd → activeElement）
 *   ④ 触摸目标尺寸统计（<32px 算失败；<44px 报告数量）
 * 截图存 _probe/shots-mobile/<page>.png（1170×2532，肉眼复核）
 *
 * 用法：node _probe/mobile-emulate.mjs [--shots]   # --shots 才落截图
 * 退出码：0 全过 / 1 失败 / 0 SKIP（Chrome 缺失或端口不通）
 */
'use strict';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || 'chrome';
const PORT = 9333;
const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(PROBE_DIR, 'shots-mobile');
const WANT_SHOTS = process.argv.includes('--shots');
const PAGES = [
  { name: '3003-remote', url: 'http://127.0.0.1:3003/', focus: '#say', token: true },
  { name: '3004-live', url: 'http://127.0.0.1:3004/', focus: '#say-input' },
];
const TOKEN_FILE = path.join(PROBE_DIR, '..', '_incoming', 'my-neuro', 'data', '遥控令牌.txt');

let pass = 0, fail = 0;
const check = (n, ok, d) => {
  if (ok) { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPort(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch (e) { /* retry */ }
    await sleep(200);
  }
  return null;
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(new Error('ws error'));
    });
    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        const list = this.events.get(msg.method);
        if (list) list.splice(0).forEach((fn) => fn(msg.params));
      }
    };
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method, timeoutMs = 15000) {
    return new Promise((res, rej) => {
      const list = this.events.get(method) || [];
      const timer = setTimeout(() => rej(new Error('timeout ' + method)), timeoutMs);
      const fn = (params) => { clearTimeout(timer); res(params); };
      list.push(fn);
      this.events.set(method, list);
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval exception');
  return r.result.value;
}

const INSPECT_JS = `(() => {
  const radiusOk = (v) => !v || v === '0px' || (!v.includes('%') && (v.match(/([\\d.]+)px/g) || []).every((n) => parseFloat(n) <= 3.5));
  const seen = (sel) => Array.from(document.querySelectorAll(sel)).slice(0, 3);
  const facts = {};
  for (const sel of ['.card', 'button', 'textarea', 'input', '.badge-tag', '.bar']) {
    const els = seen(sel);
    if (!els.length) continue;
    const cs = getComputedStyle(els[0]);
    facts[sel] = { radius: cs.borderRadius, backdrop: cs.backdropFilter || 'none', count: document.querySelectorAll(sel).length };
  }
  const small = [];
  const all = Array.from(document.querySelectorAll('button, a, input, textarea, select, [role="button"]'));
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.width < 32 || r.height < 32) small.push({ tag: el.tagName, id: el.id, w: Math.round(r.width), h: Math.round(r.height) });
  }
  const under44 = all.filter((el) => { const r = el.getBoundingClientRect(); return (r.width > 0 || r.height > 0) && (r.width < 44 || r.height < 44); }).length;
  return {
    dpr: window.devicePixelRatio,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    facts, small, under44, totalInteractive: all.length,
    viewportMeta: (document.querySelector('meta[name=viewport]') || {}).content || '(none)',
    pointerCoarse: matchMedia('(pointer: coarse)').matches,
  };
})()`;

async function runPage(cdp, page) {
  console.log(`\n[${page.name}] ${page.url}${page.token ? '?t=***' : ''}`);
  const url = page.token && page._token ? page.url + '?t=' + encodeURIComponent(page._token) : page.url;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    screenWidth: 390, screenHeight: 844,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const loaded = cdp.once('Page.loadEventFired', 20000);
  await cdp.send('Page.navigate', { url });
  await loaded.catch(() => {});
  await sleep(1200); // 让页面 JS 初始化/轮询首帧

  const f = await evaluate(cdp, INSPECT_JS);
  check(`${page.name} DPR=3`, f.dpr === 3, 'dpr=' + f.dpr);
  check(`${page.name} 无横向溢出`, f.scrollWidth <= f.clientWidth + 1, `scroll ${f.scrollWidth} / client ${f.clientWidth}`);
  check(`${page.name} 视口=390×844`, f.innerWidth === 390 && f.innerHeight === 844, `${f.innerWidth}×${f.innerHeight}`);

  for (const [sel, v] of Object.entries(f.facts)) {
    check(`${page.name} ${sel} 圆角≤3px`, (() => {
      if (!v.radius || v.radius === '0px') return true;
      if (v.radius.includes('%')) return false;
      return (v.radius.match(/([\d.]+)px/g) || []).every((n) => parseFloat(n) <= 3.5);
    })(), v.radius);
    check(`${page.name} ${sel} 无毛玻璃`, !v.backdrop || v.backdrop === 'none', v.backdrop);
  }
  check(`${page.name} 无过小触摸目标(<32px)`, f.small.length === 0, f.small.length ? JSON.stringify(f.small.slice(0, 4)) : `共 ${f.totalInteractive} 个交互元素`);
  if (f.pointerCoarse) {
    check(`${page.name} 触摸目标≥44px（pointer:coarse）`, f.under44 === 0, `${f.under44}/${f.totalInteractive} 偏小`);
  } else {
    console.log(`    · 注：仿真环境未报告 pointer:coarse，44px 规则未生效（真机才会命中）`);
  }

  if (page.token && page._token) {
    const conn = await evaluate(cdp, `(() => { const el = document.getElementById('conn'); return el ? el.textContent : ''; })()`);
    check(`${page.name} 带令牌打开 → 不显示鉴权失败`, !/鉴权失败/.test(conn), (conn || '').trim());
  }

  if (WANT_SHOTS) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(OUT_DIR, page.name + '.png'), Buffer.from(shot.data, 'base64'));
    console.log(`    · 截图 ${path.join(OUT_DIR, page.name + '.png')}`);
  }

  // 触摸注入：先滚到视口内（真机上用户也会先滑），再 tap 输入框 → 应聚焦
  const box = await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(page.focus)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, vh: window.innerHeight };
  })()`);
  if (!box) {
    check(`${page.name} 触摸目标存在 ${page.focus}`, false, 'DOM 里找不到');
  } else {
    const pt = { x: Math.round(box.x), y: Math.round(box.y), radiusX: 8, radiusY: 8, force: 1, id: 1 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
    await sleep(60);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(250);
    const active = await evaluate(cdp, 'document.activeElement && (document.activeElement.id || document.activeElement.tagName)');
    check(`${page.name} 触摸 tap 能聚焦输入框`, active === page.focus.slice(1), `activeElement=${active} @y=${Math.round(box.y)}/${box.vh}`);
  }

  // 滚动后的下半页也留一张（3004 的内容在折叠线以下）
  if (WANT_SHOTS) {
    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(OUT_DIR, page.name + '-scrolled.png'), Buffer.from(shot2.data, 'base64'));
  }
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.log('SKIP 手机仿真 — 没找到 Chrome');
    process.exit(0);
  }
  // 端口探活：3003/3004 至少一个通（不用 AbortSignal.timeout：Windows 退出期会触发 libuv 断言）
  const tryFetch = async (url, ms) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    if (t.unref) t.unref();
    try { return await fetch(url, { signal: ac.signal }); }
    finally { clearTimeout(t); }
  };
  let anyUp = false;
  for (const p of PAGES) {
    try { const r = await tryFetch(p.url, 2500); if (r.ok) anyUp = true; } catch (e) {}
  }
  if (!anyUp) { console.log('SKIP 手机仿真 — 3003/3004 都没起'); process.exit(0); }

  let token = '';
  try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { /* 没有令牌就按未鉴权看 */ }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'petbody-mobile-probe-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let cdp = null;
  try {
    const ver = await waitPort(15000);
    if (!ver) { console.log('SKIP 手机仿真 — Chrome 调试口没起来'); process.exit(0); }

    for (const page of PAGES) {
      page._token = token;
      // 每页新开 target，避免互相污染
      const newTarget = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
      cdp = new CDP(newTarget.webSocketDebuggerUrl);
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      try {
        await runPage(cdp, page);
      } finally {
        cdp.close();
        await fetch(`http://127.0.0.1:${PORT}/json/close/${newTarget.id}`).catch(() => {});
      }
    }
  } finally {
    try { chrome.kill(); } catch (e) {}
    await sleep(600);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n' + '─'.repeat(52));
  console.log(`PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('探针异常：', e && e.stack || e);
  process.exit(1);
});
