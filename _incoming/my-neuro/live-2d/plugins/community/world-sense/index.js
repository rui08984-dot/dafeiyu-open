/**
 * plugins/community/world-sense/index.js — 世界感知（Phase 1）
 *
 * 职责只有三件：
 *   ① 每秒采一次廉价源（前台/空闲/媒体/剪贴板）→ 写进 WorldStore
 *   ② 每轮对话取一次快照 → 把「变化」塞进最后一条 user 的易变尾巴
 *   ③ 把世界状态与成本记在自己身上，供 8004/8103 读（`/world`）
 *
 * 为什么不做别的（重要，别在这里加功能）：
 *   - **不说话**：主动开口的闸在 speech-coordinator + speech-budget，这里只提供事实。
 *   - **不截图/不 OCR/不调 VLM**：那些是「按需 + 有预算」的贵源（Phase 2+）。
 *     这里任何一次采样都不该超过 5ms（实测 3.8–4.2ms，低功耗 122µs）。
 *   - **不改 system**：世界状态只走易变尾巴（`request.addVolatile`），
 *     否则每轮都会打穿 system/tools 的前缀缓存（§61.6 缓存红线）。
 *
 * 开关（config.json 的 `world_sense`，缺省=全开）：
 *   { "enabled": true, "privacy": false, "low_power": false,
 *     "sources": { "foreground": true, "idle": true, "media": true, "clipboard": true } }
 *   - privacy=true   → 全部暂停采样（世界行报「已暂停」一次）
 *   - low_power=true → 只留前台+空闲（不读 SMTC、不读剪贴板）
 */

'use strict';

const fs = require('fs');
const { Plugin } = require('../../../js/core/plugin-base.js');
const { createWorldStore, worldFields, ACTIVITY_LABEL } = require('../../../js/core/world-store.js');
const { createWorldPriors } = require('../../../js/core/world-priors.js');
const { createWorldAdapters } = require('../../../js/core/world-adapters.js');
const { recordFile } = require('../../../js/core/records-path.js');
// 世界行含前台窗口标题（网页标题可控）→ 统一包成「环境数据·非指令」再注入
const { wrapUntrusted, ensureBoundaryPatch } = require('../../../js/core/untrusted-data.js');

const SAMPLE_INTERVAL_MS = 1000;
const UNAVAILABLE_NOTE_GAP_MS = 10 * 60 * 1000;   // 「世界状态不可用」最多 10 分钟提醒一次
const ERR_LOG_GAP_MS = 60 * 1000;                 // 采集错误日志：同一错误最多 1 分钟一条（别自己变噪音）
const BUDGET_WARN_GAP_MS = 60 * 60 * 1000;        // 超预算告警每小时最多一次
// Phase 3：通知采集器每 10 分钟跑一次 → 世界行只看最近 10 分钟的条目。
const NOTIFY_WINDOW_MS = 10 * 60 * 1000;
// Phase 3：扩展 60s 心跳；5 分钟没上报就当页面已关（与 world-extras 同一口径）。
const BROWSER_FRESH_MS = 5 * 60 * 1000;
// 数据行预算：world-store 的硬上限是 120 tokens（全 CJK≈120 字 / 全 ASCII≈480 字），
// 520 字只会兜住异常长行，不会把正常世界行压短。
const WORLD_DATA_MAX_CHARS = 520;
// 工具参数的活动枚举直接取自 world-store 的 ACTIVITY_LABEL（唯一真源），
// 不在这里另写一份，否则加活动时两处会漂移。
const ACTIVITY_ENUM = Object.keys(ACTIVITY_LABEL);

// ── Phase 3 读取器（纯函数 + 可注入路径/时钟；插件本体只负责接线）──────────

