// js/core/local-llm.js —— 本地记忆模型（llama.cpp server + MemOperator-4B）的唯一入口
//
// 为什么单独一层（ADR-014 轨道 2 第 10 条）：
//   · 后台记忆任务（片段卡 / MemOS 抽取 / 画像 / 日记）改成走本机 llama.cpp，
//     不再消耗云端周配额；反思仍走云端。
//   · **本地不可用就跳过，绝不静默回退云端** —— 所以这里永远返回「本地连接」，
//     解析 provider 时也只接受回环地址，云端 provider 一概不认（见 resolve()）。
//   · 不写 LLM健康.json、不调云 llmHealth：本地挂了跟云端配额熔断是两码事，
//     混在一个状态文件里会互相误伤（本地 500 把云端熔断、云 429 把本地停掉）。
//
// 约定：
//   · probe()：GET {base}/health，1.5s 超时，结果缓存 10s；状态迁移只 log 一次
//   · chat()：OpenAI 兼容 /chat/completions；错误带 status / body 摘要（≤400 字）
//   · isAvailableSync()：只读缓存，不发网络（同步闸用）
//   · 所有网络失败都当成「本地不在」，由调用方决定跳过与退避

'use strict';

const PROVIDER_ID = 'local-memory';
const MODEL = 'MemOperator-4B';
const DEFAULT_BASE_URL = 'http://127.0.0.1:11435/v1';
const DEFAULT_API_KEY = 'local-no-key';
const LOCAL_PORT = 11435;
const PROBE_TIMEOUT_MS = 1500;
const CACHE_MS = 10000;
const DEFAULT_CHAT_TIMEOUT_MS = 120000;
const ERROR_BODY_MAX = 400;

// ── 采样档（配置，不是逻辑；2026-11-24 第四轮）──────────────────────────────
// 为什么放在这里而不是各个调用点：本地模型只有 4B，采样值一散落在调用方，
// 「片段卡 0.2 / 日记 0.8」这种口径就没人守得住。调用方只声明**用途**（profile），
// 具体数字在这张表里改；单个参数仍可被调用方显式覆盖（覆盖非法则回落到档位默认）。
//
//   extract（抽取：片段卡 / 画像 / MemOS /add 摘要）：要的是稳定、可解析、不发挥。
//           0.2 / 0.8 / 20 / min_p 0 是抽取类工程取值（Qwen3 官方非思考档是 0.7/0.8/20）。
//   diary  （日记：仅 config.diary.local_enabled=true 时）：要的是语气和起伏，
//           0.8 / 0.9 / 40 / min_p 0.05；再低就写成「今天发生了什么」的说明书。
const SAMPLING = {
    extract: { temperature: 0.2, top_p: 0.8, top_k: 20, min_p: 0 },
    diary: { temperature: 0.8, top_p: 0.9, top_k: 40, min_p: 0.05 },
};
const DEFAULT_PROFILE = 'extract';
// 合法区间：超出就当没传（回落档位默认），绝不把 NaN/负数送进服务端。
const SAMPLING_RANGES = {
    temperature: [0, 2],
    top_p: [0, 1],
    top_k: [0, 2048],
    min_p: [0, 1],
};

/** 值是否可用：有限数字 + 在区间内。(top_k 另取整) */
function _pickNumber(name, value, fallback) {
    const n = Number(value);
    const range = SAMPLING_RANGES[name];
    if (value == null || value === '' || !Number.isFinite(n)) return fallback;
    if (range && (n < range[0] || n > range[1])) return fallback;
    return name === 'top_k' ? Math.floor(n) : n;
}

/**
 * 取一个采样档。非法 profile 回落 extract（不抛错：采样是配置，不该让调用失败）。
 * @param {string} [profile] 'extract' | 'diary'
 * @param {object} [overrides] { temperature, top_p, top_k, min_p } —— 逐项覆盖，非法项回落
 * @returns {{temperature:number, top_p:number, top_k:number, min_p:number}}
 */
