/**
 * js/core/game-loop.js — 纯视觉游戏操作闭环（2026-11-14 四十九轮续）
 *
 * 分层（LLM 不在实时回路里）：
 *   L1 感知：pet-core 常驻抓帧（1.8ms）+ game_detector.py 常驻检测（1ms）
 *   L2 决策：本文件的规则表（纯算术，<1ms）
 *   L0 执行：pet-core 的 mouse/keys（1-3ms）
 *   L3 规划：模型通过 game 工具下发 intent（秒级，改一次管几秒）
 *
 * 实测：抓帧 1.8ms / 检测 1ms / 端到端 state() 约 6ms（含写盘）
 *
 * 为什么检测器要常驻：`import cv2` 一次 ~750ms，新进程 = 每秒最多 1 次检测。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { getClient: getCoreClient } = require('./pet-core-client.js');
const { createFactStore } = require('./fact-store.js');
const { createModProvider } = require('./mod-provider.js');

// ── 常驻 Python 检测器 ────────────────────────────────────────────────────
let _det = null;          // { child, busy, queue, buf, ready }
let _detScript = '';

function resolveDetector() {
  if (_detScript) return _detScript;
  let dir = path.resolve(__dirname);
  for (let i = 0; i < 10; i += 1) {
    const cand = path.join(dir, 'pet-runtime', 'tools', 'game_detector.py');
    try { if (fs.existsSync(cand)) { _detScript = cand; return cand; } } catch (e) { /* 跳过错过的目录 */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  _detScript = '';
  return '';
}

function resolvePythonBin() {
  try {
    // 复用项目统一的 Python 解析（排除 WindowsApps 占位符）
    const { resolvePython } = require('./runtime-paths.js');
    return resolvePython() || '';
  } catch (e) {
    return '';
  }
}

function ensureDetector() {
  if (_det && _det.child && !_det.child.killed) return _det;
  const script = resolveDetector();
  const py = resolvePythonBin();
  if (!script || !py) return null;
  // ⚠ 必须 -u：Python 的 stdout 在管道里是块缓冲，不加会把响应压着不发（实测卡死）
  const child = spawn(py, ['-u', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { child, buf: '', queue: [], inflight: null, stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    state.buf += d;
    let idx;
    while ((idx = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, idx).trim();
      state.buf = state.buf.slice(idx + 1);
      if (!line) continue;
      const job = state.inflight;
      state.inflight = null;
      if (job) {
        if (job.timer) clearTimeout(job.timer);
        let v;
        try { v = JSON.parse(line); } catch (e) { v = { ok: false, error: 'detector 响应不是 JSON：' + line.slice(0, 120) }; }
        job.resolve(v);
      }
      pumpDetector(state);
    }
  });
  child.stderr.on('data', (d) => { state.stderr = (state.stderr + d).slice(-600); });
  // 2026-11-14 五十三轮（审计）：spawn 失败（找不到解释器 / 权限）走的是**异步 error 事件**，
  // 原来没有监听 → 未捕获的 stream error 可能直接带崩 JS 进程。
  // stdin 的 EPIPE 同理（子进程刚死时 write 会异步报错）。
  const failDetector = (why) => {
    if (_det === state) _det = null;
    const msg = '检测器不可用：' + why;
    if (state.inflight) {
      if (state.inflight.timer) clearTimeout(state.inflight.timer);
      state.inflight.resolve({ ok: false, error: msg });
      state.inflight = null;
    }
    for (const j of state.queue.splice(0)) j.resolve({ ok: false, error: msg });
  };
  child.on('error', (e) => failDetector('spawn 失败（' + (e && e.message || e) + '）'));
  try { child.stdin.on('error', (e) => failDetector('stdin 断开（' + (e && e.message || e) + '）')); } catch (e) { /* 没有 stdin */ }
  child.on('exit', (code) => {
    if (_det === state) _det = null;
    const msg = '检测器退出（code=' + code + '）' + (state.stderr ? '：' + state.stderr.slice(0, 200) : '');
    if (state.inflight) {
      if (state.inflight.timer) clearTimeout(state.inflight.timer);
      state.inflight.resolve({ ok: false, error: msg });
      state.inflight = null;
    }
    for (const j of state.queue.splice(0)) j.resolve({ ok: false, error: msg });
  });
  _det = state;
  return state;
}

function pumpDetector(state) {
  if (state.inflight || !state.queue.length) return;
  if (!state.child || state.child.killed) return;
  const job = state.queue.shift();
  state.inflight = job;
  job.timer = setTimeout(() => {
    // 超时：重启检测器（管道里可能堆了半截响应）
    state.inflight = null;
    job.resolve({ ok: false, error: '检测器超时（已重启）' });
    try { state.child.kill(); } catch (e) { /* 已死 */ }
  }, 5000);
  try {
    state.child.stdin.write(JSON.stringify(job.req) + '\n');
  } catch (e) {
    if (job.timer) clearTimeout(job.timer);
    state.inflight = null;
    job.resolve({ ok: false, error: '写检测器 stdin 失败：' + (e && e.message || e) });
  }
}

function detectorCall(req) {
  const state = ensureDetector();
  if (!state) return Promise.resolve({ ok: false, error: '检测器不可用（game_detector.py 或 Python 找不到）' });
  return new Promise((resolve) => {
    state.queue.push({ req, resolve, timer: null });
    pumpDetector(state);
  });
}

// ── profile 加载 ─────────────────────────────────────────────────────────
/** profile 目录（换游戏只换这里的 JSON） */
function profilesDir() {
  let dir = path.resolve(__dirname);
  for (let i = 0; i < 10; i += 1) {
    const cand = path.join(dir, 'pet-runtime', 'data', 'game-profiles');
    try { if (fs.existsSync(cand)) return cand; } catch (e) { /* 继续向上 */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return '';
}

/**
 * 按名字加载 profile（'minecraft' 会匹配 minecraft-1.21.1.json）。
 * 返回 null 表示没找到 —— 调用方要如实报错，不要用默认值硬跑。
 */
function loadProfile(name) {
  const dir = profilesDir();
  if (!dir || !name) return null;
  const want = String(name).toLowerCase();
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const exact = files.find((f) => f.toLowerCase() === want + '.json');
    const pick = exact || files.find((f) => f.toLowerCase().includes(want));
    if (!pick) return null;
    const obj = JSON.parse(fs.readFileSync(path.join(dir, pick), 'utf8'));
    obj._file = pick;
    obj._dir = path.join(dir, pick.replace(/\.json$/i, ''));   // 场景模板的相对路径以 <profiles>/<profile>/ 为基准
    return obj;
  } catch (e) {
    return null;
  }
}

/** 列出可用 profile */
function listProfiles() {
  const dir = profilesDir();
  if (!dir) return [];
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          return { file: f, game: o.game || f, window: o.window || '' };
        } catch (e) { return { file: f, game: '', window: '', error: '解析失败' }; }
      });
  } catch (e) {
    return [];
  }
}

