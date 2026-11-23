#!/usr/bin/env node
// _probe/regress-fake-success.cjs —— 「真假成功」回归测试（2026-11-09，偿还交接件 D4）
//
// 为什么有这个文件：
//   35 轮做「真假成功系统性治理」时只手工验证了一次，没有自动化回归。
//   交接件 D4 的原文是：「跨模块 6 个假成功没有自动化回归测试 | 只做了一次手工验证，将来可能退化」。
//   这个脚本就是那条债的还款：把「错误的情况不许返回成功」固化成可重复运行的断言。
//
// 设计原则：
//   · 每个用例都必须断言「关键字段」，不能只检查 r.ok === false（那太容易取巧）。
//     例如：not_sent 必须同时满足 action_sent === false、effect === 'not_sent'、detail 里有具体原因。
//   · 不碰生产代码（game-control.js / verify-contract.js 一行都不改）。发现 bug 只报告。
//   · 不打扰用户：
//       - 需要「真实窗口」的用例（#2/#6）自己造一个 2% 不透明度的临时 WinForms 窗口，用完必 kill；
//         #2/#3 还额外放一个「牺牲窗口」垫在点击坐标下面 —— 万一生产代码的前置校验失效，
//         鼠标也只会点到我们自己的窗口，不会点到用户的界面（并用 marker 文件反向证明「点击真的没发」）。
//       - #3 用「不存在的窗口标题」走同一个「聚焦失败」分支，不依赖用户任何窗口。
//       - 不启动/不关闭用户的任何应用（UIA 常驻服务没跑时，#2 直接 SKIP，不去拉起它）。
//   · 每个用例都有超时；异常/超时也照实记 FAIL，不吞。
//
// 用法：
//   cd "<project-root>"
//   node _probe/regress-fake-success.cjs
//
// 退出码：有 FAIL → 1；全 PASS/SKIP → 0。

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DISPATCH = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch');
const GC = require(path.join(DISPATCH, 'game-control.js'));
const VC = require(path.join(DISPATCH, 'verify-contract.js'));

const CORE = path.join(ROOT, 'pet-core', 'target', 'release', process.platform === 'win32' ? 'pet-core.exe' : 'pet-core');
const UIA_PORT = Number(process.env.PET_UIA_PORT) || 8106;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 清理栈：无论怎么退出（含 Ctrl+C），临时窗口都必须关掉 ──────────────────
const CLEANUP = [];
function killAll() {
    while (CLEANUP.length) {
        const fn = CLEANUP.pop();
        try { fn(); } catch (e) { /* ignore */ }
    }
}
process.on('exit', killAll);
process.on('SIGINT', () => { killAll(); process.exit(130); });
process.on('SIGTERM', () => { killAll(); process.exit(143); });

// ── 通用工具 ────────────────────────────────────────────────────────────────
function trunc(s, n) {
    const t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ');
    return t.length > (n || 200) ? t.slice(0, n || 200) + '…' : t;
}

function chk(list, id, desc, cond, got) {
    list.push({ id, desc, pass: cond === true, got: got === undefined ? '' : trunc(got, 220) });
}

function coreCmd(obj, timeoutMs) {
    return new Promise((resolve) => {
        try {
            const child = execFile(CORE, [], { windowsHide: true, timeout: timeoutMs || 8000, maxBuffer: 4 * 1024 * 1024 },
                (err, stdout) => {
                    if (err) return resolve(null);
                    try { resolve(JSON.parse(String(stdout))); } catch (e) { resolve(null); }
                });
            child.stdin.end(JSON.stringify(obj), 'utf8');
        } catch (e) { resolve(null); }
    });
}

function uiaHealth() {
    return new Promise((resolve) => {
        try {
            const data = Buffer.from('{}', 'utf8');
            const req = require('http').request({
                host: '127.0.0.1', port: UIA_PORT, path: '/health', method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length },
                timeout: 900,
            }, (res) => {
                let s = '';
                res.on('data', (c) => { s += c; });
                res.on('end', () => { try { resolve(!!JSON.parse(s).ok); } catch (e) { resolve(false); } });
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } resolve(false); });
            req.write(data); req.end();
        } catch (e) { resolve(false); }
    });
}

function uiaPost(p, body, timeoutMs) {
    return new Promise((resolve) => {
        try {
            const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
            const req = require('http').request({
                host: '127.0.0.1', port: UIA_PORT, path: p, method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length },
                timeout: timeoutMs || 3000,
            }, (res) => {
                let s = '';
                res.on('data', (c) => { s += c; });
                res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(null); } });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } resolve(null); });
            req.write(data); req.end();
        } catch (e) { resolve(null); }
    });
}

function runPwsh(script, timeoutMs) {
    return new Promise((resolve) => {
        try {
            const enc = Buffer.from(script, 'utf16le').toString('base64');
            execFile('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { windowsHide: true, timeout: timeoutMs || 10000 },
                (err, stdout) => resolve({ ok: !err, out: String(stdout || '').trim(), error: err ? String(err.message) : '' }));
        } catch (e) { resolve({ ok: false, out: '', error: e.message }); }
    });
}

/** 按标题子串轮询窗口（pet-core 的 EnumWindows，和 windowRealRect 的判据同源）。 */
async function waitWindow(title, present, timeoutMs) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
        const w = await coreCmd({ cmd: 'windows', filter: title, max: 50 });
        const hit = (w && Array.isArray(w.windows) && w.windows[0]) || null;
        last = hit;
        if (present ? !!hit : !hit) return hit;
        await sleep(250);
    }
    return present ? null : last;
}

/**
 * 造一个临时 WinForms 窗口（2% 不透明度 / 无边框 / 不进任务栏）。
 * 为什么用 -WindowStyle Hidden + windowsHide:false：
 *   windowsHide:true 会让子进程落到另一个 window station（实测 pet-core 看不到它的窗口）；
 *   -WindowStyle Hidden 只藏控制台、窗口仍在交互桌面。
 */
