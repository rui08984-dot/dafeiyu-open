#!/usr/bin/env node
/**
 * _probe/test-audio-device-follow.cjs —— 「一起看」跟随默认输出设备（2026-11-23）
 *
 * 背景：WASAPI loopback 录的是**渲染端点的混音**，耳机只要是默认播放设备一样能录。
 * 但旧实现只在服务启动时取一次 `default_speaker()`，用户从扬声器切到耳机/蓝牙后
 * 不会跟随 —— 要么继续录旧设备（无声），要么直到重启服务。
 *
 * 本探针只做**静态接线断言**（不启采集、不碰声卡）：确认轮询存在、切换会重开、
 * /health 可观测。真实切设备需要人工验一次。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'audio-loop', 'audio_loop_server.py');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}

ok('有设备切换计数 device_changes', /self\.device_changes\s*=\s*0/.test(src) && /device_changes\s*\+=\s*1/.test(src));
ok('默认设备每 ≤5 秒复查一次', /_now\s*-\s*_last_dev_check\s*>=\s*5/.test(src) && /sc\.default_speaker\(\)/.test(src));
ok('设备名变化时退出当前 recorder（外层 while 会重开新设备）', /输出设备已切换/.test(src) && /break/.test(src));
ok('/health 暴露 device 与 device_changes',
    /"device":\s*service\.device_name/.test(src) && /"device_changes":\s*service\.device_changes/.test(src));

// 逻辑模拟：同一段「比较→切换→重开」的语义（防止以后把轮询放到 recorder 外面导致切了也不重开）
{
    const inRecorder = src.indexOf('.recorder(');
    const poll = src.indexOf('_last_dev_check >= 5');
    const reopenBreak = src.indexOf('输出设备已切换');
    ok('轮询在 recorder 的采集循环内部（切设备不靠异常）', inRecorder > 0 && poll > inRecorder && reopenBreak > poll);
}

// 原理说明断言：注释里必须保留「loopback 录渲染端点、耳机可录」的口径，防止将来被改成扬声器专属
ok('口径写明「回环录渲染端点、耳机只要是默认设备也能录」',
    /渲染端点/.test(src) && /耳机只要是默认/.test(src));

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
