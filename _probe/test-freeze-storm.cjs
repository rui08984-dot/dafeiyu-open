#!/usr/bin/env node
/**
 * _probe/test-freeze-storm.cjs —— 轮内前缀冻结「风暴面」压测（2026-11-25）
 *
 * 与 test-volatile-freeze.cjs 的分工：
 *   · 那个文件验的是 prompt-layout 的**纯函数语义**（compose/freeze 本身）；
 *   · 这个文件直接把**真 llm-handler 的 runTurn** 跑起来（fake fetch / fake TTS / fake 宿主），
 *     用「上游看到的字节」当判据 —— 30 次工具迭代、第 31 次兜底、打断、截图重试、
 *     宿主被外部改写。纯函数门禁自己骗自己的部分，这里补上。
 *
 * 场景：
 *   ① 30 次工具迭代风暴：请求 1..30 每一条都是上一条的超集，reuse=29。
 *   ② 第 31 次兜底（裸宿主 + 空工具）：不污染冻结、轮末清干净、下一轮全新。
 *   ③ 中断（第 5/15/29 次迭代）：freeze 清理、llm.freeze 落盘（带已完成请求数）、下一轮全新；
 *      _pendingInterruptNote 必须进易变块（在 VOLATILE_HEADER 之后），不进 system。
 *   ④ 截图重试（400 image not supported）：钩子重跑、用户话不重复入库、两次 attempt 各自记账。
 *   ⑤ 宿主被外部改（弹幕并发 push/splice/改写）：append 不判改写；改写/变短判得对、
 *      重冻只重跑一次钩子、不丢消息。
 *
 * 全程离线：fake fetch（不出网）；PET_DATA_ROOT / PET_TELEMETRY_DIR 指到临时目录。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-freeze-storm-'));
process.env.PET_DATA_ROOT = path.join(TMP, 'data');
process.env.PET_TELEMETRY_DIR = path.join(TMP, 'telemetry');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const PL = require(path.join(LIVE, 'js', 'core', 'prompt-layout.js'));
const { LLMHandler } = require(path.join(LIVE, 'js', 'ai', 'llm-handler.js'));
const { appState } = require(path.join(LIVE, 'js', 'core', 'app-state.js'));
const { eventBus } = require(path.join(LIVE, 'js', 'core', 'event-bus.js'));
const { Events } = require(path.join(LIVE, 'js', 'core', 'events.js'));
const contextBudget = require(path.join(LIVE, 'js', 'core', 'context-budget.js'));

const TELEMETRY = path.join(process.env.PET_TELEMETRY_DIR, 'telemetry.jsonl');

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
const freezeRows = () => rows().filter((r) => r.type === 'llm.freeze');
const freezeBreakRows = () => rows().filter((r) => r.type === 'llm.freeze.break');

// ── fake 上游 ───────────────────────────────────────────────────────────────
function sse(payloadLines) {
    const text = payloadLines.join('');
    const stream = new ReadableStream({
        start(c) {
            c.enqueue(new TextEncoder().encode(text));
            c.close();
        },
    });
    return { ok: true, status: 200, statusText: 'OK', body: stream };
}
function sseToolCall(id, name, args) {
    const chunk = {
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0, id, type: 'function',
                    function: { name, arguments: JSON.stringify(args) },
                }],
            },
        }],
    };
    return sse([
        'data: ' + JSON.stringify(chunk) + '\n\n',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":9000,"completion_tokens":20}}\n\n',
        'data: [DONE]\n\n',
    ]);
}
function sseContent(text) {
    return sse([
        'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":9000,"completion_tokens":20}}\n\n',
        'data: [DONE]\n\n',
    ]);
}
function jsonContent(text) {
    return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({
            choices: [{ message: { role: 'assistant', content: text } }],
            usage: { prompt_tokens: 12000, completion_tokens: 8 },
        }),
        text: async () => '',
    };
}
function errResponse(status, body) {
    return {
        ok: false, status, statusText: 'Err',
        text: async () => body,
        json: async () => { throw new Error('no json'); },
    };
}

// ── fake 宿主 / TTS / 插件 ──────────────────────────────────────────────────
function makeTts() {
    const calls = { reset: 0, process: 0, stream: 0, interrupt: 0, finalize: 0 };
    return {
        calls,
        textSegmentQueue: [],
        reset() { calls.reset += 1; },
        processTextToSpeech(t) { calls.process += 1; this.lastText = t; },
        addStreamingText(t) { calls.stream += 1; },
        finalizeStreamingText() { calls.finalize += 1; },
        isPlaying() { return false; },
        interrupt() { calls.interrupt += 1; },
    };
}

function makeConfig(extra) {
    return Object.assign({
        llm: {
            api_key: 'k', api_url: 'http://fake.local/v1', model: 'm',
            retry: { max_attempts: 1, base_delay_ms: 1 },
        },
        tts: { enabled: false },
        ui: { text_only_mode: true },
        // 与生产缺省一致；场景 1 的回执都很小，不会触发任何闸
        context: { tool_result_max_chars: 12000, turn_tool_result_max_chars: 32000 },
    }, extra || {});
}

/**
 * 造一台「宿主 + handler」。
 * opts.host: 初始 voiceChat.messages
 * opts.responder(body, index): 返回 fetch 的假响应
 * opts.executeTool(name, params): 插件工具（默认回显）
 * opts.hook(req): onLLMRequest 钩子（可 req.addVolatile）
 */
