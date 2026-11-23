import fs from 'node:fs';
const p = '<project-root>/_incoming/my-neuro/plugins-dlc/memos/memos_system/logs/memos.log';
const L = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);

const lv = { INFO: 0, WARNING: 0, ERROR: 0 };
const pat = {
  memExtractAttempt: 0, memExtractFailBr: 0, memExtractOk: 0, memExtractEmpty: 0,
  entExtractAttempt: 0, entExtractFailBr: 0, entExtractOk: 0, entAllFail: 0,
  emptyModelAttempt: 0, emptyModelFail: 0,
  memAdded: 0, entitiesAdded: 0,
  heartbeat: 0,
};
for (const l of L) {
  const m = l.match(/ - (INFO|WARNING|ERROR) - ([\s\S]*)$/);
  if (!m) continue;
  lv[m[1]] = (lv[m[1]] || 0) + 1;
  const b = m[2];
  if (/v1\/embeddings/.test(b)) pat.heartbeat++;
  if (/\[记忆提取\] 尝试/.test(b)) pat.memExtractAttempt++;
  if (/\[记忆提取\].*调用成功/.test(b)) pat.memExtractOk++;
  if (/\[记忆提取\].*调用失败.*br/.test(b)) pat.memExtractFailBr++;
  if (/\[记忆提取\] 所有模型\/重试均未能解析出记忆/.test(b)) pat.memExtractEmpty++;
  if (/\[实体提取\] 尝试/.test(b)) pat.entExtractAttempt++;
  if (/\[实体提取\].*调用失败.*br/.test(b)) pat.entExtractFailBr++;
  if (/\[实体提取\].*调用成功/.test(b)) pat.entExtractOk++;
  if (/\[实体提取\] 所有模型均失败/.test(b)) pat.entAllFail++;
  if (/\[实体提取\] 尝试  \(/.test(b)) pat.emptyModelAttempt++;
  if (/\[实体提取\]  调用失败/.test(b)) pat.emptyModelFail++;
  if (/\[OK\] 新增记忆/.test(b)) pat.memAdded++;
  if (/\[OK\] 自动提取实体/.test(b)) pat.entitiesAdded++;
}
console.log('log levels:', lv);
console.log('patterns:', pat);

// timeline of extraction sessions
console.log('\n=== 提取会话时间线 ===');
for (const l of L) {
  if (/\[记忆提取\] (输入对话|尝试|所有模型)|\[记忆提取\].*调用成功|\[OK\] 新增记忆|\[实体提取\] 所有模型均失败|\[实体提取\]  调用失败/.test(l)) {
    console.log(l.replace(/^\S+ (\S+),(\d+) -/, '$1').slice(0, 170));
  }
}

// gap analysis on heartbeats
const times = L.map(l => { const m = l.match(/^(\S+) (\S+),/); return m ? `${m[1]}T${m[2]}` : null; }).filter(Boolean);
console.log('\nfirst ts:', times[0], 'last ts:', times[times.length - 1]);
// largest gaps
let gaps = [];
for (let i = 1; i < times.length; i++) {
  const d = new Date(times[i]) - new Date(times[i - 1]);
  if (d > 180000) gaps.push({ from: times[i - 1], to: times[i], sec: Math.round(d / 1000) });
}
console.log('gaps > 3min:', gaps.length);
gaps.slice(0, 10).forEach(g => console.log('  ', g.sec + 's', g.from, '->', g.to));
