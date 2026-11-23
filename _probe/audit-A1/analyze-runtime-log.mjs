import fs from 'node:fs';
const p = '<project-root>/_incoming/my-neuro/live-2d/runtime.log';
const raw = fs.readFileSync(p, 'utf8');
const all = raw.split(/\r?\n/).filter(Boolean);
console.log('total lines:', all.length, 'bytes:', raw.length);

const last = all.slice(-2000);
console.log('analyzing last', last.length, 'lines');

// detect format
console.log('\n=== first 5 ==='); all.slice(0, 5).forEach(l => console.log(l.slice(0, 200)));
console.log('\n=== last 5 ==='); all.slice(-5).forEach(l => console.log(l.slice(0, 200)));

const isLevel = (l) => /\b(WARN|WARNING|ERROR|FATAL)\b/i.test(l);
const norm = (l) => l
  .replace(/^\S*[[(]?(\d{4}-\d\d-\d\d)?[T ]?\d{2}:\d{2}:\d{2}[.,]?\d*[)\]]?\s*/, '')
  .replace(/0x[0-9a-f]+/gi, '<hex>')
  .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
  .replace(/\d+\.\d+/g, '<f>')
  .replace(/\b\d{2,}\b/g, '<n>')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 140);

const buckets = new Map();
for (const l of last) {
  if (!isLevel(l)) continue;
  const k = norm(l);
  if (!buckets.has(k)) buckets.set(k, { n: 0, first: l, last: l });
  const b = buckets.get(k); b.n++; b.last = l;
}
console.log('\n=== WARN/ERROR templates in last 2000 lines (sorted) ===');
const arr = [...buckets.entries()].sort((a, b) => b[1].n - a[1].n);
console.log('distinct templates:', arr.length);
for (const [k, v] of arr.slice(0, 25)) {
  console.log(`\n[${v.n}x] ${k}`);
  console.log('  last:', v.last.slice(0, 260));
}

// level totals in last 2000
let w = 0, e = 0;
for (const l of last) { if (/\bWARN(ING)?\b/i.test(l)) w++; if (/\bERROR\b/i.test(l)) e++; }
console.log('\nlast2000 WARN-ish lines:', w, 'ERROR lines:', e);
