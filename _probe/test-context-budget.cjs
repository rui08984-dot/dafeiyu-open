#!/usr/bin/env node
/**
 * _probe/test-context-budget.cjs — 上下文预算账本（C3，2026-11-21）
 *
 * 要防的回归：
 *   ① 易变尾巴被算进 history（section 分类失真）
 *   ② 常量漂移：context-budget 与 prompt-layout 的 VOLATILE_HEADER 不一致
 *   ③ 只测量不落盘（doctor 永远看不到）
 *   ④ p50/p90/增长源算错（拿 1 个样本当分布）
 *
 * 数据隔离：PET_TELEMETRY_DIR 指到临时目录（A2）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pet-ctxbudget-'));
process.env.PET_TELEMETRY_DIR = path.join(tmpRoot, 'runtime');

const APP = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const CB = require(path.join(APP, 'js', 'core', 'context-budget.js'));
const PL = require(path.join(APP, 'js', 'core', 'prompt-layout.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

try {
    // ① 估算口径
    ok('中文 1 字 ≈ 1 token', CB.estimateTokens('你好世界') === 4);
    ok('ASCII 4 字符 ≈ 1 token', CB.estimateTokens('abcd') === 1);
    ok('混合文本', CB.estimateTokens('你好abcd') === 3, String(CB.estimateTokens('你好abcd')));

    // ② 分类
    ok('system → system', CB.classifyMessage({ role: 'system', content: 's' }) === 'system');
    ok('普通 user → history', CB.classifyMessage({ role: 'user', content: '在吗' }) === 'history');
    ok('含易变标记的 user → volatile',
        CB.classifyMessage({ role: 'user', content: '帮我看看\n\n' + PL.VOLATILE_HEADER + '\n世界行' }) === 'volatile');
    ok('常量与 prompt-layout 一致（防漂移）', CB.VOLATILE_HEADER === PL.VOLATILE_HEADER,
        CB.VOLATILE_HEADER + ' vs ' + PL.VOLATILE_HEADER);

    // ③ measure
    const m = CB.measure({
        messages: [
            { role: 'system', content: '人格设定' },                       // 4 tokens
            { role: 'user', content: '你好' },                             // 2
            { role: 'assistant', content: '在的' },                         // 2
            { role: 'user', content: PL.VOLATILE_HEADER + '\n世界行' },      // ~12
        ],
        tools: [{ type: 'function', function: { name: 'see' } }],
    });
    ok('system 段 > 0', m.system > 0, 'system=' + m.system);
    ok('history 段 = 两轮对话', m.history === 4, 'history=' + m.history);
    ok('volatile 段单独统计', m.volatile > 0, 'volatile=' + m.volatile);
    ok('tools 段 > 0', m.tools > 0, 'tools=' + m.tools);
    ok('total = 各段之和', m.total === m.system + m.tools + m.history + m.volatile, 'total=' + m.total);
    ok('空输入不炸且全 0', CB.measure({}).total === 0);

    // ④ record → telemetry → recent 闭环（8 轮递增，验证增长源）
    for (let i = 0; i < 8; i += 1) {
        CB.record({
            messages: [
                { role: 'system', content: 'x'.repeat(40 + i * 20) },
                { role: 'user', content: 'y'.repeat(40) },
                { role: 'user', content: PL.VOLATILE_HEADER + '\n' + 'z'.repeat(20 + i * 40) },
            ],
            tools: [{ type: 'function', function: { name: 'see' } }],
        });
    }
    const r = CB.recent(20);
    ok('recent 读到 8 轮', r.n === 8, 'n=' + r.n);
    ok('p50/p90 是数字', Number.isFinite(r.sections.total_tokens.p50) && Number.isFinite(r.sections.total_tokens.p90),
        'p50=' + r.sections.total_tokens.p50 + ' p90=' + r.sections.total_tokens.p90);
    ok('p90 ≥ p50', r.sections.total_tokens.p90 >= r.sections.total_tokens.p50);
    ok('增长源识别出 volatile（数据里它涨得最快）', r.topGrowth[0] && r.topGrowth[0].key === 'volatile_tokens',
        JSON.stringify(r.topGrowth));
    ok('增长源 delta > 0', r.topGrowth[0] && r.topGrowth[0].delta > 0, 'delta=' + (r.topGrowth[0] && r.topGrowth[0].delta));

    // ⑤ telemetry 文件在临时目录（不污染真实 .runtime）
    const tel = path.join(tmpRoot, 'runtime', 'telemetry.jsonl');
    ok('遥测写进临时目录', fs.existsSync(tel) && fs.readFileSync(tel, 'utf8').includes('context.budget'));
} finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
