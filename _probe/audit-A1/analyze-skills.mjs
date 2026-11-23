import fs from 'node:fs';
const P = '<project-root>/pet-runtime/knowledge/skills/skills.json';
const doc = JSON.parse(fs.readFileSync(P, 'utf8'));
const sk = doc.skills || [];
console.log('version:', doc.version, 'total entries:', sk.length);

const active = sk.filter(s => !s.deleted);
const deleted = sk.filter(s => s.deleted);
console.log(`active: ${active.length}  deleted(tombstone): ${deleted.length}`);

console.log('\n=== active skills ===');
for (const s of active) {
  const rate = s.attemptCount ? (s.successCount / s.attemptCount * 100).toFixed(0) + '%' : 'n/a(0 attempts)';
  console.log(`  [${s.name}] steps=${(s.steps || []).length} succ=${s.successCount} att=${s.attemptCount} rate=${rate} risky=${!!s.risky} scope=${s.scope ?? '-'} lastRun=${s.lastRunAt ?? '-'}`);
}

console.log('\n=== reliability buckets (attempt>0) ===');
const b = { '0%': 0, '1-49%': 0, '50-79%': 0, '80-99%': 0, '100%': 0 };
for (const s of active) {
  if (!s.attemptCount) continue;
  const r = s.successCount / s.attemptCount;
  if (r === 0) b['0%']++; else if (r < 0.5) b['1-49%']++; else if (r < 0.8) b['50-79%']++; else if (r < 1) b['80-99%']++; else b['100%']++;
}
console.log(b);

// #编号 violations: literal "#" followed by digits
const reHash = /#\s*\d+/;
console.log('\n=== "#编号" violations ===');
let hits = 0;
for (const s of sk) {
  const fields = { name: s.name, description: s.description, steps: JSON.stringify(s.steps) };
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string' && reHash.test(v)) { hits++; console.log(`  ${s.deleted ? '[DEL]' : '[ACT]'} ${s.name} :: ${k} = ${v}`); }
  }
}
console.log('total #digits hits:', hits);

// malformed steps check
console.log('\n=== integrity ===');
let noSteps = 0, badAction = 0;
const actions = {};
for (const s of sk) {
  if (!Array.isArray(s.steps) || s.steps.length === 0) { noSteps++; console.log('  NO STEPS:', s.name); }
  else for (const st of s.steps) {
    if (!st || typeof st.action !== 'string' || !st.action.trim()) { badAction++; console.log('  BAD STEP:', s.name, JSON.stringify(st)); }
    else actions[st.action] = (actions[st.action] || 0) + 1;
  }
}
console.log(`noSteps=${noSteps} badAction=${badAction}`);
console.log('actions used:', actions);

// duplicates by name
const names = {};
for (const s of active) names[s.name] = (names[s.name] || 0) + 1;
console.log('duplicate active names:', Object.entries(names).filter(([, v]) => v > 1));
