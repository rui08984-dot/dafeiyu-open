#!/usr/bin/env node
/**
 * _probe/test-dynamic-persona.cjs — 动态人格回归（2026-11-15 五十八轮）
 *
 * 原实现的真 bug（本地实测复现）：第 16 行「不更新就 return」→ 状态**只在更新那一轮**
 * 被注入（3 次请求：r1 有、r2 无、r3 有）。还有：不落盘、prompt 里叫她「肥牛」。
 *
 * 断言：
 *   ① 每轮都注入（有新鲜状态时）
 *   ② 过期状态不注入（6 小时以前的心情不能当此刻）
 *   ③ 状态落盘，新实例能读回
 *   ④ 更新是**后台**的：onLLMRequest 不等 LLM（否则每第 3 轮回复被拖慢一次）
 *   ⑤ 源码里不再有「肥牛」
 *
 * 数据隔离（2026-11-21 A2）：写临时记录室（PET_DATA_ROOT + mkdtemp），
 * 不再备份-还原真实 data/人格状态.json —— 宿主并发写同一文件会偶发 EPERM。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

// 必须在 require 插件/records-path **之前**设置：它们在模块加载时就解析记录室路径。
const tmpRoot = iso.setUpTempDataRoot('pet-persona-');

const P = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dynamic-persona', 'index.js'));
const { recordFile } = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'records-path.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ctx(opts) {
    const o = opts || {};
    const logs = [];
    return {
        logs,
        getPluginConfig: () => ({ update_frequency: o.freq || 3, stale_hours: o.staleHours || 6 }),
        callLLM: async () => { if (o.slow) await sleep(300); return o.reply === undefined ? '有点困但还在撑' : o.reply; },
        log: (lv, msg) => logs.push(lv + ':' + msg),
    };
}
const mkReq = () => ({ messages: [{ role: 'system', content: 'S' }, { role: 'user', content: '在干嘛' }] });

(async () => {
    const stateFile = recordFile('人格状态.json');
    ok('记录室已隔离到临时目录（不写真实数据）', iso.assertIsolated(stateFile), tmpRoot);
    try {
        // ① 每轮都注入（先塞一个新鲜状态，正是原实现漏掉的场景：第 2 轮就不注入了）
        const c1 = ctx({ freq: 3 });
        const p1 = new P();
        p1.context = c1;
        await p1.onInit();
        p1.persona = '测试用状态：有点犯困';
        p1.personaAt = Date.now();
        const reqs = [mkReq(), mkReq(), mkReq(), mkReq()];
        for (const r of reqs) { await p1.onLLMRequest(r); await sleep(40); }
        const injected = reqs.filter((r) => r.messages[0].content.includes('你现在的状态'));
        ok('4 轮里都注入了状态（原实现只有第 1、3 轮有）', injected.length === 4, injected.length + '/4');

        // ② 后台更新：慢 LLM 也不能拖住 onLLMRequest
        const c2 = ctx({ freq: 2, slow: true });
        const p2 = new P();
        p2.context = c2;
        await p2.onInit();
        p2.msgCount = 1;                      // 下一次就是第 2 轮 = 该更新
        const t0 = Date.now();
        await p2.onLLMRequest(mkReq());
        const dt = Date.now() - t0;
        ok('onLLMRequest 不等 LLM（慢 300ms 的调用没进主链）', dt < 150, dt + 'ms');
        await sleep(400);

        // ③ 落盘 + 新实例读回
        const p3 = new P();
        p3.context = ctx({});
        await p3.onInit();
        ok('状态已落盘且新实例能读回', !!p3.persona && p3.personaAt > 0, 'persona=「' + p3.persona + '」');

        // ④ 过期状态不注入
        const p4 = new P();
        p4.context = ctx({ staleHours: 6 });
        await p4.onInit();
        p4.persona = '很久以前的旧心情';
        p4.personaAt = Date.now() - 7 * 3600000;
        const r4 = mkReq();
        await p4.onLLMRequest(r4);
        ok('过期（7h 前）的状态不注入', !r4.messages[0].content.includes('很久以前的旧心情'), r4.messages[0].content.slice(0, 40));

        // ⑤ 空结果不覆盖旧状态
        const c5 = ctx({ freq: 1, reply: '   ' });
        const p5 = new P();
        p5.context = c5;
        await p5.onInit();
        p5.persona = '旧的状态还在';
        p5.personaAt = Date.now();
        await p5.onLLMRequest(mkReq());
        await sleep(60);
        ok('LLM 返回空时保留旧状态（不写空）', p5.persona === '旧的状态还在', 'persona=「' + p5.persona + '」');

        // ⑥ prompt 里的人名是「大肥鱼」（注释里提到旧名字不算，只看发给模型的文案）
        const src = fs.readFileSync(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dynamic-persona', 'index.js'), 'utf8');
        ok('prompt 里用「大肥鱼」而不是旧名', /描述大肥鱼此刻/.test(src) && !/描述肥牛此刻/.test(src));
    } finally {
        // 临时记录室整目录删掉（测试不再还原真实文件，因为根本没写过真实文件）
        iso.cleanup(tmpRoot);
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
