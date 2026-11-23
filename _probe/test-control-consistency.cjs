#!/usr/bin/env node
/**
 * _probe/test-control-consistency.cjs — 操控层一致性回归（2026-11-21 审计 P1/P2）
 *
 * 覆盖 5 条「同一件事在不同层有不同答案」的问题：
 *   ① 多显示器坐标：只按主屏判越界 → 副屏/负坐标被误拒；
 *   ② OCR 全屏只抓主屏（ocr_find.py 缺 all_screens=True）；
 *   ③ 输入黑名单三套不一致（JS/Rust/pwsh）→ ctrl+shift+esc 走 Rust 真开任务管理器；
 *   ④ window_op 的 min/restore/close 不回读 → 没生效也报 ok；
 *   ⑤ 六套找窗口分叉 → 同名窗口各选各的。
 *
 * 约定：
 *   · 不点击桌面、不移动用户窗口。点击路径的后端一律被桩拦截；
 *   · Rust 回读用**自建**的临时记事本窗口（唯一文件名，标题不会和用户窗口撞），
 *     测完 close 并删临时文件；
 *   · 优先用 target/stage/release/pet-core.exe（本次修复的产物），
 *     fallback 到 target/release（旧产物 —— 此时回读/黑名单断言会红，正是修复前应有的表现）。
 *
 * 判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const GC = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch', 'game-control.js');
const DISPATCH_INDEX = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch', 'index.js');
const RUST = path.join(ROOT, 'pet-core', 'src', 'native.rs');
const OCR = path.join(ROOT, 'pet-runtime', 'tools', 'ocr_find.py');
const PS1 = path.join(ROOT, 'pet-runtime', 'tools', 'send-input.ps1');
const POLICY_JSON = path.join(ROOT, 'pet-runtime', 'tools', 'key-policy.json');
const PY = 'py';
const CORE_STAGE = path.join(ROOT, 'pet-core', 'target', 'stage', 'release', 'pet-core.exe');
const CORE_OLD = path.join(ROOT, 'pet-core', 'target', 'release', 'pet-core.exe');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1;
    failures.push(name + (detail ? '：' + detail : ''));
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 显示器 mock（必须在 require game-control 之前装好；它在调用时才 require('electron')）──
const MOCK_DISPLAYS = [
    { id: 1, label: 'primary', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 2, label: 'right', bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 3, label: 'left', bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
];
const origLoad = Module._load;
Module._load = function (request) {
    if (request === 'electron') {
        return {
            screen: {
                getAllDisplays: () => MOCK_DISPLAYS,
                getPrimaryDisplay: () => MOCK_DISPLAYS[0],
            },
            app: { getPath: () => os.tmpdir() },
        };
    }
    return origLoad.apply(this, arguments);
};

// ── 后端桩：spawn 先 throw（防止任何真实输入/进程启动），execFile 记数并按需伪造 ──
const realSpawn = cp.spawn;
const realExecFile = cp.execFile;
const realExecFileSync = cp.execFileSync;
const calls = { spawn: 0, execFile: 0, execFileSync: 0 };
const spawnCalls = [];
let spawnMode = 'throw';           // throw | record
let windowsFixture = null;         // {cmd:'windows'} 的伪造响应
let lastPsScript = '';

function fakeSpawn(file, args) {
    calls.spawn += 1;
    spawnCalls.push({ file, args: args || [] });
    if (spawnMode === 'record') {
        const script = String((args && args[args.length - 1]) || '');
        lastPsScript = script;
        const handlers = {};
        const child = {
            stdout: { on(ev, cb) { handlers['out:' + ev] = cb; }, setEncoding() {} },
            stderr: { on(ev, cb) { handlers['err:' + ev] = cb; }, setEncoding() {} },
            on(ev, cb) { handlers[ev] = cb; },
            kill() {},
        };
        process.nextTick(() => {
            if (handlers.out_data) handlers.out_data('posted');
            if (handlers.close) handlers.close(0);
        });
        return child;
    }
    throw new Error('BACKEND-SPAWN-BLOCKED');
}

function fakeExecFile(file, args, opts, cb) {
    calls.execFile += 1;
    const callback = typeof cb === 'function' ? cb : (typeof opts === 'function' ? opts : null);
    const child = {
        stdin: {
            end(data) {
                let payload = null;
                try { payload = JSON.parse(String(data || '{}')); } catch (e) { payload = null; }
                if (payload && payload.cmd === 'windows' && windowsFixture) {
                    const f = String(payload.filter || '').toLowerCase();
                    const list = windowsFixture
                        .filter((w) => !f || String(w.title || '').toLowerCase().includes(f))
                        .slice(0, Number(payload.max) || 200);
                    const body = JSON.stringify({ ok: true, windows: list });
                    process.nextTick(() => callback && callback(null, body, ''));
                } else {
                    const body = JSON.stringify({ ok: false, error: 'BACKEND-EXECFILE-BLOCKED' });
                    process.nextTick(() => callback && callback(null, body, ''));
                }
            },
        },
        stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {},
    };
    return child;
}

cp.spawn = fakeSpawn;
cp.execFile = fakeExecFile;
cp.execFileSync = function () { calls.execFileSync += 1; throw new Error('BACKEND-EXECFILESYNC-BLOCKED'); };

let g = null;
let loadErr = null;
try { g = require(GC); } catch (e) { loadErr = e; }
// 注意：不恢复 Module._load —— game-control 在**调用时**才 require('electron')，
// screen 相关断言依赖这个 mock 一直生效。

/** 直接跑 pet-core（一次性 CLI 协议：stdin 一行 JSON）。 */
function coreCall(bin, req, timeout) {
    const out = realExecFileSync(bin, [], {
        input: JSON.stringify(req), timeout: timeout || 10000, encoding: 'utf8', windowsHide: true,
    });
    return JSON.parse(String(out || '{}'));
}
function coreBin() {
    if (process.env.PET_CORE_BIN && fs.existsSync(process.env.PET_CORE_BIN)) return process.env.PET_CORE_BIN;
    if (fs.existsSync(CORE_STAGE)) return CORE_STAGE;
    return fs.existsSync(CORE_OLD) ? CORE_OLD : '';
}

