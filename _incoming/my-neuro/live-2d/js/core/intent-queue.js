/**
 * intent-queue.js —— 待发意图队列（D3，2026-11-22）
 *
 * 要解决的问题：主动开口被拒（预算用尽 / 用户刚说过话 / 静默 / 别的发起者抢先）
 * 时，那句「本来想说」就彻底没了。她不是不想说，是被闸门挡了；等空闲下来
 * 应该还有一次机会——但只能一次，而且只能在**同样的情境**里说，否则就是
 * 十分钟后突然接一句已经过时的话。
 *
 * 机制（研讨会 D3 的验收）：
 *   · 被拒 → `defer({text, intent, context})` 进队列（不改原拒绝行为，只多记一条）
 *   · 容量 5 条；满了丢最旧的，计 `dropped_overflow`
 *   · TTL 10 分钟；过期项在 defer/take/stats 时清掉，计 `dropped_stale`
 *   · 情境指纹 = `activity + app + title 摘要`（读 `globalThis.__worldSenseState()`）；
 *     补说时当前情境对不上就不取（留到 TTL 过期），避免「十分钟前游戏里的吐槽
 *     在你写文档时突然冒出来」
 *   · 空闲通道（auto-chat）每次只 `take()` **1 条**；取走即删除
 *   · 相同文本去重（同一句被拒十次也只排一条），不白占槽位
 *
 * 可观测：`stats()` 固定返回 {deferred, dropped_stale, dropped_overflow, taken}，
 * 并暴露 `window.__intentQueueStats()`（Node 测试里是 globalThis）供 doctor/探针读。
 *
 * 开关（一键关，改完 2 秒内生效，不用重启）：
 *   data/待发意图.json  {"enabled": false}
 *   （可选 {"max_items": 5, "ttl_ms": 600000}；硬上限 5 条 / 10 分钟，配置只能调小）
 *
 * 存储：纯内存（不落盘）。理由：TTL 只有 10 分钟，落盘后重启补说旧话弊大于利；
 * 计数是运行时可观测数据，进程重启归零是诚实的。需要跨会话审计时看日志，
 * 不要把这个队列变成第二份状态源。
 */
'use strict';

const fs = require('fs');
const { recordFile } = require('./records-path.js');

const CONFIG_FILE = '待发意图.json';
const HARD_MAX_ITEMS = 5;
const HARD_TTL_MS = 10 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const CONFIG_CACHE_MS = 2000;
const MAX_TEXT_CHARS = 500;
const MAX_INTENT_CHARS = 48;
const MAX_TITLE_CHARS = 48;

const DEFAULTS = {
    enabled: true,
    max_items: HARD_MAX_ITEMS,
    ttl_ms: HARD_TTL_MS,
};

