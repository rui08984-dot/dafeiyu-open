#!/usr/bin/env node
// petctl.mjs —— 大肥鱼桌宠的统一控制台。
//
// 为什么要有它：之前每验证一件事都要临时写一个 _probe.cjs，散在 .state 里、参数靠记、
// 输出格式各不相同。这里把常用动作收成一条命令，长这样：
//
//   node tools/petctl.mjs status          看她还活着吗、模型通不通、插件在不在、记忆写了没
//   node tools/petctl.mjs say "在吗"       让她说一句（只发声+字幕，不进对话）
//   node tools/petctl.mjs chat "在吗"      真的跟她对话（走完整链路）
//   node tools/petctl.mjs shot [path]     截一张她的窗口（不受遮挡影响）
//   node tools/petctl.mjs emotion         看她现在什么表情、因为什么
//   node tools/petctl.mjs plugins         插件清单 + 工具清单 + 冲突别名
//   node tools/petctl.mjs cowatch         一起看：最近画面摘要 + 声轨对白
//   node tools/petctl.mjs probe           自检清单（端口/身体/情绪/记忆/工具）
//   node tools/petctl.mjs logs [n]        看日志尾巴
//
// 端口（写死在这里，改端口时只需要改一处）：
//   VTS 8001 · 内部渲染 8102 · HTTP 控制 8103 · 自检 8004
//   一起看 1001 · Edge TTS 9883 · SenseVoice 1000

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE = path.join(ROOT, '.state');

export const PORTS = { vts: 8001, inner: 8102, control: 8103, devtools: 8004, cowatch: 1001, tts: 9883, asr: 1000 };

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const ok = (s) => C.green + '✓' + C.reset + ' ' + s;
const bad = (s) => C.red + '✗' + C.reset + ' ' + s;
const warn = (s) => C.yellow + '!' + C.reset + ' ' + s;
const dim = (s) => C.gray + s + C.reset;

