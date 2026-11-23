#!/usr/bin/env node
// runner.mjs —— 电脑操控评测执行器（真机、确定性、不调用 LLM）
//
// 用法：
//   node _probe/agent-eval/runner.mjs
//   node _probe/agent-eval/runner.mjs --only=win_alias_focus,uia_click_calc
//   node _probe/agent-eval/runner.mjs --threshold=0.9 --keep-tmp --verbose
//
// 判定：
//   · 8004 /eval 不通 → 打印 SKIP，退出 0（check-all 里显示 PASS，不会因桌宠没开而红）
//   · 8004 通但页面里没有 pluginManager → 失败，退出 1（桌宠没加载完，属于真异常）
//   · 成功率 < 阈值（默认 0.8）→ 退出 1
//
// 输出：屏幕摘要 + _probe/agent-eval/last-run.json（每条任务 ok/耗时/阶段错误）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE_ROOT = path.resolve(HERE, '..');
const PET_CORE = process.env.PET_CORE_BIN || path.resolve(PROBE_ROOT, '..', 'pet-core', 'target', 'release', 'pet-core.exe');
const PW = process.env.PET_PWSH || 'pwsh';

const args = process.argv.slice(2);
const getArg = (name, def = '') => {
  const hit = args.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return def;
  if (hit === '--' + name) return true;
  return hit.slice(('--' + name + '=').length);
};
const BASE = String(getArg('base', 'http://127.0.0.1:8004'));
const ONLY = String(getArg('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
// 门禁口径 = **零失败**（2026-11-21 根因修复）。
// 旧默认 0.8：9/10 通过也判绿，单点能力持续坏掉可以长期潜伏。
// 需要容忍型手动跑时显式传 --threshold=0.8。
const THRESHOLD = Number(getArg('threshold', '1'));
const KEEP_TMP = getArg('keep-tmp', false) === true || getArg('keep-tmp', '') === '1';
const VERBOSE = getArg('verbose', false) === true || getArg('verbose', '') === '1';
// --quiet（2026-11-21，用户要求）：**不占用户屏幕**。
//   ① 夹具/计算器启动后统一移到屏幕外（-4000,0）：可见（WGC/UIA 都要求可见）但用户看不见；
//   ② 跳过必须抢前台的三条：focus（真聚焦）、SendInput 打字（只认前台）、剪贴板（会占用户剪贴板）。
// 被跳过的任务在报告里记 SKIP（可见，不伪装成通过）。
const QUIET = getArg('quiet', false) === true || getArg('quiet', '') === '1';
const QUIET_SKIP = new Set(['win_alias_focus', 'keyboard_type_readback', 'clipboard_roundtrip']);
// 把窗口移到屏幕外（可见但看不见）。用我们自己的 app 工具（走 pet-core，不抢焦点）。
const OFFSCREEN_X = -4000;

// ── 评测地基三件套的开关（全部只在评测层生效，生产代码一行不改）──────────────
// EVAL_LIAR=1：假装工具每次都成功，用来证明 verify 读的是独立状态、抓得住谎报
const LIAR = process.env.EVAL_LIAR === '1' || getArg('liar', false) === true || getArg('liar', '') === '1';
// 谎报自检至少要判红几条才算「oracle 抓得住」（默认 5）
const LIAR_MIN_FAIL = Number(process.env.EVAL_LIAR_MIN_FAIL || getArg('liar-min-fail', '5')) || 5;
// 连续 N 个「会改状态」的动作后状态指纹没变 → 熔断（0 = 关）
const NO_CHANGE_N = Number(process.env.EVAL_NOCHANGE_N || getArg('no-change-n', '3'));
// 深度任务（3 条真机多步）。默认不开：它们会撞生产限速 20 次/分，单跑一条没问题，
// 全量一起跑会把 35 秒的基线拖到 1 分半以上；check-all 只有 120 秒预算。
const DEEP = process.env.EVAL_DEEP === '1' || getArg('deep', false) === true || getArg('deep', '') === '1';
// 熔断自检：用「真实动作用在真实原地」制造 no-change，验证熔断真的会响
const STALL_TEST = process.env.EVAL_STALL_TEST === '1' || getArg('stall-test', false) === true || getArg('stall-test', '') === '1';
// trace 读取预算（2026-11-20 审计 P2 #22）。只给自测用：EVAL_TRACE_TIMEOUT_MS=1
// 可以复现「页面忙/读不到」→ 报告必须标 unverified，而不是把预算断言静默当通过。
const TRACE_TIMEOUT_MS = Number(process.env.EVAL_TRACE_TIMEOUT_MS || 8000) || 8000;

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msStr = (n) => String(Math.round(n)).padStart(6) + 'ms';

// ── 单实例锁 ────────────────────────────────────────────────────────────────
// 为什么需要：本机 Notepad 是单实例多标签，`click_element` 的编号又来自「全局最后一次
// snapshot」（`UIA_SNAPSHOT_STATE.items`，不按窗口隔离）。两个评测同时跑会互相覆盖快照
// 编号、互相开关对方的夹具标签页 —— 两边都红，而且红得莫名其妙（本轮实测踩过）。
// 只挡并发，不挡「上一次崩溃留下的死锁」：持有者进程已经不在就自动接管。
const LOCK_FILE = path.join(HERE, '.tmp', 'runner.lock');
function lockHolderAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}
function acquireLock() {
  try {
    const prev = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (prev && Number(prev.pid) !== process.pid && lockHolderAlive(Number(prev.pid))) {
      return { ok: false, holder: prev };
    }
  } catch (e) { /* 没有锁 / 锁文件坏了 → 直接抢 */ }
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: nowIso(), base: BASE }));
    process.on('exit', () => {
      try {
        const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
        if (cur && Number(cur.pid) === process.pid) fs.unlinkSync(LOCK_FILE);
      } catch (e) { /* ignore */ }
    });
    return { ok: true };
  } catch (e) {
    // 锁本身写不了不能挡评测（只读盘/权限问题不该让门禁假红）
    return { ok: true, warn: String((e && e.message) || e) };
  }
}

// ── HTTP / 8004 ─────────────────────────────────────────────────────────────
let __phaseSeq = 0;   // 每个 phase 唯一 token（见 buildEval 的 __guard）
async function evalPage(js, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + '/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ js }),
      signal: ac.signal,
    });
    if (!res.ok) {
      // 500 的响应体里有页面抛出的真实错误（例如 NO_CHANGE_ABORT / 注入失败）——
      // 只报「8004 HTTP 500」会让报告丢掉 errorKind 的唯一线索。
      let body = '';
      try { body = String(await res.text()).slice(0, 500); } catch (e) { /* ignore */ }
      throw new Error('8004 HTTP ' + res.status + (body ? '：' + body : ''));
    }
    const j = await res.json();
    if (!j || j.ok !== true) throw new Error('eval failed: ' + JSON.stringify(j).slice(0, 400));
    return j.value;
  } finally {
    clearTimeout(timer);
  }
}

// 取消页面里的残留脚本（2026-11-20 审计 P1）。
// HTTP abort 只断 runner 这一侧；页面里的 async IIFE 还在跑（sleep/重试/type），
// 会把输入打进用户窗口。这里置 __petEvalDisabled 并让 token 失配 —— buildEval 的
// __guard 在下一次 sleep/call/__raw 前抛出，残留脚本立即停手（cleanup 不受影响）。
async function abortPageEval(reason) {
  const js = `(function(){
    try {
      const c = window.__petEvalCtl || (window.__petEvalCtl = { token: '', aborted: false, reason: null });
      c.aborted = true;
      c.reason = ${JSON.stringify(String(reason || 'abort'))};
      c.token = '__aborted__';
      window.__petEvalDisabled = true;
      if (typeof window.__petEvalAbort === 'function') window.__petEvalAbort(c.reason);
    } catch (e) {}
    return true;
  })()`;
  try {
    await evalPage(js, 3000);
    vlog('  ⛔ 已请求页面取消残留脚本（' + reason + '）');
  } catch (e) {
    vlog('  ⚠ 取消残留脚本失败（继续收尾）：' + String((e && e.message) || e));
  }
}

