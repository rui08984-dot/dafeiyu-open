// _probe/test-mind-kernel-plan.cjs —— mind-kernel 计划生成单测（2026-11-21）
//
// 覆盖：
//   ① 合法 3 步 → plan 写入、goal.rev+1、plan.rev 递增、cursor=0、落盘可校验；
//   ② 坏 JSON / 0 步 / 缺 t2 / LLM 抛错 / 超时 → 保持原单步 plan、ledger 有 plan-failed、不抛；
//   ③ 9 步 → 截断保前 8 步（plan-store 硬上限），ledger 记 truncated/dropped；
//   ④ plan_generate=false → 一次 LLM 都不调、钩子不挂载；
//   ⑤ dispatch 建 goal 后同步触发钩子（不 await、不阻塞派活）。
// 全部用 os.tmpdir() 临时目录 + mock LLM，绝不碰真实记录室/真实模型。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 数据根隔离（A2 同款，2026-11-24）：计划生成现在要过后台花费闸（background-llm.ensureCanRun
// → llm-health），而 llm-health 读的是 RECORDS_DIR/LLM健康.json。不隔离的话，宿主正在
// 配额暂停时本测试会整片变红 —— 那是宿主的账，不是计划生成的回归。**必须在 require 之前设**。
process.env.PET_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-plan-root-'));

const PLUGIN_DIR = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'mind-kernel');
const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const MindKernelPlugin = require(path.join(PLUGIN_DIR, 'index.js'));
const DispatchPlugin = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch', 'index.js'));
const planStore = require(path.join(PLUGIN_DIR, 'lib', 'plan-store.js'));
// 第四轮 P2：闸关 → planPending → 闸开补生成，需要直接控制云端闸（llm-health）
const BL = require(path.join(LIVE, 'js', 'core', 'background-llm.js'));
const { llmHealth } = require(path.join(LIVE, 'js', 'core', 'llm-health.js'));

const HEALTH_PATH = path.join(process.env.PET_DATA_ROOT, 'LLM健康.json');
function cloudOk() {
    llmHealth.resetForTests({ path: HEALTH_PATH });
    BL.__test.resetGateLog();
}
function cloudBlocked() {
    cloudOk();
    llmHealth.noteFailure({ status: 429, body: '{"error":{"message":"rate limited"}}' }, Date.now());
    return BL.canRun({ getConfig: () => ({}) }).ok === false;
}

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
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-plan-'));
    tmpDirs.push(d);
    return d;
}

