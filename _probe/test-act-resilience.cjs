#!/usr/bin/env node
/**
 * _probe/test-act-resilience.cjs — 操控层韧性单测（2026-11-21）
 *
 * 覆盖 docs/设计-操控层提升-2026-11-21.md 的 P0/P1/P2：
 *   P0-1 1001 → 同 pid focus 一次 → 重发一次（只 1 次；第二次失败不循环；非 1001 不触发）
 *   P0-2 前台判定按 pid（模态对话框与主窗同 pid 不再互斥；不同 pid 仍拒）
 *   P0-3 元素动作三级回落计划（Invoke → Toggle/SelectionItem → coord）
 *   P0-4 act snapshot 与 see tree 同构（同一个 action + arg/focus 形状）
 *   P1-5 #32770 对话框 pane → button/edit 类型补全
 *   P1-6 等 UIA 树稳定（假采样器：两次相同 = stable；变化 = not stable）
 *   P1-7 IsOffscreen / IsEnabled 可见性闸
 *   P2-8 名称归一 + 三级匹配 + ambiguous
 *   P2-9 applyUiVerify（变化=confirmed / 不变=suspected_noop / not_sent 不覆盖 / 采不到=unverifiable）
 *
 * 全部用注入的假依赖，不碰真桌面、不 spawn 任何进程。
 */
'use strict';

