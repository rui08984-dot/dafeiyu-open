// plugins/built-in/ai-log/index.js
// AI 日志插件 —— 提供每日日志生成、历史查看、月度总结工具

const { Plugin } = require('../../../js/core/plugin-base.js');
const fs = require('fs');
const path = require('path');

class AiLogPlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();
        // 往上 4 层 = my-neuro/（不是 live-2d/）。见 js/core/records-path.js 的说明：
        // 记录室唯一真源是 my-neuro/data，和 config.json 的 ../data 保持一致。
        this._rootDir = path.join(__dirname, '..', '..', '..', '..');

        this._apiUrl = cfg.api_url || '';
        this._apiKey = cfg.api_key || '';
        this._model = cfg.model || '';
        this._thinkingMode = cfg.thinking_mode || 'enabled';
        this._reasoningEffort = cfg.reasoning_effort || 'max';
        this._diaryFolder = cfg.diary_folder || 'data/AI日志';
        this._diaryFilenameTemplate = cfg.diary_filename_template || '{date}-AI日志.txt';
        this._monthlyFilenameTemplate = cfg.monthly_filename_template || '{month}-月度总结.txt';
        const resolvePath = (filePath, defaultPath) => {
            const value = (filePath && String(filePath).trim()) || defaultPath;
            return path.isAbsolute(value) ? path.normalize(value) : path.join(this._rootDir, value);
        };

        this._coreMemoryPath = resolvePath(cfg.core_memory_file, 'data/核心用户记忆.txt');
        this._conversationHistoryPath = resolvePath(cfg.conversation_history_file, 'data/记忆库.txt');
        this._historyBackupFolder = cfg.history_backup_folder || '';
        this._dailyPrompt = cfg.daily_prompt || '';
        this._monthlyPrompt = cfg.monthly_prompt || '';
        this._triggerAfterHour = cfg.trigger_after_hour ?? 21;
        this._maxRetries = cfg.max_retries ?? 3;
        this._nightHourStart = cfg.night_hour_start ?? 7;
    }

    async onStart() {
        this.context.log('info', `AI 日志插件已启动 | 日志目录: ${this._diaryFolder}`);
    }

    // ===== 工具注册 =====

    // 工具面重塑（2026-11-14）：3 个工具 → 1 个。
    getTools() {
        return [{
            type: 'function',
            function: {
                name: 'diary',
                description: `AI日志：write 生成今天的AI日志并保存、同步核心记忆（需 trigger_reason；仅当用户明确要求写日志，或说了晚安/睡觉且在晚上${this._triggerAfterHour ?? 21}点至凌晨${this._nightHourStart ?? 7}点窗口内才可调用，严禁自行猜测调用；force=true 跳过时间窗口）；read 查看最近 days 天日志（默认3）；monthly 生成上个月的月度总结。`,
                parameters: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['write', 'read', 'monthly'], description: '要做什么' },
                        force: {
                            type: 'boolean',
                            description: '是否强制执行（跳过时间窗口限制）。用户明确要求写日志时传 true，晚安自动触发时传 false'
                        },
                        trigger_reason: {
                            type: 'string',
                            enum: ['user_requested', 'user_said_goodnight'],
                            description: '触发原因（action=write 时必填）。user_requested=用户在当前消息中明确要求写日志；user_said_goodnight=用户在当前消息中明确说了晚安/睡觉等词语。禁止在不满足条件时捏造理由。'
                        },
                        days: {
                            type: 'number',
                            description: '要查看最近几天的日志，默认为3天（action=read）'
                        },
                    },
                    required: ['action'],
                },
            },
        }];
    }

    async executeTool(name, params) {
        const p = params || {};
        this.context.log('info', `执行工具: ${name}`);

        if (name === 'diary') {
            const a = String(p.action || '').toLowerCase();
            switch (a) {
                case 'write':   return await this._writeDiary(p.force || false, p.trigger_reason);
                case 'read':    return this._readRecentDiary(p.days || 3);
                case 'monthly': return await this._writeMonthlySummary();
                default: throw new Error('diary：action 只能是 write / read / monthly（收到「' + a + '」）');
            }
        }

        // 旧工具名保留（技能库/脚本可能直接调；新模型只看得到合并后的名字）
        switch (name) {
            case 'write_ai_diary':
                return await this._writeDiary(p.force || false, p.trigger_reason);
            case 'read_recent_diary':
                return this._readRecentDiary(p.days || 3);
            case 'write_monthly_summary':
                return await this._writeMonthlySummary();
            default:
                throw new Error(`不支持的工具: ${name}`);
        }
    }

    // ===== 日期工具 =====

    _getProperDate() {
        const now = new Date();
        if (now.getHours() < this._nightHourStart) {
            now.setDate(now.getDate() - 1);
        }
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    _getLastMonth() {
        const now = new Date();
        now.setMonth(now.getMonth() - 1);
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        return `${y}-${m}`;
    }

    _getTimestamp() {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }

    // ===== API 调用 =====

    /**
     * callLLM 只接受一条 user 消息，所以把插件里的系统提示词拼到同一条 prompt 前面。
     * 留空的一侧自动省略，不产生空段落。
     */
    _composePrompt(systemPrompt, userContent) {
        const sys = String(systemPrompt || '').trim();
        const user = String(userContent == null ? '' : userContent);
        return sys ? `${sys}\n\n${user}` : user;
    }

    /**
     * 调一次云端 LLM。
     *
     * 2026-11-24 审计（HANDOFF §8.3）：这里原本自己 `fetch(global.voiceChat.API_URL)` ——
     * 单次 8000 max_tokens 的日记调用既**不进 llm.usage 账本**，也**不吃 provider 路由/配额熔断**，
     * 是账本外最贵的一次云端调用。现在统一走 `context.callLLM`：
     *   · 落 llm.usage（source=plugin，doctor 的今日/7 天与 80% 告警才算得全）；
     *   · 走通讯录 provider 解析（插件显式配了 api_url/api_key/model 才覆盖连接，语义与旧版一致）；
     *   · 非 2xx 时由 plugin-context 统一挂 status/body/重置时刻，并由 llm-health 记熔断。
     * 另外补一道 background-llm 闸：配额暂停 / 用户关掉后台 LLM 时直接跳过，
     * 不再"先打 3 次 429 再放弃"（ADR-014：日记属后台花钱）。
     */
    async _callAPI(systemPrompt, userContent) {
        // 唯一入口（2026-11-25 契约）：内部 = cost.background_llm + 云端熔断。
        // 插件不再自己读配置、不再自己判 reason 字符串。
        const gate = require('../../../js/core/background-llm.js').ensureCanRun(this.context, { kind: 'ai-log' });
        if (!gate.ok) {
            this.context.log('info', `AI 日志跳过：后台 LLM 暂停（${gate.reason}）`);
            const err = new Error(`后台 LLM 已暂停（${gate.reason}），本次未调用云端`);
            err.code = 'BG_LLM_PAUSED';
            throw err;
        }

        const prompt = this._composePrompt(systemPrompt, userContent);
        // 与旧请求体逐项对齐：max_tokens 8000 / temperature 0.7 / thinking / reasoning_effort
        const options = { max_tokens: 8000, temperature: 0.7 };
        if (this._apiUrl) options.api_url = this._apiUrl;
        if (this._apiKey) options.api_key = this._apiKey;
        if (this._model) options.model = this._model;

        const thinkingMode = String(this._thinkingMode || '').toLowerCase();
        if (thinkingMode === 'enabled' || thinkingMode === 'disabled') {
            options.thinking = { type: thinkingMode };
        }
        if (this._reasoningEffort) {
            options.reasoning_effort = this._reasoningEffort;
        }

        for (let attempt = 1; attempt <= this._maxRetries; attempt++) {
            try {
                this.context.log('info', `调用 API 第 ${attempt} 次... | 模型: ${this._model || '(主 LLM)'} | thinking: ${thinkingMode || 'default'} | reasoning_effort: ${this._reasoningEffort || 'default'}`);
                const content = await this.context.callLLM(prompt, options);
                if (typeof content === 'string' && content.trim()) {
                    this.context.log('info', 'API 调用成功');
                    return content;
                }
                throw new Error('API 响应为空');
            } catch (error) {
                if (error && error.code === 'BG_LLM_PAUSED') throw error;
                this.context.log('error', `第 ${attempt} 次尝试失败: ${error.message}`);
                // 429 = 配额/限流：重试只会把受限请求再打一遍，交给 llm-health 的暂停窗口
                if (error && Number(error.status) === 429) throw error;
                if (attempt === this._maxRetries) throw error;
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    // ===== 文件 IO =====

    _readConversationHistory() {
        if (!fs.existsSync(this._conversationHistoryPath)) return null;
        const content = fs.readFileSync(this._conversationHistoryPath, 'utf-8');
        return content.trim() || null;
    }

    _getDiaryFilename(date) {
        return this._diaryFilenameTemplate.replace('{date}', date);
    }

    _getMonthlyFilename(yearMonth) {
        return this._monthlyFilenameTemplate.replace('{month}', yearMonth);
    }

    _getDiarySuffix() {
        return this._diaryFilenameTemplate.replace('{date}', '');
    }

    _readMonthlyDiaries(yearMonth) {
        if (!fs.existsSync(this._diaryFolder)) return null;

        const suffix = this._getDiarySuffix();
        const files = fs.readdirSync(this._diaryFolder)
            .filter(f => f.startsWith(yearMonth) && f.endsWith(suffix))
            .sort();

        if (files.length === 0) return null;

        this.context.log('info', `找到 ${yearMonth} 的 ${files.length} 篇 AI 日志`);

        return files.map(f => {
            const content = fs.readFileSync(path.join(this._diaryFolder, f), 'utf-8');
            const date = f.replace(suffix, '');
            return `=== ${date} 的日志 ===\n${content}`;
        }).join('\n\n');
    }

    _saveDiaryFile(filename, content) {
        if (!fs.existsSync(this._diaryFolder)) {
            fs.mkdirSync(this._diaryFolder, { recursive: true });
        }
        const filePath = path.join(this._diaryFolder, filename);
        fs.writeFileSync(filePath, content, 'utf-8');
        this.context.log('info', `文件已保存: ${filePath}`);
        return filePath;
    }

    _updateCoreMemory(entryKey, content) {
        try {
            const timestamp = this._getTimestamp();
            const newEntry = `[${timestamp}] ${entryKey}：${content}\n`;

            let existing = '';
            if (fs.existsSync(this._coreMemoryPath)) {
                existing = fs.readFileSync(this._coreMemoryPath, 'utf-8');
            }

            const escapedKey = entryKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(
                `\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\] ${escapedKey}[\\s\\S]*?(?=\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\]|$)`
            );

            const final = pattern.test(existing)
                ? existing.replace(pattern, newEntry)
                : existing + newEntry;

            fs.writeFileSync(this._coreMemoryPath, final, 'utf-8');
            this.context.log('info', `核心记忆已更新: ${entryKey}`);
        } catch (error) {
            this.context.log('error', `更新核心记忆失败: ${error.message}`);
        }
    }

    /**
     * 裁剪核心记忆中的日志：每日日志只保留最近一天，月度总结只保留最近一个月
     * 今天保留昨天，昨天没有则保留前天，以此类推
     */
    _pruneCoreMemoryLogs() {
        try {
            if (!fs.existsSync(this._coreMemoryPath)) return;

            const raw = fs.readFileSync(this._coreMemoryPath, 'utf-8');
            const chunks = raw.split(/(?=\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\])/).filter(Boolean);

            const dailyEntries = [];  // { key, date, fullText }
            const monthlyEntries = []; // { key, yearMonth, fullText }
            const otherEntries = [];   // 非本插件添加的条目

            for (const chunk of chunks) {
                const m = chunk.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] ([^：]+)：([\s\S]*)$/);
                if (!m) { otherEntries.push(chunk); continue; }

                const [, timestamp, key] = m;
                const fullText = chunk.replace(/\n+$/, '');

                const dailyDate = key.match(/^(\d{4}-\d{2}-\d{2})/);
                const monthlyYm = key.match(/^(\d{4}-\d{2})-[^\d]/);

                if (dailyDate) {
                    dailyEntries.push({ key, date: dailyDate[1], fullText });
                } else if (monthlyYm) {
                    monthlyEntries.push({ key, yearMonth: monthlyYm[1], fullText });
                } else {
                    otherEntries.push(chunk);
                }
            }

            dailyEntries.sort((a, b) => b.date.localeCompare(a.date));
            monthlyEntries.sort((a, b) => b.yearMonth.localeCompare(a.yearMonth));

            const keepDaily = dailyEntries[0] ? [dailyEntries[0].fullText] : [];
            const keepMonthly = monthlyEntries[0] ? [monthlyEntries[0].fullText] : [];

            const pruned = [...otherEntries, ...keepDaily, ...keepMonthly].join('\n\n');
            if (pruned !== raw) {
                fs.writeFileSync(this._coreMemoryPath, pruned, 'utf-8');
                const removed = dailyEntries.length + monthlyEntries.length - keepDaily.length - keepMonthly.length;
                if (removed > 0) {
                    this.context.log('info', `核心记忆已裁剪：保留最近1天日志、最近1月总结，移除 ${removed} 条旧记录`);
                }
            }
        } catch (error) {
            this.context.log('error', `核心记忆裁剪失败: ${error.message}`);
        }
    }

    _backupAndClearHistory(date) {
        if (!this._historyBackupFolder) return;

        try {
            if (!fs.existsSync(this._conversationHistoryPath)) {
                this.context.log('warn', '记忆库文件不存在，跳过备份');
                return;
            }

            const content = fs.readFileSync(this._conversationHistoryPath, 'utf-8');
            if (!content.trim()) {
                this.context.log('info', '记忆库为空，跳过备份');
                return;
            }

            if (!fs.existsSync(this._historyBackupFolder)) {
                fs.mkdirSync(this._historyBackupFolder, { recursive: true });
            }

            const now = new Date();
            const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
            const backupFilename = `记忆库-${date}-${timeStr}.txt`;
            const backupPath = path.join(this._historyBackupFolder, backupFilename);
            fs.writeFileSync(backupPath, content, 'utf-8');
            this.context.log('info', `记忆库已备份: ${backupPath}`);

            fs.writeFileSync(this._conversationHistoryPath, '', 'utf-8');
            this.context.log('info', '记忆库已清空，准备记录新一天的内容');
        } catch (error) {
            this.context.log('error', `记忆库备份失败: ${error.message}`);
        }
    }

    // ===== 核心功能 =====

    _isInTriggerWindow() {
        const hour = new Date().getHours();
        return hour >= this._triggerAfterHour || hour < this._nightHourStart;
    }

    async _writeDiary(force = false, triggerReason) {
        const validReasons = ['user_requested', 'user_said_goodnight'];
        if (!triggerReason || !validReasons.includes(triggerReason)) {
            this.context.log('warn', `无效的触发原因: ${triggerReason}，拒绝执行`);
            return '触发原因无效或缺失，拒绝写日志。只有用户明确要求写日志或用户说了晚安/睡觉时才能调用此工具。';
        }

        if (triggerReason === 'user_said_goodnight' && !this._isInTriggerWindow()) {
            this.context.log('warn', `晚安触发但不在时间窗口内（需 ${this._triggerAfterHour}:00-${this._nightHourStart}:00），拒绝执行`);
            return `现在还不到写日志的时间哦，晚上${this._triggerAfterHour}点以后再来吧！如果你确实想现在写，可以明确告诉我"写AI日志"。`;
        }

        if (triggerReason === 'user_requested' && !force && !this._isInTriggerWindow()) {
            return `现在还不到写日志的时间哦，晚上${this._triggerAfterHour}点以后再来吧！如果你确实想现在写，可以明确告诉我"强制写AI日志"。`;
        }

        this.context.log('info', `开始生成 AI 日志（触发原因: ${triggerReason}）...`);

        const date = this._getProperDate();
        const filename = this._getDiaryFilename(date);
        const diaryPath = path.join(this._diaryFolder, filename);

        let previousDiary = null;
        if (fs.existsSync(diaryPath)) {
            const existing = fs.readFileSync(diaryPath, 'utf-8').trim();
            if (existing) {
                previousDiary = existing;
                this.context.log('info', '检测到今天已有日志，将进入"合并模式"生成新版本');
            }
        }

        const history = this._readConversationHistory();
        if (!history && !previousDiary) return '今天没有对话历史，无法生成AI日志';

        let diaryContent;
        try {
            if (previousDiary) {
                diaryContent = await this._mergeDiary(previousDiary, history);
            } else {
                const userContent = `【今天的对话历史】\n${history}\n\n请根据以上对话历史生成今天的AI日志。`;
                diaryContent = await this._callAPI(this._dailyPrompt, userContent);
            }
        } catch (error) {
            const retried = error && error.code === 'BG_LLM_PAUSED' ? '' : `（已重试${this._maxRetries}次）`;
            return `生成AI日志失败：${error.message}${retried}`;
        }

        const savedPath = this._saveDiaryFile(filename, diaryContent);
        const entryKey = filename.replace('.txt', '');
        this._updateCoreMemory(entryKey, diaryContent);
        this._pruneCoreMemoryLogs();

        this._backupAndClearHistory(date);

        this.context.log('info', 'AI 日志生成完成');
        return `AI日志已生成并保存：${savedPath}\n\n${diaryContent}`;
    }

    /**
     * 合并模式：今天已有日志、又要再写一次时调用。
     * 直接把"旧日志 + 原始对话"丢给主 prompt，LLM 会把对话当作主体重写，旧日志被覆盖。
     * 因此采用双调用：
     *   步骤 1 —— 用一个客观、中性的 prompt，把新对话提炼成"事件清单"（去掉噪音、保留事实）。
     *   步骤 2 —— 把"旧日志 + 事件清单"喂给附加了"合并模式"指令的主 prompt，强制旧日志事件 100% 保留、新事件以新增板块呈现。
     */
    async _mergeDiary(previousDiary, history) {
        if (!history) {
            this.context.log('info', '记忆库为空（自上次写日志后没有新对话），旧日志原样保留');
            return previousDiary;
        }

        this.context.log('info', '【合并模式 1/2】提炼新对话的事件清单...');
        const extractSystemPrompt = `你是一个客观、中性的对话事件提取器。

请阅读用户提供的对话历史，提取出其中发生的关键事件、用户的具体行为、值得记录的对话内容。

输出要求：
- 用列表格式，每件事一行，以 "- " 开头
- 客观陈述事实，不要任何情绪化语言、不要任何角色扮演加工、不要任何情绪标签
- 保留具体细节（游戏名、错误信息、用户的具体问题、对话里出现的关键词等）
- 如果对话内容很碎、确实没什么值得记录的新事件，只输出一行：（这段对话没有值得记录的新事件）`;

        const newEvents = await this._callAPI(
            extractSystemPrompt,
            `请从以下对话历史中提取事件：\n\n${history}`
        );

        const trimmedEvents = (newEvents || '').trim();
        if (!trimmedEvents || /没有值得记录的新事件/.test(trimmedEvents)) {
            this.context.log('info', '新对话中没有值得记录的事件，旧日志原样保留');
            return previousDiary;
        }

        this.context.log('info', '【合并模式 2/2】将新事件合并到旧日志，生成完整版本...');
        const mergeSystemPrompt = `${this._dailyPrompt}\n\n<merge_mode_override>\nUpdate the same-day AI diary. Preserve factual details from the old diary, merge new events naturally, avoid duplication, and output one coherent final version.\n</merge_mode_override>`;

        const mergeUserContent = `【今天已经写过的旧日志（必须完整保留其中所有事件、板块、细节）】
${previousDiary}

【在那之后新发生的事件清单（请作为新增板块/追加段落融入）】
${trimmedEvents}

请输出今天的最终合并版本AI日志。再次强调：旧日志中的所有事件都不能丢，新事件必须以新增板块或追加段落的形式自然呈现。`;

        return await this._callAPI(mergeSystemPrompt, mergeUserContent);
    }

    _readRecentDiary(days) {
        if (!fs.existsSync(this._diaryFolder)) return 'AI日志文件夹不存在';

        const suffix = this._getDiarySuffix();
        const files = fs.readdirSync(this._diaryFolder)
            .filter(f => f.endsWith(suffix))
            .sort()
            .reverse()
            .slice(0, days);

        if (files.length === 0) return '没有找到任何AI日志';

        let result = `最近 ${files.length} 天的AI日志：\n\n`;
        for (const f of files) {
            const content = fs.readFileSync(path.join(this._diaryFolder, f), 'utf-8');
            const date = f.replace(suffix, '');
            result += `=== ${date} ===\n${content}\n\n`;
        }
        return result;
    }

    async _writeMonthlySummary() {
        this.context.log('info', '开始生成月度总结...');

        const lastMonth = this._getLastMonth();
        const diaries = this._readMonthlyDiaries(lastMonth);
        if (!diaries) return `${lastMonth} 没有AI日志，无法生成月度总结`;

        let summaryContent;
        try {
            summaryContent = await this._callAPI(
                this._monthlyPrompt,
                `以下是这个月的所有AI日志，请根据这些内容生成月度总结：\n\n${diaries}`
            );
        } catch (error) {
            const retried = error && error.code === 'BG_LLM_PAUSED' ? '' : `（已重试${this._maxRetries}次）`;
            return `生成月度总结失败：${error.message}${retried}`;
        }

        const filename = this._getMonthlyFilename(lastMonth);
        const savedPath = this._saveDiaryFile(filename, summaryContent);
        const entryKey = filename.replace('.txt', '');
        this._updateCoreMemory(entryKey, summaryContent);
        this._pruneCoreMemoryLogs();

        this.context.log('info', '月度总结生成完成');
        return `${lastMonth} 月度总结已生成并保存：${savedPath}\n\n${summaryContent}`;
    }
}

module.exports = AiLogPlugin;
