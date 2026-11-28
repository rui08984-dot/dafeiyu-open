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
        // v0.5.3：游戏知识库（产品数据）随包；缺了安装版看屏/游戏读屏会少一大块
        path.join(root, 'resources', 'app', 'pet-runtime', 'knowledge', 'rules', '我的世界.json'),
        path.join(root, 'resources', 'app', 'pet-runtime', 'knowledge', 'templates', '点击开始.json'),
        path.join(root, 'resources', 'app', 'pet-runtime', 'knowledge', 'grid-baseline', '植物大战僵尸杂交版_5x9.json'),
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
        // v0.5.3：个人数据目录绝不能随包（她学到的经验 / 个人技能）
        path.join(root, 'resources', 'app', 'pet-runtime', 'knowledge', 'experience'),
        path.join(root, 'resources', 'app', 'pet-runtime', 'knowledge', 'skills', 'skills.json'),
        // v0.5.3：dev 杂物/conda 启动脚本不能随包
        path.join(appDir, 'go.bat'),
        path.join(appDir, 'AI_set_live2d.py'),
        path.join(appDir, '启动 WebUI 控制面板.bat'),
        path.join(appDir, '一键扫描皮套动作.bat'),
        path.join(appDir, 'fake_neuro_audio'),
    ];
    for (const p of mustNot) {
        if (fs.existsSync(p)) throw new Error('[afterPack] 安装包不应包含 dev/个人文件：' + p);
    }

    // v0.5.3：Chromium 用户数据目录（--user-data-dir=Tempcc-test 之类）不能进包；
    // 同时硬断言配置里没有个人 appid / 本机绝对路径（脱敏在 build-installer 里做）。
    const chromiumLeaks = [];
    (function walkProfile(dir, depth) {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            const p = path.join(dir, ent.name);
            if (/^(Local Storage|Local Storage-journal|GPUCache|DawnCache|Cache_Data|Code Cache)$/i.test(ent.name)) {
                chromiumLeaks.push(p);
                continue;
            }
            if (depth < 3) walkProfile(p, depth + 1);
        }
    })(appDir, 0);
    if (chromiumLeaks.length) {
        throw new Error('[afterPack] 安装包含 Chromium 用户数据目录（过滤规则失效）：' + chromiumLeaks.slice(0, 3).join(', '));
    }
    for (const dir of fs.readdirSync(appDir)) {
        if (/^Tempcc-/i.test(dir)) throw new Error('[afterPack] 安装包含测试用户目录：' + dir);
    }
    const REDACT_TARGETS = [
        path.join(appDir, 'config.json'),
        path.join(appDir, 'config.example.json'),
    ];
    for (const p of REDACT_TARGETS) {
        if (!fs.existsSync(p)) continue;
        const text = fs.readFileSync(p, 'utf8');
        const j = JSON.parse(text);
        for (const k of ['volcengine_tts', 'baidu_asr', 'aliyun_tts']) {
            const appid = j.cloud && j.cloud[k] && j.cloud[k].appid;
            if (appid && String(appid).trim()) throw new Error('[afterPack] 安装包配置含个人 appid（' + k + '）：' + p);
        }
        if (j.dispatch && j.dispatch.workspaces && Object.keys(j.dispatch.workspaces).length) {
            throw new Error('[afterPack] 安装包配置含个人工作区：' + p);
        }
        if (/(^|[\\/])Users[\\/][^\\/]+|D:[\\/]ai/i.test(text)) {
            throw new Error('[afterPack] 安装包配置含本机绝对路径：' + p);
        }
    }
    const pluginConfigs = [];
    (function walkPluginConfigs(dir, depth) {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const ent of entries) {
            const p = path.join(dir, ent.name);
            if (ent.isDirectory()) { if (depth < 6) walkPluginConfigs(p, depth + 1); continue; }
            if (ent.name === 'plugin_config.json') pluginConfigs.push(p);
        }
    })(path.join(appDir, 'plugins'), 0);
    for (const p of pluginConfigs) {
        const text = fs.readFileSync(p, 'utf8');
        if (/[A-Za-z]:[\\/](Users[\\/][^"'\r\n]+|ai[^"'\r\n]*)/i.test(text)) {
            throw new Error('[afterPack] 插件配置含本机绝对路径：' + p);
        }
    }
    console.log('[afterPack] 安装版配置校验通过（provider=' + cfg.llm.provider_id + '，人格 ' + String(cfg.llm.system_prompt).length + ' 字符）');
};
