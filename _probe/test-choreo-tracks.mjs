#!/usr/bin/env node
/**
 * _probe/test-choreo-tracks.mjs —— 编舞 v1 轨道采样与权重（2026-11-15 六十三轮）
 *
 * 编舞 = 把语义动作编译成「参数 × 时间」的轨道，按权重加法偏置写回渲染器。
 * 这个测试只验纯函数（不加载模型、不碰窗口）：
 *   · 采样的端点值正确、区间内单调缓动
 *   · 情绪别名能命中表演；中性/未知情绪返回 null（不乱动）
 *   · 权重 0→1→0（进出淡出），不会在结尾留残值
 */
'use strict';

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MOD = path.join(ROOT, 'pet-runtime', 'desktop', 'choreo-tracks.mjs');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

(async () => {
    const m = await import(pathToFileURL(MOD).href);

    // ① 单轨采样
    const keys = [{ t: 0, v: 0 }, { t: 1, v: 10 }, { t: 2, v: 0 }];
    ok('t=0 取首值', m.sampleTrack(keys, 0) === 0);
    ok('t=1 取中值', m.sampleTrack(keys, 1) === 10);
    ok('t=3 取末值', m.sampleTrack(keys, 3) === 0);
    ok('区间中点在两端之间', m.sampleTrack(keys, 0.5) > 0 && m.sampleTrack(keys, 0.5) < 10,
        String(m.sampleTrack(keys, 0.5)));
    ok('空轨道返回 0', m.sampleTrack([], 0.5) === 0);

    // ② 情绪 → 表演
    ok('happy 命中', !!m.performanceForEmotion('happy'));
    ok('中文「开心」命中', !!m.performanceForEmotion('开心'));
    ok('playful/smug 命中', !!m.performanceForEmotion('smug'));
    ok('惊讶表演存在', !!m.performanceForEmotion('surprised'));
    ok('生气表演存在', !!m.performanceForEmotion('愤怒'));
    ok('中性不编舞', m.performanceForEmotion('neutral') === null);
    ok('未知情绪不编舞', m.performanceForEmotion('xyz') === null);

    // ③ 整段采样：表演进行中至少写 2 个参数；结束点附近趋近 0
    const perf = m.PERFORMANCES.curious;
    const mid = m.samplePerformance(perf, perf.duration * 0.4);
    ok('中段有参数输出', Object.keys(mid).length >= 2, Object.keys(mid).join(','));
    const end = m.samplePerformance(perf, perf.duration);
    const endMax = Math.max(0, ...Object.values(end).map((v) => Math.abs(v)));
    ok('结尾参数回到 0 附近', endMax < 0.05, 'max=' + endMax);

    // ④ 权重：进/出都归零
    ok('t=0 权重 0', m.performanceWeight(0, 3) === 0);
    ok('中段权重 1', m.performanceWeight(1.5, 3) === 1);
    ok('结尾权重 0', m.performanceWeight(3, 3) <= 0.01);
    ok('超出时长权重 0', m.performanceWeight(3.2, 3) === 0);

    // ⑤ 四段表演的参数名必须是「本模型真实存在」的白名单
    //   （实测 509 参数里没有 ParamEyeLSmile / ParamEyeRSmile / ParamCheek —— 写了也是 0）
    const ALLOWED = new Set([
        'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
        'ParamEyeBallX', 'ParamEyeBallY',
        'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
        'ParamMouthForm', 'ParamBrowLY', 'ParamBrowLAngle', 'ParamBrowRAngle',
    ]);
    let bad = [];
    for (const [name, p] of Object.entries(m.PERFORMANCES)) {
        for (const tr of p.tracks) if (!ALLOWED.has(tr.param)) bad.push(name + ':' + tr.param);
    }
    ok('只用白名单参数（不碰物理输出/手指）', bad.length === 0, bad.join(',') || 'all ok');

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
