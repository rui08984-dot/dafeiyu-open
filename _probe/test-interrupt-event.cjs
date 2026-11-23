#!/usr/bin/env node
/**
 * _probe/test-interrupt-event.cjs —— 「行，你说」假打断根因回归（2026-11-22）
 *
 * 现场：她正常回复后，用户按 V 提一个普通问题，她下一句却以「行，你说。」开头。
 * 根因（真机日志实证）：tts-processor.interrupt() 无条件写 __petInterruptedAt，
 * 而 PTT 无论 TTS 是否在播都会调 interrupt() → inner-state 30 秒内必注入
 * 「开头用不超过 6 个字确认一下，比如"行，你说"」。
 *
 * 钉住五件事：
 *   ① 不在播 → 不记录（普通提问不会被当成打断）
 *   ② 在播 → 记录（真打断仍要确认）
 *   ③ 一次性消费：take 一次就清，不会连续两轮注入
 *   ④ 30 秒过期；旧格式（没有 wasPlaying）一律不认
 *   ⑤ 接线：tts-processor 用 isPlaying 判定、PTT/热键带 reason、inner-state 走 take()
 *
 * 纯 Node：不启 Electron、不碰 TTS。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const M = require(path.join(APP, 'js', 'core', 'interrupt-event.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// ① 不在播：不记录
{
    const store = {};
    const r = M.record(store, { now: 1000, text: '上一轮的旧话', source: 'ptt', wasPlaying: false });
    ok('不在播 → record 返回 null', r === null, String(r));
    ok('不在播 → store 里没有任何标记', !store[M.STORE_KEY], JSON.stringify(store));
    ok('不在播 → take 也拿不到（普通提问不会触发确认语）', M.take(store, 1100) === null, '');
}

// ② 在播：记录
{
    const store = {};
    const r = M.record(store, { now: 2000, text: '她说到一半被截断', source: 'ptt', wasPlaying: true });
    ok('在播 → record 返回事件', !!r && r.wasPlaying === true, JSON.stringify(r));
    ok('事件带 source', r && r.source === 'ptt', r && r.source);
    ok('事件带截断文本（末尾 60）', r && r.text === '她说到一半被截断', r && r.text);
    const t = M.take(store, 2500);
    ok('在播 → 30 秒内 take 得到事件', !!t && t.text === '她说到一半被截断', JSON.stringify(t));
}

// ③ 一次性消费
{
    const store = {};
    M.record(store, { now: 3000, text: 'x', source: 'barge-in', wasPlaying: true });
    M.take(store, 3100);
    ok('take 后立刻清空（同一事件不会被两轮消费）', M.take(store, 3200) === null, '');
}

// ④ 过期 / 旧格式
{
    const store = {};
    M.record(store, { now: 4000, text: 'y', source: 'hotkey', wasPlaying: true });
    ok('超过 30 秒不算（不会隔半分钟还确认）', M.take(store, 4000 + 30001) === null, '');
    const store2 = {};
    store2[M.STORE_KEY] = { at: 5000, text: 'legacy' };   // 旧写入者没有 wasPlaying
    ok('旧格式（缺 wasPlaying）不认', M.take(store2, 5100) === null, '');
    const store3 = {};
    M.record(store3, { now: 6000, text: 'z'.repeat(100), source: 's'.repeat(50), wasPlaying: true });
    const t = M.take(store3, 6100);
    ok('文本/来源有界（60/24）', t && t.text.length === 60 && t.source.length === 24, t ? (t.text.length + '/' + t.source.length) : 'null');
}

// ⑤ 生产接线
{
    const tts = fs.readFileSync(path.join(APP, 'js', 'voice', 'tts-processor.js'), 'utf8');
    ok('tts-processor.interrupt 先算 isPlaying', /interrupt\(opts\)/.test(tts) && /isPlaying\(\)\s*===\s*true/.test(tts), '');
    ok('tts-processor 通过 interrupt-event.record 记录（带 wasPlaying）',
        /interrupt-event\.js'\)\.record/.test(tts) && /wasPlaying/.test(tts), '');
    ok('不再有无条件写 __petInterruptedAt',
        !/globalThis\.__petInterruptedAt\s*=/.test(tts), '');
    ok('日志能区分「在播/没在播」', /当时在播/.test(tts) && /当时没在播/.test(tts), '');
    ok('打断事件记的是「真播出」的尾巴（heard 先算，record 后写）', (() => {
        const iHeard = tts.indexOf('computeHeardPrefix');
        const iRec = tts.indexOf("interrupt-event.js').record");
        return iHeard > 0 && iRec > iHeard && /typeof heard === 'string' \? heard : fullForHeard/.test(tts);
    })(), '停在「…」只引用用户听过的部分');

    const asr = fs.readFileSync(path.join(APP, 'js', 'voice', 'asr-processor.js'), 'utf8');
    ok('PTT 带 reason=ptt', /interrupt\(\{\s*reason:\s*'ptt'\s*\}\)/.test(asr), '');
    ok('真抢话带 reason=barge-in', /interrupt\(\{\s*reason:\s*'barge-in'\s*\}\)/.test(asr), '');

    const ipc = fs.readFileSync(path.join(APP, 'js', 'ipc-handlers.js'), 'utf8');
    ok('Ctrl+G 带 reason=hotkey', /interrupt\(\{\s*reason:\s*'hotkey'\s*\}\)/.test(ipc), '');

    const inner = fs.readFileSync(path.join(APP, 'plugins', 'community', 'inner-state', 'index.js'), 'utf8');
    ok('inner-state 走 interrupt-event.take（一次性 + 只认在播）',
        /interrupt-event\.js'\)\.take/.test(inner), '');
    ok('inner-state 不再读旧的 __petInterruptedAt', !/__petInterruptedAt/.test(inner), '');
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
