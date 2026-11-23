#!/usr/bin/env node
// doctor.mjs —— 出问题时按下这一个键，告诉你哪坏了、怎么修。
//
// 为什么单独做一个：桌面宠物有 6~7 个进程（Electron 宿主、TTS、ASR、一起看、VTS、控制口），
// 任何一个没起来，表现都很像——「她不说话了」。光看某一条日志找不到原因。
// 这里把「她能不能说话」拆成几个环节逐个验，坏在哪一环一目了然。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MY = path.resolve(ROOT, '..', '_incoming', 'my-neuro');
const APP = path.join(MY, 'live-2d');
const RECORDS = path.join(MY, 'data');

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

// E1（2026-11-21）：--json 输出机器可读体检（门禁/控制中心/外部程序可消费）。
// 人读输出改到 stderr —— stdout 只留一份 JSON，否则「管道解析」会被彩色行污染。
const jsonMode = process.argv.includes('--json');
if (jsonMode) {
  console.log = (...a) => console.error(...a);
}

function get(url, timeoutMs = 4000) {
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

function post(url, body, timeoutMs = 6000) {
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

function tcp(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (ok) => { try { s.destroy(); } catch (e) {} resolve(ok); };
    s.setTimeout(1500);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    s.connect(port, '127.0.0.1');
  });
}

function evalJs(js, port = 8004) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ js });
    const req = http.request({ host: '127.0.0.1', port, path: '/eval', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve(JSON.parse(s).value); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(data); req.end();
  });
}

const rows = [];
// 2026-11-13 防呆护栏：判绿但 detail 里出现 undefined / NaN，多半是「字段没读到
// 却当成功」（本轮就抓到 `0×0 @undefined,undefined` 判绿、`hours` 缺失也判绿）。
// 这类不该靠人肉复查，直接在 add 这一层降级成「警告」，并说明原因。
const add = (ok, name, detail, fix) => {
  let state = ok;
  let text = detail;
  if (state === true) {
    const d = String(detail == null ? '' : detail);
    if (/\b(undefined|NaN)\b/.test(d)) {
      state = 'warn';
      text = d + '  ⚠ detail 里有 undefined/NaN —— 判据可能读错了字段，先当未验证';
    }
  }
  rows.push({ ok: state, name, detail: text, fix });
};

async function checkHost() {
  const b = await get('http://127.0.0.1:8004/bounds');
  if (b.error) { add(false, '桌面窗口', '自检通道 8004 连不上（' + b.error + '）', 'node tools/launch-my-neuro.mjs'); return false; }
  add(true, '桌面窗口', b.json.bounds.width + '×' + b.json.bounds.height + ' @' + b.json.bounds.x + ',' + b.json.bounds.y);
  return true;
}

async function checkSubtitleWindow() {
  // P0-1：字幕独立窗（透明副窗，位置由 pet-core subtitle 公式决定，贴皮套下方/上方）
  const b = await get('http://127.0.0.1:8005/bounds');
  if (b.error) { add(false, '字幕独立窗', '自检通道 8005 连不上（' + b.error + '）', '重启桌宠加载新 main.js：大肥鱼 restart'); return; }
  const sub = (b.json && b.json.bounds) || {};
  // 8005 通了但 bounds 空（窗口还没创建/已销毁）时，下面的 overlap 恒 false →
  // 会打出「0×0 @undefined,undefined」并判绿。这是假绿，必须显式拦掉。
  if (!(Number(sub.width) > 0) || !(Number(sub.height) > 0)) {
    add(false, '字幕独立窗', '8005 通了但读不到窗口尺寸（bounds 空）', '字幕窗可能没创建；看 main.js 的 subtitle 窗口创建日志');
    return;
  }
  const pet = await get('http://127.0.0.1:8004/bounds');
  const pb = (pet.json && pet.json.bounds) || null;
  let rel = '';
  let overlap = false;
  if (pb && sub.width) {
    const below = sub.y >= pb.y + pb.height - 1;
    const above = sub.y + sub.height <= pb.y + 1;
    // 侧位（贴她左右）：上下都放不下时的设计内行为——窄版字幕条（320×88）紧贴她旁边，
    // 不是"重叠"。判定：水平方向与皮套完全错开即为合法侧位。
    const sideLeft = sub.x + sub.width <= pb.x - 1;
    const sideRight = sub.x >= pb.x + pb.width - 1;
    const isSide = sideLeft || sideRight;
    overlap = !below && !above && !isSide;
    const desired = pb.x + Math.trunc((pb.width - sub.width) / 2);
    const cxDelta = Math.round(Math.abs(sub.x - desired));
    // 贴屏幕边缘时居中会被钳制，那是正确行为，不该报成"偏差"。
    // 只有当「没贴边、却明显没居中」才算异常。
    const screenW = 2560;                       // 单屏口径；多屏时以皮套所在屏为准
    const clampedByEdge = desired < 0 || desired + sub.width > screenW;
    const drift = (!isSide && !clampedByEdge && cxDelta > 8) ? cxDelta : 0;
    rel = ' · ' + (below ? '皮套下方' : above ? '皮套上方'
        : isSide ? ('侧位窄版（贴她' + (sideLeft ? '左' : '右') + '边，设计内行为）')
        : '与皮套重叠')
        + (clampedByEdge ? '，贴屏幕边已钳制（正常）' : drift ? '，居中偏差 ' + drift + 'px' : (isSide ? '' : '，已居中'));
  }
  add(!overlap, '字幕独立窗', sub.width + '×' + sub.height + ' @' + sub.x + ',' + sub.y + rel,
      overlap ? '字幕窗压在皮套上：检查 pet-core subtitle 算法与显示器工作区' : '');
}

async function checkQuietMode() {
  // 静默版（成本控制）：诊断必须显示真实闸门状态，不许「显示与实际不一致」
  const s = await get('http://127.0.0.1:8103/state');
  if (s.error || !s.json) { add(false, '静默模式', '8103 /state 查不到（' + (s.error || '空响应') + '）', '确认桌宠已启动'); return; }
  if (s.json.quiet === undefined) { add(false, '静默模式', '运行中的宿主是旧版（/state 没有 quiet 字段）', '重启桌宠：大肥鱼 restart'); return; }
  const on = s.json.quiet === true;
  // 2026-11-13：原来是 add(on, …) —— 用户主动关掉静默就判红。可关静默是**用户的设置**，
  // 不是故障；门禁红灯只留给真故障，否则红灯贬值（和直播对接同一个道理）。
  // 仍然是「显示真实状态」：关着就把「会花 API」写在 detail 里，只是不判红。
  add(true, '静默模式', on ? '开（不主动开口；视觉摘要停）' : '关（主动聊天/晨昏问候/视觉摘要都会花 API）',
    on ? '' : '想省钱就开：大肥鱼 quiet');
}

async function checkModel() {
  let prov, cfg;
  try { prov = JSON.parse(fs.readFileSync(path.join(APP, 'llm_providers.json'), 'utf8')); }
  catch (e) { add(false, '模型配置', '读不到 llm_providers.json', '检查文件是否存在'); return; }
  try { cfg = JSON.parse(fs.readFileSync(path.join(APP, 'config.json'), 'utf8')); } catch (e) { cfg = {}; }
  const list = (prov.providers || []).filter((p) => p.enabled);
  if (!list.length) { add(false, '模型配置', '没有启用的 provider', '在控制中心「模型配置」里启用一个'); return; }
  for (const p of list) {
    // 2026-11-16 P0 教训：能力开关保存曾把 provider 的 api_url/key 覆盖成空串，
    // 症状是对话全挂 `Failed to fetch`。端点为空必须单独点名（不要只查 key）。
    const base0 = String(p.api_url || '').trim();
    if (!base0) { add(false, '模型端点', p.id + ' 没有 api_url（对话会 Failed to fetch）', '在控制中心「模型」页填写接口地址，或从备份恢复 llm_providers.json'); continue; }
    if (!p.api_key || String(p.api_key).startsWith('__INJECTED')) { add(false, '模型密钥', p.id + ' 的 key 没注入', 'node tools/sync-credentials.mjs'); continue; }
    const base = String(p.api_url || '').replace(/\/+$/, '');
    let okPort = true;
    if (/^http:/.test(base)) { try { okPort = await tcp(Number(new URL(base).port || 80)); } catch (e) { okPort = false; } }
    if (!okPort) { add(false, '模型端点', p.id + ' 本地端口连不上（' + base + '）', '启动本地网关，或改用云端 provider'); continue; }
    const model = (cfg.llm && cfg.llm.model_id) || (p.models[0] && p.models[0].model_id) || '?';
    add(true, '模型端点', p.id + ' · ' + model);
  }
}

async function checkVoice() {
  const tts = await tcp(9883);
  add(tts, '语音合成 TTS', tts ? '9883 在线' : '9883 连不上', 'launcher 会自动拉起；或 py ../edge-tts/tts_server.py --port 9883');
  const h = await get('http://127.0.0.1:1000/health');
  if (h.error) { add(false, '语音识别 ASR', '1000 连不上', 'launcher 会自动拉起；或 py ../asr/asr_server.py --port 1000'); }
  else {
    const j = h.json || {};
    // 原来是 `j.loaded !== false` —— undefined 也算绿（读不到状态就等于好着）。
    // health 实际明确返回 loaded:true/false，改成三态（2026-11-13）。
    if (j.loaded === true) add(true, '语音识别 ASR', '引擎 ' + (j.engine || '?') + ' 已加载');
    else if (j.loaded === false) add(false, '语音识别 ASR', '引擎 ' + (j.engine || '?') + ' 未加载（模型可能缺失）', '看 asr 日志');
    else add('skip', '语音识别 ASR', '端口通但读不到 loaded 字段（未验证）', '确认 asr_server.py 为新版');
  }
}

