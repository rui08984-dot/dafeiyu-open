// ui/gaze.mjs — 眼神跟随鼠标
// 契约：主进程通过内网 ws 发 {type:"pointer", x, y}（归一化 -1..1，原点窗口中心；
// 鼠标不在窗口上时 x/y 为 null）。这里只做三件事：
//   1) 瞳孔 ParamEyeBallX/Y 全跟（clamp ±0.8）；
//   2) 头部 ParamAngleX/Y 跟 30%（clamp ±4°）；
//   3) 鼠标离开 1.5s 后按 0.6s 时间常数平滑回中。
// 写值用 renderer.setParameter，不改 cubism-renderer.mjs；但 updateView 每帧会重写这些
// 参数，所以由 app.mjs 包一层 renderer.draw：在真正绘制前写值并重算一次顶点。

const EYE_LIMIT = 0.8;        // 瞳孔最大偏移
const HEAD_RATIO = 0.3;       // 头部跟随强度
const HEAD_RANGE = 30;        // 皮套头部角度范围 ±30°
const HEAD_LIMIT = 7;         // 头部上限 ±7°（原 ±4° 肉眼几乎无感，用户反馈「跟随不太行」的主因之一；
                              // 可被构造参数覆盖，见 constructor options.headLimit）
const FOLLOW_TAU = 0.12;      // 跟随平滑（秒）
const RECENTER_TAU = 0.6;     // 回中时间常数（秒）
const LEAVE_GRACE_MS = 1500;  // 离开窗口后保持 1.5s 再回中
// 主进程的 y 方向约定：默认按「屏幕坐标向下为正」处理，渲染层取反成 Live2D 的向上为正。
// 如果主进程已经转过方向，把这里改成 false 即可。
const POINTER_Y_DOWN = true;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class GazeFollow {
  constructor(renderer, options = {}) {
    this.renderer = renderer;
    // 头部幅度可注入（默认 ±7°）；调大更「看得出在看」，调小更含蓄
    this.headLimit = Math.max(2, Math.min(15, Number(options.headLimit) || HEAD_LIMIT));
    this.hasPointer = false;
    this.rawX = 0;
    this.rawY = 0;
    this.x = 0;
    this.y = 0;
    this.lastAt = performance.now();
    this.lastPointerAt = 0;
    this.leftAt = 0;
    this.applied = false;
  }

  /** 收到主进程的归一化指针；x/y 非数字表示鼠标离开窗口。 */
  setPointer(x, y) {
    const now = performance.now();
    // 主进程用 JSON null 表示鼠标离开窗口，注意 Number(null) === 0，必须先判空。
    if (x === null || x === undefined || y === null || y === undefined || x === '' || y === '') {
      if (this.hasPointer) { this.hasPointer = false; this.leftAt = now; }
      return false;
    }
    const nx = Number(x), ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
      if (this.hasPointer) { this.hasPointer = false; this.leftAt = now; }
      return false;
    }
    this.hasPointer = true;
    this.lastPointerAt = now;
    this.rawX = clamp(nx, -1, 1);
    this.rawY = clamp(POINTER_Y_DOWN ? -ny : ny, -1, 1);
    return true;
  }

  get active() {
    if (this.hasPointer) return true;
    return this.leftAt > 0 && performance.now() - this.leftAt < LEAVE_GRACE_MS;
  }

  /** 推进平滑。 */
  sample(now = performance.now()) {
    const dt = clamp((now - this.lastAt) / 1000, 0.001, 0.1);
    this.lastAt = now;
    const leaveElapsed = now - this.leftAt;
    const targetX = this.hasPointer ? this.rawX : (leaveElapsed < LEAVE_GRACE_MS ? this.rawX : 0);
    const targetY = this.hasPointer ? this.rawY : (leaveElapsed < LEAVE_GRACE_MS ? this.rawY : 0);
    const tau = this.hasPointer ? FOLLOW_TAU : (leaveElapsed < LEAVE_GRACE_MS ? FOLLOW_TAU : RECENTER_TAU);
    const k = 1 - Math.exp(-dt / tau);
    this.x += (targetX - this.x) * k;
    this.y += (targetY - this.y) * k;
  }

  /** 当前应该写的参数偏移（纯读，不推进平滑）。 */
  offsets() {
    return {
      eyeX: clamp(this.x * EYE_LIMIT, -EYE_LIMIT, EYE_LIMIT),
      eyeY: clamp(this.y * EYE_LIMIT, -EYE_LIMIT, EYE_LIMIT),
      headX: clamp(this.x * HEAD_RATIO * HEAD_RANGE, -this.headLimit, this.headLimit),
      headY: clamp(this.y * HEAD_RATIO * HEAD_RANGE, -this.headLimit, this.headLimit),
    };
  }

  /**
   * 帧内取样（2026-11-21 P1）：只推进平滑、算出本帧偏移，**不写渲染器**。
   *
   * 为什么不能再「画完再写」：updateView 开头会用 defaults 重置全部参数，
   * 结尾才 `_model.update()` 重算顶点。在 updateView 之后写参数，
   * 既不参与本帧顶点重算，下一帧开头又被 defaults 清掉 —— ParamEyeBallX/Y、
   * AngleX/Y 从来没有在物理/顶点重算前存在过（这就是「眼神从不进入画面」）。
   * 所以调用方必须在 updateView **之前**取偏移，并把它作为 view.gaze 交给
   * 渲染器在物理前统一提交（见 perf/gaze-commit.mjs）。
   *
   * @returns {{eyeX:number,eyeY:number,headX:number,headY:number}|null} 静止时返回 null
   */
  prepare(now = performance.now()) {
    const renderer = this.renderer;
    if (!renderer || !renderer.ready || !renderer._model) return null;
    this.sample(now);
    const offsets = this.offsets();
    const still = !this.active
      && Math.abs(offsets.eyeX) < 0.002 && Math.abs(offsets.eyeY) < 0.002
      && Math.abs(offsets.headX) < 0.002 && Math.abs(offsets.headY) < 0.002;
    if (still) { this.applied = false; renderer._gazeQuiet = true; return null; }
    // 眼神在动 → 告诉 updateView「需要满帧」（_gazeQuiet 语义保持不变）
    renderer._gazeQuiet = false;
    this.applied = true;
    return { eyeX: offsets.eyeX, eyeY: offsets.eyeY, headX: offsets.headX, headY: offsets.headY };
  }

  /**
   * 兼容旧调用（desktop/app.mjs 的舞台页仍在 draw 前调用它）。
   * 新代码请用 prepare() + view.gaze，让偏移参与本帧顶点重算。
   */
  apply() {
    const frame = this.prepare();
    if (!frame) return;
    const renderer = this.renderer;
    renderer.setParameter('ParamEyeBallX', frame.eyeX);
    renderer.setParameter('ParamEyeBallY', frame.eyeY);
    renderer.setParameter('ParamAngleX', renderer.getParameter('ParamAngleX') + frame.headX);
    renderer.setParameter('ParamAngleY', renderer.getParameter('ParamAngleY') + frame.headY);
    // 配件/第二套物理读的是控制器层 AngleXYZ，这一帧保持一致。
    renderer.setParameter('AngleX', renderer.getParameter('AngleX') + frame.headX);
    renderer.setParameter('AngleY', renderer.getParameter('AngleY') + frame.headY);
  }

  reset() {
    this.hasPointer = false;
    this.rawX = 0; this.rawY = 0;
    this.x = 0; this.y = 0;
    this.leftAt = 0;
    this.applied = false;
  }

  debugState() {
    const offsets = this.offsets();
    return {
      active: this.active,
      hasPointer: this.hasPointer,
      // rawX/rawY/x/y = 原始输入 + 平滑后的内部值。排查「眼神钉死/不跟手」时必须能区分
      // 「输入就错」和「平滑卡住」——只报 offsets 看不出是哪一层出的问题（2026-11-08 实测踩过）。
      rawX: Math.round(this.rawX * 1000) / 1000,
      rawY: Math.round(this.rawY * 1000) / 1000,
      x: Math.round(this.x * 1000) / 1000,
      y: Math.round(this.y * 1000) / 1000,
      eyeX: Math.round(offsets.eyeX * 1000) / 1000,
      eyeY: Math.round(offsets.eyeY * 1000) / 1000,
      headX: Math.round(offsets.headX * 1000) / 1000,
      headY: Math.round(offsets.headY * 1000) / 1000,
    };
  }
}
