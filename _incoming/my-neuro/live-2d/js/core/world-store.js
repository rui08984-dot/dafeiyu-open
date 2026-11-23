/**
 * js/core/world-store.js — 世界状态库（2026-11-17 六十二轮 · 世界感知 Phase 1）
 *
 * 为什么要有它：她原来对「世界」只有零散感知（前台/空闲在 main.js、屏幕状态在
 * watch-screen、媒体靠解析窗口标题），没有一个**统一的、带时效的、能说出变化**的
 * 世界状态。这个模块是那个中心：实体 + 带 TTL/来源优先级的时序事实 + 派生活动状态
 * + 变化快照。
 *
 * 三条设计原则（决定了它长这样）：
 *
 * 1. **传感器便宜，注意力和 token 才贵**
 *    所以这里只管「记住事实」，不做任何判断该不该说话 —— 打扰预算归 speech-budget，
 *    注入预算归 renderWorldLine（只写变化、≤100 tokens）。
 *
 * 2. **事实要能过期，也要能降级**
 *    复用 `fact-store.js` 的仲裁思路：每个事实按来源存、带 TTL、过期就 stale。
 *    某个适配器坏了，它的事实变 stale，世界行少一个字段，**不影响对话主链**。
 *
 * 3. **不认具体应用**
 *    这个文件里没有任何应用名/游戏名/网址。判「在干什么」只靠通用信号：
 *    空闲时长、是否全屏、媒体是否在放且与前台同题、以及上层给的提示（hints）。
 *    换一个应用/游戏不需要改这里一行代码。
 *
 * 纯模块：不 require electron / fs / 任何 I/O，可在 node 里直接单测（注入时钟）。
 * 例外（C1 世界可纠错）：`opts.priors` 不传时会尝试 require 同目录的 world-priors.js，
 * 它读一个很小的 JSON（带 mtime 缓存、失败一律降级 null）。不想要这条接线就传
 * `priors: null` —— 此时行为与引入先验之前**完全一致**。
 */

'use strict';

const { createFactStore } = require('./fact-store.js');
const { categoryOf, CATEGORY_LABELS } = require('./site-category.js');

/** 事实名（固定顺序 = 世界行字段顺序，别随手改：缓存与测试都依赖它）
 *  2026-11-21 Phase 3 追加 notify/site/privacy 三个字段：只在有值时出现，
 *  旧快照（没有这些字段）渲染结果与以前一模一样。 */
const FIELDS = ['activity', 'app', 'title', 'media', 'idle', 'clip', 'notify', 'site', 'privacy'];

const DEFAULTS = {
  // 每个事实多久算过期（毫秒）。采样 1s，TTL 给 3-5 倍余量，偶发丢一拍不至于变 stale。
  ttlMs: {
    'env.app': 5000,
    'env.title': 5000,
    'env.fullscreen': 5000,
    'user.idle_ms': 3000,
    'media.status': 4000,
    'media.track': 4000,
    'media.app': 4000,
    'clip.ver': 120000,
    // 浏览器信号由 world-sense 每秒从 browser-tabs.jsonl 重读；TTL 只用于
    // 「信号源死了」的降级。真正的 5 分钟新鲜度看 browser.at（上报时刻）。
    'browser.host': 600000,
    'browser.incognito': 600000,
    'browser.at': 600000,
    // 通知事实每秒重算；TTL 短一点，world-sense 一停就不会继续假装有新通知。
    'notify.count': 60000,
    'notify.apps': 60000,
    'notify.title': 60000,
  },
  // 来源优先级（复刻 fact-store 的打分思路；数字越大越信）
  sourceRank: { system: 90, clipboard: 70, hint: 60, vision: 50 },
  // 活动状态机阈值
  idleSec: 30,        // 超过 30s 没输入 → idle
  awaySec: 300,       // 超过 5min 没输入 → away
  minDwellMs: 4000,   // 进一个新状态后，至少停留这么久才允许再切（防抖）
  // 世界行预算
  maxTokens: 100,     // 软上限：超过就按优先级砍字段
  hardMaxTokens: 120, // 硬上限：再怎么砍也不能超过（超了整句截断）
  titleMaxChars: 60,  // 标题单独限长（中文 1 字 ≈ 1 token）
  // 浏览器信号新鲜度：扩展 60s 心跳，5 分钟没报告就当「页面已经关了」
  browserFreshMs: 5 * 60 * 1000,
  // 活动状态保鲜期（P0-4，2026-11-22）：world-sense 暂停/隐私后 `apply()` 不再被调用，
  // activity 会永久冻在上一次的 gaming/watching。超过「2 × 采样周期」没有更新就降级成
  // unknown/stale。缺省 30s：老调用方没传 sampleIntervalMs 时的兜底（不是生产采样周期）。
  // world-sense 创建 store 时传 sampleIntervalMs: 1000 → 实际阈值 2s。
  activityStaleMs: 30000,
  // 变化历史保留条数
  historyMax: 200,
};