// 语气链路：她说话的语气应该跟着情绪变（edge-tts 的 rate/pitch/volume 三个旋钮）
async function checkProsody() {
  const r = await post('http://127.0.0.1:9883/prosody', { emotion: 'neutral', strength: 1 });
  if (r && r.error) { add(false, '语气链路', '/prosody 连不上', 'TTS 服务版本旧，重启一次'); return; }
  const j = (r && r.json) || {};
  add(j.ok === true, '语气链路', '情绪→语速/音调/音量 已接通', j.ok ? '' : 'TTS 服务不支持 /prosody');
}

// 情绪识别：SenseVoice 自带 SER/AED（同一个模型，不需要额外模型）
// 假绿修复（2026-11-09）：端口通 ≠ 引擎加载完。真判据=health.info 里模型已加载。
async function checkSer() {
  const h = await get('http://127.0.0.1:1000/health');
  if (h.error) { add(false, '情绪识别 SER', 'ASR 连不上', 'launcher 会自动拉起'); return; }
  const info = (h.json && h.json.info) || {};
  const top = h.json || {};
  // 2026-11-13：原来只看 health.info.* —— 可 asr_server 实际返回的是**顶层**
  // `loaded: true` / `engine: "sensevoice+silero"`（info 字段根本不存在），
  // 于是这一项长期「未验证」。现在两处都看。
  const engineStr = JSON.stringify(info) + '|' + String(top.engine || '');
  const loaded = info.engine_loaded === true || info.loaded === true || top.loaded === true || /sensevoice/i.test(engineStr);
  if (loaded) add(true, '情绪识别 SER', (top.engine || 'SenseVoice') + ' 自带（9 种情绪 + 10 类事件）');
  else if (info.status === 'loading' || info.loading === true) add('skip', '情绪识别 SER', '端口通但引擎还在加载（未验证）', '等 30 秒重跑 doctor');
  else add('skip', '情绪识别 SER', '端口通但读不到引擎加载状态（未验证）', '确认 asr_server.py 为新版后重跑');
}

// 情绪弧线：audio-loop /arc（逐句 tone 的本地聚合，零 API）
async function checkAudioArc() {
  const a = await get('http://127.0.0.1:1001/arc');
  if (a.error) { add(false, '情绪弧线', '1001 /arc 连不上（' + a.error + '）', '重启桌宠加载新 audio_loop'); return; }
  const j = a.json || {};
  if (j.ok !== true) { add(false, '情绪弧线', '返回异常', '重启桌宠'); return; }
  const d = String(j.digest || '');
  add(true, '情绪弧线', d ? d.slice(0, 44) : '在线（暂无声音素材）');
}

