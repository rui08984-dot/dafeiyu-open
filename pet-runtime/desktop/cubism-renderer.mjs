import { InteractionMotion } from './interaction-motion.mjs';
import { classifyParam, PHYSICS_BOTH } from './perf/physics-io.mjs';
import { applyGazeOffsets } from './perf/gaze-commit.mjs';
import { shouldRestackBlink, writesEyeOpen } from './perf/blink-stack.mjs';
import { applyAmbientOffsets, ambientOffsets, normalizeAmbientBias } from './perf/ambient-apply.mjs';
import { BodyDirector } from './body-director.mjs';
import { MotionDirector, listActions } from './motion-vocab.mjs';
import { normalizePresentationIntent } from '../contracts/presentation.ts';
import { ModelFeather } from './model-feather.mjs';
import { LAYER, evaluateFrameConflicts, createConflictLedger } from './param-ownership-probe.mjs';
import presetCatalog from './assets/jellyfish/presets.json';
// Application adapter over the official SDK; SDK owns deformation, physics, blending and WebGL rendering.
import { CubismFramework } from './vendor/cubism/Framework/src/live2dcubismframework.ts';
import { CubismUserModel } from './vendor/cubism/Framework/src/model/cubismusermodel.ts';
import { CubismModelSettingJson } from './vendor/cubism/Framework/src/cubismmodelsettingjson.ts';
import { CubismMatrix44 } from './vendor/cubism/Framework/src/math/cubismmatrix44.ts';
import { CubismEyeBlink } from './vendor/cubism/Framework/src/effect/cubismeyeblink.ts';
import { CubismExpressionMotionManager } from './vendor/cubism/Framework/src/motion/cubismexpressionmotionmanager.ts';
import { CubismShaderManager_WebGL } from './vendor/cubism/Framework/src/rendering/cubismshader_webgl.ts';


const presets = new Map(presetCatalog.items.map(item => [item.id, item]));
const automaticItems = presetCatalog.items.filter(item => item.availability === 'automatic');
const faces = new Map(automaticItems.flatMap(item => (item.emotions ?? []).map(key => [key, item])));
const gestures = new Map(automaticItems.flatMap(item => (item.gestures ?? []).map(key => [key, item])));
const headParameters = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ'];
const interactionParameters = [...headParameters, 'ParamBodyAngleX', 'ParamEyeBallX', 'ParamEyeBallY'];
const webglOwners = new Set();
/** 说话时归语音的参数：表演表情不许抢嘴型 */
const SPEECH_OWNED = new Set(['ParamMouthOpenY', 'ParamMouthForm']);
// 资产开关的互斥分组：同一组里只能开一个（不能同时戴两副眼镜）。
// 不在这张表里的资产互相独立，可以叠加。
export const COSTUME_GROUPS = {
  黑框眼镜: 'glasses', 单片眼镜: 'glasses',
  默认体型: 'body', 体型1: 'body', 体型2: 'body',
  圈圈眼: 'eyes', 屑屑眼: 'eyes', '＞＜': 'eyes', 爱心眼: 'eyes',
  竖食指开: 'hand', 竖食指关: 'hand',
};

export class JellyfishRenderer extends CubismUserModel {
  constructor(canvas, report = () => {}, options = {}) {
    super(); this.canvas = canvas; this.report = report; this.options = options;
    this.textures = []; this.expressions = new Map(); this.faceKey = ''; this.gestureKey = '';
    this.expressionParameters = new Set(); this.expressionValues = new Map(); this.previewParameters = new Set(); this.appearanceParameters = new Set();
    // 哪些 exp3 真的会写 ParamEyeLOpen/ROpen（2026-11-21 P2）：
    // 眨眼「二次相乘」只对这批表情生效。jellyfish 的 23 个 exp3 全是换装配件，
    // 一个都不写 EyeOpen —— 旧代码只看「有没有表情」，于是有表情时眨眼恒被平方。
    this.eyeWritingExpressions = new Set();
    this.interaction = new InteractionMotion(); this.bodyDirector = new BodyDirector();
    // 待机层幅度（2026-11-25 P1，ADR-015 §3.4）：ambient 给的 0..1 预算，1 = 旧行为。
    // 只影响待机摆动/呼吸/小动作的幅度，不改频率、不改工作态。
    this.ambientAmp = 1;
    // 待机层偏置（2026-11-25 P1.5）：归一化后的 {amp, bias}，由宿主每帧 setAmbientOffset 推入。
    // 真正的落地在 updateView 的 PROC_MOTION 那次写入里（applyAmbientOffsets）——
    // 这里只存，不写参数，避免同帧第二次 set 触发冲突告警。
    this._ambientOffset = null;
    // 本帧实际加了多少（诊断：performanceDebug().ambient.offsets）。null = 本帧没应用。
    this._ambientApplied = null;
    // 动作层：英文标签 → 参数编舞；speechRate 是按口型开合估出来的语速（0..1）。
    this.motionDirector = new MotionDirector(); this.speechRate = 0;
    // 派活状态的真值在动作层：它一变（含 done 到点自动回 idle），把身体层一起切过去。
    this.motionDirector.onWorkStateChange = (state) => {
      try { this.bodyDirector.setWorkState(state); } catch {}
      this.report({ type: 'work-state', state });
    };
    this.hiddenPartIds = Array.isArray(options.hiddenParts) ? options.hiddenParts : [];
    this.hideDrawableIds = Array.isArray(options.hideDrawables) ? options.hideDrawables : [];
    this.forceShowIds = Array.isArray(options.forceShowDrawables) ? options.forceShowDrawables : []; this.elapsed = 0; this.gestureManager = new CubismExpressionMotionManager(); this.previewManager = new CubismExpressionMotionManager(); this.framing = 'full';
    // No policy yet means no automatic animation, including before backend ready.
    this.automaticIds = new Set(); this.policyRevision = -1; this.previewValues = new Map();
    this.manualFace = ''; this.manualFaceUntil = 0; this.motions = new Map();
    // 表演层表情（v3，2026-11-16）：同一步里可以有多张脸（13 的裙子+眼镜/04 的＞＜+脸红），
    // 由渲染层自己做权重交叉淡入淡出（旧的单槽 manualFace 会丢掉第二张）。
    this.perfFaceWeights = new Map(); this._perfFaceTargets = new Set();
    // 外部（情绪引擎）声明拥有哪些参数；拥有者写的值优先于内置层的兜底值。
    this.emotionOwnsParam = null;
    // 参数所有权护栏（2026-11-18 §69 B3）：
    //   _ownerStack 记录「这一秒是哪一层在写」，set() 把 owner 一起记进 _frameWrites；
    //   _conflictLedger 让每个 (参数, owner 组合) 只告警一次（不刷屏，也不合并掩盖新问题）。
    this._ownerStack = [];
    this._conflictLedger = createConflictLedger({
      maxWarn: 50,
      onNew: (entry) => console.warn(
        `[param-ownership] "${entry.param}" 同一帧被多层写过：${entry.owners.join(' → ')}`
        + `（Δ${entry.delta}，本条只告警一次）`
      ),
    });
  }

  /** 当前写入方（B3）：没标就当 renderer 自己的合成层。 */
  _ownerNow() {
    return this._ownerStack.length ? this._ownerStack[this._ownerStack.length - 1] : LAYER.BASELINE;
  }

