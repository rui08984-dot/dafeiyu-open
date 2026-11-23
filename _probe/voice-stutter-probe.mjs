#!/usr/bin/env node
/**
 * _probe/voice-stutter-probe.mjs —— 「她说话的时候卡」端到端测量（2026-11-22）
 *
 * 只通过 8004 /eval 在真实宿主里 monkey-patch，不改源码、不重启：
 *   · petbody frame 热路径的分段计时（updateView / model.update / physics / interaction /
 *     bodyDirector / motionDirector / expression / blend / perfFaces / captureAppearance / draw）
 *   · 口型写入：window.petBody.setMouth 的调用频率与单次成本
 *   · 观察者 rAF：间隔分布 + 长帧（>33ms）计数
 *   · 渲染循环真实频率：dragFreezeState().renderedFrames 增量（petbody 自己按 16ms 门限跑）
 *   · TTS：每段合成耗时、playAudio 起止（段间空档）、首次 'playing' 时刻
 *   · CPU：外部 pwsh 采样所有 electron 进程 CPU 总和（cores = ΔCPU/Δt）
 *
 * ⚠ rAF 是「调度器回调频率」，不是呈现帧率（见 docs/调研-透明窗口合成与桌宠性能-2026-11-22.md）。
 *    呈现帧率需要 beginFrameSubscription/GPU trace；本脚本没有它，结论里必须标注。
 *
 * 用法：
 *   node _probe/voice-stutter-probe.mjs            # 跑完整测量（约 60s）
 *   node _probe/voice-stutter-probe.mjs uninstall  # 卸载页面内补丁（恢复原函数）
 *   node _probe/voice-stutter-probe.mjs status
 * 前置：宿主已起（8004 可达）。
 */
'use strict';

import http from 'node:http';
import { spawn } from 'node:child_process';

const PROBE = process.env.PET_PROBE || 'http://127.0.0.1:8004';
const cmd = process.argv[2] || 'run';

function ev(js, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ js }), 'utf8');
    const u = new URL(PROBE + '/eval');
    const req = http.request({
      hostname: u.hostname,
      port: Number(u.port || 80),
      path: u.pathname,
      method: 'POST',
      agent: false,
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {
          return reject(new Error('8004 /eval 返回非 JSON'));
        }
        if (!j.ok) return reject(new Error(String(j.error || '').slice(0, 500)));
        resolve(j.value);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('8004 /eval 超时')); });
    req.on('error', (e) => reject(new Error('8004 /eval 不可达：' + (e && e.message || e))));
    req.end(payload);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 页面内补丁：整段是 IIFE 表达式，返回 JSON 字符串。