// 语音播放：TTS 服务在线 ≠ 她真的会说话。
// 之前踩过：服务正常、字幕正常，但渲染层的处理/播放线程死了 → 只有字幕没声音。
// 假绿修复（2026-11-09）：「看门狗在线」只是存在性；真判据=播放引擎的 lastPlayStartedAt。
// 开机后还没说过话 → 跳过态（不算绿也不算红），要求真实播放后才有行为证据。
async function checkTtsPlayback() {
  // ⚠ 2026-11-09 三十五轮：playbackEngine 现在有三个字段，含义不同：
  //   lastPlayStartedAt —— **真的开始出声**（onplay 里设），这个才是「她出过声」的证据
  //   lastPlayAttemptAt —— 尝试播放（可能被自动播放策略拦住 / 音频解码失败）
  //   lastPlayError     —— 上次失败的原因（audio-error / play-rejected）
  // 判据顺序：startedAt>0 绿；没有但 attemptAt>0 = 试过没出声（红，带原因）；
  //           连 attemptAt 都没有 = 开机以来没试过（skip）。
  const alive = await evalJs(`String((()=>{
    const tp = window.voiceChat && window.voiceChat.ttsProcessor;
    if (!tp) return "no-tp";
    if (!tp._watchdogTimer) return "no-threads";
    const pe = tp.playbackEngine;
    if (!pe) return "no-pe";
    const started = typeof pe.lastPlayStartedAt === "number" ? pe.lastPlayStartedAt : 0;
    const attempt = typeof pe.lastPlayAttemptAt === "number" ? pe.lastPlayAttemptAt : 0;
    const err = pe.lastPlayError || "";
    return "S:" + started + "|A:" + attempt + "|E:" + err;
  })())`);
  if (alive && alive.startsWith('S:')) {
    const parts = {};
    for (const kv of alive.split('|')) {
      const i = kv.indexOf(':');
      if (i > 0) parts[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const started = Number(parts.S) || 0;
    const attempt = Number(parts.A) || 0;
    const err = String(parts.E || '');
    if (started > 0) {
      // ⚠ 2026-11-09 修：原来「超过 1 小时没出声」报红 —— **这是误报**。
      //   用户玩游戏/出门几个小时没跟她说话，TTS 链路本身是好的。
      //   这个检查的目的是「链路能不能出声」，不是「她最近有没有说话」。
      //   所以：只要出过声就是绿；很久没说话只在 detail 里注明，不报红。
      //   真正的故障信号是 lastPlayError（见下面的分支）。
      const agoMin = Math.round((Date.now() - started) / 60000);
      const ago = agoMin <= 0 ? '刚刚' : (agoMin < 60 ? agoMin + ' 分钟前' : Math.round(agoMin / 60) + ' 小时前');
      add(true, '语音播放', '线程在跑 · 最近一次真实出声 ' + ago + '（链路已验证过）');
      return;
    }
    if (attempt > 0) {
      // 试过但没出声 —— 真红灯，且带原因（这是本轮修出来的新信息）
      const agoMin = Math.round((Date.now() - attempt) / 60000);
      add(false, '语音播放',
        '试过播放但**没出声**（' + (err || '原因未记录') + '）· ' + (agoMin <= 0 ? '刚刚' : agoMin + ' 分钟前'),
        'play-rejected 多半是自动播放策略（点一下皮套再试）；audio-error 是音频数据坏了（查 tts-server 日志）');
      return;
    }
    add('skip', '语音播放', '线程在跑，但开机以来从未尝试播放（未验证）', '按 V 说句话再跑 doctor 验证');
    return;
  }
  if (alive === 'no-threads') add(false, '语音播放', '线程没起来（会只有字幕没声音）', '重启桌宠；已加自动重启，仍失败请反馈');
  else if (alive === 'no-pe') add(false, '语音播放', 'TTS 处理器没有 playbackEngine', '检查 voiceChat 初始化');
  else add(false, '语音播放', '渲染层没有 TTS 处理器', '检查 voiceChat 初始化');
}

// 眼神跟随：光标 → 主进程 IPC → 皮套眼球参数。
// 验的是「链路通不通」，不是「准不准」——这台机器的光标会被别的进程抢，逐点校验不可靠。
async function checkGaze() {
  const ok = await evalJs('String((()=>{ const b=window.petBody; if(!b||typeof b.setGaze!=="function") return "no-gaze"; const g=b.gazeInfo&&b.gazeInfo(); return g ? "ok" : "no-info"; })())');
  if (ok === 'ok') {
    const eye = await evalJs('String((()=>{ try { const b=window.petBody; b.setGaze(1,0,800); return "armed"; } catch(e){ return "err"; } })())');
    add(eye === 'armed', '眼神跟随', '链路已通（光标→眼球参数）', eye === 'armed' ? '' : 'setGaze 调用失败');
  } else if (ok === 'no-gaze') {
    add(false, '眼神跟随', '皮套没有 setGaze（版本旧）', '重新构建 petbody bundle');
  } else {
    add(false, '眼神跟随', '读不到 gazeInfo', '重新构建 petbody bundle');
  }
}

// 情绪记忆：她记不记得"因为什么而难受/开心"，并且跨重启还在
async function checkEmoMemory() {
  const info = await evalJs('String((()=>{ const m=window.__petMood; if(!m||typeof m.residue!=="function") return "no-mem"; const d=m.describe(); return JSON.stringify({wounds:(m.wounds||[]).length, residue:+m.residue().toFixed(2), line:d.line}); })())');
  if (info === 'no-mem') { add(false, '情绪记忆', '皮套没有情绪记忆模块', '重新构建 petbody bundle'); return; }
  try {
    const j = JSON.parse(info);
    add(true, '情绪记忆', j.wounds + ' 条记忆 · 余味 ' + j.residue + ' · ' + String(j.line).slice(0, 18));
  } catch (e) { add(false, '情绪记忆', '状态读不出', ''); }
}

// 人设漂移（ICASSP 2026 三维一致性框架的硬事实维度）：
// 18 个插件同时改写她的行为，必须有个数字回答「她是否还像她」。
async function checkPersonaGuard() {
  const raw = await evalJs('String((()=>{ const e=window.pluginManager && window.pluginManager._plugins.get("community/persona-guard"); if(!e||!e.plugin) return "no-plugin"; const s=e.plugin.stats(24); return JSON.stringify(s); })())');
  if (raw === 'no-plugin') { add(false, '人设漂移', 'persona-guard 插件未加载', '重启桌宠；若仍无，看 runtime.log 是否有语法错误'); return; }
  try {
    const s = JSON.parse(raw);
    const top = Object.entries(s.by_rule || {}).sort((a,b)=>b[1]-a[1]).slice(0,2).map(([k,v])=>k+'×'+v).join(' ');
    // 判红口径升级（2026-11-10 三十九轮）：**只有 mid 及以上严重度**才算异常。
    //   low 级（too-long / over-polite）是「语气统计」不是「不像她」——实测她正常读屏
    //   回答 161/238 字都被记漂移，红灯常亮就没人信了。轻危只在文字里报个数。
    const recentRaw = await evalJs('String((()=>{ const e=window.pluginManager&&window.pluginManager._plugins.get("community/persona-guard"); if(!e||!e.plugin) return "{}"; return JSON.stringify(e.plugin.stats(1)); })())');
    let recentSev = {};
    try { recentSev = JSON.parse(recentRaw).by_severity || {}; } catch (e) { recentSev = {}; }
    const seriousRecent = (recentSev.critical || 0) + (recentSev.parasocial || 0) + (recentSev.high || 0) + (recentSev.mid || 0);
    const serious24 = ((s.by_severity || {}).critical || 0) + ((s.by_severity || {}).parasocial || 0)
      + ((s.by_severity || {}).high || 0) + ((s.by_severity || {}).mid || 0);
    const soft = s.total - serious24;
    const base = s.total === 0
      ? '24h 内 0 次（她一直像她）'
      : '24h 内 ' + s.total + ' 次' + (top ? ' · ' + top : '') + ' · 连续 ' + s.consecutive
        + (soft > 0 ? ' · 其中轻危 ' + soft + ' 次（only-tone，不计红）' : '');
    add(seriousRecent === 0, '人设漂移', base,
      seriousRecent ? '近 1 小时有中/高危漂移，看 data/人设漂移.json' : '');
  } catch (e) { add(false, '人设漂移', '读不到统计', ''); }
}

// 打断延迟：从"按 V 要求打断"到"真的没在播"的耗时。
// 基线 310ms（2026-11-01 实测）；超过 800ms 说明 interrupt 链路有阻塞。
async function checkInterruptLatency() {
  const raw = await evalJs('String((()=>{ const a=globalThis.__petInterruptLatency||[]; if(!a.length) return JSON.stringify({n:0}); const ms=a.map(x=>x.ms).sort((p,q)=>p-q); const med=ms[Math.floor(ms.length/2)]; const last=a[a.length-1].ms; return JSON.stringify({n:a.length, median:med, last, max:ms[ms.length-1]}); })())');
  try {
    const s = JSON.parse(raw);
    if (!s.n) { add('skip', '打断延迟', '尚无打断记录（基线 310ms，无法验证真实延迟）', '真实打断一次后重跑'); return; }
    const bad = s.median > 800;
    add(!bad, '打断延迟', '中位 ' + s.median + 'ms · 最近 ' + s.last + 'ms · 共 ' + s.n + ' 次（基线 310ms）',
        bad ? 'interrupt 链路有阻塞：检查 playbackEngine.stop 与队列清理' : '');
  } catch (e) { add(false, '打断延迟', '读不到打点', ''); }
}

// 陪伴时长（避免过度依赖方向的落地）：只统计有交互的分钟，不做说教
async function checkCompanionHealth() {
  const raw = await evalJs('String((()=>{ const e=window.pluginManager && window.pluginManager._plugins.get("community/companion-health"); if(!e||!e.plugin) return "no-plugin"; return JSON.stringify(e.plugin.stats()); })())');
  if (raw === 'no-plugin') { add(false, '陪伴时长', 'companion-health 插件未加载', '重启桌宠'); return; }
  try {
    const s = JSON.parse(raw);
    // 2026-11-13：原来无条件 add(true) —— hours 缺失（undefined）也绿，和「活着感」
    // 曾经那个「永远 add(true)」是同一个毛病。现在缺数字就判未验证。
    const hrs = Number(s && s.hours);
    if (!Number.isFinite(hrs)) {
      add('skip', '陪伴时长', '统计里读不到 hours（未验证）', '看 companion-health 插件的 stats() 返回结构');
      return;
    }
    add(true, '陪伴时长', '今天 ' + hrs + ' 小时（阈值 ' + Math.round(s.threshold_min / 60 * 10) / 10 + 'h）'
      + (s.over ? ' · 已提醒' : ' · 未到阈值'));
  } catch (e) { add(false, '陪伴时长', '读不到统计', ''); }
}

async function checkCoWatch() {
  const h = await get('http://127.0.0.1:1001/health');
  if (h.error) { add(false, '一起看·耳朵', '1001 连不上', 'py ../audio-loop/audio_loop_server.py --port 1001'); return; }
  const j = h.json || {};
  add(!!j.recording, '一起看·耳朵', (j.device || '?') + ' · 已收 ' + (j.segments || 0) + ' 句', j.recording ? '' : '没有回环设备：检查默认播放设备');
}

// 活着感状态机（数值生理层）：饱食/精力/亲密度可读 = 数值链路活着的证据
async function checkAliveState() {
  const raw = await evalJs('String((()=>{ const e=window.pluginManager && window.pluginManager._plugins.get("community/alive-state"); if(!e||!e.plugin) return "no-plugin"; return JSON.stringify(e.plugin.stats ? e.plugin.stats() : {enabled:"?"}); })())');
  if (raw === 'no-plugin') { add(false, '活着感', 'alive-state 插件未加载', 'enabled_plugins.json 注册后重启宿主'); return; }
  let st = {};
  try { st = JSON.parse(raw); } catch (e) { st = {}; }
  if (st.enabled === false) { add('skip', '活着感', '插件在但未启用（未验证）'); return; }
  // ⚠ 2026-11-10 回归审计：这里原来**永远 add(true)** —— 实测饱食 0%/精力 0% 也判绿，
  //   而 energy 在修复前没有任何 +energy 路径（永远回不来），等于「数值已死」却没人发现。
  //   现在：双 0 判异常（黄），单项 <5 给提示但保持绿（可能刚喂过/刚醒）。
  const sat = Number(st.satiety);
  const eng = Number(st.energy);
  const bothZero = Number.isFinite(sat) && Number.isFinite(eng) && sat < 5 && eng < 5;
  add(bothZero ? 'warn' : true, '活着感',
    '饱食 ' + (st.satiety ?? '?') + '% · 精力 ' + (st.energy ?? '?') + '% · 亲密 ' + (st.intimacy ?? '?')
      + (bothZero ? ' ⚠ 双 0：状态模型可能卡死（精力现在有夜间回血路径，若仍为 0 说明没结算）' : ''),
    bothZero ? '喂一次 + 等一次夜间结算；若仍双 0，看 data/活着感.json 的 updatedAt 是否在推进' : '');
}

// 直播对接（live-dock + 弹幕服务 8030）：插件在不在 + 弹幕服务通不通。
// 8030 是手动起的（mock/blivedm），宿主重启不带动它——离线要单独提示。
async function checkLiveDock() {
  const raw = await evalJs('String((()=>{ const e=window.pluginManager && window.pluginManager._plugins.get("community/live-dock"); if(!e||!e.plugin) return "no-plugin"; return JSON.stringify(e.plugin.stats ? e.plugin.stats() : { enabled: "?" }); })())');
  if (raw === 'no-plugin') { add(false, '直播对接', 'live-dock 插件未加载', '检查 plugins/enabled_plugins.json 后重启宿主'); return; }
  let st = {};
  try { st = JSON.parse(raw); } catch (e) { st = {}; }
  if (st.enabled === false || st.enabled === 'false') {
    add(true, '直播对接', '插件在但未启用（没开播是常态）', '开播：插件配置启用 + 手动起弹幕服务 8030');
    return;
  }
  // source=off/mock 且服务离线 = 没开播的常态，不是异常（2026-11-08：mock 默认关闭后判据要跟着改）
  const notBroadcasting = !st.source || st.source === 'off' || st.source === 'mock';
  if (st.serverUp || notBroadcasting) {
    add(true, '直播对接',
      (st.source || 'off') + ' · 缓冲 ' + (st.buffered ?? 0) + ' 条' + (st.serverUp ? ' · 弹幕服务在线' : ' · 未开播（正常）'));
    return;
  }
  // 2026-11-13：原来只要 source 不是 off/mock 且服务离线就判红 → 配了 blivedm 源但
  // 没开播（绝大多数时间）天天红，狼来了。改成两级：
  //   · 本次会话收过弹幕（lastSeq>0）或有积压 → 服务掉了，真异常
  //   · 否则是「配置好但没开播」的常态 → 未验证，把起服务的方法写清楚
  // 判定「是不是真的在播」：只收到 1 条 = 当初连上测试过一次，不算开播。
  // 实测 2026-11-13：lastSeq=1 / buffered=0 / 服务离线，这是「配了 blivedm 但没开播」。
  const gotBefore = Number(st.lastSeq) > 1;
  const pending = Number(st.buffered) > 0;
  if (gotBefore || pending) {
    add(false, '直播对接', st.source + ' · 缓冲 ' + (st.buffered ?? 0) + ' 条 · 弹幕服务离线' + (gotBefore ? '（本次已收到 seq ' + st.lastSeq + '，中途掉了）' : ''),
      '重启弹幕服务：py live-danmaku/danmaku_server.py（8030）');
    return;
  }
  add('skip', '直播对接', st.source + ' 已配置但没在播（seq ' + (st.lastSeq || 0) + ' / 缓冲 ' + (st.buffered ?? 0) + '，弹幕服务未起）',
    '要收弹幕时手动起：py live-danmaku/danmaku_server.py（8030）');
}

// 说话协调器（三发起者统一闸门）：global.speechCoordinator 由 plugin-context 挂载
async function checkCoordinator() {
  const raw = await evalJs('String((()=>{ const c = global.speechCoordinator; if (!c || typeof c.stats !== "function") return "no-handle"; return JSON.stringify(c.stats()); })())');
  if (raw === 'no-handle') { add(false, '说话协调器', 'global.speechCoordinator 不存在', 'plugin-context.js 版本旧或未加载，重启宿主'); return; }
  let s = {};
  try { s = JSON.parse(raw); } catch (e) { s = {}; }
  const per = s.perPlugin || {};
  const names = Object.keys(per);
  const total = names.reduce((acc, k) => acc + (per[k].allowed || 0) + (per[k].denied || 0), 0);
  if (!names.length || total === 0) {
    // 假绿修复（2026-11-09）：「没数据」不是「正常」，单列未验证态
    add('skip', '说话协调器', '已挂载，尚无仲裁记录（没抢过话，无法验证仲裁行为）', '等真实抢话场景出现后再看本项');
    return;
  }
  const lines = names.map((k) => k + ' ' + (per[k].allowed || 0) + '✓/' + (per[k].denied || 0) + '✗').join('，');
  add(true, '说话协调器', '最近发言: ' + (s.lastSpokenBy || '—') + ' · ' + lines);
}

// 主动开口链路（2026-11-22 P0）：用户报告「从开项目到现在从没主动搭过话」，
// 根因是 cost.quiet 缺省=开 + 判据写成 `!== false` —— 装上就是哑巴。
// 本项把三件事一起摊开：①盘上静默值 ②auto-chat 每次 tick 的去向 ③近 24h 真说出口数。
// 「静默开着」是用户设置，判未验证而不是判红（红灯只留给真故障）。
async function checkProactiveChain() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(APP, 'config.json'), 'utf8')); } catch (e) { cfg = {}; }
  const quietOn = !!(cfg.cost && cfg.cost.quiet === true);
  const raw = await evalJs('String((()=>{ const m=global.autoChatModule; if(!m||typeof m.stats!=="function") return "no-handle"; return JSON.stringify(m.stats()); })())');
  let st = null;
  try { st = raw && raw !== 'no-handle' ? JSON.parse(raw) : null; } catch (e) { st = null; }
  let spoke24 = 0;
  let attempts24 = 0;
  try {
    const log = JSON.parse(fs.readFileSync(path.join(RECORDS, '主动日志.json'), 'utf8'));
    const since = Date.now() - 24 * 3600 * 1000;
    for (const a of (log.attempts || [])) {
      if (!(a.at >= since)) continue;
      attempts24 += 1;
      if (a.spoke === true) spoke24 += 1;
    }
  } catch (e) { /* 没有日志 = 0，不判红 */ }
  const parts = [quietOn ? '静默=开' : '静默=关'];
  if (st) {
    const denied = Object.values(st.denied || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    parts.push('tick ' + st.ticks + '（忙跳过 ' + st.skippedActive + ' / 离开 ' + st.skippedAway
      + ' / 静默 ' + st.skippedQuiet + ' / 自己占着 ' + st.skippedBusy + '）');
    parts.push('让路 ' + denied);
    parts.push('这次启动后说出口 ' + st.spoke);
  }
  parts.push('近24h 申请 ' + attempts24 + ' / 说出口 ' + spoke24);
  if (quietOn) {
    add('skip', '主动开口', parts.join(' · ') + ' —— 静默开着，主动通道全部关闭',
      '想让她会主动开口：托盘/总览页关掉「静默模式」（大肥鱼 quiet off）');
    return;
  }
  if (!st) {
    add('skip', '主动开口', parts.join(' · ') + ' —— 读不到 autoChatModule.stats（旧版或未加载）', '重启宿主加载新版');
    return;
  }
  if (st.errors > 0) {
    add('warn', '主动开口', parts.join(' · ') + ' —— 生成失败 ' + st.errors + ' 次', '看 runtime.log 的 [auto-chat] 行');
    return;
  }
  if (st.ticks === 0) {
    add('skip', '主动开口', parts.join(' · ') + ' —— 刚启动还没到第一个 tick（间隔 ' + st.intervalSec + ' 秒）', '');
    return;
  }
  const ageMin = st.lastSpokeAt ? Math.round((Date.now() - st.lastSpokeAt) / 60000) : null;
  const everSpoke = spoke24 > 0 || st.spoke > 0;
  add(everSpoke ? true : 'warn', '主动开口', parts.join(' · ')
    + (ageMin !== null ? ' · 上次开口 ' + ageMin + ' 分钟前' : ' · 还没开过口'),
    everSpoke ? '' : '24h 内一次都没开口：若你一直在用键鼠，她在等 30 秒以上的空闲窗口（看「忙跳过」计数确认不是链路坏了）');
}

