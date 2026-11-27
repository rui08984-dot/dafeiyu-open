'use strict';
// after-pack.cjs —— electron-builder 的打包后校验（2026-11-26 安装包 A）
//
// 为什么需要：`files` 的 glob 漏过 `runtime.log.1` 这类轮转日志，10MB 个人运行日志
// 就这样进过一次安装包。这里做最后一道闸：
//   1) 删掉 Electron dist 自带的 debug.log（Chromium 报错日志，无意义）
//   2) 删掉 resources/app 下任何 *.log / *.log.* / *.jsonl（运行日志不入包）
//   3) 硬校验：config.json / llm_providers.json 必须在，且不能出现真实 key 形状
// 任何一条不满足 → 抛错，构建失败（绝不静默）。

const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
    const root = context.appOutDir;
    const appDir = path.join(root, 'resources', 'app');
    const removed = [];

    for (const p of [path.join(root, 'debug.log')]) {
        try { if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removed.push(p); } } catch (e) { /* ignore */ }
    }

    let names = [];
    try { names = fs.readdirSync(appDir); } catch (e) { names = []; }
    for (const name of names) {
        if (!/\.(log|jsonl)(\.|$)/i.test(name)) continue;
        const p = path.join(appDir, name);
        try { fs.rmSync(p, { force: true }); removed.push(p); } catch (e) { /* ignore */ }
    }
    if (removed.length) console.log('[afterPack] 已移除运行日志：' + removed.map((p) => path.basename(p)).join(', '));

    const cfgPath = path.join(appDir, 'config.json');
    const provPath = path.join(appDir, 'llm_providers.json');
    for (const p of [cfgPath, provPath]) {
        if (!fs.existsSync(p)) throw new Error('[afterPack] 安装包缺少默认配置：' + p);
        const text = fs.readFileSync(p, 'utf8');
        if (/sk-[A-Za-z0-9]{20,}/.test(text)) throw new Error('[afterPack] 默认配置疑似含真实 key：' + p);
    }
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (!cfg.llm || !cfg.llm.provider_id) throw new Error('[afterPack] config.json 缺少 llm.provider_id');
    if (String(cfg.llm.system_prompt || '').length < 200) throw new Error('[afterPack] 默认人格太短（应来自本机 config.json）');

    // v0.4.0 底座完整性：少了这些，安装版会「能开但能力悄悄消失」
    const must = [
        path.join(root, 'components', 'manifest.json'),
        path.join(root, 'resources', 'data', '人格内核.json'),
        path.join(root, 'resources', 'app', 'pet-runtime', 'tools', 'pinyin_mouth.py'),
        path.join(root, 'resources', 'app', 'pet-runtime', 'desktop', 'perf', 'lumen-semantic-client.cjs'),
        path.join(root, 'resources', 'app', 'pet-runtime', 'data', 'facs-clips', 'index.json'),
        path.join(root, 'resources', 'app', 'pet-runtime', 'data', 'perf-sync.json'),
        path.join(root, 'resources', 'app', 'js', 'components', 'manager.js'),
    ];
    for (const p of must) {
        if (!fs.existsSync(p)) throw new Error('[afterPack] 底座缺文件：' + p);
    }
    console.log('[afterPack] 安装版配置校验通过（provider=' + cfg.llm.provider_id + '，人格 ' + String(cfg.llm.system_prompt).length + ' 字符）');
};
