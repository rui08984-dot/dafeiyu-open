// body-director.mjs — 自然身体层（呼吸 / 重心 / 髋摆 / 肩 / 位移 / 兽耳 / 待机小动作 / 派活状态）
// 这套皮套的物理系统有 131 组，输入参数是 ParamBreath、PositionY、ParamBodyAngle*、
// LeanInput、HipAngle*、LControl/RControl。只驱动头部的话，头发/裙摆/胸/尾巴/袖子
// 收不到任何输入，看起来就只有脸和耳朵在动。这个模块负责喂这些输入。
//
// 待机调度（idle scheduler）就在这一层：每 6~14 秒随机插一个小动作
// （歪头 / 换重心 / 耳朵抖 / 轻晃），幅度克制、时长和方向每次都重新抽，
// 所以待机不会出现「同一个循环」的机械感。输出的是偏移量，由渲染器叠到头部和身体上。
//
// 派活状态（setWorkState）：idle / thinking / busy / done。
//   thinking —— 低头、身体收着（摆幅压到 6 成）、呼吸放慢，像在琢磨
//   busy     —— 微微低头朝屏幕、隔 2~4 秒点一下头，身体摆幅压到 7.5 成
//   done     —— 2.5 秒的轻快小跳（PositionY 弹两下 + 肩 + 头），到点自动回 idle
// 这三个状态只动本模块本来就管着的通道（breath / pos / hip / shoulder / 头部偏移），
// 手放胸前、看屏幕的眼神这种要靠参数开关的，交给 motion-vocab 的 work 动作。
const TAU = Math.PI * 2;

const smooth = (t) => t * t * (3 - 2 * t);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const IDLE_KINDS = ['tilt', 'weight', 'ear', 'sway'];
export const WORK_STATES = ['idle', 'thinking', 'busy', 'done'];
const DONE_DURATION = 2.5;    // done 的表演时长，到点自动回待机

export class BodyDirector {
  constructor(options = {}) {
    this.t = 0;
    this.energy = 1;
    this.options = options;
    // 随机源可注入，方便无头测试；默认 Math.random。
    this.random = typeof options.random === 'function' ? options.random : Math.random;
    // 不同周期叠加，避免看出机械的正弦感。
    this.cycle = { breath: 4.6, sway: 9.2, sway2: 6.1, bob: 5.3, ear: 11.7 };
    this.phase = 0;
    this.speechSmooth = 0;
    this.nextEarAt = 6 + this.random() * 6;
    this.earAt = -1;
    // 待机调度：间隔 6~14 秒，小动作之间至少留 6 秒静默。
    this.idleMin = Number.isFinite(options.idleMin) ? options.idleMin : 6;
    this.idleMax = Number.isFinite(options.idleMax) ? options.idleMax : 14;
    this.nextIdleAt = this.idleDelay();
    this.idle = null;
    this.idleStartedAt = 0;
    this.idleCount = 0;
    this.lastIdleKind = '';
    this.offsets = { x: 0, y: 0, z: 0, bodyX: 0, bodyZ: 0, posX: 0, hipZ: 0, ear: 0 };
    // ── 派活状态 ──
    this.workState = 'idle';
    this.workSince = 0;
    this.doneAt = -1;
    // 工作姿态用缓动逼近目标，切状态时不跳变（tau≈0.22s）。
    this.pose = { x: 0, y: 0, z: 0 };
    this.focus = 1;              // 摆幅系数：工作中收着一点，看起来在专注
    this.nextNodAt = 0;
    this.nodAt = -1;
  }

  // 下一次待机动作的等待时间（6~14 秒，每次重新抽）
  idleDelay() {
    const lo = Math.max(1, this.idleMin), hi = Math.max(lo, this.idleMax);
    return lo + this.random() * (hi - lo);
  }

  /** 派活状态：idle | thinking | busy | done（done 2.5 秒后自动回 idle）。 */
  setWorkState(state) {
    const next = WORK_STATES.includes(state) ? state : 'idle';
    if (this.workState === next) return next;
    this.workState = next;
    this.workSince = this.t;
    if (next === 'done') this.doneAt = this.t;
    // 进/出工作态都把待机调度清空重排：否则刚接活就冒出个"歪头"，会像没听懂指令。
    this.idle = null;
    this.nextIdleAt = this.idleDelay();
    this.nodAt = -1;
    this.nextNodAt = this.t + 1.6 + this.random() * 1.8;
    return next;
  }

  // 工作状态的目标姿态（头部偏移量 + 摆幅系数），用缓动逼近而不是硬切。
  workTarget() {
    const drift = Math.sin(this.t * 0.42) * 1.2;     // 很慢的漂移，避免"定格"
    switch (this.workState) {
      case 'thinking': return { x: 1.2 + drift * 0.3, y: -2.8, z: -3.4 + drift, focus: 0.6 };
      case 'busy': return { x: 2.2, y: -2.2 + this.busyNod(), z: -1.2 + drift * 0.4, focus: 0.75 };
      default: return { x: 0, y: 0, z: 0, focus: 1 };
    }
  }

