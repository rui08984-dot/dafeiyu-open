#!/usr/bin/env node
/**
 * _probe/test-game-actions.cjs —— 运行时动作注册（2026-11-15 六十三轮）
 *
 * 目标（对照 Neuro-sdk 的 actions.register）：**换游戏只改 profile 数据，不改代码**。
 * 这个测试只用假 profile + 假执行器，不碰真游戏、不发任何输入。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const Plugin = require(path.join(LIVE, 'plugins', 'community', 'game-actions', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-test-'));
const p1 = path.join(dir, 'game-a.json');
const p2 = path.join(dir, 'game-b.json');
const pEmpty = path.join(dir, 'empty.json');

fs.writeFileSync(p1, JSON.stringify({
    game: 'game-a',
    actions: [
        {
            name: 'Jump',
            description: '让角色跳一下',
            parameters: { type: 'object', properties: { height: { type: 'number' } }, required: [] },
            run: { tool: 'game', args: { action: 'press_key', key: 'space', ms: 120 } },
        },
        { name: 'wave', description: '挥手', run: { tool: 'game', args: { action: 'wave' } } },
        { name: 'broken-no-run', description: '没有 run 的动作应被忽略' },
    ],
}), 'utf8');
fs.writeFileSync(p2, JSON.stringify({
    game: 'game-b',
    actions: [{ name: 'mine', description: '挖一下', run: { tool: 'game', args: { action: 'click', button: 'left' } } }],
}), 'utf8');
fs.writeFileSync(pEmpty, JSON.stringify({ game: 'empty' }), 'utf8');

(async () => {
    const registered = new Map();
    const p = new Plugin();
    let cfgPath = p1;
    p.context = {
        getPluginFileConfig: () => ({ profile: cfgPath }),
        registerTool: (def) => registered.set(def.function.name, def),
        unregisterTool: (name) => registered.delete(name),
        log: () => {},
    };
    await p.onStart();

    ok('注册两个动作（没有 run 的被忽略）', p.getTools().length === 2, 'tools=' + p.getTools().map((t) => t.function.name).join(','));
    ok('工具名有前缀且小写', registered.has('ga_jump') && registered.has('ga_wave'), [...registered.keys()].join(','));
    ok('参数 schema 原样带出', registered.get('ga_jump').function.parameters.properties.height.type === 'number');
    ok('handlesToolName 认领自己的工具', p.handlesToolName('ga_jump') === true && p.handlesToolName('recall') === false);

    // 执行委托：params 覆盖 profile 里的默认 args
    let called = null;
    global.pluginManager = { executeTool: async (tool, args) => { called = { tool, args }; return 'ok'; } };
    const r = await p.executeTool('ga_jump', { height: 2 });
    ok('执行委托给已有工具', r === 'ok' && called && called.tool === 'game', JSON.stringify(called));
    ok('调用参数覆盖默认值', called.args.action === 'press_key' && called.args.height === 2 && called.args.key === 'space');

    // 换 profile：旧动作必须被注销
    cfgPath = p2;
    p._load();
    ok('换 profile 后旧动作注销', !registered.has('ga_jump') && !registered.has('ga_wave'));
    ok('换 profile 后新动作注册', registered.has('ga_mine'), [...registered.keys()].join(','));
    ok('换 profile 后 getTools 只剩新的', p.getTools().length === 1);

    // 空 profile：零行为变化
    cfgPath = pEmpty;
    p._load();
    ok('无 actions 的 profile 不注册任何工具', p.getTools().length === 0 && registered.size === 0);

    // 未知动作 / 缺执行器必须抛错（不能静默）
    let e1 = null;
    try { await p.executeTool('ga_nope', {}); } catch (e) { e1 = e; }
    ok('未知动作抛错', !!e1 && /未知/.test(e1.message));

    await p.onStop();
    delete global.pluginManager;

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
