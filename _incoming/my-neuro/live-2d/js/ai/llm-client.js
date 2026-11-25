// llm-client.js - 统一的LLM API客户端
const { logToTerminal, handleAPIError, noteLlmNetworkFailure } = require('../api-utils.js');
const { sanitizeToolMessageSequence } = require('./tool-message-utils.js');
const { applyReasoningToRequestBody } = require('./reasoning-request.js');
const promptLayout = require('../core/prompt-layout.js');
// ADR-014 轨道 1：provider 真实 usage 基线 + 成本账本。
// usage-ledger 是纯函数（指纹/全局槽/聚合），context-budget 只用来做「发送时的分项估算」。
const usageLedger = require('../core/usage-ledger.js');
let _contextBudget = null;
try { _contextBudget = require('../core/context-budget.js'); } catch (e) { _contextBudget = null; }

// 2026-11-24：命中率不再只写日志 —— 落一条 telemetry，doctor 才能算加权命中率、
// 发现「重启后 0%」「28% 请求 0%」这类回归。失败绝不影响请求。
let _emitTelemetry = null;
try { _emitTelemetry = require('../core/telemetry.js').emitTelemetry; } catch (e) { _emitTelemetry = null; }
// 轮次归因：llm.usage 带上当前 turn_id，doctor/验收才能把「一轮里的 4.7 次请求」join 起来。
// 拿不到（单测/无活动轮）就留空 —— telemetry 与 doctor 都已兼容缺失。
let _turnCtx = null;
try { _turnCtx = require('../core/turn-context.js'); } catch (e) { _turnCtx = null; }
function _currentTurnId() {
    try {
        return _turnCtx && typeof _turnCtx.currentTurnId === 'function' ? String(_turnCtx.currentTurnId() || '') : '';
    } catch (e) { return ''; }
}
function noteLLMSuccess() {
    try { require('../core/llm-health.js').llmHealth.noteSuccess(); } catch (e) { /* 健康模块不可用不影响请求 */ }
}

/** 用户是否已打断（P2-12）：重试前必须看它，否则「她停不下来」。取不到就当作没打断。 */
function _isInterrupted() {
    try {
        const { appState } = require('../core/app-state.js');
        return !!(appState && typeof appState.isInterrupted === 'function' && appState.isInterrupted());
    } catch (e) { return false; }
}

