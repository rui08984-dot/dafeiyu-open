// llm-provider-store.js - LLM 提供商持久化存储层
// 管理 llm_providers.json（与 config.json 同目录，含 API Key 等敏感信息，已加入 .gitignore），
// 并负责旧版 config.llm / config.vision.vision_model 的一次性迁移与清洗。
//
// 设计要点（本地定制，区别于上游 PR #219）：
//   1. 模型 ID 一律原样保存，不做任何 provider 前缀剥离（本地主用 OpenRouter，模型 ID 天然含斜杠）。
//   2. temperature_enabled / temperature / reasoning_enabled / reasoning_effort 为「模型级参数」，
//      挂在每个模型条目上；retry 等稳定性配置仍保留在 config.llm.retry 全局。
//   3. 迁移时若对话与视觉配置凭据相同（api_key + api_url 一致），合并为同一个 provider。
//
// 注意：本文件同时被 Electron 主进程（main.js）与渲染进程（config-loader）require，
// 不要引入仅渲染进程可用的依赖。

const fs = require('fs');
const path = require('path');
// 写盘复用 config-persist 的同一套「tmp+rename 原子写 + 回读校验」，不复制第二份实现。
// 注意：config-persist 只依赖 fs/http，主进程与渲染进程（config-loader 链）都可 require。
const { writeJsonVerified } = require('./config-persist.js');

// 凭据写盘失败必须发声：本文件同时跑在主进程与渲染进程，logToTerminal 不一定拿得到
// （渲染层 api-utils 依赖运行时环境），拿不到就退化为 console.error —— 绝不允许静默。
let _logToTerminal;
function reportSaveFailure(message) {
    if (_logToTerminal === undefined) {
        try {
            const apiUtils = require('../api-utils.js');
            _logToTerminal = typeof apiUtils.logToTerminal === 'function' ? apiUtils.logToTerminal : null;
        } catch (e) {
            _logToTerminal = null;
        }
    }
    try {
        if (_logToTerminal) { _logToTerminal('error', message); return; }
    } catch (e) { /* 日志通道自身异常时继续走 console */ }
    console.error(message);
}

// 模型条目上允许携带的「模型级生成参数」
const MODEL_PARAM_KEYS = ['temperature_enabled', 'temperature', 'reasoning_enabled', 'reasoning_effort'];

