const express = require('express');
const { BrowserWindow } = require('electron');

/**
 * HTTP API 服务器
 * 提供音乐控制和情绪控制的 HTTP 接口
 */
class HttpServer {
    constructor() {
        this.musicApp = null;
        this.emotionApp = null;
    }

    /**
     * 启动所有 HTTP 服务
     */
    start() {
        this.startMusicServer();
        this.startEmotionServer();
    }

    /**
     * 启动音乐控制服务器 (端口 3001)
     */
    startMusicServer() {
        this.musicApp = express();
        this.musicApp.use(express.json());

        // 音乐控制接口
        this.musicApp.post('/control-music', (req, res) => {
            const { action, filename } = req.body;
            const mainWindow = BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                return res.json({ success: false, message: '应用窗口未找到' });
            }

            let jsCode = '';
            switch (action) {
                case 'play_random':
                    // 直接返回 playRandomMusic 的结果 (Promise)
                    jsCode = 'global.musicPlayer ? global.musicPlayer.playRandomMusic() : { message: "播放器未初始化", metadata: null }';
                    break;
                case 'stop':
                    jsCode = 'global.musicPlayer ? global.musicPlayer.stop() : null; "音乐已停止"';
                    break;
                case 'play_specific':
                    // 直接返回 playSpecificSong 的结果 (Promise)
                    jsCode = `global.musicPlayer ? global.musicPlayer.playSpecificSong(${JSON.stringify(filename)}) : { message: "播放器未初始化", metadata: null }`;
                    break;
                default:
                    return res.json({ success: false, message: '不支持的操作' });
            }

            mainWindow.webContents.executeJavaScript(jsCode)
                .then(result => res.json({ success: true, message: result }))
                .catch(error => res.json({ success: false, message: error.toString() }));
        });

