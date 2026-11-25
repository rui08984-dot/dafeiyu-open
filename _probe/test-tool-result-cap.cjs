#!/usr/bin/env node
/**
 * _probe/test-tool-result-cap.cjs —— 工具回执体积上限（P0-2，2026-11-24）
 *
 * 要防的回归：
 *   ① 单条工具回执无上限 → 一轮 30 条消息能把 history 顶到 68k（telemetry 峰值 78,293）；
 *   ② 单轮累计无上限 → 十几个 dispatch 工具回执叠加（日志载荷 274,207 字符 / 26 条）；
 *   ③ 截断把 tool_call_id/name 弄丢 → 严格模式 API 报 400（tool_calls 必须成对）；
 *   ④ 截断不是确定性的 → 每次请求内容都变，前缀缓存永远重建；
 *   ⑤ 连续两次执行还在改内容（幂等性）。
 *
 * 2026-11-24 ADR-014：上限从 8k/24k 提到 **12k/32k**（配套 offset/artifact 续读），
 * 这里同步期望值；其余断言（成对、幂等、多模态不动）一条不删。
 *
 * 纯逻辑，不读写真实数据。
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const cap = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'ai', 'tool-result-cap.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// ── ① 纯函数 capText ────────────────────────────────────────────────────
{
    ok('默认上限 12k/32k（ADR-014）', cap.DEFAULTS.perResultChars === 12000 && cap.DEFAULTS.perTurnChars === 32000,
        JSON.stringify(cap.DEFAULTS));

    const short = cap.capText('短内容', 100);
    ok('短内容不改', short.capped === false && short.text === '短内容' && short.dropped === 0);

    // 11,800 字：在 12k 以内，不该被截（放宽后的关键断言：不能还按 8k 砍）
    const near = 'x'.repeat(11800);
    ok('11.8k 不再被截（旧 8k 会砍）', cap.capText(near).capped === false);

    const big = '头'.repeat(100) + '中'.repeat(19900) + '尾'.repeat(1000);   // 21,000 字
    const r = cap.capText(big, 12000);
    ok('超长内容被截断', r.capped === true && r.dropped > 0, 'len=' + r.text.length + ' dropped=' + r.dropped);
    ok('截断后长度不超过上限（幂等的前提）', r.text.length <= 12000, 'len=' + r.text.length);
    ok('保留头部', r.text.startsWith('头'.repeat(100)));
    ok('保留尾部', r.text.endsWith('尾'.repeat(1000)));
    ok('截断标记可读', /已截断 \d+ 字符/.test(r.text) && /runtime\.log/.test(r.text));
    ok('截断标记指向续读通道', /artifact|offset\/limit|next/.test(r.text), r.text.slice(0, 80));

    const arr = [{ type: 'text', text: 'x' }];
    ok('多模态数组不动（截图不在这条路径）', cap.capText(arr, 10).capped === false);

    ok('非法上限回默认 12000', cap.capText('x'.repeat(13000)).text.length <= 12000 + 300);
}

// ── ② 单条闸：所有 tool 消息（含历史）───────────────────────────────────
{
    const messages = [
        { role: 'system', content: 'S' },
        { role: 'user', content: '问' },
        { role: 'tool', name: 'see', tool_call_id: 'c1', content: 'A'.repeat(20000) },
        { role: 'assistant', content: '答' },
    ];
    const before = JSON.stringify(messages[2].content);
    const out = cap.enforceToolBudget(messages, 2, {});
    ok('历史 tool 回执被单条截断', out.capped === 1 && messages[2].content.length <= 12000 + 300,
        'capped=' + out.capped + ' len=' + messages[2].content.length);
    ok('截断保留 role/name/tool_call_id', messages[2].role === 'tool' && messages[2].name === 'see'
        && messages[2].tool_call_id === 'c1');
    ok('截断后的内容确实变了', JSON.stringify(messages[2].content) !== before);

    // 幂等：再跑一遍不再改
    const out2 = cap.enforceToolBudget(messages, 2, {});
    ok('重复执行幂等', out2.capped === 0 && out2.stubbed === 0, JSON.stringify(out2));
}

// ── ③ 单轮累计闸：从最旧省略、保留最新 ──────────────────────────────────
{
    const messages = [{ role: 'system', content: 'S' }, { role: 'user', content: '本轮问题' }];
    for (let i = 1; i <= 5; i += 1) {
        messages.push({ role: 'tool', name: 't' + i, tool_call_id: 'c' + i, content: '回'.repeat(10000) + i });
    }
    const newestMsg = messages[messages.length - 1];
    const out = cap.enforceToolBudget(messages, 1, { perResultChars: 12000, perTurnChars: 32000 });
    ok('累计超限后有回执被省略', out.stubbed >= 1, JSON.stringify(out));
    ok('累计后本轮 tool 回执总量 ≤32000', out.turnChars <= 32000, 'turnChars=' + out.turnChars);
    ok('最新一条没有被累计省略（只做了单条截断）',
        !/本轮工具输出累计超过/.test(String(newestMsg.content)) && String(newestMsg.content).length > 4000,
        'len=' + String(newestMsg.content).length);
    ok('最早一条被换成省略标记', /本轮工具输出累计超过/.test(String(messages[2].content)),
        String(messages[2].content).slice(0, 60));
    ok('省略不破坏成对关系', messages.every((m) => m.role !== 'tool' || !!m.tool_call_id));

    // 未超限不动
    const small = [
        { role: 'user', content: 'q' },
        { role: 'tool', name: 'x', tool_call_id: 'c1', content: '小结果' },
    ];
    const o2 = cap.enforceToolBudget(small, 0, {});
    ok('未超限完全不动', o2.capped === 0 && o2.stubbed === 0 && small[1].content === '小结果');
}

// ── ④ turnStartIndex 非法：只做单条闸，不做累计闸 ───────────────────────
{
    const messages = [
        { role: 'tool', name: 'old', tool_call_id: 'c0', content: '旧'.repeat(15000) },
        { role: 'user', content: 'q' },
        { role: 'tool', name: 'new', tool_call_id: 'c1', content: '新'.repeat(15000) },
    ];
    const out = cap.enforceToolBudget(messages, undefined, {});
    ok('turnStartIndex 缺失：两条都只做单条截断', out.capped === 2 && out.stubbed === 0, JSON.stringify(out));
    ok('turnStartIndex 缺失：没有累计省略标记', !/本轮工具输出累计超过/.test(String(messages[0].content))
        && !/本轮工具输出累计超过/.test(String(messages[2].content)));
}

// ── ⑤ 配置解析 ──────────────────────────────────────────────────────────
{
    const r = cap.resolveLimits({ perResultChars: 0, perTurnChars: -5 });
    ok('非法配置回默认 12k/32k', r.perResultChars === 12000 && r.perTurnChars === 32000, JSON.stringify(r));
    const r2 = cap.resolveLimits({ perResultChars: 1234, perTurnChars: 5678 });
    ok('合法配置生效', r2.perResultChars === 1234 && r2.perTurnChars === 5678);
}

console.log('\n' + (fail ? '✗' : '✓') + ' 工具回执上限：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