function spawnForm(title, opts) {
    const o = Object.assign({ left: 60, top: 60, width: 240, height: 160, markerFile: '' }, opts || {});
    const lines = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$f = New-Object System.Windows.Forms.Form',
        "$f.Text = '" + title + "'",
        '$f.Width = ' + o.width + '; $f.Height = ' + o.height,
        "$f.FormBorderStyle = 'None'",
        '$f.ShowInTaskbar = $false',
        "$f.StartPosition = 'Manual'",
        '$f.Left = ' + o.left + '; $f.Top = ' + o.top,
        '$f.Opacity = 0.02',
    ];
    if (o.markerFile) {
        // 万一真有鼠标点到这个窗口，落一个标记文件 —— 让测试能证明「点击没发出去」。
        lines.push("$f.Add_Click({ try { [System.IO.File]::WriteAllText('" + o.markerFile + "', 'clicked') } catch {} })");
    }
    lines.push(
        '$f.Show()',
        '[System.Windows.Forms.Application]::DoEvents()',
        'Start-Sleep -Milliseconds 200',
        'for ($i=0; $i -lt 400; $i++) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 200 }',
        '$f.Close()',
    );
    const enc = Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', enc],
        { windowsHide: false, stdio: 'ignore' });
    CLEANUP.push(() => { try { child.kill(); } catch (e) { /* ignore */ } });
    return { title, child };
}

async function killForm(rec) {
    if (!rec) return;
    try { rec.child.kill(); } catch (e) { /* ignore */ }
    await waitWindow(rec.title, false, 5000);
}

async function minimizeWindow(hwnd) {
    const ps = [
        'Add-Type -TypeDefinition @\'',
        'using System; using System.Runtime.InteropServices;',
        'public class RGX { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); }',
        '\'@',
        '[void][RGX]::ShowWindow([IntPtr]' + hwnd + ', 6)',
        "'minimized'",
    ].join('\n');
    return runPwsh(ps, 8000);
}

function withTimeout(p, ms, label) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('用例超时（' + label + ' > ' + ms + 'ms）')), ms);
        Promise.resolve(p).then(
            (v) => { clearTimeout(t); resolve(v); },
            (e) => { clearTimeout(t); reject(e); },
        );
    });
}

// ── 契约扫描：一个结果对象违反哪些不变量 ────────────────────────────────────
// 不变量（任务书第 9 条）：
//   effect 越像成功 → action_sent 越应该是 true；
//   not_sent 必须 action_sent:false；
//   suspected_noop 意味着「发出去了但没效果」→ action_sent 必须 true
//     （否则语义自相矛盾：你根本没发，谈什么「怀疑没效果」）。
function violations(r, where) {
    const v = [];
    const push = (kind, msg) => v.push({ kind, msg });
    const eff = r && r.effect;
    if (!r || typeof r !== 'object') return [{ kind: 'not_object', msg: where + ' → 不是对象' }];
    if (eff === 'not_sent') {
        if (r.ok !== false) push('not_sent_ok_true', where + ' → not_sent 但 ok=' + r.ok);
        if (r.action_sent !== false) push('not_sent_action_sent', where + ' → not_sent 但 action_sent=' + r.action_sent);
    }
    if (eff === 'suspected_noop') {
        if (r.action_sent !== true) push('noop_action_sent_false', where + ' → suspected_noop 但 action_sent=' + r.action_sent + '（没发出去却报告「怀疑没效果」，应归 not_sent）');
        if (r.verified !== true) push('noop_not_verified', where + ' → suspected_noop 但 verified=' + r.verified);
        if (r.ok !== false) push('noop_ok_true', where + ' → suspected_noop 但 ok=' + r.ok);
    }
    if (eff === 'confirmed' || eff === 'confirmed_idempotent') {
        if (r.action_sent !== true) push('confirmed_action_sent_false', where + ' → ' + eff + ' 但 action_sent=' + r.action_sent);
        if (r.ok !== true) push('confirmed_not_ok', where + ' → ' + eff + ' 但 ok=' + r.ok);
        if (r.verified !== true) push('confirmed_not_verified', where + ' → ' + eff + ' 但 verified=' + r.verified);
    }
    if (eff === 'readonly') {
        if (r.action_sent !== false) push('readonly_action_sent', where + ' → readonly 但 action_sent=' + r.action_sent);
        if (r.ok !== true) push('readonly_not_ok', where + ' → readonly 但 ok=' + r.ok);
    }
    if (eff === 'unverifiable' && r.verified !== null) push('unverifiable_not_null', where + ' → unverifiable 但 verified=' + r.verified);
    if (r.unverified !== (r.verified === null)) push('unverified_mismatch', where + ' → unverified 字段与 verified 不一致（' + r.unverified + ' vs ' + r.verified + '）');
    if (r.action_sent === false && eff !== 'not_sent' && /已执行|已点击|已点|已按|已发送/.test(String(r.detail || ''))) {
        push('claims_executed_but_not_sent', where + ' → action_sent=false 但 detail 声称动作已执行：' + trunc(r.detail, 80));
    }
    return v;
}

/** 把违反项按「类别 + effect」归并，输出可读的一行代表。 */
function summarizeViolations(list) {
    const groups = new Map();
    for (const it of list) {
        const key = it.kind + '|' + (it.effect || '-');
        if (!groups.has(key)) groups.set(key, { kind: it.kind, effect: it.effect || '-', count: 0, sample: it });
        groups.get(key).count += 1;
    }
    return Array.from(groups.values());
}

// ══════════════════════════════════════════════════════════════════════════
// 用例
// ══════════════════════════════════════════════════════════════════════════

