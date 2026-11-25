// program-runner.mjs —— 节目单运行器（P3a，ADR-015 §3.5「组件五：节目单」）
//
// 一句话：把「几段长表演 + 台词 + 音效」串成**一次事件**，而不是把单段拉长。
//
// 为什么是这个形状（ADR §3.5 + 调研 §12B）：
//   · 单条 45–90 秒、最多 3 段 —— 需要「换段」这件事，而换段必须是**收势后**换，
//     不是一帧硬切（硬切正是「不像人」的一半，见 ADR §1.2 / 审计 §1.5）。
//   · 句边界天然是 sync point（Open-LLM-VTuber 的句子流水线，MIT：并行合成、串行交付）。
//     我们这里按 beat 串行：一句台词说完 = 一个 relax，用户这时开口就能停在这里。
//   · 抢占/收势/排队**不在这里实现**，全部交给 perf-scheduler（它才是「什么时候换人」）。
//     运行器只向调度器要一个 owner:'program' 的 claim，然后在 claim 内按 beat 播放。
//
// 纯依赖注入（不 require fs / electron / DOM）：
//   { now, scheduler, programs, playSegment, fadeOut, speak, sfx, log, telemetry,
//     budget, syncFor, relaxMsFor, segmentDurationMs, wait, pollMs, tickMs, startWaitMs }
//
// 与调度器的约定：
//   scheduler.request({owner:'program', kind:'segmented', sync: syncFor(firstSeg),
//                      maxMs: totalMs, preempt:false})
//   —— program 的优先级是 4（低于显式手动 5、高于 clip 3 / v2 2），所以：
//      用户手点场景/长表演能立刻收势顶掉节目单；自动层（clip/v2）只能在我们的 relax 点抢。
//   节目单结束（自然/被打断/超预算）一律 scheduler.finish(token, {endedBy})。
//
// 超时一律「不卡死」：台词等 maxMs/2，到点继续下一步（记 line-timeout 遥测）。

/** 节目单硬上限（ADR §3.5：单条 45–90 秒、最多 3 段） */
export const PROGRAM_LIMITS = Object.freeze({
  maxBeats: 3,
  totalMs: 90000,
  lineChars: 60,
  beatMinMs: 500,
  beatMaxMs: 30000,
  transitionMaxMs: 2000,
});

/** 段间默认过渡时长（ADR §3.5 示例用 400ms） */
export const DEFAULT_TRANSITION_MS = 400;
/** 用户输入/手动停止时的收势时长（ADR §3.5：下一 relax 点 fadeOut(400)） */
export const INTERRUPT_FADE_MS = 400;
/** 台词说完后再留一点「余韵」才换段；这也是一个 relax 点 */
export const LINE_TAIL_MS = 800;
/**
 * 段时长地板比例（2026-11-25 真机试修）：
 * beat 实际等待 ≥ min(beatMax, beatMax × 0.6)。理由是「段是表演，台词只是它的音轨」——
 * TTS 静音/短句时不能把 14s 的叙事段压成 800ms。可用 minBeatMs 覆盖（0 = 旧行为）。
 */
export const MIN_BEAT_RATIO = 0.6;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function charLen(s) {
  // 按码点计（中文/emoji 都算 1 个字）；Array.from 对 60 字量级完全够用
  try { return Array.from(String(s || '')).length; } catch (e) { return String(s || '').length; }
}

/**
 * 校验一条节目单（schema + 段 key + 时长 + 段数 + 台词长度）。
 * 运行时不强依赖（数据是离线产物），但 check-programs 与单测都走这一个函数。
 *
 * @param {object} program
 * @param {{isKnownSegment?:(seg:string)=>boolean, isDuplicateId?:()=>boolean}} [opts]
 * @returns {{ok:boolean, errors:string[], id:string, totalMs:number, beats:object[]}}
 */
