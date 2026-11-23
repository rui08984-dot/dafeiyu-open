#!/usr/bin/env node
/**
 * _probe/test-overlay-geometry.cjs — 虚拟光标指示层的坐标换算单测
 *
 * 为什么单测这块：这段逻辑原来写在 main.js 里（Electron 主进程，起不来就没法测），
 * 而它踩过两个只有真机才暴露的坑：
 *   ① 只建主屏一个 overlay → 用户把游戏挪到第二屏，指示画到主屏同坐标上去了；
 *   ② 用「物理 / 主屏 scaleFactor」换算 → 混合 DPI 下第二屏整体偏到屏外。
 *
 * 本机实测（2026-11-14，独立 Electron 探针 screenToDipPoint）：
 *   主屏 2560×1440 @1x  → DIP bounds {0,0,2560,1440}
 *   副屏 1708×961  @1.5x → DIP bounds {2560,324,1708,961}，物理原点 (2560,-155)
 *   物理(2700,800) → DIP(2653.33,960.67)   —— 不是 2700/1.5，也不是 2700-2560
 * 所以几何函数的唯一可信输入是 Electron 的 screenToDipPoint。本测试用一个
 * **按实测数据写的假 screen** 注入，验证「选屏 + 换算 + 局部坐标」三件事。
 *
 * 判定：0 = 全过；非 0 = 有失败（check-all 认退出码）
 */
'use strict';

const { makeToDip, displayForDip, toLocal } = require('../_incoming/my-neuro/live-2d/js/core/overlay-layer.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}
function eq(name, got, want) {
    const a = JSON.stringify(got);
    const b = JSON.stringify(want);
    ok(name, a === b, 'got ' + a + ' want ' + b);
}

// ── 假 screen：按本机实测的两种屏 ──
const PRIMARY = { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 };
const SECOND = { id: 2, bounds: { x: 2560, y: 324, width: 1708, height: 961 }, scaleFactor: 1.5 };
// 副屏：物理原点 (2560,-155)，DIP 原点 (2560,324)
const fakeScreen = {
    getPrimaryDisplay: () => PRIMARY,
    getAllDisplays: () => [PRIMARY, SECOND],
    screenToDipPoint: ({ x, y }) => (
        x < 2560
            ? { x, y }
            : { x: 2560 + (x - 2560) / 1.5, y: 324 + (y + 155) / 1.5 }
    ),
};
const toDip = makeToDip(fakeScreen);

// ── 场景 1：单屏基线 ──
const solo = [{ id: 9, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }];
const idToDip = makeToDip({ getPrimaryDisplay: () => solo[0] });   // 没有 screenToDipPoint → 估算
eq('单屏 选屏', displayForDip({ x: 640, y: 360 }, solo).id, 9);
eq('单屏 局部坐标', toLocal(solo[0], {
    cursor: { x: 640, y: 360, label: '测试' },
    point: { x: 640, y: 360 },
    box: { x: 100, y: 200, w: 300, h: 40 },
}, idToDip), {
    box: { x: 100, y: 200, w: 300, h: 40 },
    point: { x: 640, y: 360 },
    cursor: { x: 640, y: 360, label: '测试' },
});

// ── 场景 2：本机双屏（主屏 1x / 副屏 1.5x）──
eq('双屏 主屏点选主屏', displayForDip(toDip({ x: 1500, y: 700 }), fakeScreen.getAllDisplays()).id, 1);
eq('双屏 副屏点选副屏', displayForDip(toDip({ x: 2700, y: 800 }), fakeScreen.getAllDisplays()).id, 2);
eq('双屏 主屏局部坐标', toLocal(PRIMARY, { cursor: { x: 1500, y: 700 } }, toDip).cursor, { x: 1500, y: 700, label: '' });
// 物理(2700,800) → DIP(2653.3,960.7) → 局部 (93.3,636.7) → 取整 (93,637)
eq('双屏 副屏局部坐标', toLocal(SECOND, { cursor: { x: 2700, y: 800 } }, toDip).cursor, { x: 93, y: 637, label: '' });

// 旧算法（物理 / 副屏 sf - 副屏 DIP 原点）会得到负数 = 画到屏外
const legacy = Math.round(2700 / 1.5 - SECOND.bounds.x);
ok('旧算法确实会画到屏外（这不是回归测试遗漏）', legacy < 0, 'legacy x = ' + legacy);

// 往返：局部 DIP + 窗口原点 = 屏幕 DIP ≈ screenToDipPoint(物理)
{
    const p = { x: 3000, y: 900 };
    const dip = toDip(p);
    const d = displayForDip(dip, fakeScreen.getAllDisplays());
    const loc = toLocal(d, { cursor: p }, toDip).cursor;
    const backDip = { x: loc.x + d.bounds.x, y: loc.y + d.bounds.y };
    ok('往返 局部+原点 ≈ 屏幕 DIP（≤1px 取整误差）',
        Math.abs(backDip.x - dip.x) <= 1 && Math.abs(backDip.y - dip.y) <= 1,
        JSON.stringify({ backDip, dip }));
}

// ── 场景 3：payload 只出现部分字段 → 只转部分字段（部分更新语义）──
const partial = toLocal(PRIMARY, { cursor: null }, toDip);
eq('只清光标不回传其它字段', Object.keys(partial), ['cursor']);
ok('清光标是 null', partial.cursor === null);

// ── 场景 4：坐标不在任何屏里 → 取最近的，不静默回主屏 ──
const far = displayForDip({ x: 99999, y: 99999 }, fakeScreen.getAllDisplays());
ok('屏外坐标兜底到某个真实屏', far && (far.id === 1 || far.id === 2), JSON.stringify(far));

// ── 场景 5：非 Windows / 老版本没有 screenToDipPoint → 估算不能抛 ──
{
    let threw = false;
    let q = null;
    try { q = makeToDip({ getPrimaryDisplay: () => PRIMARY })({ x: 300, y: 300 }); } catch (e) { threw = true; }
    ok('无 screenToDipPoint 不抛异常', !threw);
    eq('无 API 时按主屏 sf 估算', q, { x: 300, y: 300 });
}

console.log('  ' + (fail === 0 ? '✅' : '❌') + ' 虚拟光标坐标换算：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
