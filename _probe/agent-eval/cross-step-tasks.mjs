#!/usr/bin/env node
// cross-step-tasks.mjs —— B6 跨步评测：3 条确定性多步任务（不调用 LLM、不依赖 8004）
//
// 为什么单独一个文件、而不是塞进 tasks.mjs：
//   · tasks.mjs 的表达式跑在 8004 页面里，依赖宿主窗口/工具；这 3 条要验证的是
//     **认知内核的目标/计划推进**，与 GUI 无关，塞进去只会让门禁被宿主拖红；
//   · 这里复用 agent-eval 的任务形状（setup / run / verify / cleanup + 独立 oracle），
//     但执行器是 Node 本地：run 是唯一副作用，verify 每次都**重新读磁盘**，
//     oracle 在整条任务结束后再独立断言最终产物 —— 「工具说成功」永远不算数。
//
// 每条任务：
//   { id, title, doneWhen, steps: [{ title, t2, run(ctx), verify(ctx) }], oracle(ctx), cleanup(ctx) }
//   ctx = { dir, root, nonce, mode, state }；run 返回 { ok, ... }，verify 返回 { ok, ... }。
//
// runCrossStepTask(task, opts)：
//   · 用 mkdtemp 建独立根目录（goals.json / goal-ledger.jsonl / work 都在这）；
//   · mind-kernel 用真实插件 + 真实 goal-store 落盘，plan 由步骤确定性注入（不走 LLM）；
//   · 全部步骤成功后 finishGoal(done_verified, steps=N)；中途失败 finishGoal(failed)；
//   · 断言 cursor/行状态/ledger，再跑 oracle；最后删临时根目录并确认已删。
//
// 直接运行：node _probe/agent-eval/cross-step-tasks.mjs
// 输出格式与其它探针一致：PASS n / FAIL m（失败退出 1）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE_ROOT = path.resolve(HERE, '..', '..');   // 项目根（_probe/agent-eval → 上两级）
const LIVE2D = path.join(PROBE_ROOT, '_incoming', 'my-neuro', 'live-2d');
const require = createRequire(import.meta.url);
const MindKernelPlugin = require(path.join(LIVE2D, 'plugins', 'community', 'mind-kernel', 'index.js'));

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => { try { return fs.existsSync(p); } catch (e) { return false; } };
const listNames = (dir) => { try { return fs.readdirSync(dir).sort(); } catch (e) { return []; } };

function expectedTransform(input) {
  const lines = String(input).split(/\r?\n/).filter((l) => l.length > 0);
  return lines.map((l) => l.toUpperCase()).join('|');
}

