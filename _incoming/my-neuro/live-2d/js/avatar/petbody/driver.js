// petbody/driver.js —— 用我们自己的 Cubism5 身体替换 my-neuro 的 live2d 渲染栈。
// 只实现 avatar-facade 约定的方法：init / dispose / setEmotion / setMouth / playMotion / getModel / getController。
//
// task-8：情绪与「语义动作意图」的桥接（参数级编舞不接，见 actions-bridge.js 顶部诊断）。
//   - 情绪：<开心> → 我们 presets 的表情（＞＜），并做一次对应动作；
//   - 动作：（挥手）/[wave] → motion-vocab 动作；
//   - 诊断：把 paramDirector / live2dRuntime / motionDirector 的存在性写进 petbody-debug.log，
//     证明「petbody 下 motion-director 没有参数可写」这件事，而不是靠猜。
const __silentAudit = require('../../core/silent-audit.js');
const { logToTerminal } = require("../../api-utils.js");
const { createEmotionBridge } = require("./actions-bridge.js");
// 12 段场景台词单一真源（2026-11-25 P3b）：以前这里和 js/ui/ui-controller.js
// 各写一份只有 6 段的硬编码表，另外 6 段点了不出字幕。现在两边 require 同一份。
const { SCENE_LINES: SCENE_HINT } = require('../../core/scene-lines.js');

// 「一起看」耳朵的暂停开关：她自己说话时不能录，
// 否则回环会把她的 TTS 录进去，再被识别成「用户在说话」——自激。
// 把「用户和我互动了」告诉宿主，宿主用它重置「空闲主动说话」的计时器。
// 不接的话会出现「刚被摸完头，转头就被她主动搭话」——很吵。
const interactionTick = (() => {
  let bus = null, Events = null;
  try {
    const ev = require("../../../js/core/event-bus.js");
    const evs = require("../../../js/core/events.js");
    bus = ev && ev.eventBus;
    Events = evs && evs.Events;
  } catch (e) { try { __silentAudit.audit('driver.js:23', e); } catch (e2) {} }
  let last = 0;
  return (reason) => {
    const now = Date.now();
    if (now - last < 1200) return;      // 节流，避免拖拽时每帧都发
    last = now;
    try { bus && Events && bus.emit(Events.INTERACTION_UPDATED, { source: "petbody", reason }); } catch (e) { try { __silentAudit.audit('driver.js:29', e); } catch (e2) {} }
  };
})();

// ── 渲染健康哨兵（2026-11-13）─────────────────────────────────────────────────
// 为什么要有它：渲染器有三条诊断（param-conflict / shadow-target /
// expression-owned-skip），原来只往 petbody-debug.log 写一行、还被截到 220 字。
// 「只写日志」= 等于没有告警——出了抢写没人知道，除非有人去 grep（§27 铁律：
// 失败路径必须发声）。这里把它们聚合成一个健康快照，搭 installSayBridge 已有的
// inner WS 送到 8103 的 /state，doctor 直接读结构化字段判红。
//
// 判据照 2026-11-13 实测基线，不是拍脑袋：
//   · param-conflict      = 0        （同帧同参数差值 >0.02 = 两层真在抢写 → 红）
//   · byKind.output       = 0        （ShoulderY / ShoulderZ 两处白写已在 2026-11-13 删掉，
//                                      基线归 0 —— 以后再出现白写就是新问题，不是「已知」）
//   · expression-owned-skip = 3      （表情预设让位给情绪层，是这个数就正常，只展示不判）
const WASTED_OUTPUT_BASELINE = 0;
const renderDiag = {
  frames: 0,            // 渲染器累计帧号
  samples: 0,           // 收到多少次 shadow-target 采样
  conflictFrames: 0,    // 累计发生过抢写的帧数（只作展示）
  lastConflictAt: 0,    // 最近一次抢写的时间 —— 判红看这个，不看累计值
  conflicts: [],        // 最近一次冲突明细
  wastedOutput: 0,      // 当前纯物理输出白写个数
  wastedIds: [],        // 白写的是哪几个
  skipped: null,        // 表情预设让位的参数数（正常 3）
  at: 0,                // 最近一次更新
};
let innerWs = null;             // installSayBridge 建的到 8102 的通道
let renderHealthSentAt = 0;

function publishRenderHealth(force) {
  try {
    if (!innerWs || innerWs.readyState !== 1) return;
    const now = Date.now();
    // 5 秒节流：shadow-target 本身就是 5 秒一采，不节流只是白占通道
    if (!force && now - renderHealthSentAt < 5000) return;
    renderHealthSentAt = now;
    const health = {
      // ⚠ 判红看「最近 30 秒内有没有抢写」，不看累计值：
      //   渲染器的 _conflictFrames 在无冲突帧会自行清零，但清零不产生 report，
      //   累计值一旦变正就再也不会被 driver 侧知道已经好了 —— 那会变成永久红（狼来了）。
      //   阴影每 5 秒一采，30 秒的窗口足够「确实发生过且还在发生」而不误报历史。
      ok: (now - renderDiag.lastConflictAt >= 30000) && renderDiag.wastedOutput <= WASTED_OUTPUT_BASELINE,
      conflict: (now - renderDiag.lastConflictAt) < 30000,
      wastedOver: renderDiag.wastedOutput > WASTED_OUTPUT_BASELINE,
      wastedBaseline: WASTED_OUTPUT_BASELINE,
      ...renderDiag,
    };
    innerWs.send(JSON.stringify({ type: 'render-health', health }));
  } catch (e) { try { __silentAudit.audit('driver.js:renderHealth', e); } catch (e2) {} }
}

function noteRenderReport(event) {
  if (!event || !event.type) return;
  if (event.type === 'shadow-target') {
    renderDiag.frames = Number(event.frame) || renderDiag.frames;
    renderDiag.samples += 1;
    renderDiag.wastedOutput = Number(event.byKind && event.byKind.output) || 0;
    renderDiag.wastedIds = Array.isArray(event.wasted) ? event.wasted.slice(0, 6) : [];
    renderDiag.at = Date.now();
    publishRenderHealth(false);
  } else if (event.type === 'param-conflict') {
    renderDiag.conflictFrames = Number(event.frames) || (renderDiag.conflictFrames + 1);
    renderDiag.lastConflictAt = Date.now();
    renderDiag.conflicts = Array.isArray(event.top) ? event.top.slice(0, 4) : [];
    renderDiag.at = Date.now();
    publishRenderHealth(true);    // 抢写是真问题，不等节流
  } else if (event.type === 'expression-owned-skip') {
    renderDiag.skipped = Number(event.skipped);
    renderDiag.at = Date.now();
    publishRenderHealth(false);
  }
}

