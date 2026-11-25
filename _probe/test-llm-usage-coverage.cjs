#!/usr/bin/env node
/**
 * _probe/test-llm-usage-coverage.cjs —— 「谁花了钱都有账」覆盖回归（ADR-014 / HANDOFF §8.3）
 *
 * 以前漏账的三条路：
 *   ① `plugins/built-in/ai-log` 的日记：裸 fetch(global.voiceChat.API_URL)，max_tokens 8000，
 *      既不进 `llm.usage`，也不吃 provider 路由与配额闸；
 *   ② `js/ai/llm-client` 流式请求：端点 400 掉 `stream_options.include_usage` 后整次没有 usage，
 *      账本里连一行 token 都没有（只有 msg_count）；
 *   ③ `js/core/local-llm.chat`：本地记忆模型的调用完全不进账本，后台花了多少只看得见云端那半边。
 *
 * 本测试断言三条路各自落一条**带正确 source** 的 `llm.usage`：
 *   ① source=plugin（走 plugin-context.callLLM）  ② source=main 且 metrics.estimated=1
 *   ③ source=local
 *
 * 全程离线：fetch 全部假实现；PET_DATA_ROOT / PET_TELEMETRY_DIR 指向临时目录，
 * 不碰真实记录室、不写真实 .runtime/telemetry.jsonl。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-llmusage-'));
process.env.PET_DATA_ROOT = TMP;
process.env.PET_TELEMETRY_DIR = TMP;

const PC = require(path.join(LIVE, 'js', 'core', 'plugin-context.js'));
const LL = require(path.join(LIVE, 'js', 'core', 'local-llm.js'));
const { LLMClient } = require(path.join(LIVE, 'js', 'ai', 'llm-client.js'));
const AiLogPlugin = require(path.join(LIVE, 'plugins', 'built-in', 'ai-log', 'index.js'));

const TELEMETRY = path.join(TMP, 'telemetry.jsonl');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

/** 读当前 telemetry 行（每次全量读，文件很小）。 */
function rows() {
    if (!fs.existsSync(TELEMETRY)) return [];
    return fs.readFileSync(TELEMETRY, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}
const usageRows = () => rows().filter((r) => r.type === 'llm.usage');

/** 假执行体：把 ai-log 的上下文换成「log 静音 + 真 callLLM」的壳。 */
function makeAiLogHost(getConfig) {
    const callLLM = PC.PluginContext.prototype.callLLM;
    // callLLM 只依赖 this.resolveLLM（其余读 global.voiceChat），所以这个壳足够真
    const llmSelf = { resolveLLM: () => null };
    const context = {
        log() {},
        getConfig: getConfig || (() => ({})),
        callLLM: (prompt, options) => callLLM.call(llmSelf, prompt, options),
    };
    const plugin = new AiLogPlugin({}, context);
    plugin._maxRetries = 3;
    plugin._thinkingMode = 'disabled';
    plugin._reasoningEffort = '';
    plugin._apiUrl = '';
    plugin._apiKey = '';
    plugin._model = '';
    return plugin;
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

(async () => {
    const realFetch = global.fetch;
    const realVoiceChat = global.voiceChat;
    try {
        // ══════════════════════════════════════════════════════════════════
        // ① ai-log 日记：走 callLLM → llm.usage(source=plugin)
        // ══════════════════════════════════════════════════════════════════
        {
            global.voiceChat = { API_URL: 'http://fake.local/v1/chat/completions', API_KEY: 'k', MODEL: 'm-main' };
            let sentBody = null;
            global.fetch = async (url, opts) => {
                sentBody = JSON.parse(opts.body);
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        choices: [{ message: { role: 'assistant', content: '今天的日志' } }],
                        usage: { prompt_tokens: 1200, completion_tokens: 300 },
                    }),
                };
            };

            const plugin = makeAiLogHost();
            const before = usageRows().length;
            const out = await plugin._callAPI('日记系统提示词', '今天的对话历史');

            ok('① ai-log 返回正文（callLLM 链路）', out === '今天的日志', String(out));
            ok('① 请求体语义不变：单条 prompt + max_tokens 8000 + temperature 0.7',
                sentBody && sentBody.messages.length === 1
                && sentBody.messages[0].content.includes('日记系统提示词')
                && sentBody.messages[0].content.includes('今天的对话历史')
                && sentBody.max_tokens === 8000 && sentBody.temperature === 0.7,
                JSON.stringify({ n: sentBody && sentBody.messages.length, max: sentBody && sentBody.max_tokens, t: sentBody && sentBody.temperature }));
            ok('① 思考模式仍下发', sentBody && sentBody.thinking && sentBody.thinking.type === 'disabled',
                JSON.stringify(sentBody && sentBody.thinking));

            const added = usageRows().slice(before);
            ok('① 落了一条 llm.usage', added.length === 1, 'rows=' + added.length);
            const row = added[0] || { metrics: {} };
            ok('① source=plugin（云端插件调用）', row.source === 'plugin', String(row.source));
            ok('① 记账数字来自 provider usage',
                row.metrics.prompt_tokens === 1200 && row.metrics.completion_tokens === 300,
                JSON.stringify(row.metrics));
            ok('① 真实 usage 不打 estimated', row.metrics.estimated == null, String(row.metrics.estimated));

            // 闸：后台 LLM 关闭 → 不调云端（也不再"打 3 次 429"）
            const gated = makeAiLogHost(() => ({ cost: { background_llm: false } }));
            let called = 0;
            const realFetchNow = global.fetch;
            global.fetch = async () => { called += 1; return realFetchNow(); };
            let gateErr = null;
            try { await gated._callAPI('sys', 'user'); } catch (e) { gateErr = e; }
            ok('① 后台 LLM 关掉 → 直接跳过（BG_LLM_PAUSED，零请求）',
                !!gateErr && gateErr.code === 'BG_LLM_PAUSED' && called === 0,
                String(gateErr && gateErr.code) + '/calls=' + called);
        }

        // ══════════════════════════════════════════════════════════════════
        // ② 流式 + 无 usage（端点不认 stream_options）→ estimated 账
        // ══════════════════════════════════════════════════════════════════
        {
            global.fetch = async () => sseResponse(
                'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'
                + 'data: {"choices":[{"delta":{"content":"呀，今天过得怎么样"}}]}\n\n'
                + 'data: [DONE]\n\n'
            );

            const client = new LLMClient({ api_key: 'k', api_url: 'http://fake.local/v1', model: 'm' });
            const chunks = [];
            const before = usageRows().length;
            const msg = await client.chatCompletion(
                [{ role: 'system', content: '你是大肥鱼' }, { role: 'user', content: '在吗' }],
                null, true, (c) => chunks.push(c)
            );

            ok('② 流式正文拼装正常', msg && msg.content === '你好呀，今天过得怎么样', String(msg && msg.content));
            ok('② onChunk 实时回调仍走', chunks.length === 2, 'chunks=' + chunks.length);
            ok('② lastUsage 不编真账（prompt/cached 仍为 null）',
                client.lastUsage && client.lastUsage.prompt_tokens === null && client.lastUsage.cached_tokens === null,
                JSON.stringify({ p: client.lastUsage && client.lastUsage.prompt_tokens, c: client.lastUsage && client.lastUsage.cached_tokens }));
            ok('② lastUsage 带估算值（estimated_tokens）',
                client.lastUsage && client.lastUsage.estimated_tokens
                && client.lastUsage.estimated_tokens.prompt > 0
                && client.lastUsage.estimated_tokens.completion > 0,
                JSON.stringify(client.lastUsage && client.lastUsage.estimated_tokens));

            const added = usageRows().slice(before).filter((r) => r.source === 'main');
            ok('② 落了一条 llm.usage（source=main）', added.length === 1, 'rows=' + added.length);
            const row = added[0] || { metrics: {} };
            ok('② 账本里 prompt/completion 有估算数字',
                row.metrics.prompt_tokens > 0 && row.metrics.completion_tokens > 0,
                JSON.stringify(row.metrics));
            ok('② estimated=1（doctor 要单独标出）', row.metrics.estimated === 1, String(row.metrics.estimated));
            ok('② cached 不估算（has_cache_field=0，命中率不掺假）',
                row.metrics.has_cache_field === 0 && row.metrics.cached_tokens == null,
                JSON.stringify({ h: row.metrics.has_cache_field, c: row.metrics.cached_tokens }));

            // 上游给了 usage 时：不打 estimated（真账优先）
            global.fetch = async () => ({
                ok: true, status: 200,
                json: async () => ({
                    choices: [{ message: { content: '好' } }],
                    usage: { prompt_tokens: 500, completion_tokens: 7 },
                }),
            });
            const before2 = usageRows().length;
            await client.chatCompletion([{ role: 'user', content: 'x' }], null, false);
            const row2 = usageRows().slice(before2)[0] || { metrics: {} };
            ok('② 有真实 usage 时不打 estimated',
                row2.metrics.prompt_tokens === 500 && row2.metrics.estimated == null,
                JSON.stringify(row2.metrics));
        }

        // ══════════════════════════════════════════════════════════════════
        // ③ local-llm.chat → llm.usage(source=local)；失败不落
        // ══════════════════════════════════════════════════════════════════
        {
            global.fetch = async () => ({
                ok: true, status: 200,
                json: async () => ({
                    choices: [{ message: { content: '片段卡要点' } }],
                    usage: { prompt_tokens: 40, completion_tokens: 12 },
                }),
            });
            const before = usageRows().length;
            const out = await LL.chat('把这段对话压成片段卡');
            ok('③ 本地 chat 正常返回', out === '片段卡要点', String(out));

            const added = usageRows().slice(before);
            ok('③ 落了一条 llm.usage', added.length === 1, 'rows=' + added.length);
            const row = added[0] || { metrics: {} };
            ok('③ source=local（不计云端周配额）', row.source === 'local', String(row.source));
            ok('③ 记账数字来自本地 server usage',
                row.metrics.prompt_tokens === 40 && row.metrics.completion_tokens === 12,
                JSON.stringify(row.metrics));
            ok('③ 本地账不打 estimated（有真 usage）', row.metrics.estimated == null, String(row.metrics.estimated));

            // 失败不落：本地连不上时账本不该多一行
            global.fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' }); };
            const beforeFail = usageRows().length;
            let err = null;
            try { await LL.chat('再压一张'); } catch (e) { err = e; }
            ok('③ 本地失败仍然抛错（调用方据此跳过）', !!err && /local LLM/.test(err.message), String(err && err.message));
            ok('③ 失败不落账', usageRows().length === beforeFail, 'rows=' + (usageRows().length - beforeFail));

            // 没有 usage 的本地响应 → estimated 兜底（estimated=1）
            global.fetch = async () => ({
                ok: true, status: 200,
                json: async () => ({ choices: [{ message: { content: '没有 usage 的本地回复' } }] }),
            });
            const before3 = usageRows().length;
            await LL.chat('给个没有 usage 的回复');
            const row3 = usageRows().slice(before3)[0] || { metrics: {} };
            ok('③ 本地无 usage → 估算兜底且 estimated=1',
                row3.metrics.prompt_tokens > 0 && row3.metrics.completion_tokens > 0 && row3.metrics.estimated === 1,
                JSON.stringify(row3.metrics));
        }

        // ══════════════════════════════════════════════════════════════════
        // ④ isLocal：任意回环地址/端口 → source=local（2026-11-24）
        //    本机 wb 在 127.0.0.1:20128，旧判定只认 :11435，wb 的调用被算进云端 80% 预算。
        // ══════════════════════════════════════════════════════════════════
        {
            const callLLM = PC.PluginContext.prototype.callLLM;
            const callVia = async (apiUrl, providerId) => {
                const self = {
                    resolveLLM: () => ({ id: providerId, api_url: apiUrl, api_key: 'k', model: 'm' }),
                };
                global.fetch = async () => ({
                    ok: true, status: 200,
                    json: async () => ({
                        choices: [{ message: { content: 'ok' } }],
                        usage: { prompt_tokens: 10, completion_tokens: 5 },
                    }),
                });
                const before = usageRows().length;
                await callLLM.call(self, 'p', { provider_id: providerId });
                return usageRows().slice(before)[0] || {};
            };

            const wb = await callVia('http://127.0.0.1:20128/v1', 'wb');
            ok('④ wb 回环 127.0.0.1:20128 → source=local（不进云端预算）', wb.source === 'local', String(wb.source));
            const loop2 = await callVia('http://127.0.0.2:8000/v1', 'local2');
            ok('④ 127/8 任意地址 → source=local', loop2.source === 'local', String(loop2.source));
            const v6 = await callVia('http://[::1]:20128/v1', 'local6');
            ok('④ ::1 → source=local', v6.source === 'local', String(v6.source));
            const lan = await callVia('http://192.168.1.10:20128/v1', 'wb-lan');
            ok('④ 局域网地址 → source=plugin（仍算云端）', lan.source === 'plugin', String(lan.source));
            const pub = await callVia('https://api.example.com/v1', 'cloud');
            ok('④ 公网 https → source=plugin', pub.source === 'plugin', String(pub.source));
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
        global.voiceChat = realVoiceChat;
    }
})();
