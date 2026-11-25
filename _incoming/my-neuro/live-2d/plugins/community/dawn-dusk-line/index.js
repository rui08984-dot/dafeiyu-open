/**
 * 晨昏之线 - 时间感知与整点主动问候插件
 *
 * 职能一：环境感知 —— 每次 LLM 请求可在用户消息前注入时区时间、工作日/周末、法定节假日与调休、时段（对齐 AstrBot LLMPerception 思路）
 * 职能二：被动工具 —— 提供时间查询和问候语时间检查
 * 职能三：主动问候 —— 在设定整点智能发起问候，根据对话活跃度选择策略
 * 职能四：桌面主播编播器（路线图 P1「桌面主播模式」）—— 用户长时间没有对话（idle_minutes，默认 25 分钟）
 *         且非静默（global.__petQuiet 为 false）时，自主排一段「节目」：问候开场 → 聊一条记忆/话题重访 →
 *         演一段（8103/perform，纯本地零 API）→ 闲聊一句收尾；段间隔 segment_gap_s（默认 90 秒），
 *         同一次空闲期只播一轮、播完即停，等用户再开口并再次空闲后才排下一轮。每段发出前过静默闸门，
 *         true 即整轮中止。
 *
 * 节假日数据：chinese-workday（国务院放假安排，与 chinese-calendar 数据源同类）
 * 安装：在插件目录执行 npm install
 *
 * 作者：爱熬夜的人形兔
 * 版本：1.1.0
 */

