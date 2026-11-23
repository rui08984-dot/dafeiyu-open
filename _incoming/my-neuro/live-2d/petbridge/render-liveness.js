/**
 * render-liveness.js — 渲染层存活判据（2026-11-15 五十八轮）
 *
 * 为什么要有这个文件：她的渲染进程会**静默冻死**。
 * 2026-11-14 00:19 实测症状（一整夜没人发现，冻了 3.5 小时）：
 *   · 主进程完全正常：8004 /bounds 回得出窗口位置、3003 收得到请求
 *   · 渲染进程还在，但页面 JS 不跑了：executeJavaScript('1+1') 永不返回、
 *     capturePage 出 0×0 / 0 字节、8102 inner WS 断开后再也不重连
 *   · runtime.log 在 00:19 之后一行没有（每小时必出现的轮询日志也停了）
 * 而当时唯一的「渲染健康哨兵」活在渲染进程内部 —— 冻死时它自己也喊不出来，
 * doctor 又把「快照陈旧」当成「省电，动一下鼠标再看」（skip），于是全员瞎。
 *
 * 判据只用主进程零成本就能拿到的两个事实：
 *   A. 8102 inner WS 的客户端数（她的页面连着 → 1；断线后代码里 2s 自己重连）
 *   B. render-health 快照的新鲜度（渲染层 5s 一采，经 8102 上报）
 *
 * 为什么 A 判「死」、B 只判「疑」：
 *   窗口最小化/被遮挡时 Chromium 会暂停渲染（B 会自然陈旧，属正常省电），
 *   但 WS 不会因此断开 —— 所以只有 A 才能零误报地判死。B 一旦用来判死，
 *   就会变成「用户把窗藏起来就重启页面」的狼来了。
 */

/** 判据默认阈值（毫秒）。改这些值前先读上面的说明。 */
const DEFAULTS = {
  offlineMs: 60000,      // 连续 60s 没有渲染层才判死（重连只要 2s，留足 30 倍余量）
  healthStaleMs: 120000, // 有连接但 2 分钟没上报 → 疑（可能只是被遮挡）
};

/**
 * @param {object} o
 * @param {number} o.now            当前时刻（毫秒）
 * @param {number} o.innerClients   8102 inner WS 在线客户端数
 * @param {number} o.lastInnerAt    最近一次「渲染层在线/说话/断开」的时刻（0 = 从未连上）
 * @param {number} o.lastHealthAt   最近一次 render-health 上报时刻（0 = 从未上报）
 * @returns {{ state: 'ok'|'waiting'|'offline'|'stale', detail: string, sinceInnerMs?: number, healthAgeMs?: number }}
 */
function judgeRenderLiveness(o) {
  const opt = Object.assign({}, DEFAULTS, o || {});
  const now = Number(opt.now) || Date.now();
  const innerClients = Number(opt.innerClients) || 0;
  const lastInnerAt = Number(opt.lastInnerAt) || 0;
  const lastHealthAt = Number(opt.lastHealthAt) || 0;

  // ── 判死：没有任何渲染层连接 ──
  if (innerClients <= 0) {
    const sinceInner = lastInnerAt ? Math.max(0, now - lastInnerAt) : Infinity;
    if (sinceInner >= opt.offlineMs) {
      const secs = Number.isFinite(sinceInner) ? Math.round(sinceInner / 1000) : null;
      return {
        state: 'offline',
        sinceInnerMs: sinceInner,
        detail: secs == null
          ? '从来没有渲染层连上 8102（页面根本没起来）'
          : '渲染层 ' + secs + 's 没连上 8102（断线后 2s 该自愈重连，没有 = 页面 JS 不跑了）',
      };
    }
    return {
      state: 'waiting',
      sinceInnerMs: sinceInner,
      detail: '渲染层刚断开 ' + Math.round(sinceInner / 1000) + 's（自愈重连窗口 2s，先别动）',
    };
  }

  // ── 疑：连着但从不上报 ──
  const healthAge = lastHealthAt ? Math.max(0, now - lastHealthAt) : Infinity;
  if (healthAge >= opt.healthStaleMs) {
    return {
      state: 'stale',
      healthAgeMs: healthAge,
      detail: '8102 连着但 ' + (Number.isFinite(healthAge) ? Math.round(healthAge / 1000) + 's ' : '') + '没有 render-health（窗口被遮挡时属正常；若画面不动就要查）',
    };
  }

  return { state: 'ok', healthAgeMs: healthAge };
}

module.exports = { judgeRenderLiveness, LIVENESS_DEFAULTS: DEFAULTS };