// 对话现场（ADR-013，2026-11-22）：只读观测「现在这场对话的事实」。
// 它不决定说话（闸门在 speech-coordinator），但「她/你上次谁说的、多久前、刚在聊什么」
// 是排查「接不上话/前言不搭后语」的第一现场——以前这些问题只能靠猜。
async function checkConversationScene() {
  const probe = () => evalJs('String((()=>{ const s=globalThis.conversationScene; if(!s||typeof s.snapshot!=="function") return "no-handle"; return JSON.stringify(s.snapshot()); })())');
  let raw = await probe();
  // 刚重启时 8004 先应答、插件/模块晚一拍挂载 —— 一次 1.2s 重试，避免把「启动竞态」误报成旧版
  if (raw === 'no-handle' || !raw) {
    await new Promise((r) => setTimeout(r, 1200));
    raw = await probe();
  }
  if (raw === 'no-handle' || !raw) {
    add('skip', '对话现场', '未挂载（旧版或未重启）', '重启宿主加载新版');
    return;
  }
  let j = null;
  try { j = JSON.parse(raw); } catch (e) { j = null; }
  if (!j) { add('skip', '对话现场', '快照格式异常（未验证）', '控制台跑 global.conversationScene.snapshot() 看结构'); return; }
  const who = j.lastSpeaker === 'companion' ? '她' : '你';
  const age = Number.isFinite(Number(j.lastContactAgeSec)) ? Math.round(Number(j.lastContactAgeSec) / 60) : null;
  const parts = ['最后说话：' + who + (age !== null ? '（' + age + ' 分钟前）' : '')];
  if (j.topic && j.topic.fresh && j.topic.text) parts.push('话题：' + String(j.topic.text).slice(0, 24));
  if (j.companion && j.companion.fresh && j.companion.text) {
    parts.push('她刚说：' + String(j.companion.text).slice(0, 16) + (j.companion.heard === false ? '（没人听）' : ''));
  }
  if (j.contact && Number(j.contact.skippedAway) > 0) parts.push('对空房间跳过 ' + j.contact.skippedAway + ' 次');
  // 只读观测项：能读到快照就是绿；内容偏旧由用户从 detail 里看，不在这里判红
  add(true, '对话现场', parts.join(' · '));
}

// MemOS 挂起感知（A-8）：客户端失败连击计数，连续 3 次失联会大声告警——doctor 把数字带出来
async function checkMemosSense() {
  const raw = await evalJs('String((()=>{ const e=window.pluginManager && window.pluginManager._plugins.get("built-in/memos"); const c=e&&e.plugin&&e.plugin.client; if(!c||typeof c.healthInfo!=="function") return "no-handle"; return JSON.stringify(c.healthInfo()); })())');
  if (raw === 'no-handle') { add('skip', 'MemOS 感知', '客户端旧版无 healthInfo（未验证）', '重启宿主加载新版 memos-client'); return; }
  let h = {};
  try { h = JSON.parse(raw); } catch (e) { h = {}; }
  if (h.enabled === false) { add('skip', 'MemOS 感知', '客户端禁用（未验证）', '启用后再看本项'); return; }
  const fs = Number(h.failStreak) || 0;
  if (fs >= 3) {
    add(false, 'MemOS 感知', '连续失联 ' + fs + ' 次——后端疑似挂起', '先 curl 127.0.0.1:8003/health（000=挂），再重启 MemOS');
  } else if (fs > 0) {
    add(true, 'MemOS 感知', '偶发失联 ' + fs + ' 次（未达告警线）');
  } else {
    add(true, 'MemOS 感知', '链路正常' + (h.lastOkAt ? '（最近成功 ' + new Date(h.lastOkAt).toLocaleTimeString() + '）' : '（尚无调用）'));
  }
}

// MemOS 长期记忆 + 它依赖的嵌入服务
// 公开版不随仓分发 MemOS 子树：缺了就 skip（用户自备后重新体检），不判红。
const MEMOS_SUBTREE = path.join(MY, 'plugins-dlc', 'memos', 'memos_system');
async function checkMemoryBackend() {
  if (!fs.existsSync(MEMOS_SUBTREE)) {
    add('skip', 'MemOS 后端', '公开版不含 MemOS（自备后放 _incoming/my-neuro/plugins-dlc/memos/memos_system）', '');
    add('skip', '嵌入服务 8090', '公开版不含 MemOS/嵌入（自备后可用）', '');
    return;
  }
  const emb = await get('http://127.0.0.1:8090/health');
  if (emb.error) {
    add(false, '嵌入服务 8090', '连不上（MemOS 会启动失败）', 'pwsh -File scripts/start-embed.ps1（或 docker start llama-embed）');
  } else {
    const models = await get('http://127.0.0.1:8090/v1/models');
    const id = (models.json && models.json.data && models.json.data[0] && models.json.data[0].id) || '?';
    add(true, '嵌入服务 8090', String(id).split(/[\\/]/).pop());
  }
  const h = await get('http://127.0.0.1:8003/health');
  if (h.error) {
    add(false, 'MemOS 8003', '连不上', '启动器会自动拉起；或 py plugins-dlc/memos/memos_system/api/memos_api_server_v2.py');
    return;
  }
  const e = (h.json && h.json.embedding) || {};
  const okEmbed = e.ready === true;
  add(okEmbed, 'MemOS 嵌入', okEmbed ? (e.model + ' · ' + e.dimension + ' 维 · ' + Math.round(e.avg_latency_ms || 0) + 'ms') : ('未就绪：' + (e.last_error || '未知')), okEmbed ? '' : '检查 embedding.provider 是否指向 8090');
  const st = await get('http://127.0.0.1:8003/stats');
  // 假绿修复（2026-11-09）：st.json 非空就绿 ≠ 记忆库真在工作。total_count 必须是数值。
  const tc = st.json && st.json.total_count;
  if (typeof tc === 'number' && Number.isFinite(tc)) {
    add(true, 'MemOS 记忆', tc + ' 条 · 图谱 ' + (st.json.graph_enabled ? '开' : '关'));
  } else if (st.json) {
    add('skip', 'MemOS 记忆', '服务在但 stats 读不出条数（未验证）', 'curl 127.0.0.1:8003/stats 看返回结构');
  } else {
    add(false, 'MemOS 记忆', '/stats 连不上（health 通但 stats 不通）', '重启 MemOS');
  }
}