// ── 状态 ─────────────────────────────────────────────────────────────────
async function coreCall(req, timeoutMs) {
  const cli = getCoreClient({ startDir: __dirname, timeoutMs: 8000 });
  if (!cli.bin) return { ok: false, error: 'pet-core 不可用' };
  return cli.call(req, timeoutMs || 8000);
}

// ── 可见反馈：她在游戏里干了什么（2026-11-14 五十三轮）────────────────────
// 用户要「两个光标」：真实鼠标归他，她的操作要有自己的可见指示。
// 游戏里没有自由光标（准星锁定），所以这里的指示是：
//   · 攻击 → 在敌人位置画她的橙色虚拟光标 + 「攻击」标签
//   · 按键 → 在游戏窗口左上角飘一行「按 s / 按住 w」
// overlay 在主进程，`setContentProtection` 保证它不会进我们自己的 WGC 抓帧。
function notifyOverlay(payload) {
  try {
    const { ipcRenderer } = require('electron');
    if (ipcRenderer && typeof ipcRenderer.send === 'function') ipcRenderer.send('pet:overlay', payload);
  } catch (e) { /* 非 Electron 渲染进程（探针/单测）—— 静默跳过是正常的 */ }
}
function hideGameCursor() {
  try {
    const { ipcRenderer } = require('electron');
    if (ipcRenderer && typeof ipcRenderer.send === 'function') ipcRenderer.send('pet:overlay', { cursor: null });
  } catch (e) { /* 同上 */ }
}

// 游戏窗口矩形（30s 缓存）：把「画面比例坐标」换算成屏幕物理像素
let _winRect = { key: '', rect: null, at: 0 };
async function gameWindowRect(profile) {
  const key = String((profile && (profile.window || profile.hwnd)) || '');
  const hwnd = Number(profile && profile.hwnd) || 0;
  const now = Date.now();
  if (_winRect.key === key && _winRect.rect && now - _winRect.at < 30000) return _winRect.rect;
  try {
    // hwnd 优先（profile 可以直接给句柄）；否则按标题子串找
    const r = await coreCall({ cmd: 'windows', filter: hwnd ? '' : key, max: 60 }, 2500);
    const w = (r && r.windows || []).find((x) => x && !x.iconic && Number.isFinite(x.x) && Number.isFinite(x.w)
      && (hwnd ? Number(x.hwnd) === hwnd : String(x.title || '').toLowerCase().includes(key.toLowerCase())));
    if (w) {
      _winRect = { key, rect: { x: w.x, y: w.y, w: w.w, h: w.h }, at: now };
      return _winRect.rect;
    }
  } catch (e) { /* 读不到窗口就退回「不画光标」而不是画错地方 */ }
  return null;
}

// 状态事实表（2026-11-14 五十三轮 · 多通道地基）。
//
// 现在只有 vision 一家在写；等 Mod/API 通道接进来，它们会写**同样的 fact**，
// 仲裁按「置信度 × 新鲜度 × 来源优先级」自动选值 —— 上层代码不用改。
// 每条事实的 ttl 就是它能容忍的年龄：敌人位置 120ms、血量 500ms、场景 400ms。
const _facts = createFactStore();
_facts.configure({
  'player.hp': { ttlMs: 500 },
  'player.hud': { ttlMs: 400 },
  scene: { ttlMs: 400 },
  'enemy.cx': { ttlMs: 120 },
  'enemy.cy': { ttlMs: 120 },
  'enemy.frames': { ttlMs: 120 },
});

/**
 * HUD 闸解析（2026-11-14 五十三轮 · 多通道）：**精确来源优先**。
 *
 * 视觉读血条会被状态效果干扰（中毒/凋灵/吸收/冰冻）—— 以前的做法是「读不到就暂停」，
 * 那是安全的但会误伤：明明 Mod 有精确血量，却因为像素读不出来就不敢动。
 * 规则：
 *   · mod/api 给了**新鲜**的 player.hp → 以它为准（hpValid=true，hpSource='mod'）
 *   · 否则退回视觉（hpValidFinal）
 *   · 都没配 → 按 requireHp 政策（老 profile 行为不变）
 * @pure 便于单测
 */
function resolveHudGate(opts) {
  const o = opts || {};
  const hpConfigured = o.hpConfigured === true;
  const requireHp = o.requireHp !== false;
  const modHp = o.modHp || null;
  // ⚠ 2026-11-14 审计：① `typeof NaN === 'number'` 会放行 NaN；② 两源差 60% 时也照样放行。
  //   现在：必须有限数、不能有冲突、且不能是已经被标记 distrust 的来源。
  const modFresh = !!(modHp
    && !modHp.stale
    && !modHp.conflict
    && (modHp.source === 'mod' || modHp.source === 'api')
    && Number.isFinite(modHp.value));
  if (modFresh) return { hpValid: true, hpSource: modHp.source };
  if (modHp && modHp.conflict) return { hpValid: false, hpSource: 'conflict' };
  if (hpConfigured) return { hpValid: o.hpValidFinal === true, hpSource: 'vision' };
  return { hpValid: !requireHp, hpSource: 'none' };
}

// 状态源总开关 + 来源↔事实绑定（2026-11-14 审计）
//   profile.state.enabled === false  → 一键回滚：不写事实、不起 Mod 通道，行为退回「只有视觉」
//   profile.state.factSources        → 限定某条事实只能由谁写（scene 只允许 vision，
//                                      这样被投毒的 mod 无法把安全闸打开）
let _factPolicyApplied = '';
function applyFactPolicy(profile) {
  const key = String((profile && (profile._file || profile.game)) || '');
  if (key === _factPolicyApplied) return;
  _factPolicyApplied = key;
  const cfg = (profile && profile.state && profile.state.factSources) || null;
  if (!cfg) return;
  const converted = {};
  for (const [fact, sources] of Object.entries(cfg)) {
    if (Array.isArray(sources)) converted[fact] = { sources: sources.slice() };
  }
  try { _facts.configure(converted); } catch (e) { console.warn('[facts] factSources 配置失败：' + (e && e.message || e)); }
}

