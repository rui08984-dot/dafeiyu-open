#!/usr/bin/env node
/**
 * _probe/test-usage-ledger.cjs —— 用量账本 / provider 基线（ADR-014 轨道 1）
 *
 * 覆盖：
 *   ① prompt-layout.cacheRate 的 miss 解析（原生 miss / 网关推算 / 不可观测）
 *   ② usage-ledger 指纹（忽略图片 URL；改正文/工具调用要变）
 *   ③ context-budget.measureWithBaseline（前缀一致走真账；压缩/裁剪后回退全量估算；
 *      尾部易变尾巴不算变化；工具面变化进增量）
 *   ④ aggregateUsage / budgetStatus（今日/近 7 天、加权缓存、p50/p90、0%、80% 告警线）
 *   ⑤ llm-client 成功响应后暴露 lastUsage + 落 llm.usage 遥测（label main/vision）
 *
 * 隔离：PET_DATA_ROOT / PET_TELEMETRY_DIR 都指到 mkdtemp，绝不碰真实记录室与 .runtime。
 * 不启宿主、不联网（fetch 被替换成固定响应）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');

// ⚠ 必须在任何 require 之前：records-path / telemetry 加载时就算好目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-usage-'));
process.env.PET_DATA_ROOT = TMP;
process.env.PET_TELEMETRY_DIR = TMP;

const PL = require(path.join(LIVE, 'js', 'core', 'prompt-layout.js'));
const UL = require(path.join(LIVE, 'js', 'core', 'usage-ledger.js'));
const CB = require(path.join(LIVE, 'js', 'core', 'context-budget.js'));
const { LLMClient } = require(path.join(LIVE, 'js', 'ai', 'llm-client.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

async function main() {
// ── ① cacheRate：miss 三种口径 ─────────────────────────────────────────────
{
    const a = PL.cacheRate({
        prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200,
    });
    ok('miss：DeepSeek 原生 hit/miss 字段', a.prompt === 1000 && a.cached === 800 && a.miss === 200 && a.rate === 80,
        JSON.stringify(a));

    const b = PL.cacheRate({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 950 } });
    ok('miss：网关只给 cached → prompt-cached 推算', b.cached === 950 && b.miss === 50, JSON.stringify(b));

    const c = PL.cacheRate({ prompt_tokens: 800 });
    ok('miss：没有 cached 字段 → null（不编 0）', c.cached === null && c.miss === null && c.rate === null,
        JSON.stringify(c));

    const d = PL.cacheRate({ prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 123 });
    ok('miss：原生 miss 优先于推算', d.miss === 123, String(d.miss));

    const e = PL.cacheRate(null);
    ok('cacheRate(null) 全 null 且不抛', e.prompt === null && e.cached === null && e.miss === null && e.rate === null);
}

// ── ② 指纹：稳定 / 区分 / 忽略图片 URL ─────────────────────────────────────
{
    const m1 = { role: 'user', content: '今天吃什么' };
    const m1b = { role: 'user', content: '今天吃什么' };
    ok('指纹：同内容稳定', UL.fingerprint(m1) === UL.fingerprint(m1b));
    ok('指纹：正文变化会变', UL.fingerprint(m1) !== UL.fingerprint({ role: 'user', content: '昨天吃什么' }));
    ok('指纹：role 变化会变', UL.fingerprint(m1) !== UL.fingerprint({ role: 'assistant', content: '今天吃什么' }));

    const t1 = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }] };
    const t2 = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{"x":1}' } }] };
    ok('指纹：tool_calls 参数变化会变', UL.fingerprint(t1) !== UL.fingerprint(t2));

    const img1 = { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] };
    const img2 = { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }] };
    ok('指纹：忽略图片 URL（每次截图不同不算变化）', UL.fingerprint(img1) === UL.fingerprint(img2));

    ok('指纹数组长度一致', UL.fingerprints([m1, t1, img1]).length === 3);
    ok('工具指纹顺序敏感', UL.toolHash([{ name: 'a' }, { name: 'b' }]) !== UL.toolHash([{ name: 'b' }, { name: 'a' }]));
    ok('空工具指纹固定', UL.toolHash([]) === UL.toolHash(null));
}

// ── ③ measureWithBaseline：前缀一致走真账，变化回退全量估算 ────────────────
{
    const tools = [{ type: 'function', function: { name: 'alpha', description: 'A' } }];
    const msgs = [{ role: 'system', content: '系统提示'.repeat(30) }];
    for (let i = 0; i < 10; i += 1) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: '消息' + i + '内容'.repeat(40) });

    const est = CB.measure({ messages: msgs, tools });
    const rec = {
        at: Date.now(),
        label: 'main',
        msgCount: msgs.length,
        msgHashes: UL.fingerprints(msgs),
        toolHash: UL.toolHash(tools),
        estimated: { total: est.total, system: est.system, tools: est.tools, history: est.history, volatile: est.volatile },
        // 故意取 2 倍：验证校准系数真被用上（钳在 0.5–2.5）
        prompt_tokens: est.total * 2,
    };

    const r0 = CB.measureWithBaseline({ messages: msgs, tools });
    ok('无 lastUsage → source=estimate', r0.source === 'estimate' && r0.baseline === false);

    const r1 = CB.measureWithBaseline({ messages: msgs, tools, lastUsage: rec });
    ok('前缀一致 → source=provider_usage', r1.source === 'provider_usage' && r1.baseline === true, r1.source);
    ok('总 token 以 provider prompt_tokens 为锚', r1.total === rec.prompt_tokens, r1.total + ' vs ' + rec.prompt_tokens);
    ok('history 乘校准系数（2.0）', r1.calibration === 2 && r1.history === Math.round(est.history * 2),
        'hist=' + r1.history + ' est=' + est.history);
    ok('无新增消息时 addedMessages=0', r1.addedMessages === 0);

    // 追加 2 条 → 只估增量
    const more = msgs.concat([
        { role: 'user', content: '新增一问' },
        { role: 'assistant', content: '新增一答' },
    ]);
    const estMore = CB.measure({ messages: more, tools });
    const r2 = CB.measureWithBaseline({ messages: more, tools, lastUsage: rec });
    const delta = (estMore.total - estMore.tools) - (est.total - est.tools);
    ok('追加 2 条 → 仍是真账', r2.source === 'provider_usage' && r2.addedMessages === 2, 'added=' + r2.addedMessages);
    ok('total = 基线 + 新增估算', r2.total === rec.prompt_tokens + delta, r2.total + ' vs ' + (rec.prompt_tokens + delta));

    // 尾部（最后一条）被易变尾巴改写 → 仍算前缀一致
    const withTail = msgs.map((m, i) => (i === msgs.length - 1
        ? { ...m, content: m.content + '\n（系统补充，不必回应）\n此刻状态：犯困' }
        : m));
    const r3 = CB.measureWithBaseline({ messages: withTail, tools, lastUsage: rec });
    ok('最后一条被易变尾巴改过 → 仍认基线', r3.source === 'provider_usage', r3.source);

    // 早期消息被压缩/裁剪改掉 → 回退估算
    const mutated = msgs.map((m, i) => (i === 3 ? { ...m, content: '被改写' } : m));
    const r4 = CB.measureWithBaseline({ messages: mutated, tools, lastUsage: rec });
    ok('早期消息变化 → 回退全量估算', r4.source === 'estimate' && r4.baseline === false);

    // 历史被裁短
    const shorter = msgs.slice(0, 6);
    const r5 = CB.measureWithBaseline({ messages: shorter, tools, lastUsage: rec });
    ok('历史条数少于基线 → 回退估算', r5.source === 'estimate');

    // 工具面变了（内容/数量）
    const tools2 = tools.concat([{ type: 'function', function: { name: 'beta', description: 'B'.repeat(200) } }]);
    const estT = CB.measure({ messages: msgs, tools: tools2 });
    const r6 = CB.measureWithBaseline({ messages: msgs, tools: tools2, lastUsage: rec });
    ok('工具面变化 → toolChanged 且计入增量',
        r6.source === 'provider_usage' && r6.toolChanged === true && r6.total === rec.prompt_tokens + (estT.tools - est.tools),
        'total=' + r6.total);

    // 调用方没给 tools（压缩插件拿不到工具面）→ 不猜工具变化
    const r7 = CB.measureWithBaseline({ messages: msgs, lastUsage: rec });
    ok('不传 tools → 假定工具未变（总 token 不被扣掉工具）', r7.source === 'provider_usage' && r7.total === rec.prompt_tokens,
        String(r7.total));

    // 没有 msgHashes 的旧记录 → 不可用
    const r8 = CB.measureWithBaseline({ messages: msgs, tools, lastUsage: { at: Date.now(), prompt_tokens: 999 } });
    ok('旧 lastUsage（无指纹）→ 回退估算', r8.source === 'estimate');
}

// ── ③a P1-2：易变块在**中间** user 上（工具轮形态）也能认基线 ───────────────
// 旧指纹把易变块算进 hash；工具轮里它落在中间 user，allowTail 只放行最后一条 →
// 真账基线永远回退估算。修法是指纹对 user 消息剥掉易变块（从 VOLATILE_HEADER 起到末尾）。
{
    const tools = [{ type: 'function', function: { name: 'alpha', description: 'A' } }];
    const VOL = PL.VOLATILE_HEADER;
    const hostTool = [
        { role: 'system', content: '系统提示'.repeat(30) },
        { role: 'user', content: '问A' + '内容'.repeat(20) },
        { role: 'assistant', content: '答A' + '内容'.repeat(20) },
        { role: 'user', content: '问B' + '内容'.repeat(20) },      // 倒数第 3 条：工具轮形态
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }] },
        { role: 'tool', content: '工具结果', tool_call_id: 'c1' },
    ];
    const reqTool = hostTool.map((m, i) => (i === 3
        ? { ...m, content: m.content + '\n\n' + VOL + '\n世界行：他在写代码' }
        : m));
    const estTool = CB.measure({ messages: reqTool, tools });
    const recTool = {
        at: Date.now(),
        label: 'main',
        msgCount: reqTool.length,
        msgHashes: UL.fingerprints(reqTool),
        toolHash: UL.toolHash(tools),
        estimated: { total: estTool.total, system: estTool.system, tools: estTool.tools, history: estTool.history, volatile: estTool.volatile },
        prompt_tokens: estTool.total,
    };

    ok('P1-2：usage-ledger.VOLATILE_HEADER 与 prompt-layout 同步', UL.VOLATILE_HEADER === PL.VOLATILE_HEADER,
        UL.VOLATILE_HEADER + ' vs ' + PL.VOLATILE_HEADER);
    ok('P1-2：指纹剥掉 user 消息末尾的易变块（请求侧 == 宿主侧）',
        UL.fingerprint(hostTool[3]) === UL.fingerprint(reqTool[3]));
    const mutated = { role: 'user', content: '问B（真实内容被改）' + '内容'.repeat(20) };
    ok('P1-2：非易变内容被改，指纹仍然变',
        UL.fingerprint(mutated) !== UL.fingerprint(hostTool[3]));

    // 多模态：易变块是单独 appending 的 text part → 剥完要与宿主侧（少一个 part）一致
    const imgHost = { role: 'user', content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ] };
    const imgReq = { role: 'user', content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
        { type: 'text', text: '\n\n' + VOL + '\n世界行：6 分钟前他在写代码' },
    ] };
    ok('P1-2：多模态 user 剥掉易变 part（URL 不同也不影响）',
        UL.fingerprint(imgHost) === UL.fingerprint(imgReq));

    const rTool = CB.measureWithBaseline({ messages: hostTool, tools, lastUsage: recTool });
    ok('P1-2：易变块在倒数第 3 条（工具轮）→ 仍 source=provider_usage',
        rTool.source === 'provider_usage' && rTool.baseline === true, rTool.source);
    const curTool = CB.measure({ messages: hostTool, tools });
    const expectedTotal = Math.round(recTool.prompt_tokens
        + ((curTool.total - curTool.tools) - (estTool.total - estTool.tools)));
    ok('P1-2：total = provider 基线 + 增量（易变块不重复计入）', rTool.total === expectedTotal,
        rTool.total + ' vs ' + expectedTotal);

    const mutatedHost = hostTool.map((m, i) => (i === 2 ? { ...m, content: '真实内容被改' } : m));
    const rMut = CB.measureWithBaseline({ messages: mutatedHost, tools, lastUsage: recTool });
    ok('P1-2：真实内容被改（非易变块）→ 仍正确回退估算',
        rMut.source === 'estimate' && rMut.baseline === false, rMut.source);
}

// ── ③b 全局槽：set/get/clear + label 分桶 ──────────────────────────────────
{
    UL.clearLastUsage();
    ok('clear 后 get 为 null', UL.getLastUsage() === null);
    UL.setLastUsage({ at: 1, label: 'main', prompt_tokens: 10 });
    UL.setLastUsage({ at: 2, label: 'vision', prompt_tokens: 20 });
    ok('getLastUsage() 取最近一条', UL.getLastUsage().prompt_tokens === 20);
    ok('getLastUsage(label) 分桶', UL.getLastUsage('main').prompt_tokens === 10
        && UL.getLastUsage('vision').prompt_tokens === 20);
    UL.clearLastUsage();
    ok('再次 clear 生效', UL.getLastUsage() === null && UL.getLastUsage('main') === null);
}

// ── ④ aggregateUsage / budgetStatus ────────────────────────────────────────
{
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    const rows = [
        { cat: 'llm', type: 'llm.usage', ts: now - 1000, source: 'main', metrics: {
            prompt_tokens: 1000, cached_tokens: 800, prompt_cache_miss_tokens: 200,
            completion_tokens: 50, reasoning_tokens: 10, hit_rate: 80, has_cache_field: 1,
        } },
        { cat: 'llm', type: 'llm.usage', ts: now - 2000, source: 'vision', metrics: {
            prompt_tokens: 500, cached_tokens: 0, prompt_cache_miss_tokens: 500,
            completion_tokens: 20, hit_rate: 0, has_cache_field: 1,
        } },
        { cat: 'llm', type: 'llm.usage', ts: now - 8 * day, source: 'main', metrics: {
            prompt_tokens: 9000, cached_tokens: 0, completion_tokens: 100, hit_rate: 0, has_cache_field: 1,
        } },
        { cat: 'llm', type: 'llm.cache', ts: now, metrics: { prompt_tokens: 1 } },       // 不相关类型
        { cat: 'llm', type: 'llm.usage', ts: now, metrics: {} },                          // 空 metrics 行也算一次请求
    ];
    const agg = UL.aggregateUsage(rows, { now });
    ok('聚合：今日请求数（空 metrics 的 usage 行也算一次请求）', agg.today.requests === 3, String(agg.today.requests));
    ok('聚合：今日 prompt/completion', agg.today.prompt === 1500 && agg.today.completion === 70,
        agg.today.prompt + '/' + agg.today.completion);
    ok('聚合：近 7 天不含 8 天前那条', agg.week.requests === 3 && agg.week.prompt === 1500,
        agg.week.requests + ' 次 / ' + agg.week.prompt);
    ok('聚合：加权缓存只看带字段样本', agg.weightedCachePct === 53.3, String(agg.weightedCachePct));
    ok('聚合：0% 请求计数', agg.zeros === 1 && agg.withCacheField === 2, agg.zeros + '/' + agg.withCacheField);
    ok('聚合：p50/p90 有值', agg.p50 === 500 && agg.p90 === 1000, agg.p50 + '/' + agg.p90);
    ok('聚合：label 分桶', agg.byLabel.main === 2 && agg.byLabel.vision === 1, JSON.stringify(agg.byLabel));
    ok('聚合：n 只数 llm.usage', agg.n === 4, String(agg.n));

    ok('预算：未设 → 仅统计', UL.budgetStatus(100, null).level === 'stats');
    ok('预算：79.9% → ok', UL.budgetStatus(7990, 10000).level === 'ok' && UL.budgetStatus(7990, 10000).pct === 79.9);
    ok('预算：80% 边界 → 黄警告', UL.budgetStatus(8000, 10000).level === 'warn'
        && UL.budgetStatus(8000, 10000).pct === 80);
}

// ── ⑤ llm-client：lastUsage 暴露 + llm.usage 遥测 ──────────────────────────
{
    const realFetch = global.fetch;
    let sentBody = null;
    global.fetch = async (url, opts) => {
        sentBody = JSON.parse(opts.body);
        return {
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { role: 'assistant', content: '好的' } }],
                usage: {
                    prompt_tokens: 1000,
                    completion_tokens: 20,
                    prompt_cache_hit_tokens: 800,
                    prompt_cache_miss_tokens: 200,
                    completion_tokens_details: { reasoning_tokens: 5 },
                },
            }),
        };
    };
    try {
        const msgs = [{ role: 'system', content: 'S' }, { role: 'user', content: '你好' }];
        const tools = [{ type: 'function', function: { name: 'zeta', description: 'Z' } }];
        const c = new LLMClient({ api_key: 'k', api_url: 'http://127.0.0.1:1/v1', model: 'm1' });
        await c.chatCompletion(msgs, tools);

        const lu = c.lastUsage;
        ok('lastUsage：prompt/cached/miss', lu && lu.prompt_tokens === 1000 && lu.cached_tokens === 800
            && lu.prompt_cache_miss_tokens === 200, JSON.stringify(lu && { p: lu.prompt_tokens, c: lu.cached_tokens, m: lu.prompt_cache_miss_tokens }));
        ok('lastUsage：completion/reasoning', lu.completion_tokens === 20 && lu.reasoning_tokens === 5);
        ok('lastUsage：msgCount/at/label', lu.msgCount === msgs.length && Number.isFinite(lu.at) && lu.label === 'main',
            JSON.stringify({ n: lu.msgCount, label: lu.label }));
        ok('lastUsage：带指纹与分项估算（供 measureWithBaseline）',
            Array.isArray(lu.msgHashes) && lu.msgHashes.length === msgs.length
            && !!lu.estimated && Number.isFinite(lu.estimated.total));
        ok('lastUsage 写入全局槽', UL.getLastUsage() && UL.getLastUsage().at === lu.at);
        ok('请求体没被基线改造（tools 原样、messages 条数不变）',
            Array.isArray(sentBody.tools) && sentBody.tools.length === 1 && sentBody.messages.length === msgs.length);

        const lines = fs.readFileSync(path.join(TMP, 'telemetry.jsonl'), 'utf8').trim().split('\n')
            .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
        const usageRows = lines.filter((l) => l.type === 'llm.usage');
        ok('遥测：落了 llm.usage', usageRows.length === 1, 'lines=' + usageRows.length);
        const u = usageRows[0] || { metrics: {} };
        ok('遥测：prompt/cached/miss/completion/reasoning 都在',
            u.metrics.prompt_tokens === 1000 && u.metrics.cached_tokens === 800
            && u.metrics.prompt_cache_miss_tokens === 200 && u.metrics.completion_tokens === 20
            && u.metrics.reasoning_tokens === 5, JSON.stringify(u.metrics));
        ok('遥测：hit_rate 与 label(source)', u.metrics.hit_rate === 80 && u.source === 'main', u.source);
        ok('遥测：llm.cache 仍然保留（老检查/图表不破）',
            lines.some((l) => l.type === 'llm.cache' && l.metrics && l.metrics.prompt_tokens === 1000));

        // 视觉：消息里带图 → label=vision（不靠调用方改代码）
        const imageMsgs = [{ role: 'user', content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ] }];
        await c.chatCompletion(imageMsgs, null);
        ok('label：含图请求记为 vision', c.lastUsage.label === 'vision', c.lastUsage.label);
        ok('label：vision 进分桶', UL.getLastUsage('vision') && UL.getLastUsage('vision').label === 'vision');

        // P1-3（2026-11-24 对抗审查）：显式 label 优先 —— 主链带历史图也必须是 main
        const mainLabeled = LLMClient.fromProviderConfig(
            { api_key: 'k', api_url: 'http://127.0.0.1:1/v1', model: 'm2' }, {}, 'main');
        await mainLabeled.chatCompletion(imageMsgs, null);
        ok('label：显式 main 优先于「含图 → vision」推断', mainLabeled.lastUsage.label === 'main',
            mainLabeled.lastUsage.label);
        ok('label：lastUsage.main 全局槽跟着更新（真账基线不再停在旧值）',
            UL.getLastUsage('main') && UL.getLastUsage('main').at === mainLabeled.lastUsage.at,
            JSON.stringify(UL.getLastUsage('main') && UL.getLastUsage('main').at));

        // llm.cache 的 source 必须用同一个 label（旧实现硬编码 main）
        const readRows = () => fs.readFileSync(path.join(TMP, 'telemetry.jsonl'), 'utf8').trim().split('\n')
            .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
        const cacheAfterMain = readRows().filter((l) => l.type === 'llm.cache').pop();
        ok('llm.cache：source 跟随 label（显式 main）',
            cacheAfterMain && cacheAfterMain.source === 'main',
            cacheAfterMain && cacheAfterMain.source);

        // 反向对照：纯文本请求 + 显式 vision → source 必须是 vision（硬编码 main 会挂在这条）
        const visionLabeled = LLMClient.fromProviderConfig(
            { api_key: 'k', api_url: 'http://127.0.0.1:1/v1', model: 'm3' }, {}, 'vision');
        await visionLabeled.chatCompletion([{ role: 'user', content: '无图但显式 vision' }], null);
        const cacheAfterVision = readRows().filter((l) => l.type === 'llm.cache').pop();
        ok('llm.cache：source 跟随显式 label（vision，不再硬编码 main）',
            cacheAfterVision && cacheAfterVision.source === 'vision',
            cacheAfterVision && cacheAfterVision.source);

        // label='plugin' 必须真实落 telemetry 的 source（doctor 靠它排除插件/本地样本）
        // + llm.usage 带 turn_id（一轮 ~4.7 次请求要能 join）
        const TC = require(path.join(LIVE, 'js', 'core', 'turn-context.js'));
        const turnId = TC.beginTurn('probe');
        const pluginLabeled = LLMClient.fromProviderConfig(
            { api_key: 'k', api_url: 'http://127.0.0.1:1/v1', model: 'm4' }, {}, 'plugin');
        await pluginLabeled.chatCompletion([{ role: 'user', content: '插件摘要' }], null);
        TC.endTurn('ok');
        const rowsNow = readRows();
        const pluginUsage = rowsNow.filter((l) => l.type === 'llm.usage').pop();
        const pluginCache = rowsNow.filter((l) => l.type === 'llm.cache').pop();
        ok('llm.usage：source 落实际 label（plugin）',
            pluginUsage && pluginUsage.source === 'plugin', pluginUsage && pluginUsage.source);
        ok('llm.cache：source 落实际 label（plugin）',
            pluginCache && pluginCache.source === 'plugin', pluginCache && pluginCache.source);
        ok('llm.usage：带 turn_id（可按轮 join）',
            pluginUsage && pluginUsage.turn_id === turnId,
            (pluginUsage && pluginUsage.turn_id) + ' vs ' + turnId);

        // 上游没有 usage → 仍要暴露 lastUsage（字段 null），但不能编 cached
        global.fetch = async () => ({
            ok: true, status: 200,
            json: async () => ({ choices: [{ message: { role: 'assistant', content: '无 usage' } }] }),
        });
        await c.chatCompletion([{ role: 'user', content: 'x' }], null);
        ok('上游无 usage → lastUsage 存在、cached 为 null', c.lastUsage
            && c.lastUsage.prompt_tokens === null && c.lastUsage.cached_tokens === null);

        // 基线联动：紧接着用压缩口径测一次，能认出前缀
        const rb = CB.measureWithBaseline({ messages: [{ role: 'user', content: 'x' }] });
        ok('measureWithBaseline 能读到 llm-client 刚写的 lastUsage（有 msgHashes）',
            !!CB.getLastUsage() && Array.isArray(CB.getLastUsage().msgHashes));
    } finally {
        global.fetch = realFetch;
    }
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败不判红 */ }
process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
