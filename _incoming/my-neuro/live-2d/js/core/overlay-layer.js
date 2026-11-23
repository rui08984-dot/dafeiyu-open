/**
 * overlay-layer.js — 「她的虚拟光标」指示层（2026-11-14 五十三轮从 main.js 抽出）
 *
 * 为什么抽出来：这段逻辑原来直接写死在 main.js 里（150 行 + 一坨内联 HTML），
 * 三件事实在是耦合在一起：窗口生命周期、多显示器坐标换算、CSS 绘制。
 * 抽出来以后：几何换算可以在 node 里单测（不用起 Electron），main.js 只留一行 IPC 接线。
 *
 * 设计要点（用户原话：“实际使用的 Windows 光标和电脑操控的光标可以是两个”）：
 *   · 真实光标归用户 —— 她的动作结束后由 pet-core 的 restoreCursor 还回原位
 *   · 她的光标 —— 本模块的橙色箭头（#cursor），常驻到 TTL 到期
 *   · 每个显示器一个 overlay 窗口（用户把游戏/窗口挪到第二屏是常态，
 *     旧实现只建主屏一个 → 第二屏上的指示画到主屏同坐标上去了）
 *   · 坐标空间：渲染进程传**物理像素**（和 pet-core/截图同口径），
 *     这里按各显示器自己的 scaleFactor 换成该窗口的**局部 DIP**
 *
 * 窗口参数（与 ZCode CUA 的 ZcodeGhostCursorOverlay 对齐过）：
 *   focusable:false + showInactive → 不抢焦点，不打断用户打字
 *   skipTaskbar + type=toolbar    → 不进任务栏 / alt-tab
 *   transparent + setIgnoreMouse  → 点击穿透
 *   setContentProtection(true)    → 不进我们自己的截图（否则动作验证永远「画面没变」）
 */
'use strict';

const OVERLAY_HTML = '<!doctype html><html><head><meta charset="utf-8"><style>'
    + 'html,body{margin:0;padding:0;background:transparent;overflow:hidden;'
    + 'font:13px/1.4 "Microsoft YaHei UI","Microsoft YaHei",sans-serif;user-select:none}'
    + '#box{position:absolute;border:2.5px solid rgba(56,189,248,.92);border-radius:7px;'
    + 'box-shadow:0 0 18px rgba(56,189,248,.55),inset 0 0 12px rgba(56,189,248,.15);'
    + 'opacity:0;transition:opacity .15s ease}'
    + '#ring{position:absolute;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;'
    + 'border:2.5px solid #38bdf8;box-shadow:0 0 14px rgba(56,189,248,.9),inset 0 0 8px rgba(56,189,248,.45);'
    + 'opacity:0;transition:opacity .12s ease}'
    + '#ring::after{content:"";position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;'
    + 'border-radius:50%;background:#38bdf8;box-shadow:0 0 8px #38bdf8}'
    + '#tag{position:absolute;padding:3px 9px;border-radius:6px;background:rgba(8,14,26,.88);'
    + 'color:#7dd3fc;border:1px solid rgba(56,189,248,.5);white-space:nowrap;opacity:0;'
    + 'font-size:12px;letter-spacing:.3px;transition:opacity .15s ease}'
    + '#cursor{position:absolute;left:0;top:0;opacity:0;pointer-events:none;'
    + 'transition:transform .16s ease-out,opacity .12s ease;filter:drop-shadow(0 1px 3px rgba(0,0,0,.55))}'
    + '#cursor svg{display:block}'
    + '#cursorLabel{position:absolute;left:22px;top:20px;padding:2px 8px;border-radius:6px;'
    + 'background:rgba(40,16,4,.86);color:#fdba74;border:1px solid rgba(249,115,22,.55);'
    + 'font-size:12px;white-space:nowrap}'
    + '#cursorLabel:empty{display:none}'
    + '.show{opacity:1 !important}'
    + '</style></head><body><div id="box"></div><div id="ring"></div><div id="tag"></div>'
    + '<div id="cursor"><svg width="24" height="30" viewBox="0 0 24 30">'
    + '<path d="M2 1.5 L2 22.5 L7.2 17.4 L10.6 25.2 L14 23.7 L10.7 16.1 L18 15.7 Z" '
    + 'fill="#f97316" stroke="#ffffff" stroke-width="1.7" stroke-linejoin="round"/>'
    + '</svg><span id="cursorLabel"></span></div>'
    // __apply 是**部分更新**：只改 payload 里出现的字段（null = 清掉该项），
    // 否则每次画光标都会把同屏的框/圈一起清掉。
    + '<script>window.__apply=function(p){'
    + 'var b=document.getElementById("box"),r=document.getElementById("ring"),t=document.getElementById("tag"),'
    + 'c=document.getElementById("cursor"),cl=document.getElementById("cursorLabel");'
    + 'if("box" in p){if(p.box){b.style.left=p.box.x+"px";b.style.top=p.box.y+"px";b.style.width=p.box.w+"px";'
    + 'b.style.height=p.box.h+"px";b.classList.add("show");}else b.classList.remove("show");}'
    + 'if("point" in p){if(p.point){r.style.left=p.point.x+"px";r.style.top=p.point.y+"px";r.classList.add("show");}'
    + 'else r.classList.remove("show");}'
    + 'if("tag" in p){if(p.tag){t.textContent=p.tag.text;t.style.left=p.tag.x+"px";t.style.top=p.tag.y+"px";'
    + 't.classList.add("show");}else t.classList.remove("show");}'
    + 'if("cursor" in p){if(p.cursor){c.style.transform="translate3d("+(p.cursor.x-2)+"px,"+(p.cursor.y-1)+"px,0)";'
    + 'cl.textContent=p.cursor.label||"";c.classList.add("show");}else c.classList.remove("show");}'
    + '};</script></body></html>';