function samplingFor(profile, overrides) {
    const name = Object.prototype.hasOwnProperty.call(SAMPLING, String(profile)) ? String(profile) : DEFAULT_PROFILE;
    const base = SAMPLING[name];
    const o = overrides || {};
    return {
        temperature: _pickNumber('temperature', o.temperature, base.temperature),
        top_p: _pickNumber('top_p', o.top_p, base.top_p),
        top_k: _pickNumber('top_k', o.top_k, base.top_k),
        min_p: _pickNumber('min_p', o.min_p, base.min_p),
    };
}

// 账本（ADR-014）：本地调用也要有账 —— 否则「后台花了多少」只能看云端那半边。
// source='local' 不消耗云端周配额，doctor 的 80% 只算云；estimated 标记估算值。
let _emitTelemetry = null;
try { _emitTelemetry = require('./telemetry.js').emitTelemetry; } catch (e) { _emitTelemetry = null; }

/** 同口径 token 估算（与 context-budget/world-store 一致：CJK 1 字≈1 token，ASCII 4 字符≈1 token）。 */
function _estimateTokens(text) {
    try {
        const { estimateTokens } = require('./context-budget.js');
        return estimateTokens(text);
    } catch (e) {
        return 0;
    }
}

/**
 * 成功调用的用量落账（失败不落）。llama.cpp 的 /v1/chat/completions 会带 usage，
 * 没有时用「已发送 prompt + 已收正文」估算并打 estimated:1 —— 不编 cached 字段。
 */
function _noteUsage(usage, promptText, completionText) {
    if (!_emitTelemetry) return;
    try {
        const u = (usage && typeof usage === 'object') ? usage : {};
        const metrics = { msg_count: 1 };
        const realPrompt = Number(u.prompt_tokens);
        const realCompletion = Number(u.completion_tokens);
        if (Number.isFinite(realPrompt) && realPrompt > 0) {
            metrics.prompt_tokens = realPrompt;
        } else {
            const est = _estimateTokens(promptText);
            if (est > 0) { metrics.prompt_tokens = est; metrics.estimated = 1; }
        }
        if (Number.isFinite(realCompletion) && realCompletion > 0) {
            metrics.completion_tokens = realCompletion;
        } else {
            const est = _estimateTokens(completionText);
            if (est > 0) { metrics.completion_tokens = est; metrics.estimated = 1; }
        }
        if (Object.keys(metrics).length <= 1) return;   // 只有 msg_count = 没有可用账，不落空行
        _emitTelemetry({
            cat: 'llm',
            type: 'llm.usage',
            title: '本地模型用量',
            metrics,
            source: 'local',
        });
    } catch (e) { /* 账本失败不影响对话 */ }
}

/** 只认本机回环 + 本地记忆端口：防止「provider 解析降级」把请求偷偷发到云端。
 *
 *  P2-9（2026-11-25）：旧实现第二条是 `/:11435(\/|$)/` —— **任意 host** 只要端口是 11435
 *  就算「本地」（`https://evil.example:11435/v1` 也通过）。这个判定决定「本地任务能不能
 *  走这个 endpoint / 要不要算云端配额」，松了就等于把云端请求当本地记账。
 *  现在必须 host 是回环（127.0.0.1 / localhost / [::1]）**且**端口正好是 LOCAL_PORT。
 */
const _LOCAL_URL_RE = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?(?:\/|$)/i;
function isLocalUrl(url) {
    const s = String(url || '').trim();
    const m = s.match(_LOCAL_URL_RE);
    if (!m) return false;
    return Number(m[1]) === LOCAL_PORT;   // 缺省端口（80/443）不是本地记忆服务
}

/** 模块级缓存（daemon 常驻进程里只有一个真相；daemon 重启即重置）。 */
let _cache = { at: 0, ok: false, status: 0, reason: 'unknown', detail: '' };
let _logged = null;          // 'ok' | 'down' —— 只在状态迁移时写日志
let _logger = null;          // 可注入（单测静音）；默认走 console
let _resolveCache = null;    // { at, value }：provider 解析 10s 缓存
const RESOLVE_CACHE_MS = 10000;

