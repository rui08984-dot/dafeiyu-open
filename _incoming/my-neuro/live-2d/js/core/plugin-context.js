// plugin-context.js - 插件上下文
// 每个插件通过此对象访问核心能力，实现安全隔离

const __silentAudit = require('./silent-audit.js');
// §72：mood 格式指令必须追加在**系统提示词真正的末尾** —— 放在 buildSystemPrompt 里会被
// 插件注入（--- Plugin Injections ---）盖住，实测模型直接不照做。
const { MOOD_INSTRUCTION } = require('../ai/mood-line.js');
const fs = require('fs');
const path = require('path');
const { eventBus } = require('./event-bus.js');
const { llmProviderManager } = require('./llm-provider.js');
const { createRequestDeadline } = require('./request-deadline.js');
const { applyReasoningToRequestBody } = require('../ai/reasoning-request.js');

class PluginStorage {
    constructor(pluginName) {
        this._data = {};
        this._name = pluginName;
    }

    get(key) {
        return this._data[key];
    }

    set(key, value) {
        this._data[key] = value;
    }

    delete(key) {
        delete this._data[key];
    }

    getAll() {
        return { ...this._data };
    }
}

// ⚠ 系统提示注入必须是「全局共享」的。
// 原来每个 PluginContext 各有一份 Map，_applySystemPromptPatches() 却只把
// 「自己这一份」拼进去并整体覆盖 sys.content ——
// 于是最后一个写补丁的插件会把前面所有插件的注入全部抹掉。
// 表现：一起看的对白上下文、记忆检索片段、看屏提示互相顶掉，只有一个活着。
// 改成所有 context 共用同一张表，谁的补丁都不会丢。
const SHARED_PROMPT_PATCHES = new Map();

// ── 只读快照（B7 plugin-context 快照）──────────────────────────────────────
// 插件拿到的是快照副本，不是宿主的活对象：插件改自己的副本不会污染
// global.voiceChat.messages / config，热重载后的旧模块也读不到「未来」的改动。
//
// 实现刻意**只复制对象/数组结构，复用字符串等原始值**：消息里可能带 base64
// 截图（多 MB），structuredClone/JSON 会把这些字符串再复制一份；而字符串本身
// 不可变，插件改不了它，没有复制必要。非普通对象（Date/Map/Buffer…）才走
// structuredClone，失败时退化为 shared 引用（宁可少隔离，不抛错/不炸内存）。
function snapshotValue(value) {
    if (value === null || typeof value !== 'object') return value;
    try {
        return snapshotPlain(value, new Map());
    } catch (_) {
        return value;
    }
}

function snapshotPlain(value, seen) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
        const out = new Array(value.length);
        seen.set(value, out);
        for (let i = 0; i < value.length; i += 1) out[i] = snapshotPlain(value[i], seen);
        return out;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
        // Date/Map/Set/Buffer/类实例：保持语义交给 structuredClone；失败就共享。
        try { return typeof structuredClone === 'function' ? structuredClone(value) : value; }
        catch (_) { return value; }
    }
    const out = {};
    seen.set(value, out);
    for (const key of Object.keys(value)) out[key] = snapshotPlain(value[key], seen);
    return out;
}

// 从 sys.content 里剥掉「上一次我们自己写的」注入块与 mood 指令，得到真正的基础提示词。
// 旧实现用 `sys._baseContent` 快照当基底：外部（人格重载/其它模块）改了 sys.content 后，
// 下一次插件 add/remove 会用旧快照整体覆盖，外部修改丢失。现在每次从当前内容反推，
// 只移除本模块写过的两段，外部追加的内容原样保留。
const PATCH_BLOCK_START = '\n\n--- Plugin Injections ---';
const PATCH_BLOCK_END = '\n--- End Plugin Injections ---';

function stripLastPluginBlock(content) {
    let text = String(content == null ? '' : content);
    const start = text.lastIndexOf(PATCH_BLOCK_START);
    if (start < 0) return text;
    const end = text.indexOf(PATCH_BLOCK_END, start);
    if (end < 0) return text.slice(0, start);   // 半截块（异常中断）：截掉
    return text.slice(0, start) + text.slice(end + PATCH_BLOCK_END.length);
}

function stripMoodInstruction(content) {
    let text = String(content == null ? '' : content);
    const mood = String(MOOD_INSTRUCTION || '');
    if (!mood) return text;
    const idx = text.lastIndexOf(mood);
    if (idx < 0) return text;
    return text.slice(0, idx) + text.slice(idx + mood.length);
}

/** 当前 system content → 基础提示词（移除本模块的注入块与 mood 尾巴）。 */
function deriveSystemBase(content) {
    return stripMoodInstruction(stripLastPluginBlock(content));
}

/** 基础提示词 + 当前稳定补丁 + mood 指令（纯函数，便于单测）。 */
function buildSystemContent(base, patches, moodInstruction = MOOD_INSTRUCTION) {
    const patchText = patches.length > 0
        ? '\n\n--- Plugin Injections ---\n' + patches.join('\n') + '\n--- End Plugin Injections ---'
        : '';
    return String(base == null ? '' : base) + patchText + String(moodInstruction || '');
}