const PATCH_JS = String.raw`(() => {
  const pb = window.petBody;
  if (!pb || !pb.renderer) return JSON.stringify({ ok: false, error: 'petBody 未就绪' });
  if (window.__vsp && window.__vsp.installed) return JSON.stringify({ ok: true, already: true });
  const CAP = 20000;
  const S = window.__vsp = {
    installed: true, seg: {}, mouth: [], mouthGaps: [], frames: [], rafCb: [], paramDelta: [],
    skippable: 0, paramFrames: 0,
    mouthCalls: 0, speakingMouth: 0, lastMouthAt: 0,
    firstPlaying: null, awaitPlaying: 0, synth: [], playStarts: [], playEnds: [],
    winStart: 0, rendered0: 0, rafAlive: true, orig: {}, slots: [], paramSnap: null,
  };
  const push = (a, v) => { if (a.length < CAP) a.push(v); };
  const wrap = (obj, name, label) => {
    if (!obj || typeof obj[name] !== 'function') return false;
    const orig = obj[name];
    if (orig.__vspWrapped) return true;
    S.orig[label] = orig;
    S.slots.push({ obj, name, orig });
    const w = function () {
      const t0 = performance.now();
      try { return orig.apply(this, arguments); }
      finally { const d = performance.now() - t0; push(S.seg[label] || (S.seg[label] = []), d); }
    };
    w.__vspWrapped = true;
    obj[name] = w;
    return true;
  };
  const r = pb.renderer;
  S.wrapped = {
    updateView: wrap(r, 'updateView', 'updateView'),
    modelUpdate: wrap(r._model, 'update', 'model.update'),
    physics: wrap(r._physics, 'evaluate', 'physics'),
    interaction: wrap(r.interaction, 'sample', 'interaction.sample'),
    bodyDirector: wrap(r.bodyDirector, 'sample', 'bodyDirector.sample'),
    motionDirector: wrap(r.motionDirector, 'sample', 'motionDirector.sample'),
    exprUpdate: wrap(r._expressionManager, 'updateMotion', 'expr.updateMotion'),
    blend: wrap(r, 'blendParameters', 'blendParameters'),
    perfFaces: wrap(r, '_applyPerformanceFaces', '_applyPerformanceFaces'),
    captureAppearance: wrap(r, 'captureAppearance', 'captureAppearance'),
    draw: wrap(r, 'draw', 'draw'),
    syncViewport: wrap(r, 'syncViewport', 'syncViewport'),
    drawModel: wrap(r._renderer, 'drawModel', 'sdk.drawModel'),
    feather: r.feather ? wrap(r.feather, 'apply', 'feather.apply') : false,
  };
  // 整帧成本：包一层 requestAnimationFrame，记录每个回调的时长（petbody 的 frame 是长的那批）
  const origRaf = window.requestAnimationFrame.bind(window);
  S.orig['raf'] = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    return origRaf(function (ts) {
      const t0 = performance.now();
      try { return cb(ts); }
      finally { const d = performance.now() - t0; if (d > 0.01) push(S.rafCb, d); }
    });
  };
  // 参数变化量：updateView 结束后比对整表，评估「脏帧检查」在说话时能省多少帧
  const origUpdateView = r.updateView;
  r.updateView = function () {
    try { return origUpdateView.apply(this, arguments); }
    finally {
      try {
        const vals = r._model.getModel().parameters.values;
        if (S.paramSnap && S.paramSnap.length === vals.length) {
          let maxd = 0;
          for (let i = 0; i < vals.length; i += 1) {
            const d = Math.abs(vals[i] - S.paramSnap[i]);
            if (d > maxd) maxd = d;
            if (maxd > 0.0015) break;
          }
          push(S.paramDelta, maxd);
          S.paramFrames += 1;
          if (maxd < 0.0015) S.skippable += 1;
        }
        if (!S.paramSnap || S.paramSnap.length !== vals.length) S.paramSnap = new Float32Array(vals.length);
        S.paramSnap.set(vals);
      } catch (e) { /* 诊断失败不影响渲染 */ }
    }
  };
  r.updateView.__vspWrapped = true;
  // 口型写入（playback 的 analyser 每 rAF → avatarFacade → petBody.setMouth）
  const origSetMouth = pb.setMouth;
  S.orig['setMouth'] = origSetMouth;
  pb.setMouth = function (v) {
    const t0 = performance.now();
    const out = origSetMouth.call(this, v);
    push(S.mouth, performance.now() - t0);
    S.mouthCalls += 1;
    if (Number(v) > 0.02) S.speakingMouth += 1;
    const now = performance.now();
    if (S.lastMouthAt) push(S.mouthGaps, now - S.lastMouthAt);
    S.lastMouthAt = now;
    return out;
  };
  // 独立观察者 rAF（不是呈现帧率！只测调度与主线程阻塞）
  let lastRaf = performance.now();
  const loop = (ts) => { if (!S.rafAlive) return; push(S.frames, ts - lastRaf); lastRaf = ts; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  // 真的出声时刻（media 'playing' 事件；capture 能收到不冒泡的媒体事件）
  S.onPlaying = () => { if (S.awaitPlaying) { S.firstPlaying = performance.now() - S.awaitPlaying; S.awaitPlaying = 0; } };
  document.addEventListener('playing', S.onPlaying, true);
  // TTS 各段合成 + 播放起止
  const tp = window.voiceChat && window.voiceChat.ttsProcessor;
  if (tp) {
    const rh = tp.requestHandler;
    const origConv = rh && rh.convertTextToSpeech;
    if (typeof origConv === 'function') {
      rh.convertTextToSpeech = async function (text) {
        const t0 = performance.now();
        try { return await origConv.apply(this, arguments); }
        finally { push(S.synth, { ms: performance.now() - t0, chars: String(text || '').length }); }
      };
    }
    const pe = tp.playbackEngine;
    const origPlay = pe && pe.playAudio;
    if (typeof origPlay === 'function') {
      pe.playAudio = async function (blob, text) {
        push(S.playStarts, { at: performance.now(), chars: String(text || '').length });
        try { return await origPlay.apply(this, arguments); }
        finally { push(S.playEnds, { at: performance.now() }); }
      };
    }
  }
  const stat = (a) => {
    if (!a || !a.length) return null;
    const s = a.slice().sort((x, y) => x - y);
    const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
    let sum = 0; for (let i = 0; i < s.length; i++) sum += s[i];
    return { n: s.length, p50: +q(.5).toFixed(3), p95: +q(.95).toFixed(3), p99: +q(.99).toFixed(3), max: +s[s.length - 1].toFixed(3), mean: +(sum / s.length).toFixed(3) };
  };
  S.stat = stat;
  S.reset = () => {
    S.seg = {}; S.mouth.length = 0; S.mouthGaps.length = 0; S.frames.length = 0;
    S.rafCb.length = 0; S.paramDelta.length = 0; S.skippable = 0; S.paramFrames = 0;
    S.mouthCalls = 0; S.speakingMouth = 0; S.lastMouthAt = 0; S.firstPlaying = null;
    S.synth.length = 0; S.playStarts.length = 0; S.playEnds.length = 0;
    S.winStart = performance.now();
    S.rendered0 = pb.dragFreezeState ? pb.dragFreezeState().renderedFrames : 0;
    return true;
  };
  S.collect = () => {
    const dur = (performance.now() - S.winStart) / 1000;
    const out = {
      dur: +dur.toFixed(2),
      seg: {}, mouth: stat(S.mouth), mouthGaps: stat(S.mouthGaps),
      mouthCalls: S.mouthCalls, mouthCallsPerSec: +(S.mouthCalls / Math.max(0.001, dur)).toFixed(1),
      speakingMouth: S.speakingMouth,
      raf: stat(S.frames), rafCb: stat(S.rafCb), longFrames: 0, longRatio: 0,
      paramDelta: stat(S.paramDelta), skippable: S.skippable, paramFrames: S.paramFrames,
      skippableRatio: S.paramFrames ? +(S.skippable / S.paramFrames).toFixed(3) : null,
      renderedFrames: 0, renderFps: 0,
      firstPlayingMs: S.firstPlaying == null ? null : +S.firstPlaying.toFixed(1),
      synth: S.synth.slice(), playStarts: S.playStarts.slice(), playEnds: S.playEnds.slice(),
      speaking: (() => { try { return pb.snapshot().speaking; } catch (e) { return null; } })(),
    };
    let lf = 0; for (let i = 0; i < S.frames.length; i++) if (S.frames[i] > 33) lf++;
    out.longFrames = lf;
    out.longRatio = S.frames.length ? +(lf / S.frames.length).toFixed(4) : 0;
    if (pb.dragFreezeState) {
      const rf = pb.dragFreezeState();
      out.renderedFrames = rf.renderedFrames - S.rendered0;
      out.renderFps = +(out.renderedFrames / Math.max(0.001, dur)).toFixed(1);
      out.dragging = rf.dragging;
      out.frozenFrames = rf.frozenFrames;
    }
    for (const k of Object.keys(S.seg)) out.seg[k] = stat(S.seg[k]);
    return out;
  };
  S.uninstall = () => {
    S.rafAlive = false;
    try { document.removeEventListener('playing', S.onPlaying, true); } catch (e) {}
    const restored = [];
    for (const slot of (S.slots || [])) {
      try {
        if (slot.obj && slot.obj[slot.name] && slot.obj[slot.name].__vspWrapped) {
          slot.obj[slot.name] = slot.orig;
          restored.push(slot.name);
        }
      } catch (e) { /* 单个恢复失败不阻断其余 */ }
    }
    try { if (S.orig && S.orig['setMouth']) window.petBody.setMouth = S.orig['setMouth']; } catch (e) {}
    // Launcher 的 rAF 观察者会因 rafAlive=false 自行退出
    return JSON.stringify({ ok: true, restored });
  };
  return JSON.stringify({ ok: true, wrapped: S.wrapped, hasVoiceChat: !!tp });
})()`;