/** 每个场景一个独立插件；llm 由场景控制，返回 {calls, lastPrompt, lastOptions} */
async function setup(cfgOver, llmImpl) {
    const tmp = makeTmp();
    const goalsFile = path.join(tmp, 'goals.json');
    const ledgerFile = path.join(tmp, 'goal-ledger.jsonl');
    const state = { calls: 0, lastPrompt: '', lastOptions: null };
    const cfg = Object.assign({
        enabled: true,
        inject_plan_line: true,
        tick_ms: 600000,
        goals_file: goalsFile,
        ledger_file: ledgerFile,
        plan_generate: true,
        plan_max_steps: 8,
        plan_timeout_ms: 200,
    }, cfgOver || {});
    const ctx = {
        getPluginFileConfig() { return cfg; },
        log() {},
        callLLM(prompt, options) {
            state.calls += 1;
            state.lastPrompt = String(prompt || '');
            state.lastOptions = options || null;
            return llmImpl(prompt, options);
        },
    };
    const p = new MindKernelPlugin({ name: 'mind-kernel' }, ctx);
    await p.onInit();
    return { p, cfg, goalsFile, ledgerFile, state, tmp };
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

const THREE_STEPS = {
    steps: [
        { title: '打开邮件客户端', t2: '窗口标题含「写邮件」' },
        { title: '填收件人并附上报告', t2: '收件人字段非空且附件列表长度=1' },
        { title: '发送并确认已送达', t2: '已发送文件夹出现该邮件' },
    ],
};
const NINE_STEPS = { steps: Array.from({ length: 9 }, (_, i) => ({ title: '第' + (i + 1) + '步', t2: '第' + (i + 1) + '步的外部判据' })) };

(async () => {
    // ── ① 合法 3 步 ──────────────────────────────────────────────────────
    {
        const s = await setup({}, async () => '```json\n' + JSON.stringify(THREE_STEPS) + '\n```');
        const gid = s.p.addGoalForTask({ title: '把桌面报告发给他', doneWhen: '邮件已发送且附件 2MB' });
        ok('合法 3 步：goal 创建成功', typeof gid === 'string' && gid.length > 3, String(gid));
        const beforeRev = s.p._store.get(gid).rev;
        const beforePlan = JSON.stringify(s.p._store.get(gid).plan);

        const plan = await s.p.generatePlan(gid);
        ok('合法 3 步：返回 plan', !!plan, String(plan));
        eq('合法 3 步：LLM 只调 1 次', s.state.calls, 1);
        ok('合法 3 步：prompt 含标题与判据', s.state.lastPrompt.includes('把桌面报告发给他') && s.state.lastPrompt.includes('邮件已发送且附件 2MB'), s.state.lastPrompt.slice(0, 120));
        ok('合法 3 步：prompt 要求 3–8 步 JSON', /3–8 步/.test(s.state.lastPrompt) && /只输出一行 JSON/.test(s.state.lastPrompt));
        eq('合法 3 步：temperature=0.2', s.state.lastOptions && s.state.lastOptions.temperature, 0.2);

        eq('合法 3 步：lines=3', plan && plan.lines.length, 3);
        eq('合法 3 步：cursor=0', plan && plan.cursor, 0);
        ok('合法 3 步：plan.rev 递增（>1）', plan && plan.rev > 1, 'rev=' + (plan && plan.rev));
        ok('合法 3 步：所有行 pending 且字段齐全', plan && plan.lines.every((l) =>
            l.status === 'pending' && l.title && l.t2 && Array.isArray(l.evidence) && l.attempts === 0 && l.lastError === null));
        ok('合法 3 步：plan 通过 plan-store 校验', planStore.validatePlan(plan).ok, JSON.stringify(planStore.validatePlan(plan).errors));

        const after = s.p._store.get(gid);
        eq('合法 3 步：goal.rev 增加 1', after.rev, beforeRev + 1);
        ok('合法 3 步：plan 确实变了', JSON.stringify(after.plan) !== beforePlan);
        eq('合法 3 步：落盘 lines=3', diskGoal(s.goalsFile, gid).plan.lines.length, 3);
        eq('合法 3 步：首行标题来自模型', diskGoal(s.goalsFile, gid).plan.lines[0].title, '打开邮件客户端');

        const led = readLedger(s.ledgerFile).filter((r) => r.kind === 'plan-generated');
        eq('合法 3 步：ledger 有 1 条 plan-generated', led.length, 1);
        eq('合法 3 步：ledger steps=3', led[0] && led[0].steps, 3);
        eq('合法 3 步：ledger truncated=false', led[0] && led[0].truncated, false);
        await s.p.onDestroy();
    }

    // ── ①b 前后有解释/无关对象时，仍能抠到带 steps 的那个对象 ─────────────
    {
        const s = await setup({}, async () => '先说明一下：{"note":"不是计划"} 正式计划是：\n' + JSON.stringify(THREE_STEPS));
        const gid = s.p.addGoalForTask({ title: '带解释的输出', doneWhen: 'x' });
        const plan = await s.p.generatePlan(gid);
        ok('括号配平：跳过无关对象，找到带 steps 的对象', !!plan && plan.lines.length === 3, JSON.stringify(plan && plan.lines.length));
        eq('括号配平：首行标题正确', plan && plan.lines[0].title, '打开邮件客户端');
        await s.p.onDestroy();
    }

    // ── ② 失败路径：坏 JSON / 0 步 / 缺 t2 / LLM 抛错 / 超时 ──────────────
    const badCases = [
        { name: '坏 JSON', mode: 'bad', expect: 'bad_json', llm: async () => '我觉得应该先打开浏览器，然后……（没有 JSON）' },
        { name: '0 步', mode: 'zero', expect: 'empty_steps', llm: async () => '{"steps":[]}' },
        { name: '缺 t2', mode: 'noT2', expect: 'step_2_t2_empty', llm: async () => '{"steps":[{"title":"第一步","t2":"文件存在"},{"title":"第二步"}]}' },
        { name: 'LLM 抛错', mode: 'throw', expect: 'llm_error', llm: async () => { throw new Error('QUOTA'); } },
        { name: '超时', mode: 'hang', expect: 'timeout', llm: () => new Promise(() => {}) },
    ];
    for (const c of badCases) {
        const s = await setup({ plan_timeout_ms: 80 }, c.llm);
        const gid = s.p.addGoalForTask({ title: '失败路径任务', doneWhen: '外部验证通过' });
        const before = JSON.stringify(s.p._store.get(gid).plan);
        const beforeStatus = s.p._store.get(gid).status;
        let ret = 'THREW';
        let err = null;
        const t0 = Date.now();
        try { ret = await s.p.generatePlan(gid); } catch (e) { err = e; }
        const elapsed = Date.now() - t0;

        eq(c.name + '：不抛错', err, null);
        eq(c.name + '：返回 null', ret, null);
        eq(c.name + '：原单步 plan 保持不变', JSON.stringify(s.p._store.get(gid).plan), before);
        eq(c.name + '：goal 状态不变', s.p._store.get(gid).status, beforeStatus);
        if (c.mode === 'hang') ok(c.name + '：80ms 超时后 2s 内返回', elapsed < 2000, 'elapsed=' + elapsed + 'ms');
        const led = readLedger(s.ledgerFile).filter((r) => r.kind === 'plan-failed');
        ok(c.name + '：ledger 有 plan-failed', led.length >= 1, JSON.stringify(led));
        ok(c.name + '：reason 正确（' + c.expect + '）', led.length >= 1 && String(led[led.length - 1].reason).startsWith(c.expect), JSON.stringify(led[led.length - 1] || null));
        await s.p.onDestroy();
    }

    // ── ③ 9 步 → 截断保前 8 步 ────────────────────────────────────────────
    {
        const s = await setup({}, async () => JSON.stringify(NINE_STEPS));
        const gid = s.p.addGoalForTask({ title: '九步任务', doneWhen: '全部完成' });
        const plan = await s.p.generatePlan(gid);
        ok('9 步：返回 plan', !!plan);
        eq('9 步：截断为 8 行（plan-store 硬上限）', plan && plan.lines.length, 8);
        eq('9 步：保留前 8 步（第 1 步标题）', plan && plan.lines[0].title, '第1步');
        eq('9 步：第 9 步被丢弃', plan && plan.lines.some((l) => l.title === '第9步'), false);
        ok('9 步：截断后仍通过校验', planStore.validatePlan(plan).ok);
        const led = readLedger(s.ledgerFile).filter((r) => r.kind === 'plan-generated');
        eq('9 步：ledger truncated=true', led[0] && led[0].truncated, true);
        eq('9 步：ledger dropped=1', led[0] && led[0].dropped, 1);
        await s.p.onDestroy();
    }

    // ── ④ plan_generate=false → 不调 LLM、不挂钩子 ────────────────────────
    {
        const s = await setup({ plan_generate: false }, async () => JSON.stringify(THREE_STEPS));
        eq('开关 false：onInit 不挂 __mindKernelPlan', typeof globalThis.__mindKernelPlan, 'undefined');
        const gid = s.p.addGoalForTask({ title: '开关关闭任务', doneWhen: 'x' });
        const plan = await s.p.generatePlan(gid);
        eq('开关 false：generatePlan 返回 null', plan, null);
        eq('开关 false：一次 LLM 都没调', s.state.calls, 0);
        eq('开关 false：plan 仍是单步', s.p._store.get(gid).plan.lines.length, 1);
        eq('开关 false：ledger 无 plan-generated', readLedger(s.ledgerFile).filter((r) => r.kind === 'plan-generated').length, 0);
        await s.p.onDestroy();
    }

    // ── ⑤ 并发触发：同一 goal 只跑一次 ────────────────────────────────────
    {
        const s = await setup({}, async () => {
            await new Promise((r) => setTimeout(r, 60));
            return JSON.stringify(THREE_STEPS);
        });
        const gid = s.p.addGoalForTask({ title: '并发任务', doneWhen: 'x' });
        const p1 = s.p.generatePlan(gid);
        const second = await s.p.generatePlan(gid);   // busy 中，应立刻 null
        const first = await p1;
        eq('并发：第二次触发被挡下（null）', second, null);
        ok('并发：第一次正常出 plan', !!first && first.lines.length === 3);
        eq('并发：LLM 只调 1 次', s.state.calls, 1);
        await s.p.onDestroy();
    }

    // ── ⑥ 钩子挂载 + dispatch 触发不阻塞派活 ──────────────────────────────
    {
        const s = await setup({}, async () => JSON.stringify(THREE_STEPS));
        eq('钩子：onInit 后 __mindKernelPlan 是函数', typeof globalThis.__mindKernelPlan, 'function');
        // 用可控的异步实现替换，验证 dispatch 同步返回 goalId（不 await 计划）
        let hookArg = null;
        let release = null;
        s.p.generatePlan = (gid) => { hookArg = gid; return new Promise((r) => { release = r; }); };
        const d = new DispatchPlugin({ name: 'dispatch' }, { log() {} });
        const gid = d._createGoalForTask({ task: 'dispatch 触发计划' });
        ok('钩子：dispatch 返回 goalId', typeof gid === 'string' && gid.length > 3, String(gid));
        eq('钩子：dispatch 同步把 goalId 传给了 __mindKernelPlan', hookArg, gid);
        ok('钩子：计划 promise 未完成时派活已返回（不阻塞）', typeof release === 'function');
        release(null);
        await new Promise((r) => setImmediate(r));
        await s.p.onDestroy();
        eq('钩子：onDestroy 后 __mindKernelPlan 被清掉', typeof globalThis.__mindKernelPlan, 'undefined');
    }

    // ── ⑦ 闸关期间建的目标：planPending + 闸开 tick 补生成（第四轮 P2）─────
    // 病根：配额暂停/预算关时 generatePlan 被闸跳过，之后**没有重试入口** ——
    // 目标永久只剩 addGoalForTask 的 1 行计划。
    {
        const s = await setup({}, async () => JSON.stringify(THREE_STEPS));
        ok('闸关前置：429 后 canRun 真的被拦', cloudBlocked() === true);

        const gid = s.p.addGoalForTask({ title: '闸关期间的目标', doneWhen: '外部验证通过' });
        ok('闸关：goal 建成功', typeof gid === 'string' && gid.length > 3, String(gid));

        const plan0 = await s.p.generatePlan(gid);
        eq('闸关：generatePlan 返回 null（不改写单步计划）', plan0, null);
        eq('闸关：一次 LLM 都没调', s.state.calls, 0);
        eq('闸关：计划仍是 1 行', s.p._store.get(gid).plan.lines.length, 1);
        const pend1 = s.p._store.get(gid).planPending;
        ok('闸关：goal 落了 planPending（attempts=0）',
            !!pend1 && typeof pend1 === 'object' && pend1.attempts === 0, JSON.stringify(pend1));
        ok('闸关：ledger 有 plan-pending',
            readLedger(s.ledgerFile).some((r) => r.kind === 'plan-pending' && r.goalId === gid));
        ok('debugState 能看到 plansPending',
            (s.p.debugState().plansPending || []).some((x) => x.id === gid));

        // tick 时闸还关 → 不生成、pending 保留
        await s.p._tick();
        await Promise.all(s.p._pendingPlanRetries || []);
        eq('闸仍关：tick 不调 LLM', s.state.calls, 0);
        ok('闸仍关：pending 保留', !!s.p._store.get(gid).planPending);

        // 闸放开 + 下一 tick → 生成完整计划、pending 清除
        cloudOk();
        await s.p._tick();
        await Promise.all(s.p._pendingPlanRetries || []);
        eq('闸开 tick：LLM 调 1 次', s.state.calls, 1);
        const g2 = s.p._store.get(gid);
        eq('闸开 tick：计划 3 步', g2.plan.lines.length, 3);
        eq('闸开 tick：pending 已清（null，不是残留对象）', g2.planPending, null);
        eq('闸开 tick：落盘也清掉了', diskGoal(s.goalsFile, gid).planPending, null);
        await s.p.onDestroy();
    }

    // ── ⑧ 重试上限：闸开但一直失败 → 最多 3 次，不永久循环（第四轮 P2）────
    {
        const s = await setup({ plan_timeout_ms: 50 }, async () => { throw new Error('QUOTA'); });
        ok('上限前置：429 后 canRun 被拦', cloudBlocked() === true);
        const gid = s.p.addGoalForTask({ title: '一直失败的目标', doneWhen: '外部验证通过' });
        await s.p.generatePlan(gid);              // 闸关 → pending(attempts=0)
        ok('上限：起点是 pending(attempts=0)',
            !!(s.p._store.get(gid).planPending && s.p._store.get(gid).planPending.attempts === 0));

        cloudOk();
        for (let i = 0; i < 5; i += 1) {
            await s.p._tick();
            await Promise.all(s.p._pendingPlanRetries || []);
        }
        eq('上限：LLM 只尝试 3 次（不永久循环）', s.state.calls, 3);
        eq('上限：pending 最终被清空', s.p._store.get(gid).planPending, null);
        ok('上限：ledger 有 plan-pending-giveup',
            readLedger(s.ledgerFile).some((r) => r.kind === 'plan-pending-giveup' && r.goalId === gid));
        eq('上限：计划仍是单步（退回既有兜底）', s.p._store.get(gid).plan.lines.length, 1);
        // 再 tick 一次也不该再打云
        await s.p._tick();
        await Promise.all(s.p._pendingPlanRetries || []);
        eq('上限：给弃后再 tick 仍 0 新调用', s.state.calls, 3);
        await s.p.onDestroy();
    }

    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不影响判定 */ } }

    if (failures.length) {
        console.error('❌ mind-kernel 计划生成：FAIL ' + fail + ' / PASS ' + pass);
        for (const f of failures) console.error('   - ' + f);
        process.exit(1);
    }
    console.log('  ✅ mind-kernel 计划生成：PASS ' + pass + ' / FAIL 0');
})();
