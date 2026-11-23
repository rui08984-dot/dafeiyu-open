#!/usr/bin/env node
/**
 * _probe/test-heard-text.cjs —— heard_response（被打断时只记真正播出去的部分）
 *
 * 纯 node：不启动 Electron、不出声、不碰真实数据。
 *
 * 覆盖：
 *   A. js/core/heard-text.js 纯函数
 *      · 整段播完（pending 为空）→ full
 *      · 段中被打断 → 只留已播前缀
 *      · 不可信（pending 不是后缀 / 顺序错 / 对象读不懂）→ null
 *      · 一个字没播（pending === full）→ ''
 *      · 空 full → null
 *   B. js/voice/tts-processor.js 接线
 *      · 真实 EnhancedTextProcessor.prototype.interrupt + 假引擎：回调收到 {heard, full, reason}
 *      · 只在 wasPlaying 且 heard 是 string 时回调
 *      · 打断后队列照旧清空（行为未变）
 *      · 源码：heard 计算早于 `this.textSegmentQueue = []`；回调在清队之后
 *   C. js/ai/llm-handler.js 接线（源码级）
 *      · 注册 setInterruptListener(applyHeardResponse)，且只注册一次
 *      · 仅当 heard 短于 full 才改；只改最近一条 role==='assistant' 且 content 匹配 full 的消息
 *      · 截断形状 = heard + '……' 且打 interrupted 标记；找不到就不动
 *
 * 判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const HEARD = path.join(APP, 'js', 'core', 'heard-text.js');
const TTS = path.join(APP, 'js', 'voice', 'tts-processor.js');
const LLM = path.join(APP, 'js', 'ai', 'llm-handler.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name); return true; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}
function eq(name, actual, expected) {
    return ok(name, actual === expected, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}

// ── A. 纯函数 ─────────────────────────────────────────────────────────────
const H = require(HEARD);

console.log('\n[A] computeHeardPrefix');
{
    const full = '第一句。第二句。第三句。';
    eq('段中打断：只剩第一句', H.computeHeardPrefix(full, {
        unplayedCurrent: '第二句。',
        queuedTexts: ['第三句。'],
    }), '第一句。');

    // pending 为空 = 队列已空 → 整段都播过（两种写法）
    eq('整段播完：不传剩余', H.computeHeardPrefix(full), full);
    eq('整段播完：空当前段 + 空队列', H.computeHeardPrefix(full, { unplayedCurrent: '', queuedTexts: [] }), full);
    eq('整段播完：null 当空', H.computeHeardPrefix(full, { unplayedCurrent: null, queuedTexts: null }), full);

    // 不可信：顺序错 / 被改写 → null（宁可不知道，不能猜错）
    eq('不可信：剩余段顺序错', H.computeHeardPrefix('第一句。第二句。', {
        unplayedCurrent: '第二句。',
        queuedTexts: ['第一句。'],
    }), null);
    eq('不可信：剩余被改写', H.computeHeardPrefix('今天天气不错，出去走走吧。', {
        unplayedCurrent: '出去散散步吧。',
    }), null);
    eq('不可信：瞎给一段不是后缀', H.computeHeardPrefix('abc', { unplayedCurrent: 'xyz' }), null);

    // 一个字没播
    eq('一个字没播：pending === full → 空串', H.computeHeardPrefix(full, {
        unplayedCurrent: full,
    }), '');

    // 空全文
    eq('空 full → null', H.computeHeardPrefix('', { unplayedCurrent: '' }), null);
    eq('null full → null', H.computeHeardPrefix(null, {}), null);

    // 结果 rstrip：剩下来的前缀是空白 → ''
    eq('前缀只有空白 → 空串', H.computeHeardPrefix('  下一句。', { unplayedCurrent: '下一句。' }), '');
    eq('前缀尾部空白被剥掉', H.computeHeardPrefix('甲  乙。', { unplayedCurrent: '乙。' }), '甲');

    // 播放器对象形状（getUnplayedCurrentText 的返回值）直接喂进来
    eq('对象形状 remainder', H.computeHeardPrefix(full, {
        unplayedCurrent: { text: '第二句。', playedChars: 0, totalChars: 4, remainder: '第二句。' },
        queuedTexts: ['第三句。'],
    }), '第一句。');
    eq('对象形状按 playedChars 截', H.computeHeardPrefix(full, {
        unplayedCurrent: { text: '第二句。', playedChars: 2, totalChars: 4 },
        queuedTexts: ['第三句。'],
    }), '第一句。第二');
    eq('队列里的对象段按全文算', H.computeHeardPrefix(full, {
        unplayedCurrent: '第二句。',
        queuedTexts: [{ text: '第三句。' }],
    }), '第一句。');
    eq('读不懂的对象段 → null', H.computeHeardPrefix(full, {
        unplayedCurrent: '第二句。',
        queuedTexts: [{ foo: 1 }],
    }), null);

    const m = H.markInterrupted('第一句。');
    ok('markInterrupted 形状', m && m.text === '第一句。' && m.interrupted === true, JSON.stringify(m));
    eq('markInterrupted null → 空串', H.markInterrupted(null).text, '');
}

// ── B. tts-processor 接线 ────────────────────────────────────────────────
console.log('\n[B] tts-processor.interrupt 接线');
{
    const { EnhancedTextProcessor, setInterruptListener } = require(TTS);
    const proto = EnhancedTextProcessor.prototype;

    // 拦掉 300ms 的真实定时器（interrupt 末尾会安排重启线程），并静音单次调用的 console.log
    const realSetTimeout = global.setTimeout;
    const realLog = console.log;
    const scheduled = [];
    global.setTimeout = (fn, ms) => { scheduled.push({ fn, ms }); return { _fake: true }; };

    function makeProc(state) {
        const proc = Object.create(proto);
        const s = state || {};
        proc.config = {};
        proc.llmFullResponse = s.full || '';
        proc.textSegmentQueue = (s.queued || []).slice();
        proc.audioDataQueue = (s.audioQueued || []).slice();
        proc._fallbackQueue = [];
        proc._fallbackTimer = null;
        proc._subtitleHideTimer = null;
        proc.isProcessing = false;
        proc.shouldStop = false;
        proc.ttsUnavailable = false;
        proc.abortGeneration = 0;
        proc.volcSession = null;
        proc._volcChain = Promise.resolve();
        proc.textMouth = { stop() {} };
        proc.playbackEngine = {
            getPlayingState: () => s.playing === true,
            getUnplayedCurrentText: () => (typeof s.unplayed === 'function' ? s.unplayed() : (s.unplayed || null)),
            stop() { s.stopped = true; },
            onEndCallback: null,
            expressionMapper: null,
            reset() {},
        };
        proc.requestHandler = {
            volcTtsEnabled: false,
            abortAllRequests() {},
            reset() {},
        };
        proc.startProcessingThread = () => {};
        proc.startPlaybackThread = () => {};
        return proc;
    }

    function runInterrupt(state, opts) {
        const got = [];
        setInterruptListener((payload) => got.push(payload));
        const proc = makeProc(state);
        const savedLog = console.log;
        console.log = () => {};                 // interrupt 自己会打一行「打断TTS播放...」
        try {
            proc.interrupt(opts || { reason: 'test' });
        } finally {
            console.log = savedLog;
        }
        setInterruptListener(null);
        return { got, proc };
    }

    // 1) 真的在播 + 可信前缀：回调收到精确 heard/full/reason；队列照旧清空
    {
        const st = {
            playing: true,
            full: '第一句。第二句。第三句。',
            unplayed: '第二句。',
            queued: ['第三句。'],
        };
        const { got, proc } = runInterrupt(st, { reason: 'ptt' });
        ok('在播：回调恰好一次', got.length === 1, 'got=' + got.length);
        eq('在播：heard 正确', got[0] && got[0].heard, '第一句。');
        eq('在播：full 正确', got[0] && got[0].full, '第一句。第二句。第三句。');
        eq('在播：reason 透传', got[0] && got[0].reason, 'ptt');
        eq('行为未变：文本队列已清空', proc.textSegmentQueue.length, 0);
        eq('行为未变：llmFullResponse 已清空', proc.llmFullResponse, '');
        ok('行为未变：仍安排 300ms 线程重启', scheduled.some((t) => t.ms === 300));
        ok('行为未变：播放器被 stop', st.stopped === true);
    }

    // 2) 没在播（PTT 普通提问）：不回调
    {
        const { got } = runInterrupt({ playing: false, full: '随便说点。', queued: [] });
        ok('没在播：不回调', got.length === 0, 'got=' + got.length);
    }

    // 3) 在播但剩余对不上（不可信）：heard 是 null → 不回调
    {
        const { got } = runInterrupt({
            playing: true,
            full: '第一句。第二句。',
            unplayed: '第二句。',
            queued: ['第一句。'],                 // 顺序反了 → pending 不是后缀
        });
        ok('不可信前缀：不回调（绝不瞎截历史）', got.length === 0, 'got=' + got.length);
    }

    // 4) 整段都播过：heard === full，仍回调（截不截由监听方判断）
    {
        const { got } = runInterrupt({ playing: true, full: '整句。', unplayed: null, queued: [] });
        ok('播完：回调一次', got.length === 1, 'got=' + got.length);
        eq('播完：heard === full', got[0] && got[0].heard, '整句。');
    }

    // 5) 播放器对象形状（真实引擎的返回值）
    {
        const { got } = runInterrupt({
            playing: true,
            full: '第一句。第二句。第三句。',
            unplayed: { text: '第二句。', playedChars: 0, totalChars: 4, remainder: '第二句。' },
            queued: ['第三句。'],
        });
        eq('对象形状：heard 正确', got[0] && got[0].heard, '第一句。');
    }

    // 6) audioDataQueue（已合成未播）也算剩余：只靠一个尾部标点绝不能误判「全播完」
    //    full = A+B，A 播到只剩「。」，B 已合成在 audioDataQueue（textSegmentQueue 空）。
    //    少了 audio 段时 pending='。' 恰好是 full 后缀 → 会误判成「只差最后一个字」。
    {
        const full = '今天天气真不错。我们出去玩吧。';
        const { got } = runInterrupt({
            playing: true,
            full,
            unplayed: '。',
            queued: [],
            audioQueued: [{ audio: {}, text: '我们出去玩吧。' }],
        });
        eq('audio 队列计入剩余：只认第一句（差最后一个句号）', got[0] && got[0].heard, '今天天气真不错');
    }

    global.setTimeout = realSetTimeout;
    console.log = realLog;

    // 源码顺序断言：heard 计算必须早于清队；回调在清队之后
    const src = fs.readFileSync(TTS, 'utf8');
    const iInterrupt = src.indexOf('interrupt(opts) {');
    const iHeard = src.indexOf('computeHeardPrefix', iInterrupt);
    const iClear = src.indexOf('this.textSegmentQueue = []', iInterrupt);
    const iCallback = src.indexOf('_onInterrupted({ heard', iInterrupt);
    ok('源码：找到 interrupt', iInterrupt > 0);
    ok('源码：heard 计算早于 textSegmentQueue=[]', iHeard > iInterrupt && iHeard < iClear,
        'interrupt@' + iInterrupt + ' heard@' + iHeard + ' clear@' + iClear);
    ok('源码：回调在清队之后', iCallback > iClear, 'callback@' + iCallback + ' clear@' + iClear);
    ok('源码：只在 wasPlaying 且 heard 是 string 时回调',
        /wasPlaying === true && typeof heard === 'string'/.test(src));
    ok('源码：pending 含 audioDataQueue（防「尾部标点」误判）',
        /audioDataQueue\.slice\(\)/.test(src.slice(iInterrupt, iClear)));
    ok('源码：导出 setInterruptListener', /module\.exports = \{[^}]*setInterruptListener/.test(src));
}

// ── C. llm-handler 接线（源码级）──────────────────────────────────────────
console.log('\n[C] llm-handler 接线');
{
    const src = fs.readFileSync(LLM, 'utf8');

    ok('要求 tts-processor 的显式回调注册',
        /setInterruptListener\(applyHeardResponse\)/.test(src));
    ok('只注册一次（幂等标志）',
        /_heardListenerInstalled/.test(src) && /if \(_heardListenerInstalled\) return true;/.test(src));
    ok('模块初始化即注册', /\r?\n_installHeardListener\(\);\r?\n/.test(src));

    // 只在 heard 比 full 短时改
    ok('heard 不短于 full → 直接返回，不改历史',
        /if \(heard\.length >= full\.length\) return false;/.test(src));

    // 只改 assistant、只改匹配 full 的那条、从后往前找
    ok('只匹配 role===assistant',
        /if \(!m \|\| m\.role !== 'assistant' \|\| typeof m\.content !== 'string'\) continue;/.test(src));
    ok('用 full 匹配消息内容',
        /_contentMatchesFull\(m\.content, full\)/.test(src));
    ok('从后往前找最近一条', /for \(let i = msgs\.length - 1; i >= 0; i -= 1\)/.test(src));
    ok('已截过的不重复截', /if \(m\.interrupted === true\) continue;/.test(src));

    // 截断形状：heard + '……'，并打 interrupted 标记
    ok("截断形状 = heard + '……'",
        /markInterrupted\(heard\.replace\(\/\\s\+\$\/, ''\) \+ '……'\)/.test(src));
    ok('标记 interrupted', /Object\.defineProperty\(message, 'interrupted'/.test(src));
    ok('找不到对应消息 → 静默失败', /return false;\s*\/\/ 找不到：静默失败/.test(src));

    // 不新增消息、不改顺序：补丁逻辑里没有任何 push/splice/unshift
    const iApply = src.indexOf('function _patchHeardInHistory');
    const iNext = src.indexOf('function _flushPendingHeard', iApply);
    const block = src.slice(iApply, iNext);
    ok('补丁逻辑不 push/splice/unshift',
        !/\.(push|splice|unshift)\s*\(/.test(block), block.slice(0, 200));

    // 时序兜底：落库后补打（且追加在 push 之后）
    const iPush = src.indexOf("voiceChat.messages.push({ 'role': 'assistant', 'content': finalResponseContent });");
    const iFlush = src.indexOf('_flushPendingHeard();', iPush);
    ok('助手消息落库后调用 _flushPendingHeard', iPush > 0 && iFlush > iPush,
        'push@' + iPush + ' flush@' + iFlush);
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
if (fail) {
    console.error('\n❌ heard-text：FAIL ' + fail + ' / PASS ' + pass);
    process.exit(1);
}
console.log('\n  ✅ heard-text：PASS ' + pass + ' / FAIL 0');