export function validateProgram(program, opts = {}) {
  const errors = [];
  const p = program && typeof program === 'object' && !Array.isArray(program) ? program : null;
  if (!p) return { ok: false, errors: ['节目单必须是对象'], id: '', totalMs: 0, beats: [] };
  const id = String(p.id == null ? '' : p.id).trim();
  if (!id) errors.push('缺少 id');
  else if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) errors.push('id 只能含字母/数字/._-：' + id);
  else if (id.length > 64) errors.push('id 过长（≤64）：' + id);
  if (p.title != null && typeof p.title !== 'string') errors.push('title 必须是字符串');
  if (typeof p.title === 'string' && charLen(p.title) > 40) errors.push('title 过长（≤40 字）');
  if (p.license != null && String(p.license) !== 'original') {
    errors.push('license 必须是 original（新台词必须原创，见 ADR §10）');
  }

  const beats = Array.isArray(p.beats) ? p.beats : null;
  if (!beats || !beats.length) {
    errors.push('beats 必须是非空数组');
    return { ok: false, errors, id, totalMs: 0, beats: [] };
  }
  if (beats.length > PROGRAM_LIMITS.maxBeats) {
    errors.push('段数 ' + beats.length + ' 超过上限 ' + PROGRAM_LIMITS.maxBeats);
  }

  const known = typeof opts.isKnownSegment === 'function' ? opts.isKnownSegment : null;
  const out = [];
  let totalMs = 0;
  beats.forEach((raw, i) => {
    const where = 'beats[' + i + ']';
    const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!b) { errors.push(where + ' 必须是对象'); return; }
    const seg = String(b.seg == null ? '' : b.seg).trim();
    if (!seg) errors.push(where + '.seg 必填');
    else if (known && !known(seg)) errors.push(where + '.seg 不在 CHOREO_DATA：' + seg);

    const maxMs = Number(b.maxMs);
    if (!Number.isFinite(maxMs)) errors.push(where + '.maxMs 必须是数字');
    else if (maxMs < PROGRAM_LIMITS.beatMinMs || maxMs > PROGRAM_LIMITS.beatMaxMs) {
      errors.push(where + '.maxMs 必须在 ' + PROGRAM_LIMITS.beatMinMs + '–' + PROGRAM_LIMITS.beatMaxMs + 'ms');
    }

    if (b.line != null) {
      if (typeof b.line !== 'string') errors.push(where + '.line 必须是字符串');
      else {
        if (charLen(b.line) > PROGRAM_LIMITS.lineChars) {
          errors.push(where + '.line 超过 ' + PROGRAM_LIMITS.lineChars + ' 字（' + charLen(b.line) + '）');
        }
        if (/[\r\n]/.test(b.line)) errors.push(where + '.line 不能含换行');
        if (!String(b.line).trim()) errors.push(where + '.line 不能是空串');
      }
    }
    if (b.transitionMs != null) {
      const tr = Number(b.transitionMs);
      if (!Number.isFinite(tr) || tr < 0 || tr > PROGRAM_LIMITS.transitionMaxMs) {
        errors.push(where + '.transitionMs 必须在 0–' + PROGRAM_LIMITS.transitionMaxMs + 'ms');
      }
    }
    if (b.sfx != null) {
      const sfx = String(b.sfx);
      if (!/^[0-9A-Za-z_-]{1,16}$/.test(sfx)) errors.push(where + '.sfx 只允许短 id（如 "07"）');
    }
    const eff = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 0;
    totalMs += eff;
    out.push({
      seg, maxMs: eff,
      line: b.line == null ? '' : String(b.line),
      sfx: b.sfx == null ? '' : String(b.sfx),
      transitionMs: Number.isFinite(Number(b.transitionMs)) ? Number(b.transitionMs) : DEFAULT_TRANSITION_MS,
    });
  });

  // 总时长按「每段 maxMs」计 —— 这是调度器真正会占用的上限（段素材可能更长，但会被 maxMs 截断）
  if (totalMs > PROGRAM_LIMITS.totalMs) {
    errors.push('总时长 ' + Math.round(totalMs / 100) / 10 + 's 超过上限 ' + (PROGRAM_LIMITS.totalMs / 1000) + 's');
  }
  return { ok: errors.length === 0, errors, id, totalMs, beats: out };
}

/** 把各种入参（数组 / Map / 数组包一层）规整成 Map<id, program> */
export function normalizePrograms(input) {
  const map = new Map();
  const add = (raw) => {
    if (!raw || typeof raw !== 'object') return;
    const id = String(raw.id == null ? '' : raw.id).trim();
    if (!id) return;
    if (map.has(id)) return;   // 先到先得，重复 id 由 check-programs 报错
    map.set(id, raw);
  };
  if (Array.isArray(input)) input.forEach(add);
  else if (input instanceof Map) input.forEach((v) => add(v));
  else if (input && typeof input === 'object' && Array.isArray(input.items)) input.items.forEach(add);
  return map;
}

