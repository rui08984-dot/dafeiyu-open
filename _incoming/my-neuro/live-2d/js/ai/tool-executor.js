// tool-executor.js - 统一的工具调用执行器
const __silentAudit = require('../core/silent-audit.js');
const { logToTerminal, logToolAction } = require('../api-utils.js');

// 遥测：可选依赖，加载/写盘失败必须吞掉，不能影响工具执行
let _emitTelemetry = null;
try { _emitTelemetry = require('../core/telemetry.js').emitTelemetry; } catch (e) { _emitTelemetry = null; }
function safeEmitTelemetry(payload) {
    if (!_emitTelemetry) return;
    try { _emitTelemetry(payload); } catch (e) { try { __silentAudit.audit('tool-executor.js:9', e); } catch (e2) {} }
}

// 轮次归因（A4，2026-11-21）：每条工具事件都挂 turn_id。
// 没有活动轮次（评测/UI 直调 executeTool）时 ensureTurn('tool') 造一个 ——
// 「孤儿 tool 事件 = 0」由这里结构上保证，不依赖调用方自觉。
let _turnCtx = null;
try { _turnCtx = require('../core/turn-context.js'); } catch (e) { _turnCtx = null; }
function turnIdForTool() {
    try {
        if (!_turnCtx) return '';
        return _turnCtx.currentTurnId() || _turnCtx.ensureTurn('tool');
    } catch (e) { return ''; }
}

// A3 统一回执（2026-11-21）：判成败用形状判据（ok===false / error），不用真值。
// 旧实现 `if (toolResult)` 把 `{ok:false}` 当真值 —— 失败进成功分支、
// 遥测记成 tool.end、模型也看不到失败原因。
let _toolResultLib = null;
try { _toolResultLib = require('../core/tool-result.js'); } catch (e) { _toolResultLib = null; }
function isToolFailure(v) { return _toolResultLib ? _toolResultLib.isFailure(v) : !v; }
function toolFailureDetail(v) { return _toolResultLib ? _toolResultLib.detailOf(v) : ''; }

// 回合日志（B2，2026-11-21）：桌面动作不可逆 —— 执行前先记 intent，执行后记 result。
// 进程被杀时留下的「有 intent 无 result」由启动时的 recover() 标 interrupted_unknown，
// **永不自动重放**（重放=做两遍）。
let _journal = null;
try { _journal = require('../core/turn-journal.js'); } catch (e) { _journal = null; }

// B2：宿主启动时（本模块首次加载）恢复未闭合回合。
// 只把「有 intent 无 result」标成 interrupted_unknown 并喊一声 —— **不重放**。
if (_journal) {
    try {
        const open = _journal.recover();
        if (open && open.length) {
            console.warn('[turn-journal] 上次有 ' + open.length + ' 个动作没有结果（进程被杀/强退）：'
                + open.map((o) => o.tool).slice(0, 5).join('/') + ' 已标 interrupted_unknown，不会自动重放');
        }
    } catch (e) { /* 恢复失败不影响启动 */ }
}

// ── 工具统一超时（2026-11-15 六十三轮，来自 Neuro-sdk 的 action.result ~20s）──
// 之前超时是各工具自己管（有的完全没管）：慢工具会把整轮卡死，用户看到的是「她不理我」。
// 这里收口一个上限：到点就放弃等待，并把原因写进工具结果（模型才知道是超时，不是没这功能）。
// 注意：JS 没法真正取消底层动作，超时只是「不再等」——动作可能仍会在后台完成。
const DEFAULT_TOOL_TIMEOUT_MS = 20000;
const TOOL_TIMEOUT_OVERRIDES = {
    game: 30000,   // 游戏动作要等帧
    see: 25000,    // 截图 + OCR 可能慢
    app: 25000,    // 窗口操作
};

function toolTimeoutFor(name) {
    const key = String(name || '').split('→')[0].trim();
    return TOOL_TIMEOUT_OVERRIDES[key] || DEFAULT_TOOL_TIMEOUT_MS;
}

function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(label + ' 超过 ' + Math.round(ms / 1000) + ' 秒未返回（已放弃等待，它可能还在后台跑）'));
        }, ms);
        Promise.resolve(promise).then(
            (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); },
            (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); },
        );
    });
}

/**
 * 统一的工具调用执行器
 * 负责协调MCP工具和本地Function Call工具的调用
 * 消除重复的工具调用逻辑
 */
class ToolExecutor {
    constructor() {
        // 工具管理器将通过全局变量访问
        // 这是合理的,因为它们是单例服务
    }