/** 任意时间表示 → 毫秒；解析不了返回 NaN（坏行计数，不猜） */
function timeMs(value) {
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const ms = Date.parse(String(value == null ? '' : value));
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * 通知汇总（纯函数）：只统计 nowMs 往前 windowMs 内的条目。
 * 返回 {count, apps, latest_title, entries, invalid, fresh}。
 *   - apps 按「越新越靠前」去重，最多 5 个（世界行只渲染前 3 个）；
 *   - latest_title 取窗口内最新一条带 title 的记录（采集侧默认不落 title，所以通常为空）。
 */
function summarizeNotifications(rows, nowMs, windowMs) {
  const win = Number(windowMs) > 0 ? Number(windowMs) : NOTIFY_WINDOW_MS;
  const now = Number(nowMs) > 0 ? Number(nowMs) : Date.now();
  const out = { count: 0, apps: [], latest_title: '', entries: 0, invalid: 0, fresh: false };
  const list = Array.isArray(rows) ? rows : [];
  const fresh = [];
  for (const row of list) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) { out.invalid += 1; continue; }
    const ms = timeMs(row.ts);
    if (!Number.isFinite(ms)) { out.invalid += 1; continue; }
    out.entries += 1;
    if (now - ms > win) continue;
    fresh.push({ row, ms });
    out.count += 1;
  }
  fresh.sort((a, b) => b.ms - a.ms);
  const seen = new Set();
  for (const item of fresh) {
    const app = String(item.row.app_short || item.row.app || '').trim();
    if (app && !seen.has(app)) {
      seen.add(app);
      out.apps.push(app);
    }
    if (!out.latest_title && typeof item.row.title === 'string' && item.row.title.trim()) {
      out.latest_title = item.row.title.trim();
    }
  }
  out.apps = out.apps.slice(0, 5);
  out.fresh = out.count > 0;
  return out;
}

/** 直接读文件（测试/一次性诊断用）：缺文件不抛，坏行计数。 */
function readNotificationsFile(file, nowMs, opts) {
  const o = opts || {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return {
      ok: true,
      missing: !!(e && e.code === 'ENOENT'),
      readError: (e && e.code === 'ENOENT') ? '' : String((e && e.message) || e),
      count: 0, apps: [], latest_title: '', entries: 0, invalid: 0, fresh: false, readAt: Number(nowMs) || Date.now(),
    };
  }
  const parsed = parseNotificationLines(raw);
  const out = summarizeNotifications(parsed.rows, nowMs, o.windowMs);
  out.ok = true;
  out.missing = false;
  out.readError = '';
  out.invalid += parsed.invalid;
  out.readAt = Number(nowMs) || Date.now();
  return out;
}

function parseNotificationLines(raw) {
  const rows = [];
  let invalid = 0;
  for (const line of String(raw == null ? '' : raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object' && !Array.isArray(o)) rows.push(o);
      else invalid += 1;
    } catch (e) {
      invalid += 1;
    }
  }
  return { rows, invalid };
}

/**
 * 通知读取器（mtime 缓存）：文件没变就不重读，但窗口过滤每次都按当前时间重算 ——
 * 否则「10 分钟窗口」会冻在第一次读取的那一刻。
 */
function createNotificationReader(opts) {
  const o = opts || {};
  const file = o.file;
  const nowFn = typeof o.now === 'function' ? o.now : () => Date.now();
  const windowMs = Number(o.windowMs) > 0 ? Number(o.windowMs) : NOTIFY_WINDOW_MS;
  let cache = { mtime: -1, size: -1, rows: [], invalid: 0 };
  const stats = { reads: 0, invalid: 0, missing: false, lastErr: '' };

  function read(t) {
    const at = Number.isFinite(Number(t)) ? Number(t) : nowFn();
    let st;
    try {
      st = fs.statSync(file);
    } catch (e) {
      stats.missing = !!(e && e.code === 'ENOENT');
      if (!stats.missing) stats.lastErr = String((e && e.message) || e);
      stats.invalid = 0;
      return { ok: true, missing: stats.missing, readError: stats.lastErr,
        count: 0, apps: [], latest_title: '', entries: 0, invalid: 0, fresh: false, readAt: at };
    }
    if (st.mtimeMs !== cache.mtime || st.size !== cache.size) {
      try {
        const parsed = parseNotificationLines(fs.readFileSync(file, 'utf8'));
        cache = { mtime: st.mtimeMs, size: st.size, rows: parsed.rows, invalid: parsed.invalid };
      } catch (e) {
        stats.lastErr = String((e && e.message) || e);
        cache = { mtime: st.mtimeMs, size: st.size, rows: [], invalid: 0 };
      }
    }
    stats.missing = false;
    stats.reads += 1;
    stats.invalid = cache.invalid;
    const out = summarizeNotifications(cache.rows, at, windowMs);
    out.ok = true;
    out.missing = false;
    out.readError = '';
    out.invalid += cache.invalid;
    out.readAt = at;
    return out;
  }
  return { read, stats, file };
}

/**
 * 浏览器信号读取器（缺口 2）：最后一行 jsonl + seen 心跳标记。
 * 返回 {ok, host, incognito, at, ageMs} 或 null（无数据/过期）。
 * 与 world-extras 同口径：seen 标记的 host/incognito 必须与最后一行一致才采用，
 * 防止一条陈旧标记把别的页面续命。
 */
