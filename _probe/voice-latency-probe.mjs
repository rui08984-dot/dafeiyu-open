#!/usr/bin/env node
/**
 * _probe/voice-latency-probe.mjs —— 全双工语音首响量法（T0→T7）
 *
 * 背景：`⏱️ 首音` 日志的起点是 ttsProcessor.reset()（LLM 请求发出前一刻），
 * 天然漏掉 VAD 静音、客户端二次静音、ASR、合并窗口 —— 恰好是最该优化的前四段。
 * 本探针不改生产代码，只通过 8004 /eval 在真实宿主窗口里 monkey-patch 现有函数，
 * 每轮语音把 T0→T7 的绝对时间戳挂到 `window.__voiceLat`。
 *
 * ── 指标定义（全部 Date.now() 毫秒，避免 performance.now 混用）────────────────
 *   T0  客户端收到服务端 VAD EOS（{type:'vad', is_speech:false}，已含服务端 250ms 静音）
 *   T1  ASRProcessor.finishRecording 入口（客户端开始收尾录音）
 *   T2  ASRProcessor.processRecording 返回（ASR 文本拿到，含回调）
 *   T3  InputRouter.handleVoiceInput 调用（合并窗口结束，真正提交 LLM）
 *   T4  首个 LLM token 进入 TTS（ttsProcessor.addStreamingText 首次调用；
 *       llm-handler 在首 token 时同时记 firstTokenAt/firstTtsAt，见 llm-handler.js:539-540,585-587）
 *   T5  首个 TTS 文本段入队（requestHandler._pushSegment 首次 push）
 *   T6  TTS 响应头到达客户端（fetch resolve = headers 到；不是整段 blob 完成）
 *   T7  真正出声（HTMLMediaElement 的 'playing' 事件，首段即首响）
 *
 *   派生指标：
 *     endpointing_ms   = T1 - T0   客户端二次静音（加 250ms 才是“从真实说完起算”）
 *     asr_ms           = T2 - T1
 *     merge_ms         = T3 - T2   合并窗口
 *     llm_ttft_ms      = T4 - T3   首个 token 到 TTS（≈LLM TTFT）
 *     seg_ms           = T5 - T4   首段成段等待
 *     tts_ttfb_ms      = T6 - T5   TTS 首包（headers）
 *     playout_ms       = T7 - T6   首包到出声
 *     llm_plus_tts_ms  = T7 - T3
 *     first_audible_ms = T7 - T0   首响；加 250ms = 从真实说完起算
 *
 * ── 反作弊（必须遵守，否则数字没有意义）──────────────────────────────────────
 *   1. **不许**拿 `⏱️ 首音` 日志当基线/战果：它的起点在 LLM 请求附近，漏掉 T0-T2、
 *      也漏掉合并窗口，天然少 2.5s+。本探针一律从 T0（客户端收到 VAD EOS）起算。
 *   2. `first_audible_ms` 以 `playing` 事件为准，不以“音频入队/开始播放调用”为准。
 *   3. T6 是响应头到达（首字节级），不是 `await response.blob()` 完成；这正好暴露
 *      改造 2（流式播放）之前的“等整段”成本。
 *   4. 不自动说话、不伪造 turn。没采到就报 0 轮，不许用估算值填充。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────────
 *   node _probe/voice-latency-probe.mjs install     # 注入，留下 window.__voiceLat
 *   node _probe/voice-latency-probe.mjs dump        # 读当前 turns，输出 p50/p90/max JSON
 *   node _probe/voice-latency-probe.mjs dump --raw  # 附带每轮原始时间戳
 *   node _probe/voice-latency-probe.mjs status      # 只看已装/未装
 *
 *   采数流程：install → 人工/其他工具触发一轮真实语音（VAD 自动模式，或 PTT）→ dump。
 *   ⚠ WebSocket 重连会重建 onmessage，patch 随之失效：重连后重新 install 一次。
 *   前置：宿主已起（8004 可达）。
 */
'use strict';

import http from 'node:http';

const PROBE = process.env.PET_PROBE || 'http://127.0.0.1:8004';
const cmd = process.argv[2] || 'status';
const wantRaw = process.argv.includes('--raw');

function ev(js, timeoutMs = 30000) {
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
        if (!j.ok) return reject(new Error(String(j.error || '').slice(0, 400)));
        resolve(j.value);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('8004 /eval 超时')); });
    req.on('error', (e) => reject(new Error('8004 /eval 不可达：' + (e && e.message || e))));
    req.end(payload);
  });
}