    /**
     * 执行工具调用
     * @param {Array} toolCalls - LLM返回的工具调用列表
     * @param {{failuresAsResults?:boolean}} [opts]
     *   failuresAsResults=true：全部工具都失败时也返回失败回执（数组），而不是 null。
     *   llm-handler / 弹幕需要它把「为什么失败」交给模型；旧调用方不传则保持原契约（null）。
     * @returns {Promise<Array|string|Object|null>} 工具执行结果
     */
    // 包装层（A4）：没有对话轮时（评测/UI 直调）造一个「工具批次轮」，跑完收掉。
    // 不这样做的话，tool 事件虽然有 turn_id（孤儿=0 成立），但那个轮永远没有 turn.end ——
    // doctor 的「到工具」阶段统计会一直是 '-'，而且 current 会挂住到下一轮才被覆盖。
    async executeToolCalls(toolCalls, opts) {
        let ownTurn = false;
        if (_turnCtx && Array.isArray(toolCalls) && toolCalls.length > 0 && !_turnCtx.currentTurnId()) {
            try { _turnCtx.ensureTurn('tool'); ownTurn = true; } catch (e) { ownTurn = false; }
        }
        try {
            return await this._executeToolCallsInner(toolCalls, opts);
        } finally {
            if (ownTurn) { try { _turnCtx.endTurn('tool-batch'); } catch (e) { /* 收轮失败不影响结果 */ } }
        }
    }

