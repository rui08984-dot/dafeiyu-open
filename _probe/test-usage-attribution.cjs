#!/usr/bin/env node
/**
 * _probe/test-usage-attribution.cjs —— 账本归因：turn_id / 双写 / doctor 回退口径（2026-11-25）
 *
 * 要撞的三件事：
 *   ① 同一次请求会不会**既落 estimated 又落真 usage**（emitUsageTelemetry 有几个调用点）；
 *   ② 200 但 body 是错误对象（网关把内容过滤/参数错误包成 200）时，账本和健康状态会怎样；
 *   ③ turn 外调用（后台任务）没有 turn_id 时，doctor 的覆盖判据能不能正确回退。
 *
 * 全程离线：fake fetch；PET_DATA_ROOT / PET_TELEMETRY_DIR 指到临时目录。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-usage-attr-'));
process.env.PET_DATA_ROOT = TMP;
process.env.PET_TELEMETRY_DIR = TMP;

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const { LLMClient } = require(path.join(LIVE, 'js', 'ai', 'llm-client.js'));
const usageLedger = require(path.join(LIVE, 'js', 'core', 'usage-ledger.js'));
const turnCtx = require(path.join(LIVE, 'js', 'core', 'turn-context.js'));
const { llmHealth } = require(path.join(LIVE, 'js', 'core', 'llm-health.js'));
const judge = require(path.join(ROOT, 'pet-runtime', 'tools', 'doctor-judge.cjs'));

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
            usage: usage === undefined ? { prompt_tokens: 800, completion_tokens: 4 } : usage,
        }),
        text: async () => '',
    };
}
function errorBody200(msg) {
    return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ error: { message: msg || 'content policy violation' } }),
        text: async () => '',
    };
}
function installFetch(responder) {
    const bodies = [];
    global.fetch = async (url, init) => {
        let b = null;
        try { b = JSON.parse(init.body); } catch (e) { b = null; }
        bodies.push(b);
        return responder(b, bodies.length - 1);
    };
    return bodies;
}

const MSGS = [{ role: 'system', content: 'S' }, { role: 'user', content: '你好' }];
const newClient = () => new LLMClient({ llm: { api_key: 'k', api_url: 'http://fake.local/v1', model: 'm', retry: { max_attempts: 1, base_delay_ms: 1 } }, });

(async () => {
    const realFetch = global.fetch;
    try {
        // ══════════════════════════════════════════════════════════════════
        // ① turn 内：llm.usage 带 turn_id；turn 外：不带但照样计数
        // ══════════════════════════════════════════════════════════════════
        {
            console.log('\n[①] turn_id 归因');
            const turnId = turnCtx.beginTurn('test');
            installFetch(() => okJson('turn 内'));
            const before = typeRows('llm.usage').length;
            await newClient().chatCompletion(MSGS, null, false);
            turnCtx.endTurn('ok');
            const inTurn = typeRows('llm.usage').slice(before);
            ok('① turn 内落一条 llm.usage', inTurn.length === 1, 'rows=' + inTurn.length);
            ok('① turn 内带 turn_id 且等于当前轮', inTurn[0] && inTurn[0].turn_id === turnId,
                String(inTurn[0] && inTurn[0].turn_id) + ' vs ' + turnId);

            // turn 外（后台任务）：没有活动轮次
            installFetch(() => okJson('turn 外'));
            const before2 = typeRows('llm.usage').length;
            await newClient().chatCompletion(MSGS, null, false);
            const outTurn = typeRows('llm.usage').slice(before2);
            ok('① turn 外落一条 llm.usage', outTurn.length === 1, 'rows=' + outTurn.length);
            ok('① turn 外不带 turn_id（空就留空，不伪造）', outTurn[0] && outTurn[0].turn_id === undefined,
                String(outTurn[0] && outTurn[0].turn_id));

            // doctor 口径：缺 turn_id 的行也算账（aggregateUsage 不看 turn_id）
            const agg = usageLedger.aggregateUsage(rows().filter((r) => r.type === 'llm.usage'), { now: Date.now() });
            ok('① 聚合把两条都算进 n（缺 turn_id 不丢账）', agg.n === 2, 'n=' + agg.n);
            ok('① byLabel 归到 main', agg.byLabel.main === 2, JSON.stringify(agg.byLabel));
        }

        // ══════════════════════════════════════════════════════════════════
        // ② 200 + error body：不许落 usage，也不许把熔断清掉
        // ══════════════════════════════════════════════════════════════════
        {
            console.log('\n[②] 200 + error body 的账本/健康污染');
            // 先把健康状态打到「退避中」，这样 noteSuccess 一被调用就能观测到
            llmHealth.resetForTests();
            llmHealth.noteFailure({ status: 500, message: 'prior outage' }, Date.now());
            ok('② 前置：健康状态已进入退避（canCall.ok=false）',
                llmHealth.canCall(Date.now()).ok === false);
            installFetch(() => errorBody200('content policy violation'));
            const beforeUsage = typeRows('llm.usage').length;
            const beforeCache = typeRows('llm.cache').length;
            let err = null;
            try { await newClient().chatCompletion(MSGS, null, false); } catch (e) { err = e; }
            ok('② 200+error 仍然抛错（调用方必须知道失败）', !!err && /content policy/.test(String(err.message)),
                String(err && err.message).slice(0, 60));
            ok('② 失败的请求不落 llm.usage（不能凭「HTTP 200」记一笔账）',
                typeRows('llm.usage').length === beforeUsage,
                'rows=' + (typeRows('llm.usage').length - beforeUsage));
            ok('② 也不落 llm.cache（没有真实 usage 就没有缓存统计）',
                typeRows('llm.cache').length === beforeCache,
                'rows=' + (typeRows('llm.cache').length - beforeCache));
            ok('② 不把「失败」当成功清熔断（canCall 仍为 false）',
                llmHealth.canCall(Date.now()).ok === false,
                JSON.stringify(llmHealth.canCall(Date.now())));
            ok('② client.lastUsage 不被伪造成一次成功',
                newClient().lastUsage === null);
            // 复原，免得影响后面的健康判据
            llmHealth.resetForTests();
        }

        // ══════════════════════════════════════════════════════════════════
        // ③ 成功请求：llm.cache 与 llm.usage 各一条，但聚合只认 usage（不双计）
        // ══════════════════════════════════════════════════════════════════
        {
            console.log('\n[③] 双遥测不等于双记账');
            installFetch(() => okJson('ok', {
                prompt_tokens: 2000, completion_tokens: 10,
                prompt_tokens_details: { cached_tokens: 1800 },
            }));
            const beforeUsage = typeRows('llm.usage').length;
            const beforeCache = typeRows('llm.cache').length;
            await newClient().chatCompletion(MSGS, null, false);
            ok('③ 一次请求一条 llm.usage', typeRows('llm.usage').length === beforeUsage + 1);
            ok('③ 一次请求一条 llm.cache（老图表用它）', typeRows('llm.cache').length === beforeCache + 1);
            const all = rows();
            const agg = usageLedger.aggregateUsage(all, { now: Date.now() });
            const usageCount = all.filter((r) => r.type === 'llm.usage').length;
            ok('③ aggregateUsage 只数 llm.usage（llm.cache 不参与，没被双计）',
                agg.n === usageCount, 'agg=' + agg.n + ' usage=' + usageCount);
            ok('③ 加权命中率是 90%（1800/2000，不出 180%）',
                agg.weightedCachePct === 90, String(agg.weightedCachePct));
        }

        // ══════════════════════════════════════════════════════════════════
        // ④ doctor：turn 外（无 turn_id）行多时的回退口径
        // ══════════════════════════════════════════════════════════════════
        {
            console.log('\n[④] doctor 回退口径');
            const NOW = 1_800_000_000_000;
            const mkTurn = (i) => ({ ts: NOW - i * 60_000, cat: 'turn', type: 'turn.end', turn_id: 't' + i });
            const mkUsage = (i, withId) => ({
                ts: NOW - i * 60_000, cat: 'llm', type: 'llm.usage',
                metrics: { prompt_tokens: 1000, completion_tokens: 10 },
                ...(withId ? { turn_id: 't' + i } : {}),
            });
            // 12 轮，usage 行大多无 turn_id（后台任务/老数据）：idRatio < 0.5 → 回退
            const turns = Array.from({ length: 12 }, (_, i) => mkTurn(i));
            const usage = [];
            for (let i = 0; i < 12; i += 1) { usage.push(mkUsage(i, false), mkUsage(i, false)); }
            usage.push(mkUsage(0, true));
            const noTools = turns.concat(usage);
            const r1 = judge.judgeLedgerCoverage(noTools, NOW);
            ok('④ 多数无 turn_id → 走 fallback 口径', r1.mode === 'fallback', r1.mode);
            ok('④ 平均 2.1 请求/轮且无工具轮 → ok（纯单请求/少请求不误报）',
                r1.status === 'ok', r1.status + ' / ' + r1.detail);
            // 加一条工具轮，平均请求数掉到 <2 → 才 warn
            const withToolsTool = usage.slice(0, 6).concat(turns.slice(6).concat([{ ts: NOW - 1000, cat: 'turn', type: 'tool.end' }]));
            const r2 = judge.judgeLedgerCoverage(withToolsTool, NOW);
            ok('④ 有工具轮 + 平均 <2 → warn（这才是漏账）', r2.status === 'warn', r2.status + ' / ' + r2.detail);

            // 有 turn_id 且覆盖不足 → 精确判据（不回退）
            const turns3 = Array.from({ length: 12 }, (_, i) => mkTurn(i));
            const usage3 = Array.from({ length: 12 }, (_, i) => mkUsage(i, true));   // t0..t11 全有 id
            // 把其中 5 轮换成「没有账」的最新轮
            const turns4 = turns3.concat(Array.from({ length: 5 }, (_, i) => ({ ts: NOW - 10_000 - i, cat: 'turn', type: 'turn.end', turn_id: 'tx' + i })));
            const r3 = judge.judgeLedgerCoverage(turns4.concat(usage3), NOW);
            ok('④ turn_id 覆盖 12/17 → mode=turn-id 且 warn',
                r3.mode === 'turn-id' && r3.status === 'warn',
                r3.mode + '/' + r3.status + ' / ' + r3.detail);
            ok('④ 缺账轮数写进 detail（可对账）', /有 5 轮没有任何账本记录/.test(r3.detail), r3.detail);
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
