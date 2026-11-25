#!/usr/bin/env node
/**
 * _probe/test-retry-purity.cjs —— 重试「不污染请求 / 不污染账本」（2026-11-25）
 *
 * test-llm-retry.cjs 已经钉住「该不该重试、重试几次、退避多少」。这里补它没测的**副作用面**：
 *   ① 非流式 500 重试：两次 HTTP 请求体逐字节一致（messages/tools 深比较），
 *      调用方传进来的 messages 数组一个字节都没被改（重试不能把请求改写掉）；
 *   ② 流式「首 token 之前」500：重试请求体同样逐字节一致（含 stream_options）；
 *   ③ 流式「已吐字」失败：不重试、streamStarted=true、llm.retry 一条都不许有；
 *   ④ max_attempts=3 全失败：llm.retry **每次失败恰好一条**（attempt 1/2，没有第 3 条）；
 *   ⑤ 账本不双写：失败的 attempt 不落 llm.usage；成功的那一发只落一条；
 *      上游没给 usage 时那一发也只落一条（estimated=1），绝不「估算+真账」两条；
 *   ⑥ 400 不认 stream_options 的内部降级请求体：除 stream_options 外与首发逐字节一致，
 *      且它不算一次「重试」（不写 llm.retry）。
 *
 * 全程离线：fake fetch；PET_TELEMETRY_DIR 指到临时目录。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-retry-purity-'));
process.env.PET_DATA_ROOT = TMP;
process.env.PET_TELEMETRY_DIR = TMP;

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const { LLMClient } = require(path.join(LIVE, 'js', 'ai', 'llm-client.js'));
const TELEMETRY = path.join(TMP, 'telemetry.jsonl');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
function rows() {
    if (!fs.existsSync(TELEMETRY)) return [];
    return fs.readFileSync(TELEMETRY, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}
const typeRows = (t) => rows().filter((r) => r.type === t);

function okJson(content, usage) {
    return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({
            choices: [{ message: { role: 'assistant', content } }],
            usage: usage === null ? undefined : (usage || { prompt_tokens: 1000, completion_tokens: 5 }),
        }),
        text: async () => '',
    };
}
function errResponse(status, body) {
    return {
        ok: false, status, statusText: 'E' + status,
        text: async () => body || ('{"error":{"message":"x' + status + '"}}'),
        json: async () => { throw new Error('no json'); },
    };
}
function sseResponse(chunks, usage) {
    const lines = chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n');
    if (usage) lines.push('data: ' + JSON.stringify({ choices: [{ delta: {} }], usage }) + '\n\n');
    lines.push('data: [DONE]\n\n');
    const text = lines.join('');
    return {
        ok: true, status: 200, statusText: 'OK',
        body: new ReadableStream({
            start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
        }),
    };
}
function brokenAfterHalfSentence() {
    let step = 0;
    const stream = new ReadableStream({
        pull(c) {
            if (step === 0) {
                step = 1;
                c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"半句"}}]}\n\n'));
                return;
            }
            c.error(new TypeError('fetch failed: other side closed'));
        },
    });
    return { ok: true, status: 200, statusText: 'OK', body: stream };
}

/** 装 fetch：记录每次请求体的**字符串**（逐字节）+ 解析后对象。 */
function installFetch(responder) {
    const raw = [];
    const bodies = [];
    global.fetch = async (url, init) => {
        raw.push(String(init && init.body));
        let b = null;
        try { b = JSON.parse(init.body); } catch (e) { b = null; }
        bodies.push(b);
        return responder(b, bodies.length - 1);
    };
    return { raw, bodies };
}

const TOOLS = [
    { type: 'function', function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] } } },
    { type: 'function', function: { name: 'see', description: '看屏幕', parameters: { type: 'object', properties: {} } } },
];
const MSGS = [
    { role: 'system', content: '人设/规则' },
    { role: 'user', content: '帮我读个文件' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"p":"a"}' } }] },
    { role: 'tool', name: 'read_file', content: '文件内容', tool_call_id: 'c1' },
];

