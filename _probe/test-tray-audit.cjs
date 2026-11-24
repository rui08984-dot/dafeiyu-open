#!/usr/bin/env node
/**
 * _probe/test-tray-audit.cjs —— 托盘菜单功能审计（2026-11-15 六十三轮）
 *
 * 用户实测：「静音（TTS）勾了还是有声音」，怀疑整排按钮都坏了。
 * 审计发现两个**真死开关**：
 *   ① 静音：写 tts.enabled=false + 运行时 ttsUnavailable=true，而处理线程一进冷却判断
 *      就把 ttsUnavailable 清掉（_ttsCooldownUntil||0 = 0）→ 照样出声；而且 enabled=false
 *      会让下次启动直接不初始化 TTS（取消静音还得重启）
 *   ② 静音表情：只写 config + 打印「重启生效」，渲染层根本没有 setEmotionGain 实现
 *
 * 这个测试是**源码级护栏**（托盘逻辑在 Electron 主进程，单测起不了）：
 * 每一项都必须有接线，且两条静音必须落到运行时开关上。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const read = (rel) => fs.readFileSync(path.join(LIVE, rel), 'utf8');
const main = read('main.js');

// ── ① 菜单项都在（用户截图里的那一排）────────────────────────────────────
{
    const labels = [
        '隐藏桌宠', '显示桌宠', '取消置顶', '保持置顶',
        '静音（TTS）', '鼠标穿透（点不穿她）', '取景：全身', '静音表情', '编舞（实验）',
        '打开设置…', '打开配置目录', '开机自启', '退出',
    ];
    for (const l of labels) ok('菜单项存在：' + l, main.includes(l), '');
}

// ── ② 静音（TTS）必须是运行时开关，不能再靠 ttsUnavailable ────────────────
{
    ok('isTtsMuted 读 tts.muted（兼容旧 enabled=false）',
        /function isTtsMuted[\s\S]{0,220}tts\.muted === true \|\| cfg\.tts\.enabled === false/.test(main));
    ok('setTtsMuted 写 tts.muted', /cfg\.tts\.muted = on/.test(main));
    ok('setTtsMuted 不再写 enabled = !on', !/cfg\.tts\.enabled = !on/.test(main));
    ok('setTtsMuted 把静音下发到渲染层', /global\.__ttsMuted=/.test(main));
    ok('启动时注入静音状态', /did-finish-load[\s\S]{0,400}__ttsMuted/.test(main));

    const tts = read('js/voice/tts-processor.js');
    ok('分段路径尊重 __ttsMuted', /if \(global\.__ttsMuted\) \{[\s\S]{0,120}appendFallbackText/.test(tts));
    ok('流式路径尊重 __ttsMuted', /llmFullResponse \+= text;[\s\S]{0,160}global\.__ttsMuted/.test(tts));
    ok('整段路径尊重 __ttsMuted', /async processTextToSpeech[\s\S]{0,200}global\.__ttsMuted/.test(tts));
    ok('静音不再靠 ttsUnavailable 复位逻辑', !/t\.ttsUnavailable = true/.test(main));
}

// ── ③ 静音表情必须实时下发 + 渲染层真的会跳过切脸 ─────────────────────────
{
    ok('托盘发送 emotion-gain', /type: 'emotion-gain', gain/.test(main));
    const drv = read('js/avatar/petbody/driver.js');
    ok('driver 把 gain 落到全局开关', /global\.__petEmotionGain = Number\.isFinite\(gain\)/.test(drv));
    const bridge = read('js/avatar/petbody/actions-bridge.js');
    ok('表情桥在 gain=0 时不切脸', /faceMuted[\s\S]{0,80}resolved\.expression && !faceMuted/.test(bridge));
    ok('静音表情仍记账（情绪状态不丢）', /onEmotion\(resolved\.key, 1\)/.test(bridge));
}

// ── ④ 取景 / 穿透 / 设置 / 自启 / 退出都有真实接线 ────────────────────────
{
    ok('取景发送 framing IPC', /type: 'framing', mode/.test(main));
    // 2026-11-23 穿透根治后的契约变更：托盘不再「裸调 setIgnoreMouseEvents(on)」——
    // 那会绕过主进程光标轮询的边界自愈，导致「开了就永久点不到她」（两次真机事故）。
    // 新契约 = ① 同步自愈策略 __ptState.manual ② 仍要落到窗口 ③ 写回配置。
    ok('穿透同步自愈策略（__ptState.manual）', /__ptState\.manual = on/.test(main));
    ok('穿透仍落到窗口（setIgnoreMouseEvents）', /petWinRef\.setIgnoreMouseEvents\((true|false|on)/.test(main));
    ok('穿透写回配置（重启保持）', /click_through_default = on/.test(main));
    ok('打开设置有实现', /function openControlCenter\(\)/.test(main));
    ok('打开配置目录用 shell.openPath', /shell\.openPath\(path\.dirname\(configPath\)\)/.test(main));
    ok('自启走注册表助手（electron 本体写不了注册表）',
        /function toggleAutostart\(\)[\s\S]{0,900}runAutostartHelper/.test(main)
        && /autostart\.cjs/.test(main));
    ok('退出会销毁托盘并 quit', /petTray && petTray\.destroy\(\)[\s\S]{0,80}app\.quit\(\)/.test(main));
    const drv = read('js/avatar/petbody/driver.js');
    ok('渲染层处理 framing', /msg\.type === "framing"[\s\S]{0,160}setFraming/.test(drv));
    // 皮套窗口必须关后台节流：被遮挡时 Chromium 会暂停 rAF（不眨眼/不呼吸/不换表情）
    ok('皮套窗口 backgroundThrottling=false', /backgroundThrottling: false/.test(main));
    // 编舞：托盘 → IPC → driver → 渲染层开关（三段都要在）
    ok('托盘发送 choreo IPC', /type: 'choreo', on/.test(main));
    ok('driver 处理 choreo 消息', /msg\.type === "choreo"[\s\S]{0,600}setChoreography/.test(drv));
    const entry = fs.readFileSync(path.join(ROOT, 'pet-runtime', 'desktop', 'petbody-entry.mjs'), 'utf8');
    ok('渲染层读 __petChoreoOn 并应用轨道', /__petChoreoOn === true/.test(entry) && /samplePerformance\(/.test(entry));
    ok('编舞在 model.update 之前叠加（否则画面不动）', /choreo: choreoFrame/.test(entry));
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
