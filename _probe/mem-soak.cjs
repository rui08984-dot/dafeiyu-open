#!/usr/bin/env node
'use strict';
/**
 * mem-soak.cjs — 长时间运行采样器（内存/JS堆/句柄/线程/磁盘）+ 可复现负载
 *
 * 用法：
 *   node _probe/mem-soak.cjs [--minutes 20] [--every 30] [--load 1|0] [--tag baseline] [--eval-port 8004]
 *   例：node _probe/mem-soak.cjs --minutes 20 --tag baseline
 *       node _probe/mem-soak.cjs --minutes 20 --load 0 --tag idle
 *
 * 输出：
 *   _probe/out/mem-soak-<tag>-<stamp>/samples.jsonl   每 30s 一行原始数据
 *   _probe/out/mem-soak-<tag>-<stamp>/summary.json    逐进程起/中/末 + 斜率 + 判定
 *   _probe/out/mem-soak-<tag>-<stamp>/summary.md      人读版
 *
 * 负载（--load 1，每 tick 一轮，全程不调 LLM）：
 *   see windows → file list → contextBudget.record → setEmotion happy/neutral → subtitle show/hide
 *   每个动作前后在渲染进程内取 process.memoryUsage()/eventBus 监听数，用于归因。
 *
 * 设计约束：
 *   - /eval 每 tick 只调 1 次（30s 一次，远低于 1 次/10s 上限）
 *   - 进程表用 pwsh Get-CimInstance（只读），一次 tick 一次
 *   - 采样器自身只保留 40~200 条小对象，不做大缓冲
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_BASE = path.join(ROOT, '_probe', 'out');
fs.mkdirSync(OUT_BASE, { recursive: true });

// 单实例锁在 TAG 解析之后创建（见下方 TAG 定义后）。

// ── 参数 ────────────────────────────────────────────────────────────────────
function argOf(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] != null) return process.argv[i + 1];
  return dflt;
}
const MINUTES = Math.max(0.5, Number(argOf('minutes', '20')) || 20);
const EVERY_S = Math.max(5, Number(argOf('every', '30')) || 30);
const WITH_LOAD = String(argOf('load', '1')) !== '0';
const TAG = String(argOf('tag', 'run')).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40) || 'run';
const EVAL_PORT = Number(argOf('eval-port', '8004')) || 8004;
const MIN_UPTIME_S = Math.max(0, Number(argOf('min-uptime', '60')) || 0);
// 主进程命令行里的应用标识。默认真实宿主 live-2d；影子实例用 --app-match soak 区分。
const APP_MATCH = String(argOf('app-match', 'live-2d')).trim() || 'live-2d';
const TICKS = Math.max(2, Math.round((MINUTES * 60) / EVERY_S) + 1);

// 单实例锁（按 tag 分锁）：影子与真实宿主可同时采，同一 tag 不允许重复。
const LOCK = path.join(OUT_BASE, '.mem-soak-' + TAG + '.lock');
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}
(function acquireLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (cur && cur.pid && cur.pid !== process.pid && pidAlive(cur.pid)) {
      console.error('[mem-soak] 已有实例在跑 pid=' + cur.pid + '（tag=' + TAG + '），本次退出（避免重复负载/同一份输出）');
      process.exit(2);
    }
  } catch (e) { /* 没有锁或坏锁：继续 */ }
  try { fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8'); } catch (e) {}
})();
function releaseLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (cur && cur.pid === process.pid) fs.unlinkSync(LOCK);
  } catch (e) { /* ignore */ }
}
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(130); });
process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

const stamp = (() => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
})();
const OUT_DIR = path.join(OUT_BASE, 'mem-soak-' + TAG + '-' + stamp);
fs.mkdirSync(OUT_DIR, { recursive: true });
const SAMPLES = path.join(OUT_DIR, 'samples.jsonl');

// ── 进程快照（pwsh 助手）────────────────────────────────────────────────────
const PROC_PS1 = path.join(__dirname, 'lib', 'proc-snapshot.ps1');
function snapProcs() {
  return new Promise((resolve) => {
    execFile('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PROC_PS1],
      { windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve(null);
        try { resolve(JSON.parse(String(stdout).trim())); } catch (e) { resolve(null); }
      });
  });
}

