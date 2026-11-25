// _probe/test-mind-kernel-plan-progress.cjs —— B6：consume 回写 + 跨步评测（2026-11-23）
//
// 覆盖：
//   ① done_verified / done_unproven → cursor 前进（steps 对齐，至少 +1）；
//   ② failed → cursor 冻结，当前行标 failed + lastError（保留现场）；
//   ③ unknown / cancelled → 目标 paused（不是 failed），cursor 不推进；
//   ④ cursor 钳制（steps 超长不越界、目标位置永不后退）；
//   ⑤ 终态幂等（二次 finish 不改状态/cursor、不重复 plan-advance）；
//   ⑥ 预算耗尽 → paused，cursor 冻结；
//   ⑦ plan-advance ledger 行（old/new cursor / outcome / advanced）；
//   ⑧ tailLine 末尾文案、无 plan / 落盘失败降级；
//   ⑨ generatePlan 重规划只替换 cursor 之后（前缀逐字段不变）、终态/已完成不再改写；
//   ⑩ 3 条 agent-eval 跨步任务（agent-eval/cross-step-tasks.mjs）全部跑过。
// 全部用 os.tmpdir() 临时目录；不调真实模型、不碰真实记录室。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 数据根隔离（A2 同款，2026-11-24）：⑨ 的 generatePlan 要过后台花费闸（llm-health 读
// RECORDS_DIR/LLM健康.json）。不隔离的话，宿主配额暂停期间本测试会整片变红。**先于 require**。
process.env.PET_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-plan-prog-root-'));

const PLUGIN_DIR = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'mind-kernel');
const MindKernelPlugin = require(path.join(PLUGIN_DIR, 'index.js'));
const planStore = require(path.join(PLUGIN_DIR, 'lib', 'plan-store.js'));

let pass = 0;
let fail = 0;
const failures = [];
const tmpDirs = [];

function ok(name, cond, detail) {
    if (cond) { pass += 1; return; }
    fail += 1;
    failures.push(name + (detail ? '：' + detail : ''));
}
function eq(name, actual, expected) {
    ok(name, actual === expected, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}
function makeTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-progress-'));
    tmpDirs.push(d);
    return d;
}
function readLedger(file) {
    try {
        return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
            try { return JSON.parse(l); } catch (e) { return null; }
        }).filter(Boolean);
    } catch (e) { return []; }
}
function diskGoal(goalsFile, gid) {
    try {
        const j = JSON.parse(fs.readFileSync(goalsFile, 'utf8'));
        return (j.goals || []).find((g) => g.id === gid) || null;
    } catch (e) { return null; }
}

async function setup(cfgOver, llmImpl) {
    const tmp = makeTmp();
    const goalsFile = path.join(tmp, 'goals.json');
    const ledgerFile = path.join(tmp, 'goal-ledger.jsonl');
    const state = { calls: 0, lastPrompt: '', lastOptions: null };
    const cfg = Object.assign({
        enabled: true,
        inject_plan_line: true,
        tick_ms: 3600000,
        max_tail_chars: 150,
        goals_file: goalsFile,
        ledger_file: ledgerFile,
        plan_generate: true,
        plan_max_steps: 8,
        plan_timeout_ms: 300,
    }, cfgOver || {});
    const ctx = {
        getPluginFileConfig() { return cfg; },
        log() {},
        callLLM(prompt, options) {
            state.calls += 1;
            state.lastPrompt = String(prompt || '');
            state.lastOptions = options || null;
            return llmImpl ? llmImpl(prompt, options) : Promise.resolve('{"steps":[]}');
        },
    };
    const p = new MindKernelPlugin({ name: 'mind-kernel' }, ctx);
    await p.onInit();
    return { p, cfg, goalsFile, ledgerFile, state, tmp };
}

/**
 * 建 goal 并注入一个确定性 plan（等价于 generatePlan 成功产物）。
 * @param {object} p
 * @param {{titles?:string[], cursor?:number, budget?:object, doneStatuses?:string[]}} opts
 */
