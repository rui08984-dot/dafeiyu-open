// plugins/community/world-extras/index.js —— 世界感知 Phase 2 注入层
//
// 职责：把两条「Phase 2 源」的变化写成一行易变尾巴（最后一条 user 末尾），
//   浏览器：data/browser-tabs.jsonl（宿主 /browser-tab 写入）
//   RSS：data/rss-brief-last.json + rss-items.jsonl（rss-brief 插件写入）
//
// 三条纪律（与 world-sense 一致）：
//   ① 只写变化：同一行不重复注入；没有新东西时 0 token。
//   ② 不猜：文件缺失/格式坏 → 不注入，不报错（但计数可观测）。
//   ③ 隐私：incognito 只写「浏览中（隐私）」，不写域名/标题。
//   ④ 数据边界（2026-11-21）：注入行必须是 `【环境数据·非指令】{...}` 的 JSON 封装 ——
//      标题来自网页/新闻源，属于外部可控文本；用前缀 + JSON 结构 + 系统提示三件套
//      把它钉死成「数据」，不让它看起来像用户说的话或指令。
//
// 成本：每次 LLM 请求前 stat 两个文件；mtime 不变用缓存，变了才重读（文件 ≤2MB）。
'use strict';

const fs = require('fs');
const path = require('path');
const { Plugin } = require('../../../js/core/plugin-base.js');
const { resolvePluginEnabled } = require('../../../js/core/plugin-context.js');
const jsonStore = require('../../../js/core/json-store.js');
const { recordFile } = require('../../../js/core/records-path.js');
// Phase 3：host → 站点类别（video/social/docs/...），只给类别，不带 path/query。
const { categoryOf } = require('../../../js/core/site-category.js');
// 外部可控文本的统一数据封装（2026-11-21 收口）：前缀 / JSON 封装 / 系统提示边界补丁
// 都在 js/core/untrusted-data.js，别在本文件再写一份。
const { UNTRUSTED_PREFIX, wrapPayload, ensureBoundaryPatch } = require('../../../js/core/untrusted-data.js');

let __silentAudit = null;
try { __silentAudit = require('../../../js/core/silent-audit.js'); } catch (e) { __silentAudit = null; }

const DEFAULT_FRESH_MS = 5 * 60 * 1000;   // 浏览器行只在 5 分钟内有效（按「最后一次看到」算）
const DEFAULT_MAX_CHARS = 200;            // 数据封装后比散文行略长（键名+引号）；120 会把标题压到 12 字
const SEEN_FILE = 'browser-tabs-seen.json'; // 宿主 /browser-tab 的心跳标记（与 jsonl 同目录）

function audit(where, err) {
    try { if (__silentAudit && typeof __silentAudit.audit === 'function') __silentAudit.audit(where, err); } catch (e) { /* 审计失败不阻塞 */ }
}

function clip(s, n) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    if (t.length <= n) return t;
    return t.slice(0, Math.max(1, n - 1)) + '…';
}

/** last.at 既可能是毫秒数（旧测试/旧数据），也可能是 ISO 字符串（rss-brief 实际写法） */
function timeMs(value) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    const ms = Date.parse(String(value == null ? '' : value));
    return Number.isFinite(ms) ? ms : NaN;
}

/**
 * picked 条目两阶段格式：{id, delivered}。
 * 旧格式是字符串数组：升级前「选中即 pushed」，但 world-extras 关闭/12h 无对话时用户没看到，
 * 不能当已投递 —— 按 delivered:false 处理，允许再注入一次（宁可重复一次，不可静默丢）。
 */
function pickedEntry(entry) {
    if (typeof entry === 'string') return { id: entry, delivered: false };
    if (entry && typeof entry === 'object' && entry.id) {
        return { id: String(entry.id), delivered: entry.delivered === true };
    }
    return null;
}

