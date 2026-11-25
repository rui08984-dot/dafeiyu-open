#!/usr/bin/env node
/**
 * _probe/test-tool-result-truncated.cjs — 截断 JSON 不再当成功（2026-11-25 P1-5）
 *
 * 病根：tool-result.parse 对「以 {/[ 开头但 JSON.parse 失败」返回 {ok:true,text}，
 * 于是 tool-executor 走成功分支、telemetry 记 tool.end，模型拿到半截 JSON。
 * 现在 parse 返回 {ok:false, parseError:true, truncated:true, raw:前500字}。
 *
 * 本测试用假 telemetry / 假工具，不调真工具、不写用户数据。
 */
'use strict';

const path = require('path');
const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const TR = require(path.join(LIVE, 'js', 'core', 'tool-result.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// ① parse 判据
const valid = TR.parse('{"ok":true,"x":1}');
ok('合法 JSON → ok:true', valid.ok === true && valid.x === 1);
const bad = TR.parse('{"ok":true,"elements":[1,2,3');
ok('截断 JSON → ok:false', bad.ok === false);
ok('截断 JSON → parseError:true', bad.parseError === true);
ok('截断 JSON → truncated:true', bad.truncated === true);
ok('保留原文前缀', /^\{"ok":true,"elements"/.test(bad.raw || ''), bad.raw);
const huge = TR.parse('{"a":"' + 'x'.repeat(2000));
ok('raw 最多 500 字', String(huge.raw || '').length <= 500, 'len=' + String(huge.raw || '').length);
ok('isFailure 认截断 JSON', TR.isFailure('{oops') === true);
ok('detailOf 给出原因（不再 backfilled）', /JSON 解析失败/.test(TR.detailOf(bad)));

// ② audit 计数
TR.resetStats();
const a = TR.audit('see', '{oops');
ok('audit 记 failure', a.ok === false && a.failure === true);
ok('截断 JSON 不算 backfilled（原因非空）', a.backfilled === false && a.detail.length > 0);

// ③ tool-executor：telemetry 记 tool.error（用桩，不碰真工具/真后端）
const events = [];
function stub(absPath, exports) {
    require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}
stub(require.resolve(path.join(LIVE, 'js', 'core', 'telemetry.js')), {
    emitTelemetry: (e) => events.push(e),
});
stub(require.resolve(path.join(LIVE, 'js', 'core', 'turn-context.js')), {
    currentTurnId: () => 't-test', ensureTurn: () => 't-test', markPhase: () => {}, endTurn: () => {},
});
stub(require.resolve(path.join(LIVE, 'js', 'core', 'turn-journal.js')), {
    recover: () => [], beginIntent: () => '', endResult: () => {},
});

const { ToolExecutor } = require(path.join(LIVE, 'js', 'ai', 'tool-executor.js'));
global.pluginManager = {
    executeTool: async () => '{"ok":true,"elements":[1,2,3',
};

(async () => {
    const ex = new ToolExecutor();
    let threw = null;
    let out = null;
    try {
        out = await ex.executeToolCalls([{
            id: 'call-1',
            type: 'function',
            function: { name: 'see', arguments: '{}' },
        }], { failuresAsResults: true });
    } catch (e) { threw = e; }
    ok('不 throw（不打断整轮）', threw === null, threw && threw.message);
    ok('返回失败回执而不是成功', typeof out === 'string' && /失败/.test(out) && /JSON 解析失败/.test(out), String(out).slice(0, 120));
    const err = events.find((e) => e.type === 'tool.error');
    const end = events.find((e) => e.type === 'tool.end');
    ok('telemetry 记 tool.error', !!err, 'types=' + events.map((e) => e.type).join(','));
    ok('telemetry 不记 tool.end', !end);
    ok('tool.error 带工具名与 ok:false', err && err.metrics && err.metrics.tool === 'see' && err.metrics.ok === false);

    delete global.pluginManager;
    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    delete global.pluginManager;
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