async function withTimeout(promise, ms, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error((label || 'phase') + ' 超时 ' + ms + 'ms')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── 「会改状态」判定（页面侧，评测层）────────────────────────────────────────
// 只有两处消费它：
//   · EVAL_LIAR 的 liarWrap  —— 决定伪造哪些调用
//   · no-change 熔断         —— 决定给哪些动作取状态指纹
// 为什么单独抽出来：这两处判错的方向必须一致（宁可把「可能改状态」当写），
// 否则会出现「谎报被伪造了但熔断不认」这种互相矛盾的报告。
const PAGE_MUTATING_CLASSIFIER = `
  // 只读工具：看一眼世界，世界没变
  const __RO_TOOL = { see: 1, file: 1, knowledge: 1 };
  // 同一工具里按 action 分读写（对齐 plugins/community/dispatch/index.js 的路由）
  const __RO_ACTION = {
    clipboard: { read: 1 },
    app: { list: 1 },              // app list = 可启动白名单；launch/focus/move… 都会改状态
    game: { status: 1, profiles: 1, see: 1 },
    act: { get_value: 1, read: 1 },
  };
  // game_control 的 READONLY 集合（照抄 game-control.js，含 read_text/edit_text 这种纯读）
  const __GC_RO = {
    list_windows: 1, snapshot: 1, som_snapshot: 1, list_game_profiles: 1, knowledge: 1,
    wgc_hash: 1, wgc_shot: 1, visual_read: 1, recent_actions: 1, edit_text: 1,
    project_status: 1, read_text: 1,
  };
  function __isMutating(name, params) {
    const n = String(name || '');
    const a = String((params && params.action) || '').toLowerCase();
    if (__RO_TOOL[n]) return false;
    const ro = __RO_ACTION[n];
    if (ro) return !ro[a];
    if (n === 'game_control') return !__GC_RO[a];
    // diary/memory/note/web_search 等不在评测任务里；真被用到就按「可能改状态」处理
    return true;
  }
`;

// ── 页面公共助手（注入到每条表达式前）────────────────────────────────────────
// opts.maintenance：cleanup / teardown 阶段。维护动作不是被测行为：
//   · 不能因为收尾动作合法地「没变化」就判熔断
//   · EVAL_LIAR 下也必须让收尾真的执行，否则夹具残留（记事本标签页/计算器关不掉）
function buildEval(taskId, expr, opts = {}) {
  const id = JSON.stringify(taskId);
  const maintenance = opts.maintenance === true;
  const phase = JSON.stringify(String(opts.phase || ''));
  // 令牌（2026-11-20 审计 P1）：每个 phase 一个 token，页面侧每次 sleep/call 前核对。
  // run 超时后 runner 把 token 置 '__aborted__'，残留脚本在下一次注入前抛 EVAL_ABORTED；
  // verify/cleanup 各自持新 token（且 maintenance 不参与取消），不会被误禁。
  const token = JSON.stringify(String(opts.token || (taskId + ':adhoc')));
  return `(async () => {
  const __R = window.__AGENT_EVAL__;
  if (!__R) throw new Error('agent-eval 状态丢失（页面可能 reload 过）');
  const __CTL = window.__petEvalCtl || (window.__petEvalCtl = { token: '', aborted: false, reason: null });
  const __TOKEN = ${token};
  const __ABORTABLE = ${maintenance ? 'false' : 'true'};
  __CTL.token = __TOKEN;
  __CTL.aborted = false;
  try { window.__petEvalDisabled = false; } catch (e) { /* 页面被冻结时不阻塞 */ }
  const __guard = () => {
    if (!__ABORTABLE) return;
    if (__CTL.aborted || __CTL.token !== __TOKEN) {
      throw new Error('EVAL_ABORTED: 本轮评测已超时/被替换，停止注入输入');
    }
  };
  const S = __R.run;
  const T = (__R.tasks[${id}] = __R.tasks[${id}] || {});
  const sleep = async (ms) => { __guard(); await new Promise((r) => setTimeout(r, ms)); __guard(); };
  const __N = Number(__R.noChangeN) || 0;
  const __PHASE = ${phase};
  // 每段表达式都显式设定，别指望上一段的残留 —— cleanup 会把它们置 true，
  // 不重置的话下一条任务就再也测不到谎报/熔断了。
  ${maintenance ? '__R.liarOff = true; __R.nchOff = true;' : '__R.liarOff = false; __R.nchOff = false;'}

  // 恢复任务的事件记录（仅评测层）：attempt / replan / retry / verify_read / error_class。
  // 与任务返回的 ok 解耦 —— 报告里的 attempts/replanTrace/errorKind 从这里读，不信任务自述。
  function recover(kind, detail) {
    __R.recovery = __R.recovery || {};
    const st = (__R.recovery[${id}] = __R.recovery[${id}] || { events: [] });
    const ev = Object.assign({ n: st.events.length + 1, kind: String(kind || ''), at: Date.now() }, detail || {});
    st.events.push(ev);
    if (st.events.length > 120) st.events.shift();
    return ev;
  }
  function recoverEvents() {
    __R.recovery = __R.recovery || {};
    return ((__R.recovery[${id}] || {}).events || []).slice();
  }

  // 2026-11-20 审计 P2 #24：恢复档位不能只信任务自报的 recover()（同义反复）。
  // 这里记录「runner 亲眼看到的事实」：每次逻辑工具调用的 tool/action/target/ok，
  // 以及夹具开窗事件。runner 侧据此判定 attempt/replan/verify-before-retry。
  // 与 recover() 完全独立：任务不写 recover() 也照样有序列；任务虚报 recover() 也骗不过序列。
  function observe(kind, detail) {
    __R.seq = __R.seq || {};
    const st = (__R.seq[${id}] = __R.seq[${id}] || { events: [] });
    st.events.push(Object.assign({ n: st.events.length + 1, kind: String(kind || ''), phase: __PHASE, at: Date.now() }, detail || {}));
    if (st.events.length > 240) st.events.shift();
  }

  // 评测专用助手：直接调 pet-core（不走生产工具，不占生产限速）。
  // 只用于确定性故障注入（按 hwnd 抢焦点/关窗口）和读窗口列表。
  function pet(req) {
    try {
      const cp = require('child_process');
      const out = cp.execFileSync(String(S.petCore || ''), [], {
        input: JSON.stringify(req || {}), timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      }).toString();
      try { return JSON.parse(out); } catch (e) { return { ok: false, error: 'pet-core 输出不是 JSON' }; }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // 探针专用：直接打原始 executeTool —— 不排队、不计入动作序列、不触发熔断
  async function __raw(name, params) {
    __guard();
    try {
      const raw = await window.pluginManager.executeTool(name, params || {});
      try { return JSON.parse(raw); } catch (e) { return { ok: null, _raw: String(raw) }; }
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  const __djb2 = (s) => { let h = 5381; for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
  const __TEXT_ACTS = new Set(['click', 'type', 'paste', 'set_value', 'select_text', 'perform', 'read', 'key', 'hold', 'scroll', 'drag']);
  const __CLICK_KEY = new Set(['click', 'key', 'hold', 'scroll', 'drag']);
  function __targetOf(name, params) {
    const p = params || {};
    let t = String(p.window || p.win || p.name || '').trim();
    // act click 的 target 可能是 "#3" 这种 UIA 编号 —— 编号不是窗口，别当目标
    if (!t && String(name) === 'act' && p.target && !/^#?\\d+$/.test(String(p.target))) t = String(p.target);
    return t;
  }

  // 「世界指纹」：只读探针，判断这次动作到底改没改东西。
  // 取指纹的三条路按成本从低到高：
  //   ① edit_text（WM_GETTEXT，实测 ~50ms）—— 记事本/输入框类
  //   ② snapshot（UIA 树，热态 ~140ms）—— 计算器这种没有编辑控件、但显示文本会变的
  //   ③ wgc_hash（WGC dHash，~400ms）—— 都不行时用像素兜底
  // 全都不吃生产限速（三条都是 READONLY）。窗口类动作直接读矩形，比抓图快一个数量级。
  async function __fp(name, params) {
    const p = params || {};
    const a = String(p.action || '').toLowerCase();
    const target = __targetOf(name, p);
    const ws = await __raw('see', { mode: 'windows' });
    const list = (ws && ws.windows) || [];
    const hit = target
      ? list.find((w) => String(w.title || '').includes(target) || String(w.hwnd) === target)
      : null;
    // 标题也进指纹：保存/改名这类动作不改正文，只把标题前的 * 去掉。
    // 不带上它，「ctrl+s → 菜单保存」会被误判成连续两个无变化（实测踩到过）。
    const titlePart = hit ? '|t:' + __djb2(String(hit.title || '')) : '';
    // 点击/按键优先看 UIA 树：菜单展开、按钮按下、弹框出现都会改变树；
    // 只看正文的话「点菜单保存」会被当成什么都没发生（正文本来就没变）。
    if (target && __CLICK_KEY.has(a)) {
      const sn0 = await __raw('see', { mode: 'tree', window: target });
      if (sn0 && sn0.ok && Array.isArray(sn0.elements)) {
        return 'tree:' + sn0.elements.length + ':' + __djb2(sn0.elements.map((e) => String(e.name || '')).join('|')) + titlePart;
      }
    }
    if (target && __TEXT_ACTS.has(a)) {
      const et = await __raw('game_control', { action: 'edit_text', arg: target });
      if (et && et.ok && et.len !== undefined) return 'edit:' + et.len + ':' + __djb2(String(et.text || '')) + titlePart;
      const sn = await __raw('see', { mode: 'tree', window: target });
      if (sn && sn.ok && Array.isArray(sn.elements)) {
        return 'tree:' + sn.elements.length + ':' + __djb2(sn.elements.map((e) => String(e.name || '')).join('|')) + titlePart;
      }
      const h = await __raw('game_control', { action: 'wgc_hash', arg: target });
      if (h && h.ok && h.hash) return 'hash:' + h.hash + titlePart;
    }
    if (hit) return 'rect:' + [hit.x, hit.y, hit.w, hit.h, hit.iconic].join(',') + titlePart;
    return 'all:' + list.map((w) => [w.hwnd, w.x, w.y, w.w, w.h].join(',')).join(';');
  }

  // no-change 熔断：连续 __N 个会改状态的动作后指纹完全一致 → 判定卡死，立刻中止本任务。
  // 为什么抛异常而不是返回失败：返回失败的话任务代码会继续往下点，
  // 「立刻中止」才是熔断的意义；已执行的动作序列留在 __R.nch 里给报告用。
  async function __track(name, params, res) {
    if (!__N || __R.nchOff || __R.liar) return;
    const p = params || {};
    if (!__R.isMutating(String(name), p)) return;
    const st = (__R.nch[${id}] = __R.nch[${id}] || { streak: [], log: [], aborted: null });
    if (st.aborted) return;
    // 等 UI 落定再取指纹：刚点完立刻读可能还是上一帧，会把「真变了」误判成「没变」。
    // 熔断唯一不能接受的就是误报。
    await sleep(130);
    let fp;
    try { fp = await __fp(String(name), p); } catch (e) { fp = 'err:' + String((e && e.message) || e).slice(0, 40); }
    st.log.push({
      n: st.log.length + 1,
      tool: String(name),
      action: String(p.action || ''),
      target: __targetOf(String(name), p),
      ok: !!(res && res.ok),
      fp: String(fp).slice(0, 80),
    });
    if (st.log.length > 60) st.log.splice(0, st.log.length - 60);
    if (st.streak.length && st.streak[st.streak.length - 1] === fp) st.streak.push(fp);
    else st.streak = [fp];
    if (st.streak.length >= __N) {
      st.aborted = {
        reason: '连续 ' + st.streak.length + ' 个会改状态的动作之后状态指纹完全没变，判定卡在同一个界面',
        n: __N,
        fingerprint: String(fp).slice(0, 80),
        actions: st.log.slice(-Math.max(__N + 2, 5)),
      };
      throw new Error('NO_CHANGE_ABORT: ' + st.aborted.reason);
    }
  }

  async function call(name, params, opts) {
    let last = null;
    // 每个 phase 的工具调用次数（只数逻辑调用，熔断/限速重试不重复计）。
    // 恢复任务用它核对预算（maxSteps）；报告里叫 runToolCalls。
    __R.counts = __R.counts || {};
    const __cnt = (__R.counts[${id}] = __R.counts[${id}] || {});
    if (__PHASE) __cnt[__PHASE] = (__cnt[__PHASE] || 0) + 1;
    // 每次逻辑调用只记一条最终结果（限速/冷却重试不重复记）。
    const obsTool = (v) => observe('tool', {
      tool: String(name),
      action: String((params && params.action) || ''),
      target: __targetOf(String(name), params || {}),
      ok: !!(v && v.ok),
      timeout: !!(v && v.timeout),
      fixture: !!(opts && opts.fixture),
      error: String((v && (v.error || v.detail)) || '').slice(0, 120),
    });
    // 撞限速不是「任务失败」，是「该等」：
    //   300ms 冷却等 900ms 就够；「20 次/分钟」是滑动窗口，只能等旧记录滑出 60s。
    // 生产闸不能改，评测层就在这儿等 —— 等待次数会写进报告，不藏。
    for (let i = 0; i < 14; i += 1) {
      __guard();
      const wait = 325 - (Date.now() - (__R.lastCallAt || 0));
      if (wait > 0) await sleep(wait);
      __R.lastCallAt = Date.now();
      let v;
      try {
        __guard();   // 等待期间可能已被取消：真正注入前再核对一次
        const raw = await window.pluginManager.executeTool(name, params || {});
        try { v = JSON.parse(raw); } catch (e) { v = { ok: null, _raw: String(raw) }; }
      } catch (e) {
        const r = { ok: false, error: String((e && e.message) || e), _threw: true };
        obsTool(r);
        return r;
      }
      last = v;
      const msg = String((v && (v.error || v.detail)) || '');
      const quota = v && v.ok === false && /一分钟里按了太多次/.test(msg);
      const cooldown = v && v.ok === false && /太快了|配额不够/.test(msg);
      if (quota || cooldown) {
        if (quota) {
          __R.waits = __R.waits || {};
          __R.waits[${id}] = (__R.waits[${id}] || 0) + 1;
        }
        await sleep(quota ? 5000 : 900);
        continue;
      }
      await __track(name, params, v);
      obsTool(v);
      return v;
    }
    await __track(name, params, last);
    obsTool(last);
    return last || { ok: false, error: 'call failed' };
  }

  async function winList() {
    const r = await call('see', { mode: 'windows' });
    return (r && r.windows) || [];
  }

  async function openNotepad(file, opts) {
    const base = String(file).split(/[\\\\/]/).pop().replace(/\\.[^.]+$/, '');
    // quiet：恢复任务的「重规划后重开」是评测夹具动作，不是被测步骤 ——
    // 用 __raw 轮询窗口，不占工具调用预算、不吃限速。
    const listWins = async () => ((opts && opts.quiet)
      ? (((await __raw('see', { mode: 'windows' })) || {}).windows || [])
      : await winList());
    const cp = require('child_process');
    const child = cp.spawn('C:/Windows/System32/notepad.exe', [file], { detached: true, stdio: 'ignore', windowsHide: false });
    try { child.unref(); } catch (e) { /* ignore */ }
    // 2026-11-21 实测：Win11 记事本会还原上次会话；旧标签指向已删除的临时文件时，
    // 启动就弹「找不到 … 文件」模态，把第一次 ctrl+w/保存全吃掉。用 __raw 点掉它
    //（夹具卫生，不占预算、不吃限速）。
    const dismissModals = async (hwnd) => {
      for (let k = 0; k < 8; k += 1) {
        const snap = await __raw('see', { mode: 'tree', window: String(hwnd) });
        const els = (snap && snap.elements) || [];
        const bi = els.findIndex((e) => /^(确定|OK)$/.test(String(e.name || '')));
        if (bi < 0) return true;
        await __raw('act', { action: 'click', target: '#' + (bi + 1), window: String(hwnd) });
        await sleep(400);
      }
      return false;
    };
    for (let i = 0; i < 16; i += 1) {
      await sleep(280);
      const ws = await listWins();
      const hit = ws.find((w) => String(w.title || '').includes(base));
      if (!hit) continue;
      // 2026-11-21 实测：Win11 记事本单实例多标签，启动器会先冒出一个临时窗口再移交给
      // 常驻进程；抢先拿到那个 hwnd 后 SetForegroundWindow 永远失败（任务 A 因此假 SKIP）。
      // 这里先确认句柄稳定（300ms 后仍在、标题仍匹配），再确认它真的能拿到前台；
      // 拿不到就 min→restore（还原天然取得前台资格），仍不行就继续等下一个窗口。
      await sleep(300);
      const ws2 = await listWins();
      const still = ws2.find((w) => String(w.hwnd) === String(hit.hwnd) && String(w.title || '').includes(base));
      if (!still) continue;
      let fr = pet({ cmd: 'focus', target: String(hit.hwnd), force: true });
      let fg = pet({ cmd: 'fg' });
      if (!fr.ok || String(fg.hwnd) !== String(hit.hwnd)) {
        pet({ cmd: 'window_op', op: 'min', target: String(hit.hwnd) });
        await sleep(450);
        fr = pet({ cmd: 'focus', target: String(hit.hwnd), force: true });
        await sleep(200);
        fg = pet({ cmd: 'fg' });
      }
      if (!fr.ok || String(fg.hwnd) !== String(hit.hwnd)) continue;
      await dismissModals(hit.hwnd);
      // 开窗 = 恢复任务「重规划」的客观证据（同一 phase 内新开窗口）。
      // setup 阶段的开窗会被 runner 侧按 phase 过滤掉，不影响判定。
      observe('window_open', { file: base, title: hit.title, hwnd: hit.hwnd });
      return { title: hit.title, hwnd: hit.hwnd, pid: hit.pid, x: hit.x, y: hit.y, w: hit.w, h: hit.h };
    }
    return null;
  }

  async function closeNotepadTab(marker) {
    const tt = {};
    const has = async () => (await winList()).some((w) => String(w.title || '').includes(marker));
    if (!(await has())) return { ok: true, already: true };
    let t0 = Date.now();
    let prompt = '';
    let dialog = '';
    let keyOk = false;
    // 最多试 2 轮。为什么要重试：Notepad 里可能压着一个模态错误框
    //（例如上一轮评测被宿主重启打断后，留下的标签页指向已被删掉的临时文件，
    //  关闭时弹「系统找不到指定的路径」）—— 它会把 ctrl+w 吃掉，标签页关不掉。
    for (let round = 0; round < 2; round += 1) {
      await sleep(round ? 450 : 300);
      t0 = Date.now();
      // 不再单独 app focus：press_key 本身就带 focus（走宽松的游戏闸，不吃严格配额），
      // 而且它会在发键前断言前台确实是目标窗口 —— 聚焦失败时宁可 not_sent，
      // 也绝不把 ctrl+w 发给当前前台（那可能是用户的文档）。
      const k = await call('act', { action: 'key', target: 'ctrl+w', window: marker });
      tt.key = (tt.key || 0) + (Date.now() - t0);
      keyOk = keyOk || !!(k && k.ok);
      await sleep(900);
      if (!(await has())) return { ok: true, prompt, dialog, keyOk, gone: true, timings: tt };
      // 有未保存改动时，保存框在同一个 Notepad 窗口的 UIA 树里（list_windows 看不到独立窗口）
      t0 = Date.now();
      const snap = await call('see', { mode: 'tree', window: marker });
      tt.snapshot = (tt.snapshot || 0) + (Date.now() - t0);
      const names = ((snap && snap.elements) || []).map((e) => String(e.name || ''));
      prompt = names.find((n) => /不保存|Don.t Save|^No$/i.test(n)) || '';
      if (prompt) {
        t0 = Date.now();
        // 优先按 snapshot 编号点（UIA Invoke，~0.4s）；click_text 会做全文 UIA 搜索，实测 4s+
        const idx = names.findIndex((n) => n === prompt) + 1;
        let clicked = false;
        if (idx > 0) {
          // §71：点「不保存」属于破坏性动作，守卫默认拒绝 —— 这是我们自己的夹具，显式确认
          const cr = await call('act', { action: 'click', target: '#' + idx, window: marker, confirm_destructive: true });
          clicked = !!(cr && cr.ok);
        }
        if (!clicked) await call('act', { action: 'click', target: '文字:' + prompt, confirm_destructive: true });
        tt.clickSave = Date.now() - t0;
        await sleep(800);
        continue;
      }
      // 非保存框的模态错误：找「确定 / OK」点掉，再重试 ctrl+w
      dialog = names.find((n) => /^确定$|^OK$/.test(n)) || '';
      if (dialog) {
        const di = names.findIndex((n) => n === dialog) + 1;
        let clicked = false;
        if (di > 0) clicked = !!(await call('act', { action: 'click', target: '#' + di, window: marker }));
        if (!clicked) await call('act', { action: 'click', target: '文字:' + dialog, window: marker });
        await sleep(500);
      }
    }
    t0 = Date.now();
    let gone = !(await has());
    tt.hasAfter = Date.now() - t0;
    if (!gone) { await sleep(700); gone = !(await has()); }
    return { ok: gone, prompt, dialog, keyOk, gone, timings: tt };
  }

  // 菜单保存：ctrl+s 在本机 Win11 记事本经 SendInput 不落盘（tasks.mjs:709 实测），
  // 所以恢复任务统一走「文件→保存」。快照取编号是现成的可靠路径（deep 任务已用）。
  async function saveNotepadViaMenu(marker, hwnd) {
    const win = String(hwnd || marker);
    const titleOf = async () => {
      const r = await __raw('see', { mode: 'windows' });
      const ws = (r && r.windows) || [];
      const w = ws.find((x) => String(x.hwnd) === win) || ws.find((x) => String(x.title || '').includes(marker));
      return w ? String(w.title || '') : '';
    };
    const before = await titleOf();
    if (!String(before).startsWith('*')) return { ok: true, via: 'already-clean', title: before };
    const s1 = await call('see', { mode: 'tree', window: marker });
    const n1 = ((s1 && s1.elements) || []).map((e) => String(e.name || ''));
    const fi = n1.indexOf('文件');
    if (fi < 0) return { ok: false, via: 'menu', error: '快照里没有「文件」菜单', names: n1.slice(0, 16) };
    const c1 = await call('act', { action: 'click', target: '#' + (fi + 1), window: marker });
    await sleep(550);
    const s2 = await call('see', { mode: 'tree', window: marker });
    const n2 = ((s2 && s2.elements) || []).map((e) => String(e.name || ''));
    const si = n2.findIndex((n) => /^保存$/.test(n));
    if (si < 0) return { ok: false, via: 'menu', error: '子菜单里没有「保存」', names: n2.slice(0, 20) };
    const c2 = await call('act', { action: 'click', target: '#' + (si + 1), window: marker, confirm_destructive: true });
    await sleep(950);
    const after = await titleOf();
    return {
      ok: !String(after).startsWith('*'),
      via: 'menu',
      title: after,
      clicks: { file: !!(c1 && c1.ok), save: !!(c2 && c2.ok) },
    };
  }

  // 关闭标签页并在保存框里点「保存」/「不保存」。
  // opts.injectTimeout：把「保存」那一次点击包成「已发出、返回值超时」——
  // 真实动作照做（文件真的落盘、标签页真的关闭），只把返回值换成超时，
  // 用来制造「不确定副作用」；是否原样重试由任务策略决定。
  async function closeSave(marker, hwnd, opts) {
    const action = (opts && opts.action) === 'discard' ? 'discard' : 'save';
    const win = String(hwnd || marker);
    const re = action === 'discard' ? /^(不保存|Don.t Save)$/i : /^(保存|Save)$/i;
    const k = await call('act', { action: 'key', target: 'ctrl+w', window: win });
    // 保存框是异步弹的：固定 sleep 在忙的时候会读早（实测 3 条恢复任务连跑时偶发）。
    // 最多等 ~2.5s，每轮先看标签页还在不在，再读一次树。
    let names = [];
    let idx = 0;
    let closedNoPrompt = false;
    for (let round = 0; round < 4; round += 1) {
      await sleep(round === 0 ? 650 : 450);
      const leftNow = (((pet({ cmd: 'windows', filter: marker, max: 10 }) || {}).windows) || []).length;
      if (!leftNow) { closedNoPrompt = true; break; }
      const snap = await call('see', { mode: 'tree', window: marker });
      names = ((snap && snap.elements) || []).map((e) => String(e.name || ''));
      idx = names.findIndex((n) => re.test(n)) + 1;
      if (idx > 0) break;
      // 会话还原留下的「找不到文件」模态会吃掉第一次 ctrl+w：点掉它再补按一次。
      const di = names.findIndex((n) => /^(确定|OK)$/.test(n));
      if (di >= 0) {
        await __raw('act', { action: 'click', target: '#' + (di + 1), window: marker });
        await sleep(400);
        await call('act', { action: 'key', target: 'ctrl+w', window: win });
        continue;
      }
    }
    const promptNames = names.filter((n) => /保存|Save/.test(n)).slice(0, 8);
    if (closedNoPrompt) {
      // discard：没框直接关掉是正常收尾。save：没有保存框说明内容没落进去 / 已被别的路径保存，
      // 对恢复任务来说不能当成功（否则「什么都没写」也会绿）。
      if (action === 'discard') return { ok: true, closed: true, noPrompt: true, key: !!(k && k.ok), promptNames };
      return { ok: false, closed: true, noPrompt: true, key: !!(k && k.ok), promptNames, error: 'ctrl+w 直接关闭了标签页，没有出现保存框（内容可能没写入）' };
    }
    if (idx <= 0) {
      return { ok: false, closed: false, key: !!(k && k.ok), promptNames, allNames: names.slice(0, 24), error: '保存框里没找到「' + (action === 'discard' ? '不保存' : '保存') + '」' };
    }
    let click = null;
    let injected = false;
    let real = null;
    if (opts && opts.injectTimeout) {
      const orig = window.pluginManager.executeTool.bind(window.pluginManager);
      window.pluginManager.executeTool = async function (name, params) {
        const p = params || {};
        if (String(name) === 'act' && String(p.action) === 'click' && String(p.target) === '#' + idx) {
          try { const raw = await orig(name, params); real = JSON.parse(raw); } catch (e) { real = { ok: false, error: String((e && e.message) || e) }; }
          injected = true;
          return JSON.stringify({ ok: false, error: '动作超时（8000ms）：已发出、未确认是否生效', action_sent: true, verified: null, timeout: true });
        }
        return orig(name, params);
      };
      try {
        click = await call('act', { action: 'click', target: '#' + idx, window: marker, confirm_destructive: true });
      } finally {
        window.pluginManager.executeTool = orig;
      }
    } else {
      click = await call('act', { action: 'click', target: '#' + idx, window: marker, confirm_destructive: true });
    }
    await sleep(900);
    const left = (((pet({ cmd: 'windows', filter: marker, max: 10 }) || {}).windows) || []).length;
    const clickOk = injected ? !!(real && real.ok) : !!(click && click.ok);
    return {
      ok: !!(k && k.ok && clickOk && left === 0),
      closed: left === 0,
      key: !!(k && k.ok),
      clicked: !!(click && click.ok),
      clickOk,
      injected,
      real,
      timeoutReturned: injected ? !!(click && click.ok === false) : false,
      promptNames,
    };
  }

  // 确定性地「只输入一份」：读回计数，多打的用 ctrl+z 撤回，没打进去的补一次。
  // 为什么需要：生产 type_text 在 Rust 内核超时后会回落 8104 **从头重打**
  //（game-control.js:3006 明确写了这个风险），实测在 --deep 连跑时偶发整段重复。
  // 恢复任务的 oracle 是「文件里 marker 恰好 1 次」——如果把这个工具抖动算成恢复失败，
  // 测的就不是恢复策略了。这里只做夹具归一，不改变被测的任务动作序列。
  async function typeOnce(text, win) {
    const marker = String(text);
    const winRef = String(win);
    const out = { types: 0, undos: 0, finalCount: null, ok: false };
    const countNow = async () => {
      const r = await call('game_control', { action: 'edit_text', arg: winRef });
      const t = String((r && r.text) || '');
      const hits = t.split(marker).length - 1;
      return { count: hits, text: t };
    };
    out.type = await call('act', { action: 'type', target: marker, window: winRef });
    out.types += 1;
    let rc = await countNow();
    for (let i = 0; i < 2 && rc.count > 1; i += 1) {
      await call('act', { action: 'key', target: 'ctrl+z', window: winRef });
      await sleep(250);
      out.undos += 1;
      rc = await countNow();
    }
    if (rc.count === 0) {
      // 补打是夹具归一（第一次根本没打进去），不是「第二次逻辑尝试」——
      // observed 的 attempts 不数它，否则 C 的「只输入一次」会被误判成两次。
      await call('act', { action: 'type', target: marker, window: winRef }, { fixture: true });
      await sleep(600);
      out.types += 1;
      rc = await countNow();
    }
    out.finalCount = rc.count;
    out.ok = rc.count === 1;
    out.readback = rc.text.slice(0, 240);
    return out;
  }

  function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }

  ${expr}
})()`;
}

// ── 独立取证（Node 侧）──────────────────────────────────────────────────────
function foreground() {
  try {
    const out = execFileSync(PET_CORE, [], {
      input: JSON.stringify({ cmd: 'fg' }),
      timeout: 4000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }).toString('utf8');
    const j = JSON.parse(out);
    return j && j.ok ? { hwnd: j.hwnd, pid: j.pid, title: String(j.title || '') } : null;
  } catch (e) {
    return null;
  }
}

function petWindows(filter) {
  try {
    const out = execFileSync(PET_CORE, [], {
      input: JSON.stringify({ cmd: 'windows', filter: String(filter || ''), max: 20 }),
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }).toString('utf8');
    const j = JSON.parse(out);
    return (j && j.windows) || [];
  } catch (e) {
    return [];
  }
}

function pwshJson(script) {
  try {
    const out = execFileSync(PW, ['-NoProfile', '-Command', script], {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    }).trim();
    return out ? JSON.parse(out) : null;
  } catch (e) {
    return null;
  }
}

function pwshReadClipboard() {
  try {
    // 用 base64 过桥：避免 Get-Clipboard -Raw 的换行/控制台编码差异
    const out = execFileSync(PW, ['-NoProfile', '-Command',
      "$t = Get-Clipboard -Raw; if ($null -eq $t) { $t = '' }; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$t))"], {
      timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
    }).trim();
    return Buffer.from(out, 'base64').toString('utf8');
  } catch (e) {
    return null;
  }
}

function pwshClearClipboard() {
  try {
    execFileSync(PW, ['-NoProfile', '-Command', "Set-Clipboard -Value ''"], {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch (e) {
    return false;
  }
}

// 清掉评测自己派生的 notepad.exe 启动器（命令行指向 _probe/agent-eval/.tmp）。
// 为什么需要：每次 openNotepad 都 spawn 一个 notepad.exe，标签页关掉后启动器有时不退出。
// 这些无窗口进程会让「按进程名找记事本」的 app-alias 选到一个没有窗口的 pid ——
// 实测踩到 win_alias_focus 报「没找到这个窗口：记事本」。
// 只杀命令行里带我们 temp 路径的进程；用户自己的 Notepad（WindowsApps 会话进程）不在范围内。
function killEvalNotepadStubs() {
  try {
    const script = [
      "$ps = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Notepad.exe' -and $_.CommandLine -like '*_probe*agent-eval*' } | ForEach-Object { $_.ProcessId })",
      "foreach ($p in $ps) {",
      "  $gp = Get-Process -Id $p -ErrorAction SilentlyContinue",
      // 只杀「没有窗口」的启动器：有窗口的那个进程可能正托管着标签页，杀了会把窗口关掉
      "  if ($gp -and $gp.MainWindowHandle -eq 0) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; $p }",
      "}",
    ].join('; ');
    const out = execFileSync('pwsh', ['-NoProfile', '-Command', script], {
      timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8',
    }).trim();
    const pids = out.split(/\s+/).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
    return { ok: true, killed: pids };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// BMP（WGC 输出 32bpp BI_RGB，高度可能为负 = top-down）+ 非黑帧/尺寸校验
function checkBmp(p, opts = {}) {
  const out = { ok: false, detail: { path: p } };
  if (!p || !fs.existsSync(p)) { out.detail.error = '文件不存在'; return out; }
  let b = null;
  try { b = fs.readFileSync(p); } catch (e) { out.detail.error = '读取失败：' + e.message; return out; }
  if (b.length < 54 || b.toString('ascii', 0, 2) !== 'BM') { out.detail.error = '不是 BMP'; return out; }
  const dataOff = b.readUInt32LE(10);
  const hdrSize = b.readUInt32LE(14);
  if (hdrSize < 40) { out.detail.error = '不支持的 BMP 头'; return out; }
  const w = b.readInt32LE(18);
  const hRaw = b.readInt32LE(22);
  const bpp = b.readUInt16LE(28);
  const comp = b.readUInt32LE(30);
  const absW = Math.abs(w);
  const absH = Math.abs(hRaw);
  const rowSize = Math.floor((bpp * absW + 31) / 32) * 4;
  Object.assign(out.detail, { bytes: b.length, w: absW, h: absH, bpp, compression: comp });
  if (bpp !== 32 || comp !== 0) { out.detail.error = '不是 32bpp BI_RGB'; return out; }
  if (!absW || !absH || dataOff + rowSize * absH > b.length) { out.detail.error = '像素区越界'; return out; }
  if (opts.expectW && absW !== Number(opts.expectW)) { out.detail.error = '宽度与工具自报不一致'; return out; }
  if (opts.expectH && absH !== Number(opts.expectH)) { out.detail.error = '高度与工具自报不一致'; return out; }
  if (opts.window && (absW !== Number(opts.window.w) || absH !== Number(opts.window.h))) {
    out.detail.error = '尺寸与窗口几何不一致';
    out.detail.window = opts.window;
    return out;
  }
  const stepX = Math.max(1, Math.floor(absW / 140));
  const stepY = Math.max(1, Math.floor(absH / 120));
  let n = 0, nonBlack = 0, sum = 0, sumSq = 0, min = 255, max = 0;
  for (let y = 0; y < absH; y += stepY) {
    const row = dataOff + y * rowSize;
    for (let x = 0; x < absW; x += stepX) {
      const i = row + x * 4;
      const lum = 0.114 * b[i] + 0.587 * b[i + 1] + 0.299 * b[i + 2];
      n += 1;
      sum += lum;
      sumSq += lum * lum;
      if (lum > 20) nonBlack += 1;
      if (lum < min) min = lum;
      if (lum > max) max = lum;
    }
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  const stddev = Math.sqrt(variance);
  const ratio = nonBlack / n;
  Object.assign(out.detail, {
    samples: n,
    nonBlackRatio: Number(ratio.toFixed(4)),
    meanLum: Number(mean.toFixed(1)),
    stddev: Number(stddev.toFixed(2)),
    min: Number(min.toFixed(0)),
    max: Number(max.toFixed(0)),
  });
  // 黑帧/纯色帧判据：既要有相当比例非黑像素，也要有真实亮度差异
  if (ratio < 0.05) { out.detail.error = '疑似黑帧（非黑像素 <5%）'; return out; }
  if (stddev < 3) { out.detail.error = '疑似纯色帧（亮度 stddev <3）'; return out; }
  out.ok = true;
  return out;
}

function unlinkQuiet(p) {
  try {
    if (!p || !fs.existsSync(p)) return { ok: true, already: true };
    const base = path.basename(p).toLowerCase();
    const dir = path.dirname(p).replace(/\\/g, '/').toLowerCase();
    // 只删 WGC 自己落的 shot-*.bmp，避免表达式被污染时删到用户文件
    if (!(base.startsWith('shot-') && base.endsWith('.bmp')) || !dir.includes('pet-wgc')) {
      return { ok: false, detail: { error: '拒绝删除非 WGC 截图：' + p } };
    }
    fs.unlinkSync(p);
    return { ok: true, deleted: p };
  } catch (e) {
    return { ok: false, detail: { error: String(e.message || e) } };
  }
}

// ── JSON 清洗（防 last-run.json 被超长文本撑爆）──────────────────────────────
function sanitize(v, depth = 0) {
  if (depth > 8) return '[depth]';
  if (typeof v === 'string') return v.length > 2000 ? v.slice(0, 2000) + '…[truncated]' : v;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  if (Array.isArray(v)) return v.slice(0, 60).map((x) => sanitize(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = sanitize(x, depth + 1);
    return o;
  }
  return String(v);
}

// ── 任务执行 ────────────────────────────────────────────────────────────────
const {
  TASKS, DEEP_TASKS, NOCHANGE_SELFTEST,
  THRESHOLD: TASK_THRESHOLD, TASK_TIMEOUT_MS,
} = await import(pathToFileURL(path.join(HERE, 'tasks.mjs')).href);
const threshold = Number.isFinite(THRESHOLD) && THRESHOLD > 0 ? THRESHOLD : (TASK_THRESHOLD || 0.8);
// keyboard_type_readback 不再蹭共享夹具：它自己开一个带编辑焦点的新标签页（见 tasks.mjs 备注）
const NEEDS_FIXTURE = new Set(['win_alias_focus', 'window_move_size', 'uia_read_text', 'screenshot_nonblack', 'list_windows_target', 'window_move_size_restore', NOCHANGE_SELFTEST.id]);
// 依赖共享记事本夹具的深度任务必须排在 keyboard_type_readback 之前——
// 那条任务会把共享夹具标签页写脏并关掉，之后再用就没窗口了。
const deepFirst = (DEEP_TASKS || []).filter((t) => NEEDS_FIXTURE.has(t.id));
const deepLast = (DEEP_TASKS || []).filter((t) => !NEEDS_FIXTURE.has(t.id));
const ALL_TASKS = [...deepFirst, ...TASKS, ...deepLast];
const defaultPool = DEEP ? ALL_TASKS : TASKS;
const selected = ONLY.length
  ? [...ALL_TASKS, NOCHANGE_SELFTEST].filter((t) => ONLY.includes(t.id))
  : (STALL_TEST ? [...defaultPool, NOCHANGE_SELFTEST] : defaultPool);
const needFixture = selected.some((t) => NEEDS_FIXTURE.has(t.id));
if (!selected.length) {
  console.error('没有匹配的任务：' + (ONLY.join(',') || '(空)'));
  process.exit(2);
}

const runId = Date.now().toString(36);
const run = {
  runId,
  startedAt: nowIso(),
  baseUrl: BASE,
  marker: 'ae-' + runId + '-fix',
  textMarker: 'AE_MARK_' + runId,
  clipMarker: 'AE_CLIP_' + runId,
  tmpDir: path.join(HERE, '.tmp', runId),
  fixtureFile: '',
  fileDir: '',
  filePath: '',
  fileContent: '',
  fixture: null,
  ownedCalc: null,
  originalForeground: null,
  clipOriginalLen: null,
};
run.fixtureFile = path.join(run.tmpDir, run.marker + '.txt');
run.fileDir = path.join(run.tmpDir, 'file-tool');
run.filePath = path.join(run.fileDir, 'marker-' + runId + '.txt');
run.fileContent = run.textMarker + '\nthird line\n';
run.fileContentLen = Buffer.byteLength(run.fileContent);
// 保存回读任务的落盘文件：先建空文件再交给记事本，否则会弹「找不到文件」对话框
run.saveFile = path.join(run.tmpDir, 'ae-save-' + runId + '.txt');
run.saveMarker = 'ae-save-' + runId;
run.saveA = 'AE_SAVE_A_' + runId;
run.saveB = 'AE_SAVE_B_' + runId;
// 键盘任务专用标签页：新开页天然带编辑焦点，不受「前台被抢再切回来」影响
run.kbFile = path.join(run.tmpDir, 'ae-kb-' + runId + '.txt');
run.kbMarker = 'ae-kb-' + runId;
// 恢复任务（3 条）的夹具文件与随机标记；标记带随机后缀，防「预写文件」式作弊。
// 每条任务用独立文件：A 用 a；B 用 b1/b2（part1/part2）；C 用 c。
// 不复用同一文件，否则前一条任务写进去的内容会变成后一条任务的初始状态（实测踩到）。
const recNonce = crypto.randomBytes(3).toString('hex');
run.recMarkers = {
  a: 'AE_REC_A_' + runId + '_' + recNonce,
  b1: 'AE_REC_B1_' + runId + '_' + recNonce,
  b2: 'AE_REC_B2_' + runId + '_' + recNonce,
  c: 'AE_REC_C_' + runId + '_' + recNonce,
};
run.rec = {
  a: path.join(run.tmpDir, run.recMarkers.a + '.txt'),
  b1: path.join(run.tmpDir, run.recMarkers.b1 + '.txt'),
  b2: path.join(run.tmpDir, run.recMarkers.b2 + '.txt'),
  c: path.join(run.tmpDir, run.recMarkers.c + '.txt'),
};
// 任务 C 的初始内容：CRLF 结尾（记事本原样保留），追加标记后应逐字节等于 init + marker。
run.recCInitial = 'AE_REC_INIT_' + runId + '\r\nsecond line\r\n';

function log(line) { console.log(line); }
function vlog(line) { if (VERBOSE) console.log(line); }

async function preflight() {
  try {
    const v = await evalPage('1+1', 3000);
    if (v !== 2) throw new Error('eval 返回异常：' + JSON.stringify(v));
  } catch (e) {
    return { ok: false, skip: true, reason: '8004 不通：' + String(e.message || e) };
  }
  try {
    const v = await evalPage("({ pm: !!window.pluginManager, exec: !!(window.pluginManager && window.pluginManager.executeTool) })", 3000);
    if (!v || !v.pm || !v.exec) return { ok: false, skip: false, reason: '8004 通了，但页面里没有 window.pluginManager.executeTool' };
    return { ok: true };
  } catch (e) {
    return { ok: false, skip: false, reason: '检查 pluginManager 失败：' + String(e.message || e) };
  }
}

async function runPhase(task, phase, budgetMs) {
  const expr = task[phase];
  if (!expr) return { ok: true, skipped: true, ms: 0, value: null };
  const t0 = Date.now();
  try {
    // cleanup 是维护动作：既不算被测行为（不触发熔断），也不吃谎报（必须真的收干净）
    const js = buildEval(task.id, expr, {
      maintenance: phase === 'cleanup',
      phase,
      token: task.id + ':' + phase + ':' + (++__phaseSeq),
    });
    const value = await withTimeout(evalPage(js, Math.max(1000, budgetMs - 200)), budgetMs, phase);
    return { ok: true, ms: Date.now() - t0, value: value === undefined ? null : value };
  } catch (e) {
    // 失败/超时：先取消页面里的残留脚本（否则它还会继续 sleep/重试/注入输入）。
    // 取消不会影响后续 phase —— 每个 phase 的 buildEval 会拿新 token。
    try { await abortPageEval(task.id + '/' + phase + ': ' + String((e && e.message) || e).slice(0, 80)); } catch (e2) { /* abort 自身失败不该改变本 phase 结论 */ }
    return { ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) };
  }
}

// 开局先清掉记事本里的「评测残留弹框」：
// 上一轮被打断（宿主重启/收尾超时）时，夹具标签页指向的临时文件已被删除，
// Notepad 会弹「系统找不到指定的路径」或「是否保留未保存的更改」——模态框会吃掉所有
// ctrl+w/SendInput，导致后面每条记事本任务都莫名其妙地红。
// 只认「文字里提到我们 .tmp / agent-eval 路径」的框，并且只点非破坏性按钮
//（保留更改/全部保留/取消/确定），不替用户做保存决定、不关任何标签页。
async function dismissEvalDialogs() {
  try {
    const js = buildEval('__dialogs__', `
      const snap = await call('see', { mode: 'tree', window: 'Notepad' });
      const els = (snap && snap.elements) || [];
      const names = els.map(e => String(e.name || ''));
      // 2026-11-20：上一轮崩溃留下的夹具标签页指向已删临时文件时，弹框常常只有
      // 「系统找不到指定的路径。」这一句，不带路径 → 原来的 /_probe|agent-eval/ 条件抓不到，
      // 而它会把 ctrl+w 全部吃掉。补一条：活动标签页本身是评测夹具（ae-…-fix / ae-kb-…）时也认。
      let msg = names.find(n => /是否保留未保存的更改|另一个应用对此文件的更改|系统找不到指定的路径|是否要将更改保存/.test(n)
        && /_probe|agent-eval/.test(n)) || '';
      if (!msg) {
        const errMsg = names.find(n => /^系统找不到指定的路径/.test(n)) || '';
        const ownTab = names.some(n => /^[*]?ae-[a-z0-9]+-[a-z0-9]+\.txt(\. 未修改。)?$/i.test(n))
          || names.some(n => /^[*]?ae-kb-[a-z0-9]+\.txt(\. 未修改。)?$/i.test(n));
        if (errMsg && ownTab) msg = errMsg;
      }
      if (!msg) return { ok: true, none: true, total: names.length };
      const safe = names.find(n => /^(保留更改|全部保留|取消|确定|OK)$/.test(n)) || '';
      let clicked = false;
      if (safe) {
        const i = names.indexOf(safe) + 1;
        const c = await call('act', { action: 'click', target: '#' + i, window: 'Notepad' });
        clicked = !!(c && c.ok);
        if (!clicked) {
          const c2 = await call('act', { action: 'click', target: '文字:' + safe, window: 'Notepad' });
          clicked = !!(c2 && c2.ok);
        }
      }
      return { ok: true, msg: msg.slice(0, 160), safe, clicked };
    `, { maintenance: true });
    return await evalPage(js, 15000);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 熔断/限速等待/恢复事件/调用序列的记录都在页面状态里；任务结束后取回来写进报告。
// 2026-11-20 审计 P2 #22：读失败必须与「页面真的没记录」区分开 ——
// 以前统一返回 null，预算断言被静默跳过（假绿），恢复任务又因 events=[] 被判红。
// 现在返回三态：{ok:true, trace} | {ok:false, error}；调用方把「读失败」记为未取证（null）。
async function readTaskTrace(taskId) {
  try {
    const id = JSON.stringify(taskId);
    const js = '(function(){ const R = window.__AGENT_EVAL__; if (!R) return { __trace: 1, __missing: true };'
      + ' const st = (R.nch || {})[' + id + '];'
      + ' return {'
      + '   __trace: 1,'
      + '   noChange: st && st.aborted ? st.aborted : null,'
      + '   waits: (R.waits || {})[' + id + '] || 0,'
      + '   counts: (R.counts || {})[' + id + '] || null,'
      + '   recovery: (R.recovery || {})[' + id + '] || null,'
      + '   seq: (R.seq || {})[' + id + '] || null'
      + ' }; })()';
    // 4s → 8s：任务刚结束时页面可能还在收尾；读不到就明确记「未取证」，不装成通过。
    const v = await evalPage(js, TRACE_TIMEOUT_MS);
    if (!v || typeof v !== 'object') return { ok: false, error: 'trace 读取返回空值' };
    if (v.__missing) return { ok: false, error: '页面状态 __AGENT_EVAL__ 不存在（宿主重启/页面 reload）' };
    return { ok: true, trace: v };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ── 严格判定纯函数（2026-11-20 审计 P2 #20/#22/#24）──────────────────────────
// #region eval-strict-pure
// 预算三态：true=在预算内；false=超预算；null=未取证（不能当通过，也不能当失败）。
function judgeBudget(task, traceRes) {
  const maxSteps = Number.isFinite(Number(task && task.maxSteps)) ? Number(task.maxSteps) : null;
  const maxWallMs = Number.isFinite(Number(task && task.maxWallMs)) ? Number(task.maxWallMs) : null;
  if (!maxSteps && !maxWallMs) {
    return { declared: false, ok: true, maxSteps: null, maxWallMs: null, runToolCalls: null };
  }
  if (!traceRes || traceRes.ok !== true) {
    return {
      declared: true, ok: null, maxSteps, maxWallMs, runToolCalls: null,
      reason: '未取证：' + String((traceRes && traceRes.error) || 'trace 不可用'),
    };
  }
  const counts = traceRes.trace && traceRes.trace.counts;
  // trace 取到了但 counts 里没有 run：页面确实一次 run 调用都没记 → 0 次（不是未取证）。
  const runCalls = counts && Number.isFinite(Number(counts.run)) ? Number(counts.run) : 0;
  return { declared: true, ok: !maxSteps || runCalls <= maxSteps, maxSteps, maxWallMs, runToolCalls: runCalls };
}

// 任务自报的 recover() 事件（保留作对照，不参与判定）。
function selfReportRecovery(task, traceRes) {
  const expected = String((task && task.expectedRecovery) || '');
  const events = traceRes && traceRes.ok === true && traceRes.trace && traceRes.trace.recovery
    && Array.isArray(traceRes.trace.recovery.events) ? traceRes.trace.recovery.events : [];
  const attempts = events.filter((e) => e.kind === 'attempt').length;
  const replans = events.filter((e) => e.kind === 'replan');
  const verifyReads = events.filter((e) => e.kind === 'verify_read');
  const retries = events.filter((e) => e.kind === 'retry');
  let ok = false;
  let why = '';
  if (!events.length) why = '没有 recovery 事件证据（任务没调用 recover()）';
  else if (expected === 'retry_in_place') {
    ok = attempts >= 2 && replans.length === 0;
    why = 'attempts=' + attempts + ' replans=' + replans.length + '（要求 ≥2 且 0）';
  } else if (expected === 'replan') {
    const want = Number.isFinite(Number(task.expectedReplanCount)) ? Number(task.expectedReplanCount) : 1;
    ok = replans.length === want;
    why = 'replans=' + replans.length + '（要求 ' + want + '）';
  } else if (expected === 'verify_before_retry') {
    const firstRead = events.findIndex((e) => e.kind === 'verify_read');
    const firstRetry = events.findIndex((e) => e.kind === 'retry');
    ok = firstRead >= 0 && (firstRetry < 0 || firstRead < firstRetry);
    why = 'verify_read@' + firstRead + ' retry@' + firstRetry + '（要求先读后重试，或不重试）';
  } else {
    why = '未知 expectedRecovery：' + expected;
  }
  return {
    expected, ok, attempts, replans: replans.length, verifyReads: verifyReads.length,
    retries: retries.length, events: events.map((e) => e.kind).slice(0, 40), why,
  };
}

// 从 runner 记录的调用序列观察恢复档位；ok=null 表示没有序列证据（不判绿也不判假红）。
function observeRecovery(task, traceRes) {
  const expected = String((task && task.expectedRecovery) || '');
  const selfReported = selfReportRecovery(task, traceRes);
  if (!traceRes || traceRes.ok !== true) {
    return {
      expected, ok: null, selfReported, observed: null,
      why: '未取证：' + String((traceRes && traceRes.error) || 'trace 不可用'),
    };
  }
  const seq = traceRes.trace && traceRes.trace.seq && Array.isArray(traceRes.trace.seq.events)
    ? traceRes.trace.seq.events : null;
  if (!seq) {
    return {
      expected, ok: null, selfReported, observed: null,
      why: '未取证：页面没有调用序列（旧状态/页面 reload）',
    };
  }
  const run = seq.filter((e) => e && e.phase === 'run');
  const tools = run.filter((e) => e && e.kind === 'tool');
  // fixture=true：typeOnce 的「补打」属于夹具归一，不是任务多试了一次。
  const types = tools.filter((e) => e.tool === 'act' && e.action === 'type' && !e.fixture);
  const allTypes = tools.filter((e) => e.tool === 'act' && e.action === 'type');
  const opens = run.filter((e) => e && e.kind === 'window_open');
  const attempts = types.length;
  const replans = opens.length;
  // 「可疑副作用」= 一个会改状态的动作返回了失败/超时（任务 C 注入的保存超时）。
  const MUT = new Set(['type', 'click', 'paste', 'set_value', 'key', 'hold', 'scroll', 'drag']);
  const suspectAt = run.findIndex((e) => e && e.kind === 'tool' && e.tool === 'act'
    && e.ok === false && MUT.has(String(e.action || '')));
  let verifyAfterSuspect = false;
  let retryBeforeVerify = false;
  if (suspectAt >= 0) {
    for (let i = suspectAt + 1; i < run.length; i += 1) {
      const e = run[i];
      if (!e || e.kind !== 'tool') continue;
      if (e.tool === 'file' && e.action === 'read') { verifyAfterSuspect = true; break; }
      if (e.tool === 'act' && MUT.has(String(e.action || ''))) retryBeforeVerify = true;
    }
  }
  const observed = {
    attempts,
    fixtureTypeCalls: allTypes.length - types.length,
    replans,
    typeCalls: allTypes.length,
    windowOpens: opens.length,
    suspectAt,
    verifyAfterSuspect,
    retryBeforeVerify,
    // 看不到的：动作内容是否等价、焦点/输入是否真的落在目标窗口（由 hostVerify 的磁盘 oracle 兜底）
    limitations: ['不比对新旧输入内容', '不判断焦点归属（hostVerify 已覆盖最终落盘）'],
  };
  let ok = false;
  let why = '';
  if (expected === 'retry_in_place') {
    ok = attempts >= 2 && replans === 0;
    why = 'observed type×' + attempts + ' window_open×' + replans + '（要求 type≥2 且重开窗=0）';
  } else if (expected === 'replan') {
    const want = Number.isFinite(Number(task.expectedReplanCount)) ? Number(task.expectedReplanCount) : 1;
    ok = replans === want && attempts >= 2;
    why = 'observed type×' + attempts + ' window_open×' + replans + '（要求重开窗=' + want + ' 且 type≥2）';
  } else if (expected === 'verify_before_retry') {
    ok = attempts === 1 && suspectAt >= 0 && verifyAfterSuspect && !retryBeforeVerify;
    why = 'observed type×' + attempts + ' suspect@' + suspectAt + ' verifyAfter=' + verifyAfterSuspect
      + ' retryBefore=' + retryBeforeVerify + '（要求 1 次输入、失败后先 file.read、之前不重试）';
  } else {
    // 配置错误不是「未取证」：写错的 expectedRecovery 必须像以前一样判红。
    ok = false;
    why = '未知 expectedRecovery：' + expected;
  }
  return { expected, ok, selfReported, observed, why };
}
// #endregion eval-strict-pure

function pageOk(phase) {
  return !!(phase && phase.ok && (!phase.value || phase.value.ok !== false));
}

async function runTask(task) {
  const t0 = Date.now();
  const rec = {
    id: task.id, title: task.title, ok: false, skipped: false, ms: 0, phases: {}, error: '', effect: null,
    outcome: null, runOk: false, verifyOk: false, expectedRecovery: task.expectedRecovery || null,
    attempts: null, replanTrace: null, errorKind: null, recovery: null, budget: null, runError: null,
  };
  // 深度跑会让多个任务分享「20 次/分钟」的严格闸，call() 会等待窗口滑过；
  // 这时单任务默认超时必须放宽，否则等待时间会被误判成任务卡死。
  const defaultTimeout = DEEP ? 60000 : (TASK_TIMEOUT_MS || 15000);
  const taskBudget = Number(task.maxWallMs) || Number(task.timeoutMs) || defaultTimeout;
  // setup 是**前置条件**（开窗口/等稳定），不是被测行为：
  //   ① 它拿独立预算（默认 45s），不再和 run/verify 抢同一个 deadline；
  //   ② run/verify 的测量预算从 setup 完成后才开始计。
  // 2026-11-21 根因修复：页面忙时 see(windows) 可能吃满整个任务预算，
  // 旧实现把「夹具没准备好」记成任务失败（深测 uia_click_calc 实测 setup 24.8s abort）。
  const setupBudget = Math.max(15000, Math.min(60000, Number(task.setupTimeoutMs) || 45000));
  let deadline = t0 + taskBudget;
  const remain = () => Math.max(800, deadline - Date.now());
  const ctx = {
    run,
    foreground,
    petWindows,
    pwshReadClipboard,
    pwshClearClipboard,
    checkBmp,
    unlinkQuiet,
  };

  vlog('  → ' + task.id + ' setup');
  rec.phases.setup = await runPhase(task, 'setup', setupBudget);
  // 测量预算（run/verify）从 setup 完成后才开始计；setup 再慢也不吃掉被测时间。
  deadline = Date.now() + taskBudget;

  if (pageOk(rec.phases.setup) && rec.phases.setup.value && rec.phases.setup.value.skip) {
    rec.skipped = true;
    rec.outcome = 'skip';
    rec.error = 'SKIP: ' + String(rec.phases.setup.value.reason || 'setup 要求跳过');
    rec.ms = Date.now() - t0;
    // 跳过的任务也跑 cleanup（通常无事可做）
    const c = await runPhase(task, 'cleanup', Math.max(3000, Math.min(6000, deadline - Date.now())));
    rec.phases.cleanup = c;
    return rec;
  }

  if (pageOk(rec.phases.setup)) {
    if (task.id === 'clipboard_roundtrip') {
      const v = rec.phases.setup.value || {};
      const n = Number(v.origLen);
      run.clipOriginalLen = Number.isFinite(n) ? n : null;
    }
    vlog('  → ' + task.id + ' run');
    rec.phases.run = await runPhase(task, 'run', remain());
    // 2026-11-20 恢复任务：run 失败也必须执行 verify/hostVerify。
    // 否则「没做」和「做了一半」在报告里长得一模一样，恢复类任务无法判定。
    // run 把 deadline 用光时，验证仍要有一份独立预算（读文件/读矩形很便宜）。
    const runPhaseOk = pageOk(rec.phases.run);
    const verifyBudget = runPhaseOk ? remain() : Math.max(8000, Math.min(20000, remain()));
    vlog('  → ' + task.id + ' verify' + (runPhaseOk ? '' : '（run 失败，仍取证）'));
    rec.phases.verify = await runPhase(task, 'verify', verifyBudget);
    // verify 阶段可以主动声明「环境干扰，无法验证」（例如用户正在操作把前台抢走）。
    // 这不是产品失败：记 SKIP 并说清原因，避免把用户行为记成回归。
    if (rec.phases.verify && rec.phases.verify.ok && rec.phases.verify.value && rec.phases.verify.value.skip) {
      rec.skipped = true;
      rec.outcome = 'skip';
      rec.error = 'SKIP: ' + String(rec.phases.verify.value.reason || '环境干扰，无法验证');
    }
    if (typeof task.hostVerify === 'function') {
      try {
        const hv = await task.hostVerify(rec, ctx);
        rec.phases.hostVerify = { ok: !!(hv && hv.ok), ms: 0, value: hv };
      } catch (e) {
        rec.phases.hostVerify = { ok: false, ms: 0, error: String((e && e.message) || e) };
      }
    }
  }

  // cleanup 永远跑：先给正常预算，超时后仍给至少 5s（关窗/删文件）
  // 收尾预算独立给足：run 把任务 deadline 用光时，cleanup 仍然要能关窗/删文件。
  // 上限给到 20s：撞上生产限速「20 次/分钟」时 call() 每轮等 5s，
  // 还原窗口要两次写动作，3 次等待就要 15s —— 12s 会把「该等的」错判成「卡死」。
  // 不跟任务 deadline 挂钩：run 超时后 deadline 已经是负数，收尾反而最需要时间还原现场。
  // 收尾预算独立给足（20000 → 25000）：实测 uia_click_calc 正常 17.8s、cleanup 偶发超 20s，
  // 而这段预算过去会被任务 deadline 挤掉。
  const cleanupBudget = rec.phases.setup.ok ? 25000 : 12000;
  vlog('  → ' + task.id + ' cleanup');
  rec.phases.cleanup = await runPhase(task, 'cleanup', cleanupBudget);
  if (typeof task.hostCleanup === 'function') {
    try {
      const hc = await task.hostCleanup(rec, ctx);
      rec.phases.hostCleanup = { ok: !!(hc && hc.ok), ms: 0, value: hc };
    } catch (e) {
      rec.phases.hostCleanup = { ok: false, ms: 0, error: String((e && e.message) || e) };
    }
  }

  // ── 判定矩阵：run × verify ────────────────────────────────────────────────
  //   run_ok     && verify_ok     → pass
  //   run_failed && verify_ok     → recovered（恢复任务的关键信号；未声明 expectedRecovery 的任务仍按旧语义判红）
  //   run_ok     && verify_failed → fail
  //   run_failed && verify_failed → fail
  // verify_ok 包含页面 verify 与 hostVerify（Node 读文件/矩形/前台，独立于工具返回值）。
  const setupOk = pageOk(rec.phases.setup);
  rec.runOk = pageOk(rec.phases.run);
  const hostVerifyPh = rec.phases.hostVerify;
  const hostVerifyOk = !hostVerifyPh || hostVerifyPh.ok;
  const verifyPageOk = pageOk(rec.phases.verify);
  rec.verifyOk = verifyPageOk && hostVerifyOk;
  const phaseErr = (phaseName) => {
    const ph = rec.phases[phaseName];
    if (!ph) return '未执行';
    if (ph.error) return ph.error;
    const v = ph.value;
    if (v && typeof v === 'object') return String(v.error || v.reason || JSON.stringify(v).slice(0, 300));
    return 'phase 失败';
  };
  if (!setupOk) rec.outcome = 'fail';
  else if (rec.runOk && rec.verifyOk) rec.outcome = 'pass';
  else if (!rec.runOk && rec.verifyOk) rec.outcome = 'recovered';
  else rec.outcome = 'fail';

  // 熔断/限速等待/恢复事件从页面取回来：报告里要有现场，不能只有一句 FAIL。
  // 2026-11-20 审计 P2 #22：traceRes 是三态 —— ok=false 时预算/恢复断言记「未取证」，
  // 既不判绿也不判假红；报告 summary 里有 unverified 计数与逐条原因。
  const traceRes = await readTaskTrace(task.id);
  const trace = traceRes.ok ? traceRes.trace : null;
  if (!traceRes.ok) rec.traceError = traceRes.error;
  if (trace && trace.noChange) {
    rec.effect = 'no-change';
    rec.noChange = trace.noChange;
  }
  if (trace && trace.waits) rec.quotaWaits = trace.waits;

  const events = trace && trace.recovery && Array.isArray(trace.recovery.events) ? trace.recovery.events : [];
  const runVal = (rec.phases.run && rec.phases.run.value) || {};
  const errClasses = events.filter((e) => e.kind === 'error_class' && e.errorKind);
  // errorKind 只认任务/事件显式声明的值，或 runner 自己抛出的两种机器可识别错误；
  // 不从错误文本里猜分类（没有就 null，不编）。
  const runErrText = String((rec.phases.run && (rec.phases.run.error || (rec.phases.run.value && rec.phases.run.value.error))) || '');
  rec.errorKind = runVal.errorKind
    || (errClasses.length ? errClasses[errClasses.length - 1].errorKind : null)
    || (/NO_CHANGE_ABORT/.test(runErrText) ? 'no_change' : null)
    || (/超时|timeout/i.test(runErrText) ? 'timeout' : null);

  // 恢复是否正确（2026-11-20 审计 P2 #24）：
  //   判定用 runner 从调用序列里 observed 出来的事实；任务自报的 recover() 只作对照。
  //   observed.ok=null → 未取证（不判绿、不判假红），不是 false。
  const recov = task.expectedRecovery ? observeRecovery(task, traceRes) : null;
  if (recov) {
    rec.recovery = {
      expected: recov.expected,
      ok: recov.ok,
      selfReported: recov.selfReported ? sanitize(recov.selfReported) : null,
      observed: recov.observed ? sanitize(recov.observed) : null,
      why: recov.why,
    };
  }
  const replans = events.filter((e) => e.kind === 'replan');
  rec.attempts = recov && recov.observed && Number.isFinite(Number(recov.observed.attempts))
    ? Number(recov.observed.attempts)
    : (recov && recov.selfReported && recov.selfReported.attempts
      ? recov.selfReported.attempts
      : (Number.isFinite(Number(runVal.attempts)) ? Number(runVal.attempts) : null));
  // 自报的 replan 轨迹保留在报告里（叙述用），判定不以它为准。
  rec.replanTrace = replans.length
    ? replans.map((e) => sanitize(e))
    : (Array.isArray(runVal.replanTrace) ? sanitize(runVal.replanTrace) : null);

  // 预算（2026-11-20 审计 P2 #20/#22）：maxSteps 只数 run 阶段的逻辑工具调用
  // （读回/保存也算，夹具轮询不算）；trace 读不到 → ok=null（未取证），不是 true。
  const budget = judgeBudget(task, traceRes);
  if (budget.declared) {
    rec.budget = {
      maxSteps: budget.maxSteps, maxWallMs: budget.maxWallMs,
      runToolCalls: budget.runToolCalls, ok: budget.ok,
      ...(budget.reason ? { reason: budget.reason } : {}),
    };
  }

  // 硬失败：只收「影响判定语义」的那些；cleanup 失败仍只算 warning（见 §79.6）。
  const hardFails = [];
  const unverifiedReasons = [];
  if (!setupOk) {
    hardFails.push('setup: ' + phaseErr('setup'));
  } else {
    if (rec.outcome === 'fail') {
      if (!rec.runOk) hardFails.push('run: ' + phaseErr('run'));
      if (!verifyPageOk) hardFails.push('verify: ' + phaseErr('verify'));
      else if (!hostVerifyOk) hardFails.push('hostVerify: ' + phaseErr('hostVerify'));
    }
    if (rec.outcome === 'recovered' && !task.expectedRecovery) {
      hardFails.push('run: ' + phaseErr('run') + '（verify 通过=recovered，但该任务未声明 expectedRecovery，按旧语义判红）');
    }
    if (rec.recovery && rec.recovery.ok === false) {
      hardFails.push('recovery: ' + rec.recovery.why);
    } else if (rec.recovery && rec.recovery.ok === null) {
      unverifiedReasons.push('recovery: ' + rec.recovery.why);
    }
    if (rec.budget && rec.budget.ok === false) {
      hardFails.push('budget: run 阶段工具调用 ' + rec.budget.runToolCalls + ' 次 > maxSteps ' + rec.budget.maxSteps);
    } else if (rec.budget && rec.budget.ok === null) {
      unverifiedReasons.push('budget: ' + rec.budget.reason);
    }
  }
  rec.ok = hardFails.length === 0 && (rec.outcome === 'pass' || rec.outcome === 'recovered');
  // 未取证只对「本来会判绿」的任务计数：已经判红的仍然是 fail，不能混进 unverified。
  rec.unverified = !!(rec.ok && unverifiedReasons.length);
  if (rec.unverified) rec.unverifiedReasons = unverifiedReasons;
  rec.error = hardFails.join(' | ');
  if (!rec.runOk) rec.runError = phaseErr('run').slice(0, 500);

  // cleanup 失败不影响本条判定，但要留原文（摘要打 ⚠）。
  const cleanupFails = [];
  for (const p of ['cleanup', 'hostCleanup']) {
    const ph = rec.phases[p];
    if (!ph) continue;
    if (!ph.ok) cleanupFails.push(p + ': ' + (ph.error || 'phase 失败'));
    else if (ph.value && ph.value.ok === false) cleanupFails.push(p + ': ' + String(ph.value.error || JSON.stringify(ph.value).slice(0, 200)));
  }
  if (cleanupFails.length) rec.cleanupWarning = cleanupFails.join(' | ');

  // 熔断已经让本任务失败；把原因放在最前面，别让后面的「verify 未执行」淹没它
  if (rec.effect === 'no-change' && rec.noChange) {
    rec.error = 'no-change: ' + rec.noChange.reason + (rec.error ? ' | ' + rec.error : '');
  }

  // 熔断自检任务：预期就是被熔断判红。判红 = 自检通过，判绿 = 熔断根本没响。
  if (task.expectNoChange) {
    rec.fuseOk = rec.effect === 'no-change';
    rec.ok = rec.fuseOk;
    rec.outcome = rec.fuseOk ? 'fuse_expected' : 'fail';
    rec.error = rec.fuseOk ? '' : ('熔断自检失败：没有触发 no-change（' + rec.error + '）');
  }

  rec.ms = Date.now() - t0;
  return rec;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[idx];
}

function shortVal(rec, phase, key) {
  const v = rec.phases[phase] && rec.phases[phase].value;
  if (!v || typeof v !== 'object') return '';
  return key ? (v[key] === undefined ? '' : String(v[key])) : '';
}

async function main() {
  log('电脑操控评测（真机）  runId=' + runId);
  log('  8004=' + BASE + '  任务数=' + selected.length + '  阈值=' + threshold + '  单任务超时=' + (DEEP ? 60000 : TASK_TIMEOUT_MS) + 'ms');
  log('  模式：' + [LIAR ? 'EVAL_LIAR（谎报注入）' : '正常', DEEP ? '深度任务' : '基线', STALL_TEST ? '熔断自检' : '', NO_CHANGE_N > 0 ? '熔断 N=' + NO_CHANGE_N : '熔断关闭'].filter(Boolean).join(' · '));

  const lock = acquireLock();
  if (!lock.ok) {
    log('');
    log('SKIP-LOCK  已有评测在跑（pid=' + ((lock.holder && lock.holder.pid) || '?') + '，起于 ' + ((lock.holder && lock.holder.startedAt) || '?') + '）');
    log('SKIP-LOCK  并发跑会互相覆盖 UIA 快照编号、互相开关对方的夹具标签页 —— 等它跑完再试');
    // 审计 P2 #21：并发锁冲突不是「任务跳过」，是「评测没跑」。exit 0 会让 check-all 记 PASS（假绿）；
    // 用非 0（3）让它显式变红/未验证。宿主没开的 SKIP 仍走 exit 0（桌宠没开不影响门禁）。
    process.exit(3);
  }
  if (lock.warn) log('  WARN  单实例锁写入失败（不阻塞）：' + lock.warn);

  const pf = await preflight();
  if (pf.skip) {
    const skipReport = {
      runId,
      startedAt: run.startedAt,
      endedAt: nowIso(),
      baseUrl: BASE,
      status: 'skip',
      skipReason: pf.reason,
      success: 0,
      total: 0,
      skipped: selected.length,
      successRate: null,
      tasks: [],
    };
    fs.writeFileSync(path.join(HERE, 'last-run.json'), JSON.stringify(skipReport, null, 2) + '\n');
    log('SKIP  ' + pf.reason);
    log('SKIP  电脑操控评测未执行（桌宠没开不影响门禁）');
    process.exit(0);
  }
  if (!pf.ok) {
    log('FAIL  ' + pf.reason);
    process.exit(1);
  }

  // ── 准备临时夹具 ────────────────────────────────────────────────────────
  fs.rmSync(run.tmpDir, { recursive: true, force: true });
  fs.mkdirSync(run.fileDir, { recursive: true });
  fs.writeFileSync(run.fixtureFile, run.textMarker + '\nsecond line\n', 'utf8');
  fs.writeFileSync(run.filePath, run.fileContent, 'utf8');
  fs.writeFileSync(run.saveFile, '', 'utf8');
  fs.writeFileSync(run.kbFile, '', 'utf8');
  // 恢复任务夹具：a/b1/b2 是空文件（记事本打开后从零写），c 有确定的初始内容（追加语义）。
  fs.writeFileSync(run.rec.a, '', 'utf8');
  fs.writeFileSync(run.rec.b1, '', 'utf8');
  fs.writeFileSync(run.rec.b2, '', 'utf8');
  fs.writeFileSync(run.rec.c, run.recCInitial, 'utf8');
  run.originalForeground = foreground();

  try {
    await evalPage('window.__AGENT_EVAL__ = ' + JSON.stringify({
      run: {
        runId: run.runId,
        marker: run.marker,
        textMarker: run.textMarker,
        clipMarker: run.clipMarker,
        tmpDir: run.tmpDir,
        fixtureFile: run.fixtureFile,
        fileDir: run.fileDir,
        filePath: run.filePath,
        fileContentLen: run.fileContentLen,
        saveFile: run.saveFile,
        saveMarker: run.saveMarker,
        saveA: run.saveA,
        saveB: run.saveB,
        kbFile: run.kbFile,
        kbMarker: run.kbMarker,
        rec: run.rec,
        recMarkers: run.recMarkers,
        recCInitial: run.recCInitial,
        petCore: PET_CORE,
        fixture: null,
        ownedCalc: null,
        originalForegroundHwnd: run.originalForeground ? String(run.originalForeground.hwnd) : '',
      },
      tasks: {},
      lastCallAt: 0,
      noChangeN: NO_CHANGE_N,
      nch: {},
      waits: {},
      counts: {},
      recovery: {},
      seq: {},
    }) + "; 'ok'", 5000);

    // 取消约定（2026-11-20 审计 P1）：runner 超时调用 abortPageEval → 这里置取消位。
    // 页面侧即使没有这个函数，__petEvalDisabled 也会让 buildEval 的 __guard 与
    // devtools 的输入注入闸停手。
    await evalPage(`(function(){
      window.__petEvalCtl = window.__petEvalCtl || { token: '', aborted: false, reason: null };
      window.__petEvalAbort = function (reason) {
        try {
          const c = window.__petEvalCtl;
          c.aborted = true;
          c.reason = String(reason || 'abort');
          c.token = '__aborted__';
          window.__petEvalDisabled = true;
        } catch (e) {}
      };
      return 'abort-ready';
    })()`, 3000);

    // 公共上下文：读写判定 + 熔断/谎报需要的容器。放在页面里只装一次。
    await evalPage(`(function(){
      const R = window.__AGENT_EVAL__;
      ${PAGE_MUTATING_CLASSIFIER}
      R.isMutating = __isMutating;
      return 'ready';
    })()`, 5000);

    // EVAL_LIAR：把「会改状态」的 executeTool 全部换成伪造的成功回执。
    // 只读动作照常放行 —— 伪造只读没有意义（只读本来就改不了世界），
    // 而 verify 读的正是独立状态，所以伪造写得再像也骗不过。
    if (LIAR) {
      await evalPage(`(function(){
        const R = window.__AGENT_EVAL__;
        R.liar = true;
        R.liarLog = [];
        R.liarWrap = function (orig) {
          return async function (name, params) {
            const p = params || {};
            if (!R.liarOff && R.isMutating(String(name), p)) {
              R.liarLog.push({
                tool: String(name),
                action: String(p.action || ''),
                target: String(p.window || p.name || p.target || ''),
              });
              if (R.liarLog.length > 300) R.liarLog.shift();
              return JSON.stringify({ ok: true, verified: true, effect: 'confirmed', action_sent: true, detail: '已执行' });
            }
            return orig(name, params);
          };
        };
        window.pluginManager.executeTool = R.liarWrap(window.pluginManager.executeTool.bind(window.pluginManager));
        return 'liar-installed';
      })()`, 5000);
      log('  ⚠ EVAL_LIAR=1：已注入谎报层（会改状态的动作一律返回伪造成功，只读动作放行）');
    }
    if (NO_CHANGE_N > 0) log('  熔断：连续 ' + NO_CHANGE_N + ' 个会改状态的动作指纹无变化 → 中止该任务');
  } catch (e) {
    log('FAIL  初始化页面状态失败：' + String(e.message || e));
    process.exit(1);
  }

  // 开夹具前先清掉上一轮留下的记事本启动器：否则 app-alias 可能选中无窗口的旧进程。
  {
    const stubs = killEvalNotepadStubs();
    if (stubs.killed && stubs.killed.length) {
      log('  清理：结束 ' + stubs.killed.length + ' 个残留记事本启动器（pid ' + stubs.killed.join(',') + '）');
    } else if (!stubs.ok) {
      log('  WARN  残留记事本启动器清理失败：' + stubs.error);
    }
  }

  // 开夹具前把上一轮残留的模态框点掉（否则 SendInput/ctrl+w 全被它吃掉）
  {
    const d = await dismissEvalDialogs();
    if (d && d.msg) log('  清理：点掉记事本残留弹框（' + (d.clicked ? '已点「' + d.safe + '」' : '没找到安全按钮') + '）：' + d.msg.replace(/\s+/g, ' ').slice(0, 120));
    else if (d && d.ok === false) log('  WARN  记事本残留弹框清理失败：' + d.error);
  }

  // 记事本夹具：win_alias_focus / window_move_size / uia_read_text / screenshot_nonblack /
  // list_windows_target 共用，由下面的全局收尾关闭（打字任务自己开新标签页，不碰它）。
  // --only 选了不需要记事本的任务时，不弹记事本（减少打扰）。
  if (!needFixture) {
    log('  夹具：本次选中的任务不需要记事本，跳过');
  } else {
    log('  夹具：打开记事本临时 txt …');
    const fx = await runPhase({ id: '__fixture__', setup: `const f = await openNotepad(S.fixtureFile); if (!f) throw new Error('记事本窗口没出现'); S.fixture = f; return f;` }, 'setup', 20000);
    if (fx.ok && fx.value) {
      run.fixture = fx.value;
      try {
        const f = await evalPage('window.__AGENT_EVAL__.run.fixture', 3000);
        log('  夹具窗口：' + (f && f.title) + '  hwnd=' + (f && f.hwnd) + ' pid=' + (f && f.pid));
      } catch (e) { /* ignore */ }
      // 不占用户屏幕（2026-11-21 用户要求）：夹具移到屏幕外。窗口仍「可见」——
      // WGC 按窗口抓图、UIA 读树、Invoke 点击都已实测可用（见 _probe/control-background-accept.cjs）。
      try {
        const mv = await evalPage(`(async () => {
          const r = await window.pluginManager.executeTool('app', { action: 'move', name: ${JSON.stringify(run.marker)}, x: ${OFFSCREEN_X}, y: 0 });
          return JSON.parse(r);
        })()`, 8000);
        log('  夹具移出屏幕：' + (mv && mv.ok ? 'ok' : '失败（' + ((mv && (mv.detail || mv.error)) || '未知') + '）'));
      } catch (e) { log('  夹具移出屏幕失败：' + String((e && e.message) || e).slice(0, 80)); }
    } else {
      log('  WARN  记事本夹具没起来：' + (fx.error || '未知') + '（依赖它的任务会失败）');
    }
    // 标签页已经在主窗口里了，启动器进程的使命结束。留着它会变成「无窗口 Notepad 进程」，
    // 让 app-alias（Get-Process notepad | Select -First 1）选到一个没有窗口的 pid。
    {
      const stubs = killEvalNotepadStubs();
      if (stubs.killed && stubs.killed.length) {
        log('  清理：结束 ' + stubs.killed.length + ' 个记事本启动器（pid ' + stubs.killed.join(',') + '）');
      }
    }
  }

  const results = [];
  for (const task of selected) {
    log('');
    log('▶ ' + task.id + '  ' + task.title);
    // --quiet：需要抢前台/占用户剪贴板的任务跳过（报告里记 SKIP，不伪装成通过）
    if (QUIET && QUIET_SKIP.has(task.id)) {
      const rec = {
        id: task.id, title: task.title, ok: true, skipped: true, outcome: 'skip', ms: 0,
        phases: {}, error: 'quiet 模式跳过（需要抢前台或占用用户剪贴板）', runOk: false, verifyOk: false,
      };
      results.push(rec);
      log('  SKIP    quiet：这条要抢前台/占剪贴板，不占你的屏幕');
      continue;
    }
    const rec = await runTask(task);
    results.push(rec);
    if (rec.skipped) {
      log('  SKIP  ' + msStr(rec.ms) + '  ' + rec.error);
    } else if (rec.ok) {
      const extra = [];
      if (rec.fuseOk) extra.push('熔断自检');
      if (rec.phases.run && rec.phases.run.value && rec.phases.run.value.via) extra.push('via=' + rec.phases.run.value.via);
      if (rec.phases.verify && rec.phases.verify.value && rec.phases.verify.value.display) extra.push('display=' + rec.phases.verify.value.display);
      if (shortVal(rec, 'run', 'count')) extra.push('windows=' + shortVal(rec, 'run', 'count'));
      if (shortVal(rec, 'verify', 'nonBlackRatio')) extra.push('nonBlack=' + shortVal(rec, 'verify', 'nonBlackRatio'));
      log('  PASS  ' + msStr(rec.ms) + (extra.length ? '  ' + extra.join(' ') : ''));
    } else {
      log('  FAIL  ' + msStr(rec.ms) + '  ' + rec.error.slice(0, 500));
      // 熔断要能一眼看出「它点了几次、每次指纹是什么」，否则报告等于没写
      if (rec.effect === 'no-change' && rec.noChange && Array.isArray(rec.noChange.actions)) {
        log('        熔断：' + rec.noChange.reason);
        for (const a of rec.noChange.actions) {
          log('          #' + a.n + ' ' + a.tool + ' ' + a.action + (a.target ? ' → ' + a.target : '') + '  ok=' + a.ok + '  fp=' + a.fp);
        }
      }
      if (rec.quotaWaits) log('        限速等待：' + rec.quotaWaits + ' 次 × 5s');
      if (VERBOSE) {
        for (const [name, ph] of Object.entries(rec.phases)) {
          log('        ' + name + ': ' + JSON.stringify(sanitize(ph)).slice(0, 600));
        }
      }
    }
  }

  // ── 全局兜底清理 ────────────────────────────────────────────────────────
  log('');
  log('收尾：');
  // 1) 共享记事本夹具标签页（任务都不负责关它，统一在这里关）
  if (run.fixture || true) {
    try {
      const c = await runPhase({ id: '__teardown__', cleanup: `return await closeNotepadTab(S.marker);` }, 'cleanup', 15000);
      if (c.ok && c.value && c.value.already) log('  记事本夹具：已不在（无需关）');
      else if (c.ok && c.value && c.value.ok) log('  记事本夹具：已关闭' + (c.value.prompt ? '（保存框点「' + c.value.prompt + '」）' : ''));
      else log('  WARN  记事本夹具兜底关闭未确认：' + (c.error || JSON.stringify(c.value)));
    } catch (e) {
      log('  WARN  记事本夹具兜底清理异常：' + String(e.message || e));
    }
  }
  // 1b) 记事本启动器：夹具关掉后它的使命就结束了；不退出会污染下一轮的 app-alias
  {
    const stubs = killEvalNotepadStubs();
    if (stubs.killed && stubs.killed.length) {
      log('  清理：结束 ' + stubs.killed.length + ' 个评测记事本启动器（pid ' + stubs.killed.join(',') + '）');
    }
  }
  // 2) 自己起的计算器（uia_click_calc / app_launch_calc / calc_chain 失败时兜底）
  try {
    const oc = await evalPage('window.__AGENT_EVAL__ && window.__AGENT_EVAL__.run.ownedCalc', 3000);
    if (oc && oc.hwnd) {
      const t = { id: '__teardown_calc__', cleanup: `const oc = S.ownedCalc; if (!oc) return { ok: true }; const r = await call('app', { action: 'close', name: String(oc.hwnd) }); await sleep(600); const ws = await winList(); const gone = !ws.some(w => String(w.hwnd) === String(oc.hwnd)); if (gone) S.ownedCalc = null; return { ok: !!(r && r.ok && gone), gone };` };
      const c = await runPhase(t, 'cleanup', 10000);
      log(c.ok ? '  计算器兜底：已关闭' : '  WARN  计算器兜底关闭未确认：' + (c.error || JSON.stringify(c.value)));
    }
  } catch (e) { /* ignore */ }

  // 3) 恢复原前台窗口（评测开始前用户在看谁）
  const of = run.originalForeground;
  if (of && of.hwnd) {
    const fg = foreground();
    if (fg && String(fg.hwnd) === String(of.hwnd)) {
      log('  前台：未变（' + of.title + '）');
    } else {
      try {
        // 恢复前台是收尾维护动作：谎报模式下也必须真的执行（maintenance 会关掉 liarWrap）
        const r = await evalPage(buildEval('__restore_fg__', `const r = await call('app', { action: 'focus', name: String(S.originalForegroundHwnd) }); return { ok: !!(r && r.ok), via: r && r.via };`, { maintenance: true }), 8000);
        const after = foreground();
        log(r && r.ok && after && String(after.hwnd) === String(of.hwnd)
          ? '  前台：已恢复到「' + of.title + '」'
          : '  WARN  前台恢复未确认（当前「' + (after && after.title) + '」）');
      } catch (e) {
        log('  WARN  前台恢复失败：' + String(e.message || e));
      }
    }
  }

  // 4) 临时目录
  if (KEEP_TMP) log('  临时目录保留：' + run.tmpDir);
  else {
    try { fs.rmSync(run.tmpDir, { recursive: true, force: true }); } catch (e) { log('  WARN  临时目录删除失败：' + e.message); }
  }

  // ── 谎报层现场（EVAL_LIAR 才有）：报告要能看出「伪造了多少次、伪造了什么」──
  let liarInfo = null;
  if (LIAR) {
    try {
      const lg = await evalPage('(window.__AGENT_EVAL__ && window.__AGENT_EVAL__.liarLog) || []', 4000);
      if (Array.isArray(lg)) {
        liarInfo = { enabled: true, faked: lg.length, minFail: LIAR_MIN_FAIL, sample: sanitize(lg.slice(-20)) };
        log('');
        log('谎报层：共伪造 ' + lg.length + ' 次会改状态的动作（只读动作全部放行）');
        const byTool = {};
        for (const x of lg) byTool[x.tool + ':' + x.action] = (byTool[x.tool + ':' + x.action] || 0) + 1;
        log('        分布：' + Object.entries(byTool).map(([k, n]) => k + '×' + n).join('  '));
      }
    } catch (e) { /* ignore */ }
  }

  // ── 统计 ────────────────────────────────────────────────────────────────
  const executed = results.filter((r) => !r.skipped);
  const success = executed.filter((r) => r.ok).length;
  const total = executed.length;
  const skipped = results.length - total;
  const failCount = total - success;
  const rate = total ? success / total : 0;
  const times = executed.map((r) => r.ms);
  const p50 = Math.round(percentile(times, 50));
  const p95 = Math.round(percentile(times, 95));
  const totalMs = Date.now() - Date.parse(run.startedAt);
  const noChangeCount = executed.filter((r) => r.effect === 'no-change').length;
  // 未取证：本来会判绿、但预算/恢复断言因 trace 读失败而无法评估的条数。
  const unverifiedCount = executed.filter((r) => r.unverified).length;

  const report = {
    runId,
    startedAt: run.startedAt,
    endedAt: nowIso(),
    baseUrl: BASE,
    status: 'done',
    mode: {
      liar: LIAR,
      deep: DEEP,
      noChangeN: NO_CHANGE_N,
      stallTest: STALL_TEST,
      selected: selected.map((t) => t.id),
    },
    threshold,
    liar: liarInfo,
    success,
    total,
    skipped,
    fail: failCount,
    noChange: noChangeCount,
    unverified: unverifiedCount,
    successRate: Number(rate.toFixed(4)),
    p50ms: p50,
    p95ms: p95,
    durationMs: totalMs,
    tasks: results.map((r) => ({
      id: r.id,
      title: r.title,
      ok: r.ok,
      skipped: r.skipped,
      outcome: r.outcome,
      runOk: r.runOk,
      verifyOk: r.verifyOk,
      ms: r.ms,
      error: r.error,
      runError: r.runError || null,
      effect: r.effect,
      fuseOk: r.fuseOk || false,
      quotaWaits: r.quotaWaits || 0,
      cleanupWarning: r.cleanupWarning || null,
      // 恢复任务：期望的恢复档位 / 实际 attempts / 重规划轨迹 / 错误分类 / 预算
      expectedRecovery: r.expectedRecovery || null,
      attempts: r.attempts,
      replanTrace: r.replanTrace ? sanitize(r.replanTrace) : null,
      errorKind: r.errorKind,
      recovery: r.recovery ? sanitize(r.recovery) : null,
      budget: r.budget ? sanitize(r.budget) : null,
      // #22：trace 读失败 → 预算/恢复未取证（不判绿）；原因见 unverifiedReasons
      unverified: !!r.unverified,
      unverifiedReasons: r.unverifiedReasons || null,
      traceError: r.traceError || null,
      // 熔断时要能复盘「它到底点了几次」；正常任务这条是 null
      noChange: r.noChange ? sanitize(r.noChange) : null,
      phases: sanitize(r.phases),
    })),
  };
  fs.writeFileSync(path.join(HERE, 'last-run.json'), JSON.stringify(report, null, 2) + '\n');

  log('');
  log('── 电脑操控评测汇总 ────────────────────────────────');
  for (const r of results) {
    const flag = r.skipped ? 'SKIP'
      : (r.ok ? (r.outcome === 'recovered' ? 'RECOVER' : 'PASS') : 'FAIL');
    const extra = (r.effect === 'no-change' ? '  [effect=no-change]' : (r.fuseOk ? '  [熔断自检]' : ''))
      + (r.outcome === 'recovered' ? '  [recovered:' + (r.expectedRecovery || '未声明') + ']' : '')
      + (r.attempts !== null && r.attempts !== undefined ? '  attempts=' + r.attempts : '')
      + (r.recovery && r.recovery.observed && r.recovery.observed.replans ? '  replans=' + r.recovery.observed.replans : '')
      + (r.unverified ? '  [未取证: ' + (r.unverifiedReasons || []).join(' | ').slice(0, 160) + ']' : '')
      + (r.cleanupWarning ? '  ⚠清理未完成（不影响本条判定，详见报告）' : '');
    log(flag + '  ' + msStr(r.ms) + '  ' + r.id + extra + (r.error ? '  — ' + r.error.slice(0, 220) : ''));
  }
  log('────────────────────────────────────────────────────');
  log('PASS ' + success + ' / FAIL ' + failCount + (skipped ? ' / SKIP ' + skipped : ''));
  log('unverified=' + unverifiedCount
    + (unverifiedCount
      ? '（本来会判绿，但 trace 未取到 → 预算/恢复断言未验证，见 last-run.json 的 unverifiedReasons）'
      : '（预算/恢复断言全部有证据）'));
  log('成功率 ' + (total ? (rate * 100).toFixed(1) + '%' : 'n/a') + '（' + success + '/' + total + '）  p50=' + p50 + 'ms  p95=' + p95 + 'ms  总耗时=' + (totalMs / 1000).toFixed(1) + 's');
  if (noChangeCount) log('熔断中止 ' + noChangeCount + ' 条（effect=no-change，动作序列见报告）');
  log('基线报告：' + path.join(HERE, 'last-run.json'));

  // ── 退出码 ──────────────────────────────────────────────────────────────
  // EVAL_LIAR 是「oracle 能不能抓谎报」的自检：这里故意把成功当失败。
  // 判据不是成功率，而是「至少 LIAR_MIN_FAIL 条被判红」——全绿才说明评测在假绿。
  if (LIAR) {
    log('');
    log('谎报注入自检：FAIL ' + failCount + ' 条，至少需要 ' + LIAR_MIN_FAIL + ' 条');
    const failedIds = executed.filter((r) => !r.ok).map((r) => r.id);
    log('被判红：' + (failedIds.join(', ') || '(无)'));
    if (failCount < LIAR_MIN_FAIL) {
      log('❌ 谎报注入没有被 oracle 抓住：伪造成功骗过了评测（假绿）');
      process.exit(1);
    }
    log('✅ 谎报注入自检通过：假成功骗不过 verify（它读的是独立状态）');
    process.exit(0);
  }

  if (total > 0 && rate < threshold) {
    log('❌ 成功率低于阈值 ' + threshold + '：' + (rate * 100).toFixed(1) + '%');
    process.exit(1);
  }
  // #22：未取证不是失败（不直接红），但必须发声；若同时有 fail，则随失败一起判红。
  if (unverifiedCount > 0) {
    log('');
    log('⚠ 未取证 ' + unverifiedCount + ' 条：预算/恢复断言没有 trace 证据（不等于通过）');
    for (const r of executed.filter((x) => x.unverified)) {
      log('  - ' + r.id + '：' + (r.unverifiedReasons || []).join(' | ').slice(0, 240));
    }
    if (failCount > 0) {
      log('❌ 未取证与失败并存（FAIL ' + failCount + ' 条），判红');
      process.exit(1);
    }
    log('（未取证不单独判红；修复 trace 读取后重跑可清零）');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('runner 自身异常：' + (e && e.stack || e));
  process.exit(1);
});
