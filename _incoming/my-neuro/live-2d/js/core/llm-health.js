// js/core/llm-health.js —— 云端 LLM 健康 / 配额熔断（持久化单例）
//
// 为什么需要：
//   2026-11-24 审计发现 memory-evolve 在套餐周配额耗尽后**每 5 分钟**重试同一批，
//   从 11-23 17:12 一路烧到 11-24 12:46（runtime.log 里 99 条 `LLM API error: 429`），
//   而 429 的响应体里明明写着「Your limit resets at 2026-11-24T08:30:32.238Z」。
//   问题有两半：
//     ① plugin-context.callLLM 在 !ok 时只抛 `LLM API error: 429`，把响应体（含重置时间）丢了；
//     ② 后台任务没有「云端不可用就别再撞」的共享状态，各自每轮傻试。
//   本模块是第 ② 半：一份**跨插件共享、落盘、重启不丢**的熔断状态。
//
// 规则（与本轮 P0-1 任务书一致，别自行发散）：
//   · 429 且能解析出配额重置时刻 → pausedUntil = 重置时刻 + 2 分钟缓冲，reason=quota_exhausted
//   · 429 无重置时刻 / 网络错误 / 5xx → 指数退避 5→10→20→40→80→160 分钟，封顶 6h
//   · 连续失败 ≥5 次 → pausedUntil = 下一个本地 00:05（reason=day_stop）
//   · 成功 → 全清
//   · 日志只在**状态迁移**时喊一次（状态没变就不重复刷屏）——这是本轮 429 刷屏的直接教训
//
// 落盘：json-store.writeJson（tmp+rename 原子写），默认 `RECORDS_DIR/LLM健康.json`；
// `createLlmHealth({ path })` / 单例的 `resetForTests({ path })` 可把状态指到临时目录。
// 写盘失败只 warn，不影响调用方（熔断是保护措施，不能因为磁盘问题把主链弄挂）。
//
// 注意：状态是「宿主机级」而不是「插件级」——所有后台任务（memory-evolve / user-profile
// / 以后的 Agent B 插件）共用同一个单例，这样一处踩到 429，别处立刻知道。
'use strict';

const path = require('path');
const jsonStore = require('./json-store.js');

const FILE_NAME = 'LLM健康.json';

const QUOTA_GRACE_MS = 2 * 60 * 1000;              // 配额重置后再留 2 分钟缓冲
const BACKOFF_MINUTES = [5, 10, 20, 40, 80, 160];  // 指数退避阶梯
const BACKOFF_CAP_MS = 6 * 3600 * 1000;            // 单次最长退避 6 小时
const MAX_CONSECUTIVE_FAILURES = 5;                // 连败到这就停当天
const DAY_STOP_HOUR = 0;
const DAY_STOP_MINUTE = 5;

