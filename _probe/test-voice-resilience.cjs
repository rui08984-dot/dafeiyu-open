#!/usr/bin/env node
/**
 * _probe/test-voice-resilience.cjs —— 语音链路「稳、不丢、不互踩」六项根因单测（2026-11-21）
 *
 * 纯 node：不启动 Electron、不连 VAD/ASR/TTS/audio-loop、不出声。
 *   ① VAD WebSocket 自愈：指数退避 1/2/4/8/16/30s、永不永久放弃、startRecording 可重建
 *   ② 附和一致性：260ms 内的短「嗯」既不置 interrupt 标记、也不提交为用户轮（suppressed:true）
 *   ③ 轮次串行化：上一轮未完时新输入排队（≤2），不清空上一轮 TTS 队列；明确「停」才中断
 *   ④ 自听：TTS 开始/结束各 POST 一次 audio-loop /pause（服务不在不炸、不刷日志）
 *   ⑤ 口型同源：带 <emotion:...> 的文本，口型字符索引与字幕用的净化文本一致
 *   ⑥ tts_server 部分失败：全分句失败返回 502 + X-Tts-Failed: all（真实 aiohttp 处理器 + 假 edge_tts）
 *
 * 判定：0 = 全过；非 0 = 有失败。汇总行 "PASS n / FAIL m" 供 check-all 识别。
 */
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const VOICE = path.join(APP, 'js', 'voice');
const PY = 'py';
const TTS_SERVER = path.join(ROOT, 'edge-tts', 'tts_server.py');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 先加载 llm-handler（它自带真实 api-utils 依赖），再把 api-utils 换成记录器，
//    让之后加载的 voice 模块拿到可观测的 logToTerminal。 ─────────────────────
global.window = global.window || {};
global.document = global.document || {
    getElementById: () => null,
    createElement: () => ({ append() { }, appendChild() { }, style: {} }),
};

const logs = [];
function logged(lvlOrRe, maybeRe) {
    const re = maybeRe || lvlOrRe;
    return logs.some((l) => re.test(l.message));
}

const llmHandlerPath = path.join(APP, 'js', 'ai', 'llm-handler.js');
const llmHandler = require(llmHandlerPath);

const apiUtilsPath = require.resolve(path.join(APP, 'js', 'api-utils.js'));
require.cache[apiUtilsPath] = {
    id: apiUtilsPath, filename: apiUtilsPath, loaded: true,
    exports: {
        logToTerminal(level, message) { logs.push({ level, message: String(message) }); },
        appendRuntimeLog() { },
        logToolAction() { },
        getMergedToolsList() { return []; },
    },
};

