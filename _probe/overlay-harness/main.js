/**
 * _probe/overlay-harness/main.js — 虚拟光标指示层「真机」验收（独立 Electron 进程）
 *
 * 为什么不能用截图验：overlay 窗口设了 `setContentProtection(true)`
 * （WDA_EXCLUDEFROMCAPTURE）—— **任何截图 API 都拍不到它**，这正是它该有的行为
 * （否则她自己的动作验证永远「画面没变」）。所以验收改成问窗口本身：
 *   ① 窗口建在哪个显示器、bounds 对不对
 *   ② __apply 之后 #cursor 是不是真的 show + transform 落在窗口内
 *   ③ 标签文字对不对
 *
 * 用法（不干扰正在运行的宿主，独立进程）：
 *   node _incoming/my-neuro/live-2d/node_modules/electron/cli.js _probe/overlay-harness
 *   加 --at 2800,700 指定物理坐标；默认取第二块屏的中心
 */
'use strict';

const { app, screen, BrowserWindow } = require('electron');
const path = require('path');

const LAYER = path.join(__dirname, '..', '..', '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'overlay-layer.js');
const { createOverlayLayer } = require(LAYER);

function argAt() {
  const i = process.argv.indexOf('--at');
  if (i > 0 && process.argv[i + 1]) {
    const m = String(process.argv[i + 1]).match(/^(-?\d+)\s*,\s*(-?\d+)$/);
    if (m) return { x: Number(m[1]), y: Number(m[2]) };
  }
  return null;
}

app.whenReady().then(async () => {
  const displays = screen.getAllDisplays();
  const sorted = displays.slice().sort((a, b) => a.bounds.x - b.bounds.x);
  const target = argAt() || (() => {
    const d = sorted[sorted.length - 1];         // 最右边那块（用户放游戏的第二屏）
    const dip = { x: d.bounds.x + d.bounds.width / 2, y: d.bounds.y + d.bounds.height / 2 };
    return screen.dipToScreenPoint ? screen.dipToScreenPoint(dip) : dip;
  })();

  const layer = createOverlayLayer({
    BrowserWindow,
    screen,
    log: (m) => console.log('[layer] ' + m),
    warn: (m) => console.warn('[layer] ' + m),
  });

  const payload = {
    cursor: { x: target.x, y: target.y, label: '验收' },
    point: { x: target.x, y: target.y },
    tag: { text: '虚拟光标验收', x: target.x + 28, y: target.y - 34 },
    ttl: 4000,
  };
  const okShow = layer.show(payload);
  console.log('SHOW_AT ' + JSON.stringify(target) + ' ok=' + okShow);

  await new Promise((r) => setTimeout(r, 900));   // 等 did-finish-load + __apply

  const recs = [...layer._wins.values()];
  let fail = 0;
  if (!recs.length) { console.error('FAIL 没有创建任何 overlay 窗口'); app.exit(1); return; }

  for (const rec of recs) {
    const win = rec.win;
    const diag = await win.webContents.executeJavaScript(`JSON.stringify({
      applyType: typeof window.__apply,
      loading: document.readyState,
      cursorEl: !!document.getElementById('cursor'),
    })`);
    console.log('DIAG ' + diag);
    const info = await win.webContents.executeJavaScript(`(function(){      var c=document.getElementById('cursor'), r=document.getElementById('ring'), t=document.getElementById('tag');
      var tr=c.style.transform||'';
      var m=tr.match(/translate3d\\((-?[\\d.]+)px,\\s*(-?[\\d.]+)px/);
      return JSON.stringify({
        cursorShown: c.classList.contains('show'),
        cx: m?Number(m[1]):null, cy: m?Number(m[2]):null,
        label: document.getElementById('cursorLabel').textContent,
        ringShown: r.classList.contains('show'),
        tagShown: t.classList.contains('show'),
        tagText: t.textContent,
        docW: document.documentElement.clientWidth, docH: document.documentElement.clientHeight,
      });
    })()`);
    const got = JSON.parse(info);
    const b = win.getBounds();
    const d = rec.d;   // 用 layer 自己认的显示器（按 bounds 猜会误判）
    const inside = got.cx !== null && got.cy !== null
      && got.cx >= 0 && got.cy >= 0 && got.cx <= b.width && got.cy <= b.height;
    const labelOk = got.label === '验收';
    console.log('WINDOW ' + JSON.stringify({ display: d && d.id, bounds: b, doc: [got.docW, got.docH], ...got }));
    if (!got.cursorShown) { console.error('FAIL 光标没有显示'); fail += 1; }
    if (!inside) { console.error('FAIL 光标局部坐标不在窗口内 ' + JSON.stringify([got.cx, got.cy, b.width, b.height])); fail += 1; }
    if (!labelOk) { console.error('FAIL 标签文字不对：' + got.label); fail += 1; }
    if (!got.ringShown) { console.error('FAIL 落点圈没有显示'); fail += 1; }
  }

  // 再验一次「清光标」：只清 cursor，不能顺带清掉框/圈/标签
  layer.show({ cursor: null });
  await new Promise((r) => setTimeout(r, 400));
  for (const rec of [...layer._wins.values()]) {
    const after = JSON.parse(await rec.win.webContents.executeJavaScript(`JSON.stringify({
      cursor: document.getElementById('cursor').classList.contains('show'),
      ring: document.getElementById('ring').classList.contains('show'),
    })`));
    console.log('AFTER_CLEAR display=' + rec.d.id + ' ' + JSON.stringify(after));
    if (after.cursor) { console.error('FAIL 清光标后光标仍在（display ' + rec.d.id + '）'); fail += 1; }
  }

  console.log(fail === 0 ? '✅ overlay 验收通过' : ('❌ overlay 验收失败 ' + fail + ' 项'));
  layer.hideAll();
  app.exit(fail === 0 ? 0 : 1);
});
