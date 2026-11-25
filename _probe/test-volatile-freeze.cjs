#!/usr/bin/env node
/**
 * _probe/test-volatile-freeze.cjs — 轮内前缀冻结回归（ADR-014 漏一，2026-11-24 第三轮）
 *
 * 防的是「工具循环又回到每请求重拼前缀」：
 *   同一轮里第 N 次请求，除了新追加的 assistant/tool 消息，**前面的字节必须和第 1 次
 *   逐字节一致**。否则上游前缀缓存从那一字节处断裂 —— 实测单轮 18 次请求
 *   cached 冻在 9,984、命中 93.7% → 41%。
 *
 * 覆盖：
 *   ① 冻结后同一轮 3 次「请求」字节级一致（模拟 deep-copy + compose）
 *   ② 追加工具消息后，前面 system+user 前缀字节不变
 *   ③ 轮结束清空、下一轮重新生成
 *   ④ 多模态 content 数组追加 text part（不改字符串、不动图片）
 *   ⑤ addVolatile 增量追加时旧字节不变（纯追加 + 幂等）
 *   ⑥ 失败路径：宿主变短 / 前缀被改写（sig 校验）
 *   ⑦ 源码级护栏：llm-handler 真的用上冻结，且在 finally 清空
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 探针数据一律落临时目录，绝不写用户真实数据（与其它 probe 同口径）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'volatile-freeze-'));
process.env.PET_DATA_ROOT = path.join(TMP, 'data');
process.env.PET_TELEMETRY_DIR = path.join(TMP, 'telemetry');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const PL = require(path.join(LIVE, 'js', 'core', 'prompt-layout.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const clone = (x) => JSON.parse(JSON.stringify(x));

/** 模拟 llm-handler 第 1 次请求：深拷贝宿主 → 拼易变尾巴 → 冻结（含宿主前缀指纹） */
function firstRequest(host, volatileTexts) {
    const messagesForAPI = clone(host);
    messagesForAPI.forEach((m) => { delete m.attachments; });
    const vres = PL.appendVolatile(messagesForAPI, volatileTexts);
    const frozen = PL.freezeTurnPrefix(messagesForAPI, host, {
        volatileCount: vres.count,
        volatileChars: vres.chars,
    });
    return { messagesForAPI, vres, frozen };
}

/** 模拟 llm-handler 第 N 次请求（iteration > 0）：只用冻结前缀 + 宿主新增消息 */
function laterRequest(frozen, host) {
    return PL.composeTurnPrefix(frozen, host);
}

// ── ① 同一轮 3 次请求：前缀字节级一致 ──────────────────────────────────────
{
    const host = [
        { role: 'system', content: '人设+规则（稳定）' },
        { role: 'user', content: '上一轮问题' },
        { role: 'assistant', content: '上一轮回答' },
        { role: 'user', content: '帮我看下这个文件', attachments: [{ type: 'image', path: 'x.png' }] },
    ];
    const vol = ['[世界] 他在写代码', '（你现在的状态：犯困；3 分钟前）', '（系统补充：mood 指令）'];
    const first = firstRequest(host, vol);
    ok('第 1 次：易变块拼到最后一条 user', /他在写代码/.test(String(first.messagesForAPI[3].content)));
    ok('第 1 次：冻结成功', !!first.frozen && first.frozen.messages.length === 4
        && first.frozen.hostLength === 4, first.frozen && ('msgs=' + first.frozen.messages.length));
    ok('第 1 次：附件不进请求体', host[3].attachments !== undefined
        && first.messagesForAPI[3].attachments === undefined);

    const prefix0 = JSON.stringify(first.frozen.messages);

    // 第 2 次：模型调工具 → 宿主追加 assistant(tool_calls) + tool
    host.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"p":"a"}' } }],
    });
    host.push({ role: 'tool', name: 'read_file', content: '文件内容…', tool_call_id: 'c1' });
    const second = laterRequest(first.frozen, host);
    ok('第 2 次：compose 成功', second.ok === true, second.ok ? '' : second.reason);
    ok('第 2 次：前缀与第 1 次逐字节一致', JSON.stringify(second.messages.slice(0, 4)) === prefix0,
        'len=' + JSON.stringify(second.messages.slice(0, 4)).length + ' vs ' + prefix0.length);
    ok('第 2 次：新增消息条数 = 2', second.tailMsgs === 2 && second.messages.length === 6,
        'tail=' + second.tailMsgs + ' total=' + second.messages.length);
    ok('第 2 次：宿主/快照判据都通过', second.hostOk === true && second.snapOk === true);

    // 第 3 次：再调一次工具
    host.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"p":"b"}' } }] });
    host.push({ role: 'tool', name: 'read_file', content: '第二个文件…', tool_call_id: 'c2' });
    const third = laterRequest(first.frozen, host);
    ok('第 3 次：前缀与第 1 次仍逐字节一致', JSON.stringify(third.messages.slice(0, 4)) === prefix0);
    ok('第 3 次：上一条 tool 消息原样带过来（也是缓存段）',
        third.messages[5].content === '文件内容…' && third.messages[7].content === '第二个文件…');
    ok('第 3 次：宿主/快照判据仍通过', third.hostOk === true && third.snapOk === true);

    // 三次请求之间「增量」只有新消息：第 2 次是第 3 次的前缀
    ok('第 3 次请求命中第 2 次请求的完整前缀',
        JSON.stringify(third.messages.slice(0, second.messages.length)) === JSON.stringify(second.messages));

    // 宿主必须没被污染（冻结不改宿主；append 只发生在副本上）
    ok('宿主消息未被注入易变块', !/他在写代码/.test(String(host[3].content)));
    ok('宿主 attachments 仍在（只删副本）', Array.isArray(host[3].attachments) && host[3].attachments.length === 1);
}

