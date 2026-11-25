// DiaryManager.js - AI日记管理模块
const __silentAudit = require('../core/silent-audit.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 云端客户端缓存 TTL（2026-11-24 第四轮 P2 根因修）：
// 以前 _cloudClient 一旦建好就永久复用，运行中换 key / 换 provider 后日记仍打旧连接
// → 401 直到重启。现在缓存带「配置指纹 + TTL」：指纹变了立刻重建，没变最多 60s 复核一次。
const CLOUD_CLIENT_TTL_MS = 60000;

class DiaryManager {
    constructor(voiceChatInterface) {
        this.voiceChat = voiceChatInterface;
        this.aiDiaryEnabled = voiceChatInterface.aiDiaryEnabled;
        this.aiDiaryIdleTime = voiceChatInterface.aiDiaryIdleTime;
        this.aiDiaryFile = voiceChatInterface.aiDiaryFile;
        this.aiDiaryPrompt = voiceChatInterface.aiDiaryPrompt;
        this.lastInteractionTime = Date.now();
        this.diaryTimer = null;
        // 云端主模型客户端（懒建；见 _getCloudClient）。测试可直接替换。
        this._cloudClient = null;
        // 缓存身份：fingerprint = provider/api_url/model/key 哈希；at = 建成时间（配 TTL）
        this._cloudClientFp = '';
        this._cloudClientAt = 0;
        // 依赖注入缝：测试替换成 fake，宿主运行时不设 = 走 require
        this._bgLLM = null;      // background-llm.js（云闸 canRun / 本地闸 canRunLocal）
        this._localLLM = null;   // local-llm.js（本地 llama.cpp）
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

            // 检查条件0: 后台 LLM 闸（2026-11-24 修订）
            // 日记是「人格化 prose」：一天一次、几百 token，本地 4B 只会复述输入（实测没人格口吻），
            // 所以**默认走云端主模型**，本地只作可选（config.diary.local_enabled=true）。
            // 闸跟着通道走：云端 → background-llm.canRun（含 cost.background_llm + 配额熔断）；
            // 本地 → canRunLocal（含 cost.local_memory + 本地 /health）。
            // 两条通道**互不回退**：云不在不偷偷打本地，本地不在不回云；素材一直落盘，晚点补写。
            const useLocal = this._isLocalDiaryEnabled();
            try {
                const gate = await this._diaryGate();
                if (!gate || gate.ok !== true) {
                    console.log((useLocal ? '本地记忆模型' : '云端主模型') + '不可用（' + ((gate && gate.reason) || 'blocked')
                        + '）：日记暂不生成，素材照常落盘，恢复后补写');
                    return;
                }
            } catch (e) {
                // 闸模块不存在/加载失败/配置读不出：按「本通道不可用」跳过。
                // 不 fail-open 到另一条通道（那正是「云不在却偷偷烧本地 / 本地不在却意外烧云」的来源）。
                try { __silentAudit.audit('DiaryManager.js:bg-gate', e); } catch (e2) { /* ignore */ }
                console.log((useLocal ? '本地记忆模型' : '云端主模型') + '闸不可用（' + ((e && e.message) || e) + '）：日记跳过');
                return;
            }

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

            // 通道选择（与条件0的闸同源）：默认云端主模型，local_enabled=true 才走本地。
            // 两条通道都在各自失败时**直接放弃今天这篇**（抛错 → 外层 catch），
            // 绝不跨通道回退 —— 素材照常落盘，次日补写。
            const useLocal = this._isLocalDiaryEnabled();
            let diaryContent;
            if (useLocal) {
                // 本地记忆模型（llama.cpp，11435）：可选项，见 config.diary.local_enabled
                const localLLM = this._localLLM || require('../core/local-llm.js');
                diaryContent = await localLLM.chat(diaryPrompt, {
                    // 采样档由 local-llm 统一管（diary = 0.8/0.9/40/0.05）；
                    // 调用方只声明用途，不再在这里散落温度值。
                    profile: 'diary',
                    max_tokens: 600,
                    timeoutMs: 180000,   // 4B 本地写 150 字：首 token + 生成留足余量
                });
                if (!diaryContent || !String(diaryContent).trim()) {
                    console.log('本地模型返回空日记，跳过保存');
                    return;
                }
            } else {
                // 云端主模型（与对话同一个 provider / key，走 LLMClient：usage 账本、缓存、
                // 健康状态、重试都在里面，不另写 fetch）
                diaryContent = await this._cloudDiary(diaryPrompt);
                if (!diaryContent || !String(diaryContent).trim()) {
                    console.log('云端模型返回空日记，跳过保存');
                    return;
                }
            }

            // 保存日记
            await this.saveDiary(String(diaryContent).trim(), dateStr);
            console.log('AI日记生成并保存成功');

        } catch (error) {
            console.error('生成AI日记失败:', error);
        }
    }

    // ===== 日记通道 =====

    /**
     * 日记配置：voiceChat.config.diary。
     * 只认一个键：local_enabled（默认 false = 云端主模型）。
     * 注意：宿主 config.json 若还没有 diary 段，这里读到 undefined → 走默认值，功能不受影响。
     */
    _diaryConfig() {
        const cfg = (this.voiceChat && this.voiceChat.config) || {};
        const d = cfg.diary;
        return (d && typeof d === 'object') ? d : {};
    }

    /** 本地记忆模型写日记？（默认 false） */
    _isLocalDiaryEnabled() {
        return this._diaryConfig().local_enabled === true;
    }

    /**
     * 本通道的预算闸：云 → canRun，本地 → canRunLocal。
     * 返回统一成 { ok, reason }；异常向外抛（调用方按「本通道不可用」跳过）。
     */
    async _diaryGate() {
        const bg = this._bgLLM || require('../core/background-llm.js');
        const ctx = { getConfig: () => (this.voiceChat && this.voiceChat.config) || {} };
        const raw = this._isLocalDiaryEnabled()
            ? await bg.canRunLocal(ctx)
            : await Promise.resolve(bg.canRun(ctx));
        if (raw && typeof raw === 'object') return { ok: raw.ok !== false, reason: raw.reason || null };
        return { ok: raw !== false, reason: raw === false ? 'blocked' : null };
    }

    /**
     * 云端主模型写日记：非流式、不带工具。
     * 用现有 LLMClient（与 llm-handler 同一套 provider 解析），**不新写 fetch 链**。
     */
    async _cloudDiary(prompt) {
        const client = this._getCloudClient();
        const message = await client.chatCompletion([{ role: 'user', content: prompt }], [], false);
        return message && message.content;
    }

    /**
     * 解析「用哪个云连接」：优先 llm_providers.json 的 provider（与对话主模型一致），
     * 退回旧式三格（API_URL/MODEL/API_KEY）。解析不到返回 null。
     * 每次调用都重新解析（读取的是运行时内存里的 provider 表，代价可忽略），
     * 这样运行中轮换 key / 换 provider 能被指纹捕获。
     */
    _resolveCloudSource() {
        const cfg = (this.voiceChat && this.voiceChat.config) || {};
        const llm = cfg.llm || {};
        let resolved = null;
        try {
            const { llmProviderManager } = require('../core/llm-provider.js');
            if (llmProviderManager && typeof llmProviderManager.resolveProviderOrFallback === 'function') {
                resolved = llmProviderManager.resolveProviderOrFallback(llm.provider_id || null, llm.model_id || null);
            }
        } catch (e) { resolved = null; }
        if (resolved && resolved.api_url) {
            return {
                kind: 'provider',
                resolved,
                providerId: String(resolved.id || llm.provider_id || ''),
                apiUrl: String(resolved.api_url || ''),
                model: String(resolved.model || ''),
                apiKey: String(resolved.api_key || ''),
            };
        }
        if (this.voiceChat && (this.voiceChat.API_URL || this.voiceChat.MODEL)) {
            // 旧式三格兜底：VoiceChatFacade 已把 provider / 旧 config.llm 解析成这三个字段
            return {
                kind: 'legacy',
                resolved: null,
                providerId: 'legacy',
                apiUrl: String(this.voiceChat.API_URL || ''),
                model: String(this.voiceChat.MODEL || ''),
                apiKey: String(this.voiceChat.API_KEY || ''),
            };
        }
        return null;
    }

    /** 配置指纹：provider 身份 + api_url + model + key 哈希（不把 key 明文留在内存字符串里）。 */
    _cloudFingerprint(src) {
        const keyHash = crypto.createHash('sha1').update(String(src.apiKey || '')).digest('hex').slice(0, 12);
        return [src.kind, src.providerId, src.apiUrl, src.model, keyHash].join('|');
    }

    /**
     * 懒建云端客户端（与对话主模型同 provider；usage 记为 plugin）。
     * 缓存条件（2026-11-24 第四轮 P2 根因修）：指纹一致 **且** 未过 TTL。
     *   · 指纹变了（换 provider / 换 model / 换 key）→ 立刻重建，不再 401 到重启；
     *   · 指纹没变也最多 60s 复核一次（兜住「provider 表整体重载但字段恰好相同」）；
     *   · 外部注入的 client（测试/_cloudClient 直接替换）没有指纹 → 原样尊重，不覆盖。
     */
    _getCloudClient() {
        // 外部注入（测试/宿主手动替换）：没有指纹就是「不归缓存管」，沿旧行为直接用
        if (this._cloudClient && !this._cloudClientFp) return this._cloudClient;

        const src = this._resolveCloudSource();
        const now = Date.now();
        const fp = src ? this._cloudFingerprint(src) : '';
        if (this._cloudClient && fp && this._cloudClientFp === fp
            && (now - (this._cloudClientAt || 0)) < CLOUD_CLIENT_TTL_MS) {
            return this._cloudClient;
        }
        if (!src) {
            // 解析不到（provider 表被整体重载的瞬间/配置被删）：已有 client 就继续用，
            // 别为了「暂时解析不到」把当天日记直接判死；真的没有才报错。
            if (this._cloudClient) return this._cloudClient;
            throw new Error('云端主模型未配置（llm_providers.json 与 config.llm 都解析不到连接）');
        }

        const { LLMClient } = require('./llm-client.js');
        const cfg = (this.voiceChat && this.voiceChat.config) || {};
        const llm = cfg.llm || {};
        let client = null;
        if (src.resolved) {
            client = LLMClient.fromProviderConfig(src.resolved, llm.retry || {}, 'plugin');
        } else {
            client = new LLMClient({
                llm: {
                    api_key: src.apiKey,
                    api_url: src.apiUrl,
                    model: src.model,
                    llm_label: 'plugin',
                },
            });
        }

        // 日记是 prose：给一点发散，但只有 150 字，别让它写成长文
        client.temperature = 0.8;
        client.temperatureEnabled = true;
        client.topP = 0.95;
        client.maxTokens = 600;

        this._cloudClient = client;
        this._cloudClientFp = fp;
        this._cloudClientAt = now;
        return client;
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