/**
 * 物理像素 → Electron 的 DIP 坐标。
 *
 * ⚠ 2026-11-14 五十三轮实测（本机双屏：主屏 2560×1440@1x、副屏 1708×961@1.5x）：
 *   **不能用「物理 / 自己的 scaleFactor」算**。真实映射是 Chromium 的：
 *     物理 (2700,800) → DIP (2653.3, 960.7)
 *   而 2700/1.5 = 1800、2700-2560 = 140 → 都对不上。
 *   Windows 的多屏布局在**物理像素**里（副屏物理原点在 (2560,-155)），
 *   Chromium 再按各屏 DPI 映射成一套 DIP —— 唯一正确的做法是问 Electron 自己
 *   （`screen.screenToDipPoint`，Windows 独有）。没有这个 API 才退回主屏 sf 估算。
 */
function makeToDip(screen) {
    const primarySf = (() => {
        try {
            const p = screen && screen.getPrimaryDisplay && screen.getPrimaryDisplay();
            return (p && p.scaleFactor) || 1;
        } catch (e) { return 1; }
    })();
    return function toDip(p) {
        const x = Number(p && p.x);
        const y = Number(p && p.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };
        try {
            if (screen && typeof screen.screenToDipPoint === 'function') {
                const q = screen.screenToDipPoint({ x, y });
                if (q && Number.isFinite(q.x) && Number.isFinite(q.y)) return q;
            }
        } catch (e) { /* 老版本没有这个 API → 走估算 */ }
        return { x: x / primarySf, y: y / primarySf };
    };
}

/** DIP 点落在哪个显示器（屏外取最近的，不静默回主屏） */
function displayForDip(dip, displays) {
    const all = Array.isArray(displays) && displays.length ? displays : [{ id: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }];
    for (const d of all) {
        const b = d.bounds || { x: 0, y: 0, width: 0, height: 0 };
        if (dip.x >= b.x && dip.x < b.x + b.width && dip.y >= b.y && dip.y < b.y + b.height) return d;
    }
    let best = all[0];
    let bestD = Infinity;
    for (const d of all) {
        const b = d.bounds || { x: 0, y: 0, width: 0, height: 0 };
        const dd = Math.pow(dip.x - (b.x + b.width / 2), 2) + Math.pow(dip.y - (b.y + b.height / 2), 2);
        if (dd < bestD) { bestD = dd; best = d; }
    }
    return best;
}

/**
 * 物理像素 payload → 该显示器窗口的局部 DIP（只转换 payload 里实际出现的字段）。
 * @param {object} d 显示器
 * @param {object} payload
 * @param {Function} toDip 物理→DIP（由 makeToDip 生成；单测里可以注入假实现）
 */
function toLocal(d, payload, toDip) {
    const b = (d && d.bounds) || { x: 0, y: 0, width: 0, height: 0 };
    const conv = typeof toDip === 'function' ? toDip : (p) => ({ x: p.x, y: p.y });
    const sf = (d && d.scaleFactor) || 1;
    const local = (px, py) => {
        const q = conv({ x: Number(px), y: Number(py) });
        return { x: Math.round(q.x - b.x), y: Math.round(q.y - b.y) };
    };
    const src = payload || {};
    const out = {};
    if ('box' in src) {
        out.box = src.box
            ? Object.assign(local(src.box.x, src.box.y), {
                w: Math.max(2, Math.round(src.box.w / sf)), h: Math.max(2, Math.round(src.box.h / sf)),
            })
            : null;
    }
    if ('point' in src) out.point = src.point ? local(src.point.x, src.point.y) : null;
    if ('tag' in src) {
        out.tag = src.tag
            ? { text: String(src.tag.text || '').slice(0, 40),
                x: Number.isFinite(src.tag.x) ? local(src.tag.x, src.tag.y).x : 12,
                y: Number.isFinite(src.tag.y) ? local(src.tag.x, src.tag.y).y : 12 }
            : null;
    }
    if ('cursor' in src) {
        out.cursor = src.cursor
            ? { x: local(src.cursor.x, src.cursor.y).x, y: local(src.cursor.x, src.cursor.y).y,
                label: String(src.cursor.label || '').slice(0, 24) }
            : null;
    }
    return out;
}