// ── ② compose 每次返回独立深拷贝（调用方乱改不污染快照）─────────────────
{
    const host = [{ role: 'system', content: 'S' }, { role: 'user', content: '问' }];
    const { frozen } = firstRequest(host, ['易变A']);
    const a = laterRequest(frozen, host);
    a.messages[1].content = '被调用方改了';
    a.messages[0].content = 'system 被改了';
    const b = laterRequest(frozen, host);
    ok('compose 返回独立深拷贝（改一次不影响下一次）',
        /易变A/.test(String(b.messages[1].content)) && b.messages[0].content === 'S');
    ok('快照本身也没被改', /易变A/.test(String(frozen.messages[1].content)) && frozen.messages[0].content === 'S');
}

// ── ③ 轮结束清空、下一轮重新生成 ─────────────────────────────────────────
{
    const host = [{ role: 'system', content: 'S' }, { role: 'user', content: '第一轮问' }];
    const t1 = firstRequest(host, ['世界：白天']);
    ok('第一轮冻结成功', !!t1.frozen);

    // 轮结束：handler 在 finally 里 turnFreeze = null
    let turnFreeze = t1.frozen;
    turnFreeze = null;
    ok('轮结束清空后不能复用', PL.composeTurnPrefix(turnFreeze, host).ok === false
        && PL.composeTurnPrefix(turnFreeze, host).reason === 'no-freeze');

    // 下一轮：新 user 消息 + 新的世界行 → 重新冻结（跨轮允许变，这是「轮起点」语义）
    host.push({ role: 'assistant', content: '第一轮答' });
    host.push({ role: 'user', content: '第二轮问' });
    const t2 = firstRequest(host, ['世界：晚上']);
    ok('下一轮重新生成（不同世界行 → 不同字节）',
        !!t2.frozen && t2.frozen.snapSig !== t1.frozen.snapSig
        && /世界：晚上/.test(String(t2.frozen.messages[3].content)));
    ok('下一轮的前缀是上一轮的超集结构（旧轮消息原样保留）',
        t2.frozen.messages[2].content === '第一轮答' && t2.frozen.messages[1].content === '第一轮问');
}

