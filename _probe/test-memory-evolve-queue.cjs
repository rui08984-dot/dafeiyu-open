#!/usr/bin/env node
/**
 * _probe/test-memory-evolve-queue.cjs — 待写队列回归（2026-11-15 五十八轮）
 *
 * 修的是一处**真丢数据**：
 *   原实现 `_consolidate` 先 `_pending.splice(0)` 再从网络写库，`/add` 失败只 warn
 *   → 整批静默消失。而且 `_post` 超时 150s、还在 onLLMResponse 里 await
 *   → MemOS 挂起时能把回复后链路卡 150 秒（TTS 在它后面）。
 *
 * 断言（全部离线可跑，当前 8003 确实不在线）：
 *   ① MemOS 不在线 → 条目进队列文件，不丢；且**快速返回**（不撞 150s）
 *   ② MemOS 在线 → 队列补写成功并清空
 *   ③ onLLMResponse 不等巩固（慢巩固不影响回复链）
 *   ④ 去重阈值被夹到 ≤0.95（配置写 1 时语义不失效）
 *
 * 数据隔离（2026-11-21 A2）：写临时记录室（PET_DATA_ROOT + mkdtemp），
 * 不再备份-还原真实 记忆待写队列.jsonl。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const iso = require('./lib/test-isolation.cjs');

// 必须在 require 之前设置：插件/records-path 在模块加载时解析记录室路径。
const tmpRoot = iso.setUpTempDataRoot('pet-queue-');

const P = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'memory-evolve', 'index.js'));
const { recordFile } = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'records-path.js'));
// ⚠ 2026-11-24 ADR-014：MemOS 后端改成本地（llama.cpp:11435）后，_drainQueue 先过
// _writeGateOpen → localLLM.isAvailable()（本地 /health 探活）。单测不依赖真 server：
// 只桩探活本身；真正的 /add 仍由用例里的 p._post 假实现提供。
const localLLM = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'local-llm.js'));
const origIsAvailable = localLLM.isAvailable;
localLLM.isAvailable = async () => true;

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkCtx(messages) {
    return {
        logs: [],
        getPluginFileConfig: () => ({ enabled: true, gate_threshold: 0.6, dedupe_threshold: 1 }),
        getMessages: () => messages || [],
        log: (lv, m) => {},
    };
}

(async () => {
    const queueFile = recordFile('记忆待写队列.jsonl');
    ok('记录室已隔离到临时目录（不写真实数据）', iso.assertIsolated(queueFile), tmpRoot);
    try {
        const p = new P();
        p.context = mkCtx([]);
        await p.onInit();
        p._queueWrite([]);   // 从干净队列开始

        ok('去重阈值被夹到 ≤0.95（配置写 1 不再让判重失效）', p._dedupeEff <= 0.95 && p._dedupeEff > 0, 'eff=' + p._dedupeEff);

        // ① 离线：进队列 + 快速返回
        p._pending = [
            { text: '我下周去杭州出差', score: 2.5 },
            { text: '我家猫叫团子', score: 2.4 },
        ];
        p._memosAlive = false;
        p._queueCheckedAt = Date.now();
        const t0 = Date.now();
        await p._consolidate('测试-离线');
        const dt = Date.now() - t0;
        const q1 = p._queueLoad();
        ok('MemOS 离线时条目进队列（不丢）', q1.length === 2, '队列 ' + q1.length + ' 条：' + q1.map((x) => x.text.slice(0, 8)).join(' / '));
        ok('离线时快速返回（不撞 150s 超时）', dt < 1500, dt + 'ms');

        // ② 在线：补写并清空
        p._post = async () => ({ ok: true, added: 1 });
        p._memosAlive = true;
        p._queueCheckedAt = Date.now();
        const written = await p._drainQueue();
        ok('在线时队列补写成功', written === 2, 'written=' + written);
        ok('补写后队列清空', p._queueLoad().length === 0, '剩 ' + p._queueLoad().length + ' 条');

        // ③ onLLMResponse 不等巩固
        const p2 = new P();
        p2.context = mkCtx([{ role: 'user', content: '我下周三要去面试' }]);
        await p2.onInit();
        p2._maybeConsolidate = () => new Promise((r) => setTimeout(r, 600));
        const t1 = Date.now();
        await p2.onLLMResponse({});
        const dt2 = Date.now() - t1;
        ok('onLLMResponse 不等巩固（600ms 的巩固没进回复链）', dt2 < 150, dt2 + 'ms');
        await sleep(700);
    } finally {
        localLLM.isAvailable = origIsAvailable;
        // 临时记录室整目录删掉（不再写/还原真实文件）
        iso.cleanup(tmpRoot);
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