  // 干活时每 2.6~4.6 秒点一下头：短促的下压，表明"在处理"。
  busyNod() {
    if (this.nodAt < 0) {
      if (this.t >= this.nextNodAt) { this.nodAt = this.t; this.nextNodAt = this.t + 2.6 + this.random() * 2.0; }
      else return 0;
    }
    const age = this.t - this.nodAt;
    if (age > 0.5) { this.nodAt = -1; return 0; }
    return -3.4 * Math.sin(clamp(age / 0.5, 0, 1) * Math.PI);
  }

  // done 的轻快小跳：两下（第二下小一点），随即收住。
  // 注意这套 rig 的 PositionY 是物理链输入（会带动肩/髋/手臂），不是屏幕位移，
  // 所以这里幅度要克制：太小看不出跳，太大会像"整个人被拉近镜头"。
  doneHop() {
    if (this.workState !== 'done') return 0;
    const p = clamp((this.t - this.doneAt) / DONE_DURATION, 0, 1);
    // 起跳前先小小下蹲一下（80ms 的预备），然后两下弹起，第二下明显小
    const crouch = -0.4 * Math.max(0, 1 - p / 0.08);
    return Math.max(0, Math.sin(p * Math.PI * 2)) * Math.exp(-p * 2.5) + crouch;
  }

  // 抽一个待机小动作：种类不连着重复，幅度 / 方向 / 时长都随机
  pick() {
    const kinds = IDLE_KINDS.filter((kind) => kind !== this.lastIdleKind);
    const kind = kinds[Math.floor(this.random() * kinds.length)] ?? 'tilt';
    this.lastIdleKind = kind;
    const idle = { kind, age: 0, sign: this.random() < 0.5 ? -1 : 1, dur: 1.8, amp: 1, entry: 0.5, exit: 0.75 };
    if (kind === 'tilt') { idle.dur = 1.3 + this.random() * 0.9; idle.amp = 1.4 + this.random() * 1.2; idle.entry = 0.4; idle.exit = 0.65; }
    else if (kind === 'weight') { idle.dur = 1.7 + this.random() * 1.0; idle.amp = 0.55 + this.random() * 0.45; idle.entry = 0.5; idle.exit = 0.8; }
    else if (kind === 'ear') { idle.dur = 0.55 + this.random() * 0.3; idle.amp = 1; idle.entry = 0.15; idle.exit = 0.3; }
    else { idle.dur = 1.8 + this.random() * 1.1; idle.amp = 0.9 + this.random() * 0.9; idle.entry = 0.5; idle.exit = 0.85; }
    this.idle = idle;
    this.idleStartedAt = this.t;
    this.idleCount += 1;
    if (kind === 'ear') this.earAt = 0;   // 耳朵抖：顺手把兽耳脉冲也触发一次
    return idle;
  }

  // 待机小动作的包络：慢进慢出、中间保持；说话时压到 6 成，别和头部跟随抢戏。
  // amp（2026-11-25 P1）：ambient 待机层的幅度上限（0..1，默认 1 = 旧行为逐值不变）。
  stepIdle(step, speaking, amp = 1) {
    const idle = this.idle;
    const out = this.offsets;
    out.x = out.y = out.z = out.bodyX = out.bodyZ = out.posX = out.hipZ = out.ear = 0;
    if (!idle) return out;
    idle.age += step;
    // 小动作结束：下一次的间隔从"上一次开始"算，保证 6~14 秒一次，而不是叠上动作本身的时长。
    if (idle.age >= idle.dur) {
      this.idle = null;
      this.nextIdleAt = Math.max(0, this.idleDelay() - (this.t - this.idleStartedAt));
      return out;
    }
    const env = smooth(clamp(idle.age / idle.entry, 0, 1)) * smooth(clamp((idle.dur - idle.age) / idle.exit, 0, 1));
    const w = env * idle.amp * (speaking ? 0.6 : 1) * idle.sign * amp;
    // 幅度克制：头部 ≤4°，躯干 ≤3°（再大就不像"待机时的小动作"了）
    switch (idle.kind) {
      case 'tilt': out.z = w * 1.5; out.x = -w * 0.5; out.y = w * 0.25; break;                        // 歪头
      case 'weight': out.posX = w * 1.05; out.hipZ = -w * 1.9; out.bodyZ = w * 0.8; out.x = w * 0.9; break;  // 换重心
      case 'ear': out.ear = w * 0.5; out.z = w * 1.6; out.x = -w * 0.6; break;                        // 耳朵抖
      default: out.bodyX = w * 1.5; out.z = w * 1.1; out.posX = w * 0.45; out.hipZ = -w * 0.7; break;  // 轻晃
    }
    return out;
  }

  // 兽耳抖动：隔一阵来一次短促的衰减振荡。
  earPulse(delta) {
    this.nextEarAt -= delta;
    if (this.nextEarAt <= 0) {
      this.earAt = 0;
      this.nextEarAt = 9 + this.random() * 9;
    }
    if (this.earAt < 0) return 0;
    this.earAt += delta;
    const age = this.earAt;
    if (age > 0.55) { this.earAt = -1; return 0; }
    return Math.sin(age * TAU * 3.2) * Math.exp(-age * 7) * 0.85;
  }

