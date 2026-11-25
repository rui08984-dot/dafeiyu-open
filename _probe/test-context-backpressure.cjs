#!/usr/bin/env node
/**
 * _probe/test-context-backpressure.cjs —— 紧急背压：enable_limit=false 也要按 token 裁（2026-11-25）
 *
 * 要防的回归：
 *   ① 关掉条数限制后历史无限涨（单轮工具循环能顶到 48k），一路到上游 400 / 费用失控；
 *   ② 条数闸与 token 闸的优先级搞反（先减半、后按 16 条，导致该留的没留）；
 *   ③ 裁剪审计账（_lastTrim）缺字段，事后只能猜「她为什么忘了前面」；
 *   ④ system 消息被当成普通历史裁掉。
 *
 * 离线：context-budget 走估算（清掉 lastUsage 基线），不读真实遥测。
 */
'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const { ContextManager } = require(path.join(LIVE, 'js', 'ai', 'ContextManager.js'));
const CB = require(path.join(LIVE, 'js', 'core', 'context-budget.js'));
const usageLedger = require(path.join(LIVE, 'js', 'core', 'usage-ledger.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const NON = (n) => '历'.repeat(n);   // CJK 1 字 ≈ 1 token

/** 造 N 条对话消息（每条 len 字，CJK → len token）。 */
function buildHistory(count, len) {
    const msgs = [{ role: 'system', content: '稳定人设（不许裁）' }];
    for (let i = 0; i < count; i += 1) {
        msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: NON(len) + '#' + i });
    }
    return msgs;
}
function makeVC(messages, opts) {
    const o = opts || {};
    return {
        messages,
        enableContextLimit: o.enableContextLimit === true,
        maxContextMessages: o.maxContextMessages || 16,
        config: { context: o.context || {} },
        _lastTrim: null,
    };
}
const historyTokens = (msgs) => CB.measure({ messages: msgs }).history;

