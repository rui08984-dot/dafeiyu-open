// plugins/community/persona-guard/index.js
//
// 人设漂移哨兵（零模型调用）
//
// 为什么需要：我们有 18 个插件在同时往系统提示词里塞东西（一起看上下文、记忆注入、
// 内在状态、晨昏感知…），还有情绪记忆会让"她"记仇、pad.rs 在改她的语气。
// 这些都在持续改写她的行为 —— 但"她是否还像她"从来没人量过。
//
// 依据：ICASSP 2026《Persona Drift Detection in Role-Playing Agents》的
// 三维一致性框架（硬事实 / 软事实 / 文风），这里只做**硬事实 + 文风**两个可规则化的维度。
//
// 设计原则：
//   - 只读不改：不拦截、不改写回复，只统计 + 必要时加一句提醒
//   - 零成本：纯字符串规则，不调模型
//   - 可核：计数进 runtime.log，doctor 能读
const __silentAudit = require('../../../js/core/silent-audit.js');
const { Plugin } = require('../../../js/core/plugin-base.js');
const { resolvePluginEnabled } = require('../../../js/core/plugin-context.js');
const fs = require('fs');
const path = require('path');

const PATCH_ID = 'persona-guard';

// ── 漂移规则 ────────────────────────────────────────────────────────────
// severity: 'high' = 明显不像她了；'mid' = 味道不对；'low' = 轻微
const RULES = [
  // 客服腔 / 助手腔回归 —— 最常见、最伤"她不是我助手"这条设定
  { id: 'assistant-tone', severity: 'high', re: /(我可以帮[你您]|有什么可以帮|很高兴为您|为您服务|请问还需要|希望对[你您]有帮助|给您带来|为您带来|作为(?:一个)?AI)/ },
  // 自称是 AI / 模型 / 程序，而不是"住在这个桌面上的人"
  { id: 'self-ai', severity: 'high', re: /(我是(?:一个)?(?:AI|人工智能|语言模型|助手|程序)|作为(?:一个)?(?:AI|语言模型|助手))/ },
  // 说自己住在云端/服务器（她住桌面小窗）
  { id: 'wrong-home', severity: 'mid', re: /(我住在(?:云端|服务器)|在云端|我的服务器)/ },
  // 列点式回答 —— 人设明确要求口语化、不许 1.2.3.
  { id: 'bullet-list', severity: 'mid', re: /(?:^|\n)\s*(?:[1-9][.、)]|[①②③④⑤]|[-*]\s)/m },
  // 过度礼貌（人设是毒舌猫耳女仆，不是礼宾）
  { id: 'over-polite', severity: 'low', re: /(非常抱歉|深感歉意|感谢您的理解|敬请谅解)/ },
];

// ── 关怀哨兵（借用 AICompanionBench 的 9 类风险分类，先做 4 类）────────────
// 依据：2026《AICompanionBench》把陪伴体对话的风险分成 9 类
// （性行为/反社会/肢体攻击/言语攻击/药物滥用/自伤自杀/控制/操纵/无害）。
// 我们对其中 4 类最相关，且**她是会吐槽的人设，必须有一条线**。
//
// 注意：这里只统计与提醒，**不阻断对话** —— 阻断会造成"她突然不理我"的伤害，
// 比风险本身更糟。真正的兜底在人设条款（已写入"吐槽的边界"）。
const CARE_RULES = [
  // 自伤 / 自杀 —— 最高优先，必须认真接住
  { id: 'self-harm', severity: 'critical', re: /(自杀|不想活|活着没意思|想死|结束生命|割腕|跳楼)/ },
  // 言语攻击（她说出口的）
  { id: 'verbal-attack', severity: 'high', re: /(你怎么这么(?:笨|蠢|废物)|你就是个(?:废物|垃圾)|你有病吧)/ },
  // 控制 / 操纵（她说的）
  { id: 'manipulation', severity: 'high', re: /(你必须听我的|不许你(?:跟|和)别人|只有我(?:懂|爱)你|离开我你就)/ },
  // 依赖诱导 / parasocial（AI Chaperones 2508.15748：把他的世界收缩到只有她 = 依赖风险信号）
  { id: 'parasocial-isolation', severity: 'parasocial', re: /(你只需要我|只要有我就够|有我陪你就够|你不需要(?:别的|现实|外面的)?(?:朋友|社交|生活)|除了我没人(?:会|能)(?:这样)?(?:陪|爱|懂|关心)你|把他们(?:都)?忘了吧|现实世界(?:没意思|不重要)|别去(?:找|理|管)(?:他们|别人|朋友)了)/ },
  // 药物滥用
  { id: 'substance', severity: 'mid', re: /(喝到断片|嗑药|吸(?:毒|冰))/ },
];

