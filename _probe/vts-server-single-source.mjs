#!/usr/bin/env node
/**
 * _probe/vts-server-single-source.mjs —— 「两套 vts-server」收敛验收（2026-11-17 六十五轮）
 *
 * 背景：之前 `pet-runtime/vts-server.mjs`（326 行）与 `live-2d/petbridge/vts-server.mjs`（513 行）
 * 是两份独立实现，长期分叉（宿主编加了 /world，standalone 没有）。
 * 现在 standby 那份是**一行 re-export**，本探针钉住两件事：
 *
 *   ① **同一个函数**：两个 import 拿到的 `startVtsServer` 必须是同一个引用
 *      （不是「长得像的两份」）；只要有人再复制一份实现，这条立刻红。
 *   ② **真能起来**：用备用端口把封装版启动一次，/health 返回 ok 再关掉
 *      （证明 re-export 的依赖在 standalone 场景下也解析得到）。
 *
 * 用法：node _probe/vts-server-single-source.mjs
 * 退出码：0 全过 / 1 有失败
 */

'use strict';

import http from 'node:http';

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const WRAPPER = new URL('../pet-runtime/vts-server.mjs', import.meta.url);
const CANONICAL = new URL('../_incoming/my-neuro/live-2d/petbridge/vts-server.mjs', import.meta.url);

const P_VTS = 18001;
const P_INNER = 18102;
const P_CTRL = 18103;

function get(port, pathname, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', timeout: timeoutMs }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, body: String(e && e.message || e) }));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const wrapper = await import(WRAPPER.href).catch((e) => ({ __err: e }));
  const canonical = await import(CANONICAL.href).catch((e) => ({ __err: e }));

  ok('封装版能 import', typeof wrapper.startVtsServer === 'function',
    wrapper.__err ? String(wrapper.__err.message) : typeof wrapper.startVtsServer);
  ok('宿主版能 import', typeof canonical.startVtsServer === 'function',
    canonical.__err ? String(canonical.__err.message) : typeof canonical.startVtsServer);
  ok('**两边是同一个函数**（真正单一实现，不是复制）',
    wrapper.startVtsServer === canonical.startVtsServer);

  // 真启动一次（备用端口，避免撞上线上 8001/8102/8103）
  let server = null;
  try {
    server = wrapper.startVtsServer({
      port: P_VTS,
      internalPort: P_INNER,
      controlPort: P_CTRL,
      model: { id: 'probe', name: 'probe', expressions: [], hotkeys: [], parameters: [] },
      log: () => {},
    });
    ok('能启动并返回控制对象', !!server && typeof server.close === 'function');

    let health = null;
    for (let i = 0; i < 25; i += 1) {
      await sleep(120);
      health = await get(P_CTRL, '/health');
      if (health.status === 200) break;
    }
    ok('控制口 /health 可用', health && health.status === 200, health ? 'status=' + health.status : 'no response');
    let json = null;
    try { json = JSON.parse(health.body); } catch (e) { /* 下面断言会报 */ }
    ok('/health 返回 ok:true', !!(json && json.ok === true), health.body.slice(0, 120));

    // 单一实现带来的直接收益：standalone 也有 /world 了（以前没有）
    const world = await get(P_CTRL, '/world');
    ok('standalone 也能访问 /world（收敛的直接收益）', world.status === 200 && /ok/.test(world.body),
      world.body.slice(0, 100));
    ok('未挂载 getWorld 时如实报错，不假装有数据',
      /世界感知未挂载/.test(world.body), world.body.slice(0, 120));
  } finally {
    try { if (server) server.close(); } catch (e) { /* 关不掉不影响结论 */ }
  }

  console.log('  ' + (fail === 0 ? '✅' : '❌') + ' vts-server 单一实现：PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('  ✗ 探针自身异常：' + (e && e.stack || e));
  console.log('  ❌ vts-server 单一实现：PASS ' + pass + ' / FAIL ' + (fail + 1));
  process.exit(1);
});