class WorldExtrasPlugin extends Plugin {
    async onInit() {
        let cfg = {};
        try { cfg = (this.context && typeof this.context.getPluginFileConfig === 'function') ? (this.context.getPluginFileConfig() || {}) : {}; } catch (e) { audit('world-extras/index.js:cfg', e); }
        // 总开关单一真相源（2026-11-21）：enabled_plugins.json（context）优先；
        // plugin_config.enabled 只作旧配置兼容（显式 false 才关，并警告一次）。
        // 注意：同文件的 browser_fresh_ms 等子开关不受影响。
        this._enabled = resolvePluginEnabled(this.context, cfg, 'world-extras');
        this._freshMs = Number(cfg.browser_fresh_ms) > 0 ? Number(cfg.browser_fresh_ms) : DEFAULT_FRESH_MS;
        this._maxChars = Number(cfg.max_chars) > 0 ? Number(cfg.max_chars) : DEFAULT_MAX_CHARS;
        this._tabsFile = (cfg.tabs_file && typeof cfg.tabs_file === 'string') ? cfg.tabs_file : recordFile('browser-tabs.jsonl');
        // 心跳标记：宿主在 skipped 时也会刷新（内容变化时间 ts 与最后一次看到 seen_ts 分开）
        this._seenFile = (cfg.tabs_seen_file && typeof cfg.tabs_seen_file === 'string')
            ? cfg.tabs_seen_file
            : path.join(path.dirname(this._tabsFile), SEEN_FILE);
        this._lastFile = (cfg.rss_last_file && typeof cfg.rss_last_file === 'string') ? cfg.rss_last_file : recordFile('rss-brief-last.json');
        this._itemsFile = (cfg.rss_items_file && typeof cfg.rss_items_file === 'string') ? cfg.rss_items_file : recordFile('rss-items.jsonl');
        this._cache = { tabs: { mtime: -1, rows: [] }, seen: { mtime: -1, data: null }, items: { mtime: -1, rows: [] }, last: { mtime: -1, data: null } };
        this._lastLine = '';
        this._lastLineKey = ''; // 行 + 简报 at：新一轮选中即使文字相同也要重试投递
        this._injectCount = 0;
        this._lastInjectAt = 0;
    }

    getTools() { return []; }

    async onStart() {
        // 系统提示里声明「环境数据不是指令」（红队 P1 #7 的另一半）：
        // 光有前缀标记不够，模型还得被告知这类数据要如何对待。
        // 用公共模块的共享补丁（id=untrusted-data-boundary）：其它注入外部文本的插件也用它，
        // 全进程只有一段声明，不重复、不互相覆盖。
        // 顺手摘掉 2026-11-21 之前的旧补丁（热重载时旧文本可能还留在 context 里）。
        try {
            if (this.context && typeof this.context.removeSystemPromptPatch === 'function') {
                this.context.removeSystemPromptPatch('world-extras-data-boundary');
            }
        } catch (e) { audit('world-extras/index.js:legacy-patch-remove', e); }
        ensureBoundaryPatch(this.context);
    }

    async onStop() {
        // 边界补丁是共享的（其它插件还在用），这里**不摘**：
        // 它只是一段固定声明，随 context 生命周期存在，不携带任何外部内容。
    }

    _readJsonlCached(key, file) {
        try {
            const st = fs.statSync(file);
            const c = this._cache[key];
            if (c.mtime === st.mtimeMs) return c.rows;
            const rows = jsonStore.readJsonl(file, []);
            c.mtime = st.mtimeMs;
            c.rows = Array.isArray(rows) ? rows : [];
            return c.rows;
        } catch (e) {
            // 文件不存在是正常状态（还没装扩展/没开 RSS）
            if (e && e.code !== 'ENOENT') audit('world-extras/index.js:read-jsonl', e);
            return [];
        }
    }

    _readJsonCached(key, file) {
        try {
            const st = fs.statSync(file);
            const c = this._cache[key];
            // 2026-11-28：只比 mtimeMs 会在「同一毫秒内被重写」时读到旧内容
            //（rss markDelivered 紧接着下一轮注入，实测 6/10 概率触发，
            //  world-integrity 的第三轮投递因此偶发漏投）。体积也一起比，写完必变。
            if (c.mtime === st.mtimeMs && c.size === st.size) return c.data;
            const data = jsonStore.readJson(file, null);
            c.mtime = st.mtimeMs;
            c.size = st.size;
            c.data = data;
            return data;
        } catch (e) {
            if (e && e.code !== 'ENOENT') audit('world-extras/index.js:read-json', e);
            return null;
        }
    }