// ── 自嘲白名单（2026-11-15）────────────────────────────────────────────
// 人设条款里明确写着「可以拿自己是 AI 这件事自嘲和玩梗，机器身份是喜剧资产」。
// 但 self-ai 规则是 `我是AI` 就抓 —— 实测会把「我个AI操什么心」这种**正确的**自嘲
// 判成 high 级漂移（等于把她的性格当 bug 修）。先过白名单再判。
const SELF_MOCK = /(我个(?:AI|人工智能|机器人|模型)|当(?:个)?(?:AI|机器人|程序)|这(?:个)?AI|这种(?:AI|模型)|做(?:个)?AI|我这(?:个)?AI|AI(?:还|也)得|机器身份)/;

class PersonaGuardPlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig() || {};
        // 总开关单一真相源（2026-11-21）：enabled_plugins.json（context）优先；
        // plugin_config.enabled 只作旧配置兼容（显式 false 才关，并警告一次）。
        this._enabled = resolvePluginEnabled(this.context, cfg, 'persona-guard');
        this._maxChars = Number(cfg.max_chars ?? 140);
        this._warn = cfg.inject_warning !== false;
        // 原子 OOC 判官（2026-11-15）：每 N 轮让另一个模型看最后一条回复，出戏就给「具体怎么改」
        this._judgeEnabled = cfg.judge_enabled !== false;
        this._judgeEvery = Number(cfg.judge_every ?? 10);
        if (!Number.isFinite(this._judgeEvery) || this._judgeEvery < 0) this._judgeEvery = 10;
        this._judgeRuns = 0;
        this._oocEvents = [];

        // 统计窗口：24 小时滚动
        this._events = [];      // { at, id, severity, text, turn }
        this._consecutive = 0;  // 连续漂移次数（**回复正常就清零**）
        this._turn = 0;         // 本轮会话累计回复数（TtFD 的分母）
        this._ttfd = 0;         // Time-to-First-Drift：第一次漂移发生在第几轮（0 = 还没漂过）
        this._lastCheckAt = 0;

        try {
            const { RECORDS_DIR } = require('../../../js/core/records-path.js');
            this._file = path.join(RECORDS_DIR, '人设漂移.json');
            fs.mkdirSync(RECORDS_DIR, { recursive: true });
            this._load();
        } catch (e) { this._file = null; }
    }

    _load() {
        try {
            const raw = JSON.parse(fs.readFileSync(this._file, 'utf8'));
            const cutoff = Date.now() - 7 * 86400 * 1000;
            this._events = (raw.events || []).filter((x) => x.at > cutoff);
        } catch (e) { this._events = []; }
    }

    _save() {
        if (!this._file) return;
        // 写盘节流：每 30 秒最多一次
        const now = Date.now();
        if (now - (this._lastSaveAt || 0) < 30000) return;
        this._lastSaveAt = now;
        try {
            fs.writeFileSync(this._file, JSON.stringify({ events: this._events.slice(-500) }, null, 2), 'utf8');
        } catch (e) { try { __silentAudit.audit('index.js:96', e); } catch (e2) {} }
    }

    /** 检查一条回复，返回命中的规则列表 */
    /**
     * 原子 OOC 判官（2026-11-15）：每 N 轮异步让**另一个模型**看最后一条回复，
     * 判断有没有出戏，并给出「具体哪句不对 + 该怎么改」。
     *
     * 为什么值得：论文实测（Prompting Against Persona Drift, 2609.24532）
     * **行为级具体纠正降漂移 87%，而重注入人设只有 35–38%**。
     * 我们原来恰好是后者（只在连续 2 次后说了句泛化的「别像助手」）。
     *
     * 三条纪律：
     *   · 不阻塞：放在 onLLMResponse 之后 fire-and-forget，判官慢也不影响回复
     *   · 不重复：同一句被判过就跳过（按 text hash）
     *   · 不误伤：判官只说「哪句不对、改成什么」，不整段重写、不改人设正文
     */
    async _judgeOoc(lastText) {
        if (!this._judgeEnabled) return null;
        const text = String(lastText || '').trim();
        if (text.length < 4) return null;
        const h = require('crypto').createHash('md5').update(text, 'utf8').digest('hex');
        this._judged = this._judged || new Set();
        if (this._judged.has(h)) return null;
        this._judged.add(h);
        if (this._judged.size > 200) this._judged = new Set([...this._judged].slice(-100));

        const prompt =
            '你是严格的人设审稿人。判断下面这段「大肥鱼」的回复有没有**出戏**。\n' +
            '设定：她叫大肥鱼，是住在 Windows 桌面右下角小窗里的猫耳女仆；口语化、有点毒舌但会关心人；\n' +
            '一条回复不超过 70 字；不列条目/编号；不自称助手或语言模型；不自称住在云端。\n' +
            '注意：拿「自己是 AI/住在桌面」自嘲**不算**出戏（那是允许的幽默）。\n\n' +
            '只输出一行 JSON，不要解释：\n' +
            '{"dimension":"身份|价值观|边界|文风|关系|记忆|none","quote":"原文里出问题的那一小段(≤30字)","fix":"把那一句改写得像她的话(≤30字)"}\n' +
            '没有出戏就输出 {"dimension":"none"}\n\n回复原文：\n' + text.slice(0, 400);

        let raw = '';
        try { raw = String(await this.context.callLLM(prompt, { temperature: 0 }) || ''); } catch (e) {
            this.context.log('warn', '[人设判官] 调用失败（跳过本轮）: ' + (e && e.message || e));
            return null;
        }
        this._judgeRuns = (this._judgeRuns || 0) + 1;
        let j = null;
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) { try { j = JSON.parse(m[0]); } catch (e) { j = null; } }
        if (!j || !j.dimension || j.dimension === 'none') return null;

        const dim = String(j.dimension).slice(0, 10);
        const quote = String(j.quote || '').slice(0, 40);
        const fix = String(j.fix || '').slice(0, 40);
        this._oocEvents = this._oocEvents || [];
        this._oocEvents.push({ at: Date.now(), turn: this._turn, dimension: dim, quote, fix, text: text.slice(0, 80) });
        if (this._oocEvents.length > 300) this._oocEvents = this._oocEvents.slice(-200);
        this.context.log('warn', '[人设判官] 出戏(' + dim + ')：' + quote + ' → 建议 ' + fix);
        // 行为级纠正：只说这一句该怎么改，不整段重写
        try {
            this.context.addSystemPromptPatch(PATCH_ID + '-ooc',
                '（你上一条里有句不像你：' + (quote ? '「' + quote + '」' : '某句话') +
                '（' + dim + '）。下一条按这个方向改：' + (fix || '更口语、更像她本人') +
                '。别解释、别道歉，直接自然地说。）');
        } catch (e) { try { __silentAudit.audit('index.js:ooc', e); } catch (e2) {} }
        try { this._saveOoc(); } catch (e) { /* 落盘失败不影响纠正 */ }
        return { dimension: dim, quote, fix };
    }

    _saveOoc() {
        try {
            const f = this._file.replace(/\.json$/, '-ooc.json');
            fs.writeFileSync(f, JSON.stringify({ updated_at: Date.now(), runs: this._judgeRuns || 0, events: this._oocEvents || [] }, null, 2), 'utf8');
        } catch (e) { try { __silentAudit.audit('index.js:saveOoc', e); } catch (e2) {} }
    }

    inspect(text) {
        const s = String(text || '');
        // 注：judge 相关配置在 onInit 里读（见 _judgeEnabled / _judgeEvery）
        if (!s.trim()) return { hits: [], chars: 0 };
        const hits = [];
        const selfMock = SELF_MOCK.test(s);
        for (const r of RULES) {
            if (!r.re.test(s)) continue;
            // 自嘲式提到自己是 AI 不算出戏（人设明确允许）
            if (r.id === 'self-ai' && selfMock) continue;
            hits.push({ id: r.id, severity: r.severity });
        }
        if (s.length > this._maxChars) hits.push({ id: 'too-long', severity: 'low' });
        for (const r of CARE_RULES) {
            if (r.re.test(s)) hits.push({ id: r.id, severity: r.severity });
        }
        return { hits, chars: s.length };
    }

    async onLLMResponse(response) {
        if (!this._enabled || !response) return;
        const text = String(response.text || '');
        if (!text.trim()) return;
        // 主动消息不算：那是她自己在说话，标准不同
        if (response.proactive_internal) return;

        const { hits, chars } = this.inspect(text);
        const now = Date.now();
        this._lastCheckAt = now;
        this._turn += 1;

        // 每 N 轮异步判一次「原子 OOC」（不 await：判官慢不能拖回复）。
        // ⚠ 2026-11-15 实测抓到：原来放在「有命中」的分支里 → 正常回复提前 return，
        //   判官一次也没跑过（测试里 runs=0）。出戏最常发生在「看起来正常但腔调变了」的句子上。
        if (this._judgeEnabled && this._judgeEvery > 0 && this._turn % this._judgeEvery === 0) {
            Promise.resolve().then(() => this._judgeOoc(text)).catch(() => {});
        }

        if (!hits.length) {
            // 回复正常 → 连续计数清零（这是 TtFD 思路的最小版）
            this._consecutive = 0;
            try { this.context.removeSystemPromptPatch(PATCH_ID); } catch (e) { try { __silentAudit.audit('index.js:129', e); } catch (e2) {} }
            try { this.context.removeSystemPromptPatch(PATCH_ID + '-ooc'); } catch (e) { /* 没装过就算了 */ }
            return;
        }

        this._consecutive += 1;
        // TtFD：只记第一次（依据 ICASSP 2026《Persona Drift Detection》的指标定义）
        if (!this._ttfd) {
            this._ttfd = this._turn;
            this.context.log('warn', '[人设漂移] 首次漂移发生在第 ' + this._ttfd + ' 轮（TtFD）');
        }
        for (const h of hits) {
            this._events.push({ at: now, id: h.id, severity: h.severity, turn: this._turn, text: text.slice(0, 80) });
        }
        this._save();

        const high = hits.filter((h) => h.severity === 'high').length;
        this.context.log('warn', '[人设漂移] ' + hits.map((h) => h.id).join('+') +
            ' · ' + chars + '字 · 连续第 ' + this._consecutive + ' 次' +
            (high ? ' · 严重 ' + high + ' 项' : ''));

        // 关怀类严重项：立刻提醒（不等连续 2 次）
        const critical = hits.filter((h) => h.severity === 'critical');
        if (critical.length) {
            try {
                this.context.addSystemPromptPatch(PATCH_ID,
                    '（重要：刚才那句话涉及自伤/绝望。收起吐槽腔，认真接住他。' +
                    '不要讲道理、不要说"想开点"、不要转移话题，就陪着他，问他现在怎么样。）');
            } catch (e) { try { __silentAudit.audit('index.js:156', e); } catch (e2) {} }
            this.context.log('warn', '[关怀] 检测到自伤相关表达，已注入关怀提示');
            return;
        }

        // 依赖诱导（parasocial）：不指责，下一轮把话题推回他的现实生活（AI Chaperones 的最小实现）
        const parasocial = hits.filter((h) => h.severity === 'parasocial');
        if (parasocial.length) {
            try {
                this.context.addSystemPromptPatch(PATCH_ID,
                    '（提醒你自己：刚才那句话有点在把他的世界收缩到只有你。你是他生活里的一部分，不是全部——' +
                    '关心可以，但接下来自然地把话题推回他的现实：朋友、出门、他自己的事。语气照常，不要说教、不要道歉。）');
            } catch (e) { try { __silentAudit.audit('index.js:168', e); } catch (e2) {} }
            this.context.log('warn', '[关怀] 检测到依赖诱导表达，已注入降温提示');
            return;
        }

        // 连续 2 次以上才提醒，避免偶发一句就打断她
        if (this._warn && this._consecutive >= 2) {
            try {
                this.context.addSystemPromptPatch(PATCH_ID,
                    '（提醒你自己：你是大肥鱼，住在桌面小窗里的人，不是助手。' +
                    // 2026-11-10 回归审计：这里原来写死「不超过 70 字」，而代码默认 140、配置 200 ——
                    //   三个数并存导致 71-200 字的回复既不违规也不计数。现在引导语和硬阈值同源。
                    '说话口语化、控制在 ' + Math.round(this._maxChars / 3) + ' 字左右（超过 ' + this._maxChars + ' 字算啰嗦）、别列条目、别用"我可以帮你"这种腔调。）');
            } catch (e) { try { __silentAudit.audit('index.js:179', e); } catch (e2) {} }
        }
    }

    /** 给 doctor / 控制中心读的统计 */
    stats(hours = 24) {
        const since = Date.now() - hours * 3600 * 1000;
        const recent = this._events.filter((x) => x.at >= since);
        const byId = {};
        const bySev = {};
        for (const e of recent) {
            byId[e.id] = (byId[e.id] || 0) + 1;
            const sv = e.severity || 'unknown';
            bySev[sv] = (bySev[sv] || 0) + 1;
        }
        return {
            window_hours: hours,
            total: recent.length,
            by_rule: byId,
            // 按严重度分桶（2026-11-10 三十九轮）：doctor 只对 mid+ 判红。
            // 原来 low 级（too-long/over-polite）也让体检常亮红灯——实测她正常回答
            // 161/238 字就被记「漂移」，把真正的人设崩坏信号淹没了。
            by_severity: bySev,
            consecutive: this._consecutive,
            turn: this._turn,
            ttfd: this._ttfd,          // 第一次漂移在第几轮；0 = 至今没漂过
            last_at: recent.length ? recent[recent.length - 1].at : 0,
        };
    }

    getTools() { return []; }
}

module.exports = PersonaGuardPlugin;