// 只保留错误摘要里「有用不敏感」的部分。插件层的 body 本来就已截断，
// 这里再挡一次 key/token 形态的字符串（防御性，正常路径不会出现）。
const SECRET_PATTERNS = [
    /\bsk-[A-Za-z0-9_-]{6,}/g,
    /\bBearer\s+[A-Za-z0-9._-]{6,}/gi,
    /\bapi[_-]?key["'\s:=]+[A-Za-z0-9._-]{6,}/gi,
];

function sanitize(text) {
    let s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    for (const re of SECRET_PATTERNS) s = s.replace(re, '[redacted]');
    return s;
}

function toMs(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 从任意文本里找 ISO 时间（兼容 `resets at ...` 之外的裸 ISO）。 */
function findIsoTime(text) {
    const m = String(text || '').match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/);
    if (!m) return 0;
    const t = Date.parse(m[0]);
    return Number.isFinite(t) && t > 0 ? t : 0;
}

function parseJsonBody(body) {
    if (body && typeof body === 'object') return body;
    const s = String(body || '');
    if (!s.trim() || (s.trim()[0] !== '{' && s.trim()[0] !== '[')) return null;
    try { return JSON.parse(s); } catch (e) { return null; }
}

/** 从 err 上找「配额何时重置」：插件层附的 quotaResetAt 优先，其次响应体/文本里的 ISO。 */
function parseQuotaResetAt(err) {
    if (!err) return 0;
    const direct = toMs(err.quotaResetAt);
    if (direct) return direct;
    const bodyText = typeof err.body === 'string' ? err.body : '';
    const parsed = parseJsonBody(err.body);
    if (parsed && typeof parsed === 'object') {
        const cands = [
            parsed.resets_at, parsed.reset_at, parsed.quota_reset_at,
            parsed.error && parsed.error.resets_at,
            parsed.error && parsed.error.reset_at,
            parsed.error && parsed.error.message,
            parsed.message,
        ];
        for (const c of cands) {
            if (typeof c === 'number' && Number.isFinite(c)) {
                // 秒级时间戳（<1e12）换算成毫秒
                return c > 1e12 ? Math.floor(c) : Math.floor(c * 1000);
            }
            if (typeof c === 'string') {
                const t = findIsoTime(c) || Number(Date.parse(c)) || 0;
                if (t > 0) return t;
            }
        }
    }
    return findIsoTime(bodyText);
}

/** 从 err 上找 Retry-After：retryAfterMs（插件层附）/ body.retry_after（秒）/ headers。 */
function parseRetryAfterMs(err, now) {
    if (!err) return 0;
    const direct = toMs(err.retryAfterMs);
    if (direct) return direct;

    const parsed = parseJsonBody(err.body);
    if (parsed && typeof parsed === 'object') {
        const ms = toMs(parsed.retry_after_ms) || toMs(parsed.retryAfterMs);
        if (ms) return ms;
        const sec = toMs(parsed.retry_after) || toMs(parsed.retryAfter);
        if (sec) return sec * 1000;
        const errObj = parsed.error;
        if (errObj && typeof errObj === 'object') {
            const ems = toMs(errObj.retry_after_ms) || toMs(errObj.retryAfterMs);
            if (ems) return ems;
            const esec = toMs(errObj.retry_after) || toMs(errObj.retryAfter);
            if (esec) return esec * 1000;
        }
    }

    let header = null;
    try {
        const h = err.headers;
        if (h && typeof h.get === 'function') header = h.get('retry-after');
        else if (h && typeof h === 'object') header = h['retry-after'] ?? h['Retry-After'];
    } catch (e) { header = null; }
    if (header != null) {
        const sec = Number(header);
        if (Number.isFinite(sec) && sec > 0) return sec * 1000;
        const t = Date.parse(String(header));
        if (Number.isFinite(t) && t > now) return t - now;
    }
    return 0;
}

/** 下一个本地 00:05（不是 UTC —— toISOString 会把本地凌晨算到前一天）。 */
function nextDayStop(now) {
    const d = new Date(now);
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAY_STOP_HOUR, DAY_STOP_MINUTE, 0, 0);
    if (t.getTime() <= now) t.setDate(t.getDate() + 1);
    return t.getTime();
}

