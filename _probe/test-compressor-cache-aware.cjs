#!/usr/bin/env node
/**
 * _probe/test-compressor-cache-aware.cjs —— 缓存感知压缩（ADR-014 轨道 1 / 交付 4）
 *
 * 验的是「摘要先持有、到水位才替换」的每一条路径：
 *   ① 8k 触发 → 只生成 + 持有，voiceChat.messages 一个字都不改（缓存不被打穿）
 *   ② 到 12k 水位 → 应用；结构 = initialSystem + [历史对话总结] + 摘要点之后的全部消息
 *   ③ 缓存冷（没有 lastUsage）→ 触发即应用（没有缓存可保）
 *   ④ tail 太长（摘要点之后 > budget）→ 丢弃 pending，消息不动，下轮少留几条再试
 *   ⑤ 连续快速回填（同一 3 轮内 2 次应用）→ 记录并退避 2 轮
 *   ⑥ 摘要失败 → 消息/游标不动，指数退避
 *   ⑦ 幂等：应用后 history 已降下来，下一轮不会再压
 *
 * 全部离线：fake voiceChat + fake LLM；PET_DATA_ROOT 指到 mkdtemp。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-compress-'));
process.env.PET_DATA_ROOT = TMP;
process.env.PET_TELEMETRY_DIR = TMP;

const CB = require(path.join(LIVE, 'js', 'core', 'context-budget.js'));
const UL = require(path.join(LIVE, 'js', 'core', 'usage-ledger.js'));
const Compressor = require(path.join(LIVE, 'plugins', 'built-in', 'context-compressor', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** nSys 条 system + nOther 条 user/assistant（chars 个「长」≈ chars token）。 */
function mkMsgs(nSys, nOther, chars) {
    const out = [];
    for (let i = 0; i < nSys; i += 1) out.push({ role: 'system', content: 'S' + i });
    for (let i = 0; i < nOther; i += 1) {
        out.push({ role: i % 2 ? 'assistant' : 'user', content: 'M' + i + '长'.repeat(chars || 0) });
    }
    return out;
}

function mkVC(msgs) {
    const vc = { messages: msgs.slice() };
    vc.conversationCore = {
        setMessages: (m) => { vc.messages = m; },
        getMessages: () => vc.messages,
    };
    return vc;
}

function mkPlugin(cfg, opts) {
    const o = opts || {};
    const p = new Compressor();
    p.context = {
        getPluginFileConfig: () => Object.assign({
            history_token_budget: 8000, history_growth_min: 4000,
            apply_at: 12000, max_hold_turns: 3, keep_recent: 4,
        }, cfg || {}),
        getConfig: () => ({}),
        log: () => {},
        callLLM: async () => {
            if (o.fail) throw new Error('LLM API error: 429');
            return o.summary || '这是一段历史摘要';
        },
    };
    return p;
}

/** 把「上一轮真实响应」摆成热缓存基线（与 llm-client 写的形状一致）。 */
function makeHot(messages) {
    const est = CB.measure({ messages, tools: [] });
    UL.setLastUsage({
        at: Date.now(),
        label: 'main',
        msgCount: messages.length,
        msgHashes: UL.fingerprints(messages),
        toolHash: UL.toolHash([]),
        estimated: { total: est.total, system: est.system, tools: est.tools, history: est.history, volatile: est.volatile },
        prompt_tokens: est.total,
    });
}

const nonSystemOf = (msgs) => msgs.filter((m) => m.role !== 'system');

