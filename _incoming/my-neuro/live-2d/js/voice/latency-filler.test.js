// latency-filler.test.js —— 快慢双轨垫场器单测（node js/voice/latency-filler.test.js 直接跑）
'use strict';
const assert = require('assert');
const { armLatencyFiller, pickFiller, FILLER_POOL } = require('./latency-filler.js');

// 垫场现在默认关闭（用户实测投诉「每次说话都先让我想想」）——
// 测试必须显式 filler_enabled: true 才走垫场路径。
const CFG = { tts: { enabled: true }, ui: {}, llm: { filler_enabled: true, filler_delay_ms: 600 } };

function fakeTTS(over = {}) {
    return {
        requestHandler: { segmentFullText: (text, q) => q.push(text), volcTtsEnabled: false },
        textSegmentQueue: [],
        isPlaying: () => false,
        ...over,
    };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    let pass = 0;
    const ok = (name) => { pass += 1; console.log('  ✅', name); };

    // 1. 快轨没到：delay 到点后垫场词进分段队列
    {
        const tts = fakeTTS();
        const cancel = armLatencyFiller({ config: CFG, ttsProcessor: tts, hasFirstToken: () => false, isCancelled: () => false });
        await sleep(800);
        cancel();
        assert.strictEqual(tts.textSegmentQueue.length, 1, '垫场词应进队列');
        assert.ok(FILLER_POOL.includes(tts.textSegmentQueue[0]), '垫场词应来自词库');
        assert.ok(!/想|稍等|等等/.test(tts.textSegmentQueue[0]), '垫场词不得含「想/稍等/等等」——那是「她卡住了」的听感');
        ok('无首字 → 垫场词插入分段队列');
    }

    // 2. 快轨已到（首字来了）：不垫
    {
        const tts = fakeTTS();
        const cancel = armLatencyFiller({ config: CFG, ttsProcessor: tts, hasFirstToken: () => true, isCancelled: () => false });
        await sleep(800);
        cancel();
        assert.strictEqual(tts.textSegmentQueue.length, 0, '首字已到不应垫场');
        ok('首字已到 → 撤销垫场');
    }

    // 3. 本轮已打断（isCancelled）：不垫
    {
        const tts = fakeTTS();
        const cancel = armLatencyFiller({ config: CFG, ttsProcessor: tts, hasFirstToken: () => false, isCancelled: () => true });
        await sleep(800);
        cancel();
        assert.strictEqual(tts.textSegmentQueue.length, 0, '已打断不应垫场');
        ok('本轮已打断 → 撤销垫场');
    }

    // 4. 有声音在播（工具播报/上一轮尾巴）：不抢队
    {
        const tts = fakeTTS({ isPlaying: () => true });
        const cancel = armLatencyFiller({ config: CFG, ttsProcessor: tts, hasFirstToken: () => false, isCancelled: () => false });
        await sleep(800);
        cancel();
        assert.strictEqual(tts.textSegmentQueue.length, 0, '忙时不应插播');
        ok('TTS 忙 → 不抢队');
    }

    // 5. 开关与降级路径：filler_enabled=false / tts 关 / 纯文本 / volc —— 全不垫
    {
        const variants = [
            { config: { ...CFG, llm: { filler_enabled: false } }, tts: fakeTTS() },
            { config: { ...CFG, llm: {} }, tts: fakeTTS() },   // 默认关闭
            { config: { ...CFG, llm: { filler_delay_ms: 600 } }, tts: fakeTTS() },
            { config: { ...CFG, tts: { enabled: false } }, tts: fakeTTS() },
            { config: { ...CFG, ui: { text_only_mode: true } }, tts: fakeTTS() },
            { config: CFG, tts: fakeTTS({ requestHandler: { segmentFullText: (t, q) => q.push(t), volcTtsEnabled: true } }) },
            { config: CFG, ttsProcessor: null },
        ];
        for (const v of variants) {
            const cancel = armLatencyFiller({ config: v.config, ttsProcessor: v.tts, hasFirstToken: () => false, isCancelled: () => false });
            await sleep(800);
            cancel();
            const q = v.tts ? v.tts.textSegmentQueue : [];
            assert.strictEqual(q.length, 0, '降级路径不应垫场');
        }
        ok('默认关闭/开关/纯文本/volc/空处理器 → 全部跳过');
    }

    // 6. cancel() 收计时器：delay 前取消就不该响
    {
        const tts = fakeTTS();
        const cancel = armLatencyFiller({ config: CFG, ttsProcessor: tts, hasFirstToken: () => false, isCancelled: () => false });
        cancel();
        await sleep(800);
        assert.strictEqual(tts.textSegmentQueue.length, 0, '取消后不应垫场');
        ok('cancel() → 计时器收掉');
    }

    // 7. delay 下限钳制：填 30ms 也要按 600ms 走（150ms 时不应已响）
    {
        const tts = fakeTTS();
        const cancel = armLatencyFiller({ config: { ...CFG, llm: { filler_enabled: true, filler_delay_ms: 30 } }, ttsProcessor: tts, hasFirstToken: () => false, isCancelled: () => false });
        await sleep(150);
        assert.strictEqual(tts.textSegmentQueue.length, 0, '下限钳制生效，30ms 不该响');
        await sleep(700);
        cancel();
        assert.strictEqual(tts.textSegmentQueue.length, 1, '钳到 600ms 后应正常响');
        ok('filler_delay_ms 下限钳 600ms');
    }

    // 8. 词库轮换：连续两次不重样（recent 窗口保证）
    {
        const seen = [pickFiller(), pickFiller(), pickFiller()];
        assert.notStrictEqual(seen[0], seen[1], '相邻两次不应重复');
        assert.notStrictEqual(seen[1], seen[2], '相邻两次不应重复');
        ok('垫场词轮换（相邻不重样）');
    }

    console.log(`\nlatency-filler.test.js：${pass}/8 全过`);
    process.exit(0);
})().catch((e) => { console.error('❌ 测试失败:', e.message); process.exit(1); });
