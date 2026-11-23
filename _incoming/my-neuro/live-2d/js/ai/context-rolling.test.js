// context-rolling.test.js —— rolling summary 单测（node js/ai/context-rolling.test.js 直接跑）
'use strict';
const assert = require('assert');
const { ContextCompressor } = require('./ContextCompressor.js');

const u = (t) => ({ role: 'user', content: t });
const a = (t) => ({ role: 'assistant', content: t });

function makeFacade(messages) {
    return {
        messages,
        setMessagesCalls: 0,
        conversationCore: { setMessages() { this.setCalls = (this.setCalls || 0) + 1; } },
    };
}
function makeConfig(over = {}) {
    return {
        llm: { api_url: 'http://fake.local/v1', api_key: 'k', model: 'm' },
        context: { rolling_summary: { interval_pairs: 3, keep_recent: 2, ...over } },
    };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    let pass = 0;
    const ok = (name) => { pass += 1; console.log('  ✅', name); };
    let fetchCalls = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
        fetchCalls.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, json: async () => ({ choices: [{ message: { content: '摘要内容' } }] }) };
    };

    try {
        // 1. 对话太短（没凑够保留窗口）：不滚
        {
            const vc = makeFacade([{ role: 'system', content: 'sys' }, u('1'), a('1'), u('2'), a('2'), u('3')]);
            const c = new ContextCompressor(vc, makeConfig());
            await c.checkAndRollAsync();
            assert.strictEqual(fetchCalls.length, 0, '短对话不应触发滚动');
            assert.strictEqual(vc.messages.length, 6, '消息不应被移除');
            ok('短对话 → 不滚动');
        }

        // 2. 超窗满间隔：滚动执行——摘要 system 消息插入、候选移除、近期保留
        {
            fetchCalls = [];
            const msgs = [{ role: 'system', content: 'sys' }];
            for (let i = 1; i <= 6; i++) { msgs.push(u(`消息${i}`), a(`回复${i}`)); }
            const vc = makeFacade(msgs);
            const c = new ContextCompressor(vc, makeConfig());
            await c.checkAndRollAsync();
            assert.strictEqual(fetchCalls.length, 1, '应触发一次摘要调用');
            assert.ok(fetchCalls[0].body.messages[0].content.includes('用户: 消息1'), '摘要输入应含候选内容');
            const digest = vc.messages.find((m) => m.role === 'system' && m.content.startsWith('[历史对话总结]'));
            assert.ok(digest, '应插入滚动摘要 system 消息');
            assert.ok(vc.messages[0].content === 'sys' && vc.messages[1] === digest, '摘要应紧跟初始 system');
            assert.ok(vc.messages.some((m) => m.content === '消息6'), '最新一轮必须保留');
            assert.ok(!vc.messages.some((m) => m.content === '消息1'), '已滚动的候选应被移除');
            assert.strictEqual(vc.messages.length, 6, 'sys + digest + 近期 4 条');
            ok('超窗满间隔 → 摘要插入 + 候选移除 + 近期保留');
        }

        // 3. 第二次滚动：累积合并（previousSummary 进提示词）
        {
            const msgs = [{ role: 'system', content: 'sys' },
                { role: 'system', content: '[历史对话总结] 旧摘要' }];
            for (let i = 1; i <= 8; i++) { msgs.push(u(`新消息${i}`), a(`新回复${i}`)); }
            const vc = makeFacade(msgs);
            const c = new ContextCompressor(vc, makeConfig());
            await c.checkAndRollAsync();
            assert.ok(fetchCalls.at(-1).body.messages[0].content.includes('旧摘要'), '累积摘要应作为基底传入');
            const digest = vc.messages.find((m) => m.content.startsWith('[历史对话总结]'));
            assert.ok(!digest.content.includes('旧摘要') || digest.content.includes('摘要内容'), '摘要应被新结果覆盖');
            assert.strictEqual(vc.messages.filter((m) => m.content.startsWith('[历史对话总结]')).length, 1, '摘要 system 消息恒一条');
            ok('二次滚动 → 累积合并且摘要消息不重复');
        }

        // 4. 工具链边界保护：候选右边界把 tool 划进候选侧，不留孤儿
        {
            const msgs = [{ role: 'system', content: 'sys' }];
            for (let i = 1; i <= 5; i++) { msgs.push(u(`消息${i}`), a(`回复${i}`)); }
            msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: 't1', function: { name: 'x', arguments: '{}' } }] });
            msgs.push({ role: 'tool', content: '结果', tool_call_id: 't1' });
            for (let i = 6; i <= 8; i++) { msgs.push(u(`消息${i}`), a(`回复${i}`)); }
            const vc = makeFacade(msgs);
            const c = new ContextCompressor(vc, makeConfig());
            await c.checkAndRollAsync();
            const firstNonSystem = vc.messages.find((m) => m.role !== 'system');
            assert.notStrictEqual(firstNonSystem.role, 'tool', '净化后不得以孤儿 tool 消息开头');
            assert.ok(vc.messages.every((m) => m.role !== 'tool' || msgs.includes(m)), 'tool 消息要么整体保留要么整体移除');
            ok('工具链边界 → 不产生孤儿 tool 消息');
        }

        // 4.5 批量上限 + 批量起点工具链安全：大 backlog 分批滚，起点不让保留区出现孤儿
        {
            const msgs = [{ role: 'system', content: 'sys' }];
            for (let i = 1; i <= 30; i++) { msgs.push(u(`历史${i}`), a(`回复${i}`)); }
            // 在批量起点附近塞一条工具链，让 batchStart 恰好落在它的 tool 上
            msgs.splice(22, 0,
                { role: 'assistant', content: null, tool_calls: [{ id: 't9', function: { name: 'y', arguments: '{}' } }] },
                { role: 'tool', content: '结果9', tool_call_id: 't9' });
            const vc = makeFacade(msgs);
            const before = msgs.length;                        // msgs 与 vc.messages 同引用，先存原始长度
            const c = new ContextCompressor(vc, makeConfig()); // batch_max 默认 40，改成 15 触发分批
            c.rollingBatchMax = 15;
            await c.checkAndRollAsync();
            assert.ok(fetchCalls.length >= 1, '应触发滚动');
            const kept = vc.messages.filter((m) => m.role !== 'system');
            // 保留区里 assistant+tool_calls 必须紧跟它的 tool 响应（序列合法）
            for (let i = 0; i < kept.length; i++) {
                if (kept[i].tool_calls) {
                    assert.ok(kept[i + 1] && kept[i + 1].role === 'tool' && kept[i + 1].tool_call_id === kept[i].tool_calls[0].id,
                        '保留区的工具链必须完整');
                }
            }
            assert.ok(vc.messages.length < before, '分批滚动后上下文应变小');
            ok('分批滚动 → 批量上限生效且工具链完整');
        }

        // 5. 禁用开关：完全不动作
        {
            fetchCalls = [];
            const msgs = [];
            for (let i = 1; i <= 8; i++) { msgs.push(u(`消息${i}`), a(`回复${i}`)); }
            const vc = makeFacade(msgs);
            const c = new ContextCompressor(vc, makeConfig({ enabled: false }));
            await c.checkAndRollAsync();
            assert.strictEqual(fetchCalls.length, 0, '禁用不应调用');
            assert.strictEqual(vc.messages.length, 16, '消息不应被移除');
            ok('enabled=false → 完全跳过');
        }

        // 6. 摘要 LLM 失败：消息保留不丢（下轮重新规划）
        {
            fetchCalls = [];
            global.fetch = async () => ({ ok: false, status: 500 });
            const msgs = [];
            for (let i = 1; i <= 8; i++) { msgs.push(u(`消息${i}`), a(`回复${i}`)); }
            const vc = makeFacade(msgs);
            const c = new ContextCompressor(vc, makeConfig());
            await c.checkAndRollAsync();
            assert.strictEqual(vc.messages.length, 16, '失败时消息必须保留');
            assert.strictEqual(c.rollingBusy, false, 'busy 标志必须复位');
            ok('摘要失败 → 消息保留 + busy 复位');
        }

        console.log(`\ncontext-rolling.test.js：${pass}/7 全过`);
        process.exit(0);
    } catch (e) {
        console.error('❌ 测试失败:', e.message);
        process.exit(1);
    } finally {
        global.fetch = realFetch;
    }
})();
