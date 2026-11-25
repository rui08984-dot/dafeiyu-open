#!/usr/bin/env node
/**
 * _probe/test-visible-patches-volatile.cjs —— 三处「稳定」补丁必须 volatile（2026-11-24 第三轮 P1）
 *
 * 防的是「每次触发都让整段历史前缀缓存作废」：
 *   persona-guard（4 处 add）、companion-health、live-dock 调 addSystemPromptPatch 没传 volatile，
 *   而 persona-guard 还在 onLLMResponse 里 remove —— system 在一次判官触发里被改写**两次**，
 *   其后的历史全部 miss（审计 §8.4）。这些内容本质是「此刻状态 / 临时裁决」，不是人格条款。
 *
 * 现在：
 *   ① 这三类补丁在 _systemPromptPatches 里 volatile === true；
 *   ② 触发前后 system 消息**字节不变**（volatile 不进 system）；
 *   ③ collectVolatilePromptPatches() 能拿到它们（由 prompt-layout 拼到 user 末尾）；
 *   ④ 删除逻辑保留：volatile 补丁也能撤（persona-guard 正常回复 / companion-health onLLMResponse）。
 *
 * 全程离线、临时数据根；不碰真实 data。
 */
'use strict';

const path = require('path');
const iso = require('./lib/test-isolation.cjs');

const TMP = iso.setUpTempDataRoot('pet-visible-patches-');

