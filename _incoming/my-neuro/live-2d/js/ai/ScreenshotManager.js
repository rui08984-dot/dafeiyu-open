// ScreenshotManager.js - 截图管理模块
const { ipcRenderer } = require('electron');
const nodeNet = require('node:net');
const { logToTerminal } = require('../api-utils.js');

class ScreenshotManager {
    constructor(voiceChatInterface) {
        this.voiceChat = voiceChatInterface;
        this.screenshotEnabled = voiceChatInterface.screenshotEnabled;
        this.autoScreenshot = voiceChatInterface.autoScreenshot;

        // 根据配置选择本地或云端模式（2026-11-16：这两个原来写死，config.bert.enabled/url
        // 是全仓没人读的死键。现在由 VoiceChatFacade 从 config.bert 传进来，开关才真的有效。）
        this.bertEnabled = voiceChatInterface.bertEnabled !== false;
        this.bertUrl = voiceChatInterface.bertUrl || 'http://127.0.0.1:6007/classify';
        this.bertApiKey = voiceChatInterface.bertApiKey || null;
        this._bertOffLogged = false;
    }

    // 判断是否需要截图
    async shouldTakeScreenshot(text) {
        if (!this.screenshotEnabled) return false;

        // 📸 显式视觉关键词快速路径（2026-11-10 三十七轮，拟真「看屏幕」黑帧链根治）：
        //   用户直接要求看屏幕时不该依赖 BERT 分类器在线（:6007 离线时判定走保守 false，
        //   实测「看一眼我的屏幕」永远不触发截图——拟真黑帧链的根因之一）。
        //   关键词命中直接 true，走到 Rust 截图引擎（54ms）→ vision 模型。
        const VISUAL_RE = /看(一)?眼|看看|屏幕|画面|截图|显示什么|看到什么|桌面上|现在显示|帮我看看/;
        if (VISUAL_RE.test(String(text || ''))) {
            logToTerminal('info', '📸 视觉关键词命中，直接判定需要截图（不依赖 BERT）');
            return true;
        }

        // 🎯 优先检查自动对话模块的截图标志
        if (this.voiceChat._autoScreenshotFlag) {
            console.log('自动对话模块要求截图');
            return true;
        }

        if (this.autoScreenshot) {
            console.log('自动截图模式已开启，将为本次对话截图');
            return true;
        }

        // 检查文本中是否包含截图标记
        if (text.includes('[需要截图]')) {
            console.log('检测到截图标记，将进行截图');
            return true;
        }

        // bert.enabled=false：跳过分类器（关键词命中在上面已经直接返回 true 了）
        if (!this.bertEnabled) {
            if (!this._bertOffLogged) {
                this._bertOffLogged = true;
                logToTerminal('info', 'BERT 截图分类器已关闭（config.bert.enabled=false），只按关键词判定');
            }
            return false;
        }

        try {
            // 300ms 竞速超时：本判定在 LLM 首字关键路径上，分类器抖一下就拖慢整句。
            // 超时按「不需要截图」处理（保守侧——宁可少截一张，不可多等一秒）。
            const result = await Promise.race([
                this.callBertClassifier(text),
                new Promise(resolve => setTimeout(() => resolve('__timeout__'), 300))
            ]);
            if (result === '__timeout__') {
                logToTerminal('info', '截图分类器 300ms 超时，本轮跳过截图判定');
                return false;
            }
            if (result) {
                const needVision = result["Vision"] === "是";
                if (needVision) logToTerminal('info', '需要截图');
                return needVision;
            }
            return false;
        } catch (error) {
            console.error('判断截图错误:', error);
            return false;
        }
    }

    // 统一调用BERT分类API的方法
    async callBertClassifier(text) {
        if (!(await this.isLocalBertAvailable())) return null;
        try {
            const headers = {
                'Content-Type': 'application/json'
            };

            // 如果是云端模式，添加 API Key
            if (this.bertApiKey) {
                headers['X-API-Key'] = this.bertApiKey;
            }

            // ⚠ 300ms 硬超时：此调用挡在 LLM 请求前，:6007 假死时若无超时整句回复卡住。
            const response = await fetch(this.bertUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    text: text
                }),
                signal: AbortSignal.timeout(300)
            });

            if (!response.ok) {
                await this.handleBertError(response);
                return null;
            }

            const data = await response.json();
            return data;
        } catch (error) {
            logToTerminal('error', `BERT分类错误: ${error.message}`);
            console.error('BERT分类错误:', error);
            return null;
        }
    }

    isLocalBertAvailable() {
        return new Promise(resolve => {
            // 从 bertUrl 解析，支持把分类器挪到别的端口/主机（config.bert.url）
            let host = '127.0.0.1', port = 6007;
            try {
                const u = new URL(this.bertUrl);
                host = u.hostname || host;
                port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
            } catch (e) { /* 非法 URL 就退回默认 */ }
            const socket = nodeNet.createConnection({ host, port });
            const finish = available => {
                socket.removeAllListeners();
                socket.destroy();
                resolve(available);
            };
            socket.setTimeout(250);
            socket.once('connect', () => finish(true));
            socket.once('timeout', () => finish(false));
            socket.once('error', () => finish(false));
        });
    }

    // 截图功能
    async takeScreenshotBase64() {
        try {
            const base64Image = await ipcRenderer.invoke('take-screenshot');
            console.log('截图已完成');
            return base64Image;
        } catch (error) {
            console.error('截图错误:', error);
            throw error;
        }
    }

    // 统一的BERT错误处理
    async handleBertError(response) {
        let errorDetail = "";
        try {
            const errorBody = await response.text();
            try {
                const errorJson = JSON.parse(errorBody);
                errorDetail = JSON.stringify(errorJson, null, 2);
            } catch (e) {
                errorDetail = errorBody;
            }
        } catch (e) {
            errorDetail = "无法读取错误详情";
        }

        const serviceName = this.bertApiKey ? '云端肥牛网关BERT' : '本地BERT';
        let errorMessage = "";
        switch (response.status) {
            case 401:
                errorMessage = `【${serviceName}】API密钥验证失败，请检查你的API密钥是否正确`;
                break;
            case 403:
                errorMessage = `【${serviceName}】API访问被禁止，你的账号可能被限制或额度已用完`;
                break;
            case 429:
                errorMessage = `【${serviceName}】请求过于频繁，超出API限制或额度已用完`;
                break;
            case 500:
            case 502:
            case 503:
            case 504:
                errorMessage = `【${serviceName}】服务器错误，AI服务当前不可用`;
                break;
            default:
                errorMessage = `【${serviceName}】API错误: ${response.status} ${response.statusText}`;
        }

        const fullError = `${errorMessage}\n详细信息: ${errorDetail}`;
        logToTerminal('error', fullError);
        console.error(errorMessage);
    }
}

module.exports = { ScreenshotManager };