        // ⚠ 2026-11-10 红队实测：原来 listen(3001) 绑 0.0.0.0 —— 同一 Wi-Fi 下任何设备
        //   一条 POST /control-motion 就能在渲染进程里执行任意 JS（motion_index 裸插值）→ 用户权限 RCE。
        //   这些是「她自己的手」，只该本机可达。
        this.musicApp.listen(3001, '127.0.0.1', () => {
            console.log('音乐控制服务启动在端口3001');
        });
    }

    /**
     * 启动情绪控制服务器 (端口 3002)
     */
    startEmotionServer() {
        this.emotionApp = express();
        this.emotionApp.use(express.json());

        // 情绪控制接口
        this.emotionApp.post('/control-motion', (req, res) => {
            const { action, emotion_name } = req.body;
            // ⚠ 2026-11-10 红队实测：motion_index 原来是**裸插值**进 executeJavaScript 的模板串，
            //   传 `0);<任意 JS>;(0` 就直接执行 → RCE。强制成整数（非法值归 0）。
            const motion_index = Number.isFinite(Number(req.body.motion_index))
                ? Math.trunc(Number(req.body.motion_index)) : 0;
            const mainWindow = BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                return res.json({ success: false, message: '应用窗口未找到' });
            }

            let jsCode = '';

            if (action === 'trigger_emotion') {
                // 调用情绪映射器播放情绪动作
                jsCode = `
                    if (global.emotionMapper && global.emotionMapper.playConfiguredEmotion) {
                        global.emotionMapper.playConfiguredEmotion(${JSON.stringify(emotion_name)});
                        "触发情绪: ${JSON.stringify(emotion_name)}";
                    } else {
                        "情绪映射器未初始化";
                    }
                `;
            } else if (action === 'trigger_motion') {
                // 保留原有的索引方式（兼容性）
                jsCode = `
                    if (global.emotionMapper && global.emotionMapper.playMotion) {
                        global.emotionMapper.playMotion(${motion_index});
                        "触发动作索引: ${motion_index}";
                    } else {
                        "情绪映射器未初始化";
                    }
                `;
            } else if (action === 'stop_all_motions') {
                // 停止所有动作
                jsCode = `
                    if (currentModel && currentModel.internalModel && currentModel.internalModel.motionManager) {
                        currentModel.internalModel.motionManager.stopAllMotions();
                        if (global.emotionMapper) {
                            global.emotionMapper.playDefaultMotion();
                        }
                        "已停止所有动作";
                    } else {
                        "模型未初始化";
                    }
                `;
            } else {
                return res.json({ success: false, message: '不支持的操作' });
            }

            mainWindow.webContents.executeJavaScript(jsCode)
                .then(result => res.json({ success: true, message: result }))
                .catch(error => res.json({ success: false, message: error.toString() }));
        });

        

        // 表情控制接口
        this.emotionApp.post('/control-expression', (req, res) => {
            const { expression_name } = req.body;
            const mainWindow = BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                return res.json({ success: false, message: '应用窗口未找到' });
            }

            const jsCode = `
                if (global.expressionMapper && global.expressionMapper.triggerExpression) {
                    global.expressionMapper.triggerExpression(${JSON.stringify(expression_name)});
                    "触发表情: ${JSON.stringify(expression_name)}";
                } else {
                    "表情映射器未初始化";
                }
            `;

            mainWindow.webContents.executeJavaScript(jsCode)
                .then(result => res.json({ success: true, message: result }))
                .catch(error => res.json({ success: false, message: error.toString() }));
        });
        
        // 表情绑定接口
        this.emotionApp.post('/bind-expression', (req, res) => {
            const { expression_name, emotion_name } = req.body;
            const mainWindow = BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                return res.json({ success: false, message: '应用窗口未找到' });
            }

            const jsCode = `
                if (global.expressionMapper && global.expressionMapper.bindExpressionToEmotion) {
                    const result = global.expressionMapper.bindExpressionToEmotion(${JSON.stringify(emotion_name)}, ${JSON.stringify(expression_name)});
                    result ? "绑定成功" : "表情已绑定";
                } else {
                    "表情映射器未初始化";
                }
            `;

            mainWindow.webContents.executeJavaScript(jsCode)
                .then(result => res.json({ success: true, message: result }))
                .catch(error => res.json({ success: false, message: error.toString() }));
        });

        // 配置重新加载接口
        this.emotionApp.post('/reload-config', async (req, res) => {
            // 2026-11-17 六十二轮 · P0：原来取 `BrowserWindow.getAllWindows()[0]`，
            // 而 getAllWindows 的顺序不保证 —— 打到字幕窗（那里没有 reloadConfig）时
            // 返回「配置重新加载函数未找到」但 success 仍然是 true（假成功）。
            // 后果：控制中心换 API key / 改开关后提示「已保存」，宿主其实一个字都没重读
            // （用户 2026-11-17 报「UI 换 key 没用」就是这条）。
            // 现在：挑**真正有 reloadConfig** 的那个窗口；找不到就如实报失败。
            const candidates = BrowserWindow.getAllWindows().filter(w => w && !w.isDestroyed());
            let target = null;
            for (const w of candidates) {
                try {
                    const has = await w.webContents.executeJavaScript('typeof global.reloadConfig === "function"');
                    if (has) { target = w; break; }
                } catch (error) { /* 窗口正在导航/已崩：跳过，继续找 */ }
            }
            if (!target) {
                return res.json({ success: false, message: '没有任何窗口能重载配置（reloadConfig 未挂载）' });
            }

            // 重载 config.json，同时让情绪引擎重读表情/动作绑定（控制面板 / WebUI 保存后调用，无需重启桌宠）
            const jsCode = `
                (async () => {
                    const reloaded = global.reloadConfig ? global.reloadConfig() : false;
                    const engines = new Set();
                    for (const mapper of [global.emotionMapper, global.expressionMapper]) {
                        if (mapper && typeof mapper.reloadConfig === 'function') engines.add(mapper._engine || mapper);
                    }
                    for (const engine of engines) await engine.reloadConfig();
                    return reloaded ? "配置已重新加载" : "配置重新加载函数未找到";
                })()
            `;

            target.webContents.executeJavaScript(jsCode)
                .then(result => {
                    // 函数内部返回 false 也是失败 —— 不能再包成 success:true（假绿）
                    const ok = String(result) === '配置已重新加载';
                    res.json({ success: ok, message: result });
                })
                .catch(error => res.json({ success: false, message: error.toString() }));
        });

        // 热复位模型端点
		this.emotionApp.post('/reset-model-position', async (req, res) => {
		    const mainWindow = BrowserWindow.getAllWindows()[0];
		    if (!mainWindow) {
		        return res.json({ success: false});
		    }
		
		    const jsCode = `
		        (() => {
		            const facade = global.avatarFacade || window.avatar;
		            const mc = facade?.getController?.() || global.modelController;
		            if (!mc) return { success: false };

		            if (typeof mc.resetModelPosition === 'function') {
		                const result = mc.resetModelPosition();
		                const uic = global.uiController;
		                if (uic) uic.resetSubtitlePosition();
		                return result && result.success !== false ? { success: true } : { success: false };
		            }

		            return { success: false };
		        })()
		    `;
		
		    try {
		        const result = await mainWindow.webContents.executeJavaScript(jsCode);
		        res.json(result);
		    } catch (error) {
		        res.json({ success: false, message: error.toString() });
		    }
		});
        // 模型切换接口（供QT前端调用）
        this.emotionApp.post('/switch-model', (req, res) => {
            const { model_name, model_type } = req.body;
            const mainWindow = BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                return res.json({ success: false, message: '应用窗口未找到' });
            }

            if (model_type === 'vrm') {
                // VRM模型切换：通过IPC触发
                mainWindow.webContents.executeJavaScript(
                    `require('electron').ipcRenderer.invoke('switch-vrm-model', ${JSON.stringify(model_name)})`
                ).then(() => {
                    res.json({ success: true, message: `VRM模型切换到 ${JSON.stringify(model_name)}` });
                }).catch(error => {
                    res.json({ success: false, message: error.toString() });
                });
            } else {
                // Live2D模型切换
                mainWindow.webContents.executeJavaScript(
                    `require('electron').ipcRenderer.invoke('switch-live2d-model', ${JSON.stringify(model_name)})`
                ).then(() => {
                    res.json({ success: true, message: `模型切换到 ${JSON.stringify(model_name)}` });
                }).catch(error => {
                    res.json({ success: false, message: error.toString() });
                });
            }
        });

        // 皮套形态切换接口（供 WebUI 调用）：桥接到 Electron 主进程的统一切换事务
        // 主进程侧的 avatar-switch-transaction 已处理跨渲染引擎的整窗重载与回滚
        this.emotionApp.post('/switch-avatar-type', (req, res) => {
            const { type } = req.body || {};
            const mainWindow = BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                return res.json({ success: false, message: '应用窗口未找到' });
            }
            if (!type) {
                return res.json({ success: false, message: '缺少 type 参数' });
            }

            mainWindow.webContents.executeJavaScript(
                `require('electron').ipcRenderer.invoke('avatar:switch-type', ${JSON.stringify(type)})`
            ).then(result => {
                res.json(result && typeof result === 'object'
                    ? result
                    : { success: !!result, message: `形态切换到 ${type}` });
            }).catch(error => {
                res.json({ success: false, message: error.toString() });
            });
        });

        // 指定形态下的模型选择接口（供 WebUI 调用）：热应用并持久化
        this.emotionApp.post('/set-avatar-model', (req, res) => {
            const { type, model_name } = req.body || {};
            const mainWindow = BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                return res.json({ success: false, message: '应用窗口未找到' });
            }
            if (!type || !model_name) {
                return res.json({ success: false, message: '缺少 type 或 model_name 参数' });
            }

            mainWindow.webContents.executeJavaScript(
                `require('electron').ipcRenderer.invoke('avatar:set-model', { type: ${JSON.stringify(type)}, model_name: ${JSON.stringify(model_name)} })`
            ).then(result => {
                res.json(result && typeof result === 'object'
                    ? result
                    : { success: !!result, message: `已应用模型：${JSON.stringify(model_name)}` });
            }).catch(error => {
                res.json({ success: false, message: error.toString() });
            });
        });

        // 桌宠退出前播放淡出动画，控制端收到完成响应后再结束进程。
        this.emotionApp.post('/prepare-close', async (_req, res) => {
            const mainWindow = BrowserWindow.getAllWindows()[0];
            if (!mainWindow) return res.json({ success: false, message: '应用窗口未找到' });
            try {
                const result = await mainWindow.webContents.executeJavaScript(
                    `require('./js/avatar/transition-overlay.js').fadeOut().then(() => ({ success: true }))`
                );
                res.json(result);
            } catch (error) {
                res.json({ success: false, message: error.toString() });
            }
        });

        // 复位字幕位置接口（供 WebUI 调用）：桌宠在线时实时复位并清除已保存的位置
        this.emotionApp.post('/reset-subtitle-position', async (req, res) => {
            const mainWindow = BrowserWindow.getAllWindows()[0];
            if (!mainWindow) {
                return res.json({ success: false, message: '应用窗口未找到' });
            }

            const jsCode = `(() => {
                const uic = global.uiController;
                if (!uic?.resetSubtitlePosition) return { success: false, message: '字幕控制器未初始化' };
                uic.resetSubtitlePosition();
                return { success: true, message: '字幕位置已复位' };
            })()`;

            try {
                const result = await mainWindow.webContents.executeJavaScript(jsCode);
                res.json(result && typeof result === 'object'
                    ? result
                    : { success: !!result });
            } catch (error) {
                res.json({ success: false, message: error.toString() });
            }
        });

        // VMC控制端点
        this._setupVMCEndpoint();

        // ===== 插件管理接口 =====

        this.emotionApp.get('/plugins', (req, res) => {
            const pm = global.pluginManager;
            if (!pm) return res.json({ success: false, message: '插件管理器未初始化' });
            res.json({ success: true, plugins: pm.getPluginList() });
        });

        this.emotionApp.post('/plugins/reload', (req, res) => {
            const pm = global.pluginManager;
            if (!pm) return res.json({ success: false, message: '插件管理器未初始化' });
            const { name } = req.body || {};
            if (!name) return res.json({ success: false, message: '缺少 name 参数' });
            pm.reload(name)
                .then(() => res.json({ success: true, message: `插件 ${JSON.stringify(name)} 已重载` }))
                .catch(e => res.json({ success: false, message: e.message }));
        });

        this.emotionApp.post('/plugins/reload-all', (req, res) => {
            const pm = global.pluginManager;
            if (!pm) return res.json({ success: false, message: '插件管理器未初始化' });
            pm.reloadAll()
                .then(() => res.json({ success: true, message: '所有插件已重载' }))
                .catch(e => res.json({ success: false, message: e.message }));
        });

        this.emotionApp.post('/plugins/sync', (req, res) => {
            const pm = global.pluginManager;
            if (!pm) return res.json({ success: false, message: '插件管理器未初始化' });
            pm.syncEnabledPlugins()
                .then(() => res.json({ success: true, message: '插件列表已同步' }))
                .catch(e => res.json({ success: false, message: e.message }));
        });

        // ── 退出字幕调整模式（看门狗与显式端点共用）─────────────────────────
        // 2026-11-18 §80：这个状态以前只能靠字幕窗上的「完成/取消」清 —— 一旦没人去点
        // （用户点了「调整」就关掉控制中心、或自动化只点了按钮），`__subtitleAdjusting`
        // 就**永久为真**：positionSubtitleWindow 开头直接 return → 字幕再也不跟随皮套；
        // 而且字幕窗的鼠标穿透被解除了（会挡住桌面点击）。实测就是这样卡住的
        // （皮套移到 300,200，字幕还留在 140,1034）。
        // 现在两条出口：① 90s 看门狗自动退出；② POST /subtitle-adjust-end 显式退出。
        const endSubtitleAdjustMode = (reason) => {
            try {
                if (globalThis.__subtitleAdjustTimer) { clearTimeout(globalThis.__subtitleAdjustTimer); globalThis.__subtitleAdjustTimer = null; }
                const wasOn = globalThis.__subtitleAdjusting === true;
                globalThis.__subtitleAdjusting = false;
                const sub = global.__subtitleWin;
                if (sub && !sub.isDestroyed()) {
                    try { sub.setIgnoreMouseEvents(true); } catch (e) { /* 穿透恢复失败不影响状态 */ }
                    try { sub.webContents.send('subtitle:adjust-mode', { on: false }); } catch (e) { /* 副窗可能还没加载 */ }
                }
                try { if (typeof global.__subtitleReposition === 'function') global.__subtitleReposition('adjust-end:' + reason); } catch (e) { /* 跟随失败下次 move 会纠正 */ }
                if (wasOn) console.log('[subtitle] 退出调整模式（' + reason + '）');
                return wasOn;
            } catch (e) { return false; }
        };
        global.__endSubtitleAdjustMode = endSubtitleAdjustMode;
        this.emotionApp.post('/subtitle-adjust-end', (req, res) => {
            const mode = String((req.body && req.body.mode) || 'cancel');
            const was = endSubtitleAdjustMode('endpoint:' + mode);
            res.json({ success: true, wasAdjusting: was });
        });

        // 字幕位置调整端点
        // 字幕已独立成副窗（决策 2026-11-01）：默认把副窗本身切进调整模式
        // （解除鼠标穿透 + 顶部拖拽条，完成后偏移持久化进 ui.subtitle_position）。
        // 副窗不存在时回落旧路径（subtitle_window:false 的主窗内容器）。
        this.emotionApp.post('/adjust-subtitle-position', async (req, res) => {
            const sub = global.__subtitleWin;
            if (sub && !sub.isDestroyed()) {
                try {
                    globalThis.__subtitleAdjusting = true;
                    sub.setIgnoreMouseEvents(false);
                    sub.webContents.send('subtitle:adjust-mode', { on: true });
                    // 看门狗：90 秒没人点「完成」就自己收摊（宁可自动退出，也不要永久卡住跟随）
                    if (globalThis.__subtitleAdjustTimer) clearTimeout(globalThis.__subtitleAdjustTimer);
                    globalThis.__subtitleAdjustTimer = setTimeout(() => {
                        try { endSubtitleAdjustMode('watchdog-90s'); } catch (e) { /* 计时器内失败只影响本次 */ }
                    }, 90 * 1000);
                    if (typeof globalThis.__subtitleAdjustTimer.unref === 'function') globalThis.__subtitleAdjustTimer.unref();
                    return res.json({ success: true, message: '已进入字幕调整模式：拖动字幕顶部的条，点「完成」保存（90 秒无操作自动退出）' });
                } catch (error) {
                    globalThis.__subtitleAdjusting = false;
                    return res.json({ success: false, message: '副窗调整模式启动失败: ' + error.toString() });
                }
            }

            const mainWindow = BrowserWindow.getAllWindows()[0];
            if (!mainWindow) {
                return res.json({ success: false, message: '应用窗口未找到' });
            }

            const jsCode = `(() => {
                const uic = global.uiController;
                if (!uic?.enterSubtitleAdjustMode) return false;
                uic.enterSubtitleAdjustMode();
                return true;
            })()`;

            try {
                const ok = await mainWindow.webContents.executeJavaScript(jsCode);
                res.json(ok
                    ? { success: true, message: '字幕调整模式已开启' }
                    : { success: false, message: '字幕控制器未初始化' });
            } catch (error) {
                res.json({ success: false, message: error.toString() });
            }
        });

        this.emotionApp.listen(3002, '127.0.0.1', () => {
            console.log('情绪控制服务启动在端口3002');
        });

        // 手机遥控页（2026-11-09 C 档）：独立 :3003 + 令牌 + 白名单。
        // 不把 :3002 绑到 0.0.0.0 —— 它内部有 7 处把请求参数裸拼进 executeJavaScript 的地方。
        try {
            const path = require('path');
            const os = require('os');
            const { startRemoteServer } = require('./remote-control.js');
            const recordsDir = path.join(__dirname, '..', '..', '..', 'data');
            try { require('fs').mkdirSync(recordsDir, { recursive: true }); } catch (e) { /* 已存在 */ }
            startRemoteServer({
                port: Number(process.env.PET_REMOTE_PORT) || 3003,
                recordsDir,
                getWindow: () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.__isPetWindow)
                    || BrowserWindow.getAllWindows()[0],
                getLocalIPs: () => {
                    const out = [];
                    for (const list of Object.values(os.networkInterfaces() || {})) {
                        for (const ni of list || []) {
                            if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
                        }
                    }
                    return out;
                },
            });
        } catch (e) {
            console.error('[遥控] 初始化失败:', e && e.message || e);
        }

        // 直播台（2026-11-09）：主播工作台，只绑 127.0.0.1
        try {
            const { startLivePanel } = require('./live-panel.js');
            startLivePanel({
                port: Number(process.env.PET_LIVE_PANEL_PORT) || 3004,
                getWindow: () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.__isPetWindow)
                    || BrowserWindow.getAllWindows()[0],
            });
        } catch (e) {
            console.error('[直播台] 初始化失败:', e && e.message || e);
        }
    }

    /**
     * 启动VMC控制端点（挂载到情绪控制服务器）
     * 供QT前端实时控制VMC发送器
     */
    _setupVMCEndpoint() {
        if (!this.emotionApp) return;

        this.emotionApp.post('/control-vmc', (req, res) => {
            const { enabled, host, port } = req.body;
            const mainWindow = BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                return res.json({ success: false, message: '应用窗口未找到' });
            }

            // 净化输入
            const safeHost = String(host || '127.0.0.1').replace(/[^a-zA-Z0-9.\-:]/g, '');
            const safePort = parseInt(port) || 39539;
            const hasEnabled = typeof enabled === 'boolean';

            const jsCode = `
                (function() {
                    if (!global.currentVRMAdapter) return '当前未使用VRM模型';
                    const sender = global.currentVRMAdapter.getVMCSender();
                    if (!sender) return 'VMC发送器未初始化';

                    sender.setTarget('${safeHost}', ${safePort});

                    ${hasEnabled ? `
                    sender.enabled = ${!!enabled};
                    if (${!!enabled}) {
                        if (!sender.socket) sender.start();
                        return 'VMC已启用 → ${safeHost}:${safePort}';
                    } else {
                        sender.stop();
                        return 'VMC已关闭';
                    }
                    ` : `
                    return 'VMC目标已更新 → ${safeHost}:${safePort}';
                    `}
                })();
            `;

            mainWindow.webContents.executeJavaScript(jsCode)
                .then(result => res.json({ success: true, message: result }))
                .catch(error => res.json({ success: false, message: error.toString() }));
        });
    }
}

module.exports = { HttpServer };
