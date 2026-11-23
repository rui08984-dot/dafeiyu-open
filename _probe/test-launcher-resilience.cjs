'use strict';
/**
 * test-launcher-resilience.cjs —— 启动器韧性回归（2026-11-21 六缺陷修复的守卫）
 *
 * 设计原则：**纯 node，不真起宿主、不杀真实进程、不碰 9883/8020/8120**。
 * 全部用依赖注入的假 spawn / 临时目录 / 可控时钟，跑完即退。
 *
 * 覆盖：
 *   T1  TTS 闸门：spawn 抛错 → 闸门复位并重试（旧实现 __ttsStarting 永不复位）
 *   T2  TTS 闸门：子进程 exit → 闸门复位并重试（核心缺陷 1 的复现路径）
 *   T3  TTS 闸门：spawn 成功但启动超时 → 杀掉并重试
 *   T4  单实例锁：第二个 launcher 被拒绝，且能读到持有者 pid/启动时间
 *   T5  单实例锁：持有者已死（崩溃残留）→ 接管；释放后重取成功
 *   T6  watchdog 失败计数：时间窗内累积，6 次内不退避，第 7 次起 30/60/120s
 *   T7  watchdog 计数：每轮都「活过 60s」的崩溃风暴不再清零（旧实现的上限永不触发）
 *   T8  服务清单：services.json 可解析、端口唯一、含 8020/8120、不含共用 8090
 *
 * 用法：node _probe/test-launcher-resilience.cjs
 *      （可加 PET_TEST_VERBOSE=1 看每条断言细节）
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

const LAUNCHER = path.resolve(__dirname, '..', 'pet-runtime', 'tools', 'launch-my-neuro.mjs');
const SERVICES = path.resolve(__dirname, '..', 'pet-runtime', 'tools', 'services.json');
const VERBOSE = process.env.PET_TEST_VERBOSE === '1';

let pass = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('PASS  ' + name);
  } catch (e) {
    failures.push({ name, error: e });
    console.log('FAIL  ' + name);
    console.log('      ' + String((e && e.message) || e).split('\n').join('\n      '));
  }
}

function fakeChild(label) {
  const c = new EventEmitter();
  c.pid = 90000 + Math.floor(Math.random() * 1000);
  c.label = label;
  c.exitCode = null;
  c.killed = false;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => { c.killed = true; };
  return c;
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pet-launcher-' + tag + '-'));
}

(async () => {
  const mod = await import(pathToFileURL(LAUNCHER).href);
  const { createTtsGate, createFailurePolicy, acquireInstanceLock, readInstanceLock, releaseInstanceLock, updateLockPids, loadServicesManifest } = mod;

  // ── T1/T2/T3：TTS 闸门 ────────────────────────────────────────────────
  await test('T1 TTS 闸门：spawn 抛错后复位并重试（不得永久「已在启动中」）', async () => {
    assert.equal(typeof createTtsGate, 'function', 'launch-my-neuro.mjs 必须导出 createTtsGate');
    let attempts = 0;
    const gate = createTtsGate({
      log: () => {},
      spawnChild: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('模拟 spawn 失败');
        return fakeChild('t1');
      },
      retryDelayMs: 10,
      startTimeoutMs: 5000,
      probe: null,
    });
    const r = gate.start();
    assert.equal(r.started, false);
    assert.equal(r.reason, 'spawn-error');
    assert.equal(gate.state().starting, false, 'spawn 失败后闸门必须复位');
    await sleep(80);
    assert.equal(attempts, 2, '失败后必须自动重试（实际尝试 ' + attempts + ' 次）');
    assert.equal(gate.state().hasChild, true);
    gate.stop();
  });

  await test('T2 TTS 闸门：子进程 exit 后复位并重试（缺陷 1 的复现路径）', async () => {
    const children = [];
    const gate = createTtsGate({
      log: () => {},
      spawnChild: () => { const c = fakeChild('t2-' + children.length); children.push(c); return c; },
      retryDelayMs: 10,
      startTimeoutMs: 5000,
      probe: null,
    });
    const r1 = gate.start();
    assert.equal(r1.started, true);
    assert.equal(gate.state().starting, false, 'spawn 成功后闸门不能一直挂着');
    assert.equal(children.length, 1);

    // 模拟 edge-tts 崩溃
    children[0].exitCode = 1;
    children[0].emit('exit', 1, null);
    await sleep(80);
    assert.equal(children.length, 2, '子进程退出后必须重新拉起（旧实现被 __ttsStarting 挡死）');
    assert.equal(gate.state().hasChild, true);

    // 第二次再崩，仍要能重试（不能只复位一次）
    children[1].exitCode = 1;
    children[1].emit('exit', 7, null);
    await sleep(80);
    assert.equal(children.length, 3, '连续崩溃也必须持续重试');
    gate.stop();
  });

  await test('T3 TTS 闸门：spawn 成功但启动超时 → 杀掉并重试', async () => {
    const children = [];
    const gate = createTtsGate({
      log: () => {},
      spawnChild: () => { const c = fakeChild('t3-' + children.length); children.push(c); return c; },
      retryDelayMs: 10,
      startTimeoutMs: 30,
      probe: async () => false,          // 9883 始终没就绪
    });
    gate.start();
    await sleep(120);
    assert.equal(children[0].killed, true, '超时后必须杀掉卡住的子进程');
    assert.ok(children.length >= 2, '超时后必须重试（实际 ' + children.length + ' 次）');
    assert.equal(gate.state().starting, false);
    gate.stop();
  });

  // ── T4/T5：单实例锁 ──────────────────────────────────────────────────
  await test('T4 单实例锁：第二个 launcher 被拒绝并报出持有者 pid/启动时间', async () => {
    assert.equal(typeof acquireInstanceLock, 'function', '必须导出 acquireInstanceLock');
    const dir = tmpDir('lock1');
    const lockPath = path.join(dir, 'launcher.lock');
    const first = acquireInstanceLock(lockPath, { pid: 11111, now: 1700000000000, isAlive: () => true });
    assert.equal(first.ok, true);
    assert.equal(first.lock.pid, 11111);
    assert.ok(first.lock.startedAtISO, '锁文件必须带启动时间');

    const second = acquireInstanceLock(lockPath, { pid: 22222, now: 1700000001000, isAlive: (pid) => Number(pid) === 11111 });
    assert.equal(second.ok, false, '第二个实例必须被锁拒绝');
    assert.equal(second.reason, 'held');
    assert.equal(second.holder.pid, 11111, '必须能打印「已有实例 pid=N」');

    const onDisk = readInstanceLock(lockPath);
    assert.equal(onDisk.pid, 11111, '被拒绝者不能改写别人的锁');
  });

  await test('T5 单实例锁：持有者已死则接管；释放后可重取', async () => {
    const dir = tmpDir('lock2');
    const lockPath = path.join(dir, 'launcher.lock');
    acquireInstanceLock(lockPath, { pid: 33333, now: 1700000000000, isAlive: () => true });

    // 崩溃残留：pid 已不存在
    const takeover = acquireInstanceLock(lockPath, { pid: 44444, now: 1700000002000, isAlive: () => false });
    assert.equal(takeover.ok, true, '陈旧锁必须能被接管，否则崩溃后再也起不来');
    assert.equal(takeover.previous.pid, 33333);

    assert.equal(updateLockPids(lockPath, 44444, [55555, 66666]), true);
    const withPids = readInstanceLock(lockPath);
    assert.deepEqual(withPids.spawnedPids.sort((a, b) => a - b).slice(0, 3), [44444, 55555, 66666].sort((a, b) => a - b).slice(0, 3));

    assert.equal(releaseInstanceLock(lockPath, 44444), true);
    assert.equal(readInstanceLock(lockPath), null);
    assert.equal(acquireInstanceLock(lockPath, { pid: 77777, isAlive: () => true }).ok, true);
  });

  // ── T6/T7：watchdog 失败计数与退避 ───────────────────────────────────
  await test('T6 watchdog：时间窗内累积，第 7 次起 30s/60s/120s 退避', async () => {
    assert.equal(typeof createFailurePolicy, 'function', '必须导出 createFailurePolicy');
    const p = createFailurePolicy({ windowMs: 600000, maxFails: 6, backoffMs: [30000, 60000, 120000] });
    const t0 = 1000000;
    const got = [];
    for (let i = 0; i < 9; i += 1) got.push(p.fail(t0 + i * 1000).delayMs);
    assert.deepEqual(got, [0, 0, 0, 0, 0, 0, 30000, 60000, 120000], '退避序列不对：' + JSON.stringify(got));
    assert.equal(p.fail(t0 + 9000).delayMs, 120000, '退避必须封顶在 120s，不能无限增长');
  });

  await test('T7 watchdog：每轮都「活过 60s」的崩溃风暴仍会累积（旧实现永远清零）', async () => {
    const p = createFailurePolicy({ windowMs: 600000, maxFails: 6, backoffMs: [30000, 60000, 120000] });
    // 每 60 秒崩一次：旧实现每次 lived>60s 都 restarts=0，上限永远到不了。
    let verdict = null;
    for (let i = 0; i < 7; i += 1) {
      const now = 2000000 + i * 60000;
      p.ok(now);                       // 成功探测也不能清零窗口内的失败
      verdict = p.fail(now);
      if (i < 6) assert.equal(verdict.delayMs, 0, '第 ' + (i + 1) + ' 次不应退避');
    }
    assert.equal(verdict.fails, 7);
    assert.equal(verdict.delayMs, 30000, '第 7 次必须开始退避，否则就是每 45s 无限杀');
  });

  // ── T8：服务清单一致性 ───────────────────────────────────────────────
  await test('T8 services.json：可解析、端口唯一、含 8020/8120、不含共用 8090', async () => {
    assert.ok(fs.existsSync(SERVICES), '缺少 pet-runtime/tools/services.json');
    const m = loadServicesManifest();
    assert.ok(Array.isArray(m.services) && m.services.length >= 10, '服务清单条目过少');
    const ports = m.services.map((s) => Number(s.port));
    assert.equal(new Set(ports).size, ports.length, '端口重复：' + ports.join(','));
    for (const need of [8020, 8120, 9883, 8103, 8003]) {
      assert.ok(ports.includes(need), '清单缺端口 ' + need);
    }
    assert.ok(!ports.includes(8090), '8090 是共用基础设施，绝不能进 kill 清单');
    for (const s of m.services) {
      assert.ok(s.id && s.name && Number(s.port) > 0, '服务条目缺 id/name/port: ' + JSON.stringify(s));
      assert.equal(typeof s.required, 'boolean', s.id + ' 缺 required 字段');
      assert.ok(['launcher', 'electron', 'external'].includes(s.launchBy), s.id + ' 的 launchBy 非法');
    }
  });

  // ── T9：kill-all 与 doctor 是否真的读同一份清单 ──────────────────────
  await test('T9 kill-all -DryRun：端口列表 == services.json，含 8020/8120，且不杀进程', async () => {
    const { spawnSync } = require('node:child_process');
    const script = path.resolve(__dirname, '..', 'pet-runtime', 'tools', 'kill-all-pet.ps1');
    const r = spawnSync('pwsh', ['-NoProfile', '-File', script, '-DryRun'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const out = String(r.stdout || '') + String(r.stderr || '');
    assert.equal(r.status, 0, 'DryRun 必须退出码 0；输出：' + out.slice(0, 400));
    const line = out.split(/\r?\n/).find((l) => l.startsWith('[manifest] services.json')) || '';
    assert.ok(line, '缺少 [manifest] 行：' + out.slice(0, 400));
    const listed = (line.split(':').pop() || '').split(',').map((x) => Number(x.trim())).filter(Boolean);
    const expected = loadServicesManifest().services.map((s) => Number(s.port));
    assert.deepEqual(listed.sort((a, b) => a - b), expected.sort((a, b) => a - b),
      'kill-all 的端口列表必须与 services.json 完全一致（单一事实源）');
    assert.ok(listed.includes(8020) && listed.includes(8120), 'kill-all 必须覆盖 8020/8120');
    assert.ok(!listed.includes(8090), '共用基础设施 8090 不得被 kill-all 覆盖');
    assert.ok(out.includes('no process killed'), 'DryRun 必须明确声明未杀进程（ASCII 标记）');
  });

  // ── 汇总 ────────────────────────────────────────────────────────────
  const total = pass + failures.length;
  console.log('');
  if (failures.length) {
    console.log('FAILED  ' + failures.length + '/' + total + ' 项失败');
    for (const f of failures) console.log('  - ' + f.name + ': ' + String((f.error && f.error.message) || f.error).split('\n')[0]);
    process.exit(1);
  }
  console.log('ALL PASS  ' + pass + '/' + total + ' 项（启动器韧性 + 服务清单）');
  if (VERBOSE) console.log('launcher module =', LAUNCHER);
  process.exit(0);
})().catch((e) => {
  console.error('测试框架自身崩溃：', e);
  process.exit(2);
});