function makeHarness(opts) {
    const o = opts || {};
    const host = o.host || [
        { role: 'system', content: '你是大肥鱼。稳定人设/规则。' },
        { role: 'assistant', content: '（以前说过的话）' },
        { role: 'user', content: '上一轮的问题' },
        { role: 'assistant', content: '上一轮的回答' },
    ];
    const tts = o.tts || makeTts();
    const bodies = [];
    const hookCalls = { n: 0, volatile: [] };
    const toolCalls = [];

    const pluginManager = {
        getAllTools: () => (o.tools !== undefined ? o.tools : [
            { type: 'function', function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} } } },
            { type: 'function', function: { name: 'see', description: '看屏幕', parameters: { type: 'object', properties: {} } } },
        ]),
        runLLMRequestHooks: async (req) => {
            hookCalls.n += 1;
            if (typeof o.hook === 'function') o.hook(req, hookCalls.n);
        },
        runLLMResponseHooks: async () => {},
        runTTSStartHooks: async () => {},
        executeTool: async (name, params) => {
            toolCalls.push({ name, params });
            if (typeof o.executeTool === 'function') return o.executeTool(name, params, { host, toolCalls });
            return '工具 ' + name + ' 的结果';
        },
    };

    const voiceChat = {
        messages: host,
        enableContextLimit: false,
        maxContextMessages: 20,
        config: makeConfig(o.configExtra),
        shouldTakeScreenshot: async () => o.screenshot === true,
        takeScreenshotBase64: async () => 'FAKEB64',
        showSubtitle() {},
        hideSubtitle() {},
        saveConversationHistory() {},
        removeInjectedMemory() {},
        trimMessages() {},
        asrProcessor: null,
    };

    const prevPluginManager = global.pluginManager;
    const prevMcp = global.mcpManager;
    global.pluginManager = pluginManager;
    global.mcpManager = null;

    const handler = LLMHandler.createEnhancedSendToLLM(voiceChat, tts, false, voiceChat.config);

    return {
        host, tts, bodies, hookCalls, toolCalls, voiceChat, handler, pluginManager,
        restore() {
            global.pluginManager = prevPluginManager;
            global.mcpManager = prevMcp;
        },
    };
}

/** 装一个「数到第 n 次请求就回什么」的 fetch；返回请求体数组。
 *  onRequest(body, idx) 在发请求那一刻跑（用来抓「请求时刻的宿主」）。 */
function installFetch(responder, onRequest) {
    const bodies = [];
    global.fetch = async (url, init) => {
        let body = null;
        try { body = JSON.parse(init && init.body); } catch (e) { body = null; }
        bodies.push(body);
        if (typeof onRequest === 'function') onRequest(body, bodies.length - 1);
        return responder(body, bodies.length - 1);
    };
    return bodies;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

/** 模拟 llm-client._cleanMessagesForAPI 里会改形态的两处（为了和 fetch body 逐字节比）。 */
function normalizeLikeClient(hostMsgs) {
    const out = clone(hostMsgs).map((m) => {
        const x = { role: m.role };
        if (m.content !== undefined) x.content = m.content;
        if (m.tool_calls !== undefined) x.tool_calls = m.tool_calls;
        if (m.tool_call_id !== undefined) x.tool_call_id = m.tool_call_id;
        if (m.name !== undefined) x.name = m.name;
        if (x.role === 'assistant' && x.content === null && x.tool_calls) x.content = '';
        return x;
    });
    // sanitizeToolMessageSequence：tool 消息必须紧跟声明它的 assistant
    const sanitized = [];
    for (let i = 0; i < out.length; i += 1) {
        const m = out[i];
        if (m.role === 'tool') continue;
        if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) { sanitized.push(m); continue; }
        const ids = m.tool_calls.map((c) => c.id).filter(Boolean);
        const got = [];
        let j = i + 1;
        for (; j < out.length && out[j].role === 'tool'; j += 1) got.push(out[j].tool_call_id);
        const all = ids.every((id) => got.includes(id));
        if (ids.length && all) sanitized.push(m, ...out.slice(i + 1, j).filter((t) => ids.includes(t.tool_call_id)));
        else sanitized.push(Object.assign({}, m, { tool_calls: undefined }));
        i = j - 1;
    }
    return sanitized;
}