function _log(level, msg) {
    if (typeof _logger === 'function') {
        try { _logger(level, msg); } catch (e) { /* 日志失败不影响判定 */ }
        return;
    }
    try {
        const line = '[本地记忆模型] ' + msg;
        if (level === 'warn') console.warn(line);
        else console.log(line);
    } catch (e) { /* 无 console 的环境（极端单测）忽略 */ }
}

/**
 * 解析本地 provider 连接信息。
 * 优先 llm-provider-manager 里的 local-memory；解析结果**必须是回环地址**，
 * 否则（manager 找不到 → 降级到云端默认 provider）一律回到内置默认值，
 * 绝不把本地任务发到云端。
 * @returns {{providerId:string, model:string, apiUrl:string, apiKey:string, source:'manager'|'default'}}
 */
function resolve() {
    const now = Date.now();
    if (_resolveCache && now - _resolveCache.at < RESOLVE_CACHE_MS) return _resolveCache.value;

    const fallback = {
        providerId: PROVIDER_ID,
        model: MODEL,
        apiUrl: DEFAULT_BASE_URL,
        apiKey: DEFAULT_API_KEY,
        source: 'default',
    };
    let value = fallback;
    try {
        const { llmProviderManager } = require('./llm-provider.js');
        if (llmProviderManager && typeof llmProviderManager.isInitialized === 'function'
            && llmProviderManager.isInitialized()) {
            const p = llmProviderManager.resolveProviderOrFallback(PROVIDER_ID, MODEL);
            // resolveProviderOrFallback 在找不到时会降级到默认（云端）provider。
            // 这里必须再确认「真的是本地」——否则本地任务会静默烧云端配额。
            if (p && p.api_url && isLocalUrl(p.api_url)) {
                value = {
                    providerId: PROVIDER_ID,
                    model: p.model || MODEL,
                    apiUrl: String(p.api_url).replace(/\/+$/, ''),
                    apiKey: p.api_key || DEFAULT_API_KEY,
                    source: 'manager',
                };
            }
        }
    } catch (e) {
        // provider 模块不可用（早期启动 / 单测）：用内置默认值
    }
    _resolveCache = { at: now, value };
    return value;
}

/** api_url → health 根路径（去掉 /v1 与尾部斜杠）。 */
function healthUrl(apiUrl) {
    return String(apiUrl || DEFAULT_BASE_URL)
        .replace(/\/+$/, '')
        .replace(/\/v1$/i, '') + '/health';
}

function _withTimeout(ms) {
    if (typeof AbortController !== 'function') return { signal: undefined, cleanup: () => {} };
    const ac = new AbortController();
    // 注意：这个 timer 不能 unref —— 它同时是「本次探活/请求」的唯一存活句柄，
    // unref 后在没有任何其他句柄的进程里（单测 / 极简脚本）Node 会直接退出，
    // 请求永远不结束。它寿命只有 ms，finally 里必清。
    const timer = setTimeout(() => { try { ac.abort(); } catch (e) { /* ignore */ } }, ms);
    return { signal: ac.signal, cleanup: () => clearTimeout(timer) };
}

/**
 * 探一次本地服务（GET /health），结果缓存 10s。
 * @param {number} [now] 注入时间便于单测
 * @param {number} [timeoutMs] 仅单测用；生产固定 1.5s
 * @returns {Promise<{ok:boolean, status:number, reason:string, detail:string, at:number}>}
 */
