#!/usr/bin/env node
/**
 * _probe/world-accept.cjs — 世界感知真机验收（2026-11-17 六十二轮）
 *
 * 为什么单独一个验收：世界感知的「有没有在工作」不是单测能证明的 ——
 * 单测证明判据与预算，这个脚本证明**真机上真的在读**：
 *   - 8103 `/world` 能读到、字段齐全、活动状态合法
 *   - 1s 采样真的在跑（两次读 samples 会增长）
 *   - 单次采样成本在预算内（便宜源，不该超过 20ms）
 *   - 变化历史里没有 `user.idle_ms` 洪水（否则真事件会被冲掉）
 *   - 用真实 payload 渲染出来的世界行 ≤100 tokens
 *   - 开关能运行时切换并生效（隐私模式往返；**结束时一定还原**）
 *
 * 刻意不做的事：不抢焦点、不启动播放器、不截图 —— 验收不该打扰用户。
 * 切窗口/放歌/空闲这类「有外部动作」的验证在交接文档里用手工证据记录。
 *
 * 用法：node _probe/world-accept.cjs
 * 退出码：0 = PASS，1 = FAIL（宿主没起也算 FAIL，和别的验收一致）
 */

'use strict';

const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WS = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'world-store.js'));

const HOST = '127.0.0.1';
const PORT = Number(process.env.PET_CONTROL_PORT || 8103);

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function req(method, pathname, body, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request({
      host: HOST, port: PORT, path: pathname, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (e) { reject(new Error('响应不是 JSON：' + Buffer.concat(chunks).toString('utf8').slice(0, 120))); }
      });
    });
    r.on('timeout', () => { r.destroy(new Error('请求超时')); });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// C1：meeting 只来自用户纠正（world-priors），但 /world 必须认它是合法状态。
const KNOWN_STATES = ['working', 'gaming', 'watching', 'meeting', 'idle', 'away', 'unknown'];

(async () => {
  let privacyTouched = false;
  try {
    const r1 = await req('GET', '/world');
    ok('8103 /world 可读', r1.status === 200 && r1.json && typeof r1.json === 'object', 'status=' + r1.status);
    const w1 = r1.json && r1.json.world;
    ok('/world 返回世界状态', !!(w1 && w1.world), w1 ? 'ok=' + w1.ok : 'null');
    if (!w1 || !w1.world) throw new Error('/world 没有世界状态（世界感知未挂载？）');

    ok('世界感知已启用', w1.enabled === true && w1.privacy !== true, 'enabled=' + w1.enabled + ' privacy=' + w1.privacy);
    ok('活动状态合法', KNOWN_STATES.indexOf(w1.activity.state) >= 0, w1.activity.state);
    ok('活动置信度在 [0,1]', w1.activity.conf >= 0 && w1.activity.conf <= 1, String(w1.activity.conf));
    ok('活动状态有起始时刻', Number(w1.activity.since) > 0);
    ok('前台应用非空（她在用电脑）', typeof w1.world.app === 'string' && w1.world.app.length > 0, w1.world.app);
    ok('stale 标记齐全', w1.world.stale && typeof w1.world.stale.app === 'boolean');
    ok('单次采样在便宜源预算内（<20ms）', Number(w1.cost.sampleUs) < 20000, w1.cost.sampleUs + 'µs');
    ok('采样零错误（或错误有原因）', Number(w1.cost.errors) === 0 || !!w1.cost.lastErr,
      'errors=' + w1.cost.errors + (w1.cost.lastErr ? ' / ' + w1.cost.lastErr : ''));

    // 变化历史不能被 idle 毫秒冲爆
    const changes = Array.isArray(w1.changes) ? w1.changes : [];
    ok('变化历史没有被 user.idle_ms 冲爆',
      changes.filter((c) => c.field === 'user.idle_ms').length === 0,
      changes.map((c) => c.field).join(','));

    // 用真 payload 渲染世界行（和历史无关，第一次渲染 → 全字段）
    const snapForRender = {
      activity: w1.activity.state,
      app: w1.world.app,
      title: w1.world.title,
      mediaTitle: w1.world.mediaTitle,
      media: w1.world.media && w1.world.media !== 'none' ? ('媒体=' + w1.world.media + (w1.world.mediaTitle ? '《' + w1.world.mediaTitle + '》' : '')) : '',
      idleSec: w1.world.idleSec,
      clip: w1.world.clip,
    };
    const line = WS.renderWorldLine(null, snapForRender, {});
    ok('世界行 ≤100 tokens', line.tokens <= WS.DEFAULTS.maxTokens, line.tokens + ' tokens');
    ok('世界行不超过硬上限 120', line.tokens <= WS.DEFAULTS.hardMaxTokens, line.tokens + ' tokens');

    // 采样在跑：等 3 秒，samples 必须增长
    const before = Number(w1.cost.samples) || 0;
    await new Promise((r) => setTimeout(r, 3000));
    const r2 = await req('GET', '/world');
    const w2 = r2.json && r2.json.world;
    ok('1s 采样循环在跑（3 秒内 samples 增长）', w2 && Number(w2.cost.samples) > before,
      before + ' → ' + (w2 ? w2.cost.samples : '?'));

    // 开关：隐私模式往返（结束时必须还原，否则她会一直瞎着）
    const base = { privacy: w1.privacy === true };
    const setP = await req('POST', '/world', { privacy: true });
    privacyTouched = true;
    ok('POST /world 能改开关', setP.status === 200 && setP.json && setP.json.ok === true, 'status=' + setP.status);
    await new Promise((r) => setTimeout(r, 1200));
    const r3 = await req('GET', '/world');
    const w3 = r3.json && r3.json.world;
    ok('隐私模式真的生效（/world 显示 privacy=true）', w3 && w3.privacy === true, w3 ? String(w3.privacy) : '?');
    const restored = await req('POST', '/world', { privacy: base.privacy });
    privacyTouched = false;
    ok('隐私模式能改回来', restored.status === 200 && restored.json && restored.json.ok === true);

    console.log('  ' + (fail === 0 ? '✅' : '❌') + ' 世界感知真机验收：PASS ' + pass + ' / FAIL ' + fail);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    if (privacyTouched) {
      try { await req('POST', '/world', { privacy: false }); console.error('  （已尝试还原 privacy=false）'); } catch (e2) { /* */ }
    }
    console.error('  ✗ 验收中断：' + (e && e.message || e));
    console.log('  ❌ 世界感知真机验收：PASS ' + pass + ' / FAIL ' + (fail + 1));
    process.exit(1);
  }
})();