(async () => {
    console.log('== ① 多显示器坐标（JS click_at / mouse / scroll）==');
    if (loadErr) {
        ok('game-control.js 可加载', false, String(loadErr.message || loadErr));
    } else {
        // 纯函数：DIP × scaleFactor；并集判定。
        const rects = typeof g.screenRectsFromDisplays === 'function'
            ? g.screenRectsFromDisplays(MOCK_DISPLAYS) : null;
        ok('screenRectsFromDisplays 导出且换算为物理像素', Array.isArray(rects) && rects.length === 3,
            Array.isArray(rects) ? JSON.stringify(rects) : '未导出（修复前）');
        if (Array.isArray(rects) && rects.length === 3) {
            const right = rects.find((r) => r.x === 1920);
            ok('右侧副屏 rect = 1920..3840', !!right && right.w === 1920, JSON.stringify(right || null));
            const left = rects.find((r) => r.x === -1920);
            ok('左侧副屏 rect 支持负 x', !!left && left.x === -1920, JSON.stringify(left || null));
        }
        // 分屏 DPI：1280×720 @1.5 → 1920×1080 物理像素
        const hi = typeof g.screenRectsFromDisplays === 'function'
            ? g.screenRectsFromDisplays([{ bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 }]) : [];
        ok('DIP×scaleFactor（1280×720@1.5 → 1920×1080）',
            hi.length === 1 && hi[0].w === 1920 && hi[0].h === 1080, JSON.stringify(hi));

        const onAny = typeof g.pointOnAnyScreen === 'function' ? g.pointOnAnyScreen : null;
        if (onAny && Array.isArray(rects)) {
            ok('副屏坐标 (2500,500) 通过', !!onAny(2500, 500, rects));
            ok('负坐标 (-100,300)（左副屏）通过', !!onAny(-100, 300, rects));
            ok('主屏坐标 (500,500) 通过', !!onAny(500, 500, rects));
            ok('主屏外 (5000,5000) 仍拒', !onAny(5000, 5000, rects));
            ok('负方向更远 (-5000,5000) 仍拒', !onAny(-5000, 5000, rects));
        } else {
            ok('pointOnAnyScreen 导出', false, '未导出（修复前）');
        }

        // 集成：click_at 走真实前置检查（后端被桩拦截，不会真点）。
        const tryClick = async (spec) => {
            const before = { spawn: calls.spawn, execFile: calls.execFile, execFileSync: calls.execFileSync };
            try {
                const res = await g.runGameAction('click_at', spec, null, null, null);
                return { threw: false, res, before };
            } catch (e) {
                return { threw: true, error: String((e && e.message) || e), before };
            }
        };
        const rRight = await tryClick('2500,500');
        const errRight = rRight.threw ? rRight.error : '';
        ok('click_at 副屏 (2500,500) 不再报「超出屏幕范围」', !/超出屏幕范围/.test(errRight),
            rRight.threw ? errRight.slice(0, 160) : '未抛越界错（已进入后端链路）');
        ok('click_at 副屏坐标确实进入了后端链路',
            (calls.spawn - rRight.before.spawn) + (calls.execFile - rRight.before.execFile) + (calls.execFileSync - rRight.before.execFileSync) > 0,
            'spawn+' + (calls.spawn - rRight.before.spawn) + ' execFile+' + (calls.execFile - rRight.before.execFile));

        const rOut = await tryClick('5000,5000');
        const errOut = rOut.threw ? rOut.error : '';
        ok('click_at 主屏外 (5000,5000) 仍被前置拒绝', /超出屏幕范围/.test(errOut), errOut.slice(0, 160));
        ok('越界时后端 0 调用',
            (calls.spawn - rOut.before.spawn) + (calls.execFile - rOut.before.execFile) + (calls.execFileSync - rOut.before.execFileSync) === 0);

        // mouse/drag 也走同一套：副屏终点不被误拒（后端被拦，只看是否报越界）。
        const beforeDrag = { spawn: calls.spawn, execFile: calls.execFile };
        let dragErr = '';
        try { await g.runGameAction('mouse', 'drag 2500,500,2600,600', null, null, null); } catch (e) { dragErr = String((e && e.message) || e); }
        ok('mouse drag 副屏终点不报越界', !/超出屏幕范围/.test(dragErr), dragErr.slice(0, 160));
        ok('mouse drag 副屏路径进入后端',
            (calls.spawn - beforeDrag.spawn) + (calls.execFile - beforeDrag.execFile) > 0);

        const stats = typeof g.controlStats === 'function' ? g.controlStats() : null;
        ok('坐标检查可观测（controlStats.coordChecks/coordRejected）',
            !!stats && stats.coordChecks > 0 && stats.coordRejected > 0,
            stats ? JSON.stringify({ checks: stats.coordChecks, rejected: stats.coordRejected, displays: stats.displayCount }) : '未导出');
    }

    console.log('\n== ② OCR 全屏取像（ocr_find.py）==');
    const ocrSrc = fs.readFileSync(OCR, 'utf8');
    ok('全屏路径使用 ImageGrab.grab(all_screens=True)', /ImageGrab\.grab\(\s*all_screens\s*=\s*True\s*\)/.test(ocrSrc));
    ok('不再有裸 ImageGrab.grab()', !/ImageGrab\.grab\(\s*\)/.test(ocrSrc));
    ok('返回虚拟屏原点（负坐标副屏可换算）', /SM_XVIRTUALSCREEN/.test(ocrSrc) && /virtual_screen/.test(ocrSrc));
    let pySyntax = '';
    try {
        realExecFileSync(PY, ['-I', '-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1])', OCR],
            { timeout: 60000, windowsHide: true, encoding: 'utf8' });
    } catch (e) { pySyntax = String((e && e.message) || e).slice(0, 200); }
    ok('ocr_find.py 语法检查通过', pySyntax === '', pySyntax);

    console.log('\n== ③ 输入黑名单唯一策略表（JS + Rust）==');
    const jsRules = loadErr ? null : g.KEY_POLICY_RULES;
    ok('JS 导出 KEY_POLICY_RULES 策略表', Array.isArray(jsRules) && jsRules.length === 4,
        Array.isArray(jsRules) ? JSON.stringify(jsRules) : '未导出（修复前）');
    const rustSrc = fs.readFileSync(RUST, 'utf8');
    // 解析 Rust 的 KEY_POLICY_RULES 表：(&["alt"], &["f4", "tab", "space"]) 形式
    const region = (rustSrc.match(/\/\/ #region key-policy-table([\s\S]*?)\/\/ #endregion key-policy-table/) || [])[1] || '';
    const rustRules = [];
    // 只解析「一条规则一行」的条目（避免命中 const 类型声明里的 (&[&str], &[&str])）
    const ruleRe = /^[ \t]+\(&\[([^\]]*)\],\s*&\[([^\]]*)\]\),[ \t]*$/gm;
    let mRule;
    while ((mRule = ruleRe.exec(region)) !== null) {
        const grab = (s) => (s.match(/"([^"]*)"/g) || []).map((x) => x.slice(1, -1));
        rustRules.push({ require: grab(mRule[1]), any: grab(mRule[2]) });
    }
    ok('Rust 解析出 KEY_POLICY_RULES 策略表', rustRules.length === 4, JSON.stringify(rustRules));
    const canon = (rules) => JSON.stringify((rules || []).map((r) => ({
        require: [...(r.require || [])].sort(),
        any: [...(r.any || [])].sort(),
    })));
    ok('JS 与 Rust 策略表内容完全一致', canon(jsRules) === canon(rustRules),
        'JS=' + canon(jsRules) + ' Rust=' + canon(rustRules));

    const jsDeny = /该组合被安全策略拒绝/.test(fs.readFileSync(GC, 'utf8'));
    const rustDeny = /该组合被安全策略拒绝/.test(rustSrc);
    ok('两侧都返回「该组合被安全策略拒绝」', jsDeny && rustDeny, 'js=' + jsDeny + ' rust=' + rustDeny);

    // ── 第三份黑名单：pwsh send-input.ps1（2026-11-21 P2 补）────────────────
    // 病根：这份表原来内联在 Resolve-Spec 里（$hasAlt/$isF4…），JS/Rust 改动它不知道。
    // 现在统一读 pet-runtime/tools/key-policy.json；测试把 **JSON / JS / Rust / PS** 四份集合做相等比较。
    let policyFile = null;
    let policyErr = '';
    try { policyFile = JSON.parse(fs.readFileSync(POLICY_JSON, 'utf8')); } catch (e) { policyErr = String((e && e.message) || e).slice(0, 180); }
    ok('key-policy.json 存在且是唯一策略源', !!policyFile && Array.isArray(policyFile.rules) && policyFile.rules.length === 4,
        policyErr || JSON.stringify(policyFile && policyFile.rules));
    if (policyFile && Array.isArray(policyFile.rules)) {
        const canonFile = canon(policyFile.rules);
        ok('key-policy.json 与 JS 策略表一致', canonFile === canon(jsRules),
            'JSON=' + canonFile + ' JS=' + canon(jsRules));
        ok('key-policy.json 与 Rust 策略表一致', canonFile === canon(rustRules),
            'JSON=' + canonFile + ' Rust=' + canon(rustRules));
    }

    const ps1Src = fs.readFileSync(PS1, 'utf8');
    ok('send-input.ps1 从 key-policy.json 读取策略（不再内联组合表）',
        /key-policy\.json/.test(ps1Src) && !/\$hasAlt\s*=/.test(ps1Src),
        /key-policy\.json/.test(ps1Src) ? '有 JSON 引用' : '仍是内联表');
    // 行为级：PS 自己打印它加载到的策略表（不注入任何按键）
    let psPolicy = null;
    let psPolicyErr = '';
    try {
        const out = realExecFileSync('pwsh', ['-NoProfile', '-File', PS1, '-PrintPolicy'],
            { timeout: 25000, encoding: 'utf8', windowsHide: true });
        const txt = String(out || '').trim();
        psPolicy = JSON.parse(txt);
        if (psPolicy && Array.isArray(psPolicy.rules)) psPolicy = psPolicy.rules;
    } catch (e) { psPolicyErr = String((e && e.message) || e).slice(0, 180); }
    ok('PWSh -PrintPolicy 输出策略表', Array.isArray(psPolicy) && psPolicy.length === 4,
        psPolicyErr || JSON.stringify(psPolicy));
    if (Array.isArray(psPolicy) && policyFile && Array.isArray(policyFile.rules)) {
        ok('pwsh 策略表与 key-policy.json 完全一致', canon(psPolicy) === canon(policyFile.rules),
            'PS=' + canon(psPolicy) + ' JSON=' + canon(policyFile.rules));
    }
    // 行为级：同一批拒绝/放行组合在 PS 侧也必须一致（-DryRun 只解析、不注入）
    const psDry = (keys) => {
        try {
            const out = realExecFileSync('pwsh', ['-NoProfile', '-File', PS1, '-Keys', keys, '-DryRun'],
                { timeout: 25000, encoding: 'utf8', windowsHide: true });
            return JSON.parse(String(out || '').trim());
        } catch (e) { return { ok: false, error: 'SPAWN:' + String((e && e.message) || e).slice(0, 120) }; }
    };
    for (const combo of ['alt+f4', 'alt+tab', 'alt+space', 'ctrl+alt+del', 'ctrl+esc', 'ctrl+shift+esc', 'win', 'win+r']) {
        const r = psDry(combo);
        ok('PWSh 拒绝 ' + combo, r && r.ok === false && /blocked/.test(String(r.error || '')),
            JSON.stringify(r).slice(0, 160));
    }
    for (const combo of ['ctrl+s', 'shift+tab', 'w']) {
        const r = psDry(combo);
        ok('PWSh 放行 ' + combo, r && r.ok === true && Array.isArray(r.vks) && r.vks.length > 0,
            JSON.stringify(r).slice(0, 160));
    }

    if (!loadErr) {
        const expectBlock = ['alt+f4', 'alt+tab', 'alt+space', 'ctrl+alt+del', 'ctrl+esc', 'ctrl+shift+esc', 'win', 'win+r'];
        for (const combo of expectBlock) {
            let msg = '';
            try { g.toSendKeys(combo); } catch (e) { msg = String((e && e.message) || e); }
            ok('JS 拒绝 ' + combo, /该组合被安全策略拒绝/.test(msg), msg || '没有拒绝');
        }
        for (const combo of ['ctrl+s', 'shift+tab', 'w']) {
            let msg = '';
            try { g.toSendKeys(combo); } catch (e) { msg = String((e && e.message) || e); }
            ok('JS 放行 ' + combo, msg === '', msg);
        }
        for (const combo of ['control+alt+delete', 'lctrl+ralt+delete', 'lwin+r']) {
            let msg = '';
            try { g.toSendKeys(combo); } catch (e) { msg = String((e && e.message) || e); }
            ok('JS 别名归一后仍拒绝 ' + combo, /该组合被安全策略拒绝/.test(msg), msg || '没有拒绝');
        }
        const stats = typeof g.controlStats === 'function' ? g.controlStats() : null;
        ok('黑名单拒绝可计数', !!stats && stats.keyPolicyRejects >= expectBlock.length,
            stats ? 'keyPolicyRejects=' + stats.keyPolicyRejects : '未导出');
    }

    const bin = coreBin();
    if (!bin) {
        ok('pet-core 二进制存在（Rust 黑名单/回读断言）', false, 'target/stage 与 target/release 都没有');
    } else {
        const source = bin === CORE_STAGE ? 'stage' : (bin === CORE_OLD ? 'release(旧)' : bin);
        console.log('  · 使用 pet-core：' + bin + '（' + source + '）');
        const dry = (keys) => coreCall(bin, { cmd: 'keys', keys, dry_run: true }, 8000);
        for (const combo of ['alt+f4', 'alt+tab', 'alt+space', 'ctrl+alt+del', 'ctrl+esc', 'ctrl+shift+esc', 'win', 'win+r', 'lctrl+ralt+delete']) {
            const r = dry(combo);
            ok('Rust 拒绝 ' + combo, r.ok === false && /该组合被安全策略拒绝/.test(String(r.error || '')),
                JSON.stringify(r).slice(0, 180));
        }
        for (const combo of ['ctrl+s', 'shift+tab', 'w']) {
            const r = dry(combo);
            ok('Rust 放行 ' + combo, r.ok === true, JSON.stringify(r).slice(0, 160));
        }
    }

    console.log('\n== ④ window_op 的 min/restore/close 回读 ==');
    // 静态：失败分支必须存在且解释原因（close 要提示未保存内容）。
    ok('Rust min 回读断言存在', /min 没生效/.test(rustSrc) && /IsIconic/.test(rustSrc));
    ok('Rust restore 回读断言存在', /restore 没生效/.test(rustSrc));
    ok('Rust close 轮询 IsWindow 且提示未保存内容', /close 没生效/.test(rustSrc) && /IsWindow/.test(rustSrc) && /未保存/.test(rustSrc));

    if (bin) {
        // 自建测试窗口：唯一文件名 → 标题不会撞用户窗口；不写入/不编辑 → 关掉不弹保存框。
        const tag = 'control-consistency-' + process.pid + '-' + Date.now();
        const tmpFile = path.join(os.tmpdir(), tag + '.txt');
        fs.writeFileSync(tmpFile, 'test window for control consistency\n', 'utf8');
        let myHwnd = 0;
        let spawnedChild = null;
        try {
            spawnedChild = realSpawn('C:\\Windows\\System32\\notepad.exe', [tmpFile], {
                detached: true, stdio: 'ignore', windowsHide: false,
            });
            spawnedChild.unref();
            for (let i = 0; i < 24 && !myHwnd; i += 1) {
                await sleep(400);
                try {
                    const wl = coreCall(bin, { cmd: 'windows', filter: tag, max: 50 }, 8000);
                    const cands = (wl.windows || []).filter((w) => String(w.title || '').includes(tag));
                    // 同名壳/真窗都可能有：按面积取最大（ApplicationFrameWindow 才是真窗口）
                    cands.sort((a, b) => (b.w * b.h) - (a.w * a.h));
                    if (cands.length) myHwnd = Number(cands[0].hwnd) || 0;
                } catch (e) { /* 还没起来 */ }
            }
            ok('自建测试窗口已出现（不碰用户窗口）', myHwnd > 0, 'hwnd=' + myHwnd + ' tag=' + tag);
            if (myHwnd > 0) {
                const hw = String(myHwnd);
                const rMin = coreCall(bin, { cmd: 'window_op', target: hw, op: 'min' }, 10000);
                ok('min：ok 与 iconic 一致（ok=true ⇒ iconic=true）',
                    (rMin.ok === true && rMin.iconic === true) || (rMin.ok === false && rMin.iconic === false),
                    JSON.stringify(rMin).slice(0, 200));
                ok('min：真的最小化了', rMin.ok === true && rMin.iconic === true, JSON.stringify({ ok: rMin.ok, iconic: rMin.iconic, error: rMin.error }));

                const rRes = coreCall(bin, { cmd: 'window_op', target: hw, op: 'restore' }, 10000);
                ok('restore：ok 与 iconic 一致（ok=true ⇒ iconic=false）',
                    (rRes.ok === true && rRes.iconic === false) || (rRes.ok === false && rRes.iconic === true),
                    JSON.stringify(rRes).slice(0, 200));
                ok('restore：真的还原了', rRes.ok === true && rRes.iconic === false, JSON.stringify({ ok: rRes.ok, iconic: rRes.iconic, error: rRes.error }));

                const tClose = Date.now();
                const rClose = coreCall(bin, { cmd: 'window_op', target: hw, op: 'close' }, 10000);
                const closeMs = Date.now() - tClose;
                let gone = false;
                try {
                    const wl2 = coreCall(bin, { cmd: 'windows', filter: tag, max: 50 }, 8000);
                    gone = !(wl2.windows || []).some((w) => Number(w.hwnd) === myHwnd);
                } catch (e) { gone = false; }
                ok('close：ok 与窗口消失一致（ok=true ⇒ IsWindow=false）',
                    (rClose.ok === true && gone) || (rClose.ok === false && !gone),
                    JSON.stringify({ ok: rClose.ok, gone, error: rClose.error }).slice(0, 200));
                ok('close：真的关掉了（≤1s 轮询）', rClose.ok === true && gone, '耗时 ' + closeMs + 'ms ' + JSON.stringify(rClose.error || ''));
                ok('close 轮询预算 ≤1s（源码）', /1000/.test((rustSrc.match(/close 没生效[\s\S]{0,400}/) || [''])[0]));
            }
        } finally {
            // 收尾：只关我们自己起的窗口（按 hwnd），再删临时文件。
            if (myHwnd > 0) {
                try { coreCall(bin, { cmd: 'window_op', target: String(myHwnd), op: 'close' }, 10000); } catch (e) { /* ignore */ }
            } else if (spawnedChild) {
                try { spawnedChild.kill(); } catch (e) { /* ignore */ }
            }
            try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
        }
    }

    console.log('\n== ⑤ 唯一窗口解析入口（resolveTargetHwnd / pickWindowForTarget）==');
    const CANDIDATES = [
        { hwnd: 11, pid: 1, title: 'Calculator', class: 'Windows.UI.Core.CoreWindow', iconic: false, w: 800, h: 600, x: 0, y: 0 },
        { hwnd: 22, pid: 2, title: 'Calculator', class: 'ApplicationFrameWindow', iconic: false, w: 800, h: 600, x: 10, y: 10 },
        { hwnd: 33, pid: 2, title: 'Calculator', class: '', iconic: true, w: 100, h: 100, x: 20, y: 20 },
    ];
    if (!loadErr) {
        const pickFn = typeof g.pickWindowForTarget === 'function' ? g.pickWindowForTarget : null;
        ok('pickWindowForTarget 导出', !!pickFn);
        if (pickFn) {
            const pick = pickFn(CANDIDATES, 'Calculator');
            ok('同标题 3 个候选 → 取最高分（真窗 ApplicationFrameWindow hwnd=22）',
                !!pick && pick.ok === true && pick.win && Number(pick.win.hwnd) === 22,
                JSON.stringify(pick && { ok: pick.ok, hwnd: pick.win && pick.win.hwnd, score: pick.win && pick.win._score }));
            ok('多命中标注「多命中 3 个，选 hwnd=22」',
                !!pick && pick.multiHit === true && /多命中 3 个/.test(String(pick.detail || '')) && /hwnd=22/.test(String(pick.detail || '')),
                pick && pick.detail);
            const none = pickFn([], 'NoSuchWindow');
            ok('无候选时明确失败（不取第一个）', !!none && none.ok === false && !!none.error,
                JSON.stringify(none));
        }
        const srcGc = fs.readFileSync(GC, 'utf8');
        ok('resolveTargetHwnd 是导出的唯一入口', typeof g.resolveTargetHwnd === 'function');
        ok('focus_window 路径用 resolveTargetHwnd',
            /async function focusWindow[\s\S]{0,900}resolveTargetHwnd\(/.test(srcGc));
        ok('window_op 在进后端前换成 hwnd',
            /async function windowOp[\s\S]{0,1400}?resolveTargetHwnd\([\s\S]{0,700}?req\.target\s*=\s*String\(/.test(srcGc));
        ok('batch 钉窗用 resolveTargetHwnd',
            /const rz = await resolveTargetHwnd\(focus0\)[\s\S]{0,800}pinned\s*=\s*\{[^}]*rz\.hwnd/.test(srcGc));
        ok('post_keys 路径用 resolveTargetHwnd',
            /async function postKeysTo[\s\S]{0,900}resolveTargetHwnd\(/.test(srcGc));
        ok('WGC 抓帧在进后端前换成 hwnd',
            /case 'wgc_hash'[\s\S]{0,6000}resolveTargetHwnd\(/.test(srcGc) &&
            /case 'wgc_shot'[\s\S]{0,4000}resolveTargetHwnd\(/.test(srcGc));

        // 运行时：postKeysTo 必须把 hwnd 交给后端，而不是标题。
        if (typeof g.postKeysTo === 'function') {
            windowsFixture = CANDIDATES;
            spawnMode = 'record';
            calls.spawn = 0;
            spawnCalls.length = 0;
            let pr = null;
            try { pr = await g.postKeysTo('Calculator', 'w'); } catch (e) { pr = { ok: false, error: String(e && e.message || e) }; }
            spawnMode = 'throw';
            windowsFixture = null;
            ok('postKeysTo 解析后投递成功（桩）', !!pr && pr.ok === true, JSON.stringify(pr));
            ok('postKeysTo 给后端的是 hwnd=22（不是标题）',
                /\[IntPtr\]22\b/.test(lastPsScript) && !/Calculator/.test(lastPsScript),
                String(lastPsScript).slice(0, 220));
        } else {
            ok('postKeysTo 导出（便于断言后端拿到 hwnd）', false, '未导出');
        }

        // 运行时：resolveTargetHwnd 对伪造的 windows 响应做多命中解析。
        if (typeof g.resolveTargetHwnd === 'function') {
            windowsFixture = CANDIDATES;
            const rz = await g.resolveTargetHwnd('Calculator');
            ok('resolveTargetHwnd 返回 hwnd=22 + 多命中信息',
                !!rz && rz.ok === true && Number(rz.hwnd) === 22 && rz.multiHit === true && /多命中 3 个/.test(String(rz.detail || '')),
                JSON.stringify(rz).slice(0, 240));
            const rMissing = await g.resolveTargetHwnd('NoSuchWindow123');
            ok('resolveTargetHwnd 解析不到时明确失败', !!rMissing && rMissing.ok === false && !!rMissing.error,
                JSON.stringify(rMissing).slice(0, 200));
            windowsFixture = null;
            const stats = typeof g.controlStats === 'function' ? g.controlStats() : null;
            ok('解析可观测（resolveCalls/multiHit/resolveFailed）',
                !!stats && stats.resolveCalls > 0 && stats.resolveMultiHit > 0 && stats.resolveFailed > 0,
                stats ? JSON.stringify({ calls: stats.resolveCalls, multi: stats.resolveMultiHit, failed: stats.resolveFailed, last: stats.lastResolveDetail }) : '未导出');
        }
    }

    console.log('\n== ⑥ act 工具面：som_click / confirm_destructive / 守卫缺省 ==');
    if (loadErr) {
        ok('game-control.js 可加载（act 工具面断言前置）', false, String(loadErr.message || loadErr));
    } else {
        const st0 = typeof g.controlStats === 'function' ? g.controlStats() : {};
        const needStats = ['somClicks', 'guardDefaulted', 'schemaUnknownKeys', 'confirmDestructiveGranted'];
        ok('新增可观测计数（somClicks/guardDefaulted/schemaUnknownKeys/confirmDestructiveGranted）',
            needStats.every((k) => Object.prototype.hasOwnProperty.call(st0, k)),
            JSON.stringify(st0));

        // ── 守卫缺省：原语自己补 {source:'unspecified', name:''}，不能静默跳过 ──
        g.__testHooks.setOwnWindows([]);
        g.__testHooks.setSomState({ title: '', hwnd: 0, marks: [{ name: '确认', x: 40, y: 40 }], rect: null });
        let clickDefaultErr = '';
        try { await g.__testHooks.clickAt(40, 40); } catch (e) { clickDefaultErr = String((e && e.message) || e).slice(0, 120); }
        ok('clickAt 缺省 guard 时自动补全（guardDefaulted 计数）',
            Number(g.controlStats().guardDefaulted) >= 1, clickDefaultErr || '已补全');

        let somPrimErr = '';
        try { await g.runGameAction('som_click', '#1', null, null, null); } catch (e) { somPrimErr = String((e && e.message) || e).slice(0, 120); }
        ok('som_click 原语使用可计数（somClicks）',
            Number(g.controlStats().somClicks) >= 1, somPrimErr || '已计数');
        g.__testHooks.reset();

        // ── 真实入口：DispatchPlugin.executeTool（LLM tool call 落到的那一层）──
        // 注意：index.js 在 require 时**解构** runGameAction —— 必须在首次 require 前装好 spy。
        const realRunGameAction = g.runGameAction;
        let spyCap = null;
        g.runGameAction = async function (action, arg, focus, profiles, extraCfg) {
            if (spyCap) {
                spyCap.push({ action, arg, focus, extraCfg: extraCfg || null });
                return { ok: true, verified: true, effect: 'confirmed', detail: 'spy' };
            }
            return realRunGameAction(action, arg, focus, profiles, extraCfg);
        };
        let Dispatch = null;
        let plugin = null;
        let instErr = '';
        try {
            Dispatch = require(DISPATCH_INDEX);
            plugin = new Dispatch({ name: 'dispatch' }, {
                getPluginFileConfig: () => ({ apps: {} }),
                log: () => {},
                sendMessage: async () => {},
            });
            await plugin.onInit();
        } catch (e) { instErr = String((e && e.message) || e).slice(0, 200); }
        ok('dispatch 插件可实例化（不依赖宿主）', !!plugin, instErr);
        if (plugin) {
            const actTool = plugin.getTools().find((t) => t.function && t.function.name === 'act');
            const props = (actTool && actTool.function && actTool.function.parameters
                && actTool.function.parameters.properties) || {};
            const enumAct = (props.action && Array.isArray(props.action.enum)) ? props.action.enum : [];
            ok('act schema 枚举含 som_click', enumAct.includes('som_click'), JSON.stringify(enumAct));
            ok('act schema 声明 arg（#N 或数字）',
                !!props.arg && props.arg.type === 'string', JSON.stringify(props.arg || null));
            ok('act schema 声明 confirm_destructive:boolean',
                !!props.confirm_destructive && props.confirm_destructive.type === 'boolean',
                JSON.stringify(props.confirm_destructive || null));
            ok('confirm_destructive 描述写清用途（破坏性/丢弃/确认）',
                /破坏性|丢弃|确认/.test(String((props.confirm_destructive && props.confirm_destructive.description) || '')),
                String((props.confirm_destructive && props.confirm_destructive.description) || '').slice(0, 80));

            // 映射：arg 接受 '#1' / 1，且必须走 som_click（不是 click_element 的另一套编号）
            const m1 = plugin._mapToGameControl('act', { action: 'som_click', arg: '#1' });
            ok('som_click arg=#1 → action=som_click arg=1',
                m1.action === 'som_click' && m1.arg === '1', JSON.stringify(m1));
            const m2 = plugin._mapToGameControl('act', { action: 'som_click', arg: 1 });
            ok('som_click arg=1（数字）→ arg=1',
                m2.action === 'som_click' && m2.arg === '1', JSON.stringify(m2));
            const m3 = plugin._mapToGameControl('act', { action: 'som_click', target: '#2' });
            ok('som_click 兼容旧写法 target=#2',
                m3.action === 'som_click' && m3.arg === '2', JSON.stringify(m3));
            ok('som_click 不映射到 click_element（编号空间不混用）',
                m1.action !== 'click_element' && m3.action !== 'click_element');

            // confirm_destructive 透传到后端 extraCfg（click_element 守卫据此放行）
            await sleep(360);
            spyCap = [];
            await plugin.executeTool('act', { action: 'click', target: '文字:确定', confirm_destructive: true });
            ok('confirm_destructive 透传到 game-control extraCfg',
                !!spyCap[0] && !!spyCap[0].extraCfg && spyCap[0].extraCfg.confirm_destructive === true,
                JSON.stringify(spyCap[0] || null));
            ok('确认放行可计数（confirmDestructiveGranted）',
                Number(g.controlStats().confirmDestructiveGranted) >= 1,
                String(g.controlStats().confirmDestructiveGranted));

            await sleep(360);
            spyCap = [];
            await plugin.executeTool('act', { action: 'som_click', arg: '#1', confirm_destructive: true });
            ok('som_click 同样透传 confirm_destructive + arg',
                !!spyCap[0] && spyCap[0].action === 'som_click' && spyCap[0].arg === '1'
                && !!spyCap[0].extraCfg && spyCap[0].extraCfg.confirm_destructive === true,
                JSON.stringify(spyCap[0] || null));

            // schema 之外的键：可观测（以前静默吞掉，看不出模型传错了参数名）
            await sleep(360);
            spyCap = [];
            const rUnknown = await plugin.executeTool('act', { action: 'click', target: 'x,y', totally_unknown: 1 });
            ok('act 未知键被计数（schemaUnknownKeys）',
                Number(g.controlStats().schemaUnknownKeys) >= 1,
                'stats=' + JSON.stringify(g.controlStats()));
            ok('未知键不阻断正常动作', !!spyCap[0] && spyCap[0].action === 'click_at',
                JSON.stringify(spyCap[0] || null) + ' raw=' + String(rUnknown).slice(0, 120));
            spyCap = null;
        }

        // 静态：两条漏传 guard 的调用点已补 source（全局搜索式断言，不依赖运行到该分支）
        const gcSrcAct = fs.readFileSync(GC, 'utf8');
        const vOk = /case 'visual_click'[\s\S]*?vGuard\s*=\s*\{[^}]*source:\s*'visual'[\s\S]*?clickAt\(vx,\s*vy[^)]*vGuard/.test(gcSrcAct);
        ok('visual_click 调用点传了 guard（source=visual）', vOk, vOk ? 'vGuard={source:visual}' : '未找到 vGuard={source:visual} + clickAt(vx,vy,…,vGuard)');
        const pOk = /pvzSub === 'plant'[\s\S]*?clickAt\(x,\s*y[^)]*source:\s*'pvz'/.test(gcSrcAct);
        ok('pvz plant 调用点传了 guard（source=pvz）', pOk, pOk ? '{source:pvz}' : '未找到 clickAt(x,y,…,{source:pvz})');
        ok('clickAt 原语自身有 guard 缺省构造',
            /async function clickAt\([\s\S]{0,900}?source: 'unspecified'/.test(gcSrcAct));
        ok('mouseEx 原语自身有 guard 缺省构造',
            /async function mouseEx\([\s\S]{0,900}?source: 'unspecified'/.test(gcSrcAct));

        // ── 真机入口（可选）：8004 /eval → pluginManager.executeTool ──────────
        // 证明「模型真实调用路径」也能到达 SoM 原语，而不是只证明进程内实例可用。
        // 只调用会**必然失败**的路径（没有 SoM 编号 → 原语在发鼠标前就抛），不点桌面。
        // 8004 不在时 SKIP（门禁在无宿主的机器上仍可跑）。
        let hostValue = null;
        let hostErr = '';
        try {
            const r = await fetch('http://127.0.0.1:8004/eval', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ js: `(async()=>{try{
                    const raw=await window.pluginManager.executeTool('act',{action:'som_click',arg:'#1'});
                    let o=null;try{o=JSON.parse(raw)}catch(e){}
                    return JSON.stringify({ok:o&&o.ok,error:o&&o.error,detail:o&&o.detail,raw:String(raw).slice(0,240)});
                }catch(e){return JSON.stringify({thrown:String(e&&e.message||e)})}})()` }),
                signal: AbortSignal.timeout(25000),
            });
            const j = await r.json();
            hostValue = j && j.ok ? JSON.parse(j.value) : null;
            if (!hostValue) hostErr = String((j && j.error) || 'eval failed');
        } catch (e) {
            hostErr = String((e && e.message) || e).slice(0, 120);
            hostValue = null;
        }
        if (!hostValue) {
            console.log('  · SKIP 8004 不可达（宿主未启动）：' + hostErr);
        } else {
            const hostMsg = String(hostValue.error || hostValue.thrown || '');
            ok('8004 executeTool(act som_click) 到达 SoM 原语（错误文案来自 SoM）',
                /som_snapshot|标注图/.test(hostMsg) && !/snapshot 拿菜单/.test(hostMsg),
                hostMsg.slice(0, 160) || JSON.stringify(hostValue).slice(0, 200));
        }
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    if (fail) {
        console.error('失败项：');
        for (const f of failures) console.error('  · ' + f);
    }
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