async function probe(now, timeoutMs) {
    const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const fresh = _cache.at > 0 && ts >= _cache.at && ts - _cache.at < CACHE_MS;
    if (fresh) return _cache;

    const conn = resolve();
    const url = healthUrl(conn.apiUrl);
    const ms = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Number(timeoutMs) : PROBE_TIMEOUT_MS;
    let result = { at: ts, ok: false, status: 0, reason: 'unreachable', detail: '' };

    if (typeof fetch !== 'function') {
        result = { at: ts, ok: false, status: 0, reason: 'no_fetch', detail: 'fetch 不可用' };
    } else {
        const t = _withTimeout(ms);
        try {
            const res = await fetch(url, { method: 'GET', signal: t.signal });
            const status = Number(res && res.status) || 0;
            if (res && res.ok) {
                // llama.cpp /health 返回 {"status":"ok"}；2xx 即认为活
                result = { at: ts, ok: true, status, reason: 'ok', detail: '' };
            } else {
                result = { at: ts, ok: false, status, reason: 'http_error', detail: 'HTTP ' + status };
            }
        } catch (e) {
            const aborted = e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
            result = {
                at: ts,
                ok: false,
                status: 0,
                reason: aborted ? 'timeout' : 'unreachable',
                detail: aborted ? ('health 超时 ' + ms + 'ms') : String((e && e.message) || e || '连接失败').slice(0, 160),
            };
        } finally {
            t.cleanup();
        }
    }

    _cache = result;
    // 状态迁移只喊一次（避免每 5 分钟一条 WARN；与 llm-health 的日志纪律一致）
    const state = result.ok ? 'ok' : 'down';
    if (_logged !== state) {
        _logged = state;
        if (result.ok) _log('info', '已连接 ' + conn.apiUrl + '（' + conn.model + '）');
        else _log('warn', '不可用（' + result.reason + (result.detail ? '：' + result.detail : '')
            + '）—— 后台记忆任务将跳过，不回退云端');
    }
    return result;
}

/** 异步闸：缓存期内直接用上次结果。 */
async function isAvailable(now) {
    const r = await probe(now);
    return !!(r && r.ok);
}

/** 同步闸：只读缓存，永不发网络（拿不到新鲜结果就当不可用）。 */
function isAvailableSync(now) {
    const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    if (!(_cache.at > 0 && ts >= _cache.at && ts - _cache.at < CACHE_MS)) return false;
    return !!_cache.ok;
}

/**
 * 调一次本地 chat（OpenAI 兼容）。
 * @param {string} prompt
 * @param {object} [opts] { profile:'extract'|'diary', temperature, top_p, top_k, min_p,
 *                          max_tokens, response_format, timeoutMs, probe }
 * @returns {Promise<string>} 纯文本回复
 */