function getProviderStorePath(baseDir) {
    return path.join(baseDir, 'llm_providers.json');
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function cloneOptional(value) {
    return value === undefined ? undefined : clone(value);
}

function normalizeModelEntry(model) {
    if (typeof model === 'string') {
        const modelId = model.trim();
        if (!modelId) return null;
        return { model_id: modelId, name: modelId, enabled: true };
    }
    if (!model || typeof model !== 'object') return null;
    const modelId = String(model.model_id || model.id || model.name || '').trim();
    if (!modelId) return null;
    const entry = {
        ...clone(model),
        model_id: modelId,
        name: (typeof model.name === 'string' && model.name.trim()) ? model.name.trim() : modelId,
        enabled: model.enabled !== false
    };
    delete entry.id;
    return entry;
}

function normalizeProvider(provider) {
    if (!provider || typeof provider !== 'object') return null;
    const id = String(provider.id || '').trim();
    if (!id) return null;

    let rawModels = [];
    if (Array.isArray(provider.models)) {
        rawModels = provider.models;
    } else if (typeof provider.model === 'string' && provider.model.trim()) {
        // 兼容旧格式：provider.model 单字符串
        rawModels = [provider.model];
    }

    const models = [];
    const seen = new Set();
    for (const model of rawModels) {
        const entry = normalizeModelEntry(model);
        if (entry && !seen.has(entry.model_id)) {
            seen.add(entry.model_id);
            models.push(entry);
        }
    }

    const normalized = {
        id,
        name: (typeof provider.name === 'string' && provider.name.trim()) ? provider.name.trim() : id,
        api_key: typeof provider.api_key === 'string' ? provider.api_key : '',
        api_url: typeof provider.api_url === 'string' ? provider.api_url : '',
        enabled: provider.enabled !== false,
        models
    };
    if (provider.prompt_cache !== undefined) {
        normalized.prompt_cache = cloneOptional(provider.prompt_cache);
    }
    return normalized;
}

function normalizeProvidersData(rawValue) {
    const list = Array.isArray(rawValue)
        ? rawValue
        : (rawValue && Array.isArray(rawValue.providers) ? rawValue.providers : []);
    const normalized = [];
    const seen = new Set();
    for (const provider of list) {
        const entry = normalizeProvider(provider);
        if (entry && !seen.has(entry.id)) {
            seen.add(entry.id);
            normalized.push(entry);
        }
    }
    return normalized;
}

function loadProvidersFromStore(baseDir) {
    const providersPath = getProviderStorePath(baseDir);
    if (!fs.existsSync(providersPath)) {
        return { providers: [], exists: false, normalizedChanged: false, loadFailed: false };
    }
    try {
        const rawData = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
        const providers = normalizeProvidersData(rawData);
        const rawProviders = Array.isArray(rawData)
            ? rawData
            : (rawData && Array.isArray(rawData.providers) ? rawData.providers : []);
        return {
            providers,
            exists: true,
            normalizedChanged: JSON.stringify(rawProviders) !== JSON.stringify(providers),
            loadFailed: false
        };
    } catch (error) {
        console.warn(`读取 llm_providers.json 失败: ${error.message}`);
        // 文件损坏时绝不能把空数据写回覆盖用户文件
        return { providers: [], exists: true, normalizedChanged: false, loadFailed: true };
    }
}

// ===== 旧版配置迁移 =====

function hasLegacyCredentials(source) {
    if (!source || typeof source !== 'object') return false;
    return ['api_key', 'api_url'].some(key => typeof source[key] === 'string' && source[key].trim());
}

function buildLegacyLlmModelEntry(llmConfig) {
    const modelId = String(llmConfig.model_id || llmConfig.model || '').trim();
    if (!modelId) return null;
    const entry = { model_id: modelId, name: modelId, enabled: true };
    for (const key of MODEL_PARAM_KEYS) {
        if (llmConfig[key] !== undefined) {
            entry[key] = clone(llmConfig[key]);
        }
    }
    return entry;
}

function sameCredentials(a, b) {
    const keyOf = (s) => String((s && s.api_key) || '').trim();
    const urlOf = (s) => String((s && s.api_url) || '').trim().replace(/\/+$/, '');
    return keyOf(a) === keyOf(b) && urlOf(a) === urlOf(b);
}

/**
 * 从旧版 config 构建 provider 列表（仅在 store 为空时执行一次）
 * @returns {{ providers: Array, llmSelection: object|null, visionSelection: object|null }}
 */
function buildLegacyProviders(config) {
    const llmConfig = config.llm || {};
    const visionConfig = (config.vision || {}).vision_model || {};
    const providers = [];
    let llmSelection = null;
    let visionSelection = null;

    const hasLlm = hasLegacyCredentials(llmConfig);
    const hasVision = hasLegacyCredentials(visionConfig);
    const visionModelId = String(visionConfig.model_id || visionConfig.model || '').trim();

    if (hasLlm) {
        const mainProvider = {
            id: 'main',
            name: '主模型',
            api_key: llmConfig.api_key || '',
            api_url: llmConfig.api_url || '',
            enabled: true,
            models: []
        };
        const llmModel = buildLegacyLlmModelEntry(llmConfig);
        if (llmModel) {
            mainProvider.models.push(llmModel);
            llmSelection = { provider_id: 'main', model_id: llmModel.model_id };
        }
        providers.push(mainProvider);

        // 凭据相同：视觉模型并入同一 provider
        if (hasVision && sameCredentials(llmConfig, visionConfig)) {
            if (visionModelId) {
                if (!mainProvider.models.some(m => m.model_id === visionModelId)) {
                    mainProvider.models.push({ model_id: visionModelId, name: visionModelId, enabled: true });
                }
                visionSelection = { provider_id: 'main', model_id: visionModelId };
            }
            return { providers, llmSelection, visionSelection };
        }
    }

    if (hasVision) {
        providers.push({
            id: 'vision',
            name: '视觉模型',
            api_key: visionConfig.api_key || '',
            api_url: visionConfig.api_url || '',
            enabled: true,
            models: visionModelId ? [{ model_id: visionModelId, name: visionModelId, enabled: true }] : []
        });
        if (visionModelId) {
            visionSelection = { provider_id: 'vision', model_id: visionModelId };
        }
    }

    return { providers, llmSelection, visionSelection };
}

// ===== 选择校验与旧字段清洗 =====

function findProvider(providers, providerId) {
    if (!providerId) return null;
    return providers.find(p => p && p.id === providerId) || null;
}

/** 确保 provider.models 中存在指定模型（缺失则补，禁用则启用）。返回是否发生修改。 */
function ensureSelectedModelPresent(provider, modelId) {
    if (!provider || !modelId) return false;
    provider.models = Array.isArray(provider.models) ? provider.models : [];
    const existing = provider.models.find(m => m && m.model_id === modelId);
    if (existing) {
        if (existing.enabled === false) {
            existing.enabled = true;
            return true;
        }
        return false;
    }
    provider.models.push({ model_id: modelId, name: modelId, enabled: true });
    return true;
}

function firstEnabledSelection(providers) {
    for (const provider of providers) {
        if (!provider || provider.enabled === false) continue;
        const models = Array.isArray(provider.models) ? provider.models : [];
        const model = models.find(m => m && m.enabled !== false) || models[0];
        if (model) {
            return { provider_id: provider.id, model_id: model.model_id };
        }
    }
    return null;
}

/**
 * 应用迁移得到的选择、修正失效引用，并清洗 config 中的旧版敏感字段。
 * 直接修改传入的 config / providers。
 * @returns {{ configChanged: boolean, providersChanged: boolean }}
 */
function applySelectionsAndScrub(config, providers, selections) {
    let configChanged = false;
    let providersChanged = false;

    if (!config.llm || typeof config.llm !== 'object') {
        config.llm = {};
        configChanged = true;
    }
    if (!config.vision || typeof config.vision !== 'object') {
        config.vision = {};
        configChanged = true;
    }
    const llmConfig = config.llm;
    const visionConfig = config.vision;

    // ---- 对话模型选择 ----
    if (!llmConfig.provider_id && selections.llmSelection) {
        llmConfig.provider_id = selections.llmSelection.provider_id;
        llmConfig.model_id = selections.llmSelection.model_id;
        configChanged = true;
    }
    let llmProvider = findProvider(providers, llmConfig.provider_id);
    if (llmProvider) {
        const modelId = String(llmConfig.model_id || '').trim();
        if (modelId) {
            if (ensureSelectedModelPresent(llmProvider, modelId)) {
                providersChanged = true;
            }
        } else {
            const fallback = firstEnabledSelection([llmProvider]);
            if (fallback) {
                llmConfig.model_id = fallback.model_id;
                configChanged = true;
            }
        }
    } else if (llmConfig.provider_id) {
        // 引用的 provider 不存在：回退到第一个可用 provider/model
        const fallback = firstEnabledSelection(providers);
        llmConfig.provider_id = fallback ? fallback.provider_id : '';
        llmConfig.model_id = fallback ? fallback.model_id : '';
        configChanged = true;
    } else if (providers.length > 0) {
        // 完全未配置选择：默认指向第一个可用 provider/model
        const fallback = firstEnabledSelection(providers);
        if (fallback) {
            llmConfig.provider_id = fallback.provider_id;
            llmConfig.model_id = fallback.model_id;
            configChanged = true;
        }
    }

    // ---- 视觉模型选择 ----
    if (!visionConfig.provider_id && selections.visionSelection) {
        visionConfig.provider_id = selections.visionSelection.provider_id;
        visionConfig.model_id = selections.visionSelection.model_id;
        configChanged = true;
    }
    const visionProvider = findProvider(providers, visionConfig.provider_id);
    if (visionProvider) {
        const modelId = String(visionConfig.model_id || '').trim();
        if (modelId && ensureSelectedModelPresent(visionProvider, modelId)) {
            providersChanged = true;
        }
    } else if (visionConfig.provider_id) {
        // 视觉引用失效：直接清空（视觉是可选功能，不强行回退）
        visionConfig.provider_id = '';
        visionConfig.model_id = '';
        configChanged = true;
    }

    // ---- 清洗 config.llm 旧字段（api_key/api_url 置空保留键，生成参数迁至模型级后删除）----
    if (llmConfig.api_key) {
        llmConfig.api_key = '';
        configChanged = true;
    }
    if (llmConfig.api_url) {
        llmConfig.api_url = '';
        configChanged = true;
    }
    for (const key of ['model', ...MODEL_PARAM_KEYS]) {
        if (Object.prototype.hasOwnProperty.call(llmConfig, key)) {
            delete llmConfig[key];
            configChanged = true;
        }
    }

    // ---- 清洗 config.vision.vision_model ----
    // 只在视觉凭据已经迁进通讯录之后才清空，避免只有 model、或 key/url 为空时把配置抹掉。
    const visionMigrated = Boolean(
        visionConfig.provider_id && findProvider(providers, visionConfig.provider_id)
    );
    if (visionMigrated && visionConfig.vision_model && Object.keys(visionConfig.vision_model).length > 0) {
        visionConfig.vision_model = {};
        configChanged = true;
    }

    return { configChanged, providersChanged };
}

// ===== 对外接口 =====

/**
 * 读取/迁移/规范化 provider 数据，并把结果注入 config.llm_providers（仅内存）。
 * 不直接写盘；写盘由 persistProviderStore 决定。
 */
/**
 * 把 UI 送来的通讯录快照合并进磁盘上的那份。
 *
 * 为什么必须有这一步（2026-11-18 §70 修的 P0）：
 *   原实现 `let providers = storeState.providers` —— 只要 store 文件非空，
 *   就**彻底不看** `config.llm_providers`。而控制中心「模型配置」页保存时是把
 *   整份通讯录（含密钥）随 config 送回的（`__llm_providers` → `config.llm_providers`）。
 *   于是：用户在 UI 里改了 API key → 保存 → saveHostConfig 返回 ok:true、
 *   provider.storeChanged=false → **磁盘上还是旧 key**，界面显示「已保存」。
 *   实测：11-07 之后 key 再没变过（sha8 ff52c872 一直是那一个），每次「换 key」
 *   都被这里静默丢弃，而没有任何错误。
 *
 * 合并规则（两条都不能少）：
 *   ① 以磁盘为基线保序，按 id upsert 快照里的条目 —— UI 不知道的 provider 不会被删；
 *   ② **凭据保护**：快照里 api_key/api_url 为空或是脱敏占位时，保留磁盘上的真实值。
 *      （反向教训见 2026-11-16：能力开关保存时把 url/key 覆盖成空串，LLM 全线 Failed to fetch。）
 *
 * @param {Array<object>} current  磁盘上的通讯录（已 normalize）
 * @param {Array<object>} incoming UI 快照（已 normalize）
 * @returns {{providers:Array<object>, changed:boolean}}
 */
const MASKED_PLACEHOLDER = /^(?:<已脱敏>|＜已脱敏＞|\*+|•+)$/;
function isBlankCredential(value) {
    const text = String(value == null ? '' : value).trim();
    return text === '' || MASKED_PLACEHOLDER.test(text);
}

function mergeProviderSnapshot(current, incoming) {
    const merged = Array.isArray(current) ? current.map((item) => clone(item)) : [];
    let changed = false;
    for (const next of (Array.isArray(incoming) ? incoming : [])) {
        if (!next || !next.id) continue;
        const index = merged.findIndex((item) => item.id === next.id);
        if (index < 0) { merged.push(clone(next)); changed = true; continue; }
        const cur = merged[index];
        const candidate = Object.assign(clone(cur), clone(next));
        if (isBlankCredential(next.api_key)) candidate.api_key = cur.api_key;
        if (isBlankCredential(next.api_url)) candidate.api_url = cur.api_url;
        if (JSON.stringify(candidate) !== JSON.stringify(cur)) { merged[index] = candidate; changed = true; }
    }
    return { providers: merged, changed };
}

function ensureProviderStore(baseDir, config) {
    const storeState = loadProvidersFromStore(baseDir);

    if (storeState.loadFailed) {
        // 文件损坏：仅用 config 内联数据兜底，本次禁止写 store，避免覆盖用户文件
        const inline = normalizeProvidersData(config.llm_providers);
        config.llm_providers = inline;
        return { providers: inline, storeChanged: false, configChanged: false, migrated: false, storeWritable: false };
    }

    let providers = storeState.providers;
    let storeChanged = storeState.normalizedChanged;
    let migrated = false;
    let selections = { llmSelection: null, visionSelection: null };

    // ① UI 送回的快照必须落地（store 非空时也要合并，见 mergeProviderSnapshot 注释）
    const inlineProviders = normalizeProvidersData(config.llm_providers);
    if (inlineProviders.length > 0) {
        if (providers.length === 0) {
            providers = inlineProviders;
            storeChanged = true;
        } else {
            const merged = mergeProviderSnapshot(providers, inlineProviders);
            providers = merged.providers;
            if (merged.changed) storeChanged = true;
        }
    }
    if (providers.length === 0) {
        const legacy = buildLegacyProviders(config);
        if (legacy.providers.length > 0) {
            providers = normalizeProvidersData(legacy.providers);
            selections = legacy;
            storeChanged = true;
            migrated = true;
        }
    }

    const scrubResult = applySelectionsAndScrub(config, providers, selections);
    config.llm_providers = providers;

    return {
        providers,
        storeChanged: storeChanged || scrubResult.providersChanged,
        configChanged: scrubResult.configChanged,
        migrated,
        storeWritable: true
    };
}

/**
 * 保存 provider 通讯录（内含云端 LLM 的 api_url / api_key）。
 *
 * 2026-11-17 加固：原来这里是一行裸 writeFileSync —— 写失败就抛异常（调用点有的 catch 有的不 catch），
 * 更糟的是「写盘成功」不等于「宿主读到新凭据」。现在统一走 config-persist.writeJsonVerified：
 *   · 同目录 .tmp + rename 原子替换，避免写一半留下半个 JSON
 *   · 写后 JSON.parse 回读 + 顶层键数校验，序列化丢字段会在返回值里暴露
 *   · 失败必定发声（logToTerminal('error') 或 console.error）并返回结构化结果，不再静默/不再抛
 *
 * @param {string} baseDir - llm_providers.json 所在目录（即 live-2d 根目录）
 * @param {Array} providers - provider 列表（会先 normalize）
 * @returns {{ok:boolean, wrote:boolean, file:string, error?:string}}
 *   向后兼容：旧调用点忽略返回值不受影响；原先依赖它抛异常的调用点见 persistProviderStore
 */
function saveProviders(baseDir, providers) {
    const providersPath = getProviderStorePath(baseDir);
    // 目录本身不存在时，writeJsonVerified 会在写 .tmp 时失败并返回结构化错误，
    // 不会像旧实现那样抛 ENOENT 出去 —— 调用方拿 ok:false 即可。
    const payload = { providers: normalizeProvidersData(providers) };
    const write = writeJsonVerified(providersPath, payload);
    if (!write.ok) {
        const error = write.error || '未知原因';
        reportSaveFailure(`保存 llm_providers.json 失败（云端凭据未落盘，宿主可能继续使用旧 key）: ${error}`);
        return { ok: false, wrote: false, file: providersPath, error };
    }
    return { ok: true, wrote: true, file: providersPath };
}

/**
 * 完整的「加载 → 迁移 → 清洗 → 持久化」流程。
 * @param {string} baseDir - llm_providers.json 所在目录（即 live-2d 根目录）
 * @param {string|null} configPath - config.json 路径；首次迁移时据此备份
 * @param {object} config - 已解析的 config 对象（会被原地修改：清洗旧字段 + 注入 llm_providers）
 * @param {{ writeBack?: boolean }} [options] - writeBack 默认 true；false 时不把清洗结果写回 config.json
 */
function persistProviderStore(baseDir, configPath, config, options = {}) {
    const writeBack = options.writeBack !== false;
    const result = ensureProviderStore(baseDir, config);

    // 首次迁移前备份 config.json（仅一次）
    if (result.migrated && configPath && fs.existsSync(configPath)) {
        const backupPath = `${configPath}.pre-provider.bak`;
        if (!fs.existsSync(backupPath)) {
            try {
                fs.copyFileSync(configPath, backupPath);
                console.log(`已备份迁移前配置: ${backupPath}`);
            } catch (error) {
                console.warn(`备份迁移前配置失败: ${error.message}`);
            }
        }
    }

    if (result.storeWritable && result.storeChanged) {
        // saveProviders 不再抛异常：失败已由它自己 logToTerminal('error')/console.error 发声，
        // 并把错误挂在返回值上；这里顺手透出给 persistProviderStore 的调用方。
        const saved = saveProviders(baseDir, result.providers);
        if (!saved.ok) result.storeSaveError = saved.error;
    }

    if (writeBack && configPath && result.configChanged) {
        // 走唯一写盘入口（2026-11-18 §69 B1/B2）：原子写 + 回读校验 + 失败发声。
        // 这个分支目前没有调用方（config-loader 与 saveHostConfig 都传 writeBack:false，
        // 由它们各自统一写盘），但它是公开选项的默认值 —— 留着裸写等于给下一个调用方埋雷。
        const persistable = clone(config);
        try { delete persistable.llm_providers; } catch { /* 非普通对象上游已拦 */ }
        const wrote = writeJsonVerified(configPath, persistable);
        if (!wrote.ok) {
            result.configWriteBackError = wrote.error;
            console.error(`写回 config.json 失败: ${wrote.error}`);
        }
    }

    return result;
}

module.exports = {
    MODEL_PARAM_KEYS,
    getProviderStorePath,
    normalizeProvidersData,
    loadProvidersFromStore,
    ensureProviderStore,
    saveProviders,
    persistProviderStore
};