// Mod 通道（进程内观测）：profile 里 state.sources.mod.enabled 才起，连不上也不影响视觉
let _mod = null;
function ensureModProvider(profile) {
  const cfg = profile && profile.state && profile.state.sources && profile.state.sources.mod;
  if (!cfg || cfg.enabled === false) return null;
  if (_mod) return _mod;
  try {
    _mod = createModProvider({
      facts: _facts,
      port: Number(cfg.port) || undefined,
      log: (m) => { try { console.log(m); } catch (e) { /* 无 console 的宿主 */ } },
    });
    // ⚠ 2026-11-14 审计：start() 失败后原来仍把 _mod 缓存住 → 这一局**永不重试**
    //   （端口后来释放了也不会连）。现在失败就丢掉，下次 state() 再来一次。
    _mod.start().then((ok) => {
      if (!ok) {
        console.warn('[mod] 通道启动失败（端口占用？），下次会重试 —— 视觉继续顶着');
        if (_mod) { try { _mod.stop(); } catch (e) { /* 已停 */ } }
        _mod = null;
      }
    }).catch(() => {
      if (_mod) { try { _mod.stop(); } catch (e) { /* 已停 */ } }
      _mod = null;
    });
    return _mod;
  } catch (e) {
    console.warn('[mod] 启动失败：' + (e && e.message || e));
    return null;
  }
}

// 场景分类缓存（2026-11-14 五十三轮 P0）：250ms 一次。
// 模板匹配 30-60ms，每帧做会把 20fps 拖垮；250ms 足够拦住「按 E 开背包」这种状态变化。
const _scene = { at: 0, name: 'game', matched: null, score: 0, blocking: false, configured: false };

/**
 * 看一帧并检测（L1）。profile 形态见 docs/设计-纯视觉游戏操作框架-2026-11-14.md。
 * 返回 { ok, w, h, bars, gray, colors, scene, ms:{grab,detect,total} }
 */
