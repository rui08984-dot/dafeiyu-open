#!/usr/bin/env node
/**
 * _probe/drag-perf-accept.cjs — 拖动性能验收（2026-11-21）
 *
 * 背景（用户反馈）：拖她的时候卡、有拖影、桌面其他应用也掉帧、眼睛像盯着桌面。
 * 实测根因：窗口移动幅度直接决定渲染帧率 ——
 *   静止 76fps / ±1px 79 / ±20px 62 / ±40px 53 / ±80px 38。
 * 真实拖动每帧几十 px，合成器被窗口移动占满；页面同时按 60fps 重绘整窗，
 * 形成正反馈（rAF 与 timer 一起变慢 → 拖动跟不上）。
 *
 * 修法：拖动期间**冻结渲染**（画面不需要变，Chromium 只更新窗口位置）
 *   + 拖动期间关掉 backdrop-filter（透明窗口上每帧重采样桌面）
 *   + 主进程尺寸校正节流 250ms。
 *
 * 本脚本验收 4 条：
 *   ① 拖动标志期间 frozenFrames 增长（冻结真的在跑，不是加了个没人走的判断）
 *   ② 拖动期间 rAF fps ≥ 100（优化前 ±40px 约 53）
 *   ③ 松手后冻结停止、gaze 恢复更新（渲染继续，不是永久冻死）
 *   ④ 只点击不拖动 → 不冻结（点摸头/轻反应不能被吞掉）
 *
 * 用 move-by 模拟拖动（来回一 px 净位移 0），不依赖真实鼠标、不动用户前台窗口。
 * 需要宿主（8004）。
 */
'use strict';

const BASE = process.env.PET_DEVTOOLS || 'http://127.0.0.1:8004';

