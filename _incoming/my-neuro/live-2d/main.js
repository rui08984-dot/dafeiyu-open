// ── 崩溃现场自动留证（2026-11-22）──────────────────────────────────────────
// 背景：重启偶发 ERR_UNKNOWN_FILE_EXTENSION（重试一次就成功），但进程死时不留任何证据 ——
// Electron 主进程默认只往控制台打，控制台随进程消失。这里在**第一行**（任何业务 require
// 之前）挂上处理器，把 code/url/完整堆栈写进 crash-main.log，下次复现能直接看到 import 链。
// 行为不变：**只记录、不退出**——实测 Electron 28 对这两类异常本来就是警告级（见 crash-log.js）。
try {
  require('./js/core/crash-log.js').install({ file: require('path').join(__dirname, 'crash-main.log') });
} catch (e) { /* 留证模块本身不可用时也不阻断启动 */ }
const __silentAudit = require('./js/core/silent-audit.js');
// ── DNS 解析顺序：IPv4 优先（2026-11-16，回复慢 7 秒的根因）────────────────
// api.commandcode.ai 有多条 AAAA（Cloudflare），而 Electron 28 跑的是 Node 18：
// 默认 verbatim 顺序 → 先连 IPv6 → 本机 IPv6 不通 → 干等 5-10 秒超时才回退 IPv4。
// 实测：同一个 key/URL/载荷，Node 24（有 Happy Eyeballs 竞速）1.4s，她这边响应头 7.3s。
// 修法：显式 ipv4first + 打开 autoSelectFamily（双保险，老 Node 没有后者会静默跳过）。
try {
  const dns = require('dns');
  if (typeof dns.setDefaultResultOrder === 'function') dns.setDefaultResultOrder('ipv4first');
  const net = require('net');
  if (typeof net.setDefaultAutoSelectFamily === 'function') net.setDefaultAutoSelectFamily(true);
  if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') net.setDefaultAutoSelectFamilyAttemptTimeout(300);
} catch (e) { /* 老运行时没有这些 API：保持默认，不阻断启动 */ }
const { app, BrowserWindow, ipcMain, screen, globalShortcut, desktopCapturer, dialog, nativeImage, Tray, Menu, contentTracing, session } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

// ── 关闭 Windows 原生遮挡计算（2026-11-22 遮挡性能）────────────────────────
// Chromium 的 CalculateNativeWinOcclusion 会把「被全屏窗口盖住的透明宠物窗」
// 判为 occluded，即使 webPreferences.backgroundThrottling=false，渲染循环也会被
// 压到个位数。实测（Edge kiosk 全屏视频在前台）：
//   空闲 82.8fps / p99 45ms  →  遮挡后 rAF 6.8fps、内容帧 19.6fps、p99 245ms。
// 桌面宠物被盖住也必须保持画面（用户切回来看时不能是僵住的），且背景节流本来就
// 已经由我们自己的“游戏/全屏省电”策略接管，所以直接关掉原生遮挡判断。
// 必须在 app ready 之前 append，ready 之后再设不生效。
try {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
} catch (e) { /* 老版本没有该 feature 时无副作用 */ }

// ── 遮挡时仍保持渲染（2026-11-22 实测补第二道）──────────────────────────────
// 只关 CalculateNativeWinOcclusion 还不够：窗口被别的窗口盖住时，Chromium 仍会把
// 该 renderer 标记为「后台化」，rAF 掉到 ~1fps（真机实测 1200ms 只跑 2 帧，
// document.visibilityState 仍是 'visible'）。后果：她被盖住时表情/呼吸/CSS 过渡全冻，
// 切回来像张照片；门禁里的「光环可见(opacity=1)」「松手后渲染恢复」也会随窗口层级偶红。
// 这两个开关让被遮挡的窗口继续出帧（代价是被盖住时仍占少量 CPU/GPU —— 这是桌宠的
// 刻意选择，与上面的注释一致）。
try {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
} catch (e) { /* 老版本没有这些开关时无副作用 */ }

// 启动标记（自检用）：确认跑的是盘上这份 main.js（排查「改了不生效」别靠猜）
try { fs.writeFileSync(path.join(__dirname, '..', '..', 'main-boot.json'), JSON.stringify({ at: Date.now(), ver: 'ascii-autostart-1', pid: process.pid }), 'utf8'); } catch (e) { /* 写不了不影响启动 */ }

// ⚠ petWinRef 必须在这里（所有函数与创建流程之前）声明。
// 创建桌宠窗口的流程会立刻 `petWinRef = win` 登记引用，而 `let` 有 TDZ：
// 声明若写在文件后半段，那次赋值会抛 ReferenceError 并被外层 try 吞掉，
// 结果 petWinRef 恒为 null → 字幕位置永远算不出（只有兜底值 → 字幕压在皮套上）。
// 2026-11-08 实测定位到的真 bug（症状：doctor 报「字幕窗压在皮套上，居中偏差 535px」）。
let petWinRef = null
const { HttpServer } = require('./js/services/http-server')
const {
    scanLive2DModels,
    resolveLive2DModel,
    scanVRMModels,
    scanMMDModels
} = require('./js/avatar/model-registry')
const { saveModelPrefs } = require('./js/avatar/preferences-store')
const {
    AvatarSwitchTransaction,
    normalizeAvatarType
} = require('./js/avatar/avatar-switch-transaction')
const { ShortcutManager } = require('./js/shortcut-manager')
const screenshot = require('screenshot-desktop');
const { logToTerminal } = require('./js/api-utils');
// 配置写盘唯一入口（原子写 + 回读校验）：别再在别处写第二份 JSON.stringify+writeFileSync
const { writeJsonVerified, patchVerified } = require('./js/core/config-persist');

// 添加配置文件路径；隔离测试可通过环境变量指向临时副本。
const configPath = process.env.MY_NEURO_CONFIG_PATH
    ? path.resolve(process.env.MY_NEURO_CONFIG_PATH)
    : path.join(app.getAppPath(), 'config.json');
// LLM 通讯录所在目录（与 config.json 同目录）
const configBaseDir = path.dirname(configPath);
const { persistProviderStore } = require('./js/core/llm-provider-store');
// 2026-11-17 六十四轮：宿主整份保存（通讯录 + config + 回读）收敛到可单测的纯辅助
const { saveHostConfig } = require('./js/core/config-persist');
let shortcutManager = null;
let rendererRequestCounter = 0;
const pendingRendererRequests = new Map();
let avatarSwitchTransaction = null;
const SUPPORTED_AVATAR_TYPES = new Set(['live2d', 'petbody', 'vrm', 'mmd']);
const AVATAR_RESULT_PHASES = new Set([
    'ready',
    'busy',
    'failed',
    'rolled-back',
    'reload-required',
    'reload-scheduled',
    'rollback-reload-scheduled'
]);

function loadConfigData() {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// 整份写盘：调用方已自己读过配置并改好键。
// 为什么失败要抛：调用点全在 try/catch 里（IPC handler/托盘回调），靠异常才能把
// success:false 传回界面。老写法只在 console 里打一行，面板照样显示「已保存」。
function saveConfigData(configData) {
    const wrote = writeJsonVerified(configPath, configData);
    if (!wrote.ok) {
        logToTerminal('error', `[config] 整份写盘失败（改动静默丢失！）: ${wrote.error}`);
        throw new Error('配置写盘失败：' + wrote.error);
    }
    return wrote;
}

/**
 * 变更 config.json 的唯一写盘入口（2026-11-18 §69 B1）
 *
 * 为什么不能继续 `fs.writeFileSync(configPath, JSON.stringify(cfg))`：
 *   ① 托盘里那份 config 是**建托盘时的快照**，控制面板/插件改过配置后，
 *      托盘任意一次点击都会把整份旧配置写回磁盘，把别人的改动整体抹掉；
 *   ② 裸写没有 .tmp + rename，写一半崩溃会留下半个 JSON（下次启动直接读崩）；
 *   ③ 写完不回读、失败只打一行 console.error —— 用户在界面上看到的是「已设置」。
 *
 * 现在固定三步：读**最新**配置 → 在它上面只改目标键 → 原子写 + 回读校验。
 * 任何一步失败都 logToTerminal('error') 并返回 ok:false（不静默）。
 * 不抛异常：调用点多半在托盘点击/事件回调里，抛出去只会变成无人处理的 rejection。
 *
 * @param {string} where                调用点标记，日志里能直接定位（如 'tray:穿透'）
 * @param {(cfg:object)=>void} mutate   在**刚从磁盘读到的**配置对象上改键
 * @returns {{ok:boolean, error?:string, keys?:number}}
 */
function patchConfigVerified(where, mutate) {
    // 真正干活的是 config-persist.patchVerified（纯函数、可单测）；这里只负责发声。
    const wrote = patchVerified(configPath, mutate);
    if (!wrote.ok) {
        const step = wrote.stage === 'read' ? '读不到当前配置'
            : wrote.stage === 'mutate' ? '改配置时出错'
            : '写盘失败（改动静默丢失！）';
        logToTerminal('error', `[config] ${where} ${step}: ${wrote.error}`);
    }
    return wrote;
}

// ── 语义兜底：把一句用户话改写成「情绪描述」（2026-11-18 §69 B6）────────────
// 为什么要这一步：8120 的模型契约是 {intent: 情绪描述, text: 台词}，而兜底链一直
// 把**原始用户文本**塞进 intent。离线实验（_probe/semantic-rewrite-eval.mjs，18 条语料）：
//   原句 → 可用率 22%、情绪对上 6%、均值置信 0.36
//   描述 → 可用率 44%、情绪对上 39%、均值置信 0.50   ← 达标线是 ≥30%
// 「同一句塞两个槽」这种零成本变体只有 22%，没有帮助 —— 起作用的是**描述**本身。
//
// 成本控制：只在兜底链真的要问 8120 时才发生（规则/LLM 已给出强情绪时压根不问），
// 再加 5 秒最小间隔 + 200 条缓存 + 12 秒硬超时（实测同一网关：独立 Node 3.5s、Electron 内首调 7.6s；2.5s/6s 都会把正常调用判超时）；失败一律 {ok:false}，让渲染层退回原句。
// 提示词与清洗规则放在 js/core/semantic-describe.js —— 离线评测用同一份，杜绝「探针测的不是线上那版」。
const { DESCRIBE_SYSTEM_PROMPT, sanitizeDescription } = require('./js/core/semantic-describe');
const describeCache = new Map();      // 原句 → 描述（简单的 LRU：超过 200 条丢最旧）
let describeClient = null;
let describeClientKey = '';
let describeLastAt = 0;

function getDescribeClient() {
  // 延迟 require：避免启动期加载 llm 链，也避免与 llm-handler 形成循环依赖
  const { llmProviderManager } = require('./js/core/llm-provider');
  const { LLMClient } = require('./js/ai/llm-client');
  const cfg = loadConfigData();
  const pick = () => llmProviderManager.resolveProviderOrFallback(
    (cfg.llm && cfg.llm.provider_id) || null,
    (cfg.llm && cfg.llm.model_id) || null
  );
  let resolved = pick();
  if (!resolved) {
    // 这个 IPC 可能比第一次对话更早到：全局 manager 只在 config-loader 走过时才 init 过。
    // 自己注水（通讯录 → config.llm_providers）+ init 一次，再取。失败照常返回 null（不假装可用）。
    try {
      const { persistProviderStore } = require('./js/core/llm-provider-store');
      persistProviderStore(configBaseDir, configPath, cfg, { writeBack: false });
    } catch (e) { /* 通讯录不在就只能是 null */ }
    try { llmProviderManager.init(cfg); } catch (e) { /* 初始化失败按不可用处理 */ }
    resolved = pick();
  }
  if (!resolved) return null;
  // provider 配置变了就重建（换 key/换模型后不用重启）
  const key = String(resolved.id || '') + '|' + String(resolved.model || '') + '|' + String(resolved.apiKey || resolved.key || '');
  if (!describeClient || key !== describeClientKey) {
    describeClient = LLMClient.fromProviderConfig(resolved, (cfg.llm && cfg.llm.retry) || {});
    describeClientKey = key;
  }
  return describeClient;
}

function withTimeout(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(what + '超时（' + ms + 'ms）')), ms);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

ipcMain.handle('sense-intent-describe', async (_event, text) => {
  const raw = String(text || '').trim().slice(0, 200);
  if (raw.length < 2) return { ok: false, error: '输入太短' };
  // §72b 决策：这里**不再**读 relay。
  // 原因（语义错配，2026-11-18 实测想清楚）：兜底是「用户开口时」问情绪，而搭车的 mood 是
  // 「她回完这句话之后」才有的 —— 在这里读只会拿到**上一轮**的 mood（她上句话的心情），
  // 拿它去喂这一句就是错的。搭车改走「到达即喂」（主进程广播 → 渲染层本地 8120 分类 → 喂引擎），
  // 见 js/ai/llm-handler.js 的 _setMoodSafe 与 main.js 的 mood-line 广播。
  try {
    const cfg = loadConfigData();
    // 2026-11-18 §71：默认**关**。实测这次改写要 4.6–7.6s（网关波动）且质量不稳
    //（「你可真行」「哼，不理你了」都被判成「困惑无奈」）——喂错的情绪比没有更糟。
    // 计划路线是「搭车主模型」（回复里顺带一行情绪描述，零额外延迟），见 §71.4；
    // 在那之前只有显式设 ui.petbody_semantic_rewrite=true 才走慢改写。
    if (!(cfg.ui && cfg.ui.petbody_semantic_rewrite === true)) return { ok: false, error: '未启用（慢改写默认关；等「搭车主模型」）' };
  } catch (e) { /* 读不到配置就按默认开 */ }
  if (describeCache.has(raw)) return { ok: true, description: describeCache.get(raw), cached: true };
  const now = Date.now();
  if (now - describeLastAt < 5000) return { ok: false, error: '限流（5 秒一次）' };
  describeLastAt = now;
  try {
    const client = getDescribeClient();
    if (!client) return { ok: false, error: '没有可用的对话模型' };
    const result = await withTimeout(client.chatCompletion([
      { role: 'system', content: DESCRIBE_SYSTEM_PROMPT },
      { role: 'user', content: raw },
    ], null, false), 12000, '情绪描述改写');
    // 各家返回形状不一：{content} / {choices:[{message:{content}}]} / 纯字符串
    const content = (result && typeof result === 'string') ? result
      : (result && (result.content || (result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content))) || '';
    const description = sanitizeDescription(content);
    if (!description) return { ok: false, error: '模型返回空描述' };
    if (describeCache.size >= 200) describeCache.delete(describeCache.keys().next().value);
    describeCache.set(raw, description);
    return { ok: true, description, elapsedMs: Date.now() - now };
  } catch (error) {
    // 失败必须发声：兜底链的降级不该静默（但也不影响她说话）
    logToTerminal('warn', '[semantic] 情绪描述改写失败，退回原句：' + ((error && error.message) || error));
    return { ok: false, error: String((error && error.message) || error) };
  }
});

// ── 自己的窗口清单（电脑操控的前置守卫用，§71）────────────────────────────
// 为什么要主进程给：只有这里能枚举所有 BrowserWindow，而且 DIP→物理像素的换算需要
// 对应显示器的 scaleFactor（本机 150%，直接拿 DIP 会偏 1.5 倍 —— 守卫就永远不命中）。
// 返回的 rect 一律是**物理屏幕像素**，与 click_at / SendInput / SetCursorPos 同一坐标系。
// §72 搭车：渲染进程的主对话链把「她刚说的那句话的情绪」发过来。
// 为什么要跨进程：llm-handler 在渲染进程里跑（app-initializer），而语义兜底的 IPC 在
// 主进程 —— 两个进程的 mood-relay 是两个模块实例，不传这一下主进程永远读不到。
ipcMain.on('mood-line', (_event, payload) => {
  try {
    const mood = payload && String(payload.mood || '').trim();
    if (!mood) return;
    const relay = require('./js/core/mood-relay');
    relay.setMood(mood, { from: 'llm-piggyback' });
    logToTerminal('info', '[mood] 主进程收到：' + mood.slice(0, 40));
    // §72b：**广播给渲染层**，让她「收到就喂」——
    // 原来的用法有个语义错配：兜底是「用户开口时」问情绪，而搭车的 mood 是「她回完话后」才有的，
    // 于是只能吃到**上一轮**的情绪。mood 描述的是她这句话的心情，应当在它到达时就喂进情绪引擎。
    // ⚠ 别用 payload 这个名字：它在块作用域里会遮蔽 handler 的同名参数 → 上面一行
    //   payload.mood 直接踩 TDZ（实测报 'Cannot access payload before initialization'）。
    const msg = { type: 'mood', mood, at: Date.now() };
    for (const win of BrowserWindow.getAllWindows()) {
      try { if (win && !win.isDestroyed()) win.webContents.send('mood-line', msg); } catch (e) { /* 单个窗口失败不影响其他 */ }
    }
  } catch (error) {
    logToTerminal('warn', '[semantic] 接收 mood 行失败：' + ((error && error.message) || error));
  }
});
ipcMain.handle('app-own-windows', () => {
  try {
    const out = [];
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win || win.isDestroyed()) continue;
      let dip;
      try { dip = win.getBounds(); } catch (e) { continue; }
      let scale = 1;
      try { scale = Number(screen.getDisplayMatching(dip).scaleFactor) || 1; } catch (e) { scale = 1; }
      let title = '';
      try { title = win.getTitle() || ''; } catch (e) { title = ''; }
      const isPet = win.__isPetWindow === true;
      const isSubtitle = win.__isSubtitleWindow === true;
      let pid = null;
      try { pid = win.webContents.getOSProcessId(); } catch (e) { pid = null; }
      out.push({
        id: win.id,
        title: title || (isPet ? '桌宠皮套' : isSubtitle ? '字幕窗' : ''),
        transparent: isPet || isSubtitle,
        pid,
        rect: {
          x: Math.round(dip.x * scale),
          y: Math.round(dip.y * scale),
          w: Math.round(dip.width * scale),
          h: Math.round(dip.height * scale),
        },
      });
    }
    return out;
  } catch (error) {
    logToTerminal('warn', '[safety] 取自身窗口清单失败：' + ((error && error.message) || error));
    return [];
  }
});

function updateUiConfig(patch) {
    const configData = loadConfigData();
    if (!configData.ui) configData.ui = {};
    Object.assign(configData.ui, patch);
    saveConfigData(configData);
    return configData;
}

// 世界感知开关（2026-11-17 六十二轮）：写盘 + 返回合并后的整段。
// 为什么要有它：开关必须能在**不重启宿主**的前提下改（隐私模式尤其），
// 而渲染层的插件只认 config.world_sense / 运行时覆盖 globalThis.__worldSenseConfig。
// 两者都由这里维护：落盘给下次启动，覆盖给当前这一秒。
function updateWorldSenseConfig(patch) {
    const configData = loadConfigData();
    const cur = (configData.world_sense && typeof configData.world_sense === 'object') ? configData.world_sense : {};
    const next = Object.assign({}, cur);
    for (const [k, v] of Object.entries(patch || {})) {
        if (k === 'sources' && v && typeof v === 'object') {
            next.sources = Object.assign({}, cur.sources || {}, v);
        } else if (['enabled', 'privacy', 'low_power', 'lowPower'].includes(k)) {
            next[k] = !!v;
        }
    }
    configData.world_sense = next;
    saveConfigData(configData);
    return next;
}

function nextRendererRequestId(prefix) {
    rendererRequestCounter += 1;
    return `${prefix}-${Date.now()}-${rendererRequestCounter}`;
}

function waitForRendererRequest(requestId, senderId, timeoutMs = 30000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingRendererRequests.delete(requestId);
            resolve({
                success: false,
                phase: 'failed',
                timedOut: true,
                reloadRequired: true,
                message: `渲染进程未在 ${timeoutMs}ms 内确认操作`
            });
        }, timeoutMs);
        pendingRendererRequests.set(requestId, { resolve, timer, senderId });
    });
}

function cancelRendererRequest(requestId) {
    const pending = pendingRendererRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRendererRequests.delete(requestId);
    pending.resolve({
        success: false,
        phase: 'failed',
        message: '渲染请求已取消'
    });
}

function completeRendererRequest(event, payload) {
    const requestId = String(payload?.requestId || '');
    const pending = pendingRendererRequests.get(requestId);
    if (!pending) {
        return { success: false, message: '找不到待确认的渲染请求' };
    }
    if (pending.senderId != null && event.sender?.id !== pending.senderId) {
        return { success: false, message: '渲染请求来源不匹配' };
    }

    clearTimeout(pending.timer);
    pendingRendererRequests.delete(requestId);
    pending.resolve({
        success: payload?.success === true,
        phase: AVATAR_RESULT_PHASES.has(payload?.phase) ? payload.phase : undefined,
        message: typeof payload?.message === 'string'
            ? payload.message
            : (payload?.success === true ? '操作成功' : '操作失败'),
        restored: payload?.restored === true,
        reloadRequired: payload?.reloadRequired === true,
        timedOut: payload?.timedOut === true,
        targetType: normalizeAvatarType(payload?.targetType),
        activeType: Object.prototype.hasOwnProperty.call(payload || {}, 'activeType')
            ? normalizeAvatarType(payload.activeType)
            : undefined
    });
    return { success: true };
}

function getRendererWindow(event) {
    const sender = event?.sender;
    if (!sender || sender.isDestroyed?.()) {
        throw new Error('渲染窗口不可用');
    }
    const win = BrowserWindow.fromWebContents(sender);
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
        throw new Error('渲染窗口不可用');
    }
    return win;
}

async function requestRendererConfirmation(event, channel, payload, prefix, timeoutMs = 30000) {
    const requestId = nextRendererRequestId(prefix);
    const pending = waitForRendererRequest(requestId, event?.sender?.id, timeoutMs);
    try {
        const win = getRendererWindow(event);
        win.webContents.send(channel, { ...payload, requestId });
        return await pending;
    } catch (error) {
        cancelRendererRequest(requestId);
        throw error;
    } finally {
        cancelRendererRequest(requestId);
    }
}

function sendUiConfigPatch(win, patch) {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send('avatar-config-updated', { ui: patch });
}

function scheduleWindowReload(win, reason) {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
        throw new Error('渲染窗口不可用，无法安排重载');
    }
    setImmediate(() => {
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
        console.log(`[Avatar] 安排窗口重载: ${reason || '状态同步'}`);
        win.webContents.reload();
    });
}

function resolveAvatarModelSelection(type, requestedName) {
    const scanners = {
        live2d: scanLive2DModels,
        vrm: scanVRMModels,
        mmd: scanMMDModels
    };
    const scan = scanners[type];
    const all = scan ? scan() : [];
    const requested = String(requestedName || '').trim();
    const entry = all.find(model => model.modelPath === requested)
        || all.find(model => model.name === requested)
        || (type !== 'live2d'
            ? all.find(model => path.basename(model.modelPath) === requested)
            : null);

    return {
        entry: entry || null,
        all,
        configValue: entry
            ? (type !== 'live2d' ? entry.modelPath : entry.name)
            : null
    };
}

function avatarModelCount(type) {
    if (!SUPPORTED_AVATAR_TYPES.has(type)) return 0;
    // petbody 自带模型（assets/petbody），不依赖模型扫描目录。
    if (type === 'petbody') return 1;
    if (type === 'live2d') return scanLive2DModels().length;
    if (type === 'vrm') return scanVRMModels().length;
    if (type === 'mmd') return scanMMDModels().length;
    return 0;
}

function hasAvatarModel(type) {
    return avatarModelCount(type) > 0;
}

function normalizeConfiguredAvatarType(configData) {
    if (!configData || typeof configData !== 'object') return null;
    if (!configData.ui || typeof configData.ui !== 'object') configData.ui = {};

    const requested = normalizeAvatarType(configData.ui.model_type) || 'live2d';
    const usable = SUPPORTED_AVATAR_TYPES.has(requested) && hasAvatarModel(requested)
        ? requested
        : ['live2d', 'vrm', 'mmd'].find(hasAvatarModel);
    if (!usable || usable === requested) return usable;

    configData.ui.model_type = usable;
    saveConfigData(configData);
    console.warn(`[Avatar] ${requested} 当前没有可用 driver 或模型，已回退到 ${usable}`);
    return usable;
}

function getAvatarSwitchTransaction() {
    if (avatarSwitchTransaction) return avatarSwitchTransaction;
    avatarSwitchTransaction = new AvatarSwitchTransaction({
        readModelType() {
            return loadConfigData().ui?.model_type || 'live2d';
        },
        updateModelType(type) {
            updateUiConfig({ model_type: type });
        },
        hasAvatarModel(type) {
            return hasAvatarModel(type);
        },
        requestRendererSwitch(type, context) {
            return requestRendererConfirmation(
                context.event,
                'avatar-switch-type',
                { type },
                'avatar-type-switch'
            );
        },
        publishModelType(type, context) {
            sendUiConfigPatch(context.win, { model_type: type });
        },
        scheduleReload({ context, reason }) {
            scheduleWindowReload(context.win, reason);
        },
        log(level, message) {
            console[level === 'error' ? 'error' : 'log'](`[Avatar] ${message}`);
        }
    });
    return avatarSwitchTransaction;
}