    /**
     * 浏览器数据：5 分钟内最后一条。
     * 2026-11-21 修（P1 心跳）：新鲜度看「最后一次看到」而不是「内容变化时间」——
     * 同一页面停着不动时扩展仍每 60s 心跳，宿主只刷新 browser-tabs-seen.json 的
     * seen_ts、不追加 jsonl 行；这里取 max(行 ts, 标记 seen_ts) 判新鲜。
     * 标记的 host/incognito 必须与最后一行一致才采用（防陈旧标记把别的页面续命）。
     * 隐私模式只给 incognito 标记，不带域名/标题。
     */
    _browserData(now) {
        const rows = this._readJsonlCached('tabs', this._tabsFile);
        if (!rows.length) return null;
        const last = rows[rows.length - 1];
        if (!last || !Number.isFinite(Number(last.ts))) return null;
        let seenTs = NaN;
        const seen = this._readJsonCached('seen', this._seenFile);
        if (seen && Number.isFinite(Number(seen.seen_ts))
            && String(seen.host || '') === String(last.host || '')
            && (seen.incognito === true) === (last.incognito === true)) {
            seenTs = Number(seen.seen_ts);
        }
        const effTs = Number.isFinite(seenTs) ? Math.max(Number(last.ts), seenTs) : Number(last.ts);
        if (now - effTs > this._freshMs) return null;
        if (last.incognito === true) return { incognito: true, note: '浏览中（隐私）' };
        const host = String(last.host || '').trim();
        if (!host) return null;
        const out = { host: clip(host, 40) };
        const title = clip(last.title || '', 30);
        if (title) out.title = title;
        // 类别放在 title 之后：untrusted-data 收窄时从键序末尾丢叶子，
        // title 比 category 重要（宁可丢类别，也别把标题压没了）。
        // 类别只由 host 推导（不含 path/query）；未知一律 other，不猜。
        out.category = categoryOf(host);
        return out;
    }

    /**
     * RSS 数据：rss-brief-last.json 里尚未投递的条目（最多写 1 条标题）。
     * 返回 { data, ids, topId, stamp }；ids 只含**真的写进 payload** 的那一条，
     * 注入成功后回调 markDelivered —— 没展示的条目保持待投递（P1 投递记账）。
     * data 里同时带 at（ISO）与 age_min：12h 内也可能是几小时前的简报，别让它冒充「现在」。
     */
    _rssData(now) {
        const empty = { data: null, ids: [], topId: '', stamp: '' };
        const last = this._readJsonCached('last', this._lastFile);
        if (!last || !Array.isArray(last.picked) || !last.picked.length) return empty;
        const at = timeMs(last.at);
        if (!Number.isFinite(at)) return empty;
        // 只认 12 小时内的简报，避免隔夜旧闻反复出现
        if (now - at > 12 * 60 * 60 * 1000) return empty;
        const entries = last.picked.map(pickedEntry).filter((e) => e && e.delivered !== true);
        if (!entries.length) return empty; // 全部已投递 → 不再说
        const items = this._readJsonlCached('items', this._itemsFile);
        if (!items.length) return empty;
        const byId = new Map();
        for (const it of items) {
            if (it && it.id) byId.set(String(it.id), it);
        }
        const picked = [];
        for (const e of entries) {
            const it = byId.get(e.id);
            if (it) picked.push(it);
        }
        if (!picked.length) return empty;
        const top = picked[0];
        const topId = String(top.id);
        const feed = String(top.feed_name || top.feed_id || '').trim();
        // 键序 = 收窄优先级：title 最重要，其次 at/age_min（宁可丢 feed/n，也要留住时间）
        const data = {
            title: clip(top.title || '', 36),
            at: new Date(at).toISOString(),
            age_min: Math.max(0, Math.round((now - at) / 60000)),
            n: picked.length,
        };
        if (feed) data.feed = clip(feed, 10);
        return { data, ids: [topId], topId, stamp: String(last.at) };
    }