// Python 依赖健康：今天真出过事——装 funasr-onnx 时 pip 把 numpy 换成了
// MINGW 实验构建，启动就警告 "CRASHES ARE TO BE EXPECTED"，
// 结果 MemOS 和「一起看」双双 0xC0000005 段错误。这条检查就是为它加的。
function checkPythonDeps() {
  try {
    const out = execSync('py -c "import numpy; print(numpy.__version__)" 2>&1', { encoding: 'utf8', timeout: 30000 });
    const mingw = /MINGW|CRASHES ARE TO BE EXPECTED/i.test(out);
    const ver = (out.match(/^(\d+\.\d+\.\d+)/m) || [])[1] || '?';
    if (mingw) {
      add(false, 'numpy', ver + '（MINGW 实验版，会段错误）', 'py -m pip install --force-reinstall --only-binary=:all: numpy -i https://pypi.tuna.tsinghua.edu.cn/simple');
    } else {
      add(true, 'numpy', ver);
    }
  } catch (e) {
    add(false, 'Python 依赖', 'py 跑不起来', '检查 Python 是否安装/在 PATH 里');
  }
}

// Rust 内核（pet-core）：2026-11-09 三十五轮加入。
// 它现在是三条热路径的唯一实现：画面 dHash（39ms vs Python 283ms）、
// 窗口枚举（4ms vs PowerShell 8s 超时）、键鼠输入。二进制没了这些功能会退化到慢速兜底，
// 但用户不会收到任何提示 —— 所以必须在这里查。
function checkPetCore() {
  const exe = path.join(ROOT, '..', 'pet-core', 'target', 'release', 'pet-core.exe');
  if (!fs.existsSync(exe)) {
    add('skip', 'Rust 内核', 'pet-core.exe 不存在（功能会退化到 Python/PowerShell 兜底）',
      'cd pet-core && cargo build --release');
    return;
  }
  try {
    const out = execSync(`"${exe}"`, {
      input: JSON.stringify({ cmd: 'screen_hash' }),
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    const d = JSON.parse(out);
    if (!d || !d.ok) { add(false, 'Rust 内核', 'screen_hash 失败：' + (d && d.error || '?')); return; }
    // 实测 39ms；超过 150ms 说明这台机器 GDI 特别慢，值得提醒
    const ms = Math.round((d.us || 0) / 1000);
    const okSpeed = ms <= 150;
    add(okSpeed, 'Rust 内核',
      `screen_hash ${ms}ms · ${d.width}×${d.height}`,
      okSpeed ? '' : 'dHash 偏慢（>150ms），检查显示缩放/多显示器配置');
  } catch (e) {
    add(false, 'Rust 内核', '跑不起来：' + (e && e.message || e), 'cd pet-core && cargo build --release');
  }
}

async function checkBrain() {
  const h = await get('http://127.0.0.1:8103/health');
  if (h.error) { add(false, '控制口 8103', '连不上', '宿主没起，或端口被占'); return; }
  add(true, '控制口 8103', 'uptime ' + (h.json && h.json.uptime) + 's');
  const info = await evalJs('JSON.stringify({plugins: window.pluginManager ? window.pluginManager._plugins.size : 0, tools: window.pluginManager ? window.pluginManager.getAllTools().length : 0, body: !!window.petBody})');
  if (!info) { add(false, '皮套与插件', '页面里读不到状态', '宿主可能还没加载完，等 10 秒再试'); return; }
  const v = JSON.parse(info);
  // 演出一段：场景数据在不在
  const scenes = await evalJs('JSON.stringify(window.petBody && window.petBody.listScenes ? window.petBody.listScenes() : [])');
  if (scenes) {
    let n = 0;
    try { n = JSON.parse(scenes).length; } catch (e) { n = 0; }
    add(n > 0, '演出编排', n + ' 段场景', n ? '' : '皮套没加载或场景没导出');
  }
  // 声学层：能不能读出「这是什么声音 + 气氛」
  const atmos = await evalJs('String((()=>{ const e=window.pluginManager && window.pluginManager._plugins.get("community/watch-screen"); const p=e&&e.plugin; return p && typeof p._audioAtmosphere === "function" ? "ok" : "missing"; })())');
  add(atmos === 'ok', '声学理解', atmos === 'ok' ? '已接入（音乐/人声/嘈杂 + 气氛）' : '没接入', atmos === 'ok' ? '' : 'watch-screen 插件版本旧');
  add(v.plugins > 0, '插件', v.plugins + ' 个插件 / ' + v.tools + ' 个工具', v.plugins ? '' : '检查 plugins/enabled_plugins.json');
  add(!!v.body, '皮套', v.body ? 'Cubism5 已加载' : '皮套没加载', v.body ? '' : '看 _incoming/petbody-debug.log');
}

async function checkRenderHealth() {
  // 渲染健康：渲染器三条诊断（抢写/白写/让位）的结构化快照，由渲染层经 8102 inner WS
  // 送到 8103 /state。判据照 2026-11-13 实测基线（driver.js 的 renderDiag）：
  //   · 同帧抢写 >0        → 红（两层写同一参数 = 说话抽搐的根因）
  //   · 白写 > 基线(2)     → 黄（物理输出被写后又被物理覆盖）
  //   · 表情让位数          → 只展示不判（切表情时必然变）
  // 为什么不扫日志：petbody-debug.log 是累积文件、每行还被截到 220 字，
  // 拿它做告警等于让人肉 grep —— 这就是本条要修的问题本身。
  const st = await get('http://127.0.0.1:8103/state');
  if (st.error) { add(false, '渲染健康', '/state 连不上（' + st.error + '）', '控制口没起，或宿主还没加载完'); return; }
  // ── 先判「渲染层还活着没」（2026-11-15 五十八轮）──────────────────────
  // 原来这里唯一能看的是下面那份 render-health 快照，而「快照陈旧」被写成
  // 「skip：渲染暂停/省电？动一下鼠标再看」—— 于是 2026-11-14 00:19 她静默冻死
  // 3.5 小时，doctor 就算跑了也只会给一个黄色 skip。
  // 现在 /state.renderer 是**主进程自己记的账**（8102 连接数 + 最后在线时刻）：
  // 渲染层断了就是页面 JS 不跑了，没有第二种解释，一律判红。
  const live = (st.json && st.json.renderer) || null;
  if (live && live.state === 'offline') {
    add(false, '渲染健康', '渲染层已死：' + live.detail, '看 live-2d/render-watchdog.log；主进程应当已经自愈（reload），没救回来就跑 pwsh -NoProfile -File pet-runtime/tools/restart-pet.ps1');
    return;
  }
  if (live && live.state === 'waiting') {
    add('skip', '渲染健康', '渲染层刚断开、在等它自己重连（2s 内正常）：' + live.detail, '10 秒后重跑；一直这样就是死了');
    return;
  }
  if (live && live.state === 'stale') {
    add('skip', '渲染健康', '可疑：' + live.detail, '画面如果也没动就是冻死了（不是省电），看 render-watchdog.log');
    return;
  }
  const h = (st.json && st.json.renderHealth) || null;
  if (!h) {
    add('skip', '渲染健康', '渲染层还没上报（哨兵 5 秒一采）', '等 10 秒重跑；一直没有 = inner WS 8102 断了');
    return;
  }
  const at = Number(st.json.renderHealthAt) || 0;
  const age = at ? Math.round((Date.now() - at) / 1000) : -1;
  const wasted = Number(h.wastedOutput) || 0;
  // ⚠ 2026-11-13：原来是 `Number(h.wastedBaseline) || 2` —— 0 是 falsy，会被兜底成 2，
  //   于是基线归零后这里仍显示「0/2」。和之前 emotion-state 的 `updatedAt || t` 同一个坑。
  const baseRaw = Number(h.wastedBaseline);
  const base = Number.isFinite(baseRaw) ? baseRaw : 2;
  const skip = h.skipped == null ? '-' : h.skipped;
  const detail = '帧 ' + (h.frames || 0) + ' · 白写 ' + wasted + '/' + base + ' · 让位 ' + skip + (age >= 0 ? ' · ' + age + 's 前' : '');
  if (h.conflict) {
    // B3（2026-11-18）：冲突明细现在带 owner 归属 —— 原来只有参数名和差值，
    // 知道「谁和谁抢」才可能直接定位到层（emotion-blend / expression-preset / lip …）。
    const top = Array.isArray(h.conflicts) && h.conflicts.length
      ? h.conflicts.map((c) => {
        const name = c.param || c.id || '?';
        const who = Array.isArray(c.owners) && c.owners.length ? '：' + c.owners.join('→') : '';
        return name + '(Δ' + c.delta + ')' + who;
      }).join(' ')
      : '明细缺失';
    add(false, '渲染健康', '同帧抢写 ' + (h.conflictFrames || '?') + ' 帧：' + top, '两层写同一参数会抽搐；看冒号后的层名，查 emotionOwnsParam 与 blendParameters 的所有权');
    return;
  }
  if (wasted > base) {
    add('skip', '渲染健康', '白写超基线 ' + wasted + '>' + base + '：' + (h.wastedIds || []).join(','), '纯物理输出不该写；看 param-commit 的分区');
    return;
  }
  if (age > 60) {
    add('skip', '渲染健康', '快照 ' + age + 's 未更新（渲染暂停/省电？）上一份：' + detail, '动一下鼠标或让她说句话再看');
    return;
  }
  add(true, '渲染健康', detail + ' · 零抢写');
}

async function checkSilentAudit() {
  // 静默失败审计（js/core/silent-audit.js）：仓里 359 处空 catch 的集中记账。
  // 它从 2026-11-08 就在记账，但**从来没人读过** —— 等于「静默失败」换了个
  // 地方继续静默（§27：失败路径必须发声）。这里把它接进门禁。
  const raw = await evalJs('JSON.stringify(window.__silentAudit ? window.__silentAudit.snapshot() : null)');
  if (!raw) { add('skip', '静默失败', '页面上读不到 __silentAudit（模块没加载？）', '确认 js/core/silent-audit.js 被 require 到宿主页面'); return; }
  let s = null;
  try { s = JSON.parse(raw); } catch (e) { s = null; }
  if (!s) { add('skip', '静默失败', '审计快照解析失败（未验证）', '控制台跑 window.__silentAudit.snapshot() 看结构'); return; }
  const total = Number(s.total) || 0;
  const unique = Number(s.unique) || 0;
  const top = Array.isArray(s.top) ? s.top : [];
  if (!total) { add(true, '静默失败', '0 次（启动至今没有被吞的异常）'); return; }
  const hot = top.find((x) => Number(x.count) >= 50);
  const desc = top.slice(0, 3).map((x) => x.where + '×' + x.count).join('  ');
  if (hot) {
    add(false, '静默失败', '热点 ' + hot.where + ' ×' + hot.count + '（共 ' + total + ' 次 / ' + unique + ' 处）：' + hot.msg,
      '这条路径在反复失败；把它从「吞掉」改成显式处理');
    return;
  }
  add('skip', '静默失败', total + ' 次 / ' + unique + ' 处（多数是可选能力降级）：' + desc, '控制台 __silentAudit.snapshot() 看明细');
}

async function checkHookStats() {
  // 插件钩子埋点（plugin-manager._traceHook / getHookStats）：每个插件的
  // onUserInput / onLLMResponse 等被调过多少次、报没报错、平均耗时。
  // 它一直在记，但没有出口 —— 插件钩子报错只会打一行 error 日志，容易被冲掉。
  const raw = await evalJs('JSON.stringify(window.pluginManager && window.pluginManager.getHookStats ? window.pluginManager.getHookStats() : null)');
  if (!raw || raw === 'null') { add('skip', '插件钩子', '读不到 getHookStats（plugin-manager 版本旧）', '重启宿主加载新版'); return; }
  let j = null;
  try { j = JSON.parse(raw); } catch (e) { j = null; }
  // 返回的是 { hooks: [...], silentPlugins: [...] } —— 不是裸数组
  const hooks = j && Array.isArray(j.hooks) ? j.hooks : null;
  if (!hooks) { add('skip', '插件钩子', '统计格式异常（未验证）', '控制台跑 pluginManager.getHookStats() 看结构'); return; }
  const silent = Array.isArray(j.silentPlugins) ? j.silentPlugins : [];
  if (!hooks.length) {
    add('skip', '插件钩子', '本次会话还没有钩子被调用（' + silent.length + ' 个插件未触发）', '跟她说句话再看');
    return;
  }
  const errs = hooks.filter((r) => Number(r.errors) > 0);
  const calls = hooks.reduce((s, r) => s + (Number(r.calls) || 0), 0);
  const slow = hooks.filter((r) => Number(r.avgMs) > 500);
  const short = (r) => String(r.plugin || '').split('/').pop() + '#' + r.hook;
  if (errs.length) {
    add(false, '插件钩子', errs.length + ' 个钩子报错：' + errs.slice(0, 3).map((r) => short(r) + '×' + r.errors).join(' '),
      '看 runtime.log 的「插件错误」行；钩子抛错会让那个插件静默少做一件事');
    return;
  }
  add(slow.length ? 'warn' : true, '插件钩子',
    calls + ' 次调用 / ' + hooks.length + ' 个钩子 · ' + silent.length + ' 个插件未触发' + (slow.length
      ? ' · 慢：' + slow.slice(0, 2).map((r) => short(r) + ' avg' + r.avgMs + 'ms').join(' ')
      : ' · 零报错'));
}

function checkMemory() {
  const main = path.join(RECORDS, '核心用户记忆.txt');
  if (!fs.existsSync(main)) {
    add(false, '记忆目录', '核心用户记忆.txt 不存在', '记录室应在 my-neuro/data');
  } else {
    const n = fs.readFileSync(main, 'utf8').split(/\r?\n/).filter((x) => x.trim() && !x.trim().startsWith('#')).length;
    add(n > 0, '记忆目录', '核心记忆 ' + n + ' 条', n ? '' : '还没有内容，可以手动写几条');
  }
  const stray = path.join(APP, 'data');
  if (fs.existsSync(stray)) add(false, '记录室分裂', 'live-2d/data 还在', '内容应并入父目录，可删掉这个旧目录');
}

// 开机自启（2026-11-21 缺陷 6）：判据改成**唯一实现** = HKCU Run 键 `DaFeiYu`。
// 旧判据查启动目录的 大肥鱼桌宠.cmd —— 那套已被废弃：实际机器上 HKCU 没有值、Startup 有旧 cmd，
// doctor 显示绿、托盘却显示未开启；一开托盘就把 cmd 删掉，doctor 立刻转红。
function readHkcuRunValue(name) {
  // 2026-11-21：原来用 execSync('reg query', {encoding:'utf8'}) —— reg.exe 按控制台代码页
  // （本机 CP936/GBK）输出，再按 UTF-8 解码会把中文路径解成 `D:\ai�˸�����\...`，
  // 于是「注册表指向的 launcher 不存在」这条红是**读法造成的假红**。
  // 改走 pwsh -Command：控制台输出强制 UTF-8，值本身是 Unicode，中文路径原样。
  try {
    const ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;'
      + '(Get-ItemProperty -Path \'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\''
      + ' -Name \'' + String(name).replace(/'/g, "''") + '\' -ErrorAction SilentlyContinue).'
      + String(name).replace(/[^A-Za-z0-9_]/g, '');
    const out = execFileSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
    const v = String(out || '').trim();
    return v || null;
  } catch (e) { return null; }
}

function checkAutostart() {
  const value = readHkcuRunValue('DaFeiYu');
  if (!value) {
    add(false, '开机自启', 'HKCU Run 无 DaFeiYu（未开启）', 'node tools/autostart.cjs on');
    return;
  }
  // 值是： "C:\Windows\System32\cmd.exe" /c start "" /min node "<launcher>"
  const m = value.match(/"([^"]+\.mjs)"/) || value.match(/([A-Za-z]:\\[^"]*\.mjs)/);
  if (!m) {
    add('warn', '开机自启', 'Run 值存在但解析不出 launcher：' + value, 'node tools/autostart.cjs on 重写该值');
    return;
  }
  const target = m[1];
  if (!fs.existsSync(target)) {
    add(false, '开机自启', '注册表指向的 launcher 不存在: ' + target, 'node tools/autostart.cjs on（路径变了要重写）');
    return;
  }
  add(true, '开机自启', 'HKCU Run DaFeiYu → ' + path.basename(target));
}

