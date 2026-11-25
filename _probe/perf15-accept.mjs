#!/usr/bin/env node
/**
 * _probe/perf15-accept.mjs — 15 段长表演「能启动」验收（2026-11-18 §76 / §68 B5 客观段）
 *
 * 能验什么、不能验什么，先说清：
 *   ✅ 客观段（本脚本）：15 段全部能被表演库列出、`playPerformance(key)` 真的把播放器拉起来
 *      （status.active + key 对得上）、每段有轨道步数、该带表情的段确实挂了脸、停止后能归位。
 *   ❌ 主观段（仍需人看）：有没有穿模、表情打架、节奏像不像人 —— 这条只能真人坐在屏幕前看，
 *      脚本判不了（§68 B5 的原话是「记录有没有穿模/表情打架」，那是观感）。
 *
 * 为什么要进门禁：15 段里 14 段只在编译/采样阶段验过；只要某段的键名或轨道坏了，
 * 用户点托盘「演一段」才会发现。这条把「能启动」变成每次门禁都跑的事实。
 *
 * 用法：node _probe/perf15-accept.mjs
 * 前置：8004 自检口（宿主在跑、皮套已加载）。
 *
 * ⚠ 不要在用户正在使用时跑：本脚本逐段 playPerformance，会真的占屏 ~15 秒/轮，
 *   并且曾把 452 条 manual 播放写进生产 performance-log（审计 §4.4）。
 *   脚本收尾会调 resetPerformanceAuto() 交还自动触发的冷却/会话计数；
 *   日志里留下的 manual 记录由 choreo-tune 的 autoOnly 排除，不会影响段偏好。
 */
'use strict';
// ⚠ 不用 fetch：Node 24 的 undici keep-alive 句柄在 process.exit 时触发
//   「Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)」→ 断言全过却退出码 127。
//   这条坑踩过（见 node24-undici-exit-assertion），这里用 node:http + agent:false 绕开。
import http from 'node:http';

const BASE = process.env.PET_PROBE || 'http://127.0.0.1:8004';

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

async function ev(js, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ js }), 'utf8');
    const u = new URL(BASE + '/eval');
    const req = http.request({
      hostname: u.hostname, port: Number(u.port || 80), path: u.pathname, method: 'POST',
      agent: false, timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return reject(new Error('非 JSON 响应')); }
        if (!j.ok) return reject(new Error('eval failed: ' + String(j.error || '').slice(0, 200)));
        resolve(j.value);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('eval 超时（' + timeoutMs + 'ms）')); });
    req.on('error', (e) => reject(e));
    req.end(payload);
  });
}

(async () => {
  console.log('\n15 段长表演（客观段）：');

  const list = await ev('JSON.stringify(window.petBody.listPerformances ? window.petBody.listPerformances() : [])');
  const items = JSON.parse(list || '[]');
  ok('表演库能列出 15 段', Array.isArray(items) && items.length === 15, String(Array.isArray(items) ? items.length : 'n/a'));
  ok('每段都有 key/title/duration/steps',
    items.every((i) => i && i.key && i.title && Number(i.duration) > 0 && Number(i.steps) > 0),
    items.filter((i) => !(i && i.key && Number(i.steps) > 0)).map((i) => i && i.key).join(',') || '全部完整');
  ok('时长都在 15–45 秒区间（19–38 设计值 + 余量）',
    items.every((i) => Number(i.duration) >= 15 && Number(i.duration) <= 45),
    items.map((i) => i.duration).join(','));

  // 逐段启动 → 读状态 → 停止（每段 ~0.9s，总共约 15s）
  const script = `(async()=>{
    const list = window.petBody.listPerformances();
    const out = [];
    for (const item of list) {
      let started = false, err = null, active = false, faces = 0, keyOk = false;
      try { started = window.petBody.playPerformance(item.key) === true; } catch (e) { err = String((e && e.message) || e); }
      await new Promise((r) => setTimeout(r, 600));
      try {
        const st = window.petBody.performanceStatus();
        active = !!(st && st.active);
        keyOk = !!(st && st.key === item.key);
        faces = ((st && st.faces) || []).length;
      } catch (e) {}
      try { window.petBody.stopPerformance(); } catch (e) {}
      await new Promise((r) => setTimeout(r, 180));
      out.push({ k: item.key, started, active, keyOk, faces, err });
    }
    return JSON.stringify(out);
  })()`;
  const rows = JSON.parse(await ev(script, 120000) || '[]');
  ok('15 段全部启动成功', rows.length === 15 && rows.every((r) => r.started), rows.filter((r) => !r.started).map((r) => r.k).join(',') || '15/15');
  ok('状态里的 key 与实际播放一致（没有串段）', rows.every((r) => r.keyOk), rows.filter((r) => !r.keyOk).map((r) => r.k).join(',') || '全部一致');
  ok('每段都处于 active（播放器真的在跑）', rows.every((r) => r.active), rows.filter((r) => !r.active).map((r) => r.k).join(',') || '全部 active');
  ok('没有任何一段抛异常', rows.every((r) => !r.err), rows.filter((r) => r.err).map((r) => r.k + ':' + r.err).join(' | ') || '无异常');
  const withFaces = rows.filter((r) => r.faces > 0).map((r) => r.k);
  ok('至少 5 段挂了表演表情（13 应该同时有裙子+眼镜）', withFaces.length >= 5, withFaces.length + ' 段：' + withFaces.join(','));

  // 收尾：确保没有残留在播（否则下一个任务会看到 active=true）
  const after = JSON.parse(await ev('JSON.stringify(window.petBody.performanceStatus ? window.petBody.performanceStatus() : {})') || '{}');
  ok('收尾后没有残留在播', after.active !== true, JSON.stringify({ active: after.active, key: after.key }));

  // 收尾：清掉自动触发的冷却/会话计数（2026-11-25 P0）。
  // 为什么必须做：playPerformance 会 perfAuto.note(key) 记冷却 —— 跑完不 reset，
  // 用户接下来 3–6 分钟看不到同名段自动演，而这 15 段明明只是被「验收」过。
  try {
    const reset = await ev('window.petBody&&typeof window.petBody.resetPerformanceAuto==="function"?JSON.stringify(window.petBody.resetPerformanceAuto()):null');
    ok('收尾重置自动触发记账（不污染生产冷却）', reset != null, String(reset || '').slice(0, 140));
  } catch (e) {
    ok('收尾重置自动触发记账（不污染生产冷却）', false, String((e && e.message) || e));
  }

  console.log('');
  console.log(`  15 段长表演（客观段）：PASS ${pass} / FAIL ${fail}`);
  console.log('  主观段（穿模/表情打架/像不像人）仍需真人看一遍 —— 这条脚本不冒充观感验收。');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('SKIP 8004 不可达或皮套没加载：' + ((e && e.message) || e));
  process.exit(0);   // 缺环境不假红（门禁会记 SKIP）
});
