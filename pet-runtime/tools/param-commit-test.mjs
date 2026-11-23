// param-commit-test.mjs —— 两段提交语义单测（P1-6 骨架）
// 跑法：node pet-runtime/tools/param-commit-test.mjs
import fs from 'node:fs';
import {
  physicsInputsOf, physicsOutputsOf, partitionTarget, commitInOrder, compareTarget,
} from '../desktop/perf/param-commit.mjs';

let pass = 0;
let fail = 0;
const check = (label, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond || !extra ? '' : '  ' + extra}`);
};
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  期望 ${JSON.stringify(want)} 实际 ${JSON.stringify(got)}`}`);
};

// ── 1. 用真实 physics3 抽 Input（权威，不靠硬编码）────────────────────
const PHYS = 'pet-runtime/desktop/assets/jellyfish/pet.physics3.json';
// 模型资产不随公开树分发（.moc3/physics3 许可见 README）：缺失时明确 SKIP，
// 而不是让整条 CI 红。D 盘完整开发树里该文件存在，测试照常全跑。
if (!fs.existsSync(PHYS)) {
  console.log('[param-commit-test] SKIP：模型资产未随公开树分发（' + PHYS + '）');
  process.exit(0);
}
const physics = JSON.parse(fs.readFileSync(PHYS, 'utf8'));
const inputs = physicsInputsOf(physics);
check('从 physics3 抽到物理输入', inputs.size >= 10, 'n=' + inputs.size);
check('ParamBreath 是物理输入', inputs.has('ParamBreath'));
check('ParamBodyAngleZ 是物理输入', inputs.has('ParamBodyAngleZ'));
// 单测纠正过的认知：ParamMouthForm 确实是 physics 的 Input（被 6 条设置引用），
// 但它是「输入」不是「输出」——物理读它、不改它，所以照样归「物理前提交」。
check('ParamMouthForm 是物理输入（物理读它，需要前置）', inputs.has('ParamMouthForm'));
const outputs = physicsOutputsOf(physics);
check('ParamBodyAngleZ 是物理输出（会被覆盖，不能当普通参数写）', outputs.has('ParamBodyAngleZ'));
check('HipAngleX 是物理输出', outputs.has('HipAngleX'));

// ── 2. 分区 ─────────────────────────────────────────────────────────
const target = new Map([
  ['ParamBreath', 0.7],
  ['ParamBodyAngleZ', -0.5],
  ['ParamMouthForm', 0.3],
  ['key7', 0.4],
]);
const parts = partitionTarget(target, inputs);
eq('物理前批次（含 ParamMouthForm）', parts.before.map((x) => x[0]).sort(), ['ParamBodyAngleZ', 'ParamBreath', 'ParamMouthForm']);
eq('物理后批次', parts.after.map((x) => x[0]).sort(), ['key7']);
check('物理输出参数不该出现在目标里（这里故意放了 ParamBodyAngleZ，仅作演示）', outputs.has('ParamBodyAngleZ'));

// ── 3. 非法值被丢弃 ─────────────────────────────────────────────────
const dirty = partitionTarget({ ParamBreath: NaN, ParamMouthForm: 0.2 }, inputs);
eq('NaN 被丢弃', dirty.before.length + dirty.after.length, 1);

// ── 4. 提交顺序：物理前 → 物理 → 物理后 ────────────────────────────
{
  const trace = [];
  const n = commitInOrder(parts,
    (id, v) => trace.push('before:' + id),
    () => trace.push('physics'),
    (id, v) => trace.push('after:' + id));
  eq('提交数量', n, 4);
  const nBefore = parts.before.length;
  eq('物理必须在两批之间', trace[nBefore], 'physics');
  check('物理前批次在 physics 之前', trace.slice(0, nBefore).every((t) => t.startsWith('before:')));
  check('物理后批次在 physics 之后', trace.slice(nBefore + 1).every((t) => t.startsWith('after:')));
}

// ── 5. 物理覆盖模拟：物理前写的值会被物理改写，物理后写的不会 ──────
{
  const model = new Map();
  // 物理只覆盖 Output（Input 只读）——这条是单测纠正出来的关键语义
  const physicsOverwrite = (id) => { if (outputs.has(id)) model.set(id, model.get(id) * 0.05); };
  commitInOrder(parts,
    (id, v) => model.set(id, v),
    () => { for (const id of [...model.keys()]) physicsOverwrite(id); },
    (id, v) => model.set(id, v));
  check('物理输出 ParamBodyAngleZ 被物理覆盖（-0.5→-0.025）', Math.abs(model.get('ParamBodyAngleZ') - (-0.5 * 0.05)) < 1e-9, 'v=' + model.get('ParamBodyAngleZ'));
  check('物理输入 ParamBreath 不被物理改写', model.get('ParamBreath') === 0.7, 'v=' + model.get('ParamBreath'));
  check('ParamMouthForm 是输入：物理只读不改，值保住', model.get('ParamMouthForm') === 0.3, 'v=' + model.get('ParamMouthForm'));
  check('物理后写 key7 保住了', model.get('key7') === 0.4);
}

// ── 6. compareTarget：影子比对口径 ──────────────────────────────────
{
  const final = new Map([['ParamBreath', 0.035], ['ParamMouthForm', 0.3], ['ParamBodyAngleZ', -0.03], ['key7', 0.4]]);
  const r = compareTarget(target, (id) => final.get(id));
  check('一致/不一致计数正确', r.same === 2 && r.diverge.length === 2, JSON.stringify(r));
  check('不一致项带 want/got', r.diverge[0].want !== undefined && r.diverge[0].got !== undefined);
}

// ── 7. 顺序无关性：物理后批次内部顺序不影响最终值 ──────────────────
{
  const a = new Map();
  const b = new Map();
  const after = parts.after;
  commitInOrder({ before: [], after }, () => {}, () => {}, (id, v) => a.set(id, v));
  commitInOrder({ before: [], after: [...after].reverse() }, () => {}, () => {}, (id, v) => b.set(id, v));
  eq('物理后批次顺序不影响最终值', [...a.entries()].sort(), [...b.entries()].sort());
}

console.log(`\n汇总: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
