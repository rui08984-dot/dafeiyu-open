'use strict';
// js/components/setup/memory.js —— 记忆组件安装后配置（2026-11-27 v0.4.0）
//
// 为什么需要：MemOS 的 memos_config.json 里有两处必须落到「这台机器/这个用户」：
//   ① embedding → 本机 8090（llama.cpp + Qwen3-Embedding，组件自带）
//   ② llm.config → 用户自己的云 provider（我们不随包任何 key；也不随包 4B 本地模型）
// 安装器（components manager）在文件就绪后调用 run(ctx) 写这两处；失败必须发声。
//
// 找不到用户 key 时不判失败：写空值 + warning（聊天/记忆其余部分仍可用），
// 用户填好 key 后在组件页再点一次「安装」即可重新写入（幂等）。

const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function atomicWrite(file, obj) {
    const text = JSON.stringify(obj, null, 2) + '\n';
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
}

function pickProvider(config, providersDoc) {
    const list = providersDoc && Array.isArray(providersDoc.providers) ? providersDoc.providers : [];
    if (!list.length) return null;
    const wanted = String((config && config.llm && config.llm.provider_id) || '').trim();
    let p = wanted ? list.find((x) => x && x.id === wanted) : null;
    if (!p) p = list.find((x) => x && x.enabled !== false) || list[0] || null;
    return p || null;
}

function run(ctx = {}) {
    const root = ctx.root;
    const dir = ctx.dir;
    if (!root || !dir) return { ok: false, error: '缺少 ctx.root/ctx.dir' };
    const memosCfg = path.join(dir, 'memos', 'memos_system', 'config', 'memos_config.json');
    const example = path.join(dir, 'memos', 'memos_system', 'config', 'memos_config.example.json');
    let doc = readJson(memosCfg, null) || readJson(example, null);
    if (!doc) return { ok: false, error: '找不到 memos_config 模板：' + example };

    // ① 嵌入：本机 8090（组件自带 llama.cpp + Qwen3-Embedding Q8）
    doc.embedding = doc.embedding || {};
    doc.embedding.provider = 'api';
    doc.embedding.use_api = true;
    doc.embedding.vector_size = 1024;
    doc.embedding.api = Object.assign({}, doc.embedding.api || {}, {
        base_url: 'http://127.0.0.1:8090/v1',
        model: 'qwen3-embed',
        api_key: 'local',
    });
    if (doc.storage && doc.storage.vector) {
        doc.storage.vector.type = 'qdrant';
        doc.storage.vector.path = './data/qdrant';
        doc.storage.vector.vector_size = 1024;
    }

    // ② 抽取 LLM：用户当前的云 provider（不随包 key）
    const appDir = path.join(root, 'resources', 'app');
    const provPath = path.join(appDir, 'llm_providers.json');
    const providers = readJson(provPath, null);
    const config = ctx.config || readJson(path.join(appDir, 'config.json'), {}) || {};
    const provider = pickProvider(config, providers);
    const key = provider ? String(provider.api_key || '').trim() : '';
    const model = provider ? String((provider.models && provider.models[0] && provider.models[0].model_id) || '') : '';
    doc.llm = doc.llm || {};
    doc.llm.config = {
        model: model || String((config.llm && config.llm.model_id) || ''),
        api_key: key,
        base_url: provider ? String(provider.api_url || '') : '',
        max_tokens: 2048,
    };
    doc.llm_fallback = doc.llm_fallback || { enabled: false };
    doc.llm_fallback.enabled = false;

    // 备份后原子写
    try {
        if (fs.existsSync(memosCfg)) {
            fs.copyFileSync(memosCfg, memosCfg + '.bak-components-' + new Date().toISOString().replace(/[:.]/g, '-'));
        }
    } catch (e) { /* 备份失败不阻断 */ }
    atomicWrite(memosCfg, doc);

    if (!key) {
        return {
            ok: true,
            warning: '还没有 API key：memos_config 的 llm.config 先留空；填好 key 后到组件页再点一次「安装」即可写入',
            path: memosCfg,
        };
    }
    return { ok: true, path: memosCfg, provider: provider.id, model: doc.llm.config.model };
}

module.exports = { run };