// ── 持久心情 ────────────────────────────────────────────────────────────────
// 情绪是「这一秒的脸」，心情是「这几天的心气」。
// 没有它，每次重启她都回到一张白纸的心气；有了它，昨天被晾了一晚上，
// 今天开口会带点没睡好的味道。
const moodStore = {
  path: null,
  score: 0,          // -1（很丧）… +1（很爽）
  updatedAt: 0,
  dirtyAt: 0,
  // 情绪 → 心情增量。只用心明确的几种，别硬凑。
  delta: { happy: 0.22, smug: 0.16, tease: 0.10, shy: 0.08, surprise: 0.02, neutral: 0, bored: -0.06, sleepy: -0.10, sad: -0.22, aggrieved: -0.18, angry: -0.26, guilty: -0.08 },
  // 情绪记忆：不是记"她难过过"，而是记"因为什么+多久了"。
  // 一条伤人的话会按 ~30 小时半衰影响后面的心气，所以第二天她还会有点别扭 ——
  // 这是「可信陪伴」和「每次重置的人设」最本质的区别。
  wounds: [],
  init(recordsDir) {
    try { this.path = require('path').join(recordsDir, '心情.json'); } catch (e) { return; }
    try {
      const raw = JSON.parse(require('fs').readFileSync(this.path, 'utf8'));
      this.score = Math.max(-1, Math.min(1, Number(raw.score) || 0));
      if (Array.isArray(raw.wounds)) this.wounds = raw.wounds.slice(-40);
      this.updatedAt = Number(raw.updatedAt) || 0;
      // 越久没见面，心气越回中位（不会记仇记一周）
      const hours = (Date.now() - this.updatedAt) / 3600000;
      if (hours > 0) this.score *= Math.exp(-hours / 18);
      dbg('mood loaded: ' + this.score.toFixed(2) + '（' + hours.toFixed(1) + 'h 前）');
    } catch (e) { try { __silentAudit.audit('driver.js:59', e); } catch (e2) {} }
  },
  // 收到情绪上报时累积（EMA，避免被一句话带跑）
  feed(emotion) {
    const d = this.delta[emotion];
    if (d === undefined) return;
    // 中性只是长尾，慢慢回中位；不要用 0.985 那种「每 1.5 秒衰减一次」的狠度，
    // 否则人还没走开，心情就被中位吸回去了。
    if (emotion === 'neutral') { this.score *= 0.997; return; }
    this.score = Math.max(-1, Math.min(1, this.score * 0.94 + d));
    this.save();
  },
  /** 记一笔情绪事件。note 是当时的用户原话，用来解释"为什么"。 */
  note(emotion, strength, note) {
    const NEG = { sad: true, aggrieved: true, angry: true, guilty: true, bored: true };
    const POS = { happy: true, smug: true, shy: true };
    const sign = NEG[emotion] ? -1 : (POS[emotion] ? 1 : 0);
    if (!sign) return null;
    const s = Math.max(0, Math.min(1, Number(strength) || 0));
    if (s < 0.5) return null;                     // 太轻的不值得记，不然全是噪声
    // 情绪是 1.5 秒上报一次的，不节流会把文件写爆、也会让余味瞬间打满。
    // 同一种情绪 3 分钟内只记一次；顺带把强度抬到最高值。
    // ⚠ 2026-11-10：这里原来还会 `dup.at = now` —— 只要她持续难过，伤口时间就被反复刷新，
    //   余味永远不衰减（实测钉在 -1.000）。时间戳只记「第一次」，后续只抬强度/补 note。
    const now = Date.now();
    const dup = this.wounds.find((x) => x.emo === String(emotion) && now - x.at < 3 * 60 * 1000);
    if (dup) { dup.s = Math.max(dup.s, +s.toFixed(2)); if (note && !dup.note) dup.note = String(note).slice(0, 40); return dup; }
    const rec = { at: now, emo: String(emotion), sign, s: +s.toFixed(2), note: String(note || '').slice(0, 40) };
    this.wounds.push(rec);
    this.wounds = this.wounds.slice(-40);
    this.save(true);
    dbg('wound+ ' + rec.emo + ' ' + rec.s + ' 「' + rec.note + '」');
    return rec;
  },

  /** 还没散掉的余味（-1..1）。
   *  负面偏差：难受的事半衰 36 小时，开心的事 18 小时 —— 人对坏事的记忆本来就久。
   *  （一条好话不该立刻把委屈冲干净，这也是"可信"的一部分。） */
  residue() {
    const now = Date.now();
    let sum = 0;
    for (const x of this.wounds) {
      const h = (now - x.at) / 3600000;
      if (h > 24 * 7) continue;
      const tau = x.sign < 0 ? 36 : 18;
      // 权重：难受 ×1.0，开心 ×0.5 —— 一句好话不该把委屈立刻清空。
      const weight = x.sign < 0 ? 1.0 : 0.5;
      sum += x.sign * x.s * weight * Math.exp(-h / tau);
    }
    // 用 tanh 做软饱和：一笔明显的委屈就是"有点烦"，好几笔才到"心情很差"，
    // 直接线性累加会在攒了四五条之后永远钉死在 -1。
    return Math.tanh(sum * 0.55);
  },

  /** 最近一条还有分量的记忆。wantSign 给定时只找同向的，避免自相矛盾。 */
  lastWound(wantSign) {
    const now = Date.now();
    const ok = (x, needNote) => {
      if (wantSign && Math.sign(x.sign) !== Math.sign(wantSign)) return false;
      if (needNote && !x.note) return false;
      const h = (now - x.at) / 3600000;
      if (h > 24 * 7) return false;
      return Math.abs(x.sign * x.s * Math.exp(-h / (x.sign < 0 ? 36 : 18))) >= 0.25;
    };
    // 先找"说得清为什么"的那条，找不到再退回任意一条
    for (const needNote of [true, false]) {
      for (let i = this.wounds.length - 1; i >= 0; i--) {
        if (!ok(this.wounds[i], needNote)) continue;
        const x = this.wounds[i];
        return { ...x, hours: Math.round(((now - x.at) / 3600000) * 10) / 10 };
      }
    }
    return null;
  },

  save(force) {
    if (!this.path) return;
    const now = Date.now();
    if (!force && now - this.dirtyAt < 20000) return;    // 20 秒最多写一次盘
    this.dirtyAt = now;
    this._lastSaved = this.score;
    try {
      require('fs').writeFileSync(this.path, JSON.stringify({ score: +this.score.toFixed(3), updatedAt: now, wounds: this.wounds }, null, 2));
    } catch (e) { try { __silentAudit.audit('driver.js:140', e); } catch (e2) {} }
  },
  // 把心情翻译成一句开场的心气
  describe() {
    // 当下心情 70% + 还没散的余味 30%
    const res = this.residue();
    const total = Math.max(-1, Math.min(1, this.score * 0.7 + res));
    const w = total === 0 ? null : this.lastWound(total);
    let line;
    if (total > 0.45) line = '心情不错';
    else if (total > 0.10) line = '还行';
    else if (total < -0.45) line = '心情很差';
    else if (total < -0.10) line = '有点烦';
    else line = '平平的';
    // 有余味就说明白"为什么"——这才像个人，而不是每次重置的 NPC
    if (w && Math.abs(total) > 0.08 && Math.abs(w.sign * w.s * Math.exp(-w.hours / (w.sign < 0 ? 36 : 18))) >= 0.25) {
      const when = w.hours < 1 ? '刚才' : (w.hours < 24 ? Math.round(w.hours) + ' 小时前' : Math.round(w.hours / 24) + ' 天前');
      const what = w.note ? '因为「' + w.note + '」' : '';
      line += w.sign < 0 ? '，还记着' + when + what : '，' + when + what + '那事还挺开心';
    }
    return { mood: total > 0.45 ? 'cheerful' : total > 0.1 ? 'ok' : total < -0.45 ? 'low' : total < -0.1 ? 'meh' : 'flat',
             emo: total > 0.45 ? 'happy' : total > 0.1 ? 'smug' : total < -0.45 ? 'sad' : total < -0.1 ? 'bored' : 'neutral',
             line, score: +total.toFixed(2), residue: +res.toFixed(2) };
  },
};

