const __silentAudit = require('../../../js/core/silent-audit.js');
const { Plugin } = require('../../../js/core/plugin-base.js');
const { resolvePluginEnabled } = require('../../../js/core/plugin-context.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
// 候选池/画像落盘统一走 json-store（原子写：同目录 tmp → rename；损坏文件隔离不覆盖）
const jsonStore = require('../../../js/core/json-store.js');

// 往上 4 层 = my-neuro/data（唯一真源，见 js/core/records-path.js）
const LIVE2D_ROOT = path.join(__dirname, '..', '..', '..', '..');
const USER_ID = 'feiniu_default';

const CATEGORY_TO_FIELD = {
    habit: 'habits',
    trait: 'traits',
    like: 'preferences.likes',
    dislike: 'preferences.dislikes',
    fact: 'facts',
    relationship: 'relationships'
};

// ── 类别归一化表（2026-11-24）─────────────────────────────────────────────
// 根因：画像模型（本地 MemOperator-4B，云端模型偶尔同样）会把提示词里的**枚举示例**
// 原样抄进 category —— 实测 `"category":"identity|preference|habit|relation|goal|health"`。
// 旧 _normalizeCategory 只认 6 个正式类别，其余一律兜底 fact：于是「身份/关系/目标/健康」
// 全被写进 facts，分桶失真，而且日志里一点信号都没有（看不出模型在乱填）。
// 这里的修法是「翻译 + 认得枚举串」，不是再补一个 if：
//   ① 精确表：6 个正式类别 + 常见复数；
//   ② 同义词表：模型常用但不在枚举里的词翻译成正式类别（含上面抄回来的 token）；
//   ③ 带分隔符的枚举串（| / , ; 全角同义）：切开后取**第一个能翻译的 token**；
//   ④ 全翻译不了才兜底 fact，并只记一次（telemetry + 日志，带原值）。
// 表是唯一真相：以后见到新枚举，只改这张表（或看日志发现它），不用动调用点。
const CATEGORY_TABLE = new Map(Object.entries({
    // ① 正式类别 + 常见复数
    habit: 'habit', habits: 'habit',
    trait: 'trait', traits: 'trait',
    like: 'like', likes: 'like',
    dislike: 'dislike', dislikes: 'dislike',
    fact: 'fact', facts: 'fact',
    relationship: 'relationship', relationships: 'relationship',
    // ② 同义词（模型常见输出；identity/relation/goal/health 就是实测抄回来的枚举 token）
    identity: 'trait',
    personality: 'trait',
    character: 'trait',
    interest: 'like',
    interests: 'like',
    hobby: 'like',
    hobbies: 'like',
    // preference 需要看文本才能定 like / dislike，见 _resolveCategoryToken
    preference: 'preference',
    preferences: 'preference',
    relation: 'relationship',
    relations: 'relationship',
    goal: 'fact',
    goals: 'fact',
    health: 'fact',
    opinion: 'fact',
    opinions: 'fact',
    // 兼作「画像字段名」别名：_decayProfileItems 曾经把 field 当 category 传给 _candidateId，
    // 没有这两条会误报「未识别」并落进 fact 桶。字段→类别本来就有 _fieldToCategory，
    // 这里只是让同一套表也认字段名。
    'preferences.likes': 'like',
    'preferences.dislikes': 'dislike'
}));

// 枚举串分隔符（含全角）：只有「切开后 token 能翻译」才采用，避免把正常短语误切
const CATEGORY_SEPARATORS = /[|｜/\\,，;；、]+/;
// preference 按文本分 like / dislike 的判据（只认明确的否定表述，不猜语气）
const DISLIKE_TEXT_HINTS = /讨厌|不喜欢|厌恶|反感|受不了/;
// 「未识别」日志去重上限：防止模型乱填把进程内存撑大
const UNKNOWN_CATEGORY_LOG_MAX = 50;

const DEFAULT_PROFILE = {
    name: '',
    nickname: '',
    traits: [],
    habits: [],
    preferences: { likes: [], dislikes: [] },
    facts: [],
    relationships: [],
    bootstrapped: false,
    updated_at: '',
    version: 1,
    _meta: { items: {} }
};

const DEFAULT_CANDIDATES = {
    candidates: [],
    archived: [],
    updated_at: '',
    version: 1
};

// ── 画像分析 prompt 预算（2026-11-25 P1 成本修复）──────────────────────────
// 现场：_buildCandidatePrompt 把**整份缩进版画像 JSON**（35KB）灌进 prompt，
//   实测 15.6K tokens ×2（空回复重试同一份），max_tokens=4000 仍被 finish_reason=length
//   截断，随后按「LLM 返回为空」失败 → 每 3 分钟烧一次云配额、画像却不动。
// 契约（本文件的唯一真相）：
//   · 只喂紧凑画像：按类别取最近/高置信 topN（habit 20 / preference 15 / trait 10 / fact 10），
//     单条 80 字；不再 JSON.stringify(..., null, 2)；
//   · prompt 总字符硬闸 6000（超了按「fact → trait → preference → habit」丢类别，
//     再丢候选摘要，最后丢最旧消息 —— 越靠前的类别越该保住）；
//   · max_tokens 1200；
//   · 空正文 / finish_reason=length / JSON 花括号不闭合 → topN 减半重试一次；
//     仍失败记 profile.analysis.skip reason:'too_long'，不写空候选。
const PROFILE_PROMPT_MAX_CHARS = 6000;
const PROFILE_PROMPT_ITEM_MAX = 80;
const PROFILE_PROMPT_MESSAGE_MAX = 200;
const PROFILE_PROMPT_MAX_TOKENS = 1200;
const PROFILE_PROMPT_CANDIDATE_MAX = 30;
const PROFILE_PROMPT_CANDIDATE_TEXT_MAX = 40;
const PROFILE_PROMPT_RELATION_LIMIT = 5;
// 丢类别顺序：先从「最不影响长期画像」的类别开始丢。habit 最后丢（行为模式最值钱）。
const PROFILE_PROMPT_DROP_ORDER = Object.freeze(['fact', 'trait', 'preference', 'habit']);
const PROFILE_PROMPT_CATEGORY_CAPS = Object.freeze({ habit: 20, preference: 15, trait: 10, fact: 10 });

// 候选观察的 JSON Schema（服务端约束解码；老服务不认时 _callProfileLLM 降级一次纯 prompt）
const OBSERVATIONS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['observations'],
    properties: {
        observations: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['match_id', 'category', 'text', 'evidence', 'one_off', 'self_declared', 'obsolete_profile_text'],
                properties: {
                    match_id: { type: ['string', 'null'] },
                    category: { type: 'string', enum: ['habit', 'trait', 'like', 'dislike', 'fact', 'relationship'] },
                    text: { type: 'string' },
                    evidence: { type: 'string' },
                    one_off: { type: 'boolean' },
                    self_declared: { type: 'boolean' },
                    obsolete_profile_text: { type: 'string' }
                }
            }
        }
    }
};

class UserProfilePlugin extends Plugin {

    async onInit() {
        this._cfg = {};
        // 总开关默认允许：真正结论在 onStart（那里能读 plugin_config 与 manager 的清单答案）。
        // 这样「onStart 之前的钩子」保持旧行为（不因 _enabled 未定义就静默停摆）。
        this._enabled = true;
        this._profilePath = null;
        this._candidatePath = null;
        this._profile = this._clone(DEFAULT_PROFILE);
        this._candidateStore = this._clone(DEFAULT_CANDIDATES);
        this._renderedProfile = '';
        this._dirty = false;
        this._distilling = false;
        this._bootstrapRunning = false;
        this._idleTimer = null;
        this._watchers = [];
        this._watchDebounce = null;
        this._interactionHandler = null;
        this._lastProcessedMessageCount = 0;
        // 后台 LLM 闸（2026-11-25）：每次问 ensureCanRun；`_bgGate` 仅作单测注入缝。
        this._bgGate = null;
        this._bgGateLogged = false;
        // 类别归一化（2026-11-24）：未识别原值的去重集合，见 _unknownCategoryOnce
        this._unknownCategories = new Set();
    }

    async onStart() {
        this._cfg = this.context.getPluginFileConfig();
        // 总开关单一真相源（2026-11-21）：enabled_plugins.json（context）优先；
        // plugin_config.enabled 只作旧配置兼容（显式 false 才关，并警告一次）。
        this._enabled = resolvePluginEnabled(this.context, this._cfg, 'user-profile');
        if (!this._enabled) {
            this.context.log('warn', '用户画像插件已禁用');
            return;
        }

        this._profilePath = this._resolveLivePath(this._cfg.profile_file || 'data/用户画像.json');
        this._candidatePath = this._resolveLivePath(this._cfg.candidate_file || 'data/用户画像_候选.json');

        this._loadProfile();
        this._loadCandidates();
        this._decayCandidates();
        this._decayProfileItems();
        this._refreshRenderedProfile();
        this._watchFiles();

        this._interactionHandler = () => this._resetIdleTimer();
        this.context.on('interaction:updated', this._interactionHandler);
        this._resetIdleTimer();

        if (this._cfg.bootstrap_on_first_run !== false && !this._profile.bootstrapped) {
            this._bootstrap().catch(err => {
                this.context.log('warn', `首次画像诊断失败（下次启动会重试）: ${err.message}`);
            });
        }

        this.context.log('info', `用户画像插件已启动，画像文件: ${this._profilePath}`);
    }

    async onStop() {
        clearTimeout(this._idleTimer);
        this._idleTimer = null;
        clearTimeout(this._watchDebounce);
        this._unwatchFiles();

        if (this._interactionHandler) {
            this.context.off('interaction:updated', this._interactionHandler);
            this._interactionHandler = null;
        }

        if (this._cfg.update_on_exit !== false && this._dirty) {
            try {
                await this._withTimeout(this._distill('stop'), 30000);
            } catch (err) {
                this.context.log('warn', `退出前画像更新未完成: ${err.message}`);
            }
        }
    }

    async onLLMRequest(request) {
        // 只有 **明确 false** 才停摆：onInit 之前（或单测直接 new）_enabled 可能未定义，
        // 旧行为是照常注入 —— 这里保持一致（见 :48 的注释）。
        if (this._enabled === false || this._cfg.inject_profile === false) return;
        if (!this._renderedProfile) return;

        // 注入源只有 _renderedProfile（由 _refreshRenderedProfile 从活跃列表拼出）。
        // 2026-11-21：一次性事件/测试元行为已迁到顶层 quarantined，天然不在这里——
        // 隔离区只做留档与可逆还原，不参与任何提示词注入。
        // ⚠ 2026-11-15 六十三轮：**不能**把画像挪到最后一条 user —— 实测渲染后 1494 字（≈900 token），
        // 挪到尾巴等于每轮多 900 token 必 miss：命中率从 ~96.8% 掉到 ~87%（每轮都掉）。
        // 留在 system 的代价只是「画像刷新时掉一次」（约 30 分钟一次），远小于每轮掉 10 个点。
        // 真正要做的是让刷新别太频繁（现在只在文件变更时重载），而不是搬家。
        const sysMsg = request.messages.find(m => m.role === 'system');
        if (sysMsg) {
            sysMsg.content += `\n\n${this._renderedProfile}`;
        }
    }

