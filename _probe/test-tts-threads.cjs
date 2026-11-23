#!/usr/bin/env node
/**
 * _probe/test-tts-threads.cjs —— TTS 处理/播放线程代数 + playAudio 契约 + 在途看门狗（2026-11-21）
 *
 * 纯 node：不启动 Electron、不连 9883、不出声。假时钟 + 假播放器/假请求器加载**真实的**
 * `live-2d/js/voice/tts-processor.js`，另用真实 TTSPlaybackEngine / TTSRequestHandler 的
 * 早退路径验证返回契约与合成超时。
 *
 * 覆盖三个已定位缺陷：
 *   A. 处理线程被播放线程判死：构造器先起处理线程、再起播放线程；两条线程共用一个代数，
 *      后起的播放线程 +1 后，处理线程下一拍发现 token 过期就自退（只有看门狗每 2s 能挤一段）。
 *   B. playAudio 早退路径返回 undefined / 裸 resolve()，playNext 裸读 result.completed
 *      → TypeError → 播放线程不再排下一拍（抢话后永久静音）。
 *   C. 看门狗 pending 只数两个队列，不数 isProcessing 的在途段 → 合成卡死时永远判「没活」。
 *   D. 合成 fetch 无总超时（本测用假 fetch + 真实 request handler 验证 AbortController 超时）。
 *
 * 判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const path = require('node:path');

const APP = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const VOICE = path.join(APP, 'js', 'voice');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}

// ── 日志捕获：把 api-utils 换成记录器（必须在 require tts-processor 之前） ─────
const logs = [];
const apiUtilsPath = require.resolve(path.join(APP, 'js', 'api-utils.js'));
require.cache[apiUtilsPath] = {
    id: apiUtilsPath, filename: apiUtilsPath, loaded: true,
    exports: {
        logToTerminal(level, message) { logs.push({ level, message: String(message) }); },
        appendRuntimeLog() { },
        logToolAction() { },
    },
};
function logged(re) { return logs.some((l) => re.test(l.message)); }

// ── 假时钟 ─────────────────────────────────────────────────────────────────
// tts-processor 用全局 setTimeout/setInterval/unref。假时钟只替换这四个，
// Date.now 保持真实（看门狗「停摆」用 _lastProgressAt 直接做旧来触发）。
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;

function createClock() {
    let now = 0;
    let seq = 0;
    const timers = new Map();
    const mk = (ms) => ({ id: 0, at: 0, every: 0, fn: null, args: [], unref() { return this; }, ref() { return this; } });
    const clock = {
        get now() { return now; },
        setTimeout(fn, ms, ...args) {
            const h = mk(ms); h.id = ++seq; h.at = now + Math.max(0, Number(ms) || 0); h.fn = fn; h.args = args;
            timers.set(h.id, h); return h;
        },
        setInterval(fn, ms, ...args) {
            const h = mk(ms); h.id = ++seq; const every = Math.max(1, Number(ms) || 1);
            h.at = now + every; h.every = every; h.fn = fn; h.args = args;
            timers.set(h.id, h); return h;
        },
        clearTimeout(h) { if (h && h.id) timers.delete(h.id); },
        clearInterval(h) { if (h && h.id) timers.delete(h.id); },
        pending() { return timers.size; },
        async advance(ms) {
            const target = now + ms;
            let guard = 0;
            for (;;) {
                let next = null;
                for (const t of timers.values()) {
                    if (t.at > target) continue;
                    if (!next || t.at < next.at || (t.at === next.at && t.id < next.id)) next = t;
                }
                if (!next) break;
                if (++guard > 50000) throw new Error('假时钟定时器风暴（>50000 次）');
                now = next.at;
                if (next.every) next.at = now + next.every; else timers.delete(next.id);
                try { next.fn(...next.args); } catch (e) { /* 被测代码的异常由断言看 */ }
                // 让出真实 macrotask：把本轮产生的微任务（await 续体）全部跑完
                await new Promise((r) => realSetTimeout(r, 0));
            }
            now = target;
        },
        uninstall() {
            global.setTimeout = realSetTimeout;
            global.clearTimeout = realClearTimeout;
            global.setInterval = realSetInterval;
            global.clearInterval = realClearInterval;
        },
    };
    global.setTimeout = clock.setTimeout;
    global.clearTimeout = clock.clearTimeout;
    global.setInterval = clock.setInterval;
    global.clearInterval = clock.clearInterval;
    return clock;
}

