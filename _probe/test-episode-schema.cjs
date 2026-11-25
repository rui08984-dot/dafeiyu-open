#!/usr/bin/env node
/**
 * _probe/test-episode-schema.cjs —— 片段卡「结构化输出」证伪测试（2026-11-24 第四轮）
 *
 * 背景：MemOperator 是指令微调的 4B 小模型，片段卡的格式靠 prompt 撑；原 prompt 是
 * 「一句话 + 一行 JSON 样例」，一旦发散（带解释 / 少字段 / facts 写成字符串），
 * parseCard 整批判废、游标不动、每 5 分钟重烧一次 LLM。本轮三件事必须同时成立：
 *   ① prompt 形状向训练分布靠（单条 user / 规则在前 / schema 在后 / 只输出一个 JSON 对象）；
 *   ② 调用带 response_format(json_schema)，且**真的进到请求体**；
 *   ③ 不合 schema 的输出**不被静默接受**（warn + 游标不动）。
 *
 * 覆盖：
 *   A. schema/校验器：合法通过、缺 summary 拒绝、facts 类型不对拒绝、多余字段拒绝
 *      （含顺手验证「category 带竖线」这类枚举串不会被夹带进卡片 —— 本卡片 schema 里没有 category）
 *   B. prompt 形状：单条 user、规则在前、schema 在后、对话在最后
 *   C. 端到端（假 context）：合规写卡 / 空摘要推进游标 / 坏输出不推进游标 + warn
 *   D. 服务端 400 不认 response_format → 降级一次纯 prompt（只 warn 一次）
 *   E. 真 PluginContext.callLLM：response_format 出现在 fetch 请求体里（fake fetch）
 *
 * 全程离线：不连 11435，不启动 llama-server，不写真实记录室（PET_DATA_ROOT 指临时目录）。
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const _TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-episode-schema-'));
process.env.PET_DATA_ROOT = _TMP_DATA;
process.env.PET_TELEMETRY_DIR = _TMP_DATA;

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const P = require(path.join(LIVE, 'plugins', 'community', 'memory-evolve', 'index.js'));
const ES = require(path.join(LIVE, 'js', 'core', 'episode-store.js'));
const UF = require(path.join(LIVE, 'js', 'core', 'user-facts.js'));
const BL = require(path.join(LIVE, 'js', 'core', 'background-llm.js'));
const { PluginContext } = require(path.join(LIVE, 'js', 'core', 'plugin-context.js'));
const { llmProviderManager } = require(path.join(LIVE, 'js', 'core', 'llm-provider.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}

// ── 假 fetch（只给 /health 与 /chat/completions；用于 C 的闸与 E 的请求体断言）──
const realFetch = global.fetch;
let fetchCalls = [];
let lastChatBody = '';
function installFetch() {
    fetchCalls = [];
    lastChatBody = '';
    global.fetch = async (url, opts) => {
        const u = String(url);
        fetchCalls.push({ url: u, opts: opts || {} });
        if (/\/health$/.test(u)) {
            return { ok: true, status: 200, json: async () => ({ status: 'ok' }), text: async () => '{"status":"ok"}' };
        }
        if (/\/chat\/completions$/.test(u)) {
            lastChatBody = String((opts && opts.body) || '');
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [{ message: { content: '{"title":"卡片","summary":"他下午去修了电脑","facts":[]}' } }],
                    usage: { prompt_tokens: 12, completion_tokens: 8 },
                }),
                text: async () => '',
            };
        }
        throw new Error('unexpected fetch url: ' + u);
    };
}

// ── 片段卡的假 IO（与 test-local-llm / test-episode-store 同思路）────────────
const fake = { cursor: 0, written: [], turns: [], llmCalls: [], replies: [], errors: [] };
const origEs = {
    loadCursor: ES.loadCursor, saveCursor: ES.saveCursor, readTurns: ES.readTurns,
    appendEpisode: ES.appendEpisode, loadEpisodes: ES.loadEpisodes,
};
const origAddFact = UF.addFact;

function resetFake() {
    fake.cursor = 0;
    fake.written = [];
    fake.turns = [{ role: 'user', text: '今天下午电脑坏了，我去修了' }, { role: 'assistant', text: '修好了吗？' }];
    fake.llmCalls = [];
    fake.replies = [];
    fake.errors = [];
    ES.loadCursor = () => fake.cursor;
    ES.saveCursor = (n) => { fake.cursor = n; return true; };
    ES.readTurns = () => ({ turns: fake.turns, consumed: fake.turns.length, total: fake.turns.length });
    ES.appendEpisode = (card) => { fake.written.push(card); return true; };
    ES.loadEpisodes = () => fake.written.slice();
    UF.addFact = () => ({ ok: true, duplicate: false, id: 'f' });
}

function restoreFake() {
    Object.assign(ES, origEs);
    UF.addFact = origAddFact;
}

function mkPlugin(reply) {
    const p = new P();
    const logs = [];
    p.context = {
        getPluginFileConfig: () => ({ enabled: true, episode_min_turns: 2, episode_idle_min: 1 }),
        getPluginFileLog: () => {},
        getConfig: () => ({ cost: {} }),
        log: (lv, m) => logs.push(String(lv) + ':' + String(m)),
        addSystemPromptPatch: () => {}, removeSystemPromptPatch: () => {},
        getMessages: () => [],
        callLLM: async (prompt, options) => {
            fake.llmCalls.push({ prompt, options: options || {} });
            const i = fake.llmCalls.length - 1;
            if (fake.errors[i]) throw fake.errors[i];
            if (Array.isArray(reply)) return reply[i];
            return reply;
        },
    };
    return { p, logs };
}

const VALID = '{"title":"修电脑","summary":"他下午电脑坏了去修，修到晚上才好","facts":["电脑下午坏了"]}';

(async () => {
    const prevLastUser = global.__lastUserInputAt;
    try {
        installFetch();

        // ══════════════════════════════════════════════════════════════
        // A. schema / 校验器：不猜、不接受半截
        // ══════════════════════════════════════════════════════════════
        {
            const v = P.validateEpisodeCardOutput;
            ok('schema 导出：additionalProperties=false、required 只有 summary（空摘要是合法输出）',
                P.EPISODE_CARD_SCHEMA.additionalProperties === false
                && Array.isArray(P.EPISODE_CARD_SCHEMA.required)
                && P.EPISODE_CARD_SCHEMA.required.length === 1
                && P.EPISODE_CARD_SCHEMA.required[0] === 'summary');
            ok('schema 字段与 episodes.jsonl 一致（title/summary/facts）',
                Object.keys(P.EPISODE_CARD_SCHEMA.properties).sort().join(',') === 'facts,summary,title');

            const r1 = v(VALID);
            ok('合法 JSON → ok', r1.status === 'ok' && /电脑/.test(r1.json.summary), r1.status);

            const r2 = v('{"title":"只有标题"}');
            ok('缺 summary → bad（拒绝）', r2.status === 'bad' && /summary/.test(r2.reason), r2.reason);

            const r3 = v('{"summary":42}');
            ok('summary 不是字符串 → bad', r3.status === 'bad' && /summary/.test(r3.reason), r3.reason);

            const r4 = v('{"summary":"他去修电脑了","facts":"电脑坏了"}');
            ok('facts 是字符串（不是数组）→ bad，不静默转成一条', r4.status === 'bad' && /facts/.test(r4.reason), r4.reason);

            const r5 = v('{"summary":"他去修电脑了","facts":["电脑坏了",3]}');
            ok('facts 里混入非字符串 → bad', r5.status === 'bad' && /facts/.test(r5.reason), r5.reason);

            // 卡片 schema 里**没有 category**；顺带证明模型自作多情塞的枚举串会被拒，
            // 而不是被宽字段吞进 episodes.jsonl（画像 category 的问题是另一条链，见报告）。
            const r6 = v('{"summary":"他去修电脑了","category":"工作|生活"}');
            ok('多余字段（如 category:"工作|生活"）→ bad，不夹带进卡片',
                r6.status === 'bad' && /多余字段/.test(r6.reason) && /category/.test(r6.reason), r6.reason);

            const r7 = v('{"summary":""}');
            ok('空 summary → empty（「没值得记的」是合法结论，要推进游标）', r7.status === 'empty', r7.status);

            const r8 = v('```json\n' + VALID + '\n```');
            ok('带 ```json 围栏 → 仍能解析', r8.status === 'ok', r8.status);

            const r9 = v('抱歉，这段没什么可记的。');
            ok('纯解释没有 JSON → bad', r9.status === 'bad', r9.reason);
        }

        // ══════════════════════════════════════════════════════════════
        // B. prompt 形状：单条 user / 规则在前 / schema 在后 / 对话在最后
        // ══════════════════════════════════════════════════════════════
        {
            const body = '他：今天下午电脑坏了，我去修了\n你：修好了吗？';
            const prompt = P.buildEpisodePrompt(body);
            const iRule = prompt.indexOf('整理规则');
            const iSchema = prompt.indexOf('"title"');
            const iDialogue = prompt.indexOf('对话：');
            ok('规则在 schema 之前、schema 在对话之前（训练分布的顺序）',
                iRule > 0 && iSchema > iRule && iDialogue > iSchema,
                ['rule=' + iRule, 'schema=' + iSchema, 'dialogue=' + iDialogue].join(' '));
            ok('明确「只输出一个 JSON 对象，不要解释」', /只输出一个 JSON 对象，不要解释/.test(prompt));
            ok('五条规则在（只写出现过的 / 第三人称 / 绝对时间 / 宁全勿简 / 空输出）',
                /只写对话里真正出现过的信息/.test(prompt) && /第三人称/.test(prompt)
                && /绝对时间/.test(prompt) && /宁全勿简/.test(prompt) && /\{"summary":""\}/.test(prompt));
            ok('对话正文原样跟在最后（截断 4000 字）', prompt.trimEnd().endsWith(body));
            const baseLen = P.buildEpisodePrompt('').length;
            ok('长对话按 4000 字截断（不无限吃 token）',
                P.buildEpisodePrompt('x'.repeat(9000)).length === baseLen + 4000,
                P.buildEpisodePrompt('x'.repeat(9000)).length + ' 字（规则 ' + baseLen + ' + 对话 4000）');
        }

        // ══════════════════════════════════════════════════════════════
        // C. 端到端：合规写卡 / 空摘要推进游标 / 坏输出不推进游标
        // ══════════════════════════════════════════════════════════════
        {
            resetFake();
            global.__lastUserInputAt = Date.now() - 2 * 60 * 60 * 1000;   // 空闲 2h
            const { p, logs } = mkPlugin(VALID);
            await p.onInit();
            const card = await p._maybeBuildEpisode();

            ok('合规输出 → 写卡 + 推进游标',
                !!card && fake.written.length === 1 && fake.cursor === fake.turns.length,
                JSON.stringify({ cursor: fake.cursor, written: fake.written.length }));

            const opt = (fake.llmCalls[0] || {}).options || {};
            ok('调用带 response_format.type=json_schema',
                opt.response_format && opt.response_format.type === 'json_schema',
                JSON.stringify(opt.response_format && opt.response_format.type));
            ok('schema 名 episode_card + strict:true',
                opt.response_format && opt.response_format.json_schema
                && opt.response_format.json_schema.name === 'episode_card'
                && opt.response_format.json_schema.strict === true);
            ok('response_format.schema 就是 EPISODE_CARD_SCHEMA（同一份，不分叉）',
                opt.response_format.json_schema.schema === P.EPISODE_CARD_SCHEMA);
            ok('抽取类采样显式带上（0.2/0.8/20/0 + repeat 1.05）',
                opt.temperature === 0.2 && opt.top_p === 0.8 && opt.top_k === 20
                && opt.min_p === 0 && opt.repeat_penalty === 1.05,
                JSON.stringify({ t: opt.temperature, p: opt.top_p, k: opt.top_k, m: opt.min_p }));
            // 2026-11-25 契约：片段卡不再传死 provider_id，而是把 localLLM.resolve() 的
            // 回环连接直接放进 options（resolve 找不到时回落内置 127.0.0.1:11435，绝不回云）。
            ok('仍然只走本地（api_url 是 resolve() 的回环 11435，且不传死 provider_id）',
                /^http:\/\/127\.0\.0\.1:11435\/v1$/.test(String(opt.api_url || ''))
                && !Object.prototype.hasOwnProperty.call(opt, 'provider_id'),
                JSON.stringify({ api_url: opt.api_url, provider_id: opt.provider_id }));
            ok('prompt 是单条字符串（callLLM 只收 prompt）且含规则',
                typeof fake.llmCalls[0].prompt === 'string' && /整理规则/.test(fake.llmCalls[0].prompt));
            ok('写卡过程没有 warn（合规输出不该报警）',
                !logs.some((l) => l.startsWith('warn:')), logs.filter((l) => l.startsWith('warn:')).join(' | '));
        }
        {
            resetFake();
            global.__lastUserInputAt = Date.now() - 2 * 60 * 60 * 1000;
            const { p } = mkPlugin('{"summary":""}');
            await p.onInit();
            const card = await p._maybeBuildEpisode();
            ok('空摘要 → 不写卡、推进游标（这段不再重试）',
                card === null && fake.written.length === 0 && fake.cursor === fake.turns.length,
                JSON.stringify({ cursor: fake.cursor, written: fake.written.length }));
        }
        {
            resetFake();
            global.__lastUserInputAt = Date.now() - 2 * 60 * 60 * 1000;
            const { p, logs } = mkPlugin('{"title":"只有标题"}');
            await p.onInit();
            const card = await p._maybeBuildEpisode();
            ok('坏输出 → 不写卡、游标不动（下次重试，一行不丢）',
                card === null && fake.written.length === 0 && fake.cursor === 0,
                JSON.stringify({ cursor: fake.cursor, written: fake.written.length }));
            ok('坏输出留一条 warn（写明不合 schema，不是静默）',
                logs.some((l) => l.startsWith('warn:') && /不合 schema/.test(l)),
                logs.filter((l) => l.startsWith('warn:')).join(' | '));
        }

        // ══════════════════════════════════════════════════════════════
        // D. 服务端不认 response_format（400）→ 降级一次纯 prompt
        // ══════════════════════════════════════════════════════════════
        {
            resetFake();
            global.__lastUserInputAt = Date.now() - 2 * 60 * 60 * 1000;
            const { p, logs } = mkPlugin([undefined, VALID]);
            fake.errors[0] = Object.assign(new Error('LLM API error: 400 — response_format is not supported'), {
                status: 400, body: '{"error":{"message":"response_format is not supported"}}',
            });
            await p.onInit();
            const card = await p._maybeBuildEpisode();
            ok('400(response_format) → 自动降级重试一次并成功写卡',
                !!card && fake.llmCalls.length === 2 && fake.written.length === 1,
                JSON.stringify({ calls: fake.llmCalls.length, written: fake.written.length }));
            ok('降级那次不带 response_format（纯 prompt 约束）',
                !!fake.llmCalls[1] && !('response_format' in (fake.llmCalls[1].options || {})));
            ok('降级只 warn 一次（写明服务端不支持）',
                logs.filter((l) => /不支持 response_format/.test(l)).length === 1,
                logs.filter((l) => /不支持 response_format/.test(l)).length + ' 条');
        }
        {
            resetFake();
            global.__lastUserInputAt = Date.now() - 2 * 60 * 60 * 1000;
            const { p } = mkPlugin(undefined);
            fake.errors[0] = Object.assign(new Error('LLM API error: 400 — bad request'), {
                status: 400, body: '{"error":{"message":"n_predict must be > 0"}}',
            });
            await p.onInit();
            const card = await p._maybeBuildEpisode();
            ok('其它 400 不被兜底吞掉（照旧失败、游标不动、只调一次）',
                card === null && fake.llmCalls.length === 1 && fake.cursor === 0,
                JSON.stringify({ calls: fake.llmCalls.length, cursor: fake.cursor }));
        }

        // ══════════════════════════════════════════════════════════════
        // E. 真 PluginContext.callLLM：response_format 真的进请求体
        // ══════════════════════════════════════════════════════════════
        {
            llmProviderManager.init({
                llm_providers: [{
                    id: 'local-memory', api_key: 'local-no-key', api_url: 'http://127.0.0.1:11435/v1',
                    models: [{ model_id: 'MemOperator-4B', enabled: true }],
                }],
                llm: { provider_id: 'local-memory' },
            });
            const ctx = new PluginContext('plugins/test-episode-schema', {}, null);
            const out = await ctx.callLLM('把这段压成卡片', {
                provider_id: 'local-memory',
                temperature: 0.2,
                max_tokens: 64,
                response_format: {
                    type: 'json_schema',
                    json_schema: { name: 'episode_card', strict: true, schema: P.EPISODE_CARD_SCHEMA },
                },
            });
            let sent = null;
            try { sent = JSON.parse(lastChatBody); } catch (e) { sent = null; }
            ok('callLLM 返回 content', /卡片/.test(String(out)), String(out).slice(0, 30));
            ok('请求体里真的有 response_format（plugin-context 透传）',
                !!sent && sent.response_format && sent.response_format.type === 'json_schema'
                && sent.response_format.json_schema.name === 'episode_card',
                sent ? JSON.stringify(Object.keys(sent)) : 'no body');
            ok('provider_id / timeout_ms 等路由字段不进请求体',
                !!sent && !('provider_id' in sent) && !('timeout_ms' in sent) && !('model_id' in sent));
            ok('请求仍发往本地 11435（没有被 provider 解析带到云端）',
                fetchCalls.some((c) => /127\.0\.0\.1:11435\/v1\/chat\/completions$/.test(c.url)));
            ok('messages 是单条 user（片段卡不分多轮）',
                !!sent && Array.isArray(sent.messages) && sent.messages.length === 1 && sent.messages[0].role === 'user');
        }
    } finally {
        restoreFake();
        global.fetch = realFetch;
        global.__lastUserInputAt = prevLastUser;
        try { fs.rmSync(_TMP_DATA, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + ((e && e.stack) || e));
    try { fs.rmSync(_TMP_DATA, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
    process.exit(1);
});
