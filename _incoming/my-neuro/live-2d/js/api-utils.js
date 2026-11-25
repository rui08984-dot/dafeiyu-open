// api-utils.js - API相关工具函数模块
const fs = require('fs');
const path = require('path');

// ── runtime.log 写入（时间戳 + 轮转）──────────────────────────────
// ⚠ 2026-11-10 数据完整性修复：
//   ① 原来每行只有 [INFO]/[ERROR]，**没有时间**——出事后无法定位是哪一轮、和别的事件对不上。
//   ② 文件只 append 不轮转（实测已 5.4MB 且继续涨），UI 读整个文件会越来越慢。
//   现在：每行加 `[YYYY-MM-DD HH:mm:ss]` 前缀；超过 10MB 时把当前文件 rename 成
//   runtime.log.1（只保留 1 份历史，够定位问题，也不会无限占盘）。
const RUNTIME_LOG = path.join(__dirname, '..', 'runtime.log');
const RUNTIME_LOG_MAX = 10 * 1024 * 1024;   // 10MB

function _logStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function appendRuntimeLog(line) {
    // 2026-11-21 审计（P2）：只有真正的 Electron 宿主才写 runtime.log。
    // 为什么：单测/CLI 也 require 插件模块，插件里的 logToTerminal 会把**测试制造的**
    // 错误写进生产 runtime.log —— 实测 test-asr-timeout 故意用 2s 超时，结果
    // runtime.log 里反复出现「【本地ASR】fetch timeout（2000ms）」，看起来像线上 ASR
    // 一直在超时（排查这个假象花了一轮）。测试要看日志就自己接管 console。
    // 需要强制写盘时设 PET_RUNTIME_LOG=1（排障用）。
    const isElectron = !!(process.versions && process.versions.electron);
    if (!isElectron && process.env.PET_RUNTIME_LOG !== '1') return;
    try {
        // 先看大小再写：>10MB 就把当前文件滚成 .1（覆盖旧 .1，只留一份）
        try {
            if (fs.statSync(RUNTIME_LOG).size > RUNTIME_LOG_MAX) {
                fs.renameSync(RUNTIME_LOG, RUNTIME_LOG + '.1');
            }
        } catch (e) { /* 文件还不存在 → 直接写 */ }
        fs.appendFileSync(RUNTIME_LOG, '[' + _logStamp() + '] ' + line + '\n', 'utf8');
    } catch (e) {
        // 忽略文件写入错误
    }
}

// 终端日志记录函数 - 普通日志
function logToTerminal(level, message) {
    const formattedMsg = `[${level.toUpperCase()}] ${message}`;

    // 输出到Electron DevTools控制台（调试用）
    if (level === 'error') {
        console.error(message);
    } else if (level === 'warn') {
        console.warn(message);
    } else {
        console.log(message);
    }

    // 写入文件供UI读取（Electron应用的日志无法通过stdout传递给父进程）
    appendRuntimeLog(formattedMsg);
}

// 工具日志记录函数 - 专用于工具调用相关日志
function logToolAction(level, message) {
    // 添加 [TOOL] 标记，方便UI区分
    const formattedMsg = `[${level.toUpperCase()}][TOOL] ${message}`;

    // 输出到Electron DevTools控制台（调试用）
    if (level === 'error') {
        console.error(`[TOOL] ${message}`);
    } else if (level === 'warn') {
        console.warn(`[TOOL] ${message}`);
    } else {
        console.log(`[TOOL] ${message}`);
    }

    // 写入到 runtime.log（和普通日志一起，通过[TOOL]标记区分）
    appendRuntimeLog(formattedMsg);
}