async function state(profile, opts) {
  const t0 = Date.now();
  const target = profile && (profile.window || profile.hwnd);
  if (!target) return { ok: false, error: 'profile 缺 window' };
  // 帧文件按消费者分槽（2026-11-14 五十三轮）：自动循环写 loop 槽、
  // 模型「看一眼」写 see 槽 —— 两者并发时不再互相覆盖帧。
  const slot = String((opts && opts.slot) || 'default');
  const f = await coreCall({ cmd: 'game_frame', target: String(target), maxWaitMs: 1200, slot }, 5000);
  if (!f.ok) return { ok: false, error: '抓帧失败：' + (f.error || '未知') };
  const scenesCfg = (profile && profile.detect && profile.detect.scenes) || null;
  const wantScene = !!(scenesCfg && Date.now() - _scene.at >= 250);
  const d = await detectorCall({
    path: f.path, w: f.width, h: f.height,
    bars: (profile.detect && profile.detect.bars) || {},
    gray: (profile.detect && profile.detect.gray) || {},
    colors: (profile.detect && profile.detect.colors) || {},
    motion: (profile.detect && profile.detect.motion) || {},
    // GUI 面板检测（背包/箱子/菜单/加载）：画面中心是平的 → std 小
    gui: (profile.detect && profile.detect.gui) || { roi: [0.25, 0.2, 0.5, 0.6] },
    // 场景分类（P0）：只在配了 scenes 时开；**节流到 250ms 一次**，
    // 模板匹配是 30-60ms 级的，每帧做会把 20fps 拖垮。
    ...(wantScene ? { scenes: scenesCfg, sceneBase: String((profile && profile._dir) || '') } : {}),
  });
  if (!d.ok) return { ok: false, error: '检测失败：' + (d.error || '未知'), w: f.width, h: f.height };
  if (d.scene) {
    // ⚠ 检测器返回的字段叫 `scene`，而缓存/返回值用的是 `name` —— 直接 Object.assign
    //   会把 scene 写成一个没人读的键，name 永远停在 'game'（实测：blocking=true 但
    //   scene='game'，闸报「场景不对（game）」）。所以显式对齐。
    Object.assign(_scene, d.scene, {
      at: Date.now(), configured: true,
      name: String(d.scene.scene || 'game'),
    });
    // 模板读不出来要吼一声 —— 否则「场景永远 game」看起来像没配，而不是配置坏了
    if (Array.isArray(d.scene.missing) && d.scene.missing.length) {
      const miss = d.scene.missing.join(',');
      if (_scene.lastMissing !== miss) {
        _scene.lastMissing = miss;
        console.warn('[game] 场景模板读不出来（路径/格式问题）：' + miss);
      }
    }
  } else if (!scenesCfg) {
    // 没配场景分类的 profile：不算「拦住」，保持向后兼容（老 profile 行为不变）
    Object.assign(_scene, { name: 'game', matched: null, score: 0, blocking: false, configured: false });
  }
  // 基线归一化（2026-11-14 真机实测）：MC 的血条是 10 颗分离心形，心形之间的
  // 间隙占列 → 满血读数不是 1.0（实测 0.8855）。profile 里记下满血读数当基准，
  // 这里除一下 —— 规则阈值就能用「真的百分比」（hp<0.35 = 真的 35%）。
  // hp 现在是 {value, valid, reason}（2026-11-14 审计）：
  // 「检测不到红心」和「血真的空了」必须能区分 —— 前者是 HUD 不在（菜单/加载/创造/F1），
  // 上层要据此暂停，而不是当成濒死一直按后退。
  // HUD 条名（默认 hp）—— 换游戏只换 profile：`safety.hud` 指到 detect.bars 里的哪个键，
  // 规则里就写哪个名字（如 "stamina < 0.2"）。不再把 "hp" 焊死在框架里。
  const hudName = String((profile && profile.safety && profile.safety.hud) || 'hp');
  const base = Number(profile && (profile._baseline || profile._hp_baseline));
  const hpRaw = d.bars && d.bars[hudName];
  const hpValid = !!(hpRaw && hpRaw.valid !== false);
  const hpVal = hpRaw && typeof hpRaw === 'object' ? hpRaw.value : hpRaw;
  // 「这个 profile 到底有没有配 HUD 检测」——和「配了但这一帧读不到」是两件事。
  //   · 没配（比如解谜类游戏没有血条）+ 明确写 safety.requireHp=false → 放行（无 HUD 需求）
  //   · 没配 + 没写 → **不放行**（fail-closed：没闸就不许自动操作，这是审计定的原则）
  //   · 配了但这一帧读不到（菜单/加载/创造/F1）→ 不放行（本来就是闸要拦的情况）
  const hpConfigured = !!(profile && profile.detect && profile.detect.bars && profile.detect.bars[hudName]);
  const requireHp = !(profile && profile.safety && profile.safety.requireHp === false);
  if (d.bars) {
    if (base > 0.05 && base <= 1.01 && hpValid && Number.isFinite(hpVal)) {
      d.bars[hudName] = { value: Math.round(Math.min(1, hpVal / base) * 10000) / 10000, valid: true, raw: hpRaw.raw };
    } else {
      d.bars[hudName] = { value: 0, valid: false, reason: (hpRaw && hpRaw.reason) || 'no-bar' };
    }
  }
  // ⚠ 2026-11-14 五十三轮（审计致命项）：这里必须用**归一化之后**的 valid。
  //   原来用的是归一化前的 `hpValid` —— profile 缺基线时上面已把这一条标成 valid:false，
  //   但返回的顶层 hpValid 还是 true → 安全闸②被绕过，同时所有 hp 规则拿到 value:0。
  const hpValidFinal = !!(d.bars && d.bars[hudName] && d.bars[hudName].valid === true);
  // 状态源总开关（一键回滚）：关掉就是「只有视觉」，与接入多通道前完全一致
  const stateEnabled = !(profile && profile.state && profile.state.enabled === false);
  if (stateEnabled) applyFactPolicy(profile);
  // Mod 通道（如果 profile 配了）：先起，再让 HUD 闸按「精确来源优先」解析
  const modProv = stateEnabled ? ensureModProvider(profile) : null;
  const _hudGate = resolveHudGate({
    hpConfigured, requireHp, hpValidFinal,
    modHp: stateEnabled ? _facts.get('player.hp') : null,
  });

  // ── 写事实（视觉通道；state.enabled=false 时整块跳过，行为退回接入前）──
  // 只写**读到了**的东西：读不到就不写（让旧值自然过期 → 上层看到 stale，
  // 而不是被一个 0 覆盖成「血空了」）。
  if (stateEnabled) {
    _facts.set('scene', _scene.name, { source: 'vision', conf: 0.85, ttlMs: 400 });
    if (hpConfigured) _facts.set('player.hud', hpValidFinal, { source: 'vision', conf: 0.9, ttlMs: 400 });
    if (hpConfigured && hpValidFinal && d.bars && d.bars[hudName]) {
      _facts.set('player.hp', d.bars[hudName].value, { source: 'vision', conf: 0.7, ttlMs: 500 });
    }
    const motionKeys = Object.keys(d.motion || {});
    const mob = motionKeys.length ? d.motion[motionKeys[0]] : null;
    if (mob && mob.ready && mob.count > 0) {
      const blob = (mob.blobs && mob.blobs[0]) || null;
      _facts.set('enemy.cx', mob.cx, { source: 'vision', conf: 0.75, ttlMs: 120 });
      _facts.set('enemy.cy', mob.cy, { source: 'vision', conf: 0.75, ttlMs: 120 });
      _facts.set('enemy.frames', blob ? blob.frames : 1, { source: 'vision', conf: 0.75, ttlMs: 120 });
    }
  }

  return {
    ok: true,
    w: f.width, h: f.height,
    bars: d.bars || {}, gray: d.gray || {}, colors: d.colors || {}, motion: d.motion || {},
    // 安全闸的三路信号（tick 里用；任一不满足就暂停，不发任何输入）
    fgMatch: f.fgMatch !== false,
    hpValid: _hudGate.hpValid,
    hpSource: _hudGate.hpSource,
    hpConfigured,
    requireHp,
    hud: hudName,
    // 场景分类（P0）：没配 scenes 的 profile 恒为 game / 不拦
    scene: _scene.name,
    sceneMatched: _scene.matched || null,
    sceneScore: _scene.score || 0,
    sceneConfigured: !!_scene.configured,
    sceneBlocking: !!(_scene.configured && _scene.blocking),
    guiFlat: !!(d.gui && d.gui.flat),
    guiStd: d.gui ? d.gui.std : null,
    // 事实表：这一帧的视觉通道读数（其它通道以后写同样的事实，仲裁自动生效）
    factsConflicts: (() => {
      const bad = [];
      for (const f of ['scene', 'player.hp', 'player.hud', 'enemy.cx']) {
        const r = _facts.get(f);
        if (r.conflict) bad.push(f);
      }
      return bad;
    })(),
    ms: {
      grab: Math.round((f.grab_us || 0) / 100) / 10,
      detect: d.ms || 0,
      total: Date.now() - t0,
    },
    frame: { path: f.path, bytes: f.bytes },
  };
}

// ── 规则表（L2）──────────────────────────────────────────────────────────
/**
 * 评估一条规则条件。支持的形式：
 *   "hp < 0.3"            bars.hp 小于 0.3
 *   "hp > 0.7"            bars.hp 大于 0.7
 *   "enemy.area > 0.01"   colors.enemy.area 大于 0.01
 *   "skill2.on"           gray.skill2.on 为真
 *   "always"              恒真
 * 变量解析：`hp` → bars.hp；`x.y` → colors[x][y] 或 gray[x][y]
 */
