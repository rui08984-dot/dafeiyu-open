#!/usr/bin/env node
/**
 * _probe/test-doctor-judge.cjs —— doctor 判据的离线单测（2026-11-24）
 *
 * 为什么测这里：doctor.mjs 一 import 就联网/写 health.json，没法直接单测；判据已抽到
 * pet-runtime/tools/doctor-judge.cjs（纯函数），doctor 与测试共用同一份 —— 测这里等于测
 * doctor 的判据，而且不会为了「让测试过」改 doctor 行为。
 *
 * 覆盖（对应 HANDOFF-2026-11-24 §8.5「doctor 盲区」）：
 *   ① 前缀缓存：样本 <5 → skip（1 条 0% 不再判绿/判红）；≥5 且加权 <40 → warn；0%/≥5 必须 warn；
 *      只取主链样本（label/source = main 或空），插件/本地单列排除；
 *   ② 用量账本：turn_id 真覆盖（<80% → warn「有 X 轮没有任何账本记录」）；
 *      单请求轮全覆盖 → 不 warn；<10 轮 → skip；无 turn_id 老数据回退
 *      「avg<2 且有工具轮」；0 条 → warn；探针/窗外排除；
 *   ②b 用量预算：10 条真账 + 5 条 estimated，80% 分母只含真账，估算条数单列；
 *   ③ 本地记忆：端口死 → skip；端口活但模型不是 MemOperator → warn；模型对 → ok；
 *      在线标签写实际 n_ctx（28672），不再硬编码 32K；
 *   ④ 前缀冻结复用（llm.freeze 契约）：requests<10 → skip；rewrite>20% 或 reuse<50% → warn；
 *      llm.freeze.break 的 rewrite 不叠加（防双计）；探针/窗外样本排除；
 *   ⑤ provider 端点分级：主/可选本地（回环含 127/8 任意端口）/可选云。
 */
'use strict';

