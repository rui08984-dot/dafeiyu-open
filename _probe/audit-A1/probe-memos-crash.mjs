const BASE = 'http://127.0.0.1:8003';
const health = async () => {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3000);
    const r = await fetch(BASE + '/', { signal: c.signal });
    clearTimeout(t);
    return r.status;
  } catch (e) { return 'ERR:' + (e.cause?.code || e.name); }
};
const search = async (q) => {
  const t0 = performance.now();
  try {
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), 30000);
    const r = await fetch(BASE + '/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ query: q, user_id: 'feiniu_default', top_k: 5 }), signal: c.signal,
    });
    clearTimeout(timer);
    const j = await r.json().catch(() => null);
    return { ok: true, status: r.status, ms: Math.round(performance.now() - t0), hits: j?.memories?.length };
  } catch (e) {
    return { ok: false, err: e.name + ':' + (e.cause?.code || ''), ms: Math.round(performance.now() - t0) };
  }
};
const qs = ['青轴机械键盘', '主人喜欢猫', '流量王番外篇', '向日葵', 'QQ 联系人', 'ZCode 首页', '机械键盘', '主人偏好', '考试复习', '电动车', '蓝队', '甘雨'];
for (const [i, q] of qs.entries()) {
  const h = await health();
  const r = await search(q);
  console.log(`#${i + 1} health=${h} search ok=${r.ok} ${r.ms}ms hits=${r.hits ?? '-'} ${r.err || ''}`);
  if (!r.ok) {
    console.log('>>> 疑似崩溃，做 3 次健康探测：');
    for (let k = 0; k < 3; k++) { await new Promise(r2 => setTimeout(r2, 2000)); console.log('   health:', await health()); }
    process.exit(0);
  }
  await new Promise(r2 => setTimeout(r2, 150));
}
console.log('12 次全部成功，未复现崩溃');