function normalizeText(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

function normalizeKey(v) {
    return normalizeText(v).toLowerCase();
}

/** 读世界感知快照；拿不到/抛错都当没有（与 speech-budget 同口径，不因感知缺失阻断说话）。
 *  P0-4：activity.stale=true（world-sense 暂停/隐私，或超过 2× 采样周期没重算）时，
 *  整个世界锚点都不可信 —— 返回 null，让指纹为空（= 未知，不参与情境拦截）。
 *  否则冻结的 gaming 指纹会让「十分钟前游戏里的吐槽」在写文档时也无法补说。 */
function readWorldContext() {
    try {
        const fn = (typeof globalThis !== 'undefined') ? globalThis.__worldSenseState : null;
        if (typeof fn !== 'function') return null;
        const s = fn();
        if (!s || typeof s !== 'object') return null;
        if (s.ok === false) return null;
        const act = s.activity;
        if (act && typeof act === 'object' && act.stale === true) return null;
        const activity = act && (act.state || act.kind) || (typeof act === 'string' ? act : '');
        const app = s.world && s.world.app || '';
        const title = s.world && s.world.title || '';
        if (!activity && !app && !title) return null;
        return { activity, app, title };
    } catch (e) {
        return null;
    }
}

/**
 * 把各种 context 形状归一成指纹：
 *   · 字符串                 → 当作 title（测试/手工指定）
 *   · {activity, app, title} → 直接字段
 *   · world-sense 快照        → {activity:{state}, world:{app,title}}
 * 返回 {key, activity, app, title, stale}；全空时 key=''（= 未知，不参与拦截）。
 * stale=true 表示输入本身是冻结/暂停的世界锚点，调用方必须当「未知」。
 */
function fingerprintOf(ctx) {
    if (ctx == null) return { key: '', activity: '', app: '', title: '', stale: false };
    if (typeof ctx === 'string') {
        const t = normalizeText(ctx).slice(0, MAX_TITLE_CHARS);
        return { key: t ? 'text:' + t : '', activity: '', app: '', title: t, stale: false };
    }
    if (typeof ctx !== 'object') return { key: '', activity: '', app: '', title: '', stale: false };

    // P0-4：world-sense 的 ok=false 是「暂停/隐私」口径 —— 整个快照不可用。
    if (ctx.ok === false) return { key: '', activity: '', app: '', title: '', stale: true };

    let activity = ctx.activity;
    if (activity && typeof activity === 'object') {
        // P0-4：stale 的 activity 是冻结值，不能参与指纹 —— 直接给空指纹（未知）。
        if (activity.stale === true) {
            return { key: '', activity: '', app: '', title: '', stale: true };
        }
        activity = activity.state || activity.kind || '';
    }
    let app = ctx.app;
    let title = ctx.title;
    if (ctx.world && typeof ctx.world === 'object') {
        if (!app) app = ctx.world.app;
        if (!title) title = ctx.world.title;
    }
    const a = normalizeKey(activity);
    const p = normalizeKey(app);
    const t = normalizeText(title).slice(0, MAX_TITLE_CHARS);
    return {
        key: [a, p, t].filter(Boolean).join('|'),
        activity: a,
        app: p,
        title: t,
        stale: false,
    };
}

/**
 * 情境是否仍然是同一个：
 *   · 任一侧未知（key 为空）→ 放行（感知缺失不拦，和 speech-budget 一致）
 *   · activity / app 是硬信号：两边都有且不同 → 不是同一情境
 *   · title 是软信号：完全相同或互相包含（页面跳转但主题没变）才算同一情境
 */
function sameContext(a, b) {
    if (!a || !b) return true;
    // P0-4：任一侧是 stale 指纹（冻结值）→ 不参与匹配，放行（等同「未知」）。
    if (a.stale === true || b.stale === true) return true;
    if (!a.key || !b.key) return true;
    if (a.key === b.key) return true;
    if (a.activity && b.activity && a.activity !== b.activity) return false;
    if (a.app && b.app && a.app !== b.app) return false;
    if (a.title && b.title) {
        if (a.title === b.title) return true;
        if (a.title.includes(b.title) || b.title.includes(a.title)) return true;
        return false;
    }
    return true;
}

/**
 * 建一个队列实例（测试可注入 now/config/contextProvider，生产用 singleton）。
 * @param {{now?:function, configFile?:string, contextProvider?:function,
 *          maxItems?:number, ttlMs?:number, configCacheMs?:number}} [opts]
 */
function createIntentQueue(opts) {
    const o = opts || {};
    const now = typeof o.now === 'function' ? o.now : () => Date.now();
    const configFile = o.configFile || recordFile(CONFIG_FILE);
    const contextProvider = typeof o.contextProvider === 'function' ? o.contextProvider : readWorldContext;
    const configCacheMs = Number.isFinite(o.configCacheMs) ? o.configCacheMs : CONFIG_CACHE_MS;

    let items = [];
    let seq = 0;
    let cfgCache = null;
    let cfgAt = 0;
    let cfgError = '';
    let warnedCfgError = false;
    const counters = { deferred: 0, dropped_stale: 0, dropped_overflow: 0, taken: 0, dropped_withdrawn: 0 };
    let lastDeferredAt = 0;
    let lastTakenAt = 0;

    function clampMax(n) {
        const v = Number(n);
        if (!Number.isFinite(v) || v <= 0) return DEFAULTS.max_items;
        return Math.max(1, Math.min(HARD_MAX_ITEMS, Math.round(v)));
    }

    function clampTtl(n) {
        const v = Number(n);
        if (!Number.isFinite(v) || v <= 0) return DEFAULTS.ttl_ms;
        return Math.max(MIN_TTL_MS, Math.min(HARD_TTL_MS, Math.round(v)));
    }

    function readConfig() {
        if (cfgCache && (now() - cfgAt) < configCacheMs) return cfgCache;

        let raw = null;
        let err = '';
        try {
            const text = fs.readFileSync(configFile, 'utf8');
            if (text.trim()) raw = JSON.parse(text);
        } catch (e) {
            if (!(e && e.code === 'ENOENT')) err = String(e && e.message || e);
        }

        const cfg = Object.assign({}, DEFAULTS);
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            if (raw.enabled === false) cfg.enabled = false;
            cfg.max_items = clampMax(raw.max_items != null ? raw.max_items : raw.maxItems);
            cfg.ttl_ms = clampTtl(raw.ttl_ms != null ? raw.ttl_ms : raw.ttlMs);
        }
        // 显式注入优先（测试/专项调参），仍受硬上限约束
        if (o.maxItems != null) cfg.max_items = clampMax(o.maxItems);
        if (o.ttlMs != null) cfg.ttl_ms = clampTtl(o.ttlMs);

        cfgCache = cfg;
        cfgAt = now();
        cfgError = err;
        // 坏配置只喊一次：默认开着继续跑，但 doctor/stats 里能看见 config_error
        if (err && !warnedCfgError) {
            warnedCfgError = true;
            try { console.warn('[intent-queue] 配置读不出来，按默认值继续：' + err); } catch (e2) { /* ignore */ }
        }
        return cfg;
    }

    /** 清掉过期项；只在 defer/take/stats 时懒执行，不常驻定时器。 */
    function purge(t) {
        const cfg = readConfig();
        const keep = [];
        for (const it of items) {
            if (t - it.at > cfg.ttl_ms) {
                counters.dropped_stale += 1;
                continue;
            }
            keep.push(it);
        }
        items = keep;
    }

    /** 单次调用可传 {now} 覆盖注入时钟（测试/补算用）；否则用实例时钟。 */
    function callTime(p) {
        const n = Number(p && p.now);
        return (Number.isFinite(n) && n > 0) ? n : now();
    }

    /**
     * 记一条被拒的意图。文本相同（未过期）只更新 repeat/last_at，不占新槽。
     * 注意：**保留文本内部换行**（watch-screen 的 prompt 有分段），
     * 去重只比较归一后的 dedupKey（空白折叠），不改原文本。
     * @returns {{ok:boolean, reason?:string, duplicate?:boolean, id?:string, size:number}}
     */
    function defer(p) {
        const cfg = readConfig();
        if (!cfg.enabled) return { ok: false, reason: 'disabled', size: items.length };
        const text = Array.from(String(p && p.text != null ? p.text : '').trim()).slice(0, MAX_TEXT_CHARS).join('');
        if (!text) return { ok: false, reason: 'empty', size: items.length };
        const dedupKey = normalizeText(text);

        const t = callTime(p);
        purge(t);

        // 可选 at：从 take 里放回时保留**原始入队时间**，让 TTL 仍然从第一次被拒算起，
        // 避免「发送失败 → 放回 → at 重置」导致无限重试。未来时间戳一律夹到现在。
        const rawAt = Number(p && p.at);
        const at = (Number.isFinite(rawAt) && rawAt > 0 && rawAt <= t) ? rawAt : t;
        if (t - at > cfg.ttl_ms) return { ok: false, reason: 'stale', size: items.length };

        const dup = items.find((it) => it.dedupKey === dedupKey);
        if (dup) {
            dup.repeat += 1;
            dup.last_at = t;
            return { ok: true, duplicate: true, id: dup.id, size: items.length };
        }

        const rawContext = (p && p.context !== undefined) ? p.context : contextProvider();
        const fp = fingerprintOf(rawContext);
        const item = {
            id: 'q' + t.toString(36) + '-' + (seq += 1).toString(36),
            text,
            dedupKey,
            intent: normalizeText(p && p.intent).slice(0, MAX_INTENT_CHARS),
            fp,
            at,
            repeat: 1,
            last_at: t,
        };
        items.push(item);
        counters.deferred += 1;
        lastDeferredAt = t;

        while (items.length > cfg.max_items) {
            items.shift();
            counters.dropped_overflow += 1;
        }
        return { ok: true, duplicate: false, id: item.id, size: items.length };
    }

    /**
     * 空闲时取 **1 条** 情境匹配的意图（取走即删除）。
     * 没有匹配项返回 null（不匹配的留在队列里，等 TTL 清或情境回来说明）。
     * @returns {object|null} {id, text, intent, fp, at, repeat, age_ms}
     */
    function take(p) {
        const cfg = readConfig();
        if (!cfg.enabled) return null;

        const t = callTime(p);
        purge(t);

        const rawContext = (p && p.context !== undefined) ? p.context : contextProvider();
        const cur = fingerprintOf(rawContext);

        for (let i = 0; i < items.length; i += 1) {
            if (!sameContext(items[i].fp, cur)) continue;
            const item = items.splice(i, 1)[0];
            counters.taken += 1;
            lastTakenAt = t;
            return Object.assign({}, item, { age_ms: Math.max(0, t - item.at) });
        }
        return null;
    }

    /** 查看队列（不删除；测试/诊断用）。 */
    function peek(p) {
        purge(callTime(p));
        return items.map((it) => Object.assign({}, it, { fp: Object.assign({}, it.fp) }));
    }

    /**
     * 撤回：按完整文本删除（与 defer 的去重键同口径，忽略空白差异）。
     *
     * 为什么需要（U4，2026-11-22）：被拒的意图进队后，发起者可能**后来自己又说了一遍**
     * （alive-state 的 gate 放行路径）。不撤回就会在空闲时被 auto-chat 再补说一次 = 重复开口。
     * @returns {number} 删除条数
     */
    function dropByText(text) {
        const key = normalizeText(text);
        if (!key) return 0;
        purge(callTime());
        const before = items.length;
        items = items.filter((it) => it.dedupKey !== key);
        const n = before - items.length;
        if (n) counters.dropped_withdrawn += n;
        return n;
    }

    /**
     * 撤回：按文本前缀删除（调用方用它撤掉「自己刚才直说过的同类意图」）。
     * 空前缀不删任何东西 —— 防止一个空参数把整条队列清空。
     * @returns {number} 删除条数
     */
    function dropByPrefix(prefix) {
        const p = normalizeText(prefix);
        if (!p) return 0;
        purge(callTime());
        const before = items.length;
        items = items.filter((it) => !normalizeText(it.text).startsWith(p));
        const n = before - items.length;
        if (n) counters.dropped_withdrawn += n;
        return n;
    }

    /**
     * 固定计数 + 运行态。doctor/探针读这个，不要读内部字段。
     * @returns {{enabled:boolean, deferred:number, dropped_stale:number,
     *            dropped_overflow:number, dropped_withdrawn:number, taken:number, size:number,
     *            max_items:number, ttl_ms:number, last_deferred_at:number,
     *            last_taken_at:number, config_error:string}}
     */
    function stats(p) {
        const cfg = readConfig();
        purge(callTime(p));
        return {
            enabled: cfg.enabled,
            deferred: counters.deferred,
            dropped_stale: counters.dropped_stale,
            dropped_overflow: counters.dropped_overflow,
            // U4：发起者后来自己说了一遍，撤回队列里的同类项（不是过期、不是溢出）
            dropped_withdrawn: counters.dropped_withdrawn,
            taken: counters.taken,
            size: items.length,
            max_items: cfg.max_items,
            ttl_ms: cfg.ttl_ms,
            last_deferred_at: lastDeferredAt || 0,
            last_taken_at: lastTakenAt || 0,
            config_error: cfgError || '',
        };
    }

    function isEnabled() {
        return readConfig().enabled === true;
    }

    function currentContext() {
        return fingerprintOf(contextProvider());
    }

    /** 清空队列；默认保留计数（运行期累计值），resetCounters=true 才归零。 */
    function clear(p) {
        items = [];
        if (p && p.resetCounters === true) {
            counters.deferred = 0;
            counters.dropped_stale = 0;
            counters.dropped_overflow = 0;
            counters.taken = 0;
            counters.dropped_withdrawn = 0;
            lastDeferredAt = 0;
            lastTakenAt = 0;
        }
        return { ok: true };
    }

    return {
        defer, take, peek, dropByText, dropByPrefix, stats, isEnabled, currentContext, clear,
        get configFile() { return configFile; },
    };
}

