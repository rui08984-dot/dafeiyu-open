// _probe/test-mind-kernel-plugin.cjs —— mind-kernel 接线单测（装配层）
//
// 只测「插件装配 + 注入行为」，纯逻辑已由 test-mind-kernel.cjs 覆盖 124 断言。
// 全部用 os.tmpdir() 临时目录，绝不碰真实 data。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_DIR = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'mind-kernel');
const MindKernelPlugin = require(path.join(PLUGIN_DIR, 'index.js'));

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
    if (cond) { pass += 1; return; }
    fail += 1;
    failures.push(name + (detail ? '：' + detail : ''));
}

function eq(name, actual, expected) {
    ok(name, actual === expected, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}

function makeTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mk-plugin-'));
}

function makeGoal(over) {
    const now = Date.now();
    return Object.assign({
        id: 'g1',
        parentId: null,
        title: '把桌面上的报告发给他',
        doneWhen: '邮件已发送且附件大小为 2MB',
        status: 'queued',
        priority: 5,
        createdAt: now,
        updatedAt: now,
        budget: { maxSteps: 20, maxLlmCalls: 4, maxWallMs: 600000 },
        used: { steps: 0, llmCalls: 0, wallMs: 0 },
        attempts: 0,
        replans: 0,
        lastError: null,
        expiresAt: null,
        rev: 1,
    }, over || {});
}

function makeCtx(cfg) {
    return {
        getPluginFileConfig() { return cfg; },
        log() {},
    };
}