  /**
   * 给某一层的写入包上下文：withOwner(LAYER.LIP, () => {...})。
   * 嵌套时取栈顶，所以「表演层里的换装」这种可以再套一层。
   */
  withOwner(name, fn) {
    this._ownerStack.push(name || LAYER.BASELINE);
    try { return fn(); } finally { this._ownerStack.pop(); }
  }
  // Pin one expression by its authored name. Pinning used to be permanent, which made the
  // face freeze on the first expression that ever fired; now every pin carries a TTL and
  // falls back to the emotion mapping when it expires.
  setNamedExpression(name, active = true, ttlMs = 0) {
    if (!this.ready) return false;
    // 表演期间表情归表演（2026-11-16 用户反馈「调试时莫名其妙黑脸/变脸」）：
    // long-performance 自己用 manualFace 锁脸，外部（actions-bridge 的情绪表情、
    // 待机随机表情）此时插进来就会把剧情里的脸顶掉。表演开始/结束由 petbody-entry 设。
    if (this.expressionOwner === 'performance' && active) return false;
    if (active) {
      if (!this.expressions.has(name)) return false;
      this.manualFace = name;
      this.manualFaceUntil = performance.now() + (ttlMs > 0 ? ttlMs : (this.options.expressionTtlMs ?? 12000));
      return true;
    }
    if (this.manualFace === name) { this.manualFace = ''; this.manualFaceUntil = 0; }
    return true;
  }
  /**
   * 表演层表情（v3，2026-11-16）：传「本帧要锁的所有脸」，渲染层按权重交叉淡入淡出。
   * - 多张脸同时在场：13 的「裙子切换+黑框眼镜」、04 的「＞＜+脸红」不再丢第二张
   * - 同组互斥（COSTUME_GROUPS）：眼镜/体型/眼型组内权重归一化，是交叉淡化不是叠加
   * - 淡入淡出 0.22s 时间常数，取代旧 manualFace 的硬切（切脸时参数跳变 0.4~0.9）
   */
  setPerformanceFaces(names) {
    const next = new Set();
    for (const n of Array.isArray(names) ? names : []) {
      if (typeof n === 'string' && this.expressions.has(n)) next.add(n);
    }
    this._perfFaceTargets = next;
    return true;
  }
  /** 应用表演层表情权重（在表情管理器与 blendParameters 之后调用，盖住情绪脸） */
  _applyPerformanceFaces(delta, speaking) {
    const targets = this._perfFaceTargets || new Set();
    const weights = this.perfFaceWeights;
    if (!targets.size && !weights.size) return;
    const k = 1 - Math.exp(-Math.max(0, delta) / 0.22);
    const names = new Set([...weights.keys(), ...targets]);
    for (const name of names) {
      const target = targets.has(name) ? 1 : 0;
      const cur = weights.get(name) || 0;
      const next = Math.abs(target - cur) < 0.006 ? target : cur + (target - cur) * k;
      if (next <= 0.006) weights.delete(name); else weights.set(name, next);
    }
    if (!weights.size) return;
    // 同组互斥：组内权重归一化（交叉淡化而不是把两张脸的加法叠在一起）
    const groupTotal = new Map();
    for (const [name, w] of weights) {
      const g = COSTUME_GROUPS[name];
      if (g) groupTotal.set(g, (groupTotal.get(g) || 0) + w);
    }
    const eff = new Map();
    for (const [name, w] of weights) {
      const g = COSTUME_GROUPS[name];
      const total = g ? (groupTotal.get(g) || 0) : 0;
      eff.set(name, g && total > 1 ? w / total : w);
    }
    // 按 blendType 分三轮：加算(0) → 乘算(1) → 覆写(2)，与 SDK 语义一致
    for (let type = 0; type <= 2; type += 1) {
      for (const [name, w] of eff) {
        if (w <= 0.006) continue;
        const motion = this.expressions.get(name);
        if (!motion || typeof motion.getExpressionParameters !== 'function') continue;
        const params = motion.getExpressionParameters();
        for (const p of params) {
          const id = p && p.parameterId && typeof p.parameterId.getString === 'function'
            ? p.parameterId.getString() : String(p && p.parameterId);
          if (!this.parameterIndices.has(id)) continue;
          if (id === 'ParamMouthOpenY') continue;
          if (speaking && SPEECH_OWNED.has(id)) continue;
          const bt = Number(p.blendType) || 0;
          if (bt !== type) continue;
          const v = Number(p.value) || 0;
          const cv = this.get(id) || 0;
          if (type === 0) this.set(id, cv + v * w);
          else if (type === 1) this.set(id, cv * (1 + (v - 1) * w));
          else this.set(id, cv * (1 - w) + v * w);
        }
      }
    }
  }
  /**
   * 待机随机小表情：空闲时每隔 45–90 秒贴一个安全表情（4 秒后自动回落）。
   * 只动 manualFace 这一个通道，且「有人手动定表情 / 正在工作 / 不在 idle」时绝不介入。
   * 安全池刻意不含 流泪/黑脸（待机随机哭脸会很怪）。
   */
  _tickIdleExpression(view, workActive) {
    if (this.options.idleExpressions === false) return;
    const now = performance.now();
    // 表演期间 / 刚演完 25 秒内不贴随机表情：否则「演到一半突然换脸」或者
    // 「刚演完立刻随机变脸」，看起来都很假（2026-11-16 用户反馈）。
    if (this.expressionOwner === 'performance') { this._idleExprAt = 0; return; }
    if (this.lastPerformanceEndAt && now - this.lastPerformanceEndAt < 25000) { this._idleExprAt = 0; return; }
    const idle = !workActive && view && view.state === 'idle';
    if (!idle || this.manualFace) { this._idleExprAt = 0; return; }
    if (!this._idleExprAt) { this._idleExprAt = now + 45000 + Math.random() * 45000; return; }
    if (now < this._idleExprAt) return;
    const pool = ['＞＜', '脸红', '屑屑眼'].filter((n) => this.expressions && this.expressions.has(n));
    if (pool.length) {
      this.setNamedExpression(pool[Math.floor(Math.random() * pool.length)], true, 4000);
    }
    this._idleExprAt = now + 60000 + Math.random() * 60000;
  }

  // ── 换装（资产开关）────────────────────────────────────────────────────
  // 和表情分开：表情有 TTL、会自动回落；资产必须一直穿着，直到明确换掉。
  setCostume(name, on = true) {
    if (!this.costumeCatalog || !this.costumeCatalog.has(name)) return false;
    if (!this.activeCostumes) this.activeCostumes = new Set();
    const group = COSTUME_GROUPS[name];
    if (on && group) {
      // 同组互斥：戴上单片就摘掉黑框
      for (const other of [...this.activeCostumes]) {
        if (other !== name && COSTUME_GROUPS[other] === group) this.activeCostumes.delete(other);
      }
    }
    if (on) this.activeCostumes.add(name); else this.activeCostumes.delete(name);
    return true;
  }
  getActiveCostumes() { return [...(this.activeCostumes || [])]; }
  resetCostumes() { if (this.activeCostumes) this.activeCostumes.clear(); return true; }
  listCostumes() { return [...(this.costumeCatalog || new Map()).keys()]; }
  /** 每帧在 model.update() 之前把资产开关叠上去（exp3 用的是 Add 混合） */
  applyCostumeLayer() {
    if (!this.activeCostumes || !this.activeCostumes.size || !this.costumeCatalog) return;
    for (const name of this.activeCostumes) {
      const params = this.costumeCatalog.get(name);
      if (!params) continue;
      for (const item of params) this.addParameter(item.id, item.value);
    }
  }

