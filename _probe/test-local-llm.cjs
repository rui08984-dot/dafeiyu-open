#!/usr/bin/env node
/**
 * _probe/test-local-llm.cjs — 本地记忆模型（llama.cpp + MemOperator-4B）单测（ADR-014 轨道 2）
 *
 * 覆盖：
 *   ① local-llm.resolve：manager 命中 / manager 降级到云端时**必须拒绝**、回到内置默认
 *   ② probe：成功/非 2xx/超时/10s 缓存/状态迁移只 log 一次/isAvailableSync 只读缓存
 *   ③ chat：成功（body 形状）、非 2xx（status+body 摘要）、超时、坏 JSON、空 choices
 *   ④ background-llm.canRunLocal：disabled / local_disabled / local_down / ok
 *   ⑤ memory-evolve：片段卡走 local-llm.resolve() 的回环连接（不再传死 provider_id）且成功失败都不碰云端熔断；
 *      反思的云闸与本地闸互不影响；本地失败退避；inspect 暴露 local
 *   ⑥ DiaryManager 通道选择（默认云 / local_enabled=true 才本地；本地不在 → 跳过不落盘，
 *      本地挂不影响云端日记闸）
 *   ⑦ MemOS 写队列闸：后端=本地时只看本地 /health；后端=云端时仍走 llmHealth
 *
 * 全程离线：global.fetch 全部替换为假实现，数据根指向临时目录（PET_DATA_ROOT）。
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const _TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-localllm-'));
process.env.PET_DATA_ROOT = _TMP_DATA;
// local-llm.chat 成功后会落一条 llm.usage（source=local）；不重定向就写进真实
// .runtime/telemetry.jsonl，污染 doctor 的账本口径。
process.env.PET_TELEMETRY_DIR = _TMP_DATA;

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const LL = require(path.join(LIVE, 'js', 'core', 'local-llm.js'));
const BL = require(path.join(LIVE, 'js', 'core', 'background-llm.js'));
const { llmHealth } = require(path.join(LIVE, 'js', 'core', 'llm-health.js'));
const { llmProviderManager } = require(path.join(LIVE, 'js', 'core', 'llm-provider.js'));
const { PluginContext } = require(path.join(LIVE, 'js', 'core', 'plugin-context.js'));
const ES = require(path.join(LIVE, 'js', 'core', 'episode-store.js'));
const UF = require(path.join(LIVE, 'js', 'core', 'user-facts.js'));
const P = require(path.join(LIVE, 'plugins', 'community', 'memory-evolve', 'index.js'));
const { DiaryManager } = require(path.join(LIVE, 'js', 'ai', 'DiaryManager.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// ── 假 fetch ─────────────────────────────────────────────────────────────
const realFetch = global.fetch;
let calls = [];
let healthMode = 'ok';       // ok | http500 | throw | hang
let chatMode = 'ok';         // ok | http429 | throw | hang | badjson | emptychoice
let chatBody = '';
let chatText = '{"title":"测试","summary":"摘要","facts":[]}';
let chatDelayMs = 0;

function res(status, jsonObj, text) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => { if (jsonObj === undefined) throw new Error('no json'); return jsonObj; },
        text: async () => (text !== undefined ? text : JSON.stringify(jsonObj)),
    };
}

function installFetch() {
    calls = [];
    global.fetch = async (url, opts) => {
        const u = String(url);
        calls.push({ url: u, opts: opts || {} });
        if (/\/health$/.test(u)) {
            if (healthMode === 'throw') throw new Error('ECONNREFUSED 127.0.0.1:11435');
            if (healthMode === 'http500') return res(500, { status: 'loading' }, 'loading');
            if (healthMode === 'hang') return hang(opts);
            return res(200, { status: 'ok' }, '{"status":"ok"}');
        }
        if (/\/chat\/completions$/.test(u)) {
            chatBody = String((opts && opts.body) || '');
            if (chatDelayMs > 0) await new Promise((r) => setTimeout(r, chatDelayMs));
            if (chatMode === 'throw') throw new Error('socket hang up');
            if (chatMode === 'http429') return res(429, undefined, '{"error":"weekly limit"}');
            if (chatMode === 'hang') return hang(opts);
            if (chatMode === 'badjson') return { ok: true, status: 200, json: async () => { throw new Error('bad json'); }, text: async () => 'not json' };
            if (chatMode === 'emptychoice') return res(200, { choices: [] });
            return res(200, { choices: [{ message: { content: chatText } }] });
        }
        throw new Error('unexpected fetch url: ' + u);
    };
}

function hang(opts) {
    return new Promise((_, reject) => {
        const sig = opts && opts.signal;
        const abort = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
        if (sig && typeof sig.addEventListener === 'function') {
            if (sig.aborted) abort(); else sig.addEventListener('abort', abort);
        }
        // 永不自己 resolve：只能被 abort 结束
    });
}

function restoreFetch() { global.fetch = realFetch; }

function resetAll() {
    LL.__test.reset();
    LL.__test.setLogger(() => {});
    try { llmHealth.resetForTests(); } catch (e) { /* 兼容 */ }
    healthMode = 'ok'; chatMode = 'ok'; chatDelayMs = 0;
    installFetch();
}