function finalizeRendererFailure(win, result, reason) {
    if (result?.success !== true && result?.reloadRequired === true) {
        try {
            scheduleWindowReload(win, reason || result.message);
            return {
                ...result,
                phase: 'reload-scheduled'
            };
        } catch (error) {
            return {
                ...result,
                phase: 'failed',
                message: `${result.message || '渲染操作失败'}；安排恢复重载失败: ${error.message}`
            };
        }
    }
    return result;
}


function ensureTopMost(win) {
    if (!win.isAlwaysOnTop()) {
        win.setAlwaysOnTop(true, 'screen-saver')
    }
}

// ===== 跨屏方案辅助函数 =====
// 6.6 单屏窗口边界（仅留给调试/兼容调用，创建窗口不再走这条路径）。
function getFullscreenDisplayBounds(display) {
    const b = display && display.bounds ? display.bounds : { x: 0, y: 0, width: 1280, height: 720 };
    return {
        x: b.x + 1,
        y: b.y + 1,
        width: Math.max(1, b.width - 1),
        height: Math.max(1, b.height - 1),
    };
}

// 6.55 巨窗并集：用 Electron display.bounds 原始 x/y（副屏在左时为负数），禁止 clamp 到 0。
// 相对 6.55 的唯一行为调整：显式 extend=false 但已有 2 块及以上屏幕时，仍覆盖全部屏幕，
// 避免用户必须先改 config.json 才能把皮套拖到副屏。
function computePetWindowBounds(config, displays, primaryDisplay) {
    // 显式小窗模式：桌宠只要一个 420x760 的透明窗，不再用「跨屏并集巨窗」。
    const petWindow = config && config.ui && config.ui.pet_window;
    if (petWindow && Number(petWindow.width) > 0 && Number(petWindow.height) > 0) {
        const width = Math.round(Number(petWindow.width));
        const height = Math.round(Number(petWindow.height));
        const base = primaryDisplay || (Array.isArray(displays) && displays[0]);
        const area = base && base.workArea ? base.workArea : { x: 0, y: 0, width: 1920, height: 1080 };
        const rawX = Number.isFinite(petWindow.x) ? Math.round(petWindow.x) : area.x + area.width - width - 24;
        const rawY = Number.isFinite(petWindow.y) ? Math.round(petWindow.y) : area.y + area.height - height - 24;
        // 拔掉副屏/改分辨率后，陈旧保存位置可能在所有物理屏之外（实测 x=4014 on 单屏 2560）：
        // 屏外窗口合成器冻结 → WebGL 挂起 → 皮套整场缺席。钳回物理显示器并集内（2026-11-02 B9）。
        const realBounds = (Array.isArray(displays) && displays.length ? displays : [base]).map(d => d.bounds || d);
        const rx = Math.min(...realBounds.map(b => b.x));
        const ry = Math.min(...realBounds.map(b => b.y));
        const rMaxX = Math.max(...realBounds.map(b => b.x + b.width));
        const rMaxY = Math.max(...realBounds.map(b => b.y + b.height));
        const x = Math.min(rMaxX - width, Math.max(rx, rawX));
        const y = Math.min(rMaxY - height, Math.max(ry, rawY));
        if (x !== rawX || y !== rawY) console.log('[pet] 陈旧位置 (' + rawX + ',' + rawY + ') 已钳回物理屏内 (' + x + ',' + y + ')');
        return { minX: x, minY: y, maxX: x + width, maxY: y + height, totalWidth: width, totalHeight: height, screenExtend: { extend: false }, displayCount: (displays || []).length, petWindow: true };
    }
    const screenExtend = (config && config.ui && config.ui.screen_extend) || { extend: false, left: false, right: true };
    const all = Array.isArray(displays) && displays.length > 0 ? displays : [primaryDisplay];
    const primary = primaryDisplay || all[0];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const include = (display) => {
        const { x, y, width, height } = display.bounds;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + width);
        maxY = Math.max(maxY, y + height);
    };

    const multi = all.length >= 2;
    if (screenExtend.extend === false && !multi) {
        include(primary);
    } else if (screenExtend.extend === true && screenExtend.left) {
        all.forEach((display) => {
            if (display.bounds.x <= primary.bounds.x) include(display);
        });
    } else {
        all.forEach(include);
    }

    return {
        minX,
        minY,
        maxX,
        maxY,
        totalWidth: maxX - minX,
        totalHeight: maxY - minY,
        screenExtend,
        displayCount: all.length
    };
}

function applyPetUnionBounds(win, config) {
    if (!win || win.isDestroyed()) return null;
    if (win._petDragging) return null;   // 用户正在拖，别跟他抢窗口
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const target = computePetWindowBounds(config || {}, displays, primary);
    const next = {
        x: target.minX,
        y: target.minY,
        width: target.totalWidth,
        height: target.totalHeight
    };
    const current = win.getBounds();
    const near = (a, b) => Math.abs(a - b) <= 2;
    if (!(near(current.x, next.x) && near(current.y, next.y) &&
        near(current.width, next.width) && near(current.height, next.height))) {
        win.setBounds(next);
        win._petCachedPos = { x: next.x, y: next.y };
        schedulePetBoundsRepair(win, next);
        console.log(`窗口调整: ${next.width}x${next.height} at (${next.x}, ${next.y})`);
    }
    return target;
}

// 创建/跨屏后多次重申窗口边界：抵消创建期被夹到 workArea，以及跨不同 DPI 屏时 Electron 单次
// setBounds 把尺寸算错。
//
// 关键：每次调用先取消该窗口上一轮“尚未触发”的重申计时器。否则快速来回切屏时，上一次切到 A 屏
// 排的 500/1500ms 延迟重申，会在已经切到 B 屏后触发、把窗口拽回 A 屏的尺寸/位置，两边互相打架
// 导致窗口尺寸错乱、模型与光标错位。
function schedulePetBoundsRepair(win, targetBounds) {
    if (!win || !targetBounds) return;
    if (win._petDragging) return;        // 同上
    if (win._petBoundsRepairTimers) {
        for (const t of win._petBoundsRepairTimers) clearTimeout(t);
    }
    win._petBoundsRepairTimers = [];
    // 容差 2px：off-by-one + DPI 取整会让 getBounds 比目标大 1~2px，足够接近就不再重申，避免无谓抖动。
    const near = (a, b) => Math.abs(a - b) <= 2;
    [0, 50, 300, 800].forEach((delay) => {
        const id = setTimeout(() => {
            if (!win || win.isDestroyed()) return;
            const b = win.getBounds();
            if (near(b.x, targetBounds.x) && near(b.y, targetBounds.y) &&
                near(b.width, targetBounds.width) && near(b.height, targetBounds.height)) return;
            try {
                win.setBounds(targetBounds);
                win._petCachedPos = { x: targetBounds.x, y: targetBounds.y };
            } catch (e) {
                console.error('[PetBoundsRepair] setBounds 失败:', e.message);
            }
        }, delay);
        win._petBoundsRepairTimers.push(id);
    });
}

// 跨屏切换时，Electron 首次 setBounds 会用错误缩放因子把尺寸算错（副屏→主屏常“过冲”到比目标更大），
// 随后由 schedulePetBoundsRepair 修正，中间一两帧会“闪跳”。切屏期间把窗口透明度降到 0
// 遮住过渡，待 getBounds 收敛到目标尺寸后再恢复原透明度。
function hidePetForMove(win) {
    if (!win || win.isDestroyed()) return;
    if (win._petHidden) return; // 已在切屏过渡中，不重复记录原透明度
    try {
        win._petPrevOpacity = win.getOpacity();
        win._petHidden = true;
        win.setOpacity(0);
    } catch (e) { try { __silentAudit.audit('main.js:423', e); } catch (e2) {} }
}

function revealPetAfterMove(win, targetBounds) {
    if (!win || win.isDestroyed()) return;
    if (win._petRevealPoll) { clearInterval(win._petRevealPoll); win._petRevealPoll = null; }
    const near = (a, b) => Math.abs(a - b) <= 2;
    const start = Date.now();
    let settledAt = null;
    win._petRevealPoll = setInterval(() => {
        if (!win || win.isDestroyed()) { clearInterval(win._petRevealPoll); win._petRevealPoll = null; return; }
        const b = win.getBounds();
        const settled = near(b.x, targetBounds.x) && near(b.y, targetBounds.y) &&
            near(b.width, targetBounds.width) && near(b.height, targetBounds.height);
        if (settled && settledAt === null) settledAt = Date.now();
        // 关键：尺寸“稳定”仅代表窗口边界到位，渲染端此时可能还没以新屏尺寸重排/重绘完成。
        // 再多等 ~120ms 宽限期让渲染端画好，再恢复显示，避免恢复瞬间露出未重绘的过渡帧（闪一下）。
        // 800ms 硬兜底，任何情况下都不会永久隐藏。
        if ((settledAt !== null && Date.now() - settledAt >= 120) || Date.now() - start > 800) {
            try { win.setOpacity(win._petPrevOpacity != null ? win._petPrevOpacity : 1); } catch (e) { try { __silentAudit.audit('main.js:442', e); } catch (e2) {} }
            win._petHidden = false;
            clearInterval(win._petRevealPoll);
            win._petRevealPoll = null;
        }
    }, 16);
}

// 8103 浏览器来源写令牌（2026-11-21 红队 P1）：
// 与 petbridge/vts-server.mjs 的 resolveControlToken 读同一个文件、同一套路径推导。
// 皮套窗 nodeIntegration=true，渲染层从 process.argv 读 --pet-control-token；
// 网页页面读不到进程参数，泄漏面只有本机同用户进程。
// 主进程先建窗、1.5s 后才起 8103 服务，所以这里先生成/读取，服务端随后读同一份。
function readOrCreatePetControlToken () {
    const file = path.join(path.dirname(configPath), '..', 'data', '.control-token');
    try {
        const existing = fs.readFileSync(file, 'utf8').trim();
        if (existing) return existing;
    } catch (e) { /* 首次启动：下面生成 */ }
    const token = require('crypto').randomBytes(32).toString('hex');
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, token + '\n', { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, file);
        try { fs.chmodSync(file, 0o600); } catch (e) { /* Windows 无 POSIX 权限语义 */ }
    } catch (e) {
        // 并发启动：另一个进程可能刚好写成功，优先用盘上那份，避免两边令牌不一致
        try {
            const raced = fs.readFileSync(file, 'utf8').trim();
            if (raced) return raced;
        } catch (e2) { /* 确实没有可读文件 */ }
        console.error('[control-auth] 写 .control-token 失败（本进程内渲染层仍可用）:', e && e.message || e);
    }
    return token;
}

// ── 真实呈现帧率探针（2026-11-22 性能轮）─────────────────────────────────
// 为什么不能用 rAF：requestAnimationFrame 只是「调度器愿意跑 JS」的频率，
// 冻结渲染时它照样 100+fps，但画面根本没有提交给合成器。
// webContents.beginFrameSubscription 的回调只在渲染器**真正提交一帧**时触发，
// 这才是呈现帧率。
//
// 零开销契约：不调用 start 就完全不加订阅、不挂每帧回调、不累积数组；
// stop 会 endFrameSubscription，恢复成「什么都没有」。
// 采样只在 start/stop 之间，避免长期观测把内存和 CPU 吃掉。
const __FRAME_PROBES = new Map();   // webContents.id -> probe
let __frameStatsIpcBound = false;

function __summarizeFrameProbe(probe) {
    const gaps = probe.gaps.slice().sort((a, b) => a - b);
    const now = performance.now();
    const ms = probe.startedAt
        ? Math.max(0, (probe.active ? now : (probe.stoppedAt || probe.startedAt)) - probe.startedAt)
        : 0;
    return __summarizeFrameGaps(gaps, ms, {
        frames: probe.frames,
        firstFrameMs: probe.firstAt ? Math.round((probe.firstAt - probe.startedAt) * 10) / 10 : null,
        active: probe.active,
        source: 'beginFrameSubscription',
        capFps: 30,
        note: 'Electron frame_subscriber.cc 把捕获周期硬编码为 1/30s；冻结渲染时仍按 30fps 回调，不能单独作为呈现帧率证据（用 __petFrameCast/__petFrameTrace）',
    });
}

// 帧间隔 → 统计。gaps 已排序，frames 是窗口内提交的帧数。
function __summarizeFrameGaps(gaps, ms, extra) {
    const frames = extra && Number.isFinite(extra.frames) ? extra.frames : gaps.length + 1;
    const fps = ms > 0 ? frames / (ms / 1000) : 0;
    // nearest-rank 分位：p50 用 ceil(p*n)-1，小样本时自然落到最后一帧，不会越界
    const pct = (p) => {
        if (!gaps.length) return 0;
        const idx = Math.min(gaps.length - 1, Math.max(0, Math.ceil(p * gaps.length) - 1));
        return Math.round(gaps[idx] * 100) / 100;
    };
    const longFrames = gaps.reduce((n, g) => n + (g > 33 ? 1 : 0), 0);
    const out = {
        ms: Math.round(ms),
        frames,
        fps: Math.round(fps * 10) / 10,
        p50: pct(0.5),
        p95: pct(0.95),
        p99: pct(0.99),
        longFrames,
        longPct: gaps.length ? Math.round((longFrames / gaps.length) * 1000) / 10 : 0,
        maxGapMs: gaps.length ? Math.round(gaps[gaps.length - 1] * 10) / 10 : 0,
        ...(extra || {}),
    };
    return out;
}

function __createFrameProbe(win) {
    const probe = {
        active: false, subscribed: false,
        startedAt: 0, stoppedAt: 0,
        frames: 0, firstAt: 0, lastAt: 0,
        gaps: [], maxGap: 0,
    };
    // 只有订阅存在时才会被调用；stop 后订阅被移除，这个函数不再有任何触发者。
    const onFrame = () => {
        if (!probe.active) return;
        const t = performance.now();
        if (probe.lastAt > 0) {
            const gap = t - probe.lastAt;
            if (probe.gaps.length < 200000) probe.gaps.push(gap);   // ~55 分钟 @60fps 的上限，防无限增长
            if (gap > probe.maxGap) probe.maxGap = gap;
        } else {
            probe.firstAt = t;
        }
        probe.lastAt = t;
        probe.frames += 1;
    };
    probe.start = () => {
        if (probe.active) return __summarizeFrameProbe(probe);
        if (win.isDestroyed()) return { error: 'window destroyed' };
        probe.active = true;
        probe.startedAt = performance.now();
        probe.stoppedAt = 0;
        probe.frames = 0; probe.firstAt = 0; probe.lastAt = 0;
        probe.gaps = []; probe.maxGap = 0;
        try {
            // onlyDirty=true：只回传脏矩形，避免每次整窗位图拷贝把观测成本推高
            win.webContents.beginFrameSubscription(true, onFrame);
            probe.subscribed = true;
        } catch (error) {
            probe.active = false;
            return { error: String(error && error.message || error) };
        }
        return __summarizeFrameProbe(probe);
    };
    probe.stop = () => {
        probe.stoppedAt = performance.now();
        probe.active = false;
        if (probe.subscribed) {
            try { win.webContents.endFrameSubscription(); } catch (e) { /* 窗口已销毁就算了 */ }
            probe.subscribed = false;
        }
        return __summarizeFrameProbe(probe);
    };
    probe.get = () => __summarizeFrameProbe(probe);
    return probe;
}

function __bindFrameStatsIpc() {
    if (__frameStatsIpcBound) return;
    __frameStatsIpcBound = true;
    ipcMain.handle('pet:frame-stats-start', (event) => {
        const probe = __FRAME_PROBES.get(event.sender.id);
        return probe ? probe.start() : { error: 'frame-stats probe not attached' };
    });
    ipcMain.handle('pet:frame-stats-stop', (event) => {
        const probe = __FRAME_PROBES.get(event.sender.id);
        return probe ? probe.stop() : { error: 'frame-stats probe not attached' };
    });
    ipcMain.handle('pet:frame-stats-get', (event) => {
        const probe = __FRAME_PROBES.get(event.sender.id);
        return probe ? probe.get() : { error: 'frame-stats probe not attached' };
    });

    // ── >30fps 的真实呈现帧迹 ────────────────────────────────────────────
    // Electron 的 beginFrameSubscription 在 frame_subscriber.cc 里把捕获周期硬编码为
    // kMaxFrameRate = 30（SetMinCapturePeriod(1/30)）。也就是说它最多只能告诉你
    // 「≥30fps」，永远测不出 60。要验证 60fps 阈值必须换一把尺子：
    // Chromium 自己的 Display::FrameDisplayed trace 带真实 present 时间戳，不限 30。
    // 只在显式 start→stop 之间录迹，默认零开销。
    let __frameTrace = null;
    ipcMain.handle('pet:frame-trace-start', async () => {
        if (__frameTrace) return { ok: true, already: true };
        const startedAt = Date.now();
        try {
            await contentTracing.startRecording({
                // 只开这一个类别：Display::FrameDisplayed 自身带 present 时间戳，
                // 不需要整包 viz 事件（那会把 17k 事件/秒写进 trace，观测成本反过来污染结果）。
                included_categories: ['disabled-by-default-display.framedisplayed'],
                recording_mode: 'record-until-full',
                trace_buffer_size_in_kb: 8192,
            });
        } catch (error) {
            return { error: String(error && error.message || error) };
        }
        __frameTrace = { startedAt };
        return { ok: true, startedAt };
    });
    ipcMain.handle('pet:frame-trace-stop', async () => {
        if (!__frameTrace) return { error: 'frame trace not active' };
        const startedAt = __frameTrace.startedAt;
        __frameTrace = null;
        const file = path.join(os.tmpdir(), 'pet-frame-trace-' + process.pid + '-' + Date.now() + '.json');
        try {
            await contentTracing.stopRecording(file);
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            const events = Array.isArray(parsed.traceEvents) ? parsed.traceEvents : [];
            const stamps = [];
            for (const e of events) {
                if (!e || e.name !== 'Display::FrameDisplayed') continue;
                const ts = Number(e.ts);
                if (Number.isFinite(ts)) stamps.push(ts / 1000);   // trace ts 是 µs
            }
            stamps.sort((a, b) => a - b);
            const gapsAll = [];
            for (let i = 1; i < stamps.length; i += 1) {
                const d = stamps[i] - stamps[i - 1];
                if (d >= 0) gapsAll.push(d);
            }
            // 同 screencast：丢掉起录冷启动的前 2 个间隔
            const gaps = gapsAll.slice(2).sort((a, b) => a - b);
            // 用首末帧时间戳算跨度：stopRecording 本身要 ~1s，用墙钟会把 fps 稀释掉。
            const spanMs = stamps.length > 1 ? Math.max(0, stamps[stamps.length - 1] - stamps[0]) : 0;
            const out = __summarizeFrameGaps(gaps, spanMs, {
                frames: stamps.length,
                source: 'Display::FrameDisplayed',
                tracedEvents: events.length,
                wallMs: Date.now() - startedAt,
                warmupDropped: Math.min(2, gapsAll.length),
            });
            // 帧间隔的平均频率 = (帧数-1)/跨度，避免把首帧自身算成一个间隔
            out.fps = spanMs > 0 ? Math.round(((stamps.length - 1) / (spanMs / 1000)) * 10) / 10 : 0;
            return out;
        } catch (error) {
            return { error: String(error && error.message || error) };
        } finally {
            try { fs.unlinkSync(file); } catch (e) { /* 临时文件清不掉不影响结果 */ }
        }
    });

    // ── 内容帧尺子（补 beginFrameSubscription 的两个硬伤）──────────────
    // 硬伤 1：frame_subscriber.cc 的 kMaxFrameRate=30，永远测不到 60。
    // 硬伤 2：实测冻结渲染（renderedFrames 不增长）时它仍按 30fps 回调，
    //        说明它是「按固定周期抓帧」而不是「有内容提交才回调」。
    // CDP Page.startScreencast 走 FrameSinkVideoCapturer（默认 min period 10ms），
    // 只在目标真的产出新帧时回调，时间戳是抓帧时刻，能测到 60fps 档位。
    // 32×32 的缩略图把编码成本压到最低；每帧立刻 ack，避免 2 帧在途限流。
    let __frameScreencast = null;
    ipcMain.handle('pet:frame-screencast-start', async (event) => {
        if (__frameScreencast) return { ok: true, already: true };
        const wc = event.sender;
        let attachedHere = false;
        try {
            if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); attachedHere = true; }
        } catch (error) {
            return { error: 'debugger attach failed: ' + String(error && error.message || error) };
        }
        const stamps = [];
        const onMessage = (_e, method, params) => {
            if (method !== 'Page.screencastFrame') return;
            const ts = Number(params && params.metadata && params.metadata.timestamp);
            if (Number.isFinite(ts)) stamps.push(ts * 1000);
            try { wc.debugger.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {}); } catch (e) { /* ignore */ }
        };
        wc.debugger.on('message', onMessage);
        try {
            await wc.debugger.sendCommand('Page.startScreencast', {
                format: 'jpeg', quality: 1, maxWidth: 32, maxHeight: 32, everyNthFrame: 1,
            });
        } catch (error) {
            try { wc.debugger.removeListener('message', onMessage); } catch (e) {}
            if (attachedHere) { try { wc.debugger.detach(); } catch (e) {} }
            return { error: 'startScreencast failed: ' + String(error && error.message || error) };
        }
        __frameScreencast = { wc, stamps, onMessage, attachedHere, startedAt: Date.now() };
        return { ok: true };
    });
    ipcMain.handle('pet:frame-screencast-stop', async () => {
        if (!__frameScreencast) return { error: 'screencast not active' };
        const s = __frameScreencast;
        __frameScreencast = null;
        try { await s.wc.debugger.sendCommand('Page.stopScreencast'); } catch (e) { /* ignore */ }
        try { s.wc.debugger.removeListener('message', s.onMessage); } catch (e) { /* ignore */ }
        if (s.attachedHere) { try { s.wc.debugger.detach(); } catch (e) { /* ignore */ } }
        const stamps = s.stamps.slice().sort((a, b) => a - b);
        const gapsAll = [];
        for (let i = 1; i < stamps.length; i += 1) {
            const d = stamps[i] - stamps[i - 1];
            if (d >= 0) gapsAll.push(d);
        }
        // 丢掉前 2 个间隔：startScreencast 的首次抓帧有 100~200ms 冷启动，
        // 不丢的话短窗口 p99 全是这个冷启动，会把稳态抖动盖掉。
        const gaps = gapsAll.slice(2).sort((a, b) => a - b);
        const spanMs = stamps.length > 1 ? Math.max(0, stamps[stamps.length - 1] - stamps[0]) : 0;
        const out = __summarizeFrameGaps(gaps, spanMs, {
            frames: stamps.length,
            source: 'Page.screencastFrame',
            wallMs: Date.now() - s.startedAt,
            firstFrameMs: stamps.length ? Math.round((stamps[0] - s.startedAt) * 10) / 10 : null,
            warmupDropped: Math.min(2, gapsAll.length),
        });
        out.fps = spanMs > 0 ? Math.round(((stamps.length - 1) / (spanMs / 1000)) * 10) / 10 : 0;
        return out;
    });
}

function attachPetFrameStats(win) {
    if (!win || win.isDestroyed()) return null;
    __bindFrameStatsIpc();
    const wcId = win.webContents.id;
    const probe = __createFrameProbe(win);
    __FRAME_PROBES.set(wcId, probe);

    // 渲染层便捷入口：window.__petFrameStats = { start, stop, get }。
    // 只在 did-finish-load 注入一次（页面重载会再触发），不建立任何轮询/监听。
    const installBridge = () => {
        if (win.isDestroyed()) return;
        const code = `(() => {
  try {
    const { ipcRenderer } = require('electron');
    window.__petFrameStats = {
      start: () => ipcRenderer.invoke('pet:frame-stats-start'),
      stop: () => ipcRenderer.invoke('pet:frame-stats-stop'),
      get: () => ipcRenderer.invoke('pet:frame-stats-get'),
    };
    // >30fps 的补充尺子（Electron frame subscription 有 30fps 硬上限）
    window.__petFrameTrace = {
      start: () => ipcRenderer.invoke('pet:frame-trace-start'),
      stop: () => ipcRenderer.invoke('pet:frame-trace-stop'),
    };
    // 内容帧尺子：只在画面真的产出新帧时回调（CDP screencast）
    window.__petFrameCast = {
      start: () => ipcRenderer.invoke('pet:frame-screencast-start'),
      stop: () => ipcRenderer.invoke('pet:frame-screencast-stop'),
    };
    return true;
  } catch (error) {
    return String(error && error.message || error);
  }
})()`;
        win.webContents.executeJavaScript(code).catch(() => { /* 页面未就绪时由 did-finish-load 再来一次 */ });
    };
    win.webContents.on('did-finish-load', installBridge);
    installBridge();

    win.on('closed', () => {
        probe.active = false;
        if (probe.subscribed) {
            try { win.webContents.endFrameSubscription(); } catch (e) { /* ignore */ }
            probe.subscribed = false;
        }
        __FRAME_PROBES.delete(wcId);
    });
    return probe;
}

