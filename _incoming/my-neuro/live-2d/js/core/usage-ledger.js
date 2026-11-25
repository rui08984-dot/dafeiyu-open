'use strict';
// usage-ledger.js —— 用量/缓存账本的**纯函数**部分（ADR-014 轨道 1，2026-11-24）
//
// 为什么单独抽一个文件：
//   · 前缀基线（measureWithBaseline）需要「消息指纹」，llm-client 记录、context-budget 比对，
//     两边必须用**同一个**指纹算法 —— 放这里只有一份实现；
//   · doctor 是 ESM，要算今日/近 7 天的 prompt/completion、加权缓存、p50/p90。
//     聚合逻辑放这里（纯函数，输入 telemetry 行），doctor 只负责读文件 + 打印，
//     测试也能离线喂行，不碰真实 .runtime。
//
// 纪律：
//   · 不写盘、不读盘、不引其它业务模块（只有纯计算），任何一方 require 都不会成环；
//   · 指纹必须**忽略图片 URL**（data URI 每次截图都不同，且宿主发请求前会把历史图清掉），
//     否则「带过截图的一轮」之后基线永远对不上；
//   · 指纹对 user 消息还要**剥掉易变块**（从 VOLATILE_HEADER 起到末尾）：它是每次请求
//     重写的尾巴，算进 hash 就会让工具轮里的中间 user 每请求都「变」→ 基线永远回退估算。
//     常量必须与 prompt-layout.VOLATILE_HEADER 同步（有单测钉住）；
//   · 聚合只认 llm.usage（llm-client 每次请求落一条）；老数据没这条就显示未验证，不猜。

/** 32 位 FNV-1a。与 prompt-layout.hashText 同算法，但这里只内部用，不跨文件比。 */
function hashText(text, max) {
    const s = String(text == null ? '' : text);
    const n = Math.min(s.length, max || 40000);
    let h = 0x811c9dc5;
    for (let i = 0; i < n; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8) + ':' + s.length;
}

// 必须与 `js/core/prompt-layout.js` 的 VOLATILE_HEADER **同一个串**（那边改了这里必须跟改，
// 否则「易变块剥离」会失效 → 前缀基线在工具轮里永远对不上）。单测钉住一致性。
const VOLATILE_HEADER = '（系统补充，不必回应）';

/**
 * 去掉 user 消息末尾的易变块（从 VOLATILE_HEADER 起到消息末尾）。
 *
 * 为什么指纹要剥它（P1-2，2026-11-24 对抗审查）：
 *   llm-client 记指纹时拿到的是**请求体**（易变块已拼在最后一条 user 末尾），
 *   而 measureWithBaseline 比对的是**宿主** voiceChat.messages（没有易变块）。
 *   易变块本来就是「每次重写的尾巴」，把它算进指纹就等于宣告这条消息每请求都变 ——
 *   工具轮里它落在中间，`allowTail` 只放行最后一条 → 真账基线永远回退估算。
 *   剥掉后跨请求 hash 稳定，与前缀缓存语义一致（缓存断点也确实在易变块之前）。
 */
function stripVolatile(text) {
    const s = String(text == null ? '' : text);
    const i = s.indexOf(VOLATILE_HEADER);
    // 易变块本身以 '\n\n' 开头（prompt-layout.buildVolatileBlock）——截断后必须去掉
    // 可能残留的尾部空白，否则请求侧「问B\n\n」与宿主侧「问B」hash 不等。
    return i === -1 ? s : s.slice(0, i).replace(/\s+$/, '');
}

/**
 * 单条消息指纹。role + 正文 + tool_calls + tool_call_id。
 * 图片 part **只记类型不记 URL**（见文件头纪律）。
 * user 消息先剥易变块（见 stripVolatile）。
 */
