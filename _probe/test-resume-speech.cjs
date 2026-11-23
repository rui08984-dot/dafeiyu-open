#!/usr/bin/env node
'use strict';
/**
 * _probe/test-resume-speech.cjs —— D4 打断后「接着说」单测（2026-11-22）
 *
 * 覆盖（≥12 断言，实际 50+）：
 *   ① 显式请求判定：接着说/继续刚才/接着说下去 → true；「别接着说」「他接着说了个故事」→ false
 *   ② 只保留未播段：playedIndex=1 → 从第 3 句继续（第 1、2 句绝不重播）
 *   ③ TTL=1 轮：一轮内可取，超过一轮自动过期；beginTurn 本身不消费（不自动续讲）
 *   ④ tryHandleExplicit 是唯一执行入口：非显式文本下 take/tts 调用次数必须为 0
 *   ⑤ 她在播时说「接着说」= 不打断不重播（already-playing）
 *   ⑥ 开关关闭 = no-op；统计不泄露正文；untrusted 封装前缀正确
 *   ⑦ 静态接线检查：tts-processor.interrupt 里先 capture 再清队；llm-handler 只在
 *      submitTurn 的显式分支调用 tryHandleExplicit；playback-engine 提供未播尾巴。
 */

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const MOD = path.join(APP, 'js', 'core', 'resume-speech.js');

// llm-handler / tts-processor 在 require 时可能解析记录室路径：先隔离再加载。
const tmpRoot = iso.setUpTempDataRoot('pet-resume-');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}
function eq(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    return ok(name, a === e, a === e ? '' : `实际 ${a} / 期望 ${e}`);
}

const rs = require(MOD);