function createWindow () {
    // 读取配置
    let config = {};
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        console.error('读取配置失败:', e);
    }

    // ===== 跨屏方案：恢复 6.55 巨窗并集。拖到副屏靠画布坐标，不再整窗跳单屏。 =====
    const displays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();
    displays.forEach((display, index) => {
        const { x, y, width, height } = display.bounds;
        console.log(`显示器 ${index}: id=${display.id}, x=${x}, y=${y}, width=${width}, height=${height}, scale=${display.scaleFactor}`);
    });
    const union = computePetWindowBounds(config, displays, primaryDisplay);
    const minX = union.minX;
    const minY = union.minY;
    const totalWidth = union.totalWidth;
    const totalHeight = union.totalHeight;

    console.log(`=== 窗口创建信息（6.55 巨窗并集）===`);
    console.log(`screen_extend: ${JSON.stringify(union.screenExtend)}, 显示器数量=${union.displayCount}`);
    console.log(`总边界: minX=${minX}, minY=${minY}, maxX=${union.maxX}, maxY=${union.maxY}`);
    console.log(`计算的窗口尺寸: ${totalWidth}x${totalHeight}`);
    console.log(`窗口位置: (${minX}, ${minY})`);
    
    const win = new BrowserWindow({
        x: minX,
        y: minY,
        width: totalWidth,
        height: totalHeight,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        focusable: true,
        type: 'desktop',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true,
            zoomFactor: 1.0,
            enableWebSQL: true,
            // 8103 写令牌：渲染层从 process.argv 读，POST 时带 X-Pet-Token
            // （Origin=file:// 的浏览器来源请求没有令牌会被 403，见 petbridge/vts-server.mjs）。
            additionalArguments: ['--pet-control-token=' + readOrCreatePetControlToken()],
            // 2026-11-15 六十三轮：皮套窗口被别的窗口挡住/全屏游戏盖住时，Chromium 会把页面标成
            // hidden 并**暂停 requestAnimationFrame** → 她不眨眼、不呼吸、不换表情（用户实测：
            // 「说话时眼睛也不动」）。桌面宠物必须一直动，所以关掉后台节流。
            backgroundThrottling: false
        },
        resizable: true,
        movable: true,
        skipTaskbar: true,
        maximizable: false,
    })
    win.__isPetWindow = true;   // 尺寸看门狗识别用
    win.setAlwaysOnTop(true, 'screen-saver')
    // 默认「可交互」：之前无条件 setIgnoreMouseEvents(true) 会让所有按钮和拖动失效，
    // 连打字框都点不到。透明区域的穿透改由渲染层按 elementFromPoint / 模型 alpha 判定来切。
    const startIgnoring = !!(config.ui && config.ui.click_through_default === true);
    win.setIgnoreMouseEvents(startIgnoring, { forward: true });
    global.__petIgnoreMouse = startIgnoring;
    // 立刻登记窗口引用：字幕副窗（下面几百行才创建）与设置窗定位都靠它。
    // 原来只在 setUpTray() 里赋值，那时字幕窗早已用 null 算过一次位置了。
    petWinRef = win
    // 托盘菜单文案必须跟着窗口可见性走。以前只有托盘自己的点击/右键会 rebuild，
    // 皮套右键「先藏起来」(hide-pet) 直接 win.hide() 却不重建 → 下次打开托盘还写着
    // 「隐藏桌宠」，点下去按真实状态 show()，看起来就是「点隐藏反而出来了」。
    // 统一订阅 show/hide：任何路径（右键、托盘、程序内）藏/显都会刷新菜单。
    try {
        const refreshTray = () => { try { if (petTrayRebuild) petTrayRebuild(); } catch (e) { /* 托盘未就绪 */ } };
        win.on('show', refreshTray);
        win.on('hide', refreshTray);
    } catch (e) { /* 老 Electron 无事件时退回各调用点 rebuild */ }
    win.setMenu(null)
    // 真实呈现帧率探针：默认零开销，只有 start→stop 之间才订阅合成器帧。
    // 渲染层用 window.__petFrameStats.start/stop/get，或经 8004 /eval 调 ipcRenderer。
    attachPetFrameStats(win)
    // 2026-11-21 红队审计 P1：本窗口 nodeIntegration=true + contextIsolation=false，
    // 一旦被导航到外部页面（聊天里的链接 / window.open / 注入的 location=），
    // 外部页面就拿到 Node 权限 = RCE。桌宠是纯本地 SPA，导航与弹窗都不需要。
    try {
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        win.webContents.on('will-navigate', (event, target) => {
            if (!/^file:\/\//i.test(String(target || ''))) event.preventDefault()
        })
    } catch (error) { /* 老 Electron 没有该 API 时不阻断启动 */ }

    // ── 眼神跟随：每 100ms 把全局光标坐标发给渲染层 ──────────────────────
    // 桌宠窗口只有 420×760，鼠标绝大多数时间在窗口外，渲染层收不到 mousemove，
    // 所以必须由主进程轮询 screen.getCursorScreenPoint()。
    try {
      let cursorTickFails = 0;
      const cursorTimer = setInterval(() => {
        try {
          if (!win || win.isDestroyed() || !win.isVisible()) return;
          const pt = screen.getCursorScreenPoint();
          const b = win.getBounds();
          // 把窗口矩形一起发过去：渲染层的 window.screenX 含边框/标题栏，
          // 和真实窗口位置差一百多像素，会让"正前方"偏掉。
          win.webContents.send('pet:cursor', { x: pt.x, y: pt.y, bx: b.x, by: b.y, bw: b.width, bh: b.height });
          cursorTickFails = 0;
        } catch (e) {
          // 静默治理：光标广播死了=眼神跟随失明（交接踩过的坑），首错与每 100 连错必须留痕
          cursorTickFails += 1;
          if (cursorTickFails === 1 || cursorTickFails % 100 === 0) console.error('[pet] 光标广播连续失败 x' + cursorTickFails + ': ' + (e && e.message || e));
        }
      }, 100);
      if (cursorTimer.unref) cursorTimer.unref();
      win.on('closed', () => clearInterval(cursorTimer));
    } catch (e) { try { __silentAudit.audit('main.js:536', e); } catch (e2) {} }

    // ── 让她从自己的截图里消失 ────────────────────────────────────────────
    // 她的「眼睛」是整屏截图。如果不做处理，截到的是「桌面 + 她自己」——
    // 于是摘要永远在说「中间浮着半透明深色窗口」，那是她自己的打字框。
    // Windows 上 setContentProtection(true) 走 WDA_EXCLUDEFROMCAPTURE，
    // 窗口会对所有截屏 API 隐形，但她自己照常显示。
    //
    // ⚠ 2026-11-09 重要修正（用户实测：桌面看得到、直播和截图看不到）：
    // 这个防截屏是**全局**的——它不只挡她自己，也挡 OBS/直播姬/你按 PrintScreen。
    // 所以现在改成：**默认关闭全局隐身**，改用「截图前临时解除、截完恢复」的方案
    // （见 ipcMain.handle('take-screenshot')），两全其美：
    //   她自己的感知照旧不会拍到自己，而直播/你的截图始终正常。
    // 仍保留配置项给需要「彻底隐身」的场景（比如她出现在不该录的画面里）。
    try {
        const hideFromShot = (config.ui && config.ui.hide_from_screenshot) === true;   // 默认 false（原为 !== false 即默认 true）
        win.setContentProtection(hideFromShot);
        win.__contentProtected = hideFromShot;
        console.log('[pet] 全局截屏隐身 =', hideFromShot, '（hide_from_screenshot；false 时直播/截图正常，她自己截图仍会临时隐身）');
    } catch (error) {
        console.warn('[pet] 截屏隐身设置失败:', error && error.message || error);
    }
    // 托盘：桌宠没有任务栏入口，靠它开关/置顶/自启/退出
    try { setUpTray(win); } catch (error) { console.error('[tray] 启动失败:', error && error.message || error); }

    // ── 看门狗的统一记账（2026-11-15 五十八轮）──────────────────────────────
    // 为什么不用 runtime.log：那是**渲染层**写的（js/api-utils.js），渲染进程一冻就停，
    // 把「渲染层健康」的告警写在那儿等于没告警。所以单开一份主进程自己的账。
    function watchdogNote(line) {
        const d = new Date();
        const p2 = (n) => String(n).padStart(2, '0');
        const stamp = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
        console.warn('[render-watchdog] ' + line);
        try {
            const logFile = path.join(__dirname, 'render-watchdog.log');
            if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) {
                try { fs.renameSync(logFile, logFile + '.1'); } catch (e) { /* 轮转失败就算了，别让日志把自己搞崩 */ }
            }
            fs.appendFileSync(logFile, '[' + stamp + '] ' + line + '\n', 'utf8');
        } catch (e) { /* 写日志失败不能再抛：看门狗必须自己能活 */ }
    }

    // ── 通用「窗口还活着吗」探针（2026-11-15 五十八轮）─────────────────────────
    // 给**没有 8102 那条 WS** 的窗口用（目前是字幕副窗 960×264）：它也是独立渲染进程，
    // 崩了同样没人管。判据 = executeJavaScript('1') 带 5s 超时，连续 2 次（≈60s）不成 → reload。
    function startWindowPingWatchdog(targetWin, label) {
        const PING_TIMEOUT_MS = 5000;
        const COOLDOWN_MS = 10 * 60 * 1000;
        let strikes = 0;
        let lastReloadAt = 0;
        let healedPending = false;
        const tick = async () => {
            if (!targetWin || targetWin.isDestroyed()) return;
            let alive = false;
            try {
                alive = await Promise.race([
                    Promise.resolve(targetWin.webContents.executeJavaScript('1')).then((v) => v === 1),
                    new Promise((resolve) => setTimeout(() => resolve(false), PING_TIMEOUT_MS)),
                ]);
            } catch (e) { alive = false; }
            if (alive) {
                // 恢复也要留痕：只记「判死/reload」而没有「好了」，等于有罪状没结案。
                if (healedPending) { watchdogNote(label + '：reload 后已恢复（探针通了）'); healedPending = false; }
                else if (strikes > 0) watchdogNote(label + '：探针恢复（此前连续失败 ' + strikes + ' 次）');
                strikes = 0;
                return;
            }
            strikes += 1;
            watchdogNote(label + '：探针 ' + PING_TIMEOUT_MS + 'ms 无响应（第 ' + strikes + ' 次）');
            if (strikes < 2) return;
            if (Date.now() - lastReloadAt < COOLDOWN_MS) return;
            lastReloadAt = Date.now();
            strikes = 0;
            healedPending = true;
            watchdogNote(label + '：连续判死，reload');
            try { targetWin.webContents.reload(); } catch (e) { watchdogNote(label + '：reload 抛错 ' + (e && e.message || e)); }
        };
        const timer = setInterval(() => { tick().catch(() => {}); }, 30000);
        if (timer && typeof timer.unref === 'function') timer.unref();
        watchdogNote(label + '：探针看门狗已启动（30s 一次，5s 超时 ×2 判死）');
        return { tick };
    }

    // ── 渲染层存活看门狗（2026-11-15 五十八轮）────────────────────────────
    // 症状（实测一整夜没人发现）：窗口还在、主进程还在，但页面 JS 静默冻死 ——
    //   8004 /eval 连 `1+1` 都不回、capturePage 出 0×0 / 0 字节、8102 断开后不再重连、
    //   runtime.log 自 00:19 起一行不写。她在屏幕上就是一张死图，没有任何告警。
    // 判据唯一来源：petbridge/render-liveness.js（8102 连接数 + render-health 新鲜度）。
    // 恢复：先 reload 页面（比重启宿主轻）；reload 无效再 forcefullyCrashRenderer + reload。
    //   10 分钟最多动一次、连试 3 次不成改人工 —— 不许「重启风暴」打断用户正在说的话。
    function startRenderWatchdog(petWin) {
        const COOLDOWN_MS = 10 * 60 * 1000;
        const MAX_ATTEMPTS = 3;
        let lastActionAt = 0;
        let attempts = 0;
        let lastState = '';
        let lastHumanWarnAt = 0;
        // 单独记账：runtime.log 是渲染层写的，冻死时它自己也停了 —— 告警不能写在那儿。
        const note = watchdogNote;
        // 自愈动作（判死与「渲染进程崩溃」共用同一套刹车：10 分钟一次、最多 3 次）
        const heal = (why) => {
            const now = Date.now();
            if (attempts >= MAX_ATTEMPTS) {
                // 已经是人工活：别再无脑 reload，只在每个冷却窗口提醒一次。
                if (now - lastHumanWarnAt > COOLDOWN_MS) {
                    lastHumanWarnAt = now;
                    note('连续 ' + attempts + ' 次自愈都没救回来，停止自动动作；需人工 pwsh -NoProfile -File pet-runtime/tools/restart-pet.ps1');
                }
                return;
            }
            if (now - lastActionAt < COOLDOWN_MS) return;
            attempts += 1;
            lastActionAt = now;
            if (attempts === 1) {
                note('第 1 次自愈（' + why + '）：reload 页面');
                petWin.webContents.reload();
            } else {
                note('第 ' + attempts + ' 次自愈（' + why + '）：forcefullyCrashRenderer + reload（reload 都没生效，说明渲染进程已僵死）');
                try { petWin.webContents.forcefullyCrashRenderer(); } catch (e) { note('forcefullyCrashRenderer 抛错：' + (e && e.message || e)); }
                setTimeout(() => {
                    try { if (petWin && !petWin.isDestroyed()) petWin.webContents.reload(); } catch (e) { note('二次 reload 抛错：' + (e && e.message || e)); }
                }, 800);
            }
        };
        // ── 内存哨兵（2026-11-15）────────────────────────────────────────────
        // 崩溃归因只做到「不是 JS 堆泄漏」这一步：历史异常码没留下（Windows 不记渲染进程
        // 崩溃、当时也没开 crashReporter）。那就把内存变成**持续可观测** —— 越过阈值就记账，
        // 下次真崩了至少有「崩之前多大」这条线。阈值取当前常态（~750MB）的两倍，避免噪声。
        let memTick = 0;
        let lastMemWarnAt = 0;
        const MEM_WARN_MB = 1600;
        const memCheck = async () => {
            try {
                if (!petWin || petWin.isDestroyed()) return;
                const info = await petWin.webContents.getProcessMemoryInfo();
                const privMB = Math.round((Number(info.private) || 0) / 1024);   // 接口单位是 KB
                const rssMB = Math.round((Number(info.residentSet) || 0) / 1024);
                const peakMB = Math.round((Number(info.peakResidentSet) || 0) / 1024);
                const tooBig = rssMB >= MEM_WARN_MB || privMB >= MEM_WARN_MB;
                if (tooBig && Date.now() - lastMemWarnAt > 10 * 60 * 1000) {
                    lastMemWarnAt = Date.now();
                    note('内存偏高：private=' + privMB + 'MB rss=' + rssMB + 'MB（峰值 ' + peakMB + 'MB，阈值 ' + MEM_WARN_MB + 'MB）—— 渲染进程此前有「静默崩溃」史，注意 OOM');
                }
            } catch (e) { /* 内存读不到不算故障，别让哨兵自己刷屏 */ }
        };

        const tick = () => {
            try {
                if (!petWin || petWin.isDestroyed()) return;
                const srv = global.__petServer;
                if (!srv || typeof srv.rendererLiveness !== 'function') return;
                const live = srv.rendererLiveness();
                if (live.state !== lastState) {
                    if (live.state === 'offline') note('判死：' + live.detail);
                    else if (live.state === 'stale') note('可疑：' + live.detail);
                    else if (live.state === 'ok' && lastState) note('恢复：渲染层在线（' + lastState + ' → ok）');
                    lastState = live.state;
                }
                if (live.state === 'ok') {
                    if (attempts > 0) note('自愈成功（累计 ' + attempts + ' 次动作），计数器清零');
                    attempts = 0;
                    // 每 10 个 tick（约 2.5 分钟）量一次内存；渲染层活着时这个调用才有意义
                    memTick += 1;
                    if (memTick % 10 === 0) memCheck().catch(() => {});
                    return;
                }
                if (live.state !== 'offline') return;
                heal('8102 无连接');
            } catch (e) {
                // 看门狗自己出错也必须留痕，别再留一个「静默失败」
                try { console.error('[render-watchdog] tick 抛错:', e && e.message || e); } catch (e2) {}
            }
        };
        // Electron 内建信号：以前一个都没监听，这类事件连一行日志都留不下。
        try {
            petWin.webContents.on('unresponsive', () => note('Electron: 渲染进程无响应（页面 30s 没处理 IPC）'));
            petWin.webContents.on('responsive', () => note('Electron: 渲染进程恢复响应'));
            petWin.webContents.on('render-process-gone', (_e, details) => {
                const reason = (details && details.reason) || 'unknown';
                note('Electron: 渲染进程消失 reason=' + reason + ' exitCode=' + (details && details.exitCode));
                // 崩溃的渲染进程**永远不会自己回来**（Electron 只留一张空白窗口）——
                // 2026-11-14 00:19 那 3.5 小时就是这么来的。所以立刻救，不等 60s 宽限。
                if (reason !== 'clean-exit') setTimeout(() => heal('渲染进程崩溃'), 600);
            });
        } catch (e) { try { console.error('[render-watchdog] 挂监听失败:', e && e.message || e); } catch (e2) {} }
        const timer = setInterval(tick, 15000);
        if (timer && typeof timer.unref === 'function') timer.unref();
        note('已启动（判死 = 60s 无 8102 连接；自愈 = 10 分钟一次、最多 3 次）');
        return { tick, note };
    }

    // 我们的「VTS 兼容 + HTTP 控制 + 派活」协议层：随宿主启动，端口可用 PET_* 覆盖。
    if (!global.__petbridgeStarted) {
        global.__petbridgeStarted = true;
        // 世界感知的可读口（2026-11-17 六十二轮）：世界状态住在渲染层的
        // community/world-sense 插件里，主进程不复制一份（两份状态必然分叉）。
        // 这里只做一次 executeJavaScript 取值，8004/8103 共用同一个读取器。
        const readWorld = async () => {
            try {
                if (!win || win.isDestroyed()) return null;
                return await win.webContents.executeJavaScript(
                    '(globalThis.__worldSenseState && typeof globalThis.__worldSenseState === "function")'
                    + ' ? globalThis.__worldSenseState() : null'
                );
            } catch (error) {
                return { ok: false, error: String(error && error.message || error) };
            }
        };
        global.__readWorldState = readWorld;
        // 世界感知开关的写入口（8103 POST /world）：落盘 + 推给渲染层。
        // 推给渲染层这一步不能省 —— 插件的 config 是启动时的那一份，不推就不会变。
        const writeWorldConfig = async (patch) => {
            const merged = updateWorldSenseConfig(patch || {});
            try {
                if (win && !win.isDestroyed()) {
                    await win.webContents.executeJavaScript(
                        'globalThis.__worldSenseConfig = ' + JSON.stringify(merged || {}) + ';'
                    );
                }
            } catch (error) {
                console.error('[world-sense] 推配置到渲染层失败:', error && error.message || error);
            }
            return { ok: true, world_sense: merged };
        };
        global.__writeWorldConfig = writeWorldConfig;
        setTimeout(async () => {
            try {
                const { startVtsServer } = await import('./petbridge/vts-server.mjs');
                const { buildModelInfo } = await import('./petbridge/model-info.mjs');
                const model = buildModelInfo();
                global.__petServer = startVtsServer({
                    port: Number(process.env.PET_VTS_PORT || 8001),
                    internalPort: Number(process.env.PET_INNER_PORT || 8102),
                    controlPort: Number(process.env.PET_CONTROL_PORT || 8103),
                    model,
                    // 静默版：开机即省钱模式（config.cost.quiet，缺省开），/quiet 切换时持久化
                    configPath,
                    quietDefault: !(config.cost && config.cost.quiet === false),
                    getWorld: readWorld,
                    setWorld: writeWorldConfig,
                });
                console.log('[petbridge] VTS 8001 / 内部 8102 / HTTP 8103 已启动，热键', (model.hotkeys || []).length);
                // 渲染层存活看门狗：依赖 8102 的连接记账，必须在 vts 起好之后挂。
                try { startRenderWatchdog(win); } catch (error) { console.error('[render-watchdog] 启动失败:', error && error.message || error); }
                // 字幕副窗没有 8102 那条 WS，用探针判活（五十八轮 §41.3-1 的欠账）
                try {
                    const subWin = global.__subtitleWin;
                    if (subWin && !subWin.isDestroyed()) startWindowPingWatchdog(subWin, '字幕副窗');
                    else console.warn('[render-watchdog] 字幕副窗还没创建，跳过它的探针（它崩了目前无人看管）');
                } catch (error) { console.error('[render-watchdog] 字幕副窗看门狗启动失败:', error && error.message || error); }
                // 自检通道：对真窗口截图/量几何/注入点击，用来「自己用一遍再确认」。
                if (process.env.PET_DEVTOOLS !== '0') {
                    try {
                        const { attachDevtools } = await import('./petbridge/devtools.mjs');
                        global.__petDevtools = attachDevtools(win, { port: Number(process.env.PET_DEVTOOLS_PORT || 8004), getWorld: readWorld });
                        // 字幕副窗的自检通道：/shot /bounds 用于验证与截图（P0-1 证据链）
                        const subWin = global.__subtitleWin;
                        if (subWin) global.__subtitleDevtools = attachDevtools(subWin, { port: Number(process.env.PET_SUB_DEVTOOLS_PORT || 8005) });
                    } catch (error) { console.error('[devtools] 挂载失败:', error && error.message || error); }
                }
            } catch (error) {
                console.error('[petbridge] 启动失败:', error && error.message || error);
            }
        }, 1500);
    }
    
    // 立即验证窗口尺寸
    const immediateBounds = win.getBounds()
    console.log(`窗口创建后立即尺寸: ${immediateBounds.width}x${immediateBounds.height}`)
    console.log(`窗口创建后立即位置: (${immediateBounds.x}, ${immediateBounds.y})`)
    
    // 创建后多次重申并集边界，抵消创建期被夹到 workArea；不再打回单屏。
    schedulePetBoundsRepair(win, { x: minX, y: minY, width: totalWidth, height: totalHeight })

    // ── 字幕独立窗口（决策 2026-11-01：字幕不许画在皮套窗口里）──────────────
    // 透明 / 鼠标穿透 / 置顶的副窗，跟在皮套下方（下方放不下自动翻上方）。
    // 文本由渲染层经 ipc 'subtitle:show' 推来；位置公式在 Rust 内核（pet-core cmd=subtitle）。
    try {
        const subtitleWin = new BrowserWindow({
            x: 0, y: 0, width: SUBTITLE_WINDOW_W, height: SUBTITLE_WINDOW_H,
            transparent: true, frame: false, hasShadow: false,
            alwaysOnTop: true, skipTaskbar: true, focusable: false,
            resizable: false, maximizable: false, minimizable: false,
            backgroundColor: '#00000000',
            webPreferences: { nodeIntegration: true, contextIsolation: false, zoomFactor: 1.0 },
        })
        subtitleWin.setAlwaysOnTop(true, 'screen-saver')
        subtitleWin.setIgnoreMouseEvents(true)   // 纯展示：永远鼠标穿透
        subtitleWin.setMenu(null)
        // 2026-11-21 红队审计 P1：字幕窗同样 nodeIntegration=true；它只负责显示一条
        // 字幕（textContent），不需要任何导航/弹窗 —— 一律禁止，防止被带到外部页面。
        try {
            subtitleWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
            subtitleWin.webContents.on('will-navigate', (event, target) => {
                if (!/^file:\/\//i.test(String(target || ''))) event.preventDefault()
            })
        } catch (error) { /* 老 Electron 没有该 API 时不阻断启动 */ }
        try { subtitleWin.setContentProtection((config.ui && config.ui.hide_from_screenshot) !== false) } catch (e) { try { __silentAudit.audit('main.js:610', e); } catch (e2) {} }
        subtitleWin.loadFile('subtitle.html')
        global.__subtitleWin = subtitleWin
        subtitleWin.__isSubtitleWindow = true   // PTT 等全局广播要跳过字幕窗（2026-11-09）
        subtitleWin.on('closed', () => { if (global.__subtitleWin === subtitleWin) global.__subtitleWin = null })
        // 皮套窗口一动（拖动/缩放/跨屏修复/换屏），字幕副窗跟着走
        for (const ev of ['move', 'resize', 'show', 'restore']) {
            win.on(ev, () => scheduleSubtitleReposition(ev));
        }
        screen.on('display-metrics-changed', () => scheduleSubtitleReposition('display-changed'));
        positionSubtitleWindow('init')

        // 位置校正定时器：只靠 move/resize 事件会漏（实测皮套从 2030 移到 2140
        // 时字幕窗还停在旧位置，因为那几帧是 setBounds 合批触发的，没生成 move 事件）。
        // 每 1.5 秒对比一次「当前应有的位置」与「实际位置」，差超过 2px 就纠正。
        if (globalThis.__subtitleDriftTimer) clearInterval(globalThis.__subtitleDriftTimer)
        globalThis.__subtitleDriftTimer = setInterval(() => {
            try {
                const sub2 = global.__subtitleWin
                if (!sub2 || sub2.isDestroyed() || !sub2.isVisible()) return
                if (globalThis.__subtitleAdjusting) return   // 调整模式：用户在拖，别抢
                const want = computeSubtitlePosition(SUBTITLE_WINDOW_W, SUBTITLE_WINDOW_H)
                if (!want) return
                const now = sub2.getBounds()
                if (Math.abs(now.x - want.x) > 2 || Math.abs(now.y - want.y) > 2) {
                    sub2.setPosition(want.x, want.y, false)
                    console.log('[subtitle] 位置漂移已纠正 →', want.x, want.y, '(' + (want.source || '') + ')')
                }
            } catch (e) { try { __silentAudit.audit('main.js:637', e); } catch (e2) {} }
        }, 1500)
        if (globalThis.__subtitleDriftTimer.unref) globalThis.__subtitleDriftTimer.unref()
    } catch (error) {
        console.error('[subtitle] 字幕副窗创建失败:', error && error.message || error)
    }

    // 项目根定位（2026-11-09 三十轮）：不数 '..' 层级 —— 踩过两次坑
    // （live-2d 在 _incoming/my-neuro/ 下，'..'×2 只到 _incoming 而不是项目根）。
    // 改为沿目录向上找含 pet-runtime/tools 的那一级。
    const findProjectRoot = (pathMod, start) => {
        let dir = start
        for (let i = 0; i < 10; i += 1) {
            try { if (fs.existsSync(pathMod.join(dir, 'pet-runtime', 'tools'))) return dir } catch (e) { /* 继续向上 */ }
            const up = pathMod.dirname(dir)
            if (up === dir) break
            dir = up
        }
        return start
    }

    // ── 游戏自动省电（2026-11-09）────────────────────────────────────────────
    // 用户诉求：「待机帧数太小看起来卡多加点吧」→ 平时必须满帧；
    // 但满帧一次 _model.update() 要 7ms，游戏时不该抢资源。
    // 这里每 3 秒检测前台是否游戏/全屏应用，命中就通知渲染层降频，退出自动恢复满帧。
    // 检测只读（枚举前台窗口），不走 API、不打扰。
    try {
        if (globalThis.__gameWatchTimer) clearInterval(globalThis.__gameWatchTimer)
        let lastGaming = null
        let lastLogAt = 0
        const probe = () => {
            try {
                const { execFile } = require('child_process')
                const pathMod = require('path')
                const root = findProjectRoot(pathMod, app.getAppPath())
                const script = pathMod.join(root, 'pet-runtime', 'tools', 'game-watch.cjs')
                if (!fs.existsSync(script)) return
                // 同 idle-detect：process.execPath 是 electron.exe，必须 ELECTRON_RUN_AS_NODE=1
                execFile(process.execPath, [script], {
                    windowsHide: true,
                    timeout: 5000,
                    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                },
                    (err, stdout, stderr) => {
                        if (err) {
                            if (!globalThis.__idleErrLogged) { globalThis.__idleErrLogged = true; console.log('[user-activity] 检测失败: ' + (err.message || err) + (stderr ? ' | ' + String(stderr).slice(0, 120) : '')) }
                            return
                        }
                        let d = null
                        try { d = JSON.parse(String(stdout || '').trim()) } catch (e) { console.log('[user-activity] 解析失败: ' + JSON.stringify(String(stdout || '').slice(0, 80))); return }
                        if (!d) return
                        const gaming = d.gaming === true
                        if (gaming !== lastGaming) {
                            lastGaming = gaming
                            const w = BrowserWindow.getAllWindows().find((x) => x.__isPetWindow)
                            if (w && !w.isDestroyed()) {
                                w.webContents.executeJavaScript(
                                    '(function(){' +
                                    'try{ if(window.petBody&&window.petBody.setPowerSave) window.petBody.setPowerSave(' + (gaming ? 'true' : 'false') + '); }catch(e){}' +
                                    // 🎮 陪玩模式联动（2026-11-09）：检测到游戏 → 打开陪玩（看画面但限速说话）；
                                    // 退出游戏 → 关闭。陪玩只在静默态生效（见 watch-screen._captureAndCheck）。
                                    'try{ const pm=window.pluginManager; const e=pm&&pm._plugins.get("community/watch-screen");' +
                                    '  if(e&&e.plugin){ e.plugin._gameCompanion=' + (gaming ? 'true' : 'false') + ';' +
                                    '   e.plugin._gameApp=' + JSON.stringify(String(d.app || '')) + ';' +
                                    '   e.plugin._gameReason=' + JSON.stringify(String(d.reason || '')) + '; } }catch(e){}' +
                                    'return 1;' +
                                    '})()'
                                ).catch(() => {})
                            }
                            if (Date.now() - lastLogAt > 5000) {
                                lastLogAt = Date.now()
                                console.log('[game-watch] ' + (gaming ? '检测到游戏/全屏应用 → 皮套省电模式 + 陪玩模式开启' : '游戏已退出 → 恢复满帧 + 关闭陪玩') + ' · ' + (d.reason || '') + (d.app ? ' · ' + d.app : ''))
                            }
                        }
                    })
            } catch (e) { try { __silentAudit.audit('main.js:game-watch', e); } catch (e2) {} }
        }
        probe()
        globalThis.__gameWatchTimer = setInterval(probe, 3000)
        if (globalThis.__gameWatchTimer.unref) globalThis.__gameWatchTimer.unref()
    } catch (e) { try { __silentAudit.audit('main.js:game-watch-init', e); } catch (e2) {} }

    // ── 用户活跃度检测（2026-11-09 三十轮）──────────────────────────────────
    // 她主动说话最尴尬的是「用户正在专注干活/开会」时插嘴。
    // 每 8 秒读一次系统最后一次输入时间（Win32 GetLastInputInfo，只读 <1ms）：
    //   active（30 秒内有输入）→ 在忙，别主动打扰
    //   idle（30 秒-5 分钟）  → 可能在想事，可以轻声说一句
    //   away（>5 分钟）       → 大概率离开，可以留句话
    // 结果挂到 global.__userActivity 供各主动说话模块判断。
    try {
        if (globalThis.__idleTimer) clearInterval(globalThis.__idleTimer)
        const probeIdle = () => {
            try {
                const { execFile } = require('child_process')
                const pathMod = require('path')
                const root = findProjectRoot(pathMod, app.getAppPath())
                const script = pathMod.join(root, 'pet-runtime', 'tools', 'idle-detect.cjs')
                if (!fs.existsSync(script)) return
                // ⚠ process.execPath 在 Electron 主进程里是 electron.exe，不是 node.exe！
                // 直接 execFile 它会当成 GUI 启动、stdout 什么都没有（2026-11-09 实测踩到）。
                // 必须置 ELECTRON_RUN_AS_NODE=1，让它以纯 Node 方式运行脚本。
                execFile(process.execPath, [script], {
                    windowsHide: true,
                    timeout: 4000,
                    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                },
                    (err, stdout, stderr) => {
                        if (err) {
                            if (!globalThis.__idleErrLogged) { globalThis.__idleErrLogged = true; console.log('[user-activity] 检测失败: ' + (err.message || err) + (stderr ? ' | ' + String(stderr).slice(0, 120) : '')) }
                            return
                        }
                        let d = null
                        try { d = JSON.parse(String(stdout || '').trim()) } catch (e) { console.log('[user-activity] 解析失败: ' + JSON.stringify(String(stdout || '').slice(0, 80))); return }
                        if (!d) return
                        const payload = {
                            idleMs: Number(d.idleMs) || 0,
                            state: String(d.state || 'unknown'),
                            busy: d.busy === true,
                            at: Date.now(),
                        }
                        global.__userActivity = payload
                        // 主进程 global 与渲染层不是同一个对象。渲染层只有一个稳定的 IPC 通道在用：
                        // 'pet:cursor'（100ms 一次的光标广播）。空闲状态变化不频繁，
                        // 用同一通道附带推送最省事——每次光标广播时一起带上，渲染层顺手更新。
                        try {
                            const w = BrowserWindow.getAllWindows().find((x) => x.__isPetWindow)
                            if (w && !w.isDestroyed()) {
                                // 只在状态变化时推（避免 8 秒重复发；渲染层只关心 state）
                                if (globalThis.__lastActivityState !== payload.state) {
                                    globalThis.__lastActivityState = payload.state
                                    w.webContents.send('pet:user-activity', payload)
                                    console.log('[user-activity] 推送 ' + payload.state + ' (idle ' + Math.round(payload.idleMs / 1000) + 's) → 渲染层')
                                }
                            }
                        } catch (e) { /* 窗口未就绪，下一拍再试 */ }
                    })
            } catch (e) { try { __silentAudit.audit('main.js:idle', e); } catch (e2) {} }
        }
        probeIdle()
        globalThis.__idleTimer = setInterval(probeIdle, 8000)
        if (globalThis.__idleTimer.unref) globalThis.__idleTimer.unref()
        console.log('[user-activity] 活跃度检测已启动（每 8 秒）')
    } catch (e) { try { __silentAudit.audit('main.js:idle-init', e); } catch (e2) {} }

    // 皮套看门狗：petBody 迟迟不出现（WASM 分配在内存紧张时可能挂起而非抛错）→ 整页重载自愈。
    // 连续 3 次（90s）未就绪才动手；切换模型/换装的瞬时空窗由 60s 重载冷却兜底。
    // 进度感知看门狗：驱动层每个阶段打心跳（__petBodyStage/StageAt）。
    // 心跳在走 = 正在慢加载（游戏期 16MB moc3 可能要 60~90s），绝不打断；
    // 心跳停滞 3 次（90s）+ petBody 仍未就绪 = 真卡死 → 整页重载（60s 防循环照旧）。
    let petBodyWatchLast = '';
    let petBodyWatchStall = 0;
    let petBodyWatchDelay = 30000;
    function schedulePetBodyWatch() {
        if (win.isDestroyed()) return;
        setTimeout(petBodyWatchTick, petBodyWatchDelay);
    }
    function petBodyWatchTick() {
        try {
            if (!win || win.isDestroyed()) return;
            win.webContents.executeJavaScript('JSON.stringify({ pb: typeof window.petBody, stage: window.__petBodyStage || "", at: window.__petBodyStageAt || 0 })').then((raw) => {
                let snap = { pb: 'undefined', stage: '', at: 0 };
                try { snap = JSON.parse(raw); } catch (e) { try { __silentAudit.audit('main.js:661', e); } catch (e2) {} }
                if (snap.pb === 'object') {
                    if (petBodyWatchStall >= 3) console.log('[pet] 看门狗：皮套已恢复 ✓');
                    petBodyWatchStall = 0;
                    petBodyWatchDelay = 30000;
                } else {
                    const sig = snap.stage + '|' + snap.at;
                    if (sig !== petBodyWatchLast) { petBodyWatchStall = 0; petBodyWatchLast = sig; }
                    else petBodyWatchStall += 1;
                    if (petBodyWatchStall >= 3 && Date.now() - __lastPetReloadAt > 60000) {
                        __lastPetReloadAt = Date.now();
                        petBodyWatchStall = 0;
                        petBodyWatchDelay = Math.min(petBodyWatchDelay * 2, 300000);
                        console.log('[pet] 看门狗：心跳停滞 90s（stage=' + snap.stage + '）→ 整页重载自愈（下次巡检 ' + Math.round(petBodyWatchDelay / 1000) + 's）');
                        win.webContents.reload();
                    }
                }
                schedulePetBodyWatch();
            }).catch(() => schedulePetBodyWatch());
        } catch (e) { schedulePetBodyWatch(); }
    }
    schedulePetBodyWatch();

    // 渲染层 console → 宿主 stdout：皮套加载失败的报错只进渲染层 console，
    // dbg 写盘静默失败时（磁盘/权限）就彻底查不到——这里是最后的真相通道。
    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
        try {
            if (level >= 1) console.log('[renderer:' + (level === 3 ? 'error' : level === 2 ? 'warn' : 'log') + '] ' + String(message).slice(0, 300) + ' @' + String(sourceId).split(/[\/]/).pop() + ':' + line);
        } catch (e) { try { __silentAudit.audit('main.js:689', e); } catch (e2) {} }
    });

    win.loadFile('index.html')
    // 2026-11-23 穿透根治：启动主进程光标轮询（不依赖窗口 mousemove）。
    // 这是唯一能在「已穿透」状态下仍读到鼠标位置的通道 → 才能做到「进入即恢复」。
    try { startPassthroughWatcher(win); } catch (e) { try { __silentAudit.audit('main.js:pt-start', e); } catch (e2) {} }
    // 启动时把「托盘开关」落到渲染层（2026-11-15）：
    // 静音 / 表情强度都是渲染层的运行时开关，光写配置不生效 —— 之前勾了静音还出声就是这个原因。
    win.webContents.on('did-finish-load', () => {
        try {
            const cfg = readConfigJson() || {};
            const muted = !!(cfg.tts && (cfg.tts.muted === true || cfg.tts.enabled === false));
            const rawGain = Number(cfg.ui && cfg.ui.petbody_emotion_gain);
            const gain = Number.isFinite(rawGain) ? rawGain : 1;
            const code = 'try{global.__ttsMuted=' + JSON.stringify(muted)
                + ';global.__petEmotionGain=' + JSON.stringify(gain) + ';}catch(e){}';
            win.webContents.executeJavaScript(code).catch(() => {});
            console.log('[tray] 启动状态注入：静音=' + muted + ' 表情强度=' + gain);
        } catch (e) { /* 注入失败不影响启动 */ }
    });
    // 调试用：PET_SNAPSHOT=<路径> 时，加载完 8 秒把窗口内容截一张图（不受 z-order 影响）。
    if (process.env.PET_SNAPSHOT) {
        win.webContents.on('did-finish-load', () => {
            setTimeout(async () => {
                try {
                    const image = await win.webContents.capturePage();
                    require('fs').writeFileSync(process.env.PET_SNAPSHOT, image.toPNG());
                    console.log('[pet-snapshot] saved', process.env.PET_SNAPSHOT);
                } catch (error) { console.error('[pet-snapshot] failed', error); }
            }, 8000);
        });
    }
    win.on('minimize', (event) => {
        event.preventDefault()
        win.restore()
    })
    // 移除 will-move 限制,允许跨屏幕移动
    win.on('blur', () => {
        ensureTopMost(win)
    })
    win.on('closed', () => {
        avatarSwitchTransaction?.clearWindow(win.id);
        // 窗口级定时器统一清理（2026-11-09 泄漏修复）：activate→createWindow 再开窗口时，
        // 旧窗口的置顶看门狗若不清会随窗口对象一直跑。
        if (win._petTimers) {
            for (const t of win._petTimers) { try { clearInterval(t); } catch (e) { try { __silentAudit.audit('main.js:closed-timers', e); } catch (e2) {} } }
            win._petTimers = [];
        }
        if (win._petRevealPoll) { clearInterval(win._petRevealPoll); win._petRevealPoll = null; }
    })
    // 置顶看门狗：挂到 win._petTimers，closed 时统一清（原实现无句柄无清理=泄漏）
    const topMostTimer = setInterval(() => {
        try {
            if (win.isDestroyed()) return;
            ensureTopMost(win)
        } catch (e) { try { __silentAudit.audit('main.js:717', e); } catch (e2) {} }
    }, 1000)
    if (topMostTimer.unref) topMostTimer.unref();
    if (!win._petTimers) win._petTimers = [];
    win._petTimers.push(topMostTimer);


    return win
}