  sample({ delta = 0.016, state = 'idle', speechRate = 0, amp = 1 } = {}) {
    const step = clamp(delta, 0, 0.1);
    this.t += step;
    const t = this.t;
    const speaking = state === 'speaking';
    const speech = clamp(speechRate, 0, 1);
    // ambient 只在「真待机」时压幅度：派活/说话时用 1（那不是待机，别把指令动作也压没）
    const ambientAmp = this.workState === 'idle' && Number.isFinite(Number(amp))
      ? clamp(Number(amp), 0, 1)
      : 1;

    // done 到点自动回待机（主进程只调一次 setWorkState('done')，剩下的由这里收尾）。
    if (this.workState === 'done' && t - this.doneAt >= DONE_DURATION) {
      this.workState = 'idle';
      this.idle = null;
      this.nextIdleAt = this.idleDelay();
    }

    // 工作姿态缓动：切状态不跳变；工作中摆幅收着（focus<1）。
    const target = this.workTarget();
    const tau = 0.22;
    const k = 1 - Math.exp(-step / tau);
    this.pose.x += (target.x - this.pose.x) * k;
    this.pose.y += (target.y - this.pose.y) * k;
    this.pose.z += (target.z - this.pose.z) * k;
    this.focus += (target.focus - this.focus) * k;

    // 说话摇摆：基础 1.25 倍，再按语速往上加（最多约 1.6 倍）；语速快时周期也略缩短。
    // 说话的"激动程度"必须低通：它来自每帧口型开合，是抖的。
    this.speechSmooth += (speech - this.speechSmooth) * (1 - Math.exp(-step / 0.35));
    const sSm = this.speechSmooth;
    const scale = (speaking ? 1.06 + 0.12 * sSm : 1) * this.energy * this.focus * ambientAmp;
    // 频率只做很小的平滑变化；相位用累加，绝不用 t*rate（那会让波形整体跳）。
    const rate = speaking ? 1 + 0.05 * sSm : 1;
    this.phase += step * rate;
    // 思考时呼吸放慢一点（专注的人呼吸浅而慢）
    const breathRate = this.workState === 'thinking' ? 0.82 : 1;

    const breathRaw = 0.5 + 0.5 * Math.sin(this.phase * TAU * breathRate / this.cycle.breath);
    // 呼吸是物理链的输入：压幅度时只压「偏离中位 0.5」的部分，中位不能动（否则像不呼吸了）。
    const breath = ambientAmp === 1 ? breathRaw : 0.5 + (breathRaw - 0.5) * ambientAmp;
    const swayA = Math.sin(this.phase * TAU * breathRate / this.cycle.sway);
    const swayB = Math.sin(this.phase * TAU * breathRate / this.cycle.sway2 + 1.1);
    const bob = Math.sin(this.phase * TAU * breathRate / this.cycle.bob + 0.4);
    const ear = this.earPulse(step) * ambientAmp;

    // 待机调度：只在 idle 跑（工作中不插小动作，否则像没在听指令）。
    if (this.workState === 'idle') {
      this.nextIdleAt -= step;
      if (!this.idle && this.nextIdleAt <= 0) this.pick();
    } else if (this.idle) this.idle = null;
    const idle = this.stepIdle(step, speaking, ambientAmp);

    // done 的小跳（只动本模块管着的位移/肩/髋，不碰别的层）
    const hop = this.doneHop();

    return {
      breath,
      bodyX: swayA * 1.8 * scale,
      bodyZ: swayB * 1.15 * scale,
      hipX: bob * 0.8 * scale,
      hipY: swayB * 0.5 * scale,
      hipZ: -swayA * 1.5 * scale - hop * 1.2,
      lean: swayB * 0.45 * scale,
      posX: swayA * 0.55 * scale,
      posY: bob * 0.65 * scale + hop * 2.9,
      posZ: 0,
      shoulderY: swayA * 0.7 * scale + hop * 2.0,
      shoulderZ: -swayB * 0.55 * scale,
      earL: ear,
      earR: -ear * 0.8,
      // 头部/身体的额外偏移：待机小动作 + 派活姿态（工作中待机小动作是 0，二者不会打架）
      idleX: idle.x + this.pose.x, idleY: idle.y + this.pose.y - hop * 1.2, idleZ: idle.z + this.pose.z,
      idleBodyX: idle.bodyX, idleBodyZ: idle.bodyZ,
      idlePosX: idle.posX, idleHipZ: idle.hipZ, idleEar: idle.ear,
      idleKind: this.idle?.kind ?? '',
      idleProgress: this.idle ? +(this.idle.age / this.idle.dur).toFixed(3) : 0,
      idleCount: this.idleCount,
      workState: this.workState,
      workHop: +hop.toFixed(3),
    };
  }
}
