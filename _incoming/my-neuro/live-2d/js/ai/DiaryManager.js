// DiaryManager.js - AI日记管理模块
const __silentAudit = require('../core/silent-audit.js');
const fs = require('fs');
const path = require('path');

class DiaryManager {
    constructor(voiceChatInterface) {
        this.voiceChat = voiceChatInterface;
        this.aiDiaryEnabled = voiceChatInterface.aiDiaryEnabled;
        this.aiDiaryIdleTime = voiceChatInterface.aiDiaryIdleTime;
        this.aiDiaryFile = voiceChatInterface.aiDiaryFile;
        this.aiDiaryPrompt = voiceChatInterface.aiDiaryPrompt;
        this.lastInteractionTime = Date.now();
        this.diaryTimer = null;
    }

    // 启动AI日记定时器
    startTimer() {
        if (this.diaryTimer) {
            clearTimeout(this.diaryTimer);
        }

        this.diaryTimer = setTimeout(() => {
            this.checkAndWriteDiary();
        }, this.aiDiaryIdleTime);

        console.log(`AI日记定时器已启动，${this.aiDiaryIdleTime / 60000}分钟后检查`);
    }

    /**
     * 供插件配置（2026-11-13）。原来 diary 插件是直接改 aiDiaryEnabled / aiDiaryIdleTime /
     * aiDiaryFile / aiDiaryPrompt 四个字段再自己调 startTimer() —— 越界改私有状态，
     * 宿主哪天改字段名就静默失效，而且插件与宿主的启动顺序会决定谁生效。
     * 这里给一个显式入口，字段语义集中在一处。
     */
    configure(options = {}) {
        if (options.enabled !== undefined) this.aiDiaryEnabled = !!options.enabled;
        if (options.idleTime !== undefined) {
            const ms = Number(options.idleTime);
            if (Number.isFinite(ms) && ms > 0) this.aiDiaryIdleTime = ms;
        }
        if (options.file !== undefined) this.aiDiaryFile = String(options.file);
        if (options.prompt !== undefined) this.aiDiaryPrompt = String(options.prompt);
        // startTimer 自身幂等（先 clear 旧的），开着就按新配置重排
        if (this.aiDiaryEnabled) this.startTimer();
        return { enabled: this.aiDiaryEnabled, idleTime: this.aiDiaryIdleTime, file: this.aiDiaryFile };
    }

    // 重置日记定时器（用户交互时调用）
    resetTimer() {
        this.lastInteractionTime = Date.now();
        if (this.aiDiaryEnabled) {
            this.startTimer();
        }
    }

    // 检查并写入AI日记
    async checkAndWriteDiary() {
        try {
            console.log('开始检查AI日记条件...');

            // 检查条件0: 静默闸门（成本闸门：静默测试期日记生成=一次 API 调用，只攒素材不烧钱）。
            // 素材（记忆整理/心情）一直在落盘，切活泼版后下一次空闲检查会补写。
            try {
                if (global.__petQuiet) {
                    console.log('静默模式：日记暂不生成（零 API），素材照常落盘，切活泼版后补写');
                    return;
                }
            } catch (e) { try { __silentAudit.audit('DiaryManager.js:49', e); } catch (e2) {} }

            // 检查条件1: 达到阈值时间
            const timeSinceLastInteraction = Date.now() - this.lastInteractionTime;
            if (timeSinceLastInteraction < this.aiDiaryIdleTime) {
                console.log('时间未达到阈值，跳过日记写入');
                return;
            }

            // 检查条件2: 记忆库里面有"交互"关键词
            const memoryPath = path.join(__dirname, '..', '..', '..', 'data', '记忆库.txt');
            if (!fs.existsSync(memoryPath)) {
                console.log('记忆库文件不存在，跳过日记写入');
                return;
            }

            const memoryContent = fs.readFileSync(memoryPath, 'utf8');
            if (!memoryContent.includes('交互')) {
                console.log('记忆库中没有交互记录，跳过日记写入');
                return;
            }

            // 检查条件3: 当天还未记录日记
            const diaryPath = path.join(__dirname, '..', '..', '..', this.aiDiaryFile);
            const today = new Date();
            const todayStr = `${today.getFullYear()}年${String(today.getMonth() + 1).padStart(2, '0')}月${String(today.getDate()).padStart(2, '0')}日`;

            if (fs.existsSync(diaryPath)) {
                const diaryContent = fs.readFileSync(diaryPath, 'utf8');
                if (diaryContent.includes(todayStr)) {
                    console.log('今天已经写过日记，跳过日记写入');
                    return;
                }
            }

            console.log('所有条件满足，开始生成AI日记...');
            await this.generateDiary(memoryContent, todayStr);

        } catch (error) {
            console.error('检查AI日记失败:', error);
        }
    }

