#!/usr/bin/env node
/**
 * _probe/test-cache-layout.cjs — prompt 前缀缓存布局回归（2026-11-16 六十二轮）
 *
 * 防的是「改造被悄悄改回去」：
 *   稳定注入必须在 system（身份/规则/核心记忆），**每轮易变的注入必须在最后一条 user**。
 *   只要有人把 volatile 标记摘掉、或者把易变文本又拼进 system，
 *   上游的字节前缀缓存就会整段作废（实测 97.4% → 83.8%）。
 *
 * 覆盖：
 *   ① prompt-layout 纯函数（追加位置/多模态/去重/截断/指纹/usage 解析）
 *   ② plugin-context 的 volatile 通道（不进 system、可被收集、可移除）
 *   ③ 源码级护栏：识别的易变生产者必须带 { volatile: true }
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const PL = require(path.join(LIVE, 'js', 'core', 'prompt-layout.js'));
const PC = require(path.join(LIVE, 'js', 'core', 'plugin-context.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

async function main() {
// ── ① 纯函数 ─────────────────────────────────────────────────────────────
{
    const sys = 'BASE 系统提示（稳定）';
    const user = '今天吃啥';
    const msgs = [
        { role: 'system', content: sys },
        { role: 'user', content: '上一轮问题' },
        { role: 'assistant', content: '上一轮回答' },
        { role: 'user', content: user },
    ];
    const r = PL.appendVolatile(msgs, ['（你想起了一些相关旧事）', '（你现在的状态：犯困；3 分钟前）']);
    ok('易变注入拼到最后一条 user', r.ok && r.target === 3 && /相关旧事/.test(msgs[3].content), 'target=' + r.target);
    ok('易变注入没有进 system', msgs[0].content === sys, msgs[0].content.slice(0, 24));
    ok('前面那条 user 不被污染', msgs[1].content === '上一轮问题');
    ok('带「不必回应」声明', /系统补充，不必回应/.test(msgs[3].content));
    ok('多段之间空行分隔', /相关旧事[\s\S]*\n\n[\s\S]*犯困/.test(msgs[3].content));
}

{
    // 多模态：content 是数组时必须追加 text part，不能把数组变成字符串
    const msgs = [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:x' } }] }];
    PL.appendVolatile(msgs, ['补充']);
    ok('多模态追加 text part', Array.isArray(msgs[0].content) && msgs[0].content.length === 3
        && msgs[0].content[2].type === 'text', 'len=' + msgs[0].content.length);
    ok('多模态图片仍在', msgs[0].content[1].type === 'image_url');
}

{
    // 没有 user（工具循环里全是 tool 结尾）→ 补一条，不能丢注入
    const msgs = [{ role: 'system', content: 'S' }, { role: 'assistant', content: null }, { role: 'tool', content: '结果' }];
    const r = PL.appendVolatile(msgs, ['易变']);
    ok('无 user 时补一条 user', r.ok && msgs[msgs.length - 1].role === 'user' && /易变/.test(msgs[msgs.length - 1].content));
}

{
    const r0 = PL.appendVolatile([{ role: 'user', content: 'x' }], []);
    ok('空列表不注入', r0.ok === false && r0.reason === 'empty');
    const r1 = PL.appendVolatile([], ['x']);
    ok('无消息不注入', r1.ok === false && r1.reason === 'no-messages');
    const msgs = [{ role: 'user', content: 'x' }];
    const r2 = PL.appendVolatile(msgs, ['同一段', '同一段']);
    ok('重复文本去重', r2.count === 1 && (msgs[0].content.match(/同一段/g) || []).length === 1);
    const big = 'x'.repeat(PL.MAX_VOLATILE_CHARS + 500);
    const msgs2 = [{ role: 'user', content: 'y' }];
    const r3 = PL.appendVolatile(msgs2, [big]);
    ok('超长截断', r3.truncated === true && msgs2[0].content.length < big.length + 200, 'len=' + msgs2[0].content.length);
}

{
    ok('systemText 字符串形态', PL.systemText([{ role: 'system', content: 'A' }]) === 'A');
    const arr = [{ role: 'system', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }];
    ok('systemText 数组形态', PL.systemText(arr) === 'AB');
    ok('systemText 没有 system → 空串', PL.systemText([{ role: 'user', content: 'x' }]) === '');
}

{
    ok('hash 稳定', PL.hashText('同一个字符串') === PL.hashText('同一个字符串'));
    ok('hash 能发现一个字节变化', PL.hashText('abc') !== PL.hashText('abd'));
    ok('hash 长度 8', /^[0-9a-f]{8}$/.test(PL.hashText('x')));
}

{
    const a = PL.cacheRate({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 950 } });
    ok('usage: prompt_tokens_details.cached_tokens', a.prompt === 1000 && a.cached === 950 && a.rate === 95);
    const b = PL.cacheRate({ input_tokens: 2000, prompt_cache_hit_tokens: 1000 });
    ok('usage: prompt_cache_hit_tokens 变体', b.prompt === 2000 && b.cached === 1000 && b.rate === 50);
    const c = PL.cacheRate({ prompt_tokens: 800 });
    ok('没有 cached 字段 → null（不当 0）', c.prompt === 800 && c.cached === null && c.rate === null);
    ok('usage 缺失 → 全 null', PL.cacheRate(null).rate === null);
}

// ── ② plugin-context 的 volatile 通道 ────────────────────────────────────
{
    const SYS = 'BASE';
    global.voiceChat = { messages: [{ role: 'system', content: SYS }, { role: 'user', content: 'hi' }] };

    const ctxA = new PC.PluginContext('test-stable', {}, null);
    const ctxB = new PC.PluginContext('test-volatile', {}, null);

    ctxA.addSystemPromptPatch('t-stable', '稳定补丁');
    ok('稳定补丁进 system', /稳定补丁/.test(global.voiceChat.messages[0].content), global.voiceChat.messages[0].content.slice(0, 40));

    ctxB.addSystemPromptPatch('t-volatile', '易变补丁', { volatile: true });
    ok('volatile 不进 system', !/易变补丁/.test(global.voiceChat.messages[0].content));
    ok('system 里只剩稳定补丁', /稳定补丁/.test(global.voiceChat.messages[0].content)
        && !/易变补丁/.test(global.voiceChat.messages[0].content));

    const collected = PC.collectVolatilePromptPatches();
    ok('volatile 可被收集', collected.includes('易变补丁'), collected.join('|'));

    const stats = PC.promptPatchLayoutStats();
    ok('布局统计可读', stats.stable >= 1 && stats.volatile >= 1, JSON.stringify(stats));

    // 端到端：钩子里 addVolatile + 补丁表 → 只落在 user
    const msgs = [{ role: 'system', content: global.voiceChat.messages[0].content }, { role: 'user', content: '问句' }];
    const volatileTexts = [];
    volatileTexts.push('钩子里的易变段');
    for (const t of PC.collectVolatilePromptPatches()) volatileTexts.push(t);
    PL.appendVolatile(msgs, volatileTexts);
    ok('端到端：system 只含稳定补丁', /稳定补丁/.test(msgs[0].content) && !/易变补丁|钩子里的易变段/.test(msgs[0].content));
    ok('端到端：user 含两路易变注入', /易变补丁/.test(msgs[1].content) && /钩子里的易变段/.test(msgs[1].content));

    // 移除后 system 回到 BASE（不残留分隔符）
    ctxA.removeSystemPromptPatch('t-stable');
    ctxB.removeSystemPromptPatch('t-volatile');
    // §72：plugin-context 会在 system 末尾恒定追加 mood 格式指令（程序契约，不是插件补丁）。
    // 所以「回到 BASE」的正确口径是 BASE + MOOD_INSTRUCTION —— 直接 import 那份常量，
    // 以后改文案这里不会误红（断言仍然守住「补丁移除后不残留」这条真正的不变量）。
    const { MOOD_INSTRUCTION } = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'ai', 'mood-line.js'));
    ok('全部移除后 system 回到 BASE + mood 指令（不残留补丁）',
      global.voiceChat.messages[0].content === SYS + MOOD_INSTRUCTION,
      JSON.stringify(global.voiceChat.messages[0].content).slice(-160));
    ok('移除后收集为空', PC.collectVolatilePromptPatches().length === 0);
}

// ── ②b 上下文压缩必须带回差（不是每轮都压）────────────────────────────────
// 实测真 bug：配置 24 条触发 / 保留 8 轮，压完却是 27 条 > 24 → 每轮都压，
// 每轮改写 history → 缓存永远只剩 system+tools 那段。
{
    const Compressor = require(path.join(LIVE, 'plugins', 'built-in', 'context-compressor', 'index.js'));
    const mk = (nSys, nOther) => {
        const msgs = [];
        for (let i = 0; i < nSys; i += 1) msgs.push({ role: 'system', content: 'S' + i });
        for (let i = 0; i < nOther; i += 1) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'M' + i });
        return msgs;
    };
    const probe = (nSys, nOther) => {
        const p = new Compressor();
        let called = 0;
        p._compress = async () => { called += 1; };
        p.context = {
            getPluginFileConfig: () => ({ trigger_threshold: 24, keep_recent: 8 }),
            log: () => {},
        };
        global.voiceChat = { messages: mk(nSys, nOther) };
        return p.onLLMResponse({ text: 'x' }).then(() => called);
    };
    // trigger = max(24, (11+1+16) × 4) = 112
    ok('压缩：56 条不触发（用户拍板再拉长一倍）', (await probe(11, 45)) === 0);
    ok('压缩：112 条触发', (await probe(11, 101)) === 1);
    ok('压缩：压完 28 条后下一轮不再触发', (await probe(11, 17)) === 0);

    // 压缩写回必须同时更新 facade（否则下一轮看到的还是旧数组 → 每轮都压）
    {
        const p = new Compressor();
        let stored = null;
        const vc = { messages: mk(11, 40) };
        vc.conversationCore = {
            setMessages: (m) => { stored = m; },
            getMessages: () => stored || vc.messages,
        };
        p.context = {
            getPluginFileConfig: () => ({ trigger_threshold: 24, keep_recent: 8 }),
            log: () => {},
            callLLM: async () => '这段是摘要',
        };
        global.voiceChat = vc;
        await p._compress(vc, { trigger_threshold: 24, keep_recent: 8, prompt: 'x' });
        ok('压缩：facade 与 core 指向同一份历史', vc.messages === vc.conversationCore.getMessages(),
            'facade=' + vc.messages.length + ' core=' + vc.conversationCore.getMessages().length);
        ok('压缩：压完条数 = 11 system + 1 总结 + 16 近期 = 28', vc.messages.length === 28, 'len=' + vc.messages.length);
    }
    delete global.voiceChat;
}

// ── ②c 滑动窗口裁剪也要带回差（否则每轮改写 history 前缀）────────────────
{
    const { ContextManager } = require(path.join(LIVE, 'js', 'ai', 'ContextManager.js'));
    const mkMsgs = (n) => {
        const out = [{ role: 'system', content: 'S' }];
        for (let i = 0; i < n; i += 1) out.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
        return out;
    };
    const mk = (n) => {
        const vc = { enableContextLimit: true, maxContextMessages: 24, messages: mkMsgs(n) };
        return { vc, cm: new ContextManager(vc) };
    };

    // hardTrigger = max(24+8, 96) = 96（总条数，含 system）
    const a = mk(30);
    a.cm.trimMessages();
    ok('裁剪：30 条不动（回差内，history 只增不改）', a.vc.messages.length === 31, 'len=' + a.vc.messages.length);

    const b = mk(100);
    b.cm.trimMessages();
    ok('裁剪：100 条裁回上限（非 system ≤ 24）', b.vc.messages.filter((m) => m.role !== 'system').length <= 24,
        'nonSys=' + b.vc.messages.filter((m) => m.role !== 'system').length);

    // 工具链不能拦腰截断：边界处的 assistant+tool_calls 与 tool 要么都留、要么都走
    const msgs = [{ role: 'system', content: 'S' }];
    for (let i = 0; i < 90; i += 1) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
    msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] });
    msgs.push({ role: 'tool', content: 'r', tool_call_id: 'c1' });
    for (let i = 0; i < 10; i += 1) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'n' + i });
    const cvc = { enableContextLimit: true, maxContextMessages: 24, messages: msgs };
    new ContextManager(cvc).trimMessages();
    const tail = cvc.messages;
    const hasOrphanTool = tail.some((m, i) => m.role === 'tool' && tail[i - 1] && tail[i - 1].role !== 'assistant');
    const hasDanglingCalls = tail.some((m, i) => m.role === 'assistant' && Array.isArray(m.tool_calls)
        && !(tail[i + 1] && tail[i + 1].role === 'tool'));
    ok('裁剪：工具链不截断（无孤儿 tool / 无悬空 tool_calls）', !hasOrphanTool && !hasDanglingCalls,
        'orphan=' + hasOrphanTool + ' dangling=' + hasDanglingCalls);
}

// ── ②d 工具 schema 必须稳定出现（不能按意图在 9k/3.3k 两种前缀间来回切）──────
{
    const IR = require(path.join(LIVE, 'js', 'ai', 'intent-router.js'));
    ok('工具 schema 默认不省（前缀保持一种形态）',
        IR.shouldOmitTools({ intent: 'chat', confidence: 0.9 }, { llm: {} }) === false);
    ok('老行为可显式开回（omit_tools=true）',
        IR.shouldOmitTools({ intent: 'chat', confidence: 0.9 }, { llm: { intent_router: { omit_tools: true } } }) === true);
    ok('工具轮永远带 schema',
        IR.shouldOmitTools({ intent: 'tool', confidence: 0.99 }, { llm: { intent_router: { omit_tools: true } } }) === false);
}

// ── ②e 流式 TTS 的「文本→表情」必须真的会切脸 ─────────────────────────────
{
    const Volc = require(path.join(LIVE, 'js', 'voice', 'volcengine-streaming.js'));
    const s = Object.create(Volc.VolcengineStreamingSession.prototype);
    const calls = [];
    s.emotionMapper = { applyTextEmotion: (t) => calls.push(t) };
    s._emoBuf = ''; s._emoBufStart = 0; s._subtitleCharIdx = 0; s.stopped = false;
    s._queueSentenceEmotion('今天真的太开心了。', '今天真的太开心了。');
    await new Promise((r) => setTimeout(r, 900));
    ok('流式 TTS：整句进表情推断', calls.length === 1 && /开心/.test(calls[0]), JSON.stringify(calls));
    // 带标签的片段交给老标签通道，不双触发
    const before = calls.length;
    s._queueSentenceEmotion('随便一句。', '<开心>随便一句。');
    await new Promise((r) => setTimeout(r, 900));
    ok('流式 TTS：带标签片段不双触发', calls.length === before);
}

// ── ③ 源码级护栏：识别的易变生产者必须带 volatile ─────────────────────────
{
    const read = (rel) => fs.readFileSync(path.join(LIVE, rel), 'utf8');

    const cases = [
        ['plugins/community/memory-recall/index.js', ["'memory-recall-context'", "'memory-recall-remembered'", "'memory-recall-forgotten'", "'memory-recall-reunion'"]],
        ['plugins/built-in/memos/index.js', ["'memos-recall'"]],
        ['plugins/community/watch-screen/index.js', ["'watch-screen-cowatch'"]],
        ['plugins/community/alive-state/index.js', ['PATCH_ID, model.describe']],
        ['plugins/community/inner-state/index.js', ['PATCH_ID, lines.join']],
    ];
    for (const [rel, needles] of cases) {
        const src = read(rel);
        for (const n of needles) {
            // 只找 add 调用（remove 调用里也有同一个 id，会误判）
            const idx = src.indexOf('addSystemPromptPatch(' + n);
            const tail = idx >= 0 ? src.slice(idx, idx + 1200) : '';
            ok('源码护栏 ' + rel.split('/').pop() + ' · ' + n + ' 带 volatile',
                idx >= 0 && /volatile:\s*true/.test(tail));
        }
    }
    // 静态指令类**不该**被误标成易变（它们本来就该留在 system）
    const ws = read('plugins/community/watch-screen/index.js');
    const passiveArea = ws.slice(ws.indexOf('addSystemPromptPatch(PATCH_ID_PASSIVE'), ws.indexOf('addSystemPromptPatch(PATCH_ID_PASSIVE') + 200);
    ok('静态指令没被误标（watch-screen passive）', !/volatile/.test(passiveArea));
    const dyn = read('plugins/community/dynamic-persona/index.js');
    ok('dynamic-persona 走 addVolatile', /request\.addVolatile\(/.test(dyn));

    // 世界感知（2026-11-17 六十二轮）：世界状态**只能**走易变尾巴。
    // 这条护栏防的是「有人图方便把它挪进 system」—— 那会直接打穿前缀缓存。
    const worldSrc = read('plugins/community/world-sense/index.js');
    ok('world-sense 走 request.addVolatile', /request\.addVolatile\(/.test(worldSrc));
    ok('world-sense 不往 system 里塞动态内容', !/addSystemPromptPatch\s*\(/.test(worldSrc));
    // 2026-11-21：共享的数据边界补丁是**固定文本**（不随世界状态变），不破前缀缓存；
    // 动态世界行仍然只走 addVolatile。
    ok('world-sense 用共享数据边界补丁', /ensureBoundaryPatch\(this\.context\)/.test(worldSrc));
    ok('world-sense 没有直接改 messages（必须走 appendVolatile）', !/messages\s*\[\s*i\s*\]\s*=\s*\{/.test(worldSrc));
}
{
    delete global.voiceChat;
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