/** 「按宿主重建」的请求：消息条数与顺序必须和宿主一致，唯一允许的差异是
 *  最后一条参与本轮对话的 user 末尾多了易变块（那是请求侧拼的，不进宿主）。 */
function bodyMatchesHostWithVolatile(bodyMsgs, hostMsgs) {
    const norm = normalizeLikeClient(hostMsgs);
    if (!Array.isArray(bodyMsgs) || bodyMsgs.length !== norm.length) return false;
    let volatileSeen = 0;
    for (let i = 0; i < norm.length; i += 1) {
        const b = bodyMsgs[i];
        const h = norm[i];
        if (!b || b.role !== h.role) return false;
        if (JSON.stringify(b.tool_calls) !== JSON.stringify(h.tool_calls)) return false;
        if (b.tool_call_id !== h.tool_call_id) return false;
        const hc = String(h.content == null ? '' : h.content);
        const bc = String(b.content == null ? '' : b.content);
        if (bc === hc) continue;
        if (h.role === 'user' && bc.startsWith(hc) && bc.includes(PL.VOLATILE_HEADER)) { volatileSeen += 1; continue; }
        return false;
    }
    return volatileSeen === 1;
}

function deepEqualPrefix(full, prefix) {
    if (!Array.isArray(full) || !Array.isArray(prefix) || full.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i += 1) {
        if (JSON.stringify(full[i]) !== JSON.stringify(prefix[i])) return false;
    }
    return true;
}

