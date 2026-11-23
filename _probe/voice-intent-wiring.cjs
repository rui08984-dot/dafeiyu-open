#!/usr/bin/env node
/**
 * _probe/voice-intent-wiring.cjs —— B5 四态门在 asr-processor 里的接线（2026-11-23）
 *
 * 被测：`live-2d/js/voice/asr-processor.js`
 *   · 开关关闭（默认）→ 行为与旧实现一致：260ms 判定后立刻 interrupt；文本不过门
 *   · 开关打开 → 260ms 先推迟打断，等 ASR 文本四态判定：
 *       backchannel/noise → 不打断、不提交为对话轮、只记 _stats.backchannelSkipped
 *       barge_in/turn_take → 打断并提交
 *       文本迟迟不来 → 兜底超时仍然打断（绝不让用户无法抢话）
 *       PTT → 永不过门（明确意图）
 *
 * 纯 node：假 WebSocket / 假 fetch / 假时钟 / 假 TTS，不碰 Electron、不出声、不连任何端口。
 * 判定：0 = 全过；非 0 = 有失败。汇总行 "PASS n / FAIL m" 供 check-all 识别。
 */
'use strict';

const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const VOICE = path.join(APP, 'js', 'voice');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}

// ── 环境桩（必须在 require asr-processor 之前）────────────────────────────
global.window = global.window || {};

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

// 被测模块的 console 噪音不进测试输出；失败原因一律走 console.error
console.log = (function (orig) {
    return function (...a) {
        const s = a.map(String).join(' ');
        if (/^(VAD|尝试重连|音频处理|语音打断|正常模式|客户端静音|TTS处理器|ASR|🎤|🤐|🔓|🔊|语音 backchannel|使用本地ASR|使用网关ASR|用户说|PTT:|\[asr\])/.test(s)) return;
        return orig.apply(console, a);
    };
})(console.log);

class FakeWS {
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        FakeWS.last = this;
    }
    close() { this.readyState = 3; }
    send(data) { this.sent.push(data); }
    _open() { this.readyState = 1; if (this.onopen) this.onopen(); }
}
FakeWS.CONNECTING = 0;
FakeWS.OPEN = 1;
FakeWS.CLOSING = 2;
FakeWS.CLOSED = 3;
FakeWS.last = null;
global.WebSocket = FakeWS;

// 假时钟：只替换 setTimeout/clearTimeout，手动触发；Date.now 保持真实（gap 判据要用）
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
let timers = [];
let timerSeq = 0;
function installTimerCapture() {
    timers = [];
    global.setTimeout = function (fn, ms, ...args) {
        const h = { id: ++timerSeq, fn, ms: Number(ms) || 0, args, cancelled: false, done: false,
            unref() { return this; }, ref() { return this; } };
        timers.push(h);
        return h;
    };
    global.clearTimeout = function (h) {
        if (h && typeof h === 'object' && typeof h.id === 'number') { h.cancelled = true; return; }
        return realClearTimeout(h);
    };
}
function restoreTimer() { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; }
function lastPending(pred) {
    for (let i = timers.length - 1; i >= 0; i--) {
        const t = timers[i];
        if (t.cancelled || t.done) continue;
        if (pred && !pred(t)) continue;
        return t;
    }
    return null;
}
function runPending(ms) {
    const t = lastPending((x) => (ms == null ? true : x.ms === ms));
    if (!t) return null;
    t.done = true;
    t.fn(...t.args);
    return t;
}
/** 段间清场：上一段遗留的兜底定时器不能干扰下一段的 lastPending 查询。 */
function drainTimers() {
    for (const t of timers) t.cancelled = true;
    timers.length = 0;
}

// 假 fetch：按队列返回 ASR 结果
let fetchQueue = [];
let fetchCalls = 0;
global.fetch = async () => {
    fetchCalls += 1;
    const text = fetchQueue.length ? fetchQueue.shift() : '';
    return { ok: true, status: 200, json: async () => ({ status: 'success', text }) };
};