/** prompt 侧估算：发送前 context-budget 已分项量过（estimated.total），直接复用同一份口径。 */
function estimatePromptTokens(ctx) {
    const est = ctx && ctx.estimated && typeof ctx.estimated === 'object' ? ctx.estimated : null;
    const n = est ? Number(est.total) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * 可重试的 HTTP 状态（P2，2026-11-24 对抗审查）。
 *   · 5xx：网关/上游临时故障；
 *   · 408 Request Timeout / 425 Too Early / 409 Conflict：同样是「这一发不巧」，
 *     换一次请求通常就过（请求体没变，重发不会重复副作用：响应还没开始流）；
 *   · 429 与其它 4xx 不在此列（429 交 llm-health 熔断；其它 4xx 重发结果一样）。
 */
function _isRetryableHttpStatus(status) {
    return status >= 500 || status === 408 || status === 425 || status === 409;
}

/** 正文侧估算：与 context-budget / world-store 同口径（CJK 1 字≈1 token，ASCII 4 字符≈1 token）。 */
function estimateCharTokens(text) {
    const s = String(text == null ? '' : text);
    if (!s) return null;
    try {
        if (_contextBudget && typeof _contextBudget.estimateTokens === 'function') {
            const n = _contextBudget.estimateTokens(s);
            return Number.isFinite(n) && n > 0 ? n : null;
        }
    } catch (e) { /* 估算失败就不写 */ }
    return null;
}

/** 从一条完整响应里取「可估算的正文」（content + 工具调用参数）。 */
function completionTextOf(data) {
    try {
        const msg = data && Array.isArray(data.choices) && data.choices[0] ? data.choices[0].message : null;
        if (!msg) return '';
        let s = typeof msg.content === 'string' ? msg.content : '';
        if (msg.tool_calls) { s += JSON.stringify(msg.tool_calls); }
        return s;
    } catch (e) { return ''; }
}

// ── 前缀缓存命中率：从「不可观测」变成「一行日志 + 一个可查询的全局」──────────
// 用户要的是「命中缓存 ≥99.8%」，但改造前客户端从不读 usage 里的 cached 字段，
// 所以这个数字一直是猜的。这里做两件事：
//   ① 流式请求显式开 stream_options.include_usage（OpenAI 兼容端点默认流式不带 usage）；
//   ② 每次调用把 prompt/cached 记进 globalThis.__cacheStats（保留最近 50 次），
//      并在有 cached 字段时打一行日志。字段不存在时**报"无此字段"而不是当 0**。
function recordUsage(usage, label, ctx) {
    // 能拿到 usage = 这次请求成功（哪怕上游没给 cached 字段）→ 配额/健康状态可以清零。
    // ⚠ incomplete/失败请求必须传 skipHealth：别把「失败」当成功清熔断（2026-11-25）。
    if (!(ctx && ctx.skipHealth)) noteLLMSuccess();
    const r = promptLayout.cacheRate(usage);
    const c = ctx || {};
    const u = (usage && typeof usage === 'object') ? usage : {};

    // ── ADR-014 轨道 1：lastUsage 真账（基线 + 账本共用一条）──────────────────
    // 记录的是**发送时的原始消息**（不是 _cleanMessagesForAPI 之后的），
    // 这样压缩/裁剪拿 voiceChat.messages 比对时前缀能对上。
    const completion = Number.isFinite(Number(u.completion_tokens)) ? Number(u.completion_tokens) : null;
    const reasoningRaw = (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) ?? u.reasoning_tokens;
    const reasoning = Number.isFinite(Number(reasoningRaw)) ? Number(reasoningRaw) : null;
    const rec = {
        prompt_tokens: r.prompt,
        cached_tokens: r.cached,
        prompt_cache_hit_tokens: r.cached,
        prompt_cache_miss_tokens: r.miss,
        completion_tokens: completion,
        reasoning_tokens: reasoning,
        msgCount: Number.isFinite(Number(c.msgCount)) ? Number(c.msgCount) : 0,
        msgHashes: Array.isArray(c.msgHashes) ? c.msgHashes : null,
        toolHash: c.toolHash || null,
        estimated: c.estimated || null,
        transport: c.transport || null,
        at: Date.now(),
        label: String(label || 'main'),
    };

    // ── 没有 usage 的请求也要有账（2026-11-24 审计 §8.3 补丁）─────────────────
    // 严格端点 400 掉 stream_options 之后，整次流式请求拿不到 usage（openai 兼容流默认不带）。
    // 这时账本里既没有 prompt 也没有 completion —— doctor 看不出「这次花了多少」，
    // 只看到请求数对不上。用「发送前的分项估算 + 已收字符估算」补一条 estimated，
    // 但 **lastUsage 的 prompt/cached 仍保持 null**：那是 provider 真账基线，
    // 估算值混进去会让压缩/裁剪把估算当真账（见 context-budget.measureWithBaseline）。
    if (r.prompt == null) {
        const promptEst = estimatePromptTokens(c);
        const completionEst = estimateCharTokens(c.completionText);
        if (promptEst != null || completionEst != null) {
            rec.estimated_tokens = { prompt: promptEst, completion: completionEst };
        }
    }

    // incomplete 行不是可用基线（prompt 缺失）：别覆盖上一发有效真账
    if (!(c && c.skipLastUsage)) usageLedger.setLastUsage(rec);
    // ── 既有：__cacheStats + 一行日志（WebUI/老 doctor 还在读）──────────────────
    if (r.prompt == null) return rec;
    const s = globalThis.__cacheStats || (globalThis.__cacheStats = {
        calls: 0, withCacheField: 0, sumPrompt: 0, sumCached: 0, series: [], lastRate: null,
    });
    s.calls += 1;
    s.sumPrompt += r.prompt;
    if (r.cached != null) {
        s.withCacheField += 1;
        s.sumCached += r.cached;
        s.lastRate = r.rate;
        s.series.push({ at: Date.now(), prompt: r.prompt, cached: r.cached, rate: r.rate, label });
        if (s.series.length > 50) s.series.shift();
        logToTerminal('info', `💾 前缀缓存 ${r.rate}%（cached ${r.cached} / prompt ${r.prompt}，${label}）`);
    } else if (s.withCacheField === 0 && !s._warnedNoField) {
        s._warnedNoField = true;
        logToTerminal('warn', `💾 上游 usage 没有 cached 字段（只有 ${r.fields.join(', ') || '空'}），命中率不可测`);
    }
    // doctor 口径：只认有 cached 字段的样本；weighted = sum(cached)/sum(prompt)。
    try {
        if (_emitTelemetry) {
            _emitTelemetry({
                cat: 'llm',
                type: 'llm.cache',
                title: '前缀缓存',
                metrics: {
                    prompt_tokens: r.prompt,
                    cached_tokens: r.cached == null ? 0 : r.cached,
                    hit_rate: r.rate == null ? 0 : r.rate,
                    has_cache_field: r.cached == null ? 0 : 1,
                },
                source: String(label || 'main'),
                label: String(label || ''),
            });
        }
    } catch (e) { /* 遥测失败不影响请求 */ }
    return rec;
}

/** 用量账本：每次请求一条（上游没给 prompt 也记 completion；不可观测的字段直接不写）。
 *  与 llm.cache 并存 —— 老检查/图表继续用它，新账本用 llm.usage 做今日/7 天汇总。 */
function emitUsageTelemetry(rec) {
    if (!rec || !_emitTelemetry) return;
    const m = {};
    const put = (k, v) => { if (v != null && Number.isFinite(Number(v))) m[k] = Number(v); };
    put('prompt_tokens', rec.prompt_tokens);
    put('cached_tokens', rec.cached_tokens);
    put('prompt_cache_miss_tokens', rec.prompt_cache_miss_tokens);
    put('completion_tokens', rec.completion_tokens);
    put('reasoning_tokens', rec.reasoning_tokens);
    put('msg_count', rec.msgCount);
    put('has_cache_field', rec.cached_tokens == null ? 0 : 1);
    // P2-12b（2026-11-25）：已经吐字/已经发出、但没收到 usage 的失败请求，标 incomplete。
    // doctor 的「每轮有没有账」靠 llm.usage∩turn_id；这种轮如果不记账，会被判成
    // 「有轮次没记账」假红。补一条估算账比「让 doctor 排除整轮」更诚实 ——
    // 请求确实发了、token 确实烧了，只是上游没回 usage。预算口径（非 estimated 真账）
    // 本来就把估算行排除在外，不会把周配额提前打满。
    if (rec.incomplete) m.incomplete = 1;
    if (rec.incomplete) m.estimated = 1;
    if (rec.cached_tokens != null && rec.prompt_tokens > 0) {
        m.hit_rate = +((rec.cached_tokens / rec.prompt_tokens) * 100).toFixed(1);
    }
    // 估算兜底：上游这次没给 usage（流式端点不认 stream_options 是最常见的路径）。
    // 真实字段优先；缺的用 estimated 补，并打 estimated:1 —— doctor 汇总时要把它们单独标出，
    // 不能和 provider 真账混成一个数。cached 永远不估算（has_cache_field 保持 0，命中率不掺假）。
    const est = rec.estimated_tokens && typeof rec.estimated_tokens === 'object' ? rec.estimated_tokens : null;
    if (est) {
        if (m.prompt_tokens == null && Number.isFinite(Number(est.prompt)) && Number(est.prompt) > 0) {
            m.prompt_tokens = Math.round(Number(est.prompt));
            m.estimated = 1;
        }
        if (m.completion_tokens == null && Number.isFinite(Number(est.completion)) && Number(est.completion) > 0) {
            m.completion_tokens = Math.round(Number(est.completion));
            m.estimated = 1;
        }
    }
    if (!Object.keys(m).length) return;
    try {
        const ev = {
            cat: 'llm',
            type: 'llm.usage',
            title: '用量',
            metrics: m,
            // telemetry 的 metrics 只保留数字，label 走 source（doctor 的 byLabel 读它）
            source: rec.label || 'main',
        };
        const turnId = _currentTurnId();
        if (turnId) ev.turn_id = turnId;
        _emitTelemetry(ev);
    } catch (e) { /* 失败不影响请求 */ }
}


/**
 * 统一的LLM客户端
 * 封装所有LLM API调用逻辑,消除重复代码
 */
class LLMClient {
    /**
     * 支持两种入参：
     *   1. new LLMClient(config)                     - 旧方式，读取 config.llm
     *   2. LLMClient.fromProviderConfig(resolved, r) - 新方式，传入 provider 解析结果（平铺对象）
     */
    constructor(config) {
        // 兼容：完整 config（取 config.llm）或已解析的 provider 平铺对象（直接取字段）
        const llmConfig = (config && config.llm) ? config.llm : (config || {});
        this.apiKey = llmConfig.api_key;
        this.apiUrl = llmConfig.api_url;
        this.model = llmConfig.model;
        this.temperature = llmConfig.temperature || 1.0;
        this.temperatureEnabled = llmConfig.temperature_enabled ?? false;
        this.topP = Number.isFinite(Number(llmConfig.top_p)) ? Number(llmConfig.top_p) : null;
        this.maxTokens = Number.isFinite(Number(llmConfig.max_tokens)) ? Number(llmConfig.max_tokens) : null;
        // 思考模式默认关闭：只有显式 reasoning_enabled === true 才开启
        this.reasoningEnabled = llmConfig.reasoning_enabled === true;
        this.reasoningEffort = llmConfig.reasoning_effort || null;
        // 用量账本的归属标签（main/vision/plugin）。调用方可以显式给；
        // 没给时按「这条消息里有没有图」推 vision，其余按 main。
        this.label = llmConfig.llm_label || llmConfig.label || null;
        // ADR-014：最近一次成功响应的真实用量（实例级；全局槽另有 getLastUsage）
        this.lastUsage = null;
        // 2026-11-24 审计 §8.5：「config.llm.retry 存了不读」—— fromProviderConfig 把它塞进
        // merged.retry 后就再没人看一眼，等于死配置。这里接上最小可用语义：
        //   · max_attempts（默认 2 = 首发 + 1 次重试），上限 5，防止把 429/宕机放大成请求风暴；
        //   · base_delay_ms（默认 300，指数退避 300/600/1200…）。
        // 只重试「网络错误 / 5xx / 超时」；429 交给 llm-health 熔断（重试只是再打受限请求）；
        // 流式只在首 token 之前失败才重试（已经吐过字再重试会把同一段话说两遍）。
        this.retryConfig = (llmConfig.retry && typeof llmConfig.retry === 'object') ? llmConfig.retry : {};
    }

    /**
     * 从 provider 解析结果创建客户端。
     * @param {object} resolved - llmProviderManager.resolveProvider 系列方法的返回值
     * @param {object} [retryConfig] - 全局重试配置（config.llm.retry）
     * @param {string} [label] - 用量标签（main/vision/plugin），不传则按请求内容推断
     * @returns {LLMClient}
     */
    static fromProviderConfig(resolved, retryConfig, label) {
        const merged = { ...resolved, retry: retryConfig || resolved.retry || {} };
        if (label) merged.llm_label = label;
        return new LLMClient(merged);
    }

    /** 标签：显式 > 含图片→vision > main。plugin 路径由调用方显式传。
     *
     *  P1-3（2026-11-24 对抗审查）：显式 label 永远优先 —— 主链的历史里只要有一张旧截图，
     *  旧逻辑就把整个请求记成 vision，导致 lastUsage.main 不更新、压缩/裁剪的真账基线
     *  拿不到最新的 prompt_tokens。image 推断只在调用方**完全没指定** label 时兜底
     *  （独立视觉客户端/插件裸调这类没有实例 label 的场景）。
     */
    _resolveLabel(messages) {
        if (this.label) return this.label;
        try {
            const hasImage = Array.isArray(messages) && messages.some((m) => Array.isArray(m && m.content)
                && m.content.some((p) => p && (p.type === 'image_url' || p.image_url)));
            return hasImage ? 'vision' : 'main';
        } catch (e) { return 'main'; }
    }

    /**
     * 请求发送前的基线上下文：消息条数/逐条指纹/工具指纹/分项估算。
     * 指纹与 context-budget.measureWithBaseline 共用 usage-ledger 的实现。
     */
    _buildUsageContext(messages, tools) {
        const msgs = Array.isArray(messages) ? messages : [];
        const toolList = Array.isArray(tools) ? tools : [];
        let estimated = null;
        try {
            if (_contextBudget) {
                const m = _contextBudget.measure({ messages: msgs, tools: toolList });
                estimated = { total: m.total, system: m.system, tools: m.tools, history: m.history, volatile: m.volatile };
            }
        } catch (e) { estimated = null; }
        let msgHashes = null;
        let toolHash = null;
        try {
            msgHashes = usageLedger.fingerprints(msgs);
            toolHash = usageLedger.toolHash(toolList);
        } catch (e) { msgHashes = null; toolHash = null; }
        return {
            msgCount: msgs.length,
            msgHashes,
            toolHash,
            estimated,
        };
    }

    /**
     * 发送聊天完成请求
     * @param {Array} messages - 消息数组
     * @param {Array} tools - 可选的工具列表
     * @param {boolean} stream - 是否使用流式响应
     * @param {Function} onChunk - 流式响应时的回调函数，接收每个文本块
     * @returns {Promise<Object>} API响应的消息对象
     */
    async chatCompletion(messages, tools = null, stream = false, onChunk = null) {
        // 🔥 清理消息格式,确保API兼容性
        const cleanedMessages = this._cleanMessagesForAPI(messages);
        // ADR-014：基线要按**发送前的原始消息**记指纹（压缩/裁剪比对的是 voiceChat.messages）
        const usageCtx = this._buildUsageContext(messages, tools);
        const usageLabel = this._resolveLabel(messages);

        const requestBody = {
            model: this.model,
            messages: cleanedMessages,
            stream: stream
        };
        // 流式默认不带 usage；显式要求上游在最后一个 chunk 里带上（含 cached_tokens）。
        // 老端点可能不认这个字段 → 下面的请求在 400 时会自动去掉重试一次。
        if (stream) requestBody.stream_options = { include_usage: true };
        if (this.temperatureEnabled) {
            requestBody.temperature = this.temperature;
        }
        // 人格型角色需要一点发散，但不能跑飞：top_p 一起给
        if (Number.isFinite(this.topP) && this.topP > 0 && this.topP <= 1) {
            requestBody.top_p = this.topP;
        }
        if (Number.isFinite(this.maxTokens) && this.maxTokens > 0) {
            requestBody.max_tokens = this.maxTokens;
        }

        applyReasoningToRequestBody(requestBody, this);

        // 添加工具列表(如果提供)
        if (tools && tools.length > 0) {
            requestBody.tools = tools;
        } else {
            // tools 为 null（视觉模型调用）或空数组（强制取最终回复）都是预期行为。
            // 原来每次调用都打一行，用户看到的就是满屏重复噪音 —— 现在只在第一次说明，之后静默。
            if (!globalThis.__noToolsLogged) {
                globalThis.__noToolsLogged = true;
                logToTerminal('info', '有模型调用不带工具（视觉/收尾用），属正常，本条只提示一次');
            }
        }


        // 🔥 发送前自查：请求体必须能 JSON 序列化（历史上出过循环引用/undefined 注入把请求打挂）
        try {
            JSON.parse(JSON.stringify(requestBody));
        } catch (jsonError) {
            logToTerminal('error', `❌ 请求体JSON格式错误: ${jsonError.message}`);
            console.error('请求体内容:', requestBody);
            throw new Error(`请求格式错误: ${jsonError.message}`);
        }

        try {
            const maxAttempts = this._maxAttempts();
            let attempt = 0;
            for (;;) {
                attempt += 1;
                try {
                    return await this._attemptCompletion(requestBody, { stream, onChunk, usageCtx, usageLabel, attempt });
                } catch (error) {
                    const decision = this._decideRetry(error, attempt, maxAttempts);
                    if (!decision.retry) throw error;
                    this._noteRetry(decision, error, attempt, maxAttempts, stream, usageLabel);
                    await new Promise((r) => setTimeout(r, decision.delayMs));
                }
            }
        } catch (error) {
            // 多模态不支持错误由上层 llm-handler 统一处理和记录，这里不重复打 ERROR
            const isMultimodalError = String(error && error.message || '').toLowerCase().includes('multimodal') ||
                String(error && error.message || '').includes('不支持图片') ||
                String(error && error.message || '').includes('模型不支持图片');
            if (!isMultimodalError) {
                logToTerminal('error', `LLM API调用失败: ${error.message}`);
            }
            // P0-2（2026-11-25）：重试已用尽后，把**传输层**最终失败记进 llm-health
            // （status=0 退避）。每次重试都记会让退避阶梯提前打满，所以只在最外层记一次。
            try { noteLlmNetworkFailure(error); } catch (e) { /* 记账失败不影响抛错 */ }
            throw error;
        }
    }

    /**
     * 一次完整尝试（重试循环的单次）：发请求 → stream_options 降级 → 非 2xx 交 handleAPIError
     * → 流式 / 非流式解析。抛出的错误由 chatCompletion 按「网络/5xx/超时」分类决定是否重试。
     * @private
     */
    async _attemptCompletion(requestBody, opts) {
        const { stream, onChunk, usageCtx, usageLabel } = opts || {};
        const attempt = Number(opts && opts.attempt) || 1;
        const doFetch = (body) => fetch(`${this.apiUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify(body)
        });

        const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        let response = await (async () => {
            // 分段计时（2026-11-16）：用户反馈「说一句等好久」，而直连同网关只要 1.5s。
            // 这里分清「建连+等响应头」与「等首块 token」——两者的修法完全不同。
            const t0 = _now();
            // 事件循环卡顿探针：如果请求期间主线程被 CPU 任务堵住（截图/OCR/编码/大量 WS），
            // 网络回调会跟着排队 —— 表现就是「网关明明 1.5s，这里却 7s」。
            let _lagMax = 0; let _lagPrev = _now();
            const _lagTimer = setInterval(() => {
                const n = _now(); const lag = n - _lagPrev - 50; if (lag > _lagMax) _lagMax = lag; _lagPrev = n;
            }, 50);
            if (_lagTimer.unref) _lagTimer.unref();
            let r;
            try {
                r = await doFetch(requestBody);
            } finally {
                // 2026-11-22 内存采样：原来只在成功路径 clearInterval。doFetch 抛错
                // （断网/超时/网关 5xx）时这个 50ms 定时器会永远活着 —— 每失败一轮漏一个，
                // 长跑越积越多。定时器只做诊断，任何路径都必须停。
                clearInterval(_lagTimer);
            }
            const headersMs = Math.round(_now() - t0);
            try { logToTerminal('info', `[延迟] 网关响应头 ${headersMs}ms · 期间事件循环最大卡顿 ${Math.round(_lagMax)}ms`); } catch (e) {}
            return r;
        })();

        // 严格的端点会因为 stream_options 这个未知字段直接 400。
        // 这时去掉它重试一次：宁可拿不到 usage，也不能把她的回复打挂。
        // （去掉之后这次请求就没有 usage 了 —— 账本那条 estimated 兜底就是为这条路补的。）
        if (!response.ok && response.status === 400 && requestBody.stream_options) {
            let errText = '';
            try { errText = await response.text(); } catch (e) { /* 读不到就按通用错误处理 */ }
            if (/stream_options|unrecognized|unknown|invalid|extra/i.test(errText)) {
                logToTerminal('warn', '💾 端点不认 stream_options，去掉后重试（这轮拿不到命中率）');
                delete requestBody.stream_options;
                response = await doFetch(requestBody);
            } else {
                // 不是 stream_options 的锅：错误体已经读了，包成同样的形状交给统一错误处理
                await handleAPIError({ status: 400, statusText: 'Bad Request', text: async () => errText });
            }
        }

        if (!response.ok) {
            const status = Number(response.status) || 0;
            // 可重试状态且还有重试预算：先把错误体排空（不断连接），但**不**交给 handleAPIError ——
            // 否则每一次重试都会给 llm-health 记一次失败，把「连续 5 次失败停一天」提前打满。
            // 最后一次尝试（或 429/其它 4xx）仍走统一错误处理：日志带完整响应体、熔断照记。
            if (_isRetryableHttpStatus(status) && attempt < this._maxAttempts()) {
                try { await response.text(); } catch (e) { /* 排空失败不影响重试 */ }
                const err = new Error(`LLM API error: ${status}` + (response.statusText ? ` ${response.statusText}` : ''));
                err.status = status;
                throw err;
            }
            await handleAPIError(response);
        }

        // 🔥 流式响应处理
        if (stream && onChunk) {
            return await this._handleStreamResponse(response, onChunk, usageCtx, usageLabel);
        }

        // 非流式响应处理
        const responseData = await response.json();
        // ⚠ 顺序（2026-11-25 风暴压测）：**先校验、再记账**。
        //   旧实现先 recordUsage（内部会 noteLLMSuccess 清熔断 + 落 llm.usage），后 _validateResponse。
        //   于是「HTTP 200 但 body 是 {error:{...}}」这种网关常见形态（内容过滤/参数错误包 200，
        //   部分 OpenAI 兼容层就这么干）会被当成一次**成功**：账本多一条 estimated、熔断被清空。
        //   先校验：失败响应既不入账、也不清健康状态；成功响应照旧（choices 也被归一化好了，
        //   completionTextOf 对 data.choices 形态同样能取到正文）。
        this._validateResponse(responseData);
        this.lastUsage = recordUsage(responseData && responseData.usage, usageLabel, {
            ...usageCtx,
            transport: 'non-stream',
            completionText: completionTextOf(responseData),
        });
        emitUsageTelemetry(this.lastUsage);

        logToTerminal('info', `AI回复中`);

        const message = responseData.choices[0].message;

        // 🔥 处理 Qwen3 等模型的 reasoning_content 字段
        // 仅在没有 tool_calls 时才用 reasoning_content 替代空 content（Qwen3 推理模式）
        // 有 tool_calls 时 reasoning_content 是思考过程，不应作为回复内容（Gemini 等）
        if ((!message.content || message.content.trim() === '') && message.reasoning_content && !message.tool_calls) {
            message.content = message.reasoning_content;
        }

        // 🔥 过滤思考内容（Gemini / DeepSeek 等模型可能在 content 中混入思考）
        if (message.content) {
            message.content = this._filterThinkingContent(message.content);
        }

        // 🔥 解析 Qwen 模型的文本格式工具调用（Hermes/XML style）
        // Qwen 模型返回的是文本格式的 <tool_call>，而不是标准的 tool_calls 对象
        if (message.content && !message.tool_calls) {
            const parsedToolCalls = this._parseQwenToolCalls(message.content);
            if (parsedToolCalls && parsedToolCalls.length > 0) {
                logToTerminal('info', `🔧 AI调用了 ${parsedToolCalls.length} 个工具`);
                message.tool_calls = parsedToolCalls;
                // 从 content 中移除工具调用部分，只保留文本回复
                message.content = this._removeToolCallsFromContent(message.content);
            }
        }

        return message;
    }

    // ===== 重试（config.llm.retry）==========================================
    // 语义（2026-11-24）：只对**可恢复的传输层故障**重试 —— 网络错误、5xx、超时、
    //   以及 408/425/409 这类「这一发不巧」的状态（P2 对抗审查补齐）。
    //   · 429 不重试：配额/限流由 llm-health 熔断（重试只是把受限请求再打一遍，还会加速退避）；
    //   · 其他 4xx 不重试：请求/参数问题，重试结果一样；
    //   · 流式只在首 token 之前失败才重试：已经吐过字再重试，TTS 会把同一段话说两遍。

    /** 总尝试次数（含首发）：retry.max_attempts，默认 2，钳在 1–5。 */
    _maxAttempts() {
        const raw = this.retryConfig && this.retryConfig.max_attempts;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 1) return 2;
        return Math.min(5, Math.floor(n));
    }

    /** 指数退避：base_delay_ms（默认 300）× 2^(失败次数-1)，封顶 10s。 */
    _retryDelayMs(failedAttempt) {
        const raw = Number(this.retryConfig && this.retryConfig.base_delay_ms);
        const base = Number.isFinite(raw) && raw >= 0 ? raw : 300;
        return Math.min(10000, Math.round(base * Math.pow(2, Math.max(0, failedAttempt - 1))));
    }

    /**
     * 这次失败要不要重试。
     * @returns {{retry:boolean, reason?:string, delayMs?:number}}
     */
    _decideRetry(error, attempt, maxAttempts) {
        if (!error || attempt >= maxAttempts) return { retry: false };
        // P2-12（2026-11-25）：用户已经打断就别再重发。旧实现只看错误类型 —— 打断那一刻
        // 正好撞上 5xx/网络错，就会继续退避重试，TTS 侧已经停了她还在后台重连，
        // 表现为「喊停之后过十几秒又冒出一句」。不重试、不写 llm.retry，原错直接抛给调用方。
        if (_isInterrupted()) return { retry: false, reason: 'interrupted' };
        const status = Number(error.status);
        if (status === 429) return { retry: false, reason: 'quota' };
        if (error.streamStarted) return { retry: false, reason: 'stream-started' };
        if (Number.isFinite(status) && status > 0) {
            if (status >= 500) return { retry: true, reason: 'server', delayMs: this._retryDelayMs(attempt) };
            if (status === 408 || status === 425 || status === 409) {
                return { retry: true, reason: 'transient', delayMs: this._retryDelayMs(attempt) };
            }
            return { retry: false, reason: 'client' };
        }
        const name = String(error.name || '');
        const msg = String(error.message || '');
        if (name === 'AbortError' || error.code === 'ABORT_ERR' || /timeout|timed out|超时/i.test(msg)) {
            return { retry: true, reason: 'timeout', delayMs: this._retryDelayMs(attempt) };
        }
        if (name === 'TypeError' || /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|other side closed|terminated/i.test(msg)) {
            return { retry: true, reason: 'network', delayMs: this._retryDelayMs(attempt) };
        }
        return { retry: false, reason: 'other' };
    }

    /** 重试留痕：一行日志 + 一条 llm.retry 遥测（失败不影响请求）。 */
    _noteRetry(decision, error, attempt, maxAttempts, stream, label) {
        const status = Number.isFinite(Number(error && error.status)) ? Number(error.status) : 0;
        const delayMs = decision.delayMs;
        try {
            logToTerminal('warn', `🔁 LLM 请求失败（${decision.reason}${status ? ' ' + status : ''}），${delayMs}ms 后重试 ${attempt}/${maxAttempts}`);
        } catch (e) { /* 日志失败不影响请求 */ }
        try {
            if (_emitTelemetry) {
                _emitTelemetry({
                    cat: 'llm',
                    type: 'llm.retry',
                    title: 'LLM 重试',
                    metrics: {
                        attempt,
                        max_attempts: maxAttempts,
                        status,
                        delay_ms: delayMs,
                        stream: stream ? 1 : 0,
                    },
                    source: String(label || 'main'),
                });
            }
        } catch (e) { /* 遥测失败不影响请求 */ }
    }

    /**
     * 清理消息格式,确保API兼容性
     * @private
     * @param {Array} messages - 原始消息数组
     * @returns {Array} 清理后的消息数组
     */
    _cleanMessagesForAPI(messages) {
        const normalizedMessages = messages.map(msg => {
            // 🔥 处理 assistant 消息的 content 为 null 的情况
            if (msg.role === 'assistant') {
                // 如果有 tool_calls 但 content 为 null,设为空字符串
                if (msg.content === null && msg.tool_calls) {
                    return {
                        ...msg,
                        content: '' // 某些API要求content不能为null
                    };
                }
            }

            // 🔥 处理 tool 消息,确保格式正确
            if (msg.role === 'tool') {
                let content = msg.content;

                // 如果content是对象或数组,转为JSON字符串
                if (typeof content === 'object' && content !== null) {
                    try {
                        content = JSON.stringify(content);
                    } catch (e) {
                        content = String(content);
                    }
                }

                // 确保content是字符串（用 ?? 而不是 ||：工具真的回了 0 / false 时不能变成空串）
                if (typeof content !== 'string') {
                    content = String(content ?? '');
                }

                // 🔥 确保字符串不包含控制字符(可能导致JSON解析失败)
                // 移除所有不可见的控制字符,但保留换行符(\n)和制表符(\t)
                content = content.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

                // ⚠ 这里**不再**按 8000 字符截断（2026-11-24 删）。
                // 根因：那是 tool-result-cap 之前的旧防线。现在体积控制统一由
                // `js/ai/tool-result-cap.js` 在**宿主消息**上做（单条 12000 / 单轮 32000，
                // 超出给 offset/limit/next 或 artifact 供模型续读）。发送前再截一次 8k，
                // 等于把 8k 以上全部砍掉 —— 「可续读」永远读不到，12k/32k 写了等于没写。
                // 长度上限只有一处真源（tool-result-cap），这里只做格式清理。

                // 返回清理后的tool消息
                const cleaned = {
                    role: 'tool',
                    content: content,
                    tool_call_id: msg.tool_call_id
                };
                // name 是可选字段：宿主写 tool 消息时（如 ConversationCore.addToolResultMessage）
                // 根本不带 name，旧代码用 'unknown_tool' 伪造一个 —— 严格端点会拿它跟工具表核对，
                // 对不上就 400。只有调用方真的给了 name 才透传，否则不发这个字段。
                if (msg.name) cleaned.name = msg.name;
                return cleaned;
            }

            // 其他消息保持原样
            return msg;
        });

        // 🔥 发送前的最后一道防线：清理 assistant.tool_calls 与 tool 响应不配对的序列。
        // 无论坏数据来自旧版本保存的对话历史、裁剪还是工具执行中断，
        // 都保证发给 API 的序列合法，避免 "tool_calls must be followed by tool messages" 400 错误
        return sanitizeToolMessageSequence(normalizedMessages);
    }

    /**
     * 验证API响应格式
     * @private
     */
    _validateResponse(responseData) {
        // 检查API错误响应
        if (responseData.error) {
            const errorMsg = responseData.error.message || responseData.error || '未知API错误';
            logToTerminal('error', `LLM API错误: ${errorMsg}`);
            // 🔥 将完整的错误信息传递出去，方便重试机制识别
            throw new Error(`API错误: ${errorMsg}`);
        }

        // 检查响应格式,适应不同的API响应结构
        let choices;
        if (responseData.choices) {
            choices = responseData.choices;
        } else if (responseData.data && responseData.data.choices) {
            choices = responseData.data.choices;
        } else {
            // 🔥 详细打印响应数据以便调试
            const debugInfo = JSON.stringify(responseData).substring(0, 500);
            logToTerminal('error', `LLM响应格式异常，缺少choices字段。响应数据: ${debugInfo}`);
            console.error('完整响应数据:', responseData);
            throw new Error('LLM响应格式异常：缺少choices字段或为空');
        }

        if (!choices || choices.length === 0) {
            // 🔥 打印完整响应数据
            const debugInfo = JSON.stringify(responseData).substring(0, 500);
            logToTerminal('error', `LLM响应choices为空。响应数据: ${debugInfo}`);
            console.error('完整响应数据:', responseData);

            // 🔥 检查响应数据中是否包含"不支持图片"相关的错误信息
            const responseStr = JSON.stringify(responseData).toLowerCase();
            if (responseStr.includes('image') &&
                (responseStr.includes('not support') ||
                 responseStr.includes('不支持') ||
                 responseStr.includes('invalid') ||
                 responseStr.includes('unsupported'))) {
                logToTerminal('error', '⚠️ 检测到模型不支持视觉功能');
                throw new Error('模型不支持图片：该模型不支持 image_url 参数');
            }

            // 🔥 检查是否是内容过滤（多种可能的字段）
            if (responseData.promptFilterResults ||
                responseData.finishReason === 'content_filter' ||
                responseData.finish_reason === 'content_filter') {
                throw new Error('API内容过滤：请求被API的内容过滤器拦截，可能包含敏感内容');
            }

            // 🔥 检查usage，如果有prompt_tokens但completion_tokens为0，很可能是内容过滤
            if (responseData.usage &&
                responseData.usage.prompt_tokens > 0 &&
                responseData.usage.completion_tokens === 0) {
                logToTerminal('warn', '⚠️ API处理了请求但拒绝生成内容，可能触发了安全过滤器');
                throw new Error('API拒绝生成内容：可能触发了安全过滤器或内容政策限制。请检查最近的对话内容。');
            }

            throw new Error('LLM响应格式异常：choices为空');
        }

        // 将标准化的choices写回
        responseData.choices = choices;
    }

    /**
     * 解析 Qwen 模型的文本格式工具调用
     * @private
     * @param {string} content - 包含工具调用的文本内容
     * @returns {Array|null} 标准格式的 tool_calls 数组
     */
    _parseQwenToolCalls(content) {
        const toolCalls = [];
        let index = 0;

        // 格式1: <tool_call> ... </tool_call> (JSON 格式)
        const toolCallRegex1 = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
        let match;

        while ((match = toolCallRegex1.exec(content)) !== null) {
            try {
                const toolCallJson = JSON.parse(match[1]);
                toolCalls.push({
                    id: `call_qwen_${Date.now()}_${index}`,
                    type: 'function',
                    function: {
                        name: toolCallJson.name,
                        arguments: JSON.stringify(toolCallJson.arguments || {})
                    }
                });
                index++;
            } catch (error) {
                logToTerminal('warn', `⚠️ 解析 Qwen 工具调用(格式1)失败: ${error.message}`);
            }
        }

        // 格式2: <function_name attr1="value1" attr2="value2"/> (XML 属性格式)
        // 匹配所有自闭合的 XML 标签，例如: <open_webpage url="..."/>
        //
        // ⚠ 2026-11-10 审计抓到：这个正则**不校验函数名是否存在于工具表** ——
        //   模型正文里出现 `<a href="…"/>` 或退化 XML 里的 `<parameter name="x" string="true"/>`
        //   都会生成 `name:"a"` / `name:"parameter"` 的假工具调用，然后产生一条工具错误结果、
        //   污染后续上下文。现在用「像工具名的标签」+ 属性名白名单两道过滤：
        //   · 标签名必须是 snake_case 或短驼峰（不含 parameter/invoke/a/img 这类 HTML 词）
        //   · 至少有一个属性名不像 HTML 属性（href/src/class/id/style/type/name/value 除外时仍保留）
        const HTML_TAGS = /^(a|img|br|hr|div|span|p|b|i|u|em|strong|input|meta|link|script|style|param|parameter|invoke|call|value|type|name|string)$/i;
        const toolCallRegex2 = /<([a-z][a-z0-9_]{2,40})\s+([^>]+?)\/>/gi;

        while ((match = toolCallRegex2.exec(content)) !== null) {
            const functionName = match[1];
            if (HTML_TAGS.test(functionName)) continue;   // 明显不是工具名
            const attributesStr = match[2];

            // 解析属性
            const attributes = {};
            const attrRegex = /(\w+)="([^"]*)"/g;
            let attrMatch;

            while ((attrMatch = attrRegex.exec(attributesStr)) !== null) {
                attributes[attrMatch[1]] = attrMatch[2];
            }

            // 转换为 OpenAI 标准格式
            toolCalls.push({
                id: `call_qwen_${Date.now()}_${index}`,
                type: 'function',
                function: {
                    name: functionName,
                    arguments: JSON.stringify(attributes)
                }
            });
            index++;
        }

        // 格式3: <tool_calls><invoke name="X"><parameter name="Y" string="true">V</parameter></invoke></tool_calls>
        //
        // ⚠ 2026-11-10 三十八轮拟真实测抓到：deepseek-v4.1-flash 在长上下文/复杂工具描述
        //   下会退化输出这种 **Anthropic/Hermes 风格** XML —— 而不是标准 tool_calls 对象。
        //   表现：「她在文本里说要调 som_click，但没有任何真调用」→ 用户看到的是
        //   「她自己不干活」。实测连续两轮 100% 复现（对话历史 441/442 行）。
        //   原有解析器只认 <tool_call> JSON 和自闭合 XML，漏了这一种。
        //
        // ⚠ 同轮第二次实测：标签前缀会抖 —— 出现 `<||DSML|| calls>` / `<|DSML| calls>`
        //   （DeepSeek 的 DSML 标记被模型当成标签吐出来）。所以标签名用「包含关键词」匹配：
        //   `<[^<>]*calls>` 能同时吃掉 tool_calls 和 DSML 变体。
        //   这是「同一个 bug 的第三个变体」——兜底解析必须按语义（calls/invoke/parameter）认，
        //   不能按字面标签认。
        const blockRe = /<[^<>]*calls>([\s\S]*?)<\/[^<>]*calls>/gi;
        let blk;
        while ((blk = blockRe.exec(content)) !== null) {
            const inner = blk[1];
            const invokeRe = /<[^<>]*invoke\s+name="([^"]+)"[^<>]*>([\s\S]*?)<\/[^<>]*invoke>/gi;
            let im;
            while ((im = invokeRe.exec(inner)) !== null) {
                const fnName = im[1];
                const args = {};
                const paramRe = /<[^<>]*parameter\s+name="([^"]+)"[^<>]*>([\s\S]*?)<\/[^<>]*parameter>/gi;
                let pm;
                while ((pm = paramRe.exec(im[2])) !== null) {
                    let v = pm[2].trim();
                    // string="true" 明确是字符串；否则尝试按 JSON 解析（数字/布尔/对象）
                    if (!/string="true"/i.test(pm[0])) {
                        try { v = JSON.parse(v); } catch (e) { /* 保持字符串 */ }
                    }
                    args[pm[1]] = v;
                }
                toolCalls.push({
                    id: `call_xml_${Date.now()}_${index}`,
                    type: 'function',
                    function: { name: fnName, arguments: JSON.stringify(args) },
                });
                index++;
            }
        }

        return toolCalls.length > 0 ? toolCalls : null;
    }

    /**
     * 过滤模型思考/推理内容，防止思考过程被TTS播放或显示为字幕
     * 支持 Gemini、DeepSeek 等模型的多种思考格式
     * @param {string} text - 原始文本
     * @returns {string} 过滤后的文本
     */
    _filterThinkingContent(text) {
        if (!text) return text;

        let filtered = text;

        // 过滤 <think>...</think> 块（DeepSeek、部分 Gemini 格式）
        filtered = filtered.replace(/<think>[\s\S]*?<\/think>/gi, '');

        // 过滤 <thinking>...</thinking> 块
        filtered = filtered.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');

        // 过滤 Gemini 中文思考格式：整段以"思考"开头（独占一行）的内容
        // 仅在整段内容都是思考时才清除（避免误杀正常对话中的"思考"二字）
        if (/^思考\s*\n/.test(filtered)) {
            filtered = '';
        }

        // 过滤 Gemini 英文思考格式：整段以"Thinking"开头（独占一行）
        if (/^Thinking\s*\n/i.test(filtered)) {
            filtered = '';
        }

        return filtered.trim();
    }

    /**
     * 从内容中移除工具调用部分
     * @private
     * @param {string} content - 原始内容
     * @returns {string} 移除工具调用后的内容
     */
    _removeToolCallsFromContent(content) {
        // 移除格式1: <tool_call> ... </tool_call>
        let cleaned = content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');

        // 移除格式2: <function_name attr="value"/>
        cleaned = cleaned.replace(/<\w+\s+[^>]+?\/>/g, '');

        // 移除格式3: tool_calls / DSML 变体的 invoke 块（按语义前缀匹配）
        cleaned = cleaned.replace(/<[^<>]*calls>[\s\S]*?<\/[^<>]*calls>/gi, '');

        return cleaned.trim();
    }

    /**
     * 处理流式响应
     * @private
     * @param {Response} response - Fetch响应对象
     * @param {Function} onChunk - 接收每个文本块的回调函数
     * @returns {Promise<Object>} 完整的消息对象
     */
    async _handleStreamResponse(response, onChunk, usageCtx, usageLabel) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        // 首块耗时（2026-11-16）：与「网关响应头」对照，分清是建连慢还是模型生成慢
        let _firstChunkLogged = false;
        const _sT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

        let buffer = '';
        let fullContent = '';
        let toolCalls = null;
        let streamUsage = null;
        // 首 token 是否已经吐出去（2026-11-24 重试语义）：流式失败只有在**还没吐过字**时才能重试，
        // 否则 TTS/字幕会把同一段话说两遍。这里只做标记，重试判定在 chatCompletion。
        let _sawDelta = false;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!_firstChunkLogged) {
                    _firstChunkLogged = true;
                    try {
                        const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - _sT0);
                        logToTerminal('info', `[延迟] 首个数据块 ${ms}ms（响应头已到之后，等模型生成）`);
                    } catch (e) { /* 观测失败不影响流 */ }
                }

                // 解码数据块
                buffer += decoder.decode(value, { stream: true });

                // 处理SSE格式的数据（data: {...}\n\n）
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // 保留不完整的行

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') continue;//添加心流API支持

                    if (trimmed.startsWith('data:')) {
                        try {
                            const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5); // 移除 "data: " 前缀，自适应有无空格
                            const chunk = JSON.parse(jsonStr);

                            // usage 通常只在最后一个 chunk 出现（且 choices 为空数组）
                            if (chunk.usage) streamUsage = chunk.usage;

                            // 提取内容
                            const delta = chunk.choices?.[0]?.delta;
                            if (!delta) continue;

                            // 处理文本内容
                            if (delta.content) {
                                _sawDelta = true;
                                fullContent += delta.content;
                                onChunk(delta.content); // 🔥 实时回调
                            }

                            // 处理工具调用
                            if (delta.tool_calls) {
                                _sawDelta = true;
                                if (!toolCalls) toolCalls = [];
                                // 累积工具调用信息
                                for (const toolCall of delta.tool_calls) {
                                    const index = toolCall.index || 0;
                                    if (!toolCalls[index]) {
                                        toolCalls[index] = {
                                            id: toolCall.id || '',
                                            type: 'function',
                                            function: { name: '', arguments: '' }
                                        };
                                    }
                                    if (toolCall.id) toolCalls[index].id = toolCall.id;
                                    if (toolCall.function?.name) toolCalls[index].function.name = toolCall.function.name;
                                    if (toolCall.function?.arguments) toolCalls[index].function.arguments += toolCall.function.arguments;
                                }
                            }
                        } catch (parseError) {
                            // 忽略解析错误，继续处理下一行
                            logToTerminal('warn', `⚠️ 流式数据解析失败: ${parseError.message}`);
                        }
                    }
                }
            }

//            logToTerminal('info', `✅ 流式响应接收完成`);

            // 🔥 过滤思考内容（Gemini 等模型可能在流式 content 中混入思考过程）
            if (fullContent) {
                fullContent = this._filterThinkingContent(fullContent);
            }

            // 构建完整的消息对象
            const message = {
                role: 'assistant',
                content: fullContent || null
            };

            if (toolCalls && toolCalls.length > 0) {
                message.tool_calls = toolCalls;
            }

            // 🔥 解析 Qwen 模型的文本格式工具调用
            if (message.content && !message.tool_calls) {
                const parsedToolCalls = this._parseQwenToolCalls(message.content);
                if (parsedToolCalls && parsedToolCalls.length > 0) {
                    logToTerminal('info', `🔧 AI调用了 ${parsedToolCalls.length} 个工具`);
                    message.tool_calls = parsedToolCalls;
                    message.content = this._removeToolCallsFromContent(message.content);
                }
            }

            // 记录本轮前缀缓存命中（上游没给就只记 prompt，不编造 cached）
            this.lastUsage = recordUsage(streamUsage, usageLabel || 'main', {
                ...(usageCtx || {}),
                transport: 'stream',
                // usage 缺失时（端点不认 stream_options）用「已收正文 + 工具参数」估算 completion
                completionText: fullContent + (toolCalls && toolCalls.length ? JSON.stringify(toolCalls) : ''),
            });
            emitUsageTelemetry(this.lastUsage);

            return message;
        } catch (error) {
            // 标记「是否已经吐过 token」：只有 false 时 chatCompletion 才允许重试这一条流
            try { error.streamStarted = _sawDelta; } catch (e) { /* 冻结对象等极端情况忽略 */ }
            // P2-12b：已经吐过字的失败也要留一条**不完整**账（见 emitUsageTelemetry 里 incomplete）。
            // 不覆盖 lastUsage：那不是一次可用的真账基线（prompt 缺失），别把上一轮的有效基线冲掉。
            if (_sawDelta) {
                try {
                    const rec = recordUsage(null, usageLabel || 'main', {
                        ...(usageCtx || {}),
                        transport: 'stream-incomplete',
                        completionText: fullContent,
                        skipHealth: true,
                        skipLastUsage: true,
                    });
                    if (rec) {
                        rec.incomplete = true;
                        rec.msgCount = Number.isFinite(Number(usageCtx && usageCtx.msgCount)) ? usageCtx.msgCount : rec.msgCount;
                        emitUsageTelemetry(rec);
                    }
                } catch (e) { /* 账本失败不影响错误抛出 */ }
            }
            logToTerminal('error', `流式响应处理错误: ${error.message}`);
            throw error;
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * 更新API配置
     * @param {Object} newConfig - 新的配置对象
     */
    updateConfig(newConfig) {
        if (newConfig.llm) {
            this.apiKey = newConfig.llm.api_key || this.apiKey;
            this.apiUrl = newConfig.llm.api_url || this.apiUrl;
            this.model = newConfig.llm.model || this.model;
            this.temperature = newConfig.llm.temperature !== undefined ? newConfig.llm.temperature : this.temperature;  // 🔥 支持temperature更新
            this.temperatureEnabled = newConfig.llm.temperature_enabled !== undefined ? newConfig.llm.temperature_enabled : this.temperatureEnabled;
            this.reasoningEnabled = newConfig.llm.reasoning_enabled !== undefined
                ? newConfig.llm.reasoning_enabled === true
                : this.reasoningEnabled;
            this.reasoningEffort = newConfig.llm.reasoning_effort !== undefined
                ? newConfig.llm.reasoning_effort
                : this.reasoningEffort;
            logToTerminal('info', 'LLM客户端配置已更新');
        }
    }

    /**
     * 获取当前配置
     * @returns {Object}
     */
    getConfig() {
        return {
            apiUrl: this.apiUrl,
            model: this.model
        };
    }
}

module.exports = {
    LLMClient,
    // ADR-014：给压缩/裁剪/诊断读「最近一次真实用量」，不必自己去摸 globalThis
    getLastUsage: usageLedger.getLastUsage,
    clearLastUsage: usageLedger.clearLastUsage,
};