// 统一的API错误处理工具函数
async function handleAPIError(response) {
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

    // 多模态不支持是预期的可恢复错误，降级为 warn 避免误导用户
    const isMultimodalUnsupported = errorDetail.toLowerCase().includes('multimodal') ||
        (response.status === 400 && errorDetail.toLowerCase().includes('image') && errorDetail.toLowerCase().includes('support'));
    if (isMultimodalUnsupported) {
        logToTerminal('warn', `📷 当前模型不支持图片/多模态，将自动过滤图片后重试`);
    } else {
        logToTerminal('error', `API错误 (${response.status} ${response.statusText}):\n${errorDetail}`);
    }

    let errorMessage = "";
    // 429 优先显示上游原话：2026-11-24 实测 429 的真因是「套餐周配额用完」，
    // 旧文案「请求过于频繁」会把人带向「等一会儿再试」，而实际要等到重置时刻。
    let apiMsg = '';
    try {
        const j = JSON.parse(errorDetail);
        apiMsg = String((j && j.error && j.error.message) || (j && j.message) || '');
    } catch (e) { apiMsg = ''; }
    switch (response.status) {
        case 401:
            errorMessage = "API密钥验证失败，请检查你的API密钥";
            break;
        case 403:
            errorMessage = "API访问被禁止，你的账号可能被限制";
            break;
        case 404:
            errorMessage = "API接口未找到，请检查API地址";
            break;
        case 429:
            errorMessage = apiMsg ? `额度/限流：${apiMsg.slice(0, 240)}` : "请求过于频繁，超出API限制";
            break;
        case 500:
        case 502:
        case 503:
        case 504:
            errorMessage = "服务器错误，AI服务当前不可用";
            break;
        default:
            errorMessage = `API错误: ${response.status} ${response.statusText}`;
    }

    // 2026-11-24：把状态/响应体/重置时刻挂到 Error 上，让 llm-health 能区分
    // 「周配额用完」和「普通限流」，也方便 doctor 直接显示。
    const err = new Error(`${errorMessage}\n详细信息: ${errorDetail}`);
    try {
        err.status = response.status;
        err.body = String(errorDetail).slice(0, 2000);
        const m = /resets?\s+at\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/i.exec(errorDetail);
        if (m) {
            const t = Date.parse(m[1]);
            if (Number.isFinite(t)) err.quotaResetAt = t;
        } else {
            let sec = NaN;
            try { sec = Number(JSON.parse(errorDetail)?.retry_after); } catch (e) { sec = NaN; }
            if (!Number.isFinite(sec)) {
                try { sec = Number(response.headers && response.headers.get && response.headers.get('retry-after')); } catch (e) { sec = NaN; }
            }
            if (Number.isFinite(sec) && sec > 0) err.retryAfterMs = Math.round(sec * 1000);
        }
    } catch (e) { /* 附加信息失败不影响抛错 */ }
    if (response.status === 429 || response.status >= 500) {
        try { require('./core/llm-health.js').llmHealth.noteFailure(err); } catch (e) { /* 健康模块不可用不影响主链 */ }
    }

    throw err;
}

// 统一的工具列表合并函数
function getMergedToolsList() {
    let allTools = [];

    // 添加MCP工具
    if (global.mcpManager && global.mcpManager.isEnabled) {
        const mcpTools = global.mcpManager.getToolsForLLM();
        if (mcpTools && mcpTools.length > 0) {
            allTools.push(...mcpTools);
        }
    }

    // 添加插件工具
    if (global.pluginManager) {
        const pluginTools = global.pluginManager.getAllTools();
        if (pluginTools && pluginTools.length > 0) {
            allTools.push(...pluginTools);
        }
    }

    // 工具顺序稳定（ADR-014 轨道 1）：上游按字节前缀复用缓存，而 tools 紧跟在 system 之后。
    // MCP 按连接顺序、插件按加载顺序拼出来的列表，在「插件热重载 / 两个 MCP 服务谁先连上」
    // 时会换序 —— 每次换序，它后面的整段 messages 缓存全部 miss。
    // 这里按工具名稳定排序（同名保持原有先后，Node 的 sort 是稳定的），
    // 工具内容/别名/语义一律不动；排序失败就保持原顺序，绝不影响工具可用性。
    try {
        const nameOf = (t) => String((t && (t.function && t.function.name)) || (t && t.name) || '');
        allTools.sort((a, b) => {
            const na = nameOf(a);
            const nb = nameOf(b);
            if (na < nb) return -1;
            if (na > nb) return 1;
            return 0;
        });
    } catch (e) { /* 排序失败不影响工具列表 */ }

    // 工具面体积哨兵（2026-11-15 六十三轮）：
    // 实测 29 个工具 ≈14.4k 字符，其中描述只占 18%、参数字段占 66% —— 想靠删描述瘦身收效很小，
    // 而砍工具栏会伤能力。所以这里不做自动裁剪，只在**超预算**时提示一次（冷启动/换 provider 要全付）。
    try {
        if (!globalThis.__toolBudgetWarned) {
            const chars = JSON.stringify(allTools).length;
            if (chars > 16000) {
                globalThis.__toolBudgetWarned = true;
                logToTerminal('warn', '🧰 工具面 ' + chars + ' 字符（>16000）：冷启动成本偏高，考虑合并低频工具');
            }
        }
    } catch (e) { /* 哨兵失败不影响工具列表 */ }

    return allTools;
}

module.exports = {
    logToTerminal,
    logToolAction,
    handleAPIError,
    getMergedToolsList
};