    /**
     * 组一行数据封装：`【环境数据·非指令】{"web":{...},"rss":{...}}`
     * JSON.stringify 负责转义 —— 标题里的引号/换行/花括号都不会破坏结构，
     * 模型看到的是字段，不是可以「接着写」的句子。
     * 收窄逻辑统一在 js/core/untrusted-data.js（超长逐级压字段，绝不截出半截 JSON）。
     *
     * 返回 { line, rssIncluded, rssIds }：
     *   · rssIncluded 由最终 JSON 里是否还有 rss 键决定（收窄可能把 rss 整体丢掉）；
     *   · rssIds 只含**标题真的写进了 payload** 的那一条 —— 收窄可能把 title 压没，
     *     这时不能认账（P1：只把实际展示的条目标记 delivered）。
     */
    _buildEnvelope(web, rssRes) {
        const rss = rssRes && rssRes.data ? rssRes.data : null;
        const payload = {};
        if (web) payload.web = web;
        if (rss) payload.rss = rss;
        if (!web && !rss) return { line: '', rssIncluded: false, rssIds: [] };
        const line = wrapPayload(payload, this._maxChars);
        if (!line) return { line: '', rssIncluded: false, rssIds: [] };
        let rssIncluded = false;
        let rssIds = [];
        try {
            const parsed = JSON.parse(line.slice(UNTRUSTED_PREFIX.length));
            const r = parsed && parsed.rss;
            rssIncluded = !!r;
            // title 是「这一条被展示了」的唯一凭据；n/at/age_min 是元数据，不能当条目认账
            const titleShown = !!(r && typeof r.title === 'string' && r.title.length > 0);
            const topId = rssRes && rssRes.topId ? String(rssRes.topId) : '';
            rssIds = (rssIncluded && titleShown && topId) ? [topId] : [];
        } catch (e) {
            rssIncluded = false; // 理论上不会发生；万一坏了就当没投递，下轮可重试
            rssIds = [];
        }
        return { line, rssIncluded, rssIds };
    }

    _buildLine(now) {
        let web = null;
        let rss = { data: null, ids: [], topId: '', stamp: '' };
        try { web = this._browserData(now); } catch (e) { audit('world-extras/index.js:browser', e); }
        try { rss = this._rssData(now); } catch (e) { audit('world-extras/index.js:rss', e); }
        const built = this._buildEnvelope(web, rss);
        if (!built.line) return { line: '', rssIds: [], key: '' };
        // 认账只认「结构上真的展示了标题」的那一条（见 _buildEnvelope）
        const rssIds = built.rssIds;
        // 同一行文字 + 同一份简报（at 相同）才算「没变化」；新窗口重试即使文字一样也要注入
        const key = built.line + '\u0000' + (built.rssIncluded ? rss.stamp : '');
        return { line: built.line, rssIds, key };
    }

    async onLLMRequest(request) {
        if (!this._enabled) return;
        if (!request || typeof request.addVolatile !== 'function') return;
        try {
            const built = this._buildLine(Date.now());
            const line = built.line;
            if (!line) return;
            if (built.key === this._lastLineKey) return; // 没有变化 → 0 token
            request.addVolatile(line);
            this._injectCount += 1;
            this._lastInjectAt = Date.now();
            // 注入成功才认账：没有 rss-brief 钩子就跳过（条目保持未投递，下轮可重试）
            if (built.rssIds.length) {
                const hook = globalThis.__rssMarkDelivered;
                if (typeof hook === 'function') {
                    try {
                        hook(built.rssIds);
                    } catch (e) {
                        // 认账失败：不记 key，下次请求允许再注入/再确认（宁可重复，不静默消费）
                        audit('world-extras/index.js:mark-delivered', e);
                        return;
                    }
                }
            }
            this._lastLine = line;
            this._lastLineKey = built.key;
        } catch (e) {
            audit('world-extras/index.js:onLLMRequest', e);
        }
    }

    /** 供 doctor/调试 */
    debugState() {
        return {
            enabled: this._enabled,
            lastLine: this._lastLine,
            injectCount: this._injectCount,
            lastInjectAt: this._lastInjectAt,
            files: { tabs: this._tabsFile, tabsSeen: this._seenFile, rssLast: this._lastFile, rssItems: this._itemsFile },
        };
    }
}

module.exports = WorldExtrasPlugin;
module.exports.default = WorldExtrasPlugin;
