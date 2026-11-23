// compiler.mjs —— 语义动作 → 参数轨道（MVL 编译器，移植自 jingyu-live2d-agent/compiler.py）
//
// 为什么要有它（2026-11-12 调研结论）：
//   现在的「演一段」是 SCENES 里一堆 setTimeout 硬编码顺序，演到哪算哪、失败不报错。
//   jingyu 的贡献不是用了什么语言，而是把「演什么」变成**可校验的中间表示**：
//   编译期就把「参数不存在 / 写了物理输出 / 值越界 / 时间重叠 / 太长」全部拒掉，
//   而且**每段轨道首尾自动回默认值**（"演完回正"不靠运行时 TTL）。
//
// 本文件只做「编译」，不做播放；播放由渲染层消费 tracks（P1-6/7 再接）。
// 纯函数、无外部依赖，node --test 可跑。

export class CompileError extends Error {
  constructor(code, message, detail) {
    super(`[${code}] ${message}`);
    this.code = code;
    this.detail = detail || null;
  }
}

export const ACTION_TYPES = Object.freeze([
  'trajectory', 'look', 'nod', 'shake_head', 'tilt',
  'smile', 'blink', 'expression', 'gesture', 'pose',
]);

const MIN_KEY_GAP = 0.08;     // 关键帧最小间隔（秒）——再密就是抖动，不是表演
const MAX_DURATION = 60;      // 单段动作总长上限

/** 缓动（与 jingyu 的 ease 名称对齐，未知名称按 linear 处理，不报错） */
export function ease(name, t) {
  const x = Math.max(0, Math.min(1, Number(t) || 0));
  switch (String(name || 'linear')) {
    case 'smoothstep': return x * x * (3 - 2 * x);
    case 'easeIn': return x * x;
    case 'easeOut': return 1 - (1 - x) * (1 - x);
    case 'easeInOut': return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    default: return x;
  }
}

/**
 * 编译一段动作。
 * @param {{type:string, duration?:number, keys?:Array, params?:object, name?:string}} spec
 * @param {{paramIds:Set<string>, ranges?:Map<string,[number,number]>, defaults?:Map<string,number>,
 *          isPhysicsOutput?:(id:string)=>boolean, hasMotion?:(name:string)=>boolean}} ctx
 * @returns {{action:string, duration:number, tracks:Array<{param:string, keys:Array}>}}
 */
export function compileAction(spec, ctx) {
  if (!spec || typeof spec !== 'object') throw new CompileError('BAD_SPEC', '动作必须是对象');
  const type = String(spec.type || '');
  if (!ACTION_TYPES.includes(type)) {
    throw new CompileError('UNKNOWN_TYPE', `未知动作类型「${type}」，可用：${ACTION_TYPES.join('/')}`);
  }
  const paramIds = ctx && ctx.paramIds instanceof Set ? ctx.paramIds : new Set((ctx && ctx.paramIds) || []);
  const ranges = (ctx && ctx.ranges) || new Map();
  const defaults = (ctx && ctx.defaults) || new Map();
  const isPhysicsOutput = (ctx && ctx.isPhysicsOutput) || (() => false);

  const tracksIn = normalizeTracks(spec);
  if (!tracksIn.length) throw new CompileError('NO_TRACKS', '动作没有任何参数轨道');

  const duration = Number(spec.duration) || inferDuration(tracksIn);
  if (!(duration > 0)) throw new CompileError('BAD_DURATION', '时长必须 > 0');
  if (duration > MAX_DURATION) throw new CompileError('TOO_LONG', `总长 ${duration.toFixed(2)}s 超过上限 ${MAX_DURATION}s`);

  const tracks = [];
  const seen = new Map();          // param → 已占用区间列表

  for (const track of tracksIn) {
    const param = String(track.param || '');
    if (!param) throw new CompileError('BAD_TRACK', '轨道缺少 param');
    if (!paramIds.has(param)) throw new CompileError('MISSING_PARAM', `模型没有参数「${param}」`, { param });
    if (isPhysicsOutput(param)) {
      throw new CompileError('PHYSICS_OUTPUT', `「${param}」是物理输出，不能直接写（会被物理层覆盖）`, { param });
    }

    const [lo, hi] = ranges.get(param) || [-1, 1];
    const def = defaults.has(param) ? defaults.get(param) : (lo <= 0 && hi >= 0 ? 0 : lo);
    const keys = normalizeKeys(track, duration);

    let prevT = -Infinity;
    for (const k of keys) {
      if (!(k.t >= 0) || k.t > duration + 1e-9) {
        throw new CompileError('KEY_OUT_OF_RANGE', `「${param}」关键帧时间 ${k.t}s 超出 0..${duration}s`, { param, t: k.t });
      }
      if (k.t - prevT < MIN_KEY_GAP - 1e-9 && prevT >= 0) {
        throw new CompileError('KEY_TOO_DENSE', `「${param}」关键帧间隔 ${(k.t - prevT).toFixed(3)}s < ${MIN_KEY_GAP}s`, { param });
      }
      if (k.v < lo - 1e-6 || k.v > hi + 1e-6) {
        throw new CompileError('VALUE_OUT_OF_RANGE', `「${param}」值 ${k.v} 超出范围 [${lo}, ${hi}]`, { param, value: k.v });
      }
      prevT = k.t;
    }

    // 同参数时间重叠 = 两个动作抢同一个通道（jingyu 的硬约束）
    const range = [keys[0].t, keys[keys.length - 1].t];
    const occupied = seen.get(param) || [];
    for (const r of occupied) {
      if (range[0] < r[1] - 1e-9 && r[0] < range[1] - 1e-9) {
        throw new CompileError('OVERLAP', `「${param}」在同一段时间被两条轨道写（${r[0]}..${r[1]} 与 ${range[0]}..${range[1]}）`, { param });
      }
    }
    occupied.push(range);
    seen.set(param, occupied);

    tracks.push({ param, keys: withReturnToNeutral(keys, duration, def) });
  }

  return { action: type, name: spec.name || null, duration, tracks };
}

