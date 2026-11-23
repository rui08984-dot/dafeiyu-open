// _probe/test-goal-terminal.cjs —— 目标终态保护 / finishGoal 幂等（2026-11-20 审计 P1-5）
//
// 复现过的 bug：
//   ① finishGoal('nonexistent') 返回 true（假装成功）；
//   ② 同一 goal 二次 finish（ok:false）把 done 改成 failed；
//   ③ consume 对终态没有明确拒绝（已实现，这里确认不回归）。
//
// 全部用 os.tmpdir() 临时目录，不碰真实 data。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_DIR = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'mind-kernel');
const MindKernelPlugin = require(path.join(PLUGIN_DIR, 'index.js'));
const goalStore = require(path.join(PLUGIN_DIR, 'lib', 'goal-store.js'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass++; return; }
    fail++;
    failures.push(name + (detail ? '：' + detail : ''));
}
function eq(name, actual, expected) {
    ok(name, actual === expected, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}
function makeTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mk-terminal-')); }
function makeGoal(over) {
    const now = Date.now();
    return Object.assign({
        id: 'g1', parentId: null, title: '终态测试目标', doneWhen: '外部判据成立',
        status: 'queued', priority: 5, createdAt: now, updatedAt: now,
        budget: { maxSteps: 20, maxLlmCalls: 4, maxWallMs: 600000 },
        used: { steps: 0, llmCalls: 0, wallMs: 0 },
        attempts: 0, replans: 0, lastError: null, expiresAt: null, rev: 1,
    }, over || {});
}
const readGoals = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).goals;

(async () => {
    // ── ① store 层：终态不可迁出 ────────────────────────────────────────────
    {
        const mem = { data: null };
        const store = goalStore.createStore({
            file: 'mem://goals',
            readJson: () => mem.data,
            writeJson: (f, d) => { mem.data = JSON.parse(JSON.stringify(d)); },
            now: () => 1000,
        });
        mem.data = { schemaVersion: 1, goals: [makeGoal({ status: 'active' })] };
        store.load();
        eq('先置 done', store.setStatus('g1', 'done', { actor: 'arbiter' }).ok, true);
        const r1 = store.setStatus('g1', 'failed', { actor: 'arbiter' });
        eq('done → failed 被拒', r1.ok, false);
        eq('拒绝原因是 terminal', r1.reason, 'terminal');
        eq('状态仍是 done', store.get('g1').status, 'done');

        const r2 = store.setStatus('g1', 'abandoned', { actor: 'arbiter' });
        eq('done → abandoned 被拒', r2.reason, 'terminal');

        const r3 = store.setStatus('g1', 'done', { actor: 'arbiter' });
        eq('重复置同一终态：幂等 ok', r3.ok, true);
        eq('重复置同一终态：unchanged', r3.unchanged, true);

        const c = store.consume('g1', { steps: 1 });
        eq('终态 consume 返回 goal_closed', c.reason, 'goal_closed');
        eq('goal_closed 带状态', c.status, 'done');

        const reopenNoFlag = store.setStatus('g1', 'active', { actor: 'human' });
        eq('human 不显式 reopen 也拒', reopenNoFlag.reason, 'terminal');
        const reopen = store.setStatus('g1', 'active', { actor: 'human', reopen: true });
        eq('human + reopen=true 可重新打开', reopen.ok, true);
        eq('重新打开后状态 active', store.get('g1').status, 'active');
    }

    // ── ② 插件层：finishGoal 未知 id / 二次 finish ──────────────────────────
    {
        const tmp = makeTmp();
        const goalsFile = path.join(tmp, 'goals.json');
        const ledgerFile = path.join(tmp, 'goal-ledger.jsonl');
        fs.writeFileSync(goalsFile, JSON.stringify({ schemaVersion: 1, goals: [makeGoal({ status: 'active' })] }, null, 2), 'utf8');
        const plugin = new MindKernelPlugin({ name: 'mind-kernel' }, {
            getPluginFileConfig: () => ({ enabled: true, tick_ms: 60000, goals_file: goalsFile, ledger_file: ledgerFile }),
            log() {},
        });
        await plugin.onInit();

        eq('未知 id finish → false', plugin.finishGoal('no-such-goal', { ok: true }), false);
        eq('未知 id 不写状态', readGoals(goalsFile).length, 1);

        eq('首次 finish(ok) → true', plugin.finishGoal('g1', { ok: true }), true);
        eq('首次 finish 后 done', readGoals(goalsFile)[0].status, 'done');
        eq('二次 finish(ok:false) → true（幂等）', plugin.finishGoal('g1', { ok: false, error: 'late duplicate' }), true);
        eq('二次 finish 不改状态（仍 done）', readGoals(goalsFile)[0].status, 'done');
        eq('二次 finish 不追加失败原因', readGoals(goalsFile)[0].lastError, null);

        const ledger = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        ok('ledger 有 goal-finish-unknown', ledger.some((r) => r.kind === 'goal-finish-unknown' && r.goalId === 'no-such-goal'));
        ok('ledger 有 goal-finish-idempotent', ledger.some((r) => r.kind === 'goal-finish-idempotent' && r.goalId === 'g1'));
        ok('ledger 只有一次真正的 goal-finish', ledger.filter((r) => r.kind === 'goal-finish').length === 1,
            '实际 ' + ledger.filter((r) => r.kind === 'goal-finish').length + ' 次');
    }

    // ── ③ 插件层：failed 也受终态保护 ──────────────────────────────────────
    {
        const tmp = makeTmp();
        const goalsFile = path.join(tmp, 'goals.json');
        fs.writeFileSync(goalsFile, JSON.stringify({ schemaVersion: 1, goals: [makeGoal({ status: 'active' })] }, null, 2), 'utf8');
        const plugin = new MindKernelPlugin({ name: 'mind-kernel' }, {
            getPluginFileConfig: () => ({ enabled: true, tick_ms: 60000, goals_file: goalsFile, ledger_file: path.join(tmp, 'l.jsonl') }),
            log() {},
        });
        plugin.onInit();
        eq('finish(fail) → true', plugin.finishGoal('g1', { ok: false, error: 'boom' }), true);
        eq('failed 落盘', readGoals(goalsFile)[0].status, 'failed');
        eq('再 finish(ok) 不改 failed', plugin.finishGoal('g1', { ok: true }), true);
        eq('failed 仍是 failed', readGoals(goalsFile)[0].status, 'failed');
    }

    if (fail) {
        console.error('❌ 目标终态保护：FAIL ' + fail + ' / PASS ' + pass);
        for (const f of failures) console.error('   - ' + f);
        process.exit(1);
    }
    console.log('  ✅ 目标终态保护：PASS ' + pass + ' / FAIL 0');
})().catch((e) => {
    console.error('❌ 目标终态保护测试异常：' + ((e && e.stack) || e));
    process.exit(1);
});