// 只允许一个实例：双实例会抢 LevelDB 锁，导致 localStorage（换装持久化）失效。
if (!app.requestSingleInstanceLock()) {
    console.log('[pet] 已有实例在运行，本进程退出');
    app.quit();
}

// ── 崩溃转储（2026-11-15 五十八轮）────────────────────────────────────────
// 2026-11-14 00:19 那次「渲染进程静默崩溃」**没留下任何 dump**
// （AppData\Roaming 与项目内 24h 内 0 个 .dmp），根因至今只能靠猜。
// 这里把转储收拢到 live-2d/crash-dumps —— **只落盘、不上传**（uploadToServer:false），
// 下次崩了才有东西可看。失败必须发声，否则「以为有 dump」会白等一次。
try {
    const dumpsDir = path.join(__dirname, 'crash-dumps');
    fs.mkdirSync(dumpsDir, { recursive: true });
    app.setPath('crashDumps', dumpsDir);
    const { crashReporter } = require('electron');
    crashReporter.start({ uploadToServer: false, compress: true });
    console.log('[crash] 崩溃转储已开：' + dumpsDir + '（本地，不上传）');
} catch (error) {
    console.warn('[crash] 崩溃转储初始化失败（下次崩溃将没有 dump）:', error && error.message || error);
}

// ===== 托盘：桌宠没有任务栏入口，靠它开关/静音/退出 =====
let petTray = null;
// 托盘菜单重建钩子（2026-11-21 统一管辖）：每次弹出前先重建，label/勾选必须来自**当下**状态，
// 不能缓存上一次 build 的结果。tray-popup IPC（控制中心/遥控页触发）也走这个钩子。
let petTrayRebuild = null;
// petWinRef 已在文件顶部声明（TDZ 修复，见那里的注释）

function autostartCmdPath() {
  // 2026-11-15：文件名改成 ASCII。原来叫「大肥鱼桌宠.cmd」，在 Electron 主进程里写 Startup 目录
  // 会 EPERM（同样的路径从普通 node 写却是好的）—— 中文文件名在部分代码页/安全软件组合下不稳。
  // 兼容：旧的中文名文件如果还在，toggle 时会一并清掉。
  return path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'dafeiyu-autostart.cmd');
}

function legacyAutostartCmdPath() {
  return path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', '大肥鱼桌宠.cmd');
}

// 开机自启（2026-11-15 六十三轮）：改用 Electron 原生登录项（HKCU Run 键），
// 不再往 Startup 目录写 .cmd —— 实测 Electron 进程写 Startup 会 EPERM（普通 node 却能写），
// 像是进程被附加了额外限制；原生 API 走注册表，稳定且是官方推荐做法。
function autostartLauncherPath() {
  return path.join(app.getAppPath(), '..', '..', '..', 'pet-runtime', 'tools', 'launch-my-neuro.mjs');
}

// 注册表助手：electron.exe 本体写不了注册表/Startup（实测 EPERM 且原生 API 静默失败），
// 但它的**子 node 进程**可以 —— 所以让 node 去写 HKCU Run。
function autostartHelperPath() {
  return path.join(app.getAppPath(), '..', '..', '..', 'pet-runtime', 'tools', 'autostart.cjs');
}

let _autostartCache = { at: 0, on: false };

function runAutostartHelper(cmd) {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('node', [autostartHelperPath(), cmd], { windowsHide: true, encoding: 'utf8', timeout: 8000 });
    if (r.status !== 0) return { ok: false, err: String(r.stderr || '').slice(0, 200) || ('status ' + r.status) };
    const j = JSON.parse(String(r.stdout || '{}'));
    return Object.assign({ ok: true }, j);
  } catch (e) {
    return { ok: false, err: String(e && e.message || e) };
  }
}

function isAutostartOn() {
  // 3 秒缓存：托盘 rebuild 频繁调用，每次 spawn 一个 node 太浪费
  const now = Date.now();
  if (now - _autostartCache.at < 3000) return _autostartCache.on;
  let on = false;
  const r = runAutostartHelper('status');
  if (r.ok) on = !!r.on;
  else {
    try { on = !!(typeof app.getLoginItemSettings === 'function' && app.getLoginItemSettings().openAtLogin); } catch (e) { on = false; }
  }
  _autostartCache = { at: now, on };
  return on;
}

// ── pet-core 定位（2026-11-13 统一成一个）─────────────────────────────────
// 之前有三套拼法，其中 screen_shot 那套用 `__dirname` + 两级 `..` —— 少了一级
// （`__dirname` 是 live-2d，两跳到 _incoming，而 pet-core 在项目根），所以
// `existsSync` 恒 false，那条「用 Rust 截图根治黑帧」的补丁**从未执行过一次**，
// 每次都静默回落到已知会出黑帧的 screenshot-desktop。
// 现在只留这一个解析器：release 优先、debug 兜底、打包后从 resourcesPath 找。
let _petCorePath = null;
function resolvePetCore() {
  if (_petCorePath !== null) return _petCorePath;
  const appPath = app.getAppPath();
  const roots = [
    path.join(appPath, '..', '..', '..', 'pet-core', 'target'),  // 开发：live-2d → 项目根
    path.join(appPath, '..', '..', 'pet-core', 'target'),        // 兼容旧布局
    path.join(process.resourcesPath || appPath, 'pet-core', 'target'), // 打包后
  ];
  for (const root of roots) {
    for (const kind of ['release', 'debug']) {
      const p = path.join(root, kind, 'pet-core.exe');
      if (fs.existsSync(p)) { _petCorePath = p; return p; }
    }
  }
  _petCorePath = '';
  return '';
}

// 打开宿主原生的配置中心（control-main.js 是独立 Electron 应用，自带单实例锁，
// 重复点只会把已有窗口拉到前台，不会开出第二份）。
// 计算设置窗位置：优先调用 Rust 内核（pet-core），拿不到则用同一套公式的 JS 兜底。
// 公式来源：AkaneCompanionLab desktop_pet_next/src-tauri/src/pet_windows/placement.rs
function computePanelPosition(panelW, panelH) {
  try {
    const petWin = (typeof petWinRef !== "undefined" ? petWinRef : null);
    if (!petWin || petWin.isDestroyed()) return null;
    const b = petWin.getBounds();
    const disp = screen.getDisplayMatching(b);
    const work = disp.workArea;

    // ① 首选 Rust 内核
    try {
      const { execFileSync } = require('child_process');
      // release 优先（打包只带 release）；debug 只在本地开发时兜底
      const corePath = resolvePetCore();
      if (corePath) {
        const out = execFileSync(corePath, [], {
          input: JSON.stringify({
            cmd: 'panel',
            pet: { x: b.x, y: b.y, width: b.width, height: b.height },
            panel: [panelW, panelH],
            work: { x: work.x, y: work.y, width: work.width, height: work.height },
          }),
          timeout: 3000, encoding: 'utf8', windowsHide: true,
        });
        const j = JSON.parse(out);
        if (j && j.ok) return { x: j.x, y: j.y, source: 'pet-core(rust)' };
      }
    } catch (e) { try { __silentAudit.audit('main.js:767', e); } catch (e2) {} }

    // ② JS 兜底（同一套规则）
    const GAP = 6;
    const right = b.x + b.width + GAP;
    const lastX = Math.max(work.x, work.x + work.width - panelW);
    const lastY = Math.max(work.y, work.y + work.height - panelH);
    const x = (right >= work.x && right <= lastX) ? right : Math.min(lastX, Math.max(work.x, b.x - panelW - GAP));
    const y = Math.min(lastY, Math.max(work.y, b.y));
    return { x, y, source: 'js-fallback' };
  } catch (e) {
    console.error('[panel] 计算位置异常:', e && e.message);
    return null;
  }
}

// ── 字幕副窗定位（P0-1：字幕独立窗口）────────────────────────────────
// 公式与 pet-core/src/placement.rs subtitle_position 一致：贴皮套下方，
// 下方放不下翻上方，再不行贴工作区底边；水平以皮套中线对齐并 clamp。
// 先问 Rust 内核（cmd=subtitle），拿不到用同一套公式的 JS 兜底。
const SUBTITLE_WINDOW_W = 640;
const SUBTITLE_WINDOW_H = 176;