    async _executeToolCallsInner(toolCalls, opts) {
        if (!toolCalls || toolCalls.length === 0) {
            return null;
        }

        const results = [];
        let hasToolExecuted = false;
        let screenshotData = null;  // 🔥 用于存储截图数据

        for (const toolCall of toolCalls) {
            const functionName = toolCall.function.name;
            const toolStartTs = Date.now();
            const toolTurnId = turnIdForTool();
            try { if (_turnCtx) _turnCtx.markPhase('tool'); } catch (e) { /* 打点失败不影响执行 */ }
            safeEmitTelemetry({
                cat: 'tool',
                type: 'tool.start',
                title: `调用工具: ${functionName}`,
                turn_id: toolTurnId,
                span: 'tool:' + functionName,
                source: 'main'
            });
            let toolResult = null;
            let failureNote = '';   // 超时/异常原因：要进工具结果，模型才知道为什么失败

            // 解析参数
            let parameters;
            try {
                parameters = typeof toolCall.function.arguments === 'string'
                    ? JSON.parse(toolCall.function.arguments)
                    : toolCall.function.arguments;
            } catch (error) {
                console.error('解析工具参数错误:', error);
                parameters = {};
            }

            // 🎈 显示工具调用气泡框（带参数）
            if (typeof global.showToolBubble === 'function') {
                global.showToolBubble(functionName, parameters);
            }

            // B2：先记账再动手（参数只存 hash，不存明文）
            let __journalId = '';
            try {
                if (_journal) {
                    const target = String((parameters && (parameters.window || parameters.win || parameters.name || parameters.target)) || '');
                    __journalId = _journal.beginIntent({ turnId: toolTurnId, tool: functionName, args: parameters, target });
                }
            } catch (e) { __journalId = ''; }

            // 优先尝试MCP工具
            if (global.mcpManager && global.mcpManager.isEnabled) {
                try {
                    const mcpResult = await withTimeout(
                        global.mcpManager.handleToolCalls([toolCall]),
                        toolTimeoutFor(functionName),
                        'MCP 工具 ' + functionName,
                    );
                    if (mcpResult) {
                        toolResult = mcpResult;
                        hasToolExecuted = true;
                    }
                } catch (error) {
                    failureNote = error.message;
                    logToolAction('warn', `MCP工具 ${functionName} 执行失败，尝试本地工具: ${error.message}`);
                }
            }

            // 如果MCP没有处理，尝试插件工具
            if (!toolResult && global.pluginManager) {
                try {
                    const pluginResult = await withTimeout(
                        global.pluginManager.executeTool(functionName, parameters),
                        toolTimeoutFor(functionName),
                        '插件工具 ' + functionName,
                    );
                    if (pluginResult !== undefined) {
                        toolResult = pluginResult;
                        hasToolExecuted = true;
                    }
                } catch (error) {
                    failureNote = error.message;
                    logToolAction('error', `插件工具 ${functionName} 执行失败: ${error.message}`);
                }
            }

            // 如果工具执行成功，添加结果（A3：成败按形状判，失败进 else）
            const toolFailed = isToolFailure(toolResult);
            if (!toolFailed) {
                // 🔥 特殊处理截图工具的返回值
                if (typeof toolResult === 'object' && toolResult._isScreenshot) {
                    console.log('🎯 检测到截图工具返回，准备特殊处理');
                    screenshotData = {
                        tool_call_id: toolCall.id,
                        base64: toolResult.base64,
                        message: toolResult.message
                    };
                    // 将简单的成功消息添加到结果中
                    results.push({
                        tool_call_id: toolCall.id,
                        content: toolResult.message
                    });
                }
                // 处理不同格式的结果
                else if (Array.isArray(toolResult)) {
                    results.push(...toolResult);
                } else if (typeof toolResult === 'object' && toolResult.content) {
                    results.push(toolResult);
                } else {
                    results.push({
                        tool_call_id: toolCall.id,
                        content: toolResult
                    });
                }
            } else {
                // 工具未找到或执行失败（A3：失败原因优先级 = 异常/超时 > 工具自己的 detail/error）
                const why = failureNote || toolFailureDetail(toolResult) || '';
                results.push({
                    tool_call_id: toolCall.id,
                    content: why
                        ? `工具 ${functionName} 失败：${why}`
                        : `工具 ${functionName} 执行失败或未找到`
                });
                logToolAction('error', `工具 ${functionName} 失败：${why || '未给原因'}`);
            }

            // 工具结束遥测（含耗时与成败）
            const toolDurationMs = Date.now() - toolStartTs;
            const toolSecs = (toolDurationMs / 1000).toFixed(1);
            // B2：记 result（失败时带上原因，恢复后能看出做到哪一步、为什么失败）
            try {
                if (_journal && __journalId) {
                    _journal.endResult(__journalId, {
                        ok: !toolFailed,
                        detail: failureNote || toolFailureDetail(toolResult),
                        ms: toolDurationMs,
                    });
                }
            } catch (e) { /* 记账失败不影响工具 */ }
            safeEmitTelemetry({
                cat: 'tool',
                type: toolFailed ? 'tool.error' : 'tool.end',
                title: toolFailed ? `工具 ${functionName} 失败 (${toolSecs}s)` : `工具 ${functionName} 完成 (${toolSecs}s)`,
                level: toolFailed ? 'error' : 'info',
                metrics: { duration_ms: toolDurationMs, tool: functionName, ok: !toolFailed },
                turn_id: toolTurnId,
                span: 'tool:' + functionName,
                source: 'main'
            });
        }

        if (!hasToolExecuted) {
            logToolAction('error', '所有工具调用均失败');
            // ⚠ 2026-11-22 审计：原实现无条件 return null。调用方（llm-handler）看到 null 会抛
            //   「工具调用失败」，而它已经把 assistant(tool_calls) 推进历史 —— 下一轮请求缺
            //   tool 响应，OpenAI 兼容层直接 400；且上面算好的「为什么失败」全被丢掉。
            //   默认仍返回 null（旧契约/场景评测依赖），需要失败回执的调用方显式 opt-in。
            if (opts && opts.failuresAsResults === true && results.length) return results;
            return null;
        }

        // 🔥 如果有截图数据，返回特殊格式
        if (screenshotData) {
            return {
                _hasScreenshot: true,
                screenshotData: screenshotData,
                results: results
            };
        }

        // 如果只有一个结果，返回单个字符串(向后兼容)
        if (results.length === 1 && typeof results[0] === 'string') {
            return results[0];
        }

        // 如果只有一个结果对象，返回其content(向后兼容)
        if (results.length === 1 && results[0].content) {
            return results[0].content;
        }

        // 返回完整的结果数组
        return results;
    }

    /**
     * 检查是否有可用的工具管理器
     * @returns {boolean}
     */
    hasToolManagers() {
        const hasMCP = global.mcpManager && global.mcpManager.isEnabled;
        return hasMCP;
    }

    /**
     * 获取工具统计信息
     * @returns {Object}
     */
    getStats() {
        const stats = {
            mcpEnabled: false,
            mcpToolCount: 0,
            totalTools: 0
        };

        if (global.mcpManager && global.mcpManager.isEnabled) {
            stats.mcpEnabled = true;
            const mcpStats = global.mcpManager.getStats();
            stats.mcpToolCount = mcpStats.tools || 0;
        }

        stats.totalTools = stats.mcpToolCount;

        return stats;
    }
}

// 导出单例（超时工具也导出，单测要能直接验）
const toolExecutor = new ToolExecutor();
module.exports = { toolExecutor, ToolExecutor, DEFAULT_TOOL_TIMEOUT_MS, toolTimeoutFor, withTimeout };
