#!/usr/bin/env node
/**
 * _probe/test-llm-retry.cjs —— `config.llm.retry` 真接线（2026-11-24 审计 §8.5）
 *
 * 事实：`LLMClient.fromProviderConfig` 把 `config.llm.retry` 塞进 merged.retry 之后，
 * 全文件没有任何读取 —— 一个「存了不读」的死配置。现在实现最小可用语义：
 *   · 网络错误 / 5xx / 超时 → 重试 max_attempts（默认 2），指数退避（默认 300ms）；
 *   · 429 不重试（交给 llm-health 熔断）；
 *   · 其他 4xx 不重试（请求/参数问题）；
 *   · 流式只在「首 token 之前」失败才重试（已经吐过字再重试会把同一段话说两遍）；
 *   · 每次重试写日志 + 一条 `llm.retry` telemetry。
 *
 * 全程离线：fetch 假实现；PET_DATA_ROOT / PET_TELEMETRY_DIR 指向临时目录
 * （5xx/429 会让 llm-health 写状态文件、重试会写遥测，不能碰真实数据）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-llmretry-'));
process.env.PET_DATA_ROOT = TMP;
process.env.PET_TELEMETRY_DIR = TMP;

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
const retryRows = () => rows().filter((r) => r.type === 'llm.retry');

function okJson(content) {
    return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({
            choices: [{ message: { role: 'assistant', content } }],
            usage: { prompt_tokens: 100, completion_tokens: 5 },
        }),
    };
}
function errResponse(status, text, statusText) {
    return {
        ok: false, status, statusText: statusText || String(status),
        text: async () => text,
        json: async () => { throw new Error('no json'); },
    };
}
function sseResponse(text) {
    const stream = new ReadableStream({
        start(c) {
            c.enqueue(new TextEncoder().encode(text));
            c.close();
        },
    });
    return { ok: true, status: 200, body: stream };
}
function brokenMidStream() {
    // pull 版：先真把半句交给 reader（模拟"已经吐字"），下一次拉取时连接断掉。
    // （start 里 enqueue 完立刻 error 会把排队块丢掉 —— 那样根本没吐过字，测不到「中途」）
    let step = 0;
    const stream = new ReadableStream({
        pull(c) {
            if (step === 0) {
                step = 1;
                c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"半句话"}}]}\n\n'));
                return;
            }
            c.error(new TypeError('fetch failed: other side closed'));
        },
    });
    return { ok: true, status: 200, body: stream };
}

(async () => {
    const realFetch = global.fetch;
    try {
        const msgs = [{ role: 'user', content: '你好' }];

        // ══════════════════════════════════════════════════════════════════
        // ① 5xx → 重试一次成功
        // ══════════════════════════════════════════════════════════════════
        {
            let calls = 0;
            global.fetch = async () => {
                calls += 1;
                return calls === 1 ? errResponse(502, 'bad gateway', 'Bad Gateway') : okJson('第二次成功');
            };
            const client = new LLMClient({ api_key: 'k', api_url: 'http://fake.local/v1', model: 'm' });
            const before = retryRows().length;
            const msg = await client.chatCompletion(msgs, null, false);

            ok('① 5xx 后重试成功', msg && msg.content === '第二次成功', String(msg && msg.content));
            ok('① 一共发了 2 次请求', calls === 2, 'calls=' + calls);
            const added = retryRows().slice(before);
            ok('① 落了一条 llm.retry', added.length === 1, 'rows=' + added.length);
            const row = added[0] || { metrics: {} };
            ok('① llm.retry 字段（attempt/status/退避/非流式）',
                row.metrics.attempt === 1 && row.metrics.max_attempts === 2
                && row.metrics.status === 502 && row.metrics.delay_ms === 300 && row.metrics.stream === 0,
                JSON.stringify(row.metrics));
            ok('① 重试成功后账本仍是真账', client.lastUsage && client.lastUsage.prompt_tokens === 100,
                JSON.stringify(client.lastUsage && client.lastUsage.prompt_tokens));
        }

        // ══════════════════════════════════════════════════════════════════
        // ② 429 不重试（交给 llm-health）
        // ══════════════════════════════════════════════════════════════════
        {
            let calls = 0;
            global.fetch = async () => {
                calls += 1;
                return errResponse(429, '{"error":{"message":"weekly usage limit"},"retry_after":60}', 'Too Many Requests');
            };
            const client = new LLMClient({ api_key: 'k', api_url: 'http://fake.local/v1', model: 'm' });
            const before = retryRows().length;
            let err = null;
            try { await client.chatCompletion(msgs, null, false); } catch (e) { err = e; }
            ok('② 429 直接抛错（不吞）', !!err && Number(err.status) === 429, String(err && err.status));
            ok('② 429 只请求了 1 次', calls === 1, 'calls=' + calls);
            ok('② 429 不算重试（不写 llm.retry）', retryRows().length === before,
                'rows=' + (retryRows().length - before));
        }

        // ══════════════════════════════════════════════════════════════════
        // ③ 流式中途失败（已吐字）→ 不重试
        // ══════════════════════════════════════════════════════════════════
        {
            let calls = 0;
            global.fetch = async () => {
                calls += 1;
                return calls === 1 ? brokenMidStream() : sseResponse('data: {"choices":[{"delta":{"content":"重说"}}]}\n\ndata: [DONE]\n\n');
            };
            const client = new LLMClient({ api_key: 'k', api_url: 'http://fake.local/v1', model: 'm' });
            const chunks = [];
            const before = retryRows().length;
            let err = null;
            try {
                await client.chatCompletion(msgs, null, true, (c) => chunks.push(c));
            } catch (e) { err = e; }
            ok('③ 中途失败抛错', !!err, String(err && err.message));
            ok('③ 错误被标记 streamStarted（已吐过 token）', !!err && err.streamStarted === true, String(err && err.streamStarted));
            ok('③ 只请求 1 次（不重放已说的话）', calls === 1, 'calls=' + calls);
            ok('③ 不写 llm.retry', retryRows().length === before, 'rows=' + (retryRows().length - before));
            ok('③ 已吐出的半句仍交给调用方（不改动）', chunks.length === 1, 'chunks=' + chunks.length);
        }

        // ══════════════════════════════════════════════════════════════════
        // ④ 流式「首 token 之前」失败 → 允许重试
        // ══════════════════════════════════════════════════════════════════
        {
            let calls = 0;
            global.fetch = async () => {
                calls += 1;
                if (calls === 1) throw new TypeError('fetch failed');
                return sseResponse('data: {"choices":[{"delta":{"content":"首块重试成功"}}]}\n\ndata: [DONE]\n\n');
            };
            const client = new LLMClient({ api_key: 'k', api_url: 'http://fake.local/v1', model: 'm' });
            const before = retryRows().length;
            const msg = await client.chatCompletion(msgs, null, true, () => {});
            ok('④ 首 token 前失败被重试并成功', msg && msg.content === '首块重试成功', String(msg && msg.content));
            ok('④ 一共 2 次请求', calls === 2, 'calls=' + calls);
            const added = retryRows().slice(before);
            ok('④ llm.retry 标 stream=1 / status=0（网络层）',
                added.length === 1 && added[0].metrics.stream === 1 && added[0].metrics.status === 0,
                JSON.stringify(added[0] && added[0].metrics));
        }

        // ══════════════════════════════════════════════════════════════════
        // ⑤ config.llm.retry 真被读：max_attempts / base_delay_ms / 关闭
        // ══════════════════════════════════════════════════════════════════
        {
            // 5a. config.llm.retry.max_attempts（完整 config 形态）
            let calls = 0;
            global.fetch = async () => { calls += 1; return errResponse(503, 'unavailable', 'Service Unavailable'); };
            const cfgClient = new LLMClient({
                llm: {
                    api_key: 'k', api_url: 'http://fake.local/v1', model: 'm',
                    retry: { max_attempts: 3, base_delay_ms: 10 },
                },
            });
            let err = null;
            try { await cfgClient.chatCompletion(msgs, null, false); } catch (e) { err = e; }
            ok('5a. config.llm.retry.max_attempts=3 生效', calls === 3, 'calls=' + calls);
            ok('5a. 全失败后仍抛错', !!err && Number(err.status) === 503, String(err && err.status));

            // 5b. 指数退避：300 → 600（base 默认 300）
            let calls2 = 0;
            global.fetch = async () => {
                calls2 += 1;
                return calls2 <= 2 ? errResponse(500, 'boom', 'Internal Server Error') : okJson('第三把成功');
            };
            const expClient = new LLMClient({ llm: { api_key: 'k', api_url: 'http://fake.local/v1', model: 'm', retry: { max_attempts: 3 } } });
            const beforeExp = retryRows().length;
            const msg2 = await expClient.chatCompletion(msgs, null, false);
            const delays = retryRows().slice(beforeExp).map((r) => r.metrics.delay_ms);
            ok('5b. 两次 5xx 后第三次成功', msg2 && msg2.content === '第三把成功', String(msg2 && msg2.content));
            ok('5b. 退避是指数的（300 → 600）', JSON.stringify(delays) === JSON.stringify([300, 600]), JSON.stringify(delays));

            // 5c. max_attempts=1 = 不重试
            let calls3 = 0;
            global.fetch = async () => { calls3 += 1; return errResponse(500, 'boom', 'Internal Server Error'); };
            const onceClient = new LLMClient({ llm: { api_key: 'k', api_url: 'http://fake.local/v1', model: 'm', retry: { max_attempts: 1 } } });
            let err3 = null;
            try { await onceClient.chatCompletion(msgs, null, false); } catch (e) { err3 = e; }
            ok('5c. max_attempts=1 → 只发 1 次', calls3 === 1 && !!err3, 'calls=' + calls3);

            // 5d. fromProviderConfig 的 retryConfig 也真被用上（llm-handler 走这条）
            let calls4 = 0;
            global.fetch = async () => {
                calls4 += 1;
                return calls4 === 1 ? errResponse(500, 'boom', 'Internal Server Error') : okJson('fallback ok');
            };
            const viaProvider = LLMClient.fromProviderConfig(
                { api_key: 'k', api_url: 'http://fake.local/v1', model: 'm' },
                { max_attempts: 2, base_delay_ms: 10 }
            );
            const msg4 = await viaProvider.chatCompletion(msgs, null, false);
            ok('5d. fromProviderConfig(retryConfig) 生效', calls4 === 2 && msg4 && msg4.content === 'fallback ok',
                'calls=' + calls4);
        }

        // ══════════════════════════════════════════════════════════════════
        // ⑥ 4xx（非 stream_options 的 400）不重试
        // ══════════════════════════════════════════════════════════════════
        {
            let calls = 0;
            global.fetch = async () => {
                calls += 1;
                return errResponse(400, '{"error":{"message":"model not found"}}', 'Bad Request');
            };
            const client = new LLMClient({ api_key: 'k', api_url: 'http://fake.local/v1', model: 'm' });
            const before = retryRows().length;
            let err = null;
            try { await client.chatCompletion(msgs, null, false); } catch (e) { err = e; }
            ok('⑥ 400 直接抛错', !!err && Number(err.status) === 400, String(err && err.status));
            ok('⑥ 400 不重试', calls === 1 && retryRows().length === before,
                'calls=' + calls + ' retryRows=' + (retryRows().length - before));
        }

        // ══════════════════════════════════════════════════════════════════
        // ⑦ 408 / 425 / 409 可重试（P2 对抗审查补齐）；429/400 仍不重试（见 ②/⑥）
        // ══════════════════════════════════════════════════════════════════
        {
            for (const status of [408, 425, 409]) {
                let calls = 0;
                global.fetch = async () => {
                    calls += 1;
                    return calls === 1
                        ? errResponse(status, '{"error":{"message":"transient"}}', 'Transient')
                        : okJson('重试成功 ' + status);
                };
                const client = new LLMClient({
                    api_key: 'k', api_url: 'http://fake.local/v1', model: 'm',
                    retry: { base_delay_ms: 10 },
                });
                const before = retryRows().length;
                const msg = await client.chatCompletion(msgs, null, false);
                const added = retryRows().slice(before);
                ok('⑦ ' + status + ' 后重试成功', msg && msg.content === '重试成功 ' + status,
                    String(msg && msg.content));
                ok('⑦ ' + status + ' 一共 2 次请求', calls === 2, 'calls=' + calls);
                ok('⑦ ' + status + ' 落一条 llm.retry（status 原样）',
                    added.length === 1 && added[0].metrics.status === status && added[0].metrics.attempt === 1,
                    JSON.stringify(added[0] && added[0].metrics));
            }
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
