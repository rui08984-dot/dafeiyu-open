#!/usr/bin/env node
// verify-all.mjs —— 九项总验收：每条都给证据，不是「应该没问题」。
//
// 设计：只读为主，不产生 API 费用；桌宠没跑时能离线验的照样验，在线项标 SKIP 而不是 FAIL。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MY = path.resolve(ROOT, '..', '_incoming', 'my-neuro');
const APP = path.join(MY, 'live-2d');

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

function get(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(s) }); } catch (e) { resolve({ status: res.statusCode, raw: s }); } });
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

function post(url, body, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: timeoutMs }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(s) }); } catch (e) { resolve({ status: res.statusCode, raw: s }); } });
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.write(data); req.end();
  });
}

const petEval = async (js) => {
  const r = await post('http://127.0.0.1:8004/eval', { js });
  return r && r.json ? r.json.value : null;
};

const rows = [];
const add = (ok, id, name, evidence) => rows.push({ ok, id, name, evidence });

// ① 记忆
async function checkMemory() {
  const health = await get('http://127.0.0.1:8003/health');
  if (health.error) { add('skip', '①', '记忆 MemOS', '后端没跑（' + health.error + '）'); return; }
  const emb = (health.json && health.json.embedding) || {};
  const stats = await get('http://127.0.0.1:8003/stats');
  const total = (stats.json && stats.json.total_count) || 0;
  const search = await post('http://127.0.0.1:8003/search', { query: '显示器 大小', top_k: 2, user_id: 'feiniu_default', similarity_threshold: 0.25 });
  const hits = (search.json && (search.json.memories || search.json.results)) || [];
  const ok = emb.ready === true && emb.dimension === 1024 && total > 0 && hits.length > 0;
  add(ok ? 'pass' : 'fail', '①', '记忆 MemOS',
    '嵌入 ' + (emb.model || '?') + ' ' + (emb.dimension || '?') + ' 维 ' + Math.round(emb.avg_latency_ms || 0) + 'ms · 记忆 ' + total + ' 条 · 语义搜索命中 ' + hits.length);
}

// ② 插件
async function checkPlugins() {
  const n = await petEval('window.pluginManager ? window.pluginManager._plugins.size : 0');
  const tools = await petEval('JSON.stringify(window.pluginManager ? window.pluginManager.getAllTools().map(t=>t.name||t.function?.name) : [])');
  if (!n) { add('skip', '②', '插件与工具', '桌宠没跑'); return; }
  let list = [];
  try { list = JSON.parse(tools); } catch (e) { list = []; }
  const dup = list.filter((x, i) => list.indexOf(x) !== i);
  const need = ['execute_code', 'dispatch_to_dsh', 'record_memory'];
  const missing = need.filter((x) => !list.includes(x));
  add(dup.length === 0 && missing.length === 0 ? 'pass' : 'fail', '②', '插件与工具',
    n + ' 个插件 / ' + list.length + ' 个工具 · 重名 ' + dup.length + ' · 关键工具缺 ' + (missing.join(',') || '无'));
}

// ③ 换装
async function checkAssets() {
  const file = path.join(APP, 'js', 'avatar', 'petbody', 'assets-data.js');
  if (!fs.existsSync(file)) { add('fail', '③', '换装资产', 'assets-data.js 不存在'); return; }
  const src = fs.readFileSync(file, 'utf8');
  let data = null;
  try { data = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1)); } catch (e) { data = null; }
  const assets = data ? data.assets.length : 0;
  const presets = data ? data.presets.length : 0;
  const groups = data ? data.groups.length : 0;
  add(assets >= 20 && presets === 4 ? 'pass' : 'fail', '③', '换装资产',
    groups + ' 组 / ' + assets + ' 资产 / ' + presets + ' 预设');
}

// ④ 一起看（画面）
async function checkVision() {
  const raw = await petEval('JSON.stringify((()=>{ const e=window.pluginManager && window.pluginManager._plugins.get("community/watch-screen"); const o=e&&e.plugin&&e.plugin._organ; if(!o) return null; const s=o.stats(); return { sheets:(o.sheet||[]).length, summaries:s.summaries, last:o._lastSummaryText||"" }; })())');
  if (!raw) { add('skip', '④', '一起看·画面', '桌宠没跑'); return; }
  const d = JSON.parse(raw);
  // 静默模式会主动关掉视觉摘要（省钱闸门）。那种情况下「摘要 0 条」是正确行为，
  // 不该判失败 —— 否则每次开着静默跑验收都会红，久而久之就没人信这个灯了。
  const st = await get('http://127.0.0.1:8103/state');
  const quiet = !!(st && st.json && st.json.quiet);
  if (d.summaries > 0) {
    add('pass', '④', '一起看·画面',
      '联络表 ' + d.sheets + ' 帧 · 摘要 ' + d.summaries + ' 条 · 最新：' + String(d.last || '(空)').slice(0, 40));
  } else if (quiet) {
    add('skip', '④', '一起看·画面',
      '静默模式已主动停掉视觉摘要（省钱闸门）· 联络表仍在采：' + d.sheets + ' 帧');
  } else {
    add('fail', '④', '一起看·画面',
      '联络表 ' + d.sheets + ' 帧但摘要 0 条（非静默）→ 检查视觉模型配置与预算闸门');
  }
}

