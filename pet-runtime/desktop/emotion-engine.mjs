// ⚠️ 状态：**未接线（inert）**。Lead 在 09:35 叫停 task-14，要求先出《宿主表情/动作引擎接入方案》。
//    本文件目前不被任何入口 import，打包不会带上它；单测 tools/emotion-engine-test.mjs 56/56 全绿，可作为方案落地时的现成实现。
//    接线与否、复用宿主引擎与否，取决于 docs/宿主表情动作引擎接入方案.md 的结论。
//
// emotion-engine.mjs —— 程序化「情绪引擎」v1
//
// 为什么不用表情文件：这套皮套的 23 个 exp3 全是换装配件（体型/眼镜/钢盆/圈圈眼…），
// 模型里**没有** happy/sad/angry 这种情绪表情。所以情绪必须靠**参数合成**：
// 眉毛 + 嘴角 + 眼型 + 瞳孔，几路小幅叠加就能读出「开心/难过/得意/心虚」。
//
// 这个模块是纯逻辑（无 DOM、无渲染器依赖）：
//   · feed() 把文本/事件变成「候选情绪」（L1 关键词 / L2 标点小动作 / L3 事件 / L4 标签）；
//   · 仲裁：L4 > L3 > L1 > L2，同层比强度、再比新旧；带 TTL 与同情绪冷却；
//   · tick(now) 只输出「目标参数值（归一化）+ 权重」，由 petbody-entry 做一阶低通后写入渲染器。
//
// 参数所有权（只碰这些，别的层在用的参数一律不写）：
//   Emotion, Emotion2, EyeSmile, PupilX, PupilY, BrowInnerUp,
//   ParamMouthForm, ParamBrowLY/RY, ParamBrowLAngle/RAngle, ParamBrowLY2/RY2,
//   ParamEyeLOpen/ROpen（0~1.5，能睁大到 1.3）
// 绝对不碰：ParamA/I/U/E/O、ParamMouthOpenY、ParamSilence（口型层）；
//   ParamBreath/Position/Hip/Lean/Shoulder（body-director）；ParamAngle*/BodyAngle（interaction）；
//   ParamEyeBallX/Y（眼神跟随）。点头/摇头这类动作走 playMotion，别写角度参数。
//
// 归一化公式（渲染层用）：实际写入 = def + (target - def) * intensity * weight
//   target 是本文件 EMOTIONS 表里的值，intensity 是规则强度，weight 是仲裁后的权重。

export const TUNING = {
  defaultTtlMs: 3200,
  emotionCooldownMs: 8000,      // 同一个情绪 8 秒内不重复触发
  globalMinGapMs: 140,          // 两次接受之间至少隔这么久（文本是分片到达的）
  bubbleMinGapMs: 1500,
  bubbleRepeatMs: 9000,
  maxPending: 3,
  layerWeight: { L4: 40, L3: 30, L1: 10, L2: 5 },
  // 同层覆盖判据：新强度要比旧的高这么多才抢
  sameLayerOverrideMargin: 0.12,
  idleHuffMs: 5 * 60 * 1000,    // 5 分钟没人理 → 打哈欠
  idleSleepyMs: 15 * 60 * 1000, // 15 分钟 → 犯困

  // ──「人味」参数（原来是硬切，像机器人在表情包之间跳）──────────────
  // 情绪不是开关，是余韵：演完不归零，落到这里留下的残余上
  residueWeight: 0.22,          // 余韵保留强度（0.22 = 情绪的 22% 留着）
  residueDecayMs: 2400,         // 余韵再过这么久才彻底散掉
  attackMs: 180,                // 起势：从 0 涨到目标用多久（人做表情不是瞬移）
  releaseMs: 900,               // 收势：从目标落回余韵用多久
  overlayMax: 2,                // 最多几层情绪叠加（真实的人会「笑着生气」）
  overlayFalloff: 0.55,         // 第 2 层按这个比例折算强度
  breathJitterMs: 2600,         // 微表情间隔：这么久没新情绪就抖一下
  breathStrength: 0.14,         // 微表情强度
};