// 1. click_at 坐标越界 / 格式非法
async function case1() {
    const a = [];
    let threw = null;
    try { await GC.runGameAction('click_at', '99999999,99999999', null, null, null); } catch (e) { threw = e; }
    chk(a, '1a', '离谱坐标必须被拒绝（不是 confirmed）', !!threw || /超出屏幕/.test(threw ? threw.message : ''),
        threw ? 'threw: ' + threw.message : '没抛错（危险）');
    chk(a, '1b', '拒绝原因必须说「超出屏幕范围」', !!threw && /超出屏幕范围/.test(threw.message),
        threw ? threw.message : 'no throw');

    let threw2 = null;
    try { await GC.runGameAction('click_at', 'abc', null, null, null); } catch (e) { threw2 = e; }
    chk(a, '1c', '非坐标格式必须被拒绝', !!threw2 && /格式/.test(threw2.message), threw2 ? threw2.message : '没抛错（危险）');

    const notes = [
        '已知边界：纯 Node 下读不到 electron 屏幕信息，scr 兜底成 ±1e6（见 game-control.js L2024-2034），' +
        '所以 (5000,5000) 这种「越界但没到 1e6」的坐标在这里不会被拦 —— 这是兜底设计的已知缺口，不是本测试的漏测。',
    ];
    return { assertions: a, notes };
}

// 2. click_at 坐标在 focus 窗口外
async function case2() {
    const a = [];
    const notes = [];
    if (!fs.existsSync(CORE)) return { skip: 'pet-core.exe 不存在，无法读窗口矩形/造临时窗口' };
    if (!(await uiaHealth())) {
        return { skip: 'UIA 常驻服务未运行：windowRealRect 会为了这次测试拉起常驻服务（改变环境），故跳过。先启动 pet/uia-service.ps1 再跑' };
    }

    const stamp = String(process.pid) + '_' + String(Date.now() % 100000);
    const titleA = 'REGRESS_OUTSIDE_A_' + stamp;
    const titleB = 'REGRESS_SACRIFICE_B_' + stamp;
    const marker = path.join(__dirname, '.tmp-click-marker-2-' + stamp + '.txt');
    try { fs.unlinkSync(marker); } catch (e) { /* ignore */ }
    CLEANUP.push(() => { try { fs.unlinkSync(marker); } catch (e) { /* ignore */ } });

    let winA = null;
    let winB = null;
    try {
        // 牺牲窗口：垫在「窗口外坐标」下面。万一前置校验失效真的点了，也只会点到我们自己的窗口。
        winB = spawnForm(titleB, { left: 400, top: 300, width: 200, height: 140, markerFile: marker });
        const rectB = await waitWindow(titleB, true, 9000);
        if (!rectB) return { skip: '牺牲窗口没起来（没有安全垫，不能冒点用户界面的风险），无法测这条', notes };
        // 待测窗口：放在左上角，和被点坐标不重叠。
        winA = spawnForm(titleA, { left: 60, top: 60, width: 240, height: 160 });
        const rectA = await waitWindow(titleA, true, 9000);
        if (!rectA) return { skip: '临时测试窗口没起来（pwsh/WinForms 不可用），无法安全地测这条', notes };

        // 确保 A 是前台（新窗口 Show() 通常会拿到前台；拿不到就用我们自己的 focus 强制一次）
        let fg = await coreCmd({ cmd: 'fg' });
        if (!fg || !String(fg.title || '').includes(titleA)) {
            await coreCmd({ cmd: 'focus', target: String(rectA.hwnd), force: true });
            await sleep(400);
            fg = await coreCmd({ cmd: 'fg' });
        }
        if (!fg || !String(fg.title || '').includes(titleA)) {
            return { skip: '临时窗口抢不到前台（当前前台：' + (fg && fg.title) + '），无法在不打扰用户的前提下测这条', notes };
        }

        // 点：牺牲窗口的中心（在 A 之外）
        const px = Math.round(rectB.x + rectB.w / 2);
        const py = Math.round(rectB.y + rectB.h / 2);
        const realA = await uiaPost('/rect', { title: titleA }, 3000);
        const outside = !rectA || px < rectA.x || px > rectA.x + rectA.w || py < rectA.y || py > rectA.y + rectA.h;
        chk(a, '2a', '测试点确实在 A 窗口之外（用例自身前提）', outside,
            '点=(' + px + ',' + py + ') A=' + JSON.stringify(rectA ? { x: rectA.x, y: rectA.y, w: rectA.w, h: rectA.h } : null));

        let threw = null;
        let res = null;
        try { res = await GC.runGameAction('click_at', px + ',' + py, titleA, null, null); } catch (e) { threw = e; }

        chk(a, '2b', '没有返回成功（throw 或 ok:false）', !!threw || (res && res.ok === false),
            threw ? 'threw: ' + threw.message : ('result: ' + JSON.stringify(res)));
        const msg = threw ? threw.message : String((res && (res.detail || res.error)) || '');
        chk(a, '2c', '原因里必须带窗口范围（用户能据此修正坐标）', /窗口范围/.test(msg) && /不在/.test(msg), msg);
        chk(a, '2d', '报告的范围必须是真实窗口矩形（不是编的）', (() => {
            const m = msg.match(/窗口范围\s*(-?\d+),(-?\d+)\s*~\s*(-?\d+),(-?\d+)/);
            if (!m || !realA) return false;
            const got = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
            const exp = [Number(realA.x), Number(realA.y), Number(realA.x) + Number(realA.w), Number(realA.y) + Number(realA.h)];
            return got.every((v, i) => Math.abs(v - exp[i]) <= 2);
        })(), msg + ' | /rect=' + JSON.stringify(realA));

        // 物理证据：牺牲窗口没收到点击 → 鼠标事件真的没发出去
        await sleep(500);
        const clicked = fs.existsSync(marker);
        chk(a, '2e', '鼠标事件确实没发出去（牺牲窗口未收到点击）', !clicked,
            clicked ? '牺牲窗口收到了点击 —— action_sent 语义不可信' : '未收到点击');

        chk(a, '2f', '本用例没有被判成 confirmed', !(res && res.effect === 'confirmed'), res ? String(res.effect) : 'threw');
        return { assertions: a, notes };
    } finally {
        await killForm(winA);
        await killForm(winB);
        try { fs.unlinkSync(marker); } catch (e) { /* ignore */ }
    }
}

