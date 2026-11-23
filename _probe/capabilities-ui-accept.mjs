#!/usr/bin/env node
/**
 * _probe/capabilities-ui-accept.mjs —— 能力注册表接前端验收（2026-11-16 P1）
 *
 * 验五件事（全走真实链路：8771 自检口 → 渲染层 → IPC → config.json）：
 *   ① 设置页「能力」区由 js/core/capabilities.js 生成（行数=注册表条数、有分组/开关/端口）
 *   ② 勾一个 config 开关 → config.json 真变了（非只改内存）
 *   ③ 再勾回来 → 恢复原值（不留副作用）
 *   ④ 未声明的键写不进去（白名单）
 *   ⑤ 类型不对写不进去（boolean 字段传字符串）
 *
 * 用法：node _probe/capabilities-ui-accept.mjs
 * 退出码：0 全过 / 1 失败 / 0 SKIP（控制中心没开）
 */
'use strict';

import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CAPABILITIES } = require('<project-root>/_incoming/my-neuro/live-2d/js/core/capabilities.js');
const crypto = require('node:crypto');
const CONFIG = '<project-root>/_incoming/my-neuro/live-2d/config.json';
const PROVIDERS = '<project-root>/_incoming/my-neuro/live-2d/llm_providers.json';
const hashFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

