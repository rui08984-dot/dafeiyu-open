#!/usr/bin/env node
/**
 * _probe/test-control-verify.cjs — 点击/聚焦的「验证通道」回归（2026-11-25 P0-3）
 *
 * 覆盖审计 docs/research/操控与闸管线-功能审计-2026-11-25.md 的 P0-3 + A4 假成功：
 *   ① UIA 状态变化 → verified:true, method:'uia'（首选通道）
 *   ② UIA 无状态 + 目标元素矩形像素差超阈 → verified:true, method:'pixels'
 *   ③ 遮挡 / 屏外 / 最小化 → ok:false + verified:false + reason（不猜）
 *   ④ region（整窗）变化**不能单独判成功**（本层根本不消费 region 通道）
 *   ⑤ focus_window：SetForegroundWindow 成功但回读不是目标 → ok:false + actual
 *   ⑥ verified:false 绝不置 VC.confirmed（ok 也不能变 true）
 *
 * 约定：全部用注入的假 UIA / 假截图 / 假时钟，不 spawn 任何进程、不碰真桌面。
 * 另加少量**静态**断言（服务端/内核补丁必须真的落地），不启动它们。
 *
 * 判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CV = require('../_incoming/my-neuro/live-2d/plugins/community/dispatch/control-verify.js');
const GC_PATH = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch', 'game-control.js');
const IDX_PATH = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch', 'index.js');
const PS1_PATH = path.join(ROOT, 'pet-runtime', 'tools', 'uia-service.ps1');
const NATIVE_RS = path.join(ROOT, 'pet-core', 'src', 'native.rs');
const MAIN_RS = path.join(ROOT, 'pet-core', 'src', 'main.rs');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name); return true; }
    fail += 1;
    failures.push(name);
    console.error('  ✗ ' + name + (detail === undefined ? '' : ' —— got ' + JSON.stringify(detail)));
    return false;
}
function eq(name, got, want) {
    return ok(name + '（= ' + JSON.stringify(want) + '）', got === want, got);
}
const noSleep = async () => {};

function feat(v, mean) {
    return {
        gray: new Array(120).fill(v),
        mean: mean === undefined ? v / 2 : mean,
        std: 1,
    };
}
const BTN = {
    ok: true, found: true, name: '确定', ctype: 'button',
    enabled: true, offscreen: false, focused: false, iconic: false,
    x: 100, y: 200, w: 80, h: 30,
};

(async () => {
    // ══ A. 状态归一 / 差异比较 ══════════════════════════════════════════
    {
        const b = CV.normState(Object.assign({}, BTN, { toggleState: 'Off' }));
        const a = CV.normState(Object.assign({}, BTN, { toggleState: 'On' }));
        ok('normState：toggleState 归一为小写', b.toggle === 'off' && a.toggle === 'on', [b.toggle, a.toggle]);
        ok('diffState：ToggleState off→on 是变化', CV.diffState(b, a).includes('toggle'), CV.diffState(b, a));
    }
    {
        const b = CV.normState(Object.assign({}, BTN, { value: '555' }));
        const a = CV.normState(Object.assign({}, BTN, { value: '0' }));
        ok('diffState：Value 555→0 是变化', CV.diffState(b, a).includes('value'), CV.diffState(b, a));
    }
    {
        const b = CV.normState(Object.assign({}, BTN, { enabled: true }));
        const a = CV.normState(Object.assign({}, BTN, { enabled: false }));
        ok('diffState：IsEnabled true→false 是变化', CV.diffState(b, a).includes('enabled'), CV.diffState(b, a));
    }
    {
        const b = CV.normState(Object.assign({}, BTN, { x: 100, y: 200 }));
        const a = CV.normState(Object.assign({}, BTN, { x: 140, y: 240 }));
        ok('diffState：单纯矩形移动**不算**变化（动画/滚动不是点击后果）', CV.diffState(b, a).length === 0, CV.diffState(b, a));
    }
    {
        const b = CV.normState(Object.assign({}, BTN, { focused: false }));
        const a = CV.normState(Object.assign({}, BTN, { focused: true }));
        ok('diffState：获得焦点算变化', CV.diffState(b, a).includes('focused'), CV.diffState(b, a));
        ok('diffState：丢失焦点不算变化', CV.diffState(a, b).length === 0, CV.diffState(a, b));
    }
    {
        const b = CV.normState(BTN);
        const a = CV.normState({ ok: false, error: '读不到' });
        ok('diffState：一边读不到（无基线/读失败）不当作变化', CV.diffState(b, a).length === 0, CV.diffState(b, a));
    }
    {
        const b = CV.normState(BTN);
        const a = CV.normState(Object.assign({}, BTN, { name: '取消' }));
        ok('diffState：Name 变化是变化', CV.diffState(b, a).includes('name'), CV.diffState(b, a));
    }

    // ══ B. 可见性三分类 ══════════════════════════════════════════════════
    eq('classifyVisibility：最小化优先', CV.classifyVisibility({ minimized: true, occluded: true }), 'minimized');
    eq('classifyVisibility：屏外', CV.classifyVisibility({ offscreen: true }), 'offscreen');
    eq('classifyVisibility：遮挡', CV.classifyVisibility({ occluded: true }), 'occluded');
    eq('classifyVisibility：都正常 → null', CV.classifyVisibility({}), null);
    ok('windowOnScreens：副屏负坐标窗口在虚拟屏内',
        CV.windowOnScreens({ x: -1800, y: 100, w: 800, h: 600 },
            [{ x: 0, y: 0, w: 1920, h: 1080 }, { x: -1920, y: 0, w: 1920, h: 1080 }]) === true);
    ok('windowOnScreens：完全移出屏幕 → false',
        CV.windowOnScreens({ x: 5000, y: 5000, w: 400, h: 300 },
            [{ x: 0, y: 0, w: 1920, h: 1080 }]) === false);

    // ══ C. verifyClick：UIA 首选 ════════════════════════════════════════
    {
        // 复选框：点击前 Off，点击后 On —— 不需要像素通道
        let sampled = 0;
        let acted = 0;
        const r = await CV.verifyClick({
            before: Object.assign({}, BTN, { toggleState: 'Off' }),
            rect: { x: 100, y: 200, w: 80, h: 30 },
            action: async () => { acted += 1; return { ok: true, how: 'invoke' }; },
            readState: async () => Object.assign({}, BTN, { toggleState: 'On' }),
            sampleRect: async () => { sampled += 1; return feat(10); },
            visibility: async () => ({ minimized: false, offscreen: false, occluded: false }),
            waits: [350, 450], sleep: noSleep,
        });
        eq('UIA 状态变化 → verified', r.verified, true);
        eq('UIA 状态变化 → method=uia', r.method, 'uia');
        eq('UIA 状态变化 → action 只执行一次', acted, 1);
        eq('UIA 已判成功 → 不再采样像素（只取基线 1 次）', sampled, 1);
        ok('UIA 证据里写明变化字段', String(r.evidence).includes('toggle') && r.changedFields.includes('toggle'), r.evidence);
    }
    {
        // 元素点击后消失（按钮变灰/内容重构）→ 也是可观测后果
        const r = await CV.verifyClick({
            before: BTN,
            rect: { x: 100, y: 200, w: 80, h: 30 },
            action: async () => ({ ok: true, how: 'invoke' }),
            readState: async () => ({ ok: false, found: false, error: '元素不存在' }),
            sampleRect: async () => feat(10),
            visibility: async () => ({}),
            waits: [350], sleep: noSleep,
        });
        eq('元素消失 → verified', r.verified, true);
        eq('元素消失 → method=uia', r.method, 'uia');
        ok('元素消失 → changedFields=[found]', JSON.stringify(r.changedFields) === '["found"]', r.changedFields);
    }
    {
        // 遮挡但 UIA 状态确实变了（后台 Invoke 不需要前台）→ UIA 优先，仍算成功
        const r = await CV.verifyClick({
            before: Object.assign({}, BTN, { value: '' }),
            rect: { x: 100, y: 200, w: 80, h: 30 },
            action: async () => ({ ok: true }),
            readState: async () => Object.assign({}, BTN, { value: '7' }),
            sampleRect: async () => feat(10),
            visibility: async () => ({ occluded: true }),
            waits: [350], sleep: noSleep,
        });
        eq('遮挡 + UIA 有变化 → 仍 verified（uia 优先）', r.verified, true);
        eq('遮挡 + UIA 有变化 → method=uia', r.method, 'uia');
    }

    // ══ D. verifyClick：像素为辅（只采目标元素矩形）════════════════════════
    {
        let sampled = 0;
        let rectSeen = null;
        const r = await CV.verifyClick({
            before: BTN,       // 普通按钮：没有任何可观察状态
            rect: { x: 100, y: 200, w: 80, h: 30 },
            action: async () => ({ ok: true, how: 'invoke' }),
            readState: async () => BTN,          // 前后完全一样
            sampleRect: async (rect) => { sampled += 1; rectSeen = rect; return sampled === 1 ? feat(10) : feat(90); },
            visibility: async () => ({ minimized: false, offscreen: false, occluded: false }),
            waits: [350, 450], sleep: noSleep,
        });
        eq('UIA 无状态 + 元素矩形像素差超阈 → verified', r.verified, true);
        eq('UIA 无状态 + 像素差 → method=pixels', r.method, 'pixels');
        ok('像素通道只采传进来的元素矩形（不是整窗）',
            rectSeen && rectSeen.w === 80 && rectSeen.h === 30, rectSeen);
    }
    {
        // 像素差低于阈值 → 不算成功
        const r = await CV.verifyClick({
            before: BTN,
            rect: { x: 100, y: 200, w: 80, h: 30 },
            action: async () => ({ ok: true }),
            readState: async () => BTN,
            sampleRect: async () => feat(10),
            visibility: async () => ({}),
            waits: [350], sleep: noSleep,
            thresholds: { cell: 8, mean: 3.5 },
        });
        eq('像素差低于阈值 → verified=false', r.verified, false);
        eq('像素差低于阈值 → reason=no_change', r.reason, 'no_change');
    }
    {
        // 「别处（region）变了，但目标元素没变」→ 绝不能判成功。
        // 这里用一个会记录调用的 regionChanged 桩：verifyClick 不该碰它。
        let regionCalls = 0;
        const r = await CV.verifyClick({
            before: BTN,
            rect: { x: 100, y: 200, w: 80, h: 30 },
            action: async () => ({ ok: true }),
            readState: async () => BTN,
            sampleRect: async () => feat(10),          // 目标元素像素没变
            regionChanged: () => { regionCalls += 1; return true; },   // 整窗变化（旧实现会据此判成功）
            visibility: async () => ({}),
            waits: [350, 450], sleep: noSleep,
        });
        eq('region 变化但目标无变化 → 不判成功', r.verified, false);
        eq('region 变化但目标无变化 → reason=no_change', r.reason, 'no_change');
        eq('整窗 region 通道根本没被消费', regionCalls, 0);
    }

    // ══ E. verifyClick：遮挡 / 屏外 / 最小化 → 不猜 ══════════════════════
    for (const [sig, want] of [
        [{ occluded: true }, 'occluded'],
        [{ offscreen: true }, 'offscreen'],
        [{ minimized: true }, 'minimized'],
    ]) {
        let afterSamples = 0;
        const r = await CV.verifyClick({
            before: BTN,
            rect: { x: 100, y: 200, w: 80, h: 30 },
            action: async () => ({ ok: true }),
            readState: async () => BTN,       // UIA 也读到了，但状态没变
            sampleRect: async () => { afterSamples += 1; return feat(afterSamples === 1 ? 10 : 200); },
            visibility: async () => sig,
            waits: [350], sleep: noSleep,
        });
        eq(want + ' → ok=false', r.ok, false);
        eq(want + ' → verified=false', r.verified, false);
        eq(want + ' → reason=' + want, r.reason, want);
        eq(want + ' → method=none', r.method, 'none');
        eq(want + ' → 不做动作后像素采样（置信度不足，不猜）', afterSamples, 1);
    }

    // ══ F. verifyClick：通道全不可用 / 动作没发出 ═════════════════════════
    {
        const r = await CV.verifyClick({
            before: null,
            rect: null,
            action: async () => ({ ok: true }),
            readState: async () => ({ ok: false, error: 'uia-service 不可用' }),
            sampleRect: null,
            visibility: async () => null,
            waits: [350], sleep: noSleep,
        });
        eq('两条通道都不可用 → verified=false', r.verified, false);
        eq('两条通道都不可用 → reason=no_channel', r.reason, 'no_channel');
    }
    {
        let acted = 0;
        const r = await CV.verifyClick({
            before: BTN,
            rect: null,
            action: async () => { acted += 1; return { ok: false, error: 'element_unavailable' }; },
            readState: async () => BTN,
            visibility: async () => ({}),
            waits: [350], sleep: noSleep,
        });
        eq('动作 ok:false → reason=action_failed', r.reason, 'action_failed');
        eq('动作 ok:false → actionSent=false', r.actionSent, false);
        eq('动作 ok:false → verified=false', r.verified, false);
        eq('动作 ok:false → 只执行一次', acted, 1);
    }
    {
        let r = null;
        try {
            r = await CV.verifyClick({
                before: BTN,
                rect: null,
                action: async () => { throw new Error('pwsh 挂了'); },
                readState: async () => BTN,
                waits: [350], sleep: noSleep,
            });
        } catch (e) { r = { threw: true }; }
        ok('动作抛错（非守卫）→ 不冒泡，落 action_failed',
            r && r.threw !== true && r.reason === 'action_failed', r);
    }
    {
        // 守卫拒绝必须原样抛出（上层要回「被守卫拦下」，不能伪装成元素点不到）
        let threw = null;
        try {
            await CV.verifyClick({
                before: BTN,
                rect: null,
                action: async () => {
                    const e = new Error('点了「不保存」被守卫拒绝');
                    e.guardBlocked = 'destructive';
                    throw e;
                },
                readState: async () => BTN,
                waits: [350], sleep: noSleep,
            });
        } catch (e) { threw = e; }
        ok('守卫拒绝（guardBlocked）原样抛出', threw && threw.guardBlocked === 'destructive');
    }

    // ══ G. buildClickVerdict：三条文案 + 契约字段 ═════════════════════════
    {
        const v = CV.buildClickVerdict({
            ok: true, verified: true, method: 'uia', reason: null,
            changedFields: ['toggle'], evidence: 'UIA 状态变化：toggle "off"→"on"', actionSent: true,
        }, { name: '静音', howLabel: 'Toggle 直调' });
        eq('uia 判决 → effect=confirmed', v.effect, 'confirmed');
        eq('uia 判决 → ok=true', v.ok, true);
        eq('uia 判决 → verified=true', v.verified, true);
        eq('uia 判决 → method 透传', v.method, 'uia');
        ok('uia 判决文案写「验证通过」', /验证通过/.test(v.detail), v.detail);
    }
    {
        const v = CV.buildClickVerdict({
            ok: true, verified: true, method: 'pixels', reason: null,
            evidence: '目标元素区域像素差 30（阈值 8）', actionSent: true,
        }, { name: '确定', howLabel: 'Invoke 直调' });
        eq('pixels 判决 → effect=confirmed', v.effect, 'confirmed');
        eq('pixels 判决 → method=pixels', v.method, 'pixels');
        ok('pixels 判决文案写「验证通过」', /验证通过/.test(v.detail), v.detail);
    }
    {
        const v = CV.buildClickVerdict({
            ok: false, verified: false, method: 'none', reason: 'occluded',
            evidence: '目标窗口被遮挡', actionSent: true,
        }, { name: '确定' });
        eq('遮挡判决 → ok=false', v.ok, false);
        eq('遮挡判决 → verified=false', v.verified, false);
        eq('遮挡判决 → error=occluded', v.error, 'occluded');
        ok('遮挡判决绝不置 confirmed', v.effect !== 'confirmed', v.effect);
        ok('遮挡判决文案写「没法验证 / 当失败处理」', /没法验证/.test(v.detail) && /失败/.test(v.detail), v.detail);
        ok('遮挡判决带下一步建议', !!v.nextIfFailed);
    }
    {
        const v = CV.buildClickVerdict({
            ok: false, verified: false, method: 'uia', reason: 'no_change', actionSent: true,
        }, { name: '确定' });
        eq('no_change 判决 → effect=suspected_noop', v.effect, 'suspected_noop');
        eq('no_change 判决 → ok=false', v.ok, false);
        eq('no_change 判决 → verified=true（我们确实验了「没变」）', v.verified, true);
    }
    {
        const v = CV.buildClickVerdict({
            ok: false, verified: false, method: 'none', reason: 'action_failed',
            evidence: '底层动作返回 ok:false', actionSent: false,
        }, { name: '确定' });
        eq('动作没发出 → effect=not_sent', v.effect, 'not_sent');
        eq('动作没发出 → action_sent=false', v.action_sent, false);
    }
    {
        // 硬约束：任何 verified:false 的结果都不许带 ok:true / confirmed
        const reasons = ['occluded', 'offscreen', 'minimized', 'no_channel'];
        let bad = 0;
        for (const reason of reasons) {
            const v = CV.buildClickVerdict({
                ok: false, verified: false, method: 'none', reason, actionSent: true,
            }, { name: 'X' });
            if (v.ok !== false || v.verified !== false || v.effect === 'confirmed') bad += 1;
        }
        eq('所有 verified:false 原因都保持 ok:false 且不置 confirmed', bad, 0);
    }

    // ══ H. focus_window：只认 GetForegroundWindow 回读 ═══════════════════
    {
        const j = CV.judgeFocusReadback({ hwnd: 100, title: 'A' }, { hwnd: 100, title: 'A' });
        eq('回读 hwnd 一致 → verified', j.verified, true);
        eq('回读 hwnd 一致 → reason=null', j.reason, null);
    }
    {
        const j = CV.judgeFocusReadback({ hwnd: 100, title: '记事本' }, { hwnd: 200, title: 'QQ音乐' });
        eq('回读 hwnd 不同 → ok=false', j.ok, false);
        eq('回读 hwnd 不同 → reason=not_foreground', j.reason, 'not_foreground');
        eq('回读 hwnd 不同 → actual 是真实前台标题', j.actual, 'QQ音乐');
    }
    {
        const j = CV.judgeFocusReadback({ hwnd: 100, title: 'A' }, null);
        eq('回读不到前台 → reason=no_readback', j.reason, 'no_readback');
        eq('回读不到前台 → verified=false', j.verified, false);
    }
    {
        const v = CV.buildFocusVerdict(
            { ok: true, hwnd: 100, title: '记事本', via: 'pwsh-fallback' },
            { hwnd: 200, title: 'QQ音乐' }, '记事本',
        );
        eq('fw.ok 但前台不符 → ok=false', v.ok, false);
        eq('fw.ok 但前台不符 → verified=false', v.verified, false);
        eq('fw.ok 但前台不符 → reason=not_foreground', v.reason, 'not_foreground');
        eq('fw.ok 但前台不符 → actual', v.actual, 'QQ音乐');
        ok('fw.ok 但前台不符 → 绝不置 confirmed', v.effect !== 'confirmed', v.effect);
    }
    {
        const v = CV.buildFocusVerdict(
            { ok: true, hwnd: 100, title: '记事本', via: 'rust' },
            { hwnd: 100, title: '记事本' }, '记事本',
        );
        eq('fw.ok + 前台一致 → effect=confirmed', v.effect, 'confirmed');
        eq('fw.ok + 前台一致 → verified=true', v.verified, true);
        ok('confirmed 的证据写着回读前台', /回读/.test(String(v.evidence)), v.evidence);
    }
    {
        const v = CV.buildFocusVerdict({ ok: false, unresolved: true, error: '没找到窗口' }, null, '不存在的窗');
        eq('解析不到 → effect=not_sent', v.effect, 'not_sent');
        eq('解析不到 → ok=false', v.ok, false);
    }
    {
        const v = CV.buildFocusVerdict(
            { ok: false, hwnd: 100, title: '记事本', error: 'AttachThreadInput 失败' },
            { hwnd: 200, title: 'ZCode' }, '记事本',
        );
        eq('激活失败 → ok=false', v.ok, false);
        ok('激活失败 → 报告真实前台', /ZCode/.test(String(v.detail)), v.detail);
    }

    // ══ I. 静态断言：补丁真的落地（不启动服务/内核）══════════════════════
    {
        const ps = fs.readFileSync(PS1_PATH, 'utf8');
        ok('uia-service.ps1 有 /element_state 路由', ps.includes("'/element_state'"));
        ok('uia-service.ps1 有 Get-ElementState 实现', /function Get-ElementState/.test(ps));
        ok('element_state 读 Toggle/Value/Selection/Expand 四类状态',
            ps.includes('TogglePattern') && ps.includes('ValuePattern')
            && ps.includes('SelectionItemPattern') && ps.includes('ExpandCollapsePattern'));
        ok('element_state 支持按 Name+ControlType 找元素（SoM 无 rid）',
            /NameProperty, \$nameQuery/.test(ps) && ps.includes('$ctypeQuery'));

        const nat = fs.readFileSync(NATIVE_RS, 'utf8');
        ok('native.rs 有 region_gray_in（可传显示器矩形）', /pub fn region_gray_in/.test(nat));
        ok('native.rs 钳位改用虚拟屏（SM_XVIRTUALSCREEN）',
            /region_gray_in[\s\S]{0,1200}SM_XVIRTUALSCREEN/.test(nat));
        ok('native.rs 不再把 region 坐标 clamp 到主屏左上（x.max(0) 已删）',
            !/let x0 = x\.max\(0\)\.min\(sw - 1\)/.test(nat));
        ok('RegionGrayResult 留痕实际采样矩形', /pub x0: i32/.test(nat) && /pub w0: i32/.test(nat));

        const main = fs.readFileSync(MAIN_RS, 'utf8');
        ok('main.rs 的 region_gray 透传 dx/dy/dw/dh', /req\.dx/.test(main) && /region_gray_in/.test(main));

        const gc = fs.readFileSync(GC_PATH, 'utf8');
        ok('game-control 两条点击路径都走 CV.verifyClick',
            (gc.match(/CV\.verifyClick\(/g) || []).length >= 2);
        ok('click_element 不再用整窗 region + actAndVerifySmart 做点击验证',
            gc.includes('rectFromState') && gc.includes('regionGrayForRect'));
        ok('focus_window 分支改走 CV.buildFocusVerdict（回读后再置 confirmed）',
            /return CV\.buildFocusVerdict\(fw, fgNow, focusTarget\)/.test(gc));
        ok('pwsh 兜底回读 GetForegroundWindow', /GetForegroundWindow\(\)/.test(gc));
        ok('actAndVerifySmart 的 region 变化要先确认前台（regionVeto）',
            gc.includes('regionVeto') && /assertTargetFocused\(o\.uiaTitle/.test(gc));
        ok('region_gray 请求带目标显示器 origin/size', /req\.dx = Math\.round/.test(gc)
            && /req\.dw = Math\.round/.test(gc));

        const idx = fs.readFileSync(IDX_PATH, 'utf8');
        ok('index.js 对 verified:false 记 warn（带 reason）',
            /verified === false/.test(idx) && /验证未通过（verified:false, reason=/.test(idx));
    }

    // ══ 汇总 ═══════════════════════════════════════════════════════════
    console.log('\n' + (fail === 0 ? '✅' : '❌') + ' test-control-verify：' + pass + ' 通过 / ' + fail + ' 失败');
    if (fail) {
        console.error('失败项：\n - ' + failures.join('\n - '));
        process.exit(1);
    }
    process.exit(0);
})().catch((e) => {
    console.error('测试自身抛错：', e && e.stack || e);
    process.exit(2);
});
