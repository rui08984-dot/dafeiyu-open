#!/usr/bin/env node
/**
 * _probe/frame-present-bench.cjs — 真实呈现帧率基线/复测（2026-11-22）
 *
 * 为什么需要：_probe/drag-perf-accept.cjs 数的是 requestAnimationFrame 回调频率。
 * 渲染被冻结时 rAF 照样 100+fps，但画面一帧都没提交给合成器 —— 那个数字不能当呈现帧率。
 * 本脚本用宿主主进程的 beginFrameSubscription 探针（window.__petFrameStats）取
 * 「真正提交给合成器的帧」的间隔分布，并在同一时间窗内同步数 rAF，两者放在一起对照。
 *
 * 用法：
 *   node _probe/frame-present-bench.cjs                 # idle/drag/speak 三项
 *   node _probe/frame-present-bench.cjs --only idle
 *   node _probe/frame-present-bench.cjs --ms 4000 --tag baseline
 *   node _probe/frame-present-bench.cjs --occluded       # 遮挡场景由外部脚本准备好前台全屏后执行
 *
 * 需要宿主（8004）与已部署的帧探针。结果写 _probe/out/frame-present-<tag>.json。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = process.env.PET_DEVTOOLS || 'http://127.0.0.1:8004';
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(name);
const DUR = Math.max(1000, Number(argOf('--ms', 3000)) || 3000);
const TAG = String(argOf('--tag', 'baseline')).replace(/[^\w.-]/g, '_');
const ONLY = argOf('--only', '');
const OUT = path.join(__dirname, 'out', 'frame-present-' + TAG + '.json');

async function evalJs(js, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + '/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ js }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (!json.ok) throw new Error('eval failed: ' + JSON.stringify(json).slice(0, 300));
    return json.value;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 单个测量 pass。mode='sub' 用 beginFrameSubscription（Electron 硬上限 30fps，
 * 只能证明「≥30fps」）；mode='trace' 用 Display::FrameDisplayed（真实 present 时间戳，
 * 能测 >30fps）。两种尺子的观测成本不同，必须分开跑，否则互相污染。
 * action 是注入到页面里的 JS（在 start 之后、计时窗口内执行）。
 */
function measureCode(action, mode) {
  const startInstrument = mode === 'trace'
    ? `let traceStart = null;
       if (ft) { try { traceStart = await ft.start(); } catch (e) { traceStart = { error: String(e && e.message || e) }; } }`
    : mode === 'cast'
      ? `let castStart = null;
         if (fc) { try { castStart = await fc.start(); } catch (e) { castStart = { error: String(e && e.message || e) }; } }`
      : `await fr.start();`;
  const stopInstrument = mode === 'trace'
    ? `let traceStats = null;
       if (ft) { try { traceStats = await ft.stop(); } catch (e) { traceStats = { error: String(e && e.message || e) }; } }`
    : mode === 'cast'
      ? `let castStats = null;
         if (fc) { try { castStats = await fc.stop(); } catch (e) { castStats = { error: String(e && e.message || e) }; } }`
      : `const stats = await fr.stop();`;
  return `(async () => {
    const fr = window.__petFrameStats;
    if (!fr) return { unsupported: 'window.__petFrameStats 缺失（宿主未部署帧探针）' };
    const ft = window.__petFrameTrace || null;
    const fc = window.__petFrameCast || null;
    if (${mode === 'trace' ? 'true' : 'false'} && !ft) return { unsupported: 'window.__petFrameTrace 缺失（宿主版本过旧）' };
    if (${mode === 'cast' ? 'true' : 'false'} && !fc) return { unsupported: 'window.__petFrameCast 缺失（宿主版本过旧）' };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 先让上一次动作的余温散掉（表情/口型平滑），再开始计时
    try { window.__pbDragging = false; document.documentElement.classList.remove('pb-dragging'); } catch (e) {}
    try { if (window.petBody && window.petBody.setMouth) window.petBody.setMouth(0); } catch (e) {}
    await sleep(400);
    ${startInstrument}
    let raf = 0;
    const t0 = performance.now();
    const tEnd = t0 + ${DUR};
    const loop = (ts) => { raf += 1; if (ts < tEnd) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    ${action}
    await sleep(${DUR} + 80);
    ${stopInstrument}
    // 收尾：无论哪一项，都把动作状态清掉
    try { window.__pbDragging = false; document.documentElement.classList.remove('pb-dragging'); } catch (e) {}
    try { if (window.petBody && window.petBody.setMouth) window.petBody.setMouth(0); } catch (e) {}
    try {
      const { ipcRenderer } = require('electron');
      // 拖动动作是 ±40 交替，偶数次净位移为 0；这里再显式对齐一次缓存
      if (window.__frameBenchMoved) ipcRenderer.send('pet:move-by', 0, 0);
      window.__frameBenchMoved = false;
    } catch (e) {}
    const elapsed = (performance.now() - t0) / 1000;
    let snap = null;
    try {
      const s = window.petBody && window.petBody.snapshot ? window.petBody.snapshot() : null;
      if (s) snap = { speaking: s.speaking === true, mouth: Number(s.mouth) || 0 };
    } catch (e) {}
    return JSON.stringify({
      mode: ${JSON.stringify(mode)},
      raf,
      rafMs: Math.round(elapsed * 1000),
      rafFps: Math.round((raf / elapsed) * 10) / 10,
      stats: typeof stats === 'undefined' ? null : stats,
      traceStats: typeof traceStats === 'undefined' ? null : traceStats,
      castStats: typeof castStats === 'undefined' ? null : castStats,
      snapshot: snap,
    });
  })()`;
}

