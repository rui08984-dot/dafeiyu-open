#!/usr/bin/env node
/**
 * _probe/test-geometry.cjs —— E5 纯函数单测：屏幕/窗口几何（geometry）
 *
 * 守的边界：
 *   ① 纯函数层（js/core/geometry.js）不读文件、不 require fs/electron —— 可独立测；
 *   ② normalizeRect / rectContains / pointOnAnyScreen / toDip / clampPoint 的边界语义；
 *   ③ game-control 的历史行为不变：多显示器并集、DIP×scaleFactor、负坐标副屏、
 *      缺失 bounds 跳过、tol 默认 1（不是 0）。
 *
 * 全程不 spawn、不碰桌面。判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core');
const GC = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch', 'game-control.js');

const GEO = require(path.join(CORE, 'geometry.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}
function eq(name, got, want) {
    return ok(name, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

console.log('== ① 纯函数层自证 ==');
{
    const src = fs.readFileSync(path.join(CORE, 'geometry.js'), 'utf8');
    ok('geometry.js 不 require fs/path/electron/child_process',
        !/require\(['"](fs|path|electron|child_process)['"]\)/.test(src));
    ok('geometry.js 没有 IO 调用',
        !/\b(readFile|writeFile|appendFile|spawn|execFile)\b/.test(src));
}

console.log('\n== ② normalizeRect ==');
eq('对象 {x,y,w,h} 原样', GEO.normalizeRect({ x: 10, y: 20, w: 300, h: 200 }), { x: 10, y: 20, w: 300, h: 200 });
eq('对象 {width,height} 兼容 Electron bounds',
    GEO.normalizeRect({ x: 5, y: 6, width: 1280, height: 720 }), { x: 5, y: 6, w: 1280, h: 720 });
eq('四个参数形式', GEO.normalizeRect(1, 2, 3, 4), { x: 1, y: 2, w: 3, h: 4 });
eq('负宽：原点左移、宽取正', GEO.normalizeRect({ x: 100, y: 50, w: -40, h: 30 }), { x: 60, y: 50, w: 40, h: 30 });
eq('负高：原点上移、高取正', GEO.normalizeRect({ x: 100, y: 50, w: 40, h: -30 }), { x: 100, y: 20, w: 40, h: 30 });
eq('负宽+负高同时', GEO.normalizeRect({ x: 100, y: 50, w: -40, h: -30 }), { x: 60, y: 20, w: 40, h: 30 });
eq('零宽高保持', GEO.normalizeRect({ x: 7, y: 8, w: 0, h: 0 }), { x: 7, y: 8, w: 0, h: 0 });
ok('NaN 原样保留（不偷偷改 0）', Number.isNaN(GEO.normalizeRect({ x: 'a', y: 0, w: 1, h: 1 }).x));
{
    const nul = GEO.normalizeRect(null);
    ok('null 矩形 → Number(null)=0 + 其余 NaN（不崩）',
        nul.x === 0 && Number.isNaN(nul.y) && Number.isNaN(nul.w) && Number.isNaN(nul.h),
        JSON.stringify(nul));
}

console.log('\n== ③ rectContains（闭区间 + tol）==');
const R = { x: 100, y: 100, w: 200, h: 100 };
ok('内部点', GEO.rectContains(R, 150, 150) === true);
ok('左上角算在内', GEO.rectContains(R, 100, 100) === true);
ok('右下角算在内（闭区间）', GEO.rectContains(R, 300, 200) === true);
ok('右边界外 1px', GEO.rectContains(R, 301, 150) === false);
ok('上边界外 1px', GEO.rectContains(R, 150, 99) === false);
ok('tol=1 吸收右边界外 1px', GEO.rectContains(R, 301, 150, 1) === true);
ok('tol=1 吸收左边界外 1px', GEO.rectContains(R, 99, 150, 1) === true);
ok('tol=0 不吸收', GEO.rectContains(R, 99, 150, 0) === false);
ok('负 tol 视作 0', GEO.rectContains(R, 99, 150, -5) === false);
ok('null 矩形返回 false', GEO.rectContains(null, 1, 1) === false);
ok('NaN 点返回 false', GEO.rectContains(R, NaN, 1) === false);

console.log('\n== ④ pointOnAnyScreen（多屏并集，含负坐标）==');
const RECTS = [
    { x: 0, y: 0, w: 1920, h: 1080, dpi: 1 },
    { x: 1920, y: 0, w: 1920, h: 1080, dpi: 1 },
    { x: -1920, y: 0, w: 1920, h: 1080, dpi: 1 },
];
ok('主屏 (500,500) 命中', !!GEO.pointOnAnyScreen(500, 500, RECTS));
ok('主屏命中返回原矩形引用', GEO.pointOnAnyScreen(500, 500, RECTS) === RECTS[0]);
ok('右副屏 (2500,500) 命中', !!GEO.pointOnAnyScreen(2500, 500, RECTS));
ok('左副屏 (-100,300) 命中', !!GEO.pointOnAnyScreen(-100, 300, RECTS));
ok('主屏外 (5000,5000) 不命中', GEO.pointOnAnyScreen(5000, 5000, RECTS) === null);
ok('更远负坐标 (-5000,5000) 不命中', GEO.pointOnAnyScreen(-5000, 5000, RECTS) === null);
ok('tol 默认 1：右边界外 0.5px 命中', !!GEO.pointOnAnyScreen(1920.5, 10, [{ x: 0, y: 0, w: 1920, h: 1080 }]));
ok('tol 显式 0：右边界外 0.5px 不命中', GEO.pointOnAnyScreen(1920.5, 10, [{ x: 0, y: 0, w: 1920, h: 1080 }], 0) === null);
ok('空数组安全', GEO.pointOnAnyScreen(0, 0, []) === null);
ok('非数组安全', GEO.pointOnAnyScreen(0, 0, null) === null);

console.log('\n== ⑤ toDip / toPhysical / scaleOf ==');
eq('150%：2550 物理 → 1700 DIP', GEO.toDip(2550, 1.5), 1700);
eq('100%：1920 → 1920', GEO.toDip(1920, 1), 1920);
eq('scaleFactor 缺失 → 1', GEO.toDip(100, undefined), 100);
eq('scaleFactor=0 → 1（不除零）', GEO.toDip(100, 0), 100);
eq('scaleFactor=-2 → 1', GEO.toDip(100, -2), 100);
eq('toPhysical 1280@1.5 → 1920', GEO.toPhysical(1280, 1.5), 1920);
ok('toDip/toPhysical 互逆', Math.abs(GEO.toPhysical(GEO.toDip(2550, 1.5), 1.5) - 2550) < 1e-9);
eq('scaleOf(1.5)=1.5', GEO.scaleOf(1.5), 1.5);
eq('scaleOf(NaN)=1', GEO.scaleOf(NaN), 1);

console.log('\n== ⑥ clampPoint ==');
eq('内部点不动', GEO.clampPoint(150, 150, R), { x: 150, y: 150 });
eq('左上越界夹到左上角', GEO.clampPoint(0, 0, R), { x: 100, y: 100 });
eq('右下越界夹到右下角', GEO.clampPoint(999, 999, R), { x: 300, y: 200 });
eq('只越 x', GEO.clampPoint(50, 150, R), { x: 100, y: 150 });
eq('只越 y', GEO.clampPoint(150, 999, R), { x: 150, y: 200 });
eq('负坐标矩形', GEO.clampPoint(0, 0, { x: -1920, y: 0, w: 1920, h: 1080 }), { x: 0, y: 0 });
eq('null 矩形原样返回', GEO.clampPoint(12, 34, null), { x: 12, y: 34 });
ok('NaN 点 → NaN（显式坏数据）', Number.isNaN(GEO.clampPoint(NaN, 1, R).x));

console.log('\n== ⑦ game-control 包装行为不变 ==');
{
    let g = null;
    let loadErr = null;
    try { g = require(GC); } catch (e) { loadErr = e; }
    ok('game-control.js 可加载（不 spawn）', !!g, loadErr ? String(loadErr.message || loadErr) : 'ok');
    if (g) {
        const MOCK = [
            { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
            { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
            { id: 3, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
        ];
        eq('三块屏 → 三个物理矩形', g.screenRectsFromDisplays(MOCK), [
            { x: 0, y: 0, w: 1920, h: 1080, dpi: 1 },
            { x: 1920, y: 0, w: 1920, h: 1080, dpi: 1 },
            { x: -1920, y: 0, w: 1920, h: 1080, dpi: 1 },
        ]);
        eq('1280×720@1.5 → 1920×1080', g.screenRectsFromDisplays([{ bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 }]),
            [{ x: 0, y: 0, w: 1920, h: 1080, dpi: 1.5 }]);
        eq('缺失 bounds 的显示器被跳过', g.screenRectsFromDisplays([{ id: 9 }, { bounds: null }, MOCK[0]]),
            [{ x: 0, y: 0, w: 1920, h: 1080, dpi: 1 }]);
        eq('零/负宽高被跳过', g.screenRectsFromDisplays([
            { bounds: { x: 0, y: 0, width: 0, height: 100 }, scaleFactor: 1 },
            { bounds: { x: 0, y: 0, width: -5, height: 100 }, scaleFactor: 1 },
            { bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1 },
        ]), [{ x: 0, y: 0, w: 100, h: 100, dpi: 1 }]);
        eq('GC.screenRectsFromDisplays ≡ 纯函数组合', g.screenRectsFromDisplays(MOCK),
            MOCK.map((d) => {
                const n = GEO.normalizeRect(d.bounds);
                return { x: Math.round(GEO.toPhysical(n.x, d.scaleFactor)), y: Math.round(GEO.toPhysical(n.y, d.scaleFactor)),
                    w: Math.round(GEO.toPhysical(n.w, d.scaleFactor)), h: Math.round(GEO.toPhysical(n.h, d.scaleFactor)), dpi: d.scaleFactor };
            }));
        ok('GC.pointOnAnyScreen 右副屏', !!g.pointOnAnyScreen(2500, 500, g.screenRectsFromDisplays(MOCK)));
        ok('GC.pointOnAnyScreen 左副屏', !!g.pointOnAnyScreen(-100, 300, g.screenRectsFromDisplays(MOCK)));
        ok('GC.pointOnAnyScreen 屏外仍拒', g.pointOnAnyScreen(5000, 5000, g.screenRectsFromDisplays(MOCK)) === null);
        // tol 默认值必须与历史一致（1）
        ok('GC.pointOnAnyScreen tol 默认 1', !!g.pointOnAnyScreen(1920.5, 10, [{ x: 0, y: 0, w: 1920, h: 1080 }]));
        ok('GC.pointOnAnyScreen tol=0 生效', g.pointOnAnyScreen(1920.5, 10, [{ x: 0, y: 0, w: 1920, h: 1080 }], 0) === null);
    }
    ok('geometry 模块可独立 require（不依赖 game-control）', typeof GEO.normalizeRect === 'function');
}

console.log('\n' + (fail === 0 ? '✅ geometry：' : '❌ geometry：') + 'PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
