// speech-coordinator 单测：node speech-coordinator.test.js（纯逻辑，零依赖）
const { SpeechCoordinator } = require('../../_incoming/my-neuro/live-2d/js/core/speech-coordinator.js');

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fails++; } };

function mk(busy = false, quiet = false) {
    return new SpeechCoordinator({
        isBusy: () => busy,
        isQuiet: () => quiet,
        minGapMs: 20000,
    });
}

// 1. 静默闸门：什么优先级都拒
{
    const c = mk(false, true);
    const g = c.request('watch-screen', { priority: 'critical' });
    ok(!g.allowed && /静默/.test(g.reason), '静默全拒');
}
// 2. 忙碌：高优先让路（等待），低优先直接拒
{
    const c = mk(true, false);
    const hi = c.request('dispatch-care', { priority: 'critical' });
    ok(!hi.allowed && hi.waitMs > 0, '忙碌时高优先等待');
    const lo = c.request('watch-screen', { priority: 'proactive' });
    ok(!lo.allowed && /忙碌/.test(lo.reason), '忙碌时低优先拒绝');
}
// 3. 冷却：刚说完 5s 内，下一个自主请求拒；优先级 critical 间隔放宽
{
    const c = mk(false, false);
    c.request('watch-screen', { priority: 'proactive' });
    c.markSpoken('watch-screen');
    const g1 = c.request('live-dock', { priority: 'danmaku' });
    ok(!g1.allowed, '刚说完 5s 内拒绝');
    const g2 = c.request('care', { priority: 'critical' });
    ok(g2.allowed, 'critical 间隔放宽放行');
}
// 4. 间隔过后放行
{
    const c = mk(false, false);
    c._lastSpokenAt = Date.now() - 60000;   // 模拟 60s 前说过
    const g = c.request('watch-screen', { priority: 'proactive' });
    ok(g.allowed, '间隔 60s 后放行');
}
// 5. markUser 重置间隔
{
    const c = mk(false, false);
    c.markSpoken('dawn-dusk');
    c.markUser();
    const g = c.request('live-dock', { priority: 'danmaku' });
    ok(g.allowed, '用户说话后间隔重置');
}
// 6. 统计计数
{
    const c = mk(false, false);
    c.request('a1', { priority: 'proactive' }); c.markSpoken('a1');
    c.request('a2', { priority: 'danmaku' });   // 拒
    const s = c.stats().perPlugin;
    ok(s.a1 && s.a1.allowed === 1, 'a1 计数');
    ok(s.a2 && s.a2.denied === 1, 'a2 拒绝计数');
}

if (fails) { console.error(`speech-coordinator: ${fails} 项失败`); process.exit(1); }
console.log('speech-coordinator: 全部通过（6 组）');
