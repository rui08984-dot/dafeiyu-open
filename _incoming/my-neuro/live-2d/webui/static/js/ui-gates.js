// ui-gates.js —— WebUI 开关「显示状态 = 运行时闸门」的纯函数（2026-11-23 UI 审计）
//
// 病根（登记在案的三个假开关）：
//   ① 「启用 Function Call 工具」写 config.tools.enabled —— 运行时没人读
//      （插件开关的唯一真相源是 plugins/enabled_plugins.json）→ 本文件不提供它，控件已移除。
//   ② 动作模式下拉框在 petbody 形态下整段短路（js/ai/motion-director.js isPetBodyTakeover），
//      写 motion_director.enabled 更是运行时明确忽略的键 → 由 motionModeGate() 按
//      ui.model_type 统一判定，前端据此禁用控件并显示原因。
//   ③ 字幕开关：运行时 js/ui/ui-controller.js 只在 subtitle_labels.enabled === false 时隐藏，
//      即**缺键按显示**；而 WebUI GET 以前缺键回 False（显示反）→ subtitleEnabledValue()
//      与运行时同源，缺键 = true。
//
// 浏览器：<script> 后挂在 window.UI_GATES；Node/测试：require()。
'use strict';

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.UI_GATES = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function flag(value) {
        return typeof value === 'boolean' ? value : null;
    }

    /**
     * 字幕开关的真实值（与运行时缺省一致：缺键 = 显示）。
     * 兼容 WebUI GET 的平铺字段、根级 subtitle_labels、ui.subtitle_labels 三种形状。
     */
    function subtitleEnabledValue(data) {
        const d = data && typeof data === 'object' ? data : {};
        const rootLabels = d.subtitle_labels && typeof d.subtitle_labels === 'object' ? d.subtitle_labels : null;
        const uiLabels = d.ui && d.ui.subtitle_labels && typeof d.ui.subtitle_labels === 'object' ? d.ui.subtitle_labels : null;
        for (const block of [rootLabels, uiLabels]) {
            const v = block ? flag(block.enabled) : null;
            if (v !== null) return v;
        }
        const flat = flag(d.subtitle_enabled);
        if (flat !== null) return flat;
        const legacy = flag(d['subtitle-labels-enabled']);
        if (legacy !== null) return legacy;
        // js/ui/ui-controller.js: config.subtitle_labels.enabled === false 才隐藏 → 缺键显示
        return true;
    }

    function avatarModelType(data) {
        const d = data && typeof data === 'object' ? data : {};
        return String(d.avatar_model_type || d.model_type || 'live2d').trim().toLowerCase() || 'live2d';
    }

    /**
     * 动作模式/动作风格是否对当前形态生效。
     * 与运行时同源：js/ai/motion-director.js isPetBodyTakeover() —— petbody 接管渲染时，
     * 编舞产出（参数关键帧）没有 paramDirector 可落，整段短路，语义动作改走 actions-bridge。
     */
    function motionModeGate(data) {
        const type = avatarModelType(data);
        if (type === 'petbody') {
            return {
                effective: false,
                modelType: type,
                reason: '当前是皮套（petbody）形态：运行时 isPetBodyTakeover() 会把编舞/参数导演整段短路，'
                    + '这里的动作模式与动作风格不生效（语义动作走 actions-bridge）。切回 live2d 形态后再调。',
            };
        }
        // 参数导演（global.paramDirector）只在 live2d 运行时里创建（js/avatar/live2d/runtime.js），
        // 编舞的落地点就是它；vrm 形态同样没有可落的参数通道（motion-director 里 !paramDirector 直接 disabled）。
        if (type !== 'live2d') {
            return {
                effective: false,
                modelType: type,
                reason: '当前是 ' + type + ' 形态：编舞依赖 live2d 参数导演（global.paramDirector），'
                    + '这个形态下动作模式与动作风格不会生效。',
            };
        }
        return { effective: true, modelType: type, reason: '' };
    }

    /**
     * 把闸门画到控件上：不生效就禁用 + 就地说明，不在别处再写一份判断。
     * @param {Element|Element[]} selects 需要联动的下拉框（模式/风格）
     * @param {object} data GET /api/settings/ui 的返回
     * @param {Document} [doc] 测试注入
     */
    function applyMotionModeGate(selects, data, doc) {
        const list = (Array.isArray(selects) ? selects : [selects]).filter(Boolean);
        const gate = motionModeGate(data);
        for (const el of list) el.disabled = !gate.effective;
        if (!list.length) return gate;
        const anchor = list[list.length - 1];
        const group = anchor && anchor.parentNode;
        const host = (group && group.parentNode) || group;
        const d = doc || (anchor && anchor.ownerDocument) || (typeof document !== 'undefined' ? document : null);
        let hint = null;
        if (host && typeof host.querySelector === 'function') {
            hint = host.querySelector('[data-ui-gate-hint="motion-mode"]');
        }
        if (!hint && d && typeof d.createElement === 'function' && host && typeof host.insertBefore === 'function') {
            hint = d.createElement('div');
            hint.setAttribute('data-ui-gate-hint', 'motion-mode');
            hint.className = 'form-note';
            host.insertBefore(hint, (group && group.nextSibling) || null);
        }
        if (hint) {
            hint.textContent = gate.reason || '';
            hint.hidden = gate.effective;
        }
        return gate;
    }

    return { subtitleEnabledValue, motionModeGate, applyMotionModeGate, avatarModelType };
});