/**
 * 建一个指示层管理器。
 * @param {object} opts
 * @param {Function} opts.BrowserWindow Electron 的 BrowserWindow 构造器
 * @param {object} opts.screen Electron 的 screen 模块（需要 getAllDisplays/on）
 * @param {Function} [opts.log]
 */
function createOverlayLayer(opts) {
    const BrowserWindow = opts && opts.BrowserWindow;
    const screen = opts && opts.screen;
    const log = (opts && opts.log) || ((...a) => console.log(...a));
    const warn = (opts && opts.warn) || ((...a) => console.warn(...a));
    /** displayId → { win, hideTimer, cursorTimer } */
    const wins = new Map();

    function ensure(d) {
        const key = String(d.id);
        const cur = wins.get(key);
        if (cur && cur.win && !cur.win.isDestroyed()) return cur;
        const rec = { win: null, hideTimer: null, cursorTimer: null, loaded: false, pending: null, d: d };
        try {
            const win = new BrowserWindow({
                x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
                frame: false, transparent: true, resizable: false, movable: false,
                minimizable: false, maximizable: false, fullscreenable: false,
                skipTaskbar: true, focusable: false, hasShadow: false, show: false,
                enableLargerThanScreen: true,
                type: process.platform === 'win32' ? 'toolbar' : 'panel',
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    backgroundThrottling: false,
                    devTools: false,
                },
            });
            win.setIgnoreMouseEvents(true, { forward: false });
            try { win.setContentProtection(true); } catch (e) {
                warn('[overlay] setContentProtection 不可用（截图可能拍到 overlay）:', e && e.message || e);
            }
            try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (e) {
                try { win.setAlwaysOnTop(true); } catch (e2) { /* 置顶失败不影响透明窗 */ }
            }
            // ⚠ 2026-11-14 五十三轮真机验收抓到的坑：`new BrowserWindow` 之后立刻
            //   `webContents.isLoading()` 返回 **false**（加载还没开始），于是
            //   `executeJavaScript('window.__apply(...)')` 打在 about:blank 上——
            //   **静默成功、什么都没画**（旧实现在这里就丢过首帧）。
            //   现在用显式 loaded 标记 + 待绘制缓存，did-finish-load 后再补画。
            win.webContents.on('did-finish-load', () => {
                rec.loaded = true;
                const p = rec.pending;
                rec.pending = null;
                if (p) paint(rec, p);
            });
            win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(OVERLAY_HTML));
            win.on('closed', () => {
                const r = wins.get(key);
                if (r) { if (r.hideTimer) clearTimeout(r.hideTimer); if (r.cursorTimer) clearTimeout(r.cursorTimer); }
                wins.delete(key);
            });
            rec.win = win;
            wins.set(key, rec);
            log('[overlay] 显示器 ' + d.id + ' 指示层已创建（' + d.bounds.width + '×' + d.bounds.height
                + ' DIP, scale=' + (d.scaleFactor || 1) + '）');
        } catch (e) {
            warn('[overlay] 创建失败:', e && e.message || e);
            return null;
        }
        return rec;
    }

    function hideRec(key, rec) {
        try { if (rec.win && !rec.win.isDestroyed()) rec.win.hide(); } catch (e) { /* 窗口已关 */ }
        if (rec.hideTimer) { clearTimeout(rec.hideTimer); rec.hideTimer = null; }
        if (rec.cursorTimer) { clearTimeout(rec.cursorTimer); rec.cursorTimer = null; }
    }

    function paint(rec, local) {
        try {
            const win = rec.win;
            if (!win || win.isDestroyed()) return;
            if (!rec.loaded) {
                // 页面还没加载完：合并进待绘制（部分更新语义 → 同 key 覆盖，别的 key 保留）
                rec.pending = Object.assign({}, rec.pending || {}, local);
                return;
            }
            win.showInactive();   // 不激活：不会把你正在打字的窗口抢走
            win.webContents.executeJavaScript('window.__apply(' + JSON.stringify(local) + ')').catch((e) => {
                warn('[overlay] 绘制失败:', e && e.message || e);
            });
        } catch (e) {
            warn('[overlay] 显示失败:', e && e.message || e);
        }
    }

    function applyOne(rec, p, toDip) {
        const key = String(rec.d.id);
        const local = toLocal(rec.d, p, toDip);
        paint(rec, local);

        // 瞬时提示（框/圈/标签）：TTL 到期只清这三样，不碰常驻光标
        if (('box' in local) || ('point' in local) || ('tag' in local)) {
            const ttl = Math.max(300, Math.min(10000, Number(p.ttl) || 1200));
            if (rec.hideTimer) clearTimeout(rec.hideTimer);
            rec.hideTimer = setTimeout(() => {
                rec.hideTimer = null;
                try {
                    if (!rec.win || rec.win.isDestroyed()) return;
                    rec.win.webContents.executeJavaScript('window.__apply({"box":null,"point":null,"tag":null})')
                        .catch(() => { /* 窗口正在销毁时忽略 */ });
                } catch (e) { /* 忽略 */ }
                if (!rec.cursorTimer) hideRec(key, rec);   // 没有常驻光标就收窗（省一次合成）
            }, ttl);
            if (rec.hideTimer.unref) rec.hideTimer.unref();
        }

        // 她的虚拟光标：常驻，但「一段时间没更新」就消失（不留幽灵指针）
        if ('cursor' in local) {
            if (rec.cursorTimer) { clearTimeout(rec.cursorTimer); rec.cursorTimer = null; }
            if (local.cursor) {
                const cttl = Math.max(800, Math.min(60000, Number(p.cursorTtl) || 5000));
                rec.cursorTimer = setTimeout(() => {
                    rec.cursorTimer = null;
                    try {
                        if (!rec.win || rec.win.isDestroyed()) return;
                        rec.win.webContents.executeJavaScript('window.__apply({"cursor":null})').catch(() => { /* 忽略 */ });
                    } catch (e) { /* 忽略 */ }
                    if (!rec.hideTimer) hideRec(key, rec);
                }, cttl);
                if (rec.cursorTimer.unref) rec.cursorTimer.unref();
            } else if (!rec.hideTimer) {
                hideRec(key, rec);   // 主动清光标且没有瞬时提示 → 收窗
            }
        }
    }

    function show(payload) {
        const p = payload || {};
        const toDip = makeToDip(screen);
        const displays = screen && typeof screen.getAllDisplays === 'function' ? screen.getAllDisplays() : [];
        // 有落点 → 只画那块屏；**全是 null（清除）→ 广播到所有已存在的屏**。
        // ⚠ 2026-11-14 五十三轮真机验收抓到的坑：`{cursor:null}` 没有落点，
        //   按 (0,0) 选屏会去主屏**新建**一个窗口画「空」，第二屏上的光标根本不清除。
        const hasPos = (p.cursor && Number.isFinite(p.cursor.x))
            || (p.point && Number.isFinite(p.point.x))
            || (p.box && Number.isFinite(p.box.x))
            || (p.tag && Number.isFinite(p.tag.x) && Number.isFinite(p.tag.y));

        const recs = [];
        if (hasPos) {
            const anchor = (p.cursor && Number.isFinite(p.cursor.x)) ? p.cursor
                : (p.point && Number.isFinite(p.point.x)) ? p.point
                : (p.box && Number.isFinite(p.box.x)) ? { x: p.box.x + (p.box.w || 0) / 2, y: p.box.y + (p.box.h || 0) / 2 }
                : { x: p.tag.x, y: p.tag.y };
            const d = displayForDip(toDip(anchor), displays);
            const rec = ensure(d);
            if (!rec) return false;
            recs.push(rec);
        } else {
            for (const [, r] of wins) recs.push(r);
            if (!recs.length) return false;   // 没有窗口就没有东西要清
        }
        for (const rec of recs) applyOne(rec, p, toDip);
        return true;
    }

    function hideAll() {
        for (const [key, rec] of wins) hideRec(key, rec);
    }

    /** 显示器拔掉时清掉那一块（不然会留一个看不见的置顶窗） */
    function dropDisplay(d) {
        const key = String(d.id);
        const rec = wins.get(key);
        if (!rec) return;
        if (rec.hideTimer) clearTimeout(rec.hideTimer);
        if (rec.cursorTimer) clearTimeout(rec.cursorTimer);
        try { if (rec.win && !rec.win.isDestroyed()) rec.win.destroy(); } catch (e) { /* 已销毁 */ }
        wins.delete(key);
    }

    return { show, hideAll, dropDisplay, _wins: wins };
}

module.exports = { createOverlayLayer, makeToDip, displayForDip, toLocal, OVERLAY_HTML };
