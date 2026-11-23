#!/usr/bin/env node
/**
 * _probe/test-key-policy.cjs —— E5 纯函数单测：按键策略（key-policy）
 *
 * 守的边界：
 *   ① 纯函数层（js/core/key-policy.js）不读文件、不 require fs/electron —— 可独立测；
 *   ② 归一/拆分/命中的语义与 game-control 历史实现逐字一致（别名、大小写、空键）；
 *   ③ classify 的返回形状固定为 {allowed, reason, needsConfirm}；
 *   ④ game-control 的公开包装（KEY_POLICY_RULES / normalizeKeyName / keyPolicyViolation /
 *      toSendKeys）行为不变：拒绝文案、放行组合、可观测计数都在。
 *
 * 全程不 spawn、不碰桌面。判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core');
const GC = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch', 'game-control.js');
const POLICY_JSON = path.join(ROOT, 'pet-runtime', 'tools', 'key-policy.json');

const KP = require(path.join(CORE, 'key-policy.js'));
const GEOM = require(path.join(CORE, 'geometry.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}
function eq(name, got, want) {
    return ok(name, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

console.log('== ① 纯函数层自证 ==');
{
    const src = fs.readFileSync(path.join(CORE, 'key-policy.js'), 'utf8');
    ok('key-policy.js 不 require fs/path/electron/child_process',
        !/require\(['"](fs|path|electron|child_process)['"]\)/.test(src));
    ok('key-policy.js 没有 IO 调用',
        !/\b(readFile|writeFile|appendFile|spawn|execFile)\b/.test(src));
}

console.log('\n== ② 键名归一 / 拆分 ==');
eq('control → ctrl', KP.normalizeKeyName('control'), 'ctrl');
eq('ESCAPE → esc（大小写 + 别名）', KP.normalizeKeyName('  ESCAPE '), 'esc');
eq('lctrl → ctrl', KP.normalizeKeyName('lctrl'), 'ctrl');
eq('delete → del', KP.normalizeKeyName('delete'), 'del');
eq('未知键原样小写', KP.normalizeKeyName('F5'), 'f5');
eq('null → 空串', KP.normalizeKeyName(null), '');
eq('自定义别名覆盖默认', KP.normalizeKeyName('control', { control: 'ctl' }), 'ctl');
eq("splitKeySpec('Ctrl + S')", KP.splitKeySpec(' Ctrl + S '), ['ctrl', 's']);
eq('splitKeySpec 空串', KP.splitKeySpec(''), []);
eq("splitKeySpec('w')", KP.splitKeySpec('w'), ['w']);
eq("splitKeySpec('undefined') 的历史行为", KP.splitKeySpec(undefined), ['undefined']);

console.log('\n== ③ 规则命中（fallback 表）==');
const BLOCK = [
    'alt+f4', 'alt+tab', 'alt+space', 'ctrl+alt+del', 'ctrl+esc',
    'ctrl+shift+esc', 'win', 'win+r', 'control+alt+delete', 'lctrl+ralt+delete', 'lwin+r',
];
const ALLOW = ['ctrl+s', 'shift+tab', 'w', 'f5', 'alt', 'ctrl+del', 'shift+esc', 'ctrl+shift+t'];
for (const combo of BLOCK) {
    ok('拒绝 ' + combo, !!KP.matchRule(combo), JSON.stringify(KP.matchRule(combo)));
}
for (const combo of ALLOW) {
    ok('放行 ' + combo, KP.matchRule(combo) === null, JSON.stringify(KP.matchRule(combo)));
}
eq('require 全部命中才拒（ctrl+del 缺 alt）', KP.matchRule(['ctrl', 'del']), null);
ok('win+任意键：require 命中且 any 为空 → 拒', !!KP.matchRule(['win', 'x']), 'win+x');
eq('大小写/空白不影响命中', !!KP.matchRule(' ALT + F4 '), true);

console.log('\n== ④ classify 形状与语义 ==');
{
    const bad = KP.classify('alt+f4');
    eq('拒绝时字段集合 = 规定的三键', Object.keys(bad).sort(), ['allowed', 'needsConfirm', 'reason']);
    ok('拒绝：allowed=false', bad.allowed === false);
    ok('拒绝：reason = 默认拒绝文案', bad.reason === KP.DENY_MSG, bad.reason);
    ok('拒绝：needsConfirm=false', bad.needsConfirm === false);
    const good = KP.classify('ctrl+s');
    ok('放行：allowed=true / reason 空 / needsConfirm=false',
        good.allowed === true && good.reason === '' && good.needsConfirm === false, JSON.stringify(good));
    const custom = KP.classify('win', { denyMessage: 'CUSTOM-DENY' });
    ok('自定义 denyMessage 原样作为 reason', custom.allowed === false && custom.reason === 'CUSTOM-DENY', custom.reason);
    const soft = KP.classify('alt+f4', { rules: [{ require: ['alt'], any: ['f4'], confirm: true }] });
    ok('软危险规则（confirm:true）：放行但 needsConfirm=true',
        soft.allowed === true && soft.needsConfirm === true, JSON.stringify(soft));
    const ctx = KP.classify('ctrl+s', { context: { window: 'game' } });
    ok('context 预留不改变判定', ctx.allowed === true && ctx.needsConfirm === false);
}

console.log('\n== ⑤ 唯一策略源 key-policy.json 与纯函数一致 ==');
{
    let file = null;
    try { file = JSON.parse(fs.readFileSync(POLICY_JSON, 'utf8')); } catch (e) { /* 下面判红 */ }
    ok('key-policy.json 可读且 rules 非空', !!file && Array.isArray(file.rules) && file.rules.length > 0);
    if (file && Array.isArray(file.rules)) {
        const rules = file.rules.map((r) => ({
            require: Array.isArray(r.require) ? r.require.map((x) => String(x).toLowerCase()) : [],
            any: Array.isArray(r.any) ? r.any.map((x) => String(x).toLowerCase()) : [],
        }));
        const aliases = file.aliases && typeof file.aliases === 'object' ? file.aliases : KP.DEFAULT_ALIASES;
        let same = true;
        for (const combo of BLOCK.concat(ALLOW)) {
            const a = KP.classify(combo, { rules, aliases }).allowed;
            const b = KP.classify(combo).allowed;
            if (a !== b) { same = false; ok('JSON 与 fallback 判定一致：' + combo, false, 'json=' + a + ' fallback=' + b); }
        }
        ok('JSON 策略表与内联 fallback 判定完全一致（' + (BLOCK.length + ALLOW.length) + ' 组）', same);
        const canon = (rs) => JSON.stringify(rs.map((r) => ({
            require: [...r.require].sort(), any: [...r.any].sort(),
        })));
        ok('JSON 与 FALLBACK_RULES 内容一致', canon(rules) === canon(KP.FALLBACK_RULES),
            'json=' + canon(rules) + ' fallback=' + canon(KP.FALLBACK_RULES));
    }
}