// 服务清单（2026-11-21 缺陷 2）：doctor 与 kill-all-pet.ps1 读同一份 services.json。
// 必需项不在 → 红；可选项不在 → 黄。端口集合不再在 doctor 里另写一套。
async function checkServicesManifest() {
  let m;
  try {
    m = JSON.parse(fs.readFileSync(path.join(HERE, 'services.json'), 'utf8'));
  } catch (e) {
    add(false, '服务清单', 'services.json 读不出：' + ((e && e.message) || e), '检查 pet-runtime/tools/services.json');
    return;
  }
  const services = Array.isArray(m.services) ? m.services : [];
  if (!services.length) { add(false, '服务清单', 'services.json 里没有服务条目', '恢复清单内容'); return; }
  const down = [];
  for (const s of services) { if (!(await tcp(Number(s.port)))) down.push(s); }
  const missingRequired = down.filter((s) => s.required);
  // 按需启动（launchBy=external 且非必需：8104 按键助手 / 8106 UIA）平时本来就不在，
  // 报「黄」等于每天挂一条永久噪声 —— 归到 detail 说明，不算异常。
  const onDemand = down.filter((s) => s.launchBy === 'external' && !s.required);
  const unexpected = down.filter((s) => !(s.launchBy === 'external' && !s.required));
  const detail = services.length + ' 项 · ' + (down.length
    ? '缺 ' + down.map((s) => s.id + '(' + s.port + ')').join(' ')
    : '全部在线');
  if (missingRequired.length) {
    add(false, '服务清单', detail, '必需项缺：' + missingRequired.map((s) => s.id).join(', ') + '；先跑 restart-pet.ps1');
  } else if (unexpected.length) {
    add('warn', '服务清单', detail, '可选项缺失不影响主体（见 services.json 的 launchBy/note）');
  } else if (onDemand.length) {
    add(true, '服务清单', detail + '（按需启动，未起属正常）');
  } else {
    add(true, '服务清单', detail);
  }
}