function fingerprint(msg) {
    if (!msg || typeof msg !== 'object') return 'x';
    const role = String(msg.role || '');
    const isUser = role === 'user';
    const content = msg.content;
    let body = '';
    if (typeof content === 'string') body = isUser ? stripVolatile(content) : content;
    else if (Array.isArray(content)) {
        const parts = [];
        for (const p of content) {
            if (!p || typeof p !== 'object') { parts.push(''); continue; }
            if (p.type === 'text') {
                let t = String(p.text || '');
                if (isUser) {
                    t = stripVolatile(t);
                    // 整段都是易变块 → 这个 part 在宿主侧不存在，丢掉才能两侧对齐
                    if (!t) continue;
                }
                parts.push('text:' + t);
            } else if (p.type === 'image_url' || p.image_url) {
                parts.push('image_url');
            } else {
                parts.push(String(p.type || '') + ':' + (typeof p.text === 'string' ? p.text : ''));
            }
        }
        body = parts.join('\u0002');
    } else if (content != null) {
        try { body = JSON.stringify(content); } catch (e) { body = String(content); }
    }
    let s = role + '\u0001' + body;
    if (msg.tool_calls) {
        try { s += '\u0003' + JSON.stringify(msg.tool_calls); } catch (e) { s += '\u0003?'; }
    }
    if (msg.tool_call_id) s += '\u0004' + String(msg.tool_call_id);
    return hashText(s);
}

/** 整段消息的指纹数组（发给上游的原始消息顺序）。 */
function fingerprints(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map((m) => fingerprint(m));
}

/** 工具面指纹：顺序敏感（排序稳定后它就是稳定的）+ 体积。 */
function toolHash(tools) {
    if (!Array.isArray(tools) || !tools.length) return '0:0';
    try {
        const json = JSON.stringify(tools);
        return hashText(json, 200000);
    } catch (e) {
        return 'err:' + tools.length;
    }
}

// ── lastUsage 共享槽：llm-client 写，context-budget / 压缩插件读 ─────────────
// 放 globalThis 而不是模块变量：测试可以直接清掉（隔离），热重载也不会丢。
const GLOBAL_KEY = '__llmLastUsage';
const BY_LABEL_KEY = '__llmUsageByLabel';

function setLastUsage(rec) {
    if (!rec || typeof rec !== 'object') return null;
    const copy = { ...rec };
    try {
        globalThis[GLOBAL_KEY] = copy;
        const by = globalThis[BY_LABEL_KEY] || (globalThis[BY_LABEL_KEY] = {});
        by[String(copy.label || 'main')] = copy;
    } catch (e) { /* 全局写入失败不影响请求 */ }
    return copy;
}

function getLastUsage(label) {
    try {
        if (label) {
            const by = globalThis[BY_LABEL_KEY];
            return (by && by[String(label)]) || null;
        }
        return globalThis[GLOBAL_KEY] || null;
    } catch (e) { return null; }
}

function clearLastUsage() {
    try {
        delete globalThis[GLOBAL_KEY];
        delete globalThis[BY_LABEL_KEY];
    } catch (e) { /* ignore */ }
}

// ── 聚合（doctor 用，纯函数）────────────────────────────────────────────────
function num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function pct(arr, p) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1))];
}

/**
 * 汇总 llm.usage 行。
 * @param {Array} rows telemetry 行（可含其它类型，会自己过滤）
 * @param {{now?:number, weekMs?:number}} [opts]
 * @returns {{
 *   n:number, today:object, week:object,
 *   weightedCachePct:number|null, p50:number|null, p90:number|null,
 *   zeros:number, withCacheField:number, byLabel:Object<string,number>
 * }}
 */
