// petbody-entry.mjs —— 把我们的身体渲染器打包成 my-neuro 页面可直接用的全局对象。
// 由 build-petbody.mjs 用 esbuild 打成 iife，暴露 window.PetBody。
// createPetBody 返回的 api 多了 mountUi(container, hooks)：宿主页 js/avatar/petbody/ui.js
// 用它把我们的面板/大字幕挂进 my-neuro，而不动它的渲染根。
import { JellyfishRenderer } from './cubism-renderer.mjs';
import { applyAsset, getState, listAssets, listPresets, applyPreset, currentPreset, applyAssetValue, getPinnedAssetParams } from './asset-toggles.mjs';
import { createPetBodyUi } from './ui/petbody-ui.mjs';
import { createEmotionEngine, blendParam, EMOTIONS, bindCanvasListeners } from './emotion-engine.mjs';
import { createPerfEngine, buildProfile, PROFILE_SPECS, EXTERNALLY_OWNED, EXTERNALLY_OWNED_PARAMS, PERF_SHARED_OWNED_PARAMS } from './perf/index.mjs';
import { selectPhysicsOutputTargets } from './perf/param-commit.mjs';
import { classifyParam } from './perf/physics-io.mjs';
import { findExternalOwnershipViolations } from './param-ownership-probe.mjs';
import { createPerformanceArbiter, buildPerformanceStatus } from './perf/performance-arbiter.mjs';
// P2b（2026-11-25，ADR-015 §3.1）：调度器只管「什么时候换人」（排队/relax 抢占/收势），
// claim 仍由 perfArbiter 单点持有。performance.scheduler.enabled !== true 时根本不创建它。
import { createScheduler, loadSync as loadPerfSync, syncFor as selectPerfSync } from './perf/perf-scheduler.mjs';
// P3a（2026-11-25，ADR-015 §3.5）：节目单运行器。只依赖注入的 scheduler/播放器/台词/音效，
// 抢占与收势仍归调度器；scheduler 关着时 playProgram 直接返回 scheduler-off（不偷偷走旧路径）。
import { createProgramRunner } from './perf/program-runner.mjs';
import { checkWriteSet, writePerfParams, detectExternalPins, SHARED_ASSET_PARAM_SET, filterPinnedExpressions, checkChoreoWriteSet } from './perf/param-ownership.mjs';
import { readPresence } from './perf/presence.mjs';
import { decide as directorDecide, gate as directorGate, resolvePerformanceConfig, PERFORMANCE_DEFAULTS, budgetsFromSummary } from './perf/director.mjs';
import { createAmbient } from './perf/ambient.mjs';
import { expressionAffect } from './pad-expression.mjs';
import { validateRanges } from './perf/param-inventory.mjs';
import { GazeFollow } from './ui/gaze.mjs';
import { performanceForEmotion, samplePerformance, performanceWeight } from './choreo-tracks.mjs';
import { createPerformer } from './choreo-performer.mjs';
import { createAutoTrigger } from './choreo-auto.mjs';
// D6（2026-11-22）：performance-log → 冷却/优先级倍率。CJS 模块，esbuild 会内联；
// 读不到日志/开关关掉/样本不足都返回空表（=1.0），不改变旧决策。
import choreoTune from '../../_incoming/my-neuro/live-2d/js/core/choreo-tune.js';
import { sampleClip as sampleFacsClip } from './perf/facs-clip-player.mjs';
import { createClipDirector } from './perf/facs-clip-director.mjs';
import lumenSemantic from './perf/lumen-semantic-client.cjs';
import { createPerformanceLog } from './perf/performance-log.mjs';

const NEUTRAL = { state: 'idle', expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null }, mouth: 0 };

// 情绪名映射（setEmotion 与持久化恢复共用一份，别再各写一遍）
const EMOTION_KEYS = Object.freeze({ 开心: 'happy', 生气: 'angry', 难过: 'sad', 惊讶: 'surprise', 害羞: 'shy', 俏皮: 'smug', 得意: 'smug', 无聊: 'bored', 委屈: 'aggrieved', 心虚: 'guilty', 困: 'sleepy' });
const EMOTION_EN = Object.freeze(['happy', 'sad', 'angry', 'surprise', 'shy', 'smug', 'tease', 'bored', 'aggrieved', 'guilty', 'sleepy']);
export function normalizeEmotionName(name) {
  const raw = String(name || '').trim();
  return EMOTION_KEYS[raw] || (EMOTION_EN.includes(raw) ? raw : null);
}

// ── C-1b 情绪状态持久化（8103 /emotion-state）─────────────────────────────
// 目标：重启后她的情绪还在（按 10 分钟半衰期衰减，不把昨天的怒气带回来）。
const EMOTION_STATE_URL = 'http://127.0.0.1:8103/emotion-state';
const EMOTION_HALF_LIFE_SEC = 600;

// 2026-11-10：原来 AUTO 只有 3 个 procedural + 常驻待机动作，**一个表情预设都没有**。
//   updateView 里 `enabled(item.id)` 判 false → face 永远空 → 皮套 7 张情绪脸（开心/害羞/
//   难过/生气/惊讶/得意/尴尬）从来没上过场。用户反馈「她不会做表情，皮套明明都有」。
const AUTO = [
  'proc-head', 'proc-body', 'proc-blink', 'motion-idle-0',
  'expr-happy', 'expr-shy', 'expr-sad', 'expr-angry', 'expr-surprised', 'expr-smug', 'expr-awkward',
];

// 宿主页（my-neuro/live-2d）的 index.html 不在本任务改动范围，所以 bundle 自己把
// js/avatar/petbody/ui.js 注入进去；它会等 window.petBody 就绪后调用 mountUi。
const CURRENT_SCRIPT_SRC = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src)
  ? document.currentScript.src
  : '';

(function autoInjectHostUi() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  // 默认关闭：宿主的 js/ui/ui-controller.js 已经提供完整 UI（无框描边字幕 / 6 种打字框 /
  // 跟随气泡 / 右键菜单 / 控制按钮组）。我们那套 petbody-ui.mjs 属于重复造轮子，
  // 只有显式打开 window.__PETBODY_AUTO_UI__ 时才注入（留给独立舞台页 debug 用）。
  if (window.__PETBODY_AUTO_UI__ !== true) return;
  if (window.__PETBODY_NO_AUTO_UI__ === true) return;
  const load = () => {
    try {
      if (document.querySelector('script[data-petbody-host-ui]')) return;
      let src = '';
      if (CURRENT_SCRIPT_SRC) src = new URL('../js/avatar/petbody/ui.js', CURRENT_SCRIPT_SRC).href;
      if (!src) src = new URL('js/avatar/petbody/ui.js', document.baseURI).href;
      const script = document.createElement('script');
      script.dataset.petbodyHostUi = '1';
      script.async = true;
      script.src = src;
      script.onerror = () => console.info('[petbody] 宿主 ui.js 未加载（' + src + '），面板/大字幕不可用');
      document.head.appendChild(script);
    } catch (error) {
      console.info('[petbody] 注入宿主 UI 失败', error);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true });
  else load();
})();