function seedGoal(p, opts) {
    const o = opts || {};
    const titles = o.titles || ['第一步', '第二步', '第三步'];
    const gid = p.addGoalForTask({
        title: o.title || '跨步测试目标',
        doneWhen: '外部判据',
        budget: o.budget,
    });
    const g = p._store.get(gid);
    const plan = {
        goalId: gid,
        cursor: Number.isInteger(o.cursor) ? o.cursor : 0,
        rev: Math.max(0, Number(g.plan && g.plan.rev) || 0) + 1,
        lines: titles.map((t, i) => ({
            id: gid + '-t' + (i + 1),
            title: t,
            // cursor 之前默认 done（模拟已执行前缀）
            status: (o.doneStatuses && o.doneStatuses[i]) ||
                ((Number.isInteger(o.cursor) && i < o.cursor) ? 'done' : 'pending'),
            t2: t + '的外部判据',
            evidence: (Number.isInteger(o.cursor) && i < o.cursor) ? ['seed'] : [],
            attempts: 0,
            lastError: null,
        })),
    };
    const r = p._store.update(gid, { plan }, { expectedRev: g.rev });
    if (!r || r.ok !== true) throw new Error('seedGoal plan 注入失败：' + JSON.stringify(r));
    p._goals = p._store.list();
    p._lastTail = '';
    return gid;
}

function lastPlanAdvance(ledgerFile) {
    const rows = readLedger(ledgerFile).filter((r) => r.kind === 'plan-advance');
    return rows.length ? rows[rows.length - 1] : null;
}

