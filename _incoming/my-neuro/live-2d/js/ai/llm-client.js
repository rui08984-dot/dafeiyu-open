// llm-client.js - 统一的LLM API客户端
const { logToTerminal, handleAPIError } = require('../api-utils.js');
const { sanitizeToolMessageSequence } = require('./tool-message-utils.js');
const { applyReasoningToRequestBody } = require('./reasoning-request.js');
const promptLayout = require('../core/prompt-layout.js');

// ── 前缀缓存命中率：从「不可观测」变成「一行日志 + 一个可查询的全局」──────────
// 用户要的是「命中缓存 ≥99.8%」，但改造前客户端从不读 usage 里的 cached 字段，
// 所以这个数字一直是猜的。这里做两件事：
//   ① 流式请求显式开 stream_options.include_usage（OpenAI 兼容端点默认流式不带 usage）；
//   ② 每次调用把 prompt/cached 记进 globalThis.__cacheStats（保留最近 50 次），
//      并在有 cached 字段时打一行日志。字段不存在时**报"无此字段"而不是当 0**。
function recordUsage(usage, label) {
    const r = promptLayout.cacheRate(usage);
    if (r.prompt == null) return null;
    const s = globalThis.__cacheStats || (globalThis.__cacheStats = {
        calls: 0, withCacheField: 0, sumPrompt: 0, sumCached: 0, series: [], lastRate: null,
    });
    s.calls += 1;
    s.sumPrompt += r.prompt;
    if (r.cached != null) {
        s.withCacheField += 1;
        s.sumCached += r.cached;
        s.lastRate = r.rate;
        s.series.push({ at: Date.now(), prompt: r.prompt, cached: r.cached, rate: r.rate, label });
        if (s.series.length > 50) s.series.shift();
        logToTerminal('info', `💾 前缀缓存 ${r.rate}%（cached ${r.cached} / prompt ${r.prompt}，${label}）`);
    } else if (s.withCacheField === 0 && !s._warnedNoField) {
        s._warnedNoField = true;
        logToTerminal('warn', `💾 上游 usage 没有 cached 字段（只有 ${r.fields.join(', ') || '空'}），命中率不可测`);
    }
    return r;
}

/**
 * 统一的LLM客户端
 * 封装所有LLM API调用逻辑,消除重复代码
 */
class LLMClient {
    /**
     * 支持两种入参：
     *   1. new LLMClient(config)                     - 旧方式，读取 config.llm
     *   2. LLMClient.fromProviderConfig(resolved, r) - 新方式，传入 provider 解析结果（平铺对象）
     */
    constructor(config) {
        // 兼容：完整 config（取 config.llm）或已解析的 provider 平铺对象（直接取字段）
        const llmConfig = (config && config.llm) ? config.llm : (config || {});
        this.apiKey = llmConfig.api_key;
        this.apiUrl = llmConfig.api_url;
        this.model = llmConfig.model;
        this.providerId = llmConfig.id || llmConfig.provider_id || '';
        this.temperature = llmConfig.temperature || 1.0;
        this.temperatureEnabled = llmConfig.temperature_enabled ?? false;
        this.topP = Number.isFinite(Number(llmConfig.top_p)) ? Number(llmConfig.top_p) : null;
        this.maxTokens = Number.isFinite(Number(llmConfig.max_tokens)) ? Number(llmConfig.max_tokens) : null;
        // 思考模式默认关闭：只有显式 reasoning_enabled === true 才开启
        this.reasoningEnabled = llmConfig.reasoning_enabled === true;
        this.reasoningEffort = llmConfig.reasoning_effort || null;
    }

    /**
     * 从 provider 解析结果创建客户端。
     * @param {object} resolved - llmProviderManager.resolveProvider 系列方法的返回值
     * @param {object} [retryConfig] - 全局重试配置（config.llm.retry）
     * @returns {LLMClient}
     */
    static fromProviderConfig(resolved, retryConfig) {
        return new LLMClient({ ...resolved, retry: retryConfig || resolved.retry || {} });
    }

