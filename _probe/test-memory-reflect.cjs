#!/usr/bin/env node
/**
 * _probe/test-memory-reflect.cjs — 记忆 v2「反思落盘」单测（2026-11-20）
 *
 * 覆盖 docs/调研-记忆v2-2026-11-20.md §2.1/§2.2 与 docs/框架设计-四块落地-2026-11-20.md §5：
 *   ① 打分边界：idle/寒暄=1、强情绪/承诺/身份显著更高、恒在 1..10
 *   ② 触发器：累减、<=0 触发并重置、非法分数不穿透
 *   ③ reflect 纯逻辑：evidence_ids 映射、<2 条整条丢弃、depth=1+max、超长截断、LLM/解析失败
 *   ④ 落盘：insights.jsonl append + insights-cursor.json；游标幂等（同输入不重复写）
 *   ⑤ 策略：LLM 失败不写盘且游标不动、日上限 4、gaming 不触发、空结果推进游标
 *
 * 全部离线：临时目录 + mock LLM，不碰真实 data、不发一次网络请求。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const iso = require('./lib/test-isolation.cjs');

const ROOT = path.join(__dirname, '..');
// 数据隔离必须发生在任何业务模块 require 之前：records-path 在 require 时就把
// RECORDS_DIR 定下来了。设了 PET_DATA_ROOT，memory-evolve 的 onInit（记忆整理目录、
// 待写队列）和 llm-health 的默认状态文件都落在临时目录，不写真实 data。
const TMP_ROOT = iso.setUpTempDataRoot('dafeiyu-reflect-');

const PLUG = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'memory-evolve');
const IMP = require(path.join(PLUG, 'lib', 'importance.js'));
const REF = require(path.join(PLUG, 'lib', 'reflect.js'));
const STORE = require(path.join(PLUG, 'lib', 'insights-store.js'));
const P = require(path.join(PLUG, 'index.js'));
const { llmHealth } = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'llm-health.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

let seq = 0;
function newDir() {
    seq += 1;
    const d = path.join(TMP_ROOT, 'case' + seq);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

// ── 夹具：两张片段卡（每张 卡 + 2 条事实 = 3 个证据坐标）──
const EP1 = {
    at: 1763000000000,
    title: '熬夜改代码',
    summary: '他凌晨三点还在改代码，说眼睛快瞎了，答应第二天早点睡',
    facts: ['凌晨三点在改代码', '答应第二天早点睡'],
    turns: 8,
    span: { from: 0, lines: 12 },
};
const EP2 = {
    at: 1763010000000,
    title: '面试前紧张',
    summary: '他下周三要去面试，有点紧张，说这次准备很久了',
    facts: ['下周三要去面试', '这次准备很久了'],
    turns: 6,
    span: { from: 12, lines: 10 },
};

function writeEpisodes(dir, cards) {
    fs.writeFileSync(path.join(dir, 'episodes.jsonl'), cards.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
}
function readInsights(dir) {
    try {
        return fs.readFileSync(path.join(dir, 'insights.jsonl'), 'utf8')
            .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) { return []; }
}
function readCursor(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'insights-cursor.json'), 'utf8')); }
    catch (e) { return null; }
}
function writeCursor(dir, c) {
    fs.writeFileSync(path.join(dir, 'insights-cursor.json'), JSON.stringify(c, null, 2), 'utf8');
}

const OLD_IDLE = 60 * 60 * 1000;
function setIdle() { global.__lastUserInputAt = Date.now() - OLD_IDLE; }

async function mkPlugin(opts) {
    const o = opts || {};
    // 熔断状态是进程级单例：每个用例前指到临时路径并清空，避免上一个用例的失败
    // 把下一个用例的 LLM 调用挡在门外（也让断言能确定地看到本轮状态）。
    llmHealth.resetForTests({ path: path.join(o.dir || TMP_ROOT, 'LLM健康.json') });
    const logs = [];
    const calls = [];
    const p = new P();
    p.context = {
        getPluginFileConfig: () => Object.assign({
            enabled: true,
            reflect_enabled: true,
            reflect_dir: o.dir,
            episode_idle_min: 30,
            reflect_daily_cap: 4,
            reflect_max_entries: 30,
        }, o.cfg || {}),
        getPluginFileLog: () => {},
        log: (lv, m) => logs.push(String(lv) + ' ' + String(m)),
        getMessages: () => [],
        callLLM: async (prompt) => {
            calls.push(prompt);
            if (o.reply instanceof Error) throw o.reply;
            return typeof o.reply === 'function' ? o.reply(prompt) : o.reply;
        },
    };
    await p.onInit();
    return { p, logs, calls };
}

const GOOD = JSON.stringify({
    insights: [{
        text: '他最近作息很乱，连续熬夜还在准备面试',
        evidence: [1, 2],
        importance: 7,
        keywords: ['作息', '熬夜', '面试'],
    }],
});

(async () => {
    try {
        // ═══════════════════════════════════════════════════════════════
        // ① 打分边界
        // ═══════════════════════════════════════════════════════════════
        {
            const greet = IMP.scoreEvent('嗯', {});
            ok('寒暄 = 1 分', greet.score === 1 && greet.hits.includes('greeting'), JSON.stringify(greet));
            ok('meta.idle = 1 分', IMP.scoreEvent('我在忙', { idle: true }).score === 1);
            ok('空文本 = 1 分', IMP.scoreEvent('   ').score === 1);
            const emo = IMP.scoreEvent('我今天彻底崩溃了，哭了很久，特别难受，感觉要绝望了');
            ok('强情绪高分（>=7）', emo.score >= 7, JSON.stringify(emo));
            const promise = IMP.scoreEvent('我答应你周末一定给你听新曲子，我保证');
            ok('承诺加权（>=5 且命中 promise）', promise.score >= 5 && promise.hits.includes('promise'), JSON.stringify(promise));
            const idn = IMP.scoreEvent('我叫小林，我住在杭州，我在一家游戏公司上班');
            ok('身份加权（>=4 且命中 identity）', idn.score >= 4 && idn.hits.includes('identity'), JSON.stringify(idn));
            const samples = ['好', '嗯嗯', '我饿了', '今天加班到十点', '我养了一只猫叫团子', '我下周要搬家了', '他说要分手，我很难受'];
            ok('分数恒在 1..10', samples.every((s) => {
                const n = IMP.scoreEvent(s).score;
                return Number.isInteger(n) && n >= 1 && n <= 10;
            }), samples.map((s) => s + '=' + IMP.scoreEvent(s).score).join(' / '));
        }

        // ═══════════════════════════════════════════════════════════════
        // ② 触发器：累减 / 触发重置 / 非法分数
        // ═══════════════════════════════════════════════════════════════
        {
            ok('默认阈值 60（我们的校准值）', IMP.createTrigger().threshold === 60);
            const t = IMP.createTrigger({ threshold: 10 });
            const r1 = t.add(4);
            const r2 = t.add(4);
            const r3 = t.add(4);
            const resetRemain = t.remain;
            const r4 = t.add(2);
            ok('累减 remain 正确', !r1.fire && r1.remain === 6 && !r2.fire && r2.remain === 2,
                JSON.stringify([r1, r2]));
            ok('<=0 触发并重置为阈值', r3.fire === true && r3.remain === 10 && resetRemain === 10, JSON.stringify(r3));
            ok('触发后从阈值继续累减', !r4.fire && r4.remain === 8, JSON.stringify(r4));
            const before = t.remain;
            t.add(NaN);
            t.add(-5);
            ok('非法分数按 0（不会把触发器打穿）', t.remain === before, 'remain=' + t.remain);
        }

        // ═══════════════════════════════════════════════════════════════
        // ③ reflect 纯逻辑
        // ═══════════════════════════════════════════════════════════════
        {
            const entries = [
                { id: 'e1', text: '他凌晨三点还在改代码，说眼睛快瞎了', depth: 0, importance: 8 },
                { id: 'e2', text: '他答应第二天早点睡', depth: 0, importance: 6 },
            ];
            const rr = await REF.reflect({ entries, callLLM: async () => GOOD, now: () => 1763000000000 });
            ok('正常输出 → ok + 1 条', rr.ok === true && rr.insights.length === 1, JSON.stringify(rr.insights || rr.error));
            const ins = rr.insights[0];
            ok('evidence 编号映射成真实 id', JSON.stringify(ins.evidence_ids) === JSON.stringify(['e1', 'e2']), JSON.stringify(ins.evidence_ids));
            ok('depth = 1 + max(证据 depth)', ins.depth === 1, 'depth=' + ins.depth);
            ok('importance 保留且夹在 1..10', ins.importance === 7);
            ok('schema 字段齐全', /^ins_/.test(ins.id) && ins.created_at === 1763000000000 &&
                ins.status === 'active' && ins.prompt_version === 'reflect-v1');

            // 结论的结论：引用已有 insight（depth=2）→ 新 insight depth=3
            const chain = await REF.reflect({
                entries,
                existingInsights: [{ id: 'ins_old', text: '他长期睡眠不足', depth: 2, importance: 5 }],
                callLLM: async () => JSON.stringify({ insights: [{ text: '他的作息问题在影响面试状态', evidence: ['ins_old', 1], importance: 6 }] }),
            });
            ok('引用已有 insight 时 depth=1+2=3', chain.ok && chain.insights[0].depth === 3,
                chain.ok ? 'depth=' + chain.insights[0].depth : chain.error);

            // 证据不足 2 条 → 整条丢弃
            const bad = await REF.reflect({
                entries,
                callLLM: async () => JSON.stringify({ insights: [{ text: '只有一条证据', evidence: [1] }] }),
            });
            ok('evidence <2 整条丢弃', bad.ok === true && bad.insights.length === 0 && bad.dropped === 1,
                'insights=' + bad.insights.length + ' dropped=' + bad.dropped);

            // 越界编号不能凑数
            const ghost = await REF.reflect({
                entries,
                callLLM: async () => JSON.stringify({ insights: [{ text: '编号越界', evidence: [1, 99] }] }),
            });
            ok('越界证据不算数（<2 丢弃）', ghost.ok === true && ghost.insights.length === 0);

            // 重复编号去重后只剩 1 条 → 丢弃
            const dup = await REF.reflect({
                entries,
                callLLM: async () => JSON.stringify({ insights: [{ text: '重复编号', evidence: [1, '1', 1] }] }),
            });
            ok('重复证据去重后不足 2 条 → 丢弃', dup.ok === true && dup.insights.length === 0);

            // 超长截断
            const long = await REF.reflect({
                entries,
                callLLM: async () => JSON.stringify({ insights: [{ text: '长'.repeat(300), evidence: [1, 2] }] }),
                maxTextChars: 200,
            });
            ok('text 超长截断到 200', long.ok && long.insights[0].text.length === 200,
                'len=' + (long.insights && long.insights[0] ? long.insights[0].text.length : '?'));

            // LLM 失败 / 解析失败 → ok:false，绝不伪装成功
            const f1 = await REF.reflect({ entries, callLLM: async () => { throw new Error('boom'); } });
            ok('LLM 抛错 → ok:false', f1.ok === false && /LLM/.test(f1.error), f1.error);
            const f2 = await REF.reflect({ entries, callLLM: async () => '我觉得挺好的但没按格式' });
            ok('输出不可解析 → ok:false', f2.ok === false && /解析/.test(f2.error), f2.error);
            const f3 = await REF.reflect({ entries, callLLM: async () => '{"insights":{}}' });
            ok('insights 不是数组 → ok:false', f3.ok === false);

            // 无新增条目：不调 LLM，直接 ok 空
            const empty = await REF.reflect({ entries: [], callLLM: async () => { throw new Error('不该调用'); } });
            ok('无新增条目不调 LLM', empty.ok === true && empty.insights.length === 0);
        }

        // ═══════════════════════════════════════════════════════════════
        // ④ buildEntries：不切半张卡 / 游标后只读新增
        // ═══════════════════════════════════════════════════════════════
        {
            const dir = newDir();
            writeEpisodes(dir, [EP1, EP2]);
            const cards = STORE.readEpisodesWithLines(dir);
            const b1 = STORE.buildEntries(cards, 0, 3);
            ok('条目上限不切半张卡（第一张卡 3 条）', b1.entries.length === 3 && b1.lastLine === 1,
                'entries=' + b1.entries.length + ' lastLine=' + b1.lastLine);
            const b2 = STORE.buildEntries(cards, 1, 30);
            ok('游标后只读新增片段', b2.entries.length === 3 && b2.lastLine === 2 && b2.lastId === STORE.episodeId(2, EP2),
                'entries=' + b2.entries.length + ' lastLine=' + b2.lastLine);
            ok('证据坐标含片段行号与事实序号', b2.entries[0].id === STORE.episodeId(2, EP2) &&
                b2.entries[1].id === STORE.episodeId(2, EP2) + '#f1');
        }

        // ═══════════════════════════════════════════════════════════════
        // ⑤ 插件端到端（mock LLM）：写盘 / 游标 / 幂等
        // ═══════════════════════════════════════════════════════════════
        {
            const dir = newDir();
            writeEpisodes(dir, [EP1, EP2]);
            const { p, logs, calls } = await mkPlugin({ dir, reply: GOOD });
            setIdle();
            p._reflectPending = true;
            const r = await p._maybeReflect();
            const written = readInsights(dir);
            const cur = readCursor(dir);
            ok('端到端：写 1 条 insight 到 insights.jsonl', r.ok === true && r.insights.length === 1 && written.length === 1,
                JSON.stringify(written[0] && { text: written[0].text, evidence: written[0].evidence_ids }));
            ok('端到端：游标推进到第 2 行', cur && cur.lastEpisodeLine === 2 && cur.lastEpisodeId === STORE.episodeId(2, EP2),
                JSON.stringify(cur));
            ok('端到端：runsToday=1 且状态回写', cur.runsToday === 1 && p._reflectState.runsToday === 1);
            ok('端到端：pending 清掉', p._reflectPending === false);
            ok('端到端：日志留痕', logs.some((l) => /\[反思\].*完成/.test(l)), logs.filter((l) => /反思/.test(l)).slice(-1)[0]);

            // 同输入再跑：没有新片段 → 不调 LLM、不重复写、游标不动
            p._reflectPending = true;
            const r2 = await p._maybeReflect();
            ok('cursor 幂等（同输入不重复写）',
                r2 === null && readInsights(dir).length === 1 && calls.length === 1 && readCursor(dir).lastEpisodeLine === 2,
                'calls=' + calls.length + ' insights=' + readInsights(dir).length);
        }

        // ═══════════════════════════════════════════════════════════════
        // ⑥ LLM 失败 / 解析失败：不写盘、游标不动、lastError 发声
        // ═══════════════════════════════════════════════════════════════
        {
            const dir = newDir();
            writeEpisodes(dir, [EP1]);
            const { p, logs } = await mkPlugin({ dir, reply: new Error('mock boom') });
            setIdle();
            p._reflectPending = true;
            const r = await p._maybeReflect();
            const cur = readCursor(dir);
            ok('LLM 失败：不写 insight', r.ok === false && readInsights(dir).length === 0);
            ok('LLM 失败：游标不前进（下次重试）', cur && cur.lastEpisodeLine === 0, JSON.stringify(cur));
            ok('LLM 失败：lastError 落盘且可见', typeof (cur && cur.lastError) === 'string' && /LLM/.test(cur.lastError), cur && cur.lastError);
            ok('LLM 失败：warn 日志发声', logs.some((l) => /^warn/.test(l) && /反思/.test(l)));
            ok('LLM 失败：仍占一次日配额（成本诚实）', cur.runsToday === 1, 'runsToday=' + cur.runsToday);
        }
        {
            const dir = newDir();
            writeEpisodes(dir, [EP1]);
            const { p } = await mkPlugin({ dir, reply: '不是 JSON' });
            setIdle();
            p._reflectPending = true;
            const r = await p._maybeReflect();
            const cur = readCursor(dir);
            ok('解析失败：不写盘且游标不动', r.ok === false && readInsights(dir).length === 0 && cur.lastEpisodeLine === 0);
            ok('解析失败：lastError 写明解析', /解析/.test(cur.lastError || ''), cur.lastError);
        }

        // ═══════════════════════════════════════════════════════════════
        // ⑦ 日上限 4 + 跨天重置
        // ═══════════════════════════════════════════════════════════════
        {
            const dir = newDir();
            writeEpisodes(dir, [EP1]);
            const { p, calls } = await mkPlugin({ dir, reply: GOOD });
            setIdle();
            p._reflectPending = true;
            writeCursor(dir, {
                lastEpisodeLine: 0, lastEpisodeId: null, lastRunAt: 0,
                runsToday: 4, day: STORE.todayStr(Date.now()), lastError: null,
            });
            const r = await p._maybeReflect();
            ok('日上限 4：第 5 次不调 LLM、不写盘', r && r.skipped === 'daily_cap' && calls.length === 0 && readInsights(dir).length === 0,
                JSON.stringify(r));
            writeCursor(dir, {
                lastEpisodeLine: 0, lastEpisodeId: null, lastRunAt: 0,
                runsToday: 4, day: '2000-01-01', lastError: null,
            });
            const r2 = await p._maybeReflect();
            const cur = readCursor(dir);
            ok('跨天重置 runsToday 并可再跑', r2 && r2.ok === true && cur.runsToday === 1 && calls.length === 1,
                'runsToday=' + (cur && cur.runsToday) + ' calls=' + calls.length);
        }

        // ═══════════════════════════════════════════════════════════════
        // ⑧ 证据不足 / 明确空结果：仍推进游标（否则同一批永久重试）
        // ═══════════════════════════════════════════════════════════════
        {
            const dir = newDir();
            writeEpisodes(dir, [EP1, EP2]);
            const { p } = await mkPlugin({
                dir,
                reply: JSON.stringify({ insights: [{ text: '只有一条证据', evidence: [1] }] }),
            });
            setIdle();
            p._reflectPending = true;
            const r = await p._maybeReflect();
            const cur = readCursor(dir);
            ok('全部证据不足 → 不写 insight', r.ok === true && r.insights.length === 0 && readInsights(dir).length === 0);
            ok('证据不足也推进游标', cur.lastEpisodeLine === 2 && p._reflectPending === false, JSON.stringify(cur));
        }
        {
            const dir = newDir();
            writeEpisodes(dir, [EP1]);
            const { p } = await mkPlugin({ dir, reply: '{"insights":[]}' });
            setIdle();
            p._reflectPending = true;
            const r = await p._maybeReflect();
            const cur = readCursor(dir);
            ok('LLM 明确返回空 → 推进游标（不永久卡住）',
                r.ok === true && r.insights.length === 0 && cur.lastEpisodeLine === 1);
        }

        // 单条新观察 + 已有结论 → 允许组成 depth=2 的链（不被 entries<2 误杀）
        {
            const dir = newDir();
            writeEpisodes(dir, [{ at: 1763020000000, title: '安静的一天', summary: '他今天很安静，几乎没说话', facts: [], turns: 3 }]);
            fs.writeFileSync(path.join(dir, 'insights.jsonl'), JSON.stringify({
                id: 'ins_old1', created_at: 1762000000000, text: '他最近情绪偏低',
                evidence_ids: ['ep:0:0', 'ep:0:0#f1'], depth: 1, importance: 6, status: 'active',
            }) + '\n', 'utf8');
            const { p } = await mkPlugin({
                dir,
                reply: JSON.stringify({ insights: [{ text: '他的低落还在持续', evidence: ['ins_old1', 1], importance: 6 }] }),
            });
            setIdle();
            p._reflectPending = true;
            const r = await p._maybeReflect();
            ok('单条新观察 + 已有结论可成链（depth=2）',
                r.ok === true && r.insights.length === 1 && r.insights[0].depth === 2 &&
                r.insights[0].evidence_ids.includes('ins_old1'),
                r.ok ? JSON.stringify({ depth: r.insights[0].depth, ev: r.insights[0].evidence_ids }) : r.error);
        }

        // ═══════════════════════════════════════════════════════════════
        // ⑨ 世界在 gaming/watching 时不触发
        // ═══════════════════════════════════════════════════════════════
        {
            const dir = newDir();
            writeEpisodes(dir, [EP1]);
            const { p, calls } = await mkPlugin({ dir, reply: GOOD });
            setIdle();
            p._reflectPending = true;
            globalThis.__worldSenseState = () => ({ activity: { state: 'gaming' } });
            const r = await p._maybeReflect();
            ok('gaming：不调 LLM、不写盘', r && r.skipped === 'world_busy' && calls.length === 0 && readInsights(dir).length === 0);
            ok('gaming：待反思标记保留', p._reflectPending === true);
            globalThis.__worldSenseState = () => ({ activity: { state: 'watching' } });
            const r2 = await p._maybeReflect();
            ok('watching：同样跳过', r2 && r2.skipped === 'world_busy');
            delete globalThis.__worldSenseState;
        }

        // ═══════════════════════════════════════════════════════════════
        // ⑩ 触发器接线：低阈值下强情绪消息点亮 pending
        // ═══════════════════════════════════════════════════════════════
        {
            const dir = newDir();
            const { p } = await mkPlugin({ dir, cfg: { reflect_threshold: 5 }, reply: GOOD });
            const r = p._noteImportance('我今天崩溃了，哭了很久，特别难受');
            ok('低阈值 + 强情绪 → 触发器点火', r.fire === true && p._reflectPending === true, JSON.stringify(r));
        }
        // ═══════════════════════════════════════════════════════════════
        // ⑪ 热重载/并发（2026-11-20 审计 P1-6）
        //    · onStart 的 2 分钟补跑 timer 必须留句柄，onStop/onDestroy 清掉；
        //    · _destroyed 后 _idleTick 不再跑；
        //    · 同一实例并发第二次反思直接跳过并计数；
        //    · cursor CAS：另一实例推进了游标 → 不重复 append、runsToday 不少计。
        // ═══════════════════════════════════════════════════════════════
        {
            const dir = newDir();
            const { p, calls } = await mkPlugin({ dir, reply: GOOD });
            await p.onStart();
            ok('onStart 保存 2 分钟补跑 timer', p._bootTimer != null);
            ok('onStart 保存 5 分钟 interval', p._episodeTimer != null);
            await p.onStop();
            ok('onStop 清掉 boot timer', p._bootTimer === null);
            ok('onStop 清掉 interval', p._episodeTimer === null);
            ok('onStop 置 _destroyed', p._destroyed === true);
            p._reflectPending = true;
            setIdle();
            await p._idleTick();
            ok('destroyed 后 _idleTick 不再调 LLM', calls.length === 0);
            await p.onDestroy();   // 双保险可重复调用
            ok('onDestroy 幂等', p._episodeTimer === null && p._bootTimer === null);
        }

        {
            const dir = newDir();
            writeEpisodes(dir, [EP1]);
            const { p, calls } = await mkPlugin({ dir, reply: GOOD });
            setIdle();
            p._reflectPending = true;
            p._reflecting = true;             // 模拟第一次还没跑完
            const r = await p._maybeReflect();
            ok('并发第二次 → skipped=concurrent', r && r.skipped === 'concurrent', JSON.stringify(r));
            ok('并发跳过计数 +1', r && r.skippedTotal === 1);
            ok('并发跳过不调 LLM', calls.length === 0);
            ok('并发跳过不动游标', readInsights(dir).length === 0);
            p._reflecting = false;
            const r2 = await p._maybeReflect();
            ok('互斥释放后正常跑完', r2 && r2.ok === true, JSON.stringify(r2));
        }

        {
            const dir = newDir();
            writeEpisodes(dir, [EP1]);
            // 基准：今天已经跑过 1 次（模拟另一实例/上一轮），游标还没读到任何片段。
            writeCursor(dir, {
                lastEpisodeLine: 0, lastEpisodeId: null, lastRunAt: Date.now() - 60000,
                runsToday: 1, day: STORE.todayStr(Date.now()), lastError: null,
            });
            let injected = false;
            const { p } = await mkPlugin({
                dir,
                reply: async () => {
                    // 模拟另一实例在本轮 LLM 期间完成了同一批片段：把游标推到 EP1 行号 1。
                    if (!injected) {
                        injected = true;
                        writeCursor(dir, {
                            lastEpisodeLine: 1,
                            lastEpisodeId: 'ep:1:other',
                            lastRunAt: Date.now(),
                            runsToday: 2,
                            day: STORE.todayStr(Date.now()),
                            lastError: null,
                        });
                    }
                    return GOOD;
                },
            });
            setIdle();
            p._reflectPending = true;
            const r = await p._maybeReflect();
            ok('CAS 冲突 → 本轮标记 deduped', r && r.deduped === true, JSON.stringify(r && { ok: r.ok, deduped: r.deduped }));
            ok('CAS 冲突 → 不重复 append insight', readInsights(dir).length === 0);
            const cur = readCursor(dir);
            ok('CAS 冲突 → 保留对方更远的游标', cur && cur.lastEpisodeLine === 1, JSON.stringify(cur));
            ok('CAS 冲突 → 日配额不少计（基准 1 + 对方 1 + 本轮 1）', cur && cur.runsToday === 3, JSON.stringify(cur));
        }
        // ═══════════════════════════════════════════════════════════════
        // ⑫ 反思触发持久化（2026-11-24 审计 §9.3-③）
        //    remain/pending 原来只在内存：今天重启 8 次 → 永远攒不到 60。
        //    现在写进 insights-cursor.json（与 runsToday/day/游标同文件），onInit 恢复。
        // ═══════════════════════════════════════════════════════════════
        {
            const trg = IMP.createTrigger({ threshold: 10 });
            ok('setRemain 正常夹取', trg.setRemain(7) === 7 && trg.remain === 7, 'remain=' + trg.remain);
            ok('setRemain 0 → 1（不把触发器设成永久点火）', trg.setRemain(0) === 1, 'remain=' + trg.remain);
            ok('setRemain 超阈值 → threshold', trg.setRemain(99) === 10, 'remain=' + trg.remain);
            ok('setRemain 非法输入保持原值', trg.setRemain(NaN) === 10, 'remain=' + trg.remain);
            // 旧版游标没有这两个字段：必须读成 null（不能是 1，否则一重启就立刻反思）
            const legacy = STORE.normalizeCursor({ lastEpisodeLine: 3, runsToday: 1, day: '2026-11-24' });
            ok('旧版游标缺字段 → reflectRemain/reflectPending = null',
                legacy.reflectRemain === null && legacy.reflectPending === null,
                JSON.stringify({ remain: legacy.reflectRemain, pending: legacy.reflectPending }));
            ok('标准化不丢弃原有字段', legacy.lastEpisodeLine === 3 && legacy.runsToday === 1);
        }
        {
            const dir = newDir();
            const fresh = await mkPlugin({ dir, reply: GOOD });
            ok('无游标文件时 onInit 保持默认阈值（不误恢复成 1）',
                fresh.p._reflectTrigger.remain === 60 && fresh.p._reflectPending === false,
                'remain=' + fresh.p._reflectTrigger.remain);
        }
        {
            const dir = newDir();
            const a = await mkPlugin({ dir, reply: GOOD });
            writeCursor(dir, {
                lastEpisodeLine: 0, lastEpisodeId: null, lastRunAt: 0,
                runsToday: 2, day: STORE.todayStr(Date.now()), lastError: null,
            });
            a.p._reflectTrigger.setRemain(7);
            a.p._reflectState.remain = 7;
            a.p._reflectPending = true;
            const saved = a.p._persistReflectTrigger('test');
            const cur = readCursor(dir);
            ok('触发状态写进 insights-cursor.json',
                saved === true && cur.reflectRemain === 7 && cur.reflectPending === true,
                JSON.stringify({ remain: cur.reflectRemain, pending: cur.reflectPending }));
            ok('写触发状态不覆盖 runsToday/day/片段游标',
                cur.runsToday === 2 && cur.lastEpisodeLine === 0 && cur.day === STORE.todayStr(Date.now()),
                JSON.stringify({ runsToday: cur.runsToday, line: cur.lastEpisodeLine }));

            const b = await mkPlugin({ dir, reply: GOOD });
            ok('新实例 onInit 从游标恢复 remain', b.p._reflectTrigger.remain === 7,
                'remain=' + b.p._reflectTrigger.remain);
            ok('新实例 onInit 从游标恢复 pending', b.p._reflectPending === true);
            ok('恢复时留日志（可观测）', b.logs.some((l) => /从游标恢复触发状态/.test(l)),
                b.logs.filter((l) => /恢复/.test(l)).slice(-1)[0]);

            // onStop 必须强制写一次：不能把最后 2 秒的累计丢掉
            b.p._reflectTrigger.setRemain(4);
            b.p._reflectPending = true;
            await b.p.onStop();
            const cur2 = readCursor(dir);
            ok('onStop 强制写触发状态', cur2.reflectRemain === 4 && cur2.reflectPending === true,
                JSON.stringify({ remain: cur2.reflectRemain, pending: cur2.reflectPending }));
        }
        {
            const d2 = await mkPlugin({ dir: newDir(), cfg: { reflect_threshold: 5 }, reply: GOOD });
            d2.p._noteImportance('我今天崩溃了，哭了很久，特别难受');
            ok('触发变化排一次 debounce 落盘', d2.p._reflectPersistTimer != null);
            if (d2.p._reflectPersistTimer) { clearTimeout(d2.p._reflectPersistTimer); d2.p._reflectPersistTimer = null; }
        }

        // ═══════════════════════════════════════════════════════════════
        // ⑬ 429 熔断接线（2026-11-24 审计 P0-1）
        //    首轮失败 → 熔断记配额暂停；之后同一 5 分钟节拍不再调 LLM、不刷屏。
        // ═══════════════════════════════════════════════════════════════
        {
            const dir = newDir();
            writeEpisodes(dir, [EP1]);
            const resetAt = Date.now() + 7 * 24 * 3600 * 1000;   // 未来一周，保证暂停窗口有效
            const resetIso = new Date(resetAt).toISOString();
            const body = JSON.stringify({
                error: { message: "You've reached your weekly usage limit for your plan. Your limit resets at " + resetIso },
            });
            // 与 plugin-context 改造后的形态一致：message 带 body 摘要，err 上挂 status/body/quotaResetAt。
            const qErr = new Error('LLM API error: 429 — ' + body.replace(/\s+/g, ' ').slice(0, 160));
            qErr.status = 429;
            qErr.body = body;
            qErr.quotaResetAt = resetAt;

            const { p, logs, calls } = await mkPlugin({ dir, reply: qErr });
            setIdle();
            p._reflectPending = true;
            const r1 = await p._maybeReflect();
            ok('429 首轮：调用失败且日志带 body 摘要',
                r1 && r1.ok === false && calls.length === 1 &&
                logs.some((l) => /^warn/.test(l) && /429/.test(l) && /weekly usage limit/.test(l)),
                logs.filter((l) => /429/.test(l)).slice(-1)[0]);
            ok('429 首轮：游标不前进（下次重试）', readCursor(dir).lastEpisodeLine === 0);
            ok('429 首轮：共享熔断记为 quota_exhausted',
                p.inspect('').background.health.source === 'quota_exhausted',
                JSON.stringify(p.inspect('').background.health));

            const r2 = await p._maybeReflect();
            ok('429 后第二次 tick 不再调 LLM',
                r2 && r2.skipped === 'llm_paused' && calls.length === 1, JSON.stringify(r2));
            ok('429 后待反思标记保留（恢复后还能跑）', p._reflectPending === true);
            ok('暂停期间不占日配额', Number(readCursor(dir).runsToday) === 1,
                'runsToday=' + readCursor(dir).runsToday);

            const pauseLogs1 = logs.filter((l) => /LLM 暂停中/.test(l)).length;
            const r3 = await p._maybeReflect();
            ok('暂停日志只喊一次（不每 5 分钟刷屏）',
                pauseLogs1 === 1 && logs.filter((l) => /LLM 暂停中/.test(l)).length === 1 && calls.length === 1,
                'pauseLogs=' + pauseLogs1 + ' calls=' + calls.length);
            ok('inspect() 暴露 background.enabled/health',
                (() => {
                    const ins = p.inspect('你好');
                    return ins.background && typeof ins.background.enabled === 'boolean' && !!ins.background.health;
                })());
            ok('第三轮仍被熔断拦住', r3 && r3.skipped === 'llm_paused');
        }

    } finally {
        delete global.__lastUserInputAt;
        delete globalThis.__worldSenseState;
        delete process.env.PET_DATA_ROOT;
        iso.cleanup(TMP_ROOT);
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + ((e && e.stack) || e));
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
    process.exit(1);
});