try {
    usageLedger.clearLastUsage();   // 走全量估算口径（可重复）

    // ══════════════════════════════════════════════════════════════════
    // ① enable_limit=false + 48k 历史 → 仍按 token 裁到 ≤24k
    // ══════════════════════════════════════════════════════════════════
    {
        console.log('\n[①] 关掉条数限制，token 闸仍生效');
        const msgs = buildHistory(60, 800);          // 60 × 800 ≈ 48k token
        ok('① 前置：history 约 48k（> 24k 硬上限）', historyTokens(msgs) > 40000,
            String(historyTokens(msgs)));
        const vc = makeVC(msgs, { enableContextLimit: false });
        const cm = new ContextManager(vc);
        cm.trimMessages();
        const after = historyTokens(vc.messages);
        const nonSystem = vc.messages.filter((m) => m.role !== 'system');
        ok('① 裁后 history ≤ 24k', after <= 24000, 'after=' + after);
        ok('① 保留条数 ≥ 4（背压不是为了把对话砍光）', nonSystem.length >= 4, 'n=' + nonSystem.length);
        ok('① system 一条都没少', vc.messages.filter((m) => m.role === 'system').length === 1
            && /稳定人设/.test(String(vc.messages[0].content)));
        ok('① 保留的是**最新**的那几条', String(nonSystem[nonSystem.length - 1].content).endsWith('#59'),
            String(nonSystem[nonSystem.length - 1].content).slice(-6));
        const t = vc._lastTrim;
        ok('① _lastTrim 记录完整（能对账）',
            !!t && t.reason === 'tokens' && t.countGateEnabled === false
            && Number.isFinite(t.historyTokensBefore) && Number.isFinite(t.historyTokensAfter)
            && t.historyTokensAfter <= t.hardTokenLimit
            && t.messagesAfter === vc.messages.length && t.dropped > 0
            && typeof t.firstKeptMessageId === 'string',
            t && JSON.stringify({ reason: t.reason, before: t.historyTokensBefore, after: t.historyTokensAfter, dropped: t.dropped }));
        ok('① historySource 是 estimate（没有真账基线）', t && t.historySource === 'estimate', t && t.historySource);
    }

    // ══════════════════════════════════════════════════════════════════
    // ② 条数闸 16 + token 闸同时生效：先按 16 条，再按 token 减半
    // ══════════════════════════════════════════════════════════════════
    {
        console.log('\n[②] 两条闸同时生效的优先级');
        // 2a. history 12k（>8k 软线，<24k 硬线）：条数闸先动手
        const msgs = buildHistory(60, 200);           // ≈12k token
        const vc = makeVC(msgs, { enableContextLimit: true, maxContextMessages: 16 });
        const cm = new ContextManager(vc);
        cm.trimMessages();
        const nonSystem = vc.messages.filter((m) => m.role !== 'system');
        ok('② history>8k 时条数闸按 16 条裁', nonSystem.length === 16, 'n=' + nonSystem.length);
        ok('② reason=count（token 没超）', vc._lastTrim.reason === 'count', vc._lastTrim.reason);
        ok('② countGateEnabled=true', vc._lastTrim.countGateEnabled === true);

        // 2b. 60 × 1000 ≈ 60k：两条闸都超 → 先 16 条、再减半到 token 达标
        const msgs2 = buildHistory(60, 1000);
        const vc2 = makeVC(msgs2, { enableContextLimit: true, maxContextMessages: 16 });
        new ContextManager(vc2).trimMessages();
        const non2 = vc2.messages.filter((m) => m.role !== 'system');
        const h2 = historyTokens(vc2.messages);
        ok('② 两闸都超时最终 history ≤ 24k', h2 <= 24000, 'history=' + h2);
        ok('② 条数也 ≤ 16（token 减半只会更少）', non2.length <= 16, 'n=' + non2.length);
        ok('② reason=tokens（token 闸是最后决定性的那个）', vc2._lastTrim.reason === 'tokens', vc2._lastTrim.reason);
        ok('② 减半过程留在账里（historyTokensAfter 与最终一致）',
            vc2._lastTrim.historyTokensAfter === h2, vc2._lastTrim.historyTokensAfter + ' vs ' + h2);
    }

    // ══════════════════════════════════════════════════════════════════
    // ③ 未超限不动手（别每轮都裁，前缀缓存会碎）
    // ══════════════════════════════════════════════════════════════════
    {
        console.log('\n[③] 未超限不动手');
        const msgs = buildHistory(20, 100);      // ≈2k token
        const vc = makeVC(msgs, { enableContextLimit: false });
        const before = vc.messages.slice();
        new ContextManager(vc).trimMessages();
        ok('③ 未超 token 上限：消息数组原样（连引用都没换）',
            vc.messages.length === before.length && vc.messages === vc.messages
            && vc._lastTrim === null);
        const vc2 = makeVC(buildHistory(20, 100), { enableContextLimit: true, maxContextMessages: 16 });
        new ContextManager(vc2).trimMessages();
        ok('③ 条数没到 hardTrigger（96 / 48）也不裁', vc2.messages.length === 21 && vc2._lastTrim === null,
            'n=' + vc2.messages.length);
    }

    // ══════════════════════════════════════════════════════════════════
    // ④ 工具轮不可分割（裁到工具链中间 = 下次请求 400）
    // ══════════════════════════════════════════════════════════════════
    {
        console.log('\n[④] 工具轮原子性');
        const msgs = [{ role: 'system', content: 'S' }];
        for (let i = 0; i < 30; i += 1) msgs.push({ role: 'user', content: NON(700) + '#' + i });
        // 末尾一条完整工具轮（assistant.tool_calls + tool）
        msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: 'cX', type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
        msgs.push({ role: 'tool', name: 'read_file', content: NON(900), tool_call_id: 'cX' });
        const vc = makeVC(msgs, { enableContextLimit: false });
        new ContextManager(vc).trimMessages();
        const out = vc.messages;
        const hasOrphanTool = out.some((m, i) => m.role === 'tool' && !(out[i - 1] && out[i - 1].role === 'assistant' && out[i - 1].tool_calls));
        ok('④ 裁完没有孤儿 tool 消息', !hasOrphanTool);
        ok('④ 末尾工具轮要么整组留、要么整组没（对比 id）', (() => {
            const a = out.find((m) => m.role === 'assistant' && m.tool_calls);
            const t = out.find((m) => m.role === 'tool');
            return (!a && !t) || (!!a && !!t && t.tool_call_id === a.tool_calls[0].id);
        })());
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
} catch (e) {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
}