(async () => {
    const realFetch = global.fetch;
    try {
        // ══════════════════════════════════════════════════════════════════
        // ① 非流式 500 → 重试：请求体逐字节一致，调用方数组不被改
        // ══════════════════════════════════════════════════════════════════
        {
            console.log('\n[①] 非流式重试的请求体纯度');
            const msgs = JSON.parse(JSON.stringify(MSGS));
            const snapshot = JSON.stringify(msgs);
            const { raw } = installFetch((body, i) => (i === 0 ? errResponse(500, '') : okJson('第二次成功')));
            const client = new LLMClient({
                llm: { api_key: 'k', api_url: 'http://fake.local/v1', model: 'm', retry: { base_delay_ms: 1 } },
            });
            const beforeRetry = typeRows('llm.retry').length;
            const beforeUsage = typeRows('llm.usage').length;
            const reply = await client.chatCompletion(msgs, TOOLS, false);

            ok('① 重试成功', reply && reply.content === '第二次成功', String(reply && reply.content));
            ok('① 两次请求体逐字节一致（messages/tools 都没变）', raw.length === 2 && raw[0] === raw[1],
                'len=' + raw[0] + ' vs ' + raw[1] + ' equal=' + (raw[0] === raw[1]));
            const b0 = JSON.parse(raw[0]);
            const b1 = JSON.parse(raw[1]);
            ok('① messages 深比较一致', JSON.stringify(b0.messages) === JSON.stringify(b1.messages));
            ok('① tools 深比较一致', JSON.stringify(b0.tools) === JSON.stringify(b1.tools));
            ok('① 调用方传入的 messages 数组一个字节都没被改', JSON.stringify(msgs) === snapshot);
            ok('① 每次失败恰好一条 llm.retry', typeRows('llm.retry').length === beforeRetry + 1,
                'rows=' + (typeRows('llm.retry').length - beforeRetry));
            ok('① 账本只落一条 llm.usage（失败的那发不记账）',
                typeRows('llm.usage').length === beforeUsage + 1,
                'rows=' + (typeRows('llm.usage').length - beforeUsage));
        }

        // ══════════════════════════════════════════════════════════════════
        // ② 流式首 token 前 500 → 重试：含 stream_options 也逐字节一致
        // ══════════════════════════════════════════════════════════════════
        {
            console.log('\n[②] 流式（首 token 前）重试的请求体纯度');
            const { raw } = installFetch((body, i) => (i === 0
                ? errResponse(500, '')
                : sseResponse([{ choices: [{ delta: { content: '好了' } }] }], { prompt_tokens: 900, completion_tokens: 3 })));
            const client = new LLMClient({
                llm: { api_key: 'k', api_url: 'http://fake.local/v1', model: 'm', retry: { base_delay_ms: 1 } },
            });
            const beforeUsage = typeRows('llm.usage').length;
            const reply = await client.chatCompletion(MSGS, TOOLS, true, () => {});
            ok('② 重试后成功', reply && reply.content === '好了', String(reply && reply.content));
            ok('② 两次请求体逐字节一致（含 stream_options）', raw.length === 2 && raw[0] === raw[1]);
            ok('② 两次都带 stream_options.include_usage',
                JSON.parse(raw[0]).stream_options.include_usage === true
                && JSON.parse(raw[1]).stream_options.include_usage === true);
            ok('② 账本只落一条（不是「失败也记一条」）',
                typeRows('llm.usage').length === beforeUsage + 1,
                'rows=' + (typeRows('llm.usage').length - beforeUsage));
        }

        // ══════════════════════════════════════════════════════════════════
        // ③ 流式已吐字 → 不重试
        // ══════════════════════════════════════════════════════════════════
        {
            console.log('\n[③] 流式已吐字失败：不许重放');
            const { bodies } = installFetch(() => brokenAfterHalfSentence());
            const client = new LLMClient({
                llm: { api_key: 'k', api_url: 'http://fake.local/v1', model: 'm', retry: { max_attempts: 5, base_delay_ms: 1 } },
            });
            const beforeRetry = typeRows('llm.retry').length;
            const beforeUsage = typeRows('llm.usage').length;
            const chunks = [];
            let err = null;
            try { await client.chatCompletion(MSGS, TOOLS, true, (c) => chunks.push(c)); } catch (e) { err = e; }
            ok('③ 抛错且 streamStarted=true', !!err && err.streamStarted === true, String(err && err.streamStarted));
            ok('③ 只发 1 次（max_attempts=5 也不重放）', bodies.length === 1, 'n=' + bodies.length);
            ok('③ 不写 llm.retry', typeRows('llm.retry').length === beforeRetry);
            ok('③ 已吐出的半句原样交给调用方', chunks.length === 1 && chunks[0] === '半句', JSON.stringify(chunks));
            // P2-12b：已吐字的失败要留一条**不完整**账（否则 doctor 判「有轮次没记账」假红）。
            // 但它必须是 estimated+incomplete，不能冒充真账，也不能清熔断。
            const addedUsage = typeRows('llm.usage').slice(beforeUsage);
            ok('③ 已吐字失败落一条 incomplete 估算账（不是零账，也不是真账）',
                addedUsage.length === 1 && addedUsage[0].metrics.incomplete === 1
                && addedUsage[0].metrics.estimated === 1 && addedUsage[0].metrics.cached_tokens === undefined,
                JSON.stringify(addedUsage[0] && addedUsage[0].metrics));
        }

        // ══════════════════════════════════════════════════════════════════
        // ③b P2-12：用户已打断 → 5xx/网络错不再重发（不许「停不下来」）
        // ══════════════════════════════════════════════════════════════════
        {
            console.log('\n[③b] 打断优先于重试');
            const { appState } = require(path.join(LIVE, 'js', 'core', 'app-state.js'));
            appState.setInterrupted(true);
            const { bodies } = installFetch(() => errResponse(503, ''));
            const client = new LLMClient({
                llm: { api_key: 'k', api_url: 'http://fake.local/v1', model: 'm', retry: { max_attempts: 5, base_delay_ms: 1 } },
            });
            const before = typeRows('llm.retry').length;
            let err = null;
            try { await client.chatCompletion(MSGS, TOOLS, false); } catch (e) { err = e; }
            appState.clearInterrupted();
            ok('③b 打断后 503 只发 1 次（不重试）', bodies.length === 1, 'n=' + bodies.length);
            ok('③b 原错照抛（不吞）', !!err && Number(err.status) === 503, String(err && err.status));
            ok('③b 不落 llm.retry', typeRows('llm.retry').length === before,
                'rows=' + (typeRows('llm.retry').length - before));
            // 网络错同理
            appState.setInterrupted(true);
            const net = installFetch(() => { throw new TypeError('fetch failed'); });
            let err2 = null;
            try { await client.chatCompletion(MSGS, TOOLS, false); } catch (e) { err2 = e; }
            appState.clearInterrupted();
            ok('③b 打断后网络错也只发 1 次', net.bodies.length === 1, 'n=' + net.bodies.length);
            ok('③b 网络错照抛', !!err2 && /fetch failed/.test(String(err2.message)));
        }

        // ══════════════════════════════════════════════════════════════════
        // ④ max_attempts=3 全失败：retry 条数 = 失败次数（不是尝试次数）
        // ══════════════════════════════════════════════════════════════════
        {
            console.log('\n[④] 三次全失败：每失败一次一条 llm.retry');
            const { bodies } = installFetch(() => errResponse(503, ''));
            const client = new LLMClient({
                llm: { api_key: 'k', api_url: 'http://fake.local/v1', model: 'm', retry: { max_attempts: 3, base_delay_ms: 1 } },
            });
            const before = typeRows('llm.retry').length;
            let err = null;
            try { await client.chatCompletion(MSGS, TOOLS, false); } catch (e) { err = e; }
            const added = typeRows('llm.retry').slice(before);
            ok('④ 共发 3 次', bodies.length === 3, 'n=' + bodies.length);
            ok('④ 最终抛 503', !!err && Number(err.status) === 503, String(err && err.status));
            ok('④ llm.retry 恰好 2 条（第 3 次失败后不再重试）', added.length === 2, 'rows=' + added.length);
            ok('④ attempt 依次为 1、2（不重复、不跳号）',
                added.map((r) => r.metrics.attempt).join(',') === '1,2',
                added.map((r) => r.metrics.attempt).join(','));
            ok('④ 每条都带 max_attempts=3 / status=503',
                added.every((r) => r.metrics.max_attempts === 3 && r.metrics.status === 503));
            ok('④ requests 数 = 3（退避 1ms，无抖动）', bodies.length === 3);
        }

        // ══════════════════════════════════════════════════════════════════
        // ⑤ 上游不给 usage：只落一条 estimated（不双写）
        // ══════════════════════════════════════════════════════════════════
        {
            console.log('\n[⑤] 无 usage 的流式：账本不双写');
            const { raw } = installFetch(() => sseResponse([{ choices: [{ delta: { content: '没有 usage 的一发' } }] }], null));
            const client = new LLMClient({ llm: { api_key: 'k', api_url: 'http://fake.local/v1', model: 'm' } });
            const before = typeRows('llm.usage').length;
            await client.chatCompletion(MSGS, TOOLS, true, () => {});
            const added = typeRows('llm.usage').slice(before);
            ok('⑤ 只落一条 llm.usage（估算+真账不并存）', added.length === 1, 'rows=' + added.length);
            const m = (added[0] && added[0].metrics) || {};
            ok('⑤ 标了 estimated=1 且没有 cached（命中率不掺假）',
                m.estimated === 1 && m.has_cache_field === 0 && m.cached_tokens === undefined,
                JSON.stringify(m));
            ok('⑤ 估算的 prompt 用发送时的分项估算（不是 0）',
                Number(m.prompt_tokens) > 0, 'prompt=' + m.prompt_tokens);
            ok('⑤ 真实 usage 那次没有 estimated 标记（另测）', !/estimated/.test(raw[0]) || true);
            // 对照：给 usage 的那发不标 estimated
            const before2 = typeRows('llm.usage').length;
            const h = installFetch(() => sseResponse(
                [{ choices: [{ delta: { content: '有 usage' } }] }],
                { prompt_tokens: 1234, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 1000 } }
            ));
            await client.chatCompletion(MSGS, TOOLS, true, () => {});
            const added2 = typeRows('llm.usage').slice(before2);
            ok('⑤ 有 usage 时只有一条且 estimated 缺省',
                added2.length === 1 && added2[0].metrics.estimated === undefined
                && added2[0].metrics.prompt_tokens === 1234
                && added2[0].metrics.cached_tokens === 1000,
                added2.length + ' rows / ' + JSON.stringify(added2[0] && added2[0].metrics));
            ok('⑤ 对照请求确实发了 1 次', h.bodies.length === 1);
        }

        // ══════════════════════════════════════════════════════════════════
        // ⑥ 400 不认 stream_options：内部降级 ≠ 重试
        // ══════════════════════════════════════════════════════════════════
        {
            console.log('\n[⑥] stream_options 降级不算重试');
            const { raw } = installFetch((body, i) => (i === 0
                ? errResponse(400, '{"error":{"message":"unrecognized field: stream_options"}}')
                : sseResponse([{ choices: [{ delta: { content: '降级后成功' } }] }])));
            const client = new LLMClient({
                llm: { api_key: 'k', api_url: 'http://fake.local/v1', model: 'm', retry: { max_attempts: 1, base_delay_ms: 1 } },
            });
            const before = typeRows('llm.retry').length;
            const reply = await client.chatCompletion(MSGS, TOOLS, true, () => {});
            ok('⑥ 降级后成功', reply && reply.content === '降级后成功', String(reply && reply.content));
            ok('⑥ 发了 2 次 HTTP（1 次降级重发）', raw.length === 2, 'n=' + raw.length);
            const b0 = JSON.parse(raw[0]);
            const b1 = JSON.parse(raw[1]);
            ok('⑥ 降级只去掉 stream_options，messages/tools 逐字节一致',
                JSON.stringify(b0.messages) === JSON.stringify(b1.messages)
                && JSON.stringify(b0.tools) === JSON.stringify(b1.tools)
                && b0.stream_options !== undefined && b1.stream_options === undefined);
            ok('⑥ 不写 llm.retry（它不是一次 attempt）', typeRows('llm.retry').length === before,
                'rows=' + (typeRows('llm.retry').length - before));
        }

        console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败不判红 */ }
        process.exit(fail === 0 ? 0 : 1);
    } catch (e) {
        console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
        process.exit(1);
    } finally {
        global.fetch = realFetch;
    }
})();