const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const PC = require(path.join(LIVE, 'js', 'core', 'plugin-context.js'));
const PersonaGuard = require(path.join(LIVE, 'plugins', 'community', 'persona-guard', 'index.js'));
const CompanionHealth = require(path.join(LIVE, 'plugins', 'community', 'companion-health', 'index.js'));
const LiveDock = require(path.join(LIVE, 'plugins', 'community', 'live-dock', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const BASE = '人设与规则（稳定，不该被临时补丁改写）';

(async () => {
    // 真实 PluginContext：补丁必须落进共享补丁表，才能验证 volatile 标记与 system 内容
    const ctx = new PC.PluginContext('probe-visible', {}, null);
    ctx.log = () => {};
    ctx.callLLM = async () => '{"dimension":"身份","quote":"我可以帮你","fix":"我来搭把手"}';
    global.voiceChat = { messages: [{ role: 'system', content: BASE }] };

    const sysMsg = () => global.voiceChat.messages.find((m) => m.role === 'system');
    const patched = (id) => ctx._systemPromptPatches.get(id);

    // ── ⓪ 先证明「stable 补丁确实会改 system」（否则后面的「不变」没有意义）──
    // 注：_applySystemPromptPatches 会把 mood 指令追加在 system 末尾（既有设计），
    // 所以基线不是裸 BASE，而是「BASE + mood」；这里先做一次 add/remove 拿到稳态基线。
    ctx.addSystemPromptPatch('probe-stable', 'STABLE-RULE');
    ok('stable 补丁会进 system（机制有效）', sysMsg().content.includes('STABLE-RULE'),
        sysMsg().content.slice(0, 60));
    ctx.removeSystemPromptPatch('probe-stable');
    const systemBefore = sysMsg().content;
    ok('移除 stable 补丁后 system 不再含补丁文本', !systemBefore.includes('STABLE-RULE')
        && systemBefore.includes(BASE), JSON.stringify(systemBefore.slice(0, 60)));

    // ── ① persona-guard：连续漂移提醒 ───────────────────────────────────────
    const guard = new PersonaGuard();
    guard.context = ctx;
    await guard.onInit();
    guard._enabled = true;
    guard._judgeEnabled = false;      // 先不触发判官，单独验证「连续 2 次」这条路
    guard._judgeEvery = 0;
    guard._warn = true;
    guard._maxChars = 140;
    const drift = { text: '我可以帮你处理这个问题，很高兴为您服务。', proactive_internal: false };
    await guard.onLLMResponse(drift);
    await guard.onLLMResponse(drift);
    ok('persona-guard 连续漂移后装了补丁', !!patched('persona-guard'), String(!!patched('persona-guard')));
    ok('persona-guard 连续漂移补丁 volatile===true',
        !!patched('persona-guard') && patched('persona-guard').volatile === true,
        JSON.stringify(patched('persona-guard') && patched('persona-guard').volatile));

    // ── ② persona-guard：判官 OOC 纠正（volatile 也要能撤）──────────────────
    guard._judgeEnabled = true;
    const ooc = await guard._judgeOoc('这句回复的腔调有点变了，像客服。');
    ok('判官真的产出了纠正', !!ooc && ooc.dimension === '身份', JSON.stringify(ooc));
    ok('persona-guard-ooc 补丁 volatile===true',
        !!patched('persona-guard-ooc') && patched('persona-guard-ooc').volatile === true,
        JSON.stringify(patched('persona-guard-ooc') && patched('persona-guard-ooc').volatile));

    // ── ③ companion-health：互动超量提示 ────────────────────────────────────
    const health = new CompanionHealth();
    health.context = ctx;
    await health.onInit();
    health._enabled = true;
    health._threshold = 30;
    health._minutes = 999;
    health._lastPromptAt = 0;
    await health.onUserInput();
    ok('companion-health 装了提示补丁', !!patched('companion-health'));
    ok('companion-health 补丁 volatile===true',
        !!patched('companion-health') && patched('companion-health').volatile === true,
        JSON.stringify(patched('companion-health') && patched('companion-health').volatile));

    // ── ④ live-dock：漏掉弹幕摘要 ───────────────────────────────────────────
    const dock = new LiveDock();
    dock.context = ctx;
    await dock.onInit();
    dock._updateDroppedPatch(3);
    ok('live-dock 装了漏弹幕补丁', !!patched('live-dock-dropped'));
    ok('live-dock-dropped 补丁 volatile===true',
        !!patched('live-dock-dropped') && patched('live-dock-dropped').volatile === true,
        JSON.stringify(patched('live-dock-dropped') && patched('live-dock-dropped').volatile));

    // ── ⑤ 触发前后 system 字节不变（核心断言）───────────────────────────────
    ok('三类触发后 system 消息字节完全不变', sysMsg().content === systemBefore,
        JSON.stringify(sysMsg().content));
    ok('system 里没有 Plugin Injections 块', !sysMsg().content.includes('Plugin Injections'),
        sysMsg().content.slice(0, 80));

    // ── ⑥ volatile 收集函数能拿到它们（prompt-layout 拼到 user 末尾）─────────
    const vol = PC.collectVolatilePromptPatches();
    ok('collectVolatilePromptPatches 至少含 4 段', vol.length >= 4, 'volatile=' + vol.length);
    ok('收集到 persona-guard 的连续漂移提醒', vol.some((t) => t.includes('你是大肥鱼，住在桌面小窗')),
        vol.join(' | ').slice(0, 120));
    ok('收集到 persona-guard 的 OOC 纠正', vol.some((t) => t.includes('不像你')),
        vol.join(' | ').slice(0, 120));
    ok('收集到 companion-health 的互动提示', vol.some((t) => t.includes('他已经和你互动')),
        vol.join(' | ').slice(0, 120));
    ok('收集到 live-dock 的漏弹幕摘要', vol.some((t) => t.includes('条弹幕你没回')),
        vol.join(' | ').slice(0, 120));

    const stats = PC.promptPatchLayoutStats();
    ok('补丁布局：stable=0 / volatile>=4', stats.stable === 0 && stats.volatile >= 4, JSON.stringify(stats));

    // ── ⑦ 撤销逻辑保留：正常回复 → persona-guard 两条都撤 ────────────────────
    await guard.onLLMResponse({ text: '嗯，知道了。', proactive_internal: false });
    ok('正常回复后 persona-guard 补丁被撤（volatile 也可撤）', !patched('persona-guard'));
    ok('正常回复后 OOC 补丁被撤', !patched('persona-guard-ooc'));
    const volAfter = PC.collectVolatilePromptPatches();
    ok('撤销后 volatile 收集里不再有这两条',
        !volAfter.some((t) => t.includes('你是大肥鱼，住在桌面小窗')) && !volAfter.some((t) => t.includes('不像你')),
        'volatile=' + volAfter.length);

    // ── ⑧ 另外两处也要能撤 ──────────────────────────────────────────────────
    await health.onLLMResponse();
    ok('companion-health onLLMResponse 撤掉自己的补丁', !patched('companion-health'));
    await dock.onStop();
    ok('live-dock onStop 撤掉自己的补丁', !patched('live-dock-dropped'));
    ok('全部撤完后 system 仍逐字节等于基线', sysMsg().content === systemBefore, JSON.stringify(sysMsg().content.slice(0, 60)));

    delete global.voiceChat;
    iso.cleanup(TMP);
    console.log('\n  可见补丁 volatile：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('探针自身异常：', e);
    try { iso.cleanup(TMP); } catch (e2) { /* ignore */ }
    process.exit(1);
});