// 3. click_at 目标不是前台且聚焦失败 → 不许发点击
async function case3() {
    const a = [];
    const notes = [];
    if (!fs.existsSync(CORE)) return { skip: 'pet-core.exe 不存在，无法造牺牲窗口' };
    const stamp = String(process.pid) + '_' + String(Date.now() % 100000);
    const titleB = 'REGRESS_SACRIFICE_C_' + stamp;
    const missing = 'REGRESS_NO_SUCH_WINDOW_' + stamp;
    const marker = path.join(__dirname, '.tmp-click-marker-3-' + stamp + '.txt');
    try { fs.unlinkSync(marker); } catch (e) { /* ignore */ }
    CLEANUP.push(() => { try { fs.unlinkSync(marker); } catch (e) { /* ignore */ } });

    let winB = null;
    try {
        winB = spawnForm(titleB, { left: 400, top: 300, width: 200, height: 140, markerFile: marker });
        const rectB = await waitWindow(titleB, true, 9000);
        if (!rectB) return { skip: '临时牺牲窗口没起来，无法安全地测这条', notes };
        const px = Math.round(rectB.x + rectB.w / 2);
        const py = Math.round(rectB.y + rectB.h / 2);

        // missing 窗口不存在 → assertTargetFocused 失败 → focusWindow 也失败 → 必须 notSent
        const res = await GC.runGameAction('click_at', px + ',' + py, missing, null, null);
        chk(a, '3a', '结果是 ok:false 且 effect=not_sent', res.ok === false && res.effect === 'not_sent', JSON.stringify(res));
        chk(a, '3b', 'action_sent 必须是 false（根本没发点击）', res.action_sent === false, 'action_sent=' + res.action_sent);
        chk(a, '3c', 'detail 必须说清「没点」和为什么', /没点/.test(String(res.detail)) && /前台/.test(String(res.detail)), res.detail);
        chk(a, '3d', '走了 click_at 的 focus 分支（coordsInWindow 标记存在）', res.coordsInWindow === true, 'coordsInWindow=' + res.coordsInWindow);
        chk(a, '3e', '绝不能是 confirmed', res.effect !== 'confirmed', String(res.effect));
        chk(a, '3g', '带稳定否决码 1001（焦点丢失）', res.vetoCode === 1001, 'vetoCode=' + res.vetoCode);

        await sleep(500);
        chk(a, '3f', '鼠标事件确实没发出去（牺牲窗口未收到点击）', !fs.existsSync(marker),
            fs.existsSync(marker) ? '牺牲窗口收到了点击 —— action_sent=false 在撒谎' : '未收到点击');
        notes.push('本用例的 focus 是一个不存在的标题：走的是 assertTargetFocused 失败 → focusWindow 失败 → notSent 这条分支，' +
            '和「窗口存在但不是前台且抢不过来」是同一段代码；全程只碰我们自己的 2% 临时窗口，不碰用户任何窗口。');
        return { assertions: a, notes };
    } finally {
        await killForm(winB);
        try { fs.unlinkSync(marker); } catch (e) { /* ignore */ }
    }
}

// 4. click_text 找不到文字 → notSent + ocrSaw（诚实报告 OCR 看到了什么）
async function case4() {
    const a = [];
    const notes = [];
    const token = 'QZXJ9KV7REGRESS_9F3A7B';
    const res = await GC.runGameAction('click_text', token, null, null, null);

    chk(a, '4a', '找不到文字时 ok:false / effect=not_sent', res.ok === false && res.effect === 'not_sent', JSON.stringify(res).slice(0, 300));
    chk(a, '4b', 'action_sent 必须是 false', res.action_sent === false, 'action_sent=' + res.action_sent);
    // ⚠ 2026-11-10 断言更新（配合生产代码的诚实性修复）：
    //   原来只认「没找到」。但 OCR 20s 超时时，正确话术是「没法确认…这次检查没跑完」——
    //   那是**更诚实**的回答，不该被判 FAIL。现在两种情况都接受，但**都必须明确表态**：
    //   要么「没找到」（查过了），要么「没跑完/超时」（没查成）。含糊其辞才算失败。
    const d4 = String(res.detail || '');
    const honest = /没找到/.test(d4) || /没跑完|超时|没法确认/.test(d4);
    chk(a, '4c', 'detail 必须明确表态（要么「没找到」要么「没跑完/超时」）', honest, d4);
    if (/没跑完|超时|没法确认/.test(d4)) {
        chk(a, '4c2', 'OCR 没跑完时必须标 checked:false（不能假装查过）',
            res.checked === false, 'checked=' + JSON.stringify(res.checked));
    }
    chk(a, '4d', '必须带 ocrSaw 字段（诚实报告 OCR 看到了什么）',
        Object.prototype.hasOwnProperty.call(res, 'ocrSaw') && typeof res.ocrSaw === 'string',
        'ocrSaw=' + JSON.stringify(res.ocrSaw));

    // 观察项（不判 FAIL，因为 OCR 是否在 20s 内完成取决于机器/负载，会 flaky）：
    //   OCR 没产出任何文本 = 这条链路失败了；而 detail 却写「UIA 和 OCR 都没看到」，
    //   把「OCR 没跑成」说成「OCR 看过了没有」——这是诚实性问题，不是拒绝逻辑问题。
    const ocrEmpty = String(res.ocrSaw || '') === '';
    if (ocrEmpty) {
        notes.push('⚠ 诚实性缺口（本次观察到）：ocrSaw 为空（OCR 没有产出任何文本），但 detail 说「UIA 和 OCR 都没看到」。' +
            '实测全屏 OCR 在 2560×1440 上约 40s，而代码 20s 就 kill（game-control.js L2319），' +
            'res.error 被整个丢弃 → 调用方无法区分「OCR 跑了没看到」和「OCR 超时没跑成」。');
    } else {
        notes.push('本次 OCR 在 20s 内产出了文本（ocrSaw 非空），所以「OCR 失败被伪装成没看到」这个缺口本次没有被触发；' +
            '它在慢机器/高负载时会触发（前一版实测 26s 超时）。');
    }
    notes.push('说明：OCR 是否在 20s 内完成与机器负载有关，所以这一条只作为观察项输出，不参与 PASS/FAIL，避免 flaky。');
    return { assertions: a, notes };
}

