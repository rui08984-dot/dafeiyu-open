'use strict';
// js/components/setup/local-memory.js —— 本地记忆模型组件安装后配置（2026-11-27 v0.5.0）
//
// 为什么需要：local-memory 组件只落了一个外部 GGUF + 一条 service 定义；要让宿主
// 真正「接上」，还差三处配置（都按 dev 现状对齐）：
//   ① llm_providers.json 新增/更新 provider `local-memory`（127.0.0.1:11435/v1 · MemOperator-4B）
//      —— js/core/local-llm.js 解析本地连接时优先读它（resolveProviderOrFallback）。
//   ② config.json 的 cost.local_memory = true（能力页开关，默认开；fragment 的 config
//      补丁也会写一次，这里再兜底：用户日后重装 memory 组件时它会把这键翻回 false）。
//   ③ 若 memory 组件已装：memos_config.json 的 llm.config 改到本地 11435/该模型
//      （dev 的 memos_config.example.json 同款：MemOperator-4B + max_tokens 2048）。
//      只动 llm.config / llm_fallback.enabled；embedding 归 memory 组件自己的 setup 管。
//
// 纪律（与 setup/memory.js 同一套）：读不到就不判失败（warning + 幂等重跑）；
// 所有写盘先备份、tmp+rename 原子写；内容没变不写（不产生垃圾备份）。

const fs = require('fs');
const path = require('path');

const PROVIDER_ID = 'local-memory';
const MODEL_ID = 'MemOperator-4B';   // 必须与 service cmd 的 `-a MemOperator-4B` 一致
const API_URL = 'http://127.0.0.1:11435/v1';
const API_KEY = 'local';             // llama.cpp 不校验 key，占位即可

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function atomicWrite(file, obj) {
    const text = JSON.stringify(obj, null, 2) + '\n';
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { /* 已存在/并发创建 */ }
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
}
function backup(file) {
    try {
        if (fs.existsSync(file)) {
            fs.copyFileSync(file, file + '.bak-local-memory-' + new Date().toISOString().replace(/[:.]/g, '-'));
            return true;
        }
    } catch (e) { /* 备份失败不阻断（下面仍是原子写） */ }
    return false;
}

/** 与 manager.appConfigPath 同口径：安装版 resources/app，开发树 live-2d。 */
function appDirOf(root) {
    const packaged = path.join(root, 'resources', 'app');
    if (fs.existsSync(path.join(packaged, 'config.json'))) return packaged;
    const dev = path.join(root, '_incoming', 'my-neuro', 'live-2d');
    if (fs.existsSync(path.join(dev, 'config.json'))) return dev;
    return packaged;
}

function canonicalModel() {
    return {
        model_id: MODEL_ID,
        name: MODEL_ID + '（本地 · 28K）',
        enabled: true,
        reasoning_enabled: false,
        temperature_enabled: false,
    };
}

/** ① llm_providers.json：新增/更新 local-memory provider（保序、不碰其他 provider）。 */
function upsertProvider(provPath) {
    const warnings = [];
    const raw = readJson(provPath, null);
    const isArray = Array.isArray(raw);
    if (!raw) {
        // 文件还没有（首次启动前）：只建本组件的一条，别替用户发明云端 provider
        warnings.push('llm_providers.json 不存在（首次启动后 app 会补全），已创建只含 ' + PROVIDER_ID + ' 的初始文件');
    }
    const list = isArray ? raw : (Array.isArray(raw && raw.providers) ? raw.providers : []);
    let p = null;
    for (const x of list) { if (x && x.id === PROVIDER_ID) { p = x; break; } }
    if (!p) {
        p = { id: PROVIDER_ID, name: '本地记忆模型（llama.cpp · MemOperator-4B）', api_key: API_KEY, api_url: API_URL, enabled: true, models: [] };
        list.push(p);
    }
    p.name = (p.name && String(p.name).trim()) ? p.name : '本地记忆模型（llama.cpp · MemOperator-4B）';
    p.api_url = API_URL;
    p.api_key = API_KEY;
    p.enabled = true;
    const models = Array.isArray(p.models) ? p.models : [];
    const found = models.find((m) => m && (typeof m === 'string' ? m.trim() === MODEL_ID : m.model_id === MODEL_ID));
    if (!found) {
        models.push(canonicalModel());
        p.models = models;
    } else if (typeof found === 'object') {
        found.enabled = true;   // 其他模型级参数（temperature 等）不动
    }
    const doc = isArray ? list : Object.assign({}, raw, { providers: list });
    return { doc, warnings };
}

