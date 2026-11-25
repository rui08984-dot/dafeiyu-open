#!/usr/bin/env node
/**
 * _probe/test-watch-screen-budget.cjs —— 看屏每小时视觉预算：唯一数字源 + 归一（ADR-014，2026-11-24）
 *
 * 根因（HANDOFF-2026-11-24 §8.5）：同一个预算数字曾存在三处 —— vision-organ.js DEFAULTS=220、
 * index.js 兜底 `|| 90`、plugin_config.json=90（旧安装可能还是 220）。谁生效取决于「配置在不在」，
 * 于是默认值、配置值、代码兜底会各自漂移，审计看到的数字和实际花钱的数字不是一回事。
 *
 * 现在唯一权威是 vision-organ.js 的 VISION_BUDGET_PER_HOUR_DEFAULT（ADR-014 = 90/h；
 * ADR-004 的「云端 VLM ≤6/h」是旧世界感知口径）。本测试钉住：
 *   ① 不配 plugin_config → 90；
 *   ② 配 90 → 90；配 30 → 30（用户显式值必须赢）；
 *   ③ 旧出厂值 220 视为未配置 → 90（老安装的 plugin_config 里可能还存着它）；
 *   ④ DEFAULTS / plugin_config.json default+value / 常量 三者一致；
 *   ⑤ index.js 的兜底也读同一常量，不再写第二份 90/220。
 *
 * 纯静态 + 纯函数；不启动插件、不联网。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const PLUGIN_DIR = path.join(LIVE, 'plugins', 'community', 'watch-screen');
const {
    DEFAULTS,
    VISION_BUDGET_PER_HOUR_DEFAULT,
    resolveVisionBudgetPerHour,
} = require(path.join(PLUGIN_DIR, 'vision-organ.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const pluginCfg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'plugin_config.json'), 'utf8'));
const budgetCfg = pluginCfg.organVisionBudgetPerHour || {};
const indexSrc = fs.readFileSync(path.join(PLUGIN_DIR, 'index.js'), 'utf8');
const organSrc = fs.readFileSync(path.join(PLUGIN_DIR, 'vision-organ.js'), 'utf8');

// 模拟 onInit 的取值链：cfg 来自 getPluginFileConfig()（未配置时是 undefined）
const effective = (cfgValue) => resolveVisionBudgetPerHour(
    cfgValue !== undefined ? cfgValue : DEFAULTS.visionBudgetPerHour);

// ── ① 不配 plugin_config → 默认 90 ──────────────────────────────────────
{
    ok('DEFAULTS.visionBudgetPerHour = 90', DEFAULTS.visionBudgetPerHour === 90, String(DEFAULTS.visionBudgetPerHour));
    ok('常量 VISION_BUDGET_PER_HOUR_DEFAULT = 90', VISION_BUDGET_PER_HOUR_DEFAULT === 90, String(VISION_BUDGET_PER_HOUR_DEFAULT));
    ok('不配 plugin_config → 90', effective(undefined) === 90, String(effective(undefined)));
    ok('plugin_config 缺该键（null）→ 90', effective(null) === 90, String(effective(null)));
}

// ── ② 用户显式值必须赢 ──────────────────────────────────────────────────
{
    ok('配 90 → 90', effective(90) === 90, String(effective(90)));
    ok('配 30 → 30', effective(30) === 30, String(effective(30)));
    ok('配 "45"（schema 可能给字符串）→ 45', effective('45') === 45, String(effective('45')));
    ok('配 120.9 → 取整 120', effective(120.9) === 120, String(effective(120.9)));
}

// ── ③ 旧出厂值 220 = 未配置 ─────────────────────────────────────────────
{
    ok('旧出厂值 220 → 90（老安装不复活旧预算）', effective(220) === 90, String(effective(220)));
    ok('字符串 "220" 同样归一', effective('220') === 90, String(effective('220')));
    ok('非法值（abc/0/负数）→ 90', effective('abc') === 90 && effective(0) === 90 && effective(-5) === 90);
}

// ── ④ DEFAULTS / plugin_config / 常量 同源 ──────────────────────────────
{
    ok('plugin_config.default = 90', budgetCfg.default === 90, String(budgetCfg.default));
    ok('plugin_config.value = 90', budgetCfg.value === 90, String(budgetCfg.value));
    ok('plugin_config 与 DEFAULTS 一致', budgetCfg.default === DEFAULTS.visionBudgetPerHour
        && budgetCfg.value === DEFAULTS.visionBudgetPerHour,
        budgetCfg.default + '/' + budgetCfg.value + ' vs ' + DEFAULTS.visionBudgetPerHour);
    ok('描述写明同源常量', /VISION_BUDGET_PER_HOUR_DEFAULT/.test(String(budgetCfg.description || '')));
    ok('描述写明 ADR-014 与 ADR-004 口径区别', /ADR-014/.test(String(budgetCfg.description || ''))
        && /ADR-004/.test(String(budgetCfg.description || '')), String(budgetCfg.description || '').slice(0, 80));
}

// ── ⑤ index.js 没有第二份数字 ────────────────────────────────────────────
{
    ok('配置取值仍按 cfg.organVisionBudgetPerHour（配置优先）',
        /visionBudgetPerHour:\s*cfg\.organVisionBudgetPerHour \?\? DEFAULTS\.visionBudgetPerHour/.test(indexSrc));
    ok('_visionBudgetOk 走同一 resolve（不再 `|| 90`）',
        /const cap = resolveVisionBudgetPerHour\(this\._organConfig\.visionBudgetPerHour\)/.test(indexSrc));
    ok('index.js 的预算兜底不再写死 90',
        !/Number\(this\._organConfig\.visionBudgetPerHour\)\s*\|\|\s*90/.test(indexSrc)
        && !/visionBudgetPerHour\s*\|\|\s*90/.test(indexSrc));
    ok('vision-organ.js 不再把 220 当 DEFAULTS',
        !/visionBudgetPerHour:\s*220/.test(organSrc));
}

// ── ⑥ 默认值只有一处定义（同源的真正含义）─────────────────────────────────
{
    const defs = organSrc.match(/VISION_BUDGET_PER_HOUR_DEFAULT\s*=\s*90/g) || [];
    ok('vision-organ.js 里常量 90 只定义一次', defs.length === 1, 'n=' + defs.length);
    ok('vision-organ.js 的 DEFAULTS 不再直接写字面数字',
        !/visionBudgetPerHour:\s*\d+/.test(organSrc));
    ok('index.js 不再出现 visionBudgetPerHour 的数字字面量',
        !/visionBudgetPerHour:\s*\d+/.test(indexSrc));
    ok('index.js 读的就是 DEFAULTS（同一常量），不是第二份 90',
        /cfg\.organVisionBudgetPerHour \?\? DEFAULTS\.visionBudgetPerHour/.test(indexSrc)
        && DEFAULTS.visionBudgetPerHour === VISION_BUDGET_PER_HOUR_DEFAULT);
}

console.log('\n' + (fail ? '✗' : '✓') + ' 看屏预算：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
