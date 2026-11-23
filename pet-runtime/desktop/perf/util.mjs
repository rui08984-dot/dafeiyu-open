// 小工具。perf 模块不依赖任何外部包（要能进 esbuild 打包，也要能 node --test 直接跑）。

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return n < min ? min : n > max ? max : n;
}

export function lerp(from, to, amount) {
  return from + (to - from) * clamp(amount, 0, 1);
}

export function ease(name, t) {
  const k = clamp(t, 0, 1);
  switch (name) {
    case 'easeIn': return k * k;
    case 'easeOut': return 1 - (1 - k) * (1 - k);
    case 'easeInOut': return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    case 'smoothstep': return k * k * (3 - 2 * k);
    default: return k;
  }
}

// 一阶低通：给定时间常数 tau（秒），返回本帧的插值系数。
// 用 1 - exp(-dt/tau) 而不是写死系数，掉帧时的手感才和满帧一致。
export function smoothingFactor(tau, dt) {
  if (!(tau > 0)) return 1;
  return 1 - Math.exp(-Math.max(0, dt) / tau);
}