function computeSubtitleAutoPosition(subW, subH) {
  try {
    const petWin = (typeof petWinRef !== "undefined" ? petWinRef : null);
    if (!petWin || petWin.isDestroyed()) return null;
    const b = petWin.getBounds();
    const disp = screen.getDisplayMatching(b);
    const work = disp.workArea;

    // ① 首选 Rust 内核
    try {
      const { execFileSync } = require('child_process');
      // release 优先（打包只带 release）；debug 只在本地开发时兜底
      const corePath = resolvePetCore();
      if (corePath) {
        const out = execFileSync(corePath, [], {
          input: JSON.stringify({
            cmd: 'subtitle',
            pet: { x: b.x, y: b.y, width: b.width, height: b.height },
            panel: [subW, subH],
            // 侧位窄版尺寸：上下都放不下时用它贴在她旁边（2026-11-08 用户反馈
            // 646px 大条幅贴旁边像另一块面板）。
            side_panel: [320, 88],
            work: { x: work.x, y: work.y, width: work.width, height: work.height },
          }),
          timeout: 3000, encoding: 'utf8', windowsHide: true,
        });
        const j = JSON.parse(out);
        // 透传 Rust 的 source 标记：'side' = 走窄版侧位，宿主据此把字幕窗缩到 320×88。
        // （2026-11-08：不透传会让窗口尺寸停在 640 宽，白算了窄版坐标。）
        if (j && j.ok) return { x: j.x, y: j.y, source: j.source ? ('pet-core(rust)-' + j.source) : 'pet-core(rust)' };
      }
    } catch (e) { try { __silentAudit.audit('main.js:820', e); } catch (e2) {} }

    // ② JS 兜底（同一套规则，与 Rust 实现逐行对齐）
    // 竖直：优先下方，放不下就上方；都放不下 → 侧位（贴皮套左右，垂直居中）——
    // 工作区纵向余量不足时（1067 高屏上皮套 762+字幕 180），硬贴底会与皮套重叠。
    const GAP = 6;
    const lastX = Math.max(work.x, work.x + work.width - subW);
    const lastY = Math.max(work.y, work.y + work.height - subH);
    const fitsBelow = b.y + b.height + GAP <= lastY;
    const fitsAbove = b.y - subH - GAP >= work.y;
    if (fitsBelow || fitsAbove) {
        const centered = b.x + Math.trunc((b.width - subW) / 2);
        const x = Math.min(lastX, Math.max(work.x, centered));
        const y = fitsBelow ? b.y + b.height + GAP : b.y - subH - GAP;
        return { x, y, source: 'js-fallback' };
    }
    // 侧位：与 Rust 同规则，但用**窄版**尺寸（320×88）贴她旁边——
    // 整宽 640 贴旁边像另一块面板（2026-11-08 用户反馈）。
    const sideW = 320, sideH = 88;
    const sideLastY = Math.max(work.y, work.y + work.height - sideH);
    const sideY = Math.min(sideLastY, Math.max(work.y, b.y + Math.trunc((b.height - sideH) / 2)));
    const rightX = b.x + b.width + GAP;
    const leftX = b.x - sideW - GAP;
    if (rightX + sideW <= work.x + work.width) {
        return { x: rightX, y: sideY, source: 'js-fallback-side' };
    }
    if (leftX >= work.x) {
        return { x: leftX, y: sideY, source: 'js-fallback-side' };
    }
    const centered = b.x + Math.trunc((b.width - subW) / 2);
    return { x: Math.min(lastX, Math.max(work.x, centered)), y: lastY, source: 'js-fallback' };
  } catch (e) {
    console.error('[subtitle] 计算位置异常:', e && e.message);
    return null;
  }
}

// 用户手动摆放（面板「调整字幕位置」→ 副窗调整条）持久化为相对自动位置的偏移：
// 皮套挪走/换屏后偏移仍然成立，clamp 回显示器并集防陈旧坐标把窗推没。
// ── 字幕位置缓存（2026-11-14）─────────────────────────────────────────────
// computeSubtitlePosition 被「1.5 秒漂移检查」反复调用，而它内部会
// execFileSync 起 pet-core（实测 54-75ms，**同步阻塞主线程**）+ 每次都
// `loadConfigData()` 读盘解析。皮套没动、配置没改时结果必然完全一样 ——
// 没必要每 1.5 秒让主线程卡 75ms。
// key 里带上 config.json 的 mtime：用户改字幕偏移后自动失效（statSync 约 0.1ms）。
let __subPosCache = null;
function computeSubtitlePosition(subW, subH, opts = {}) {
  let key = '';
  try {
    const b = (typeof petWinRef !== 'undefined' && petWinRef && !petWinRef.isDestroyed()) ? petWinRef.getBounds() : null;
    let cfgMtime = 0;
    try { cfgMtime = fs.statSync(configPath).mtimeMs; } catch (e) { cfgMtime = 0; }
    key = [subW, subH, opts.ignoreOffset ? 1 : 0,
      b ? [b.x, b.y, b.width, b.height].join(',') : 'nopet',
      cfgMtime].join('|');
  } catch (e) { key = ''; }
  if (key && __subPosCache && __subPosCache.key === key) return __subPosCache.pos;
  const pos = computeSubtitlePositionUncached(subW, subH, opts);
  if (key) __subPosCache = { key, pos };
  return pos;
}

function computeSubtitlePositionUncached(subW, subH, opts = {}) {
  const pos = computeSubtitleAutoPosition(subW, subH);
  if (!pos || opts.ignoreOffset) return pos;
  try {
    const sp = (loadConfigData().ui || {}).subtitle_position;
    if (!sp || !Number.isFinite(sp.dx) || !Number.isFinite(sp.dy) || (sp.dx === 0 && sp.dy === 0)) return pos;
    const displays = screen.getAllDisplays();
    const minX = Math.min(...displays.map(d => d.bounds.x));
    const minY = Math.min(...displays.map(d => d.bounds.y));
    const maxX = Math.max(...displays.map(d => d.bounds.x + d.bounds.width));
    const maxY = Math.max(...displays.map(d => d.bounds.y + d.bounds.height));
    const x = Math.min(Math.max(pos.x + sp.dx, minX), Math.max(minX, maxX - subW));
    const y = Math.min(Math.max(pos.y + sp.dy, minY), Math.max(minY, maxY - subH));
    return { x: Math.round(x), y: Math.round(y), source: (pos.source || '') + '+offset' };
  } catch (e) {
    console.error('[subtitle] 应用手动偏移失败（用自动位置）:', e && e.message);
    return pos;
  }
}

let __subtitleRepositionTimer = null;
function positionSubtitleWindow(why) {
  if (globalThis.__subtitleAdjusting) return;   // 调整模式：用户在拖，别抢
  const sub = global.__subtitleWin;
  if (!sub || sub.isDestroyed()) return;
  const pos = computeSubtitlePosition(SUBTITLE_WINDOW_W, SUBTITLE_WINDOW_H);
  if (!pos) return;
  // 侧位时窗口真的收窄到 320×88（Rust 返回的 side 坐标就是按这个尺寸算的），
  // 普通上下位用回通栏 640×176。两个尺寸的窗口都贴同一个角移动，避免文字被裁。
  const isSide = /side/.test(String(pos.source || ''));
  const wantW = isSide ? 320 : SUBTITLE_WINDOW_W;
  const wantH = isSide ? 88 : SUBTITLE_WINDOW_H;
  try {
    const b = sub.getBounds();
    if (b.width !== wantW || b.height !== wantH) {
      sub.setBounds({ x: pos.x, y: pos.y, width: wantW, height: wantH }, false);
      console.log('[subtitle] 尺寸切到 ' + wantW + '×' + wantH + '（' + (isSide ? '侧位窄版' : '通栏') + '）');
    } else {
      sub.setPosition(pos.x, pos.y, false);
    }
  } catch (e) {
    try { sub.setPosition(pos.x, pos.y, false); } catch (e2) {}
  }
  console.log('[subtitle] 位置', pos.x, pos.y, '(' + (pos.source || '') + (why ? ' · ' + why : '') + ')');
}
// 暴露给 http-server 的调整模式退出逻辑（§80）：退出后要把字幕拉回「跟随皮套」
global.__subtitleReposition = (why) => scheduleSubtitleReposition(why);
function scheduleSubtitleReposition(why) {
  if (__subtitleRepositionTimer) return;
  __subtitleRepositionTimer = setTimeout(() => {
    __subtitleRepositionTimer = null;
    positionSubtitleWindow(why);
  }, 150);
}

function openControlCenter() {
  try {
    const { spawn } = require('child_process');
    const appDir = app.getAppPath();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;

    // 把设置窗定位到皮套旁边 —— 布局算法在 Rust 内核里（pet-core），
    // 这里只负责把参数递过去、拿回坐标。皮套与设置窗并排，换装时能看到效果。
    const panelArgs = [];
    try {
      const pos = computePanelPosition(520, 720);
      if (pos) {
        env.PET_PANEL_X = String(pos.x);
        env.PET_PANEL_Y = String(pos.y);
        env.PET_PANEL_W = '520';
        env.PET_PANEL_H = '720';
        console.log('[panel] 设置窗位置:', pos.x, pos.y, pos.source || '');
      }
    } catch (e) { console.error('[panel] 定位失败:', e && e.message); }

    const child = spawn(process.execPath, [path.join(appDir, 'control-main.js')], {
      cwd: appDir, env, detached: true, stdio: 'ignore', windowsHide: false,
    });
    child.on('error', (error) => console.error('[tray] 打开设置失败:', error && error.message || error));
    child.unref();
    console.log('[tray] 已拉起配置中心 pid=', child.pid);
    return true;
  } catch (error) {
    console.error('[tray] 打开设置失败:', error && error.message || error);
    return false;
  }
}

function readConfigJson() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { return {}; }
}

function isTtsMuted() {
  const cfg = readConfigJson();
  if (!cfg || !cfg.tts) return false;
  // 新口径：tts.muted（运行时静音，不关子系统）；兼容旧配置里被写过 enabled=false 的情况
  return cfg.tts.muted === true || cfg.tts.enabled === false;
}

// 静音：写 tts.muted（持久）+ 立刻让渲染层停声并进入「只字幕」模式。
// ⚠ 2026-11-15 修复：原来写的是 `tts.enabled=false`（下次启动直接不初始化 TTS），
//   运行时靠 `ttsProcessor.ttsUnavailable=true` —— 而处理线程一到冷却判断就把它清掉
//   （`_ttsCooldownUntil||0` = 0），所以勾了静音照样出声。
//   而且 `enabled=false` 还留了个坑：取消静音后必须重启才能恢复 TTS。
function setTtsMuted(muted) {
  const on = !!muted;
  // 写盘失败不再静默（§69 B1）：本次运行照样生效，但持久化没成功要报出来，
  // 否则用户以为「已静音」，下次启动又被声音吓一跳。
  const wrote = patchConfigVerified('tray:静音TTS', (cfg) => {
    if (!cfg.tts) cfg.tts = {};
    cfg.tts.muted = on;
    if (on && cfg.tts.enabled === false) cfg.tts.enabled = true;   // 迁移：别让静音把子系统关死
  });
  try {
    const code = 'try{global.__ttsMuted=' + JSON.stringify(on)
      + ';const t=global.ttsProcessor;if(t&&on&&t.interrupt)t.interrupt();true;}catch(e){false;}';
    petWinRef?.webContents?.executeJavaScript(code).catch(() => {});
  } catch (error) { try { __silentAudit.audit('main.js:971', error); } catch (e2) {} }
  console.log('[tray] TTS 静音 =', on, wrote.ok ? '' : '（写盘失败，重启会回退）');
  return on;
}

function toggleAutostart() {
  const want = !isAutostartOn();
  global.__lastAutostartError = '';
  let result = runAutostartHelper(want ? 'on' : 'off');
  _autostartCache = { at: 0, on: false };            // 失效缓存，下面重读
  if (!result.ok) global.__lastAutostartError = result.err || '注册表助手执行失败';
  // 助手不可用/失败 → 退回 Electron 原生登录项（本机实测静默无效，但换个环境可能行）
  let now = isAutostartOn();
  if (now !== want) {
    try {
      app.setLoginItemSettings({
        openAtLogin: want,
        path: 'C:\\Windows\\System32\\cmd.exe',
        args: want ? ['/c', 'start', '', '/min', 'node', autostartLauncherPath()] : [],
      });
    } catch (e) { global.__lastAutostartError = global.__lastAutostartError || String(e && e.message || e); }
    _autostartCache = { at: 0, on: false };
    now = isAutostartOn();
  }
  // 清掉旧实现留下的 Startup .cmd（有就删）
  try {
    for (const p of [autostartCmdPath(), legacyAutostartCmdPath()]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch (e) { /* 旧文件删不掉不影响新机制 */ }
  return now;
}

// 托盘自检（2026-11-15 六十三轮，PET_TRAY_SELFTEST=1 触发）
// 原则：**每一项都必须能回滚**；会开窗/退出的只记 SKIP，不代跑。
async function runTraySelfTest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const lines = [];
  const rec = (name, state, detail) => lines.push(state + '  ' + name + (detail ? ' — ' + detail : ''));
  try {
    const w = petWinRef;
    if (!w || w.isDestroyed()) { rec('桌宠窗口', 'FAIL', '窗口不存在'); throw new Error('no window'); }

    const wasVisible = w.isVisible();
    w.hide(); await wait(300);
    rec('隐藏桌宠', w.isVisible() === false ? 'PASS' : 'FAIL', 'isVisible=' + w.isVisible());
    // 2026-11-23 用户报「托盘写着隐藏、点了反而出来」：断言隐藏后首项文案是「显示桌宠」
    const labelsHidden = Array.isArray(global.__petTrayMenuLabels) ? global.__petTrayMenuLabels : [];
    rec('托盘文案·隐藏后', labelsHidden[0] === '显示桌宠' ? 'PASS' : 'FAIL', '首项=' + (labelsHidden[0] || '空'));
    w.show(); await wait(300);
    rec('显示桌宠', w.isVisible() === true ? 'PASS' : 'FAIL', 'isVisible=' + w.isVisible());
    const labelsShown = Array.isArray(global.__petTrayMenuLabels) ? global.__petTrayMenuLabels : [];
    rec('托盘文案·显示后', labelsShown[0] === '隐藏桌宠' ? 'PASS' : 'FAIL', '首项=' + (labelsShown[0] || '空'));
    if (!wasVisible) w.hide();

    const wasTop = w.isAlwaysOnTop();
    w.setAlwaysOnTop(false, 'screen-saver'); await wait(120);
    rec('取消置顶', w.isAlwaysOnTop() === false ? 'PASS' : 'FAIL', 'isAlwaysOnTop=' + w.isAlwaysOnTop());
    w.setAlwaysOnTop(true, 'screen-saver'); await wait(120);
    rec('保持置顶', w.isAlwaysOnTop() === true ? 'PASS' : 'FAIL', 'isAlwaysOnTop=' + w.isAlwaysOnTop());
    if (!wasTop) w.setAlwaysOnTop(false, 'screen-saver');

    const cfg0 = readConfigJson() || {};
    const framing0 = (cfg0.ui && cfg0.ui.petbody_framing) || 'half';
    try {
      for (const mode of ['full', 'half', framing0]) {
        if (global.__petServer && global.__petServer.sendToRenderers) global.__petServer.sendToRenderers({ type: 'framing', mode });
        await wait(100);
      }
      rec('取景 IPC', 'PASS', 'full → half → ' + framing0);
    } catch (e) { rec('取景 IPC', 'FAIL', e.message); }

    const wasMuted = isTtsMuted();
    setTtsMuted(!wasMuted); await wait(300);
    rec('静音切换', isTtsMuted() === !wasMuted ? 'PASS' : 'FAIL', 'now=' + isTtsMuted());
    setTtsMuted(wasMuted); await wait(300);
    rec('静音恢复', isTtsMuted() === wasMuted ? 'PASS' : 'FAIL', 'now=' + isTtsMuted());

    const gain0 = Number((cfg0.ui && cfg0.ui.petbody_emotion_gain) === 0 ? 0 : 1);
    try {
      for (const g of [0, gain0]) {
        if (global.__petServer && global.__petServer.sendToRenderers) global.__petServer.sendToRenderers({ type: 'emotion-gain', gain: g });
        await wait(100);
      }
      rec('表情强度 IPC', 'PASS', '0 → ' + gain0);
    } catch (e) { rec('表情强度 IPC', 'FAIL', e.message); }

    try {
      const choreo0 = !!(cfg0.ui && cfg0.ui.petbody_choreo === true);
      for (const on of [true, choreo0]) {
        if (global.__petServer && global.__petServer.sendToRenderers) global.__petServer.sendToRenderers({ type: 'choreo', on });
        await wait(100);
      }
      rec('编舞 IPC', 'PASS', 'on → ' + choreo0);
    } catch (e) { rec('编舞 IPC', 'FAIL', e.message); }

    const had = isAutostartOn();
    global.__lastAutostartError = '';
    toggleAutostart(); await wait(250);
    const mid = isAutostartOn();
    if (mid !== had) { toggleAutostart(); await wait(250); }   // 回滚到原状态
    const back = isAutostartOn();
    rec('开机自启往返', (mid !== had && back === had) ? 'PASS' : 'FAIL',
        'had=' + had + ' mid=' + mid + ' back=' + back + ' path=' + autostartCmdPath()
        + ' appdata=' + (process.env.APPDATA || '(空)')
        + (global.__lastAutostartError ? ' err=' + global.__lastAutostartError : ''));

    rec('打开设置', 'SKIP', '会开窗，不代跑');
    rec('打开配置目录', 'SKIP', '会开资源管理器，不代跑');
    rec('退出', 'SKIP', '会退出，不代跑');
  } catch (e) {
    rec('自检异常', 'FAIL', e && e.message || String(e));
  }
  try {
    fs.writeFileSync(path.join(__dirname, '..', '..', 'tray-selftest.log'), lines.join('\n') + '\n', 'utf8');
    console.log('[tray-selftest]\n' + lines.join('\n'));
  } catch (e) { console.error('[tray-selftest] 写日志失败:', e && e.message || e); }
}

function setUpTray(win) {
  petWinRef = win;
  if (petTray) return petTray;
  // ⚠ 这里必须自己读配置。
  // 原来直接用 `config`，但那个变量是 createWindow() 里的局部变量，
  // 模块级的 setUpTray 根本看不到它 —— 每次建托盘都抛 "config is not defined"，
  // 托盘图标是空的，右键当然点不出任何东西。
  let config = (() => {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch (e) { return {}; }
  })();
  let image;
  try {
    const iconPath = path.join(app.getAppPath(), 'assets', 'tray.png');
    image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath).resize({ width: 32, height: 32 }) : nativeImage.createEmpty();
  } catch (e) { image = nativeImage.createEmpty(); }
  try {
    petTray = new Tray(image);
  } catch (e) {
    console.error('[tray] 创建托盘失败:', e.message);
    return null;
  }
  petTray.setToolTip('大肥鱼 · 桌宠');

  // ── 表演库 v2（2026-11-15）：15 段 19–38 秒长表演 ────────────────────────
  // 与下面「编舞（实验）」的区别：那是说话时按情绪播的微动作（2–4 秒，自动）；
  // 这是参数级长表演（眼球/眉/嘴逐帧轨道 + 原生手势 + 真表情），按名字手动触发。
  // 列表和 pet-runtime/desktop/choreo-performances.mjs 的 key 一一对应；
  // 重新编译后若段名有变，playPerformance 会返回 false（控制台会打印）。
  const PERFORMANCE_MENU = [
    ['01-curiosity', '01 疑惑→思考→恍然大悟'],
    ['02-vulnerable', '02 委屈→犹豫→鼓起勇气'],
    ['03-pride', '03 得意→被戳穿→害羞否认'],
    ['04-playful', '04 拿草逗趣→开心→前倾'],
    ['05-weight-shift', '05 左右换重心·腿部联动'],
    ['06-finger-articulation', '06 竖指讲解·手臂腕指'],
    ['07-left-articulation', '07 抚胸展开·手腕致意'],
    ['08-grass-articulation', '08 持草轻摆·身体配合'],
    ['09-composure', '09 强装镇定→慌张→致谢'],
    ['10-resolution', '10 犹豫求助→想通→讲解'],
    ['11-mischief', '11 顽皮逗趣→被发现→道歉'],
    ['12-bold-performance', '12 大胆逗趣→后退→抚胸笑'],
    ['13-form-performance', '13 长裙逗趣→Q版闹别扭→致意'],
    ['14-flirt', '14 侧目试探→靠近→带笑回望'],
    ['15-flirt-layered', '15 侧目试探→靠近→回望（分层）'],
  ];
  const runPerformance = (key) => {
    // key 用 JSON.stringify 包：菜单是静态的，但别给「拼字符串进 executeJavaScript」留口子
    const js = key
      ? `try{global.petBody&&global.petBody.playPerformance(${JSON.stringify(String(key))});}catch(e){}`
      : 'try{global.petBody&&global.petBody.stopPerformance();}catch(e){}';
    try { petWinRef?.webContents?.executeJavaScript(js).catch(() => {}); } catch (e) { try { __silentAudit.audit('main.js:performance', e); } catch (e2) {} }
    console.log('[tray] 表演 =', key || '停止');
  };

  // 静默模式：托盘只是快捷方式，真源是 8103 /quiet（vts-server 持有 state.quiet 并持久化
  // cost.quiet）。以前托盘没有这一项，用户要么开面板要么开遥控页；现在三处同源：
  //   读 = global.__petQuiet（就是 /state 返回的那个 quiet，vts-server 每次切换同步写）
  //   写 = POST 127.0.0.1:8103/quiet（和能力页 proactive.quiet、总览开关同一入口）
  const readQuietLive = () => {
    if (typeof global.__petQuiet === 'boolean') return global.__petQuiet;
    try { return !(config && config.cost && config.cost.quiet === false); } catch (e) { return true; }
  };
  const setQuietViaControl = (on) => {
    const data = Buffer.from(JSON.stringify({ on: on === true }), 'utf8');
    let req;
    try {
      // 延迟 require：主进程顶部没有引 http（只有面板进程用），托盘这一处按需取，避免多一个顶层依赖
      const http = require('http');
      req = http.request({
        host: '127.0.0.1', port: 8103, path: '/quiet', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 2500,
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(raw);
            if (j && j.ok !== false) console.log('[tray] 静默 =', j.quiet);
            else console.error('[tray] 静默切换被拒:', raw.slice(0, 120));
          } catch (e) { console.error('[tray] 静默回包无法解析:', raw.slice(0, 80)); }
          rebuild();
        });
      });
    } catch (e) { console.error('[tray] 静默请求构造失败:', e && e.message || e); rebuild(); return; }
    req.on('error', (e) => { console.error('[tray] 静默切换失败（8103 不在线）:', e && e.message || e); rebuild(); });
    req.setTimeout(2500, () => { req.destroy(); });
    req.write(data); req.end();
  };

  const rebuild = () => {
    // 每次重画菜单前重读盘上配置（§69 B1）：这份 config 只是"上次读到的那一份"，
    // 控制面板/插件随时可能在改同一个文件。不重读，菜单里的勾选状态就是过期的。
    try { config = loadConfigData(); } catch (e) { /* 读不到就沿用上一份，别把菜单弄空 */ }
    const visible = !!(petWinRef && !petWinRef.isDestroyed() && petWinRef.isVisible());
    const top = petWinRef && !petWinRef.isDestroyed() && petWinRef.isAlwaysOnTop();
    const quietLive = readQuietLive();
    const menu = Menu.buildFromTemplate([
      { label: visible ? '隐藏桌宠' : '显示桌宠', click: () => {
        if (!petWinRef || petWinRef.isDestroyed()) return;
        if (petWinRef.isVisible()) petWinRef.hide(); else { petWinRef.show(); petWinRef.setAlwaysOnTop(true, 'screen-saver'); }
        rebuild();
      } },
      { label: top ? '取消置顶' : '保持置顶', click: () => {
        if (!petWinRef || petWinRef.isDestroyed()) return;
        petWinRef.setAlwaysOnTop(!petWinRef.isAlwaysOnTop(), 'screen-saver');
        rebuild();
      } },
      { type: 'separator' },
      { type: 'checkbox', label: '静音（TTS）', checked: isTtsMuted(), click: (item) => { setTtsMuted(item.checked); rebuild(); } },
      // 静默：label 直接写当前态，勾选也来自实时状态（不再只靠勾号，用户一眼能读）
      { type: 'checkbox', label: quietLive ? '静默模式：开（不主动开口）' : '静默模式：关（会主动开口）', checked: quietLive, click: (item) => { setQuietViaControl(item.checked); } },
      { type: 'separator' },
      { type: 'checkbox', label: '鼠标穿透（点不穿她）', checked: !!(config.ui && config.ui.click_through_default === true), click: (item) => {
        const on = item.checked;
        try {
          // 2026-11-23 穿透根治：托盘开关只更新「策略」，由主进程轮询统一落地。
          // 直接 setIgnoreMouseEvents(on) 会绕过边界自愈，导致「开了就永久点不到」。
          __ptState.manual = on;
          if (on) {
            petWinRef.setIgnoreMouseEvents(true, { forward: true });
          } else {
            const rect = __ptWindowRect(petWinRef);
            const inside = rect ? __ptCursorInside(rect) : null;
            if (inside !== false) petWinRef.setIgnoreMouseEvents(false, { forward: true });
          }
          global.__petIgnoreMouse = on;
          const wrote = patchConfigVerified('tray:鼠标穿透', (cfg) => {
            cfg.ui = cfg.ui || {};
            cfg.ui.click_through_default = on;
          });
          console.log('[tray] 鼠标穿透 =', on, wrote.ok ? '' : '（写盘失败，重启会回退）');
        } catch (e) { console.error('[tray] 切换穿透失败:', e.message); }
        rebuild();
      } },
      { type: 'checkbox', label: '取景：全身', checked: !!(config.ui && config.ui.petbody_framing === 'full'), click: (item) => {
        const mode = item.checked ? 'full' : 'half';
        const wrote = patchConfigVerified('tray:取景', (cfg) => {
          cfg.ui = cfg.ui || {};
          cfg.ui.petbody_framing = mode;
        });
        if (!wrote.ok) console.error('[tray] 取景写配置失败（重启会回退）:', wrote.error);
        // 立即生效：通过内部通道让渲染层重设取景
        try { global.__petServer && global.__petServer.sendToRenderers && global.__petServer.sendToRenderers({ type: 'framing', mode }); } catch (e) { try { __silentAudit.audit('main.js:1042', e); } catch (e2) {} }
        console.log('[tray] 取景 =', mode);
        rebuild();
      } },
      { type: 'checkbox', label: '静音表情', checked: !!(config.ui && Number(config.ui.petbody_emotion_gain) === 0), click: (item) => {
        const gain = item.checked ? 0 : 1;
        const wrote = patchConfigVerified('tray:静音表情', (cfg) => {
          cfg.ui = cfg.ui || {};
          cfg.ui.petbody_emotion_gain = gain;
        });
        if (!wrote.ok) console.error('[tray] 表情强度写配置失败（重启会回退）:', wrote.error);
        // 立即生效（2026-11-15）：以前只写配置 + 一句「重启生效」，而渲染层根本没有 setEmotionGain 实现
        // → 这个开关一直是死的。现在按 gain=0 让情绪桥不切表情（动作/口型不受影响）。
        try {
          if (global.__petServer && global.__petServer.sendToRenderers) {
            global.__petServer.sendToRenderers({ type: 'emotion-gain', gain });
          } else {
            petWinRef?.webContents?.executeJavaScript('try{global.__petEmotionGain=' + Number(gain) + ';}catch(e){}').catch(() => {});
          }
        } catch (e) { try { __silentAudit.audit('main.js:emotionGain', e); } catch (e2) {} }
        console.log('[tray] 表情强度 =', gain, '（已实时下发）');
        rebuild();
      } },
      // 编舞 v1（实验，2026-11-15）：说话时按情绪播一段参数轨道（头/眼/身体/眉/嘴形）。
      // 默认关；打开后可和「只有表情」对比。轨道播完权重归零，不留残值。
      { type: 'checkbox', label: '编舞（实验）', checked: !!(config.ui && config.ui.petbody_choreo === true), click: (item) => {
        const wrote = patchConfigVerified('tray:编舞', (cfg) => {
          cfg.ui = cfg.ui || {};
          cfg.ui.petbody_choreo = item.checked;
        });
        if (!wrote.ok) console.error('[tray] 编舞配置写盘失败（重启会回退）:', wrote.error);
        try {
          if (global.__petServer && global.__petServer.sendToRenderers) {
            global.__petServer.sendToRenderers({ type: 'choreo', on: item.checked });
          } else {
            petWinRef?.webContents?.executeJavaScript('try{global.petBody&&global.petBody.setChoreography(' + item.checked + ');}catch(e){}').catch(() => {});
          }
        } catch (e) { try { __silentAudit.audit('main.js:choreo', e); } catch (e2) {} }
        console.log('[tray] 编舞 =', item.checked);
        rebuild();
      } },
      // 长表演自动触发（2026-11-16）：聊天时情绪到位就自动演一段 19–38 秒的戏。
      // 默认开（用户拍板「不能靠托盘按键才演」）；这个是「允许自动演」的总闸，
      // 节流（4 分钟冷却 / 同段 15 分钟 / 单会话 6 段）在渲染层 choreo-auto.mjs 里。
      { type: 'checkbox', label: '自动演（情绪触发）', checked: !(config.ui && config.ui.petbody_perf_auto === false), click: (item) => {
        const wrote = patchConfigVerified('tray:自动演', (cfg) => {
          cfg.ui = cfg.ui || {};
          cfg.ui.petbody_perf_auto = item.checked;
        });
        if (!wrote.ok) console.error('[tray] 自动演配置写盘失败（重启会回退）:', wrote.error);
        try {
          if (global.__petServer && global.__petServer.sendToRenderers) {
            global.__petServer.sendToRenderers({ type: 'perf-auto', on: item.checked });
          } else {
            petWinRef?.webContents?.executeJavaScript('try{global.petBody&&global.petBody.setPerformanceAuto(' + item.checked + ');}catch(e){}').catch(() => {});
          }
        } catch (e) { try { __silentAudit.audit('main.js:perf-auto', e); } catch (e2) {} }
        console.log('[tray] 自动演 =', item.checked);
        rebuild();
      } },
      // 表演库 v2：手动演一段（15 段长表演）。点新的会顶掉正在播的（不排队演戏）。
      { label: '演一段（长表演）', submenu: [
        ...PERFORMANCE_MENU.map(([key, label]) => ({ label, click: () => runPerformance(key) })),
        { type: 'separator' },
        { label: '停止表演', click: () => runPerformance('') },
      ] },
      { label: '打开设置…', click: () => { openControlCenter(); } },
      { label: '打开配置目录', click: () => { try { require('electron').shell.openPath(path.dirname(configPath)); } catch (e) { try { __silentAudit.audit('main.js:1054', e); } catch (e2) {} } } },
      { label: isAutostartOn() ? '关闭开机自启' : '开启开机自启', click: async () => {
        const want = !isAutostartOn();
        const on = toggleAutostart();
        console.log('[tray] 开机自启 =', on);
        // 失败必须发声：设置没生效时别让用户以为开了（多半是安全软件拦 Run 项/Startup）
        if (on !== want) {
          try {
            await dialog.showMessageBox({
              type: 'warning',
              title: '开机自启没设置成功',
              message: '系统没有接受「开机自启」的设置',
              detail: '常见原因是安全软件拦截了注册表 Run 项或 Startup 目录写入。\n'
                + '错误信息：' + (global.__lastAutostartError || '系统未返回原因（可能是静默拦截）'),
              buttons: ['知道了'],
            });
          } catch (e) { /* 对话框失败不影响托盘 */ }
        }
        rebuild();
      } },
      { type: 'separator' },
      { label: '退出', click: () => { try { petTray && petTray.destroy(); } catch (e) { try { __silentAudit.audit('main.js:1057', e); } catch (e2) {} } app.quit(); } },
    ]);
    petTray.setContextMenu(menu);
    // 托盘自检读取（只读观测，不参与业务）：验证「隐藏后文案=显示桌宠」不再滞后
    try { global.__petTrayMenuLabels = menu.items.map((item) => String(item.label || '')).filter(Boolean); } catch (e) { /* ignore */ }
    console.log('[tray] 菜单:', menu.items.map((item) => item.label).filter(Boolean).join(' | '));
  };
  rebuild();
  // 控制中心/遥控页通过 8771 的 tray-popup 触发弹出时，也必须在弹前重建（否则还是旧勾选）
  petTrayRebuild = rebuild;
  // Windows 上 setContextMenu 本身就该响应右键；但在「全屏应用盖住 / 通知区折叠 / 某些缩放」时
  // 有概率不弹。这里显式再挂一次，保证右键一定有反应。
  petTray.on('right-click', () => {
    // 2026-11-21 统一管辖：menu.popup 前先重建 —— 静默/演出/穿透这些状态可能刚被控制中心或
    // 8103 改过，原生 Menu 不重建就会弹出一份过期勾选。
    try { rebuild(); } catch (e) { console.error('[tray] 弹前重建失败（沿用旧菜单）:', e && e.message || e); }
    try { petTray.popUpContextMenu(); } catch (e) { console.error('[tray] 右键弹出失败:', e && e.message || e); }
  });
  petTray.on('click', () => {
    if (!petWinRef || petWinRef.isDestroyed()) return;
    if (petWinRef.isVisible()) petWinRef.hide(); else { petWinRef.show(); petWinRef.setAlwaysOnTop(true, 'screen-saver'); }
    rebuild();
  });
  // 托盘自检（2026-11-15 六十三轮）：PET_TRAY_SELFTEST=1 时把「能安全回滚」的菜单项真跑一遍并写日志。
  // 打开设置/配置目录/退出 会开窗或退出 → 只记 SKIP，不代跑。
  if (process.env.PET_TRAY_SELFTEST === '1') {
    setTimeout(() => { runTraySelfTest().catch((e) => console.error('[tray-selftest] 异常:', e && e.message || e)); }, 12000);
  }
  if (!setUpTray._quitHooked) {
    setUpTray._quitHooked = true;
    // 托盘退出/系统退出时先释放 petbridge 的端口，再交给 Electron 正常退出。
    app.on('will-quit', () => {
      try { petTray && petTray.destroy(); } catch (e) { try { __silentAudit.audit('main.js:1077', e); } catch (e2) {} }
      petTray = null;
      try { global.__petServer && global.__petServer.close && global.__petServer.close(); } catch (e) { try { __silentAudit.audit('main.js:1079', e); } catch (e2) {} }
    });
  }
  console.log('[tray] 托盘已就绪');
  // 自检钩子：PET_TRAY_POPUP=1 时把右键菜单弹出来，便于无头/截图验收（不影响正常启动）。
  if (process.env.PET_TRAY_POPUP === '1') {
    setTimeout(() => {
      try { petTray.popUpContextMenu(); console.log('[tray] 自检菜单已弹出'); } catch (e) { console.error('[tray] 自检菜单失败:', e && e.message || e); }
    }, 2500);
  }
  return petTray;
}

