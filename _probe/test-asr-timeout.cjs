// _probe/test-asr-timeout.cjs —— ASR fetch 超时解锁（2026-11-20 审计 P1-3）
//
// 复现过的 bug：ASR 服务接受连接但迟迟不回 → fetch 永不结束 → asrLocked 永久 true，
// 之后所有语音被 `if (this.asrLocked) return` 吞掉，用户只能重启宿主。
//
// 做法：起一个「只收不回」的本地 HTTP 服务，直接调 ASRProcessor.processRecording，
// 断言：超时返回 null、asrLocked=false、isRecording=false、日志里有 [asr] fetch timeout。
'use strict';

const http = require('http');
const path = require('path');

const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
// 构造函数会 fire-and-forget 调 setupAudioSystem() 连 VAD WebSocket；单测不需要真连，
// 用最小桩顶掉全局 WebSocket，避免重连 5 次把测试拖到 7s+ 并刷屏。
class FakeWS {
    constructor() { this.readyState = 0; }
    close() { this.readyState = 3; }
    send() {}
}
FakeWS.OPEN = 1;
FakeWS.CLOSED = 3;
const origWS = global.WebSocket;
global.WebSocket = FakeWS;
const { ASRProcessor } = require(path.join(LIVE, 'js', 'voice', 'asr-processor.js'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass++; return; }
    fail++;
    failures.push(name + (detail ? '：' + detail : ''));
}

(async () => {
    // ① 半死服务：接受请求、永不响应
    const sockets = new Set();
    const hang = http.createServer((req) => { req.resume(); /* 故意不 res.end() */ });
    hang.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise((r) => hang.listen(0, '127.0.0.1', r));
    const port = hang.address().port;

    const errors = [];
    const origError = console.error;
    const origLog = console.log;
    console.log = () => {};
    console.error = (...a) => { errors.push(a.map(String).join(' ')); };

    try {
        const p = new ASRProcessor('ws://127.0.0.1:1/vad', 'http://127.0.0.1:' + port + '/asr', { asr: { timeout_ms: 2000 } });
        p.asrLocked = true;       // 模拟 finishRecording 已锁
        p.isRecording = true;     // 模拟录音状态（超时后必须释放）
        const blob = new Blob([Buffer.from([0, 0, 0, 0])], { type: 'audio/wav' });
        const t0 = Date.now();
        const r = await p.processRecording(blob);
        const dt = Date.now() - t0;

        ok('超时后返回 null（不挂死）', r === null);
        ok('超时后 asrLocked 已解锁', p.asrLocked === false);
        ok('超时后 isRecording 已释放', p.isRecording === false);
        ok('耗时落在配置超时附近（' + dt + 'ms）', dt >= 1500 && dt < 5000);
        ok('日志有 [asr] fetch timeout', errors.some((e) => /\[asr\] fetch timeout/.test(e)));

        // ② 服务正常但返回 500：同样必须解锁
        const bad = http.createServer((req, res) => { req.resume(); res.writeHead(500); res.end('boom'); });
        await new Promise((r2) => bad.listen(0, '127.0.0.1', r2));
        const p2 = new ASRProcessor('ws://127.0.0.1:1/vad', 'http://127.0.0.1:' + bad.address().port + '/asr', { asr: { timeout_ms: 2000 } });
        p2.asrLocked = true;
        const r2 = await p2.processRecording(blob);
        ok('HTTP 500 → 返回 null', r2 === null);
        ok('HTTP 500 → 解锁', p2.asrLocked === false);
        bad.closeAllConnections();
        bad.close();

        // ③ 配置缺省时不报错（默认 8s，不在这里等满，只断言可构造）
        const p3 = new ASRProcessor('ws://127.0.0.1:1/vad', 'http://127.0.0.1:1/asr', {});
        ok('无 timeout_ms 配置也能构造', p3 instanceof ASRProcessor);
    } finally {
        console.log = origLog;
        console.error = origError;
        global.WebSocket = origWS;
        for (const s of sockets) { try { s.destroy(); } catch (e) {} }
        hang.close();
    }

    if (fail) {
        console.error('❌ ASR 超时解锁：FAIL ' + fail + ' / PASS ' + pass);
        for (const f of failures) console.error('   - ' + f);
        process.exit(1);
    }
    console.log('  ✅ ASR 超时解锁：PASS ' + pass + ' / FAIL 0');
})().catch((e) => {
    console.error('❌ ASR 超时测试异常：' + ((e && e.stack) || e));
    process.exit(1);
});