export function createPetBody(canvas, options = {}) {
  const errors = [];
  const renderer = new JellyfishRenderer(canvas, (event) => {
    try { if (typeof window !== 'undefined' && window.__petBodyReport) window.__petBodyReport(event); } catch (err) {}
    if (event && event.type === 'error') { errors.push(event.message); console.error('[petbody]', event.message); }
  }, {
    assetBase: options.assetBase || 'assets/petbody/',
    mouthGain: options.mouthGain || 1.25,
    premultiplied: options.premultiplied !== false,
    shaderBase: options.shaderBase || 'vendor/cubism/Framework/Shaders/WebGL/',
    // 省电模式（2026-11-09）：默认关（满帧优先，用户投诉过待机卡）。
    // 开 = 待机降到每 3 帧重算，适合游戏时让 GPU。
    powerSave: options.powerSave === true,
  });

  const state = { mouth: 0, mouthSmooth: 0, emotion: 'neutral', gesture: null, speaking: false, workState: 'idle', lastMouthAt: 0 };
  // 编舞 v1（2026-11-15）：说话开始时按情绪播一段参数轨道；默认关，由托盘/配置打开。
  // 轨道是「加法偏置」，播完权重归零 —— 不和物理/呼吸/眨眼抢，也不会留残值。
  const choreo = { perf: null, startedAt: 0, prevSpeaking: false, lastKey: '', lastApplyAt: 0 };
  // 编舞 v2（2026-11-15）：情景长表演（15 段，19–38 秒，Python 离线编译成参数轨道）。
  // 与 v1 的分工：v1 是说话时的情绪微动作（2–4 秒，自动），v2 是「演一段戏」（按名字手动）。
  // 两者可同帧叠加：v1 走 choreo 加法、v2 走 additive+override 两条道，互不覆盖。
  const performer = createPerformer();
  // D6（2026-11-22）导演改戏：performance-log 回灌冷却/优先级倍率。
  // 30 秒进程内缓存：loadTuning 自己按 mtime/10 分钟缓存，这层只是避免每帧 stat 文件。
  // 任何异常/文件缺失 → null，决策层按 1.0 处理。
  let _tuneCache = { at: 0, value: null };
  function choreoTuning() {
    const nowMs = Date.now();
    if (nowMs - _tuneCache.at < 30000) return _tuneCache.value;
    let value = null;
    try { value = choreoTune.loadTuning(); } catch (e) { value = null; }
    // P1：loadTuning 已改为「先回上次值 + 异步重算」。首次调用会拿到 reason='warming'
    // 的空表 —— 这时候不要缓存 30 秒，否则启动后半分钟都不调参。
    const warming = Boolean(value && value.meta && value.meta.reason === 'warming');
    _tuneCache = { at: warming ? 0 : nowMs, value };
    return value;
  }
  // 自动触发器（2026-11-16）：情绪驱动的节流决策 + 冷却记账。决策逻辑在 choreo-auto.mjs。
  const perfAuto = createAutoTrigger({ tuningProvider: choreoTuning });
  // 空闲通道（v3）：多久没说话 + 上次评估时间。她安静站着时会自己练一段（05/06/07/08/01，稀有 13）。
  const perfIdle = { lastSpeakingAt: (typeof performance !== 'undefined' ? performance.now() : Date.now()), lastCheckAt: 0 };
  // 情绪到位通道（v3.1）：引擎算出的强情绪先暂存，等这句说完再演
  const perfEmo = { lastKey: '', lastAt: 0, pending: null, lastYieldAt: 0 };

  // ── 导演层（2026-11-25 P0，ADR-015 §3.3）────────────────────────────────
  // presence/density 门：默认 **dry-run**（只写 perf.request，不拦任何表演）。
  // 配置来源优先级：window.__petPerformanceConfig（driver 下发）> 默认值。
  // 不做每帧决策：只在「本来就要 consider」的那几个点问一次（T1 说话沿 / T2 情绪到位 /
  // T3 空闲 20s 一次 / clip 峰值 2s 一次 / clip 空闲 8min 一次）。
  const perfDirector = {
    cfg: resolvePerformanceConfig(null),
    lastDecision: null,
    lastAt: 0,
  };
  // perf.request 日志去重（2026-11-25 P1 真机实测）：启动打招呼时 TTS 分段让
  // speaking 反复上升沿，3 秒内写了 6 条 auto:speech —— 决策照算，只是少写日志。
  const perfRequestLogAt = new Map();
  const perfSkipLogAt = new Map();
  const PERF_REQUEST_LOG_GAP_MS = 2000;
  const PERF_SKIP_LOG_GAP_MS = 10000;
  // 会话统计（导演强度曲线用）：开始时间 / 轮数 / 用户最近一次主动交互
  const perfSession = { startedAt: Date.now(), turns: 0, userActionAt: 0, lastTextAt: 0 };

  // ── 待机层（2026-11-25 P1，ADR-015 §3.4）────────────────────────────────
  // 6 态 Markov + 对数正态停留 + 加权待机池 + 程序化呼吸；每帧 O(1)。
  // 配置来源：perfDirector.cfg.ambient（缺键 = enabled:true / scale:0.3）。
  const ambient = createAmbient({
    enabled: (perfDirector.cfg.ambient || PERFORMANCE_DEFAULTS.ambient).enabled !== false,
    scale: (perfDirector.cfg.ambient || PERFORMANCE_DEFAULTS.ambient).scale,
    seed: 20261125,
  });
  // 待机上下文（读 world-sense/会话现场是同步函数调用，1 秒采样一次就够，别每帧问）
  const ambientCtx = { at: 0, presence: 'unknown', idleSec: 0, conversationEndedAt: 0, lastSpeaking: false };
  // 导演 intensity → ambient（幅度/状态偏好）：最近一次决策的 intensity
  function ambientIntensity() {
    const d = perfDirector.lastDecision;
    return d && Number.isFinite(Number(d.intensity)) ? Number(d.intensity) : 0;
  }

  // ── 表演占用仲裁（2026-11-21 P1/P2）：单一 claim + 播放进度 ─────────────
  // 片段导演（clip）、长表演（v2）、显式手动（manual/scenes）启动前都必须先 begin()。
  // 同一帧只有一个 owner 能拿到；另一个记 yield 并让位 —— 旧实现里
  // maybeTriggerFacsClip 先算 busy=performer.active（那时 v2 还没启动），
  // v2 自动启动在同帧稍后，于是两套表演同时写脸，导演的 busy 门被绕过。
  // 优先级：manual/scenes(5) > clip(3) > v2(2) > micro(1)；只有显式手动能 preempt。
  const perfArbiter = createPerformanceArbiter({
    now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    log: (line) => { try { console.info('[petbody:perf-claim] ' + line); } catch (e) { /* ignore */ } },
  });
  const perfClaim = perfArbiter.claim;

  // ── 演出调度器（2026-11-25 P2b，ADR-015 §3.1）────────────────────────────
  // 三个刻意的设计决定：
  //   1. **默认不建**：enabled !== true 时 ensureScheduler() 返回 null，所有调用点
  //      原样走旧 arbiter 路径（逐位一致；P2a 的 begin/end 兼容层只用于热重载空窗）。
  //   2. **懒创建**：第一次 request/tick 时才建（applyPerfConfig 在 perfLog 定义之前跑，
  //      提前建会在闭包里碰到 TDZ）。
  //   3. **热滚动**：中途把 enabled 改 false → reset + 交还 claim（不留幽灵占用）。
  let perfSched = null;
  let perfSyncDoc = null;
  const perfSyncInfo = { file: '', items: 0, loaded: 0, version: 0, error: '' };
  const schedPending = new Map();   // token → { kind, owner, key, apply(ev) }（收势期间排队的请求）
  let schedLastEvent = null;        // 最近一次调度事件（performanceDebug 看「最近一次 yield 原因」）
  const SCHED_PENDING_LIMIT = 8;

  function schedulerEnabled() {
    const cfg = perfDirector.cfg || resolvePerformanceConfig(null);
    const s = cfg.scheduler || PERFORMANCE_DEFAULTS.scheduler;
    return s.enabled === true;
  }

  /** pet-runtime/data 目录（与 performance-log/FACS 片段同一套向上查找；没有 fs 返回空） */
  function perfDataDir() {
    try {
      const fs = require('fs');
      const path = require('path');
      const starts = [];
      try { starts.push(__dirname); } catch (e) { /* bundle 里可能没有 */ }
      if (typeof process !== 'undefined' && process.cwd) starts.push(process.cwd());
      for (const start of starts) {
        let d = path.resolve(start);
        for (let i = 0; i < 8; i += 1) {
          const cand = path.join(d, 'pet-runtime', 'data');
          if (fs.existsSync(cand)) return cand;
          const up = path.dirname(d);
          if (up === d) break;
          d = up;
        }
      }
    } catch (e) { /* 没有 fs = 没有 sync（调度器退化 atomic，不报错） */ }
    return '';
  }

  /** 读 perf-sync.json（一次性；缺文件/坏 JSON 都返回 null，调度器退化 atomic） */
  function loadPerfSyncDoc() {
    if (perfSyncDoc) return perfSyncDoc;
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = perfDataDir();
      if (!dir) { perfSyncInfo.error = 'no-data-dir'; return null; }
      const file = path.join(dir, 'perf-sync.json');
      perfSyncInfo.file = file;
      perfSyncDoc = loadPerfSync({ file, readFile: (f) => fs.readFileSync(f, 'utf8') });
      if (!perfSyncDoc) { perfSyncInfo.error = 'missing-or-broken'; return null; }
      const items = perfSyncDoc.items && typeof perfSyncDoc.items === 'object' ? Object.keys(perfSyncDoc.items) : [];
      perfSyncInfo.version = Number(perfSyncDoc.version) || 0;
      perfSyncInfo.items = items.length;
      perfSyncInfo.loaded = items.length;   // 整份解析进内存；缺 key 时 syncFor 返回 null
      perfSyncInfo.error = '';
      return perfSyncDoc;
    } catch (e) {
      perfSyncInfo.error = String((e && e.message) || e);
      return null;
    }
  }

  function ensureScheduler() {
    if (!schedulerEnabled()) return null;
    if (perfSched) return perfSched;
    try {
      loadPerfSyncDoc();
      perfSched = createScheduler({
        now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
        arbiter: perfArbiter,
        log: (line) => { try { console.info('[petbody:perf-sched] ' + line); } catch (e) { /* ignore */ } },
        onChange: onSchedulerEvent,
      });
    } catch (e) {
      console.warn('[petbody] 调度器创建失败，继续走旧 arbiter 路径', e);
      perfSched = null;
    }
    return perfSched;
  }

  /** 调度器事件 → 日志账 + 真正启停各层（抢人的视觉收势在 'retract' 里做） */
  function onSchedulerEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    const type = String(ev.type || '');
    schedLastEvent = {
      type, owner: ev.owner || ev.from || '', key: ev.key || '', reason: ev.reason || '',
      at: Number(ev.at) || Date.now(),
    };
    if (type === 'start') {
      // 账：画面真的换到它了（与决策日志 'play' 分开，P3 节目单按这个算真实开始）
      try { perfLog.noteStart({ key: ev.key, owner: ev.owner, plannedMs: ev.plannedMs }); } catch (e) { /* ignore */ }
      const p = schedPending.get(ev.token);
      if (p) {
        schedPending.delete(ev.token);
        try { p.apply(ev); } catch (e) { /* 单次启动失败不影响调度 */ }
      } else if (ev.owner === 'v2' || ev.owner === 'manual') {
        // 兜底：队列由 tick 拉起但没有登记（P2c 节目单会走这条）
        beginV2Playback(ev.key, ev.owner, null);
      }
      return;
    }
    if (type === 'retract') {
      // 账：旧层收势、新层 pending（atRelax=false 就是显式手动立即抢）
      try {
        perfLog.noteInterrupt({
          from: ev.from, to: ev.to, atRelax: ev.atRelax === true, retractMs: ev.ms,
        });
      } catch (e) { /* ignore */ }
      // 视觉收势：v2/manual/program 有权重可淡；clip 有自己的逐通道平滑（stop 时会淡出）；
      // scenes 是 setTimeout 串，最后一步的情绪包络自己会落。
      if ((ev.from === 'v2' || ev.from === 'manual' || ev.from === 'program') && performer.active) {
        try { performer.fadeOut(Number(ev.ms) || 0); } catch (e) { /* ignore */ }
      }
      return;
    }
    if (type === 'expired' || type === 'cancelled') {
      // 队列里的请求过期/被取消（ttl、queue-full、被同 owner 新请求顶掉）：
      // 待启动表必须同步删掉，否则会留一条永远等不到 start 的登记（pending 泄漏）。
      schedPending.delete(ev.token);
      return;
    }
    if (type === 'end') {
      // 账：一次演出结束（endedBy 只暴露 natural/interrupt/budget，与 ADR §4.4 一致）
      // 'replace' 是同一 owner 的换段：新段的 play 已经写在 lastPlay 上，
      // 此时再 noteEnd 会把**刚开演的新段**结掉 → 跳过（旧段只是被替换，不留独立账）。
      if (ev.endedBy !== 'replace') {
        const endedBy = mapSchedEndedBy(ev.endedBy);
        try {
          perfLog.noteEnd({ endedBy, clipId: ev.key, plannedMs: ev.plannedMs, actualMs: ev.actualMs });
        } catch (e) { /* ignore */ }
      }
      // 真正停掉旧层的写者（'replace' 是同一 owner 换段，新的一段已经在写，绝不能停）
      if (ev.endedBy !== 'replace' && ev.endedBy !== 'superseded') stopLayerFor(ev.owner, ev.key, ev.endedBy);
    }
  }

  function mapSchedEndedBy(v) {
    const s = String(v || '');
    if (s === 'natural') return 'natural';
    if (s === 'interrupt' || s === 'replace' || s === 'released') return 'interrupt';
    if (s === 'expired' || s === 'cancelled') return 'budget';
    return 'natural';
  }

  function clearSceneTimers() {
    try {
      if (api && Array.isArray(api._sceneTimers)) {
        for (const id of api._sceneTimers) clearTimeout(id);
        api._sceneTimers = [];
      }
    } catch (e) { /* api 还没初始化（理论上到不了） */ }
  }

  /** 旧 owner 的写者停掉（收势完成后才调；同 owner 换段由 'replace' 排除） */
  function stopLayerFor(owner, key, why) {
    try {
      if (owner === 'clip') {
        // cancelPending:false —— 队列里的「下一条」属于调度器，不能被旧层的停止顺手取消
        if (emotion.facsClips && emotion.facsClips.isPlaying) emotion.facsClips.stop('interrupt', { cancelPending: false });
      } else if (owner === 'scenes') {
        clearSceneTimers();
      } else if (owner === 'v2' || owner === 'manual') {
        if (performer.active && (!key || performer.key === String(key))) performer.stop(why || 'interrupt');
      }
    } catch (e) { /* 停止失败不影响调度状态 */ }
  }

  /**
   * 交还占用：调度器接管时走 finish（它同时负责拉起队列下一条），否则旧 arbiter。
   * 调度器是「热开启」的（开启前已有旧 claim）时 finish 找不到 current → 回落 arbiter.end，
   * 绝不留下「画面停了但 claim 还在」的静默占用。
   */
  function endClaim(owner, token, endedBy) {
    if (perfSched) {
      try { if (perfSched.finish(token || owner, { endedBy: endedBy || 'natural' })) return true; } catch (e) { /* 回落 */ }
    }
    try { return perfArbiter.end(owner, token); } catch (e) { return false; }
  }

  /** 取消队列里/待启动表里属于某个 owner 的请求（显式停止、dispose 用） */
  function cancelSchedPending(match) {
    if (!perfSched) return 0;
    const tokens = [];
    try {
      for (const q of perfSched.status().queue || []) {
        if (match(q.owner) && !tokens.includes(q.token)) tokens.push(q.token);
      }
    } catch (e) { /* ignore */ }
    for (const [token, p] of Array.from(schedPending.entries())) {
      const owner = p.owner || (p.kind === 'v2' ? 'v2' : p.kind);
      if (match(owner) && !tokens.includes(token)) tokens.push(token);
    }
    let n = 0;
    for (const t of tokens) {
      schedPending.delete(t);
      try { if (perfSched.finish(t, { endedBy: 'cancelled' })) n += 1; } catch (e) { /* ignore */ }
    }
    return n;
  }

  /** v2 真正开演（scheduler 的 'start' 时调；旧路径在 requestPerformance 里直接调） */
  function beginV2Playback(key, owner, perfOpts, logInfo) {
    if (!key) return false;
    // 换人时旧写者必须真的停（收势已由 retract 的 fadeOut 做；这里只兜底）
    try {
      if (performer.active && performer.key !== String(key)) performer.stop('switch');
      if (emotion.facsClips && emotion.facsClips.isPlaying) emotion.facsClips.stop('interrupt', { cancelPending: false });
      clearSceneTimers();
    } catch (e) { /* ignore */ }
    // 幂等：scheduler.request 的 'start' 事件是**同步**发的（回调里已经兜底启动过一次），
    // 调用方紧接着的那次 begin 不能把刚起势的表演又重启一遍（会重置 startedAt/手势 fired）。
    const sameJustStarted = performer.active && performer.key === String(key)
      && performer.elapsedMs(performance.now()) < 60;
    if (!sameJustStarted) {
      const started = performer.start(String(key), performance.now(), perfOpts || {});
      if (!started) {
        try { endClaim(owner || 'v2', '', 'interrupt'); } catch (e) { /* ignore */ }
        return false;
      }
    }
    // v1 让位：两套同时演会互相盖参数（与旧路径 requestPerformance 调用点一致）
    try { choreo.perf = null; } catch (e) { /* ignore */ }
    // 决策日志在**真开演**这一刻写（见 requestPerformance 的账目说明）
    if (logInfo) {
      try {
        perfLog.noteDecision({
          source: owner === 'manual' ? 'manual' : 'auto',
          emotion: '',
          intensity: null,
          played: true,
          perfKind: 'v2',
          decision: {
            clipId: String(key),
            label: (logInfo.meta && logInfo.meta.title) || String(key),
            reason: logInfo.logReason || 'v2-long',
            detail: { durationMs: logInfo.durationMs },
          },
        });
      } catch (e) { /* 日志失败绝不影响表演 */ }
    }
    return true;
  }

  // 表演库元数据（时长/标题）：performer.list() 是唯一现成来源，缓存一次。
  const perfMetaByKey = new Map();
  function performanceMeta(key) {
    const k = String(key || '');
    if (!perfMetaByKey.size) {
      try { for (const item of performer.list()) perfMetaByKey.set(String(item.key), item); } catch (e) { /* ignore */ }
    }
    return perfMetaByKey.get(k) || null;
  }

  // ── 节目单（P3a，ADR-015 §3.5）───────────────────────────────────────────
  // 节目单 = 几段长表演 + 台词 + 音效串成一次「事件」（45–90s、≤3 段），不是把单段拉长。
  //   · 运行器只管「按 beat 串」；抢占/排队/收势仍由 perf-scheduler 决定（owner='program'）。
  //   · 数据：pet-runtime/data/programs/*.json（离线产物；tools/check-programs.mjs 校验）。
  //   · 预算：performance.program.max_per_day，只计节目单（不吃导演的自动演出额度）。
  //   · 台词：宿主有 globalThis.petSpeak 就走真 TTS（字幕/口型由它带），否则字幕 + 事件 +
  //     按字数估算时长。TTS 不可用不会卡死：运行器另有 maxMs/2 超时。
  const programsInfo = { list: [], byId: new Map(), dir: '', error: '', loadedAt: 0 };
  let programRunner = null;
  const programBudget = { day: '', used: 0, plays: 0, byEndedBy: {} };

  function programCfg() {
    const cfg = perfDirector.cfg || resolvePerformanceConfig(null);
    return cfg.program || PERFORMANCE_DEFAULTS.program;
  }

  function programDayKey(ts) {
    const d = new Date(Number(ts) || Date.now());
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function rollProgramDay(ts) {
    const key = programDayKey(ts);
    if (programBudget.day !== key) { programBudget.day = key; programBudget.used = 0; }
    return key;
  }

  function programMaxPerDay() {
    return Math.max(0, Number(programCfg().max_per_day) || 0);
  }

  // 运行器注入的预算口：只计 program（takeProgram 在启动前调用，失败会 release 退还）
  const programBudgetApi = {
    takeProgram() {
      rollProgramDay();
      const max = programMaxPerDay();
      if (programBudget.used >= max) return { ok: false, reason: 'budget', left: 0, max };
      programBudget.used += 1;
      return { ok: true, left: Math.max(0, max - programBudget.used), max };
    },
    releaseProgram() {
      rollProgramDay();
      if (programBudget.used > 0) programBudget.used -= 1;
      return true;
    },
    left() {
      rollProgramDay();
      return Math.max(0, programMaxPerDay() - programBudget.used);
    },
  };

  /** 读 pet-runtime/data/programs/*.json（懒加载一次；缺目录/坏 JSON 只记 error，不抛） */
  function loadProgramsDoc() {
    if (programsInfo.loadedAt) return programsInfo;
    programsInfo.loadedAt = Date.now();
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = perfDataDir();
      if (!dir) { programsInfo.error = 'no-data-dir'; return programsInfo; }
      const pdir = path.join(dir, 'programs');
      programsInfo.dir = pdir;
      if (!fs.existsSync(pdir)) { programsInfo.error = 'missing-dir'; return programsInfo; }
      const files = fs.readdirSync(pdir).filter((n) => /\.json$/i.test(n)).sort();
      const list = [];
      for (const name of files) {
        try {
          const doc = JSON.parse(fs.readFileSync(path.join(pdir, name), 'utf8'));
          if (!doc || !doc.id) { programsInfo.error = 'bad-item:' + name; continue; }
          list.push(doc);
          programsInfo.byId.set(String(doc.id), doc);
        } catch (e) {
          programsInfo.error = 'parse:' + name;
        }
      }
      programsInfo.list = list;
      if (!programsInfo.error) programsInfo.error = list.length ? '' : 'empty';
    } catch (e) {
      programsInfo.error = String((e && e.message) || e);
    }
    return programsInfo;
  }

  /** 节目单里的「换一段」：直接开演该段（claim 已在 program 手上，写参数路径与 v2 相同） */
  function programPlaySegment(seg) {
    const key = String(seg || '');
    if (!performanceMeta(key)) return false;
    try {
      if (performer.active) performer.stop('program-switch');
      if (emotion.facsClips && emotion.facsClips.isPlaying) {
        emotion.facsClips.stop('interrupt', { cancelPending: false });
      }
    } catch (e) { /* ignore */ }
    let ok = false;
    try { ok = performer.start(key, performance.now(), {}) === true; } catch (e) { ok = false; }
    // v1 让位：两套同时演会互相盖参数（与 v2 路径一致）
    try { choreo.perf = null; } catch (e) { /* ignore */ }
    return ok;
  }

  /** 段间/收尾的收势：先让权重线性落到 0，再等它真的走完（performer 按采样时钟计时） */
  function programFadeOut(ms) {
    const dur = Math.max(0, Number(ms) || 0);
    try { if (performer.active) performer.fadeOut(dur); } catch (e) { /* ignore */ }
    if (!(dur > 0)) return undefined;
    return new Promise((resolve) => { try { setTimeout(resolve, dur); } catch (e) { resolve(); } });
  }

  /**
   * 一句台词：说完的 promise。
   * 优先级：宿主 petSpeak（真 TTS，字幕/口型它包了）→ 事件 petbody:speak + 气泡字幕。
   * 完成判据：嘴动过又停了（真 TTS）→ 立刻返回；否则按字数估算（不假装知道）。
   */
  function programSpeak(line, opts = {}) {
    const text = String(line || '');
    if (!text) return Promise.resolve({ ms: 0, via: 'empty' });
    try { showBubble(text); } catch (e) { /* ignore */ }
    let host = null;
    try {
      if (typeof globalThis !== 'undefined' && typeof globalThis.petSpeak === 'function') host = globalThis.petSpeak;
      else if (typeof window !== 'undefined' && typeof window.petSpeak === 'function') host = window.petSpeak;
    } catch (e) { host = null; }
    let via = 'estimate';
    let hostPromise = null;
    if (host) {
      try {
        const r = host(text);           // 宿主 TTS：真播（字幕/口型/音频都在它那边）
        if (r && typeof r.then === 'function') hostPromise = r;
        via = 'tts';
      } catch (e) { via = 'estimate'; }
    }
    if (via !== 'tts') {
      try {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('petbody:speak', { detail: { text } }));
        }
      } catch (e) { /* 没有宿主监听也不影响时序 */ }
    }
    let span = 0;
    try { span = Array.from(text).length; } catch (e) { span = text.length; }
    const estMs = Math.max(700, Math.min(9000, span * 210));
    return new Promise((resolve) => {
      const t0 = Date.now();
      const sig = opts && opts.signal;
      let iv = null;
      let settled = false;
      let sawSpeaking = false;
      const onAbort = () => finish('abort');
      function finish(reason) {
        if (settled) return;
        settled = true;
        try { if (iv) clearInterval(iv); } catch (e) { /* ignore */ }
        try { if (sig && typeof sig.removeEventListener === 'function') sig.removeEventListener('abort', onAbort); } catch (e) { /* ignore */ }
        resolve({ ms: Date.now() - t0, via, reason });
      }
      if (sig && typeof sig.addEventListener === 'function') {
        if (sig.aborted) { finish('abort'); return; }
        try { sig.addEventListener('abort', onAbort); } catch (e) { /* ignore */ }
      }
      // 宿主 TTS 的 promise 是**最准**的完成信号（processTextToSpeech 说完才 resolve）
      if (hostPromise) {
        hostPromise.then(() => finish('tts'), () => finish('tts-error'));
      }
      iv = setInterval(() => {
        const speaking = state.speaking === true;
        if (speaking) sawSpeaking = true;
        const elapsed = Date.now() - t0;
        if (hostPromise) {
          // 有 TTS：嘴动过又停下就是说完（比 promise 更实时），15s 兜底
          if (elapsed > 400 && sawSpeaking && !speaking) finish('tts');
          else if (elapsed >= 15000) finish('cap');
        } else if (elapsed >= estMs) {
          finish('estimate');
        }
      }, 100);
    });
  }

  /** 音效：与 SCENES 同一条路（渲染层不播，交给宿主 sfx 插件） */
  function programSfx(id) {
    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('petbody:sfx', { detail: { id: String(id) } }));
      }
    } catch (e) { /* ignore */ }
  }

  /**
   * 运行器遥测 → performance-log。
   * start → 一条 play（perfKind:'program'，source 记 manual：P3a 只有用户点播，没有自动通道，
   *         所以不该吃导演的自动日预算；节目单有自己的 max_per_day）。
   * beat/end → perf.program（new，字段见 ADR §4.4 扩展；旧字段不受影响）。
   * end 的 perf.end 由调度器 'end' 事件照旧写，这里不重复。
   */
  function onProgramTelemetry(evt) {
    try {
      if (!evt || typeof evt !== 'object') return;
      if (evt.scope === 'program' && evt.phase === 'start') {
        programBudget.plays = (Number(programBudget.plays) || 0) + 1;
        perfLog.noteDecision({
          source: 'manual',
          emotion: '',
          intensity: null,
          played: true,
          perfKind: 'program',
          decision: {
            clipId: evt.programId,
            label: evt.title || evt.programId,
            reason: 'program',
            detail: { durationMs: evt.plannedMs },
          },
        });
        return;
      }
      if (evt.scope === 'program' && evt.phase === 'end') {
        const k = String(evt.endedBy || 'natural');
        programBudget.byEndedBy[k] = (Number(programBudget.byEndedBy[k]) || 0) + 1;
      }
      perfLog.noteProgram(evt);
    } catch (e) { /* 遥测失败绝不影响演出 */ }
  }

  /** 懒建运行器（program 依赖 scheduler；scheduler 关着 → null） */
  function ensureProgramRunner() {
    if (!schedulerEnabled()) return null;
    if (programRunner) return programRunner;
    const sched = ensureScheduler();
    if (!sched) return null;
    loadProgramsDoc();
    loadPerfSyncDoc();
    const nowFn = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
      programRunner = createProgramRunner({
        now: nowFn,
        scheduler: sched,
        programs: programsInfo.list,
        playSegment: programPlaySegment,
        fadeOut: programFadeOut,
        speak: programSpeak,
        sfx: programSfx,
        log: (line) => { try { console.info('[petbody:program] ' + line); } catch (e) { /* ignore */ } },
        telemetry: onProgramTelemetry,
        budget: programBudgetApi,
        syncFor: (seg) => selectPerfSync(perfSyncDoc, seg),
        relaxMsFor: (seg) => {
          const s = perfSyncDoc ? selectPerfSync(perfSyncDoc, seg) : null;
          return s && Array.isArray(s.relaxPreempt) ? s.relaxPreempt : null;
        },
        segmentDurationMs: (seg) => {
          const m = performanceMeta(seg);
          return m && Number(m.duration) > 0 ? Number(m.duration) * 1000 : 0;
        },
      });
    } catch (e) {
      console.warn('[petbody] 节目单运行器创建失败', e);
      programRunner = null;
    }
    return programRunner;
  }

  /** performanceDebug().program 的快照（只读内存，不做 I/O） */
  function programDebugSnapshot() {
    const cfg = programCfg();
    let st = null;
    try { st = programRunner ? programRunner.status() : null; } catch (e) { st = null; }
    return {
      enabled: cfg.enabled === true,
      scheduler: schedulerEnabled(),
      active: Boolean(st && st.active),
      programId: (st && st.programId) || '',
      title: (st && st.title) || '',
      beatIdx: st ? st.beatIdx : -1,
      beatKey: (st && st.beatKey) || '',
      beatCount: st ? Number(st.beatCount) || 0 : 0,
      pending: Boolean(st && st.pending),
      elapsedMs: st ? st.elapsedMs : 0,
      stopAtNextRelax: Boolean(st && st.stopAtNextRelax),
      lastEndedBy: (st && st.lastEndedBy) || '',
      lastProgramId: (st && st.lastProgramId) || '',
      budgetLeft: programBudgetApi.left(),
      budgetUsed: programBudget.used,
      maxPerDay: programMaxPerDay(),
      plays: programBudget.plays,
      byEndedBy: Object.assign({}, programBudget.byEndedBy),
      loaded: programsInfo.loadedAt ? programsInfo.list.length : 0,
      dataError: programsInfo.loadedAt ? programsInfo.error : 'not-loaded',
    };
  }

  /**
   * 启动一段 v2 长表演（自动或手动），**所有入口共用**：
   *   1) 自动层先看 claim 是否空闲；占用则让位 + yield 计数，**不消耗 perfAuto 的冷却**；
   *   2) 手动层 preempt=true，可顶掉 clip/v2，并停掉被顶掉的那一层；
   *   3) 只有 claim 拿到才 performer.start，二者不会出现「占了脸但没演」的中间态。
   *
   * @returns {{ok:boolean, reason?:string, owner?:string, key?:string, token?:string, durationMs?:number, heldBy?:string}}
   */
  function requestPerformance(key, now, opts = {}) {
    const owner = opts.owner || 'v2';
    const preempt = opts.preempt === true;
    const meta = performanceMeta(key);
    // 先验名字再抢占用：写错 key 时不能先把正在演的片段/长表演停掉再失败。
    if (!meta) return { ok: false, reason: 'unknown-performance' };
    const durationMs = Number(meta.duration) > 0 ? Number(meta.duration) * 1000 : 0;

    // ── 调度器路径（enabled=true）──────────────────────────────────────────
    // 规则：manual/v2 都声明 segmented（按 perf-sync 的 relax 点可打断），manual 带 preempt。
    // 返回 pending/preempting 时**先不启动**：等 scheduler 的 'start' 事件（收势结束后）。
    const sched = ensureScheduler();
    if (sched) {
      // 自动层「占用就不问」的旧门保留：60fps 的自动通道不能把队列塞满（旧行为是直接让位）。
      if (!preempt && !perfArbiter.availableFor(owner)) {
        const holder = perfClaim.snapshot();
        perfClaim.recordYield(owner, { reason: 'busy', heldBy: holder.owner, key: key });
        return { ok: false, reason: 'busy', heldBy: holder.owner };
      }
      const req = sched.request({
        owner,
        key: String(key),
        kind: 'segmented',
        sync: selectPerfSync(perfSyncDoc, key),
        maxMs: durationMs,
        preempt,
      });
      if (!req.ok) {
        return { ok: false, reason: req.reason || 'busy', heldBy: (perfClaim.snapshot() || {}).owner || '' };
      }
      // 决策日志推迟到**真正开演**时写（P2b 账目）：
      // perfLog 的 lastPlay 是单槽 —— 如果在 request 时就写 manual 的 play，被顶掉的
      // v2 在 150/400ms 后的 perf.end 会因为「lastPlay 已经不是它」而丢掉一条结束账。
      const logInfo = { meta, durationMs, logReason: opts.logReason };
      if (req.status === 'started') {
        const started = beginV2Playback(key, owner, opts.performer, logInfo);
        if (!started) return { ok: false, reason: 'unknown-performance' };
        return { ok: true, owner, key: String(key), token: req.token, durationMs, scheduler: 'started' };
      }
      if (schedPending.size >= SCHED_PENDING_LIMIT) {
        try { endClaim(owner, req.token, 'cancelled'); } catch (e) { /* ignore */ }
        return { ok: false, reason: 'queue-full' };
      }
      schedPending.set(req.token, {
        kind: 'v2',
        owner,
        key: String(key),
        apply: () => beginV2Playback(key, owner, opts.performer, logInfo),
      });
      return {
        ok: true, owner, key: String(key), token: req.token, durationMs,
        pending: true, status: req.status, relaxAt: req.relaxAt || 0,
      };
    }

    // ── 旧路径（scheduler 关）：逐位不变 ──────────────────────────────────
    if (!preempt && !perfArbiter.availableFor(owner)) {
      const holder = perfClaim.snapshot();
      perfClaim.recordYield(owner, { reason: 'busy', heldBy: holder.owner, key: key });
      return { ok: false, reason: 'busy', heldBy: holder.owner };
    }
    const admitted = perfArbiter.begin(owner, {
      key: String(key),
      title: (meta && meta.title) || String(key),
      durationMs,
      preempt,
    });
    if (!admitted.ok) return { ok: false, reason: admitted.reason || 'busy', heldBy: admitted.holder || '' };
    // 手动优先：被顶掉的层必须真的停下来，否则它还会继续写脸。
    if (admitted.preempted === 'clip') {
      try { if (emotion.facsClips && emotion.facsClips.stop) emotion.facsClips.stop(); } catch (e) { /* ignore */ }
    } else if (admitted.preempted === 'scenes') {
      // 场景是一串 setTimeout；只停 claim 不够，定时器还会继续发情绪/动作。
      try {
        if (api && Array.isArray(api._sceneTimers)) {
          for (const id of api._sceneTimers) clearTimeout(id);
          api._sceneTimers = [];
        }
      } catch (e) { /* api 还没初始化（理论上到不了） */ }
    } else if (admitted.preempted && admitted.preempted !== 'micro') {
      // P0.2：被顶掉的长演出一律记 interrupt（v2 没有收势，硬切也是打断）
      try { if (performer.key) perfLog.noteEnd({ endedBy: 'interrupt', clipId: performer.key }); } catch (e) { /* ignore */ }
      try { performer.stop(); } catch (e) { /* ignore */ }
    }
    const started = performer.start(String(key), now, opts.performer || {});
    if (!started) {
      perfArbiter.end(owner, admitted.token);
      return { ok: false, reason: 'unknown-performance' };
    }
    // 2026-11-22 P2：v2 长表演以前**不进 performance-log**，D6 导演改戏只有 FACS 片段数据。
    // 所有入口（手动/自动）都汇到这一处，所以记一条 play 就够。
    // clipId 用**原始 key**（不加前缀）：choreo-auto 查 tuning 时按这个 key 查，
    // 加前缀会让「按段倍率」永远查不到。source 区分 manual/auto，便于 D6 分维度算接受率。
    try {
      perfLog.noteDecision({
        source: owner === 'manual' ? 'manual' : 'auto',
        emotion: '',
        intensity: null,
        played: true,
        perfKind: 'v2',
        decision: {
          clipId: String(key),
          label: (meta && meta.title) || String(key),
          reason: opts.logReason || 'v2-long',
          detail: { durationMs },
        },
      });
    } catch (e) { /* 日志失败绝不影响表演 */ }
    return { ok: true, owner, key: String(key), token: admitted.token, durationMs };
  }

  /** 表演自然结束/被停止时释放占用（只释放自己持有的那一层） */
  function releasePerformance(owner) {
    try {
      const holder = perfClaim.snapshot();
      if (holder.owner === owner) endClaim(owner, holder.token, 'interrupt');
    } catch (e) { /* ignore */ }
  }

  // ── 导演接线（2026-11-25 P0）─────────────────────────────────────────────
  // 只做两件事：① 每次「本来要演」前问一次；② 把决定写进 perf.request。
  // dry-run 时 gate() 永远 proceed=true —— **不改变 consider 行为**，也就不白吃冷却
  // （现有注释见 T1 的 claim 判断：占用时不跑 consider，否则冷却被白吃）。
  function perfConfigFromScope() {
    try {
      if (typeof window !== 'undefined' && window.__petPerformanceConfig) return window.__petPerformanceConfig;
      if (typeof globalThis !== 'undefined' && globalThis.__petPerformanceConfig) return globalThis.__petPerformanceConfig;
    } catch (e) { /* 读不到就用默认 */ }
    return null;
  }

  /** 宿主/测试可下发 performance.* 配置（驱动 config.json → 渲染层的唯一入口） */
  function applyPerfConfig(raw) {
    perfDirector.cfg = resolvePerformanceConfig(raw === undefined ? perfConfigFromScope() : raw);
    // 待机层跟着配置走（热改 scale/enabled 立刻生效，不需要重载）
    try {
      const a = perfDirector.cfg.ambient || PERFORMANCE_DEFAULTS.ambient;
      ambient.setEnabled(a.enabled !== false);
      ambient.setScale(a.scale);
    } catch (e) { /* ambient 异常不影响表演 */ }
    // 调度器热滚动（P2b）：开 → 立刻建（要赶在第一次 request 前把 sync 读进来）；
    // 关 → reset + 交还 claim + 清待启动表，否则会留下「画面停了 claim 还在」的幽灵占用。
    try {
      if (schedulerEnabled()) {
        ensureScheduler();
      } else if (perfSched) {
        // P0-3（对抗审计）：先停节目单（finishClaim + 退额度），再 reset；
        // 否则 reset 清掉 claim 表后 runner 的 finish 找不到，arbiter 仍持 program 到 ttl。
        try { if (programRunner) programRunner.stop('disabled'); } catch (e) { /* ignore */ }
        try { perfSched.reset(); } catch (e) { /* ignore */ }
        schedPending.clear();
        try {
          perfArbiter.end('program');
          perfArbiter.end('clip');
          perfArbiter.end('v2');
          perfArbiter.end('manual');
          perfArbiter.end('scenes');
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* 配置异常不影响旧路径 */ }
    // 节目单跟着开关走（P3a）：关掉 program 或关掉 scheduler → 立刻收势，
    // 否则会出现「演到一半没人管」的幽灵 loop（它还持有 performer 的写入）。
    try {
      const pcfg = perfDirector.cfg.program || PERFORMANCE_DEFAULTS.program;
      if (programRunner && (pcfg.enabled !== true || !schedulerEnabled())) programRunner.stop('disabled');
    } catch (e) { /* ignore */ }
    return perfDirector.cfg;
  }
  // 初始化即按 window 下发的配置对齐（缺省走默认）；ambient 也一起同步 scale/enabled
  applyPerfConfig(perfConfigFromScope());

  function directorPresence() {
    try { return readPresence(globalThis, Date.now()); } catch (e) { return null; }
  }

  function directorSession() {
    const now = Date.now();
    const sum = perfLog.summary(now);
    return {
      startedAt: perfSession.startedAt,
      ageMs: Math.max(0, now - perfSession.startedAt),
      turns: perfSession.turns,
      userActionAt: perfSession.userActionAt,
      // 被接率只统计 afterEnd（演完 90s 内被吸引）；打断率单独看，不混算。
      // 全部来自 perfLog 的内存 ring（最近 10 次），不读文件。
      replyRate: sum.replyRateAfterEnd != null ? sum.replyRateAfterEnd : sum.replyRate,
      replySamples: sum.replySamplesAfterEnd != null && sum.replySamplesAfterEnd > 0 ? sum.replySamplesAfterEnd : sum.replySamples,
      interruptRate: sum.interruptRate,
    };
  }

  /**
   * 问一次导演。
   * @param {'v2'|'clip'|'program'} kind
   * @param {{key?:string}} [ctx]
   * @returns {{proceed:boolean, dec:object|null, reason:string}}
   */
  function directorDecideFor(kind, ctx = {}) {
    const cfg = perfDirector.cfg || resolvePerformanceConfig(null);
    const dirCfg = cfg.director || PERFORMANCE_DEFAULTS.director;
    // 两个开关都关 = 导演不存在（旧行为，连日志都不写）
    if (dirCfg.enabled !== true && dirCfg.dry_run !== true) return { proceed: true, dec: null, reason: 'off' };
    let dec = null;
    let sum = null;
    try {
      sum = perfLog.summary(Date.now());
      dec = directorDecide({
        presence: directorPresence(),
        session: directorSession(),
        now: Date.now(),
        lastPerfAt: perfLog.lastPlay ? perfLog.lastPlay.at : 0,
        // 日预算/长段预算只统计自动来源（手点不吃额度）；见 director.budgetsFromSummary
        budgets: budgetsFromSummary(sum),
        config: { director: dirCfg, program: cfg.program },
      });
    } catch (e) { return { proceed: true, dec: null, reason: 'director-error' }; }
    const g = directorGate(dec, kind === 'program' ? 'program' : kind);
    // 审计口径：allowed = 「按决策本应允许」；dry-run 下 gate 仍 proceed（不拦）
    const allowed = dec.allow === true && Array.isArray(dec.allowedKinds) && dec.allowedKinds.includes(kind);
    perfDirector.lastDecision = {
      at: Date.now(), kind, mode: dec.mode, allow: dec.allow === true,
      allowed, allowedKinds: (dec.allowedKinds || []).slice(),
      reason: dec.reason, intensity: dec.intensity, maxMs: dec.maxMs,
      presence: dec.presence, budgetLeft: dec.budgetLeft, proceed: g.proceed,
    };
    perfDirector.lastAt = Date.now();
    // 导演 intensity 变化 → 待机层（幅度上限与状态偏好都跟着走）
    try { ambient.setIntensity(dec.intensity); } catch (e) { /* ignore */ }
    // 2 秒窗口内同 kind:key 只写一条日志（决策照算，不白吃冷却）
    const logKey = String(kind) + ':' + String(ctx.key || '');
    const logNow = Date.now();
    const lastLog = Number(perfRequestLogAt.get(logKey) || 0);
    if (logNow - lastLog >= PERF_REQUEST_LOG_GAP_MS) {
      perfRequestLogAt.set(logKey, logNow);
      try {
        perfLog.noteRequest({
          owner: kind === 'v2' ? 'v2' : (kind === 'clip' ? 'clip' : 'program'),
          key: ctx.key || null,
          perfKind: kind,
          presence: dec.presence,
          intensity: dec.intensity,
          maxMs: dec.maxMs,
          allowed,
          reason: dec.reason,
          mode: dec.mode,
          budgetLeft: dec.budgetLeft,
        });
      } catch (e) { /* 日志失败绝不影响表演 */ }
    }
    // 被导演拦下时：**不调用 consider、不碰 claim**（不白吃冷却/占用），
    // 只在日志写一条 perf.skip.reason=director:<reason>（10 秒窗口去重，防止刷屏）。
    if (!g.proceed) {
      const skipKey = 'skip:' + logKey;
      if (logNow - Number(perfSkipLogAt.get(skipKey) || 0) >= PERF_SKIP_LOG_GAP_MS) {
        perfSkipLogAt.set(skipKey, logNow);
        try {
          perfLog.noteDecision({
            source: 'auto',
            emotion: '',
            intensity: dec.intensity,
            played: false,
            perfKind: kind,
            activity: dec.presence,
            decision: { reason: 'director:' + (g.reason || 'blocked') },
          });
        } catch (e) { /* 日志失败绝不影响表演 */ }
      }
    }
    try { if (typeof window !== 'undefined') window.__perfDirectorState = perfDirector.lastDecision; } catch (e) { /* ignore */ }
    return { proceed: g.proceed, dec, reason: g.proceed ? 'ok' : g.reason };
  }

  // ── C-1b：情绪写盘 / 读回 ────────────────────────────────────────────
  let _persistTimer = null;
  let _emotionRev = 0;
  function scheduleEmotionPersist(label, strength) {
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(() => {
      _emotionRev += 1;
      const now = Date.now();
      const payload = {
        state: {
          user: { label: 'neutral', intensity: 0, confidence: 0, provenance: null, revision: 0, updatedAt: now, sources: [] },
          companion: {
            label: String(label || 'neutral'),
            intensity: Math.max(0, Math.min(1, Number(strength) || 0)),
            confidence: 0.8,
            provenance: 'text_recent_context',
            revision: _emotionRev,
            updatedAt: now,
            sources: [{ provenance: 'text_recent_context', label, intensity: Math.max(0, Math.min(1, Number(strength) || 0)), at: now }],
          },
        },
      };
      try {
        fetch(EMOTION_STATE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => { /* 8103 没起就算了，下次变化再写 */ });
      } catch (e) { /* fetch 不可用（非浏览器环境）时忽略 */ }
    }, 2500);
  }

  async function restoreEmotion() {
    try {
      const r = await fetch(EMOTION_STATE_URL, { cache: 'no-store' });
      const j = await r.json();
      const st = (j && j.state && j.state.state) || (j && j.state);
      const c = st && st.companion;
      if (!c || !c.label || !(c.intensity > 0.05)) return null;
      const dt = (Date.now() - (Number(c.updatedAt) || Date.now())) / 1000;
      const decayed = c.intensity * Math.pow(0.5, Math.max(0, dt) / EMOTION_HALF_LIFE_SEC);
      if (decayed <= 0.05) return null;
      _emotionRev = Number(c.revision) || 0;
      state.emotion = String(c.label);
      state.emotionKey = normalizeEmotionName(c.label) || state.emotionKey;
      state.emotionStrength = decayed;
      // 注意：这是**启动时恢复的旧情绪**，不是「这句话的情绪」——不能标 emotionAt，
      // 否则重启后 15 秒内一开口就会拿持久化的 bored/sleepy 演一段（2026-11-16 真机抓到）。
      if (state.emotionKey && emotion.engine) {
        emotion.engine.feed({ kind: 'emotion', emotion: state.emotionKey, strength: decayed, now: performance.now() });
      }
      // 回写「已恢复」标记：让 /emotion-state 能证明这次是 boot 恢复，而不是旧文件
      try {
        fetch(EMOTION_STATE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            state: { user: { label: 'neutral', intensity: 0, confidence: 0, provenance: null, revision: 0, updatedAt: Date.now(), sources: [] },
                     companion: { label: c.label, intensity: decayed, confidence: Number(c.confidence) || 0.8, provenance: c.provenance || 'text_recent_context', revision: Number(c.revision) || 0, updatedAt: Date.now(), sources: Array.isArray(c.sources) ? c.sources : [] } },
            restored: { label: c.label, intensity: decayed, at: Date.now() },
          }),
        }).catch(() => {});
      } catch (e) { /* ignore */ }
      return { label: c.label, intensity: decayed };
    } catch (e) { return null; }
  }

  let running = false;
  let last = 0;
  let ui = null;

  // ── 情绪层 ──────────────────────────────────────────────────────────────
  // 这套皮套的 23 个 exp3 全是换装配件（体型/眼镜/钢盆/圈圈眼…），没有 happy/sad 这类情绪表情。
  // 所以情绪只能靠【参数合成】：笑眼 + 嘴角 + 眉毛 + 瞳孔，几路小幅叠加就能读出情绪。
  // 参数所有权：只碰下面 OWNED 这些，口型/呼吸/头部角度/眼神全部让给别人。
  const OWNED_PARAMS = ['Emotion', 'Emotion2', 'EyeSmile', 'PupilX', 'PupilY', 'BrowInnerUp',
    'ParamMouthForm', 'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLAngle', 'ParamBrowRAngle',
    'ParamBrowLY2', 'ParamBrowRY2', 'ParamEyeLOpen', 'ParamEyeROpen'];

  // 这些参数的「无表情基线」是语义确定的，不能从 renderer.defaults 里读 ——
  // 因为 defaults 会被我们每帧写入，读到的可能是上一帧的表情残留
  // （实测踩过：EyeSmile 基线被读成 0.909，导致「没情绪时眼睛也在笑」）。
  const BASE_POSE = {
    Emotion: 0, Emotion2: 0, EyeSmile: 0, PupilX: 0, PupilY: 0, BrowInnerUp: 0,
    ParamMouthForm: 0, ParamBrowLY: 0, ParamBrowRY: 0,
    ParamBrowLAngle: 0, ParamBrowRAngle: 0, ParamBrowLY2: 0, ParamBrowRY2: 0,
    ParamEyeLOpen: 1, ParamEyeROpen: 1,   // 眼睛默认是睁开的
  };
  const emotion = {
    engine: null,
    // perf：VAD+FACS 的表情表演引擎（见 desktop/perf/）。'legacy' = 退回老的参数表驱动。
    // 出任何异常都会自动降级，不会让皮套整张脸不动。
    perf: null,
    perfMode: options.perfMode === 'legacy' ? 'legacy' : 'perf',
    base: new Map(),      // 参数默认值
    range: new Map(),     // 参数 [min,max]
    smooth: new Map(),    // 一阶低通后的当前值
    bubbleEl: null,
    bubbleTimer: null,
    lastSubtitle: '',
    fedSubtitle: '',
    subtitleTimer: null,
    clicks: [],
    driftPhase: 0,
    lastMouthAt: 0,
    // 眼神跟随：状态在 ui/gaze.mjs 的 GazeFollow 实例里（头部跟随/宽限/回中都在那）
    gaze: null,
    hoverTimer: null,
    dragging: false, dragMoved: false, downX: 0, downY: 0, downAt: 0,
  };

  // 把引擎算出的「目标参数值」平滑逼近后写进 renderer.defaults：
  // updateView 每帧先用 defaults 重置，写 defaults 才是每帧基线。
  // 每个参数有自己的低通时间常数：眉毛/瞳孔跟得快，嘴角跟得慢，
  // 这样多层情绪叠加时不会「整张脸一起跳」。
  const TAU_BY_PARAM = {
    EyeSmile: 0.34, ParamMouthForm: 0.38,
    ParamBrowRY: 0.16, ParamBrowLY: 0.16,
    ParamBrowRAngle: 0.20, ParamBrowLAngle: 0.20,
    ParamBrowRY2: 0.18, ParamBrowLY2: 0.18,
    BrowInnerUp: 0.30, PupilX: 0.18, PupilY: 0.18,
    ParamEyeLOpen: 0.14, ParamEyeROpen: 0.14,
    Emotion: 0.30, Emotion2: 0.30,
  };

  function applyEmotionTargets(out, dt) {
    // 表情强度增益（控制面板「大肥鱼」页可调）：0 = 面瘫，1 = 正常，1.5 = 夸张
    // PAD 底色（论文 Top2 表情半边）：唤醒度缩放增益与跟随速度，(P, 心气) 做基线偏置——
    // 与 TTS 韵律消费同一组 (emotion, mood)，表情与声音才由同一个 driving affect 派生。
    const aff = expressionAffect(state.emotionKey || 'neutral', Number.isFinite(state.emotionStrength) ? state.emotionStrength : 1, Number(state.affectMood) || 0);
    const gain = (Number.isFinite(options.emotionGain) ? options.emotionGain : 1) * aff.gainMul;
    const w = (out && Number.isFinite(out.weight) ? out.weight : 0) * Math.max(0, gain);
    const targets = (out && out.targets) || {};
    const idxMap = renderer.parameterIndices;
    if (!idxMap) return;
    const d = Math.max(0.001, dt);
    for (const [name, def] of emotion.base) {
      const target = Number.isFinite(targets[name]) ? targets[name] : def;
      const [min, max] = emotion.range.get(name) || [-1, 1];
      let want = blendParam(def, target, w, min, max);
      const bias = aff.bias[name];
      if (bias) want = Math.max(min, Math.min(max, want + bias));
      const cur = emotion.smooth.has(name) ? emotion.smooth.get(name) : def;
      const tau = (TAU_BY_PARAM[name] || 0.2) * aff.tauMul;
      const next = cur + (want - cur) * (1 - Math.exp(-d / tau));
      emotion.smooth.set(name, next);
      const idx = idxMap.get(name);
      if (idx === undefined) continue;
      // 在目标值附近叠一层极小的呼吸抖动，避免参数像被钉死一样完全静止
      // （真人脸上即使「保持一个表情」，也是微微在动的）
      const drift = (emotion.driftPhase = (emotion.driftPhase || 0) + d) > 0
        ? Math.sin(emotion.driftPhase * 1.7 + (name.length * 1.31)) * 0.012 * Math.min(1, Math.abs(next) + 0.25)
        : 0;
      renderer.defaults[idx] = next + drift;
    }
  }

  // ── 眼神跟随 ──────────────────────────────────────────────────────────
  // 皮套有标准眼球参数 ParamEyeBallX / ParamEyeBallY。
  // 写进 renderer.defaults 才不会被 updateView 每帧重置掉（和情绪参数同一套路）。
  // 超过 6 秒没收到新位置就慢慢回正，避免她一直斜眼看人。
  function initEmotionLayer() {
    if (emotion.engine) return emotion.engine;
    const model = renderer._model;
    const idxMap = renderer.parameterIndices || new Map();
    const ownedSet = new Set(OWNED_PARAMS);
    // 告诉渲染器这些参数归情绪层，内置兜底值要让位
    // （否则 cubism-renderer 每帧把 ParamMouthForm 硬写成 0，笑/撇嘴全被抹平）
    renderer.emotionOwnsParam = (name) => ownedSet.has(name);

    const ids = model && model._parameterIds ? Array.from(model._parameterIds).map((o) => (o && (o._id || o.id)) || String(o)) : [];
    const mins = model && model._parameterMinimumValues ? Array.from(model._parameterMinimumValues) : [];
    const maxs = model && model._parameterMaximumValues ? Array.from(model._parameterMaximumValues) : [];

    for (const name of OWNED_PARAMS) {
      const idx = idxMap.get(name);
      if (idx === undefined) continue;
      const def = Number.isFinite(BASE_POSE[name]) ? BASE_POSE[name] : 0;
      const k = ids.indexOf(name);
      let min = -1, max = 1;
      if (k >= 0 && Number.isFinite(mins[k]) && Number.isFinite(maxs[k])) { min = mins[k]; max = maxs[k]; }
      emotion.base.set(name, def);
      emotion.range.set(name, [Math.min(min, max), Math.max(min, max)]);
      emotion.smooth.set(name, def);
    }

    emotion.engine = createEmotionEngine({
      now: () => performance.now(),
      onAction: (tag) => { try { renderer.playAction && renderer.playAction(String(tag)); } catch (e) {} },
      onBubble: (text) => showBubble(text),
      onWorkState: (w) => { try { renderer.setWorkState && renderer.setWorkState(String(w)); } catch (e) {} },
      log: (line) => { try { console.info('[petbody:emotion] ' + line); } catch (e) {} },
    });

    try { initPerfLayer(); } catch (perfError) {
      emotion.perf = null;
      emotion.perfMode = 'legacy';
      console.error('[petbody] perf 表情层初始化失败，退回 legacy', perfError);
    }
    bindEmotionInteraction();
    watchEmotionSubtitle();
    if (typeof window !== 'undefined') {
      window.petBodyEmotion = {
        engine: emotion.engine,
        feed: (text, kind) => emotion.engine.feed({ text, kind: kind || 'llm' }),
        snapshot: () => emotion.engine.snapshot(),
      };
    }
    return emotion.engine;
  }

  // ── perf 表情表演引擎：VAD 连续情绪 → FACS 语义层 → 模型画像 → 参数 ──────
  // 和老引擎的分工：老引擎决定「演什么情绪」（词表/事件/冷却/演出编排），
  // 这一层决定「脸怎么动」（连续性、余韵、多通道、单边眉、缺参数降级）。
  // 初始化失败/运行时抛错都退回 legacy 的表驱动路径，绝不把渲染拖死。
  function initPerfLayer() {
    const model = renderer._model;
    if (!model) return null;
    const idList = model._parameterIds
      ? Array.from(model._parameterIds).map((o) => (o && (o._id || o.id)) || String(o))
      : [];
    const mins = model._parameterMinimumValues ? Array.from(model._parameterMinimumValues) : [];
    const maxs = model._parameterMaximumValues ? Array.from(model._parameterMaximumValues) : [];
    const ranges = new Map();
    idList.forEach((id, i) => {
      if (Number.isFinite(mins[i]) && Number.isFinite(maxs[i])) {
        ranges.set(id, [Math.min(mins[i], maxs[i]), Math.max(mins[i], maxs[i])]);
      }
    });
    const expressionIds = renderer.expressions && renderer.expressions.keys
      ? Array.from(renderer.expressions.keys())
      : [];
    const profile = buildProfile(PROFILE_SPECS.jellyfish, {
      paramIds: new Set(idList), expressions: new Set(expressionIds), ranges,
    });
    // P0-1 参数权威表校验（2026-11-12）：拿 jingyu 的 core-inventory（同一份模型）当标准，
    // 比对运行时读到的 min/max。不一致说明模型被换过/导出参数变了 —— 必须喊出来，
    // 否则表情会「按老范围硬写」，表现为幅度不对但没人知道为什么。
    let inventoryCheck = null;
    try {
      inventoryCheck = validateRanges(ranges, (id) => ranges.has(id));
      if (inventoryCheck.mismatched.length) {
        console.warn('[petbody] 参数范围与权威表不一致：', JSON.stringify(inventoryCheck.mismatched.slice(0, 5)));
      }
    } catch (e) {
      inventoryCheck = { error: String(e && e.message || e) };
    }
    state.inventoryCheck = inventoryCheck;
    // 基线语义固定（不能读 defaults：那里可能还留着上一帧的表情残留）
    const baseline = {};
    for (const id of profile.usedParams) {
      baseline[id] = Number.isFinite(BASE_POSE[id]) ? BASE_POSE[id] : (ranges.get(id) ? ranges.get(id)[0] : 0);
    }
    baseline.ParamEyeLOpen = 1;
    baseline.ParamEyeROpen = 1;

    // P2（2026-11-21）：情绪增益必须从创建时就进 perf 的 tuning —— 旧代码只把它
    // 放在 options.emotionGain，perf 路径永远拿默认 1（面板滑块是空转的）。
    emotion.perf = createPerfEngine({
      profile, baseline, seed: 20261112,
      emotionGain: Number.isFinite(Number(options.emotionGain)) ? Number(options.emotionGain) : 1,
    });
    // 告诉渲染器这些参数归表情层：内置兜底（比如 ParamMouthForm 每帧写 0）要让位。
    const owned = new Set([...profile.usedParams, ...OWNED_PARAMS]);
    renderer.emotionOwnsParam = (name) => owned.has(name);
    if (typeof window !== 'undefined') {
      const clipApi = createFacsClipApi(emotion.perf);
      emotion.facsClips = clipApi;
      // 边沿触发的状态（默认开；setEnabled(false) 可关）
      emotion.facsTrigger = emotion.facsTrigger || { enabled: true, prevWeight: 0, peak: null };
      window.petBodyPerf = {
        engine: emotion.perf,
        snapshot: () => emotion.perf.snapshot(),
        report: () => emotion.perf.report(),
        // 面部片段（LumenAct 转出来的 FACS 片段，2026-11-17 六十二轮续）
        // 用法：window.petBodyPerf.clips.play('lumen-91') / play('害羞') / stop() / status()
        //       clips.auto({emotion,intensity}) 让导演决定；clips.setEnabled(false) 关自动触发
        clips: clipApi,
      };
    }
    return emotion.perf;
  }

  /**
   * FACS 片段播放 API（只在宿主页里有 node 能力时可用；纯浏览器环境会如实返回不可用）。
   *
   * 为什么放在 entry 而不是 perf/ 里：读文件需要 fs，而 perf/ 要能被打进浏览器包
   * （纯模块）。所以 I/O 留在 entry，采样用 perf/facs-clip-player.mjs 的纯函数。
   *
   * 每 50ms 把当前片段的 FACS 值写成 reaction 层；片段自己带 240ms 淡入淡出，
   * 播完自动清空（engine.setReaction(null)），不会把脸卡在最后的表情上。
   */
    function createFacsClipApi(engine) {
    const state = { playing: false, clipId: null, startedAt: 0, timer: null, index: null, dir: null, cache: new Map(), lastError: '', claimToken: '' };
    let director = null;

    /** 导演懒加载：索引读到了才建（决定「演不演/演哪段」） */
    function ensureDirector() {
      if (director) return director;
      const idx = loadIndex();
      if (!idx) return null;
      director = createClipDirector(idx, { tuningProvider: choreoTuning });
      return director;
    }
    const status = () => ({
      available: Boolean(loadIndex()),   // 懒加载：status 也要能把索引读起来，否则永远显示不可用
      playing: state.playing,
      clipId: state.clipId,
      label: state.clipId && state.cache.get(state.clipId) ? state.cache.get(state.clipId).label : null,
      elapsedMs: state.playing ? Math.round(Date.now() - state.startedAt) : 0,
      durationMs: state.clipId && state.cache.get(state.clipId) ? state.cache.get(state.clipId).durationMs : 0,
      clipCount: state.index ? state.index.clipCount : 0,
      error: state.lastError || null,
      lastDecision: state.lastDecision || null,
    });

    function findDataDir() {
      try {
        /* eslint-disable global-require */
        const fs = require('fs');
        const path = require('path');
        const starts = [];
        try { starts.push(__dirname); } catch (e) { /* 打包后可能没有 */ }
        if (typeof process !== 'undefined' && process.cwd) starts.push(process.cwd());
        for (const start of starts) {
          let dir = path.resolve(start);
          for (let i = 0; i < 8; i += 1) {
            const cand = path.join(dir, 'pet-runtime', 'data', 'facs-clips');
            if (fs.existsSync(path.join(cand, 'index.json'))) return cand;
            const up = path.dirname(dir);
            if (up === dir) break;
            dir = up;
          }
        }
      } catch (e) { state.lastError = 'no-fs: ' + String(e && e.message || e); }
      return null;
    }

    function loadIndex() {
      if (state.index) return state.index;
      const dir = findDataDir();
      if (!dir) { state.lastError = state.lastError || '找不到 facs-clips 目录'; return null; }
      try {
        const fs = require('fs');
        const path = require('path');
        state.dir = dir;
        state.index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
        return state.index;
      } catch (e) { state.lastError = '读 index 失败: ' + String(e && e.message || e); return null; }
    }

    function loadClip(idOrLabel) {
      const index = loadIndex();
      if (!index) return null;
      const fs = require('fs');
      const path = require('path');
      let id = idOrLabel;
      if (!state.cache.has(id)) {
        // 允许传 label（挑 energy 最强的那段）
        const hit = (index.clips || []).filter((c) => c.id === idOrLabel || c.label === idOrLabel)
          .sort((a, b) => (b.energy || 0) - (a.energy || 0))[0];
        if (!hit) { state.lastError = '找不到片段: ' + idOrLabel; return null; }
        id = hit.id;
        state.cache.set(id, JSON.parse(fs.readFileSync(path.join(state.dir, 'clips', id + '.json'), 'utf8')));
      }
      return state.cache.get(id);
    }

    function stop(reason, options) {
      const opts = options && typeof options === 'object' ? options : {};
      const wasPlaying = state.playing === true;
      const clipId = state.clipId;
      const startedAt = state.startedAt;
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      state.playing = false;
      state.clipId = null;
      // P0.2：片段结束分账 —— 自然播完 vs 被顶掉/被停。只有「这段确实是日志里的 lastPlay」
      // 才记（noteEnd 按 clipId 匹配），否则会误结 v2 的账。
      if (wasPlaying) {
        try {
          perfLog.noteEnd({
            endedBy: reason === 'natural' ? 'natural' : 'interrupt',
            clipId,
            actualMs: startedAt ? Math.max(0, Date.now() - startedAt) : undefined,
          });
        } catch (e) { /* 日志失败不影响播放 */ }
      }
      // P1（2026-11-21）：片段停下就交还表演占用，否则 v2/自动层会被一个
      // 已经结束的片段永久挡住。P2b：调度器接管时走 finish（顺带拉起队列下一条）。
      try {
        const endedBy = reason === 'natural' ? 'natural' : 'interrupt';
        if (state.claimToken) { endClaim('clip', state.claimToken, endedBy); state.claimToken = ''; }
        else { endClaim('clip', '', endedBy); }
      } catch (e) { /* ignore */ }
      // 显式停止/换段时，把自己还在队列里的请求一起取消（调度器收势清理时不能取消，
      // 那条「下一条」是调度器要拉的 —— 见 stopLayerFor 的 cancelPending:false）。
      if (opts.cancelPending !== false) {
        try { cancelSchedPending((o) => o === 'clip'); } catch (e) { /* ignore */ }
      }
      try { engine.setReaction(null); } catch (e) { /* 引擎不在也安全 */ }
      return status();
    }

    /** 片段真正开演（scheduler 'start' 时才调；旧路径在 play 里直接调） */
    function beginClipPlayback(clip, token, logCtx, decisionForLog) {
      // 换人时旧写者必须真的停（收势/结束路径已停过；这里兜底，绝不碰自己）
      try {
        if (performer.active) performer.stop('switch');
        clearSceneTimers();
      } catch (e) { /* ignore */ }
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      state.claimToken = token || '';
      state.clipId = clip.id;
      state.startedAt = Date.now();
      state.playing = true;
      // 决策日志在真正开演这一刻写（见 requestPerformance/auto 的账目说明）
      if (logCtx) {
        try {
          const decision = decisionForLog || {
            clipId: clip.id, label: clip.label, reason: 'ok', detail: { durationMs: clip.durationMs },
          };
          perfLog.noteDecision(Object.assign({ played: true, decision }, logCtx));
        } catch (e) { /* 日志失败不影响播放 */ }
      }
      const tick = () => {
        if (!state.playing) return;
        const t = Date.now() - state.startedAt;
        // 说话时屏蔽嘴：口型层拥有 mouthOpen/mouthSmile 等（mixer 里 speech 层「绝不碰嘴」）
        const speaking = Boolean(engine && typeof engine.snapshot === 'function' && engine.snapshot().speaking);
        const res = sampleFacsClip(clip, t, { speechActive: speaking });
        try { engine.setReaction(res.done ? null : res.facs); } catch (e) { /* 忽略 */ }
        if (res.done) stop('natural');
      };
      tick();
      state.timer = setInterval(tick, 50);
      if (state.timer.unref) state.timer.unref();
      return { ok: true, id: clip.id, label: clip.label, durationMs: clip.durationMs, logged: Boolean(logCtx) };
    }

    function play(idOrLabel, opts = {}) {
      const clip = loadClip(idOrLabel);
      if (!clip) return { ok: false, error: state.lastError || '片段不可用' };
      stop();
      // ── 调度器路径（P2b）────────────────────────────────────────────────
      // 片段一律 atomic（短、且自己已有 240ms 淡入淡出）：自动层不可能打断它，
      // 显式手动仍可（scheduler 里 priority 5 立即抢）。pending/preempting 时不启动，
      // 等 'start' 事件（收势结束）再 beginClipPlayback。
      const sched = ensureScheduler();
      if (sched) {
        try { cancelSchedPending((o) => o === 'clip'); } catch (e) { /* ignore */ }
        const req = sched.request({
          owner: 'clip',
          key: clip.id,
          kind: 'atomic',
          channels: ['face'],
          maxMs: Number(clip.durationMs) || 0,
          preempt: opts.preempt === true,
        });
        if (!req.ok) {
          const holder = perfClaim.snapshot();
          perfClaim.recordYield('clip', { reason: req.reason || 'busy', heldBy: holder.owner, key: clip.id });
          return { ok: false, error: req.reason || 'busy', reason: req.reason || 'busy', heldBy: holder.owner || '' };
        }
        if (req.status === 'started') return beginClipPlayback(clip, req.token, opts.logCtx || null, opts.decision || null);
        const logCtx = opts.logCtx || null;
        const decisionForLog = opts.decision || null;
        schedPending.set(req.token, {
          kind: 'clip', owner: 'clip', key: clip.id,
          apply: () => beginClipPlayback(clip, req.token, logCtx, decisionForLog),
        });
        return {
          ok: true, pending: true, id: clip.id, label: clip.label, durationMs: clip.durationMs,
          status: req.status, token: req.token, logged: Boolean(logCtx),
        };
      }
      // ── 旧路径（scheduler 关）：逐位不变 ────────────────────────────────
      // P1：claim 在 play 里拿（决策之后），拿不到就如实返回 busy；
      // 同一帧里 v2 稍后启动时会看到 'clip' 持有，从而让位。
      // 公开的 clips.play() 是显式手动（preempt=true，可顶掉 v2）；导演自动调用时不抢占。
      const admitted = perfArbiter.begin('clip', {
        key: clip.id, title: clip.label, durationMs: Number(clip.durationMs) || 0,
        // 元数据缺 duration 时给个兜底 TTL，避免 claim 永久不释放
        ttlMs: Number(clip.durationMs) > 0 ? undefined : 60_000,
        preempt: opts.preempt === true,
      });
      if (!admitted.ok) {
        perfClaim.recordYield('clip', { reason: 'busy', heldBy: admitted.holder, key: clip.id });
        return { ok: false, error: 'busy', reason: 'busy', heldBy: admitted.holder || '' };
      }
      if (admitted.preempted === 'v2' || admitted.preempted === 'manual') {
        // 手动点片段优先于自动长表演：被顶掉的 performer 必须真停，否则它还在写脸。
        try { if (performer.key) perfLog.noteEnd({ endedBy: 'interrupt', clipId: performer.key }); } catch (e) { /* ignore */ }
        try { performer.stop('interrupt'); } catch (e) { /* ignore */ }
      } else if (admitted.preempted === 'scenes') {
        clearSceneTimers();
      }
      state.claimToken = admitted.token;
      state.clipId = clip.id;
      state.startedAt = Date.now();
      state.playing = true;
      const tick = () => {
        if (!state.playing) return;
        const t = Date.now() - state.startedAt;
        // 说话时屏蔽嘴：口型层拥有 mouthOpen/mouthSmile 等（mixer 里 speech 层「绝不碰嘴」）
        const speaking = Boolean(engine && typeof engine.snapshot === 'function' && engine.snapshot().speaking);
        const res = sampleFacsClip(clip, t, { speechActive: speaking });
        try { engine.setReaction(res.done ? null : res.facs); } catch (e) { /* 忽略 */ }
        if (res.done) stop('natural');
      };
      tick();
      state.timer = setInterval(tick, 50);
      if (state.timer.unref) state.timer.unref();
      return { ok: true, id: clip.id, label: clip.label, durationMs: clip.durationMs };
    }

    /**
     * 让导演决定「这一拍演不演」；演就真的播，并记账（冷却/重复规避靠它）。
     * @param {{emotion?:string, intensity?:number, activity?:string, speaking?:boolean}} ctx
     */
    function auto(ctx) {
      const d = ensureDirector();
      if (!d) return { ok: false, played: false, reason: 'index-unavailable', error: state.lastError || null };
      // P1：占用门在**导演之前**判。v2 已经在演时，这里连决策都不该做 ——
      // 否则导演会消耗冷却记账，最后却因为 busy 演不出来（旧的 busy 门被绕开正是这个原因）。
      const holder = perfClaim.snapshot();
      if (holder.owner && holder.owner !== 'clip') {
        perfClaim.recordYield('clip', { reason: 'busy', heldBy: holder.owner, key: ctx && ctx.source });
        const decision = { clipId: null, label: null, reason: 'busy', detail: { heldBy: holder.owner, heldKey: holder.key } };
        state.lastDecision = { at: Date.now(), ctx: ctx || {}, decision };
        perfLog.noteDecision(Object.assign({ played: false, decision }, {
          source: (ctx && ctx.source) || 'manual',
          emotion: ctx && ctx.emotion,
          intensity: ctx && ctx.intensity,
          busy: true,
          speaking: ctx && ctx.speaking,
          activity: ctx && ctx.activity,
        }));
        return { ok: true, played: false, reason: 'busy', detail: decision.detail };
      }
      const decision = d.decide(ctx || {});
      const stamp = { at: Date.now(), ctx: ctx || {}, decision };
      state.lastDecision = stamp;
      const logCtx = {
        source: (ctx && ctx.source) || 'manual',
        emotion: ctx && ctx.emotion,
        intensity: ctx && ctx.intensity,
        perfKind: 'clip',
        busy: ctx && ctx.busy,
        speaking: ctx && ctx.speaking,
        activity: ctx && ctx.activity,
      };
      if (!decision.clipId) {
        perfLog.noteDecision(Object.assign({ played: false, decision }, logCtx));
        return { ok: true, played: false, reason: decision.reason, detail: decision.detail || null };
      }
      const r = play(decision.clipId, { logCtx, decision });
      // 调度器路径下 play 自己会在**真正开演**时写 play（pending 时立刻写会顶掉旧层的
      // lastPlay，让被顶掉的层丢一条 perf.end）；旧路径仍然由这里写，行为逐位不变。
      if (r.logged !== true) perfLog.noteDecision(Object.assign({ played: r.ok === true, decision }, logCtx));
      if (r.ok) d.notePlayed(decision.clipId, Date.now());
      return {
        ok: true, played: r.ok === true,
        reason: r.ok ? (r.pending ? 'pending' : 'ok') : (r.reason === 'busy' ? 'busy' : 'play-failed'),
        clipId: decision.clipId, label: decision.label, detail: decision.detail || null, error: r.error || null,
      };
    }

    /** 用当前引擎状态 + 用户活跃度自动组 ctx（方便外部定时调用） */
    function autoNow(extra) {
      let snap = {};
      try { snap = engine && typeof engine.snapshot === 'function' ? engine.snapshot() : {}; } catch (e) { snap = {}; }
      let activity = '';
      try {
        const ua = globalThis.__userActivity;
        if (ua && ua.state === 'away') activity = 'away';
      } catch (e) { /* 读不到就不设 */ }
      return auto(Object.assign({
        emotion: snap.emotion,
        intensity: snap.weight != null ? snap.weight : snap.intensity,
        activity,
        speaking: !!snap.speaking,
      }, extra || {}));
    }

    /**
     * 触发开关（2026-11-17 六十四轮续）。
     *
     * 语义变了：不再是「每 8s 盲问一次」（实测几乎永远 weak-emotion，因为 perf 的
     * weight 依赖老引擎包络，没事件时恒 0），而是**边沿触发**：
     *   ① 情绪峰值上升沿 → 记下峰值（不立刻演，避免和说话抢嘴）
     *   ② 说完（包络落下来）→ 用记下的峰值问一次导演
     * 开关只控制这条边沿链；`clips.auto(ctx)` 手动调用始终可用。
     */
    function setEnabled(on) {
      if (!emotion.facsTrigger) emotion.facsTrigger = { enabled: true, prevWeight: 0, peak: null };
      emotion.facsTrigger.enabled = on === true;
      if (!on) { emotion.facsTrigger.peak = null; }
      return { enabled: emotion.facsTrigger.enabled };
    }

    return {
      // 公开 play 是显式手动：默认 preempt（可顶掉长表演）；导演内部走 auto()，不抢占。
      play: (idOrLabel, opts) => play(idOrLabel, Object.assign({ preempt: true }, opts || {})),
      stop, status,
      get isPlaying() { return state.playing === true; },
      list: () => (loadIndex() ? state.index.clips.map((c) => ({ id: c.id, label: c.label, energy: c.energy })) : []),
      auto, autoNow,
      setEnabled,
      setAuto: setEnabled,          // 兼容旧名（六十三轮的写法）
      /** 空闲自练的阈值（毫秒）：默认 2.5 分钟后、最多 8 分钟一次。调小用于验收。 */
      setIdleRule(patch) {
        if (!emotion.facsTrigger) emotion.facsTrigger = { enabled: true, prevWeight: 0, peak: null };
        if (patch && Number.isFinite(Number(patch.idleMs))) emotion.facsTrigger.idleMs = Math.max(2000, Number(patch.idleMs));
        if (patch && Number.isFinite(Number(patch.gapMs))) emotion.facsTrigger.idleGapMs = Math.max(1000, Number(patch.gapMs));
        return { idleMs: emotion.facsTrigger.idleMs || 150000, gapMs: emotion.facsTrigger.idleGapMs || 480000 };
      },
      get isEnabled() { return !emotion.facsTrigger || emotion.facsTrigger.enabled !== false; },
      get isAuto() { return this.isEnabled; },
      directorStats: () => (director ? director.stats : null),
      /** P0：每个情绪的可用段数（能量两档 + 时长门 + 日上限）；performanceDebug 读它 */
      poolStats: (nowMs, maxMs) => {
        const d = ensureDirector();
        if (!d || typeof d.poolStats !== 'function') return null;
        try { return d.poolStats(nowMs, maxMs); } catch (e) { return null; }
      },
    /** 决策日志：累计统计 + 最近若干条（分析「演了之后有没有人理」） */
    logStats: () => perfLog.stats,
    recentLog: (n) => perfLog.recent(n),
      /** 边沿触发的观测（排查「为什么没演」：看 maxWeight / edges / peak） */
      triggerStats: () => (emotion.facsTrigger ? {
        enabled: emotion.facsTrigger.enabled !== false,
        maxWeight: Number(emotion.facsTrigger.maxWeight) || 0,
        maxStrength: Number(emotion.facsTrigger.maxStrength) || 0,
        edges: Number(emotion.facsTrigger.edges) || 0,
        peak: emotion.facsTrigger.peak || null,
        prevWeight: Number(emotion.facsTrigger.prevWeight) || 0,
        idleMs: Number(emotion.facsTrigger.idleMs) || 150000,
        idleGapMs: Number(emotion.facsTrigger.idleGapMs) || 480000,
        idleTries: Number(emotion.facsTrigger.idleTries) || 0,
        lastIdlePlayedAt: Number(emotion.facsTrigger.lastIdlePlayedAt) || 0,
        idleFor: emotion.facsTrigger.lastStrongAt ? Date.now() - Number(emotion.facsTrigger.lastStrongAt) : null,
      } : null),
    };
  }

  // perf 输出的参数写进 renderer.defaults（updateView 每帧从这里取基线）。
  // 只写画像里声明的参数：口型/眼球/头身/呼吸都不在这份清单里，不会被表情层抢。
  const perfOwnershipSeen = new Set();
  // P2：perf 自己上一帧写进 defaults 的值（用于识别「宿主的换装 UI 直接改了 defaults」）。
  // live-2d 的 ui-controller 有自己的 writeAssetParam，不走 asset-toggles —— 不能改它的源码，
  // 就对比 defaults 的变化来推断手动 pin。见 perf/param-ownership.mjs detectExternalPins。
  const perfWriteLedgers = new WeakMap();
  function perfLedgerFor(renderer) {
    if (!renderer || typeof renderer !== 'object') return new Map();
    let ledger = perfWriteLedgers.get(renderer);
    if (!ledger) { ledger = new Map(); perfWriteLedgers.set(renderer, ledger); }
    return ledger;
  }
  function applyPerfParams(out, dt) {
    // 物理输出参数的「物理后重放」清单：每帧先清空，只有本帧真有目标才填。
    state.perfCommit = null;
    if (!out || !out.params) return;
    const idxMap = renderer.parameterIndices;
    if (!idxMap) return;
    // 目标值附近叠一层极小的呼吸抖动，避免「保持一个表情」时参数像被钉死。
    emotion.driftPhase = (emotion.driftPhase || 0) + Math.max(0.001, dt);
    const drift = Math.sin(emotion.driftPhase * 1.7) * 0.01;
    // P2（2026-11-21）：资产层手动 pin 的参数（key2 流泪 / key7 脸红 / key13 流冷汗）
    // perf 写前必须跳过。旧实现里 perf 每帧覆盖 defaults，用户点「落泪」后下一帧
    // 就被情绪脸改回去 —— 这就是手动值被「改」的根因。
    const pinned = getPinnedAssetParams(renderer);
    // 宿主换装 UI（live-2d ui-controller）直接写 defaults，不经过 asset-toggles；
    // 这里用「perf 上一帧写的值 vs 此刻 defaults」识别手动开关，统一所有权语义。
    const ledger = perfLedgerFor(renderer);
    const externalPins = detectExternalPins({
      defaults: renderer.defaults,
      indices: idxMap,
      previous: ledger,
      pinned,
      candidates: SHARED_ASSET_PARAM_SET,
    });
    if (externalPins.detected.length) {
      emotion.externalPinDetected = (Number(emotion.externalPinDetected) || 0) + externalPins.detected.length;
      if (!emotion.externalPinSeen) emotion.externalPinSeen = new Set();
      for (const id of externalPins.detected) {
        if (emotion.externalPinSeen.has(id)) continue;
        emotion.externalPinSeen.add(id);
        console.info(`[param-ownership] 检测到手动 pin "${id}"（宿主 UI 直接写 defaults），perf 让位`);
      }
    }
    if (externalPins.released.length) {
      emotion.externalPinReleased = (Number(emotion.externalPinReleased) || 0) + externalPins.released.length;
      for (const id of externalPins.released) {
        console.info(`[param-ownership] 手动 pin "${id}" 已关闭，所有权交还 perf`);
      }
    }
    const write = writePerfParams({
      params: out.params,
      indices: idxMap,
      defaults: renderer.defaults,
      pinned,
      drift,
    });
    const accepted = write.accepted || {};
    // 记下 perf 自己写下去的值，供下一帧识别「外部手动改动」。
    for (const id of write.written) {
      const index = idxMap.get(id);
      if (index !== undefined) ledger.set(id, Number(renderer.defaults[index]));
    }
    if (write.skippedPinned && write.skippedPinned.length) {
      emotion.perfPinSkips = (Number(emotion.perfPinSkips) || 0) + write.skippedPinned.length;
      if (!emotion.perfPinSkipSeen) emotion.perfPinSkipSeen = new Set();
      for (const id of write.skippedPinned) {
        if (emotion.perfPinSkipSeen.has(id)) continue;
        emotion.perfPinSkipSeen.add(id);
        console.info(`[param-ownership] perf 跳过资产 pin 参数 "${id}"（手动开关拥有，等用户关掉再交还）`);
      }
    }
    // 声明所有权断言（P2）：本帧真正写下去的每个参数都必须在画像声明里。
    // 每帧都查是纯集合运算，成本可忽略；结果留在 state 里给 /eval 看。
    if (emotion.perf && emotion.perf.profile) {
      const audit = checkWriteSet('perf', Object.keys(accepted), { profile: emotion.perf.profile });
      emotion.ownershipAudit = audit;
      if (!audit.ok && !emotion.ownershipWarned) {
        emotion.ownershipWarned = true;
        console.warn('[param-ownership] perf 写入了画像未声明的参数：', JSON.stringify(audit.undeclared.slice(0, 8)));
      }
    }
    // browDown 的主通道 ParamBrowLAngle/RAngle 是 physics3 的 Output（每帧被物理覆盖）。
    // defaults 那份是「物理前喂」（Shock/Emotion2 要读），这里再挑出来做「物理后放」。
    const commit = selectPhysicsOutputTargets(accepted, classifyParam);
    state.perfCommit = commit.length ? Object.fromEntries(commit) : null;
    // 所有权从「数据」变「断言」（§69 B3）：画像层在 buildProfile 已按 EXTERNALLY_OWNED 跳过，
    // 但 out.params 是引擎自己算的清单，那张表管不到它。越权写 = 口型和表情/眼神打架，
    // 必须在源头喊出来（每对参数只喊一次，别刷屏）。
    // 注意查的是参数级表（EXTERNALLY_OWNED 的键是通道名，对不上参数 id）。
    // P0（2026-11-25）：ParamMouthForm 对 perf 是**共享**的（画像的嘴形通道就写它），
    // 不能拿它喊越权，否则每次启动都一条狼来了；v2 的断言不走这份豁免。
    const violations = findExternalOwnershipViolations(accepted, EXTERNALLY_OWNED_PARAMS)
      .filter((v) => !PERF_SHARED_OWNED_PARAMS.has(v.param));
    for (const v of violations) {
      if (perfOwnershipSeen.has(v.param)) continue;
      perfOwnershipSeen.add(v.param);
      console.warn(`[param-ownership] perf 层越权写了 "${v.param}"（该参数归 ${v.owner}）—— 这一层应当从画像里摘掉它`);
    }
    // 辅助表情（脸红/流泪/流冷汗）在模型里没有参数，只能借 exp3。
    // 只在「当前没有别的脸占着」时上，避免把宿主/演出显式指定的表情顶掉。
    const aux = out.expressions && out.expressions[0];
    if (aux && aux.weight >= 0.18 && !renderer.manualFace && !renderer.faceKey) {
      try { renderer.setNamedExpression(aux.name, true, 900); } catch (e) {}
    }
  }

  // 交互事件 → 情绪引擎（点击/摸头/拖动/连点/悬停）
  //
  // 事件名契约（2026-11-21 P1）：以 emotion-engine 的 EVENT_RULES 为准
  //   headpat / poke / dblclick / drag / drop / hover / spam3 …
  // 旧代码发 'pat_head' / 'tap'，引擎查不到 → handleEvent 返回 false，而调用方
  // 把返回值丢了 → 摸头/单点完全没有反应，日志也一片安静。
  // 现在：① 宿主改用规范名；② 引擎保留旧名别名；③ 任何没命中的事件都计数 + 喊一次。
  function feedEmotionEvent(name, meta) {
    let ok = false;
    const eventName = String(name || '');
    try {
      ok = emotion.engine ? emotion.engine.feed({ kind: 'event', name: eventName, meta }) === true : false;
    } catch (e) { ok = false; }
    if (!ok) {
      // 静默丢弃是上一版最难查的坑：事件到底发没发、名字对不对，全都没有痕迹。
      emotion.eventMiss = (Number(emotion.eventMiss) || 0) + 1;
      emotion.lastEventMiss = { name: eventName, at: Date.now() };
      if (!emotion.eventMissSeen) emotion.eventMissSeen = new Set();
      if (!emotion.eventMissSeen.has(eventName)) {
        emotion.eventMissSeen.add(eventName);
        console.warn(`[petbody] 未知交互事件 "${eventName}"：情绪引擎没有对应规则（已计数，本条只告警一次）`);
      }
    }
    return ok;
  }

  function bindEmotionInteraction() {
    const canvas = renderer && renderer.canvas;
    if (!canvas || canvas.__petEmotionBound) return;
    const feed = (name, meta) => {
      feedEmotionEvent(name, meta);
      // 告诉宿主「用户和我互动了」，用于重置空闲主动说话的计时器。
      try {
        if (typeof window !== 'undefined' && window.dispatchEvent) {
          window.dispatchEvent(new CustomEvent('petbody:interaction', { detail: { name } }));
        }
      } catch (e) {}
    };

    // 监听器交给 bindCanvasListeners：它记下挂了哪些函数，dispose 时能逐个解绑并清标记。
    // 旧实现是匿名 addEventListener + 只留 __petEmotionBound=true → 切 VRM/MMD 再回来，
    // 标记还在、监听器已经跟着旧 canvas 走了，交互永久失效。
    emotion.canvasBinding = bindCanvasListeners(canvas, {
      pointerdown: (event) => {
        emotion.dragging = true; emotion.dragMoved = false;
        emotion.downX = event.clientX; emotion.downY = event.clientY; emotion.downAt = performance.now();
      },
      pointermove: (event) => {
        if (!emotion.dragging) return;
        const dx = event.clientX - emotion.downX, dy = event.clientY - emotion.downY;
        if (!emotion.dragMoved && Math.abs(dx) + Math.abs(dy) > 8) {
          emotion.dragMoved = true;
          feed('drag');
        }
      },
      pointerup: () => {
        if (!emotion.dragging) return;
        emotion.dragging = false;
        if (emotion.dragMoved) { feed('drop'); return; }
        const nowMs = performance.now();
        const head = emotion.downY < canvas.clientHeight * 0.36;
        feed(head ? 'headpat' : 'poke');
        emotion.clicks = emotion.clicks.filter((t) => nowMs - t < 1500);
        emotion.clicks.push(nowMs);
        if (emotion.clicks.length >= 3) { emotion.clicks = []; feed('spam3'); }
      },
      pointerenter: () => {
        clearTimeout(emotion.hoverTimer);
        emotion.hoverTimer = setTimeout(() => feed('hover'), 1500);
      },
      pointerleave: () => { clearTimeout(emotion.hoverTimer); emotion.hoverTimer = null; },
    });
  }

  // 字幕 → 情绪词表（L1/L2 靠这个吃文本）
  function watchEmotionSubtitle() {
    const read = () => {
      const el = typeof document !== 'undefined' ? document.getElementById('subtitle-text') : null;
      return el ? String(el.textContent || '').trim() : '';
    };
    if (emotion.subtitleTimer) clearInterval(emotion.subtitleTimer);
    emotion.subtitleTimer = setInterval(() => {
      const text = read();
      if (!text || text === emotion.lastSubtitle) return;
      emotion.lastSubtitle = text;
      // 别把自己说的话当输入：她会把自己的台词再喂回情绪引擎，
      // 于是说一句丧气话就真的变丧，说一句自嘲就真的委屈 —— 自激。
      // 判断依据：嘴里正在动 / 刚动过 400ms 内，说明这条字幕是她自己的。
      const nowMs = performance.now();
      if (state.mouthSmooth > 0.02 || nowMs - (emotion.lastMouthAt || 0) < 400) {
        emotion.fedSubtitle = text;   // 记下来，避免 TTS 结束后又被当成新文本
        return;
      }
      // 字幕是逐字流式的，等它稳定 600ms 再喂，避免把半句喂进词表
      clearTimeout(emotion.subtitleFlush);
      emotion.subtitleFlush = setTimeout(() => {
        const finalText = read();
        if (!finalText || finalText === emotion.fedSubtitle) return;
        emotion.fedSubtitle = finalText;
        try { emotion.engine.feed({ text: finalText, kind: 'llm' }); } catch (e) {}
      }, 600);
    }, 400);
  }

  function showBubble(text) {
    if (typeof document === 'undefined') return;
    try {
      let el = emotion.bubbleEl;
      if (!el || !el.isConnected) {
        el = document.createElement('div');
        el.id = 'petbody-bubble';
        document.body.appendChild(el);
        emotion.bubbleEl = el;
      }
      el.textContent = String(text || '');
      el.style.opacity = '1';
      clearTimeout(emotion.bubbleTimer);
      emotion.bubbleTimer = setTimeout(() => { el.style.opacity = '0'; }, 3600);
    } catch (e) {}
  }

  // ── 表演决策日志（2026-11-17 六十六轮）──────────────────────────────
  // 攒「学习型导演」的数据：每次决策 + 播完 90 秒内用户有没有接话。
  // 写在 pet-runtime/data/performance-log.jsonl（gitignored；2MB 轮转一次）。
  // 渲染层有 fs（nodeIntegration），但打包进浏览器时没有 → 拿不到 fs 就只留内存。
  const perfLog = createPerformanceLog({
    append: (() => {
      try {
        const fs = require('fs');
        const path = require('path');
        let dir = null;
        const starts = [];
        try { starts.push(__dirname); } catch (e) { /* bundle 里可能没有 */ }
        if (typeof process !== 'undefined' && process.cwd) starts.push(process.cwd());
        for (const start of starts) {
          let d = path.resolve(start);
          for (let i = 0; i < 8; i += 1) {
            const cand = path.join(d, 'pet-runtime', 'data');
            if (fs.existsSync(cand)) { dir = cand; break; }
            const up = path.dirname(d);
            if (up === d) break;
            d = up;
          }
          if (dir) break;
        }
        if (!dir) return () => {};
        const file = path.join(dir, 'performance-log.jsonl');
        return (line) => {
          try {
            const st = fs.existsSync(file) ? fs.statSync(file) : null;
            if (st && st.size > 2 * 1024 * 1024) { try { fs.renameSync(file, file + '.1'); } catch (e) {} }
            fs.appendFileSync(file, line, 'utf8');
          } catch (e) { /* 写日志失败不能影响表演 */ }
        };
      } catch (e) { return () => {}; }
    })(),
  });

  // ── 语义兜底（2026-11-17 六十五轮）────────────────────────────────────
  // 规则引擎（关键词）+ LLM 都没给出情绪时，问一次常驻的 LumenAct 语义服务（8120）。
  // 为什么要它：规则只认词表，'算了，不说了' 这种它给不出情绪；语义模型能。
  // 为什么异步 + 门限：8ms 也别挡主链；置信度 < 0.4 不喂（宁可没有，不要喂错）。
  //
  // 2026-11-18 §69 B6：输入槽改用「情绪描述 + 台词」。8120 的契约本来就是
  // {intent: 情绪描述, text: 台词}，而这里原来把原始文本塞进 intent —— 离线实验
  // （_probe/semantic-rewrite-eval.mjs，18 条语料）可用率 22%、情绪对上 6%；
  // 换成描述后 44% / 39%，同一句塞两个槽只有 22%（说明起作用的是描述本身）。
  // 描述由宿主提供（options.describeIntent → ipc sense-intent-describe → 极小 LLM 改写）；
  // 拿不到描述时**退回原句**，确保不比原来更差。
  const SEM = { lastAt: 0, last: null, calls: 0, fed: 0, skipped: 0, rewritten: 0, describeFail: 0, moodFed: 0, moodSeen: 0, moodMiss: 0, moodNeutral: 0, moodLastError: '' };

  // ── 搭车的情绪：收到就喂（2026-11-18 §72b）────────────────────────────────
  // 原来的用法有个语义错配：语义兜底是「用户开口时」问一次情绪，而主模型搭车写的 mood 是
  // 「她回完这句话之后」才有的 —— 兜底只能吃到**上一轮**的 mood。而 mood 描述的正是她这句话
  // 的心情，所以正确时机是它到达的那一刻：本地 8120 分类（~8ms，不调 LLM）→ 喂情绪引擎。
  // 与兜底不冲突：兜底仍负责「用户话里有规则读不出的情绪」，这条负责「她自己说完之后的心情」。
  // 8120 的 27 类 category 有时会把一句情绪描述判成「自然放松/neutral」（实测 conf 0.48），
  // 而同一响应里的 voice 置信度高得多（vulnerable 0.80）。所以补一层：category 给不出非中性时，
  // 用 voice 兜；只映射语义明确的几档 —— 剩下的宁可丢，也不猜（喂错情绪比没有更糟）。
  const VOICE_TO_EMOTION = {
    joyful: 'happy', playful: 'playful', warm: 'happy',
    sad: 'sad', vulnerable: 'sad', fearful: 'sad',
    angry: 'angry', awkward: 'shy', apologetic: 'shy',
  };
  (function listenMoodFromHost() {
    if (typeof window === 'undefined' || window.__petMoodListener) return;
    window.__petMoodListener = true;
    let ipcRenderer = null;
    try { ipcRenderer = require('electron').ipcRenderer; } catch (e) { ipcRenderer = null; }
    if (!ipcRenderer || typeof ipcRenderer.on !== 'function') return;
    ipcRenderer.on('mood-line', (_event, payload) => {
      try {
        SEM.moodSeen += 1;   // 收到就算见到（后面分类失败也记）—— 用来区分「没广播到」和「分类失败」
        const mood = String((payload && payload.mood) || '').trim();
        if (!mood || mood.length < 2) { SEM.moodMiss += 1; SEM.moodLastError = 'mood 为空'; return; }
        lumenSemantic.classify({ intent: mood, timeoutMs: 900 }).then((r) => {
          if (!r || !r.ok) { SEM.moodMiss += 1; SEM.moodLastError = '分类服务失败：' + String((r && r.error) || 'unknown'); return; }
          // category 给不出非中性时用 voice 兜 —— voice 的置信度高得多
          // （实测同一句：category 痛苦疼痛 0.30 / voice vulnerable 0.80）
          let emo = r.emotion;
          let via = 'category';
          if (!emo || emo === 'neutral') {
            const byVoice = VOICE_TO_EMOTION[String(r.voice || '')];
            if (byVoice) { emo = byVoice; via = 'voice'; }
          }
          if (!emo || emo === 'neutral') {
            SEM.moodMiss += 1;
            SEM.moodLastError = '分类不可用：' + String(r.category || '-') + '/' + String(r.voice || '-') + ' → neutral';
            return;
          }
          if (!emotion.engine) { SEM.moodMiss += 1; SEM.moodLastError = '情绪引擎未就绪'; return; }
          emotion.engine.feed({
            kind: 'emotion',
            emotion: emo,
            // voice 兜的那档没有 category 置信度可依，给一个中庸强度
            strength: via === 'voice' ? 0.55 : Math.min(0.85, 0.4 + Number(r.confidence || 0) * 0.5),
            now: performance.now(),
          });
          SEM.moodFed += 1;
          SEM.moodLastError = '';
        }).catch((e) => { SEM.moodMiss += 1; SEM.moodLastError = '分类异常：' + ((e && e.message) || e); });
      } catch (e) { SEM.moodMiss += 1; /* 绝不影响主链 */ }
    });
  })();
  async function classifyForFallback(text) {
    const describe = (options && typeof options.describeIntent === 'function') ? options.describeIntent : null;
    if (!describe) return { r: await lumenSemantic.classify({ intent: text, timeoutMs: 900 }), described: false };
    let description = '';
    try {
      const d = await describe(text);
      if (d && d.ok && d.description) { description = String(d.description).trim(); SEM.rewritten += 1; }
      else SEM.describeFail += 1;
    } catch (e) {
      SEM.describeFail += 1;
    }
    if (!description) return { r: await lumenSemantic.classify({ intent: text, timeoutMs: 900 }), described: false };
    return { r: await lumenSemantic.classify({ intent: description, text, timeoutMs: 900 }), described: true, description };
  }
  function semanticFallback(text) {
    try {
      if (typeof window !== 'undefined' && window.__petSemantic === false) return;
      const t = String(text || '').trim();
      if (t.length < 2) return;
      const now = Date.now();
      if (now - SEM.lastAt < 1200) return;            // 文本是分片到达的，防抖
      SEM.lastAt = now;
      // 规则已经给出强情绪 → 不再问（省一次 8ms，也避免覆盖更可信的结论）
      let strong = false;
      try {
        const snap = emotion.engine ? emotion.engine.snapshot() : null;
        strong = Boolean(snap && Number(snap.strength) >= 0.45 && snap.emotion && snap.emotion !== 'neutral');
      } catch (e) { strong = false; }
      if (strong) { SEM.skipped += 1; return; }
      SEM.calls += 1;
      classifyForFallback(t).then(({ r, described, description }) => {
        SEM.last = {
          at: Date.now(), ok: r.ok, category: r.category || null, confidence: r.confidence || 0,
          emotion: r.emotion || null, error: r.error || null, elapsedMs: r.elapsedMs || null,
          described: !!described, description: description || null,
        };
        if (!r.ok) return;
        // 阈值 0.4：对原始文本本来就低（20–52%），要求 0.5 会导致几乎从不兜底；
        // 走描述槽后均值上到 0.50（实验），同一个阈值自然放进来更多「明确的那部分」。
        if (Number(r.confidence) < 0.4) return;
        if (!r.emotion || r.emotion === 'neutral') return;
        if (!emotion.engine) return;
        emotion.engine.feed({
          kind: 'emotion',
          emotion: r.emotion,
          strength: Math.min(0.85, 0.35 + Number(r.confidence) * 0.5),
          now: performance.now(),
        });
        SEM.fed += 1;
      }).catch(() => { /* 服务挂了就当没有 */ });
    } catch (e) { /* 兜底链绝不能反向影响主链 */ }
  }

  /**
   * 面部片段的**边沿触发**（2026-11-17 六十四轮续）。
   *
   * 为什么不是定时轮询：`perf.feed({gate: emoSnap.weight})` 里的 gate 是**老引擎的包络**，
   * 她没在说话/没情绪事件时恒 0 → `perf.snapshot().weight` 长期为 0，
   * 轮询 8 秒只会不停拿到 weak-emotion（实测 14 次决策 0 播放）。
   *
   * 所以改成两个**边沿**：
   *   ① 情绪峰值上升沿（包络由弱跨强）：记下峰值，**不立刻演** —— 她正在说话，嘴归口型层；
   *   ② 说完（包络落下来）：拿记下的峰值问一次导演，由导演的六条规则决定演不演。
   * 导演自己还有 90s 冷却 + 同段 6 分钟 + 10 分钟 4 次上限，不会连环爆。
   */
  function maybeTriggerFacsClip(emoSnap, perfSnap) {
    const api = emotion.facsClips;
    const trig = emotion.facsTrigger;
    // 用**老引擎包络**当强度信号（`emoSnap.weight`，0..1，喂一句强情绪能到 0.8+）。
    // 不能用 perf 的 weight：它是 `intensity × gate × gain`，实测峰值只有 0.39，
    // 拿它当阈值会导致「永远差一点」（六十四轮实测踩到）。
    const env = Number(emoSnap && emoSnap.weight);
    const perfW = Number(perfSnap && perfSnap.weight) || 0;
    const w = Number.isFinite(env) && env > 0 ? env : perfW;
    if (!api || !trig) return;
    if (trig.enabled === false) { trig.prevWeight = w; return; }

    const speaking = Boolean(perfSnap && perfSnap.speaking);
    const emo = (emoSnap && emoSnap.emotion) || (perfSnap && perfSnap.emotion) || '';

    // 观测：记住见过的最大强度与边沿次数（排查「为什么没触发」用，成本可忽略）
    trig.maxWeight = Math.max(Number(trig.maxWeight) || 0, w);
    trig.maxStrength = Math.max(Number(trig.maxStrength) || 0, w);

    // ① 上升沿：只记峰值，不立刻演 —— 她正在说话，嘴归口型层。
    //    两个坑（实测）：
    //    a) 包络回落尾巴时 output() 返回 `emotion:'neutral'` 但 weight 还很高 →
    //       neutral 绝不能进峰值，否则会去演「自然放松」；
    //    b) 峰值要取「非 neutral 的最高点」，而不是第一次跨过阈值的那个采样。
    if (emo && emo !== 'neutral' && w >= 0.5 && (!trig.peak || w >= trig.peak.intensity)) {
      trig.peak = { emotion: emo, intensity: w, at: Date.now() };
      trig.retryCount = 0;
      if (trig.prevWeight < 0.5) trig.edges = (Number(trig.edges) || 0) + 1;
    }
    // ② 说完（包络落回 0.15 以下）→ 拿峰值问导演
    if (trig.peak && !speaking && w < 0.15) {
      const nowMs = Date.now();
      // busy 时不要每帧重试（实测 60fps 会打 278 次决策）：最多 2 秒试一次；
      // 峰值超过 60 秒还没演出去就丢弃（情绪早过去了，别补演）
      if (nowMs - Number(trig.peak.at || 0) > 60000) {
        trig.peak = null;
        trig.nextTryAt = 0;
      } else if (!trig.nextTryAt || nowMs >= Number(trig.nextTryAt)) {
        const peak = trig.peak;
        // P0：在场判定统一走 presence（六态）；片段导演只把 away 当硬门，
        // gaming/watching 由外层 director 决定「只许短段」。
        const presence = directorPresence();
        const activity = presence ? presence.state : '';
        // P0：导演门。dry-run 只记 perf.request（allowed:false + reason），auto 照旧；
        // enforce 才不调用 auto（不白吃导演冷却）。
        const dirPeak = directorDecideFor('clip', { key: 'clip:peak' });
        let res = null;
        try {
          if (dirPeak.proceed) {
            res = api.auto({
              source: 'peak',
              emotion: peak.emotion,
              intensity: peak.intensity,
              activity,
              speaking: false,
              // P1（2026-11-21）：busy 从**共享 claim** 取，而不是只问 performer.active。
              // 旧写法在「v2 同帧稍后才启动」时读到 false → 片段先演、v2 又启动 → 双写。
              // 现在 director 的 busy 门与 claim 同源；auto() 内部还有二次占用门。
              busy: perfClaim.active && perfClaim.owner !== 'clip',
              // 只有 enforce 才把时长预算交给片段导演；dry-run 不能改变选择结果。
              maxMs: dirPeak.dec && dirPeak.dec.mode === 'enforce' ? dirPeak.dec.maxMs : undefined,
            });
          }
        } catch (e) { /* 片段出错绝不能影响渲染/对话 */ }
        if (res && res.reason === 'busy') {
          // 全身表演占着：2 秒后再试，但**最多 3 次**。
          // 为什么要上限：每次重试都会写一条 skip，日志分析时 45/53 条 skip 全是 busy，
          // 把「她其实很少被允许演」的结论灌成了噪音（2026-11-18 分析脚本首次跑出来）。
          trig.retryCount = (Number(trig.retryCount) || 0) + 1;
          if (trig.retryCount >= 3) {
            trig.peak = null;
            trig.nextTryAt = 0;
            trig.retryCount = 0;
          } else {
            trig.nextTryAt = nowMs + 2000;
          }
        } else {
          trig.peak = null;                    // 其余结果都算处理过
          trig.nextTryAt = 0;
          trig.retryCount = 0;
        }
      }
    }
    trig.prevWeight = w;

    // ③ 空闲自练（2026-11-17 六十五轮，用户拍板「加空闲自练」）：
    //    足够久没有情绪事件 → 偶尔自己练一段中性片段（自然放松/思考专注/欣慰宽慰）。
    //    阈值与间隔可调（setIdleRule），验收时把 idleMs 调到 5 秒即可看到。
    const nowIdle = Date.now();
    if (w >= 0.3) trig.lastStrongAt = nowIdle;
    if (!trig.lastStrongAt) trig.lastStrongAt = nowIdle;
    if (!trig.peak && !speaking && !api.isPlaying) {
      const idleFor = nowIdle - Number(trig.lastStrongAt);
      const needIdle = Number(trig.idleMs) || 150000;
      if (idleFor >= needIdle && nowIdle >= (Number(trig.nextIdleAt) || 0)) {
        const presence = directorPresence();
        const activity = presence ? presence.state : '';
        // P0：导演门（空闲通道 8 分钟一次）。
        const dirIdle = directorDecideFor('clip', { key: 'clip:idle' });
        let res = null;
        try {
          if (dirIdle.proceed) {
            res = api.auto({ source: 'idle', emotion: 'neutral', intensity: 0.6, activity, speaking: false, busy: perfClaim.active && perfClaim.owner !== 'clip' });
          }
        } catch (e) { /* 同上，绝不影响渲染 */ }
        const gap = Number(trig.idleGapMs) || 8 * 60 * 1000;
        trig.nextIdleAt = nowIdle + (res && res.reason === 'busy' ? 60000 : gap);
        trig.idleTries = (Number(trig.idleTries) || 0) + 1;
        if (res && res.played) trig.lastIdlePlayedAt = nowIdle;
      }
    }
  }

  /**
   * 手势资产/动作下发（P2b 抽成单点）：正常帧手势与「停止时补发的 exit」共用。
   * 资产 API 不在时（独立舞台页/非宿主环境）至少要发 petbody:asset 关闭事件 ——
   * 否则竖指/抚胸/狗尾草会留在手上（审计 §1.5 第 5 条）。
   */
  function applyGestureEvent(g) {
    if (!g || !g.group) return;
    let applied = false;
    try {
      const assetApi = (typeof window !== 'undefined') && window.__petAssets;
      if (g.asset && assetApi && typeof assetApi.apply === 'function') {
        assetApi.apply(g.asset, g.on === true);
        applied = true;
      }
    } catch (e) { /* 资产切换失败不阻断动作 */ }
    if (!applied && g.asset && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(new CustomEvent('petbody:asset', {
          detail: {
            asset: String(g.asset),
            on: g.on === true,
            reason: g.forced === true ? 'exit' : 'frame',
            fadeMs: Number(g.fadeMs) || 0,
          },
        }));
      } catch (e) { /* 没有 CustomEvent 的环境忽略 */ }
    }
    try { renderer.playMotion(g.group, g.index); } catch (e) { /* 单次动作失败不阻断整段表演 */ }
  }

  /** SCENES 真正开演（scheduler 'start' 时调；旧路径在 perform 里直接调） */
  function beginScenePlayback(name, steps, sceneDuration, token) {
    // 换人时旧写者必须真的停（收势已由 retract/fadeOut 做；这里只兜底）
    try {
      if (performer.active) performer.stop('switch');
      if (emotion.facsClips && emotion.facsClips.isPlaying) emotion.facsClips.stop('interrupt', { cancelPending: false });
    } catch (e) { /* ignore */ }
    clearSceneTimers();
    const timers = [];
    for (const step of steps) {
      timers.push(setTimeout(() => {
        try { if (step.emotion) api.setEmotion(step.emotion); } catch (e) {}
        try { if (step.motion) api.playMotion(step.motion); } catch (e) {}
        try { if (step.costume) api.setCostume(step.costume[0], step.costume[1]); } catch (e) {}
        // 音效不在渲染层播：它要经插件管理器（sfx 插件才有 SFX 目录与编码处理）。
        // 这里只把需求抛出去，由宿主的 driver 接住。
        try {
          if (step.sfx && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('petbody:sfx', { detail: { id: String(step.sfx) } }));
          }
        } catch (e) {}
      }, step.at || 0));
    }
    // 场景演完交还占用；token 确保不会误杀之后新起的另一段场景/手动演出。
    timers.push(setTimeout(() => { try { endClaim('scenes', token, 'natural'); } catch (e) {} }, sceneDuration));
    try { api._sceneTimers = timers; } catch (e) { /* api 还没初始化（理论上到不了） */ }
    return steps.length;
  }

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    // 帧率上限（2026-11-08 用户反馈「皮套帧数很低」）：
    //   原来写死 30ms = 33fps 硬顶。拖动、眼神跟随、口型都在这个循环里，
    //   33fps 下快速拖动会明显拖影/一顿一顿。
    //   实测浏览器 rAF 能跑 97fps（420×760 + 715 drawable 毫无压力），
    //   改成 16ms = 60fps；窗口隐藏时浏览器自动暂停 rAF，不需要额外省电逻辑。
    if (now - last < 16) return;
    last = now;
    // 调度器节拍（P2b）：1 次/帧，O(队列 ≤4)。收势到点换人、到 relax 点开收势、
    // 空闲时拉起队列都在这一行里；开关关着时 ensureScheduler() 返回 null（零成本）。
    try {
      const sched = ensureScheduler();
      if (sched) sched.tick(now);
    } catch (e) { /* 调度器异常绝不影响渲染 */ }
    // 拖动冻结（2026-11-21 用户反馈拖拽掉帧/残影/桌面卡顿）：
    //   真机实测「窗口移动幅度」直接决定渲染帧率 —— 静止 76fps、±1px 79、
    //   ±20px 62、±40px 53、±80px 38。真实拖动每帧几十 px，合成器被窗口移动占满，
    //   表现就是拖动卡、拖影、桌面其他应用一起掉帧。
    //   拖动时画面内容不需要变（她只是被搬走）：冻结后 Chromium 只更新窗口位置，
    //   GPU/合成压力骤降。last 必须推进（否则松手后 dt 巨大）；
    //   1.5s 新鲜度兜底 pointerup 落在窗外、drag-end 没发出来的情况。
    try {
      if (window.__pbDragging && Date.now() - (window.__pbDraggingAt || 0) < 1500) {
        state.dragFrozenFrames = (state.dragFrozenFrames || 0) + 1;
        return;
      }
    } catch (e) { /* 标志读不到就正常渲染 */ }
    state.renderedFrames = (state.renderedFrames || 0) + 1;
    // 60fps 的原始音量是抖的，先做攻击/释放平滑再交给嘴型曲线。
    const rawMouth = state.mouth > 0 && now - state.lastMouthAt > 320 ? 0 : state.mouth;
    const tau = rawMouth > state.mouthSmooth ? 0.035 : 0.09;
    state.mouthSmooth += (rawMouth - state.mouthSmooth) * (1 - Math.exp(-Math.max(0.001, dt) / tau));
    if (state.mouthSmooth < 0.01 && rawMouth === 0) { state.mouthSmooth = 0; state.speaking = false; }
    if (state.mouthSmooth > 0.02) emotion.lastMouthAt = now;
    if (typeof options.onMouth === 'function') options.onMouth(state.mouthSmooth, rawMouth);
    // ── 待机层（2026-11-25 P1）：每帧取一次偏置，上下文 1 秒采样一次 ─────────
    // 为什么 1 秒：readPresence 是同步函数调用（world-sense/__userActivity），每帧问
    // 60 次没必要；ambient.sample 本身是 O(1)（几个 sin + 一次比较）。
    try {
      const ambNow = Date.now();
      if (ambNow - ambientCtx.at >= 1000) {
        ambientCtx.at = ambNow;
        const p = directorPresence();
        ambientCtx.presence = p ? p.state : 'unknown';
        const lastTouch = Number(perfSession.lastTextAt || perfSession.userActionAt || perfSession.startedAt) || ambNow;
        ambientCtx.idleSec = Math.max(0, (ambNow - lastTouch) / 1000);
        ambientCtx.hour = new Date(ambNow).getHours();
        const sum = perfLog.summary(ambNow);
        // 被接率样本 <20 时 ambient 不会调权重（门槛与 choreo-tune 同）
        ambientCtx.reply = { rate: sum.replyRateAfterEnd, samples: sum.replySamplesAfterEnd };
      }
      const wasSpeaking = ambientCtx.lastSpeaking;
      ambientCtx.lastSpeaking = state.speaking === true;
      if (wasSpeaking && ambientCtx.lastSpeaking !== true) ambientCtx.conversationEndedAt = ambNow;
      const amb = ambient.sample(ambNow, {
        presence: ambientCtx.presence,
        hour: ambientCtx.hour,
        idleSec: ambientCtx.idleSec,
        conversationEndedAt: ambientCtx.conversationEndedAt,
        intensity: ambientIntensity(),
        reply: ambientCtx.reply,
      });
      state.ambient = {
        state: amb.state, dwellMs: amb.dwellMs, amp: amb.amp, action: amb.action,
        transitions: amb.transitions, needsRecompute: amb.needsRecompute,
      };
      // 表演/说话/片段占着时，ambient 让位（幅度 1 = 旧行为，偏置 null）
      const ambientVisible = state.speaking !== true && !performer.active && !perfClaim.active;
      // P1.5：偏置要落到真正写参数的那一层。表演占着时同样让位；说话时仍推给渲染器，
      // 由它把 head/gaze 系数减半（breath 不变）—— 这样「说话时不参与指向、但还在呼吸」
      // 是一条可测的规则，而不是「说话时整层消失」。
      const ambientApply = !performer.active && !perfClaim.active;
      try { renderer.setAmbientAmp(ambientVisible ? amb.motionScale : 1); } catch (e) { /* ignore */ }
      try {
        renderer.setAmbientOffset(ambientApply ? Object.assign({}, amb.bias, { amp: amb.amp }) : null);
      } catch (e) { /* ignore */ }
      if (emotion.perf && typeof emotion.perf.setAmbientBias === 'function') {
        emotion.perf.setAmbientBias(ambientVisible ? { amp: amb.amp, bias: amb.bias } : null);
      }
    } catch (e) { /* ambient 异常绝不影响主渲染 */ }
    // 情绪引擎：tick → 平滑逼近 → 写进 defaults（updateView 从 defaults 取基线）
    let emoSnap = null;
    let perfSnap = null;
    const frameDt = Math.max(0.001, dt);
    // 本帧「物理输出参数重放」清单（只有 perf 算出目标时才填；legacy 帧必须清空）
    state.perfCommit = null;
    try {
      if (emotion.engine) {
        emoSnap = emotion.engine.tick(now);
        if (emotion.perfMode === 'perf' && emotion.perf) {
          try {
            // 说话状态接入（2026-11-21 P1）：perf 的 speaking 原来只来自 speech.pending，
            // 而 speak() 全仓无人调用 → snapshot().speaking 恒 false（「说完才演」退化、
            // FACS 片段说话时也不屏蔽嘴）。这里每帧把宿主 TTS 状态推进去；
            // 上升沿把字幕文本交给 speech.segment（语音重点真正的生产调用点）。
            const speakingNow = state.speaking === true;
            try { emotion.perf.setSpeaking(speakingNow); } catch (e) { /* perf 缺 API 也不影响渲染 */ }
            if (speakingNow && !emotion.speechPrev) {
              try {
                const el = typeof document !== 'undefined' ? document.getElementById('subtitle-text') : null;
                const spoken = el ? String(el.textContent || '').trim() : '';
                if (spoken) emotion.perf.speak(spoken, Math.min(15000, Math.max(800, spoken.length * 180)));
              } catch (e) { /* 字幕还没出来就算了 */ }
            }
            emotion.speechPrev = speakingNow;
            // gate = 老引擎的起势/收势包络：它说收就收，VAD 只负责「还在不在余韵里」。
            // ⚠ 2026-11-17 六十四轮：这里原来读 `emoSnap.strength`，但 emotion-engine 的
            //   tick()/output() **根本不返回 strength 字段**（只有 weight/until/layers…）
            //   → 传了几年 0，perf 只靠 gate 的残余驱动，表情层一直偏弱
            //   （实测喂进 0.82 强度的难过，perf 的 weight 峰值只有 0.398）。
            //   现在优先取包络 weight，退化再取 layers[0].strength。
            const feedStrength = Number.isFinite(emoSnap.weight) ? emoSnap.weight
              : (Array.isArray(emoSnap.layers) && emoSnap.layers[0] && Number.isFinite(emoSnap.layers[0].strength)
                ? emoSnap.layers[0].strength : 0);
            emotion.perf.feed({
              emotion: emoSnap.emotion,
              strength: feedStrength,
              gate: Number.isFinite(emoSnap.weight) ? emoSnap.weight : 1,
            });
            perfSnap = emotion.perf.update(frameDt);
            applyPerfParams(perfSnap, frameDt);
            maybeTriggerFacsClip(emoSnap, perfSnap);
          } catch (perfError) {
            emotion.perfMode = 'legacy';
            if (!errors.includes(String(perfError))) { errors.push(String(perfError)); console.error('[petbody] perf 运行出错，降级 legacy', perfError); }
            applyEmotionTargets(emoSnap, frameDt);
          }
        } else {
          applyEmotionTargets(emoSnap, frameDt);
        }
      }
    } catch (error) {
      if (!errors.includes(String(error))) { errors.push(String(error)); console.error('[petbody] emotion', error); }
    }
    // 每 1.5 秒把情绪快照抛给宿主（控制面板「自查」读它）
    if (emotion.engine && now - (emotion.lastReport || 0) > 1500) {
      emotion.lastReport = now;
      try {
        const snap = emoSnap || emotion.engine.snapshot();
        const payload = { type: 'emotion', emotion: snap.emotion, strength: snap.strength, remainingMs: snap.remainingMs, layer: snap.layer };
        if (typeof window !== 'undefined') {
          window.__petBodyEmotionReport = payload;
          window.dispatchEvent(new CustomEvent('petbody:emotion', { detail: payload }));
        }
      } catch (e) {}
    }
    // 表情脸的来源：优先用情绪引擎**当前**的情绪（会自然衰减、能自己回落）；
    //   没有引擎时才退回 state.emotion（显式 setEmotion 的旧语义）。
    //   原来这里只读 state.emotion，而 state.emotion 只有宿主显式调用才会变，所以
    //   引擎算出了 aggrieved/happy 也不会驱动脸 —— 她又「没表情」了。
    const faceEmotion = (emoSnap && emoSnap.emotion) || state.emotion || 'neutral';
    // ⚠ emotion.engine.tick() 返回的是 **weight**（包络后的强度），没有 strength 字段。
    //   2026-11-16 真机抓到的：这里读 emoSnap.strength 恒为 undefined → faceStrength 恒 0，
    //   自动演出在「引擎明明算出 happy 0.82」时也判 weak-emotion。
    const faceStrength = emoSnap && Number.isFinite(emoSnap.weight)
      ? Math.max(0, Math.min(1, emoSnap.weight))
      : (state.emotion === 'neutral' ? 0 : 1);
    // ── 编舞 v1（2026-11-15）────────────────────────────────────────────
    // 先算这一帧的加法偏置，交给 updateView 在 model.update() **之前**叠加。
    // （写在 updateView 之后不会参与这一帧的顶点重算 —— 表现是「参数里有值、画面不动」。）
    // 默认关（window.__petChoreoOn），托盘「编舞（实验）」打开。
    let choreoFrame = null;
    try {
      const choreoOn = (typeof window !== 'undefined') && window.__petChoreoOn === true;
      const speakingNow = state.speaking === true;
      // 情绪键顺序：先用「这句话的标注情绪」（setEmotion 的标准键），再用引擎的 felt emotion。
      // 2026-11-16 实测：引擎常驻 back to neutral，拿它当首选会让 v1/v2 都判定"没情绪"。
      const emoKey = String(state.emotionKey || (emoSnap && emoSnap.emotion) || state.emotion || 'neutral');
      const sinceStart = performance.now() - choreo.startedAt;
      const risingEdge = speakingNow && choreo.prevSpeaking !== true;

      // ── 表演 v2 自动触发（2026-11-16，用户拍板：「聊天就该触发，不能靠托盘」）──
      // 真人不会每句话都演 20–38 秒的戏 ⇒ 决策全在 choreo-auto.mjs（纯函数、可单测）：
      // 情绪要有对应段、强度到门槛 0.35、全局冷却 3 分钟、同段冷却 6 分钟、单会话上限 12 段。
      // v3 起有三个触发点：①开始说话（标注情绪新鲜时）②引擎算出强情绪后等这句说完
      // ③安静 2.5 分钟后自己练一段（见下方空闲通道）。
      let v2Started = false;
      const perfAutoOn = (typeof window === 'undefined') || window.__petPerfAuto !== false;
      // P1（2026-11-21）：本帧 v2 能不能启动，先问共享 claim（片段/v2/手动统一仲裁）。
      // 占用时不跑 consider（否则冷却被白吃），只记 yield。
      const claimFreeForV2 = perfArbiter.availableFor('v2');
      if (risingEdge && perfAutoOn && !performer.active) {
        // 情绪键新鲜度（v3.1 真机教训）：state.emotionKey 会被「空闲检测」写成 bored/sleepy 并一直留着，
        // 用户一开口就按 bored 演「换重心」——完全不对。只有 15 秒内写入的情绪才算「这句话的情绪」。
        const stateEmoFresh = Number(state.emotionAt) > 0 && (performance.now() - Number(state.emotionAt) < 15000);
        const riseEmotion = stateEmoFresh ? String(state.emotionKey || '') : String((emoSnap && emoSnap.emotion) || '');
        const riseStrength = stateEmoFresh && Number(state.emotionStrength) > 0
          ? Number(state.emotionStrength)
          : (Number(faceStrength) || 0);
        // P0（2026-11-25）：导演门在 consider **之前**。dry-run 时 gate 永远 proceed，
        // 只多写一条 perf.request；enforce 时才真的跳过 consider（不白吃冷却）。
        const dirT1 = directorDecideFor('v2', { key: 'auto:speech' });
        if (!dirT1.proceed) {
          if (typeof window !== 'undefined') window.__perfAutoState = {
            decision: { play: false, reason: 'director:' + dirT1.reason },
            input: { emotion: riseEmotion, strength: riseStrength, fresh: stateEmoFresh },
            at: Date.now(),
          };
        } else if (!claimFreeForV2) {
          // 片段（或手动）正占着脸：让位并记账，不消耗自动触发的冷却。
          perfClaim.recordYield('v2', { reason: 'busy', heldBy: perfClaim.snapshot().owner, key: 'auto:speech' });
          if (typeof window !== 'undefined') window.__perfAutoState = {
            decision: { play: false, reason: 'busy' },
            input: { emotion: riseEmotion, strength: riseStrength, fresh: stateEmoFresh },
            at: Date.now(),
          };
        } else {
          const d = perfAuto.consider({ emotion: riseEmotion, strength: riseStrength, now: performance.now() });
          if (d.play) {
            const started = requestPerformance(d.key, performance.now(), { owner: 'v2' });
            if (started.ok) {
              v2Started = true;
              choreo.perf = null;   // v2 接手时 v1 让位：两套同时演会互相盖参数
            }
          }
          if (typeof window !== 'undefined') window.__perfAutoState = {
            decision: d,
            input: { emotion: riseEmotion, strength: riseStrength, fresh: stateEmoFresh },
            at: Date.now(),
          };
        }
      }

      // ── 空闲通道（v3）：她安静站着时自己练一段 ──────────────────────
      // 触发条件：没在说话 + 至少 2.5 分钟没人聊 + 每 20 秒评估一次（概率 30%）。
      // 段池=姿态/手势小段（05/06/07/08/01），稀有段 13（换装变 Q 版）只有 4% 概率。
      // 与情绪通道共用全局冷却/同段冷却/会话上限，不会「刚演完又演」。
      if (speakingNow) perfIdle.lastSpeakingAt = performance.now();
      if (!speakingNow && perfAutoOn && !performer.active) {
        const nowIdle = performance.now();
        if (nowIdle - perfIdle.lastCheckAt >= 20000) {
          perfIdle.lastCheckAt = nowIdle;
          // P0：导演门（dry-run 只记 perf.request，不拦）。只有「安静到接近空闲触发阈值
          // （2 分钟）」才问导演 —— 否则用户正在聊天时每 20 秒一条 perf.request，
          // 24h dry-run 报告会被不是演出请求的样本灌成噪音。
          const idleForDirector = nowIdle - perfIdle.lastSpeakingAt;
          const dirT3 = idleForDirector >= 120000
            ? directorDecideFor('v2', { key: 'auto:idle' })
            : { proceed: true, dec: null };
          if (!dirT3.proceed) {
            if (typeof window !== 'undefined') window.__perfIdleState = { decision: { play: false, reason: 'director:' + dirT3.reason }, at: Date.now() };
          } else if (!claimFreeForV2) {
            perfClaim.recordYield('v2', { reason: 'busy', heldBy: perfClaim.snapshot().owner, key: 'auto:idle' });
            if (typeof window !== 'undefined') window.__perfIdleState = { decision: { play: false, reason: 'busy' }, at: Date.now() };
          } else {
            const di = perfAuto.considerIdle({
              now: nowIdle,
              idleMs: nowIdle - perfIdle.lastSpeakingAt,
              // P1：空闲长段只在导演 intensity≥0.8 时允许；其余时间交给 ambient。
              // 导演没开（dec=null）时传 undefined → 保持旧行为（不设门）。
              intensity: dirT3.dec ? dirT3.dec.intensity : undefined,
            });
            if (di.play) {
              const started = requestPerformance(di.key, nowIdle, { owner: 'v2' });
              if (started.ok) {
                v2Started = true;
                choreo.perf = null;
              }
            }
            if (typeof window !== 'undefined') window.__perfIdleState = { decision: di, at: Date.now() };
          }
        }
      }

      // ── 情绪到位通道（v3.1）─────────────────────────────────────────
      // 真机实测（2026-11-16）：一条真实回复里，「开始说话」那一刻强度常常还是 0，
      // 引擎要到 7 秒后才算出 happy 0.82。只挂 risingEdge ⇒ 自动长表演几乎永不触发
      // （用户看到的就是「只能点击演一段」）。
      // 这里改为监听「引擎算出强情绪」这件事本身，先暂存；等这轮说完（speaking 落下）
      // 再评估一次 —— 像真人说完一句情绪上来，才顺势做个动作。
      if (perfAutoOn) {
        const feltKey = String((emoSnap && emoSnap.emotion) || '');
        // tick() 的强度字段叫 weight（包络后的 0..1），不是 strength
        const feltStrength = Number((emoSnap && (emoSnap.weight ?? emoSnap.strength)) || 0);
        if (typeof window !== 'undefined' && (!window.__perfEmoDebugAt || performance.now() - window.__perfEmoDebugAt > 500)) {
          window.__perfEmoDebugAt = performance.now();
          window.__perfEmoDebug = {
            feltKey, feltStrength, pending: perfEmo.pending ? { ...perfEmo.pending } : null,
            active: performer.active, speaking: speakingNow, at: Date.now(),
          };
        }
        if (feltKey && feltStrength >= 0.5) {
          perfEmo.pending = { emotion: feltKey, strength: feltStrength, at: performance.now() };
        }
        if (!speakingNow && perfEmo.pending && !performer.active
          && performance.now() - perfEmo.pending.at < 20000) {
          if (!claimFreeForV2) {
            // P1：片段/手动正占着 → 保留 pending（20 秒内片段结束还能补演），
            // 每秒最多记一条 yield，避免 60fps 把计数刷爆。
            const nowMs = performance.now();
            if (!perfEmo.lastYieldAt || nowMs - perfEmo.lastYieldAt > 1000) {
              perfEmo.lastYieldAt = nowMs;
              perfClaim.recordYield('v2', { reason: 'busy', heldBy: perfClaim.snapshot().owner, key: 'auto:felt' });
            }
          } else {
            const cand = perfEmo.pending;
            perfEmo.pending = null;
            if (cand.emotion !== perfEmo.lastKey || performance.now() - perfEmo.lastAt > 15000) {
              perfEmo.lastKey = cand.emotion;
              perfEmo.lastAt = performance.now();
              // P0：导演门（此分支最多 15 秒一次）。dry-run 只记日志，enforce 才跳过 consider。
              const dirT2 = directorDecideFor('v2', { key: 'auto:felt' });
              if (!dirT2.proceed) {
                if (typeof window !== 'undefined') window.__perfEmoState = { decision: { play: false, reason: 'director:' + dirT2.reason }, input: cand, at: Date.now() };
              } else {
                const de = perfAuto.consider({ emotion: cand.emotion, strength: cand.strength, now: performance.now() });
                if (de.play) {
                  const started = requestPerformance(de.key, performance.now(), { owner: 'v2' });
                  if (started.ok) {
                    v2Started = true;
                    choreo.perf = null;
                  }
                }
                if (typeof window !== 'undefined') window.__perfEmoState = { decision: de, input: cand, at: Date.now() };
              }
            }
          }
        }
      }

      const shouldStart = choreoOn && speakingNow && !v2Started && !performer.active
        && (!choreo.prevSpeaking || (choreo.perf && emoKey !== choreo.lastKey && sinceStart > 900));
      if (shouldStart) {
        const perf = performanceForEmotion(emoKey);
        if (perf) {
          choreo.perf = perf;
          choreo.startedAt = performance.now();
          choreo.lastKey = emoKey;
          if (typeof window !== 'undefined') {
            window.__choreoState = { on: true, active: true, name: perf.name, at: Math.round(choreo.startedAt) };
          }
        }
      }
      choreo.prevSpeaking = speakingNow;
      if (choreoOn && choreo.perf) {
        const t = (performance.now() - choreo.startedAt) / 1000;
        if (t <= choreo.perf.duration) {
          const w = performanceWeight(t, choreo.perf.duration);
          // 情绪强度参与幅度：淡淡的高兴只小幅动，强烈的高兴演得明显一点
          const gain = 0.65 + 0.35 * Math.max(0, Math.min(1, Number(faceStrength) || 0.8));
          const vals = samplePerformance(choreo.perf, t);
          choreoFrame = {};
          for (const pid of Object.keys(vals)) choreoFrame[pid] = vals[pid] * w * gain;
          choreo.lastApplyAt = performance.now();
        } else {
          choreo.perf = null;
          if (typeof window !== 'undefined') window.__choreoState = { on: true, active: false, name: '', at: 0 };
        }
      }
    } catch (e) { /* 编舞异常不影响主渲染 */ }
    // ── 表演层 v2（2026-11-15）：采样本帧参数轨道，并处理一次性事件 ──────────
    // 三条让权规则（见 choreo-performer.mjs 注释）：
    //   说话时嘴归语音（PLAYER 里已剔除 MouthOpenY/MouthForm）；
    //   手势走 playMotion 原生动画（不写关节轨道）；
    //   表情走 manualFace（exp3 交给 ExpressionManager）。
    let perfFrame = null;
    try {
      const nowPerf = performance.now();
      perfFrame = performer.sample(nowPerf, { speaking: state.speaking === true });
      // P2b：停止时补发的手势 exit 可能落在「已经没有表演」的帧上（sample 返回 null），
      // 所以每帧都取一次（空数组时零成本），保证资产一定会被收回。
      try {
        const exits = performer.takeExits();
        for (let i = 0; i < exits.length; i += 1) applyGestureEvent(exits[i]);
      } catch (e) { /* 资产收回失败不阻断渲染 */ }
      if (perfFrame) {
        // 表演层表情（v3）：把本帧所有该锁的脸交给渲染层按权重融合。
        // 旧实现只锁第一张（manualFace 单槽）→ 13 的「裙子+眼镜」、04 的「＞＜+脸红」会丢第二张。
        // P0（2026-11-25）：exp3 锁也在资产 pin 的管辖内 —— 用户手动点「脸红」（pin key7）后，
        // v2 不能再靠剧情锁「脸红」把 key7 叠回来。整张脸锁或整张不锁（单通道没有半张脸）。
        let facesToLock = Array.isArray(perfFrame.expressions) ? perfFrame.expressions : [];
        // 2026-11-25 实拍：10-resolution 的「加载」是作者做的 loading 动画（12 个灰胶囊），
        // 在 40% 处贴在头发上像脏点/穿模。它不是剧情表情，是资源占位 —— 不进表演层。
        // 硬编码黑名单而不是配置键：它来自素材本身，不是用户偏好。
        const V2_FACE_BLOCKLIST = new Set(['加载']);
        if (facesToLock.length) facesToLock = facesToLock.filter((n) => !V2_FACE_BLOCKLIST.has(String(n)));
        let facePinSkips = [];
        try {
          const pinnedFaces = getPinnedAssetParams(renderer);
          if (pinnedFaces && pinnedFaces.size) {
            const filtered = filterPinnedExpressions(facesToLock, pinnedFaces);
            facesToLock = filtered.accepted;
            facePinSkips = filtered.skippedPinned;
          }
        } catch (e) { facePinSkips = []; }
        if (facePinSkips.length) {
          emotion.v2FacePinSkips = (Number(emotion.v2FacePinSkips) || 0) + facePinSkips.length;
          for (const s of facePinSkips) {
            const key = 'face:' + s.name;
            if (emotion.v2FacePinSeen && emotion.v2FacePinSeen.has(key)) continue;
            if (!emotion.v2FacePinSeen) emotion.v2FacePinSeen = new Set();
            emotion.v2FacePinSeen.add(key);
            console.info(`[param-ownership] v2 跳过表情锁「${s.name}」（${s.params.join('/')} 已被手动 pin）`);
          }
        }
        if (typeof renderer.setPerformanceFaces === 'function') {
          renderer.setPerformanceFaces(facesToLock);
        } else if (perfFrame.expression) {
          // 兜底旧渲染层
          if (facesToLock.includes(perfFrame.expression)) {
            renderer.manualFace = perfFrame.expression;
            renderer.manualFaceUntil = nowPerf + 600;
          }
        }
        // P0：v2 写入集入册 —— 以前 checkWriteSet 只查 perf，v2 走 view.choreo/choreoOverride
        // 完全绕过断言（审计叫它「所有权黑洞」）。这里把本帧真实写入集与编译数据的轨道 id 对账。
        try {
          const declared = Array.isArray(performer.params) ? performer.params(perfFrame.key) : [];
          // 生命层（lifeLayer）是代码里写死的微漂移，不在编译数据里 —— 一起声明，否则永远红。
          const audit = checkChoreoWriteSet(
            { choreo: perfFrame.additive, choreoOverride: perfFrame.override },
            declared.concat(['AngleX', 'AngleZ', 'ParamEyeBallX']),
          );
          emotion.v2OwnershipAudit = audit;
          if (!audit.ok && !emotion.v2OwnershipWarned) {
            emotion.v2OwnershipWarned = true;
            console.warn('[param-ownership] v2 写入了编译数据未声明的参数：', JSON.stringify(audit.undeclared.slice(0, 8)));
          }
        } catch (e) { /* 断言失败不影响渲染 */ }
        // 原生手势：动作 + 资产必须成对（2026-11-15 实测：光播 motion 只轻微调手臂，
        // 「竖食指」出现靠 Movement1/2/3 的图层切换）。资产走 window.__petAssets 全局，
        // 不直接引 api.setCostume —— frame 可能早于 api 定义执行（TDZ）。
        for (let i = 0; i < perfFrame.gestures.length; i += 1) {
          applyGestureEvent(perfFrame.gestures[i]);
        }
        if (perfFrame.done) {
          // P1：演完必须交还占用，否则自动层会被一段已经结束的表演永久挡住。
          const holder = perfClaim.snapshot();
          // P0.2：自然结束（淡出走到 duration，不是被打断）
          try { perfLog.noteEnd({ endedBy: 'natural', clipId: perfFrame.key, actualMs: Math.round(Number(perfFrame.t) * 1000) }); } catch (e) { /* ignore */ }
          performer.stop('natural');
          // P2b：交还走统一出口（scheduler 开时 finish 会顺手拉起队列里的下一条）
          if (holder.owner === 'v2' || holder.owner === 'manual') endClaim(holder.owner, holder.token, 'natural');
        }
      }
      // 表情/随机表情的所有权：表演在场时归表演（外部换脸会被 renderer 拒绝），
      // 一退出就交还并记下时刻 —— 演完 25 秒内不贴待机随机表情，避免「刚演完就变脸」。
      if (performer.active) {
        renderer.expressionOwner = 'performance';
      } else {
        // performer 已经不在演了（手动 stop / 被顶掉），但 claim 可能还挂在 v2/manual：
        // 兜底交还（scenes/clip 的占用由各自的定时器/播放器释放）。
        const holder = perfClaim.snapshot();
        if (holder.owner === 'v2' || holder.owner === 'manual') endClaim(holder.owner, holder.token, 'released');
        // 表演结束：脸集合清空（渲染层会用 0.22s 淡出，不会硬切回情绪脸）
        if (typeof renderer.setPerformanceFaces === 'function') renderer.setPerformanceFaces([]);
        if (renderer.expressionOwner === 'performance') {
          renderer.expressionOwner = '';
          renderer.lastPerformanceEndAt = nowPerf;
        }
      }
    } catch (e) { /* 表演异常不影响主渲染 */ }
    // v1（情绪微动作）与 v2（长表演）的加法偏置合流：同一参数相加，
    // 都是「在待机/物理之上再动一点」的语义，不会互相覆盖。
    if (perfFrame && perfFrame.additive) {
      const akeys = Object.keys(perfFrame.additive);
      if (akeys.length) {
        choreoFrame = choreoFrame || {};
        for (let i = 0; i < akeys.length; i += 1) {
          const k = akeys[i];
          choreoFrame[k] = (choreoFrame[k] || 0) + perfFrame.additive[k];
        }
      }
    }
    let __dt = Math.max(0.001, dt);
    // 眼神：编舞一旦接管眼球，这一帧就不让 GazeFollow 写（它只负责「没人演的时候跟鼠标」）。
    // ⚠ 2026-11-15 真机实测的架构矛盾：GazeFollow 是**无条件覆盖** ParamEyeBallX/Y，
    //   而编舞（v1 加法 / v2 覆盖）也在写同一对参数 —— 结果整场表演眼球恒等于鼠标偏移
    //   （实测 0.4664 一动不动，「看向左侧」完全没发生）。
    const eyesOwnedByChoreo = !!(
      (choreoFrame && ('ParamEyeBallX' in choreoFrame || 'ParamEyeBallY' in choreoFrame))
      || (perfFrame && perfFrame.override
        && ('ParamEyeBallX' in perfFrame.override || 'ParamEyeBallY' in perfFrame.override))
    );
    // 2026-11-21 P1：眼神偏移必须在 updateView **之前**取样，作为 view.gaze 交给渲染器
    // 在物理/顶点重算前提交。旧实现在 updateView 之后 apply()：updateView 开头用 defaults
    // 重置参数、结尾才 _model.update()，写在后面既不参与本帧重算，下一帧又被清掉 →
    // ParamEyeBallX/Y、AngleX/Y 从来没有在物理/顶点前存在过（「眼神从不进入画面」）。
    let gazeFrame = null;
    if (!eyesOwnedByChoreo) {
      try { gazeFrame = (state.gaze || (state.gaze = new GazeFollow(renderer))).prepare(); } catch (e) {}
    }
    try {
      renderer.updateView({
        state: state.speaking ? 'speaking' : 'idle',
        expression: { emotion: faceEmotion, intensity: faceStrength, delivery: '', gesture: state.gesture },
        mouth: state.mouthSmooth,
        choreo: choreoFrame,
        choreoOverride: perfFrame ? perfFrame.override : null,
        choreoOverrideW: perfFrame ? perfFrame.overrideW : 0,
        gaze: gazeFrame,
        perfCommit: state.perfCommit,
      }, state.speaking ? 'speaking' : 'idle', false);
    } catch (error) {
      if (!errors.includes(String(error))) { errors.push(String(error)); console.error('[petbody] frame', error); }
    }
  }

  // 资产开关和它们配套的动作：光扳参数会「手抬不起来」「尾巴硬邦邦」，
