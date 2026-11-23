#!/usr/bin/env node
/**
 * _probe/mobile-3003-e2e.mjs —— 3003 手机遥控端到端（令牌 + 白名单）验收
 *
 * 背景：§56 跨轮遗留「3003 端到端未测（token 鉴权那次没做成）」。
 * 本探针只做**无副作用**的端到端：
 *   ① 带令牌 GET /remote/status      → ok:true（真实读到她的状态）
 *   ② 不带令牌 GET /remote/status    → unauthorized（鉴权生效）
 *   ③ 带令牌 POST 非法动作   → 拒绝（白名单生效，不触达桌面）
 *   ④ 带令牌 POST 非法表情   → 拒绝
 * 不发送任何会让她说话/动起来的请求。
 *
 * 用法：node _probe/mobile-3003-e2e.mjs
 * 退出码：0 全过 / 1 失败 / 0 SKIP（3003 没起）
 */
'use strict';

import fs from 'node:fs';
import http from 'node:http';

const BASE = 'http://127.0.0.1:3003';
const TOKEN_FILE = '<project-root>/_incoming/my-neuro/data/遥控令牌.txt';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

// 用 node:http 而不是 fetch/undici：Windows + Node 24 上 process.exit 时
// undici 的 keep-alive 句柄会触发 libuv 断言（!(handle->flags & UV_HANDLE_CLOSING)），
// 门禁里表现为「断言全过但退出码 127」。
function request(method, path, body, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const req = http.request({
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
      timeout: timeoutMs,
      agent: false,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(new Error('bad json: ' + raw.slice(0, 80))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const get = (path, timeoutMs) => request('GET', path, null, timeoutMs);
const post = (path, obj, timeoutMs) => request('POST', path, JSON.stringify(obj), timeoutMs);

async function main() {
  // 探活
  try {
    await get('/remote/status', 3000);
  } catch (e) {
    console.log('SKIP 3003 端到端 — 端口未通（遥控服务没起？）');
    process.exit(0);
  }

  let token = '';
  try {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (e) {
    console.log('SKIP 3003 端到端 — 读不到令牌文件：' + e.message);
    process.exit(0);
  }

  console.log('[3003 端到端 · 令牌与白名单]');

  // ① 带令牌读状态
  const st = await get('/remote/status?t=' + encodeURIComponent(token));
  check('带令牌 GET /remote/status → ok', st && st.ok === true, st && st.ok ? '有状态数据' : JSON.stringify(st).slice(0, 80));
  if (st && st.ok) {
    const keys = Object.keys(st.data || st.state || st).filter((k) => k !== 'ok');
    check('状态里有字段', keys.length > 0, keys.slice(0, 6).join(','));
  }

  // ② 无令牌
  const noT = await get('/remote/status');
  check('无令牌 GET /remote/status → unauthorized', noT && noT.ok === false && /unauthorized/i.test(noT.error || ''), noT && noT.error);

  // ③ 非法动作名（白名单）
  const badScene = await post('/remote/perform?t=' + encodeURIComponent(token), { scene: '__probe_not_in_whitelist__' });
  check('非法动作 → 拒绝', badScene && badScene.ok === false && /白名单/.test(badScene.error || ''), badScene && badScene.error);

  // ④ 非法表情
  const badEmo = await post('/remote/emotion?t=' + encodeURIComponent(token), { emotion: '__probe_not_in_whitelist__' });
  check('非法表情 → 拒绝', badEmo && badEmo.ok === false && /白名单/.test(badEmo.error || ''), badEmo && badEmo.error);

  console.log('\n' + '─'.repeat(52));
  console.log(`PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('探针异常：', e && e.stack || e);
  process.exit(1);
});