// ── 假 WebSocket（手动触发 onopen/onclose/onmessage；不连任何端口） ─────────
class FakeWS {
    constructor(url) {
        this.url = url;
        this.readyState = 0;   // CONNECTING
        this.sent = [];
        FakeWS.instances.push(this);
        FakeWS.last = this;
    }
    close() { this.readyState = 3; }
    send(data) { this.sent.push(data); }
    _open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    _close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    _msg(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
}
FakeWS.CONNECTING = 0;
FakeWS.OPEN = 1;
FakeWS.CLOSING = 2;
FakeWS.CLOSED = 3;
FakeWS.instances = [];
FakeWS.last = null;
global.WebSocket = FakeWS;

// ── 定时器捕获（只用于 VAD 段）：记录 delay，手动触发，不真的等 30s ─────────
function installTimerCapture() {
    const realST = global.setTimeout;
    const realCT = global.clearTimeout;
    const timers = [];
    let seq = 0;
    global.setTimeout = function (fn, ms, ...args) {
        const h = { id: ++seq, fn, ms: Number(ms) || 0, args, cancelled: false, done: false, unref() { return this; } };
        timers.push(h);
        return h;
    };
    global.clearTimeout = function (h) {
        if (h && typeof h === 'object' && typeof h.id === 'number') { h.cancelled = true; return; }
        return realCT(h);
    };
    return {
        timers,
        lastPending() {
            for (let i = timers.length - 1; i >= 0; i--) {
                const t = timers[i];
                if (!t.cancelled && !t.done) return t;
            }
            return null;
        },
        runNext() {
            const t = this.lastPending();
            if (!t) return null;
            t.done = true;
            t.fn(...t.args);
            return t;
        },
        restore() { global.setTimeout = realST; global.clearTimeout = realCT; },
    };
}

// ── 假 Audio / AudioContext（播放引擎不真的出声） ──────────────────────────
class FakeAudio {
    constructor(src) {
        this.src = src;
        this.duration = 1.5;
        this.currentTime = 0;
        FakeAudio.last = this;
    }
    play() { if (this.onplay) this.onplay(); return Promise.resolve(); }
    pause() { }
}
global.Audio = FakeAudio;
global.requestAnimationFrame = () => 1;
global.cancelAnimationFrame = () => { };
// Node 24 原生 createObjectURL 只认真 Blob；这里统一换成假 URL（不出声，不需要真解码）
global.URL.createObjectURL = () => 'blob:fake';
global.URL.revokeObjectURL = () => { };

function installFakeAudioContext() {
    global.window = global.window || {};
    global.window.AudioContext = class {
        constructor() { this.currentTime = 0; this.destination = {}; this.sampleRate = 16000; }
        createAnalyser() {
            return {
                fftSize: 256, frequencyBinCount: 128, smoothingTimeConstant: 0.8,
                connect() { },
                getByteTimeDomainData(arr) { if (arr) arr.fill(128); },
                getByteFrequencyData() { },
            };
        }
        createGain() {
            return { gain: { value: 1, setValueAtTime() { }, exponentialRampToValueAtTime() { } }, connect() { } };
        }
        createMediaElementSource() { return { connect() { } }; }
        createMediaStreamSource() { return { connect() { } }; }
        createScriptProcessor() { return { connect() { }, onaudioprocess: null }; }
        close() { }
    };
    global.AudioContext = global.window.AudioContext;
}

console.log = (function (orig) {
    return function (...a) {
        // 被测模块的 console.log 噪音不进测试输出；失败原因一律走 console.error
        const s = a.map(String).join(' ');
        if (/^\s*(VAD|尝试重连|音频处理|语音打断|正常模式|客户端静音|语音合并窗口|TTS处理器|ASR|🎤|🤐|🔓|🔊|\[turn-queue\]|\[asr\]|\[tts\])/.test(s)) return;
        return orig.apply(console, a);
    };
})(console.log);

(async () => {
    const { ASRProcessor } = require(path.join(VOICE, 'asr-processor.js'));
    const { TTSPlaybackEngine } = require(path.join(VOICE, 'tts-playback-engine.js'));
    const { appState } = require(path.join(APP, 'js', 'core', 'app-state.js'));

    // ══ ① VAD 自愈 ═════════════════════════════════════════════════════════
    console.log('\n[①] VAD WebSocket 自愈');
    {
        const cap = installTimerCapture();
        try {
            FakeWS.instances.length = 0;
            const proc = new ASRProcessor('ws://127.0.0.1:1/vad', 'http://127.0.0.1:1/asr', { asr: {} });
            const delays = [];
            for (let i = 0; i < 12; i++) {
                const ws = FakeWS.last;
                ws._close();
                const t = cap.lastPending();
                delays.push(t ? t.ms : null);
                cap.runNext();          // 触发重连 → 新 WebSocket（CONNECTING）
            }
            ok('V1 退避序列 1/2/4/8/16s，之后封顶 30s',
                delays.slice(0, 6).join(',') === '1000,2000,4000,8000,16000,30000'
                && delays.slice(6).every((d) => d === 30000),
                delays.join(','));
            ok('V2 关闭 12 次后仍在重连（不永久放弃）',
                FakeWS.instances.length === 13 && FakeWS.last.readyState === 0,
                'sockets=' + FakeWS.instances.length + ' readyState=' + FakeWS.last.readyState);
            ok('V3 断开期间 vadDownSince 有值、vadReconnects=0',
                typeof proc.vadDownSince === 'number' && proc.vadReconnects === 0,
                'downSince=' + proc.vadDownSince + ' reconnects=' + proc.vadReconnects);
            ok('V4 连续失败 10 次写 runtime.log',
                logged(/VAD 已连续重连 10 次|VAD 连续重连 10 次/),
                JSON.stringify(logs.filter((l) => /VAD/.test(l.message)).slice(-2)));

            // 连通成功 → 计数清零 + vadReconnects 递增 + vadDownSince 清空
            FakeWS.last._open();
            ok('V5 重连成功清零并计数',
                proc.retryCount === 0 && proc.vadReconnects >= 1 && proc.vadDownSince === null,
                'retry=' + proc.retryCount + ' reconnects=' + proc.vadReconnects + ' downSince=' + proc.vadDownSince);

            // startRecording 时 WS 已断开 → 必须重建（不等退避定时器）
            FakeWS.last._close();       // 触发重连定时器，但我们不执行它
            const before = FakeWS.instances.length;
            FakeWS.last.readyState = 3;
            proc.mediaStream = { getTracks: () => [] };
            installFakeAudioContext();
            await proc.startRecording();
            ok('V6 startRecording 会重建不在 OPEN/CONNECTING 的 WS',
                FakeWS.instances.length === before + 1 && FakeWS.last.readyState === 0,
                'sockets=' + FakeWS.instances.length + '/' + before + ' readyState=' + FakeWS.last.readyState);
        } finally {
            cap.restore();
        }
    }

    // ══ ② 附和一致性 ═══════════════════════════════════════════════════════
    console.log('\n[②] 附和判定与提交一致性');
    {
        const cap = installTimerCapture();
        try {
            let interrupts = 0;
            let submitted = 0;
            const proc = new ASRProcessor('ws://127.0.0.1:1/vad', 'http://127.0.0.1:1/asr', {
                asr: { voice_barge_in: true, client_silence_ms: 150 },
            });
            proc.ttsProcessor = { interrupt() { interrupts += 1; } };
            // 让 ws 处于 OPEN，避免 onmessage 前置检查干扰（本段直接调 handleSpeech）
            proc.ws.readyState = 1;
            proc.processRecording = async () => { submitted += 1; };

            // 她正在说话（TTS 播放中），用户「嗯」了一声就停
            appState._state.isPlayingTTS = true;
            proc.isRecording = false;
            proc.asrLocked = false;
            proc.hasInterruptedThisSession = false;
            proc.lastSpeechTime = Date.now() - 320;   // 260ms 判定时，人声已停 320ms
            proc.continuousBuffer = new Float32Array(0);   // 开口那一刻缓冲还是空的
            proc.recordingStartIndex = 0;
            proc.handleSpeech();
            // 开口之后才往缓冲里写入这声「嗯」（0.6s），finishRecording 才算得到真实时长
            proc.continuousBuffer = new Float32Array(Math.floor(proc.SAMPLE_RATE * 0.6));
            // handleSpeech 尾部会把 lastSpeechTime 刷成「开口时刻」；这里模拟那一声
            // 「嗯」已经结束（VAD is_speech:false 已到，服务端心跳不再来）。
            proc.lastSpeechTime = Date.now() - 320;
            proc._vadSpeechEndedAt = Date.now() - 120;   // VAD 权威结束信号
            cap.runNext();                            // 执行 260ms 判定
            ok('A1 短附和不置 hasInterruptedThisSession', proc.hasInterruptedThisSession === false,
                String(proc.hasInterruptedThisSession));
            ok('A2 短附和不触发 tts.interrupt', interrupts === 0, 'interrupts=' + interrupts);
            ok('A3 短附和被标记 suppressed 并计数',
                proc._suppressUtterance === true && proc._suppressedAffirmations === 1,
                'flag=' + proc._suppressUtterance + ' count=' + proc._suppressedAffirmations);

            proc.isRecording = true;
            await proc.finishRecording();
            ok('A4 短附和不提交为用户轮（未调用 processRecording）', submitted === 0, 'submitted=' + submitted);
            ok('A5 抑制留痕（runtime.log 含 suppressed）', logged(/suppressed/i),
                JSON.stringify(logs.filter((l) => /suppressed/i.test(l.message)).slice(-1)));

            // 正常短句：TTS 不在播 → 不该被抑制
            appState._state.isPlayingTTS = false;
            proc.hasInterruptedThisSession = false;
            proc._suppressUtterance = false;
            proc.isRecording = false;
            proc.lastSpeechTime = Date.now();
            proc.continuousBuffer = new Float32Array(Math.floor(proc.SAMPLE_RATE * 0.8));
            proc.recordingStartIndex = 0;
            proc.handleSpeech();
            cap.runNext();
            proc.isRecording = true;
            await proc.finishRecording();
            ok('A6 正常短句仍照常提交为一轮', submitted === 1,
                'submitted=' + submitted + ' suppressFlag=' + proc._suppressUtterance);

            // 续说护栏：260ms 判定像附和，但随后麦克风又实测到人声 → 不能吞掉这句
            submitted = 0;
            proc.asrLocked = false;
            proc.hasInterruptedThisSession = false;
            proc._suppressUtterance = true;
            proc._vadSpeechEndedAt = Date.now() - 200;
            proc._lastVoicedAt = Date.now() - 20;
            proc.isRecording = true;
            proc.continuousBuffer = new Float32Array(proc.SAMPLE_RATE);   // 1s
            proc.recordingStartIndex = 0;
            await proc.finishRecording();
            ok('A7 判定后又说 → 撤销抑制、照常提交',
                submitted === 1 && proc._affirmationRescued === 1,
                'submitted=' + submitted + ' rescued=' + proc._affirmationRescued);
        } finally {
            cap.restore();
        }
    }

    // ══ ③ 轮次串行化 ═══════════════════════════════════════════════════════
    console.log('\n[③] 两轮并发串行化');
    {
        ok('Q0 llm-handler 导出 createTurnGate', typeof llmHandler.createTurnGate === 'function');

        if (typeof llmHandler.createTurnGate === 'function') {
            const events = [];
            let releaseFirst;
            const firstGate = new Promise((r) => { releaseFirst = r; });
            let n = 0;
            const gate = llmHandler.createTurnGate({
                maxQueue: 2,
                log(level, msg) { events.push({ level, msg }); },
                runTurn: async (prompt) => {
                    n += 1;
                    events.push({ phase: 'start', prompt, n });
                    if (n === 1) await firstGate;
                    events.push({ phase: 'end', prompt, n });
                    return 'reply:' + prompt;
                },
            });
            const p1 = gate.submit('第一句');
            await sleep(5);
            const p2 = gate.submit('第二句');
            const r2 = await p2;
            ok('Q1 第二句立即返回空串（不阻塞 ASR 解锁）', r2 === '',
                JSON.stringify(r2));
            ok('Q2 第二句排队中，第一轮仍在跑',
                events.filter((e) => e.phase === 'start').length === 1
                && gate.stats().pending === 1,
                JSON.stringify(gate.stats()));
            ok('Q3 排队不计入「已开始」，也未被 reset',
                events.filter((e) => e.phase === 'start').length === 1,
                events.filter((e) => e.phase === 'start').map((e) => e.prompt).join('|'));

            releaseFirst();
            const r1 = await p1;
            await sleep(10);
            const starts = events.filter((e) => e.phase === 'start').map((e) => e.prompt);
            ok('Q4 第一轮结束后才启动第二轮（顺序不变）',
                starts.join('|') === '第一句|第二句', starts.join('|'));
            ok('Q5 第一轮回复未被第二轮覆盖', r1 === 'reply:第一句', JSON.stringify(r1));

            // 队列满（2）→ 丢弃最旧
            let releaseBlock;
            const block = new Promise((r) => { releaseBlock = r; });
            let k = 0;
            const gate2 = llmHandler.createTurnGate({
                maxQueue: 2,
                log(level, msg) { events.push({ level, msg }); },
                runTurn: async (prompt) => { k += 1; if (k === 1) await block; return prompt; },
            });
            gate2.submit('A');
            await sleep(2);
            gate2.submit('B');
            gate2.submit('C');
            gate2.submit('D');        // 队列 [B,C] 已满 → 丢 B，收 D
            const st = gate2.stats();
            ok('Q6 队列满丢弃最旧并计数', st.dropped === 1 && st.pending === 2,
                JSON.stringify(st) + ' pendingTexts=' + JSON.stringify(gate2.pendingTexts()));
            ok('Q7 丢弃有 warn 日志', events.some((e) => e.level === 'warn' && /丢弃最旧/.test(e.msg)),
                JSON.stringify(events.filter((e) => e.level === 'warn').slice(-2)));
            ok('Q8 队列里留下的是 C/D（最旧 B 被丢）',
                gate2.pendingTexts().join('|') === 'C|D', gate2.pendingTexts().join('|'));

            // 明确「停」：清空排队 + 中断当前
            let interrupted = 0;
            const gate3 = llmHandler.createTurnGate({
                maxQueue: 2,
                log() { },
                interrupt() { interrupted += 1; },
                runTurn: async () => new Promise(() => { }),   // 永不结束
            });
            gate3.submit('讲个长故事');
            await sleep(2);
            gate3.submit('第二句');
            gate3.submit('第三句');
            gate3.submit('停');
            ok('Q9 明确「停」清空排队并中断当前', interrupted === 1 && gate3.stats().cleared === 2,
                JSON.stringify(gate3.stats()) + ' interrupted=' + interrupted);
            releaseBlock();

            // 抢话中断（TTS_INTERRUPTED → isInterrupted）不得吞掉排队输入：
            // 那句是用户刚说的，只能排队等，不能被当成「停」丢掉。
            let releaseTurn;
            const turnBlocker = new Promise((r) => { releaseTurn = r; });
            const started4 = [];
            const flag = { interrupted: false };
            const gate4 = llmHandler.createTurnGate({
                maxQueue: 2,
                log() { },
                isInterrupted: () => flag.interrupted,
                clearInterrupted: () => { flag.interrupted = false; },
                runTurn: async (p) => { started4.push(p); if (p === '首轮') await turnBlocker; return p; },
            });
            gate4.submit('首轮');
            await sleep(2);
            gate4.submit('抢话那句');
            flag.interrupted = true;      // 模拟 asr-processor 打断 TTS
            releaseTurn();
            await sleep(30);
            ok('Q10 打断信号不丢排队输入（抢话那句仍执行）',
                started4.join('|') === '首轮|抢话那句', started4.join('|'));
        }
    }

    // ══ ④ audio-loop /pause 接线 ═══════════════════════════════════════════
    console.log('\n[④] 自听：TTS 播放期间暂停剧集回环');
    {
        installFakeAudioContext();
        const realFetch = global.fetch;
        const calls = [];
        global.fetch = async (url, opts) => {
            calls.push({ url: String(url), body: JSON.parse((opts && opts.body) || '{}') });
            return { ok: true, status: 200 };
        };
        try {
            const engine = new TTSPlaybackEngine({ subtitle_labels: { ai: 'Fen' } }, () => { }, () => { }, () => { });
            const p = engine.playAudio({ fake: 1 }, '你好呀。');
            await sleep(10);
            ok('P1 播放开始 → POST /pause {on:true}',
                calls.length === 1 && /\/pause$/.test(calls[0].url) && calls[0].body.on === true,
                JSON.stringify(calls));
            engine.stop();
            await p.catch(() => { });
            await sleep(20);
            ok('P2 停止/打断 → POST /pause {on:false}（各一次）',
                calls.length === 2 && calls[1].body.on === false,
                JSON.stringify(calls));

            // 服务不在：不抛错、不刷日志
            global.fetch = async () => { throw new Error('ECONNREFUSED'); };
            const before = logs.length;
            const e2 = new TTSPlaybackEngine({ subtitle_labels: { ai: 'Fen' } }, () => { }, () => { }, () => { });
            const p2 = e2.playAudio({ fake: 1 }, '还在吗。');
            await sleep(10);
            e2.stop();
            await p2.catch(() => { });
            await sleep(20);
            ok('P3 audio-loop 不在时不抛错、日志不刷屏', logs.length - before <= 1,
                'newLogs=' + (logs.length - before));
        } finally {
            global.fetch = realFetch;
        }
    }

    // ══ ⑤ 口型与字幕同源 ═══════════════════════════════════════════════════
    console.log('\n[⑤] viseme 与字幕共用净化文本');
    {
        installFakeAudioContext();
        const engine = new TTSPlaybackEngine({ subtitle_labels: { ai: 'Fen' } }, () => { }, () => { }, () => { });
        // 情绪映射器：净化后返回纯文本（真实 emotion-engine 的 stripTags 行为）
        engine.setEmotionMapper({
            prepareTextForTTS(text) {
                return { text: String(text).replace(/<[^>]+>/g, ''), emotionMarkers: [] };
            },
        });
        const raw = '<emotion:开心>你好，今天真开心。';
        const processed = '你好，今天真开心。';
        const p = engine.playAudio({ fake: 1 }, raw);
        await sleep(10);
        ok('S1 currentSegmentText 存净化文本', engine.currentSegmentText === processed,
            JSON.stringify(engine.currentSegmentText));
        ok('S2 不再是原始标签文本', engine.currentSegmentText !== raw);
        const r0 = engine._visemeCharAt ? engine._visemeCharAt(0, 1.5) : null;
        ok('S3 口型索引落在净化文本上（与字幕同源）',
            !!r0 && r0.text === processed && typeof r0.index === 'number'
            && processed[r0.index] === r0.ch && r0.ch === '你',
            JSON.stringify(r0) + ' rawIndexOfYou=' + raw.indexOf('你'));
        const rMid = engine._visemeCharAt ? engine._visemeCharAt(1.0, 1.5) : null;
        ok('S4 句中索引仍对齐净化文本（标点不参与发音序但不动下标基准）',
            !!rMid && processed[rMid.index] === rMid.ch && rMid.index > 0
            && !/[，。！？、；：]/.test(rMid.ch || ''),
            JSON.stringify(rMid));
        engine.stop();
        await p.catch(() => { });
    }

    // ══ ⑥ tts_server 全失败 ════════════════════════════════════════════════
    console.log('\n[⑥] tts_server 全分句失败 → 502');
    {
        const snippet = `
import asyncio, sys
sys.path.insert(0, r'${path.dirname(TTS_SERVER)}')
from aiohttp import web
from aiohttp.test_utils import TestServer, TestClient
import edge_tts, tts_server

class Boom:
    def __init__(self, *a, **k): pass
    async def stream(self):
        raise RuntimeError('synthetic edge failure')
        yield  # pragma: no cover

class Good:
    def __init__(self, *a, **k): pass
    async def stream(self):
        yield {'type': 'audio', 'data': b'ID3fake'}

async def run_case(communicate, mode):
    edge_tts.Communicate = communicate
    app = web.Application()
    app['voice'] = 'zh-CN-XiaoyiNeural'
    app.router.add_post('/tts', tts_server.tts)
    async with TestClient(TestServer(app)) as client:
        r = await client.post('/tts', json={'text': '你好。今天天气不错。'})
        body = await r.read()
        return r.status, dict(r.headers), body

async def main():
    status, headers, body = await run_case(Boom, 'boom')
    assert status == 502, f'全失败应 502，实际 {status}'
    assert (headers.get('X-Tts-Failed') or '').lower() == 'all', f'缺 X-Tts-Failed=all：{headers}'
    assert body and len(body) > 0, '全失败不能是 0 字节 200'
    ok_status, ok_headers, ok_body = await run_case(Good, 'ok')
    assert ok_status == 200, f'正常路径应 200，实际 {ok_status}'
    assert ok_body == b'ID3fake' * 2, f'正常路径音频字节不应被改写：{ok_body!r}'
    print('TTSSERVER_ALL_FAILED_502_OK')

asyncio.run(main())
`;
        const r = spawnSync(PY, ['-I', '-c', snippet], { encoding: 'utf-8', timeout: 60000 });
        const out = (r.stdout || '') + (r.stderr || '');
        ok('T1 全分句失败返回 502 + X-Tts-Failed: all，正常路径仍 200',
            r.status === 0 && /TTSSERVER_ALL_FAILED_502_OK/.test(out),
            'exit=' + r.status + ' ' + out.split('\n').filter(Boolean).slice(-3).join(' | '));
    }

    console.log('\nPASS ' + pass + ' / FAIL ' + fail);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('测试自身异常：', (e && e.stack) || e);
    process.exit(2);
});
