#!/usr/bin/env node
/**
 * _probe/test-llm-tool-passthrough.cjs —— 发送前清理不再二次截断工具回执（2026-11-24）
 *
 * 根因：`llm-client._cleanMessagesForAPI` 里有一段 `MAX_CONTENT_LENGTH = 8000` 的硬截断，
 * 是 tool-result-cap 之前的旧防线。ADR-014 把体积控制统一到 `js/ai/tool-result-cap.js`
 * （宿主消息上单条 12000 / 单轮 32000，超出给 offset/limit/next 或 artifact 供模型续读），
 * 但发送前又砍回 8k —— **8k 以上全部消失，「可续读」永远读不到，12k/32k 等于没写**。
 *
 * 本测试钉住：
 *   ① 12,000 字符（CJK / ASCII）的 tool 回执经过 `_cleanMessagesForAPI` 后**仍是 12,000**；
 *   ② 任意长度（40k）不再被截断，也不再出现「内容过长已截断」标记；
 *   ③ 控制字符清理保留（\n \t 必须留）；④ tool_call_id / tool_calls / name 语义不变
 *      （宿主本来就不写 name → 不再伪造 'unknown_tool'；写了就原样透传）；
 *   ⑤ 配对关系仍由 sanitizeToolMessageSequence 守着（孤立 tool 丢弃、成对保留）。
 *
 * 纯函数级：只 new 一个客户端（不发请求、不连网、不写盘）。
 */
'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const { LLMClient } = require(path.join(LIVE, 'js', 'ai', 'llm-client.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const client = new LLMClient({ api_key: 'k', api_url: 'http://127.0.0.1:1/v1', model: 'm' });
const clean = (msgs) => client._cleanMessagesForAPI(msgs);

/** assistant(tool_calls) + tool 的合法最小序列（否则 sanitize 会把孤立 tool 丢掉）。 */
function pairWithToolResult(content, extraToolFields, callId) {
    const id = callId || 'call_1';
    return [
        { role: 'user', content: '读一下文件' },
        {
            role: 'assistant',
            content: null,
            tool_calls: [{ id, type: 'function', function: { name: 'file', arguments: '{"action":"read"}' } }],
        },
        Object.assign({ role: 'tool', content, tool_call_id: id }, extraToolFields || {}),
    ];
}

// ── ① 12,000 字符原样送到上游（本轮修复的核心断言）────────────────────────
{
    const ascii = 'x'.repeat(12000);
    const outA = clean(pairWithToolResult(ascii));
    const toolA = outA.find((m) => m.role === 'tool');
    ok('① 12,000 字符 ASCII tool 回执不被截断',
        !!toolA && toolA.content.length === 12000 && !toolA.content.includes('内容过长已截断'),
        'len=' + (toolA && toolA.content.length));
    ok('① 12,000 > 8k（可续读窗口真的到达模型）', !!toolA && toolA.content.length > 8000,
        String(toolA && toolA.content.length));

    const cjk = '记'.repeat(12000);
    const outB = clean(pairWithToolResult(cjk));
    const toolB = outB.find((m) => m.role === 'tool');
    ok('① 12,000 字符 CJK tool 回执不被截断',
        !!toolB && toolB.content.length === 12000, 'len=' + (toolB && toolB.content.length));
}

// ── ② 再长的回执也不再二次截断（上限只有 tool-result-cap 一处真源）─────────
{
    const huge = 'y'.repeat(40000);
    const tool = clean(pairWithToolResult(huge)).find((m) => m.role === 'tool');
    ok('② 40,000 字符原样保留（发送层不再设上限）',
        !!tool && tool.content.length === 40000, 'len=' + (tool && tool.content.length));
    ok('② 旧截断标记彻底消失', !!tool && !tool.content.includes('内容过长已截断'));
}

// ── ③ 控制字符清理保留 ──────────────────────────────────────────────────
{
    const dirty = 'a\x00b\x07c\nd\te\x7f';
    const tool = clean(pairWithToolResult(dirty)).find((m) => m.role === 'tool');
    ok('③ 控制字符被清掉、\\n 与 \\t 保留', !!tool && tool.content === 'abc\nd\te',
        JSON.stringify(tool && tool.content));
}

// ── ④ tool_call_id / tool_calls / name 语义不变 ─────────────────────────
{
    const out = clean(pairWithToolResult('结果', null, 'call_abc_DEF-123'));
    const asst = out.find((m) => m.role === 'assistant');
    const tool = out.find((m) => m.role === 'tool');
    ok('④ tool_call_id 原样透传', !!tool && tool.tool_call_id === 'call_abc_DEF-123', String(tool && tool.tool_call_id));
    ok('④ assistant.tool_calls 结构不变（id/type/function 全在）',
        !!asst && Array.isArray(asst.tool_calls) && asst.tool_calls[0].id === 'call_abc_DEF-123'
        && asst.tool_calls[0].type === 'function' && asst.tool_calls[0].function.name === 'file',
        JSON.stringify(asst && asst.tool_calls));
    ok('④ assistant(content=null + tool_calls) → content 变空串（API 要求）',
        !!asst && asst.content === '');
    ok('④ 宿主没给 name 时不伪造字段（旧代码会塞 unknown_tool）',
        !!tool && !Object.prototype.hasOwnProperty.call(tool, 'name'), JSON.stringify(tool));
    const withName = clean(pairWithToolResult('结果', { name: 'file' })).find((m) => m.role === 'tool');
    ok('④ 调用方给了 name 就原样透传', !!withName && withName.name === 'file', String(withName && withName.name));
}

// ── ⑤ 配对守卫仍在（截断没了，序列合法性不能跟着丢）────────────────────
{
    const paired = clean(pairWithToolResult('ok'));
    ok('⑤ 成对的 assistant(tool_calls)+tool 都保留，顺序不变',
        paired.length === 3 && paired[1].role === 'assistant' && paired[1].tool_calls
        && paired[2].role === 'tool', paired.map((m) => m.role).join(','));

    const orphan = clean([{ role: 'user', content: 'hi' }, { role: 'tool', content: 'x'.repeat(12000), tool_call_id: 'nope' }]);
    ok('⑤ 孤立 tool（前面没有对应 tool_calls）仍被丢弃',
        orphan.length === 1 && orphan[0].role === 'user', orphan.map((m) => m.role).join(','));
}

// ── ⑥ 非字符串 content 仍按老规矩归一化 ─────────────────────────────────
{
    const objTool = clean(pairWithToolResult({ rows: [1, 2, 3], note: '结构体回执' })).find((m) => m.role === 'tool');
    ok('⑥ 对象 content → JSON 字符串（不是 [object Object]）',
        !!objTool && objTool.content.startsWith('{"rows":[1,2,3]'), String(objTool && objTool.content).slice(0, 40));
    const numTool = clean(pairWithToolResult(0)).find((m) => m.role === 'tool');
    ok('⑥ 数字/空值 content → 字符串（0 不丢成空）', !!numTool && numTool.content === '0', JSON.stringify(numTool && numTool.content));
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
