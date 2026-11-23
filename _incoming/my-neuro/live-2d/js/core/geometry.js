/**
 * geometry.js —— 屏幕/窗口矩形几何（E5 最小切口，2026-11-22）
 *
 * 从 plugins/community/dispatch/game-control.js 抽出的**纯函数层**。
 * 只做四类计算：矩形归一、DPI 换算、点是否在矩形内、点钳制到矩形内。
 * 不做 IO、不读 Electron、不依赖任何全局。
 *
 * 坐标约定：本模块不区分 DIP/物理像素 —— 由调用方决定单位，换算只乘/除 scaleFactor。
 * game-control 的注入层吃**物理像素**；Electron 的 display.bounds 是 DIP。
 *
 * 行为零变化（E5 硬约束）：
 *   · rectContains 与原内联判断一致：**闭区间**（x 落在右边界也算在内）；
 *   · pointOnAnyScreen 的 tol 默认值保持历史的 1（不是 0）—— Number(undefined) 是 NaN，
 *     原实现的 `Number(tol) >= 0 ? ... : 1` 对 undefined 会落到 1；
 *   · normalizeRect 对负数宽高的处理是「平移原点 + 取正」，正数输入逐位不变。
 */

'use strict';

/**
 * 矩形归一。接受对象（{x,y,w,h} 或 {x,y,width,height}）或四个参数。
 *
 * 负宽/负高 → 原点平移到左上角、宽高取正（Windows RECT 允许 right < left）。
 * NaN/非数字原样保留 NaN（不偷偷改成 0 —— 调用方据此判「数据不可用」）。
 *
 * @param {object|number} rectOrX
 * @param {number} [y]
 * @param {number} [w]
 * @param {number} [h]
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function normalizeRect(rectOrX, y, w, h) {
    let x;
    let ww;
    let hh;
    let yy;
    if (rectOrX && typeof rectOrX === 'object') {
        const r = rectOrX;
        x = r.x;
        yy = r.y;
        ww = r.w !== undefined ? r.w : r.width;
        hh = r.h !== undefined ? r.h : r.height;
    } else {
        x = rectOrX;
        yy = y;
        ww = w;
        hh = h;
    }
    x = Number(x);
    yy = Number(yy);
    ww = Number(ww);
    hh = Number(hh);
    if (ww < 0) { x += ww; ww = -ww; }
    if (hh < 0) { yy += hh; hh = -hh; }
    return { x, y: yy, w: ww, h: hh };
}

/** scaleFactor 兜底：<=0 / NaN / 非数字一律 1（与 game-control 原实现一致）。 */
function scaleOf(scaleFactor) {
    const sf = Number(scaleFactor);
    return sf > 0 ? sf : 1;
}

/**
 * 物理像素 → DIP（除以该屏 scaleFactor）。
 * @param {number} px
 * @param {number} [scaleFactor]
 * @returns {number}
 */
function toDip(px, scaleFactor) {
    return Number(px) / scaleOf(scaleFactor);
}

/**
 * DIP → 物理像素（乘以该屏 scaleFactor）。toDip 的逆运算。
 * @param {number} dip
 * @param {number} [scaleFactor]
 * @returns {number}
 */
function toPhysical(dip, scaleFactor) {
    return Number(dip) * scaleOf(scaleFactor);
}

/**
 * 点是否在矩形内（闭区间）。tol 同时向外扩四条边（吸收 DIP×scaleFactor 的舍入）。
 *
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @param {number} x
 * @param {number} y
 * @param {number} [tol] 容差，默认 0；只有 >0 才生效
 * @returns {boolean}
 */
function rectContains(rect, x, y, tol) {
    if (!rect) return false;
    const t = Number(tol) > 0 ? Number(tol) : 0;
    const px = Number(x);
    const py = Number(y);
    const rx = Number(rect.x);
    const ry = Number(rect.y);
    const rw = Number(rect.w);
    const rh = Number(rect.h);
    return px >= rx - t && px <= rx + rw + t && py >= ry - t && py <= ry + rh + t;
}

/**
 * 点是否落在任一矩形内，返回命中的矩形或 null。
 * tol 默认 1（历史行为：`Number(tol) >= 0 ? Number(tol) : 1`，undefined → 1）。
 *
 * @param {number} x
 * @param {number} y
 * @param {Array<{x:number,y:number,w:number,h:number}>} rects
 * @param {number} [tol]
 * @returns {object|null}
 */
function pointOnAnyScreen(x, y, rects, tol) {
    const t = Number(tol) >= 0 ? Number(tol) : 1;
    for (const r of (Array.isArray(rects) ? rects : [])) {
        if (rectContains(r, x, y, t)) return r;
    }
    return null;
}

/**
 * 把点钳制到矩形内（闭区间）。矩形为空/NaN 时原样返回点。
 * 说明：game-control 目前没有「钳制坐标」的生产路径（越界是拒绝，不是夹住；
 * region_gray 的 clamp 在 Rust 侧），所以这个函数只作为纯工具/后续复用，不接线。
 *
 * @param {number} x
 * @param {number} y
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @returns {{x:number,y:number}}
 */
function clampPoint(x, y, rect) {
    const px = Number(x);
    const py = Number(y);
    if (!rect) return { x: px, y: py };
    const left = Number(rect.x);
    const top = Number(rect.y);
    const right = left + Number(rect.w);
    const bottom = top + Number(rect.h);
    return {
        x: Math.min(Math.max(px, left), right),
        y: Math.min(Math.max(py, top), bottom),
    };
}

module.exports = {
    normalizeRect,
    toDip,
    toPhysical,
    rectContains,
    pointOnAnyScreen,
    clampPoint,
    scaleOf,
};