const { ASRProcessor } = require(path.join(VOICE, 'asr-processor.js'));
const { appState } = require(path.join(APP, 'js', 'core', 'app-state.js'));

const VAD = 'ws://127.0.0.1:1/vad';
const ASR = 'http://127.0.0.1:1/asr';
const PLAYING = (v) => { appState._state.isPlayingTTS = v === true; };

function makeProc(voiceCfg, opts = {}) {
    const cfg = {
        asr: { voice_barge_in: true, client_silence_ms: 150 },
        ...(voiceCfg ? { voice: voiceCfg } : {}),
    };
    const proc = new ASRProcessor(VAD, ASR, cfg);
    proc.interrupts = 0;
    proc.ttsProcessor = {
        llmFullResponse: opts.ttsText || '',
        interrupt() { proc.interrupts += 1; },
        isPlaying: () => appState.isPlayingTTS(),
    };
    proc.submitted = [];
    proc.onSpeechRecognized = (t) => proc.submitted.push(t);
    proc.isRecording = true;
    proc.asrLocked = false;
    proc.hasInterruptedThisSession = false;
    proc.continuousBuffer = new Float32Array(proc.SAMPLE_RATE);
    proc.recordingStartIndex = 0;
    // 让 ws 处于 OPEN，避免 onmessage 前置检查干扰
    if (proc.ws) proc.ws.readyState = 1;
    return proc;
}

/** 走一遍真实 processRecording：假 fetch 返回 text。 */
async function submit(proc, text, audioMs = 1000) {
    fetchQueue.push(text);
    const bytes = 44 + Math.round(proc.SAMPLE_RATE * (audioMs / 1000)) * 2;
    const blob = new Blob([new Uint8Array(bytes)]);
    proc.isRecording = true;
    const out = await proc.processRecording(blob);
    return out;
}