// 5. wgc_shot 抓不存在的窗口
async function case5() {
    const a = [];
    if (!fs.existsSync(CORE)) return { skip: 'pet-core.exe 不存在，WGC 不可用（会走 notSent 的二进制缺失分支，测不到 Rust 语义）' };
    const res = await GC.runGameAction('wgc_shot', 'REGRESS_NO_SUCH_WIN_' + process.pid, null, null, null);
    chk(a, '5a', '抓不存在的窗口必须 ok:false / not_sent', res.ok === false && res.effect === 'not_sent', JSON.stringify(res).slice(0, 300));
    chk(a, '5b', 'action_sent 必须是 false（没有可抓的对象）', res.action_sent === false, 'action_sent=' + res.action_sent);
    chk(a, '5c', '原因必须说明「没找到窗口」', /没找到窗口/.test(String(res.detail)), res.detail);
    chk(a, '5d', 'error 字段要有内容（规格要求；调用方常靠 r.error 判失败）',
        typeof res.error === 'string' && res.error.length > 0,
        'error=' + JSON.stringify(res.error) + '，原因只出现在 detail 里');
    return { assertions: a, notes: ['5d 若 FAIL：说明 VC.notSent() 不写 error 字段（只写 detail），这是契约层缺口，不是 WGC 抓图逻辑的问题。'] };
}

// 6. wgc_shot 抓最小化窗口
async function case6() {
    const a = [];
    const notes = [];
    if (!fs.existsSync(CORE)) return { skip: 'pet-core.exe 不存在，WGC 不可用' };
    const stamp = String(process.pid) + '_' + String(Date.now() % 100000);
    const title = 'REGRESS_MINIMIZED_' + stamp;
    let win = null;
    try {
        win = spawnForm(title, { left: 80, top: 80, width: 240, height: 160 });
        const rect = await waitWindow(title, true, 9000);
        if (!rect) return { skip: '临时窗口没起来，无法测「最小化」', notes };

        await minimizeWindow(rect.hwnd);
        const after = await waitWindow(title, true, 5000);
        const iconic = !!(after && after.iconic === true);
        if (!iconic) return { skip: '临时窗口没能最小化（iconic=false），无法复现该场景', notes };

        const res = await GC.runGameAction('wgc_shot', title, null, null, null);
        chk(a, '6a', '抓最小化窗口必须 ok:false / not_sent', res.ok === false && res.effect === 'not_sent', JSON.stringify(res).slice(0, 300));
        chk(a, '6b', 'action_sent 必须是 false', res.action_sent === false, 'action_sent=' + res.action_sent);
        chk(a, '6c', '原因必须说明「最小化」并给出下一步', /最小化/.test(String(res.detail)) && /focus_window/.test(String(res.detail)), res.detail);
        chk(a, '6d', 'error 字段要有内容（规格要求）', typeof res.error === 'string' && res.error.length > 0,
            'error=' + JSON.stringify(res.error) + '，原因只出现在 detail 里');
        return { assertions: a, notes };
    } finally {
        await killForm(win);
    }
}

// 7. click_element / som_click 编号不存在
async function case7() {
    const a = [];
    let threw = null;
    try { await GC.runGameAction('click_element', '99999', null, null, null); } catch (e) { threw = e; }
    chk(a, '7a', 'click_element 编号不存在必须失败（throw），不能返回 ok:true',
        !!threw, threw ? 'threw: ' + threw.message : '没抛错（危险）');
    chk(a, '7b', '错误信息必须提示先 snapshot', !!threw && /编号不存在/.test(threw.message) && /snapshot/.test(threw.message),
        threw ? threw.message : 'no throw');

    let threw2 = null;
    try { await GC.runGameAction('som_click', '1', null, null, null); } catch (e) { threw2 = e; }
    chk(a, '7c', 'som_click 没先 som_snapshot 也必须失败', !!threw2 && /编号不存在/.test(threw2.message),
        threw2 ? threw2.message : '没抛错（危险）');
    return { assertions: a };
}