/** ② config.json：cost.local_memory = true（只在缺失/false 时写）。 */
function ensureConfigFlag(cfgPath) {
    const cfg = readJson(cfgPath, null);
    if (!cfg) return { changed: false, error: 'config.json 缺失或不可解析：' + cfgPath };
    if (!cfg.cost || typeof cfg.cost !== 'object') cfg.cost = {};
    if (cfg.cost.local_memory === true) return { changed: false };
    cfg.cost.local_memory = true;
    return { changed: true, doc: cfg };
}

/** ③ memos_config.json：llm.config → 本地 11435（memory 组件已装才动）。 */
function patchMemosConfig(memosCfg) {
    if (!fs.existsSync(memosCfg)) return { changed: false, skip: 'memory 组件未安装（找不到 memos_config.json）' };
    const example = path.join(path.dirname(memosCfg), 'memos_config.example.json');
    const doc = readJson(memosCfg, null) || readJson(example, null);
    if (!doc) return { changed: false, skip: 'memos_config.json 不可解析且无 example 模板' };
    // 变更前快照：重跑时内容一致就不写盘（memory.js 那份是每次都写，这里更保守）
    const before = JSON.stringify(doc, null, 2);
    doc.llm = doc.llm || {};
    doc.llm.config = {
        model: MODEL_ID,
        api_key: API_KEY,
        base_url: API_URL,
        max_tokens: 2048,
    };
    doc.llm_fallback = doc.llm_fallback || { enabled: false };
    doc.llm_fallback.enabled = false;
    if (JSON.stringify(doc, null, 2) === before) return { changed: false };
    return { changed: true, doc };
}

function run(ctx = {}) {
    const root = ctx.root;
    if (!root) return { ok: false, error: '缺少 ctx.root' };
    const appDir = appDirOf(root);
    const provPath = path.join(appDir, 'llm_providers.json');
    const cfgPath = path.join(appDir, 'config.json');
    const memosCfg = path.join(root, 'components', 'memory', 'memos', 'memos_system', 'config', 'memos_config.json');

    const changed = [];
    const warnings = [];

    // ① provider
    const prov = upsertProvider(provPath);
    warnings.push.apply(warnings, prov.warnings);
    if (JSON.stringify(readJson(provPath, null)) !== JSON.stringify(prov.doc)) {
        backup(provPath);
        atomicWrite(provPath, prov.doc);
        changed.push(path.relative(root, provPath) || provPath);
    }

    // ② cost.local_memory
    const flag = ensureConfigFlag(cfgPath);
    if (flag.error) warnings.push('config.json：' + flag.error);
    if (flag.changed) {
        backup(cfgPath);
        atomicWrite(cfgPath, flag.doc);
        changed.push((path.relative(root, cfgPath) || cfgPath) + ' → cost.local_memory=true');
    }

    // ③ MemOS 抽取 LLM → 本地
    const memos = patchMemosConfig(memosCfg);
    if (memos.skip) warnings.push('memos_config：' + memos.skip);
    if (memos.changed) {
        backup(memosCfg);
        atomicWrite(memosCfg, memos.doc);
        changed.push((path.relative(root, memosCfg) || memosCfg) + ' → llm.config=11435/' + MODEL_ID);
    }

    return {
        ok: true,
        provider: PROVIDER_ID,
        model: MODEL_ID,
        apiUrl: API_URL,
        changed,
        warnings,
        memo: changed.length ? '改了 ' + changed.length + ' 处；重复安装是幂等的（无变化不写盘）' : '配置已是目标状态，无需改动',
    };
}

module.exports = { run };
