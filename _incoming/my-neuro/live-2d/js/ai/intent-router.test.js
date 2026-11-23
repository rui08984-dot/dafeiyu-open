// intent-router.test.js —— 意图路由单测（node js/ai/intent-router.test.js 直接跑）
'use strict';
const assert = require('assert');
const { classifyIntent, classifyIntentLocal, shouldOmitTools } = require('./intent-router.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realFetch = global.fetch;

const CFG = { llm: { intent_router: { timeout_ms: 800 } } };
// 嵌入 mock：全同向量 → 余弦全等 → margin 0 → 快通道放弃，落慢通道
const FLAT_EMBED = { ok: true, json: async () => ({ data: Array.from({ length: 12 }, () => ({ embedding: [1, 0] })) }) };
// 嵌入 mock（正交向量版）：样例 4chat=[1,0,0]、4tool=[0,1,0]、3memory=[0,0,1]，输入=tool 向量
// → tool avg 0.25、其余 0 → 果断 tool
const CHAT_V = [1, 0, 0], TOOL_V = [0, 1, 0], MEM_V = [0, 0, 1];
const TOOL_EMBED = {
    ok: true,
    json: async () => ({ data: [CHAT_V, CHAT_V, CHAT_V, CHAT_V, TOOL_V, TOOL_V, TOOL_V, TOOL_V, MEM_V, MEM_V, MEM_V, TOOL_V].map((embedding) => ({ embedding })) }),
};

function genResponder(payload) {
    return async (url) => {
        if (String(url).includes('/v1/embeddings')) return FLAT_EMBED;
        return { ok: true, json: async () => payload };
    };
}

(async () => {
    let pass = 0;
    const ok = (name) => { pass += 1; console.log('  ✅', name); };

    try {
        // 1. 嵌入快通道命中：输入向量与 tool 样例一致 → 直接 tool，不走慢通道
        {
            let generateCalled = 0;
            global.fetch = async (url) => {
                if (String(url).includes('/v1/embeddings')) return TOOL_EMBED;
                generateCalled += 1;
                return { ok: true, json: async () => ({ response: '{"intent":"chat","confidence":0.9}' }) };
            };
            const r = await classifyIntent('帮我把音量调小一点', CFG);
            assert.strictEqual(r.intent, 'tool');
            assert.strictEqual(r.via, 'embed', '应由嵌入快通道判定');
            assert.strictEqual(generateCalled, 0, '快通道命中就不该打慢通道');
            ok('嵌入快通道命中（~30ms 不吃 GPU 生成）');
        }

        // 2. 快通道分不开 → 慢通道正常解析
        {
            global.fetch = genResponder({ response: '{"intent":"tool","confidence":0.9}' });
            const r = await classifyIntent('把音量调小', CFG);
            assert.strictEqual(r.intent, 'tool');
            assert.strictEqual(r.confidence, 0.9);
            ok('快通道放弃 → 慢通道兜住');
        }

        // 3. 慢通道吐怪东西：unknown 兜底
        {
            global.fetch = genResponder({ response: '{"intent":"dance","confidence":0.99}' });
            const r = await classifyIntent('随便什么', CFG);
            assert.strictEqual(r.intent, 'unknown', '未知意图必须回落 unknown');
            ok('怪意图 → unknown 兜底');
        }

        // 4. 双通道全挂：unknown + 双退避
        {
            global.fetch = async () => { throw new Error('conn refused'); };
            const r1 = await classifyIntent('测试双挂', CFG);
            assert.strictEqual(r1.intent, 'unknown');
            const r2 = await classifyIntent('退避期内', CFG);
            assert.strictEqual(r2.intent, 'unknown');
            ok('双通道全挂 → unknown（全量工具不受影响）');
        }

        // 5. shouldOmitTools：只有 chat 且置信过线才省
        {
            assert.ok(shouldOmitTools({ intent: 'chat', confidence: 0.9 }, CFG), 'chat 高置信 → 省工具');
            assert.ok(!shouldOmitTools({ intent: 'chat', confidence: 0.6 }, CFG), 'chat 低置信 → 不省');
            assert.ok(!shouldOmitTools({ intent: 'tool', confidence: 0.9 }, CFG), 'tool → 不省');
            assert.ok(!shouldOmitTools({ intent: 'unknown', confidence: 0 }, CFG), 'unknown → 不省');
            ok('省工具判据（chat ∧ 置信≥0.85）');
        }

        // 6. 开关与空文本：直接跳过不发请求
        {
            let called = 0;
            global.fetch = async () => { called += 1; return { ok: true, json: async () => ({ response: '{}' }) }; };
            await classifyIntent('hi', { llm: { intent_router: { enabled: false } } });
            await classifyIntent('', CFG);
            await classifyIntent('x'.repeat(501), CFG);
            assert.strictEqual(called, 0, '禁用/空文本/超长文本都不该发请求');
            ok('开关/空文本/超长 → 零请求');
        }

        // 7. 慢通道超时：AbortSignal 真掐断（尊重 signal 的 mock）
        {
            global.fetch = (url, opts) => {
                if (String(url).includes('/v1/embeddings')) return FLAT_EMBED;
                return new Promise((resolve, reject) => {
                    const t = setTimeout(() => resolve({ ok: true, json: async () => ({ response: '{}' }) }), 5000);
                    opts.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
                });
            };
            const r = await classifyIntent('测试超时', CFG);
            assert.strictEqual(r.intent, 'unknown', '超时回落 unknown');
            assert.ok(r.ms < 3500, 'AbortSignal 真把 5s mock 掐断在 2.5s 附近');
            ok('慢通道超时 → unknown + 退避');
        }

        // 8. ⚡ 零延迟本地分类器（2026-11-08 性能重做：主链只跑这个，永不 await 网络）
        {
            const cases = [
                ['今天好累啊', 'chat'], ['陪我聊聊天吧', 'chat'], ['在干嘛呢', 'chat'],
                ['哈哈哈哈笑死我了', 'chat'], ['你要不要摸摸我', 'chat'],
                ['帮我把音量调小', 'tool'], ['看看桌面上开着哪些窗口', 'tool'],
                ['帮我截个屏', 'tool'], ['打开记事本', 'tool'], ['打开一下设置', 'tool'],
                ['还记得我的猫叫什么吗', 'memory'], ['我们上次聊了什么', 'memory'],
            ];
            for (const [text, want] of cases) {
                assert.strictEqual(classifyIntentLocal(text).intent, want, '本地判定：' + text);
            }
            // 性能契约：微秒级（1000 次 < 50ms = 零延迟级）
            const lc0 = Date.now();
            for (let i = 0; i < 1000; i++) classifyIntentLocal('今天好累啊随便聊聊');
            const lcost = Date.now() - lc0;
            assert.ok(lcost < 50, '1000 次本地判定应 <50ms，实际 ' + lcost + 'ms');
            ok('零延迟本地分类器（12 例全对 + 1000 次 ' + lcost + 'ms）');
        }

        console.log(`\nintent-router.test.js：${pass}/8 全过`);
        process.exit(0);
    } catch (e) {
        console.error('❌ 测试失败:', e.message);
        process.exit(1);
    } finally {
        global.fetch = realFetch;
    }
})();