// 注入到宿主窗口的补丁。整段是一个 IIFE 表达式，返回 JSON 字符串。
const PATCH_JS = String.raw`(() => {
  const L = window.__voiceLat = window.__voiceLat || { turns: [], aborted: [], installedAt: 0, version: 3 };
  L.turns = L.turns || [];
  L.aborted = L.aborted || [];
  L.interrupts = L.interrupts || 0;
  L.bargeChecks = L.bargeChecks || 0;
  L.speechActivity = L.speechActivity || 0;
  if (L._installed) return JSON.stringify({ ok: true, already: true, turns: L.turns.length });

  const vc = window.voiceChat;
  const ap = vc && vc.asrProcessor;
  const tp = vc && vc.ttsProcessor;
  const ir = vc && vc.inputRouter;
  if (!ap || !tp) return JSON.stringify({ ok: false, error: 'voiceChat/asrProcessor/ttsProcessor 未就绪' });
  if (!ap.ws) return JSON.stringify({ ok: false, error: 'VAD WebSocket 未建立（asrProcessor.ws 为空）' });

  const now = () => Date.now();
  const markTurn = (k) => { const c = L.cur; if (c && !c[k]) c[k] = now(); };
  const finishTurn = (reason) => {
    const c = L.cur;
    if (!c) return;
    if (reason) c.aborted = reason;
    if (c.t0 && c.t7) L.turns.push(c); else L.aborted.push(c);
    L.cur = null;
  };

  // ── T0 / 误切统计：VAD EOS 开启一轮；1s 内又开口记 reopened ────────────
  const origOnMsg = ap.ws.onmessage;
  ap.ws.onmessage = function (ev) {
    try {
      const d = JSON.parse(ev.data);
      if (d && d.type === 'vad' && d.is_speech === false) {
        // 上一轮还没等到出声就被新 EOS 顶掉 → 记为未完成，不丢
        if (L.cur) finishTurn('new_eos');
        L.cur = { t0: now(), reopened: 0 };
      } else if (d && d.type === 'vad' && d.is_speech === true) {
        if (d.speech_activity) L.speechActivity += 1;
        if (L.cur && L.cur.t0 && !L.cur.t7 && (now() - L.cur.t0) < 1000) L.cur.reopened = 1;
      }
    } catch (_) { /* 非 JSON 帧忽略 */ }
    return origOnMsg && origOnMsg.call(this, ev);
  };

  // ── T1：开始收尾录音 ───────────────────────────────────────────────────
  const origFinish = ap.finishRecording.bind(ap);
  ap.finishRecording = async function (...a) { markTurn('t1'); return origFinish(...a); };

  // ── T2：ASR 文本返回（包返回值比 onSpeechRecognized 稳）─────────────────
  const origRec = ap.processRecording.bind(ap);
  ap.processRecording = async function (...a) { const r = await origRec(...a); markTurn('t2'); return r; };

  // ── T3：合并窗口结束 → 提交 LLM ────────────────────────────────────────
  if (ir && typeof ir.handleVoiceInput === 'function') {
    const origHandle = ir.handleVoiceInput.bind(ir);
    ir.handleVoiceInput = async function (...a) { markTurn('t3'); return origHandle(...a); };
  }

  // ── T4 / T5：首 token 进入 TTS、首段文本入队 ───────────────────────────
  if (typeof tp.addStreamingText === 'function') {
    const origAdd = tp.addStreamingText.bind(tp);
    tp.addStreamingText = function (...a) { markTurn('t4'); return origAdd(...a); };
  }
  const rh = tp.requestHandler;
  if (rh && typeof rh._pushSegment === 'function') {
    const origPush = rh._pushSegment.bind(rh);
    rh._pushSegment = function (queue, segment) {
      if (Array.isArray(queue) && queue.length === 0) markTurn('t5');
      return origPush(queue, segment);
    };
  }

  // ── T6：TTS 响应头到达（不是整段 blob 完成）────────────────────────────
  if (!L._fetchPatched) {
    L._fetchPatched = true;
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = String(typeof input === 'string' ? input : (input && input.url) || '');
      const p = origFetch.apply(this, arguments);
      if (!/\/tts\b|\/tts\?|:9883\//.test(url)) return p;
      return p.then((res) => { markTurn('t6'); return res; });
    };
  }

  // ── T7：真正出声（首段 playing 即首响）──────────────────────────────────
  if (!L._playPatched) {
    L._playPatched = true;
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...a) {
      // 只认 T3 之后、本轮尚未出声的那次 play，避免 UI 音效/前一轮残响
      if (L.cur && L.cur.t3 && !L.cur.t7 && !L.cur._hooked) {
        L.cur._hooked = true;
        this.addEventListener('playing', () => {
          if (!L.cur || L.cur.t7) return;
          L.cur.t7 = now();
          finishTurn();
        }, { once: true });
      }
      return origPlay.apply(this, a);
    };
  }

  L._installed = true;
  L._installedAt = now();
  L.installedAt = L._installedAt;
  return JSON.stringify({ ok: true, already: false, ws: !!ap.ws, ptt: !!ap.pttModeEnabled });
})()`;

