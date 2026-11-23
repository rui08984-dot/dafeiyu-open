#!/usr/bin/env node
/**
 * _probe/test-speech-gates.cjs —— 工具统一超时 + 说话让路闸（2026-11-15 六十三轮）
 *
 * 两件事都来自「Neuro-sdk action.result ~20s」与「priority/语句级打断」的对照：
 *   ① 工具超时以前各工具自己管（有的没管）→ 慢工具把整轮卡死，用户看到「她不理我」
 *   ② speech-coordinator.userActive() 原来是个**恒 false 的占位** → 主动搭话会插进回复过程中
 */
'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const TE = require(path.join(LIVE, 'js', 'ai', 'tool-executor.js'));
// 预算闸有真实持久化（当天可能已经 8/8 用完）——单测要测的是「让路/优先级」，不是预算。
// 这里把 speech-budget 的模块缓存换成恒放行的假实现（协调器是在 request() 里动态 require 的）。
const budgetPath = require.resolve(path.join(LIVE, 'js', 'core', 'speech-budget.js'));
require.cache[budgetPath] = {
    id: budgetPath, filename: budgetPath, loaded: true,
    exports: { singleton: () => ({ request: () => ({ allowed: true, attemptId: 'test' }) }) },
};
const SC = require(path.join(LIVE, 'js', 'core', 'speech-coordinator.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

(async () => {
    // ── ① 工具超时 ────────────────────────────────────────────────────────
    ok('默认超时 20s', TE.DEFAULT_TOOL_TIMEOUT_MS === 20000);
    ok('game 放宽到 30s', TE.toolTimeoutFor('game') === 30000);
    ok('see 放宽到 25s', TE.toolTimeoutFor('see') === 25000);
    ok('普通工具走默认', TE.toolTimeoutFor('recall') === 20000);
    ok('带描述的工具名也能匹配', TE.toolTimeoutFor('game→动作') === 30000);

    const fast = await TE.withTimeout(Promise.resolve('ok'), 1000, '快工具');
    ok('快工具正常返回', fast === 'ok');
    const t0 = Date.now();
    let err = null;
    try { await TE.withTimeout(new Promise(() => {}), 120, '慢工具'); } catch (e) { err = e; }
    ok('慢工具按点超时', !!err && Date.now() - t0 >= 100, err ? err.message.slice(0, 40) : 'no error');
    ok('超时消息带工具名与秒数', !!err && /慢工具/.test(err.message) && /1 秒|0 秒/.test(err.message), err && err.message);
    // 已经 reject 的 promise 不该被超时消息盖掉原因
    let e2 = null;
    try { await TE.withTimeout(Promise.reject(new Error('真原因')), 500, 'x'); } catch (e) { e2 = e; }
    ok('原始错误优先于超时', !!e2 && e2.message === '真原因');

    // ── ② 说话让路闸 ──────────────────────────────────────────────────────
    const c = new SC.SpeechCoordinator();
    c.isBusy = () => false;
    c.isQuiet = () => false;
    ok('初始 userActive=false', c.userActive() === false);

    c.markUser();
    ok('markUser 后 userActive=true', c.userActive() === true);
    const g1 = c.request('watch-screen', { priority: 'proactive' });
    ok('用户这轮未结束时主动发起被拒', g1.allowed === false && /用户这轮/.test(g1.reason), g1.reason);
    const g2 = c.request('alive-state', { priority: 'critical' });
    ok('critical 关怀不受让路闸限制', g2.allowed === true, g2.reason);

    // 用户这轮结束很久 → 放行
    c._lastUserTurnAt = Date.now() - 60000;
    c._lastSpokenAt = 0;
    const g3 = c.request('watch-screen', { priority: 'proactive' });
    ok('过了余温窗口后主动发起放行', g3.allowed === true, g3.reason);

    // isProcessingUserInput / 正在播 TTS 也必须让路
    c._lastUserTurnAt = 0;
    global.isProcessingUserInput = true;
    ok('正在处理用户输入 → 让路', c.userActive() === true);
    global.isProcessingUserInput = false;
    global.appState = { isPlayingTTS: () => true };
    ok('正在播回复 → 让路', c.userActive() === true);
    global.appState = { isPlayingTTS: () => false };
    ok('都没在忙 → 不让路', c.userActive() === false);
    delete global.appState;

    // ── ③ 说完信号 ────────────────────────────────────────────────────────
    const before = c.lastSentenceEndAt();
    c.markSentenceEnd();
    ok('markSentenceEnd 记时间', c.lastSentenceEndAt() > before);

    // ── ④ 四路主动性都必须过同一张闸门表（源码护栏）───────────────────────
    {
        const fs = require('fs');
        const read = (rel) => fs.readFileSync(path.join(LIVE, rel), 'utf8');
        const ac = read('js/live/auto-chat.js');
        ok('auto-chat 走统一闸门', /singleton\.request\('auto-chat'/.test(ac));
        ok('auto-chat 失败会还令牌', /singleton\.release\('auto-chat'/.test(ac));
        ok('auto-chat 成功才记发言', /singleton\.markSpoken\('auto-chat'/.test(ac));

        ok('alive-state 走协调器', /request\('alive-state'/.test(read('plugins/community/alive-state/index.js')));
        ok('watch-screen 走协调器', /speechCoordinator\.request\('watch-screen'/.test(read('plugins/community/watch-screen/index.js')));
        ok('dawn-dusk 走仲裁器', /externalSourcePolicy\??\.[\s\S]{0,4}\('dawn-dusk-line'\)/.test(read('plugins/community/dawn-dusk-line/index.js')));
    }

    // ── ⑤ TTS 首段切分（首音延迟）────────────────────────────────────────
    {
        const H = require(path.join(LIVE, 'js', 'voice', 'tts-request-handler.js'));
        const mk = () => {
            const o = Object.create(H.TTSRequestHandler.prototype);
            o.punctuations = ['。', '？', '!', '！', '；', ';', '\n'];
            o.softPunctuations = ['，', ','];
            o.maxSegmentChars = 80;
            o.firstSegmentChars = 14;
            o.pendingSegment = '';
            return o;
        };
        const o = mk();
        const q = [];
        // 首段：逗号出现时已 ≥14 字 → 立即切
        o.segmentStreamingText('啊'.repeat(14) + '，后面的内容还有很多很多很多', q);
        ok('首段在逗号处提前切（≥14 字）', q.length >= 1 && q[0].endsWith('，'), JSON.stringify(q[0] || ''));
        ok('首段长度明显小于 80', q.length >= 1 && q[0].length < 40, 'len=' + (q[0] || '').length);

        // 首段只要 ≥4 字，第一个逗号就切（edge-tts 单次 ~1.2s，首段带逗号会串行合成两次）
        const o5 = mk();
        const q5 = [];
        o5.segmentStreamingText('嗯嗯嗯嗯，后面还有很多很多内容', q5);
        ok('首段 4 字遇逗号立即切', q5.length >= 1 && q5[0] === '嗯嗯嗯嗯，', JSON.stringify(q5[0] || ''));

        const o2 = mk();
        const q2 = [];
        o2.segmentStreamingText('啊'.repeat(40), q2);
        ok('首段没标点 → 21 字硬切（14×1.5）', q2.length === 1 && q2[0].length === 21, 'len=' + (q2[0] || '').length);

        const o3 = mk();
        const q3 = [];
        o3.segmentStreamingText('第一句就到这里。第二句里有一个逗号，但它不该被切开。', q3);
        ok('句末正常切分', q3.length >= 1 && q3[0] === '第一句就到这里。', JSON.stringify(q3));
        // 后续段即便 30 字才遇到逗号也不切（仍用 80 上限）
        const o4 = mk();
        const q4 = [];
        o4.segmentStreamingText('短句。', q4);            // 先占掉首段
        o4.segmentStreamingText('这一句有二十多个字然后才出现逗号，后面的内容还很长很长', q4);
        ok('非首段不在 24 字处切', q4.length === 1, JSON.stringify(q4.map((s) => s.length)));

        console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
        process.exit(fail === 0 ? 0 : 1);
    }

})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
