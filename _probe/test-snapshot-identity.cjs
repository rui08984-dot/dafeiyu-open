#!/usr/bin/env node
/**
 * _probe/test-snapshot-identity.cjs — 快照身份与代数（2026-11-24 根因修）回归
 *
 * 病根：#编号属于**某一次**快照，而 UIA_SNAPSHOT_STATE / SOM_STATE 是模块级单例。
 * see 与 click 之间只要有别的东西又拍了一次快照（门禁并发 / watch-screen / 另一回合 /
 * 后台任务），编号就指向另一份快照（很可能是另一个窗口），点击还会「静默成功」。
 *
 * 本测试不碰真实 UIA / 不点鼠标 / 不开 GPU：
 *   · 在 require game-control 之前把 child_process 的 spawn/execFile/execFileSync 换成计数器桩
 *     （任何后端调用都会失败并计数）——「拒绝时必须 0 次点击请求」靠计数判定；
 *   · 用 __testHooks 注入 UIA_SNAPSHOT_STATE / SOM_STATE + 纯函数 checkSnapshotBinding。
 *
 * 判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const path = require('path');
const cp = require('child_process');

const GC = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch', 'game-control.js');

// ── 后端桩：必须在 require game-control 之前替换 ─────────────────────────
const calls = { spawn: 0, execFile: 0, execFileSync: 0 };
function fakeExecFile(...args) {
    calls.execFile += 1;
    const cb = args[args.length - 1];
    if (typeof cb === 'function') {
        process.nextTick(() => cb(Object.assign(new Error('BACKEND-EXECFILE-BLOCKED'), { code: 'BLOCKED' }), '', ''));
    }
    return { stdin: { end() {} }, stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {} };
}
cp.spawn = function () { calls.spawn += 1; throw new Error('BACKEND-SPAWN-BLOCKED'); };
cp.execFile = fakeExecFile;
cp.execFileSync = function () { calls.execFileSync += 1; throw new Error('BACKEND-EXECFILESYNC-BLOCKED'); };

let g = null;
let loadErr = null;
try { g = require(GC); } catch (e) { loadErr = e; }

const fs = require('fs');
const gcSrc = fs.readFileSync(GC, 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); }
    else { fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const counts = () => ({ ...calls });
const unchanged = (before) => calls.spawn === before.spawn && calls.execFile === before.execFile && calls.execFileSync === before.execFileSync;
// 打印**本用例期间**的后端调用增量（累计值会让「0 次」看起来像 1 次）
const deltaText = (before) => '本次调用 spawn=' + (calls.spawn - before.spawn)
    + ' execFile=' + (calls.execFile - before.execFile)
    + ' execFileSync=' + (calls.execFileSync - before.execFileSync);

(async () => {
    console.log('== test-snapshot-identity（纯 Node，后端已桩死）==');
    ok('game-control 可加载', !!g && !loadErr, loadErr ? String(loadErr.message) : 'ok');
    if (!g) { console.error('\n' + pass + '/' + (pass + fail) + ' 全过'); process.exit(1); }

    const H = g.__testHooks;
    ok('暴露 __testHooks.checkSnapshotBinding', !!(H && typeof H.checkSnapshotBinding === 'function'));
    if (!H || typeof H.checkSnapshotBinding !== 'function') {
        console.error('\n' + pass + '/' + (pass + fail) + ' 全过');
        process.exit(1);
    }
    const MAX_AGE = Number(H.snapshotMaxAgeMs) || 120000;
    const STICKY_AGE = Number(H.somStickyMaxAgeMs) || 300000;

    // ── 0. 源码结构：快照写入带身份/代数，snapshot 返回体带 snapshot_id/window ──
    ok('snapshot 写 sid/at/targetHwnd/targetTitle',
        /UIA_SNAPSHOT_STATE\.sid = \+\+_snapshotSid/.test(gcSrc)
        && /UIA_SNAPSHOT_STATE\.at = Date\.now\(\)/.test(gcSrc)
        && /UIA_SNAPSHOT_STATE\.targetHwnd = /.test(gcSrc)
        && /UIA_SNAPSHOT_STATE\.targetTitle = /.test(gcSrc));
    ok('snapshot 返回体带 snapshot_id + window',
        /snapshot_id: UIA_SNAPSHOT_STATE\.sid/.test(gcSrc)
        && /window: \{ hwnd: UIA_SNAPSHOT_STATE\.targetHwnd/.test(gcSrc));
    ok('som_snapshot 也写 sid/at/targetHwnd/targetTitle',
        /SOM_STATE\.sid = \+\+_snapshotSid/.test(gcSrc)
        && /SOM_STATE\.at = Date\.now\(\)/.test(gcSrc)
        && /SOM_STATE\.targetHwnd = /.test(gcSrc)
        && /SOM_STATE\.targetTitle = /.test(gcSrc));
    ok('成功回执追加 snapshot_id / snapshot_age_ms',
        /vr\.snapshot_id = snapBind\.snapshot_id/.test(gcSrc)
        && /vr\.snapshot_age_ms = snapBind\.snapshot_age_ms/.test(gcSrc)
        && /vr\.snapshot_id = somBind\.snapshot_id/.test(gcSrc));
    ok('click_element / som_click 都在取编号前做绑定校验',
        /case 'click_element':[\s\S]*?checkSnapshotBinding\(UIA_SNAPSHOT_STATE/.test(gcSrc)
        && /case 'som_click':[\s\S]*?checkSnapshotBinding\(SOM_STATE/.test(gcSrc));
    // 新快照一开始拍就作废旧编号（扫描失败/超时也不例外）
    {
        const at = gcSrc.indexOf("case 'snapshot':");
        const near = at < 0 ? '' : gcSrc.slice(at, at + 4000);
        ok('snapshot 开始即作旧编号', /UIA_SNAPSHOT_STATE\.items = \[\];/.test(near));
        const atSom = gcSrc.indexOf("case 'som_snapshot':");
        const nearSom = atSom < 0 ? '' : gcSrc.slice(atSom, atSom + 3000);
        ok('som_snapshot 开始即作旧编号', /SOM_STATE\.marks = \[\];/.test(nearSom));
    }

    // ── 1. 快照 A 后点 A → 通过，且带 sid ───────────────────────────────
    let stateA = {
        title: '计算器', items: [{ rid: '1-2', name: '七', x: 10, y: 10 }],
        hwnd: 4242, pid: 999, rect: null,
        sid: 11, at: Date.now(), targetHwnd: 4242, targetTitle: '计算器',
    };
    {
        const b = H.checkSnapshotBinding(stateA, { title: '计算器' });
        ok('A→A：绑定通过', b.ok === true, JSON.stringify({ ok: b.ok, sid: b.snapshot_id }));
        ok('A→A：回执可带 sid=11', b.ok && b.snapshot_id === 11, b.ok ? 'sid=' + b.snapshot_id : '');
        ok('A→A：age 是数字且很小', b.ok && Number.isFinite(b.snapshot_age_ms) && b.snapshot_age_ms < 5000, b.ok ? 'age=' + b.snapshot_age_ms + 'ms' : '');
        ok('A→A：window 带回快照目标', b.ok && b.window.hwnd === 4242 && b.window.title === '计算器', b.ok ? JSON.stringify(b.window) : '');
        ok('A→A：matchedBy=title（标题匹配可复核）', b.ok && b.matchedBy === 'title', b.ok ? String(b.matchedBy) : '');
    }

    // 真实动作路径：A→A 不应该被判 STALE（后端桩会失败，但校验必须放行）
    H.reset();
    H.setUiaSnapshotState(stateA);
    {
        const res = await g.runGameAction('click_element', '1', '计算器', null, null);
        ok('A→A 动作未被 STALE_SNAPSHOT 拒绝', !!(res && res.code !== 'STALE_SNAPSHOT' && res.error !== 'STALE_SNAPSHOT'),
            res ? 'code=' + res.code + ' error=' + String(res.error || '').slice(0, 60) : 'no result');
        ok('A→A 尝试后回执里有 sid=11', !!(res && res.snapshot_id === 11), res ? 'sid=' + res.snapshot_id + ' age=' + res.snapshot_age_ms : '');
    }

    // ── 2. 快照 A → 快照 B → 点 A 的编号 → STALE_SNAPSHOT 且不发点击 ──────
    let stateB = {
        title: '设置', items: [{ rid: '9-9', name: '系统', x: 20, y: 20 }],
        hwnd: 777, pid: 888, rect: null,
        sid: 12, at: Date.now(), targetHwnd: 777, targetTitle: '设置',
    };
    {
        H.reset();
        H.setUiaSnapshotState(stateA);
        H.setUiaSnapshotState(stateB);   // 中间被别的快照顶掉（同一模块级单例）
        const before = counts();
        const res = await g.runGameAction('click_element', '1', '计算器', null, null);
        ok('A→B→点A：拒绝码 STALE_SNAPSHOT', !!(res && res.code === 'STALE_SNAPSHOT' && res.ok === false), res ? 'code=' + res.code : 'no result');
        ok('A→B→点A：报的是快照 B 的 sid=12', !!(res && res.snapshot_id === 12), res ? 'sid=' + res.snapshot_id : '');
        ok('A→B→点A：文案说清「快照属于 X（sid=N），你点的是 Y」',
            !!(res && /快照属于/.test(res.detail) && /sid=12/.test(res.detail) && /计算器/.test(res.detail) && /设置/.test(res.detail)),
            res ? String(res.detail).slice(0, 90) : '');
        ok('A→B→点A：一次点击请求都没发', unchanged(before), deltaText(before));
        ok('A→B→点A：nextIfFailed 指向重新 see', !!(res && /重新 see/.test(String(res.nextIfFailed || ''))));
    }
    // 纯函数同样拒绝（无后端也能证明）
    {
        const b = H.checkSnapshotBinding(stateB, { title: '计算器' });
        ok('A→B（纯函数）：reason=window-mismatch', !b.ok && b.code === 'STALE_SNAPSHOT' && b.reason === 'window-mismatch', b.ok ? 'ok' : b.reason);
    }

    // ── 3. 快照超过 120s → STALE_SNAPSHOT ───────────────────────────────
    {
        H.reset();
        H.setUiaSnapshotState({
            title: '计算器', items: [{ rid: '1-2', name: '七', x: 10, y: 10 }],
            hwnd: 4242, pid: 999, rect: null,
            sid: 13, at: Date.now() - (MAX_AGE + 1000), targetHwnd: 4242, targetTitle: '计算器',
        });
        const before = counts();
        const res = await g.runGameAction('click_element', '1', '计算器', null, null);
        ok('超龄快照：拒绝码 STALE_SNAPSHOT', !!(res && res.code === 'STALE_SNAPSHOT'), res ? 'code=' + res.code : 'no result');
        ok('超龄快照：reason=expired', !!(res && res.staleReason === 'expired'), res ? 'reason=' + res.staleReason : '');
        ok('超龄快照：没发点击', unchanged(before), deltaText(before));
        ok('超龄快照：文案带秒数', !!(res && /过期/.test(res.detail) && /秒前/.test(res.detail)), res ? String(res.detail).slice(0, 80) : '');
    }

    // ── 4. 不带窗口 → 按快照自身 hwnd 继续（不拒绝） ─────────────────────
    {
        const b = H.checkSnapshotBinding(stateA, {});
        ok('无窗口：不拒绝', b.ok === true);
        ok('无窗口：usedOwnWindow=true', b.ok && b.usedOwnWindow === true);
        ok('无窗口：沿用快照自身 hwnd=4242', b.ok && b.window.hwnd === 4242, b.ok ? JSON.stringify(b.window) : '');

        H.reset();
        H.setUiaSnapshotState(stateA);
        const before = counts();
        const res = await g.runGameAction('click_element', '1', null, null, null);
        ok('无窗口：动作未被 STALE_SNAPSHOT 拒绝', !!(res && res.code !== 'STALE_SNAPSHOT'), res ? 'code=' + res.code + ' error=' + String(res.error || '').slice(0, 50) : '');
        ok('无窗口：回执仍带 sid=11', !!(res && res.snapshot_id === 11), res ? 'sid=' + res.snapshot_id : '');
        ok('无窗口：确实尝试过（后端有调用）', !unchanged(before), deltaText(before));
    }

    // ── 5. 空快照 → 保持原「先 snapshot」错误 ───────────────────────────
    {
        H.reset();
        let err = null;
        try { await g.runGameAction('click_element', '1', '计算器', null, null); } catch (e) { err = e; }
        ok('空快照：仍是「编号不存在 / 先 snapshot」', !!(err && /编号不存在/.test(err.message)), err ? String(err.message).slice(0, 60) : '没抛错');
    }

    // ── 6. som_click 同样受保护（全局 SoM 编号）──────────────────────────
    {
        H.reset();
        H.setSomState({
            title: '计算器', hwnd: 4242, rect: null, seq: 0,
            sid: 21, at: Date.now(), targetHwnd: 4242, targetTitle: '计算器',
            marks: [{ id: 1, name: '七', x: 10, y: 10, type: 'button' }],
        });
        const before = counts();
        const res = await g.runGameAction('som_click', '1', '设置', null, null);
        ok('som_click 窗口不符：STALE_SNAPSHOT', !!(res && res.code === 'STALE_SNAPSHOT'), res ? 'code=' + res.code : 'no result');
        ok('som_click 窗口不符：没发点击', unchanged(before), deltaText(before));
        ok('som_click 窗口不符：带 snapshot_id=21', !!(res && res.snapshot_id === 21), res ? 'sid=' + res.snapshot_id : '');
    }
    {
        H.reset();
        H.setSomState({
            title: '计算器', hwnd: 4242, rect: null, seq: 0,
            sid: 22, at: Date.now() - (STICKY_AGE + 5000), targetHwnd: 4242, targetTitle: '计算器',
            marks: [{ id: 1, name: '七', x: 10, y: 10, type: 'button' }],
        });
        const before = counts();
        const res = await g.runGameAction('som_click', '1', null, null, null);
        ok('som_click 超龄（>300s 且没带 hwnd）：STALE_SNAPSHOT/expired', !!(res && res.code === 'STALE_SNAPSHOT' && res.staleReason === 'expired'), res ? 'code=' + res.code + ' reason=' + res.staleReason : 'no result');
        ok('som_click 超龄：没发点击', unchanged(before), deltaText(before));
    }
    // 2026-11-25 P2-7：只有「请求带了可验证的同窗 hwnd」才放宽到 300s；不带 hwnd 仍 120s
    {
        H.reset();
        H.setSomState({
            title: '计算器', hwnd: 4242, rect: null, seq: 0,
            sid: 24, at: Date.now() - (MAX_AGE + 5000), targetHwnd: 4242, targetTitle: '计算器',
            marks: [{ id: 1, name: '七', x: 10, y: 10, type: 'button' }],
        });
        const res = await g.runGameAction('som_click', '1', '4242', null, null);
        ok('som_click 125s + 请求带同窗 hwnd：不判 expired（TTL 300s）',
            !!(res && res.code !== 'STALE_SNAPSHOT' && res.error !== 'STALE_SNAPSHOT'),
            res ? 'code=' + res.code + ' error=' + String(res.error || '').slice(0, 50) : 'no result');
    }
    {
        H.reset();
        H.setSomState({
            title: '计算器', hwnd: 4242, rect: null, seq: 0,
            sid: 25, at: Date.now() - (MAX_AGE + 5000), targetHwnd: 4242, targetTitle: '计算器',
            marks: [{ id: 1, name: '七', x: 10, y: 10, type: 'button' }],
        });
        const res = await g.runGameAction('som_click', '1', null, null, null);
        ok('som_click 125s 但不带 hwnd：不放宽，仍 expired',
            !!(res && res.code === 'STALE_SNAPSHOT' && res.staleReason === 'expired'),
            res ? 'code=' + res.code + ' reason=' + res.staleReason : 'no result');
    }
    {
        ok('somClickMaxAgeMs：请求带同窗 hwnd → 300s',
            H.somClickMaxAgeMs({ targetHwnd: 4242 }, { hwnd: 4242 }) === STICKY_AGE,
            String(H.somClickMaxAgeMs({ targetHwnd: 4242 }, { hwnd: 4242 })));
        ok('somClickMaxAgeMs：没带 hwnd → 不放宽，仍 120s',
            H.somClickMaxAgeMs({ targetHwnd: 4242 }, {}) === MAX_AGE
            && H.somClickMaxAgeMs({}, {}) === MAX_AGE,
            String(H.somClickMaxAgeMs({ targetHwnd: 4242 }, {})));
        ok('somClickMaxAgeMs：换了窗口 → 仍 120s',
            H.somClickMaxAgeMs({ targetHwnd: 4242 }, { hwnd: 777 }) === MAX_AGE,
            String(H.somClickMaxAgeMs({ targetHwnd: 4242 }, { hwnd: 777 })));
        ok('somClickMaxAgeMs：传 pid（数字不可验证）→ 仍 120s',
            H.somClickMaxAgeMs({ targetHwnd: 4242, pid: 999 }, { hwnd: 999 }) === MAX_AGE,
            String(H.somClickMaxAgeMs({ targetHwnd: 4242, pid: 999 }, { hwnd: 999 })));
    }
    {
        const b = H.checkSnapshotBinding({
            title: '计算器', hwnd: 4242, sid: 23, at: Date.now(), targetHwnd: 4242, targetTitle: '计算器',
        }, {});
        ok('som_click 新鲜且不带窗口：通过并带 sid=23', b.ok === true && b.snapshot_id === 23, b.ok ? 'sid=' + b.snapshot_id : (b.reason || ''));
    }

    // ── 7. 纯数字目标其实是 pid（第四轮 P2）──────────────────────────────
    // 病根：模型把 pid 当 hwnd/focus 传 → window-mismatch 拒绝 → 「重新 see → 再传 pid」
    // 死循环。现在：值等于快照记过的 pid = 同一进程，不拒绝但明确提示改用 hwnd/标题。
    {
        const b = H.checkSnapshotBinding({
            title: '计算器', hwnd: 4242, pid: 999, targetHwnd: 4242, targetTitle: '计算器',
            sid: 31, at: Date.now(),
        }, { hwnd: 999 });
        ok('pid 当 hwnd：不拒绝（沿用快照窗口）', b.ok === true, b.ok ? 'ok' : b.reason);
        ok('pid 当 hwnd：回执带 identity note',
            !!b.note && b.note.code === 'pid-not-hwnd', JSON.stringify(b.note || null));
        ok('pid 当 hwnd：文案明确「这是 pid，请改用 hwnd 或标题」',
            !!b.note && /pid/.test(b.note.text) && /hwnd/.test(b.note.text) && /标题/.test(b.note.text)
            && /4242/.test(b.note.text), b.note && b.note.text);

        // 真正的不同窗口仍拒绝（不能把「等于 pid」的宽容扩成「数字都对」）
        const b2 = H.checkSnapshotBinding({
            title: '计算器', hwnd: 4242, pid: 999, targetHwnd: 4242, targetTitle: '计算器',
            sid: 32, at: Date.now(),
        }, { hwnd: 5555 });
        ok('既不是 hwnd 也不是 pid：仍 window-mismatch',
            !b2.ok && b2.reason === 'window-mismatch', b2.ok ? 'ok' : b2.reason);
    }

    // ── 8. 标题过短不得仅凭子串放行（第四轮 P2）──────────────────────────
    // 病根：hwnd=0 时只做 title.includes —— 「Q」「计」几乎匹配一切窗口，等于没校验。
    {
        const b1 = H.checkSnapshotBinding({
            title: '计算器', hwnd: 4242, targetHwnd: 4242, targetTitle: '计算器',
            sid: 41, at: Date.now(),
        }, { title: '计' });
        ok('请求标题 <2 字符：identity-unknown（拒绝）',
            !b1.ok && b1.code === 'STALE_SNAPSHOT' && b1.reason === 'identity-unknown',
            b1.ok ? 'ok' : b1.reason);

        const b2 = H.checkSnapshotBinding({
            title: 'Q', hwnd: 0, targetHwnd: 0, targetTitle: 'Q',
            sid: 42, at: Date.now(),
        }, { title: 'QQ' });
        ok('快照自身标题 <2 字符：identity-unknown（拒绝）',
            !b2.ok && b2.reason === 'identity-unknown', b2.ok ? 'ok' : b2.reason);

        const b3 = H.checkSnapshotBinding({
            title: '', hwnd: 0, targetHwnd: 0, targetTitle: '',
            sid: 43, at: Date.now(),
        }, { title: '设置' });
        ok('快照无标题 + 仅标题请求：identity-unknown（拒绝）',
            !b3.ok && b3.reason === 'identity-unknown', b3.ok ? 'ok' : b3.reason);

        const b4 = H.checkSnapshotBinding({
            title: '计算器', hwnd: 4242, targetHwnd: 4242, targetTitle: '计算器',
            sid: 44, at: Date.now(),
        }, { title: '计算器' });
        ok('正常长度标题仍放行（不误伤）', b4.ok === true, b4.ok ? 'ok' : b4.reason);
    }

    // ── 8b. 标题匹配（2026-11-25 P1-2 契约变化）────────────────────────────
    // 旧契约（P2-7）：绑定层只认「精确 / ≥4 字前缀+分隔符」，任意子串一律拒绝。
    // 新契约：解析层与绑定层共用 titleMatchKind：
    //   exact → prefix+boundary（短侧 ≥4）→ substring（短针 ≥2）。
    // 为什么放宽：旧契约下 `see window=QQ` 用子串解析到「QQ音乐」，`act click window=QQ`
    // 绑定却拒绝 → see 成功、click 永远 STALE。现在两层给出同一个答案；
    // 「多命中」由解析层在真实窗口表上判歧义（不猜），绑定层只核对同一窗口。
    {
        ok('标题匹配：QQ vs QQ音乐 → 通过（唯一子串层级，与 see 的解析一致）', H.winTitleMatches('QQ音乐', 'QQ') === true,
            String(H.winTitleMatches('QQ音乐', 'QQ')));
        ok('标题匹配：计算器 vs 计算器 - 标准模式 → 通过（子串层级）',
            H.winTitleMatches('计算器 - 标准模式', '计算器') === true,
            String(H.winTitleMatches('计算器 - 标准模式', '计算器')));
        ok('标题匹配：完全相等 → 通过（「计算器」vs「计算器」）',
            H.winTitleMatches('计算器', '计算器') === true);
        ok('标题匹配：≥4 字 + 前缀 + 分隔符 → 通过',
            H.winTitleMatches('记事本 - 未命名.txt', '记事本 -') === true
            && H.winTitleMatches('Windows 设置', 'windows') === true);
        ok('标题匹配：后缀 → 通过（唯一子串层级；多命中由解析层判歧义）',
            H.winTitleMatches('file.txt - Notepad', 'Notepad') === true);
        ok('标题匹配：前缀无分隔符 → 通过（substring 层级，不再要求 boundary）',
            H.winTitleMatches('SetupHelper', 'Setup') === true);
        ok('标题匹配：1 字针仍拒绝（防「Q」命中一切窗口）',
            H.winTitleMatches('QQ音乐', 'Q') === false);
        // 纯函数：标题匹配成功时回执带 matched（hwnd/title/请求值）
        const bm = H.checkSnapshotBinding({
            title: '记事本 - 未命名.txt', hwnd: 4242, targetHwnd: 4242, targetTitle: '记事本 - 未命名.txt',
            sid: 45, at: Date.now(),
        }, { title: '记事本 -' });
        ok('标题匹配成功：回执 matchedBy=title 且带匹配到的 hwnd/title',
            bm.ok === true && bm.matchedBy === 'title'
            && bm.matched && bm.matched.hwnd === 4242 && /记事本/.test(bm.matched.title)
            && bm.matched.requestedTitle === '记事本 -',
            bm.ok ? JSON.stringify(bm.matched) : bm.reason);
    }

    // ── 8c. pid/hwnd 数字撞车（2026-11-25 P2-7）：先查实时窗口表再决定 ───────
    {
        const collideState = {
            title: '计算器', hwnd: 4242, pid: 999, targetHwnd: 4242, targetTitle: '计算器',
            sid: 51, at: Date.now(),
        };
        const hit = H.checkSnapshotBinding(collideState, { hwnd: 999 }, { liveHwnds: [999, 1234] });
        ok('pid/hwnd 撞车：数字也是真实窗口 → window-mismatch（不冒充 pid）',
            !hit.ok && hit.reason === 'window-mismatch' && hit.pidHwndCollision === true,
            hit.ok ? 'ok' : hit.reason + ' / collision=' + hit.pidHwndCollision);
        const miss = H.checkSnapshotBinding(collideState, { hwnd: 999 }, { liveHwnds: [1234] });
        ok('pid 不是真实窗口 → 宽容并给 identityNote',
            miss.ok === true && miss.matchedBy === 'pid-tolerated'
            && miss.note && miss.note.code === 'pid-not-hwnd',
            miss.ok ? JSON.stringify(miss.note) : miss.reason);
        const unknown = H.checkSnapshotBinding(collideState, { hwnd: 999 });
        ok('实时窗口表查不到 → 保持旧宽容（不误拒）', unknown.ok === true);
    }
    // 真实动作路径：注入「999 确实是另一个窗口」→ 拒发、0 次点击请求
    {
        H.reset();
        H.setLiveHwnds([999, 4242]);
        H.setSomState({
            title: '计算器', hwnd: 4242, pid: 999, rect: null, seq: 0,
            sid: 52, at: Date.now(), targetHwnd: 4242, targetTitle: '计算器',
            marks: [{ id: 1, name: '七', x: 10, y: 10, type: 'button' }],
        });
        const before = counts();
        const res = await g.runGameAction('som_click', '1', '999', null, null);
        ok('动作路径 pid/hwnd 撞车：STALE_SNAPSHOT/window-mismatch',
            !!(res && res.code === 'STALE_SNAPSHOT' && res.staleReason === 'window-mismatch'),
            res ? 'code=' + res.code + ' reason=' + res.staleReason : 'no result');
        ok('动作路径 pid/hwnd 撞车：一次点击请求都没发', unchanged(before), deltaText(before));
    }
    {
        H.reset();
        H.setLiveHwnds([1234]);   // 999 不在实时窗口表里 → 是 pid
        H.setSomState({
            title: '计算器', hwnd: 4242, pid: 999, rect: null, seq: 0,
            sid: 53, at: Date.now(), targetHwnd: 4242, targetTitle: '计算器',
            marks: [{ id: 1, name: '七', x: 10, y: 10, type: 'button' }],
        });
        const res = await g.runGameAction('som_click', '1', '999', null, null);
        ok('动作路径 pid 不是窗口：不判 STALE（继续走后续守卫）',
            !!(res && res.code !== 'STALE_SNAPSHOT' && res.error !== 'STALE_SNAPSHOT'),
            res ? 'code=' + res.code + ' error=' + String(res.error || '').slice(0, 60) : 'no result');
    }

    // ── 9. 结构性接线：som_click 用 300s 上限、SOM_STATE 记 pid ───────────
    {
        ok('som_click 通过 somClickMaxAgeMs 取年龄上限',
            /case 'som_click':[\s\S]*?somClickMaxAgeMs\(SOM_STATE/.test(gcSrc));
        ok('SOM_STATE 记录 pid（识别 pid/hwnd 歧义）',
            /SOM_STATE\.pid\s*=/.test(gcSrc) && /pid:\s*0,\s*marks/.test(gcSrc));
        ok('绑定通过时把 identityNote 带回执',
            /snapBind\.note/.test(gcSrc) && /somBind\.note/.test(gcSrc));
        ok('两条编号路径都先查实时窗口表再绑定（pid/hwnd 撞车）',
            /liveHwndsForCollisionCheck\(UIA_SNAPSHOT_STATE, reqWinHwnd\)/.test(gcSrc)
            && /liveHwndsForCollisionCheck\(SOM_STATE, somReq\.hwnd\)/.test(gcSrc)
            && /liveHwnds: snapLiveHwnds/.test(gcSrc)
            && /liveHwnds: somLiveHwnds/.test(gcSrc));
        ok('回执带 matchedBy / matched_window（怎么匹配到的）',
            /vr\.matchedBy = snapBind\.matchedBy/.test(gcSrc)
            && /vr\.matchedBy = somBind\.matchedBy/.test(gcSrc)
            && /vr\.matched_window = /.test(gcSrc));
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过' + (fail ? '（失败 ' + fail + '）' : ''));
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('测试自身异常：', e && e.stack || e);
    process.exit(1);
});