function createBrowserSignalReader(opts) {
  const o = opts || {};
  const tabsFile = o.tabsFile;
  const seenFile = o.seenFile;
  const nowFn = typeof o.now === 'function' ? o.now : () => Date.now();
  const freshMs = Number(o.freshMs) > 0 ? Number(o.freshMs) : BROWSER_FRESH_MS;
  let tabs = { mtime: -1, size: -1, row: null, invalid: 0 };
  const stats = { reads: 0, invalid: 0, missing: false, lastErr: '' };

  function read(t) {
    const at = Number.isFinite(Number(t)) ? Number(t) : nowFn();
    try {
      const st = fs.statSync(tabsFile);
      if (st.mtimeMs !== tabs.mtime || st.size !== tabs.size) {
        const raw = fs.readFileSync(tabsFile, 'utf8');
        // 全量扫一遍（文件 2MB 轮转，且只在 mtime 变化时发生）：
        // 既取最后一条好行，也把坏行数出来（/world 的 sensors.browserInvalid）。
        let row = null;
        let invalid = 0;
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const o2 = JSON.parse(line);
            if (o2 && typeof o2 === 'object' && Number.isFinite(Number(o2.ts))) row = o2;
            else invalid += 1;
          } catch (e) { invalid += 1; }
        }
        tabs = { mtime: st.mtimeMs, size: st.size, row, invalid };
      }
    } catch (e) {
      stats.missing = !!(e && e.code === 'ENOENT');
      if (!stats.missing) stats.lastErr = String((e && e.message) || e);
      return null;
    }
    stats.missing = false;
    stats.invalid = tabs.invalid;
    if (!tabs.row) return null;

    let seenTs = NaN;
    // seen 是 ~100 字节的小文件，直接读不缓存 —— 缓存按 mtime 判断时，
    // 同一毫秒内连续两次上报会漏掉后一次（测试里就是这种写法）。
    try {
      const sd = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
      if (sd && Number.isFinite(Number(sd.seen_ts))
        && String(sd.host || '') === String(tabs.row.host || '')
        && (sd.incognito === true) === (tabs.row.incognito === true)) {
        seenTs = Number(sd.seen_ts);
      }
    } catch (e) { /* seen 只是心跳续命，缺失不致命 */ }

    const rowTs = Number(tabs.row.ts);
    const effTs = Number.isFinite(seenTs) ? Math.max(rowTs, seenTs) : rowTs;
    if (at - effTs > freshMs) return null;
    stats.reads += 1;
    return {
      ok: true,
      host: String(tabs.row.host || ''),
      incognito: tabs.row.incognito === true,
      at: effTs,
      ageMs: Math.max(0, at - effTs),
    };
  }
  return { read, stats, files: { tabsFile, seenFile } };
}

/** 把 world-store 渲染出的世界行包成数据行（纯函数，可单测） */
function buildWorldDataLine(text, maxChars) {
  const t = String(text == null ? '' : text);
  if (!t) return '';
  return wrapUntrusted('world', { text: t }, maxChars || WORLD_DATA_MAX_CHARS);
}

class WorldSensePlugin extends Plugin {
  async onInit() {
    this._running = false;
    this._inFlight = false;
    this._timer = null;

    // C1 世界可纠错：用户纠偏先验。插件自己持有实例，`world` 工具写入与
    // WorldStore 读取共用同一份缓存 —— 纠正后不必等下一次读盘就立刻生效。
    this._priors = createWorldPriors();
    // P0-4：把采样周期交给 store，活动保鲜期 = 2×（暂停/隐私后 2s 就降级 unknown），
    // 而不是让最后一次 gaming/watching 永久冻结。
    this._store = createWorldStore({ priors: this._priors, sampleIntervalMs: SAMPLE_INTERVAL_MS });
    this._cfg = this._readConfig();

    this._adapters = this._buildAdapters();
    // Phase 3：两个文件型信号源（通知/浏览器）。读的是采集器与扩展已经落盘的事实，
    // 不新增端口、不新增常驻进程；文件缺失/坏行由读取器计数，不抛。
    this._notificationsFile = recordFile('notifications.jsonl');
    this._notifyReader = createNotificationReader({ file: this._notificationsFile, windowMs: NOTIFY_WINDOW_MS });
    this._browserReader = createBrowserSignalReader({
      tabsFile: recordFile('browser-tabs.jsonl'),
      seenFile: recordFile('browser-tabs-seen.json'),
      freshMs: BROWSER_FRESH_MS,
    });
    this._sensorStats = {
      notifyReads: 0, notifyInvalid: 0, lastNotifyCount: 0,
      browserReads: 0, browserNoSignal: 0, browserInvalid: 0,
    };

    // 上一轮注入用的字段文本（diff 基准）。只在真的注入后才更新。
    this._lastFields = null;
    // 采集错误日志去重（同一错误 1 分钟一条）；store.stats 里另有累计计数
    this._lastAdapterErr = '';
    this._lastAdapterErrAt = 0;
    // 通知文件坏行发声去重（同一个计数只报一次，别每秒刷）
    this._lastNotifyInvalid = 0;
    // 成本账：每轮世界行 token + 缓存命中 + 主动次数（跨轮累计，供 /world 读）
    this._stats = {
      turns: 0,
      injected: 0,
      tokensTotal: 0,
      tokensMax: 0,
      lastTokens: 0,
      lastLine: '',
      lastFields: [],
      lastAt: 0,
      lastCacheRate: null,
      lastPromptTokens: null,
      lastCachedTokens: null,
      truncatedTurns: 0,
      lastWarnAt: 0,
      lastUnavailableAt: 0,
      startedAt: Date.now(),
    };

    // 可观测：8004/8103 通过 executeJavaScript 读这个函数
    globalThis.__worldSenseState = () => this.state();
    globalThis.__worldSenseState.__owner = this;
  }