async function chat(prompt, opts) {
    const o = opts || {};
    const conn = resolve();
    const text = String(prompt == null ? '' : prompt);
    if (!text.trim()) throw Object.assign(new Error('local LLM: empty prompt'), { code: 'LOCAL_LLM_EMPTY' });

    // 可选先探活：默认不探（调用方已有闸，且拒绝连接本来就是毫秒级失败）
    if (o.probe === true) {
        const okNow = await isAvailable();
        if (!okNow) {
            throw Object.assign(new Error('local LLM unavailable'), {
                code: 'LOCAL_LLM_DOWN', status: 0, body: '',
            });
        }
    }

    if (typeof fetch !== 'function') {
        throw Object.assign(new Error('local LLM: fetch unavailable'), { code: 'LOCAL_LLM_NO_FETCH' });
    }

    const body = {
        model: conn.model,
        messages: [{ role: 'user', content: text }],
        stream: false,
    };
    // 采样：默认走抽取档（0.2/0.8/20/0）；日记调用方声明 profile:'diary'。
    // 显式传的单个值优先（合法才生效），不再在调用方散落硬编码。
    const sampling = samplingFor(o.profile, {
        temperature: o.temperature, top_p: o.top_p, top_k: o.top_k, min_p: o.min_p,
    });
    body.temperature = sampling.temperature;
    body.top_p = sampling.top_p;
    body.top_k = sampling.top_k;
    body.min_p = sampling.min_p;
    if (Number.isFinite(Number(o.max_tokens)) && Number(o.max_tokens) > 0) body.max_tokens = Math.floor(Number(o.max_tokens));
    if (o.response_format && typeof o.response_format === 'object') body.response_format = o.response_format;

    const timeoutMs = Number.isFinite(Number(o.timeoutMs)) && Number(o.timeoutMs) > 0
        ? Number(o.timeoutMs) : DEFAULT_CHAT_TIMEOUT_MS;
    const t = _withTimeout(timeoutMs);
    const endpoint = conn.apiUrl.replace(/\/+$/, '') + '/chat/completions';

    let res;
    try {
        res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // llama.cpp 不校验 key，但保留 OpenAI 形状便于将来换后端
                'Authorization': 'Bearer ' + (conn.apiKey || DEFAULT_API_KEY),
            },
            body: JSON.stringify(body),
            signal: t.signal,
        });
    } catch (e) {
        t.cleanup();
        const aborted = e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
        const err = new Error(aborted
            ? 'local LLM 超时（' + timeoutMs + 'ms）'
            : 'local LLM 连接失败: ' + String((e && e.message) || e || 'unknown').slice(0, 160));
        err.code = aborted ? 'LOCAL_LLM_TIMEOUT' : 'LOCAL_LLM_UNREACHABLE';
        err.status = 0;
        err.body = '';
        throw err;
    }

    try {
        if (!res || !res.ok) {
            let raw = '';
            try {
                const txt = await res.text();
                raw = String(txt == null ? '' : txt).slice(0, ERROR_BODY_MAX);
            } catch (e) { raw = ''; }
            const flat = raw.replace(/\s+/g, ' ').trim();
            const status = Number(res && res.status) || 0;
            const err = new Error('local LLM HTTP ' + status + (flat ? ' — ' + flat.slice(0, 200) : ''));
            err.code = 'LOCAL_LLM_HTTP';
            err.status = status;
            err.body = raw;
            throw err;
        }

        let data;
        try { data = await res.json(); }
        catch (e) {
            const err = new Error('local LLM 响应不是合法 JSON');
            err.code = 'LOCAL_LLM_BAD_JSON';
            err.status = Number(res && res.status) || 0;
            err.body = '';
            throw err;
        }
        const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
        const content = choice && choice.message ? choice.message.content : null;
        if (typeof content !== 'string') {
            const err = new Error('local LLM 响应缺少 choices[0].message.content');
            err.code = 'LOCAL_LLM_EMPTY_CHOICE';
            err.status = Number(res && res.status) || 0;
            err.body = '';
            throw err;
        }
        _noteUsage(data && data.usage, text, content);
        return content;
    } finally {
        t.cleanup();
    }
}

/** 体检/调试用快照（同步，不发网络）。 */
function getStatus(now) {
    const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const conn = resolve();
    const age = _cache.at > 0 ? Math.max(0, ts - _cache.at) : null;
    return {
        providerId: conn.providerId,
        model: conn.model,
        baseUrl: conn.apiUrl,
        source: conn.source,
        ok: !!(_cache.at > 0 && age != null && age < CACHE_MS && _cache.ok),
        lastOk: !!_cache.ok,
        checkedAt: _cache.at || 0,
        ageMs: age,
        cacheTtlMs: CACHE_MS,
        lastStatus: _cache.status || 0,
        reason: _cache.reason || 'unknown',
        detail: _cache.detail || '',
    };
}

module.exports = {
    PROVIDER_ID,
    MODEL,
    DEFAULT_BASE_URL,
    DEFAULT_API_KEY,
    LOCAL_PORT,
    CACHE_MS,
    SAMPLING,
    DEFAULT_PROFILE,
    samplingFor,
    resolve,
    probe,
    isAvailable,
    isAvailableSync,
    chat,
    getStatus,
    isLocalUrl,
    // 单测后门（生产代码不要用）：清缓存 / 注入 logger
    __test: {
        reset() {
            _cache = { at: 0, ok: false, status: 0, reason: 'unknown', detail: '' };
            _logged = null;
            _resolveCache = null;
        },
        setLogger(fn) { _logger = typeof fn === 'function' ? fn : null; },
        cache() { return Object.assign({}, _cache); },
    },
};