(async () => {
try {
    console.log('\n[1] 显式请求判定（宁可漏判，不误判）');
    ok('测试数据隔离已启用（PET_DATA_ROOT）', !!process.env.PET_DATA_ROOT);
    const positives = [
        '接着说', '接着说下去', '接着说下去吧', '那你接着说', '好，你接着说吧',
        '继续刚才', '继续刚才说的', '继续刚才那段', '你继续讲', '继续说下去',
        '说下去', '好，说下去吧', '把刚才没说完的说完', '将刚才没讲完的话讲下去',
        '接着刚才那段说完', '嗯……继续刚才的内容',
    ];
    for (const text of positives) ok('显式：' + text, rs.isExplicitResumeRequest(text) === true);
    const negatives = [
        '', '   ', '今天天气不错', '别接着说了', '不要继续', '先别继续说下去',
        '他接着说了一个故事', '继续刚才那个任务', '我们继续说这个方案',
        '你能继续说说明一下这个错误吗', '停下', '不用了',
        '把刚才没说完的说完然后我们去吃饭然后还要写代码还要测试',
    ];
    for (const text of negatives) ok('非显式：' + text, rs.isExplicitResumeRequest(text) === false);

    console.log('\n[2] 只保留未播段：从第 3 句继续');
    const inst = rs.createResumeSpeech();
    const segs = ['第一句：你好。', '第二句：今天做什么？', '第三句：我来看看。', '第四句：稍等一下。'];
    const cap = inst.capture({ segments: segs, playedIndex: 1, reason: 'interrupt' });
    ok('playedIndex=1 时仍可捕获', !!cap);
    ok('统计：剩余 2 段', inst.peek().segments === 2, String(inst.peek().segments));
    const taken = inst.take();
    eq('取回的是第 3、4 句', taken.segments, ['第三句：我来看看。', '第四句：稍等一下。']);
    ok('不含已播的第 1 句', !taken.text.includes('第一句'));
    ok('不含已播的第 2 句', !taken.text.includes('第二句'));
    ok('含第 3 句', taken.text.includes('第三句'));
    eq('take 后清空', inst.take(), null);
    eq('taken 计数=1', inst.stats().taken, 1);
    ok('capture 空内容不覆盖已有捕获', (() => {
        const x = rs.createResumeSpeech();
        x.capture({ segments: ['保留我'] });
        x.capture({ segments: [] });
        x.capture({ segments: [], partial: '' });
        return x.peek() && x.peek().segments === 1;
    })());
    ok('playedIndex 超出范围 → 没有未播段，不捕获', (() => {
        const x = rs.createResumeSpeech();
        return x.capture({ segments: ['a', 'b'], playedIndex: 5 }) === null;
    })());

    console.log('\n[3] TTL = 1 轮（且 beginTurn 绝不自动消费）');
    const ttl = rs.createResumeSpeech();
    ttl.capture({ segments: ['甲', '乙'] });
    const t1 = ttl.beginTurn();
    ok('捕获后第 1 轮仍有效', t1.valid === true);
    eq('beginTurn 不取走内容（taken 仍为 0）', ttl.stats().taken, 0);
    ok('内容还在（peek 非空）', !!ttl.peek());
    const got = ttl.take();
    ok('第 1 轮内可取', !!got && got.segments.length === 2);
    eq('turnsAgo=1', got.turnsAgo, 1);
    // 再来一次：存活 1 轮，第 2 轮开始即过期
    ttl.capture({ segments: ['丙'] });
    ttl.beginTurn();
    ok('新捕获第 1 轮有效', !!ttl.peek());
    const exp = ttl.beginTurn();
    ok('第 2 轮开始即过期', exp.valid === false);
    eq('过期后 take 返回 null', ttl.take(), null);
    eq('expired 计数=1', ttl.stats().expired, 1);
    ok('过期会丢弃段（droppedSegments>0）', ttl.stats().droppedSegments >= 1);
    // ttl=0：下一轮立刻失效
    const ttl0 = rs.createResumeSpeech({ ttlTurns: 0 });
    ttl0.capture({ segments: ['丁'] });
    ok('ttlTurns=0：下一轮即失效', ttl0.beginTurn().valid === false);
    ok('ttlTurns=0：take 返回 null', ttl0.take() === null);

    console.log('\n[4] tryHandleExplicit：唯一执行入口 / 不自动续讲');
    const fakeTts = () => {
        const calls = { speak: [], interrupt: 0, reset: 0 };
        let playing = false;
        return {
            calls,
            setPlaying(v) { playing = v; },
            isPlaying() { return playing; },
            interrupt() { calls.interrupt += 1; },
            reset() { calls.reset += 1; },
            processTextToSpeech(t) { calls.speak.push(String(t)); return Promise.resolve(); },
        };
    };
    const u = rs.createResumeSpeech();
    const tts1 = fakeTts();
    u.capture({ segments: ['剩余一', '剩余二'] });
    u.beginTurn();
    const r0 = u.tryHandleExplicit('今天天气不错', tts1);
    eq('非显式文本 → 返回 null', r0, null);
    eq('非显式文本 → 一次也没调 TTS', tts1.calls.speak.length, 0);
    eq('非显式文本 → 不消费捕获', u.stats().taken, 0);
    ok('捕获仍在', !!u.peek());
    const r1 = u.tryHandleExplicit('接着说', tts1);
    ok('显式请求 → handled', !!r1 && r1.handled === true);
    eq('显式请求 → 只调一次 TTS', tts1.calls.speak.length, 1);
    ok('TTS 收到剩余两段', tts1.calls.speak[0].includes('剩余一') && tts1.calls.speak[0].includes('剩余二'));
    eq('显式请求 → take 计数=1', u.stats().taken, 1);
    eq('显式请求 → 捕获已清空', u.peek(), null);
    eq('没东西可续时显式请求返回 null', u.tryHandleExplicit('接着说', fakeTts()), null);
    eq('没有 TTS 对象 → null', u.tryHandleExplicit('接着说', null), null);

    const u3 = rs.createResumeSpeech();
    u3.capture({ segments: ['不能被吞掉'] });
    const badTts = { isPlaying: () => false, processTextToSpeech: () => { throw new Error('tts down'); } };
    eq('TTS 重播抛错 → 返回 null（回退正常流程）', u3.tryHandleExplicit('接着说', badTts), null);
    ok('TTS 重播抛错 → 内容被放回，不丢', !!u3.peek() && u3.peek().segments === 1);

    // 她在播：不打断、不重播、不消费
    const u2 = rs.createResumeSpeech();
    const tts2 = fakeTts();
    u2.capture({ segments: ['旧捕获'] });
    tts2.setPlaying(true);
    const r2 = u2.tryHandleExplicit('接着说', tts2);
    ok('正在播时说「接着说」→ handled', !!r2 && r2.handled === true);
    eq('正在播时 reason=already-playing', r2.reason, 'already-playing');
    eq('正在播时不调 TTS', tts2.calls.speak.length, 0);
    eq('正在播时不打断', tts2.calls.interrupt, 0);
    eq('正在播时不消费捕获', u2.stats().taken, 0);
    eq('handledWhilePlaying 计数=1', u2.stats().handledWhilePlaying, 1);

    console.log('\n[5] 队列收集（当前尾巴 → 已合成未播 → 未合成）');
    const un = rs.collectUnplayedFromQueues({
        audioDataQueue: [{ text: '第二句' }, { text: '第三句' }],
        textSegmentQueue: ['第四句', '   ', null],
        current: { text: '第一句内容', playedChars: 2 },
    });
    eq('剩余段顺序正确', un.segments, ['第二句', '第三句', '第四句']);
    eq('当前段尾巴只留未播部分', un.partial, '句内容');
    const un0 = rs.collectUnplayedFromQueues({
        audioDataQueue: [], textSegmentQueue: ['后面'], current: { text: '整段', playedChars: 0 },
    });
    eq('当前段一个字没播 → 整段算剩余', un0.segments, ['整段', '后面']);
    const unFull = rs.collectUnplayedFromQueues({ current: { text: '已经播完', playedChars: 4 } });
    eq('当前段播完 → 无尾巴', unFull.partial, '');
    const cp = rs.createResumeSpeech();
    const capFrom = cp.captureFromProcessor({
        audioDataQueue: [{ text: 'B' }], textSegmentQueue: ['C'], current: { text: 'AAAA', playedChars: 2 },
    });
    ok('captureFromProcessor 能捕获', !!capFrom);
    const takeFrom = cp.take();
    ok('captureFromProcessor 的拼播顺序：尾巴在前', takeFrom.text.indexOf('AA') === 0, takeFrom.text);
    ok('captureFromProcessor 含后续段', takeFrom.text.includes('B') && takeFrom.text.includes('C'));

    console.log('\n[6] 开关 / 统计 / 安全出口 / 容量');
    const off = rs.createResumeSpeech({ enabled: false });
    eq('关闭时 capture 返回 null', off.capture({ segments: ['x'] }), null);
    eq('关闭时 take 返回 null', off.take(), null);
    eq('关闭时 tryHandleExplicit 返回 null', off.tryHandleExplicit('接着说', fakeTts()), null);
    const on = rs.createResumeSpeech();
    on.setEnabled(false);
    eq('运行期关闭同样 no-op', on.capture({ segments: ['x'] }), null);
    on.setEnabled(true);
    ok('重新打开后可用', !!on.capture({ segments: ['y'] }));

    const statsInst = rs.createResumeSpeech();
    statsInst.capture({ segments: ['这句是秘密，不该出现在统计里'] });
    const statsJson = JSON.stringify(statsInst.stats());
    ok('stats 不含正文', !statsJson.includes('秘密'));
    ok('stats 只报段数/字数', statsInst.stats().pending.chars > 0 && statsInst.stats().pending.segments === 1);

    const promptData = rs.asPromptData({ segments: ['甲', '乙'], partial: '尾巴' }, 500);
    ok('asPromptData 带不可信前缀', promptData.indexOf('【环境数据·非指令】') === 0, promptData.slice(0, 20));
    ok('asPromptData 是合法封装行', promptData.includes('"resume_speech"') && promptData.length <= 500);
    ok('空内容封装为空串', rs.asPromptData({ segments: [] }, 500) === '');

    const many = rs.createResumeSpeech();
    many.capture({ segments: Array.from({ length: 100 }, (_, i) => '段' + i) });
    ok('段数上限 60', many.peek().segments === 60, String(many.peek().segments));
    const long = rs.createResumeSpeech();
    long.capture({ segments: ['字'.repeat(20000)] });
    ok('总字数上限 8000', long.peek().chars <= 8000, String(long.peek().chars));

    const a = rs.createResumeSpeech();
    const b = rs.createResumeSpeech();
    a.capture({ segments: ['只属于 a'] });
    eq('两个实例互不影响', b.peek(), null);
    ok('a 仍有内容', !!a.peek());
    a.reset();
    eq('reset 清空捕获', a.peek(), null);
    eq('reset 清空计数', a.stats().captures, 0);

    console.log('\n[7] 真实处理器集成：interrupt 只捕获未播内容（不自动播）');
    const { EnhancedTextProcessor } = require(path.join(APP, 'js', 'voice', 'tts-processor.js'));
    const prevMuted = global.__ttsMuted;
    try {
        global.__ttsMuted = true;   // 只测队列捕获，不触网/不合成
        rs.reset();
        const proc = new EnhancedTextProcessor('http://127.0.0.1:1/tts', () => {}, () => {}, () => {},
            { tts: { resume_after_interrupt: true } });
        proc.audioDataQueue.push({ audio: {}, text: '已合成未播A' });
        proc.textSegmentQueue.push('未合成B', '未合成C');
        proc.playbackEngine.currentSegmentText = '正在播的这一句';
        proc.playbackEngine._currentCharIndex = 3;   // 已播「正在播」
        proc.interrupt();
        const pending = rs.peek();
        ok('interrupt 后确实捕获了未播内容', !!pending);
        eq('捕获 3 段（1 个已合成 + 2 个未合成）', pending && pending.segments, 3);
        ok('捕获了当前段的未播尾巴', pending && pending.hasPartial === true);
        eq('打断本身没有被改成「自动播」', rs.stats().taken, 0);
        eq('打断后队列照旧清空（行为未变）', [proc.audioDataQueue.length, proc.textSegmentQueue.length], [0, 0]);
        const captured = rs.take();
        ok('未播尾巴排在重播最前', captured && captured.text.indexOf('的这一句') === 0, captured && captured.text);
        ok('不含当前段已播部分', captured && !captured.text.includes('正在播'));
        ok('含所有未播段', captured && captured.text.includes('已合成未播A') &&
            captured.text.includes('未合成B') && captured.text.includes('未合成C'));
        proc.stop();

        // 开关关闭：interrupt 不捕获
        rs.reset();
        const procOff = new EnhancedTextProcessor('http://127.0.0.1:1/tts', () => {}, () => {}, () => {},
            { tts: { resume_after_interrupt: false } });
        procOff.textSegmentQueue.push('不该被保存');
        procOff.interrupt();
        eq('开关关闭时 interrupt 不捕获', rs.peek(), null);
        procOff.stop();
        rs.setEnabled(true);
    } finally {
        if (prevMuted === undefined) delete global.__ttsMuted;
        else global.__ttsMuted = prevMuted;
    }

    console.log('\n[7b] 真实 submitTurn：显式请求才重播（非显式路径不碰 TTS）');
    const { LLMHandler } = require(path.join(APP, 'js', 'ai', 'llm-handler.js'));
    try {
        rs.reset();
        rs.capture({ segments: ['剩余甲', '剩余乙'] });
        const speaks = [];
        const fakeTts = {
            isPlaying: () => false,
            processTextToSpeech: (t) => { speaks.push(String(t)); return Promise.resolve(); },
        };
        const send = LLMHandler.createEnhancedSendToLLM({ messages: [] }, fakeTts, false,
            { llm: {}, tts: { resume_after_interrupt: true } });
        const reply = await send('接着说');
        ok('submitTurn 返回续讲文本', String(reply).includes('剩余甲') && String(reply).includes('剩余乙'));
        eq('submitTurn → TTS 只调一次', speaks.length, 1);
        ok('submitTurn → TTS 文本含剩余两段', speaks[0].includes('剩余甲') && speaks[0].includes('剩余乙'));
        eq('submitTurn → take 一次', rs.stats().taken, 1);
        ok('submitTurn 会结算 TTL（beginTurn 已执行）', rs.stats().turnsStarted >= 1);

        // 她正在播：submitTurn 吞下这句，不打断、不重播、不消费
        rs.reset();
        rs.capture({ segments: ['旧捕获'] });
        const playingTts = {
            isPlaying: () => true,
            processTextToSpeech: () => { speaks.push('不该出现'); return Promise.resolve(); },
        };
        const send2 = LLMHandler.createEnhancedSendToLLM({ messages: [] }, playingTts, false,
            { llm: {}, tts: { resume_after_interrupt: true } });
        const r2 = await send2('接着说');
        eq('正在播时 submitTurn 返回空串', r2, '');
        eq('正在播时不调 TTS', speaks.length, 1);
        eq('正在播时不消费捕获', rs.stats().taken, 0);
        ok('正在播时仍结算了 TTL', rs.stats().turnsStarted === 1, String(rs.stats().turnsStarted));
    } catch (e) {
        fail += 1;
        console.error('  ✗ submitTurn 集成测试异常：' + (e && e.stack || e));
    }

    console.log('\n[8] 静态接线检查（宿主不启动也能证明接上了）');
    const ttsSrc = fs.readFileSync(path.join(APP, 'js', 'voice', 'tts-processor.js'), 'utf8');
    const llmSrc = fs.readFileSync(path.join(APP, 'js', 'ai', 'llm-handler.js'), 'utf8');
    const playSrc = fs.readFileSync(path.join(APP, 'js', 'voice', 'tts-playback-engine.js'), 'utf8');
    const resumeSrc = fs.readFileSync(MOD, 'utf8');

    const interruptBody = (() => {
        // 2026-11-22：interrupt 现在带可选 opts（reason），签名从 interrupt() 变成 interrupt(opts)。
        // 这里断言的是「函数体里的顺序」，不是签名本身，所以按正则找入口。
        const m = ttsSrc.match(/^ {4}interrupt\([^)]*\)\s*\{/m);
        if (!m) return '';
        const start = m.index;
        const next = ttsSrc.indexOf('\n    stop() {', start);
        return next > start ? ttsSrc.slice(start, next) : ttsSrc.slice(start);
    })();
    ok('tts-processor 引入了 resume-speech', /require\(['"]\.\.\/core\/resume-speech(\.js)?['"]\)/.test(ttsSrc));
    ok('interrupt 内调用 captureFromProcessor', /captureFromProcessor\s*\(/.test(interruptBody));
    ok('capture 在清空队列之前', (() => {
        const capAt = interruptBody.indexOf('captureFromProcessor');
        const clearAt = interruptBody.indexOf('this.textSegmentQueue = []');
        return capAt > 0 && clearAt > capAt;
    })(), '先存后清');
    ok('interrupt 用 playbackEngine 取未播尾巴', /getUnplayedCurrentText/.test(interruptBody));
    ok('playback-engine 提供 getUnplayedCurrentText', /getUnplayedCurrentText\s*\(/.test(playSrc));

    ok('llm-handler 引入了 resume-speech', /require\(['"]\.\.\/core\/resume-speech(\.js)?['"]\)/.test(llmSrc));
    const handleCalls = (llmSrc.match(/tryHandleExplicit\s*\(/g) || []).length;
    eq('llm-handler 只有一处 tryHandleExplicit 调用', handleCalls, 1);
    ok('llm-handler 没有直接调用 resumeSpeech.take(', !/resumeSpeech\.take\s*\(/.test(llmSrc));
    ok('llm-handler 在 submitTurn 内先问显式续讲', (() => {
        const at = llmSrc.indexOf('tryHandleExplicit(');
        const sub = llmSrc.indexOf('const submitTurn = function submitTurn');
        const gate = llmSrc.indexOf('turnGate.submit(prompt)', sub);
        return at > sub && gate > at;
    })());
    ok('每轮开始结算 TTL（beginTurn）', /resumeSpeech\.beginTurn\s*\(/.test(llmSrc));
    ok('resume-speech 不含 fs/写盘（TTL 1 轮不落盘）', !/\brequire\(['"]fs['"]\)/.test(resumeSrc));
    ok('resume-speech 未把正文拼进 system', !/system/.test(resumeSrc.replace(/\/\*[\s\S]*?\*\//g, '')));
} catch (e) {
    fail += 1;
    console.error('  ✗ 测试异常：' + (e && e.stack || e));
}

console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
iso.cleanup(tmpRoot);
process.exit(fail ? 1 : 0);
})();