const hostOk = await checkHost();
checkPythonDeps();
checkPetCore();
await checkModel();
await checkVoice();
// MemOS 与嵌入服务跟桌面窗口无关，无论宿主在不在都查
await checkMemoryBackend();
if (hostOk) { await checkTtsPlayback(); await checkInterruptLatency(); await checkPersonaGuard(); await checkCompanionHealth(); await checkGaze(); await checkSubtitleWindow(); await checkQuietMode(); await checkEmoMemory(); await checkCoWatch(); await checkProsody(); await checkSer(); await checkAudioArc(); await checkBrain(); await checkRenderHealth(); await checkSilentAudit(); await checkHookStats(); await checkLiveDock(); await checkAliveState(); await checkCoordinator(); await checkProactiveChain(); await checkConversationScene(); await checkMemosSense(); }
checkMemory();
checkAutostart();
// 服务清单复核（与 kill-all-pet.ps1 共用 services.json）：必需项缺 → 红，可选项缺 → 黄
await checkServicesManifest();
// ── 延迟预算（E4，2026-11-22）─────────────────────────────────────────────
// 轮次 p50 / 工具 p90 / 评测总耗时，对比「最近 20 次的中位数」；超 20% 黄、连 3 次红。
// 只在回落时清零 streak —— 不做累计值告警（那是狼来了）。
async function checkLatencyBudget() {
  let LB;
  try {
    const mod = await import(new URL('../../_incoming/my-neuro/live-2d/js/core/latency-budget.js', import.meta.url).href);
    LB = mod.default || mod;
  } catch (e) {
    add('skip', '延迟预算', '模块不可用：' + ((e && e.message) || e), '');
    return;
  }
  let r;
  try { r = LB.evaluate(); } catch (e) {
    add('skip', '延迟预算', '评估失败：' + ((e && e.message) || e), '');
    return;
  }
  const parts = (r.items || []).filter((i) => i.value != null).map((i) => {
    const v = (i.value / 1000).toFixed(1) + 's';
    if (i.baseline == null) return i.label + ' ' + v + '（基线未建立）';
    return i.label + ' ' + v + '（基线 ' + (i.baseline / 1000).toFixed(1) + 's'
      + (i.overPct > 0 ? ' +' + i.overPct + '%' : '') + '）';
  });
  if (!parts.length) { add('skip', '延迟预算', '还没有样本（聊几句或跑一次评测）', ''); return; }
  if (r.bad > 0) {
    add(false, '延迟预算', parts.join(' · ') + ' —— 连续超预算', '看「轮次遥测」的阶段 p50/p90 定位慢在哪段');
    return;
  }
  if (r.warn > 0) { add('warn', '延迟预算', parts.join(' · ') + ' —— 超基线 20%', '连续 3 次会判红；先看是否偶发'); return; }
  add(true, '延迟预算', parts.join(' · '));
}

// ── 上下文预算（C3，2026-11-21）──────────────────────────────────────────
// llm-handler 每轮请求前记一条 section token（system/tools/history/volatile）；
// 这里读最近 20 轮算 p50/p90，并指出「后半段比前半段涨最多」的单项。
// 只读 telemetry，不引入新文件/进程。
async function checkContextBudget() {
  const file = path.join(APP, '.runtime', 'telemetry.jsonl');
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-4000)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) {
    add('skip', '上下文预算', '还没有 telemetry.jsonl（聊一句就会有）', '');
    return;
  }
  const rows = lines.filter((l) => l.cat === 'context' && l.type === 'context.budget' && l.metrics).slice(-20);
  if (!rows.length) {
    add('skip', '上下文预算', '还没有请求记录（重启宿主后聊一句）', '');
    return;
  }
  const pct = (arr, p) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1))];
  };
  const get = (k) => rows.map((r) => Number(r.metrics[k])).filter((n) => Number.isFinite(n));
  const fmt = (k) => { const a = get(k); return a.length ? Math.round(pct(a, 50)) + '/' + Math.round(pct(a, 90)) : '-'; };
  // 增长源：后半段均值 - 前半段均值（至少 6 轮才有意义）
  let growth = '';
  if (rows.length >= 6) {
    const half = Math.floor(rows.length / 2);
    const avg = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;
    const deltas = ['system_tokens', 'tools_tokens', 'history_tokens', 'volatile_tokens']
      .map((k) => {
        const a = rows.slice(0, half).map((r) => Number(r.metrics[k])).filter(Number.isFinite);
        const b = rows.slice(half).map((r) => Number(r.metrics[k])).filter(Number.isFinite);
        return (a.length && b.length) ? { k, d: Math.round(avg(b) - avg(a)) } : null;
      })
      .filter(Boolean)
      .sort((x, y) => y.d - x.d);
    if (deltas.length && deltas[0].d > 0) growth = ' · 涨最快 ' + deltas[0].k.replace('_tokens', '') + ' +' + deltas[0].d;
  }
  add(true, '上下文预算', '近 ' + rows.length + ' 轮 total ' + fmt('total_tokens')
    + ' · sys ' + fmt('system_tokens') + ' · tools ' + fmt('tools_tokens')
    + ' · hist ' + fmt('history_tokens') + ' · volatile ' + fmt('volatile_tokens') + growth);
}

// ── 轮次遥测（A4，2026-11-21）────────────────────────────────────────────
// 回答两个问题：① 最近 50 轮各阶段 p50/p90 是多少（哪一段在吃时间）；
// ② tool 事件有没有丢 turn_id（孤儿=不能归因）。数据源只有 .runtime/telemetry.jsonl，
// 不引入新文件/进程。旧版本事件没有 turn_id，所以覆盖率从**第一个 turn.begin** 起算。
async function checkTurnTelemetry() {
  const file = path.join(APP, '.runtime', 'telemetry.jsonl');
  let lines;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    lines = raw.trim().split('\n').slice(-4000)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) {
    add('skip', '轮次遥测', '还没有 telemetry.jsonl（跟她聊一句就会有）', '');
    return;
  }
  const pct = (arr, p) => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1))];
  };
  const secs = (arr) => (arr.length ? (pct(arr, 50) / 1000).toFixed(1) + '/' + (pct(arr, 90) / 1000).toFixed(1) + 's' : '-');
  const turnEnds = lines.filter((l) => l.cat === 'turn' && l.type === 'turn.end').slice(-50);
  const firstTurn = lines.findIndex((l) => l.cat === 'turn' && l.type === 'turn.begin');
  const toolEvts = (firstTurn >= 0 ? lines.slice(firstTurn) : []).filter((l) => l.cat === 'tool');
  const orphans = toolEvts.filter((l) => !l.turn_id).length;
  if (!turnEnds.length) {
    add('skip', '轮次遥测', '还没有轮次收尾事件（重启宿主后聊一句）', 'pwsh -File pet-runtime/tools/restart-pet.ps1');
    return;
  }
  const totals = turnEnds.map((l) => l.metrics && l.metrics.total_ms).filter((n) => Number.isFinite(n));
  const llm = turnEnds.map((l) => l.metrics && l.metrics.phase_llm_ms).filter((n) => Number.isFinite(n));
  const tool = turnEnds.map((l) => l.metrics && l.metrics.phase_tool_ms).filter((n) => Number.isFinite(n));
  const cover = toolEvts.length ? Math.round((1 - orphans / toolEvts.length) * 100) : 100;
  const detail = '近 ' + turnEnds.length + ' 轮 总 p50/p90=' + secs(totals)
    + ' · 到 LLM=' + secs(llm) + ' · 到工具=' + secs(tool)
    + ' · tool 事件 ' + toolEvts.length + ' 条覆盖率 ' + cover + '%' + (orphans ? '（孤儿 ' + orphans + '）' : '');
  if (orphans > 0 || (toolEvts.length >= 10 && cover < 99)) {
    add('warn', '轮次遥测', detail, 'tool 事件缺 turn_id：确认 tool-executor 是新版（重启宿主），且没有绕过 executeToolCalls 的旁路');
    return;
  }
  add(true, '轮次遥测', detail);
}