function request(method, pathname, body, port, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: encodeURI(pathname), method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({ raw: data }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

const control = (pathname, body, timeout) => request('POST', pathname, body, PORTS.control, timeout);
const controlGet = (pathname) => request('GET', pathname, null, PORTS.control);
const devGet = (pathname) => request('GET', pathname, null, PORTS.devtools);
const devEval = (js) => request('POST', '/eval', { js }, PORTS.devtools, 30000);

// ── status ────────────────────────────────────────────────────────────────
async function cmdStatus() {
  console.log(C.bold + '大肥鱼 · 状态' + C.reset);
  const bounds = await devGet('/bounds');
  if (bounds.error) {
    console.log(bad('桌宠没在运行') + dim('（自检通道 ' + PORTS.devtools + ' 连不上）'));
    console.log(dim('  启动: node tools/launch-my-neuro.mjs'));
    return 1;
  }
  const b = bounds.bounds || {};
  console.log(ok('窗口 ' + b.width + '×' + b.height + ' @(' + b.x + ',' + b.y + ')' +
    (bounds.alwaysOnTop ? dim(' · 置顶') : '') +
    (bounds.ignoreMouse ? dim(' · 穿透') : '')));

  // 身体 / 情绪 / UI
  const body = await devEval('JSON.stringify({ body: !!window.petBody, emotion: !!window.petBodyEmotion, ui: !!window.petBodyUi, drag: !!window.__dragInstalled, err: window.__bootErr || null })');
  if (body.value) {
    const v = JSON.parse(body.value);
    console.log(ok('身体' + dim('· Cubism5')) + ' ' +
      (v.emotion ? ok('情绪引擎') : bad('情绪引擎')) + ' ' +
      (v.ui ? ok('舞台适配') : bad('舞台适配')) + ' ' +
      (v.drag ? ok('整窗拖动') : bad('整窗拖动')));
    if (v.err && v.err.length) console.log(warn('boot 告警: ' + JSON.stringify(v.err)));
  }

  // 模型
  const emo = await controlGet('/emotion');
  if (emo && emo.ok) console.log(ok('当前情绪 ' + (emo.emotion || 'neutral')));

  // 心情（跨重启累积的那个）
  const mood = await devEval('JSON.stringify(global.__petMood ? { score: +global.__petMood.score.toFixed(2), desc: global.__petMood.describe() } : null)');
  if (mood.value && mood.value !== 'null') {
    const mv = JSON.parse(mood.value);
    const bar = mv.score >= 0 ? C.green : C.red;
    const filled = Math.round(Math.abs(mv.score) * 10);
    console.log(ok('心情 ' + bar + (mv.score >= 0 ? '+' : '') + mv.score + C.reset +
      ' ' + dim('[' + '#'.repeat(filled) + '.'.repeat(10 - filled) + ']') +
      ' ' + (mv.desc && mv.desc.line ? mv.desc.line : '')));
  }

  // 一起看
  const cw = await request('GET', '/health', null, PORTS.cowatch, 4000);
  if (cw.error) console.log(warn('一起看·耳朵没起（' + PORTS.cowatch + '）'));
  else console.log(ok('一起看·耳朵' + dim(' · 设备 ' + (cw.device || '?') + ' · 已收 ' + (cw.segments || 0) + ' 句')));

  // 插件
  const plugins = await devEval('JSON.stringify({ tools: window.pluginManager.getAllTools().map(t=>t.name||t.function?.name), count: window.pluginManager._plugins.size })');
  if (plugins.value) {
    const p = JSON.parse(plugins.value);
    const dup = p.tools.filter((n, i) => p.tools.indexOf(n) !== i);
    console.log(ok('插件 ' + p.count + ' 个 · 工具 ' + p.tools.length + ' 个') +
      (dup.length ? warn(' 重名: ' + dup.join(',')) : dim(' · 全部唯一')));
  }

  // 记忆
  try {
    const hf = path.join(ROOT, '..', '_incoming', 'my-neuro', 'data', '核心用户记忆.txt');
    const lines = fs.readFileSync(hf, 'utf8').split(/\r?\n/).filter((x) => x.trim() && !x.trim().startsWith('#'));
    console.log(ok('核心记忆 ' + lines.length + ' 条'));
  } catch (e) { console.log(warn('核心记忆文件读不到')); }

  return 0;
}

// ── say / chat ────────────────────────────────────────────────────────────
async function cmdSay(text) {
  if (!text) { console.log('用法: petctl say "要说的话"'); return 1; }
  const r = await control('/say', { text });
  console.log(r.ok ? ok('已让她说: ' + text) : bad(JSON.stringify(r)));
  return r.ok ? 0 : 1;
}

async function cmdChat(text) {
  if (!text) { console.log('用法: petctl chat "要说的话"'); return 1; }
  console.log(dim('…她正在想'));
  const r = await control('/chat', { text }, 120000);
  console.log(r.ok ? ok('已送达（回复走语音+字幕，不在这打印）') : bad(JSON.stringify(r)));
  return r.ok ? 0 : 1;
}

// ── shot ──────────────────────────────────────────────────────────────────
async function cmdShot(target) {
  const out = target || path.join(ROOT, '..', '_incoming', 'probe', 'petctl-' + Date.now() + '.png');
  const r = await request('GET', '/shot?out=' + out, null, PORTS.devtools, 30000);
  if (!r.ok) { console.log(bad('截图失败: ' + JSON.stringify(r))); return 1; }
  console.log(ok('截图 → ' + out));
  return 0;
}

// ── emotion ───────────────────────────────────────────────────────────────
async function cmdEmotion() {
  const r = await devEval('JSON.stringify((()=>{ const s = window.petBody && window.petBody.emotionSnapshot && window.petBody.emotionSnapshot(); return s || null; })())');
  if (!r.value) { console.log(bad('拿不到情绪快照')); return 1; }
  const snap = JSON.parse(r.value);
  const zh = { happy: '开心', sad: '难过', angry: '生气', surprise: '惊讶', shy: '害羞', smug: '得意', tease: '嘲讽', bored: '无聊', aggrieved: '委屈', guilty: '心虚', sleepy: '困', neutral: '中性' };
  console.log(C.bold + '当前情绪: ' + C.reset + (zh[snap.emotion] || snap.emotion || '?') +
    (snap.strength ? dim(' · 强度 ' + snap.strength) : '') +
    (snap.remainingMs ? dim(' · 还剩 ' + Math.round(snap.remainingMs) + 'ms') : ''));
  if (snap.lastHit) console.log(dim('  来源: ' + snap.lastHit.layer + ' 命中「' + (snap.lastHit.matched || snap.lastHit.key) + '」'));
  if (snap.cooldowns && snap.cooldowns.length) console.log(dim('  冷却: ' + snap.cooldowns.join(', ')));
  return 0;
}

// ── plugins ───────────────────────────────────────────────────────────────
async function cmdPlugins() {
  const js = [
    "JSON.stringify((()=>{",
    "  const pm = window.pluginManager;",
    "  const out = [];",
    "  for (const [id, pkg] of pm._plugins) {",
    "    let tools = [];",
    "    try { tools = (pkg.plugin.getTools ? pkg.plugin.getTools() : []).map(t => t.name || (t.function && t.function.name)).filter(Boolean); } catch (e) {}",
    "    out.push({ id, tools });",
    "  }",
    "  const aliases = pm._toolAliases ? [...pm._toolAliases.entries()].map(([a, v]) => a + \" -> \" + v.pluginId + \":\" + v.originalName) : [];",
    "  return { plugins: out, aliases };",
    "})())"
  ].join('');
  const r = await devEval(js);
  if (!r.value) { console.log(bad('拿不到插件清单')); return 1; }
  const { plugins, aliases } = JSON.parse(r.value);
  console.log(C.bold + '插件 ' + plugins.length + ' 个' + C.reset);
  for (const p of plugins) {
    console.log('  ' + p.id.padEnd(34) + C.cyan + String(p.tools.length).padStart(2) + C.reset + ' ' + dim(p.tools.join(', ').slice(0, 70)));
  }
  if (aliases.length) {
    console.log('\n' + C.bold + '重名别名' + C.reset);
    aliases.forEach((a) => console.log('  ' + a));
  }

  // 钩子活跃度：装了没生效的插件比没装更糟
  const hs = await devEval('JSON.stringify(window.pluginManager.getHookStats ? window.pluginManager.getHookStats() : null)');
  if (hs.value && hs.value !== 'null') {
    const d = JSON.parse(hs.value);
    console.log('\n' + C.bold + '钩子活跃度' + C.reset + C.dim + '（这次启动以来）' + C.reset);
    if (!d.hooks.length) console.log(dim('  （还没有对话，所有钩子都是 0 次）'));
    for (const h of d.hooks.slice(0, 12)) {
      const flag = h.errors ? C.red + ' ' + h.errors + ' 次报错' + C.reset : '';
      console.log('  ' + h.plugin.padEnd(32) + h.hook.padEnd(16) + String(h.calls).padStart(4) + ' 次  ' + dim(h.avgMs + 'ms/次') + flag);
      if (h.lastError) console.log('      ' + C.red + h.lastError.slice(0, 90) + C.reset);
    }
    if (d.silentPlugins && d.silentPlugins.length) {
      console.log('  ' + C.yellow + '!' + C.reset + ' 未触发过任何钩子: ' + dim(d.silentPlugins.join(', ')));
    }
  }
  return 0;
}

// ── cowatch ───────────────────────────────────────────────────────────────
async function cmdCowatch() {
  const h = await request('GET', '/health', null, PORTS.cowatch, 4000);
  if (h.error) { console.log(bad('一起看·耳朵没起')); return 1; }
  console.log(ok('设备: ' + h.device + (h.paused ? '（她正在说话，已暂停收录）' : '')));
  const now = await request('GET', '/now?seconds=180', null, PORTS.cowatch, 6000);
  console.log(C.bold + '最近 3 分钟声轨:' + C.reset);
  console.log(now && now.text ? '  ' + now.text : dim('  （没有识别到对白——可能没在放东西）'));
  const r = await devEval('JSON.stringify((()=>{ const o = window.watchScreenOrgan; return o && o.latestSummary ? o.latestSummary() : null; })())');
  if (r.value && r.value !== 'null') console.log(C.bold + '画面摘要:' + C.reset + ' ' + JSON.parse(r.value));
  return 0;
}

// ── probe ─────────────────────────────────────────────────────────────────
async function cmdProbe() {
  const rows = [];
  const add = (name, pass, detail) => { rows.push({ name, pass, detail }); };

  const bounds = await devGet('/bounds');
  add('窗口在线', !bounds.error, bounds.error || (bounds.bounds.width + '×' + bounds.bounds.height));
  const health = await controlGet('/health');
  add('控制口 8103', !!health.ok, JSON.stringify(health).slice(0, 50));
  const cw = await request('GET', '/health', null, PORTS.cowatch, 4000);
  add('一起看 1001', !!cw.ok, cw.device || cw.error || '');

  const st = await devEval('JSON.stringify({ body: !!window.petBody, emo: !!window.petBodyEmotion, drag: !!window.__dragInstalled })');
  if (st.value) {
    const v = JSON.parse(st.value);
    add('身体已加载', v.body);
    add('情绪引擎', v.emo);
    add('整窗拖动', v.drag);
  }

  const tools = await devEval('JSON.stringify(window.pluginManager.getAllTools().map(t=>t.name||t.function?.name))');
  if (tools.value) {
    const list = JSON.parse(tools.value);
    add('工具唯一', list.length === new Set(list).size, list.length + ' 个');
    add('一起看工具', list.includes('cowatch_now') && list.includes('cowatch_recap'));
  }

  const mem = await devEval('(async()=>{ try { return String(await window.pluginManager.executeTool("core_memory_list", {})).slice(0, 60); } catch (e) { return "ERR"; } })()');
  add('核心记忆可读', String(mem.value || '').includes('核心记忆'), String(mem.value || '').slice(0, 30));

  const base = await devEval('JSON.stringify((()=>{ const r = window.petBody.renderer; return { es: +r.getParameter("EyeSmile").toFixed(2), mf: +r.getParameter("ParamMouthForm").toFixed(2) }; })())');
  if (base.value) { const b = JSON.parse(base.value); add('表情基线归零', Math.abs(b.es) < 0.1 && Math.abs(b.mf) < 0.1, JSON.stringify(b)); }

  const pass = rows.filter((r) => r.pass).length;
  console.log(C.bold + '自检 ' + pass + '/' + rows.length + C.reset);
  for (const r of rows) console.log('  ' + (r.pass ? C.green + '✓' : C.red + '✗') + C.reset + ' ' + r.name.padEnd(16) + dim(r.detail || ''));
  return pass === rows.length ? 0 : 1;
}

// ── logs ──────────────────────────────────────────────────────────────────
function cmdLogs(n) {
  const count = Number(n) || 40;
  const file = path.join(STATE, 'my-neuro.out.log');
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    console.log(dim('（' + file + ' 最后 ' + count + ' 行）'));
    console.log(lines.slice(-count).join('\n'));
  } catch (e) { console.log(bad('读不到日志: ' + e.message)); return 1; }
  return 0;
}

// ── 入口 ──────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const arg = rest.join(' ');

const table = {
  status: () => cmdStatus(),
  say: () => cmdSay(arg),
  chat: () => cmdChat(arg),
  shot: () => cmdShot(rest[0]),
  emotion: () => cmdEmotion(),
  plugins: () => cmdPlugins(),
  cowatch: () => cmdCowatch(),
  probe: () => cmdProbe(),
  quiet: async (args) => {
    const on = String((args && args[0]) || 'on') !== 'off';
    const r = await controlPost('/quiet', { on });
    if (r && r.ok) console.log(ok('静默模式 = ' + (r.quiet ? '开（她不主动开口）' : '关（正常）')));
    else console.log(bad('设置失败：' + JSON.stringify(r).slice(0, 160)));
    return 0;
  },
  verify: async () => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [path.join(HERE, 'verify-all.mjs')], { stdio: 'inherit' });
    return r.status === 0 ? 0 : 1;
  },
  doctor: async () => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [path.join(HERE, 'doctor.mjs')], { stdio: 'inherit' });
    return r.status === 0 ? 0 : 1;
  },
  logs: () => cmdLogs(rest[0]),
};

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(C.bold + 'petctl —— 大肥鱼控制台' + C.reset);
  console.log('  status    她的整体状态（窗口/身体/情绪/插件/记忆/一起看）');
  console.log('  say       petctl say "要说的话"     只发声+字幕');
  console.log('  chat      petctl chat "要说的话"    真对话（LLM+TTS+口型+字幕）');
  console.log('  shot      petctl shot [路径]        截她的窗口');
  console.log('  emotion   现在什么表情、因为什么');
  console.log('  plugins   插件 + 工具 + 重名别名');
  console.log('  cowatch   一起看：声轨对白 + 画面摘要');
  console.log('  probe     自检清单（通过/失败）');
  console.log('  doctor    完整体检（含模型/TTS/ASR/一起看/记忆/自启），出问题先跑它');
  console.log('  verify    九项总验收（记忆/插件/换装/一起看/声音/前端/入口/演出/文档）')
  console.log('  quiet     petctl quiet on|off   省钱模式：不主动开口（测试时开）');
  console.log('  logs      petctl logs [行数]');
  process.exit(0);
}

if (!table[cmd]) { console.log(bad('不认识的命令: ' + cmd + '（试点 petctl help）')); process.exit(1); }
try {
  process.exit(await table[cmd]());
} catch (e) {
  console.error(bad('崩溃: ' + (e && e.message || e)));
  process.exit(1);
}