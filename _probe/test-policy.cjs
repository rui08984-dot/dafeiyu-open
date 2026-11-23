#!/usr/bin/env node
/**
 * _probe/test-policy.cjs — 统一策略门（D7，2026-11-22）
 *
 * 要防的回归：
 *   ① 高危动作不拦（file write / code run / note delete / memory correct）
 *   ② 拦过头（日常 act 点击、app close 被误拦 → 功能变烦）
 *   ③ 无人值守时照做（夜里没人看着还改数据）
 *   ④ 拒绝不留痕（approvals.jsonl 没有记录）或留了明文参数
 *   ⑤ policy.json 覆盖不生效（用户想自定义却改不动）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

const tmpRoot = iso.setUpTempDataRoot('pet-policy-');
const P = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'policy.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
const D = (o) => P.decide(Object.assign({ unattended: false }, o));

try {
    ok('数据目录已隔离', iso.assertIsolated(path.join(tmpRoot, 'data', 'approvals.jsonl')), tmpRoot);

    // ① 高危动作要 ask（有人时）
    ok('file write → ask', D({ tool: 'file', action: 'write' }).decision === 'ask');
    ok('code run → ask', D({ tool: 'code', action: 'run' }).decision === 'ask');
    ok('note delete → ask', D({ tool: 'note', action: 'delete' }).decision === 'ask');
    ok('memory correct → ask', D({ tool: 'memory', action: 'correct' }).decision === 'ask');

    // ② 不误伤日常
    ok('act click → allow（日常点击不拦）', D({ tool: 'act', action: 'click' }).decision === 'allow');
    ok('app close → allow（用户明确指令）', D({ tool: 'app', action: 'close' }).decision === 'allow');
    ok('file list → allow（只读动作）', D({ tool: 'file', action: 'list' }).decision === 'allow');
    ok('see → allow（只读工具）', D({ tool: 'see', mode: 'windows' }).decision === 'allow');
    ok('dispatch_to_dsh → allow（核心功能）', D({ tool: 'dispatch_to_dsh', action: 'run' }).decision === 'allow');
    ok('未注解工具 → allow（默认不拦）', D({ tool: 'no_such_tool_xyz', action: 'x' }).decision === 'allow');

    // ③ 无人值守
    const u = P.decide({ tool: 'file', action: 'write', unattended: true });
    ok('无人值守 + file write → deny', u.decision === 'deny', u.reason.slice(0, 40));
    ok('无人值守 + act click → 仍 allow（只读/日常不拦）',
        P.decide({ tool: 'act', action: 'click', unattended: true }).decision === 'allow');

    // ④ 显式确认放行
    ok('file write + confirm → allow', D({ tool: 'file', action: 'write', params: { confirm_destructive: true } }).decision === 'allow');
    ok('无人值守 + confirm → allow（用户回来后显式点名）',
        P.decide({ tool: 'file', action: 'write', unattended: true, params: { confirm_destructive: true } }).decision === 'allow');

    // ⑤ 留痕：deny/ask 有记录、allow 没有、参数不落明文
    const appr = path.join(tmpRoot, 'data', 'approvals.jsonl');
    const raw = fs.existsSync(appr) ? fs.readFileSync(appr, 'utf8') : '';
    ok('approvals.jsonl 有记录', raw.includes('"tool":"file"'));
    ok('allow 不写留痕', !raw.includes('"tool":"see"'));
    ok('参数只存 hash（无明文）', /"paramsHash":"[0-9a-f]{16}"/.test(raw) && !raw.includes('SECRET_PLAINTEXT'));
    // 上面没传过 SECRET，显式再打一条带机密的
    D({ tool: 'file', action: 'write', params: { content: 'SECRET_PLAINTEXT' } });
    ok('机密参数不落盘', !fs.readFileSync(appr, 'utf8').includes('SECRET_PLAINTEXT'));

    // ⑥ policy.json 覆盖（最后匹配生效）
    const dir = path.join(tmpRoot, 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify([
        { match: { tool: 'file', action: 'write' }, decision: 'allow', reason: '测试：允许写' },
        { match: { tool: 'act' }, decision: 'deny', reason: '测试：拦所有 act' },
    ]), 'utf8');
    P._resetCaches();
    const w = D({ tool: 'file', action: 'write' });
    ok('policy.json 能放行内置高危', w.decision === 'allow' && w.source === 'policy.json', w.reason);
    const a = D({ tool: 'act', action: 'click' });
    ok('policy.json 能拦日常动作', a.decision === 'deny' && a.source === 'policy.json', a.reason);

    // ⑦ 评测豁免无人值守
    globalThis.__AGENT_EVAL__ = true;
    ok('评测运行中不算无人值守', P.isUnattended(Date.now() + 60 * 60 * 1000) === false);
    delete globalThis.__AGENT_EVAL__;
    globalThis.__lastUserInputAt = Date.now() - 11 * 60 * 1000;
    ok('11 分钟没输入 → 无人值守', P.isUnattended() === true);
    globalThis.__lastUserInputAt = Date.now();
    ok('刚说过话 → 有人', P.isUnattended() === false);

    // ⑧ 计数可观测
    const st = P.stats();
    ok('stats 有 allow/deny/ask 计数', st.counts.allow > 0 && st.counts.deny > 0 && st.counts.ask > 0, JSON.stringify(st.counts));
    ok('stats 能数到注解工具', st.annotations >= 15, 'annotations=' + st.annotations);
} finally {
    iso.cleanup(tmpRoot);
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