// 在主进程启动时调用
app.whenReady().then(() => {
    // ── LLM 网关绕开系统代理（2026-11-25，她突然"说不出话"的根因）────────────
    // Electron 的 fetch 默认走 Windows 系统代理（Clash 2080）。Clash 的 ✈️Final 分组
    // 一旦选到死节点，**所有未命中规则的域名**（含 api.commandcode.ai）都会挂 20s 后
    // Failed to fetch —— 小请求也一样（与载荷无关）。而 LLM 网关是 Cloudflare 前置，
    // 直连实测 1–3s。config.network.proxy_bypass 的域名一律绕开代理直连。
    // 注释：这是「她能不能说话」的命脉，别删。
    try {
        const cfg0 = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const bypass = String((cfg0.network && cfg0.network.proxy_bypass)
            || 'commandcode.ai;*.commandcode.ai;localhost;127.0.0.1;<local>')
            .split(/[;,\s]+/).map(s => s.trim()).filter(Boolean);
        if (bypass.length && session.defaultSession && typeof session.defaultSession.setProxy === 'function') {
            // ⚠ 三重坑（全部实测）：
            //   ① `mode:'system'` **不会合并** Windows 的 ProxyOverride —— 绕行列表会被原样忽略；
            //   ② `proxyBypassRules` 必须自己带上系统本地豁免（127.* / 192.168.* / <local>），
            //      否则把内网也送进代理；
            //   ③ 即便带上了 bypass 列表，`mode:'system'` 的绕行**仍不生效**（Chromium 对 system
            //      模式照搬 PAC/注册表）→ 改用 `mode:'pac_script'`，PAC 里对 bypass 域名返回 DIRECT，
            //      其余全部 `PROXY 127.0.0.1:2080`（= 系统代理地址，动态读注册表）。
            // 这就是「bypass 列表打印生效但 comad 仍 Failed to fetch」的根因。
            const sysBypass = ['localhost', '127.*', '192.168.*', '10.*', '172.16.*', '172.17.*', '172.18.*',
                '172.19.*', '172.20.*', '172.21.*', '172.22.*', '172.23.*', '172.24.*', '172.25.*',
                '172.26.*', '172.27.*', '172.28.*', '172.29.*', '172.30.*', '172.31.*', '*.local', '<local>'];
            const allBypass = [...bypass, ...sysBypass];
            // 从 Windows 注册表读系统代理地址（PAC 里用）
            let sysProxy = '127.0.0.1:2080';   // Clash Verge mihomo mixed 端口的兜底值
            try {
                const winReg = require('winreg');
                // 走注册表太重 —— 直接读 IE 设置也不轻。Clash Verge 的 mixed 端口写死在
                // 2080（本机实测），若用户改了端口，改 config.network.proxy_bypass 即可。
            } catch (e) { /* ignore */ }
            const pacEntries = allBypass.map((b) => {
                // PAC 语法：把 Windows 通配（127.*）转成 Chromium 通配（127.*）
                const entries = b.split(';').map(s => s.trim()).filter(Boolean);
                return entries;
            }).flat().filter(Boolean);
            const pacScript = [
                'function FindProxyForURL(url, host) {',
                ...pacEntries.map((b) => `  if (shExpMatch(host, '${b}')) return 'DIRECT';`),
                `  return 'PROXY ${sysProxy}';`,
                '}'
            ].join('\n');
            session.defaultSession.setProxy({ mode: 'pac_script', pacScript })
                .then(() => logToTerminal('info', `[网络] LLM 网关直连绕行已生效（PAC，共 ${pacEntries.length} 条规则）：${bypass.join(',')}`))
                .catch((e) => logToTerminal('warn', '[网络] setProxy 失败（保持系统默认）: ' + (e && e.message || e)));
        }
    } catch (e) { /* 读不到配置就保持系统默认，不阻断启动 */ }

    // 读取配置判断模型类型
    let modelType = 'live2d';
    let configData = {};
    try {
        configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        modelType = configData.ui?.model_type || 'live2d';
    } catch (e) {
        console.log('读取配置失败，使用默认Live2D模式');
    }

    normalizeConfiguredAvatarType(configData);

    const mainWindow = createWindow();

    // 启动 HTTP API 服务器
    const httpServer = new HttpServer();
    httpServer.start();

    // 隐私知情确认（一次性，商业合规：屏幕感知=高敏感能力，须显式披露——docs/隐私说明.md §3）。
    // 只在「一起看/主播陪玩启用且未确认过」时弹一次；确认写进 config.privacy.ack_screen_watch。
    try {
        const priv = configData.privacy || {};
        let wsEnabled = false;
        try {
            const list = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'plugins', 'enabled_plugins.json'), 'utf8'));
            wsEnabled = Array.isArray(list.plugins) && list.plugins.includes('community/watch-screen');
        } catch (e) { try { __silentAudit.audit('main.js:1120', e); } catch (e2) {} }
        if (wsEnabled && !priv.ack_screen_watch) {
            setTimeout(() => {
                try {
                    dialog.showMessageBox(mainWindow, {
                        type: 'info',
                        title: '屏幕感知说明',
                        message: '大肥鱼开启了屏幕感知（一起看 / 主播陪玩）。',
                        detail: '她会周期性截取你的屏幕做本地分析（关键帧比对/OCR）。\n截帧不出你的电脑——只有配置了视觉模型时，个别摘要才会调用视觉 API。\n随时可关：插件设置里停用 watch-screen，或面板开静默。\n详见 docs/隐私说明.md。',
                        buttons: ['知道了'],
                        defaultId: 0,
                        noLink: true,
                    }).then(() => {
                        // 写盘走唯一入口（§69 B1）：失败会发声；确认没落盘就下次启动再问一次，
                        // 比"提示已记录但磁盘没有"更安全。
                        const wrote = patchConfigVerified('privacy:知情确认', (cfgNow) => {
                            cfgNow.privacy = Object.assign({}, cfgNow.privacy, { ack_screen_watch: true, acked_at: new Date().toISOString() });
                        });
                        if (wrote.ok) console.log('[privacy] 屏幕感知知情确认已记录');
                    }).catch((e) => console.error('[privacy] 知情确认失败:', e && e.message));
                } catch (e) { console.error('[privacy] 知情确认弹窗失败:', e && e.message); }
            }, 3000);
        }
    } catch (e) { console.error('[privacy] 检查失败:', e && e.message); }

    // 注册全局快捷键
    shortcutManager = new ShortcutManager(configData);
    shortcutManager.registerAll();

    // 自己产的临时文件清理（2026-11-22 长跑采样）：
    // %TEMP%/pet-wgc 实测 564MB / 91 个 shot-*.bmp（11-09 攒到 11-22，无任何清理策略）；
    // %TEMP%/pet-screen-*.bmp 历史残留 140MB（失败路径没删）。清理器只认严格文件名白名单，
    // 不递归、不碰别人的文件；启动 60s 后扫一次（避开启动高峰），之后每 6 小时一次。
    try {
        setTimeout(() => {
            import('./petbridge/temp-sweeper.mjs')
                .then((m) => m.startTempSweeper({ log: (line) => console.log(line) }))
                .catch((e) => console.warn('[temp-sweeper] 加载失败:', e && e.message || e));
        }, 60000).unref?.();
    } catch (e) { /* 清理器起不来不影响宿主 */ }
});


app.on('window-all-closed', () => {
    if (global.pluginManager) {
        global.pluginManager.stopWatching();
    }
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('will-quit', () => {
    try { stopPassthroughWatcher(); } catch (e) { /* 退出时清理失败不影响关闭 */ }
    avatarSwitchTransaction?.dispose();
    avatarSwitchTransaction = null;
    if (shortcutManager) {
        shortcutManager.unregisterAll();
        shortcutManager = null;
    }
})

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
    }
})

// 恢复 6.55 的 window-move：拖到窗边时把窗口扩成当前配置下的显示器并集。
ipcMain.on('window-move', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    let config = {};
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) { try { __silentAudit.audit('main.js:1180', e); } catch (e2) {} }
    applyPetUnionBounds(win, config);
});

ipcMain.on('get-screen-info-sync', (event) => {
    try {
        const win = BrowserWindow.fromWebContents(event.sender);
        event.returnValue = {
            primaryDisplay: screen.getPrimaryDisplay(),
            allDisplays: screen.getAllDisplays(),
            windowBounds: win && !win.isDestroyed() ? win.getBounds() : null
        };
    } catch (e) {
        console.error('获取屏幕信息失败:', e);
        event.returnValue = null;
    }
});

// 相对位移（评测/自检用）：±40px 拖动模拟必须真的移动窗口，否则测到的只是
// 「窗口没动时的 rAF 频率」。
//
// 2026-11-24 根因修复（拖动「只能拖一小段就不动」的另一半原因）：
// 原实现把位置缓存在 win._petCachedPos，只在**自己写**的时候更新；一旦窗口被
// 外部移动（真实拖动 pet-drag-to / 用户拖窗口 / 其他模块 setBounds），缓存就变脏，
// 后续 pet:move-by 会按**过期的绝对坐标**计算 → 表现为「跳回原处」或「拖不动」。
// 缓存优化本身是错的：getBounds 是同步内存读（微秒级），60Hz 调用完全不成问题。
// 现在每次都以真实 bounds 为准，并注册 move 事件让任何外部移动都不会留下脏缓存。
ipcMain.on('pet:move-by', (event, dx, dy) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    let b;
    try { b = win.getBounds(); } catch (e) { return; }
    const nx = Math.round(b.x + (Number(dx) || 0));
    const ny = Math.round(b.y + (Number(dy) || 0));
    try { win.setPosition(nx, ny, false); } catch (e) { try { __silentAudit.audit('main.js:move-by', e); } catch (e2) {} }
});

// 拖动：渲染层算出目标位置，主进程移动窗口（透明窗口里最好用的拖法）。
ipcMain.on('pet-drag-to', (event, pos) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || !pos) return;
    // 拖动期间必须压住 PetBoundsRepair：它在 0/50/300/800ms 反复 setBounds 重申位置，
    // 会和拖动的 setPosition 抢，表现就是「拖到哪又弹回原处」的抽搐。
    win._petDragging = true;
    // §80 同族：这个标志也只有 drag-end 一个出口。记一下时刻，让 3s 看门狗能自解（见下）。
    win._petDragStartedAt = Date.now();
    // 2026-11-24：同步给穿透自愈轮询（拖动期间绝不置穿透，否则收不到 pointermove → 拖动中断）。
    global.__petDragging = true;
    global.__petDraggingAt = Date.now();
    if (win._petBoundsRepairTimers) {
        for (const timer of win._petBoundsRepairTimers) clearTimeout(timer);
        win._petBoundsRepairTimers = [];
    }
    // 2026-11-22：拖动分两种模式。
    //   ① 预览模式（默认，config.ui.drag_preview !== false）：
    //      真实窗**原地不动**（画面冻结），只跟一个轻量虚线框；松手才跳 —— 拖动过程不再
    //      每帧重合成 420×760 透明窗，也不会出现「被系统改尺寸」的窗口期。
    //   ② 直接模式（关掉开关时）：setBounds 原子设置位置+尺寸（原 setPosition + 250ms 校尺寸
    //      会留一段可见的变形期）。
    const want = getPetWantSize();
    if (petDragPreviewEnabled() && moveDragPreview(pos.x, pos.y)) {
        win._petDragPendingPos = { x: Math.round(pos.x), y: Math.round(pos.y) };
        win._petCachedPos = { x: Math.round(pos.x), y: Math.round(pos.y) };
        return;
    }
    try {
        win.setBounds({ x: Math.round(pos.x), y: Math.round(pos.y), width: want.width, height: want.height }, false);
        win._petCachedPos = { x: Math.round(pos.x), y: Math.round(pos.y) };
    } catch (e) {
        try { __silentAudit.audit('main.js:1209', e); } catch (e2) { /* ignore */ }
        try { win.setPosition(Math.round(pos.x), Math.round(pos.y), false); } catch (e3) { /* ignore */ }
    }
});

// 皮套窗口应有尺寸（config.ui.pet_window；面板改尺寸走配置+重启，运行时只有拖动改位置）。
// 跨 DPI 屏拖动时 setPosition 会用错误缩放因子把窗口撑大（见 pet-drag-end 注释里的
// 420→501→715 实测记录）——拖动中每次落点后立刻校回，配合下面的周期看门狗双保险。
let __petWantSize = null, __petWantAt = 0;
function getPetWantSize() {
    if (__petWantSize && Date.now() - __petWantAt < 5000) return __petWantSize;
    let want = { width: 420, height: 760 };
    try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const pw = cfg.ui && cfg.ui.pet_window;
        if (pw && Number(pw.width) > 0) want = { width: Math.round(Number(pw.width)), height: Math.round(Number(pw.height)) };
    } catch (e) { try { __silentAudit.audit('main.js:1236', e); } catch (e2) {} }
    __petWantSize = want; __petWantAt = Date.now();
    return want;
}
// ── 拖动预览窗（2026-11-22 用户拍板）─────────────────────────────────────
// 问题：拖动时移动 420×760 的**透明**窗，DWM 每帧都要重新合成 → 实测 present 只有 22–40fps；
//   且跨 DPI / 系统钳制时窗口边界可能被临时改写（用户反馈「拖的时候上下变长」）。
// 方案：拖动中**真实窗原地不动**（画面冻结），只跟一个轻量虚线框（独立透明小窗，纯色矩形）；
//   松手时真实窗一次性跳到目标位置。拖动过程的合成成本≈一个半透明矩形，肉眼不再卡。
// 开关：config.ui.drag_preview === false 可关掉（回到「真实窗直接跟手」）。
let __dragPreview = null;
let __dragPreviewHtml = null;
// 闲置销毁：预览窗是一个独立 BrowserWindow（自带一个 renderer 进程，约 60–100MB）。
// 只在拖动时用，长期留着不值得 —— 松手 60 秒后销毁，下一次拖动按需重建。
let __dragPreviewKillTimer = null;
function petDragPreviewEnabled() {
    // 2026-11-22：预览窗代码已实现，默认关（未真机验证）。
    // 2026-11-22 §115：机制已按下面四项验收（真窗不动/预览跟随不吃鼠标/松手跳位/不进业务解析），
    // 默认改为开启；想回到「真实窗直接跟手」在 config.ui.drag_preview 写 false。
    //
    // 2026-11-24 根因修复：原实现读的是**模块作用域里并不存在的 `config` 变量**
    // （只有几个函数内部有 `let config`），ReferenceError 被 catch 吞掉 →
    // 永远返回 true → 用户把 config.ui.drag_preview 写成 false 也**毫无效果**。
    // 现在改为每次实时从磁盘读（与 readConfigJson 同源），并明确先判 false。
    try {
        const cfg = readConfigJson();
        // 语义：未配置（缺 ui 或缺 drag_preview）→ 默认**开**预览；
        // 只有显式写 false 才回到「真实窗直接跟手」。
        // ⚠ 不能写成 `cfg.ui && cfg.ui.drag_preview !== false`——cfg.ui 缺失时结果是
        //   undefined，`!!` 之后变成 false，与「默认开」相反（2026-11-24 自测抓到）。
        if (!cfg || !cfg.ui) return true;
        return cfg.ui.drag_preview !== false;
    } catch (e) { return true; }
}
function ensureDragPreview() {
    // 复用时取消「闲置销毁」倒计时（见 hideDragPreview）
    if (__dragPreviewKillTimer) { clearTimeout(__dragPreviewKillTimer); __dragPreviewKillTimer = null; }
    if (__dragPreview && !__dragPreview.isDestroyed()) return __dragPreview;
    const want = getPetWantSize();
    if (!__dragPreviewHtml) {
        __dragPreviewHtml = 'data:text/html;charset=utf-8,' + encodeURIComponent(
            // 标题必须独一无二：game-control 的窗口枚举按它把预览窗摘掉（否则拖动时
            // list_windows 会多一个幽灵窗口）。默认标题会变成应用名 combined-project。
            '<!doctype html><meta charset="utf-8"><title>__pet_drag_preview__</title>'
            + '<style>html,body{margin:0;width:100%;height:100%;'
            + 'background:transparent;overflow:hidden}.box{position:absolute;inset:0;box-sizing:border-box;'
            + 'border:2px dashed rgba(109,155,208,.9);border-radius:20px;background:rgba(109,155,208,.10)}'
            + '</style><div class="box"></div>'
        );
    }
    try {
        __dragPreview = new BrowserWindow({
            width: want.width, height: want.height,
            transparent: true, frame: false, hasShadow: false, resizable: false,
            alwaysOnTop: true, focusable: false, skipTaskbar: true, show: false,
            type: 'toolbar',
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        });
        __dragPreview.__isPetDragPreview = true;
        try { __dragPreview.setIgnoreMouseEvents(true); } catch (e) { /* 预览窗绝不能吃鼠标 */ }
        try { __dragPreview.loadURL(__dragPreviewHtml); } catch (e) { /* ignore */ }
        __dragPreview.on('closed', () => { __dragPreview = null; });
    } catch (e) {
        __dragPreview = null;
        try { __silentAudit.audit('main.js:dragPreview', e); } catch (e2) { /* ignore */ }
    }
    return __dragPreview;
}
function moveDragPreview(x, y) {
    try {
        const pv = ensureDragPreview();
        if (!pv) return false;
        const want = getPetWantSize();
        pv.setBounds({ x: Math.round(x), y: Math.round(y), width: want.width, height: want.height }, false);
        if (!pv.isVisible()) pv.showInactive();
        return true;
    } catch (e) { return false; }
}
function hideDragPreview() {
    try { if (__dragPreview && !__dragPreview.isDestroyed()) __dragPreview.hide(); } catch (e) { /* ignore */ }
    // 60 秒后销毁（拖动中再次 ensure 会取消这个倒计时）
    if (__dragPreview && !__dragPreview.isDestroyed()) {
        if (__dragPreviewKillTimer) clearTimeout(__dragPreviewKillTimer);
        __dragPreviewKillTimer = setTimeout(() => {
            __dragPreviewKillTimer = null;
            try {
                if (__dragPreview && !__dragPreview.isDestroyed()) __dragPreview.destroy();
            } catch (e) { /* ignore */ }
            __dragPreview = null;
        }, 60000);
        if (__dragPreviewKillTimer.unref) __dragPreviewKillTimer.unref();
    }
}