async function main() {
// ── ① 8k 触发 → 生成但持有 ─────────────────────────────────────────────────
{
    UL.clearLastUsage();
    const msgs = mkMsgs(1, 30, 300);                 // history ≈ 9k
    const vc = mkVC(msgs);
    global.voiceChat = vc;
    makeHot(vc.messages);
    const p = mkPlugin();

    const before = vc.messages.map((m) => m.content).join('\u0001');
    await p.onLLMResponse({});
    await sleep(20);

    ok('8k：生成摘要但持有（messages 条数不变）', vc.messages.length === msgs.length, 'len=' + vc.messages.length);
    ok('8k：messages 内容一字未改', vc.messages.map((m) => m.content).join('\u0001') === before);
    ok('8k：pending 已生成', !!p._pending && p._pending.summary === '这是一段历史摘要');
    ok('8k：还没有写 _lastCompression（没替换）', !vc._lastCompression);
    ok('8k：pending 记录了摘要覆盖点与持有起点',
        p._pending.summaryUpToIndex === 22 && Number.isFinite(p._pending.at) && p._pending.heldTurns === 0,
        'upTo=' + p._pending.summaryUpToIndex);

    // ── ② 到 12k 水位 → 应用 ────────────────────────────────────────────────
    const extra = mkMsgs(0, 12, 300);                // 30 → 42 条非系统 ≈ 13k
    vc.messages.push(...extra);
    makeHot(vc.messages);
    const beforeApply = vc.messages.slice();
    await p.onLLMResponse({});
    await sleep(20);

    const comp = vc._lastCompression;
    ok('12k：pending 换成摘要（trigger=held/reason=apply_at）',
        !p._pending && comp && comp.trigger === 'held' && comp.reason === 'apply_at',
        comp && (comp.trigger + '/' + comp.reason));
    ok('12k：结构 = initialSystem + 总结 + 摘要点之后全部消息（不丢消息）',
        vc.messages.length === 1 + 1 + (42 - 22), 'len=' + vc.messages.length);
    ok('12k：总结是 system 且带 [历史对话总结]',
        vc.messages[1].role === 'system' && /^\[历史对话总结\]/.test(vc.messages[1].content));
    const tailAfter = vc.messages.slice(2);
    const origTail = nonSystemOf(beforeApply).slice(22);
    ok('12k：摘要点之后的 20 条原样保留（同顺序同内容）',
        tailAfter.length === origTail.length
        && tailAfter.every((m, i) => m.content === origTail[i].content),
        tailAfter.length + ' vs ' + origTail.length);
    ok('12k：记账 pre/post/truePost/heldMs 齐全',
        comp.preTokens > 0 && comp.historyTokensAfter > 0 && comp.truePostTokens === comp.historyTokensAfter
        && Number.isFinite(comp.heldMs) && comp.heldMs >= 0 && comp.dropped === 22 && comp.kept === 20,
        JSON.stringify({ pre: comp.preTokens, post: comp.historyTokensAfter, held: comp.heldMs }));
    ok('12k：willRetriggerNextTurn 是布尔（应用后是否仍 ≥ trigger）',
        typeof comp.willRetriggerNextTurn === 'boolean' && comp.willRetriggerNextTurn === (comp.historyTokensAfter >= 8000),
        String(comp.willRetriggerNextTurn));

    // ── ⑦ 幂等：应用后 history 降下来，下一轮不再压 ─────────────────────────
    const atBefore = comp.at;
    const lenBefore = vc.messages.length;
    await p.onLLMResponse({});
    await sleep(20);
    ok('幂等：应用后下一轮不再压（条数与记账时间不变）',
        vc.messages.length === lenBefore && vc._lastCompression.at === atBefore,
        'len=' + vc.messages.length);
}

// ── ②b 持有期间头部被硬裁 → 旧摘要作废（绝不把未摘要的旧消息替换掉）─────────
{
    UL.clearLastUsage();
    const msgs = mkMsgs(1, 30, 300);
    const vc = mkVC(msgs);
    global.voiceChat = vc;
    makeHot(vc.messages);
    const p = mkPlugin();
    await p.onLLMResponse({});
    await sleep(20);
    ok('头部改写前置：pending 已生成', !!p._pending && p._pending.summaryUpToIndex === 22);

    // 模拟 ContextManager 硬裁：砍掉最旧 3 条非系统消息（index 错位，边界指纹不再匹配）
    const sys = vc.messages.filter((m) => m.role === 'system');
    const ns = vc.messages.filter((m) => m.role !== 'system');
    vc.messages = sys.concat(ns.slice(3));
    await p.onLLMResponse({});
    await sleep(20);

    ok('头部被裁：没有应用旧摘要（不丢未摘要的旧消息）', !vc._lastCompression);
    ok('头部被裁：消息只少了被裁的 3 条', vc.messages.length === msgs.length - 3, 'len=' + vc.messages.length);
    ok('头部被裁：旧 pending 作废（若重新生成，覆盖点按新历史算）',
        !p._pending || p._pending.summaryUpToIndex !== 22,
        p._pending && String(p._pending.summaryUpToIndex));
}

// ── ③ 缓存冷（没有 lastUsage）→ 触发即应用 ────────────────────────────────
{
    UL.clearLastUsage();
    const msgs = mkMsgs(1, 30, 300);
    const vc = mkVC(msgs);
    global.voiceChat = vc;
    const p = mkPlugin();
    await p.onLLMResponse({});
    await sleep(20);
    const comp = vc._lastCompression;
    ok('缓存冷：没有缓存可保 → 立刻应用（immediate/cache_cold）',
        vc.messages.length < msgs.length && comp && comp.trigger === 'immediate' && comp.reason === 'cache_cold',
        comp && (comp.trigger + '/' + comp.reason));
    ok('缓存冷：应用后没有 pending 残留', p._pending === null);
}

// ── ④ tail 太长 → 丢弃 pending、消息不动、下轮少留几条 ─────────────────────
{
    UL.clearLastUsage();
    const cfg = { history_token_budget: 500, history_growth_min: 100, apply_at: 600, keep_recent: 4 };
    const msgs = mkMsgs(1, 20, 120);                  // history ≈ 2.4k；tail 8 条 ≈ 1k > 500
    const vc = mkVC(msgs);
    global.voiceChat = vc;
    const p = mkPlugin(cfg);
    await p.onLLMResponse({});
    await sleep(20);

    ok('tail 太长：丢弃 pending', p._pending === null);
    ok('tail 太长：消息完全不动（没丢任何一条）', vc.messages.length === msgs.length, 'len=' + vc.messages.length);
    ok('tail 太长：没有写 _lastCompression', !vc._lastCompression);
    ok('tail 太长：退避 2 轮', p._tailTooLongUntilTurn === p._turnIndex + 2,
        p._tailTooLongUntilTurn + ' vs ' + (p._turnIndex + 2));
    ok('tail 太长：下次少留几条（keep_recent 减半，仍然全进摘要不丢）', p._keepRecentHint === 2,
        String(p._keepRecentHint));
}

// ── ⑤ 连续快速回填 → 退避 2 轮 ────────────────────────────────────────────
{
    UL.clearLastUsage();
    const cfg = { history_token_budget: 8000, history_growth_min: 4000, apply_at: 12000, keep_recent: 4 };
    const p = mkPlugin();

    const vc1 = mkVC(mkMsgs(1, 30, 300));
    const r1 = await p._generate(vc1, p.context.getPluginFileConfig(), {
        immediate: true, budget: 8000, historyTokensBefore: 9000,
    });
    ok('快速回填：第一次应用成功', r1 === 'applied' && !!vc1._lastCompression);

    const vc2 = mkVC(mkMsgs(1, 30, 300));
    const r2 = await p._generate(vc2, p.context.getPluginFileConfig(), {
        immediate: true, budget: 8000, historyTokensBefore: 9000,
    });
    ok('快速回填：同一 3 轮内第二次应用被记录', r2 === 'applied'
        && vc2._lastCompression.rapidRefill === true && vc2._lastCompression.rapidRefillCount >= 1,
        JSON.stringify(vc2._lastCompression && { rr: vc2._lastCompression.rapidRefill, n: vc2._lastCompression.rapidRefillCount }));
    ok('快速回填：下一次允许时间推后 2 轮', p._rapidRefillUntilTurn === p._turnIndex + 2,
        p._rapidRefillUntilTurn + ' vs ' + (p._turnIndex + 2));

    // 闸内即使 history 又到 8k，也不生成（不丢数据，只是这轮不压）
    const vc3 = mkVC(mkMsgs(1, 30, 300));
    global.voiceChat = vc3;
    makeHot(vc3.messages);
    const before = vc3.messages.length;
    await p.onLLMResponse({});
    await sleep(20);
    ok('快速回填：闸内不再触发（消息不变、无 pending）',
        vc3.messages.length === before && p._pending === null && !vc3._lastCompression);
}

// ── ⑥ 摘要失败 → 消息/游标不动 + 指数退避 ─────────────────────────────────
{
    UL.clearLastUsage();
    const msgs = mkMsgs(1, 30, 300);
    const vc = mkVC(msgs);
    global.voiceChat = vc;
    const p = mkPlugin({}, { fail: true });
    const before = vc.messages.map((m) => m.content).join('\u0001');
    await p.onLLMResponse({});
    await sleep(20);

    ok('失败：messages 一字未改', vc.messages.map((m) => m.content).join('\u0001') === before);
    ok('失败：没有 pending', p._pending === null);
    ok('失败：指数退避已设置（5 分钟起）', p._compressionFails === 1 && p._nextAttemptAt > Date.now() + 4 * 60 * 1000,
        'fails=' + p._compressionFails);
    await p.onLLMResponse({});
    await sleep(20);
    ok('失败：退避期内不再撞（fails 不再增加）', p._compressionFails === 1);
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败不判红 */ }
process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