const clock = createClock();

// unhandledRejection 不能把测试进程直接带走（修复前 playNext 抛 TypeError 正是缺陷信号）
const rejections = [];
process.on('unhandledRejection', (e) => rejections.push(e));

// ── 真实模块（在打桩前抓引用） ──────────────────────────────────────────────
const realPlayback = require(path.join(VOICE, 'tts-playback-engine.js'));
const realRequest = require(path.join(VOICE, 'tts-request-handler.js'));

// ── 假播放器 / 假请求器：替换模块缓存，让真实 tts-processor 用它们 ──────────
class FakePlaybackEngine {
    constructor(config, onAudioDataCallback, onStartCallback, onEndCallback) {
        this.config = config;
        this.onAudioDataCallback = onAudioDataCallback;
        this.onStartCallback = onStartCallback;
        this.onEndCallback = onEndCallback;
        this.expressionMapper = null;
        this.isPlaying = false;
        this.played = [];
        this._script = [];       // 每段的返回值；'throw' 表示抛异常
        FakePlaybackEngine.last = this;
    }
    setEmotionMapper(m) { this.emotionMapper = m; }
    setExpressionMapper(m) { this.expressionMapper = m; }
    getPlayingState() { return this.isPlaying; }
    async playAudio(audio, text) {
        this.played.push(text);
        const step = this._script.length ? this._script.shift() : { status: 'completed', completed: true };
        if (step === 'throw') throw new Error('playAudio 内部炸了');
        return step;
    }
    stop() { this.isPlaying = false; }
}

class FakeRequestHandler {
    constructor(config, ttsUrl) {
        this.config = config;
        this.ttsUrl = ttsUrl;
        this.volcTtsEnabled = false;
        this.mode = 'ok';
        FakeRequestHandler.last = this;
    }
    getPendingSegment() { return ''; }
    abortAllRequests() { }
    reset() { }
    convertTextToSpeech(text) {
        if (this.mode === 'hang') return new Promise(() => { });   // 永不返回
        return Promise.resolve({ __fakeAudio: true, text });
    }
}

const pbPath = require.resolve(path.join(VOICE, 'tts-playback-engine.js'));
const rhPath = require.resolve(path.join(VOICE, 'tts-request-handler.js'));
require.cache[pbPath] = {
    id: pbPath, filename: pbPath, loaded: true,
    exports: { TTSPlaybackEngine: FakePlaybackEngine },
};
require.cache[rhPath] = {
    id: rhPath, filename: rhPath, loaded: true,
    exports: { TTSRequestHandler: FakeRequestHandler, TTSStreamHandle: realRequest.TTSStreamHandle },
};

const { EnhancedTextProcessor } = require(path.join(VOICE, 'tts-processor.js'));

function newProcessor() {
    return new EnhancedTextProcessor('http://127.0.0.1:1/tts', () => { }, () => { }, () => { }, { tts: {} });
}
function stopWatchdog(proc) {
    if (proc._watchdogTimer) { clock.clearInterval(proc._watchdogTimer); proc._watchdogTimer = null; }
}