// ── memory-evolve 的假 IO（与 test-episode-store 同思路）────────────────
const fake = { cursor: 0, written: [], turns: [], readCalls: 0, llmCalls: [], llmReply: '' };
const origEs = {
    loadCursor: ES.loadCursor, saveCursor: ES.saveCursor, readTurns: ES.readTurns,
    appendEpisode: ES.appendEpisode, loadEpisodes: ES.loadEpisodes,
};
const origAddFact = UF.addFact;

function installFakes() {
    fake.cursor = 0; fake.written = []; fake.turns = []; fake.readCalls = 0;
    fake.llmCalls = []; fake.llmReply = '{"title":"熬夜改代码","summary":"他凌晨三点还在改代码","facts":["凌晨三点在改代码"]}';
    ES.loadCursor = () => fake.cursor;
    ES.saveCursor = (n) => { fake.cursor = n; return true; };
    ES.readTurns = () => { fake.readCalls += 1; return { turns: fake.turns, consumed: fake.turns.length, total: fake.turns.length }; };
    ES.appendEpisode = (card) => { fake.written.push(card); return true; };
    ES.loadEpisodes = () => fake.written.slice();
    UF.addFact = () => ({ ok: true, duplicate: false, id: 'f' });
}
function restoreFakes() {
    Object.assign(ES, origEs);
    UF.addFact = origAddFact;
}

function mkPlugin(opts) {
    const o = opts || {};
    const p = new P();
    const logs = [];
    p.context = {
        getPluginFileConfig: () => Object.assign({ enabled: true, episode_min_turns: 2, episode_idle_min: 1 }, o.cfg || {}),
        getPluginFileLog: () => {},
        getConfig: () => ({ cost: o.cost || {} }),
        log: (lv, m) => logs.push(String(m)),
        addSystemPromptPatch: () => {}, removeSystemPromptPatch: () => {},
        getMessages: () => [],
        callLLM: async (prompt, options) => {
            fake.llmCalls.push({ prompt, options: options || {} });
            if (o.llmError) throw o.llmError;
            return fake.llmReply;
        },
    };
    return { p, logs };
}

const MIN = 60 * 1000;
// 时间炸弹（2026-11-24 修，测试夹具不是产品行为）：reset 时刻必须相对「现在」。
// 硬编码日期一旦过期，llmHealth 读到 reset 已到会立刻解除暂停 → 依赖「暂停生效」的
// 3 条断言全红（本地 16:30 之后实测）。这里每次调用生成 future reset。
const quotaBody = () => JSON.stringify({
    error: { message: 'weekly usage limit resets at ' + new Date(Date.now() + 3600 * 1000).toISOString() },
});