const ACTIONS = {
  idle: '',
  drag: `
    try {
      const { ipcRenderer } = require('electron');
      window.__pbDragging = true; window.__pbDraggingAt = Date.now();
      document.documentElement.classList.add('pb-dragging');
      window.__frameBenchMoved = true;
      let n = 0;
      const iv = setInterval(() => {
        try {
          ipcRenderer.send('pet:move-by', n % 2 ? 40 : -40, 0);
          window.__pbDraggingAt = Date.now();
        } catch (e) {}
        n += 1;
      }, 16);
      setTimeout(() => clearInterval(iv), ${DUR});
    } catch (e) { return { actionError: String(e && e.message || e) }; }
  `,
  speak: `
    try {
      const body = window.petBody;
      if (!body || !body.setMouth) return { actionError: 'petBody.setMouth 不可用' };
      const iv = setInterval(() => {
        const t = performance.now();
        // 60Hz 口型驱动（模拟 TTS 音频回调的 60fps 更新），幅度 0.15~0.95
        body.setMouth(0.15 + 0.8 * Math.abs(Math.sin(t / 110)));
      }, 16);
      setTimeout(() => { clearInterval(iv); try { body.setMouth(0); } catch (e) {} }, ${DUR});
    } catch (e) { return { actionError: String(e && e.message || e) }; }
  `,
};

function row(name, subR, castR, traceR) {
  if ((!subR || subR.unsupported) && (!traceR || traceR.unsupported)) {
    return { scenario: name, unsupported: (subR && subR.unsupported) || (traceR && traceR.unsupported) };
  }
  const s = (subR && subR.stats) || {};
  const c = (castR && castR.castStats) || {};
  const t = (traceR && traceR.traceStats) || {};
  return {
    scenario: name,
    rafFps: (traceR && traceR.rafFps) != null ? traceR.rafFps : (subR && subR.rafFps),
    presentedFps: s.fps,
    frames: s.frames,
    ms: s.ms,
    p50: s.p50,
    p95: s.p95,
    p99: s.p99,
    longFrames: s.longFrames,
    longPct: s.longPct,
    maxGapMs: s.maxGapMs,
    firstFrameMs: s.firstFrameMs,
    castFps: c.fps,
    castFrames: c.frames,
    castP50: c.p50,
    castP99: c.p99,
    castLongPct: c.longPct,
    castMaxGap: c.maxGapMs,
    traceFps: t.fps,
    traceFrames: t.frames,
    traceP50: t.p50,
    traceP99: t.p99,
    traceLongPct: t.longPct,
    traceMaxGap: t.maxGapMs,
    speaking: (traceR || subR || {}).snapshot ? (traceR || subR).snapshot.speaking : null,
    error: s.error || c.error || t.error || (subR && subR.actionError) || (traceR && traceR.actionError) || null,
  };
}

function printTable(rows) {
  const cols = ['scenario', 'rafFps', 'presentedFps', 'p50', 'p99', 'longPct', 'castFps', 'castP99', 'castLongPct', 'traceFps', 'traceP99'];
  const widths = {};
  for (const c of cols) widths[c] = Math.max(c.length, ...rows.map((r) => String(r[c] == null ? '-' : r[c]).length));
  const line = (vals) => cols.map((c, i) => String(vals[i] == null ? '-' : vals[i]).padEnd(widths[c])).join('  ');
  console.log(line(cols));
  console.log(cols.map((c) => '-'.repeat(widths[c])).join('  '));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
}

(async () => {
  const list = has('--occluded') ? ['occluded'] : ['idle', 'drag', 'speak'];
  const rows = [];
  const parse = (raw) => {
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch (e) { return { unsupported: '无法解析测量结果: ' + raw.slice(0, 200) }; }
  };
  for (const name of list) {
    if (ONLY && ONLY !== name) continue;
    const action = name === 'occluded' ? '' : (ACTIONS[name] || '');
    process.stdout.write('[frame-bench] ' + name + ' … ');
    try {
      // 三把尺子分开跑：帧订阅会拷整窗位图，trace 会录全进程事件，
      // 同时开会互相污染，测到的就不是同一件事了。
      const subR = parse(await evalJs(measureCode(action, 'sub'), DUR + 30000));
      const castR = parse(await evalJs(measureCode(action, 'cast'), DUR + 45000));
      const traceR = parse(await evalJs(measureCode(action, 'trace'), DUR + 45000));
      const out = row(name, subR, castR, traceR);
      rows.push(out);
      console.log(out.unsupported
        ? ('跳过：' + out.unsupported)
        : ('sub=' + out.presentedFps + 'fps(≤30hdr)  cast=' + (out.castFps == null ? '-' : out.castFps) + 'fps  trace=' + (out.traceFps == null ? '-' : out.traceFps) + 'fps  raf=' + out.rafFps + 'fps  subP99=' + out.p99 + 'ms  castP99=' + out.castP99 + 'ms  castLong=' + out.castLongPct + '%'));
    } catch (error) {
      const out = { scenario: name, error: String(error && error.message || error) };
      rows.push(out);
      console.log('失败：' + out.error);
    }
  }
  console.log('');
  printTable(rows);
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), base: BASE, durationMs: DUR, tag: TAG, rows }, null, 2));
    console.log('\n结果已写入 ' + OUT);
  } catch (e) { console.error('写结果失败: ' + (e && e.message || e)); }
  process.exitCode = rows.some((r) => r.error) ? 1 : 0;
})().catch((e) => {
  console.error('[frame-bench] 异常：' + (e && e.stack || e));
  process.exitCode = 1;
});