function evalCond(cond, st) {
  const s = String(cond == null ? '' : cond).trim();
  if (!s || s === 'always' || s === 'true') return true;
  // 2026-11-14 五十三轮：支持 && / ||（|| 先拆，等于它优先级更低）。
  // 为什么需要：profile 里想表达「画面里在动 **并且** 这个目标连续两帧都在」——
  // 只有单条件时只能二选一，单帧粒子就会骗她挥刀。规则复杂度留在 profile，不进代码。
  if (s.includes('||')) return s.split('||').some((part) => evalCond(part, st));
  if (s.includes('&&')) return s.split('&&').every((part) => evalCond(part, st));
  const m = s.match(/^([a-zA-Z_][\w.]*)\s*(<=|>=|<|>|==|!=)?\s*(-?[\d.]+)?$/);
  if (!m) return false;
  const [, lhs, op, rhsRaw] = m;
  let val;
  if (lhs.includes('.')) {
    const [a, b] = lhs.split('.');
    // ⚠ 2026-11-14 真机抓到的 bug：原来只查 colors / gray，**漏了 motion** ——
    // 于是 `enemy.area > 0.004` 永远取不到值（僵尸就在旁边也不打，被咬到 1.2 颗心）。
    if (st.colors && st.colors[a] && st.colors[a][b] !== undefined) val = st.colors[a][b];
    else if (st.motion && st.motion[a] && st.motion[a][b] !== undefined) val = st.motion[a][b];
    else if (st.gray && st.gray[a]) val = st.gray[a][b];
    else val = undefined;
  } else if (st.bars && st.bars[lhs] !== undefined) {
    const b = st.bars[lhs];
    // 2026-11-14：bar 现在是 {value, valid}。valid=false（读不到 HUD）时当「未知」，
    // 条件一律不成立 —— 宁可不动作，也不能因为「读成 0」去按濒死规则。
    val = (b && typeof b === 'object') ? (b.valid ? b.value : undefined) : b;
  } else if (st.gray && st.gray[lhs]) {
    val = st.gray[lhs].on;
  } else {
    val = undefined;
  }
  // 2026-11-14 五十三轮（多通道）：state 里没有的键 → 去**事实表**找。
  // 这样规则可以直接用 Mod 给的精确事实（`enemy.nearest.dist < 4`、`player.food < 0.3`），
  // 不必等视觉把它算出来。st 里有值永远优先（视觉是这一帧的原始观测）。
  if (val === undefined) {
    const f = _facts.get(lhs);
    if (f && f.value !== undefined && !f.stale) {
      val = typeof f.value === 'number' ? f.value : (f.value ? 1 : 0);
    }
  }
  if (!op) return !!val;
  const rhs = Number(rhsRaw);
  if (!Number.isFinite(val) || !Number.isFinite(rhs)) return false;
  switch (op) {
    case '<': return val < rhs;
    case '<=': return val <= rhs;
    case '>': return val > rhs;
    case '>=': return val >= rhs;
    case '==': return Math.abs(val - rhs) < 1e-6;
    case '!=': return Math.abs(val - rhs) >= 1e-6;
    default: return false;
  }
}

/**
 * 按规则表选出一条动作（第一条命中的）。规则形态：
 *   { if: "hp < 0.3", act: { kind:"key", key:"1" }, why:"血少吃药" }
 * act.kind: key / click / hold / none
 */
function decide(profile, st, cdMap) {
  const rules = (profile && profile.rules) || [];
  const now = Date.now();
  for (let i = 0; i < rules.length; i += 1) {
    const r = rules[i];
    if (!evalCond(r.if, st)) continue;
    // cooldown：同一条规则 N 毫秒内不重复触发。
    // 为什么必须（2026-11-14 实测教训）：没有它，「hp<0.35 → 切第 2 格」会在
    // 每一帧都命中（血低是持续状态），把「后退」「攻击」永远挡在后面 ——
    // 实测被僵尸打死，而且死在一直切食物格上（第 2 格还是空的）。
    const cd = Number(r.cooldown) || 0;
    if (cd > 0 && cdMap && cdMap[i] && now - cdMap[i] < cd) continue;
    return { rule: r, why: r.why || r.if, index: i };
  }
  return null;
}

// ── 非阻塞按住（2026-11-14 五十三轮 P1）────────────────────────────────
// 为什么：原来 `hold` 走 pet-core 的 keys + hold_ms —— **在 core 里 sleep 700ms**，
// 这段时间整个闭环冻住（20fps → 1.4Hz）。砍树/挖矿/走位全靠「按住」，全卡在这。
// 现在拆成 key_down + 定时 key_up：发完 down 立刻返回，循环继续跑。
// 兜底：stopLoop / 出错时把还按着的键全松开（core 侧还有 release_all 那层网）。
const _heldKeys = new Map();   // id → { timer, up: 松开请求 }

/** 排一个定时松开（键/鼠标键共用）。同一个 id 再次按住会刷新计时，不叠 timer。 */
function scheduleRelease(id, ms, upReq) {
  const prev = _heldKeys.get(id);
  if (prev && prev.timer) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    _heldKeys.delete(id);
    coreCall(upReq, 4000).catch(() => { /* 已退出 */ });
  }, Math.max(40, Number(ms) || 300));
  if (timer.unref) timer.unref();
  _heldKeys.set(id, { timer, up: upReq });
}

function releaseHeldKeys() {
  for (const [, h] of _heldKeys) {
    if (h && h.timer) clearTimeout(h.timer);
    if (h && h.up) coreCall(h.up, 2000).catch(() => { /* 已退出 */ });
  }
  _heldKeys.clear();
  // 兜底：core 侧记账里可能还有（跨进程安全网）
  coreCall({ cmd: 'release_all' }, 2000).catch(() => { /* 老版本 core 没这条 */ });
}

/**
 * 瞄准：把「目标相对视线的角度偏差」换算成鼠标相对位移（2026-11-14 五十三轮）。
 *
 * 为什么要它：视觉只能给「目标在画面上的像素位置」，换算成视角还受 FOV/宽高比影响；
 * Mod 能直接给 yawDelta/pitchDelta（度），这才是「像人一样把准星甩过去」的正解。
 * sensitivity 由 profile 的 `aim.pxPerDeg` 决定（不同游戏/灵敏度不同，属于数据不是代码）。
 * @pure
 */
function computeAim(facts, cfg) {
  const c = cfg || {};
  const yaw = facts && facts.get('enemy.nearest.yawDelta');
  const pitch = facts && facts.get('enemy.nearest.pitchDelta');
  if (!yaw || yaw.stale || typeof yaw.value !== 'number') {
    return { ok: false, error: '没有准星偏差数据（需要 Mod 通道给 yawDelta）' };
  }
  const pxPerDeg = Number(c.pxPerDeg) > 0 ? Number(c.pxPerDeg) : 6.67;   // 2026-11-14 本机实测标定值（0.15°/px）
  const gain = Number.isFinite(Number(c.gain)) ? Number(c.gain) : 1;
  const rawDx = Math.round(yaw.value * pxPerDeg * gain);
  const rawDy = Math.round(((pitch && !pitch.stale && typeof pitch.value === 'number') ? pitch.value : 0) * pxPerDeg * gain);
  // 死区（2026-11-15 验收抓到）：0.2° 会算出 1px —— 差一点点时会 1px 来回抖（像手抖）。
  // 小于 2px 的一律当已对准（0.3° 以内不动），要用更细的灵敏度就调 profile.aim.
  const dx = Math.abs(rawDx) < 2 ? 0 : rawDx;
  const dy = Math.abs(rawDy) < 2 ? 0 : rawDy;
  return { ok: true, dx, dy, rawDx, rawDy, yaw: yaw.value, pitch: pitch ? pitch.value : 0 };
}

