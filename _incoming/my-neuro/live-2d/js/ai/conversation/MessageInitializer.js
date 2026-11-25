// MessageInitializer.js - 消息初始化逻辑
const fs = require('fs');
const path = require('path');
// 记录室路径唯一真源（2026-11-24）：原来这里手拼 4 层 ..，测试无法用 PET_DATA_ROOT 隔离。
const { RECORDS_DIR, recordFile } = require('../../core/records-path.js');

/**
 * 下一个交互编号：取现有「交互N：」的最大号 +1（口径不变，从 1 开始）。
 * 提成模块级函数供 InputRouter 复用 —— 启动时不再预写占位，编号在**第一条真实内容**前才算。
 * @param {string} [filePath]
 * @returns {number}
 */
function getNextInteractionNumber(filePath) {
    const dialogLogPath = filePath || recordFile('记忆库.txt');
    try {
        if (!fs.existsSync(dialogLogPath)) return 1;
        const content = fs.readFileSync(dialogLogPath, 'utf8');
        const matches = content.match(/交互(\d+)：/g);
        if (!matches) return 1;
        const numbers = matches.map((match) => parseInt(match.match(/\d+/)[0], 10)).filter((n) => Number.isFinite(n));
        if (!numbers.length) return 1;
        return Math.max(...numbers) + 1;
    } catch (error) {
        console.error('获取交互编号失败:', error);
        return 1;
    }
}

/**
 * 构造「本次会话头」（日期分割线 + 交互N：）。
 * 2026-11-24：启动时不再写空占位（实测 975 个「交互N：」里 864 个下面一个字都没有）；
 * 改成第一条真实内容落盘前调用本函数，返回要 append 的文本。
 *   · 今天已有日期头 → 只写 `\n交互N：\n`（与旧格式一致）
 *   · 今天还没有 → 写分割线 + 日期头 + 空行 + `交互N：\n`
 * @param {string} [filePath]
 * @param {Date} [now]
 * @returns {{text:string, dateLabel:string, interactionNumber:number, newDay:boolean}}
 */
function buildSessionHeader(filePath, now = new Date()) {
    const dialogLogPath = filePath || recordFile('记忆库.txt');
    const pad = (n) => String(n).padStart(2, '0');
    const dateLabel = `[${now.getFullYear()}年${pad(now.getMonth() + 1)}月${pad(now.getDate())}日]`;
    const interactionNumber = getNextInteractionNumber(dialogLogPath);
    let hasToday = false;
    try {
        hasToday = fs.readFileSync(dialogLogPath, 'utf8').includes(dateLabel);
    } catch (error) { /* 文件不存在 = 今天还没有记录 */ }
    return {
        text: hasToday
            ? `\n交互${interactionNumber}：\n`
            : `------------------------------------\n${dateLabel}\n\n交互${interactionNumber}：\n`,
        dateLabel,
        interactionNumber,
        newDay: !hasToday,
    };
}

/**
 * 把会话头落盘（惰性写：由 InputRouter 在第一条真实内容前调用）。
 * @returns {{ok:boolean, interactionNumber:number, newDay:boolean, error?:string}}
 */
function ensureSessionHeader(filePath, now = new Date()) {
    const dialogLogPath = filePath || recordFile('记忆库.txt');
    try {
        fs.mkdirSync(path.dirname(dialogLogPath), { recursive: true });
        const header = buildSessionHeader(dialogLogPath, now);
        fs.appendFileSync(dialogLogPath, header.text, 'utf8');
        return { ok: true, interactionNumber: header.interactionNumber, newDay: header.newDay };
    } catch (error) {
        console.error('写记忆库会话头失败:', error);
        return { ok: false, interactionNumber: 0, newDay: false, error: String((error && error.message) || error) };
    }
}

/**
 * 负责文件读取、历史加载、交互编号等初始化逻辑
 */
class MessageInitializer {
    constructor(config) {
        this.config = config;
    }

