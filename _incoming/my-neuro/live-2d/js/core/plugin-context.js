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
     *   provider_id: 指定提供商；留空则跟随当前全局对话模型
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

        // 优先使用插件显式指定的提供商
        if (providerId) {
            const provider = this.resolveLLM(providerId, requestedModel);
            if (provider) {
                resolvedProvider = provider;
                apiUrl = provider.api_url;
                apiKey = provider.api_key;
                model = provider.model;
            }
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

            if (!response.ok) throw new Error(`LLM API error: ${response.status}`);
            const data = await response.json();
            return data.choices[0].message.content;
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
    __test: { snapshotValue, deriveSystemBase, buildSystemContent, stripLastPluginBlock, stripMoodInstruction },
};