// 给诊断/控制台看的入口
try { global.__petMood = moodStore; } catch (e) { try { __silentAudit.audit('driver.js:167', e); } catch (e2) {} }

// ── 用户语气 ────────────────────────────────────────────────────────────────
// 同一句「我没事」，大声喊和轻轻说完全是两回事。
//
// 注意：用户说话走的是**麦克风 → ASR**，不是 audio-loop（那是系统声音）。
// 所以语气特征由 ASR 服务在识别时顺手算（rms / 语速 / 断续度）并随结果返回，
// 这里订阅识别结果事件，把它翻译成一句人话，再喂给情绪引擎。
const userTone = {
  last: null,
  at: 0,
  /** 把 ASR 返回的物理量翻成线索 */
  describe(tn) {
    if (!tn) return null;
    // 统一字段优先：ASR 现在和回环那一路用同一个分类器，直接给 kind/mood/cues。
    // 不是人声就别当成"用户的语气"——放音乐时麦克风也会收到声音。
    if (tn.kind && tn.kind !== 'speech' && tn.kind !== 'speech_music') return null;
    if (Array.isArray(tn.cues) && tn.cues.length) return tn.cues;
    const cues = [];
    const rms = Number(tn.rms) || 0;
    const cps = Number(tn.chars_per_sec) || 0;
    const quiet = Number(tn.quiet_ratio) || 0;
    if (rms > 0.08) cues.push("声音很大、像在激动");
    else if (rms > 0 && rms < 0.008) cues.push("声音很小、没什么力气");
    if (cps > 7) cues.push("说得很快");
    else if (cps > 0 && cps < 3.0) cues.push("说得很慢");
    if (quiet > 0.45) cues.push("断断续续、像在犹豫");
    return cues.length ? cues : null;
  },
  apply(tn, source) {
    try {
      const cues = this.describe(tn);
      if (!cues) return null;
      this.last = cues;
      this.at = Date.now();
      dbg("user tone(" + (source || "?") + "): " + cues.join("、"));
      try {
        const body = global.petBody;
        if (body && typeof body.feedEvent === "function") {
          if (cues.some((c) => /激动|很快/.test(c))) body.feedEvent("user_excited");
          else if (cues.some((c) => /小、|慢|犹豫/.test(c))) body.feedEvent("user_low");
        }
      } catch (e) { try { __silentAudit.audit('driver.js:209', e); } catch (e2) {} }
      return cues;
    } catch (e) { return null; }
  },
};

// 最近一次用户原话（情绪记忆要记「因为什么」，不能只记「她难过了」）
let lastUserText = '';

// 订阅 ASR 识别结果（带 tone 就顺手用掉）
try {
  const ev = require("../../../js/core/event-bus.js");
  const evs = require("../../../js/core/events.js");
  if (ev && ev.eventBus && evs && evs.Events && evs.Events.ASR_TEXT_RECOGNIZED) {
    ev.eventBus.on(evs.Events.ASR_TEXT_RECOGNIZED, (payload) => {
      const tn = (payload && (payload.tone || (payload.result && payload.result.tone))) || null;
      const txt = String((payload && (payload.text || (payload.result && payload.result.text))) || '').trim();
      if (txt) lastUserText = txt.slice(0, 60);
      if (tn) userTone.apply(tn, "asr");
    });
  }
  // 2026-11-10：文字输入也要更新 lastUserText（原来只认 ASR，打字说话时伤口 note 永远空）。
  //   事件载荷由 InputRouter / ASRController 补上 { text }。
  if (ev && ev.eventBus && evs && evs.Events && evs.Events.USER_MESSAGE_RECEIVED) {
    ev.eventBus.on(evs.Events.USER_MESSAGE_RECEIVED, (payload) => {
      const txt = payload && typeof payload === 'object' ? String(payload.text || '').trim() : '';
      if (txt) lastUserText = txt.slice(0, 60);
    });
  }
} catch (e) { try { __silentAudit.audit('driver.js:230', e); } catch (e2) {} }

try { global.__petTone = userTone; } catch (e) { try { __silentAudit.audit('driver.js:232', e); } catch (e2) {} }

// ── 把她此刻的情绪推给 TTS ────────────────────────────────────────────────
// edge-tts 只有 语速/音调/音量 三个旋钮，但按情绪调一下，语气就明显不同了。
let __lastProsodyEmotion = '';
let __lastProsodyAt = 0;
function pushProsody(emotion, strength) {
  try {
    const emo = String(emotion || 'neutral');
    const now = Date.now();
    // 同一情绪 1.5 秒内不重复推，避免每帧发一次请求
    if (emo === __lastProsodyEmotion && now - __lastProsodyAt < 1500) return;
    __lastProsodyEmotion = emo;
    __lastProsodyAt = now;
    const http = require('http');
    const body = Buffer.from(JSON.stringify({ emotion: emo, strength: Number(strength) || 1 }), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: 9883, path: '/prosody', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (res) => { res.resume(); });
    req.on('error', (e) => { pushProsody._fails = (pushProsody._fails || 0) + 1; if (pushProsody._fails === 1 || pushProsody._fails % 10 === 0) dbg('prosody 连续失败 x' + pushProsody._fails + ': ' + (e && e.message || e) + '（语气韵律没送达，她说话不带情绪韵律）'); });
    req.setTimeout(3000, () => { try { req.destroy(); } catch (e) { try { __silentAudit.audit('driver.js:253', e); } catch (e2) {} } });
    req.write(body); req.end();
    pushProsody._fails = 0;
    dbg('prosody -> ' + emo);
  } catch (e) { try { __silentAudit.audit('driver.js:257', e); } catch (e2) {} }
}

// 兜底：不管 WS 连没连上，都定期把当前情绪推给 TTS。
// （只依赖 WS 的话，一旦内部通道没连上，语气就永远是默认的。）
let __prosodyTimer = null;
function startProsodyLoop() {
  if (__prosodyTimer) return;
  __prosodyTimer = setInterval(() => {
    try {
      const body = global.petBody;
      if (!body || typeof body.emotionSnapshot !== 'function') return;
      const snap = body.emotionSnapshot();
      if (!snap || !snap.emotion) return;
      pushProsody(snap.emotion, snap.strength);
    } catch (e) { try { __silentAudit.audit('driver.js:272', e); } catch (e2) {} }
  }, 1200);
  if (__prosodyTimer.unref) __prosodyTimer.unref();
}

const listenGate = {
  paused: false,
  timer: null,
  set(on) {
    if (this.paused === on) return;
    this.paused = on;
    try {
      const body = JSON.stringify({ on });
      const http = require("http");
      const req = http.request({ host: "127.0.0.1", port: 1001, path: "/pause", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: 1500 });
      req.on("error", (e) => { listenGate._fails = (listenGate._fails || 0) + 1; if (listenGate._fails === 1 || listenGate._fails % 5 === 0) dbg('listenGate /pause 连续失败 x' + listenGate._fails + ': ' + (e && e.message || e) + '（耳朵不暂停→她的 TTS 会被回环录回去当人声）'); });
      req.on("timeout", () => { try { req.destroy(); listenGate._fails = (listenGate._fails || 0) + 1; } catch (e) { try { __silentAudit.audit('driver.js:289', e); } catch (e2) {} } });
      req.write(body); req.end();
    } catch (e) { try { __silentAudit.audit('driver.js:291', e); } catch (e2) {} }
  },
  // 嘴一动就暂停；静音 900ms 后恢复
  onMouth(value) {
    if (value > 0.02) {
      this.set(true);
      clearTimeout(this.timer);
      this.timer = null;
    } else if (this.paused && !this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.set(false); }, 900);
    }
  },
};