const path = require('path');
const judge = require(path.join(__dirname, '..', 'pet-runtime', 'tools', 'doctor-judge.cjs'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
const NOW = 1_800_000_000_000;   // 固定「现在」，窗口判定可重复
const HOUR = 3600 * 1000;

// ── ① 前缀缓存 ──────────────────────────────────────────────────────────
{
    const s = (over) => ({ prompt: 10000, cached: 9500, hitRate: 0.95, hasField: true, ...over });
    ok('无样本 → skip', judge.judgeCacheHit([]).status === 'skip');
    ok('有记录但都没 cached 字段 → skip',
        judge.judgeCacheHit([{ prompt: 100, hasField: false }, { prompt: 200, hasField: false }]).status === 'skip');
    ok('1 条 0% → skip（样本不足，不当结论）', judge.judgeCacheHit([s({ cached: 0, hitRate: 0 })]).status === 'skip');
    ok('4 条 0% → skip（<5）', judge.judgeCacheHit(Array.from({ length: 4 }, () => s({ cached: 0, hitRate: 0 }))).status === 'skip');
    const five0 = judge.judgeCacheHit(Array.from({ length: 5 }, () => s({ cached: 0, hitRate: 0 })));
    ok('5 条全 0% → warn（0% 且样本 ≥5 不能绿）', five0.status === 'warn', five0.status + ' / ' + five0.detail);
    ok('5 条全 0% 的 detail 带 0% 计数', /0% 命中 5\/5/.test(five0.detail), five0.detail);
    const low = judge.judgeCacheHit(Array.from({ length: 6 }, () => s({ cached: 1000, hitRate: 0.1 })));
    ok('加权 10% 且样本 6 → warn', low.status === 'warn', low.detail);
    const healthy = judge.judgeCacheHit(Array.from({ length: 6 }, () => s({})));
    ok('加权 95% 且样本 6 → ok', healthy.status === 'ok', healthy.detail);
    const boundary = judge.judgeCacheHit(Array.from({ length: 5 }, () => s({ cached: 4000, hitRate: 0.4 })));
    ok('加权正好 40% → ok（阈值是 <40）', boundary.status === 'ok', boundary.detail);
    ok('prompt 全 0 → skip（不可测）',
        judge.judgeCacheHit(Array.from({ length: 5 }, () => s({ prompt: 0, cached: 0, hitRate: 0 }))).status === 'skip');

    // 样本筛选：插件/本地小请求混在最近 40 条里会把加权命中率拉偏。
    const cacheRow = (label, source) => ({ cat: 'llm', type: 'llm.cache', metrics: { prompt_tokens: 1 }, label, source });
    const mixed = [
        cacheRow('', 'main'), cacheRow(undefined, 'main'), cacheRow('main', 'main'),
        cacheRow('plugin', 'main'), cacheRow('plugin', 'main'), cacheRow('vision', 'main'),
        cacheRow('', 'local'), cacheRow(undefined, 'local'),
    ];
    const picked = judge.pickCacheSamples(mixed, 40);
    ok('缓存样本只取主链（label/source = main 或空）', picked.samples.length === 3, 'n=' + picked.samples.length);
    ok('插件/本地缓存样本单列计数', picked.excluded === 5, 'excluded=' + picked.excluded);
    ok('limit 只取最近 N 条主链', judge.pickCacheSamples(mixed, 1).samples.length === 1);
}

// ── ② 用量账本覆盖率（turn_id 真覆盖 + 旧口径回退）────────────────────────
{
    const row = (cat, type, ts, extra) => ({ cat, type, ts, ...(extra || {}) });
    // n 轮 turn.end，可选带 turn_id（老数据可以不带）
    const turnEnds = (n, ts = NOW, extra) => Array.from({ length: n }, (_, i) => {
        const e = { ...(extra || {}) };
        if (!('turn_id' in e)) e.turn_id = 't' + (n - i);
        return row('turn', 'turn.end', ts - i * 1000, e);
    });
    // n 条 usage，每个带自己的 turn_id（默认对齐前 ids 轮）
    const usages = (n, ts = NOW, extra) => Array.from({ length: n }, (_, i) => {
        const e = { ...(extra || {}) };
        if (!('turn_id' in e)) e.turn_id = 't' + (n - i);
        return row('llm', 'llm.usage', ts - i * 1000, e);
    });

    ok('完全没有数据 → skip', judge.judgeLedgerCoverage([], NOW).status === 'skip');
    ok('只有 usage 没有 turn → skip',
        judge.judgeLedgerCoverage(usages(20), NOW).status === 'skip');

    // ① 6 轮各 1 请求、turn_id 全覆盖（8004 直驱简单问答的真实形态）→ 不 warn
    const sixSimple = judge.judgeLedgerCoverage([...turnEnds(6), ...usages(6)], NOW);
    ok('6 轮各 1 请求且 turn_id 全覆盖 → 不 warn（覆盖 100%，轮数 <10 → skip）',
        sixSimple.status === 'skip' && sixSimple.covered === 6, sixSimple.status + ' / ' + sixSimple.detail);
    ok('轮数 <10 的 skip 不判绿', sixSimple.coverage === 1 && sixSimple.mode === 'turn-id',
        JSON.stringify({ cov: sixSimple.coverage, mode: sixSimple.mode }));

    // 同形态但 10 轮（样本够了）→ ok
    const tenSimple = judge.judgeLedgerCoverage([...turnEnds(10), ...usages(10)], NOW);
    ok('10 轮各 1 请求且全覆盖 → ok（单请求轮不是漏账）', tenSimple.status === 'ok', tenSimple.detail);
    ok('ok 文案写覆盖 100%', /覆盖 100%/.test(tenSimple.detail), tenSimple.detail);
    ok('detail 写平均 1 请求/轮', /平均 1 请求\/轮/.test(tenSimple.detail), tenSimple.detail);

    // ② 4 轮里 1 轮缺 usage（25% 缺失 ≥ 80% 线下）→ warn，哪怕每轮只有 1 请求
    const fourRows = [];
    for (let i = 1; i <= 4; i++) fourRows.push(row('turn', 'turn.end', NOW - i * 1000, { turn_id: 't' + i }));
    for (let i = 2; i <= 4; i++) fourRows.push(row('llm', 'llm.usage', NOW - i * 1000, { turn_id: 't' + i }));
    const gap = judge.judgeLedgerCoverage(fourRows, NOW);
    ok('4 轮里 1 轮缺 usage → warn', gap.status === 'warn', gap.detail);
    ok('warn 文案写「有 1 轮没有任何账本记录」', /有 1 轮没有任何账本记录/.test(gap.detail), gap.detail);

    // 10 轮里 2 轮缺（80%）→ ok（阈值是 <80）
    const rows80 = [];
    for (let i = 1; i <= 10; i++) rows80.push(row('turn', 'turn.end', NOW - i * 1000, { turn_id: 'u' + i }));
    for (let i = 3; i <= 10; i++) rows80.push(row('llm', 'llm.usage', NOW - i * 1000, { turn_id: 'u' + i }));
    const cov80 = judge.judgeLedgerCoverage(rows80, NOW);
    ok('10 轮覆盖正好 80% → ok（阈值是 <80）', cov80.status === 'ok' && cov80.coverage === 0.8, cov80.detail);

    // ③ 无 turn_id 的旧数据 → 回退旧口径：有工具轮且 avg<2 才 warn；纯闲聊不 warn
    const oldData = (n, u, withTool) => {
        const rows = [...turnEnds(n, NOW, { turn_id: '' }), ...usages(u, NOW, { turn_id: '' })];
        if (withTool) rows.push(row('turn', 'tool.end', NOW - 500));
        return rows;
    };
    const oldChat = judge.judgeLedgerCoverage(oldData(12, 12, false), NOW);
    ok('旧口径：12 轮 12 条纯闲聊（avg=1，无工具轮）→ ok 不 warn',
        oldChat.status === 'ok' && oldChat.mode === 'fallback', oldChat.detail);
    ok('旧口径 ok 文案写明「纯单请求轮不算漏账」', /纯单请求轮不算漏账/.test(oldChat.detail), oldChat.detail);
    const oldTool = judge.judgeLedgerCoverage(oldData(12, 12, true), NOW);
    ok('旧口径：12 轮 12 条但存在工具轮（avg=1 <2）→ warn', oldTool.status === 'warn', oldTool.detail);
    ok('旧口径 warn 文案点名常态 4–5', /4–5/.test(oldTool.detail), oldTool.detail);
    ok('旧口径回退的 detail 写「多数无 turn_id」', /多数无 turn_id/.test(oldTool.detail), oldTool.detail);

    // 多数 usage 有 turn_id 但轮的 turn_id 缺 → 仍走 turn-id 主判据
    const mixed = judge.judgeLedgerCoverage([...turnEnds(10), ...usages(10, NOW, { turn_id: '' })], NOW);
    ok('usage 全无 turn_id 而轮有 → 回退口径（不是 turn-id）', mixed.mode === 'fallback', mixed.detail);

    // ④ <10 轮 → skip（不拿 6 轮合成样本判红/判绿）
    ok('5 轮全覆盖 → skip', judge.judgeLedgerCoverage([...turnEnds(5), ...usages(5)], NOW).status === 'skip');

    // 硬故障不随轮数豁免
    ok('10 轮 / 0 条 → warn（账本一条没写不能 skip 成绿）',
        judge.judgeLedgerCoverage(turnEnds(10), NOW).status === 'warn');
    ok('0 条文案写「一条都没写」', /一条都没写/.test(judge.judgeLedgerCoverage(turnEnds(10), NOW).detail));
    ok('2 轮 0 条 → 仍 warn（账本一条没写是硬故障）',
        judge.judgeLedgerCoverage(turnEnds(2), NOW).status === 'warn');

    // 工具循环：10 轮每轮 4.7 请求 → ok 且覆盖 100%
    const busy = [];
    for (let i = 1; i <= 10; i++) {
        busy.push(row('turn', 'turn.end', NOW - i * 1000, { turn_id: 'b' + i }));
        for (let k = 0; k < 5; k++) busy.push(row('llm', 'llm.usage', NOW - i * 1000 - k, { turn_id: 'b' + i }));
    }
    const busyJudge = judge.judgeLedgerCoverage(busy, NOW);
    ok('10 轮 × 5 请求全覆盖 → ok', busyJudge.status === 'ok' && busyJudge.perTurn === 5, busyJudge.detail);

    // ⑤ 被打断/出错的轮不是漏账（2026-11-25 P2）：
    //    流式吐字后失败 / 被用户打断的请求不落 llm.usage；旧逻辑把这些轮算成
    //    「有轮没记账」→ warn 假红。outcome 是 turn.end 的行级字段（telemetry.js:117），
    //    取值按生产者实际代码（llm-handler ok/error、InputRouter prevented/error、
    //    tool-executor tool-batch）。
    const twelve = [];
    for (let i = 1; i <= 12; i++) {
        twelve.push(row('turn', 'turn.end', NOW - i * 1000, {
            turn_id: 'x' + i, outcome: i <= 2 ? 'interrupted' : 'ok',
        }));
    }
    for (let i = 3; i <= 12; i++) twelve.push(row('llm', 'llm.usage', NOW - i * 1000, { turn_id: 'x' + i }));
    const twelveJudge = judge.judgeLedgerCoverage(twelve, NOW);
    ok('12 轮里 2 轮 interrupted 且无 usage → 覆盖 100%（不算漏账）',
        twelveJudge.status === 'ok' && twelveJudge.coverage === 1, twelveJudge.detail);
    ok('排除数单列在文案里（已排除 2 轮被打断/出错）',
        /已排除 2 轮被打断\/出错/.test(twelveJudge.detail), twelveJudge.detail);
    ok('turns 只算可计费轮（10），excluded=2',
        twelveJudge.turns === 10 && twelveJudge.excluded === 2,
        JSON.stringify({ turns: twelveJudge.turns, excluded: twelveJudge.excluded }));

    // 用户口径的 10 轮形态：2 轮 interrupted 无 usage → 剩 8 轮全覆盖，不判 warn（<10 只 skip）
    const tenTwo = [];
    for (let i = 1; i <= 10; i++) {
        tenTwo.push(row('turn', 'turn.end', NOW - i * 1000, {
            turn_id: 'y' + i, outcome: i <= 2 ? 'interrupted' : 'ok',
        }));
    }
    for (let i = 3; i <= 10; i++) tenTwo.push(row('llm', 'llm.usage', NOW - i * 1000, { turn_id: 'y' + i }));
    const tenTwoJudge = judge.judgeLedgerCoverage(tenTwo, NOW);
    ok('10 轮里 2 轮 interrupted 且无 usage → 覆盖 100%、不判 warn',
        tenTwoJudge.status !== 'warn' && tenTwoJudge.coverage === 1, tenTwoJudge.detail);

    // 真漏账不能被排除逻辑洗白：10 轮里 1 轮 ok 但无 usage → 仍 warn
    // （5 轮 interrupted + 1 轮 error 被排除，剩 4 个 ok 轮里 3 个有账 = 75% < 80%）
    const withGap = [];
    for (let i = 1; i <= 6; i++) {
        withGap.push(row('turn', 'turn.end', NOW - i * 1000, {
            turn_id: 'z' + i, outcome: i <= 5 ? 'interrupted' : 'error',
        }));
    }
    for (let i = 7; i <= 10; i++) {
        withGap.push(row('turn', 'turn.end', NOW - i * 1000, { turn_id: 'z' + i, outcome: 'ok' }));
    }
    for (let i = 8; i <= 10; i++) withGap.push(row('llm', 'llm.usage', NOW - i * 1000, { turn_id: 'z' + i }));
    const gapJudge = judge.judgeLedgerCoverage(withGap, NOW);
    ok('10 轮里 1 轮 ok 但无 usage → warn（可计费轮覆盖 3/4=75%）',
        gapJudge.status === 'warn', gapJudge.detail);
    ok('漏账 warn 仍写「有 1 轮没有任何账本记录」，并单列已排除 6 轮',
        /有 1 轮没有任何账本记录/.test(gapJudge.detail) && /已排除 6 轮/.test(gapJudge.detail),
        gapJudge.detail);

    // 全部轮都被打断 → 不判覆盖（别把「没账可记」当硬故障）
    const allInterrupted = Array.from({ length: 6 }, (_, i) => row('turn', 'turn.end', NOW - i * 1000, {
        turn_id: 'ai' + i, outcome: 'interrupted',
    }));
    const allIntJudge = judge.judgeLedgerCoverage(allInterrupted, NOW);
    ok('全部轮 interrupted 且 0 usage → skip（不误报账本没写）',
        allIntJudge.status === 'skip' && /全部被打断\/出错/.test(allIntJudge.detail), allIntJudge.detail);

    // 探针/窗外
    const probe = judge.judgeLedgerCoverage([...turnEnds(10, NOW, { source: 'probe' }), ...usages(1)], NOW);
    ok('source=probe 的探针轮不参与', probe.status === 'skip' && probe.turns === 0, JSON.stringify(probe));
    const old = judge.judgeLedgerCoverage([...turnEnds(10, NOW - 30 * HOUR), ...usages(1, NOW - 30 * HOUR)], NOW);
    ok('24h 窗外的不参与', old.status === 'skip', JSON.stringify(old));
}

// ── ②b 用量预算：真账 / 估算分离 ─────────────────────────────────────────
{
    // 10 条云端真账（prompt 500 + 出 100 = 600/条 → 6000）+ 5 条云端估算（2000+200=2200/条 → 11000）
    // + 1 条本地真账（18000）。
    // 若估算/本地混进分母 → (6000+11000+18000)/10000 = 350% → 误报；
    // 只算云端真账 → 6000/10000 = 60%。
    const mk = (source, p, c, estimated, ts) => ({
        cat: 'llm', type: 'llm.usage', ts, source,
        metrics: { prompt_tokens: p, completion_tokens: c, ...(estimated ? { estimated: 1 } : {}) },
    });
    const rows = [
        ...Array.from({ length: 10 }, (_, i) => mk('main', 500, 100, false, NOW - 1000 - i * 1000)),
        ...Array.from({ length: 5 }, (_, i) => mk('main', 2000, 200, true, NOW - 200000 - i * 1000)),
        mk('local', 9000, 9000, false, NOW),
    ];
    const v = judge.judgeUsageBudget(rows, { now: NOW, budget: 10000 });
    ok('80% 分母只含云端非估算真账（6000/10000=60%）',
        v.status === 'ok' && v.pct === 60, JSON.stringify({ status: v.status, pct: v.pct }));
    ok('估算条数单列（云端 5 条）', v.week.cloudEstimated === 5 && /估算 5 条/.test(v.detail), v.detail);
    ok('detail 写明估算「不计入周预算」', /不计入周预算/.test(v.detail), v.detail);
    ok('本地用量不进真账分母', v.weekRealTokens === 6000, 'real=' + v.weekRealTokens);
    ok('未设预算 → stats（仅统计）', judge.judgeUsageBudget(rows, { now: NOW, budget: 0 }).status === 'stats');

    // 极端：只有估算行 → 预算 0%，不能被估算打满
    const onlyEst = Array.from({ length: 5 }, (_, i) => mk('main', 2000, 200, true, NOW - i * 1000));
    const v2 = judge.judgeUsageBudget(onlyEst, { now: NOW, budget: 1000 });
    ok('全是估算行 → 预算 0%（不误报超支）', v2.status === 'ok' && v2.pct === 0,
        JSON.stringify({ status: v2.status, pct: v2.pct }));
    ok('全是估算行时 detail 仍写估算条数', /估算 5 条/.test(v2.detail), v2.detail);

    // 字段名对齐：另一人若把 estimated 放在行级（row.estimated）也要认
    ok('estimated 兼容 metrics.estimated=1 / "1" / true / 行级',
        judge.isEstimatedRow({ metrics: { estimated: 1 } })
        && judge.isEstimatedRow({ metrics: { estimated: '1' } })
        && judge.isEstimatedRow({ estimated: true })
        && !judge.isEstimatedRow({ metrics: { estimated: 0 } })
        && !judge.isEstimatedRow({ metrics: {} }));
}

// ── ③ 本地记忆模型 ──────────────────────────────────────────────────────
{
    ok('cost.local_memory=false → skip',
        judge.judgeLocalMemory({ enabled: false, healthError: false, models: [] }).status === 'skip');
    const down = judge.judgeLocalMemory({ enabled: true, healthError: 'ECONNREFUSED', models: [] });
    ok('11435 未起 → skip（可选服务，不判红）', down.status === 'skip', down.detail);
    ok('未起文案写明「可选」', /可选/.test(down.detail), down.detail);
    const noModel = judge.judgeLocalMemory({ enabled: true, healthError: false, models: [] });
    ok('端口活但 /v1/models 空 → warn', noModel.status === 'warn', noModel.detail);
    const wrong = judge.judgeLocalMemory({ enabled: true, healthError: false, models: ['qwen3-8b', 'llama-3'] });
    ok('端口活着但模型不对 → warn', wrong.status === 'warn', wrong.detail);
    ok('模型不对文案点名实际 id', /qwen3-8b/.test(wrong.detail), wrong.detail);
    ok('MemOperator-4B → ok',
        judge.judgeLocalMemory({ enabled: true, healthError: false, models: ['MemOperator-4B'] }).status === 'ok');
    ok('带路径的 gguf id 也认（大小写不敏感）',
        judge.judgeLocalMemory({ enabled: true, healthError: false, models: ['D:/models/memoperator-4b-q4.gguf'] }).status === 'ok');

    // 展示层（CO 2026-11-24）：写死「32K/KV q8」和 Daily 档实际 n_ctx=28672 对不上。
    const online = judge.judgeLocalMemory({ enabled: true, healthError: false, models: ['MemOperator-4B'], nCtx: 28672 });
    ok('在线标签写实际 n_ctx（28672）', /28672/.test(online.detail), online.detail);
    ok('不再硬编码「32K」/「KV q8」', !/32K|KV q8/.test(online.detail), online.detail);
    ok('KV 探测不到就不写 KV=', !/KV=/.test(online.detail), online.detail);
    const noCtx = judge.judgeLocalMemory({ enabled: true, healthError: false, models: ['MemOperator-4B'] });
    ok('读不到 n_ctx 就只写「在线」（不臆造上下文）',
        /在线/.test(noCtx.detail) && !/ctx=/.test(noCtx.detail), noCtx.detail);
    ok('n_ctx 不改变判定：仍是 ok', noCtx.status === 'ok' && online.status === 'ok');
}

// ── ④ 前缀冻结复用（llm.freeze 契约）────────────────────────────────────
{
    const freeze = (ts, m, extra) => ({
        cat: 'llm', type: 'llm.freeze', ts, turn_id: 't' + ts,
        metrics: { reuse: 0, rebuild: 0, rewrite: 0, requests: 1, prefix_msgs: 3, prefix_chars: 500, ...(m || {}) },
        ...(extra || {}),
    });
    const freezeBreak = (ts, extra) => ({
        cat: 'llm', type: 'llm.freeze.break', ts, turn_id: 'tb' + ts,
        metrics: { rewrite: 1, at_msg: 2 }, ...(extra || {}),
    });

    ok('没有 telemetry → skip', judge.judgeFreezeReuse([], NOW).status === 'skip');
    ok('没有 llm.freeze（只有别的类型）→ skip',
        judge.judgeFreezeReuse([{ cat: 'context', type: 'context.budget', ts: NOW, metrics: { total_tokens: 1 } }], NOW).status === 'skip');
    const tiny = judge.judgeFreezeReuse(Array.from({ length: 9 }, (_, i) => freeze(NOW - i * 1000, { requests: 1 })), NOW);
    ok('requests 合计 9（<10）→ skip（样本不足）', tiny.status === 'skip', tiny.detail);

    const healthyRows = Array.from({ length: 10 }, (_, i) => freeze(NOW - i * 1000, { requests: 4, reuse: 3, rewrite: 0 }));
    const healthy = judge.judgeFreezeReuse(healthyRows, NOW);
    ok('40 请求 / 复用 30（75%）/ 改写 0 → ok', healthy.status === 'ok', healthy.detail);
    ok('ok 时 requests/reuse 聚合正确', healthy.requests === 40 && healthy.reuse === 30,
        JSON.stringify({ r: healthy.requests, u: healthy.reuse }));

    const lowReuseRows = Array.from({ length: 10 }, (_, i) => freeze(NOW - i * 1000, { requests: 4, reuse: 1, rewrite: 0 }));
    const lowReuse = judge.judgeFreezeReuse(lowReuseRows, NOW);
    ok('40 请求 / 复用 10（25%）→ warn', lowReuse.status === 'warn', lowReuse.detail);
    ok('warn 文案写明「工具循环内前缀复用率过低」', /工具循环内前缀复用率过低/.test(lowReuse.detail), lowReuse.detail);

    const highRewriteRows = Array.from({ length: 10 }, (_, i) => freeze(NOW - i * 1000, { requests: 4, reuse: 3, rewrite: 1 }));
    const highRewrite = judge.judgeFreezeReuse(highRewriteRows, NOW);
    ok('40 请求 / 改写 10（25% >20%）→ warn', highRewrite.status === 'warn', highRewrite.detail);

    // 阈值边界：正好 20% 改写 / 正好 50% 复用 → ok
    const edge = judge.judgeFreezeReuse([freeze(NOW, { requests: 10, reuse: 5, rewrite: 2 })], NOW);
    ok('改写正好 20%、复用正好 50% → ok（阈值是 >/<）', edge.status === 'ok', edge.detail);

    // ⚠ 防双计：break 的 rewrite 不能再加到 freeze 的 rewrite 上
    const withBreaks = [
        freeze(NOW, { requests: 10, reuse: 10, rewrite: 0 }),
        freezeBreak(NOW), freezeBreak(NOW - 1), freezeBreak(NOW - 2),
    ];
    const noDouble = judge.judgeFreezeReuse(withBreaks, NOW);
    ok('llm.freeze.break 的 rewrite 不叠加（否则 3/10=30% 会误报）', noDouble.status === 'ok' && noDouble.rewrite === 0,
        JSON.stringify({ status: noDouble.status, rewrite: noDouble.rewrite }));

    const probe = [freeze(NOW, { requests: 4, reuse: 0, rewrite: 4 }, { source: 'probe' })];
    ok('source=probe 的探针轮不参与', judge.judgeFreezeReuse(probe, NOW).status === 'skip');
    const old = [freeze(NOW - 30 * HOUR, { requests: 20, reuse: 0, rewrite: 20 })];
    ok('24h 窗外的旧样本不参与', judge.judgeFreezeReuse(old, NOW).status === 'skip');
}

// ── ⑤ provider 端点分级 ─────────────────────────────────────────────────
{
    const main = { id: 'comad', api_url: 'https://api.example.com/v1' };
    const local = { id: 'local-memory', api_url: 'http://127.0.0.1:11435/v1' };
    const cloudOpt = { id: 'wb', api_url: 'https://api.other.com/v1' };
    ok('provider_id 命中的是主', judge.classifyProvider(main, { mainProviderId: 'comad' }).tier === 'main');
    ok('没配 provider_id 时启用列表第一个是主',
        judge.classifyProvider(main, { mainProviderId: '', firstEnabledId: 'comad' }).tier === 'main');
    ok('回环地址 → 可选本地', judge.classifyProvider(local, { mainProviderId: 'comad' }).tier === 'optional-local');
    ok('wb 回环 127.0.0.1:20128 → 可选本地（端口不限）',
        judge.classifyProvider({ id: 'wb', api_url: 'http://127.0.0.1:20128/v1' }, { mainProviderId: 'comad' }).tier === 'optional-local');
    ok('127.0.0.2:8080 → 可选本地（127/8）',
        judge.classifyProvider({ id: 'x', api_url: 'http://127.0.0.2:8080/v1' }, { mainProviderId: 'comad' }).tier === 'optional-local');
    ok('[::1]:9999 → 可选本地',
        judge.classifyProvider({ id: 'x', api_url: 'http://[::1]:9999/v1' }, { mainProviderId: 'comad' }).tier === 'optional-local');
    ok('localhost:20128 → 可选本地',
        judge.classifyProvider({ id: 'x', api_url: 'http://localhost:20128/v1' }, { mainProviderId: 'comad' }).tier === 'optional-local');
    ok('id 以 local 开头（非回环也算）→ 可选本地',
        judge.classifyProvider({ id: 'local-llm', api_url: 'http://127.0.0.1:9999/v1' }, { mainProviderId: 'comad' }).tier === 'optional-local');
    ok('非回环、非主 → 可选云', judge.classifyProvider(cloudOpt, { mainProviderId: 'comad' }).tier === 'optional-cloud');
    ok('主 provider 即使是回环也判主（主优先）',
        judge.classifyProvider(local, { mainProviderId: 'local-memory' }).tier === 'main');
    ok('端点分级：主=fail', judge.judgeProviderEndpoint('main') === 'fail');
    ok('端点分级：可选本地=skip', judge.judgeProviderEndpoint('optional-local') === 'skip');
    ok('端点分级：可选云=warn', judge.judgeProviderEndpoint('optional-cloud') === 'warn');
}

console.log('\n' + (fail ? '✗' : '✓') + ' doctor 判据：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