console.log('\n== ⑥ game-control 包装行为不变 ==');
{
    let g = null;
    let loadErr = null;
    try { g = require(GC); } catch (e) { loadErr = e; }
    ok('game-control.js 可加载（不 spawn）', !!g, loadErr ? String(loadErr.message || loadErr) : 'ok');
    if (g) {
        ok('KEY_POLICY_DENY_MSG 与纯函数默认文案逐字一致', g.KEY_POLICY_DENY_MSG === KP.DENY_MSG);
        ok('KEY_POLICY_RULES 仍是 4 条', Array.isArray(g.KEY_POLICY_RULES) && g.KEY_POLICY_RULES.length === 4,
            JSON.stringify(g.KEY_POLICY_RULES));
        eq('normalizeKeyName 包装', g.normalizeKeyName('LCTRL'), 'ctrl');
        ok('keyPolicyViolation 命中返回规则对象', !!g.keyPolicyViolation('alt+f4'));
        ok('keyPolicyViolation 放行返回 null', g.keyPolicyViolation('ctrl+s') === null);

        const before = g.controlStats().keyPolicyRejects;
        for (const combo of BLOCK) {
            let msg = '';
            try { g.toSendKeys(combo); } catch (e) { msg = String((e && e.message) || e); }
            ok('toSendKeys 拒绝 ' + combo + '（逐字文案）', msg === g.KEY_POLICY_DENY_MSG, msg || '没有拒绝');
        }
        for (const combo of ALLOW) {
            let msg = '';
            try { g.toSendKeys(combo); } catch (e) { msg = String((e && e.message) || e); }
            ok('toSendKeys 放行 ' + combo, msg === '', msg);
        }
        const after = g.controlStats().keyPolicyRejects;
        ok('拒绝计数只增不减（+BLOCK.length）', after - before === BLOCK.length,
            'before=' + before + ' after=' + after);
        let emptyMsg = '';
        try { g.toSendKeys(''); } catch (e) { emptyMsg = String((e && e.message) || e); }
        ok('空按键仍报「空的按键」（策略之后）', emptyMsg === '空的按键', emptyMsg);
        let unknownMsg = '';
        try { g.toSendKeys('ctrl+notakey'); } catch (e) { unknownMsg = String((e && e.message) || e); }
        ok('未知键仍报「不认识的键」', unknownMsg === '不认识的键：notakey', unknownMsg);
        eq("toSendKeys('w') 仍产出 'W'", g.toSendKeys('w'), 'W');
        eq("toSendKeys('ctrl+s') 仍产出 '^S'", g.toSendKeys('ctrl+s'), '^S');
        // 交叉校验：核心判定 == 包装行为（放行 ⇔ toSendKeys 不抛策略错）
        let cross = true;
        for (const combo of BLOCK.concat(ALLOW)) {
            const allowed = KP.classify(combo).allowed;
            let threwPolicy = false;
            try { g.toSendKeys(combo); } catch (e) { threwPolicy = String((e && e.message) || '') === g.KEY_POLICY_DENY_MSG; }
            if (allowed === threwPolicy) { cross = false; ok('核心/包装交叉一致：' + combo, false, 'allowed=' + allowed + ' threwPolicy=' + threwPolicy); }
        }
        ok('核心判定与 toSendKeys 行为交叉一致（' + (BLOCK.length + ALLOW.length) + ' 组）', cross);
    }
    ok('geometry 被 require 但未污染 key-policy 测试', typeof GEOM.rectContains === 'function');
}

console.log('\n' + (fail === 0 ? '✅ key-policy：' : '❌ key-policy：') + 'PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