// 8. 契约自检：动作成功但画面没变 → suspected_noop（最核心的一条）
async function case8() {
    const a = [];

    const noop = VC.fromActAndVerify(
        { ok: false, actionResult: { ok: true }, verified: true, changed: false, dist: 2, elapsed: 400 },
        { name: 'click_at' },
    );
    chk(a, '8a', '画面没变时必须 suspected_noop，绝不能 confirmed',
        noop.effect === 'suspected_noop' && noop.effect !== 'confirmed', 'effect=' + noop.effect);
    chk(a, '8b', 'suspected_noop 必须 ok:false / verified:true', noop.ok === false && noop.verified === true,
        'ok=' + noop.ok + ' verified=' + noop.verified);
    chk(a, '8c', 'suspected_noop 必须 action_sent:true（动作确实发了）', noop.action_sent === true, 'action_sent=' + noop.action_sent);
    chk(a, '8d', 'detail 必须写明「画面没变化」', /画面没变化/.test(String(noop.detail)), noop.detail);
    chk(a, '8e', 'nextIfFailed 必须给出可执行的下一步', typeof noop.nextIfFailed === 'string' && noop.nextIfFailed.length > 10, noop.nextIfFailed);

    const conf = VC.fromActAndVerify(
        { ok: true, actionResult: { ok: true }, verified: true, changed: true, dist: 42, elapsed: 320 },
        { name: 'click_at' },
    );
    chk(a, '8f', '画面确实变了 → confirmed 且 action_sent:true',
        conf.effect === 'confirmed' && conf.ok === true && conf.action_sent === true,
        'effect=' + conf.effect + ' ok=' + conf.ok + ' action_sent=' + conf.action_sent);

    const jitter = VC.fromActAndVerify(
        { ok: true, actionResult: { ok: true }, verified: false, jitter: 22 },
        { name: 'click_at' },
    );
    chk(a, '8g', '画面在动（抖动大）时必须 unverifiable，不能冒充 confirmed/noop',
        jitter.effect === 'unverifiable' && jitter.verified === null, 'effect=' + jitter.effect + ' verified=' + jitter.verified);
    chk(a, '8h', '抖动状态下必须把 jitter 数值带出来（调用方要能判断为什么验不了）', jitter.jitter === 22, 'jitter=' + jitter.jitter);

    return {
        assertions: a,
        notes: ['这一条是整套治理的核心：以前「动作返回 ok」就算成功；现在「画面没变」必须落成 suspected_noop。'],
    };
}

// 9. 契约一致性扫描（不变量）
async function case9() {
    const a = [];
    const notes = [];

    // 9-A：六个工厂的默认产出
    const factories = {
        'VC.confirmed()': VC.confirmed('x'),
        'VC.idempotent()': VC.idempotent('x'),
        'VC.failed()': VC.failed('x'),
        'VC.unverified()': VC.unverified('x'),
        'VC.readonly()': VC.readonly('x'),
        'VC.notSent()': VC.notSent('x'),
    };
    const badA = [];
    for (const [k, r] of Object.entries(factories)) {
        for (const it of violations(r, k)) badA.push(Object.assign({}, it, { effect: r.effect }));
    }
    chk(a, '9a', '六个工厂的默认产出满足不变量', badA.length === 0,
        badA.length ? badA.map((x) => x.msg).join(' ; ') : 'OK');

    // 9-B：fromActAndVerify 全组合
    const seen = new Set();
    const combos = [];
    for (const verified of [true, false]) {
        for (const changed of [true, false]) {
            for (const arOk of [true, false, undefined]) {
                for (const jitter of [undefined, 22]) {
                    for (const note of ['', '拍不到画面']) {
                        const av = { verified, changed, dist: changed ? 42 : 2, elapsed: 300 };
                        if (arOk !== undefined) av.actionResult = { ok: arOk, name: 'actAndVerify' };
                        if (jitter !== undefined) av.jitter = jitter;
                        if (note) av.note = note;
                        const key = JSON.stringify(av);
                        if (seen.has(key)) continue;
                        seen.add(key);
                        combos.push(av);
                    }
                }
            }
        }
    }
    const badB = [];
    for (const av of combos) {
        const desc = 'fromActAndVerify(' + JSON.stringify(av) + ')';
        const r = VC.fromActAndVerify(av, { name: 'click_at' });
        for (const it of violations(r, desc)) badB.push(Object.assign({}, it, { effect: r.effect }));
    }
    chk(a, '9b', 'fromActAndVerify 全组合（' + combos.length + ' 组）满足不变量', badB.length === 0,
        badB.length ? ('违反 ' + badB.length + ' 处，归并为 ' + summarizeViolations(badB).length + ' 类（明细见下方 ·）') : 'OK');
    for (const g of summarizeViolations(badB)) {
        notes.push('[契约矛盾:' + g.kind + '｜effect=' + g.effect + '] 共 ' + g.count + ' 组。代表：' + g.sample.msg);
    }

    // 只报告、不判 FAIL：契约允许 extra 覆盖 action_sent —— 生产代码目前没这么调，
    // 但这是个潜在暗门（谁传错一次就会得到「confirmed + action_sent:false」的自相矛盾结果）。
    const hole1 = VC.confirmed('x', { action_sent: false });
    const hole2 = VC.notSent('x', { action_sent: true });
    notes.push('潜在暗门（不判 FAIL，因为生产代码没有这种调用）：extra 可以覆盖 action_sent —— ' +
        'VC.confirmed("x",{action_sent:false}) → effect=' + hole1.effect + ',action_sent=' + hole1.action_sent +
        '；VC.notSent("x",{action_sent:true}) → effect=' + hole2.effect + ',action_sent=' + hole2.action_sent +
        '。建议工厂函数把 action_sent 从 extra 里剥掉（不改契约，只是加固）。');
    notes.push('语义小瑕疵：notSent() 的 verified=null → unverified=true（表示「不知道」），' +
        '但「根本没发出去」其实是确定的否定。调用方必须同时看 action_sent:false 才不会误判。');
    return { assertions: a, notes };
}

// 10. 附加：wgc_hash 抓不存在的窗口（只读通道也不能假成功）
async function case10() {
    const a = [];
    if (!fs.existsSync(CORE)) return { skip: 'pet-core.exe 不存在，WGC 不可用' };
    const res = await GC.runGameAction('wgc_hash', 'REGRESS_NO_SUCH_HASH_' + process.pid, null, null, null);
    chk(a, '10a', 'ok:false / not_sent', res.ok === false && res.effect === 'not_sent', JSON.stringify(res).slice(0, 260));
    chk(a, '10b', 'action_sent 必须是 false', res.action_sent === false, 'action_sent=' + res.action_sent);
    chk(a, '10c', '原因必须说明「没找到窗口」', /没找到窗口/.test(String(res.detail)), res.detail);
    return { assertions: a };
}