function enforcePetSize(win) {
    if (!win || win.isDestroyed() || win._petResizing) return;
    try {
        const want = getPetWantSize();
        const b = win.getBounds();
        if (Math.abs(b.width - want.width) > 3 || Math.abs(b.height - want.height) > 3) {
            win._petResizing = true;
            win.setSize(want.width, want.height);
            console.log('[pet] 窗口尺寸被外力改变（跨屏 DPI/缩放手势），已校回', b.width + 'x' + b.height, '→', want.width + 'x' + want.height);
            win._petResizing = false;
        }
    } catch (e) { try { __silentAudit.audit('main.js:1251', e); } catch (e2) {} }
}
// 尺寸看门狗（全局唯一）：无皮套窗口时自动自灭，防止 activate→关窗循环里空转泄漏
setInterval(() => {
  try {
    const w = BrowserWindow.getAllWindows().find(x => x.__isPetWindow);
    if (!w) return;   // 没有皮套窗口就空转一拍（不清句柄：activate 重开窗后仍需它）
    // §80 同族修正：_petDragging 只有 'pet-drag-end' 一个出口。渲染层崩溃/工具只发了
    // pet-drag-to 没发 end（合成拖拽、脚本、评测都可能）→ 标志永久为真 →
    // enforcePetSize 与 PetBoundsRepair 都 return，窗口从此不再校正尺寸（跨 DPI 会越拖越大）。
    if (w._petDragging && Date.now() - (w._petDragStartedAt || 0) > 5000) {
      w._petDragging = false;
      w._petDragPendingPos = null;
      hideDragPreview();   // 预览窗不能残留（drag-end 丢了也要收）
      // 2026-11-24：同步清掉全局拖动标志，否则穿透自愈会一直以为在拖动 → 永远不穿透。
      global.__petDragging = false;
      global.__petDraggingAt = 0;
      logToTerminal('warn', '[pet] 拖动状态超过 5s 没收到 drag-end，已自动解除（否则尺寸校正与穿透自愈会永久失效）');
    }
    if (!w._petDragging) enforcePetSize(w);
  } catch (e) { try { __silentAudit.audit('main.js:1253', e); } catch (e2) {} }
}, 3000).unref?.();
ipcMain.on('pet-drag-end', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    win._petDragging = false;
    win._petDragStartedAt = 0;
    // 2026-11-24：解除穿透自愈的「拖动中」保护，恢复正常的进出边界判定。
    global.__petDragging = false;
    global.__petDraggingAt = 0;
    // 预览模式：拖动过程中真实窗一直原地不动，松手才跳过去（见 pet-drag-to 注释）。
    const pendingPos = win._petDragPendingPos;
    win._petDragPendingPos = null;
    hideDragPreview();
    if (pendingPos) {
        try {
            const want = getPetWantSize();
            win.setBounds({ x: pendingPos.x, y: pendingPos.y, width: want.width, height: want.height }, false);
        } catch (e) { try { __silentAudit.audit('main.js:dragCommit', e); } catch (e2) { /* ignore */ } }
    }
    enforcePetSize(win);   // 拖动全程不校正（防 DPI 拉锯抖动），拖完一次性校回
    try {
        const b = win.getBounds();
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        cfg.ui = cfg.ui || {};
        const prev = cfg.ui.pet_window || {};
        // ⚠ 只存位置，不存尺寸。
        // 窗口横跨两块不同 DPI 的屏幕时，Electron 的 setBounds/setPosition 会用错误缩放因子
        // 把窗口撑大（420x760 → 501x841 → 715x1224）。如果这时把 getBounds 的尺寸写回配置，
        // 下次启动就以更大的尺寸为基准，再撑一次 —— 越拖越大。
        // 尺寸该由设置面板决定，拖动只负责位置。
        cfg.ui.pet_window = {
            width: Number(prev.width) > 0 ? Number(prev.width) : 420,
            height: Number(prev.height) > 0 ? Number(prev.height) : 760,
            x: Math.round(b.x),
            y: Math.round(b.y),
        };
        const wrote = writeJsonVerified(configPath, cfg);
        if (!wrote.ok) {
            logToTerminal('error', `[config] pet:位置 写盘失败（改动静默丢失！）: ${wrote.error}`);
        }
        console.log('[pet] 位置已保存', JSON.stringify(cfg.ui.pet_window), '（当前实际尺寸 ' + b.width + 'x' + b.height + '，不写回）', wrote.ok ? '' : '· 写盘失败');
        // 松手后把尺寸纠回配置值（跨屏时 Electron 会用错缩放因子撑大），但**不动位置**。
        const wantW = cfg.ui.pet_window.width, wantH = cfg.ui.pet_window.height;
        if (Math.abs(b.width - wantW) > 2 || Math.abs(b.height - wantH) > 2) {
            try {
                win.setBounds({ x: b.x, y: b.y, width: wantW, height: wantH });
                console.log('[pet] 尺寸已纠回', wantW + 'x' + wantH);
            } catch (e) { try { __silentAudit.audit('main.js:1283', e); } catch (e2) {} }
        }
    } catch (e) { console.error('[pet] 保存位置失败:', e.message); }
});
// 托盘菜单兜底：渲染层/控制口可以直接要求弹出菜单（诊断与「右键没反应」时用）
ipcMain.on('tray-popup', () => {
    try {
        if (!petTray) return console.warn('[tray] 托盘还没建好');
        // 弹前重建（2026-11-21 统一管辖）：外部触发的弹出同样不能展示缓存的旧状态
        try { if (petTrayRebuild) petTrayRebuild(); } catch (e) { console.error('[tray] 弹前重建失败（沿用旧菜单）:', e && e.message || e); }
        petTray.popUpContextMenu();
        console.log('[tray] 手动弹出菜单');
    } catch (e) { console.error('[tray] 弹出失败:', e && e.message || e); }
});

// 右键菜单里的「打开设置」「先藏起来」
ipcMain.on('open-control-center', (_e, page) => {
  try {
    // page 可选：换装时直接落到「大肥鱼」页，省得用户再找
    if (page) process.env.PET_PANEL_PAGE = String(page);
    openControlCenter();
  } catch (e) { console.error('[pet] 打开设置失败', e.message); }
});
ipcMain.on('hide-pet', (event) => {
    try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) win.hide();
        // 2026-11-23 兜底（用户报「托盘还写隐藏桌宠、点它反而出来」）：
        // 窗口 show/hide 事件本身会重建菜单，但事件是异步派发的，且「已经隐藏时再 hide()」
        // 不发事件 —— 显式再 rebuild 一次，保证任何时刻菜单文案都不滞后于真实可见性。
        // rebuild 幂等（重读配置 + 重设 contextMenu），重复调用无副作用。
        try { if (petTrayRebuild) petTrayRebuild(); } catch (e) { /* 托盘未就绪 */ }
        console.log('[pet] 用户从右键菜单隐藏了桌宠（托盘可重新显示）');
    } catch (e) { try { __silentAudit.audit('main.js:1309', e); } catch (e2) {} }
});

ipcMain.on('set-ignore-mouse-events', (event, { ignore, options }) => {
    BrowserWindow.fromWebContents(event.sender).setIgnoreMouseEvents(ignore, options)
})

// ── 皮套专用穿透通道（2026-11-13）─────────────────────────────────────────
// petbody/ui.js 里有一道总闸会拦截上面的旧通道（防 Live2D/VRM 的发送方在皮套
// 形态下乱发 ignore:true —— 它们对应的渲染层没加载，判定恒 false，会把窗口
// 变成永远穿透、点不到她）。但皮套自己的逐像素判定（petBody.hitTest）是对的，
// 必须能过 —— 所以单独给一条不会被拦的通道。
ipcMain.on('pet:set-ignore-mouse', (event, { ignore, options }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        // 诊断（2026-11-13）：只在值变化时打一行，方便确认这条通道到底有没有在发
        const st = global.__pbIgnoreLog || (global.__pbIgnoreLog = { last: null, calls: 0 });
        if (st.last !== !!ignore) {
            st.last = !!ignore;
            console.log('[穿透] pet:set-ignore-mouse → ' + (ignore ? '穿透(on)' : '可见(off)'));
        }
        st.calls += 1;
        win.setIgnoreMouseEvents(!!ignore, options || { forward: true });
    }
})

// ── 穿透边界自愈（2026-11-23 根因修复）────────────────────────────────────
// 事故：置上 WS_EX_TRANSPARENT 后，窗口**收不到真实鼠标事件**（forward:true 实测没把
// mousemove 转回来），渲染层的悬停判定永远等不到「鼠标离开了」→ 一旦穿透就永久点不到她。
//
// 根因：穿透的判定权在渲染层，而穿透状态本身破坏了判定所依赖的输入（mousemove）。
//       这是自指死锁，任何「渲染层再补一个 if」的补丁都不可能修好。
//
// 根治：把「鼠标是否还在窗口矩形内」这件事交给**主进程轮询**（screen.getCursorScreenPoint
// 不依赖窗口事件，穿透时照样能读）。规则：
//   ① 光标进入窗口矩形 → 立即解除穿透（保证她随时点得到）
//   ② 光标离开窗口矩形 ≥ LEAVE_GRACE_MS → 恢复穿透（让下面的窗口可点）
//   ③ 手动穿透开关（托盘/配置）= 开时，只允许 ②（进入也不解除），保持用户意图
//   ④ 渲染层仍可下发 ignore（逐像素 alpha 命中），但主进程轮询是最终的兜底与边界权威
// 开销：250ms 一次 getCursorScreenPoint（微秒级），只在窗口可见时跑。
const PASSTHROUGH_POLL_MS = 250;
const PASSTHROUGH_LEAVE_GRACE_MS = 600;
let __ptTimer = null;
let __ptState = { inside: null, ignoredAtLeave: 0, manual: false, lastIgnore: null };

function __ptWindowRect(win) {
    try {
        if (!win || win.isDestroyed()) return null;
        const b = win.getBounds();      // DIP 坐标，与 getCursorScreenPoint 同坐标系
        return b;
    } catch (e) { return null; }
}
function __ptCursorInside(rect) {
    try {
        const pt = screen.getCursorScreenPoint();
        return pt.x >= rect.x && pt.x < rect.x + rect.width
            && pt.y >= rect.y && pt.y < rect.y + rect.height;
    } catch (e) { return null; }
}
function __ptApply(win, ignore, why) {
    try {
        if (!win || win.isDestroyed()) return;
        if (__ptState.lastIgnore === !!ignore) return;   // 去重
        __ptState.lastIgnore = !!ignore;
        win.setIgnoreMouseEvents(!!ignore, { forward: true });
        console.log('[穿透自愈] ' + (ignore ? '穿透(on)' : '可见(off)') + ' · ' + why);
    } catch (e) { try { __silentAudit.audit('main.js:pt-apply', e); } catch (e2) {} }
}
function startPassthroughWatcher(win) {
    if (__ptTimer) { clearInterval(__ptTimer); __ptTimer = null; }
    __ptState = { inside: null, ignoredAtLeave: 0, manual: false, lastIgnore: null };
    __ptTimer = setInterval(() => {
        try {
            if (!win || win.isDestroyed() || !win.isVisible()) return;
            // 2026-11-24 根因修复：拖动期间绝不置穿透。
            // 拖动靠渲染层持续收 pointermove；一旦穿透，窗口收不到事件 → 拖动中断。
            // 渲染层已提前 return，这里再兜一层（拖到透明处 / 拖动时窗口移出光标位置都可能触发）。
            let dragging = false;
            try {
                dragging = global.__petDragging === true
                    && (Date.now() - (global.__petDraggingAt || 0) < 3000);
            } catch (e) { dragging = false; }
            if (dragging) {
                if (__ptState.lastIgnore !== false) __ptApply(win, false, '拖动中强制可见');
                __ptState.ignoredAtLeave = 0;
                return;
            }
            const rect = __ptWindowRect(win);
            if (!rect) return;
            const inside = __ptCursorInside(rect);
            if (inside === null) return;
            const prev = __ptState.inside;
            __ptState.inside = inside;
            // 用户手动开了完全穿透：只做「离开→穿透」，不因进入而解除
            const manual = !!__ptState.manual;
            if (inside !== prev) {
                if (inside) {
                    if (!manual) __ptApply(win, false, '光标进入窗口');
                    __ptState.ignoredAtLeave = 0;
                } else {
                    __ptState.ignoredAtLeave = Date.now();
                }
            }
            // 离开超过宽限期 → 穿透（让下层窗口可点）
            if (!inside && __ptState.ignoredAtLeave && !manual
                && Date.now() - __ptState.ignoredAtLeave >= PASSTHROUGH_LEAVE_GRACE_MS
                && __ptState.lastIgnore !== true) {
                __ptApply(win, true, '光标离开 ≥' + PASSTHROUGH_LEAVE_GRACE_MS + 'ms');
            }
        } catch (e) { /* 轮询异常不影响主流程 */ }
    }, PASSTHROUGH_POLL_MS);
    if (__ptTimer.unref) __ptTimer.unref();
    console.log('[穿透自愈] 已启动：主进程轮询光标（' + PASSTHROUGH_POLL_MS + 'ms），不依赖窗口 mousemove');
}
function stopPassthroughWatcher() {
    if (__ptTimer) { clearInterval(__ptTimer); __ptTimer = null; }
    __ptState = { inside: null, ignoredAtLeave: 0, manual: false, lastIgnore: null };
}
// 渲染层告知「手动穿透开关」当前值（托盘/配置变化时下发；只改策略，不直接动窗口）
ipcMain.on('pet:passthrough-manual', (_event, on) => {
    __ptState.manual = on === true;
    // 手动开 → 立刻穿透；手动关 → 若光标在窗口内则立刻恢复可交互
    const win = petWinRef;
    if (!win || win.isDestroyed()) return;
    if (__ptState.manual) __ptApply(win, true, '手动开关=开');
    else {
        const rect = __ptWindowRect(win);
        const inside = rect ? __ptCursorInside(rect) : null;
        if (inside === true) __ptApply(win, false, '手动开关=关且在窗口内');
    }
});
// 渲染层逐像素判定仍可下发（alpha 命中），但主进程去重 + 轮询兜底
ipcMain.on('set-window-opacity', (event, opacity) => {    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.setOpacity(Math.max(0, Math.min(1, opacity)));
})

// ── 字幕独立窗（P0-1）：渲染层把字幕推给主进程，主进程转发给副窗 ─────────
ipcMain.on('subtitle:show', (_event, payload) => {
    const sub = global.__subtitleWin;
    if (!sub || sub.isDestroyed()) return;
    sub.webContents.send('subtitle:show', {
        text: String((payload && payload.text) || ''),
        duration: Number((payload && payload.duration) || 0),
    });
})

ipcMain.on('subtitle:hide', () => {
    const sub = global.__subtitleWin;
    if (sub && !sub.isDestroyed()) sub.webContents.send('subtitle:hide');
})

// ── 字幕副窗「手动摆放」（P1）：调整条发来的三个落点 ─────────────────────
// 进入调整模式走 HTTP /adjust-subtitle-position（控制面板按钮 → 8103），
// 这里只管收尾：done=保存偏移、reset=清偏移回自动、cancel=放弃本次拖动。
function endSubtitleAdjust(why) {
    globalThis.__subtitleAdjusting = false;
    const sub = global.__subtitleWin;
    if (sub && !sub.isDestroyed()) {
        try { sub.setIgnoreMouseEvents(true); } catch (e) { try { __silentAudit.audit('main.js:1343', e); } catch (e2) {} }
        sub.webContents.send('subtitle:adjust-mode', { on: false });
    }
    positionSubtitleWindow('adjust-' + why);
}
ipcMain.on('subtitle:adjust-done', () => {
    try {
        const sub = global.__subtitleWin;
        if (sub && !sub.isDestroyed()) {
            const auto = computeSubtitlePosition(SUBTITLE_WINDOW_W, SUBTITLE_WINDOW_H, { ignoreOffset: true });
            const now = sub.getBounds();
            if (auto) {
                const dx = now.x - auto.x, dy = now.y - auto.y;
                updateUiConfig({ subtitle_position: (dx === 0 && dy === 0) ? null : { dx, dy } });
                console.log('[subtitle] 手动位置已保存: 偏移', dx, dy);
            }
        }
        endSubtitleAdjust('done');
    } catch (e) {
        console.error('[subtitle] 保存调整位置失败:', e && e.message);
        endSubtitleAdjust('done-err');
    }
});
ipcMain.on('subtitle:adjust-reset', () => {
    try {
        updateUiConfig({ subtitle_position: null });
        console.log('[subtitle] 手动位置已清除，回到自动跟随');
    } catch (e) { console.error('[subtitle] 清除字幕位置失败:', e && e.message); }
    endSubtitleAdjust('reset');
});
ipcMain.on('subtitle:adjust-cancel', () => endSubtitleAdjust('cancel'));

// ═══════════════════════════════════════════════════════════════════════════
// 操控 overlay（2026-11-14 五十三轮：**两个光标**）
//
// 用户的设计要求（原话）：「实际使用的 Windows 光标和电脑操控的光标可以是两个。
// 你要电脑操控的时候，在对应的视窗里面应该是一个虚拟的光标（橙色也行）……
// 用户自己做自己事情，你自己做电脑操控的事情。」
//
// 分工：
//   · 用户的真实光标 —— 归用户。她的动作结束后由 pet-core 的 `restoreCursor`
//     把指针还回原位（native.rs mouse_inject ⑦）。
//   · 她的虚拟光标 —— overlay 里的橙色箭头，常驻、跟着动作走，一眼能分清。
//
// 实现搬到了 js/core/overlay-layer.js（多显示器 + 每屏自己的 scaleFactor + 单测覆盖），
// main.js 只留接线。
// ═══════════════════════════════════════════════════════════════════════════
const { createOverlayLayer } = require('./js/core/overlay-layer.js');
const petOverlayLayer = createOverlayLayer({ BrowserWindow, screen });

ipcMain.on('pet:overlay', (_event, payload) => {
    try {
        if (payload && payload.hide) { petOverlayLayer.hideAll(); return; }
        petOverlayLayer.show(payload || {});
    } catch (e) {
        try { __silentAudit.audit('main.js:pet-overlay', e); } catch (e2) { /* 记账失败也不影响 */ }
    }
});

// 显示器拔掉时清掉那一块 overlay（不然会留一个看不见的置顶窗）
try {
    screen.on('display-removed', (_e, d) => petOverlayLayer.dropDisplay(d));
} catch (e) { /* 老版本 Electron 没有这个事件也不影响主流程 */ }

ipcMain.on('request-top-most', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win.setAlwaysOnTop(true, 'screen-saver')
})

// 添加保存配置的IPC处理器
// 2026-11-17 六十四轮：写盘逻辑收敛到 js/core/config-persist.saveHostConfig（可单测）。
// 旧实现吞掉通讯录写失败、config.json 裸写无回读，然后无条件弹「配置已成功保存」——
// 用户以为新 key/开关已生效，重启后还是旧值。现在只有「通讯录 + config 都写对且整份回读一致」
// 才 ok:true；失败弹「保存失败 + 原因」并保留写前 .bak，不再假装成功。
ipcMain.handle('save-config', async (event, configData) => {
    try {
        const saved = saveHostConfig({
            configPath,
            configBaseDir,
            configData,
            persistProvider: persistProviderStore,
        });

        // 失败：不弹「已成功」，把真实原因告诉用户
        if (!saved.ok) {
            const reason = String(saved.error || '未知原因');
            console.error('保存配置失败:', reason);
            const backupNote = saved.backup && saved.backup.ok && !saved.backup.missing
                ? '\n\n旧配置已备份为 config.json.bak，可手工恢复。'
                : '';
            try {
                await dialog.showMessageBox({
                    type: 'error',
                    title: '配置保存失败',
                    message: '配置未能保存',
                    detail: reason + backupNote,
                    buttons: ['确定'],
                    defaultId: 0
                });
            } catch (dialogError) {
                // 提示框本身失败也不能把真实错误吞掉（上面已 console.error）
                console.error('保存失败提示框显示失败:', dialogError && dialogError.message);
            }
            // 向后兼容：老调用方只认 success；新调用方可用 ok/stage/error。
            // 老调用方忽略返回值也不会崩。
            return { ok: false, success: false, stage: saved.stage, error: reason };
        }

        // 通知用户需要重启应用（只有真写成功才走到这里）
        const result = await dialog.showMessageBox({
            type: 'info',
            title: '配置已保存',
            message: '配置已成功保存',
            detail: '需要重启应用以应用新配置。现在重启应用吗？',
            buttons: ['是', '否'],
            defaultId: 0
        });

        // 如果用户选择重启
        if (result.response === 0) {
            app.relaunch();
            app.exit();
        }

        return { ok: true, success: true, keys: saved.keys, bytes: saved.bytes };
    } catch (error) {
        console.error('保存配置失败:', error);
        return { ok: false, success: false, error: error.message };
    }
});

// 修改获取配置的IPC处理器，假设配置文件总是存在
ipcMain.handle('get-config', async (event) => {
    try {
        const configData = fs.readFileSync(configPath, 'utf8');
        return { success: true, config: JSON.parse(configData) };
    } catch (error) {
        console.error('获取配置失败:', error);
        return { success: false, error: error.message };
    }
});

// 皮套右键快捷菜单只保存自己的两个开关，不弹出“配置已保存”提示。
ipcMain.handle('save-quick-settings', async (_event, patch = {}) => {
    try {
        const configData = loadConfigData();
        if (!configData.ui) configData.ui = {};
        if (!configData.asr) configData.asr = {};
        if (typeof patch.show_chat_box === 'boolean') {
            configData.ui.show_chat_box = patch.show_chat_box;
        }
        if (typeof patch.ptt_enabled === 'boolean') {
            configData.asr.ptt_enabled = patch.ptt_enabled;
        }
        saveConfigData(configData);
        return { success: true };
    } catch (error) {
        console.error('保存皮套快捷设置失败:', error);
        return { success: false, error: error.message };
    }
});

// 皮套 WASM 加载自愈：渲染层 3 连败后请求整页重载（新页=新 WASM 表）。
// 60s 防循环：连炸也不许变成重启风暴。
let __lastPetReloadAt = 0;
ipcMain.on('pet-reload', (event) => {
    const now = Date.now();
    if (now - __lastPetReloadAt < 60000) { console.log('[pet] 重载请求被防循环守卫拦下'); return; }
    __lastPetReloadAt = now;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
        console.log('[pet] 皮套加载 3 连败 → 整页重载自愈');
        win.webContents.reload();
    }
});

// 活动窗口标题清单（本地视频直读用）：desktopCapturer 一次拿全部窗口名，
// 1×1 缩略图最省。比 PowerShell GetForegroundWindow 快且不闪窗。
ipcMain.handle('get-window-titles', async () => {
    try {
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false });
        return { ok: true, titles: sources.map(s => String(s.name || '')).filter(Boolean) };
    } catch (error) {
        console.error('[titles] 枚举窗口失败:', error && error.message || error);
        return { ok: false, titles: [] };
    }
});

