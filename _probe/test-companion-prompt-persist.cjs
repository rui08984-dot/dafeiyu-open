#!/usr/bin/env node
/**
 * _probe/test-companion-prompt-persist.cjs —— 陪伴健康提示时间戳落盘（2026-11-24 第四轮 P2）
 *
 * 病根：`_save()` 有「一分钟最多写一次」的节流，而 `_lastPromptAt` 也在被节流的同一份
 * JSON 里。提示后 1 分钟内重启 → 时间戳没落盘 → 读回 0 → 两小时内又提示一次
 * （用户感受是「提示时有时无、一天被念两遍」）。
 *
 * 修法：提示那一刻 `_save(true)` 强制落盘（绕过一分钟节流），分钟数等其它字段保持节流。
 *
 * 断言：
 *   ① 节流窗口内（_lastSaveAt = 刚刚）提示 → 文件里立刻有 lastPromptAt；
 *   ② 同一文件重启 → 新实例读回 lastPromptAt（2 小时内不会重复提示）；
 *   ③ 反向约束：非强制 `_save()` 仍受一分钟节流（别把写盘放大成每轮一次）。
 *
 * 全程隔离：PET_DATA_ROOT + mkdtemp，不写真实 data、不启动宿主。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

// 必须在 require 业务模块之前设置（records-path 在 require 时解析 RECORDS_DIR）
const TMP = iso.setUpTempDataRoot('pet-companion-');
const APP = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const CompanionHealth = require(path.join(APP, 'plugins', 'community', 'companion-health', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function mkCtx() {
    return {
        getPluginFileConfig: () => ({ daily_threshold_min: 30, repeat_gap_min: 120 }),
        getConfig: () => ({}),
        log: () => {},
        addSystemPromptPatch: () => {},
        removeSystemPromptPatch: () => {},
    };
}

(async () => {
    const p = new CompanionHealth();
    p.context = mkCtx();
    await p.onInit();
    p._enabled = true;
    p._threshold = 30;
    p._minutes = 999;
    p._lastTickAt = Date.now() - 1000;
    p._lastPromptAt = 0;
    p._lastSaveAt = Date.now();          // 模拟「刚刚写过盘」：非强制写会被节流吞掉
    const file = p._file;
    ok('有可写的时长文件且已隔离（不写真实记录室）',
        !!file && iso.assertIsolated(file), String(file));

    await p.onUserInput();
    ok('提示后 lastPromptAt 已推进', p._lastPromptAt > 0, String(p._lastPromptAt));

    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { raw = null; }
    ok('一分钟节流窗口内依然立即落盘 lastPromptAt',
        !!raw && Number(raw.lastPromptAt) === Number(p._lastPromptAt),
        JSON.stringify(raw));

    // 模拟「提示后 1 分钟内重启」：同一文件、新实例
    const p2 = new CompanionHealth();
    p2.context = mkCtx();
    await p2.onInit();
    ok('重启后读回 lastPromptAt（两小时内不会重复提示）',
        Number(p2._lastPromptAt) === Number(p._lastPromptAt),
        'restart=' + p2._lastPromptAt + ' / prompt=' + p._lastPromptAt);

    // 反证：非强制 _save() 仍按 1 分钟节流（其它字段没被放大写）
    const minutesBefore = Math.round(Number(p2._minutes) || 0);
    p2._minutes = minutesBefore + 5;
    p2._lastSaveAt = Date.now();
    p2._save();
    let raw2 = null;
    try { raw2 = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { raw2 = null; }
    ok('普通 _save() 仍按分钟节流（minutes 没被写回）',
        !!raw2 && Math.round(Number(raw2.minutes) || 0) !== minutesBefore + 5,
        JSON.stringify(raw2));

    iso.cleanup(TMP);
    console.log('\n  陪伴健康时间戳：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('测试自身异常：', (e && e.stack) || e);
    try { iso.cleanup(TMP); } catch (e2) { /* ignore */ }
    process.exit(2);
});