// ⑤ 一起看（声音）
async function checkAudio() {
  const h = await get('http://127.0.0.1:1001/health');
  if (h.error) { add('skip', '⑤', '一起看·声音', '耳朵没跑（' + h.error + '）'); return; }
  const seg = await get('http://127.0.0.1:1001/segments?since=0');
  const items = (seg.json && seg.json.items) || [];
  const kinds = {};
  for (const it of items) { const k = (it.tone || {}).kind; if (k) kinds[k] = (kinds[k] || 0) + 1; }
  const atmos = await petEval('String((()=>{ const e=window.pluginManager && window.pluginManager._plugins.get("community/watch-screen"); const p=e&&e.plugin; return p && typeof p._audioAtmosphere==="function" ? (p._audioAtmosphere(60)||"(无)") : "missing"; })())');
  add(items.length > 0 || atmos === '(无)' ? 'pass' : 'fail', '⑤', '一起看·声音',
    items.length + ' 段 · 分类 ' + JSON.stringify(kinds) + ' · 气氛「' + String(atmos || '').slice(0, 22) + '」');
}

// ⑥ 前端
function checkFrontend() {
  // 2026-11-10：v1 面板已删除，检查 v2（默认且唯一）
  const file = path.join(APP, 'control-v2.html');
  const src = fs.readFileSync(file, 'utf8');
  const brand = /大肥鱼 · 控制中心/.test(src);
  const markers = ['control-v2-renderer.js', 'ov-feed', 'quiet-switch', 'petbody-cowatch'].filter((x) => src.includes(x));
  const removed = !src.includes('data-page="cloud"') && !src.includes('data-page="tools"');
  add(brand && markers.length === 4 && removed ? 'pass' : 'fail', '⑥', '前端面板 v2',
    (brand ? '品牌已改' : '品牌未改') + ' · 关键标记 ' + markers.length + '/4 · 冗余页已删 ' + (removed ? '是' : '否'));
}

// ⑦ 启动入口
function checkLauncher() {
  const rootDir = path.resolve(ROOT, '..');
  const cmds = fs.readdirSync(rootDir).filter((f) => /\.(cmd|bat)$/i.test(f));
  const single = cmds.length === 1 && cmds[0] === '大肥鱼.cmd';
  add(single ? 'pass' : 'fail', '⑦', '启动入口', '根目录脚本 ' + cmds.length + ' 个' + (single ? '（只有 大肥鱼.cmd）' : '：' + cmds.join(',')));
}

// ⑧ 演出与内在状态
async function checkStage() {
  const scenes = await petEval('JSON.stringify(window.petBody && window.petBody.listScenes ? window.petBody.listScenes() : [])');
  if (!scenes) { add('skip', '⑧', '演出与内在状态', '桌宠没跑'); return; }
  let n = 0;
  try { n = JSON.parse(scenes).length; } catch (e) { n = 0; }
  const inner = await petEval('String((()=>{ const e=window.pluginManager && window.pluginManager._plugins.get("community/inner-state"); return e ? "ok" : "missing"; })())');
  add(n > 0 && inner === 'ok' ? 'pass' : 'fail', '⑧', '演出与内在状态', n + ' 段演出 · inner-state ' + inner);
}

// ⑨ 文档
function checkDocs() {
  const docs = path.resolve(ROOT, '..', 'docs');
  const need = ['交接-大肥鱼桌宠-2026-10-31-1240.md', '评估-现状达标-2026-10-31.md'];
  const have = need.filter((f) => fs.existsSync(path.join(docs, f)));
  const manual = fs.existsSync(path.resolve(ROOT, '..', '使用手册.md'));
  add(have.length === need.length && manual ? 'pass' : 'fail', '⑨', '文档收口',
    '交接/评估 ' + have.length + '/' + need.length + ' · 使用手册 ' + (manual ? '在' : '缺'));
}

console.log(C.bold + '大肥鱼 · 九项总验收' + C.reset + C.dim + '（只读为主，不产生 API 费用）' + C.reset);
console.log('');
await checkMemory();
await checkPlugins();
await checkAssets();
await checkVision();
await checkAudio();
checkFrontend();
checkLauncher();
await checkStage();
checkDocs();

const mark = { pass: C.green + '✓' + C.reset, fail: C.red + '✗' + C.reset, skip: C.yellow + '—' + C.reset };
let pass = 0, fail = 0, skip = 0;
for (const r of rows) {
  if (r.ok === 'pass') pass++; else if (r.ok === 'fail') fail++; else skip++;
  console.log('  ' + mark[r.ok] + ' ' + r.id + ' ' + r.name.padEnd(14) + C.dim + r.evidence + C.reset);
}

console.log('');
console.log(C.bold + '汇总' + C.reset + '：通过 ' + pass + ' · 失败 ' + fail + ' · 跳过 ' + skip);
if (skip) console.log(C.dim + '跳过项需要桌宠在运行（大肥鱼 start）' + C.reset);
process.exit(fail ? 1 : 0);