// ── 分类 ────────────────────────────────────────────────────────────────────
function electronKind(cmd) {
  const c = String(cmd || '');
  if (/--type=crashpad-handler/.test(c)) return 'electron:crashpad';
  if (/--type=gpu-process/.test(c)) return 'electron:gpu';
  if (/--type=utility/.test(c)) {
    if (/utility-sub-type=network/.test(c)) return 'electron:utility:network';
    if (/utility-sub-type=audio/.test(c)) return 'electron:utility:audio';
    if (/utility-sub-type=tracing/.test(c)) return 'electron:utility:tracing';
    if (/utility-sub-type=storage/.test(c)) return 'electron:utility:storage';
    return 'electron:utility:other';
  }
  if (/--type=renderer/.test(c)) {
    if (/--pet-control-token=/.test(c)) return 'electron:renderer:pet';
    if (/--first-renderer-process/.test(c)) return 'electron:renderer:first';
    if (/--renderer-client-id=/.test(c)) return 'electron:renderer:other';
    return 'electron:renderer:other';
  }
  return 'electron:main-or-other';
}

function classifyAll(snapshot) {
  const procs = (snapshot && snapshot.procs) || [];
  const byPid = new Map();
  for (const p of procs) byPid.set(p.pid, p);
  const children = new Map();
  for (const p of procs) {
    const arr = children.get(p.ppid) || [];
    arr.push(p.pid);
    children.set(p.ppid, arr);
  }
  // 应用主进程：cmdline 命中 APP_MATCH，且不是 --type=*
  const appRe = new RegExp(APP_MATCH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const mains = procs.filter((p) => p.name === 'electron.exe'
    && !/--type=/.test(p.cmd || '')
    && appRe.test(p.cmd || ''));
  const main = mains.length ? mains[0] : null;
  const tree = new Set();
  if (main) {
    const stack = [main.pid];
    while (stack.length) {
      const pid = stack.pop();
      if (tree.has(pid)) continue;
      tree.add(pid);
      for (const c of children.get(pid) || []) stack.push(c);
    }
  }

  const keyOf = (p) => {
    const nm = String(p.name || '').toLowerCase();
    const cmd = p.cmd || '';
    if (nm === 'pet-core.exe') return 'pet-core';
    if (nm.startsWith('python')) {
      if (/asr_server\.py/.test(cmd)) return 'python:asr';
      if (/audio_loop_server\.py/.test(cmd)) return 'python:audio-loop';
      if (/voiceprint_server\.py/.test(cmd)) return 'python:voiceprint';
      if (/tts_server\.py/.test(cmd)) return 'python:tts(9883)';
      if (/lumen-semantic-server\.py/.test(cmd)) return 'python:lumen-semantic(8120)';
      if (/memos_api_server_v2\.py/.test(cmd)) return 'python:memos-api';
      if (/launcher\.py/.test(cmd)) return 'python:launcher';
      return 'python:other';
    }
    if (nm === 'node.exe') {
      if (/launch-my-neuro\.mjs/.test(cmd)) return 'node:launcher';
      if (!/<project-root>|_incoming[\\/]my-neuro/i.test(cmd)) return null; // 非本项目（zcode/agent1super/…）不采
      return 'node:project-other';
    }
    if (nm === 'electron.exe') {
      if (main && p.pid === main.pid) return 'electron:main';
      if (main && tree.has(p.pid)) return electronKind(cmd);
      // 影子实测实例（_probe/soak）不混进真实宿主的汇总
      if (/_probe[\\/]soak/i.test(cmd)) return null;
      if (APP_MATCH !== 'live-2d') return null;   // 影子模式：只采影子实例这一棵树
      if (/game-watch\.cjs/.test(cmd)) return 'electron:game-watch';
      return 'electron:other';
    }
    return null;
  };

  const rows = [];
  for (const p of procs) {
    const key = keyOf(p);
    if (!key) continue;
    rows.push({
      key, pid: p.pid, name: p.name,
      wsMB: +(Number(p.ws || 0) / 1048576).toFixed(1),
      privMB: +(Number(p.priv || 0) / 1048576).toFixed(1),
      handles: Number(p.handles) || 0,
      threads: Number(p.threads) || 0,
      start: p.start || '',
      cmd: String(p.cmd || '').slice(0, 300),
    });
  }
  return { mainPid: main ? main.pid : null, tree: Array.from(tree), rows };
}

// ── 磁盘快照 ────────────────────────────────────────────────────────────────
const TMP = os.tmpdir();
const PROFILE = path.join(process.env.APPDATA || '', 'combined-project');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const PETR = path.join(ROOT, 'pet-runtime');

function walkSize(target) {
  let bytes = 0; let files = 0; const stack = [target];
  while (stack.length) {
    const p = stack.pop();
    let st;
    try { st = fs.lstatSync(p); } catch (e) { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      let ents = [];
      try { ents = fs.readdirSync(p); } catch (e) { continue; }
      for (const e of ents) stack.push(path.join(p, e));
    } else if (st.isFile()) { bytes += st.size; files += 1; }
  }
  return { bytes, files };
}

function globSize(dir, re) {
  let bytes = 0; let files = 0;
  let ents = [];
  try { ents = fs.readdirSync(dir); } catch (e) { return { bytes: 0, files: 0 }; }
  for (const e of ents) {
    if (!re.test(e)) continue;
    try { const st = fs.lstatSync(path.join(dir, e)); if (st.isFile()) { bytes += st.size; files += 1; } } catch (e2) { /* skip */ }
  }
  return { bytes, files };
}

function diskSnapshot() {
  const APP = path.join(ROOT, '_incoming', 'my-neuro');
  const dirs = {
    'TEMP/pet-wgc': path.join(TMP, 'pet-wgc'),
    'TEMP/pet-ocr-cache': path.join(TMP, 'pet-ocr-cache'),
    'live-2d/.runtime': path.join(LIVE, '.runtime'),
    'my-neuro/data': path.join(APP, 'data'),
    'pet-runtime/.state': path.join(PETR, '.state'),
    'pet-runtime/data': path.join(PETR, 'data'),
    'electron-profile': PROFILE,
    '_probe/out(总)': OUT_BASE,
    '_probe/soak(影子)': path.join(ROOT, '_probe', 'soak'),
    '_probe/soak/profile': path.join(ROOT, '_probe', 'soak', 'profile'),
    '_probe/soak/data': path.join(ROOT, '_probe', 'soak', 'data'),
  };
  const out = {};
  for (const [k, p] of Object.entries(dirs)) out[k] = walkSize(p);
  out['TEMP/pet-screen-*.bmp'] = globSize(TMP, /^pet-screen-\d+\.bmp$/);
  out['TEMP/pet-frame-trace-*'] = globSize(TMP, /^pet-frame-trace-/);
  out['live-2d/runtime.log'] = globSize(LIVE, /^runtime\.log(\.\d+)?$/);
  out['pet-runtime/.state/out.log'] = globSize(path.join(PETR, '.state'), /^my-neuro\.out\.log(\.\d+)?$/);
  return out;
}

// ── /eval 负载 + 渲染进程内部统计 ───────────────────────────────────────────
function buildEvalSource() {
  const cfg = JSON.stringify({ load: WITH_LOAD, docsPath: '<project-root>/docs', port: EVAL_PORT });
  return `(async () => {
  const C = ${cfg};
  const mb = () => { try { const m = process.memoryUsage(); return { h: m.heapUsed, e: m.external, a: m.arrayBuffers, r: m.rss }; } catch (e) { return null; } };
  const ev = () => { try { const b = require('./js/core/event-bus.js').eventBus; let n = 0; const c = {}; for (const [k, v] of b.events) { if (v.length) { c[k] = v.length; n += v.length; } } return { n, c }; } catch (e) { return { n: null, err: String(e && e.message || e) }; } };
  const stat = () => {
    const o = { m: mb(), ev: ev() };
    try { o.pm = performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null; } catch (e) { o.pm = null; }
    try { const r = process.getActiveResourcesInfo ? process.getActiveResourcesInfo() : []; const c = {}; for (const x of r) c[x] = (c[x] || 0) + 1; o.res = c; o.resN = r.length; } catch (e) { o.res = null; }
    try { o.handles = process._getActiveHandles ? process._getActiveHandles().length : null; } catch (e) { o.handles = null; }
    try { o.nodes = document.querySelectorAll('*').length; } catch (e) { o.nodes = null; }
    try { o.pmgr = { plugins: global.pluginManager._plugins.size, aliases: global.pluginManager._toolAliases.size, tools: global.pluginManager.getAllTools().length }; } catch (e) { o.pmgr = null; }
    try { o.stage = global.__petBodyStage || null; } catch (e) {}
    return o;
  };
  const out = { t0: Date.now(), start: stat(), stages: [] };
  if (!C.load) { out.end = stat(); out.ms = Date.now() - out.t0; return JSON.stringify(out); }
  const mark = (k) => { const s = stat(); out.stages.push({ k, at: Date.now() - out.t0, h: s.m && s.m.h, e: s.m && s.m.e, ev: s.ev && s.ev.n }); };
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  mark('t0');
  try { const r = await global.pluginManager.executeTool('see', { mode: 'windows' }); out.seeLen = String(r || '').length; } catch (e) { out.seeErr = String(e && e.message || e).slice(0, 200); }
  mark('see');
  try { const r = await global.pluginManager.executeTool('file', { action: 'list', path: C.docsPath }); out.fileLen = String(r || '').length; } catch (e) { out.fileErr = String(e && e.message || e).slice(0, 200); }
  mark('file');
  try { const cb = require('./js/core/context-budget.js'); const msgs = []; for (let i = 0; i < 12; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: ('第' + i + '轮：').repeat(1) + 'x'.repeat(600) }); msgs.unshift({ role: 'system', content: '你是一个桌宠。'.repeat(80) }); cb.record({ messages: msgs, tools: global.pluginManager.getAllTools() }); } catch (e) { out.cbErr = String(e && e.message || e).slice(0, 200); }
  mark('contextBudget');
  try { window.petBody.setEmotion('happy'); await settle(40); window.petBody.setEmotion('neutral'); await settle(20); } catch (e) { out.emoErr = String(e && e.message || e).slice(0, 200); }
  mark('emotion');
  try { const { ipcRenderer } = require('electron'); ipcRenderer.send('subtitle:show', { text: '内存采样字幕（自动）', duration: 500 }); await settle(60); ipcRenderer.send('subtitle:hide'); await settle(40); } catch (e) { out.subErr = String(e && e.message || e).slice(0, 200); }
  mark('subtitle');
  out.end = stat();
  out.ms = Date.now() - out.t0;
  return JSON.stringify(out);
})()`;
}

async function evalApp() {
  const src = buildEvalSource();
  const body = JSON.stringify({ js: src });
  const res = await fetch('http://127.0.0.1:' + EVAL_PORT + '/eval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json();
  if (!json || json.ok !== true) throw new Error('eval failed: ' + JSON.stringify(json).slice(0, 200));
  const v = typeof json.value === 'string' ? json.value : JSON.stringify(json.value);
  return JSON.parse(v);
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
function regress(points) { // [{x:minutes, y:MB}] → slope MB/hour
  if (points.length < 2) return 0;
  let sx = 0, sy = 0, n = 0;
  for (const p of points) { sx += p.x / 60; sy += p.y; n += 1; }
  const mx = sx / n, my = sy / n;
  let num = 0, den = 0;
  for (const p of points) { const dx = p.x / 60 - mx; num += dx * (p.y - my); den += dx * dx; }
  return den === 0 ? 0 : num / den;
}

function seriesStats(points) { // [{x:minutes,y:number}]
  const vals = points.map((p) => p.y);
  const n = vals.length;
  if (!n) return null;
  const first = vals[0];
  const last = vals[n - 1];
  const mid = vals[Math.floor((n - 1) / 2)];
  let up = 0, down = 0;
  for (let i = 1; i < n; i++) {
    if (vals[i] >= vals[i - 1] - 0.05) up += 1; else down += 1;
  }
  const half = Math.floor(n / 2);
  const firstHalf = vals[Math.max(0, half - 1)] - vals[0];
  const secondHalf = vals[n - 1] - vals[Math.max(0, half - 1)];
  const slope = regress(points);
  return {
    n, first: +first.toFixed(2), mid: +mid.toFixed(2), last: +last.toFixed(2),
    min: +Math.min(...vals).toFixed(2), max: +Math.max(...vals).toFixed(2),
    growth: +(last - first).toFixed(2), slopeMBpH: +slope.toFixed(1),
    mono: +(up / Math.max(1, n - 1)).toFixed(2),
    firstHalfGrowth: +firstHalf.toFixed(2), secondHalfGrowth: +secondHalf.toFixed(2),
  };
}

function verdictFor(key, st, kind) {
  if (!st) return 'NO-DATA';
  const g = st.growth, mono = st.mono, slope = st.slopeMBpH;
  if (kind === 'rss') {
    if (g > 100 && mono >= 0.75) return 'SUSPECT';
    if (g > 40 && slope > 150 && mono >= 0.8) return 'SUSPECT-SLOPE';
    if (g > 100) return 'SPIKE(非单调)';
    if (g > 20 && slope > 40) return 'CREEP';
    if (g < -50) return 'SHRINK';
    return 'NORMAL';
  }
  if (kind === 'heap') {
    if (g > 30 && mono >= 0.7) return 'SUSPECT';
    if (g > 15 && slope > 60 && mono >= 0.75) return 'SUSPECT-SLOPE';
    if (g > 30) return 'SPIKE';
    if (g > 8 && slope > 20) return 'CREEP';
    return 'NORMAL';
  }
  return 'NORMAL';
}

// ── 主循环 ──────────────────────────────────────────────────────────────────
const samples = [];
let lastPetPid = null;
let evalFails = 0;
const restarts = [];
let epoch = 0;
let lastMainPid = null;

function fmtMB(v) { return (v == null ? '-' : String(v)) + 'MB'; }

async function tick(i) {
  const startedAt = Date.now();
  const timer = setTimeout(() => { /* 标记慢 tick */ }, 1);
  clearTimeout(timer);
  const snap = await snapProcs();
  const disk = diskSnapshot();
  let app = null; let appErr = null;
  try { app = await evalApp(); evalFails = 0; } catch (e) { appErr = String(e && e.message || e).slice(0, 300); evalFails += 1; }
  const cls = classifyAll(snap);
  const elapsedMin = +(((Date.now() - t0) / 60000).toFixed(2));
  const petRow = cls.rows.find((r) => r.key === 'electron:renderer:pet');
  // 宿主 epoch：主进程 pid 变化（或从「无」变「有」）= 新的一段。重启会把渲染进程内存重置，
  // 跨 epoch 的斜率没有意义，所以汇总里按 epoch 分开算。
  const mainChanged = i > 0 && lastMainPid !== cls.mainPid;
  if (mainChanged && cls.mainPid) epoch += 1;
  lastMainPid = cls.mainPid;
  if (mainChanged && cls.mainPid) {
    restarts.push({ atMin: elapsedMin, from: samples.length ? samples[samples.length - 1].mainPid : null, to: cls.mainPid, epoch });
    console.log('[!] 宿主主进程换了（' + (samples.length ? samples[samples.length - 1].mainPid : null) + ' → ' + cls.mainPid + '）：进入 epoch ' + epoch);
  }
  if (petRow && lastPetPid && petRow.pid !== lastPetPid && !mainChanged) {
    restarts.push({ atMin: elapsedMin, from: lastPetPid, to: petRow.pid, rendererOnly: true });
    console.log('[!] pet renderer 换了 PID（' + lastPetPid + ' → ' + petRow.pid + '）：看门狗 reload/崩溃，采样曲线会断层');
  }
  if (petRow) lastPetPid = petRow.pid;

  const rec = {
    i, t: Date.now(), iso: new Date().toISOString(), elapsedMin,
    epoch,
    freeMB: snap ? snap.freeMB : null,
    mainPid: cls.mainPid,
    hostRestarted: mainChanged,
    procs: cls.rows,
    app: app || null,
    appErr,
    disk,
  };
  samples.push(rec);
  try { fs.appendFileSync(SAMPLES, JSON.stringify(rec) + '\n', 'utf8'); } catch (e) { /* 磁盘写失败不拦采样 */ }

  const heapMB = app && app.start && app.start.m ? (app.start.m.h / 1048576).toFixed(1) : '-';
  const evN = app && app.start && app.start.ev ? app.start.ev.n : '-';
  const stages = app && app.stages ? app.stages.map((s) => s.k + ':' + (s.h ? (s.h / 1048576).toFixed(1) : '?')).join('>') : '';
  console.log(
    '[t+' + String(elapsedMin).padStart(5) + 'm] pet=' + fmtMB(petRow && petRow.wsMB)
    + ' heap=' + heapMB + 'MB ev=' + evN + ' free=' + (snap ? snap.freeMB : '?') + 'MB'
    + (app && app.ms ? ' load=' + app.ms + 'ms' : '')
    + (stages ? ' | ' + stages : '')
    + (appErr ? ' | appErr=' + appErr : '')
  );
  void startedAt;
}

let t0 = Date.now();
(async () => {
  console.log('=== mem-soak ===');
  console.log('目录: ' + OUT_DIR);
  console.log('参数: ' + TICKS + ' 点 x ' + EVERY_S + 's（约 ' + (MINUTES).toFixed(1) + ' 分钟）, load=' + (WITH_LOAD ? 'on' : 'off') + ', min-uptime=' + MIN_UPTIME_S + 's');
  console.log('负载: see windows / file list / contextBudget.record / emotion / subtitle（不调 LLM）');

  // 稳定性闸门：宿主刚重启时正在预热（插件加载/Live2D WASM/Python 模型），曲线前 2 分钟是假的。
  // 等主进程至少活过 MIN_UPTIME_S 秒再开始，避免把启动预热误判成「泄漏」。
  if (MIN_UPTIME_S > 0) {
    const deadline = Date.now() + Math.max(MIN_UPTIME_S, 0) * 1000 + 120000;
    for (;;) {
      const snap = await snapProcs();
      const cls = classifyAll(snap);
      const mainRow = cls.rows.find((r) => r.key === 'electron:main');
      // .NET 的 'o' 格式给 7 位小数秒（.7310000Z），V8 的 Date.parse 只认 3 位 → 先裁到 3 位
      const startStr = mainRow && mainRow.start ? String(mainRow.start).replace(/(\.\d{3})\d+/, '$1') : '';
      const started = startStr ? Date.parse(startStr) : 0;
      const upS = started && Number.isFinite(started) ? Math.round((Date.now() - started) / 1000) : -1;
      if (upS >= MIN_UPTIME_S) { console.log('宿主已运行 ' + upS + 's，开始采样'); break; }
      if (Date.now() > deadline) { console.log('[!] 等不到稳定宿主（当前 uptime=' + upS + 's），带风险开跑'); break; }
      console.log('等待宿主预热：uptime=' + upS + 's（需要 ' + MIN_UPTIME_S + 's）…');
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
  t0 = Date.now();

  const schedule = [];
  for (let i = 0; i < TICKS; i++) schedule.push(t0 + i * EVERY_S * 1000);
  for (let i = 0; i < TICKS; i++) {
    const wait = schedule[i] - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { await tick(i); } catch (e) { console.log('[!] tick ' + i + ' 抛错: ' + (e && e.message || e)); }
  }

  // ── 汇总 ──────────────────────────────────────────────────────────────────
  const keys = new Set();
  for (const s of samples) for (const r of s.procs) keys.add(r.key);
  const keyList = Array.from(keys).sort();

  // 分段（epoch）：宿主每次重启会重置渲染进程内存，跨 epoch 的斜率没有意义。
  // 只对点数 >=3 的段算斜率（2 点必成直线，会误导）。
  const epochRows = [];
  for (const ep of Array.from(new Set(samples.map((s) => s.epoch))).sort((a, b) => a - b)) {
    const ss = samples.filter((s) => s.epoch === ep);
    const petPts = ss.map((s) => {
      const row = s.procs.find((r) => r.key === 'electron:renderer:pet');
      return row ? { x: s.elapsedMin, y: row.wsMB } : null;
    }).filter(Boolean);
    const heapPts2 = ss.filter((s) => s.app && s.app.start && s.app.start.m).map((s) => ({ x: s.elapsedMin, y: s.app.start.m.h / 1048576 }));
    const evs = ss.filter((s) => s.app && s.app.start && s.app.start.ev).map((s) => s.app.start.ev.n);
    const row = {
      epoch: ep,
      points: ss.length,
      spanMin: +(ss[ss.length - 1].elapsedMin - ss[0].elapsedMin).toFixed(2),
      mainPid: ss[ss.length - 1].mainPid,
      petPid: (ss[ss.length - 1].procs.find((r) => r.key === 'electron:renderer:pet') || {}).pid || null,
      pet: petPts.length >= 3 ? seriesStats(petPts) : null,
      heap: heapPts2.length >= 3 ? seriesStats(heapPts2) : null,
      eventBus: evs.length ? [evs[0], evs[evs.length - 1]] : null,
      partial: petPts.length < 3,
    };
    if (row.pet) row.pet.verdict = verdictFor('pet', row.pet, 'rss');
    if (row.heap) row.heap.verdict = verdictFor('heap', row.heap, 'heap');
    epochRows.push(row);
  }

  const rss = {};
  for (const key of keyList) {
    const pts = samples.map((s) => {
      const rows = s.procs.filter((r) => r.key === key);
      return { x: s.elapsedMin, y: rows.reduce((a, r) => a + r.wsMB, 0) };
    });
    const st = seriesStats(pts);
    rss[key] = { ...st, verdict: verdictFor(key, st, 'rss') };
  }
  // 聚合
  const agg = {};
  for (const [name, pred] of Object.entries({
    'TOTAL:electron-tree': (k) => k.startsWith('electron:'),
    'TOTAL:python': (k) => k.startsWith('python:'),
    'TOTAL:project': () => true,
  })) {
    const pts = samples.map((s) => ({ x: s.elapsedMin, y: s.procs.filter((r) => pred(r.key)).reduce((a, r) => a + r.wsMB, 0) }));
    const st = seriesStats(pts);
    agg[name] = { ...st, verdict: verdictFor(name, st, 'rss') };
  }

  const heapPts = samples.filter((s) => s.app && s.app.start && s.app.start.m).map((s) => ({ x: s.elapsedMin, y: s.app.start.m.h / 1048576 }));
  const heap = heapPts.length ? { ...seriesStats(heapPts), verdict: verdictFor('renderer-heap', seriesStats(heapPts), 'heap') } : { n: 0, verdict: 'NO-DATA' };
  const perfPts = samples.filter((s) => s.app && s.app.start && s.app.start.pm).map((s) => ({ x: s.elapsedMin, y: s.app.start.pm.used / 1048576 }));
  const perfHeap = perfPts.length ? { ...seriesStats(perfPts), verdict: verdictFor('perf.memory.used', seriesStats(perfPts), 'heap') } : { n: 0, verdict: 'NO-DATA' };

  // 句柄/线程/监听器 起末
  const misc = {};
  for (const key of keyList) {
    const first = samples[0].procs.filter((r) => r.key === key);
    const lastS = samples[samples.length - 1].procs.filter((r) => r.key === key);
    if (!first.length || !lastS.length) continue;
    misc[key] = {
      handles: [first.reduce((a, r) => a + r.handles, 0), lastS.reduce((a, r) => a + r.handles, 0)],
      threads: [first.reduce((a, r) => a + r.threads, 0), lastS.reduce((a, r) => a + r.threads, 0)],
      pids: [first.map((r) => r.pid), lastS.map((r) => r.pid)],
    };
  }
  const evFirst = samples[0].app && samples[0].app.start && samples[0].app.start.ev ? samples[0].app.start.ev : null;
  const evLast = samples[samples.length - 1].app && samples[samples.length - 1].app.start && samples[samples.length - 1].app.start.ev ? samples[samples.length - 1].app.start.ev : null;

  // 负载归因：每个 stage 的 heap 增量（MB）
  const stageAgg = {};
  for (const s of samples) {
    if (!s.app || !Array.isArray(s.app.stages)) continue;
    let prev = s.app.stages[0];
    for (let i2 = 1; i2 < s.app.stages.length; i2++) {
      const cur = s.app.stages[i2];
      const d = (cur.h != null && prev.h != null) ? (cur.h - prev.h) / 1048576 : 0;
      const g = stageAgg[cur.k] || { sum: 0, n: 0, pos: 0, max: -1e9, min: 1e9 };
      g.sum += d; g.n += 1; if (d > 0) g.pos += 1;
      g.max = Math.max(g.max, d); g.min = Math.min(g.min, d);
      stageAgg[cur.k] = g;
      prev = cur;
    }
  }
  const loadStages = Object.fromEntries(Object.entries(stageAgg).map(([k, g]) => [k, {
    n: g.n, avgDeltaMB: +(g.sum / Math.max(1, g.n)).toFixed(2), posRate: +(g.pos / Math.max(1, g.n)).toFixed(2),
    maxDeltaMB: +g.max.toFixed(2), minDeltaMB: +g.min.toFixed(2),
  }]));

  const diskSummary = {};
  const firstDisk = samples[0].disk || {};
  const lastDisk = samples[samples.length - 1].disk || {};
  for (const k of Object.keys(lastDisk)) {
    const a = firstDisk[k] || { bytes: 0, files: 0 };
    const b = lastDisk[k] || { bytes: 0, files: 0 };
    diskSummary[k] = {
      startMB: +(a.bytes / 1048576).toFixed(2), endMB: +(b.bytes / 1048576).toFixed(2),
      deltaMB: +((b.bytes - a.bytes) / 1048576).toFixed(2), files: [a.files, b.files],
    };
  }

  const summary = {
    tag: TAG, minuteSpan: +((samples[samples.length - 1].t - samples[0].t) / 60000).toFixed(2),
    everySec: EVERY_S, points: samples.length, load: WITH_LOAD,
    evalFails, mainPid: samples[0].mainPid, restarts,
    polluted: restarts.length > 0,
    epochs: epochRows,
    rss, agg, heap, perfHeap, misc,
    eventBus: { first: evFirst, last: evLast },
    loadStages, disk: diskSummary,
    outDir: OUT_DIR,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  // 人读版
  const L = [];
  L.push('# mem-soak ' + TAG);
  L.push('');
  L.push('- 时间: ' + samples[0].iso + ' → ' + samples[samples.length - 1].iso + '（' + summary.minuteSpan + ' 分钟，' + samples.length + ' 点）');
  L.push('- 负载: ' + (WITH_LOAD ? 'see windows / file list / contextBudget / emotion / subtitle' : '无（静置）'));
  L.push('- 原始数据: `' + SAMPLES + '`');
  if (restarts.length) {
    L.push('- ⚠ **宿主重启 ' + restarts.length + ' 次，曲线被污染**：' + restarts.map((r) => '+ ' + r.atMin + 'min ' + r.from + '→' + r.to).join('; '));
    L.push('- 跨 epoch 的「RSS 斜率」把重启前的峰和重启后的谷连在一起，**不可用于判定**；判定看下面的分段表。');
  }
  L.push('');
  L.push('## 宿主分段（epoch；每段内才算斜率）');
  L.push('');
  L.push('| epoch | main pid | pet pid | 点数 | 跨度 min | pet 起→末 | 增长 | 斜率 MB/h | 单调 | 判定 | heap 起→末 | heap 斜率 | ev |');
  L.push('|---:|---:|---:|---:|---:|---|---:|---:|---:|---|---|---:|---|');
  for (const e of epochRows) {
    L.push('| ' + e.epoch + ' | ' + (e.mainPid || '-') + ' | ' + (e.petPid || '-') + ' | ' + e.points + ' | ' + e.spanMin
      + ' | ' + (e.pet ? e.pet.first + '→' + e.pet.last : '数据不足') + ' | ' + (e.pet ? (e.pet.growth >= 0 ? '+' : '') + e.pet.growth : '-')
      + ' | ' + (e.pet ? e.pet.slopeMBpH : '-') + ' | ' + (e.pet ? e.pet.mono : '-') + ' | ' + (e.pet ? e.pet.verdict : '-')
      + ' | ' + (e.heap ? e.heap.first + '→' + e.heap.last : '-') + ' | ' + (e.heap ? e.heap.slopeMBpH : '-')
      + ' | ' + (e.eventBus ? e.eventBus[0] + '→' + e.eventBus[1] : '-') + ' |');
  }
  L.push('');
  L.push('## RSS 斜率（按进程/角色）');
  L.push('');
  L.push('| key | 起 | 中 | 末 | 增长 | 斜率 MB/h | 单调 | 判定 |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---|');
  for (const [k, v] of Object.entries({ ...rss, ...agg })) {
    if (!v || v.n == null) continue;
    L.push('| ' + k + ' | ' + v.first + ' | ' + v.mid + ' | ' + v.last + ' | ' + (v.growth >= 0 ? '+' : '') + v.growth + ' | ' + v.slopeMBpH + ' | ' + v.mono + ' | ' + v.verdict + ' |');
  }
  L.push('');
  L.push('## JS 堆');
  L.push('');
  L.push('- process.memoryUsage().heapUsed: ' + (heap.n ? heap.first + ' → ' + heap.last + 'MB（' + (heap.growth >= 0 ? '+' : '') + heap.growth + 'MB, 斜率 ' + heap.slopeMBpH + 'MB/h, 单调 ' + heap.mono + '）→ ' + heap.verdict : '无数据'));
  L.push('- performance.memory.usedJSHeapSize: ' + (perfHeap.n ? perfHeap.first + ' → ' + perfHeap.last + 'MB（' + (perfHeap.growth >= 0 ? '+' : '') + perfHeap.growth + 'MB, 斜率 ' + perfHeap.slopeMBpH + 'MB/h）→ ' + perfHeap.verdict : '无数据'));
  L.push('- eventBus 监听器总数: ' + (evFirst ? evFirst.n : '?') + ' → ' + (evLast ? evLast.n : '?'));
  if (evFirst && evLast) {
    const keys2 = new Set([...Object.keys(evFirst.c || {}), ...Object.keys(evLast.c || {})]);
    const grew = [];
    for (const k of keys2) { const a = (evFirst.c || {})[k] || 0; const b = (evLast.c || {})[k] || 0; if (b !== a) grew.push(k + ' ' + a + '→' + b); }
    L.push('- 变化的监听器: ' + (grew.length ? grew.join('; ') : '无'));
  }
  L.push('');
  L.push('## 负载归因（每 stage 的 JS 堆增量，MB）');
  L.push('');
  L.push('| stage | 次数 | 平均增量 | 正增长占比 | 最大 | 最小 |');
  L.push('|---|---:|---:|---:|---:|---:|');
  for (const [k, v] of Object.entries(loadStages)) L.push('| ' + k + ' | ' + v.n + ' | ' + v.avgDeltaMB + ' | ' + v.posRate + ' | ' + v.maxDeltaMB + ' | ' + v.minDeltaMB + ' |');
  L.push('');
  L.push('## 句柄 / 线程 / PID');
  L.push('');
  L.push('| key | handles | threads | pid |');
  L.push('|---|---:|---:|---|');
  for (const [k, v] of Object.entries(misc)) L.push('| ' + k + ' | ' + v.handles[0] + '→' + v.handles[1] + ' | ' + v.threads[0] + '→' + v.threads[1] + ' | ' + v.pids[0].join(',') + '→' + v.pids[1].join(',') + ' |');
  L.push('');
  L.push('## 磁盘');
  L.push('');
  L.push('| 路径 | 起 MB | 末 MB | 增量 MB | 文件数 |');
  L.push('|---|---:|---:|---:|---:|');
  for (const [k, v] of Object.entries(diskSummary)) L.push('| ' + k + ' | ' + v.startMB + ' | ' + v.endMB + ' | ' + (v.deltaMB >= 0 ? '+' : '') + v.deltaMB + ' | ' + v.files[0] + '→' + v.files[1] + ' |');
  fs.writeFileSync(path.join(OUT_DIR, 'summary.md'), L.join('\n') + '\n', 'utf8');

  console.log('\n=== 结果 ===');
  for (const line of L) console.log(line);
  console.log('\n写入: ' + path.join(OUT_DIR, 'summary.json'));
  if (restarts.length) {
    console.log('\n[!] 采样期间宿主重启 ' + restarts.length + ' 次 —— 这组斜率不可用于判定泄漏，等宿主稳定后重跑');
    process.exitCode = 3;
  }
})();
