import fs from 'node:fs';

const URL = 'http://127.0.0.1:8003/search';
async function search(q, top_k = 5) {
  const t0 = performance.now();
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ query: q, user_id: 'feiniu_default', top_k }),
  });
  const t1 = performance.now();
  const j = await r.json().catch(() => null);
  return { ms: Math.round(t1 - t0), status: r.status, j };
}

// 1) 回查事件卡是否入库
const cards = [
  { id: 'card1 三十九轮补传链路验证用测试卡', q: 'ZCODE 三十九轮补传链路验证用测试卡 测试帧A' },
  { id: 'card2 流量王番外篇蓝队', q: '流量王番外篇蓝队 蓝队这波运营太细腻了' },
  { id: 'card3 流量王番外篇第三集(蓝队反超)', q: '流量王番外篇第三集 蓝队最后一分钟反超比分拿下冠军' },
  { id: 'card4 陪伴记录(笑了三次)', q: '一起看完流量王番外篇第三集 笑了三次 气氛轻松愉快' },
  { id: 'card5  fundamentally same as card4', q: '主人看到反超的时候连着笑了三次 这集太有意思了' },
];
console.log('=== 事件卡回查（top3，sim>0.5）===');
for (const c of cards) {
  const { ms, j } = await search(c.q, 3);
  const mems = j?.memories || [];
  console.log(`\n[${c.id}] ${ms}ms  hits=${mems.length}`);
  for (const m of mems) console.log(`   sim=${m.similarity}  ${String(m.content).slice(0, 70)}`);
}

// 2) latency stats
console.log('\n=== 检索延迟（8 次同查询）===');
const qs = ['青轴机械键盘', '主人喜欢猫', '流量王番外篇', '植物大战僵尸 向日葵', 'QQ 联系人', 'ZCode 首页', '机械键盘声音', '主人偏好'];
const lat = [];
for (const q of qs) {
  const { ms, status, j } = await search(q, 5);
  lat.push(ms);
  console.log(`  ${q}: ${ms}ms status=${status} hits=${(j?.memories || []).length}`);
}
lat.sort((a, b) => a - b);
const avg = lat.reduce((a, b) => a + b, 0) / lat.length;
console.log(`min=${lat[0]} p50=${lat[Math.floor(lat.length / 2)]} max=${lat[lat.length - 1]} avg=${avg.toFixed(0)}`);

// 3) similarity distribution sanity
console.log('\n=== similarity 是否 >1 ===');
const { j: big } = await search('主人', 20);
const sims = (big?.memories || []).map(m => m.similarity);
console.log('n=', sims.length, 'max=', Math.max(...sims), '>1 count=', sims.filter(s => s > 1).length);
console.log('sample sims:', sims.slice(0, 10));