/** 执行一条决策（L0） */
async function execute(profile, act, st) {
  if (!act || act.kind === 'none') return { ok: true, sent: false };
  const target = String((profile && (profile.window || profile.hwnd)) || '');
  // 键位解析：profile.keys 是「语义名 → 实际键」的映射（forward→w / jump→space…）。
  // 2026-11-14 五十三轮：这个映射以前**从来没被读过** —— 框架里到处写死 act.key，
  // 换个游戏键位就全错。现在一律过一遍；映射里没有就原样用（直接写裸键也支持）。
  const keyMap = (profile && profile.keys) || {};
  const keyOf = (k) => {
    const name = String(k == null ? '' : k);
    const v = keyMap[name];
    return v == null || v === '' ? name : String(v);
  };
  // 可见反馈：游戏窗口矩形（30s 缓存，读不到就退化成「不画」）
  const rect = await gameWindowRect(profile).catch(() => null);
  const tagAt = (text) => {
    if (!rect) return;
    notifyOverlay({ tag: { text: String(text).slice(0, 40), x: rect.x + 24, y: rect.y + 56 }, ttl: 1200 });
  };
  const cursorAt = (fx, fy, label) => {
    if (!rect) return;
    notifyOverlay({
      cursor: { x: Math.round(rect.x + fx * rect.w), y: Math.round(rect.y + fy * rect.h), label: String(label).slice(0, 24) },
      cursorTtl: 4000,
    });
  };
  if (act.kind === 'key') {
    const k = keyOf(act.key);
    tagAt('按 ' + k);
    // 2026-11-14 五十三轮实测：**GLFW 丢弃 SendInput 注入的键盘输入**（本机 MC 1.21.1
    // 在「前台 + 键盘焦点都在它身上」时按 W/E/F3 全无反应），但 PostMessage 的
    // WM_KEYDOWN/WM_CHAR 立刻生效（`/time query daytime` 实测回话）。
    // 所以游戏里的按键走 post_keys：后台可用、不抢焦点、不污染用户输入。
    return coreCall({ cmd: 'post_keys', target, keys: k, holdMs: Number(act.holdMs) || 90 }, 5000);
  }
  if (act.kind === 'hold') {
    const k = keyOf(act.key);
    const ms = Math.max(60, Number(act.ms) || 300);
    tagAt('按住 ' + k + ' ' + (ms / 1000).toFixed(1) + 's');
    // 非阻塞：按下立刻返回，松开交给定时器（同样走 PostMessage）
    const r = await coreCall({ cmd: 'post_key_down', target, keys: k }, 4000);
    if (!r || r.ok !== true) return r || { ok: false, error: 'post_key_down 没有响应' };
    scheduleRelease('key:' + k, ms, { cmd: 'post_key_up', target, keys: k });
    return { ok: true, sent: true, held: k, ms, via: 'post_key_down+timer' };
  }
  if (act.kind === 'aim') {
    // 用 Mod 的准星偏差瞄准（视觉给不了角度，只给像素）
    const aim = computeAim(_facts, { pxPerDeg: (profile && profile.aim && profile.aim.pxPerDeg) || act.pxPerDeg, gain: act.gain });
    if (!aim.ok) return { ok: false, error: aim.error };
    tagAt('瞄准 ' + aim.yaw.toFixed(1) + '°');
    if (Math.abs(aim.dx) <= 1 && Math.abs(aim.dy) <= 1) return { ok: true, sent: false, note: '已经在准星上' };
    return coreCall({ cmd: 'mouse', kind: 'move_rel', target, x: aim.dx, y: aim.dy }, 4000);
  }
  if (act.kind === 'mouse_hold') {
    // 长按鼠标键（挖矿/砍树 = 按住左键，吃东西/放方块 = 按住右键）
    const btn = String(act.button || 'left');
    const ms = Math.max(60, Number(act.ms) || 400);
    tagAt('按住' + (btn === 'right' ? '右键' : '左键') + ' ' + (ms / 1000).toFixed(1) + 's');
    const r = await coreCall({ cmd: 'mouse_down', button: btn, target }, 4000);
    if (!r || r.ok !== true) return r || { ok: false, error: 'mouse_down 没有响应' };
    scheduleRelease('mouse:' + btn, ms, { cmd: 'mouse_up', button: btn });
    return { ok: true, sent: true, held: btn, ms, via: 'mouse_down+timer' };
  }
  if (act.kind === 'move_rel') {
    // 相对移动（3D 转视角）。dx/dy 是像素增量 —— 绝对坐标在 3D 游戏里不跟手。
    // target 必须带：pet-core 用它断言「前台就是目标窗口」，不然转视角的鼠标事件
    // 会打进用户刚切过去的应用（SendInput 只认前台）。
    return coreCall({ cmd: 'mouse', kind: 'move_rel', target, x: Math.round(Number(act.dx) || 0), y: Math.round(Number(act.dy) || 0) }, 4000);
  }
  if (act.kind === 'attack') {
    // 转向 + 攻击（2026-11-14）：游戏世界里鼠标被锁定，「打」= 先相对移动把准星
    // 拉到目标，再原地按下左键。gain 是比例增益（BetterGI 用 0.35/0.25 防过冲）。
    //
    // 2026-11-14 五十三轮：目标键名不再写死 'enemy' —— `act.from` 指哪条检测数据就用哪条
    // （缺省取 motion 里的第一条）。换游戏只改 profile，框架不动。
    let tx = 0.5;
    let ty = 0.5;
    const fromKey = String(act.from || (st && st.motion ? (Object.keys(st.motion)[0] || '') : ''));
    const blob = (fromKey && st && st.motion) ? st.motion[fromKey] : null;
    if (blob && Number.isFinite(blob.cx)) {
      tx = blob.cx;
      ty = blob.cy;
    } else if (Number.isFinite(act.x) && Number.isFinite(act.y)) {
      tx = act.x;
      ty = act.y;
    }
    const gain = Number.isFinite(Number(act.gain)) ? Number(act.gain) : 0.35;
    const w = (st && st.w) || 1280;
    const h = (st && st.h) || 720;
    const dx = Math.round((tx - 0.5) * w * gain);
    const dy = Math.round((ty - 0.5) * h * gain);
    cursorAt(tx, ty, '攻击');
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      await coreCall({ cmd: 'mouse', kind: 'move_rel', target, x: dx, y: dy }, 4000);
    }
    return coreCall({ cmd: 'mouse', kind: 'click_only', target }, 4000);
  }
  if (act.kind === 'click') {
    // 坐标可以是绝对像素，也可以是比例（0-1，按画面尺寸换算）
    //
    // ⚠ 2026-11-14 五十三轮修（P0，审计点出的坐标空间混用）：
    //   换算出来的 x/y 是**画面内坐标**，而 `mouse kind:'click'` 要的是**屏幕坐标**。
    //   原来直接把画面坐标当屏幕坐标发出去 —— 游戏窗口不在 (0,0) 时全部点到左上角
    //   （第二屏尤其必错）。现在加上窗口原点。
    //   为什么画面坐标 = 窗口坐标：WGC `CreateForWindow` 抓的是整窗（含标题栏），
    //   和 post_mouse 的「整窗相对」同一套口径（wgc.rs / native.rs 都注过）。
    let x = act.x;
    let y = act.y;
    if (x <= 1 && y <= 1 && st) { x = Math.round(x * st.w); y = Math.round(y * st.h); }
    // `act.at` 指哪条颜色检测的质心就用哪条（不再写死 'enemy'）
    const atKey = String(act.at || '');
    const blobC = (atKey && st && st.colors) ? st.colors[atKey] : null;
    if (blobC && Number.isFinite(blobC.cx)) {
      x = Math.round(blobC.cx * st.w);
      y = Math.round(blobC.cy * st.h);
    }
    if (rect) {
      // 画面坐标 + 窗口原点 = 屏幕坐标；expectTitle 走落点遮挡守卫（防止点在盖住游戏的悬浮窗上）
      const sx = rect.x + x;
      const sy = rect.y + y;
      notifyOverlay({ cursor: { x: sx, y: sy, label: '点' }, cursorTtl: 3000 });
      return coreCall({ cmd: 'mouse', kind: act.button === 'right' ? 'right_click' : 'click', target, x: sx, y: sy, expectTitle: target }, 5000);
    }
    // 读不到窗口矩形 → 如实失败，而不是用画面坐标乱点（那是会点进用户应用的假动作）
    return { ok: false, error: '读不到游戏窗口位置，已拒绝点击（画面坐标不是屏幕坐标，硬点会落到别的窗口）' };
  }
  return { ok: false, error: '不认识的 act.kind：' + act.kind };
}