const __silentAudit = require('../../../js/core/silent-audit.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { createRequire } = require('module');
const { Plugin } = require('../../../js/core/plugin-base.js');
// 后台云端花费闸（2026-11-25 契约）：主动问候 / 话题重访 / 自主节目每一句都走
// context.sendMessage（完整云调用）。quiet 只表示「不说话」，不是「不花钱」；
// cost.background_llm=false 才是后台花费总开关 —— 两者必须都过。
const backgroundLLM = require('../../../js/core/background-llm.js');

const PATCH_ID = 'dawn-dusk-line-greeting';

// 演出控制口（petbridge/vts-server.mjs 的 HTTP 控制端口；POST /perform {name} 纯本地，不产生任何 API 调用）
const PERFORM_PORT = 8103;

const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 与 LLMPerception / 常用习惯一致：上午/中午/下午/晚上/深夜 */
function timePeriodFromHour(hour) {
    if (hour >= 5 && hour < 12) return '上午';
    if (hour >= 12 && hour < 14) return '中午';
    if (hour >= 14 && hour < 18) return '下午';
    if (hour >= 18 && hour < 22) return '晚上';
    return '深夜';
}

/**
 * 指定 IANA 时区下的日历分量（与 LLMPerception 一致：精确到秒的时间戳 + 用于节假日判断的当地日期）
 */
function getZonedComponents(date, timeZone) {
    const s = new Intl.DateTimeFormat('sv-SE', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(date);
    const [datePart, timePart] = s.split(/[\sT]/);
    const [hh, mm] = (timePart || '00:00:00').split(':');
    const hour = parseInt(hh, 10);
    const minute = parseInt(mm, 10);
    const weekdayMon0 = getWeekdayMon0(date, timeZone);
    return {
        dateKey: datePart,
        timestr: `${datePart} ${timePart || `${hh}:${mm}:00`}`,
        hour,
        minute,
        weekdayMon0
    };
}

/** 周一=0 … 周日=6（按配置时区的日历日） */
function getWeekdayMon0(date, timeZone) {
    const long = new Intl.DateTimeFormat('zh-CN', { timeZone, weekday: 'long' }).format(date);
    const names = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
    const idx = names.indexOf(long);
    return idx >= 0 ? idx : 0;
}

// 注入系统提示词用：引导 AI 在下次回复中自然融入问候
const GREETING_PROMPTS = {
    0:  '现在是午夜12点了，夜深了。如果你接下来要回复用户，请自然地提醒对方注意休息、早点睡觉，语气温柔关切，不要生硬地报时。',
    8:  '现在是早上8点，新的一天开始了。如果你接下来要回复用户，请自然地说一句早安问候，可以提到早晨的感觉，语气活泼温暖，不要生硬地报时。',
    12: '现在是中午12点，该吃午饭了。如果你接下来要回复用户，请自然地提醒对方吃午饭、休息一下，语气轻松日常，不要生硬地报时。',
    18: '现在是傍晚6点，一天快结束了。如果你接下来要回复用户，请自然地说一句傍晚的问候，可以关心对方今天过得怎么样，语气温和，不要生硬地报时。'
};

// 直接发送用：给 AI 一个情景提示让它自由发挥
const DIRECT_GREETING_HINTS = {
    0:  '（现在是午夜12点，夜深了，关心一下对方是否还没睡，温柔地提醒早点休息）',
    8:  '（现在是早上8点，新的一天，元气满满地跟对方说早安吧）',
    12: '（现在是中午12点了，提醒对方该吃午饭了，关心一下）',
    18: '（现在是傍晚6点，一天快结束了，问问对方今天过得怎么样）'
};

class DawnDuskLinePlugin extends Plugin {

    // ==================== 生命周期 ====================

    async onInit() {
        const cfg = this.context.getPluginFileConfig();

        const hoursStr = cfg.greetingHours ?? '0,8,12,18';
        this._greetingHours = hoursStr.split(',').map(h => parseInt(h.trim(), 10)).filter(h => !isNaN(h));
        this._quietThreshold  = (cfg.quietThreshold  ?? 10) * 60 * 1000;
        this._activeThreshold = (cfg.activeThreshold  ?? 3)  * 60 * 1000;
        this._deferTimeout    = (cfg.deferTimeout     ?? 30) * 60 * 1000;
        this._checkInterval   = (cfg.checkInterval    ?? 30) * 1000;
        this._revisitIntervalH = Number(cfg.revisitIntervalHours ?? 2);

        this._timezone = cfg.timezone || 'Asia/Shanghai';
        this._enableHoliday = cfg.enableHolidayPerception !== false;
        this._injectPerception = cfg.injectEnvironmentPerception !== false;
        this._holidayCountry = (cfg.holidayCountry || 'CN').toUpperCase();

        // P1-11（2026-11-22 审计）：以前把「进程启动时刻」当成上次交互 ——
        // 8:01 启动会被判「对话活跃」，把早安问候做成补丁挂进 system，用户 9:30 才说话，
        // 她第一句还是「早安」。初始化为 0：启动时按「静默很久」处理（直接问候，不留补丁）。
        this._lastInteractionTime = 0;
        this._firedHours = new Set();
        this._checkTimer = null;
        this._deferredGreeting = null;
        this._deferTimer = null;
        this._patchApplied = false;
        this._cnWorkday = null;

        // ── 桌面主播编播器（路线图 P1「桌面主播模式」）──
        this._showcaseEnabled  = cfg.showcase_enabled !== false;
        this._idleMinutes      = Math.max(1, Number(cfg.idle_minutes ?? 25));
        this._segmentGapS      = Math.max(5, Number(cfg.segment_gap_s ?? 90));
        this._showRunning      = false;
        this._showToken        = 0;      // 递增作废旧节目链上的定时回调
        this._showPlayedForIdle = false; // 本次空闲期已排过节目（用户开口才算新的空闲期）
        this._showInterrupted  = false;  // 节目播到一半用户插话 → 剩余段落收场
        this._showTimers       = [];
        this._sceneCursor      = 0;      // 演出名单轮换游标
        this._memoryCursor     = 0;      // 记忆素材轮换游标

        await this._loadChineseWorkday();
    }

    /**
     * chinese-workday 包为 "type":"module"，其 dist 文件名为 *.cjs.js（仍以 .js 结尾），
     * 在包目录内会被当作 ESM，require 会得到空对象；若改用动态 import(巨大 ESM)，
     * 在 Electron 渲染进程曾触发崩溃（exitCode=-36861）。
     * 做法：将 dist 复制到插件目录下纯 .cjs 后缀缓存文件，再 require。
     */
    async _loadChineseWorkday() {
        try {
            const pluginDir = path.dirname(__filename);
            const bundleSrc = path.join(pluginDir, 'node_modules', 'chinese-workday', 'dist', 'chinese-workday.cjs.js');
            const bundleCjs = path.join(pluginDir, '.chinese-workday-bundle.cjs');
            if (!fs.existsSync(bundleSrc)) {
                this._cnWorkday = null;
                return;
            }
            const needCopy =
                !fs.existsSync(bundleCjs) ||
                fs.statSync(bundleSrc).mtimeMs > fs.statSync(bundleCjs).mtimeMs;
            if (needCopy) {
                fs.copyFileSync(bundleSrc, bundleCjs);
            }
            const req = createRequire(__filename);
            const mod = req(bundleCjs);
            if (mod && typeof mod.isHoliday === 'function' && typeof mod.isWorkday === 'function') {
                this._cnWorkday = mod;
                return;
            }
            this.context.log('warn', '晨昏之线: chinese-workday 加载后 API 异常，节假日将仅按周末判断');
            this._cnWorkday = null;
        } catch (e) {
            this.context.log('warn',
                `晨昏之线: 未加载 chinese-workday（请在插件目录执行 npm install），节假日将仅按周末判断: ${e.message}`);
            this._cnWorkday = null;
        }
    }

    async onStart() {
        this._onInteraction = () => {
            this._lastInteractionTime = Date.now();
        };

        this.context.on('interaction:updated', this._onInteraction);

        // 用户真正开口（打字/语音）与「任何交互」分开记：她自己 TTS 播完也会发 interaction:updated
        // （js/voice/tts-factory.js），不能拿它当「用户回来了」——否则节目会播到一半被自己打断。
        // 用户开口才意味着：本轮节目让位 + 新的空闲期开始（可以再排下一轮节目）。
        this._onUserMessage = () => {
            this._lastInteractionTime = Date.now();
            this._showPlayedForIdle = false;
            this._showInterrupted = true;
        };
        this.context.on('user:message:received', this._onUserMessage);

        this._onTTSEnd = () => this._tryFlushDeferred();
        this.context.on('tts:end', this._onTTSEnd);

        this._checkTimer = setInterval(() => this._tick(), this._checkInterval);

        // ── 话题重访（MapDia 思路）：记忆里「有后续价值的事」，隔一阵子自然地问一句近况 ──
        // 四层门控：静默闸 → 用户 10 分钟内有对话不插嘴 → 该话题 24h 内聊过不重复 → 才花那次 LLM。
        this._revisitSent = new Set();
        this._revisitTimer = setInterval(() => { this._revisitSweep().catch(() => {}); },
            Math.max(0.5, this._revisitIntervalH) * 3600 * 1000);
        this._revisitFirst = setTimeout(() => { this._revisitSweep().catch(() => {}); }, 15 * 60 * 1000);

        const calOk = this._cnWorkday && this._enableHoliday && this._holidayCountry === 'CN';
        this.context.log('info',
            `晨昏之线已启动 | 时区: ${this._timezone} | 注入感知: ${this._injectPerception} | ` +
            `节假日: ${calOk ? 'chinese-workday' : '仅周末'} | 问候时刻: ${this._greetingHours.join(',')}点 | 检查间隔: ${this._checkInterval / 1000}s`);
        this.context.log('info',
            `[节目] 编播器已就绪 | 开关: ${this._showcaseEnabled} | 空闲阈值: ${this._idleMinutes}min | 段间隔: ${this._segmentGapS}s`);
    }

    async onStop() {
        if (this._checkTimer) { clearInterval(this._checkTimer); this._checkTimer = null; }
        if (this._deferTimer) { clearInterval(this._deferTimer); this._deferTimer = null; }
        // 话题重访定时器（既有泄漏：卸载后仍存活，2026-11-07 工作流实现者发现，此处补清）
        if (this._revisitTimer) { clearInterval(this._revisitTimer); this._revisitTimer = null; }
        if (this._revisitFirst) { clearTimeout(this._revisitFirst); this._revisitFirst = null; }
        // 编播器：作废在排的节目链并清掉段间隔定时器
        this._showToken++;
        this._clearShowTimers();
        this._showRunning = false;
        if (this._onInteraction) {
            this.context.off('interaction:updated', this._onInteraction);
        }
        if (this._onUserMessage) {
            this.context.off('user:message:received', this._onUserMessage);
        }
        if (this._onTTSEnd) {
            this.context.off('tts:end', this._onTTSEnd);
        }
        this._removePatch();
    }

    // ==================== 感知行（工具 + LLM 注入） ====================

    _buildPerceptionLine(now = new Date(), tzOverride) {
        const tz = tzOverride || this._timezone;
        const { timestr, hour, dateKey, weekdayMon0 } = getZonedComponents(now, tz);

        const calParts = [WEEKDAY_NAMES[weekdayMon0]];
        const isWeekend = weekdayMon0 >= 5;

        if (this._enableHoliday && this._holidayCountry === 'CN' && this._cnWorkday) {
            const isHol = this._cnWorkday.isHoliday(dateKey);
            const isWork = this._cnWorkday.isWorkday(dateKey);
            let festival = '';
            if (isHol) {
                try {
                    festival = this._cnWorkday.getFestival(dateKey) || '';
                } catch (_) {
                    festival = '';
                }
                if (!festival) festival = '法定节假日';
                calParts.push(isWeekend ? `周末(${festival})` : `法定节假日(${festival})`);
            } else if (isWork) {
                calParts.push(isWeekend ? '调休工作日' : '工作日');
            } else {
                calParts.push('周末');
            }
        } else {
            calParts.push(isWeekend ? '周末' : '工作日');
        }

        calParts.push(timePeriodFromHour(hour));
        return `发送时间: ${timestr} | ${calParts.join(', ')}`;
    }

    /**
     * 旧宿主兜底：把环境行**追加到末尾**（2026-11-25 P2-6）。
     * 历史缓存只允许尾部追加，禁止前插 —— 往最后一条 user 的**开头**插字会让
     * usage-ledger 的易变块剥离（只剥 VOLATILE_HEADER 之后）失效，压缩触发退回估算。
     * 新宿主走 request.addVolatile（prompt-layout 统一拼到尾），根本不用这个函数。
     */
    _appendToLastUserMessage(messages, suffix) {
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role !== 'user') continue;
            const msg = messages[i];
            if (typeof msg.content === 'string') {
                msg.content = msg.content + (msg.content ? '\n' : '') + suffix;
            } else if (Array.isArray(msg.content)) {
                const textBlock = [...msg.content].reverse().find(c => c.type === 'text');
                if (textBlock) {
                    textBlock.text = (textBlock.text || '') + '\n' + suffix;
                } else {
                    msg.content.push({ type: 'text', text: suffix });
                }
            }
            return;
        }
    }

    async onLLMRequest(request) {
        if (!this._injectPerception || !request.messages?.length) return;
        const line = `[${this._buildPerceptionLine()}]`;
        // 时间/时段每轮都在变：只能走易变尾巴，禁止改最后一条 user 的开头。
        if (typeof request.addVolatile === 'function') {
            request.addVolatile(line);
            return;
        }
        this._appendToLastUserMessage(request.messages, line);
    }

    // ==================== 工具注册（取代 FC 工具） ====================

    // 工具面重塑（2026-11-14）：2 个工具 → 1 个。
    getTools() {
        return [{
            type: 'function',
            function: {
                name: 'dawn_dusk',
                description: '晨昏之线的统一入口：action=time 查询当前时间、日期、星期、是否工作日/节假日，action=check 在用户说「早上好」「晚安」等时间性问候时确认时段，返回配置时区的精确时间与上午/中午/下午/晚上/深夜。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['check', 'time'], description: '要做什么：time 查时间，check 检查问候时段' },
                        timezone: {
                            type: 'string',
                            description: 'IANA 时区（可选，默认与插件配置一致，如 Asia/Shanghai）'
                        }
                    },
                    required: ['action']
                }
            }
        }];
    }

    async executeTool(name, params) {
        const p = params || {};
        // 工具面重塑（2026-11-14）：2 个工具 → 1 个。
        // 两个动作原本就共用同一段实现（逻辑内联在下面的旧分支里，没有内部方法），按旧名复用即可。
        if (name === 'dawn_dusk') {
            const a = String(p.action || '').toLowerCase();
            switch (a) {
                case 'check':
                case 'time':
                    return await this.executeTool('dawn_dusk_get_time', p);
                default:
                    throw new Error('dawn_dusk：action 只能是 check / time（收到「' + a + '」）');
            }
        }
        switch (name) {
            case 'dawn_dusk_get_time':
            case 'dawn_dusk_greeting_check': {
                const tz = p.timezone || this._timezone;
                try {
                    const line = this._buildPerceptionLine(new Date(), tz);
                    return line;
                } catch (e) {
                    return `时间解析失败（请检查时区字符串是否为合法 IANA 时区）: ${e.message}`;
                }
            }
            default:
                throw new Error(`晨昏之线：不支持的工具 ${name}`);
        }
    }

    // ==================== 主动问候系统 ====================

    _tick() {
        this._maybeStartShow();   // 桌面主播编播器：空闲排期与整点问候互不相干，先于问候的 early-return 判断
        const now = new Date();
        const tz = this._timezone;
        const { hour, minute, dateKey: ymd } = getZonedComponents(now, tz);
        const dateKey = `${ymd}-${hour}`;

        const todayPrefix = `${ymd}-`;
        for (const key of this._firedHours) {
            if (!key.startsWith(todayPrefix)) {
                this._firedHours.delete(key);
            }
        }

        if (minute > 5) return;

        if (!this._greetingHours.includes(hour)) return;
        if (this._firedHours.has(dateKey)) return;

        this._firedHours.add(dateKey);
        this._initiateGreeting(hour);
    }

    _initiateGreeting(hour) {
        const elapsed = Date.now() - this._lastInteractionTime;

        try {
            const { appState } = require('../../../js/core/app-state.js');
            if (appState.isPlayingTTS() || appState.isProcessingUserInput()) {
                this.context.log('info', `[晨昏之线] ${hour}点问候 → AI正在说话/处理中，注入提示词`);
                this._injectPatch(hour);
                return;
            }
        } catch (_) { try { __silentAudit.audit('index.js:379', _); } catch (e2) {} }

        if (elapsed < this._activeThreshold) {
            this.context.log('info', `[晨昏之线] ${hour}点问候 → 对话活跃中(${Math.round(elapsed / 1000)}s前)，注入提示词`);
            this._injectPatch(hour);
        } else if (elapsed >= this._quietThreshold) {
            this.context.log('info', `[晨昏之线] ${hour}点问候 → 静默状态(${Math.round(elapsed / 1000)}s前)，直接主动问候`);
            this._sendDirectGreeting(hour);
        } else {
            this.context.log('info', `[晨昏之线] ${hour}点问候 → 半活跃状态，进入延迟等待`);
            this._deferGreeting(hour);
        }
    }

    async _sendDirectGreeting(hour) {
        const hint = DIRECT_GREETING_HINTS[hour] || `（现在是${hour}点，自然地打个招呼）`;
        try {
            // 静默模式（省钱闸）：静默版下不主动开口 —— 主动问候 = 白烧一次 LLM。
            if (global.__petQuiet) {
                this.context.log('info', '[晨昏之线] 静默模式，跳过主动问候');
                return;
            }
            // 后台花费闸（quiet 管「说不说」，这里管「花不花」）。跳过时**退回本小时的
            // 已触发标记**：整点窗口只有 5 分钟，闸在这期间放开还能补发。
            const bgGate = backgroundLLM.ensureCanRun(this.context, { kind: 'dawn-dusk-line' });
            if (!bgGate.ok) {
                try {
                    const z = getZonedComponents(new Date(), this._timezone || 'Asia/Shanghai');
                    if (this._firedHours) this._firedHours.delete(z.dateKey + '-' + hour);
                } catch (e) { try { __silentAudit.audit('index.js:greeting-gate', e); } catch (e2) {} }
                return;
            }
            const arbiter = global.proactiveArbiter;
            const externalPolicy = arbiter?.externalSourcePolicy?.('dawn-dusk-line');
            if (externalPolicy === 'block') {
                this.context.log('info', '[晨昏之线] 已被人格导演阻断主动问候');
                return;
            }
            if (arbiter?.submitExternal && externalPolicy === 'collect') {
                await arbiter.submitExternal('dawn-dusk-line', hint, {
                    priority: 0.56,
                    topic: `${hour}点问候`,
                    topic_key: `dawn_dusk_${hour}`,
                    render_hint: '这是晨昏问候意图，保留时间感，但不要像报时机器。'
                });
                return;
            }
            const greetingReply = await this.context.sendMessage(hint);
            if (greetingReply && String(greetingReply).trim().length >= 2) {
                // 她说话了 = 一次真实接触（防久别重逢误判，见 js/core/last-contact.js 头部）
                try { require('../../../js/core/last-contact.js').noteContact('dawn-dusk'); } catch (e) { /* 记账失败不影响说话 */ }
            }
        } catch (e) {
            this.context.log('error', `[晨昏之线] 主动问候发送失败: ${e.message}`);
        }
    }

    // ── 话题重访 ─────────────────────────────────────────────────────
    async _revisitSweep() {
        try {
            if (global.__petQuiet) return;   // 静默闸（省钱）
            // 后台花费闸：话题重访会发一次完整 sendMessage（云 token）。
            if (!backgroundLLM.ensureCanRun(this.context, { kind: 'dawn-dusk-line' }).ok) return;
            if (Date.now() - this._lastInteractionTime < Math.max(this._activeThreshold, 10 * 60 * 1000)) return;   // 正聊着不插嘴
            const items = await this._memosList();
            const candidates = this._pickRevisitTopics(items);
            if (!candidates.length) return;
            const recent = this._recentConversationText();
            for (const topic of candidates) {
                if (this._revisitSent.has(topic.content)) continue;
                if (topic.keyword && recent && recent.includes(topic.keyword)) continue;   // 24h 内聊过
                this._revisitSent.add(topic.content);
                this.context.log('info', '[晨昏之线] 话题重访 → ' + topic.content.slice(0, 36));
                const revisitReply = await this.context.sendMessage('（你在自己的记忆里想起他之前说过的事，现在想自然地问一句近况；不要像查户口，不要复述原句）他之前提到过：' + topic.content);
                if (revisitReply && String(revisitReply).trim().length >= 2) {
                    try { require('../../../js/core/last-contact.js').noteContact('dawn-dusk'); } catch (e) { /* 记账失败不影响说话 */ }
                }
                return;   // 一次只聊一件
            }
        } catch (e) { this.context.log('warn', '[晨昏之线] 话题重访失败: ' + (e && e.message)); }
    }

    _memosList() {
        // 渲染进程插件：node http 直连 MemOS（memory-recall 同款姿势，不受 file:// CORS 限制）
        return new Promise((resolve) => {
            try {
                const http = require('http');
                http.get({ host: '127.0.0.1', port: 8003, path: '/list', timeout: 10000 }, (res) => {
                    let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(null); } });
                }).on('error', () => resolve(null));
            } catch (e) { resolve(null); }
        });
    }

    _pickRevisitTopics(list) {
        const items = (list && (list.memories || list.items)) || [];
        const OPEN_TOPIC = /(计划|打算|准备|要|生日|考试|面试|出差|换工作|旅游|搬|养|买|毕业)/;
        const now = Date.now();
        const picks = [];
        for (const m of items) {
            const content = String(m.content || '').trim();
            if (content.length < 8 || content.length > 60) continue;
            const imp = Number(m.importance ?? 0);
            if (imp < 0.6) continue;                                  // 有分量的事才值得问
            const created = Date.parse(m.created_at || m.updated_at || '') || 0;
            const ageDays = (now - created) / 86400000;
            if (!(ageDays >= 1 && ageDays <= 14)) continue;            // 太新像复读，太旧像失忆
            if (!OPEN_TOPIC.test(content)) continue;                   // 没有后续价值的平凡陈述不问
            const keyword = content.replace(/^主人|^小C|[，。！？、].*$/g, '').slice(0, 6);
            picks.push({ content, keyword, imp, ageDays });
        }
        picks.sort((a, b) => (b.imp - a.imp) || (a.ageDays - b.ageDays));
        return picks.slice(0, 3);
    }

    _recentConversationText() {
        // 最近 24h 的对话里找关键词，避免「问了又问」
        try {
            const { RECORDS_DIR } = require('../../../js/core/records-path.js');
            const file = require('path').join(RECORDS_DIR, '对话历史.jsonl');
            const fs = require('fs');
            const raw = fs.readFileSync(file, 'utf8').split('\n').slice(-80).join('\n');
            const cutoff = Date.now() - 24 * 3600 * 1000;
            const lines = raw.split('\n').filter((l) => {
                try { return (JSON.parse(l).timestamp || 0) > cutoff || /[\d-]{10}T/.test(l) && Date.parse(l) > 0; } catch (e) { return true; }
            });
            return lines.join('\n').slice(-20000);
        } catch (e) { return ''; }
    }

    // ── 桌面主播编播器 ─────────────────────────────────────────────────
    // 用户长时间没说话且非静默时，自主排一段节目：问候开场 → 聊一条记忆/话题重访 →
    // 演一段（8103/perform，纯本地零 API）→ 闲聊一句收尾。四层约束：
    //   ① 同一次空闲期只排一轮（_showPlayedForIdle，用户开口才翻开新的一期）；
    //   ② 每段发出前过静默闸 global.__petQuiet，true 即整轮中止（省钱闸，零 API）；
    //   ③ 用户中途插话（user:message:received）→ 剩余段落收场，让位给对话；
    //   ④ 节目素材只来自记忆库与已有演出名，拿不到就跳过该段并打日志，不编造。

    _maybeStartShow() {
        if (!this._showcaseEnabled) return;
        if (this._showRunning || this._showPlayedForIdle) return;
        const idleMs = Date.now() - this._lastInteractionTime;
        if (idleMs < this._idleMinutes * 60 * 1000) return;
        if (global.__petQuiet) return;   // 静默版不排节目（排了也发不出，白烧调度）
        // 后台花费闸也必须在这里判：_showPlayedForIdle 一旦置 true，本次空闲期就作废
        // （用户再开口才翻开新一期）。闸关时不占坑，放开后仍能排这一期。
        if (!backgroundLLM.ensureCanRun(this.context, { kind: 'dawn-dusk-line' }).ok) return;
        this._showPlayedForIdle = true;  // 先占坑，防止下个 tick 重复排期
        this._startShow();
    }

    _startShow() {
        const token = ++this._showToken;
        this._showRunning = true;
        this._showInterrupted = false;
        this._clearShowTimers();
        this.context.log('info',
            `[节目] 用户已空闲 ${this._idleMinutes} 分钟且非静默，开始排一段节目（段间隔 ${this._segmentGapS}s）`);
        const segments = [
            { name: '开场',   run: () => this._segmentOpening() },
            { name: '聊记忆', run: () => this._segmentMemory() },
            { name: '表演',   run: () => this._segmentPerform() },
            { name: '收尾',   run: () => this._segmentClosing() }
        ];
        let idx = 0;
        const runNext = () => {
            if (token !== this._showToken) return;   // 已被新一轮/停止作废
            if (idx >= segments.length) { this._endShow(token, null); return; }
            const seg = segments[idx++];
            const blocked = this._showGate(seg.name);
            if (blocked) { this._endShow(token, blocked); return; }
            Promise.resolve().then(seg.run).then(() => {
                if (token !== this._showToken) return;
                if (idx >= segments.length) { this._endShow(token, null); return; }
                const t = setTimeout(runNext, this._segmentGapS * 1000);
                this._showTimers.push(t);
            }).catch((e) => {
                if (e && e.gate) { this._endShow(token, e.message); return; }   // 闸门中止不算失败
                this.context.log('error', `[节目] ${seg.name}段执行失败: ${e && e.message || e}`);
                this._endShow(token, `${seg.name}段失败`);
            });
        };
        runNext();
    }

    /** 每段发出前的闸门：返回 null=放行，返回字符串=中止原因 */
    _showGate(segName) {
        if (global.__petQuiet) return '静默模式已开启';
        if (this._showInterrupted) return '用户插话，节目让位';
        // 节目每段都是一次云调用（表演段除外，纯本地）。闸在段间关闭时整轮收场，
        // 不把剩下的段落半截发出去（也不为下一段再请求一次）。
        const bgGate = backgroundLLM.ensureCanRun(this.context, { kind: 'dawn-dusk-line' });
        if (!bgGate.ok) return '后台 LLM 暂停（' + (bgGate.reason || 'paused') + '）';
        this.context.log('info', `[节目] 闸门放行 → ${segName}段（静默=${!!global.__petQuiet}）`);
        return null;
    }

    _endShow(token, reason) {
        if (token !== this._showToken) return;
        this._showToken++;               // 作废链上残留的定时回调
        this._clearShowTimers();
        this._showRunning = false;
        this.context.log('info', reason
            ? `[节目] 本轮节目提前收场（${reason}），等下一次空闲触发`
            : '[节目] 本轮节目播完，等下一次空闲触发');
    }

    _clearShowTimers() {
        if (this._showTimers && this._showTimers.length) {
            for (const t of this._showTimers) clearTimeout(t);
        }
        this._showTimers = [];
    }

    /** 段落发送（复用主动问候的 sendMessage 骨架：人格导演闸 → 递交 → 直发），发送前最后一道静默闸 */
    async _sendShowLine(hint, topicKey) {
        if (global.__petQuiet) {
            const err = new Error('发送前静默闸命中');
            err.gate = true;
            throw err;
        }
        // 段间隔默认 90s：闸可能在两段之间被关掉，发送前再问一次（最终闸）。
        if (!backgroundLLM.ensureCanRun(this.context, { kind: 'dawn-dusk-line' }).ok) {
            const err = new Error('后台 LLM 暂停，节目收场');
            err.gate = true;
            throw err;
        }
        const arbiter = global.proactiveArbiter;
        const externalPolicy = arbiter?.externalSourcePolicy?.('dawn-dusk-line');
        if (externalPolicy === 'block') {
            const err = new Error('已被人格导演阻断');
            err.gate = true;
            throw err;
        }
        if (arbiter?.submitExternal && externalPolicy === 'collect') {
            await arbiter.submitExternal('dawn-dusk-line', hint, {
                priority: 0.5,
                topic: '桌面小节目',
                topic_key: topicKey,
                render_hint: '这是自主节目的串词，保持口语自然，不要像播报机器。'
            });
            return;
        }
        await this.context.sendMessage(hint);
    }

    // 段一：问候开场（时间感来自已有的感知骨架，不报时不问在吗）
    _segmentOpening() {
        const { hour } = getZonedComponents(new Date(), this._timezone);
        const period = timePeriodFromHour(hour);
        const hint = `（自主节目时间：他已经有一阵子没说话了。你决定自己开播一段小节目，先像主播开场一样自然地打个招呼，可以带一句${period}的氛围，一两句话就好）`;
        return this._sendShowLine(hint, 'show_opening');
    }

    // 段二：聊一条记忆/话题重访（素材全部来自记忆库，拿不到就跳过）
    async _segmentMemory() {
        let pick = null;
        try {
            const list = await this._memosList();
            pick = this._pickShowMemory(list);
        } catch (e) {
            this.context.log('error', '[节目] 记忆库读取失败，聊记忆段跳过: ' + (e && e.message || e));
            return;
        }
        if (!pick) {
            this.context.log('info', '[节目] 记忆库里没有可聊的素材，聊记忆段跳过');
            return;
        }
        const hint = '（节目第二段：你在自己的记忆里想起他之前的事，像聊起往事一样自然地说一段，不要查户口、不要复述原句）他之前提到过：' + pick.content;
        return this._sendShowLine(hint, 'show_memory');
    }

    /** 节目记忆素材：先走话题重访同一条质量线（_pickRevisitTopics），没有再放宽到任意有内容的记忆，游标轮换不重复 */
    _pickShowMemory(list) {
        const items = (list && (list.memories || list.items)) || [];
        const good = this._pickRevisitTopics(list);
        const pool = good.length
            ? good
            : items
                .map((m) => ({ content: String(m.content || '').trim() }))
                .filter((m) => m.content.length >= 8 && m.content.length <= 120);
        if (!pool.length) return null;
        const pick = pool[this._memoryCursor % pool.length];
        this._memoryCursor = (this._memoryCursor + 1) % pool.length;
        return pick;
    }

    // 段三：演一段（8103/perform，纯本地零 API）。演出名来自 listScenes，拿不到就跳过本段
    _segmentPerform() {
        const scenes = this._listScenes();
        if (!scenes.length) {
            this.context.log('info', '[节目] 拿不到演出单（listScenes 不可用或为空），表演段跳过');
            return;
        }
        const name = scenes[this._sceneCursor % scenes.length];
        this._sceneCursor = (this._sceneCursor + 1) % scenes.length;
        return this._postPerform(name).then((ok) => {
            if (ok) {
                this.context.log('info', `[节目] 表演段 → ${name}（8103/perform，纯本地）`);
            } else {
                this.context.log('info', '[节目] 表演段未被 8103/perform 确认成功，继续后面的段落');
            }
        });
    }

    /** 演出单：本插件与 petBody 同渲染进程（index.html 同时加载 petbody.js 与 app.js），
     *  与 ui-controller「演一段」按钮同源同姿势（js/ui/ui-controller.js: global.petBody.listScenes()）。
     *  8103 HTTP 控制口只有 /perform 没有 scenes 清单端点，故清单从渲染进程拿，拿不到返回空=跳过表演段。 */
    _listScenes() {
        try {
            const body = global.petBody;
            if (body && typeof body.listScenes === 'function') {
                const names = body.listScenes() || [];
                return names.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim());
            }
        } catch (e) {
            this.context.log('warn', '[节目] 读取演出单失败: ' + (e && e.message || e));
        }
        return [];
    }

    _postPerform(name) {
        return new Promise((resolve) => {
            try {
                const body = Buffer.from(JSON.stringify({ name }), 'utf8');
                const req = http.request({
                    host: '127.0.0.1', port: PERFORM_PORT, path: '/perform', method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
                }, (res) => {
                    let s = '';
                    res.on('data', (c) => { s += c; });
                    res.on('end', () => {
                        try {
                            const data = JSON.parse(s);
                            resolve(!!(data && data.ok));
                        } catch (e) {
                            this.context.log('warn', `[节目] 8103/perform 响应解析失败: ${e.message}`);
                            resolve(false);
                        }
                    });
                });
                req.on('error', (e) => {
                    this.context.log('warn', `[节目] 8103/perform 请求失败，表演段跳过: ${e.message}`);
                    resolve(false);
                });
                req.setTimeout(5000, () => {
                    try { req.destroy(); } catch (e) { this.context.log('warn', `[节目] 8103/perform 超时中断异常: ${e.message}`); }
                    resolve(false);
                });
                req.write(body);
                req.end();
            } catch (e) {
                this.context.log('warn', '[节目] 表演段发起失败: ' + (e && e.message || e));
                resolve(false);
            }
        });
    }

    // 段四：闲聊一句收尾
    _segmentClosing() {
        const hint = '（节目收尾：闲聊一句，比如问问对方刚才那段怎么样、或者他想听点什么，一两句话自然收场，不要总结陈词）';
        return this._sendShowLine(hint, 'show_closing');
    }

    _injectPatch(hour) {
        const prompt = GREETING_PROMPTS[hour] || `现在是${hour}点，请在下次回复中自然地融入一句应景的问候。`;
        // 易变尾巴而不是 system：问候只在「下一次回复」有效；挂 system 会一直作废前缀缓存，
        // 且用户几小时后才说话时还在（2026-11-22 审计 P1-11）。
        this.context.addSystemPromptPatch(PATCH_ID, prompt, { volatile: true });
        this._patchApplied = true;
    }

    _removePatch() {
        if (this._patchApplied) {
            this.context.removeSystemPromptPatch(PATCH_ID);
            this._patchApplied = false;
        }
    }

    _deferGreeting(hour) {
        if (this._deferredGreeting) return;
        this._deferredGreeting = { hour, startTime: Date.now() };

        this._deferTimer = setInterval(() => {
            if (!this._deferredGreeting) {
                clearInterval(this._deferTimer);
                this._deferTimer = null;
                return;
            }

            const waitedMs = Date.now() - this._deferredGreeting.startTime;
            if (waitedMs > this._deferTimeout) {
                this.context.log('info', `[晨昏之线] 延迟等待超时(${Math.round(waitedMs / 60000)}min)，放弃本次问候`);
                this._deferredGreeting = null;
                clearInterval(this._deferTimer);
                this._deferTimer = null;
                return;
            }

            const elapsed = Date.now() - this._lastInteractionTime;
            if (elapsed >= this._quietThreshold) {
                const h = this._deferredGreeting.hour;
                this._deferredGreeting = null;
                clearInterval(this._deferTimer);
                this._deferTimer = null;
                this.context.log('info', `[晨昏之线] 检测到对话间隙，发送延迟问候`);
                this._sendDirectGreeting(h);
            }
        }, 15000);
    }

    _tryFlushDeferred() {
        if (!this._deferredGreeting) return;
        const elapsed = Date.now() - this._lastInteractionTime;
        if (elapsed >= this._quietThreshold) {
            const h = this._deferredGreeting.hour;
            this._deferredGreeting = null;
            if (this._deferTimer) { clearInterval(this._deferTimer); this._deferTimer = null; }
            this.context.log('info', `[晨昏之线] TTS结束后检测到静默，发送延迟问候`);
            this._sendDirectGreeting(h);
        }
    }

    // ==================== 消息钩子 ====================

    async onLLMResponse(response) {
        if (this._patchApplied) {
            this._removePatch();
        }
    }
}

module.exports = DawnDuskLinePlugin;