    /**
     * 执行完整初始化
     */
    async initialize() {
        // 确保data文件夹存在
        this.initializeRecordsDir();

        // 获取交互编号（只算不写：真正写头在第一条真实内容落盘前，见 InputRouter.saveToMemoryLog）
        const sessionInteractionNumber = this.getNextInteractionNumber();

        // 构建系统提示词
        const systemPrompt = this.buildSystemPrompt();

        // 加载对话历史
        const { fullHistory, historyForAI } = this.loadConversationHistory();

        return {
            systemPrompt,
            conversationHistory: historyForAI,
            fullConversationHistory: fullHistory,
            sessionInteractionNumber
        };
    }

    /**
     * 初始化data文件夹和记忆库文件（**不再写「交互N：」空占位**）
     */
    initializeRecordsDir() {
        const dialogLogPath = recordFile('记忆库.txt');

        try {
            // 确保data文件夹存在
            if (!fs.existsSync(RECORDS_DIR)) {
                fs.mkdirSync(RECORDS_DIR, { recursive: true });
                console.log('已创建data文件夹');
            }

            // 确保记忆库文件存在
            if (!fs.existsSync(dialogLogPath)) {
                fs.writeFileSync(dialogLogPath, '', 'utf8');
                console.log('已创建记忆库文件');
            }

            // 2026-11-24：这里原来每次启动都 append「交互N：\n」（一天开几次就几个空壳，
            // 实测 864/975 是空占位）。现在只保证文件存在；日期/交互头由
            // InputRouter.saveToMemoryLog 在第一条真实内容落盘前用 ensureSessionHeader() 写。
        } catch (error) {
            console.error('准备记忆库文件失败:', error);
        }
    }

    /**
     * 构建系统提示词
     */
    buildSystemPrompt() {
        // §72 搭车：让主模型在回复末尾附一行 #mood:（同一次 completion，多 ~20 token）。
        // 为什么加在代码里而不是改 config：config.llm.system_prompt 是用户可编辑的资产，
        // 这条格式约定属于程序契约（解析器认它），不该被用户的编辑覆盖掉。
        return this.config.llm.system_prompt;
    }

    /**
     * 加载持久化对话历史（JSONL格式）
     */
    loadConversationHistory() {
        const conversationHistoryPath = recordFile('对话历史.jsonl');
        let conversationHistory = [];

        // 总是尝试读取历史文件（用于保存时的完整性）
        try {
            if (fs.existsSync(conversationHistoryPath)) {
                const fileContent = fs.readFileSync(conversationHistoryPath, 'utf8');
                const lines = fileContent.trim().split('\n');

                // 逐行解析 JSONL 格式
                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            conversationHistory.push(JSON.parse(line));
                        } catch (e) {
                            console.error('解析对话历史行失败:', line.substring(0, 50) + '...');
                        }
                    }
                }

                console.log(`读取到完整对话历史，共 ${conversationHistory.length} 条消息`);
            } else {
                console.log('对话历史文件不存在，将创建新的对话历史');
            }
        } catch (error) {
            console.error('加载对话历史失败:', error);
            conversationHistory = [];
        }

        // 根据配置决定AI是否能看到历史
        const historyForAI = this.config.context.persistent_history ? conversationHistory : [];

        if (this.config.context.persistent_history) {
            console.log(`AI将记住之前的 ${historyForAI.length} 条对话`);
        } else {
            console.log('AI不会记住之前的对话（但历史仍会保存）');
        }

        return {
            fullHistory: conversationHistory,
            historyForAI: historyForAI
        };
    }

    /**
     * 获取下一个交互编号（类方法保留旧 API；实现与模块级函数同源）
     */
    getNextInteractionNumber() {
        return getNextInteractionNumber();
    }
}

module.exports = {
    MessageInitializer,
    // 供 InputRouter / 单测复用（惰性写头）
    getNextInteractionNumber,
    buildSessionHeader,
    ensureSessionHeader,
};
