// MessageInitializer.js - 消息初始化逻辑
const fs = require('fs');
const path = require('path');

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

        // 获取交互编号
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
     * 初始化data文件夹和记忆库文件
     */
    initializeRecordsDir() {
        const recordsDir = path.join(__dirname, '..', '..', '..', '..', 'data');
        const dialogLogPath = path.join(recordsDir, '记忆库.txt');

        try {
            // 确保data文件夹存在
            if (!fs.existsSync(recordsDir)) {
                fs.mkdirSync(recordsDir, { recursive: true });
                console.log('已创建data文件夹');
            }

            // 确保记忆库文件存在
            if (!fs.existsSync(dialogLogPath)) {
                fs.writeFileSync(dialogLogPath, '', 'utf8');
                console.log('已创建记忆库文件');
            }

            // 添加日期和交互编号
            const now = new Date();
            const currentDate = `${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, '0')}月${String(now.getDate()).padStart(2, '0')}日`;

            const existingContent = fs.readFileSync(dialogLogPath, 'utf8');
            const todayPattern = `[${currentDate}]`;

            let sessionStart;
            if (existingContent.includes(todayPattern)) {
                // 今天已经有记录，只添加交互编号
                const interactionNumber = this.getNextInteractionNumber();
                sessionStart = `\n交互${interactionNumber}：\n`;
            } else {
                // 今天还没有记录，添加完整的日期分割线
                const interactionNumber = this.getNextInteractionNumber();
                sessionStart = `------------------------------------\n[${currentDate}]\n\n交互${interactionNumber}：\n`;
            }

            fs.appendFileSync(dialogLogPath, sessionStart, 'utf8');
            console.log('记忆库文件已准备好');
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
        const conversationHistoryPath = path.join(__dirname, '..', '..', '..', '..', 'data', '对话历史.jsonl');
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
     * 获取下一个交互编号
     */
    getNextInteractionNumber() {
        try {
            const dialogLogPath = path.join(__dirname, '..', '..', '..', '..', 'data', '记忆库.txt');
            if (!fs.existsSync(dialogLogPath)) {
                return 1;
            }

            const content = fs.readFileSync(dialogLogPath, 'utf8');
            const matches = content.match(/交互(\d+)：/g);
            if (!matches) {
                return 1;
            }

            const numbers = matches.map(match => parseInt(match.match(/\d+/)[0]));
            return Math.max(...numbers) + 1;
        } catch (error) {
            console.error('获取交互编号失败:', error);
            return 1;
        }
    }
}

module.exports = { MessageInitializer };
