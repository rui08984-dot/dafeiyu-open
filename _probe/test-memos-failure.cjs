#!/usr/bin/env node
/**
 * _probe/test-memos-failure.cjs — MemOS 搜索失败不再伪装成「没有记忆」（2026-11-25 P1-4）
 *
 * 病根：memos-client.search 的 catch 里 return []，前两次失败不写日志；
 * 注入侧只表现为「没有可注入记忆」，MemOS 挂了没人知道。
 * 本测试用假 axios + 假 logger，不连真 MemOS、不写用户数据。
 */
'use strict';

const path = require('path');
const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const API = require(path.join(LIVE, 'js', 'api-utils.js'));
const axios = require(path.join(LIVE, 'node_modules', 'axios', 'dist', 'node', 'axios.cjs'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// 先换 logger，再 require memos-client（它在模块加载时解构 logToTerminal）
const logs = [];
API.logToTerminal = (level, msg) => { logs.push({ level, msg: String(msg) }); };
const warns = [];
const origWarn = console.warn;
console.warn = (msg) => { warns.push(String(msg)); };

const { MemosClient } = require(path.join(LIVE, 'plugins', 'built-in', 'memos', 'memos-client.js'));

let calls = 0;
let mode = 'fail';
axios.post = async () => {
    calls += 1;
    if (mode === 'fail') {
        const e = new Error('connect ECONNREFUSED 127.0.0.1:8003');
        e.response = { status: 503 };
        throw e;
    }
    return { data: { memories: [{ content: '主人喜欢喝乌龙茶', similarity: 0.9 }] } };
};

(async () => {
    const c = new MemosClient({ enabled: true, api_url: 'http://127.0.0.1:8003' });

    // ① 第 1 次失败：返回结构化失败、静默（不 warn）
    const r1 = await c.search('茶');
    ok('第 1 次失败返回 ok:false', r1.ok === false);
    ok('失败原因 search-failed', r1.reason === 'search-failed', r1.reason);
    ok('失败带回 HTTP status', r1.status === 503, String(r1.status));
    ok('第 1 次失败静默（0 条 warn）', warns.length === 0 && logs.filter((x) => x.level === 'warn').length === 0,
        'warns=' + warns.length + ' logs=' + JSON.stringify(logs));
    ok('failStreak 计到 1', c.healthInfo().failStreak === 1);

    // ② 第 2 次失败：必须 warn 一行（含 status/原因）
    const r2 = await c.search('茶');
    ok('第 2 次失败仍 ok:false', r2.ok === false);
    ok('第 2 次失败 warn 1 行', warns.length === 1, 'warns=' + warns.length);
    ok('warn 含 status=503 与原因', /503/.test(warns[0] || '') && /ECONNREFUSED|失联/.test(warns[0] || ''), warns[0]);
    ok('warn 同时进 logToTerminal(warn)', logs.some((x) => x.level === 'warn' && /503/.test(x.msg)));
    ok('healthInfo 暴露 lastFailReason', /503/.test(c.healthInfo().lastFailReason || ''));

    // ③ 第 3 次后熔断：不再打后端，返回 circuit-open
    await c.search('茶');
    const before = calls;
    const r4 = await c.search('茶');
    ok('连续 3 次后熔断 circuit-open', r4.ok === false && r4.reason === 'circuit-open', r4.reason);
    ok('熔断期不再请求后端', calls === before, 'calls=' + calls);

    // ④ 成功一次清零（模拟熔断窗口过去：把 lastFailAt 推远，而不是手动清 streak）
    c._lastFailAt = 0;
    mode = 'ok';
    const r5 = await c.search('茶');
    ok('成功返回 ok:true', r5.ok === true);
    ok('成功带回 memories 数组', Array.isArray(r5.memories) && r5.memories.length === 1);
    ok('成功清零 failStreak', c.healthInfo().failStreak === 0);
    ok('恢复写一条 info 日志', logs.some((x) => x.level === 'info' && /恢复/.test(x.msg)));

    // ⑤ 关闭状态：结构化原因，不抛
    const off = new MemosClient({ enabled: false });
    const r6 = await off.search('茶');
    ok('禁用时 ok:false + reason:disabled', r6.ok === false && r6.reason === 'disabled');
    ok('search 永不抛（异常对象也能收住）', await (async () => {
        mode = 'fail';
        try { await c.search('x'); return true; } catch (e) { return false; }
    })());

    console.warn = origWarn;
    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.warn = origWarn;
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
