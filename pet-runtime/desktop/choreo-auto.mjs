// choreo-auto.mjs —— 长表演的自动触发决策（v3，2026-11-16 深夜）
//
// 用户拍板两件事：
//   ① 「长表演不能只靠点击，要自动触发」——15 段都要能在日常里自己出现
//   ② 「融合好一点，别机械」——同一情绪可以有多段候选，不总是同一段
//
// 所以从「单段映射」升级成两条自动通道：
//   · 情绪通道（聊天时）：情绪键 → **候选段列表**，挑最久没演的那段
//   · 空闲通道（没人说话时）：她安静站着 ≥2.5 分钟，偶尔自己练一段
//     - 日常小段：05 换重心 / 06 竖指 / 07 抚胸 / 08 狗尾草 / 01 疑惑
//     - 稀有段：13 换装表演（会变 Q 版），概率压到 4%，只在长空闲出现
//
// 节流（真人不会每句话都演 20–38 秒的戏）：
//   强度门槛 0.35 / 全局 3 分钟 / 同段 6 分钟 / 单会话 12 段 / 空闲 8 分钟一次
//
// 为什么仍是纯函数：触发时机很难靠真机反复试，决策必须能单测（见 _probe/test-choreo-auto.mjs）。
//
// D6（2026-11-22）导演改戏：决策可带 tuning = choreo-tune 读 performance-log 算出的
// {segmentMultiplier, cooldownMultiplier}。倍率只乘在**同段冷却**和**候选先后**上，
// 不改情绪映射/强度门/全局冷却/会话上限；tuning 缺省时行为与旧版逐位一致。

/** 情绪 → 候选表演段（按优先级排列；同一情绪有多段时挑最久没演的）。 */
export const EMOTION_PERFORMANCES = {
  happy: ['04-playful', '15-flirt-layered', '03-pride'],
  sad: ['02-vulnerable', '09-composure'],
  aggrieved: ['02-vulnerable', '10-resolution'],
  surprise: ['12-bold-performance', '01-curiosity'],
  shy: ['14-flirt', '03-pride'],
  smug: ['03-pride', '09-composure'],
  tease: ['04-playful', '11-mischief', '15-flirt-layered'],
  guilty: ['11-mischief'],
  bored: ['05-weight-shift'],
  sleepy: ['05-weight-shift'],
};

/** 空闲通道的日常段：没有叙事情绪也能演（姿态调整 / 手势练习 / 好奇张望）。 */
export const IDLE_PERFORMANCES = [
  '05-weight-shift',
  '06-finger-articulation',
  '07-left-articulation',
  '08-grass-articulation',
  '01-curiosity',
];

/** 稀有段：13 会换装 + 变 Q 版，聊着天突然变身太吓人 ⇒ 只在长空闲低概率出现。 */
export const RARE_PERFORMANCES = ['13-form-performance'];

/** 明确不演的情绪（生气/中性硬套会「演得不像」）。这些继续走 v1 微动作。 */
export const NO_PERFORMANCE = new Set(['angry', 'neutral', '']);

/**
 * 「只在空闲通道演」的情绪（v3.1）：
 * bored/sleepy 是引擎的**空闲检测**（5/15 分钟没人说话）算出来的，不是这句话的情绪。
 * 聊天通道拿它们去演「换重心」= 用户一开口就看到她在无聊地换脚（真机抓到过）。
 * 空闲通道（安静够久）仍然可以用它们。
 */
export const IDLE_ONLY = new Set(['bored', 'sleepy']);

/** 兼容旧引用：情绪 → 首选段（单值映射）。新代码请用 EMOTION_PERFORMANCES。 */
export const EMOTION_PERFORMANCE = Object.fromEntries(
  Object.entries(EMOTION_PERFORMANCES).map(([k, list]) => [k, list[0]]),
);

export const DEFAULT_OPTIONS = Object.freeze({
  minStrength: 0.35,
  globalCooldownMs: 180 * 1000,
  perKeyCooldownMs: 6 * 60 * 1000,
  maxPerSession: 12,
  idleAfterMs: 150 * 1000,     // 至少 2.5 分钟没说话才考虑空闲演出
  idleCheckEveryMs: 20 * 1000, // 帧循环里多久评估一次空闲通道
  idleCooldownMs: 8 * 60 * 1000,
  idleChance: 0.30,            // 每次评估触发的概率（避免「一到点就必演」）
  rareChance: 0.04,            // 稀有段（13）每次评估的额外概率
});

function normalizeEmotion(emotion) {
  return String(emotion == null ? '' : emotion).trim().toLowerCase();
}

