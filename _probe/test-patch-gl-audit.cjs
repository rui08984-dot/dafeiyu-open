#!/usr/bin/env node
/**
 * _probe/test-patch-gl-audit.cjs —— B7「patchGL」审计 + 可单测部分
 *
 * patchGL 在 pet-runtime/desktop/renderer/index.js（**禁改区**），本轮不改源码，
 * 只做静态审计 + 用假 WebGL 上下文执行「从源码里抽出来的真实函数」验证行为。
 *
 * 实际改动：只在 canvas 的 gl 上包 drawElements/drawArrays，统计
 *   state.drawCalls（累计）/ state.frameDrawCalls（每帧，tick 里渲染前清零）。
 * 恢复/幂等/失败路径：
 *   · glPatched 守卫 → 不会二次包装；
 *   · dispose() 把两个方法还原成原始 bound 函数；
 *   · patchGL 内部 try/catch，失败只 warn，不阻断渲染。
 *
 * 能单测（本文件）：包装后返回值不变、计数正确、幂等、空 gl 不抛。
 * 需要真实渲染器验证（留给人，不重启/不截图）：stats().drawCallsLastFrame 与
 * Chromium 合成器/DrawCall 实测一致；dispose 后无残留包装（可在 devtools 里比对
 * gl.drawElements 的函数身份）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'pet-runtime', 'desktop', 'renderer', 'index.js');

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

/** 从 startIndex 的 `{` 开始做括号配对（跳过字符串/模板/注释的简化版；本函数体不含复杂字面量）。 */
function extractFunction(source, name) {
    const start = source.indexOf('function ' + name + '(');
    if (start < 0) return null;
    const brace = source.indexOf('{', start);
    if (brace < 0) return null;
    let depth = 0;
    for (let i = brace; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    return null;
}

const source = fs.readFileSync(RENDERER, 'utf8');

console.log('\n[A] 静态审计：调用点 / 幂等 / 恢复 / 帧计数');
{
    ok('只有 collectStats 打开时才 patch', /if\s*\(\s*cfg\.collectStats\s*\)\s*patchGL\(app\)/.test(source));
    ok('collectStats 默认 true（验收依赖 drawCalls）', /collectStats:\s*true/.test(source));
    ok('patchGL 有 glPatched 幂等守卫', /if\s*\(!gl\s*\|\|\s*glPatched\)\s*return/.test(source));
    ok('dispose 里还原 drawElements', /gl\.drawElements\s*=\s*origDrawElements/.test(source));
    ok('dispose 里还原 drawArrays', /gl\.drawArrays\s*=\s*origDrawArrays/.test(source));
    ok('还原只在 glPatched && gl 时做', /if\s*\(glPatched\s*&&\s*gl\)/.test(source));
    ok('帧计数在 render 前清零', /state\.frameDrawCalls\s*=\s*0;[\s\S]{0,400}app\.render\(\)/.test(source));
    ok('patchGL 失败只 warn（不抛）', /could not patch GL for stats/.test(source));

    const fn = extractFunction(source, 'patchGL');
    ok('能抽出 patchGL 函数体', !!fn);
    ok('包装函数 return 原函数结果（drawElements）', /return origDrawElements\.apply\(null, arguments\)/.test(fn || ''));
    ok('包装函数 return 原函数结果（drawArrays）', /return origDrawArrays\.apply\(null, arguments\)/.test(fn || ''));
}

console.log('\n[B] 行为：用源码抽出的 patchGL + 假 WebGL');
{
    const fn = extractFunction(source, 'patchGL');
    // patchGL 依赖外层闭包：state / gl / glPatched / origDraw* / TAG / console。
    // 这里把同名变量注入，执行的是**生产源码原文**，不是复制品。
    const factory = new Function('state', 'console', 'TAG', `
        let gl = null;
        let glPatched = false;
        let origDrawElements = null;
        let origDrawArrays = null;
        ${fn}
        return {
            patchGL,
            snapshot: () => ({ gl, glPatched, origDrawElements, origDrawArrays }),
        };
    `);

    const state = { drawCalls: 0, frameDrawCalls: 0 };
    const silence = { warn: () => {} };
    const harness = factory(state, silence, '[test]');

    let elementCalls = 0;
    let arrayCalls = 0;
    const gl = {
        drawElements(...args) { elementCalls += 1; return 'E:' + args.length; },
        drawArrays(...args) { arrayCalls += 1; return 'A:' + args.length; },
    };
    const originalElements = gl.drawElements;
    const originalArrays = gl.drawArrays;

    harness.patchGL({ renderer: { gl } });
    let snap = harness.snapshot();
    eq('patch 后 glPatched=true', snap.glPatched, true);
    ok('gl 被记录', snap.gl === gl);
    ok('drawElements 已被替换', gl.drawElements !== originalElements);
    ok('drawArrays 已被替换', gl.drawArrays !== originalArrays);

    const retE = gl.drawElements(1, 2, 3);
    const retA = gl.drawArrays(4, 0, 6);
    eq('drawElements 返回值不变', retE, 'E:3');
    eq('drawArrays 返回值不变', retA, 'A:3');
    eq('累计 drawCalls=2', state.drawCalls, 2);
    eq('本帧 frameDrawCalls=2', state.frameDrawCalls, 2);

    state.frameDrawCalls = 0;   // 模拟 tick 每帧清零
    gl.drawArrays(4, 0, 6);
    eq('累计计数继续增长', state.drawCalls, 3);
    eq('新一帧只计本帧 1 次', state.frameDrawCalls, 1);

    // 幂等：重复 patch 不二次包装（否则一次调用会计两次）
    harness.patchGL({ renderer: { gl } });
    state.drawCalls = 0;
    state.frameDrawCalls = 0;
    gl.drawElements(1, 2, 3);
    eq('重复 patch 后一次调用只计 1 次', state.drawCalls, 1);
    eq('重复 patch 后本帧也只计 1 次', state.frameDrawCalls, 1);
    eq('原函数实际只被调 1 次', elementCalls, 2);   // 之前直接调用 1 次 + 这次 1 次

    // 失败路径：没有 gl 不抛，也不标记已 patch
    const harness2 = factory({ drawCalls: 0, frameDrawCalls: 0 }, silence, '[test]');
    let threw = false;
    try { harness2.patchGL({ renderer: {} }); } catch (_) { threw = true; }
    eq('无 gl：不抛错', threw, false);
    eq('无 gl：不标记 glPatched', harness2.snapshot().glPatched, false);

    // 还原语义（与 dispose 同款赋值）：还原后不再计数
    const snap2 = harness.snapshot();
    gl.drawElements = snap2.origDrawElements;
    gl.drawArrays = snap2.origDrawArrays;
    state.drawCalls = 0;
    gl.drawElements(1, 2, 3);
    gl.drawArrays(4, 0, 6);
    eq('还原后不再计数', state.drawCalls, 0);
    eq('还原后调用仍返回原值', gl.drawElements(1, 2, 3), 'E:3');
}

console.log('\n================ 结果 ================');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
