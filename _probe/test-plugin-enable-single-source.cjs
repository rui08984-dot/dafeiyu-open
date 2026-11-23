#!/usr/bin/env node
// _probe/test-plugin-enable-single-source.cjs —— 插件总开关单一真相源单测（2026-11-21）
//
// 覆盖：
//   ① 解析器 resolvePluginEnabled：优先级与旧开关兼容语义
//   ② plugin-manager / plugin-context：enabled_plugins.json 是唯一加载闸
//   ③ 10 个插件：三种组合下 onInit 不抛，且总开关结论正确
//        manager 开 + 无 enabled 键        → 启用
//        manager 开 + enabled=false        → 关 + 只 warn 一次（旧开关兼容）
//        manager 关 + enabled=true         → 关（清单说了算）
//
// 全部用 os.tmpdir() 临时目录，不碰真实 data。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const CORE = path.join(APP, 'js', 'core');
const PLUGINS_DIR = path.join(APP, 'plugins');

const { resolvePluginEnabled, PluginContext } = require(path.join(CORE, 'plugin-context.js'));
const { PluginManager } = require(path.join(CORE, 'plugin-manager.js'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; failures.push(name + (detail ? '：' + detail : '')); }
function eq(name, actual, expected) { ok(name, actual === expected, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual)); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-single-source-'));
let seq = 0;
function freshDir() {
    const d = path.join(tmpRoot, 'case-' + (++seq));
    fs.mkdirSync(d, { recursive: true });
    return d;
}
function resetWarnState() {
    try { delete globalThis.__pluginLegacyEnabledWarned; } catch (e) { /* ignore */ }
}
function makeCtx({ enabled, cfg, recordsDir, logs }) {
    return {
        isPluginEnabled: () => enabled,
        getPluginFileConfig: () => Object.assign({}, cfg || {}),
        log: (level, msg) => { if (logs) logs.push(String(level) + ':' + String(msg)); },
        recordsDir: recordsDir || null,
        on() {}, off() {}, emit() {},
        storage: { get() {}, set() {}, delete() {}, getAll() { return {}; } },
    };
}

// ── 10 个插件（总开关判定在本轮统一改造）──────────────────────────────
const TARGETS = [
    { rel: 'built-in/memos', name: 'memos', file: ['built-in', 'memos', 'index.js'], flag: (p) => !!(p.client && p.client.enabled) },
    { rel: 'community/alive-state', name: 'alive-state', file: ['community', 'alive-state', 'index.js'], flag: (p) => p._enabled },
    { rel: 'community/companion-health', name: 'companion-health', file: ['community', 'companion-health', 'index.js'], flag: (p) => p._enabled },
    { rel: 'community/live-dock', name: 'live-dock', file: ['community', 'live-dock', 'index.js'], flag: (p) => p._enabled },
    { rel: 'community/memory-evolve', name: 'memory-evolve', file: ['community', 'memory-evolve', 'index.js'], flag: (p) => p._enabled },
    { rel: 'community/mind-kernel', name: 'mind-kernel', file: ['community', 'mind-kernel', 'index.js'], flag: (p) => p._enabled },
    { rel: 'community/persona-guard', name: 'persona-guard', file: ['community', 'persona-guard', 'index.js'], flag: (p) => p._enabled },
    { rel: 'community/rss-brief', name: 'rss-brief', file: ['community', 'rss-brief', 'index.js'], flag: (p) => !!(p._cfg && p._cfg.enabled) },
    // user-profile 的总开关在 onStart 解析（onInit 只先置默认 true）；见下特殊处理
    { rel: 'community/user-profile', name: 'user-profile', file: ['community', 'user-profile', 'index.js'], flag: (p) => p._enabled, resolveInStart: true },
    { rel: 'community/world-extras', name: 'world-extras', file: ['community', 'world-extras', 'index.js'], flag: (p) => p._enabled },
];

function configFor(t, dir) {
    if (t.rel === 'community/mind-kernel') {
        return { goals_file: path.join(dir, 'goals.json'), ledger_file: path.join(dir, 'goal-ledger.jsonl') };
    }
    if (t.rel === 'community/world-extras') {
        return {
            tabs_file: path.join(dir, 'browser-tabs.jsonl'),
            rss_last_file: path.join(dir, 'rss-brief-last.json'),
            rss_items_file: path.join(dir, 'rss-items.jsonl'),
        };
    }
    return {};
}

function loadPluginClass(t) {
    const main = path.join(PLUGINS_DIR, ...t.file);
    const mod = require(main);
    const named = (mod && typeof mod === 'object')
        ? Object.keys(mod).map((k) => mod[k]).find((v) => typeof v === 'function')
        : null;
    return (typeof mod === 'function') ? mod : (mod && mod.default) || named || mod;
}

(async () => {
    // ══════════════════════════════════════════════════════════════════
    // ① 解析器语义
    // ══════════════════════════════════════════════════════════════════
    resetWarnState();
    {
        const logs = [];
        const ctxOn = makeCtx({ enabled: true, logs });

        eq('manager 开 + 无 enabled 键 → 启用',
            resolvePluginEnabled(ctxOn, {}, 'p1'), true);

        eq('manager 开 + enabled=true → 启用',
            resolvePluginEnabled(ctxOn, { enabled: true }, 'p2'), true);

        const r = resolvePluginEnabled(ctxOn, { enabled: false }, 'p3');
        const r2 = resolvePluginEnabled(ctxOn, { enabled: false }, 'p3');
        eq('manager 开 + enabled=false → 关（旧开关显式关）', r, false);
        eq('重复解析仍为关', r2, false);
        const warns = logs.filter((l) => l.indexOf('已废弃') >= 0);
        eq('旧开关关闭只 warn 一次', warns.length, 1);
        ok('警告文案含插件名与能力页指引',
            warns.length === 1 && /p3 被 plugin_config\.enabled=false 关闭（已废弃，请用能力页）/.test(warns[0]),
            warns.join(' | '));

        const ctxOff = makeCtx({ enabled: false, logs: [] });
        eq('manager 关 + enabled=true → 关（清单说了算）',
            resolvePluginEnabled(ctxOff, { enabled: true }, 'p4'), false);
        eq('manager 关 + 无 enabled 键 → 关',
            resolvePluginEnabled(ctxOff, {}, 'p5'), false);

        // 旧 mock（没有 isPluginEnabled）：退回历史默认
        const legacyCtx = { log() {}, getPluginFileConfig: () => ({}) };
        eq('无 manager 答案 + 无键 + legacyDefault=true → 启用',
            resolvePluginEnabled(legacyCtx, {}, 'p6', true), true);
        eq('无 manager 答案 + 无键 + legacyDefault=false → 关（保留 opt-in 旧默认）',
            resolvePluginEnabled(legacyCtx, {}, 'p7', false), false);
        eq('无 manager 答案 + enabled=true → 启用',
            resolvePluginEnabled(legacyCtx, { enabled: true }, 'p8', false), true);
        resetWarnState();
        eq('无 manager 答案 + enabled=false → 关',
            resolvePluginEnabled(legacyCtx, { enabled: false }, 'p9', true), false);
    }

    // ══════════════════════════════════════════════════════════════════
    // ② manager / context：enabled_plugins.json 是唯一加载闸
    // ══════════════════════════════════════════════════════════════════
    const mgr = new PluginManager({});
    ok('manager.isPluginEnabled(清单内) = true', mgr.isPluginEnabled('community/world-extras') === true);
    ok('manager.isPluginEnabled(清单外) = false', mgr.isPluginEnabled('community/definitely-not-loaded') === false);
    ok('manager.isPluginEnabled(空) = false', mgr.isPluginEnabled('') === false);

    const ctxListed = new PluginContext('community/world-extras', {}, mgr);
    const ctxUnlisted = new PluginContext('community/definitely-not-loaded', {}, mgr);
    const ctxNoMgr = new PluginContext('community/world-extras', {}, null);
    eq('context.isPluginEnabled() 反映清单（开）', ctxListed.isPluginEnabled(), true);
    eq('context.isPluginEnabled() 反映清单（关）', ctxUnlisted.isPluginEnabled(), false);
    eq('无 manager 时 context.isPluginEnabled() = true（退回旧默认）', ctxNoMgr.isPluginEnabled(), true);

    // 「清单里没有 → manager 不加载」：造一个 require 就会抛错的插件目录
    {
        const strayDir = freshDir();
        fs.writeFileSync(path.join(strayDir, 'metadata.json'), JSON.stringify({ name: 'stray-probe', main: 'index.js' }), 'utf8');
        fs.writeFileSync(path.join(strayDir, 'index.js'), "throw new Error('STRICT: 未启用插件被加载了');", 'utf8');
        let threw = null;
        try { await mgr.load(strayDir); } catch (e) { threw = e; }
        eq('未启用插件不被加载（manager.load 静默跳过）', threw, null);
        eq('未启用插件没有进入 _plugins', mgr._plugins.size, 0);
    }

    // ══════════════════════════════════════════════════════════════════
    // ③ 10 个插件：onInit 不抛 + 三种组合的开关结论
    // ══════════════════════════════════════════════════════════════════
    for (const t of TARGETS) {
        const Cls = loadPluginClass(t);
        ok(t.rel + ' 入口是可构造类', typeof Cls === 'function', '拿到 ' + typeof Cls);
        if (typeof Cls !== 'function') continue;

        // (a) manager 开 + 无 enabled 键 → 启用
        {
            resetWarnState();
            const logs = [];
            const dir = freshDir();
            const inst = new Cls({ name: t.name }, makeCtx({ enabled: true, cfg: configFor(t, dir), recordsDir: dir, logs }));
            let threw = null;
            try { await inst.onInit(); } catch (e) { threw = e; }
            eq(t.rel + ' onInit 不抛（manager 开、无键）', threw && threw.message, null);
            if (!t.resolveInStart) {
                eq(t.rel + ' manager 开 + 无 enabled 键 → 启用', t.flag(inst), true);
            } else {
                eq(t.rel + ' onInit 后默认允许（真正结论在 onStart）', t.flag(inst), true);
            }
            eq(t.rel + ' 无键时不应产生废弃警告', logs.filter((l) => l.indexOf('已废弃') >= 0).length, 0);
        }

        // (b) manager 开 + plugin_config.enabled=false → 关 + warn 一次
        {
            resetWarnState();
            const logs = [];
            const dir = freshDir();
            const inst = new Cls({ name: t.name }, makeCtx({
                enabled: true, cfg: Object.assign({ enabled: false }, configFor(t, dir)), recordsDir: dir, logs,
            }));
            let threw = null;
            try {
                await inst.onInit();
                if (t.resolveInStart) await inst.onStart();
            } catch (e) { threw = e; }
            eq(t.rel + ' onInit 不抛（旧开关关闭）', threw && threw.message, null);
            eq(t.rel + ' 旧配置显式关 → 关', t.flag(inst), false);
            const warns = logs.filter((l) => l.indexOf('已废弃') >= 0);
            eq(t.rel + ' 旧配置关闭 warn 一次', warns.length, 1);
            ok(t.rel + ' 警告文案指向能力页',
                warns.length === 1 && warns[0].indexOf('请用能力页') >= 0, warns.join(' | '));
            // 二次解析不应再 warn（全局只记一次）
            const inst2 = new Cls({ name: t.name }, makeCtx({
                enabled: true, cfg: Object.assign({ enabled: false }, configFor(t, freshDir())), recordsDir: dir, logs,
            }));
            await inst2.onInit();
            if (t.resolveInStart) await inst2.onStart();
            eq(t.rel + ' 重复加载不再重复 warn',
                logs.filter((l) => l.indexOf('已废弃') >= 0).length, 1);
        }

        // (c) manager 关 + enabled=true → 关（清单说了算，不再加载）
        {
            resetWarnState();
            const logs = [];
            const dir = freshDir();
            const inst = new Cls({ name: t.name }, makeCtx({
                enabled: false, cfg: Object.assign({ enabled: true }, configFor(t, dir)), recordsDir: dir, logs,
            }));
            let threw = null;
            try {
                await inst.onInit();
                if (t.resolveInStart) await inst.onStart();
            } catch (e) { threw = e; }
            eq(t.rel + ' onInit 不抛（manager 关）', threw && threw.message, null);
            eq(t.rel + ' 清单关 → 关（哪怕旧配置 true）', t.flag(inst), false);
            eq(t.rel + ' 清单关时不应产生废弃警告', logs.filter((l) => l.indexOf('已废弃') >= 0).length, 0);
        }
    }

    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    if (failures.length) {
        console.error('❌ plugin-enable-single-source：FAIL ' + fail + ' / PASS ' + pass);
        for (const f of failures) console.error('   - ' + f);
        process.exit(1);
    }
    console.log('  ✅ plugin-enable-single-source：PASS ' + pass + ' / FAIL 0');
})();