export const CROSS_STEP_TASKS = [
  {
    id: 'mk_cross_file_rename',
    title: '跨步①：建文件→写内容→改名（每步磁盘回读 + 最终 oracle）',
    doneWhen: 'final.txt 存在且内容逐字节等于预期，draft.txt 不存在',
    steps: [
      {
        title: '建空草稿文件',
        t2: 'draft.txt 存在且 size=0',
        run(ctx) {
          fs.writeFileSync(ctx.paths.draft, '', 'utf8');
          return { ok: true };
        },
        verify(ctx) {
          const ok = exists(ctx.paths.draft) && fs.statSync(ctx.paths.draft).size === 0;
          return { ok, exists: exists(ctx.paths.draft), size: exists(ctx.paths.draft) ? fs.statSync(ctx.paths.draft).size : null };
        },
      },
      {
        title: '写入两行内容',
        t2: 'draft.txt 逐字节等于预期（nonce 出现 2 次）',
        run(ctx) {
          fs.writeFileSync(ctx.paths.draft, ctx.content, 'utf8');
          return { ok: true };
        },
        verify(ctx) {
          const got = exists(ctx.paths.draft) ? read(ctx.paths.draft) : '';
          return { ok: got === ctx.content && got.split(ctx.nonce).length - 1 === 2, bytes: Buffer.byteLength(got) };
        },
      },
      {
        title: '改名为最终文件',
        t2: 'final.txt 存在、draft.txt 消失、内容不变',
        run(ctx) {
          fs.renameSync(ctx.paths.draft, ctx.paths.final);
          return { ok: true };
        },
        verify(ctx) {
          const got = exists(ctx.paths.final) ? read(ctx.paths.final) : '';
          return { ok: got === ctx.content && !exists(ctx.paths.draft), draftGone: !exists(ctx.paths.draft) };
        },
      },
    ],
    oracle(ctx) {
      const got = exists(ctx.paths.final) ? read(ctx.paths.final) : '';
      return {
        ok: got === ctx.content && !exists(ctx.paths.draft) && listNames(ctx.dir).join(',') === 'final.txt',
        checks: {
          finalExact: got === ctx.content,
          draftGone: !exists(ctx.paths.draft),
          onlyFinal: listNames(ctx.dir).join(',') === 'final.txt',
          nonceHits: got.split(ctx.nonce).length - 1,
        },
      };
    },
    cleanup() { return { ok: true }; },
  },

  {
    id: 'mk_cross_read_transform_write',
    title: '跨步②：读输入→生成结果→校验摘要（结果由输入独立重算）',
    doneWhen: 'result.txt 等于输入行的大写拼接，summary.json 的 digest 与 result 一致',
    setup(ctx) {
      ctx.input = 'alpha ' + ctx.nonce + '\nbeta line\ngamma line';
      fs.writeFileSync(ctx.paths.input, ctx.input, 'utf8');
      return { ok: true };
    },
    steps: [
      {
        title: '读输入并生成结果',
        t2: 'result.txt 等于 input 各行大写后用 | 拼接',
        run(ctx) {
          const input = read(ctx.paths.input);
          fs.writeFileSync(ctx.paths.result, expectedTransform(input), 'utf8');
          return { ok: true };
        },
        verify(ctx) {
          const want = expectedTransform(read(ctx.paths.input));
          const got = exists(ctx.paths.result) ? read(ctx.paths.result) : '';
          return { ok: got === want, got: got.slice(0, 120) };
        },
      },
      {
        title: '生成摘要文件',
        t2: 'summary.json 的 count=输入行数、digest=result 的 sha256',
        run(ctx) {
          const input = read(ctx.paths.input);
          const result = read(ctx.paths.result);
          const summary = {
            count: input.split(/\r?\n/).filter((l) => l.length > 0).length,
            digest: sha256(result),
          };
          fs.writeFileSync(ctx.paths.summary, JSON.stringify(summary), 'utf8');
          return { ok: true };
        },
        verify(ctx) {
          let j = null;
          try { j = JSON.parse(read(ctx.paths.summary)); } catch (e) { j = null; }
          const result = exists(ctx.paths.result) ? read(ctx.paths.result) : '';
          const wantCount = read(ctx.paths.input).split(/\r?\n/).filter((l) => l.length > 0).length;
          return { ok: !!j && j.count === wantCount && j.digest === sha256(result), summary: j };
        },
      },
      {
        title: '写校验标记',
        t2: 'verified.txt 内容等于 digest 前 12 位',
        run(ctx) {
          const j = JSON.parse(read(ctx.paths.summary));
          fs.writeFileSync(ctx.paths.verified, String(j.digest).slice(0, 12), 'utf8');
          return { ok: true };
        },
        verify(ctx) {
          const j = JSON.parse(read(ctx.paths.summary));
          const got = exists(ctx.paths.verified) ? read(ctx.paths.verified) : '';
          return { ok: got === String(j.digest).slice(0, 12), got };
        },
      },
    ],
    oracle(ctx) {
      const input = exists(ctx.paths.input) ? read(ctx.paths.input) : '';
      const result = exists(ctx.paths.result) ? read(ctx.paths.result) : '';
      let summary = null;
      try { summary = JSON.parse(read(ctx.paths.summary)); } catch (e) { summary = null; }
      const verified = exists(ctx.paths.verified) ? read(ctx.paths.verified) : '';
      return {
        ok: input === ctx.input && result === expectedTransform(input) && !!summary &&
          summary.digest === sha256(result) && verified === String(summary.digest).slice(0, 12) &&
          listNames(ctx.dir).join(',') === 'input.txt,result.txt,summary.json,verified.txt',
        checks: {
          inputIntact: input === ctx.input,
          resultExact: result === expectedTransform(input),
          digestMatches: !!summary && summary.digest === sha256(result),
          verifiedMarker: verified === String((summary || {}).digest).slice(0, 12),
          files: listNames(ctx.dir),
        },
      };
    },
    cleanup() { return { ok: true }; },
  },

  {
    id: 'mk_cross_two_step_gate',
    title: '跨步③：两步都成功才允许结案（第二步注入失败→任务 failed、cursor 不动）',
    doneWhen: 'step1.txt 与 step2.txt 都存在且内容正确；任一失败则任务判 failed',
    steps: [
      {
        title: '写第一步产物',
        t2: 'step1.txt 存在且等于 nonce',
        run(ctx) {
          fs.writeFileSync(ctx.paths.step1, ctx.nonce, 'utf8');
          return { ok: true };
        },
        verify(ctx) {
          const got = exists(ctx.paths.step1) ? read(ctx.paths.step1) : '';
          return { ok: got === ctx.nonce };
        },
      },
      {
        title: '写第二步产物',
        t2: 'step2.txt 存在且等于 DONE+nonce',
        run(ctx) {
          // 故障注入：确定性失败（不写文件），模拟「中间一步失败」。
          if (ctx.mode === 'fail') return { ok: false, error: '注入失败：第二步禁止写盘' };
          fs.writeFileSync(ctx.paths.step2, 'DONE ' + ctx.nonce, 'utf8');
          return { ok: true };
        },
        verify(ctx) {
          const got = exists(ctx.paths.step2) ? read(ctx.paths.step2) : '';
          return { ok: got === 'DONE ' + ctx.nonce };
        },
      },
    ],
    oracle(ctx) {
      const s1 = exists(ctx.paths.step1) ? read(ctx.paths.step1) : '';
      const s2 = exists(ctx.paths.step2) ? read(ctx.paths.step2) : '';
      if (ctx.mode === 'fail') {
        return {
          ok: s1 === ctx.nonce && !exists(ctx.paths.step2) && listNames(ctx.dir).join(',') === 'step1.txt',
          checks: { step1Written: s1 === ctx.nonce, step2Absent: !exists(ctx.paths.step2), files: listNames(ctx.dir) },
        };
      }
      return {
        ok: s1 === ctx.nonce && s2 === 'DONE ' + ctx.nonce && listNames(ctx.dir).join(',') === 'step1.txt,step2.txt',
        checks: { step1Written: s1 === ctx.nonce, step2Written: s2 === 'DONE ' + ctx.nonce, files: listNames(ctx.dir) },
      };
    },
    cleanup() { return { ok: true }; },
  },
];