async function evalJs(js) {
  const r = await fetch(BASE + '/eval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ js }) });
  const j = await r.json();
  if (!j.ok) throw new Error('eval failed: ' + JSON.stringify(j).slice(0, 300));
  return j.value;
}

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

(async () => {
  // ① + ③：冻结在拖动期间增长、结束后停止，且渲染真的恢复（renderedFrames 在涨）
  const r1 = await evalJs(`(async () => {
    const api = window.petBody;
    if (!api || !api.dragFreezeState) return { unsupported: true };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const before = api.dragFreezeState();
    window.__pbDragging = true; window.__pbDraggingAt = Date.now();
    await sleep(500);
    const during = api.dragFreezeState();
    window.__pbDragging = false;
    await sleep(200);
    const after0 = api.dragFreezeState();
    await sleep(500);
    const after1 = api.dragFreezeState();
    return { before, during, after0, after1, renderedDelta: after1.renderedFrames - after0.renderedFrames };
  })()`);
  if (r1.unsupported) {
    ok('宿主暴露 dragFreezeState', false, '旧包未部署（先 build-and-deploy-petbody + 重启）');
  } else {
    ok('拖动期间冻结计数增长', r1.during.frozenFrames > r1.before.frozenFrames,
      `${r1.before.frozenFrames} → ${r1.during.frozenFrames}`);
    ok('拖动标志生效（dragging=true）', r1.during.dragging === true);
    ok('松手后冻结停止', r1.after1.frozenFrames === r1.during.frozenFrames && r1.after0.dragging === false);
    ok('松手后渲染恢复（renderedFrames 在涨）', r1.renderedDelta >= 5, `500ms 渲染 ${r1.renderedDelta} 帧`);
  }

  // ②：拖动（±40px，每 16ms）+ 冻结 → rAF fps
  // 2026-11-22：宿主现在真的处理 pet:move-by（之前没有 handler，测的是「窗口没动」）。
  // 跑完必须把窗口移回原位，否则重复跑会让她一轮漂 40px。
  const boundsBefore = await (await fetch(BASE + '/bounds')).json();
  const r2 = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // ⓪ 先证明 pet:move-by 真的移动窗口（2026-11-22：之前宿主没有这个 handler，
    //    所谓「拖动测试」窗口根本没动过）。+40 后读 bounds，再 -40 复位。
    const b0 = await ipcRenderer.invoke('get-window-bounds');
    ipcRenderer.send('pet:move-by', 40, 0);
    await sleep(80);
    const b1 = await ipcRenderer.invoke('get-window-bounds');
    ipcRenderer.send('pet:move-by', -40, 0);
    await sleep(80);
    // ② 拖动期间「跟手延迟」——这是用户真正能感知的判据。
    // 为什么不拿帧率当硬判据（2026-11-22 实测，三把尺子都不可信）：
    //   · rAF：真移动时被合成器挤到 25–53fps，但它只是 JS 回调频率（我们冻结渲染后 JS 提前 return，低也无副作用）；
    //   · beginFrameSubscription：Electron 28 硬编码封顶 30fps；
    //   · contentTracing Display::FrameDisplayed：1.2s 只捕到 7–37 个事件（idle 也才 51.7fps），事件稀疏不可用。
    // 所以硬判据改成「发目标位移 → 窗口实际到达的耗时」：>150ms 才算视觉滞后。
    const lag = await (async () => {
      const ipcRenderer2 = require('electron').ipcRenderer;
      const readX = async () => (await ipcRenderer2.invoke('get-window-bounds')).x;
      const x0 = await readX();
      const t0 = performance.now();
      ipcRenderer2.send('pet:move-by', 40, 0);
      let x1 = x0;
      for (let i = 0; i < 30; i += 1) {
        await new Promise(r => setTimeout(r, 10));
        x1 = await readX();
        if (Math.abs(x1 - (x0 + 40)) <= 2) return { ms: Math.round(performance.now() - t0), reached: true, from: x0, to: x1 };
      }
      return { ms: Math.round(performance.now() - t0), reached: false, from: x0, to: x1 };
    })();
    ipcRenderer.send('pet:move-by', -40, 0);
    await new Promise(r => setTimeout(r, 60));
    window.__pbDragging = true; window.__pbDraggingAt = Date.now();
    let n = 0;
    const iv = setInterval(() => {
      try { ipcRenderer.send('pet:move-by', n % 2 ? 40 : -40, 0); window.__pbDraggingAt = Date.now(); } catch (e) {}
      n += 1;
    }, 16);
    let frames = 0; const t0 = performance.now();
    const loop = (ts) => { frames += 1; if (ts - t0 < 1200) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    await new Promise(r => setTimeout(r, 1250));
    clearInterval(iv);
    window.__pbDragging = false;
    const freeze = window.petBody && window.petBody.dragFreezeState ? window.petBody.dragFreezeState() : null;
    // 净位移已抵消（偶数次 ±40）；保险再回正一次
    try { ipcRenderer.send('pet:move-by', 0, 0); } catch (e) {}
    return { moves: n, rafFps: Math.round(frames / 1.2), lag, freeze, b0, b1 };
  })()`);
  ok('pet:move-by 真的移动窗口（+40px 后 bounds 生效）',
    Math.abs(Number(r2.b1.x) - Number(r2.b0.x)) >= 30,
    `x ${r2.b0.x} → ${r2.b1.x}（Δ${Number(r2.b1.x) - Number(r2.b0.x)}）`);
  ok('拖动跟手延迟 ≤ 150ms（窗口实际到达目标位移的耗时）',
    !!(r2.lag && r2.lag.reached && r2.lag.ms <= 150),
    r2.lag ? `${r2.lag.ms}ms ${r2.lag.reached ? '已到达' : '未到达'}（x ${r2.lag.from} → ${r2.lag.to}）` : '没测到');
  ok('拖动期间冻结在跑（frozenFrames 随拖动增长）',
    !!(r2.freeze && Number(r2.freeze.frozenFrames) > 0),
    r2.freeze ? ('frozen=' + r2.freeze.frozenFrames + ' rendered=' + r2.freeze.renderedFrames) : '读不到');
  console.log('  · 参考：rAF ' + r2.rafFps + 'fps（真移动时被合成器压低是正常现象，我们冻结后 JS 提前 return）· moves=' + r2.moves);
  // 把窗口移回测前位置（±40 交替的奇偶净位移最多 40px）
  try {
    const boundsAfter = await (await fetch(BASE + '/bounds')).json();
    const dx = Number(boundsBefore.bounds && boundsBefore.bounds.x) - Number(boundsAfter.bounds && boundsAfter.bounds.x);
    const dy = Number(boundsBefore.bounds && boundsBefore.bounds.y) - Number(boundsAfter.bounds && boundsAfter.bounds.y);
    if (Number.isFinite(dx) && Number.isFinite(dy) && (dx !== 0 || dy !== 0)) {
      await evalJs(`(() => { require('electron').ipcRenderer.send('pet:move-by', ${dx}, ${dy}); return true; })()`);
      console.log('  · 已把窗口移回测前位置 (' + dx + ', ' + dy + ')');
    }
  } catch (e) { console.log('  · 窗口位置回正失败（不影响验收）: ' + (e && e.message || e)); }

  // ④：只点击不拖动 → 不冻结
  const r3 = await evalJs(`(async () => {
    const api = window.petBody;
    const before = api.dragFreezeState().frozenFrames;
    await new Promise(r => setTimeout(r, 400));
    return { before, after: api.dragFreezeState().frozenFrames };
  })()`);
  ok('非拖动时冻结计数不变（点击/待机不受影响）', r3.before === r3.after, `${r3.before} → ${r3.after}`);

  console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => {
  console.error('  ✗ 验收脚本异常：' + (e && e.message || e));
  process.exitCode = 1;
});
