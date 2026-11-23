#!/usr/bin/env node
/**
 * _probe/test-window-ops.cjs — 窗口生命周期回归（2026-11-15 五十八轮）
 *
 * 为什么要真机测：这一层以前**根本不存在**（只有 focus/launch），而「最小化全部」
 * 映射成 press_key win+d 在 Win 键白名单处必被拒 —— 那条路从来没成功过，
 * 却没有任何测试会发现它（因为没有测试）。
 *
 * 不打扰用户的约定：
 *   · 优先复用**已存在的**普通窗口（默认记事本），不新开窗
 *   · 先记下它的原始 rect/iconic，跑完全部断言后**还原**
 *   · 只有找不到现成窗口时才新起一个记事本，并在结束时关掉它自己起的那个
 *   · 永远不 close 有未保存标记（标题带 *）的窗口
 *
 * 判定：0 = 全过；非 0 = 有失败（check-all 认退出码）
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const GC = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch', 'game-control.js');
const g = require(GC);

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listWin(filter) {
    const r = await g.runGameAction('list_windows', filter || '', null, null, null);
    const arr = (r && Array.isArray(r.windows)) ? r.windows : [];
    // 统一取标题：Rust 路径给 title/MainWindowTitle，UIA 兜底给 name
    return arr.map((w) => Object.assign({}, w, { title: String(w.title || w.MainWindowTitle || w.name || '') }));
}

(async () => {
    const FILTER = 'Notepad';
    let picked = null;
    let spawned = null;
    const mine = (w) => w.title.toLowerCase().includes(FILTER.toLowerCase());
    let wins = (await listWin(FILTER)).filter(mine);
    if (!wins.length) {
        // 没有现成窗口 → 自己起一个（结束时负责关掉）
        spawned = spawn('C:\\Windows\\System32\\notepad.exe', [], { detached: true, stdio: 'ignore', windowsHide: false });
        spawned.unref();
        for (let i = 0; i < 12 && !wins.length; i += 1) { await sleep(500); wins = (await listWin(FILTER)).filter(mine); }
    }
    // 只碰标题里真的含 Notepad 的窗口 —— 绝不碰她自己的窗口（桌宠/字幕）
    picked = wins.find((w) => !w.iconic && !/\*/.test(w.title)) || wins.find((w) => !w.iconic) || wins[0];
    ok('能找到一个可测窗口', !!picked, picked ? ('hwnd=' + picked.hwnd + ' 「' + picked.title + '」 iconic=' + picked.iconic) : '连记事本都没起来');
    if (!picked) { console.error('\n' + pass + '/' + (pass + fail) + ' 全过'); process.exit(1); }

    const hwnd = String(picked.hwnd);
    const run = (spec) => g.runGameAction('window_op', spec, null, null, null);

    // ⚠ 2026-11-15 实测踩到的坑：最小化窗口的 GetWindowRect 是 (-32000,-32000)。
    //   如果直接拿它当「原位置」再加减，move 会把窗口挪到屏幕外（用户只会觉得窗口没了）。
    //   所以：先还原成正常态，再读一次真实 rect 当基准。
    let wasIconic = !!picked.iconic;
    if (wasIconic) {
        await run('restore|' + hwnd);
        await sleep(500);
        const re = (await listWin(FILTER)).find((w) => String(w.hwnd) === hwnd);
        if (re) picked = re;
    }
    const orig = { x: Number(picked.x), y: Number(picked.y), w: Number(picked.w), h: Number(picked.h), iconic: wasIconic, maximized: !!picked.maximized };
    const geomOk = Number.isFinite(orig.x) && Number.isFinite(orig.y) && orig.x > -30000 && orig.y > -30000 && orig.w > 0 && orig.h > 0;
    ok('拿到可用的原始几何（不是 -32000 伪坐标）', geomOk, 'orig=' + JSON.stringify(orig));
    // 最大化窗口的 rect 是负原点（例如 -11,-11，边框在屏幕外）：这是**合法状态**，
    // 不是越界。为了测 move/size 必须先还原成普通窗口，收尾再 max 回去。
    if (orig.maximized) {
        await run('restore|' + hwnd);
        await sleep(400);
        const re = (await listWin(FILTER)).find((w) => String(w.hwnd) === hwnd);
        if (re) { picked = re; orig.x = Number(re.x); orig.y = Number(re.y); orig.w = Number(re.w); orig.h = Number(re.h); }
        ok('最大化窗口已先还原（便于测量几何）', !!(re && re.maximized === false), 'maximized=' + (re && re.maximized));
    }

    // ① min：必须自报 iconic=true
    let r = await run('min|' + hwnd);
    ok('min 成功且自报 iconic=true', r.ok === true && r.iconic === true, 'ok=' + r.ok + ' iconic=' + r.iconic + ' ' + (r.detail || r.error || ''));

    // ② restore：iconic 必须回到 false
    r = await run('restore|' + hwnd);
    ok('restore 成功且 iconic=false', r.ok === true && r.iconic === false, 'iconic=' + r.iconic);

    // ②b 护栏：把窗口挪到 -32000（最小化伪坐标）必须被**拒绝**，
    //     否则窗口会被挪到看不见的地方，用户只会说「我的窗口没了」。
    let guard = '';
    try {
        const rg = await run('move|' + hwnd + '|-31963,-31977');
        guard = (rg && rg.ok === false) ? String(rg.error || rg.detail || '') : '没拦住(r.ok=' + (rg && rg.ok) + ')';
    } catch (e) { guard = String(e && e.message || e); }
    ok('拒绝把窗口挪到屏幕外（-32000 伪坐标）', /哨兵|挪出屏幕/.test(guard), guard);

    // ②c UIA 全文读取（2026-11-15）：原生文本控件应该毫秒级直读，而不是走 4.87s 的 OCR
    const rt = await g.runGameAction('read_text', FILTER, null, null, null);
    ok('read_text 走 UIA 并读到内容', rt.ok === true && rt.via === 'uia-text' && Number(rt.chars) > 0,
        'via=' + rt.via + ' chars=' + rt.chars + ' ms≈' + (/（(\d+)ms）/.exec(String(rt.detail || '')) || [])[1]);

    // ③ move：几何必须真的变
    const nx = orig.x + 37;
    const ny = orig.y + 23;
    r = await run('move|' + hwnd + '|' + nx + ',' + ny);
    ok('move 生效（rect 变了）', r.ok === true && r.rect && r.rect.x === nx && r.rect.y === ny,
        'rect=' + JSON.stringify(r.rect) + ' 期望 x=' + nx + ' y=' + ny);

    // ④ size：尺寸必须真的变（用「与当前不同」的值，否则断言等于自证）
    const nw = Math.max(320, orig.w - 73);
    const nh = Math.max(240, orig.h - 59);
    r = await run('size|' + hwnd + '|' + nw + ',' + nh);
    ok('size 生效（w×h 变了）', r.ok === true && r.rect && r.rect.w === nw && r.rect.h === nh,
        'rect=' + JSON.stringify(r.rect) + ' 期望 ' + nw + 'x' + nh);

    // ⑤ 参数校验：缺参数必须**明确拒绝**，不能静默成功
    let threw = '';
    try { await run('move|' + hwnd); } catch (e) { threw = String(e && e.message || e); }
    ok('move 缺 x,y 会明确报错', /需要 x 和 y/.test(threw), threw || '（没有抛错 —— 危险）');
    threw = '';
    try { await run('nonsense|' + hwnd); } catch (e) { threw = String(e && e.message || e); }
    ok('未知 op 会明确报错', /op 只能是/.test(threw), threw || '（没有抛错 —— 危险）');

    // ⑥ all_min 带过滤：只收匹配的（不能把用户别的窗口一起收走）
    r = await run('all_min|' + FILTER);
    ok('all_min（带过滤）至少收了 1 个', r.ok === true && r.count >= 1, 'count=' + r.count);

    // ⑦ 还原：**先解除最小化再改几何** —— 最小化态下 SetWindowPos 会落到 -32000 伪坐标。
    //   2026-11-15：Cleanup 不再依赖「listWin 里还能看到它」（最小化窗口可能不在枚举结果里）：
    //   无条件先 restore，再 move/size；复核不过就再来一轮。
    const hwndStr = String(hwnd);
    // 收尾必须**断言每一步真的成功**：旧实现吞掉 move 的 ok，于是「护栏拒绝了还原」
    // 在测试里表现成「差几个像素」，看不出来是谁的错。
    let cleanupErrs = [];
    const cleanupGeom = async () => {
        cleanupErrs = [];
        const rr = await run('restore|' + hwndStr).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
        if (!rr || rr.ok !== true) cleanupErrs.push('restore: ' + ((rr && (rr.error || rr.detail)) || 'no-ok'));
        const rm = await run('move|' + hwndStr + '|' + orig.x + ',' + orig.y).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
        if (!rm || rm.ok !== true) cleanupErrs.push('move: ' + ((rm && (rm.error || rm.detail)) || 'no-ok'));
        const rs = await run('size|' + hwndStr + '|' + orig.w + ',' + orig.h).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
        if (!rs || rs.ok !== true) cleanupErrs.push('size: ' + ((rs && (rs.error || rs.detail)) || 'no-ok'));
    };
    await cleanupGeom();
    await sleep(300);
    let chk = (await listWin(FILTER)).find((w) => String(w.hwnd) === hwndStr);
    if (!chk || chk.iconic || chk.x < -1000 || chk.y < -1000) {
        await cleanupGeom();
        await sleep(300);
        chk = (await listWin(FILTER)).find((w) => String(w.hwnd) === hwndStr);
    }
    // 原本是最大化 → 收尾要 max 回去（否则「测完把用户的窗口变成普通大小」是副作用）
    if (orig.maximized) {
        const rm2 = await run('max|' + hwndStr).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
        if (!rm2 || rm2.ok !== true) cleanupErrs.push('max: ' + ((rm2 && (rm2.error || rm2.detail)) || 'no-ok'));
        await sleep(400);
    }
    ok('收尾动作全部成功（不吞 ok）', cleanupErrs.length === 0, cleanupErrs.join(' | '));
    if (orig.iconic) await run('min|' + hwndStr);
    await sleep(300);
    const after = (await listWin(FILTER)).find((w) => String(w.hwnd) === hwndStr);
    // 2026-11-16 修：窗口本来就最小化时，收尾会再 min 一次 —— 此时 rect 必然是 -32000 伪坐标，
    // 拿它和「还原后的原始几何」比永远失败（本次找个已最小化的 Notepad 就踩到了）。
    // 原来的真实状态是「最小化」，正确判据是 iconic 仍为 true。
    // 2026-11-21 修：原本最大化时同理 —— 正确判据是 maximized 仍为 true（rect 是负原点的合法值）。
    const restoredOk = orig.iconic
        ? (!!after && after.iconic === true)
        : (orig.maximized
            ? (!!after && after.maximized === true && after.iconic === false)
            : (!!after && after.x === orig.x && after.y === orig.y && after.w === orig.w && after.h === orig.h));
    ok('已还原现场（' + (orig.iconic ? '保持最小化' : (orig.maximized ? '保持最大化' : '位置尺寸与初始一致')) + '）', restoredOk,
        after ? ('iconic=' + after.iconic + ' maximized=' + after.maximized + ' rect=' + after.x + ',' + after.y + ' ' + after.w + 'x' + after.h + ' / 原始 ' + orig.x + ',' + orig.y + ' ' + orig.w + 'x' + orig.h) : '窗口不见了');

    // ⑧ 只有「自己起的、且无未保存标记」才关掉
    if (spawned && after && !/\*/.test(String(after.title || ''))) {
        const cr = await run('close|' + hwnd);
        await sleep(600);
        const gone = !(await listWin(FILTER)).some((w) => String(w.hwnd) === hwnd);
        ok('close 让窗口真的消失（关的是自己起的那个）', cr.ok === true && gone, 'window gone=' + gone);
    } else {
        console.log('  · 跳过 close（窗口不是本次新建的，或标题带 * 有未保存内容）');
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
