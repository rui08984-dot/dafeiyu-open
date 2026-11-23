'use strict';

/**
 * plugins/community/rss-brief/index.js —— 世界感知 Phase 2「RSS 今日简报」
 *
 * 只做数据层，不做注入：
 *   ① 串行抓取 data/feeds.json 里启用的源（内置 fetch，10s 超时，单源失败不影响其他）
 *   ② 解析（lib/rss-parse.js）→ 72h 剪枝 → id 去重（sha1(feed_id+link)）→ 打分（lib/score.js）
 *   ③ 到达 push_window ±5 分钟、且当日推送数 < max_push_per_day 时，取未推送 top_n 条
 *      标记 pushed=true，写 data/rss-brief-last.json（{at,picked,card}）供主控注入层读取
 *
 * 明确不做：
 *   - 不注入 prompt（世界行由主控的 world-extras 统一做；这里只提供事实与 last 文件）
 *   - 不注册工具、不新增常驻端口/进程（hostUrl 只是可选的出站 POST）
 *   - 不 npm install（零依赖，只用 Node 内置 crypto/fs/path + 全局 fetch）
 *
 * 插件总开关由 enabled_plugins.json 决定（2026-11-21 单一源）；不在清单里就不加载。
 * 旧 plugin_config.enabled 仅兼容：显式 false 才关（warn 一次），缺省时不再默认关。
 * 没有 feeds 时定时器照旧空转保护（tick 内跳过），不会产生请求。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Plugin } = require('../../../js/core/plugin-base.js');
const { resolvePluginEnabled } = require('../../../js/core/plugin-context.js');
const { parseFeed } = require('./lib/rss-parse.js');
const {
  scoreItem, ageHours, toMs, normalizeUrl, clusterItems, selectDiverse,
} = require('./lib/score.js');

const DEFAULTS = {
  enabled: false,
  interval_minutes: 45,
  push_windows: ['08:30', '12:30', '19:30'],
  max_push_per_day: 3,
  top_n: 3,
  max_items: 400,
  hostUrl: '',
};

const FETCH_TIMEOUT_MS = 10 * 1000;
const HOST_POST_TIMEOUT_MS = 5 * 1000;
const WINDOW_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_PUSHED_HISTORY = 20;
const NOVELTY_DAYS = 7;
const INTEREST_MAX = 80;
const INTEREST_TTL_MS = 10 * 60 * 1000;
const FEEDS_TEMPLATE = {
  _comment: 'RSS/Atom 订阅源。enabled=false 的源不抓取；weight 是源信任权重(0-1)。默认不内置真实源，避免无网环境启动即挂死。示例：{"id":"hn","url":"https://example.com/rss","name":"HN","weight":1.0,"enabled":true}',
  feeds: [],
};

const ZH_STOP = new Set([
  '用户', '我们', '你们', '他们', '她们', '这个', '那个', '这些', '那些', '就是', '不是',
  '没有', '什么', '怎么', '现在', '一个', '因为', '所以', '但是', '如果', '已经', '还是',
  '这样', '那样', '自己', '时候', '觉得', '知道', '需要', '应该', '可能', '可以', '起来',
  '出来', '下来', '上去', '东西', '事情', '一直', '有点', '一些', '这里', '那里', '今天',
  '明天', '昨天', '经常', '而且', '然后', '其实', '确实', '非常', '特别', '比较', '喜欢',
  '要求', '讨厌', '正在', '还是', '就是', '的话', '这种', '那种', '一次', '一点', '不是',
]);

const EN_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'is', 'are', 'was', 'were', 'be',
  'been', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'it', 'this',
  'that', 'these', 'those', 'i', 'you', 'he', 'she', 'they', 'we', 'my', 'your', 'his',
  'her', 'their', 'our', 'not', 'no', 'yes', 'do', 'does', 'did', 'have', 'has', 'had',
  'can', 'could', 'should', 'would', 'will', 'just', 'very', 'so', 'than', 'too', 'also',
  'episode', 'source', 'confidence', 'version', 'updated', 'fact', 'facts', 'user', 'users',
]);

const STRING_KEYS = new Set(['fact', 'value', 'text', 'content', 'summary', 'memory', 'detail']);

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localDayKey(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function normalizeWindows(value) {
  let arr;
  if (Array.isArray(value)) arr = value;
  else if (typeof value === 'string') arr = value.split(/[,，;；\s]+/);
  else return DEFAULTS.push_windows.slice();

  const out = [];
  for (const raw of arr) {
    const m = String(raw == null ? '' : raw).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) continue;
    out.push(pad2(h) + ':' + pad2(mi));
  }
  if (arr.length === 0) return [];
  // 有内容但全部非法 → 视为配置写错，退回默认，避免静默停推
  return out.length ? Array.from(new Set(out)) : DEFAULTS.push_windows.slice();
}

function windowAt(nowMs, windows, toleranceMs) {
  const d = new Date(nowMs);
  const day = localDayKey(d);
  const nowMin = d.getHours() * 60 + d.getMinutes();
  const tolMin = Math.max(0, Math.floor(toleranceMs / 60000));
  for (const w of windows) {
    const parts = w.split(':').map(Number);
    const winMin = parts[0] * 60 + parts[1];
    let diff = Math.abs(nowMin - winMin);
    diff = Math.min(diff, 1440 - diff);
    if (diff <= tolMin) return { key: day + ' ' + w, day, window: w, offsetMinutes: diff };
  }
  return null;
}

function msUntilNextWindow(nowMs, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return 60 * 60 * 1000;
  const now = new Date(nowMs);
  let best = Infinity;
  for (const w of windows) {
    const parts = w.split(':').map(Number);
    const h = parts[0];
    const mi = parts[1];
    let t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi, 0, 0).getTime();
    if (t - nowMs <= 500) {
      t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, h, mi, 0, 0).getTime();
    }
    const delta = t - nowMs;
    if (delta > 500 && delta < best) best = delta;
  }
  return Number.isFinite(best) ? best : 60 * 60 * 1000;
}

function sha1Id(feedId, link) {
  return crypto.createHash('sha1').update(String(feedId) + String(link), 'utf8').digest('hex');
}

function clampWeight(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** 按 Unicode 码点截断，避免把 emoji 的代理对切一半 */
function clipChars(value, max) {
  const arr = Array.from(String(value == null ? '' : value));
  return arr.length <= max ? arr.join('') : arr.slice(0, max).join('');
}

