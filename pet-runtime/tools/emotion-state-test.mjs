// emotion-state-test.mjs —— 情绪状态契约单测（C-1）
// 跑法：node pet-runtime/tools/emotion-state-test.mjs
import {
  createState, observe, apply, merge, decay, describe, SUBJECTS, PROVENANCE,
} from '../desktop/emotion-state.mjs';

let pass = 0;
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  期望 ${JSON.stringify(want)} 实际 ${JSON.stringify(got)}`}`);
};
const check = (label, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond || !extra ? '' : '  ' + extra}`);
};

// ── 1. 空状态 ────────────────────────────────────────────────────────
{
  const s = createState(1000);
  eq('两个主体', Object.keys(s), ['user', 'companion']);
  eq('都从中性开始', [s.user.label, s.companion.label], ['neutral', 'neutral']);
  eq('revision 从 0 起', [s.user.revision, s.companion.revision], [0, 0]);
}

// ── 2. observe 校验 ─────────────────────────────────────────────────
{
  check('未知主体被拒', observe('cat', { label: 'happy' }).ok === false);
  check('空标签被拒', observe('user', { label: '  ' }).ok === false);
  check('未知来源被拒', observe('user', { label: 'happy', provenance: 'mind_reading' }).ok === false);
  const r = observe('user', { label: 'angry', intensity: 1.8, confidence: 2, provenance: 'user_explicit' });
  check('强度与置信度被夹到 0..1', r.ok && r.observation.intensity === 1 && r.observation.confidence === 1);
  const r2 = observe('user', { label: 'tired' });
  check('只给标签时 intensity 为 null（不瞎猜幅度）', r2.ok && r2.observation.intensity === null);
}

// ── 3. apply：正常写入 + revision 自增 ──────────────────────────────
let state = createState(1000);
let obs = observe('user', { label: 'angry', intensity: 0.8, provenance: 'user_explicit', at: 1000 }).observation;
let res = apply(state, obs);
state = res.state;
check('写入成功', res.applied === true, res.reason);
eq('标签与强度分开存', [state.user.label, state.user.intensity], ['angry', 0.8]);
eq('revision 自增到 1', state.user.revision, 1);
eq('证据链记一条', state.user.sources.length, 1);

// ── 4. CAS：旧 revision 必须 stale ──────────────────────────────────
{
  const staleObs = observe('user', { label: 'happy', intensity: 0.9, provenance: 'audio', at: 2000 }).observation;
  const r = apply(state, staleObs, { expectedRevision: 0 });   // 当前已是 1
  check('旧 revision 被判 stale', r.applied === false && r.reason === 'stale');
  eq('状态没有被旧推断覆盖', r.state.user.label, 'angry');
}

// ── 5. 低置信度不改状态 ─────────────────────────────────────────────
{
  const weak = observe('companion', { label: 'sad', intensity: 0.9, confidence: 0.2, provenance: 'companion_inference' }).observation;
  const r = apply(state, weak);
  check('低置信度被拒', r.applied === false && r.reason === 'low_confidence');
}

// ── 6. 只给标签时给中性幅度，不沿用旧幅度 ──────────────────────────
{
  const s0 = createState(0);
  const a = apply(s0, observe('companion', { label: 'happy', intensity: 0.9, provenance: 'text_recent_context' }).observation).state;
  const b = apply(a, observe('companion', { label: 'surprised', provenance: 'text_recent_context' }).observation).state;
  check('换标签但无强度 → 0.5', Math.abs(b.companion.intensity - 0.5) < 1e-9, 'v=' + b.companion.intensity);
}

// ── 7. 证据链最多 5 条 ──────────────────────────────────────────────
{
  let s = createState(0);
  for (let i = 0; i < 8; i++) {
    s = apply(s, observe('user', { label: 'happy', intensity: 0.2 + i * 0.05, provenance: 'user_explicit', at: i * 1000 }).observation).state;
  }
  eq('证据链截断到 5', s.user.sources.length, 5);
  eq('revision 累计到 8', s.user.revision, 8);
}

// ── 8. merge 取 revision 大的 ───────────────────────────────────────
{
  const a = apply(createState(0), observe('user', { label: 'happy', intensity: 0.4, provenance: 'user_explicit' }).observation).state;
  const b = apply(a, observe('user', { label: 'sad', intensity: 0.7, provenance: 'user_explicit' }).observation).state;
  const m1 = merge(a, b);
  eq('较新的 state 胜出', m1.user.label, 'sad');
  const m2 = merge(b, a);
  eq('顺序无关', m2.user.label, 'sad');
}

// ── 9. decay 半衰期 ─────────────────────────────────────────────────
{
  const s0 = createState(0);
  const s1 = apply(s0, observe('companion', { label: 'angry', intensity: 1, provenance: 'text_recent_context', at: 0 }).observation).state;
  const half = decay(s1, 300 * 1000, 300);      // 300 秒后
  check('半衰期后强度减半', Math.abs(half.companion.intensity - 0.5) < 0.02, 'v=' + half.companion.intensity);
  const none = decay(s1, 0, 300);
  check('时间没走不衰减', none.companion.intensity === 1);
}

// ── 10. describe ────────────────────────────────────────────────────
{
  const s = apply(createState(0), observe('user', { label: 'angry', intensity: 0.8, provenance: 'user_explicit' }).observation).state;
  check('摘要含标签与百分比', describe(s).includes('angry(80%)'), describe(s));
  check('平静时显示平静', describe(createState(0)).includes('平静'));
}

eq('主体清单', SUBJECTS, ['user', 'companion']);
eq('来源清单长度', PROVENANCE.length, 5);

console.log(`\n汇总: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
