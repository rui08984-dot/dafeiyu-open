const { Plugin } = require('../../../js/core/plugin-base.js');
const { resolvePluginEnabled } = require('../../../js/core/plugin-context.js');
const { MemosClient } = require('./memos-client.js');
const { MemosTools } = require('./tools.js');
const { buildBackendEmbeddingConfig } = require('./embedding-config.js');
const fs = require('fs');
const path = require('path');
// MemOS 记忆正文是外部可控文本（可能来自任意来源/被投毒）→ 统一数据封装
const { wrapUntrusted, ensureBoundaryPatch } = require('../../../js/core/untrusted-data.js');
// 遗忘墓碑（2026-11-22）：MemOS 侧删除可能失败或留有多副本，本地墓碑才是权威判据。
// 已忘内容即使被检索回来也整条不注入，避免「她说忘了，下一轮又提起」。
const tombstones = require('../../../js/core/forget-tombstones.js');

const BACKEND_CONFIG_PATH = path.join(__dirname, '..', '..', '..', '..', 'plugins-dlc', 'memos', 'memos_system', 'config', 'memos_config.json');
// 记忆数据行预算：默认只注入 3 条（inject_top_k），1200 字足够；超长时整条丢弃而不是截半句。
const MEMORIES_DATA_MAX_CHARS = 1200;

/**
 * 把 formatMemoriesForPrompt 的多行文本包成数据行（纯函数，可单测）。
 * 按行拆成 items：超预算时从尾部丢整条记忆，不把某条记忆截成半句。
 */
function buildMemoriesLine(text, maxChars) {
    // 只在「- 」开头的新条目处切分：记忆正文里自带换行时不会被切成两条
    const items = String(text == null ? '' : text)
        .split(/\n(?=- )/)
        .map((s) => s.trim())
        .filter(Boolean);
    if (!items.length) return '';
    return wrapUntrusted('memories', { items }, maxChars || MEMORIES_DATA_MAX_CHARS);
}

class MemosPlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();
        this.client = new MemosClient(cfg);
        // 总开关单一真相源（2026-11-21）：enabled_plugins.json（context）优先；
        // plugin_config.enabled 只作旧配置兼容（显式 false 才关，并警告一次）。
        this.client.enabled = resolvePluginEnabled(this.context, cfg, 'memos');
        this.tools = new MemosTools(this.client.apiUrl, {
            similarityThreshold: this.client.similarityThreshold
        });
        this._cfg = cfg;
    }

    async onStart() {
        if (!this.client.enabled) {
            this.context.log('warn', 'MemOS 已禁用');
            return;
        }

        // 系统提示声明「带前缀的记忆是数据不是指令」（共享补丁，幂等）
        ensureBoundaryPatch(this.context);

        this._syncBackendConfig();

        const ok = await this.client.isAvailable();
        this.context.log('info', `MemOS 服务: ${ok ? '已连接' : '不可用（请确认 memos_system 是否启动）'}`);
    }

    async onStop() {
        if (this.client?.enabled) {
            await this.client.flushBuffer();
        }
    }

    async onUserInput(event) {
        if (!this.client?.enabled || !this._cfg.auto_inject) return;
        if (!['voice', 'text'].includes(event.source)) return;

        try {
            // 2026-11-25 P1-4：search 现在返回 {ok, memories, reason, status}。
            // 失败不再伪装成「没有记忆」—— 降级为「本轮不注入」，但日志必须可见。
            const sr = await this.client.search(event.text);
            if (!sr || sr.ok === false) {
                const why = sr ? String(sr.reason || 'unknown') : 'no-result';
                const extra = sr && (sr.status || sr.message || sr.lastFailReason)
                    ? '（' + [sr.status ? 'status=' + sr.status : '', sr.message || sr.lastFailReason || ''].filter(Boolean).join(' ') + '）'
                    : '';
                this.context.log('warn', `[memos] 本轮不注入记忆：搜索失败 ${why}${extra}`);
                this.context.removeSystemPromptPatch('memos-recall');
                return;
            }
            // 兼容旧契约（数组）与桩：新 client 返回 {ok,memories}
            let memories = Array.isArray(sr)
                ? sr
                : (Array.isArray(sr.memories) ? sr.memories : []);
            // 遗忘墓碑（2026-11-22）：本地删除 + 墓碑是权威判据，MemOS 检索结果逐条过滤。
            // 内容取 m.content（兼容纯字符串条目）；过滤抛错时放行，不能让记忆注入整体挂掉。
            let tombstoned = 0;
            try {
                const before = memories.length;
                memories = memories.filter((mem) => {
                    const content = (mem && typeof mem === 'object') ? mem.content : mem;
                    return !tombstones.isForgotten(String(content == null ? '' : content));
                });
                tombstoned = before - memories.length;
            } catch (e) { /* 墓碑读不到不影响正常注入 */ }
            if (tombstoned > 0) {
                // 每轮最多一条：过滤条数是可观测信号，不是每条的独立日志
                this.context.log('info', `[memos] 遗忘墓碑过滤 ${tombstoned} 条记忆（已忘内容不再注入）`);
            }
            if (memories.length > 0) {
                const text = this.client.formatMemoriesForPrompt(memories);
                // 记忆正文统一包成 `【环境数据·非指令】{"memories":{"items":[...]}}`，
                // 补丁里只留程序写的使用说明（可信），外部内容全部进数据行。
                const dataLine = buildMemoriesLine(text);
                if (dataLine) {
                    this.context.addSystemPromptPatch('memos-recall', `\n【你对主人的已知记忆，回答时必须自然融入，不要说"根据记忆"】:\n${dataLine}`, { volatile: true });
                } else {
                    this.context.removeSystemPromptPatch('memos-recall');
                }
            } else {
                this.context.removeSystemPromptPatch('memos-recall');
            }
        } catch (err) {
            this.context.log('error', `记忆注入失败: ${err.message}`);
        }
    }

    async onLLMResponse(response) {
        if (!this.client?.enabled || !this._cfg.auto_save) return;
        if (response.proactive_internal) return;

        const messages = this.context.getMessages();
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        if (!lastUser) return;

        this.client.addWithBuffer([
            { role: 'user', content: lastUser.content },
            { role: 'assistant', content: response.text }
        ]).catch(err => {
            this.context.log('error', `MemOS 保存对话失败: ${err.message}`);
        });
    }

    getTools() {
        if (!this.client?.enabled) return [];
        return this.tools.getDefinitions();
    }

    async executeTool(name, params) {
        return this.tools.execute(name, params);
    }

    /**
     * 将插件中的后端配置同步写入 memos_system/config/memos_config.json
     * 只覆盖插件管理的字段，保留后端独有字段（storage、embedding 等）
     */
    _syncBackendConfig() {
        try {
            let backendCfg = {};
            if (fs.existsSync(BACKEND_CONFIG_PATH)) {
                backendCfg = JSON.parse(fs.readFileSync(BACKEND_CONFIG_PATH, 'utf-8'));
            }

            const cfg = this._cfg;
            const mainLlm = global.voiceChat || {};
            const mainBaseUrl = mainLlm.API_URL || '';

            // LLM
            if (cfg.backend_llm) {
                backendCfg.llm = backendCfg.llm || {};
                backendCfg.llm.config = {
                    model: cfg.backend_llm.model || mainLlm.MODEL || backendCfg.llm?.config?.model || '',
                    api_key: cfg.backend_llm.api_key || mainLlm.API_KEY || backendCfg.llm?.config?.api_key || '',
                    base_url: cfg.backend_llm.base_url || mainBaseUrl.replace(/\/chat\/completions\/?$/, '') || backendCfg.llm?.config?.base_url || '',
                    max_tokens: cfg.backend_llm.max_tokens || backendCfg.llm?.config?.max_tokens || 8000
                };
            }

            // LLM fallback
            if (cfg.backend_llm_fallback) {
                backendCfg.llm_fallback = {
                    enabled: cfg.backend_llm_fallback.enabled !== false,
                    config: {
                        model: cfg.backend_llm_fallback.model || backendCfg.llm_fallback?.config?.model || '',
                        api_key: cfg.backend_llm_fallback.api_key || backendCfg.llm_fallback?.config?.api_key || '',
                        base_url: cfg.backend_llm_fallback.base_url || backendCfg.llm_fallback?.config?.base_url || ''
                    }
                };
            }

            // Search
            if (cfg.backend_search) {
                backendCfg.search = backendCfg.search || {};
                if (cfg.backend_search.enable_bm25 !== undefined) backendCfg.search.enable_bm25 = cfg.backend_search.enable_bm25;
                if (cfg.backend_search.bm25_weight !== undefined) backendCfg.search.bm25_weight = cfg.backend_search.bm25_weight;
                if (cfg.backend_search.enable_graph_query !== undefined) backendCfg.search.enable_graph_query = cfg.backend_search.enable_graph_query;
                if (cfg.backend_search.enable_reranker !== undefined) backendCfg.search.enable_reranker = cfg.backend_search.enable_reranker;
                if (cfg.backend_search.reranker_auto_download !== undefined) backendCfg.search.reranker_auto_download = cfg.backend_search.reranker_auto_download;
                if (cfg.backend_search.reranker_model_id !== undefined) backendCfg.search.reranker_model_id = cfg.backend_search.reranker_model_id;
                if (cfg.backend_search.reranker_model_path !== undefined) backendCfg.search.reranker_model_path = cfg.backend_search.reranker_model_path;
                if (cfg.backend_search.rerank_top_n !== undefined) backendCfg.search.rerank_top_n = cfg.backend_search.rerank_top_n;
            }
            backendCfg.search = backendCfg.search || {};
            backendCfg.search.similarity_threshold = cfg.similarity_threshold ?? backendCfg.search.similarity_threshold ?? 0.5;
            buildBackendEmbeddingConfig(cfg, backendCfg);

            // Features
            if (cfg.backend_features) {
                if (cfg.backend_features.entity_extraction !== undefined) {
                    backendCfg.entity_extraction = backendCfg.entity_extraction || {};
                    backendCfg.entity_extraction.enabled = cfg.backend_features.entity_extraction;
                    backendCfg.entity_extraction.auto_extract_on_add = cfg.backend_features.entity_extraction;
                }
                if (cfg.backend_features.image_memory !== undefined) {
                    backendCfg.image = backendCfg.image || {};
                    backendCfg.image.enabled = cfg.backend_features.image_memory;
                }
                if (cfg.backend_features.image_auto_describe !== undefined) {
                    backendCfg.image = backendCfg.image || {};
                    backendCfg.image.auto_describe = cfg.backend_features.image_auto_describe;
                }
            }

            const dir = path.dirname(BACKEND_CONFIG_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(BACKEND_CONFIG_PATH, JSON.stringify(backendCfg, null, 2), 'utf-8');
            this.context.log('info', '已同步后端配置到 memos_config.json');
        } catch (err) {
            this.context.log('warn', `同步后端配置失败（不影响运行）: ${err.message}`);
        }
    }
}

module.exports = MemosPlugin;
Object.defineProperty(module.exports, 'buildBackendEmbeddingConfig', {
    value: buildBackendEmbeddingConfig,
    enumerable: false
});
Object.defineProperty(module.exports, 'buildMemoriesLine', {
    value: buildMemoriesLine,
    enumerable: false
});