function aggregateUsage(rows, opts) {
    const o = opts || {};
    const now = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now();
    const weekMs = Number.isFinite(Number(o.weekMs)) && Number(o.weekMs) > 0 ? Number(o.weekMs) : 7 * 24 * 3600 * 1000;
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = now - weekMs;

    const blank = () => ({
        requests: 0, prompt: 0, completion: 0, reasoning: 0,
        cachePrompt: 0, cached: 0, miss: 0, withCacheField: 0, zeros: 0,
    });
    const today = blank();
    const week = blank();
    // 2026-11-24：云/本地分开记。本地（llama.cpp:11435）不消耗云端周配额，
    // 80% 告警必须只算云；插件/视觉的云调用也不能漏。
    const todayCloud = blank();
    const todayLocal = blank();
    const weekCloud = blank();
    const weekLocal = blank();
    const promptSeries = [];
    const cloudPromptSeries = [];
    const byLabel = {};
    let n = 0;

    for (const r of (Array.isArray(rows) ? rows : [])) {
        if (!r || r.cat !== 'llm' || r.type !== 'llm.usage' || !r.metrics) continue;
        const ts = num(r.ts);
        if (ts == null) continue;
        const m = r.metrics;
        const p = num(m.prompt_tokens);
        const comp = num(m.completion_tokens);
        const rea = num(m.reasoning_tokens);
        const cached = num(m.cached_tokens);
        const miss = num(m.prompt_cache_miss_tokens);
        const has = num(m.has_cache_field) === 1;
        const hitRate = num(m.hit_rate);
        const isLocal = String(r.source || '').toLowerCase() === 'local';
        n += 1;

        const add = (t) => {
            t.requests += 1;
            if (p != null) t.prompt += p;
            if (comp != null) t.completion += comp;
            if (rea != null) t.reasoning += rea;
            if (has) {
                t.withCacheField += 1;
                if (p != null) t.cachePrompt += p;
                if (cached != null) t.cached += cached;
                if (miss != null) t.miss += miss;
                if (hitRate === 0) t.zeros += 1;
            }
        };
        if (ts >= todayStart.getTime()) {
            add(today);
            add(isLocal ? todayLocal : todayCloud);
        }
        if (ts >= weekStart) {
            add(week);
            add(isLocal ? weekLocal : weekCloud);
            if (p != null && p > 0) promptSeries.push(p);
            if (p != null && p > 0 && !isLocal) cloudPromptSeries.push(p);
            const lb = String(r.source || m.label || 'main');
            byLabel[lb] = (byLabel[lb] || 0) + 1;
        }
    }

    return {
        n,
        today,
        week,
        todayCloud,
        todayLocal,
        weekCloud,
        weekLocal,
        // 加权命中率分母只用「带 cached 字段」的样本（与 doctor 既有口径一致）
        weightedCachePct: week.cachePrompt > 0 ? Math.round((week.cached / week.cachePrompt) * 1000) / 10 : null,
        weightedCachePctCloud: weekCloud.cachePrompt > 0 ? Math.round((weekCloud.cached / weekCloud.cachePrompt) * 1000) / 10 : null,
        p50: pct(promptSeries, 50),
        p90: pct(promptSeries, 90),
        p50Cloud: pct(cloudPromptSeries, 50),
        p90Cloud: pct(cloudPromptSeries, 90),
        zeros: week.zeros,
        withCacheField: week.withCacheField,
        byLabel,
    };
}

/**
 * 周预算判级（doctor 用）。**只告警不拦截**（用户拍板）：
 *   · budget 未设（null/0）→ { level: 'stats', pct: null }「仅统计」；
 *   · 用量 ≥80% → 'warn'；否则 'ok'。
 * 放在纯函数里，测试不启宿主也能验 80% 边界，doctor 只负责打印。
 */
function budgetStatus(weekTokens, budget) {
    const b = Number(budget);
    const used = Number(weekTokens) || 0;
    if (!Number.isFinite(b) || b <= 0) return { level: 'stats', pct: null };
    const pct = Math.round((used / b) * 1000) / 10;
    return { level: pct >= 80 ? 'warn' : 'ok', pct };
}

/** 从根配置读周预算（0/缺省=只统计）。doctor 调它，能力覆盖测试也能看到消费者。 */
function weeklyBudgetOf(cfg) {
    const n = Number(cfg && cfg.cost && cfg.cost.weekly_token_budget);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

module.exports = {
    VOLATILE_HEADER,
    hashText,
    stripVolatile,
    fingerprint,
    fingerprints,
    toolHash,
    setLastUsage,
    getLastUsage,
    clearLastUsage,
    aggregateUsage,
    budgetStatus,
    weeklyBudgetOf,
};