(async () => {
    try {
        // ══════════════════════════════════════════════════════════════
        // ① resolve：只要不是本地地址，一律回到内置默认（绝不发云端）
        // ══════════════════════════════════════════════════════════════
        {
            resetAll();
            // 没初始化 manager：走内置默认
            const r0 = LL.resolve();
            ok('resolve 未初始化 → 内置默认本地地址',
                r0.source === 'default' && r0.apiUrl === 'http://127.0.0.1:11435/v1' && r0.model === 'MemOperator-4B',
                JSON.stringify(r0));

            llmProviderManager.init({
                llm_providers: [{
                    id: 'local-memory', api_key: 'local-no-key', api_url: 'http://127.0.0.1:11435/v1',
                    models: [{ model_id: 'MemOperator-4B', enabled: true }],
                }],
            });
            LL.__test.reset();
            const r1 = LL.resolve();
            ok('resolve 命中 manager 的 local-memory', r1.source === 'manager' && /:11435/.test(r1.apiUrl), JSON.stringify(r1));

            // manager 里没有 local-memory → resolveProviderOrFallback 会降级到云端默认；
            // 必须被识别并拒绝（否则本地任务静默烧云端配额）。
            llmProviderManager.init({
                llm_providers: [{
                    id: 'comad', api_key: 'cloud-key', api_url: 'https://api.commandcode.ai/provider/v1',
                    models: [{ model_id: 'deepseek/deepseek-v4.1-flash', enabled: true }],
                }],
                llm: { provider_id: 'comad' },
            });
            LL.__test.reset();
            const r2 = LL.resolve();
            ok('resolve manager 无 local-memory（降级云端）→ 回内置默认，不返回云端',
                r2.source === 'default' && r2.apiUrl === 'http://127.0.0.1:11435/v1' && !/commandcode/.test(r2.apiUrl),
                JSON.stringify(r2));
            ok('isLocalUrl 只认 11435 回环',
                LL.isLocalUrl('http://127.0.0.1:11435/v1') === true &&
                LL.isLocalUrl('http://localhost:11435/v1') === true &&
                LL.isLocalUrl('https://api.commandcode.ai/provider/v1') === false &&
                LL.isLocalUrl('http://127.0.0.1:20128/v1') === false);
            // P2-9（2026-11-25）：端口对但 host 不是回环 = 不是本地（旧实现会误判成 true）
            ok('isLocalUrl 不接受「非回环 host + 11435」',
                LL.isLocalUrl('https://evil.example:11435/v1') === false &&
                LL.isLocalUrl('http://192.168.1.9:11435/v1') === false &&
                LL.isLocalUrl('http://localhost.evil.com:11435/v1') === false);
            ok('isLocalUrl 接受无 scheme 的回环 / [::1] / 缺省端口拒绝',
                LL.isLocalUrl('127.0.0.1:11435') === true &&
                LL.isLocalUrl('http://[::1]:11435/v1') === true &&
                LL.isLocalUrl('http://localhost/v1') === false &&
                LL.isLocalUrl('http://localhost:11435.evil.com/v1') === false);
        }

        // ══════════════════════════════════════════════════════════════
        // ② probe：成功 / 非 2xx / 超时 / 缓存 / 一次性日志 / 同步闸
        // ══════════════════════════════════════════════════════════════
        {
            resetAll();
            healthMode = 'ok';
            const logs = [];
            LL.__test.setLogger((lv, m) => logs.push(lv + ':' + m));
            const a = await LL.probe(1000);
            ok('probe 200 → ok:true', a.ok === true && a.status === 200, JSON.stringify(a));
            ok('probe 走的是根路径 /health（去掉 /v1）', calls.length > 0 && /127\.0\.0\.1:11435\/health$/.test(calls[0].url), calls[0] && calls[0].url);
            ok('probe 首次在线记一条 info（不是 warn）', logs.length === 1 && /^info:/.test(logs[0]), logs.join('|'));

            const before = calls.length;
            const a2 = await LL.probe(2000);
            ok('probe 10s 内命中缓存（不再发请求）', a2.ok === true && calls.length === before, 'calls=' + calls.length);

            const a3 = await LL.probe(2000 + LL.CACHE_MS + 1);
            ok('probe 超过 10s 缓存重新探活', calls.length === before + 1, 'calls=' + calls.length);

            const lastProbeAt = 2000 + LL.CACHE_MS + 1;
            ok('isAvailableSync 缓存内为 true', LL.isAvailableSync(lastProbeAt + LL.CACHE_MS - 1) === true);
            ok('isAvailableSync 缓存外为 false（只读，不发网络）', LL.isAvailableSync(lastProbeAt + LL.CACHE_MS) === false);
        }
        {
            resetAll();
            healthMode = 'http500';
            const logs = [];
            LL.__test.setLogger((lv, m) => logs.push(lv + ':' + m));
            const a = await LL.probe(5000);
            ok('probe 500 → ok:false + reason=http_error', a.ok === false && a.reason === 'http_error' && a.status === 500, JSON.stringify(a));
            ok('probe 失败 log 只喊一次（warn）', logs.filter((x) => /^warn:/.test(x)).length === 1, logs.join('|'));
            const logsBefore = logs.length;
            await LL.probe(5000 + LL.CACHE_MS + 1);
            ok('probe 连续失败同一状态不再刷日志', logs.length === logsBefore, logs.length + '/' + logsBefore);
            ok('probe 失败时 isAvailable → false', (await LL.isAvailable(5000 + LL.CACHE_MS * 2)) === false);
        }
        {
            resetAll();
            healthMode = 'hang';
            const a = await LL.probe(7000, 30);
            ok('probe 超时 → reason=timeout', a.ok === false && a.reason === 'timeout', JSON.stringify(a));
        }
        {
            resetAll();
            healthMode = 'throw';
            const a = await LL.probe(9000);
            ok('probe 连接拒绝 → reason=unreachable + detail',
                a.ok === false && a.reason === 'unreachable' && /ECONNREFUSED/.test(a.detail), JSON.stringify(a));
        }

        // ══════════════════════════════════════════════════════════════
        // ③ chat：成功 / 非 2xx / 超时 / 坏 JSON / 空 choices
        // ══════════════════════════════════════════════════════════════
        {
            resetAll();
            chatText = '{"title":"本地","summary":"好"}';
            const out = await LL.chat('把这段压成卡片', { temperature: 0.2, max_tokens: 800 });
            const body = JSON.parse(chatBody);
            ok('chat 成功返回 content', out === chatText, out.slice(0, 40));
            ok('chat 请求体：model=MemOperator-4B + temperature + max_tokens + stream:false',
                body.model === 'MemOperator-4B' && body.temperature === 0.2 && body.max_tokens === 800 && body.stream === false,
                JSON.stringify({ model: body.model, t: body.temperature, m: body.max_tokens, s: body.stream }));
            ok('chat 请求发到 /v1/chat/completions',
                calls.some((c) => /127\.0\.0\.1:11435\/v1\/chat\/completions$/.test(c.url)));
            ok('chat 带 Authorization Bearer（占位 key）',
                /Bearer local-no-key/.test(String(calls[calls.length - 1].opts.headers && calls[calls.length - 1].opts.headers.Authorization)));
        }
        {
            resetAll();
            chatMode = 'http429';
            let err = null;
            try { await LL.chat('x'); } catch (e) { err = e; }
            ok('chat 429 → 抛错带 status=429 + body 摘要',
                !!err && err.status === 429 && err.code === 'LOCAL_LLM_HTTP' && /weekly limit/.test(err.body),
                err ? (err.code + ' ' + err.status + ' ' + err.body) : 'no error');
        }
        {
            resetAll();
            chatMode = 'hang';
            let err = null;
            try { await LL.chat('x', { timeoutMs: 30 }); } catch (e) { err = e; }
            ok('chat 超时 → code=LOCAL_LLM_TIMEOUT', !!err && err.code === 'LOCAL_LLM_TIMEOUT' && /超时/.test(err.message), err && err.code);
        }
        {
            resetAll();
            chatMode = 'badjson';
            let err = null;
            try { await LL.chat('x'); } catch (e) { err = e; }
            ok('chat 非 JSON → code=LOCAL_LLM_BAD_JSON', !!err && err.code === 'LOCAL_LLM_BAD_JSON', err && err.code);
        }
        {
            resetAll();
            chatMode = 'emptychoice';
            let err = null;
            try { await LL.chat('x'); } catch (e) { err = e; }
            ok('chat 空 choices → code=LOCAL_LLM_EMPTY_CHOICE', !!err && err.code === 'LOCAL_LLM_EMPTY_CHOICE', err && err.code);
        }

        // ══════════════════════════════════════════════════════════════
        // ③b 采样档：默认值 / 调用方可覆盖 / 非法值兜底（2026-11-24 调参）
        // ══════════════════════════════════════════════════════════════
        {
            resetAll();
            await LL.chat('抽取类');
            let b = JSON.parse(chatBody);
            ok('默认（抽取档）= 0.2 / 0.8 / 20 / 0',
                b.temperature === 0.2 && b.top_p === 0.8 && b.top_k === 20 && b.min_p === 0,
                JSON.stringify({ t: b.temperature, p: b.top_p, k: b.top_k, m: b.min_p }));

            resetAll();
            await LL.chat('日记', { profile: 'diary' });
            b = JSON.parse(chatBody);
            ok('diary 档 = 0.8 / 0.9 / 40 / 0.05',
                b.temperature === 0.8 && b.top_p === 0.9 && b.top_k === 40 && b.min_p === 0.05,
                JSON.stringify({ t: b.temperature, p: b.top_p, k: b.top_k, m: b.min_p }));

            resetAll();
            await LL.chat('覆盖', { profile: 'diary', temperature: 0.3, top_k: 12, top_p: 1.5, min_p: -1 });
            b = JSON.parse(chatBody);
            ok('调用方逐项覆盖：合法的生效、越界的回落档案',
                b.temperature === 0.3 && b.top_k === 12 && b.top_p === 0.9 && b.min_p === 0.05,
                JSON.stringify({ t: b.temperature, p: b.top_p, k: b.top_k, m: b.min_p }));

            resetAll();
            await LL.chat('非法档', { profile: '不存在的档', temperature: 'hot', top_k: NaN });
            b = JSON.parse(chatBody);
            ok('非法 profile / 非数字值兜底到抽取档（不把 NaN 送服务端）',
                b.temperature === 0.2 && b.top_k === 20 && b.min_p === 0
                && LL.samplingFor('nope').temperature === 0.2 && LL.SAMPLING.diary.top_k === 40,
                JSON.stringify({ t: b.temperature, k: b.top_k, m: b.min_p }));
        }

        // ══════════════════════════════════════════════════════════════
        // ④ background-llm.canRunLocal
        // ══════════════════════════════════════════════════════════════
        {
            resetAll();
            const off = await BL.canRunLocal({ getConfig: () => ({ cost: { background_llm: false } }) });
            ok('canRunLocal 后台总开关关 → reason=disabled', off.ok === false && off.reason === 'disabled', JSON.stringify(off));

            const localOff = await BL.canRunLocal({ getConfig: () => ({ cost: { local_memory: false } }) });
            ok('canRunLocal cost.local_memory=false → reason=local_disabled',
                localOff.ok === false && localOff.reason === 'local_disabled', JSON.stringify(localOff));
            ok('isLocalEnabled 默认 true / 显式 false 为 false',
                BL.isLocalEnabled({ getConfig: () => ({ cost: {} }) }) === true &&
                BL.isLocalEnabled({ getConfig: () => ({ cost: { local_memory: false } }) }) === false);

            healthMode = 'throw';
            LL.__test.reset();
            const down = await BL.canRunLocal({ getConfig: () => ({}) });
            ok('canRunLocal 本地不在 → reason=local_down', down.ok === false && down.reason === 'local_down', JSON.stringify(down));

            healthMode = 'ok';
            LL.__test.reset();
            const up = await BL.canRunLocal({ getConfig: () => ({}) });
            ok('canRunLocal 本地在线 → ok:true', up.ok === true && up.reason === null, JSON.stringify(up));

            // 云端熔断与本地闸无关：429 暂停期间本地仍可跑
            llmHealth.noteFailure({ status: 429, body: quotaBody() }, Date.now());
            const cloudBlocked = BL.canRun({ getConfig: () => ({}) });
            const localStill = await BL.canRunLocal({ getConfig: () => ({}) });
            ok('云端 429 熔断时 canRun 停、canRunLocal 仍放行（两套闸独立）',
                cloudBlocked.ok === false && localStill.ok === true,
                JSON.stringify({ cloud: cloudBlocked.reason, local: localStill.ok }));
        }

        // ══════════════════════════════════════════════════════════════
        // ⑤ memory-evolve：片段卡本地、反思云、退避、inspect
        // ══════════════════════════════════════════════════════════════
        try {
            installFakes();
            {
                resetAll();
                installFakes();
                fake.turns = [
                    { role: 'user', text: '我昨天凌晨三点还在改代码' },
                    { role: 'assistant', text: '你也太拼了' },
                ];
                const { p, logs } = mkPlugin();
                await p.onInit();
                p._destroyed = false;
                const card = await p._maybeBuildEpisode();
                ok('片段卡：本地在线 → 生成卡片并推进游标',
                    !!card && fake.written.length === 1 && fake.cursor > 0, card && card.title);
                const call = fake.llmCalls[0] || { options: {} };
                ok('片段卡：连接来自 local-llm.resolve()（回环 11435）+ max_tokens=800 + temperature=0.2',
                    /^http:\/\/127\.0\.0\.1:11435\/v1$/.test(String(call.options.api_url || ''))
                    && call.options.max_tokens === 800 && call.options.temperature === 0.2,
                    JSON.stringify(call.options));
                ok('片段卡：不再传死 provider_id（fail-closed 契约下 provider 缺失也不回云）',
                    !Object.prototype.hasOwnProperty.call(call.options, 'provider_id'),
                    JSON.stringify(call.options.provider_id));
                // 再用**真实** PluginContext.callLLM 走一遍同一份 options：fake fetch 看到的就是
                // 最终 URL —— 证明请求确实打到本机 11435，而不是云端默认 provider。
                calls.length = 0;
                const realCtx = new PluginContext('local-llm-episode-probe', {}, null);
                realCtx.log = () => {};
                await realCtx.callLLM('片段卡探针', call.options);
                const chatHits = calls.filter((c) => /\/chat\/completions$/.test(c.url));
                ok('片段卡：真实 callLLM 请求打到 http://127.0.0.1:11435（fake fetch URL 检查）',
                    chatHits.length === 1 && /^http:\/\/127\.0\.0\.1:11435\/v1\/chat\/completions$/.test(chatHits[0].url),
                    chatHits.map((c) => c.url).join(' | '));
                ok('片段卡成功不写云端熔断（llmHealth 仍空闲）',
                    llmHealth.getStatus().pausedUntil === 0, JSON.stringify(llmHealth.getStatus().pausedUntil));

                // 本地挂了：游标不动、写退避、不碰云端熔断
                resetAll();
                installFakes();
                fake.turns = [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }];
                healthMode = 'ok';
                const errObj = new Error('local LLM HTTP 500 — boom');
                errObj.status = 500;
                const { p: p2 } = mkPlugin({ llmError: errObj });
                await p2.onInit();
                p2._destroyed = false;
                const card2 = await p2._maybeBuildEpisode();
                ok('片段卡：本地调用失败 → 不落卡、游标不动',
                    card2 === null && fake.written.length === 0 && fake.cursor === 0);
                ok('片段卡失败 → 退避 2 分钟（_localBackoffUntil > now）', p2._localBackoffUntil > Date.now() - 1000);
                ok('片段卡失败不写云端熔断（pausedUntil 仍 0）', llmHealth.getStatus().pausedUntil === 0,
                    String(llmHealth.getStatus().pausedUntil));
                const g = await p2._localGate();
                ok('退避期内 _localGate → reason=local_backoff', g.ok === false && g.reason === 'local_backoff', JSON.stringify(g));

                // 云端暂停：反思闸关，本地闸开
                healthMode = 'ok';
                LL.__test.reset();
                llmHealth.noteFailure({ status: 429, body: quotaBody() }, Date.now());
                const { p: p3 } = mkPlugin();
                await p3.onInit();
                const cloudGate = p3._llmGate();
                const localGate = await p3._localGate();
                ok('反思云闸：429 暂停时 _llmGate.ok=false', cloudGate.ok === false, JSON.stringify(cloudGate));
                ok('同一时刻本地闸仍开（本地摘要不被云端配额拦住）', localGate.ok === true, JSON.stringify(localGate));

                const insp = p3.inspect('我每天七点起床');
                ok('inspect 暴露 local（getStatus 形状）',
                    !!insp.local && insp.local.model === 'MemOperator-4B' && typeof insp.local.ok === 'boolean',
                    JSON.stringify(insp.local && { model: insp.local.model, ok: insp.local.ok }));
                ok('inspect 暴露 localEnabled + memosBackendLocal',
                    insp.background.localEnabled === true && typeof insp.background.memosBackendLocal === 'boolean',
                    JSON.stringify(insp.background));
                const origGetConfig = p3.context.getConfig;
                p3.context.getConfig = () => ({ cost: { local_memory: false } });
                ok('isLocalEnabled=false 时 inspect.localEnabled=false',
                    p3.inspect('x').background.localEnabled === false);
                p3.context.getConfig = origGetConfig;
            }
        } finally {
            restoreFakes();
        }

        // ══════════════════════════════════════════════════════════════
        // ⑥ DiaryManager 通道选择（2026-11-24 修订：日记默认云端主模型，
        //    config.diary.local_enabled=true 才走本地 —— 语义见 DiaryManager._diaryGate）
        //    ⑥-a 本地通道：local_enabled=true + 本地 health 抛错 → 跳过、不进 generateDiary、不落盘
        //    ⑥-b 默认配置（无 diary 键）：走云端闸；本地 health 抛错**不影响**云端日记路径
        // ══════════════════════════════════════════════════════════════
        {
            resetAll();
            healthMode = 'throw';
            const voiceChat = {
                aiDiaryEnabled: true, aiDiaryIdleTime: 1, aiDiaryFile: 'data/AI日记.txt',
                aiDiaryPrompt: '写日记', API_URL: 'https://api.commandcode.ai/provider/v1',
                API_KEY: 'cloud-key', MODEL: 'deepseek/deepseek-v4.1-flash',
                config: { cost: {}, diary: { local_enabled: true } },
            };
            const dm = new DiaryManager(voiceChat);
            dm.lastInteractionTime = Date.now() - 10 * MIN;
            let genCalled = 0;
            dm.generateDiary = async () => { genCalled += 1; };
            const origLog = console.log;
            const lines = [];
            console.log = (...a) => { lines.push(a.join(' ')); };
            try { await dm.checkAndWriteDiary(); } finally { console.log = origLog; }
            ok('日记（本地通道）：本地不在 → 不发 chat completions（不回退云端）',
                calls.filter((c) => /chat\/completions/.test(c.url)).length === 0,
                'chatCalls=' + calls.filter((c) => /chat\/completions/.test(c.url)).length);
            ok('日记（本地通道）：本地不在 → 根本不进 generateDiary（素材留着下次补）', genCalled === 0);
            ok('日记（本地通道）：跳过原因写明本地闸（可观测）',
                lines.some((l) => l.includes('本地记忆模型不可用') && l.includes('local_down')),
                lines.filter((l) => l.includes('不可用')).join(' / '));
        }

        {
            // 对称断言：默认配置（无 diary 键）→ 云端闸；本地 health 抛错拦不住云端日记。
            // 闸层面判定就够了：闸是「跳不跳过」的唯一开关，生成走云端 LLMClient 已由
            // _probe/test-diary-provider.cjs 用 fake client 覆盖（这里不再造第二份假象）。
            resetAll();
            healthMode = 'throw';
            const voiceChat = {
                aiDiaryEnabled: true, aiDiaryIdleTime: 1, aiDiaryFile: 'data/AI日记.txt',
                aiDiaryPrompt: '写日记', API_URL: 'https://api.commandcode.ai/provider/v1',
                API_KEY: 'cloud-key', MODEL: 'deepseek/deepseek-v4.1-flash',
                config: { cost: {} },   // 无 diary 键 = 默认云端
            };
            const dm = new DiaryManager(voiceChat);
            ok('日记（默认云端）：local_enabled 缺省为 false', dm._isLocalDiaryEnabled() === false);
            const gate = await dm._diaryGate();
            ok('日记（默认云端）：本地 health 抛错不影响云闸 → {ok:true}',
                gate && gate.ok === true, JSON.stringify(gate));
            ok('日记（默认云端）：全程没碰本地 /health（canRunLocal 一次都没调）',
                calls.filter((c) => /\/health/.test(c.url)).length === 0,
                'healthCalls=' + calls.filter((c) => /\/health/.test(c.url)).length);
        }

        // ══════════════════════════════════════════════════════════════
        // ⑦ MemOS 写队列闸：后端本地/云端分流
        // ══════════════════════════════════════════════════════════════
        {
            resetAll();
            const { p } = mkPlugin();
            await p.onInit();
            // 三种配置形状都要能认出 base_url（扁平 / 盘上 schema / 生成的 memos_config.json）
            const LOCAL_URL = 'http://127.0.0.1:11435/v1';
            ok('MemOS 后端 base_url 解析：扁平形状',
                p._backendBaseUrlFromConfig({ backend_llm: { base_url: LOCAL_URL } }) === LOCAL_URL);
            ok('MemOS 后端 base_url 解析：plugin_config 的 fields/value 形状',
                p._backendBaseUrlFromConfig({ backend_llm: { fields: { base_url: { value: LOCAL_URL } } } }) === LOCAL_URL);
            ok('MemOS 后端 base_url 解析：memos_config.json 的 llm.config 形状',
                p._backendBaseUrlFromConfig({ llm: { config: { base_url: LOCAL_URL } } }) === LOCAL_URL);
            ok('MemOS 后端 base_url 解析：缺失/坏值 → 空串（按云端保守处理）',
                p._backendBaseUrlFromConfig(null) === '' && p._backendBaseUrlFromConfig({}) === '');
            p._memosBackendIsLocal = () => true;
            healthMode = 'throw';
            LL.__test.reset();
            const closed = await p._writeGateOpen();
            ok('写队列闸：后端=本地且本地不在 → 关闭', closed === false);
            healthMode = 'ok';
            LL.__test.reset();
            const opened = await p._writeGateOpen();
            ok('写队列闸：后端=本地且本地在线 → 打开', opened === true);

            // 后端=云端：仍走 llmHealth（429 暂停 → 关闭）
            p._memosBackendIsLocal = () => false;
            llmHealth.noteFailure({ status: 429, body: quotaBody() }, Date.now());
            const cloudClosed = await p._writeGateOpen();
            ok('写队列闸：后端=云端且 429 暂停 → 关闭（沿用 llmHealth）', cloudClosed === false);
            llmHealth.noteSuccess();
            const cloudOpened = await p._writeGateOpen();
            ok('写队列闸：后端=云端且熔断清除 → 打开', cloudOpened === true);
        }
    } finally {
        restoreFakes();
        restoreFetch();
        try { fs.rmSync(_TMP_DATA, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + ((e && e.stack) || e));
    try { fs.rmSync(_TMP_DATA, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
    process.exit(1);
});