(async () => {
    // ── ① done_verified：按 steps 前进 ────────────────────────────────────
    {
        const s = await setup();
        const gid = seedGoal(s.p, { titles: ['A', 'B', 'C', 'D'] });
        eq('done_verified：finish 返回 true', s.p.finishGoal(gid, { ok: true, outcome: 'done_verified', steps: 2, wallMs: 10 }), true);
        const g = s.p._store.get(gid);
        eq('done_verified：状态 done', g.status, 'done');
        eq('done_verified：cursor=2（steps 对齐）', g.plan.cursor, 2);
        eq('done_verified：前两行 done', g.plan.lines.slice(0, 2).map((l) => l.status).join(','), 'done,done');
        eq('done_verified：后两行仍 pending', g.plan.lines.slice(2).map((l) => l.status).join(','), 'pending,pending');
        ok('done_verified：已消费行带 evidence', g.plan.lines[0].evidence.includes('done_verified'), JSON.stringify(g.plan.lines[0].evidence));
        eq('done_verified：落盘 cursor=2', diskGoal(s.goalsFile, gid).plan.cursor, 2);
        const adv = lastPlanAdvance(s.ledgerFile);
        ok('done_verified：ledger plan-advance 存在', !!adv);
        eq('done_verified：ledger outcome', adv && adv.outcome, 'done_verified');
        eq('done_verified：ledger oldCursor=0', adv && adv.oldCursor, 0);
        eq('done_verified：ledger newCursor=2', adv && adv.newCursor, 2);
        eq('done_verified：ledger advanced=2', adv && adv.advanced, 2);
        eq('done_verified：ledger total=4', adv && adv.total, 4);
        await s.p.onDestroy();
    }

    // ── ①b done_unproven：至少 +1（steps 缺省/0）─────────────────────────
    {
        const s = await setup();
        const gid = seedGoal(s.p, { titles: ['A', 'B', 'C'] });
        s.p.finishGoal(gid, { ok: true, outcome: 'done_unproven' });
        const g = s.p._store.get(gid);
        eq('done_unproven：状态 done_unproven', g.status, 'done_unproven');
        eq('done_unproven：cursor=1（至少 +1）', g.plan.cursor, 1);
        eq('done_unproven：首行 done', g.plan.lines[0].status, 'done');
        eq('done_unproven：ledger advanced=1', lastPlanAdvance(s.ledgerFile).advanced, 1);
        await s.p.onDestroy();
    }

    // ── ② failed：冻结 cursor + 当前行留现场 ──────────────────────────────
    {
        const s = await setup();
        const gid = seedGoal(s.p, { titles: ['A', 'B', 'C'] });
        s.p.finishGoal(gid, { ok: false, outcome: 'failed', steps: 3, error: 'boom' });
        const g = s.p._store.get(gid);
        eq('failed：状态 failed', g.status, 'failed');
        eq('failed：cursor 不推进', g.plan.cursor, 0);
        eq('failed：当前行标 failed', g.plan.lines[0].status, 'failed');
        eq('failed：当前行 attempts=1', g.plan.lines[0].attempts, 1);
        eq('failed：当前行 lastError', g.plan.lines[0].lastError, 'boom');
        eq('failed：后续行仍 pending', g.plan.lines[1].status, 'pending');
        const adv = lastPlanAdvance(s.ledgerFile);
        eq('failed：ledger outcome', adv && adv.outcome, 'failed');
        eq('failed：ledger newCursor=0', adv && adv.newCursor, 0);
        eq('failed：ledger advanced=0', adv && adv.advanced, 0);
        await s.p.onDestroy();
    }

    // ── ②b 旧调用方 {ok:false} 仍是 failed（行为不倒退）───────────────────
    {
        const s = await setup();
        const gid = seedGoal(s.p, { titles: ['A', 'B'] });
        s.p.finishGoal(gid, { ok: false, error: 'legacy-fail' });
        const g = s.p._store.get(gid);
        eq('旧 {ok:false}：状态 failed', g.status, 'failed');
        eq('旧 {ok:false}：cursor 不推进', g.plan.cursor, 0);
        eq('旧 {ok:false}：ledger outcome=failed', lastPlanAdvance(s.ledgerFile).outcome, 'failed');
        await s.p.onDestroy();
    }

    // ── ③ unknown / cancelled：paused 且不推进 ────────────────────────────
    {
        const s = await setup();
        const g1 = seedGoal(s.p, { titles: ['A', 'B', 'C'] });
        s.p.finishGoal(g1, { outcome: 'unknown', ok: null, steps: 2 });
        const a = s.p._store.get(g1);
        eq('unknown：状态 paused（不是 failed）', a.status, 'paused');
        eq('unknown：cursor 不推进', a.plan.cursor, 0);
        eq('unknown：行全部保持 pending', a.plan.lines.map((l) => l.status).join(','), 'pending,pending,pending');
        const advU = lastPlanAdvance(s.ledgerFile);
        eq('unknown：ledger outcome', advU && advU.outcome, 'unknown');
        eq('unknown：ledger advanced=0', advU && advU.advanced, 0);

        const g2 = seedGoal(s.p, { titles: ['A', 'B'] });
        s.p.finishGoal(g2, { state: 'cancelled', steps: 1 });
        const b = s.p._store.get(g2);
        eq('cancelled（state 透传）：状态 paused', b.status, 'paused');
        eq('cancelled：cursor 不推进', b.plan.cursor, 0);
        eq('cancelled：ledger outcome', lastPlanAdvance(s.ledgerFile).outcome, 'cancelled');
        await s.p.onDestroy();
    }

    // ── ④ cursor 钳制：steps 超长不越界；目标位置永不后退 ─────────────────
    {
        const s = await setup();
        const gid = seedGoal(s.p, { titles: ['A', 'B'], budget: { maxSteps: 1000, maxLlmCalls: 100, maxWallMs: 600000 } });
        s.p.finishGoal(gid, { ok: true, outcome: 'done_verified', steps: 99 });
        eq('钳制：cursor=lines.length（2）', s.p._store.get(gid).plan.cursor, 2);
        eq('钳制：ledger advanced=2', lastPlanAdvance(s.ledgerFile).advanced, 2);

        // 纯函数侧：目标小于当前 cursor → unchanged（不后退、不涨 rev）
        const plan = {
            goalId: 'gx', cursor: 2, rev: 5,
            lines: [1, 2, 3].map((i) => ({ id: 'l' + i, title: 't' + i, status: i <= 2 ? 'done' : 'pending', t2: 'x', evidence: [], attempts: 0, lastError: null })),
        };
        const back = planStore.advanceTo(plan, 0);
        eq('钳制：advanceTo 后退请求 ok', back.ok, true);
        eq('钳制：advanceTo 不后退', back.to, 2);
        eq('钳制：advanceTo 无变化不涨 rev', back.plan.rev, 5);
        eq('钳制：advanceTo 标 unchanged', back.unchanged, true);
        const over = planStore.advanceTo(plan, 999);
        eq('钳制：advanceTo 超界钳到末尾', over.to, 3);
        eq('钳制：advanceTo 超界 advanced=1', over.advanced, 1);
        await s.p.onDestroy();
    }

    // ── ⑤ 终态幂等：二次 finish 不改状态/cursor，不重复 plan-advance ───────
    {
        const s = await setup();
        const gid = seedGoal(s.p, { titles: ['A', 'B', 'C'] });
        s.p.finishGoal(gid, { ok: true, outcome: 'done_verified', steps: 2 });
        const before = JSON.stringify(s.p._store.get(gid).plan);
        const advCount = readLedger(s.ledgerFile).filter((r) => r.kind === 'plan-advance').length;
        eq('幂等：二次 finish 返回 true', s.p.finishGoal(gid, { ok: false, outcome: 'failed', steps: 1 }), true);
        const g = s.p._store.get(gid);
        eq('幂等：状态仍 done', g.status, 'done');
        eq('幂等：plan 逐字节未变', JSON.stringify(g.plan), before);
        eq('幂等：plan-advance 没有新增', readLedger(s.ledgerFile).filter((r) => r.kind === 'plan-advance').length, advCount);
        ok('幂等：ledger 有 goal-finish-idempotent', readLedger(s.ledgerFile).some((r) => r.kind === 'goal-finish-idempotent'));

        // failed 终态后再 finish(ok) 也不能改回 done
        const gid2 = seedGoal(s.p, { titles: ['A'] });
        s.p.finishGoal(gid2, { ok: false, outcome: 'failed', error: 'x' });
        s.p.finishGoal(gid2, { ok: true, outcome: 'done_verified', steps: 1 });
        const g2 = s.p._store.get(gid2);
        eq('幂等：failed 不被二次 finish 翻成 done', g2.status, 'failed');
        eq('幂等：failed 的 cursor 仍是 0', g2.plan.cursor, 0);
        await s.p.onDestroy();
    }

    // ── ⑥ 预算耗尽：paused，cursor 冻结 ──────────────────────────────────
    {
        const s = await setup();
        const gid = seedGoal(s.p, { titles: ['A', 'B'], budget: { maxSteps: 1, maxLlmCalls: 4, maxWallMs: 600000 } });
        s.p.finishGoal(gid, { ok: true, outcome: 'done_verified', steps: 2 });
        const g = s.p._store.get(gid);
        eq('预算耗尽：状态 paused（不是 done）', g.status, 'paused');
        eq('预算耗尽：cursor 不推进', g.plan.cursor, 0);
        const rows = readLedger(s.ledgerFile);
        ok('预算耗尽：有 goal-budget-exhausted', rows.some((r) => r.kind === 'goal-budget-exhausted'));
        const adv = lastPlanAdvance(s.ledgerFile);
        eq('预算耗尽：plan-advance outcome', adv && adv.outcome, 'budget_exhausted');
        eq('预算耗尽：plan-advance advanced=0', adv && adv.advanced, 0);
        await s.p.onDestroy();
    }

    // ── ⑦ tailLine：中段有「下一步」，末尾说「已到计划末尾」──────────────
    {
        const s = await setup();
        const gid = seedGoal(s.p, { titles: ['收集材料', '写初稿', '校对'] });
        let line = s.p._tailLine();
        ok('tailLine：中段含下一步', line.includes('下一步 收集材料'), line);
        ok('tailLine：中段含余 3 步', line.includes('余 3 步'), line);

        // 直接改内存快照（tailLine 只读 _goals，不写盘）
        s.p._goals[0].plan.cursor = 1;
        line = s.p._tailLine();
        ok('tailLine：cursor=1 指向第二步', line.includes('下一步 写初稿'), line);
        ok('tailLine：cursor=1 余 2 步', line.includes('余 2 步'), line);

        s.p._goals[0].plan.cursor = 3;
        line = s.p._tailLine();
        ok('tailLine：末尾说「已到计划末尾」', line.includes('已到计划末尾'), line);
        ok('tailLine：末尾不再出现「下一步」', !line.includes('下一步'), line);
        ok('tailLine：末尾不出现 undefined', !/undefined/.test(line), line);
        ok('tailLine：末尾仍 ≤ max_tail_chars', line.length <= 150, 'len=' + line.length);

        const activeGoal = s.p._goals[0];
        const c = s.p._store.get(gid);
        eq('tailLine 只读：磁盘 cursor 未变', c.plan.cursor, 0, '内存 ' + activeGoal.plan.cursor);
        await s.p.onDestroy();
    }

    // ── ⑧ 无 plan / 落盘失败：只降级不抛 ─────────────────────────────────
    {
        const s = await setup();
        const gid = seedGoal(s.p, { titles: ['A'] });
        const g = s.p._store.get(gid);
        s.p._store.update(gid, { plan: null }, { expectedRev: g.rev });
        s.p._goals = s.p._store.list();
        let threw = null;
        try { s.p.finishGoal(gid, { ok: true, outcome: 'done_verified', steps: 1 }); } catch (e) { threw = e; }
        eq('无 plan：不抛错', threw, null);
        eq('无 plan：状态仍 done', s.p._store.get(gid).status, 'done');
        eq('无 plan：不写 plan-advance', readLedger(s.ledgerFile).filter((r) => r.kind === 'plan-advance').length, 0);

        // ledger 路径坏掉（指向目录）：finishGoal 仍成功
        const gid2 = seedGoal(s.p, { titles: ['A', 'B'] });
        const badLedger = path.join(s.tmp, 'ledger-as-dir');
        fs.mkdirSync(badLedger);
        s.p._ledgerFile = badLedger;
        threw = null;
        let ret = null;
        try { ret = s.p.finishGoal(gid2, { ok: true, outcome: 'done_verified', steps: 1 }); } catch (e) { threw = e; }
        eq('ledger 写失败：不抛错', threw, null);
        eq('ledger 写失败：finishGoal 仍 true', ret, true);
        eq('ledger 写失败：goal 状态仍 done', s.p._store.get(gid2).status, 'done');
        s.p._ledgerFile = s.ledgerFile;   // 恢复可写账本，下面的断言还要读它

        // plan 写盘失败（update 返回失败）：goal 状态保留，cursor 不变，不抛
        const gid3 = seedGoal(s.p, { titles: ['A', 'B'] });
        const realUpdate = s.p._store.update;
        s.p._store.update = () => ({ ok: false, reason: 'disk_full' });
        threw = null;
        ret = null;
        try { ret = s.p.finishGoal(gid3, { ok: true, outcome: 'done_verified', steps: 1 }); } catch (e) { threw = e; }
        s.p._store.update = realUpdate;
        eq('plan 写失败：不抛错', threw, null);
        eq('plan 写失败：finishGoal 仍 true', ret, true);
        eq('plan 写失败：goal 状态仍 done', s.p._store.get(gid3).status, 'done');
        eq('plan 写失败：cursor 不动', s.p._store.get(gid3).plan.cursor, 0);
        const advFail = readLedger(s.ledgerFile).filter((r) => r.kind === 'plan-advance').pop();
        eq('plan 写失败：ledger 记 ok=false', advFail && advFail.ok, false);
        await s.p.onDestroy();
    }

    // ── ⑨ generatePlan：重规划只替换 cursor 之后；终态/已完成不再改写 ─────
    {
        const two = { steps: [{ title: '新步骤一', t2: '新判据一' }, { title: '新步骤二', t2: '新判据二' }] };
        const s = await setup({}, async () => JSON.stringify(two));
        const gid = seedGoal(s.p, { titles: ['已完成一', '已完成二', '旧剩余'], cursor: 2 });
        const before = s.p._store.get(gid);
        const prefixBefore = JSON.stringify(before.plan.lines.slice(0, 2));
        const plan = await s.p.generatePlan(gid);
        ok('重规划：返回新 plan', !!plan);
        eq('重规划：cursor 保持 2', plan && plan.cursor, 2);
        eq('重规划：前缀逐字段不变', JSON.stringify(plan && plan.lines.slice(0, 2)), prefixBefore);
        eq('重规划：只留 cursor 后的新行', plan && plan.lines.length, 4);
        eq('重规划：旧剩余行被替换', plan && plan.lines[2].title, '新步骤一');
        eq('重规划：ledger 记 cursor=2', (readLedger(s.ledgerFile).filter((r) => r.kind === 'plan-generated').pop() || {}).cursor, 2);
        eq('重规划：ledger steps=2', (readLedger(s.ledgerFile).filter((r) => r.kind === 'plan-generated').pop() || {}).steps, 2);
        await s.p.onDestroy();
    }
    {
        // 已完成计划（cursor == lines.length）→ plan_complete，不改写
        const s = await setup({}, async () => JSON.stringify({ steps: [{ title: 'x', t2: 'y' }] }));
        const gid = seedGoal(s.p, { titles: ['A', 'B'], cursor: 2 });
        s.p._store.setStatus(gid, 'paused', { actor: 'arbiter', reason: 'test' });
        const before = JSON.stringify(s.p._store.get(gid).plan);
        const plan = await s.p.generatePlan(gid);
        eq('已完成计划：generatePlan 返回 null', plan, null);
        eq('已完成计划：plan 未改写', JSON.stringify(s.p._store.get(gid).plan), before);
        ok('已完成计划：ledger reason=plan_complete',
            readLedger(s.ledgerFile).some((r) => r.kind === 'plan-failed' && r.reason === 'plan_complete'));

        // 终态目标 → goal_closed
        s.p.finishGoal(gid, { ok: true, outcome: 'done_verified', steps: 1 });
        const plan2 = await s.p.generatePlan(gid);
        eq('终态：generatePlan 返回 null', plan2, null);
        ok('终态：ledger reason=goal_closed',
            readLedger(s.ledgerFile).some((r) => r.kind === 'plan-failed' && r.reason === 'goal_closed'));
        await s.p.onDestroy();
    }

    // ── ⑨b dispatch 桥真接线：结案 → consume 回写（不改 dispatch 源码）─────
    {
        const DispatchPlugin = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d',
            'plugins', 'community', 'dispatch', 'index.js'));
        const s = await setup();
        const d = new DispatchPlugin({ name: 'dispatch' }, { log() {} });
        const gid = seedGoal(s.p, { titles: ['A', 'B', 'C'] });
        d._finishGoalForTask({
            goalId: gid, state: 'done', outcome: 'done_verified',
            tools: [{ n: 1 }, { n: 2 }], tookMs: 12, startedAt: Date.now() - 12,
        });
        eq('桥：done_verified 状态 done', s.p._store.get(gid).status, 'done');
        eq('桥：done_verified cursor=2（tools 数对齐）', s.p._store.get(gid).plan.cursor, 2);
        eq('桥：ledger outcome=done_verified', lastPlanAdvance(s.ledgerFile).outcome, 'done_verified');
        eq('桥：ledger advanced=2', lastPlanAdvance(s.ledgerFile).advanced, 2);

        const gid2 = seedGoal(s.p, { titles: ['A', 'B'] });
        d._finishGoalForTask({
            goalId: gid2, state: 'failed', outcome: 'failed', error: 'QUOTA',
            tools: [{}], tookMs: 5, startedAt: Date.now() - 5,
        });
        const g2 = s.p._store.get(gid2);
        eq('桥：failed 状态 failed', g2.status, 'failed');
        eq('桥：failed cursor 不推进', g2.plan.cursor, 0);
        eq('桥：failed 当前行留现场', g2.plan.lines[0].status, 'failed');
        eq('桥：failed 记了一次失败熔断', s.p._breaker.size, 1);

        // B6 补：unknown / cancelled 不是失败 → 目标 paused、计划冻结、不记熔断
        const gid3 = seedGoal(s.p, { titles: ['A', 'B'] });
        d._finishGoalForTask({
            goalId: gid3, state: 'unknown', outcome: null, stateReason: 'disconnect',
            tools: [{}], tookMs: 3, startedAt: Date.now() - 3,
        });
        const g3 = s.p._store.get(gid3);
        eq('桥：unknown 状态 paused', g3.status, 'paused');
        eq('桥：unknown cursor 不推进', g3.plan.cursor, 0);
        eq('桥：unknown ledger outcome=unknown', lastPlanAdvance(s.ledgerFile).outcome, 'unknown');

        const gid4 = seedGoal(s.p, { titles: ['A', 'B'] });
        d._finishGoalForTask({
            goalId: gid4, state: 'cancelled', outcome: null, stateReason: 'cancelled',
            tools: [{}], tookMs: 2, startedAt: Date.now() - 2,
        });
        const g4 = s.p._store.get(gid4);
        eq('桥：cancelled 状态 paused', g4.status, 'paused');
        eq('桥：cancelled cursor 不推进', g4.plan.cursor, 0);
        eq('桥：cancelled ledger outcome=cancelled', lastPlanAdvance(s.ledgerFile).outcome, 'cancelled');
        eq('桥：unknown/cancelled 不记失败熔断', s.p._breaker.size, 1);
        await s.p.onDestroy();
    }

    // ── ⑩ 3 条跨步 agent-eval 任务（成功 + 失败门控各跑一遍）────────────
    {
        const mod = await import(require('url').pathToFileURL(path.join(__dirname, 'agent-eval', 'cross-step-tasks.mjs')).href);
        const results = await mod.runAllCrossStepTasks();
        eq('跨步评测：共 4 次执行（3 条任务 + 失败门控）', results.length, 4);
        for (const r of results) {
            ok('跨步评测 ' + r.id + '：全部断言通过',
                r.ok === true,
                r.assertions.filter((a) => !a.ok).map((a) => a.name + (a.detail === undefined ? '' : '=' + JSON.stringify(a.detail))).join('; '));
            ok('跨步评测 ' + r.id + '：临时目录已清理', r.snapshot && r.snapshot.tmpRemoved === true);
        }
        const gateFail = results.find((r) => r.id === 'mk_cross_two_step_gate' && r.snapshot && r.snapshot.status === 'failed');
        ok('跨步评测：失败门控确实跑到 failed 分支', !!gateFail);
        eq('跨步评测：失败门控 cursor 不推进', gateFail && gateFail.snapshot.cursor, 0);
        const gateOk = results.find((r) => r.id === 'mk_cross_two_step_gate' && r.snapshot && r.snapshot.status === 'done');
        eq('跨步评测：成功门控 cursor 到末尾', gateOk && gateOk.snapshot.cursor, 2);
    }

    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不影响判定 */ } }

    if (failures.length) {
        console.error('❌ mind-kernel 计划推进：FAIL ' + fail + ' / PASS ' + pass);
        for (const f of failures) console.error('   - ' + f);
        process.exit(1);
    }
    console.log('  ✅ mind-kernel 计划推进：PASS ' + pass + ' / FAIL 0');
})();
