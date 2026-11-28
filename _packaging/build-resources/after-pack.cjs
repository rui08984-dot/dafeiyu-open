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

    // v0.5.1：轮转日志会换名字（performance-log.jsonl.1 / runtime.log.3…），
    // 顶层 basename 规则漏过 `.jsonl.1` 把 2MB dev 运行数据带进过一次包。
    // 这里整树扫一遍，命中即构建失败（不是删掉就算，必须让构建方修过滤规则）。
    const leaks = [];
    (function walk(dir) {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const ent of entries) {
            const p = path.join(dir, ent.name);
            if (ent.isDirectory()) { walk(p); continue; }
            if (/\.(log|jsonl)\.[0-9]+$/i.test(ent.name)) leaks.push(p);
        }
    })(appDir);
    if (leaks.length) {
        throw new Error('[afterPack] 安装包里有轮转运行日志（过滤规则失效）：' + leaks.map((p) => path.relative(root, p)).join(', '));
    }

    const cfgPath = path.join(appDir, 'config.json');
    const provPath = path.join(appDir, 'llm_providers.json');
    for (const p of [cfgPath, provPath]) {
        if (!fs.existsSync(p)) throw new Error('[afterPack] 安装包缺少默认配置：' + p);
        const text = fs.readFileSync(p, 'utf8');
        if (/sk-[A-Za-z0-9]{20,}/.test(text)) throw new Error('[afterPack] 默认配置疑似含真实 key：' + p);
    }
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (!cfg.llm || !cfg.llm.provider_id) throw new Error('[afterPack] config.json 缺少 llm.provider_id');
    // v0.5.1（P0-3）：公开树全新 clone 没有 config.json，构建回退到占位人格（结构验证用）；
    // 本机构建（persona=live-config）仍强制 ≥200 字符，防止发布包悄悄带上占位人格。
    const personaSource = String((cfg._install && cfg._install.persona) || '');
    if (String(cfg.llm.system_prompt || '').length < 200) {
        if (personaSource === 'example-placeholder') {
            console.warn('[afterPack] 占位人格构建（公开树结构验证），不是可发布安装包：' + String(cfg.llm.system_prompt || '').length + ' 字符');
        } else {
            throw new Error('[afterPack] 默认人格太短（应来自本机 config.json）');
        }
    }

    // v0.4.0 底座完整性：少了这些，安装版会「能开但能力悄悄消失」
    const must = [
        path.join(root, 'components', 'manifest.json'),
        path.join(root, 'resources', 'data', '人格内核.json'),
        path.join(root, 'resources', 'app', 'pet-runtime', 'tools', 'pinyin_mouth.py'),
        // v0.5.1（G1）：控制面板「记忆体检」跑它；以前被 /XF 排除，安装版必然报找不到脚本
        path.join(root, 'resources', 'app', 'pet-runtime', 'tools', 'memos-consistency.mjs'),
        path.join(root, 'resources', 'app', 'pet-runtime', 'desktop', 'perf', 'lumen-semantic-client.cjs'),
        path.join(root, 'resources', 'app', 'pet-runtime', 'data', 'facs-clips', 'index.json'),
        path.join(root, 'resources', 'app', 'pet-runtime', 'data', 'perf-sync.json'),
        path.join(root, 'resources', 'app', 'js', 'components', 'manager.js'),
        // v0.5.1（G3）：浏览器标签扩展随包（手动加载）；缺了能力页会指向不存在的目录
        path.join(root, '浏览器扩展', 'browser-tabs', 'manifest.json'),
    ];
    for (const p of must) {
        if (!fs.existsSync(p)) throw new Error('[afterPack] 底座缺文件：' + p);
    }
    // v0.5.1（G4）：dev 维护入口/服务清单不该出现在安装版（它们按 dev 相对路径工作）
    const mustNot = [
        path.join(root, 'resources', 'app', 'pet-runtime', 'tools', 'services.json'),
        path.join(root, 'resources', 'app', 'pet-runtime', 'tools', 'doctor.mjs'),
    ];
    for (const p of mustNot) {
        if (fs.existsSync(p)) throw new Error('[afterPack] 安装包不应包含 dev 维护文件：' + p);
    }
    console.log('[afterPack] 安装版配置校验通过（provider=' + cfg.llm.provider_id + '，人格 ' + String(cfg.llm.system_prompt).length + ' 字符）');
};