(async () => {
    const realFetch = global.fetch;
    let harness = null;
    try {
        // ══════════════════════════════════════════════════════════════════
        // ① 30 次工具迭代风暴
        // ══════════════════════════════════════════════════════════════════
        {
            console.log('\n[①] 30 次工具迭代风暴');
            harness = makeHarness({});
            const before = freezeRows().length;
            const hostAtRequest = [];
            const bodies = installFetch((body) => {
                // 工具轮：流式；兜底：非流式
                if (body && body.stream) {
                    return sseToolCall('call_' + bodies.length, 'read_file', { p: 'f' + bodies.length });
                }
                return jsonContent('收尾兜底回复');
            }, () => { hostAtRequest.push(clone(harness.voiceChat.messages)); });
            // 把最后一轮（第 31 次）标记出来：responder 闭包里的 bodies 是同一个数组
            const reply = await harness.handler('帮我连续读 30 个文件');

            ok('① 一轮里发了 31 次请求（30 工具轮 + 1 兜底）', bodies.length === 31, 'n=' + bodies.length);
            ok('① 回复来自第 31 次兜底', reply === '收尾兜底回复', String(reply));

            const toolBodies = bodies.slice(0, 30);
            ok('① 30 次工具请求都是流式', toolBodies.every((b) => b && b.stream === true));
            ok('① 第 31 次是非流式且空工具面（裸宿主兜底）',
                bodies[30] && bodies[30].stream === false && bodies[30].tools === undefined,
                'tools=' + JSON.stringify(bodies[30] && bodies[30].tools));

            // 逐条：后一条是前一条的严格超集，新增只有 assistant(tool_calls)+tool
            let allPrefix = true;
            let exactTail = true;
            let badAt = -1;
            for (let i = 1; i < toolBodies.length; i += 1) {
                const prev = toolBodies[i - 1].messages;
                const cur = toolBodies[i].messages;
                if (!deepEqualPrefix(cur, prev)) { allPrefix = false; badAt = i; break; }
                if (cur.length !== prev.length + 2) { exactTail = false; badAt = i; break; }
            }
            ok('① 每一次请求的前缀都与上一次逐字节一致（除新增 tail）', allPrefix, badAt >= 0 ? '第 ' + (badAt + 1) + ' 条断' : '');
            ok('① 每次只新增 2 条（assistant+tool）', exactTail, badAt >= 0 ? '第 ' + (badAt + 1) + ' 条不等' : '');

            // 首条请求里易变尾巴只出现在最后一条 user，且 30 次请求里那段字节完全没动
            const firstMsgs = toolBodies[0].messages;
            const volatileIdx = firstMsgs.findIndex((m) => typeof m.content === 'string' && m.content.includes(PL.VOLATILE_HEADER));
            ok('① 易变尾巴落在最后一条 user（不进 system）', volatileIdx > 0 && firstMsgs[0].role === 'system'
                && !String(firstMsgs[0].content).includes(PL.VOLATILE_HEADER), 'idx=' + volatileIdx);
            ok('① 30 次请求里该 user 消息逐字节不变（含易变块）',
                toolBodies.every((b) => JSON.stringify(b.messages[volatileIdx]) === JSON.stringify(firstMsgs[volatileIdx])));

            // 宿主侧：30 个工具回执 + 30 个 assistant(tool_calls) 都在
            const toolMsgs = harness.host.filter((m) => m.role === 'tool');
            const assistantCalls = harness.host.filter((m) => m.role === 'assistant' && m.tool_calls);
            ok('① 宿主落下 30 条工具回执 / 30 条 assistant(tool_calls)',
                toolMsgs.length === 30 && assistantCalls.length === 30,
                'tool=' + toolMsgs.length + ' asst=' + assistantCalls.length);

            // telemetry：llm.freeze reuse=29 / requests=30
            const added = freezeRows().slice(before);
            ok('① 轮末只落一条 llm.freeze', added.length === 1, 'rows=' + added.length);
            const m = (added[0] && added[0].metrics) || {};
            ok('① reuse=29', m.reuse === 29, 'reuse=' + m.reuse);
            ok('① requests=30 / rebuild=0 / rewrite=0',
                m.requests === 30 && m.rebuild === 0 && m.rewrite === 0,
                JSON.stringify(m));
            ok('① prefix_msgs 等于首次请求的条数（快照=首请求字节）',
                m.prefix_msgs === firstMsgs.length, m.prefix_msgs + ' vs ' + firstMsgs.length);
            ok('① 轮末没落 freeze.break（没发生假命中/静默改写）',
                freezeBreakRows().length === 0, 'breaks=' + freezeBreakRows().length);

            // 轮末清空
            ok('① 轮末 voiceChat._turnFreeze 已删除', harness.voiceChat._turnFreeze === undefined);

            // ── ② 第 31 次兜底不污染冻结 + 下一轮全新 ────────────────────
            console.log('\n[②] 第 31 次兜底 / 下一轮重冻');
            const fb = bodies[30];
            ok('② 兜底请求没有易变尾巴（裸宿主）',
                !JSON.stringify(fb.messages).includes(PL.VOLATILE_HEADER));
            ok('② 兜底请求 == 宿主当时的消息（逐字节，不含 attachments）',
                JSON.stringify(fb.messages) === JSON.stringify(normalizeLikeClient(hostAtRequest[30])),
                'req=' + JSON.stringify(fb.messages).length + ' host=' + JSON.stringify(normalizeLikeClient(hostAtRequest[30])).length);

            // 下一轮：全新冻结（不能复用上一轮字节）
            const before2 = freezeRows().length;
            const hostLenBefore = harness.host.length;
            const bodies2 = installFetch((body) => (body && body.stream ? sseContent('新一轮回复') : jsonContent('x')));
            const reply2 = await harness.handler('新一轮开始');
            ok('② 下一轮正常回复', reply2 === '新一轮回复', String(reply2));
            const added2 = freezeRows().slice(before2);
            ok('② 下一轮只有 1 次请求（无工具）', bodies2.length === 1, 'n=' + bodies2.length);
            const m2 = (added2[0] && added2[0].metrics) || {};
            ok('② 下一轮 reuse=0 / rebuild=0 / requests=1（全新冻结，不复用上一轮）',
                m2.reuse === 0 && m2.rebuild === 0 && m2.requests === 1, JSON.stringify(m2));
            ok('② 下一轮冻结的快照包含上一轮全部历史（hostLength 前移）',
                m2.prefix_msgs >= hostLenBefore, m2.prefix_msgs + ' vs host=' + hostLenBefore);
            ok('② 下一轮请求确实带了新易变块（世界行是新的）',
                JSON.stringify(bodies2[0].messages).includes(PL.VOLATILE_HEADER));
            harness.restore();
        }

        // ══════════════════════════════════════════════════════════════════
        // ③ 中断（第 5/15/29 次工具迭代）
        // ══════════════════════════════════════════════════════════════════
        for (const stopAt of [5, 15, 29]) {
            console.log('\n[③] 中断于第 ' + stopAt + ' 次迭代');
            harness = makeHarness({});
            const before = freezeRows().length;
            const bodies = installFetch((body) => (body && body.stream
                ? sseToolCall('c' + bodies.length, 'read_file', { p: String(bodies.length) })
                : jsonContent('不该走到这里')));

            // 在「第 stopAt 次工具回执 push 进宿主」时置中断位 —— 下一个循环顶部的
            // USER_INTERRUPTED 检查会命中（这是轮内最靠后的可控点）。
            let toolPushes = 0;
            const rawPush = Array.prototype.push;
            harness.host.push = function patchedPush(...items) {
                const r = rawPush.apply(this, items);
                if (items.some((x) => x && x.role === 'tool')) {
                    toolPushes += 1;
                    if (toolPushes === stopAt) appState.setInterrupted(true);
                }
                return r;
            };

            const reply = await harness.handler('跑工具跑到一半我打断你');
            delete harness.host.push;   // 还原成 Array.prototype.push
            appState.clearInterrupted();

            const added = freezeRows().slice(before);
            const m = (added[0] && added[0].metrics) || {};
            ok('③ @' + stopAt + ' 被打断时本轮返回空', reply == null || reply === '', JSON.stringify(reply));
            ok('③ @' + stopAt + ' 请求数与打断点一致（' + stopAt + ' 次）',
                bodies.length === stopAt, 'n=' + bodies.length + ' (toolPushes=' + toolPushes + ')');
            ok('③ @' + stopAt + ' 落一条 llm.freeze（带已完成请求数）',
                added.length === 1 && m.requests === stopAt, 'rows=' + added.length + ' requests=' + m.requests);
            ok('③ @' + stopAt + ' reuse = requests-1（最后一次冻结没有复用）',
                m.reuse === stopAt - 1, 'reuse=' + m.reuse);
            ok('③ @' + stopAt + ' 没有 rebuild/rewrite（打断不是宿主改写）',
                m.rebuild === 0 && m.rewrite === 0, JSON.stringify(m));
            ok('③ @' + stopAt + ' 轮末 _turnFreeze 已清', harness.voiceChat._turnFreeze === undefined);
            // 打断后宿主里不能留「有 tool_calls 没有 tool 回执」的半条链
            const badPairs = (() => {
                const msgs = harness.host;
                for (let i = 0; i < msgs.length; i += 1) {
                    const asst = msgs[i];
                    if (asst && asst.role === 'assistant' && Array.isArray(asst.tool_calls)) {
                        const ids = asst.tool_calls.map((c) => c.id);
                        const got = [];
                        for (let j = i + 1; j < msgs.length && msgs[j].role === 'tool'; j += 1) got.push(msgs[j].tool_call_id);
                        if (JSON.stringify(ids) !== JSON.stringify(got)) return { i, ids, got };
                    }
                }
                return null;
            })();
            ok('③ @' + stopAt + ' 宿主工具链配对完整（打断点回滚了 assistant(tool_calls)）',
                badPairs === null, badPairs ? JSON.stringify(badPairs) : '');

            // 下一轮全新
            const before2 = freezeRows().length;
            const bodies2 = installFetch(() => sseContent('继续'));
            const reply2 = await harness.handler('继续');
            const m2 = (freezeRows().slice(before2)[0] || {}).metrics || {};
            ok('③ @' + stopAt + ' 下一轮全新冻结（reuse=0/requests=1）',
                reply2 === '继续' && m2.reuse === 0 && m2.requests === 1, JSON.stringify(m2));
            harness.restore();
        }

        // ── ③b _pendingInterruptNote（TTS 还在播时开新轮）必须进易变块 ──
        {
            console.log('\n[③b] 打断提示走易变块');
            harness = makeHarness({});
            eventBus.emit(Events.TTS_START);            // 让 appState.isPlayingTTS() = true
            const bodies = installFetch(() => sseContent('嗯？'));
            const reply = await harness.handler('（用户抢话）你先别说了');
            eventBus.emit(Events.TTS_END);
            appState.clearInterrupted();
            const msgs = bodies[0] && bodies[0].messages || [];
            const sys = String((msgs.find((m) => m.role === 'system') || {}).content || '');
            const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
            const lastUserText = String(lastUser && lastUser.content || '');
            ok('③b 回复正常', reply === '嗯？', String(reply));
            ok('③b 打断提示不在 system（不破历史缓存）', !sys.includes('别接着讲完'));
            ok('③b 打断提示在最后一条 user 的易变块里', lastUserText.includes('别接着讲完'));
            ok('③b 易变块声明在提示之前（先声明「不必回应」再给内容）',
                lastUserText.indexOf(PL.VOLATILE_HEADER) >= 0
                && lastUserText.indexOf(PL.VOLATILE_HEADER) < lastUserText.indexOf('别接着讲完'));
            harness.restore();
        }

        // ══════════════════════════════════════════════════════════════════
        // ④ 截图重试（模型不支持图片）
        // ══════════════════════════════════════════════════════════════════
        {
            console.log('\n[④] 截图重试');
            harness = makeHarness({});
            const before = freezeRows().length;
            const bodies = installFetch((body) => {
                if (bodies.length === 1) {
                    return errResponse(400, '{"error":{"message":"this model does not support image input"}}');
                }
                return sseContent('我看不到图，但可以聊。');
            });
            const prompt = '看这张截图：她在写代码';
            const reply = await harness.handler(prompt);
            ok('④ 纯文本重试成功', reply === '我看不到图，但可以聊。', String(reply));

            const hostNow = harness.voiceChat.messages;
            const userTexts = hostNow.filter((m) => m.role === 'user')
                .map((m) => String(m.content));
            ok('④ 用户这句话只入宿主一次（重试不重复 push）',
                userTexts.filter((t) => t === prompt).length === 1,
                'count=' + userTexts.filter((t) => t === prompt).length + ' / users=' + userTexts.length);
            ok('④ 恰有 2 次上游请求（首发 + 重试）', bodies.length === 2, 'n=' + bodies.length);
            ok('④ 重试请求带「不支持识图」的系统提示（告诉用户要换模型）',
                JSON.stringify(bodies[1].messages).includes('不支持识图'));
            ok('④ 钩子在两次 attempt 各跑一次（重冻确实重跑了钩子）',
                harness.hookCalls.n === 2, 'hooks=' + harness.hookCalls.n);

            const added = freezeRows().slice(before);
            ok('④ 两次 attempt 各落一条 llm.freeze（聚合 requests=2）',
                added.length === 2
                && added[0].metrics.requests === 1 && added[1].metrics.requests === 1,
                added.map((r) => JSON.stringify(r.metrics)).join(' | '));
            ok('④ 第一次 attempt 的冻结没有被算成 reuse（失败的轮不记账为命中）',
                added[0].metrics.reuse === 0 && added[0].metrics.rebuild === 0,
                JSON.stringify(added[0].metrics));
            ok('④ 第二次 attempt 也是全新冻结（reuse=0/rebuild=0）',
                added[1].metrics.reuse === 0 && added[1].metrics.rebuild === 0,
                JSON.stringify(added[1].metrics));
            harness.restore();
        }

        // ══════════════════════════════════════════════════════════════════
        // ⑤ 宿主被外部改（弹幕并发）
        // ══════════════════════════════════════════════════════════════════
        const hostCases = [
            {
                name: 'append（弹幕只是追加）',
                mutate(host) { host.push({ role: 'user', content: '【弹幕】主播好可爱' }); },
                expectReason: null,
            },
            {
                name: 'in-place 改写（旧消息内容被改）',
                mutate(host) { host[2].content = host[2].content + '（被并发路径改写）'; },
                expectReason: 'host-rewritten',
            },
            {
                name: 'splice 移除（历史被剪短）',
                mutate(host) { host.splice(1, 3); },
                expectReason: 'host-shrank',
            },
        ];
        for (const c of hostCases) {
            console.log('\n[⑤] 宿主被外部改：' + c.name);
            let mutated = false;
            harness = makeHarness({
                executeTool: (name, params, ctx) => {
                    if (!mutated) { mutated = true; c.mutate(ctx.host); }
                    return '回执';
                },
            });
            const before = freezeRows().length;
            const breaksBefore = freezeBreakRows().length;
            const hostAtRequest = [];
            const bodies = installFetch((body) => {
                if (body && body.stream && bodies.length === 1) return sseToolCall('c1', 'read_file', {});
                return sseContent('好');
            }, () => { hostAtRequest.push(clone(harness.voiceChat.messages)); });
            const reply = await harness.handler('用一次工具');
            ok('⑤ 宿主改完后仍能正常回复', reply === '好', String(reply));
            ok('⑤ 恰好 2 次请求（工具轮 + 最终）', bodies.length === 2, 'n=' + bodies.length);

            const second = bodies[1] && bodies[1].messages || [];
            if (c.expectReason === null) {
                ok('⑤ append 不判改写：第二条请求前缀仍是第一条的超集',
                    deepEqualPrefix(second, bodies[0].messages));
                ok('⑤ append 的新消息进了第二条请求（没丢）',
                    JSON.stringify(second).includes('主播好可爱'));
                ok('⑤ append 不落 freeze.break', freezeBreakRows().length === breaksBefore);
                ok('⑤ append 时钩子只跑一次（冻结没被作废）', harness.hookCalls.n === 1, 'hooks=' + harness.hookCalls.n);
            } else {
                ok('⑤ ' + c.expectReason + '：落一条 freeze.break',
                    freezeBreakRows().length === breaksBefore + 1,
                    'breaks=' + (freezeBreakRows().length - breaksBefore));
                ok('⑤ ' + c.expectReason + '：冻结被作废并按宿主重建（钩子跑两次）',
                    harness.hookCalls.n === 2, 'hooks=' + harness.hookCalls.n);
                ok('⑤ ' + c.expectReason + '：第二条请求 == 请求时刻宿主的完整深拷贝（不丢消息）',
                    bodyMatchesHostWithVolatile(second, hostAtRequest[1]),
                    'req=' + second.length + ' host=' + hostAtRequest[1].length);
            }
            const added = freezeRows().slice(before);
            const m = (added[0] && added[0].metrics) || {};
            if (c.expectReason === null) {
                ok('⑤ append：reuse=1 / rebuild=0', m.reuse === 1 && m.rebuild === 0, JSON.stringify(m));
            } else {
                ok('⑤ ' + c.expectReason + '：rebuild=1 / rewrite=1（主动断一次并记账）',
                    m.rebuild === 1 && m.rewrite === 1, JSON.stringify(m));
                const brk = freezeBreakRows().slice(breaksBefore)[0];
                ok('⑤ ' + c.expectReason + '：freeze.break 标出原因（' + c.expectReason + '）',
                    !!brk && (c.expectReason === 'host-shrank'
                        ? brk.metrics.shrank === 1
                        : Number.isFinite(brk.metrics.at_msg) && brk.metrics.at_msg >= 0),
                    brk ? JSON.stringify(brk.metrics) : 'no row');
                ok('⑤ ' + c.expectReason + '：requests=2（重建的那次也算发出过）',
                    m.requests === 2, 'requests=' + m.requests);
            }
            harness.restore();
        }

        // ══════════════════════════════════════════════════════════════════
        // ⑥ 截图轮被外部改写触发重冻：本轮截图必须还在（P0，2026-11-25）
        // ══════════════════════════════════════════════════════════════════
        {
            console.log('\n[⑥] 重冻后本轮截图不丢');
            let mutated = false;
            harness = makeHarness({
                screenshot: true,
                executeTool: (name, params, ctx) => {
                    if (!mutated) {
                        mutated = true;
                        // 模拟「工具回执限流/别的模块」改写了已发出去的历史（触发 host-rewritten）
                        ctx.host[2].content = String(ctx.host[2].content) + '（被外部路径改写）';
                    }
                    return '回执';
                },
            });
            const before = freezeRows().length;
            const bodies = installFetch((body) => {
                if (body && body.stream && bodies.length <= 2) return sseToolCall('c' + bodies.length, 'read_file', {});
                return sseContent('好');
            });
            const reply = await harness.handler('看看我的屏幕然后读个文件');
            ok('⑥ 正常收尾', reply === '好', String(reply));
            ok('⑥ 发了 3 次（首请求 + 重冻 + 最终）', bodies.length === 3, 'n=' + bodies.length);

            // 每条图片 part 的 JSON 里 "image_url" 会出现两次（type + 键名），按 data URI 数才准
            const imgCount = (msgs) => (JSON.stringify(msgs).match(/data:image\/jpeg;base64,/g) || []).length;
            ok('⑥ 首请求带本轮截图', imgCount(bodies[0].messages) === 1
                && /FAKEB64/.test(JSON.stringify(bodies[0].messages)));
            ok('⑥ 重冻请求仍带本轮截图（不是盲聊）', imgCount(bodies[1].messages) === 1
                && /FAKEB64/.test(JSON.stringify(bodies[1].messages)),
                'images=' + imgCount(bodies[1].messages));
            ok('⑥ 重冻请求用的是改写后的历史（确实重建过）',
                JSON.stringify(bodies[1].messages).includes('被外部路径改写'));
            ok('⑥ 重冻后下一条请求与重冻前缀逐字节一致',
                deepEqualPrefix(bodies[2].messages, bodies[1].messages));

            const added = freezeRows().slice(before);
            const m = (added[0] && added[0].metrics) || {};
            ok('⑥ 记账：rebuild=1 / rewrite=1 / reuse=1 / requests=3',
                m.rebuild === 1 && m.rewrite === 1 && m.reuse === 1 && m.requests === 3,
                JSON.stringify(m));
            ok('⑥ vision_lost=0（截图贴回去了）', m.vision_lost === 0, String(m.vision_lost));

            // ── ⑥b 目标消息被删：视觉真丢，必须计 vision_lost 并 warn ──
            let removed = false;
            harness.restore();
            harness = makeHarness({
                screenshot: true,
                executeTool: (name, params, ctx) => {
                    if (!removed) {
                        removed = true;
                        const i = ctx.host.findIndex((x) => Array.isArray(x.attachments));
                        if (i >= 0) ctx.host.splice(i, 1);
                        ctx.host[2].content = String(ctx.host[2].content) + '（改写）';
                    }
                    return '回执';
                },
            });
            const before2 = freezeRows().length;
            const bodies2 = installFetch((body) => {
                if (body && body.stream && bodies2.length <= 1) return sseToolCall('x1', 'read_file', {});
                return sseContent('嗯');
            });
            const reply2 = await harness.handler('看看屏幕');
            ok('⑥b 不崩、正常收尾', reply2 === '嗯', String(reply2));
            ok('⑥b 重冻请求确实没有图（目标消息没了）',
                !/data:image\/jpeg;base64,/.test(JSON.stringify(bodies2[1].messages)));
            const m2 = (freezeRows().slice(before2)[0] || {}).metrics || {};
            ok('⑥b vision_lost=1（视觉丢失可观测，不是静默降级）', m2.vision_lost === 1,
                JSON.stringify(m2));
            harness.restore();
        }

        // ══════════════════════════════════════════════════════════════════
        // ⑦ 指纹开销（P2-13）+ doctor 契约
        // ══════════════════════════════════════════════════════════════════
        {
            console.log('\n[⑦] 大图前缀指纹 / freeze 判据');
            PL._sigStats.full = 0;
            PL._sigStats.cheap = 0;
            const bigImg = 'data:image/jpeg;base64,' + 'Q'.repeat(1400 * 1024);
            const host = [
                { role: 'system', content: 'S' },
                { role: 'user', content: [{ type: 'text', text: '看屏幕' }, { type: 'image_url', image_url: { url: bigImg } }] },
                { role: 'user', content: '问' },
            ];
            const f = PL.freezeTurnPrefix(host, host, {});
            const t0 = Date.now();
            for (let i = 0; i < 30; i += 1) {
                host.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
                host.push({ role: 'tool', name: 'read_file', content: 'r' + i, tool_call_id: 'c' + i });
                const c = PL.composeTurnPrefix(f, host);
                if (!c.ok) { ok('⑦ compose 第 ' + i + ' 次失败', false, c.reason); break; }
            }
            const ms = Date.now() - t0;
            ok('⑦ 1.4MB 图的逐条指纹走轻量通道（31 次 = 1 冻结 + 30 复用）',
                PL._sigStats.cheap === 31, 'cheap=' + PL._sigStats.cheap);
            ok('⑦ 小消息仍走全量 JSON（2 条 × 31 次）', PL._sigStats.full === 62, 'full=' + PL._sigStats.full);
            ok('⑦ 30 次 compose 没有因为大图变慢（<3s，实测 ' + ms + 'ms）', ms < 3000);
            ok('⑦ 轻量指纹仍能抓出大图被换（缓存断裂可观测）', (() => {
                const host2 = JSON.parse(JSON.stringify(host.slice(0, 3)));
                const f2 = PL.freezeTurnPrefix(host2, host2, {});
                host2[1].content[1].image_url.url = 'data:image/jpeg;base64,' + 'R'.repeat(1400 * 1024);
                const r = PL.composeTurnPrefix(f2, host2);
                return r.ok === false && r.reason === 'host-rewritten' && r.index === 1;
            })());

            const judge = require(path.join(ROOT, 'pet-runtime', 'tools', 'doctor-judge.cjs'));
            const okRow = { ts: Date.now(), cat: 'llm', type: 'llm.freeze', metrics: { requests: 30, reuse: 29, rebuild: 0, rewrite: 0, vision_lost: 0 } };
            ok('⑦ doctor 判据：本次风暴那一条 → ok',
                judge.judgeFreezeReuse([okRow]).status === 'ok', judge.judgeFreezeReuse([okRow]).detail);
            const badRow = { ts: Date.now(), cat: 'llm', type: 'llm.freeze', metrics: { requests: 30, reuse: 5, rebuild: 5, rewrite: 10 } };
            ok('⑦ doctor 判据：复用率过低 → warn（账本真能报警）',
                judge.judgeFreezeReuse([badRow]).status === 'warn');
        }

        console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败不判红 */ }
        process.exit(fail === 0 ? 0 : 1);
    } catch (e) {
        console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
        try { if (harness) harness.restore(); } catch (e2) { /* ignore */ }
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
        process.exit(1);
    } finally {
        global.fetch = realFetch;
    }
})();
