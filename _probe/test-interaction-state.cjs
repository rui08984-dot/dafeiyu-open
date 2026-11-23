#!/usr/bin/env node
/**
 * _probe/test-interaction-state.cjs —— D8 交互状态机 shadow 单测（2026-11-22）
 *
 * 要防的回归：
 *   ① reduce 不是纯函数（改了入参 / 状态字段漂移）
 *   ② shadow 写回现有状态（D8 的验收前提，必须一个字都不能改）
 *   ③ 开关形同虚设（enabled:false 还在算/还在写盘）
 *   ④ mismatch 记录不是「只记不一致的键」、不可查 TOP、不滚动
 *   ⑤ 事件接线错位（TTS/工具/拖动/回合没有推进影子状态）
 *
 * 数据隔离：先设 PET_DATA_ROOT 再 require 业务模块（A2 口径）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

const tmpRoot = iso.setUpTempDataRoot('pet-interaction-');
const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');

const IS = require(path.join(LIVE, 'js', 'core', 'interaction-state.js'));
const { appState } = require(path.join(LIVE, 'js', 'core', 'app-state.js'));
const { eventBus } = require(path.join(LIVE, 'js', 'core', 'event-bus.js'));
const { Events } = require(path.join(LIVE, 'js', 'core', 'events.js'));
const { recordFile } = require(path.join(LIVE, 'js', 'core', 'records-path.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const CFG = recordFile(IS.CFG_FILE);
const LOG = recordFile(IS.LOG_FILE);
const idleActual = () => ({ talking: false, thinking: false, listening: false, dragging: false, idle: true });

try {
    ok('数据目录已隔离', iso.assertIsolated(LOG), tmpRoot);

    // ── ① 纯函数 reduce ──────────────────────────────────────────────────
    const s0 = IS.initialState();
    ok('初始状态：idle=true，其余 false',
        s0.idle === true && !s0.talking && !s0.thinking && !s0.listening && !s0.dragging && !s0.waitingUser);

    const sTts = IS.reduce(s0, { type: 'tts.start' });
    ok('tts.start → talking=true / idle=false / waitingUser=false',
        sTts.talking === true && sTts.thinking === false && sTts.idle === false && sTts.waitingUser === false);
    ok('reduce 不修改入参', s0.talking === false && s0.idle === true, '入参仍为初始状态');

    const sEnd = IS.reduce(sTts, { type: 'tts.end' });
    ok('tts.end → talking=false / waitingUser=true / idle=true',
        sEnd.talking === false && sEnd.waitingUser === true && sEnd.idle === true);

    const sSpeak = IS.reduce(sEnd, 'user.speak');
    ok('user.speak → listening=true / talking=false / waitingUser=false / idle=false',
        sSpeak.listening === true && sSpeak.talking === false && sSpeak.waitingUser === false && sSpeak.idle === false);

    const sTurn = IS.reduce(sSpeak, { type: 'turn.begin' });
    ok('turn.begin → listening=false / thinking=true',
        sTurn.listening === false && sTurn.thinking === true && sTurn.idle === false);

    const sToolStart = IS.reduce(sTurn, { type: 'tool.start' });
    const sToolEnd = IS.reduce(sToolStart, { type: 'tool.end' });
    ok('tool.start/tool.end 期间 thinking 保持 true（回合没完）',
        sToolStart.thinking === true && sToolEnd.thinking === true);

    const sDrag = IS.reduce(sEnd, { type: 'drag.start' });
    const sDrop = IS.reduce(sDrag, { type: 'drag.end' });
    ok('drag.start → dragging=true / idle=false', sDrag.dragging === true && sDrag.idle === false);
    ok('drag.end → dragging=false / idle=true', sDrop.dragging === false && sDrop.idle === true);

    const sTalkingTurnEnd = IS.reduce(sTts, { type: 'turn.end' });
    ok('turn.end 时还在说 → waitingUser=false（她说完才算等用户）',
        sTalkingTurnEnd.thinking === false && sTalkingTurnEnd.talking === true && sTalkingTurnEnd.waitingUser === false);

    const sUnknown = IS.reduce(sTurn, { type: 'no.such.event' });
    ok('未知事件不改变状态', same(sUnknown, sTurn));

    ok('状态字段固定为 6 个', same(Object.keys(s0).sort(), IS.STATE_KEYS.slice().sort()), Object.keys(s0).join(','));

    // ── ② 开关：关闭时零计算、零落盘、零写回 ─────────────────────────────
    fs.mkdirSync(path.dirname(CFG), { recursive: true });
    fs.writeFileSync(CFG, JSON.stringify({ enabled: false }), 'utf8');
    IS.reloadConfig();

    const before = appState.getAllStates();
    IS.feed({ type: 'tts.start' });
    IS.feed({ type: 'turn.begin' });
    const offStats = IS.stats();
    ok('enabled:false 时不计数', offStats.total === 0 && offStats.mismatch === 0, 'total=' + offStats.total);
    ok('enabled:false 时不写 jsonl', !fs.existsSync(LOG));
    ok('enabled:false 时 appState 未被改动', same(before, appState.getAllStates()), JSON.stringify(appState.getAllStates()));

    // ── ③ 开启：mismatch 只记不一致的键 + TOP 可查 ───────────────────────
    fs.writeFileSync(CFG, JSON.stringify({ enabled: true }), 'utf8');
    IS.reloadConfig();
    IS.setActualProvider(idleActual);

    const r1 = IS.feed({ type: 'tts.start' });
    ok('feed 返回影子状态（talking=true）', r1.talking === true && r1.idle === false);
    const rec1 = IS.flush();
    ok('mismatch 记录已生成', !!rec1 && rec1.event === 'tts.start', rec1 && JSON.stringify(rec1.keys));
    ok('只记不一致的键（talking/idle，不含 thinking/listening）',
        same(rec1.keys, ['talking', 'idle']) && !('thinking' in rec1.expected) && !('listening' in rec1.expected),
        JSON.stringify(rec1));

    IS.feed({ type: 'tts.end' });
    const recNone = IS.flush();
    ok('全部一致时不写记录', recNone === null);

    const st1 = IS.stats();
    ok('stats 有 total/mismatch/top', st1.total === 2 && st1.mismatch === 1 && Array.isArray(st1.top),
        JSON.stringify({ total: st1.total, mismatch: st1.mismatch, top: st1.top }));
    const topMap = Object.fromEntries(st1.top.map((t) => [t.key, t.count]));
    ok('TOP 按键计数正确', topMap.talking === 1 && topMap.idle === 1);

    const fileLines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
    const firstLine = JSON.parse(fileLines[0]);
    ok('jsonl 行形状 {at,event,expected,actual,keys}',
        Number.isFinite(firstLine.at) && firstLine.event === 'tts.start' &&
        firstLine.expected && firstLine.actual && Array.isArray(firstLine.keys));

    // 自造条件（D8 交付项 3）：伪造一整轮事件序列 → mismatch 正常记录，现有状态一字未改
    const beforeSeq = appState.getAllStates();
    const mismatchBefore = IS.stats().mismatch;
    for (const type of ['user.speak', 'turn.begin', 'tool.start', 'tool.end', 'tts.start', 'tts.end']) {
        IS.feed({ type });
        IS.flush();
    }
    const afterSeq = appState.getAllStates();
    ok('伪造事件序列：mismatch 逐事件记录', IS.stats().mismatch >= mismatchBefore + 5,
        'mismatch +' + (IS.stats().mismatch - mismatchBefore));
    ok('伪造事件序列后 appState 一字未改（shadow 不写回）', same(beforeSeq, afterSeq), JSON.stringify(afterSeq));

    // ── ④ eventBus 接线：只订阅、不写回 ──────────────────────────────────
    const beforeBus = appState.getAllStates();
    eventBus.emit(Events.TTS_START);
    IS.flush();
    ok('eventBus TTS_START 推进影子状态并比对', IS.stats().total >= 3, 'total=' + IS.stats().total);
    ok('eventBus 事件后 appState 只被它自己的监听器改（shadow 未写回）',
        appState.isPlayingTTS() === true && beforeBus.isPlayingTTS === false,
        'shadow 没有 setter 调用');
    eventBus.emit(Events.TTS_END);
    IS.flush();
    ok('eventBus TTS_END 后 appState 恢复 false', appState.isPlayingTTS() === false);

    // 拖动事件（新增的只读通知）也要能推进
    const beforeDrag = IS.stats().total;
    eventBus.emit(Events.AVATAR_DRAG_START);
    IS.flush();
    eventBus.emit(Events.AVATAR_DRAG_END);
    IS.flush();
    ok('drag.start / drag.end 已接线', IS.stats().total === beforeDrag + 2);

    // ── ④b 默认快照：从现有 UI aura 类 / appState 读，而不是只看注入值 ──
    const aura = new Set(['state-thinking']);
    global.document = { body: { classList: { contains: (c) => aura.has(c) } } };
    global.window = { __pbDragging: false, __pbDraggingAt: Date.now() };
    IS.setActualProvider(null);
    IS.feed({ type: 'turn.begin' });
    const recDomMatch = IS.flush();
    ok('默认快照能读到 state-thinking（turn.begin 全一致）', recDomMatch === null,
        recDomMatch && JSON.stringify(recDomMatch.keys));
    aura.clear();
    IS.feed({ type: 'tts.start' });   // appState 未在播、aura 也没 speaking → 预期不一致
    const recDom = IS.flush();
    ok('默认快照 talking/idle 不一致时正确记录', !!recDom && same(recDom.keys, ['talking', 'idle']),
        recDom && JSON.stringify(recDom.keys));
    delete global.document;
    delete global.window;
    IS.setActualProvider(idleActual);

    // ── ⑤ 健壮性 + 滚动上限 ─────────────────────────────────────────────
    IS.setActualProvider(idleActual);
    let threw = false;
    try { IS.feed(null); IS.feed({}); IS.feed({ type: 'nonsense' }); } catch (e) { threw = true; }
    IS.flush();
    ok('畸形事件不抛错', threw === false);

    for (let i = 0; i < 510; i += 1) {
        IS.feed({ type: 'tts.start' });
        IS.flush();
    }
    const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
    ok('滚动上限 500 行', lines.length === 500, 'lines=' + lines.length);
    const allValid = lines.every((l) => {
        try {
            const r = JSON.parse(l);
            return Array.isArray(r.keys) && same(Object.keys(r.expected).sort(), r.keys.slice().sort());
        } catch (e) { return false; }
    });
    ok('500 行全部是合法且只含 mismatch 键的记录', allValid);

    const st2 = IS.stats();
    const top2 = Object.fromEntries(st2.top.map((t) => [t.key, t.count]));
    ok('滚动后 TOP 仍可查且 talking/idle 各 500',
        st2.top.length > 0 && top2.talking === 500 && top2.idle === 500,
        JSON.stringify(st2.top.slice(0, 3)));
    ok('mismatch 总数覆盖连跑（>=500）', st2.mismatch >= 510, 'mismatch=' + st2.mismatch);

    // 默认开：删掉配置后 reload 应回到 enabled=true
    fs.unlinkSync(CFG);
    ok('无配置文件 → 默认开启', IS.reloadConfig() === true);
} finally {
    iso.cleanup(tmpRoot);
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
