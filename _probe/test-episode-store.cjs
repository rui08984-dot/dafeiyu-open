#!/usr/bin/env node
/**
 * _probe/test-episode-store.cjs — 空闲巩固 / 片段卡片回归（2026-11-15 六十轮）
 *
 * 这块的核心风险全是「失败时怎么办」：
 *   · LLM 挂了 → 绝不能把游标往前推（推了就等于这段对话永远压不成卡片）
 *   · LLM 输出坏了 → 同上
 *   · LLM 明确说「这段没值得记的」→ **必须**推游标（否则同一段永远重试，永久卡住）
 *   · 用户还在说话 → 不许抢 LLM
 *
 * 全程离线：把 episode-store 的 IO 换成内存假实现（不碰真实记录室）。
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const ES = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'episode-store.js'));
const P = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'memory-evolve', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// ── 内存假 IO（只替换会落盘/读盘的那几个，parseCard/episodeToDoc 保留真实实现）──
const fake = { cursor: 0, written: [], turns: [], readCalls: 0 };
const orig = {
    loadCursor: ES.loadCursor, saveCursor: ES.saveCursor,
    readTurns: ES.readTurns, appendEpisode: ES.appendEpisode, loadEpisodes: ES.loadEpisodes,
};
// 假 user-facts：记录 addFact 调用（不写真实 用户事实.json）
const UF = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'user-facts.js'));
const origAddFact = UF.addFact;
const factCalls = [];
function installUfFake() {
    factCalls.length = 0;
    UF.addFact = (o) => { factCalls.push(o && o.text); return { ok: true, duplicate: false, id: 'x' + factCalls.length }; };
}
function restoreUf() { UF.addFact = origAddFact; }

function installFake() {
    fake.cursor = 0; fake.written = []; fake.readCalls = 0;
    ES.loadCursor = () => fake.cursor;
    ES.saveCursor = (n) => { fake.cursor = n; return true; };
    ES.readTurns = () => { fake.readCalls += 1; return { turns: fake.turns, consumed: fake.turns.length, total: fake.turns.length }; };
    ES.appendEpisode = (card) => { fake.written.push(card); return true; };
    ES.loadEpisodes = () => fake.written.slice();
}
function restore() { Object.assign(ES, orig); }

function mk(reply) {
    const p = new P();
    const logs = [];
    p.context = {
        getPluginFileConfig: () => ({ enabled: true, episode_min_turns: 4, episode_idle_min: 30 }),
        getPluginFileLog: () => {},
        log: (lv, m) => logs.push(String(m)),
        addSystemPromptPatch: () => {}, removeSystemPromptPatch: () => {},
        getMessages: () => [],
        callLLM: async () => { if (reply instanceof Error) throw reply; return reply; },
    };
    return { p, logs };
}

const GOOD = '{"title":"熬夜改代码","summary":"他凌晨三点还在改代码，说眼睛快瞎了；答应第二天早点睡","facts":["凌晨三点在改代码","答应早点睡"]}';

(async () => {
    installFake();
    installUfFake();
    try {
        // ⓪ 纯函数：解析
        ok('parseCard 能从带代码块的输出里取到 JSON', !!ES.parseCard('```json\n' + GOOD + '\n```'));
        ok('parseCard 无 summary 返回 null', ES.parseCard('{"title":"x"}') === null);
        ok('parseCard summary 太短返回 null', ES.parseCard('{"summary":"好"}') === null);
        const doc = ES.episodeToDoc(ES.parseCard(GOOD));
        ok('episodeToDoc 生成 src=片段 的 doc', doc.src === '片段' && /片段/.test(doc.text) && /熬夜改代码/.test(doc.text), doc.text.slice(0, 40));

        const eightTurns = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '第' + i + '句测试内容' }));

        // ① 用户还在说话 → 不读不写
        {
            installFake();
            fake.turns = eightTurns;
            global.__lastUserInputAt = Date.now() - 60 * 1000;      // 1 分钟前说过话（< 30 分钟）
            const { p } = mk(GOOD);
            await p.onInit();
            const r = await p._maybeBuildEpisode();
            ok('用户还在说话时不压卡片', r === null && fake.readCalls === 0, 'readCalls=' + fake.readCalls);
        }

        // ② 轮数不够 → 不压
        {
            installFake();
            fake.turns = eightTurns.slice(0, 2);
            global.__lastUserInputAt = Date.now() - 60 * 60 * 1000;
            const { p } = mk(GOOD);
            await p.onInit();
            const r = await p._maybeBuildEpisode();
            ok('轮数不足 4 时不压卡片', r === null && fake.written.length === 0);
        }

        // ③ 正常：写卡片 + 游标前进
        {
            installFake();
            fake.turns = eightTurns;
            global.__lastUserInputAt = Date.now() - 60 * 60 * 1000;
            const { p, logs } = mk(GOOD);
            await p.onInit();
            const r = await p._maybeBuildEpisode();
            ok('空闲且够料 → 生成卡片', !!r && fake.written.length === 1, r ? r.title : 'null');
            ok('卡片带 title/summary/facts', !!r && r.title === '熬夜改代码' && (r.facts || []).length === 2);
            ok('游标前进到已消费行数', fake.cursor === 8, 'cursor=' + fake.cursor);
            ok('日志留痕', logs.some((l) => /生成卡片/.test(l)), logs[logs.length - 1]);
            // 卡片给了 2 条事实，但「答应早点睡」只有 5 字 → 按规则被过滤，只升 1 条（正确）
            ok('卡片事实被升进事实层（短句按规则过滤）', factCalls.length === 1 && /凌晨三点/.test(factCalls[0]), JSON.stringify(factCalls));
        }

        // ③b 事实升级的过滤（太短/问句不升）
        {
            installFake();
            const { p } = mk(GOOD);
            await p.onInit();
            factCalls.length = 0;
            const n = p._promoteEpisodeFacts({ facts: ['短句', '这是问题吗？', '他下午三点要去开会这件事'] });
            ok('短句与问句被过滤，只升合格的一条', n === 1 && factCalls.length === 1, JSON.stringify(factCalls));
        }

        // ④ LLM 抛错 → 游标**不动**（关键：推了这段就永远丢了）
        {
            installFake();
            fake.turns = eightTurns;
            global.__lastUserInputAt = Date.now() - 60 * 60 * 1000;
            const { p, logs } = mk(new Error('boom'));
            await p.onInit();
            const r = await p._maybeBuildEpisode();
            ok('LLM 失败时不写卡片', r === null && fake.written.length === 0);
            ok('LLM 失败时游标不动（下次重试）', fake.cursor === 0, 'cursor=' + fake.cursor);
            ok('失败有 warn 留痕', logs.some((l) => /摘要调用失败/.test(l)));
        }

        // ⑤ LLM 输出坏 → 游标不动
        {
            installFake();
            fake.turns = eightTurns;
            global.__lastUserInputAt = Date.now() - 60 * 60 * 1000;
            const { p } = mk('我觉得挺好的但是我没按格式输出');
            await p.onInit();
            const r = await p._maybeBuildEpisode();
            ok('输出不可解析时游标不动', r === null && fake.written.length === 0 && fake.cursor === 0);
        }

        // ⑥ LLM 明说「没值得记的」→ 游标**必须**前进（否则永久卡住）
        {
            installFake();
            fake.turns = eightTurns;
            global.__lastUserInputAt = Date.now() - 60 * 60 * 1000;
            const { p, logs } = mk('{"summary":""}');
            await p.onInit();
            const r = await p._maybeBuildEpisode();
            ok('空内容时跳过并前进游标', r === null && fake.written.length === 0 && fake.cursor === 8, 'cursor=' + fake.cursor);
            ok('跳过有日志', logs.some((l) => /没值得记/.test(l)));
        }

        // ⑦ 防重入
        {
            installFake();
            fake.turns = eightTurns;
            global.__lastUserInputAt = Date.now() - 60 * 60 * 1000;
            const { p } = mk(GOOD);
            await p.onInit();
            p._episodeBusy = true;
            const r = await p._maybeBuildEpisode();
            ok('忙时直接返回（防重入）', r === null && fake.written.length === 0);
            p._episodeBusy = false;
        }
    } finally {
        restore();
        restoreUf();
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('  ✗ 测试自身异常：' + (e && e.stack || e)); process.exit(1); });