function readLedgerRows(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { return []; }
}

function makePlugin(root) {
  const goalsFile = path.join(root, 'goals.json');
  const ledgerFile = path.join(root, 'goal-ledger.jsonl');
  const plugin = new MindKernelPlugin({ name: 'mind-kernel' }, {
    getPluginFileConfig() {
      return {
        enabled: true,
        inject_plan_line: true,
        plan_generate: false,   // 评测不调 LLM：plan 由步骤确定性注入
        tick_ms: 3600000,
        goals_file: goalsFile,
        ledger_file: ledgerFile,
      };
    },
    log() {},
  });
  return { plugin, goalsFile, ledgerFile };
}

/** 把任务的 steps 注入成 mind-kernel 的真实 plan（等价于 generatePlan 的成功产物）。 */
function injectPlan(plugin, gid, steps) {
  const g = plugin._store.get(gid);
  const planRev = Math.max(0, Number(g.plan && g.plan.rev) || 0) + 1;
  const plan = {
    goalId: gid,
    cursor: 0,
    rev: planRev,
    lines: steps.map((s, i) => ({
      id: gid + '-p' + planRev + '-l' + (i + 1),
      title: s.title,
      status: 'pending',
      t2: s.t2,
      evidence: [],
      attempts: 0,
      lastError: null,
    })),
  };
  const r = plugin._store.update(gid, { plan }, { expectedRev: g.rev });
  plugin._goals = plugin._store.list();
  return r && r.ok === true ? plan : null;
}

/**
 * 跑一条跨步任务。
 * @param {object} task CROSS_STEP_TASKS[i]
 * @param {{mode?:'ok'|'fail', failAt?:number}} [opts] failAt = 第几步（1-based）开始注入失败
 * @returns {Promise<object>} { id, ok, assertions, snapshot, tmpRemoved }
 */