(async () => {
    installTimerCapture();
    try {
        // ══ ① 开关关闭：零行为变化 ═══════════════════════════════════════════
        console.log('\n[①] 开关关闭（默认）');
        {
            const proc = makeProc(null);
            ok('O1 无 voice 配置 → 门关闭', proc._backchannelGate === false);
            PLAYING(true);
            ok('O2 门关闭时「嗯」照常放行（旧行为：提交）',
                proc._gateRecognizedText('嗯') === true && proc.submitted.length === 0);
            ok('O3 门关闭时不计数', proc._stats.backchannelSkipped === 0);
            ok('O4 门关闭时噪音文本也放行（不做任何过滤）',
                proc._gateRecognizedText('。。。') === true && proc._gateRecognizedText('') === true);

            // 260ms 路径：仍然是「判定为真打断 → 立刻 interrupt」
            proc.hasInterruptedThisSession = false;
            proc._bargeCheckActive = false;
            proc.isRecording = false;
            proc._speechSessionId += 1;
            proc.lastSpeechTime = Date.now();
            proc.handleSpeech();
            const t = runPending(260);
            ok('O5 门关闭：260ms 后立刻打断（旧路径不变）',
                Boolean(t) && proc.interrupts === 1 && proc.hasInterruptedThisSession === true,
                'timer=' + Boolean(t) + ' interrupts=' + proc.interrupts);
            ok('O6 门关闭：不产生待定打断状态',
                proc._deferredBarge === null && proc._stats.deferredInterrupts === 0);
        }

        // ══ ② 配置解析 ═══════════════════════════════════════════════════════
        console.log('\n[②] 配置解析');
        {
            const near = new ASRProcessor(VAD, ASR, { asr: {}, voice: { duplex: { backchannel_gate: 'true' } } });
            ok('C1 非严格 true（字符串）→ 关闭', near._backchannelGate === false);
            const bad = new ASRProcessor(VAD, ASR, { asr: {}, voice: { duplex: false } });
            ok('C2 duplex 结构非法 → 关闭（不抛）', bad._backchannelGate === false);
            const on = new ASRProcessor(VAD, ASR, {
                asr: {}, voice: { duplex: { backchannel_gate: true, noise_confidence_threshold: 0.9 } },
            });
            ok('C3 backchannel_gate:true → 开启', on._backchannelGate === true);
            ok('C4 阈值被读入', on._noiseConfidenceThreshold === 0.9, String(on._noiseConfidenceThreshold));
            const badTh = new ASRProcessor(VAD, ASR, {
                asr: {}, voice: { duplex: { backchannel_gate: true, noise_confidence_threshold: 7 } },
            });
            ok('C5 非法阈值回落 0.35', badTh._noiseConfidenceThreshold === 0.35);
        }

        // ══ ③ 开关打开：260ms 推迟 + 文本判定 ═════════════════════════════════
        console.log('\n[③] 开关打开：附和不再打断');
        {
            const proc = makeProc({ duplex: { backchannel_gate: true } });
            PLAYING(true);
            proc.hasInterruptedThisSession = false;
            proc._bargeCheckActive = false;
            proc.isRecording = false;
            proc._speechSessionId += 1;
            proc.lastSpeechTime = Date.now();
            proc.handleSpeech();
            const fired260 = runPending(260);
            const deferTimer = lastPending((x) => x.ms === proc._bargeDeferTimeoutMs);
            ok('W1 260ms 到了仍不打断（改为待定）',
                Boolean(fired260) && proc.interrupts === 0 && proc._deferredBarge !== null,
                'interrupts=' + proc.interrupts + ' deferred=' + JSON.stringify(proc._deferredBarge));
            ok('W2 计数 deferredInterrupts=1', proc._stats.deferredInterrupts === 1);
            ok('W3 兜底定时器已排（' + proc._bargeDeferTimeoutMs + 'ms）', Boolean(deferTimer));

            const kept = proc._gateRecognizedText('嗯');
            ok('W4 文本「嗯」→ 不放行（不提交为用户轮）', kept === false);
            ok('W5 文本「嗯」→ 不打断她', proc.interrupts === 0, 'interrupts=' + proc.interrupts);
            ok('W6 计数 backchannelSkipped=1', proc._stats.backchannelSkipped === 1);
            ok('W7 待定状态已清、兜底定时器已取消',
                proc._deferredBarge === null && (deferTimer.cancelled === true || deferTimer.done === true),
                'cancelled=' + deferTimer.cancelled + ' done=' + deferTimer.done);
            ok('W8 判定原因可观测', proc._stats.lastGateReason === 'backchannel:backchannel',
                proc._stats.lastGateReason);

            // 再一声「对」：计数累加
            ok('W9 第二声「对」继续被抑制且计数=2',
                proc._gateRecognizedText('对') === false && proc._stats.backchannelSkipped === 2);
            ok('W10 留痕（runtime.log 含 backchannel 门）', logged(/backchannel 门/),
                JSON.stringify(logs.filter((l) => /backchannel 门/.test(l.message)).slice(-1)));

            // 心跳每 200ms 会再进 handleSpeech：同一句不能重复推迟（否则无限顺延 + 计数虚高）
            const proc2 = makeProc({ duplex: { backchannel_gate: true } });
            PLAYING(true);
            proc2.hasInterruptedThisSession = false;
            proc2._bargeCheckActive = false;
            proc2.isRecording = false;
            proc2._speechSessionId += 1;
            proc2.lastSpeechTime = Date.now();
            proc2.handleSpeech();
            runPending(260);
            const before = proc2._stats.deferredInterrupts;
            proc2.lastSpeechTime = Date.now();
            proc2.handleSpeech();                 // 心跳再来一次
            runPending(260);
            ok('W11 同一句重复心跳不重复推迟、只保留一个兜底定时器',
                proc2._stats.deferredInterrupts === before && before === 1
                && timers.filter((x) => x.ms === proc2._bargeDeferTimeoutMs && !x.cancelled && !x.done).length === 1,
                'deferred=' + proc2._stats.deferredInterrupts
                + ' timers=' + timers.filter((x) => x.ms === proc2._bargeDeferTimeoutMs && !x.cancelled && !x.done).length);
            drainTimers();   // 这一段留下的兜底定时器不能干扰后面按 ms 查定时器的断言
        }

        // ══ ④ 端到端：processRecording 不送对话链 ════════════════════════════
        console.log('\n[④] processRecording：文本确实没进对话链');
        {
            const proc = makeProc({ duplex: { backchannel_gate: true } });
            PLAYING(true);
            proc.asrLocked = true;
            const out = await submit(proc, '嗯', 500);
            ok('E1 返回 null（当次没有识别文本产出）', out === null, JSON.stringify(out));
            ok('E2 onSpeechRecognized 未被调用', proc.submitted.length === 0, JSON.stringify(proc.submitted));
            ok('E3 不打断', proc.interrupts === 0);
            ok('E4 ASR 已解锁（不会永久静音）', proc.asrLocked === false);
            ok('E5 只有一次 fetch（说明真的送过 ASR，不是提前短路）', fetchCalls >= 1, 'fetches=' + fetchCalls);
        }

        // ══ ⑤ 真抢话：barge_in / turn_take 照旧打断并提交 ═════════════════════
        console.log('\n[⑤] 真抢话仍然有效');
        {
            const proc = makeProc({ duplex: { backchannel_gate: true } });
            PLAYING(true);
            const out1 = await submit(proc, '等等，你先别说了', 1200);
            ok('T1 「等等…」→ 打断 1 次',
                proc.interrupts === 1 && proc.hasInterruptedThisSession === true,
                'interrupts=' + proc.interrupts);
            ok('T2 「等等…」→ 正常提交', out1 === '等等，你先别说了' && proc.submitted.length === 1,
                JSON.stringify(proc.submitted));

            proc.interrupts = 0;
            proc.hasInterruptedThisSession = false;
            const out2 = await submit(proc, '我想问一下明天几点出门', 1500);
            ok('T3 完整话语 → 打断并提交',
                proc.interrupts === 1 && out2 === '我想问一下明天几点出门' && proc.submitted.length === 2,
                'interrupts=' + proc.interrupts + ' submitted=' + JSON.stringify(proc.submitted));

            proc.interrupts = 0;
            const out3 = await submit(proc, '。。。', 400);
            ok('T4 纯标点 → 丢弃且不打断', out3 === null && proc.interrupts === 0
                && proc.submitted.length === 2, 'out=' + JSON.stringify(out3));
        }

        // ══ ⑥ 她在问问题：短确认升级为回答 ═══════════════════════════════════
        console.log('\n[⑥] response-intent 门');
        {
            const proc = makeProc({ duplex: { backchannel_gate: true } }, { ttsText: '你想吃点什么吗？' });
            PLAYING(true);
            const out = await submit(proc, '嗯', 500);
            ok('Q1 她问 + 用户「嗯」→ 提交（不被吞）', out === '嗯' && proc.submitted.length === 1,
                JSON.stringify(proc.submitted));
            ok('Q2 她问 + 用户「嗯」→ 打断（用户在回答，可以直接抢）',
                proc.interrupts === 1, 'interrupts=' + proc.interrupts);
            ok('Q3 原因记为 backchannel-answer',
                proc._stats.lastGateReason === 'turn_take:backchannel-answer', proc._stats.lastGateReason);

            // 她没在问 → 同一句「嗯」被抑制
            PLAYING(true);
            const proc2 = makeProc({ duplex: { backchannel_gate: true } }, { ttsText: '我今天看了一部电影。' });
            const out2 = await submit(proc2, '嗯', 500);
            ok('Q4 她没问 + 「嗯」→ 抑制且不打断',
                out2 === null && proc2.interrupts === 0 && proc2.submitted.length === 0);
        }

        // ══ ⑦ 兜底：文本不来仍然能打断 ═══════════════════════════════════════
        console.log('\n[⑦] 推迟兜底');
        {
            const proc = makeProc({ duplex: { backchannel_gate: true } });
            PLAYING(true);
            proc.hasInterruptedThisSession = false;
            proc._bargeCheckActive = false;
            proc.isRecording = false;
            proc._speechSessionId += 1;
            proc.lastSpeechTime = Date.now();
            proc.handleSpeech();
            runPending(260);
            ok('F1 先处于待定（不打断）', proc.interrupts === 0 && proc._deferredBarge !== null);
            const t = runPending(proc._bargeDeferTimeoutMs);
            ok('F2 兜底超时后仍然打断（ASR 挂了也能抢话）',
                Boolean(t) && proc.interrupts === 1 && proc._stats.deferredTimeouts === 1,
                'interrupts=' + proc.interrupts + ' timeouts=' + proc._stats.deferredTimeouts);
            ok('F3 待定状态已清', proc._deferredBarge === null);

            // 文本先到 → 兜底定时器取消，不会再补一次打断
            const proc2 = makeProc({ duplex: { backchannel_gate: true } });
            PLAYING(true);
            proc2.hasInterruptedThisSession = false;
            proc2._bargeCheckActive = false;
            proc2.isRecording = false;
            proc2._speechSessionId += 1;
            proc2.lastSpeechTime = Date.now();
            proc2.handleSpeech();
            runPending(260);
            proc2._gateRecognizedText('好的');
            const late = runPending(proc2._bargeDeferTimeoutMs);
            ok('F4 文本先到 → 兜底定时器已取消（不会二次打断）',
                late === null && proc2.interrupts === 0 && proc2._stats.deferredTimeouts === 0,
                'late=' + Boolean(late) + ' interrupts=' + proc2.interrupts);
        }

        // ══ ⑧ PTT 与降级 ═════════════════════════════════════════════════════
        console.log('\n[⑧] PTT / 未在播 / 阈值');
        {
            const proc = makeProc({ duplex: { backchannel_gate: true } });
            proc.isRecording = false;
            proc.pttStartRecording();
            const pttInterrupts = proc.interrupts;      // PTT 按键本身会 interrupt（旧行为）
            PLAYING(true);
            const out = await submit(proc, '嗯', 500);
            ok('P1 PTT 的「嗯」永不过门（照常提交）', out === '嗯' && proc.submitted.length === 1,
                JSON.stringify(proc.submitted));
            ok('P2 PTT 不额外打断、不计数',
                proc.interrupts === pttInterrupts && proc._stats.backchannelSkipped === 0,
                'interrupts=' + proc.interrupts + '/' + pttInterrupts);

            PLAYING(false);
            const proc2 = makeProc({ duplex: { backchannel_gate: true } });
            const out2 = await submit(proc2, '嗯', 500);
            ok('P3 她没在播 + 「嗯」→ 正常提交（她说完你应一声）',
                out2 === '嗯' && proc2.submitted.length === 1 && proc2.interrupts === 0);

            const proc3 = makeProc({ duplex: { backchannel_gate: true, noise_confidence_threshold: 0.9 } });
            PLAYING(true);
            ok('P4 阈值读进实例（低置信文本由 ASR 侧提供，纯函数测试已覆盖）',
                proc3._noiseConfidenceThreshold === 0.9, String(proc3._noiseConfidenceThreshold));
        }

        // ══ ⑨ stopRecording 清理 ═════════════════════════════════════════════
        console.log('\n[⑨] 停止时清理待定打断');
        {
            const proc = makeProc({ duplex: { backchannel_gate: true } });
            PLAYING(true);
            proc.hasInterruptedThisSession = false;
            proc._bargeCheckActive = false;
            proc.isRecording = false;
            proc._speechSessionId += 1;
            proc.lastSpeechTime = Date.now();
            proc.handleSpeech();
            runPending(260);
            const timer = lastPending((x) => x.ms === proc._bargeDeferTimeoutMs);
            proc.stopRecording();
            ok('X1 stopRecording 清掉待定状态', proc._deferredBarge === null);
            ok('X2 兜底定时器被取消', Boolean(timer) && timer.cancelled === true);
            ok('X3 之后不会补打断', proc.interrupts === 0);
        }
    } finally {
        restoreTimer();
    }

    console.log('\nPASS ' + pass + ' / FAIL ' + fail);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('测试自身异常：', (e && e.stack) || e);
    process.exit(2);
});
