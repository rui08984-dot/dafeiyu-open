// facs-clip-director.mjs —— 面部片段的「规则导演」（2026-11-17 六十三轮）
//
// 职责：给定「此刻的情绪与情境」，从 97 段 FACS 片段里挑一段播，或者明确说「不演」。
//
// 为什么先是规则，不是模型（ADR-003）：
//   1. 可解释：每次都能说清「为什么选它 / 为什么不演」，出问题能复盘；
//   2. 可测：纯函数，node 里跑断言；
//   3. **它本身就在采集标注** —— 「什么情境下演了哪段、用户有没有打断」就是将来
//      训学习型 ranker 的数据。先跑规则，等于免费攒数据。
//
// 判据（按顺序，先命中先返回；每条都有 reason 字符串）：
//   ① speaking            —— 在说话：嘴归口型层，片段会把嘴屏蔽掉，演起来是半张脸，干脆不演
//   ② away                —— 人不在：演给谁看
//   ③ weak-emotion        —— 情绪强度 < weakBelow：没情绪就别硬演（这是「假动作」的来源）
//   ④ cooldown            —— 全局冷却：两次表演之间至少 gapMs
//   ⑤ no-candidate        —— 候选里没有「够强 + 没刚播过」的段
//   ⑥ max-per-10min       —— 10 分钟内表演次数上限（防话痨化）
//
// 候选筛选：
//   - 情绪 → label 列表（EMOTION_TO_LABELS）
//   - energy ≥ minEnergy（弱段演了跟没演一样，实测 clip 0 的 energy 只有 26）
//   - 同段冷却 sameClipMs 内不再播
//   - 排序：energy 降序 → 与上次 label 不同优先 → 确定性 hash（可复现）
//
// 纯模块：不 require fs / electron / DOM；索引由调用方传入。

/** 情绪 → 可用 label（顺序即优先级；这些 label 来自 LumenAct 的原始标注） */
export const EMOTION_TO_LABELS = Object.freeze({
  happy: ['微笑', '大眼微笑', '开心欢快', '微笑_闭眼', '欣慰宽慰'],
  playful: ['挑眉逗趣', '星星眼', '爱心眼', '卖萌和蔼安详'],
  surprised: ['惊讶震惊', '小眼震惊', '震惊疑惑质问'],
  angry: ['生气愤怒', '厌烦厌恶'],
  sad: ['难过流泪', '痛苦疼痛', '担忧担心'],
  shy: ['害羞', '尴尬', '道歉抱歉'],
  smug: ['骄傲自豪'],
  neutral: ['自然放松', '思考专注'],
  // 空闲类（老引擎在长时间没人理时会自己发 bored/sleepy）
  // 注：LumenAct 里「感觉无聊无趣」的 energy 只有 123、「睡眼朦胧敷衍」122，都低于
  //     150 的门槛 —— 硬映射会「无候选」。所以映射到够强的待机段（专注/放松）。
  bored: ['思考专注', '自然放松'],
  sleepy: ['自然放松', '思考专注'],
});

/** 中文情绪名 / 旧引擎原型名 → 上面的键（宿主链路里三套词汇并存） */
export const EMOTION_ALIASES = Object.freeze({
  // 中文（词表/LLM 打标）
  开心: 'happy', 高兴: 'happy', 快乐: 'happy', 欣慰: 'happy',
  俏皮: 'playful', 调皮: 'playful', 好奇: 'playful',
  惊讶: 'surprised', 惊喜: 'surprised', 震惊: 'surprised',
  生气: 'angry', 愤怒: 'angry', 厌烦: 'angry',
  难过: 'sad', 伤心: 'sad', 委屈: 'sad', 担忧: 'sad', 焦虑: 'sad',
  害羞: 'shy', 脸红: 'shy', 尴尬: 'shy',
  得意: 'smug', 骄傲: 'smug',
  平静: 'neutral', 中性: 'neutral', 思考: 'neutral',
  // 英文（词表 / 我们的六类）
  happy: 'happy', joy: 'happy', joyful: 'happy', warm: 'happy',
  playful: 'playful', tease: 'playful', teasing: 'playful',
  surprised: 'surprised', surprise: 'surprised', shocked: 'surprised',
  angry: 'angry', mad: 'angry', annoyed: 'angry',
  sad: 'sad', aggrieved: 'sad', guilty: 'sad', anxiety: 'sad', worried: 'sad',
  shy: 'shy', embarrassed: 'shy', awkward: 'shy',
  smug: 'smug', proud: 'smug',
  neutral: 'neutral', calm: 'neutral', curious: 'neutral',
  bored: 'bored', sleepy: 'sleepy', tired: 'sleepy',
  // perf 引擎的原型名（吃过大亏：软情绪名不在表里 → 全被归成 neutral → 演「自然放松」）
  'soft-happy': 'happy', 'soft-positive': 'happy',
  'soft-calm': 'neutral', 'soft-steady': 'neutral', 'soft-curious': 'neutral',
  'soft-shy': 'shy', 'soft-uneasy': 'sad', 'soft-low': 'sad',
});