/** 粗粒度 token 估算：CJK 1 字 ≈ 1 token，ASCII ≈ 4 字符 1 token。
 *  为什么不用真分词器：世界行是几十个 token 的小段，误差不影响「≤100」这条红线，
 *  而引入分词器会把一个纯模块变成有依赖的东西。 */
function estimateTokens(text) {
  const s = String(text == null ? '' : text);
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 0x2e80) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** 两个标题是不是「同一个东西」（宽松：忽略大小写/空白，互相包含即算）。
 *  为什么用包含而不是相等：播放器常把「歌名 - 歌手」写进标题、SMTC 只给歌名；
 *  窗口标题还可能带「- Bilibili」这类后缀。包含关系对这两类都成立。 */
function sameText(a, b) {
  const norm = (x) => String(x == null ? '' : x).toLowerCase().replace(/\s+/g, ' ').trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length < 4 || y.length < 4) return false;   // 太短的串包含关系没有意义
  return x.includes(y) || y.includes(x);
}

/**
 * 活动状态机（纯函数，可单测）。
 *
 * 判据按优先级从强到弱，**先命中先返回**：
 *   ① 空闲 ≥ awaySec(300s) → away（人不在，这是最强信号，压过一切）
 *   ② hints.gaming           → gaming（主进程 game-watch 的结论，已有逻辑不重复造）
 *   ③ 全屏 + 媒体在放         → watching（全屏看电影/视频）
 *   ④ 媒体在放 + 与前台同题   → watching（B 站这种：窗口标题就是视频标题）
 *   ⑤ hints.screenState=game → gaming（watch-screen 的屏幕状态机，弱一档）
 *   ⑥ hints.screenState=video→ watching
 *   ⑦ 空闲 ≥ idleSec(30s)    → idle（在想事/看东西没动手）
 *   ⑧ 有前台应用            → working（默认：在用电脑）
 *   ⑨ 什么都没有            → unknown
 *
 * 为什么 gaming 排在 watching 前面：游戏也会全屏、也可能带媒体会话（Steam 音乐），
 * 游戏检测是更专门的信号。
 */
function classifyActivity(input) {
  const i = input || {};
  const idleSec = Number(i.idleSec) || 0;
  const hints = i.hints || {};
  const playing = String(i.mediaStatus || '') === 'playing';

  if (idleSec >= DEFAULTS.awaySec) return { state: 'away', conf: 0.95, why: 'idle>=awaySec' };
  if (hints.gaming === true) return { state: 'gaming', conf: 0.9, why: 'hint.gaming' };
  if (i.fullscreen === true && playing) return { state: 'watching', conf: 0.85, why: 'fullscreen+media' };
  if (playing && sameText(i.mediaTitle, i.fgTitle)) return { state: 'watching', conf: 0.85, why: 'media==fg' };
  if (hints.screenState === 'game') return { state: 'gaming', conf: 0.75, why: 'hint.screen=game' };
  if (hints.screenState === 'video') return { state: 'watching', conf: 0.75, why: 'hint.screen=video' };
  if (idleSec >= DEFAULTS.idleSec) return { state: 'idle', conf: 0.7, why: 'idle>=idleSec' };
  if (i.fgApp) return { state: 'working', conf: 0.6, why: 'fg-app' };
  return { state: 'unknown', conf: 0.2, why: 'no-signal' };
}

/** 状态迁移带最小停留时间（防抖）：刚进的状态 4 秒内不许被替换。
 *  例外：away 不受限制 —— 人离开是明确事实，不该被「防抖」延迟。 */