// ── D6 导演改戏（2026-11-22）：performance-log 回灌的倍率 ────────────────
// 只影响「冷却多久」和「同时候选里先挑谁」，不改情绪映射/强度门/会话上限。
// tuning 缺省（null/{enabled:false}/样本不足）时所有倍率都是 1.0，行为与旧版完全一致。
function clampTune(value) {
  return Math.min(2, Math.max(0.5, value));
}

/** 查找倍率：clip/segment key 优先，其次情绪；找不到 = 1。 */
function tuneMultiplier(map, key, emotion) {
  if (!map || typeof map !== 'object') return 1;
  const direct = Number(map[key]);
  if (Number.isFinite(direct)) return clampTune(direct);
  if (emotion) {
    const byEmotion = Number(map[emotion]);
    if (Number.isFinite(byEmotion)) return clampTune(byEmotion);
  }
  return 1;
}

/** 从候选里挑「最久没演」的一段；都没演过就取第一个。
 *  D6：优先级倍率只缩放「有效年龄」—— >1 的段看起来更久没演、更早被挑中。 */
function pickLeastRecent(candidates, lastByKey, tuning, emotion) {
  let best = null;
  let bestEffectiveAt = Infinity;
  for (const key of candidates) {
    const at = Number((lastByKey && lastByKey[key]) || 0);
    const priority = tuneMultiplier(tuning && tuning.segmentMultiplier, key, emotion);
    // at=0（从没演过）保持 0，仍然是最高优先；倍率只在「演过的段」之间调先后。
    const effectiveAt = at > 0 ? at / priority : 0;
    if (effectiveAt < bestEffectiveAt) { bestEffectiveAt = effectiveAt; best = key; }
  }
  return best;
}

function availableByKey(candidates, lastByKey, now, cooldownMs, tuning, emotion) {
  return candidates.filter((key) => {
    const at = Number((lastByKey && lastByKey[key]) || 0);
    if (!at) return true;
    const cooldown = cooldownMs * tuneMultiplier(tuning && tuning.cooldownMultiplier, key, emotion);
    return now - at >= cooldown;
  });
}

/**
 * 决定这一轮（聊天情绪）要不要自动演一段。
 * @returns {{ play: boolean, key: string|null, reason: string }}
 *   reason: ok / no-mapping / excluded / weak-emotion / global-cooldown / key-cooldown / session-cap
 */
export function decidePerformance(s) {
  const o = { ...DEFAULT_OPTIONS, ...(s && s.options ? s.options : {}) };
  const emotion = normalizeEmotion(s && s.emotion);
  const now = Number(s && s.now) || 0;
  const tuning = (s && s.tuning) || null;

  if (NO_PERFORMANCE.has(emotion)) return { play: false, key: null, reason: 'excluded' };
  if (IDLE_ONLY.has(emotion)) return { play: false, key: null, reason: 'idle-only' };
  const candidates = EMOTION_PERFORMANCES[emotion];
  if (!candidates || !candidates.length) return { play: false, key: null, reason: 'no-mapping' };

  const strength = Number(s && s.strength);
  if (!Number.isFinite(strength) || strength < o.minStrength) {
    return { play: false, key: null, reason: 'weak-emotion' };
  }

  const lastAt = Number(s && s.lastAt) || 0;
  if (lastAt > 0 && now - lastAt < o.globalCooldownMs) {
    return { play: false, key: null, reason: 'global-cooldown' };
  }
  const count = Number(s && s.sessionCount) || 0;
  if (count >= o.maxPerSession) return { play: false, key: null, reason: 'session-cap' };

  const lastByKey = s && s.lastByKey ? s.lastByKey : {};
  const available = availableByKey(candidates, lastByKey, now, o.perKeyCooldownMs, tuning, emotion);
  if (!available.length) return { play: false, key: null, reason: 'key-cooldown' };

  return { play: true, key: pickLeastRecent(available, lastByKey, tuning, emotion), reason: 'ok' };
}

/**
 * 决定「空闲时要不要自己演一段」。
 * @param {object} s
 * @param {number} s.now
 * @param {number} s.idleMs         已经多久没说话（ms）
 * @param {number} [s.lastAt]       上次任意自动表演
 * @param {number} [s.lastIdleAt]   上次空闲表演
 * @param {object} [s.lastByKey]
 * @param {number} [s.sessionCount]
 * @param {number} [s.rand]         0..1（测试注入；默认 Math.random）
 * @returns {{ play: boolean, key: string|null, reason: string }}
 *   reason: ok / not-idle / idle-cooldown / global-cooldown / session-cap / key-cooldown / idle-roll
 */