(async () => {
    const tmp = makeTmp();
    const goalsFile = path.join(tmp, 'goals.json');
    const ledgerFile = path.join(tmp, 'goal-ledger.jsonl');

    // 预置一个 active 目标：验证 onInit 时 active→paused（重启规则）
    fs.writeFileSync(goalsFile, JSON.stringify({
        schemaVersion: 1,
        goals: [makeGoal({ status: 'active', plan: { goalId: 'g1', cursor: 0, rev: 1, lines: [] } })],
    }, null, 2), 'utf8');

    const cfg = { enabled: true, inject_plan_line: true, tick_ms: 60000, max_tail_chars: 150, goals_file: goalsFile, ledger_file: ledgerFile };
    const plugin = new MindKernelPlugin({ name: 'mind-kernel' }, makeCtx(cfg));
    await plugin.onInit();

    const afterLoad = JSON.parse(fs.readFileSync(goalsFile, 'utf8')).goals;
    eq('onInit 后 active 转 paused（重启规则）', afterLoad[0].status, 'paused');
    ok('onInit 后 rev 自增（可审计）', afterLoad[0].rev > 1, 'rev=' + afterLoad[0].rev);

    // 没有 active → 不注入
    let injected = [];
    await plugin.onLLMRequest({ addVolatile: (t) => injected.push(t) });
    eq('无 active 目标时不注入', injected.length, 0);

    // 造一个带 plan 的 active 目标
    plugin._goals = [makeGoal({
        status: 'active',
        used: { steps: 3, llmCalls: 1, wallMs: 1000 },
        plan: {
            goalId: 'g1', cursor: 1, rev: 1,
            lines: [
                { id: 'l1', title: '打开邮件客户端', status: 'done', t2: '窗口标题含「写邮件」', evidence: [], attempts: 1, lastError: null },
                { id: 'l2', title: '填收件人并附上报告', status: 'running', t2: '附件列表非空', evidence: [], attempts: 0, lastError: null },
                { id: 'l3', title: '发送并确认已送达', status: 'pending', t2: '已发送文件夹有记录', evidence: [], attempts: 0, lastError: null },
            ],
        },
    })];

    injected = [];
    await plugin.onLLMRequest({ addVolatile: (t) => injected.push(t) });
    eq('计划存在时注入 1 条', injected.length, 1);
    const line = injected[0] || '';
    ok('注入行含目标与步数', /📋/.test(line) && /步 3\/20/.test(line), line);
    ok('注入行含下一步', /下一步/.test(line), line);
    ok('注入行 ≤ max_tail_chars', line.length <= 150, 'len=' + line.length);

    injected = [];
    await plugin.onLLMRequest({ addVolatile: (t) => injected.push(t) });
    eq('计划未变时不重复注入', injected.length, 0);

    // 计划变化 → 再注入
    plugin._goals[0].plan.cursor = 2;
    plugin._goals[0].used.steps = 4;
    injected = [];
    await plugin.onLLMRequest({ addVolatile: (t) => injected.push(t) });
    eq('计划变化后再次注入', injected.length, 1);
    ok('新注入行反映新游标', /步 4\/20/.test(injected[0] || ''), injected[0]);

    // 超长标题被截断
    plugin._goals[0].title = '这是一个非常非常非常非常非常非常长的目标标题用来验证截断逻辑是否真的生效并且不会超过上限';
    plugin._goals[0].plan = null;
    plugin._lastTail = '';
    injected = [];
    await plugin.onLLMRequest({ addVolatile: (t) => injected.push(t) });
    eq('长标题仍注入 1 条', injected.length, 1);
    ok('长标题被截断到上限内', (injected[0] || '').length <= 150, 'len=' + (injected[0] || '').length);

    // 关闭时不注入
    const off = new MindKernelPlugin({ name: 'mind-kernel' }, makeCtx(Object.assign({}, cfg, { enabled: false })));
    await off.onInit();
    off._goals = [makeGoal({ status: 'active' })];
    injected = [];
    await off.onLLMRequest({ addVolatile: (t) => injected.push(t) });
    eq('enabled=false 时不注入', injected.length, 0);
    await off.onStart();
    eq('enabled=false 时不启动 tick', off._timer, null);

    // onStart 启动、onStop 清理
    await plugin.onStart();
    ok('onStart 后 timer 存在', !!plugin._timer);
    await plugin.onStop();
    eq('onStop 后 timer 清空', plugin._timer, null);

    // 手动 tick 能跑通并落 ledger（arbiter 无动作时不写）
    const before = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').length : 0;
    plugin._goals = [makeGoal({ status: 'queued' })];
    await plugin._tick();
    const after = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').length : 0;
    // queued 且无 active → arbiter 发 start，应写 ledger
    ok('queued 时 tick 触发 start 并写 ledger', after > before, 'before=' + before + ' after=' + after);

    // 关键回归：tick 的 start 不能被「重启规则」立刻打回 paused（load vs list 的坑）
    const afterTick = JSON.parse(fs.readFileSync(goalsFile, 'utf8')).goals.find((g) => g.id === 'g1');
    eq('tick start 后磁盘上的目标保持 active', afterTick && afterTick.status, 'active');
    const memGoal = (plugin._goals || []).find((g) => g.id === 'g1');
    eq('tick start 后内存里的目标保持 active', memGoal && memGoal.status, 'active');

    // 活动门：world-sense 报 gaming → active 目标被 pause
    globalThis.__worldSenseState = () => ({ activity: { state: 'gaming' }, changes: [] });
    await plugin._tick();
    const paused = (plugin._goals || []).find((g) => g.id === 'g1');
    eq('gaming 时 active 目标被 pause（活动门）', paused && paused.status, 'paused');

    // 事件优先：changes 比上次 tick 新 → onLLMRequest 触发一次提前 tick
    delete globalThis.__worldSenseState;
    plugin._lastTickAt = Date.now() - 60000; // 假装上次 tick 在 1 分钟前
    const tickBefore = plugin._tickCount;
    globalThis.__worldSenseState = () => ({ activity: { state: 'active' }, changes: [{ at: Date.now() }] });
    await plugin.onLLMRequest({ addVolatile: () => {} });
    ok('世界有新变化时提前 tick（事件优先）', plugin._tickCount > tickBefore, 'tickCount ' + tickBefore + ' → ' + plugin._tickCount);
    delete globalThis.__worldSenseState;

    // ── 入口：addGoalForTask / finishGoal（dispatch 桥）────────────────────
    // 清空成一个干净场景：无 active、无 queued
    plugin._goals = [];
    fs.writeFileSync(goalsFile, JSON.stringify({ schemaVersion: 1, goals: [] }), 'utf8');
    plugin._store = require(path.join(PLUGIN_DIR, 'lib', 'goal-store.js')).createStore({
        file: goalsFile,
        readJson: (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } },
        writeJson: (f, d) => fs.writeFileSync(f, JSON.stringify(d), 'utf8'),
        now: () => Date.now(),
    });
    plugin._goals = plugin._store.load();

    const gid = plugin.addGoalForTask({ title: '整理桌面的报告并发邮件', doneWhen: '邮件已发送', kind: 'dsh' });
    ok('addGoalForTask 返回 goalId', typeof gid === 'string' && gid.length > 3, String(gid));
    const g1 = (plugin._goals || []).find((g) => g.id === gid);
    eq('第一个 goal 立刻 active', g1 && g1.status, 'active');
    ok('goal 带单步 plan', g1 && g1.plan && g1.plan.lines.length === 1);

    const gid2 = plugin.addGoalForTask({ title: '第二个任务' });
    const g2 = (plugin._goals || []).find((g) => g.id === gid2);
    eq('已有 active 时新 goal 进 queued', g2 && g2.status, 'queued');

    // 注入行应反映第一个 active 目标
    plugin._lastTail = '';
    injected = [];
    await plugin.onLLMRequest({ addVolatile: (t) => injected.push(t) });
    eq('有 active 目标后注入 1 条', injected.length, 1);
    ok('注入行含标题片段', /整理桌面/.test(injected[0] || ''), injected[0]);

    // finishGoal：done + 记账（steps/wallMs）
    const okFin = plugin.finishGoal(gid, { ok: true, wallMs: 5000, steps: 3 });
    eq('finishGoal 返回 true', okFin, true);
    const g1b = (plugin._goals || []).find((g) => g.id === gid);
    eq('finishGoal 后状态 done', g1b && g1b.status, 'done');
    ok('finishGoal 记账 steps=3', g1b && g1b.used && g1b.used.steps === 3, JSON.stringify(g1b && g1b.used));

    // 失败回写
    const okFail = plugin.finishGoal(gid2, { ok: false, error: 'QUOTA', wallMs: 1000, steps: 1 });
    eq('失败 finishGoal 返回 true', okFail, true);
    const g2b = (plugin._goals || []).find((g) => g.id === gid2);
    eq('失败 finishGoal 后状态 failed', g2b && g2b.status, 'failed');

    // enabled=false：桥接函数不挂载/不生效
    const offPlugin = new MindKernelPlugin({ name: 'mind-kernel' }, makeCtx(Object.assign({}, cfg, { enabled: false })));
    await offPlugin.onInit();
    eq('enabled=false 时 addGoalForTask 返回 null', offPlugin.addGoalForTask({ title: 'x' }), null);
    eq('enabled=false 时 finishGoal 返回 false', offPlugin.finishGoal('g1', { ok: true }), false);

    // ── 2026-11-21 arbiter 接线：预算/过期/熔断从「不可达」变「可达」──────────
    // 1) 预算耗尽 → paused（不是 done/failed）
    plugin._goals = [];
    fs.writeFileSync(goalsFile, JSON.stringify({ schemaVersion: 1, goals: [] }), 'utf8');
    plugin._store = require(path.join(PLUGIN_DIR, 'lib', 'goal-store.js')).createStore({
        file: goalsFile,
        readJson: (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } },
        writeJson: (f, d) => fs.writeFileSync(f, JSON.stringify(d), 'utf8'),
        now: () => Date.now(),
    });
    plugin._goals = plugin._store.load();
    const gb = plugin.addGoalForTask({ title: '预算测试', doneWhen: 'x', budget: { maxSteps: 1, maxLlmCalls: 4, maxWallMs: 600000 } });
    // 预算压到 1 步，然后完成时消费 2 步
    plugin.finishGoal(gb, { ok: true, steps: 2, wallMs: 100 });
    const gbAfter = (plugin._goals || []).find((g) => g.id === gb);
    eq('预算耗尽后 goal 变 paused（不是 done）', gbAfter && gbAfter.status, 'paused');

    // 2) 过期 → abandoned
    plugin._goals = [];
    fs.writeFileSync(goalsFile, JSON.stringify({ schemaVersion: 1, goals: [] }), 'utf8');
    plugin._store = require(path.join(PLUGIN_DIR, 'lib', 'goal-store.js')).createStore({
        file: goalsFile,
        readJson: (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } },
        writeJson: (f, d) => fs.writeFileSync(f, JSON.stringify(d), 'utf8'),
        now: () => Date.now(),
    });
    plugin._goals = plugin._store.load();
    const ge = plugin.addGoalForTask({ title: '过期测试', doneWhen: 'x', expiresAt: Date.now() - 5000 });
    plugin._goals = plugin._store.list();
    await plugin._tick();
    const geAfter = (plugin._goals || []).find((g) => g.id === ge);
    eq('过期 goal 被 abandoned', geAfter && geAfter.status, 'abandoned');

    // 3) 熔断 ≥3 → reject → paused
    plugin._goals = [];
    fs.writeFileSync(goalsFile, JSON.stringify({ schemaVersion: 1, goals: [] }), 'utf8');
    plugin._store = require(path.join(PLUGIN_DIR, 'lib', 'goal-store.js')).createStore({
        file: goalsFile,
        readJson: (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } },
        writeJson: (f, d) => fs.writeFileSync(f, JSON.stringify(d), 'utf8'),
        now: () => Date.now(),
    });
    plugin._goals = plugin._store.load();
    const gf = plugin.addGoalForTask({ title: '熔断测试', doneWhen: 'x' });
    plugin._goals = plugin._store.list();
    for (let i = 0; i < 3; i++) plugin.recordFailure({ key: 'dispatch|same-intent', goalId: gf });
    const bs = plugin._breakerState();
    ok('breakerState 带 goalId', !!bs['dispatch|same-intent'] && bs['dispatch|same-intent'].goalId === gf, JSON.stringify(bs));
    await plugin._tick();
    const gfAfter = (plugin._goals || []).find((g) => g.id === gf);
    eq('熔断 3 次后 goal 被 paused（reject）', gfAfter && gfAfter.status, 'paused');

    // debugState 形状
    const dbg = plugin.debugState();
    ok('debugState 含关键字段', dbg && dbg.goalsFile === goalsFile && typeof dbg.tickCount === 'number');

    // 清理
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不影响判定 */ }

    if (failures.length) {
        console.error('❌ mind-kernel 接线：FAIL ' + fail + ' / PASS ' + pass);
        for (const f of failures) console.error('   - ' + f);
        process.exit(1);
    }
    console.log('  ✅ mind-kernel 接线：PASS ' + pass + ' / FAIL 0');
})();
