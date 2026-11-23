#!/usr/bin/env node
/**
 * _probe/test-petbody-ui-adapter.cjs —— B7「petbody UI 适配层」的纯函数与接线测试
 *
 * 审计结论（不改 pet-runtime/desktop/**）：
 *   · 宿主 ui-controller 的聊天框 350 / 字幕 0.92×主屏 / 气泡 offset 400,50 / 700 分界
 *     都是为整屏巨窗写死的；皮套窗 420×760 下会溢出或被推到窗外。
 *   · 皮套渲染器没有 toGlobal/getScreenHitBox/containsPoint，旧 _getModelScreenPosition
 *     直接 return null → 气泡/工具气泡位置永远不更新（adapter 缺位）。
 *   · pet-runtime/desktop/ui/** 是独立皮套渲染器自己的固定设计稿（420×760 分区、
 *     底部 160/290、面板宽 300、HEAD_RATIO 用 window.innerHeight||760）。本轮不改，
 *     只作为审计记录；宿主侧的适配统一收进 core/petbody-layout.js。
 *
 * 覆盖：纯函数边界（窄/宽、夹取、DPI 无关）+ ui-controller 接线静态断言。
 * 真机验收（留给人）：420×760 窗内气泡不越界、聊天框/字幕不出窗、换分辨率不破版。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const LAYOUT = path.join(LIVE, 'js', 'core', 'petbody-layout.js');
const UI_CONTROLLER = path.join(LIVE, 'js', 'ui', 'ui-controller.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name); return true; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}
function eq(name, actual, expected) {
    return ok(name, actual === expected, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}
function deepEq(name, actual, expected) {
    return ok(name, JSON.stringify(actual) === JSON.stringify(expected), '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}

const L = require(LAYOUT);

console.log('\n[A] 窄/宽与聊天框尺寸');
{
    eq('420 是窄窗', L.isNarrow(420), true);
    eq('700 不是窄窗（原实现 <700）', L.isNarrow(700), false);
    eq('1440 是宽窗', L.isNarrow(1440), false);
    eq('非法宽度按设计稿 420 处理（仍窄）', L.isNarrow(undefined), true);

    const narrow = L.chatBoxSize(420);
    deepEq('420 宽：撑满左右各留 16', { narrow: narrow.narrow, width: narrow.width, maxWidth: narrow.maxWidth }, { narrow: true, width: 388, maxWidth: 388 });
    const wide = L.chatBoxSize(1440);
    deepEq('1440 宽：沿用 350', { narrow: wide.narrow, width: wide.width }, { narrow: false, width: 350 });
    const tiny = L.chatBoxSize(100);
    ok('极窄视口：宽度不小于 120（不出现负宽）', tiny.width >= 120);

    eq('420 字幕宽 = round(420×0.92)', L.subtitleWidth(420), 386);
    eq('1440 字幕宽 = round(1440×0.92)', L.subtitleWidth(1440), 1325);
    eq('极窄字幕宽下限 200', L.subtitleWidth(50), 200);
}

console.log('\n[B] 夹取与气泡目标');
{
    deepEq('420×760 视口：200×80 气泡夹到右边距 8',
        L.clampToViewport(610, 50, { width: 200, height: 80 }, { width: 420, height: 760 }),
        { x: 212, y: 50 });
    deepEq('小于视口：保持原位',
        L.clampToViewport(100, 100, { width: 200, height: 80 }, { width: 420, height: 760 }),
        { x: 100, y: 100 });
    deepEq('负数坐标夹到边距 8',
        L.clampToViewport(-30, -30, { width: 200, height: 80 }, { width: 420, height: 760 }),
        { x: 8, y: 8 });
    deepEq('气泡比视口还大：退化为边距（不产生负坐标）',
        L.clampToViewport(0, 0, { width: 900, height: 900 }, { width: 420, height: 760 }),
        { x: 8, y: 8 });

    const wide = L.bubbleTarget({ modelX: 100, modelY: 100, viewportWidth: 1440, viewportHeight: 900, bubbleWidth: 200, bubbleHeight: 80 });
    deepEq('宽窗：原点+400/50 本来就在窗内 → 与旧实现一致', { x: wide.x, y: wide.y, clamped: wide.clamped }, { x: 500, y: 150, clamped: false });

    const narrow = L.bubbleTarget({ modelX: 210, modelY: 319.2, viewportWidth: 420, viewportHeight: 760, bubbleWidth: 200, bubbleHeight: 80 });
    eq('420 宽：x 被夹回视口', narrow.x, 212);
    eq('420 宽：clamped=true', narrow.clamped, true);
    ok('420 宽：y 在视口内', narrow.y >= 8 && narrow.y <= 760 - 80 - 8);

    const anchor = L.petBodyAnchor({ left: 0, top: 0, width: 420, height: 760 });
    deepEq('皮套锚点（无 toGlobal 时的兜底）', { x: anchor.x, y: Math.round(anchor.y * 10) / 10 }, { x: 210, y: 319.2 });
    const bounds = L.petBodyBounds({ left: 10, top: 20, width: 420, height: 760 });
    deepEq('皮套边界来自画布 rect', { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom }, { left: 10, top: 20, right: 430, bottom: 780 });
}

console.log('\n[C] DPI 无关性（CSS 像素输入，不双重缩放）');
{
    // 同一 CSS rect 在不同 devicePixelRatio 下应得到同一布局（canvas backing store 由渲染器自己处理）
    const a = L.chatBoxSize(420, {});
    const b = L.chatBoxSize(420, {});
    deepEq('纯函数无隐藏 DPR 状态：重复调用结果一致', a, b);
    ok('模块不读取 devicePixelRatio（宿主适配只算 CSS 像素）',
        !fs.readFileSync(LAYOUT, 'utf8').includes('devicePixelRatio'));
}

console.log('\n[D] ui-controller 接线（静态）');
{
    const src = fs.readFileSync(UI_CONTROLLER, 'utf8');
    ok('聊天框宽度用 chatBoxSize', src.includes('petbodyLayout.chatBoxSize'));
    ok('字幕宽度用 subtitleWidth', src.includes('petbodyLayout.subtitleWidth'));
    ok('气泡位置用 bubbleTarget', src.includes('petbodyLayout.bubbleTarget'));
    ok('不再写死 Math.round(winW * 0.92)', !src.includes('Math.round(winW * 0.92)'));
    ok('不再写死 winW >= 700 判断', !src.includes('winW >= 700'));
    ok('皮套锚点兜底存在（_getPetBodyCanvasRect）', src.includes('_getPetBodyCanvasRect'));
    ok('_getModelScreenPosition 皮套分支', /__petBodyActive[\s\S]{0,220}petbodyLayout\.petBodyAnchor/.test(src));
    ok('_getModelScreenBounds 皮套分支', /__petBodyActive[\s\S]{0,220}petbodyLayout\.petBodyBounds/.test(src));
}

console.log('\n================ 结果 ================');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