function pct(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return { n: v.length, p50: pct(v, 0.5), p90: pct(v, 0.9), max: v[v.length - 1], min: v[0] };
}

function summarize(turns) {
  const fields = {
    endpointing_ms: (t) => t.t1 && t.t0 ? t.t1 - t.t0 : null,
    asr_ms: (t) => t.t2 && t.t1 ? t.t2 - t.t1 : null,
    merge_ms: (t) => t.t3 && t.t2 ? t.t3 - t.t2 : null,
    llm_ttft_ms: (t) => t.t4 && t.t3 ? t.t4 - t.t3 : null,
    seg_ms: (t) => t.t5 && t.t4 ? t.t5 - t.t4 : null,
    tts_ttfb_ms: (t) => t.t6 && t.t5 ? t.t6 - t.t5 : null,
    playout_ms: (t) => t.t7 && t.t6 ? t.t7 - t.t6 : null,
    llm_plus_tts_ms: (t) => t.t7 && t.t3 ? t.t7 - t.t3 : null,
    first_audible_ms: (t) => t.t7 && t.t0 ? t.t7 - t.t0 : null,
  };
  const out = { turns: turns.length, metrics: {}, missing: {} };
  for (const [name, fn] of Object.entries(fields)) {
    const vals = turns.map(fn);
    out.metrics[name] = stats(vals);
    out.missing[name] = vals.filter((x) => x === null).length;
  }
  return out;
}

(async () => {
  if (cmd === 'install') {
    const raw = await ev(PATCH_JS);
    let r = null;
    try { r = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { r = { ok: false, error: '返回无法解析: ' + String(raw).slice(0, 200) }; }
    console.log(JSON.stringify(r, null, 2));
    process.exit(r && r.ok ? 0 : 1);
  }

  if (cmd === 'status' || cmd === 'dump') {
    const raw = await ev(`JSON.stringify(window.__voiceLat ? {
      installed: !!window.__voiceLat._installed,
      installedAt: window.__voiceLat.installedAt || 0,
      turns: window.__voiceLat.turns || [],
      aborted: (window.__voiceLat.aborted || []).length,
      cur: window.__voiceLat.cur || null,
      interrupts: window.__voiceLat.interrupts || 0,
      bargeChecks: window.__voiceLat.bargeChecks || 0,
      speechActivity: window.__voiceLat.speechActivity || 0
    } : null)`);
    let s = null;
    try { s = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { s = null; }

    if (cmd === 'status') {
      if (!s) { console.log('未安装（window.__voiceLat 不存在）。先跑 install。'); process.exit(1); }
      console.log(JSON.stringify({ installed: s.installed, turns: s.turns.length, aborted: s.aborted, interrupts: s.interrupts, bargeChecks: s.bargeChecks, speechActivity: s.speechActivity, cur: s.cur }, null, 2));
      process.exit(s.installed ? 0 : 1);
    }

    if (!s || !s.installed) {
      console.error('未安装或窗口已重载：window.__voiceLat 不存在。先跑 install。');
      process.exit(1);
    }
    const result = {
      probe: 'voice-latency',
      at: new Date().toISOString(),
      installedAt: s.installedAt ? new Date(s.installedAt).toISOString() : null,
      counters: { interrupts: s.interrupts, bargeChecks: s.bargeChecks, speechActivity: s.speechActivity },
      abortedTurns: s.aborted,
      incompleteCurrent: s.cur ? { hasT0: !!s.cur.t0, hasT7: !!s.cur.t7, reopened: s.cur.reopened || 0 } : null,
      ...summarize(s.turns),
    };
    if (wantRaw) result.rawTurns = s.turns;
    console.log(JSON.stringify(result, null, 2));
    process.exit(s.turns.length ? 0 : 2);
  }

  console.error('用法：node _probe/voice-latency-probe.mjs install|dump|status [--raw]');
  process.exit(1);
})().catch((e) => {
  console.error('探针失败：' + (e && e.message || e));
  process.exit(1);
});
