#!/usr/bin/env node
/**
 * _probe/reload-config-accept.cjs — 「控制中心保存 → 宿主热重载」端到端验收（2026-11-17 六十二轮）
 *
 * 为什么必须有这条：用户报「UI 换了 API key 没用」。查下来是
 * `/reload-config` 用 `getAllWindows()[0]` 打在字幕窗上（那里没有 reloadConfig），
 * 却仍返回 success:true —— 于是「已保存」是个假承诺，宿主一直用旧凭据。
 *
 * 这个验收不改任何敏感字段：只改 `wb`（一个被禁用的备用 provider）的**显示名**，
 * 走「写盘 → POST /reload-config → 读运行中的内存」这条链，最后一定还原。
 * 显示名变了 = 宿主真的重读了 provider 列表 = 以后换 key 也会生效。
 *
 * 用法：node _probe/reload-config-accept.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const PROV = path.join(APP, 'llm_providers.json');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function post(port, pathname, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }, timeout: timeoutMs },
      (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { reject(new Error('非 JSON')); } }); });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.write(payload); r.end();
  });
}

const readMemName = async (id) => {
  const r = await post(8004, '/eval', {
    js: `(function(){try{var m=require('./js/core/llm-provider.js').llmProviderManager;var p=m._providers.get(${JSON.stringify(id)});return p?String(p.name):null;}catch(e){return 'ERR:'+e.message}})()`,
  });
  return r && r.value;
};

(async () => {
  const original = fs.readFileSync(PROV, 'utf8');
  const data = JSON.parse(original);
  const wb = (data.providers || []).find((p) => p.id === 'wb');
  if (!wb) { console.error('  ✗ 找不到 wb provider（验收无法进行）'); console.log('  0/1 全过'); process.exit(1); }

  const origName = String(wb.name || '');
  const marker = '热重载验收-' + Date.now();
  try {
    ok('改动前内存里有 wb', (await readMemName('wb')) !== null);

    wb.name = marker;
    fs.writeFileSync(PROV, JSON.stringify(data, null, 2), 'utf8');

    const reload = await post(3002, '/reload-config', {});
    ok('/reload-config 报成功', reload && reload.success === true, JSON.stringify(reload && reload.message));
    ok('/reload-config 不再假绿（消息是「配置已重新加载」）',
      String(reload && reload.message).indexOf('未找到') < 0, String(reload && reload.message));

    const memAfter = await readMemName('wb');
    ok('宿主真的重读了 provider（内存显示名已变）', memAfter === marker, String(memAfter));
  } finally {
    // 一定还原：先恢复文件，再让宿主重读一次
    fs.writeFileSync(PROV, original, 'utf8');
    try { await post(3002, '/reload-config', {}); } catch (e) { /* 还原时失败也要报出来 */ }
    const back = await readMemName('wb').catch(() => null);
    ok('还原后内存也回到原名', back === origName, String(back));
  }

  console.log('  ' + (fail === 0 ? '✅' : '❌') + ' 控制中心→宿主热重载：PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('  ✗ 验收中断：' + (e && e.message || e)); process.exit(1); });
