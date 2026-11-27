// game-control.js —— 她的手：毫秒级游戏/桌面直控（不走 DSH 会话，直发系统输入）。
//
// 动作：press_key（点按/组合键）/ hold_key（按住 N 秒，走位用）/ click_at（屏幕坐标点击）/
//       type_text（输入文字）/ focus_window（按标题或 pid 聚焦）/ volume（音量加减/静音）/
//       list_windows（枚举可见窗口，只读）。
// 实现：pwsh WScript.Shell SendKeys + user32 P/Invoke（keybd_event/SetCursorPos/mouse_event），
//       不引任何 npm 依赖。每次调用一个 pwsh 进程（~200-400ms），对「按一下 W」够用。
//
// 安全护栏（她有手了，必须管住）：
//   · 危险组合黑名单（alt+f4 / ctrl+alt+del / alt+tab 洗屏）直接拒绝；
//   · 冷却 300ms + 每分钟 ≤20 次（防按键连发把自己/系统搞炸）；
//   · 每次动作都打日志（审计），参数全部经 String()/Number() 清洗。
'use strict';
const __silentAudit = require('../../../js/core/silent-audit.js');
const { spawn } = require('child_process');
const path = require('path');   // SoM 标注脚本路径（som_snapshot）
// 解释器统一解析：pet-runtime 各脚本原来各自硬编码本机 Python313 绝对路径，换机器即失效。
const { resolvePython } = require('../../../js/core/runtime-paths.js');
// ⚠ 2026-11-10 审计抓到：pvz_state 分支用了裸 `fs.existsSync/fs.readFileSync`，
//   但全文件没有这个绑定 —— Electron 28（Node 18）没有全局 fs，调用必抛
//   `fs is not defined`，整个 pvz_state 能力 100% 不可用。
//   注意：用 Node 24 直接跑测试**不会复现**（Node 24 加了全局 fs），所以以 Electron 的 Node 18 为准。
const fs = require('fs');
// 统一结果契约（2026-11-09 三十五轮）：所有动作都往同一个形状里填，
// 根因是「把工具调用的成功当成任务的完成」，契约强制每个动作带上可观测后果。
const VC = require('./verify-contract.js');
// P0-3（2026-11-25）：点击/聚焦的验证通道收口。纯判定 + 注入依赖，便于纯 Node 单测。
// 审计根因：「动作通道」和「验证通道」不是同一块屏幕（UIA Invoke 不需要前台，
// 但旧实现拿屏幕像素采整窗矩形 → 遮挡/副屏/屏外时假成功或假 noop）。
const CV = require('./control-verify.js');
// D2 经验路由（2026-11-22）：只回答「同样这几条候选通道先试哪条」，
// 不执行 UIA/OCR/坐标、不改任何动作的成败判定与校验逻辑。
const routeExperience = require('../../../js/core/route-experience.js');
// E5 最小切口（2026-11-22）：按键策略与屏幕几何的纯函数层。
// 只搬计算，不搬 IO/配置：策略表加载仍在本文件（读 key-policy.json），
// 拒绝文案仍由本文件持有并传入 —— 返回值/文案/vetoCode 一律不变。
const keyPolicy = require('../../../js/core/key-policy.js');
const geometry = require('../../../js/core/geometry.js');

// ── 桌面动作串行锁（2026-11-10 红队 S4）─────────────────────────────────────
// 病根：UIA_SNAPSHOT_STATE / SOM_STATE / PVZ_STATE / stateGame 都是**模块级单例**，
//   而 som_snapshot 能跑 90s。LLM 一次发两个 tool call（A: som_snapshot 窗口X，
//   B: som_click #3）→ B 读到的可能是 A 正在改写中的 marks，点到另一个窗口的同号坐标。
// 修法：所有「会改 STATE / 会发真实输入」的动作排队串行，只读动作（list_windows /
//   knowledge / recent_actions / edit_text）**不排队**——否则长任务会把查询堵死。
// 递归安全：batch/pvz auto/semantic 内部会再调 runGameAction；用 AsyncLocalStorage
//   标记「已在锁内」，内部调用直接执行，不会自己等自己（死锁）。
const { AsyncLocalStorage } = require('async_hooks');
const _deskLockCtx = new AsyncLocalStorage();
let _deskChain = Promise.resolve();
function withDesktopLock(fn) {
    if (_deskLockCtx.getStore()) return Promise.resolve().then(fn);   // 已在锁内：内部递归直接跑
    const exec = () => _deskLockCtx.run(true, fn);
    const run = _deskChain.then(exec, exec);
    _deskChain = run.then(() => {}, () => {});   // 失败也不断链
    return run;
}
// 会改 STATE / 发真实输入的动作（只读动作刻意不在表里）
const DESK_SERIAL_ACTIONS = new Set([
    'snapshot', 'som_snapshot', 'som_click', 'click_element', 'focus_window',
    'press_key', 'hold_key', 'click_at', 'click_text', 'visual_click',
    'type_text', 'mouse', 'volume', 'pvz', 'mc', 'batch', 'semantic',
    // 2026-11-14 五十三轮（审计）：新补的原语没进串行锁 —— 两个动作并发时
    // 「按下/抬起」会交错（拖拽中途插一个点击 = 拖到一半松手）。
    'scroll', 'drag', 'paste', 'set_value', 'select_text', 'perform_action',
]);
function needsDesktopLock(action, arg) {
    const act = String(action || '').trim();
    // skill：只有 run 会动桌面；list/save/forget 是纯本地 JSON 查询，别堵
    if (act === 'skill') return String(arg || '').trim().split(/\s+/)[0].toLowerCase() === 'run';
    return DESK_SERIAL_ACTIONS.has(act);
}

// STATE 世代号（同日红队 S4 第二道）：任何快照都会 ++。
// som_click 时若 SOM_STATE.seq 落后 → 说明中间又拍过别的窗口，编号坐标已不可信。
let _stateSeq = 0;

// 快照身份号（2026-11-24 根因修）：进程内单调递增，每次写 UIA_SNAPSHOT_STATE / SOM_STATE 都 +1。
// 病根：#编号属于**某一次**快照，而 UIA_SNAPSHOT_STATE 是模块级单例 —— see 与 click 之间
// 只要有别的东西（门禁并发 / watch-screen / 另一回合 / 后台任务）又拍了一次快照，
// 编号就指向另一份快照（很可能是另一个窗口），且点击会「静默成功」。
// sid 让回执能说清「你点的是第几代快照」，配合窗口身份 + 年龄做 fail-closed 校验。
let _snapshotSid = 0;
const SNAPSHOT_MAX_AGE_MS = 120000;   // 快照超过 2 分钟就拒绝按旧编号点（界面早变了）
// som_click 的放宽上限（2026-11-24 第四轮 P2）：SoM 标注带**真实 hwnd** 时，长任务里
// 「两分钟必须重拍一次」是纯误伤（窗口没换、编号仍有效）。同一 hwnd 放宽到 5 分钟；
// 「窗口还活着」由点击前已有的 assertTargetFocused(strict) 兜底 —— 那个断言失败就一次
// 点击都不发（fail-closed），所以这里只按「有没有可核对的 hwnd」决定 TTL。
const SOM_STICKY_MAX_AGE_MS = 300000;

// 只计数、不判冷却的「预扣配额」（红队 R6）。
// batch / skill run 的内层原来完全绕过限速：外层闸扣 1 次，里面最多 20 次真实输入。
function preChargeTokens(n, game) {
    const cnt = Number(n) || 0;
    if (cnt <= 0) return null;
    const bucket = game ? stateGame : state;
    const cap = game ? 600 : 20;
    const now = Date.now();
    bucket.window = bucket.window.filter((t) => now - t < 60000);
    const room = cap - bucket.window.length;
    if (cnt > room) {
        return '一分钟配额不够：这批要 ' + cnt + ' 次，' + (game ? '游戏闸' : '严格闸') +
            '只剩 ' + Math.max(0, room) + ' 次（上限 ' + cap + '/分）——拆小或等几十秒再试';
    }
    for (let i = 0; i < cnt; i += 1) bucket.window.push(now);
    bucket.lastAt = now;
    return null;
}
// 和 index.js 的 GAME_ACTIONS 同档（600/分）；其余写动作走严格闸（20/分）
const GAME_GATE_ACTIONS = new Set(['semantic', 'press_key', 'hold_key', 'click_at', 'pvz', 'visual_click']);
const BATCH_READONLY_STEPS = new Set(['list_windows', 'snapshot', 'som_snapshot', 'visual_read', 'pvz_state', 'wgc_hash']);
// ⚠ 2026-11-14 五十三轮（审计）：`wgc_shot` 从只读表里移出来了 —— 它要**落盘**一张图，
//   旧红队正是把「batch 里塞 N 个 wgc_shot」当成绕过落盘配额的路子。现在它算写动作。
// batch 钉住窗口后，这些步骤的 focus 直接传 hwnd（输入落点明确）；
// snapshot/som_snapshot 的 focus 是「按标题找窗口」，只能传标题。
const PIN_AS_HWND = new Set([
    'press_key', 'hold_key', 'click_at', 'click_text', 'visual_click',
    'type_text', 'mouse', 'volume', 'focus_window', 'semantic', 'click_element', 'som_click',
]);

// ── 输入安全策略：唯一策略表（2026-11-21 审计 P2）──────────────────────────
// 病根：三套黑名单各挡各的 —— JS BLOCKLIST 只挡 alt+f4/ctrl+alt+del/alt+tab；
//   Rust parse_keys **什么都不挡**；pwsh send-input.ps1 挡 6 类。
//   同一句 `press_key ctrl+shift+esc` 走 JS 前置会被拒、走 Rust 会真的把任务管理器调起来
//   （游戏 profile / 其他模块直连 pet-core 时就是这条路）。
// 修法（2026-11-21 收敛）：唯一策略源 = pet-runtime/tools/key-policy.json，
//   JS 与 pwsh（send-input.ps1）都读这份文件；Rust（pet-core/src/native.rs）仍内联，
//   由测试 _probe/test-control-consistency.cjs 把 JSON/JS/Rust/PS 四份做集合相等比较。
//   下面的内联表只在 JSON 缺失时兜底（测试会同时比对两者，漂移即红）。
// 语义：require = 必须同时出现的规范化键；any = 任一触发键（空数组 = require 命中即拒）。
// 键名归一：control→ctrl / escape→esc / delete→del / lctrl|lalt|lshift|lwin 等→基础名。
// #region key-policy-table
const KEY_POLICY_FALLBACK = [
    { require: ['alt'], any: ['f4', 'tab', 'space'] },
    { require: ['ctrl', 'alt'], any: ['del', 'delete'] },
    { require: ['ctrl'], any: ['esc', 'escape'] },
    { require: ['win'], any: [] },
];
const KEY_POLICY_DENY_MSG = '该组合被安全策略拒绝（固定策略：alt+f4 / alt+tab / alt+space / ctrl+alt+del / ctrl+esc / ctrl+shift+esc / win+任意键 不允许注入）';
/** 读唯一策略源；不可用返回 null（调用方回落内联表）。 */
function loadKeyPolicyFile() {
    try {
        const root = findProjectRoot(path.resolve(__dirname, '..', '..', '..', '..'));
        const file = path.join(root, 'pet-runtime', 'tools', 'key-policy.json');
        const o = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!o || !Array.isArray(o.rules) || !o.rules.length) return null;
        const rules = o.rules.map((r) => ({
            require: Array.isArray(r && r.require) ? r.require.map((x) => String(x).toLowerCase()) : [],
            any: Array.isArray(r && r.any) ? r.any.map((x) => String(x).toLowerCase()) : [],
        })).filter((r) => r.require.length > 0);
        if (!rules.length) return null;
        return { rules, aliases: (o.aliases && typeof o.aliases === 'object') ? o.aliases : null, file };
    } catch (e) { return null; }
}
const _KEY_POLICY = loadKeyPolicyFile();
const KEY_POLICY_RULES = _KEY_POLICY ? _KEY_POLICY.rules : KEY_POLICY_FALLBACK;
const KEY_POLICY_SOURCE = _KEY_POLICY ? _KEY_POLICY.file : 'inline-fallback';
// #endregion key-policy-table
// 键名归一 / 策略判定：实现已搬到 js/core/key-policy.js（E5 纯函数切口）。
// 下面三个包装保持**原签名与原返回值**，调用点一个字不用改。
const KEY_ALIAS = Object.assign({}, keyPolicy.DEFAULT_ALIASES, (_KEY_POLICY && _KEY_POLICY.aliases) || {});
function normalizeKeyName(k) { return keyPolicy.normalizeKeyName(k, KEY_ALIAS); }
/** 策略判定（纯函数）：返回命中的规则对象或 null。 */
function keyPolicyViolation(keys) { return keyPolicy.matchRule(keys, KEY_POLICY_RULES, KEY_ALIAS); }
/** E5：完整判定（allowed/reason/needsConfirm），内部与单测共用。 */
function keyPolicyClassify(spec) {
    return keyPolicy.classify(spec, { rules: KEY_POLICY_RULES, aliases: KEY_ALIAS, denyMessage: KEY_POLICY_DENY_MSG });
}

// 操控层可观测计数（2026-11-21）：每条一致性修复都要能被 doctor/测试看到，
// 不允许「改了但没人知道有没有生效」。
const CONTROL_STATS = {
    coordChecks: 0, coordRejected: 0, displayCount: 0, multiDisplay: false,
    keyPolicyRejects: 0, windowOpReadbackFails: 0,
    resolveCalls: 0, resolveMultiHit: 0, resolveFailed: 0,
    // 工具面收敛（2026-11-21）：SoM 点击 / 守卫缺省补全 / schema 外参数 / 破坏性确认
    somClicks: 0, guardDefaulted: 0, schemaUnknownKeys: 0, confirmDestructiveGranted: 0,
    // D2 经验路由（2026-11-22）：记账次数 / 因拿不到 app 指纹跳过 / 触发的降级
    routeExpRecords: 0, routeExpSkippedNoApp: 0, routeExpDegraded: 0,
    lastResolveDetail: '',
};
function controlStats() { return Object.assign({}, CONTROL_STATS); }
/** 供上层（dispatch/index.js）记同一份计数；未知键忽略，避免拼错悄悄丢数。 */
function bumpControlStat(key, n) {
    if (!Object.prototype.hasOwnProperty.call(CONTROL_STATS, key)) return false;
    if (typeof CONTROL_STATS[key] !== 'number') return false;
    CONTROL_STATS[key] += Number(n) || 1;
    return true;
}

// ── D2 app 指纹缓存（2026-11-22）────────────────────────────────────────────
// 为什么需要缓存：经验路由的键必须是**进程名**，而窗口枚举（列表/快照）只给 pid+title。
// 拿进程名的廉价来源是 getForegroundInfo（pet-core fg 已带 app 字段，一次 P/Invoke）。
// 这里只缓存**已经发生过的**解析结果，绝不为记账额外起进程/查窗口 —— 记账是 best-effort，
// 拿不到 app 就跳过（routeExpSkippedNoApp 可观测），不能拖慢真实动作。
const _EXP_APP_TTL_MS = 120000;
const _EXP_APP_MAX = 400;
const _expAppByPid = new Map();     // pid -> { app, at }
const _expAppByTitle = new Map();   // 小写标题 -> { app, at }

function _expPrune(now) {
    if (_expAppByPid.size > _EXP_APP_MAX) {
        const rows = Array.from(_expAppByPid.entries()).sort((a, b) => a[1].at - b[1].at);
        for (let i = 0; i < rows.length - _EXP_APP_MAX; i += 1) _expAppByPid.delete(rows[i][0]);
    }
    if (_expAppByTitle.size > _EXP_APP_MAX) {
        const rows = Array.from(_expAppByTitle.entries()).sort((a, b) => a[1].at - b[1].at);
        for (let i = 0; i < rows.length - _EXP_APP_MAX; i += 1) _expAppByTitle.delete(rows[i][0]);
    }
}

/** 记下「pid/窗口标题 → 进程名」的观测（只写缓存，不做 IO）。 */
function _expNoteApp(pid, app, title) {
    const key = (() => {
        try { return routeExperience.normalizeApp(app); } catch (e) { return ''; }
    })();
    if (!key) return '';
    const now = Date.now();
    const p = Number(pid) || 0;
    if (p > 0) _expAppByPid.set(p, { app: key, at: now });
    const t = String(title || '').trim().toLowerCase();
    if (t) _expAppByTitle.set(t, { app: key, at: now });
    _expPrune(now);
    return key;
}

/** 从缓存取 app 指纹：优先 pid，其次标题（精确/包含）。取不到返回 ''。 */
function _expAppFor(pid, title) {
    const now = Date.now();
    const p = Number(pid) || 0;
    if (p > 0) {
        const hit = _expAppByPid.get(p);
        if (hit && now - hit.at <= _EXP_APP_TTL_MS) return hit.app;
    }
    const t = String(title || '').trim().toLowerCase();
    if (!t) return '';
    const exact = _expAppByTitle.get(t);
    if (exact && now - exact.at <= _EXP_APP_TTL_MS) return exact.app;
    if (t.length >= 4) {
        for (const [key, val] of _expAppByTitle) {
            if (now - val.at > _EXP_APP_TTL_MS) continue;
            if (key.length >= 4 && (key.includes(t) || t.includes(key))) return val.app;
        }
    }
    return '';
}

/**
 * D2：把一次真实动作的结果记进经验路由。**只读结果字段**，不改 res。
 * 跳过 not_sent / action_sent:false：那不是通道选错，是前台/参数/环境问题，
 * 记进去会把好通道冤枉成坏通道。
 */
const ROUTE_EXPERIENCE_ACTIONS = new Set(['click_text', 'click_element', 'som_click']);

function recordRouteOutcome(act, focus, res) {
    try {
        if (!res || typeof res !== 'object') return false;
        if (res.effect === 'not_sent' || res.action_sent === false) return false;
        // ⚠ 指纹来源必须与**本次动作的目标**一致：
        //   click_element / som_click 的编号本来就来自各自的快照状态，可以用；
        //   click_text 没有快照绑定 —— 绝不能拿上一次 snapshot 的 pid（那是另一个窗口），
        //   否则会把 A 应用的结果记到 B 应用头上。它只认 focus / 结果里的 pid。
        let pid = res.pid || res.targetPid || 0;
        let title = focus || res.windowTitle || '';
        if (!pid && !title) {
            if (act === 'click_element') {
                pid = UIA_SNAPSHOT_STATE.pid;
                title = UIA_SNAPSHOT_STATE.title || '';
            } else if (act === 'som_click') {
                title = SOM_STATE.title || '';
            }
        }
        const app = _expAppFor(pid, title);
        if (!app) {
            bumpControlStat('routeExpSkippedNoApp', 1);
            return false;
        }
        const out = routeExperience.record({
            app,
            via: res.via || '',
            ok: res.ok !== false,
            verified: res.verified === true ? true : (res.verified === false ? false : null),
        });
        if (!out || !out.recorded) return false;
        bumpControlStat('routeExpRecords', 1);
        if (out.degraded) bumpControlStat('routeExpDegraded', 1);
        return true;
    } catch (e) {
        // 经验记账永远不能影响真实动作
        return false;
    }
}

const SENDKEY_MAP = {
    enter: '{ENTER}', space: ' ', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', del: '{DEL}',
    backspace: '{BS}', delete: '{DEL}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
    home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
    // 数学/符号别名（2026-11-10 三十九轮实测：她 press_key "multiply" 直接报「不认识的键」，
    // 逼她改用整屏 click_at 点按钮；别名补上后键盘输入这条路对她可用）。
    // ⚠ SendKeys 特殊字符只有 + ^ % ~ ( ) { } [ ]，其中 `+` 必须转义成 {+}；* / - = . 安全。
    multiply: '*', star: '*', times: '*',
    divide: '/', slash: '/',
    plus: '{+}', add: '{+}',
    minus: '-', subtract: '-',
    equal: '=', equals: '=',
    decimal: '.', point: '.', dot: '.',
    percent: '%',
};
const VK = { volume_up: 0xAF, volume_down: 0xAE, volume_mute: 0xAD };

const state = { lastAt: 0, window: [] };

// 通用语义动作表（Neuro SDK 思路的最小实现）：她说「前进」「跳跃」，键位由 profile 决定。
// 换游戏 = 在 dispatch 的 plugin_config.json 加 game_profiles.<游戏名>，不改代码。
const SEMANTIC_GENERIC = {
    前进: 'hold:w,1', 后退: 'hold:s,1', 左移: 'hold:a,1', 右移: 'hold:d,1',
    跳跃: 'press:space', 攻击: 'press:j', 互动: 'press:e', 蹲下: 'hold:ctrl,0.5',
    确认: 'press:enter', 取消: 'press:esc',
};

// ── 内置常见游戏键位 profile（2026-11-09）─────────────────────────────────────
// 用户诉求「打游戏什么的都可以做」。零风险路径：只做**键位映射**（模拟按键），
// 不读游戏内存、不注入 DLL、不改游戏文件——这是「辅助输入」，不是外挂。
// 但仍有反作弊风险（部分竞技游戏禁止任何自动输入），所以：
//   · 竞技类（LOL/瓦罗兰特/CS）默认**只提供查询**，`allow_competitive: false` 时不执行按键
//   · 用户可在 plugin_config.json 里覆盖任意 profile
// 键位基于各游戏默认键位，玩家改键后请在配置里覆盖。
const SEMANTIC_PROFILES_BUILTIN = {
    // 原神/崩铁类（WASD + 1234 技能 + Q/E 大招/交互）
    '原神': {
        前进: 'hold:w,1', 后退: 'hold:s,1', 左移: 'hold:a,1', 右移: 'hold:d,1',
        跳跃: 'press:space', 冲刺: 'hold:shift,1', 攻击: 'press:鼠标左', 重击: 'hold:鼠标左,1',
        技能: 'press:e', 大招: 'press:q', 交互: 'press:f', 背包: 'press:b', 地图: 'press:m',
        确认: 'press:enter', 取消: 'press:esc',
        一技能: 'press:1', 二技能: 'press:2', 三技能: 'press:3', 四技能: 'press:4',
    },
    // 我的世界（Java 版默认键位）
    '我的世界': {
        前进: 'hold:w,1', 后退: 'hold:s,1', 左移: 'hold:a,1', 右移: 'hold:d,1',
        跳跃: 'press:space', 潜行: 'hold:shift,1', 冲刺: 'hold:ctrl,1',
        攻击: 'press:鼠标左', 使用: 'press:鼠标右', 丢弃: 'press:q',
        背包: 'press:e', 说话: 'press:t', 聊天: 'press:t',
        一栏: 'press:1', 二栏: 'press:2', 三栏: 'press:3',
    },
    // 英雄联盟（注意：竞技游戏，默认仅允许查询；enabled:false 时不自动按）
    '英雄联盟': {
        一技能: 'press:q', 二技能: 'press:w', 三技能: 'press:e', 大招: 'press:r',
        回城: 'press:b', 升级技能: 'combo:ctrl+q', 饰品: 'press:4',
        攻击移动: 'press:a', 停止: 'press:s', 视角回中: 'press:space',
        _risk: 'competitive',
    },
    // 无畏契约/CS 类（同样竞技）
    '无畏契约': { 一技能: 'press:q', 二技能: 'press:e', 三技能: 'press:c', 大招: 'press:x', 买装备: 'press:b', _risk: 'competitive' },
    '反恐精英': { 主武器: 'press:1', 副武器: 'press:2', 刀: 'press:3', 炸弹: 'press:5', 买装备: 'press:b', _risk: 'competitive' },
    // 通用 FPS
    'FPS通用': {
        前进: 'hold:w,1', 后退: 'hold:s,1', 左移: 'hold:a,1', 右移: 'hold:d,1',
        跳跃: 'press:space', 蹲下: 'hold:ctrl,1', 冲刺: 'hold:shift,1',
        开火: 'press:鼠标左', 瞄准: 'hold:鼠标右,1', 换弹: 'press:r', 互动: 'press:e',
        一武器: 'press:1', 二武器: 'press:2', 医疗: 'press:4',
    },
    // 植物大战僵尸杂交版（2026-11-09 实测路径 D:/Games/植物大战僵尸杂交重制版v0.31）
    // 它主要靠鼠标点格子种植物，键盘只有功能键。种植物走 click_at 点行列坐标。
    '植物大战僵尸': {
        暂停: 'press:space', 菜单: 'press:esc', 确认: 'press:enter',
        铲子: 'press:q',
        快捷栏1: 'press:1', 快捷栏2: 'press:2', 快捷栏3: 'press:3', 快捷栏4: 'press:4',
        快捷栏5: 'press:5', 快捷栏6: 'press:6', 快捷栏7: 'press:7', 快捷栏8: 'press:8',
        快捷栏9: 'press:9', 快捷栏十: 'press:0',
    },
    // 模拟经营/通用（星露谷、泰拉瑞亚这类）
    '通用2D': {
        前进: 'hold:d,1', 后退: 'hold:a,1', 上: 'hold:w,1', 下: 'hold:s,1',
        跳跃: 'press:space', 攻击: 'press:鼠标左', 使用: 'press:鼠标右',
        背包: 'press:e', 地图: 'press:m', 确认: 'press:enter', 取消: 'press:esc',
    },
};

// 游戏态限速（2026-11-09）：原来 300ms 冷却 + 20 次/分钟，打游戏根本不够
//（走位+技能连招一秒就要好几次）。区分两种场景：
//   · 非游戏态（日常操控）：保持原限制，防误触
//   · 游戏态（前台是全屏游戏）：放宽到 80ms 冷却 / 600 次每分钟，够连招
const stateGame = { lastAt: 0, window: [] };

function rateGate() {
    const now = Date.now();
    if (now - state.lastAt < 300) return '太快了，歇一下再按（冷却 300ms）';
    state.window = state.window.filter((t) => now - t < 60000);
    if (state.window.length >= 20) return '一分钟里按了太多次（上限 20），先缓缓';
    state.lastAt = now;
    state.window.push(now);
    return null;
}

/** 游戏态限速：给「她陪你打游戏」用，冷 80ms、上限 600/分钟。 */
function rateGateGame() {
    // 2026-11-09 压测修正：原来有 80ms 硬冷却，实测连续 10 次只过 4 次——
    // 但**人按键本来就不需要冷却**（连招一秒能按 8-12 次，间隔经常 <80ms）。
    // 80ms 冷却对游戏是纯伤害。现在只保留「每分钟 600 次」这个防失控上限，
    // 不设冷却是安全的：SendInput 本身是系统级瞬时调用，不存在队列堆积风险。
    const now = Date.now();
    stateGame.window = stateGame.window.filter((t) => now - t < 60000);
    if (stateGame.window.length >= 600) return '一分钟 600 次上限（防失控）';
    stateGame.lastAt = now;
    stateGame.window.push(now);
    return null;
}

function runPs(script, timeoutMs = 8000) {
    return new Promise((resolve) => {
        try {
            // ⚠ 编码坑（2026-11-09 实测）：pwsh 管道输出默认跟随系统代码页（本机 GBK），
            // Node 按 UTF-8 解码 → 中文窗口标题全变 `����`（实测 list_windows 16 个窗口一半乱码，
            // 「设置」「安卓模拟器」这类中文标题不可读，AI 也就没法据此操作）。
            // 修法：脚本前置强制 Console 输出编码为 UTF-8，stdout 也显式按 utf8 解码。
            const wrapped = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ' + script;
            const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', wrapped], { windowsHide: true });
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            let out = '', err = '';
            child.stdout.on('data', (c) => { out += c; });
            child.stderr.on('data', (c) => { err += c; });
            child.on('error', (e) => resolve({ ok: false, error: e.message }));
            child.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), error: err.trim() || (code === 0 ? '' : 'exit ' + code) }));
            setTimeout(() => { try { child.kill(); } catch (e) { try { __silentAudit.audit('game-control.js:53', e); } catch (e2) {} } resolve({ ok: false, error: 'timeout' }); }, timeoutMs);
        } catch (e) { resolve({ ok: false, error: e.message }); }
    });
}

function escapeSendKeys(text) {
    // SendKeys 特殊字符 (+^%~(){}[]) 要用花括号包起来
    return String(text).replace(/([+^%~(){}[\]])/g, '{$1}');
}

/** 组合键/单键 → SendKeys 序列。支持 'w' / 'ctrl+s' / 'shift+alt+t' / 'enter'。 */
function toSendKeys(spec) {
    const rawParts = keyPolicy.splitKeySpec(spec);
    if (!rawParts.length) throw new Error('空的按键');
    // 唯一安全策略表（JS/Rust 同源）：命中即拒，错误文案两边一致。
    const kp = keyPolicyClassify(rawParts);
    if (!kp.allowed) {
        CONTROL_STATS.keyPolicyRejects += 1;
        try { __silentAudit.audit('game-control:key-policy', 'rejected: ' + String(spec).slice(0, 40)); } catch (e) { /* ignore */ }
        throw new Error(kp.reason);
    }
    const parts = rawParts.map(normalizeKeyName);
    let mods = '';
    const keys = [];
    for (const p of parts) {
        if (p === 'ctrl') mods += '^';
        else if (p === 'alt') mods += '%';
        else if (p === 'shift') mods += '+';
        else if (SENDKEY_MAP[p]) keys.push(SENDKEY_MAP[p]);
        else if (/^[a-z0-9]$/.test(p)) keys.push(p.toUpperCase());
        else if (/^f([1-9]|1[0-2])$/.test(p)) keys.push('{' + p.toUpperCase() + '}');
        else throw new Error('不认识的键：' + p);
    }
    return mods + keys.join('');
}

/**
 * 内置启动白名单（2026-11-14 从 launch_app case 提到模块级）。
 *
 * 提上来是为了让 focus 也能用：**中文应用名 ≠ 窗口标题/进程名**是这台机器上的常态
 * （记事本窗口标题是英文 `*zcode-et3.txt - Notepad`、PCL 的进程名是
 * `Plain Craft Launcher 2`），而 Rust/UIA 的 focus 只按标题匹配 —— 于是
 * 「打开记事本 → focus 记事本」必然失败，后面 press_key 全打空。
 * 有了这张表，focus 能把「记事本」翻成 `notepad` 再按进程名找窗口。
 */
const BUILTIN_APPS = {
    '植物大战僵尸': 'D:/Games/植物大战僵尸杂交重制版v0.31/植物大战僵尸杂交版发布版0.31.0.Csharp.exe',
    'Minecraft': '',   // 需用户在配置里填
    // ── 2026-11-10 三十七轮：系统自带软件（拟真「打开记事本」场景的缺口）——
    //    Windows 自带、零安全风险。⚠ 必须全路径：existsSync 按进程 cwd 解析，
    //   裸 'calc.exe' 会误报「文件不存在」（实测踩到）。本机 mspaint 是 Store 应用无 exe，不收。
    '记事本': 'C:/Windows/System32/notepad.exe',
    '计算器': 'C:/Windows/System32/calc.exe',
};

// ── 游戏窗口识别（2026-11-25 P1-1）─────────────────────────────────────────
// 病根：`act key` 先发 SendInput，但 GLFW 游戏（MC）实测**丢弃 SendInput**，只认 PostMessage
// （js/core/game-loop.js:648-662）。这里复用三份既有判据，不再新造检测框架：
//   ① 内置游戏名/别名（SEMANTIC_PROFILES_BUILTIN + 本文件原有的正则别名表）
//   ② pet-runtime/data/game-profiles/*.json 的 window 字段（game-loop.listProfiles）
//   ③ 前台进程名（pet-core fg 已带 app）
// 浏览器/编辑器标题里的游戏名（「Chrome - Minecraft 攻略」）不算游戏，否则按键会被错误
// 路由到 PostMessage（对浏览器窗口通常无效）。
const GAME_TITLE_EXCLUDE_RE = /(Google Chrome|Microsoft Edge|Mozilla Firefox|Firefox|Opera|Brave|Vivaldi|哔哩哔哩|bilibili|YouTube|Visual Studio Code|Cursor|PyCharm|IntelliJ|WebStorm|Sublime Text|Notepad\+\+|微信|WeChat|Telegram|Discord|钉钉|飞书|Slack|Microsoft Teams|Windows Terminal|PowerShell|命令提示符|Git Bash|文件资源管理器|File Explorer|任务管理器|Task Manager)/i;
const GAME_TITLE_ALIASES = [
    { re: /Minecraft|我的世界/i, name: '我的世界' },
    { re: /Genshin|原神/i, name: '原神' },
    { re: /植物大战僵尸|PlantsVsZombies|PvZ/i, name: '植物大战僵尸' },
    { re: /League of Legends|英雄联盟/i, name: '英雄联盟' },
    { re: /Valorant|无畏契约/i, name: '无畏契约' },
    { re: /Counter-Strike|CS2|CSGO/i, name: '反恐精英' },
];
// 进程名（小写、去 .exe）里的游戏特征。只作第三路补充：窗口标题/profile 已经能覆盖大多数。
const GAME_PROCESS_HINTS = [
    'javaw', 'java', 'minecraft', 'genshinimpact', 'yuanshen', 'plantsvszombies', 'pvz',
    'leagueclient', 'league of legends', 'valorant', 'cs2', 'csgo', 'terraria', 'stardewvalley',
];
let _gameProfilesCache = { at: 0, list: [] };

/** 读 game-profiles（30s 缓存）。失败返回 []，不阻塞按键。 */
function _gameProfiles() {
    if (Date.now() - _gameProfilesCache.at < 30000) return _gameProfilesCache.list;
    let list = [];
    try {
        const GL = require('../../../js/core/game-loop.js');
        if (GL && typeof GL.listProfiles === 'function') list = GL.listProfiles() || [];
    } catch (e) { list = []; }
    _gameProfilesCache = { at: Date.now(), list };
    return list;
}

/**
 * 判断一个窗口是不是游戏（纯函数，测试直接打）。
 * @param {{title?:string, app?:string, proc?:string, hwnd?:number}} win
 * @param {Array<{game?:string, window?:string}>} [profiles]
 * @returns {{isGame:boolean, game?:string, via?:string}}
 */
function detectGameWindow(win, profiles) {
    const title = String((win && win.title) || '');
    const app = String((win && (win.app || win.proc)) || '');
    if (!title && !app) return { isGame: false };
    // 浏览器/编辑器/IM 里的游戏名不算（防「搜攻略」被误判成打游戏）
    if (title && GAME_TITLE_EXCLUDE_RE.test(title)) return { isGame: false, reason: 'non-game-app' };
    // ① 进程名（最可靠：窗口标题看不见 javaw）
    const proc = app.toLowerCase().replace(/\.exe$/i, '').trim();
    if (proc && GAME_PROCESS_HINTS.some((h) => proc === h || proc.includes(h))) {
        return { isGame: true, game: proc, via: 'process' };
    }
    // ② 既有 profile 文件（换游戏只改 JSON 的那份数据）
    for (const p of (Array.isArray(profiles) ? profiles : [])) {
        const w = String((p && p.window) || '').trim();
        if (!w) continue;
        if (title && titleMatchKind(title, w)) return { isGame: true, game: String(p.game || w), via: 'profile' };
    }
    // ③ 内置游戏名/别名
    if (title) {
        for (const a of GAME_TITLE_ALIASES) {
            if (a.re.test(title)) return { isGame: true, game: a.name, via: 'title-alias' };
        }
        for (const name of Object.keys(SEMANTIC_PROFILES_BUILTIN)) {
            if (name.startsWith('_')) continue;
            // 只认具体游戏名；'FPS通用'/'通用2D' 是键位模板，不是游戏身份
            if (name === 'FPS通用' || name === '通用2D') continue;
            if (title.toLowerCase().includes(name.toLowerCase())) return { isGame: true, game: name, via: 'title' };
        }
    }
    return { isGame: false };
}

/**
 * 按键路由决策（纯函数）：游戏 → postmessage；其它 → sendinput。
 * 游戏窗口缺 hwnd 时返回 error（PostMessage 没有 hwnd 无处可投），调用方必须报错而不是回退。
 */
function decideKeyRoute(win, profiles) {
    const g = detectGameWindow(win, profiles);
    if (!g.isGame) return { method: 'sendinput', isGame: false };
    const hwnd = Number(win && win.hwnd) || 0;
    if (!hwnd) {
        return {
            method: 'postmessage', isGame: true, game: g.game, hwnd: 0,
            error: '目标「' + (g.game || '游戏') + '」是游戏，但拿不到 hwnd，无法 PostMessage（请带 window 重试）',
        };
    }
    return { method: 'postmessage', isGame: true, game: g.game, hwnd, via: g.via };
}


const PS_SIG = `$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PetU {
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  public struct POINT { public int X; public int Y; }
}
'@; Add-Type -TypeDefinition $sig; [void][PetU]::SetProcessDPIAware();`;

// ── 五级门禁的否决码（2026-11-10 四十轮，抄 rust_core_prototype/ipc/protocol.rs）──
// LLM 看到的是人话，但结果里带一个稳定数字码，便于日志聚合/回归断言。
const VETO = {
    FOCUS_LOST: 1001,
    TARGET_OCCLUDED: 1002,
    SCENE_TURBULENT: 1003,
    HOVER_PROBE_FAILED: 1004,
    EMERGENCY_STOP: 1005,
    POST_ASSERT_FAILED: 1006,
    VRAM_PRESSURE_HIGH: 1007,
    WINDOW_DESTROYED: 1008,
    // 1009：点击原语前置守卫拒绝（破坏性按钮 / 落点在自己的窗口）——动作**没有发出去**
    GUARD_BLOCKED: 1009,
};

/** UAC 安全桌面探针（抄原型 check_secure_desktop）：OpenInputDesktop 返回空且
 *  GetLastError=5(ERROR_ACCESS_DENIED) = 当前在安全桌面，绝不能注入。
 *  放在已有的 pwsh 脚本里执行，不额外起进程。 */
function psUacGuard() {
    return `
$__hd = [PetU]::OpenInputDesktop(0, $false, 0x0100)
if ($__hd -eq [IntPtr]::Zero) {
  $__err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($__err -eq 5) { Write-Output 'UAC-SECURE-DESKTOP'; exit 3 }
} else { [void][PetU]::CloseDesktop($__hd) }
`;
}

/** 落点遮挡探针（抄原型 Gate 2 / 我们 pet-core 的 window_from_point）：
 *  WindowFromPoint 查落点真正的根窗口，标题和期望目标不符 → 绝不发点击
 *  （桌宠自己/置顶小工具/输入法面板压在上面时，坐标对、前台对，点击仍会被吞）。 */
function psOcclusionGuard(x, y, expectTitle) {
    const want = String(expectTitle || '').trim();
    if (!want) return '';
    const t = want.toLowerCase().replace(/'/g, "''");
    return `
$__wp = New-Object PetU+POINT; $__wp.X = ${Math.round(x)}; $__wp.Y = ${Math.round(y)}
$__wh = [PetU]::WindowFromPoint($__wp)
if ($__wh -ne [IntPtr]::Zero) {
  $__wr = [PetU]::GetAncestor($__wh, 2)
  $__wsb = New-Object System.Text.StringBuilder 512
  [void][PetU]::GetWindowTextW($__wr, $__wsb, 512)
  $__wt = $__wsb.ToString()
  if ($__wt -and (-not $__wt.ToLower().Contains('${t}'))) { Write-Output ('OCCLUDED:' + $__wt); exit 2 }
}
`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 操控层韧性（2026-11-21 · P0/P1/P2，doc: 设计-操控层提升-2026-11-21.md）
//
// 这一块只做「让现有动作更可靠」的四件事，不新增工具、不新增进程、不改三层注入语义：
//   P0-1 1001 否决后按同 pid 自动 focus 一次再重发一次
//   P0-2 前台判定按 pid（主窗 + 模态对话框同 pid 不再互斥）
//   P0-3 元素动作三级回落 Invoke → Toggle/SelectionItem.Select → 坐标（pet-core 物理入口）
//   P1-5 #32770 对话框控件类型补全 / P1-6 等 UIA 树稳定 / P1-7 可见性闸
//   P2-8 名称归一 + 三级匹配（多命中 ambiguous）/ P2-9 可选 verify / P2-10 坐标单点收口
//
// 验证方式（单测）：_probe/test-act-resilience.cjs 用注入的假依赖跑纯函数，
// 不碰真桌面；真机路径由 check-all 的窗口回归与人工复测覆盖。
// ═══════════════════════════════════════════════════════════════════════════

const _uiaSleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

/** powershell **5.1**（不是 pwsh7）：UIAutomationClient 在 .NET Framework GAC 里，
 *  pwsh7 的引用链在本机装不上（见 docs/研究-电脑操控升级路径-2026-11-08.md）。
 *  只用于 UIA 探测脚本；输出走 Base64，整条通道 ASCII，不受 GBK 影响。 */
function runPs51(script, timeoutMs = 10000) {
    return new Promise((resolve) => {
        try {
            const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
            let out = '', err = '';
            child.stdout.on('data', (c) => { out += c; });
            child.stderr.on('data', (c) => { err += c; });
            child.on('error', (e) => resolve({ ok: false, error: e.message }));
            child.on('close', (code) => resolve({
                ok: code === 0, out: out.trim(),
                error: err.trim() || (code === 0 ? '' : 'exit ' + code),
            }));
            setTimeout(() => {
                try { child.kill(); } catch (e) { /* ignore */ }
                resolve({ ok: false, error: 'timeout' });
            }, timeoutMs);
        } catch (e) { resolve({ ok: false, error: e.message }); }
    });
}

// ── P0-2：前台判定（纯函数 + pid 解析）──────────────────────────────────
/**
 * 判定「目标窗口是否等于/属于当前前台」。纯函数，单测直接打。
 * @param {object} fg  {title,pid,hwnd,proc}
 * @param {object} t   {title?,pid?,hwnd?,owned?}
 * @returns {{ok:boolean, matchedBy?:string, fgPid:number, targetPid:number, samePid?:boolean}}
 *
 * 语义（P0-2）：目标 pid === 前台 pid 即视为前台 —— 同一应用的主窗与模态对话框
 * 是一对「同 pid 窗口」，以前按标题比对会把它们当成两个对手互相拒。
 * owned popup 的 pid 天然等于 owner 的 pid，所以同 pid 判定已覆盖；这里额外留痕。
 */
function fgVerdict(fg, t, opts) {
    const target = t || {};
    const strict = !!(opts && opts.strict === true);
    const fgPid = Number(fg && fg.pid) || 0;
    const targetPid = Number(target.pid) || 0;
    if (!fg) return { ok: false, matchedBy: '', fgPid, targetPid, reason: 'sensor' };
    if (target.hwnd && Number(fg.hwnd) === Number(target.hwnd)) {
        return { ok: true, matchedBy: 'hwnd', fgPid, targetPid: targetPid || fgPid };
    }
    if (targetPid && fgPid && Number(targetPid) === Number(fgPid)) {
        // 2026-11-21 审计（P1）：同 pid 只对「UIA 直调」够用。物理输入（SendInput /
        // SetCursorPos）发给的是**前台窗口**；同一进程的两个窗口（两个资源管理器/
        // 同进程多窗口）pid 相同但 hwnd 不同 → 以前会放行，按键/点击实际落到兄弟窗口。
        // strict 模式要求精确 hwnd 或 Windows owner 关系；owner 判定由调用方补。
        if (strict && target.hwnd && Number(target.hwnd) !== Number(fg.hwnd)) {
            return {
                ok: false, matchedBy: '', fgPid, targetPid, samePid: true,
                reason: 'same-pid-different-window',
                fgHwnd: Number(fg.hwnd) || 0, targetHwnd: Number(target.hwnd) || 0,
            };
        }
        return {
            ok: true, matchedBy: 'pid', fgPid, targetPid,
            samePid: true, targetOwned: target.owned === true,
        };
    }
    const needle = String(target.title || target.query || '').toLowerCase();
    if (needle) {
        const fgTitle = String(fg.title || '').toLowerCase();
        const fgProc = String(fg.proc || '').toLowerCase();
        if (fgTitle.includes(needle) || fgProc.includes(needle)) {
            return { ok: true, matchedBy: 'title', fgPid, targetPid };
        }
    }
    return { ok: false, matchedBy: '', fgPid, targetPid };
}

/** 内核窗口清单（Rust：hwnd/title/class/pid/iconic/owned，4ms 级）。
 *
 * ⚠ 用**一次性 execFile**而不是常驻客户端（2026-11-21 门禁抓到的真 bug）：
 *   getCoreClient() 会起 `pet-core serve` 常驻子进程，它的管道会让**短命进程**
 *   （单测/CLI/regress-fake-success）在干完活后永不退出 —— 实测 check-all 卡在
 *   第一项回归 45 分钟。窗口枚举本来就只要几毫秒，不值得为它背一个常驻子进程。
 */
async function coreWindows(filter, max) {
    const bin = _coreBin();
    if (!bin) return null;
    return new Promise((resolve) => {
        try {
            const { execFile } = require('child_process');
            const child = execFile(bin, [], { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
                (err, stdout) => {
                    if (err) return resolve(null);
                    try {
                        const d = JSON.parse(String(stdout));
                        const wins = d && Array.isArray(d.windows) ? d.windows : null;
                        resolve(wins ? wins.filter((w) => !isDragPreviewWin(w)) : null);
                    } catch (e) { resolve(null); }
                });
            try {
                child.stdin.end(JSON.stringify({ cmd: 'windows', filter: String(filter || ''), max: Number(max) || 200 }), 'utf8');
            } catch (e) { resolve(null); }
        } catch (e) { resolve(null); }
    });
}

// 拖动预览窗（main.js 的 __dragPreview）—— 它是她自己的虚线框，不是业务窗口。
// 标题由 main.js 写死成 DRAG_PREVIEW_TITLE；凡是窗口枚举/解析都当它不存在，
// 否则「拖她的时候」list_windows 会多出一个 combined-project 之类的幽灵窗口。
const DRAG_PREVIEW_TITLE = '__pet_drag_preview__';
function isDragPreviewWin(w) {
    const t = String((w && (w.title || w.MainWindowTitle || w.name)) || '');
    return t === DRAG_PREVIEW_TITLE;
}

// ── 屏幕边界：所有显示器的并集（2026-11-21 审计 P1）────────────────────────
// 病根：原实现用 `screen.getPrimaryDisplay().bounds × scaleFactor` —— 副屏（尤其负坐标
//   的左侧副屏）上的合法坐标全被判「超出屏幕范围」，点击/拖拽/滚动在副屏上直接不可用。
// 为什么用「所有显示器并集」而不是「光标所在显示器」：
//   · 校验对象是**即将移动到的点**，和当前光标位置无关 —— 光标在主屏时把鼠标移到副屏
//     是完全合法的；按光标所在屏判会把这条正常路径误拒。
//   · 合法坐标集合 = 所有可寻址物理像素的并集，这正好是 SendInput/SetCursorPos 能落到的
//     范围（Rust 侧 native.rs 也是用 SM_*VIRTUALSCREEN 虚拟屏）。
// 为什么逐个显示器乘自己的 scaleFactor：Electron 的 bounds 是 DIP，注入层吃物理像素；
//   本机实测 150% 下主屏 DIP 1706×960 vs 物理 2560×1440。逐屏换算在单 DPI/同 DPI 多屏
//   下是精确的，混 DPI 下是**保守放大**（宁可放行边缘，也不误拒正常操作）。
function screenRectsFromDisplays(displays) {
    const out = [];
    for (const d of (Array.isArray(displays) ? displays : [])) {
        const b = d && d.bounds;
        if (!b) continue;
        const sf = geometry.scaleOf(d.scaleFactor);
        // 与原实现一致：`b.width || 0` 把 undefined/null/0/NaN 变成 0，非正宽高直接跳过。
        // 非数字字符串会得到 NaN 并原样流入（历史行为如此，不改）。
        const rawW = Number(b.width || 0);
        const rawH = Number(b.height || 0);
        if (rawW <= 0 || rawH <= 0) continue;
        const nr = geometry.normalizeRect({
            x: Number(b.x || 0), y: Number(b.y || 0), w: rawW, h: rawH,
        });
        const w = Math.round(geometry.toPhysical(nr.w, sf));
        const h = Math.round(geometry.toPhysical(nr.h, sf));
        if (w <= 0 || h <= 0) continue;
        out.push({
            x: Math.round(geometry.toPhysical(nr.x, sf)),
            y: Math.round(geometry.toPhysical(nr.y, sf)),
            w, h, dpi: sf,
        });
    }
    return out;
}

/** 当前屏幕矩形（物理像素）。拿不到 Electron → 沿用旧的 ±16384 宽松兜底。 */
function screenRects() {
    const fallback = [{ x: -16384, y: -16384, w: 32768, h: 32768, dpi: 0 }];
    try {
        const scr = require('electron').screen;
        const list = typeof scr.getAllDisplays === 'function' ? scr.getAllDisplays() : [scr.getPrimaryDisplay()];
        const rects = screenRectsFromDisplays(list);
        if (rects.length) {
            CONTROL_STATS.displayCount = rects.length;
            CONTROL_STATS.multiDisplay = rects.length > 1;
            return { rects, via: 'electron-all-displays' };
        }
    } catch (e) { /* 纯 Node（测试/CLI/子进程）没有 electron：保持宽松兜底 */ }
    return { rects: fallback, via: 'fallback' };
}

/** 点是否落在任一显示器矩形内（tol 吸收 DIP×scaleFactor 的舍入误差）。实现见 js/core/geometry.js。 */
function pointOnAnyScreen(x, y, rects, tol) {
    return geometry.pointOnAnyScreen(x, y, rects, tol);
}

/**
 * 屏幕边界前置检查（click_at / mouse / drag / scroll 共用唯一实现）。
 * 越界抛错并留下审计 + 计数；通过返回命中的显示器矩形。
 */
function assertScreenPoint(x, y, what) {
    const { rects, via } = screenRects();
    CONTROL_STATS.coordChecks += 1;
    const hit = pointOnAnyScreen(x, y, rects);
    if (hit) return hit;
    CONTROL_STATS.coordRejected += 1;
    const summary = rects.map((r) => (r.w + '×' + r.h + '@' + r.x + ',' + r.y)).join(' ∪ ');
    try {
        __silentAudit.audit('game-control:coord-out-of-screen',
            (what || 'point') + ' (' + x + ',' + y + ') outside ' + rects.length + ' display(s): ' + summary);
    } catch (e) { /* ignore */ }
    throw new Error('坐标 (' + x + ',' + y + ') 超出屏幕范围（' + summary + '，共 ' + rects.length +
        ' 块屏 / ' + via + '） —— 坐标算错了');
}

/** 取窗口的 owner hwnd（GW_OWNER=4）；失败返回 0。只在「pid 不一致」的异常路径调用。 */function winOwnerOf(hwnd) {
    const h = Number(hwnd) || 0;
    if (!h) return Promise.resolve(0);
    const script = 'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; '
        + 'public class _OwnQ { [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c); }\'; '
        + '$o = [_OwnQ]::GetWindow([IntPtr]' + h + ', 4); [string]$o.ToInt64()';
    return runPs(script, 4000).then((r) => {
        const m = String((r && r.out) || '').match(/(\d+)/);
        return m ? Number(m[1]) : 0;
    }).catch(() => 0);
}

/**
 * owner 关系的纯判定（单测直接打）。
 * 实测：Chromium 的文件对话框（#32770）在**另一个 msedge.exe 进程**里，
 * 但它的 GW_OWNER 正好是主窗口 —— 只看 pid 会把同一个应用拆成两个对手。
 * 这里只认 Windows 自己的 owner 关系（精确 hwnd），不做标题/进程名猜测。
 */
function ownerRelationVerdict(s) {
    const o = s || {};
    const fgHwnd = Number(o.fgHwnd) || 0;
    const targetHwnd = Number(o.targetHwnd) || 0;
    const fgOwn = Number(o.fgOwn) || 0;
    const targetOwn = Number(o.targetOwn) || 0;
    if (!fgHwnd || !targetHwnd) return { ok: false };
    if (targetOwn && targetOwn === fgHwnd) {
        return { ok: true, matchedBy: 'owner', relation: 'target-owned-by-fg', ownerHwnd: targetOwn };
    }
    if (fgOwn && fgOwn === targetHwnd) {
        return { ok: true, matchedBy: 'owner', relation: 'fg-owned-by-target', ownerHwnd: fgOwn };
    }
    if (fgOwn && targetOwn && fgOwn === targetOwn) {
        return { ok: true, matchedBy: 'owner', relation: 'siblings', ownerHwnd: fgOwn };
    }
    return { ok: false, fgOwn, targetOwn };
}

/** 取 owner 并判定「前后台是否同一应用家族」。 */
async function sameAppFamily(fg, targetWin) {
    const fgHwnd = Number(fg && fg.hwnd) || 0;
    const targetHwnd = Number(targetWin && targetWin.hwnd) || 0;
    if (!fgHwnd || !targetHwnd) return { ok: false };
    const targetOwn = targetWin.owned === true ? await winOwnerOf(targetHwnd) : 0;
    const fgOwn = await winOwnerOf(fgHwnd);
    return ownerRelationVerdict({ fgHwnd, targetHwnd, fgOwn, targetOwn });
}

function _normWin(w, by) {
    return {
        hwnd: Number(w && w.hwnd) || 0,
        pid: Number(w && w.pid) || 0,
        title: String((w && w.title) || ''),
        class: String((w && w.class) || ''),
        iconic: !!(w && w.iconic === true),
        // 2026-11-21：最大化态与 iconic 分开透传 —— 最大化窗口的 rect 是负原点（-11,-11）
        // 的**合法值**，调用方据此区分「合法最大化」和「真的跑出屏幕」。
        maximized: !!(w && w.maximized === true),
        owned: !!(w && w.owned === true),
        rect: {
            x: Number(w && w.x) || 0, y: Number(w && w.y) || 0,
            w: Number(w && w.w) || 0, h: Number(w && w.h) || 0,
        },
        // D2：窗口枚举本身不带进程名；有就透传（uia-service 的窗口列表可能带），没有就空。
        app: String((w && (w.app || w.proc || w.ProcessName)) || ''),
        by: by || '',
    };
}

/**
 * 同名多窗口的最佳选择（2026-11-21 审计 P1）。
 *
 * 实测：UWP 计算器最小化时，EnumWindows 会同时列出
 *   · Windows.UI.Core.CoreWindow（CalculatorApp.exe，IsWindowVisible=true，但 UIA 树为空、
 *     聚焦后 GetForegroundWindow=0）
 *   · ApplicationFrameWindow（ApplicationFrameHost.exe，iconic=true，才是真窗口）
 * 旧逻辑「第一个非最小化」选中 CoreWindow → snapshot 报「空壳」、focus 报「激活了但前台
 * 还是别的」；runner 的 uia_click_calc 因此全按钮「没找到」。
 * 这里按「真实可操作」排序：非 CoreWindow 壳 > 非最小化 > 面积大 > 标题精确。
 */
function windowPickScore(w, needle) {
    let s = 0;
    const cls = String((w && w.class) || '');
    if (/^Windows\.UI\.Core\.CoreWindow$/i.test(cls)) s -= 5000;
    if (/^ApplicationFrameWindow$/i.test(cls)) s += 120;
    if (w && w.iconic) s -= 1000; else s += 300;
    const area = (Number(w && w.w) || 0) * (Number(w && w.h) || 0);
    if (area > 0) s += Math.min(200, Math.round(Math.log10(area) * 40));
    const t = String((w && w.title) || '').toLowerCase();
    const n = String(needle || '').toLowerCase();
    if (n && t === n) s += 200; else if (n && t.includes(n)) s += 50;
    return s;
}

function pickBestWindow(wins, needle) {
    const list = Array.isArray(wins) ? wins.filter(Boolean) : [];
    if (!list.length) return null;
    return list.slice().sort((a, b) => {
        const d = windowPickScore(b, needle) - windowPickScore(a, needle);
        if (d) return d;
        // 同分时保持枚举顺序（稳定，可复现）
        return Number(a.hwnd) - Number(b.hwnd);
    })[0];
}


/** 歧义候选的可读清单（最多 8 个，带 hwnd/pid/title，方便模型改传 hwnd）。 */
function _candidateList(cands) {
    return (Array.isArray(cands) ? cands : []).slice(0, 8)
        .map((w) => 'hwnd=' + w.hwnd + '「' + String((w && w.title) || '').slice(0, 60) + '」(pid=' + w.pid + ')')
        .join('，');
}

/** UWP 的 CoreWindow 壳不是可操作目标（UIA 树空、聚焦后 GetForegroundWindow=0）。 */
function _isUwpShell(w) {
    return /^Windows\.UI\.Core\.CoreWindow$/i.test(String((w && w.class) || ''));
}
/**
 * 从候选里剔除「不可能是目标」的窗口：UWP 空壳 → 优先非最小化。
 * 这不是「猜」：空壳没有可操作界面，最小化副本是同一窗口的影子；
 * 剔除后仍有多个真实窗口，就在匹配层报歧义。
 */
function _operableCandidates(list) {
    const noShell = list.filter((w) => !_isUwpShell(w));
    const pool = noShell.length ? noShell : list;
    const live = pool.filter((w) => !w.iconic);
    return live.length ? live : pool;
}

/**
 * 候选窗口 → 唯一目标（2026-11-25 P1-2：与绑定层共用同一个标题 matcher）。
 *
 * 匹配层级（自上而下，第一个有候选的层级决定结果）：
 *   ① 完全相同
 *   ② 前缀 + 分隔符（短的一侧 ≥4 字）
 *   ③ 唯一子串（短针 ≥2 字）
 * 一层里有多个候选 = **歧义**：返回 ok:false + candidates，绝不「挑一个最高分」。
 * 只有 pid 分支（needle 为空）才继续用打分选（同一 pid 的兄弟窗口本来就要挑真窗口）。
 *
 * @returns {{ok:true,win:object,matchedBy:string,candidateCount:number,sameTitleCount:number,multiHit:boolean,detail:string}
 *          |{ok:false,code:string,error:string,candidates:object[],candidateCount:number,multiHit:boolean}}
 */
function pickWindowForTarget(wins, needle) {
    CONTROL_STATS.resolveCalls += 1;
    const list = (Array.isArray(wins) ? wins : []).filter(Boolean);
    if (!list.length) {
        CONTROL_STATS.resolveFailed += 1;
        return {
            ok: false, code: 'NOT_FOUND', candidates: [], candidateCount: 0, multiHit: false,
            error: '窗口解析失败：没有候选窗口（标题/hwnd/pid 都没匹配到）',
        };
    }
    const want = String(needle == null ? '' : needle).trim();
    // pid 分支：同一进程的多个窗口（UWP 空壳 + 真窗）仍按打分挑，不算标题歧义
    if (!want) {
        const best = pickBestWindow(list, '');
        if (!best) {
            CONTROL_STATS.resolveFailed += 1;
            return { ok: false, code: 'NOT_FOUND', candidates: [], candidateCount: list.length, multiHit: false, error: '窗口解析失败：候选里没有可用窗口' };
        }
        const multiHit = list.length > 1;
        if (multiHit) CONTROL_STATS.resolveMultiHit += 1;
        const detail = multiHit
            ? ('pid 下 ' + list.length + ' 个窗口，选 hwnd=' + best.hwnd + '（' + best.title + '）')
            : ('唯一命中 hwnd=' + best.hwnd + '（' + best.title + '）');
        CONTROL_STATS.lastResolveDetail = detail;
        return { ok: true, win: best, matchedBy: 'pid-pick', candidateCount: list.length, sameTitleCount: list.length, multiHit, detail };
    }
    // 2026-11-25：**不能**先按 iconic 过滤再匹配 —— 那会把「唯一命中但最小化」变成
    // 「没找到窗口」。这里在全部非空壳窗口上匹配，命中后再按 iconic 决定：
    //   唯一命中且最小化 → MINIMIZED（明确告诉模型先还原）；
    //   多命中 → 优先非最小化那个（同窗口的影子），全最小化 → MINIMIZED。
    const noShell = list.filter((w) => !_isUwpShell(w));
    const usable = noShell.length ? noShell : list;
    const tiers = { exact: [], prefix: [], substring: [] };
    for (const w of usable) {
        const kind = titleMatchKind(w && w.title, want);
        if (kind) tiers[kind].push(w);
    }
    const rawSame = list.filter((w) => _normWinText(w && w.title) === _normWinText(want)).length;
    for (const name of ['exact', 'prefix', 'substring']) {
        const hit = tiers[name];
        if (hit.length === 1) {
            const win = hit[0];
            // 2026-11-25：唯一命中但窗口最小化 → 明确说「最小化」，不要伪装成「没找到」
            if (win && win.iconic) {
                CONTROL_STATS.resolveFailed += 1;
                return {
                    ok: false, code: 'MINIMIZED', candidates: [win], candidateCount: 1, multiHit: false,
                    error: '窗口解析失败：目标窗口已最小化（' + (win.title || '') + '）—— 先 focus_window 或 window_op restore 还原窗口，再试',
                };
            }
            const multiHit = rawSame > 1;
            if (multiHit) CONTROL_STATS.resolveMultiHit += 1;
            const sameTitleCount = rawSame || 1;
            const detail = multiHit
                ? ('多命中 ' + rawSame + ' 个，选 hwnd=' + win.hwnd + '（' + win.title + '）')
                : ('唯一命中（' + name + '）hwnd=' + win.hwnd + '（' + win.title + '）');
            CONTROL_STATS.lastResolveDetail = detail;
            return {
                ok: true, win, matchedBy: name, candidateCount: list.length,
                sameTitleCount, multiHit, detail,
            };
        }
        if (hit.length > 1) {
            const liveHit = hit.filter((w) => !w.iconic);
            if (liveHit.length === 1) {
                const win = liveHit[0];
                // 候选里还有最小化影子：仍算「多命中」（可观测），但选非最小化的那个。
                CONTROL_STATS.resolveMultiHit += 1;
                const detail = '多命中 ' + list.length + ' 个，选 hwnd=' + win.hwnd + '（' + win.title + '；其余是最小化影子）';
                CONTROL_STATS.lastResolveDetail = detail;
                return { ok: true, win, matchedBy: name, candidateCount: list.length, sameTitleCount: hit.length, multiHit: true, detail };
            }
            if (liveHit.length === 0 && hit.every((w) => w.iconic)) {
                CONTROL_STATS.resolveFailed += 1;
                return {
                    ok: false, code: 'MINIMIZED', candidates: hit, candidateCount: hit.length, multiHit: true,
                    error: '窗口解析失败：匹配到的窗口都已最小化（' + hit.length + ' 个）—— 先还原窗口再试',
                };
            }
            CONTROL_STATS.resolveFailed += 1;
            CONTROL_STATS.resolveMultiHit += 1;
            const detail = '「' + want + '」在「' + name + '」层命中 ' + hit.length + ' 个：' + _candidateList(hit);
            CONTROL_STATS.lastResolveDetail = detail;
            return {
                ok: false, code: 'AMBIGUOUS', candidates: hit, candidateCount: hit.length, multiHit: true,
                error: '窗口解析失败：' + detail + ' —— 有歧义，不猜。请改传完整标题或 hwnd',
            };
        }
    }
    CONTROL_STATS.resolveFailed += 1;
    return {
        ok: false, code: 'NOT_FOUND', candidates: [], candidateCount: 0, multiHit: false,
        error: '窗口解析失败：没找到窗口（没有标题匹配「' + want + '」的可见窗口；先 list_windows / see windows 确认）',
    };
}

/**
 * **唯一窗口解析入口**（2026-11-21 审计 P2）。
 *
 * focus_window / window_op / batch 钉窗 / post_keys / WGC 抓帧 进入后端前都必须先过这里，
 * 后端只拿 hwnd —— 不允许各层再按标题找一次（那样同名窗口会各选各的）。
 *
 * 解析顺序：纯数字先按 hwnd（IsWindow 已验证：windows 清单里存在）→ 再按 pid；
 * 标题按子串匹配后走 pickWindowForTarget 打分。
 * 失败是**明确失败**（ok:false + error），绝不回落成「取第一个」。
 *
 * @returns {{ok:true,hwnd:number,title:string,pid:number,iconic:boolean,rect:object,via:string,
 *            multiHit:boolean,candidateCount:number,sameTitleCount:number,detail:string}
 *          |{ok:false,error:string,multiHit:boolean,candidateCount:number}}
 */
async function resolveTargetHwnd(titleOrHwnd) {
    const arg = String(titleOrHwnd == null ? '' : titleOrHwnd).trim();
    if (!arg) {
        CONTROL_STATS.resolveFailed += 1;
        return { ok: false, error: '窗口解析失败：目标为空（需要标题子串 / hwnd / pid）', multiHit: false, candidateCount: 0 };
    }
    if (/^\d+$/.test(arg)) {
        const wins = await coreWindows('', 400);
        if (!wins) {
            CONTROL_STATS.resolveFailed += 1;
            return { ok: false, error: '窗口解析失败：pet-core 不可用，无法验证 hwnd/pid=' + arg, multiHit: false, candidateCount: 0 };
        }
        const byHwnd = wins.find((w) => Number(w.hwnd) === Number(arg));
        if (byHwnd) {
            const info = _normWin(byHwnd, 'hwnd');
            const detail = 'hwnd=' + info.hwnd + '（' + info.title + '）';
            CONTROL_STATS.lastResolveDetail = detail;
            return Object.assign({ ok: true, via: 'hwnd', multiHit: false, candidateCount: 1, sameTitleCount: 1, detail }, info);
        }
        const same = wins.filter((w) => Number(w.pid) === Number(arg) && String(w.title || '').trim());
        if (!same.length) {
            CONTROL_STATS.resolveFailed += 1;
            return {
                ok: false, multiHit: false, candidateCount: 0,
                error: '窗口解析失败：' + arg + ' 既不是有效 hwnd，也没有 pid=' + arg + ' 的可见窗口',
            };
        }
        const pk = pickWindowForTarget(same, '');
        if (!pk.ok) return pk;
        const info = _normWin(pk.win, 'pid');
        return Object.assign({ ok: true, via: 'pid', multiHit: pk.multiHit, candidateCount: pk.candidateCount, sameTitleCount: pk.sameTitleCount, detail: pk.detail }, info);
    }
    // 2026-11-25 P1-2：先取全量窗口，再在 JS 侧走唯一 matcher。
    // 旧实现交给 pet-core 按子串过滤（title.includes(needle)），过滤完再打分挑最高分 ——
    // 于是 see 能和「QQ音乐」对上、绑定层却对不上。现在过滤与判定都在 matcher 里。
    const wins = await coreWindows('', 400);
    if (!wins) {
        CONTROL_STATS.resolveFailed += 1;
        return {
            ok: false, code: 'CORE_UNAVAILABLE', multiHit: false, candidateCount: 0, candidates: [],
            error: '窗口解析失败：pet-core 不可用，无法枚举窗口（确认 pet-core 已构建/在跑）',
        };
    }
    const pk = pickWindowForTarget(wins, arg);
    if (!pk.ok) return pk;
    const info = _normWin(pk.win, 'title');
    return Object.assign({ ok: true, via: 'title', multiHit: pk.multiHit, candidateCount: pk.candidateCount, sameTitleCount: pk.sameTitleCount, detail: pk.detail, matchedBy: pk.matchedBy }, info);
}

/**
 * 标题子串 / pid / hwnd → 结构化窗口信息。找不到返回 null。
 * 保留旧签名（大量调用点依赖）；解析本身已统一到 resolveTargetHwnd。
 */
async function resolveWindowInfo(titleOrPid) {
    const rz = await resolveTargetHwnd(titleOrPid);
    if (!rz || rz.ok === false) return null;
    return Object.assign({}, rz, { by: rz.via });
}

/**
 * snapshot / som_snapshot 的「空目标」解析（2026-11-21 P1 根因修）。
 *
 * 原缺陷：arg/focus 都为空时把 title='' 发给 UIA 服务 → WinEnum.FindAll('') +
 * PickBest（没有「前台」概念）→ 返回枚举顺序里第一个窗口。实测前台是 Notepad
 * (hwnd 8393794)，服务返回「设置」(hwnd 9505532)。
 *
 * 语义：空目标 = **前台窗口**（调用方不用再猜），所以先在 JS 侧解析成真实
 * hwnd/title，再带着 hwnd 调服务（hwnd 是唯一无歧义的身份，PS 侧已支持）。
 * 只改这一处，不动 uia-service.ps1 的空标题语义（避免双重语义）。
 *
 * 纯函数（无 IO），_probe/test-click-guard.cjs 可直接断言。
 * @param {string} arg      动作 arg
 * @param {string} focus    动作 focus
 * @param {{hwnd?:number,title?:string,pid?:number,via?:string}|null} fg getForegroundInfo() 结果
 * @returns {{ok:true,target:string,hwnd:number,pid:number,fromForeground:boolean,via:string}|{ok:false,error:string}}
 */
function pickSnapshotTarget(arg, focus, fg) {
    const explicit = String(arg || '').trim() || String(focus || '').trim();
    if (explicit) return { ok: true, target: explicit, hwnd: 0, pid: 0, fromForeground: false, via: 'explicit' };
    const hwnd = Number(fg && fg.hwnd) || 0;
    const title = String((fg && fg.title) || '').trim();
    if (!hwnd && !title) {
        return { ok: false, error: '没给窗口标题，也读不到当前前台窗口（pet-core / UIA 服务 / pwsh 三条通道都失败）——为了不扫错窗口，这次不发请求' };
    }
    return {
        ok: true, target: title, hwnd, pid: Number(fg && fg.pid) || 0,
        fromForeground: true, via: String((fg && fg.via) || 'fg'),
    };
}

// ── P0-1：自动 focus 重试（只在 vetoCode=1001 时触发，最多 1 次）────────// 会因「前台被占」而在**发输入之前**被拒的动作。1001 的语义就是 action_sent:false，
// 所以重发一次不会做两遍（这是能做自动重试的前提，别把这集合扩到会部分生效的动作）。
const AUTO_FOCUS_ACTIONS = new Set([
    'click_at', 'click_element', 'click_text', 'mouse', 'drag', 'scroll',
    'press_key', 'hold_key', 'type_text', 'paste', 'set_value', 'perform_action',
]);

/** 同 pid 找任一可见窗口 focus 一次；优先目标窗口本身，其次同 pid 非最小化窗口。 */
async function autoFocusTarget(opts) {
    const o = opts || {};
    let pid = Number(o.targetPid) || 0;
    let preferred = null;
    if (o.focus) {
        preferred = await resolveWindowInfo(o.focus);
        if (!pid && preferred) pid = preferred.pid;
    }
    if (!pid && o.res && Number(o.res.targetPid)) pid = Number(o.res.targetPid);
    // 2026-11-21 审计（P1）：snapshotPid 只在「目标就是快照窗口」时才用。
    // 原实现无条件兜底：focus 解析不到（targetPid=0）时会拿上一次 snapshot 的 pid，
    // 实测把「聚焦记事本」变成了「聚焦计算器」（还把 autoFocusEvidence 记成成功）。
    if (!pid && o.snapshotPid) {
        const snapTitle = String((UIA_SNAPSHOT_STATE && UIA_SNAPSHOT_STATE.title) || '').toLowerCase();
        const want = String(o.focus || '').toLowerCase();
        if (!want || (snapTitle && (snapTitle.includes(want) || want.includes(snapTitle)))) {
            pid = Number(o.snapshotPid) || 0;
        }
    }
    if (!pid) return { ok: false, error: '不知道目标进程 pid，无法自动 focus' };
    const wins = (await coreWindows('', 400)) || [];
    const pool = wins
        .filter((w) => Number(w.pid) === pid && String(w.title || '').trim())
        .map((w) => _normWin(w, 'pid'));
    if (!pool.length) return { ok: false, pid, error: 'pid ' + pid + ' 没有可见窗口' };
    const live = pool.filter((w) => !w.iconic);
    const usable = live.length ? live : pool;
    const target = (preferred && usable.find((w) => Number(w.hwnd) === Number(preferred.hwnd)))
        || pickBestWindow(usable, o.focus || '');
    if (!target) return { ok: false, pid, error: 'pid ' + pid + ' 没有可用窗口' };
    const fw = await focusWindow(String(target.hwnd), { force: false });
    await _uiaSleep(260);
    const fg = await getForegroundInfo();
    // 精确到 hwnd：同 pid 的兄弟窗口不算「聚焦成功」——重试会把输入送到另一个窗口。
    const matched = !!(fg && Number(fg.hwnd) === Number(target.hwnd));
    return {
        ok: matched,
        verified: matched,
        pid,
        hwnd: target.hwnd,
        title: target.title,
        fgTitle: fg ? String(fg.title || '') : '',
        fgPid: fg ? Number(fg.pid) || 0 : 0,
        focusOk: !!(fw && fw.ok),
        focusError: fw && fw.error ? String(fw.error).slice(0, 160) : '',
        error: matched ? '' : '聚焦后复核仍不是目标窗口（' + (fg ? String(fg.title || '') : '读不到') + '）',
    };
}

/**
 * 1001 → 同 pid focus 一次 → 重发一次。runOnce(attempt) 返回契约结果。
 * 只重试一次；第二次失败原样返回（带 autoFocus/attempt 留痕，不循环）。
 */
async function withAutoFocusRetry(runOnce, opts) {
    const o = opts || {};
    const res1 = await runOnce(1);
    if (!res1 || res1.vetoCode !== VETO.FOCUS_LOST || o.enabled === false) return res1;
    if (res1.autoFocus === true) return res1;   // 已经在重试里，绝不递归
    const focusFn = o.focusFn || autoFocusTarget;
    let af = null;
    try {
        af = await focusFn({ targetPid: res1.targetPid, focus: o.focus, res: res1, snapshotPid: UIA_SNAPSHOT_STATE.pid });
    } catch (e) { af = { ok: false, error: String(e && e.message || e) }; }
    const firstAttempt = {
        vetoCode: res1.vetoCode,
        detail: String(res1.detail || '').slice(0, 200),
        fgPid: res1.fgPid,
        targetPid: res1.targetPid,
    };
    if (!af || !af.ok) {
        return Object.assign({}, res1, {
            autoFocus: false, autoFocusAttempted: true, firstAttempt,
            autoFocusError: af && af.error ? af.error : '自动 focus 失败',
        });
    }
    const res2 = await runOnce(2);
    const out = Object.assign({}, res2 || {}, {
        autoFocus: true, attempt: 2, firstAttempt,
        autoFocusEvidence: {
            pid: af.pid, hwnd: af.hwnd, title: af.title,
            fgTitle: af.fgTitle, fgPid: af.fgPid,
        },
    });
    if (res2 && res2.vetoCode === VETO.FOCUS_LOST) {
        out.stillNotFocused = true;
        out.nextIfFailed = '已自动 focus 同进程窗口（' + (af.title || af.hwnd) + '）重试一次，仍不是前台；' +
            '目标可能被全屏置顶窗口压住，先挪开遮挡再试';
    } else if (res2 && res2.ok !== false) {
        out.detail = String(res2.detail || '') + '（首次因前台被占被拒，已自动把目标进程窗口调到前台并重试成功）';
    }
    return out;
}

// ── P0-3：元素动作三级回落计划（纯函数，单测直接打）────────────────────
/**
 * 按 UIA 模式能力排出回落顺序：Invoke → Toggle → SelectionItem.Select → 坐标。
 * 坐标永远兜底（物理矩形中心交 pet-core）；没有 Invoke/Toggle/Select 时只剩坐标。
 * PS 侧按同一顺序尝试，JS 用这份计划判定「这一档能不能算成功」。
 */
function elementFallbackPlan(el) {
    const acts = String((el && el.actions) || '').toLowerCase();
    const has = (n) => new RegExp('(^|,)' + n + '(,|$)').test(acts);
    const plan = [];
    if (has('invoke')) plan.push('invoke');
    if (has('toggle')) plan.push('toggle');
    if (has('selectionitem')) plan.push('select');
    plan.push('coord');
    return plan;
}

// ── P1-5：对话框控件类型补全（只改类型字段）────────────────────────────
/**
 * #32770 对话框里 UIA 常把按钮报成 pane。按「动作能力」重新归类：
 *   pane + invoke/toggle/selectionitem/legacy → button
 *   pane + value 且非只读                  → edit
 *   edit/document + value                  → edit
 * 实测补充（2026-11-21）：经典 Shell 文件对话框的「选择文件夹」「取消」是**无任何 Pattern
 * 的叶子 pane**（.NET 4.8 连 LegacyIAccessible 都不暴露）。它们确实是按钮，只能靠
 * 「叶子 + 可见 + 启用 + 非标签名（不以冒号结尾）」识别 —— 这条启发式**只在 #32770 里生效**。
 * 只影响 see tree / snapshot 的 type 字段，不改元素集合与 rid。
 */
function classifyDialogElement(el, windowClass) {
    if (!el) return el;
    if (!/#32770/i.test(String(windowClass || ''))) return el;
    const type = String(el.type || '').toLowerCase();
    const acts = String(el.actions || '').toLowerCase();
    const has = (n) => new RegExp('(^|,)' + n + '(,|$)').test(acts);
    const actionable = has('invoke') || has('toggle') || has('selectionitem') || has('legacy');
    const editable = has('value') && el.readonly !== true;
    if (type === 'pane') {
        if (actionable) return Object.assign({}, el, { type: 'button', reclassifiedFrom: 'pane' });
        if (editable) return Object.assign({}, el, { type: 'edit', reclassifiedFrom: 'pane' });
        const nm = String(el.name || '').trim();
        const w = Number(el.w), h = Number(el.h);
        const leafButton = el.kids === 0
            && !has('value')   // 有 ValuePattern 的是输入框（含只读），不是按钮
            && el.enabled !== false && el.offscreen !== true
            && !!nm && !/[:：]$/.test(nm)
            && Number.isFinite(w) && w >= 10 && w <= 600
            && Number.isFinite(h) && h >= 10 && h <= 80;
        if (leafButton) {
            return Object.assign({}, el, { type: 'button', reclassifiedFrom: 'pane', reclassifiedBy: 'dialog-leaf' });
        }
    }
    if ((type === 'document' || type === 'pane') && editable) {
        return Object.assign({}, el, { type: 'edit', reclassifiedFrom: type });
    }
    return el;
}

// ── P1-7：可见性闸（纯函数）─────────────────────────────────────────────
/** IsOffscreen=false && IsEnabled=true 才放行；否则 element_unavailable（不盲点）。 */
function gateElementState(state) {
    const s = state || {};
    if (s.found === false) {
        return { ok: false, code: 'stale', reason: '元素已失效（窗口内容变过）——重新 snapshot 拿新编号' };
    }
    if (s.enabled === false) {
        return { ok: false, code: 'element_unavailable', reason: '元素被禁用（IsEnabled=false）——不发盲点' };
    }
    if (s.offscreen === true) {
        return {
            ok: false, code: 'element_unavailable',
            reason: '元素不在可视区（IsOffscreen=true）' + (s.scrolled ? '，ScrollIntoView 后仍在屏外' : ''),
        };
    }
    return { ok: true };
}

// ── P1-6：等 UIA 树稳定（连续两次哈希相同，最多等 maxWaitMs）───────────
/**
 * sampler(title) 默认 uiaTreeSignature。第一次采样必要时可慢（UIA 几百 ms），
 * 之后最多再等 maxWaitMs；至少采两次。stable=null 表示拿不到签名（不可验证）。
 */
async function waitUiStable(opts) {
    const o = opts || {};
    const title = String(o.title || '').trim();
    const sampler = typeof o.sampler === 'function' ? o.sampler : (t) => uiaTreeSignature(t);
    const maxWaitMs = Number.isFinite(Number(o.maxWaitMs)) ? Number(o.maxWaitMs) : 400;
    const intervalMs = Number.isFinite(Number(o.intervalMs)) ? Number(o.intervalMs) : 120;
    if (!title) return { stable: null, samples: 0, hash: null, ms: 0, reason: 'no-target' };
    const t0 = Date.now();
    let prev = await sampler(title);
    if (!prev) return { stable: null, samples: 0, hash: null, ms: Date.now() - t0, reason: 'no-signature' };
    let samples = 1;
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
        await _uiaSleep(intervalMs);
        const next = await sampler(title);
        if (!next) {
            return { stable: null, samples, hash: prev, ms: Date.now() - t0, reason: 'sample-failed' };
        }
        samples += 1;
        if (next === prev) return { stable: true, samples, hash: next, ms: Date.now() - t0 };
        prev = next;
        if (Date.now() >= deadline || samples >= 3) {
            return { stable: false, samples, hash: prev, ms: Date.now() - t0 };
        }
    }
}

// ── P2-8：名称归一 + 三级匹配 ───────────────────────────────────────────
const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const ACCEL_RE = /\(&[^)]{1,4}\)/g;

/** 去零宽字符、全半角归一（NFKC 不可用时手写映射）。 */
function stripInvisible(s) {
    return String(s == null ? '' : s).replace(ZERO_WIDTH_RE, '');
}
function toHalfWidth(s) {
    let out = String(s == null ? '' : s);
    try { out = out.normalize('NFKC'); } catch (e) { /* 老 Node 没有 normalize */ }
    out = out.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    return out.replace(/\u3000/g, ' ');
}
/** 名称归一：零宽 → 全半角 → 去 (&H) 快捷键后缀 → 折叠空白 → 小写。 */
function normalizeUiName(s) {
    return toHalfWidth(stripInvisible(s))
        .replace(ACCEL_RE, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}
/** 只去快捷键后缀（保留其余字符），用于「去后缀」这一级。 */
function stripAccelSuffix(s) {
    return toHalfWidth(stripInvisible(s))
        .replace(ACCEL_RE, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** 只做「可见字符归一」（不拆快捷键后缀）：精确级要用它，否则「保存」会误中「保存(&S)」。 */
function rawUiName(s) {
    return toHalfWidth(stripInvisible(s)).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 三级匹配：精确 → 去快捷键后缀 → 包含。命中多个 → ambiguous（不猜）。
 * 「精确」= 归一后（零宽/全半角/空白/大小写）逐字相等，仍保留 (&H) 后缀；
 * 「去后缀」= 两边都拆掉 (&H) 后相等；「包含」= 子串。
 * @param {Array} items 元素（至少含 name）
 * @param {string} query
 * @returns {{tier:string|null, hits:Array, ambiguous:boolean, unique:object|null}}
 */
function matchUiNames(items, query) {
    const list = Array.isArray(items) ? items : [];
    const qRaw = rawUiName(query);
    const qBare = rawUiName(stripAccelSuffix(query));
    const tiers = { exact: [], desuffix: [], contains: [] };
    for (const it of list) {
        const name = String((it && it.name) || '');
        if (!name.trim()) continue;
        const nRaw = rawUiName(name);
        const nBare = rawUiName(stripAccelSuffix(name));
        if (qRaw && nRaw === qRaw) tiers.exact.push(it);
        else if (qBare && nBare === qBare) tiers.desuffix.push(it);
        else if (qBare && (nRaw.includes(qRaw) || nBare.includes(qBare))) tiers.contains.push(it);
    }
    for (const tier of ['exact', 'desuffix', 'contains']) {
        if (tiers[tier].length) {
            return {
                tier,
                hits: tiers[tier],
                ambiguous: tiers[tier].length > 1,
                unique: tiers[tier].length === 1 ? tiers[tier][0] : null,
            };
        }
    }
    return { tier: null, hits: [], ambiguous: false, unique: null };
}

// ── P2-9：可选 verify（UIA 摘要前后对比，语义沿用 verify-contract）──────
async function uiSummaryFor(target) {
    const t0 = Date.now();
    let win = null;
    try { win = await resolveWindowInfo(target); } catch (e) { win = null; }
    const title = win ? win.title : String(target || '');
    let sig = null;
    if (title) { try { sig = await uiaTreeSignature(title); } catch (e) { sig = null; } }
    const fg = await getForegroundInfo();
    const snapItem = (UIA_SNAPSHOT_STATE.items || [])[0];
    return {
        at: t0,
        title,
        sig,
        fgTitle: fg ? String(fg.title || '') : '',
        fgPid: fg ? Number(fg.pid) || 0 : 0,
        element: snapItem ? { name: String(snapItem.name || ''), type: String(snapItem.type || '') } : null,
        ok: !!(title || sig),
        ms: Date.now() - t0,
    };
}

/**
 * 把 UIA 摘要前后对比写成契约字段（增强，不另造一套）：
 *   有变化 → confirmed；无变化 → suspected_noop；采不到 → 保留原 effect，标 unverifiable。
 * not_sent / readonly 永远不覆盖（没发出去的动作谈不上「界面变了」）。
 */
function applyUiVerify(result, before, after) {
    const out = Object.assign({}, result || {});
    const b = before || {};
    const a = after || {};
    const captureOk = !!(b.ok && a.ok);
    out.verifyUi = {
        captureOk,
        before: { title: String(b.title || ''), sig: b.sig || null },
        after: { title: String(a.title || ''), sig: a.sig || null },
        targetElement: b.element || null,
    };
    if (!captureOk) {
        out.verifyEffect = 'unverifiable';
        out.verifyUi.reason = 'UIA 摘要采不到（窗口无 UIA 树或目标未解析）';
        return out;
    }
    const changed = String(b.sig || '') !== String(a.sig || '')
        || String(b.title || '') !== String(a.title || '');
    out.verifyUi.changed = changed;
    if (out.effect === 'not_sent' || out.effect === 'readonly') {
        out.verifyEffect = out.effect;
        return out;
    }
    if (changed) {
        out.ok = true;
        out.verified = true;
        out.unverified = false;
        out.effect = 'confirmed';
        if (out.action_sent === undefined) out.action_sent = true;
        out.evidence = 'UIA 摘要变化：' + (b.sig || '?') + ' → ' + (a.sig || '?')
            + (String(b.title || '') !== String(a.title || '') ? '；窗口标题「' + b.title + '」→「' + a.title + '」' : '');
        out.verifyEffect = 'confirmed';
    } else {
        out.ok = false;
        out.verified = true;
        out.unverified = false;
        out.effect = 'suspected_noop';
        if (out.action_sent === undefined) out.action_sent = true;
        out.evidence = 'UIA 摘要前后一致（' + (a.sig || a.title || '?') + '）——界面没有可见变化';
        out.verifyEffect = 'suspected_noop';
        out.nextIfFailed = out.nextIfFailed
            || 'verify：UIA 摘要没变。先 snapshot 确认现场；纯输入框内部文本不在名称摘要里，可改用 get_value 回读';
    }
    return out;
}

// ── P0-3 / P1-5 / P1-7：UIA 元素探测与动作（powershell 5.1，零 SetCursorPos）──
/**
 * 在一个窗口里按 rid 找元素，输出动作能力与可见性；mode=act 时按
 * Invoke → Toggle → SelectionItem.Select 顺序尝试（坐标回落由 JS 交给 pet-core）。
 * 返回：{ok, found, how, actions, offscreen, enabled, scrolled, readonly, x,y,rx,ry,rw,rh,pid,name,type,error}
 */
function uiaElementScript(title, targetRid, hwnd) {
    const escTitle = String(title || '').replace(/'/g, "''").toLowerCase();
    const escRid = String(targetRid || '').replace(/'/g, "''");
    const hwndNum = Math.max(0, Number(hwnd) || 0);
    return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class _PetDpi3 { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][_PetDpi3]::SetProcessDPIAware()
Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::RootElement
$roots = New-Object System.Collections.ArrayList
$hw = ${hwndNum}
if ($hw -gt 0) {
  try {
    $we = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hw)
    if ($null -ne $we) { [void]$roots.Add($we) }
  } catch { }
}
if ($roots.Count -eq 0) {
  $tops = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $tops) {
    if ("$($w.Current.Name)".ToLower().Contains('${escTitle}')) { [void]$roots.Add($w) }
  }
}
$wantRid = '${escRid}'
$goal = $null
$seen = 0
foreach ($w in $roots) {
  $stack = New-Object System.Collections.Stack
  $stack.Push(@($w, 0))
  while ($stack.Count -gt 0 -and ($null -eq $goal) -and $seen -lt 4000) {
    $cur = $stack.Pop(); $el = $cur[0]; $depth = $cur[1]
    $seen += 1
    try {
      $rid = [int[]]$el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::RuntimeIdProperty)
      if (($rid -join '-') -eq $wantRid) { $goal = $el; break }
      if ($depth -lt 8) {
        $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($k in $kids) { $stack.Push(@($k, $depth + 1)) }
      }
    } catch { }
  }
  if ($null -ne $goal) { break }
}
$res = @{ ok = $false; found = $false; how = 'none'; actions = ''; offscreen = $false; enabled = $false; scrolled = $false; readonly = $false; name = ''; type = ''; x = 0; y = 0; rx = 0; ry = 0; rw = 0; rh = 0; pid = 0; error = 'no-target' }
if ($null -ne $goal) {
  $res.found = $true
  $res.name = "$($goal.Current.Name)".Trim()
  $res.type = ($goal.Current.ControlType.ProgrammaticName -replace '^ControlType\\.', '').ToLower()
  $res.pid = $goal.Current.ProcessId
  $acts = @()
  $inv = $null; if ($goal.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) { $acts += 'invoke' }
  $tog = $null; if ($goal.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tog)) { $acts += 'toggle' }
  $sel = $null; if ($goal.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) { $acts += 'selectionitem' }
  $val = $null; if ($goal.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$val)) { $acts += 'value' }
  $scr = $null; if ($goal.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scr)) { $acts += 'scrollitem' }
  $res.actions = ($acts -join ',')
  if ($null -ne $val) { $res.readonly = ($val.CurrentIsReadOnly -eq $true) }
  if (($goal.Current.IsOffscreen -eq $true) -and ($null -ne $scr)) {
    try { $scr.ScrollIntoView(); $res.scrolled = $true; Start-Sleep -Milliseconds 160 } catch { }
  }
  $res.offscreen = ($goal.Current.IsOffscreen -eq $true)
  $res.enabled = ($goal.Current.IsEnabled -eq $true)
  $r = $goal.Current.BoundingRectangle
  $res.x = [int]($r.X + $r.Width / 2); $res.y = [int]($r.Y + $r.Height / 2)
  $res.rx = [int]$r.X; $res.ry = [int]$r.Y; $res.rw = [int]$r.Width; $res.rh = [int]$r.Height
  if ($res.offscreen -eq $true) { $res.error = 'element_unavailable: offscreen' }
  elseif ($res.enabled -ne $true) { $res.error = 'element_unavailable: disabled' }
  elseif ($null -ne $inv) {
    try { $inv.Invoke(); $res.ok = $true; $res.how = 'invoke'; $res.error = '' }
    catch { $res.error = "Invoke failed: $($_.Exception.Message)" }
  }
  if (($res.ok -ne $true) -and ($null -ne $tog)) {
    try { $tog.Toggle(); $res.ok = $true; $res.how = 'toggle'; $res.error = '' }
    catch { $res.error = "Toggle failed: $($_.Exception.Message)" }
  }
  if (($res.ok -ne $true) -and ($null -ne $sel)) {
    try { $sel.Select(); $res.ok = $true; $res.how = 'select'; $res.error = '' }
    catch { $res.error = "Select failed: $($_.Exception.Message)" }
  }
}
$json = $res | ConvertTo-Json -Compress
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
`;
}

async function uiaElementAction(title, rid, timeoutMs, hwnd, guard) {
    // UIA Invoke 原语的第一件事：统一守卫（2026-11-21 P0）。
    // 不走 click_element 的调用路径（比如 click_text 的 UIA 命中）也绕不过去。
    await assertClickGuard(guard);
    const r = await runPs51(uiaElementScript(title, rid, hwnd), timeoutMs || 12000);
    const raw = String((r && r.out) || '').trim();
    if (!raw) return { ok: false, found: false, error: String((r && r.error) || 'UIA 元素动作没有输出') };
    try {
        const d = JSON.parse(Buffer.from(raw.split(/\s+/)[0], 'base64').toString('utf8'));
        return d && typeof d === 'object' ? d : { ok: false, found: false, error: '空结果' };
    } catch (e) {
        return { ok: false, found: false, error: '输出解析失败：' + raw.slice(0, 60) };
    }
}

/** 扫描一个窗口的全部元素（带动作能力），给 #32770 对话框类型补全用。 */
function uiaScanScript(title, max, hwnd) {
    const escTitle = String(title || '').replace(/'/g, "''").toLowerCase();
    const cap = Math.max(1, Math.min(120, Number(max) || 80));
    const hwndNum = Math.max(0, Number(hwnd) || 0);
    return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class _PetDpi4 { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][_PetDpi4]::SetProcessDPIAware()
Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::RootElement
$roots = New-Object System.Collections.ArrayList
$hw = ${hwndNum}
if ($hw -gt 0) {
  try {
    $we = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hw)
    if ($null -ne $we) { [void]$roots.Add($we) }
  } catch { }
}
if ($roots.Count -eq 0) {
  $tops = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $tops) {
    if ("$($w.Current.Name)".ToLower().Contains('${escTitle}')) { [void]$roots.Add($w) }
  }
}
$out = New-Object System.Collections.ArrayList
$seen = 0
foreach ($w in $roots) {
  $stack = New-Object System.Collections.Stack
  $stack.Push(@($w, 0))
  while ($stack.Count -gt 0 -and $out.Count -lt ${cap} -and $seen -lt 4000) {
    $cur = $stack.Pop(); $el = $cur[0]; $depth = $cur[1]
    $seen += 1
    try {
      $rid = [int[]]$el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::RuntimeIdProperty)
      $pn = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\\.', ''
      $acts = @()
      $inv = $null; if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) { $acts += 'invoke' }
      $tog = $null; if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tog)) { $acts += 'toggle' }
      $sel = $null; if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) { $acts += 'selectionitem' }
      $val = $null; if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$val)) { $acts += 'value' }
      $ro = $false; if ($null -ne $val) { $ro = ($val.CurrentIsReadOnly -eq $true) }
      $kidsN = 0
      try { $kidsN = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition).Count } catch { }
      $rr = $el.Current.BoundingRectangle
      [void]$out.Add(@{ rid = ($rid -join '-'); type = $pn.ToLower(); name = "$($el.Current.Name)".Trim(); actions = ($acts -join ','); readonly = $ro; offscreen = ($el.Current.IsOffscreen -eq $true); enabled = ($el.Current.IsEnabled -eq $true); kids = $kidsN; w = [int]$rr.Width; h = [int]$rr.Height })
      if ($depth -lt 8) {
        $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($k in $kids) { $stack.Push(@($k, $depth + 1)) }
      }
    } catch { }
  }
  if ($out.Count -gt 0) { break }
}
$json = ConvertTo-Json -InputObject @($out) -Compress
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
`;
}

async function uiaScan(title, max, hwnd) {
    const r = await runPs51(uiaScanScript(title, max, hwnd), 15000);
    const raw = String((r && r.out) || '').trim();
    if (!raw) return { ok: false, items: [], error: String((r && r.error) || '扫描没有输出') };
    try {
        const parsed = JSON.parse(Buffer.from(raw.split(/\s+/)[0], 'base64').toString('utf8'));
        const items = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        return { ok: items.length > 0, items };
    } catch (e) {
        return { ok: false, items: [], error: '输出解析失败：' + raw.slice(0, 60) };
    }
}

// UIA 控件树找字（拍板：UIA 优先+OCR 兜底）。走 powershell.exe 5.1——.NET Framework 的
// GAC 原生带 UIAutomationClient，零安装（pwsh7 引用链坑见 docs/研究-电脑操控升级路径-2026-11-08.md）。
// 桌面级按 Name 找含关键词的元素→BoundingRectangle 中心。深度限 4 层、命中即收，防大树卡死。
function uiaFindText(keyword, timeoutMs = 6000) {
    const esc = String(keyword).replace(/'/g, "''");
    // ⚠ 2026-11-09 三十六轮修两个真 bug（都让中文界面「找得到但点不到」）：
    //   ① 编码：powershell 5.1 的 stdout 走系统代码页（本机 GBK/CP936），
    //      `ConvertTo-Json` 出来的中文到 Node 侧按 UTF-8 解就是乱码
    //      （实测控件名变成 `���������˵� + һ�����`）。乱码进不了日志、也没法核对。
    //      修法：**PS 侧把 JSON 转 UTF-8 再 Base64**，Node 侧 base64 解回 UTF-8
    //      —— 整条通道只走 ASCII，编码问题从根上消失。
    //   ② DPI：powershell 5.1 默认 **DPI-unaware**，UIA 的 BoundingRectangle 返回**逻辑坐标**；
    //      2560×1440@150% 的屏上要 ×1.333 才是物理坐标（SendInput/SetCursorPos 要的）。
    //      不换算 → 「找到了」但点在错位置（实测点了 (737,1128)，弹窗其实在 ~(1269,980)）。
    //      修法：脚本开头自己 SetProcessDPIAware()，UIA 直接吐物理坐标。
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class _DpiFix { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][_DpiFix]::SetProcessDPIAware()
Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::RootElement
$hits = New-Object System.Collections.ArrayList
$tops = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($w in $tops) {
    $stack = New-Object System.Collections.Stack
    $stack.Push(@($w, 0))
    while ($stack.Count -gt 0 -and $hits.Count -lt 5) {
        $cur = $stack.Pop(); $el = $cur[0]; $depth = $cur[1]
        $name = $el.Current.Name
        if ($name -and $name.Contains('${esc}')) {
            $r = $el.Current.BoundingRectangle
            if ($r.Width -gt 1 -and $r.Height -gt 1) {
                $rid = [int[]]$el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::RuntimeIdProperty)
                [void]$hits.Add(@{ name = $name; x = [int]($r.X + $r.Width / 2); y = [int]($r.Y + $r.Height / 2); pid = $el.Current.ProcessId; rid = [string]::Join('-', $rid); type = (($el.Current.ControlType.ProgrammaticName -replace '^ControlType\\.', '').ToLower()); offscreen = ($el.Current.IsOffscreen -eq $true); enabled = ($el.Current.IsEnabled -eq $true) })
            }
        }
        if ($depth -lt 4) {
            $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($k in $kids) { $stack.Push(@($k, $depth + 1)) }
        }
    }
    if ($hits.Count -ge 3) { break }
}
if ($hits.Count -gt 0) { $json = $hits | ConvertTo-Json -Compress } else { $json = '{"found":false}' }
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
`;
    return new Promise((resolve) => {
        const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
        let out = '';
        child.stdout.on('data', (c) => { out += c; });
        child.on('error', () => resolve({ found: false }));
        child.on('close', () => {
            try {
                // PS 侧输出的是 UTF-8 的 Base64（见上面 ① 的说明）
                const raw = String(out || '').trim();
                const jsonText = raw ? Buffer.from(raw, 'base64').toString('utf8') : '';
                const parsed = JSON.parse(jsonText || '{"found":false}');
                const arr = Array.isArray(parsed) ? parsed : [parsed];
                // P2-8：保留全部命中（最多 5 个），click_text 要做三级匹配 + ambiguous 判定。
                const hits = arr.filter((h) => h && Number.isFinite(Number(h.x)) && Number.isFinite(Number(h.y)))
                    .map((h) => ({
                        name: String(h.name || ''), x: Number(h.x), y: Number(h.y),
                        pid: Number(h.pid) || 0, rid: String(h.rid || ''),
                        type: String(h.type || ''), offscreen: h.offscreen === true,
                        enabled: h.enabled !== false,
                    }));
                const hit = hits[0];
                resolve(hit ? { found: true, name: hit.name, x: hit.x, y: hit.y, pid: hit.pid, rid: hit.rid, hits } : { found: false, hits: [] });
            } catch (e) { resolve({ found: false, rawSample: String(out || '').slice(0, 80) }); }
        });
        setTimeout(() => { try { child.kill(); } catch (e) { try { __silentAudit.audit('game-control.js:139', e); } catch (e2) {} } resolve({ found: false }); }, timeoutMs);
    });
}

/** 在 (x,y) 点一下（SetCursorPos + mouse_event，与 click_at 同一实现，抽出来复用）。 */
// 鼠标角落急停（2026-11-10 三十七轮；四十轮按原型收敛到 4px + 原生目标白名单）：
//   光标停在虚拟屏**左上/左下 4px** 内 → 判定用户在紧急避险，拒绝输入；移开即恢复。
//   右上（关闭按钮）与右下（Peek 桌面）**白名单放行** —— 12px 版本会把最大化窗口的 [X]
//   一起拦掉，等于「防误触」误伤了正常关闭按钮（原型 is_whitelisted_native_target 同口径）。
const CORNER_GUARD = `
$__p = New-Object PetU+POINT; [void][PetU]::GetCursorPos([ref]$__p);
$__l = [PetU]::GetSystemMetrics(76); $__t = [PetU]::GetSystemMetrics(77);
$__w = [PetU]::GetSystemMetrics(78); $__h = [PetU]::GetSystemMetrics(79);
$__r = 4;
$__nearLeft = (($__p.X - $__l) -le $__r);
$__nearTop = (($__p.Y - $__t) -le $__r);
$__nearRight = (((($__l + $__w) - $__p.X)) -le $__r);
$__nearBottom = (((($__t + $__h) - $__p.Y)) -le $__r);
$__inCorner = ($__nearLeft -and $__nearTop) -or ($__nearLeft -and $__nearBottom) -or ($__nearRight -and $__nearTop) -or ($__nearRight -and $__nearBottom);
$__whitelist = ($__nearRight -and $__nearTop) -or ($__nearRight -and $__nearBottom);
if ($__inCorner -and -not $__whitelist) { Write-Output 'EMERGENCY-STOP'; exit 1 }
`;
// ── Rust 鼠标注入（2026-11-10 四十轮续）─────────────────────────────────
// 为什么搬：pwsh 冷启动 200–450ms 是 click/drag 的最大延迟源；pet-core 一条命令
// 里把 UAC 探针 → 4px 急停 → 落点遮挡 → SendInput 全做完，实测 click <100ms（含进程启动）。
// 失败语义：UAC/急停/遮挡是**否决**（直接抛，绝不回落到 pwsh 绕过护栏）；
// 其它错误（二进制缺失等）回落到旧的 pwsh 路径。
async function rustMouse(kind, x, y, x2, y2, durMs, notches, expectTitle, modifiers, axis, restoreCursor) {
    const bin = _coreBin();
    if (!bin) return null;
    // ⚠ 2026-11-14 四十八轮续：从 execFileSync（每次 50ms）改成**常驻客户端**（稳态 1ms）。
    //   实测：一次性 50.3ms/次 → 常驻 6.4ms（首次 55ms，之后 1ms）。
    //   鼠标点击是她的热路径，一次任务动辄十几下 —— 这一项就省下几百毫秒。
    const cli = getCoreClient(bin);
    const req = {
        cmd: 'mouse', kind,
        x2: Number.isFinite(x2) ? Math.round(x2) : 0,
        y2: Number.isFinite(y2) ? Math.round(y2) : 0,
        durationMs: Number.isFinite(durMs) ? Math.round(durMs) : 0,
        notches: Number.isFinite(notches) ? Math.round(notches) : 0,
        expectTitle: String(expectTitle || ''),
    };
    // ⚠ 坐标**可选**（2026-11-14 五十三轮，审计抓到的回归）：
    //   原来无条件垫成 0 —— `scroll down 5` 不带 @x,y 就变成「滚到屏幕 (0,0)」，
    //   而 (0,0) 在极角，会被急停守卫拒掉（EMERGENCY-STOP@0x0）。现在没坐标就不发。
    if (Number.isFinite(x)) req.x = Math.round(x);
    if (Number.isFinite(y)) req.y = Math.round(y);
    if (modifiers) req.modifiers = String(modifiers);
    if (axis) req.axis = String(axis);
    // 2026-11-14 五十三轮（「两个光标」）：动作后把用户光标还回去，
    // 她只留屏幕上的橙色虚拟光标。GUI 动作默认开；游戏路径不走这里。
    if (restoreCursor) req.restoreCursor = true;
    const r = await cli.call(req, 10000);
    // 常驻不可用（spawn 失败/超时）→ 回落一次 execFileSync，保证功能不瘫
    if (r && r.ok === false && /启动失败|管道|退出|二进制不存在|超时/.test(String(r.error || ''))) {
        return cli.callOnce(req, 10000);
    }
    return r;
}

async function tryRustMouse(kind, x, y, x2, y2, durMs, notches, expectTitle, modifiers, axis, restoreCursor) {
    const r = await rustMouse(kind, x, y, x2, y2, durMs, notches, expectTitle, modifiers, axis, restoreCursor);
    if (!r) return null;
    if (r.ok === true) return r;
    const msg = String(r.error || '');
    if (msg.includes('UAC-SECURE-DESKTOP')) {
        throw Object.assign(new Error('UAC 安全桌面正在前台（提权弹窗）——已拒绝 ' + kind), { vetoCode: VETO.EMERGENCY_STOP });
    }
    if (msg.includes('OCCLUDED:')) {
        throw Object.assign(new Error('落点被「' + msg.split('OCCLUDED:')[1].trim() + '」盖住了——已拒绝 ' + kind), { vetoCode: VETO.TARGET_OCCLUDED });
    }
    if (msg.includes('EMERGENCY-STOP')) {
        throw Object.assign(new Error('EMERGENCY-STOP：光标被甩在屏幕角落——已拒绝 ' + kind + '。移开鼠标即恢复。'), { vetoCode: VETO.EMERGENCY_STOP });
    }
    return null;   // 非护栏错误 → 回落 pwsh（例如 pet-core 不存在/被占用）
}

/**
 * 通知操控指示层（主进程的透明 overlay 窗口）。
 *
 * 2026-11-14 四十八轮续：用户要的「她正在操作电脑」的可见反馈 ——
 * 屏幕上出现一个青色圆圈（落点）+ 目标窗口描边 + 一行小标签。
 * overlay 窗口不抢焦点、点击穿透、且 `setContentProtection(true)` 不会进我们自己的截图。
 * 纯 Node 环境（探针脚本/CLI）没有 ipcRenderer —— 静默跳过是正常的，不是失败。
 */
function notifyOverlay(payload) {
    try {
        const { ipcRenderer } = require('electron');
        if (ipcRenderer && typeof ipcRenderer.send === 'function') ipcRenderer.send('pet:overlay', payload);
    } catch (e) { /* 非 Electron 渲染进程 */ }
}

/**
 * 她的**虚拟光标**（2026-11-14 五十三轮，用户明确要求）。
 *
 * 用户要的是「两个光标」：真实鼠标归用户，她的操作在屏幕上用橙色虚拟光标显示。
 * 所以每一条注入路径都要调它 —— 包括**不移动真实光标**的那些（UIA Invoke /
 * PostMessage）：那些动作用户本来完全看不见，虚拟光标就是唯一的可见反馈。
 *
 * @param {number} x 物理像素（屏幕坐标）
 * @param {number} y 物理像素
 * @param {string} label 光标旁的小标签（点「保存」/ 输入 / 按键 w …）
 * @param {number} [ttlMs] 多久没更新就淡出（默认 6s）
 */
let AGENT_POS = { x: 0, y: 0, ts: 0 };
function notifyCursor(x, y, label, ttlMs) {
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    AGENT_POS = { x: px, y: py, ts: Date.now() };
    try {
        const { ipcRenderer } = require('electron');
        if (ipcRenderer && typeof ipcRenderer.send === 'function') {
            ipcRenderer.send('pet:overlay', {
                cursor: { x: px, y: py, label: String(label || '').slice(0, 24) },
                cursorTtl: Math.max(800, Number(ttlMs) || 6000),
            });
        }
    } catch (e) { /* 非 Electron 环境 */ }
}

/**
 * 键盘类动作（打字/按键/按住）没有「落点」——在虚拟光标旁边飘一行小标签。
 * 用户一眼知道「她在打字」而不是「她卡住了」。没有历史位置就落在屏幕左上角。
 */
function notifyKeyTag(text) {
    const has = AGENT_POS.ts > 0 && (Date.now() - AGENT_POS.ts) < 60000;
    const r = UIA_SNAPSHOT_STATE.rect;   // 最近一次 snapshot 的窗口矩形（没拍过快照就是 null）
    const hasRect = !!(r && Number.isFinite(r.x) && Number.isFinite(r.y));
    const px = has ? AGENT_POS.x + 22 : (hasRect ? r.x + 24 : 40);
    const py = has ? AGENT_POS.y + 26 : (hasRect ? r.y + 56 : 40);
    notifyOverlay({ tag: { text: String(text || '按键').slice(0, 40), x: px, y: py }, ttl: 1200 });
    // 没有落点时**不伪造坐标**：她知道目标窗口就把光标放在其标题栏，不知道就不画光标
    // （原来一律丢到屏幕 (40,40) —— 那是假的「她在哪」，比不画更误导）
    if (!has && hasRect) notifyCursor(r.x + 24, r.y + 28, String(text || '按键').slice(0, 20), 4000);
}

/**
 * UIA 语义动作（Invoke / SetValue / SelectText / DoDefaultAction）**不动真实光标**，
 * 用户原本完全看不见她在操作。「虚拟光标 + 标签」就是这些动作的唯一可见反馈。
 * rid → 最近一次 snapshot 里的元素坐标；查不到就退化成标签提示。
 */
function showUiaCursor(rid, label) {
    const r = String(rid || '').trim();
    const it = r ? (UIA_SNAPSHOT_STATE.items || []).find((x) => String(x.rid || '') === r) : null;
    if (it && Number.isFinite(it.x) && Number.isFinite(it.y)) {
        notifyCursor(it.x, it.y, label + '「' + String(it.name || '').slice(0, 12) + '」');
    } else {
        notifyKeyTag(label);
    }
}

/**
 * 按 pid 找它当前那个顶层窗口的标题（2026-11-14 五十三轮）。
 * 为什么需要：`click_text` 的 UIA 命中只带回 pid/坐标/rid，没有窗口标题 ——
 * 而坐标点击必须先断言「那个窗口现在是前台」，否则点到盖在它上面的窗口。
 */
async function titleForPid(pid) {
    if (!pid) return '';
    try {
        const cli = getCoreClient(_coreBin());
        const r = await cli.call({ cmd: 'windows', max: 60 }, 2500);
        const w = (r && r.windows || []).find((x) => Number(x.pid) === Number(pid) && !x.iconic && String(x.title || '').trim());
        return w ? String(w.title) : '';
    } catch (e) { return ''; }
}

async function clickAt(x, y, timeoutMs = 8000, expectTitle = '', modifiers = '', guard = null) {
    // ── 点击原语的第一件事（2026-11-21 根因修 P0）────────────────────────
    // 任何鼠标注入之前先过守卫：破坏性按钮 + 落点在自己窗口里。
    // 以前这段话只挂在 click_element 的调用点，click_text / som_click 直接绕过去了。
    // 2026-11-21 守卫缺省（审计洞 3）：调用点没传 guard 时不能再「整段跳过」——
    //   由原语自己补 {source:'unspecified', name:''}，保证「落点在自己窗口」这道
    //   守卫**始终执行**；破坏性按钮仍按 name 判（空名自然放行）。
    const guardInfo = Object.assign({ source: 'unspecified', name: '' }, guard || {}, { x, y });
    if (!guard) {
        CONTROL_STATS.guardDefaulted += 1;
        try { __silentAudit.audit('game-control:guard-default', 'clickAt 调用点未传 guard，已补 ' + JSON.stringify({ source: guardInfo.source }), { quiet: true }); } catch (e) { /* ignore */ }
    }
    await assertClickGuard(guardInfo);
    // 屏幕指示（描边 + 落点圈），动作前先画出来 —— 用户能看到她在点哪
    notifyOverlay({
        point: { x, y },
        tag: { text: (modifiers ? modifiers + '+' : '') + '点击', x: x + 26, y: y - 36 },
    });
    // 虚拟光标（2026-11-14 五十三轮）：真实光标动作后会被还回用户原位，
    // 屏幕上这只橙色箭头才是「她点在哪」的持久指示。
    notifyCursor(x, y, (modifiers ? modifiers + '+' : '') + '点击');
    // 快轨：Rust 一条命令完成「护栏 + 注入」（restoreCursor：不霸占用户的鼠标）
    const rr = await tryRustMouse('click', x, y, 0, 0, 0, 0, expectTitle, modifiers, '', true);
    if (rr) return { ok: true, out: 'rust-mouse click' + (modifiers ? '+' + modifiers : ''), via: 'rust', us: rr.us, steps: rr.steps, userRestored: rr.restored === true };
    if (modifiers) {
        // 失败路径必须发声：兜底 pwsh 路径不会按修饰键，静默忽略会变成「点了但没多选」
        throw new Error('组合键点击（' + modifiers + '）需要 Rust 内核；当前 pet-core 不可用，已拒绝而不是退化成裸点击');
    }
    // pwsh 兜底也做同样的「保存 → 点 → 还回」（原来只点不还，用户鼠标会被抢走）
    return runPs(`${PS_SIG} ${psUacGuard()} ${psOcclusionGuard(x, y, expectTitle)} ${CORNER_GUARD} $__op = New-Object PetU+POINT; [void][PetU]::GetCursorPos([ref]$__op); [PetU]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 60; [PetU]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [PetU]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [void][PetU]::SetCursorPos($__op.X,$__op.Y); 'clicked'`, timeoutMs).then((out) => {
        // ⚠ 2026-11-10 四十轮修：runPs 返回的是 {ok,out,error} 对象，原来 `String(out)`
        //   永远是 "[object Object]" —— 角落急停/遮挡/UAC 的判定**一次都没生效过**。
        const text = String((out && (out.out || out.error)) || '');
        if (text.includes('UAC-SECURE-DESKTOP')) throw Object.assign(new Error('UAC 安全桌面正在前台（提权弹窗）——已拒绝发鼠标：安全桌面上注入会被系统丢弃，且可能误触提权框'), { vetoCode: VETO.EMERGENCY_STOP });
        if (text.includes('OCCLUDED:')) throw Object.assign(new Error('落点被「' + text.split('OCCLUDED:')[1].trim() + '」盖住了——坐标虽然对，但鼠标会点到遮挡窗口上；先挪开遮挡物或换坐标'), { vetoCode: VETO.TARGET_OCCLUDED });
        if (text.includes('EMERGENCY-STOP')) throw Object.assign(new Error('EMERGENCY-STOP：光标被甩在屏幕角落——判定你在紧急避险，已拒绝发键。把鼠标移开角落即可恢复。'), { vetoCode: VETO.EMERGENCY_STOP });
        return out;
    });
}



// 用户实测：QQ 消息列表的联系人**点不开**（列表项需要双击），她只会单击 → 点了半天
// 没反应就绕道搜索。根因 = 交互原语只有「单击」一种。补齐人类的基础交互集：
//   double_click（两次 down/up 间隔 90ms < 500ms 双击窗口）、right_click（0x08/0x0010）、
//   drag（按下 → 分段移动 → 抬起，用于拖滑块/选文本/拖文件）。
// 一个 PS 进程完成整个动作（不拆多次 spawn——双击拆两次会超 500ms 双击窗口）。
async function mouseEx(kind, x, y, x2, y2, durMs, timeoutMs = 9000, expectTitle = '', modifiers = '', axis = '', guard = null) {
    // ── 鼠标原语的统一守卫（2026-11-21 洞 3）────────────────────────────
    // 双击/右键/中键/拖拽/滚轮以前**完全不经过** guardClickTarget：不仅破坏性按钮
    // 无人管，连「落点在自己窗口里」也没人判。这里和 clickAt 同口径：
    // 缺省时由原语补 {source:'unspecified', name:''}（own-window 守卫始终生效）。
    // 注意：scroll 允许不给坐标（沿用当前光标），此时只做按钮名判定。
    const mGuardInfo = Object.assign({ source: 'unspecified', name: '' }, guard || {});
    if (Number.isFinite(x) && Number.isFinite(y)) { mGuardInfo.x = x; mGuardInfo.y = y; }
    if (!guard) {
        CONTROL_STATS.guardDefaulted += 1;
        try { __silentAudit.audit('game-control:guard-default', 'mouseEx(' + kind + ') 调用点未传 guard，已补 source=' + mGuardInfo.source, { quiet: true }); } catch (e) { /* ignore */ }
    }
    await assertClickGuard(mGuardInfo);
    // 屏幕指示（2026-11-14）：拖拽/滚动/双击都要让用户看得见
    {
        const hasPos = Number.isFinite(x) && Number.isFinite(y);
        const labelText = kind === 'drag' ? '拖拽 →'
            : kind === 'scroll' ? ('滚动 ' + ((axis === 'h') ? '横' : '纵'))
                : kind === 'double_click' ? '双击'
                    : kind === 'right_click' ? '右键'
                        : kind === 'middle_click' ? '中键' : '点击';
        notifyOverlay({
            point: hasPos ? { x, y } : null,
            tag: {
                text: labelText + (modifiers ? '（' + modifiers + '）' : ''),
                x: hasPos ? x + 26 : 40,
                y: hasPos ? y - 36 : 40,
            },
        });
        if (hasPos) notifyCursor(x, y, labelText + (modifiers ? '+' + modifiers : ''));
    }
    // 快轨：Rust 一条命令完成「护栏 + 注入」（restoreCursor：不霸占用户的鼠标）
    const rr = await tryRustMouse(kind, x, y, x2, y2, kind === 'drag' ? durMs : 0, kind === 'scroll' ? durMs : 0, expectTitle, modifiers, axis, true);
    if (rr) return { ok: true, out: 'rust-mouse ' + kind, via: 'rust', us: rr.us, steps: rr.steps, userRestored: rr.restored === true };
    if (modifiers) {
        throw new Error('组合键 ' + kind + '（' + modifiers + '）需要 Rust 内核；当前 pet-core 不可用，已拒绝而不是退化成裸操作');
    }
    // scroll 允许不给坐标（沿用当前光标位置）；其他交互必须有坐标
    const hasPos = Number.isFinite(x) && Number.isFinite(y);
    // 记住用户光标，动作结束还回去（与 Rust 路径同语义；不给坐标的 scroll 不用管）
    let ops = hasPos ? `$__op = New-Object PetU+POINT; [void][PetU]::GetCursorPos([ref]$__op); [PetU]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 80; ` : '';
    if (kind === 'double_click') {
        ops += `[PetU]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [PetU]::mouse_event(4,0,0,0,[UIntPtr]::Zero);`
            + ` Start-Sleep -Milliseconds 90;`
            + ` [PetU]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [PetU]::mouse_event(4,0,0,0,[UIntPtr]::Zero);`;
    } else if (kind === 'right_click') {
        ops += `[PetU]::mouse_event(8,0,0,0,[UIntPtr]::Zero); [PetU]::mouse_event(0x10,0,0,0,[UIntPtr]::Zero);`;
    } else if (kind === 'drag') {
        // 2026-11-10 四十轮（抄原型 bezier_curve.rs 的 ease-in-out 思路）：
        //   12 段等速 ≈20Hz，3D 运镜/拖滑块一眼看出是机器；改 30 段 + 钟形速度
        //   （首尾慢、中间快），末点强制精确落靶。纯算术，无新依赖。
        const steps = 30;
        const dur = Math.max(200, Number(durMs) || 600);
        const stepMs = Math.max(4, Math.round(dur / steps));
        ops += `[PetU]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 120;`;
        for (let i = 1; i <= steps; i += 1) {
            const p = i / steps;
            const t = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;   // ease-in-out cubic
            const ix = Math.round(x + (x2 - x) * t);
            const iy = Math.round(y + (y2 - y) * t);
            ops += ` [PetU]::SetCursorPos(${ix},${iy}); Start-Sleep -Milliseconds ${stepMs};`;
        }
        ops += ` Start-Sleep -Milliseconds 100; [PetU]::mouse_event(4,0,0,0,[UIntPtr]::Zero);`;
    } else if (kind === 'scroll') {
        // 滚轮（2026-11-10 行为审计补：审计发现她连续试了 5 种写法（scroll_down /
        //   scroll down 8 at x,y / scroll -8 / {"scroll":-600} …）全被拒，因为全文件
        //   根本没有 wheel 实现（0 处 grep 命中）。现在支持：负数=向下滚，正数=向上，每格 120。
        const notches = Math.max(-50, Math.min(50, Number(durMs) || 3));
        const delta = Math.round(notches * 120);
        ops += `[PetU]::mouse_event(0x0800,0,0,${delta},[UIntPtr]::Zero);`;
    } else {
        ops += `[PetU]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [PetU]::mouse_event(4,0,0,0,[UIntPtr]::Zero);`;
    }
    ops += ` Start-Sleep -Milliseconds 40; if ($__op) { [void][PetU]::SetCursorPos($__op.X,$__op.Y) }; 'done'`;
    return runPs(`${PS_SIG} ${psUacGuard()} ${psOcclusionGuard(x, y, expectTitle)} ${CORNER_GUARD} ` + ops, timeoutMs).then((out) => {
        const text = String((out && (out.out || out.error)) || '');
        if (text.includes('UAC-SECURE-DESKTOP')) throw Object.assign(new Error('UAC 安全桌面正在前台（提权弹窗）——已拒绝 ' + kind), { vetoCode: VETO.EMERGENCY_STOP });
        if (text.includes('OCCLUDED:')) throw Object.assign(new Error('落点被「' + text.split('OCCLUDED:')[1].trim() + '」盖住了——已拒绝 ' + kind), { vetoCode: VETO.TARGET_OCCLUDED });
        if (text.includes('EMERGENCY-STOP')) throw Object.assign(new Error('EMERGENCY-STOP：光标被甩在屏幕角落——已拒绝 ' + kind + '。移开鼠标即恢复。'), { vetoCode: VETO.EMERGENCY_STOP });
        return out;
    });
}

// ── 执行链第二档：PostMessage 后台投递（trycua 思路，拍板三增量的延续）────────
// UIA Invoke（第一档，已做）→ **PostMessage 后台**（本档：不抢焦点、不打断用户）→ SendKeys 硬发（第三档兜底）。
// 诚实边界：PostMessage 的送达≠生效——游戏类读 RawInput/DirectInput 根本不认；
// 所以 focus 没给/投递失败/她说没生效时，调用方自动回落硬发，这里只做"不惊扰的先试"。
const VK_MAP = { enter: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, backspace: 0x08, delete: 0x2e,
                 up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23,
                 pageup: 0x21, pagedown: 0x22, space: 0x20,
                 ctrl: 0x11, alt: 0x12, shift: 0x10 };

function vkFor(p) {
    if (VK_MAP[p]) return VK_MAP[p];
    if (/^[a-z0-9]$/.test(p)) return p.toUpperCase().charCodeAt(0);
    const fm = p.match(/^f([1-9]|1[0-2])$/);
    if (fm) return 0x70 + Number(fm[1]) - 1;
    return null;
}

const PS_POST_SIG = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class PetP {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
}
'@;`;

/** 按标题子串找可见窗口句柄（pwsh）。返回 'no-window' 或 hwnd 十进制串。 */
function findHwndPs(title) {
    const esc = String(title).toLowerCase().replace(/'/g, "''");
    return runPs(`${PS_POST_SIG}
$script:target = [IntPtr]::Zero
$cb = [PetP+EnumWindowsProc]{ param($h, $l)
  if ([PetP]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][PetP]::GetWindowText($h, $sb, 512)
    if ($sb.Length -gt 0 -and $sb.ToString().ToLower().Contains('${esc}')) { $script:target = $h; return $false }
  }
  return $true
}
[void][PetP]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:target -eq [IntPtr]::Zero) { 'no-window' } else { $script:target.ToInt64() }`, 8000).then((r) => {
        if (r.out === 'no-window') return null;
        const hwnd = Number(r.out);
        return Number.isFinite(hwnd) && hwnd > 0 ? hwnd : null;
    });
}

/** 后台投递按键序列（VK 序列，支持修饰键包裹）。 */
async function postKeysTo(focus, spec) {
    // 唯一解析入口（2026-11-21 P2）：先把标题/pid 换成 hwnd，投递只认 hwnd。
    // 旧实现用 pwsh EnumWindows 取第一个标题命中的窗口 —— 与 JS/Rust 两套解析三选各不同。
    const rz = await resolveTargetHwnd(focus);
    if (!rz || rz.ok === false) {
        return { ok: false, reason: 'unresolved', error: (rz && rz.error) || ('没找到窗口：' + focus) };
    }
    const hwnd = rz.hwnd;
    if (rz.multiHit) {
        try { __silentAudit.audit('game-control:post-keys-multi-hit', rz.detail); } catch (e) { /* ignore */ }
    }
    // 复用统一策略表（黑名单/win 键拒绝都在 toSendKeys 里）
    toSendKeys(spec);
    const parts = keyPolicy.splitKeySpec(spec).map(normalizeKeyName);
    const mods = parts.filter((p) => ['ctrl', 'alt', 'shift'].includes(p)).map(vkFor);
    const keys = parts.filter((p) => !['ctrl', 'alt', 'shift'].includes(p)).map(vkFor);
    if (!keys.length || keys.some((v) => !v) || mods.some((v) => !v)) return { ok: false, reason: 'unsupported-key' };
    const posts = [];
    for (const v of mods) posts.push(`[void][PetP]::PostMessage($t,0x0100,[IntPtr]${v},[IntPtr]0)`);
    for (const v of keys) posts.push(`[void][PetP]::PostMessage($t,0x0100,[IntPtr]${v},[IntPtr]0); Start-Sleep -Milliseconds 25; [void][PetP]::PostMessage($t,0x0101,[IntPtr]${v},[IntPtr]0)`);
    for (const v of mods.reverse()) posts.push(`[void][PetP]::PostMessage($t,0x0101,[IntPtr]${v},[IntPtr]0)`);
    const r = await runPs(`${PS_POST_SIG}
$t = [IntPtr]${hwnd}
${posts.join('; ')}
'posted'`, 8000);
    return r.ok ? { ok: true, hwnd, multiHit: rz.multiHit === true, resolution: rz.detail } : { ok: false, reason: r.error || 'post-failed' };
}

/** 后台投递文字（WM_CHAR 逐字符，Unicode 直投）。 */
async function postTextTo(focus, text) {
    const hwnd = await findHwndPs(focus);
    if (!hwnd) return { ok: false, reason: 'no-window' };
    const codes = [...String(text)].map((c) => c.codePointAt(0)).filter((c) => c > 0 && c !== 10 && c !== 13);
    if (!codes.length) return { ok: false, reason: 'empty' };
    const r = await runPs(`${PS_POST_SIG}
$t = [IntPtr]${hwnd}
foreach ($c in @(${codes.join(',')})) { [void][PetP]::PostMessage($t,0x0102,[IntPtr]$c,[IntPtr]0); Start-Sleep -Milliseconds 8 }
'posted'`, 8000 + codes.length * 12);
    return r.ok ? { ok: true, hwnd, count: codes.length } : { ok: false, reason: r.error || 'post-failed' };
}

// ── Snapshot 元素编号菜单（Windows-MCP 协议形状，调研报告 Top2）──────────────
// pwsh 5.1 实现（uiautomation 库在本机实测两次挂死，见调研报告附录；pwsh 473ms 留任）。
// 护栏同 Windows-MCP：按 ClassName 排除病态 a11y 树（Chromium/Electron 系）、深度限 5、
// 元素封顶 60、只收可交互类型、JS 侧 8s 进程超时。
const UIA_EXCLUDE_CLASSES = 'Chrome_WidgetWin_1|Chrome_RenderWidgetHostHWND';
const UIA_SNAPSHOT_STATE = {
    title: '', items: [], hwnd: 0, pid: 0, rect: null,
    // 2026-11-24：快照身份与代数（见 _snapshotSid 注释）
    sid: 0, at: 0, targetHwnd: 0, targetTitle: '',
};   // hwnd/pid/rect：身份守卫 + homing（2026-11-10 三十八轮）
const SOM_STATE = {
    title: '', hwnd: 0, pid: 0, marks: [], rect: null,
    sid: 0, at: 0, targetHwnd: 0, targetTitle: '',
};   // hwnd：真实窗口身份（2026-11-21）；pid：识别「把 pid 当 hwnd 传」的歧义（第四轮 P2）；rect：homing 自动补偿基线（三十八轮）
const PVZ_STATE = { hwnd: 0, client: null, grid: null };   // 植物大战僵尸网格标定（pvz init）   // SoM 标注状态（som_click 按编号回查）   // 最近一次快照（click_element 按编号回查）

// ── 快照≥编号绑定校验（2026-11-24 根因修，fail-closed）─────────────────────
// #编号只在「拍它的那次快照」里成立。调用方给窗口（标题或 hwnd）时必须与快照记录的
// 目标窗口一致；没给窗口则沿用快照自身的 hwnd（不拒绝），但把 sid 记进回执。
// 任何一项对不上 / 快照过旧 → STALE_SNAPSHOT，且**不发点击**。
const _normWinText = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
// 标题匹配的边界字符：空白 / 常见分隔符 / 左括号。只有「短标题后面紧跟这些」才算同一个窗口。
const TITLE_BOUNDARY = /[\s\-–—_|/\\:：·.,，()（）\[\]【】]/;
// 子串匹配的最短长度：1 个字（"Q"）几乎能命中一切窗口，等于没校验。
const TITLE_SUBSTR_MIN = 2;
/**
 * **唯一标题 matcher**（2026-11-25 P1-2）：解析层与绑定层必须用同一套，否则
 * `see window=QQ` 解析到「QQ音乐」而 `act click window=QQ` 绑定失败（STALE 死循环）。
 *
 * 层级：exact → prefix+boundary → substring（是否唯一由调用方在候选集上判）。
 *   · 完全相同 → 'exact'
 *   · 一侧是另一侧的前缀，且短侧 ≥4 字、长侧紧跟着分隔符（"记事本 - 未命名"）→ 'prefix'
 *   · 任意子串，但短针 ≥2 字（"QQ" → "QQ音乐"）→ 'substring'
 * 返回 null = 不匹配。
 */
function titleMatchKind(candidate, needle) {
    const c = _normWinText(candidate);
    const n = _normWinText(needle);
    if (!c || !n) return null;
    if (c === n) return 'exact';
    const shortSide = c.length <= n.length ? c : n;
    const longSide = c.length <= n.length ? n : c;
    if (shortSide.length >= 4 && longSide.startsWith(shortSide) && TITLE_BOUNDARY.test(longSide.charAt(shortSide.length))) {
        return 'prefix';
    }
    if (n.length >= TITLE_SUBSTR_MIN && c.includes(n)) return 'substring';
    return null;
}
/**
 * 窗口标题匹配（2026-11-25 P1-2：改为委托 titleMatchKind）。
 * 旧实现是双向 includes：req="QQ" 能匹配 "QQ音乐"、req="计" 能匹配一切 —— 等于没校验；
 * 但收紧成「短标题必须精确」后，`see` 的解析层（子串）和 `act` 的绑定层（精确）不一致，
 * 于是 see 成功、click 永远 STALE。现在两层共用 titleMatchKind：
 * 短标题仍不做前缀放宽（<4 字只认精确/唯一子串），但解析与绑定给出同一个答案。
 */
function _winTitleMatches(a, b) {
    return titleMatchKind(a, b) !== null;
}

/**
 * 校验「这次点击引用的编号」是否仍属于当前快照。
 * @param {object} state UIA_SNAPSHOT_STATE 或 SOM_STATE
 * @param {{title?:string, hwnd?:number}} req 请求里带的窗口（可空）
 * @param {{maxAgeMs?:number, space?:string, liveHwnds?:number[]|null}} [opts]
 *        liveHwnds：当前真实存在的窗口 hwnd 列表（只在「数字既不是快照 hwnd、又等于快照 pid」
 *        的歧义场景需要；传 null/不传 = 查不到窗口表，保持旧宽容，不拒绝）
 * @returns {{ok:true, snapshot_id:number, snapshot_age_ms:number|null, window:{hwnd:number,title:string}, usedOwnWindow:boolean, matchedBy:string}
 *          |{ok:false, code:'STALE_SNAPSHOT', reason:string, detail:string, snapshot_id:number, snapshot_age_ms:number|null, snapshot_window:{hwnd:number,title:string}, requested_window:{hwnd:number,title:string}}}
 */
function checkSnapshotBinding(state, req, opts) {
    const st = state || {};
    const o = opts || {};
    const maxAge = Number.isFinite(o.maxAgeMs) ? o.maxAgeMs : SNAPSHOT_MAX_AGE_MS;
    const sid = Number(st.sid) || 0;
    const at = Number(st.at) || 0;
    const age = at > 0 ? Math.max(0, Date.now() - at) : null;
    const snapHwnd = Number(st.targetHwnd || st.hwnd) || 0;
    const snapPid = Number(st.pid) || 0;
    const snapTitle = String(st.targetTitle || st.title || '').trim();
    const r = req || {};
    const reqTitle = String(r.title == null ? '' : r.title).trim();
    const reqHwnd = Number(r.hwnd) || 0;
    const snapshot_window = { hwnd: snapHwnd, title: snapTitle };
    const requested_window = { hwnd: reqHwnd, title: reqTitle };
    const who = () => '「' + (snapTitle || ('hwnd ' + snapHwnd)) + '」（sid=' + sid + '）';
    const stale = (reason, detail, extra) => Object.assign({
        ok: false, code: 'STALE_SNAPSHOT', reason, detail,
        snapshot_id: sid, snapshot_age_ms: age,
        snapshot_window, requested_window,
    }, extra || {});
    const okResult = (matchedBy, extra) => Object.assign({
        ok: true, snapshot_id: sid, snapshot_age_ms: age,
        window: snapshot_window, usedOwnWindow: !reqHwnd && !reqTitle,
        matchedBy,
        // 回执里带「实际匹配到的窗口身份」：模型/评测能直接核对，不用回猜
        matched: { by: matchedBy, hwnd: snapHwnd, title: snapTitle, requestedHwnd: reqHwnd, requestedTitle: reqTitle },
    }, extra || {});

    // ① 年龄：超过上限的快照不可信（界面早变了，编号可能指向别的东西）
    if (age !== null && age > maxAge) {
        return stale('expired',
            '快照已过期：' + who() + ' 拍于 ' + Math.round(age / 1000) + ' 秒前（上限 ' +
            Math.round(maxAge / 1000) + ' 秒）——界面可能已经变了。请重新 see 再点');
    }
    // ② 请求带了窗口：必须与快照目标一致
    if (reqHwnd > 0) {
        if (!snapHwnd) {
            return stale('identity-unknown',
                '快照没有窗口身份（sid=' + sid + '），无法确认编号属于 hwnd ' + reqHwnd +
                '；请重新 see "' + (reqTitle || reqHwnd) + '" 再点');
        }
        if (reqHwnd !== snapHwnd) {
            // 2026-11-24 第四轮 P2：纯数字最常见是**模型把 pid 当 hwnd 传**。快照记过 pid
            // 且请求值等于它 = 同一个进程的窗口，按 window-mismatch 拒绝会让她在
            // 「重新 see → 还是传 pid → 还是 mismatch」里死循环。
            // 2026-11-25 P2-7 修正：「等于 pid」不能直接当通行证 —— 这个数字也可能**真的是
            // 另一个窗口的 hwnd**（hwnd 与 pid 都是小整数，撞车完全可能）。所以先查实时窗口表：
            //   · 传了 liveHwnds 且里面有它 → 是真实存在的另一个窗口 → 拒绝（window-mismatch）；
            //   · 传了 liveHwnds 但没有它 → 这才当 pid 宽容（沿用快照窗口，回执给 identityNote）；
            //   · 没传（窗口表查不到）→ 无法证伪，保持旧宽容。
            if (snapPid && reqHwnd === snapPid) {
                const live = Array.isArray(o.liveHwnds) ? o.liveHwnds : null;
                const isRealWindow = live ? live.some((h) => Number(h) === reqHwnd) : null;
                if (isRealWindow === true) {
                    return stale('window-mismatch',
                        '你传的 hwnd ' + reqHwnd + ' 当前确实是一个窗口（它同时也是快照窗口的 pid，数字撞车）——' +
                        '编号只属于 ' + who() + '，不能跨窗口复用。请重新 see "' + (reqTitle || reqHwnd) + '" 再点',
                        { pidHwndCollision: true });
                }
                return okResult('pid-tolerated', {
                    usedOwnWindow: true,
                    note: {
                        code: 'pid-not-hwnd',
                        text: '你传的 ' + reqHwnd + ' 是进程 pid，不是窗口 hwnd（快照窗口 hwnd=' + snapHwnd +
                            '）。这次按快照窗口继续；下次请改传 hwnd=' + snapHwnd + ' 或窗口标题' +
                            (live ? '' : '（本次未取到实时窗口表，无法排除同号窗口撞车）'),
                    },
                });
            }
            return stale('window-mismatch',
                '快照属于 ' + who() + '，你点的是「hwnd ' + reqHwnd + '」；请重新 see "' +
                (reqTitle || reqHwnd) + '" 再点');
        }
        return okResult('hwnd');
    } else if (reqTitle) {
        // 2026-11-24 第四轮 P2：hwnd=0 时只凭标题子串放行 —— 1 个字符（如 "Q"）几乎
        // 匹配一切窗口，等于没校验。标题为空/过短 → identity-unknown，要求给 hwnd 或完整标题。
        if (_normWinText(reqTitle).length < 2) {
            return stale('identity-unknown',
                '窗口标题太短（"' + reqTitle + '"，不足 2 个字符），按子串匹配会误中任意窗口；' +
                '请改传完整标题或 hwnd（可在 see windows 回执里查）');
        }
        if (!snapTitle || _normWinText(snapTitle).length < 2) {
            return stale('identity-unknown',
                '快照的窗口标题不可用（"' + snapTitle + '"），无法确认编号属于「' + reqTitle +
                '」；请重新 see "' + reqTitle + '" 再点');
        }
        if (!_winTitleMatches(snapTitle, reqTitle)) {
            return stale('window-mismatch',
                '快照属于「' + snapTitle + '」（sid=' + sid + '），你点的是「' + reqTitle +
                '」；标题必须精确相等，或长标题以它开头并紧跟分隔符（短于 4 字的标题必须写全）。请重新 see "' + reqTitle + '" 再点');
        }
        return okResult('title');
    }
    // ③ 没带窗口：沿用快照自身 hwnd（不拒绝），回执里会带 sid 便于排障
    return okResult('snapshot-own');
}

/**
 * som_click 的快照年龄上限（纯函数，测试可直接断言）：
 *   · 请求带了**可验证 hwnd** 且等于快照窗口 hwnd（= 同一窗口，编号仍属于它）→ 300s；
 *   · 请求没带 hwnd / 传的是别的窗口 / 传的是 pid（数字不可验证）→ 不放宽，仍 120s。
 * 2026-11-25 P2-7：旧实现「reqHwnd<=0 也放宽到 300s」等于没传窗口就放宽 —— 编号可能来自
 * 早已换掉的窗口，模型却拿到 5 分钟有效期。现在只有能证明「还是那个窗口」才放宽。
 * 「窗口仍存活」由点击前的 assertTargetFocused(strict) 强制 —— 不是前台/已关闭就拒绝，
 * 所以放宽 TTL 不会把点击发进已消失的窗口。
 */
function somClickMaxAgeMs(state, req) {
    const st = state || {};
    const r = req || {};
    const snapHwnd = Number(st.targetHwnd || st.hwnd) || 0;
    const reqHwnd = Number(r.hwnd) || 0;
    if (!snapHwnd) return SNAPSHOT_MAX_AGE_MS;
    if (reqHwnd <= 0) return SNAPSHOT_MAX_AGE_MS;   // 没带可验证 hwnd → 不放宽
    return reqHwnd === snapHwnd ? SOM_STICKY_MAX_AGE_MS : SNAPSHOT_MAX_AGE_MS;
}

// 测试注入用：模拟「当前真实窗口表」。null = 不注入，走真实 pet-core。
let _liveHwndsOverride = null;
/**
 * 只在「请求的数字既不是快照 hwnd、又恰好等于快照 pid」时查一次实时窗口表。
 * 用途：区分「模型把 pid 当 hwnd 传」（宽容并提示）与「这个数字真的是另一个窗口的 hwnd」（拒绝）。
 * 返回 null = 查不到（pet-core 缺失/超时/测试桩死）→ 调用方保持旧宽容，不拒绝。
 */
function liveHwndsForCollisionCheck(state, reqHwnd) {
    const st = state || {};
    const snapHwnd = Number(st.targetHwnd || st.hwnd) || 0;
    const snapPid = Number(st.pid) || 0;
    const n = Number(reqHwnd) || 0;
    if (!(n > 0) || n === snapHwnd || !snapPid || n !== snapPid) return null;
    if (Array.isArray(_liveHwndsOverride)) return _liveHwndsOverride.map((h) => Number(h) || 0).filter(Boolean);
    try {
        const bin = _coreBin();
        if (!bin) return null;
        const wl = JSON.parse(require('child_process').execFileSync(bin, [], {
            input: JSON.stringify({ cmd: 'windows', max: 400 }), timeout: 8000,
            maxBuffer: 8 * 1024 * 1024, windowsHide: true,
        }).toString());
        return (wl.windows || []).map((w) => Number(w.hwnd) || 0).filter(Boolean);
    } catch (e) { return null; }
}

function uiaPsScript(mode, title, targetRid) {
    const escTitle = String(title || '').replace(/'/g, "''");
    const escRid = String(targetRid || '').replace(/'/g, "''");
    return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::RootElement
$tops = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$hits = New-Object System.Collections.ArrayList
$interactive = '|Button|MenuItem|Edit|CheckBox|RadioButton|ComboBox|ListItem|Hyperlink|TabItem|Slider|ToggleButton|SplitButton|'
foreach ($w in $tops) {
    if ("$($w.Current.ClassName)" -match '^(${UIA_EXCLUDE_CLASSES})$') { continue }
    ${title ? `if (-not ("$($w.Current.Name)".ToLower().Contains('${escTitle.toLowerCase()}'))) { continue }` : ''}
    $stack = New-Object System.Collections.Stack
    $stack.Push(@($w, 0))
    while ($stack.Count -gt 0 -and $hits.Count -lt 60) {
        $cur = $stack.Pop(); $el = $cur[0]; $depth = $cur[1]
        try {
            $pn = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\\.', ''
            $name = "$($el.Current.Name)".Trim()
            $r = $el.Current.BoundingRectangle
            if ($interactive.Contains('|' + $pn + '|')) {
                if ($name -and $r.Width -gt 1 -and $r.Height -gt 1) {
                    $rid = [int[]]$el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::RuntimeIdProperty)
                    $ridS = ($rid -join '-')
                    if ('${mode}' -eq 'click' -and $ridS -eq '${escRid}') {
                        $inv = $null
                        if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) {
                            $inv.Invoke() | Out-Null
                            [void]$hits.Add(@{ ok = $true; how = 'invoke'; name = $name })
                        } else {
                            # P2-10（2026-11-21）：PowerShell 侧不再 SetCursorPos（150% 缩放下会偏）。
                            # 没有 Invoke 就只把物理矩形中心报给 JS，由 pet-core 的坐标入口点。
                            [void]$hits.Add(@{ ok = $false; how = 'none'; noPattern = $true; hasRect = $true;
                                x = [int]($r.X + $r.Width / 2); y = [int]($r.Y + $r.Height / 2); name = $name })
                        }
                        break
                    }
                    if ('${mode}' -eq 'snapshot') {
                        [void]$hits.Add(@{ rid = $ridS; type = $pn.ToLower(); name = $name; x = [int]($r.X + $r.Width / 2); y = [int]($r.Y + $r.Height / 2); pid = $el.Current.ProcessId })
                    }
                }
            }
            if ($depth -lt 5) {
                $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
                foreach ($k in $kids) { $stack.Push(@($k, $depth + 1)) }
            }
        } catch { }
    }
    if ($hits.Count -ge 60 -or ($hits.Count -gt 0 -and '${mode}' -eq 'click')) { break }
}
if ($hits.Count -gt 0) { $hits | ConvertTo-Json -Compress } else {
    if ('${mode}' -eq 'click') { '{"ok":false}' } else { '[]' }
}
`;
}

// ── SendInput 常驻助手（2026-11-09 三十轮）──────────────────────────────────
// 调研结论：Raw Input / DirectInput 游戏只认 SendInput 这条系统输入流；
// PostMessage 对它们无效（DirectInput8 另起线程读 WM_INPUT，RIDEV_NOLEGACY 下不生成 WM_KEYDOWN）。
// 另外每次 spawn pwsh 有 200-400ms 开销，写游戏连招跟不上——所以起一个常驻 HTTP 小服务。
const SEND_INPUT_PORT = Number(process.env.PET_SENDINPUT_PORT) || 8104;
/**
 * 查当前前台窗口信息（2026-11-09 第一性原理复盘 P0）。
 * 为什么需要：SendInput 没有 hwnd 参数——它永远发给**当前前台窗口**。
 * 如果目标不在前台，按键会落到别人身上，但我们的工具还返回 ok:true（假成功）。
 * 实测踩到：press_key ctrl+f 说「已按」，实际 Ctrl+F 落到了 ZCode 里。
 */
async function getForegroundInfo() {
    try {
        // ⓪ Rust 内核（2026-11-09 三十五轮）：GetForegroundWindow 一次 P/Invoke，零 HTTP。
        //    这是 press_key/hold_key/type_text 每次都要跑的热路径。
        const bin = _coreBin();
        if (bin) {
            const rr = await new Promise((resolve) => {
                try {
                    const { execFile } = require('child_process');
                    const child = execFile(bin, [], { windowsHide: true, timeout: 4000, maxBuffer: 512 * 1024 },
                        (err, stdout) => {
                            if (err) return resolve(null);
                            try { resolve(JSON.parse(String(stdout))); } catch (e) { resolve(null); }
                        });
                    try { child.stdin.end('{"cmd":"fg"}', 'utf8'); } catch (e) { resolve(null); }
                } catch (e) { resolve(null); }
            });
            if (rr && rr.ok) {
                // D2：pet-core fg 已带 app（进程名小写）——只进经验缓存，不改既有 proc 语义
                const app = _expNoteApp(rr.pid, rr.app, rr.title);
                return {
                    title: String(rr.title || ''), pid: Number(rr.pid) || 0,
                    // ⚠ 2026-11-22（子代理审计发现）：这里原本 `proc: ''`，而 pet-core 的 fg
                    // 自 2026-11-17 起就返回 `app`（进程名）——于是所有依赖 `fg.proc` 的守卫
                    // （黑名单 612 行、窗口匹配 2134 行）在 Rust 热路径上**一直在空转**。
                    // 消费方都做 toLowerCase()+includes，app 的格式足够；填上即可。
                    proc: String(rr.app || ''),
                    hwnd: Number(rr.hwnd) || 0, via: 'rust', app,
                };
            }
        }

        // ⚠ 2026-11-09 三十五轮：优先走常驻服务（<5ms），失败才 spawn pwsh（300ms+）。
        //   查前台是 press_key/hold_key/type_text 每次都要做的事，这条路径在热路上。
        if (await ensureUiaService()) {
            const r = await _uiaPost('/fg', {}, 2500);
            if (r && r.ok && r.title !== undefined) {
                const app = _expNoteApp(r.pid, r.proc, r.title);
                return {
                    title: String(r.title || ''), pid: Number(r.pid) || 0, proc: String(r.proc || ''),
                    hwnd: Number(r.hwnd) || 0, via: 'uia-service', app,
                };
            }
        }
        const ps = [
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
            "$sig = @'",
            "using System;using System.Text;using System.Runtime.InteropServices;",
            "public class FGI {",
            ' [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
            ' [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);',
            ' [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
            "}",
            "'@",
            "Add-Type -TypeDefinition $sig",
            "$h = [FGI]::GetForegroundWindow()",
            "$sb = New-Object System.Text.StringBuilder 512",
            "[void][FGI]::GetWindowTextW($h, $sb, 512)",
            "$pid2 = 0",
            "[void][FGI]::GetWindowThreadProcessId($h, [ref]$pid2)",
            "$pn = ''",
            "try { $pn = (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName } catch {}",
            "@{ title=$sb.ToString(); pid=[int]$pid2; proc=$pn } | ConvertTo-Json -Compress",
        ].join('\n');
        const r = await runPs(ps, 4000);
        if (!r.ok || !r.out) return null;
        const d = JSON.parse(r.out);
        d.via = 'pwsh-fallback';
        // D2：pwsh 分支早就给了 proc（进程名），同样只进经验缓存
        d.app = _expNoteApp(d.pid, d.proc, d.title);
        return d;
    } catch (e) { return null; }
}

/**
 * 断言目标窗口是前台（输入类动作的前置检查）。
 *
 * 2026-11-21（P0-2）：判定从「按标题比对」升级为「按 pid 比对」——
 *   同一应用的主窗 + 模态对话框（#32770）pid 相同，以前会把它们当成两个对手互相拒
 *   （实测：focus 到「选择扩展目录。」后点主窗控件被拒）。现在目标窗口 pid === 前台 pid
 *   即视为前台；owned popup 的 pid 天然等于 owner，已被同 pid 覆盖。
 *   保留标题匹配作为**解析手段**（把标题解析成 pid），不再作为最终判据。
 *
 * @returns {Promise<{ok:boolean, error?:string, fg?:object, fgPid?:number, targetPid?:number, matchedBy?:string}>}
 */
async function assertTargetFocused(titleOrPid, opts) {
    const strict = !!(opts && opts.strict === true);
    if (!titleOrPid) {
        // 没指定目标 = 用户就是要按给当前前台，放行但要告知当前是谁
        const fg0 = await getForegroundInfo();
        return { ok: true, fg: fg0, note: '未指定目标窗口，按给当前前台：' + (fg0 ? fg0.title : '未知') };
    }
    const fg = await getForegroundInfo();
    // 2026-11-13：原来这里是 fail-open（读不到前台就 `ok:true` 放行）—— 传感器失效时
    //   照样把键发出去，会打到随机窗口上。安全前置检查必须 fail-closed：
    //   调用方都是 `if (!chk.ok) return VC.notSent(...)`，所以这里改 false 就是「不发」。
    if (!fg) return { ok: false, error: '读不到前台窗口信息（传感器失效），为了不误按，这次不发键' };
    const arg = String(titleOrPid);
    const isNum = /^\d+$/.test(arg);
    const num = Number(arg);
    const fgPid = Number(fg.pid) || 0;

    // 纯数字：pid / hwnd 双认（Rust fg 有 pid；list_windows 给的是 hwnd）
    if (isNum && (num === fgPid || num === Number(fg.hwnd))) {
        return {
            ok: true, fg, fgPid, targetPid: fgPid,
            matchedBy: num === Number(fg.hwnd) ? 'hwnd' : 'pid',
        };
    }
    // 标题快速通道：前台自己就匹配这个标题（保留旧行为，省一次窗口枚举）
    // strict 模式跳过：同 pid 的另一个窗口标题也可能包含同一子串，必须走到 hwnd 身份比对。
    if (!isNum && !strict) {
        const low = arg.toLowerCase();
        if (String(fg.title || '').toLowerCase().includes(low) || String(fg.proc || '').toLowerCase().includes(low)) {
            return { ok: true, fg, fgPid, targetPid: fgPid, matchedBy: 'title' };
        }
    }
    // P0-2 核心：把目标解析成窗口身份，再按 pid 判定
    const win = await resolveWindowInfo(arg);
    if (win) {
        const v = fgVerdict(fg, win, { strict });
        if (v.ok) return Object.assign({ ok: true, fg, target: win }, v);
        // pid 不同时再认 Windows 的 owner 关系：Chromium 的模态文件对话框在另一个
        // msedge.exe 进程里，但 GW_OWNER 指向主窗口 —— 同一个应用的窗口不该互斥。
        const rel = await sameAppFamily(fg, win);
        if (rel.ok) {
            return Object.assign({
                ok: true, fg, target: win, fgPid,
                targetPid: Number(win.pid) || 0,
            }, rel);
        }
        // strict 下的同 pid 兄弟窗口：owner 关系也不成立 → 明确拒绝，不靠 pid 放行。
        if (strict && v.samePid) {
            return {
                ok: false, fg, target: win, fgPid, targetPid: Number(win.pid) || 0,
                matchedBy: '', samePid: true, reason: 'same-pid-different-window',
                error: '「' + arg + '」不是当前前台窗口：同进程的另一个窗口「' + String(fg.title || '') +
                    '」在前台（hwnd ' + (fg.hwnd || 0) + ' vs 目标 ' + (win.hwnd || 0) + '）。' +
                    '物理按键/点击只会发给前台窗口，发出去会落到兄弟窗口上——没发。请先 focus_window "' + arg + '"',
            };
        }
        return Object.assign({
            ok: false,
            fg,
            target: win,
            error: '「' + arg + '」不是当前前台窗口（目标 pid ' + (win.pid || '?') + '，现在前台「' +
                String(fg.title || '') + '」pid ' + fgPid + '，hwnd ' + (fg.hwnd || 0) + '）。' +
                'SendInput 只能发到前台——按键会落到「' + String(fg.title || '') + '」上。' +
                '请先用 focus_window 切换，或用带 focus 参数的动作。',
        }, v, { owner: rel });
    }
    // 解析不到目标窗口：保持旧语义（按标题/进程名宽松匹配失败）
    return {
        ok: false,
        fg,
        fgPid,
        targetPid: isNum ? num : 0,
        matchedBy: '',
        error: '「' + arg + '」不是当前前台窗口（现在前台是「' + fg.title + '」，pid ' + fg.pid + '，hwnd ' + (fg.hwnd || 0) + '）。' +
               'SendInput 只能发到前台——按键会落到「' + fg.title + '」上。' +
               '请先用 focus_window 切换，或用带 focus 参数的动作。',
    };
}

/**
 * 查窗口真实矩形（用于识别「最小化/隐藏」——UIA 元素坐标此时不可信）。
 * @returns {Promise<{x,y,w,h,visible,iconic}|null>}
 *
 * ⚠ 2026-11-09 三十五轮修：原来纯 spawn pwsh 用 EnumWindows + 标题 Contains 匹配，
 *   会撞到同名 overlay 窗口（实测「ZCode」命中了不可见的 `Zcode Ghost Cursor`，
 *   于是报「ZCode 当前不可见」——但 ZCode 明明开着）。
 *   现在优先走常驻服务（WinEnum.FindAll 用 IsWindowVisible 过滤 + 优先挑非最小化的）。
 */
async function windowRealRect(titleSub) {
    if (!titleSub) return null;
    try {
        // 优先：常驻服务（<10ms，且已处理「可见性 / 最小化 / 撞名」）
        if (await ensureUiaService()) {
            const r = await _uiaPost('/rect', { title: String(titleSub) }, 3000);
            if (r && r.ok && Number.isFinite(Number(r.w))) {
                // E5：矩形归一走纯函数层（负数宽高平移取正；正数逐位不变）。
                const nr = geometry.normalizeRect({ x: r.x, y: r.y, w: r.w, h: r.h });
                return {
                    x: nr.x, y: nr.y,
                    w: nr.w, h: nr.h,
                    visible: r.visible !== false,
                    iconic: r.iconic === true,
                    title: r.title || '',
                };
            }
            if (r && r.notFound) return null;
        }
        const lines = [
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
            "$sig = @'",
            "using System;using System.Text;using System.Runtime.InteropServices;",
            "public class WRW {",
            ' [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
            ' [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);',
            ' [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
            ' [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
            ' [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
            " public delegate bool EnumProc(IntPtr h, IntPtr l);",
            " public struct RECT { public int L,T,R,B; }",
            "}",
            "'@",
            "Add-Type -TypeDefinition $sig",
            "$script:found = $null",
            "$cb = [WRW+EnumProc]{ param($h,$l)",
            "  $sb = New-Object System.Text.StringBuilder 512",
            "  [void][WRW]::GetWindowTextW($h, $sb, 512)",
            "  $t = $sb.ToString()",
            "  if ($t -and $t.ToLower().Contains('" + String(titleSub).toLowerCase().replace(/'/g, "''") + "')) {",
            "    $script:found = $h; return $false }",
            "  return $true }",
            "[void][WRW]::EnumWindows($cb, [IntPtr]::Zero)",
            "if ($script:found -ne $null) {",
            "  $r = New-Object WRW+RECT; [void][WRW]::GetWindowRect($script:found, [ref]$r)",
            "  @{ x=[int]$r.L; y=[int]$r.T; w=[int]($r.R-$r.L); h=[int]($r.B-$r.T); visible=[bool][WRW]::IsWindowVisible($script:found); iconic=[bool][WRW]::IsIconic($script:found) } | ConvertTo-Json -Compress",
            "} else { 'null' }",
        ];
        const r = await runPs(lines.join('\n'), 5000);
        if (!r.ok || !r.out || String(r.out).trim() === 'null') return null;
        return JSON.parse(r.out);
    } catch (e) { return null; }
}

// ── GUI 通道路由（2026-11-09 架构重设计 P0）─────────────────────────────
// 问题：现在全靠 LLM 每次自己选工具，但 LLM 不知道「这个窗口有没有 UIA 树」——
// 试错成本很高（微信试 UIA = 白等 300ms 才失败）。
// 这里用「窗口 class」这个确定信号做本地路由，<1ms，不占 LLM 上下文。
//
// D2（2026-11-22）：在静态路由之上叠一层**经验重排**。候选族按 app（进程名）的
// 历史成功率排序；样本 <3 的族位置不动，连续 3 次失败由 route-experience 自动回默认。
// 这一层只改「建议先试哪条」，不改任何实际执行/校验 —— 路由判断错了最多多等一次回落。
function guiRoute(windowTitle, windowClass, appProc) {
    const t = String(windowTitle || '');
    const c = String(windowClass || '');

    let route;
    // ① 有官方 API 的游戏 → 最快（连截图都不用）
    if (/Minecraft|我的世界/i.test(t)) route = { ch: 'fast', via: 'rcon', why: '有 RCON 官方协议', hint: '用 mc 子命令', candidates: ['rcon'] };
    else if (/League of Legends|英雄联盟/i.test(t)) route = { ch: 'fast', via: 'lol-api', why: '有 Live Client Data API :2999', hint: 'HTTP :2999 拉状态', candidates: ['lol-api'] };
    else if (/Counter-Strike|CS2|Dota|无畏契约|Valorant/i.test(t)) route = { ch: 'fast', via: 'valve-gsi', why: '有 Valve GSI', hint: 'GSI HTTP 拉状态', candidates: ['valve-gsi'] };
    // ② UIA 一定失明的自绘窗口 → 直接走视觉，别浪费时间试
    else if (/Qt\d|QWindow/i.test(c)) route = { ch: 'slow', via: 'ocr', why: 'Qt 自绘，UIA 无树（如微信）', hint: 'som_snapshot（OCR）找元素，som_click 点', candidates: ['ocr', 'uia', 'vision'] };
    else if (/Unity|Unreal|Godot|SDL_app|GLFW/i.test(c) || /植物大战僵尸/i.test(t)) route = { ch: 'slow', via: 'vision', why: '游戏引擎自绘', hint: 'som_snapshot 看画面 / visual_read 读数值 / click_at 点坐标', candidates: ['vision', 'ocr', 'uia'] };
    // ③ 已知有 UIA 树的 → fast（实测 Chromium/Tauri 都能扫到 30-60 个元素）
    else if (/Chrome_WidgetWin|Tauri|ApplicationFrame/i.test(c)) route = { ch: 'fast', via: 'uia', why: '实测有 UIA 树', hint: 'snapshot → click_element #编号', candidates: ['uia', 'ocr'] };
    // ④ 不确定 → 先试 fast（UIA 会自己超时降级）
    else route = { ch: 'fast', via: 'uia-probe', why: '未识别，先试 UIA', hint: '先 snapshot（快），空壳再 som_snapshot', candidates: ['uia', 'ocr'] };

    try {
        const app = routeExperience.normalizeApp(appProc) || _expAppFor(0, t);
        if (app) route.app = app;
        const ordered = routeExperience.prefer({ app, candidates: route.candidates });
        if (ordered.join('|') !== route.candidates.join('|')) {
            route.via = ordered[0];
            route.candidates = ordered;
            route.why = route.why + '；按 ' + app + ' 的历史成功率调整：' + ordered.join(' → ');
            route.experience = true;
        }
    } catch (e) {
        // 经验路由失败绝不影响静态路由
    }
    return route;
}

// ── 闭环判断：动作前后画面是否真的变了（2026-11-09 架构重设计 P0）────────
// 为什么需要：刚才实测「选卡槽 ok + 点格子 ok」，但被弹窗挡住，实际什么都没种上。
// 动作执行成功 ≠ 目的达成。这里用「感知哈希」快速判断画面变化（~50ms，不调 VLM）。
// dHash：缩到 9x8 灰度 → 相邻像素比较 → 64 bit 指纹。两帧汉明距离 > 5 就算变了。
// ── 画面 dHash（2026-11-09 三十五轮：从 Python 搬到 Rust）──────────────
//
// 为什么搬：Python 版实测 **283ms**（解释器启动 + Pillow 导入 + ImageGrab + resize 全在里面），
// 而它是**每个验证动作都要跑两次**的成本。Rust 版实测 **39ms**，快 7.3 倍。
//
// 为什么 Rust 不是更快：39ms 里约 30ms 是 BitBlt/StretchBlt 读全屏像素，
// 这部分是 GDI 的极限。要再往下走只能用 WGC（Windows Graphics Capture，GPU 侧读取），
// 那是另一个量级的工程量（WinRT + D3D11 + 消息泵），等真有性能投诉再做。
let _coreBinCache = null;
function _coreBin() {
    if (_coreBinCache !== null) return _coreBinCache;
    try {
        const root = findProjectRoot(path.resolve(__dirname, '..', '..', '..', '..'));
        const exe = process.platform === 'win32' ? 'pet-core.exe' : 'pet-core';
        const cand = path.join(root, 'pet-core', 'target', 'release', exe);
        _coreBinCache = require('fs').existsSync(cand) ? cand : '';
    } catch (e) { _coreBinCache = ''; }
    return _coreBinCache;
}

// 常驻内核客户端（2026-11-14 四十八轮续）：懒创建，全插件共用一个子进程。
let _coreClient = null;
function getCoreClient(bin) {
    if (_coreClient) return _coreClient;
    try {
        const { getClient } = require('../../../js/core/pet-core-client.js');
        _coreClient = getClient({ bin: bin || _coreBin(), timeoutMs: 8000 });
    } catch (e) {
        // 客户端模块加载失败 → 给一个只支持一次性调用的替身，保证 rustMouse 的
        // `?.call` 不会炸（宁可慢，不能瘫）
        _coreClient = {
            bin: bin || _coreBin(),
            call: () => Promise.resolve({ ok: false, error: '客户端不可用：' + (e && e.message || e) }),
            callOnce: (req) => {
                try {
                    const out = require('child_process').execFileSync(_coreClient.bin, [], {
                        input: JSON.stringify(req), timeout: 8000, encoding: 'utf8', windowsHide: true,
                    });
                    return JSON.parse(String(out || '{}'));
                } catch (e2) { return { ok: false, error: String(e2 && e2.message || e2) }; }
            },
        };
    }
    return _coreClient;
}

/** 内核统计（doctor/体检用：能直接看出常驻有没有起来、服务了几个请求） */
function coreStats() {
    const cli = getCoreClient();
    return cli && typeof cli.stats === 'function' ? cli.stats() : { running: false, bin: _coreBin() };
}

// ── 自身窗口 / 破坏性按钮守卫（2026-11-18 §71，§69.5 的 P0）──────────────
// 两条线都是「错的路走不通，但给正确的路」：
//   ① 落点在她自己的窗口矩形内 → 不发点击。皮套/字幕窗是透明置顶窗，点下去会被自己吃掉；
//      更糟的是长任务里她会把字幕窗当成目标。给的路是 UIA（click_element/som_click/click_text）。
//   ② 按钮名属于「放弃未保存更改」一族 → 默认拒绝。实测日志里她两次点了「不保存」。
//      给的路是带 confirm_destructive:true 重试（拒绝文案里写明）。
// 窗口清单来自主进程 `app-own-windows`（物理像素，已按 scaleFactor 换算）。
// 纯 Node 环境（探针/CLI）没有 ipcRenderer → 清单为空 → 放行，不影响脚本化测试。
const SELF_GUARD = require('./self-guard.js');
const _ownWinCache = { at: 0, list: [] };

async function ownWindowsForGuard() {
    const now = Date.now();
    if (now - _ownWinCache.at < 10000) return _ownWinCache.list;
    try {
        const { ipcRenderer } = require('electron');
        if (ipcRenderer && typeof ipcRenderer.invoke === 'function') {
            const list = await ipcRenderer.invoke('app-own-windows');
            _ownWinCache.list = Array.isArray(list) ? list : [];
            _ownWinCache.at = now;
        }
    } catch (e) { /* 没有 Electron：没有「自己的窗口」这回事 */ }
    return _ownWinCache.list;
}

/** 落点在自己窗口里 → 返回 notSent 结果；否则 null。 */
async function guardOwnWindow(x, y) {
    const list = await ownWindowsForGuard();
    if (!list.length) return null;
    const r = SELF_GUARD.checkPoint(list, x, y);
    if (!r.blocked) return null;
    // 可观测（不能静默拒绝）：首次出现打一行 warn，后续只计数
    try { __silentAudit.audit('game-control:guard-own-window', r.reason); } catch (e) { /* ignore */ }
    return VC.notSent(r.reason, {
        blocked: 'own-window',
        safety: 'self-click',
        ownWindow: r.window ? { id: r.window.id, title: r.window.title } : null,
        nextIfFailed: r.hint,
    });
}

/**
 * 点击原语的**统一前置守卫**（2026-11-21 根因修，P0）。
 *
 * 根因：§71 的 checkButton 只挂在 click_element 一个调用点上，而 click_text / som_click
 * 根本不经过它 —— 编辑器弹「是否保存更改」时 `click_text 不保存` 会直接丢用户数据。
 * 现在三条路径的 UIA Invoke 与坐标点击都经过本函数（actAndVerify* 顶层 + clickAt /
 * uiaElementAction 原语），守卫跟着原语走，不再依赖哪个调用点记得调。
 *
 * @param {{name?:string, source?:string, x?:number, y?:number, confirmDestructive?:boolean}} info
 * @returns {Promise<null|{ok:false, blocked:string, safety:string, reason:string, hint?:string, name?:string, source:string}>}
 *          null = 放行；对象 = 拒绝（reason 是给人看的原因）
 */
async function guardClickTarget(info) {
    const g = info || {};
    const name = String(g.name || '').trim();
    const source = String(g.source || 'click');
    // ① 破坏性按钮（「不保存 / 放弃 / Don't Save」一族）：默认拒绝，除非显式确认
    const chk = SELF_GUARD.checkButton(name, { confirmDestructive: g.confirmDestructive === true });
    // 补盲（2026-11-21 根因修实测）：self-guard 的 DISCARD_RE 要求「放弃更改/放弃修改」这类
    // 带后缀的写法，但中文「是否保存更改」对话框的按钮常常就是**裸标签**：
    //   是(Y) / 否(N) / 放弃 / 不保存
    // 裸「否」在任何保存对话框里都等价于「丢弃更改」。这里按**归一化后精确等于**判定，
    // 不放宽到包含匹配（避免把「否则」「否定」之类误伤）。
    // 注：策略本体仍在 self-guard.js，本次修复范围只在点击层，故在此补齐。
    const bare = name.replace(/&/g, '').replace(/\([^)]*\)/g, '').replace(/[\s.。:：]/g, '').toLowerCase();
    const BARE_DISCARD = new Set(['否', 'no', 'n', '不', '不要', '放弃', '放棄', '丢弃', '丟棄',
        '不保存', '不儲存', "don'tsave", 'discard']);
    if (chk.blocked || (g.confirmDestructive !== true && BARE_DISCARD.has(bare))) {
        try { __silentAudit.audit('game-control:guard-destructive-button', source + ' refused: ' + name.slice(0, 40)); } catch (e) { /* ignore */ }
        return {
            ok: false, blocked: 'destructive-button', safety: 'data-loss',
            reason: chk.blocked ? chk.reason : ('“' + name + '”会丢弃未保存的更改（点下去 = 用户的数据没了）'),
            hint: chk.blocked ? chk.hint : '如果你确定要放弃的是她自己这轮改的东西，带 confirm_destructive:true 重试；否则改用「保存」或先问用户',
            name: name.slice(0, 60), source, bareLabel: !chk.blocked,
        };
    }
    // 破坏性但可能是正常任务：放行 + 记账（不静默）
    if (chk.warning) {
        try { __silentAudit.audit('game-control:guard-destructive-warning', source + ': ' + chk.warning, { quiet: true }); } catch (e) { /* ignore */ }
    }
    // ② 落点在自己窗口里（透明皮套/字幕窗）：坐标点击一律拒绝
    const px = Number(g.x);
    const py = Number(g.y);
    if (Number.isFinite(px) && Number.isFinite(py)) {
        const self = await guardOwnWindow(px, py);
        if (self) {
            return {
                ok: false, blocked: 'own-window', safety: 'self-click',
                reason: String(self.detail || '落点在她自己的窗口里'),
                hint: self.nextIfFailed, source, ownWindow: self.ownWindow || null,
            };
        }
    }
    return null;
}

/** 守卫拒绝 → 带稳定否决码的 Error（index.js 的 catch 会转成 not_sent，action_sent:false）。 */
function throwClickGuard(g) {
    const e = new Error(String(g.reason || '点击被安全守卫拒绝') + (g.hint ? '（' + g.hint + '）' : ''));
    e.vetoCode = VETO.GUARD_BLOCKED;
    e.guardBlocked = String(g.blocked || 'guard');
    e.blocked = e.guardBlocked;
    if (g.hint) e.nextIfFailed = g.hint;
    throw e;
}

/** 原语入口的便捷形式：拒绝就 throw，放行返回 undefined。 */
async function assertClickGuard(info) {
    if (!info) return;
    const g = await guardClickTarget(info);
    if (g) throwClickGuard(g);
}

/**
 * UIA 语义动作（2026-11-14 四十八轮续）。
 * action: invoke / set_value / get_value / focus / perform_action / actions
 * rid 来自 snapshot 返回的 elements[].rid（RuntimeId 串）。
 */
async function coreUiaAction(target, rid, action, value, guard) {
    // 点击类（invoke）也要过统一守卫：Rust 的 UIA 直调同样会按下「不保存」。
    // set_value / get_value / select_text 等不是点击，不触发破坏性按钮策略。
    if (String(action || '') === 'invoke') await assertClickGuard(guard);
    const bin = _coreBin();
    if (!bin) return { ok: false, error: 'pet-core 不可用（先 cd pet-core && cargo build --release）' };
    const req = {
        cmd: 'uia_action',
        target: String(target || ''),
        rid: String(rid || ''),
        action: String(action || 'actions'),
    };
    if (value !== undefined && value !== null) req.value = String(value);
    const cli = getCoreClient(bin);
    return cli.call(req, 12000);
}

/**
 * 窗口生命周期（2026-11-15 五十八轮）：min / max / restore / close / move / size / all_min
 *
 * 为什么补这一层：工具面此前只有 focus 和 launch —— 日常最想说的「把这个窗口挪开」
 * 「最小化」「关掉」全都做不到。而「最小化全部」当时映射成 press_key win+d，
 * 又在 Win 键白名单处被直接 REJECT（实测），那条路**从来就不可能成功**。
 *
 * 为什么复核写在 Rust 里：min/max 是异步的，返回「已发送」不等于成了；
 * pet-core 在动作后 sleep 120ms 再读回真实 iconic/rect，所以这里的 ok 是真状态。
 */
async function windowOp(target, op, opts) {
    const bin = _coreBin();
    if (!bin) return { ok: false, error: 'pet-core 不可用（先 cd pet-core && cargo build --release；或 pet-core.exe 被占用）' };
    const o = opts || {};
    const req = { cmd: 'window_op', target: String(target || ''), op: String(op || '') };
    for (const k of ['x', 'y', 'w', 'h']) {
        if (o[k] !== undefined && o[k] !== null && o[k] !== '' && Number.isFinite(Number(o[k]))) req[k] = Number(o[k]);
    }
    // 唯一解析入口（2026-11-21 P2）：除 all_min（语义是「按过滤条件枚举多个窗口」）外，
    // 一律先解析成 hwnd 再交给 Rust —— 后端不再按标题找一次，同名窗口不会各选各的。
    let resolved = null;
    if (req.op !== 'all_min') {
        const rz = await resolveTargetHwnd(req.target);
        if (!rz || rz.ok === false) {
            return {
                ok: false, unresolved: true,
                error: (rz && rz.error) || ('窗口解析失败：' + (target || '(空)')),
                resolveDetail: (rz && rz.detail) || '',
            };
        }
        req.target = String(rz.hwnd);
        resolved = { hwnd: rz.hwnd, title: rz.title, multiHit: rz.multiHit === true, detail: rz.detail };
        if (rz.multiHit) {
            try { __silentAudit.audit('game-control:window-op-multi-hit', rz.detail); } catch (e) { /* ignore */ }
        }
    }
    let out = null;
    try {
        const cli = getCoreClient(bin);
        out = (await cli.call(req, 10000)) || { ok: false, error: '空回复' };
    } catch (e) {
        out = { ok: false, error: String(e && e.message || e) };
    }
    if (resolved) {
        out.resolvedHwnd = resolved.hwnd;
        out.resolvedTitle = resolved.title;
        out.multiHit = resolved.multiHit;
        out.resolveDetail = resolved.detail;
    }
    // 回读失败可观测（min/restore/close 的「ok=true 但状态没变」是本次修复的重点）
    if (out.ok === false && ['min', 'restore', 'close'].includes(req.op)) {
        CONTROL_STATS.windowOpReadbackFails += 1;
        try {
            __silentAudit.audit('game-control:window-op-readback-fail',
                req.op + ' hwnd=' + req.target + ' error=' + String(out.error || '').slice(0, 120));
        } catch (e) { /* ignore */ }
    }
    return out;
}

/**
 * UIA 全文读取（2026-11-15 六十轮）。
 * 为什么：see mode=text 原来只走 OCR —— 全窗实测 4.87s，还会把 l 认成 1。
 * 原生文本控件（记事本/浏览器 document/各种 Edit）本来就能通过 UIA TextPattern 直接给文字，
 * 毫秒级且零识别误差。OCR 退化成兜底。
 */
async function coreUiaText(target, maxChars) {
    const bin = _coreBin();
    if (!bin) return { ok: false, error: 'pet-core 不可用' };
    try {
        const cli = getCoreClient(bin);
        const r = await cli.call({ cmd: 'uia_text', target: String(target || ''), max: Number(maxChars) || 8000 }, 10000);
        return r || { ok: false, error: '空回复' };
    } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
    }
}

/**
 * 「动作前确保目标在前台」——click_at/mouse/type_text 里那段重复逻辑，
 * 2026-11-14 收口成一个。失败时返回已构造好的 notSent verdict，调用方直接 return。
 */
async function focusOrVeto(focus, what) {
    if (!focus) return { ok: true, expTitle: '' };
    let fc = await assertTargetFocused(focus, { strict: true });
    if (!fc.ok) {
        // schema 里 focus 的语义就是「先调到前台再动作」——那就真去聚焦一次
        await focusWindow(focus, { force: false });
        await new Promise((r) => setTimeout(r, 240));
        fc = await assertTargetFocused(focus, { strict: true });
    }
    if (!fc.ok) {
        return {
            ok: false,
            res: VC.notSent('没' + (what || '做') + '：' + fc.error, {
                vetoCode: VETO.FOCUS_LOST,
                targetPid: Number(fc.targetPid) || 0,
                fgPid: Number(fc.fgPid) || 0,
                nextIfFailed: '先 focus_window "' + focus + '"；或确认目标窗口能到前台（全屏置顶游戏挡住的 Windows 限制无解）',
            }),
        };
    }
    return { ok: true, expTitle: (fc.fg && fc.fg.title) || '' };
}

async function screenHash() {
    // ① Rust（39ms，带精确计时）
    const bin = _coreBin();
    if (bin) {
        const r = await new Promise((resolve) => {
            try {
                const { execFile } = require('child_process');
                const child = execFile(bin, [], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 },
                    (err, stdout) => {
                        if (err) return resolve(null);
                        try {
                            const d = JSON.parse(String(stdout));
                            resolve(d && d.ok && /^[0-9a-f]{16}$/i.test(String(d.hash)) ? String(d.hash) : null);
                        } catch (e) { resolve(null); }
                    });
                try { child.stdin.end('{"cmd":"screen_hash"}', 'utf8'); } catch (e) { resolve(null); }
            } catch (e) { resolve(null); }
        });
        if (r) return r;
    }
    // ② Python 兜底（283ms，慢但能用）
    return new Promise((resolve) => {
        try {
            const { execFile } = require('child_process');
            const py = resolvePython();
            const root = findProjectRoot(path.resolve(__dirname, '..', '..', '..', '..'));
            const script = path.join(root, 'pet-runtime', 'tools', 'screen-hash.py');
            if (!require('fs').existsSync(script)) return resolve(null);
            execFile(py, [script], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
                if (err) return resolve(null);
                const h = String(stdout || '').trim();
                resolve(/^[0-9a-f]{16}$/i.test(h) ? h : null);
            });
        } catch (e) { resolve(null); }
    });
}

/**
 * 测量「画面本身的抖动」—— 连续采 3 次，取两两 hamming 的最大值。
 *
 * ⚠ 为什么需要这个（2026-11-09 实测出来的认知，比调 dHash 参数重要得多）：
 *   dHash 只在**画面相对静止**时才可信。实测：终端在刷新的场景下，
 *   连续 12 次采样两两 hamming 中位 27、max 40 —— 这不是 hash 不稳定，
 *   是**屏幕真的在变**。此时「动作前后 hash 不同」根本说明不了动作生效了。
 *
 *   所以正确做法不是调参数，而是**先验证验证手段本身是否可用**：
 *   基线抖动大 → 本次验证不可信，诚实标 unverified（而不是误报 confirmed 或 suspected_noop）。
 *
 * @returns {Promise<{jitter:number, stable:boolean, samples:number}>}
 */
async function baselineJitter(samples) {
    const n = Math.max(2, Math.min(5, Number(samples) || 3));
    const hashes = [];
    for (let i = 0; i < n; i += 1) {
        const h = await screenHash();
        if (h) hashes.push(h);
        if (i < n - 1) await new Promise((r) => setTimeout(r, 120));
    }
    if (hashes.length < 2) return { jitter: null, stable: false, samples: hashes.length, error: '拍不到画面' };
    let maxD = 0;
    for (let i = 0; i < hashes.length; i += 1) {
        for (let j = i + 1; j < hashes.length; j += 1) {
            maxD = Math.max(maxD, hamming(hashes[i], hashes[j]));
        }
    }
    // 阈值 10：实测静止画面抖动中位 4 / max 9；画面在动时中位 27。
    // 取 10 是「略高于静止抖动上限、远低于动态抖动」的分界。
    return { jitter: maxD, stable: maxD <= 10, samples: hashes.length };
}

function hamming(a, b) {
    if (!a || !b || a.length !== b.length) return 99;
    let d = 0;
    for (let i = 0; i < a.length; i += 1) {
        const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
        // 数 bit
        d += ((x & 1) ? 1 : 0) + ((x & 2) ? 1 : 0) + ((x & 4) ? 1 : 0) + ((x & 8) ? 1 : 0);
    }
    return d;
}

/**
 * UIA 树签名（L2 验证）：拿一个窗口的元素指纹，用来判断「UI 结构变没变」。
 *
 * ⚠ 为什么需要这条通道（2026-11-09 实测）：
 *   像素 dHash 在画面有动画时完全失效（基线抖动 27-40）。
 *   但「UI 结构」不受动画影响 —— 点开一个菜单，元素数从 60 变 80，
 *   这个信号是确定的、和画面动不动无关。
 *
 * 代价：一次 snapshot 要走 UIA 服务（几百 ms），比 dHash 慢一个量级。
 * 所以只在**像素对比不可信时**才用（见 actAndVerify 的 l2Fallback）。
 *
 * @returns {Promise<string|null>} 形如 "n=60|h=a1b2c3d4" 的签名，失败返回 null
 */
async function uiaTreeSignature(title) {
    try {
        if (!(await ensureUiaService())) return null;
        const r = await _uiaPost('/elements', { title: String(title || ''), max: 120 }, 8000);
        if (!r || !r.ok || !Array.isArray(r.elements)) return null;
        // 签名 = 元素数 + 排序后的「类型:名称」串的 sha1 前 8 位
        // 排序是为了让「元素顺序变了但内容没变」不算变化（有些应用会重排）
        const items = r.elements
            .map((e) => String(e.type || '') + ':' + String(e.name || '').slice(0, 40))
            .sort();
        const h = require('crypto').createHash('sha1').update(items.join('\n')).digest('hex').slice(0, 8);
        return 'n=' + r.elements.length + '|h=' + h;
    } catch (e) {
        try { __silentAudit.audit('game-control.js:uiaTreeSignature', e); } catch (e2) { /* ignore */ }
        return null;
    }
}

/**
 * 执行一个动作并验证画面是否真的变了。
 * @param {Function} actionFn 要执行的动作
 * @param {object} opts { expectChange: bool, timeoutMs, pollMs }
 */
// ── 局部区域灰度（2026-11-10 三十七轮）：actAndVerify 的游戏内验证通道 ──────
// pet-core 的 region_gray：GDI BitBlt 局部 + 12×10 灰度 + mean/std。
// 实测：10.9ms（比 wgc_shot 快 44 倍）、出界自动 clamp、3 次连测零抖动。
async function regionGray(x, y, w, h, displayRect) {
    const bin = _coreBin();
    if (!bin) return null;
    return await new Promise((resolve) => {
        let child;
        try { child = spawn(bin, [], { windowsHide: true }); } catch (e) { return resolve(null); }
        let out = '';
        let timer = null;
        const fin = (v) => { if (timer) { try { clearTimeout(timer); } catch (e0) { /* ignore */ } timer = null; } resolve(v); };
        child.stdout.on('data', (c) => { out += c; });
        child.on('error', () => fin(null));
        child.on('close', () => { try { const d = JSON.parse(out); fin(d && d.ok ? d : null); } catch (e) { fin(null); } });
        const req = { cmd: 'region_gray', x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
        // P0-3（2026-11-25）：把**目标显示器**的 origin/size 一起传下去。
        // 为什么不靠 Rust 自己算主屏：region_gray 原来用 SM_CXSCREEN/SM_CYSCREEN 并把坐标
        // `max(0)` 钳到主屏 —— 副屏（负坐标）/移出屏幕的窗口全部采到主屏左上，
        // 验证采的根本不是目标窗口。Rust 侧已改为「有这块屏就钳到这块屏，否则钳虚拟屏」。
        if (displayRect && Number.isFinite(Number(displayRect.x)) && Number.isFinite(Number(displayRect.w))) {
            req.dx = Math.round(Number(displayRect.x));
            req.dy = Math.round(Number(displayRect.y));
            req.dw = Math.round(Number(displayRect.w));
            req.dh = Math.round(Number(displayRect.h));
        }
        child.stdin.write(JSON.stringify(req));
        child.stdin.end();
        timer = setTimeout(() => { try { child.kill(); } catch (e) { /* 已退出 */ } fin(null); }, 4000);
        if (timer.unref) timer.unref();
    });
}

/**
 * 按**目标元素矩形**采局部灰度（P0-3：像素通道只采元素，不再采整个窗口）。
 * 规则：
 *   · 矩形归一化；宽高不足 16（region_gray 的下限）时向外扩到 16 —— 小图标也能采；
 *   · 显示器矩形来自所有显示器并集（pointOnAnyScreen），传给 Rust 做精确钳位；
 *   · 完全不在任何显示器上（屏外）→ 返回 null（调用方按「不能采样」处理，不猜）。
 */
async function regionGrayForRect(rect) {
    const r = geometry.normalizeRect({
        x: Number(rect && rect.x), y: Number(rect && rect.y),
        w: Number(rect && (rect.w !== undefined ? rect.w : rect.width)),
        h: Number(rect && (rect.h !== undefined ? rect.h : rect.height)),
    });
    if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.w) || !Number.isFinite(r.h)) return null;
    if (r.w <= 0 || r.h <= 0) return null;
    const w = Math.max(16, Math.min(4096, Math.round(r.w)));
    const h = Math.max(16, Math.min(4096, Math.round(r.h)));
    // 小控件扩到 16 时向四周均摊（不是只往右下扩），采样中心仍在元素上
    const x0 = Math.round(r.x - (w - r.w) / 2);
    const y0 = Math.round(r.y - (h - r.h) / 2);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const { rects } = screenRects();
    const display = pointOnAnyScreen(cx, cy, rects) || null;
    if (!display) return null;   // 元素中心不在任何屏幕上：采样一定是旧帧，不猜
    return await regionGray(x0, y0, w, h, display);
}

/**
 * 回读单个 UIA 元素的可观察状态（P0-3 的首选验证通道）。
 * @param {number|string} hwnd 目标窗口（唯一无歧义的身份）
 * @param {string} rid RuntimeId（click_element 有；som_click 没有）
 * @param {string} title 标题（没有 hwnd 时的兜底解析）
 * @param {string} name 元素名（没有 rid 时按名找，som_click 用）
 * @param {string} ctype 控件类型（配合 name 降低误配）
 * @returns {Promise<object>} {ok, found, name, ctype, enabled, offscreen, focused,
 *                             toggleState, value, selected, expandState, iconic, x,y,w,h, pid}
 */
async function uiaElementState(hwnd, rid, title, name, ctype) {
    if (!(await ensureUiaService())) return { ok: false, found: false, error: 'uia-service 不可用（无 UIA 回读通道）' };
    const body = {
        hwnd: Number(hwnd) || 0,
        rid: String(rid || ''),
        name: String(name || ''),
        ctype: String(ctype || ''),
    };
    if (!body.hwnd) body.title = String(title || '');
    if (!body.rid && !body.name) return { ok: false, found: false, error: '没有元素身份（rid/name 都缺）' };
    const r = await _uiaPost('/element_state', body, 3000);
    if (!r || typeof r !== 'object') return { ok: false, found: false, error: 'element_state 没有响应' };
    return r;
}

/**
 * 目标窗口/元素的可验证性信号（P0-3）：最小化 / 屏外 / 遮挡。
 * 判定口径与 control-verify.classifyVisibility 一致：只要有一条成立，**像素通道就不作数**。
 * 失败一律返回 null 字段（= 不知道），绝不默认「可见」。
 *
 * @param {number} hwnd 目标 hwnd（0 = 只能用标题兜底）
 * @param {string} title 目标标题
 * @param {object} point 元素中心 {x,y}（给 WindowFromPoint 遮挡探针）
 * @param {object} state 已经回读到元素状态时直接复用 iconic/offscreen
 */
async function clickTargetVisibility(hwnd, title, point, state) {
    const out = { minimized: false, offscreen: false, occluded: false, detail: '' };
    const st = state || null;
    if (st && (st.iconic === true || st.minimized === true)) out.minimized = true;
    if (st && st.offscreen === true) out.offscreen = true;

    // 窗口矩形 / 最小化态（uia-service /rect 实测 <10ms；失败不阻止动作，只让像素通道失效）
    let wr = null;
    try { wr = await windowRealRect(title || ''); } catch (e) { wr = null; }
    if (wr) {
        if (wr.iconic === true) out.minimized = true;
        const { rects } = screenRects();
        if (wr.w > 0 && wr.h > 0 && !CV.windowOnScreens(wr, rects)) {
            out.offscreen = true;
            out.detail = '窗口 ' + wr.w + '×' + wr.h + '@' + wr.x + ',' + wr.y + ' 不在任何显示器上';
        }
    }

    // 落点遮挡：WindowFromPoint 的根窗口不是目标窗口 → 像素采到的是遮挡者
    const px = Number(point && point.x);
    const py = Number(point && point.y);
    if (Number.isFinite(px) && Number.isFinite(py)) {
        try {
            const bin = _coreBin();
            if (bin) {
                const rr = await getCoreClient(bin).call({ cmd: 'window_from_point', x: Math.round(px), y: Math.round(py) }, 3000);
                if (rr && rr.ok) {
                    const rootHwnd = Number(rr.rootHwnd) || 0;
                    if (Number(hwnd) > 0 && rootHwnd > 0 && rootHwnd !== Number(hwnd)) {
                        out.occluded = true;
                        out.detail = '落点属于「' + String(rr.rootTitle || ('hwnd ' + rootHwnd)) + '」，不是目标窗口';
                    } else if (!Number(hwnd) && rr.rootTitle && title
                        && !String(rr.rootTitle).toLowerCase().includes(String(title).toLowerCase())) {
                        out.occluded = true;
                        out.detail = '落点属于「' + String(rr.rootTitle) + '」，不是「' + title + '」';
                    }
                }
            }
        } catch (e) { /* 探针失败 = 不知道，不据此判遮挡 */ }
    }
    return out;
}



/** 两次局部灰度特征的差：最大格差 + mean/std 差。不可比返回 null。 */
function regionDelta(a, b) {
    if (!a || !b || !Array.isArray(a.gray) || !Array.isArray(b.gray)) return null;
    if (a.gray.length !== b.gray.length || !a.gray.length) return null;
    let maxCell = 0;
    for (let i = 0; i < a.gray.length; i += 1) {
        const d = Math.abs(a.gray[i] - b.gray[i]);
        if (d > maxCell) maxCell = d;
    }
    return {
        maxCell,
        meanD: Math.abs((a.mean || 0) - (b.mean || 0)),
        stdD: Math.abs((a.std || 0) - (b.std || 0)),
    };
}

/** 局部区域的时间抖动：同一块区域连采 N 次，返回两两之间最大格差/均值差。
 *  用途：区分「这块区域自己在动」（视频/动画/游戏）和「我的动作让它变了」。
 *  为什么按 region 采样而不是全屏：屏幕上别处放视频不该把局部判定判成「验不了」。 */
async function regionJitter(region, samples) {
    const n = Math.max(2, Math.min(5, Number(samples) || 3));
    const frames = [];
    for (let i = 0; i < n; i += 1) {
        const g = await regionGray(region.x, region.y, region.w, region.h);
        if (g) frames.push(g);
        if (i < n - 1) await new Promise((r) => setTimeout(r, 120));
    }
    if (frames.length < 2) return { maxCell: null, meanD: null, samples: frames.length, error: '拍不到局部画面' };
    let maxCell = 0;
    let meanD = 0;
    for (let i = 0; i < frames.length; i += 1) {
        for (let j = i + 1; j < frames.length; j += 1) {
            const d = regionDelta(frames[i], frames[j]);
            if (!d) continue;
            if (d.maxCell > maxCell) maxCell = d.maxCell;
            if (d.meanD > meanD) meanD = d.meanD;
        }
    }
    return { maxCell, meanD, samples: frames.length };
}

async function actAndVerify(actionFn, opts) {
    const o = opts || {};
    // ── 统一守卫（2026-11-21 P0）─────────────────────────────────────
    // 三条点击路径都经过这里；守卫放在**任何截图/基线采样之前**，
    // 拒绝时 actionFn 一次都不会被调用（后端调用 0 次）。
    // 原语（clickAt / uiaElementAction）里还有第二道，防止将来新调用点漏传。
    if (o.guard && o.guard.name) {
        const g = await guardClickTarget(o.guard);
        if (g) throwClickGuard(g);
    }
    const expectChange = o.expectChange !== false;
    const timeoutMs = Number(o.timeoutMs) || 1800;

    // ── 局部区域验证（2026-11-10 三十七轮）────────────────────────────
    // 为什么要有：全屏 9×8 dHash 对游戏内局部变化（60×60 格子种一株植物、卡片高亮）
    // 是**验证盲区** —— PVZ 实测种植成功但 hamming=0，被误报 noop（假失败）。
    // 有 o.region（点击点 ±110px）时改用 pet-core 的 region_gray：
    //   GDI BitBlt 局部 40ms 级（比 wgc_shot 快 44 倍），12×10 灰度 + mean/std，
    //   实测 3 次连测零抖动。changed = 最大格差 > 6 或 mean 差 > 2.5。
    const useRegion = o.region && Number.isFinite(o.region.x) && Number.isFinite(o.region.w);
    const grab = useRegion
        ? () => regionGray(o.region.x, o.region.y, o.region.w, o.region.h)
        : screenHash;
    // 局部阈值先给保守默认值，下面采到基线后按噪声自适应（见 regionThr 赋值）
    const regionThr = { cell: 6, mean: 2.5 };
    const compare = useRegion
        ? (a, b) => {
            const d = regionDelta(a, b);
            if (d === null) return null;
            return (d.maxCell > regionThr.cell || d.meanD > regionThr.mean) ? 99 : 0;
        }
        : (a, b) => hamming(a, b);

    // ⚠ 2026-11-09 三十五轮：先验「画面本身静不静」。
    //   画面一直在动（看视频/打游戏/终端刷新）时，前后对比毫无意义 ——
    //   此时宁可诚实说「验不了」，也不要误报 confirmed 或 suspected_noop。
    //   代价：多采 2 次 hash（Rust 版每次 39ms，共 +80ms）。
    if (o.skipBaseline !== true && useRegion) {
        // 局部判定：只采这块区域自己的噪声，并用它反推阈值。
        // 实测动机：桌面上别处放视频时，全屏基线抖 27 → 原来的实现直接判「验不了」，
        // 而点击的那块区域其实完全静止、变化清晰可见。
        const rj = await regionJitter(o.region, 3);
        if (rj.maxCell !== null) {
            if (rj.maxCell > 24 || rj.meanD > 8) {
                const actionResult0 = await actionFn();
                return {
                    ok: actionResult0 && actionResult0.ok !== false,
                    actionResult: actionResult0,
                    verified: false,
                    note: '这块区域本身在动（局部噪声 maxCell=' + rj.maxCell + ' / meanD=' + rj.meanD.toFixed(1) + '）—— 前后对比不可信',
                    jitter: rj.maxCell,
                };
            }
            // 自适应：阈值 = max(原阈值, 噪声 × 2.5 + 2)，静态场景几乎不变，微动画场景不再误判
            regionThr.cell = Math.max(6, Math.round(rj.maxCell * 2.5 + 2));
            regionThr.mean = Math.max(2.5, rj.meanD * 2.5);
        }
    }
    if (o.skipBaseline !== true && !useRegion) {
        const base = await baselineJitter(3);
        if (base.jitter !== null && !base.stable) {
            const actionResult0 = await actionFn();
            return {
                ok: actionResult0 && actionResult0.ok !== false,
                actionResult: actionResult0,
                verified: false,
                note: '画面本身在动（基线抖动 ' + base.jitter + '，静止时应 ≤10）—— 前后对比不可信',
                jitter: base.jitter,
            };
        }
    }

    const before = await grab();
    const actionResult = await actionFn();
    if (before === null) {
        return { ok: actionResult && actionResult.ok !== false, actionResult, verified: false, note: '拍不到画面，无法验证（按动作返回值判断）' };
    }
    const t0 = Date.now();
    let after = null;
    let captureFailed = false;
    while (Date.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 320));
        after = await grab();
        // ⚠ 2026-11-10 审计抓到（把「没查成」报告成「查过了」）：原来 after===null 直接 break，
        //   随后 finalDist=null 仍返回 `verified:true, changed:false` → 上层变成
        //   `suspected_noop`（证据写着「像素距离 null」）——和之前修的 OCR 超时同一种病。
        if (after === null) { captureFailed = true; break; }
        const dist = compare(before, after);
        const changed = dist !== null && dist > 5;
        if (expectChange ? changed : !changed) {
            return { ok: true, actionResult, verified: true, changed, dist, elapsed: Date.now() - t0, tier: 'L1',
                     ...(useRegion ? { via: 'region' } : {}) };
        }
    }
    if (captureFailed && after === null) {
        return {
            ok: actionResult && actionResult.ok !== false,
            actionResult,
            verified: false,
            note: '轮询期间抓不到画面（' + (useRegion ? 'region_gray' : 'screen_hash') + ' 采集失败）——无法判断有没有变化，按动作返回值判断',
            tier: 'L1',
            ...(useRegion ? { via: 'region' } : {}),
        };
    }
    const finalDist = useRegion ? regionDelta(before, after) : (after ? hamming(before, after) : null);
    return {
        ok: false,
        actionResult,
        verified: true,
        changed: false,
        dist: finalDist ? (finalDist.maxCell !== undefined ? finalDist.maxCell : finalDist) : null,
        elapsed: Date.now() - t0,
        tier: 'L1',
        ...(useRegion ? { via: 'region', regionDetail: finalDist || undefined } : {}),
        hint: '画面在 ' + timeoutMs + 'ms 内没有明显变化 —— 可能被弹窗挡住 / 卡槽冷却 / 位置不对 / 动作真的没生效',
    };
}

/**
 * 带 UIA 树后备的验证（L1 像素 → L2 UI 树）。
 *
 * 流程：
 *   ① 先测基线抖动。稳定 → 走纯像素对比（39ms×3，最便宜的确定信号）
 *   ② 不稳定（画面在动）→ 走 UIA 树对比（几百 ms，但不受动画影响）
 *   ③ 两条都不行 → 诚实返回 unverifiable
 *
 * @param {Function} actionFn
 * @param {object} opts { expectChange, timeoutMs, uiaTitle }
 *   uiaTitle 是目标窗口标题 —— 没有它就没法走 L2，只能 L1。
 */
async function actAndVerifySmart(actionFn, opts) {
    const o = opts || {};
    // 同 actAndVerify：守卫先于基线采样/动作，拒绝时后端 0 调用（2026-11-21 P0）
    if (o.guard && o.guard.name) {
        const g = await guardClickTarget(o.guard);
        if (g) throwClickGuard(g);
    }
    // ⚠ 2026-11-10 三十九轮实测抓到：原来**先看全屏稳不稳**——桌面静止时 stable=true，
    //   直接走全屏 dHash；而小窗口里的小变化（计算器 555→0、7×8=56）在全屏哈希上根本看不出来，
    //   Invoke 明明生效却报 suspected_noop，她以为点不动 → 反复重试/放弃。
    //   现在：**只要给了 region 就优先走局部对比**（更精确的证据不需要先问全屏）。
    const wantRegion0 = !!(o.region && Number.isFinite(o.region.x));
    // ⚠ 2026-11-10 审计抓到我自己的回归：`base` 原来声明在下面的 if 块里，
    //   而失败分支（region 没验出 / 无 UIA 签名 / 无窗口）在块外引用 `base.jitter`
    //   → ReferenceError，被 index.js 的 catch 转成 not_sent，把「发出去了但没效果」
    //   谎报成「没发出去」（LLM 会重试 = 点两遍）。现在提到函数顶层，默认 {jitter:null}。
    let base = { jitter: null, stable: false };
    if (!wantRegion0) {
        base = await baselineJitter(3);
        if (base.jitter !== null && base.stable) {
            return actAndVerify(actionFn, Object.assign({}, o, { skipBaseline: true }));
        }
    }

    // 画面在动：如果知道目标窗口，走 UIA 树对比；有 region 先走局部对比（游戏 UIA 是空壳时的主通道）
    if (o.uiaTitle || (o.region && Number.isFinite(o.region.x))) {
        // ⚠ actionFn 只能调一次（click 两次 = 做两遍）——所以 before 全部先取，action 一次，验证按序落。
        //   ① region 局部对比（2026-11-10 三十七轮）：区域动画抖动远小于全屏 —— 游戏里僵尸在走、
        //      阳光在掉，全屏基线永远"在动"，但点击点 ±110px 的格子常常是静的。阈值比稳定态
        //      略高（maxCell > 8 / meanD > 3.5）以容忍区域内的小动画。
        //   ② region 没验出 → 落 UIA 树（原生对话框有效；游戏 UIA 空壳时这里会诚实 unverifiable）。
        const wantRegion = o.region && Number.isFinite(o.region.x);
        const beforeRegion = wantRegion
            ? await regionGray(o.region.x, o.region.y, o.region.w, o.region.h)
            : null;
        const beforeSig = o.uiaTitle ? await uiaTreeSignature(o.uiaTitle) : null;
        const actionResult = await actionFn();
        const t0 = Date.now();
        if (beforeRegion) {
            let regionOk = false;
            let lastDelta = null;
            for (const w of [350, 450]) {
                await new Promise((r) => setTimeout(r, w));
                const afterRegion = await regionGray(o.region.x, o.region.y, o.region.w, o.region.h);
                const d = regionDelta(beforeRegion, afterRegion);
                lastDelta = d;
                if (d && (d.maxCell > 8 || d.meanD > 3.5)) {
                    regionOk = true;
                    break;
                }
            }
            // ── P0-3（2026-11-25）：region 变化只能当**辅助信号**，不能单独判成功 ──
            // 旧实现是「region 一变化就先判成功，连 UIA 树都不看」：窗口被遮挡时，
            // 采样到的根本不是目标窗口的像素（视频/遮挡者的动画），一次没生效的点击
            // 会被报成 confirmed。现在采样后必须再确认「这块像素确实属于前台目标窗口」；
            // 确认不了就把 region 证据作废，继续走 UIA 树 / 诚实失败。
            // 说明：本函数的调用方只剩已强制前台的坐标动作（click_at / mouse / scroll / drag /
            // pvz / click_text）；后台 UIA 动作（click_element / som_click）已改走
            // control-verify.js 的元素矩形通道，不再经过这里。
            let regionVeto = null;
            if (regionOk) {
                const fgChk = o.uiaTitle ? await assertTargetFocused(o.uiaTitle, { strict: false }) : null;
                if (!fgChk || fgChk.ok === true) {
                    return {
                        ok: true, actionResult, verified: true, changed: true,
                        dist: lastDelta.maxCell, elapsed: Date.now() - t0, tier: 'L1',
                        via: 'region-dynamic', regionDetail: lastDelta,
                        ...(fgChk ? { regionFgConfirmed: true } : {}),
                    };
                }
                regionVeto = fgChk;
            }
            // 局部没验出：如果连 UIA 都没有，别假装 —— 诚实返回（但带上 region 证据）
            if (!beforeSig) {
                return {
                    ok: actionResult && actionResult.ok !== false,
                    actionResult, verified: false, jitter: base.jitter,
                    dist: lastDelta ? lastDelta.maxCell : null, elapsed: Date.now() - t0,
                    via: 'region-dynamic',
                    note: regionVeto
                        // region 变了但前台不是目标 → 那块像素不是目标的像素，证据作废
                        ? ('局部区域有变化，但采样时前台不是「' + o.uiaTitle + '」（' + (regionVeto.error || '') + '）——变化可能是遮挡者的动画，不能算成功')
                        : ('画面在动（抖动 ' + base.jitter + '）；局部区域（±' + Math.round(o.region.w / 2) + 'px）前后也没变化，UIA 树又拿不到 —— 两条通道都验不出'),
                    hint: regionVeto
                        ? '先把目标窗口调到前台（focus_window）再看画面；遮挡时屏幕像素不能当证据'
                        : '局部区域没变 = 点击大概率没生效（被遮挡/点空/冷却）。用 som_snapshot 看现场，或确认目标窗口在最上层',
                };
            }
        }
        // 有 UIA 签名 → 继续走下面的 UIA 对比（actionResult 已有，不重复执行动作）
        if (beforeSig) {
            // ⚠ 轮询策略（2026-11-09 优化）：一次 snapshot 要 ~500ms，无脑轮询会让
            //   L2 通道跑到 4 秒以上。实测 UI 结构变化通常在 300-600ms 内完成，
            //   所以只做「2 次采样」：400ms 后一次，不行再等 500ms 一次。
            //   总成本 ~1.4s，比轮询快 3 倍，覆盖绝大多数情况。
            const t0 = Date.now();
            const waits = [400, 500];
            let afterSig = null;
            for (const w of waits) {
                await new Promise((r) => setTimeout(r, w));
                afterSig = await uiaTreeSignature(o.uiaTitle);
                if (afterSig && afterSig !== beforeSig) {
                    return {
                        ok: true, actionResult, verified: true, changed: true,
                        dist: null, elapsed: Date.now() - t0, tier: 'L2',
                        note: 'UI 结构变了（' + beforeSig + ' → ' + afterSig + '）',
                    };
                }
            }
            return {
                ok: false, actionResult, verified: true, changed: false,
                dist: null, elapsed: Date.now() - t0, tier: 'L2',
                note: 'UI 结构没变（' + beforeSig + '），画面虽然在动但界面没响应',
                hint: 'UI 树没变通常意味着：动作没生效 / 点到了不可交互的元素 / 界面被遮挡',
            };
        }
        // 拿不到 UIA 签名（窗口无 UIA 树）→ 只能标不可验证
        // ⚠ 2026-11-10 审计抓到：这里原来又调了一次 `actionFn()` —— 函数自己上面的注释
        //   写着「actionFn 只能调一次（click 两次 = 做两遍）」，正好违反。一次点击变两次点击
        //   （双击语义/重复种植/重复提交）。现在复用上面已经执行过的 actionResult。
        return {
            ok: actionResult && actionResult.ok !== false,
            actionResult,
            verified: false,
            jitter: base.jitter,
            note: '画面在动（抖动 ' + (base.jitter === null ? '未测' : base.jitter) + '）且拿不到 UIA 树签名，两条验证通道都不可用',
        };
    }

    // 画面在动且不知道目标窗口 → 诚实说验不了（此路径没进上面的 if，actionFn 是第一次执行）
    const actionResult3 = await actionFn();
    return {
        ok: actionResult3 && actionResult3.ok !== false,
        actionResult: actionResult3,
        verified: false,
        jitter: base.jitter,
        note: '画面本身在动（基线抖动 ' + base.jitter + '，静止时应 ≤10），且没给 uiaTitle 无法走 UI 树对比',
    };
}

// ── 常驻 UIA 服务（2026-11-09）──────────────────────────────────────────
// 实测瓶颈拆解：spawn pwsh 每次 294ms 启动 + 70ms 加载 UIAutomation + 333ms 实际扫描 = 697ms。
// 做成常驻服务后省掉前两段，只剩实际扫描：实测 134-609ms，视窗口复杂度。
// 服务文件：pet-runtime/tools/uia-service.ps1
const UIA_PORT = Number(process.env.PET_UIA_PORT) || 8106;
// 上一次 snapshot 走的哪条通道（ps / rust / pwsh），给诊断和日志用
let _lastSnapshotVia = 'ps';
let _uiaReadyAt = 0;
let _uiaStarting = false;

function _uiaPost(path, body, timeoutMs = 8000) {
    return new Promise((resolve) => {
        try {
            const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
            const req = require('http').request({
                host: '127.0.0.1', port: UIA_PORT, path, method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length },
                timeout: timeoutMs,
            }, (res) => {
                let s = '';
                res.on('data', (c) => { s += c; });
                res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve({ ok: false, error: 'parse' }); } });
            });
            req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
            req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } resolve({ ok: false, error: 'timeout' }); });
            req.write(data); req.end();
        } catch (e) { resolve({ ok: false, error: e.message }); }
    });
}

async function ensureUiaService() {
    if (Date.now() - _uiaReadyAt < 30000) return true;
    const probe = await _uiaPost('/health', {}, 800);
    if (probe && probe.ok) { _uiaReadyAt = Date.now(); return true; }
    if (_uiaStarting) return false;
    _uiaStarting = true;
    try {
        const root = findProjectRoot(path.resolve(__dirname, '..', '..', '..', '..'));
        const script = path.join(root, 'pet-runtime', 'tools', 'uia-service.ps1');
        if (!require('fs').existsSync(script)) { _uiaStarting = false; return false; }
        const child = spawn('pwsh', ['-NoProfile', '-File', script, '-Serve', '-Port', String(UIA_PORT)], {
            windowsHide: true, stdio: 'ignore',
        });
        child.on('error', () => { /* 拉起失败就走 spawn 兜底 */ });
        for (let i = 0; i < 20; i += 1) {
            await new Promise((r) => setTimeout(r, 500));
            const ok = await _uiaPost('/health', {}, 600);
            if (ok && ok.ok) { _uiaReadyAt = Date.now(); _uiaStarting = false; return true; }
        }
    } catch (e) {
        try { __silentAudit.audit('game-control.js:ensureUia', e); } catch (e2) { /* ignore */ }
    }
    _uiaStarting = false;
    return false;
}

let _siStarting = false;
let _siChild = null;
let _siReadyAt = 0;

function findProjectRoot(start) {
    let dir = start;
    for (let i = 0; i < 10; i += 1) {
        if (require('fs').existsSync(path.join(dir, 'pet-runtime', 'tools'))) return dir;
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return start;
}

/** 确保 SendInput 常驻助手在跑（幂等；失败静默，走兜底链）。 */
async function ensureSendInput() {
    if (Date.now() - _siReadyAt < 30000) return true;   // 30 秒内认为还活着
    const probe = await new Promise((resolve) => {
        const req = require('http').request({
            host: '127.0.0.1', port: SEND_INPUT_PORT, path: '/health', method: 'GET', timeout: 800,
        }, (res) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve(/send-input/.test(s))); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } resolve(false); });
        req.end();
    });
    if (probe) { _siReadyAt = Date.now(); return true; }
    if (_siStarting) return false;
    _siStarting = true;
    try {
        const root = findProjectRoot(path.resolve(__dirname, '..', '..', '..', '..'));
        const script = path.join(root, 'pet-runtime', 'tools', 'send-input.ps1');
        if (!require('fs').existsSync(script)) { _siStarting = false; return false; }
        const child = spawn('pwsh', ['-NoProfile', '-File', script, '-Serve', '-Port', String(SEND_INPUT_PORT)], {
            windowsHide: true,
            // ⚠ 不用 detached：Electron 主进程里 detached 子进程会被连带回收（实测起不来）。
            // stdio 也不能是 'ignore'——重定向到日志文件便于排查。
            stdio: 'ignore',
        });
        child.on('error', (e) => { try { __silentAudit.audit('game-control.js:sendInputSpawn', e); } catch (e2) { /* ignore */ } });
        _siChild = child;
        // 不 unref：让它跟主进程同生命周期（主进程退出时它自然结束，避免残留）
        // 等它起来（最多 8 秒）
        for (let i = 0; i < 16; i += 1) {
            await new Promise((r) => setTimeout(r, 500));
            const ok = await new Promise((resolve) => {
                const req2 = require('http').request({
                    host: '127.0.0.1', port: SEND_INPUT_PORT, path: '/health', method: 'GET', timeout: 600,
                }, (res) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve(/send-input/.test(s))); });
                req2.on('error', () => resolve(false));
                req2.on('timeout', () => { try { req2.destroy(); } catch (e) { /* ignore */ } resolve(false); });
                req2.end();
            });
            if (ok) { _siReadyAt = Date.now(); _siStarting = false; return true; }
        }
    } catch (e) {
        try { __silentAudit.audit('game-control.js:sendInputStart', e); } catch (e2) { /* ignore */ }
    }
    _siStarting = false;
    return false;
}

/**
 * 用 SendInput 输入一段文字（逐字符真输入，走系统输入流）。
 * 为什么不用 SendKeys：SendKeys 对中文和特殊字符支持差；SendInput 可指定 scan code，任何应用都认。
 * 实现：把文字交给 send-input.ps1 的 /text 端点（它内部用 SendInput 逐字符 + 中文走 Unicode 输入）。
 */
async function sendInputText(text, target) {
    try {
        // ⓪ Rust 内核（2026-11-09 三十五轮）：KEYEVENTF_UNICODE 逐字符 + 换行改发 VK_RETURN。
        //    2026-11-14 五十三轮改：走**常驻客户端**（每次 spawn 20-50ms → 稳态 1ms），
        //    并把 target 带上 —— pet-core 会断言「前台就是目标窗口」，不在前台直接拒绝
        //    （SendInput 只认前台，否则文字打进用户正在用的应用）。
        const bin = _coreBin();
        if (bin) {
            try {
                const cli = getCoreClient(bin);
                const payload = { cmd: 'text', text: String(text) };
                if (target) payload.target = String(target);
                const rr = await cli.call(payload, 20000);
                if (rr && rr.ok) return { ok: true, via: 'rust', sent: rr.sent };
                if (rr && rr.error) return { ok: false, error: rr.error };
            } catch (e) {
                // 常驻不可用 → 落到 8104 / 兜底路径（不静默：下面失败会带 error）
                try { __silentAudit.audit('game-control:sendInputText', e); } catch (e2) { /* ignore */ }
            }
        }

        if (!(await ensureSendInput())) return { ok: false, error: 'send-input 未就绪' };
        const body = Buffer.from(JSON.stringify({ text: String(text) }), 'utf8');
        return await new Promise((resolve) => {
            const req = require('http').request({
                host: '127.0.0.1', port: SEND_INPUT_PORT, path: '/text', method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length }, timeout: 8000,
            }, (res) => {
                let s = ''; res.on('data', (c) => { s += c; });
                res.on('end', () => { try { const d = JSON.parse(s); resolve(d.ok ? { ok: true } : { ok: false, error: d.error }); } catch (e) { resolve({ ok: false, error: 'parse' }); } });
            });
            req.on('error', (e) => resolve({ ok: false, error: e.message }));
            req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } resolve({ ok: false, error: 'timeout' }); });
            req.write(body); req.end();
        });
    } catch (e) { return { ok: false, error: e.message }; }
}

/**
 * 聚焦窗口（真焦点）。返回 {ok, error, fg?}
 *
 * ⚠ 2026-11-09 三十五轮改：优先走常驻 UIA 服务（/focus），失败才 spawn pwsh。
 *   原因：原实现每次 spawn 一个 pwsh（实测 300ms+ 启动开销 + 70ms 加载），
 *   而聚焦本来是个 5ms 的操作。常驻服务还能做**复核**（GetForegroundWindow 比对），
 *   原实现只要 PowerShell 脚本没报错就 return ok:true —— 又一个「假成功」。
 */
async function focusWindow(titleOrPid, opts) {
    const force = !!(opts && opts.force);
    try {
        const arg = String(titleOrPid || '');
        if (!arg) return { ok: false, verified: false, error: 'no target' };
        // 唯一解析入口（2026-11-21 P2）：标题/pid/hwnd → hwnd，多命中按 pickWindowForTarget 打分。
        // 同名双窗口（UWP 的 Windows.UI.Core.CoreWindow 壳 + ApplicationFrameWindow 真窗）
        // 时，后端按标题都会挑第一个非最小化窗口 —— 实测挑中空壳，聚焦后前台=0、UIA 树空。
        // 先解析成 hwnd 再进后端，是唯一能保证「focus 和后续输入打同一个窗口」的做法。
        const rz = await resolveTargetHwnd(arg);
        if (!rz || rz.ok === false) {
            return {
                ok: false, verified: false, unresolved: true, via: 'resolve',
                error: (rz && rz.error) || ('没找到窗口：' + arg),
                resolveDetail: (rz && rz.detail) || '',
                candidates: (rz && rz.candidates) || [],
            };
        }
        const targetArg = String(rz.hwnd);
        const resolved = {
            hwnd: rz.hwnd, title: rz.title, pid: rz.pid,
            multiHit: rz.multiHit === true, resolveDetail: rz.detail,
        };
        if (rz.multiHit) {
            try { __silentAudit.audit('game-control:focus-multi-hit', rz.detail); } catch (e) { /* ignore */ }
        }

        // ⓪ Rust 内核（2026-11-09 三十五轮）：不依赖 UIA 服务，自带三段式 + 复核。
        //    比 UIA 服务版少一次 HTTP 往返，而且服务挂了也能用。
        const bin = _coreBin();
        if (bin) {
            const rr = await new Promise((resolve) => {
                try {
                    const { execFile } = require('child_process');
                    const child = execFile(bin, [], { windowsHide: true, timeout: 6000, maxBuffer: 1024 * 1024 },
                        (err, stdout) => {
                            if (err) return resolve(null);
                            try { resolve(JSON.parse(String(stdout))); } catch (e) { resolve(null); }
                        });
                    try { child.stdin.end(JSON.stringify({ cmd: 'focus', target: targetArg, force }), 'utf8'); } catch (e) { resolve(null); }
                } catch (e) { resolve(null); }
            });
            if (rr && rr.error) return Object.assign({ ok: false, verified: false, error: rr.error, via: 'rust' }, resolved);
            if (rr && rr.ok) return Object.assign({ ok: true, verified: true, via: 'rust', fg: { title: rr.title, hwnd: rr.hwnd }, wasIconic: rr.wasIconic === true, forced: rr.forced === true }, resolved);
            if (rr && rr.ok === false) {
                return Object.assign({
                    ok: false, verified: false, via: 'rust',
                    error: '聚焦「' + arg + '」没成功，当前前台是「' + (rr.fgTitle || '未知') + '」（可能被 alwaysOnTop 窗口盖住）',
                    fg: { title: rr.fgTitle, hwnd: rr.fgHwnd },
                }, resolved);
            }
        }

        // ① 常驻服务（毫秒级 + 带复核）：hwnd 是唯一身份，title 只作展示/兜底。
        if (await ensureUiaService()) {
            const r = await _uiaPost('/focus', { title: rz.title, hwnd: rz.hwnd }, 4000);
            if (r && r.ok) return Object.assign({ ok: true, verified: true, via: 'uia-service', fg: { title: r.title, hwnd: r.hwnd } }, resolved);
            if (r && r.error) return Object.assign({ ok: false, verified: false, error: r.error, via: 'uia-service' }, resolved);
            if (r && r.ok === false) {
                // 服务连上了但没聚焦成功：把复核到的真实前台报出去，比「focus failed」有用
                return Object.assign({
                    ok: false, verified: false, via: 'uia-service',
                    error: '聚焦「' + arg + '」没成功，当前前台是「' + (r.fgTitle || '未知') + '」（可能被 alwaysOnTop 窗口盖住）',
                    fg: { title: r.fgTitle, hwnd: r.fgHwnd },
                }, resolved);
            }
        }

        // ② 兜底：spawn pwsh（只按 hwnd 激活，不再按标题枚举第二次）
        // P0-3（2026-11-25）：**回读** GetForegroundWindow 再判 ok —— 原来只看
        //   SetForegroundWindow 的返回值（Windows 前台锁下返回 true 但前台没变是已知行为），
        //   于是 focus_window 拿到 ok:true 就报「已调到前台」（假成功）。
        const ps = `$sig2 = @'
using System;using System.Text;using System.Runtime.InteropServices;
public class FWX {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
}
'@; Add-Type -TypeDefinition $sig2; $h = [IntPtr]${targetArg}; [void][FWX]::ShowWindow($h, 9); $null = [FWX]::SetForegroundWindow($h); Start-Sleep -Milliseconds 120; $fg = [FWX]::GetForegroundWindow(); $sb = New-Object System.Text.StringBuilder 512; [void][FWX]::GetWindowTextW($fg, $sb, 512); ([string]$fg.ToInt64()) + '|' + $sb.ToString()`;
        const r = await runPs(ps, 5000);
        const out = String(r.out || '').trim();
        const mf = out.match(/^(-?\d+)\|([\s\S]*)$/);
        const fgHwnd = mf ? Number(mf[1]) : 0;
        const fgTitle = mf ? mf[2] : '';
        const wantHwnd = Number(targetArg) || 0;
        if (wantHwnd > 0 && fgHwnd === wantHwnd) {
            return Object.assign({
                ok: true, verified: true, via: 'pwsh-fallback', readback: true,
                fg: { title: fgTitle, hwnd: fgHwnd },
            }, resolved);
        }
        return Object.assign({
            ok: false, verified: false, via: 'pwsh-fallback',
            error: wantHwnd > 0
                ? '聚焦「' + arg + '」没成功，回读前台是「' + (fgTitle || '未知') + '」'
                : ('无法回读前台（输出=' + out.slice(0, 40) + '）'),
            fg: { title: fgTitle, hwnd: fgHwnd },
            readback: true,
        }, resolved);
    } catch (e) { return { ok: false, verified: false, error: e.message }; }
}

/** 「没找到窗口」类错误——只有这一类值得重试（窗口可能还在创建）。 */
function isWindowNotFound(msg) {
    return /没找到|notfound|not found|no window|cannot find|找不到/i.test(String(msg || ''));
}

/**
 * focusWindow + 短重试（2026-11-14）。
 *
 * 为什么：执行档案里 `launch_app('计算器')` 刚 confirmed，紧接着 `focus_window('计算器')`
 * 就 not_sent（Rust/UIA/pwsh 三级兜底全报「没找到」）—— 不是真没有窗口，而是窗口还在创建
 * （UWP/Electron/启动器出窗口要 0.3–3s，枚举那一刻还没有它）。模型拿不到焦点，后面
 * press_key 就全落空，用户看到的是「她说打开了，但键盘没反应 / 又去关了重开」。
 *
 * 只对「没找到」重试：**「前台还是别的窗口」不重试**（那是置顶/遮挡问题，重试无用，
 * 立刻把真实原因报回去比傻等 1.8 秒有用）。
 */
/**
 * 按「应用名 → exe 路径」找到真实窗口并聚焦（2026-11-14）。
 *
 * 为什么需要：Rust/UIA 的 focus 只按**窗口标题**匹配，而中文应用名经常和标题无关 ——
 * 实测这台机器上记事本的标题是英文 `*zcode-et3.txt - Notepad`，所以
 * `focus_window('记事本')` 三级兜底全报「没找到」。同一根因在 11-10 的
 * 计算器任务里让后续 5 批 press_key 全部 suspected_noop（键盘落到了别的窗口）。
 *
 * 做法：用启动白名单的名字→exe 表查进程（Name/Path 两路，Store 应用真实 exe 在
 * WindowsApps 下也命中 Name），拿到 pid 再交给 focusWindow —— 纯数字走它已有的
 * pid 分支，不重复实现窗口激活。
 */
async function focusByAppAlias(arg, opts = {}) {
    const apps = (opts && opts.apps) || {};
    const exePath = apps[String(arg)];
    if (!exePath) return null;
    const stem = String(require('path').basename(String(exePath), '.exe')).replace(/'/g, "''");
    const full = String(exePath).replace(/\//g, '\\').replace(/'/g, "''");
    const r = await runPs(
        "$p = Get-Process -ErrorAction SilentlyContinue | Where-Object { ($_.Name -eq '" + stem
        + "' -or $_.Path -eq '" + full + "') -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1; "
        + "if ($p) { [string]$p.Id + '|' + $p.MainWindowTitle } else { '' }",
        4000,
    );
    const m = String(r.out || '').trim().match(/^(\d+)\|(.*)$/);
    if (!m) return null;
    // opts.apps[pid] 不存在 → focusWindow 内部不会再走别名分支，不会递归
    const viaPid = await focusWindow(m[1], opts);
    if (viaPid && viaPid.ok) {
        viaPid.via = 'app-alias→' + (viaPid.via || 'pid');
        viaPid.fg = { title: m[2] };
        viaPid.aliasStem = stem;
        return viaPid;
    }
    return null;
}

async function focusWindowRetry(titleOrPid, opts = {}) {
    const tries = Math.max(1, Number(opts.tries) || 4);
    const gapMs = Math.max(100, Number(opts.gapMs) || 450);
    let last = null;
    let aliasTried = false;
    for (let i = 0; i < tries; i += 1) {
        // 第 2 次仍「没找到」→ 先试应用名→进程名（标题对不上时这是唯一出路）。
        // 放第 2 次而不是第 1 次：标题能匹配的常见情况仍走最快的单次 Rust 调用。
        if (i === 1 && !aliasTried) {
            aliasTried = true;
            const viaAlias = await focusByAppAlias(titleOrPid, opts);
            if (viaAlias) { viaAlias.waitedMs = i * gapMs; return viaAlias; }
        }
        last = await focusWindow(titleOrPid, opts);
        if (last && last.ok) {
            if (i > 0) last.waitedMs = i * gapMs;   // 坦白等了多久：模型据此判断「刚启动的要等」
            return last;
        }
        if (!isWindowNotFound(last && last.error)) return last;
        if (i < tries - 1) await new Promise((r) => setTimeout(r, gapMs));
    }
    return last;
}

/** 用 SendInput 发一个组合键。失败返回 {ok:false}，由调用方走兜底链。 */
async function sendInputKey(spec, holdSec, target) {
    try {
        // ⓪ Rust 内核（2026-11-09 三十五轮）：扫描码 + 扩展键位，游戏才认。
        //    2026-11-14 五十三轮：常驻客户端 + target 前台断言（原来是每次 spawn）。
        const bin = _coreBin();
        if (bin) {
            try {
                const cli = getCoreClient(bin);
                const payload = { cmd: 'keys', keys: String(spec) };
                if (holdSec) payload.holdMs = Math.round(Number(holdSec) * 1000);
                if (target) payload.target = String(target);
                const rr = await cli.call(payload, 10000);
                if (rr && rr.ok) return { ok: true, via: 'rust', sent: rr.sent };
                if (rr && rr.error) {
                    // Rust 明确说「不认识这个键」/「前台不对」→ 直接返回，别再去试 PowerShell
                    return { ok: false, error: rr.error };
                }
            } catch (e) {
                try { __silentAudit.audit('game-control:sendInputKey', e); } catch (e2) { /* ignore */ }
            }
        }

        if (!(await ensureSendInput())) return { ok: false, error: 'send-input 未就绪' };
        const body = Buffer.from(JSON.stringify({ keys: String(spec), ...(holdSec ? { hold: Number(holdSec) } : {}) }), 'utf8');
        return await new Promise((resolve) => {
            const req = require('http').request({
                host: '127.0.0.1', port: SEND_INPUT_PORT, path: '/key', method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length }, timeout: 5000,
            }, (res) => {
                let s = ''; res.on('data', (c) => { s += c; });
                res.on('end', () => { try { const d = JSON.parse(s); resolve(d.ok ? { ok: true } : { ok: false, error: d.error }); } catch (e) { resolve({ ok: false, error: 'parse' }); } });
            });
            req.on('error', (e) => resolve({ ok: false, error: e.message }));
            req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } resolve({ ok: false, error: 'timeout' }); });
            req.write(body); req.end();
        });
    } catch (e) { return { ok: false, error: e.message }; }
}

/** 读前台窗口标题（游戏自动识别用，只读）。失败返回 ''。 */
async function detectForegroundTitle() {
    try {
        // ⓪ Rust 内核（2026-11-09 三十五轮）：4ms。
        //    原实现 spawn pwsh 跑 Add-Type + Get-Process，实测 **1419ms** —— 
        //    因为 Get-Process 逐进程取属性是 PowerShell 最慢的操作之一。
        //    这个函数被 semantic（自动识别游戏）和 list_game_profiles 调用，是热路径。
        const bin = _coreBin();
        if (bin) {
            const rr = await new Promise((resolve) => {
                try {
                    const { execFile } = require('child_process');
                    const child = execFile(bin, [], { windowsHide: true, timeout: 4000, maxBuffer: 512 * 1024 },
                        (err, stdout) => {
                            if (err) return resolve(null);
                            try { resolve(JSON.parse(String(stdout))); } catch (e) { resolve(null); }
                        });
                    try { child.stdin.end('{"cmd":"fg"}', 'utf8'); } catch (e) { resolve(null); }
                } catch (e) { resolve(null); }
            });
            if (rr && rr.ok && rr.title) return String(rr.title);
        }

        // ① 老路径：Win32 GetWindowTextW 直接读标题（2026-11-09 实测：靠 MainWindowHandle
        // 反查 Get-Process 常拿不到标题，UWP/管理员窗口尤其如此）。返回「标题 进程名」。
        const ps = [
            "$sig = @'",
            "using System;",
            "using System.Text;",
            "using System.Runtime.InteropServices;",
            "public class FGUTIL {",
            '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
            '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);',
            '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
            "}",
            "'@",
            "Add-Type -TypeDefinition $sig",
            "$h = [FGUTIL]::GetForegroundWindow()",
            "$sb = New-Object System.Text.StringBuilder 512",
            "[void][FGUTIL]::GetWindowTextW($h, $sb, 512)",
            "$pid2 = 0",
            "[void][FGUTIL]::GetWindowThreadProcessId($h, [ref]$pid2)",
            "$pn = ''",
            "try { $pn = (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName } catch {}",
            "$sb.ToString() + '|' + $pn",
        ].join('\n');
        const r = await runPs(ps, 3000);
        const out = String(r.out || '').trim();
        if (!out) return '';
        return out.split('|').filter(Boolean).join(' ');
    } catch (e) { return ''; }
}

/** 执行一个直控动作。返回 { ok, detail }，抛错=参数不合法。
 *  focus：可选，先在同一进程里 AppActivate 这个窗口标题再动作——
 *  分两次调用会各起一个 pwsh，进程切换会把前台抢回去，按键就落空了。
 *
 *  ⚠ 红队 S4：真正的实现叫 _runGameAction；对外的 runGameAction 会先过串行锁
 *  （只读动作直接放行）。内部递归调用走的也是 runGameAction，靠 AsyncLocalStorage
 *  识别「已在锁内」→ 直接执行，不会死锁。 */
async function _runGameAction(action, arg, focus, semanticProfiles, extraCfg) {
    const a = String(arg || '').trim();
    const focusPre = focus
        ? `$ws = New-Object -ComObject WScript.Shell; $null = $ws.AppActivate('${String(focus).replace(/'/g, "''")}'); Start-Sleep -Milliseconds 180; `
        : '';
    const wsScript = (body) => `$ws = New-Object -ComObject WScript.Shell; ${focusPre}${body}`;
    switch (action) {
        case 'batch': {
            // #22 批量整计划预校验 + 钉死 HWND（2026-11-10 三十八轮，抄 dsh-computer-use-win）
            //
            // 动机（两个真实坑）：
            //   ① LLM 做多步 GUI 任务（点输入框→打字→回车）常「跑到第 3 步才发现第 2 步参数就错了」，
            //      期间已经动了桌面一半，回滚不了；
            //   ② 每步都按标题重新找窗口 → 中途串到同名窗口（本项目实测过「按标题打进了另一个窗口」）。
            //
            // 语义：
            //   ① 整份计划先校验（动作白名单/参数格式/目标唯一），**任何一步不合法就一步都不执行**；
            //   ② 首个窗口解析后钉死 hwnd，后续步骤都打这个窗口（不再按标题重找）；
            //   ③ 逐步执行，失败即停（stopOnError:false 可改），返回逐步明细。
            const BATCH_OK = new Set([
                'list_windows', 'snapshot', 'click_element', 'som_snapshot', 'som_click', 'focus_window',
                'press_key', 'hold_key', 'click_at', 'click_text', 'visual_click', 'type_text', 'mouse',
                'volume', 'wgc_hash', 'wgc_shot', 'visual_read', 'pvz_state', 'pvz', 'mc', 'semantic',
                // 2026-11-10 回归审计：补纯读的 edit_text / recent_actions —— 多步流程里
                // 「type_text → edit_text 回读验证」是最该在同一次 batch 里做的组合。
                'edit_text', 'recent_actions',
                // 2026-11-14 五十三轮（审计）：新原语同样能在 batch 里用（点→滚→拖这种组合）
                'scroll', 'drag', 'paste', 'set_value', 'select_text', 'perform_action', 'get_value', 'edit_text',
            ]);
            const ARG_RULES = {
                click_element: { re: /^#?\d+$/, need: '编号（如 #5，先 snapshot）' },
                som_click: { re: /^#?\d+$/, need: '编号（如 #3，先 som_snapshot）' },
                click_at: { re: /^-?\d+\s*,\s*-?\d+$/, need: 'x,y 屏幕像素' },
                type_text: { re: /\S/, need: '要输入的文字' },
                press_key: { re: /\S/, need: '键或组合（如 ctrl+s）' },
                hold_key: { re: /^\S+(\s*,\s*\d+(\.\d+)?)?$/, need: '键[,秒数]（如 w,2）' },
                visual_click: { re: /\S/, need: '模板名[,阈值]' },
                click_text: { re: /\S/, need: '屏幕上要点的文字' },
                mouse: { re: /^(double_click|right_click|drag)\b/, need: 'double_click x,y / right_click x,y / drag x1,y1,x2,y2' },
                volume: { re: /^(up|down|mute|\d+)/i, need: 'up/down/mute 或数字' },
                focus_window: { re: /\S/, need: '窗口标题子串或 hwnd' },
                // 2026-11-14 五十三轮：新原语补参数校验（batch 里 arg 写错要整份拒绝，不能半路才炸）
                scroll: { re: /^\S+/, need: '方向 + 格数（如 down 5 / up 3 / hdown 4）' },
                drag: { re: /^-?\d+\s*,\s*-?\d+\s*,\s*-?\d+\s*,\s*-?\d+/, need: 'x1,y1,x2,y2[,时长ms]' },
                paste: { re: /\S/, need: '要粘贴的文字' },
                set_value: { re: /^.+\|.*$/, need: 'rid|值' },
                get_value: { re: /\S/, need: 'rid' },
                select_text: { re: /^.+\|.*$/, need: 'rid|要选中的文字' },
                perform_action: { re: /\S/, need: 'rid' },
            };
            let plan = null;
            try { plan = JSON.parse(String(arg || '')); } catch (e) { plan = null; }
            if (Array.isArray(plan)) plan = { steps: plan };
            if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
                return VC.notSent(
                    'batch 需要 arg 传 JSON：{"steps":[{"action":"click_element","arg":"#5"},{"action":"type_text","arg":"你好"}],"focus":"记事本"}',
                    { error: '计划为空或不是合法 JSON', nextIfFailed: '按上面的形状重新提交' },
                );
            }
            if (plan.steps.length > 20) {
                return VC.notSent('batch 一次最多 20 步（收到 ' + plan.steps.length + ' 步）——拆小一点', { error: 'steps 超上限' });
            }
            // 2026-11-14 五十三轮（审计）：steps 的动作名现在**两套都认** ——
            //   `act` 暴露的语义名（click/type/key/hold/scroll/drag/paste/set_value/…）
            //   和旧的 game_control 名（click_at/type_text/press_key/…）。
            // 原来只认后者，模型按 act 的词汇写 batch 会被整份拒绝（而且看不出为什么）。
            const SEMANTIC_STEP = {
                type: 'type_text', key: 'press_key', hold: 'hold_key',
                scroll: 'scroll', drag: 'drag', paste: 'paste',
                set_value: 'set_value', get_value: 'get_value',
                select_text: 'select_text', perform: 'perform_action', read: 'edit_text',
            };
            plan.steps = plan.steps.map((st) => {
                const s = Object.assign({}, st || {});
                const a = String(s.action || '').trim().toLowerCase();
                const rawArg = (s.arg == null && s.target != null) ? String(s.target) : (s.arg == null ? '' : String(s.arg));
                if (a === 'click') {
                    const t = String(rawArg).trim();
                    if (/^#?\d+$/.test(t)) { s.action = 'click_element'; s.arg = t.replace(/^#/, ''); }
                    else if (/^文字[:：]/.test(t)) { s.action = 'click_text'; s.arg = t.replace(/^文字[:：]/, ''); }
                    else if (/^图片[:：]/.test(t)) { s.action = 'visual_click'; s.arg = t.replace(/^图片[:：]/, ''); }
                    else { s.action = 'click_at'; s.arg = t; }
                    return s;
                }
                if (SEMANTIC_STEP[a]) { s.action = SEMANTIC_STEP[a]; s.arg = String(rawArg); }
                return s;
            });
            const errs = [];
            plan.steps.forEach((st, i) => {
                const n = i + 1;
                const act = st && String(st.action || '').trim();
                if (!act) { errs.push('第 ' + n + ' 步：缺 action'); return; }
                if (!BATCH_OK.has(act)) {
                    errs.push('第 ' + n + ' 步：' + act + ' 不允许进 batch（' + (act === 'batch' ? '禁止嵌套' : '非纯 GUI 动作') + '）');
                    return;
                }
                const sa = st.arg == null ? '' : String(st.arg).trim();
                const rule = ARG_RULES[act];
                if (!rule) return;
                if (!sa) { errs.push('第 ' + n + ' 步 ' + act + '：缺 arg（需要' + rule.need + '）'); return; }
                if (!rule.re.test(sa)) { errs.push('第 ' + n + ' 步 ' + act + '：arg「' + sa.slice(0, 30) + '」格式不对（需要' + rule.need + '）'); }
            });
            if (errs.length) {
                return VC.notSent('批量计划校验没过，一步都没执行：\n' + errs.join('\n'), {
                    error: errs[0], validationErrors: errs,
                    steps: plan.steps.length, executed: 0,
                    nextIfFailed: '按上面每条把参数改对，整份重新提交（batch 是原子的：不合法就一步不动）',
                });
            }
            // 钉死 HWND：解析一次目标窗口，后续每步都用它（2026-11-21 P2：唯一解析入口）
            let pinned = null;
            let pinResolution = null;
            const focus0 = plan.focus != null ? String(plan.focus) : String(focus || '');
            if (focus0) {
                try {
                    const rz = await resolveTargetHwnd(focus0);
                    if (rz && rz.ok) {
                        pinned = { hwnd: rz.hwnd, title: rz.title, pid: rz.pid };
                        pinResolution = { detail: rz.detail, multiHit: rz.multiHit === true, hwnd: rz.hwnd, title: rz.title };
                        if (rz.multiHit) {
                            try { __silentAudit.audit('game-control:batch-multi-hit', rz.detail); } catch (e2) { /* ignore */ }
                        }
                    } else {
                        pinResolution = { error: (rz && rz.error) || ('没找到窗口：' + focus0), detail: (rz && rz.detail) || '' };
                    }
                } catch (e) { try { __silentAudit.audit('game-control:batch-pin', e); } catch (e2) { /* ignore */ } }
                if (!pinned) {
                    return VC.notSent('batch 找不到目标窗口「' + focus0 + '」——一步都没执行', {
                        error: pinResolution && pinResolution.error ? pinResolution.error : ('没找到窗口：' + focus0),
                        resolution: pinResolution && pinResolution.detail ? pinResolution.detail : '',
                        nextIfFailed: '先 list_windows 确认窗口标题，再提交 batch（解析不到不会取第一个）',
                    });
                }
                // 批开始前只 focus 一次（后续步骤不再切窗）；用 hwnd，避免同名窗口在聚焦时又串一次
                try { await focusWindow(String(pinned.hwnd), {}); } catch (e) { try { __silentAudit.audit('game-control:batch-focus', e); } catch (e2) { /* ignore */ } }
            }
            // ⚠ 红队 R6（内层不过限速）：外层 index.js 只扣 1 个令牌，里面最多 20 步真实输入
            //   → 实际可达 400 次/分。现在执行前按步数**预扣配额**（只计数不判冷却：
            //   batch 的步间隔是 120ms，走 300ms 冷却会把整份计划判死）。
            //   只读步不扣；写动作按 index.js 同款分档（游戏闸 600/分 / 严格闸 20/分）。
            const nGameSteps = plan.steps.filter((st) => GAME_GATE_ACTIONS.has(String(st && st.action || '').trim())).length;
            const nStrictSteps = plan.steps.filter((st) => {
                const s = String(st && st.action || '').trim();
                return !BATCH_READONLY_STEPS.has(s) && !GAME_GATE_ACTIONS.has(s);
            }).length;
            const chargeErr = preChargeTokens(nGameSteps, true) || preChargeTokens(nStrictSteps, false);
            if (chargeErr) {
                return VC.notSent(chargeErr, {
                    error: '批量配额不足', steps: plan.steps.length, executed: 0,
                    nextIfFailed: '把 batch 拆成更小的份，或等一分钟窗口滑过去再提；只读步（snapshot 等）不占配额',
                });
            }
            // 逐步执行
            const results = [];
            for (let i = 0; i < plan.steps.length; i += 1) {
                const st = plan.steps[i];
                const act = String(st.action);
                const sa = st.arg == null ? '' : String(st.arg);
                // ⚠ 回归 #5（pinned hwnd 死代码）：以前解析出 pinned 却每步仍用标题 focus0，
                //   等于没钉住。现在默认把 pinned.hwnd 作为**输入类步骤**的 focus
                //   （focusWindow/assertTargetFocused 都双认 hwnd，不会因标题撞名串窗）；
                //   窗口识别类步骤（snapshot/som_snapshot 走 UIA 标题查找）用 pinned.title，
                //   因为 UIA 服务只按标题匹配，传数字会「没找到窗口」。
                //   某步自带 focus 时以步内为准。
                const stepFocus0 = (st.focus != null && String(st.focus).trim())
                    ? String(st.focus).trim()
                    : (pinned ? (PIN_AS_HWND.has(act) ? String(pinned.hwnd) : String(pinned.title || focus0)) : focus0);
                const stepFocus = stepFocus0;
                let ok = false; let effect = null; let detail = ''; let errMsg = '';
                try {
                    const r = await runGameAction(act, sa, stepFocus, semanticProfiles, extraCfg);
                    ok = r ? r.ok !== false : false;
                    effect = r ? r.effect : null;
                    detail = r ? String(r.detail || '').slice(0, 120) : '';
                } catch (e) {
                    errMsg = String(e && e.message || e).slice(0, 160);
                }
                results.push({ step: i + 1, action: act, ok, effect, detail, focus: stepFocus || undefined, error: errMsg || undefined });
                if (!ok && plan.stopOnError !== false) break;
                await new Promise((res) => setTimeout(res, 120));
            }
            const done = results.length;
            const allOk = results.every((x) => x.ok);
            const brief = results.map((x) => '#' + x.step + ' ' + x.action +
                (x.ok ? ' ✓' : ' ✗' + (x.error ? ' ' + x.error : '（' + (x.effect || '无效果') + '）'))).join('｜');
            const meta = {
                pinnedHwnd: pinned ? pinned.hwnd : 0, pinnedTitle: pinned ? pinned.title : '',
                pinnedResolution: pinResolution && pinResolution.detail ? pinResolution.detail : '',
                pinnedMultiHit: !!(pinResolution && pinResolution.multiHit),
                steps: plan.steps.length, executed: done, results,
            };
            // 全是只读步（snapshot/visual_read…）→ 如实返回 readonly；有写动作才 confirmed
            const READONLY_STEPS = new Set(['list_windows', 'snapshot', 'som_snapshot', 'visual_read', 'pvz_state', 'wgc_hash', 'wgc_shot']);
            const onlyRead = results.every((x) => READONLY_STEPS.has(x.action));
            // ⚠ 2026-11-10 红队审计抓到（假成功）：原来 `allOk` 只看 `ok !== false`，
            //   而 press_key/type_text/hold_key 正常返回的是 `ok:true, effect:'unverifiable'`
            //   → batch 汇总成 `confirmed/verified:true`，等于把「没验证」洗成「已确认」，
            //   本次所有验证层的努力被批量层推翻。现在有未验证步就降级成 unverified 汇总。
            const unverifiedSteps = results.filter((x) => x.effect === 'unverifiable');
            if (allOk) {
                if (onlyRead) return VC.readonly('批量（只读）' + done + '/' + plan.steps.length + ' 步完成：' + brief, meta);
                if (unverifiedSteps.length > 0) {
                    return VC.unverified(
                        '批量 ' + done + '/' + plan.steps.length + ' 步都执行了，但其中 ' + unverifiedSteps.length +
                        ' 步无法自动验证（# ' + unverifiedSteps.map((x) => x.step).join(',') + '）：' + brief, meta);
                }
                return VC.confirmed('批量 ' + done + '/' + plan.steps.length + ' 步全部完成：' + brief, meta);
            }
            if (done === 0) return VC.notSent('批量一步都没执行', meta);
            return VC.failed('批量停在第 ' + done + ' 步（共 ' + plan.steps.length + ' 步）：' + brief, Object.assign({
                error: '某步失败', nextIfFailed: '看上面哪一步 ✗，修正后从该步起重提（前面成功的步骤别重做）',
            }, meta));
        }
        case 'snapshot': {
            // ⚠ 2026-11-10 三十九轮实测抓到：她调 snapshot 时传的是 focus:"计算器" 而 arg 留空
            //   → 原实现只看 arg → 扫了前台窗口（2 节点空壳）→ 她以为「UIA 读不到」白绕一圈。
            //   这和 som_snapshot 的 focus 坑是同一个 bug——当时只修了 som_snapshot，漏了最常用的 snapshot。
            // 2026-11-21 P1 根因修：空目标 = 前台窗口。
            // 原实现把 title='' 直接发给 UIA 服务 → WinEnum.FindAll('') + PickBest 没有
            // 「前台」概念，返回枚举顺序里第一个窗口（实测前台 Notepad，返回「设置」）。
            // 现在先在 JS 侧把空目标解析成真实 hwnd/title，再把 hwnd 交给服务。
            // 2026-11-24 根因修：**开始拍新快照就作废旧编号** —— 哪怕这次扫描失败/超时，
            // 旧 #编号 也不再可信（模型看到的是「这次没拍到」，不能拿上一份编号去点）。
            // 放在解析目标之前：空目标解析失败同样要作废。
            UIA_SNAPSHOT_STATE.items = [];
            UIA_SNAPSHOT_STATE.sid = 0;
            UIA_SNAPSHOT_STATE.at = 0;
            UIA_SNAPSHOT_STATE.targetHwnd = 0;
            UIA_SNAPSHOT_STATE.targetTitle = '';
            let snapTarget = a || String(focus || '').trim();
            let snapFg = null;
            let snapPicked = null;
            if (!snapTarget) {
                try { snapFg = await getForegroundInfo(); } catch (e) { snapFg = null; }
                snapPicked = pickSnapshotTarget('', '', snapFg);
                if (!snapPicked.ok) {
                    try { __silentAudit.audit('game-control:snapshot-empty-target', snapPicked.error); } catch (e) { /* ignore */ }
                    return VC.notSent(snapPicked.error, {
                        error: 'foreground-unresolved',
                        nextIfFailed: '调用时显式带窗口名：snapshot「记事本」；或先 focus_window 把目标调到前台再重试',
                    });
                }
                snapTarget = snapPicked.target;
            }
            // Windows-MCP 协议形状：列出可交互元素菜单（编号+类型+名称），她回编号→click_element。
            // arg=窗口标题子串（留空=前台窗口）。这是 semantic 协议的具象版：从猜键位升级为报菜单。
            // 2026-11-09：优先走**常驻 UIA 服务**（省掉 294ms 启动 + 70ms 加载，实测快 3-6 倍）。
            // 服务不可用时才回落到 spawn pwsh（保持旧路径可用）。
            let list = [];
            let viaService = false;
            let svcDiag = null;   // 服务的诊断信息（scanned / shellOnly / hint），要透给调用方
            // 同名双窗口：先解析出**具体**目标窗口（跳过 UWP 空壳 CoreWindow），
            // 再把 hwnd 一起给 UIA 服务/Rust —— 否则两边都可能挑中空壳窗口。
            let snapWin = null;
            if (snapPicked && snapPicked.hwnd > 0) {
                // 前台解析已经给了 hwnd：按 hwnd 绑定（标题只用于展示/诊断）
                try { snapWin = await resolveWindowInfo(String(snapPicked.hwnd)); } catch (e) { snapWin = null; }
                if (!snapWin) {
                    snapWin = {
                        hwnd: snapPicked.hwnd, title: snapTarget,
                        pid: snapPicked.pid || 0, rect: null, iconic: false,
                    };
                }
            } else if (snapTarget) {
                // 2026-11-25 P1-2：see 与 act 必须用同一个 matcher。
                // 解析歧义（多个候选）时直接拒绝 —— 旧实现会带着标题继续让 UIA 服务自己挑一个，
                // 结果 see 拍的是 A、act click 绑定的是 B（STALE 死循环）。
                let rz0 = null;
                try { rz0 = await resolveTargetHwnd(snapTarget); } catch (e) { rz0 = null; }
                if (rz0 && rz0.ok === false && (rz0.code === 'AMBIGUOUS' || rz0.code === 'NOT_FOUND')) {
                    return VC.notSent('没拍：' + rz0.error, {
                        error: 'window-unresolved', reason: rz0.code,
                        candidates: rz0.candidates || [],
                        nextIfFailed: '改传完整标题或 hwnd（see windows 回执里有）；有歧义时不要猜',
                    });
                }
                if (rz0 && rz0.ok) snapWin = Object.assign({}, rz0, { by: rz0.via });
            }
            if (snapPicked && snapPicked.fromForeground) {
                // 可观测：这次扫描的目标是「解析出来的前台」，不是「枚举第一个窗口」
                try {
                    __silentAudit.audit('game-control:snapshot-foreground-resolved',
                        'title="' + snapTarget + '" hwnd=' + (snapWin && snapWin.hwnd || 0) + ' via=' + snapPicked.via,
                        { quiet: true });
                } catch (e) { /* ignore */ }
            }
            if (await ensureUiaService()) {
                const svc = await _uiaPost('/elements', { title: snapTarget || '', hwnd: snapWin ? snapWin.hwnd : 0, max: 60 }, 10000);
                // ⚠ 2026-11-09 三十五轮（第二次修这里）：PS 失败时**先试 Rust 再决定放弃**。
                //
                //   之前的分支把「iconic / offscreen / 任何 error」一锅端直接 return，
                //   结果 Clash Verge 这种「PS 版扫不出来但 Rust 版能扫 240 个」的窗口
                //   被误判成「读不到」（实测 8ms 就返回 not_sent）。
                //
                //   现在分两类：
                //     · iconic / offscreen → 窗口状态问题，换通道也没用 → 直接返回（带 focus 建议）
                //     · 其它 error → 可能是 PS 的 COM 会话问题 → **试 Rust**
                if (svc && svc.ok === false && (svc.iconic || svc.offscreen)) {
                    return VC.notSent(String(svc.error || ('「' + (snapTarget || '前台窗口') + '」读不到元素树')), {
                        tier: 'L2', iconic: svc.iconic === true, offscreen: svc.offscreen === true,
                        nextIfFailed: svc.iconic
                            ? '先 focus_window "' + (snapTarget || '') + '" 把窗口恢复（我从最小化恢复会顺带把它调到前台），再 snapshot'
                            : '先 focus_window 恢复窗口，或用 list_windows 看它现在在哪',
                    });
                }
                if (svc && svc.ok && Array.isArray(svc.elements)) {
                    list = svc.elements.map((e, i) => ({
                        rid: e.rid, type: e.type, name: e.name,
                        x: e.cx, y: e.cy, pid: e.pid, idx: i + 1,
                    }));
                    viaService = true;
                    // ⚠ 2026-11-09：这几个诊断字段原来是丢的 ——
                    //   scanned 告诉你「扫了多少节点」（判断树完不完整）；
                    //   shellOnly 告诉你「这个窗口的 UIA 树是空壳」（应用没启无障碍）；
                    //   hint 直接给「改用 som_snapshot」的建议。
                    //   不带走的话，AI 只会看到「1 个元素」而不知道为什么。
                    svcDiag = {
                        scanned: svc.scanned,
                        chromiumWoke: svc.chromiumWoke === true,
                        shellOnly: svc.shellOnly === true,
                        title: svc.title || '',
                        hwnd: svc.hwnd || 0,
                    };
                }
            }
            // ⚠ 2026-11-09 三十五轮：PS 常驻服务失败时的回落链变成
            //   **PS 服务 → Rust 内核 → spawn pwsh**
            //
            //   为什么把 Rust 排在 spawn 前面：实测 PS 服务在 Clash Verge 上会失败
            //   （`ok=false`），而 Rust 版能扫到 240 个节点。Rust 比 spawn pwsh 快得多
            //   （1400ms vs 8 秒超时），而且不依赖 PowerShell。
            //
            //   ⚠ 重要认知（实测纠正）：**UIA 扫描的瓶颈是 COM 跨进程，不是解释器**。
            //   Rust 和 PowerShell 扫同一个窗口耗时基本一致（979 节点：1407ms vs 1436ms）。
            //   所以「UIA 走 Rust」的收益不在速度，在**健壮性**（不依赖 PowerShell 会话状态）。
            if (!viaService) {
                const bin = _coreBin();
                if (bin) {
                    const rr = await new Promise((resolve) => {
                        try {
                            const { execFile } = require('child_process');
                            const child = execFile(bin, [], { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
                                (err, stdout) => {
                                    if (err) return resolve(null);
                                    try { resolve(JSON.parse(String(stdout))); } catch (e) { resolve(null); }
                                });
                            try { child.stdin.end(JSON.stringify({ cmd: 'uia_elements', target: (snapWin && snapWin.hwnd) ? String(snapWin.hwnd) : (snapTarget || ''), max: 60 }), 'utf8'); } catch (e) { resolve(null); }
                        } catch (e) { resolve(null); }
                    });
                    if (rr && rr.ok && Array.isArray(rr.elements) && rr.elements.length) {
                        list = rr.elements.map((e, i) => ({
                            rid: e.rid, type: e.ctype, name: e.name,
                            x: e.cx, y: e.cy, pid: e.pid, idx: i + 1,
                        }));
                        svcDiag = {
                            scanned: rr.scanned, chromiumWoke: false,
                            shellOnly: (rr.scanned || 0) < 3 && list.length <= 1,
                            title: rr.title || '', hwnd: rr.hwnd || 0,
                            // 三重预算（2026-11-10 三十八轮）：目标应用太大时如实标注
                            // 「这份清单不完整」，否则 AI 会以为没找到 = 不存在。
                            truncated: rr.truncated || null,
                        };
                        viaService = true;
                        // 记一下是 Rust 通道（诊断用）
                        _lastSnapshotVia = 'rust';
                    }
                }
            }
            if (!viaService) {
                const r = await runPs(uiaPsScript('snapshot', snapTarget || ''), 8000);
                if (!r.ok && !r.out) throw new Error('snapshot 失败：' + r.error);
                try {
                    const parsed = JSON.parse(r.out || '[]');
                    list = Array.isArray(parsed) ? parsed : [parsed];
                } catch (e) { throw new Error('snapshot 输出异常：' + String(r.out).slice(0, 80)); }
            }
            // ⚠ 2026-11-09 三十五轮（第二次修这个点）：shellOnly 判断必须**在** !list.length 之前。
            //   原来顺序反了 → 空壳窗口（scanned=0 或很少）先被 `!list.length` 拦住，
            //   抛一个泛泛的 Error，被 index.js 的 catch 变成 not_sent，而且 detail 是空的
            //   —— AI 完全不知道「这是空壳，该换 som_snapshot」。
            //   实测踩到：VALORANT（UE4，反作弊，UIA 完全读不到）。
            if (svcDiag && svcDiag.shellOnly) {
                return VC.readonly(
                    '「' + (snapTarget || '前台窗口') + '」的 UIA 树是**空壳**（扫了 ' + svcDiag.scanned + ' 个节点，' +
                    '只有窗口框架，没有真控件）。这个应用没启用无障碍' +
                    '（如未加 --force-renderer-accessibility 的 Electron，或 UE4/UE5 游戏）——UIA 这条路走不通。' +
                    '改用 som_snapshot 看画面，或 click_text 走 OCR。',
                    { shellOnly: true, diag: svcDiag, elements: [], scanned: svcDiag.scanned },
                );
            }
            if (!list.length) {
                return VC.notSent('这个窗口没扫到可交互元素（标题写一部分试试）', {
                    story: '可能是 Qt 自绘（微信）或游戏引擎，UIA 本来就没有树',
                    nextIfFailed: '改用 som_snapshot 看画面（UIA/OCR 标注），或 click_text 按文字点',
                });
            }

            // ⚠ 2026-11-09 修（用户实测「叫她开QQ发消息做不到」的根因之一）：
            // 原实现只过滤「元素坐标在屏外」的情况。但实测 QQ 最小化时（窗口 rect = -21333,-21333），
            // UIA 返回的**元素坐标却是恢复后的正常值**（如 1832,1450）——过滤不掉！
            // 结果 AI 拿到一堆「看起来合法」的坐标去点，点的却是桌面空白。
            // 现在先查窗口**真实矩形**：最小化/在屏外就直接报错，绝不给假坐标。
            {
                const wr = (snapWin && snapWin.rect)
                    ? { x: snapWin.rect.x, y: snapWin.rect.y, w: snapWin.rect.w, h: snapWin.rect.h, visible: true, iconic: snapWin.iconic }
                    : await windowRealRect(snapTarget || '');
                if (wr && (wr.x < -20000 || wr.y < -20000 || wr.w <= 1 || wr.h <= 1)) {
                    throw new Error('「' + (snapTarget || '前台窗口') + '」是最小化状态（窗口位置 ' + wr.x + ',' + wr.y + '）——元素坐标是旧值，点了也不会有反应。请先恢复窗口：focus_window "' + (snapTarget || '') + '" 再重试');
                }
                if (wr && !wr.visible) {
                    throw new Error('「' + (snapTarget || '前台窗口') + '」当前不可见（隐藏/在其他虚拟桌面）——先 focus_window 恢复');
                }
            }

            // 二次保险：元素坐标本身也该在屏幕内
            list = list.filter((e) => e.x > -20000 && e.y > -20000);

            if (!list.length) {
                throw new Error('这个窗口没扫到屏内的可交互元素（可能最小化了）——先 focus_window 恢复');
            }
            UIA_SNAPSHOT_STATE.title = snapTarget || '';
            UIA_SNAPSHOT_STATE.items = list;
            // 世代号（红队 S4）：任何快照都推进，让更早的 SoM 编号自动失效
            _stateSeq += 1;
            UIA_SNAPSHOT_STATE.seq = _stateSeq;
            // 快照身份与代数（2026-11-24 根因修）：sid 单调递增 + 拍摄时间
            UIA_SNAPSHOT_STATE.sid = ++_snapshotSid;
            UIA_SNAPSHOT_STATE.at = Date.now();
            // 新快照 = 新身份：先清掉上一份，解析失败时宁可「未知」也不要沿用旧 hwnd
            //（沿用旧 hwnd 正是「按编号点到上一个窗口」的根因）
            UIA_SNAPSHOT_STATE.hwnd = 0;
            UIA_SNAPSHOT_STATE.pid = 0;
            UIA_SNAPSHOT_STATE.rect = null;
            // 窗口身份守卫 + homing（2026-11-10 三十七轮，抄 #10/#11）：记住快照时刻的 hwnd 与矩形
            try {
                // 2026-11-21 P1：优先用已经解析好的快照窗口身份（前台 hwnd / 标题解析结果）。
                // 原来无条件用 `filter: snapTarget || ''` 再 find —— 空目标时等于「枚举第一个
                // 非最小化窗口」，和扫错窗口是同一个 bug。现在只有显式标题才走旧兜底。
                if (snapWin) {
                    UIA_SNAPSHOT_STATE.hwnd = Number(snapWin.hwnd) || 0;
                    UIA_SNAPSHOT_STATE.pid = Number(snapWin.pid) || 0;
                    if (snapWin.rect) {
                        UIA_SNAPSHOT_STATE.rect = {
                            x: snapWin.rect.x, y: snapWin.rect.y, w: snapWin.rect.w, h: snapWin.rect.h,
                            visible: true, iconic: snapWin.iconic === true,
                        };
                    }
                }
                if (!UIA_SNAPSHOT_STATE.rect) {
                    const wr2 = await windowRealRect(snapTarget || '');
                    if (wr2) UIA_SNAPSHOT_STATE.rect = wr2;
                }
                if (!UIA_SNAPSHOT_STATE.hwnd && snapTarget) {
                    const wl = JSON.parse(require('child_process').execFileSync(_coreBin(), [], {
                        input: JSON.stringify({ cmd: 'windows', filter: snapTarget, max: 40 }), timeout: 8000,
                        maxBuffer: 8 * 1024 * 1024, windowsHide: true,
                    }).toString());
                    // 2026-11-25 P1-2：兜底也走唯一 matcher；多命中/找不到就不写 hwnd，
                    // 宁可身份未知让绑定层 fail-closed，也不要按 includes 猜一个。
                    const pk2 = pickWindowForTarget((wl.windows || []).filter((w) => !w.iconic), snapTarget);
                    if (pk2.ok) { UIA_SNAPSHOT_STATE.hwnd = pk2.win.hwnd; UIA_SNAPSHOT_STATE.pid = pk2.win.pid || 0; }
                }
            } catch (e) { try { __silentAudit.audit('game-control:snapshot-identity', e); } catch (e2) { /* ignore */ } }
            // 快照目标窗口（2026-11-24 根因修）：这次快照**实际**拍的是哪个窗口。
            // 解析顺序：已解析的 snapWin → 服务/内核回报的标题 → 调用方给的标题。
            UIA_SNAPSHOT_STATE.targetHwnd = Number(UIA_SNAPSHOT_STATE.hwnd) || 0;
            UIA_SNAPSHOT_STATE.targetTitle = String(
                (snapWin && snapWin.title) || (svcDiag && svcDiag.title) || snapTarget || UIA_SNAPSHOT_STATE.title || '',
            ).trim();
            // P1-5（2026-11-21）：#32770 对话框控件类型补全。
            // UIA 常把对话框按钮（「选择文件夹」「取消」）报成 pane —— 按类型的自动化会选错。
            // 只对对话框做一次能力扫描，按动作能力把 pane 改判成 button / edit；
            // 只改 type 字段，不动元素集合与 rid（click_element 仍按 rid 工作）。
            let dialogInfo = null;
            try {
                const winTitle = String((svcDiag && svcDiag.title) || snapTarget || UIA_SNAPSHOT_STATE.title || '').trim();
                if (winTitle) {
                    const wi = await resolveWindowInfo(winTitle);
                    if (wi && /#32770/i.test(wi.class)) {
                        const scan = await uiaScan(winTitle, 80, wi.hwnd);
                        if (scan.ok && scan.items.length) {
                            const byRid = new Map(scan.items.map((x) => [String(x.rid || ''), x]));
                            let changed = 0;
                            list = list.map((e) => {
                                const info = byRid.get(String(e.rid || ''));
                                const merged = classifyDialogElement(
                                    Object.assign({}, e, info ? {
                                        actions: info.actions, readonly: info.readonly,
                                        offscreen: info.offscreen, enabled: info.enabled,
                                        kids: info.kids, w: info.w, h: info.h,
                                    } : {}),
                                    wi.class,
                                );
                                if (merged.type !== e.type) changed += 1;
                                return merged;
                            });
                            UIA_SNAPSHOT_STATE.items = list;
                            dialogInfo = { class: wi.class, scanned: scan.items.length, reclassified: changed };
                        }
                    }
                }
            } catch (e) { try { __silentAudit.audit('game-control:snapshot-dialog-types', e); } catch (e2) { /* ignore */ } }
            const lines = list.map((e, i) => `#${i + 1}[${e.type}]${String(e.name).slice(0, 24)}(@${e.x},${e.y})`);
            const trunc = svcDiag ? svcDiag.truncated : null;
            return VC.readonly(
                `「${snapTarget || '前台窗口'}」可交互元素 ${list.length} 个（扫了 ${svcDiag ? svcDiag.scanned : '?'} 个节点）：` + lines.slice(0, 20).join(' ') +
                (trunc ? `　⚠ 本次因${trunc === 'time' ? '时间' : '节点数'}预算提前截断——清单可能不全；找不到目标就 som_snapshot 看画面` : ''),
                {
                    elements: list,
                    // 2026-11-24 根因修：#编号只在「这份快照」里成立。
                    // 回执带 sid + 拍的是哪个窗口，click_element 会核对（不一致 → STALE_SNAPSHOT）。
                    snapshot_id: UIA_SNAPSHOT_STATE.sid,
                    snapshot_at: UIA_SNAPSHOT_STATE.at,
                    window: { hwnd: UIA_SNAPSHOT_STATE.targetHwnd || 0, title: UIA_SNAPSHOT_STATE.targetTitle || '' },
                    scanned: svcDiag ? svcDiag.scanned : null,
                    truncated: trunc,
                    shellOnly: svcDiag ? svcDiag.shellOnly : false,
                    chromiumWoke: svcDiag ? svcDiag.chromiumWoke : false,
                    via: viaService ? 'uia-service-or-rust' : 'pwsh',
                    // P1-5：对话框类型补全留痕（null = 不是 #32770 或没扫到能力）
                    dialog: dialogInfo,
                    // 2026-11-21 P1：空目标解析留痕（null = 调用方显式给了窗口）
                    foreground: snapPicked && snapPicked.fromForeground
                        ? { resolved: true, hwnd: snapWin ? (snapWin.hwnd || 0) : 0, title: snapTarget, via: snapPicked.via }
                        : null,
                    target: { hwnd: UIA_SNAPSHOT_STATE.hwnd || 0, title: UIA_SNAPSHOT_STATE.title || '', pid: UIA_SNAPSHOT_STATE.pid || 0 },
                    // 通道路由：**实测优先** —— 本次扫到 N 个元素 = UIA 可读的实证，
                    // 比静态规则准；0 元素才落回 guiRoute 静态判定（含降级建议）。
                    route: list.length > 0
                        ? { ch: 'fast', via: 'uia', why: '实测 ' + list.length + ' 个可交互元素', hint: '继续 click_element #编号 操作这个窗口' }
                        : Object.assign(guiRoute(
                            snapTarget, '',
                            (snapFg && snapFg.app) || _expAppFor(snapWin && snapWin.pid, snapTarget),
                        ), { fallback: 'som_snapshot' }),
                },
            );
        }
        case 'som_snapshot': {
            // SoM（Set-of-Mark）标注截图（2026-11-09 C档）：把 UIA/OCR 找到的可点元素
            // 画框+编号到截图上，让 AI「按编号选」而不是「猜像素坐标」。
            // 价值：UIA 读不到的自绘画布/游戏/微信/UWP 也能点——OCR 兜底 + 视觉语义。
            // 与 snapshot 的区别：snapshot 只回文字清单（她看不见画面）；som_snapshot 回标注图。
            // 2026-11-24 根因修：开始标注就作废旧的 SoM 编号（失败/超时同样作废）。
            SOM_STATE.marks = [];
            SOM_STATE.sid = 0;
            SOM_STATE.at = 0;
            SOM_STATE.targetHwnd = 0;
            SOM_STATE.targetTitle = '';
            SOM_STATE.pid = 0;
            const { spawn: _spawn } = require('child_process');
            const py = resolvePython();
            // 路径解析（2026-11-09）：不数层级，直接沿目录树向上找「含 pet-runtime 的根」。
            // 数 '..' 个数太脆（本项目 _incoming/my-neuro/live-2d/plugins/community/dispatch 共 7 级）。
            let rootDir = __dirname;
            for (let i = 0; i < 10; i += 1) {
                if (require('fs').existsSync(path.join(rootDir, 'pet-runtime', 'tools', 'som_annotate.py'))) break;
                const up = path.dirname(rootDir);
                if (up === rootDir) break;
                rootDir = up;
            }
            const script = path.join(rootDir, 'pet-runtime', 'tools', 'som_annotate.py');
            const args = [script, '--max', '30'];
            // ⚠ 编码坑（2026-11-09 实测）：中文参数从 Node spawn 传到 Python 会变 `΢��`（GBK 解码）。
            // 用 base64 传（纯 ASCII，绕开所有编码层），Python 侧解码。
            //
            // ⚠ 参数幻觉兜底（2026-11-10 三十八轮，她实战踩到）：
            //   描述里没写 som_snapshot 的 arg 含义 → 她把「当前前台窗口」当窗口名传进来
            //   → Python 按标题找不到 → `SoM 失败：没找到窗口：当前前台窗口`。
            //   同一次任务里不带 arg 的调用是成功的（标注 30 元素）——纯参数层问题。
            //   这里把「当前前台窗口/前台/current…」这类描述词归一化为空（=不指定窗口）。
            //
            // ⚠ 第二个坑（同轮 QQ 实战）：她传 `focus:"QQ"` 而 arg 留空 —— 原实现只看 arg，
            //   focus 被完全忽略 → 标的是「(前台窗口)」，OCR 抓了一屏桌面图标（微信/launcherx）。
            //   现在 arg 空时回落到 focus，与 click_at/type_text 等动作的语义对齐。
            const winArgRaw = String((a && String(a).trim()) || (focus && String(focus).trim()) || '');
            const winArg = /^(当前前台窗口|前台窗口|当前窗口|整个屏幕|全屏|current|active|front|foreground|now)$/i.test(winArgRaw)
                ? ''
                : winArgRaw;
            if (winArg) args.push('--window-b64', Buffer.from(winArg, 'utf8').toString('base64'));
            const out = await new Promise((resolve) => {
                const ch = _spawn(py, args, { windowsHide: true });
                ch.stdout.setEncoding('utf8'); ch.stderr.setEncoding('utf8');
                let buf = '', err = '';
                ch.stdout.on('data', (c) => { buf += c; });
                ch.stderr.on('data', (c) => { err += c; });
                ch.on('error', (e) => resolve({ ok: false, error: e.message }));
                ch.on('close', () => resolve({ ok: true, out: buf.trim(), err: err.trim() }));
                setTimeout(() => { try { ch.kill(); } catch (e) { try { __silentAudit.audit('game-control.js:som-timeout', e); } catch (e2) {} } resolve({ ok: false, error: 'timeout' }); }, 90000);
            });
            if (!out.ok) throw new Error('SoM 标注失败：' + out.error);
            let d = {};
            try { d = JSON.parse(out.out || '{}'); } catch (e) { throw new Error('SoM 输出异常：' + String(out.out).slice(0, 120)); }
            if (!d.ok) throw new Error('SoM 失败：' + (d.error || '未知'));
            // 2026-11-21 P1 根因修：窗口身份不再用占位文案「(前台窗口)」。
            // som_annotate.py 现在总是回填真实前台 title + hwnd（--window 缺省时也一样）；
            // som_click 的前台断言优先用 hwnd（唯一无歧义），标题只作展示。
            const somTitle = String(d.title || winArg || '').trim();
            SOM_STATE.title = /^(\(?前台窗口\)?|\(?foreground\)?)$/i.test(somTitle) ? '' : somTitle;
            SOM_STATE.hwnd = Number(d.hwnd) || 0;
            if (!SOM_STATE.hwnd || !SOM_STATE.title) {
                try {
                    __silentAudit.audit('game-control:som-window-identity',
                        'SoM 窗口身份不完整（hwnd=' + SOM_STATE.hwnd + ' title="' + SOM_STATE.title + '"）——som_click 前台断言可能无法执行');
                } catch (e) { /* ignore */ }
            }
            SOM_STATE.marks = d.marks || [];
            // 世代号（红队 S4）：记下这次标注是第几代；后面任何快照都会让它过期
            SOM_STATE.seq = ++_stateSeq;
            // 快照身份与代数（2026-11-24）：与 UIA snapshot 共用同一个进程级 sid 计数器
            SOM_STATE.sid = ++_snapshotSid;
            SOM_STATE.at = Date.now();
            SOM_STATE.targetHwnd = Number(SOM_STATE.hwnd) || 0;
            SOM_STATE.targetTitle = String(SOM_STATE.title || '').trim();
            // 第四轮 P2：记下 pid，用于识别「模型把 pid 当 hwnd 传」。som_annotate 只回
            // hwnd/title，所以这里用一次只读的 windows 查询补 pid（失败就 0，不影响标注）。
            SOM_STATE.pid = 0;
            try {
                if (SOM_STATE.hwnd) {
                    const wl = JSON.parse(require('child_process').execFileSync(_coreBin(), [], {
                        input: JSON.stringify({ cmd: 'windows', max: 200 }), timeout: 8000,
                        maxBuffer: 8 * 1024 * 1024, windowsHide: true,
                    }).toString());
                    const hit = (wl.windows || []).find((w) => Number(w.hwnd) === Number(SOM_STATE.hwnd));
                    if (hit) SOM_STATE.pid = Number(hit.pid) || 0;
                }
            } catch (e) { SOM_STATE.pid = 0; }
            // homing 基线（2026-11-10 三十八轮）：记下标注时刻窗口矩形，som_click 补偿用
            try { SOM_STATE.rect = await windowRealRect(SOM_STATE.title || ''); } catch (e) { SOM_STATE.rect = null; }
            const lines = (d.marks || []).map((m) => `#${m.id}[${m.type}]${String(m.name).slice(0, 20)}`);
            // #13 delivered_scale 契约（2026-11-10 三十八轮）：图被压缩时必须告诉模型
            // 「图上 1px ≠ 屏幕 1px」，并给它刻度尺这个校对锚（som_annotate 已画）
            const sc = d.scale || { x: 1, y: 1 };
            const scaled = Math.abs((sc.x || 1) - 1) > 0.01 || Math.abs((sc.y || 1) - 1) > 0.01;
            return VC.readonly(
                `「${d.title}」已标注 ${d.count} 个可点元素（源=${d.source}）：` + lines.slice(0, 24).join(' ') +
                (scaled ? `　⚠ 图已压缩到 ${Math.round((sc.x || 1) * 100)}%（scale=${sc.x}）——按像素点请读图边缘黄色刻度标签（屏幕坐标），别按图上像素估` : '') +
                '　→ 用 som_click 传编号',
                {
                    elements: d.marks,
                    // 2026-11-24 根因修：SoM 编号同样只属于这一代标注
                    snapshot_id: SOM_STATE.sid,
                    snapshot_at: SOM_STATE.at,
                    window: { hwnd: SOM_STATE.targetHwnd || 0, title: SOM_STATE.targetTitle || '' },
                    image: d.image,             // base64 JPEG：调用方决定是否附加给视觉模型
                    imageIsBase64: true,
                    source: d.source,
                    captured: d.captured || null,   // 采集时窗口像素
                    delivered: d.delivered || null, // 交付给模型的图像尺寸
                    scale: d.scale || null,         // delivered/captured（条件式承诺的乘数）
                    ruler: d.ruler || null,         // {step:200, unit:'screen_px'}
                    note: d.note || '',
                },
            );
        }
        case 'som_click': {
            // 点 SoM 标注图里的编号：走坐标点击（元素来自 UIA/OCR，坐标已换算成屏幕坐标）
            // 可观测（2026-11-21）：SoM 编号和 UIA 编号是**两套空间**，必须能看出
            // 「模型到底走的哪一条」—— 计数在编号解析之前，连空/错编号的调用也算。
            CONTROL_STATS.somClicks += 1;
            // ⚠ 2026-11-09 修（三十五轮）：原来这段有一句 `SendKeys('{ENTER}')` 的「让目标获焦」调用，
            //   注释自己都说「真正点击用 mouse_event 更稳」——但那个 ENTER 是真的按下去了，
            //   而且点完不验证。现在：① 删掉多余的 ENTER ② 走 actAndVerify 闭环。
            // 同上：接受 # 前缀（som_snapshot 输出也是 #N 格式）
            const idx = Number(String(a || '').replace(/^#/, '').trim()) || 0;
            if (!Array.isArray(SOM_STATE.marks) || !SOM_STATE.marks.length) {
                throw new Error('编号不存在（先 som_snapshot 拿标注图，再传编号）');
            }
            // 快照绑定校验（2026-11-24 根因修）：SoM 编号也只属于**那一代**标注。
            // 窗口对不上 / 标注超龄 → STALE_SNAPSHOT，且一次点击都不发。
            // 第四轮 P2：带真实 hwnd 的同一窗口放宽到 300s（窗口存活由下面 strict 前台断言兜底）。
            const somReqTitle = String(focus || '').trim();
            const somReq = {
                title: somReqTitle,
                hwnd: /^\d+$/.test(somReqTitle) ? Number(somReqTitle) : 0,
            };
            // pid/hwnd 撞车时先查实时窗口表：数字真是另一个窗口的 hwnd → 拒绝跨窗复用编号
            const somLiveHwnds = liveHwndsForCollisionCheck(SOM_STATE, somReq.hwnd);
            const somBind = checkSnapshotBinding(SOM_STATE, somReq, {
                maxAgeMs: somClickMaxAgeMs(SOM_STATE, somReq),
                liveHwnds: somLiveHwnds,
            });
            if (!somBind.ok) {
                return VC.notSent(somBind.detail, {
                    code: somBind.code, error: somBind.code, staleSnapshot: true,
                    staleReason: somBind.reason,
                    snapshot_id: somBind.snapshot_id, snapshot_age_ms: somBind.snapshot_age_ms,
                    snapshot_window: somBind.snapshot_window, requested_window: somBind.requested_window,
                    tier: 'L2',
                    nextIfFailed: '重新 som_snapshot（这一代编号已不可信），再 som_click；别在两次快照之间混用编号',
                });
            }
            const m = SOM_STATE.marks[idx - 1];
            if (!m) throw new Error('编号不存在（先 som_snapshot 拿标注图，再传编号）');
            // ⚠ 红队 S4 第二道（陈旧编号）：编号来自某一次 som_snapshot，而 SOM_STATE 是
            //   模块级单例。如果这中间又拍过任何快照（som_snapshot / snapshot），marks 和
            //   屏幕已经不是同一时刻 —— 编号 N 现在指向另一个窗口的第 N 个元素。
            //   拒绝并要求重拍，别拿旧编号点新窗口。
            if (SOM_STATE.seq && SOM_STATE.seq !== _stateSeq) {
                return VC.notSent('SoM 编号已过期：这次标注之后又拍过快照（当前世代 ' + _stateSeq +
                    '，这批编号是第 ' + SOM_STATE.seq + ' 代）——编号可能指向另一个窗口的同号元素，没发出去', {
                    error: 'stale_som_marks', seq: SOM_STATE.seq, latest: _stateSeq,
                    nextIfFailed: '重新 som_snapshot 拿这一代的编号，再 som_click；别在两次快照之间混用编号',
                });
            }
            // ── 统一守卫（2026-11-21 P0 根因修）──────────────────────────────
            // 编号 → marks[i] → 元素文本必须参与守卫，不能只凭坐标。
            // 原实现这条路径完全绕过 checkButton：SoM 标出的「不保存」会被直接点下去。
            // 放在 homing / 前台断言**之前**：拒绝时连一次窗口查询都不发。
            const somGuard = {
                name: String(m.name || ''), source: 'som_click',
                confirmDestructive: !!(extraCfg && extraCfg.confirm_destructive),
            };
            await assertClickGuard(somGuard);
            // 坐标 homing（2026-11-10 三十八轮）：SoM 编号坐标是「快照时代」的，
            // 窗口被拖动后整体漂移。判据同 click_at：只落在旧矩形才补偿。
            let tx = m.x, ty = m.y;
            let homed = null;
            if (SOM_STATE.rect && SOM_STATE.title) {
                try {
                    const wr = await windowRealRect(SOM_STATE.title);
                    if (wr) {
                        const dx = wr.x - SOM_STATE.rect.x, dy = wr.y - SOM_STATE.rect.y;
                        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
                            const inOld = geometry.rectContains(SOM_STATE.rect, tx, ty);
                            const inNew = geometry.rectContains(wr, tx, ty);
                            if (inOld && !inNew) {
                                tx += dx; ty += dy;
                                homed = { dx, dy, applied: true, from: { x: m.x, y: m.y }, to: { x: tx, y: ty } };
                            }
                        }
                    }
                } catch (e) { try { __silentAudit.audit('game-control:som-homing', e); } catch (e2) { /* ignore */ } }
            }
            // ⚠ 2026-11-10 红队审计（点击落到用户窗口）：SoM 编号来自上一次 som_snapshot，
            //   之后用户完全可能把窗口挪走/切走 —— 这条路径原来**没有任何前台断言**，
            //   clickAt 是真鼠标事件（SetCursorPos+mouse_event），会点到 (x,y) 上的任意窗口。
            //   现在：快照时有窗口身份就断言它仍是前台；不是就拒绝（让她重新 som_snapshot）。
            // 2026-11-21 P1 根因修：用**真实 hwnd 优先**（som_annotate 回填），
            // 不再拿占位文案「(前台窗口)」当窗口身份（strict 解析不到 → 永久 notSent）。
            if (SOM_STATE.hwnd || SOM_STATE.title) {
                const sfChk = await assertTargetFocused(SOM_STATE.hwnd || SOM_STATE.title, { strict: true });
                if (!sfChk.ok) {
                    return VC.notSent('SoM 快照的窗口「' + (SOM_STATE.title || ('hwnd ' + SOM_STATE.hwnd)) + '」现在不是前台，点击会落到别的窗口上——没发出去。先 focus_window 再重拍 som_snapshot', {
                        error: sfChk.error, foreground: sfChk.fg ? sfChk.fg.title : null,
                        target: { hwnd: SOM_STATE.hwnd || 0, title: SOM_STATE.title || '' },
                        nextIfFailed: '重新 som_snapshot（会顺带聚焦），再 som_click 编号',
                    });
                }
            }
            // ── P0-3（2026-11-25）：SoM 点击的验证 ────────────────────────────
            // SoM 的 marks 只有 name/type（没有 RuntimeId），所以 UIA 通道按 Name+ControlType
            // 回读目标元素状态；没有可回读元素时退到**编号附近**的局部像素；
            // 遮挡/屏外/最小化不猜（ok:false + verified:false + reason）。
            // 旧实现是「整窗 region 一变就 success」——视频/遮挡者的运动会把它变成假成功。
            const somName = String(m.name || '');
            const somType = String(m.type || '');
            const somPoint = { x: tx, y: ty };
            const somRect = { x: tx - 110, y: ty - 110, w: 220, h: 220 };
            const beforeSomState = await uiaElementState(SOM_STATE.hwnd, null, SOM_STATE.title, somName, somType);
            const cv = await CV.verifyClick({
                action: () => clickAt(tx, ty, 8000, '', '', Object.assign({}, somGuard, { x: tx, y: ty })),
                before: beforeSomState,
                rect: somRect,
                readState: () => uiaElementState(SOM_STATE.hwnd, null, SOM_STATE.title, somName, somType),
                sampleRect: (r) => regionGrayForRect(r),
                visibility: () => clickTargetVisibility(SOM_STATE.hwnd, SOM_STATE.title, somPoint, beforeSomState),
                waits: [350, 450],
            });
            const vr = CV.buildClickVerdict(cv, {
                name: '#' + idx + '「' + String(m.name).slice(0, 20) + '」',
                howLabel: 'SoM 坐标点击 @' + tx + ',' + ty,
            });
            if (homed) {
                vr.homed = homed;
                vr.detail = String(vr.detail || '') + `（窗口移动 ${homed.dx},${homed.dy}，已自动补偿）`;
            }
            if (vr.effect === 'suspected_noop') {
                vr.nextIfFailed = '点了画面没变：元素可能已失效（窗口变过），重新 som_snapshot 拿新编号再点';
            }
            // 可观测（2026-11-24）：这条点击用的是第几代标注、标注多久了
            vr.snapshot_id = somBind.snapshot_id;
            vr.snapshot_age_ms = somBind.snapshot_age_ms;
            // 第四轮 P2：传的是 pid 时明确提示「改用 hwnd / 标题」（本次已按快照窗口继续）
            if (somBind.note) { vr.identityNote = somBind.note.text; vr.identityNoteCode = somBind.note.code; }
            // 2026-11-25 P2-7：回执带「怎么匹配到的 + 匹配到的窗口身份」，便于模型/评测核对
            vr.matchedBy = somBind.matchedBy;
            vr.matched_window = somBind.matched;
            vr.via = 'som';
            vr.name = String(m.name).slice(0, 40);
            return vr;
        }
        case 'click_element': {
            // 按编号点 snapshot 菜单里的元素：UIA Pattern 直调（不占鼠标、不抢焦点）→ 坐标点击兜底。
            // ⚠ 2026-11-09 修（三十五轮）三处：
            //   ① 原来 spawn `uiaPsScript('click', ...)`，那条脚本用的是 v1 的浅遍历（扫不到 Electron 内容）
            //      → 实测点 ZCode 的「搜索」按钮永远返回「元素点不到」。改成走常驻服务 /click。
            //   ② 原来只看 `res.ok` = 「UIA 说没抛异常」≠「界面有反应」。补 dHash 闭环。
            //   ③ 元素不支持任何 Pattern 时，服务现在会返回坐标 —— 那就退化成真实坐标点击，
            //      而不是像以前那样直接判失败（自绘控件这条路本来就走不通）。
            // ⚠ 2026-11-10 三十七轮修（QQ 实战抓到）：工具描述让 LLM 传「#编号」，
            //   但 Number('#13') = NaN → || 0 → items[-1] undefined → 永远「编号不存在」。
            //   **所有带 # 的调用全挂**。接受 # 前缀（剥离后再解析）。
            const idx = Number(String(a || '').replace(/^#/, '').trim()) || 0;
            // ── 编号↔快照绑定校验（2026-11-24 根因修，fail-closed）────────────────
            // #编号属于**某一次**快照，不是全局编号。see 与 click 之间只要又拍过一次快照，
            // 编号就指向另一份（很可能是另一个窗口）——模型看到 A、点的是 B，还静默 ok。
            // 窗口对不上 / 快照超龄 → STALE_SNAPSHOT，**一次点击都不发**。
            if (!Array.isArray(UIA_SNAPSHOT_STATE.items) || !UIA_SNAPSHOT_STATE.items.length) {
                throw new Error('编号不存在（先 snapshot 拿菜单，再传 #编号；窗口变过就重新 snapshot）');
            }
            const reqWinTitle = String(focus || '').trim();
            const reqWinHwnd = /^\d+$/.test(reqWinTitle) ? Number(reqWinTitle) : 0;
            // pid/hwnd 撞车时先查实时窗口表：数字真是另一个窗口的 hwnd → 拒绝跨窗复用编号
            const snapLiveHwnds = liveHwndsForCollisionCheck(UIA_SNAPSHOT_STATE, reqWinHwnd);
            const snapBind = checkSnapshotBinding(UIA_SNAPSHOT_STATE, {
                title: reqWinTitle,
                hwnd: reqWinHwnd,
            }, { liveHwnds: snapLiveHwnds });
            if (!snapBind.ok) {
                return VC.notSent(snapBind.detail, {
                    code: snapBind.code, error: snapBind.code, staleSnapshot: true,
                    staleReason: snapBind.reason,
                    snapshot_id: snapBind.snapshot_id, snapshot_age_ms: snapBind.snapshot_age_ms,
                    snapshot_window: snapBind.snapshot_window, requested_window: snapBind.requested_window,
                    tier: 'L2',
                    nextIfFailed: '重新 see（mode=tree）拿这一份快照的编号，再点；别跨快照混用 #编号',
                });
            }
            const item = UIA_SNAPSHOT_STATE.items[idx - 1];
            if (!item) throw new Error('编号不存在（先 snapshot 拿菜单，再传 #编号；窗口变过就重新 snapshot）');
            // 破坏性按钮守卫（§71，2026-11-21 根因修）：不再在这里内联 checkButton ——
            // 守卫下沉到点击原语（actAndVerifySmart / uiaElementAction / coreUiaAction / clickAt），
            // 这样 click_text / som_click 也绕不过去。这里只构造**同一份**守卫信息并提前拒绝，
            // 避免走完身份校验/自动聚焦才发现该拦。
            const clickGuard = {
                name: item.name || item.label || item.title || '',
                source: 'click_element',
                rid: item.rid || null,
                confirmDestructive: !!(extraCfg && extraCfg.confirm_destructive),
            };
            await assertClickGuard(clickGuard);
            if (!item.rid) {
                return VC.notSent('这个元素没有 RuntimeId（snapshot 时取不到），无法直调', {
                    tier: 'L2',
                    nextIfFailed: '重新 snapshot 拿新菜单；或改用 som_snapshot + som_click 走坐标点击',
                });
            }

            // 窗口身份守卫（2026-11-10 三十七轮，抄 #11）：快照后窗口被关/被同名窗口顶替 → 拒绝
            //（防止「按标题打进了另一个同名窗口」——输入框/聊天窗同名场景真踩过）
            if (UIA_SNAPSHOT_STATE.hwnd) {
                let identity = null;
                try {
                    const wl = JSON.parse(require('child_process').execFileSync(_coreBin(), [], {
                        input: JSON.stringify({ cmd: 'windows', filter: UIA_SNAPSHOT_STATE.title || '', max: 20 }),
                        timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
                    }).toString());
                    identity = (wl.windows || []).find((w) => Number(w.hwnd) === Number(UIA_SNAPSHOT_STATE.hwnd) && !w.iconic) || null;
                } catch (e) { identity = null; }
                if (!identity) {
                    return VC.notSent('窗口身份已变：快照时的窗口（hwnd ' + UIA_SNAPSHOT_STATE.hwnd + '）已关闭——重新 snapshot', {
                        identityChanged: true,
                        snapshot_id: snapBind.snapshot_id, snapshot_age_ms: snapBind.snapshot_age_ms,
                        snapshot_window: snapBind.window,
                        nextIfFailed: '目标窗口被关了。若同名窗口还在，重新 snapshot 会绑定到新 hwnd',
                    });
                }
                // 身份守卫深化（2026-11-10 三十八轮，抄 #11 的完整版）：hwnd 会被 Windows 复用，
                // 「hwnd 还在但 pid 变了」= 已经是另一个进程的窗口，坐标全不可信 → 拒绝。
                if (UIA_SNAPSHOT_STATE.pid && identity.pid && Number(identity.pid) !== Number(UIA_SNAPSHOT_STATE.pid)) {
                    return VC.notSent(
                        '窗口身份已变：hwnd ' + UIA_SNAPSHOT_STATE.hwnd + ' 现在是另一个进程的窗口（快照时 pid ' +
                        UIA_SNAPSHOT_STATE.pid + '，现在 pid ' + identity.pid + '）——hwnd 被系统复用了。重新 snapshot',
                        { identityChanged: true, pidWas: UIA_SNAPSHOT_STATE.pid, pidNow: identity.pid,
                          snapshot_id: snapBind.snapshot_id, snapshot_age_ms: snapBind.snapshot_age_ms,
                          snapshot_window: snapBind.window,
                          nextIfFailed: '原窗口已关。重新 snapshot 绑定新窗口后再点' },
                    );
                }
            }
            // 虚拟光标（2026-11-14 五十三轮）：Invoke 不动真实鼠标 ——
            // 没有这个指示，用户完全看不见她在点哪。
            if (Number.isFinite(item.x) && Number.isFinite(item.y)) {
                notifyCursor(item.x, item.y, '点「' + String(item.name || '').slice(0, 12) + '」');
            }
            // ── P0-3 / P1-7（2026-11-21）：三级回落 + 可见性闸 ────────────────
            // 以前：Invoke 失败后交给 uia-service 的 /click，它内部会自己做 SetCursorPos
            //   （150% 缩放下会偏），而且没有 IsOffscreen/IsEnabled 检查。
            // 现在：powershell 5.1 里按 Invoke → Toggle → SelectionItem.Select 顺序试；
            //   都没有就返回 BoundingRectangle（已 SetProcessDPIAware，物理坐标）中心，
            //   由 JS 交给 pet-core 的坐标入口（P2-10 单点收口，PS 侧不再点坐标）。
            //   门禁：IsOffscreen 先 ScrollIntoView，仍不可见/被禁用 → element_unavailable。
            // 目标窗口身份以**快照记录**为准（编号属于那一代快照）；请求窗口只用于校验。
            // （旧实现回落到 `a` —— 那是编号 '5'，拿它当窗口标题是错的方向）
            const targetTitle = String(UIA_SNAPSHOT_STATE.targetTitle || UIA_SNAPSHOT_STATE.title || snapBind.window.title || focus || '');
            const targetHwnd = Number(snapBind.window.hwnd || UIA_SNAPSHOT_STATE.hwnd) || 0;
            // ── P0-3（2026-11-25）：验证改「UIA 回读为准，元素矩形像素为辅」──────
            // 旧实现用 actAndVerifySmart + 整窗 region：region 一变化就先判成功，
            //   连 UIA 树都不看 —— 窗口被遮挡时把遮挡者的运动当证据（假成功），
            //   窗口在屏外时把静止桌面当「没反应」（假 noop）。
            // 新顺序（见 control-verify.js 的 verifyClick）：
            //   ① 回读目标元素状态（ToggleState/Value/IsEnabled/焦点/选中/名称/是否还在），
            //      任一变化 → verified:true, method:'uia'；
            //   ② 元素没有状态（普通按钮）→ 只采**目标元素矩形**的局部像素差 → method:'pixels'；
            //   ③ 遮挡 / 屏外 / 最小化 → 不猜，ok:false + verified:false + reason。
            const rectFromState = (s) => {
                if (!s || s.ok === false || s.found === false) return null;
                const x = Number(s.x); const y = Number(s.y);
                const w = Number(s.w); const h = Number(s.h);
                if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
                return { x, y, w, h };
            };
            const rectFromItem = (() => {
                const w = Number(item.w); const h = Number(item.h);
                if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
                    return { x: Number(item.x), y: Number(item.y), w, h };
                }
                const cx0 = Number(item.x); const cy0 = Number(item.y);
                if (!Number.isFinite(cx0) || !Number.isFinite(cy0)) return null;
                return { x: cx0 - 110, y: cy0 - 110, w: 220, h: 220 };
            })();
            const beforeState = await uiaElementState(targetHwnd, item.rid, targetTitle);
            const verifyRect = rectFromState(beforeState) || rectFromItem;
            const verifyPoint = verifyRect
                ? { x: verifyRect.x + verifyRect.w / 2, y: verifyRect.y + verifyRect.h / 2 }
                : ((Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y)))
                    ? { x: Number(item.x), y: Number(item.y) } : null);
            const doClick = async () => {
                // 守卫必须抢在任何后端调用之前（与旧 actAndVerifySmart 的语义一致）
                if (clickGuard && clickGuard.name) {
                    const g = await guardClickTarget(clickGuard);
                    if (g) throwClickGuard(g);
                }
                let el = null;
                try { el = await uiaElementAction(targetTitle, item.rid, 12000, targetHwnd, clickGuard); }
                catch (e) {
                    // 守卫拒绝必须原样抛出：不能被当成「元素找不到」然后继续走 core/坐标兜底
                    if (e && e.guardBlocked) throw e;
                    el = { ok: false, found: false, error: String(e && e.message || e) };
                }
                // PowerShell 5.1 不可用 / 探测失败 → 至少退 pet-core 的 invoke（不动鼠标）
                if (!el || el.found === false) {
                    const core = await coreUiaAction(String(targetHwnd || targetTitle), item.rid, 'invoke', undefined, clickGuard);
                    if (core && core.ok === true) {
                        return {
                            ok: true, found: true, how: 'invoke', name: core.name || item.name,
                            actions: (core.actions || []).join(','), pid: UIA_SNAPSHOT_STATE.pid,
                        };
                    }
                    const psErr = String((el && el.error) || '');
                    const coreErr = String((core && (core.error || core.detail)) || '');
                    // 只有「真的找不到这个元素」才算 stale；PS 不可用 / 无 Invoke 能力不能误导成「重新 snapshot」
                    const stale = /no-target|没找到|失效/.test(psErr) || /失效/.test(coreErr);
                    return {
                        ok: false, found: false, stale,
                        error: psErr || coreErr || '元素找不到',
                        name: item.name,
                    };
                }
                const gate = gateElementState(el);
                if (!gate.ok) {
                    return {
                        ok: false, found: true, code: gate.code, error: gate.reason,
                        offscreen: el.offscreen === true, enabled: el.enabled !== false,
                        scrolled: el.scrolled === true, name: el.name || item.name,
                        pid: el.pid || UIA_SNAPSHOT_STATE.pid,
                    };
                }
                // 这套元素支持哪些档：Invoke → Toggle/Select → 坐标（坐标永远在最后）
                const plan = elementFallbackPlan(el);
                if (el.ok === true && plan.includes(el.how)) {
                    return Object.assign({}, el, {
                        how: el.how, plan, pid: el.pid || UIA_SNAPSHOT_STATE.pid,
                    });
                }
                // 第三档：坐标（UIA 物理矩形中心 → pet-core；仍先过前台校验）
                const cx = Number.isFinite(Number(el.x)) ? Number(el.x) : item.x;
                const cy = Number.isFinite(Number(el.y)) ? Number(el.y) : item.y;
                const fgChk = await assertTargetFocused(targetTitle, { strict: true });
                if (!fgChk.ok) {
                    return {
                        ok: false, found: true, noPattern: true,
                        hasRect: Number.isFinite(cx) && Number.isFinite(cy),
                        vetoCode: VETO.FOCUS_LOST, error: fgChk.error,
                        targetPid: Number(el.pid) || Number(UIA_SNAPSHOT_STATE.pid) || 0,
                        fgPid: fgChk.fgPid, x: cx, y: cy, name: el.name || item.name,
                    };
                }
                const rr = await clickAt(cx, cy, 8000, targetTitle, '', clickGuard);
                return Object.assign({}, rr, {
                    ok: rr && rr.ok !== false, how: 'coord', plan, noPattern: plan.length === 1, hasRect: true,
                    x: cx, y: cy, name: el.name || item.name, pid: el.pid || UIA_SNAPSHOT_STATE.pid,
                });
            };
            const cv = await CV.verifyClick({
                action: doClick,
                before: beforeState,
                rect: verifyRect,
                readState: () => uiaElementState(targetHwnd, item.rid, targetTitle),
                sampleRect: (r) => regionGrayForRect(r),
                visibility: () => clickTargetVisibility(targetHwnd, targetTitle, verifyPoint, beforeState),
                waits: [350, 450],
            });

            const ar = (cv && cv.actionResult) || {};

            // P1-7：可见性闸拒绝（没发盲点）
            if (ar.code === 'element_unavailable') {
                return VC.notSent('元素不可用（' + ar.error + '）——没发点击', {
                    code: 'element_unavailable',
                    elementUnavailable: true,
                    element: { rid: item.rid, name: String(ar.name || item.name || '') },
                    offscreen: ar.offscreen === true,
                    enabled: ar.enabled !== false,
                    scrolled: ar.scrolled === true,
                    snapshot_id: snapBind.snapshot_id, snapshot_age_ms: snapBind.snapshot_age_ms,
                    tier: 'L2',
                    nextIfFailed: '先把元素滚进可视区/展开所在面板（或重新 snapshot 看它是否还在）；被禁用的控件本来就不能点',
                });
            }
            // 坐标兜底被前台校验拦住 → 交给外层 runGameAction 的 autoFocus 重试
            if (ar.vetoCode === VETO.FOCUS_LOST) {
                return VC.notSent('元素找到了（「' + String(ar.name || item.name || '').slice(0, 20) + '」），但' + ar.error, {
                    vetoCode: VETO.FOCUS_LOST,
                    targetPid: ar.targetPid || UIA_SNAPSHOT_STATE.pid || 0,
                    fgPid: ar.fgPid || 0,
                    elementName: String(ar.name || item.name || '').slice(0, 60),
                    snapshot_id: snapBind.snapshot_id, snapshot_age_ms: snapBind.snapshot_age_ms,
                    tier: 'L2',
                    nextIfFailed: '坐标兜底只认前台：先 focus_window 把目标窗口调到前台再重试',
                });
            }
            if (ar.ok !== true) {
                // 真·动作没发出去（元素失效 / 最小化 / 找不到）
                return VC.notSent('元素点不到（' + (ar.error || '未知原因') + '）', {
                    tier: 'L2',
                    stale: ar.stale === true,
                    iconic: ar.iconic === true,
                    nextIfFailed: ar.iconic
                        ? '窗口最小化了：先 focus_window 恢复，再 snapshot 拿新菜单'
                        : (ar.stale ? '元素失效了（窗口内容变过）：重新 snapshot 拿新编号' : '窗口可能变过：重新 snapshot 拿新菜单；自绘控件改用 som_snapshot + som_click'),
                    name: String(item.name || '').slice(0, 40),
                    snapshot_id: snapBind.snapshot_id, snapshot_age_ms: snapBind.snapshot_age_ms,
                });
            }
            const howText = ar.how === 'coord' ? 'UIA 无 Pattern，已改用坐标点击（pet-core 物理坐标）'
                : ar.how === 'toggle' ? 'Toggle 直调'
                    : ar.how === 'select' ? 'SelectionItem.Select 直调'
                        : 'Invoke 直调，没动你的鼠标';
            // P0-3：契约按「验证通道」落 —— uia / pixels / none，且 verified:false 绝不当成功
            const vr = CV.buildClickVerdict(cv, {
                name: String(ar.name || item.name || '元素'),
                howLabel: howText,
            });
            if (vr.effect === 'suspected_noop') {
                vr.nextIfFailed = 'UIA 调用成功了但界面没反应：控件可能不是真按钮，或操作被弹窗挡住了。先 snapshot 看现场';
            }
            vr.via = ar.how === 'coord' ? 'uia-coord-fallback' : 'uia-element';
            vr.how = ar.how;
            // ⚠ 2026-11-09 三十五轮：把元素名带回给调用方。
            //   原来只带 how，index.js 记经验时只能用编号（「click_element 5」）——
            //   编号每轮都变，这条经验下次毫无用处。
            //   带上 name 后能记成「click_element 首 页」，下次能作为「这个按钮可点」的知识。
            vr.elementName = String(ar.name || item.name || '').slice(0, 60);
            // 可观测（2026-11-24 根因修）：这次点击用的是第几代快照、快照多久了。
            // 现有字段结构上追加，不破坏调用方。
            vr.snapshot_id = snapBind.snapshot_id;
            vr.snapshot_age_ms = snapBind.snapshot_age_ms;
            if (snapBind.usedOwnWindow) vr.snapshot_window = snapBind.window;
            // 第四轮 P2：focus 传了 pid 时明确提示「这是 pid，请改用 hwnd 或标题」
            if (snapBind.note) { vr.identityNote = snapBind.note.text; vr.identityNoteCode = snapBind.note.code; }
            // 2026-11-25 P2-7：回执带「怎么匹配到的 + 匹配到的窗口身份」，便于模型/评测核对
            vr.matchedBy = snapBind.matchedBy;
            vr.matched_window = snapBind.matched;
            // P1-6：动作返回前等目标窗口 UIA 树稳定（连续两次哈希相同，最多 400ms）
            try {
                const st = await waitUiStable({ title: targetTitle, maxWaitMs: 400 });
                vr.uiStable = st;
                if (st.stable === true) {
                    vr.evidence = String(vr.evidence || '') + (vr.evidence ? '；' : '') +
                        '界面已稳定（UIA 树 ' + st.hash + '，连续 2 次）';
                } else if (st.stable === false) {
                    vr.evidence = String(vr.evidence || '') + (vr.evidence ? '；' : '') +
                        '界面仍在变化（' + st.samples + ' 次采样未稳定）';
                }
            } catch (e) { /* 稳定等待失败不影响动作结论 */ }
            return vr;
        }
        case 'list_windows': {
            // 操控②窗口枚举（只读，不走 rateGate）：她能「看看现在开着什么」再决策——
            // 先看窗口再 focus_window/操作，比盲猜标题可靠一个量级。
            // ⚠ 2026-11-09 三十五轮改：优先走常驻 UIA 服务 /list（实测 <20ms），
            //   原实现每次 spawn pwsh 跑 Get-Process | Where MainWindowTitle（实测 8s 超时）。
            //   差别在「进程枚举」vs「窗口枚举」——UI Automation 本来就按窗口粒度列，更准也更快。
            let list = [];
            let viaService = false;
            // ① Rust 内核（实测 4ms，15 个窗口）
            //    比 UIA 服务版（255ms）快 60 倍，因为 EnumWindows 只查窗口、不碰无障碍树。
            //    返回的字段也更多：hwnd / class / iconic / owned（有 owner 的多半是对话框）。
            const coreBin = _coreBin();
            if (coreBin) {
                const rust = await new Promise((resolve) => {
                    try {
                        const { execFile } = require('child_process');
                        const child = execFile(coreBin, [], { windowsHide: true, timeout: 4000, maxBuffer: 2 * 1024 * 1024 },
                            (err, stdout) => {
                                if (err) return resolve(null);
                                try {
                                    const d = JSON.parse(String(stdout));
                                    resolve(d && d.ok && Array.isArray(d.windows) ? d : null);
                                } catch (e) { resolve(null); }
                            });
                        // ⚠ 2026-11-15 五十八轮：filter（arg）原来**根本没传进去** ——
                        //   `list_windows 记事本` 永远返回全部窗口，和当年 `apps` 白名单没传进
                        //   extraCfg 是同一类坑：参数写在工具描述里，实现里漏接。
                        try { child.stdin.end(JSON.stringify({ cmd: 'windows', max: 40, filter: String(a || '') }), 'utf8'); } catch (e) { resolve(null); }
                    } catch (e) { resolve(null); }
                });
                if (rust) {
                    list = rust.windows.map((w) => ({
                        // 规范字段（2026-11-15 起新代码只认这三个 + hwnd/iconic/rect）
                        title: w.title, pid: w.pid, class: w.class,
                        // 兼容别名：历史调用方（控制中心 / 手机页 / 知识库）还在读这些
                        MainWindowTitle: w.title, Id: w.pid, ProcessName: w.class,
                        hwnd: w.hwnd, iconic: w.iconic, owned: w.owned,
                        // 2026-11-21：最大化态必须透传（负原点 rect 是合法值）
                        maximized: w.maximized === true,
                        x: w.x, y: w.y, w: w.w, h: w.h,
                    }));
                    viaService = true;
                }
            }
            // ② UIA 服务兜底（255ms）
            if (!viaService && await ensureUiaService()) {
                const svc = await _uiaPost('/list', {}, 4000);
                if (svc && svc.ok && Array.isArray(svc.windows)) {
                    list = svc.windows.map((w) => ({ title: w.name, pid: w.pid, class: w.cls, MainWindowTitle: w.name, ProcessName: w.cls, Id: w.pid }));
                    viaService = true;
                }
            }
            // ③ pwsh 最后兜底（8s，但保证能用）
            if (!viaService) {
                const r = await runPs(`$w = @(Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First 20 ProcessName, Id, MainWindowTitle); if ($w.Count -eq 0) { '[]' } else { $w | ConvertTo-Json -Compress }`, 8000);
                if (!r.ok && !r.out) throw new Error('窗口枚举失败：' + r.error);
                try {
                    const parsed = JSON.parse(r.out || '[]');
                    list = Array.isArray(parsed) ? parsed : [parsed];
                } catch (e) {
                    throw new Error('窗口枚举输出异常：' + String(r.out).slice(0, 80));
                }
            }
            // 拖动预览窗不是业务窗口：三条通道统一在这里摘掉（Rust 通道已在 coreWindows 摘过）
            list = list.filter((w) => !isDragPreviewWin(w));
            // 兜底路径（UIA 服务 / pwsh）不吃 filter —— 在这里统一过滤一次，
            // 保证「传了 filter 就一定生效」，而不是看走了哪条通道。
            const want = String(a || '').trim().toLowerCase();
            if (want) {
                list = list.filter((w) => String(w.title || w.MainWindowTitle || w.name || '').toLowerCase().includes(want));
            }
            const lines = list.map((w) => `${w.title || w.MainWindowTitle}（#${w.Id || w.pid}）`);
            return VC.readonly(
                lines.length ? `当前可见窗口 ${lines.length} 个：` + lines.join('；') : '当前没有带标题的可见窗口',
                { windows: list.map((w) => {
                    const title = w.title || w.MainWindowTitle || w.name || '';
                    const appProc = w.app || w.proc || w.ProcessName || _expAppFor(w.pid || w.Id, title);
                    return { ...w, route: guiRoute(title, w.class || w.ProcessName || w.cls || '', appProc) };
                }), via: viaService ? (_coreBin() ? 'rust' : 'uia-service') : 'pwsh' },
            );
        }
        // 窗口生命周期（2026-11-15 五十八轮）：min/max/restore/close/move/size/all_min
        // arg = op；参数走 extraCfg.win = { target, x, y, w, h }
        case 'window_op': {
            // 两种写法都认（都是本仓既有习惯）：
            //   · "op|目标|x,y,w,h" —— 工具面编码，目标里可以有空格（与 focus_window 的 "标题|force" 同源）
            //   · extraCfg.win = { target, x, y, w, h } —— 结构化调用/单测用
            const raw = String(a || '').trim();
            const seg = raw.split('|');
            const op = (seg[0] || '').trim();
            const o = Object.assign({}, (extraCfg && extraCfg.win) || {});
            if (!o.target && seg[1]) o.target = seg[1].trim();
            if (seg[2]) {
                const nums = seg[2].split(',').map((v) => Number(String(v).trim()));
                if (op === 'move') { o.x = nums[0]; o.y = nums[1]; }
                else if (op === 'size') { o.w = nums[0]; o.h = nums[1]; }
            }
            const tgt = String(o.target || focus || '').trim();
            const allowed = new Set(['min', 'max', 'restore', 'close', 'move', 'size', 'all_min']);
            if (!allowed.has(op)) {
                throw new Error('window_op：op 只能是 min / max / restore / close / move / size / all_min（收到「' + op + '」）');
            }
            if (op !== 'all_min' && !tgt) {
                throw new Error('window_op：需要目标窗口（给标题片段 / hwnd / pid）');
            }
            if (op === 'move' && (!Number.isFinite(Number(o.x)) || !Number.isFinite(Number(o.y)))) {
                throw new Error('window_op move：需要 x 和 y（写法 move|目标|x,y）');
            }
            if (op === 'size' && (!Number.isFinite(Number(o.w)) || !Number.isFinite(Number(o.h)))) {
                throw new Error('window_op size：需要 w 和 h（> 0，写法 size|目标|w,h）');
            }
            const r = await windowOp(tgt, op, o);
            if (!r.ok) {
                return VC.notSent('窗口操作没成：' + (r.error || '未知原因'), {
                    error: r.error || 'window_op failed',
                    unresolved: r.unresolved === true,
                    resolution: r.resolveDetail || '',
                    nextIfFailed: r.unresolved
                        ? '先 list_windows 确认窗口标题/hwnd；解析不到不会「取第一个」乱操作'
                        : '先 see mode=windows 确认窗口还在（按标题/hwnd）；不要盲目重试 close',
                });
            }
            const rect = r.rect ? (r.rect.w + '×' + r.rect.h + ' @' + r.rect.x + ',' + r.rect.y) : '';
            const warn = r.warning ? ('（注意：' + r.warning + '）') : '';
            // 多命中留痕（2026-11-21 P2）：同名窗口时告诉她到底选了哪个 hwnd。
            const pickNote = r.multiHit ? ('（' + r.resolveDetail + '）') : '';
            const detail = op === 'all_min'
                ? ('最小化了 ' + r.count + ' 个窗口' + (tgt ? '（匹配「' + tgt + '」）' : ''))
                : ('窗口「' + (r.title || tgt) + '」' + op + '：iconic=' + r.iconic + (rect ? ' · ' + rect : '') + warn + pickNote);
            return VC.confirmed(detail, {
                effect: 'window_op_' + op, iconic: r.iconic, maximized: r.maximized === true, rect: r.rect, count: r.count,
                hwnd: r.hwnd || r.resolvedHwnd || 0, warning: r.warning,
                targetHwnd: r.resolvedHwnd || 0, multiHit: r.multiHit === true, resolution: r.resolveDetail || '',
            });
        }

        case 'focus_window': {
            if (!a) throw new Error('要聚焦的窗口标题呢');
            // arg 支持 "标题|force" 显式要求强制切换（SwitchToThisWindow 兜底）
            // ⚠ 2026-11-09 实测：全屏置顶游戏（VALORANT）连 SwitchToThisWindow 都切不过去，
            //   而且**最小化也不改变 GetForegroundWindow**（Windows 允许最小化窗口持有前台）。
            //   所以 force 不是万能的 —— 失败时会明确报「前台还是 X」。
            const fparts = String(a).split('|');
            const focusTarget = fparts[0].trim();
            const focusForce = /force/i.test(fparts[1] || '');
            // ⚠ 2026-11-09 三十五轮改：优先走常驻 UIA 服务 /focus（毫秒级 + AttachThreadInput 三段式 + 自带复核），
            //   原实现 spawn pwsh 跑 WScript.Shell.AppActivate（实测 300ms+ 且复核另花一次 spawn）。
            //   纯数字（pid）也交给服务处理——WinEnum.Focus 支持直接传 hwnd/pid。
            // 先走 focusWindow（内部是 Rust 优先，会带 force）
            // ⚠ 2026-11-14：加短重试 —— 刚 launch_app 出来的窗口可能还没被枚举到
            //   （执行档案：launch_app 计算器 confirmed 之后紧接 focus_window 就 not_sent）。
            const fw = await focusWindowRetry(focusTarget, {
                force: focusForce,
                // 中文应用名 → exe：标题匹配不上时按进程名找（记事本/PCL 实测必需）
                apps: Object.assign({}, BUILTIN_APPS, (extraCfg && extraCfg.apps) || {}),
            });
            // ── P0-3（2026-11-25）：ok 不算数，**回读前台**才算 ────────────────
            // 旧实现只看 fw.ok 就 VC.confirmed —— pwsh 兜底返回的 ok 只是
            // 「SetForegroundWindow 请求被接受」，Windows 前台锁下这经常不等于前台变了。
            // 现在统一回读 GetForegroundWindow，confirmed 只在 verified===true 时置位
            // （见 control-verify.buildFocusVerdict）；不然 ok:false + verified:false + actual。
            const fgNow = await getForegroundInfo();
            return CV.buildFocusVerdict(fw, fgNow, focusTarget);
        }
        case 'press_key': {
            notifyKeyTag('按键 ' + String(a || '').slice(0, 20));
            const seq = toSendKeys(a);
            // ⚠ 2026-11-09 第一性原理复盘 P0：SendInput 没有 hwnd 参数，永远发给**当前前台窗口**。
            // 如果目标不在前台，按键会落到别人身上但工具还返回 ok —— 这是「假成功」的典型。
            // 实测踩到：press_key ctrl+f 说「已按」，实际 Ctrl+F 落到了 ZCode 里。
            // 所以：有 focus 就先 focus 到目标；同时断言焦点真的对了。
            if (focus) {
                await focusWindow(focus);
                await new Promise((r) => setTimeout(r, 200));
            }
            const focusChk = await assertTargetFocused(focus || '', { strict: true });
            if (!focusChk.ok) {
                return VC.notSent(focusChk.error, {
                    vetoCode: VETO.FOCUS_LOST,
                    targetPid: Number(focusChk.targetPid) || 0,
                    fgPid: Number(focusChk.fgPid) || 0,
                    nextIfFailed: '先 focus_window "' + focus + '" 再重试；或者不带 focus 直接按给当前前台',
                });
            }
            // ── 2026-11-25 P1-1：游戏判据（复用 profile/进程/内置游戏名，三路任一命中）──
            // GLFW 游戏（MC）实测丢弃 SendInput，只认 PostMessage（js/core/game-loop.js:648-662）。
            // 通用入口原来把 SendInput 当第一档，于是 act key 对 MC 永远「已按但角色不动」。
            // 现在：游戏 → 直接 postKeysTo（同款 WM_KEYDOWN/WM_KEYUP + 字符键映射）；
            //       非游戏 → 保持原 SendInput 链。PostMessage 失败**不回退**，直接报错。
            const fgRoute = focusChk.fg || (await getForegroundInfo());
            const route = decideKeyRoute({
                title: String((fgRoute && fgRoute.title) || ''),
                app: String((fgRoute && fgRoute.proc) || ''),
                hwnd: Number(fgRoute && fgRoute.hwnd) || 0,
            }, _gameProfiles());
            if (route.method === 'postmessage') {
                if (route.error) {
                    return VC.notSent(route.error, { method: 'postmessage', game: route.game, action_sent: false });
                }
                // 投递目标是**实际判成游戏的前台 hwnd**（不是调用方传的标题/兄弟窗口）：
                // assertTargetFocused 允许同 pid 的模态/兄弟窗口，只有回读到的 hwnd 才是游戏画面。
                const postTarget = String(route.hwnd);
                let post = null;
                try { post = await postKeysTo(postTarget, a); }
                catch (e) { post = { ok: false, reason: 'post-threw', error: String((e && e.message) || e) }; }
                if (!post || post.ok !== true) {
                    return VC.notSent('游戏按键 PostMessage 投递失败：' + String((post && (post.error || post.reason)) || '未知'), {
                        method: 'postmessage', game: route.game, hwnd: route.hwnd,
                        reason: (post && post.reason) || 'post-failed',
                        nextIfFailed: '确认窗口还活着、按键名受支持（a-z/0-9/F1-F12/方向键/space/enter/esc）；' +
                            '游戏只认 PostMessage，不会静默回退 SendInput',
                    });
                }
                return VC.unverified(`已后台投递 ${a} → ${route.game || focus || ('hwnd ' + route.hwnd)}（PostMessage，游戏只认这个）`, {
                    method: 'postmessage', game: route.game, hwnd: post.hwnd,
                    evidence: 'PostMessage WM_KEYDOWN/WM_KEYUP 已投递（GLFW 游戏丢弃 SendInput）',
                    nextIfFailed: 'PostMessage 投递成功 ≠ 对方处理了；没反应先 see image 看画面，别连按',
                });
            }
            // 执行链：① SendInput（非游戏默认） ② PostMessage ③ SendKeys
            // target 带上 → pet-core 在注入前再断言一次前台（双保险：这里断言过一次，
            // 但这两次之间用户可能切走窗口；SendInput 只认前台，切走就是打进别人的应用）
            const si = await sendInputKey(a, 0, focus || '');
            if (si.ok) {
                // 按键是「瞬时动作」，画面不一定马上变（比如按了下方向键但光标还没动）。
                // 所以这一档标 unverified（动作确实发出去了、焦点也确认对了，但效果得靠调用方自己看）。
                return VC.unverified(`已按：${a}${focus ? '（→' + focus + '）' : ''}（SendInput，焦点已确认）`, {
                    method: 'sendinput',
                    evidence: 'SendInput 已发送，焦点确认在「' + (focusChk.fg ? focusChk.fg.title : '当前前台') + '」',
                    nextIfFailed: '按键发出去了但没法自动确认效果——如果没反应，先用 snapshot 看看界面状态，别重复按（可能已经生效了）',
                });
            }
            // 非游戏路径的旧兜底：focus 给了先 PostMessage 后台投递（不抢焦点）；失败/不认再硬发
            if (focus) {
                const post = await postKeysTo(focus, a);
                if (post.ok) return VC.unverified(`已后台投递 ${a} → ${focus}（PostMessage，没动你的焦点）`, {
                    method: 'postmessage',
                    evidence: 'PostMessage 投递成功，但投递成功 ≠ 对方处理了',
                    nextIfFailed: 'PostMessage 对游戏/Chromium 自绘窗口常常无效。没生效就改用 focus_window 后不带 focus 重试（走 SendInput 硬发）',
                });
            }
            const r = await runPs(wsScript(`$ws.SendKeys('${seq.replace(/'/g, "''")}'); 'sent'`));
            if (!r.ok) return VC.notSent('按键失败：' + r.error, { method: 'sendinput', nextIfFailed: 'SendInput 和 SendKeys 都失败了，检查 send-input 服务（8104）是否在跑' });
            return VC.unverified(`已按：${a}${focus ? '（→' + focus + '）' : ''}（SendKeys 兜底）`, {
                method: 'sendkeys',
                evidence: 'SendKeys 已发送（最不可靠的一档，依赖焦点和键盘布局）',
                nextIfFailed: 'SendKeys 兜底路径，可靠性最低。没生效就先启动 send-input 常驻服务（8104）',
            });
        }
        case 'edit_text': {
            // 回读输入框（2026-11-10 三十九轮实测补的缺口）：她会 type_text 但**没有工具验证输入结果**，
            // 只能靠截图/OCR 猜——「已输入 N 字符」不等于「已生效」是本项目反复踩的铁律。
            // 这个动作走 pet-core 的 read_edit_text（WM_GETTEXT，支持 Edit/RichEdit/RichEditD2DPT/
            // WindowsForms EDIT 等类名），返回文本 + 类名 + 长度。
            // arg：留空（默认取 focus 窗口的编辑控件）；可选传窗口标题。
            const etTarget = String(a || focus || '').trim();
            if (!etTarget) {
                return VC.notSent('edit_text 需要窗口（arg 或 focus）：告诉我读哪个窗口的输入框', {
                    nextIfFailed: '例如 focus:记事本 或 arg:计算器',
                });
            }
            const binEt = _coreBin();
            if (!binEt) return VC.notSent('Rust 内核不可用，读不了 edit 文本', { nextIfFailed: '确认 pet-core 已构建' });
            let et = null;
            try {
                et = JSON.parse(require('child_process').execFileSync(binEt, [], {
                    input: JSON.stringify({ cmd: 'edit_text', target: etTarget }), timeout: 8000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
                }).toString());
            } catch (e) { et = { ok: false, error: String(e && e.message || e) }; }
            if (!et || et.ok !== true) {
                return VC.notSent('读不到「' + etTarget + '」的输入框：' + String((et && et.error) || '未知'), {
                    nextIfFailed: '确认窗口有可编辑控件（记事本/输入框）；自绘输入框（QQ/微信）读不到，改用 som_snapshot 看画面',
                });
            }
            return VC.readonly('「' + etTarget + '」输入框（' + (et.class || '?') + '）当前内容 ' + String(et.text || '').length + ' 字：' + String(et.text || '').slice(0, 300), {
                text: et.text || '', len: String(et.text || '').length, cls: et.class || '', via: 'rust-wm-gettext',
            });
        }
        case 'type_text': {
            if (!a) throw new Error('要输入的文字呢');
            notifyKeyTag('输入 ' + String(a).slice(0, 12) + (String(a).length > 12 ? '…' : ''));
            // ⚠ 红队 S7（无长度上限）：Rust 每字 8ms、execFile 20s 超时 → 2500 字约 20s
            //   刚好卡在超时线上；超时后回落 8104 会**从头重打** → 文本重复一半。
            //   现在硬上限 500 字（约 4s，留足余量），超出直接拒绝并要求分段。
            if (a.length > 500) {
                return VC.notSent('一次最多输入 500 字（收到 ' + a.length + ' 字，超出 ' + (a.length - 500) + ' 字）——没发出去', {
                    error: 'too_long', sent: 0, total: a.length, max: 500,
                    nextIfFailed: '把文字分段（每段 ≤500 字），每段单独 type_text；段与段之间用 edit_text 回读确认，别整段重发（会重复）',
                });
            }
            // ⚠ 2026-11-09 修（用户实测「叫她开QQ发消息做不到」的根因之二）：
            // 原实现把 PostMessage（WM_CHAR 后台投递）排第一并直接 return ok——
            // 但 PostMessage 对 Chromium/自绘输入框（QQ/微信/Electron 应用）**完全无效**，
            // 消息进了窗口队列但控件不响应。日志写「已后台输入 2 个字符」= **假成功**。
            // 现在改为执行链：
            //   ① 有 focus → 先聚焦窗口（真焦点，不是后台投递）
            //   ② SendInput 逐字符真输入（走系统输入流，任何应用都认）
            //   ③ 只有 SendInput 不可用时才回落到 PostMessage（并明确告知可能无效）
            // 2026-11-14 五十三轮：聚焦失败**不再照发**。原来 `focusWindow` 失败只加一句
            // 「⚠ 聚焦失败，可能没落到目标窗口」然后就往当前前台打字 —— 那就是打到用户窗口里。
            // 现在失败即 notSent（focusOrVeto 里会把前台是谁告诉他）。
            const pf = await focusOrVeto(focus, '输入');
            if (!pf.ok) return pf.res;
            const expTitle = pf.expTitle || focus || '';
            const si = await sendInputText(a, expTitle);
            if (si.ok) {
                // ⚠ 关于「输入有没有真的进去」的诚实边界（2026-11-09 从 ZCode CUA 源码学到的）：
                //   ZCode 的 classifyReplacementReadback 有一层 applyAxEchoSurfaceTrust——
                //   **Chromium 宿主的 AX 回显不可信**：你把值写进去，它立刻回显新值，
                //   但那是它自己的界面缓存在骗你，不代表真的生效了。
                //   所以这一档我们不改回「读回值确认」，而是老实标 unverified。
                return VC.unverified('已发 ' + a.length + '/' + a.length + ' 字' + (expTitle ? '（→' + expTitle + '，SendInput 真输入）' : '（SendInput 真输入）'), {
                    sent: a.length, total: a.length,
                    evidence: 'SendInput 逐字符走系统输入流（KEYEVENTF_UNICODE）；注入前已断言前台 = ' + (expTitle || '当前前台'),
                    nextIfFailed: '文字发出去了但没法自动确认进去没有。用 snapshot 或截图看一眼输入框；如果没进去，可能是目标输入框没获得焦点（先 click 一下输入框再 type_text）',
                    via: 'sendinput',
                });
            }
            // 兜底：SendKeys（老路径）
            const r = await runPs(wsScript(`$ws.SendKeys('${escapeSendKeys(a).replace(/'/g, "''")}'); 'typed'`));
            if (r.ok) return VC.unverified('已发 ' + a.length + '/' + a.length + ' 字' + (focus ? '（→' + focus + '，SendKeys）' : ''), {
                sent: a.length, total: a.length,
                evidence: 'SendKeys 已发送（依赖焦点和键盘布局，中文/特殊字符支持差）',
                nextIfFailed: 'SendKeys 兜底：中文容易乱、符号可能丢。优先修好 send-input 常驻服务（8104）',
                via: 'sendkeys',
            });
            // 最后才用 PostMessage，且明确告知不可靠
            if (focus) {
                const post = await postTextTo(focus, a);
                if (post.ok) return VC.unverified('已后台投递 ' + post.count + '/' + a.length + ' 字 → ' + focus, {
                    sent: post.count, total: a.length,
                    evidence: 'PostMessage WM_CHAR 投递成功 —— 但这只说明消息进了队列',
                    nextIfFailed: 'PostMessage 对 Chromium/自绘输入框（QQ/微信/Electron）**原理性无效**。别指望这条；先 focus_window 再用 SendInput',
                    via: 'postmessage-unreliable',
                });
            }
            return VC.notSent('输入失败：SendInput / SendKeys / PostMessage 全部不可用', {
                nextIfFailed: '三条输入路径全断：先检查 send-input 常驻服务（8104）有没有起来',
            });
        }
        case 'hold_key': {
            notifyKeyTag('按住 ' + String(a || '').slice(0, 16));
            const m = String(a).match(/^([a-z0-9]+)\s*,\s*([0-9.]+)$/i) || null;
            if (!m) throw new Error('格式：键,秒数（如 "w,2" 表示按住 W 两秒）');
            const key = m[1].toLowerCase();
            const sec = Math.min(5, Math.max(0.1, Number(m[2])));
            if (!(key.length === 1 && /[a-z0-9]/.test(key))) throw new Error('hold 只支持单键（a-z0-9）');
            // 同上：按住键也只发给前台，先确认焦点
            if (focus) {
                await focusWindow(focus);
                await new Promise((r) => setTimeout(r, 200));
            }
            const holdChk = await assertTargetFocused(focus || '', { strict: true });
            if (!holdChk.ok) {
                return VC.notSent(holdChk.error, {
                    vetoCode: VETO.FOCUS_LOST,
                    targetPid: Number(holdChk.targetPid) || 0,
                    fgPid: Number(holdChk.fgPid) || 0,
                    nextIfFailed: '先 focus_window "' + focus + '" 再重试',
                });
            }
            const vk = key.toUpperCase().charCodeAt(0);
            // 优先 SendInput（游戏才认；也省掉 spawn 开销）
            const si = await sendInputKey(key, sec, focus || '');
            if (si.ok) {
                return VC.unverified(`已按住 ${key.toUpperCase()} ${sec}s（SendInput）`, {
                    evidence: 'SendInput 按下+抬起序列已发送，焦点确认在「' + (holdChk.fg ? holdChk.fg.title : '当前前台') + '」',
                    nextIfFailed: '按住发出去了但没法自动确认角色有没有移动——用截图看一眼，别重复按住（可能已经走过去了）',
                });
            }
            const r = await runPs(`${PS_SIG} ${psUacGuard()} [PetU]::keybd_event(${vk},0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds ${Math.round(sec * 1000)}; [PetU]::keybd_event(${vk},0,2,[UIntPtr]::Zero); 'held'`, sec * 1000 + 6000);
            if (String(r.out || '').includes('UAC-SECURE-DESKTOP')) {
                return VC.notSent('UAC 安全桌面正在前台（提权弹窗）——已拒绝按住 ' + key, { vetoCode: VETO.EMERGENCY_STOP });
            }
            if (!r.ok) return VC.notSent('按住失败：' + r.error, { nextIfFailed: '检查 send-input 常驻服务（8104）' });
            return VC.unverified(`已按住 ${key.toUpperCase()} ${sec}s（keybd_event 兜底）`, {
                evidence: 'keybd_event 已发送（老 API，部分游戏不认）',
                nextIfFailed: 'keybd_event 是兜底路径，部分游戏（Raw Input/DirectInput）不认。启动 send-input 服务（8104）会优先走 SendInput+SCANCODE',
            });
        }
        case 'mc': {
            // Minecraft 零注入陪玩（2026-11-09 三十轮）：走服务端 RCON 协议，不做键鼠注入。
            // 调研依据：键鼠模拟属「模拟输入」有条款风险；Minecraft 服务端**原生支持 RCON**，
            // 官方协议、零反作弊风险。前提：server.properties 里 enable-rcon=true + rcon.password。
            // arg：「子命令 参数」，如 `list` / `pos Steve` / `say 你好` / `raw time set day`
            const mcParts = String(a || '').trim().split(/\s+/);
            const mcSub = (mcParts.shift() || '').toLowerCase();
            const mcRest = mcParts.join(' ');
            const mcMod = require(path.join(findProjectRoot(path.resolve(__dirname, '..', '..', '..', '..')), 'pet-runtime', 'tools', 'minecraft-rcon.cjs'));
            // 配置优先级（2026-11-09）：插件配置（UI 可填）> 环境变量 > 默认
            // mc_cfg 由 index.js 从 plugin_config.json 读出后透传（见 runGameAction 第 5 参）
            const mcFileCfg = (extraCfg && extraCfg.mc) || {};
            const mcCfg = {
                host: mcFileCfg.host || process.env.MC_RCON_HOST || '127.0.0.1',
                port: Number(mcFileCfg.port || process.env.MC_RCON_PORT) || 25575,
                password: mcFileCfg.password || process.env.MC_RCON_PASSWORD || '',
                allowWorldModify: mcFileCfg.allow_world_modify === true || process.env.MC_ALLOW_WORLD_MODIFY === '1',
            };
            if (!mcCfg.password) {
                throw new Error('未配置 RCON 密码：请设环境变量 MC_RCON_PASSWORD，或看服务端 server.properties 的 rcon.password');
            }
            // ⚠ 2026-11-09 三十五轮：mc 的四个子命令原来返回裸 {ok, detail}，没走契约。
            //   但 RCON 其实是**最好的验证通道**：服务端真的返回了结果才算成功，
            //   不存在「发了但不知道成没成」——这是 L2 级别的真验证。
            //   现在按语义分档：
            //     list / pos 是查询 → readonly
            //     say / raw 是执行，服务端返回即确认 → confirmed
            if (mcSub === 'list') {
                const r = await mcMod.listPlayers(mcCfg);
                if (!r.ok) return VC.notSent('RCON 查询失败：' + r.error, {
                    tier: 'L2',
                    nextIfFailed: '检查 server.properties 的 enable-rcon=true 与 rcon.password，以及端口（默认 25575）',
                });
                return VC.readonly(`在线玩家 ${r.players.length} 人：${r.players.join('、') || '（无）'}`, {
                    players: r.players, tier: 'L2', via: 'rcon',
                });
            }
            if (mcSub === 'pos') {
                const r = await mcMod.playerPos(mcRest, mcCfg);
                if (!r.ok) return VC.notSent('查坐标失败：' + r.error, { tier: 'L2', nextIfFailed: '玩家名对吗？用 mc list 看在线列表' });
                return VC.readonly(`${mcRest} 在 (${r.pos.x.toFixed(1)}, ${r.pos.y.toFixed(1)}, ${r.pos.z.toFixed(1)})`, {
                    pos: r.pos, tier: 'L2', via: 'rcon',
                });
            }
            if (mcSub === 'say') {
                const r = await mcMod.say(mcRest, mcCfg, process.env.MC_PLAYER || '');
                if (!r.ok) return VC.notSent('说话失败：' + r.error, { tier: 'L2', nextIfFailed: '检查 RCON 配置；说话内容不能为空' });
                // 服务端返回成功 = 真的进游戏了（RCON 是同步的，服务端执行完才回）
                return VC.confirmed(`已在游戏里说：${mcRest.slice(0, 40)}`, {
                    evidence: 'RCON 服务端确认执行', tier: 'L2', via: 'rcon',
                });
            }
            if (mcSub === 'raw') {
                const r = await mcMod.run(mcRest, mcCfg);
                if (!r.ok) return VC.notSent('命令被拒或失败：' + r.error, {
                    tier: 'L2',
                    nextIfFailed: 'raw 受白名单限制（op/ban/kick/stop/kill @a/fill…air 会被拒）。需要改世界请先用 mc_cfg.allow_world_modify 显式授权',
                });
                return VC.confirmed(String(r.result).slice(0, 300), {
                    evidence: 'RCON 服务端返回：' + String(r.result).slice(0, 100),
                    result: r.result, tier: 'L2', via: 'rcon',
                });
            }
            throw new Error('mc 子命令：list / pos <玩家> / say <话> / raw <命令>（raw 受白名单限制）');
        }
        case 'pvz': {
            // 植物大战僵尸专用（2026-11-09，实测路径 D:/Games/植物大战僵尸杂交重制版v0.31）
            // 核心：PvZ 操作几乎全是「点格子种植物」，不需要键位注入。
            // 子命令：init（标定网格）/ plant 行,列 / slot 1-10 / sun
            const pvzParts = String(a || '').trim().split(/\s+/);
            const pvzSub = (pvzParts.shift() || '').toLowerCase();
            const pvzArg = pvzParts.join(' ');

            const findPvzWin = async () => {
                const lines = [
                    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
                    "$sig = @'",
                    "using System;using System.Text;using System.Runtime.InteropServices;",
                    "public class PVZW {",
                    " [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);",
                    " [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);",
                    " [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h);",
                    " [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out RECT r);",
                    " [DllImport(\"user32.dll\")] public static extern bool GetClientRect(IntPtr h, out RECT r);",
                    " [DllImport(\"user32.dll\")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);",
                    " [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();",
                    " public delegate bool EnumProc(IntPtr h, IntPtr l);",
                    " public struct RECT { public int L,T,R,B; }",
                    " public struct POINT { public int X,Y; }",
                    "}",
                    "'@",
                    "Add-Type -TypeDefinition $sig",
                    // ⚠ 2026-11-09 三十六轮：必须 DPI aware，否则 GetWindowRect 返回**逻辑坐标**。
                    //   实测：PVZ 实际窗口 1642×956（pet-core 物理坐标），这里是 1095×637 —— 正好 /1.5。
                    //   草坪网格按逻辑坐标算出来，再用物理坐标的 click_at 去点，会整体偏 1.5 倍，
                    //   「种下去」的位置全错，而且 dHash 闭环还会因为画面确实变了而报成功。
                    "[void][PVZW]::SetProcessDPIAware()",
                    "$script:found = $null",
                    "$script:foundTitle = ''",
                    "$sbTmp = New-Object System.Text.StringBuilder 512",
                    "$cb = [PVZW+EnumProc]{ param($h,$l)",
                    "  if (-not [PVZW]::IsWindowVisible($h)) { return $true }",
                    "  $sb = New-Object System.Text.StringBuilder 512",
                    "  [void][PVZW]::GetWindowTextW($h, $sb, 512)",
                    "  $t = $sb.ToString()",
                    "  if ($t -match '植物大战僵尸' -or $t -match 'PlantsVsZombies' -or $t -match 'PvZ') {",
                    "    $script:found = $h; $script:foundTitle = $t; return $false }",
                    "  return $true }",
                    "[void][PVZW]::EnumWindows($cb, [IntPtr]::Zero)",
                    "if ($script:found -ne $null) {",
                    "  $r = New-Object PVZW+RECT; [void][PVZW]::GetWindowRect($script:found, [ref]$r)",
                    "  $c = New-Object PVZW+RECT; [void][PVZW]::GetClientRect($script:found, [ref]$c)",
                    "  $p = New-Object PVZW+POINT; [void][PVZW]::ClientToScreen($script:found, [ref]$p)",
                    "  @{ hwnd=[int64]$script:found; title=[string]$script:foundTitle; x=[int]$r.L; y=[int]$r.T; w=[int]($r.R-$r.L); h=[int]($r.B-$r.T); cx=[int]$p.X; cy=[int]$p.Y; cw=[int]$c.R; ch=[int]$c.B } | ConvertTo-Json -Compress",
                    "} else { 'null' }",
                ];
                const r = await runPs(lines.join('\n'), 6000);
                if (!r.ok || !r.out || String(r.out).trim() === 'null') return null;
                try { return JSON.parse(r.out); } catch (e) { return null; }
            };

            // ── 红队 S3：pvz 三条路径（plant/auto/slot）的前台 + 身份 + 位移守卫 ──
            // 病根：plant/auto 用 PVZ_STATE.grid 的**绝对屏幕坐标**直接 clickAt，
            //   slot 直接 press_key（focus 为 null）——窗口被挪动/遮挡/切走时，
            //   真鼠标点会落到用户自己的窗口上（SetCursorPos 不看目标是谁）。
            // 修法：① 断言标定时的 hwnd 仍是前台（assertTargetFocused 双认 hwnd/pid/标题）；
            //       ② 复核窗口矩形，位移 > 8px 就要求重新 pvz init（网格已失效）。
            const pvzGuard = async () => {
                const target = PVZ_STATE.hwnd ? String(PVZ_STATE.hwnd) : String(PVZ_STATE.title || '植物大战僵尸');
                const chk = await assertTargetFocused(target, { strict: true });
                if (!chk.ok) {
                    return VC.notSent('PVZ 窗口不在前台/已移动——先 pvz init 重新标定', {
                        error: chk.error, foreground: chk.fg ? chk.fg.title : null,
                        nextIfFailed: '先 focus_window "植物大战僵尸"（或 pvz init 重新标定）再重试',
                    });
                }
                if (PVZ_STATE.rect) {
                    let wr = null;
                    try { wr = await windowRealRect(PVZ_STATE.title || '植物大战僵尸'); } catch (e) { wr = null; }
                    if (wr && (Math.abs(wr.x - PVZ_STATE.rect.x) > 8 || Math.abs(wr.y - PVZ_STATE.rect.y) > 8
                        || Math.abs(wr.w - PVZ_STATE.rect.w) > 16 || Math.abs(wr.h - PVZ_STATE.rect.h) > 16)) {
                        return VC.notSent('PVZ 窗口移动/缩放了（标定时 ' + PVZ_STATE.rect.w + '×' + PVZ_STATE.rect.h +
                            ' @' + PVZ_STATE.rect.x + ',' + PVZ_STATE.rect.y + '，现在 ' + wr.w + '×' + wr.h + ' @' + wr.x + ',' + wr.y +
                            '）——网格坐标已失效，先 pvz init 重新标定', {
                            error: 'pvz_rect_drift', was: PVZ_STATE.rect, now: { x: wr.x, y: wr.y, w: wr.w, h: wr.h },
                            nextIfFailed: 'pvz init 重新标定网格再操作',
                        });
                    }
                }
                return null;
            };

            if (pvzSub === 'guide') {
                // ⚠ 2026-11-09 三十五轮改：原来这里硬编码了 20 行攻略。
                //   现在改成从知识库读（pet-runtime/knowledge/rules/植物大战僵尸.json），
                //   这样用户能自己改、游戏更新能改，而且经验层里她自己的成功/失败也会带出来。
                //   guide 参数可选：pvz guide 卡槽 → 按「卡槽」检索最相关的几条。
                try {
                    const KB = require('./knowledge-base.js');
                    const kn = await KB.getKnowledge('植物大战僵尸', { query: pvzArg || '', topK: 10 });
                    if (kn && kn.promptText) {
                        return VC.readonly(kn.promptText, {
                            guide: true,
                            source: kn.source,
                            retrieval: kn.retrievalTrace || null,
                            retrievalUs: kn.retrievalTotalUs || null,
                        });
                    }
                } catch (e) {
                    // 知识库不可用 → 回落到最小提示（不静默，明确告诉调用方）
                    try { __silentAudit.audit('game-control.js:pvz-guide', e); } catch (e2) { /* ignore */ }
                }
                return VC.readonly([
                    '【植物大战僵尸 · 最小提示】（知识库读取失败，这是兜底）',
                    '· 先 pvz init 标定草坪网格（5 行 × 9 列）',
                    '· pvz slot N 选卡槽 → pvz plant 行,列 种下',
                    '· 操作后必须 som_snapshot 确认真的种上了',
                    '· 知识库位置：pet-runtime/knowledge/rules/植物大战僵尸.json',
                ].join('\n'), { guide: true, fallback: true });
            }

            if (pvzSub === 'init') {
                const w = await findPvzWin();
                if (!w) throw new Error('没找到植物大战僵尸窗口（先启动游戏，标题需含「植物大战僵尸」）');
                // ⚠ 2026-11-09 压测修正：原实现混用了 client 宽和窗口坐标（w.cx 是 client 左上角，
                // 但 cw 取了 client 宽，两套坐标叠加导致偏到窗口外）。现在统一用**窗口矩形**：
                // 窗口左上 (w.x,w.y) + 窗口宽高 (w.w,w.h)，全程一个坐标系。
                // 草坪比例按 PvZ 原版 800×600 换算（重制版等比拉伸后仍适用）：
                //   x: 4.5%~95%，y: 13.5%~85.5%（5 行 × 9 列）
                const bx = w.x, by = w.y, bw = w.w, bh = w.h;
                const left = bx + bw * 0.045, top = by + bh * 0.135;
                const gridW = bw * 0.905, gridH = bh * 0.72;
                const cellW = gridW / 9, cellH = gridH / 5;
                PVZ_STATE.hwnd = w.hwnd;
                PVZ_STATE.title = w.title || '植物大战僵尸';
                PVZ_STATE.client = { x: bx, y: by, w: bw, h: bh };
                // 红队 S3：网格是**绝对屏幕坐标**，窗口一挪/一缩放就全错。
                // 记下标定时刻的矩形，plant/auto/slot 前对比；漂移 > 8px 直接拒绝。
                PVZ_STATE.rect = { x: bx, y: by, w: bw, h: bh };
                PVZ_STATE.grid = { left, top, cellW, cellH };
                const rows = [];
                for (let r2 = 1; r2 <= 5; r2 += 1) {
                    const cols = [];
                    for (let c2 = 1; c2 <= 9; c2 += 1) {
                        cols.push(Math.round(left + (c2 - 0.5) * cellW) + ',' + Math.round(top + (r2 - 0.5) * cellH));
                    }
                    rows.push('  行' + r2 + '：' + cols.join(' | '));
                }
                // ⚠ 2026-11-09 修（三十五轮）：pvz init 原来只是扫描窗口算网格，属于「纯观测」，
                //   但返回的 ok:true 会被算进「动作成功率」，虚高。改成 readonly。
                return VC.readonly(
                    '已标定「植物大战僵尸」窗口 ' + w.w + '×' + w.h + '\n草坪网格（点击坐标）：\n' + rows.join('\n') + '\n用法：plant <行>,<列> 种植物；slot <1-10> 换卡槽',
                    { grid: PVZ_STATE.grid, cellW: Math.round(cellW), cellH: Math.round(cellH) },
                );
            }

            if (pvzSub === 'plant') {
                if (!PVZ_STATE.grid) throw new Error('还没标定网格：先执行 pvz init');
                const pvzBlockedP = await pvzGuard();
                if (pvzBlockedP) return pvzBlockedP;
                const m = pvzArg.match(/^(\d)\s*,\s*(\d)$/);
                if (!m) throw new Error('格式：plant <行1-5>,<列1-9>，如 plant 3,2');
                const row = Number(m[1]), col = Number(m[2]);
                if (row < 1 || row > 5 || col < 1 || col > 9) throw new Error('行 1-5，列 1-9');
                const g = PVZ_STATE.grid;
                const x = Math.round(g.left + (col - 0.5) * g.cellW);
                const y = Math.round(g.top + (row - 0.5) * g.cellH);
                // ⚠ 2026-11-09 修（三十五轮）：原来 clickAt 返回 ok 就说「已种下」——
                //   但卡槽没选/阳光不够/被弹窗挡住时，鼠标点了格子什么都不会发生。
                //   现在走 dHash 闭环，画面没变就明说「没种上」。
                // ⚠ 2026-11-10 四十轮续：原来这里走**全屏 9×8 dHash** —— 种一株植物只改
                //   点击点附近几十像素，全屏哈希经常 hamming=0 → 误报 suspected_noop。
                //   「同键连点第二下报 noop」就是这个盲区（第二株种在另一格，变化更小）。
                //   现在和 click_at 一样用点击点 ±110px 的 12×10 局部灰度对比。
                // 守卫（2026-11-21 洞 3）：pvz 的坐标来自标定网格，调用点必须显式声明来源；
                // 以前传 null guard → 既无「弃存」判定也无「自身窗口」判定。
                const verifiedPlant = await actAndVerify(async () => clickAt(x, y, 8000, '', '', { source: 'pvz', name: 'plant' }), {
                    expectChange: true, timeoutMs: 1800,
                    region: { x: x - 110, y: y - 110, w: 220, h: 220 },
                });
                const vrP = VC.fromActAndVerify(verifiedPlant, {
                    detail: '已在第 ' + row + ' 行第 ' + col + ' 列点击（' + x + ',' + y + '）',
                });
                if (vrP.effect === 'suspected_noop') {
                    vrP.nextIfFailed = '点了格子但画面没变，最可能是「没先选卡槽」或「阳光不够」。先 pvz slot N 选植物再 plant，或 som_snapshot 看看阳光和卡槽状态';
                }
                vrP.row = row; vrP.col = col; vrP.x = x; vrP.y = y;
                return vrP;
            }

            if (pvzSub === 'auto') {
                // 真闭环自动种（2026-11-09 架构 P0）：act → verify 一次事务。
                // 之前只返回 ok + 「请你自己再看一眼」——她不知道成没成。
                // 现在 dHash 对比（~250ms/次），画面真的变了才算种上。
                // arg 格式：auto <卡槽>,<行>,<列>，如 auto 1,3,2
                if (!PVZ_STATE.grid) throw new Error('还没标定网格：先执行 pvz init');
                const pvzBlockedA = await pvzGuard();
                if (pvzBlockedA) return pvzBlockedA;
                const am = pvzArg.match(/^(\d{1,2})\s*,\s*(\d)\s*,\s*(\d)$/);
                if (!am) throw new Error('格式：auto <卡槽1-10>,<行1-5>,<列1-9>，如 auto 1,3,2');
                const slotN = Number(am[1]), rowN = Number(am[2]), colN = Number(am[3]);
                const steps = [];
                const g2 = PVZ_STATE.grid;
                const px = Math.round(g2.left + (colN - 0.5) * g2.cellW);
                const py = Math.round(g2.top + (rowN - 0.5) * g2.cellH);

                const verified = await actAndVerify(async () => {
                    const slotRes = await runGameAction('press_key', slotN === 10 ? '0' : String(slotN));
                    steps.push('选卡槽 ' + slotN + '：' + (slotRes && slotRes.ok ? 'ok' : '失败'));
                    await new Promise((r) => setTimeout(r, 180));
                    const clickRes = await clickAt(px, py, 8000, '', '', { source: 'pvz', name: 'plant' });
                    steps.push('点格子(' + rowN + ',' + colN + ') @' + px + ',' + py + '：' + (clickRes && clickRes.ok ? 'ok' : '失败'));
                    return { ok: !!(clickRes && clickRes.ok) };
                }, {
                    expectChange: true, timeoutMs: 1800,
                    // 同上：种植的视觉变化只在点击点附近，全屏 dHash 是盲区。
                    region: { x: px - 110, y: py - 110, w: 220, h: 220 },
                });

                if (verified.verified && verified.changed) {
                    steps.push('✓ 已验证：画面确实变了（距离 ' + verified.dist + '，' + verified.elapsed + 'ms）—— 植物应该种上了');
                } else if (verified.verified && !verified.changed) {
                    steps.push('✗ 验证失败：画面没变化 —— ' + (verified.hint || ''));
                    steps.push('建议：① som_snapshot 看有没有弹窗挡着 ② 确认卡槽冷却 ③ 换个格子');
                } else {
                    steps.push('⚠ 无法验证（拍不到画面）—— 按动作返回值判断：' + (verified.ok ? '可能成功' : '可能失败'));
                }

                const vrAuto = VC.fromActAndVerify(verified, { detail: steps.join('\n') });
                if (vrAuto.effect === 'suspected_noop') {
                    vrAuto.nextIfFailed = '选卡槽 + 点格子都做了但画面没变：① 卡槽冷却中 ② 阳光不够 ③ 有弹窗挡着 ④ 网格标定偏了。先 som_snapshot 看现场，或 pvz init 重新标定';
                }
                vrAuto.slot = slotN; vrAuto.row = rowN; vrAuto.col = colN; vrAuto.x = px; vrAuto.y = py;
                vrAuto.steps = steps;
                return vrAuto;
            }

            if (pvzSub === 'slot') {
                const n = Number(pvzArg);
                if (!Number.isFinite(n) || n < 1 || n > 10) throw new Error('卡槽 1-10');
                // 红队 S3：slot 直接 press_key（focus 为 null），原来不做任何前台校验
                const pvzBlockedS = await pvzGuard();
                if (pvzBlockedS) return pvzBlockedS;
                return runGameAction('press_key', n === 10 ? '0' : String(n));
            }

            throw new Error('pvz 子命令：init / plant <行>,<列> / slot <1-10>');
        }
        case 'click_at': {
            // 2026-11-14 四十八轮续：支持**点击变体后缀**（可发现性优先 —— 一个入口覆盖
            // 人类的全部基础点击，模型不用记 mouse double_click 那套字符串语法）：
            //   click_at 500,300             单击
            //   click_at 500,300 double      双击（列表项打开）
            //   click_at 500,300 right       右键（上下文菜单）
            //   click_at 500,300 middle      中键
            //   click_at 500,300 ctrl        多选（Ctrl+单击）★ 列表多选靠它
            //   click_at 500,300 ctrl+shift  区间选择
            //   click_at 500,300 ctrl double 组合：修饰键 + 双击
            const m = String(a).match(/^(-?\d+)\s*,\s*(-?\d+)(?:\s+(.+))?$/);
            if (!m) throw new Error('格式：x,y [double|right|middle] [ctrl|shift|alt][+...]（屏幕像素坐标）');
            let x = Number(m[1]), y = Number(m[2]);   // let：homing 自动补偿需要改写
            const suffix = String(m[3] || '').toLowerCase();
            const clickKind = /\bdouble\b/.test(suffix) ? 'double_click'
                : /\bright\b/.test(suffix) ? 'right_click'
                    : /\bmiddle\b/.test(suffix) ? 'middle_click' : 'click';
            // 修饰键：去掉类型词后剩下 ctrl/shift/alt/win 及其 + 组合
            const clickMods = suffix
                .replace(/\b(double|right|middle|click)\b/g, ' ')
                .split(/[\s,+]+/)
                .filter((t) => /^(ctrl|control|shift|alt|win|super|meta)$/.test(t))
                .join('+');

            // ⚠ 2026-11-09 加校验（用户实测「叫她开QQ发消息做不到」的根因之三）：
            // 日志里 AI 自己编了个 click_at 750,278 —— 跟 QQ 窗口（1832-1986 那一片）毫无关系，
            // 点到的是桌面空白。这不是代码 bug，是**坐标缺校验**导致的静默失败。
            // 现在点之前先问三件事：①在屏幕内吗 ②会落在目标窗口上吗（如果给了 focus）③闭环验证
            // 屏幕边界（2026-11-21 P1）：所有显示器并集，副屏/负坐标同样合法。
            // 历史：旧实现只看 getPrimaryDisplay() → 副屏坐标被误拒；纯 Node 兜底 ±16384。
            assertScreenPoint(x, y, 'click_at');
            // 自身窗口守卫（§71）：落点在她自己身上就一步都不发。
            // 放在屏幕范围校验之后、任何鼠标动作之前 —— 这是最后一个「还没动桌面」的位置。
            {
                const selfBlocked = await guardOwnWindow(x, y);
                if (selfBlocked) return selfBlocked;
            }
            let focusRect = null;   // 供下方 region 验证用（原 wr 在块内，出不来）
            let expectedTitle = ''; // 遮挡探针的期望根窗口标题（焦点确认后填真实前台标题）
            if (focus) {
                // ⚠ 2026-11-09 三十六轮修（假成功的又一扇暗门）：
                //   「坐标在窗口矩形内」≠「点击会落到这个窗口」。
                //   实测：PVZ 被 ZCode/B站/QQ/设置 盖住时，坐标算得完全正确（误差 <5px），
                //   但 SetCursorPos+mouse_event 发给的是**最上层窗口**（当前前台），
                //   PVZ 画面一动不动，而 detail 还写着「已在 (x,y) 点击」。
                //   现在先验前台：目标窗口不在前台就明确 notSent，**不发这一次点击**
                //   （发了只会污染别的窗口，还会让 AI 以为点过了）。
                //   这是 35 轮给 keys/text 加的 assertTargetFocused 的同一条防线，click_at 之前漏掉了。
                const focusChk0 = await assertTargetFocused(focus, { strict: true });
                let focusChk = focusChk0;
                if (!focusChk.ok) {
                    // schema 里 focus 的语义就是「先把某个窗口调到前台再动作」——
                    // 那就真的去聚焦一次，然后再复核。不聚焦只报错等于把活推给调用方。
                    const fw = await focusWindow(focus, { force: false });
                    await new Promise((r) => setTimeout(r, 260));
                    focusChk = await assertTargetFocused(focus, { strict: true });
                    if (!focusChk.ok) {
                        return VC.notSent(
                            '没点：' + focusChk.error +
                            '（坐标 (' + x + ',' + y + ') 本身在「' + focus + '」窗口范围内，但鼠标事件只会发给最上层窗口；' +
                            '聚焦也试过了：' + (fw && fw.error ? String(fw.error).slice(0, 80) : '复核仍不是前台') + '）',
                            {
                                coordsInWindow: true,
                                foreground: focusChk.fg ? focusChk.fg.title : null,
                                vetoCode: VETO.FOCUS_LOST,
                                targetPid: Number(focusChk.targetPid) || 0,
                                fgPid: Number(focusChk.fgPid) || 0,
                                nextIfFailed: '目标窗口可能被全屏置顶窗口盖住（Windows 限制，无法切换）——先挪开遮挡窗口；' +
                                    '或确认标题写对了',
                            },
                        );
                    }
                }
                    // 遮挡探针用真实前台标题（不是用户传的 focus 字符串：focus 可能是 pid/简称）
                    expectedTitle = (focusChk && focusChk.fg && focusChk.fg.title) || '';
                    const wr = await windowRealRect(focus);
                    focusRect = wr;
                if (wr) {
                    // 坐标 homing（2026-11-10 三十八轮，抄 #10 并深化为**自动补偿**）：
                    // 快照后窗口被拖动 → 快照坐标整体漂移。判据用「这个坐标只落在旧矩形里」：
                    //   · 落在旧矩形、不落在新矩形 → 说明它来自快照时代 → 自动 +dx,+dy；
                    //   · 两个矩形都落在（移动很小/无法区分）→ 不自动改，只提示；
                    //   · 只落在新矩形 → LLM 自己已经算过新坐标，绝不动它。
                    const oldRect = UIA_SNAPSHOT_STATE && UIA_SNAPSHOT_STATE.rect;
                    if (oldRect && UIA_SNAPSHOT_STATE.title && focus && UIA_SNAPSHOT_STATE.title.includes(focus)) {
                        const dx = wr.x - oldRect.x, dy = wr.y - oldRect.y;
                        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
                            const inOld = geometry.rectContains(oldRect, x, y);
                            const inNew = geometry.rectContains(wr, x, y);
                            if (inOld && !inNew) {
                                const ox = x, oy = y;
                                x += dx; y += dy;
                                UIA_SNAPSHOT_STATE.homed = {
                                    dx, dy, from: { x: ox, y: oy }, to: { x, y }, applied: true,
                                    note: '窗口自快照后移动 (' + dx + ',' + dy + ')，坐标已自动补偿',
                                };
                            } else {
                                UIA_SNAPSHOT_STATE.homed = {
                                    dx, dy, applied: false,
                                    note: '窗口自快照后移动了 (' + dx + ',' + dy + ')，快照坐标可能过期',
                                };
                            }
                        }
                    }
                    const inside = geometry.rectContains(wr, x, y);
                    if (!inside) {
                        // 点击落到窗口外 = 一定点不到目标，直接拒绝并给出正确范围
                        throw new Error('坐标 (' + x + ',' + y + ') 不在「' + focus + '」窗口内（窗口范围 ' +
                            wr.x + ',' + wr.y + ' ~ ' + (wr.x + wr.w) + ',' + (wr.y + wr.h) + '）。' +
                            '请用 snapshot 拿真实元素坐标，或用 som_snapshot 看画面。');
                    }
                }
            }
            // 闭环：点完看画面变没变（无 focus 的盲点场景也验，变没变至少能判断「有没有反应」）
            const verified = await actAndVerifySmart(async () => {
                // clickKind/clickMods 来自 arg 后缀（2026-11-14）：default 走原来的 clickAt，
                // 其余（双击/右键/中键/修饰键）走 mouseEx —— 它和 clickAt 共用同一套
                // UAC/急停/遮挡护栏，只是 kind 不同。
                const rr = (clickKind === 'click')
                    ? await clickAt(x, y, 8000, expectedTitle, clickMods)
                    : await mouseEx(clickKind, x, y, 0, 0, 0, 9000, expectedTitle, clickMods);
                return rr;
            }, {
                expectChange: true, timeoutMs: 1200, uiaTitle: focus || '',
                // 局部验证（2026-11-10）：全屏 dHash 对游戏内局部变化是盲区（PVZ 种植实测 hamming=0 但成功）
                // 有目标窗口就用整个窗口当验证区域（2026-11-10 三十九轮）：
                // ±110px 对「点数字键→显示区在窗口顶部变化」是盲区，实测报 noop 逼她换整屏 click_at 重试。
                region: (focus && focusRect && Number.isFinite(focusRect.x))
                    ? { x: focusRect.x, y: focusRect.y, w: focusRect.w, h: focusRect.h }
                    : { x: x - 110, y: y - 110, w: 220, h: 220 },
            });
            const vr = VC.fromActAndVerify(verified, { detail: '已在 (' + x + ',' + y + ') 点击' });
            if (verified.via) vr.via = verified.via;               // region/region-dynamic 通道标记
            if (verified.regionDetail) vr.regionDetail = verified.regionDetail;
            // homing 结果透传（三十八轮）：自动补偿过就明确告诉她「点的不是原来那个坐标」
            if (UIA_SNAPSHOT_STATE.homed) {
                vr.homed = UIA_SNAPSHOT_STATE.homed;
                if (UIA_SNAPSHOT_STATE.homed.applied) {
                    vr.detail = String(vr.detail || '') + '（窗口自快照后移动 ' +
                        UIA_SNAPSHOT_STATE.homed.dx + ',' + UIA_SNAPSHOT_STATE.homed.dy + '，坐标已自动补偿）';
                }
                UIA_SNAPSHOT_STATE.homed = null;   // 一次性，别污染后续调用
            }
            // 补一条这一档特有的话术：坐标点击最常见的失败原因就是「点到空白」
            if (vr.effect === 'suspected_noop') {
                vr.nextIfFailed = '可能点到了空白/被遮挡。改用 snapshot 拿真实元素坐标，或 som_snapshot 看画面再点';
            }
            return vr;
        }
        case 'mouse': {
            // 基础交互扩展（2026-11-10 三十七轮，QQ 实战反馈）：double_click / right_click / drag。
            // 为什么要有：QQ 消息列表的联系人**需要双击**才打开，她只有单击 → 点不开 → 绕道搜索。
            // arg 语法：
            //   double_click x,y
            //   right_click  x,y
            //   drag x1,y1,x2,y2[,durMs]     （按下→12 段移动→抬起，默认 600ms）
            const mparts = String(a || '').trim();
            if (!mparts) throw new Error('arg：double_click x,y | right_click x,y | drag x1,y1,x2,y2[,durMs] | scroll [x,y,]±N（负=下滚）');
            let mm = mparts.match(/^(double_click|right_click|drag)\s+([\d-]+)\s*,\s*([\d-]+)(?:\s*,\s*([\d-]+)\s*,\s*([\d-]+))?(?:\s*,\s*(\d+))?\s*$/);
            // 滚动（2026-11-10 行为审计补）：`scroll 3` / `scroll -5` / `scroll 500,400,-5`
            const scrollM = !mm ? mparts.match(/^scroll\s+(?:(-?\d+)\s*,\s*(-?\d+)\s*,\s*)?(-?\d+)\s*$/i) : null;
            if (!mm && !scrollM) {
                throw new Error('参数格式不对：' + mparts.slice(0, 80) +
                    '（支持 double_click x,y / right_click x,y / drag x1,y1,x2,y2[,ms] / scroll [x,y,]±N）');
            }
            let kind, mx, my, mx2, my2, durMs;
            if (scrollM) {
                kind = 'scroll';
                mx = scrollM[1] !== undefined ? Number(scrollM[1]) : NaN;
                my = scrollM[2] !== undefined ? Number(scrollM[2]) : NaN;
                mx2 = null; my2 = null;
                durMs = Number(scrollM[3]);   // 复用该槽传「格数」
            } else {
                kind = mm[1];
                mx = Number(mm[2]); my = Number(mm[3]);
                mx2 = mm[4] !== undefined ? Number(mm[4]) : null;
                my2 = mm[5] !== undefined ? Number(mm[5]) : null;
                durMs = mm[6] !== undefined ? Number(mm[6]) : 600;
            }
            if (kind === 'drag' && (mx2 === null || my2 === null)) {
                throw new Error('drag 需要 x1,y1,x2,y2 四个坐标');
            }
            // 屏幕边界（2026-11-21 P1）：与 click_at 共用 assertScreenPoint（所有显示器并集）
            // scroll 允许无坐标（沿用当前光标），别拿 NaN 去比
            const pts = (Number.isFinite(mx) && Number.isFinite(my)) ? [[mx, my]].concat(mx2 !== null ? [[mx2, my2]] : []) : [];
            for (const [px, py] of pts) assertScreenPoint(px, py, 'mouse/' + kind);
            // 自身窗口守卫（§71）：任一落点（含 drag 的终点）在她自己身上就不发
            for (const [px, py] of pts) {
                const selfBlocked = await guardOwnWindow(px, py);
                if (selfBlocked) return selfBlocked;
            }
            let mExpected = '';
            if (focus) {
                const focusChk0 = await assertTargetFocused(focus, { strict: true });
                let focusChk = focusChk0;
                if (!focusChk.ok) {
                    const fw = await focusWindow(focus, { force: false });
                    await new Promise((r) => setTimeout(r, 260));
                    focusChk = await assertTargetFocused(focus, { strict: true });
                    if (!focusChk.ok) {
                        return VC.notSent('没做：' + focusChk.error, {
                            vetoCode: VETO.FOCUS_LOST,
                            targetPid: Number(focusChk.targetPid) || 0,
                            fgPid: Number(focusChk.fgPid) || 0,
                            nextIfFailed: '先确认目标窗口能到前台（全屏置顶游戏挡住的 Windows 限制无解）',
                        });
                    }
                }
                mExpected = (focusChk && focusChk.fg && focusChk.fg.title) || '';
            }
            const verifiedM = await actAndVerifySmart(
                async () => mouseEx(kind, mx, my, mx2, my2, durMs, 9000, mExpected),
                {
                    expectChange: true, timeoutMs: 1500, uiaTitle: focus || '',
                    region: { x: mx - 110, y: my - 110, w: 220, h: 220 },
                },
            );
            const vrM = VC.fromActAndVerify(verifiedM, {
                detail: kind + ' @(' + mx + ',' + my + ')' + (mx2 !== null ? '→(' + mx2 + ',' + my2 + ')' : ''),
            });
            if (verifiedM.via) vrM.via = verifiedM.via;
            if (verifiedM.regionDetail) vrM.regionDetail = verifiedM.regionDetail;
            // 拖动参数回执（四十轮）：LLM 能看到实际用了多少段/什么速度曲线，
            // 也方便回归断言「不是 12 段等速老路」。
            if (kind === 'drag') { vrM.steps = 30; vrM.curve = 'ease-in-out-cubic'; }
            if (vrM.effect === 'suspected_noop') {
                vrM.nextIfFailed = kind + ' 发出了但画面没变：① 该元素可能需要别的交互（单击 vs 双击 vs 右键菜单）② 被遮挡 ③ 目标不对。先 som_snapshot 看现场';
            }
            return vrM;
        }
        case 'scroll': {
            // 独立滚动动作（2026-11-14 四十八轮续）。
            // 为什么单列：原来只有 `mouse scroll [x,y,]±N` —— 藏在一个叫 mouse 的动作的
            // 字符串语法里，模型几乎想不到。而长网页/聊天记录/商品列表全靠它。
            // 语法：`down 5` / `up 3` / `left 2` / `right 2` / `-5`（负=下滚，兼容老语法）
            // 起点可选：`down 5 @800,600`（不写就用当前光标位置）
            const txt = String(a || '').trim().toLowerCase();
            let dir = 'down';
            let n = 3;
            let sx = NaN;
            let sy = NaN;
            let sm = txt.match(/^(up|down|left|right)\s+(\d+)(?:\s*@\s*(-?\d+)\s*,\s*(-?\d+))?$/);
            if (sm) {
                dir = sm[1];
                n = Math.max(1, Math.min(50, Number(sm[2])));
                if (sm[3] !== undefined) { sx = Number(sm[3]); sy = Number(sm[4]); }
            } else if ((sm = txt.match(/^(-?\d+)$/))) {
                n = Math.max(1, Math.min(50, Math.abs(Number(sm[1]))));
                dir = Number(sm[1]) < 0 ? 'down' : 'up';
            } else {
                throw new Error('格式：scroll down 5 / up 3 / left 2 / right 2（格数 1-50，一格=120 单位）；起点可写 @x,y');
            }
            const axis = (dir === 'left' || dir === 'right') ? 'h' : 'v';
            const notches = (dir === 'up' || dir === 'left') ? n : -n;
            // 屏幕边界（2026-11-21 P1）：给了起点就按所有显示器并集校验（与 click_at 同源）
            if (Number.isFinite(sx) && Number.isFinite(sy)) assertScreenPoint(sx, sy, 'scroll');
            // 滚轮只发给前台窗口 —— 目标不在前台就明确拒绝，别滚了别人
            const sf = await focusOrVeto(focus, '滚');
            if (!sf.ok) return sf.res;
            const vr = await actAndVerifySmart(
                async () => mouseEx('scroll', sx, sy, 0, 0, notches, 9000, sf.expTitle, '', axis),
                Object.assign(
                    { expectChange: true, timeoutMs: 1400, uiaTitle: focus || '' },
                    (Number.isFinite(sx) && Number.isFinite(sy))
                        ? { region: { x: sx - 220, y: sy - 320, w: 440, h: 640 } }
                        : {},
                ),
            );
            const v = VC.fromActAndVerify(vr, {
                detail: 'scroll ' + dir + ' ' + n + ' 格（' + axis + ' 轴，' + n + '×120=' + (n * 120) + ' 单位）'
                    + (Number.isFinite(sx) ? ' 起点@' + sx + ',' + sy : '（沿用当前光标）'),
            });
            if (vr.via) v.via = vr.via;
            v.axis = axis;
            v.notches = notches;
            if (v.effect === 'suspected_noop') {
                v.nextIfFailed = '滚了但画面没变：① 目标不在前台（滚轮跟焦点走）② 已经到顶/到底 '
                    + '③ 这块区域不可滚。先 som_snapshot 看有没有滚动条，或换成 click_element 点分页';
            }
            return v;
        }
        case 'drag': {
            // 拖拽（2026-11-14 四十八轮续）：`x1,y1,x2,y2[,时长ms]`。
            // 拖滑块 / 选文本 / 拖文件 / 画布拖拽都用它。Rust 侧是 30 段 ease-in-out
            // （首尾慢中间快），不是 12 段等速 —— 一眼看不出是机器。
            const dm = String(a || '').match(/^(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)(?:\s*,\s*(\d+))?$/);
            if (!dm) throw new Error('格式：drag x1,y1,x2,y2[,时长ms]（默认 600ms）');
            const dx1 = Number(dm[1]); const dy1 = Number(dm[2]);
            const dx2 = Number(dm[3]); const dy2 = Number(dm[4]);
            const dur = dm[5] !== undefined ? Math.max(200, Math.min(5000, Number(dm[5]))) : 600;
            // 自身窗口守卫（§71）：起点或终点在她自己身上就不拖
            for (const [px, py] of [[dx1, dy1], [dx2, dy2]]) {
                const selfBlocked = await guardOwnWindow(px, py);
                if (selfBlocked) return selfBlocked;
            }
            const df = await focusOrVeto(focus, '拖');
            if (!df.ok) return df.res;
            // E5：拖拽包围盒先归一（dx2<dx1 / dy2<dy1 时原点平移到左上），再向外扩 60px。
            const dragRect = geometry.normalizeRect({ x: dx1, y: dy1, w: dx2 - dx1, h: dy2 - dy1 });
            const vr = await actAndVerifySmart(
                async () => mouseEx('drag', dx1, dy1, dx2, dy2, dur, 12000, df.expTitle),
                {
                    expectChange: true, timeoutMs: 1800, uiaTitle: focus || '',
                    region: {
                        x: dragRect.x - 60, y: dragRect.y - 60,
                        w: dragRect.w + 120, h: dragRect.h + 120,
                    },
                },
            );
            const v = VC.fromActAndVerify(vr, {
                detail: 'drag (' + dx1 + ',' + dy1 + ') → (' + dx2 + ',' + dy2 + ') 用时 ' + dur + 'ms',
            });
            if (vr.via) v.via = vr.via;
            v.steps = 30;
            v.curve = 'ease-in-out-cubic';
            if (v.effect === 'suspected_noop') {
                v.nextIfFailed = '拖了但画面没变：① 按下点没落在可拖对象上（先 som_snapshot 看）'
                    + ' ② 需要更长/更慢的拖动（加时长，如 drag x1,y1,x2,y2,1200）'
                    + ' ③ 目标在拖的过程中自己变了（列表滚动）';
            }
            return v;
        }
        case 'set_value': {
            // UIA 直接设值（2026-11-14）：填表单最快最准的方式 —— 不用点、不用选、不用逐字打。
            // arg 写 "rid|值"（用 | 分隔：值里可能含逗号/空格，别用逗号切）。
            const sv = String(a || '');
            const bar = sv.indexOf('|');
            if (bar <= 0) {
                throw new Error('格式：arg 写 "rid|值"，如 "42-1234-5-1|张三"；rid 从 snapshot 返回的 elements[].rid 拿');
            }
            const rid = sv.slice(0, bar).trim();
            const val = sv.slice(bar + 1);
            showUiaCursor(rid, '设值');   // 不动真实光标 → 虚拟光标是唯一可见反馈
            const r = await coreUiaAction(focus || '', rid, 'set_value', val);
            const who = r.name ? '「' + r.name + '」' : '元素 ' + rid;
            if (!r.ok) {
                return VC.notSent('设值失败：' + (r.detail || r.error || '未知'), {
                    rid, ctype: r.ctype, actions: r.actions || [], error: 'set_value_failed',
                    nextIfFailed: '① 确认 rid 是**这一次** snapshot 拿的（窗口内容一变 rid 就失效）'
                        + ' ② 只读控件设不了，改用 click_element 后 type_text'
                        + ' ③ 这个元素根本不支持 value（看 actions 里有没有 set_value）',
                });
            }
            // 2026-11-14 五十三轮（审计致命项）：Pattern 调用成功 ≠ 值真的变了。
            // 回读一次（ValuePattern），一致才算 confirmed；读不到就如实 unverified。
            const rb = await coreUiaAction(focus || '', rid, 'get_value');
            const gotVal = (rb && rb.ok) ? String(rb.value == null ? '' : rb.value) : null;
            if (gotVal !== null && gotVal === String(val)) {
                return VC.confirmed('已把' + who + '设为：' + String(val).slice(0, 80) + '（回读一致）', {
                    rid, ctype: r.ctype, via: 'uia-value-pattern', actions: r.actions || [],
                    len: String(val).length, verification: 'readback',
                });
            }
            return VC.unverified('已调用 SetValue，但回读' + (gotVal === null
                ? '拿不到值（控件不支持 get_value）——无法确认是否生效'
                : '是「' + gotVal.slice(0, 60) + '」而不是你给的值'), {
                rid, ctype: r.ctype, via: 'uia-value-pattern', actions: r.actions || [],
                readback: gotVal, wanted: String(val).slice(0, 200),
                nextIfFailed: gotVal === null
                    ? '这个控件不支持回读；要确认就 edit_text / see text 看界面'
                    : '控件可能做了格式化（日期/金额），或 SetValue 被应用忽略 —— 用 edit_text 看实际内容',
            });
        }
        case 'get_value': {
            // 读控件的当前值（2026-11-14）：edit_text 只认 Edit/RichEdit 窗口类，
            // ValuePattern 能读下拉框/UWP/自绘控件的值 —— 补上那个缺口。
            const rid = String(a || '').trim();
            if (!rid) throw new Error('arg 给元素的 rid（从 snapshot 的 elements[].rid 拿）');
            const r = await coreUiaAction(focus || '', rid, 'get_value');
            if (!r.ok) {
                return VC.notSent('读不到值：' + (r.detail || r.error || '未知'), {
                    rid, actions: r.actions || [],
                    nextIfFailed: '这个元素不支持 get_value（看 actions）。能读文字的窗口改用 read_text/edit_text',
                });
            }
            return VC.readonly('「' + (r.name || rid) + '」当前值：' + String(r.value || '').slice(0, 300), {
                rid, value: r.value, ctype: r.ctype, len: String(r.value || '').length,
            });
        }
        case 'select_text': {
            // 在文本控件里选中指定文字（2026-11-14）：改输入框里某一段，而不是「全选重打」。
            // arg 写 "rid|要选中的文字"（| 分隔：文字里可能含逗号/空格）。
            const sv = String(a || '');
            const bar = sv.indexOf('|');
            if (bar <= 0) {
                throw new Error('格式：arg 写 "rid|要选中的文字"，如 "42-1234-5-1|张三"；rid 从 snapshot 的 elements[].rid 拿');
            }
            const rid = sv.slice(0, bar).trim();
            const needle = sv.slice(bar + 1);
            showUiaCursor(rid, '选中');
            const r = await coreUiaAction(focus || '', rid, 'select_text', needle);
            if (!r.ok) {
                return VC.notSent('选中失败：' + (r.detail || r.error || '未知'), {
                    rid, actions: r.actions || [], error: 'select_text_failed',
                    nextIfFailed: '① 文字要和控件里完全一致（含空格/标点）'
                        + ' ② 这个控件不支持 TextPattern（看 actions）→ 改用 focus + press_key ctrl+a 全选'
                        + ' ③ rid 可能过期，重新 snapshot',
                });
            }
            return VC.confirmed('已在「' + (r.name || rid) + '」里选中：' + String(r.value || needle).slice(0, 80), {
                rid, selected: r.value, via: 'uia-text-pattern', ctype: r.ctype,
            });
        }
        case 'perform_action': {
            // 执行元素自己声明的默认动作（2026-11-14）：LegacyIAccessible 的 DoDefaultAction。
            // 有些控件 Invoke 不支持但 DoDefaultAction 有效（老式 Win32 控件、部分列表项）。
            const rid = String(a || '').trim();
            if (!rid) throw new Error('arg 给元素的 rid（从 snapshot 的 elements[].rid 拿）');
            showUiaCursor(rid, '执行');
            const r = await coreUiaAction(focus || '', rid, 'perform_action');
            if (!r.ok) {
                return VC.notSent('执行失败：' + (r.detail || r.error || '未知'), {
                    rid, actions: r.actions || [],
                    nextIfFailed: '只有元素声明了 default_action 才走这条（看 actions）。优先用 click_element（Invoke），它更通用',
                });
            }
            // 2026-11-14 五十三轮：DoDefaultAction 没有回读手段 —— 只能说「调用成功」，
            // 不能说「已经生效」（契约里的假成功就是这一条）。
            return VC.unverified('已调用「' + (r.name || rid) + '」的默认动作（无回读手段，未确认效果）', {
                rid, ctype: r.ctype, via: 'uia-legacy-default-action',
                nextIfFailed: '没反应就 som_snapshot / see tree 看现场；能 Invoke 的控件优先用 click',
            });
        }
        case 'paste': {
            // 剪贴板粘贴（2026-11-14）：比 type_text 快一个数量级（逐字 8ms/字 vs 一次 ctrl+v）。
            // 代价是**动了用户的剪贴板** —— 所以先备份，800ms 后还原。
            const text = String(a || '');
            if (!text) throw new Error('arg 给要粘贴的文字');
            let prevClip = null;
            try {
                const { clipboard } = require('electron');
                prevClip = clipboard.readText();
                clipboard.writeText(text);
            } catch (e) {
                return VC.notSent('写不了剪贴板：' + (e && e.message || e) + ' —— 没粘贴', {
                    nextIfFailed: '改用 type_text（逐字输入，慢但不需要剪贴板）',
                });
            }
            const pf = await focusOrVeto(focus, '粘');
            if (!pf.ok) {
                // 已经改了剪贴板 → 立刻还原，别把用户的东西弄丢
                try { require('electron').clipboard.writeText(prevClip); } catch (e) { /* 还原失败：下面 return 里如实说 */ }
                return pf.res;
            }
            const si = await sendInputKey('ctrl+v', 0, pf.expTitle || '');
            // 等目标应用真读了剪贴板再还原
            setTimeout(() => {
                try { require('electron').clipboard.writeText(prevClip); } catch (e) { /* 还原失败不影响已粘贴结果 */ }
            }, 800);
            if (!si || !si.ok) {
                return VC.notSent('ctrl+v 没发出去：' + ((si && si.error) || '未知') + ' —— 剪贴板 800ms 后自动还原', {
                    clipboardTouched: true,
                    nextIfFailed: '先 focus_window 再重试；或改用 type_text',
                });
            }
            return VC.unverified('已粘贴 ' + text.length + ' 字（剪贴板被临时占用，800ms 后还原）', {
                len: text.length, via: 'clipboard+ctrl+v', clipboardTouched: true,
                nextIfFailed: '粘贴 ≠ 生效：用 edit_text 回读确认（自绘输入框读不到就 som_snapshot 看）',
            });
        }
        case 'launch_app': {
            // 启动应用（2026-11-09，用户要求「她自己打开游戏自己玩」）。
            // 安全设计：**白名单路径**，只允许启动明确配置过的 exe，不接受任意路径。
            // 白名单来源：plugin_config.json 的 apps.<名字>.path，或内置常见游戏路径探测。
            // arg：应用名（配置里的键）或已知游戏名。留空=列出可启动项。
            const LAUNCH_KEY = 'LAUNCH_STATE';
            const cfgApp = (extraCfg && extraCfg.apps) || {};
            const apps = Object.assign({}, BUILTIN_APPS, cfgApp);   // 白名单表已提到模块级（focus 也要用）
            const names = Object.keys(apps).filter((k) => apps[k]);

            if (!a) {
                return VC.readonly(
                    '可启动的应用（白名单）：' + (names.length ? names.join('、') : '（无）')
                        + '\n在 plugin_config.json 的 apps.<名字>.path 里加更多',
                    { apps: names },
                );
            }

            // 找到目标（支持模糊）
            const hit = names.find((n) => n === a) || names.find((n) => n.includes(a) || a.includes(n));
            if (!hit) throw new Error('不在启动白名单：' + a + '（可用：' + (names.join('、') || '无') + '）');
            const exePath = String(apps[hit]);
            if (!require('fs').existsSync(exePath)) throw new Error('文件不存在：' + exePath);
            // 2026-11-13：判断「是否已开着 / 窗口是否出现」时，除了配置里的名字还按
            //   **完整路径**和**可执行文件名**匹配进程。实测两例都靠名字匹配不到：
            //   · 记事本：窗口标题是英文「*后台填值 WM_SETTEXT 实测 ABC 123 - Notepad」
            //   · PCL：进程名是「Plain Craft Launcher 2」，窗口标题「Plain Craft Launcher」，
            //     两个都不含配置名「PCL」→ launch_app 报「启动但没看到窗口」（假失败）
            const exeStem = require('path').basename(exePath, '.exe');
            // ⚠ 2026-11-14 实测修正三处：
            //   ① 原来 `exePath.replace(/\//g, '\\\\')` 出来是**双反斜杠** —— PowerShell 里反斜杠
            //      不是转义符，于是 `$_.Path -eq "C:\\Windows\\..."` 永远 false（实测：单斜杠 1、
            //      双斜杠 0）。之前全靠 $_.Name 兜住，Path 这一路是死的。
            //   ② 引号改成 PowerShell 单引号语法（' → ''）：路径里有 `"` 会直接打断双引号表达式。
            //   ③ Store 应用（记事本/计算器）真实 Path 在 WindowsApps 下，和配置的 System32
            //      路径根本不是同一个 → Name / 窗口标题两路必须保留（实测记事本只靠 Name 命中）。
            const psStr = (s) => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
            const existsExpr = '(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '
                + psStr(exePath.replace(/\//g, '\\'))
                + ' -or $_.Name -eq ' + psStr(exeStem)
                + ' -or $_.MainWindowTitle -like ' + psStr('*' + hit + '*')
                + ' } | Measure-Object).Count';

            // 已开着就不重复启动
            //
            // ⚠ 2026-11-14 五十三轮（审计致命项）：原来是 `String(out).trim() !== '0'`
            //   —— PowerShell 起不来/超时/输出空时 out 是 ''，`'' !== '0'` 成立 →
            //   直接返回「已在运行」，**应用永远启动不了**（而且看起来是幂等成功）。
            //   现在只认「解析出有限数且 > 0」；探测失败按「未知」处理，继续启动。
            const already = await runPs(existsExpr, 3000);
            const runningN = Number(String((already && already.out) || '').trim());
            if (Number.isFinite(runningN) && runningN > 0) {
                return VC.idempotent('「' + hit + '」已经在运行了，不用重复启动', { alreadyRunning: true, tier: 'L2' });
            }
            if (!Number.isFinite(runningN)) {
                try {
                    __silentAudit.audit('game-control:launch-probe',
                        new Error('已运行探测输出异常（按未知处理，继续启动）：' +
                            String((already && (already.out || already.error)) || '').slice(0, 80)));
                } catch (e2) { /* 记账失败不影响启动 */ }
            }

            // ⚠ 2026-11-10 审计抓到：spawn 返回成功只代表进程『已创建』，ENOENT/EACCES 走
            //   **异步 error 事件**——原来没有 error 监听，文件在 existsSync 之后被删/无执行权限
            //   就会变成未捕获异常，在 Electron 主进程里 = 整个她崩掉。现在监听并转成启动失败。
            let spawnErr = null;
            try {
                const child = spawn(exePath, [], {
                    cwd: require('path').dirname(exePath),
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: false,
                });
                child.on('error', (e) => { spawnErr = e; });
                child.unref();
            } catch (e) {
                throw new Error('启动失败：' + (e && e.message || e));
            }
            await new Promise((r) => setTimeout(r, 400));
            if (spawnErr) throw new Error('启动失败（异步）：' + (spawnErr.message || spawnErr));
            // 等窗口出现（最多 25 秒；大游戏要加载）
            const t0 = Date.now();
            let appeared = false;
            let probeFails = 0;
            while (Date.now() - t0 < 25000) {
                await new Promise((r) => setTimeout(r, 1200));
                const chk = await runPs(existsExpr, 3000);
                const n = Number(String(chk.out || '').trim());
                // ⚠ 2026-11-14 修假绿：原来判的是 `String(chk.out||'').trim() !== '0'` ——
                //   runPs 超时/失败时 out 是 undefined，空串 ≠ '0'，于是**误判「窗口出现了」**。
                //   现在显式要求一个正整数；检测本身失败只记账，不当证据。
                if (Number.isFinite(n) && n > 0) { appeared = true; break; }
                if (!chk.ok) probeFails += 1;
            }
            const secElapsed = Math.round((Date.now() - t0) / 1000);
            if (appeared) {
                // 2026-11-14：启动成功后**顺手拉到前台**。原来不 focus，模型还得再调
                //   focus_window —— 而执行档案里那一调紧接着就 not_sent（窗口枚举竞态），
                //   整条「启动→聚焦→键盘」流程断在第二步。
                let fwInfo = null;
                try { fwInfo = await focusWindowRetry(hit, { tries: 3, gapMs: 350, apps }); }
                catch (e) { fwInfo = { ok: false, error: String((e && e.message) || e) }; }
                // 2026-11-25 P1-3：ok 只代表「请求被接受」，必须 verified===true（回读前台一致）才算切到前台
                const focused = !!(fwInfo && fwInfo.verified === true);
                return VC.confirmed('「' + hit + '」已启动，窗口出来了（耗时 ' + secElapsed + ' 秒）'
                    + (focused ? '，已切到前台' : '，但没抢到前台（' + ((fwInfo && fwInfo.error) || '未知') + '）')
                    + '。下一步可以 som_snapshot 看画面', {
                    evidence: '轮询检测到进程/窗口出现（Path/Name/标题 三路）' + (focused ? '，focus 复核通过' : ''),
                    tier: 'L2', launched: true, appeared: true, focused, costMs: Date.now() - t0,
                });
            }
            // 失败就记一笔病历（2026-11-14 接线）：下次再「打开同一个」时，
            // 拦截/启动会带上「这个坑以前踩过」，不用等人去翻日志。
            try {
                require('./skill-library.js').recordPitfall(hit,
                    'launch_app 启动了但 ' + secElapsed + ' 秒内没看到窗口（可能：窗口标题不含配置名 / 程序自己退了 / 加载慢）');
            } catch (e) { /* 记病历失败不影响返回 */ }
            return VC.failed('「' + hit + '」进程启动了但 ' + secElapsed + ' 秒内没看到窗口', {
                evidence: '已 spawn 成功，但 25 秒内没检测到匹配的进程/窗口'
                    + (probeFails ? '（其中 ' + probeFails + ' 次检测本身失败，这段时间的证据不可信）' : ''),
                tier: 'L2', launched: true, appeared: false, probeFails, costMs: Date.now() - t0,
                nextIfFailed: '可能是：① 还在加载（大游戏要更久）② 进程名和窗口标题都不含「' + hit + '」'
                    + '（Store 应用真实 exe 在 WindowsApps 下，配置路径只是别名）③ 启动器弹了登录/更新窗口。'
                    + '先 list_windows 看看现在开着什么',
            });
        }
        case 'list_game_profiles': {
            // 列出内置游戏键位方案 + 当前前台识别结果（2026-11-09）。
            // 让她能回答「你能帮我玩什么游戏」并在打游戏时自动选对键位。
            const fg = await detectForegroundTitle();
            const names = Object.keys(SEMANTIC_PROFILES_BUILTIN).filter((n) => !n.startsWith('_'));
            let matched = '';
            for (const n of names) { if (fg && fg.includes(n)) { matched = n; break; } }
            if (!matched && fg) {
                if (/Genshin|原神/i.test(fg)) matched = '原神';
                else if (/植物大战僵尸|PlantsVsZombies|PvZ/i.test(fg)) matched = '植物大战僵尸';
                else if (/Minecraft|我的世界/i.test(fg)) matched = '我的世界';
                else if (/League of Legends|英雄联盟/i.test(fg)) matched = '英雄联盟';
                else if (/Valorant|无畏契约/i.test(fg)) matched = '无畏契约';
                else if (/Counter-Strike|CS2|CSGO/i.test(fg)) matched = '反恐精英';
            }
            const lines = names.map((n) => {
                const risk = SEMANTIC_PROFILES_BUILTIN[n]._risk === 'competitive' ? '（竞技·需授权）' : '';
                const acts = Object.keys(SEMANTIC_PROFILES_BUILTIN[n]).filter((k) => !k.startsWith('_'));
                return `· ${n}${risk}：${acts.slice(0, 8).join('/')}${acts.length > 8 ? '…' : ''}（${acts.length} 个动作）`;
            });
            return VC.readonly(
                `当前前台：${fg || '（读不到）'}${matched ? ' → 自动匹配「' + matched + '」' : ''}\n内置游戏方案（${names.length} 个）：\n${lines.join('\n')}\n用法：semantic + 动作名，如「前进」「技能」「跳跃」`,
                { matched: matched || null, foreground: fg, profiles: names },
            );
        }
        case 'semantic': {
            // Neuro SDK 思路（竞品 Top2）：游戏方声明动作 schema（键位 profile），她只做语义选择。
            // arg 格式：「动作名[,秒数]」，如 "前进,2"（按住 W 两秒）/ "攻击" / "跳跃"。
            // profile 选择优先级（2026-11-09 增强）：
            //   ① arg 前缀 "profile:名|动作"（显式指定，最高优先）
            //   ② 前台窗口标题命中内置游戏名（原神/我的世界/英雄联盟…）→ 自动用该 profile
            //   ③ config 里 game_profiles.<名> 覆盖/新增
            //   ④ 回落到 generic
            let spec = a;
            let profileId = 'generic';
            const pm = a.match(/^profile:([\w\-一-龥]+)\|(.+)$/);
            if (pm) { profileId = pm[1]; spec = pm[2]; }

            // ② 自动识别当前游戏（按前台窗口标题）——让「打游戏」不需要用户先报游戏名
            let autoMatched = null;
            if (profileId === 'generic' || !pm) {
                const fg = await detectForegroundTitle();
                if (fg) {
                    for (const name of Object.keys(SEMANTIC_PROFILES_BUILTIN)) {
                        if (name !== '_risk' && fg.includes(name)) { autoMatched = name; break; }
                    }
                    // 标题模糊匹配（英文/别名）
                    if (!autoMatched) {
                        if (/Genshin|原神/i.test(fg)) autoMatched = '原神';
                        else if (/植物大战僵尸|PlantsVsZombies|PvZ/i.test(fg)) autoMatched = '植物大战僵尸';
                        else if (/Minecraft|我的世界/i.test(fg)) autoMatched = '我的世界';
                        else if (/League of Legends|英雄联盟/i.test(fg)) autoMatched = '英雄联盟';
                        else if (/Valorant|无畏契约/i.test(fg)) autoMatched = '无畏契约';
                        else if (/Counter-Strike|CS2|CSGO/i.test(fg)) autoMatched = '反恐精英';
                    }
                    if (autoMatched) profileId = autoMatched;
                }
            }

            // 合并：内置 → config 覆盖 → generic 兜底
            const builtin = SEMANTIC_PROFILES_BUILTIN[profileId] || null;
            const cfgProfile = (semanticProfiles && semanticProfiles[profileId]) || null;
            const profile = Object.assign({}, SEMANTIC_GENERIC, builtin || {}, cfgProfile || {});
            const parts = spec.split(',').map((s) => s.trim()).filter(Boolean);
            const move = parts[0];
            const binding = profile[move];
            if (!binding) {
                const avail = Object.keys(profile).filter((k) => !k.startsWith('_'));
                throw new Error('不认识的语义动作：' + move + '（profile=' + profileId + (autoMatched ? '/自动识别' : '') + ' 可用：' + avail.join('、') + '）');
            }
            // 竞技游戏默认要求显式授权（反作弊风险告知）
            if (profile._risk === 'competitive' && !(semanticProfiles && semanticProfiles.__allowCompetitive === true)) {
                throw new Error('「' + profileId + '」属于竞技游戏，自动输入有账号风险。确认要用请说「允许竞技游戏操控」或配置 __allowCompetitive:true');
            }
            // 绑定形如 "press:w" / "hold:w,2" / "combo:ctrl+s" / "text:你好"
            const [kind, val] = binding.split(':');
            const val2 = parts[1] ? kind === 'hold' ? val.split(',')[0] + ',' + parts[1] : val : val;
            // ⚠ 2026-11-09 修（三十五轮）关于 semantic 的验证：
            //   下面四条都在转发，所以 press_key / hold_key / type_text 各自的验证
            //   会通过契约原样传出去——这正是「验证跟着底层动作走」。
            //   不重复套 actAndVerify：会花两倍 dHash 成本，而且对「按住 W 走两秒」
            //   这种持续动作，外层「画面变了没」反而判定不准。
            //   这里补两件：① 给结果打语义标签 ② **验证过的动作自动落经验层**
            let r;
            if (kind === 'press') r = await runGameAction('press_key', val2, focus);
            else if (kind === 'hold') r = await runGameAction('hold_key', val2, focus);
            else if (kind === 'combo') r = await runGameAction('press_key', val2, focus);
            else if (kind === 'text') r = await runGameAction('type_text', val2, focus);
            else throw new Error('绑定类型不认识：' + kind);

            if (r && typeof r === 'object') {
                // 兜底：万一下层返回的不是契约形状（比如早期版本的 press_key），
                // 用 VC 包一层，保证「semantic 的返回永远有 verified/effect/detail」。
                if (r.effect === undefined) {
                    r = r.ok
                        ? VC.unverified(String(r.detail || ('已执行 ' + move)), {
                            evidence: '下层动作返回的是旧格式（无契约字段）',
                            nextIfFailed: '这条动作链还没契约化，效果需要自己确认',
                            ...r,
                        })
                        : VC.notSent(String(r.error || r.detail || ('执行 ' + move + ' 失败')), r);
                }
                r.semantic = { game: profileId, action: move, binding, autoMatched: autoMatched || null };
                // 经验落库统一由 index.js 的 executeTool 收口（2026-11-09 三十五轮）——
                // 那里能看到所有 action，不会漏，也不会重复。这里只负责打 semantic 标签，
                // index.js 会读 r.semantic.game 决定记到哪个游戏名下。
            }
            return r;
        }
        case 'click_text': {
            // 精准点击（拍板：UIA 优先+OCR 兜底）。
            // ① UIA：控件树直读 Name→真实控件中心——快、抗 DPI、抗窗口移动，原生对话框最准；
            // ② OCR：RapidOCR 找字点中心——UIA 够不着的非原生控件（部分游戏/网页/自绘 UI）兜底。
            if (!a) throw new Error('要点的文字呢（如「确定」「关闭」）');
            // ── 统一守卫（2026-11-21 P0 根因修）──────────────────────────────
            // 原实现这条路径**完全不经过** §71 的 checkButton：编辑器/记事本弹
            // 「是否保存更改」时 click_text 不保存 会直接丢用户数据（注释自述实测两次）。
            // 先在请求文本上拦（连 UIA/OCR 都不跑），底下 Invoke/坐标/OCR 三个原语还会再拦一次。
            const ctGuard = {
                name: String(a),
                source: 'click_text',
                confirmDestructive: !!(extraCfg && extraCfg.confirm_destructive),
            };
            await assertClickGuard(ctGuard);
            // ⚠ 2026-11-09 修（三十五轮）：三条执行路径原来都是「发了就 ok」——
            //   Invoke 成功 ≠ 界面有反应；坐标点击成功 ≠ 点到了；OCR 找到 ≠ 点对了。
            //   现在每条路径都套 actAndVerify 闭环。
            // P2-8（2026-11-21）：名称归一 + 三级匹配（精确 → 去 (&H) 后缀 → 包含）。
            // 全角/零宽字符/快捷键后缀不再导致「找不到」；命中多个 → ambiguous（不猜）。
            let u = await uiaFindText(a);
            if (!u.found) {
                const bare = stripAccelSuffix(a);
                if (bare && bare !== a) u = await uiaFindText(bare);
            }
            if (!u.found) {
                // D2（2026-11-22）：UIA 这一档没找到（下面会走 OCR）——记一次真实的
                // UIA 通道失败，供以后把这个 app 的 UIA 排到 OCR 后面。
                // 只记账，不改接下来的 OCR 执行与校验。
                try {
                    // 只认这次 UIA 命中/请求带回来的 pid 与显式 focus —— 不用上一次
                    // snapshot 的 pid（那可能是另一个窗口，会把经验记错 app）。
                    const app = _expAppFor(u && u.pid, focus || '');
                    if (app) {
                        const out = routeExperience.record({ app, via: 'uia', ok: false, verified: false });
                        if (out && out.recorded) {
                            bumpControlStat('routeExpRecords', 1);
                            if (out.degraded) bumpControlStat('routeExpDegraded', 1);
                        }
                    } else {
                        bumpControlStat('routeExpSkippedNoApp', 1);
                    }
                } catch (e) { /* 记账失败绝不影响点击 */ }
            }
            if (u.found) {
                const allHits = (Array.isArray(u.hits) && u.hits.length) ? u.hits : [u];
                // 指定了 window 时，先把命中范围收窄到该 pid —— 桌面上同名文字（「取消」「确定」）
                // 到处都有，不收窄会把「目标窗口里的唯一按钮」误判成 ambiguous。
                let uWinInfo = null;
                if (focus) {
                    try { uWinInfo = await resolveWindowInfo(focus); } catch (e) { uWinInfo = null; }
                }
                const focusPid = uWinInfo ? Number(uWinInfo.pid) || 0 : 0;
                let pool = allHits;
                if (focusPid) {
                    const scoped = allHits.filter((h) => Number(h.pid) === focusPid);
                    if (scoped.length) pool = scoped;
                }
                // 同一个 rid 只留一个（嵌套元素偶尔会重复报同一个控件）
                {
                    const seen = new Set();
                    pool = pool.filter((h) => {
                        const k = String(h.rid || '') + '@' + h.x + ',' + h.y + '|' + h.name;
                        if (seen.has(k)) return false;
                        seen.add(k);
                        return true;
                    });
                }
                const m = matchUiNames(pool, a);
                // 同层多命中时，优先可交互类型（button/checkbox/…）：文字层与按钮同名很常见，
                // 类型是客观信号，不算「猜」。仍然多个可交互 → ambiguous。
                let unique = m.unique;
                let ambHits = m.hits;
                if (!unique && m.hits.length > 1) {
                    const INTERACTIVE = new Set(['button', 'checkbox', 'radiobutton', 'listitem', 'menuitem',
                        'splitbutton', 'hyperlink', 'tabitem', 'combobox', 'edit', 'treeitem', 'slider']);
                    const actHits = m.hits.filter((h) => INTERACTIVE.has(String(h.type || '').toLowerCase()));
                    if (actHits.length === 1) { unique = actHits[0]; ambHits = actHits; }
                    else if (actHits.length > 1) { ambHits = actHits; }
                }
                if (!unique && ambHits.length > 1) {
                    const cands = ambHits.slice(0, 6).map((h) => ({
                        name: String(h.name || '').slice(0, 40), x: h.x, y: h.y, pid: h.pid || 0,
                    }));
                    return VC.notSent('「' + a + '」命中 ' + ambHits.length + ' 个控件（' + (m.tier || 'contains') +
                        ' 级匹配），不猜是哪一个：' +
                        cands.map((c) => '「' + c.name + '」@(' + c.x + ',' + c.y + ')').join(' / '), {
                        code: 'ambiguous', ambiguous: true, candidates: cands, tier: 'L3',
                        nextIfFailed: '换更精确的名字（或带窗口名），先 snapshot 拿编号后 act click #编号',
                    });
                }
                const hitEl = unique || pool[0] || allHits[0];
                const uName = String(hitEl.name || u.name || a);
                const uPid = Number(hitEl.pid || u.pid) || 0;
                const uRid = String(hitEl.rid || u.rid || '');
                const uWin = String(focus || '') || await titleForPid(uPid);
                if (!uWinInfo) {
                    try { uWinInfo = await resolveWindowInfo(focus || uPid); } catch (e) { uWinInfo = null; }
                }
                const uHwnd = uWinInfo ? Number(uWinInfo.hwnd) || 0 : 0;
                // UIA 命中的真实控件名参与守卫：请求文本可能是「保存」，但命中的是
                // 「不保存」的同名前缀控件（或反过来）——守卫必须看**将要点的那个元素**。
                const uiaClickGuard = {
                    name: uName, source: 'click_text', confirmDestructive: ctGuard.confirmDestructive,
                };
                // P1-7：没有 rid 时只能靠坐标 —— IsOffscreen/IsEnabled 先挡（不盲点）
                if (!uRid) {
                    const g0 = gateElementState({ found: true, offscreen: hitEl.offscreen === true, enabled: hitEl.enabled !== false });
                    if (!g0.ok) {
                        return VC.notSent('控件「' + uName.slice(0, 20) + '」不可用（' + g0.reason + '）——没发点击', {
                            code: g0.code, elementUnavailable: true,
                            elementName: uName.slice(0, 60), tier: 'L3',
                            nextIfFailed: '先把元素滚进可视区/展开面板；被禁用的控件不能点',
                        });
                    }
                }
                // 第一档：Invoke → Toggle → SelectionItem.Select（PS 5.1，零 SetCursorPos）
                if (uRid) {
                    const verifiedAction = await actAndVerify(async () => {
                        let el = null;
                        try { el = await uiaElementAction(uWin || '', uRid, 12000, uHwnd, uiaClickGuard); }
                        catch (e) {
                            if (e && e.guardBlocked) throw e;
                            el = { ok: false, found: false, error: String(e && e.message || e) };
                        }
                        if (!el || el.found !== true) {
                            const core = await coreUiaAction(String(uHwnd || uWin || ''), uRid, 'invoke', undefined, uiaClickGuard);
                            if (core && core.ok === true) {
                                return { ok: true, found: true, how: 'invoke', name: core.name || uName, pid: uPid };
                            }
                            return el || { ok: false, found: false, error: '元素找不到' };
                        }
                        const g = gateElementState(el);
                        if (!g.ok) {
                            return Object.assign({}, el, { ok: false, code: g.code, error: g.reason });
                        }
                        return el;
                    }, { expectChange: true, timeoutMs: 1500, guard: uiaClickGuard });
                    const arA = (verifiedAction && verifiedAction.actionResult) || {};
                    if (arA.code === 'element_unavailable') {
                        return VC.notSent('控件「' + uName.slice(0, 20) + '」不可用（' + arA.error + '）——没发点击', {
                            code: 'element_unavailable', elementUnavailable: true,
                            elementName: uName.slice(0, 60), tier: 'L2',
                            nextIfFailed: '先把元素滚进可视区/展开面板；被禁用的控件不能点',
                        });
                    }
                    if (arA.ok === true && ['invoke', 'toggle', 'select'].includes(arA.how)) {
                        const vr = VC.fromActAndVerify(verifiedAction, {
                            detail: `已点控件「${uName.slice(0, 20)}」（${arA.how === 'invoke' ? 'Invoke 直调' : arA.how === 'toggle' ? 'Toggle 直调' : 'SelectionItem.Select 直调'}）`,
                        });
                        if (vr.effect === 'suspected_noop') {
                            vr.nextIfFailed = 'UIA 调用成功了但界面没反应：控件可能不是真按钮，或弹窗挡住。先 snapshot 看现场，或改用 som_snapshot';
                        }
                        vr.via = 'uia-' + arA.how;
                        vr.how = arA.how;
                        vr.elementName = uName.slice(0, 60);
                        return vr;
                    }
                    // 不支持任何 Pattern → 继续往下走坐标点击（不算失败）
                }
                // 第二档：坐标（UIA BoundingRectangle 中心 → pet-core 物理入口）
                // 2026-11-14 五十三轮（审计致命项）：坐标兜底先断言前台。
                // UIA 命中只带回 pid/坐标，没有窗口标题 → 按 pid 反查窗口，再比对前台。
                if (uWin) {
                    const fgU = await assertTargetFocused(uWin, { strict: true });
                    if (!fgU.ok) {
                        return VC.notSent('控件找到了（「' + String(uName || a).slice(0, 20) + '」@(' + hitEl.x + ',' + hitEl.y + ')），但' + fgU.error, {
                            vetoCode: VETO.FOCUS_LOST,
                            targetPid: uPid || fgU.targetPid || 0,
                            fgPid: fgU.fgPid || 0,
                            elementName: String(uName || '').slice(0, 60),
                            nextIfFailed: '坐标点击只认前台：先 focus_window 把「' + uWin + '」调到前台再重试',
                        });
                    }
                }
                const verifiedClick = await actAndVerify(async () => clickAt(Number(hitEl.x), Number(hitEl.y), 8000, uWin, '', uiaClickGuard), {
                    expectChange: true, timeoutMs: 1500, guard: uiaClickGuard,
                });
                const vrC = VC.fromActAndVerify(verifiedClick, {
                    detail: `已点控件「${uName.slice(0, 20)}」@(${hitEl.x},${hitEl.y})（UIA，进程 ${uPid}）`,
                });
                if (vrC.effect === 'suspected_noop') {
                    vrC.nextIfFailed = '坐标点在控件上但界面没变：可能控件是纯文本不能点，或窗口最小化了（坐标是旧值）';
                }
                vrC.via = 'uia-coord';
                vrC.how = 'coord';
                vrC.elementName = uName.slice(0, 60);
                return vrC;
            }
            const res = await new Promise((resolve) => {
                // 执行链第二档：focus 给了窗口就用 PrintWindow 单窗截图（省整屏开销、能截被遮挡窗）；否则整屏
                // ⚠ 2026-11-10 审计抓到：这里写死了绝对路径（换目录/换机器就永久失效）。
                //   改成和 visual_read 一样：沿目录树找项目根 + PET_PYTHON 覆盖。
                const ocrRoot = findProjectRoot(__dirname);
                const ocrPy = resolvePython();
                const ocrScript = require('path').join(ocrRoot, 'pet-runtime', 'tools', 'ocr_find.py');
                const pyArgs = [ocrScript, a];
                if (focus) pyArgs.push('--window', focus);
                const child = spawn(ocrPy,
                    pyArgs, { windowsHide: true });
                let out = '';
                child.stdout.on('data', (c) => { out += c; });
                child.on('error', (e) => resolve({ ok: false, error: e.message }));
                child.on('close', () => { try { resolve(JSON.parse(out)); } catch (e2) { resolve({ found: false, error: 'ocr 输出异常' }); } });
                setTimeout(() => { try { child.kill(); } catch (e2) {} resolve({ found: false, error: 'ocr timeout' }); }, 45000);
            });
            // 单窗没截到（窗口不存在/最小化）→ 退整屏再试一次
            if (focus && res.error && /没找到可截的窗口/.test(res.error)) {
                const r2 = await new Promise((resolve) => {
                    const child = spawn(ocrPy,
                        [require('path').join(findProjectRoot(__dirname), 'pet-runtime', 'tools', 'ocr_find.py'), a], { windowsHide: true });
                    let out = '';
                    child.stdout.on('data', (c) => { out += c; });
                    child.on('close', () => { try { resolve(JSON.parse(out)); } catch (e2) { resolve({ found: false }); } });
                    setTimeout(() => { try { child.kill(); } catch (e2) {} resolve({ found: false }); }, 45000);
                });
                Object.assign(res, r2);
            }
            if (!res.found || !res.hits || !res.hits.length) {
                // ⚠ 2026-11-10 三十六轮修（回归测试用例 C 抓到的「假核查」）：
                //   上面 spawn OCR 时挂了 45s 超时，`res.error` 可能是 'ocr timeout'。
                //   原来把 error 整个丢掉，统一说「UIA 和 OCR 都没看到」——
                //   但**超时意味着这次检查根本没跑完**，不是「看过了但没有」。
                //   这是假成功的镜像：把「没查成」报告成「查过了、没有」。
                //   实测：ocr_find.py 全屏一次 39.8s（负载高时）——原来的 20s 超时必踩，现已放到 45s。
                const ocrErr = res && res.error ? String(res.error) : '';
                const ocrTimedOut = /timeout|超时/i.test(ocrErr);
                if (ocrTimedOut) {
                    return VC.notSent(
                        '没法确认「' + a + '」在不在屏幕上：OCR 超时了（' + ocrErr + '），这次检查**没跑完**',
                        {
                            tier: 'L3', checked: false, ocrSaw: '',
                            nextIfFailed: '① 用 --rect 只识别目标区域（快 10 倍以上）② 或先 som_snapshot 看画面再 click_at 坐标',
                        },
                    );
                }
                // ⚠ 2026-11-10 用户拍板：**OCR 找不到时自动试模板匹配兜底**。
                //   动机：游戏里的艺术字 RapidOCR 认不出（PVZ 主菜单「点击开始」木牌的白字完全识别不到），
                //   而 visual_locate.py 的模板匹配实测 3/3 命中（0.8898 / 0.9801 / 0.9331）。
                //   设计约束：
                //     ① **有模板才试** —— 模板库是 pet-runtime/knowledge/templates/<文字>.png，
                //        没有对应模板就直接跳过，零额外开销（不 spawn、不截图）。
                //     ② 复用 visual_click 那条链（它已含「验前台 → 自动聚焦 → 点击 → dHash 闭环」），
                //        不重写一遍点击逻辑，避免两处行为漂移。
                //     ③ 模板也失败时**不吞掉原 notSent**，而是在 nextIfFailed 里补一句「模板也试过了」，
                //        让调用方知道两条路都走完了。
                let tplTried = null;
                if (focus) {
                    try {
                        const tplDir = path.join(
                            findProjectRoot(path.resolve(__dirname, '..', '..', '..', '..')),
                            'pet-runtime', 'knowledge', 'templates',
                        );
                        const safeName = String(a).replace(/[\\/:*?"<>|]/g, '_');
                        const tplFile = path.join(tplDir, safeName + '.png');
                        if (require('fs').existsSync(tplFile)) {
                            const tplRes = await runGameAction('visual_click', String(a), focus, semanticProfiles, extraCfg);
                            if (tplRes && tplRes.ok) {
                                tplRes.viaChain = 'ocr→template';
                                tplRes.detail = 'OCR 没认出来，改用模板匹配找到并点击：' + String(tplRes.detail || '');
                                return tplRes;
                            }
                            tplTried = tplRes;
                        }
                    } catch (e) {
                        // 模板路挂了不能影响主流程的诚实报告
                        try { __silentAudit.audit('game-control.js:click_text/tpl', e); } catch (e2) { /* ignore */ }
                    }
                }
                return VC.notSent('屏幕上没找到「' + a + '」（UIA 和 OCR 都没看到' + (tplTried ? '，模板匹配也没命中' : '') + '）', {
                    tier: 'L2', checked: true,
                    ocrSaw: String(res.all || '').slice(0, 120),
                    ...(ocrErr ? { ocrError: ocrErr.slice(0, 120) } : {}),
                    ...(tplTried ? { templateTried: true, templateScore: tplTried.matchScore, templateError: String(tplTried.error || '').slice(0, 160) } : {}),
                    nextIfFailed: '这可能说明：① 文字写错了 ② 那个窗口被别的窗口完全挡住了 ③ 窗口最小化（OCR 截不到）④ 文字是画在游戏画面里的，OCR 认不出。先 list_windows 看窗口状态，或 som_snapshot 看画面',
                });
            }
            const hit = res.hits[0];
            // 同上（红队 S3）：OCR 命中的坐标是几秒前截的图上的，期间窗口可能被切走。
            // 有 focus 就断言它仍是前台，否则点击会落到别的窗口。
            if (focus) {
                const ctChk = await assertTargetFocused(focus, { strict: true });
                if (!ctChk.ok) {
                    return VC.notSent('「' + focus + '」现在不是前台，OCR 坐标的点击会落到别的窗口上——没发出去', {
                        error: ctChk.error, foreground: ctChk.fg ? ctChk.fg.title : null,
                        nextIfFailed: '先 focus_window "' + focus + '" 再重试，或用 snapshot→click_element',
                    });
                }
            }
            const verifiedOcr = await actAndVerify(async () => clickAt(hit.x, hit.y, 8000, '', '', {
                name: String(hit.text || a), source: 'click_text', confirmDestructive: ctGuard.confirmDestructive,
            }), {
                expectChange: true, timeoutMs: 1500,
                guard: { name: String(hit.text || a), source: 'click_text', confirmDestructive: ctGuard.confirmDestructive },
                region: { x: hit.x - 110, y: hit.y - 110, w: 220, h: 220 },
            });
            const vrO = VC.fromActAndVerify(verifiedOcr, {
                detail: `已点击「${hit.text.slice(0, 20)}」@(${hit.x},${hit.y})（OCR 兜底）`,
            });
            if (vrO.effect === 'suspected_noop') {
                vrO.nextIfFailed = 'OCR 找到了字但点完没反应：可能点到的是文字而非按钮（有些 UI 里文字和按钮是分开的），试着点文字下方的按钮区';
            }
            vrO.via = 'ocr';
            return vrO;
        }
        case 'visual_click': {
            // 不靠 OCR 的视觉定位点击（2026-11-10 三十七轮）：模板匹配找按钮 → 点它。
            //
            // 为什么要有这个动作（实测根因）：
            //   游戏里的艺术字 RapidOCR 认不出 —— PVZ 主菜单「点击开始」木牌上的白字完全识别不到，
            //   而弹窗上的标准黑体「检测到更新」能认出来。click_text 在这种画面上必然 notSent。
            //   visual_locate.py 换一条路：cv2.matchTemplate + 多尺度 + 按窗口尺寸归一化，
            //   把「那个按钮长什么样」直接当特征去画面里找（WGC 取物理像素，坐标与 click_at 同系）。
            //
            // arg：`模板名[,minScore]`
            //   模板在 pet-runtime/knowledge/templates/<名>.png，同名 .json 记源窗口尺寸（窗口缩放后仍能匹配）。
            //   minScore 默认 0.80。⚠ 不要为了让动作"能点上"调低它：分数不够就是没找到，诚实报 notSent。
            // focus：目标窗口（在它上面匹配+点击；不给就用前台窗口）。
            //
            // 为什么不做成 click_text 的内部兜底：click_text 是生产路径，改它的行为要用户拍板。
            // 这里只加动作，调用方（LLM/上层）在 click_text 报「OCR 没找到」后自己改用 visual_click。
            const vparts = String(a || '').split(',').map((s) => s.trim());
            const vName = vparts[0] || '';
            if (!vName) throw new Error('格式：模板名[,minScore]（模板在 pet-runtime/knowledge/templates/<名>.png）');
            const vMin = (vparts.length > 1 && vparts[1] !== '') ? Number(vparts[1]) : 0.80;
            if (!Number.isFinite(vMin) || vMin <= 0 || vMin > 1) {
                throw new Error('minScore 必须是 (0,1] 之间的数；收到「' + vparts[1] + '」');
            }
            const vroot = findProjectRoot(path.resolve(__dirname, '..', '..', '..', '..'));
            const vscript = path.join(vroot, 'pet-runtime', 'tools', 'visual_locate.py');
            if (!require('fs').existsSync(vscript)) {
                return VC.notSent('visual_locate.py 不存在：' + vscript, {
                    nextIfFailed: '确认 pet-runtime/tools/visual_locate.py 在位（项目根是往上找到含 pet-runtime/tools 的那层）',
                });
            }
            const vpy = resolvePython();
            const vargs = [vscript, '--template', vName, '--min-score', String(vMin)];
            if (focus) vargs.push('--window', focus);
            const vt0 = Date.now();
            const vres = await new Promise((resolve) => {
                let child;
                try {
                    child = spawn(vpy, vargs, { windowsHide: true });
                } catch (e) {
                    return resolve({ found: false, error: '进程起不来：' + ((e && e.message) || e) });
                }
                let out = '', errOut = '';
                let vTimer = null;
                // 单次完成：清掉超时定时器再 resolve（否则 25s 定时器会让命令行调用白等 20 秒）
                const finish = (obj) => {
                    if (vTimer) { try { clearTimeout(vTimer); } catch (e0) { /* ignore */ } vTimer = null; }
                    resolve(obj);
                };
                child.stdout.on('data', (c) => { out += c; });
                child.stderr.on('data', (c) => { errOut += c; });
                child.on('error', (e) => finish({ found: false, error: 'spawn 失败：' + ((e && e.message) || e) }));
                child.on('close', () => {
                    try { finish(JSON.parse(String(out).trim())); }
                    catch (e2) {
                        finish({
                            found: false,
                            error: 'visual_locate 输出异常（不是 JSON）：' + String(out).slice(0, 160),
                            stderr: String(errOut).slice(0, 160),
                        });
                    }
                });
                // WGC 抓图 0.7-1.3s + 匹配 0.15-0.3s，正常 1-2s；25s 是防死锁的硬上限
                vTimer = setTimeout(() => {
                    try { child.kill(); } catch (e2) { /* 已退出 */ }
                    finish({ found: false, error: 'visual_locate 超时（' + Math.round(Date.now() - vt0) + 'ms 没返回）' });
                }, 25000);
                if (vTimer.unref) vTimer.unref();   // 不把宿主进程的事件循环钉住
            });
            const vMs = Date.now() - vt0;
            if (!vres || vres.found !== true) {
                // 「没找到」≠「没查」：把脚本自己的 error 原样带出去
                //（模板不存在 / 窗口不存在 / 窗口最小化 / 模板比窗口大 / 分数不够 —— 每种都写明）
                const verr = String((vres && vres.error) || '未知（没有 found:true）');
                const vTimedOut = /超时|timeout/i.test(verr);
                return VC.notSent('视觉定位没找到「' + vName + '」：' + verr.slice(0, 240), {
                    tier: 'L2', checked: !vTimedOut,
                    matchScore: vres && vres.score, minScore: vMin,
                    imageSize: vres && vres.img_size, window: (vres && vres.window) || focus || null,
                    locateMs: vMs, via: 'template',
                    ...(vres && vres.stderr ? { stderr: String(vres.stderr).slice(0, 160) } : {}),
                    nextIfFailed: vTimedOut
                        ? '这次检查没跑完：先确认 pet-core 二进制在、窗口没最小化，再重试'
                        : '① 先 --save-region 重新截模板（模板质量直接决定匹配效果）② 确认窗口没换皮肤/语言/大小 ' +
                          '③ 别调低阈值硬凑：分数明显偏低通常说明它不在当前画面上',
                });
            }
            const vx = Number(vres.x), vy = Number(vres.y);
            if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
                return VC.notSent('视觉定位返回 found:true 但坐标不是数字（' + vres.x + ',' + vres.y + '）', {
                    tier: 'L2', checked: true, locateMs: vMs,
                    raw: String(JSON.stringify(vres)).slice(0, 300),
                });
            }
            // 点击前验前台：SetCursorPos+mouse_event 只发给最上层窗口。
            // 「坐标算对了」≠「点得到」（click_at 三十六轮踩过：PVZ 被盖住时点得准但全落到遮挡者）。
            if (focus) {
                const vchk0 = await assertTargetFocused(focus, { strict: true });
                if (!vchk0.ok) {
                    const vfw = await focusWindow(focus, { force: false });
                    await new Promise((r) => setTimeout(r, 260));
                    const vchk = await assertTargetFocused(focus, { strict: true });
                    if (!vchk.ok) {
                        return VC.notSent(
                            '没点：「' + focus + '」不是前台（现在前台是「' + (vchk.fg ? vchk.fg.title : '未知') + '」）。' +
                            '视觉定位已找到「' + vName + '」@(' + vx + ',' + vy + ')，但鼠标事件只会发给最上层窗口；' +
                            '聚焦也试过了：' + (vfw && vfw.error ? String(vfw.error).slice(0, 80) : '复核仍不是前台'),
                            {
                                tier: 'L2', coordsInWindow: true, matchScore: vres.score,
                                locateMs: vMs, foreground: vchk.fg ? vchk.fg.title : null,
                                nextIfFailed: '目标窗口可能被全屏置顶窗口盖住（Windows 限制）——先挪开遮挡窗口，或确认标题写对了',
                            },
                        );
                    }
                }
            }
            // 守卫（2026-11-21 洞 3）：模板名参与破坏性判定，source 标明视觉路径；
            // actAndVerify 的 guard 也要给，否则守卫要等到 clickAt 内部才跑（截图/基线已采完）。
            const vGuard = { source: 'visual', name: vName, x: vx, y: vy };
            const verified = await actAndVerify(async () => clickAt(vx, vy, 8000, '', '', vGuard), {
                expectChange: true, timeoutMs: 1800,
                guard: vGuard,
                region: { x: vx - 110, y: vy - 110, w: 220, h: 220 },
            });
            const vr = VC.fromActAndVerify(verified, {
                detail: '已点击模板「' + vName + '」@(' + vx + ',' + vy + ')（视觉定位，匹配分 ' +
                    Number(vres.score).toFixed(3) + '，缩放 ' + vres.scale + '）',
            });
            vr.via = 'visual';
            vr.template = vName;
            vr.matchScore = vres.score;
            vr.matchScale = vres.scale;
            vr.matchRect = vres.rect;
            vr.imageSize = vres.img_size;
            vr.locateMs = vMs;
            if (vr.effect === 'suspected_noop') {
                vr.nextIfFailed = '模板匹配到了、点击也发了，但画面没变：① 点中的可能只是装饰图不是按钮 ' +
                    '② 目标窗口不在前台（点击落到遮挡者）③ 按钮反应很小（全屏 dHash 9×8 看不出局部小变化，' +
                    '不代表没点上）——先确认前台窗口，再换更贴近按钮本体的模板';
            }
            return vr;
        }
        case 'read_text': {
            // ① UIA TextPattern 优先（2026-11-15 六十轮）：原生文本控件毫秒级、零识别误差
            //    （实测记事本 161ms/18 字符，而 OCR 全窗 4.87s）。读不到再走下面 OCR 通道。
            {
                let uiaTarget = String(a || '').trim();
                if (uiaTarget.startsWith('{')) {
                    try {
                        const o = JSON.parse(uiaTarget) || {};
                        uiaTarget = String(o.window || o.title || o.name || o.focus || o.target || '').trim();
                    } catch (e) { uiaTarget = ''; }
                }
                if (!uiaTarget) uiaTarget = String(focus || '').trim();
                // §81 修：原来这里写 `this.lastUiaTextFail` —— 本函数是**独立函数**（'use strict'
                // 下 this === undefined），于是只要 UIA 读失败就抛 TypeError，
                // 「读不到就继续走 OCR」这条兜底**从来没走通过**（executeTool 直接 500）。
                // 而且那个字段全库没人读。现在用局部变量，把原因拼进 OCR 的结果里，模型才真能据此换招。
                let uiaFailReason = '';
                if (uiaTarget) {
                    const ut = await coreUiaText(uiaTarget, 8000);
                    if (ut && ut.ok) {
                        const body = String(ut.text || '');
                        return VC.confirmed(
                            '「' + (ut.title || uiaTarget) + '」UIA 读到 ' + ut.chars + ' 字符（' + Math.round((ut.us || 0) / 1000) + 'ms）：\n' + body.slice(0, 4000),
                            { via: 'uia-text', chars: ut.chars, text: body.slice(0, 8000) });
                    }
                    // 读不到不报错 —— 继续走 OCR，但把原因带上（下面拼进结果，模型能据此换招）
                    uiaFailReason = (ut && (ut.detail || ut.error)) || 'unknown';
                }
            }

            // 读内容（不是找坐标）：ocr_read.py 双引擎——GLM-OCR 整窗读文（保排版/表格），
            // 空帧或显存不足自动退回 RapidOCR。与 visual_read 的分工：那个做结构推断
            // （数值/血条/网格/按钮），这个把文字整段读出来。
            // 三道闸都在 python 里：空帧判定（VLM 会编内容）、复读截断、显存门限。
            const rroot = findProjectRoot(path.resolve(__dirname, '..', '..', '..', '..'));
            const rscript = path.join(rroot, 'pet-runtime', 'tools', 'ocr_read.py');
            if (!require('fs').existsSync(rscript)) {
                return VC.notSent('ocr_read.py 不存在：' + rscript, {
                    nextIfFailed: '确认 pet-runtime/tools/ocr_read.py 在位',
                });
            }
            const rpy = resolvePython();
            const rargs = [rscript];
            // arg 容错（2026-11-12 实测）：模型有时把参数写成 JSON，如 {"mode":"window"}。
            // 直接当窗口名传给 python 会「找不到窗口」，所以先试着解析出 window/title/name。
            let rargText = a.replace(/\s*--rapid\s*/g, ' ').trim();
            if (rargText.startsWith('{')) {
                try {
                    const o = JSON.parse(rargText) || {};
                    const picked = o.window || o.title || o.name || o.focus || o.target || '';
                    if (picked) rargText = String(picked).trim();
                    else if (o.mode || o.action) rargText = '';   // 只有 mode/action 说明没给窗口
                } catch (e) {
                    // 不是合法 JSON —— 按原文当窗口名，别把用户的标题吃掉
                }
            }
            const rtarget = focus || rargText;
            if (rtarget) rargs.push('--window', rtarget);
            if (/--rapid/.test(a)) rargs.push('--engine', 'rapid');
            const rt0 = Date.now();
            const rres = await new Promise((resolve) => {
                let child;
                try {
                    child = spawn(rpy, rargs, { windowsHide: true });
                } catch (e) {
                    return resolve({ ok: false, error: 'spawn 失败：' + ((e && e.message) || e) });
                }
                let out = '';
                child.stdout.on('data', (c) => { out += c; });
                child.on('error', (e) => resolve({ ok: false, error: 'spawn 失败：' + ((e && e.message) || e) }));
                child.on('close', () => {
                    try { resolve(JSON.parse(String(out).trim())); }
                    catch (e2) { resolve({ ok: false, error: 'ocr_read 输出异常：' + String(out).slice(0, 160) }); }
                });
                setTimeout(() => { try { child.kill(); } catch (e3) { /* 已退出 */ } resolve({ ok: false, error: 'ocr_read 超时（120s）' }); }, 120000);
            });
            const rms = Date.now() - rt0;
            if (!rres || rres.ok === false) {
                const err = String((rres && rres.error) || '未知');
                const blank = /没有可辨认/.test(err);
                return VC.notSent('读不到「' + (rtarget || '屏幕') + '」：' + err.slice(0, 200), {
                    tier: 'L2', checked: !blank && !/超时|timeout/i.test(err), costMs: rms,
                    nextIfFailed: blank
                        ? '这张图截出来是空的（UWP/黑屏/最小化）——改用 snapshot 读控件树，或先把窗口露出来再读'
                        : '① list_windows 确认窗口名对得上 ② 只想要快结果就加 --rapid（RapidOCR，丢表格结构但 2s 级）',
                });
            }
            const txt = String(rres.text || '');
            return VC.readonly(
                '[read_text/' + rres.engine + '] ' + (rres.window || '') + ' 共 ' + txt.length + ' 字（' + rms + 'ms）'
                + (uiaFailReason ? ' UIA 读不到：' + uiaFailReason : '') + '\n' +
                txt.slice(0, 4000),
                {
                    read: { engine: rres.engine, chars: txt.length, guard: rres.guard, fallback: rres.fallback_reason || null },
                    costMs: rms, via: 'ocr_read',
                },
            );
        }
        case 'visual_read': {
            // 通用视觉增强四件套（2026-11-10 三十七轮，全部只读）：
            //   numbers —— 数字区读取（阳光/血量/金币）：rec-only OCR，8ms 级
            //   bars    —— 血条/进度条：HSV 色块 + 槽扩展，fill_ratio 相对槽满宽（实测 0.693/0.345 vs 期望 0.70/0.35）
            //   grid    —— 网格差分（哪格有东西）：存基准 → 逐格比对，--inset 可标定（零误报实测）
            //   buttons —— 通用按钮候选：Canny+轮廓，新游戏没模板时的兜底（卡通画风弱，见 README）
            // 为什么要有：模板只能找"见过的按钮"，这四个从画面**推出结构**，新游戏零准备。
            // arg 语法（子命令必填，--window 由 focus 提供）：
            //   numbers --region x,y,w,h   |  numbers --auto（慢，2-7s，不用知道数字在哪）
            //   bars [--color red|green|blue|yellow|purple|auto]
            //   grid <行>,<列> save|diff [--inset x%,y%,w%,h%]（PVZ 草坪: 4.5,13.5,90.5,72）
            //   buttons [--max n]
            const argStr = String(a || '').trim();
            if (!argStr) throw new Error('arg：numbers/bars/grid/buttons 子命令 + 参数（例："bars"、"grid 5,9 save --inset 4.5,13.5,90.5,72"、"numbers --region 100,20,200,60"）');
            const argvE0 = argStr.split(/\s+/).filter(Boolean);
            // ⚠ 2026-11-10 行为审计抓到（近 2000 行最高频摩擦，10 次）：模型把**窗口名**塞进 arg，
            //   得到「子命令必须是 numbers/bars/grid/buttons：收到「计算器」」然后反复重试。
            //   现在：arg 首词不是合法子命令时，把它当成窗口名（等价 focus），并补默认子命令 numbers。
            //   这样 `visual_read "计算器"` 和 `visual_read "numbers" focus:"计算器"` 都能用。
            const SUBCOMMANDS = ['numbers', 'bars', 'grid', 'buttons'];
            let argvE = argvE0;
            let inferredFocus = '';
            if (!SUBCOMMANDS.includes(argvE0[0])) {
                inferredFocus = argvE0.join(' ');
                argvE = ['numbers'];
            }
            const subCmd = argvE[0];
            const eroot = findProjectRoot(path.resolve(__dirname, '..', '..', '..', '..'));
            const escript = path.join(eroot, 'pet-runtime', 'tools', 'visual_enhance.py');
            if (!require('fs').existsSync(escript)) {
                return VC.notSent('visual_enhance.py 不存在：' + escript, {
                    nextIfFailed: '确认 pet-runtime/tools/visual_enhance.py 在位',
                });
            }
            const epy = resolvePython();
            // ⚠ 2026-11-10 审计抓到：原来只剥 flag 不剥值 —— 用户写 "bars --window 计算器" 时
            //   「计算器」会作为多余位置参数传给 Python。现在成对剥离（flag + 紧随的值）。
            const eArgsRest = (() => {
                const src = argvE.slice(1);
                const out = [];
                for (let i = 0; i < src.length; i += 1) {
                    if (src[i] === '--window') { i += 1; continue; }   // 跳过 flag 和它的值
                    out.push(src[i]);
                }
                return out;
            })();
            const eargs = [escript, subCmd, ...eArgsRest];
            let effFocus = focus || inferredFocus;   // arg 里混进来的窗口名也认
            // 2026-11-14 五十三轮（审计）：visual_enhance.py 的 --window 是 required，
            // 而 `see mode=state` 这条路径原来不带 focus → 每次必失败。
            // 没给就取**当前前台窗口**（用户让她「读一下现在的数」时本来就是看前台）。
            if (!effFocus) {
                try {
                    const cli = getCoreClient(_coreBin());
                    const fg = await cli.call({ cmd: 'fg' }, 2500);
                    if (fg && fg.ok && fg.title) effFocus = String(fg.title);
                } catch (e) { /* 取不到就下面直接报错，不静默 */ }
            }
            if (!effFocus) {
                return VC.notSent('visual_read 需要知道读哪个窗口：arg 里带窗口名，或 focus 指定，或让目标窗口在前台', {
                    nextIfFailed: '例：act/see 传 window:"计算器"；或先用 app focus 把它调到前台',
                });
            }
            if (effFocus) eargs.push('--window', effFocus);
            const et0 = Date.now();
            const eres = await new Promise((resolve) => {
                let child;
                try {
                    child = spawn(epy, eargs, { windowsHide: true });
                } catch (e) {
                    return resolve({ ok: false, error: 'spawn 失败：' + ((e && e.message) || e) });
                }
                let eout = '';
                let eTimer = null;
                const efin = (obj) => { if (eTimer) { try { clearTimeout(eTimer); } catch (e0) { /* ignore */ } eTimer = null; } resolve(obj); };
                child.stdout.on('data', (c) => { eout += c; });
                child.on('error', (e) => efin({ ok: false, error: 'spawn 失败：' + ((e && e.message) || e) }));
                child.on('close', () => {
                    try { efin(JSON.parse(String(eout).trim())); }
                    catch (e2) { efin({ ok: false, error: 'visual_enhance 输出异常（不是 JSON）：' + String(eout).slice(0, 160) }); }
                });
                eTimer = setTimeout(() => { try { child.kill(); } catch (e3) { /* 已退出 */ } efin({ ok: false, error: 'visual_enhance 超时（45s）' }); }, 45000);
                if (eTimer.unref) eTimer.unref();
            });
            const eMs = Date.now() - et0;
            if (!eres || eres.ok === false || !eres.mode) {
                // 脚本自己 emit 的错误对象没有 mode 字段（emit({ok:false,error})）
                const eerr = String((eres && (eres.error || eres.msg)) || '未知（没有 mode 字段）');
                return VC.notSent('visual_read[' + subCmd + '] 失败：' + eerr.slice(0, 240), {
                    tier: 'L2', checked: !/timeout|超时/i.test(eerr), costMs: eMs,
                    nextIfFailed: '① 确认窗口没最小化（WGC 抓不到）② numbers 的 --region 是窗口内物理像素 ' +
                        '③ grid 第一次要先 save 基准，窗口改尺寸后要重新 save',
                });
            }
            // 只读：readonly 档（不算进动作成功率，不占限流）
            return VC.readonly(
                '[' + eres.mode + '] ' + JSON.stringify(eres).slice(0, 1400),
                { visual: eres, costMs: eMs, via: 'visual_enhance' },
            );
        }
        case 'pvz_state': {
            // 读 PVZHE Mod「大肥鱼状态导出」的 user_state.json（2026-11-10 三十七轮）。
            // 前提：游戏内安装了 pvzhe-dsh-state mod（.pmod 已备好在 Mods 目录，等 GUI 安装）。
            // mod 每 500ms 原子写（tmp+rename），这里只读——所以 stale 判定用 updatedAt 距今。
            const STATE_FILE = require('path').join(findProjectRoot(__dirname), 'pet-runtime', 'data', 'pvz_user_state.json');
            if (!fs.existsSync(STATE_FILE)) {
                // 区分「没装」「装了没启用」「启用了但游戏没开」三种情况（2026-11-10 三十八轮）：
                // ModManager 的启用状态持久化在 Mods/mod_last_good.json 的 selection.enabledIds，
                // 直读它就能给出准确下一步，而不是永远说「去 GUI 装」。
                const userDir = require('path').join(process.env.APPDATA || require('os').homedir(), 'Godot', 'app_userdata', '植物大战僵尸杂交版');
                const lg = userDir + '/Mods/mod_last_good.json';
                let enabled = null;
                try { enabled = (JSON.parse(fs.readFileSync(lg, 'utf8')).selection || {}).enabledIds || []; } catch (e) { enabled = null; }
                const hasMod = fs.existsSync(userDir + '/Mods/pvzhe-dsh-state') || fs.existsSync(userDir + '/Mods/pvzhe-dsh-state.pmod');
                if (!hasMod) {
                    return VC.notSent('pvz_user_state.json 不存在 —— Mod「大肥鱼状态导出」(pvzhe-dsh-state) 还没装进游戏', {
                        nextIfFailed: '把 pvzhe-dsh-state.pmod 放进 Mods 目录后重试（游戏选项 → Mod 管理）',
                    });
                }
                if (enabled && !enabled.includes('pvzhe-dsh-state')) {
                    return VC.notSent('Mod 装了但**没启用**（mod_last_good.json 的 enabledIds 里没有它）', {
                        enabledIds: enabled,
                        nextIfFailed: '启用它（不用点 GUI）：node pet-runtime/tools/pvz-mod-enable.cjs —— 下次开游戏自动加载',
                    });
                }
                return VC.notSent('Mod 已启用，但状态文件还没出现 —— 游戏可能没开，或刚开还没进关卡', {
                    enabledIds: enabled,
                    nextIfFailed: '开游戏并进任意关卡，约 1 秒后 mod 会开始写状态（日志出现 loaded 1 enabled Mod package(s)）',
                });
            }
            let st = null;
            try {
                st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            } catch (e) {
                // 500ms 原子写窗口撞上读取（rename 原子性下不该发生，防御）
                return VC.notSent('状态文件解析失败（可能撞上写入，稍后重试即可）: ' + (e && e.message || e), { retryable: true });
            }
            let ageMs = -1;
            try { ageMs = Date.now() - new Date(String(st.updatedAt).replace(' ', 'T')).getTime(); } catch (e0) { /* 无时间戳 */ }
            const stale = ageMs > 5000;
            return VC.readonly(
                'PVZ 状态' + (stale ? '（**已过期 ' + Math.round(ageMs / 1000) + 's —— 游戏可能已关或 mod 停了**）' : '（新鲜）') +
                ': 阳光=' + st.sun + ' 角色事件数=' + st.charactersSeen +
                (st.battleResult ? ' 结果=' + String(st.battleResult).slice(0, 60) : '') +
                (st.lastEvent ? ' 最近事件=' + String(st.lastEvent).slice(0, 80) : ''),
                { state: st, ageMs, stale, via: 'pvzhe-dsh-state-mod' },
            );
        }
        case 'wgc_hash': {
            // 用 WGC（Windows.Graphics.Capture）按 **HWND** 抓窗口并算 dHash。
            //
            // ⚠ 为什么会有这个 action（2026-11-09 实测铁证）：
            //   GDI BitBlt 从**屏幕 DC** 读，窗口被别的窗口盖住时读到的是遮挡者的像素。
            //   实测：白底测试窗口被 VALORANT 全屏盖住时 ——
            //     · GDI 平均亮度 1.0（全黑，读到的是 VALORANT）
            //     · WGC 平均亮度 239.6（正确拿到白底窗口内容）
            //   所以「窗口被遮挡但要看它的内容」这个场景**只有 WGC 能做**。
            //
            // ⚠ 但它慢：单次 CLI 调用 560-1200ms（其中 ~480ms 是 D3D11 设备 + FramePool 初始化）。
            //   GDI 只要 40-58ms。**所以不能当默认路径** —— 只在确实需要时用。
            //
            // arg：窗口标题子串或 hwnd（可选 ",client" 只抓客户区）
            const wparts = String(a || '').split(',').map((x) => x.trim());
            const wTarget = wparts[0] || '';
            const wClientOnly = wparts.length > 1 && /client/i.test(wparts[1]);
            if (!wTarget) throw new Error('要抓哪个窗口：wgc_hash <窗口标题或hwnd>');
            // 唯一解析入口（2026-11-21 P2）：进后端前换成 hwnd，WGC 不再按标题找一次。
            const wz = await resolveTargetHwnd(wTarget);
            if (!wz || wz.ok === false) {
                return VC.notSent('WGC 找不到目标窗口：' + ((wz && wz.error) || wTarget), {
                    error: (wz && wz.error) || 'window-unresolved',
                    nextIfFailed: '先 list_windows 确认标题/hwnd',
                });
            }
            const bin = _coreBin();
            if (!bin) return VC.notSent('pet-core 二进制不存在，WGC 不可用', { nextIfFailed: 'cd pet-core && cargo build --release' });
            const t0 = Date.now();
            const rr = await new Promise((resolve) => {
                try {
                    const { execFile } = require('child_process');
                    const child = execFile(bin, [], { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
                        (err, stdout) => {
                            if (err) return resolve(null);
                            try { resolve(JSON.parse(String(stdout))); } catch (e) { resolve(null); }
                        });
                    const payload = { cmd: 'wgc_hash', target: String(wz.hwnd), client_only: wClientOnly, max_wait_ms: 900 };
                    try { child.stdin.end(JSON.stringify(payload), 'utf8'); } catch (e) { resolve(null); }
                } catch (e) { resolve(null); }
            });
            const ms = Date.now() - t0;
            if (!rr) return VC.notSent('WGC 调用失败（进程起不来或输出异常）', { costMs: ms });
            if (!rr.ok) {
                return VC.notSent('WGC 抓不到：' + String(rr.error || '未知'), {
                    tier: 'L3', costMs: ms, nextIfFailed: String(rr.error || '').slice(0, 200),
                });
            }
            const rgba = Array.isArray(rr.gray) && rr.gray.length === 72 ? rr.gray : [];
            return VC.readonly(
                '「' + (wz.title || wTarget) + '」(hwnd=' + wz.hwnd + ') WGC 抓到 ' + rr.width + '×' + rr.height + '，dHash=' + rr.hash +
                '，等帧 ' + (rr.frames_waited || 0) + ' 次（' + Math.round((rr.us_wait || 0) / 1000) + 'ms）+ 读回 ' +
                Math.round((rr.us_readback || 0) / 1000) + 'ms' + (wz.multiHit ? '（' + wz.detail + '）' : ''),
                {
                    hash: rr.hash, width: rr.width, height: rr.height,
                    framesWaited: rr.frames_waited,
                    targetHwnd: wz.hwnd, multiHit: wz.multiHit === true, resolution: wz.detail,
                    // 9×8 灰度矩阵：能直接看出「抓到的是什么画面」（白底 vs 黑屏）
                    gray: rgba,
                    avgBrightness: rgba.length ? Math.round(rgba.reduce((s2, x2) => s2 + x2, 0) / rgba.length) : null,
                    costMs: ms, via: 'wgc',
                    note: 'WGC 按 HWND 从 DWM 合成表面读 —— 窗口被遮挡时也能拿到它自己的内容（GDI 会读到遮挡者）',
                },
            );
        }
        case 'wgc_shot': {
            // 用 WGC 按 **HWND** 抓窗口 → 存 BMP 文件（2026-11-09 三十六轮）。
            //
            // 和 wgc_hash 的分工：
            //   · wgc_hash  只给 64bit dHash —— 能比「变没变」，看不见内容
            //   · wgc_shot  把合成表面落盘成图 —— 她（或多模态模型）能真的看到
            //     「被全屏游戏挡住的窗口里是什么」（GDI BitBlt 只能读到遮挡者的像素）
            //
            // 为什么存 BMP：WGC 拿到的是 BGRA 32bpp，BMP 的 BI_RGB+32bpp 就是同一存储顺序，
            // 零转换零依赖（Cargo.toml 里没有 image/png），PIL/看图器都能打开。
            //
            // arg：`窗口标题或hwnd[,client][,输出路径]`
            //   `ZCode` → 自动存到 %TEMP%\pet-wgc\shot-<ts>.bmp
            //   `ZCode,client` → 只抓客户区
            //   `ZCode,client,D:/tmp/z.bmp` / `记事本,path=D:/tmp/n.bmp`
            const sparts = String(a || '').split(',').map((x) => x.trim()).filter(Boolean);
            const sTarget = sparts[0] || '';
            let sClientOnly = false;
            let sPath = '';
            for (const p of sparts.slice(1)) {
                if (/^client$/i.test(p)) sClientOnly = true;
                else if (/^path[:=]/i.test(p)) sPath = p.replace(/^path[:=]/i, '');
                else if (/[\\/]|\.bmp$/i.test(p)) sPath = p;
                else if (!sPath) sPath = p;   // 兜底：非 client 的参数当路径
            }
            if (!sTarget) throw new Error('要抓哪个窗口：wgc_shot <窗口标题或hwnd>[,client][,输出路径]');
            // 唯一解析入口（2026-11-21 P2）：进后端前换成 hwnd，WGC 不再按标题找一次。
            const sz = await resolveTargetHwnd(sTarget);
            if (!sz || sz.ok === false) {
                return VC.notSent('WGC 抓图找不到目标窗口：' + ((sz && sz.error) || sTarget), {
                    error: (sz && sz.error) || 'window-unresolved',
                    nextIfFailed: '先 list_windows 确认标题/hwnd',
                });
            }
            // ⚠ 2026-11-10 红队实测（任意文件写）：原来 sPath 原样透传给 Rust，
            //   `path:"../../x.bmp"` 或绝对路径都能落地 —— 她的 LLM 参数就能用 7MB BMP
            //   覆盖技能库/配置/看板；而 wgc_shot 又不在限速里，循环调用可写满磁盘。
            //   现在：白名单目录（%TEMP%\pet-wgc）+ 拒绝 `..` + 只允许 .bmp；越界直接拒绝。
            if (sPath) {
                const osx = require('os');
                const allowedDir = require('path').resolve(osx.tmpdir(), 'pet-wgc');
                const resolved = require('path').resolve(sPath);
                const badTraversal = /\.\./.test(sPath);
                const inAllowed = resolved.toLowerCase().startsWith((allowedDir + require('path').sep).toLowerCase());
                const isBmp = /\.bmp$/i.test(resolved);
                if (badTraversal || !inAllowed || !isBmp) {
                    return VC.notSent('wgc_shot 的输出路径只能在 ' + allowedDir + ' 下、且必须是 .bmp（收到：' + sPath.slice(0, 80) + '）', {
                        error: 'path 不在白名单',
                        nextIfFailed: '不给路径就自动存 %TEMP%\\pet-wgc\\；要固定路径也必须在那个目录下',
                    });
                }
                sPath = resolved;
            }
            const shbin = _coreBin();
            if (!shbin) return VC.notSent('pet-core 二进制不存在，WGC 不可用', { nextIfFailed: 'cd pet-core && cargo build --release' });
            const st0 = Date.now();
            const sr = await new Promise((resolve) => {
                try {
                    const { execFile } = require('child_process');
                    const child = execFile(shbin, [], { windowsHide: true, timeout: 25000, maxBuffer: 4 * 1024 * 1024 },
                        (err, stdout) => {
                            if (err) return resolve(null);
                            try { resolve(JSON.parse(String(stdout))); } catch (e) { resolve(null); }
                        });
                    const payload = { cmd: 'wgc_shot', target: String(sz.hwnd), path: sPath, clientOnly: sClientOnly, maxWaitMs: 3000 };
                    try { child.stdin.end(JSON.stringify(payload), 'utf8'); } catch (e) { resolve(null); }
                } catch (e) { resolve(null); }
            });
            const sms = Date.now() - st0;
            if (!sr) return VC.notSent('WGC 抓图调用失败（进程起不来或输出异常）', { costMs: sms });
            if (!sr.ok) {
                return VC.notSent('WGC 抓图失败：' + String(sr.error || '未知'), {
                    tier: 'L3', costMs: sms, nextIfFailed: String(sr.error || '').slice(0, 200),
                });
            }
            // 落盘核验：Rust 返回 ok 不等于文件真在（杀软拦截/磁盘满都可能半途失败），
            // 用 statSync 拿实际字节数和 Rust 报告的 bytes 对账。
            let onDisk = -1;
            try { onDisk = require('fs').statSync(sr.path).size; } catch (e) { onDisk = -1; }
            if (onDisk !== Number(sr.bytes)) {
                return VC.unverified('WGC 抓图返回成功，但落盘字节数对不上：' + sr.path, {
                    path: sr.path, bytes: sr.bytes, onDisk, costMs: sms,
                    evidence: 'statSync 实际 ' + onDisk + ' 字节，Rust 报告 ' + sr.bytes + ' 字节',
                    nextIfFailed: '磁盘满 / 杀软拦截 / 路径不可写。换一个 path（或留空走 %TEMP%）再试',
                });
            }
            return VC.readonly(
                '「' + (sz.title || sTarget) + '」(hwnd=' + sz.hwnd + ') WGC 抓图已存 ' + sr.path + '（' + sr.width + '×' + sr.height + '，' +
                Math.round(Number(sr.bytes) / 1024) + 'KB，dHash=' + sr.hash + '）' + (sz.multiHit ? '（' + sz.detail + '）' : ''),
                {
                    path: sr.path, width: sr.width, height: sr.height, bytes: sr.bytes,
                    hash: sr.hash, framesWaited: sr.frames_waited,
                    targetHwnd: sz.hwnd, multiHit: sz.multiHit === true, resolution: sz.detail,
                    usTotal: sr.us_total, costMs: sms, via: 'wgc',
                    note: 'BMP 32bpp（第 4 字节 alpha 多数看图器忽略）。WGC 按 HWND 从 DWM 合成表面读 —— 窗口被遮挡时也能拿到它自己的内容（GDI 会读到遮挡者）',
                },
            );
        }
        case 'volume': {
            // ⚠ 2026-11-10 三十七轮修（拟真测试抓到）：LLM 传的 arg 是**短式**（"down" / "up 4" / "mute"），
            //   而文案判定写的是全名 `dir === 'volume_down'` —— 短式永远不匹配。
            //   实测：用户说「调小一点」→ 她传 "down" → 按键正确（VK.volume_down = 0xAE 减键，
            //   真的按了 4 下减）但工具自述「音量已升高（4 档）」—— 方向自述与实际相反，
            //   她自己都察觉「这工具回我的话怪怪的」。归一化 dir 让按键/文案/次数三处统一。
            const dirRaw = String(a || '').toLowerCase();
            // ⚠ 2026-11-10 回归审计：只给数字（"4"）时 dir='4' → VK['4']/VK['volume_4'] 都不存在
            //   → 静默回落 VK.volume_up（**往上加 4 档**）。这正是本段注释声称修掉的 fallback 问题。
            //   数字单独出现语义不明，明确拒绝比猜方向好。
            if (/^\s*\d+\s*$/.test(dirRaw)) {
                return VC.notSent('volume 要方向：up / down / mute（可带次数，如 "down 4"）。只给数字我猜不出加还是减', {
                    error: '缺方向', nextIfFailed: '示例："down 4" 减 4 档，"up 2" 加 2 档',
                });
            }
            const dir = dirRaw.includes('down') ? 'volume_down'
                : dirRaw.includes('mute') ? 'volume_mute'
                : dirRaw.includes('up') ? 'volume_up'
                : dirRaw;
            // ⚠ 查表顺序：dir 已归一化成 'volume_down' 等全名，直接查 VK[dir]；
            //   再拼 'volume_'+dir 会查成 volume_volume_down → fallback 成 UP 键
            //   （拟真第二轮当场抓到：文案对「降低」、evidence VK=0xaf 实际按的是加键）。
            //
            // ⚠ 2026-11-14 五十三轮（审计）：这里**必须白名单**。原来末尾是
            //   `|| VK.volume_up` —— 任何没识别出来的方向（"音量"、"小一点"、"loud"）
            //   都会去**调高**音量，然后自述「已升高」。宁可拒绝，也不能猜错方向。
            if (dir !== 'volume_up' && dir !== 'volume_down' && dir !== 'volume_mute') {
                return VC.notSent('volume 要方向：up / down / mute（可带次数，如 "down 4"）——收到「' + dirRaw + '」，我不猜方向', {
                    error: 'unknown_direction', nextIfFailed: '示例："down 4" 减 4 档，"up 2" 加 2 档，"mute" 静音',
                });
            }
            const vk = VK[dir];
            const times = /\d+/.test(a) ? Math.min(10, Number(a.match(/\d+/)[0])) : (dir === 'volume_mute' ? 1 : 2);
            const calls = Array.from({ length: times }, () => `[PetU]::keybd_event(${vk},0,0,[UIntPtr]::Zero); [PetU]::keybd_event(${vk},0,2,[UIntPtr]::Zero);`).join(' Start-Sleep -Milliseconds 40; ');
            const r = await runPs(`${PS_SIG} ${calls} 'done'`);
            if (!r.ok) return VC.notSent('音量操作失败：' + r.error, { nextIfFailed: '检查 PowerShell 能否正常执行' });
            // 音量是系统级状态，能读回来——但当前没有可靠的读法（WASAPI 要 COM 初始化），
            // 所以老实标 unverified，不假装确认了。
            return VC.unverified(`音量已${dir === 'volume_mute' ? '静音切换' : (dir === 'volume_down' ? '降低' : '升高')}（${times} 档）`, {
                evidence: 'keybd_event 发送了 ' + times + ' 次 VK_VOLUME_* 按键（VK=0x' + vk.toString(16) + '）',
                nextIfFailed: '音量键发出去了但没自动确认。若无效，可能是被某个程序独占了多媒体键',
            });
        }
        case 'recent_actions': {
            // 跨会话执行历史（2026-11-10 三十九轮创新）：她回答「刚才/上次做了什么」的
            // **唯一事实来源**。以前历史只在内存里，重启即忘——她说「我刚才帮你查了…」
            // 只能靠上下文猜；现在落在 pet-runtime/data/dispatch-history.jsonl，
            // 重启后照样能翻。arg=条数（默认 10，最多 30）。
            const n = Math.max(1, Math.min(30, Number(String(a || '').trim()) || 10));
            let rows = [];
            try {
                const SK = require('./skill-library.js');
                rows = SK.readHistoryFromDisk ? SK.readHistoryFromDisk(n) : [];
            } catch (e) { try { __silentAudit.audit('game-control:recent-actions', e); } catch (e2) { /* ignore */ } }
            if (!rows.length) {
                return VC.readonly('还没有执行历史（她还没在你电脑上动过手，或历史文件还没生成）', { count: 0 });
            }
            const fmt = (r) => {
                const t = new Date(Number(r.ts) || 0);
                const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
                return hh + ' ' + r.action + (r.arg ? ' ' + String(r.arg).slice(0, 24) : '') + (r.ok ? ' ✓' : ' ✗');
            };
            return VC.readonly(
                '最近 ' + rows.length + ' 次操作（新的在前）：' + rows.map(fmt).join('；'),
                { count: rows.length, items: rows },
            );
        }
        case 'project_status': {
            // ⚠ 2026-11-10 三十九轮（用户拍板）：**这个能力不给她用**——ses 状态栈是
            //   给开发者/AI 协作用的项目看板，不是她的陪伴记忆。她有 MemOS（用户事实/偏好）
            //   + 知识库（世界知识）+ 技能库（操作序列）三层，已经够了；读项目看板会让
            //   她把「AI 的工作清单」当成「用户的生活」，混淆人格边界。
            //   代码保留仅为兼容旧工具面，正常不会走到（enum 已移除）。
            return VC.notSent('这个能力没有开放给她', {
                nextIfFailed: '想了解项目进展直接问用户；你的记忆在 MemOS，知识在知识库，操作经验在技能库',
            });
        }
        case 'knowledge': {
            // 查知识库（2026-11-09 三十五轮新增）。
            // arg：「游戏名[,查询词]」，如 `植物大战僵尸`（给骨架）/ `植物大战僵尸,为什么种不上`（检索）
            // 实现：知识库三层（rules/live/experience）→ Rust 混合检索（BM25 + 向量 + RRF）
            const KB = require('./knowledge-base.js');
            const kparts = String(a || '').split(',').map((s) => s.trim()).filter(Boolean);
            let game = kparts[0] || '';
            const kquery = kparts.slice(1).join(',') || '';
            // 没给游戏名 → 自动用前台窗口标题
            if (!game) {
                const fg = await detectForegroundTitle();
                game = fg || '';
            }
            const t0 = Date.now();
            const kn = await KB.getKnowledge(game, { query: kquery, topK: 8 });
            const ms = Date.now() - t0;
            if (!kn || (!kn.found && !(kn.experience || []).length)) {
                // 四层检索仲裁（2026-11-10 三十九轮，用户要求「知识库和 MemOS 协调好」）：
                //   知识库只装「关于世界」的知识（游戏设定/攻略），**用户偏好/事实不在里面**。
                //   查不到时自动回落到 MemOS（关于用户的记忆），别直接说「我不知道」。
                let memHits = [];
                try {
                    const body = JSON.stringify({ query: kquery || game, user_id: 'feiniu_default', limit: 5 });
                    const mem = await new Promise((resolve) => {
                        try {
                            const req = require('http').request({
                                host: '127.0.0.1', port: 8003, path: '/search', method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 12000,
                            }, (res) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(null); } }); });
                            req.on('error', () => resolve(null));
                            req.setTimeout(12000, () => { try { req.destroy(); } catch (e) { /* ignore */ } resolve(null); });
                            req.write(body); req.end();
                        } catch (e) { resolve(null); }
                    });
                    memHits = (mem && Array.isArray(mem.memories)) ? mem.memories : [];
                } catch (e) { try { __silentAudit.audit('game-control:knowledge-memos-fallback', e); } catch (e2) { /* ignore */ } }
                if (memHits.length) {
                    const lines = memHits.slice(0, 5).map((m) => '· ' + String(m.content || '').slice(0, 80)).join('\n');
                    return VC.readonly(
                        '知识库里没有「' + (game || '当前环境') + '」的世界知识，但**我的记忆里**有 ' + memHits.length + ' 条相关：\n' + lines,
                        { from: 'memos', memories: memHits.slice(0, 5), game, hint: '这是关于用户的记忆，不是游戏攻略' },
                    );
                }
                return VC.readonly('知识库里没有「' + (game || '当前环境') + '」的条目，记忆里也没有相关记录（两层都空）', {
                    hint: '可以往 pet-runtime/knowledge/rules/ 加一个 <游戏名>.json',
                    game, from: 'none',
                });
            }
            // 四层仲裁（续）：命中「通用桌面」= 工具说明兜底，**不含用户事实**。
            //   这种时候应该再补一层 MemOS —— 否则「主人喜欢什么猫」会被通用键位表糊弄过去。
            const isGenericLayer = /通用/.test(String(kn.game || '')) || /通用/.test(String(kn.source || ''));
            if (isGenericLayer) {
                let memHits2 = [];
                try {
                    const body2 = JSON.stringify({ query: kquery || game, user_id: 'feiniu_default', limit: 4 });
                    const mem2 = await new Promise((resolve) => {
                        try {
                            const req = require('http').request({
                                host: '127.0.0.1', port: 8003, path: '/search', method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body2) }, timeout: 12000,
                            }, (res) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(null); } }); });
                            req.on('error', () => resolve(null));
                            req.setTimeout(12000, () => { try { req.destroy(); } catch (e) { /* ignore */ } resolve(null); });
                            req.write(body2); req.end();
                        } catch (e) { resolve(null); }
                    });
                    memHits2 = (mem2 && Array.isArray(mem2.memories)) ? mem2.memories.filter((m) => Number(m.similarity || 0) >= 0.35) : [];
                } catch (e) { try { __silentAudit.audit('game-control:knowledge-memos-supplement', e); } catch (e2) { /* ignore */ } }
                if (memHits2.length) {
                    const memLines = memHits2.slice(0, 4).map((m) => '· ' + String(m.content || '').slice(0, 80)).join('\n');
                    return VC.readonly(
                        kn.promptText + '\n\n【我的记忆（关于用户，来自 MemOS）】\n' + memLines,
                        {
                            game: kn.game, source: kn.source, from: 'knowledge+memos',
                            confidence: kn.confidence, live: kn.live,
                            memosHits: memHits2.slice(0, 4),
                            retrieval: kn.retrievalTrace || null, costMs: ms,
                        },
                    );
                }
            }
            return VC.readonly(kn.promptText, {
                game: kn.game,
                source: kn.source,
                confidence: kn.confidence,
                live: kn.live,
                from: 'knowledge',
                retrieval: kn.retrievalTrace || null,
                retrievalUs: kn.retrievalTotalUs || null,
                costMs: ms,
            });
        }
        case 'skill': {
            // 技能库（2026-11-09 三十五轮新增，P1）。
            // arg：「子命令 [参数]」，如：
            //   `skill list`                  列出已保存的技能（带可靠度）
            //   `skill save <名字>`            把最近一次成功的动作序列存成技能
            //   `skill run <名字>`             回放（检查前置场景 → 执行 → 验证后置）
            //   `skill forget <名字>`           删掉（软删，留审计）
            const SK = require('./skill-library.js');
            const sp = String(a || '').split(/\s+/).filter(Boolean);
            const sub = (sp.shift() || 'list').toLowerCase();
            const sarg = sp.join(' ');
            // E7（2026-11-22）：技能生命周期。不新增工具，只在 skill 的 action 里加子命令：
            //   skill health / health <名字> / health --revive|--quarantine|--dormant <名字>
            if (sub === 'health' || sub === 'revive' || sub === 'quarantine' || sub === 'dormant') {
                const SH = require('../../../js/core/skill-health.js');
                const toks = sarg.split(/\s+/).filter(Boolean);
                let op = 'report';
                let target = '';
                if (sub !== 'health') {
                    op = sub;
                    target = sarg.trim();
                } else if (toks[0] === '--revive' || toks[0] === 'revive') {
                    op = 'revive'; target = toks.slice(1).join(' ');
                } else if (toks[0] === '--quarantine' || toks[0] === 'quarantine') {
                    op = 'quarantine'; target = toks.slice(1).join(' ');
                } else if (toks[0] === '--dormant' || toks[0] === 'dormant') {
                    op = 'dormant'; target = toks.slice(1).join(' ');
                } else {
                    target = toks.join(' ');
                }

                const known = (name) => (SK.listSkills() || []).some((s) => s && s.name === name);
                if (op === 'revive' || op === 'quarantine' || op === 'dormant') {
                    if (!target) return VC.notSent('要指定技能名：skill health --' + op + ' <名字>', { nextIfFailed: '先用 skill health 看有哪些技能/状态' });
                    if (!known(target)) return VC.notSent('没有这个技能：' + target, { nextIfFailed: '先用 skill list 看技能库' });
                    const r = op === 'revive' ? SH.revive(target) : SH.forceState(target, op);
                    if (!r.ok) return VC.notSent('操作失败：' + (r.error || '未知原因'));
                    const label = op === 'revive' ? '已复活' : (op === 'quarantine' ? '已隔离' : '已降为休眠');
                    return VC.confirmed(label + '技能「' + target + '」（连续失败已' + (op === 'revive' ? '清零' : '保持') +
                        '，状态 ' + r.health.state + '）', { health: SH.getHealth({ skillNames: (SK.listSkills() || []).map((s) => s.name) }) });
                }

                const report = SH.getHealth({ skillNames: (SK.listSkills() || []).map((s) => s.name) });
                const fmt = (s) => {
                    const rate = (s.verifiedRate === null || s.verifiedRate === undefined) ? '-' : Math.round(s.verifiedRate * 100) + '%';
                    const idle = (s.idleDays === null || s.idleDays === undefined) ? '从未' : s.idleDays + ' 天前';
                    const why = (s.state !== 'active' && s.stateReason) ? '（' + s.stateReason + '）' : '';
                    return '· [' + s.state + '] ' + s.name + ' —— 试 ' + s.tries + ' / 成 ' + s.ok +
                        ' / 验证率 ' + rate + ' / 连败 ' + s.consecutiveFails + ' / 最后 ' + idle + why;
                };
                const fmtAct = (s) => {
                    const rate = (s.verifiedRate === null || s.verifiedRate === undefined) ? '-' : Math.round(s.verifiedRate * 100) + '%';
                    return '· [' + s.state + '] ' + s.action + ' —— 试 ' + s.tries + ' / 成 ' + s.ok + ' / 验证率 ' + rate + ' / 连败 ' + s.consecutiveFails;
                };
                if (target) {
                    const one = report.skills.find((s) => s.name === target);
                    if (!one) return VC.notSent('没有这个技能的健康记录：' + target, { nextIfFailed: 'skill health 看全部；或 skill list 看技能库' });
                    return VC.readonly('技能「' + target + '」健康度：\n' + fmt(one) +
                        (one.lastError ? '\n  最近错误：' + one.lastError : '') +
                        (one.state === 'quarantined' ? '\n  复活：skill health --revive ' + target : ''), { health: one });
                }
                const lines = report.skills.map(fmt);
                const actLines = report.actions.slice(0, 8).map(fmtAct);
                const text = '技能健康度（' + report.counts.skills + ' 个技能：' +
                    report.counts.quarantined + ' 隔离 / ' + report.counts.dormant + ' 休眠）：\n' +
                    (lines.length ? lines.join('\n') : '（技能库是空的）') +
                    (actLines.length ? '\n\n动作健康度（按次数前 8）：\n' + actLines.join('\n') : '');
                return VC.readonly(text, { health: report });
            }
            if (sub === 'list') {
                const list = SK.listSkills();
                if (!list.length) {
                    return VC.readonly('技能库还是空的。完成一个动作序列后说「skill save <名字>」把它存下来', { skills: [] });
                }
                const lines = list.map((s) => {
                    const rel = s.reliability || {};
                    const rate = Number.isFinite(rel.mean) ? Math.round(rel.mean * 100) + '%' : '?';
                    return '· ' + s.name + '（' + (s.steps || []).length + ' 步，成功率 ' + rate + '，试过 ' + (rel.total || 0) + ' 次' +
                        (rel.verdict === 'unreliable' ? ' ⚠不可靠' : '') + '）—— ' + String(s.description || '').slice(0, 60);
                });
                return VC.readonly('技能库（' + list.length + ' 个）：\n' + lines.join('\n'), { skills: list.map((s) => ({ name: s.name, steps: (s.steps || []).length, reliability: s.reliability })) });
            }
            if (sub === 'save') {
                if (!sarg) throw new Error('要给技能起个名字：skill save <名字>');
                // 2026-11-14 五十三轮（审计）：尾部的数字是「回看几步」（schema 的 steps 参数）。
                //   原来整段被当成技能名 → 名字变成「我的技能 5」、步数参数当描述。
                const mm = sarg.match(/^(.*?)\s+(\d{1,2})$/);
                const skillName = mm ? mm[1].trim() : sarg;
                const maxSteps = mm ? Math.max(1, Math.min(30, Number(mm[2]))) : 0;
                if (!skillName) throw new Error('技能名不能只有数字：skill save <名字> [步数]');
                const r = SK.saveSkillFromHistory(skillName, maxSteps ? { maxSteps } : {});
                if (!r.ok) {
                    return VC.notSent('保存失败：' + (r.error || '未知原因'), {
                        nextIfFailed: r.hint || '先做几个成功动作再 save；click_element/som_click/click_text 依赖编号不能进技能',
                    });
                }
                // ⚠ 2026-11-09：原来只带 skill + tier，把 steps/deduped/updated/risky 都丢了
                //   （又是「白名单透传」那个病）。all 字段都带上。
                return VC.confirmed('已保存技能「' + sarg + '」（' + r.steps + ' 步）' +
                        (r.deduped ? '，步骤和已有的一样，只更新了计数' : (r.updated ? '，已覆盖旧版本' : '')) +
                        (r.risky ? ' ⚠含危险动作' : ''), {
                    skill: r.skill,
                    steps: r.steps,
                    deduped: r.deduped === true,
                    updated: r.updated === true,
                    risky: r.risky === true,
                    tier: 'L2',
                });
            }
            if (sub === 'run') {
                if (!sarg) throw new Error('要跑哪个技能：skill run <名字>');
                // ⚠ 红队 R6：技能回放以前每步都不过闸（外层只扣 1 次令牌，里面最多几十步
                //   真实输入）。现在按步数预扣游戏闸配额；查不到技能就让 runSkill 自己报。
                const one = (SK.listSkills() || []).find((x) => x && x.name === sarg);
                const nSkSteps = one ? Number((one.steps || []).length) || 0 : 0;
                const skChargeErr = preChargeTokens(nSkSteps, true);
                if (skChargeErr) {
                    return VC.notSent(skChargeErr, {
                        error: '技能回放配额不足', skill: sarg, steps: nSkSteps,
                        nextIfFailed: '等几十秒再跑（游戏闸 600/分），或把技能拆短',
                    });
                }
                const r = await SK.runSkill(sarg, { runGameAction });
                return r;
            }
            if (sub === 'forget') {
                if (!sarg) throw new Error('要删哪个技能：skill forget <名字>');
                const r = SK.forgetSkill(sarg);
                return r.ok ? VC.confirmed('已删掉技能「' + sarg + '」') : VC.notSent('没这个技能：' + sarg);
            }
            return VC.notSent('skill 子命令：list / save <名字> / run <名字> / forget <名字>');
        }
        default:
            throw new Error('不认识的直控动作：' + action + '（可用：list_windows / focus_window / press_key / hold_key / click_at / click_text / visual_click / type_text / volume / knowledge / skill / wgc_hash / wgc_shot）');
    }
}

// ── 对外入口：串行锁（红队 S4）────────────────────────────────────────────
// 只读动作（list_windows / knowledge / recent_actions / edit_text / wgc_hash…）
// **不排队**，长任务（som_snapshot 90s）不会把查询堵死。
//
// 2026-11-21：外面再包两层「不改变动作语义」的韧性（设计-操控层提升 P0-1 / P2-9）：
//   · vetoCode=1001（前台被占，动作没发出去）→ 按同 pid focus 一次 → 只重发一次
//   · extraCfg.verify === true → 动作前后 UIA 摘要对比，effect 写回同一份契约
async function runGameAction(action, arg, focus, semanticProfiles, extraCfg) {
    const act = String(action || '');
    const runOnce = () => (needsDesktopLock(act, arg)
        ? withDesktopLock(() => _runGameAction(act, arg, focus, semanticProfiles, extraCfg))
        : _runGameAction(act, arg, focus, semanticProfiles, extraCfg));

    const wantVerify = !!(extraCfg && extraCfg.verify === true);
    const verifyTarget = String(focus || (act === 'click_element' ? UIA_SNAPSHOT_STATE.title : '') || '');
    let before = null;
    if (wantVerify) {
        try { before = await uiSummaryFor(verifyTarget); } catch (e) { before = { ok: false, title: verifyTarget }; }
    }

    let res = await runOnce();

    if (res && res.vetoCode === VETO.FOCUS_LOST && AUTO_FOCUS_ACTIONS.has(act) && res.autoFocus !== true) {
        // 第一次结果复用（不重复执行）；autoFocus 内部只调一次 runOnce → 总共最多 2 次。
        res = await withAutoFocusRetry(
            (attempt) => (attempt === 1 ? Promise.resolve(res) : runOnce()),
            { focus, enabled: true },
        );
    }

    if (wantVerify) {
        let after = null;
        try { after = await uiSummaryFor(verifyTarget || (act === 'click_element' ? UIA_SNAPSHOT_STATE.title : '')); } catch (e) { after = { ok: false, title: verifyTarget }; }
        res = applyUiVerify(res, before, after);
    }
    // D2（2026-11-22）：经验记账放在所有验证/自动重试之后 —— 记的是**最终结论**，
    // 不参与本次动作的成败判定，也不影响返回对象。
    if (ROUTE_EXPERIENCE_ACTIONS.has(act)) recordRouteOutcome(act, focus, res);
    return res;
}

/**
 * 测试注入口（只给 _probe/test-click-guard.cjs 用；运行时代码从不读它）。
 * 目的是让「三条点击路径都经过守卫、且守卫在执行前」能被纯 Node 断言，
 * 不需要真机快照/真鼠标事件。
 */
const __testHooks = {
    guardClickTarget,
    clickAt,
    uiaElementAction,
    pickSnapshotTarget,
    setUiaSnapshotState(s) { Object.assign(UIA_SNAPSHOT_STATE, s || {}); },
    setSomState(s) { Object.assign(SOM_STATE, s || {}); },
    // 2026-11-24：快照↔编号绑定校验的纯函数入口（测试不需要真机快照）
    checkSnapshotBinding,
    somClickMaxAgeMs,
    // 2026-11-25 P2-7：标题匹配收紧 + pid/hwnd 撞车探测（测试注入实时窗口表）
    winTitleMatches: _winTitleMatches,
    liveHwndsForCollisionCheck,
    setLiveHwnds(list) { _liveHwndsOverride = Array.isArray(list) ? list.slice() : null; },
    somStickyMaxAgeMs: SOM_STICKY_MAX_AGE_MS,
    snapshotMaxAgeMs: SNAPSHOT_MAX_AGE_MS,
    setOwnWindows(list) { _ownWinCache.list = Array.isArray(list) ? list : []; _ownWinCache.at = Date.now(); },
    // D2（2026-11-22）：经验路由接线检查用的纯入口（记账/取缓存/静态路由）
    expNoteApp: _expNoteApp,
    expAppFor: _expAppFor,
    guiRoute,
    recordRouteOutcome,
    routeExperienceStats,
    reset() {
        Object.assign(UIA_SNAPSHOT_STATE, {
            title: '', items: [], hwnd: 0, pid: 0, rect: null,
            sid: 0, at: 0, targetHwnd: 0, targetTitle: '',
        });
        Object.assign(SOM_STATE, {
            title: '', hwnd: 0, pid: 0, marks: [], rect: null,
            sid: 0, at: 0, targetHwnd: 0, targetTitle: '',
        });
        _ownWinCache.list = [];
        _ownWinCache.at = 0;
        _expAppByPid.clear();
        _expAppByTitle.clear();
        _liveHwndsOverride = null;
    },
};

/** D2：经验路由的可观测快照（doctor / 探针）。失败返回 null，绝不抛。 */
function routeExperienceStats() {
    try { return routeExperience.stats(); } catch (e) { return null; }
}

/** D2：插件开关入口（dispatch/index.js 在 onInit 里按 plugin_config 调用）。 */
function setRouteExperienceEnabled(v) {
    try { return routeExperience.setEnabled(v !== false); } catch (e) { return false; }
}

module.exports = {
    runGameAction, rateGate, rateGateGame, toSendKeys, escapeSendKeys, SEMANTIC_PROFILES_BUILTIN, SEMANTIC_GENERIC,
    baselineJitter, uiaTreeSignature, actAndVerifySmart, VETO, regionDelta, coreStats, coreUiaAction, windowOp, notifyOverlay,
    // 操控层韧性（2026-11-21）：单测用纯函数 + 可注入依赖的重试/稳定等待
    normalizeUiName, stripAccelSuffix, matchUiNames, fgVerdict, ownerRelationVerdict, gateElementState, classifyDialogElement,
    elementFallbackPlan, waitUiStable, applyUiVerify, withAutoFocusRetry, autoFocusTarget, resolveWindowInfo,
    pickBestWindow, windowPickScore,
    // 操控层一致性（2026-11-21 P1/P2）：唯一窗口解析 / 多屏并集 / 唯一按键策略 / 可观测计数
    resolveTargetHwnd, pickWindowForTarget, postKeysTo, titleMatchKind,
    // 2026-11-25 P1-1：游戏按键路由（纯函数，单测直接打）
    detectGameWindow, decideKeyRoute, vkFor,
    screenRectsFromDisplays, pointOnAnyScreen, assertScreenPoint, screenRects,
    KEY_POLICY_RULES, KEY_POLICY_DENY_MSG, KEY_POLICY_SOURCE, keyPolicyViolation, normalizeKeyName, controlStats, bumpControlStat,
    uiaScan, uiaElementAction, uiaScanScript, assertTargetFocused, pickSnapshotTarget, guardClickTarget, checkSnapshotBinding,
    // D2（2026-11-22）：经验路由（只重排候选顺序；统计可观测）
    guiRoute, recordRouteOutcome, routeExperienceStats, setRouteExperienceEnabled,
    __testHooks,
};
