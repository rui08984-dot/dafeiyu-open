'use strict';
// first-run.js —— 首启判定（纯函数，无 Electron 依赖）
//
// 背景（2026-11-26 安装包 A）：公开 NSIS 安装包只带 live-2d 本体 + 一份空白 provider。
// 用户没填 key 时宿主不能装作可用：启动后自动打开控制中心「模型」页，让他把
// 接口地址 / 密钥 / 模型填进去（保存链路走 /reload-config，不用重启）。
//
// 判定口径（宁松勿紧：误报只会多开一次设置窗，漏报会让陌生人对着不说话的桌宠发呆）：
//   · 当前 provider 有非占位 key            → 已配置
//   · provider 是本地/内网端点（无需 key）  → 已配置
//   · provider 是 ollama                    → 已配置
//   · 其它（无文件/空 key/占位符）          → 需要首启引导
//
// 这个文件被主进程 require，也被 _probe 单测直接 require —— 不要引入 app/global 依赖。

const PLACEHOLDER_PATTERNS = [
    /^\s*$/,
    /^<.*>\s*$/,                 // <填你的密钥>
    /填你的|请填写|placeholder|your[_-]?api[_-]?key/i,
    /^sk-x{3,}$/i,               // 文档里常见的打码示例
    /^\.{3,}$/,
];

function isPlaceholderKey(value) {
    const key = String(value == null ? '' : value).trim();
    return PLACEHOLDER_PATTERNS.some((re) => re.test(key));
}

function isLocalEndpoint(url) {
    const raw = String(url || '').trim();
    if (!raw) return false;
    let host = '';
    try {
        const u = new URL(raw);
        host = String(u.hostname || '').toLowerCase();
    } catch (e) { /* 不带协议的写法下面兜 */ }
    if (!host) {
        // 不带协议/带自定义 scheme 的写法（127.0.0.1:11434/v1、ollama:11434/v1）
        const m = /^([^/?#:]+)(?::\d+)?(?:\/|$)/.exec(raw);
        host = m ? String(m[1] || '').toLowerCase() : '';
    }
    if (!host) return false;
    if (host === 'localhost' || host === '::1' || host === '[::1]' || host === '0.0.0.0') return true;
    if (/^127\./.test(host)) return true;
    // 无点主机名（容器/内网短名）按本地处理
    if (!host.includes('.') && !host.includes(':')) return true;
    return false;
}

function pickProvider(config, providersDoc) {
    const list = providersDoc && Array.isArray(providersDoc.providers) ? providersDoc.providers : [];
    if (!list.length) return null;
    const wanted = String((config && config.llm && config.llm.provider_id) || '').trim();
    let provider = wanted ? list.find((p) => p && p.id === wanted) : null;
    if (!provider) provider = list.find((p) => p && p.enabled !== false) || list[0] || null;
    return provider || null;
}

/**
 * @param {object|null} config       config.json 内容（可空）
 * @param {object|null} providersDoc llm_providers.json 内容（可空）
 * @returns {{needsKey:boolean, reason:string, providerId:string}}
 */
function inspectFirstRun(config, providersDoc) {
    const provider = pickProvider(config, providersDoc);
    if (!provider) return { needsKey: true, reason: 'no-provider', providerId: '' };

    const id = String(provider.id || '');
    const url = String(provider.api_url || '');
    const key = provider.api_key;

    if (id.toLowerCase() === 'ollama') return { needsKey: false, reason: 'ollama', providerId: id };
    if (isLocalEndpoint(url)) return { needsKey: false, reason: 'local-endpoint', providerId: id };
    if (!isPlaceholderKey(key)) return { needsKey: false, reason: 'key-present', providerId: id };
    return { needsKey: true, reason: 'empty-key', providerId: id };
}

function needsApiKey(config, providersDoc) {
    return inspectFirstRun(config, providersDoc).needsKey;
}

/** 随包 TTS（安装版才有；开发树里不存在 → 返回空串，调用方静默跳过） */
function bundledTtsPath(resourcesPath) {
    const path = require('path');
    const fs = require('fs');
    const base = String(resourcesPath || '').trim();
    if (!base) return '';
    const exe = path.join(base, 'tts', 'dafeiyu-tts.exe');
    try { return fs.existsSync(exe) ? exe : ''; } catch (e) { return ''; }
}

module.exports = { isPlaceholderKey, isLocalEndpoint, pickProvider, inspectFirstRun, needsApiKey, bundledTtsPath };