    /**
     * 发送聊天完成请求
     * @param {Array} messages - 消息数组
     * @param {Array} tools - 可选的工具列表
     * @param {boolean} stream - 是否使用流式响应
     * @param {Function} onChunk - 流式响应时的回调函数，接收每个文本块
     * @returns {Promise<Object>} API响应的消息对象
     */
    async chatCompletion(messages, tools = null, stream = false, onChunk = null) {
        // 🔥 清理消息格式,确保API兼容性
        const cleanedMessages = this._cleanMessagesForAPI(messages);

        const requestBody = {
            model: this.model,
            messages: cleanedMessages,
            stream: stream
        };
        // 流式默认不带 usage；显式要求上游在最后一个 chunk 里带上（含 cached_tokens）。
        // 老端点可能不认这个字段 → 下面的请求在 400 时会自动去掉重试一次。
        if (stream) requestBody.stream_options = { include_usage: true };
        if (this.temperatureEnabled) {
            requestBody.temperature = this.temperature;
        }
        // 人格型角色需要一点发散，但不能跑飞：top_p 一起给
        if (Number.isFinite(this.topP) && this.topP > 0 && this.topP <= 1) {
            requestBody.top_p = this.topP;
        }
        if (Number.isFinite(this.maxTokens) && this.maxTokens > 0) {
            requestBody.max_tokens = this.maxTokens;
        }

        applyReasoningToRequestBody(requestBody, this);

        // 添加工具列表(如果提供)
        if (tools && tools.length > 0) {
            requestBody.tools = tools;
        } else {
            // tools 为 null（视觉模型调用）或空数组（强制取最终回复）都是预期行为。
            // 原来每次调用都打一行，用户看到的就是满屏重复噪音 —— 现在只在第一次说明，之后静默。
            if (!globalThis.__noToolsLogged) {
                globalThis.__noToolsLogged = true;
                logToTerminal('info', '有模型调用不带工具（视觉/收尾用），属正常，本条只提示一次');
            }
        }


        // 🔥 调试：在发送前验证JSON格式
        try {
            const testJson = JSON.stringify(requestBody);
            JSON.parse(testJson); // 验证可以正确解析

            // 打印请求统计信息
            const stats = {
                messagesCount: requestBody.messages.length,
                toolsCount: requestBody.tools?.length || 0,
                requestSize: testJson.length,
                temperature: requestBody.temperature  // 🔥 添加temperature到统计信息
            };
//            logToTerminal('info', `📤 API请求统计: ${JSON.stringify(stats)}`);
//            logToTerminal('info', `🌡️ Temperature参数: ${requestBody.temperature}`);  // 🔥 明确打印temperature

            // 如果请求过大,警告
            if (stats.requestSize > 50000) {
//                logToTerminal('warn', `⚠️ 请求体过大 (${Math.round(stats.requestSize/1024)}KB)，可能导致API错误`);
            }
        } catch (jsonError) {
            logToTerminal('error', `❌ 请求体JSON格式错误: ${jsonError.message}`);
            console.error('请求体内容:', requestBody);
            throw new Error(`请求格式错误: ${jsonError.message}`);
        }

        try {
            const doFetch = (body) => fetch(`${this.apiUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify(body)
            });

            const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
            let response = await (async () => {
                // 分段计时（2026-11-16）：用户反馈「说一句等好久」，而直连同网关只要 1.5s。
                // 这里分清「建连+等响应头」与「等首块 token」——两者的修法完全不同。
                const t0 = _now();
                // 事件循环卡顿探针：如果请求期间主线程被 CPU 任务堵住（截图/OCR/编码/大量 WS），
                // 网络回调会跟着排队 —— 表现就是「网关明明 1.5s，这里却 7s」。
                let _lagMax = 0; let _lagPrev = _now();
                const _lagTimer = setInterval(() => {
                    const n = _now(); const lag = n - _lagPrev - 50; if (lag > _lagMax) _lagMax = lag; _lagPrev = n;
                }, 50);
                if (_lagTimer.unref) _lagTimer.unref();
                let r;
                try {
                    r = await doFetch(requestBody);
                } finally {
                    // 2026-11-22 内存采样：原来只在成功路径 clearInterval。doFetch 抛错
                    // （断网/超时/网关 5xx）时这个 50ms 定时器会永远活着 —— 每失败一轮漏一个，
                    // 长跑越积越多。定时器只做诊断，任何路径都必须停。
                    clearInterval(_lagTimer);
                }
                const headersMs = Math.round(_now() - t0);
                try { logToTerminal('info', `[延迟] 网关响应头 ${headersMs}ms · 期间事件循环最大卡顿 ${Math.round(_lagMax)}ms`); } catch (e) {}
                return r;
            })();

            // 严格的端点会因为 stream_options 这个未知字段直接 400。
            // 这时去掉它重试一次：宁可拿不到 usage，也不能把她的回复打挂。
            if (!response.ok && response.status === 400 && requestBody.stream_options) {
                let errText = '';
                try { errText = await response.text(); } catch (e) { /* 读不到就按通用错误处理 */ }
                if (/stream_options|unrecognized|unknown|invalid|extra/i.test(errText)) {
                    logToTerminal('warn', '💾 端点不认 stream_options，去掉后重试（这轮拿不到命中率）');
                    delete requestBody.stream_options;
                    response = await doFetch(requestBody);
                } else {
                    // 不是 stream_options 的锅：错误体已经读了，包成同样的形状交给统一错误处理
                    await handleAPIError({ status: 400, statusText: 'Bad Request', text: async () => errText });
                }
            }

            if (!response.ok) {
                await handleAPIError(response);
            }

            // 🔥 流式响应处理
            if (stream && onChunk) {
                return await this._handleStreamResponse(response, onChunk);
            }

            // 非流式响应处理
            const responseData = await response.json();
            recordUsage(responseData && responseData.usage, 'non-stream');

            // 验证响应格式
            this._validateResponse(responseData);

            logToTerminal('info', `AI回复中`);

            const message = responseData.choices[0].message;

            // 🔥 处理 Qwen3 等模型的 reasoning_content 字段
            // 仅在没有 tool_calls 时才用 reasoning_content 替代空 content（Qwen3 推理模式）
            // 有 tool_calls 时 reasoning_content 是思考过程，不应作为回复内容（Gemini 等）
            if ((!message.content || message.content.trim() === '') && message.reasoning_content && !message.tool_calls) {
                message.content = message.reasoning_content;
            }

            // 🔥 过滤思考内容（Gemini / DeepSeek 等模型可能在 content 中混入思考）
            if (message.content) {
                message.content = this._filterThinkingContent(message.content);
            }

            // 🔥 解析 Qwen 模型的文本格式工具调用（Hermes/XML style）
            // Qwen 模型返回的是文本格式的 <tool_call>，而不是标准的 tool_calls 对象
            if (message.content && !message.tool_calls) {
                const parsedToolCalls = this._parseQwenToolCalls(message.content);
                if (parsedToolCalls && parsedToolCalls.length > 0) {
                    logToTerminal('info', `🔧 AI调用了 ${parsedToolCalls.length} 个工具`);
                    message.tool_calls = parsedToolCalls;
                    // 从 content 中移除工具调用部分，只保留文本回复
                    message.content = this._removeToolCallsFromContent(message.content);
                }
            }

            return message;

        } catch (error) {
            // 多模态不支持错误由上层 llm-handler 统一处理和记录，这里不重复打 ERROR
            const isMultimodalError = error.message.toLowerCase().includes('multimodal') ||
                error.message.toLowerCase().includes('不支持图片') ||
                error.message.toLowerCase().includes('模型不支持图片');
            if (!isMultimodalError) {
                logToTerminal('error', `LLM API调用失败: ${error.message}`);
            }
            throw error;
        }
    }

    /**
     * 清理消息格式,确保API兼容性
     * @private
     * @param {Array} messages - 原始消息数组
     * @returns {Array} 清理后的消息数组
     */
    _cleanMessagesForAPI(messages) {
        const normalizedMessages = messages.map(msg => {
            // 🔥 处理 assistant 消息的 content 为 null 的情况
            if (msg.role === 'assistant') {
                // 如果有 tool_calls 但 content 为 null,设为空字符串
                if (msg.content === null && msg.tool_calls) {
                    return {
                        ...msg,
                        content: '' // 某些API要求content不能为null
                    };
                }
            }

            // 🔥 处理 tool 消息,确保格式正确
            if (msg.role === 'tool') {
                let content = msg.content;

                // 如果content是对象或数组,转为JSON字符串
                if (typeof content === 'object' && content !== null) {
                    try {
                        content = JSON.stringify(content);
                    } catch (e) {
                        content = String(content);
                    }
                }

                // 确保content是字符串
                if (typeof content !== 'string') {
                    content = String(content || '');
                }

                // 🔥 确保字符串不包含控制字符(可能导致JSON解析失败)
                // 移除所有不可见的控制字符,但保留换行符(\n)和制表符(\t)
                content = content.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

                // 🔥 确保字符串长度不超过限制(避免超大响应)
                const MAX_CONTENT_LENGTH = 8000;
                if (content.length > MAX_CONTENT_LENGTH) {
                    content = content.substring(0, MAX_CONTENT_LENGTH) + '...(内容过长已截断)';
                }

                // 返回清理后的tool消息
                return {
                    role: 'tool',
                    name: msg.name || 'unknown_tool',
                    content: content,
                    tool_call_id: msg.tool_call_id
                };
            }

            // 其他消息保持原样
            return msg;
        });

        // 🔥 发送前的最后一道防线：清理 assistant.tool_calls 与 tool 响应不配对的序列。
        // 无论坏数据来自旧版本保存的对话历史、裁剪还是工具执行中断，
        // 都保证发给 API 的序列合法，避免 "tool_calls must be followed by tool messages" 400 错误
        return sanitizeToolMessageSequence(normalizedMessages);
    }

    /**
     * 验证API响应格式
     * @private
     */
    _validateResponse(responseData) {
        // 检查API错误响应
        if (responseData.error) {
            const errorMsg = responseData.error.message || responseData.error || '未知API错误';
            logToTerminal('error', `LLM API错误: ${errorMsg}`);
            // 🔥 将完整的错误信息传递出去，方便重试机制识别
            throw new Error(`API错误: ${errorMsg}`);
        }

        // 检查响应格式,适应不同的API响应结构
        let choices;
        if (responseData.choices) {
            choices = responseData.choices;
        } else if (responseData.data && responseData.data.choices) {
            choices = responseData.data.choices;
        } else {
            // 🔥 详细打印响应数据以便调试
            const debugInfo = JSON.stringify(responseData).substring(0, 500);
            logToTerminal('error', `LLM响应格式异常，缺少choices字段。响应数据: ${debugInfo}`);
            console.error('完整响应数据:', responseData);
            throw new Error('LLM响应格式异常：缺少choices字段或为空');
        }

        if (!choices || choices.length === 0) {
            // 🔥 打印完整响应数据
            const debugInfo = JSON.stringify(responseData).substring(0, 500);
            logToTerminal('error', `LLM响应choices为空。响应数据: ${debugInfo}`);
            console.error('完整响应数据:', responseData);

            // 🔥 检查响应数据中是否包含"不支持图片"相关的错误信息
            const responseStr = JSON.stringify(responseData).toLowerCase();
            if (responseStr.includes('image') &&
                (responseStr.includes('not support') ||
                 responseStr.includes('不支持') ||
                 responseStr.includes('invalid') ||
                 responseStr.includes('unsupported'))) {
                logToTerminal('error', '⚠️ 检测到模型不支持视觉功能');
                throw new Error('模型不支持图片：该模型不支持 image_url 参数');
            }

            // 🔥 检查是否是内容过滤（多种可能的字段）
            if (responseData.promptFilterResults ||
                responseData.finishReason === 'content_filter' ||
                responseData.finish_reason === 'content_filter') {
                throw new Error('API内容过滤：请求被API的内容过滤器拦截，可能包含敏感内容');
            }

            // 🔥 检查usage，如果有prompt_tokens但completion_tokens为0，很可能是内容过滤
            if (responseData.usage &&
                responseData.usage.prompt_tokens > 0 &&
                responseData.usage.completion_tokens === 0) {
                logToTerminal('warn', '⚠️ API处理了请求但拒绝生成内容，可能触发了安全过滤器');
                throw new Error('API拒绝生成内容：可能触发了安全过滤器或内容政策限制。请检查最近的对话内容。');
            }

            throw new Error('LLM响应格式异常：choices为空');
        }

        // 将标准化的choices写回
        responseData.choices = choices;
    }

    /**
     * 解析 Qwen 模型的文本格式工具调用
     * @private
     * @param {string} content - 包含工具调用的文本内容
     * @returns {Array|null} 标准格式的 tool_calls 数组
     */
    _parseQwenToolCalls(content) {
        const toolCalls = [];
        let index = 0;

        // 格式1: <tool_call> ... </tool_call> (JSON 格式)
        const toolCallRegex1 = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
        let match;

        while ((match = toolCallRegex1.exec(content)) !== null) {
            try {
                const toolCallJson = JSON.parse(match[1]);
                toolCalls.push({
                    id: `call_qwen_${Date.now()}_${index}`,
                    type: 'function',
                    function: {
                        name: toolCallJson.name,
                        arguments: JSON.stringify(toolCallJson.arguments || {})
                    }
                });
                index++;
            } catch (error) {
                logToTerminal('warn', `⚠️ 解析 Qwen 工具调用(格式1)失败: ${error.message}`);
            }
        }

        // 格式2: <function_name attr1="value1" attr2="value2"/> (XML 属性格式)
        // 匹配所有自闭合的 XML 标签，例如: <open_webpage url="..."/>
        //
        // ⚠ 2026-11-10 审计抓到：这个正则**不校验函数名是否存在于工具表** ——
        //   模型正文里出现 `<a href="…"/>` 或退化 XML 里的 `<parameter name="x" string="true"/>`
        //   都会生成 `name:"a"` / `name:"parameter"` 的假工具调用，然后产生一条工具错误结果、
        //   污染后续上下文。现在用「像工具名的标签」+ 属性名白名单两道过滤：
        //   · 标签名必须是 snake_case 或短驼峰（不含 parameter/invoke/a/img 这类 HTML 词）
        //   · 至少有一个属性名不像 HTML 属性（href/src/class/id/style/type/name/value 除外时仍保留）
        const HTML_TAGS = /^(a|img|br|hr|div|span|p|b|i|u|em|strong|input|meta|link|script|style|param|parameter|invoke|call|value|type|name|string)$/i;
        const toolCallRegex2 = /<([a-z][a-z0-9_]{2,40})\s+([^>]+?)\/>/gi;

        while ((match = toolCallRegex2.exec(content)) !== null) {
            const functionName = match[1];
            if (HTML_TAGS.test(functionName)) continue;   // 明显不是工具名
            const attributesStr = match[2];

            // 解析属性
            const attributes = {};
            const attrRegex = /(\w+)="([^"]*)"/g;
            let attrMatch;

            while ((attrMatch = attrRegex.exec(attributesStr)) !== null) {
                attributes[attrMatch[1]] = attrMatch[2];
            }

            // 转换为 OpenAI 标准格式
            toolCalls.push({
                id: `call_qwen_${Date.now()}_${index}`,
                type: 'function',
                function: {
                    name: functionName,
                    arguments: JSON.stringify(attributes)
                }
            });
            index++;
        }

        // 格式3: <tool_calls><invoke name="X"><parameter name="Y" string="true">V</parameter></invoke></tool_calls>
        //
        // ⚠ 2026-11-10 三十八轮拟真实测抓到：deepseek-v4.1-flash 在长上下文/复杂工具描述
        //   下会退化输出这种 **Anthropic/Hermes 风格** XML —— 而不是标准 tool_calls 对象。
        //   表现：「她在文本里说要调 som_click，但没有任何真调用」→ 用户看到的是
        //   「她自己不干活」。实测连续两轮 100% 复现（对话历史 441/442 行）。
        //   原有解析器只认 <tool_call> JSON 和自闭合 XML，漏了这一种。
        //
        // ⚠ 同轮第二次实测：标签前缀会抖 —— 出现 `<||DSML|| calls>` / `<|DSML| calls>`
        //   （DeepSeek 的 DSML 标记被模型当成标签吐出来）。所以标签名用「包含关键词」匹配：
        //   `<[^<>]*calls>` 能同时吃掉 tool_calls 和 DSML 变体。
        //   这是「同一个 bug 的第三个变体」——兜底解析必须按语义（calls/invoke/parameter）认，
        //   不能按字面标签认。
        const blockRe = /<[^<>]*calls>([\s\S]*?)<\/[^<>]*calls>/gi;
        let blk;
        while ((blk = blockRe.exec(content)) !== null) {
            const inner = blk[1];
            const invokeRe = /<[^<>]*invoke\s+name="([^"]+)"[^<>]*>([\s\S]*?)<\/[^<>]*invoke>/gi;
            let im;
            while ((im = invokeRe.exec(inner)) !== null) {
                const fnName = im[1];
                const args = {};
                const paramRe = /<[^<>]*parameter\s+name="([^"]+)"[^<>]*>([\s\S]*?)<\/[^<>]*parameter>/gi;
                let pm;
                while ((pm = paramRe.exec(im[2])) !== null) {
                    let v = pm[2].trim();
                    // string="true" 明确是字符串；否则尝试按 JSON 解析（数字/布尔/对象）
                    if (!/string="true"/i.test(pm[0])) {
                        try { v = JSON.parse(v); } catch (e) { /* 保持字符串 */ }
                    }
                    args[pm[1]] = v;
                }
                toolCalls.push({
                    id: `call_xml_${Date.now()}_${index}`,
                    type: 'function',
                    function: { name: fnName, arguments: JSON.stringify(args) },
                });
                index++;
            }
        }

        return toolCalls.length > 0 ? toolCalls : null;
    }

    /**
     * 过滤模型思考/推理内容，防止思考过程被TTS播放或显示为字幕
     * 支持 Gemini、DeepSeek 等模型的多种思考格式
     * @param {string} text - 原始文本
     * @returns {string} 过滤后的文本
     */
    _filterThinkingContent(text) {
        if (!text) return text;

        let filtered = text;

        // 过滤 <think>...</think> 块（DeepSeek、部分 Gemini 格式）
        filtered = filtered.replace(/<think>[\s\S]*?<\/think>/gi, '');

        // 过滤 <thinking>...</thinking> 块
        filtered = filtered.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');

        // 过滤 Gemini 中文思考格式：整段以"思考"开头（独占一行）的内容
        // 仅在整段内容都是思考时才清除（避免误杀正常对话中的"思考"二字）
        if (/^思考\s*\n/.test(filtered)) {
            filtered = '';
        }

        // 过滤 Gemini 英文思考格式：整段以"Thinking"开头（独占一行）
        if (/^Thinking\s*\n/i.test(filtered)) {
            filtered = '';
        }

        return filtered.trim();
    }

    /**
     * 从内容中移除工具调用部分
     * @private
     * @param {string} content - 原始内容
     * @returns {string} 移除工具调用后的内容
     */
    _removeToolCallsFromContent(content) {
        // 移除格式1: <tool_call> ... </tool_call>
        let cleaned = content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');

        // 移除格式2: <function_name attr="value"/>
        cleaned = cleaned.replace(/<\w+\s+[^>]+?\/>/g, '');

        // 移除格式3: tool_calls / DSML 变体的 invoke 块（按语义前缀匹配）
        cleaned = cleaned.replace(/<[^<>]*calls>[\s\S]*?<\/[^<>]*calls>/gi, '');

        return cleaned.trim();
    }

    /**
     * 处理流式响应
     * @private
     * @param {Response} response - Fetch响应对象
     * @param {Function} onChunk - 接收每个文本块的回调函数
     * @returns {Promise<Object>} 完整的消息对象
     */
    async _handleStreamResponse(response, onChunk) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        // 首块耗时（2026-11-16）：与「网关响应头」对照，分清是建连慢还是模型生成慢
        let _firstChunkLogged = false;
        const _sT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

        let buffer = '';
        let fullContent = '';
        let toolCalls = null;
        let streamUsage = null;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!_firstChunkLogged) {
                    _firstChunkLogged = true;
                    try {
                        const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - _sT0);
                        logToTerminal('info', `[延迟] 首个数据块 ${ms}ms（响应头已到之后，等模型生成）`);
                    } catch (e) { /* 观测失败不影响流 */ }
                }

                // 解码数据块
                buffer += decoder.decode(value, { stream: true });

                // 处理SSE格式的数据（data: {...}\n\n）
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // 保留不完整的行

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') continue;//添加心流API支持

                    if (trimmed.startsWith('data:')) {
                        try {
                            const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5); // 移除 "data: " 前缀，自适应有无空格
                            const chunk = JSON.parse(jsonStr);

                            // usage 通常只在最后一个 chunk 出现（且 choices 为空数组）
                            if (chunk.usage) streamUsage = chunk.usage;

                            // 提取内容
                            const delta = chunk.choices?.[0]?.delta;
                            if (!delta) continue;

                            // 处理文本内容
                            if (delta.content) {
                                fullContent += delta.content;
                                onChunk(delta.content); // 🔥 实时回调
                            }

                            // 处理工具调用
                            if (delta.tool_calls) {
                                if (!toolCalls) toolCalls = [];
                                // 累积工具调用信息
                                for (const toolCall of delta.tool_calls) {
                                    const index = toolCall.index || 0;
                                    if (!toolCalls[index]) {
                                        toolCalls[index] = {
                                            id: toolCall.id || '',
                                            type: 'function',
                                            function: { name: '', arguments: '' }
                                        };
                                    }
                                    if (toolCall.id) toolCalls[index].id = toolCall.id;
                                    if (toolCall.function?.name) toolCalls[index].function.name = toolCall.function.name;
                                    if (toolCall.function?.arguments) toolCalls[index].function.arguments += toolCall.function.arguments;
                                }
                            }
                        } catch (parseError) {
                            // 忽略解析错误，继续处理下一行
                            logToTerminal('warn', `⚠️ 流式数据解析失败: ${parseError.message}`);
                        }
                    }
                }
            }

//            logToTerminal('info', `✅ 流式响应接收完成`);

            // 🔥 过滤思考内容（Gemini 等模型可能在流式 content 中混入思考过程）
            if (fullContent) {
                fullContent = this._filterThinkingContent(fullContent);
            }

            // 构建完整的消息对象
            const message = {
                role: 'assistant',
                content: fullContent || null
            };

            if (toolCalls && toolCalls.length > 0) {
                message.tool_calls = toolCalls;
            }

            // 🔥 解析 Qwen 模型的文本格式工具调用
            if (message.content && !message.tool_calls) {
                const parsedToolCalls = this._parseQwenToolCalls(message.content);
                if (parsedToolCalls && parsedToolCalls.length > 0) {
                    logToTerminal('info', `🔧 AI调用了 ${parsedToolCalls.length} 个工具`);
                    message.tool_calls = parsedToolCalls;
                    message.content = this._removeToolCallsFromContent(message.content);
                }
            }

            // 记录本轮前缀缓存命中（上游没给就只记 prompt，不编造 cached）
            recordUsage(streamUsage, 'stream');

            return message;
        } catch (error) {
            logToTerminal('error', `流式响应处理错误: ${error.message}`);
            throw error;
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * 更新API配置
     * @param {Object} newConfig - 新的配置对象
     */
    updateConfig(newConfig) {
        if (newConfig.llm) {
            this.apiKey = newConfig.llm.api_key || this.apiKey;
            this.apiUrl = newConfig.llm.api_url || this.apiUrl;
            this.model = newConfig.llm.model || this.model;
            this.temperature = newConfig.llm.temperature !== undefined ? newConfig.llm.temperature : this.temperature;  // 🔥 支持temperature更新
            this.temperatureEnabled = newConfig.llm.temperature_enabled !== undefined ? newConfig.llm.temperature_enabled : this.temperatureEnabled;
            this.reasoningEnabled = newConfig.llm.reasoning_enabled !== undefined
                ? newConfig.llm.reasoning_enabled === true
                : this.reasoningEnabled;
            this.reasoningEffort = newConfig.llm.reasoning_effort !== undefined
                ? newConfig.llm.reasoning_effort
                : this.reasoningEffort;
            logToTerminal('info', 'LLM客户端配置已更新');
        }
    }

    /**
     * 获取当前配置
     * @returns {Object}
     */
    getConfig() {
        return {
            apiUrl: this.apiUrl,
            model: this.model
        };
    }
}

module.exports = { LLMClient };