// ── 单例 + 模块级便捷函数 ─────────────────────────────────────────────

let _singleton = null;
function singleton(opts) {
    if (!_singleton) _singleton = createIntentQueue(opts);
    return _singleton;
}

function defer(p) { return singleton().defer(p); }
function take(p) { return singleton().take(p); }
function peek(p) { return singleton().peek(p); }
function dropByText(text) { return singleton().dropByText(text); }
function dropByPrefix(prefix) { return singleton().dropByPrefix(prefix); }
function stats(p) { return singleton().stats(p); }
function isEnabled() { return singleton().isEnabled(); }
function currentContext() { return singleton().currentContext(); }
function clear(p) { return singleton().clear(p); }

module.exports = {
    createIntentQueue,
    singleton,
    defer,
    take,
    peek,
    dropByText,
    dropByPrefix,
    stats,
    isEnabled,
    currentContext,
    clear,
    fingerprintOf,
    sameContext,
    readWorldContext,
    DEFAULTS,
    CONFIG_FILE,
    HARD_MAX_ITEMS,
    HARD_TTL_MS,
};

// 可观测入口：doctor/探针 eval `window.__intentQueueStats()`（Node 里是 globalThis）。
try {
    const g = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : null);
    if (g) g.__intentQueueStats = () => singleton().stats();
} catch (e) { /* 全局挂载失败不影响模块使用 */ }