// ── LLM 错误透出（2026-11-24 审计 P0-1）───────────────────────────────────
// 原来 !response.ok 只抛 `LLM API error: 429`：响应体里写着「Your limit resets at
// 2026-11-24T08:30:32.238Z」，被整段丢掉，后台任务只能每 5 分钟盲重试。
// 这里把「状态码 + 响应体摘要 + 重试/配额重置时刻」挂到 Error 上，
// 由 llm-health 决定退避还是停到重置时刻。
// ⚠ 不打印、不记录 apiKey：响应体来自服务端，请求头从不进入 message。
const ERROR_BODY_MAX = 2000;
const ERROR_EXCERPT_MAX = 160;
const RESET_AT_RE = /(?:resets?|reset)\s+at\s*[:：]?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/i;
const ISO_TIME_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/;

function parsePositiveMs(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function isoToMs(text) {
    const m = String(text == null ? '' : text).match(ISO_TIME_RE);
    if (!m) return 0;
    const t = Date.parse(m[0]);
    return Number.isFinite(t) && t > 0 ? t : 0;
}

/**
 * 从失败响应里提取「人话」与「什么时候能再试」。
 * 纯函数，便于单测；不抛错（调用方正处在错误路径上，不能再叠一层异常）。
 * @param {string} body 响应体文本（已截断到 ERROR_BODY_MAX）
 * @param {Headers|object} [headers] 响应头
 * @returns {{message:string, retryAfterMs:number, quotaResetAt:number}}
 */
function extractLlmErrorInfo(body, headers) {
    const text = String(body == null ? '' : body);
    let parsed = null;
    try { parsed = text.trim() ? JSON.parse(text) : null; } catch (e) { parsed = null; }

    let message = '';
    let retryAfterMs = 0;
    let quotaResetAt = 0;

    if (parsed && typeof parsed === 'object') {
        const errObj = parsed.error && typeof parsed.error === 'object' ? parsed.error : null;
        const cand = [errObj && errObj.message, parsed.message, typeof parsed.error === 'string' ? parsed.error : ''];
        for (const c of cand) {
            if (typeof c === 'string' && c.trim()) { message = c; break; }
        }
        retryAfterMs = parsePositiveMs(parsed.retry_after_ms) || parsePositiveMs(parsed.retryAfterMs) ||
            parsePositiveMs(parsed.retry_after) * 1000 || 0;
        if (errObj) {
            retryAfterMs = retryAfterMs || parsePositiveMs(errObj.retry_after_ms) ||
                parsePositiveMs(errObj.retry_after) * 1000 || 0;
        }
        const resetCand = [
            parsed.resets_at, parsed.reset_at, parsed.quota_reset_at,
            errObj && errObj.resets_at, errObj && errObj.reset_at, errObj && errObj.message, message,
        ];
        for (const c of resetCand) {
            if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
                quotaResetAt = c > 1e12 ? Math.floor(c) : Math.floor(c * 1000);
                break;
            }
            if (typeof c === 'string') {
                const t = isoToMs(c) || 0;
                if (t) { quotaResetAt = t; break; }
            }
        }
    }
    if (!message) message = text;
    if (!quotaResetAt) {
        const m = text.match(RESET_AT_RE);
        if (m) quotaResetAt = isoToMs(m[1]);
    }

    if (!retryAfterMs && headers) {
        let header = null;
        try {
            header = typeof headers.get === 'function'
                ? headers.get('retry-after')
                : (headers['retry-after'] ?? headers['Retry-After']);
        } catch (e) { header = null; }
        if (header != null) {
            const sec = Number(header);
            if (Number.isFinite(sec) && sec > 0) retryAfterMs = sec * 1000;
            else {
                const t = Date.parse(String(header));
                if (Number.isFinite(t)) retryAfterMs = Math.max(0, t - Date.now());
            }
        }
    }

    return { message: String(message || ''), retryAfterMs, quotaResetAt };
}

// ── provider fail-closed（2026-11-24 第三轮 · 堵隐式回云）──────────────────────
// 事实：`resolveProviderOrFallback(providerId)` 找不到 provider 时会**降级到默认（云端）
// provider**（llm-provider.js:194-228），所以旧 callLLM 拿到的「provider」其实可能是云。
// `memory-evolve` 用 `provider_id:'local-memory'`，一旦配置丢失/manager 未初始化，
// 旧代码会把片段卡**静默打到云端**（审计 §8.5 最后一条）。
//
// 规则（本函数只有一个出口，别在调用点各写一份）：
//   · providerId 非空且解析不到**同一个 id** → 抛 PROVIDER_NOT_FOUND，绝不回退；
//   · providerId 为空 → 保留旧行为（legacy api_url → voiceChat 全局模型）；
//   · `local-memory` 解析到非回环地址只 warn（配置责任在人，但不许静默）。
const _warnedProviderUrls = new Set();