// 11. 只读 batch 的成功路径（2026-11-10 补盲：原来回归只测 batch 的失败分支）
async function case11() {
    const a = [];
    const plan = { steps: [{ action: 'list_windows', arg: '' }, { action: 'list_windows', arg: '' }] };
    const res = await GC.runGameAction('batch', JSON.stringify(plan), null, null, null);
    chk(a, '11a', '只读 batch 成功路径 ok:true', res.ok === true, JSON.stringify(res).slice(0, 260));
    chk(a, '11b', '两步都执行（executed=2）', res.executed === 2, 'executed=' + res.executed);
    chk(a, '11c', 'effect 必须是 readonly（不是 confirmed）', res.effect === 'readonly', 'effect=' + res.effect);
    chk(a, '11d', '结果里带每步明细且每步 ok', Array.isArray(res.results) && res.results.length === 2 && res.results.every((x) => x.ok === true), 'results=' + ((res.results || []).length));
    chk(a, '11e', '只读 batch 不得标 action_sent:true', res.action_sent !== true, 'action_sent=' + res.action_sent);
    return { assertions: a };
}

// 12. 限速分档（2026-11-10 补盲：原来只测「被拒」，不测「放行到哪一档」）
async function case12() {
    const a = [];
    const realNow = Date.now;
    let fake = realNow.call(Date);
    Date.now = () => fake;
    try {
        // 非游戏态：冷 300ms、上限 20/分钟
        fake += 61000;
        let okCount = 0;
        let msg = '';
        for (let i = 0; i < 21; i += 1) {
            fake += 301;
            msg = GC.rateGate();
            if (!msg) okCount += 1;
        }
        chk(a, '12a', '非游戏限速：前 20 次放行', okCount === 20, '放行 ' + okCount + ' 次');
        chk(a, '12b', '第 21 次被 20/分钟上限拦住', /20/.test(String(msg)) && /上限|太多/.test(String(msg)), msg);
        // 冷却：60s 清窗后，第一条必过、紧接着第二条必拒
        fake += 61000;
        const first = GC.rateGate();
        const second = GC.rateGate();
        chk(a, '12c', '300ms 冷却生效（第一条过、第二条拒）', first === null && /300ms|太快/.test(String(second)), 'first=' + first + ' second=' + second);
        // 游戏态：只保留 600/分钟上限，无冷却
        fake += 61000;
        let gameOk = 0;
        let gameMsg = '';
        for (let i = 0; i < 601; i += 1) {
            gameMsg = GC.rateGateGame();
            if (!gameMsg) gameOk += 1;
        }
        chk(a, '12d', '游戏态 600/分钟上限（前 600 次放行）', gameOk === 600, '放行 ' + gameOk + ' 次');
        chk(a, '12e', '第 601 次被游戏上限拦住', /600/.test(String(gameMsg)), gameMsg);
    } finally {
        Date.now = realNow;
    }
    return { assertions: a };
}

// 13. 否决码表（2026-11-10 四十轮，抄 rust_core_prototype/ipc/protocol.rs）
async function case13() {
    const a = [];
    const V = GC.VETO || {};
    chk(a, '13a', '否决码 1001 焦点丢失', V.FOCUS_LOST === 1001, 'FOCUS_LOST=' + V.FOCUS_LOST);
    chk(a, '13b', '否决码 1002 落点遮挡', V.TARGET_OCCLUDED === 1002, 'TARGET_OCCLUDED=' + V.TARGET_OCCLUDED);
    chk(a, '13c', '否决码 1005 急停/UAC', V.EMERGENCY_STOP === 1005, 'EMERGENCY_STOP=' + V.EMERGENCY_STOP);
    chk(a, '13d', '否决码 1008 窗口销毁', V.WINDOW_DESTROYED === 1008, 'WINDOW_DESTROYED=' + V.WINDOW_DESTROYED);
    return { assertions: a };
}