// ── 情绪参数表（值都是归一化量，范围见文件头）──────────────────────────────
// 越靠后的继承前面的字段；ttl 可单独覆盖。
export const EMOTIONS = {
  neutral: { params: {}, ttl: 800, zh: '中性' },
  happy: {
    zh: '开心', ttl: 4000,
    params: { EyeSmile: 1, ParamMouthForm: 0.6, ParamBrowRY: 0.3, ParamBrowLY: 0.3 },
  },
  sad: {
    zh: '难过', ttl: 5000,
    params: { BrowInnerUp: 0.8, ParamBrowRAngle: -0.5, ParamBrowLAngle: -0.5, ParamMouthForm: -0.4, ParamEyeLOpen: 0.7, ParamEyeROpen: 0.7 },
  },
  angry: {
    zh: '生气', ttl: 3500,
    params: { ParamBrowRY: -0.6, ParamBrowLY: -0.6, ParamBrowRAngle: 0.5, ParamBrowLAngle: 0.5, ParamMouthForm: -0.5 },
  },
  surprise: {
    zh: '惊讶', ttl: 1800,
    params: { ParamBrowRY: 0.9, ParamBrowLY: 0.9, ParamEyeLOpen: 1.3, ParamEyeROpen: 1.3, ParamMouthForm: 0.15 },
  },
  shy: {
    zh: '害羞', ttl: 4500,
    params: { EyeSmile: 0.5, ParamMouthForm: 0.3, PupilX: -0.6, BrowInnerUp: 0.2 },
  },
  smug: {
    zh: '得意', ttl: 3500,
    params: { EyeSmile: 0.6, ParamMouthForm: 0.45, ParamBrowRY: 0.25, ParamBrowLY: 0.15, PupilX: 0.35 },
  },
  tease: {
    zh: '嘲讽', ttl: 3000,
    params: { EyeSmile: 0.35, ParamMouthForm: 0.3, ParamBrowRY: -0.25, ParamBrowRY2: -0.3, PupilX: 0.5 },
  },
  bored: {
    zh: '无聊', ttl: 4000,
    params: { ParamEyeLOpen: 0.62, ParamEyeROpen: 0.62, ParamMouthForm: -0.2, BrowInnerUp: 0.25 },
  },
  aggrieved: {
    zh: '委屈', ttl: 4500,
    params: { BrowInnerUp: 0.95, ParamMouthForm: -0.55, ParamEyeLOpen: 0.82, ParamEyeROpen: 0.82, ParamBrowRAngle: -0.35, ParamBrowLAngle: -0.35 },
  },
  guilty: {
    zh: '心虚', ttl: 3000,
    params: { PupilX: 0.55, PupilY: 0.45, EyeSmile: 0.15, ParamBrowLY: 0.2, ParamMouthForm: -0.15 },
  },
  sleepy: {
    zh: '困', ttl: 5000,
    params: { ParamEyeLOpen: 0.45, ParamEyeROpen: 0.45, ParamMouthForm: -0.1, BrowInnerUp: 0.2 },
  },
};

// ── L1 词表（≥40 条；按人设：傲娇/爱吐槽/嘴硬心软）────────────────────────
// [词, 情绪, 强度, ttl?] —— 先长词后短词匹配，命中即用第一条。
export const WORD_LIST = [
  // 开心
  ['笑死我了', 'happy', 0.95], ['笑死', 'happy', 0.9], ['太好了', 'happy', 0.85], ['好耶', 'happy', 0.85],
  ['哈哈', 'happy', 0.9], ['嘿嘿', 'happy', 0.72], ['开心', 'happy', 0.82], ['高兴', 'happy', 0.82],
  ['厉害', 'happy', 0.62], ['可爱', 'happy', 0.7], ['喜欢', 'happy', 0.7], ['好玩', 'happy', 0.6],
  ['笑', 'happy', 0.6], ['嗯哼', 'happy', 0.5],
  // 难过
  ['难过', 'sad', 0.82], ['伤心', 'sad', 0.82], ['哭', 'sad', 0.72], ['唉', 'sad', 0.6],
  ['累', 'sad', 0.55], ['算了', 'sad', 0.5], ['没劲', 'bored', 0.65],
  // 生气（短促）
  ['气死', 'angry', 0.92], ['生气', 'angry', 0.85], ['恼火', 'angry', 0.8], ['讨厌', 'angry', 0.72],
  ['烦', 'angry', 0.7], ['过分', 'angry', 0.7], ['凭什么', 'angry', 0.7], ['少来', 'angry', 0.6],
  ['你管我', 'angry', 0.6], ['喂', 'angry', 0.45],
  // 怕 / 惊讶
  ['救命', 'surprise', 0.85], ['恐怖', 'surprise', 0.8], ['可怕', 'surprise', 0.75], ['吓', 'surprise', 0.75],
  ['真的吗', 'surprise', 0.78], ['不会吧', 'surprise', 0.75], ['哇', 'surprise', 0.7], ['怎么会', 'surprise', 0.66],
  ['难道', 'surprise', 0.6], ['什么', 'surprise', 0.55], ['啥', 'surprise', 0.55], ['为什么', 'surprise', 0.6],
  // 害羞
  ['害羞', 'shy', 0.85], ['脸红', 'shy', 0.85], ['不好意思', 'shy', 0.7], ['讨厌啦', 'shy', 0.7],
  ['别说了', 'shy', 0.65],
  // 得意
  ['我厉害吧', 'smug', 0.8], ['那当然', 'smug', 0.72], ['得意', 'smug', 0.8], ['当然', 'smug', 0.6],
  ['想得美', 'smug', 0.6], ['哼', 'smug', 0.55],
  // 嘲讽
  ['就这', 'tease', 0.78], ['切', 'tease', 0.62], ['你猜', 'tease', 0.55], ['逗你', 'tease', 0.6],
  ['谁说的', 'tease', 0.55],
  // 无聊 / 困
  ['无聊', 'bored', 0.8], ['好闲', 'bored', 0.6],
  ['好困', 'sleepy', 0.85], ['困', 'sleepy', 0.75], ['打哈欠', 'sleepy', 0.7], ['想睡', 'sleepy', 0.7],
  // 委屈 / 心虚
  ['委屈', 'aggrieved', 0.85], ['欺负', 'aggrieved', 0.8], ['你坏', 'aggrieved', 0.6],
  ['心虚', 'guilty', 0.8], ['呃', 'guilty', 0.45], ['那个', 'guilty', 0.4],
];