function localStamp(ms) {
    const d = new Date(Number(ms) || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function emptyState() {
    return {
        consecutiveFailures: 0,
        nextAttemptAt: 0,
        pausedUntil: 0,
        lastError: null,
        lastErrorAt: 0,
        source: 'none',
        updated_at: 0,
    };
}

function normalizeState(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const source = typeof s.source === 'string' && s.source ? s.source : 'none';
    return {
        consecutiveFailures: Math.max(0, Math.floor(Number(s.consecutiveFailures) || 0)),
        nextAttemptAt: toMs(s.nextAttemptAt),
        pausedUntil: toMs(s.pausedUntil),
        lastError: typeof s.lastError === 'string' && s.lastError ? s.lastError : null,
        lastErrorAt: toMs(s.lastErrorAt),
        source,
        updated_at: toMs(s.updated_at),
    };
}

/** 默认状态文件：唯一真源 RECORDS_DIR（PET_DATA_ROOT 设了就是临时记录室）。 */
function defaultStatePath() {
    // records-path 在 require 时解析 RECORDS_DIR（含 PET_DATA_ROOT），这里惰性取，
    // 保证「先设环境变量、后首次使用」的测试顺序也能拿到隔离路径。
    const root = process.env.PET_DATA_ROOT;
    let recordsDir = null;
    try {
        const rp = require('./records-path.js');
        recordsDir = rp && rp.RECORDS_DIR ? rp.RECORDS_DIR : null;
    } catch (e) { recordsDir = null; }
    if (root) {
        const absRoot = path.resolve(root);
        // records-path 可能在我们设 PET_DATA_ROOT 之前就被别处 require 过（缓存了生产路径）：
        // 这种情况下按同一约定自己拼一次，绝不把测试状态写进真实记录室。
        const rel = recordsDir ? path.relative(absRoot, path.resolve(recordsDir)) : '..';
        if (!recordsDir || rel.startsWith('..') || path.isAbsolute(rel)) {
            recordsDir = path.join(absRoot, 'data');
        }
    }
    if (!recordsDir) recordsDir = path.join(__dirname, '..', '..', 'data');
    return path.join(recordsDir, FILE_NAME);
}

class LlmHealth {
    /**
     * @param {{path?: string, logger?: Function}} [opts]
     *   path   —— 状态文件路径（测试隔离用；不传走 RECORDS_DIR/LLM健康.json）
     *   logger —— 覆盖日志出口（默认 console.warn）；测试可用来抓「只喊一次」
     */
    constructor(opts) {
        const o = opts || {};
        this._path = o.path ? path.resolve(String(o.path)) : null;
        this._logger = typeof o.logger === 'function' ? o.logger : (msg) => {
            try { console.warn(msg); } catch (e) { /* 控制台不可用也不影响熔断 */ }
        };
        this._state = emptyState();
        this._loaded = false;
        this._lastBlockSignature = null;
    }

    _filePath() {
        if (!this._path) this._path = defaultStatePath();
        return this._path;
    }

    _ensureLoaded() {
        if (this._loaded) return;
        this._loaded = true;
        let raw = null;
        try { raw = jsonStore.readJson(this._filePath(), null); } catch (e) {
            this._warn('[LLM健康] 状态读取失败（按空状态继续）: ' + ((e && e.message) || e));
        }
        this._state = normalizeState(raw);
        if (this._state.pausedUntil || this._state.nextAttemptAt) {
            this._lastBlockSignature = this._signature(this._state.source,
                this._state.pausedUntil || this._state.nextAttemptAt);
        }
    }

    _warn(msg) {
        try { this._logger(msg); } catch (e) { /* 日志失败不能反向弄挂调用方 */ }
    }

    _persist() {
        this._state.updated_at = Date.now();
        try {
            jsonStore.writeJson(this._filePath(), this._state);
            return true;
        } catch (e) {
            this._warn('[LLM健康] 状态落盘失败（本次熔断只在内存生效）: ' + ((e && e.message) || e));
            return false;
        }
    }

    _signature(source, until) {
        return String(source || 'none') + ':' + String(Math.round(Number(until) || 0));
    }

    /** 状态迁移才喊一次：同一暂停/退避窗口内反复失败不刷屏。 */
    _noteTransition(source, until, message) {
        const sig = this._signature(source, until);
        if (sig === this._lastBlockSignature) return;
        this._lastBlockSignature = sig;
        this._warn(message);
    }

    /**
     * 现在能不能调云端 LLM。
     * @param {number} [now=Date.now()]
     * @returns {{ok:boolean, reason:string|null, retryAt:number|null}}
     */
    canCall(now) {
        this._ensureLoaded();
        const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
        let expired = false;
        if (this._state.pausedUntil && this._state.pausedUntil <= ts) {
            this._state.pausedUntil = 0;
            expired = true;
        }
        if (this._state.nextAttemptAt && this._state.nextAttemptAt <= ts) {
            this._state.nextAttemptAt = 0;
            expired = true;
        }
        if (expired) {
            if (!this._state.pausedUntil && !this._state.nextAttemptAt) this._state.source = 'none';
            this._lastBlockSignature = null;
            this._persist();
        }
        const paused = this._state.pausedUntil;
        if (paused > ts) {
            return { ok: false, reason: this._state.source && this._state.source !== 'none' ? this._state.source : 'paused', retryAt: paused };
        }
        const next = this._state.nextAttemptAt;
        if (next > ts) return { ok: false, reason: 'backoff', retryAt: next };
        return { ok: true, reason: null, retryAt: null };
    }

    /** 调用成功：连续失败、退避、暂停、错误摘要全清。 */
    noteSuccess() {
        this._ensureLoaded();
        const prevSource = this._state.source;
        const dirty = this._state.consecutiveFailures > 0 || this._state.nextAttemptAt > 0 ||
            this._state.pausedUntil > 0 || !!this._state.lastError;
        this._state = emptyState();
        this._lastBlockSignature = null;
        if (dirty) {
            this._persist();
            if (prevSource && prevSource !== 'none') {
                this._warn('[LLM健康] 云端调用已恢复，清空熔断（原 ' + prevSource + '）');
            }
        }
        return this.getStatus();
    }

    /**
     * 记一次失败。err 上读 status / body / retryAfterMs / quotaResetAt
     * （后两个由 plugin-context 附加）。
     * @returns {{state:object, retryAt:number}}
     */
    noteFailure(err, now) {
        this._ensureLoaded();
        const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
        const status = Number(err && err.status) || 0;

        const failures = this._state.consecutiveFailures + 1;
        const quotaResetAt = status === 429 ? parseQuotaResetAt(err) : 0;
        const retryAfterMs = parseRetryAfterMs(err, ts);
        const errorText = sanitize((err && (err.body || err.message)) || err || 'LLM 调用失败').slice(0, 200);

        let source = 'none';
        let pausedUntil = 0;
        let nextAttemptAt = 0;
        let logMessage = '';

        if (status === 429 && quotaResetAt) {
            source = 'quota_exhausted';
            pausedUntil = quotaResetAt + QUOTA_GRACE_MS;
            logMessage = '[LLM健康] 云端配额用尽（quota_exhausted），暂停到 ' + localStamp(pausedUntil) +
                '（重置 ' + localStamp(quotaResetAt) + ' + 2 分钟缓冲）';
        } else if (status === 429 || status === 0 || status >= 500) {
            const stepIdx = Math.min(failures - 1, BACKOFF_MINUTES.length - 1);
            let waitMs = BACKOFF_MINUTES[stepIdx] * 60 * 1000;
            if (retryAfterMs > waitMs) waitMs = retryAfterMs;
            waitMs = Math.min(waitMs, BACKOFF_CAP_MS);
            source = 'backoff';
            nextAttemptAt = ts + waitMs;
            logMessage = '[LLM健康] 云端调用失败 ' + failures + ' 次（' + (status ? 'HTTP ' + status : '网络错误') +
                '），退避 ' + Math.round(waitMs / 60000) + ' 分钟，' + localStamp(nextAttemptAt) + ' 后再试';
        }

        // 连败 ≥5：当天停手（退避/配额窗口若更远则保留更远的那个，绝不让熔断变短）。
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
            const dayStop = nextDayStop(ts);
            const horizon = Math.max(pausedUntil, nextAttemptAt);
            if (dayStop >= horizon) {
                source = 'day_stop';
                pausedUntil = dayStop;
                nextAttemptAt = 0;
                logMessage = '[LLM健康] 连续失败 ' + failures + ' 次，今天不再调用（' + localStamp(dayStop) + ' 恢复）';
            }
        }

        this._state.consecutiveFailures = failures;
        this._state.nextAttemptAt = nextAttemptAt;
        this._state.pausedUntil = pausedUntil;
        this._state.lastError = errorText || null;
        this._state.lastErrorAt = ts;
        this._state.source = source;

        if (logMessage) this._noteTransition(source, pausedUntil || nextAttemptAt, logMessage);
        this._persist();
        return { state: this.getStatus(), retryAt: pausedUntil || nextAttemptAt || 0 };
    }

    /** @returns {{consecutiveFailures:number,nextAttemptAt:number,pausedUntil:number,lastError:string|null,lastErrorAt:number,source:string,updated_at:number}} */
    getStatus() {
        this._ensureLoaded();
        return Object.assign({}, this._state);
    }

    /** 测试用：清空内存状态并（可选）把状态文件指到临时路径。 */
    resetForTests(opts) {
        const o = opts || {};
        if (o.path) this._path = path.resolve(String(o.path));
        this._state = emptyState();
        this._loaded = true;             // 重置后不要再从旧文件回读
        this._lastBlockSignature = null;
        // 只清理「明确隔离」的状态文件：实例带 path、传了 path 或设了 PET_DATA_ROOT。
        // 生产侧误调 resetForTests() 不能把真实熔断记录删掉。
        if (o.path || this._path || process.env.PET_DATA_ROOT) {
            try {
                const f = this._filePath();
                if (f) { try { require('fs').unlinkSync(f); } catch (e) { /* 文件不存在是正常态 */ } }
            } catch (e) { /* 路径不可用也不影响内存重置 */ }
        }
        return this.getStatus();
    }
}

/** 新建一个独立实例（测试/多 profile 用；生产共享下面的单例）。 */
function createLlmHealth(opts) {
    return new LlmHealth(opts);
}

const llmHealth = new LlmHealth();

module.exports = {
    llmHealth,
    createLlmHealth,
    LlmHealth,
    FILE_NAME,
    BACKOFF_MINUTES,
    MAX_CONSECUTIVE_FAILURES,
    __test: { sanitize, findIsoTime, parseQuotaResetAt, parseRetryAfterMs, nextDayStop, localStamp, normalizeState },
};