// 14. 同键连点 noop 根治（2026-11-10 四十轮续）：PVZ plant/auto 改用点击点 ±110 的
//     局部灰度对比；全屏 9×8 对「另一格种一株」这种局部变化是盲区（第二下常报 noop）。
async function case14() {
    const a = [];
    // 14a/14b：regionDelta 纯逻辑——全屏哈希看不见的单格变化必须能被抓到
    const base = { gray: new Array(120).fill(100), mean: 100, std: 0 };
    const oneCell = { gray: base.gray.slice(), mean: 100, std: 1 };
    oneCell.gray[57] = 108;
    const d = GC.regionDelta(base, oneCell);
    chk(a, '14a', '局部单格 +8 能被 regionDelta 检出', d && d.maxCell === 8, JSON.stringify(d));
    const same = GC.regionDelta(base, { gray: base.gray.slice(), mean: 100, std: 0 });
    chk(a, '14b', '完全相同 → maxCell 0（不误报）', same && same.maxCell === 0, JSON.stringify(same));
    // 14c/14d：静态接线守卫——plant/auto 的 actAndVerify 必须带 region，防止以后被改回全屏
    const src = fs.readFileSync(path.join(DISPATCH, 'game-control.js'), 'utf8');
    const plantBlock = src.slice(src.indexOf("pvzSub === 'plant'"), src.indexOf("pvzSub === 'auto'"));
    const autoBlock = src.slice(src.indexOf("pvzSub === 'auto'"), src.indexOf("pvzSub === 'slot'"));
    chk(a, '14c', 'pvz plant 的 actAndVerify 带 region', /actAndVerify\([\s\S]*?region:\s*\{/.test(plantBlock), 'plantBlock=' + plantBlock.length);
    chk(a, '14d', 'pvz auto 的 actAndVerify 带 region', /actAndVerify\([\s\S]*?region:\s*\{/.test(autoBlock), 'autoBlock=' + autoBlock.length);
    return { assertions: a };
}

const CASES = [
    { name: 'click_at：坐标越界 / 格式非法必须拒绝', run: case1, timeoutMs: 20000 },
    { name: 'click_at：坐标在 focus 窗口外 → 必须拒绝且报告真实窗口范围', run: case2, timeoutMs: 60000 },
    { name: 'click_at：目标非前台且聚焦失败 → notSent 且 action_sent=false（不许发点击）', run: case3, timeoutMs: 40000 },
    { name: 'click_text：找不到文字 → notSent + ocrSaw 诚实报告', run: case4, timeoutMs: 70000 },
    { name: 'wgc_shot：抓不存在的窗口 → ok:false 且有可读原因', run: case5, timeoutMs: 30000 },
    { name: 'wgc_shot：抓最小化窗口 → ok:false 且说明「最小化」', run: case6, timeoutMs: 40000 },
    { name: 'click_element / som_click：编号不存在必须失败', run: case7, timeoutMs: 20000 },
    { name: '契约自检：动作成功但画面没变 → suspected_noop（不是 confirmed）', run: case8, timeoutMs: 10000 },
    { name: '契约一致性扫描：effect 与 action_sent 的不变量', run: case9, timeoutMs: 10000 },
    { name: '附加：wgc_hash 抓不存在的窗口 → 不得 ok:true', run: case10, timeoutMs: 30000 },
    { name: '补盲：只读 batch 成功路径（executed/effect/results）', run: case11, timeoutMs: 30000 },
    { name: '补盲：限速分档（20/分钟 · 300ms · 游戏 600/分钟）', run: case12, timeoutMs: 15000 },
    { name: '四十轮：否决码表 1001-1008 与结果透传', run: case13, timeoutMs: 10000 },
    { name: '同键连点 noop：局部 region 检出 + pvz 接线守卫', run: case14, timeoutMs: 10000 },
];

// ══════════════════════════════════════════════════════════════════════════
// Runner
// ══════════════════════════════════════════════════════════════════════════
(async () => {
    const t0 = Date.now();
    const fg = fs.existsSync(CORE) ? await coreCmd({ cmd: 'fg' }) : null;

    console.log('=== 真假成功回归测试（regress-fake-success.cjs）===');
    console.log('项目     : ' + ROOT);
    console.log('node     : ' + process.version + '  platform=' + process.platform);
    console.log('pet-core : ' + (fs.existsSync(CORE) ? CORE : '缺失（WGC / 窗口用例会 SKIP）'));
    console.log('UIA 服务 : ' + ((await uiaHealth()) ? '运行中 :' + UIA_PORT : '未运行（#2 会 SKIP）'));
    console.log('当前前台 : ' + (fg && fg.title ? trunc(fg.title, 60) : '读不到'));
    console.log('说明     : 需要真实窗口的用例会短暂显示一个 2% 透明度的临时窗口（用完即 kill），不点击用户界面。\n');

    let pass = 0;
    let fail = 0;
    let skip = 0;
    const failedItems = [];
    const skippedItems = [];

    for (let i = 0; i < CASES.length; i += 1) {
        const c = CASES[i];
        console.log('[' + (i + 1) + '/' + CASES.length + '] ' + c.name);
        let out;
        try {
            out = await withTimeout(c.run(), c.timeoutMs || 45000, c.name);
        } catch (e) {
            out = { assertions: [{ id: String(i + 1) + 'x', desc: '用例执行异常/超时', pass: false, got: e.message }] };
        }

        if (out && out.skip) {
            skip += 1;
            console.log('  SKIP  ' + out.skip);
            skippedItems.push({ id: String(i + 1), name: c.name, why: out.skip });
            continue;
        }

        const list = (out && out.assertions) || [];
        let casePass = true;
        for (const it of list) {
            const mark = it.pass ? 'PASS' : 'FAIL';
            console.log('  ' + mark + '  ' + it.id + '  ' + it.desc);
            if (it.got) console.log('        got: ' + it.got);
            if (!it.pass) {
                casePass = false;
                failedItems.push({ id: it.id, desc: it.desc, got: it.got });
            }
        }
        for (const n of ((out && out.notes) || [])) console.log('  · ' + n);
        if (list.length === 0) {
            casePass = false;
            console.log('  FAIL  (用例没有产出任何断言)');
            failedItems.push({ id: String(i + 1), desc: '用例没有产出断言', got: '' });
        }
        if (casePass) pass += 1; else fail += 1;
    }

    console.log('\n────────────────────────────────────────────────────────────');
    console.log('汇总: PASS ' + pass + ' / FAIL ' + fail + ' / SKIP ' + skip + '  （用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
    if (skippedItems.length) {
        console.log('\nSKIP 明细:');
        for (const s of skippedItems) console.log('  - [' + s.id + '] ' + s.name + '\n      ' + s.why);
    }
    if (failedItems.length) {
        console.log('\nFAIL 明细:');
        for (const f of failedItems) console.log('  - [' + f.id + '] ' + f.desc + (f.got ? '\n      got: ' + f.got : ''));
    }
    console.log('\n注意：本脚本只报告，不改生产代码。发现的问题见上方 FAIL 明细与中文说明。');

    const code = failedItems.length ? 1 : 0;
    process.exitCode = code;
    // 2026-11-22：汇总打完后进程**不退**（有一个残留句柄/子进程持有 stdout 管道），
    // check-all 用 spawnSync 等 stdout EOF → 实测整条门禁卡在本项 20 分钟。
    // 脚本已经跑完、临时窗口也清理过，这里显式退出（不再等句柄自然释放）。
    try { killAll(); } catch (e) { /* 清理失败也要退 */ }
    setTimeout(() => process.exit(code), 50);
})();