// ── L2 标点 / 句式 → 小动作（只出动作，不动表情）─────────────────────────
const L2_RULES = [
  { test: (text) => /！！|!!/.test(text), action: 'shrug', strength: 0.62, name: 'double-exclaim' },
  { test: (text) => /[！!]/.test(text), action: 'nod head', strength: 0.55, name: 'exclaim' },
  { test: (text) => /[？?]/.test(text), action: 'tilt head right', strength: 0.5, name: 'question' },
  { test: (text) => /…|——|\.\.\./.test(text), action: 'lean forward', strength: 0.45, name: 'ellipsis' },
];

// ── L3 事件表 ──────────────────────────────────────────────────────────────
// ⚠ 事件名是宿主 ↔ 引擎的契约（2026-11-21 P1）：
//   宿主曾经发 'pat_head' / 'tap'，而这里只有 'headpat' / 'poke' → handleEvent 查不到、
//   返回 false，调用方又把返回值丢了 → 摸头/单点「静默无反应」，日志一片安静。
//   现在两边统一以这张表的 key 为准（宿主 feed 已改名）；旧名保留别名做兼容，
//   真正未知的事件会计数 + 发声（见 handleEvent），不再悄悄吞掉。
const EVENT_RULES = {
  hover: { emotion: 'shy', strength: 0.3, ttl: 1200, action: 'tilt head right' },
  dblclick: { emotion: 'happy', strength: 0.9, ttl: 2200, action: 'laugh', bubble: '嘿嘿' },
  drag: { emotion: 'surprise', strength: 0.85, ttl: 2200, action: 'shake head' },
  drop: { emotion: 'aggrieved', strength: 0.8, ttl: 2600, action: 'bow', bubble: '放我下来' },
  poke: { emotion: 'tease', strength: 0.7, ttl: 2000, action: 'shrug', bubble: '干嘛~' },
  headpat: { emotion: 'shy', strength: 0.9, ttl: 3000, action: 'tilt head left', bubble: '呀…' },
  spam3: { emotion: 'surprise', strength: 1.0, ttl: 2500, action: 'shake head', bubble: '别戳了' },
  listen_start: { action: 'tilt head right', strength: 0.55, ttl: 1500 },
  idle5m: { emotion: 'sleepy', strength: 0.6, ttl: 4000, action: 'stretch', bubble: '啊…' },
  idle15m: { emotion: 'sleepy', strength: 1.0, ttl: 6000, action: 'bow', bubble: '好困…' },
  // 用户的语气会影响她的反应：他激动她也来劲，他低落她收敛
  user_excited: { emotion: 'surprise', strength: 0.55, ttl: 1800, action: 'nod head' },
  user_low: { emotion: 'aggrieved', strength: 0.45, ttl: 2600, action: 'tilt head left' },
  work_thinking: { action: 'think', strength: 0.6, ttl: 1500 },
  work_running: { action: 'busy', strength: 0.6, ttl: 1500 },
  work_done: { emotion: 'smug', strength: 0.8, ttl: 2500, action: 'nod head' },
};

// 旧宿主/插件用过的名字 → 表里的规范名。只做兼容，新代码一律用规范名。
const EVENT_ALIASES = Object.freeze({
  pat_head: 'headpat',
  head_pat: 'headpat',
  pathead: 'headpat',
  tap: 'poke',
  click: 'poke',
  doubleclick: 'dblclick',
});

// 标签 → 情绪（L4）
const TAG_EMOTION_ALIASES = {
  开心: 'happy', 高兴: 'happy', 快乐: 'happy', happy: 'happy', joy: 'happy',
  难过: 'sad', 伤心: 'sad', sad: 'sad',
  生气: 'angry', 愤怒: 'angry', angry: 'angry',
  惊讶: 'surprise', 惊喜: 'surprise', surprised: 'surprise',
  害羞: 'shy', 脸红: 'shy', shy: 'shy',
  得意: 'smug', 自豪: 'smug', smug: 'smug',
  嘲讽: 'tease', 吐槽: 'tease', tease: 'tease',
  无聊: 'bored', bored: 'bored',
  委屈: 'aggrieved', aggrieved: 'aggrieved',
  心虚: 'guilty', guilty: 'guilty',
  困: 'sleepy', 犯困: 'sleepy', sleepy: 'sleepy',
  中性: 'neutral', neutral: 'neutral',
};

