#!/usr/bin/env node
// _probe/plugin-enabled-audit.cjs —— 插件总开关一致性审计（2026-11-21）
//
// 背景：同一个插件曾经有三道闸 —— 能力页写 plugins/enabled_plugins.json、
// 插件页写各插件 plugin_config.json 的 enabled、插件代码里还有自己的默认值。
// 三处不一致时表现为「开了但没生效」，用户无法判断该信哪个。
// 2026-11-21 起单一真相源 = enabled_plugins.json；plugin_config.enabled 降级为
// 兼容读取（只有显式 false 才关，会 warn 一次）。
//
// 本脚本**只读**：不加载插件、不改任何配置，只把不一致项列出来。
//
// 用法：node _probe/plugin-enabled-audit.cjs
// 退出码：0 = 审计完成（有/没有不一致都算完成）；1 = 清单本身读不了。
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const PLUGINS = path.join(APP, 'plugins');
const ENABLED_FILE = path.join(PLUGINS, 'enabled_plugins.json');

// 本次迁移涉及的 10 个「插件内还有 enabled 总开关」的插件
const AFFECTED = [
    'built-in/memos',
    'community/alive-state',
    'community/companion-health',
    'community/live-dock',
    'community/memory-evolve',
    'community/mind-kernel',
    'community/persona-guard',
    'community/rss-brief',
    'community/user-profile',
    'community/world-extras',
];

// 历史默认关的插件（代码里是 `enabled === true`）：拿不到 manager 答案时仍默认关。
const LEGACY_OPT_IN = new Set(['community/live-dock', 'community/mind-kernel', 'community/rss-brief']);

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

/** plugin_config.json 里 enabled 的真实值；兼容 schema 包装（{type,value,default}） */
function legacyEnabledOf(cfg) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { has: false, value: undefined, raw: undefined };
    if (!Object.prototype.hasOwnProperty.call(cfg, 'enabled')) return { has: false, value: undefined, raw: undefined };
    const raw = cfg.enabled;
    let v = raw;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        // 与 PluginContext._resolveSchema 的取值规则一致：value 优先，其次 default
        v = raw.value !== undefined ? raw.value : raw.default;
    }
    return { has: true, value: v, raw };
}

function scanPlugins() {
    const out = [];
    for (const kind of ['built-in', 'community']) {
        const base = path.join(PLUGINS, kind);
        if (!fs.existsSync(base)) continue;
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(base, entry.name);
            if (!fs.existsSync(path.join(dir, 'metadata.json'))) continue;
            out.push({ rel: kind + '/' + entry.name, dir });
        }
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function verdictOf(rel, inList, legacy) {
    if (inList && legacy.has && legacy.value === false) return 'MISMATCH_LEGACY_OFF';
    if (!inList && legacy.has && legacy.value === true) return 'MISMATCH_LIST_OFF';
    if (inList) return legacy.has ? 'OK' : 'OK_NO_LEGACY_KEY';
    return 'OK_OFF';
}

function main() {
    let enabled = null;
    try {
        const parsed = JSON.parse(fs.readFileSync(ENABLED_FILE, 'utf8'));
        enabled = Array.isArray(parsed && parsed.plugins) ? parsed.plugins : null;
    } catch (e) {
        console.error('❌ enabled_plugins.json 读取失败：' + e.message);
        process.exit(1);
    }
    if (!enabled) {
        console.error('❌ enabled_plugins.json 缺少 plugins 数组');
        process.exit(1);
    }

    const enabledSet = new Set(enabled);
    const plugins = scanPlugins();
    const rows = [];
    for (const p of plugins) {
        const cfgFile = path.join(p.dir, 'plugin_config.json');
        const exists = fs.existsSync(cfgFile);
        const cfg = exists ? readJson(cfgFile, null) : null;
        const legacy = legacyEnabledOf(cfg);
        rows.push({
            rel: p.rel,
            inList: enabledSet.has(p.rel),
            configFile: exists,
            legacy,
            affected: AFFECTED.includes(p.rel),
            optIn: LEGACY_OPT_IN.has(p.rel),
            verdict: verdictOf(p.rel, enabledSet.has(p.rel), legacy),
        });
    }

    // 清单里有、但磁盘上找不到目录的条目（另一类不一致）
    const missingDirs = enabled.filter((rel) => !rows.some((r) => r.rel === rel));

    const legacyOff = rows.filter((r) => r.verdict === 'MISMATCH_LEGACY_OFF');
    const listOff = rows.filter((r) => r.verdict === 'MISMATCH_LIST_OFF');
    const noKey = rows.filter((r) => r.verdict === 'OK_NO_LEGACY_KEY');

    console.log('插件总开关审计（单一真相源 = enabled_plugins.json）');
    console.log('  插件目录：' + plugins.length + ' 个；清单条目：' + enabled.length + ' 个');
    console.log('');
    console.log('【本次迁移的 10 个插件】');
    for (const r of rows.filter((x) => x.affected)) {
        const legacyText = r.legacy.has ? JSON.stringify(r.legacy.value) : '（无 enabled 键）';
        const mark = r.verdict === 'MISMATCH_LEGACY_OFF' || r.verdict === 'MISMATCH_LIST_OFF' ? '⚠️' : '·';
        console.log(`  ${mark} ${r.rel}`);
        console.log(`      清单(enabled_plugins)：${r.inList ? '开' : '关'}   plugin_config.enabled：${legacyText}${r.optIn ? '   [历史默认关]' : ''}`);
    }
    console.log('');

    if (legacyOff.length) {
        console.log('⚠️ 不一致 A：清单里开着，但被旧开关 plugin_config.enabled=false 关掉（表现为「开了但没生效」）');
        for (const r of legacyOff) console.log('   - ' + r.rel);
    } else {
        console.log('✅ 不一致 A：无（没有「清单开、旧开关显式关」的插件）');
    }
    if (listOff.length) {
        console.log('⚠️ 不一致 B：清单里关着，但插件配置写着 enabled=true（插件页会显示开，实际不加载）');
        for (const r of listOff) console.log('   - ' + r.rel);
    } else {
        console.log('✅ 不一致 B：无（没有「清单关、插件配置显式开」的插件）');
    }
    if (noKey.length) {
        console.log('ℹ️ 清单开着且没有 enabled 键（按新规则 = 启用，旧规则下部分插件依赖各自默认）：');
        for (const r of noKey) console.log('   - ' + r.rel + (r.optIn ? '（历史默认关）' : ''));
    }
    if (missingDirs.length) {
        console.log('⚠️ 不一致 C：清单里的条目在磁盘上找不到插件目录');
        for (const rel of missingDirs) console.log('   - ' + rel);
    } else {
        console.log('✅ 不一致 C：无（清单条目都有对应目录）');
    }

    const bad = legacyOff.length + listOff.length + missingDirs.length;
    console.log('');
    console.log(bad
        ? `审计完成：发现 ${bad} 项不一致（只读报告，未自动修改）`
        : '审计完成：没有不一致项，单一真相源与插件配置一致（只读报告，未自动修改）');
    process.exit(0);
}

main();