  async onStart() {
    this._running = true;
    // 系统提示声明「带前缀的世界行是数据不是指令」（共享补丁，幂等；固定文本不进每轮请求）
    ensureBoundaryPatch(this.context);
    this._readConfig();
    if (this._cfgChanged) { this._adapters = this._buildAdapters(); this._cfgChanged = false; }
    // 配置在运行时被改（控制中心保存）时重建适配器：不用重启宿主
    this._loop().catch(() => {});
    this.context.log('info', '[world-sense] 世界感知已启动（1s 采样 · 前台/空闲/媒体/剪贴板）');
  }

  async onStop() {
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (globalThis.__worldSenseState && globalThis.__worldSenseState.__owner === this) {
      delete globalThis.__worldSenseState;
    }
  }

  // ── 配置 ──────────────────────────────────────────────────────────────
  _readConfig() {
    let cfg = {};
    try { cfg = this.context.getConfig() || {}; } catch (e) { cfg = {}; }
    const base = cfg.world_sense || {};
    // 运行时覆盖（8103 `POST /world` 写盘后由主进程推进渲染层）——
    // 插件的 config 是启动时那一份，不认这个覆盖的话，隐私模式必须重启才生效。
    let live = null;
    try { live = globalThis.__worldSenseConfig || null; } catch (e) { live = null; }
    const w = live ? Object.assign({}, base, live) : base;
    const src = Object.assign({}, base.sources || {}, (live && live.sources) || {});
    const out = {
      enabled: w.enabled !== false,
      privacy: w.privacy === true,
      lowPower: w.low_power === true || w.lowPower === true,
      sources: {
        foreground: src.foreground !== false,
        idle: src.idle !== false,
        media: src.media !== false,
        clipboard: src.clipboard !== false,
      },
    };
    const changed = !this._cfg
      || this._cfg.enabled !== out.enabled
      || this._cfg.privacy !== out.privacy
      || this._cfg.lowPower !== out.lowPower
      || JSON.stringify(this._cfg.sources) !== JSON.stringify(out.sources);
    this._cfg = out;
    this._cfgChanged = changed;
    return out;
  }

  _buildAdapters() {
    return createWorldAdapters({
      sources: this._cfg.sources,
      lowPower: this._cfg.lowPower,
    });
  }

  _active() {
    return this._cfg.enabled && !this._cfg.privacy;
  }