// 必须同时播一下为这个资产写的切换动作。
const COSTUME_MOTION = {
  竖食指开: '竖手指切出来动画',
  竖食指关: '竖手指切回默认',
  // 脱鞋在 rig 里是一段专门的动作（“脱捕”），光扳 Clothes4 会变成鞋凭空消失
  脱鞋: '脱捕',
};
const COSTUME_MOTION_BACK = {
  竖食指开: '竖手指切回默认',
};


// ── 演出编排 ────────────────────────────────────────────────────────────
// 有 15 个动作、11 种情绪、21 个换装，但对外只有一个「随机换个动作」。
// 这里把它们串成有开头有结尾的小段子 —— 陪伴体真正好玩的地方在这儿。
// 每一步：{ at: 毫秒偏移, emotion, motion, costume:[名字,开关], hint: 字幕 }
const SCENES = {
  打招呼: [
    { at: 0, emotion: 'happy', motion: 'wave', hint: '哟，来了。' },
    { at: 1400, emotion: 'smug', motion: 'hands_on_chest' },
  ],
  撒娇: [
    { at: 0, emotion: 'shy', motion: 'tilt_head', costume: ['兔牙', true], hint: '……你就不能多陪我一会儿嘛。' },
    { at: 1600, emotion: 'shy', motion: 'lean_forward' },
    { at: 3200, emotion: 'happy', costume: ['兔牙', false] },
  ],
  生气: [
    { at: 0, emotion: 'angry', motion: 'angry', hint: '哼，你自己玩去吧。' },
    { at: 1200, emotion: 'angry', motion: 'shake_head' },
    { at: 2600, emotion: 'aggrieved', motion: 'tilt_head' },
  ],
  难过: [
    { at: 0, emotion: 'sad', motion: 'tilt_head', hint: '……算了，没事。' },
    { at: 1800, emotion: 'sad', costume: ['尾巴开关', false] },
    { at: 3600, emotion: 'aggrieved', costume: ['尾巴开关', true] },
  ],
  得意: [
    { at: 0, emotion: 'smug', motion: 'raise_your_hands', costume: ['黑框眼镜', true], hint: '怎么样，服不服。' },
    { at: 1600, emotion: 'smug', motion: 'laugh' },
    { at: 3200, emotion: 'happy', costume: ['黑框眼镜', false] },
  ],
  伸懒腰: [
    { at: 0, emotion: 'sleepy', motion: 'stretch', sfx: '02', hint: '唔……几点了。' },
    { at: 1800, emotion: 'bored', motion: 'shrug' },
    { at: 3200, emotion: 'neutral', motion: 'nod_head' },
  ],
  鼓掌: [
    { at: 0, emotion: 'happy', motion: 'clap', sfx: '07', hint: '好耶！' },
    { at: 1200, emotion: 'happy', motion: 'clap' },
    { at: 2400, emotion: 'smug', motion: 'raise_your_hands' },
  ],
  想事情: [
    { at: 0, emotion: 'bored', motion: 'thinking', sfx: '01', hint: '嗯……让我想想。' },
    { at: 2000, emotion: 'surprise', motion: 'nod_head' },
    { at: 3400, emotion: 'smug', motion: 'point' },
  ],
  点头: [
    { at: 0, emotion: 'neutral', motion: 'nod_head', hint: '嗯，知道了。' },
    { at: 1000, emotion: 'happy', motion: 'nod_head' },
  ],
  晚安: [
    { at: 0, emotion: 'sleepy', motion: 'bow', hint: '睡了，别熬夜。' },
    { at: 2000, emotion: 'sleepy', motion: 'shake_head', costume: ['脱鞋', true] },
    { at: 3600, emotion: 'sleepy', costume: ['脱鞋', false] },
  ],
  鞠躬: [
    { at: 0, emotion: 'happy', motion: 'bow', hint: '多谢款待！' },
    { at: 1800, emotion: 'smug', motion: 'hands_on_chest' },
  ],
  指一指: [
    { at: 0, emotion: 'surprise', motion: 'point', hint: '诶，那边！' },
    { at: 1600, emotion: 'tease', motion: 'laugh' },
  ],
};
const api = {
    renderer,
    errors,
    async load() {
      await renderer.load();
      renderer.setFraming(options.framing === 'full' ? 'full' : 'half');
      renderer.setAutomaticPolicy({ modelId: 'jellyfish', revision: 1, enabledIds: AUTO });
      try { initEmotionLayer(); } catch (error) { console.error('[petbody] 情绪层初始化失败', error); }
      running = true; last = performance.now();
      requestAnimationFrame(frame);
      return { drawables: renderer._model ? renderer._model.getDrawableCount() : 0, mask: renderer.maskConfig };
    },
    dispose() {
      running = false;
      try { clearInterval(emotion.subtitleTimer); clearTimeout(emotion.subtitleFlush); clearTimeout(emotion.hoverTimer); clearTimeout(emotion.bubbleTimer); } catch (e) {}
      // 2026-11-21 P2：交互监听与 FACS 片段 interval 必须一起清 ——
      // 旧版只清 canvas.__petEmotionBound 以外的定时器，监听器还挂在 canvas 上；
      // 切 VRM/MMD 再回 petbody 时标记为 true，bindEmotionInteraction 直接 return，
      // 交互永久不再驱动情绪。FACS 片段的 50ms interval 也会在 dispose 后继续跑。
      try { emotion.canvasBinding && emotion.canvasBinding.dispose(); } catch (e) {}
      emotion.canvasBinding = null;
      try { emotion.facsClips && emotion.facsClips.stop && emotion.facsClips.stop(); } catch (e) {}
      emotion.facsClips = null;
      // P1：dispose 时把仲裁占用全部交还，避免热重载后旧 claim 挡住新实例。
      // P2b：调度器先 reset（清队列/待启动表），再交还 arbiter 的四个 owner。
      try { if (perfSched) perfSched.reset(); } catch (e) { /* ignore */ }
      schedPending.clear();
      // P3a：节目单的在途循环要一起掐掉，否则 dispose 后还会 await 然后写参数
      try { if (programRunner) programRunner.reset(); } catch (e) { /* ignore */ }
      try { perfArbiter.end('clip'); perfArbiter.end('v2'); perfArbiter.end('manual'); perfArbiter.end('scenes'); } catch (e) { /* ignore */ }
      try { emotion.bubbleEl && emotion.bubbleEl.remove(); } catch (e) {}
      emotion.bubbleEl = null;
      emotion.engine = null;
      emotion.perf = null;
      try { ui?.dispose?.(); } catch (error) { /* ignore */ }
      ui = null;
      try { renderer.dispose && renderer.dispose(); } catch (e) {}
    },
    /** 把面板 / 大字幕挂到宿主页容器里；重复调用会复用同一个实例。 */
    mountUi(container, hooks = {}) {
      if (ui) { try { ui.dispose(); } catch (error) { /* ignore */ } ui = null; }
      ui = createPetBodyUi({ body: api, container, hooks });
      return ui;
    },
    getUi() { return ui; },
    /** C-1b：只写盘、不改渲染（桥在切完 exp3 预设后调它） */
    persistEmotion(label, strength) { try { scheduleEmotionPersist(label, strength); return true; } catch (e) { return false; } },
    setEmotion(name, strength) {
      state.emotion = String(name || 'neutral');
      // 六情绪中文名 / 英文 id 都认（演出编排里写英文）
      const key = normalizeEmotionName(name);
      // 记给 PAD 表情层（状态总线）：key 缺省不覆盖上一次的有效情绪
      if (key) { state.emotionKey = key; state.emotionStrength = Number.isFinite(Number(strength)) && Number(strength) > 0 ? Math.min(1.5, Number(strength)) : 0.9; state.emotionAt = performance.now(); }
      try {
        const str = Number.isFinite(Number(strength)) && Number(strength) > 0 ? Math.min(1.5, Number(strength)) : 0.9;
        if (key && emotion.engine) emotion.engine.feed({ kind: 'emotion', emotion: key, strength: str, now: performance.now() });
        else if (emotion.engine) emotion.engine.feed({ text: String(name || ''), kind: 'llm' });
      } catch (e) {}
      // C-1b：情绪变了就（去抖 2.5s）写盘，重启后可恢复
      if (key) scheduleEmotionPersist(key, state.emotionStrength);
    },
    // 心气 → 表情基线偏置（驱动层 moodStore 变化时推过来；PAD 总线的表情半边）
    setMood(m) { state.affectMood = Math.max(-1, Math.min(1, Number(m) || 0)); return state.affectMood; },
    feedText(text, kind) {
      let ok = false;
      try { ok = emotion.engine ? emotion.engine.feed({ text: String(text || ''), kind: kind || 'llm' }) : false; } catch (e) { ok = false; }
      semanticFallback(String(text || ''));   // 规则没命中时由语义服务兜底（异步、不阻塞）
      // P0：会话统计（导演强度曲线用）—— 用户每说一句算一轮，并刷新「最近主动交互」
      try { perfSession.turns = (Number(perfSession.turns) || 0) + 1; perfSession.userActionAt = Date.now(); perfSession.lastTextAt = perfSession.userActionAt; } catch (e) { /* ignore */ }
      try { perfLog.noteUserInput(); } catch (e) { /* 日志失败不影响对话 */ }
      // P3a：用户开口 = 节目单的「下一 relax 点停」信号（不硬切，等这句台词说完）
      try { if (programRunner) programRunner.notifyUserInput(); } catch (e) { /* 没在演就算了 */ }
      return ok;
    },
    /** 直接喂一个情绪键（不走关键词）：给插件/语义兜底用 */
    feedEmotion(emotionKey, strength) {
      try {
        const key = String(emotionKey || '').trim();
        if (!key || !emotion.engine) return false;
        emotion.engine.feed({ kind: 'emotion', emotion: key, strength: Math.max(0, Math.min(1, Number(strength) || 0.6)), now: performance.now() });
        return true;
      } catch (e) { return false; }
    },
    /** 语义兜底的观测：调用/喂入/跳过次数 + 最近一次结果 */
    semanticStats() {
      return { enabled: !(typeof window !== 'undefined' && window.__petSemantic === false), calls: SEM.calls, fed: SEM.fed, skipped: SEM.skipped, last: SEM.last };
    },
    feedEvent(name, meta) { return feedEmotionEvent(String(name || ''), meta); },
    /** 交互事件审计：没被引擎规则命中的次数 / 最近一次 / 每个名字的次数 */
    eventStats() {
      let unknown = {};
      try { unknown = emotion.engine ? emotion.engine.snapshot().unknownEventCounts || {} : {}; } catch (e) {}
      return {
        misses: Number(emotion.eventMiss) || 0,
        lastMiss: emotion.lastEventMiss || null,
        unknown,
      };
    },
    emotionSnapshot() { try { return emotion.engine ? emotion.engine.snapshot() : null; } catch (e) { return null; } },
    // perf 表情层：快照/覆盖率报告/语音重点注入/模式切换（perf ⇄ legacy 热切）
    perfSnapshot() { try { return emotion.perf ? emotion.perf.snapshot() : null; } catch (e) { return null; } },
    perfReport() {
      try {
        const base = emotion.perf ? emotion.perf.report() : null;
        if (!base) return null;
        // P0-1：把「参数权威表校验」一并暴露，/eval 可直接看
        return Object.assign({}, base, { inventory: state.inventoryCheck || null });
      } catch (e) { return null; }
    },
    perfSpeak(text, durationMs) {
      try { return emotion.perf ? emotion.perf.speak(String(text || ''), Number(durationMs) || 0) : []; } catch (e) { return []; }
    },
    setPerfMode(mode) {
      const next = String(mode || '').trim();
      if (next === 'perf' || next === 'legacy') emotion.perfMode = next;
      return emotion.perfMode;
    },
    setMouth(value) {
      const v = Math.max(0, Math.min(1, Number(value) || 0));
      state.mouth = v; state.lastMouthAt = performance.now();
      state.speaking = v > 0.02;
    },
    // ── 换装 ────────────────────────────────────────────────────────────
  // 和情绪/表情完全分开：表情会自己回落，资产得一直穿着。
  // 眼神：x/y 是归一化方向（-1 左，+1 右；-1 上，+1 下），由宿主的全局光标位置算出来。
  // 调试用：看一眼内部数值对不对（体检和自测都靠它）
  gazeInfo() {
    const g = (state.gaze || (state.gaze = new GazeFollow(renderer)));
    return g.debugState();
  },

  // setGaze(x, y, holdMs)：兼容旧契约（doctor/驱动都在调）。x/y 传 null 表示鼠标离开。
  // holdMs 不再需要——离开宽限与回中由 GazeFollow 处理（1.5s 宽限 + 0.6s 回中）。
  setGaze(x, y, holdMs) {
    const g = (state.gaze || (state.gaze = new GazeFollow(renderer)));
    const nx = (x === null || x === undefined || x === '') ? null : Number(x);
    const ny = (y === null || y === undefined || y === '') ? null : Number(y);
    g.setPointer(Number.isFinite(nx) ? nx : null, Number.isFinite(ny) ? ny : null);
    return true;
  },
  // 游戏自动省电（2026-11-09）：主进程检测到前台是游戏时传 true，
  // 待机降到每 3 帧重算，把 CPU/GPU 让给游戏；不玩游戏时保持满帧不卡。
  setPowerSave(on) {
    try { renderer.setPowerSave(on === true); return true; } catch (e) { return false; }
  },
  powerSaveState() {
    return { auto: renderer._autoPowerSave === true, fixed: renderer.options?.powerSave === true };
  },

  /**
   * 拖动冻结的客观计数（2026-11-21 拖动性能优化）。
   * 冻结生效时每帧 +1；拖动前后差值 > 0 说明冻结真的在跑（不是只加了个判断没人走）。
   * 读法：window.petBody.dragFreezeState()
   */
  dragFreezeState() {
    let dragging = false;
    try { dragging = !!(window.__pbDragging && Date.now() - (window.__pbDraggingAt || 0) < 1500); } catch (e) { /* ignore */ }
    return { frozenFrames: state.dragFrozenFrames || 0, renderedFrames: state.renderedFrames || 0, dragging };
  },

  /**
   * 命中测试：窗口 CSS 坐标是否落在她身上（供 ui-controller 的鼠标穿透判定用）。
   * 透明区域返回 false → 宿主把窗口切成穿透 → 用户能点到她旁边的桌面/其他窗口。
   */
  hitTest(cssX, cssY) {
    try {
      return !!(renderer && typeof renderer.hitTest === 'function' && renderer.hitTest(cssX, cssY));
    } catch (e) {
      return false;
    }
  },

  setCostume(name, on) {
    try {
      // 换装的真通路是 ui-controller 暴露的 window.__petAssets（构建期资产数据 + 钉 defaults）。
      // 渲染层那个 catalog 是上一轮的实现，加法图层已停用，留着只作兜底。
      const api = (typeof window !== 'undefined') && window.__petAssets;
      if (api && typeof api.apply === 'function') {
        const done = api.apply(String(name), on !== false);
        const motion = COSTUME_MOTION[String(name)];
        if (done && on !== false && motion) { try { renderer.playAction && renderer.playAction(motion); } catch (e) {} }
        return !!done;
      }
      const ok = renderer.setCostume ? renderer.setCostume(String(name), on !== false) : false;
      if (ok) {
        // 有些资产配了专属动作（竖手指要抬手，狗尾草要摇），顺手播一下才像真的换上了。
        const motion = COSTUME_MOTION[String(name)];
        if (on !== false && motion) { try { renderer.playAction && renderer.playAction(motion); } catch (e) {} }
        const back = COSTUME_MOTION_BACK[String(name)];
        if (on === false && back) { try { renderer.playAction && renderer.playAction(back); } catch (e) {} }
      }
      return ok;
    } catch (e) { return false; }
  },
  // 编舞 v1：开关（托盘/配置调用）。关掉时立刻清轨道，不留残值。
  setChoreography(on) {
    const v = on === true;
    try { if (typeof window !== 'undefined') window.__petChoreoOn = v; } catch (e) { /* ignore */ }
    if (!v) choreo.perf = null;
    if (typeof window !== 'undefined') {
      window.__choreoState = { on: v, active: !!choreo.perf, name: choreo.perf ? choreo.perf.name : '', at: choreo.startedAt };
    }
    return v;
  },
  getChoreography() {
    const on = (typeof window !== 'undefined') && window.__petChoreoOn === true;
    return { on, active: !!choreo.perf, name: choreo.perf ? choreo.perf.name : '' };
  },
  // 演一段：按时间线串情绪 + 动作 + 换装。同名场景重复调用会打断上一段。
  perform(name) {
    const steps = SCENES[String(name)];
    if (!steps || !steps.length) return false;
    // P1：SCENES 是显式手动（用户/托盘点名），优先级最高：先拿占用（可顶掉 clip/v2），
    // 拿不到只可能是另一个显式手动正在跑 —— 那也按「后一次调用替换前一次」处理。
    const sceneDuration = steps.reduce((max, step) => Math.max(max, Number(step.at) || 0), 0) + 3000;
    const sceneKey = 'scene:' + String(name);
    // P2b：调度器路径 —— kind=atomic（3–4s 短场景不可被自动层打断），preempt=true（显式手动）。
    // 返回 preempting 时先不排 setTimeout：等收势结束的 'start' 事件再开演。
    const sched = ensureScheduler();
    if (sched) {
      const req = sched.request({
        owner: 'scenes', key: sceneKey, kind: 'atomic', maxMs: sceneDuration, preempt: true,
      });
      if (!req.ok) {
        perfClaim.recordYield('scenes', { reason: req.reason || 'busy', heldBy: perfClaim.snapshot().owner, key: String(name) });
        return false;
      }
      if (req.status === 'started') return beginScenePlayback(name, steps, sceneDuration, req.token);
      schedPending.set(req.token, {
        kind: 'scenes', owner: 'scenes', key: sceneKey,
        apply: () => beginScenePlayback(name, steps, sceneDuration, req.token),
      });
      return steps.length;
    }
    // ── 旧路径（scheduler 关）：逐位不变 ──────────────────────────────────
    const admitted = perfArbiter.begin('scenes', {
      key: sceneKey, title: String(name), durationMs: sceneDuration, preempt: true,
    });
    if (!admitted.ok) {
      perfClaim.recordYield('scenes', { reason: 'busy', heldBy: admitted.holder, key: String(name) });
      return false;
    }
    if (admitted.preempted === 'clip') {
      try { if (emotion.facsClips && emotion.facsClips.stop) emotion.facsClips.stop(); } catch (e) { /* ignore */ }
    } else if (admitted.preempted && admitted.preempted !== 'micro') {
      // P0.2：被顶掉的长演出一律记 interrupt（v2 没有收势，硬切也是打断）
      try { if (performer.key) perfLog.noteEnd({ endedBy: 'interrupt', clipId: performer.key }); } catch (e) { /* ignore */ }
      try { performer.stop('interrupt'); } catch (e) { /* ignore */ }
    }
    try { if (api._sceneTimers) for (const id of api._sceneTimers) clearTimeout(id); } catch (e) {}
    api._sceneTimers = [];
    for (const step of steps) {
      const id = setTimeout(() => {
        try { if (step.emotion) api.setEmotion(step.emotion); } catch (e) {}
        try { if (step.motion) api.playMotion(step.motion); } catch (e) {}
        try { if (step.costume) api.setCostume(step.costume[0], step.costume[1]); } catch (e) {}
        // 音效不在渲染层播：它要经插件管理器（sfx 插件才有 SFX 目录与编码处理）。
        // 这里只把需求抛出去，由宿主的 driver 接住。
        try {
          if (step.sfx && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('petbody:sfx', { detail: { id: String(step.sfx) } }));
          }
        } catch (e) {}
      }, step.at || 0);
      api._sceneTimers.push(id);
    }
    // 场景演完交还占用；token 确保不会误杀之后新起的另一段场景/手动演出。
    api._sceneTimers.push(setTimeout(() => { try { endClaim('scenes', admitted.token, 'natural'); } catch (e) {} }, sceneDuration));
    return steps.length;
  },
  listScenes() { return Object.keys(SCENES); },

  // ── 表演库 v2（2026-11-15，15 段长表演）─────────────────────────────────
  // 与 SCENES 的区别：SCENES 是 3–4 秒的「情绪+动作词典+换装」粗编排；
  // 表演库是 19–38 秒的参数级演出（眼球/眉/嘴/角度逐帧轨道 + 原生手势 + 真表情）。
  listPerformances() { return performer.list(); },

  // ── 节目单（P3a，ADR-015 §3.5）─────────────────────────────────────────
  // 契约：listPrograms() 给 UI 列表；playProgram(id) 返回 {ok,reason,...}；
  // stopProgram() 立即收势（400ms）。三种拒绝理由必须可区分：disabled / scheduler-off / budget。
  listPrograms() {
    const info = loadProgramsDoc();
    const cfg = programCfg();
    return {
      enabled: cfg.enabled === true,
      scheduler: schedulerEnabled(),
      maxPerDay: programMaxPerDay(),
      budgetLeft: programBudgetApi.left(),
      dir: info.dir,
      error: info.error,
      items: info.list.map((p) => ({
        id: String(p.id),
        title: String(p.title || p.id),
        beats: (Array.isArray(p.beats) ? p.beats : []).map((b) => ({
          seg: String((b && b.seg) || ''),
          maxMs: Number((b && b.maxMs) || 0),
          line: String((b && b.line) || ''),
          sfx: String((b && b.sfx) || ''),
        })),
      })),
    };
  },
  playProgram(programId) {
    const cfg = programCfg();
    if (cfg.enabled !== true) return { ok: false, reason: 'disabled' };
    if (!schedulerEnabled()) return { ok: false, reason: 'scheduler-off' };
    const runner = ensureProgramRunner();
    if (!runner) return { ok: false, reason: 'scheduler-off' };
    const res = runner.start(String(programId == null ? '' : programId));
    if (!res.ok) {
      try {
        perfClaim.recordYield('program', {
          reason: res.reason || 'busy',
          heldBy: (perfClaim.snapshot() || {}).owner,
          key: String(programId || ''),
        });
      } catch (e) { /* ignore */ }
    }
    return res;
  },
  stopProgram() {
    if (!programRunner) return { ok: false, reason: 'idle' };
    try { return programRunner.stop('user'); } catch (e) { return { ok: false, reason: 'error' }; }
  },

  playPerformance(key, opts) {
    // P1：显式手动，preempt=true（优先级最高，可顶掉片段/自动长表演）。
    const result = requestPerformance(key, performance.now(), { owner: 'manual', preempt: true, performer: opts || {} });
    // 手动演过就同步记账：否则刚手动演完 04，下一句情绪对上又会自动演同一段
    if (result.ok) {
      try { perfAuto.note(String(key), performance.now()); } catch (e) { /* ignore */ }
      try { renderer.stopAction && renderer.stopAction(0.2); } catch (e) { /* ignore */ }
    }
    return result.ok === true;
  },
  stopPerformance() {
    // P0.2：显式停止 = 打断（不是自然结束）
    try { if (performer.key) perfLog.noteEnd({ endedBy: 'interrupt', clipId: performer.key }); } catch (e) { /* ignore */ }
    performer.stop('interrupt');
    // P3a：节目单也一起停（用户点「停」不该只停 v2，留她在演节目单）
    try { if (programRunner) programRunner.stop('user'); } catch (e) { /* ignore */ }
    // P2b：队列里/待启动表里属于 v2/manual 的请求一并取消，否则停下 400ms 后又自己演起来
    try { cancelSchedPending((o) => o === 'v2' || o === 'manual'); } catch (e) { /* ignore */ }
    releasePerformance('v2');
    releasePerformance('manual');
    return true;
  },
  // 语义兜底的落账（B6）：calls/fed 就是 §68 说的兜底命中率分子分母。
  semanticStats() {
    return { ...SEM, hitRate: SEM.calls ? Math.round((SEM.fed / SEM.calls) * 1000) / 1000 : null };
  },
  // 参数所有权护栏的读口（§69 B3）：8004 /eval 与 doctor 靠它判断「有没有两层在抢参数」。
  // 返回的是**去重账本**（每对 (参数, owner 组合) 只出现一次），不是每帧刷屏的流水。
  paramOwnershipStats() {
    try {
      const ledger = renderer && renderer._conflictLedger;
      const stats = ledger ? ledger.stats() : null;
      return {
        ...(stats || { unique: 0, warnings: 0, dropped: 0, recent: [] }),
        conflictFrames: Number(renderer && renderer._conflictFrames) || 0,
        composeFrames: Number(renderer && renderer._composeFrames) || 0,
        perfOverreach: Array.from(perfOwnershipSeen),
        // P2：资产 pin 所有权 —— 跳过的次数与当前 pin 的参数
        pinnedParams: getPinnedAssetParams(renderer) ? Array.from(getPinnedAssetParams(renderer)).sort() : [],
        pinnedSkips: Number(emotion.perfPinSkips) || 0,
        pinnedSkippedParams: emotion.perfPinSkipSeen ? Array.from(emotion.perfPinSkipSeen) : [],
        externalPinDetected: Number(emotion.externalPinDetected) || 0,
        externalPinReleased: Number(emotion.externalPinReleased) || 0,
        perfOwnershipAudit: emotion.ownershipAudit || null,
        // P0（2026-11-25）：v2 长表演的写入集断言 + exp3 锁被 pin 跳过的次数。
        // 以前这两件事完全在断言之外（「所有权黑洞」），doctor 只能看到全绿。
        v2OwnershipAudit: emotion.v2OwnershipAudit || null,
        v2FacePinSkips: Number(emotion.v2FacePinSkips) || 0,
        v2FacePinSkipped: emotion.v2FacePinSeen ? Array.from(emotion.v2FacePinSeen) : [],
      };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  },
  performanceStatus() {
    // P2（2026-11-21）：旧实现只返回 active/key/title/auto/faces，渲染层读
    // st.t / st.duration 永远是 0/0（进度条死）。现在 t/duration 由共享会话给出：
    //   · v2/manual/scenes：会话在 begin 时记下 durationMs，t = 已演秒数；
    //   · clip：用片段播放器的 elapsedMs/durationMs（50ms tick，更实时）。
    let clipStatus = null;
    try {
      clipStatus = emotion.facsClips && typeof emotion.facsClips.status === 'function'
        ? emotion.facsClips.status()
        : null;
    } catch (e) { clipStatus = null; }
    const status = buildPerformanceStatus({
      session: perfArbiter.session.status(),
      clip: clipStatus,
      performerActive: performer.active === true,
      key: performer.key,
      title: performer.title,
      faces: renderer && renderer.perfFaceWeights ? renderer.perfFaceWeights.keys() : [],
      auto: perfAuto.snapshot(),
      claim: perfClaim.snapshot(),
    });
    // 情绪增益的生效证据（P2）：value = 当前值，applied = setEmotionGain 被调用次数，
    // perfApplied = 其中真正推进 perf 引擎的次数。
    status.gain = {
      value: Number.isFinite(Number(options.emotionGain)) ? Number(options.emotionGain) : 1,
      applied: Number(emotion.gainApplied) || 0,
      perfApplied: Number(emotion.gainAppliedPerf) || 0,
    };
    // 2026-11-25 P0「情绪增益滑杆死契约」修复：控制面板旧版本读 status.options.emotionGain，
    // 而 buildPerformanceStatus 从来不返回 options → 滑杆恒被判「未接线」禁用。
    // 现在两套都给：新 UI 读 status.gain.value（entry 一直有），旧 UI 读 options（补上）。
    status.options = Object.assign({}, status.options || {}, { emotionGain: status.gain.value });
    return status;
  },
  /** P0.5：performance.* 配置下发（driver 在皮套初始化后调一次；缺键走默认） */
  setPerformanceConfig(raw) {
    try { return applyPerfConfig(raw); } catch (e) { return perfDirector.cfg; }
  },
  /**
   * P0.5 只读快照（8004 /eval 与控制中心用）：
   * presence / director 最近决策 / clip 池统计 / 预算余额 / sync 覆盖（P0 恒 0）。
   * 只读内存，不做 I/O，可随时调。
   */
  performanceDebug() {
    const at = Date.now();
    let presence = null;
    try { presence = readPresence(globalThis, at); } catch (e) { presence = null; }
    let sum = null;
    try { sum = perfLog.summary(at); } catch (e) { sum = null; }
    let poolStats = null;
    try {
      poolStats = emotion.facsClips && typeof emotion.facsClips.poolStats === 'function'
        ? emotion.facsClips.poolStats(at)
        : null;
    } catch (e) { poolStats = null; }
    const cfg = perfDirector.cfg || resolvePerformanceConfig(null);
    const dirCfg = cfg.director || PERFORMANCE_DEFAULTS.director;
    return {
      at,
      presence,
      director: {
        mode: dirCfg.enabled === true ? 'enforce' : (dirCfg.dry_run === true ? 'dryrun' : 'off'),
        config: dirCfg,
        lastDecision: perfDirector.lastDecision,
        lastAt: perfDirector.lastAt,
      },
      poolStats,
      budget: sum ? (() => {
        // 日预算/长段预算只算自动来源（手点不吃额度，见 directive.budgetsFromSummary）
        const autoPlays = Number.isFinite(Number(sum.autoPlaysToday)) ? sum.autoPlaysToday : sum.playsToday;
        const autoLong = Number.isFinite(Number(sum.autoLongToday)) ? sum.autoLongToday : sum.longToday;
        const auto10 = Number.isFinite(Number(sum.autoPlays10)) ? sum.autoPlays10 : sum.plays10;
        return {
          playsToday: sum.playsToday,
          longToday: sum.longToday,
          playsLast10Min: sum.plays10,
          requestsToday: sum.requestsToday,
          blockedToday: sum.blockedToday,
          // 分开暴露（24h 校准用）：手点/场景不进导演预算
          spentAuto: { plays: autoPlays, long: autoLong, last10: auto10 },
          spentManual: {
            plays: Number.isFinite(Number(sum.manualPlaysToday)) ? sum.manualPlaysToday : Math.max(0, sum.playsToday - autoPlays),
            long: Number.isFinite(Number(sum.manualLongToday)) ? sum.manualLongToday : Math.max(0, sum.longToday - autoLong),
          },
          left: {
            plays: Math.max(0, Number(dirCfg.max_plays_per_day) - autoPlays),
            long: Math.max(0, Number(dirCfg.max_long_per_day) - autoLong),
            last10: Math.max(0, Number(dirCfg.max_per_10min) - auto10),
          },
        };
      })() : null,
      // P1 待机层：状态/停留/幅度（只读内存；renderer 与本进程同一份状态）
      ambient: (() => {
        try {
          const snap = ambient.snapshot();
          // P1.5：证明偏置真的进了参数写入 —— offsets 是渲染器本帧加到各参数上的量
          // （归一化偏置 × 系数，已含 speaking 减半），不是「配置里说了什么」。
          const applied = renderer && renderer.ambientApplied;
          return {
            enabled: snap.enabled,
            scale: snap.scale,
            state: snap.state,
            dwellMs: snap.dwellMs,
            amp: state.ambient ? state.ambient.amp : null,
            action: snap.action,
            transitions: snap.transitions,
            intensity: snap.intensity,
            applied: Boolean(applied),
            offsets: applied ? applied.offsets : null,
            applyingWhileSpeaking: applied ? applied.speaking : null,
          };
        } catch (e) { return null; }
      })(),
      // P2b：sync 覆盖从 perf-sync.json 实读（P0/P1 时期这里诚实写 0；现在有产物了）。
      // 缺文件/坏 JSON → items=0 + error，调度器按「整段 atomic」退化（不假装有 relax 点）。
      syncCoverage: (() => {
        try {
          loadPerfSyncDoc();
          return { items: perfSyncInfo.items, loaded: perfSyncInfo.loaded, version: perfSyncInfo.version };
        } catch (e) {
          return { items: 0, loaded: 0, version: 0 };
        }
      })(),
      // P2b 调度器现场：开没开 / 当前 owner / 排队几条 / 最近的 yield 原因 / sync 覆盖
      scheduler: (() => {
        try {
          const enabled = schedulerEnabled();
          const st = perfSched ? perfSched.status() : null;
          return {
            enabled,
            mode: !enabled ? 'off' : (st ? (st.degraded ? 'degraded' : 'on') : 'cold'),
            current: st ? st.current : null,
            pending: st ? st.pending : null,
            queue: st ? st.queue : [],
            queueLength: st ? (st.queue || []).length : 0,
            yields: st ? st.yields : {},
            stats: st ? st.stats : null,
            lastEvent: schedLastEvent,
            syncCoverage: {
              items: perfSyncInfo.items,
              loaded: perfSyncInfo.loaded,
              version: perfSyncInfo.version,
              file: perfSyncInfo.file,
              error: perfSyncInfo.error,
            },
          };
        } catch (e) { return { enabled: false, mode: 'error', error: String((e && e.message) || e) }; }
      })(),
      claim: perfClaim.snapshot(),
      // P3a：节目单现场（enabled/active/programId/beatIdx/budgetLeft + 遥测计数）
      program: programDebugSnapshot(),
    };
  },
  // 调试/验收：强制走一次空闲通道（忽略「安静够不够」，rand 固定走日常段池）
  triggerIdlePerformance() {
    const now = performance.now();
    if (!perfArbiter.availableFor('v2')) {
      perfClaim.recordYield('v2', { reason: 'busy', heldBy: perfClaim.snapshot().owner, key: 'debug:idle' });
      return { play: false, reason: 'busy', heldBy: perfClaim.snapshot().owner };
    }
    const d = perfAuto.considerIdle({ now, idleMs: 60 * 60 * 1000, rand: 0, rand2: 0.5, intensity: 1 });
    if (d.play) {
      const started = requestPerformance(d.key, now, { owner: 'v2' });
      if (!started.ok) return Object.assign({}, d, { play: false, reason: started.reason || 'busy' });
    }
    return d;
  },
  // 自动触发的开关（默认开）。托盘/配置可关：关掉后只剩手动。
  setPerformanceAuto(on) {
    try { if (typeof window !== 'undefined') window.__petPerfAuto = on !== false; } catch (e) { return false; }
    return on !== false;
  },
  getPerformanceAuto() {
    return { on: (typeof window === 'undefined') || window.__petPerfAuto !== false, auto: perfAuto.snapshot() };
  },
  // 调试：重置冷却记账（验收连续试多段时用）
  resetPerformanceAuto() { perfAuto.reset(); return perfAuto.snapshot(); },
  // A/B：true = 角度直改 ParamAngle*（跟手、二级物理不动）；false = 走 Angle* 物理链（自然、有惯性）
  setChoreoAngleDirect(on) {
    try { renderer.choreoAngleDirect = on === true; } catch (e) { return false; }
    return renderer.choreoAngleDirect === true;
  },

  listCostumes() { try { return renderer.listCostumes ? renderer.listCostumes() : []; } catch (e) { return []; } },
  getActiveCostumes() { try { return renderer.getActiveCostumes ? renderer.getActiveCostumes() : []; } catch (e) { return []; } },
  resetCostumes() { try { return renderer.resetCostumes ? renderer.resetCostumes() : false; } catch (e) { return false; } },

  playMotion(name) { try { return renderer.playAction ? renderer.playAction(String(name)) : false; } catch (e) { return false; } },
    setWorkState(v) { try { return renderer.setWorkState ? renderer.setWorkState(String(v)) : false; } catch (e) { return false; } },
    // 表情强度实时切换（控制面板 / 托盘用）：0=面瘫 1=正常 1.5=夸张
    // P2（2026-11-21）：旧实现只写 options.emotionGain，legacy 路径消费、perf 路径不消费
    // → 面板滑块在 perf 模式下空转。现在同时推进 perf 引擎的 tuning，并计数。
    setEmotionGain(gain) {
      const value = Math.max(0, Math.min(2, Number(gain) || 0));
      options.emotionGain = value;
      emotion.gainApplied = (Number(emotion.gainApplied) || 0) + 1;
      emotion.lastGainRequestedAt = Date.now();
      let forwarded = false;
      try {
        if (emotion.perf && typeof emotion.perf.setEmotionGain === 'function') {
          emotion.perf.setEmotionGain(value);
          forwarded = Number(emotion.perf.emotionGain) === value;
        }
      } catch (e) { forwarded = false; }
      if (forwarded) emotion.gainAppliedPerf = (Number(emotion.gainAppliedPerf) || 0) + 1;
      // 只在值真的变化时打一行，避免拖滑块刷屏
      if (emotion.lastGainLogged !== value) {
        emotion.lastGainLogged = value;
        try { console.info('[petbody:perf] emotionGain=' + value + ' → perf=' + (forwarded ? 'on' : 'off')); } catch (e) { /* ignore */ }
      }
      return value;
    },
    asset(id, on) { return applyAsset(renderer, id, on); },
  // 档位直设（控制中心「装扮与形态」用）：setAssetValue('form-size', 'mid'|'big'|'small')；开关型传布尔
  setAssetValue(id, value) {
    try { return applyAssetValue(renderer, String(id), value); } catch (e) { return null; }
  },
    assets() { return getState(renderer); },
    assetList() { return listAssets(); },
    presets() { return listPresets(); },
    preset(id) { return applyPreset(renderer, id); },
    presetState() { try { return currentPreset(renderer); } catch (error) { return null; } },
    snapshot() {
      let perf = null;
      try { perf = emotion.perf ? emotion.perf.snapshot() : null; } catch (e) { perf = null; }
      return { ...state, perfMode: emotion.perfMode, perf, source: renderer.snapshot ? renderer.snapshot() : null };
    },
  };
  // C-1b：启动时读回情绪（延迟一点，等 8103 与渲染就绪）
  try { setTimeout(() => { restoreEmotion().catch(() => {}); }, 1800); } catch (e) { /* 非浏览器环境 */ }
  // 表演库调试入口（真机预览/验收用）。不接触发逻辑：托盘与工具面另外接，
  // 这里只保证「能在 DevTools / 遥控里点名演一段」，并且没配任何自动触发。
  try {
    if (typeof window !== 'undefined') {
      window.__petPerformance = {
        list: () => api.listPerformances(),
        play: (key, opts) => api.playPerformance(key, opts),
        stop: () => api.stopPerformance(),
        status: () => api.performanceStatus(),
        angleDirect: (on) => api.setChoreoAngleDirect(on),
        auto: (on) => (on === undefined ? api.getPerformanceAuto() : api.setPerformanceAuto(on)),
        resetAuto: () => api.resetPerformanceAuto(),
        // 验收：强制走一次空闲通道（不等待真实安静时长）
        idleTry: () => api.triggerIdlePerformance(),
        // P1：占用仲裁现场（owner/key/since + yield/conflict/preempt 计数）
        claim: () => perfClaim.snapshot(),
      };
    }
  } catch (e) { /* 非浏览器环境 */ }
  return api;
}

export const meta = { name: 'petbody', version: 2 };