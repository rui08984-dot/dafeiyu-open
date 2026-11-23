#!/usr/bin/env node
/**
 * _probe/test-tts-stream.cjs —— 首段真流式播放单测（改造 2，2026-11-20）
 *
 * 测的是「字节流 → 按序 append → 首块即播 → 可打断 → 兼容性回退」这条链，
 * 不启动 Electron、不连 9883：fetch 与 MediaSource/SourceBuffer 都是本文件里的假实现。
 *
 * 断言：
 *   ① 分块被按序 append（不丢、不乱序）
 *   ② 首块 append 完成后 attach 即返回（剩余块还在路上也能开始播放）
 *   ③ MediaSource 不支持 audio/mpeg → convertTextToSpeech 回退整段 Blob，且发声
 *   ④ 中途 cancel/打断 → reader 被取消、SourceBuffer 被移除、之后不再 append
 *   ⑤ 回退 Blob 由「已收块 + 剩余块」按原序拼成
 *
 * 判定：0 = 全过；非 0 = 有失败（check-all 认退出码与 "PASS n / FAIL m" 汇总）
 */
'use strict';

const path = require('node:path');

const APP = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const { TTSRequestHandler, TTSStreamHandle } = require(path.join(APP, 'js', 'voice', 'tts-request-handler.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
    'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const u8 = (...xs) => Uint8Array.from(xs);

// ── 假可读流：pauseAfter 指定「第几条 read 前卡住」，用来证明 attach 不等整段 ──
function makeChunkReader(chunks, pauseAfter = Infinity) {
    let i = 0;
    let gateResolve = null;
    let gatePromise = null;
    const reader = {
        reads: 0,
        cancelled: false,
        released: false,
        cancelReason: '',
        openGate() { if (gateResolve) { gateResolve(); gateResolve = null; } },
        async read() {
            reader.reads += 1;
            if (i >= chunks.length) return { done: true, value: undefined };
            if (i === pauseAfter) {
                if (!gatePromise) gatePromise = new Promise((resolve) => { gateResolve = resolve; });
                await gatePromise;
            }
            return { done: false, value: chunks[i++] };
        },
        async cancel(reason) { reader.cancelled = true; reader.cancelReason = String(reason || ''); },
        releaseLock() { reader.released = true; },
    };
    return reader;
}

// ── 假 MediaSource / SourceBuffer：appendBuffer 异步触发 updateend ──
function makeFakeMediaSource() {
    const sb = {
        mime: '',
        updating: false,
        appended: [],
        aborted: false,
        _ls: {},
        addEventListener(type, fn) { (this._ls[type] = this._ls[type] || []).push(fn); },
        removeEventListener(type, fn) {
            const arr = this._ls[type] || [];
            const at = arr.indexOf(fn);
            if (at >= 0) arr.splice(at, 1);
        },
        appendBuffer(chunk) {
            this.appended.push(chunk);
            this.updating = true;
            setTimeout(() => { this.updating = false; this._emit('updateend'); }, 1);
        },
        abort() { this.aborted = true; },
        _emit(type) { for (const fn of (this._ls[type] || []).slice()) fn(); },
    };
    const ms = {
        readyState: 'open',
        removed: [],
        ended: 0,
        _sb: null,
        addSourceBuffer(mime) { sb.mime = mime; this._sb = sb; return sb; },
        removeSourceBuffer(x) { this.removed.push(x); },
        endOfStream() { this.ended += 1; },
    };
    return { ms, sb };
}

function makeResponse(chunks, reader) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (k) => String(k).toLowerCase() === 'content-type' ? 'audio/mpeg' : null },
        body: { getReader: () => reader },
        blob() { return new Blob(chunks, { type: 'audio/mpeg' }); },
    };
}

function makeHandler(extraTts = {}) {
    return new TTSRequestHandler({
        tts: { enabled: true, backend: 'edge', language: 'zh', speed_factor: 1, stream_first_segment: true, ...extraTts },
        api_gateway: { use_gateway: false },
    }, 'http://127.0.0.1:9883/tts');
}