    async onLLMResponse() {
        if (!this._enabled) return;
        this._dirty = true;
        this._resetIdleTimer();
    }

    async onTTSEnd() {
        if (!this._enabled) return;
        this._resetIdleTimer();
    }

    // 工具面重塑（2026-11-14）：3 个工具 → 1 个。
    // 注意：原 profile_update 的参数名就叫 action，与合并后的 action 冲突，故改名 update_action。
    getTools() {
        if (this._enabled === false) return [];
        return [{
            type: 'function',
            function: {
                name: 'profile',
                description: '用户画像：view 查看**完整**的长期画像（system 里每字段只注入前 10 条，细节缺口用 view 补）；update 手动修正画像，需 update_action 指定操作类型、value 为内容；rebuild 备份当前画像并从 MemOS 长期记忆重新诊断。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['view', 'update', 'rebuild'], description: '要做什么' },
                        update_action: {
                            type: 'string',
                            enum: ['add_trait', 'add_habit', 'add_like', 'add_dislike', 'add_fact', 'add_relationship', 'set_name', 'set_nickname', 'remove'],
                            description: '画像修改操作类型（action=update 时必填；等价于原 profile_update 的 action）'
                        },
                        value: { type: 'string', description: '要写入或移除的内容（action=update 时必填）' }
                    },
                    required: ['action'],
                },
            },
        }];
    }

    async executeTool(name, params = {}) {
        const p = params || {};
        if (name === 'profile') {
            const a = String(p.action || '').toLowerCase();
            switch (a) {
                case 'view':    return this._renderProfileForTool();
                case 'update':  return this._manualUpdate(p.update_action, p.value);
                case 'rebuild': return this._rebuildProfile();
                default: throw new Error('profile：action 只能是 view / update / rebuild（收到「' + a + '」）');
            }
        }
        // 旧工具名保留（技能库/脚本可能直接调；新模型只看得到合并后的名字）
        switch (name) {
            case 'profile_view':
                return this._renderProfileForTool();
            case 'profile_update':
                return this._manualUpdate(params.action, params.value);
            case 'profile_rebuild':
                return this._rebuildProfile();
            default:
                return undefined;
        }
    }

    // ===== Startup bootstrap =====

    async _bootstrap() {
        if (this._bootstrapRunning) return;
        this._bootstrapRunning = true;

        try {
            const apiUrl = this._trimTrailingSlash(this._cfg.memos_api_url || 'http://127.0.0.1:8003');
            const ok = await this._memosHealth(apiUrl);
            if (!ok) {
                this.context.log('warn', 'MemOS 不可用，跳过首次用户画像诊断');
                return;
            }

            const [memories, preferences, graph] = await Promise.all([
                this._fetchMemosMemories(apiUrl),
                this._fetchMemosPreferences(apiUrl),
                this._fetchMemosGraph(apiUrl)
            ]);

            const selectedMemories = this._selectBootstrapMemories(memories);
            if (selectedMemories.length === 0 && preferences.length === 0) {
                this.context.log('warn', 'MemOS 中暂无可用于首次诊断的长期记忆');
                return;
            }

            const prompt = this._buildBootstrapPrompt(selectedMemories, preferences, graph);
            const response = await this._callProfileLLM(prompt, { temperature: 0.2 });
            const parsed = this._parseJsonObject(response);
            const nextProfile = this._normalizeProfile({
                ...this._profile,
                ...parsed,
                bootstrapped: true,
                updated_at: this._nowIso()
            });

            nextProfile._meta = nextProfile._meta || { items: {} };
            this._touchAllProfileItems(nextProfile, this._today());
            this._profile = nextProfile;
            this._saveProfile();
            this._refreshRenderedProfile();
            this.context.log('info', `首次用户画像诊断完成：使用 ${selectedMemories.length} 条记忆、${preferences.length} 条偏好`);
        } finally {
            this._bootstrapRunning = false;
        }
    }

    // ===== Distillation pipeline =====

    async _distill(reason = 'idle') {
        if (this._distilling) return;

        const messages = this.context.getMessages();
        const minNewMessages = this._numberCfg('min_new_messages', 4);
        const newCount = Math.max(0, messages.length - this._lastProcessedMessageCount);
        if (!this._dirty || newCount < minNewMessages) {
            this._decayCandidates();
            this._decayProfileItems();
            return;
        }

        this._distilling = true;
        try {
            // 2026-11-24（后台花钱闸）：画像分析 = 一次 LLM 调用，静默/配额耗尽/熔断期间不该跑。
            // 判据统一来自 js/core/background-llm.js 的 canRun()（返回 {ok,reason,retryAt}）。
            // 懒加载 + try/catch + fail-open：模块缺失或自身报错时照旧跑，不让数据链路停摆。
            if (!(await this._backgroundAllowed())) {
                // 不进 LLM，但仍做 TTL/归档这些零成本的本地维护
                this._decayCandidates();
                this._decayProfileItems();
                if (!this._bgGateLogged) {
                    this._bgGateLogged = true;
                    this.context.log('info', '画像后台分析暂停：后台 LLM 闸不可用（静默/配额/熔断），恢复后自动补跑（只记一次）');
                }
                // 注意：不置 _dirty=false、不推进 _lastProcessedMessageCount → 闸恢复后这批消息还会被分析
                return;
            }

            const maxMessages = this._numberCfg('max_context_messages', 40);
            const recentMessages = messages
                .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
                .slice(-maxMessages);

            if (recentMessages.length === 0) return;

            const observations = await this._extractCandidates(recentMessages);
            const { changed, profileChanged, promotable } = await this._updateCandidatePool(observations);
            const promoted = await this._promoteCandidates(promotable);

            this._decayCandidates();
            this._decayProfileItems();

            // 2026-11-24：候选池只在真有池内变更/晋升时写；画像变更不再连带重写候选池
            // （原来 profileChanged 也让 _saveCandidates 跑，等于每轮把 138 条整份重写）。
            const poolTouched = changed || promoted > 0;
            const profileTouched = profileChanged || promoted > 0;
            if (poolTouched) this._saveCandidates();
            if (profileTouched) {
                if (!promoted) this._profile.updated_at = this._nowIso();
                this._saveProfile();
                this._refreshRenderedProfile();
            }

            this._dirty = false;
            this._lastProcessedMessageCount = messages.length;
            this._failStreak = 0;
            this.context.log('info', `画像后台分析完成 (${reason})：候选 ${observations.length} 条，晋升 ${promoted} 条`);
        } catch (err) {
            // 失败分级（2026-11-10 三十九轮）：LLM 偶发「只回思考不回正文」不该按 error 报——
            // 它让日志看起来像功能坏了（实测 6 次）。改 warn + 保留 dirty（下次消息自然重试），
            // 连续 3 次才升 error（那才是真有问题）。
            this._failStreak = (this._failStreak || 0) + 1;
            const lvl = this._failStreak >= 3 ? 'error' : 'warn';
            this.context.log(lvl, `画像后台分析失败（连续 ${this._failStreak} 次）: ${err.message}`);
        } finally {
            this._distilling = false;
        }
    }

    /**
     * 后台 LLM 闸（2026-11-24；2026-11-25 收口）：判据唯一入口是
     * `backgroundLLM.ensureCanRun(this.context, {kind})`（内部 = 用户开关 + 云端熔断），
     * 返回 {ok, reason, retryAt, kind}。只有模块真的不在（早期启动）才 fail-open。
     *
     * 旧实现第一次 require 失败就把 `_bgGateReady=true` 永久置位，之后闸永远等于不存在；
     * 还自己兼容 undefined/布尔/`{allowed}`，判错一律放行 —— 闸的「真相」被插件复制了一遍。
     * 现在不再缓存失败、不再解析多种形状。`_bgGate` 仅保留为单测注入缝。
     * @returns {Promise<boolean>} true = 允许调 LLM
     */
    async _backgroundAllowed() {
        // 单测注入缝（生产不设置）：与真实闸同语义，返回 {ok:false} 即拒绝。
        if (this._bgGate && typeof this._bgGate.ensureCanRun === 'function') {
            const r = this._bgGate.ensureCanRun(this.context, { kind: 'user-profile' });
            return !(r && r.ok === false);
        }
        if (this._bgGate && typeof this._bgGate.canRun === 'function') {
            // 兼容旧测试注入的 {canRun}：按真实契约只认显式 ok:false。
            const r = this._bgGate.canRun(this.context);
            return !(r && r.ok === false);
        }
        let bg;
        try { bg = require('../../../js/core/background-llm.js'); } catch (e) { return true; }
        if (!bg || typeof bg.ensureCanRun !== 'function') return true;
        // 不包 try/catch：ensureCanRun 内部已兜住配置/熔断/日志异常。
        const r = bg.ensureCanRun(this.context, { kind: 'user-profile' });
        return !(r && r.ok === false);
    }

    async _extractCandidates(recentMessages) {
        // 第一次用正常预算；输出空/被截断 → topN 减半、消息减半再试一次。
        // 两次都失败就不再写空候选（旧行为会把「LLM 返回为空」抛给 _distill，每 3 分钟重试同一份 35KB prompt）。
        let result = await this._runCandidatePrompt(recentMessages, PROFILE_PROMPT_CATEGORY_CAPS, this._numberCfg('max_context_messages', 40));
        if (this._profileOutputTruncated(result)) {
            const half = {};
            for (const [k, v] of Object.entries(PROFILE_PROMPT_CATEGORY_CAPS)) {
                half[k] = Math.max(1, Math.floor(v / 2));
            }
            this.context.log('warn', `[画像] 候选分析输出不完整，降级重试（topN 减半）: ${this._profilePromptLogLine(result)}`);
            result = await this._runCandidatePrompt(recentMessages, half,
                Math.max(4, Math.ceil(this._numberCfg('max_context_messages', 40) / 2)));
        }
        if (this._profileOutputTruncated(result)) {
            this.context.log('warn', `profile.analysis.skip reason:'too_long' ${this._profilePromptLogLine(result)}`);
            return [];
        }

        const parsed = this._parseJsonObject(result.text);
        const observations = Array.isArray(parsed.observations) ? parsed.observations : [];

        return observations
            .map(obs => this._normalizeObservation(obs))
            .filter(obs => obs && obs.text);
    }

    async _runCandidatePrompt(recentMessages, caps, messageLimit) {
        const prompt = this._buildCandidatePrompt(recentMessages, { caps, messageLimit });
        const stats = Object.assign({}, this._lastPromptStats);
        const out = await this._callProfileLLM(prompt, {
            temperature: 0.2, withMeta: true, schema: 'observations', max_tokens: PROFILE_PROMPT_MAX_TOKENS
        });
        const text = typeof out === 'string' ? out : String((out && out.text) || '');
        return {
            text,
            finishReason: String((out && out.finishReason) || ''),
            stats
        };
    }

    /**
     * 输出是否「没拿到可用正文」。三个信号任一成立即算：
     *   · 正文为空（本地小模型只回 reasoning 的典型形态）；
     *   · finish_reason === 'length'（专用画像模型的 HTTP 通道能拿到）；
     *   · 花括号不闭合（context.callLLM 只回字符串，拿不到 finish_reason → 用结构判据兜底）。
     */
    _profileOutputTruncated(result) {
        if (!result) return true;
        const text = String(result.text || '').trim();
        if (!text) return true;
        if (String(result.finishReason || '').toLowerCase() === 'length') return true;
        const opens = (text.match(/\{/g) || []).length;
        const closes = (text.match(/\}/g) || []).length;
        return opens > closes;
    }

    _profilePromptLogLine(result) {
        const s = (result && result.stats) || this._lastPromptStats || {};
        return 'promptChars=' + (Number(s.chars) || 0)
            + ' tokensEst=' + (Number(s.tokensEst) || 0)
            + ' maxTokens=' + PROFILE_PROMPT_MAX_TOKENS
            + ' finishReason=' + String((result && result.finishReason) || 'unknown')
            + ' profileChars=' + (Number(s.profileChars) || 0)
            + ' dropped=' + JSON.stringify(s.dropped || []);
    }

    async _updateCandidatePool(observations) {
        const today = this._today();
        // 2026-11-24：候选池变更与画像变更分开记。原来「观察命中已有画像项」也把
        // candidates 标脏 → 每轮都把 138 条（含 110 条已晋升）整份重写一遍。
        let changed = false;
        let profileChanged = false;
        const promotable = [];

        for (const obs of observations) {
            this._applyObservationContradictions(obs);

            const existingProfileItem = this._findProfileItem(obs.category, obs.text);
            if (existingProfileItem) {
                this._touchProfileItem(existingProfileItem.field, existingProfileItem.text, today);
                profileChanged = true;
                continue;
            }

            let candidate = this._findCandidateForObservation(obs);
            if (!candidate) {
                // 2026-11-24：归档 ≠ 遗忘。同一件事在归档后再次被观察到时，必须认出 archived
                // 里的旧条目并**复活**它，否则会新建一条同名候选 → 再晋升一次 → 重复画像/重复
                // 证据链（archived 里留着旧的，candidates 里又长出一条新的）。
                candidate = this._reviveArchivedCandidate(obs, today);
            }
            if (!candidate) {
                candidate = {
                    id: this._candidateId(obs.category, obs.text),
                    category: obs.category,
                    text: obs.text,
                    count: 0,
                    first_seen: today,
                    last_seen: today,
                    last_counted_day: '',
                    self_declared: false,
                    status: 'candidate',
                    evidence: [],
                    memos_support: null
                };
                this._candidateStore.candidates.push(candidate);
            }

            const sameDay = candidate.last_counted_day === today;
            const evidenceItem = {
                date: today,
                text: obs.evidence || obs.text,
                one_off: obs.one_off,
                self_declared: obs.self_declared
            };
            // 同一天同一条证据不重复追加：原来每轮都 push 一次，evidence 永远「变了」
            // → changed 恒 true → 整池重写（promoted 条目也跟着被重写）。
            const evidenceAdded = this._isNewEvidence(candidate.evidence, evidenceItem) === true;
            const countBumped = !sameDay;
            const selfChanged = Boolean(candidate.self_declared) !== Boolean(candidate.self_declared || obs.self_declared);
            const oneOffChanged = Boolean(candidate.one_off) !== Boolean(candidate.one_off || obs.one_off);

            if (countBumped) candidate.count = Math.max(0, Number(candidate.count || 0)) + 1;
            candidate.self_declared = Boolean(candidate.self_declared || obs.self_declared);
            // 2026-11-21 审计 P1：one_off 必须**粘住**（一旦有一次被标成一次性事件，
            // 后续普通观察不能把它洗白）。跨天反复出现 ≥3 次且跨 ≥3 天时才在
            // _shouldPromote 里推翻这个标签 —— 见那里的注释。
            candidate.one_off = Boolean(candidate.one_off || obs.one_off);
            const wasPromoted = candidate.status === 'promoted';
            candidate.status = wasPromoted ? 'promoted' : 'candidate';
            if (evidenceAdded) {
                candidate.evidence = this._appendEvidence(candidate.evidence, evidenceItem);
            }

            // promoted 条目：只有「新证据 / 新计数 / 标签变化」才动它（含 last_seen）。
            // 没变化的已晋升条目不该每轮被刷新、被重新序列化。
            if (!wasPromoted || evidenceAdded || countBumped || selfChanged || oneOffChanged) {
                if (countBumped) candidate.last_counted_day = today;
                candidate.last_seen = today;
                changed = true;
            }

            if (candidate.status !== 'promoted' && await this._shouldPromote(candidate)) {
                promotable.push(candidate);
            }
        }

        return { changed, profileChanged, promotable };
    }

    async _promoteCandidates(candidates) {
        const pending = candidates.filter(c => c && c.status !== 'promoted');
        if (pending.length === 0) return 0;

        const refined = await this._refinePromotionTexts(pending);
        const today = this._today();
        let promoted = 0;

        for (const candidate of pending) {
            const item = refined.get(candidate.id) || { category: candidate.category, text: candidate.text };
            const text = this._cleanText(item.text || candidate.text);
            const category = this._normalizeCategory(item.category || candidate.category, text);
            if (!text) continue;

            this._addProfileItem(category, text, today);
            // 跨天反复出现推翻了 one_off 标签：晋升时清掉，避免下次 decay/导出再当一次性事件
            candidate.one_off = false;
            candidate.status = 'promoted';
            candidate.promoted_at = today;
            promoted += 1;
            this.context.log('info', '[画像] 晋升：' + category + ' / ' + text.slice(0, 30));
        }

        if (promoted > 0) {
            this._profile.updated_at = this._nowIso();
        }

        return promoted;
    }

    async _shouldPromote(candidate) {
        if (!candidate || candidate.status === 'promoted') return false;

        const category = this._normalizeCategory(candidate.category, candidate.text);
        const count = Number(candidate.count || 0);
        const spanDays = this._daysBetween(candidate.first_seen, candidate.last_seen);

        // 2026-11-21 审计 P1：一次性事件绝不能晋升成永久画像/事实。
        // 原来 fact 类别 count>=1 就晋级（见下），于是「今天下午三点开会」第二天就成了
        // 「稳定事实」；实测 25 条事实里 24 条是一次性事件。现在：
        //   · one_off 默认不晋升（连 self_declared 也不绕开）；
        //   · 只有**跨天反复出现**（≥ promote_count 次且 ≥ promote_span_days 天）才推翻标签。
        if (candidate.one_off) {
            const repeated = count >= this._numberCfg('promote_count', 3)
                && spanDays >= this._numberCfg('promote_span_days', 3);
            if (!repeated) {
                this.context.log('info', '[画像] 一次性观察不晋升（one_off, count=' + count
                    + ', span=' + spanDays + 'd）：' + String(candidate.text || '').slice(0, 30));
                return false;
            }
        }

        if (candidate.self_declared) return true;

        if (category === 'fact') return count >= 1;
        if (category === 'like' || category === 'dislike' || category === 'relationship') return count >= 2;

        const localPromote = count >= this._numberCfg('promote_count', 3)
            && spanDays >= this._numberCfg('promote_span_days', 3);
        if (localPromote) return true;

        const source = String(this._cfg.recurrence_source || 'hybrid').toLowerCase();
        if (source === 'local') return false;
        if (source === 'memos' || source === 'hybrid') {
            return await this._memosSupportsCandidate(candidate);
        }

        return false;
    }

    async _memosSupportsCandidate(candidate) {
        const apiUrl = this._trimTrailingSlash(this._cfg.memos_api_url || 'http://127.0.0.1:8003');
        try {
            const { data } = await axios.post(`${apiUrl}/search`, {
                query: `关于主人的长期习惯、偏好或特点：${candidate.text}`,
                top_k: 8,
                user_id: USER_ID,
                similarity_threshold: 0.45
            }, { timeout: 5000 });

            const memories = Array.isArray(data.memories) ? data.memories : [];
            if (memories.length === 0) return false;

            const mergeMax = memories.reduce((max, mem) => {
                const pl = mem && typeof mem.payload === 'object' ? mem.payload : {};
                return Math.max(max, Number(mem.merge_count || pl.merge_count || 0));
            }, 0);

            const dates = memories
                .map(mem => mem.created_at || mem.timestamp || (mem.payload && (mem.payload.created_at || mem.payload.timestamp)))
                .map(ts => this._dateOnly(ts))
                .filter(Boolean)
                .sort();

            const span = dates.length >= 2 ? this._daysBetween(dates[0], dates[dates.length - 1]) : 0;
            const enoughMerge = mergeMax >= this._numberCfg('promote_count', 3);
            const enoughDistinctHits = memories.length >= this._numberCfg('promote_count', 3)
                && span >= this._numberCfg('promote_span_days', 3);

            candidate.memos_support = {
                checked_at: this._nowIso(),
                hit_count: memories.length,
                merge_count: mergeMax,
                span_days: span
            };

            return enoughMerge || enoughDistinctHits;
        } catch (_) {
            return false;
        }
    }

    async _refinePromotionTexts(candidates) {
        const result = new Map();
        const prompt = `你是用户画像编辑器。请把以下已达晋升条件的候选观察润色为简洁、稳定、长期的画像条目。

要求：
- 只输出 JSON，不要解释。
- 保留候选 id。
- text 用一句自然中文，不要带"可能"、"今天"、"刚才"等一次性表述。
- category 只能是 habit、trait、like、dislike、fact、relationship。

候选：
${JSON.stringify(candidates.map(c => ({
    id: c.id,
    category: c.category,
    text: c.text,
    count: c.count,
    first_seen: c.first_seen,
    last_seen: c.last_seen,
    self_declared: c.self_declared,
    memos_support: c.memos_support
})), null, 2)}

输出格式：
{"items":[{"id":"...","category":"habit","text":"..."}]}`;

        try {
            const response = await this._callProfileLLM(prompt, { temperature: 0.1 });
            const parsed = this._parseJsonObject(response);
            const items = Array.isArray(parsed.items) ? parsed.items : [];
            for (const item of items) {
                if (item && item.id && item.text) {
                    result.set(item.id, {
                        category: this._normalizeCategory(item.category, item.text),
                        text: this._cleanText(item.text)
                    });
                }
            }
        } catch (err) {
            this.context.log('warn', `画像晋升润色失败，使用候选原文: ${err.message}`);
        }

        return result;
    }

    // ===== Profile LLM =====

    async _callProfileLLM(prompt, options = {}) {
        const withMeta = options.withMeta === true;
        const wrap = (text, finishReason) => (withMeta
            ? { text: String(text || ''), finishReason: String(finishReason || '') }
            : String(text || ''));
        const primary = this._cfg.profile_llm || {};
        const hasDedicated = primary.model && primary.api_key && primary.base_url;

        if (!hasDedicated) {
            const opts = {
                temperature: options.temperature ?? 0.2,
                max_tokens: this._numberValue(options.max_tokens,
                    this._numberValue(primary.max_tokens, PROFILE_PROMPT_MAX_TOKENS))
            };
            if (options.schema === 'observations') opts.response_format = this._profileResponseFormat();
            let out;
            try {
                out = await this.context.callLLM(prompt, opts);
            } catch (err) {
                if (!this._isSchemaRejected(err) || !opts.response_format) throw err;
                this._warnSchemaUnsupported('主对话模型');
                const relaxed = Object.assign({}, opts);
                delete relaxed.response_format;
                out = await this.context.callLLM(prompt, relaxed);
            }
            // context.callLLM 只回字符串（拿不到 finish_reason）。空返回的重试交给
            // _extractCandidates 的「更紧凑 prompt」路径；这里保留旧的一次同 prompt 重试，
            // 仅用于非分析调用（润色/冷启动），避免它们因偶发空正文直接失败。
            if (!withMeta && !String(out || '').trim()) {
                await new Promise((r) => setTimeout(r, 1500));
                out = await this.context.callLLM(prompt, { ...opts, temperature: (opts.temperature ?? 0.2) + 0.1 });
            }
            if (!withMeta && !String(out || '').trim()) throw new Error('LLM 返回为空（重试后仍空：多为模型只回思考不回正文或额度受限）');
            return wrap(out, '');
        }

        const configs = [primary];
        const fallback = this._cfg.profile_llm_fallback || {};
        if (fallback.enabled && fallback.model && fallback.api_key && fallback.base_url) {
            configs.push({
                ...fallback,
                max_tokens: this._numberValue(primary.max_tokens, PROFILE_PROMPT_MAX_TOKENS),
                timeout_seconds: primary.timeout_seconds || 120
            });
        }

        let lastError = null;
        for (const cfg of configs) {
            const timeouts = [this._numberValue(cfg.timeout_seconds, 120), this._numberValue(cfg.timeout_seconds, 120) * 2];
            for (const timeoutSeconds of timeouts) {
                const payload = this._buildChatPayload(cfg, prompt, options);
                try {
                    const { data } = await axios.post(
                        `${this._trimTrailingSlash(cfg.base_url)}/chat/completions`,
                        payload,
                        {
                            headers: {
                                Authorization: `Bearer ${cfg.api_key}`,
                                'Content-Type': 'application/json'
                            },
                            timeout: timeoutSeconds * 1000
                        }
                    );
                    const choice = data.choices?.[0] || {};
                    return wrap(choice.message?.content || '', choice.finish_reason || '');
                } catch (err) {
                    // 服务端不认 response_format（老 llama.cpp / 兼容层会直接 400）：
                    // 去掉结构化约束再试一次，只 warn 一次，不让画像链路永久停摆。
                    if (payload.response_format && this._isSchemaRejected(err)) {
                        this._warnSchemaUnsupported(cfg.model || '画像模型');
                        payload.response_format = undefined;
                        try {
                            const { data } = await axios.post(
                                `${this._trimTrailingSlash(cfg.base_url)}/chat/completions`,
                                payload,
                                {
                                    headers: {
                                        Authorization: `Bearer ${cfg.api_key}`,
                                        'Content-Type': 'application/json'
                                    },
                                    timeout: timeoutSeconds * 1000
                                }
                            );
                            const choice = data.choices?.[0] || {};
                            return wrap(choice.message?.content || '', choice.finish_reason || '');
                        } catch (err2) {
                            lastError = err2;
                            this.context.log('warn', `画像模型调用失败 (${cfg.model}, ${timeoutSeconds}s): ${err2.message}`);
                            continue;
                        }
                    }
                    lastError = err;
                    this.context.log('warn', `画像模型调用失败 (${cfg.model}, ${timeoutSeconds}s): ${err.message}`);
                }
            }
        }

        // P0-2（2026-11-25）：画像专用 axios 不走 plugin-context.callLLM 的 catch，
        // 网络/超时（无 HTTP 状态码）失败在这里补一次 llm-health 记账 —— 否则后台
        // ensureCanRun 看不到失败，每个周期继续撞。只在**重试全部用尽**后记一次。
        try { require('../../../js/api-utils.js').noteLlmNetworkFailure(lastError); } catch (e) { /* 记账失败不影响抛错 */ }

        throw lastError || new Error('画像模型调用失败');
    }

    _profileResponseFormat() {
        return {
            type: 'json_schema',
            json_schema: { name: 'profile_observations', strict: true, schema: OBSERVATIONS_SCHEMA }
        };
    }

    /** 只认 4xx + 文案提到 schema/response_format 的拒绝（网络超时/429 不算）。 */
    _isSchemaRejected(err) {
        const status = Number(err && (err.status || (err.response && err.response.status))) || 0;
        if (!(status >= 400 && status < 500)) return false;
        const text = String((err && err.message) || '') + ' ' + String((err && err.body) || '');
        return /response_format|json_schema|json schema|grammar|schema/i.test(text);
    }

    _warnSchemaUnsupported(who) {
        if (this._schemaWarned) return;
        this._schemaWarned = true;
        this.context.log('warn', `[画像] ${who}不支持 response_format/json_schema，已降级为纯 prompt 约束（只记一次）`);
    }

    _buildChatPayload(cfg, prompt, options) {
        const payload = {
                            model: cfg.model,
                            messages: [{ role: 'user', content: prompt }],
                            temperature: options.temperature ?? 0.2,
                            max_tokens: this._numberValue(options.max_tokens,
                                this._numberValue(cfg.max_tokens, PROFILE_PROMPT_MAX_TOKENS))
        };

        if (options.schema === 'observations') payload.response_format = this._profileResponseFormat();

        if (cfg.thinking_mode) {
            payload.thinking = { type: String(cfg.thinking_mode) };
        }

        return payload;
    }

    // ===== Storage =====

    _loadProfile() {
        const existed = fs.existsSync(this._profilePath);
        const loaded = this._readJson(this._profilePath, DEFAULT_PROFILE);
        this._profile = this._normalizeProfile(loaded);
        // 2026-11-21：隔离区只做留档，不注入；启动时把条数写进日志便于核对。
        const quarantined = this._quarantinedCount();
        if (quarantined) {
            this.context.log('info', `用户画像隔离区：${quarantined} 条已隔离（不参与提示词注入；node _probe/profile-restore.cjs --all 可还原）`);
        }
        if (!existed) this._saveProfile();
    }

    _quarantinedCount() {
        const list = this._profile && this._profile.quarantined;
        return Array.isArray(list) ? list.filter(item => item && item.text).length : 0;
    }

    _loadCandidates() {
        const existed = fs.existsSync(this._candidatePath);
        const loaded = this._readJson(this._candidatePath, DEFAULT_CANDIDATES);
        this._candidateStore = this._normalizeCandidates(loaded);
        if (!existed) this._saveCandidates();
    }

    _saveProfile() {
        this._writeJson(this._profilePath, this._profile);
    }

    _saveCandidates() {
        this._candidateStore.updated_at = this._nowIso();
        this._compactCandidateStore();
        this._writeJson(this._candidatePath, this._candidateStore);
    }

    _readJson(filePath, fallback) {
        try {
            if (!fs.existsSync(filePath)) return this._clone(fallback);
            const raw = fs.readFileSync(filePath, 'utf-8').trim();
            if (!raw) return this._clone(fallback);
            return JSON.parse(raw);
        } catch (err) {
            this.context.log('warn', `读取 JSON 失败 (${filePath}): ${err.message}`);
            return this._clone(fallback);
        }
    }

    _writeJson(filePath, data) {
        // 原子写（2026-11-24）：原来 writeFileSync 直写目标文件，进程被杀会留半截 JSON；
        // 走 json-store：tmp + rename，且损坏过的文件拒绝写回（不让空数据覆盖残骸）。
        jsonStore.writeJson(filePath, data, { pretty: true });
    }

    _normalizeProfile(profile) {
        const next = {
            ...this._clone(DEFAULT_PROFILE),
            ...(profile || {})
        };
        next.traits = this._limitItems(next.traits);
        next.habits = this._limitItems(next.habits);
        next.facts = this._limitItems(next.facts);
        next.relationships = this._limitItems(next.relationships);
        next.preferences = next.preferences && typeof next.preferences === 'object' ? next.preferences : {};
        next.preferences.likes = this._limitItems(next.preferences.likes);
        next.preferences.dislikes = this._limitItems(next.preferences.dislikes);
        next._meta = next._meta && typeof next._meta === 'object' ? next._meta : { items: {} };
        next._meta.items = next._meta.items && typeof next._meta.items === 'object' ? next._meta.items : {};
        // 2026-11-21：隔离区是留档数据，原样保留（有则保留、无则不新建），
        // 不改条目、不参与 _refreshRenderedProfile；restore 依赖原字段与 index。
        if (Array.isArray(next.quarantined)) {
            next.quarantined = next.quarantined.filter(item => item && typeof item === 'object' && item.text);
        } else {
            delete next.quarantined;
        }
        next.version = 1;
        return next;
    }

    _normalizeCandidates(store) {
        const next = {
            ...this._clone(DEFAULT_CANDIDATES),
            ...(store || {})
        };
        next.candidates = Array.isArray(next.candidates) ? next.candidates : [];
        next.archived = Array.isArray(next.archived) ? next.archived : [];
        next.candidates = next.candidates.map(c => ({
            id: c.id || this._candidateId(c.category, c.text),
            category: this._normalizeCategory(c.category, c.text),
            text: this._cleanText(c.text),
            count: Math.max(0, Number(c.count || 0)),
            first_seen: c.first_seen || this._today(),
            last_seen: c.last_seen || this._today(),
            last_counted_day: c.last_counted_day || '',
            self_declared: Boolean(c.self_declared),
            // 2026-11-24：one_off 原来没被 normalize 带过来 → 每次加载都把「一次性事件」标签丢掉
            one_off: Boolean(c.one_off),
            status: c.status || 'candidate',
            evidence: Array.isArray(c.evidence) ? c.evidence.slice(-10) : [],
            memos_support: c.memos_support || null,
            promoted_at: c.promoted_at || undefined
        })).filter(c => c.text);
        this._candidateStore = next;
        this._compactCandidateStore();
        return this._candidateStore;
    }

    _compactCandidateStore() {
        if (!this._candidateStore) return;

        const maxCandidates = Math.max(1, this._numberCfg('max_candidates', 200));
        // 2026-11-24：归档上限统一走 _archiveMax()（archive_max 优先，默认 500）
        const maxArchived = this._archiveMax();
        const today = this._today();

        const sortByFreshness = (a, b) => {
            const ad = new Date(a.last_seen || a.promoted_at || a.first_seen || a.archived_at || 0).getTime() || 0;
            const bd = new Date(b.last_seen || b.promoted_at || b.first_seen || b.archived_at || 0).getTime() || 0;
            const ac = Number(a.count || 0);
            const bc = Number(b.count || 0);
            return (bd - ad) || (bc - ac);
        };

        const byId = new Map();
        for (const candidate of Array.isArray(this._candidateStore.candidates) ? this._candidateStore.candidates : []) {
            const id = candidate.id || this._candidateId(candidate.category, candidate.text);
            const prev = byId.get(id);
            if (!prev || sortByFreshness(candidate, prev) < 0) {
                byId.set(id, { ...candidate, id });
            }
        }

        const sorted = Array.from(byId.values()).sort(sortByFreshness);
        const kept = sorted.slice(0, maxCandidates);
        const overflow = sorted.slice(maxCandidates).map(candidate => ({
            ...candidate,
            status: 'archived',
            archived_at: today,
            archived_reason: 'candidate_capacity'
        }));

        const archived = [
            ...(Array.isArray(this._candidateStore.archived) ? this._candidateStore.archived : []),
            ...overflow
        ].sort(sortByFreshness).slice(0, maxArchived);

        this._candidateStore.candidates = kept;
        this._candidateStore.archived = archived;
    }

    _refreshRenderedProfile() {
        // 2026-11-21：只从活跃列表（traits/habits/preferences/facts/relationships）
        // 拼注入文本；顶层 quarantined 故意不读——隔离区不注入。
        //
        // 2026-11-24 ADR-014 轨道 2-8：system 里的画像**每字段只放前 max_items_per_field 条**
        // （默认 10，仍可配）。完整画像不删、不变，继续由 `profile view` 工具提供。
        // 为什么要分开：_limitItems 是**存储**裁剪（默认 20，别跟着降，否则会删真数据）；
        // 这里只是**渲染**预算，省的是每次请求的 system token。
        const maxPerField = this._renderMaxItems();
        this._renderedProfile = this._buildProfileText(maxPerField, true);
    }

    /** 渲染预算：system 注入每字段条数（默认 10）。 */
    _renderMaxItems() {
        // ADR-014：默认 20→10。⚠ 旧版 plugin_config.json 里 value 仍是出厂默认 20，
        // 那不是「用户选择」——按未配置处理（否则这个降预算在真机上静默失效）。
        // 用户把它改成任何**非 20** 的数才按用户的来（仍可配，含调大）。
        const v = Number(this._cfg && this._cfg.max_items_per_field);
        if (Number.isFinite(v) && v > 0 && v !== 20) return Math.floor(v);
        return 10;
    }

    /** 取前 n 条（不修改原数组，不写盘）。 */
    _headItems(items, n) {
        const arr = Array.isArray(items) ? items : [];
        if (!Number.isFinite(n) || n >= arr.length) return arr.slice();
        return arr.slice(0, n);
    }

    /**
     * 拼画像文本。
     * @param {number} maxPerField 每字段最多渲染几条（Infinity = 全量，给 profile 工具用）
     * @param {boolean} withHint   是否追加「更多细节用 profile 工具查看」的提示
     */
    _buildProfileText(maxPerField, withHint) {
        const p = this._profile || {};
        const prefs = (p.preferences && typeof p.preferences === 'object') ? p.preferences : {};
        const traits = Array.isArray(p.traits) ? p.traits : [];
        const habits = Array.isArray(p.habits) ? p.habits : [];
        const likes = Array.isArray(prefs.likes) ? prefs.likes : [];
        const dislikes = Array.isArray(prefs.dislikes) ? prefs.dislikes : [];
        const facts = Array.isArray(p.facts) ? p.facts : [];
        const relationships = Array.isArray(p.relationships) ? p.relationships : [];

        const parts = [];
        if (p.name) parts.push(`姓名: ${p.name}`);
        if (p.nickname) parts.push(`称呼/昵称: ${p.nickname}`);
        if (traits.length) parts.push(`性格/做派:\n${this._headItems(traits, maxPerField).map(x => `- ${x}`).join('\n')}`);
        if (habits.length) parts.push(`长期习惯/行为模式:\n${this._headItems(habits, maxPerField).map(x => `- ${x}`).join('\n')}`);
        if (likes.length || dislikes.length) {
            const prefsOut = [];
            if (likes.length) prefsOut.push(`喜欢: ${this._headItems(likes, maxPerField).join('；')}`);
            if (dislikes.length) prefsOut.push(`不喜欢: ${this._headItems(dislikes, maxPerField).join('；')}`);
            parts.push(`稳定偏好:\n${prefsOut.map(x => `- ${x}`).join('\n')}`);
        }
        if (facts.length) parts.push(`稳定事实:\n${this._headItems(facts, maxPerField).map(x => `- ${x}`).join('\n')}`);
        if (relationships.length) parts.push(`重要关系:\n${this._headItems(relationships, maxPerField).map(x => `- ${x}`).join('\n')}`);

        if (!parts.length) return '';
        let text = `【用户画像 - 主人长期以来的习惯/性格/偏好，自然融入对话，勿照搬原文】\n${parts.join('\n')}`;
        // 有字段被裁才提示（没有裁剪就不加冗余句，省 token）
        const counts = [traits.length, habits.length, likes.length, dislikes.length, facts.length, relationships.length];
        const truncated = Number.isFinite(maxPerField) && counts.some(c => c > maxPerField);
        if (withHint && truncated) {
            text += `\n（这里每字段只放前 ${maxPerField} 条；更多细节用 profile 工具查看` +
                `（traits ${traits.length} / habits ${habits.length} / 偏好 ${likes.length + dislikes.length}` +
                ` / facts ${facts.length} / 关系 ${relationships.length}））`;
        }
        return text;
    }

    _watchFiles() {
        this._unwatchFiles();
        for (const filePath of [this._profilePath, this._candidatePath]) {
            try {
                const dir = path.dirname(filePath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                const base = path.basename(filePath);
                const watcher = fs.watch(dir, (eventType, filename) => {
                    if (filename !== base) return;
                    clearTimeout(this._watchDebounce);
                    this._watchDebounce = setTimeout(() => {
                        this._loadProfile();
                        this._loadCandidates();
                        this._refreshRenderedProfile();
                        this.context.log('info', '用户画像文件已变更，已重新加载');
                    }, 500);
                });
                this._watchers.push(watcher);
            } catch (err) {
                this.context.log('warn', `无法监听画像文件: ${err.message}`);
            }
        }
    }

    _unwatchFiles() {
        for (const watcher of this._watchers) {
            try { watcher.close(); } catch (_) { try { __silentAudit.audit('index.js:735', _); } catch (e2) {} }
        }
        this._watchers = [];
    }

    // ===== Prompts =====

    _buildBootstrapPrompt(memories, preferences, graph) {
        return `你是用户画像诊断器。请基于大肥鱼的长期记忆，为"主人"生成一份长期稳定用户画像。

原则：
- 只提炼长期稳定的习惯、行为模式、性格做派、稳定偏好、稳定事实和重要关系。
- 忽略当天/一次性/偶发事件。
- 如果证据不足，宁可留空，不要猜测。
- 只输出 JSON，不要 markdown，不要解释。

输出 JSON 结构：
{
  "name": "",
  "nickname": "",
  "traits": [],
  "habits": [],
  "preferences": { "likes": [], "dislikes": [] },
  "facts": [],
  "relationships": []
}

长期记忆（已按 importance、merge_count、时间跨度筛选）：
${JSON.stringify(memories, null, 2)}

结构化偏好：
${JSON.stringify(preferences, null, 2)}

关系图谱摘要（可为空）：
${JSON.stringify(graph, null, 2)}`;
    }

    _buildCandidatePrompt(recentMessages, options = {}) {
        const opts = options || {};
        const caps = Object.assign({}, PROFILE_PROMPT_CATEGORY_CAPS, opts.caps || {});
        const messageLimit = Math.max(1, Number(opts.messageLimit) || this._numberCfg('max_context_messages', 40));
        const profile = this._buildCompactProfile(caps);
        const candidateSummary = this._compactCandidateSummary();

        const head = `你是用户画像观察器。请从最近对话中提取"可能值得长期跟踪"的用户观察，输出候选观察，不要直接判断它已是长期画像。

重要原则：
- 只提取与主人长期画像有关的观察：habit(习惯/行为模式)、trait(性格/做派)、like、dislike、fact(稳定事实)、relationship。
- 一次性事件也可以作为候选，但必须标注 one_off=true；不要把"今天/刚才/这次"说成长期。
- 如果主人明确说"我一直/经常/习惯/每天/通常/基本都..."，self_declared=true。
- 如果观察与已有候选相同，请填写 match_id；否则 match_id=null。
- 如发现某个正式画像项已被明确否定/取代，可填写 obsolete_profile_text。
- 只输出 JSON，不要 markdown，不要解释。

已有正式画像（紧凑版：按最近出现排序，单条 ≤${PROFILE_PROMPT_ITEM_MAX} 字）：
`;

        const tail = `

输出格式（category 必须填**一个**词，从下面 6 个里选一个，不要照抄整行、不要带竖线/逗号）：
{
  "observations": [
    {
      "match_id": "已有候选id或null",
      "category": "habit",
      "text": "简洁观察",
      "evidence": "触发该观察的短证据",
      "one_off": false,
      "self_declared": false,
      "obsolete_profile_text": ""
    }
  ]
}`;

        const labelCandidates = '\n\n已有候选池摘要：\n';
        const labelMessages = '\n\n最近对话（旧→新）：\n';

        const msgs = (Array.isArray(recentMessages) ? recentMessages : [])
            .slice(-messageLimit)
            .map(m => ({
                role: m && m.role === 'assistant' ? '她' : '主人',
                text: this._truncatePromptText(m && m.content, PROFILE_PROMPT_MESSAGE_MAX)
            }))
            .filter(m => m.text);

        const dropped = [];
        const compose = () => {
            const profileText = JSON.stringify(profile);
            const candidateText = JSON.stringify(candidateSummary);
            const msgText = msgs.map(m => `${m.role}：${m.text}`).join('\n');
            return head + profileText + labelCandidates + candidateText + labelMessages + msgText + tail;
        };

        let prompt = compose();

        // ① 超预算 → 先丢候选摘要（辅助信息：插件侧 _findCandidateForObservation 还会模糊匹配，
        //    丢 match_id 只会多出一条候选，不会丢观察；而 30 条摘要能占 3KB+）。
        while (prompt.length > PROFILE_PROMPT_MAX_CHARS && candidateSummary.length) {
            candidateSummary.pop();
            if (!dropped.includes('candidates')) dropped.push('candidates');
            prompt = compose();
        }

        // ② 仍超 → 从最旧的对话丢（保留至少 1 条最新的；对话是当轮分析的输入）。
        while (prompt.length > PROFILE_PROMPT_MAX_CHARS && msgs.length > 1) {
            msgs.shift();
            if (!dropped.includes('messages')) dropped.push('messages');
            prompt = compose();
        }

        // ③ 仍超 → 按优先级丢整个画像类别（fact 最先，habit 最后；habit 是行为模式，最值钱）。
        //    画像是「避免重复晋升」的唯一上下文，比候选摘要更该保住，所以放最后丢。
        for (const cat of PROFILE_PROMPT_DROP_ORDER) {
            if (prompt.length <= PROFILE_PROMPT_MAX_CHARS) break;
            if (cat === 'preference') {
                if (!profile.preferences) continue;
                delete profile.preferences;
            } else {
                const key = cat === 'habit' ? 'habits' : cat + 's';
                if (!profile[key]) continue;
                delete profile[key];
            }
            dropped.push(cat);
            prompt = compose();
        }

        // ④ 最后一道硬闸：单条消息本身超长时截到剩余预算（不把 prompt 撑破）。
        if (prompt.length > PROFILE_PROMPT_MAX_CHARS && msgs.length) {
            const overflow = prompt.length - PROFILE_PROMPT_MAX_CHARS;
            const last = msgs[msgs.length - 1];
            last.text = this._truncatePromptText(last.text, Math.max(1, last.text.length - overflow - 1));
            if (!dropped.includes('messages')) dropped.push('messages');
            prompt = compose();
        }

        this._lastPromptStats = {
            chars: prompt.length,
            tokensEst: Math.ceil(prompt.length / 2.2),   // 中文约 2.2 字符/token（现场 35KB ≈ 15.6K tokens）
            maxTokens: PROFILE_PROMPT_MAX_TOKENS,
            profileChars: JSON.stringify(profile).length,
            candidateChars: JSON.stringify(candidateSummary).length,
            messages: msgs.length,
            dropped
        };
        return prompt;
    }

    /**
     * 紧凑画像：只带「最近/高置信」的 topN，单条 ≤80 字，无缩进。
     * 画像项本身没有 confidence 字段（晋升闸已经做过置信筛选），这里用 `_meta.items.last_seen`
     * 做「最近」排序；没有 meta 的旧条目按出现顺序兜底（越靠后越新）。
     */
    _buildCompactProfile(caps = {}) {
        const c = Object.assign({}, PROFILE_PROMPT_CATEGORY_CAPS, caps || {});
        const out = {};
        if (this._profile.name) out.name = this._truncatePromptText(this._profile.name, 40);
        if (this._profile.nickname) out.nickname = this._truncatePromptText(this._profile.nickname, 40);

        const habits = this._promptItems('habits', c.habit);
        if (habits.length) out.habits = habits;

        // preference 的 15 条是 likes+dislikes **合计**：混排后按最近出现取前 15，再拆回两组。
        const prefs = [];
        for (const [field, tag] of [['preferences.likes', '喜欢'], ['preferences.dislikes', '不喜欢']]) {
            for (const item of this._promptItemObjects(field)) prefs.push(Object.assign({}, item, { tag }));
        }
        prefs.sort((a, b) => (b.at - a.at) || (a.idx - b.idx));
        const prefTop = prefs.slice(0, Math.max(0, Number(c.preference) || 0));
        if (prefTop.length) {
            out.preferences = {
                likes: prefTop.filter(x => x.tag === '喜欢').map(x => x.text),
                dislikes: prefTop.filter(x => x.tag === '不喜欢').map(x => x.text)
            };
        }

        const traits = this._promptItems('traits', c.trait);
        if (traits.length) out.traits = traits;
        const facts = this._promptItems('facts', c.fact);
        if (facts.length) out.facts = facts;
        const rel = this._promptItems('relationships', PROFILE_PROMPT_RELATION_LIMIT);
        if (rel.length) out.relationships = rel;
        return out;
    }

    _promptItems(field, limit) {
        return this._promptItemObjects(field)
            .slice(0, Math.max(0, Number(limit) || 0))
            .map(x => x.text);
    }

    _promptItemObjects(field) {
        const list = this._getProfileList(field) || [];
        const meta = (this._profile._meta && this._profile._meta.items) || {};
        const out = [];
        list.forEach((text, idx) => {
            const s = String(text || '').trim();
            if (!s) return;
            const m = meta[this._profileMetaKey(field, text)] || {};
            const at = Date.parse(String(m.last_seen || m.promoted_at || '')) || 0;
            out.push({ text: this._truncatePromptText(s, PROFILE_PROMPT_ITEM_MAX), at, idx });
        });
        return out.sort((a, b) => (b.at - a.at) || (a.idx - b.idx));
    }

    _compactCandidateSummary() {
        const candidates = (this._candidateStore && Array.isArray(this._candidateStore.candidates))
            ? this._candidateStore.candidates
            : [];
        return candidates
            .filter(c => c && c.status !== 'archived')
            .slice(-PROFILE_PROMPT_CANDIDATE_MAX)
            .map(c => ({
                id: c.id,
                category: c.category,
                text: this._truncatePromptText(c.text, PROFILE_PROMPT_CANDIDATE_TEXT_MAX),
                count: c.count,
                last_seen: c.last_seen
            }));
    }

    _truncatePromptText(text, max) {
        const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
        const n = Math.max(1, Number(max) || PROFILE_PROMPT_ITEM_MAX);
        return s.length > n ? s.slice(0, n - 1) + '…' : s;
    }

    // ===== MemOS =====

    async _memosHealth(apiUrl) {
        try {
            const { data } = await axios.get(`${apiUrl}/health`, { timeout: 2000 });
            return data.status === 'healthy';
        } catch (_) {
            return false;
        }
    }

    async _fetchMemosMemories(apiUrl) {
        try {
            const { data } = await axios.get(`${apiUrl}/list`, {
                params: { user_id: USER_ID, limit: 0 },
                timeout: 15000
            });
            return Array.isArray(data.memories) ? data.memories : [];
        } catch (err) {
            this.context.log('warn', `拉取 MemOS 记忆失败: ${err.message}`);
            return [];
        }
    }

    async _fetchMemosPreferences(apiUrl) {
        try {
            const { data } = await axios.get(`${apiUrl}/preferences`, {
                params: { user_id: USER_ID },
                timeout: 8000
            });
            return Array.isArray(data.preferences) ? data.preferences : [];
        } catch (err) {
            this.context.log('warn', `拉取 MemOS 偏好失败: ${err.message}`);
            return [];
        }
    }

    async _fetchMemosGraph(apiUrl) {
        try {
            const [entities, relations] = await Promise.all([
                axios.get(`${apiUrl}/graph/entities`, { timeout: 5000 }),
                axios.get(`${apiUrl}/graph/relations`, { timeout: 5000 })
            ]);
            return {
                entities: entities.data.entities || entities.data || [],
                relations: relations.data.relations || relations.data || []
            };
        } catch (_) {
            return { entities: [], relations: [] };
        }
    }

    _selectBootstrapMemories(memories) {
        const max = this._numberCfg('bootstrap_max_memories', 200);
        return memories
            .map(mem => ({
                id: mem.id,
                content: mem.content,
                importance: Number(mem.importance || 0),
                merge_count: Number(mem.merge_count || 0),
                memory_type: mem.memory_type || 'general',
                created_at: mem.created_at || mem.timestamp,
                tags: mem.tags || []
            }))
            .filter(mem => mem.content)
            .sort((a, b) => this._memoryBootstrapScore(b) - this._memoryBootstrapScore(a))
            .slice(0, max);
    }

    _memoryBootstrapScore(mem) {
        const importance = Math.min(1, Math.max(0, Number(mem.importance || 0))) * 3;
        const merge = Math.min(5, Number(mem.merge_count || 0)) * 1.5;
        const typeBonus = ['preference', 'fact', 'semantic'].includes(mem.memory_type) ? 1 : 0;
        return importance + merge + typeBonus;
    }

    // ===== Decay =====

    _decayCandidates() {
        const ttl = this._numberCfg('candidate_ttl_days', 30);
        const today = this._today();
        let changed = false;

        const kept = [];
        for (const candidate of this._candidateStore.candidates) {
            if (candidate.status === 'promoted') {
                kept.push(candidate);
                continue;
            }

            const staleDays = this._daysBetween(candidate.last_seen, today);
            if (staleDays > ttl) {
                this._candidateStore.archived.push({
                    ...candidate,
                    status: 'archived',
                    archived_at: today,
                    archived_reason: 'candidate_ttl'
                });
                changed = true;
            } else {
                kept.push(candidate);
            }
        }
        if (changed) this._candidateStore.candidates = kept;

        // 2026-11-24：已晋升条目超龄归档（候选池只增不减，§9.3-⑨）
        const archivedPromoted = this._archivePromotedCandidates();
        if (changed || archivedPromoted) {
            this._saveCandidates();
        }
        return changed || archivedPromoted;
    }

    /** archived 上限：新配置 archive_max 优先；兼容旧键 max_archived_candidates。默认 500。 */
    _archiveMax() {
        const legacy = this._numberCfg('max_archived_candidates', 500);
        return Math.max(0, this._numberCfg('archive_max', legacy));
    }

    /** 归档条目只留最小字段（id/category/text/status/promoted_at/last_seen + 归档元信息）。 */
    _minimalArchived(candidate, today, reason) {
        return {
            id: candidate.id || this._candidateId(candidate.category, candidate.text),
            category: this._normalizeCategory(candidate.category, candidate.text),
            text: this._cleanText(candidate.text),
            status: 'archived',
            promoted_at: candidate.promoted_at || '',
            last_seen: candidate.last_seen || '',
            archived_at: today,
            archived_reason: reason,
        };
    }

    /**
     * 已晋升条目归档（2026-11-24，§9.3-⑨）：
     *   promoted 且 (last_seen 或 promoted_at) 距今 > archive_after_days（默认 30）→ 移入 archived。
     *   只动候选池，**不动画像本体** —— 归档的是「晋升证据链」，画像里的条目照常注入。
     * @returns {boolean} 是否有改动
     */
    _archivePromotedCandidates() {
        const days = Math.max(1, this._numberCfg('archive_after_days', 30));
        const today = this._today();
        const kept = [];
        const moved = [];

        for (const candidate of Array.isArray(this._candidateStore.candidates) ? this._candidateStore.candidates : []) {
            if (!candidate || candidate.status !== 'promoted') {
                kept.push(candidate);
                continue;
            }
            const anchor = candidate.last_seen || candidate.promoted_at || candidate.first_seen || '';
            if (!anchor || this._daysBetween(anchor, today) <= days) {
                kept.push(candidate);
                continue;
            }
            moved.push(this._minimalArchived(candidate, today, 'promoted_stale'));
        }

        if (!moved.length) return false;
        this._candidateStore.candidates = kept;
        this._candidateStore.archived = this._mergeArchived(this._candidateStore.archived, moved);
        return true;
    }

    /** 归档合并：按 id 去重（保 last_seen 更新的），按新鲜度降序，超 archive_max 丢最旧。 */
    _mergeArchived(existing, incoming) {
        const byId = new Map();
        const freshness = (a) => new Date(a.last_seen || a.promoted_at || a.archived_at || a.first_seen || 0).getTime() || 0;
        for (const item of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
            if (!item || (!item.text && !item.id)) continue;
            const id = item.id || this._candidateId(item.category, item.text);
            const prev = byId.get(id);
            if (!prev || freshness(item) >= freshness(prev)) byId.set(id, { ...item, id });
        }
        return Array.from(byId.values())
            .sort((a, b) => freshness(b) - freshness(a))
            .slice(0, this._archiveMax());
    }

    _decayProfileItems() {
        const staleDays = this._numberCfg('profile_stale_days', 180);
        const today = this._today();
        const meta = this._profile._meta?.items || {};
        let changed = false;

        for (const [key, itemMeta] of Object.entries(meta)) {
            // facts 不衰减是**有意**的（2026-11-21 审计复核）：
            // 「我叫什么/我是程序员」不会因为 180 天没复现就变假。一次性事件不再靠这里清理，
            // 而是在晋升前用 one_off 闸挡住（见 _shouldPromote）。
            if (!itemMeta || itemMeta.field === 'facts') continue;
            const lastSeen = itemMeta.last_seen || itemMeta.promoted_at;
            if (!lastSeen || this._daysBetween(lastSeen, today) <= staleDays) continue;

            const removed = this._removeProfileText(itemMeta.field, itemMeta.text);
            if (removed) {
                this._candidateStore.candidates.push({
                    id: this._candidateId(itemMeta.field, itemMeta.text),
                    category: this._fieldToCategory(itemMeta.field),
                    text: itemMeta.text,
                    count: 1,
                    first_seen: today,
                    last_seen: today,
                    last_counted_day: today,
                    self_declared: false,
                    status: 'candidate',
                    evidence: [{ date: today, text: '正式画像长期未复现后软降级回候选池' }]
                });
                delete meta[key];
                changed = true;
            }
        }

        if (changed) {
            this._profile.updated_at = this._nowIso();
            this._saveProfile();
            this._saveCandidates();
            this._refreshRenderedProfile();
        }
    }

    // ===== Profile operations =====

    _addProfileItem(category, text, date = this._today()) {
        const field = CATEGORY_TO_FIELD[this._normalizeCategory(category, text)];
        if (!field || !text) return false;

        const list = this._getProfileList(field);
        if (!list) return false;

        const norm = this._normalizeComparable(text);
        const exists = list.some(item => this._normalizeComparable(item) === norm);
        if (!exists) {
            list.push(text);
            this._setProfileList(field, this._limitItems(list));
        }

        this._touchProfileItem(field, exists ? list.find(item => this._normalizeComparable(item) === norm) : text, date);
        return true;
    }

    _findProfileItem(category, text) {
        const field = CATEGORY_TO_FIELD[this._normalizeCategory(category, text)];
        const list = this._getProfileList(field);
        if (!list) return null;

        const norm = this._normalizeComparable(text);
        const found = list.find(item => {
            const itemNorm = this._normalizeComparable(item);
            return itemNorm === norm || itemNorm.includes(norm) || norm.includes(itemNorm);
        });
        return found ? { field, text: found } : null;
    }

    _touchProfileItem(field, text, date = this._today()) {
        this._profile._meta = this._profile._meta || { items: {} };
        this._profile._meta.items = this._profile._meta.items || {};
        const key = this._profileMetaKey(field, text);
        this._profile._meta.items[key] = {
            field,
            text,
            last_seen: date,
            promoted_at: this._profile._meta.items[key]?.promoted_at || date
        };
    }

    _touchAllProfileItems(profile, date = this._today()) {
        for (const field of ['traits', 'habits', 'facts', 'relationships', 'preferences.likes', 'preferences.dislikes']) {
            const list = this._getProfileListFrom(profile, field);
            for (const text of list) {
                const key = this._profileMetaKey(field, text);
                profile._meta.items[key] = { field, text, last_seen: date, promoted_at: date };
            }
        }
    }

    _applyObservationContradictions(obs) {
        const obsolete = this._cleanText(obs.obsolete_profile_text);
        if (!obsolete) return;
        for (const field of ['traits', 'habits', 'relationships', 'preferences.likes', 'preferences.dislikes']) {
            const removed = this._removeProfileText(field, obsolete);
            if (removed) {
                this.context.log('info', `画像项被新观察取代，已移除: ${obsolete}`);
                this._profile.updated_at = this._nowIso();
                break;
            }
        }
    }

    _removeProfileText(field, text) {
        const list = this._getProfileList(field);
        if (!list) return false;
        const norm = this._normalizeComparable(text);
        const next = list.filter(item => {
            const itemNorm = this._normalizeComparable(item);
            return itemNorm !== norm && !itemNorm.includes(norm) && !norm.includes(itemNorm);
        });
        if (next.length === list.length) return false;
        this._setProfileList(field, next);
        for (const key of Object.keys(this._profile._meta?.items || {})) {
            if (this._profile._meta.items[key].field === field && this._normalizeComparable(this._profile._meta.items[key].text) === norm) {
                delete this._profile._meta.items[key];
            }
        }
        return true;
    }

    _manualUpdate(action, value) {
        const text = this._cleanText(value);
        if (!text) return '错误：未提供有效内容。';

        switch (action) {
            case 'set_name':
                this._profile.name = text;
                break;
            case 'set_nickname':
                this._profile.nickname = text;
                break;
            case 'add_trait':
                this._addProfileItem('trait', text);
                break;
            case 'add_habit':
                this._addProfileItem('habit', text);
                break;
            case 'add_like':
                this._addProfileItem('like', text);
                break;
            case 'add_dislike':
                this._addProfileItem('dislike', text);
                break;
            case 'add_fact':
                this._addProfileItem('fact', text);
                break;
            case 'add_relationship':
                this._addProfileItem('relationship', text);
                break;
            case 'remove':
                for (const field of ['traits', 'habits', 'facts', 'relationships', 'preferences.likes', 'preferences.dislikes']) {
                    this._removeProfileText(field, text);
                }
                break;
            default:
                return `错误：不支持的操作 ${action}`;
        }

        this._profile.updated_at = this._nowIso();
        this._saveProfile();
        this._refreshRenderedProfile();
        return `用户画像已更新：${action} ${text}`;
    }

    async _rebuildProfile() {
        this._profile = this._normalizeProfile({
            ...this._clone(DEFAULT_PROFILE),
            bootstrapped: false
        });
        this._saveProfile();
        this._refreshRenderedProfile();
        this._bootstrap().catch(err => this.context.log('warn', `重新诊断失败: ${err.message}`));
        return '已开始重新诊断用户画像；完成后会写入用户画像.json。';
    }

    _renderProfileForTool() {
        // 工具视图 = **全量**（ADR-014：渲染降到 10/字段，但数据不删，细节从工具取）。
        const full = this._buildProfileText(Infinity, false);
        const quarantined = this._quarantinedCount();
        const tail = quarantined
            ? `\n隔离区: ${quarantined} 条（已移出活跃画像，不参与注入；node _probe/profile-restore.cjs --all 可还原）`
            : '';
        if (!full) return `当前没有已晋升的用户画像。${tail}`;
        return `${full}${tail}\n\n画像文件: ${this._profilePath}\n候选池文件: ${this._candidatePath}`;
    }

    // ===== Helpers =====

    _resetIdleTimer() {
        clearTimeout(this._idleTimer);
        const idleMs = this._numberCfg('idle_time', 180000);
        this._idleTimer = setTimeout(() => {
            this._distill('idle').catch(err => {
                this.context.log('error', `空闲画像分析失败: ${err.message}`);
            });
        }, idleMs);
    }

    _findCandidateForObservation(obs) {
        if (obs.match_id) {
            const found = this._candidateStore.candidates.find(c => c.id === obs.match_id && c.status !== 'archived');
            if (found) return found;
        }

        const norm = this._normalizeComparable(obs.text);
        return this._candidateStore.candidates.find(c => {
            if (c.status === 'archived') return false;
            if (this._normalizeCategory(c.category, c.text) !== obs.category) return false;
            const cNorm = this._normalizeComparable(c.text);
            return cNorm === norm || cNorm.includes(norm) || norm.includes(cNorm);
        });
    }

    /**
     * 在 archived 里找同一观察（类别归一化 + 文本归一化后相同/互相包含）。
     * 归档条目只留最小字段（id/category/text/promoted_at/last_seen），足够比对。
     */
    _findArchivedForObservation(obs) {
        const list = Array.isArray(this._candidateStore.archived) ? this._candidateStore.archived : [];
        const category = this._normalizeCategory(obs.category, obs.text);
        const norm = this._normalizeComparable(obs.text);
        if (!norm) return null;
        return list.find((a) => {
            if (!a || !a.text) return false;
            if (this._normalizeCategory(a.category, a.text) !== category) return false;
            const aNorm = this._normalizeComparable(a.text);
            return aNorm === norm || aNorm.includes(norm) || norm.includes(aNorm);
        }) || null;
    }

    /**
     * 从 archived 复活一条候选（2026-11-24，配合 promoted 超龄归档）。
     * 复活 = 从 archived 移出 + 放回 candidates（保留原 id/promoted_at，证据链不丢），
     * 后续计数/晋升走原有逻辑。这样「归档后再提一次」不会产生同名重复候选。
     * @returns {object|null} 复活后的候选对象（未找到返回 null）
     */
    _reviveArchivedCandidate(obs, today = this._today()) {
        const found = this._findArchivedForObservation(obs);
        if (!found) return null;
        const foundId = found.id || this._candidateId(found.category, found.text);
        this._candidateStore.archived = (this._candidateStore.archived || [])
            .filter((a) => a !== found && (a.id || this._candidateId(a.category, a.text)) !== foundId);
        const revived = {
            id: foundId,
            category: this._normalizeCategory(found.category || obs.category, found.text),
            text: this._cleanText(found.text),
            count: 0,
            first_seen: found.promoted_at || found.last_seen || today,
            last_seen: today,
            last_counted_day: '',
            self_declared: Boolean(obs.self_declared),
            status: 'candidate',
            evidence: [],
            memos_support: null,
            promoted_at: found.promoted_at || undefined,
        };
        this._candidateStore.candidates.push(revived);
        try {
            this.context.log('info', '[画像] 归档条目重新出现，已复活回候选池：' + String(revived.text).slice(0, 30));
        } catch (e) { /* 日志失败不影响主线 */ }
        return revived;
    }

    _normalizeObservation(obs) {
        if (!obs || typeof obs !== 'object') return null;
        const text = this._cleanText(obs.text);
        if (!text) return null;
        return {
            match_id: typeof obs.match_id === 'string' ? obs.match_id : '',
            category: this._normalizeCategory(obs.category, text),
            text,
            evidence: this._cleanText(obs.evidence),
            one_off: Boolean(obs.one_off),
            self_declared: Boolean(obs.self_declared),
            obsolete_profile_text: this._cleanText(obs.obsolete_profile_text)
        };
    }

    /**
     * 把模型给的 category 翻译成 6 个正式类别之一（表驱动，见文件头 CATEGORY_TABLE）。
     * @param {string} category 模型原值（可能是枚举串 / 同义词 / 大小写 / 复数）
     * @param {string} [text] 观察正文 —— preference 需要它才能分 like / dislike
     * @returns {'habit'|'trait'|'like'|'dislike'|'fact'|'relationship'}
     */
    _normalizeCategory(category, text) {
        const raw = String(category == null ? '' : category).trim();

        // ①② 整串先当单 token 查表（"Habit" / "habits" / "identity" / "preferences.likes"）
        const direct = this._resolveCategoryToken(raw, text);
        if (direct) return direct;

        // ③ 枚举串："identity|preference|habit|..." → 取第一个能翻译的 token。
        //    模型抄回来的顺序就是提示词里的顺序，取第一个是**确定**选择（不是碰运气）。
        const tokens = raw.split(CATEGORY_SEPARATORS);
        if (tokens.length > 1) {
            for (const token of tokens) {
                const resolved = this._resolveCategoryToken(token, text);
                if (resolved) return resolved;
            }
        }

        // ④ 兜底 fact，但要留下信号（见 _unknownCategoryOnce）
        return this._unknownCategoryOnce(raw);
    }

    /** 单个 token → 正式类别；查不到返回 null（由调用方决定是否兜底）。 */
    _resolveCategoryToken(token, text) {
        const t = String(token == null ? '' : token)
            .replace(/^[\s"'`[\]()（）【】]+|[\s"'`[\]()（）【】]+$/g, '')
            .toLowerCase();
        if (!t) return null;
        const mapped = CATEGORY_TABLE.get(t);
        if (!mapped) return null;
        if (mapped === 'preference') {
            // 「preference」本身不区分爱憎：正文含明确否定词才算 dislike
            return DISLIKE_TEXT_HINTS.test(String(text || '')) ? 'dislike' : 'like';
        }
        return mapped;
    }

    /**
     * 兜底为 fact，并按原值去重记一次（日志 + telemetry）。
     * 目的：下次模型换了一套枚举能立刻在日志/遥测里看到，而不是静默混进 facts。
     */
    _unknownCategoryOnce(raw) {
        const key = String(raw == null ? '' : raw).trim().toLowerCase().slice(0, 60);
        if (!this._unknownCategories) this._unknownCategories = new Set();
        if (!key || this._unknownCategories.has(key) || this._unknownCategories.size >= UNKNOWN_CATEGORY_LOG_MAX) {
            return 'fact';
        }
        this._unknownCategories.add(key);
        try {
            if (this.context && typeof this.context.log === 'function') {
                this.context.log('warn', '画像类别未识别，已按 fact 兜底: ' + JSON.stringify(key));
            }
        } catch (e) { /* 日志失败不影响归一化 */ }
        try {
            const { emitTelemetry } = require('../../../js/core/telemetry.js');
            emitTelemetry({
                cat: 'profile',
                type: 'profile.category_unknown',
                title: '画像类别未识别: ' + key,
                level: 'warn',
                source: 'user-profile'
            });
        } catch (e) { /* 遥测不可用不影响归一化 */ }
        return 'fact';
    }

    _fieldToCategory(field) {
        if (field === 'habits') return 'habit';
        if (field === 'traits') return 'trait';
        if (field === 'preferences.likes') return 'like';
        if (field === 'preferences.dislikes') return 'dislike';
        if (field === 'relationships') return 'relationship';
        return 'fact';
    }

    _candidateId(category, text) {
        const normalized = this._normalizeCategory(category, text);
        const hash = crypto.createHash('sha1')
            .update(`${normalized}:${this._normalizeComparable(text)}`)
            .digest('hex')
            .slice(0, 12);
        return `${normalized}:${hash}`;
    }

    _appendEvidence(list, item) {
        const next = Array.isArray(list) ? list.slice() : [];
        next.push(item);
        return next.slice(-10);
    }

    /** 这条证据是否还没记过（同日同文视为重复）。用于避免每轮都把 evidence 改脏。 */
    _isNewEvidence(list, item) {
        const arr = Array.isArray(list) ? list : [];
        const date = String(item && item.date || '');
        const text = String(item && item.text || '');
        return !arr.some((e) => e && String(e.date || '') === date && String(e.text || '') === text);
    }

    _parseJsonObject(response) {
        if (!response) throw new Error('LLM 返回为空');
        let text = String(response).trim();

        if (text.startsWith('```')) {
            text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
        }

        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            text = text.slice(firstBrace, lastBrace + 1);
        }

        try {
            return JSON.parse(text);
        } catch (err) {
            const fixed = this._tryFixJson(text);
            if (fixed) return fixed;
            throw new Error(`JSON 解析失败: ${err.message}`);
        }
    }

    _tryFixJson(text) {
        const trimmed = String(text || '').trim();
        if (!trimmed) return null;
        const openBraces = (trimmed.match(/\{/g) || []).length - (trimmed.match(/\}/g) || []).length;
        const openBrackets = (trimmed.match(/\[/g) || []).length - (trimmed.match(/\]/g) || []).length;
        if (openBraces < 0 || openBrackets < 0) return null;
        const fixed = trimmed + ']'.repeat(openBrackets) + '}'.repeat(openBraces);
        try {
            return JSON.parse(fixed);
        } catch (_) {
            return null;
        }
    }

    _getProfileList(field) {
        return this._getProfileListFrom(this._profile, field);
    }

    _getProfileListFrom(profile, field) {
        if (!field) return null;
        if (field === 'preferences.likes') return profile.preferences?.likes || [];
        if (field === 'preferences.dislikes') return profile.preferences?.dislikes || [];
        return Array.isArray(profile[field]) ? profile[field] : [];
    }

    _setProfileList(field, list) {
        if (field === 'preferences.likes') {
            this._profile.preferences.likes = list;
        } else if (field === 'preferences.dislikes') {
            this._profile.preferences.dislikes = list;
        } else {
            this._profile[field] = list;
        }
    }

    _profileMetaKey(field, text) {
        return crypto.createHash('sha1')
            .update(`${field}:${this._normalizeComparable(text)}`)
            .digest('hex')
            .slice(0, 16);
    }

    _limitItems(items) {
        // 存储裁剪（ADR-014 拆分）：max_items_per_field 现在只管**渲染**（默认 10），
        // 存储上限独立为 max_stored_items_per_field（默认 20，与旧行为一致）。
        // 两者取大：即使有人把渲染调到 30，存储也不会因此从 20 缩到 10 而删数据。
        const storeMax = Math.max(
            this._numberCfg('max_stored_items_per_field', 20),
            this._numberCfg('max_items_per_field', 10)
        );
        const max = Number.isFinite(storeMax) && storeMax > 0 ? Math.floor(storeMax) : 20;
        const seen = new Set();
        const result = [];
        for (const item of Array.isArray(items) ? items : []) {
            const text = this._cleanText(typeof item === 'string' ? item : (item?.text || item?.item || JSON.stringify(item)));
            if (!text) continue;
            const key = this._normalizeComparable(text);
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(text);
            if (result.length >= max) break;
        }
        return result;
    }

    _cleanText(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/\s+/g, ' ').trim();
    }

    _normalizeComparable(text) {
        return this._cleanText(text).toLowerCase().replace(/[，。！？、,.!?；;："“”'‘’\s]/g, '');
    }

    _resolveLivePath(filePath) {
        if (path.isAbsolute(filePath)) return filePath;
        return path.join(LIVE2D_ROOT, filePath);
    }

    _trimTrailingSlash(url) {
        return String(url || '').replace(/\/+$/, '');
    }

    _numberCfg(key, fallback) {
        return this._numberValue(this._cfg[key], fallback);
    }

    _numberValue(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    _nowIso() {
        return new Date().toISOString();
    }

    _today() {
        return this._dateOnly(new Date());
    }

    _dateOnly(value) {
        const d = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(d.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    _daysBetween(a, b) {
        const da = new Date(a);
        const db = new Date(b);
        if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return 0;
        const ms = db.setHours(0, 0, 0, 0) - da.setHours(0, 0, 0, 0);
        return Math.max(0, Math.floor(ms / 86400000));
    }

    _clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    async _withTimeout(promise, ms) {
        let timer;
        try {
            return await Promise.race([
                promise,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('timeout')), ms);
                })
            ]);
        } finally {
            clearTimeout(timer);
        }
    }
}

module.exports = UserProfilePlugin;
