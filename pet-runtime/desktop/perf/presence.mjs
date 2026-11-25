// presence.mjs —— 「用户此刻在不在 / 在干嘛」的统一入口（2026-11-25 P0，ADR-015 §3.0 组件 0.3）
//
// 为什么需要它（审计 §2.8）：
//   · world-sense 插件已经在渲染窗口里暴露 `globalThis.__worldSenseState()`（六态 +
//     conf/why/stale，零 IPC 可读），但**没有任何表演层读它**；
//   · 实际只用 `globalThis.__userActivity`（3 态，主进程每 8s 推一次），且只在
//     state 变化时推 —— 渲染层重载后若一直是 active，会 undefined 很久；
//   · v2 的自动三通道根本不传 presence，away 时照演 20–38 秒。
//
// 这个模块只做一件事：把两个来源归一成**一个** `{state,inFront,idleSec,fresh,source}`，
// 并强制 30 秒新鲜度（没有时间戳/太旧的数据按「不知道」处理，而不是把上一次 away 永久粘住）。
//
// 六态：working / gaming / watching / meeting / idle / away（+ unknown）
//
// 纯函数：scope（默认真实 global）与 nowMs 都注入，node 里可单测；不 require fs/electron/DOM。

/** 数据新鲜度上限：超过它就别拿来做「人不不在」的判断 */
export const PRESENCE_FRESH_MS = 30 * 1000;

/** world-sense 的六态（+ unknown 兜底） */
export const PRESENCE_STATES = Object.freeze([
  'working', 'gaming', 'watching', 'meeting', 'idle', 'away', 'unknown',
]);

/** 这些活动态下「长表演 / 节目单」不允许启动（短片段/微动作仍可） */
export const LONG_BLOCKED_STATES = Object.freeze(['away', 'gaming', 'watching', 'meeting']);

const STATE_ALIASES = Object.freeze({
  active: 'working',
  focus: 'working',
  busy: 'working',
  game: 'gaming',
  gaming: 'gaming',
  video: 'watching',
  watching: 'watching',
  media: 'watching',
  meet: 'meeting',
  meeting: 'meeting',
  call: 'meeting',
  idle: 'idle',
  away: 'away',
  afk: 'away',
  unknown: 'unknown',
});

/** 归一活动态名（world-sense 六态 / __userActivity 三态 / 别名） */
export function normalizePresenceState(raw) {
  const key = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!key) return 'unknown';
  return STATE_ALIASES[key] || (PRESENCE_STATES.includes(key) ? key : 'unknown');
}

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeCall(fn) {
  try { return typeof fn === 'function' ? fn() : null; } catch (e) { return null; }
}

/**
 * 读一次在场状态。
 *
 * @param {object} [scope] 全局对象（测试注入假 global）
 * @param {number} [nowMs]
 * @returns {{state:string, inFront:boolean, idleSec:number, fresh:boolean, source:string,
 *            conf:number|null, why:string, stale:boolean}}
 */
export function readPresence(scope = (typeof globalThis !== 'undefined' ? globalThis : {}), nowMs = Date.now()) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const empty = {
    state: 'unknown', inFront: true, idleSec: 0, fresh: false, source: 'none',
    conf: null, why: '', stale: true,
  };
  if (!scope || typeof scope !== 'object') return empty;

  // ① 首选 world-sense（六态 + stale 标记）
  const ws = safeCall(scope.__worldSenseState);
  if (ws && typeof ws === 'object' && ws.activity) {
    const act = ws.activity;
    const state = normalizePresenceState(act.state);
    const at = finiteOrNull(act.at);
    const ageMs = at == null ? null : now - at;
    const fresh = act.stale !== true && (ageMs == null || (ageMs >= 0 && ageMs <= PRESENCE_FRESH_MS));
    if (state !== 'unknown' && fresh) {
      const idleSec = finiteOrNull(ws.world && ws.world.idleSec);
      return {
        state,
        inFront: state !== 'away',
        idleSec: idleSec == null ? 0 : Math.max(0, idleSec),
        fresh: true,
        source: 'world-sense',
        conf: finiteOrNull(act.conf),
        why: String(act.why || ''),
        stale: act.stale === true,
      };
    }
  }

  // ② 回退 __userActivity（3 态，主进程 idle-detect）
  const ua = scope.__userActivity;
  if (ua && typeof ua === 'object') {
    const state = normalizePresenceState(ua.state);
    const at = finiteOrNull(ua.at);
    const ageMs = at == null ? null : now - at;
    const fresh = ageMs == null || (ageMs >= 0 && ageMs <= PRESENCE_FRESH_MS);
    if (state !== 'unknown') {
      const idleMs = finiteOrNull(ua.idleMs);
      return {
        state,
        inFront: state !== 'away',
        idleSec: idleMs == null ? 0 : Math.max(0, idleMs / 1000),
        fresh,
        source: 'user-activity',
        conf: null,
        why: '',
        stale: !fresh,
      };
    }
  }

  return empty;
}

/** 这个人/这段活动态允许「长表演」吗（away/gaming/watching/meeting 一律不许） */
export function allowsLongPerformance(presence) {
  const state = normalizePresenceState(presence && presence.state);
  if (state === 'unknown') return true;   // 不知道就别拦（保守：不制造「她不演了」）
  return !LONG_BLOCKED_STATES.includes(state);
}