(async () => {
    const realFetch = global.fetch;
    const realMediaSource = global.MediaSource;

    // ── 1. 按序 append + 首块到达即返回/即播 + 收流 endOfStream ─────────────
    {
        const chunks = [u8(1, 2), u8(3, 4), u8(5, 6)];
        const reader = makeChunkReader(chunks, 1);   // 第一条返回后卡住第二条
        const handle = new TTSStreamHandle(makeResponse(chunks, reader), { mimeType: 'audio/mpeg', log: () => { } });
        const first = await handle.waitFirstChunk();
        ok('首块按原样返回', first === chunks[0]);

        const { ms, sb } = makeFakeMediaSource();
        let playedAtAppendedCount = -1;
        const fakeAudio = { play() { playedAtAppendedCount = sb.appended.length; } };
        await handle.attach(ms, fakeAudio);

        ok('首块 append 完成后 attach 即返回（不等整段）', sb.appended.length === 1 && sb.appended[0] === chunks[0]);
        ok('后台泵已在等第二块（未阻塞 attach）', reader.reads === 2, 'reads=' + reader.reads);
        fakeAudio.play();
        eq('首块到达即开始播放', playedAtAppendedCount, 1);

        reader.openGate();
        await handle.waitForPump();
        eq('分块按序 append', sb.appended.map((c) => Array.from(c)), [[1, 2], [3, 4], [5, 6]]);
        ok('收流后 endOfStream', ms.ended >= 1);
        ok('SourceBuffer mime 正确', sb.mime === 'audio/mpeg');
    }

    // ── 2. 中途打断：释放 reader + 移除 SourceBuffer，之后不再 append ──────
    {
        const chunks = [u8(9, 9), u8(8, 8), u8(7, 7)];
        const reader = makeChunkReader(chunks, 1);
        const handle = new TTSStreamHandle(makeResponse(chunks, reader), { mimeType: 'audio/mpeg', log: () => { } });
        await handle.waitFirstChunk();
        const { ms, sb } = makeFakeMediaSource();
        await handle.attach(ms, null);
        const appendedBeforeCancel = sb.appended.length;

        handle.cancel('interrupt');
        ok('cancel 后 reader 被取消', reader.cancelled === true);
        ok('cancel 后 reader 释放锁', reader.released === true);
        ok('cancel 后 SourceBuffer 被移除', ms.removed.includes(sb) && handle.sourceBuffer === null);

        reader.openGate();
        await handle.waitForPump();
        await tick();
        eq('cancel 后不再 append', sb.appended.length, appendedBeforeCancel);
    }

    // ── 3. 回退 Blob：已收块 + 剩余块按原序拼成完整 MP3 ─────────────────────
    {
        const chunks = [u8(10), u8(20), u8(30)];
        const reader = makeChunkReader(chunks);
        const handle = new TTSStreamHandle(makeResponse(chunks, reader), { mimeType: 'audio/mpeg', log: () => { } });
        await handle.waitFirstChunk();                 // 已消费第 1 块，模拟 attach 前失败
        const blob = await handle.toBlob();
        const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
        eq('回退 Blob 字节完整且有序', bytes, [10, 20, 30]);
        eq('回退 Blob 类型', blob.type, 'audio/mpeg');
    }

    // ── 3b. 首块超时 → 回退 Blob，且「挂在流上的那次 read」不丢块、不乱序 ──
    {
        const chunks = [u8(11), u8(22), u8(33)];
        const reader = makeChunkReader(chunks, 0);   // 第一次 read 就卡住，模拟首块超时
        const handle = new TTSStreamHandle(makeResponse(chunks, reader), {
            mimeType: 'audio/mpeg', firstChunkTimeoutMs: 30, log: () => { },
        });
        let timeoutErr = null;
        try { await handle.waitFirstChunk(); }
        catch (e) { timeoutErr = e; }
        ok('首块超时抛错并标记 isTimeout', !!timeoutErr && timeoutErr.isTimeout === true && /首块超时/.test(timeoutErr.message));
        reader.openGate();
        const blob = await handle.toBlob();
        const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
        eq('超时回退 Blob 仍按序完整（已收块+剩余块）', bytes, [11, 22, 33]);
    }

    // ── 4. 走真实 convertTextToSpeech：首段句柄、后续段 Blob、MSE 不支持回退 ──
    {
        const handler = makeHandler();
        const chunks = [u8(1, 1), u8(2, 2), u8(3, 3)];
        let served = 0;
        global.fetch = async () => {
            served += 1;
            return makeResponse(chunks, makeChunkReader(chunks));
        };

        // 4a. 支持 MSE：首段返回流句柄
        global.MediaSource = { isTypeSupported: (m) => m === 'audio/mpeg' };
        const firstRes = await handler.convertTextToSpeech('你好呀。');
        ok('首段返回流句柄（__ttsStream）', !!(firstRes && firstRes.__ttsStream), String(firstRes && firstRes.constructor && firstRes.constructor.name));
        if (firstRes && firstRes.__ttsStream) {
            const { ms, sb } = makeFakeMediaSource();
            await firstRes.waitFirstChunk();
            await firstRes.attach(ms, null);
            await firstRes.waitForPump();
            eq('首段句柄按序 append', sb.appended.map((c) => Array.from(c)), [[1, 1], [2, 2], [3, 3]]);
        }

        // 4b. 同一轮第二段：保持现状，仍旧整段 Blob
        const secondRes = await handler.convertTextToSpeech('第二句。');
        ok('后续段仍返回 Blob（回归面最小）', secondRes instanceof Blob);
        eq('后续段没有重复走流式判定', served, 2);

        // 4c. 新一轮 + MediaSource 不支持：回退 Blob 并打日志
        handler.reset();
        global.MediaSource = undefined;
        const warns = [];
        const origWarn = console.warn;
        console.warn = (...a) => warns.push(a.map(String).join(' '));
        let fallbackRes = null;
        try { fallbackRes = await handler.convertTextToSpeech('回退测试。'); }
        finally { console.warn = origWarn; }
        ok('MSE 不支持时回退整段 Blob', fallbackRes instanceof Blob);
        if (fallbackRes instanceof Blob) {
            const bytes = Array.from(new Uint8Array(await fallbackRes.arrayBuffer()));
            eq('回退 Blob 字节完整', bytes, [1, 1, 2, 2, 3, 3]);
        }
        ok('回退必须发声（[tts] stream 回退）', warns.some((w) => w.includes('[tts] stream 回退:')), warns.join(' | ').slice(0, 200));
    }

    // ── 5. 开关 false：直接整段 Blob（不被兼容性逻辑影响）────────────────ー
    {
        const handler = makeHandler({ stream_first_segment: false });
        const chunks = [u8(4, 4), u8(5, 5)];
        global.MediaSource = { isTypeSupported: () => true };
        global.fetch = async () => makeResponse(chunks, makeChunkReader(chunks));
        const res = await handler.convertTextToSpeech('开关关闭。');
        ok('stream_first_segment=false 直接整段 Blob', res instanceof Blob);
    }

    global.fetch = realFetch;
    if (realMediaSource === undefined) delete global.MediaSource;
    else global.MediaSource = realMediaSource;

    // 不用 process.exit()：Windows 管道下它会截断还没 flush 的 stdout（门禁解析不到汇总）。
    console.log(`PASS ${pass} / FAIL ${fail}`);
    process.exitCode = fail ? 1 : 0;
})().catch((e) => {
    console.error('单测异常：' + (e && e.stack || e));
    console.log(`PASS ${pass} / FAIL ${fail + 1}`);
    process.exitCode = 1;
});