    // 生成AI日记
    async generateDiary(memoryContent, dateStr) {
        try {
            // 提取今天的交互记录
            const todayInteractions = this.extractTodayInteractions(memoryContent, dateStr);
            if (!todayInteractions) {
                console.log('没有找到今天的交互记录');
                return;
            }

            console.log('正在生成AI日记...');

            // 素材升级（P0 路线图）：除了对话记录，把「心气」与「今日记忆整理」一并喂给日记——
            // 心气让日记有情绪底色（心气差的日记连开心事都写得涩），整理日志让日记有真事件。
            let moodLine = '';
            try {
                const md = global.__petMood && global.__petMood.describe ? global.__petMood.describe() : null;
                if (md) moodLine = `（此刻心气 ${md.score >= 0 ? '+' : ''}${md.score}，${md.line}${md.residue ? '，余味 ' + md.residue : ''}）`;
            } catch (e) { try { __silentAudit.audit('DiaryManager.js:110', e); } catch (e2) {} }
            let digestLine = '';
            try {
                const digestPath = path.join(__dirname, '..', '..', '..', 'data', '记忆整理', dateStr.replace(/年|月/g, '-').replace(/日/g, '') + '.md');
                if (fs.existsSync(digestPath)) digestLine = fs.readFileSync(digestPath, 'utf8').slice(0, 1200);
            } catch (e) { console.warn('[日记] 记忆整理 digest 读取失败（日记会变空洞）：', e.message); }

            // 构建日记生成的prompt
            const diaryPrompt = `${this.aiDiaryPrompt}

今天的心气：${moodLine || '平平的'}

今天的记忆整理（真事件，优先从这里取材）：
${digestLine || '（今天还没有整理日志）'}

今天的对话记录：
${todayInteractions}

请写一篇日记：第一人称，用你自己的口吻，至少提到一两件今天真实发生的事（从记忆整理里取），心情要跟心气一致。150 字以内。`;

            // 调用LLM生成日记
            const response = await fetch(`${this.voiceChat.API_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.voiceChat.API_KEY}`
                },
                body: JSON.stringify({
                    model: this.voiceChat.MODEL,
                    messages: [
                        {
                            role: 'user',
                            content: diaryPrompt
                        }
                    ],
                    stream: false
                })
            });

            if (!response.ok) {
                throw new Error(`API请求失败: ${response.status}`);
            }

            const data = await response.json();
            const diaryContent = data.choices[0].message.content;

            // 保存日记
            await this.saveDiary(diaryContent, dateStr);
            console.log('AI日记生成并保存成功');

        } catch (error) {
            console.error('生成AI日记失败:', error);
        }
    }

    // 提取今天的交互记录
    extractTodayInteractions(memoryContent, dateStr) {
        const lines = memoryContent.split('\n');
        let todaySection = '';
        let inTodaySection = false;

        for (const line of lines) {
            if (line.includes(`[${dateStr}]`)) {
                inTodaySection = true;
                continue;
            }

            if (inTodaySection) {
                if (line.startsWith('------------------------------------')) {
                    // 遇到新的分割线，说明今天的记录结束
                    break;
                }
                todaySection += line + '\n';
            }
        }

        return todaySection.trim() || null;
    }

    // 保存日记
    async saveDiary(diaryContent, dateStr) {
        try {
            const diaryPath = path.join(__dirname, '..', '..', '..', this.aiDiaryFile);

            // 确保data文件夹存在
            const diaryDir = path.dirname(diaryPath);
            if (!fs.existsSync(diaryDir)) {
                fs.mkdirSync(diaryDir, { recursive: true });
            }

            const diaryEntry = `------------------------------------\n[${dateStr}] 大肥鱼的日记\n\n${diaryContent}\n\n`;

            fs.appendFileSync(diaryPath, diaryEntry, 'utf8');
            console.log('AI日记已保存到文件');

        } catch (error) {
            console.error('保存AI日记失败:', error);
        }
    }
}

module.exports = { DiaryManager };
