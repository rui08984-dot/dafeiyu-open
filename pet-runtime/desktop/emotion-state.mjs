// emotion-state.mjs —— 情绪状态契约（参考上游 emotion-state 契约的思想）
//
// 解决什么问题（2026-11-12 调研结论）：
//   她的情绪只活在渲染进程的内存 state 里，**重启即失、跨窗口不可见**。
//   而且「用户心情」和「她自己的心情」混在一个变量里，没法各自演进。
//
// 四条核心约束（都是上游实现踩过的坑）：
//   ① 双主体：user（用户）/ companion（她），各自独立 revision 与 CAS
//   ② **标签与强度分开**：label='angry' ≠ intensity=0.9（"类别"不能当"幅度"）
//   ③ 证据链：每条观察带 provenance（用户明说 / 近期上下文 / 音频 / 视频 / 她的推断）
//   ④ revision CAS：迟到的推断（旧 revision）必须标 stale，**不许覆盖新状态**
//
// 纯函数、无 IO、无外部依赖 —— node --test / 单测直接跑；存储接入由调用方负责。

export const SUBJECTS = Object.freeze(['user', 'companion']);

export const PROVENANCE = Object.freeze([
  'user_explicit',        // 用户原话（最高可信）
  'text_recent_context',  // 近期对话文本推断
  'audio',                // 声学（SER）
  'video',                // 视觉
  'companion_inference',  // 她自己的推断（最低可信）
]);

// 可信度先验：同一强度下，用户明说 > 文本 > 音频/视觉 > 她的推断
const TRUST = Object.freeze({
  user_explicit: 1.0,
  text_recent_context: 0.8,
  audio: 0.7,
  video: 0.6,
  companion_inference: 0.45,
});

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** 空状态：两个主体各一份，revision 从 0 起 */
export function createState(now) {
  const t = Number(now) || 0;
  const blank = () => ({
    label: 'neutral',
    intensity: 0,
    confidence: 0,
    provenance: null,
    revision: 0,
    updatedAt: t,
    sources: [],
  });
  return { user: blank(), companion: blank() };
}

/**
 * 造一条观察（不写状态）。
 * @returns {{ok:true, observation:object}|{ok:false, reason:string}}
 */
export function observe(subject, input) {
  if (!SUBJECTS.includes(subject)) return { ok: false, reason: 'unknown_subject' };
  const o = input || {};
  const label = String(o.label || '').trim();
  if (!label) return { ok: false, reason: 'empty_label' };
  if (o.provenance && !PROVENANCE.includes(o.provenance)) return { ok: false, reason: 'unknown_provenance' };
  if (!Number.isFinite(Number(o.confidence)) && o.confidence !== undefined) {
    return { ok: false, reason: 'bad_confidence' };
  }
  const intensity = o.intensity === null || o.intensity === undefined ? null : clamp01(o.intensity);
  return {
    ok: true,
    observation: {
      subject,
      label,
      intensity,                                   // null = 只知道类别、不知道幅度
      confidence: clamp01(o.confidence === undefined ? 1 : o.confidence),
      provenance: o.provenance || 'companion_inference',
      at: Number(o.at) || 0,
      source: o.source ? String(o.source).slice(0, 64) : null,
    },
  };
}

/**
 * 应用一条观察（CAS）。revision 不符 → stale，原状态原样返回。
 * @returns {{state:object, applied:boolean, reason?:string}}
 */
export function apply(state, observation, opts) {
  const s = state || createState();
  const ob = observation || {};
  const subject = ob.subject;
  if (!SUBJECTS.includes(subject)) return { state: s, applied: false, reason: 'unknown_subject' };
  const cur = s[subject];
  const expected = opts && Number.isFinite(Number(opts.expectedRevision))
    ? Number(opts.expectedRevision)
    : cur.revision;
  if (expected !== cur.revision) {
    // 迟到的推断：不许覆盖新状态
    return { state: s, applied: false, reason: 'stale' };
  }
  const trust = TRUST[ob.provenance] || 0.45;
  // 置信度 = 来源可信度 × 观察置信度；低于 0.25 的不改状态（避免噪声抖脸）
  const conf = trust * clamp01(ob.confidence);
  if (conf < 0.25) return { state: s, applied: false, reason: 'low_confidence' };

  const intensity = ob.intensity === null || ob.intensity === undefined
    ? (cur.label === ob.label ? cur.intensity : 0.5)     // 只知道类别时给中性幅度，不沿用旧幅度
    : clamp01(ob.intensity);

  const next = {
    ...s,
    [subject]: {
      label: ob.label,
      intensity,
      confidence: conf,
      provenance: ob.provenance,
      revision: cur.revision + 1,
      updatedAt: ob.at || cur.updatedAt,
      // 证据链只留最近 5 条，防无限增长
      sources: [
        { provenance: ob.provenance, label: ob.label, intensity, confidence: conf, at: ob.at || 0, source: ob.source },
        ...(cur.sources || []),
      ].slice(0, 5),
    },
  };
  return { state: next, applied: true };
}

/** 合并两份状态（跨进程/跨窗口）：每个主体取 revision 大的，相同则取 updatedAt 晚的 */
export function merge(a, b) {
  const out = createState();
  for (const subject of SUBJECTS) {
    const x = (a && a[subject]) || null;
    const y = (b && b[subject]) || null;
    if (!x && !y) continue;
    if (!x) { out[subject] = { ...y }; continue; }
    if (!y) { out[subject] = { ...x }; continue; }
    const pick = (y.revision > x.revision) || (y.revision === x.revision && (y.updatedAt || 0) > (x.updatedAt || 0))
      ? y : x;
    out[subject] = { ...pick };
  }
  return out;
}

/**
 * 时间衰减：情绪会凉。半衰期按主体不同（她的情绪比用户情绪衰减快）。
 * 返回新状态，不改入参。
 */
export function decay(state, now, halfLifeSec) {
  const s = state || createState();
  const t = Number(now) || 0;
  const hl = Number(halfLifeSec) > 0 ? Number(halfLifeSec) : 300;
  const out = { ...s };
  for (const subject of SUBJECTS) {
    const cur = s[subject];
    if (!cur) continue;
    // 注意：updatedAt 可能合法地等于 0（epoch 起点），不能用 || 兜底，否则永远算成 dt=0
    const last = Number.isFinite(cur.updatedAt) ? cur.updatedAt : t;
    const dt = Math.max(0, (t - last) / 1000);
    if (!dt) { out[subject] = { ...cur }; continue; }
    const keep = Math.pow(0.5, dt / hl);
    out[subject] = { ...cur, intensity: clamp01(cur.intensity * keep), updatedAt: t };
  }
  return out;
}

/** 导出给提示词/面板用的一行摘要 */
export function describe(state) {
  const s = state || createState();
  const part = (x) => (x && x.intensity > 0.05 ? `${x.label}(${Math.round(x.intensity * 100)}%)` : '平静');
  return `用户：${part(s.user)} ｜ 她：${part(s.companion)}`;
}