const fs = require("fs");
const path = require("path");
const LOG = path.resolve(__dirname, "../../../../..", "petbody-debug.log");
const petbodyMouth = { peak: 0, at: 0 };
// 轮转（2026-11-13）：dbg 以前是裸 appendFileSync，无上限。shadow-target 5 秒一条，
// 光它就约 3.5MB/天，再加切表情/动作 —— 和 `.state/my-neuro.out.log` 涨到 184MB
// 是同一类问题（那次只修了 main.js 与 launcher，渲染层这条漏了）。
// 按字节轮转、保留一份 .1；用累加计数避免每帧 statSync。
const LOG_MAX_BYTES = 8 * 1024 * 1024;
let logBytes = 0;
try { logBytes = fs.statSync(LOG).size; } catch (e) { logBytes = 0; }

function dbg(msg) {
  try {
    const line = new Date().toISOString().slice(11, 19) + " " + msg + "\n";
    if (logBytes > LOG_MAX_BYTES) {
      try { fs.unlinkSync(LOG + ".1"); } catch (e) { /* 没有旧的 */ }
      try { fs.renameSync(LOG, LOG + ".1"); } catch (e) { /* 改名失败照常追加，不能因日志把渲染搞挂 */ }
      logBytes = 0;
    }
    fs.appendFileSync(LOG, line);
    logBytes += Buffer.byteLength(line);
  } catch (e) { try { __silentAudit.audit('driver.js:308', e); } catch (e2) {} }
}
// 初始化心跳：看门狗据此区分「正在慢加载」与「卡死」——只贴心跳，绝不空转
function stage(name) { try { window.__petBodyStage = name; window.__petBodyStageAt = Date.now(); } catch (e) { try { __silentAudit.audit('driver.js:310', e); } catch (e2) {} } }

// 诊断快照：谁在、谁不在、motion-director 会不会真的写参数
function collectDiag() {
  const facade = global.avatarFacade;
  let motionDirector = null;
  try { motionDirector = require("../../../js/ai/motion-director.js").motionDirector || null; } catch (e) { try { __silentAudit.audit('driver.js:316', e); } catch (e2) {} }
  if (!motionDirector) { try { motionDirector = global.motionDirector || null; } catch (e) { try { __silentAudit.audit('driver.js:317', e); } catch (e2) {} } }
  let motionEnabled = null;
  try { motionEnabled = motionDirector && typeof motionDirector.isEnabled === "function" ? !!motionDirector.isEnabled() : null; } catch (e) { try { __silentAudit.audit('driver.js:319', e); } catch (e2) {} }
  return {
    activeType: (facade && typeof facade.getActiveType === "function" && facade.getActiveType()) || null,
    petBodyActive: !!global.__petBodyActive,
    paramDirector: !!global.paramDirector,
    live2dRuntime: !!global.live2dRuntime,
    petBody: !!global.petBody,
    emotionMapper: !!global.emotionMapper,
    motionDirector: !!motionDirector,
    motionDirectorEnabled: motionEnabled,
    // petbody 下 paramDirector 不存在 → llm-handler 会走 no-param-director 分支，choreograph 不会被调用
    choreographyWouldRun: !!(global.paramDirector && motionEnabled),
  };
}