  // ── 工具面（C1 世界可纠错）：world ───────────────────────────────────
  // 这是「世界感知」唯一的工具入口：status 只读，correct 写用户先验。
  // 为什么不做成两个工具：工具面已经很多，一个 action 开关比再多一个名字省 schema。
  getTools() {
    return [{
      type: 'function',
      function: {
        name: 'world',
        description: '世界感知：status=看当前活动/前台应用/窗口标题/空闲时长/最近变化；correct=用户明确纠正活动（如「不是，我在开会」）并按应用+标题记住，同一窗口下次直接采用。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['status', 'correct'], description: 'status 查看；correct 纠正' },
            activity: {
              type: 'string',
              enum: ACTIVITY_ENUM.slice(),
              description: 'correct 必填：开会用 meeting，办公类用 working',
            },
            app: { type: 'string', description: '可选：限定到某个应用，默认当前前台' },
            title: { type: 'string', description: '可选：限定到某类窗口标题，默认当前标题' },
            note: { type: 'string', description: '可选：备注原因（只给人看，不参与判定）' },
          },
          required: ['action'],
        },
      },
    }];
  }

  async executeTool(name, params) {
    // 失败一律返回 {ok:false, detail:'人话原因'} 的 JSON 字符串（项目铁律），
    // 不 throw 到工具调用主链 —— 模型拿到原因才知道该重试还是换方法。
    if (name !== 'world') {
      return JSON.stringify({ ok: false, detail: 'world-sense 不支持的工具：' + name });
    }
    const p = params || {};
    const action = String(p.action == null ? '' : p.action).toLowerCase();
    try {
      if (action === 'status') return JSON.stringify(this._worldStatus());
      if (action === 'correct') return JSON.stringify(this._worldCorrect(p));
      return JSON.stringify({ ok: false, detail: 'action 只能是 status / correct（收到「' + action + '」）' });
    } catch (e) {
      return JSON.stringify({ ok: false, detail: '世界工具执行失败：' + String((e && e.message) || e) });
    }
  }

  /** status：只读世界状态。字段直接取自 store 快照（不重新发明一份口径）。 */
  _worldStatus() {
    const snap = this._store.snapshot();
    // P0-4：暂停/隐私时即使还没到 2s 保鲜期，也不能把冻结状态当当前状态报给模型。
    const active = this._active();
    let priors = { ok: true, priors: [], lastError: '' };
    try {
      priors = this._priors.list();
    } catch (e) {
      priors = { ok: false, priors: [], lastError: '读先验失败：' + String((e && e.message) || e) };
    }
    return {
      ok: true,
      activity: snap.activity,
      // P0-4：stale=true 表示这不是当前状态（暂停/隐私，或超过 2× 采样周期没更新）；
      // last 是冻结前的原值，只用于诊断，消费方不得当当前情境使用。
      stale: snap.activityStale === true || !active,
      last: snap.activityLast,
      app: snap.app,
      title: snap.title,
      idle: snap.idleSec,
      since: snap.activitySince,
      why: snap.activityWhy,
      conf: snap.activityConf,
      history: this._store.recentChanges(10 * 60 * 1000).slice(-10),
      priors: priors.priors || [],
      // 先验文件坏了必须让人看见，不能静默当「没配过」
      priorsLastError: priors.lastError || '',
    };
  }

  /** correct：写用户先验，并立刻让当前 store 采用（不等下一拍 1s 采样）。 */
  _worldCorrect(p) {
    const activity = String(p.activity == null ? '' : p.activity).trim().toLowerCase();
    if (!activity) {
      return { ok: false, detail: 'correct 需要 activity（可用：' + ACTIVITY_ENUM.join(' / ') + '）' };
    }
    if (ACTIVITY_ENUM.indexOf(activity) < 0) {
      return { ok: false, detail: '不认识的 activity「' + activity + '」，可用：' + ACTIVITY_ENUM.join(' / ') };
    }

    const snap = this._store.snapshot();
    const pick = (v, fallback) => (v === undefined || v === null || String(v).trim() === '')
      ? fallback
      : String(v).trim();
    const app = pick(p.app, snap.app);
    const title = pick(p.title, snap.title);
    if (!app && !title) {
      return { ok: false, detail: '当前没有前台应用/标题，correct 至少要给 app 或 title（否则先验无处匹配）' };
    }

    const r = this._priors.upsert({ app, title, activity, note: p.note });
    if (!r || r.ok !== true) {
      return { ok: false, detail: '先验没保存成功：' + ((r && r.detail) || '未知原因') };
    }

    // 立刻重算：用户纠正后应当在下一帧就看到 why:'user-prior'。
    // 重算失败不影响已保存的先验（下一拍采样仍会采用）。
    try { this._store.refreshActivity(); } catch (e) { /* 下一拍会再算 */ }

    const now = this._store.snapshot();
    const adopted = now.activity === activity && now.activityWhy === 'user-prior';
    const out = {
      ok: true,
      activity: now.activity,
      why: now.activityWhy,
      since: now.activitySince,
      key: r.key,
      app,
      title,
      note: r.entry.note,
      ttlMs: r.entry.ttlMs,
      expiresAt: r.entry.updatedAt + r.entry.ttlMs,
      adopted,
    };
    // 显式给了别的 app/title 时，当前前台可能不匹配 —— 先验已保存，切过去才生效。
    // 这不是失败，但必须说清楚，否则模型会以为「纠正没生效」。
    if (!adopted) out.hint = '已记住先验；当前前台与 app/title 不匹配，切到该窗口时自动生效';
    return out;
  }

  // ── 采样循环（自续 setTimeout + 丢弃重入，抄 vision-organ 的形状）──
  async _loop() {
    if (!this._running) return;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }

    // 每拍都重读开关：隐私/低功耗要能在一秒内生效，而不是等下一次对话
    this._readConfig();
    if (this._cfgChanged) { this._adapters = this._buildAdapters(); this._cfgChanged = false; }

    if (!this._active()) {
      this._schedule(SAMPLE_INTERVAL_MS);
      return;
    }
    if (this._inFlight) { this._schedule(SAMPLE_INTERVAL_MS); return; }
    this._inFlight = true;
    try {
      const snapAt = Date.now();
      const snap = await this._adapters.sample();
      snap.hints = this._collectHints();
      // 文件型信号：读不到就缺省（store 里对应事实自然过期），不影响主链。
      try { snap.browser = this._browserReader.read(snapAt); } catch (e) { snap.browser = null; }
      try { snap.notifications = this._notifyReader.read(snapAt); } catch (e) { snap.notifications = null; }
      this._noteSensorStats(snap);
      // apply 内部把 snap.errors 计入 store.stats.errors（P1：pet-core 挂了不能静默空转）
      this._store.apply(snap, { source: 'system', conf: 0.9, us: snap.us });
      this._logAdapterErrors(snap);
    } catch (e) {
      // 世界感知坏了不能影响任何别的东西：记一笔，下一拍继续
      this._store.stats.errors += 1;
      this._store.stats.lastErr = String((e && e.message) || e);
      this._store.stats.lastErrAt = Date.now();
      try { this.context.log('warn', '[world-sense] 采样失败：' + this._store.stats.lastErr); } catch (e2) { /* 日志也不能抛 */ }
    } finally {
      this._inFlight = false;
      this._schedule(SAMPLE_INTERVAL_MS);
    }
  }

  /** 文件型信号的可观测计数（`/world` 的 sensors 段读它）。
   *  通知坏行只在计数变化时记一条 warn —— 坏 JSONL 不该每秒刷日志。 */
  _noteSensorStats(snap) {
    const n = snap && snap.notifications;
    if (n) {
      this._sensorStats.notifyReads += 1;
      const bad = Number(n.invalid) || 0;
      this._sensorStats.notifyInvalid = bad;
      this._sensorStats.lastNotifyCount = Math.max(0, Number(n.count) || 0);
      if (bad > 0 && bad !== this._lastNotifyInvalid) {
        this._lastNotifyInvalid = bad;
        try {
          this.context.log('warn', '[world-sense] notifications.jsonl 有 ' + bad + ' 行无法解析（已跳过）');
        } catch (e) { /* 日志不能抛 */ }
      }
    }
    const b = snap && snap.browser;
    if (b) {
      this._sensorStats.browserReads += 1;
      this._sensorStats.browserInvalid = Number(this._browserReader.stats.invalid) || 0;
    } else {
      this._sensorStats.browserNoSignal += 1;
    }
  }

  /** 适配器把采集失败塞进 snap.errors（不抛异常）—— 这里让它在日志里可见。
   *  同一错误最多 1 分钟一条：pet-core 长时间不在时不能每秒刷一行。 */
  _logAdapterErrors(snap) {
    const errs = Array.isArray(snap && snap.errors) ? snap.errors : [];
    if (!errs.length) return;
    const first = String(errs[0] || '');
    const t = Date.now();
    if (first === this._lastAdapterErr && t - this._lastAdapterErrAt < ERR_LOG_GAP_MS) return;
    this._lastAdapterErr = first;
    this._lastAdapterErrAt = t;
    try {
      this.context.log('warn', '[world-sense] 采集失败（累计 ' + (this._store.stats.errors || 0) + ' 次）：' + errs.join('; '));
    } catch (e) { /* 日志不能抛 */ }
  }

  _schedule(delay) {
    if (!this._running) return;
    this._timer = setTimeout(() => { this._loop().catch(() => {}); }, Math.max(200, delay));
    if (this._timer.unref) this._timer.unref();
  }

  /**
   * 上层已有的判断，直接当提示用（不重复造）：
   *   - watch-screen 的 `_gameCompanion`（主进程 game-watch 每 3s 推过来）
   *   - watch-screen 的 `_screenState.state`（game/video/working/idle 屏幕状态机）
   *   - 主进程 `global.__userActivity.state`（active/idle/away）
   * 读不到就是没有 —— 用可选链 + try/catch，缺任何一项都不算错。
   */
  _collectHints() {
    const hints = {};
    try {
      const pm = globalThis.pluginManager;
      const entry = pm && pm._plugins && pm._plugins.get('community/watch-screen');
      const p = entry && entry.plugin;
      if (p) {
        if (p._gameCompanion === true) hints.gaming = true;
        const ss = p._screenState;
        if (ss && ss.state) hints.screenState = String(ss.state);
      }
    } catch (e) { /* 提示缺失不算错 */ }
    try {
      const ua = globalThis.__userActivity;
      if (ua && ua.state) hints.userActivity = String(ua.state);
    } catch (e) { /* 同上 */ }
    return hints;
  }

  // ── 注入（只走易变尾巴）──────────────────────────────────────────────
  async onLLMRequest(request) {
    try {
      if (!request || typeof request.addVolatile !== 'function') return;
      this._readConfig();
      if (this._cfgChanged) { this._adapters = this._buildAdapters(); this._cfgChanged = false; }

      if (!this._active()) {
        // 隐私模式：一句交代一次，之后不再刷（别每轮都烧 token）
        const t = Date.now();
        if (t - this._stats.lastUnavailableAt > UNAVAILABLE_NOTE_GAP_MS) {
          this._stats.lastUnavailableAt = t;
          request.addVolatile('[世界] 感知已暂停（隐私模式）');
        }
        return;
      }

      const snap = this._store.snapshot();
      const res = this._store.renderWorldLine(this._lastFields, snap);
      const cache = this._readCache();

      this._stats.turns += 1;
      this._stats.lastAt = Date.now();
      this._stats.lastCacheRate = cache.rate;
      this._stats.lastPromptTokens = cache.prompt;
      this._stats.lastCachedTokens = cache.cached;

      if (!res.text) {
        // 世界没变：**完全不注入**（这是缓存/token 红线的核心）
        this._stats.lastTokens = 0;
        this._maybeWarnUnavailable();
        return;
      }

      // 世界行只走易变尾巴（前缀缓存红线不变）；内容含窗口标题，包成数据行再注入。
      const dataLine = buildWorldDataLine(res.text);
      if (!dataLine) {
        this._stats.lastTokens = 0;
        this._maybeWarnUnavailable();
        return;
      }
      request.addVolatile(dataLine);
      // 只有真的注入了才更新 diff 基准：否则「数据行封装失败」会把这次变化静默吃掉，
      // 下一轮世界没变化 → 永远不再报（宁可重复一次，不可静默丢）。
      this._lastFields = worldFields(snap);

      this._stats.injected += 1;
      this._stats.lastTokens = res.tokens;
      this._stats.lastLine = res.text;             // 上一次真的注进去的原文（排查用）
      this._stats.lastFields = res.fields.slice();
      this._stats.tokensTotal += res.tokens;
      if (res.tokens > this._stats.tokensMax) this._stats.tokensMax = res.tokens;
      if (res.truncated) this._stats.truncatedTurns += 1;

      // 超预算要发声（每小时最多一次，避免自己变成噪音）
      const limit = this._store._config.maxTokens;
      const now = Date.now();
      if (res.truncated && now - this._stats.lastWarnAt > BUDGET_WARN_GAP_MS) {
        this._stats.lastWarnAt = now;
        this.context.log('warn', `[world-sense] 世界行超预算被截断（${res.tokens}/${limit} tokens，字段 ${res.fields.join('+')}）`);
      }
      this._maybeWarnUnavailable();
    } catch (e) {
      // 任何异常都不能挡对话
      try { this.context.log('warn', '[world-sense] 注入失败：' + String((e && e.message) || e)); } catch (e2) { /* */ }
    }
  }

  /** 世界状态不可用/不完整（从没采到过 / 采集一直在报错）→ 提醒一次，不阻塞。
   *  2026-11-21 修（P1）：原来只认 samples===0 —— 但 samples 每拍都 +1，
   *  pet-core 挂掉时「一直在采样、错误一直是 0」永远不告警。现在 errors>0 也算。 */
  _maybeWarnUnavailable() {
    const st = (this._store && this._store.stats) || {};
    const neverSampled = st.samples === 0;
    const failing = Number(st.errors) > 0;
    if (!neverSampled && !failing) return;
    const t = Date.now();
    if (t - this._stats.lastUnavailableAt <= UNAVAILABLE_NOTE_GAP_MS) return;
    this._stats.lastUnavailableAt = t;
    const why = neverSampled
      ? '采样 0 次'
      : '采集错误 ' + Number(st.errors) + ' 次';
    try { this.context.log('warn', '[world-sense] 世界状态不可用（' + why + '）：' + (st.lastErr || '未知')); } catch (e) { /* */ }
  }

  /** 缓存命中：读 llm-client 记的全局账（它已经在记，这里只读，不重复实现） */
  _readCache() {
    try {
      const s = globalThis.__cacheStats;
      if (s && Number.isFinite(Number(s.lastRate))) {
        const last = Array.isArray(s.series) && s.series.length ? s.series[s.series.length - 1] : null;
        return { rate: Number(s.lastRate), prompt: last ? Number(last.prompt) : null, cached: last ? Number(last.cached) : null };
      }
    } catch (e) { /* 读不到就 null */ }
    return { rate: null, prompt: null, cached: null };
  }

  /** 主动开口次数（读 speech-budget 的今日账，只读） */
  _readProactive() {
    try {
      const { singleton } = require('../../../js/core/speech-budget.js');
      const st = singleton().stats();
      return { used: st.used, limit: st.limit, today: st.today_attempts };
    } catch (e) {
      return { used: null, limit: null, today: null, err: String((e && e.message) || e) };
    }
  }

  /** 给 8004/8103 `/world` 的可观测载荷 */
  state() {
    this._readConfig();   // 反映最新开关，而不是启动时的
    const active = this._active();
    const snap = this._store.snapshot();
    return {
      ok: active,
      enabled: this._cfg.enabled,
      privacy: this._cfg.privacy,
      lowPower: this._cfg.lowPower,
      sources: this._cfg.sources,
      activity: {
        state: snap.activity,
        conf: snap.activityConf,
        why: snap.activityWhy,
        since: snap.activitySince,
        // P0-4：消费方（speech-budget / intent-queue / mind-kernel）必须先看 stale。
        // 暂停/隐私时立即 stale；运行中超过 2× 采样周期没重算也 stale（store 已降级）。
        stale: snap.activityStale === true || !active,
        at: snap.activityAt,
        last: snap.activityLast,
      },
      world: {
        app: snap.app,
        title: snap.title,
        fullscreen: snap.fullscreen,
        media: snap.mediaStatus,
        mediaTitle: snap.mediaTitle,
        idleSec: snap.idleSec,
        clip: snap.clip,
        stale: snap.stale,
        // Phase 3：站点类别（不含 path/query）+ 无痕启发式 + 最近通知
        category: snap.category || 'other',
        privacy: snap.privacy || '',
        notifications: snap.notifications,
      },
      cost: {
        sampleUs: this._adapters.stats.lastUs,
        samples: this._store.stats.samples,
        errors: this._store.stats.errors,
        lastErr: this._store.stats.lastErr,
        turns: this._stats.turns,
        injectedTurns: this._stats.injected,
        lastTokens: this._stats.lastTokens,
        // 无痕生效时不回放上一行（lastLine/lastFields 可能含上一个页面的标题）
        lastLine: snap.privacy ? '' : this._stats.lastLine,
        lastFields: snap.privacy ? [] : this._stats.lastFields,
        tokensMax: this._stats.tokensMax,
        truncatedTurns: this._stats.truncatedTurns,
        cacheRate: this._stats.lastCacheRate,
        promptTokens: this._stats.lastPromptTokens,
        cachedTokens: this._stats.lastCachedTokens,
      },
      proactive: this._readProactive(),
      // 无痕启发式生效时，变化历史里的标题类字段也不进 /world ——
      // 否则「世界行屏蔽了，但诊断口还能看到」等于没屏蔽。
      changes: this._store.recentChanges(10 * 60 * 1000)
        .filter((c) => !(snap.privacy && (c.field === 'env.title' || c.field === 'media.track')))
        .slice(-12),
      sensors: Object.assign({}, this._sensorStats, {
        notificationsFile: this._notificationsFile,
        notifyMissing: !!(this._notifyReader.stats && this._notifyReader.stats.missing),
        browserMissing: !!(this._browserReader.stats && this._browserReader.stats.missing),
      }),
      at: Date.now(),
    };
  }
}

module.exports = WorldSensePlugin;
// 纯函数导出（_probe/test-untrusted-data.cjs 单测用；插件加载器只用类本身）
module.exports.buildWorldDataLine = buildWorldDataLine;
// Phase 3 读取器的测试口：非枚举，避免被插件加载器误当插件类。
Object.defineProperty(WorldSensePlugin, '__test', {
  enumerable: false,
  value: {
    summarizeNotifications,
    readNotificationsFile,
    parseNotificationLines,
    createNotificationReader,
    createBrowserSignalReader,
    NOTIFY_WINDOW_MS,
    BROWSER_FRESH_MS,
  },
});