function normalizeTracks(spec) {
  if (Array.isArray(spec.tracks)) return spec.tracks.map((t) => ({ ...t }));
  // 简写：params: { ParamAngleX: [[t,v], ...], ... }
  if (spec.params && typeof spec.params === 'object') {
    return Object.entries(spec.params).map(([param, keys]) => ({ param, keys }));
  }
  if (Array.isArray(spec.keys)) return [{ param: spec.param, keys: spec.keys }];
  return [];
}

function normalizeKeys(track, duration) {
  const raw = Array.isArray(track.keys) ? track.keys : [];
  if (raw.length < 1) throw new CompileError('NO_KEYS', `「${track.param || '?'}」没有关键帧`);
  const keys = raw.map((k) => {
    if (Array.isArray(k)) return { t: Number(k[0]), v: Number(k[1]), ease: k[2] || 'linear' };
    return { t: Number(k.t), v: Number(k.v), ease: k.ease || 'linear' };
  });
  keys.sort((a, b) => a.t - b.t);
  for (const k of keys) {
    if (!Number.isFinite(k.t) || !Number.isFinite(k.v)) {
      throw new CompileError('BAD_KEY', `「${track.param}」有关键帧不是数字`, { param: track.param });
    }
  }
  // 只写一个关键帧时补到 0 与 duration，避免「瞬间跳变」
  if (keys.length === 1) {
    const only = keys[0];
    if (only.t > 0) keys.unshift({ t: 0, v: only.v, ease: only.ease });
    if (only.t < duration) keys.push({ t: duration, v: only.v, ease: only.ease });
  }
  return keys;
}

/** 首尾回默认值：演完回正由编译期保证（jingyu 的核心约束） */
function withReturnToNeutral(keys, duration, def) {
  const out = keys.map((k) => ({ ...k }));
  if (out[0].t > 1e-6) out.unshift({ t: 0, v: def, ease: out[0].ease });
  else out[0] = { ...out[0], v: out[0].v };   // 起点就是 0 时保留用户值（可做「从当前姿态开始」）
  if (out[out.length - 1].t < duration - 1e-6) {
    out.push({ t: duration, v: def, ease: 'smoothstep' });
  }
  return out;
}

function inferDuration(tracks) {
  let max = 0;
  for (const t of tracks) {
    for (const k of t.keys || []) {
      const time = Array.isArray(k) ? Number(k[0]) : Number(k.t);
      if (Number.isFinite(time)) max = Math.max(max, time);
    }
  }
  return max;
}