let pass = 0, fail = 0;
const check = (n, ok, d) => {
  if (ok) { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

// 用 node:http：Windows + Node 24 在 process.exit 时 fetch/undici 的 keep-alive
// 句柄会触发 libuv 断言（退出码 127），门禁会判假失败。
async function evalJs(js) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ js });
    const req = http.request({
      host: '127.0.0.1', port: 8771, path: '/eval', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000, agent: false,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          if (!j.ok) reject(new Error('eval failed: ' + raw.slice(0, 120)));
          else resolve(j.value);
        } catch (e) { reject(new Error('bad response: ' + raw.slice(0, 120))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readConfig = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const getPath = (obj, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj);

async function waitFor(fn, ms = 6000, step = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

async function main() {
  // 探活
  try { await evalJs('1'); } catch (e) {
    console.log('SKIP 能力注册表前端验收 — 控制中心没开（8771 不通）');
    process.exit(0);
  }

  // 等渲染层把行铺好（启动后异步拉一次）
  const okRows = await waitFor(async () => {
    const n = await evalJs('document.querySelectorAll("#capability-rows .cap-row").length');
    return n > 0;
  }, 8000);
  check('能力区已渲染', okRows, okRows ? '' : '8 秒内没有行');

  const info = await evalJs(`(() => {
    const host = document.getElementById('capability-rows');
    return {
      groups: host.querySelectorAll('.cap-group').length,
      rows: host.querySelectorAll('.cap-row').length,
      switches: host.querySelectorAll('input[type=checkbox]').length,
      selects: host.querySelectorAll('select').length,
      ports: host.querySelectorAll('.cap-readonly').length,
      hasApi: typeof window.controlApi?.capabilities === 'function' && typeof window.controlApi?.setConfigValue === 'function',
      hasIntentSwitch: !!host.querySelector('[data-cap-key="llm.intent_router.enabled"]'),
    };
  })()`);
  // 2026-11-21 方案 A：废弃能力不再渲染（声明保留），所以行数 = 有效条数
  const activeCaps = CAPABILITIES.filter((c) => !c.deprecated);
  check('行数 = 注册表有效条数（已废弃的不渲染）', info.rows === activeCaps.length,
    `渲染 ${info.rows} / 有效 ${activeCaps.length}（注册表 ${CAPABILITIES.length}）`);
  check('废弃开关 intent_router 不再渲染', info.hasIntentSwitch === false);

  // 有效值取源可见：llm.reasoning / llm.temperature 的真值在 llm_providers.json 的模型上，
  // 能力页必须显示运行时值并标注来源（模型/静态/默认），不能永远显示 default。
  const effective = await evalJs(`(async () => {
    const items = await window.controlApi.capabilities();
    const pick = (id) => items.find((x) => x.id === id) || null;
    const host = document.getElementById('capability-rows');
    const rowOf = (key) => {
      const input = host.querySelector('[data-cap-key="' + key + '"]');
      return input ? input.closest('.cap-row') : null;
    };
    return {
      rea: pick('llm.reasoning'),
      temp: pick('llm.temperature'),
      intentDeprecated: !!pick('llm.intent_router')?.deprecated,
      reaBadge: (rowOf('llm.reasoning_enabled')?.textContent || ''),
      tempBadge: (rowOf('llm.temperature_enabled')?.textContent || ''),
    };
  })()`);
  check('IPC 返回 valueSource（静态/运行时/默认 三态）',
    !!effective.rea && ['config', 'model', 'default'].includes(effective.rea.valueSource),
    effective.rea ? String(effective.rea.valueSource) : 'missing');
  check('llm.reasoning 显示运行时值 + 来源标记',
    !!effective.rea && typeof effective.rea.value === 'boolean' && /运行时·模型|静态·config\.json|默认值/.test(effective.reaBadge),
    effective.reaBadge.trim().slice(-24));
  check('llm.temperature 显示运行时值 + 来源标记',
    !!effective.temp && typeof effective.temp.value === 'boolean' && /运行时·模型|静态·config\.json|默认值/.test(effective.tempBadge),
    effective.tempBadge.trim().slice(-24));
  check('IPC 里 intent_router 标了 deprecated', effective.intentDeprecated === true);
  check('有分组', info.groups >= 5, `${info.groups} 组`);
  check('有开关行', info.switches >= 20, `${info.switches} 个开关`);
  check('有枚举下拉（取景）', info.selects >= 1, `${info.selects} 个 select`);
  check('有端口只读行', info.ports >= 5, `${info.ports} 个端口`);
  check('preload 暴露 capabilities/setConfigValue', info.hasApi === true);

  // ── 2026-11-21 统一管辖：能力页是唯一启停入口 ────────────────────────────
  // ① 插件类开关必须留在能力页（插件页的每行开关已删）
  const pluginCaps = CAPABILITIES.filter((c) => c.kind === 'plugin' && !c.deprecated);
  const pluginUi = await evalJs(`(() => {
    const cap = document.querySelectorAll('#capability-rows [data-cap-plugin]').length;
    const page = document.querySelectorAll('#installed-plugin-list [data-plugin-enabled]').length;
    const rows = document.querySelectorAll('#installed-plugin-list .plugin-row').length;
    return { cap, page, rows };
  })()`);
  check('能力页插件开关数 = 注册表插件条数', pluginUi.cap === pluginCaps.length,
    `UI ${pluginUi.cap} / 注册表 ${pluginCaps.length}`);
  check('插件页已渲染插件行（不是空页假绿）', pluginUi.rows > 0, `${pluginUi.rows} 行`);
  check('插件页不再有 enable 开关（统一到能力页）', pluginUi.page === 0, `${pluginUi.page} 个`);

  // ② 面板里被删的重复布尔开关：id 全部不存在（有任何一个回来就是回归）
  const removedIds = [
    'quiet-mode-enabled', 'text-input-enabled', 'ptt-enabled', 'barge-enabled',
    'auto-vision', 'history-enabled', 'context-limit', 'temperature-enabled',
    'vision-enabled', 'subtitle-enabled', 'hide-model', 'auto-close-services',
    'latency-filler-enabled', 'petbody-framing-full', 'petbody-click-through',
  ];
  const leftover = await evalJs(`(${JSON.stringify(removedIds)}).filter(id => document.getElementById(id))`);
  check('重复开关全部消失（15 个 id 都不在 DOM）', Array.isArray(leftover) && leftover.length === 0,
    Array.isArray(leftover) ? JSON.stringify(leftover) : String(leftover));

  // ③ 每个被删的键都必须在注册表里（否则功能失去唯一入口 —— 这正是不能删的那类）
  const requiredKeys = [
    'ui.show_chat_box', 'asr.ptt_enabled', 'asr.voice_barge_in', 'vision.auto_screenshot',
    'vision.use_vision_model', 'context.persistent_history', 'context.enable_limit',
    'llm.temperature_enabled', 'subtitle_labels.enabled', 'ui.show_model',
    'auto_close_services.enabled', 'llm.filler_enabled', 'ui.petbody_framing',
    'ui.click_through_default', 'cost.quiet',
  ];
  const missing = requiredKeys.filter((k) => !CAPABILITIES.some((c) => c.kind === 'config' && c.key === k && !c.deprecated));
  check('被删开关的 15 个 config 键都有能力行（无功能失去入口）', missing.length === 0, JSON.stringify(missing));

  // ②③ 真实写盘往返：ui.petbody_perf_auto（声明过、boolean、hot）
  const KEY = 'ui.petbody_perf_auto';
  const cap = CAPABILITIES.find((c) => c.key === KEY);
  check('测试键在注册表里', !!cap, KEY);
  const before = getPath(readConfig(), KEY);
  check('改前有值', typeof before === 'boolean', String(before));

  const clicked = await evalJs(`(() => {
    const el = document.querySelector('input[data-cap-key="${KEY}"]');
    if (!el) return { ok: false, error: '找不到开关' };
    el.click();
    return { ok: true, now: el.checked };
  })()`);
  check('点击能力开关', clicked.ok === true, JSON.stringify(clicked));
  const flipped = !before;
  const providersHashBefore = hashFile(PROVIDERS);
  const wrote = await waitFor(() => getPath(readConfig(), KEY) === flipped, 6000);
  check('config.json 真写盘（非只改内存）', wrote, `${before} → 期望 ${flipped}，实际 ${getPath(readConfig(), KEY)}`);
  // P0 防回归（2026-11-16）：能力开关只该改 config.json，绝不能重写 llm_providers.json。
  // 事故：set-config-value 曾走 saveControlConfig → 用已删除的 legacy 字段把 provider 凭据清空。
  check('provider 通讯录未被能力开关改动（P0 防回归）',
    hashFile(PROVIDERS) === providersHashBefore,
    hashFile(PROVIDERS) === providersHashBefore ? 'hash 不变' : '❌ llm_providers.json 被改动');

  // ③ 恢复
  await evalJs(`(() => { const el = document.querySelector('input[data-cap-key="${KEY}"]'); if (el) el.click(); return true; })()`);
  const restored = await waitFor(() => getPath(readConfig(), KEY) === before, 6000);
  check('再点一次恢复原值', restored, `实际 ${getPath(readConfig(), KEY)}`);

  // ④ 白名单：未声明键
  const bad = await evalJs(`(async () => {
    try { await window.controlApi.setConfigValue('not.declared.anywhere', true); return { rejected: false }; }
    catch (e) { return { rejected: true, msg: String(e && e.message || e) }; }
  })()`);
  check('未声明键被拒（白名单）', bad.rejected === true && /未声明/.test(bad.msg || ''), bad.msg || '没有报错');

  // ⑤ 类型校验
  const badType = await evalJs(`(async () => {
    try { await window.controlApi.setConfigValue('${KEY}', 'not-a-boolean'); return { rejected: false }; }
    catch (e) { return { rejected: true, msg: String(e && e.message || e) }; }
  })()`);
  check('类型不匹配被拒', badType.rejected === true && /类型/.test(badType.msg || ''), badType.msg || '没有报错');

  // 收尾：值必须回到原位（哪怕前面某步失败也不要留脏值）
  const now = getPath(readConfig(), KEY);
  if (now !== before) {
    await evalJs(`(async () => { try { await window.controlApi.setConfigValue('${KEY}', ${JSON.stringify(before)}); } catch (e) {} return true; })()`);
    await waitFor(() => getPath(readConfig(), KEY) === before, 4000);
  }

  console.log('\n' + '─'.repeat(52));
  console.log(`PASS ${pass} / FAIL ${fail}`);
  // PASS=0 = 断言全被跳过，不能算通过（删行/改 DOM 后最容易出现的假绿）
  if (pass === 0) { console.error('PASS=0：没有任何断言真正执行，视为失败'); process.exit(1); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('探针异常：', e && e.stack || e);
  process.exit(1);
});
