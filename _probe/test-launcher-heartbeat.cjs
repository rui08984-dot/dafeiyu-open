#!/usr/bin/env node
/**
 * _probe/test-launcher-heartbeat.cjs —— launcher 心跳 / 死因 / 陈旧锁（2026-11-25）
 *
 * 背景：launcher 静默死时没有任何现场：不知道是正常退出、异常、信号还是被 taskkill；
 * 陈旧锁也只有一句「已接管」，说不清为什么。
 *
 * 现在（纯函数 + 临时目录，不启宿主）：
 *   · 每 60s 一行 `[launcher] heartbeat pid=… uptime=…s services=…/…`（写已有 launcher.out.log）；
 *   · 退出路径写 `.state/launcher-death.json`：{at,pid,code,signal,reason,uptimeMs,lastServiceSnapshot}；
 *   · 陈旧锁判定三类：pid 不存在 / 不是 launcher / 心跳超时；旧 pid 留给 previousPid。
 *
 * 用法：node _probe/test-launcher-heartbeat.cjs
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('node:url');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-launcher-hb-'));
process.env.PET_LAUNCHER_LOCK = path.join(TMP, 'launcher.lock');
process.env.PET_LAUNCHER_OUT = path.join(TMP, 'launcher.out.log');
process.env.PET_LAUNCHER_DEATH = path.join(TMP, 'launcher-death.json');

const LAUNCHER = path.resolve(__dirname, '..', 'pet-runtime', 'tools', 'launch-my-neuro.mjs');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}

(async () => {
    const mod = await import(pathToFileURL(LAUNCHER).href);
    const {
        formatHeartbeatLine, safeAppendLine, buildDeathRecord, writeDeathRecord,
        readDeathRecord, classifyStaleLock, touchLockHeartbeat,
        acquireInstanceLock, readInstanceLock,
    } = mod;

    ok('导出 formatHeartbeatLine', typeof formatHeartbeatLine === 'function');
    ok('导出 classifyStaleLock', typeof classifyStaleLock === 'function');

    // ── 心跳行格式 ────────────────────────────────────────────────────────
    const hb = formatHeartbeatLine({ pid: 4321, uptimeMs: 125000, servicesUp: 2, servicesTotal: 9 });
    ok('心跳行格式完全匹配', hb === '[launcher] heartbeat pid=4321 uptime=125s services=2/9', hb);
    ok('心跳行只有一行（无换行）', hb.indexOf('\n') === -1);
    ok('uptime 非法值归零', formatHeartbeatLine({ pid: 1, uptimeMs: -5, servicesUp: 0, servicesTotal: 0 })
        === '[launcher] heartbeat pid=1 uptime=0s services=0/0');

    // ── 心跳落盘（写已有 out.log，失败不抛）──────────────────────────────
    const outLog = process.env.PET_LAUNCHER_OUT;
    ok('safeAppendLine 创建目录并追加成功', safeAppendLine(outLog, hb) === true);
    ok('心跳行确实在文件里', fs.readFileSync(outLog, 'utf8').includes('[launcher] heartbeat pid=4321'));
    const blocker = path.join(TMP, 'blocker');
    fs.writeFileSync(blocker, 'x');
    ok('写入失败只返回 false，不抛', (() => {
        try { return safeAppendLine(path.join(blocker, 'nope', 'x.log'), 'line') === false; }
        catch (e) { return false; }
    })());

    // ── death.json 字段与读写 ─────────────────────────────────────────────
    const rec = buildDeathRecord({
        now: Date.parse('2026-11-25T10:00:00.000Z'),
        pid: 9876, code: 1, signal: null, reason: 'uncaught-exception:boom',
        uptimeMs: 65432, serviceSnapshot: { up: 3, total: 9 }, previousPid: 1111,
    });
    ok('death.json 含全部约定字段', ['at', 'pid', 'code', 'signal', 'reason', 'uptimeMs', 'lastServiceSnapshot']
        .every((k) => Object.prototype.hasOwnProperty.call(rec, k)));
    ok('death.json at 是 ISO 时间', rec.at === '2026-11-25T10:00:00.000Z', rec.at);
    ok('death.json 保留 code/reason/uptime', rec.code === 1 && rec.reason === 'uncaught-exception:boom' && rec.uptimeMs === 65432);
    ok('death.json 保留 previousPid', rec.previousPid === 1111, String(rec.previousPid));
    ok('lastServiceSnapshot 默认是对象', typeof buildDeathRecord({}).lastServiceSnapshot === 'object');
    ok('signal 显式写入', buildDeathRecord({ signal: 'SIGTERM' }).signal === 'SIGTERM');

    const deathPath = process.env.PET_LAUNCHER_DEATH;
    ok('writeDeathRecord 成功', writeDeathRecord(deathPath, rec) === true);
    const back = readDeathRecord(deathPath);
    ok('readDeathRecord 往返一致', back.pid === 9876 && back.reason === 'uncaught-exception:boom' && back.previousPid === 1111);
    ok('坏 JSON 读返回 null', (() => {
        fs.writeFileSync(path.join(TMP, 'bad.json'), '{oops');
        return readDeathRecord(path.join(TMP, 'bad.json')) === null;
    })());
    ok('死因写失败不抛（父路径是文件）', (() => {
        try { return writeDeathRecord(path.join(blocker, 'x.json'), rec) === false; }
        catch (e) { return false; }
    })());

    // ── 陈旧锁三类 ────────────────────────────────────────────────────────
    ok('无锁不判陈旧', classifyStaleLock(null) === null);
    const gone = classifyStaleLock({ pid: 12345, startedAt: 1 }, {
        isAlive: () => false, isHolder: () => true, heartbeatTimeoutMs: 180000,
    });
    ok('pid 不存在 → pid-gone', gone && gone.reason === 'pid-gone' && gone.message.includes('不存在'), gone && gone.message);
    const notLauncher = classifyStaleLock({ pid: 12345, startedAt: 1 }, {
        isAlive: () => true, isHolder: () => false, heartbeatTimeoutMs: 180000,
    });
    ok('不是 launcher → not-launcher', notLauncher && notLauncher.reason === 'not-launcher'
        && notLauncher.message.includes('不是 launcher'), notLauncher && notLauncher.message);
    const now = 1700000000000;
    const hbStale = classifyStaleLock({ pid: 12345, startedAt: 1, heartbeatAt: now - 200000 }, {
        isAlive: () => true, isHolder: () => true, heartbeatTimeoutMs: 180000, now,
    });
    ok('心跳超时 → heartbeat-timeout', hbStale && hbStale.reason === 'heartbeat-timeout'
        && hbStale.message.includes('心跳超时'), hbStale && hbStale.message);
    ok('心跳新鲜 → 锁有效', classifyStaleLock({ pid: 12345, startedAt: 1, heartbeatAt: now - 60000 }, {
        isAlive: () => true, isHolder: () => true, heartbeatTimeoutMs: 180000, now,
    }) === null);
    ok('旧版锁无 heartbeatAt → 不因启动久误判', classifyStaleLock({ pid: 12345, startedAt: 1 }, {
        isAlive: () => true, isHolder: () => true, heartbeatTimeoutMs: 180000, now,
    }) === null);

    // ── 陈旧锁接管：staleReason 允许越过「pid 活着」──
    const lockPath = process.env.PET_LAUNCHER_LOCK;
    const first = acquireInstanceLock(lockPath, { pid: 11111, now, isAlive: () => true, isHolder: () => true });
    ok('先写一把有效锁', first.ok === true);
    const held = acquireInstanceLock(lockPath, { pid: 22222, now: now + 1, isAlive: () => true, isHolder: () => true });
    ok('正常情况拒绝双开', held.ok === false && held.reason === 'held');
    const take = acquireInstanceLock(lockPath, {
        pid: 33333, now: now + 2, isAlive: () => true, isHolder: () => true, staleReason: 'heartbeat-timeout',
    });
    ok('带 staleReason 强制接管', take.ok === true && take.previous && take.previous.pid === 11111);

    // ── 心跳刷新锁里的 heartbeatAt ────────────────────────────────────────
    const touched = touchLockHeartbeat(lockPath, 33333, now + 60000);
    ok('touchLockHeartbeat 成功', touched === true);
    ok('锁 heartbeatAt 已更新', readInstanceLock(lockPath).heartbeatAt === now + 60000);

    console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
    process.exitCode = fail ? 1 : 0;
})().catch((e) => {
    console.error('测试异常:', e && e.stack || e);
    process.exitCode = 1;
});
