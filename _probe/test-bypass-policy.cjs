#!/usr/bin/env node
/**
 * _probe/test-bypass-policy.cjs —— 操控两条旁路的闸门回归（2026-11-21 审计）
 *
 * 旁路①：`game` 工具 → game-loop 直连 post_keys/mouse。
 *   · 只读动作（status/see/profiles/stop）不需要会话；
 *   · 输入类动作（press/hold/click/move/...）必须有活动会话 + 前台命中；
 *   · `game start` 必须显式带目标（profile/窗口），不得默认前台。
 *
 * 旁路②：watch-screen 命中 OCR 白名单自动 click_text。
 *   · watch_screen.auto_click 默认 false → 只建议不点，且同一目标 N 分钟内不重复建议；
 *   · true → 保留直点，但必须过 rateGate 与破坏性守卫。
 *
 * 纯函数 / mock：不真注入、不点桌面、不启游戏循环。
 * 判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const DISPATCH = path.join(LIVE, 'plugins', 'community', 'dispatch', 'index.js');
const GAME_LOOP = path.join(LIVE, 'js', 'core', 'game-loop.js');
const WATCH = path.join(LIVE, 'plugins', 'community', 'watch-screen', 'index.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    console.log('== test-bypass-policy（纯 Node / mock，不注入、不点桌面）==');

    const Dispatch = require(DISPATCH);
    const GameLoop = require(GAME_LOOP);
    const Watch = require(WATCH);

    // ── 0. 测试注入口 ───────────────────────────────────────────────────
    const H = Dispatch.__testHooks;
    ok('dispatch 暴露 __testHooks', !!H, H ? Object.keys(H).join(',') : 'missing');
    ok('watch-screen 暴露 resolveAutoClick', typeof Watch.resolveAutoClick === 'function');
    ok('watch-screen 暴露 decideOpportunity', typeof Watch.decideOpportunity === 'function');
    ok('game-loop 暴露 sessionSnapshot', typeof GameLoop.sessionSnapshot === 'function');
    if (!H) {
        console.error('\n' + pass + '/' + (pass + fail) + ' 全过');
        process.exit(1);
    }

    // ── 1. game 输入动作：无会话 → 拒绝且原因含「act key」──────────────
    const inst = Object.create(Dispatch.prototype);
    inst.context = { log: () => {} };

    for (const action of ['press', 'hold', 'click', 'move', 'key']) {
        const r = JSON.parse(await inst._gameLoop({ action, key: 'w' }));
        ok('game ' + action + ' 无会话被拒', r.ok === false && r.effect === 'not_sent' && r.action_sent === false,
            'ok=' + r.ok + ' effect=' + r.effect + ' action_sent=' + r.action_sent);
        ok('game ' + action + ' 拒绝原因指回 act key', /act key/.test(String(r.reason || r.error || '')),
            String(r.reason || r.error || '').slice(0, 80));
    }

    // ── 2. 有会话但前台不符 → 拒绝 ────────────────────────────────────
    const gateNoSession = H.gameInputGate('press', { active: false, fgMatch: true, target: 'Minecraft' });
    ok('纯闸：无会话 → 拒绝', !!gateNoSession && gateNoSession.effect === 'not_sent');
    const gateBg = H.gameInputGate('press', { active: true, fgMatch: false, target: 'Minecraft' });
    ok('纯闸：有会话但前台不符 → 拒绝', !!gateBg && gateBg.effect === 'not_sent',
        gateBg ? String(gateBg.reason || '').slice(0, 80) : 'null');
    ok('纯闸：前台未知（null）→ 拒绝（fail-closed）',
        !!H.gameInputGate('press', { active: true, fgMatch: null, target: 'Minecraft' }));
    const gateOk = H.gameInputGate('press', { active: true, fgMatch: true, target: 'Minecraft' });
    ok('纯闸：会话+前台都满足 → 放行', gateOk === null, String(gateOk));

    // ── 3. 只读动作不受会话闸影响 ─────────────────────────────────────
    for (const a of ['status', 'see', 'profiles', 'stop']) {
        ok('纯闸：' + a + ' 不需要会话', H.gameInputGate(a, { active: false }) === null);
    }
    const rStatus = JSON.parse(await inst._gameLoop({ action: 'status' }));
    ok('status 无会话可用', rStatus.ok === true && rStatus.running === false, JSON.stringify(rStatus).slice(0, 100));
    ok('status 带拒绝计数（可观测）', rStatus.gate && typeof rStatus.gate.rejected === 'number',
        JSON.stringify(rStatus.gate));
    const rProfiles = JSON.parse(await inst._gameLoop({ action: 'profiles' }));
    ok('profiles 无会话可用', rProfiles.ok === true && Array.isArray(rProfiles.profiles));
    const rStop = JSON.parse(await inst._gameLoop({ action: 'stop' }));
    ok('stop 无会话可用', rStop.ok === true && rStop.stopped === true);

    // ── 4. game start 无目标 → 拒绝 ───────────────────────────────────
    const rStartNoTarget = JSON.parse(await inst._gameLoop({ action: 'start' }));
    ok('game start 无目标被拒', rStartNoTarget.ok === false && rStartNoTarget.effect === 'not_sent');
    ok('start 拒绝原因提「显式目标/不会默认前台」',
        /显式目标|不会默认当前前台/.test(String(rStartNoTarget.reason || rStartNoTarget.error || '')),
        String(rStartNoTarget.reason || rStartNoTarget.error || '').slice(0, 100));

    // ── 5. watch-screen：默认 auto_click=false ───────────────────────
    ok('配置默认 false', Watch.resolveAutoClick({}, {}) === false);
    ok('全局 watch_screen.auto_click=true 生效',
        Watch.resolveAutoClick({}, { watch_screen: { auto_click: true } }) === true);
    ok('插件级 auto_click=true 生效', Watch.resolveAutoClick({ auto_click: true }, {}) === true);

    const text = '确定\n是否保存更改';
    const p = Object.create(Watch.prototype);
    p.context = { log: () => {} };
    p._opSuggestEnabled = true;
    p._opSuggestAt = 0;
    p._opSuggestByWord = {};
    p._screenState = { state: 'idle' };
    p._autoClick = false;
    p._logOnceSeen = {};
    const suggestions = [];
    p._commentOn = async (o) => { suggestions.push(o); };
    let clicks = 0;
    let gateCalls = 0;
    p._gcModule = {
        guardClickTarget: async () => null,
        rateGate: () => { gateCalls += 1; return null; },
        runGameAction: () => { clicks += 1; return Promise.resolve({ ok: true, detail: 'mock' }); },
    };

    p._scanOpportunity(text, 1000000);
    await sleep(0);
    ok('auto_click=false：runGameAction 调用 0 次', clicks === 0, 'clicks=' + clicks);
    ok('auto_click=false：建议产出 1 条', suggestions.length === 1, 'n=' + suggestions.length);
    ok('auto_click=false：建议含「看到可点 X（未点）」',
        !!suggestions[0] && /看到可点/.test(suggestions[0].text) && /未点/.test(suggestions[0].text),
        suggestions[0] ? suggestions[0].text : '(none)');
    ok('auto_click=false：不碰 rateGate', gateCalls === 0, 'gateCalls=' + gateCalls);

    // 同一目标去重：紧接着再来一次仍只有 1 条
    p._scanOpportunity(text, 1000000 + 1000);
    await sleep(0);
    ok('同一目标重复命中只建议 1 条', suggestions.length === 1, 'n=' + suggestions.length);

    // 纯函数层面证明「同一目标 N 分钟内不重复」独立于全局冷却
    const dDedup = Watch.decideOpportunity({
        text, now: 2000000, autoClick: false, lastSuggestAt: 0,
        byWord: { 确定: 2000000 - 60000 }, targetCooldownMs: 5 * 60 * 1000,
    });
    ok('去重判据：同目标 1 分钟后 → target-cooldown',
        dDedup.mode === 'skip' && dDedup.reason === 'target-cooldown', JSON.stringify(dDedup));
    const dFresh = Watch.decideOpportunity({
        text, now: 2000000, autoClick: false, lastSuggestAt: 0,
        byWord: { 确定: 2000000 - 6 * 60 * 1000 }, targetCooldownMs: 5 * 60 * 1000,
    });
    ok('去重判据：同目标 6 分钟后 → 重新建议', dFresh.mode === 'suggest', JSON.stringify(dFresh));

    // ── 6. watch-screen：auto_click=true 保留直点，但过闸 ────────────
    const p2 = Object.create(Watch.prototype);
    p2.context = { log: () => {} };
    p2._opSuggestEnabled = true;
    p2._opSuggestAt = 0;
    p2._opSuggestByWord = {};
    p2._screenState = { state: 'idle' };
    p2._autoClick = true;
    p2._logOnceSeen = {};
    const suggestions2 = [];
    p2._commentOn = async (o) => { suggestions2.push(o); };
    let clicks2 = 0;
    let rateCalls2 = 0;
    let guardCalls2 = 0;
    p2._gcModule = {
        guardClickTarget: async () => { guardCalls2 += 1; return null; },
        rateGate: () => { rateCalls2 += 1; return null; },
        runGameAction: () => { clicks2 += 1; return Promise.resolve({ ok: true, detail: 'mock clicked' }); },
    };

    await p2._scanOpportunity(text, 3000000);
    await sleep(0);
    ok('auto_click=true：runGameAction 调用 1 次', clicks2 === 1, 'clicks=' + clicks2);
    ok('auto_click=true：过 rateGate（mock 计数 1）', rateCalls2 === 1, 'rateCalls=' + rateCalls2);
    ok('auto_click=true：过破坏性守卫（mock 计数 1）', guardCalls2 === 1, 'guardCalls=' + guardCalls2);
    ok('auto_click=true：成功直点后报一句', suggestions2.length === 1, 'n=' + suggestions2.length);

    // 守卫拦下时不许点
    const p3 = Object.create(Watch.prototype);
    p3.context = { log: () => {} };
    p3._opSuggestEnabled = true;
    p3._opSuggestAt = 0;
    p3._opSuggestByWord = {};
    p3._screenState = { state: 'idle' };
    p3._autoClick = true;
    p3._logOnceSeen = {};
    p3._commentOn = async () => {};
    let clicks3 = 0;
    p3._gcModule = {
        guardClickTarget: async () => ({ ok: false, blocked: 'destructive-button', reason: '会丢弃未保存的更改' }),
        rateGate: () => null,
        runGameAction: () => { clicks3 += 1; return Promise.resolve({ ok: true }); },
    };
    await p3._scanOpportunity(text, 4000000);
    await sleep(0);
    ok('auto_click=true：破坏性守卫拦下 → 不点', clicks3 === 0, 'clicks=' + clicks3);

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
