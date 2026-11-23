// 导入所需模块
// 跨屏桥接：注入 window.electronScreen（必须在任何模型交互逻辑之前加载）
require('./js/services/electron-screen-bridge.js');
const { Live2DInteractionController: ModelInteractionController } = require('./js/avatar/live2d/interaction.js');
const { configLoader } = require('./js/core/config-loader.js');
const { logToTerminal } = require('./js/api-utils.js');
const { AppInitializer } = require('./js/app-initializer.js');
const { eventBus } = require('./js/core/event-bus.js');
const { Events } = require('./js/core/events.js');
const avatarTransition = require('./js/avatar/transition-overlay.js');

// 初始化状态管理器（自动通过事件管理状态）
require('./js/core/app-state.js');

// D8 交互状态机 shadow（2026-11-22）：只订阅事件 + 只记 mismatch，不写回任何现有状态。
// 放在 app-state 之后：现有布尔先就位，shadow 只做只读比对。
// 2026-11-22 审计：shadow 只是观测，require 失败不能把整个渲染进程带死 —— 降级为一条 warn。
try {
    require('./js/core/interaction-state.js');
} catch (e) {
    try { logToTerminal('warn', '[interaction-state] shadow 加载失败（不影响对话主链）：' + (e && e.message || e)); } catch (_) { /* 日志失败也不拦启动 */ }
}

// D1 每日成绩单（2026-11-22 审计 U6）：模块原先**零调用点**（只有单测 require 它）。
// require 即挂 globalThis.__dailyReport；每小时检查一次，22 点后且当天没生成过就产出（幂等）。
// 全程 try/catch：成绩单是纯本地统计，失败绝不能影响对话主链。
try {
    const dailyReport = require('./js/core/daily-report.js');
    globalThis.__dailyReport = dailyReport.build;
    const tick = () => {
        try {
            if (new Date().getHours() >= 22) {
                const r = dailyReport.runDaily();
                if (r && r.ok && r.file) logToTerminal('info', '[成绩单] 已生成 ' + r.file);
                else if (r && r.ok === false) logToTerminal('warn', '[成绩单] 生成失败：' + (r.detail || '未知'));
            }
        } catch (e) { /* 单次失败不影响下一小时重试 */ }
    };
    setTimeout(tick, 60 * 1000);                       // 启动 1 分钟后先试一次（重启当天也能补）
    setInterval(tick, 60 * 60 * 1000).unref?.();       // 之后每小时一次
} catch (e) {
    try { logToTerminal('warn', '[daily-report] 初始化失败（不影响主链）：' + (e && e.message || e)); } catch (_) { /* ignore */ }
}

// 监听事件，仅用于日志记录
// TTS播放事件日志已注释，避免过多输出
// eventBus.on(Events.TTS_START, () => {
//     logToTerminal('info', '▶️ TTS开始播放');
// });

// eventBus.on(Events.TTS_END, () => {
//     logToTerminal('info', '⏹️ TTS播放结束');
// });

eventBus.on(Events.TTS_INTERRUPTED, () => {
    logToTerminal('info', '⏸️ TTS被中断');
});

// 用户输入开始事件日志已注释，避免与LLM请求日志重复
// eventBus.on(Events.USER_INPUT_START, () => {
//     logToTerminal('info', '🎤 用户输入开始');
// });

// 用户输入结束事件日志已注释，避免过多输出
// eventBus.on(Events.USER_INPUT_END, () => {
//     logToTerminal('info', '✅ 用户输入结束');
// });

// 加载配置文件
let config;
try {
    config = configLoader.load();
    console.log('配置文件加载成功');
    console.log('MCP配置:', config.mcp);
    logToTerminal('info', '配置文件加载成功');

    // 检查TTS和ASR配置
    const ttsEnabled = config.tts?.enabled !== false;
    const asrEnabled = config.asr?.enabled !== false;

    console.log(`TTS模块: ${ttsEnabled ? '启用' : '禁用'}`);
    console.log(`ASR模块: ${asrEnabled ? '启用' : '禁用'}`);
    logToTerminal('info', `TTS模块: ${ttsEnabled ? '启用' : '禁用'}`);
    logToTerminal('info', `ASR模块: ${asrEnabled ? '启用' : '禁用'}`);

} catch (error) {
    console.error('配置加载失败:', error);
    logToTerminal('error', `配置加载失败: ${error.message}`);
    alert(`配置文件错误: ${error.message}\n请检查config.json格式是否正确。`);
    throw error;
}