// ── 循环 ─────────────────────────────────────────────────────────────────
let _loop = null;   // { profile, timer, running, ticks, actions, lastState, lastDecide, errs }

function loopStatus() {
  if (!_loop) return { running: false, active: false, target: '', fgMatch: null };
  return {
    running: _loop.running,
    active: !!_loop.running,
    profile: _loop.profile && (_loop.profile.game || _loop.profile.window),
    target: String((_loop.profile && (_loop.profile.window || _loop.profile.hwnd)) || ''),
    // 最近一拍安全闸看到的前台命中（true=目标在前台 / false=不在 / null=还没抓到帧）
    fgMatch: _loop.lastFgMatch === undefined ? null : _loop.lastFgMatch,
    ticks: _loop.ticks,
    actions: _loop.actions,
    errs: _loop.errs,
    fps: _loop.ticks && _loop.startedAt ? Math.round(_loop.ticks / ((Date.now() - _loop.startedAt) / 1000) * 10) / 10 : 0,
    lastMs: _loop.lastMs,
    lastWhy: _loop.lastWhy,
    lastState: _loop.lastState,
  };
}

/**
 * 会话快照（2026-11-21 审计旁路①：只读判据，不触发抓帧、不改变循环）。
 *
 * 模型可调用的 game 工具分发层据此做「会话」闸；前台判据沿用每拍
 * state() 的 fgMatch（pet-core 的 game_frame 已经按目标窗口断言过前台），
 * 这里不再单独查窗口，避免给输入热路径加一次系统调用。
 *
 * @returns {{active:boolean, profile:string, target:string, fgMatch:(boolean|null), paused:number}}
 */
function sessionSnapshot() {
  if (!_loop) return { active: false, profile: '', target: '', fgMatch: null, paused: 0 };
  const prof = _loop.profile || {};
  return {
    active: !!_loop.running,
    profile: String(prof.game || prof._file || ''),
    target: String(prof.window || prof.hwnd || ''),
    fgMatch: _loop.lastFgMatch === undefined ? null : _loop.lastFgMatch,
    paused: _loop.paused || 0,
  };
}

/**
 * 安全闸（2026-11-14 审计驱动）。
 *
 * 审计原话：最危险的不是识别不准，而是**没有任何「现在能不能操作」的闸**。
 * `SendInput` 永远发给前台窗口 —— 目标不在前台时按 S / 点鼠标会打进用户正在用的应用，
 * 在背包里会丢物品，在死亡界面会点到 Respawn / Title Screen。
 *
 * 三道闸，任一不满足 → 本次 tick 不执行任何动作：
 *   ① 前台：目标窗口必须是当前前台
 *   ② HUD：血条读数必须 valid（读不到 = 菜单/加载/创造/F1）
 *   ③ 界面：画面中心不能是 GUI 面板（背包/箱子/菜单）
 *
 * @returns {string|null} 不满足时的原因（null = 可以操作）
 */
function checkSafetyGate(st) {
  if (!st || !st.ok) return '抓帧失败';
  if (st.fgMatch === false) return '目标窗口不在前台（SendInput 会打进别的应用）';
  // 场景闸（P0）：背包/箱子/聊天/暂停/死亡/加载/标题 —— 这些状态下按 WASD 是灾难
  // （背包里按 Q 丢物品、聊天框里打字、死亡界面点到 Respawn）。
  if (st.sceneBlocking) {
    return '场景不对（' + st.scene + (st.sceneMatched ? ' ✓' : '') + '）—— 现在发输入会打进菜单/背包/聊天';
  }
  // 「没配 HUD」和「配了但读不到」分开说 —— 前者是 profile 的错，后者是画面状态。
  // 没配又不明确放弃（safety.requireHp=false）→ fail-closed，不许盲操作。
  if (st.hpConfigured === false && st.requireHp !== false) {
    return 'profile 没配 HUD 检测（detect.bars.' + (st.hud || 'hp') + ' 缺失，没有 HUD 就没有安全闸）——补上，或显式写 safety.requireHp=false';
  }
  if (st.hpValid === false) return 'HUD 读不到（可能在菜单/加载/创造模式/F1）';
  if (st.guiFlat) return '检测到 GUI 面板（背包/箱子/菜单）';
  return null;
}

