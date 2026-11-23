/**
 * key-policy.js —— 输入键安全策略（E5 最小切口，2026-11-22）
 *
 * 从 plugins/community/dispatch/game-control.js 抽出的**纯函数层**。
 * 只回答三件事：这个键能不能发、算不算危险组合、要不要二次确认。
 * 不做 IO、不读配置、不依赖 Electron —— 策略表与别名表由调用方传入。
 *
 * 与 game-control 的分工（行为零变化是硬约束）：
 *   · 策略文件加载（pet-runtime/tools/key-policy.json）仍留在 game-control（它要 IO）；
 *   · 拒绝文案的**人类可读原文**仍由 game-control 持有并传入（下面的 DENY_MSG 是同一句
 *     的默认值，给独立调用/单测用；两边必须逐字一致）；
 *   · game-control 的 KEY_POLICY_RULES / normalizeKeyName / keyPolicyViolation 等导出
 *     保持原签名，内部转调本模块。
 *
 * 语义（与 pet-runtime/tools/key-policy.json 完全一致）：
 *   require = 必须同时出现的规范化键；any = 任一触发键（空数组 = require 命中即拒）。
 *   键名归一：control→ctrl / escape→esc / delete→del / lctrl|lalt|lshift|lwin 等→基础名。
 */

'use strict';

/** 默认拒绝文案。与 game-control.js 的 KEY_POLICY_DENY_MSG **逐字一致**（测试会比对）。 */
const DENY_MSG = '该组合被安全策略拒绝（固定策略：alt+f4 / alt+tab / alt+space / ctrl+alt+del / ctrl+esc / ctrl+shift+esc / win+任意键 不允许注入）';

/** 键名别名（JSON 缺失时的兜底；与 key-policy.json 的 aliases 一致）。 */
const DEFAULT_ALIASES = {
    control: 'ctrl', escape: 'esc', delete: 'del',
    lctrl: 'ctrl', rctrl: 'ctrl', lalt: 'alt', ralt: 'alt',
    lshift: 'shift', rshift: 'shift', lwin: 'win', rwin: 'win',
};

/** 内联兜底策略表（JSON 缺失时用；与 key-policy.json 的 rules 一致）。 */
const FALLBACK_RULES = [
    { require: ['alt'], any: ['f4', 'tab', 'space'] },
    { require: ['ctrl', 'alt'], any: ['del', 'delete'] },
    { require: ['ctrl'], any: ['esc', 'escape'] },
    { require: ['win'], any: [] },
];

/**
 * 键名归一：小写、去空白、套别名。
 * @param {any} key
 * @param {object} [aliases] 别名表（不传用 DEFAULT_ALIASES）
 * @returns {string}
 */
function normalizeKeyName(key, aliases) {
    const map = aliases && typeof aliases === 'object' ? aliases : DEFAULT_ALIASES;
    const s = String(key == null ? '' : key).toLowerCase().trim();
    return map[s] || s;
}

/**
 * 组合键字符串 → 键片段数组。**与 game-control 原实现逐字一致**：
 *   String(spec).trim().toLowerCase().split('+').map(trim).filter(Boolean)
 * @param {any} spec 例如 'ctrl+s' / ['ctrl','s'] / undefined
 * @returns {string[]}
 */
function splitKeySpec(spec) {
    if (Array.isArray(spec)) {
        return spec.map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
    }
    return String(spec).trim().toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
}

/**
 * 命中哪条策略规则（纯函数）。返回规则对象或 null。
 *
 * 注意：规则表里的键**不再做别名归一**（与历史实现一致 —— 策略文件加载时已小写化，
 * 且防 aliases 反向改写规则语义）。只对输入键做归一。
 *
 * @param {string[]|string} keys 键片段或组合键字符串
 * @param {Array<{require:string[],any:string[]}>} [rules]
 * @param {object} [aliases]
 * @returns {object|null}
 */
function matchRule(keys, rules, aliases) {
    const list = Array.isArray(rules) && rules.length ? rules : FALLBACK_RULES;
    const raw = Array.isArray(keys) ? keys : splitKeySpec(keys);
    const set = new Set(raw.map((k) => normalizeKeyName(k, aliases)).filter(Boolean));
    for (const r of list) {
        if (!r || !Array.isArray(r.require) || !r.require.length) continue;
        if (!r.require.every((k) => set.has(k))) continue;
        const any = Array.isArray(r.any) ? r.any : [];
        if (any.length === 0 || any.some((k) => set.has(k))) return r;
    }
    return null;
}

/**
 * 策略判定（纯函数）。E5 规定的入口形状：
 *   classify(keySpec, { context }) → { allowed, reason, needsConfirm }
 *
 * @param {any} keySpec 组合键字符串或键片段数组
 * @param {object} [opts]
 * @param {Array} [opts.rules] 策略表（不传用 FALLBACK_RULES）
 * @param {object} [opts.aliases] 别名表
 * @param {string} [opts.denyMessage] 拒绝时的 reason 文案（不传用 DENY_MSG）
 * @param {object} [opts.context] 预留：判定上下文（窗口/场景等），当前不影响结果
 * @returns {{allowed:boolean, reason:string, needsConfirm:boolean}}
 */
function classify(keySpec, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const rules = Array.isArray(o.rules) && o.rules.length ? o.rules : FALLBACK_RULES;
    const aliases = o.aliases && typeof o.aliases === 'object' ? o.aliases : DEFAULT_ALIASES;
    const denyMessage = typeof o.denyMessage === 'string' && o.denyMessage ? o.denyMessage : DENY_MSG;
    const hit = matchRule(keySpec, rules, aliases);
    if (!hit) return { allowed: true, reason: '', needsConfirm: false };
    // 软危险（策略条目显式写 confirm:true）：放行但要求二次确认。当前策略表没有这种条目，
    // 保留这条通路是为了「不要为了一个未来字段再改一次判定逻辑」。
    if (hit.confirm === true) {
        return { allowed: true, reason: '', needsConfirm: true };
    }
    return { allowed: false, reason: denyMessage, needsConfirm: false };
}

module.exports = {
    DENY_MSG,
    DEFAULT_ALIASES,
    FALLBACK_RULES,
    normalizeKeyName,
    splitKeySpec,
    matchRule,
    classify,
};
