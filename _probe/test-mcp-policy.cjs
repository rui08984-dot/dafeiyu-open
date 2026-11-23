#!/usr/bin/env node
/**
 * _probe/test-mcp-policy.cjs — MCP 工具接入统一策略门（P2，2026-11-22）
 *
 * 要防的回归：
 *   ① MCP 工具绕过 policy（同样的 file write，插件被拦、MCP 放行）
 *   ② 拒绝不发声（静默放行，或只说「失败」不说原因）
 *   ③ 审批留痕落明文参数
 *   ④ MCP 结果绕过 A3 出口审计（checked/byTool 里看不到）
 *   ⑤ 批处理壳（handleToolCalls）重复判定/重复审计
 *
 * 纯逻辑：不联网、不起子进程、不碰真实数据（PET_DATA_ROOT 指向 mkdtemp）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

const tmpRoot = iso.setUpTempDataRoot('pet-mcp-policy-');
const APP = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'js');
const { MCPManager } = require(path.join(APP, 'ai', 'mcp-manager.js'));
const policy = require(path.join(APP, 'core', 'policy.js'));
const TR = require(path.join(APP, 'core', 'tool-result.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// 屏蔽被测模块的 console.log：它会打印明文参数，测试输出不该出现机密值
async function quietly(fn) {
    const orig = console.log;
    console.log = () => {};
    try { return await fn(); } finally { console.log = orig; }
}

// 假管理器：只装内存注册表 + 假传输，永远不 startServer
function makeManager(toolNames, callTool) {
    const m = new MCPManager({ mcp: { enabled: true } });
    m.isInitialized = true;
    for (const name of toolNames) {
        m.toolRegistry.tools.push({
            name,
            description: 'probe fake tool',
            parameters: {},
            server: 'fake',
            type: 'mcp',
        });
    }
    m.transports.set('fake', { callTool });
    return m;
}

function parsed(v) {
    try { return JSON.parse(v); } catch (e) { return null; }
}

(async () => {
    try {
        ok('数据目录已隔离', iso.assertIsolated(path.join(tmpRoot, 'data', 'approvals.jsonl')), tmpRoot);
        globalThis.__lastUserInputAt = Date.now();
        delete globalThis.__petQuiet;
        delete globalThis.__AGENT_EVAL__;
        policy._resetCaches();

        // ① 普通 MCP 工具放行：返回值原样、审计计数 +1
        TR.resetStats();
        let executed = 0;
        let snap;
        const mEcho = makeManager(['echo'], async (name, args) => {
            executed += 1;
            return { ok: true, echo: args };
        });
        const r1 = await quietly(() => mEcho.executeFunction('echo', { text: 'hello' }));
        ok('普通 MCP 工具放行', r1 && r1.ok === true && r1.echo && r1.echo.text === 'hello');
        ok('返回值形状未变（原样透传）', executed === 1 && !('vetoCode' in r1));
        snap = TR.snapshot();
        ok('成功结果经过 tool-result 审计', snap.checked === 1 && snap.byTool.echo && snap.byTool.echo.checked === 1,
            JSON.stringify(snap.byTool));

        // ② 高危动作（有人值守）→ ask：拒绝、原因可读、底层不执行
        TR.resetStats();
        executed = 0;
        policy._resetCaches();
        const mFile = makeManager(['file'], async () => {
            executed += 1;
            return { ok: true };
        });
        const askRaw = await quietly(() => mFile.executeFunction('file', {
            action: 'write',
            content: 'MCP_SECRET_PLAINTEXT_9f3a',
        }));
        const ask = parsed(askRaw);
        ok('高危 MCP 动作被拦（ask → 失败回执）',
            ask && ask.ok === false && ask.vetoCode === 'POLICY_ASK', askRaw && String(askRaw).slice(0, 60));
        ok('拒绝原因可读且教模型怎么重试',
            ask && /会改磁盘上的文件/.test(ask.detail) && /confirm_destructive/.test(ask.detail),
            ask && ask.detail);
        ok('被拦时底层传输未执行', executed === 0);
        snap = TR.snapshot();
        ok('拒绝回执也经过 tool-result 审计',
            snap.checked === 1 && snap.byTool.file && snap.byTool.file.failures === 1);

        // ③ 无人值守 + 高危 → deny（与普通工具同一口径）
        TR.resetStats();
        executed = 0;
        globalThis.__lastUserInputAt = Date.now() - 11 * 60 * 1000;
        const denyRaw = await quietly(() => mFile.executeFunction('file', {
            action: 'delete',
            content: 'MCP_SECRET_PLAINTEXT_9f3a',
        }));
        const deny = parsed(denyRaw);
        ok('无人值守时高危 MCP 动作 → POLICY_DENY', deny && deny.vetoCode === 'POLICY_DENY');
        ok('无人值守原因可读', deny && /无人值守/.test(deny.detail), deny && deny.detail);
        ok('无人值守被拦时底层传输未执行', executed === 0);
        globalThis.__lastUserInputAt = Date.now();

        // ④ 审批留痕：只存参数 hash，不落明文
        const appr = path.join(tmpRoot, 'data', 'approvals.jsonl');
        const raw = fs.existsSync(appr) ? fs.readFileSync(appr, 'utf8') : '';
        ok('approvals.jsonl 有 MCP 拒绝记录', raw.includes('"tool":"file"'));
        ok('参数只存 16 位 hash', /"paramsHash":"[0-9a-f]{16}"/.test(raw));
        ok('留痕里没有明文参数', !raw.includes('MCP_SECRET_PLAINTEXT_9f3a'));
        ok('留痕里没有 params 字段', !/"params"\s*:/.test(raw));
        ok('allow 的 MCP 调用不写留痕', !raw.includes('"tool":"echo"'));

        // ⑤ handleToolCalls：单结果形状不变、只审计一次（不重复）
        TR.resetStats();
        policy._resetCaches();
        const mBatch = makeManager(['echo'], async () => ({ ok: true, via: 'batch' }));
        const out = await quietly(() => mBatch.handleToolCalls([{
            id: 'call_1',
            function: { name: 'echo', arguments: '{"text":"x"}' },
        }]));
        ok('handleToolCalls 单结果形状不变', out && out.ok === true && out.via === 'batch');
        snap = TR.snapshot();
        ok('批处理路径审计恰好一次（不重复）', snap.checked === 1, 'checked=' + snap.checked);

        // ⑥ handleToolCalls 里的高危调用同样被拦，且不重复审计
        TR.resetStats();
        executed = 0;
        policy._resetCaches();
        const mBatchFile = makeManager(['file'], async () => {
            executed += 1;
            return { ok: true };
        });
        const outDenied = await quietly(() => mBatchFile.handleToolCalls([{
            id: 'call_2',
            function: { name: 'file', arguments: '{"action":"write"}' },
        }]));
        const batchDeny = parsed(outDenied);
        ok('批处理路径同样被策略门拦下',
            batchDeny && batchDeny.ok === false && batchDeny.vetoCode === 'POLICY_ASK');
        ok('批处理路径被拦时底层传输未执行', executed === 0);
        snap = TR.snapshot();
        ok('批处理路径拒绝也只审计一次', snap.checked === 1 && snap.byTool.file.failures === 1,
            'checked=' + snap.checked);

        // ⑦ 底层异常：契约不变（照旧抛），但失败必须进审计
        TR.resetStats();
        policy._resetCaches();
        const mFail = makeManager(['boom'], async () => { throw new Error('transport boom'); });
        let threw = false;
        try {
            await quietly(() => mFail.executeFunction('boom', {}));
        } catch (e) {
            threw = true;
        }
        ok('底层异常仍向上抛（不改契约）', threw === true);
        snap = TR.snapshot();
        ok('MCP 异常也经过审计（失败可见）',
            snap.checked === 1 && snap.byTool.boom && snap.byTool.boom.failures === 1);
    } finally {
        iso.cleanup(tmpRoot);
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('测试自身异常：', e);
    try { iso.cleanup(tmpRoot); } catch (e2) { /* ignore */ }
    process.exit(1);
});