function stabilize(prev, next, now, minDwellMs) {
  if (!prev || !prev.state || prev.state === 'unknown') return next;
  if (prev.state === next.state) return next;
  if (next.state === 'away') return next;
  if (now - Number(prev.since || 0) >= minDwellMs) return next;
  return { state: prev.state, conf: prev.conf, why: 'dwell(' + prev.state + ')' };
}

/** 把一段文本压到 maxChars（保留头尾，中间省略） */
function clipText(s, maxChars) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (t.length <= maxChars) return t;
  if (maxChars <= 6) return t.slice(0, maxChars);
  const head = Math.ceil((maxChars - 3) * 0.65);
  const tail = maxChars - 3 - head;
  return t.slice(0, head) + '...' + (tail > 0 ? t.slice(-tail) : '');
}

/** 只把「有意义的变化」写进变化历史：空闲毫秒每秒都在变，记进去只会把真事件冲掉
 *  （2026-11-17 实测：66 秒就把 12 条历史全填成 user.idle_ms）。 */
const NO_HISTORY = new Set(['user.idle_ms']);

/** 空闲秒数 → 粗粒度相对时间（不写秒级时间戳：越细越容易打穿「变化才写」）
 *  2026-11-21 修（P2）：原来 5 秒一档，而两次对话间隔普遍 >5s → 「没变就不注入」基本失效。
 *  改成 30 秒一档：同一档内（例如 12s→18s）世界行不变；跨档（<30s → ~30s → 1m）才产生新行。
 *  30s 以下统一写「刚动过」—— 比「~0s」更贴近模型理解，也不会 1 秒一跳。 */
function humanIdle(sec) {
  const s = Math.max(0, Number(sec) || 0);
  if (s < 30) return '刚动过';
  if (s < 60) return '~30s';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm';
  return Math.round(m / 60) + 'h';
}

/** 活动状态的中文短标签（给世界行用的最小词；快照里仍保留英文枚举） */
const ACTIVITY_LABEL = {
  working: '在干活',
  gaming: '在玩游戏',
  watching: '在看视频',
  // C1（2026-11-21）：用户原话场景就是「不是，我在开会」——没有 meeting 时只能
  // 纠正成 working（「在用电脑」），丢掉了「开会」这个最有用的事实。
  // 注意：classifyActivity 不会自动判出 meeting（没有可靠的通用信号），
  // 它只来自用户显式纠正（world-priors）。
  meeting: '开会',
  idle: '发呆',
  away: '人不在',
  unknown: '',
};

/**
 * 把快照变成「字段文本」。**唯一**的格式化入口 —— 渲染与「上一轮比什么」都用它，
 * 避免两处各拼一遍导致「明明没变却认为变了」。
 */
function worldFields(snap, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const s = snap || {};
  // 前台标题和媒体标题常常是同一个东西（B 站这类：窗口标题就是视频标题）。
  // 两个都写等于把同一句话付两遍 token —— 只留媒体段，它带播放状态，信息更多。
  const titleDupOfMedia = s.title && s.mediaTitle && sameText(s.title, s.mediaTitle);

  // 通知：只写「最近 10 分钟有 N 条 + 是哪些应用（最多 3 个）+ 最新标题（若允许采集）」。
  // 标题可能含验证码/私信 → 采集侧默认不落盘；这里只展示已经落盘的内容。
  const n = s.notifications || {};
  const nCount = Math.max(0, Number(n.count) || 0);
  let notify = '';
  if (nCount > 0) {
    const apps = Array.isArray(n.apps) ? n.apps.filter(Boolean).slice(0, 3) : [];
    notify = '通知=' + nCount + '条' + (apps.length ? '(' + apps.join(',') + ')' : '');
    if (n.latest_title) notify += '《' + clipText(n.latest_title, 24) + '》';
  }

  // 站点类别来自浏览器扩展的 host（不含 path/query）。未知归 other ——
  // 「站点=其他」也写出来：它至少说明「浏览器开着且不在已知站点」，比空着诚实。
  const site = s.category
    ? '站点=' + (CATEGORY_LABELS[s.category] || s.category)
    : '';

  return {
    activity: ACTIVITY_LABEL[s.activity] || '',
    app: s.app ? '前台=' + s.app : '',
    title: (s.title && !titleDupOfMedia) ? '《' + clipText(s.title, o.titleMaxChars) + '》' : '',
    media: s.media || '',
    idle: s.idleSec != null ? '空闲=' + humanIdle(s.idleSec) : '',
    clip: s.clip || '',
    notify,
    site,
    privacy: s.privacy || '',
  };
}

