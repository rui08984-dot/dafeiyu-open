// ui-controller.js - UI控制模块
const __silentAudit = require('../core/silent-audit.js');
const { ipcRenderer } = require('electron');
const { logToTerminal } = require('../api-utils.js');
const { eventBus } = require('../core/event-bus.js');
const { Events } = require('../core/events.js');
const passthroughPolicy = require('../core/passthrough-policy.js');
const petbodyLayout = require('../core/petbody-layout.js');
const costumeStore = require('../core/costume-store.js');

// Lucide 图标（sprite 在 index.html）：统一用 <use> 引用，颜色跟 currentColor
const ICON = (name, cls = '') => `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

class UIController {
    constructor(config) {
        this.config = config;
        this.subtitleTimeout = null;
        this.bubbleVisible = false;  // 气泡框显示状态
        this.bubbleUpdateInterval = null;  // 气泡框位置更新定时器

        // 气泡框位置平滑处理
        this.bubbleCurrentX = 0;
        this.bubbleCurrentY = 0;
        this.bubbleTargetX = 0;
        this.bubbleTargetY = 0;

        // 字幕位置调整
        this.isAdjustingSubtitle = false;
        this.isDraggingSubtitle = false;
        this.subtitleScale = 1.0;
        this._subtitleCenterX = null;
        this._subtitleCenterY = null;
        this._pttCleanup = null;
        this._cancelActivePTT = null;
    }

    // 初始化UI控制
    initialize() {
        this.setupMouseIgnore();
        this.setupChatBoxEvents();
        this.setupStateIndicators();
    }

    setupStateIndicators() {
        if (!eventBus || !Events) return;
        const aura = document.getElementById('pet-state-aura');
        const iconEl = aura ? aura.querySelector('.aura-icon') : null;
        const textEl = aura ? aura.querySelector('.aura-text') : null;
        const updateAura = (state, active, icon, text) => {
            if (typeof document === 'undefined' || !document.body) return;
            document.body.classList.toggle(`state-${state}`, !!active);
            if (aura && iconEl && textEl && active) {
                iconEl.innerHTML = ICON(icon || 'sparkles');
                textEl.textContent = text || '';
            }
        };
        eventBus.on(Events.ASR_START, () => updateAura('listening', true, 'mic', '倾听中…'));
        eventBus.on(Events.ASR_STOP, () => updateAura('listening', false));
        eventBus.on(Events.LLM_REQUEST_START, () => updateAura('thinking', true, 'brain', '思考中…'));
        eventBus.on(Events.LLM_REQUEST_END, () => updateAura('thinking', false));
        eventBus.on(Events.LLM_RESPONSE, () => updateAura('thinking', false));
        eventBus.on(Events.LLM_ERROR, () => updateAura('thinking', false));
        eventBus.on(Events.TTS_START, () => updateAura('speaking', true, 'volume-2', '说话中…'));
        eventBus.on(Events.TTS_END, () => updateAura('speaking', false));
        eventBus.on(Events.TTS_INTERRUPTED, () => updateAura('speaking', false));
        eventBus.on(Events.TOOL_CALL_START, () => updateAura('acting', true, 'mouse-pointer-2', '操作电脑中…'));
        eventBus.on(Events.TOOL_CALL_END, () => updateAura('acting', false));
    }

    // 设置鼠标穿透
    setupMouseIgnore() {
        // 这些可交互 UI 容器悬停时必须“不穿透”，否则点击会穿过去。
        // 快捷面板(#quick-settings)原本没被纳入判定，只靠模型命中盒蹭——单屏布局下齿轮落在
        // 命中盒外就点不动了。这里统一把它们纳入：鼠标在这些元素上时保持窗口可交互。
        const INTERACTIVE_UI = '#quick-settings, #text-chat-container, #model-controls, #costume-panel';

        // 手动「鼠标穿透」开关的真实状态：主进程托盘/启动时写的是**主进程** global，
        // 渲染进程读不到（旧守卫读渲染进程的 global 标志，条件恒假，等于没守）。
        // 现在从主进程 get-config 读盘状态，按 TTL 缓存；发现开关是开且刚被悬停误关，
        // 会用专用通道重新置上（自愈）。纯判定逻辑在 core/passthrough-policy.js。
        const manualInitial = !!(this.config && this.config.ui && this.config.ui.click_through_default === true);
        this._passGate = passthroughPolicy.createManualPassthroughGate({
            initial: manualInitial,
            read: async () => {
                const result = await ipcRenderer.invoke('get-config');
                if (!result || result.success !== true) throw new Error('get-config failed');
                return !!(result.config && result.config.ui && result.config.ui.click_through_default === true);
            },
            apply: (on) => this._applyIgnoreMouse(on, { manual: true }),
        });
        // 启动先刷一次（不漏掉「启动时配置已开、但主进程之后又改过」的情况）。
        this._passGate.refreshIfStale();
        // 2026-11-23 穿透根治：把手动开关状态同步给主进程（主进程据此决定
        // 「光标进入窗口要不要解除穿透」；手动开=保持穿透，手动关=进入即恢复）。
        try { ipcRenderer.send('pet:passthrough-manual', manualInitial); } catch (e) { /* 通道未就绪不影响 */ }

        const updateMouseIgnore = (e) => {
            if (this.isAdjustingSubtitle) return;
            // 2026-11-24 根因修复（拖动只能拖一小段就停）：
            // 拖动依赖持续的 pointermove/mousemove；而置上 WS_EX_TRANSPARENT 后窗口
            // **收不到任何鼠标事件** → 拖动中途一旦被判为「透明处」就立刻断掉。
            // 这是「穿透判定所依赖的输入被穿透本身破坏」的同一个自指死锁，
            // 因此不是在尾端加 if，而是：**拖动期间根本不许进入穿透**。
            // 拖动标志来自 petbody（window.__pbDragging，带 3s 新鲜度兜底）。
            let dragging = false;
            try {
                dragging = window.__pbDragging === true
                    && (Date.now() - (window.__pbDraggingAt || 0) < 3000);
            } catch (err) { dragging = false; }
            if (dragging) {
                // 已经是可见态就什么都不做；若是穿透态（拖到透明处被切过），立刻恢复。
                if (this._lastIgnoreMouse !== false) this._applyIgnoreMouse(false);
                return;
            }
            // 节流刷新手动开关（最多 1s 一次，不阻塞本次判定）。
            try { this._passGate.refreshIfStale(); } catch (_) { /* 刷新失败不影响悬停 */ }

            const manual = this._passGate.isOn();
            // 皮套模式：用 **alpha 命中测试** 判「鼠标在不在她身上」。
            // 历史：之前这里直接 `if (global.__petBodyActive) return;`——因为老的 Cubism5
            // 渲染器没有 containsPoint，悬停判定永远算成 false 会把窗口切成穿透、点都点不到。
            // 代价是她周围大片透明区域也吃鼠标（窗口挡着却点不到下面的东西 = 遮挡感）。
            // 现在 petBody.hitTest() 用 drawable 顶点做多边形包含判定，能真正区分
            // 「在她身上」和「在她旁边的透明处」——透明处穿透，她身上不穿透。
            let overUI = false;
            if (e) {
                try {
                    const el = document.elementFromPoint(e.clientX, e.clientY);
                    if (el && el.closest && el.closest(INTERACTIVE_UI)) overUI = true;
                } catch (err) { try { __silentAudit.audit('ui-controller.js:57', err); } catch (e2) {} }
            }

            if (global.__petBodyActive) {
                if (!e) return;
                let overHer = false;
                try {
                    const pb = window.petBody;
                    if (pb && typeof pb.hitTest === 'function') overHer = !!pb.hitTest(e.clientX, e.clientY);
                } catch (err) { try { __silentAudit.audit('ui-controller.js:62', err); } catch (e2) {} }
                const decision = passthroughPolicy.decideHoverPassthrough({
                    manualPassthrough: manual,
                    petBodyActive: true,
                    overUI,
                    overHer,
                });
                if (decision.apply) this._applyIgnoreMouse(decision.ignore);
                return;
            }

            if (!global.currentModel) return;

            const facade = global.avatarFacade || window.avatar;
            const controller = facade?.getController?.() || global.modelController;
            const model = facade?.getModel?.() || global.currentModel;
            let overModel = false;
            if (controller && typeof controller.isPointOverInteractive === 'function') {
                overModel = controller.isPointOverInteractive(e.clientX, e.clientY);
            } else if (model && typeof model.containsPoint === 'function') {
                try {
                    overModel = !!model.containsPoint({ x: e.clientX, y: e.clientY });
                } catch (_) { try { __silentAudit.audit('ui-controller.js:85', _); } catch (e2) {} }
            }

            const decision = passthroughPolicy.decideHoverPassthrough({
                manualPassthrough: manual,
                petBodyActive: false,
                hasModel: true,
                overUI,
                overModel,
            });
            if (decision.apply) this._applyIgnoreMouse(decision.ignore);
        };

        /** 统一下发穿透状态（去重：值没变不发 IPC，避免 mousemove 每帧打满通道）。
         *  options.manual=true 时走 `pet:set-ignore-mouse` 专用通道——它不会被
         *  petbody/ui.js 的总闸拦截（总闸只允许用户显式开关把窗口切成穿透）。 */
        this._applyIgnoreMouse = (ignore, options = {}) => {
            const want = !!ignore;
            // 手动穿透每次刷新都重发（幂等），不受悬停去重影响：别的模块可能把它关过一次。
            if (options.manual !== true && this._lastIgnoreMouse === want) return;
            this._lastIgnoreMouse = want;
            try {
                // 2026-11-23 穿透根治：**两条路径统一走专用通道**（pet:set-ignore-mouse）。
                // 旧实现里悬停路径走 set-ignore-mouse-events，会被 petbody/ui.js 总闸拦掉，
                // 导致「透明处穿透」这个功能实际上从没生效过。现在主进程有光标轮询兜底
                //（进入窗口即恢复可见），所以即便置上穿透也不会再出现「永久点不到她」。
                ipcRenderer.send('pet:set-ignore-mouse', { ignore: want, options: { forward: true } });
            } catch (err) { try { __silentAudit.audit('ui-controller.js:101', err); } catch (e2) {} }
        };
        this._win = typeof window !== 'undefined' ? window : null;

        document.addEventListener('mousemove', updateMouseIgnore);
    }

    // 设置聊天框事件
    setupChatBoxEvents() {
        const chatInput = document.getElementById('chat-input');
        const textChatContainer = document.getElementById('text-chat-container');
        const submitBtn = document.getElementById('chat-send-btn');

        if (!chatInput || !textChatContainer || !submitBtn) return;

        // 基础定位样式
        textChatContainer.style.setProperty('position', 'fixed', 'important');
        textChatContainer.style.setProperty('z-index', '10000', 'important');
        // 尺寸不再写死 350：窄窗（皮套 420 宽）按视口撑满，宽窗沿用 350。
        const chatLayout = petbodyLayout.chatBoxSize(window.innerWidth || 420);
        textChatContainer.style.setProperty('width', chatLayout.width + 'px', 'important');
        textChatContainer.style.setProperty('max-width', chatLayout.maxWidth + 'px', 'important');
        textChatContainer.style.setProperty('height', 'auto', 'important');

        // 初始化时立即根据配置设置可见性，避免先显示再隐藏的闪烁
        const shouldShow = this.config.ui && this.config.ui.hasOwnProperty('show_chat_box')
            ? this.config.ui.show_chat_box
            : true;
        if (shouldShow) {
            textChatContainer.style.setProperty('display', 'block', 'important');
            textChatContainer.style.setProperty('visibility', 'visible', 'important');
            textChatContainer.style.setProperty('opacity', '1', 'important');
        } else {
            textChatContainer.style.setProperty('display', 'none', 'important');
            textChatContainer.style.setProperty('visibility', 'hidden', 'important');
            textChatContainer.style.setProperty('opacity', '0', 'important');
        }

        // 巨窗覆盖多屏时，必须锚到主屏右下，不能锚整窗右下（否则对话框会跑到副屏最右侧）。
        const screenInfo = ipcRenderer.sendSync('get-screen-info-sync');
        if (screenInfo?.primaryDisplay && screenInfo?.windowBounds) {
            const { primaryDisplay, windowBounds } = screenInfo;
            const winX = windowBounds.x;
            const winY = windowBounds.y;
            const winH = windowBounds.height;
            const primaryLeftOffset = primaryDisplay.bounds.x - winX;
            const primaryTopOffset = primaryDisplay.bounds.y - winY;
            const primaryBottomOffset = winH - (primaryTopOffset + primaryDisplay.bounds.height);
            // 宿主原算法是为「整屏巨窗」写的：left = 主屏宽 - 350 - 20。
            // 420 宽桌宠窗里会算出 74 并让 350 宽溢出右边缘 4px。
            // 窄窗改成「按窗口宽居中，左右各留 16px」。
            // 窄窗（420 宽桌宠）的定位统一交给 css/styles.css 的 @media 段，
            // 这里不再写内联 !important，否则会和 CSS 打架且互相覆盖。
            const winWidth = window.innerWidth || 420;
            const layout = petbodyLayout.chatBoxSize(winWidth);
            const narrowWin = layout.narrow;
            const rightPos = primaryLeftOffset + primaryDisplay.bounds.width - layout.width - 20;

            if (!narrowWin) {
                textChatContainer.style.setProperty('left', rightPos + 'px', 'important');
            }
            textChatContainer.style.setProperty('right', 'auto', 'important');
            // 窄窗底部由 CSS @media 管；大窗沿用主屏底部偏移。
            if (!narrowWin) {
                textChatContainer.style.setProperty('bottom', (primaryBottomOffset + 50) + 'px', 'important');
            }

            const subtitleContainer = document.getElementById('subtitle-container');
            if (subtitleContainer) {
                // 原实现按「主屏宽 - 800」定位，只在整屏巨窗下成立；桌宠是 420x760 小窗，
                // 那样会把字幕推到窗口外被裁掉。改为按**当前窗口**宽度居中。
                const winW = window.innerWidth || document.documentElement.clientWidth;
                // 窄窗位置交给 CSS @media；这里只处理大窗的居中。
                if (!petbodyLayout.isNarrow(winW)) {
                    subtitleContainer.style.setProperty('position', 'fixed', 'important');
                    subtitleContainer.style.setProperty('left', '50%', 'important');
                    subtitleContainer.style.setProperty('right', 'auto', 'important');
                    subtitleContainer.style.setProperty('width', petbodyLayout.subtitleWidth(winW) + 'px', 'important');
                    subtitleContainer.style.setProperty('max-width', '92%', 'important');
                    subtitleContainer.style.setProperty('transform', 'translateX(-50%)', 'important');
                }
                // 不要强制 display:block —— 那会让空字幕框占位并压住输入框，
                // 显示与否交给 showSubtitle/hideSubtitle 管。
            }
        } else {
            textChatContainer.style.setProperty('left', 'auto', 'important');
            textChatContainer.style.setProperty('right', '20px', 'important');
            textChatContainer.style.setProperty('bottom', '50px', 'important');
        }

        const setMousePassthrough = (ignore, forward = true) => {
            // 2026-11-23：统一走专用通道（旧通道会被 petbody/ui.js 总闸拦掉，
            // 表现为「聊天框内划过就整窗永久穿透/再也点不到」）。
            ipcRenderer.send('pet:set-ignore-mouse', {
                ignore,
                options: { forward }
            });
        };

        let chatPointerDown = false;

        const captureChatMouse = () => {
            setMousePassthrough(false, false);
        };

        const releaseChatMouseForTyping = () => {
            requestAnimationFrame(() => {
                if (chatPointerDown || document.activeElement !== chatInput) return;
                // Keep keyboard focus in the editor, but let video windows underneath keep rendering.
                setMousePassthrough(true, true);
            });
        };

        textChatContainer.addEventListener('mouseenter', captureChatMouse);

        textChatContainer.addEventListener('mouseleave', () => {
            if (chatPointerDown) return;
            setMousePassthrough(true, true);
        });

        const releasePointerCapture = (event) => {
            if (
                event?.pointerId != null &&
                chatInput.hasPointerCapture?.(event.pointerId)
            ) {
                chatInput.releasePointerCapture(event.pointerId);
            }
        };

        const finishChatPointer = (event) => {
            if (!chatPointerDown) return;
            chatPointerDown = false;
            releasePointerCapture(event);
            releaseChatMouseForTyping();
        };

        chatInput.addEventListener('pointerdown', (event) => {
            chatPointerDown = true;
            captureChatMouse();
            chatInput.setPointerCapture?.(event.pointerId);
        });

        document.addEventListener('pointerup', finishChatPointer);
        document.addEventListener('pointercancel', finishChatPointer);

        chatInput.addEventListener('focus', () => {
            captureChatMouse();
            releaseChatMouseForTyping();
        });

        chatInput.addEventListener('blur', () => {
            chatPointerDown = false;
            setMousePassthrough(true, true);
        });
        
    }

    // 显示字幕
    showSubtitle(text, duration = null) {
        // 检查字幕是否启用
        if (this.config && this.config.subtitle_labels && this.config.subtitle_labels.enabled === false) {
            return;
        }

        // 最终展示边界：情绪/动作标签只用于驱动皮套，绝不能显示给用户。
        const displayText = String(text || '')
            .replace(/<[^>]*>/g, '').replace(/<[^<>]*$/g, '')
            .replace(/＜[^＞]*＞/g, '').replace(/＜[^＜＞]*$/g, '');

        // ── 字幕独立窗口模式（决策 2026-11-01：字幕不许画在皮套窗口里）────────
        // ① 原文转发主进程 → 透明副窗；② 文本仍写入 #subtitle-text —— 情绪引擎
        //   watchEmotionSubtitle（petbody-entry.mjs）靠轮询它吃文本，停写会断粮；
        // ③ 容器保持隐藏，皮套窗口里什么都不画（舞台层兜底带也按此标志熄灭）。
        const subWindowMode = !(this.config && this.config.ui && this.config.ui.subtitle_window === false);
        window.__SUBTITLE_WINDOW_MODE = subWindowMode;

        // 清除之前的定时器
        if (this.subtitleTimeout) {
            clearTimeout(this.subtitleTimeout);
            this.subtitleTimeout = null;
        }

        if (subWindowMode) {
            try {
                ipcRenderer.send('subtitle:show', { text: displayText, duration: Number(duration) || 0 });
            } catch (error) {
                console.warn('[subtitle] 转发字幕副窗失败:', error && error.message || error);
            }
            const subEl = document.getElementById('subtitle-text');
            if (subEl) subEl.textContent = displayText;   // 喂情绪引擎（DOM 不可见）
            return;   // duration 由副窗自己的定时器处理
        }

        const container = document.getElementById('subtitle-container');
        const subtitleText = document.getElementById('subtitle-text');

        if (!container || !subtitleText) return;

        subtitleText.textContent = displayText;
        container.style.display = 'block';
        this.applySubtitlePosition();
        container.scrollTop = container.scrollHeight;

        // 如果指定了持续时间，设置自动隐藏
        if (duration) {
            this.subtitleTimeout = setTimeout(() => {
                this.hideSubtitle();
            }, duration);
        }
    }

    // 隐藏字幕
    hideSubtitle() {
        const subWindowMode = window.__SUBTITLE_WINDOW_MODE === true ||
            !(this.config && this.config.ui && this.config.ui.subtitle_window === false);
        if (subWindowMode) {
            try { ipcRenderer.send('subtitle:hide'); } catch (error) {
                console.warn('[subtitle] 转发隐藏失败:', error && error.message || error);
            }
        }

        const container = document.getElementById('subtitle-container');
        if (container) {
            container.style.display = 'none';
        }

        if (this.subtitleTimeout) {
            clearTimeout(this.subtitleTimeout);
            this.subtitleTimeout = null;
        }
    }

    _getActiveAvatarState() {
        const facade = global.avatarFacade || window.avatar;
        return {
            type: facade?.getActiveType?.() || global.currentModel?.modelType || 'live2d',
            model: facade?.getModel?.() || global.currentModel,
            canvas: facade?.getActiveCanvas?.() || document.getElementById('canvas')
        };
    }

    /** 皮套画布在视口中的矩形（适配层缺位的兜底；不假设窗口固定 420×760）。 */
    _getPetBodyCanvasRect() {
        try {
            const canvas = document.querySelector('#live2d-container canvas') || document.getElementById('canvas');
            if (!canvas || typeof canvas.getBoundingClientRect !== 'function') return null;
            const rect = canvas.getBoundingClientRect();
            if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
            return rect;
        } catch (_) {
            return null;
        }
    }

    _getModelScreenPosition() {
        // 皮套渲染器（Cubism5）没有 toGlobal/containsPoint：旧实现到这里直接 return null，
        // 气泡/工具气泡位置永远不更新。用画布 rect 推算锚点（纯函数在 core/petbody-layout）。
        if (global.__petBodyActive) {
            const rect = this._getPetBodyCanvasRect();
            if (rect) return petbodyLayout.petBodyAnchor(rect);
        }
        const { type, model, canvas } = this._getActiveAvatarState();
        if (!model || typeof model.toGlobal !== 'function') return null;

        const point = model.toGlobal({ x: 0, y: 0 });
        const modelX = Number(point?.x);
        const modelY = Number(point?.y);
        if (!Number.isFinite(modelX) || !Number.isFinite(modelY)) return null;

        if (type === 'live2d' && canvas) {
            const canvasRect = canvas.getBoundingClientRect();
            const canvasWidth = Number(canvas.width) || canvasRect.width || 1;
            const canvasHeight = Number(canvas.height) || canvasRect.height || 1;
            return {
                x: canvasRect.left + modelX * (canvasRect.width / canvasWidth),
                y: canvasRect.top + modelY * (canvasRect.height / canvasHeight)
            };
        }

        return { x: modelX, y: modelY };
    }

    _getModelScreenBounds() {
        // 皮套渲染器没有 getScreenHitBox/getBounds：用画布 rect 作为可用边界，
        // 工具气泡才能贴着她显示而不是永远不更新。
        if (global.__petBodyActive) {
            const rect = this._getPetBodyCanvasRect();
            if (rect) return petbodyLayout.petBodyBounds(rect);
        }
        const { model } = this._getActiveAvatarState();
        if (!model) return null;
        let bounds = null;
        try {
            bounds = model.getScreenHitBox?.() || model.getBounds?.() || model.viewRect;
        } catch (_) {
            return null;
        }
        if (!bounds) return null;
        let left = Number.isFinite(bounds.left) ? bounds.left : Number(bounds.x);
        let top = Number.isFinite(bounds.top) ? bounds.top : Number(bounds.y);
        let right = Number.isFinite(bounds.right) ? bounds.right : left + Number(bounds.width);
        let bottom = Number.isFinite(bounds.bottom) ? bounds.bottom : top + Number(bounds.height);
        if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;

        const visibleLeft = Math.max(0, Math.min(window.innerWidth, left));
        const visibleTop = Math.max(0, Math.min(window.innerHeight, top));
        const visibleRight = Math.max(0, Math.min(window.innerWidth, right));
        const visibleBottom = Math.max(0, Math.min(window.innerHeight, bottom));
        if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return null;
        return { left: visibleLeft, top: visibleTop, right: visibleRight, bottom: visibleBottom };
    }

    // 更新气泡框位置，使其跟随模型
    updateBubblePosition() {
        const bubbleContainer = document.getElementById('bubble-container');
        const toolBubblesContainer = document.getElementById('tool-bubbles-container');

        try {
            const position = this._getModelScreenPosition();
            if (!position) return;
            const screenX = position.x;
            const screenY = position.y;

            // 检查值是否有效
            if (screenX === undefined || screenY === undefined || isNaN(screenX) || isNaN(screenY)) {
                return;
            }

            // 平滑插值系数
            const smoothFactor = 0.2;

            // 更新用户手动气泡框位置（如果可见）
            if (this.bubbleVisible && bubbleContainer) {
                // 400/50 是为整屏巨窗写的偏移；420 宽皮套窗里会把她推出窗外。
                // 纯函数 bubbleTarget 做「原点+偏移 → 夹回视口」，宽窗下结果与旧值一致。
                const bubbleRect = bubbleContainer.getBoundingClientRect();
                const target = petbodyLayout.bubbleTarget({
                    modelX: screenX,
                    modelY: screenY,
                    viewportWidth: window.innerWidth,
                    viewportHeight: window.innerHeight,
                    bubbleWidth: bubbleRect.width,
                    bubbleHeight: bubbleRect.height,
                });
                const targetX = target.x;
                const targetY = target.y;

                if (!this._bubbleInitialized) {
                    this.bubbleCurrentX = targetX;
                    this.bubbleCurrentY = targetY;
                    this._bubbleInitialized = true;
                } else {
                    this.bubbleCurrentX += (targetX - this.bubbleCurrentX) * smoothFactor;
                    this.bubbleCurrentY += (targetY - this.bubbleCurrentY) * smoothFactor;
                }

                bubbleContainer.style.left = `${this.bubbleCurrentX}px`;
                bubbleContainer.style.top = `${this.bubbleCurrentY}px`;
            }

            // 更新工具气泡堆叠容器位置 (身体下方)
            if (toolBubblesContainer) {
                const modelBounds = this._getModelScreenBounds();
                const cardRect = toolBubblesContainer.getBoundingClientRect();
                const cardWidth = cardRect.width || 360;
                const cardHeight = cardRect.height || 80;
                const edge = 12;
                let toolTargetX;
                let toolTargetY;
                if (modelBounds) {
                    const bodyCenterX = (modelBounds.left + modelBounds.right) / 2;
                    const bodyCenterY = modelBounds.top + (modelBounds.bottom - modelBounds.top) * 0.42;
                    toolTargetX = bodyCenterX - cardWidth / 2;
                    toolTargetY = bodyCenterY - cardHeight / 2;
                } else {
                    toolTargetX = screenX - cardWidth / 2;
                    toolTargetY = screenY - cardHeight / 2;
                }
                toolTargetX = Math.max(edge, Math.min(toolTargetX, window.innerWidth - cardWidth - edge));
                toolTargetY = Math.max(edge, Math.min(toolTargetY, window.innerHeight - cardHeight - edge));

                if (!this._toolBubblesInitialized) {
                    this.toolBubblesCurrentX = toolTargetX;
                    this.toolBubblesCurrentY = toolTargetY;
                    this._toolBubblesInitialized = true;
                } else {
                    this.toolBubblesCurrentX += (toolTargetX - this.toolBubblesCurrentX) * smoothFactor;
                    this.toolBubblesCurrentY += (toolTargetY - this.toolBubblesCurrentY) * smoothFactor;
                }

                toolBubblesContainer.style.left = `${this.toolBubblesCurrentX}px`;
                toolBubblesContainer.style.top = `${this.toolBubblesCurrentY}px`;
            }

            // 更新歌词气泡位置 (身体左侧或上方)
            const lyricsBubbleContainer = document.getElementById('lyrics-bubble-container');
            if (this.lyricsBubbleVisible && lyricsBubbleContainer) {
                const lyricsOffsetX = -20;  // 再向右移 (原-150)
                const lyricsOffsetY = -20;  // 再向下移 (原-100)
                const lyricsTargetX = screenX + lyricsOffsetX;
                const lyricsTargetY = screenY + lyricsOffsetY;

                if (!this._lyricsBubbleInitialized) {
                    this.lyricsBubbleCurrentX = lyricsTargetX;
                    this.lyricsBubbleCurrentY = lyricsTargetY;
                    this._lyricsBubbleInitialized = true;
                } else {
                    this.lyricsBubbleCurrentX += (lyricsTargetX - this.lyricsBubbleCurrentX) * smoothFactor;
                    this.lyricsBubbleCurrentY += (lyricsTargetY - this.lyricsBubbleCurrentY) * smoothFactor;
                }

                lyricsBubbleContainer.style.left = `${this.lyricsBubbleCurrentX}px`;
                lyricsBubbleContainer.style.top = `${this.lyricsBubbleCurrentY}px`;
            }

        } catch (error) {
            logToTerminal('error', `更新气泡框位置失败: ${error.message}`);
        }
    }

    // 开始气泡框位置追踪
    startBubbleTracking() {
        if (this.bubbleUpdateInterval) {
            clearInterval(this.bubbleUpdateInterval);
        }

        // 每帧更新气泡框位置 (约60fps)
        this.bubbleUpdateInterval = setInterval(() => {
            this.updateBubblePosition();
        }, 16);
    }

    // 停止气泡框位置追踪
    stopBubbleTracking() {
        if (this.bubbleUpdateInterval) {
            clearInterval(this.bubbleUpdateInterval);
            this.bubbleUpdateInterval = null;
        }
    }

    // 显示气泡框
    showBubble() {
        const bubbleContainer = document.getElementById('bubble-container');
        if (!bubbleContainer) {
            logToTerminal('error', '找不到气泡框容器！');
            return;
        }

        this.bubbleVisible = true;
        this._debugLogged = false;
        this._bubbleInitialized = false;  // 重置初始化标志

        // 先立即更新一次位置
        this.updateBubblePosition();

        // 显示气泡框
        bubbleContainer.style.display = 'block';

        // 启动位置追踪
        this.startBubbleTracking();
    }

    // 隐藏气泡框
    hideBubble() {
        const bubbleContainer = document.getElementById('bubble-container');
        if (bubbleContainer) {
            bubbleContainer.style.display = 'none';
            this.bubbleVisible = false;
            this.stopBubbleTracking();  // 停止追踪位置
        }
    }

    // 切换气泡框显示状态
    toggleBubble() {
        if (this.bubbleVisible) {
            this.hideBubble();
        } else {
            this.showBubble();
        }
    }

    // 显示工具调用气泡（堆叠式显示）
    showToolBubble(toolName, parameters = null) {
        const container = document.getElementById('tool-bubbles-container');
        if (!container) return;

        // 启动位置追踪
        if (!this.bubbleUpdateInterval) {
            this.startBubbleTracking();
        }

        // 正文（图标单独渲染，工具名/参数一律走 textContent）
        let bodyText = String(toolName);
        if (parameters && Object.keys(parameters).length > 0) {
            const paramEntries = Object.entries(parameters).slice(0, 2);
            const paramText = paramEntries
                .map(([key, value]) => {
                    const valueStr = String(value);
                    const truncated = valueStr.length > 30 ? valueStr.substring(0, 30) + '...' : valueStr;
                    return `${key}: ${truncated}`;
                })
                .join('\n');
            bodyText += `\n${paramText}`;
        }

        // 创建新的气泡元素：扳手图标 + 标题 + 正文
        const bubble = document.createElement('div');
        bubble.className = 'tool-bubble';
        const head = document.createElement('div');
        head.className = 'tool-bubble-head';
        head.innerHTML = ICON('wrench') + '<span>调用工具</span>';
        const body = document.createElement('div');
        body.className = 'tool-bubble-body';
        body.textContent = bodyText;
        bubble.append(head, body);

        // 添加到容器
        container.appendChild(bubble);

        this._toolBubblesInitialized = false;
        this.updateBubblePosition();

        // 记录工具名称到日志
        logToTerminal('info', `🔧 工具调用: ${toolName}${parameters ? ' 参数: ' + JSON.stringify(parameters) : ''}`);

        // 5秒后移除这个气泡
        setTimeout(() => {
            bubble.classList.add('removing');
            // 等待动画完成后移除DOM
            setTimeout(() => {
                if (bubble.parentNode === container) {
                    container.removeChild(bubble);
                }
            }, 300); // 动画持续时间
        }, 5000);
    }

    // 设置聊天框样式
    setChatStyle(styleNumber) {
        const textChatContainer = document.getElementById('text-chat-container');
        if (!textChatContainer) return;

        // 样式名称映射
        const styleNames = {
            1: '现代毛玻璃',
            2: '可爱卡通',
            3: '极简科技',
            4: '渐变霓虹',
            5: '柔和圆润',
            6: '萌系气泡'
        };

        // 设置data-style属性
        textChatContainer.setAttribute('data-style', styleNumber);

        // 保存到localStorage
        try {
            localStorage.setItem('chatInputStyle', styleNumber);
        } catch (e) {
            console.error('保存聊天框样式失败:', e);
        }

        // 显示提示
        const styleName = styleNames[styleNumber] || '未知';
        this.showSubtitle(`聊天框样式: ${styleName} (样式${styleNumber})`, 2000);

        console.log(`切换到聊天框样式${styleNumber}: ${styleName}`);
    }

    // 设置聊天框可见性
    setupChatBoxVisibility(ttsEnabled, asrEnabled) {
        const textChatContainer = document.getElementById('text-chat-container');
        if (!textChatContainer) return false;

        // 根据配置设置对话框显示状态
        const shouldShowChatBox = this.config.ui && this.config.ui.hasOwnProperty('show_chat_box')
            ? this.config.ui.show_chat_box
            : true;

        if (shouldShowChatBox) {
            textChatContainer.style.setProperty('display', 'block', 'important');
            textChatContainer.style.setProperty('visibility', 'visible', 'important');
            textChatContainer.style.setProperty('opacity', '1', 'important');
            textChatContainer.style.setProperty('pointer-events', 'auto', 'important');
        } else {
            textChatContainer.style.setProperty('display', 'none', 'important');
            textChatContainer.style.setProperty('visibility', 'hidden', 'important');
            textChatContainer.style.setProperty('opacity', '0', 'important');
            textChatContainer.style.setProperty('pointer-events', 'none', 'important');
        }
        textChatContainer.style.setProperty('z-index', '10000', 'important');

        console.log(`聊天框: ${shouldShowChatBox ? '显示' : '隐藏'}`);

        // 调试：确保对话框在可见范围内
        setTimeout(() => {
            const computedStyle = window.getComputedStyle(textChatContainer);
            console.log('对话框调试信息:', {
                display: computedStyle.display,
                position: computedStyle.position,
                bottom: computedStyle.bottom,
                right: computedStyle.right,
                zIndex: computedStyle.zIndex,
                visibility: computedStyle.visibility,
                opacity: computedStyle.opacity
            });
        }, 1000);


        // 从localStorage加载保存的样式
        try {
            const savedStyle = localStorage.getItem('chatInputStyle');
            if (savedStyle && savedStyle >= 1 && savedStyle <= 6) {
                textChatContainer.setAttribute('data-style', savedStyle);
                console.log(`加载保存的聊天框样式: ${savedStyle}`);
            } else {
                // 默认样式1
                textChatContainer.setAttribute('data-style', '1');
            }
        } catch (e) {
            console.error('加载聊天框样式失败:', e);
            textChatContainer.setAttribute('data-style', '1');
        }

        // Alt键切换聊天框显示/隐藏
        // Alt+数字键切换样式
        document.addEventListener('keydown', (e) => {
            // Alt键单独按下：切换聊天框显示/隐藏
            if (e.key === 'Alt' && !e.shiftKey && !e.ctrlKey) {
                e.preventDefault();
                const chatContainer = document.getElementById('text-chat-container');
                if (chatContainer) {
                    const isHidden = window.getComputedStyle(chatContainer).display === 'none';
                    chatContainer.style.setProperty('display', isHidden ? 'block' : 'none', 'important');
                }
            }

            // Alt+1~6：切换聊天框样式
            if (e.altKey && !e.shiftKey && !e.ctrlKey) {
                const num = parseInt(e.key);
                if (num >= 1 && num <= 6) {
                    e.preventDefault();
                    this.setChatStyle(num);
                }
            }
        });

        return shouldShowChatBox;
    }

    // 设置聊天框消息发送
    setupChatInput(voiceChat) {
        const chatInput = document.getElementById('chat-input');
        const chatSendBtn = document.getElementById('chat-send-btn');

        if (!chatInput || !chatSendBtn) return;

        const handleSendMessage = () => {
            const message = chatInput.textContent.trim();
            if (!message) return;

            chatInput.textContent = '';

            // 用户文本先喂情绪引擎（2026-11-16）：引擎本身 1µs/帧，慢的是「文本何时到」。
            // 以前只靠字幕轮询（她自己的字幕还要打完字才稳定），情绪要 5-7 秒后才算出来，
            // 自动长表演因此几乎只在「点击」时出现。这里在提交瞬间就把用户的话喂进去，
            // 情绪在回复开始前就到位 → 说话上升沿可以立即触发。
            try {
                if (global.petBody && typeof global.petBody.feedText === 'function') {
                    global.petBody.feedText(message, 'user');
                }
            } catch (e) { /* 情绪引擎不可用不影响发送 */ }

            // 走 inputRouter.handleTextInput，触发插件 hooks（含 memos 记忆注入）
            if (voiceChat.inputRouter) {
                voiceChat.inputRouter.handleTextInput(message);
            } else {
                voiceChat.sendToLLM(message);
            }
        };

        //新的Enter事件注册，不调用preventDefault，会换行
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleSendMessage();
            }
        });

        chatSendBtn.addEventListener('click', handleSendMessage);
    }

    // 快捷设置面板（齿轮菜单）
    setupQuickPanel(voiceChat, config) {
        const panel = document.getElementById('quick-settings');
        const gear = document.getElementById('quick-gear');
        const items = document.getElementById('quick-settings-items');
        const toggleModeBtn = document.getElementById('btn-toggle-mode');
        const toggleChatBtn = document.getElementById('btn-toggle-chat');
        if (!panel || !items) return;

        let panelOpen = false;

        // 初始化按钮激活状态
        const isPTT = voiceChat.asrController?.asrProcessor?.pttModeEnabled || false;
        toggleModeBtn.classList.toggle('active', isPTT);

        const chatContainer = document.getElementById('text-chat-container');
        const chatVisible = chatContainer && window.getComputedStyle(chatContainer).display !== 'none';
        toggleChatBtn.classList.toggle('active', chatVisible);

        // 「文字输入框」显隐的唯一实现：右键快捷菜单与控制中心能力页（8004 eval）共用，
        // 避免两处各写一套 DOM 逻辑、状态分叉（2026-11-23 统一管辖）。
        const applyChatBoxVisible = (visible) => {
            const box = document.getElementById('text-chat-container');
            if (!box) return false;
            if (visible) {
                box.style.setProperty('display', 'block', 'important');
                box.style.setProperty('visibility', 'visible', 'important');
                box.style.setProperty('opacity', '1', 'important');
                box.style.setProperty('pointer-events', 'auto', 'important');
            } else {
                box.style.setProperty('display', 'none', 'important');
                box.style.setProperty('visibility', 'hidden', 'important');
                box.style.setProperty('opacity', '0', 'important');
                box.style.setProperty('pointer-events', 'none', 'important');
            }
            toggleChatBtn.classList.toggle('active', !!visible);
            return true;
        };
        try { global.__setChatBoxVisible = applyChatBoxVisible; } catch (e) { /* 非 Node 环境忽略 */ }

        // 按钮文案由**实时状态**推导（旧文案是动作名「打字框/按键录音」，
        // 菜单里看不出现在是开还是关）。
        const paintToggleLabels = () => {
            const chatText = toggleChatBtn.querySelector('.quick-item-text');
            if (chatText) chatText.textContent = '打字框：' + (toggleChatBtn.classList.contains('active') ? '开' : '关');
            const pttText = toggleModeBtn.querySelector('.quick-item-text');
            if (pttText) {
                const on = !!(voiceChat.asrController?.asrProcessor?.pttModeEnabled);
                pttText.textContent = '按键录音：' + (on ? '开' : '关');
            }
        };
        paintToggleLabels();

        const closePanel = () => {
            panelOpen = false;
            panel.classList.remove('context-open');
            items.classList.remove('expanded');
            // 字幕在她下一次说话时自然回来（当前条暂不恢复，换菜单可见性）
        };

        const persistQuickSettings = (patch) => {
            ipcRenderer.invoke('save-quick-settings', patch).then(result => {
                if (!result?.success) console.error('保存皮套快捷设置失败:', result?.error || '未知错误');
            }).catch(error => console.error('保存皮套快捷设置失败:', error));
        };

        const pointHitsModel = (x, y) => {
            // petbody（我们的 Cubism5 皮套）没有 PIXI 那套 containsPoint/getScreenHitBox，
            // 直接走"落点是不是在皮套画布上"——比包围盒准，而且不会被透明区域误判。
            if (global.__petBodyActive) {
                const el = document.elementFromPoint(x, y);
                return !!(el && (el.id === 'canvas' || el.closest('#live2d-container')));
            }
            const controller = global.avatarFacade?.getController?.() || global.modelController;
            if (typeof controller?.isPointOverModel === 'function') {
                try { return Boolean(controller.isPointOverModel(x, y)); } catch (_) { try { __silentAudit.audit('ui-controller.js:782', _); } catch (e2) {} }
            }
            const model = global.avatarFacade?.getModel?.() || global.currentModel;
            try {
                if (typeof model?.containsPoint === 'function') return Boolean(model.containsPoint({ x, y }));
                const box = model?.getScreenHitBox?.() || model?.getBounds?.() || model?.viewRect;
                if (box) {
                    const left = Number.isFinite(box.left) ? box.left : box.x;
                    const top = Number.isFinite(box.top) ? box.top : box.y;
                    const right = Number.isFinite(box.right) ? box.right : left + box.width;
                    const bottom = Number.isFinite(box.bottom) ? box.bottom : top + box.height;
                    return x >= left && x <= right && y >= top && y <= bottom;
                }
            } catch (_) { try { __silentAudit.audit('ui-controller.js:795', _); } catch (e2) {} }
            return false;
        };

        document.addEventListener('contextmenu', (e) => {
            if (!pointHitsModel(e.clientX, e.clientY)) {
                closePanel();
                return;
            }
            e.preventDefault();
            panelOpen = true;
            panel.classList.add('context-open');
            items.classList.add('expanded');
            // 字幕是独立 OS 窗口（alwaysOnTop），会盖住本菜单——菜单开着时把它藏起来，
            // 关闭菜单后她下一次说话时字幕自然回来。
            try { ipcRenderer.send('subtitle:hide'); } catch (e) { try { __silentAudit.audit('ui-controller.js:810', e); } catch (e2) {} }
            // 先显示再测量，保证菜单不会超出窗口边缘。
            const rect = panel.getBoundingClientRect();
            const left = Math.max(8, Math.min(e.clientX, window.innerWidth - rect.width - 8));
            const top = Math.max(8, Math.min(e.clientY, window.innerHeight - rect.height - 8));
            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
        });

        document.addEventListener('click', (e) => {
            if (panelOpen && !e.target.closest('#quick-settings')) closePanel();
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

        toggleChatBtn.addEventListener('click', () => {
            const visible = !toggleChatBtn.classList.contains('active');
            applyChatBoxVisible(visible);
            config.ui = config.ui || {};
            config.ui.show_chat_box = visible;
            persistQuickSettings({ show_chat_box: visible });
            paintToggleLabels();
            closePanel();
        });

        // ── 我们的扩展项：右键菜单是桌宠最自然的入口，塞几件常用的事 ──────────
        // 🎬 演一段：把情绪 + 动作 + 换装串成有开头有结尾的小段子（纯本地，不花钱）
        const performBtn = document.getElementById('btn-quick-perform');
        if (performBtn) {
            performBtn.addEventListener('click', () => {
                try {
                    const body = global.petBody;
                    const scenes = (body && body.listScenes && body.listScenes()) || [];
                    if (!scenes.length) { global.showSubtitle && global.showSubtitle('还没编好节目。', 2000); closePanel(); return; }
                    // 避开上一次，连点不会老演同一段
                    let pick = scenes[Math.floor(Math.random() * scenes.length)];
                    if (pick === window._lastScene && scenes.length > 1) pick = scenes[(scenes.indexOf(pick) + 1) % scenes.length];
                    window._lastScene = pick;
                    const HINT = { '打招呼': '哟，来了。', '撒娇': '……你就不能多陪我一会儿嘛。', '生气': '哼，你自己玩去吧。', '难过': '……算了，没事。', '得意': '怎么样，服不服。', '晚安': '睡了，别熬夜。' };
                    body.perform(pick);
                    if (HINT[pick] && global.showSubtitle) global.showSubtitle(HINT[pick], 3200);
                } catch (e) { try { __silentAudit.audit('ui-controller.js:862', e); } catch (e2) {} }
                closePanel();
            });
        }

        const gestureBtn = document.getElementById('btn-quick-gesture');
        if (gestureBtn) {
            gestureBtn.addEventListener('click', () => {
                try {
                    const body = global.petBody;
                    if (body && typeof body.playMotion === 'function') {
                        // 15 个编舞里挑一个，避开上一次
                        const pool = ['wave hand', 'nod head', 'shake head', 'tilt head left', 'tilt head right', 'shrug', 'bow', 'laugh', 'stretch', 'think'];
                        let pick = pool[Math.floor(Math.random() * pool.length)];
                        if (pick === this._lastQuickGesture) pick = pool[(pool.indexOf(pick) + 1) % pool.length];
                        this._lastQuickGesture = pick;
                        body.playMotion(pick);
                        body.playMotionAux ? null : null;
                    }
                } catch (e) { try { __silentAudit.audit('ui-controller.js:881', e); } catch (e2) {} }
                closePanel();
            });
        }

        const moodBtn = document.getElementById('btn-quick-mood');
        if (moodBtn) {
            moodBtn.addEventListener('click', async () => {
                // 读一下她当前的情绪 + 引擎判定依据，直接说给用户听
                let line = '说不上来，反正没什么表情。';
                try {
                    const snap = global.petBody && global.petBody.emotionSnapshot && global.petBody.emotionSnapshot();
                    const zh = { happy: '有点开心', sad: '有点难过', angry: '在生气', surprise: '被吓到了', shy: '有点不好意思', smug: '挺得意', tease: '在使坏', bored: '无聊得要命', aggrieved: '有点委屈', guilty: '心虚', sleepy: '困得不行', neutral: '没什么情绪' };
                    if (snap && snap.emotion) {
                        line = '现在' + (zh[snap.emotion] || snap.emotion);
                        if (snap.lastHit && snap.lastHit.matched) line += '（刚才听到「' + snap.lastHit.matched + '」）';
                        line += '。';
                    }
                } catch (e) { try { __silentAudit.audit('ui-controller.js:899', e); } catch (e2) {} }
                try { global.showSubtitle && global.showSubtitle(line, 4000); } catch (e) { try { __silentAudit.audit('ui-controller.js:900', e); } catch (e2) {} }
                closePanel();
            });
        }

        // ── 换装面板（数据来自 pet-runtime/desktop/asset-toggles.mjs 的构建期导出）──
        //
        // 为什么不在宿主里直接 import 那个模块：它在「宿主运行时」里一 import 就自动启动
        // startHostAssetSync()（700ms 循环，反复 decorateHostBody），实测几秒内把渲染进程拖死
        // （frame disposed，连 1+1 都 eval 不出来）。
        // 所以改成：构建期把资产目录导出成 js/avatar/petbody/assets-data.js，
        // 宿主只读数据 + 自己写参数。逻辑是这个模块的核心三条（写值 / 钉进 defaults / 互斥）。
        // 存档 key/形状统一由 core/costume-store.js 负责（与 asset-toggles 同 schema）。

        function assetData() { return window.__PET_ASSETS || null; }
        const assetRenderer = () => (global.petBody && global.petBody.renderer) || null;

        function readParam(renderer, param) {
            try { return Number(renderer.getParameter(param)); } catch (e) { return NaN; }
        }
        // 关键：updateView 每帧把参数恢复成 defaults，所以写值之后必须同时钉进 defaults。
        function writeAssetParam(renderer, param, value) {
            try { renderer.setParameter(param, value); } catch (e) { try { __silentAudit.audit('ui-controller.js:922', e); } catch (e2) {} }
            try {
                const idx = renderer.parameterIndices && renderer.parameterIndices.get(param);
                if (idx !== undefined && renderer.defaults) renderer.defaults[idx] = value;
            } catch (e) { try { __silentAudit.audit('ui-controller.js:926', e); } catch (e2) {} }
        }

        function assetStateOf(renderer, asset) {
            const v = readParam(renderer, asset.param);
            const value = Number.isFinite(v) ? v : asset.default;
            if (asset.kind === 'cycle') {
                const opts = asset.options || [];
                let best = 0, bestD = Infinity;
                opts.forEach((o, i) => { const d = Math.abs(o.value - value); if (d < bestD) { bestD = d; best = i; } });
                return { value, on: Math.abs(opts[best].value - asset.default) > 1e-6, optionIndex: best, optionLabel: opts[best].label };
            }
            return { value, on: value >= 0.5, optionLabel: value >= 0.5 ? (asset.onLabel || '开') : (asset.offLabel || '关') };
        }

        function applyAssetById(renderer, id, on) {
            const data = assetData();
            if (!data) return false;
            // 三种写法都得认：id（glasses-frame）、别名（眼镜/黑框）、中文标签（黑框眼镜）。
            // 演出编排里写的是中文标签，只按 id/别名查会全部落空。
            const asset = data.assets.find((x) => x.id === id
                || (x.aliases || []).includes(id)
                || x.label === id);
            if (!asset) return false;
            if (asset.kind === 'cycle') {
                const cur = assetStateOf(renderer, asset);
                const opts = asset.options || [];
                let value;
                if (typeof on === 'number') value = on;
                else value = opts[(cur.optionIndex + 1) % opts.length].value;
                writeAssetParam(renderer, asset.param, value);
            } else {
                writeAssetParam(renderer, asset.param, on ? 1 : 0);
            }
            // 互斥：同组其它资产关掉
            if (asset.exclusive) {
                for (const other of data.assets) {
                    if (other === asset || other.exclusive !== asset.exclusive || other.kind === 'cycle') continue;
                    writeAssetParam(renderer, other.param, 0);
                }
            }
            saveAssetState(renderer);
            return true;
        }

        function applyPresetById(renderer, presetId) {
            const data = assetData();
            if (!data) return false;
            const preset = data.presets.find((x) => x.id === presetId || x.label === presetId);
            if (!preset) return false;
            // 先回默认，再套预设（和原模块行为一致）
            for (const asset of data.assets) writeAssetParam(renderer, asset.param, asset.default);
            for (const [id, spec] of Object.entries(preset.assets || {})) {
                const asset = data.assets.find((x) => x.id === id);
                if (!asset) continue;
                if (asset.kind === 'cycle') {
                    const opts = asset.options || [];
                    const hit = opts.find((o) => o.id === spec || o.label === spec);
                    if (hit) writeAssetParam(renderer, asset.param, hit.value);
                } else {
                    writeAssetParam(renderer, asset.param, spec ? 1 : 0);
                }
            }
            saveAssetState(renderer);
            return true;
        }

        function snapshotAssets(renderer) {
            const data = assetData();
            if (!data || !renderer) return null;
            const values = {};
            for (const asset of data.assets) values[asset.id] = assetStateOf(renderer, asset).value;
            // 形状与 asset-toggles 存档对齐（updatedAt 而不是私有的 at）。
            return { version: 1, updatedAt: Date.now(), values };
        }

        function saveAssetState(renderer) {
            const data = assetData();
            if (!renderer || !data) return { saved: false, reason: 'no-renderer' };
            // 单一写入者：打包的 asset-toggles 才是 `pet.assets.v1` 的权威写入方
            // （它写 {version, updatedAt, preset, values}）。以前这里自己拼
            // {version, at, values} 覆盖同一个 key，把 preset 抹掉——换装预设高亮丢失。
            try {
                const canonical = typeof window !== 'undefined' ? window.petAssets : null;
                if (canonical && typeof canonical.saveAssetsState === 'function') {
                    const result = canonical.saveAssetsState(renderer);
                    if (result && result.saved) return result;
                }
            } catch (e) { try { __silentAudit.audit('ui-controller.js:saveAssetState-canonical', e); } catch (e2) {} }
            // 兜底：没有 asset-toggles 时走兼容写入器（补齐 preset + 回读校验 + 失败回滚）。
            const snap = snapshotAssets(renderer);
            if (!snap) return { saved: false, reason: 'no-snapshot' };
            try {
                return costumeStore.writeAssetsState(localStorage, {
                    values: snap.values,
                    presets: data.presets,
                    assets: data.assets,
                });
            } catch (e) {
                try { __silentAudit.audit('ui-controller.js:1005', e); } catch (e2) {}
                return { saved: false, reason: 'write-threw', error: String((e && e.message) || e) };
            }
        }

        function restoreAssetState(renderer) {
            if (!renderer) return false;
            // 同样优先走权威模块；它内部有「每个渲染器只恢复一次」的 WeakSet。
            try {
                const canonical = typeof window !== 'undefined' ? window.petAssets : null;
                if (canonical && typeof canonical.restoreSavedAssets === 'function') {
                    const restored = canonical.restoreSavedAssets(renderer);
                    if (restored) return true;
                }
            } catch (e) { try { __silentAudit.audit('ui-controller.js:restoreAssetState-canonical', e); } catch (e2) {} }
            try {
                const data = assetData();
                const snap = costumeStore.readAssetsState(localStorage);
                if (!snap || !data) return false;
                for (const asset of data.assets) {
                    if (Object.prototype.hasOwnProperty.call(snap.values, asset.id)) {
                        writeAssetParam(renderer, asset.param, Number(snap.values[asset.id]));
                    }
                }
                return true;
            } catch (e) { return false; }
        }

        // 给驱动层/桥接用的全局入口（避免它再 import 那个有副作用的模块）
        window.__petAssets = {
            apply: (id, on) => applyAssetById(assetRenderer(), id, on),
            preset: (id) => applyPresetById(assetRenderer(), id),
            restore: () => restoreAssetState(assetRenderer()),
            snapshot: () => snapshotAssets(assetRenderer()),
        };

        async function renderCostumePanel() {
            const body = document.getElementById('costume-body');
            if (!body) return;
            const data = assetData();
            const renderer = assetRenderer();
            if (!data) {
                body.innerHTML = '<div class="costume-label">资产数据没加载（assets-data.js）</div>';
                return;
            }
            const presetBtns = data.presets.map((p) =>
                '<div class="costume-chip preset" data-preset="' + p.id + '" title="' + (p.description || '') + '">' + p.label + '</div>'
            ).join('');

            const groupsHtml = data.groups.map((group) => {
                const items = data.assets.filter((asset) => asset.group === group.id);
                const chips = items.map((asset) => {
                    const st = renderer ? assetStateOf(renderer, asset) : { on: false, optionLabel: asset.label };
                    const text = asset.kind === 'cycle' ? st.optionLabel : asset.label;
                    return '<div class="costume-chip' + (st.on ? ' on' : '') + '" data-asset="' + asset.id + '" title="' + (asset.note || '') + '">' + text + '</div>';
                }).join('');
                return '<div class="costume-group"><div class="costume-label">' + group.label + '</div><div class="costume-chips">' + chips + '</div></div>';
            }).join('');

            body.innerHTML = '<div class="costume-group"><div class="costume-label">预设</div><div class="costume-chips">' + presetBtns + '</div></div>' + groupsHtml;
        }

        const openCostumePanel = () => {
            const panel = document.getElementById('costume-panel');
            const anchor = document.getElementById('quick-settings');
            if (!panel) return;
            panel.style.display = 'block';
            const rect = anchor ? anchor.getBoundingClientRect() : { left: 20, top: 20, right: 200 };
            const pw = panel.offsetWidth || 260;
            const ph = panel.offsetHeight || 320;
            const left = Math.max(8, Math.min(rect.left, window.innerWidth - pw - 8));
            const top = Math.max(8, Math.min(rect.top, window.innerHeight - ph - 8));
            panel.style.left = left + "px";
            panel.style.top = top + "px";
            renderCostumePanel();
        };

        const closeCostumePanel = () => {
            const panel = document.getElementById('costume-panel');
            if (panel) panel.style.display = 'none';
        };

        const costumeBtn = document.getElementById('btn-quick-costume');
        if (costumeBtn) {
            costumeBtn.addEventListener('click', () => {
                // 换装改成在**皮套旁边**的独立窗口里做 ——
                // 之前是内嵌浮层，一打开就把她整个盖住，根本看不到换装效果。
                try { closePanel(); } catch (e) { try { __silentAudit.audit('ui-controller.js:1083', e); } catch (e2) {} }
                try {
                    require('electron').ipcRenderer.send('open-control-center', 'petbody');
                } catch (e) {
                    openCostumePanel();   // 拿不到 IPC 才退回内嵌面板
                }
            });
        }

        const costumePanel = document.getElementById('costume-panel');
        if (costumePanel) {
            costumePanel.addEventListener('click', (event) => {
                const chip = event.target.closest && event.target.closest(".costume-chip");
                if (!chip) return;
                event.stopPropagation();
                const renderer = assetRenderer();
                if (!renderer) return;
                if (chip.dataset.preset) { applyPresetById(renderer, chip.dataset.preset); }
                else if (chip.dataset.asset) {
                    const data = assetData();
                    const asset = data && data.assets.find((x) => x.id === chip.dataset.asset);
                    if (!asset) return;
                    if (asset.kind === 'cycle') applyAssetById(renderer, asset.id);
                    else applyAssetById(renderer, asset.id, !chip.classList.contains("on"));
                }
                renderCostumePanel();
            });
            const closeBtn = document.getElementById('costume-close');
            if (closeBtn) closeBtn.addEventListener('click', () => closeCostumePanel());
            document.addEventListener('mousedown', (event) => {
                if (costumePanel.style.display !== "block") return;
                if (costumePanel.contains(event.target)) return;
                if (event.target.closest && event.target.closest('#quick-settings')) return;
                closeCostumePanel();
            });
            // 启动后把上次的装备穿回去
            setTimeout(() => {
                const renderer = assetRenderer();
                if (!renderer) return;
                try { restoreAssetState(renderer); } catch (e) { try { __silentAudit.audit('ui-controller.js:1122', e); } catch (e2) {} }
            }, 3000);
        }

        const settingsBtn = document.getElementById('btn-quick-settings');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => {
                try { require('electron').ipcRenderer.send('open-control-center'); } catch (e) { try { __silentAudit.audit('ui-controller.js:1129', e); } catch (e2) {} }
                closePanel();
            });
        }

        const hideBtn = document.getElementById('btn-quick-hide');
        if (hideBtn) {
            hideBtn.addEventListener('click', () => {
                try { require('electron').ipcRenderer.send('hide-pet'); } catch (e) { try { __silentAudit.audit('ui-controller.js:1137', e); } catch (e2) {} }
                closePanel();
            });
        }

        toggleModeBtn.addEventListener('click', () => {
            const proc = voiceChat.asrController?.asrProcessor;
            if (!proc) return;
            const nextPTTMode = !proc.pttModeEnabled;
            if (typeof this._cancelActivePTT === 'function') {
                this._cancelActivePTT('mode-toggle');
            }
            proc.pttModeEnabled = nextPTTMode;
            config.asr = config.asr || {};
            config.asr.ptt_enabled = proc.pttModeEnabled;
            persistQuickSettings({ ptt_enabled: proc.pttModeEnabled });
            toggleModeBtn.classList.toggle('active', proc.pttModeEnabled);
            paintToggleLabels();
            closePanel();
        });
    }

    // PTT global/local hold-to-talk listener
    setupPTT(voiceChat, config) {
        if (typeof this._pttCleanup === 'function') {
            this._pttCleanup();
        }

        const normalizeKey = (value) => {
            const raw = String(value || '').trim().toLowerCase();
            const aliases = {
                ' ': 'space',
                spacebar: 'space',
                return: 'enter',
                esc: 'escape',
                control: 'ctrl',
                command: 'meta',
                cmd: 'meta',
                win: 'meta',
                windows: 'meta',
                option: 'alt',
                left: 'arrowleft',
                up: 'arrowup',
                right: 'arrowright',
                down: 'arrowdown'
            };
            return aliases[raw] || raw;
        };

        const pttKey = normalizeKey(config.asr?.ptt_key || 'v') || 'v';
        const recordingText = '\u5f55\u97f3\u4e2d...';
        let pttActive = false;
        let pttSource = null;

        const getProcessor = () => voiceChat.asrController?.asrProcessor;
        const isPTTEnabled = () => getProcessor()?.pttModeEnabled || false;
        const matchesPTTKey = (key) => normalizeKey(key) === pttKey;
        const isInputFocused = () => {
            const el = document.activeElement;
            if (!el) return false;
            const tag = el.tagName;
            return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
        };
        const shouldSkipForInput = (source) => {
            if (!isInputFocused()) return false;
            return source === 'local' || document.hasFocus();
        };

        const cancelProcessor = (reason) => {
            const proc = getProcessor();
            if (typeof voiceChat.pttCancelRecording === 'function') {
                voiceChat.pttCancelRecording(reason);
                return;
            }
            if (typeof proc?.pttCancelRecording === 'function') {
                proc.pttCancelRecording(reason);
                return;
            }
            if (!proc) return;
            proc.isRecording = false;
            proc.asrLocked = false;
            proc.hasInterruptedThisSession = false;
            if (proc.silenceTimeout) {
                clearTimeout(proc.silenceTimeout);
                proc.silenceTimeout = null;
            }
        };

        const cancelPTT = (reason = 'cancelled') => {
            const wasActive = pttActive;
            pttActive = false;
            pttSource = null;
            if (wasActive) {
                cancelProcessor(reason);
                this.hideSubtitle();
                logToTerminal('info', `[PTT] cancelled: ${reason}`);
            }
            return wasActive;
        };

        const startPTT = (source) => {
            if (!isPTTEnabled()) return false;
            if (pttActive) {
                if (source === 'global') pttSource = 'global';
                return true;
            }
            if (shouldSkipForInput(source)) {
                logToTerminal('info', `[PTT] ${source} keydown ignored because input is focused`);
                return false;
            }

            pttActive = true;
            pttSource = source;
            logToTerminal('info', `[PTT] ${source} keydown, start recording`);
            if (typeof voiceChat.pttStartRecording === 'function') {
                voiceChat.pttStartRecording();
            }
            this.showSubtitle(recordingText, 0);
            return true;
        };

        const stopPTT = (source, reason = 'keyup') => {
            if (!pttActive) return false;
            const activeSource = pttSource;
            pttActive = false;
            pttSource = null;

            if (!isPTTEnabled()) {
                cancelProcessor(reason);
                this.hideSubtitle();
                logToTerminal('info', `[PTT] ${source} ${reason}, mode disabled so recording was cancelled`);
                return true;
            }

            logToTerminal('info', `[PTT] ${source} ${reason}, stop recording from ${activeSource || 'unknown'}`);
            if (typeof voiceChat.pttStopRecording === 'function') {
                voiceChat.pttStopRecording();
            }
            this.hideSubtitle();
            return true;
        };

        const onLocalKeyDown = (e) => {
            if (!matchesPTTKey(e.key) || e.repeat) return;
            startPTT('local');
        };

        const onLocalKeyUp = (e) => {
            if (!matchesPTTKey(e.key)) return;
            stopPTT('local');
        };

        const onGlobalPTT = (_event, payload = {}) => {
            if (!payload || !matchesPTTKey(payload.key)) return;
            if (payload.action === 'down') {
                startPTT('global');
            } else if (payload.action === 'up') {
                stopPTT('global');
            }
        };

        const onWindowBlur = () => {
            setTimeout(() => {
                if (pttActive && pttSource !== 'global') {
                    stopPTT('window-blur', 'blur');
                }
            }, 50);
        };

        const onVisibilityChange = () => {
            if (document.hidden) {
                cancelPTT('visibility-hidden');
            }
        };

        const onBeforeUnload = () => {
            cancelPTT('beforeunload');
        };

        document.addEventListener('keydown', onLocalKeyDown);
        document.addEventListener('keyup', onLocalKeyUp);
        ipcRenderer.on('ptt-global-key', onGlobalPTT);
        window.addEventListener('blur', onWindowBlur);
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('beforeunload', onBeforeUnload);

        this._cancelActivePTT = cancelPTT;
        this._pttCleanup = () => {
            document.removeEventListener('keydown', onLocalKeyDown);
            document.removeEventListener('keyup', onLocalKeyUp);
            ipcRenderer.removeListener('ptt-global-key', onGlobalPTT);
            window.removeEventListener('blur', onWindowBlur);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener('beforeunload', onBeforeUnload);
            if (this._cancelActivePTT === cancelPTT) {
                this._cancelActivePTT = null;
            }
            this._pttCleanup = null;
        };

        console.log(`PTT listener registered, key: ${pttKey.toUpperCase()} (global + local fallback)`);
    }

    // 显示歌词气泡
    showLyricsBubble(text) {
        const bubbleContainer = document.getElementById('lyrics-bubble-container');
        const bubbleText = document.getElementById('lyrics-bubble-text');

        if (!bubbleContainer || !bubbleText) return;

        bubbleText.textContent = text;
        bubbleContainer.style.display = 'block';

        // 启动位置追踪（复用现有的气泡位置逻辑，或者稍微偏移）
        if (!this.bubbleUpdateInterval) {
            this.startBubbleTracking();
        }

        // 标记歌词气泡可见，以便 updateBubblePosition 更新它的位置
        this.lyricsBubbleVisible = true;
        this.updateBubblePosition();
    }

    // 隐藏歌词气泡
    hideLyricsBubble() {
        const bubbleContainer = document.getElementById('lyrics-bubble-container');
        if (bubbleContainer) {
            bubbleContainer.style.display = 'none';
        }
        this.lyricsBubbleVisible = false;

        // 如果没有其他气泡显示，停止追踪
        if (!this.bubbleVisible && !this.lyricsBubbleVisible) {
            // 注意：这里不能直接停止，因为可能还有工具气泡。
            // 简单起见，只要有任何气泡显示，就保持追踪。
            // 现有的 stopBubbleTracking 逻辑可能需要调整，或者我们暂时保持它运行。
        }
    }

    // ========== 字幕位置调整 ==========

    // 进入调整模式
    enterSubtitleAdjustMode() {
        if (this.isAdjustingSubtitle) return; // 防止重复进入导致事件重复绑定
        const c = document.getElementById('subtitle-container');
        const t = document.getElementById('subtitle-text');
        if (!c || !t) return;

        this.isAdjustingSubtitle = true;
        this._savedText = t.textContent;
        this._savedDisplay = c.style.display;
        t.textContent = '1.拖动或滚轮缩放调整\n2.复位皮套按钮复位';

        // 加载已有位置或取当前中心点
        const pos = this.config?.ui?.subtitle_position;
        if (pos?.centerX != null) {
            this._subtitleCenterX = pos.centerX;
            this._subtitleCenterY = pos.centerY;
            if (pos.scale != null) this.subtitleScale = pos.scale;
        } else {
            c.style.display = 'block'; c.offsetHeight;
            const r = c.getBoundingClientRect();
            this._subtitleCenterX = r.left + r.width / 2;
            this._subtitleCenterY = r.top + r.height / 2;
        }

        Object.assign(c.style, {
            bottom: 'auto', left: `${this._subtitleCenterX}px`, top: `${this._subtitleCenterY}px`,
            transform: `translate(-50%, -50%) scale(${this.subtitleScale})`, transformOrigin: 'center center'
        });
        c.classList.add('subtitle-adjusting');

        // 创建遮罩
        let overlay = document.getElementById('subtitle-adjust-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'subtitle-adjust-overlay';
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9998;background:transparent;cursor:default;';
            document.body.appendChild(overlay);
        }

        // 绑定事件
        this._adjustCleanup = [];

        const onKey = (e) => { if (e.key === 'Escape') this.exitSubtitleAdjustMode(); };
        document.addEventListener('keydown', onKey);
        this._adjustCleanup.push(() => document.removeEventListener('keydown', onKey));

        overlay.addEventListener('mouseenter', () =>
            ipcRenderer.send('pet:set-ignore-mouse', { ignore: false, options: { forward: false } }));

        // 拖拽
        const onDragStart = (e) => {
            if (e.target.id === 'subtitle-confirm-btn') return;
            e.preventDefault(); e.stopPropagation();
            this.isDraggingSubtitle = true; c.style.cursor = 'grabbing';
            const sx = e.clientX, sy = e.clientY, scx = this._subtitleCenterX, scy = this._subtitleCenterY;
            const onMove = (ev) => {
                if (!this.isDraggingSubtitle) return;
                ev.preventDefault();
                c.style.left = `${this._subtitleCenterX = scx + ev.clientX - sx}px`;
                c.style.top = `${this._subtitleCenterY = scy + ev.clientY - sy}px`;
            };
            const onUp = () => {
                this.isDraggingSubtitle = false; c.style.cursor = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
        c.addEventListener('mousedown', onDragStart);
        this._adjustCleanup.push(() => c.removeEventListener('mousedown', onDragStart));

        // 滚轮缩放
        const onWheel = (e) => {
            e.preventDefault(); e.stopPropagation();
            this.subtitleScale = Math.max(0.3, Math.min(3.0, this.subtitleScale + (e.deltaY > 0 ? -0.05 : 0.05)));
            c.style.transform = `translate(-50%, -50%) scale(${this.subtitleScale})`;
        };
        c.addEventListener('wheel', onWheel, { passive: false });
        this._adjustCleanup.push(() => c.removeEventListener('wheel', onWheel));

        // 确认按钮
        const confirmBtn = document.getElementById('subtitle-confirm-btn');
        if (confirmBtn) {
            const onConfirm = (e) => { e.stopPropagation(); e.preventDefault(); this.exitSubtitleAdjustMode(); };
            confirmBtn.addEventListener('click', onConfirm);
            this._adjustCleanup.push(() => confirmBtn.removeEventListener('click', onConfirm));
        }

        ipcRenderer.send('pet:set-ignore-mouse', { ignore: false, options: { forward: false } });
    }

    // 退出调整模式
    exitSubtitleAdjustMode() {
        const c = document.getElementById('subtitle-container');
        if (!c) return;

        // 保存位置到内存
        if (this.config?.ui) {
            this.config.ui.subtitle_position = {
                centerX: this._subtitleCenterX, centerY: this._subtitleCenterY, scale: this.subtitleScale
            };
        }

        c.classList.remove('subtitle-adjusting');
        c.style.cursor = '';
        const t = document.getElementById('subtitle-text');
        if (t) t.textContent = this._savedText || '';
        if (!this._savedText) c.style.display = this._savedDisplay || 'none';

        // 执行所有清理回调
        this._adjustCleanup?.forEach(fn => fn());
        this._adjustCleanup = null;
        document.getElementById('subtitle-adjust-overlay')?.remove();

        this.isAdjustingSubtitle = this.isDraggingSubtitle = false;
        ipcRenderer.send('pet:set-ignore-mouse', { ignore: true, options: { forward: true } });
    }

    // 应用保存的字幕位置
    applySubtitlePosition() {
        const c = document.getElementById('subtitle-container');
        if (!c || this.isAdjustingSubtitle) return;
        const pos = this.config?.ui?.subtitle_position;
        if (pos?.centerX != null) {
            Object.assign(c.style, {
                left: `${pos.centerX}px`, top: `${pos.centerY}px`, bottom: 'auto',
                transform: `translate(-50%, -50%) scale(${pos.scale || 1})`, transformOrigin: 'center center'
            });
        }
    }

    // 复位字幕到 CSS 默认位置
    resetSubtitlePosition() {
        const c = document.getElementById('subtitle-container');
        if (!c) return;

        if (this.config?.ui) this.config.ui.subtitle_position = null;
        this._subtitleCenterX = null;
        this._subtitleCenterY = null;
        this.subtitleScale = 1;

        if (this.isAdjustingSubtitle) {
            let tx = window.innerWidth * 0.7;
            let ty = window.innerHeight - 80;
            try {
                const info = ipcRenderer.sendSync('get-screen-info-sync');
                if (info?.primaryDisplay?.bounds && info?.windowBounds) {
                    const left = info.primaryDisplay.bounds.x - info.windowBounds.x;
                    const top = info.primaryDisplay.bounds.y - info.windowBounds.y;
                    tx = left + info.primaryDisplay.bounds.width * 0.7;
                    ty = top + info.primaryDisplay.bounds.height - 80;
                }
            } catch (_) { try { __silentAudit.audit('ui-controller.js:1531', _); } catch (e2) {} }
            this._subtitleCenterX = tx; this._subtitleCenterY = ty;
            Object.assign(c.style, {
                left: `${tx}px`, top: `${ty}px`,
                transform: 'translate(-50%, -50%) scale(1)', transformOrigin: 'center center'
            });
        } else {
            Object.assign(c.style, { left: '', top: '', bottom: '', transform: '', transformOrigin: '' });
        }
    }
}

module.exports = { UIController };
