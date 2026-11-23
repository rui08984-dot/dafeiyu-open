#!/usr/bin/env node
/**
 * _probe/provider-key-check.cjs — 校验当前 provider 凭据「文件里的」和「内存里的」是否一致 + 真调一次
 *
 * 为什么需要：2026-11-16 出过「保存路径用 legacy 字段覆盖 provider」，2026-11-17 用户又报
 * 「UI 换了 key 没用」。provider 管理器是**启动时 init 的内存 Map**，写盘不等于生效 ——
 * 所以必须分三步量：① 文件里是什么 ② 运行中的进程认的是什么 ③ 这个 key 到底通不通。
 *
 * 绝不打印密钥本体：只打印长度与 sha256 前 8 位（够比对，不够泄密）。
 *
 * 用法：
 *   node _probe/provider-key-check.cjs            # 只比文件 vs 内存
 *   node _probe/provider-key-check.cjs --live     # 额外真调一次 /chat/completions
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const PROV = path.join(APP, 'llm_providers.json');
const DEVTOOLS = Number(process.env.PET_DEVTOOLS_PORT || 8004);

const fp = (s) => (s ? crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8) : '(空)');
const live = process.argv.includes('--live');

function post(port, pathname, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }, timeout: timeoutMs },
      (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString('utf8') })); });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.write(payload); r.end();
  });
}

(async () => {
  const data = JSON.parse(fs.readFileSync(PROV, 'utf8'));
  const providers = Array.isArray(data.providers) ? data.providers : [];
  console.log('== ① 文件（llm_providers.json）==');
  for (const p of providers) {
    console.log(`  ${p.id}: url=${p.api_url} keyLen=${String(p.api_key || '').length} keyFp=${fp(p.api_key)} enabled=${p.enabled !== false}`);
  }

  console.log('\n== ② 运行中的宿主（8004 /eval 读内存）==');
  let mem = null;
  try {
    const r = await post(DEVTOOLS, '/eval', {
      js: `(function(){try{
        const m = window.llmProviderManager || (window.global && global.llmProviderManager) || (typeof llmProviderManager!=='undefined'?llmProviderManager:null);
        if(!m) return {err:'no llmProviderManager'};
        const out=[];
        for (const [id,p] of m._providers.entries()) out.push({id, url:p.api_url, keyLen:(p.api_key||'').length});
        return {defaultId:m._defaultId, modelId:m._activeModelId, providers:out};
      }catch(e){return {err:String(e&&e.message||e)}}})()`,
    });
    const j = JSON.parse(r.text);
    mem = j.value || null;
    if (mem && mem.providers) {
      for (const p of mem.providers) console.log(`  ${p.id}: url=${p.url} keyLen=${p.keyLen}`);
      console.log(`  默认 provider=${mem.defaultId} 模型=${mem.modelId}`);
    } else {
      console.log('  读不到：' + JSON.stringify(mem));
    }
  } catch (e) {
    console.log('  8004 不可达：' + (e && e.message || e));
  }

  // 文件 vs 内存：长度不同就是「写盘了但进程还用旧的」
  if (mem && mem.providers) {
    let mismatch = false;
    for (const p of providers) {
      const m = mem.providers.find((x) => x.id === p.id);
      if (!m) { mismatch = true; console.log(`  ⚠ ${p.id} 只在文件里，内存没有`); continue; }
      if (m.keyLen !== String(p.api_key || '').length) {
        mismatch = true;
        console.log(`  ⚠ ${p.id} 长度不一致：文件 ${String(p.api_key || '').length} / 内存 ${m.keyLen} → 需要重启宿主`);
      }
    }
    console.log(mismatch ? '  ⇒ 结论：文件与内存不一致（写盘没生效到进程）' : '  ⇒ 结论：文件与内存一致');
  }

  if (!live) return;
  console.log('\n== ③ 真调一次（直连 provider，不经她的引擎）==');
  const p = providers.find((x) => x.id === 'comad') || providers[0];
  const model = (p.models && p.models[0] && (p.models[0].model_id || p.models[0].id)) || 'deepseek/deepseek-v4.1-flash';
  const body = { model, messages: [{ role: 'user', content: '回复 ok' }], max_tokens: 8, stream: false };
  const url = new URL(p.api_url.replace(/\/$/, '') + '/chat/completions');
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const status = await new Promise((resolve) => {
    const mod = url.protocol === 'https:' ? require('node:https') : http;
    const r = mod.request({ host: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': payload.length,
        Authorization: 'Bearer ' + p.api_key,
        // 网关按 UA 拦 Python 默认 UA（踩过 403），这里显式声明
        'User-Agent': 'pet-runtime-provider-check/1.0', 'Accept-Encoding': 'identity',
      }, timeout: 30000 },
      (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ s: res.statusCode, b: Buffer.concat(c).toString('utf8') })); });
    r.on('error', (e) => resolve({ s: 0, b: String(e && e.message || e) }));
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.write(payload); r.end();
  });
  console.log(`  HTTP ${status.s}`);
  let brief = status.b;
  try {
    const j = JSON.parse(status.b);
    brief = j.error ? JSON.stringify(j.error).slice(0, 300) : `model=${j.model} usage=${JSON.stringify(j.usage || {})}`;
  } catch (e) { brief = brief.slice(0, 300); }
  console.log('  ' + brief);
})().catch((e) => { console.error('检查失败：' + (e && e.stack || e)); process.exit(1); });
