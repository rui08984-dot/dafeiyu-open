#!/usr/bin/env node
/**
 * _probe/test-render-liveness.cjs — 渲染层存活判据单测（2026-11-15 五十八轮）
 *
 * 这块要防的是**静默冻死**（2026-11-14 00:19 真机冻了 3.5 小时没人发现）：
 * 窗口还在、主进程还在，但页面 JS 不跑了。判据错了两个方向都疼：
 *   · 太松 → 她死了没人管（就是这次的事故）
 *   · 太紧 → 正常省电/遮挡被当成死，反复 reload 打断她说话（用户最恨的抽搐）
 * 所以这里把「宽限期」「边界值」「垃圾输入」全部钉住。
 *
 * 判定：0 = 全过；非 0 = 有失败（check-all 认退出码）
 */
'use strict';

const { judgeRenderLiveness, LIVENESS_DEFAULTS } = require('../_incoming/my-neuro/live-2d/petbridge/render-liveness.js');

let pass = 0;
let fail = 0;
function eq(name, got, want) {
    if (got === want) { pass += 1; return; }
    fail += 1;
    console.error('  ✗ ' + name + ' —— got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}
function ok(name, cond, detail) {
    if (cond) { pass += 1; return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}

const NOW = 1_800_000_000_000;
const j = (o) => judgeRenderLiveness(Object.assign({ now: NOW }, o));

// ① 正常：连着且刚上报
eq('连着+新鲜 → ok', j({ innerClients: 1, lastInnerAt: NOW - 1000, lastHealthAt: NOW - 5000 }).state, 'ok');

// ② 刚断开：必须给宽限（渲染层 2s 自己重连，不能立刻判死）
eq('断开 5s → waiting', j({ innerClients: 0, lastInnerAt: NOW - 5000, lastHealthAt: NOW - 5000 }).state, 'waiting');
eq('断开 59.9s → waiting', j({ innerClients: 0, lastInnerAt: NOW - 59900 }).state, 'waiting');

// ③ 判死：超过宽限
eq('断开 60s（边界）→ offline', j({ innerClients: 0, lastInnerAt: NOW - 60000 }).state, 'offline');
eq('断开 90s → offline', j({ innerClients: 0, lastInnerAt: NOW - 90000 }).state, 'offline');
// 从未连上（launch 后页面根本没起来）也要判死，不能永远 waiting
eq('从未连上 → offline', j({ innerClients: 0, lastInnerAt: 0 }).state, 'offline');

// ④ 可疑但不算死：WS 在、health 陈旧（窗口被遮挡/最小化时属正常）
eq('连着+health 180s → stale', j({ innerClients: 1, lastInnerAt: NOW - 1000, lastHealthAt: NOW - 180000 }).state, 'stale');
eq('连着+从未上报 → stale', j({ innerClients: 1, lastInnerAt: NOW - 1000, lastHealthAt: 0 }).state, 'stale');
eq('连着+health 119s → ok', j({ innerClients: 1, lastInnerAt: NOW - 1000, lastHealthAt: NOW - 119000 }).state, 'ok');

// ⑤ 阈值可覆盖（测试和现场都要能调，但默认值只有一处）
eq('自定义 offlineMs=1000', judgeRenderLiveness({ now: NOW, innerClients: 0, lastInnerAt: NOW - 2000, offlineMs: 1000 }).state, 'offline');
eq('默认 offlineMs 是 60s', LIVENESS_DEFAULTS.offlineMs, 60000);
eq('默认 healthStaleMs 是 120s', LIVENESS_DEFAULTS.healthStaleMs, 120000);

// ⑥ 垃圾输入不许崩，也不许判成 ok（宁可判死让人看见，也不能静默放过）
eq('innerClients 负数 → offline', j({ innerClients: -1, lastInnerAt: NOW - 90000 }).state, 'offline');
eq('lastInnerAt 在未来（时钟漂移）→ waiting 不是 negative', j({ innerClients: 0, lastInnerAt: NOW + 60000 }).state, 'waiting');
ok('全部缺省 → offline', judgeRenderLiveness().state === 'offline');

// ⑦ detail 必须能人读（不是只给一个状态码 —— 日志里要能看出「为什么死」）
ok('offline 的 detail 带秒数', /60s|秒|s 没连上/.test(j({ innerClients: 0, lastInnerAt: NOW - 60000 }).detail), j({ innerClients: 0, lastInnerAt: NOW - 60000 }).detail);
ok('stale 的 detail 提到 render-health', /render-health/.test(j({ innerClients: 1, lastInnerAt: NOW - 1000, lastHealthAt: NOW - 180000 }).detail));

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