export const DIRECTOR_DEFAULTS = Object.freeze({
  minEnergy: 150,          // 片段可迁移强度下限（实测中位 162；<150 基本是微动）
  weakBelow: 0.35,         // 情绪强度低于它就不演
  gapMs: 90 * 1000,        // 两次表演之间的全局间隔
  sameClipMs: 6 * 60 * 1000, // 同一段多久内不重复
  maxPer10Min: 4,          // 10 分钟最多演几次
  windowMs: 10 * 60 * 1000,
  // ── 2026-11-25 P0 内容快胜（ADR-015 §3.0 组件 0.4，不改素材）────────────
  // 审计 §2.2：minEnergy=150 时 47/97 段不可达、playful 只剩 1 段、top4 长中性段
  // 吃掉 89% 播放。三条纯逻辑止血：
  //   ① 稀缺情绪把能量门放宽到 minEnergy × relaxFactor（不放弃弱段，但排在强段之后）；
  //   ② 时长预算 maxMs = f(intensity)：低强度只允许 ≤8s，高强度才放长段；
  //   ③ 每段每日播放上限（内存计数，防 top4 垄断；跨重启清零可接受）。
  relaxFactor: 0.5,        // 第二档能量门 = minEnergy × 0.5（75）
  minPoolPerEmotion: 5,    // 每个情绪至少要有 5 段可用（不够就借 neutral 通用段，排最后）
  maxPlaysPerClipPerDay: 8,
  shortMs: 8000,
  mediumMs: 12000,
  longMs: 20000,
  maxMs: 45000,
});

/**
 * 时长预算（与 perf/director.mjs 同一口径；这里独立一份是为了片段导演可单测、
 * 不依赖 director 的会话逻辑）。
 * 低强度（≤0.4）只允许 ≤8s；0.4–0.8 逐步放宽；>0.8 才允许长段。
 */
export function maxMsForIntensity(intensity) {
  const i = Number.isFinite(Number(intensity)) ? Math.max(0, Math.min(1, Number(intensity))) : 0;
  if (i <= 0.4) return DIRECTOR_DEFAULTS.shortMs;
  if (i <= 0.6) return DIRECTOR_DEFAULTS.mediumMs;
  if (i <= 0.8) return DIRECTOR_DEFAULTS.longMs;
  return DIRECTOR_DEFAULTS.maxMs;
}

/** 通用段（稀缺情绪的兜底）：neutral 的两组 label */
const GENERIC_LABELS = Object.freeze(['自然放松', '思考专注']);

function dayKeyOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 把各种写法归一到 6 类情绪键 */
export function normalizeEmotion(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return 'neutral';
  const lower = raw.toLowerCase();
  if (EMOTION_TO_LABELS[lower]) return lower;
  if (EMOTION_ALIASES[raw]) return EMOTION_ALIASES[raw];
  if (EMOTION_ALIASES[lower]) return EMOTION_ALIASES[lower];
  return 'neutral';
}