// 添加重新加载配置的全局函数
global.reloadConfig = function() {
    try {
        config = configLoader.load();
        // Named voice selection applies to subsequent synthesis requests without
        // dropping active requests or rebuilding the audio playback engine.
        if (config.cloud?.aliyun_tts?.enabled && ttsProcessor?.requestHandler?.useAliyunVoice) {
            ttsProcessor.requestHandler.useAliyunVoice(config);
            ttsProcessor.config = config;
            ttsProcessor.ttsUnavailable = false;
        } else if (config.cloud?.volcengine_tts?.enabled && ttsProcessor?.requestHandler?.useVolcengineVoice) {
            ttsProcessor.requestHandler.useVolcengineVoice(config);
            ttsProcessor.config = config;
            ttsProcessor.ttsUnavailable = false;
        }
        console.log('配置文件已重新加载');
        logToTerminal('info', '配置文件已重新加载');
        // 2026-11-09：把新配置真正应用到「启动时只读一次」的模块，
        // 否则设置面板保存后要重启才生效（UI 提示已保存 = 假承诺）。
        try {
            if (voiceChat) voiceChat.config = config;
            // 垫场：运行期读 global.__latencyFillerCfg（缺省则用 config 本身）
            if (!global.__latencyFillerCfg) global.__latencyFillerCfg = {};
            global.__latencyFillerCfg.filler_enabled = config.llm?.filler_enabled === true;
            global.__latencyFillerCfg.filler_delay_ms = config.llm?.filler_delay_ms;
            // 静默：cost.quiet 变化时同步运行期开关（原先只有开机读一次）
            global.__petQuiet = config.cost?.quiet !== false;
            logToTerminal('info', `[配置热应用] 垫场=${config.llm?.filler_enabled === true ? '开' : '关'} 静默=${config.cost?.quiet !== false ? '开' : '关'}`);
        } catch (e) { try { __silentAudit.audit('app.js:reloadConfig-apply', e); } catch (e2) {} }
        return true;
    } catch (error) {
        console.error('重新加载配置文件失败:', error);
        logToTerminal('error', `重新加载配置文件失败: ${error.message}`);
        return false;
    }
}

// 创建模型交互控制器
const modelController = new ModelInteractionController();
global.modelController = modelController; // 添加到全局作用域，供HTTP API访问

// 模块实例（在全局作用域，供其他模块访问）
let voiceChat = null;
let ttsProcessor = null;
let barrageManager = null;

// TTS完成回调 - 弹幕专用
function onBarrageTTSComplete() {
    if (barrageManager) {
        barrageManager.onBarrageTTSComplete();
    }
}

// 增强系统提示词（初始化时使用）
function enhanceSystemPrompt() {
    // 只有启用直播功能时才添加提示词
    if (!config.bilibili || !config.bilibili.enabled) {
        return;
    }

    if (voiceChat && voiceChat.messages && voiceChat.messages.length > 0 && voiceChat.messages[0].role === 'system') {
        const originalPrompt = voiceChat.messages[0].content;

        if (!originalPrompt.includes('你可能会收到直播弹幕')) {
            const enhancedPrompt = originalPrompt + "\n\n你可能会收到直播弹幕消息，这些消息会被标记为[接收到了直播间的弹幕]，表示这是来自直播间观众的消息，而不是主人直接对你说的话。当你看到[接收到了直播间的弹幕]标记时，你应该知道这是其他人发送的，但你仍然可以回应，就像在直播间与观众互动一样。";
            voiceChat.messages[0].content = enhancedPrompt;
            console.log('系统提示已增强，添加了直播弹幕相关说明');
            logToTerminal('info', '系统提示已增强，添加了直播弹幕相关说明');
        }
    }
}

// 主初始化函数
(async function main() {
    avatarTransition.show('正在加载皮套');
    try {
        // 创建应用初始化器
        const appInitializer = new AppInitializer(
            config,
            modelController,
            onBarrageTTSComplete,
            enhanceSystemPrompt
        );

        // 执行初始化
        const modules = await appInitializer.initialize();

        // 保存模块引用到全局作用域
        voiceChat = modules.voiceChat;
        ttsProcessor = modules.ttsProcessor;
        barrageManager = modules.barrageManager;
        avatarTransition.hide();

    } catch (error) {
        avatarTransition.hide();
        console.error("加载模型错误:", error);
        console.error("错误详情:", error.message);
        logToTerminal('error', `加载模型错误: ${error.message}`);
        if (error.stack) {
            logToTerminal('error', `错误堆栈: ${error.stack}`);
        }
    }
})();