/**
 * 把当前世界状态渲染成「一行变化」。
 *
 * 三个硬约束（来自 §61.6 成本与缓存红线）：
 *   - **只写变化**：和 prev 相同的字段省略；全都没变 → text='' （调用方就不注入）
 *   - **字段顺序固定**：永远是 activity → app → title → media → idle → clip
 *   - **≤100 tokens（硬上限 120）**：超了按优先级从低到高砍字段（clip→idle→title→media→app）
 *
 * 为什么把 activity 放最前且永不砍：它是「她现在在干什么」最值钱的一个词。
 *
 * @param prev 上一轮注入用的 worldFields()（null/undefined = 第一次）
 * @param cur  当前 snapshot()
 */
function renderWorldLine(prev, cur, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const p = prev || {};
  const fields = worldFields(cur, o);
  const parts = [];

  for (const key of FIELDS) {
    const text = fields[key];
    if (text === undefined || text === null || text === '') continue;
    if (p[key] === text) continue;      // 没变 → 不写
    parts.push({ key, text });
  }

  if (!parts.length) return { text: '', tokens: 0, fields: [], truncated: false };

  // 砍字段顺序（从最不重要的开始）：clip → notify → site → idle → title → media → app；
  // activity 与 privacy 保底（privacy 是「无痕」信号，被砍掉就等于泄露口径失效）。
  const dropOrder = ['clip', 'notify', 'site', 'idle', 'title', 'media', 'app'];
  let kept = parts.slice();
  const build = () => '[世界] ' + kept.map((x) => x.text).join('；');
  let text = build();
  let tokens = estimateTokens(text);
  let dropped = 0;
  for (const key of dropOrder) {
    if (tokens <= o.maxTokens) break;
    const idx = kept.findIndex((x) => x.key === key);
    if (idx < 0) continue;
    kept.splice(idx, 1);
    dropped += 1;
    text = build();
    tokens = estimateTokens(text);
  }
  let truncated = dropped > 0;
  if (tokens > o.hardMaxTokens) {
    // 走到这里说明光 activity 就超硬上限（理论上不会）—— 兜底整句截断，不能不带省略号
    text = clipText(text, Math.max(8, Math.floor(o.hardMaxTokens * 0.9)));
    tokens = estimateTokens(text);
    truncated = true;
  }
  return { text, tokens, fields: kept.map((x) => x.key), truncated };
}

/**
 * 世界状态库。
 *
 * opts:
 *   now        注入时钟（测试用）
 *   ttlMs      覆盖默认 TTL
 *   sourceRank 覆盖来源优先级
 *   minDwellMs 状态防抖窗口
 *   sampleIntervalMs 采样周期（world-sense 传 1000）→ 活动保鲜期 = 2×
 *   activityStaleMs  直接指定活动保鲜期（优先级高于 sampleIntervalMs）
 */