const GC = require('../_incoming/my-neuro/live-2d/plugins/community/dispatch/game-control.js');
const DispatchPlugin = require('../_incoming/my-neuro/live-2d/plugins/community/dispatch/index.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail === undefined ? '' : ' —— got ' + JSON.stringify(detail)));
}
function eq(name, got, want) {
    if (got === want) { pass += 1; return; }
    fail += 1;
    console.error('  ✗ ' + name + ' —— got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}

(async () => {
    // ── P0-1：1001 → focus → 重试 ────────────────────────────────────────
    {
        const attempts = [];
        let focusCalls = 0;
        const r = await GC.withAutoFocusRetry(async (attempt) => {
            attempts.push(attempt);
            return attempt === 1
                ? { ok: false, effect: 'not_sent', verified: null, action_sent: false,
                    vetoCode: GC.VETO.FOCUS_LOST, detail: '没点：前台是 QQ', targetPid: 42, fgPid: 77 }
                : { ok: true, effect: 'confirmed', verified: true, action_sent: true, detail: '已在 (5,5) 点击' };
        }, {
            focusFn: async () => {
                focusCalls += 1;
                return { ok: true, pid: 42, hwnd: 900, title: 'Edge', fgTitle: 'Edge', fgPid: 42 };
            },
        });
        ok('1001 → 自动 focus 后重试成功', r.ok === true && r.autoFocus === true && r.attempt === 2, r);
        ok('只重试 1 次（runOnce 恰好 2 次、focus 1 次）', attempts.length === 2 && focusCalls === 1, attempts);
        ok('回执带 firstAttempt + autoFocusEvidence', !!(r.firstAttempt && r.firstAttempt.vetoCode === GC.VETO.FOCUS_LOST
            && r.autoFocusEvidence && r.autoFocusEvidence.pid === 42));
        ok('detail 说明是自动切前台后重试', /自动/.test(String(r.detail || '')), r.detail);
    }
    {
        const attempts = [];
        const r = await GC.withAutoFocusRetry(async (attempt) => {
            attempts.push(attempt);
            return { ok: false, effect: 'not_sent', action_sent: false,
                vetoCode: GC.VETO.FOCUS_LOST, detail: '还是不是前台', targetPid: 42 };
        }, { focusFn: async () => ({ ok: true, pid: 42, hwnd: 900, title: 'Edge', fgTitle: 'Edge', fgPid: 42 }) });
        ok('第二次仍 1001 → 不循环（只 2 次）', attempts.length === 2, attempts);
        ok('第二次失败原样返回（ok:false + stillNotFocused）', r.ok === false && r.stillNotFocused === true, r);
        ok('仍标 autoFocus:true / attempt:2 供审计', r.autoFocus === true && r.attempt === 2);
    }
    {
        let calls = 0, focusCalls = 0;
        const r = await GC.withAutoFocusRetry(async () => {
            calls += 1;
            return { ok: false, effect: 'not_sent', vetoCode: 1002, detail: '被遮挡', targetPid: 42 };
        }, { focusFn: async () => { focusCalls += 1; return { ok: true, pid: 42 }; } });
        ok('非 1001 不触发 focus/重试', calls === 1 && focusCalls === 0 && r.autoFocus === undefined, { calls, focusCalls, r });
    }
    {
        let calls = 0;
        const r = await GC.withAutoFocusRetry(async () => {
            calls += 1;
            return { ok: false, effect: 'not_sent', vetoCode: GC.VETO.FOCUS_LOST, detail: '前台被占', targetPid: 42 };
        }, { focusFn: async () => ({ ok: false, error: '聚焦被系统拒绝' }) });
        ok('focus 失败 → 不重发（calls=1）', calls === 1, calls);
        ok('focus 失败留痕 autoFocusAttempted', r.autoFocusAttempted === true && r.autoFocus === false && /拒绝/.test(r.autoFocusError), r);
    }
    {
        let calls = 0;
        const r = await GC.withAutoFocusRetry(async () => {
            calls += 1;
            return { ok: false, vetoCode: GC.VETO.FOCUS_LOST, autoFocus: true, detail: '已在重试中' };
        }, { focusFn: async () => ({ ok: true, pid: 1 }) });
        ok('已在重试中（autoFocus:true）→ 防御性不再重试', calls === 1 && r.autoFocus === true, calls);
    }

    // ── P0-2：前台判定按 pid ─────────────────────────────────────────────
    {
        const fg = { title: '选择扩展目录。', pid: 100, hwnd: 5000 };
        const same = GC.fgVerdict(fg, { title: '扩展 - 用户配置 1', pid: 100 });
        ok('主窗 + 模态对话框同 pid → 视为前台', same.ok === true && same.matchedBy === 'pid', same);
        ok('证据保留 fgPid/targetPid', same.fgPid === 100 && same.targetPid === 100);
        const other = GC.fgVerdict(fg, { title: '别的应用', pid: 200 });
        ok('不同 pid → 仍拒绝', other.ok === false && other.fgPid === 100 && other.targetPid === 200, other);
        const owned = GC.fgVerdict(fg, { title: 'popup', pid: 100, owned: true });
        ok('owned popup（同 pid）→ 前台 + targetOwned 留痕', owned.ok === true && owned.targetOwned === true, owned);
        ok('hwnd 命中优先', GC.fgVerdict(fg, { hwnd: 5000, pid: 200 }).matchedBy === 'hwnd');
        ok('无 pid 时标题级匹配仍可用', GC.fgVerdict(fg, { title: '扩展' }).ok === true);
        ok('前台传感器失效 → fail-closed', GC.fgVerdict(null, { pid: 1 }).ok === false);

        // 实测补充：Chromium 的 #32770 文件对话框在另一个 msedge.exe 进程里（pid 不同），
        // 但 GW_OWNER 指向主窗口 —— owner 关系必须认，否则「主窗 + 模态」仍互斥。
        const ownedBy = GC.ownerRelationVerdict({ fgHwnd: 1118190, targetHwnd: 13897612, fgOwn: 0, targetOwn: 1118190 });
        ok('目标是前台窗口的 owned popup → 视为前台', ownedBy.ok === true && ownedBy.relation === 'target-owned-by-fg', ownedBy);
        const fgOwned = GC.ownerRelationVerdict({ fgHwnd: 13897612, targetHwnd: 1118190, fgOwn: 1118190, targetOwn: 0 });
        ok('前台是目标的 owned popup（模态对话框盖主窗）→ 视为前台', fgOwned.ok === true && fgOwned.relation === 'fg-owned-by-target', fgOwned);
        const siblings = GC.ownerRelationVerdict({ fgHwnd: 1, targetHwnd: 2, fgOwn: 9, targetOwn: 9 });
        ok('同一 owner 的兄弟窗口 → 视为前台', siblings.ok === true && siblings.relation === 'siblings', siblings);
        const unrelated = GC.ownerRelationVerdict({ fgHwnd: 1, targetHwnd: 2, fgOwn: 7, targetOwn: 8 });
        ok('没有 owner 关系 → 仍拒绝（不做模糊放行）', unrelated.ok === false, unrelated);

        // 2026-11-21 审计（P1）：两个**同 pid、不同 hwnd** 的窗口。UIA 直调同 pid 够用，
        // 但物理输入（SendInput/SetCursorPos）只发给前台窗口 —— strict 必须拒，否则
        // 点击/按键会落到兄弟窗口上。owner 关系由 assertTargetFocused 另行补认。
        const siblingsFg = { title: '窗口 A', pid: 100, hwnd: 5001 };
        const targetB = { title: '窗口 B', pid: 100, hwnd: 5002 };
        ok('non-strict：同 pid 不同窗口仍视为前台（UIA 直调语义）',
            GC.fgVerdict(siblingsFg, targetB).ok === true);
        const strictV = GC.fgVerdict(siblingsFg, targetB, { strict: true });
        ok('strict：同 pid 不同 hwnd → 拒绝（物理输入不误发）',
            strictV.ok === false && strictV.samePid === true && strictV.reason === 'same-pid-different-window', strictV);
        ok('strict：精确 hwnd 仍放行',
            GC.fgVerdict(siblingsFg, { hwnd: 5001, pid: 100 }, { strict: true }).matchedBy === 'hwnd');

        // 同名双窗口的选窗排序（UWP 最小化实测）：CoreWindow 空壳不得压过真窗。
        const ghost = { hwnd: 3477158, class: 'Windows.UI.Core.CoreWindow', title: '计算器', iconic: false, w: 735, h: 1205 };
        const frame = { hwnd: 11472302, class: 'ApplicationFrameWindow', title: '计算器', iconic: true, w: 237, h: 39 };
        const best = GC.pickBestWindow([ghost, frame], '计算器');
        eq('同名双窗口：ApplicationFrameWindow 优先于 UWP 空壳 CoreWindow', best && best.hwnd, 11472302);
        const best2 = GC.pickBestWindow([frame, { hwnd: 9, class: 'Notepad', title: '记事本', iconic: false, w: 800, h: 600 }], '记事本');
        eq('不同标题时仍按标题命中', best2 && best2.hwnd, 9);
    }

    // ── P0-3：三级回落计划 ─────────────────────────────────────────────
    {
        eq('invoke 可用 → 先 invoke，坐标兜底', GC.elementFallbackPlan({ actions: 'invoke,toggle,value' }).join(','), 'invoke,toggle,coord');
        eq('只有 toggle → toggle → select 顺序不越级', GC.elementFallbackPlan({ actions: 'toggle,selectionitem' }).join(','), 'toggle,select,coord');
        eq('ListItem（selectionitem）→ select 档', GC.elementFallbackPlan({ actions: 'selectionitem' }).join(','), 'select,coord');
        eq('无任何 Pattern → 只剩坐标', GC.elementFallbackPlan({ actions: '' }).join(','), 'coord');
        eq('中文逗号/大写不误判', GC.elementFallbackPlan({ actions: 'INVOKE' }).join(','), 'invoke,coord');
        eq('actions 缺失 → 坐标', GC.elementFallbackPlan({}).join(','), 'coord');
    }

    // ── P0-4：act snapshot 与 see tree 同构 ────────────────────────────
    {
        const proto = DispatchPlugin.prototype;
        const seeTree = proto._mapToGameControl.call({}, 'see', { mode: 'tree', window: 'Edge' });
        const actSnap = proto._mapToGameControl.call({}, 'act', { action: 'snapshot', window: 'Edge' });
        eq('同一个底层 action', actSnap.action, seeTree.action);
        eq('arg 同构（window → arg）', actSnap.arg, seeTree.arg);
        eq('focus 同构', actSnap.focus, seeTree.focus);
        const byTarget = proto._mapToGameControl.call({}, 'act', { action: 'snapshot', target: '扩展' });
        eq('act snapshot target → arg', byTarget.arg, '扩展');
        const tools = proto.getTools.call({});
        const actTool = tools.find((t) => t.function && t.function.name === 'act');
        ok('act schema 的 action 枚举含 snapshot', actTool && actTool.function.parameters.properties.action.enum.includes('snapshot'));
        ok('act schema 暴露 verify 参数', !!(actTool && actTool.function.parameters.properties.verify));
    }

    // ── P1-7：IsOffscreen / IsEnabled 闸 ───────────────────────────────
    {
        eq('IsOffscreen=true → element_unavailable', GC.gateElementState({ found: true, offscreen: true, enabled: true }).code, 'element_unavailable');
        eq('IsEnabled=false → element_unavailable', GC.gateElementState({ found: true, offscreen: false, enabled: false }).code, 'element_unavailable');
        ok('可见且启用 → 放行', GC.gateElementState({ found: true, offscreen: false, enabled: true }).ok === true);
        eq('元素失效（找不到）→ stale', GC.gateElementState({ found: false }).code, 'stale');
        ok('状态未知（没探测到）不误拦', GC.gateElementState({}).ok === true);
        ok('reason 是给人看的说明', /IsOffscreen/.test(GC.gateElementState({ found: true, offscreen: true }).reason));
    }

    // ── P1-6：等 UIA 树稳定（假采样器）────────────────────────────────
    {
        let n = 0;
        const stable = await GC.waitUiStable({
            title: 'X', maxWaitMs: 50, intervalMs: 0,
            sampler: async () => (n++ === 0 ? 'n=3|h=aa' : 'n=3|h=aa'),
        });
        ok('连续两次相同 → stable:true', stable.stable === true && stable.samples === 2, stable);
        eq('稳定时带回哈希', stable.hash, 'n=3|h=aa');

        let k = 0;
        const moving = await GC.waitUiStable({
            title: 'X', maxWaitMs: 0, intervalMs: 0,
            sampler: async () => 'n=' + (k++),
        });
        ok('两次不同且超过等待预算 → stable:false（不无限等）', moving.stable === false && moving.samples === 2, moving);

        const none = await GC.waitUiStable({
            title: 'X', maxWaitMs: 10, intervalMs: 0, sampler: async () => null,
        });
        ok('拿不到签名 → stable:null（不可验证，不谎报稳定）', none.stable === null, none);

        const noTarget = await GC.waitUiStable({ title: '', sampler: async () => 'x' });
        eq('没有目标窗口 → no-target', noTarget.reason, 'no-target');
    }

    // ── P1-5：对话框类型补全 ───────────────────────────────────────────
    {
        const btn = GC.classifyDialogElement({ type: 'pane', name: '选择文件夹', actions: 'invoke,legacy' }, '#32770');
        eq('对话框 pane + invoke → button', btn.type, 'button');
        eq('改判留痕 reclassifiedFrom', btn.reclassifiedFrom, 'pane');
        const edit = GC.classifyDialogElement({ type: 'pane', name: '文件夹:', actions: 'value', readonly: false }, '#32770');
        eq('对话框 pane + value → edit', edit.type, 'edit');
        const ro = GC.classifyDialogElement({ type: 'pane', name: '只读', actions: 'value', readonly: true, kids: 0, w: 100, h: 20 }, '#32770');
        eq('只读 value 不误判成 edit（也不会被叶子启发式当成 button）', ro.type, 'pane');
        const plain = GC.classifyDialogElement({ type: 'pane', name: '取消', actions: 'invoke' }, 'Chrome_WidgetWin_1');
        eq('非 #32770 不改类型', plain.type, 'pane');
        const check = GC.classifyDialogElement({ type: 'pane', name: '开发人员模式', actions: 'toggle' }, '#32770');
        eq('toggle 型 pane → button（「开发人员模式」类）', check.type, 'button');
        // 实测（2026-11-21）：经典 Shell 对话框的「选择文件夹」「取消」是**无任何 Pattern 的叶子 pane**
        const leafBtn = GC.classifyDialogElement(
            { type: 'pane', name: '选择文件夹', actions: '', kids: 0, w: 180, h: 40, enabled: true, offscreen: false },
            '#32770',
        );
        eq('无 Pattern 的叶子 pane（按钮形状）→ button', leafBtn.type, 'button');
        eq('启发式留痕 reclassifiedBy', leafBtn.reclassifiedBy, 'dialog-leaf');
        const label = GC.classifyDialogElement(
            { type: 'pane', name: '文件夹:', actions: '', kids: 0, w: 100, h: 20, enabled: true, offscreen: false },
            '#32770',
        );
        eq('标签（冒号结尾）不误判成 button', label.type, 'pane');
        const container = GC.classifyDialogElement(
            { type: 'pane', name: '导航窗格', actions: '', kids: 5, w: 400, h: 600, enabled: true, offscreen: false },
            '#32770',
        );
        eq('有子节点的容器 pane 不误判', container.type, 'pane');
    }

    // ── P2-8：名称归一 + 三级匹配 + ambiguous ──────────────────────────
    {
        eq('去零宽字符', GC.normalizeUiName('保\u200B存\uFEFF'), '保存');
        eq('去 (&H) 快捷键后缀', GC.normalizeUiName('帮助(&H)'), '帮助');
        eq('全角 → 半角（NFKC）', GC.normalizeUiName('ＳＡＶＥ　文件'), 'save 文件');
        eq('大小写归一', GC.normalizeUiName('SAVE'), 'save');

        const items = [{ name: '保存(&S)' }, { name: '保存并关闭' }, { name: '保存' }];
        const exact = GC.matchUiNames(items, '保存');
        eq('精确命中优先于包含', exact.tier, 'exact');
        eq('精确命中唯一', exact.unique && exact.unique.name, '保存');
        const withAccel = GC.matchUiNames(items, '保存(&S)');
        eq('带后缀精确命中', withAccel.unique && withAccel.unique.name, '保存(&S)');
        const desuf = GC.matchUiNames([{ name: '保存并关闭' }, { name: '保存' }], '保存(&S)');
        eq('去后缀级优先于包含级', desuf.tier, 'desuffix');
        eq('去后缀命中唯一', desuf.unique && desuf.unique.name, '保存');
        const amb = GC.matchUiNames([{ name: '确定' }, { name: '确定' }], '确定');
        ok('同名多命中 → ambiguous（unique=null，不猜）', amb.ambiguous === true && amb.unique === null, amb);
        const none = GC.matchUiNames([{ name: '取消' }], '确定');
        eq('没有命中 → tier:null', none.tier, null);
    }

    // ── P2-9：applyUiVerify（沿用 verify-contract 语义）────────────────
    {
        const before = { ok: true, title: '扩展', sig: 'n=10|h=aaaa', element: { name: '开发人员模式', type: 'button' } };
        const after = { ok: true, title: '扩展', sig: 'n=12|h=bbbb' };
        const changed = GC.applyUiVerify({ ok: true, effect: 'unverifiable', verified: null, action_sent: true }, before, after);
        eq('UIA 摘要变化 → effect:confirmed', changed.effect, 'confirmed');
        eq('verified 置 true', changed.verified, true);
        ok('verifyUi.changed 留痕', changed.verifyUi && changed.verifyUi.changed === true, changed.verifyUi);

        const same = GC.applyUiVerify({ ok: true, effect: 'unverifiable', verified: null, action_sent: true }, before, Object.assign({}, before));
        eq('摘要不变 → effect:suspected_noop', same.effect, 'suspected_noop');
        eq('摘要不变 → ok:false（诚实报没效果）', same.ok, false);
        eq('action_sent 保持 true（发了但没效果，不能盲目重试）', same.action_sent, true);

        const notSent = GC.applyUiVerify({ ok: false, effect: 'not_sent', verified: null, action_sent: false }, before, after);
        eq('not_sent 不被 verify 覆盖', notSent.effect, 'not_sent');
        eq('not_sent 的 ok 不被改成 true', notSent.ok, false);

        const uncaptured = GC.applyUiVerify({ ok: true, effect: 'confirmed' }, { ok: false }, { ok: false });
        eq('采不到摘要 → verifyEffect:unverifiable', uncaptured.verifyEffect, 'unverifiable');
        eq('采不到时不改原 effect', uncaptured.effect, 'confirmed');
    }

    // ── 汇总 ───────────────────────────────────────────────────────────
    console.log('  ' + (fail === 0 ? '✅' : '❌') + ' 操控层韧性：PASS ' + pass + ' / FAIL ' + fail);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