// pet-core screen_shot 的**异步**版本（2026-11-22 性能）：
// 原来是 execFileSync —— 主进程被同步阻塞整个 Rust 截图（56~120ms）。主进程一卡，
// 皮套的合成帧提交就跟着卡：实测看屏器官 2fps 采样时皮套 p99 146ms、长帧 2.6%。
// 改成 spawn + Promise，Rust 在子进程里跑，主进程事件循环不再被占住。
function runPetCoreScreenShot(coreExe, outPath) {
    return new Promise((resolve, reject) => {
        const child = require('child_process').spawn(coreExe, [], { windowsHide: true });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
        const timer = setTimeout(() => {
            try { child.kill(); } catch (e) { /* ignore */ }
            done(reject, new Error('pet-core screen_shot 超时（15s）'));
        }, 15000);
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
            if (stdout.length > 64 * 1024 * 1024) {
                try { child.kill(); } catch (e) { /* ignore */ }
                done(reject, new Error('pet-core screen_shot 输出过大'));
            }
        });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8').slice(0, 2000); });
        child.on('error', (error) => done(reject, error));
        child.on('close', (code) => {
            if (code === 0) done(resolve, stdout);
            else done(reject, new Error('pet-core exit ' + code + (stderr ? ': ' + stderr.slice(0, 200) : '')));
        });
        try {
            child.stdin.write(JSON.stringify({ cmd: 'screen_shot', path: outPath }));
            child.stdin.end();
        } catch (error) {
            done(reject, error);
        }
    });
}

ipcMain.handle('take-screenshot', async (event) => {
    // ── ① Rust 引擎优先（2026-11-10 三十七轮，根治黑帧）─────────────────────
    //    拟真实测「截图这边抓不到（黑帧）」：screenshot-desktop 外部包对某些显示配置
    //    输出黑帧（已知问题），且每次 spawn 外部进程 1-2s。
    //    pet-core 的 screen_shot：GDI BitBlt 全屏 → 32bpp BMP，实测 54ms（2560×1600），
    //    同源链路（screen_gray_matrix）在本机一直稳定。失败才落回老包。
    try {
        // ⚠ 2026-11-13 修：这里原来是 `__dirname + 两级 ..`，少一级（pet-core 在项目根，
        //   不在 _incoming 下）→ existsSync 恒 false → 这条「Rust 截图根治黑帧」的补丁
        //   从上线起一次都没跑过，一直静默回落到黑帧的 screenshot-desktop。
        const coreExe = resolvePetCore();
        if (coreExe) {
            const tmpBmp = path.join(os.tmpdir(), `pet-screen-${Date.now()}.bmp`);
            // 2026-11-22 内存/磁盘采样：临时 BMP 原来只在「Rust 成功且读文件成功」这一条路上删。
            // JSON 解析失败 / d.ok=false / readFileSync 抛错都会留下 15MB 的 pet-screen-<ts>.bmp，
            // 实测 %TEMP% 已积 10 个（140MB）。finally 保证任何路径都清掉自己的临时文件。
            try {
                // 异步：不再用 execFileSync 阻塞主进程（见 runPetCoreScreenShot 注释）
                const out = await runPetCoreScreenShot(coreExe, tmpBmp);
                const d = JSON.parse(String(out || '{}'));
                if (d.ok) {
                    // ⚠ 2026-11-13：**不能用 createFromPath** —— Chromium 的 BMP 解码器不认
                    //   负高度（top-down）BMP，实测返回 0×0 空图（「Rust 截图解码为空」）。
                    //   但 createFromBitmap 直接吃 BGRA 像素是好的（实测 2560×1440 成功）。
                    //   所以自己跳过 54 字节头，把像素交给它。
                    const bmpBuf = fs.readFileSync(tmpBmp);
                    if (bmpBuf.length < 54) throw new Error('Rust 截图文件过小（' + bmpBuf.length + ' 字节）');
                    const bmpW = bmpBuf.readInt32LE(18);
                    const bmpH = Math.abs(bmpBuf.readInt32LE(22));
                    if (!(bmpW > 0) || !(bmpH > 0)) throw new Error('Rust 截图头尺寸非法：' + bmpW + '×' + bmpH);
                    const image = nativeImage.createFromBitmap(bmpBuf.subarray(54), { width: bmpW, height: bmpH });
                    if (image.isEmpty()) throw new Error('Rust 截图解码为空（createFromBitmap ' + bmpW + '×' + bmpH + '）');
                    const sourceSize = image.getSize();
                    const scale = Math.min(1, 1600 / sourceSize.width, 900 / sourceSize.height);
                    const resized = scale < 1
                        ? image.resize({ width: Math.round(sourceSize.width * scale), height: Math.round(sourceSize.height * scale), quality: 'fast' })
                        : image;
                    const compressed = resized.toJPEG(80);
                    const b64 = compressed.toString('base64');
                    // 帧去重（2026-11-10 三十七轮，抄 #12）：与上一帧相同的截图不重复喂 vision
                    // （多轮桌面任务的 token 大头是重复截图）。同输入同参数的 JPEG 输出确定相同，
                    // 直接 sha1(b64) 对比即可判「同一帧」。返回仍带图（调用方要喂），只附标记。
                    global.__lastShot = global.__lastShot || { fp: '', at: 0 };
                    const fp = require('crypto').createHash('sha1').update(b64).digest('hex').slice(0, 16);
                    const unchanged = fp === global.__lastShot.fp && (Date.now() - global.__lastShot.at) < 120000;
                    global.__lastShot = { fp, at: Date.now() };
                    global.__lastShotUnchanged = unchanged;
                    console.log(`[截图] Rust 引擎: ${sourceSize.width}x${sourceSize.height} -> ${resized.getSize().width}x${resized.getSize().height}, JPEG 80%${unchanged ? '（与上帧相同，vision 可跳过重看）' : ''}`);
                    return b64;
                }
                console.warn('[截图] Rust 引擎返回失败，落回 screenshot 包：', d.error || '');
            } finally {
                try { fs.unlinkSync(tmpBmp); } catch (e) { /* 没生成/已被清理/被占用：都不影响截图结果 */ }
            }
        }
    } catch (e) {
        console.warn('[截图] Rust 引擎异常，落回 screenshot 包：', (e && e.message) || e);
    }
    // ⚠ 2026-11-09 直播修复（用户实测：桌面看得到皮套，直播/他自己截图看不到）：
    // 根因 = `setContentProtection(true)` 在 Windows 上走 WDA_EXCLUDEFROMCAPTURE，
    // 会让窗口对**所有**截图/录屏/直播捕获隐形——不只是「她自己的眼睛」。
    // 这本来是防止她截到自己（截到的桌面里浮着半透明打字框），但顺带把直播也挡了。
    // 正确做法：**只在「她要截图」的这一瞬间临时解除隐身，截完立刻恢复**。
    // 这样她自己的感知照旧看不到自己，而直播/用户截图始终正常。
    const petWin = BrowserWindow.getAllWindows().find((w) => w.__isPetWindow && !w.isDestroyed());
    const hadProtection = petWin && petWin.__contentProtected === true;
    if (hadProtection) {
        try { petWin.setContentProtection(false); } catch (e) { /* 取消失败就继续（最多她看到自己） */ }
        // 给 DWM 一点时间把窗口重新纳入捕获（实测 <50ms 足够，给 80ms 余量）
        await new Promise((r) => setTimeout(r, 80));
    }
    try {
        await new Promise(resolve => setTimeout(resolve, 100));

        const displays = await screenshot.listDisplays();

        const cursorPoint = screen.getCursorScreenPoint();
        const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);

        const electronDisplays = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x);
        const targetIndex = electronDisplays.findIndex(d => d.id === currentDisplay.id);

        const nativeDisplays = displays.sort((a, b) => (a.left || 0) - (b.left || 0));

        if (targetIndex >= nativeDisplays.length) {
            throw new Error(`屏幕索引越界：鼠标在 Index ${targetIndex}，但原生只检测到 ${nativeDisplays.length} 个屏幕`);
        }

        const targetNativeDisplay = nativeDisplays[targetIndex];

        const imgBuffer = await screenshot({
            screen: targetNativeDisplay.id,
            format: 'jpg'
        });

        // 视觉模型默认使用均衡画质：限制到 1600x900 内、保持比例且不放大小图。
        // 这样可显著减少 2K/4K 屏幕截图的 Base64 体积和上传延迟。
        const image = nativeImage.createFromBuffer(imgBuffer);
        if (image.isEmpty()) throw new Error('截图图像解码失败');
        const sourceSize = image.getSize();
        const scale = Math.min(1, 1600 / sourceSize.width, 900 / sourceSize.height);
        const targetSize = {
            width: Math.max(1, Math.round(sourceSize.width * scale)),
            height: Math.max(1, Math.round(sourceSize.height * scale))
        };
        const resized = scale < 1 ? image.resize({ ...targetSize, quality: 'fast' }) : image;
        const compressed = resized.toJPEG(80);
        // 只在「尺寸组合变化」时打一次（2026-11-12）：原来每帧都打，
        // 实测把 pet-runtime/.state/my-neuro.out.log 刷到 176MB / 267 万行（其中 24 万行就是这句），
        // 真正要看的事件全被埋掉，日志也没法轮转。
        {
            const _shotKey = `${sourceSize.width}x${sourceSize.height}->${targetSize.width}x${targetSize.height}`;
            if (global.__lastShotLogKey !== _shotKey) {
                global.__lastShotLogKey = _shotKey;
                console.log(`截图已压缩: ${_shotKey}, JPEG 80%（尺寸变化时才提示）`);
            }
        }
        return compressed.toString('base64');
    } catch (error) {
        console.error('截图错误:', error)
        throw error;
    } finally {
        // 无论成功失败，都要把防截屏恢复回去（否则她下一次截图会拍到自己）
        if (hadProtection && petWin && !petWin.isDestroyed()) {
            try { petWin.setContentProtection(true); } catch (e) { try { __silentAudit.audit('main.js:restore-content-protection', e); } catch (e2) {} }
        }
    }
})

// SiliconFlow ASR 通过主进程请求，避免渲染进程跨域限制并保护 API Key。
ipcMain.handle('siliconflow-asr-transcribe', async (event, audioBytes) => {
    try {
        const configData = loadConfigData();
        const asrConfig = configData.cloud?.siliconflow_asr || {};
        if (asrConfig.enabled !== true) {
            throw new Error('SiliconFlow ASR 未启用');
        }
        if (!asrConfig.key) {
            throw new Error('SiliconFlow ASR API Key 为空');
        }

        const audioSize = audioBytes?.byteLength || audioBytes?.length || 0;
        logToTerminal('info', `【SiliconFlow ASR】开始上传录音（${audioSize} bytes，模型: ${asrConfig.model || 'XingChenAGI/XingChenASR-V3.2-Ultra'}）`);

        const formData = new FormData();
        formData.append('file', new Blob([audioBytes], { type: 'audio/wav' }), 'recording.wav');
        formData.append('model', asrConfig.model || 'XingChenAGI/XingChenASR-V3.2-Ultra');

        const response = await fetch(
            asrConfig.api || 'https://api.siliconflow.cn/v1/audio/transcriptions',
            {
                method: 'POST',
                headers: { Authorization: `Bearer ${asrConfig.key}` },
                body: formData,
            }
        );
        const bodyText = await response.text();
        let result;
        try { result = JSON.parse(bodyText); } catch (_) { result = { error: bodyText }; }
        if (!response.ok) {
            const detail = result?.message || result?.error?.message || result?.error || bodyText;
            throw new Error(`HTTP ${response.status}: ${detail || '识别请求失败'}`);
        }
        logToTerminal('info', `【SiliconFlow ASR】识别成功${result.text ? `：${result.text}` : '，但返回文本为空'}`);
        return { success: true, text: result.text || '' };
    } catch (error) {
        logToTerminal('error', `【SiliconFlow ASR】请求失败：${error.message}`);
        return { success: false, error: error.message };
    }
})

// 列出已扫描到的 Live2D 模型（供 WebUI、快捷面板和兼容接口使用）。
ipcMain.handle('get-live2d-models', async () => {
    try {
        return { success: true, models: scanLive2DModels() };
    } catch (error) {
        return { success: false, message: error.message, models: [] };
    }
});

// 渲染进程完成热切换后，通过 requestId 确认主进程正在等待的请求。
ipcMain.handle('live2d-switch-model-result', (event, payload) => {
    return completeRendererRequest(event, payload);
});

ipcMain.handle('avatar-switch-type-result', (event, payload) => {
    return completeRendererRequest(event, payload);
});

ipcMain.handle('avatar-reload-model-result', (event, payload) => {
    return completeRendererRequest(event, payload);
});

// 每次窗口启动并完成 Avatar 初始化后回报 ready，用于结束跨渲染引擎切换事务。
ipcMain.handle('avatar-runtime-ready', async (event, payload) => {
    try {
        const win = getRendererWindow(event);
        const result = await getAvatarSwitchTransaction().handleRuntimeReady({
            windowId: win.id,
            success: payload?.success === true,
            activeType: payload?.activeType,
            message: typeof payload?.message === 'string' ? payload.message : ''
        });
        console.log(
            `[Avatar] runtime ready: phase=${result.phase}, active=${result.activeType || 'none'}`
        );
        return result;
    } catch (error) {
        console.error('处理 Avatar runtime ready 失败:', error);
        return { success: false, phase: 'failed', message: error.message };
    }
});

// 重新扫描并热重载当前 Live2D 模型（保留旧接口名，不再改写源码、不再直接 reload 窗口）。
ipcMain.handle('update-live2d-model', async (event) => {
    try {
        let preferred = null;
        try {
            preferred = loadConfigData().ui?.live2d_model || null;
        } catch (_) { try { __silentAudit.audit('main.js:1619', _); } catch (e2) {} }

        const { modelPath, entry, all } = resolveLive2DModel(preferred);
        if (!modelPath || !entry) {
            return { success: false, message: '2D 目录下没有找到任何模型' };
        }

        const win = getRendererWindow(event);
        const result = await requestRendererConfirmation(
            event,
            'live2d-switch-model',
            { modelName: entry.name, modelPath },
            'live2d-refresh'
        );
        if (!result.success) {
            return finalizeRendererFailure(win, result, 'Live2D 模型恢复需要窗口重载');
        }
        return {
            success: true,
            phase: 'ready',
            targetType: 'live2d',
            activeType: 'live2d',
            message: `已重新扫描（共 ${all.length} 个模型），已加载 ${entry.name}`
        };
    } catch (error) {
        console.error('手动更新模型时出错:', error);
        return { success: false, message: `更新失败: ${error.message}` };
    }
});

// 切换 Live2D 模型：先让渲染进程成功加载，再持久化选择。
ipcMain.handle('switch-live2d-model', async (event, modelName) => {
    try {
        console.log(`切换模型到: ${modelName}`);
        const { entry, all } = resolveAvatarModelSelection('live2d', modelName);
        if (!entry) {
            return {
                success: false,
                message: `未找到模型 "${modelName}"（2D 目录下共 ${all.length} 个模型）`
            };
        }

        const win = getRendererWindow(event);
        const result = await requestRendererConfirmation(
            event,
            'live2d-switch-model',
            { modelName: entry.name, modelPath: entry.modelPath },
            'live2d-switch'
        );
        if (!result.success) {
            return finalizeRendererFailure(win, result, 'Live2D 模型恢复需要窗口重载');
        }

        updateUiConfig({ live2d_model: entry.name });
        sendUiConfigPatch(win, { live2d_model: entry.name });
        return {
            success: true,
            phase: 'ready',
            targetType: 'live2d',
            activeType: 'live2d',
            message: `模型已切换到 ${entry.name}`
        };
    } catch (error) {
        console.error('切换模型时出错:', error);
        return { success: false, message: `切换失败: ${error.message}` };
    }
});


// 添加获取窗口实际尺寸的IPC处理器
ipcMain.handle('get-window-bounds', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const bounds = win.getBounds();
    return {
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y
    };
});

// 添加获取所有显示器信息的IPC处理器
// 返回跨屏所需的字段（screenX/screenY 为屏幕绝对坐标，x/y 为相对当前窗口左上角的坐标），
// 同时保留 bounds/workArea/rotation 以兼容旧调用（如 model-setup.js）。
ipcMain.handle('get-all-displays', (event) => {
    const displays = screen.getAllDisplays();
    const win = BrowserWindow.fromWebContents(event.sender);
    const windowBounds = win && !win.isDestroyed() ? win.getBounds() : { x: 0, y: 0 };
    return displays.map(display => ({
        id: display.id,
        x: display.bounds.x - windowBounds.x,
        y: display.bounds.y - windowBounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        screenX: display.bounds.x,
        screenY: display.bounds.y,
        scaleFactor: display.scaleFactor,
        // 兼容旧调用
        bounds: display.bounds,
        workArea: display.workArea,
        rotation: display.rotation
    }));
});

// 获取“当前窗口所在”的显示器信息（渲染端用 screenX/screenY 做窗口<->屏幕坐标换算）
ipcMain.handle('get-current-display', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return null;
    const windowBounds = win.getBounds();
    const currentDisplay = screen.getDisplayMatching(windowBounds);
    return {
        id: currentDisplay.id,
        x: 0,
        y: 0,
        width: currentDisplay.bounds.width,
        height: currentDisplay.bounds.height,
        screenX: currentDisplay.bounds.x,
        screenY: currentDisplay.bounds.y,
        scaleFactor: currentDisplay.scaleFactor,
        workArea: currentDisplay.workArea
    };
});

// 获取主显示器信息
ipcMain.handle('get-primary-display-info', () => {
    const primary = screen.getPrimaryDisplay();
    return {
        id: primary.id,
        bounds: { ...primary.bounds },
        workArea: primary.workArea,
        scaleFactor: primary.scaleFactor
    };
});

// 6.6 单屏切屏入口保留给旧调用，但不再把窗口缩回一块屏。
ipcMain.handle('move-window-to-display', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { success: false, error: 'Window not found' };
    try {
        let config = {};
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) { try { __silentAudit.audit('main.js:1761', e); } catch (e2) {} }
        const target = applyPetUnionBounds(win, config);
        return {
            success: true,
            sameDisplay: true,
            bounds: target ? { x: target.minX, y: target.minY, width: target.totalWidth, height: target.totalHeight } : null
        };
    } catch (err) {
        console.error('move-window-to-display 错误:', err.message);
        return { success: false, error: err.message };
    }
});


// 添加保存模型位置的IPC处理器
ipcMain.on('save-model-position', (event, position) => {
    try {
        const nextPosition = position && typeof position === 'object' ? position : {};
        // 读取当前配置
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        // 更新位置信息
        if (!configData.ui) {
            configData.ui = {};
        }
        if (!configData.ui.model_position) {
            configData.ui.model_position = {
                x: null,
                y: null,
                remember_position: true
            };
        }

        // 巨窗方案恢复 6.55 的单/双屏坐标：右扩巨窗写 x_dual/y_dual。
        if (nextPosition.dual) {
            configData.ui.model_position.x_dual = nextPosition.x;
            configData.ui.model_position.y_dual = nextPosition.y;
        } else {
            configData.ui.model_position.x = nextPosition.x;
            configData.ui.model_position.y = nextPosition.y;
        }
        configData.ui.model_scale = nextPosition.scale;

        // 仍记录当前屏原点，仅供诊断；启动落点以巨窗并集为准。
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
            try {
                const d = screen.getDisplayMatching(win.getBounds());
                configData.ui.model_position.display = { screenX: d.bounds.x, screenY: d.bounds.y };
            } catch (e) { try { __silentAudit.audit('main.js:1810', e); } catch (e2) {} }
        }

        // 保存到文件（原子写 + 回读校验；失败抛给外层 catch 报「保存模型位置失败」）
        const wrote = writeJsonVerified(configPath, configData);
        if (!wrote.ok) throw new Error(wrote.error);

        // v2：如果渲染端提供模型名，同时保存该模型自己的位置/缩放偏好。
        if (nextPosition.modelName) {
            saveModelPrefs('live2d', nextPosition.modelName, {
                position: {
                    x: nextPosition.x,
                    y: nextPosition.y
                },
                scale: nextPosition.scale
            });
        }

    } catch (error) {
        console.error('保存模型位置失败:', error);
    }
});

// 形态切换：主进程负责配置提交、渲染侧确认、窗口重载和失败回滚。
ipcMain.handle('avatar:switch-type', async (event, type) => {
    try {
        const win = getRendererWindow(event);
        return await getAvatarSwitchTransaction().switchType(type, {
            event,
            win,
            windowId: win.id
        });
    } catch (error) {
        console.error('形态切换失败:', error);
        return { success: false, phase: 'failed', message: `形态切换失败: ${error.message}` };
    }
});

// 设置指定形态的模型：先确认当前渲染侧已应用，再持久化选择。
ipcMain.handle('avatar:set-model', async (event, payload) => {
    try {
        const type = String(payload?.type || '').trim().toLowerCase();
        if (!SUPPORTED_AVATAR_TYPES.has(type)) {
            return { success: false, message: `当前 PR 未接入形态: ${type || '未指定'}` };
        }

        const requestedName = String(payload?.model_name || payload?.name || '');
        if (!requestedName.trim()) {
            return { success: false, message: '未提供模型' };
        }

        const selection = resolveAvatarModelSelection(type, requestedName);
        if (!selection.entry) {
            return {
                success: false,
                message: `未找到 ${type} 模型 "${requestedName}"（当前共 ${selection.all.length} 个）`
            };
        }

        const configPatch = type !== 'live2d'
            ? {
                [`${type}_model`]: selection.entry.name,
                [`${type}_model_path`]: selection.entry.modelPath
            }
            : { live2d_model: selection.entry.name };
        const configData = loadConfigData();
        const activeType = normalizeAvatarType(configData.ui?.model_type) || 'live2d';
        const win = getRendererWindow(event);

        if (activeType === type) {
            let result;
            if (type === 'live2d') {
                result = await requestRendererConfirmation(
                    event,
                    'live2d-switch-model',
                    {
                        modelName: selection.entry.name,
                        modelPath: selection.entry.modelPath
                    },
                    'live2d-set-model'
                );
            } else {
                result = await requestRendererConfirmation(
                    event,
                    'avatar-reload-model',
                    {
                        type,
                        configKey: `${type}_model_path`,
                        configValue: selection.entry.modelPath
                    },
                    'avatar-reload-model'
                );
            }
            if (!result.success) {
                return finalizeRendererFailure(
                    win,
                    result,
                    `${type} 模型恢复需要窗口重载`
                );
            }
        }

        updateUiConfig(configPatch);
        sendUiConfigPatch(win, configPatch);
        if (activeType === type) {
            return {
                success: true,
                phase: 'ready',
                targetType: type,
                activeType: type,
                message: `已应用模型：${selection.entry.name}`
            };
        }
        return {
            success: true,
            phase: 'ready',
            targetType: type,
            activeType,
            message: `已保存模型选择：${selection.entry.name}（切换到 ${type} 形态时生效）`
        };
    } catch (error) {
        console.error('设置形态模型失败:', error);
        return { success: false, message: `设置失败: ${error.message}` };
    }
});

// 形态模型列表：Live2D、VRM 和 PMX。
ipcMain.handle('avatar:get-models', async (event, type) => {
    try {
        const normalized = String(type || 'live2d').trim().toLowerCase();
        const scanners = {
            live2d: scanLive2DModels,
            vrm: scanVRMModels,
            mmd: scanMMDModels
        };
        const scan = scanners[normalized];
        if (!scan) {
            return {
                success: false,
                message: `当前 PR 未接入形态: ${type}`,
                models: []
            };
        }
        return { success: true, models: scan() };
    } catch (error) {
        return { success: false, message: error.message, models: [] };
    }
});

// 切换到 VRM 模型：保留旧 IPC 名称，同时接入统一切换事务。
ipcMain.handle('switch-vrm-model', async (event, vrmFileName) => {
    try {
        console.log(`切换VRM模型到: ${vrmFileName}`);

        const selection = resolveAvatarModelSelection('vrm', vrmFileName);
        if (!selection.entry) {
            return {
                success: false,
                message: `未找到 VRM 模型 "${vrmFileName}"（当前共 ${selection.all.length} 个）`
            };
        }

        const configData = loadConfigData();
        const activeType = normalizeAvatarType(configData.ui?.model_type) || 'live2d';
        const win = getRendererWindow(event);
        const modelPatch = {
            vrm_model: selection.entry.name,
            vrm_model_path: selection.entry.modelPath
        };

        if (activeType === 'vrm') {
            const reloadResult = await requestRendererConfirmation(
                event,
                'avatar-reload-model',
                {
                    type: 'vrm',
                    configKey: 'vrm_model_path',
                    configValue: selection.entry.modelPath
                },
                'legacy-vrm-reload'
            );
            if (!reloadResult.success) {
                return finalizeRendererFailure(
                    win,
                    reloadResult,
                    'VRM 模型恢复需要窗口重载'
                );
            }
            updateUiConfig(modelPatch);
            sendUiConfigPatch(win, modelPatch);
            return {
                success: true,
                phase: 'ready',
                targetType: 'vrm',
                activeType: 'vrm',
                message: `VRM 模型已切换到 ${selection.entry.name}`
            };
        }

        // 先保存 VRM 选择，但不提前改 model_type，让事务仍能读取真实旧形态。
        updateUiConfig(modelPatch);
        sendUiConfigPatch(win, modelPatch);
        const switchResult = await getAvatarSwitchTransaction().switchType('vrm', {
            event,
            win,
            windowId: win.id
        });

        return {
            ...switchResult,
            message: switchResult.success
                ? `${switchResult.message}；VRM 模型：${selection.entry.name}`
                : switchResult.message
        };
    } catch (error) {
        console.error('切换VRM模型时出错:', error);
        return { success: false, message: `切换失败: ${error.message}` };
    }
});