function createWorldStore(opts) {
  const o = opts || {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const cfg = Object.assign({}, DEFAULTS, o);
  cfg.ttlMs = Object.assign({}, DEFAULTS.ttlMs, o.ttlMs || {});
  cfg.sourceRank = Object.assign({}, DEFAULTS.sourceRank, o.sourceRank || {});
  // P0-4：保鲜期只认一个数。显式 activityStaleMs > 2×sampleIntervalMs > 缺省 30s。
  const sampleMs = Number(o.sampleIntervalMs);
  const staleMs = Number(o.activityStaleMs);
  cfg.activityStaleMs = (Number.isFinite(staleMs) && staleMs > 0)
    ? staleMs
    : (Number.isFinite(sampleMs) && sampleMs > 0 ? sampleMs * 2 : DEFAULTS.activityStaleMs);

  // ── C1 用户纠偏先验 ────────────────────────────────────────────────
  // 不传 opts.priors → 用默认文件单例（recordFile('world-priors.json')）；
  // require 失败（如在渲染进程/打包裁剪后没有 fs）→ null，退回纯启发式。
  // 显式传 null 可以彻底关掉（测试与嵌入方用）。
  let priors = o.priors === undefined ? null : o.priors;
  if (o.priors === undefined) {
    try { priors = require('./world-priors.js'); } catch (e) { priors = null; }
  }

  // 仲裁/时效交给 fact-store：它已经踩过「TTL、来源分、冲突、NaN 拒收」这些坑
  const facts = createFactStore({
    now,
    policy: { sourceRank: cfg.sourceRank, conflictTol: 0.12, dropAfterTtlRatio: 4 },
  });
  const factPolicy = {};
  for (const [k, v] of Object.entries(cfg.ttlMs)) factPolicy[k] = { ttlMs: v };
  facts.configure(factPolicy);

  const state = {
    at: 0,                 // 最近一次采样时刻
    activity: { state: 'unknown', conf: 0, since: 0, why: 'init' },
    // P0-4：活动状态最近一次「真正重算」的时刻。snapshot 用它判断冻结。
    // 初值 -1 = 从未采样（不能用 0：注入时钟从 0 开始的单测里，0 是合法时刻）。
    activityAt: -1,
    // 变化快照：最近 N 条字段变化（"你离开这段时间发生了什么" 的原料）
    history: [],
    // 每个字段最近一次「值」与变更时刻（供 world line 与诊断）
    last: {},
    stats: { samples: 0, errors: 0, lastErr: '', lastErrAt: 0, lastUs: 0 },
  };

  // 最近一拍的 hints。只存这一小撮（事实本身已经在 fact-store 里），
  // 供 refreshActivity 在不重新采样时按当前事实重算活动状态。
  let lastHints = { hints: {} };

  function recordChange(field, from, to, t) {
    state.history.push({ at: t, field, from, to });
    if (state.history.length > cfg.historyMax) state.history.shift();
  }

  /** 写一个事实；值变化才记历史（相同值不刷历史，避免 1s 采样把历史冲爆） */
  function setFact(fact, value, meta) {
    const prevVal = state.last[fact];
    const ok = facts.set(fact, value, Object.assign({ ttlMs: cfg.ttlMs[fact] }, meta || {}));
    if (ok && prevVal !== value) {
      if (!NO_HISTORY.has(fact)) recordChange(fact, prevVal, value, now());
      state.last[fact] = value;
    }
    return ok;
  }

  /** 喂一拍采样（world-adapter 的产出）。
   *  snap: { fg:{ok,title,app,fullscreen}, idleMs, media:{ok,status,title,app}, clip:{hash,chars}, hints:{}, errors:[] }
   *  每个子项都可以缺 —— 缺了就当这个源这一拍没数据（事实自然到期变 stale）。
   *  2026-11-21 修（P1）：适配器把采集失败放进 snap.errors（不再抛异常），这里必须计入
   *  stats.errors/lastErr，否则 pet-core 挂了也会「采样一直在跑、错误一直是 0」静默空转。 */
  function apply(snap, meta) {
    const m = Object.assign({ source: 'system', conf: 0.9 }, meta || {});
    const s = snap || {};
    state.stats.samples += 1;
    if (Number.isFinite(Number(m.us))) state.stats.lastUs = Number(m.us);
    if (Array.isArray(s.errors) && s.errors.length) {
      state.stats.errors += s.errors.length;
      state.stats.lastErr = String(s.errors[0] || '');
      state.stats.lastErrAt = now();
    }

    if (s.fg && s.fg.ok) {
      setFact('env.app', String(s.fg.app || 'unknown'), m);
      setFact('env.title', String(s.fg.title || ''), Object.assign({}, m, { conf: 0.85 }));
      setFact('env.fullscreen', s.fg.fullscreen === true, m);
    }
    if (Number.isFinite(Number(s.idleMs))) {
      setFact('user.idle_ms', Math.max(0, Math.round(Number(s.idleMs))), m);
    }
    if (s.media) {
      const ms = String(s.media.status || 'none');
      setFact('media.status', ms, Object.assign({}, m, { conf: s.media.ok ? 0.9 : 0.4 }));
      setFact('media.track', String(s.media.title || ''), m);
      setFact('media.app', String(s.media.app || ''), m);
    }
    if (s.clip && s.clip.hash) {
      setFact('clip.ver', String(s.clip.hash) + ':' + (Number(s.clip.chars) || 0),
        Object.assign({}, m, { source: 'clipboard', conf: 0.95 }));
    }
    // 浏览器信号（world-sense 从 browser-tabs.jsonl 读取；本模块不碰文件）：
    //   host      最后一次上报的域名（无痕时为空）
    //   incognito 最后一次上报是否无痕
    //   at        最后一次「看到」的时刻（含 60s 心跳续命）
    if (s.browser && s.browser.ok) {
      setFact('browser.host', String(s.browser.host || ''), m);
      setFact('browser.incognito', s.browser.incognito === true, m);
      setFact('browser.at', Number(s.browser.at) || 0, m);
    }
    // 通知（world-sense 从 notifications.jsonl 汇总；10 分钟窗口在读取侧算好）
    if (s.notifications && Number.isFinite(Number(s.notifications.count))) {
      const n = s.notifications;
      setFact('notify.count', Math.max(0, Math.round(Number(n.count))), m);
      setFact('notify.apps', Array.isArray(n.apps) ? n.apps.filter(Boolean).slice(0, 5).join(',') : '', m);
      setFact('notify.title', String(n.latest_title || ''), m);
    }

    state.at = now();
    lastHints = { hints: (s.hints || {}) };
    updateActivity(s);
    return snapshot();
  }

  /** 派生活动状态（读事实 + hints），带防抖 */
  function updateActivity(hintsSnap) {
    const g = (k) => facts.get(k);
    const idleMs = Number(g('user.idle_ms').value) || 0;
    // **过期的事实不能当证据**：媒体适配器停掉（低功耗/崩溃）后 `media.status` 会
    // 一直保留最后一个值（fact-store 在 4×TTL 内仍返回），如果照用，
    // 「在放视频」会一直成立 → 她会以为自己一直在被看视频。
    // 过期就当没在放（宁可少说，不可说错）。
    const mediaFact = g('media.status');
    const mediaStatus = mediaFact.stale ? 'none' : String(mediaFact.value || 'none');
    const mediaTrack = g('media.track');
    const mediaTitle = mediaTrack.stale ? '' : String(mediaTrack.value || '');
    const fgApp = String(g('env.app').value || '');
    const fgTitle = String(g('env.title').value || '');
    const hints = (hintsSnap && hintsSnap.hints) || {};
    const t = now();

    // 用户先验（未命中/过期/文件坏了都是 null，绝不影响启发式）
    let priorHit = null;
    if (priors && typeof priors.lookup === 'function') {
      try { priorHit = priors.lookup({ app: fgApp, title: fgTitle }, t); } catch (e) { priorHit = null; }
    }

    // 启发式先算出来：即使先验命中，也要用它判断「人是不是已经离开」。
    // 成本可忽略（纯函数），换来的是「away 优先」有一个不会漂移的判据。
    const heuristic = classifyActivity({
      idleSec: Math.round(idleMs / 1000),
      fgApp,
      fgTitle,
      fullscreen: g('env.fullscreen').value === true,
      mediaStatus,
      mediaTitle,
      mediaApp: String(g('media.app').value || ''),
      hints,
    });
    const heuristicSettled = stabilize(state.activity, heuristic, t, cfg.minDwellMs);

    // ── C1：用户纠偏优先，但「人不在」比「他在干嘛」更硬 ─────────────
    // 先验回答的是「这个窗口出现时算在干嘛」；它不能把「人已经离开」压成
    // 「开会中/在看视频」。现有实现里 away 的唯一判据是 idleSec >= awaySec(300s)，
    // 由 classifyActivity 的第一条直接给出（进入 away 也不受 stabilize 延迟）；
    // 这里连 stabilize 后的结果一起看，是为了覆盖「刚从 away 回来、还在 4s 防抖里」
    // 的短暂窗口 —— 那 4 秒里她仍应保持「人不在」，而不是立刻改口。
    // 人回来后 idle 降下来，先验会自动重新生效（见 _probe/test-world-priors.cjs）。
    const awayWins = heuristic.state === 'away' || heuristicSettled.state === 'away';

    let next = heuristic;
    let fromPrior = false;
    if (priorHit && priorHit.activity && !awayWins) {
      // conf 口径：world-store 一直是 0..1（/world 与验收都按这个区间），
      // priors 的 conf:100 是「用户明确指定」的百分比口径，这里归一到 1。
      next = { state: priorHit.activity, conf: 1, why: 'user-prior' };
      fromPrior = true;
    }

    // 先验越过 stabilize：minDwell 是压「启发式抖动」的，不该让用户的明确纠正
    // 延迟最多 4 秒；而且启发式持续命中时 dwell 会一直返回旧状态，用户改了也看不见。
    const settled = fromPrior ? next : heuristicSettled;
    if (settled.state !== state.activity.state) {
      recordChange('activity', state.activity.state, settled.state, t);
      state.activity = { state: settled.state, conf: settled.conf, since: t, why: settled.why || '' };
    } else {
      // 同状态：置信度/原因更新，since 不动（since 是「这个状态从什么时候开始」）
      state.activity.conf = settled.conf;
      state.activity.why = settled.why || state.activity.why;
    }
    // P0-4：保鲜计时只在这里推进。world-sense 暂停/隐私后 apply/refresh 都不再调用，
    // 这里的时间戳就会停在最后一拍，snapshot 据此把冻结状态降级。
    state.activityAt = t;
  }

  /** 立刻按当前事实重算一次活动状态（不重新采样）。
   *  `world` 工具写完先验后调用它，用户纠正的**下一帧**就该看到 why:'user-prior'，
   *  而不是最多等 1 秒的下一次采样。 */
  function refreshActivity() {
    updateActivity(lastHints);
    return snapshot();
  }

  /** 当前世界快照（给注入/诊断用；字段顺序固定） */
  function snapshot() {
    const g = (k) => facts.get(k);
    const t = now();

    // ── P0-4：活动状态保鲜 ────────────────────────────────────────────
    // world-sense 暂停/隐私时不再 apply()，但 facts 在 4×TTL 内还会返回旧值，
    // state.activity 更是永远保留最后一次结果。冻结的 gaming/watching 被
    // speech-budget / intent-queue 当成当前情境，就会「她以为你还在打游戏」。
    // 口径：超过 activityStaleMs（生产 2s = 2×1s 采样）没有重算 → unknown + stale。
    // 原值保留在 activityLast，方便 /world 与日志诊断「最后看到的是什么」。
    const activityAgeMs = state.activityAt >= 0 ? Math.max(0, t - state.activityAt) : Infinity;
    const activityStale = activityAgeMs > cfg.activityStaleMs;
    const activityState = activityStale ? 'unknown' : state.activity.state;

    const mediaStatus = g('media.status');
    const mediaTrack = g('media.track');
    const rawIdle = g('user.idle_ms');
    const idleSec = rawIdle.value != null ? Math.round(Number(rawIdle.value) / 1000) : null;

    // ── 浏览器信号：无痕启发式 + 站点类别（Phase 3 缺口 2/3）────────────
    // 口径：**扩展最后一条上报是 incognito=true，且距离最后一次看到 ≤5 分钟**
    // → 认为当前页面可能处于无痕；此时屏蔽前台窗口标题/媒体标题这两个
    // 「可能来自浏览器」的字段，只保留 app 名与「浏览中（隐私）」。
    // 这只是启发式：它识别的是「扩展说过自己在无痕」，不是「所有无痕窗口」；
    // 别的浏览器/扩展没上报、或上报过期，都会回落到普通行为（宁可少屏蔽，不假装全知）。
    const bInc = g('browser.incognito');
    const bAt = g('browser.at');
    const bHost = g('browser.host');
    const bAtMs = Number(bAt.value);
    const browserFresh = Number.isFinite(bAtMs) && bAtMs > 0 && (t - bAtMs) <= cfg.browserFreshMs;
    const incognito = bInc.value === true && browserFresh;
    const category = (!incognito && browserFresh && bHost.value)
      ? categoryOf(String(bHost.value))
      : '';

    let mediaText = '';
    if (mediaStatus.value && ['none', 'stopped', 'closed', 'skipped'].indexOf(String(mediaStatus.value)) < 0) {
      const st = String(mediaStatus.value);
      // 媒体标题也要限长：一条 B 站视频标题动辄 60 字，不截能把整个世界行的预算吃光
      const title = clipText(String(mediaTrack.value || ''), cfg.titleMaxChars);
      mediaText = '媒体=' + st + (title ? '《' + title + '》' : '');
      if (mediaStatus.stale) mediaText += '(旧)';
    }

    const clip = g('clip.ver');
    // 注意别叫 clipText：那会遮蔽同名的格式化函数（踩过 TDZ 报错）
    let clipLine = '';
    if (clip.value && !clip.stale) {
      const [hash, chars] = String(clip.value).split(':');
      clipLine = '剪贴板=' + String(Number(chars) || 0) + '字#' + String(hash).slice(0, 4);
    }

    // 无痕：媒体段里含标题 → 整段屏蔽（保留 mediaStatus 供 /world 诊断，标题不出现）。
    if (incognito) mediaText = '';

    // 通知：count 事实过期就当没有（采集停了不能一直说「有新通知」）。
    const nc = g('notify.count');
    const notifyCount = nc.stale ? 0 : Math.max(0, Number(nc.value) || 0);
    let notifyApps = [];
    let notifyTitle = '';
    if (notifyCount > 0) {
      const na = g('notify.apps');
      notifyApps = (!na.stale && typeof na.value === 'string')
        ? na.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 5)
        : [];
      const nt = g('notify.title');
      notifyTitle = (!nt.stale && typeof nt.value === 'string') ? nt.value : '';
    }
    const notifications = { count: notifyCount, apps: notifyApps, latest_title: notifyTitle };

    return {
      at: state.at,
      activity: activityState,
      activityConf: state.activity.conf,
      activityWhy: state.activity.why,
      activitySince: state.activity.since,
      // P0-4 诊断面：at=最后一次重算时刻；last=冻结前的原值；stale=是否已降级
      activityAt: state.activityAt,
      activityLast: state.activity.state,
      activityStale,
      app: String(g('env.app').value || ''),
      // 无痕时这两个字段是「可能来自浏览器标题」的直接通道 → 清空
      title: incognito ? '' : String(g('env.title').value || ''),
      fullscreen: g('env.fullscreen').value === true,
      media: mediaText,
      mediaStatus: String(mediaStatus.value || 'none'),
      mediaTitle: incognito ? '' : String(mediaTrack.value || ''),
      idleSec,
      clip: clipLine,
      category,
      privacy: incognito ? '浏览中（隐私）' : '',
      notifications,
      stale: {
        app: g('env.app').stale, title: g('env.title').stale,
        media: mediaStatus.stale, idle: rawIdle.stale,
        browser: !browserFresh,
        // P0-4：活动保鲜与事实 TTL 是两件事 —— 适配器可能还在跑、事实是新的，
        // 但 world-sense 被暂停（或 refresh 停摆）时 activity 会冻结。这里显式给消费方。
        activity: activityStale,
      },
    };
  }

  /** 最近一段时间内的变化（"你离开这段时间发生了什么"） */
  function recentChanges(withinMs) {
    const t = now();
    const win = Number(withinMs) || 10 * 60 * 1000;
    return state.history.filter((h) => t - h.at <= win);
  }

  function dump() {
    return {
      at: state.at,
      activity: state.activity,
      activityAt: state.activityAt,
      snapshot: snapshot(),
      facts: facts.dump(),
      stats: state.stats,
      history: state.history.slice(-20),
    };
  }

  return {
    apply,
    snapshot,
    recentChanges,
    refreshActivity,
    dump,
    classifyActivity,
    renderWorldLine: (prev, cur, ro) => renderWorldLine(prev, cur, Object.assign({}, cfg, ro || {})),
    estimateTokens,
    get activity() { return state.activity; },
    get stats() { return state.stats; },
    _facts: facts,
    _config: cfg,
  };
}

module.exports = {
  createWorldStore,
  classifyActivity,
  stabilize,
  renderWorldLine,
  worldFields,
  estimateTokens,
  sameText,
  clipText,
  humanIdle,
  ACTIVITY_LABEL,
  FIELDS,
  DEFAULTS,
};