async function tick() {
  const L = _loop;
  if (!L || !L.running) return;
  const t0 = Date.now();
  try {
    const st = await state(L.profile, { slot: 'loop' });
    if (!L.running) return;                    // stopLoop 在 await 期间生效 → 这一拍不再动作
    // 前台判据留给分发层做「输入闸」：只记录最近一次观察，不改变这一拍的动作决策。
    L.lastFgMatch = (st && st.ok) ? (st.fgMatch !== false) : null;
    if (!st.ok) {
      L.errs += 1;
      if (L.errs <= 3) L.onErr && L.onErr('state: ' + st.error);
      // 连续失败太多就自动停，别无限重试（检测器崩了会 20 次/秒 spawn Python）
      if (L.errs >= (L.profile && L.profile.max_errors || 30)) {
        L.lastWhy = '自动停：连续 ' + L.errs + ' 次抓帧/检测失败';
        stopLoop();
        return;
      }
    } else if (checkSafetyGate(st)) {
      // 安全闸：不发任何输入，只记原因
      const why = checkSafetyGate(st);
      // 2026-11-14 五十三轮（P0）：**死亡/标题画面直接停机**，不是暂停 ——
      // 这两处等下去也没有「自己会好」的可能，继续挂着只会让用户以为她卡住了。
      if (st.scene === 'death' || st.scene === 'title') {
        L.lastWhy = '自动停：' + why;
        if (L.onErr) L.onErr('场景：' + st.scene + '（循环已停）');
        stopLoop();
        return;
      }
      L.paused = (L.paused || 0) + 1;
      L.lastWhy = '暂停：' + why;
      L.lastState = { bars: st.bars, gray: st.gray, motion: st.motion, guiStd: st.guiStd, scene: st.scene, ms: st.ms };
      if (L.paused >= (L.profile && L.profile.max_paused || 60)) {
        L.lastWhy = '自动停：连续 ' + L.paused + ' 拍不满足安全条件（' + why + '）';
        stopLoop();
        return;
      }
    } else {
      L.paused = 0;
      L.errs = 0;
      L.lastState = { bars: st.bars, gray: st.gray, colors: st.colors, motion: st.motion, ms: st.ms };
      const d = decide(L.profile, st, L.cdMap);
      if (d && d.rule && d.rule.act && d.rule.act.kind !== 'none') {
        if (d.index !== undefined) L.cdMap[d.index] = Date.now();   // 记冷却
        const r = await execute(L.profile, d.rule.act, st);
        if (r && r.ok) L.actions += 1;
        L.lastWhy = d.why;
      } else {
        L.lastWhy = d ? d.why : '无规则命中';
      }
    }
  } catch (e) {
    L.errs += 1;
    if (L.errs <= 3) L.onErr && L.onErr(String(e && e.message || e));
  }
  L.ticks += 1;
  L.lastMs = Date.now() - t0;
  if (!L.running) return;
  const interval = Math.max(16, Math.round(1000 / Math.max(1, Number(L.profile.fps) || 20)));
  L.timer = setTimeout(() => { tick().catch(() => {}); }, Math.max(0, interval - L.lastMs));
}

function startLoop(profile, opts = {}) {
  if (!profile || !(profile.window || profile.hwnd)) return { ok: false, error: 'profile 缺 window' };
  stopLoop();
  _loop = {
    profile, running: true, ticks: 0, actions: 0, errs: 0,
    startedAt: Date.now(), timer: null, lastMs: 0, lastWhy: '', lastState: null,
    // 还没抓到第一帧 → 前台未知（分发层的输入闸按 fail-closed 处理）
    lastFgMatch: null,
    onErr: typeof opts.onErr === 'function' ? opts.onErr : null,
    cdMap: {}, paused: 0,
  };
  tick().catch(() => {});
  return { ok: true, started: true, profile: profile.game || profile.window };
}

function stopLoop() {
  if (_loop) {
    _loop.running = false;
    if (_loop.timer) clearTimeout(_loop.timer);
    _loop = null;
  }
  releaseHeldKeys();   // 还按着的键/鼠标键先松开，再收光标（否则角色会一直走）
  try { _facts.reset(); } catch (e) { /* 事实表清空失败不影响停机 */ }
  try { if (_mod) { _mod.stop(); _mod = null; } } catch (e) { /* 停 Mod 通道失败不影响停机 */ }
  hideGameCursor();    // 停了就收掉她的虚拟光标，别在屏幕上留一个幽灵指针
  return { ok: true, stopped: true };
}

function closeDetector() {
  if (_det && _det.child) {
    try { _det.child.stdin.write('__quit__\n'); } catch (e) { /* 已关 */ }
    try { _det.child.kill(); } catch (e) { /* 已死 */ }
    _det = null;
  }
}

// 2026-11-14 五十三轮（审计）：closeDetector 原来**只有定义没有调用点** ——
// 进程退出时那个常驻 Python 会留成孤儿（每次重启多一个）。挂到 process 退出上。
try {
  process.once('exit', () => { try { closeDetector(); } catch (e) { /* 退出路径不抛 */ } });
} catch (e) { /* 某些宿主没有 process 事件 */ }

module.exports = {
  facts: _facts,   // 诊断/单测用（读快照，不给业务逻辑直接改）
  resolveHudGate,
  computeAim,
  // 诊断：Mod 通道健康（连着没/多久没数据/解析错误）—— game status 与探针用
  modHealth: () => (_mod ? _mod.health() : null),
  __ensureMod: (prof) => { try { return !!ensureModProvider(prof); } catch (e) { return 'ERR:' + (e && e.message || e); } },
  checkSafetyGate,
  loadProfile,
  listProfiles,
  profilesDir,
  state,
  decide,
  execute,
  startLoop,
  stopLoop,
  loopStatus,
  sessionSnapshot,
  closeDetector,
  evalCond,
  detect: detectorCall,   // 暴露给测试
};
