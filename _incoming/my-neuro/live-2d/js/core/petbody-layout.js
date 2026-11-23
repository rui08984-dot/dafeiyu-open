// petbody-layout.js —— 皮套宿主 UI 的纯函数适配层（2026-11-23 B7）
//
// 背景：宿主 ui-controller 的布局值是为「1440~2560 宽的整屏巨窗」写死的
// （聊天框宽 350、字幕按主屏宽、气泡 offsetX=400/offsetY=50、窄/宽以 700 切换）。
// 皮套窗是 420×760 的透明小窗，这些值会溢出/跑到窗外；于是两边各自打补丁：
//   · js/ui/ui-controller.js 里塞 `|| 420`、`< 700`
//   · js/avatar/petbody/ui.js 用内联 !important + 1.5s 轮询再盖一遍
// 这不是适配层，是两套写死值互相覆盖。
//
// 这个模块只做纯计算（无 DOM / 无 Electron），把「视口 → 可用尺寸/位置」集中到一处，
// 由宿主调用。pet-runtime/desktop/ui/** 是独立皮套渲染器自己的 UI（固定设计稿），
// 不在本轮改动范围；它的硬编码假设记录在审计结论里。

'use strict';

const DESIGN = {
    /** 皮套窗设计稿（config.ui.pet_window 默认值，main.js 也用 420×760）。 */
    width: 420,
    height: 760,
    /** 宿主原布局的窄/宽分界（低于它走窄窗规则）。 */
    narrowBreakpoint: 700,
    /** 聊天框首选宽度（宽窗沿用宿主原值）。 */
    chatPreferredWidth: 350,
    /** 窄窗左右留白：width = viewport - 2 * sideGap。 */
    sideGap: 16,
    /** 字幕占视口宽比例（宿主原实现 0.92）。 */
    subtitleRatio: 0.92,
    /** 气泡相对模型原点的默认偏移（宿主原值，宽窗下成立）。 */
    bubbleOffsetX: 400,
    bubbleOffsetY: 50,
    /** 气泡/工具气泡距窗口边缘的最小留白。 */
    edgeMargin: 8,
    /** 皮套没有 toGlobal 时，模型锚点相对画布的位置（半身取景下头肩区域）。 */
    petBodyAnchorX: 0.5,
    petBodyAnchorY: 0.42,
};

function finiteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function viewportWidth(width) {
    return Math.max(1, finiteNumber(width, DESIGN.width));
}

function viewportHeight(height) {
    return Math.max(1, finiteNumber(height, DESIGN.height));
}

/** 是否按窄窗规则布局（宿主原实现写死 `< 700`）。 */
function isNarrow(width, breakpoint = DESIGN.narrowBreakpoint) {
    return viewportWidth(width) < finiteNumber(breakpoint, DESIGN.narrowBreakpoint);
}

/**
 * 聊天框尺寸。窄窗撑满（左右各留 sideGap）；宽窗沿用 350。
 * @returns {{narrow: boolean, width: number, maxWidth: number}}
 */
function chatBoxSize(width, options = {}) {
    const w = viewportWidth(width);
    const gap = finiteNumber(options.sideGap, DESIGN.sideGap);
    const preferred = finiteNumber(options.preferredWidth, DESIGN.chatPreferredWidth);
    const narrow = isNarrow(w, options.breakpoint);
    const value = narrow ? Math.max(120, w - gap * 2) : Math.min(preferred, Math.max(120, w - gap * 2));
    return { narrow, width: Math.round(value), maxWidth: Math.round(value) };
}

/** 字幕宽度：始终按视口比例，窄窗不再用主屏像素。 */
function subtitleWidth(width, options = {}) {
    const w = viewportWidth(width);
    const ratio = Math.min(1, Math.max(0.2, finiteNumber(options.ratio, DESIGN.subtitleRatio)));
    return Math.max(200, Math.round(w * ratio));
}

/** 把矩形夹进视口（宽高不足时以边距优先，返回非负坐标）。 */
function clampToViewport(x, y, box = {}, viewport = {}, options = {}) {
    const margin = Math.max(0, finiteNumber(options.margin, DESIGN.edgeMargin));
    const vw = viewportWidth(viewport.width);
    const vh = viewportHeight(viewport.height);
    const bw = Math.max(0, finiteNumber(box.width, 0));
    const bh = Math.max(0, finiteNumber(box.height, 0));
    const maxX = Math.max(margin, vw - bw - margin);
    const maxY = Math.max(margin, vh - bh - margin);
    return {
        x: Math.round(Math.min(Math.max(finiteNumber(x, margin), margin), maxX)),
        y: Math.round(Math.min(Math.max(finiteNumber(y, margin), margin), maxY)),
    };
}

/**
 * 气泡目标位置：模型锚点 + 原偏移，再夹回视口。
 * 宽窗下若原偏移本来就在视口内，结果与旧实现一致（不改变既有视觉）。
 * @returns {{x: number, y: number, clamped: boolean}}
 */
function bubbleTarget(input = {}) {
    const modelX = finiteNumber(input.modelX, 0);
    const modelY = finiteNumber(input.modelY, 0);
    const offsetX = finiteNumber(input.offsetX, DESIGN.bubbleOffsetX);
    const offsetY = finiteNumber(input.offsetY, DESIGN.bubbleOffsetY);
    const vw = viewportWidth(input.viewportWidth);
    const vh = viewportHeight(input.viewportHeight);
    const rawX = modelX + offsetX;
    const rawY = modelY + offsetY;
    const target = clampToViewport(rawX, rawY, {
        width: input.bubbleWidth,
        height: input.bubbleHeight,
    }, { width: vw, height: vh }, { margin: input.margin });
    return {
        x: target.x,
        y: target.y,
        clamped: target.x !== Math.round(rawX) || target.y !== Math.round(rawY),
    };
}

/**
 * 皮套没有 toGlobal/getScreenHitBox 时的模型锚点（由画布 DOMRect 推算）。
 * 这是「适配器缺位」的兜底：只依赖渲染器实际画布，不假设窗口尺寸。
 */
function petBodyAnchor(rect = {}) {
    const left = finiteNumber(rect.left, 0);
    const top = finiteNumber(rect.top, 0);
    const width = Math.max(0, finiteNumber(rect.width, 0));
    const height = Math.max(0, finiteNumber(rect.height, 0));
    return {
        x: left + width * DESIGN.petBodyAnchorX,
        y: top + height * DESIGN.petBodyAnchorY,
    };
}

/** 皮套的可用边界（工具气泡用）；同样来自画布 rect。 */
function petBodyBounds(rect = {}) {
    const left = finiteNumber(rect.left, 0);
    const top = finiteNumber(rect.top, 0);
    const width = Math.max(0, finiteNumber(rect.width, 0));
    const height = Math.max(0, finiteNumber(rect.height, 0));
    return { left, top, right: left + width, bottom: top + height, width, height };
}

module.exports = {
    DESIGN,
    isNarrow,
    chatBoxSize,
    subtitleWidth,
    clampToViewport,
    bubbleTarget,
    petBodyAnchor,
    petBodyBounds,
};