export async function runCrossStepTask(task, opts) {
  const o = opts || {};
  const mode = o.mode === 'fail' ? 'fail' : 'ok';
  const failAt = Number(o.failAt) > 0 ? Math.floor(Number(o.failAt)) : 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-cross-'));
  const dir = path.join(root, 'work');
  fs.mkdirSync(dir, { recursive: true });
  const { plugin, goalsFile, ledgerFile } = makePlugin(root);
  const assertions = [];
  const assert = (name, cond, detail) => {
    assertions.push({ name, ok: !!cond, ...(detail === undefined ? {} : { detail }) });
  };
  let goalId = null;
  let snapshot = null;
  let oracleRes = null;
  try {
    await plugin.onInit();
    const nonce = crypto.randomBytes(5).toString('hex');
    const ctx = {
      root, dir, nonce, mode,
      state: {},
      content: 'LINE1 ' + nonce + '\nLINE2 ' + nonce + '\n',
      paths: {
        draft: path.join(dir, 'draft.txt'),
        final: path.join(dir, 'final.txt'),
        input: path.join(dir, 'input.txt'),
        result: path.join(dir, 'result.txt'),
        summary: path.join(dir, 'summary.json'),
        verified: path.join(dir, 'verified.txt'),
        step1: path.join(dir, 'step1.txt'),
        step2: path.join(dir, 'step2.txt'),
      },
    };
    if (typeof task.setup === 'function') {
      const su = await task.setup(ctx);
      assert('setup 完成', !!(su && su.ok !== false), su && su.error);
    }

    goalId = plugin.addGoalForTask({ title: task.title, doneWhen: task.doneWhen, kind: 'eval' });
    assert('goal 创建成功', typeof goalId === 'string' && goalId.length > 3, String(goalId));
    const plan = injectPlan(plugin, goalId, task.steps);
    assert('plan 注入成功', !!plan && plan.lines.length === task.steps.length, plan ? plan.lines.length : null);

    const stepResults = [];
    let failedStep = 0;
    for (let i = 0; i < task.steps.length; i += 1) {
      const step = task.steps[i];
      // failAt 语义：从第 failAt 步（1-based）开始，run 直接返回失败、不产生副作用。
      if (failAt && i + 1 >= failAt) {
        stepResults.push({ index: i + 1, title: step.title, runOk: false, verifyOk: false, injected: true });
        failedStep = i + 1;
        break;
      }
      let rr = null;
      try { rr = await step.run(ctx); } catch (e) { rr = { ok: false, error: String((e && e.message) || e) }; }
      let vr = null;
      try { vr = await step.verify(ctx); } catch (e) { vr = { ok: false, error: String((e && e.message) || e) }; }
      const ok = !!(rr && rr.ok !== false && vr && vr.ok === true);
      stepResults.push({ index: i + 1, title: step.title, runOk: !!(rr && rr.ok !== false), verifyOk: !!(vr && vr.ok === true), ok, verify: vr });
      if (!ok) { failedStep = i + 1; break; }
    }
    const doneSteps = failedStep ? failedStep - 1 : task.steps.length;
    assert('每一步 run+独立 verify 都通过' + (mode === 'fail' ? '（失败场景允许中断）' : ''),
      mode === 'fail' ? failedStep > 0 : failedStep === 0,
      stepResults.map((s) => s.index + ':' + (s.ok ? 'ok' : 'fail')).join(','));

    const fin = failedStep
      ? plugin.finishGoal(goalId, { ok: false, outcome: 'failed', steps: Math.max(1, doneSteps), wallMs: 5, error: 'step' + failedStep + ' failed' })
      : plugin.finishGoal(goalId, { ok: true, outcome: 'done_verified', steps: doneSteps, wallMs: 5 });
    assert('finishGoal 返回 true', fin === true);

    const g = plugin._store.get(goalId);
    const lines = g && g.plan && Array.isArray(g.plan.lines) ? g.plan.lines : [];
    const advances = readLedgerRows(ledgerFile).filter((r) => r.kind === 'plan-advance');
    const lastAdv = advances.length ? advances[advances.length - 1] : null;
    snapshot = {
      status: g && g.status,
      cursor: g && g.plan && g.plan.cursor,
      total: lines.length,
      lineStatuses: lines.map((l) => l.status),
      lastError: lines[0] ? lines[0].lastError : null,
      planAdvance: lastAdv,
      ledgerRows: readLedgerRows(ledgerFile).length,
      stepResults,
    };

    if (mode === 'fail') {
      assert('失败场景：goal=failed', snapshot.status === 'failed', snapshot.status);
      assert('失败场景：cursor 不推进（0）', snapshot.cursor === 0, snapshot.cursor);
      assert('失败场景：当前行标 failed', snapshot.lineStatuses[0] === 'failed', snapshot.lineStatuses.join(','));
      assert('失败场景：后续行仍 pending', lines.slice(1).every((l) => l.status === 'pending'), snapshot.lineStatuses.join(','));
      assert('失败场景：失败行有 lastError', typeof snapshot.lastError === 'string' && snapshot.lastError.length > 0, snapshot.lastError);
      assert('失败场景：未结案到第二步', doneSteps === 0 || doneSteps === failAt - 1, doneSteps);
    } else {
      assert('成功场景：goal=done', snapshot.status === 'done', snapshot.status);
      assert('成功场景：cursor 推进到末尾', snapshot.cursor === task.steps.length, snapshot.cursor + '/' + task.steps.length);
      assert('成功场景：所有行标 done', lines.every((l) => l.status === 'done'), snapshot.lineStatuses.join(','));
    }
    assert('ledger 有 plan-advance 行', advances.length >= 1, advances.length);
    assert('plan-advance 的 outcome 与结案一致',
      !!lastAdv && lastAdv.outcome === (mode === 'fail' ? 'failed' : 'done_verified'),
      lastAdv && lastAdv.outcome);
    assert('plan-advance 的 oldCursor=0',
      !!lastAdv && lastAdv.oldCursor === 0, lastAdv && lastAdv.oldCursor);
    assert('plan-advance 的 newCursor 与 goal 一致',
      !!lastAdv && lastAdv.newCursor === snapshot.cursor, lastAdv && (lastAdv.newCursor + ' vs ' + snapshot.cursor));
    assert('plan-advance advanced 数正确',
      !!lastAdv && lastAdv.advanced === (mode === 'fail' ? 0 : task.steps.length),
      lastAdv && lastAdv.advanced);

    oracleRes = task.oracle(ctx);
    assert('最终磁盘 oracle 通过', !!(oracleRes && oracleRes.ok), JSON.stringify(oracleRes && oracleRes.checks));
    snapshot.oracle = oracleRes && oracleRes.checks;
    snapshot.goalsFile = goalsFile;
  } catch (e) {
    assertions.push({ name: '任务执行不抛错', ok: false, detail: String((e && e.message) || e) });
  } finally {
    try { if (typeof task.cleanup === 'function') await task.cleanup({ root, dir, mode }); } catch (e) { /* cleanup 失败不掩盖主结论 */ }
    try { await plugin.onDestroy(); } catch (e) { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* 下面统一断言 */ }
    const removed = !fs.existsSync(root);
    assertions.push({ name: '临时目录已清理', ok: removed, detail: root });
    snapshot = snapshot || {};
    snapshot.tmpRemoved = removed;
    snapshot.root = root;
  }
  return {
    id: task.id,
    ok: assertions.every((a) => a.ok),
    assertions,
    snapshot,
  };
}

export async function runAllCrossStepTasks() {
  const out = [];
  for (const t of CROSS_STEP_TASKS) {
    out.push(await runCrossStepTask(t, { mode: 'ok' }));
    if (t.id === 'mk_cross_two_step_gate') {
      out.push(await runCrossStepTask(t, { mode: 'fail', failAt: 2 }));
    }
  }
  return out;
}

async function main() {
  const results = await runAllCrossStepTasks();
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    for (const a of r.assertions) {
      if (a.ok) pass += 1;
      else {
        fail += 1;
        console.error('   - ' + r.id + ' / ' + a.name + (a.detail === undefined ? '' : '：' + JSON.stringify(a.detail)));
      }
    }
    console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.id + '（' + r.assertions.length + ' 条断言）');
  }
  if (fail) {
    console.error('❌ 跨步评测：FAIL ' + fail + ' / PASS ' + pass);
    process.exit(1);
  }
  console.log('  ✅ 跨步评测：PASS ' + pass + ' / FAIL 0');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('跨步评测异常：' + ((e && e.message) || e)); process.exit(1); });
}