/** 稳定的 32 位 hash（只用于 tie-break，可复现；不做安全用途） */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ── D6 导演改戏（2026-11-22）：performance-log 回灌的倍率 ────────────────
// 这份日志记的正是本导演的 clipId/label/emotion，所以倍率在这里直接可用。
// 只乘「同段冷却」和「label 优先级」；全局 gap / 10 分钟上限 / 候选池不变。
function clampTune(value) {
  return Math.min(2, Math.max(0.5, value));
}

function tuneMultiplier(map, keys) {
  if (!map || typeof map !== 'object') return 1;
  for (const key of keys) {
    if (key == null || key === '') continue;
    const n = Number(map[String(key)]);
    if (Number.isFinite(n)) return clampTune(n);
  }
  return 1;
}

/**
 * 创建导演。
 * @param {object} index   facs-clips/index.json（clips 至少要有 id/label/emotion/energy/durationMs）
 * @param {object} opts    覆盖 DIRECTOR_DEFAULTS；seed 用于可复现的 tie-break
 */
export function createClipDirector(index, opts = {}) {
  const cfg = Object.assign({}, DIRECTOR_DEFAULTS, opts);
  const seed = Number.isFinite(Number(opts.seed)) ? Number(opts.seed) : 20261117;
  const clips = (index && index.clips) || [];
  const byLabel = new Map();
  for (const c of clips) {
    if (!c || !c.label) continue;
    if (!byLabel.has(c.label)) byLabel.set(c.label, []);
    byLabel.get(c.label).push(c);
  }

  // D6：tuning 可由调用方热更新（读日志的 provider）；读不到就保持旧值/空表。
  const tuningProvider = typeof opts.tuningProvider === 'function' ? opts.tuningProvider : null;
  let tuning = (opts.tuning && typeof opts.tuning === 'object') ? opts.tuning : null;
  function resolveTuning() {
    if (!tuningProvider) return tuning;
    try {
      const next = tuningProvider();
      if (next && typeof next === 'object') tuning = next;
    } catch (e) { /* 日志读失败 = 不调参，绝不影响表演 */ }
    return tuning;
  }

  const state = {
    lastAt: 0,
    lastClipId: null,
    lastLabel: null,
    playedAt: new Map(),     // clipId → ms
    recent: [],              // 最近播放时刻（用于 10 分钟上限）
    stats: { decisions: 0, played: 0, skipped: 0, byReason: {} },
    // P0：每段每日播放上限（内存计数；跨重启清零可接受 —— 重启后 top4 也只是多播几次）
    daily: { key: '', counts: new Map() },
  };

  function rollDaily(now) {
    const key = dayKeyOf(now);
    if (state.daily.key !== key) state.daily = { key, counts: new Map() };
    return state.daily;
  }

  function dailyCount(clipId) {
    return Number(state.daily.counts.get(String(clipId)) || 0);
  }

  const reason = (code, detail) => {
    state.stats.byReason[code] = (state.stats.byReason[code] || 0) + 1;
    state.stats.skipped += 1;
    return { clipId: null, label: null, reason: code, detail: detail || null };
  };

  /**
   * 决定这一拍演不演。
   * @param {{emotion?:string, intensity?:number, activity?:string, speaking?:boolean, nowMs?:number}} ctx
   */
  function decide(ctx = {}) {
    state.stats.decisions += 1;
    const now = Number.isFinite(Number(ctx.nowMs)) ? Number(ctx.nowMs) : Date.now();
    const emotion = normalizeEmotion(ctx.emotion);
    const intensity = Number.isFinite(Number(ctx.intensity)) ? Number(ctx.intensity) : 0;
    const activity = String(ctx.activity || '');
    const tune = resolveTuning();

    if (ctx.speaking === true) return reason('speaking');
    // busy = 全身长表演正在演（参数轨道直写面部）。两条路同时写 = 双写入者，
    // 违反 ADR-002 的所有权 —— 这里直接让位（用户 2026-11-17 未拍板时取最保守选项）。
    if (ctx.busy === true) return reason('busy');
    if (activity === 'away') return reason('away');
    if (intensity < cfg.weakBelow) return reason('weak-emotion', { intensity, weakBelow: cfg.weakBelow });
    if (state.lastAt && now - state.lastAt < cfg.gapMs) {
      return reason('cooldown', { sinceLastMs: now - state.lastAt, gapMs: cfg.gapMs });
    }
    // 10 分钟窗口内的次数上限
    state.recent = state.recent.filter((t) => now - t < cfg.windowMs);
    if (state.recent.length >= cfg.maxPer10Min) {
      return reason('max-per-10min', { count: state.recent.length, max: cfg.maxPer10Min });
    }

    const labels = EMOTION_TO_LABELS[emotion] || [];
    // P0：时长预算（调用方可显式传 maxMs；否则由强度推）
    const maxMs = Number.isFinite(Number(ctx.maxMs)) ? Math.max(1, Number(ctx.maxMs)) : maxMsForIntensity(intensity);
    rollDaily(now);
    const pool = [];
    let ownAvailable = 0;

    /**
     * 段能不能进候选池：时长门 + 日上限 + 同段冷却（冷却单独判，因为「可用性」统计不含它）。
     * @returns {'added'|'cooldown'|'skip'}
     */
    const consider = (clip, label, labelRank, tier) => {
      const energy = Number(clip.energy) || 0;
      const duration = Number(clip.durationMs);
      if (Number.isFinite(duration) && duration > 0 && duration > maxMs) return 'skip';
      if (dailyCount(clip.id) >= cfg.maxPlaysPerClipPerDay) return 'skip';
      const played = state.playedAt.get(clip.id) || 0;
      // D6：同段冷却 × 倍率（>1 隔更久、<1 更快回来）；缺省 1。
      const cooldownMult = tuneMultiplier(tune && tune.cooldownMultiplier, [clip.id, clip.label, emotion]);
      if (played && now - played < cfg.sameClipMs * cooldownMult) return 'cooldown';
      const priority = tuneMultiplier(tune && tune.segmentMultiplier, [clip.id, clip.label, emotion]);
      pool.push({ clip, energy, labelRank, priority, tier, h: hash32(clip.id + ':' + seed) });
      return 'added';
    };

    for (const label of labels) {
      for (const c of byLabel.get(label) || []) {
        const energy = Number(c.energy) || 0;
        // 两档能量门：强段（tier 0）永远排在放宽段（tier 1）之前。
        // 放宽只救「稀缺情绪」（playful/星星眼/爱心眼这些整组 <150 的），不凑数到噪声段。
        let tier = -1;
        if (energy >= cfg.minEnergy) tier = 0;
        else if (energy >= cfg.minEnergy * cfg.relaxFactor) tier = 1;
        if (tier < 0) continue;
        const duration = Number(c.durationMs);
        const durationOk = !(Number.isFinite(duration) && duration > 0 && duration > maxMs);
        const dailyOk = dailyCount(c.id) < cfg.maxPlaysPerClipPerDay;
        if (durationOk && dailyOk) ownAvailable += 1;
        consider(c, label, labels.indexOf(label), tier);
      }
    }

    // 稀缺兜底：本情绪（能量+时长+日上限之后）不足 minPoolPerEmotion 段时，
    // 借 neutral 的通用段（自然放松/思考专注）补到 5 段；tier 9 = 永远排最后，
    // 只在本情绪真的没段可演时才上（smug 这类素材总共只有 3 段）。
    if (ownAvailable < cfg.minPoolPerEmotion) {
      for (const label of GENERIC_LABELS) {
        if (labels.includes(label)) continue;
        for (const c of byLabel.get(label) || []) {
          consider(c, label, labels.length + 1, 9);
        }
      }
    }

    if (!pool.length) return reason('no-candidate', { emotion, labels, maxMs, ownAvailable });

    // 排序：档位（强段 > 放宽段 > 借用段）→ 优先级（label 顺序 × 倍率）→ 能量 → 与上次不同 → 确定性 hash
    pool.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const aRank = (a.labelRank + 1) / a.priority;
      const bRank = (b.labelRank + 1) / b.priority;
      if (aRank !== bRank) return aRank - bRank;
      if (b.energy !== a.energy) return b.energy - a.energy;
      const aSame = a.clip.label === state.lastLabel ? 1 : 0;
      const bSame = b.clip.label === state.lastLabel ? 1 : 0;
      if (aSame !== bSame) return aSame - bSame;
      return a.h - b.h;
    });
    const pick = pool[0].clip;
    return {
      clipId: pick.id,
      label: pick.label,
      reason: 'ok',
      detail: {
        emotion, intensity: +Number(intensity).toFixed(2),
        energy: Number(pick.energy) || 0, durationMs: pick.durationMs,
        maxMs, tier: pool[0].tier, poolSize: pool.length,
      },
    };
  }

  /** 记一次真的播了（导演靠它做冷却与重复规避） */
  function notePlayed(clipId, nowMs) {
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const clip = clips.find((c) => c.id === clipId);
    state.lastAt = now;
    state.lastClipId = clipId;
    state.lastLabel = clip ? clip.label : null;
    state.playedAt.set(clipId, now);
    state.recent.push(now);
    rollDaily(now);
    state.daily.counts.set(String(clipId), dailyCount(clipId) + 1);
    state.stats.played += 1;
  }

  return {
    decide,
    notePlayed,
    get stats() { return state.stats; },
    get last() { return { at: state.lastAt, clipId: state.lastClipId, label: state.lastLabel }; },
    config: cfg,
    get tuning() { return tuning; },
    setTuning(next) {
      tuning = (next && typeof next === 'object') ? next : null;
      return tuning;
    },
    /** 诊断：某情绪下此刻有哪些候选 */
    candidates(emotion) {
      const labels = EMOTION_TO_LABELS[normalizeEmotion(emotion)] || [];
      return labels.map((label) => ({
        label,
        clips: (byLabel.get(label) || []).map((c) => ({ id: c.id, energy: c.energy, durationMs: c.durationMs })),
      }));
    },
    /**
     * 诊断（P0）：每个情绪的**可用段数**（能量两档 + 时长门 + 日上限；不含冷却）。
     * `performanceDebug().poolStats` 与验收脚本读这个 —— 「playful 从 1 → ≥5」是可量化的。
     */
    poolStats(nowMs, maxMs) {
      const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
      rollDaily(now);
      const capMs = Number.isFinite(Number(maxMs)) ? Math.max(1, Number(maxMs)) : DIRECTOR_DEFAULTS.maxMs;
      const pass = (c) => {
        const duration = Number(c.durationMs);
        if (Number.isFinite(duration) && duration > 0 && duration > capMs) return false;
        return dailyCount(c.id) < cfg.maxPlaysPerClipPerDay;
      };
      const emotions = {};
      for (const emotion of Object.keys(EMOTION_TO_LABELS)) {
        const labels = EMOTION_TO_LABELS[emotion] || [];
        let tier0 = 0;
        let tier1 = 0;
        for (const label of labels) {
          for (const c of byLabel.get(label) || []) {
            if (!pass(c)) continue;
            const energy = Number(c.energy) || 0;
            if (energy >= cfg.minEnergy) tier0 += 1;
            else if (energy >= cfg.minEnergy * cfg.relaxFactor) tier1 += 1;
          }
        }
        let borrowed = 0;
        if (tier0 + tier1 < cfg.minPoolPerEmotion) {
          for (const label of GENERIC_LABELS) {
            if (labels.includes(label)) continue;
            for (const c of byLabel.get(label) || []) if (pass(c)) borrowed += 1;
          }
        }
        emotions[emotion] = { tier0, tier1, borrowed, total: tier0 + tier1 + borrowed, labels };
      }
      const dailyTop = [...state.daily.counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, count]) => ({ id, count, label: (clips.find((c) => c.id === id) || {}).label || '' }));
      return {
        maxMs: capMs,
        minEnergy: cfg.minEnergy,
        relaxedEnergy: cfg.minEnergy * cfg.relaxFactor,
        minPoolPerEmotion: cfg.minPoolPerEmotion,
        maxPlaysPerClipPerDay: cfg.maxPlaysPerClipPerDay,
        emotions,
        dailyTop,
      };
    },
  };
}
