// petbody-entry.mjs —— 把我们的身体渲染器打包成 my-neuro 页面可直接用的全局对象。
// 由 build-petbody.mjs 用 esbuild 打成 iife，暴露 window.PetBody。
// createPetBody 返回的 api 多了 mountUi(container, hooks)：宿主页 js/avatar/petbody/ui.js
// 用它把我们的面板/大字幕挂进 my-neuro，而不动它的渲染根。
import { JellyfishRenderer } from './cubism-renderer.mjs';
import { applyAsset, getState, listAssets, listPresets, applyPreset, currentPreset, applyAssetValue, getPinnedAssetParams } from './asset-toggles.mjs';
import { createPetBodyUi } from './ui/petbody-ui.mjs';
import { createEmotionEngine, blendParam, EMOTIONS, bindCanvasListeners } from './emotion-engine.mjs';
import { createPerfEngine, buildProfile, PROFILE_SPECS, EXTERNALLY_OWNED, EXTERNALLY_OWNED_PARAMS } from './perf/index.mjs';
import { selectPhysicsOutputTargets } from './perf/param-commit.mjs';
import { classifyParam } from './perf/physics-io.mjs';
import { findExternalOwnershipViolations } from './param-ownership-probe.mjs';
import { createPerformanceArbiter, buildPerformanceStatus } from './perf/performance-arbiter.mjs';
import { checkWriteSet, writePerfParams, detectExternalPins, SHARED_ASSET_PARAM_SET } from './perf/param-ownership.mjs';
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
    _tuneCache = { at: nowMs, value };
    return value;
  }
  // 自动触发器（2026-11-16）：情绪驱动的节流决策 + 冷却记账。决策逻辑在 choreo-auto.mjs。
  const perfAuto = createAutoTrigger({ tuningProvider: choreoTuning });
  // 空闲通道（v3）：多久没说话 + 上次评估时间。她安静站着时会自己练一段（05/06/07/08/01，稀有 13）。
  const perfIdle = { lastSpeakingAt: (typeof performance !== 'undefined' ? performance.now() : Date.now()), lastCheckAt: 0 };
  // 情绪到位通道（v3.1）：引擎算出的强情绪先暂存，等这句说完再演
  const perfEmo = { lastKey: '', lastAt: 0, pending: null, lastYieldAt: 0 };

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
  // 表演库元数据（时长/标题）：performer.list() 是唯一现成来源，缓存一次。
  const perfMetaByKey = new Map();
  function performanceMeta(key) {
    const k = String(key || '');
    if (!perfMetaByKey.size) {
      try { for (const item of performer.list()) perfMetaByKey.set(String(item.key), item); } catch (e) { /* ignore */ }
    }
    return perfMetaByKey.get(k) || null;
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
    if (!preempt && !perfArbiter.availableFor(owner)) {
      const holder = perfClaim.snapshot();
      perfClaim.recordYield(owner, { reason: 'busy', heldBy: holder.owner, key: key });
      return { ok: false, reason: 'busy', heldBy: holder.owner };
    }
    const durationMs = Number(meta.duration) > 0 ? Number(meta.duration) * 1000 : 0;
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
      if (holder.owner === owner) perfArbiter.end(owner, holder.token);
    } catch (e) { /* ignore */ }
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

    function stop() {
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      state.playing = false;
      state.clipId = null;
      // P1（2026-11-21）：片段停下就交还表演占用，否则 v2/自动层会被一个
      // 已经结束的片段永久挡住。
      try {
        if (state.claimToken) { perfArbiter.end('clip', state.claimToken); state.claimToken = ''; }
        else { perfArbiter.end('clip'); }
      } catch (e) { /* ignore */ }
      try { engine.setReaction(null); } catch (e) { /* 引擎不在也安全 */ }
      return status();
    }

    function play(idOrLabel, opts = {}) {
      const clip = loadClip(idOrLabel);
      if (!clip) return { ok: false, error: state.lastError || '片段不可用' };
      stop();
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
        try { performer.stop(); } catch (e) { /* ignore */ }
      } else if (admitted.preempted === 'scenes') {
        try {
          if (api && Array.isArray(api._sceneTimers)) {
            for (const id of api._sceneTimers) clearTimeout(id);
            api._sceneTimers = [];
          }
        } catch (e) { /* api 还没初始化 */ }
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
        if (res.done) stop();
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
        busy: ctx && ctx.busy,
        speaking: ctx && ctx.speaking,
        activity: ctx && ctx.activity,
      };
      if (!decision.clipId) {
        perfLog.noteDecision(Object.assign({ played: false, decision }, logCtx));
        return { ok: true, played: false, reason: decision.reason, detail: decision.detail || null };
      }
      const r = play(decision.clipId);
      perfLog.noteDecision(Object.assign({ played: r.ok === true, decision }, logCtx));
      if (r.ok) d.notePlayed(decision.clipId, Date.now());
      return {
        ok: true, played: r.ok === true,
        reason: r.ok ? 'ok' : (r.reason === 'busy' ? 'busy' : 'play-failed'),
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
    const violations = findExternalOwnershipViolations(accepted, EXTERNALLY_OWNED_PARAMS);
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
        let activity = '';
        try {
          const ua = globalThis.__userActivity;
          if (ua && ua.state === 'away') activity = 'away';
        } catch (e) { /* 读不到就不设 */ }
        let res = null;
        try {
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
          });
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
        let activity = '';
        try {
          const ua = globalThis.__userActivity;
          if (ua && ua.state === 'away') activity = 'away';
        } catch (e) { /* 读不到就不设 */ }
        let res = null;
        try {
          res = api.auto({ source: 'idle', emotion: 'neutral', intensity: 0.6, activity, speaking: false, busy: perfClaim.active && perfClaim.owner !== 'clip' });
        } catch (e) { /* 同上，绝不影响渲染 */ }
        const gap = Number(trig.idleGapMs) || 8 * 60 * 1000;
        trig.nextIdleAt = nowIdle + (res && res.reason === 'busy' ? 60000 : gap);
        trig.idleTries = (Number(trig.idleTries) || 0) + 1;
        if (res && res.played) trig.lastIdlePlayedAt = nowIdle;
      }
    }
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
        if (!claimFreeForV2) {
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
          if (!claimFreeForV2) {
            perfClaim.recordYield('v2', { reason: 'busy', heldBy: perfClaim.snapshot().owner, key: 'auto:idle' });
            if (typeof window !== 'undefined') window.__perfIdleState = { decision: { play: false, reason: 'busy' }, at: Date.now() };
          } else {
            const di = perfAuto.considerIdle({ now: nowIdle, idleMs: nowIdle - perfIdle.lastSpeakingAt });
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
      if (perfFrame) {
        // 表演层表情（v3）：把本帧所有该锁的脸交给渲染层按权重融合。
        // 旧实现只锁第一张（manualFace 单槽）→ 13 的「裙子+眼镜」、04 的「＞＜+脸红」会丢第二张。
        if (typeof renderer.setPerformanceFaces === 'function') {
          renderer.setPerformanceFaces(perfFrame.expressions || []);
        } else if (perfFrame.expression) {
          // 兜底旧渲染层
          renderer.manualFace = perfFrame.expression;
          renderer.manualFaceUntil = nowPerf + 600;
        }
        // 原生手势：动作 + 资产必须成对（2026-11-15 实测：光播 motion 只轻微调手臂，
        // 「竖食指」出现靠 Movement1/2/3 的图层切换）。资产走 window.__petAssets 全局，
        // 不直接引 api.setCostume —— frame 可能早于 api 定义执行（TDZ）。
        for (let i = 0; i < perfFrame.gestures.length; i += 1) {
          const g = perfFrame.gestures[i];
          try {
            const assetApi = (typeof window !== 'undefined') && window.__petAssets;
            if (g.asset && assetApi && typeof assetApi.apply === 'function') {
              assetApi.apply(g.asset, g.on === true);
            }
          } catch (e) { /* 资产切换失败不阻断动作 */ }
          try { renderer.playMotion(g.group, g.index); } catch (e) { /* 单次动作失败不阻断整段表演 */ }
        }
        if (perfFrame.done) {
          // P1：演完必须交还占用，否则自动层会被一段已经结束的表演永久挡住。
          const holder = perfClaim.snapshot();
          performer.stop();
          if (holder.owner === 'v2' || holder.owner === 'manual') perfArbiter.end(holder.owner, holder.token);
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
        if (holder.owner === 'v2' || holder.owner === 'manual') perfArbiter.end(holder.owner, holder.token);
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
      try { perfLog.noteUserInput(); } catch (e) { /* 日志失败不影响对话 */ }
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
    const admitted = perfArbiter.begin('scenes', {
      key: 'scene:' + String(name), title: String(name), durationMs: sceneDuration, preempt: true,
    });
    if (!admitted.ok) {
      perfClaim.recordYield('scenes', { reason: 'busy', heldBy: admitted.holder, key: String(name) });
      return false;
    }
    if (admitted.preempted === 'clip') {
      try { if (emotion.facsClips && emotion.facsClips.stop) emotion.facsClips.stop(); } catch (e) { /* ignore */ }
    } else if (admitted.preempted && admitted.preempted !== 'micro') {
      try { performer.stop(); } catch (e) { /* ignore */ }
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
    api._sceneTimers.push(setTimeout(() => { try { perfArbiter.end('scenes', admitted.token); } catch (e) {} }, sceneDuration));
    return steps.length;
  },
  listScenes() { return Object.keys(SCENES); },

  // ── 表演库 v2（2026-11-15，15 段长表演）─────────────────────────────────
  // 与 SCENES 的区别：SCENES 是 3–4 秒的「情绪+动作词典+换装」粗编排；
  // 表演库是 19–38 秒的参数级演出（眼球/眉/嘴/角度逐帧轨道 + 原生手势 + 真表情）。
  listPerformances() { return performer.list(); },
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
    performer.stop();
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
    return status;
  },
  // 调试/验收：强制走一次空闲通道（忽略「安静够不够」，rand 固定走日常段池）
  triggerIdlePerformance() {
    const now = performance.now();
    if (!perfArbiter.availableFor('v2')) {
      perfClaim.recordYield('v2', { reason: 'busy', heldBy: perfClaim.snapshot().owner, key: 'debug:idle' });
      return { play: false, reason: 'busy', heldBy: perfClaim.snapshot().owner };
    }
    const d = perfAuto.considerIdle({ now, idleMs: 60 * 60 * 1000, rand: 0, rand2: 0.5 });
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