// 让外部的 HTTP /say 真正「开口」：走宿主自己的 TTS 管线，口型由它的音频回调驱动。
function installSayBridge(context, dbg) {
  const tts = context && context.ttsProcessor;
  if (tts && typeof tts.processTextToSpeech === "function") {
    global.petSpeak = (text) => {
      try {
        // 延迟填充（论文 2507.22352：>4s 感知差明显；填充动作能补救）：
        // 请求已发出、900ms 还没开口 → 轻歪个头，让「等待」看起来像「在想」。
        // 开口了就什么都不做，不打扰说话时的表情。
        if (global.petBody && typeof global.petBody.playMotion === "function") {
          setTimeout(() => {
            try {
              const s = global.petBody.snapshot ? global.petBody.snapshot() : null;
              if (s && !s.speaking) global.petBody.playMotion("tilt_head");
            } catch (e) { try { __silentAudit.audit('driver.js:349', e); } catch (e2) {} }
          }, 900);
        }
        return tts.processTextToSpeech(String(text || ""));
      } catch (e) { dbg("speak failed: " + e.message); return null; }
    };
  }
  try {
    const ws = new WebSocket("ws://127.0.0.1:" + (process.env.PET_INNER_PORT || 8102));
    // 渲染健康哨兵复用这条通道（见文件头 renderDiag）：就绪前 publishRenderHealth 会自己 return
    innerWs = ws;
    // 给同一页面的其他桥用（assets-bridge 回传资产状态）：别各自再开一条 8102，
    // 8103 是按连接广播的，多开一条 = 每个指令都收两遍。
    global.__petInnerSend = (msg) => {
      try {
        if (!innerWs || innerWs.readyState !== 1) return false;
        innerWs.send(JSON.stringify(msg));
        return true;
      } catch (e) { return false; }
    };
    ws.onopen = () => {
      dbg("say-bridge connected");
      // 情绪快照转发给内部通道，GET /emotion 与托盘菜单都靠它
      if (!global.__petEmotionRelay) {
        global.__petEmotionRelay = (event) => {
          try {
            const d = (event && event.detail) || window.__petBodyEmotionReport;
            if (!d) return;
            // 顺手累计心情（不管 WS 通不通都要记）。
            // 只让「有分量」的情绪计分：强度太弱的碎情绪不该改写心情，
            // 否则一句随口的话就能把她整天的心气翻过来。
            try {
              const strength = Number(d.strength);
              if (!Number.isFinite(strength) || strength >= 0.45) {
                // ⚠ 2026-11-10：这里**不再记伤口**。d 是她自己情绪引擎 1.5s 一次的快照
                //   （idle/环境/自说自话都会让 aggrieved 持续存在），在这里记账 =
                //   自己给自己判刑：40 条伤口全空 note、余味钉死 -1.000。
                //   伤口只由「用户触发」的路径写入（setEmotion / 投喂 / 摸头）。
                moodStore.feed(d.emotion);
                // PAD 总线表情半边：心气推回皮套，表情基线随心情偏移（与 TTS 韵律同一 driving affect）
                try {
                  const md = moodStore.describe();
                  if (global.petBody && typeof global.petBody.setMood === 'function') global.petBody.setMood(md && Number.isFinite(md.score) ? md.score : 0);
                } catch (e) { try { __silentAudit.audit('driver.js:380', e); } catch (e2) {} }
              }
            } catch (e) { try { __silentAudit.audit('driver.js:382', e); } catch (e2) {} }
            if (ws.readyState !== 1) return;
            ws.send(JSON.stringify(d));
          } catch (e) { try { __silentAudit.audit('driver.js:385', e); } catch (e2) {} }
        };
        window.addEventListener("petbody:emotion", global.__petEmotionRelay);

        // 演出编排里的音效：渲染层只负责"该响了"，真正播由 sfx 插件做
        // （它才有 SFX 目录路径与文件解码）。失败不影响演出继续。
        if (!global.__petSfxRelay) {
          global.__petSfxRelay = (ev) => {
            try {
              const id = ev && ev.detail && ev.detail.id;
              if (!id) return;
              const pm = global.pluginManager;
              if (pm && typeof pm.executeTool === 'function') {
                Promise.resolve(pm.executeTool('play_sound_effect', { sfx_id: String(id) }))
                  .then(() => dbg('sfx ' + id))
                  .catch((e) => dbg('sfx failed: ' + (e && e.message || e)));
              }
            } catch (e) { try { __silentAudit.audit('driver.js:402', e); } catch (e2) {} }
          };
          window.addEventListener('petbody:sfx', global.__petSfxRelay);
          dbg('sfx-relay installed');
        }
        if (!global.__petInteractionRelay) {
          global.__petInteractionRelay = (event) => interactionTick((event && event.detail && event.detail.name) || "gesture");
          window.addEventListener("petbody:interaction", global.__petInteractionRelay);
        }
      }
    };
    ws.onerror = (e) => { dbg("say-bridge ws 出错: " + (e && e.message || e || "unknown") + "（8102 断线→say/costume/perform 全失联，2s 后重连）"); };
    ws.onclose = () => { if (innerWs === ws) innerWs = null; dbg("say-bridge ws 关闭，2s 后重连"); setTimeout(() => { try { installSayBridge(context, dbg); } catch (e) { try { __silentAudit.audit('driver.js:414', e); } catch (e2) {} } }, 2000); };
    ws.onmessage = (event) => {
      let msg; try { msg = JSON.parse(String(event.data)); } catch (e) { return; }
      if (!msg || !msg.type) return;
      // 注意：installSayBridge 是顶层函数，作用域里没有 init() 的 body 变量，
      // 必须走 global.petBody（之前写成 body 会抛 ReferenceError，把整个消息处理打断）。
      if (msg.type === "emotion-gain" && global.petBody) {
        // 表情强度：0 = 静音表情（不切脸）。2026-11-15：原来只调 body.setEmotionGain，
        // 而 petBody 上**根本没有这个方法** → 托盘开关一直是死的。现在落成全局开关，
        // 由 actions-bridge.applyEmotion 判断。
        try {
          const gain = Number(msg.gain);
          global.__petEmotionGain = Number.isFinite(gain) ? gain : 1;
          if (typeof global.petBody.setEmotionGain === "function") global.petBody.setEmotionGain(global.__petEmotionGain);
          dbg("emotion-gain → " + global.__petEmotionGain);
        } catch (e) { dbg("emotion-gain failed: " + (e && e.message || e)); }
      }
      else if (msg.type === "framing" && global.petBody && global.petBody.renderer) {
        // 托盘菜单/HTTP 切换取景：立即生效，不用重启
        try { global.petBody.renderer.setFraming(msg.mode === "full" ? "full" : "half"); dbg("framing → " + msg.mode); } catch (e) { dbg("framing failed: " + (e && e.message || e)); }
      }
      else if (msg.type === "choreo") {
        // 编舞 v1 开关（托盘「编舞（实验）」）：落到渲染层的 window.__petChoreoOn
        try {
          const on = msg.on === true;
          global.__petChoreoOn = on;
          if (typeof window !== "undefined") window.__petChoreoOn = on;
          if (global.petBody && typeof global.petBody.setChoreography === "function") global.petBody.setChoreography(on);
          dbg("choreo → " + on);
        } catch (e) { dbg("choreo failed: " + (e && e.message || e)); }
      }
      else if (msg.type === "perf-auto") {
        // 长表演自动触发开关（托盘「自动演（情绪触发）」）：落到渲染层的 window.__petPerfAuto
        try {
          const on = msg.on !== false;
          if (typeof window !== "undefined") window.__petPerfAuto = on;
          if (global.petBody && typeof global.petBody.setPerformanceAuto === "function") global.petBody.setPerformanceAuto(on);
          dbg("perf-auto → " + on);
        } catch (e) { dbg("perf-auto failed: " + (e && e.message || e)); }
      }
      else if (msg.type === "say" && global.petSpeak) { interactionTick("say"); dbg("say: " + String(msg.text).slice(0, 40)); global.petSpeak(msg.text); }
      else if (msg.type === "chat") {
        interactionTick("chat");
        dbg("chat: " + String(msg.text).slice(0, 40));
        // 用户语气由 ASR 结果事件驱动（见 userTone），这里只做兜底：
        // 如果 3 秒内刚拿到过语气线索就复用，避免打字时误触发。
        try {
          if (userTone.last && Date.now() - userTone.at < 3000) {
            dbg("user tone(reuse): " + userTone.last.join("、"));
          }
        } catch (e) { try { __silentAudit.audit('driver.js:438', e); } catch (e2) {} }
        try {
          const vc = global.voiceChat;
          dbg("voiceChat=" + typeof vc + " handleTextMessage=" + (vc && typeof vc.handleTextMessage));
          if (vc && typeof vc.handleTextMessage === "function") {
            const r = vc.handleTextMessage(String(msg.text));
            dbg("chat dispatched, returned=" + typeof r);
          } else { dbg("chat skipped: voiceChat 未就绪"); }
        } catch (e) { dbg("chat failed: " + (e && e.stack || e).toString().slice(0, 300)); }
      }
      else if (msg.type === "asset" && global.petBody) { try { global.petBody.asset(msg.id, msg.toggle ? undefined : msg.on); } catch (e) { dbg("asset " + msg.id + " failed: " + (e && e.message || e)); } }
      // 换装：{ type:'costume', name, on } / { type:'costume-reset' }
      // 省钱模式：她说得越少，LLM 调用越少。测试/调试时打开。
      else if (msg.type === "quiet") {
        try {
          global.__petQuiet = !!msg.on;
          dbg("quiet = " + global.__petQuiet);
        } catch (e) { try { __silentAudit.audit('driver.js:455', e); } catch (e2) {} }
      }
      // 用户活跃度走独立的 ipcRenderer 通道 'pet:user-activity'（见上方 installSayBridge 外的注册），
      // 不走这条 WS 消息总线——WS 用于 say/costume/perform 这类演出指令。
      else if (msg.type === "costume") {
        // 换装统一走 ui-controller 暴露的 window.__petAssets（它用的是构建期导出的资产数据）。
        // 注意：绝不在渲染进程 import pet-runtime/desktop/asset-toggles.mjs ——
        // 那个模块在宿主运行时里一 import 就会自启 700ms 的同步循环，直接把渲染进程拖死。
        try {
          const api = window.__petAssets;
          if (!api) { dbg("costume skipped: __petAssets 未就绪"); }
          else if (msg.preset) { api.preset(msg.preset); dbg("preset → " + msg.preset); }
          else if (msg.name) { api.apply(msg.name, msg.on !== false); dbg("costume " + msg.name + (msg.on === false ? " 关" : " 开")); }
        } catch (e) { dbg("costume failed: " + (e && e.message || e)); }
      }
      // 下面两条之前被误删过（删 loadAssets 时连带删掉了），这里补回来。
      // ⚠ 2026-11-13：第三行（asset）当时补重了 —— 上面 if/else-if 链里已有一个
      //   完全相同的 `msg.type === "asset"` 分支，这一条永远不可达。已删。
      else if (msg.type === "action" && global.petBody) { try { global.petBody.playMotion(msg.name); } catch (e) { dbg("action " + msg.name + " failed: " + (e && e.message || e)); } }
      // 演一段：情绪 + 动作 + 换装 的时间线（纯本地，不产生 API 调用）
      else if (msg.type === "perform" && global.petBody) {
        try {
          const steps = global.petBody.perform ? global.petBody.perform(msg.name) : false;
          dbg("perform " + msg.name + " → " + steps + " 步");
          if (steps && msg.hint !== false && global.showSubtitle) {
            // 台词表在文件顶部 require（js/core/scene-lines.js，单一真源）
            try { global.showSubtitle(SCENE_HINT[msg.name] || '', 3200); } catch (e) { try { __silentAudit.audit('driver.js:478', e); } catch (e2) {} }
          }
        } catch (e) { dbg("perform failed: " + (e && e.message || e)); }
      }
      else if (msg.type === "work-state" && global.petBody) { try { global.petBody.setWorkState(msg.state); } catch (e) { dbg("work-state failed: " + (e && e.message || e)); } }
      else if (msg.type === "expression" && global.petBody) { try { global.petBody.setEmotion(msg.name, msg.strength); } catch (e) { dbg("expression " + msg.name + " failed: " + (e && e.message || e)); } }
    };
  } catch (error) { dbg("say-bridge failed: " + (error && error.message || error)); }
}