(async () => {
    // ══ A. 线程代数：处理线程不得被播放线程的启动判死 ═══════════════════════
    console.log('\n[A] 线程代数分离');
    {
        const proc = newProcessor();
        stopWatchdog(proc);   // 隔离看门狗：本组只测主循环是否活着（<2s，看门狗本来也不会响）
        proc.textSegmentQueue.push('第一句，你好。');
        proc._kickProc();
        await clock.advance(300);
        ok('A1 构造后处理线程仍存活（新段被消费并播放）',
            proc.textSegmentQueue.length === 0 && FakePlaybackEngine.last.played.length === 1,
            'queue=' + proc.textSegmentQueue.length + ' played=' + FakePlaybackEngine.last.played.length
            + ' token=' + JSON.stringify({ proc: proc._procToken, play: proc._playToken, legacy: proc._threadToken }));

        // 单独再起一条播放线程（等价于看门狗「只重启播放」）→ 处理线程必须不受影响
        FakePlaybackEngine.last.played.length = 0;
        proc.startPlaybackThread();
        proc.textSegmentQueue.push('第二句，仍然要说。');
        proc._kickProc();
        await clock.advance(300);
        ok('A2 重启播放线程后处理线程仍存活',
            proc.textSegmentQueue.length === 0 && FakePlaybackEngine.last.played.length === 1,
            'queue=' + proc.textSegmentQueue.length + ' played=' + FakePlaybackEngine.last.played.length);

        // 反向：重启处理线程不得让播放线程自退（处理新段 + 播放线程仍排下一拍）
        FakePlaybackEngine.last.played.length = 0;
        proc.startProcessingThread();
        proc.audioDataQueue.push({ audio: { fake: 1 }, text: '第三句。' });
        await clock.advance(200);
        ok('A3 重启处理线程后播放线程仍存活', FakePlaybackEngine.last.played.length === 1,
            'played=' + FakePlaybackEngine.last.played.length);
        proc.shouldStop = true;
    }

    // ══ B. playAudio 返回契约（真实播放引擎的早退路径） ════════════════════
    console.log('\n[B] playAudio 返回契约');
    const isResult = (r) => !!r && typeof r === 'object' && typeof r.status === 'string';
    {
        global.window = {
            AudioContext: class {
                constructor() { this.destination = {}; }
                createAnalyser() {
                    return {
                        fftSize: 256, frequencyBinCount: 128, smoothingTimeConstant: 0.8,
                        connect() { }, getByteTimeDomainData() { }, getByteFrequencyData() { },
                    };
                }
                createGain() { return { gain: { value: 1 }, connect() { } }; }
                createMediaElementSource() { return { connect() { } }; }
            },
        };
        const engine = new realPlayback.TTSPlaybackEngine({}, () => { }, () => { }, () => { });

        const rNull = await engine.playAudio(null, '空音频');
        ok('B1 无音频 → 返回对象 status=skipped', isResult(rNull) && rNull.status === 'skipped',
            JSON.stringify(rNull));

        engine.shouldStop = true;    // 抢话后 interrupt() 只 stop()，shouldStop 留到下一轮 reset
        const rStopped = await engine.playAudio({ fake: 1 }, '抢话后的一段');
        ok('B2 已停止 → 返回对象 status=stopped（不再是 undefined）',
            isResult(rStopped) && rStopped.status === 'stopped', JSON.stringify(rStopped));
        engine.shouldStop = false;

        const zeroByte = {
            __ttsStream: true, cancelled: false,
            waitFirstChunk: async () => { throw new Error('首块超时'); },
            toBlob: async () => null,
        };
        const rEmpty = await engine.playAudio(zeroByte, '0字节200');
        ok('B3 0 字节流 → 返回对象 status=error/skipped',
            isResult(rEmpty) && ['error', 'skipped', 'stopped'].includes(rEmpty.status), JSON.stringify(rEmpty));

        ok('B4 兼容字段 completed=status==="completed"',
            !!rNull && rNull.completed === false
            && !!rStopped && rStopped.completed === false
            && !!rEmpty && rEmpty.completed === false,
            JSON.stringify([rNull && rNull.completed, rStopped && rStopped.completed, rEmpty && rEmpty.completed]));
    }

    // ══ C. playNext 对每段结果兜底：undefined / 抛异常都要排下一拍 ═══════════
    console.log('\n[C] playNext 结果兜底');
    {
        const proc = newProcessor();
        stopWatchdog(proc);
        const pb = FakePlaybackEngine.last;
        pb._script = [undefined, 'throw', { status: 'completed', completed: true }];
        proc.audioDataQueue.push({ audio: 1, text: '一' });
        proc.audioDataQueue.push({ audio: 2, text: '二' });
        proc.audioDataQueue.push({ audio: 3, text: '三' });
        await clock.advance(300);
        ok('C1 单段返回 undefined / 抛异常后播放线程仍继续（3 段全排到）',
            pb.played.length === 3 && proc.audioDataQueue.length === 0,
            'played=' + pb.played.length + ' queue=' + proc.audioDataQueue.length
            + ' rejections=' + rejections.length);
        ok('C2 异常被记录进 runtime.log（不是静默）', logged(/playAudio|播放线程|播放段/),
            JSON.stringify(logs.slice(-4)));
        proc.shouldStop = true;
    }

    // ══ D. 看门狗 pending 计入在途段 ═══════════════════════════════════════
    console.log('\n[D] 看门狗在途计数');
    {
        // D0：真实在途（段已 shift、合成永不返回）
        const proc = newProcessor();
        stopWatchdog(proc);
        FakeRequestHandler.last.mode = 'hang';
        proc.textSegmentQueue.push('永远合成不完的句子。');
        proc._kickProc();
        await clock.advance(100);
        ok('D0 段已被 shift、isProcessing=true（在途）',
            proc.textSegmentQueue.length === 0 && proc.isProcessing === true,
            'queue=' + proc.textSegmentQueue.length + ' isProcessing=' + proc.isProcessing);
        proc.shouldStop = true;

        // D1/D2：隔离测 pending 公式 —— 只留「在途」，两个队列都空。
        //   修复前 pending = 0 + 0 = 0 → 永远判「没活」；修复后 = 0 + 1 → 卡死并重启。
        const wd = newProcessor();
        wd.isProcessing = true;         // 等价于：段已被 shift，fetch 挂住
        wd.textSegmentQueue = [];
        wd.audioDataQueue = [];
        const restartsBefore = wd._stallRestarts || 0;
        wd._lastProgressAt = Date.now() - 5000;   // 让「停摆 > 4s」成立
        await clock.advance(2100);                // 跨过一个看门狗周期（2s）
        ok('D1 在途段计入 pending → 看门狗判定卡死并重启',
            (wd._stallRestarts || 0) > restartsBefore,
            'restarts=' + (wd._stallRestarts || 0) + '（队列 0 + 在途 1 应为 pending=1）');
        ok('D2 卡死告警写入 logToTerminal（runtime.log 可见）', logged(/卡死/),
            JSON.stringify(logs.filter((l) => /卡死/.test(l.message)).slice(-2)));
        wd.shouldStop = true;
    }

    // ══ E. 合成总超时（真实 request handler + 假 fetch） ═══════════════════
    console.log('\n[E] 合成总超时');
    {
        clock.uninstall();   // 这一组要真实时间
        const realFetch = global.fetch;
        let aborted = 0;
        global.fetch = (url, opts) => new Promise((resolve, reject) => {
            const sig = opts && opts.signal;
            if (sig) {
                sig.addEventListener('abort', () => {
                    aborted += 1;
                    const err = new Error('The operation was aborted');
                    err.name = 'AbortError';
                    reject(err);
                }, { once: true });
            }
            // 永不返回（模拟 Edge 卡住）
        });
        try {
            const rh = new realRequest.TTSRequestHandler(
                { tts: { backend: 'edge', synth_timeout_ms: 150 } }, 'http://127.0.0.1:1/tts');
            const t0 = Date.now();
            let out = 'PENDING';
            let terr = null;
            try {
                // 护栏：修复前 fetch 永不返回、进程会「没活可干」静默退出（假通过），
                // 这里用真实计时器拖住事件循环，把「没有总超时」变成一条明确的失败。
                const guard = new Promise((_, reject) => {
                    realSetTimeout(() => reject(new Error('SYNTH_HANG')), 1500);
                });
                out = await Promise.race([rh.convertTextToSpeech('你好，这是一句测试。'), guard]);
            } catch (e) { terr = e; }
            const dt = Date.now() - t0;
            ok('E1 合成卡住 → 本段失败返回 null（不整轮卡死）',
                out === null && !terr, terr ? terr.message : 'out=' + JSON.stringify(out));
            ok('E2 超时按配置触发（150ms 量级）', !terr && dt >= 120 && dt < 1200, 'dt=' + dt + 'ms');
            ok('E3 超时真正 abort 了 fetch', aborted === 1, 'aborted=' + aborted);
            ok('E4 超时写 runtime.log（warn）', logged(/合成超时|超时/),
                JSON.stringify(logs.filter((l) => /超时/.test(l.message)).slice(-2)));
        } finally {
            global.fetch = realFetch;
        }
    }

    // ── 汇总 ────────────────────────────────────────────────────────────────
    console.log('\nPASS ' + pass + ' / FAIL ' + fail);
    if (rejections.length) console.log('（过程内 unhandledRejection ' + rejections.length + ' 次：'
        + rejections.map((e) => String(e && e.message || e)).slice(0, 3).join(' | ') + '）');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('测试自身异常：', e && e.stack || e);
    process.exit(2);
});