// ── ④ 多模态：数组时追加 text part，不改字符串、不动图片 ─────────────────
{
    const msgs = [{
        role: 'user',
        content: [
            { type: 'text', text: '看这张图' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
        ],
    }];
    const before0 = JSON.stringify(msgs[0].content[0]);
    const before1 = JSON.stringify(msgs[0].content[1]);
    const r = PL.appendVolatile(msgs, ['易变多模态']);
    ok('多模态：追加 text part（长度 2→3）', r.ok && msgs[0].content.length === 3, 'len=' + msgs[0].content.length);
    ok('多模态：新 part 是 text 且在最后', msgs[0].content[2].type === 'text'
        && /易变多模态/.test(msgs[0].content[2].text));
    ok('多模态：原有 text part 字节不变', JSON.stringify(msgs[0].content[0]) === before0);
    ok('多模态：图片 part 字节/位置不变', JSON.stringify(msgs[0].content[1]) === before1);
    ok('多模态：content 仍是数组（没被降级成字符串）', Array.isArray(msgs[0].content));

    // 多模态下幂等：同一块再拼一次不重复
    const r2 = PL.appendVolatile(msgs, ['易变多模态']);
    ok('多模态：重复拼接幂等（reason=already，长度不变）',
        r2.ok && r2.reason === 'already' && msgs[0].content.length === 3);
}

// ── ⑤ addVolatile 增量追加：旧字节不变（纯追加 + 幂等）────────────────────
{
    const msgs = [{ role: 'user', content: '问句' }];
    const r1 = PL.appendVolatile(msgs, ['第一段']);
    const after1 = String(msgs[0].content);
    const r2 = PL.appendVolatile(msgs, ['第一段', '第二段']);
    const after2 = String(msgs[0].content);
    ok('增量追加：新内容以旧内容为前缀（旧字节一个没改）', after2.startsWith(after1),
        'old=' + after1.length + ' new=' + after2.length);
    ok('增量追加：第二段确实进去了', /第二段/.test(after2) && r1.count === 1 && r2.count === 2);
    const r3 = PL.appendVolatile(msgs, ['第一段', '第二段']);
    ok('增量追加：同样的集合再拼一次不动字节', r3.reason === 'already'
        && String(msgs[0].content) === after2);
}

// ── ⑥ 失败路径：宿主变短 / 前缀被改写 ────────────────────────────────────
{
    const host = [{ role: 'system', content: 'S' }, { role: 'user', content: '问' }];
    const { frozen } = firstRequest(host, ['易变X']);

    const shortHost = [{ role: 'system', content: 'S' }];
    const rShrink = PL.composeTurnPrefix(frozen, shortHost);
    ok('宿主变短：拒绝复用（reason=host-shrank，不静默丢消息）',
        rShrink.ok === false && rShrink.reason === 'host-shrank', rShrink.reason);
    ok('空冻结/非数组：拒绝', PL.composeTurnPrefix(null, host).reason === 'no-freeze'
        && PL.composeTurnPrefix(frozen, null).reason === 'no-host');
    ok('空消息不冻结', PL.freezeTurnPrefix([], []) === null && PL.freezeTurnPrefix(null, []) === null);

    // 有人改写了「已经发出去过的字节」→ sig 必须报警（缓存断裂可观测）
    frozen.messages[1].content = '问' + '（被某条路径改写）';
    const rDirty = PL.composeTurnPrefix(frozen, host);
    ok('快照被改写：snapOk=false（宿主没变）', rDirty.ok === true && rDirty.snapOk === false && rDirty.hostOk === true);

    // 只追加消息（不改前缀）→ sig 仍通过
    const host2 = [{ role: 'system', content: 'S' }, { role: 'user', content: '问' }];
    const { frozen: f2 } = firstRequest(host2, ['易变Y']);
    host2.push({ role: 'assistant', content: '答' });
    const rOk = PL.composeTurnPrefix(f2, host2);
    ok('只追加新消息：两条判据都通过', rOk.ok === true && rOk.hostOk === true && rOk.snapOk === true && rOk.tailMsgs === 1);
}

// ── ⑦ 宿主被工具回执限流改写 → 冻结作废 → 重冻后请求带省略版 ──────────────
// 这是 coordinator 点出的真 bug：compose 如果只比「快照 vs 快照自己的 hash」，永远为真
// （门禁自己骗自己），宿主里被 cap 改短的 tool 消息就会被旧字节静默绕过。
{
    const cap = require(path.join(LIVE, 'js', 'ai', 'tool-result-cap.js'));
    const BIG = 'X'.repeat(600);
    const host = [
        { role: 'system', content: 'S' },
        { role: 'user', content: '读一下这个大文件' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', name: 'read_file', content: BIG, tool_call_id: 'c1' },
    ];
    // 冻结点：宿主里已经有这条 tool 回执（模拟「回执先落盘、本次请求再冻结」的形态）
    const first = firstRequest(host, ['易变尾巴']);
    ok('冻结时宿主含本轮 tool 回执', first.frozen.hostLength === 4
        && first.frozen.messages[3].content === BIG);

    // 下一次请求前：限流闸把这条回执截短（原地改宿主，正是 tool-result-cap 的行为）
    const capRes = cap.enforceToolBudget(host, 1, { perResultChars: 120, perTurnChars: 32000 });
    ok('限流确实改写了宿主（单条截断）', capRes.capped === 1 && host[3].content !== BIG
        && host[3].content.length <= 120, 'capped=' + capRes.capped + ' len=' + String(host[3].content).length);

    // 旧冻结必须被识破：否则发出去的是 600 字原文，截断被静默绕过
    const stale = laterRequest(first.frozen, host);
    ok('冻结感知宿主被改写（host-rewritten，不是静默复用）',
        stale.ok === false && stale.reason === 'host-rewritten', stale.reason);
    ok('能指出被改写的是第几条（工具回执 #3）', stale.index === 3, 'index=' + stale.index);

    // 调用方的处置：丢弃冻结 → 按宿主重建 → 重新冻结（承认这一次有意断缓存）
    const rebuilt = firstRequest(host, ['易变尾巴']);
    ok('重冻后请求用的是「改短后的内容」', rebuilt.messagesForAPI[3].content === host[3].content
        && rebuilt.messagesForAPI[3].content.length < 600,
        'len=' + String(rebuilt.messagesForAPI[3].content).length);
    ok('重冻后请求不再包含 600 字原文', !String(rebuilt.messagesForAPI[3].content).includes(BIG));

    // 再下一次请求：命中重冻后的前缀（这里不再有新的宿主改写）
    host.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"p":2}' } }] });
    host.push({ role: 'tool', name: 'read_file', content: '第二个结果', tool_call_id: 'c2' });
    const after = laterRequest(rebuilt.frozen, host);
    ok('重冻后的下一次请求命中完整前缀（含截断版回执）',
        after.ok === true && after.hostOk === true && after.tailMsgs === 2
        && JSON.stringify(after.messages.slice(0, 4)) === JSON.stringify(rebuilt.messagesForAPI));
}

// ── ⑧ 归一化：宿主上的 attachments 增删不算「改写」──────────────────────
// 截图回合会在宿主 user 消息上挂 attachments（不进请求体），它变了不能误判成宿主被改写。
{
    const host = [{ role: 'system', content: 'S' }, { role: 'user', content: '看图' }];
    const { frozen } = firstRequest(host, ['易变']);
    host[1].attachments = [{ type: 'image', path: '对话截图/a.jpg' }];
    const r1 = laterRequest(frozen, host);
    ok('宿主加 attachments：不判改写', r1.ok === true && r1.hostOk === true);
    delete host[1].attachments;
    const r2 = laterRequest(frozen, host);
    ok('宿主删 attachments：不判改写', r2.ok === true && r2.hostOk === true);
    ok('宿主 attachments 也不进请求体', r2.messages[1].attachments === undefined);
}

// ── ⑨ 源码级护栏：llm-handler 真的接上了冻结 + 轮末清空 ─────────────────
{
    const src = fs.readFileSync(path.join(LIVE, 'js', 'ai', 'llm-handler.js'), 'utf8');
    ok('llm-handler 冻结前缀（连宿主一起传）',
        /promptLayout\.freezeTurnPrefix\(\s*messagesForAPI,\s*voiceChat\.messages/.test(src));
    ok('llm-handler 复用时走 composeTurnPrefix', /promptLayout\.composeTurnPrefix\(\s*turnFreeze/.test(src));
    ok('llm-handler 冻结后不再跑钩子', /if \(!turnFreeze\) \{\s*\n\s*const volatileTexts = \[\]/.test(src));
    const clearCount = (src.match(/turnFreeze = null;/g) || []).length;
    ok('llm-handler 至少有 3 处清空/失效回退（冻结失效、轮末各一处）', clearCount >= 3, 'count=' + clearCount);
    ok('轮末 finally 里清空（含 voiceChat._turnFreeze 观测字段）',
        /finally \{[\s\S]{0,4000}turnFreeze = null;[\s\S]{0,200}delete voiceChat\._turnFreeze/.test(src));
    ok('冻结复用时不再剥历史图片（改字节会断缓存）', !/if \(!frozenReuse && \(!screenshotBase64 \|\| iteration > 0\)\)/.test(src));
    // P1-1（2026-11-24 对抗审查）：剥历史图必须在冻结点**之前**，且只跑一次。
    // 旧位置在 vision/main 分支里（冻结之后）→ 快照带图、实际请求剥图 → req2 图片复活 + 前缀分叉。
    ok('历史图片清理在冻结点之前调用（快照 == 首次请求真实字节）',
        /stripHistoryImagesForRequest\(messagesForAPI, screenshotBase64, iteration\)/.test(src)
        && src.indexOf('stripHistoryImagesForRequest(messagesForAPI') < src.indexOf('promptLayout.freezeTurnPrefix('));
    ok('剥图只在「重建请求体」块里跑一次（不在 vision/main 分支里）',
        (src.match(/stripHistoryImagesForRequest\(messagesForAPI/g) || []).length === 1);
    // 宿主被改写必须走「重冻」而不是只打日志
    ok('host-rewritten 触发重建重冻', /reason === 'host-rewritten'[\s\S]{0,2500}turnFreeze = null;/.test(src));
    ok('断裂计数进 stats（rewrite）', /freezeStats\.rewrite \+= 1;/.test(src));
    ok('轮末落 telemetry llm.freeze（reuse/rebuild/rewrite/requests）',
        /type: 'llm\.freeze'[\s\S]{0,500}reuse: freezeStats\.reuse[\s\S]{0,200}rebuild: freezeStats\.rebuild[\s\S]{0,200}rewrite: freezeStats\.rewrite/.test(src));
    ok('stats 挂到 voiceChat._turnFreeze（排障/验收可读）', /_turnFreeze = \{[\s\S]{0,400}stats: freezeStats/.test(src));
    // 截图分析不再裸发宿主数组（另起一份前缀 = 本轮多一次全 miss）
    ok('截图分析走冻结通道', /_shotReuse = promptLayout\.composeTurnPrefix\(turnFreeze, voiceChat\.messages\)[\s\S]{0,2500}chatCompletion\(shotMessages/.test(src));
    ok('截图分支不再裸发 voiceChat.messages', !/chatCompletion\(voiceChat\.messages, allTools\)/.test(src));
    // 旧截图剥离挪到轮末（轮内改宿主就是改冻结前缀）
    ok('旧截图剥离定义成轮末清理', /function stripOldScreenshotImages\(messages\)/.test(src));
    ok('轮内不再有「清除历史消息中的旧截图」', !/清除历史消息中的旧截图/.test(src));
    // 旧压缩器调用已删（另一代理在删 ContextCompressor）
    ok('不再调用 contextCompressor.checkAndRollAsync', !/checkAndRollAsync/.test(src));
}

// ── ⑩ telemetry 契约：llm.freeze 真能落盘、三个数可聚合 ──────────────────
// 「缓存断裂可观测」是这一轮的核心交付：只打日志不算，必须能被 doctor/验收查出来。
{
    const T = require(path.join(LIVE, 'js', 'core', 'telemetry.js'));
    T.emitTelemetry({
        cat: 'llm', type: 'llm.freeze', title: '前缀冻结复用', level: 'info', pipeline_stage: 'llm',
        metrics: { reuse: 5, rebuild: 1, rewrite: 1, requests: 7, prefix_msgs: 12, prefix_chars: 18000 },
        turn_id: 't-freeze-1',
    });
    const file = path.join(process.env.PET_TELEMETRY_DIR, 'telemetry.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = lines[lines.length - 1];
    ok('telemetry 落盘 llm.freeze', !!last && last.type === 'llm.freeze' && last.cat === 'llm',
        last && (last.cat + '/' + last.type));
    ok('reuse/rebuild/rewrite 都是数字（可聚合）',
        ['reuse', 'rebuild', 'rewrite'].every((k) => typeof last.metrics[k] === 'number'),
        JSON.stringify(last.metrics));
    ok('metric 名与 handler 一致（不会写成别的键）',
        last.metrics.reuse === 5 && last.metrics.rebuild === 1 && last.metrics.rewrite === 1
        && last.metrics.requests === 7);
    ok('轮次可 join（turn_id）', last.turn_id === 't-freeze-1');
}

// ── ⑪ 轮末旧截图清理（调真函数，不是源码字符串比对）────────────────────
// 截图分支原来在轮内剥宿主旧图 = 轮内改写冻结前缀。现在挪到轮末，这里锁住它的语义：
// 只剥**历史**图片、永远保留最新一张（模型这轮看的就是它）、非 user 消息一根手指都不碰。
{
    let LH = null;
    try { LH = require(path.join(LIVE, 'js', 'ai', 'llm-handler.js')); } catch (e) { LH = null; }
    ok('llm-handler 可被单测加载（无 electron 硬依赖）',
        !!LH && typeof LH.stripOldScreenshotImages === 'function');
    if (LH && typeof LH.stripOldScreenshotImages === 'function') {
        const img = (t) => ({ role: 'user', content: [{ type: 'text', text: t }, { type: 'image_url', image_url: { url: 'data:' + t } }] });
        const msgs = [
            { role: 'system', content: 'S' },
            img('旧1'),
            { role: 'assistant', content: '嗯' },
            img('旧2'),
            img('最新'),
        ];
        const n = LH.stripOldScreenshotImages(msgs);
        ok('轮末清理只剥旧图（2 条）', n === 2, 'stripped=' + n);
        ok('最新一张图原样保留', Array.isArray(msgs[4].content)
            && msgs[4].content.some((p) => p.type === 'image_url'));
        ok('旧图剥成文字（原话保留，不丢用户说的话）', msgs[1].content === '旧1' && msgs[3].content === '旧2');
        ok('非 user / 无图消息不动', msgs[2].content === '嗯'
            && LH.stripOldScreenshotImages([{ role: 'user', content: '纯文本' }]) === 0);
    }
}

// ── ⑫ P1-1：无新截图的轮次 —— 剥历史图在冻结之前，快照 == 首次请求真实字节 ─────
// 防「快照带图、请求剥图 → req2 图片复活 + 前缀分叉，llm.freeze 仍报 reuse 成功」。
// 按真实调用序模拟：克隆宿主 → （附加新截图）→ stripHistoryImagesForRequest →
// appendVolatile → freezeTurnPrefix；req2+ 用 composeTurnPrefix。
{
    const LH = require(path.join(LIVE, 'js', 'ai', 'llm-handler.js'));
    const imgUser = (text, url) => ({
        role: 'user',
        content: [{ type: 'text', text }, { type: 'image_url', image_url: { url } }],
    });

    // 按 llm-handler 真实顺序构造「第 1 次请求 + 冻结」
    const buildFirst = (host, shot, iteration) => {
        const m = clone(host);
        m.forEach((x) => { delete x.attachments; });
        if (shot && iteration === 0) {
            // 新截图附加到最后一条 user（宿主不动）
            let idx = -1;
            for (let i = m.length - 1; i >= 0; i -= 1) { if (m[i].role === 'user') { idx = i; break; } }
            m[idx] = { role: 'user', content: [{ type: 'text', text: String(m[idx].content) },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + shot } }] };
        }
        const stripped = LH.stripHistoryImagesForRequest(m, shot, iteration);
        PL.appendVolatile(m, ['世界行：他在写代码']);
        const frozen = PL.freezeTurnPrefix(m, host, {});
        return { request: m, frozen, stripped };
    };

    // ── 场景 A：宿主含历史图 + 本轮无新截图 ──────────────────────────────
    {
        const host = [
            { role: 'system', content: 'S' },
            imgUser('看这张旧图', 'data:image/jpeg;base64,OLD'),
            { role: 'assistant', content: '看到了' },
            { role: 'user', content: '接着聊' },
        ];
        const { request, frozen, stripped } = buildFirst(host, null, 0);
        ok('无新截图：历史图确实被剥（1 条）', stripped === 1, 'stripped=' + stripped);
        ok('无新截图：剥成文字且原话保留', typeof request[1].content === 'string' && request[1].content === '看这张旧图');
        ok('无新截图：请求体里不再有 image_url', !/image_url/.test(JSON.stringify(request)));
        ok('P1-1 核心断言：冻结快照 == 首次请求 JSON.stringify 完全相等',
            JSON.stringify(frozen.messages) === JSON.stringify(request),
            'snap=' + JSON.stringify(frozen.messages).length + ' req=' + JSON.stringify(request).length);

        // req2：宿主追加 assistant(tool_calls) + tool
        host.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
        host.push({ role: 'tool', content: '文件内容…', tool_call_id: 'c1' });
        const second = PL.composeTurnPrefix(frozen, host);
        ok('无新截图：req2 compose 成功（宿主只追加，判据全过）',
            second.ok === true && second.hostOk === true && second.snapOk === true,
            second.ok ? '' : second.reason);
        ok('P1-1 核心断言：req2 前缀与首次请求完全相等（含图片字段逐字节）',
            second.ok && JSON.stringify(second.messages.slice(0, request.length)) === JSON.stringify(request));
        ok('无新截图：req2 里图片没有复活', !/image_url/.test(JSON.stringify(second.messages.slice(0, request.length))));

        // req3：再追加一轮工具，仍是同一前缀
        host.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"p":2}' } }] });
        host.push({ role: 'tool', content: '第二个结果', tool_call_id: 'c2' });
        const third = PL.composeTurnPrefix(frozen, host);
        ok('无新截图：req3 前缀仍与首次请求完全相等',
            third.ok && JSON.stringify(third.messages.slice(0, request.length)) === JSON.stringify(request));
    }

    // ── 场景 B：有新截图的轮次（不剥图，快照同样 == 首次请求）─────────────
    {
        const host = [
            { role: 'system', content: 'S' },
            imgUser('看这张旧图', 'data:image/jpeg;base64,OLD'),
            { role: 'assistant', content: '看到了' },
            { role: 'user', content: '再看看现在的屏幕' },
        ];
        const { request, frozen, stripped } = buildFirst(host, 'NEWB64', 0);
        ok('有新截图：不剥任何历史图（新截图要留给模型）', stripped === 0, 'stripped=' + stripped);
        ok('有新截图：历史旧图保留', Array.isArray(request[1].content)
            && request[1].content.some((p) => p.type === 'image_url'));
        ok('有新截图：新图附加到最后一条 user', Array.isArray(request[3].content)
            && request[3].content.some((p) => p.type === 'image_url' && /NEWB64/.test(p.image_url.url)));
        ok('P1-1 核心断言（有新截图）：冻结快照 == 首次请求 JSON.stringify 完全相等',
            JSON.stringify(frozen.messages) === JSON.stringify(request));

        host.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'see', arguments: '{}' } }] });
        host.push({ role: 'tool', content: '截图工具回执', tool_call_id: 'c1' });
        const second = PL.composeTurnPrefix(frozen, host);
        ok('有新截图：req2 前缀与首次请求完全相等（含两张图逐字节）',
            second.ok && JSON.stringify(second.messages.slice(0, request.length)) === JSON.stringify(request));
        ok('有新截图：req2 图片没有丢失/复活（数量不变）',
            (JSON.stringify(second.messages.slice(0, request.length)).match(/image_url/g) || []).length
            === (JSON.stringify(request).match(/image_url/g) || []).length);
    }

    // ── 场景 C：工具轮（iteration>0）重建请求体时仍按原语义剥图 ────────────
    {
        const msgs = [
            { role: 'system', content: 'S' },
            imgUser('旧图', 'data:image/jpeg;base64,OLD'),
        ];
        const n = LH.stripHistoryImagesForRequest(msgs, 'NEWB64', 1);
        ok('iteration>0（重冻）：即使有本轮截图也剥历史图（原条件不变）', n === 1, 'stripped=' + n);
        ok('空数组/非数组安全', LH.stripHistoryImagesForRequest([], null, 0) === 0
            && LH.stripHistoryImagesForRequest(null, null, 0) === 0);
    }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