// 外部 CPU 采样：每 ~250ms 记一行「UTC ms 所有 electron 进程 CPU 总和(秒)」
function startCpuSampler(ms = 90000) {
  const ps = spawn('pwsh', ['-NoProfile', '-Command', `
    $end = (Get-Date).AddMilliseconds(${ms})
    while ((Get-Date) -lt $end) {
      $procs = Get-Process electron -ErrorAction SilentlyContinue
      $sum = 0.0
      if ($procs) { $sum = ($procs | Measure-Object -Property CPU -Sum).Sum }
      if ($null -eq $sum) { $sum = 0.0 }
      Write-Output ("{0} {1}" -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), $sum)
      Start-Sleep -Milliseconds 250
    }
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  ps.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      const m = line.match(/^(\d+)\s+([\d.]+)$/);
      if (m) lines.push({ at: Number(m[1]), cpu: Number(m[2]) });
    }
  });
  ps.on('error', () => {});
  return { lines, stop: () => { try { ps.kill(); } catch (e) {} } };
}

function cpuBetween(lines, t0, t1) {
  const pts = lines.filter((p) => p.at >= t0 - 400 && p.at <= t1 + 400);
  if (pts.length < 2) return null;
  const a = pts[0], b = pts[pts.length - 1];
  const dt = (b.at - a.at) / 1000;
  if (dt <= 0) return null;
  return { cores: +((b.cpu - a.cpu) / dt).toFixed(2), dt: +dt.toFixed(2), n: pts.length, delta: +(b.cpu - a.cpu).toFixed(2) };
}

const SPEAK_TEXT = '嗯，我在这儿呢。今天天气不错，要不要一起出去走走？刚才看到楼下那只橘猫又趴在窗台上晒太阳。';

async function phaseIdle(seconds) {
  await ev('window.__vsp.reset()');
  const t0 = Date.now();
  await sleep(seconds * 1000);
  const data = await ev('window.__vsp.collect()');
  return { name: `idle-${seconds}s`, t0, t1: Date.now(), data };
}

async function phaseSpeak(idx) {
  // 触发 + 立刻清零：这一窗包含首音延迟
  const t0 = Date.now();
  await ev(`void window.petSpeak(${JSON.stringify(SPEAK_TEXT)}); 'ok'`);
  await ev('window.__vsp.awaitPlaying = performance.now(); window.__vsp.reset(); true');
  await sleep(4500);
  const data = await ev('window.__vsp.collect()');
  const t1 = Date.now();
  // 等本轮说完（最多 12s），避免下一句叠在上一句上
  for (let i = 0; i < 120; i += 1) {
    const speaking = await ev('(function(){try{return window.petBody.snapshot().speaking===true}catch(e){return false}})()');
    if (!speaking) break;
    await sleep(100);
  }
  return { name: `speak-${idx}`, t0, t1, data };
}

async function phaseSpeakTail(idx) {
  // 同一次说话的后半段：检查长帧是否随累积上升
  await ev('window.__vsp.reset()');
  const t0 = Date.now();
  await sleep(4000);
  const data = await ev('window.__vsp.collect()');
  return { name: `speak-${idx}-tail`, t0, t1: Date.now(), data };
}

// ── exp：变体对照（feather 关掉 / DPR 降档），量化单项收益 ─────────────────
const VARIANTS = {
  baseline: async () => {},
  'feather-off': async () => {
    await ev('window.__vsp.orig["feather.apply"] && (window.petBody.renderer.feather.apply = function(){ return true; }); true');
  },
  'dpr-1.0': async () => {
    await ev('Object.defineProperty(window, "devicePixelRatio", { value: 1.0, configurable: true }); window.petBody.renderer.syncViewport(true); true');
  },
  'feather-off+dpr-1.0': async () => {
    await ev('window.__vsp.orig["feather.apply"] && (window.petBody.renderer.feather.apply = function(){ return true; }); Object.defineProperty(window, "devicePixelRatio", { value: 1.0, configurable: true }); window.petBody.renderer.syncViewport(true); true');
  },
  restore: async () => {
    await ev('window.__vsp.orig["feather.apply"] && (window.petBody.renderer.feather.apply = window.__vsp.orig["feather.apply"]); Object.defineProperty(window, "devicePixelRatio", { value: 1.5, configurable: true }); window.petBody.renderer.syncViewport(true); true');
  },
};

function fmtSeg(seg) {
  if (!seg) return 'n/a';
  return `n=${seg.n} p50=${seg.p50} p95=${seg.p95} max=${seg.max} mean=${seg.mean}`;
}

function printPhase(p, cpu) {
  const d = p.data;
  console.log(`\n── ${p.name} ─────────────────────────────────────────`);
  console.log(`  窗口 ${d.dur}s  speaking=${d.speaking}`);
  console.log(`  rAF(回调): ${d.raf ? d.raf.n : 0} 次  p50=${d.raf && d.raf.p50}ms p95=${d.raf && d.raf.p95}ms max=${d.raf && d.raf.max}ms`);
  console.log(`  rAF 回调内部耗时（petbody frame 是长的那批）: ${fmtSeg(d.rafCb)}`);
  console.log(`  长帧(>33ms): ${d.longFrames} 次 (${(d.longRatio * 100).toFixed(1)}%)`);
  console.log(`  渲染循环: ${d.renderedFrames} 帧 → ${d.renderFps} fps`);
  console.log(`  参数变化量(每帧 maxΔ): ${fmtSeg(d.paramDelta)}  可跳过(busy 时也能省): ${d.skippable}/${d.paramFrames} = ${d.skippableRatio == null ? 'n/a' : (d.skippableRatio * 100).toFixed(1) + '%'}`);
  console.log(`  口型写入: ${d.mouthCalls} 次 (${d.mouthCallsPerSec}/s) 成本 ${fmtSeg(d.mouth)}  间隔 p95=${d.mouthGaps && d.mouthGaps.p95}ms`);
  if (cpu) console.log(`  CPU(全部 electron): ${cpu.cores} cores（Δ${cpu.delta}s / ${cpu.dt}s）`);
  for (const k of ['updateView', 'model.update', 'physics', 'draw', 'sdk.drawModel', 'feather.apply', 'syncViewport', 'interaction.sample', 'bodyDirector.sample', 'motionDirector.sample', 'expr.updateMotion', 'blendParameters', '_applyPerformanceFaces', 'captureAppearance']) {
    if (d.seg[k]) console.log(`    ${k}: ${fmtSeg(d.seg[k])}`);
  }
  if (d.firstPlayingMs != null) console.log(`  首次出声: ${d.firstPlayingMs}ms`);
  if (d.synth && d.synth.length) console.log('  合成段: ' + d.synth.map((s) => s.ms.toFixed(0) + 'ms/' + s.chars + '字').join(', '));
  if (d.playStarts && d.playStarts.length) {
    const starts = d.playStarts.map((s) => s.at);
    const ends = d.playEnds.map((s) => s.at);
    console.log('  播放段起始(相对窗口): ' + starts.map((s) => '+' + (s - (d.playStarts[0] ? d.playStarts[0].at : s)).toFixed(0)).join(', '));
    const gaps = [];
    for (let i = 1; i < starts.length; i += 1) {
      if (ends[i - 1] != null) gaps.push(starts[i] - ends[i - 1]);
    }
    if (gaps.length) console.log('  段间空档: ' + gaps.map((g) => g.toFixed(0) + 'ms').join(', '));
  }
}

(async () => {
  if (cmd === 'status') {
    const r = await ev('JSON.stringify({ inst: !!(window.__vsp && window.__vsp.installed), now: performance.now(), speak: typeof window.petSpeak })');
    console.log(r);
    return;
  }
  if (cmd === 'uninstall') {
    const r = await ev('window.__vsp ? window.__vsp.uninstall() : JSON.stringify({ok:true,note:"未安装"})');
    console.log(r);
    return;
  }

  console.log('安装页面内探针…');
  try { await ev('(window.__vsp && window.__vsp.uninstall) ? window.__vsp.uninstall() : "none"'); } catch (e) { /* ignore */ }
  await ev('delete window.__vsp; true');
  const inst = await ev(PATCH_JS);
  console.log('  ' + inst);

  if (cmd === 'exp') {
    const order = ['baseline', 'feather-off', 'dpr-1.0', 'feather-off+dpr-1.0', 'restore'];
    const rows = [];
    for (const name of order) {
      if (name !== 'restore') {
        await VARIANTS[name]();
        await sleep(400);
        const p = await phaseSpeak(name);
        rows.push(p);
        await sleep(700);
      } else {
        await VARIANTS.restore();
        await sleep(400);
      }
    }
    for (const p of rows) printPhase(p, null);
    console.log('\n=== EXP SUMMARY ===');
    for (const p of rows) {
      const d = p.data;
      console.log(JSON.stringify({
        variant: p.name,
        renderFps: d.renderFps,
        rafP50: d.raf && d.raf.p50,
        rafCbP95: d.rafCb && d.rafCb.p95,
        longRatio: d.longRatio,
        updateP50: d.seg.updateView && d.seg.updateView.p50,
        modelP50: d.seg['model.update'] && d.seg['model.update'].p50,
        drawP50: d.seg.draw && d.seg.draw.p50,
        drawModelP50: d.seg['sdk.drawModel'] && d.seg['sdk.drawModel'].p50,
        featherP50: d.seg['feather.apply'] && d.seg['feather.apply'].p50,
      }));
    }
    await ev('window.__vsp.uninstall()');
    return;
  }
  console.log('  ' + inst);
  console.log(`  测试文本(${SPEAK_TEXT.length}字)：${SPEAK_TEXT}`);

  if (cmd === 'quick') {
    // 干净版：静止 3s + 连说 3 句（每句测 4.5s），用于验收「长帧不随时间增长」。
    const phases = [];
    phases.push(await phaseIdle(3));
    for (let i = 1; i <= 3; i += 1) {
      phases.push(await phaseSpeak(i));
      await sleep(800);
    }
    for (const p of phases) {
      const d = p.data;
      console.log(JSON.stringify({
        phase: p.name, dur: d.dur, speaking: d.speaking, dragging: d.dragging,
        renderFps: d.renderFps, rafCount: d.raf && d.raf.n, rafP50: d.raf && d.raf.p50,
        longFrames: d.longFrames, longRatio: d.longRatio,
        updateP50: d.seg.updateView && d.seg.updateView.p50,
        updateP95: d.seg.updateView && d.seg.updateView.p95,
        modelP50: d.seg['model.update'] && d.seg['model.update'].p50,
        drawP50: d.seg.draw && d.seg.draw.p50,
        featherP50: d.seg['feather.apply'] && d.seg['feather.apply'].p50,
        physicsP50: d.seg.physics && d.seg.physics.p50,
        mouthP95: d.mouth && d.mouth.p95, mouthCalls: d.mouthCalls,
        firstPlayingMs: d.firstPlayingMs,
        synth: d.synth.map((s) => Math.round(s.ms)), segGap: (d.playStarts.length > 1 ? Math.round(d.playStarts[1].at - d.playEnds[0].at) : null),
      }));
    }
    await ev('window.__vsp.uninstall()');
    return;
  }

  if (cmd === 'leak') {
    // 连续说 4 句：看堆/DOM/队列有没有随时间增长（排除累积泄漏）
    const snap = async () => ev(`(() => {
      const t = window.voiceChat && window.voiceChat.ttsProcessor;
      const pe = t && t.playbackEngine;
      let heap = null;
      try { heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10 : null; } catch (e) {}
      return JSON.stringify({
        heapMB: heap,
        domNodes: document.getElementsByTagName('*').length,
        segQ: t ? t.textSegmentQueue.length : null,
        audioQ: t ? t.audioDataQueue.length : null,
        hasAudio: !!(pe && pe.currentAudio),
        perfFaces: (window.petBody && window.petBody.renderer && window.petBody.renderer.perfFaceWeights) ? window.petBody.renderer.perfFaceWeights.size : null,
        listenersNote: 'n/a',
      });
    })()`);
    const rows = [];
    rows.push({ at: 'before', ...JSON.parse(await snap()) });
    for (let i = 1; i <= 4; i += 1) {
      await ev(`void window.petSpeak(${JSON.stringify(SPEAK_TEXT)}); 'ok'`);
      for (let k = 0; k < 150; k += 1) {
        const speaking = await ev('(function(){try{return window.petBody.snapshot().speaking===true}catch(e){return false}})()');
        if (!speaking) break;
        await sleep(100);
      }
      await sleep(1000);
      rows.push({ at: `after-${i}`, ...JSON.parse(await snap()) });
    }
    console.log(JSON.stringify(rows, null, 2));
    await ev('window.__vsp.uninstall()');
    return;
  }

  const cpu = startCpuSampler(120000);
  const phases = [];
  const choreoWasOn = await ev('window.__petChoreoOn === true');
  try {
    await sleep(1500); // 等采样器第一拍 + 页面稳定
    phases.push(await phaseIdle(3));
    phases.push(await phaseSpeak(1));
    await sleep(800);
    phases.push(await phaseSpeak(2));
    await sleep(800);
    // 对照组：关掉 choreo v1（每帧采样参数轨道 + 写一批参数）
    await ev('window.__petChoreoOn = false; true');
    await sleep(300);
    phases.push(await phaseSpeak('3-choreo-off'));
    await sleep(800);
    phases.push(await phaseSpeak('4-choreo-off'));
    await ev(`window.__petChoreoOn = ${choreoWasOn}; true`);
    await sleep(800);
    // 第 5 句：前后半段对比，检查长帧是否随时间累积
    await ev(`void window.petSpeak(${JSON.stringify(SPEAK_TEXT)}); 'ok'`);
    await ev('window.__vsp.awaitPlaying = performance.now(); window.__vsp.reset(); true');
    await sleep(4200);
    phases.push({ name: 'speak-5-first-half', t0: Date.now() - 4200, t1: Date.now(), data: await ev('window.__vsp.collect()') });
    phases.push(await phaseSpeakTail(5));
  } finally {
    await sleep(600);
    cpu.stop();
    try { await ev('window.__vsp.uninstall()'); } catch (e) { /* 宿主可能已重载 */ }
  }

  for (const p of phases) printPhase(p, cpuBetween(cpu.lines, p.t0, p.t1));

  // 摘要给上级/报告用
  const summary = {
    idle: phases.filter((p) => p.name.startsWith('idle')).map((p) => ({ renderFps: p.data.renderFps, rafP50: p.data.raf && p.data.raf.p50, rafCbP95: p.data.rafCb && p.data.rafCb.p95, longRatio: p.data.longRatio, cpu: cpuBetween(cpu.lines, p.t0, p.t1) && cpuBetween(cpu.lines, p.t0, p.t1).cores, mouthP95: p.data.mouth && p.data.mouth.p95 })),
    speak: phases.filter((p) => p.name.startsWith('speak')).map((p) => ({ name: p.name, renderFps: p.data.renderFps, rafP50: p.data.raf && p.data.raf.p50, rafCbP95: p.data.rafCb && p.data.rafCb.p95, longRatio: p.data.longRatio, cpu: cpuBetween(cpu.lines, p.t0, p.t1) && cpuBetween(cpu.lines, p.t0, p.t1).cores, mouthP95: p.data.mouth && p.data.mouth.p95, updateP95: p.data.seg.updateView && p.data.seg.updateView.p95, modelP95: p.data.seg['model.update'] && p.data.seg['model.update'].p95, skippableRatio: p.data.skippableRatio })),
  };
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
})().catch((e) => { console.error('探针失败：', e && e.message || e); process.exitCode = 1; });
