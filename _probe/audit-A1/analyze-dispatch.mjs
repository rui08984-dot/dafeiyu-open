import fs from 'node:fs';

const P = '<project-root>/pet-runtime/data/dispatch-history.jsonl';
const lines = fs.readFileSync(P, 'utf8').split('\n').filter(Boolean);
const recs = [];
let bad = 0;
const badSamples = [];
for (const [i, l] of lines.entries()) {
  try { recs.push(JSON.parse(l)); } catch { bad++; if (badSamples.length < 3) badSamples.push({ line: i + 1, text: l.slice(0, 300) }); }
}
console.log('TOTAL lines:', lines.length, 'parsed:', recs.length, 'unparseable:', bad);
if (bad) console.log('bad samples:', JSON.stringify(badSamples, null, 2));

// schema survey
const keys = new Map();
for (const r of recs) for (const k of Object.keys(r)) keys.set(k, (keys.get(k) || 0) + 1);
console.log('\n=== field presence ===');
for (const [k, v] of [...keys].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}/${recs.length}`);

const outs = {};
const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
for (const r of recs) {
  bump(outs, `${r.action ?? '<no-action>'}|ok=${r.ok} |effect=${r.effect ?? '<none>'}`);
}
console.log('\n=== action x ok x effect ===');
for (const [k, v] of Object.entries(outs).sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(4)}  ${k}`);

// failure by action
const byAction = {};
for (const r of recs) {
  const a = r.action ?? '<none>';
  byAction[a] ??= { total: 0, ok: 0, fail: 0, effects: {} };
  byAction[a].total++;
  if (r.ok === true) byAction[a].ok++; else byAction[a].fail++;
  const e = r.effect ?? '<none>';
  byAction[a].effects[e] = (byAction[a].effects[e] || 0) + 1;
}
console.log('\n=== per action ===');
for (const [a, s] of Object.entries(byAction).sort((x, y) => y[1].fail - x[1].fail)) {
  console.log(` ${a}: total=${s.total} ok=${s.ok} fail=${s.fail} rate=${(s.fail / s.total * 100).toFixed(0)}% effects=${JSON.stringify(s.effects)}`);
}

// timestamps
const tsKey = ['ts', 'time', 'timestamp', 'at', 'createdAt'].find(k => recs.some(r => r[k]));
console.log('\nts field:', tsKey);
if (tsKey) {
  const ts = recs.map(r => r[tsKey]).filter(Boolean);
  console.log('first:', ts[0], 'last:', ts[ts.length - 1]);
  // check monotonic
  let inversions = 0;
  for (let i = 1; i < ts.length; i++) if (new Date(ts[i]) < new Date(ts[i - 1])) inversions++;
  console.log('timestamp inversions:', inversions);
}

// duplicates
const sig = recs.map(r => JSON.stringify(r));
const uniq = new Set(sig);
console.log('\nduplicate records (exact):', recs.length - uniq.size);

// last 10 records raw
console.log('\n=== last 8 records ===');
for (const r of recs.slice(-8)) console.log(JSON.stringify(r));

// field completeness for key fields
for (const f of ['action', 'ok', 'effect', 'reason', 'detail', 'params', 'intent', 'latency', 'ms']) {
  const missing = recs.filter(r => r[f] === undefined || r[f] === null || r[f] === '').length;
  if (keys.has(f)) console.log(`field "${f}": missing/empty ${missing}/${recs.length}`);
}