function collectStrings(node, out, key) {
  if (typeof node === 'string') {
    if (!key || STRING_KEYS.has(key)) out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectStrings(v, out, key);
    return;
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) collectStrings(node[k], out, k);
  }
}

/** 中文 2-gram + 英文词，去停用词，按词频取前 80 */
function extractInterests(texts) {
  const counts = new Map();
  const add = (term) => {
    if (!term) return;
    counts.set(term, (counts.get(term) || 0) + 1);
  };
  for (const text of texts) {
    const s = String(text || '').toLowerCase();
    if (!s) continue;
    const latin = s.match(/[a-z][a-z0-9_+#.-]*/g) || [];
    for (const word of latin) {
      if (word.length >= 2 && !EN_STOP.has(word)) add(word);
    }
    const cjk = s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) || [];
    for (const run of cjk) {
      const chars = Array.from(run);
      for (let i = 0; i + 1 < chars.length; i += 1) {
        const bigram = chars[i] + chars[i + 1];
        if (!ZH_STOP.has(bigram)) add(bigram);
      }
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, INTEREST_MAX)
    .map((pair) => pair[0]);
}

function emptyState() {
  return {
    day: '',
    pushCount: 0,
    deliveredCount: 0,
    pending: [],
    windows: {},
    lastError: null,
    lastOkAt: null,
  };
}

class RssBriefPlugin extends Plugin {
  async onInit() {
    this._running = false;
    this._inFlight = false;
    this._pendingTick = false;
    this._timer = null;
    this._firstTimer = null;
    this._winTimer = null;
    this._items = [];
    this._byId = new Map();
    this._normKey = new Map();
    this._trustMap = new Map();
    this._scoreMeta = new Map();
    this._state = emptyState();
    this._interestCache = null;
    this._interestCacheAt = 0;
    this._interestWarned = false;
    this._noFeedsLogged = false;
    this._cfg = this._readConfig();
    this._resolvePaths();
    this._ensureFeedsTemplate();

    // 诊断口（只读快照）；卸载时按 owner 清理，避免多实例互相覆盖
    globalThis.__rssBriefState = () => this.state();
    globalThis.__rssBriefState.__owner = this;

    // 投递确认口：world-extras 真正注入成功后调用，把 selected 变 delivered。
    // 只挂一个全局函数；没挂时 world-extras 静默跳过（不消费）。
    globalThis.__rssMarkDelivered = (ids) => this.markDelivered(ids);
    globalThis.__rssMarkDelivered.__owner = this;
  }

  async onStart() {
    this._running = true;
    this._cfg = this._readConfig();
    this._resolvePaths();
    this._loadState();
    if (!this._cfg.enabled) {
      this.context.log('info', '[rss-brief] 未启用；要收简报请先在 data/feeds.json 配置源，再到能力页打开「RSS 今日简报」');
      return;
    }
    this._armTimers();
    this.context.log('info', '[rss-brief] 已启动：每 ' + this._cfg.interval_minutes + ' 分钟抓取；窗口 '
      + (this._cfg.push_windows.join('/') || '(无)') + '；每日上限 ' + this._cfg.max_push_per_day);
  }

  async onStop() {
    this._running = false;
    this._clearTimers();
    this._dropGlobal();
  }

  async onDestroy() {
    this._running = false;
    this._clearTimers();
    this._dropGlobal();
  }

  // ── 配置与路径 ─────────────────────────────────────────────────────────

  _resolvePaths() {
    let recordsDir = this.context && this.context.recordsDir;
    if (!recordsDir) {
      const recordsPath = require('../../../js/core/records-path.js');
      recordsDir = recordsPath.RECORDS_DIR;
    }
    this._paths = {
      recordsDir,
      feeds: path.join(recordsDir, 'feeds.json'),
      items: path.join(recordsDir, 'rss-items.jsonl'),
      last: path.join(recordsDir, 'rss-brief-last.json'),
      state: path.join(recordsDir, 'rss-brief-state.json'),
      facts: path.join(recordsDir, '用户事实.json'),
      coreMemory: path.join(recordsDir, '核心用户记忆.txt'),
    };
  }

  /** 数据契约：feeds.json 默认存在且为空数组（模板带 _comment 说明），不给任何真实源 */
  _ensureFeedsTemplate() {
    if (!this._paths || fs.existsSync(this._paths.feeds)) return;
    try {
      this._writeAtomic(this._paths.feeds, JSON.stringify(FEEDS_TEMPLATE, null, 2) + '\n');
      this.context.log('info', '[rss-brief] 已创建 data/feeds.json 模板（空源）');
    } catch (e) {
      this.context.log('warn', '[rss-brief] 创建 feeds.json 模板失败：' + ((e && e.message) || e));
    }
  }

  _readConfig() {
    let raw = {};
    try {
      if (this.context && typeof this.context.getPluginFileConfig === 'function') {
        raw = this.context.getPluginFileConfig() || {};
      }
    } catch (e) {
      raw = {};
    }
    const intOr = (v, d, min) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n >= min ? n : d;
    };
    return {
      // 总开关单一真相源（2026-11-21）：enabled_plugins.json（context）优先；
      // 旧 plugin_config.enabled 只作兼容（显式 false 才关，并警告一次）。
      // 拿不到 context 答案时保留历史默认（默认关 = false）。
      enabled: resolvePluginEnabled(this.context, raw, 'rss-brief', false),
      interval_minutes: intOr(raw.interval_minutes, DEFAULTS.interval_minutes, 1),
      push_windows: normalizeWindows(raw.push_windows === undefined ? DEFAULTS.push_windows : raw.push_windows),
      max_push_per_day: intOr(raw.max_push_per_day, DEFAULTS.max_push_per_day, 0),
      top_n: intOr(raw.top_n, DEFAULTS.top_n, 1),
      max_items: intOr(raw.max_items, DEFAULTS.max_items, 1),
      hostUrl: typeof raw.hostUrl === 'string' ? raw.hostUrl.trim() : '',
    };
  }

  _armTimers() {
    this._clearTimers();
    const intervalMs = Math.max(60 * 1000, this._cfg.interval_minutes * 60 * 1000);
    this._timer = setInterval(() => {
      this._tick('interval').catch(() => {});
    }, intervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();

    // 启动后 5s 抓一次，不阻塞宿主启动
    this._firstTimer = setTimeout(() => {
      this._tick('startup').catch(() => {});
    }, 5000);
    if (typeof this._firstTimer.unref === 'function') this._firstTimer.unref();

    this._scheduleWindowTimer();
  }

  _scheduleWindowTimer() {
    if (!this._running || !this._cfg || !this._cfg.enabled) return;
    if (this._winTimer) { clearTimeout(this._winTimer); this._winTimer = null; }
    const delay = msUntilNextWindow(Date.now(), this._cfg.push_windows);
    // 超过 6 小时先醒来重算（跨天/DST/配置变更都不至于睡死）
    const wait = Math.max(1000, Math.min(delay + 200, 6 * 60 * 60 * 1000));
    this._winTimer = setTimeout(() => {
      if (!this._running) return;
      this._tick('window').catch(() => {});
      this._scheduleWindowTimer();
    }, wait);
    if (typeof this._winTimer.unref === 'function') this._winTimer.unref();
  }

  _clearTimers() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._firstTimer) { clearTimeout(this._firstTimer); this._firstTimer = null; }
    if (this._winTimer) { clearTimeout(this._winTimer); this._winTimer = null; }
  }

  _dropGlobal() {
    if (globalThis.__rssBriefState && globalThis.__rssBriefState.__owner === this) {
      delete globalThis.__rssBriefState;
    }
    if (globalThis.__rssMarkDelivered && globalThis.__rssMarkDelivered.__owner === this) {
      delete globalThis.__rssMarkDelivered;
    }
  }

  state() {
    return {
      enabled: !!(this._cfg && this._cfg.enabled),
      running: this._running,
      items: Array.isArray(this._items) ? this._items.length : 0,
      feeds: this._trustMap ? this._trustMap.size : 0,
      pushCount: this._state ? this._state.pushCount : 0,
      deliveredCount: this._state ? Number(this._state.deliveredCount) || 0 : 0,
      pending: this._state && Array.isArray(this._state.pending) ? this._state.pending.length : 0,
      lastError: this._state ? this._state.lastError : null,
      lastOkAt: this._state ? this._state.lastOkAt : null,
      paths: this._paths ? { feeds: this._paths.feeds, items: this._paths.items } : null,
    };
  }

  // ── 主循环 ─────────────────────────────────────────────────────────────

  async _tick(reason) {
    if (!this._running) return { skipped: 'not-running' };
    if (!this._cfg || !this._cfg.enabled) return { skipped: 'disabled' };
    if (this._inFlight) {
      this._pendingTick = true;
      return { skipped: 'busy' };
    }
    this._inFlight = true;
    const started = Date.now();
    try {
      this._loadState();
      this._items = this._readItems();
      this._prune(started);
      await this._fetchAll(started);
      this._prune(Date.now());
      this._scoreAll(Date.now());
      this._writeItems();
      this._state.lastOkAt = new Date().toISOString();
      this._writeState();
      const pushResult = await this._maybePush(Date.now());
      return { ok: true, items: this._items.length, pushed: pushResult.pushed || [] };
    } catch (e) {
      this._setError('tick:' + (reason || 'interval'), e);
      return { ok: false, error: (e && e.message) || String(e) };
    } finally {
      this._inFlight = false;
      if (this._pendingTick) {
        this._pendingTick = false;
        const t = setTimeout(() => { this._tick('pending').catch(() => {}); }, 1000);
        if (typeof t.unref === 'function') t.unref();
      }
    }
  }

  // ── feeds.json ─────────────────────────────────────────────────────────

  _loadFeeds() {
    if (!fs.existsSync(this._paths.feeds)) {
      try {
        this._writeAtomic(this._paths.feeds, JSON.stringify(FEEDS_TEMPLATE, null, 2) + '\n');
        this.context.log('info', '[rss-brief] 已创建 feeds.json 模板（空源）。填入源后生效（插件总开关在能力页）');
      } catch (e) {
        this._setError('feeds-template', e);
      }
      return [];
    }
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(this._paths.feeds, 'utf8'));
    } catch (e) {
      this._setError('feeds-json', e);
      return [];
    }
    const list = Array.isArray(doc) ? doc : (doc && Array.isArray(doc.feeds) ? doc.feeds : null);
    if (!list) {
      this._setError('feeds-json', new Error('feeds.json 缺少 feeds 数组'));
      return [];
    }
    const out = [];
    const seen = new Set();
    list.forEach((f, idx) => {
      if (!f || typeof f !== 'object') return;
      const url = typeof f.url === 'string' ? f.url.trim() : '';
      if (!url || f.enabled === false) return;
      let id = typeof f.id === 'string' && f.id.trim() ? f.id.trim() : ('feed-' + idx);
      if (seen.has(id)) {
        this.context.log('warn', '[rss-brief] feeds.json 里 id 重复，跳过：' + id);
        return;
      }
      seen.add(id);
      out.push({
        id,
        url,
        name: typeof f.name === 'string' && f.name.trim() ? f.name.trim() : id,
        weight: clampWeight(f.weight),
      });
    });
    return out;
  }

  // ── 抓取 ───────────────────────────────────────────────────────────────

  async _fetchAll(nowMs) {
    const feeds = this._loadFeeds();
    this._trustMap = new Map();
    for (const f of feeds) this._trustMap.set(f.id, f.weight);

    if (feeds.length === 0) {
      if (!this._noFeedsLogged) {
        this._noFeedsLogged = true;
        this.context.log('info', '[rss-brief] feeds.json 里没有启用的源，本轮只做剪枝/打分');
      }
      return;
    }

    if (typeof fetch !== 'function') {
      this._setError('fetch-unavailable', new Error('当前运行时没有内置 fetch（需要 Node 18+/Electron 主进程）'));
      return;
    }

    let okCount = 0;
    let failCount = 0;
    let added = 0;
    let updated = 0;
    for (const feed of feeds) {
      try {
        const parsed = await this._fetchOne(feed);
        const stat = this._ingest(feed, parsed, nowMs);
        added += stat.added;
        updated += stat.updated;
        okCount += 1;
      } catch (e) {
        failCount += 1;
        this._setError('fetch:' + feed.id, e, { url: feed.url });
      }
    }
    this.context.log('info', '[rss-brief] 抓取 ' + okCount + ' 成功 / ' + failCount + ' 失败；新增 '
      + added + '，更新 ' + updated + '，候选池 ' + this._items.length);
  }

  async _fetchOne(feed) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(feed.url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': 'Dafeiyu-RSS/1.0 (+local desktop pet)',
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
      });
      if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '无响应'));
      const text = await res.text();
      if (typeof text !== 'string') throw new Error('响应不是文本');
      if (text.length > MAX_RESPONSE_BYTES) throw new Error('响应过大（' + text.length + ' chars）');
      const parsed = parseFeed(text);
      if (!parsed.ok) throw new Error('解析失败：' + parsed.error);
      return parsed;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('抓取超时（' + (FETCH_TIMEOUT_MS / 1000) + 's）');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  _ingest(feed, parsed, fetchedAt) {
    const stat = { added: 0, updated: 0, skippedNoLink: 0 };
    if (!this._normKey) this._normKey = new Map();
    for (const raw of parsed.items || []) {
      const link = String(raw.link || '').trim();
      if (!link) { stat.skippedNoLink += 1; continue; }
      // 归一化 URL：同一 feed 里带 utm_*/fbclid 的同一链接不再变成新条目。
      // 跨源同名 URL 仍是不同 item（不同 feed_id），由合簇负责只选代表。
      const normLink = normalizeUrl(link) || link;
      const key = String(feed.id) + '\n' + normLink;
      const id = sha1Id(feed.id, normLink);
      const published = raw.published_at || new Date(fetchedAt).toISOString();
      const existing = this._byId.get(id) || this._normKey.get(key);
      if (existing) {
        if (raw.title && existing.title !== raw.title) existing.title = raw.title;
        if (raw.summary && existing.summary !== raw.summary) existing.summary = raw.summary;
        if (!existing.published_at && published) existing.published_at = published;
        if (!existing.feed_name) existing.feed_name = feed.name;
        existing.link = link;
        this._normKey.set(key, existing);
        stat.updated += 1;
        continue;
      }
      const item = {
        id,
        feed_id: feed.id,
        feed_name: feed.name,
        title: clipChars(raw.title || '(无标题)', 300),
        link,
        published_at: published,
        summary: clipChars(raw.summary || '', 200),
        fetched_at: fetchedAt,
        score: 0,
        pushed: false,
      };
      this._byId.set(id, item);
      this._normKey.set(key, item);
      this._items.push(item);
      stat.added += 1;
    }
    if (stat.skippedNoLink > 0) {
      this.context.log('warn', '[rss-brief] ' + feed.name + ' 有 ' + stat.skippedNoLink + ' 条缺少 link，已跳过');
    }
    return stat;
  }

  // ── 读写 rss-items.jsonl ───────────────────────────────────────────────

  _readItems() {
    this._byId = new Map();
    this._normKey = new Map();
    if (!fs.existsSync(this._paths.items)) return [];
    let text = '';
    try {
      text = fs.readFileSync(this._paths.items, 'utf8');
    } catch (e) {
      this._setError('read-items', e);
      return [];
    }
    const out = [];
    let bad = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let raw;
      try {
        raw = JSON.parse(line);
      } catch (e) {
        bad += 1;
        continue;
      }
      if (!raw || typeof raw !== 'object' || !raw.id) { bad += 1; continue; }
      const item = {
        id: String(raw.id),
        feed_id: String(raw.feed_id || ''),
        feed_name: String(raw.feed_name || raw.feed_id || ''),
        title: String(raw.title || ''),
        link: String(raw.link || ''),
        published_at: raw.published_at ? String(raw.published_at) : null,
        summary: clipChars(raw.summary || '', 200),
        fetched_at: Number(raw.fetched_at) || 0,
        score: Number(raw.score) || 0,
        pushed: raw.pushed === true,
        // 新字段可缺省：旧行没有 cluster_* 也能跑（_scoreAll 会重算）
        cluster_key: typeof raw.cluster_key === 'string' ? raw.cluster_key : '',
        cluster_size: Number(raw.cluster_size) > 1 ? Math.floor(Number(raw.cluster_size)) : 1,
      };
      const normKey = String(item.feed_id) + '\n' + (normalizeUrl(item.link) || item.link);
      if (!this._byId.has(item.id) && !this._normKey.has(normKey)) {
        this._byId.set(item.id, item);
        this._normKey.set(normKey, item);
        out.push(item);
      } else {
        bad += 1;
      }
    }
    if (bad > 0) this.context.log('warn', '[rss-brief] rss-items.jsonl 有 ' + bad + ' 行损坏/重复，已跳过（未删原文）');
    return out;
  }

  _writeItems() {
    const rows = this._items.map((it) => {
      const row = {
        id: it.id,
        feed_id: it.feed_id,
        feed_name: it.feed_name,
        title: it.title,
        link: it.link,
        published_at: it.published_at,
        summary: it.summary,
        fetched_at: it.fetched_at,
        score: it.score,
        pushed: it.pushed === true,
      };
      // 只有跨源合簇（size>1）才追加字段：单条保持旧 10 字段契约，
      // 旧 reader/测试不受影响；旧行没有这两个字段也能跑。
      if (Number(it.cluster_size) > 1 && it.cluster_key) {
        row.cluster_key = it.cluster_key;
        row.cluster_size = Number(it.cluster_size);
      }
      return JSON.stringify(row);
    });
    this._writeAtomic(this._paths.items, rows.join('\n') + (rows.length ? '\n' : ''));
  }

  _writeLast(payload) {
    const picked = (payload.picked || []).map((entry) => {
      if (typeof entry === 'string') return { id: entry, delivered: false };
      if (entry && typeof entry === 'object' && entry.id) {
        return { id: String(entry.id), delivered: entry.delivered === true };
      }
      return null;
    }).filter(Boolean);
    const out = { at: payload.at, picked };
    // Phase 3 缺口 4：简报卡（数据层，不做 UI）。最多 5 条，供控制中心/未来卡片读；
    // world-extras 仍按 picked + items 注入（n + top1 标题 + 年龄），不依赖 card。
    if (payload.card && typeof payload.card === 'object') out.card = this._sanitizeCard(payload.card);
    this._writeAtomic(this._paths.last, JSON.stringify(out, null, 2) + '\n');
  }

  /** card 形状收敛：{at, items:[{title,feed,at,score}]（≤5）, delivered:[id]}。
   *  纯形状校验，坏字段退化为空串/0 —— 卡片读不到内容也不该把世界注入链弄崩。 */
  _sanitizeCard(card) {
    const c = (card && typeof card === 'object' && !Array.isArray(card)) ? card : {};
    const items = (Array.isArray(c.items) ? c.items : []).slice(0, 5).map((it) => {
      // 压力测试（2026-11-21）：it 可能是 null/0/'str'/数组 —— 既要读得安全，
      // 也不能让 Number(null)=0 之外的路径把 undefined/NaN/Infinity 写进卡片。
      const sc = Number(it && it.score);
      return {
        title: String((it && it.title) || '').slice(0, 120),
        feed: String((it && it.feed) || '').slice(0, 40),
        at: (typeof (it && it.at) === 'string' || typeof (it && it.at) === 'number')
          ? String(it.at) : '',
        score: Number.isFinite(sc) ? sc : 0,
      };
    });
    const delivered = (Array.isArray(c.delivered) ? c.delivered : [])
      .map((x) => String(x == null ? '' : x)).filter(Boolean).slice(0, 20);
    // c 可能是数组/布尔：[] .at 是 Array.prototype.at 函数 —— 只接受字符串/数字。
    const at = (typeof c.at === 'string' || typeof c.at === 'number') ? String(c.at) : '';
    return { at, items, delivered };
  }

  _readLast() {
    if (!this._paths || !fs.existsSync(this._paths.last)) return null;
    try {
      return JSON.parse(fs.readFileSync(this._paths.last, 'utf8'));
    } catch (e) {
      return null;
    }
  }

  /**
   * 旧格式兼容：picked 是字符串数组（升级前写的）时按 delivered:false 处理。
   * 理由：旧代码在选中时就记 pushed=true，world-extras 关闭/12h 没对话时用户根本没看到；
   * 不能当作已投递，否则正是要修的「静默消费」。重复注入一次比永久丢一条安全。
   */
  _readLastEntries() {
    const raw = this._readLast();
    if (!raw || !Array.isArray(raw.picked)) return [];
    return raw.picked.map((entry) => {
      if (typeof entry === 'string') return { id: entry, delivered: false };
      if (entry && typeof entry === 'object' && entry.id) {
        return { id: String(entry.id), delivered: entry.delivered === true };
      }
      return null;
    }).filter(Boolean);
  }

  /** 把 last 里未投递的 id 种进 pending：进程重启/升级后旧简报仍可重试 */
  _syncPendingFromLast() {
    if (!this._state) this._state = emptyState();
    const pending = new Set(Array.isArray(this._state.pending) ? this._state.pending : []);
    let changed = false;
    for (const entry of this._readLastEntries()) {
      if (entry.delivered) {
        if (pending.delete(entry.id)) changed = true;
        continue;
      }
      if (this._byId.has(entry.id) && !pending.has(entry.id)) {
        pending.add(entry.id);
        changed = true;
      }
    }
    if (changed) this._state.pending = Array.from(pending);
  }

  /**
   * 两阶段投递的第二步：world-extras 真正注入成功后调用（经 globalThis.__rssMarkDelivered）。
   * 只有这里会移除 pending / 增加 deliveredCount；未投递的条目下轮仍是候选。
   * 幂等：重复调用同一批 id 返回 delivered:0，不重复计数。
   *
   * 2026-11-21 修（P1 投递记账）：认账范围限制在 last.picked 里**真的选中过**的条目。
   * world-extras 现在只上报「标题真的写进 payload」的那一条；这里再兜一层，
   * 即使调用方误传整批 id，也不会把没展示的条目标成已投递（deliveredCount 以实际展示为准）。
   * 读不到 last（文件损坏/缺失）时退回旧行为，宁可多记一次也不卡死投递链。
   */
  markDelivered(ids) {
    const list = (Array.isArray(ids) ? ids : [ids])
      .map((x) => String(x == null ? '' : x))
      .filter(Boolean);
    const uniq = Array.from(new Set(list));
    if (!uniq.length) return { delivered: 0, ids: [] };

    this._loadState();
    const rawLast = this._readLast();
    const selected = (rawLast && Array.isArray(rawLast.picked))
      ? new Set(rawLast.picked
        .map((e) => (typeof e === 'string' ? e : (e && e.id ? String(e.id) : '')))
        .filter(Boolean))
      : null;
    const eligible = selected ? uniq.filter((id) => selected.has(id)) : uniq;
    if (!eligible.length) return { delivered: 0, ids: [] };

    const pending = new Set(Array.isArray(this._state.pending) ? this._state.pending : []);
    const deliveredIds = [];
    for (const id of eligible) {
      if (pending.has(id)) {
        pending.delete(id);
        deliveredIds.push(id);
      }
    }

    // 同步 last：对应条目 delivered=true（幂等；旧字符串条目也升级成对象）
    if (rawLast && Array.isArray(rawLast.picked)) {
      const set = new Set(eligible);
      let changed = false;
      const picked = rawLast.picked.map((entry) => {
        if (typeof entry === 'string') {
          if (!set.has(entry)) return entry;
          changed = true;
          return { id: entry, delivered: true };
        }
        if (!entry || typeof entry !== 'object' || !entry.id) return entry;
        const id = String(entry.id);
        if (!set.has(id) || entry.delivered === true) return entry;
        changed = true;
        return { id, delivered: true };
      });
      if (changed) {
        // 简报卡的 delivered 同步回填（card 只是展示数据；picked 才是投递账本）。
        let card;
        if (rawLast.card && typeof rawLast.card === 'object') {
          const prev = Array.isArray(rawLast.card.delivered) ? rawLast.card.delivered.map(String) : [];
          card = Object.assign({}, rawLast.card, {
            delivered: Array.from(new Set(prev.concat(deliveredIds))),
          });
        }
        this._writeLast({ at: rawLast.at, picked, card });
      }
    }

    if (deliveredIds.length > 0) {
      this._state.pending = Array.from(pending);
      this._state.deliveredCount = (Number(this._state.deliveredCount) || 0) + deliveredIds.length;
      this._writeState();
    }
    return { delivered: deliveredIds.length, ids: deliveredIds };
  }

  _loadState() {
    if (!this._paths || !fs.existsSync(this._paths.state)) {
      this._state = emptyState();
      return this._state;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this._paths.state, 'utf8'));
      this._state = {
        day: typeof raw.day === 'string' ? raw.day : '',
        pushCount: Number.isFinite(Number(raw.pushCount)) ? Math.max(0, Math.floor(Number(raw.pushCount))) : 0,
        deliveredCount: Number.isFinite(Number(raw.deliveredCount)) ? Math.max(0, Math.floor(Number(raw.deliveredCount))) : 0,
        pending: Array.isArray(raw.pending)
          ? Array.from(new Set(raw.pending.filter((x) => typeof x === 'string' && x)))
          : [],
        windows: raw.windows && typeof raw.windows === 'object' ? raw.windows : {},
        lastError: raw.lastError && typeof raw.lastError === 'object' ? raw.lastError : null,
        lastOkAt: typeof raw.lastOkAt === 'string' ? raw.lastOkAt : null,
      };
    } catch (e) {
      this._state = emptyState();
      this.context.log('warn', '[rss-brief] rss-brief-state.json 损坏，已重置计数：' + (e && e.message));
    }
    return this._state;
  }

  _writeState() {
    try {
      this._writeAtomic(this._paths.state, JSON.stringify(this._state, null, 2) + '\n');
    } catch (e) {
      this.context.log('error', '[rss-brief] 写 rss-brief-state.json 失败：' + ((e && e.message) || e));
    }
  }

  _writeAtomic(file, content) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    try {
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) { /* 清临时文件失败不覆盖原错误 */ }
      throw e;
    }
  }

  _setError(kind, err, extra) {
    const message = (err && err.message) ? err.message : String(err || '未知错误');
    this._state.lastError = Object.assign({
      at: new Date().toISOString(),
      kind,
      message: message.slice(0, 500),
    }, extra || {});
    this.context.log('error', '[rss-brief] ' + kind + ' 失败：' + message);
    this._writeState();
  }

  // ── 剪枝 / 打分 / 推送 ─────────────────────────────────────────────────

  _prune(nowMs) {
    const pending = new Set(this._state && Array.isArray(this._state.pending) ? this._state.pending : []);
    const consumed = [];
    const pool = [];
    for (const it of this._items) {
      // pending（选中但未投递）不能进 pushed 历史桶，否则会被 MAX_PUSHED_HISTORY 挤掉；
      // 它们下轮还要重试。旧行 pushed=true 且不在 pending → 视为已消费。
      (it.pushed && !pending.has(it.id) ? consumed : pool).push(it);
    }
    const pushed = consumed;
    const timeOf = (it) => {
      const t = toMs(it.published_at);
      if (Number.isFinite(t)) return t;
      return Number.isFinite(Number(it.fetched_at)) ? Number(it.fetched_at) : 0;
    };
    pushed.sort((a, b) => timeOf(b) - timeOf(a));
    const keptPushed = pushed.slice(0, MAX_PUSHED_HISTORY);

    const fresh = pool
      .filter((it) => ageHours(it, nowMs) <= 72)
      .sort((a, b) => timeOf(b) - timeOf(a));
    const room = Math.max(0, this._cfg.max_items - keptPushed.length);
    const keptPool = fresh.slice(0, room);

    this._items = keptPool.concat(keptPushed).sort((a, b) => timeOf(b) - timeOf(a));
    this._byId = new Map(this._items.map((it) => [it.id, it]));
    this._normKey = new Map();
    for (const it of this._items) {
      this._normKey.set(String(it.feed_id) + '\n' + (normalizeUrl(it.link) || it.link), it);
    }
    // pending 里已被剪枝的 id 清掉，避免状态文件无限长
    if (this._state && Array.isArray(this._state.pending) && this._state.pending.length) {
      const live = new Set(this._items.map((it) => it.id));
      const next = this._state.pending.filter((id) => live.has(id));
      if (next.length !== this._state.pending.length) this._state.pending = next;
    }
  }

  _recentPushedTitles(nowMs) {
    const cutoff = nowMs - NOVELTY_DAYS * 24 * 3600 * 1000;
    const pending = new Set(this._state && Array.isArray(this._state.pending) ? this._state.pending : []);
    const titles = [];
    for (const it of this._items) {
      // 只有真正投递过的才算「已推送标题」；pending 未投递，不参与 novelty 压制
      if (!it.pushed || pending.has(it.id) || !it.title) continue;
      const t = toMs(it.published_at);
      const base = Number.isFinite(t) ? t : Number(it.fetched_at) || 0;
      if (base >= cutoff) titles.push(it.title);
    }
    return titles;
  }

  _scoreAll(nowMs) {
    const interests = this._loadInterests(nowMs);
    const recentTitles = this._recentPushedTitles(nowMs);
    const pending = new Set(this._state && Array.isArray(this._state.pending) ? this._state.pending : []);
    const pushedCount = this._items.reduce(
      (n, it) => n + (it.pushed && !pending.has(it.id) ? 1 : 0), 0,
    );
    const meta = new Map();
    for (const it of this._items) {
      const r = scoreItem(it, {
        now: nowMs,
        interests,
        sourceTrust: this._trustMap.has(it.feed_id) ? this._trustMap.get(it.feed_id) : 0.5,
        recentTitles,
        pushedCount,
        clickCount: 0,
      });
      it.score = r.score;
      meta.set(it.id, r);
    }
    // 跨源合簇：URL 相同或标题 Jaccard ≥0.7 归为一簇；cluster_size = 几个源报道。
    // 代表条按当前分数选（selectDiverse 会按 cluster_key 去重，保证同簇只出一条）。
    const clusters = clusterItems(this._items);
    for (const cluster of clusters) {
      for (const it of cluster.items) {
        it.cluster_key = cluster.key;
        it.cluster_size = cluster.size;
      }
    }
    this._scoreMeta = meta;
    return meta;
  }

  _loadInterests(nowMs) {
    if (this._interestCache && nowMs - this._interestCacheAt < INTEREST_TTL_MS) {
      return this._interestCache;
    }
    const texts = [];
    try {
      const doc = JSON.parse(fs.readFileSync(this._paths.facts, 'utf8'));
      collectStrings(doc, texts, '');
    } catch (e) {
      if (e && e.code !== 'ENOENT') this.context.log('warn', '[rss-brief] 读用户事实.json 失败：' + e.message);
    }
    try {
      const memory = fs.readFileSync(this._paths.coreMemory, 'utf8');
      if (memory) texts.push(memory.slice(0, 40000));
    } catch (e) {
      if (e && e.code !== 'ENOENT') this.context.log('warn', '[rss-brief] 读核心用户记忆.txt 失败：' + e.message);
    }
    const words = extractInterests(texts);
    if (words.length === 0 && !this._interestWarned) {
      this._interestWarned = true;
      this.context.log('warn', '[rss-brief] 兴趣词表为空（用户事实/核心记忆都读不到），interest 分量按 0 计');
    }
    this._interestCache = words;
    this._interestCacheAt = nowMs;
    return words;
  }

  _maybePush(nowMs) {
    const cfg = this._cfg || this._readConfig();
    const windows = cfg.push_windows || [];
    const win = windowAt(nowMs, windows, WINDOW_TOLERANCE_MS);
    if (!win) return { pushed: [], reason: 'no-window' };

    this._loadState();
    this._rolloverDay(win.day);
    if (this._state.windows[win.key]) {
      return { pushed: [], reason: 'window-already-fired' };
    }

    this._items = this._readItems();
    // 旧 last（字符串数组）或上次未投递的 id 种进 pending：未消费的下轮仍可选
    this._syncPendingFromLast();
    this._prune(nowMs);
    const meta = this._scoreAll(nowMs);
    // 把 cluster_key/cluster_size 落盘（单条不追加字段，保持旧行契约）
    this._writeItems();

    const pending = new Set(Array.isArray(this._state.pending) ? this._state.pending : []);
    // 配额按「已投递」算，而不是「已选中」：world-extras 关闭时不会静默吃掉全天额度
    const deliveredToday = Number(this._state.deliveredCount) || 0;
    const remaining = Math.max(0, cfg.max_push_per_day - deliveredToday);
    let picked = [];
    if (remaining > 0) {
      const candidates = this._items.filter((it) => {
        const m = meta.get(it.id);
        if (!m || m.dropped || m.dup || !(m.score > 0)) return false;
        // pushed 且不在 pending = 已真正投递（或升级前的旧账）→ 不再选
        if (it.pushed && !pending.has(it.id)) return false;
        return true;
      });
      // 新条目优先，重试条目兜底：不因为一条没投出去就堵住今天的新简报
      const fresh = candidates.filter((it) => it.pushed !== true);
      const retry = candidates.filter((it) => it.pushed === true);
      const limit = Math.min(cfg.top_n, remaining);
      picked = selectDiverse(fresh, limit);
      if (picked.length < limit) {
        picked = picked.concat(selectDiverse(retry, limit - picked.length, { selected: picked }));
      }
    }

    // 先记账：同一窗口无论有没有候选都只处理一次（幂等）
    this._state.windows[win.key] = new Date(nowMs).toISOString();

    if (picked.length === 0) {
      this.context.log('info', '[rss-brief] 窗口 ' + win.window + ' 到达，但没有新的可用候选（不推送）');
      this._writeState();
      return { pushed: [], reason: 'no-candidates' };
    }

    // 选中≠送达：pushed 只表示「已选中」（兼容旧字段），真正消费看 pending/delivered
    for (const it of picked) it.pushed = true;
    const pendingSet = new Set(Array.isArray(this._state.pending) ? this._state.pending : []);
    for (const it of picked) pendingSet.add(it.id);
    this._state.pending = Array.from(pendingSet);
    this._state.pushCount += picked.length;
    // 先落 items，再落 last：last 写失败也能靠 pending 重试，不会永久丢
    this._writeItems();
    const at = new Date(nowMs).toISOString();
    const entries = picked.map((it) => ({ id: it.id, delivered: false }));
    // 简报卡：这次窗口选中的前 5 条（标题/源/发布时间/分数），delivered 由投递确认回填。
    // card.items 与 picked 同序，所以 delivered 里的 id 能按位置对回 items。
    const card = {
      at,
      items: picked.slice(0, 5).map((it) => ({
        title: String(it.title || ''),
        feed: String(it.feed_name || it.feed_id || ''),
        at: String(it.published_at || at),
        score: Number(it.score) || 0,
      })),
      delivered: [],
    };
    this._writeLast({ at, picked: entries, card });
    this._writeState();
    this.context.log('info', '[rss-brief] 选中 ' + picked.length + ' 条（' + win.window
      + '，待投递确认）：' + picked.map((it) => '《' + it.title.slice(0, 24) + '》').join(' '));

    this._notifyHost(picked, at).catch(() => {});
    return {
      pushed: entries,
      picked: entries.map((e) => e.id),
      window: win.window,
      at,
    };
  }

  _rolloverDay(day) {
    if (this._state.day === day) return;
    this._state.day = day;
    this._state.pushCount = 0;
    this._state.deliveredCount = 0;
    const next = {};
    for (const key of Object.keys(this._state.windows || {})) {
      if (key.indexOf(day + ' ') === 0) next[key] = this._state.windows[key];
    }
    this._state.windows = next;
  }

  async _notifyHost(picked, at) {
    const host = String((this._cfg && this._cfg.hostUrl) || '').trim();
    if (!host) return;
    if (typeof fetch !== 'function') return;
    const url = host.replace(/\/+$/, '') + '/rss/brief';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HOST_POST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          at,
          picked: picked.map((it) => it.id),
          items: picked.map((it) => ({ id: it.id, title: it.title, link: it.link, feed_name: it.feed_name })),
        }),
      });
      if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '无响应'));
    } catch (e) {
      this._setError('notify-host', e, { url });
    } finally {
      clearTimeout(timer);
    }
  }
}

// 单测入口：非枚举属性，避免 plugin-manager 的 mod[Object.keys(mod)[0]] 误把测试钩子当插件类
Object.defineProperty(RssBriefPlugin, '__test', {
  enumerable: false,
  value: {
    DEFAULTS,
    normalizeWindows,
    windowAt,
    msUntilNextWindow,
    localDayKey,
    sha1Id,
    extractInterests,
    emptyState,
    FETCH_TIMEOUT_MS,
    WINDOW_TOLERANCE_MS,
  },
});

module.exports = RssBriefPlugin;