  // Play one of the rig's authored motions; priority 2 outranks the idle loop.
  playMotion(group, index = 0, priority = 2) {
    if (!this.ready) return false;
    const motion = this.motions.get(group + ':' + index) ?? this.motions.get(group + ':0') ?? (group === 'Idle' ? this.idle : null);
    if (!motion) return false;
    this._motionManager.startMotionPriority(motion, false, priority);
    // 主动动作（Tap/手势/场景动作）期间不允许降频帧率——那是用户正盯着看的表演。
    // 待机循环动作不算（它一直在跑，若也算 busy 则永远降不了频，见 updateView 注释）。
    if (String(group).toLowerCase() !== 'idle') {
      this._mainMotionPlaying = true;
      clearTimeout(this._mainMotionTimer);
      this._mainMotionTimer = setTimeout(() => { this._mainMotionPlaying = false; }, 2500);
      if (this._mainMotionTimer.unref) this._mainMotionTimer.unref();
    }
    return true;
  }
  // One atlas holds at most 36 mask groups (32 once more than one atlas is in
  // play); the mask atlas also has to be fine enough for a 2x-DPI canvas, since
  // the SDK default of 256x256 blurs every clipped layer into a pale veil.
  resolveMaskConfig() {
    let groups = 1;
    try {
      const model = this._model;
      const masks = model.getDrawableMasks(), counts = model.getDrawableMaskCounts();
      const seen = new Set();
      for (let i = 0; i < model.getDrawableCount(); i++) {
        const n = counts[i];
        if (!n) continue;
        seen.add(Array.from(masks[i]).slice(0, n).join(','));
      }
      groups = Math.max(1, seen.size);
    } catch (error) {
      this.report({ type: 'error', message: 'mask groups: ' + String(error && error.message || error) });
    }
    const count = Math.max(1, Math.ceil(groups / 32));
    const edge = Math.ceil(Math.max(this.canvas.width, this.canvas.height) / 2);
    const size = Math.min(2048, Math.max(512, Math.pow(2, Math.ceil(Math.log2(edge)))));
    this.maskConfig = { groups, count, size };
    this.report({ type: 'mask-config', groups, count, size });
    return this.maskConfig;
  }
  async load() {
    this.gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!this.gl) throw new Error('这个窗口无法启用 WebGL');
    this.syncViewport();
    const base = new URL(this.options.assetBase ?? 'assets/jellyfish/', location.href);
    // Electron 用 file:// 载入页面时 fetch 常常拿不到 body（返回 status 0 或空 buffer），
    // 所以这里 fetch 失败就退回 XHR —— XHR 是唯一在 file:// 下稳定读二进制的方式。
    const read = async path => {
      const url = new URL(path, base).href;
      try {
        const response = await fetch(url);
        if (response.ok || response.status === 0) {
          const buffer = await response.arrayBuffer();
          if (buffer && buffer.byteLength > 0) return buffer;
        }
      } catch (error) { /* 落到 XHR */ }
      return await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = () => {
          const ok = xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300);
          if (ok && xhr.response && xhr.response.byteLength > 0) resolve(xhr.response);
          else reject(new Error('模型文件加载失败：' + path + ' (' + xhr.status + ')'));
        };
        xhr.onerror = () => reject(new Error('模型文件加载失败：' + path));
        xhr.send();
      });
    };
    await this.loadRig(read);
    // Cubism packs several clipping mask groups into each atlas channel and hard
    // caps a single atlas at 36 groups; past that the SDK falls back to "clear one
    // buffer per drawable", which silently smears every mask-based layer (white
    // nose patch, brown mouth). This rig uses 49 groups, so size the atlas count
    // from the rig itself instead of trusting the SDK default of one.
    const maskConfig = this.resolveMaskConfig();
    this.createRenderer(this.canvas.width, this.canvas.height, maskConfig.count);
    try { this.getRenderer().setClippingMaskBufferSize(maskConfig.size); }
    catch (error) { this.report({ type: 'error', message: 'mask buffer size: ' + String(error && error.message || error) }); }
    webglOwners.add(this);
    const renderer = this.getRenderer(); renderer.startUp(this.gl); if (typeof renderer.loadShaders === 'function') renderer.loadShaders(new URL(this.options.shaderBase ?? 'vendor/cubism/Framework/Shaders/WebGL/', location.href).href); renderer.setIsPremultipliedAlpha(true);
    for (let i = 0; i < this.settings.getTextureCount(); i++) {
      const img = new Image(); img.src = new URL(this.settings.getTextureFileName(i), base).href; await img.decode();
      if (Math.max(img.width, img.height) > this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE)) throw new Error('设备不支持这张模型纹理的尺寸');
      const gl = this.gl, tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); renderer.bindTexture(i, tex); this.textures.push(tex);
    }
    this._modelMatrix.setHeight(1.9); this._modelMatrix.setPosition(0, 0);
    this.syncViewport(true);
    this.report({ type: 'model-loaded', parameters: this._model.getParameterCount(), drawables: this._model.getDrawableCount(), expressions: this.expressions.size, textures: this.textures.length, canvas: [this._model.getCanvasWidth(), this._model.getCanvasHeight()], maxTextureSize: this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE), runtime: 'Cubism5-r.5' });
    this.ready = true; this.last = performance.now();
  }
  // Shared by the real WebGL loader and silent tests of the actual Cubism rig.
  async loadRig(readAsset) {
    CubismFramework.startUp({ logFunction: message => this.report({ type: 'sdk', message }), loggingLevel: 3 }); CubismFramework.initialize();
    const buffers = new Map();
    const read = async path => {
      if (typeof path !== 'string' || /^[/.]|[:%\\]/.test(path) || path.split('/').includes('..')) throw new Error('模型资源路径不可用');
      if (!buffers.has(path)) { const buffer = await readAsset(path); buffers.set(path, buffer); this.report({ type: 'asset', path, bytes: buffer ? buffer.byteLength : -1 }); }
      return buffers.get(path);
    };
    const settingsBuffer = await read('pet.model3.json');
    const refs = JSON.parse(new TextDecoder().decode(settingsBuffer)).FileReferences;
    const paths = [...new Set(['pet.model3.json', refs.Moc, refs.Physics, ...refs.Expressions.map(e => e.File), ...Object.values(refs.Motions).flat().map(m => m.File)])].sort();
    // 换装目录：这些 exp3 里有一半不是「表情」而是「资产开关」——
    // 黑框眼镜只是把 key11 扳到 1，裙子切换把 Clothes1 扳到 -1。
    // 换装要常驻，不能走表情那套 6 秒 TTL，所以单独建目录、单独一套状态。
    this.costumeCatalog = new Map();
    for (const entry of (refs.Expressions || [])) {
      try {
        const buffer = await read(entry.File);
        const json = JSON.parse(new TextDecoder().decode(buffer));
        const params = (json.Parameters || []).map(item => ({ id: item.Id, value: item.Value }));
        if (params.length) this.costumeCatalog.set(entry.Name, params);
      } catch (error) { /* 单个资产读不出来不影响其它 */ }
    }
    // 资产参数必须排除在「外观默认值」之外。
    // captureAppearance() 每帧把当前值抄进 defaults，如果资产开着的时候抄了，
    // 这个值就变成新基线——摘掉眼镜后 key11 仍然是 1，越换越乱。
    this.costumeParamIds = new Set();
    for (const params of this.costumeCatalog.values()) for (const item of params) this.costumeParamIds.add(item.id);
    const hash = async buffer => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), byte => byte.toString(16).padStart(2, '0')).join('');
    let binding = '';
    for (const path of paths) binding += path + '\0' + await hash(await read(path)) + '\n';
    const fingerprint = await hash(new TextEncoder().encode(binding));
    if (fingerprint !== presetCatalog.modelFingerprint) throw new Error('模型与预设目录版本不一致');
    this.settings = new CubismModelSettingJson(settingsBuffer, settingsBuffer.byteLength);
    // 第二个参数是「是否做 moc 一致性校验」：该校验要读核心的 csmGetMocVersion，
    // 旧版 Core（my-neuro 自带的 4/5 早期构建）在上面会抛 byteLength，所以默认跳过。
    this.loadModel(await read(this.settings.getModelFileName()), this.options.mocConsistencyCheck === true);
    if (!this._model) throw new Error('Cubism 未能解析模型');
    const physics = await read(this.settings.getPhysicsFileName()); this.loadPhysics(physics, physics.byteLength);
    this.blink = CubismEyeBlink.create(this.settings);
    // 默认间隔 4s（随机 3–7s）偏慢，用户实测「基本不眨眼」→ 收到 3.2s（随机 2.2–5.4s），
    // 接近真人静息 15–20 次/分；说话时也照常眨（表情覆盖问题见下面的乘法补丁）。
    try { this.blink && this.blink.setBlinkingInterval && this.blink.setBlinkingInterval(3.2); } catch (e) { /* 旧版 SDK 没有这个 API */ }
    this.parameterIndices = new Map(Array.from(this._model.getModel().parameters.ids, (id, i) => [id, i]));
    const supported = new Set(automaticItems.map(item => item.expressionName));
    const appearance = new Set(presetCatalog.items.filter(item => item.category === 'appearance').map(item => item.expressionName));
    for (let i = 0; i < this.settings.getExpressionCount(); i++) {
      const name = this.settings.getExpressionName(i), b = await read(this.settings.getExpressionFileName(i));
      this.expressions.set(name, this.loadExpression(b, b.byteLength, name));
      const expressionJson = JSON.parse(new TextDecoder().decode(b));
      const expressionParams = expressionJson.Parameters || [];
      if (writesEyeOpen(expressionParams.map((parameter) => parameter.Id))) this.eyeWritingExpressions.add(name);
      for (const parameter of expressionParams) {
        if (!this.parameterIndices.has(parameter.Id)) throw new Error('预设引用了模型不存在的参数');
        // Mouth amplitude stays on the actual playback clock, never expression easing.
        if (parameter.Id === 'ParamMouthOpenY' || parameter.Id === 'fase80') continue;
        this.previewParameters.add(parameter.Id);
        if (supported.has(name)) this.expressionParameters.add(parameter.Id);
        if (appearance.has(name)) this.appearanceParameters.add(parameter.Id);
      }
    }
    for (let groupIndex = 0; groupIndex < this.settings.getMotionGroupCount(); groupIndex++) {
      const group = this.settings.getMotionGroupName(groupIndex);
      for (let index = 0; index < this.settings.getMotionCount(group); index++) {
        try {
          const buffer = await read(this.settings.getMotionFileName(group, index));
          const loaded = this.loadMotion(buffer, buffer.byteLength, group + '_' + index);
          if (loaded) { loaded.setEffectIds([], []); this.motions.set(group + ':' + index, loaded); }
        } catch (error) { this.report({ type: 'error', message: 'motion ' + group + ':' + index + ' ' + String(error && error.message || error) }); }
      }
    }
    const motion = await read(this.settings.getMotionFileName('Idle', 0)); this.idle = this.loadMotion(motion, motion.byteLength, 'Idle'); this.idle.setLoop(true); this.idle.setEffectIds([], []);
    this.motionParameters = new Set(JSON.parse(new TextDecoder().decode(motion)).Curves.filter(c => c.Target === 'Parameter').map(c => c.Id));
    this.runtimeParameters = new Set([...this.expressionParameters, ...this.motionParameters, ...interactionParameters, 'ParamBodyAngleX', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthForm', 'ParamMouthOpenY']);
    for (const id of this.runtimeParameters) { if (!this.parameterIndices.has(id)) throw new Error('动作引用了模型不存在的参数'); this.previewParameters.add(id); this.appearanceParameters.delete(id); }
    // Asset-author switch: hide the preview watermark; source model and textures stay intact.
    this.set('fase80', 1); this._model.update();
    this.defaults = Array.from(this._model.getModel().parameters.values);
  }
  // 参数名 → index 缓存（2026-11-09 #20）：原实现每次 set/get 都走
  // CubismFramework.getIdManager().getId(name) 字符串哈希 + getParameterIndex 查表。
  // 实测单次 0.118µs、每帧 17 次 ≈ 2µs/帧——量级不大，但缓存是零风险纯收益：
  // 名字是常量、模型加载后 index 不变，缓存不会失效。
  _paramIndex(name) {
    let i = this._paramIndexCache?.get(name);
    if (i !== undefined) return i;
    if (!this._paramIndexCache) this._paramIndexCache = new Map();
    const m = this._model;
    if (!m) return -1;
    const id = CubismFramework.getIdManager().getId(name);
    i = m.getParameterIndex(id);
    if (i >= 0 && i < m.getParameterCount()) { this._paramIndexCache.set(name, i); return i; }
    return -1;
  }
  set(name, value) {
    const i = this._paramIndex(name);
    if (i >= 0) {
      // 只读探针（P1-6 前置）：记录本帧每个参数被写了哪些值、以及**是谁**写的（B3）。
      // 同一参数在一帧内被写多次且值不同 = 多层抢写 = 视觉上的抖动来源。
      if (this._frameWrites) {
        let entry = this._frameWrites.get(name);
        if (!entry) { entry = { vals: [], owners: [] }; this._frameWrites.set(name, entry); }
        entry.vals.push(value);
        entry.owners.push(this._ownerNow());
      }
      // 影子模式（P1-6 第一段）：记录「本帧最后一次意图值」，帧末与最终值比对。
      // 这一步**不改变任何行为**——只是把以后要抽成 target map 的东西先记下来。
      if (this._frameTarget) this._frameTarget.set(name, value);
      this._model.setParameterValueByIndex(i, value);
    }
  }
  get(name) {
    const i = this._paramIndex(name);
    return i >= 0 ? this._model.getModel().parameters.values[i] : 0;
  }

  /**
   * 命中测试：窗口坐标 (cssX, cssY) 是否落在她身上（不透明区域）。
   *
   * 用途：鼠标穿透判定。皮套铺满 420×760 窗口，但她是人形——周围大片透明区域若也算可点击，
   * 用户会觉得「窗口挡着却点不到下面的东西」（遮挡感）。这里用 Cubism drawable 顶点做
   * 多边形包含测试（几十个部件 vs 63 万像素逐点判，便宜得多）。
   * 命中失败一律返回 false：宁可让它穿透，也不挡住用户操作。
   */
  hitTest(cssX, cssY) {
    try {
      const model = this._model;
      const canvas = this.canvas;
      if (!model || !this.ready || !canvas) return false;
      const cw = canvas.width, ch = canvas.height;
      if (!cw || !ch) return false;
      const dprX = cw / Math.max(1, canvas.clientWidth || cw);
      const dprY = ch / Math.max(1, canvas.clientHeight || ch);
      const px = cssX * dprX, py = cssY * dprY;

      const count = typeof model.getDrawableCount === 'function' ? model.getDrawableCount() : 0;
      for (let i = 0; i < count; i++) {
        if (typeof model.getDrawableDynamicFlagIsVisible === 'function'
            && !model.getDrawableDynamicFlagIsVisible(i)) continue;
        if (typeof model.getDrawableOpacity === 'function' && model.getDrawableOpacity(i) < 0.01) continue;
        const vcount = typeof model.getDrawableVertexCount === 'function' ? model.getDrawableVertexCount(i) : 0;
        if (vcount < 3) continue;
        const verts = typeof model.getDrawableVertexPositions === 'function'
          ? model.getDrawableVertexPositions(i) : null;
        if (!verts || verts.length < 6) continue;
        // 顶点是模型空间（±1 附近，y 向上）→ 画布像素（y 向下）
        let inside = false;
        for (let a = 0, b = vcount - 1; a < vcount; b = a++) {
          const ax = (verts[a * 2] * 0.5 + 0.5) * cw;
          const ay = (1 - (verts[a * 2 + 1] * 0.5 + 0.5)) * ch;
          const bx = (verts[b * 2] * 0.5 + 0.5) * cw;
          const by = (1 - (verts[b * 2 + 1] * 0.5 + 0.5)) * ch;
          if (((ay > py) !== (by > py)) && (px < (bx - ax) * (py - ay) / (((by - ay) || 1e-9)) + ax)) {
            inside = !inside;
          }
        }
        if (inside) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // ── 公开的参数读写：范围一律从模型读 ───────────────────────────────────────
  // 这套 rig 里 ParamAngleX 是 -30..30、LArm 是 -1..1、Movement1 是 0..1、Param38 是 0..1，
  // 写死任何一组都会让别的层「僵」住或者被裁掉，所以上下限每次都问模型要。
  setParameter(id, value) {
    const index = this.parameterIndices?.get(String(id));
    if (index === undefined || !this._model) return false;
    const model = this._model, values = model.getModel().parameters.values;
    const lo = model.getParameterMinimumValue(index), hi = model.getParameterMaximumValue(index);
    values[index] = Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : values[index];
    return true;
  }
  getParameter(id) {
    const index = this.parameterIndices?.get(String(id));
    return index === undefined || !this._model ? 0 : this._model.getModel().parameters.values[index];
  }
  // 叠加补偿（动作层用）：在基础层算好的值上加 delta，越界按模型范围钳制。
  addParameter(id, delta) {
    if (!Number.isFinite(delta) || delta === 0) return false;
    return this.setParameter(id, this.getParameter(id) + delta);
  }
  // ── 动作词典 ──────────────────────────────────────────────────────────────
  // 播一个动作：英文标签（"[wave right hand]" 这种带修饰的也行）或规范名。
  // 编舞是「补偿量」，叠在呼吸/重心/头部跟随之上；淡入 120ms、淡出 200ms，播完自动回待机。
  playAction(tag, options = {}) {
    if (!this.ready || this.previewMode) return false;
    if (!this.motionDirector.play(tag, options)) return false;
    this.report({ type: 'action', name: this.motionDirector.name, label: this.motionDirector.label, tag: this.motionDirector.lastTag });
    return true;
  }
  // 提前收尾：走 200ms 淡出，不是硬切。
  stopAction(fade) { return this.motionDirector.stop(fade); }
  /**
   * 待机层幅度（P1）：ambient.mjs 每帧给的 0..1 预算。
   * 1 = 完全按旧行为；0..1 之间只压待机摆动/呼吸/小动作的幅度，不改任何频率与所有权。
   */
  setAmbientAmp(value) {
    const n = Number(value);
    this.ambientAmp = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
    return this.ambientAmp;
  }
  /**
   * 待机层偏置落地（P1.5）：ambient.mjs 的 bias（FACS 偏移单位）在这里归一化成 [-1,1] 存起来。
   * 接受 `{amp, bias:{...}}` 或 `{...bias, amp}` 两种形状（宿主传的是后者）。传 null 关闭。
   *
   * 只存不写：参数在 updateView 里并进 PROC_MOTION 的**同一次**写入（head/body 各一处），
   * 保证 ParamAngleX/Y/Z、ParamEyeBallX/Y、ParamBreath、ParamBodyAngleZ 每帧仍只有一个写者。
   */
  setAmbientOffset(amb) {
    if (!amb || typeof amb !== 'object') { this._ambientOffset = null; return null; }
    const bias = amb.bias && typeof amb.bias === 'object' ? amb.bias : amb;
    const amp = Number(amb.amp);
    this._ambientOffset = {
      amp: Number.isFinite(amp) ? Math.min(1, Math.max(0, amp)) : 0,
      bias: normalizeAmbientBias(bias),
    };
    return this._ambientOffset;
  }
  /** 本帧偏置的应用结果（只读诊断口；没应用时为 null）。 */
  get ambientApplied() { return this._ambientApplied; }
  // ── 派活状态（主进程在 HTTP /dispatch 前后调用）───────────────────────────
  // idle → thinking（接活）→ busy（干活，可选）→ done（交差，2.5 秒后自动回 idle）。
  // 状态只在动作层维护一份，这里做入口和联动，避免两份状态打架。
  get workState() { return this.motionDirector.workState; }
  setWorkState(state) {
    const next = this.motionDirector.setWorkState(state);
    this.bodyDirector.setWorkState(next);
    return next;
  }
  // 给 UI 的动作清单（不含关键帧数据）。
  listActions() { return listActions(); }
  get actionName() { return this.motionDirector.name; }
  // 把这一帧的补偿量贴到底层参数上：手势互斥参数先清零，再叠增量。
  // stage='pre' 贴物理之前（AngleXYZ / PositionXYZ 这类物理链输入，头发裙摆才吃得到）；
  // stage='post' 贴物理之后（RArm/LArm 这类在本 rig 里是物理"输出"的关节参数，
  // 物理每帧会把它们写回去，只能晚一步盖住，否则手势根本抬不起来）。
  applyActionLayer(layer, stage = 'pre') {
    if (!layer) return;
    if (stage === 'pre') for (const id of layer.pinned) this.setParameter(id, 0);
    const source = stage === 'pre' ? layer.deltas : layer.post;
    for (const id in source) {
      // ParamBodyAngleX 在物理之后才写，由 updateView 统一合成，这里跳过避免重复叠加。
      if (id === 'ParamBodyAngleX') continue;
      this.addParameter(id, source[id]);
    }
  }
  setAutomaticPolicy(policy) {
    // The host sends this sentinel at a backend-generation boundary. Other
    // foreign model IDs must not silently reset the monotonic revision guard.
    if (policy?.modelId === 'disconnected') this.policyRevision = -1;
    if (policy?.modelId !== presetCatalog.modelId) { this.policyValid = false; this.automaticIds.clear(); this.interaction.release(); this.clearAutomatic(); return false; }
    if (!Number.isSafeInteger(policy.revision) || policy.revision < 0 || policy.revision < this.policyRevision) return false;
    if (!Array.isArray(policy.enabledIds) || policy.enabledIds.some(id => presets.get(id)?.availability !== 'automatic')) { this.policyValid = false; this.automaticIds.clear(); this.interaction.release(); this.clearAutomatic(); return false; }
    const next = new Set(policy.enabledIds);
    if (this.policyValid && policy.revision === this.policyRevision) return next.size === this.automaticIds.size && [...next].every(id => this.automaticIds.has(id));
    this.policyValid = true; this.policyRevision = policy.revision; this.automaticIds = next;
    if (!['proc-head', 'proc-body', 'proc-blink'].some(id => next.has(id))) this.interaction.release();
    if (!this.previewMode) {
      let released = false;
      if (this.faceKey && !automaticItems.some(item => item.expressionName === this.faceKey && next.has(item.id))) { this._expressionManager.stopAllMotions(); this.faceKey = ''; released = true; }
      if (this.gestureKey && !automaticItems.some(item => item.expressionName === this.gestureKey && next.has(item.id))) { this.gestureManager.stopAllMotions(); this.gestureKey = ''; released = true; }
      if (released) this.expressionValues.clear();
      if (!next.has('motion-idle-0')) this._motionManager.stopAllMotions();
    }
    return true;
  }
  clearAutomatic() {
    this.motionDirector.reset();
    if (!this.previewMode) this._motionManager.stopAllMotions();
    this._expressionManager.stopAllMotions(); this.gestureManager.stopAllMotions();
    this.faceKey = ''; this.gestureKey = ''; this.expressionValues.clear();
  }
  captureAppearance() {
    if (!this.defaults) return;
    // 动作层正在演的时候跳过它驱动的参数：否则手势/道具的瞬态值会被当成
    // 新的「外观默认值」钉下来，动作结束也放不下（资产开关还会被顺手改掉）。
    const claimed = this.motionDirector?.claimedIds;
    // ⚡ 性能（2026-11-08）：这是每帧热路径（updateView 第一件事）。
    // 原来每个参数都走 this.get(id) —— 内部要先 CubismFramework.getIdManager()
    // .getId(name) 做字符串哈希查表，再走模型 API。几十个外观参数 × 60fps = 每帧
    // 上千次字符串哈希，实测 updateView 单帧 10.7ms（16ms 预算的 67%）。
    // 现在直接读 parameters.values 数组（O(1) 下标），一次性建好索引表。
    try {
      if (!this._appearanceIdx) {
        this._appearanceIdx = [];
        for (const id of this.appearanceParameters) {
          const idx = this.parameterIndices?.get(String(id));
          if (idx !== undefined) this._appearanceIdx.push(idx);
        }
      }
      const values = this._model.getModel().parameters.values;
      for (const idx of this._appearanceIdx) {
        const id = this._model.getModel().parameters.ids[idx];
        if (claimed && claimed.has(id)) continue;
        if (this.costumeParamIds && this.costumeParamIds.has(id)) continue;
        this.defaults[idx] = values[idx];
      }
    } catch (e) {
      // 兜底回旧实现（结构变化时不至于每帧报错）
      for (const id of this.appearanceParameters) {
        if (claimed && claimed.has(id)) continue;
        if (this.costumeParamIds && this.costumeParamIds.has(id)) continue;
        this.defaults[this.parameterIndices.get(id)] = this.get(id);
      }
    }
  }
  beginAttention() {
    if (this.ready && !this.previewMode && this.policyValid && ['proc-head', 'proc-body', 'proc-blink'].some(id => this.automaticIds.has(id))) this.interaction.start(performance.now());
  }
  reset({ preserveAttention = false } = {}) {
    if (!preserveAttention) this.interaction.release();
    this.clearAutomatic();
    this.motionDirector.reset(); this.speechRate = 0;
    if (this.previewMode) { this.stopPreview(); return; }
    // Release transient controls only; clothing/accessory state is not a turn.
    if (this._model && this.defaults) for (const id of this.runtimeParameters) if (!interactionParameters.includes(id)) this.set(id, this.defaults[this.parameterIndices.get(id)]);
  }
  enterPreview() {
    if (this.previewMode) return;
    this.clearAutomatic(); this.previewMode = true; this.motionDirector.reset();
    this.previewBaseline = Array.from(this._model.getModel().parameters.values);
    for (const id of this.previewParameters) this.previewValues.set(id, this.get(id));
  }
  selectPreset(id) {
    const item = presets.get(id);
    if (!this._model || !item?.previewable || item.availability === 'unavailable') throw new Error('这个预设暂时不能预览');
    this.enterPreview(); this.previewManager.stopAllMotions(); this._motionManager.stopAllMotions(); this.previewSelection = item;
    if (item.expressionName) this.previewManager.startMotion(this.expressions.get(item.expressionName), false);
    return true;
  }
  stopPreview() {
    if (!this._model) return;
    this.enterPreview(); this.previewSelection = null; this.previewManager.stopAllMotions(); this._motionManager.stopAllMotions();
  }
  restorePreview() { this.stopPreview(); }
  /** 影子模式结算：意图值 vs 最终值。差异 = 该参数受「写入顺序/物理」影响，
   *  重构 target map 时必须保留这些顺序语义。只统计，不改行为。 */
  _flushShadowTarget() {
    const target = this._frameTarget;
    this._frameTarget = null;
    if (!target || target.size === 0) return;
    let same = 0;
    const diverge = [];
    for (const [id, want] of target) {
      const got = this.get(id);
      if (Math.abs(got - want) < 1e-6) { same += 1; continue; }
      diverge.push({ id, want: Math.round(want * 1000) / 1000, got: Math.round(got * 1000) / 1000 });
    }
    this._shadowFrames = (this._shadowFrames || 0) + 1;
    // 按物理归属分类：纯输出 = 白写（物理会覆盖）；纯输入 = 喂物理；双向 = 既喂又被调。
    const byKind = { plain: 0, input: 0, output: 0, both: 0 };
    const wasted = [];
    try {
      for (const id of target.keys()) {
        const k = classifyParam(id);
        if (k === 'output') {
          byKind.output += 1;
          if (wasted.length < 8) wasted.push(id);
        } else if (k === 'input') byKind.input += 1;
        else {
          // 既是输入又是输出（19 个：头/身体/髋）——算 both，需要按『先喂后放』处理
          byKind[(PHYSICS_BOTH && PHYSICS_BOTH.has(id)) ? 'both' : 'plain'] += 1;
        }
      }
    } catch (e) { /* 分类失败不影响渲染 */ }
    // 每 300 帧报一次（约 5 秒），含占比，避免刷屏
    if (this._shadowFrames % 300 === 1) {
      this.report({
        type: 'shadow-target',
        frame: this._shadowFrames,
        written: target.size,
        same,
        divergeCount: diverge.length,
        byKind,
        wasted: wasted.slice(0, 6),
        diverge: diverge.slice(0, 4),
      });
    }
  }

  /**
   * 帧末结算：同帧内同参数被写多次且差值 >0.02 → 记为冲突（2026-11-13 起有这条，
   * 2026-11-18 §69 B3 补上 owner 归属、「只告警一次」与 compose/fight 分类）。
   *
   * 两条出口，节奏不同、别合并：
   *   · console 告警 —— 每个 (参数, owner 组合) 只喊一次（去重账本），喊完不再刷屏；
   *   · 结构化 report —— 仍按 120 帧节流发，因为 driver 的健康快照判红看
   *     「最近 30 秒有没有」，需要持续心跳而不是一次性事件。
   *
   * ⚠ 只有 fight 才算抢写。compose（choreo / perf-override / action 这些
   *   「设计上就是最后一道」的层）单独计数，不判红 —— 真机基线 15 条里 14 条是它们。
   */
  _flushParamConflicts() {
    const fw = this._frameWrites;
    this._frameWrites = null;
    if (!fw) return;
    const { conflicts, compose, fights } = evaluateFrameConflicts(fw);
    if (compose > 0) this._composeFrames = (this._composeFrames || 0) + 1;
    const fightList = conflicts.filter((c) => c.kind === 'fight');
    if (!fightList.length) { this._conflictFrames = 0; return; }
    this._conflictFrames = (this._conflictFrames || 0) + 1;
    for (const c of fightList) this._conflictLedger.note(c);
    // 每 120 帧报一次，避免刷屏；同时记录最近一次冲突帧总数
    if (this._conflictFrames % 120 === 1) {
      const ledger = this._conflictLedger.stats();
      this.report({
        type: 'param-conflict',
        frames: this._conflictFrames,
        top: fightList.slice(0, 6),
        unique: ledger.unique,
        compose,
        fights,
      });
    }
  }

  blendParameters(parameters, values, delta) {
    const blend = 1 - Math.exp(-Math.max(0, delta) / .12);
    const owned = this.emotionOwnsParam;
    let skipped = 0;
    for (const id of parameters) {
      if (id === 'ParamMouthOpenY') continue;
      // ⚠ 2026-11-12 修「说话时抽搐」的根因：情绪层（perf/FACS）每帧都在写眉毛/眼睛/嘴角，
      //   而表情预设（exp3）也每帧把自己那批参数混合写一遍 —— 两层逐帧抢同一个参数，
      //   在 60fps 下就是你看到的「不自然抖动」。
      //   所有权规则：情绪层接管的参数，表情预设让位（表情仍能驱动它没接管的通道）。
      if (owned && owned(id)) { skipped += 1; continue; }
      const target = this.get(id), previous = values.get(id) ?? target;
      const value = Math.abs(target - previous) < .0001 ? target : previous + (target - previous) * blend;
      values.set(id, value); this.set(id, value);
    }
    // 可观测：切换表情时报告跳过了多少（0 = 没冲突；持续 >0 说明两边覆盖重叠）
    if (skipped > 0 && this._lastSkipReport !== skipped) {
      this._lastSkipReport = skipped;
      this.report({ type: 'expression-owned-skip', skipped });
    }
  }
  updateView(view, interactionState = view.state, workFocus = false) {
    if (!this.ready) return;
    this._frameWrites = new Map();   // 帧内写入记录（冲突探针）
    this._frameTarget = new Map();   // 帧内最后意图值（影子模式 P1-6）
    const now = performance.now(), delta = Math.min((now - this.last) / 1000, .1); this.last = now; this.elapsed += delta;
    // 语速：口型开合的大小做一个平滑，供说话摇摆和动作层细化幅度（0..1）。
    const mouthNow = Number.isFinite(view.mouth) ? Math.min(1, Math.max(0, view.mouth)) : 0;
    const speechTarget = interactionState === 'speaking' ? Math.min(1, mouthNow * 1.6) : 0;
    this.speechRate += (speechTarget - this.speechRate) * (1 - Math.exp(-delta / 0.18));
    if (!this.previewMode) this.captureAppearance();
    this._model.getModel().parameters.values.set(this.previewMode ? this.previewBaseline : this.defaults);
    // 眼神偏移（2026-11-21 P1）：由宿主在 updateView 之前取样，作为 view.gaze 传进来。
    // 必须在物理/顶点重算之前写 —— 写在 updateView 之后的值既不参与本帧重算，
    // 下一帧开头又会被 defaults 重置（这正是「眼神从不进入画面」的根因）。
    const gazeFrame = view && view.gaze && typeof view.gaze === 'object' ? view.gaze : null;
    const enabled = id => this.previewMode ? this.previewSelection?.id === id : this.automaticIds.has(id);
    const workActive=enabled('proc-work-focus') && (this.previewMode || workFocus && ['idle','error'].includes(view.state));
    if (enabled('motion-idle-0')) {
      if (this._motionManager.isFinished()) this._motionManager.startMotionPriority(this.idle, false, 1);
      this.withOwner(LAYER.IDLE_MOTION, () => this._motionManager.updateMotion(this._model, delta));
    } else this._motionManager.stopAllMotions();
    if (enabled('proc-blink')) this.withOwner(LAYER.BLINK, () => this.blink.updateParameters(this._model, delta));
    // 眨眼结果先存下来：表情（expression）会在这之后覆盖眼睛参数，
    // 如果不在表情之后再乘一次，**只要脸上有表情就永远看不到眨眼**（用户实测：「她基本不眨眼」）。
    const __blinkEyeL = this.get('ParamEyeLOpen');
    const __blinkEyeR = this.get('ParamEyeROpen');
    // 待机随机小表情（2026-11-15 六十三轮，用户拍板）：
    // 只在「空闲且没人手动定表情、没有工作动作」时，隔 45–90 秒挑一个**安全**表情贴 4 秒。
    // 用 setNamedExpression 走同一条 manualFace 通道（带 TTL，会自己回落），不新开参数写入路径。
    if (!this.previewMode) this._tickIdleExpression(view, workActive);
    const rawExpression = workActive ? {emotion:'neutral',intensity:0,delivery:'',gesture:null} : view.invitation && view.state === 'idle' ? { emotion: 'neutral', intensity: 0, delivery: '', gesture: view.invitation.gesture } : view.expression;
    const expression = normalizePresentationIntent(rawExpression);
    const faceItem = faces.get(expression.emotion), gestureItem = gestures.get(expression.gesture);
    let face = '', gesture = '';
    if (!this.previewMode) {
      if (Object.hasOwn(expression, 'presetId')) {
        // A present null/unknown/disabled ID is explicitly neutral. It must not
        // fall back to the TTS emotion or the legacy gesture on the same reply.
        const item = presets.get(expression.presetId);
        if (item?.availability === 'automatic' && enabled(item.id)) {
          if (item.category === 'expression') face = item.expressionName;
          if (item.category === 'pose') gesture = item.expressionName;
        }
      } else {
        face = faceItem && enabled(faceItem.id) ? faceItem.expressionName : '';
        gesture = gestureItem && enabled(gestureItem.id) ? gestureItem.expressionName : '';
      }
    }
    // A hotkey or the VTS bridge can pin a named expression regardless of emotion mapping.
    // 手动表情到期自动释放，避免「触发一次就永远不变」。
    if (this.manualFace && this.manualFaceUntil && performance.now() > this.manualFaceUntil) { this.manualFace = ''; this.manualFaceUntil = 0; }
    // 表演层有脸时，情绪脸先让位（参数由 _applyPerformanceFaces 在稍后统一融合写入）
    const perfFacesActive = (this._perfFaceTargets && this._perfFaceTargets.size > 0) || (this.perfFaceWeights && this.perfFaceWeights.size > 0);
    if (perfFacesActive && !this.manualFace) face = '';
    if (this.manualFace) face = this.manualFace;
    if (face !== this.faceKey) { this._expressionManager.stopAllMotions(); if (face) this._expressionManager.startMotion(this.expressions.get(face), false); this.faceKey = face; }
    if (gesture !== this.gestureKey) { this.gestureManager.stopAllMotions(); if (gesture) this.gestureManager.startMotion(this.expressions.get(gesture), false); this.gestureKey = gesture; }
    this.withOwner(LAYER.EXPRESSION, () => { this._expressionManager.updateMotion(this._model, delta); this.gestureManager.updateMotion(this._model, delta); });
    if (this.previewMode) this.previewManager.updateMotion(this._model, delta);
    // The SDK managers reset on intent changes. Carry only supported expression
    // parameters across frames, so changing a face/pose does not pop to defaults.
    if (!this.previewMode) this.withOwner(LAYER.EMOTION_BLEND, () => this.blendParameters(this.expressionParameters, this.expressionValues, delta));
    // 表演层表情融合（第三层，v3）：多张脸按权重交叉淡化，盖在情绪脸之上
    if (!this.previewMode) this.withOwner(LAYER.PERF_FACES, () => this._applyPerformanceFaces(delta, view.state === 'speaking'));
    // 有表情时重新叠一次眨眼：**只有该表情真的写过 EyeOpen 才做**（2026-11-21 P2）。
    // 旧实现只看「有没有表情」，而 jellyfish 的 23 个 exp3 一个都不写 EyeOpen →
    // 眨眼值被乘两次（0.3 → 0.09），有表情时几乎看不到眨眼。
    // 乘法叠加（不是覆盖）—— 表情决定「眼睛什么形状」，眨眼只负责「这一刻闭上」。
    const eyeExpressionNames = [];
    if (this.faceKey) eyeExpressionNames.push(this.faceKey);
    if (this.gestureKey) eyeExpressionNames.push(this.gestureKey);
    if (this.perfFaceWeights) for (const [name, weight] of this.perfFaceWeights) if (weight > 0.006) eyeExpressionNames.push(name);
    const expressionWritesEyes = shouldRestackBlink({ eyeWriters: this.eyeWritingExpressions, activeNames: eyeExpressionNames });
    if (!this.previewMode && expressionWritesEyes && enabled('proc-blink')) {
      this.withOwner(LAYER.BLINK_RESTACK, () => {
        this.set('ParamEyeLOpen', this.get('ParamEyeLOpen') * __blinkEyeL);
        this.set('ParamEyeROpen', this.get('ParamEyeROpen') * __blinkEyeR);
      });
    }
    const active = !this.previewMode && view.state === 'speaking';
    const ambientAmp = this.previewMode ? 1 : (Number.isFinite(Number(this.ambientAmp)) ? this.ambientAmp : 1);
    const movement = this.interaction.sample({ now, delta, elapsed: this.elapsed, state: this.previewMode ? 'idle' : interactionState,
      head: enabled('proc-head')||workActive, body: enabled('proc-body')||workActive, blink: enabled('proc-blink')||workActive, work:workActive, speechRate:this.speechRate, workState:this.motionDirector.workState, reducedMotion:globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true, amp: ambientAmp });
    // Feed the rig's physics chain: without these inputs its 131 physics settings stay
    // still and only the head and ears appear to move.
    const body = this.bodyDirector.sample({ delta, state: this.previewMode ? 'idle' : interactionState, speechRate: this.speechRate, amp: ambientAmp });
    const gazeEyeX = gazeFrame && Number.isFinite(Number(gazeFrame.eyeX)) ? Number(gazeFrame.eyeX) : 0;
    const gazeEyeY = gazeFrame && Number.isFinite(Number(gazeFrame.eyeY)) ? Number(gazeFrame.eyeY) : 0;
    const gazeHeadX = gazeFrame && Number.isFinite(Number(gazeFrame.headX)) ? Number(gazeFrame.headX) : 0;
    const gazeHeadY = gazeFrame && Number.isFinite(Number(gazeFrame.headY)) ? Number(gazeFrame.headY) : 0;
    // ── 待机层偏置（P1.5）：只做「同一所有者内部的一个加法项」───────────────
    // 源值仍然完全由 body-director / interaction-motion / GazeFollow 决定；
    // ambient 不新增写者、不新开 set —— 它只改这一次写入的目标值。
    // 之所以等到这里才算：body/movement/gaze 都已就位，且必须在 body 与 head 两次
    // PROC_MOTION 写入之前共用同一份结果（两处各算一次会出现两个不同的偏置）。
    const ambOffset = this.previewMode ? null : this._ambientOffset;
    const ambBase = {
      breath: body.breath,
      bodyZ: body.bodyZ + body.idleBodyZ,
      headX: movement.yaw + body.idleX + gazeHeadX,
      headY: movement.pitch + body.idleY + gazeHeadY,
      headZ: movement.roll + body.idleZ,
      gazeX: movement.gazeX + gazeEyeX,
      gazeY: movement.gazeY + gazeEyeY,
      posX: body.posX + body.idlePosX,
      posZ: body.posZ,
    };
    const ambSpeaking = interactionState === 'speaking';
    const ambOut = applyAmbientOffsets(ambBase, ambOffset && ambOffset.bias, { speaking: ambSpeaking });
    const ambWriters = (enabled('proc-body') || workActive) || (enabled('proc-head') || workActive);
    this._ambientApplied = ambOffset && ambWriters
      ? { speaking: ambSpeaking, amp: ambOffset.amp, offsets: ambientOffsets(ambOffset.bias, { speaking: ambSpeaking }) }
      : null;
    if (enabled('proc-body') || workActive) {
      this.withOwner(LAYER.PROC_MOTION, () => {
        this.set('ParamBreath', ambOut.breath);
        // 待机小动作（歪头/换重心/耳朵抖/轻晃）的偏移量叠在基础摆动上。
        this.set('ParamBodyAngleZ', ambOut.bodyZ);
        this.set('HipAngleX', body.hipX); this.set('HipAngleY', body.hipY); this.set('HipAngleZ', body.hipZ + body.idleHipZ);
        this.set('LeanInput', body.lean);
        this.set('PositionX', ambOut.posX); this.set('PositionY', body.posY); this.set('PositionZ', ambOut.posZ);
        // ⚠ 2026-11-13：这里原来还有 `set('ShoulderY'/'ShoulderZ', …)` —— 这两个参数
        //   是 pet.physics3.json 的 **Output**，写在物理前必被物理覆盖（影子比对里就是
        //   那 2 处「白写」）。删掉，健康哨兵的 wasted 基线随之归 0，以后再出现白写就是新问题。
        this.set('LControl', body.earL + body.idleEar); this.set('RControl', body.earR - body.idleEar);
      });
    }
    if (enabled('proc-head') || workActive) {
      this.withOwner(LAYER.PROC_MOTION, () => {
        // 眼神/待机偏置直接并进同一路写入（不再单独写一遍，避免同帧同参数两次写触发冲突告警）
        this.set('ParamAngleX', ambOut.headX); this.set('ParamAngleY', ambOut.headY); this.set('ParamAngleZ', ambOut.headZ);
        this.set('ParamEyeBallX', ambOut.gazeX); this.set('ParamEyeBallY', ambOut.gazeY);
        // The accessory/second physics bank reads the controller layer, not the head bones.
        this.set('AngleX', ambOut.headX); this.set('AngleY', ambOut.headY); this.set('AngleZ', ambOut.headZ);
      });
    } else if (gazeFrame) {
      // 头/眼动画被关掉时仍然要跟鼠标（旧 GazeFollow 是无条件写的）
      this.withOwner('gaze', () => applyGazeOffsets({ get: (id) => this.get(id), set: (id, v) => this.set(id, v) }, gazeFrame));
    }
    if (workActive || enabled('proc-blink') && !this.previewMode) {
      this.withOwner(LAYER.BLINK, () => {
        this.set('ParamEyeLOpen', Math.min(this.get('ParamEyeLOpen'), 1 - movement.blink * .95));
        this.set('ParamEyeROpen', Math.min(this.get('ParamEyeROpen'), 1 - movement.blink * .95));
      });
    }
    // 动作层（挥手/点头/抚胸…）：先贴物理之前的那一份，物理才吃得到动作输入，
    // 头发/裙摆/尾巴会跟着动作甩。ParamBodyAngleX 在物理之后才写，单独在下面加。
    if (!this.previewMode) this.withOwner(LAYER.ACTION, () => this.applyActionLayer(this.motionDirector.sample({ delta }), 'pre'));
    if (this._physics) this._physics.evaluate(this._model, delta);
    // 物理"输出"参数（手臂关节等）物理会把它们写回去，所以动作的这部分要晚一步盖住。
    if (!this.previewMode) this.withOwner(LAYER.ACTION, () => this.applyActionLayer(this.motionDirector.layer, 'post'));
    // 表情层「物理输出参数」重放（2026-11-21 P1 browDown）：
    //   ParamBrowLAngle/RAngle 是 pet.physics3.json 的 Output（Setting 39/41 每帧重算覆盖）。
    //   只写 defaults（物理前喂）会被物理吃掉 → perf 的压眉主通道等于不存在。
    //   这里在物理之后把意图值放回去；物理前的 defaults 仍然照写，Shock/Emotion2 照样能读到。
    if (!this.previewMode && view && view.perfCommit && typeof view.perfCommit === 'object') {
      this.withOwner('perf-commit', () => {
        for (const id of Object.keys(view.perfCommit)) {
          const value = Number(view.perfCommit[id]);
          if (Number.isFinite(value)) this.set(id, value);
        }
      });
    }
    // Deliberate body movement layers after this model's physics; mouth remains last.
    // ParamBodyAngleX 在物理之后才写，所以待机轻晃和动作层的身体摆幅都在这里补。
    const actionBodyX = this.previewMode ? 0 : (this.motionDirector.layer.post.ParamBodyAngleX ?? 0);
    if (enabled('proc-body') || workActive) this.withOwner(LAYER.PROC_MOTION, () => this.set('ParamBodyAngleX', body.bodyX + movement.body + body.idleBodyX + actionBodyX));
    else if (actionBodyX) this.withOwner(LAYER.ACTION, () => this.set('ParamBodyAngleX', actionBodyX));
    if (this.previewMode) this.withOwner(LAYER.PREVIEW, () => this.blendParameters(this.previewParameters, this.previewValues, delta));
    // 嘴角弧度 ParamMouthForm 归「情绪层」所有：情绪引擎把目标值写进 defaults，
    // 这里只在情绪层没有接管时才给兜底值，否则每帧硬写 0 会把笑/撇嘴全部抹平。
    const mouthFormOwned = this.emotionOwnsParam && this.emotionOwnsParam('ParamMouthForm');
    if (!mouthFormOwned) this.withOwner(LAYER.BASELINE, () => this.set('ParamMouthForm', face === '脸红' ? .25 : 0));
    // 嘴型：0.75 次幂比 sqrt 更接近人说话的口型分布，上限压到 0.82 避免张太大；
    // 轻微叠一点 MouthForm，让开口时不是纯几何圆。
    const rawMouth = Math.max(0, Math.min(1, Number(view.mouth) || 0));
    const mouthOpen = active ? Math.min(0.82, Math.pow(rawMouth, 0.8) * (this.options.mouthGain ?? 0.95)) : 0;
    this.withOwner(LAYER.LIP, () => this.set('ParamMouthOpenY', mouthOpen));
    // ── 口型细化（2026-11-15，用户反馈「嘴型不太好」）────────────────────
    // 只驱 ParamMouthOpenY = 上下翻盖。这里补一层「音节级伪 viseme」：
    // 用几个不同频率的正弦（≈3–6Hz）驱动形状参数（funnel/pucker/widen/嘴角/下颌），
    // 幅度随说话能量缩放；不说话时全 0，不改变静息表情。
    if (active || mouthOpen > 0.005) {
      const t = this.elapsed;
      const amp = Math.min(1, rawMouth * 1.3);
      const syl = 0.5 + 0.5 * Math.sin(t * 18.5);
      const v1 = Math.sin(t * 11.3 + 1.7);
      const v2 = Math.sin(t * 7.9 + 0.6);
      this.withOwner(LAYER.MOUTH_VISEME, () => {
        this.set('ParamMouthForm', this.get('ParamMouthForm') + v1 * 0.10 * amp);
        this.set('MouthFunnel', this.get('MouthFunnel') + (0.25 + 0.25 * v2) * 0.40 * amp);
        this.set('MouthPuckerWiden', this.get('MouthPuckerWiden') + (0.5 - syl) * 0.30 * amp);
        this.set('MouthX', this.get('MouthX') + v2 * 0.06 * amp);
        this.set('MouthSmile_L', this.get('MouthSmile_L') + syl * 0.10 * amp);
        this.set('MouthSmile_R', this.get('MouthSmile_R') + (1 - syl) * 0.10 * amp);
        this.set('JawOpen', this.get('JawOpen') + mouthOpen * 0.35);
      });
    }
    // 2026-11-13：删掉 `this.set('fase80', 1)` —— 实测该参数在模型里**根本不存在**
    //   （parameterIndices 查不到、defaults 为 null、cdi3 里也没有），每帧都在调用一次
    //   注定失败的 set。注释说它是「模型水印开关」，但既然参数不存在，这个调用是纯浪费。
    // 注意：换装现在走「写参数 + 钉进 defaults」的方案（与 asset-toggles 一致），
    // 不再每帧做加法叠加——两套同时开会把值写两遍。
    //
    // ⚡ 性能（2026-11-08 实测）：_model.update() = 6.29ms/帧，占 updateView 的 59%
    // （Cubism 顶点变形 + 绘制网格重算；drawable 715 个）。16ms 预算里它吃掉 6.3ms，
    // 是帧率上不去的真正瓶颈（参数写入实测 0ms，不是瓶颈）。
    //
    // 策略：**静止时降频重算**。物理/呼吸是连续变化，但静止状态下顶点差异极小，
    // 每 3 帧算一次（20fps 的顶点更新）肉眼无差；一旦说话/有动作/张嘴立刻恢复每帧。
    // claimedIds 非空 = 动作层在演，必须每帧（否则动作卡顿）。
    // 2026-11-08 修正：初版把 `_motionManager.isFinished()` 也算 busy，
    // 但待机动作是**循环播放**的 → 永远没结束 → busy 恒 true，降频完全被绕过（实测 updateView 仍 11ms）。
    // 正确口径：只有「会被用户看到差异」的活动才算 busy——
    //   说话/张嘴、动作层抢参数、非待机的主动动作（Tap/手势）。
    // 待机呼吸的幅度在 1/3 帧率下肉眼无差，正该降频。
    const motionBusy = (this.motionDirector && this.motionDirector.claimedIds && this.motionDirector.claimedIds.size > 0)
      || (this._mainMotionPlaying === true);
    const busy = this.speechRate > 0.001 || (view.mouth > 0.001) || motionBusy || (this._gazeQuiet === false);

    // ── 待机帧率（2026-11-09 三次修正：用户实测反馈「待机帧数太小看起来卡」为最高优先）──
    // 历次教训：每 5 帧(12fps)/每 3 帧(20fps) 都被用户看出卡；根源是「顶点重算被跳过时，
    // 画面上呼吸/微动作是原地停住的」——人眼对这种停顿很敏感，比 CPU 占用重要得多。
    // 现在的策略：**默认每帧**（60fps 顶点更新，绝不卡）；只有两种情形才降：
    //   ① 用户明确开了省电（ui.petbody_power_save === true）→ 每 3 帧
    //   ② 自适应：连续多次 update 耗时 > 12ms（低配机/GPU 被游戏占用），自动退到每 2 帧，
    //      并在耗时回落到 8ms 以下持续 3 秒后自动恢复每帧（不会永久降级）
    // 眼神移动/说话/动作/表情一律 busy → 强制每帧（跟手优先）。
    const cost = this._updateCostMs || 0;
    const nowMs = now;
    if (cost > 12) { this._slowSince = this._slowSince || nowMs; }
    else if (cost < 8) { this._fastSince = this._fastSince || nowMs; }
    let autoEvery = this._autoEvery || 1;
    if (cost > 12 && nowMs - (this._slowSince || nowMs) > 600) { autoEvery = 2; this._fastSince = null; }
    if (autoEvery > 1 && cost < 8 && nowMs - (this._fastSince || nowMs) > 3000) { autoEvery = 1; this._slowSince = null; }
    this._autoEvery = autoEvery;

    // 省电：settings 里的固定开关（用户手动）或**游戏自动检测**（主进程 setPowerSave 动态切）。
    // _autoPowerSave 由外层每秒检测前台应用后调用，优先级高于固定开关。
    const powerSave = this._autoPowerSave === true || this.options?.powerSave === true;
    const updateEvery = busy ? 1 : (powerSave ? 3 : autoEvery);
    this._updateSkip = busy ? 0 : ((this._updateSkip || 0) + 1);
    let doUpdate = busy || this._updateSkip >= updateEvery;

    // ── 表演层（2026-11-15）：外部传入的偏置，必须在 model.update() **之前**叠加，
    //    否则写进去的值不会参与这一帧的顶点重算（表现就是「参数里有值、画面不动」）。
    //
    //    两条通道，语义不同（v2 长表演的裁决，别混用）：
    //      view.choreo          —— 加法偏置。适合角度/位置这类「再歪一点」的量，
    //                              写 Angle* 会进物理链，头发/耳朵/裙摆跟着甩。
    //      view.choreoOverride  —— 权重混合覆盖（get*(1-w)+target*w）。适合眼/嘴/眉/换装
    //                              这类归一化参数：写加法会出错（待机眨眼把 ParamEyeLOpen
    //                              乘到 0，再 +1 就等于「睁眼」，闭眼动作被取消）。
    //
    //    A/B 实测结论（2026-11-15 真机，不是推测）：
    //      只写 AngleX 走物理链 → AngleX=-18.68，但物理算出的 ParamAngleX 只有 -0.47，
    //      头部几乎不动（物理对大幅快速输入有严重滞后与衰减）。观众只看得到骨头，
    //      所以物理链**不能单独用**。
    //      只写 ParamAngleX 直改骨头 → 头部跟手，但二级物理（头发/耳/裙摆）不动。
    //      ⇒ 默认「双写」：Angle* 进物理链（配件自然甩）+ ParamAngle* 直改（跟手）。
    //         choreoAngleDirect=true 只关掉物理输入那一半（诊断/对比用）。
    if (view && view.choreo && typeof view.choreo === 'object') {
      const onlyDirect = this.choreoAngleDirect === true;
      this.withOwner(LAYER.CHOREO, () => {
        for (const pid of Object.keys(view.choreo)) {
          const off = Number(view.choreo[pid]) || 0;
          if (Math.abs(off) < 1e-4) continue;
          if (pid === 'AngleX' || pid === 'AngleY' || pid === 'AngleZ') {
            // 物理输入：头发/耳朵/裙摆会跟着甩（但它自己有惯性，骨头跟不上）
            if (!onlyDirect) this.set(pid, (this.get(pid) || 0) + off);
            // 骨头：物理之后直接覆盖，保证眼睛看得见「她在动」
            const bone = 'Param' + pid;
            this.set(bone, (this.get(bone) || 0) + off);
          } else {
            this.set(pid, (this.get(pid) || 0) + off);
          }
        }
      });
    }
    if (view && view.choreoOverride && typeof view.choreoOverride === 'object') {
      const w = Math.max(0, Math.min(1, Number(view.choreoOverrideW) || 0));
      if (w > 1e-4) {
        this.withOwner(LAYER.PERF_OVERRIDE, () => {
          for (const pid of Object.keys(view.choreoOverride)) {
            const tv = Number(view.choreoOverride[pid]);
            if (!Number.isFinite(tv)) continue;
            const cv = this.get(pid) || 0;
            this.set(pid, cv + (tv - cv) * w);
          }
        });
      }
    }

    // ── 脏帧检测（2026-11-09）：参数完全没变就跳过顶点重算 ──────────────────
    // 待机时呼吸/微动作幅度极小，很多帧的参数与上一帧几乎一致（差 < 0.001）。
    // 实测遍历 509 个参数只要 0.01ms，而一次 _model.update() 要 7ms ——
    // 用 0.01ms 换掉 7ms，且**画面完全不变**（因为参数真的没变），是纯赢。
    // 阈值 0.0015：比呼吸单帧变化量略小，保证真在动时不会误跳过。
    if (doUpdate && !busy) {
      const vals = this._model.getModel().parameters.values;
      const prev = this._paramSnap;
      let changed = false;
      if (!prev || prev.length !== vals.length) {
        this._paramSnap = Array.prototype.slice.call(vals);
        changed = true;
      } else {
        for (let i = 0; i < vals.length; i += 1) {
          const d = vals[i] - prev[i];
          if (d > 0.0015 || d < -0.0015) { changed = true; break; }
        }
        if (changed) this._paramSnap = Array.prototype.slice.call(vals);
      }
      if (!changed) doUpdate = false;   // 参数没变 → 不重算也不重绘（复用上一帧画面）
    }

    if (doUpdate) {
      this._updateSkip = 0;
      const _t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      this._model.update();
    this._flushParamConflicts();
    this._flushShadowTarget();
      const _dt = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - _t0;
      // 指数平滑，避免单帧抖动误触发降级
      this._updateCostMs = (this._updateCostMs == null) ? _dt : (this._updateCostMs * 0.8 + _dt * 0.2);
    }
    // 只有真重算过才重绘：跳过 update 却仍 draw 等于白白占用 GPU（画面还是旧帧）。
    // 返回 false 让调用方知道这一帧没产出新画面。
    for (const id of this.hiddenPartIds) { try { this._model.setPartOpacityById(id, 0); } catch {} }
    if (this.hideDrawableIds.length) { const dw = this._model.getModel().drawables; for (const i of this.hideDrawableIds) { try { dw.opacities[i] = 0; } catch {} } }
    if (this.forceShowIds.length) { const dw = this._model.getModel().drawables; for (const i of this.forceShowIds) { try { dw.opacities[i] = 1; } catch {} } }
    if (doUpdate) this.draw();
    return doUpdate;
  }
  /**
   * 游戏自动省电开关（2026-11-09）：主进程检测到前台是游戏/全屏应用时调用传 true。
   * true → 待机降到每 3 帧重算（让出 CPU/GPU 给游戏）；false → 满帧。
   * 说话/动作/表情期间不受影响（busy 恒每帧）。
   */
  setPowerSave(on) {
    const v = on === true;
    if (this._autoPowerSave === v) return;
    this._autoPowerSave = v;
    this._updateSkip = 0;
  }
  setFraming(mode) {
    if (!['full', 'half'].includes(mode) || this.framing === mode && this.projection) return;
    if (mode === 'full') this.feather?.releaseTexture();
    this.framing = mode; this.syncViewport(true);
  }
  syncViewport(force = false) {
    if (!this.canvas) return;
    // 渲染倍率：跟设备像素 1:1 最锐。1x 屏保留 2x 超采（大纹理的 AA 就是按它设计的）；
    // 但 1.25/1.5/1.75 这类分数缩放屏若也超采到 2x，浏览器会把 canvas 非整数下采样
    // （如 2.0→1.5 每像素 0.75 重采样）—— 用户实测「皮套有点糊」的根因就是它。
    // 分数缩放屏一律按物理像素 1:1 渲染，杜绝重采样。
    const raw = globalThis.devicePixelRatio || 1;
    const dpr = raw >= 1.25 ? raw : 2;
    // 2026-11-22 性能：gl.getParameter 每帧一次是同步 GL 查询（命令缓冲往返），
    // 而 MAX_RENDERBUFFER_SIZE 是常量；缓存它，别放在每帧热路径里。
    if (this._maxRenderbufferSize == null) {
      this._maxRenderbufferSize = this.gl?.getParameter(this.gl.MAX_RENDERBUFFER_SIZE) || 4096;
    }
    const limit = this._maxRenderbufferSize;
    const scale = Math.min(dpr, limit / Math.max(1, this.canvas.clientWidth, this.canvas.clientHeight));
    const width = Math.max(1, Math.round(this.canvas.clientWidth * scale)), height = Math.max(1, Math.round(this.canvas.clientHeight * scale));
    if (!force && this.canvas.width === width && this.canvas.height === height) return;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
      this.setRenderTargetSize(width, height);
    }
    if (!this._modelMatrix) return;
    const zoom = this.framing === 'half' ? (this.options.halfZoom ?? 2.55) : 1;
    this.projection = new CubismMatrix44();
    this.projection.scale(height / width * zoom, zoom); this.projection.multiplyByMatrix(this._modelMatrix);
    if (this.framing === 'half') this.projection.translateY(this.options.halfShiftY ?? -1.02);
  }
  draw() {
    this.syncViewport();
    const gl = this.gl; gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    // 复用 viewport 数组：每帧 new 一个小数组在 60fps 下是纯 GC 噪音。
    const vp = this._renderStateViewport || (this._renderStateViewport = [0, 0, 0, 0]);
    vp[2] = this.canvas.width; vp[3] = this.canvas.height;
    this.getRenderer().setMvpMatrix(this.projection); this.getRenderer().setRenderState(null, vp); this.getRenderer().drawModel();
    if (this.framing === 'half') {
      this.feather ??= new ModelFeather(gl);
      if (!this.feather.apply(this.canvas) && !this.featherWarning) {
        this.featherWarning = true; this.report({ type: 'model-feather-unavailable', reason: this.feather.status });
      }
    }
  }
  snapshot() { return { mouth: this.get('ParamMouthOpenY'), body: this.get('ParamBodyAngleX'), face: this.faceKey, gesture: this.gestureKey, breath: this.get('ParamBreath'), action: this.motionDirector.name, actionEnvelope: +this.motionDirector.envelope.toFixed(3), speechRate: +this.speechRate.toFixed(3) }; }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.ready = false; this.feather?.dispose();
    this.motionDirector.reset();
    this.gestureManager.stopAllMotions(); this.gestureManager.release(); this.previewManager.stopAllMotions(); this.previewManager.release();
    for (const tex of this.textures) this.gl?.deleteTexture(tex);
    this.textures = []; this.expressions.clear(); this.previewValues.clear(); this.release();
    // The SDK renderer releases buffers/masks, but shader programs belong to its
    // context manager. Release that manager after our last canvas is disposed.
    if (webglOwners.delete(this) && webglOwners.size === 0) CubismShaderManager_WebGL.deleteInstance();
  }
}