/** 从 api_url 取 host（够用即可：provider 都是 http(s) URL）；取不到返回 ''。 */
function urlHost(apiUrl) {
    const m = String(apiUrl == null ? '' : apiUrl).match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
    if (!m) return '';
    return String(m[1]).replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase();
}

/**
 * 回环判定（纯函数）：回环 = 请求没出本机 = **不消耗云端周配额**。
 * 调用点唯一：callLLM 落 llm.usage 时据此决定 source=local 还是 plugin
 * （doctor 的 80% 周预算只算 source≠local 的云端真账）。判错只会「多算钱」，
 * 不会漏拦——所以这里宁可把本机别名认全。
 *
 * 为什么放宽到整个 127/8 与任意端口（2026-11-24）：本地 provider 不止 11435 ——
 * 本机 wb 在 127.0.0.1:20128，之前只认 127.0.0.1:11435，wb 的调用被记成
 * source=plugin 而进了云端 80% 预算。
 * 2026-11-25 补齐 IPv6/别名变体（旧版只认裸 `::1`）：
 *   · `[::1]` / `[::1%25lo0]`：方括号 + RFC 6874 zone id（URL 里 `%` 编码成 `%25`）；
 *   · `[::ffff:127.0.0.1]`：IPv4-mapped IPv6，剥掉 `::ffff:` 后按内层 IPv4 再判一次；
 *   · `0.0.0.0`：监听地址（客户端理论上不用，但模板/旧配置里出现过），按本机算。
 * 口径与 local-llm.isLocalUrl（只认 11435 的「本地记忆模型」）不同层级：
 * 那里判的是「是不是 MemOperator」，这里判的是「出没出本机」。
 * @param {string} host 仅 host（可带方括号/zone id），不要传端口
 * @returns {boolean}
 */