function nowOr(now, fallback) { return Number.isFinite(now) ? now : fallback; }

export function createEmotionEngine(options = {}) {
  const pose = options.pose || {};
  const onAction = typeof options.onAction === 'function' ? options.onAction : () => {};
  const onBubble = typeof options.onBubble === 'function' ? options.onBubble : () => {};
  const onWorkState = typeof options.onWorkState === 'function' ? options.onWorkState : () => {};
  const log = typeof options.log === 'function' ? options.log : () => {};
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const tuning = Object.assign({}, TUNING, options.tuning || {});

  const state = {
    active: null,            // { emotion, layer, strength, since, until, action, bubble, key }
    pending: [],             // 排队候选
    cooldowns: new Map(),    // emotion -> untilMs
    lastAcceptedAt: 0,
    lastBubbleAt: null,
    lastBubbleText: '',
    actionUntil: 0,
    actionLayer: 0,
    speaking: false,
    listening: false,
    lastInteractionAt: now(),
    idle5mFiredAt: 0,
    idle15mFiredAt: 0,
    shortRun: { count: 0, lastAt: 0 },
    counters: { feeds: 0, candidates: 0, accepted: 0, dropped: 0, queued: 0, expired: 0, bubbles: 0, unknownEvents: 0 },
    lastHit: null,
    lastUnknownEvent: '',
    unknownEventCounts: new Map(),   // 事件名 → 次数（排查「宿主发了引擎不认识的名字」）
    warnedEvents: new Set(),         // 同一个未知事件只喊一次，别刷屏
    residue: null,           // { emotion, weight, until }  上一个情绪的余韵
    envelope: { weight: 0, from: 0, target: 0, since: 0 },  // 起势/收势包络
    microUntil: 0,           // 微表情到期时间
    microSeed: 0,            // 微表情随机种子
    lastEmotionAt: 0,        // 上次情绪变化时间（判断该不该出微表情）
    lastTargets: {},         // 上一帧的参数目标，收势时继续送出去（形成余味）
  };

  // ── 候选构造 ────────────────────────────────────────────────────────────
  function candidate(layer, layerName, spec) {
    if (!spec || !spec.emotion && !spec.action && !spec.bubble) return null;
    const emotion = spec.emotion && EMOTIONS[spec.emotion] ? spec.emotion : null;
    return {
      layer, layerName,
      emotion,
      strength: Math.max(0, Math.min(1, Number(spec.strength) || 0.6)),
      ttl: Math.max(300, Number(spec.ttl) || (emotion ? EMOTIONS[emotion].ttl : tuning.defaultTtlMs)),
      action: spec.action || null,
      bubble: spec.bubble || null,
      key: spec.key || (layerName + ':' + (emotion || spec.action || 'bubble')),
      seq: ++state.counters.candidates,
    };
  }

  // L1：关键词（长词优先）
  function l1Candidates(text) {
    const out = [];
    const lower = String(text || '').toLowerCase();
    for (const row of WORD_LIST) {
      const word = row[0];
      const idx = lower.indexOf(String(word).toLowerCase());
      if (idx < 0) continue;
      const emotion = row[1], strength = row[2], ttl = row[3];
      const spec = { emotion, strength, ttl, key: 'L1:' + word };
      // 同一句里同一个情绪只取最强的一条
      if (!out.some((c) => c && c.emotion === emotion)) {
        const c = candidate(tuning.layerWeight.L1, 'L1', spec);
        if (c) { c.matched = word; out.push(c); }
      }
    }
    return out;
  }

  // L2：标点/句式（只出动作）
  function l2Candidates(text) {
    const out = [];
    for (const rule of L2_RULES) {
      if (!rule.test(text)) continue;
      const c = candidate(tuning.layerWeight.L2, 'L2', { action: rule.action, strength: rule.strength, key: 'L2:' + rule.name, ttl: 900 });
      if (c) out.push(c);
    }
    // 连续短句（≥3 句且每句 <8 字）→ 快速点头
    const parts = String(text || '').split(/[。！？!?；;\n]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 3 && parts.every((s) => s.length < 8)) {
      const c = candidate(tuning.layerWeight.L2, 'L2', { action: 'nod head', strength: 0.6, key: 'L2:short-run', ttl: 1200 });
      if (c) out.push(c);
    }
    return out;
  }

  // L4：模型标签 <表情:xx> / <动作:xx> / <开心>
  const TAG_PATTERN = /<([^<>]{1,16})>/g;
  function l4Candidates(text) {
    const out = [];
    let match;
    TAG_PATTERN.lastIndex = 0;
    while ((match = TAG_PATTERN.exec(String(text || ''))) !== null) {
      const inner = String(match[1] || '').trim();
      let m = /^(?:表情|emotion)[:：](.+)$/i.exec(inner);
      if (m) {
        const emo = TAG_EMOTION_ALIASES[m[1].trim()] || TAG_EMOTION_ALIASES[m[1].trim().toLowerCase()];
        const c = emo ? candidate(tuning.layerWeight.L4, 'L4', { emotion: emo, strength: 1, key: 'L4:' + emo }) : null;
        if (c) out.push(c);
        continue;
      }
      m = /^(?:动作|action)[:：](.+)$/i.exec(inner);
      if (m) {
        const c = candidate(tuning.layerWeight.L4, 'L4', { action: String(m[1]).trim(), strength: 1, key: 'L4:' + m[1], ttl: 1500 });
        if (c) out.push(c);
        continue;
      }
      const emo = TAG_EMOTION_ALIASES[inner] || TAG_EMOTION_ALIASES[inner.toLowerCase()];
      if (emo) {
        const c = candidate(tuning.layerWeight.L4, 'L4', { emotion: emo, strength: 1, key: 'L4:' + emo });
        if (c) out.push(c);
      }
    }
    return out;
  }

  // ── 仲裁 ────────────────────────────────────────────────────────────────
  function better(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.layer !== b.layer) return a.layer > b.layer ? a : b;
    if (Math.abs(a.strength - b.strength) > 0.02) return a.strength > b.strength ? a : b;
    return a.seq > b.seq ? a : b;
  }

  function inCooldown(emotion, t) {
    if (!emotion) return false;
    const until = state.cooldowns.get(emotion) || 0;
    return t < until;
  }

  function accept(cand, t) {
    if (cand.emotion) state.cooldowns.set(cand.emotion, t + tuning.emotionCooldownMs);
    state.active = {
      emotion: cand.emotion,
      layer: cand.layer,
      layerName: cand.layerName,
      strength: cand.strength,
      since: t,
      until: t + cand.ttl,
      action: cand.action,
      bubble: cand.bubble,
      key: cand.key,
      matched: cand.matched || null,
    };
    state.lastAcceptedAt = t;
    state.counters.accepted += 1;
    state.lastEmotionAt = t;
    // 新情绪来了，余韵立刻让位（不要和新情绪打架）
    if (state.residue && state.residue.emotion !== cand.emotion) state.residue = null;
    state.lastHit = { emotion: cand.emotion, layer: cand.layerName, strength: +cand.strength.toFixed(2), key: cand.key, matched: cand.matched || null, at: t };
    return state.active;
  }

  function emitBubble(text, t) {
    const value = String(text || '').trim();
    if (!value) return false;
    if (state.lastBubbleAt !== null && t - state.lastBubbleAt < tuning.bubbleMinGapMs) return false;
    if (value === state.lastBubbleText && state.lastBubbleAt !== null && t - state.lastBubbleAt < tuning.bubbleRepeatMs) return false;
    state.lastBubbleAt = t;
    state.lastBubbleText = value;
    state.counters.bubbles += 1;
    try { onBubble(value, { emotion: state.active && state.active.emotion, at: t }); } catch (_) {}
    return true;
  }

  // 候选 vs 当前激活：返回 'accept' | 'queue' | 'drop'
  function decide(cand, t) {
    const active = state.active;
    if (t - state.lastAcceptedAt < tuning.globalMinGapMs && active) return 'drop';
    // 同一个情绪正在演时，更强的一条算"刷新"（延长 TTL / 提高权重），不算重触发，不受冷却限制
    const refreshing = !!(active && cand.emotion && cand.emotion === active.emotion && t < active.until);
    if (!refreshing && cand.emotion && inCooldown(cand.emotion, t) && cand.layer < tuning.layerWeight.L4) return 'drop';
    if (!active || t >= active.until) return 'accept';
    if (cand.layer > active.layer) return 'accept';
    if (cand.layer === active.layer) {
      const sameEmotion = cand.emotion && cand.emotion === active.emotion;
      // 同一个情绪：更强就刷新 TTL（说"笑死"比"笑"更值得重播），否则丢弃
      if (sameEmotion) return cand.strength >= active.strength + tuning.sameLayerOverrideMargin ? 'accept' : 'drop';
      if (cand.key === active.key) return 'drop';
      if (cand.strength >= active.strength + tuning.sameLayerOverrideMargin) return 'accept';
      return 'queue';
    }
    return 'queue';
  }

  function enqueue(cand) {
    if (state.pending.length >= tuning.maxPending) { state.counters.dropped += 1; return; }
    state.pending.push(cand);
    state.counters.queued += 1;
  }

  // ── 对外 API ────────────────────────────────────────────────────────────
  // 动作是独立通道：情绪在演"开心"的同时也可以点头（L2 标点小动作），互不抢槽。
  function tryAction(cand, t) {
    if (!cand.action) return false;
    if (t < state.actionUntil && cand.layer < state.actionLayer) return false;   // 正在播更高优先级动作
    state.actionUntil = t + Math.max(600, cand.ttl);
    state.actionLayer = cand.layer;
    try { onAction(cand.action, { emotion: cand.emotion, layer: cand.layerName }); } catch (_) {}
    return true;
  }

  function consume(list, t) {
    const sorted = list.filter(Boolean).sort((a, b) => (b.layer - a.layer) || (b.strength - a.strength) || (b.seq - a.seq));
    for (const cand of sorted) {
      if (cand.emotion) {
        const verdict = decide(cand, t);
        if (verdict === 'accept') accept(cand, t);
        else if (verdict === 'queue') enqueue(cand);
        else state.counters.dropped += 1;
      }
      tryAction(cand, t);
      if (cand.bubble) emitBubble(cand.bubble, t);
    }
  }

  function feed(input = {}) {
    state.counters.feeds += 1;
    const t = nowOr(input.now, now());
    const kind = String(input.kind || 'llm');
    const text = String(input.text || '');

    if (kind === 'event') {
      const name = String(input.name || (input.meta && input.meta.name) || '');
      return handleEvent(name, input.meta || {}, t);
    }
    if (kind === 'emotion') {
      // 直接指定情绪（宿主 setEmotion / 调试通道用）
      const key = String(input.emotion || input.text || '').trim();
      if (!EMOTIONS[key]) return false;
      consume([candidate(tuning.layerWeight.L3, 'L3', {
        emotion: key, strength: Number.isFinite(input.strength) ? input.strength : 0.85,
        ttl: input.ttl, key: 'EXPLICIT:' + key,
      })], t);
      return true;
    }
    if (kind === 'work') {
      const workState = String((input.meta && (input.meta.state || input.meta.work)) || input.text || 'idle');
      try { onWorkState(workState); } catch (_) {}
      const spec = EVENT_RULES['work_' + workState];
      if (spec) consume([candidate(tuning.layerWeight.L3, 'L3', spec)], t);
      return true;
    }

    // 文本：L4 标签优先，其次是 L1 关键词、L2 标点
    const l4 = l4Candidates(text);
    if (l4.length) { consume(l4, t); return true; }
    const candidates = [...l1Candidates(text), ...l2Candidates(text)];
    if (candidates.length) consume(candidates, t);
    return candidates.length > 0;
  }

  function handleEvent(name, meta, t) {
    if (!name) return false;
    const raw = String(name);
    // 旧名兼容：宿主历史版本/第三方插件仍可能发 pat_head / tap
    const resolved = EVENT_ALIASES[raw] || raw;
    if (resolved === 'speak_start') { state.speaking = true; return true; }
    if (resolved === 'speak_end') { state.speaking = false; return true; }
    if (resolved === 'listen_start') { state.listening = true; return true; }
    if (resolved === 'listen_end') { state.listening = false; return true; }
    if (resolved === 'interaction') { state.lastInteractionAt = t; return true; }
    const spec = EVENT_RULES[resolved];
    if (!spec) {
      // 静默吞事件是「摸头没反应」查了半天的根因：返回值被调用方丢弃。
      // 这里必须留下可观测痕迹：计数 + 最近事件名 + 每个名字只喊一次。
      state.counters.unknownEvents += 1;
      state.lastUnknownEvent = raw;
      state.unknownEventCounts.set(raw, (state.unknownEventCounts.get(raw) || 0) + 1);
      if (!state.warnedEvents.has(raw)) {
        state.warnedEvents.add(raw);
        try { log('[event] 未识别事件 "' + raw + '"（宿主与引擎枚举不一致；已计数，本条只喊一次）'); } catch (_) {}
      }
      return false;
    }
    state.lastInteractionAt = t;
    consume([candidate(tuning.layerWeight.L3, 'L3', Object.assign({}, spec, { key: 'L3:' + resolved }))], t);
    return true;
  }

  function tick(nowMs) {
    const t = nowOr(nowMs, now());

    // 1) 到点回落 —— 但不是「啪」一下归零，而是留下一层余韵慢慢散掉。
    //    这是「人味」的关键：真人说完一句话，脸上的情绪不会瞬间消失。
    if (state.active && t >= state.active.until) {
      const expiryAt = state.active.until;
      if (state.active.emotion && state.active.emotion !== 'neutral') {
        state.residue = {
          emotion: state.active.emotion,
          weight: state.active.strength * tuning.residueWeight,
          until: t + tuning.residueDecayMs,
        };
      }
      state.active = null;
      state.counters.expired += 1;
      // 立刻把包络目标切到 0，并把收势起点回溯到「TTL 到期那一刻」——
      // 这样即使用户/测试一次性跳过很久（tick(4500)），也会立刻算出该衰减到哪。
      state.envelope.from = state.envelope.weight;
      state.envelope.target = 0;
      state.envelope.since = expiryAt;
      state.envelope.weight = 0;   // 让下面按 since 重新积分
    }
    // 2) 排队里挑一个还能用的接上（不回队）
    if (!state.active && state.pending.length) {
      const sorted = state.pending.splice(0).filter((c) => !(c.emotion && inCooldown(c.emotion, t)));
      const winner = sorted.reduce((a, b) => better(a, b), null);
      if (winner) accept(winner, t);
      else state.counters.dropped += sorted.length ? sorted.length : 0;
    }
    // 3) 闲置事件（只在没在说话时触发）
    if (!state.speaking) {
      const idleFor = t - state.lastInteractionAt;
      if (idleFor >= tuning.idleSleepyMs && t - state.idle15mFiredAt >= tuning.idleSleepyMs) {
        state.idle15mFiredAt = t;
        consume([candidate(tuning.layerWeight.L3, 'L3', Object.assign({}, EVENT_RULES.idle15m, { key: 'L3:idle15m' }))], t);
      } else if (idleFor >= tuning.idleHuffMs && t - state.idle5mFiredAt >= tuning.idleHuffMs) {
        state.idle5mFiredAt = t;
        consume([candidate(tuning.layerWeight.L3, 'L3', Object.assign({}, EVENT_RULES.idle5m, { key: 'L3:idle5m' }))], t);
      }
    }

    return output(t);
  }

  // ── 微表情：长时间没有新情绪时，让眉毛/嘴角自己抖一下，避免「石化」──────
  function microTwitch(t) {
    if (t < state.microUntil) return null;
    if (t - state.lastEmotionAt < tuning.breathJitterMs) return null;
    // 用确定性伪随机（同一秒内稳定），避免每帧乱跳
    state.microSeed = (state.microSeed * 1103515245 + 12345) & 0x7fffffff;
    const r = (state.microSeed % 1000) / 1000;
    const set = [
      { ParamBrowRY: 0.08, ParamBrowLY: 0.05 },
      { ParamMouthForm: 0.07, EyeSmile: 0.06 },
      { PupilX: 0.10, ParamEyeLOpen: 0.04 },
      { ParamBrowLY: 0.09, ParamMouthForm: -0.04 },
    ][Math.floor(r * 4)];
    state.microUntil = t + 700 + Math.floor(r * 600);
    return set;
  }

  // ── 起势/收势包络：情绪不瞬移 ─────────────────────────────────────────
  function envelopeScale(t, targetWeight) {
    const env = state.envelope;
    if (targetWeight !== env.target) {
      // 目标变了：记下当前实际值作为起点，重新计时。
      // 只有「从无到有」的起势才允许直跳到目标（情绪一触发就该被看见）；
      // 回落（target=0）必须走缓动，否则就没有余味。
      if (env.weight === 0 && targetWeight > 0) env.weight = targetWeight;
      env.from = env.weight;
      env.target = targetWeight;
      env.since = t;
      if (targetWeight > 0) return env.weight;
      // target 落到 0：继续往下走缓动，不提前 return
    }
    const dur = targetWeight >= env.from ? tuning.attackMs : tuning.releaseMs;
    const k = Math.min(1, Math.max(0, (t - env.since) / Math.max(1, dur)));
    const rising = targetWeight >= env.from;
    const eased = rising ? 1 - Math.pow(1 - k, 2) : (k * k * (3 - 2 * k));
    env.weight = env.from + (targetWeight - env.from) * eased;
    if (Math.abs(env.weight - targetWeight) < 0.004) env.weight = targetWeight;
    return env.weight;
  }

  function output(t) {
    const active = state.active;

    // 主情绪 + 叠加层（最多 overlayMax 层，第 2 层按 overlayFalloff 折算）
    const layers = [];
    if (active) layers.push({ emotion: active.emotion, strength: active.strength, source: 'active' });

    const merged = {};
    let totalW = 0;
    const applied = [];
    layers.slice(0, tuning.overlayMax).forEach((layer, idx) => {
      const table = EMOTIONS[layer.emotion] || EMOTIONS.neutral;
      const scale = idx === 0 ? 1 : tuning.overlayFalloff;
      const w = layer.strength * scale;
      for (const [name, target] of Object.entries(table.params || {})) {
        const prev = merged[name] !== undefined ? merged[name] : 0;
        merged[name] = prev + (target - prev) * (w / Math.max(0.001, totalW + w));
      }
      totalW += w;
      applied.push({ emotion: layer.emotion, strength: +w.toFixed(2), source: layer.source });
    });

    // 包络：起势快、收势慢。状态机归零时 weight 会走 releaseMs 缓慢降到 0，
    // 而下游 0.15s 低通会让参数跟着慢慢回落 —— 这就是「余味」，不需要额外存 residue。
    const weight = envelopeScale(t, active ? active.strength : 0);

    // 微表情：情绪淡下去时让眉毛/嘴角自己动一下，避免石化
    if (weight < 0.5) {
      const micro = microTwitch(t);
      if (micro) for (const [k2, v] of Object.entries(micro)) merged[k2] = (merged[k2] || 0) + v * tuning.breathStrength * 6;
    }

    if (!active) {
      // 状态上就是 neutral；但只要包络还没落到 0，就把上一次的参数尾巴继续送出去，
      // 让渲染层平滑收势（weight 逐渐归零 = 余味散尽）。
      const tailW = weight;
      return {
        emotion: 'neutral', zh: '中性',
        targets: tailW > 0.01 ? (state.lastTargets || {}) : {},
        weight: +tailW.toFixed(3),
        until: 0, remaining: 0,
        layer: 0, layerName: tailW > 0.01 ? 'tail' : '',
        action: null, key: null, layers: applied,
      };
    }

    // 记住这一帧的参数，供收势时继续送
    state.lastTargets = merged;

    const table = EMOTIONS[active.emotion] || EMOTIONS.neutral;
    return {
      emotion: active.emotion,
      zh: table.zh,
      targets: merged,
      weight: +weight.toFixed(3),
      until: active.until,
      remaining: Math.max(0, active.until - t),
      layer: active.layer,
      layerName: active.layerName,
      action: active.action,
      key: active.key,
      matched: active.matched || null,
      layers: applied,
    };
  }

  function snapshot() {
    const t = now();
    return {
      emotion: state.active ? state.active.emotion : 'neutral',
      layer: state.active ? state.active.layerName : '',
      strength: state.active ? +state.active.strength.toFixed(2) : 0,
      remainingMs: state.active ? Math.max(0, Math.round(state.active.until - t)) : 0,
      key: state.active ? state.active.key : null,
      speaking: state.speaking,
      pending: state.pending.length,
      cooldowns: [...state.cooldowns.entries()].filter(([, u]) => u > t).map(([k, u]) => k + ':' + Math.round(u - t) + 'ms'),
      lastHit: state.lastHit,
      counters: Object.assign({}, state.counters),
      lastUnknownEvent: state.lastUnknownEvent || '',
      unknownEventCounts: Object.fromEntries(state.unknownEventCounts.entries()),
    };
  }

  function reset() {
    state.active = null; state.pending = []; state.cooldowns.clear();
    state.lastAcceptedAt = 0; state.lastBubbleAt = null; state.lastBubbleText = '';
    state.actionUntil = 0; state.actionLayer = 0;
    state.speaking = false; state.listening = false;
    state.lastInteractionAt = now();
    state.counters = { feeds: 0, candidates: 0, accepted: 0, dropped: 0, queued: 0, expired: 0, bubbles: 0, unknownEvents: 0 };
    state.lastHit = null;
    state.lastUnknownEvent = '';
    state.unknownEventCounts.clear();
    state.warnedEvents.clear();
  }

  // 渲染层要用的参数名清单（entry 用它准备 def 基线）
  const OWNED_PARAMS = ['Emotion', 'Emotion2', 'EyeSmile', 'PupilX', 'PupilY', 'BrowInnerUp',
    'ParamMouthForm', 'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLAngle', 'ParamBrowRAngle',
    'ParamBrowLY2', 'ParamBrowRY2', 'ParamEyeLOpen', 'ParamEyeROpen'];

  return { feed, tick, snapshot, reset, handleEvent, OWNED_PARAMS, EMOTIONS, WORD_LIST, tuning };
}

