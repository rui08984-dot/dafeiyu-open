#!/usr/bin/env node
/**
 * _probe/test-plugin-context-snapshot.cjs —— B7「plugin-context 快照」证伪测试
 *
 * 真 bug 两条：
 *   ① getMessages/getConfig 直接返回宿主活对象 → 插件改副本会污染全局。
 *   ② _applySystemPromptPatches 用 sys._baseContent 旧快照当基底 → 外部改了
 *      sys.content（人格重载/别的模块追加）后，下一次插件 add/remove 会整体覆盖，
 *      外部修改丢失；补丁表也没有 owner，插件卸载后注入留在 system 里。
 *
 * 覆盖：
 *   A. getMessages / getConfig 深快照：改副本不影响源；嵌套对象也隔离。
 *   B. system content 反推：外部追加保留、注入块/ mood 不重复、重复 add 幂等。
 *   C. remove/release：只删自己的补丁（owner），volatile 不进 system。
 *   D. plugin-manager.unload 调用 releaseSystemPromptPatches（静态接线）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const PC = path.join(LIVE, 'js', 'core', 'plugin-context.js');
const PM = path.join(LIVE, 'js', 'core', 'plugin-manager.js');
const WATCH = path.join(LIVE, 'plugins', 'community', 'watch-screen', 'index.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name); return true; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}
function eq(name, actual, expected) {
    return ok(name, actual === expected, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}
function count(haystack, needle) {
    return String(haystack).split(needle).length - 1;
}

const { PluginContext, collectVolatilePromptPatches, __test } = require(PC);
const MOOD = require(path.join(LIVE, 'js', 'ai', 'mood-line.js')).MOOD_INSTRUCTION;

const previousVoiceChat = global.voiceChat;

console.log('\n[A] 快照：改副本不影响源');
{
    const config = { ui: { width: 420, nested: { a: 1 } }, list: [{ x: 1 }] };
    const messages = [
        { role: 'system', content: 'BASE' },
        { role: 'user', content: '原话' },
        { role: 'assistant', content: '回复' },
    ];
    global.voiceChat = { messages };
    const ctx = new PluginContext('plugins/test-snapshot', config, null);

    const cfg = ctx.getConfig();
    ok('getConfig 返回的是副本（不是同一引用）', cfg !== config);
    cfg.ui.width = 999;
    cfg.ui.nested.a = 999;
    cfg.list[0].x = 999;
    eq('改副本顶层不影响源', config.ui.width, 420);
    eq('改副本嵌套对象不影响源', config.ui.nested.a, 1);
    eq('改副本数组元素不影响源', config.list[0].x, 1);

    const msgs = ctx.getMessages();
    ok('getMessages 返回的是新数组', msgs !== messages);
    eq('数组长度一致', msgs.length, messages.length);
    msgs.push({ role: 'user', content: '插件塞的' });
    msgs[1].content = '被插件改了';
    msgs[1].role = 'system';
    eq('往副本 push 不影响源长度', messages.length, 3);
    eq('改副本消息内容不影响源', messages[1].content, '原话');
    eq('改副本消息角色不影响源', messages[1].role, 'user');
    ok('消息对象本身也是副本', msgs[0] !== messages[0]);

    // 边界：明确需要原位维护的插件用 getMessagesLive（活引用）
    const live = ctx.getMessagesLive();
    ok('getMessagesLive 返回宿主原数组', live === messages);
    live.push({ role: 'user', content: '原位维护' });
    eq('getMessagesLive 的写入确实落到宿主', messages.length, 4);
    ok('快照 API 与活引用 API 边界清晰', ctx.getMessages().length === 4 && ctx.getMessages() !== messages);

    // 多模态消息里的嵌套对象也要隔离
    const multimodal = [{ role: 'user', content: [{ type: 'text', text: '看屏幕' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } }] }];
    const mm = __test.snapshotValue(multimodal);
    mm[0].content[1].image_url.url = 'HACKED';
    eq('多模态嵌套对象改副本不影响源', multimodal[0].content[1].image_url.url, 'data:image/jpeg;base64,AAA');

    // 纯结构复制：循环引用不炸、非普通对象（Date）保留语义
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    const c = __test.snapshotValue(cyclic);
    ok('循环引用可复制', c !== cyclic && c.self === c);
    const withDate = { at: new Date(123456) };
    ok('Date 保留 Date 语义', __test.snapshotValue(withDate).at instanceof Date);
    eq('Date 值不变', __test.snapshotValue(withDate).at.getTime(), 123456);
}

console.log('\n[B] system content：外部修改保留 + 幂等');
{
    const messages = [{ role: 'system', content: 'BASE-PROMPT' }];
    global.voiceChat = { messages };
    const config = { ui: {} };
    const a = new PluginContext('plugins/test-a', config, null);
    const b = new PluginContext('plugins/test-b', config, null);
    const sys = messages[0];

    a.addSystemPromptPatch('test-a-one', 'PATCH-A1');
    eq('首个补丁后内容 = 纯函数期望', sys.content, __test.buildSystemContent('BASE-PROMPT', ['PATCH-A1']));
    eq('注入块只出现一次', count(sys.content, '--- Plugin Injections ---'), 1);
    eq('mood 指令只出现一次', count(sys.content, MOOD), 1);

    // 外部（人格重载/其它模块）在末尾追加内容
    sys.content += '\nEXTERNAL-EDIT';
    a.addSystemPromptPatch('test-a-two', 'PATCH-A2');
    ok('外部追加内容被保留', sys.content.includes('EXTERNAL-EDIT'));
    ok('两个补丁都在', sys.content.includes('PATCH-A1') && sys.content.includes('PATCH-A2'));
    eq('重写后注入块仍只有一份', count(sys.content, '--- Plugin Injections ---'), 1);
    eq('重写后 mood 仍只有一份', count(sys.content, MOOD), 1);
    eq('外部追加只在正确位置出现一次', count(sys.content, 'EXTERNAL-EDIT'), 1);

    // 重复 add 同一 id → 幂等（内容不重复）
    a.addSystemPromptPatch('test-a-one', 'PATCH-A1');
    eq('同 id 重复 add：文本仍只出现一次', count(sys.content, 'PATCH-A1'), 1);
    eq('同 id 重复 add：注入块仍一份', count(sys.content, '--- Plugin Injections ---'), 1);

    // b 的补丁与 a 并存
    b.addSystemPromptPatch('test-b-one', 'PATCH-B1');
    ok('跨 context 共享补丁表：A/B 都在', sys.content.includes('PATCH-A2') && sys.content.includes('PATCH-B1'));

    // volatile 补丁不进 system，但可被请求期收集
    a.addSystemPromptPatch('test-a-vol', 'VOLATILE-A', { volatile: true });
    ok('volatile 不进 system', !sys.content.includes('VOLATILE-A'));
    ok('volatile 被 collectVolatilePromptPatches 收集', collectVolatilePromptPatches().includes('VOLATILE-A'));

    console.log('\n[C] remove / release（owner 隔离）');
    a.removeSystemPromptPatch('test-a-one');
    ok('remove 后自己的补丁消失', !sys.content.includes('PATCH-A1'));
    ok('remove 不误删别人的补丁', sys.content.includes('PATCH-B1'));
    ok('remove 不误删外部修改', sys.content.includes('EXTERNAL-EDIT'));

    a.addSystemPromptPatch('test-a-one', 'PATCH-A1-AGAIN');
    const removed = a.releaseSystemPromptPatches();
    eq('release 清掉 A 的两条稳定 + 一条 volatile', removed, 3);
    ok('release 后 A 的稳定补丁都不在', !sys.content.includes('PATCH-A1-AGAIN') && !sys.content.includes('PATCH-A2'));
    ok('release 后 A 的 volatile 不在收集列表', !collectVolatilePromptPatches().includes('VOLATILE-A'));
    ok('release 不碰 B 的补丁', sys.content.includes('PATCH-B1'));
    ok('release 不碰外部修改', sys.content.includes('EXTERNAL-EDIT'));
    eq('release 后注入块仍一份', count(sys.content, '--- Plugin Injections ---'), 1);

    // 共用 id（如 untrusted-data 的边界补丁）：一个插件卸载不能删掉别人的注入
    a.addSystemPromptPatch('test-shared', 'SHARED-LINE');
    b.addSystemPromptPatch('test-shared', 'SHARED-LINE');
    a.releaseSystemPromptPatches();
    ok('共用补丁：A 释放后仍由 B 持有', sys.content.includes('SHARED-LINE'));
    b.releaseSystemPromptPatches();
    ok('共用补丁：最后一个 owner 释放后才移除', !sys.content.includes('SHARED-LINE'));

    // 清理 B，避免污染其它测试
    b.releaseSystemPromptPatches();
    ok('B release 后补丁消失', !sys.content.includes('PATCH-B1'));
    eq('全部释放后注入块消失', count(sys.content, '--- Plugin Injections ---'), 0);
    ok('全部释放后 base + 外部修改仍在', sys.content.startsWith('BASE-PROMPT') && sys.content.includes('EXTERNAL-EDIT'));
}

console.log('\n[D] 接线（静态）');
{
    const src = fs.readFileSync(PC, 'utf8');
    ok('getMessages 走 snapshotValue', /getMessages\(\)[\s\S]{0,160}snapshotValue\(voiceChat\.messages/.test(src));
    ok('getConfig 走 snapshotValue', /getConfig\(\)[\s\S]{0,80}snapshotValue\(this\._config\)/.test(src));
    ok('提供 getMessagesLive 明确活引用边界', /getMessagesLive\(\)/.test(src) && /return voiceChat\.messages \|\| \[\]/.test(src));
    const watch = fs.readFileSync(WATCH, 'utf8');
    ok('watch-screen 原位清旧截图改走 getMessagesLive', watch.includes('this.context.getMessagesLive()'));
    ok('watch-screen 仍清 image_url', watch.includes("p.type !== 'image_url'"));
    ok('watch-screen 保留旧 context 兜底', /typeof this\.context\.getMessagesLive === 'function'/.test(watch));
    ok('补丁记录带 owner', /owner:\s*this\._promptPatchOwner/.test(src));
    ok('_apply 从当前 content 反推基座', src.includes('deriveSystemBase(sys.content)'));
    ok('不再用 _baseContent 当写回基底', !/const base = \(sys\._baseContent !== undefined\)/.test(src));

    const pm = fs.readFileSync(PM, 'utf8');
    ok('unload 调用 releaseSystemPromptPatches', /releaseSystemPromptPatches\(\)/.test(pm));
    ok('unload 清理失败只告警不死锁', /清理插件提示注入失败/.test(pm));
}

// 还原全局，避免影响同进程后续（本文件独立进程，保险）
global.voiceChat = previousVoiceChat;

console.log('\n================ 结果 ================');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