function isLoopbackHost(host) {
    let h = String(host == null ? '' : host).trim().toLowerCase();
    if (!h) return false;
    // ① 去 IPv6 方括号：[::1] → ::1
    h = h.replace(/^\[/, '').replace(/\]$/, '');
    // ② 去 zone id：`::1%25lo0`（URL 编码的 %25）与 `fe80::1%eth0`（原始形式）
    const pct = h.indexOf('%');
    if (pct >= 0) h = h.slice(0, pct);
    // ③ IPv4-mapped IPv6：::ffff:127.0.0.1 → 127.0.0.1
    if (h.startsWith('::ffff:')) h = h.slice('::ffff:'.length);
    if (!h) return false;
    if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function isLoopbackUrl(apiUrl) {
    const host = urlHost(apiUrl);
    if (host) return isLoopbackHost(host);
    // 没有 scheme 的裸 host:port（旧插件字段可能这么写）也要认
    const bare = String(apiUrl == null ? '' : apiUrl).trim().split(/[/?#]/)[0];
    return isLoopbackHost(String(bare).replace(/^[^@]*@/, '').replace(/:\d+$/, ''));
}

/**
 * 指定了 provider_id 却拿不到它 → 构造可识别的错误（调用方按 code 分支）。
 * @param {string} providerId
 * @returns {Error & {code:string, providerId:string, availableProviders:string[]}}
 */
function providerNotFoundError(providerId) {
    let available = [];
    let initialized = false;
    try {
        initialized = llmProviderManager.isInitialized() === true;
        available = llmProviderManager.getAllProviders()
            .filter((p) => p && p.id && p.enabled !== false && p.api_url)
            .map((p) => String(p.id));
    } catch (e) { available = []; }
    const err = new Error(
        `LLM 提供商不可用：${providerId}（未配置或已禁用）` +
        (initialized ? '' : '；provider 管理器尚未初始化') +
        `。按 fail-closed 规则不回退到全局云模型。` +
        `可用提供商：${available.length ? available.join(', ') : '无'}`
    );
    err.code = 'PROVIDER_NOT_FOUND';
    err.providerId = String(providerId);
    err.availableProviders = available;
    err.managerInitialized = initialized;
    return err;
}

/** 本地 provider 指到非回环地址：warn 一次（按 URL 去重），不阻断。 */
function warnIfLocalProviderNotLoopback(providerId, apiUrl) {
    if (String(providerId) !== 'local-memory') return;
    if (!apiUrl || isLoopbackUrl(apiUrl)) return;
    const key = String(apiUrl);
    if (_warnedProviderUrls.has(key)) return;
    _warnedProviderUrls.add(key);
    try {
        const { logToTerminal } = require('../api-utils.js');
        logToTerminal('warn', `⚠️ 本地记忆 provider "local-memory" 指向非回环地址 ${apiUrl}`
            + '（期望 127.0.0.1/localhost:11435）——该地址会按普通云端调用计费，请核对 llm_providers.json');
    } catch (e) { /* 日志失败不影响调用 */ }
}

// 人格导演仲裁本体（dawn-dusk-line 消费端约定早已存在但一直没人实现——
// global.proactiveArbiter 恒 undefined，节目实际无仲裁直发）。
// 说话协调器单例补上：时间协调即仲裁决策。core 模块加载早于插件，挂 global 安全。
// 顺带挂 singleton 本体（global.speechCoordinator）：doctor/诊断可以直接读 stats()。
try {
    const { singleton: _speechSingleton } = require('./speech-coordinator.js');
    if (!global.proactiveArbiter) global.proactiveArbiter = _speechSingleton.arbiterGlobal();
    if (!global.speechCoordinator) global.speechCoordinator = _speechSingleton;
} catch (e) { try { __silentAudit.audit('plugin-context.js:50', e); } catch (e2) {} }

class PluginContext {
    /**
     * @param {string} pluginName - 插件名称
     * @param {object} config - 全局 config.json
     * @param {object} pluginManager - PluginManager 实例（用于插件间通信）
     */
    constructor(pluginName, config, pluginManager, pluginDir) {
        this._pluginName = pluginName;
        this._config = config;
        this._pluginManager = pluginManager;
        this._pluginDir = pluginDir || null;
        // 与所有插件共用同一张补丁表（见文件顶部说明）。id 由各插件自己命名空间化。
        this._systemPromptPatches = SHARED_PROMPT_PATCHES;
        // 补丁 owner：卸载/禁用时只清自己的，不误删别的插件注入。
        this._promptPatchOwner = String(pluginName == null ? '' : pluginName);

        /** 每插件独立的持久化存储（内存版，可扩展为文件）*/
        this.storage = new PluginStorage(pluginName);
    }

    // ===== 开关（单一真相源）=====

    /**
     * 本插件是否启用 —— **唯一真相源是 plugins/enabled_plugins.json**。
     *
     * 2026-11-21：以前同一个插件有三道闸（能力页写的 enabled_plugins、
     * 插件页写的 plugin_config.enabled、插件代码自己的默认值），
     * 三处不一致时表现为「开了但没生效」，用户不知道该信哪个。
     * 现在 plugin-manager 只加载 enabled_plugins.json 里的插件，
     * 这里把「manager 的答案」以只读 getter 暴露给插件；
     * 插件内 plugin_config.enabled 降级为兼容读取（只认显式 false，且会警告）。
     *
     * 注意：只读，不改任何状态；manager 不可用（单测 mock）时返回 true，
     * 让插件退回自己的旧默认，而不是莫名全关。
     * @returns {boolean}
     */
    isPluginEnabled() {
        const mgr = this._pluginManager;
        if (!mgr || typeof mgr.isPluginEnabled !== 'function') return true;
        try {
            return mgr.isPluginEnabled(this._pluginName) !== false;
        } catch (e) {
            return true;
        }
    }

    // ===== 对话 =====

    /** 获取当前对话历史（**只读快照**：插件改副本不影响宿主历史）。 */
    getMessages() {
        const voiceChat = global.voiceChat;
        if (!voiceChat) return [];
        return snapshotValue(voiceChat.messages || []);
    }

    /**
     * 获取当前对话历史的**活引用**（边界明确：只给需要原位维护的宿主插件用）。
     *
     * 目前唯一合法调用方是 watch-screen：它要在把新截图发给模型前，原位清掉历史里
     * 旧的 image_url，避免多 MB base64 在上下文里累积。这类「维护宿主状态」的插件
     * 必须显式拿活引用，不能靠 getMessages() 的副本悄悄写入（那会变成静默无效）。
     * 插件**不得**缓存这个引用跨轮使用，也不得改写 role/顺序。
     */
    getMessagesLive() {
        const voiceChat = global.voiceChat;
        if (!voiceChat) return [];
        return voiceChat.messages || [];
    }

    /**
     * 注入系统提示词片段（幂等，可多次调用）
     * @param {string} id - 唯一标识，用于后续移除
     * @param {string} text - 要注入的文本
     * @param {{volatile?: boolean}} [opts]
     *   volatile=true：**不进 system**，改为在发请求时拼到最后一条 user 消息末尾。
     *   为什么（2026-11-16 六十二轮）：system 里任何每轮变化的字节都会让它后面的
     *   整段历史缓存作废（实测 97.4% → 83.8%）。召回片段/此刻状态/屏幕描述都属于这类。
     */
    addSystemPromptPatch(id, text, opts) {
        const volatile = !!(opts && opts.volatile);
        const normalizedText = String(text == null ? '' : text);
        const existing = this._systemPromptPatches.get(id);
        if (existing && typeof existing === 'object') {
            // 同一个 id 可能被多个插件共用（如 untrusted-data 的边界补丁）：
            // owners 记录所有贡献者，卸载一个不能把别人的注入一起删掉。
            if (!(existing.owners instanceof Set)) {
                existing.owners = new Set(existing.owner ? [existing.owner] : []);
            }
            existing.owners.add(this._promptPatchOwner);
            existing.text = normalizedText;
            existing.volatile = volatile;
            existing.owner = this._promptPatchOwner;
        } else {
            this._systemPromptPatches.set(id, {
                text: normalizedText,
                volatile,
                owner: this._promptPatchOwner,
                owners: new Set([this._promptPatchOwner]),
            });
        }
        this._applySystemPromptPatches();
    }

    /**
     * 移除已注入的系统提示词片段
     * @param {string} id
     */
    removeSystemPromptPatch(id) {
        this._systemPromptPatches.delete(id);
        this._applySystemPromptPatches();
    }

    /**
     * 卸载/禁用时清掉本插件留下的稳定/volatile 补丁（B7：补丁表原来没有 owner，
     * 插件热重载后旧注入会一直留在 system 里）。
     * @returns {number} 清掉的条数
     */
    releaseSystemPromptPatches() {
        let removed = 0;
        for (const [id, value] of Array.from(this._systemPromptPatches.entries())) {
            if (!value || typeof value !== 'object') continue;
            const owners = value.owners instanceof Set
                ? value.owners
                : new Set(value.owner ? [value.owner] : []);
            if (!owners.has(this._promptPatchOwner)) continue;
            owners.delete(this._promptPatchOwner);
            removed += 1;
            if (owners.size === 0) {
                this._systemPromptPatches.delete(id);
            } else {
                // 还有别的插件在用：保留补丁，只摘掉本插件的所有权。
                value.owners = owners;
                if (value.owner === this._promptPatchOwner) value.owner = Array.from(owners)[0];
            }
        }
        if (removed > 0) this._applySystemPromptPatches();
        return removed;
    }

    _applySystemPromptPatches() {
        const voiceChat = global.voiceChat;
        if (!voiceChat || !voiceChat.messages) return;

        // 找到系统消息并追加 patch 标记
        // 使用一个约定的标记区间来识别插件注入内容
        // 注意：只拼**稳定**补丁。volatile 补丁由 prompt-layout 在请求时摆到 user 末尾。
        const patches = Array.from(this._systemPromptPatches.entries())
            .filter(([, v]) => !(v && v.volatile))
            .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
            .map(([, v]) => (v && v.text !== undefined ? v.text : String(v)));

        const sys = voiceChat.messages.find(m => m.role === 'system');
        if (sys) {
            // 基底从**当前内容**反推：外部改动（人格重载/别的模块追加）不会被旧快照覆盖。
            const base = deriveSystemBase(sys.content);
            sys._baseContent = base;   // 兼容旧诊断读取；不再作为写回依据
            // §72：指令放在最后一句（插件注入之后）
            sys.content = buildSystemContent(base, patches);
        }
    }

    // ===== LLM =====

    /**
     * 插件自己调用 LLM（独立请求，不进入对话历史）
     * @param {string} prompt
     * @param {object} options - { model, temperature, ... }
     * @returns {Promise<string>}
     */
    // 解析 LLM 提供商（通讯录）；供插件查询当前/指定 provider 的连接与模型级参数
    resolveLLM(providerId, modelId = null) {
        return llmProviderManager.resolveProviderOrFallback(
            providerId || null,
            modelId || null
        );
    }

    /**
     * 插件自己调用 LLM（独立请求，不进入对话历史）
     * @param {string} prompt
     * @param {object} options - { provider_id, model/model_id, timeout_ms, temperature, ... }
     *   provider_id: 指定提供商；**给了就必须解析到它本身**，解析失败抛 PROVIDER_NOT_FOUND
     *                （fail-closed，绝不回退到全局云模型）；留空才跟随当前全局对话模型
     *   api_url/api_key: 仅旧插件兼容；provider_id 为空时用作连接，不进请求体
     *   timeout_ms: 可选请求超时
     */
    async callLLM(prompt, options = {}) {
        // 剔除内部路由字段，避免连接信息和控制参数泄漏进请求体
        const {
            provider_id: providerId,
            model_id: modelId,
            api_url: legacyApiUrl,
            api_key: legacyApiKey,
            timeout_ms: requestedTimeoutMs,
            signal: parentSignal,
            ...requestOptions
        } = options;
        const requestedModel = requestOptions.model || modelId || null;

        let apiUrl = '';
        let apiKey = '';
        let model = '';
        let resolvedProvider = null;

        // 优先使用插件显式指定的提供商。
        // ⚠ fail-closed（2026-11-24 第三轮）：指定了 provider_id 就必须**真的是它**。
        //   resolveProviderOrFallback 找不到会降级到默认（云端）provider；如果在这里
        //   接受降级结果，memory-evolve 的 local-memory 一丢配置就会静默烧云配额。
        //   只有 providerId 为空时才允许走下面的 legacy / 全局回退。
        if (providerId) {
            const provider = this.resolveLLM(providerId, requestedModel);
            const matched = provider
                && provider.id !== '_empty'
                && String(provider.id) === String(providerId)
                && !!provider.api_url;
            if (!matched) throw providerNotFoundError(providerId);
            resolvedProvider = provider;
            apiUrl = provider.api_url;
            apiKey = provider.api_key;
            model = provider.model;
            warnIfLocalProviderNotLoopback(providerId, apiUrl);
        }

        // provider 留空时兼容旧插件字段；这些字段只决定连接，不进入请求体
        if (!apiUrl && legacyApiUrl) {
            apiUrl = legacyApiUrl;
            apiKey = legacyApiKey || '';
            model = requestedModel || '';
        }

        // 旧字段也为空时，回退到当前全局对话模型
        if (!apiUrl) {
            const voiceChat = global.voiceChat;
            if (llmProviderManager.isInitialized && llmProviderManager.isInitialized()) {
                resolvedProvider = this.resolveLLM(null, requestedModel);
            }
            if (voiceChat && voiceChat.API_URL) {
                apiUrl = voiceChat.API_URL;
                apiKey = voiceChat.API_KEY || '';
                model = requestedModel || voiceChat.MODEL || (resolvedProvider && resolvedProvider.model) || '';
            } else if (resolvedProvider) {
                apiUrl = resolvedProvider.api_url;
                apiKey = resolvedProvider.api_key;
                model = resolvedProvider.model;
            } else {
                throw new Error('LLM not available');
            }
        }

        const requestBody = {
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            ...requestOptions,
            model
        };
        // 无显式 temperature 时保持旧默认 1.0；若当前模型开启了模型级温度则用模型值。
        if (!Object.prototype.hasOwnProperty.call(requestOptions, 'temperature')) {
            if (resolvedProvider && resolvedProvider.temperature_enabled === true) {
                requestBody.temperature = resolvedProvider.temperature ?? 1.0;
            } else {
                requestBody.temperature = 1.0;
            }
        }
        if (
            !Object.prototype.hasOwnProperty.call(requestOptions, 'reasoning_effort') &&
            !Object.prototype.hasOwnProperty.call(requestOptions, 'thinking')
        ) {
            applyReasoningToRequestBody(requestBody, resolvedProvider || {});
        }

        const timeoutMs = Number(requestedTimeoutMs);
        const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
            ? createRequestDeadline(timeoutMs, {
                parentSignal,
                code: 'PLUGIN_LLM_TIMEOUT',
                message: `Plugin LLM request timed out after ${Math.round(timeoutMs)}ms`
            })
            : null;
        const requestSignal = (deadline && deadline.signal) || parentSignal || undefined;
        const endpoint = /\/chat\/completions\/?$/i.test(apiUrl)
            ? apiUrl.replace(/\/+$/, '')
            : `${apiUrl.replace(/\/+$/, '')}/chat/completions`;

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(requestBody),
                signal: requestSignal
            });

            if (!response.ok) {
                // 读响应体（上限 2000 字）：失败给空串，绝不因读 body 把原始状态码弄丢。
                let body = '';
                try {
                    const text = await response.text();
                    body = String(text == null ? '' : text).slice(0, ERROR_BODY_MAX);
                } catch (e) { body = ''; }
                const info = extractLlmErrorInfo(body, response.headers);
                const detail = String(info.message || body || '').replace(/\s+/g, ' ').trim().slice(0, ERROR_EXCERPT_MAX);
                const error = new Error(`LLM API error: ${response.status}` + (detail ? ` — ${detail}` : ''));
                error.status = response.status;
                error.body = body;
                if (info.retryAfterMs) error.retryAfterMs = info.retryAfterMs;
                if (info.quotaResetAt) error.quotaResetAt = info.quotaResetAt;
                throw error;
            }
            const data = await response.json();
            // ADR-014：插件走的是裸 fetch，不经过 LLMClient；这里补一条 llm.usage，
            // 否则成本账本漏掉 context-compressor / persona-guard / memory-evolve 这些调用。
            // source='local' 的（本地 llama.cpp）不消耗云端周配额，doctor 的 80% 只算云。
            try {
                const usage = data && data.usage;
                if (usage) {
                    const promptLayout = require('./prompt-layout.js');
                    const r = promptLayout.cacheRate(usage);
                    // 2026-11-24：任意回环地址/端口都算本地（wb=127.0.0.1:20128），
                    // 只有出本机的调用才进云端 80% 预算。
                    const isLocal = isLoopbackUrl(apiUrl);
                    const telemetry = require('./telemetry.js');
                    telemetry.emitTelemetry({
                        cat: 'llm',
                        type: 'llm.usage',
                        title: '插件调用用量',
                        source: isLocal ? 'local' : 'plugin',
                        metrics: {
                            prompt_tokens: r.prompt == null ? 0 : r.prompt,
                            cached_tokens: r.cached == null ? 0 : r.cached,
                            prompt_cache_miss_tokens: r.miss == null ? 0 : r.miss,
                            completion_tokens: Number(usage.completion_tokens) || 0,
                            reasoning_tokens: Number(usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0,
                            has_cache_field: r.cached == null ? 0 : 1,
                            hit_rate: r.rate == null ? 0 : r.rate,
                        },
                    });
                }
            } catch (e) { /* 账本失败不影响返回 */ }
            return data.choices[0].message.content;
        } catch (error) {
            // P0-2（2026-11-25 审计）：网络层失败（fetch reject / ECONNRESET / 超时）没有
            // HTTP 状态码，旧实现只 throw、不进 llm-health —— 后台 ensureCanRun 永远放行，
            // 每个周期继续撞。HTTP 非 2xx 的错误对象（status/body/quotaResetAt）形状**不变**；
            // 429/5xx 同样在这里记一次（旧实现整条路径没有 producer，只有调用方各自记得的
            // memory-evolve 例外）。记过会打 `__llmHealthNoted`，调用方 catch 再记会被跳过。
            try {
                const apiUtils = require('../api-utils.js');
                if (apiUtils.isNetworkError(error)) {
                    apiUtils.noteLlmNetworkFailure(error);
                } else {
                    const status = Number(error && error.status) || 0;
                    if ((status === 429 || status >= 500) && !error.__llmHealthNoted) {
                        require('./llm-health.js').llmHealth.noteFailure(error);
                        try { error.__llmHealthNoted = true; } catch (e) { /* 冻结对象也无所谓 */ }
                    }
                }
            } catch (e) { /* 记账失败不影响抛错 */ }
            throw error;
        } finally {
            if (deadline) deadline.cleanup();
        }
    }

    // ===== 事件 =====

    on(event, handler) {
        eventBus.on(event, handler);
    }

    off(event, handler) {
        eventBus.off(event, handler);
    }

    emit(event, data) {
        eventBus.emit(event, data);
    }

    // ===== UI =====

    /**
     * 显示字幕
     * @param {string} text
     * @param {number} duration - 毫秒
     */
    showSubtitle(text, duration) {
        if (global.showSubtitle) global.showSubtitle(text, duration);
    }

    /**
     * 触发 Live2D 情绪动作
     * @param {string} emotion
     */
    triggerEmotion(emotion) {
        if (global.currentModel && global.currentModel.triggerEmotion) {
            global.currentModel.triggerEmotion(emotion);
        }
    }

    /**
     * 让 AI 主动说一句话（走完整 TTS 流程）
     * @param {string|Array} content - 纯文本字符串，或 OpenAI 多模态数组
     *   多模态示例：[
     *     { type: 'text', text: '你看到了什么？' },
     *     { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,...', detail: 'low' } }
     *   ]
     */
    async sendMessage(content) {
        const voiceChat = global.voiceChat;
        if (!voiceChat) return '';
        // 回传回复文本：调用方（如 live-dock）要用它判断「这次真的说出来了没有」。
        // 原来这里 return undefined，导致弹幕每次都判「生成结果为空」。
        return await voiceChat.sendToLLM(content);
    }

    /**
     * 直接让 TTS 朗读一段文字，不经过 LLM
     * @param {string} text
     */
    speakText(text) {
        const voiceChat = global.voiceChat;
        if (!voiceChat?.ttsProcessor) return;
        voiceChat.ttsProcessor.reset();
        voiceChat.ttsProcessor.processTextToSpeech(text);
    }

    // ===== 配置 =====

    /** 获取整个 config.json（**只读快照**：插件改副本不会污染宿主配置） */
    getConfig() {
        return snapshotValue(this._config);
    }

    /** 获取插件的配置（读取 plugin_config.json，兼容旧调用） */
    getPluginConfig() {
        return this.getPluginFileConfig();
    }

    /**
     * 读取插件目录下的 plugin_config.json，支持 schema 格式和旧版平铺格式
     * schema 格式：每个 key 对应 { title, description, type, default, value?, fields? }
     * 返回平铺的 { key: value } 对象，插件代码无需感知 schema 结构
     * @returns {object}
     */
    getPluginFileConfig() {
        if (!this._pluginDir) return {};
        const cfgPath = path.join(this._pluginDir, 'plugin_config.json');
        if (!fs.existsSync(cfgPath)) return {};
        try {
            const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
            return this._resolveSchema(raw);
        } catch (e) {
            this.log('warn', `plugin_config.json 读取失败: ${e.message}`);
            return {};
        }
    }

    /**
     * 将 schema 格式解析为平铺的 { key: value } 对象
     * 若值不是 schema 条目（无 type 字段），直接原样返回（兼容旧格式）
     */
    _resolveSchema(schema) {
        const result = {};
        for (const [key, def] of Object.entries(schema)) {
            if (def !== null && typeof def === 'object' && 'type' in def) {
                if (def.type === 'object' && def.fields) {
                    result[key] = this._resolveSchema(def.fields);
                } else {
                    result[key] = def.value !== undefined ? def.value : def.default;
                }
            } else {
                result[key] = def;
            }
        }
        return result;
    }

    // ===== 插件间通信 =====

    /**
     * 获取另一个插件的实例（公开 API）
     * @param {string} name
     * @returns {Plugin|null}
     */
    getPlugin(name) {
        return this._pluginManager ? this._pluginManager.getPlugin(name) : null;
    }

    /**
     * 动态注册工具（适合运行时确定工具列表的插件）
     * @param {object} toolDef - OpenAI function calling 格式
     */
    registerTool(toolDef) {
        if (this._pluginManager) {
            this._pluginManager.registerDynamicTool(this._pluginName, toolDef);
        }
    }

    /** 注销一个动态注册的工具（换 profile / 卸载时用；否则工具面只增不减）。 */
    unregisterTool(name) {
        if (this._pluginManager && typeof this._pluginManager.unregisterDynamicTool === 'function') {
            this._pluginManager.unregisterDynamicTool(this._pluginName, name);
        }
    }

    // ===== 日志 =====

    log(level, message) {
        const { logToTerminal } = require('../api-utils.js');
        logToTerminal(level, `[Plugin:${this._pluginName}] ${message}`);
    }
}

/**
 * 收集所有 volatile 补丁的文本（按 id 排序，保证每轮顺序稳定）。
 * 由 llm-handler 在发请求前调用，交给 prompt-layout 拼到最后一条 user 消息。
 * 模块级导出而不是 context 方法：补丁表本来就是全局共享的，
 * 发请求的是 llm-handler（core），不该为了读它去造一个 PluginContext。
 * @returns {string[]}
 */
function collectVolatilePromptPatches() {
    return Array.from(SHARED_PROMPT_PATCHES.entries())
        .filter(([, v]) => !!(v && v.volatile))
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .map(([, v]) => String(v.text == null ? '' : v.text).trim())
        .filter(Boolean);
}

/** 诊断用：当前补丁布局（stable / volatile 各多少个、字符数）。 */
function promptPatchLayoutStats() {
    let stable = 0;
    let volatile = 0;
    let stableChars = 0;
    let volatileChars = 0;
    SHARED_PROMPT_PATCHES.forEach((v) => {
        const n = String((v && v.text) || '').length;
        if (v && v.volatile) { volatile += 1; volatileChars += n; }
        else { stable += 1; stableChars += n; }
    });
    return { stable, volatile, stableChars, volatileChars };
}

/**
 * 插件总开关的唯一解析出口（2026-11-21）。
 *
 * 规则（按优先级）：
 *   ① enabled_plugins.json（plugin-manager → context.isPluginEnabled()）
 *      false → 关，且不再看旧开关。这是唯一真相源。
 *   ② plugin_config.enabled（兼容旧配置）：**只有显式 false 才关**，
 *      并在日志里 warn 一次「该开关已废弃，请用能力页」；显式 true 不改变结论。
 *   ③ 都没有 → 启用。
 *
 * 为什么 ② 仍然能关：旧用户把 plugin_config.enabled 设成 false 是真实意图，
 * 升级后不能突然打开（那会凭空开直播轮询 / 认知内核 tick）。所以旧显式 false 保留为
 * 「一票否决」，只警告不复用 —— 用户在能力页关掉后，再把它改回 true 即可不再看到警告。
 *
 * @param {object} context    插件 context（可为单测 mock）
 * @param {object} legacyCfg  已扁平化的 plugin_config（getPluginFileConfig 的返回值）
 * @param {string} pluginName 插件短名（仅用于日志）
 * @param {boolean} [legacyDefault=true] 仅当拿不到 manager 答案且没有 enabled 键时的旧默认值
 * @returns {boolean}
 */
function resolvePluginEnabled(context, legacyCfg, pluginName, legacyDefault = true) {
    const rawName = pluginName || (context && context._pluginName) || 'plugin';
    const shortName = String(rawName).split('/').pop();
    const cfg = (legacyCfg && typeof legacyCfg === 'object') ? legacyCfg : {};
    const hasLegacyKey = Object.prototype.hasOwnProperty.call(cfg, 'enabled');

    // ① 单一真相源：manager 的答案。只有明确的 false 才算数（true / undefined 都继续往下看）。
    let managerSays = null;
    try {
        if (context && typeof context.isPluginEnabled === 'function') {
            const v = context.isPluginEnabled();
            if (typeof v === 'boolean') managerSays = v;
        }
    } catch (e) {
        managerSays = null;
    }
    if (managerSays === false) return false;

    // ② 旧开关兼容读取：只认显式 false（显式 true 与「没写」行为一致，避免旧默认语义分叉）
    if (hasLegacyKey && cfg.enabled === false) {
        try {
            const g = (typeof globalThis === 'object' && globalThis) || global;
            const seen = g.__pluginLegacyEnabledWarned || (g.__pluginLegacyEnabledWarned = new Set());
            if (!seen.has(shortName)) {
                seen.add(shortName);
                if (context && typeof context.log === 'function') {
                    context.log('warn', `${shortName} 被 plugin_config.enabled=false 关闭（已废弃，请用能力页）`);
                }
            }
        } catch (e) { /* 日志失败不影响开关判定 */ }
        return false;
    }

    // ③ 拿不到 manager 答案（单测 mock）：退回插件的旧默认，保持历史行为
    if (managerSays === null) {
        return hasLegacyKey ? cfg.enabled !== false : legacyDefault !== false;
    }
    return true;
}

module.exports = {
    PluginContext,
    collectVolatilePromptPatches,
    promptPatchLayoutStats,
    resolvePluginEnabled,
    __test: {
        snapshotValue, deriveSystemBase, buildSystemContent, stripLastPluginBlock, stripMoodInstruction,
        extractLlmErrorInfo,
        // 回环判定是「本地=不消耗云端配额」的唯一判据，单测直接验纯函数（见
        // _probe/test-provider-fail-closed.cjs ⑤），不用每次都造一轮假请求。
        isLoopbackHost, isLoopbackUrl, urlHost,
    },
};