export function decideIdle(s) {
  const o = { ...DEFAULT_OPTIONS, ...(s && s.options ? s.options : {}) };
  const now = Number(s && s.now) || 0;
  const idleMs = Number(s && s.idleMs) || 0;
  const tuning = (s && s.tuning) || null;

  if (idleMs < o.idleAfterMs) return { play: false, key: null, reason: 'not-idle' };

  const lastAt = Number(s && s.lastAt) || 0;
  if (lastAt > 0 && now - lastAt < o.globalCooldownMs) {
    return { play: false, key: null, reason: 'global-cooldown' };
  }
  const lastIdleAt = Number(s && s.lastIdleAt) || 0;
  if (lastIdleAt > 0 && now - lastIdleAt < o.idleCooldownMs) {
    return { play: false, key: null, reason: 'idle-cooldown' };
  }
  const count = Number(s && s.sessionCount) || 0;
  if (count >= o.maxPerSession) return { play: false, key: null, reason: 'session-cap' };

  const lastByKey = s && s.lastByKey ? s.lastByKey : {};
  const available = availableByKey(IDLE_PERFORMANCES, lastByKey, now, o.perKeyCooldownMs, tuning, '');
  const rareAvailable = availableByKey(RARE_PERFORMANCES, lastByKey, now, o.perKeyCooldownMs, tuning, '');
  if (!available.length && !rareAvailable.length) return { play: false, key: null, reason: 'key-cooldown' };

  const rand = Number.isFinite(Number(s && s.rand)) ? Number(s.rand) : Math.random();
  if (rand > o.idleChance) return { play: false, key: null, reason: 'idle-roll' };

  // 稀有段用第二个随机数：同一个 rand 既控「演不演」又控「演哪段」会耦合，测试不好写
  const rand2 = Number.isFinite(Number(s && s.rand2)) ? Number(s.rand2) : Math.random();
  if (rareAvailable.length && rand2 < o.rareChance) {
    return { play: true, key: pickLeastRecent(rareAvailable, lastByKey, tuning, ''), reason: 'ok' };
  }
  if (!available.length) return { play: false, key: null, reason: 'key-cooldown' };
  return { play: true, key: pickLeastRecent(available, lastByKey, tuning, ''), reason: 'ok' };
}

/** 建一个触发器状态机：包住冷却记账，避免调用方各自维护一份。 */
export function createAutoTrigger(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const tuningProvider = typeof options.tuningProvider === 'function' ? options.tuningProvider : null;
  let tuning = (options.tuning && typeof options.tuning === 'object') ? options.tuning : null;
  let lastAt = 0;
  let lastIdleAt = 0;
  const lastByKey = Object.create(null);
  let sessionCount = 0;

  function resolveTuning() {
    if (!tuningProvider) return tuning;
    try {
      const next = tuningProvider();
      if (next && typeof next === 'object') tuning = next;
    } catch (e) { /* 读日志失败 = 不调参，绝不影响表演 */ }
    return tuning;
  }

  function record(key, now) {
    lastAt = now;
    if (key) lastByKey[key] = now;
    sessionCount += 1;
  }

  return {
    /** 聊天情绪通道：调用一次做决策；返回 play 时内部已记账。 */
    consider({ emotion, strength, now }) {
      const d = decidePerformance({
        emotion, strength, now, lastAt, lastByKey, sessionCount, options: opts,
        tuning: resolveTuning(),
      });
      if (d.play) record(d.key, now);
      return d;
    },
    /** 空闲通道：调用一次做决策；返回 play 时内部已记账。 */
    considerIdle({ now, idleMs, rand, rand2 }) {
      const d = decideIdle({
        now, idleMs, lastAt, lastIdleAt, lastByKey, sessionCount, rand, rand2, options: opts,
        tuning: resolveTuning(),
      });
      if (d.play) { record(d.key, now); lastIdleAt = now; }
      return d;
    },
    /** 手动播放后同步记账：防止「手动演完一句钟后又自动演同一段」。 */
    note(key, now) {
      lastAt = now;
      if (key) lastByKey[key] = now;
    },
    /** D6：外部（测试/热更新）直接换倍率表；不传 = 关闭调参。 */
    setTuning(next) {
      tuning = (next && typeof next === 'object') ? next : null;
      return tuning;
    },
    getTuning() { return tuning; },
    reset() {
      lastAt = 0;
      lastIdleAt = 0;
      for (const k of Object.keys(lastByKey)) delete lastByKey[k];
      sessionCount = 0;
    },
    snapshot() {
      return { lastAt, lastIdleAt, lastByKey: { ...lastByKey }, sessionCount, options: { ...opts }, tuning };
    },
    get sessionCount() { return sessionCount; },
  };
}