/**
 * 建一个节目单运行器。
 *
 * @param {{
 *   now?:()=>number,
 *   scheduler:object,                          // perf-scheduler 实例（必需）
 *   programs?:object[]|Map<string,object>,
 *   playSegment?:(seg:string, ctx:object)=>boolean|Promise<boolean>,
 *   fadeOut?:(ms:number)=>void|Promise<void>,
 *   speak?:(line:string, ctx:object)=>Promise<any>,
 *   sfx?:(id:string, ctx:object)=>void,
 *   log?:(line:string)=>void,
 *   telemetry?:(evt:object)=>void,
 *   budget?:{takeProgram?:()=>any, releaseProgram?:()=>void, left?:()=>number},
 *   syncFor?:(seg:string)=>object|null,
 *   relaxMsFor?:(seg:string)=>number[]|null,
 *   segmentDurationMs?:(seg:string)=>number,
 *   minBeatMs?:number,                         // 段时长地板（默认 0.6×beatMax；见下）
 *   wait?:(ms:number)=>Promise<any>,
 *   pollMs?:number, tickMs?:number, startWaitMs?:number,
 * }} deps
 */
export function createProgramRunner(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const scheduler = deps.scheduler && typeof deps.scheduler.request === 'function' ? deps.scheduler : null;
  const programs = normalizePrograms(deps.programs);
  const playSegment = typeof deps.playSegment === 'function' ? deps.playSegment : () => true;
  const fadeOut = typeof deps.fadeOut === 'function' ? deps.fadeOut : () => {};
  const speak = typeof deps.speak === 'function' ? deps.speak : () => Promise.resolve();
  const sfx = typeof deps.sfx === 'function' ? deps.sfx : () => {};
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const telemetry = typeof deps.telemetry === 'function' ? deps.telemetry : () => {};
  const budget = deps.budget && typeof deps.budget === 'object' ? deps.budget : null;
  const syncFor = typeof deps.syncFor === 'function' ? deps.syncFor : () => null;
  const relaxMsFor = typeof deps.relaxMsFor === 'function' ? deps.relaxMsFor : () => null;
  const segmentDurationMs = typeof deps.segmentDurationMs === 'function' ? deps.segmentDurationMs : () => 0;
  // 段时长地板（2026-11-25 真机试演缺陷修复）：旧公式 beatMs = lineMs + 800 在
  // TTS 静音/短句（lineMs≈0）时只演 800ms —— 14s 段素材的叙事弧（起—转—收）完全没演到，
  // 用户看到的是「3 秒内 natural 结束，两段各 1 秒」。段是**表演**，台词只是它的音轨，
  // 所以段长必须有地板：默认 0.6×beatMax（不超过 beatMax）。
  const minBeatMsOpt = Number(deps.minBeatMs);
  const hasMinBeatMs = Number.isFinite(minBeatMsOpt) && minBeatMsOpt >= 0;
  const wait = typeof deps.wait === 'function' ? deps.wait : (ms, opts) => new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    const sig = opts && opts.signal;
    if (sig && typeof sig.addEventListener === 'function') {
      sig.addEventListener('abort', () => { try { clearTimeout(id); } catch (e) { /* ignore */ } resolve(); }, { once: true });
    }
  });
  const pollMs = clamp(Number(deps.pollMs) || 100, 20, 1000);
  const tickMs = clamp(Number(deps.tickMs) || 100, 20, 1000);
  const startWaitMs = clamp(Number(deps.startWaitMs) || 30000, 1000, 120000);

  // ── 状态 ────────────────────────────────────────────────────────────
  function idleState() {
    return {
      active: false,
      programId: '',
      title: '',
      beatIdx: -1,
      beatKey: '',
      beatCount: 0,
      token: '',
      pending: false,
      startedAt: 0,
      stopNow: false,
      stopReason: '',
      stopAtNextRelax: false,
      lastEndedBy: '',
      lastProgramId: '',
      plays: 0,
      byEndedBy: {},
    };
  }
  let state = idleState();
  let runPromise = null;
  let generation = 0;
  const sleepers = [];
  let lineAbort = null;      // 当前台词等待的中断钩子（stop() 用）

  function note(line) {
    try { log('[program] ' + line); } catch (e) { /* 日志失败不影响演出 */ }
  }

  function emit(evt) {
    try { telemetry(Object.assign({ kind: 'perf.program' }, evt || {})); } catch (e) { /* ignore */ }
  }

  // ── 可唤醒的 sleep（用户停止必须能立刻打断任何等待）──────────────────
  function sleep(ms) {
    const dur = Math.max(0, Number(ms) || 0);
    if (!(dur > 0)) return { promise: Promise.resolve(), cancel: () => {} };
    let controller = null;
    try { if (typeof AbortController !== 'undefined') controller = new AbortController(); } catch (e) { controller = null; }
    const item = { done: false, finish: null };
    const promise = new Promise((resolve) => {
      item.finish = () => {
        if (item.done) return;
        item.done = true;
        const i = sleepers.indexOf(item);
        if (i >= 0) sleepers.splice(i, 1);
        // 取消要连底层定时器一起撤（否则被放弃的 7s 台词超时还会在后台跳时钟/占 CPU）
        if (controller) { try { controller.abort(); } catch (e) { /* ignore */ } }
        resolve();
      };
    });
    item.promise = promise;
    sleepers.push(item);
    Promise.resolve()
      .then(() => wait(dur, { signal: controller ? controller.signal : undefined }))
      .then(() => item.finish(), () => item.finish());
    return { promise, cancel: () => item.finish() };
  }

  function wakeAll() {
    const list = sleepers.splice(0);
    for (const item of list) { try { item.finish(); } catch (e) { /* ignore */ } }
  }

  // ── 调度器读口（都用可选链式防御：假 scheduler 只实现 request/finish 也能跑）──
  function schedStatus() {
    try { return typeof scheduler.status === 'function' ? scheduler.status() : null; } catch (e) { return null; }
  }

  function ownsClaim(token) {
    if (!token) return false;
    const st = schedStatus();
    if (!st) return true;     // 读不到状态就不猜（假 scheduler / 旧实现）
    if (st.current) return String(st.current.token || '') === String(token);
    // current 为空：token 还在队列里就是「还没到手」，不在队列就是已经被丢弃
    if (Array.isArray(st.queue) && st.queue.some((q) => String(q.token || '') === String(token))) return false;
    return false;
  }

  function claimQueued(token) {
    const st = schedStatus();
    if (!st || !Array.isArray(st.queue)) return true;
    return st.queue.some((q) => String(q.token || '') === String(token));
  }

  function finishClaim(token, endedBy) {
    if (!token) return false;
    try {
      if (typeof scheduler.finish === 'function') return scheduler.finish(token, { endedBy }) !== false;
    } catch (e) { /* 调度器异常不影响收尾 */ }
    return false;
  }

  function releaseBudget(reason) {
    if (!budget || typeof budget.releaseProgram !== 'function') return false;
    try { return budget.releaseProgram(reason) !== false; } catch (e) { return false; }
  }

  function budgetLeft() {
    if (!budget) return null;
    try {
      if (typeof budget.left === 'function') return budget.left();
      if (typeof budget.remaining === 'function') return budget.remaining();
    } catch (e) { /* ignore */ }
    return null;
  }

  // ── 台词等待（超时/停止都不卡死）─────────────────────────────────────
  async function awaitLine(line, timeoutMs) {
    const t0 = now();
    const timer = sleep(timeoutMs);
    let controller = null;
    try { if (typeof AbortController !== 'undefined') controller = new AbortController(); } catch (e) { controller = null; }

    const aborted = new Promise((resolve) => { lineAbort = () => resolve({ reason: 'abort' }); });
    const spoken = Promise.resolve()
      .then(() => speak(String(line), {
        timeoutMs,
        signal: controller ? controller.signal : undefined,
      }))
      .then(() => ({ reason: 'done' }), (e) => ({ reason: 'error', error: e }));
    const timedOut = timer.promise.then(() => ({ reason: 'timeout' }));

    let result = { reason: 'done' };
    try {
      result = await Promise.race([spoken, timedOut, aborted]);
    } finally {
      lineAbort = null;
      timer.cancel();
      if (result.reason !== 'done' && controller) { try { controller.abort(); } catch (e) { /* ignore */ } }
    }
    return { reason: result.reason, error: result.error || null, ms: Math.max(0, Math.round(now() - t0)) };
  }

  // ── relax 点：句边界 / 作者静止点 / 段结束 ───────────────────────────
  function relaxPoints(beat, beatStartAt, lineMs, beatMs) {
    const list = [];
    if (beat.line) list.push(beatStartAt + Math.max(0, lineMs));
    let authored = null;
    try { authored = relaxMsFor(String(beat.seg)); } catch (e) { authored = null; }
    if (Array.isArray(authored)) {
      for (const raw of authored) {
        const v = Number(raw);
        if (!Number.isFinite(v) || v <= 0 || v >= beatMs) continue;
        list.push(beatStartAt + v);
      }
    }
    list.push(beatStartAt + beatMs);
    list.sort((a, b) => a - b);
    return list;
  }

  function passedRelax(list, at) {
    for (const t of list) { if (at >= t - 1e-6) return true; }
    return false;
  }

  // ── 等待 claim（排队中）──────────────────────────────────────────────
  async function waitForClaim(gen, token) {
    const deadline = now() + startWaitMs;
    while (now() < deadline) {
      if (gen !== generation) return false;
      if (state.stopNow) return false;
      if (ownsClaim(token)) return true;
      if (!claimQueued(token)) return false;
      await sleep(pollMs).promise;
    }
    return false;
  }

  // ── 主循环 ──────────────────────────────────────────────────────────
  function endedByForStop(reason) {
    const s = String(reason || '');
    if (s === 'budget') return 'budget';
    if (s === 'natural' || s === 'done') return 'natural';
    return 'interrupt';
  }

  async function run(gen, program, claim) {
    const startedAt = now();
    const beats = claim.beats;
    const totalMs = claim.totalMs;
    let endedBy = 'natural';
    let beatIdx = -1;
    let beatKey = '';
    let playedBeats = 0;
    let finishedClaim = false;
    let claimLost = false;

    try {
      if (claim.pending) {
        const got = await waitForClaim(gen, claim.token);
        if (!got) {
          if (gen !== generation) return;                 // reset()：什么都不做
          const why = state.stopNow ? endedByForStop(state.stopReason) : 'interrupt';
          note('排队未开演就结束 token=' + claim.token + ' why=' + why);
          finishClaim(claim.token, 'cancelled');
          finishedClaim = true;
          endedBy = why;
          releaseBudget('not-started');
          return;
        }
      }

      for (let i = 0; i < beats.length; i += 1) {
        if (gen !== generation) return;
        if (state.stopNow) { endedBy = endedByForStop(state.stopReason); break; }
        // claim 被顶掉（用户手点场景/长表演）→ 立刻收手：不要再写一帧参数，
        // 也不要在收尾时 fadeOut（那会把**接替者的**表演淡掉）。
        if (!ownsClaim(claim.token)) {
          endedBy = 'interrupt';
          claimLost = true;
          note('claim 已被顶掉，节目单提前收尾：' + claim.programId);
          break;
        }

        const beat = beats[i];
        beatIdx = i;
        beatKey = String(beat.seg);
        state.beatIdx = i;
        state.beatKey = beatKey;

        const beatStart = now();
        const segMs = Number(segmentDurationMs(beat.seg)) || 0;
        const capMs = Math.min(Number(beat.maxMs) || 0, segMs > 0 ? segMs : Number(beat.maxMs) || 0);
        const beatMax = Math.max(0, capMs);

        // P1-5（对抗审计）：换段后把当前 claim 的 relax 表切到新段 ——
        // 否则第二段仍按第一段的点判定收势（跨 beat 后 relax 表错位）。
        try { if (scheduler && typeof scheduler.updateSync === 'function') scheduler.updateSync(claim.token, syncFor(beatKey)); } catch (e) { /* ignore */ }

        // 1) 换段（画面真的切过去）
        let segOk = true;
        try { segOk = await playSegment(beatKey, { index: i, beat, programId: claim.programId }); } catch (e) { segOk = false; }
        if (segOk === false) note('段不存在/拒绝播放：' + beatKey + '（继续下一条 beat）');

        // 2) 台词（句边界 = 天然 relax 点）
        let lineMs = 0;
        let lineReason = '';
        if (beat.line) {
          const timeoutMs = Math.max(500, Math.round(beatMax / 2));
          const r = await awaitLine(beat.line, timeoutMs);
          lineMs = r.ms;
          lineReason = r.reason;
          if (r.reason === 'timeout') note('台词超时（' + timeoutMs + 'ms）不卡死：' + beatKey);
          if (r.reason === 'error') note('台词异常（继续演）：' + beatKey);
          if (r.reason === 'abort' || state.stopNow) {
            endedBy = endedByForStop(state.stopReason);
            emitBeat(claim, i, beatKey, beat, lineMs, endedBy);
            break;
          }
        }

        // 3) 音效（不走渲染层，交给宿主插件）
        if (beat.sfx) { try { sfx(String(beat.sfx), { beat, programId: claim.programId }); } catch (e) { note('sfx 失败：' + beat.sfx); } }

        // 4) 等 relax / beat 结束
        // 段长 = max(地板, 台词时长 + 余韵)，再被 beatMax 封顶：
        //   · 静音/短句（lineMs≈0）→ 地板（默认 0.6×beatMax），段素材该演的弧照演；
        //   · 台词比地板长 → 跟台词走；台词超过 beatMax → 仍以 beatMax 封顶（行为不变）；
        //   · minBeatMs=0 可退回旧行为（纯台词驱动）。
        const floorMs = hasMinBeatMs
          ? Math.min(beatMax, minBeatMsOpt)
          : Math.min(beatMax, Math.max(0, Math.round(beatMax * MIN_BEAT_RATIO)));
        const beatMs = Math.min(beatMax, Math.max(floorMs, beat.line ? lineMs + LINE_TAIL_MS : 0));
        const beatEndAt = beatStart + beatMs;
        const relaxAt = relaxPoints(beat, beatStart, lineMs, beatMs);
        const hardEndAt = startedAt + totalMs;
        let interrupted = false;
        let guard = 0;
        // 台词说完那一刻本身就是 relax：用户在这之前开口，句一落就停（不硬切）
        if (state.stopAtNextRelax && passedRelax(relaxAt, now())) { interrupted = true; endedBy = 'interrupt'; }
        while (!interrupted && now() < beatEndAt) {
          if (gen !== generation) return;
          guard += 1;
          if (guard > 20000) { note('beat 等待保护触发（时钟没有前进？）'); break; }
          if (state.stopNow) { endedBy = endedByForStop(state.stopReason); interrupted = true; break; }
          if (!ownsClaim(claim.token)) { endedBy = 'interrupt'; claimLost = true; interrupted = true; note('claim 在段内被顶掉'); break; }
          if (now() >= hardEndAt) { endedBy = 'budget'; interrupted = true; note('总时长到点：' + totalMs + 'ms'); break; }
          if (state.stopAtNextRelax && passedRelax(relaxAt, now())) { endedBy = 'interrupt'; interrupted = true; break; }
          const rest = Math.max(1, Math.min(tickMs, beatEndAt - now()));
          await sleep(rest).promise;
        }
        if (interrupted && endedBy === 'natural') endedBy = 'interrupt';
        // 用户在本段「尾巴」里开口：段末就是最自然的 relax —— 本段演完，到此为止
        if (!interrupted && state.stopAtNextRelax) { interrupted = true; endedBy = 'interrupt'; }

        playedBeats += 1;
        emitBeat(claim, i, beatKey, beat, Math.max(0, Math.round(now() - beatStart)), interrupted ? endedBy : 'natural',
          { lineReason, interrupted, beatMs });
        if (interrupted) break;

        // 5) 段间收势再换下一段（transitionMs 由 beat 自己声明）
        if (i < beats.length - 1) {
          if (!ownsClaim(claim.token)) {
            claimLost = true; endedBy = 'interrupt';
            note('claim 在段间被顶掉，不再换段');
            break;
          }
          const tr = Number.isFinite(Number(beat.transitionMs)) && Number(beat.transitionMs) >= 0
            ? Number(beat.transitionMs)
            : DEFAULT_TRANSITION_MS;
          await fadeSafely(tr);
          if (state.stopNow) { endedBy = endedByForStop(state.stopReason); break; }
        }
      }

      // 收尾：先收势（自然结束也落回待机），再交还 claim。
      // claim 被别人顶掉时**不收势**——新 owner 已经在写，fadeOut 会把它的表演淡掉。
      if (gen === generation && !claimLost) await fadeSafely(INTERRUPT_FADE_MS);
    } catch (e) {
      endedBy = 'error';
      note('运行器异常：' + ((e && e.message) || e));
    } finally {
      if (gen === generation) {
        if (!finishedClaim) finishClaim(claim.token, endedBy);
        const actualMs = Math.max(0, Math.round(now() - startedAt));
        state.active = false;
        state.programId = '';
        state.title = '';
        state.beatIdx = -1;
        state.beatKey = '';
        state.token = '';
        state.pending = false;
        state.stopNow = false;
        state.stopAtNextRelax = false;
        state.stopReason = '';
        state.lastEndedBy = endedBy;
        state.lastProgramId = claim.programId;
        state.plays += 1;
        state.byEndedBy[endedBy] = (state.byEndedBy[endedBy] || 0) + 1;
        emit({
          scope: 'program', phase: 'end', programId: claim.programId, title: claim.title,
          beatIdx, beatKey, lineLen: 0, beats: beats.length, playedBeats,
          plannedMs: totalMs, actualMs, endedBy,
        });
        note('end ' + claim.programId + ' endedBy=' + endedBy + ' ' + actualMs + 'ms');
        runPromise = null;
      }
    }
  }

  function emitBeat(claim, idx, key, beat, actualMs, endedBy, extra = {}) {
    emit(Object.assign({
      scope: 'beat',
      programId: claim.programId,
      beatIdx: idx,
      beatKey: key,
      lineLen: charLen(beat.line),
      actualMs: Math.max(0, Math.round(actualMs)),
      endedBy,
      maxMs: Number(beat.maxMs) || 0,
    }, extra));
  }

  async function fadeSafely(ms) {
    const dur = Math.max(0, Number(ms) || 0);
    try {
      const r = fadeOut(dur);
      if (r && typeof r.then === 'function') await r;
    } catch (e) { note('fadeOut 失败（忽略）：' + ((e && e.message) || e)); }
  }

  // ── 对外 API ────────────────────────────────────────────────────────
  /**
   * 开始一条节目单。
   * @param {string} programId
   * @returns {{ok:boolean, reason?:string, programId?:string, token?:string,
   *            status?:'started'|'pending', pending?:boolean, totalMs?:number, budgetLeft?:any}}
   */
  function start(programId) {
    const id = String(programId == null ? '' : programId).trim();
    if (!id) return { ok: false, reason: 'unknown-program' };
    if (state.active) return { ok: false, reason: 'busy', programId: state.programId };
    if (!scheduler) return { ok: false, reason: 'scheduler-off' };
    const program = programs.get(id);
    if (!program) return { ok: false, reason: 'unknown-program', programId: id };

    const v = validateProgram(program);
    if (!v.ok) {
      note('数据不合法，拒绝启动 ' + id + '：' + v.errors.join('；'));
      return { ok: false, reason: 'invalid-program', errors: v.errors, programId: id };
    }
    const beats = v.beats.length ? v.beats : (Array.isArray(program.beats) ? program.beats : []);

    // 预算（只计 program；日上限来自 performance.program.max_per_day）
    if (budget && typeof budget.takeProgram === 'function') {
      let taken = null;
      try { taken = budget.takeProgram(); } catch (e) { taken = null; note('预算接口异常，按放行处理'); }
      if (taken === false || (taken && typeof taken === 'object' && taken.ok === false)) {
        const reason = (taken && typeof taken === 'object' && taken.reason) || 'budget';
        return { ok: false, reason: reason === 'budget' ? 'budget' : reason, programId: id, budgetLeft: budgetLeft() };
      }
    }

    const totalMs = v.totalMs;
    let req = null;
    try {
      req = scheduler.request({
        owner: 'program',
        key: id,
        title: String(program.title || id),
        kind: 'segmented',
        sync: syncFor(beats[0].seg),
        maxMs: totalMs,
        preempt: false,
      });
    } catch (e) {
      releaseBudget('request-error');
      note('调度器请求异常：' + ((e && e.message) || e));
      return { ok: false, reason: 'scheduler-error', programId: id };
    }
    if (!req || req.ok !== true) {
      releaseBudget('rejected');
      return {
        ok: false, reason: (req && req.reason) || 'busy', programId: id,
        holder: (req && (req.holder || req.from)) || '',
      };
    }

    const token = String(req.token || '');
    const pending = req.status !== 'started';
    generation += 1;
    const gen = generation;
    state = Object.assign(idleState(), {
      active: true,
      programId: id,
      title: String(program.title || id),
      beatIdx: -1,
      beatKey: pending ? '' : String(beats[0].seg),
      beatCount: beats.length,
      token,
      pending,
      startedAt: now(),
      plays: state.plays,
      byEndedBy: state.byEndedBy,
    });
    note('start ' + id + ' token=' + token + ' ' + (pending ? 'pending' : 'started') + ' total=' + totalMs + 'ms');
    emit({
      scope: 'program', phase: 'start', programId: id, title: state.title,
      beats: beats.length, beatIdx: -1, beatKey: '', lineLen: 0,
      plannedMs: totalMs, actualMs: 0, endedBy: '', pending,
    });
    runPromise = run(gen, program, { programId: id, title: state.title, token, beats, totalMs, pending });
    return {
      ok: true, programId: id, token, status: pending ? 'pending' : 'started',
      pending, totalMs, budgetLeft: budgetLeft(),
    };
  }

  /**
   * 停止。`reason='user'` 是用户说话/手点停止 → 立即收势（400ms），不等 relax。
   * 其它 reason（budget/disabled/…）同样立即收，endedBy 按 reason 归账。
   */
  function stop(reason) {
    const why = String(reason || 'user');
    if (!state.active) return { ok: false, reason: 'idle' };
    state.stopNow = true;
    state.stopReason = why;
    // 台词等待也要立刻放掉（否则用户点了停止还在等一句 7 秒的台词）
    if (lineAbort) { try { lineAbort(); } catch (e) { /* ignore */ } }
    wakeAll();
    note('stop ' + state.programId + ' reason=' + why);
    return { ok: true, programId: state.programId, reason: why };
  }

  /**
   * 用户开口了：**不硬切**，标记「在下一个 relax 点停」。
   * relax 点 = 台词说完（句边界）/ 作者静止点 / 本段结束。
   */
  function notifyUserInput() {
    if (!state.active) return { ok: false, reason: 'idle' };
    if (state.pending) {
      // 还在排队没开演 —— 没有「下一 relax」，直接撤掉
      return stop('interrupt');
    }
    if (state.stopAtNextRelax) return { ok: true, programId: state.programId, already: true };
    state.stopAtNextRelax = true;
    note('user-input → 在下一 relax 点停 ' + state.programId + ' beat=' + state.beatIdx);
    return { ok: true, programId: state.programId, beatIdx: state.beatIdx, stopAtNextRelax: true };
  }

  function status() {
    const st = state;
    return {
      active: st.active,
      programId: st.programId,
      title: st.title,
      beatIdx: st.beatIdx,
      beatKey: st.beatKey,
      beatCount: st.beatCount,
      token: st.token,
      pending: st.pending,
      elapsedMs: st.active ? Math.max(0, Math.round(now() - st.startedAt)) : 0,
      stopRequested: st.stopNow,
      stopAtNextRelax: st.stopAtNextRelax,
      lastEndedBy: st.lastEndedBy,
      lastProgramId: st.lastProgramId,
      plays: st.plays,
      byEndedBy: Object.assign({}, st.byEndedBy),
      budgetLeft: budgetLeft(),
    };
  }

  /** 等当前这次演出彻底收尾（测试/验收用；没有在演 → 立刻 resolve） */
  function idle() {
    return runPromise ? runPromise.catch(() => {}) : Promise.resolve();
  }

  /** 热重载/开关关闭：丢掉一切在途状态（不发收势、不写日志） */
  function reset() {
    generation += 1;
    state = idleState();
    runPromise = null;
    wakeAll();
    if (lineAbort) { try { lineAbort(); } catch (e) { /* ignore */ } }
    lineAbort = null;
  }

  function list() {
    const items = [];
    for (const [id, p] of programs) {
      const v = validateProgram(p);
      items.push({
        id,
        title: String(p.title || id),
        beatCount: Array.isArray(p.beats) ? p.beats.length : 0,
        totalMs: v.totalMs,
        valid: v.ok,
        errors: v.errors,
        beats: (Array.isArray(p.beats) ? p.beats : []).map((b) => ({
          seg: String((b && b.seg) || ''),
          maxMs: Number((b && b.maxMs) || 0),
          line: String((b && b.line) || ''),
          sfx: String((b && b.sfx) || ''),
        })),
      });
    }
    return items;
  }

  return { start, stop, notifyUserInput, status, idle, reset, list, validate: validateProgram, programs };
}