/**
 * canvas 交互监听的绑定/解绑（2026-11-21 P2）。
 *
 * 为什么单独抽出来：原来监听器是匿名 addEventListener，dispose 只能清
 * canvas.__petEmotionBound 之外什么都做不了；换了模型再切回来，标记还在 →
 * bindEmotionInteraction 直接 return → 交互不再驱动情绪。
 * 这个 helper 把「挂了哪些函数」记下来，dispose 时逐一 removeEventListener 并清标记。
 *
 * @param {{addEventListener:Function,removeEventListener:Function}} canvas
 * @param {Record<string, (event:any)=>void>} handlers 事件类型 → 处理函数
 * @returns {{dispose:()=>void, readonly disposed:boolean, readonly size:number}}
 */
export function bindCanvasListeners(canvas, handlers = {}) {
  const bound = [];
  if (!canvas || typeof canvas.addEventListener !== 'function') {
    return { dispose() {}, get disposed() { return true; }, get size() { return 0; } };
  }
  for (const type of Object.keys(handlers)) {
    const fn = handlers[type];
    if (typeof fn !== 'function') continue;
    canvas.addEventListener(type, fn);
    bound.push([type, fn]);
  }
  canvas.__petEmotionBound = true;
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [type, fn] of bound) {
        try { canvas.removeEventListener(type, fn); } catch (_) { /* 旧环境可能不支持 */ }
      }
      bound.length = 0;
      try { canvas.__petEmotionBound = false; } catch (_) { /* 只读 canvas 忽略 */ }
    },
    get disposed() { return disposed; },
    get size() { return bound.length; },
  };
}

// 渲染层可直接用：给定 def 与归一化目标，算实际写入值（并 clamp 到模型范围）
export function blendParam(def, target, intensityWeight, min = -1, max = 1) {
  const w = Math.max(0, Math.min(1, Number(intensityWeight) || 0));
  const d = Number(def) || 0;
  const value = d + ((Number(target) || 0) - d) * w;
  return Math.max(min, Math.min(max, value));
}

export default { createEmotionEngine, blendParam, EMOTIONS, WORD_LIST, TUNING };