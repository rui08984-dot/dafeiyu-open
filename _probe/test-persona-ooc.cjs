#!/usr/bin/env node
/**
 * _probe/test-persona-ooc.cjs — 原子 OOC 判官回归（2026-11-15 五十九轮）
 *
 * 两条要守住的东西：
 *   ① **自嘲不算出戏**：人设明确允许「拿自己是 AI 开玩笑」，规则不能把性格当 bug 修
 *   ② **行为级具体纠正**：论文实测降漂移 87%（泛化重注入只有 35–38%）——
 *      所以判官必须给出「哪句不对 + 改成什么」，而且不能阻塞回复、不能重复判同一句
 *
 * 全部离线（stub 掉 LLM），不需要她在线。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ⚠ 2026-11-24：persona-guard 的判官走 background-llm.canRun → llmHealth.canCall，
// 读的是「data/LLM健康.json」。不隔离就会吃真实配额暂停状态（实测 pausedUntil 16:32
// 时判官整段跳过 → 7 条断言时间敏感假红）。必须在 require 业务模块**之前**把数据根指到
// 临时目录（与 test-memory-quality.cjs 同款），llm-health 会优先按 PET_DATA_ROOT 取状态文件。
process.env.PET_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-persona-ooc-'));

const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'persona-guard', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function mk(reply, cfg) {
    const p = new P();
    const patches = new Map();
    const logs = [];
    p.context = {
        getPluginFileConfig: () => Object.assign({ max_chars: 200 }, cfg || {}),
        log: (lv, m) => logs.push(lv + ':' + m),
        addSystemPromptPatch: (id, t) => patches.set(id, t),
        removeSystemPromptPatch: (id) => patches.delete(id),
        callLLM: async () => {
            if (reply instanceof Error) throw reply;
            return reply;
        },
        getMessages: () => [],
    };
    return { p, patches, logs };
}

(async () => {
    // ① 自嘲白名单
    {
        const { p } = mk('{"dimension":"none"}');
        await p.onInit();
        const a = p.inspect('我个AI操什么心，还陪你写代码');
        ok('自嘲「我个AI…」不算出戏', !a.hits.some((h) => h.id === 'self-ai'), a.hits.map((h) => h.id).join(',') || '无命中');
        const b = p.inspect('我是一个AI语言模型，很高兴为您服务');
        ok('正经自称 AI/语言模型仍然算出戏', b.hits.some((h) => h.id === 'self-ai') && b.hits.some((h) => h.id === 'assistant-tone'),
            b.hits.map((h) => h.id).join(','));
    }

    // ② 判官给出具体纠正 → 注入带 quote/fix 的补丁
    {
        const { p, patches, logs } = mk('{"dimension":"文风","quote":"我可以帮你整理一下","fix":"这破文件我看看"}');
        await p.onInit();
        p._turn = 10;
        const hit = await p._judgeOoc('我可以帮你整理一下这些文件');
        ok('判官命中时返回 dimension/quote/fix', !!hit && hit.dimension === '文风' && /我来/.test(hit.fix) === false, hit ? JSON.stringify(hit) : 'null');
        const patch = patches.get('persona-guard-ooc') || '';
        ok('补丁里带上了「哪句不对」', /我可以帮你整理一下/.test(patch), patch.slice(0, 60));
        ok('补丁里带上了「改成什么」', /这破文件我看看/.test(patch), patch.slice(0, 60));
        ok('事件已记账', (p._oocEvents || []).length === 1 && p._oocEvents[0].dimension === '文风');
        ok('日志里有一行 warn', logs.some((l) => l.startsWith('warn:[人设判官]')));
    }

    // ③ 同一句不重复判
    {
        const { p } = mk('{"dimension":"文风","quote":"x","fix":"y"}');
        await p.onInit();
        await p._judgeOoc('同一句话同一句话');
        const second = await p._judgeOoc('同一句话同一句话');
        ok('同一句只判一次（避免每轮烧 LLM）', second === null && (p._oocEvents || []).length === 1);
    }

    // ④ 判官说不出戏 → 不注入、不记账
    {
        const { p, patches } = mk('{"dimension":"none"}');
        await p.onInit();
        const hit = await p._judgeOoc('嗯，睡吧，明天再说。');
        ok('没出戏时不返回、不注入', hit === null && !patches.has('persona-guard-ooc'));
    }

    // ⑤ 判官挂掉 → 不注入、不崩
    {
        const { p, patches, logs } = mk(new Error('boom'));
        await p.onInit();
        const hit = await p._judgeOoc('这句随便');
        ok('判官失败时不注入也不抛', hit === null && !patches.has('persona-guard-ooc') && logs.some((l) => /人设判官/.test(l)));
    }

    // ⑥ 正常回复会清掉 ooc 补丁（一次纠正只粘一轮）
    {
        const { p, patches } = mk('{"dimension":"文风","quote":"我可以帮你","fix":"我来看看"}');
        await p.onInit();
        patches.set('persona-guard-ooc', 'x');
        await p.onLLMResponse({ text: '行，睡了。' });
        ok('正常回复后纠正补丁被清掉', !patches.has('persona-guard-ooc'));
    }

    // ⑦ 每 N 轮触发（不阻塞）：慢判官不能让 onLLMResponse 变慢
    {
        const p = new P();
        p.context = {
            getPluginFileConfig: () => ({ max_chars: 200, judge_every: 2 }),
            log: () => {},
            addSystemPromptPatch: () => {}, removeSystemPromptPatch: () => {},
            callLLM: () => new Promise((r) => setTimeout(() => r('{"dimension":"none"}'), 500)),
            getMessages: () => [],
        };
        await p.onInit();
        const t0 = Date.now();
        await p.onLLMResponse({ text: '正常一句话。' });   // turn=1
        await p.onLLMResponse({ text: '正常第二句。' });   // turn=2 → 触发判官（500ms）
        const dt = Date.now() - t0;
        ok('判官不阻塞回复（500ms 判官没进主链）', dt < 200, dt + 'ms');
        await new Promise((r) => setTimeout(r, 700));
        ok('判官确实跑了', (p._judgeRuns || 0) >= 1, 'runs=' + p._judgeRuns);
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('  ✗ 测试自身异常：' + (e && e.stack || e)); process.exit(1); });