// ── 门禁真机项的陈旧度（2026-11-18 §73，对应 §68 B4）─────────────────────
// 真机项在服务没起时只能 SKIP。SKIP 本身已经可见（§71），但「多久没真正跑过」没人盯。
// 这里读 _probe/gate-history.json：>7 天没通过就降级提示（黄，不是红 —— 缺环境不该假红）。
async function checkGateStaleness() {
  let report;
  try {
    // doctor 是 ESM（.mjs），这里没有 require：必须用动态 import（CJS 互操作取 default）
    const mod = await import(new URL('../../_probe/gate-history.cjs', import.meta.url).href);
    const gh = mod.default || mod;
    report = gh.staleness(gh.defaultPath(path.resolve(HERE, '..', '..')));
  } catch (e) {
    add('skip', '真机项陈旧度', '台账模块不可用：' + ((e && e.message) || e), '先跑一次 node _probe/check-all.mjs');
    return;
  }
  if (!report.items.length) {
    add('skip', '真机项陈旧度', '台账还没有记录（跑一次门禁就会写）', 'node _probe/check-all.mjs');
    return;
  }
  const stale = report.items.filter((i) => i.stale);
  const detail = report.items.slice(0, 4).map((i) => (i.daysAgo === null ? i.label + ' 从未通过' : i.label + ' ' + i.daysAgo + ' 天前')).join(' · ');
  if (stale.length) {
    add('warn', '真机项陈旧度', stale.length + ' 项 >7 天没真机验过：' + detail, '跑一次门禁（确保 8004/3003/3004/8103 都在）；真机项过期等于没有这条验收');
    return;
  }
  add(true, '真机项陈旧度', report.items.length + ' 项都在 7 天内：' + detail);
}
// ── 备份新鲜度（E3，2026-11-22）──────────────────────────────────────────
// 只回答一个问题：最近一份备份是多少天前？>7 天或无备份 → 黄（不判红 ——
// 缺备份是可修的运维欠账，不该让体检整体变红）。目录约定与 backup-data.mjs
// 一致：仓库根/备份。清单格式见 scripts/backup-manifest.mjs；没有 manifest 的
// 旧备份退回「最近 .enc 的 mtime」，标 legacy。这里**不跑 sha256**（完整校验用
// `node scripts/backup-data.mjs --verify`），doctor 必须保持轻。
async function checkBackupFreshness() {
  const dir = path.resolve(HERE, '..', '..', '备份');
  let info;
  try {
    // doctor 是 ESM；scripts/backup-manifest.mjs 也是 ESM，可直接动态 import
    const mod = await import(new URL('../../scripts/backup-manifest.mjs', import.meta.url).href);
    info = mod.inspectBackupDir(dir);
  } catch (e) {
    add('skip', '备份新鲜度', '备份清单模块不可用：' + ((e && e.message) || e), '检查 scripts/backup-manifest.mjs 是否存在');
    return;
  }
  if (!info.found) {
    // 目录根本不存在 = 这台机器还没配过备份 → skip（不是故障）
    if (info.reason === '备份目录不存在') {
      add('skip', '备份新鲜度', '还没有备份目录（' + dir + '）', 'node scripts/backup-data.mjs --dry 生成第一份');
      return;
    }
    add('warn', '备份新鲜度', info.reason || '没有可识别的备份', '跑一次 node scripts/backup-data.mjs（含 manifest），再用 --verify 校验');
    return;
  }
  const age = info.ageDays === null ? '?' : String(info.ageDays);
  const kind = info.legacy ? '旧备份无 manifest' : 'manifest';
  const detail = '最近备份 ' + age + ' 天前（' + kind + ' · ' + info.fileCount + ' 个文件）';
  if (info.missing && info.missing.length) {
    add('warn', '备份新鲜度', detail + ' · 清单里有 ' + info.missing.length + ' 个文件缺失：' + info.missing.slice(0, 3).join(', '),
      '跑 node scripts/backup-data.mjs --verify 看明细，然后重新做一份备份');
    return;
  }
  if (info.ageDays === null || info.ageDays === undefined || info.ageDays > 7) {
    add('warn', '备份新鲜度', detail + (info.ageDays === null || info.ageDays === undefined ? '，时间读不出来' : '，超过 7 天'),
      '跑一次 node scripts/backup-data.mjs 生成新备份');
    return;
  }
  add(true, '备份新鲜度', detail + '（≤7 天）');
}
// ── 主进程崩溃现场（2026-11-22）────────────────────────────────────────────
// main.js 第一行把 uncaughtException/unhandledRejection 落进 crash-main.log。
// 只回答一个问题：最近 24 小时有没有新的崩溃条目？有 → 黄 + 首行摘要（含 code/url），
// 没有 → 绿。不判红：崩溃后 launcher 自愈，宿主可能正跑得好好的；但要让人看见。
async function checkMainCrashLog() {
  const file = path.resolve(HERE, '..', '..', '_incoming', 'my-neuro', 'live-2d', 'crash-main.log');
  let st = null;
  try { st = fs.statSync(file); } catch (e) { st = null; }
  if (!st) { add(true, '主进程崩溃', '没有崩溃记录（crash-main.log 不存在）'); return; }
  const ageMin = Math.max(0, (Date.now() - st.mtimeMs) / 60000);
  const ageText = ageMin < 60 ? Math.round(ageMin) + ' 分钟前' : (ageMin < 1440 ? Math.round(ageMin / 60) + ' 小时前' : Math.round(ageMin / 1440) + ' 天前');
  if (ageMin > 24 * 60) { add(true, '主进程崩溃', '最近一次崩溃在 ' + ageText + '（>24h，不算新事故）'); return; }
  let head = '';
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    head = lines.length ? lines[lines.length - 1].slice(0, 160) : '';
    if (!head && lines.length) head = lines[0].slice(0, 160);
  } catch (e) { head = '(读不出来: ' + ((e && e.message) || e) + ')'; }
  add('warn', '主进程崩溃', '最近一次崩溃在 ' + ageText + (head ? '：' + head : ''),
    '看 crash-main.log 的完整堆栈（restart-pet 失败时也会自动打印末尾 30 行）');
}
// ── 人格内核（2026-11-22 P0 观测面）──────────────────────────────────────
// persona-layers 现在对损坏文件「隔离 + 锁死写回」（见 _probe/test-persona-corruption.cjs 19 条），
// 但 doctor 得让人**看见**发生过这件事：只读检查 .corrupt-* 与当前文件能否解析，
// 绝不在这里触发隔离（doctor 不许改数据）。
async function checkPersonaKernel() {
  const dir = path.resolve(HERE, '..', '..', '_incoming', 'my-neuro', 'data');
  const file = path.join(dir, '人格内核.json');
  let corrupt = [];
  try { corrupt = fs.readdirSync(dir).filter((n) => n.startsWith('人格内核.json.corrupt-')); } catch (e) { corrupt = []; }
  if (corrupt.length) {
    add('warn', '人格内核', '发现 ' + corrupt.length + ' 个损坏隔离文件：' + corrupt.slice(0, 2).join(', '),
      '手工修好后改名回 人格内核.json 再重启（文件坏着时她锁死写回，slow 层不会更新）');
    return;
  }
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    add('skip', '人格内核', '还没有人格内核文件（首次运行会自动生成）');
    return;
  }
  try {
    const j = JSON.parse(raw);
    const slow = j && j.slow ? Object.values(j.slow).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0) : 0;
    const hasCore = !!(j && j.core && j.core.name);
    if (!hasCore) {
      add('warn', '人格内核', '缺 core.name（形状不合法，下次启动会被隔离）', '检查 人格内核.json 是否被手改坏');
      return;
    }
    add(true, '人格内核', 'core=' + String(j.core.name) + ' · slow ' + slow + ' 条');
  } catch (e) {
    add('warn', '人格内核', '当前文件解析失败（下次启动会被隔离并锁死写回）：' + String((e && e.message) || e).slice(0, 80),
      '手工修 JSON，或从 .corrupt-* 恢复');
  }
}
await checkContextBudget();
await checkLatencyBudget();
await checkTurnTelemetry();
await checkGateStaleness();
await checkBackupFreshness();
await checkMainCrashLog();
await checkPersonaKernel();

const bad = rows.filter((r) => r.ok === false);
const skipped = rows.filter((r) => r.ok === 'skip');
// 2026-11-13：'warn' 以前是个「幽灵态」—— mark 会画红叉，但 bad/skipped/good 三个
// 计数都不认它，于是「显示有红叉、汇总说 0 异常、数字加起来还不等于总项数」。
// 现在把它明确当黄（和未验证同色），并在抬头单独计数。
const warned = rows.filter((r) => r.ok === 'warn');
const goodCount = rows.filter((r) => r.ok === true).length;
console.log(C.bold + '大肥鱼 · 体检' + C.reset + C.dim + '（' + rows.length + ' 项：' + goodCount + ' 绿 / ' + bad.length + ' 异常 / ' + skipped.length + ' 未验证' + (warned.length ? ' / ' + warned.length + ' 警告' : '') + '）' + C.reset);
console.log('');
for (const r of rows) {
  const soft = r.ok === 'skip' || r.ok === 'warn';
  const mark = r.ok === true ? C.green + '✓' + C.reset
    : soft ? C.yellow + '?' + C.reset
    : C.red + '✗' + C.reset;
  console.log('  ' + mark + ' ' + r.name.padEnd(16) + C.dim + String(r.detail || '') + C.reset);
  if (r.ok !== true && r.fix) console.log('      ' + (soft ? C.dim : C.yellow) + '→ ' + r.fix + C.reset);
}
if (bad.length) {
  console.log('');
  console.log(C.bold + '最快的修法' + C.reset);
  console.log(C.dim + '  1) 全清再起：powershell -File tools/kill-all-pet.ps1 然后 node tools/launch-my-neuro.mjs' + C.reset);
  console.log(C.dim + '  2) 看日志：node tools/petctl.mjs logs 60' + C.reset);
}
// E1（2026-11-21）：健康快照。总是落 pet-runtime/.state/health.json（原子写），
// --json 时再向 stdout 打一份（人读输出已重定向到 stderr，管道不会被污染）。
// 写盘失败只警告，不改变退出码 —— 体检结论不该因为「快照写不进去」而变成红。
{
  const doc = {
    at: Date.now(),
    version: 1,
    total: rows.length,
    ok: goodCount,
    bad: bad.length,
    skipped: skipped.length,
    warned: warned.length,
    items: rows.map((r) => ({ name: r.name, status: r.ok, detail: r.detail || '', fix: r.fix || '' })),
  };
  try {
    const file = path.join(HERE, '..', '.state', 'health.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(file + '.tmp', file);
  } catch (e) {
    console.error('[doctor] 写 health.json 失败（不阻断）：' + ((e && e.message) || e));
  }
  if (jsonMode) process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
}
process.exit(bad.length ? 1 : 0);