function createPetBodyDriver() {
  // 用户活跃度（2026-11-09 三十轮）：主进程每 8 秒检测系统空闲时间，状态变化时推送。
  // auto-chat / MoodChatModule 读 global.__userActivity 判断「用户是否在专注」以决定要不要主动开口。
  // 放在函数最开头无条件注册 —— 之前嵌在深处的 try 块里，前面的代码一抛错就整个跳过（实测踩到）。
  try {
    require('electron').ipcRenderer.on('pet:user-activity', (_e, payload) => {
      try {
        if (!payload) return;
        global.__userActivity = {
          idleMs: Number(payload.idleMs) || 0,
          state: String(payload.state || 'unknown'),
          busy: payload.busy === true,
          at: Number(payload.at) || Date.now(),
        };
      } catch (e) { try { __silentAudit.audit('driver.js:userActivity', e); } catch (e2) {} }
    });
  } catch (e) { try { __silentAudit.audit('driver.js:userActivity-reg', e); } catch (e2) {} }
  try { startProsodyLoop(); } catch (e) { try { __silentAudit.audit('driver.js:489', e); } catch (e2) {} }
  // subtitle-hook：把宿主显示的字幕抄一份到调试日志，用来验证"对话→字幕"这段。
  try {
    setTimeout(() => {
      const orig = global.showSubtitle;
      if (typeof orig === "function" && !orig.__petHooked) {
        const hooked = (text, duration) => { try { dbg("subtitle: " + String(text).slice(0, 80)); } catch (e) { try { __silentAudit.audit('driver.js:495', e); } catch (e2) {} } return orig(text, duration); };
        hooked.__petHooked = true;
        global.showSubtitle = hooked;
        dbg("subtitle-hook installed");
      }
    }, 3000);
  } catch (e) { try { __silentAudit.audit('driver.js:501', e); } catch (e2) {} }
  try { require("./assets-bridge.js"); } catch (e) { try { __silentAudit.audit('driver.js:502', e); } catch (e2) {} }
// 薄适配层：拖动 / 穿透 / 按窗口宽修正宿主为大窗口写死的位置 / 字幕前缀剥离。
// 宿主的 js/ui/ui-controller.js 提供全部界面组件，这里只补它没有的那几件。
try { require("./ui.js"); } catch (e) { logToTerminal("warn", "[PetBody] ui.js 加载失败: " + (e && e.message || e)); }
  let body = null;
  let bridge = null;
  let ttsProcessor = null;
  let diagTimer = null;
  let diagTicks = 0;
  let prevEmotionMapper = null;

  // ── 眼神跟随 ────────────────────────────────────────────────────────────
  // 主进程每 100ms 发全局光标坐标；这里换算成「相对她脸的归一化方向」交给皮套。
  function installGaze(win) {
    try {
      const { ipcRenderer } = require('electron');
      let last = 0;
      // 工作区缓存（sendSync 别放进 16Hz 的光标循环里）：range 跟屏幕走，
      // 否则固定 450px 在 2560 宽屏上大部分时间都钳在满偏——「她永远瞪死一边」的体感来源。
      // key = 窗口位置：窗口挪屏时下一次光标事件就重算（缓存 5s 兜底）。
      let workCache = null, workAt = 0, workKey = '';
      const workArea = (key) => {
        if (workCache && key === workKey && Date.now() - workAt < 5000) return workCache;
        try {
          const info = ipcRenderer.sendSync('get-screen-info-sync');
          const wb = info && info.windowBounds;
          const ds = (info && info.allDisplays) || [];
          let hit = null;
          if (wb) {
            const cx = wb.x + wb.width / 2, cy = wb.y + wb.height / 2;
            hit = ds.find((d) => { const b = d.bounds || d; return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height; });
          }
          const area = hit ? (hit.workArea || hit.bounds) : null;
          workCache = area ? { x: area.x, y: area.y, w: area.width, h: area.height } : { x: 0, y: 0, w: 1200, h: 900 };
        } catch (e) { workCache = { x: 0, y: 0, w: 1200, h: 900 }; }
        workAt = Date.now(); workKey = key;
        return workCache;
      };
      ipcRenderer.on('pet:cursor', (_e, pt) => {
        const now = Date.now();
        if (now - last < 60) return;           // 最多 16Hz，够用又不浪费
        last = now;
        const body = global.petBody;
        if (!body || typeof body.setGaze !== 'function' || !pt) return;
        // 被人拖着走的时候别乱瞟：窗口自己在动，眼神先回中，像「被搬走」而不是「追鼠标」。
        // 3s 新鲜度：拖太快 pointerup 落在窗外没触发 endDrag 时自动解冻，不会永久冻结。
        try { if (window.__pbDragging && Date.now() - (window.__pbDraggingAt || 0) < 3000) { body.setGaze(null, null, 0); return; } } catch (e) { try { __silentAudit.audit('driver.js:548', e); } catch (e2) {} }
        try {
          // 优先用主进程随点一起发来的窗口矩形（准），拿不到才退回 window.screenX
          const b = (pt.bw ? { x: pt.bx, y: pt.by, width: pt.bw, height: pt.bh } : null);
          const w = (b && b.width) || window.innerWidth || 420;
          const h = (b && b.height) || window.innerHeight || 760;
          const ox = (b && b.x) || (window.screenX || 0);
          const oy = (b && b.y) || (window.screenY || 0);
          // 脸大致在窗口上半部中央
          const cx = ox + w / 2;
          const cy = oy + h * 0.30;
          // 范围决定「多敏感」。2026-11-08 实测两次踩坑：
          //  ① 固定 30% 屏宽 → 她贴屏最左、鼠标在最右时距离 1487px，整段行程恒钳 ±1（眼神钉死）。
          //  ② 改成 50% 屏宽仍不够（853 < 1487）。
          // 正解：range 取「她的脸到工作区四边的最远距离」——这样在任何位置，
          // 光标落在屏内任何一点都落在 ±1 之内，方向对且不会一出门就饱和。
          const wa = workArea(ox + ',' + oy);
          const faX = ox + w / 2;
          const faY = oy + h * 0.30;
          const distRight = (wa.x + wa.w) - faX, distLeft = faX - wa.x;
          const distDown = (wa.y + wa.h) - faY, distUp = faY - wa.y;
          // 留一点余量（×0.9）：鼠标真到屏幕角时接近满偏，但不会因为几像素抖动就顶死
          const rangeX = Math.max(240, Math.max(distLeft, distRight) * 0.9);
          const rangeY = Math.max(240, Math.max(distUp, distDown) * 0.9);
          // 跟随门：整个工作区都算「她在看你的范围」——原来只在鼠标落进 420px 窗口矩形时
          // 才跟随，大屏上覆盖率不到 6%，用户体感就是「眼神跟随还是没有」。
          // 现在光标在她所在屏的任何位置她都看向那个方向；出屏/切到别的屏才回中。
          const onScreen = pt.x >= wa.x && pt.x <= wa.x + wa.w && pt.y >= wa.y && pt.y <= wa.y + wa.h;
          if (!onScreen) { body.setGaze(null, null, 0); return; }
          const gx = Math.max(-1, Math.min(1, (pt.x - cx) / rangeX));
          const gy = Math.max(-1, Math.min(1, (pt.y - cy) / rangeY));
          body.setGaze(gx, gy, 0);
        } catch (e) { if (!installGaze._warned) { installGaze._warned = true; dbg('gaze tick failed: ' + (e && e.message || e)); } }
      });
      dbg('gaze: cursor bridge installed');
    } catch (e) { dbg('gaze failed: ' + (e && e.message || e)); }
  }

  function logDiag(tag) {
    const d = collectDiag();
    dbg("[diag] " + tag + " " + JSON.stringify(d));
    return d;
  }

  return {
    engine: "cubism5",
    async init(context) {
      stage("init");
      dbg("init:start");
      global.__petBodyReport = (event) => {
        try {
          dbg("report: " + JSON.stringify(event).slice(0, 220));
          // 顺路把三条诊断喂给健康哨兵 —— 日志照写（人要看），快照另走结构化通道
          noteRenderReport(event);
        } catch (e) { try { __silentAudit.audit('driver.js:597', e); } catch (e2) {} }
      };
        stage("load:" + String((event && (event.path || event.type)) || "").slice(0, 40));
      dbg("PetBody=" + typeof global.PetBody + " createPetBody=" + (global.PetBody && typeof global.PetBody.createPetBody));
      const api = global.PetBody;
      if (!api || typeof api.createPetBody !== "function") throw new Error("PetBody 运行时未加载（build/petbody.js 缺失）：公开版不随仓分发 Cubism SDK，请按 README「自备资产」取得 SDK 后运行 node pet-runtime/build-and-deploy-petbody.mjs");
      const canvas = document.querySelector("#live2d-container canvas") || document.querySelector("#canvas");
      if (!canvas) throw new Error("找不到皮套画布");
      body = api.createPetBody(canvas, {
        assetBase: context?.config?.ui?.petbody_asset_base || "assets/petbody/",
        framing: context?.config?.ui?.petbody_framing || "half",
        shaderBase: "vendor/cubism/Framework/Shaders/WebGL/",
        mouthGain: Number(context?.config?.ui?.petbody_mouth_gain || 1.1),
        emotionGain: Number(context?.config?.ui?.petbody_emotion_gain ?? 1),
        // 语义兜底的「情绪描述」改写（2026-11-18 §69 B6）：8120 的契约是
        // {intent: 情绪描述, text: 台词}，喂原始文本可用率只有 22%（离线 18 条语料），
        // 改写后 44%。LLM 在主进程里（那里才有 provider 凭据），这里只递一句话。
        // 失败/超时一律返回 {ok:false}，皮套会退回原句，不比原来差。
        describeIntent: (() => {
          try {
            const ipc = require("electron").ipcRenderer;
            return (text) => ipc.invoke("sense-intent-describe", String(text || ""));
          } catch (error) {
            try { __silentAudit.audit("driver.js:describeIntent", error); } catch (e2) {}
            return null;
          }
        })(),
        // 省电模式（2026-11-09）：默认关——用户反馈「待机帧数太小看起来卡」，
        // 满帧优先。玩游戏时可从设置面板打开，待机降到每 3 帧重算让出 GPU。
        powerSave: context?.config?.ui?.petbody_power_save === true,
        onMouth: (smooth, raw) => {
          try { listenGate.onMouth(smooth); } catch (e) { try { __silentAudit.audit('driver.js:611', e); } catch (e2) {} }
          petbodyMouth.peak = Math.max(petbodyMouth.peak, smooth);
          const now = Date.now();
          if (now - petbodyMouth.at > 800) {
            if (petbodyMouth.peak > 0.03) dbg("mouth peak=" + petbodyMouth.peak.toFixed(3) + " raw=" + Number(raw || 0).toFixed(3));
            petbodyMouth.at = now; petbodyMouth.peak = 0;
          }
        },
      });
      dbg("canvas " + canvas.width + "x" + canvas.height + " client " + canvas.clientWidth + "x" + canvas.clientHeight + " webgl=" + !!canvas.getContext("webgl"));
      dbg("body created, loading...");
      stage("load");
      // WASM 表/内存在系统紧张（游戏、大程序）时可能瞬时分配失败：
      // 重试 3 次（间隔 3s），之前一失败就整场缺席只能重启——自愈才算产品级。
      let info;
      let lastLoadErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { info = await body.load(); lastLoadErr = null; break; }
        catch (error) {
          lastLoadErr = error;
          dbg("load failed (attempt " + attempt + "/3): " + String(error && error.message || error));
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (lastLoadErr) {
        dbg(String(lastLoadErr && lastLoadErr.stack || lastLoadErr).slice(0, 400));
        // 同页重试救不了 WASM 表耗尽（游戏内存压力下常见）：整页重载 = 新表。
        // 主进程带 60s 防循环守卫，连炸也不至于变成重启风暴。
        try {
          dbg("load 3 连败 → 请求整页重载（WASM 表自愈）");
          require('electron').ipcRenderer.send('pet-reload');
        } catch (e) { try { __silentAudit.audit('driver.js:642', e); } catch (e2) {} }
        throw lastLoadErr;
      }
      dbg("loaded: " + JSON.stringify(info));
      // 心情：读上次留下的，心情明显时开局就带着它
      try {
        const recordsDir = require('path').join(__dirname, '..', '..', '..', '..', 'data');
        moodStore.init(recordsDir);
        const d = moodStore.describe();
        if (d.mood !== 'flat') {
          try { body.setEmotion(d.emo); } catch (e) { try { __silentAudit.audit('driver.js:652', e); } catch (e2) {} }
          dbg("mood applied: " + d.mood + "（" + d.line + "）");
        }
      } catch (e) { try { __silentAudit.audit('driver.js:655', e); } catch (e2) {} }
      installSayBridge(context, dbg);
      stage("bridge");
      global.petBody = body;
      // 编舞 v1 开关：从配置恢复（托盘「编舞（实验）」写 ui.petbody_choreo）
      try {
        const choreoOn = !!(context && context.config && context.config.ui && context.config.ui.petbody_choreo === true);
        global.__petChoreoOn = choreoOn;
        if (typeof window !== 'undefined') window.__petChoreoOn = choreoOn;
        if (typeof body.setChoreography === 'function') body.setChoreography(choreoOn);
        dbg('[choreo] 初始 = ' + choreoOn);
      } catch (e) { try { __silentAudit.audit('driver.js:choreo-init', e); } catch (e2) {} }
      // 长表演自动触发：默认开（用户拍板「聊天的时候触发才像真人」），配置里显式 false 才关
      try {
        const perfAutoOn = !(context && context.config && context.config.ui && context.config.ui.petbody_perf_auto === false);
        if (typeof window !== 'undefined') window.__petPerfAuto = perfAutoOn;
        if (typeof body.setPerformanceAuto === 'function') body.setPerformanceAuto(perfAutoOn);
        dbg('[perf-auto] 初始 = ' + perfAutoOn);
      } catch (e) { try { __silentAudit.audit('driver.js:perf-auto-init', e); } catch (e2) {} }
      // 演出编排配置（2026-11-25 P0，ADR-015 §4.1）：director dry-run / ambient / program /
      // scheduler 整组下发。缺键由 perf/director.mjs 的默认值兜底（enabled=false + dry_run=true
      // = 只写 perf.request，不拦任何表演）。不读 config 就永远拿不到 Pi/控制中心的改动。
      try {
        const perfCfg = (context && context.config && context.config.performance) || null;
        if (typeof window !== 'undefined') window.__petPerformanceConfig = perfCfg;
        if (typeof body.setPerformanceConfig === 'function') body.setPerformanceConfig(perfCfg);
        dbg('[perf-config] ' + JSON.stringify((perfCfg && perfCfg.director) || null));
      } catch (e) { try { __silentAudit.audit('driver.js:perf-config-init', e); } catch (e2) {} }
      stage("ready");
      try { installGaze(require('electron').remote ? require('electron').remote.getCurrentWindow() : null); } catch (e) { dbg('gaze install skipped: ' + (e && e.message || e)); }
      try { global.currentModel = body.renderer; } catch (e) { try { __silentAudit.audit('driver.js:661', e); } catch (e2) {} }
      // 给 motion-director 看的仲裁标志：petbody 接管渲染期间，它不该再产参数级编舞
      global.__petBodyActive = true;
      logToTerminal("info", "[PetBody] 已接管渲染: drawables=" + info.drawables + " mask=" + JSON.stringify(info.mask));

      // ── 情绪 / 动作意图桥 ───────────────────────────────────────────────
      const renderer = body.renderer;
      bridge = createEmotionBridge({
        characterName: "大肥鱼",
        log: (line) => dbg(line),
        setExpression: (name) => {
          try {
            if (renderer && typeof renderer.setNamedExpression === "function" && renderer.setNamedExpression(name, true)) return true;
            // 没有这个表情名时退回情绪通道（normalizePresentationIntent 会映射成对应脸）
            if (body && typeof body.setEmotion === "function") { body.setEmotion(name); return false; }
          } catch (e) { try { __silentAudit.audit('driver.js:676', e); } catch (e2) {} }
          return false;
        },
        clearExpression: (name) => {
          try { if (renderer && typeof renderer.setNamedExpression === "function") renderer.setNamedExpression(name, false); } catch (e) { try { __silentAudit.audit('driver.js:680', e); } catch (e2) {} }
        },
        playAction: (tag) => { try { return !!(body && body.playMotion && body.playMotion(tag)); } catch (e) { return false; } },
        // C-1b：说话时由桥通知「这句是什么情绪」→ 交给 petbody 写盘（重启后能恢复）
        onEmotion: (key) => { try { if (body && typeof body.persistEmotion === 'function') body.persistEmotion(key, 0.9); } catch (e) { /* ignore */ } },
      });
      prevEmotionMapper = global.emotionMapper || null;
      global.emotionMapper = bridge;          // TTS 的情绪管线（tts-playback-engine）会用它清洗 <开心> 并按位置触发
      ttsProcessor = context?.ttsProcessor || null;
      try { ttsProcessor && ttsProcessor.setEmotionMapper && ttsProcessor.setEmotionMapper(bridge); } catch (e) { try { __silentAudit.audit('driver.js:687', e); } catch (e2) {} }
      dbg("[bridge] 已安装 emotion bridge（6 情绪 → presets 表情 + 动作意图 → motion-vocab）");

      // ── 诊断：谁在写参数 ────────────────────────────────────────────────
      if (typeof window !== "undefined") {
        window.__petBodyDiag = () => collectDiag();
      }
      logDiag("after-init");
      if (diagTimer) clearInterval(diagTimer);
      diagTicks = 0;
      diagTimer = setInterval(() => {
        diagTicks += 1;
        const d = logDiag("tick" + diagTicks);
        // paramDirector 突然出现 = 有人把 live2d 栈又拉起来了，这才会和 motion-director 产生真冲突
        if (d.paramDirector) logToTerminal("warn", "[PetBody] 检测到 paramDirector 出现：motion-director 可能开始写参数（petbody 仲裁仍会拦下）");
        if (diagTicks >= 12) { clearInterval(diagTimer); diagTimer = null; }
      }, 5000);
      if (diagTimer.unref) diagTimer.unref();
      // 启动耗时打点（2026-11-15 六十三轮）：用户体感里「她出现得慢」一直没数字。
      // performance.now() 从页面开始计时；moc3 16MB + 纹理/资产是主要成本。
      try {
        logToTerminal("info", "[PetBody] 初始化耗时 " + Math.round(performance.now()) + "ms（页面开始→渲染接管）");
      } catch (e) { /* 打点失败不影响渲染 */ }
      return { app: null, stage: null, loader: null, model: body.renderer, info, diag: collectDiag() };
    },
    async dispose() {
      dbg("dispose");
      if (diagTimer) { clearInterval(diagTimer); diagTimer = null; }
      try { bridge && bridge.reset && bridge.reset(); } catch (e) { try { __silentAudit.audit('driver.js:710', e); } catch (e2) {} }
      try { global.emotionMapper = prevEmotionMapper || null; } catch (e) { try { __silentAudit.audit('driver.js:711', e); } catch (e2) {} }
      prevEmotionMapper = null; bridge = null; ttsProcessor = null;
      global.__petBodyActive = false;
      try { body?.dispose?.(); } catch (e) { try { __silentAudit.audit('driver.js:714', e); } catch (e2) {} }
      body = null; global.petBody = null; global.currentModel = null;
      logToTerminal("info", "[PetBody] 已卸载");
    },
    getModel() { return body ? body.renderer : null; },
    getController() { return null; },
    setEmotion(emotion) {
      try {
        if (bridge && bridge.playConfiguredEmotion(emotion)) {
          // 2026-11-10：伤口只在「对话/用户动作把她触动」时记 —— 这是唯一由外界触发的入口。
          //   她自己的情绪引擎快照不再记账（那条路径会自己把自己扣到 -1）。
          try {
            moodStore.note(emotion, 0.7, lastUserText);
            moodStore.feed(emotion);
          } catch (e) { try { __silentAudit.audit('driver.js:755', e); } catch (e2) {} }
          return;
        }
        body?.setEmotion?.(emotion);
      } catch (e) { try { __silentAudit.audit('driver.js:724', e); } catch (e2) {} }
    },
    setMouth(value) { try { body?.setMouth(value); } catch (e) { try { __silentAudit.audit('driver.js:726', e); } catch (e2) {} } },
    playMotion(indexOrGroup, index) {
      try {
        if (bridge) return !!bridge.playMotion(indexOrGroup);
        if (typeof indexOrGroup === "string") return body?.playMotion(indexOrGroup);
        return body?.playMotion("wave");
      } catch (e) { return false; }
    },
    // 诊断入口（控制台/远程排查用）
    diag() { return collectDiag(); },
  };
}

module.exports = { createPetBodyDriver, collectDiag };
