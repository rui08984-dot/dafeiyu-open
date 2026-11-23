#!/usr/bin/env node
/**
 * _probe/test-intent-router-llm-off.cjs —— llm_enabled=false（停 qwen3:0.6b）回归
 *
 * 要防的回归：
 *   ① 关了 llm_enabled 仍偷偷打 Ollama（显存/延迟白花）
 *   ② 规则命中/嵌入命中被关开关连带改变（能力变窄）
 *   ③ unknown 回落语义变了：旧版 LLM 失败/超时返回 {intent:'unknown',confidence:0}
 *      → 调用方（shouldOmitTools / llm-handler）带全量工具；新路径必须逐字一致
 *   ④ 配置缺 llm_enabled 键时默认值漂移（钉住：缺省=true 旧语义；
 *      产品停用靠 config.json 显式 false，见 intent-router.js 头注释的 A/B 结论）
 *   ⑤ 嵌入快通道挂了就 panic / 去打 LLM（应：退避 + unknown，全量工具兜底）
 *
 * 纯 Node + mock fetch，不碰真 Ollama / 真 8090 / 真记忆。
 * 跑法：node _probe/test-intent-router-llm-off.cjs
 */
'use strict';

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const {
    classifyIntent, classifyIntentLocal, shouldOmitTools,
    stats, resetStats, DEFAULT_LLM_ENABLED,
} = require(path.join(APP, 'js', 'ai', 'intent-router.js'));

// ── mock 传输层 ────────────────────────────────────────────────────────────
const CHAT_V = [1, 0, 0], TOOL_V = [0, 1, 0], MEM_V = [0, 0, 1];
let embedMode = 'flat';      // flat | chat | tool | memory | fail
let llmReply = { response: '{"intent":"tool","confidence":0.9}' };
let llmThrows = false;
let embedRequests = 0;
let llmRequests = 0;

function embedPayload(mode) {
    const input = mode === 'chat' ? CHAT_V : mode === 'tool' ? TOOL_V : mode === 'memory' ? MEM_V : [1, 0];
    const vecs = [
        CHAT_V, CHAT_V, CHAT_V, CHAT_V,
        TOOL_V, TOOL_V, TOOL_V, TOOL_V,
        MEM_V, MEM_V, MEM_V,
    ];
    if (mode === 'flat') return { data: Array.from({ length: 12 }, () => ({ embedding: [1, 0] })) };
    return { data: [...vecs, input].map((embedding) => ({ embedding })) };
}

global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/v1/embeddings')) {
        embedRequests += 1;
        if (embedMode === 'fail') throw new Error('embed conn refused');
        return { ok: true, json: async () => embedPayload(embedMode) };
    }
    if (u.includes('/api/generate')) {
        llmRequests += 1;
        if (llmThrows) throw new Error('ollama conn refused');
        return { ok: true, json: async () => llmReply };
    }
    throw new Error('unexpected fetch: ' + u);
};

const cfg = (intentRouter) => ({ llm: { intent_router: intentRouter } });
const CFG_OFF = cfg({ llm_enabled: false, timeout_ms: 3000 });
const CFG_ON = cfg({ llm_enabled: true, timeout_ms: 3000 });
const CFG_MISSING = cfg({});                    // 没有 llm_enabled 键

let pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
function eq(name, actual, expected) {
    ok(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

(async () => {
    try {
        // ── 1) 默认值钉在 true（缺键 = 旧版行为；停用只认显式 false）────────
        eq('DEFAULT_LLM_ENABLED = true（缺键保持旧语义）', DEFAULT_LLM_ENABLED, true);
        {
            embedMode = 'flat';
            llmReply = { response: '{"intent":"chat","confidence":0.9}' };
            const before = llmRequests;
            resetStats();
            const r = await classifyIntent('今天不知道聊什么', CFG_MISSING);
            eq('缺 llm_enabled 键 → 旧版 LLM 路径照常（chat）', r.intent, 'chat');
            eq('缺 llm_enabled 键 → 恰好 1 次 LLM 请求', llmRequests - before, 1);
            eq('缺 llm_enabled 键 → stats.llmCalls=1', stats.llmCalls, 1);
            eq('缺 llm_enabled 键 → 不记 llmSkipped', stats.llmSkipped, 0);
        }

        // ── 2) llm_enabled=false：嵌入分不开也绝不发 LLM 请求 ──────────────
        {
            embedMode = 'flat';
            const before = llmRequests;
            const embedBefore = embedRequests;
            resetStats();
            const r = await classifyIntent('把音量调小一点', CFG_OFF);
            eq('llm_enabled=false → unknown（与旧 LLM 失败同形）', r.intent, 'unknown');
            eq('llm_enabled=false → confidence 0', r.confidence, 0);
            eq('llm_enabled=false → skip=llm-disabled', r.skip, 'llm-disabled');
            eq('llm_enabled=false → 0 次 LLM 请求', llmRequests - before, 0);
            eq('llm_enabled=false → stats.llmCalls=0', stats.llmCalls, 0);
            eq('llm_enabled=false → stats.llmSkipped=1', stats.llmSkipped, 1);
            eq('llm_enabled=false → stats.calls=1', stats.calls, 1);
            ok('llm_enabled=false 仍会尝试嵌入（不是把整条语义链砍掉）', embedRequests - embedBefore === 1);
        }

        // ── 3) 嵌入命中不受开关影响：three-class 结果原样返回 ──────────────
        {
            const cases = [
                ['chat', '这首歌唱得还行吧', 'chat'],
                ['tool', '把音量调小一点', 'tool'],
                ['memory', '那件事你现在怎么想', 'memory'],
            ];
            for (const [mode, text, want] of cases) {
                embedMode = mode;
                const before = llmRequests;
                resetStats();
                const off = await classifyIntent(text, CFG_OFF);
                const on = await classifyIntent(text, CFG_ON);
                eq(`嵌入 ${mode} 命中：llm off 返回 ${want}`, off.intent, want);
                eq(`嵌入 ${mode} 命中：llm on 返回同一结果`, on.intent, off.intent);
                eq(`嵌入 ${mode} 命中：confidence 一致`, on.confidence, off.confidence);
                eq(`嵌入 ${mode} 命中：via=embed`, off.via, 'embed');
                eq(`嵌入 ${mode} 命中：0 次 LLM 请求（两轮合计）`, llmRequests - before, 0);
                eq(`嵌入 ${mode} 命中：不记 llmSkipped`, stats.llmSkipped, 0);
            }
        }

        // ── 4) 规则命中：10 条固定样例原样不变（开关不参与规则）────────────
        {
            const cases = [
                ['今天好累啊', 'chat', 0.9],
                ['陪我聊聊天吧', 'chat', 0.9],
                ['在干嘛呢', 'chat', 0.9],
                ['哈哈哈哈笑死我了', 'chat', 0.9],
                ['你要不要摸摸我', 'chat', 0.9],
                ['帮我把音量调小', 'tool', 0.95],
                ['看看桌面上开着哪些窗口', 'tool', 0.95],
                ['帮我截个屏', 'tool', 0.95],
                ['打开记事本', 'tool', 0.95],
                ['还记得我的猫叫什么吗', 'memory', 0.9],
            ];
            embedMode = 'flat';
            const before = llmRequests;
            for (const [text, want, wantConf] of cases) {
                const a = classifyIntentLocal(text);
                const b = classifyIntentLocal(text);
                eq(`规则样例「${text}」→ ${want}`, a.intent, want);
                eq(`规则样例「${text}」confidence=${wantConf}`, a.confidence, wantConf);
                eq(`规则样例「${text}」重复调用稳定`, b.intent, a.intent);
            }
            eq('规则命中不触发任何 LLM 请求', llmRequests - before, 0);
            ok('规则判定微秒级（无网络）', classifyIntentLocal('今天好累啊').ms < 5);
        }

        // ── 5) llm_enabled=true 仍保留旧能力（对照，证明 mock 有效）────────
        {
            embedMode = 'flat';
            llmReply = { response: '{"intent":"tool","confidence":0.9}' };
            const before = llmRequests;
            resetStats();
            const r = await classifyIntent('把音量调小', CFG_ON);
            eq('llm_enabled=true → 小模型照常给出 tool', r.intent, 'tool');
            eq('llm_enabled=true → confidence 0.9', r.confidence, 0.9);
            eq('llm_enabled=true → 恰好 1 次 LLM 请求', llmRequests - before, 1);
            eq('llm_enabled=true → stats.llmCalls=1', stats.llmCalls, 1);
            eq('llm_enabled=true → stats.llmHits=1', stats.llmHits, 1);
            eq('llm_enabled=true → 不记 llmSkipped', stats.llmSkipped, 0);
        }

        // ── 6) unknown 回落与旧 LLM 失败路径逐字一致（除 skip 说明）────────
        {
            embedMode = 'flat';
            resetStats();
            const off = await classifyIntent('测试未知回落', CFG_OFF);

            llmThrows = true;
            const onFail = await classifyIntent('测试未知回落', CFG_ON);
            llmThrows = false;

            eq('LLM 关 vs LLM 失败：intent 一致', off.intent, onFail.intent);
            eq('LLM 关 vs LLM 失败：confidence 一致', off.confidence, onFail.confidence);
            eq('两者都是 unknown', off.intent, 'unknown');
            eq('两者 confidence 都是 0', off.confidence, 0);
            ok('skip 保留各自原因（llm-disabled vs error:*）',
                off.skip === 'llm-disabled' && /^error:/.test(String(onFail.skip || '')),
                `${off.skip} / ${onFail.skip}`);

            // 调用方契约：unknown 一律带全量工具；即便 omit_tools=true 也不会省
            const omitCfg = cfg({ llm_enabled: false, omit_tools: true, min_confidence: 0.85 });
            eq('unknown + omit_tools=true → 仍带全量工具', shouldOmitTools(off, omitCfg), false);
            eq('未知置信 0 → 不省工具', shouldOmitTools({ intent: 'chat', confidence: 0 }, omitCfg), false);
            eq('chat 高置信 → 仍可省（策略本身没被改坏）', shouldOmitTools({ intent: 'chat', confidence: 0.9 }, omitCfg), true);
        }

        // ── 7) 嵌入挂掉：退避 + unknown，且不打 LLM ────────────────────────
        {
            embedMode = 'fail';
            const before = llmRequests;
            resetStats();
            const r = await classifyIntent('嵌入挂了也不能打 LLM', CFG_OFF);
            eq('嵌入失败 + llm off → unknown', r.intent, 'unknown');
            eq('嵌入失败 + llm off → 0 次 LLM 请求', llmRequests - before, 0);
        }

        console.log(`\ntest-intent-router-llm-off.cjs：${pass} 通过 / ${fail} 失败`);
        process.exit(fail === 0 ? 0 : 1);
    } catch (e) {
        console.error('❌ 测试异常:', e && e.stack || e);
        process.exit(1);
    }
})();
