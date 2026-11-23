// plugins/community/memory-evolve/index.js
//
// 记忆自我演化：短期门控 + 长期巩固（对齐 arXiv 2602.06052 的两层记忆结构）
//
// 现状问题：memos 插件每轮都把「用户+助手」整段写进 MemOS。
// 结果是库里塞满「嗯」「好吧」「哈哈哈」，真正有用的信息被稀释，
// 而且同一件事重复说十遍就有十条记忆。
//
// 这里做两件事：
//   1) 短期门控：只挑长期有用的 —— 自述、偏好、习惯、计划、关系、嘱托、时间点
//   2) 长期巩固：写库前先查相似度，已经记得就不重复写；每次留一份整理日志（可审计）
//
// 全部本地判断，不花一次 LLM 调用。
const __silentAudit = require('../../../js/core/silent-audit.js');
const { Plugin } = require('../../../js/core/plugin-base.js');
const { resolvePluginEnabled } = require('../../../js/core/plugin-context.js');
const { scoreEvent, createTrigger } = require('./lib/importance.js');
const { reflect } = require('./lib/reflect.js');
const { isAddOk, addErrorText } = require('./lib/memos-contract.js');
// 脚手架判定唯一真源（2026-11-22 记忆污染）：与 memory-recall 共用 js/core/memory-scaffold.js。
// 模块加载失败必须 fail-open —— 过滤器坏了可以多写一条，不能把整条记忆链停掉。
let scaffoldFilter;
try { scaffoldFilter = require('../../../js/core/memory-scaffold.js'); }
catch (e) { scaffoldFilter = { isScaffolding: () => false }; }
const insightsStore = require('./lib/insights-store.js');
// 遗忘墓碑（2026-11-22）：用户说「忘掉 X」后，X 的原文/事实还在片段卡与历史里。
// memory-recall 的重建索引已挡；这里补**写入侧**——反思读到的片段与产出的 insight
// 若含已忘内容，不得再写回 insights.jsonl（否则「忘了又被反思写回来」）。
let tombstones = null;
try { tombstones = require('../../../js/core/forget-tombstones.js'); } catch (e) { tombstones = null; }
function _isForgotten(text) {
    try { return !!(tombstones && tombstones.isForgotten(String(text || ''))); } catch (e) { return false; }
}
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const MEMOS_PORT = 8003;
const USER_ID = 'feiniu_default';

// 门控规则：每条给一个权重，命中就加分。
// 核心思路：必须是关于他的长期信息，不是「此刻在干嘛」。
const RULES = [
  { w: 3.0, tag: '自述',   re: /我(?:叫|是|在|住|来自|今年|已经|做)[^，。？]{1,24}/ },
  { w: 3.0, tag: '所有物', re: /我的[^，。？]{1,14}(?:是|叫|在|有)[^，。？]{0,20}/ },
  { w: 2.5, tag: '偏好',   re: /我(?:不|很|超|特别|最)?(?:喜欢|讨厌|爱吃|不吃|怕|受不了|习惯)[^，。？]{1,24}/ },
  { w: 2.5, tag: '习惯',   re: /我(?:每天|每周|总是|一般|通常|经常|从来)[^，。？]{1,24}/ },
  { w: 2.2, tag: '计划',   re: /我(?:打算|计划|准备|要|想|考虑)[^，。？]{2,24}/ },
  { w: 2.0, tag: '日程',   re: /我(?:这周|下周|下个月?|月底|月底前|明天|后天|周末|假期|年底|过完年)[^，。？]{1,24}/ },
  { w: 2.4, tag: '宠物',   re: /我(?:家)?(?:养|买|领养|捡)了?[^，。？]{1,16}/ },
  { w: 2.4, tag: '健康',   re: /我(?:对[^，。？]{1,10}过敏|不能吃|不适合吃|吃[^，。？]{1,6}会过敏|住院[^，。？]{0,12})/ },
  { w: 2.0, tag: '关系',   re: /我(?:老婆|老公|女朋友|男朋友|妈|爸|儿子|女儿|同事|老板|室友|朋友)[^，。？]{0,18}/ },
  { w: 1.8, tag: '嘱托',   re: /(?:记住|别忘了|你要记得|帮我记)[^。？]{1,30}/ },
  { w: 1.6, tag: '时间点', re: /(?:生日|纪念日|截止|deadline|DDL)[^。？]{0,16}/i },
];

// 明显不该记的：只有寒暄和纯情绪词。
// （之前还有一条「6 个字以下全跳过」，把「我不吃香菜」这种真信息也杀了。）
const NOISE = [
  /^(?:嗯|哦|啊|哈|好|行|在吗|你好|晚安|早安|谢谢|拜拜|哈哈哈?)[。！？!.?~ ]*$/,
];

class MemoryEvolvePlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig() || {};
        // 总开关单一真相源（2026-11-21）：enabled_plugins.json（context）优先；
        // plugin_config.enabled 只作旧配置兼容（显式 false 才关，并警告一次）。
        this._enabled = resolvePluginEnabled(this.context, cfg, 'memory-evolve');
        this._gate = Number(cfg.gate_threshold ?? 0.6);
        this._dedupe = Number(cfg.dedupe_threshold ?? 0.82);
        this._every = Math.max(1, Number(cfg.consolidate_every ?? 6));
        // 语义段级巩固（LycheeMemory 2608.12990）：新句与已攒批的语义重心相似度低于阈值 = 话题切段，
        // 此刻就该巩固，而不是硬等满 6 轮（切断事件、无效轮次也烧 /add）。
        this._segThreshold = Number(cfg.segment_similarity ?? 0.45);
        this._vecCache = new Map();   // 文本 → 向量（8090 本地嵌入，免费；LRU 50）
        this._embedWarned = false;
        this._turns = 0;
        this._pending = [];
        // 2026-11-21 审计 P0：单条过闸后 `_pending.length < 2` 直接 return，唯一落盘点在
        // _consolidate —— 也就是说「只说了一句值得记的话」永远不入队，重启即失。
        // 现在两道保险：① 过闸当场 append 到 JSONL 队列（一条也落盘）；
        // ② 定时 flush（默认 30s）把内存里的 _pending 也推进巩固链，不再等「攒够 2 条」。
        const flushSec = Number(cfg.flush_interval_sec ?? 30);
        this._flushMs = (Number.isFinite(flushSec) && flushSec > 0 ? flushSec : 30) * 1000;
        this._flushTimer = null;
        this._stats = { gated: 0, enqueued: 0, flushed: 0, addOk: 0, addFail: 0, scaffoldSkipped: 0 };
        this._scaffoldFilterImpl = scaffoldFilter;
        this._lastSeenUserText = '';
        this._log = [];
        try {
            // 记录室有唯一真源（js/core/records-path.js），别自己按 __dirname 数层级 ——
            // 历史上就这么分裂过一次，用户画像被劈成两半。
            const { RECORDS_DIR } = require('../../../js/core/records-path.js');
            this._dir = path.join(RECORDS_DIR, '记忆整理');
            fs.mkdirSync(this._dir, { recursive: true });
        } catch (e) { this._dir = null; this.context.log('warn', '[记忆演化] 记录室不可用: ' + (e && e.message)); }

        // ── 待写队列（2026-11-15 五十八轮）──────────────────────────────────
        // 为什么加：MemOS(8003) 不在线时，_consolidate 先 splice 出 _pending、/add 失败只 warn，
        // **整批静默丢失**；而且 _post 超时 150s、还在 onLLMResponse 里 await ——
        // MemOS 一挂起，回复后链路最多卡 150 秒。现在：写库前先落盘队列，写成一条删一条，
        // 不在线就攒着，等它回来再重放。
        // 去重阈值：配置写 1 表示「几乎不判重」，但 similarity 是 0~1 —— 代码语义失效。
        // 夹到 0.95 并把生效值记下来（不确定就保守：宁可多写一条，也别一句不记）。
        const dd = Number(this._dedupe);
        this._dedupeEff = Number.isFinite(dd) ? Math.min(0.95, dd) : 0.82;
        this._consolidating = false;
        // 空闲巩固（2026-11-15 六十轮）：把一段对话压成「片段卡片」。
        // 为什么要空闲：生成要一次 LLM 调用，用户正在说话时不该抢；
        // 而且卡片是给「上周/那阵子发生了什么」这种问法用的，晚半小时没损失。
        this._episodeEnabled = cfg.episode_enabled !== false;
        const idleMin = Number(cfg.episode_idle_min ?? 30);
        this._episodeIdleMs = (Number.isFinite(idleMin) && idleMin > 0 ? idleMin : 30) * 60 * 1000;
        const epMinTurns = Number(cfg.episode_min_turns ?? 6);
        this._episodeMinTurns = (Number.isFinite(epMinTurns) && epMinTurns > 0 ? epMinTurns : 6);
        const epMaxLines = Number(cfg.episode_max_lines ?? 60);
        this._episodeMaxLines = (Number.isFinite(epMaxLines) && epMaxLines > 0 ? epMaxLines : 60);
        // 解析连续失败上限（2026-11-21 审计 P2）：坏输出不再无限重试同一批。
        // 括号配平已经把多数坏输出救回来了；连续 N 次仍解析不了 → 跳过这段（原文还在
        // 对话历史.jsonl，只是没有卡片），避免每 5 分钟烧一次 LLM。
        const epRetries = Number(cfg.episode_parse_max_retries ?? 3);
        this._episodeMaxParseRetries = (Number.isFinite(epRetries) && epRetries >= 1 ? Math.floor(epRetries) : 3);
        this._episodeParseFails = 0;
        this._episodeTimer = null;
        this._episodeBusy = false;
        // 启动补跑 timer 句柄（2026-11-20 审计 P1）：原来 setTimeout 的 id 丢掉，
        // 热重载后旧实例的 2 分钟回调照样跑 → 新旧两份实例同时反思、重复写 insight。
        this._bootTimer = null;
        this._destroyed = false;
        this._reflecting = false;
        this._reflectSkipCount = 0;
        this._reflectCasConflicts = 0;

        // ── 反思（记忆 v2，2026-11-20）────────────────────────────────────
        // 重要性累加触发（不是时钟）；只写 data/insights.jsonl，**不在本轮注入、不改 system**。
        // 默认关闭：阈值 60 与打分权重都还没用真实语料校准（调研 §6.1/§6.2），
        // 开之前先看 docs/调研-记忆v2-2026-11-20.md；配置键 reflect_enabled。
        this._reflectEnabled = cfg.reflect_enabled === true;
        const rThreshold = Number(cfg.reflect_threshold ?? 60);
        this._reflectThreshold = Number.isFinite(rThreshold) && rThreshold > 0 ? rThreshold : 60;
        const rCap = Number(cfg.reflect_daily_cap ?? 4);
        this._reflectCap = Number.isFinite(rCap) && rCap >= 1 ? Math.floor(rCap) : 4;
        const rMaxEntries = Number(cfg.reflect_max_entries ?? 30);
        this._reflectMaxEntries = Number.isFinite(rMaxEntries) && rMaxEntries >= 2 ? Math.floor(rMaxEntries) : 30;
        const rMaxIns = Number(cfg.reflect_max_insights ?? 5);
        this._reflectMaxInsights = Number.isFinite(rMaxIns) && rMaxIns >= 1 ? Math.floor(rMaxIns) : 5;
        const rMaxChars = Number(cfg.reflect_max_text_chars ?? 200);
        this._reflectMaxTextChars = Number.isFinite(rMaxChars) && rMaxChars >= 20 ? Math.floor(rMaxChars) : 200;
        this._reflectTrigger = createTrigger({ threshold: this._reflectThreshold });
        this._reflectPending = false;   // 触发器已点着，等空闲节拍真正跑
        this._reflectBusy = false;
        this._reflectCapWarnedDay = ''; // 日上限日志一天只喊一次（别每 5 分钟刷屏）
        this._reflectState = {
            lastError: null, lastRunAt: 0, runsToday: 0,
            lastResult: null, lastScore: null, lastHits: [], remain: this._reflectThreshold,
        };
        this._insightsDir = null;
        try {
            const { RECORDS_DIR } = require('../../../js/core/records-path.js');
            // reflect_dir 只给单测/隔离用；生产永远走唯一真源 RECORDS_DIR
            this._insightsDir = (typeof cfg.reflect_dir === 'string' && cfg.reflect_dir)
                ? cfg.reflect_dir : RECORDS_DIR;
        } catch (e) {
            this.context.log('warn', '[反思] 记录室不可用: ' + (e && e.message));
        }

        this._queuePath = null;
        try {
            const { RECORDS_DIR } = require('../../../js/core/records-path.js');
            this._queuePath = path.join(RECORDS_DIR, '记忆待写队列.jsonl');
        } catch (e) { this._queuePath = null; }
        this._queueCheckedAt = 0;
        this._memosAlive = null;
        // 启动时若队列有货，后台补写一次（不阻塞启动）
        // 2026-11-21 审计（P2）：句柄原来直接丢掉 → 热重载后旧实例的 8s 回调照样跑，
        // 新旧实例可能同时 _drainQueue（同一批写两遍）。现在留句柄、unref、onStop 清掉，
        // 回调里再查 _destroyed。
        this._bootQueueTimer = setTimeout(() => {
            if (this._destroyed) return;
            try {
                const n = this._queueLoad().length;
                if (n > 0) {
                    this.context.log('info', '[记忆演化] 待写队列有 ' + n + ' 条，尝试补写');
                    this._drainQueue().catch(() => {});
                }
            } catch (e) { /* 读队列失败不该影响启动 */ }
        }, 8000);
        if (this._bootQueueTimer.unref) this._bootQueueTimer.unref();
    }

    // ── 空闲巩固：episode 卡片（2026-11-15 六十轮）──────────────────────────
    // 原文永远在 对话历史.jsonl 里，但没人能一次读 700 轮。到了「上周/那阵子在干嘛」
    // 这种问法，词法检索只能碰到零散句子。卡片 = 一段时间的叙事摘要（标题+摘要+事实）。
    async onStart() {
        this._destroyed = false;
        // 插件总开关（审计 P2 #31）：enabled:false 时必须完全不整理，而不只是关反思。
        if (!this._enabled) return;
        this._startFlushTimer();
        if (!this._episodeEnabled && !this._reflectEnabled) return;
        // 每 5 分钟问一次「空闲了吗」；放 onStart 而不是 onInit：onInit 阶段 callLLM 未必就绪
        const tick = () => {
            if (this._destroyed) return;   // 热重载：旧实例的残留回调一律不跑
            this._idleTick().catch(() => {});
        };
        this._episodeTimer = setInterval(tick, 5 * 60 * 1000);
        if (this._episodeTimer.unref) this._episodeTimer.unref();
        // 启动 2 分钟后再试一次，补上「关了一段时间」的积压（句柄必须留着给 onStop 清）
        this._bootTimer = setTimeout(tick, 2 * 60 * 1000);
        if (this._bootTimer.unref) this._bootTimer.unref();
    }

    /**
     * 空闲维护的统一节拍：人格层 → 片段卡 → 反思。
     * 反思排在压卡之后，这样刚生成的卡片当轮就能被读到（否则要等多 5 分钟）。
     * 任何一步失败都不拖垮后面：各自 try/catch，失败必须留日志（不许静默）。
     */
    async _idleTick() {        if (this._destroyed) return;   // onStop 之后不再做任何空闲巩固
        if (!this._enabled) return;    // 总开关关闭：连旧 timer 残留调用也短路（审计 P2 #31）
        try { this._maybePromoteSlow(); } catch (e) { /* 人格层失败不影响压卡 */ }
        if (this._episodeEnabled) {
            try { await this._maybeBuildEpisode(); } catch (e) { /* 压卡失败不影响反思 */ }
        }
        if (this._reflectEnabled) {
            try { await this._maybeReflect(); } catch (e) {
                this._setReflectError('反思异常: ' + ((e && e.message) || e));
            }
        }
    }

    /**
     * 定时 flush（2026-11-21 审计 P0）：_maybeConsolidate 的「<2 条就 return」不许再是
     * 数据的终点。每 flushMs 检查一次内存里的 _pending，有货就走一次巩固（单条也走）。
     * 句柄 unref + onStop 清理：热重载后旧实例的定时器不能再跑。
     */
    _startFlushTimer() {
        if (this._flushTimer) return;
        if (!(this._flushMs > 0)) return;
        this._flushTimer = setInterval(() => {
            if (this._destroyed) return;
            if (this._consolidating) return;
            if (this._pending.length) { this._flushPending('定时').catch(() => {}); return; }
            // 内存里没有新条目，但队列里有历史积压 → 借同一个节拍重放（MemOS 恢复后
            // 不必等下一轮对话或下次重启才补写）。离线时 reachability 有 30s 缓存，很便宜。
            if (this._queueLoad().length) this._drainQueue().catch(() => {});
        }, this._flushMs);
        if (this._flushTimer.unref) this._flushTimer.unref();
    }

    /** 把内存里的待写条目立刻推进巩固链（定时器/停机/体检都可调用）。 */
    async _flushPending(reason) {
        if (this._destroyed) return 0;
        if (!this._pending.length) return 0;
        if (this._consolidating) return 0;   // 已有巩固在跑：它会把这批一起带走
        this._consolidating = true;
        const n = this._pending.length;
        try {
            // 直接走 _consolidate：绕开「<2 条不巩固」的批量启发式 —— 单条也是数据。
            await this._consolidate(reason || '定时');
            this._stats.flushed += 1;
            this.context.log('info', '[记忆演化] flush（' + (reason || '手动') + '）：' + n
                + ' 条待写已推进（累计 flush ' + this._stats.flushed + ' 次）');
            return n;
        } catch (e) {
            this.context.log('warn', '[记忆演化] flush 失败（条目仍在队列，不会丢）: ' + ((e && e.message) || e));
            return 0;
        } finally {
            this._consolidating = false;
        }
    }

    async onStop() {
        this._destroyed = true;
        if (this._flushTimer) { clearInterval(this._flushTimer); this._flushTimer = null; }
        if (this._episodeTimer) { clearInterval(this._episodeTimer); this._episodeTimer = null; }
        if (this._bootTimer) { clearTimeout(this._bootTimer); this._bootTimer = null; }
        if (this._bootQueueTimer) { clearTimeout(this._bootQueueTimer); this._bootQueueTimer = null; }
        if (this._pending.length) {
            // 过闸时已逐条 append 到队列，这里只留痕（不在停机路径上撞 /add 的 150s 超时）
            this.context.log('info', '[记忆演化] 停机：' + this._pending.length + ' 条待写仍在队列（下次启动补写）');
        }
    }

    /** 热重载统一走 onStop；onDestroy 再兜一层，保证任何卸载路径都清 timer。 */
    async onDestroy() {
        await this.onStop();
    }

    /**
     * 空闲时把「跨天出现 ≥2 次」的事实升级成人格 slow 层（2026-11-15 六十轮）。
     * 不花 LLM：证据来自 user-facts 的 valid_from（每条事实本来就带日期）。
     * 三重闸在 persona-layers.applySlow 里：core 冲突拒、周配额 ≤5、同类去重。
     */
    _maybePromoteSlow() {
        try {
            const layers = require('../../../js/core/persona-layers.js');
            const uf = require('../../../js/core/user-facts.js');
            layers.initIfMissing();
            const cands = layers.proposeFromFacts(uf.load());
            let applied = 0;
            for (const c of cands) {
                const r = layers.applySlow(c);
                if (r.ok) {
                    applied += 1;
                    this.context.log('info', '[人格层] 升级到 slow（' + r.cls + '）：' + String(c.text).slice(0, 30)
                        + '（证据 ' + (c.days || []).length + ' 天）');
                }
            }
            return applied;
        } catch (e) { return 0; }
    }

    /**
     * 空闲时把「游标之后」的对话压成一张卡片。
     * 四条纪律（踩过坑的）：
     *   · 用户还在说话（< idleMs）→ 不动
     *   · 轮数不够 → 不动
     *   · LLM 失败/输出坏 → **不动游标**（下次重试，一行不丢）
     *   · LLM 明确说「没值得记的」→ 前进游标跳过这段（否则同一段会永远重试）
     */
    /**
     * 片段卡片里的事实 → 用户事实层（2026-11-15 六十轮）。
     *
     * 为什么多这一步：卡片摘要里已经写着「下午三点开会」这种**稳定信息**，但它只活在
     * 片段文本里；而事实层才是免衰减、可被 supersedes 管起来的一等公民。
     * 不做这步就会出现「上周的会她记得、会几点开她答不上」。
     *
     * 保守三条：≥6 字 / 不像问句 / 每卡最多 3 条；失败一律不影响卡片本身。
     *
     * ⚠ 2026-11-21 审计 P1：片段卡是「一段时间的叙事」，里面的事实**天然带一次性**属性
     * （「昨天下午三点开会」）。它们照样进事实层（可被 supersedes 管），但 source='episode'
     * 会在召回侧被当成 **STABLE=false** —— 参与时间衰减，不再是永久真理。
     * 实测 25 条事实里 24 条是一次性事件，就是因为这里无条件晋升 + 召回侧按来源一刀切稳定。
     */
    _promoteEpisodeFacts(card) {
        try {
            const uf = require('../../../js/core/user-facts.js');
            const facts = Array.isArray(card && card.facts) ? card.facts : [];
            let added = 0;
            for (const raw of facts.slice(0, 3)) {
                const t = String(raw || '').trim();
                if (t.length < 6 || t.length > 60) continue;
                if (/[?？]$/.test(t)) continue;
                // source='episode' 是稳定性判定的唯一依据（memory-recall._isStableDoc）
                const r = uf.addFact({ text: t, source: 'episode', confidence: 0.6 });
                if (r && r.ok && !r.duplicate) added += 1;
            }
            if (added) this.context.log('info', '[片段] 顺手把 ' + added + ' 条事实升进事实层（episode → 非 STABLE，按时间衰减）');
            return added;
        } catch (e) { return 0; }
    }

    async _maybeBuildEpisode() {
        if (!this._episodeEnabled || this._episodeBusy) return null;
        const now = Date.now();
        const lastUser = Number(global.__lastUserInputAt) || 0;
        if (lastUser && now - lastUser < this._episodeIdleMs) return null;

        let es, rp;
        try {
            es = require('../../../js/core/episode-store.js');
            rp = require('../../../js/core/records-path.js');
        } catch (e) { return null; }

        const cursor = es.loadCursor();
        const { turns, consumed } = es.readTurns(rp.recordFile('对话历史.jsonl'), cursor, this._episodeMaxLines);
        if (turns.length < this._episodeMinTurns) return null;

        this._episodeBusy = true;
        try {
            const body = turns.map((t) => (t.role === 'user' ? '他：' : '你：') + t.text).join('\n');
            const prompt =
                '把下面这段对话压成一张「片段卡片」，以后用来回答「上周/那阵子在干什么」。\n' +
                '只输出一行 JSON：{"title":"≤12字","summary":"≤120字，说清发生了什么、他的状态或决定","facts":["≤30字的关键事实，最多3条"]}\n' +
                '要求：只写对话里真的出现过的信息，不要评价、不要编；如果这段没有任何值得记住的内容，输出 {"summary":""}\n\n' +
                body.slice(0, 4000);
            let raw = '';
            try { raw = String(await this.context.callLLM(prompt, { temperature: 0.2 }) || ''); }
            catch (e) {
                this.context.log('warn', '[片段] 摘要调用失败（游标不动，下次重试）: ' + (e && e.message || e));
                return null;
            }
            if (/"summary"\s*:\s*""/.test(raw)) {
                es.saveCursor(cursor + consumed);
                this.context.log('info', '[片段] 这段没值得记的，跳过 ' + consumed + ' 行');
                return null;
            }
            const card = es.parseCard(raw, {
                at: now,
                turns: turns.length,
                // 证据坐标（记忆 v2）：记下这张卡覆盖的对话行区间，反思的 evidence 才能点回原话。
                // 旧卡没有这个字段 → null，读取方兜底，不影响向后兼容。
                span: { from: cursor, lines: consumed },
            });
            if (!card) {
                // 解析失败：括号配平后已很少见；但坏输出不能无限重试同一批（每 5 分钟一次 LLM）。
                // 连续 episode_parse_max_retries 次仍失败 → 跳过这段（原文仍在对话历史，只是没卡片）。
                this._episodeParseFails += 1;
                if (this._episodeParseFails >= this._episodeMaxParseRetries) {
                    es.saveCursor(cursor + consumed);
                    this.context.log('warn', '[片段] 连续 ' + this._episodeParseFails + ' 次解析失败，跳过 '
                        + consumed + ' 行（原文仍在对话历史；不再重试同一批）: ' + String(raw).slice(0, 80));
                    this._episodeParseFails = 0;
                } else {
                    this.context.log('warn', '[片段] 输出解析失败（游标不动，第 ' + this._episodeParseFails
                        + '/' + this._episodeMaxParseRetries + ' 次重试）: ' + String(raw).slice(0, 80));
                }
                return null;
            }
            if (!es.appendEpisode(card)) {
                this.context.log('warn', '[片段] 卡片落盘失败（游标不动）');
                return null;
            }
            es.saveCursor(cursor + consumed);
            this._episodeParseFails = 0;
            // 卡片里的事实顺手升进事实层（免衰减 + 可被 supersedes 管）
            this._promoteEpisodeFacts(card);
            this.context.log('info', '[片段] 生成卡片「' + card.title + '」（' + turns.length + ' 轮 / ' + consumed + ' 行）');
            return card;
        } finally {
            this._episodeBusy = false;
        }
    }

    // ── 反思（记忆 v2，2026-11-20）────────────────────────────────────────
    // 触发：每条新用户消息按 1..10 打分，累减到 <=0 只点亮「待反思」；真正跑要等
    // 5 分钟空闲节拍（复用压卡的 30 分钟空闲闸），一天 ≤4 次，gaming/watching 不跑。
    // 产出只 append insights.jsonl + 推进 cursor；**本轮不注入人格、不改 system**。
    _setReflectError(msg) {
        const text = String(msg || '未知错误');
        this._reflectState.lastError = text;
        try { this.context.log('warn', '[反思] ' + text); } catch (e) { /* 日志本身失败也不能吞掉原错误 */ }
    }

    /** 重要性打分 + 累减。返回本轮打分结果，便于体检/单测。 */
    _noteImportance(text) {
        if (!this._reflectEnabled) return null;
        const r = scoreEvent(text, { role: 'user' });
        const t = this._reflectTrigger.add(r.score);
        this._reflectState.lastScore = r.score;
        this._reflectState.lastHits = r.hits;
        this._reflectState.remain = t.remain;
        if (t.fire) {
            this._reflectPending = true;
            this.context.log('info', '[反思] 重要性触发（本条 ' + r.score + ' 分' +
                (r.hits.length ? '：' + r.hits.join('/') : '') + '），等空闲再反思');
        }
        return { score: r.score, hits: r.hits, fire: t.fire, remain: t.remain };
    }

    /** 世界五态（world-sense 只读快照）；不可用/stale/已暂停 就当 unknown，不阻塞反思。 */
    _worldActivity() {
        try {
            const fn = globalThis.__worldSenseState;
            if (typeof fn === 'function') {
                const s = fn();
                // 与 speech-budget/intent-queue 同口径：ok=false（暂停/隐私）也当无状态。
                if (s && s.ok === false) return 'unknown';
                const a = s && s.activity;
                // stale（暂停/隐私/采样停摆）时 state 还可能留着最后一次 gaming/watching：
                // 直接当 unknown，否则「世界在忙」会拦掉本该跑的反思。
                if (a && a.stale === true) return 'unknown';
                const st = a && a.state;
                if (typeof st === 'string' && st) return st;
            }
        } catch (e) { /* 世界状态不可用：按 unknown 处理 */ }
        return 'unknown';
    }

    /**
     * 跑一次反思。四条纪律：
     *   · 失败不动 lastEpisodeLine（下次重试，一行不丢）
     *   · LLM 明确返回空 insights → **推进游标**（否则同一批永远重试）
     *   · 日配额先记账再调用（失败也占一次，成本必须诚实）
     *   · 只 append + 原子写游标；不改已有记忆、不注入本轮对话
     */
    async _maybeReflect() {
        if (!this._enabled || !this._reflectEnabled || this._reflectBusy) return null;
        // 内存互斥（2026-11-20 审计 P1）：同一实例被两个节拍同时触发时，
        // 第二次直接跳过并计数（不排队、不叠加 LLM 成本）。
        if (this._reflecting) {
            this._reflectSkipCount += 1;
            this.context.log('info', '[反思] 上一次还没跑完，跳过本次（累计 ' + this._reflectSkipCount + ' 次）');
            return { skipped: 'concurrent', skippedTotal: this._reflectSkipCount };
        }
        this._reflecting = true;
        try {
            return await this._maybeReflectInner();
        } finally {
            this._reflecting = false;
        }
    }

    /**
     * 简单 CAS 写游标（2026-11-20 审计 P1）：写前重读，若 lastEpisodeLine 已被
     * 另一实例推进，就在最新游标上叠加本轮记账（runsToday 取大、游标位置保留更远的一方），
     * 避免「最后写者赢」把日配额少计。loadCursor/saveCursor 都是同步 IO，
     * 同一进程内「读-比-写」不会被其他回调插入。
     */
    _saveCursorCas(cursor, expectedLastLine, opts) {
        const dir = this._insightsDir;
        const fresh = insightsStore.loadCursor(dir);
        const conflict = fresh.lastEpisodeLine !== expectedLastLine;
        let next = cursor;
        if (conflict) {
            // 对方把 runsToday 覆盖成了它的值：若它 ≥ 我们的值，说明本轮这次 LLM
            // 成本被盖掉了，必须 +1 补回来（否则两个实例并发时日配额永远少计一次）。
            const runsToday = Number(fresh.runsToday) >= Number(cursor.runsToday)
                ? Number(fresh.runsToday) + 1
                : Number(cursor.runsToday);
            next = Object.assign({}, fresh, {
                runsToday,
                lastRunAt: Math.max(Number(fresh.lastRunAt) || 0, Number(cursor.lastRunAt) || 0),
                day: fresh.day || cursor.day,
                lastError: cursor.lastError === undefined ? fresh.lastError : cursor.lastError,
            });
            this._reflectCasConflicts += 1;
            this.context.log('info', '[反思] 游标 CAS：另一实例已推进到 ' +
                String(fresh.lastEpisodeLine).slice(0, 40) + '，叠加记账后写回（第 ' + this._reflectCasConflicts + ' 次）');
        }
        if (opts && opts.advanceLine !== undefined && !conflict) {
            next.lastEpisodeLine = opts.advanceLine;
            next.lastEpisodeId = opts.advanceId;
        }
        const saved = insightsStore.saveCursor(dir, next);
        return { conflict, cursor: saved };
    }

    async _maybeReflectInner() {
        if (!this._reflectPending) return null;
        if (!this._insightsDir) return null;

        const now = Date.now();
        const lastUser = Number(global.__lastUserInputAt) || 0;
        // 用户还在说话：不抢 LLM（与压卡共用同一个空闲阈值）
        if (lastUser && now - lastUser < this._episodeIdleMs) return null;
        const world = this._worldActivity();
        if (world === 'gaming' || world === 'watching') {
            this.context.log('info', '[反思] 世界在 ' + world + '，这轮不跑（标记保留）');
            return { skipped: 'world_busy' };
        }

        let cursor;
        try { cursor = insightsStore.loadCursor(this._insightsDir); }
        catch (e) { this._setReflectError('读游标失败: ' + ((e && e.message) || e)); return { ok: false, error: '读游标失败' }; }
        const today = insightsStore.todayStr(now);
        cursor = insightsStore.rollDay(cursor, today);
        if (!insightsStore.canRun(cursor, this._reflectCap)) {
            if (this._reflectCapWarnedDay !== today) {
                this._reflectCapWarnedDay = today;
                this.context.log('info', '[反思] 今日已达上限 ' + this._reflectCap + ' 次，明天再说');
            }
            return { skipped: 'daily_cap', runsToday: cursor.runsToday };
        }

        let cards;
        try { cards = insightsStore.readEpisodesWithLines(this._insightsDir); }
        catch (e) { this._setReflectError('读片段失败: ' + ((e && e.message) || e)); return { ok: false, error: '读片段失败' }; }
        const baseLine = cursor.lastEpisodeLine;   // CAS 基准：本轮读到的游标
        const built = insightsStore.buildEntries(cards, cursor.lastEpisodeLine, this._reflectMaxEntries);
        if (!built.entries.length) return null;       // 没有新片段：游标不动，标记保留
        // 单条新观察也可以和已有 insight 组成 ≥2 证据的链；证据不足由 reflect 整条丢弃。

        let tombstonedEntries = 0;
        const entries = built.entries
            .filter((e) => {
                if (!_isForgotten(e && e.text)) return true;
                tombstonedEntries += 1;
                return false;
            })
            .map((e) => Object.assign({}, e, {
                importance: scoreEvent(e.text).score,
            }));
        if (!entries.length) {
            // 这批片段全部命中墓碑：不调 LLM、不重复读，但**游标必须前进**
            //（否则每个空闲节拍都会重读同一批已忘片段）。
            this._reflectPending = false;
            try {
                cursor = this._saveCursorCas(cursor, baseLine, { advanceLine: built.lastLine, advanceId: built.lastId }).cursor;
            } catch (e) { /* 游标写不进去：下轮重复读已忘片段，不影响正确性 */ }
            this.context.log('info', '[反思] 本批片段全部命中遗忘墓碑，跳过（' + tombstonedEntries + ' 条）');
            return { ok: true, insights: [], tombstoned: tombstonedEntries, cursor };
        }
        let existing = [];
        try {
            existing = insightsStore.loadRecentInsights(this._insightsDir, 5)
                .filter((x) => !_isForgotten(x && x.text));
        } catch (e) { existing = []; }

        this._reflectBusy = true;
        // 先记一次成本：LLM 失败也算今天跑过，日配额不能因为失败而虚高。
        cursor.runsToday += 1;
        cursor.lastRunAt = now;
        cursor.day = today;
        cursor.lastError = null;
        let costCas;
        try { costCas = this._saveCursorCas(cursor, baseLine); cursor = costCas.cursor; }
        catch (e) {
            this._reflectBusy = false;
            this._setReflectError('写游标失败: ' + ((e && e.message) || e));
            return { ok: false, error: '写游标失败' };
        }

        let r;
        try {
            r = await reflect({
                entries,
                existingInsights: existing,
                callLLM: (prompt) => this.context.callLLM(prompt, { temperature: 0.2 }),
                now: () => now,
                maxEntries: this._reflectMaxEntries,
                maxInsights: this._reflectMaxInsights,
                maxTextChars: this._reflectMaxTextChars,
                promptVersion: 'reflect-v1',
            });
        } catch (e) {
            r = { ok: false, error: '反思调用异常: ' + ((e && e.message) || e) };
        } finally {
            this._reflectBusy = false;
        }

        if (!r || !r.ok) {
            const msg = String((r && r.error) || '反思失败（未返回原因）').slice(0, 300);
            cursor.lastError = msg;
            try { cursor = this._saveCursorCas(cursor, baseLine).cursor; } catch (e2) { /* 已在下面发声 */ }
            this._setReflectError(msg + '（游标未前进，下次重试）');
            return { ok: false, error: msg };
        }

        // 并发去重（2026-11-20 审计 P1）：另一实例在本轮期间已把这批片段反思过了
        // （游标被推进）→ 不重复 append、不推进游标。runsToday 已在成本阶段叠加。
        if ((costCas && costCas.conflict) ||
            insightsStore.loadCursor(this._insightsDir).lastEpisodeLine !== baseLine) {
            // 把本轮成本补记到最新游标（对方可能已覆盖 runsToday），但不推进片段游标。
            try { cursor = this._saveCursorCas(cursor, baseLine).cursor; } catch (e) { /* 写失败下面照常发声 */ }
            this._reflectPending = false;
            this._reflectState.lastRunAt = now;
            this._reflectState.runsToday = cursor.runsToday;
            this._reflectState.lastResult = { insights: 0, deduped: r.insights.length, cards: built.cardCount };
            this.context.log('info', '[反思] 并发去重：另一实例已覆盖这批片段，丢弃本轮 ' +
                r.insights.length + ' 条 insight，不重复写盘');
            return { ok: true, insights: [], deduped: true, cursor };
        }

        // 写入侧墓碑过滤：LLM 可能从旧片段/旧 insight 里重新归纳出已忘内容，落盘前再挡一次。
        let tombstonedInsights = 0;
        const freshInsights = r.insights.filter((ins) => {
            if (!_isForgotten(ins && ins.text)) return true;
            tombstonedInsights += 1;
            return false;
        });
        let writeRes = { added: 0, merged: 0, total: 0 };
        try {
            if (freshInsights.length) writeRes = insightsStore.mergeOrAppendInsights(this._insightsDir, freshInsights);
        } catch (e) {
            cursor.lastError = 'insights 写盘失败: ' + ((e && e.message) || e);
            try { cursor = this._saveCursorCas(cursor, baseLine).cursor; } catch (e2) { /* 同上 */ }
            this._setReflectError(cursor.lastError + '（游标未前进）');
            return { ok: false, error: cursor.lastError };
        }

        cursor.lastError = null;
        try { cursor = this._saveCursorCas(cursor, baseLine, { advanceLine: built.lastLine, advanceId: built.lastId }).cursor; }
        catch (e) {
            // 游标没写进去 → 下轮可能重复追加同一批 insight。重复比丢好，但必须发声。
            this._setReflectError('游标保存失败（下轮可能重复写，需人工检查）: ' + ((e && e.message) || e));
        }

        this._reflectPending = false;
        this._reflectState.lastRunAt = now;
        this._reflectState.runsToday = cursor.runsToday;
        this._reflectState.lastResult = {
            insights: writeRes.added,
            merged: writeRes.merged,
            dropped: r.dropped,
            tombstoned: tombstonedEntries + tombstonedInsights,
            cards: built.cardCount,
        };
        this.context.log('info', '[反思] 完成：新增 ' + writeRes.added + ' / 合并 ' + writeRes.merged +
            ' 条 insight（证据不足丢弃 ' + r.dropped + ' 条' +
            ((tombstonedEntries + tombstonedInsights) ? '，遗忘墓碑剔除 ' + (tombstonedEntries + tombstonedInsights) + ' 条' : '') +
            '），覆盖片段 ' + built.cardCount + ' 张，今日 ' + cursor.runsToday + '/' + this._reflectCap);
        return {
            ok: true, insights: freshInsights, added: writeRes.added, merged: writeRes.merged,
            dropped: r.dropped, tombstoned: tombstonedEntries + tombstonedInsights, cursor,
        };
    }

    // ── 待写队列：JSONL 追加安全；重写用 tmp+rename 原子替换 ──────────────
    _queueLoad() {
        if (!this._queuePath) return [];
        try {
            const raw = fs.readFileSync(this._queuePath, 'utf8');
            const out = [];
            for (const line of raw.split(/\r?\n/)) {
                if (!line.trim()) continue;
                try {
                    const o = JSON.parse(line);
                    if (o && typeof o.text === 'string' && o.text.trim()) out.push(o);
                } catch (e) { /* 坏行跳过：别让一条脏数据毁掉整个队列 */ }
            }
            return out;
        } catch (e) { return []; }
    }

    _queueWrite(items) {
        if (!this._queuePath) return false;
        try {
            const tmp = this._queuePath + '.tmp';
            const body = (items || []).map((x) => JSON.stringify(x)).join('\n');
            fs.writeFileSync(tmp, body ? body + '\n' : '', 'utf8');
            fs.renameSync(tmp, this._queuePath);
            return true;
        } catch (e) {
            this.context.log('warn', '[记忆演化] 队列落盘失败（这批可能丢）: ' + (e && e.message || e));
            return false;
        }
    }

    _queueAppend(items) {
        if (!this._queuePath || !items || !items.length) return this._queueLoad();
        const cur = this._queueLoad();
        const at = Date.now();
        // 按 text 去重：过闸时会「立即 append」，_consolidate 里还会再 append 一次兜底
        // （队列路径不可用时也不能丢）。幂等之后两条路径可以同时存在而不写重复。
        const known = new Set(cur.map((x) => String(x && x.text)));
        let added = 0;
        for (const it of items) {
            const text = String(it && it.text || '');
            if (!text || known.has(text)) continue;
            known.add(text);
            cur.push({ text, score: it.score, at });
            added += 1;
        }
        this._queueWrite(cur);
        return cur;
    }

    /** MemOS 在不在线（1.2s 探针 + 30s 缓存）：避免每次巩固都先吃一次长超时 */
    async _memosReachable() {
        const now = Date.now();
        if (this._memosAlive !== null && now - this._queueCheckedAt < 30000) return this._memosAlive;
        this._queueCheckedAt = now;
        this._memosAlive = await new Promise((resolve) => {
            try {
                const req = http.get({ host: '127.0.0.1', port: MEMOS_PORT, path: '/health', timeout: 1200 }, (res) => {
                    res.resume();
                    resolve(res.statusCode === 200);
                });
                req.on('error', () => resolve(false));
                req.setTimeout(1200, () => { try { req.destroy(); } catch (e) {} resolve(false); });
            } catch (e) { resolve(false); }
        });
        return this._memosAlive;
    }

    /** 把队列里攒着的条目写回去（成功一条删一条，失败保留） */
    async _drainQueue() {
        if (!(await this._memosReachable())) return 0;
        const items = this._queueLoad();
        if (!items.length) return 0;
        const remaining = [];
        let written = 0;
        let skipped = 0;
        for (const it of items) {
            // 2026-11-22：历史队列里可能已经混进主动脚手架（修复前入队的）。
            // 重放出口也必须过同一道过滤，否则旧污染会原样再喂给 MemOS。
            if (this._isScaffoldText(it.text)) { skipped += 1; continue; }
            const res = await this._post('/add', {
                messages: [{ role: 'user', content: '(他说的，值得记住)' + it.text }],
                user_id: USER_ID,
                source: 'evolve',   // B2 来源标注：反思/演化队列重放
            });
            // 2026-11-21 审计 P0：原来 `ok && !ok.error`（ok 是响应对象，恒真）→ 后端
            // 200+status:failed 也算写成功，队列条目被删。现在只认机器可读契约。
            if (isAddOk(res)) { written += 1; continue; }
            remaining.push(it);
        }
        this._queueWrite(remaining);
        if (written) this.context.log('info', '[记忆演化] 队列补写成功 ' + written + ' 条（剩 ' + remaining.length + '）');
        if (skipped) {
            this._stats.scaffoldSkipped += skipped;
            this.context.log('info', '[记忆演化] 队列重放剔除脚手架 ' + skipped + ' 条（不再喂给 MemOS）');
        }
        return written;
    }

    /**
     * 这条文本是不是「程序对她说的话」（主动开口提示词/控制标记）。
     * 复用 memory-recall 的 isScaffolding 契约（js/core/memory-scaffold.js）。
     * 任何异常一律返回 false（fail-open）：过滤器坏了不能阻塞记忆写入。
     */
    _isScaffoldText(text) {
        const impl = this._scaffoldFilterImpl || scaffoldFilter;
        try {
            return !!(impl && typeof impl.isScaffolding === 'function' && impl.isScaffolding(text, 'user'));
        } catch (e) {
            try {
                this.context.log('warn', '[记忆演化] 脚手架判定失败（本条放行）: ' + ((e && e.message) || e));
            } catch (e2) { /* 日志失败也不改变「放行」 */ }
            return false;
        }
    }

    // 给一句话打分：0~1，越大越值得记
    _score(text) {
        const s = String(text || '').trim();
        if (!s) return 0;
        // 2026-11-22：主动脚手架先归零。原来只看 RULES，watch-screen 提示词里
        // 只要 ASR 残片带了「我是…」就能拿满分过闸，最终写成用户事实。
        if (this._isScaffoldText(s)) return 0;
        for (const re of NOISE) if (re.test(s)) return 0;
        if (s.length < 4) return 0;
        let got = 0;
        for (const r of RULES) if (r.re.test(s)) got += r.w;
        if (!got) return 0;
        // 2.5 分就算「很值得记」：命中一条强规则基本直接过门。
        // 长度只做微调，不能因为句子短就把真信息丢掉。
        const base = Math.min(1, got / 2.5);
        const lenBonus = Math.min(1, s.length / 20);
        return Math.max(0, Math.min(1, base * 0.8 + lenBonus * 0.2));
    }

    _get(route) {
        return new Promise((resolve) => {
            try {
                const req = http.get({ host: '127.0.0.1', port: MEMOS_PORT, path: route, timeout: 15000 }, (res) => {
                    let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(null); } });
                });
                req.on('error', () => resolve(null));
                req.setTimeout(15000, () => { req.destroy(); resolve(null); });
            } catch (e) { resolve(null); }
        });
    }

    _post(route, body) {
        return new Promise((resolve) => {
            try {
                const data = Buffer.from(JSON.stringify(body), 'utf8');
                const req = http.request({
                    host: '127.0.0.1', port: MEMOS_PORT, path: route, method: 'POST',
                    // 服务端 /add 实测 72~120 秒（提取+嵌入+图谱），20s 会把正式写入全灭
                    // （2026-11-01 E2E 实锤，见交接 §3 bug1）。
                    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 150000,
                }, (res) => {
                    let s = '';
                    res.on('data', (c) => { s += c; });
                    res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(null); } });
                });
                req.on('error', () => resolve(null));
                req.setTimeout(150000, () => { try { req.destroy(); } catch (e) { try { __silentAudit.audit('index.js:114', e); } catch (e2) {} } resolve(null); });
                req.write(data); req.end();
            } catch (e) { resolve(null); }
        });
    }

    async onLLMResponse(response) {
        if (!this._enabled || !response || response.proactive_internal) return;
        const messages = this.context.getMessages ? this.context.getMessages() : [];
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        if (!lastUser || typeof lastUser.content !== 'string') return;
        const text = lastUser.content.trim();
        // bug4 守卫（2026-11-02）：喂「嗯」这类轮次时，宿主 getMessages() 会滞后返回
        // 上一轮的 user 消息 → 同一句重复入队（E2E 实锤，见交接 0040 §3）。
        // 文本没前进 = 这不是新消息，直接跳过；真重复说的话首轮已入队，巩固去重会兜住。
        if (text === this._lastSeenUserText) return;
        this._lastSeenUserText = text;
        // 2026-11-22 记忆污染：主动开口提示词（watch-screen / auto-chat / alive-state /
        // dawn-dusk / intent-queue）在 llm-handler 里也是 role=user，会走到这里。
        // 它们不是「他说的话」，既不进反思打分，也不入待写队列。
        if (this._isScaffoldText(text)) {
            this._stats.scaffoldSkipped += 1;
            this.context.log('info', '[记忆演化] 脚手架消息跳过（不入队/不写 MemOS）: ' + text.slice(0, 26));
            return;
        }
        // 记忆 v2：重要性累加（只打标记，不在这里跑 LLM；真正反思等空闲节拍）
        if (this._reflectEnabled) this._noteImportance(text);
        const score = this._score(text);
        this._turns += 1;
        if (score >= this._gate) {
            this._pending.push({ text, score: +score.toFixed(2) });
            this._stats.gated += 1;
            // 2026-11-21 审计 P0：过闸**当场**落盘一条（不是等攒够 2 条再批量 append）。
            // 单条记忆的唯一落盘点原来是 _consolidate，而它 <2 条直接 return —— 等于
            // 「只说一句值得记的话」永远不进队列，重启即失。append 按 text 幂等。
            const before = this._queueLoad().length;
            this._queueAppend([{ text, score: +score.toFixed(2) }]);
            const after = this._queueLoad().length;
            if (after > before) this._stats.enqueued += 1;
            this.context.log('info', '[记忆演化] 门控通过 ' + score.toFixed(2) + ': ' + text.slice(0, 30)
                + '（已入待写队列 ' + after + ' 条）');
        } else if (score > 0) {
            this.context.log('info', '[记忆演化] 门控跳过 ' + score.toFixed(2) + ': ' + text.slice(0, 24));
        }
        // 巩固改**后台**跑（2026-11-15 五十八轮）：MemOS /add 实测 72–120s，原来在这里
        // await，而这段在 TTS 之前 —— MemOS 一挂起，回复后链路最多卡 150 秒。
        // 丢后台 + 防重入；写盘队列保证「这次没写成」也不丢。
        // 2026-11-21：单条不再在这里触发（<2 条批量启发式本来就是空转），交给定时 flush，
        // 否则后台任务会占着 _consolidating 让 flush 空等。
        if (!this._consolidating && this._pending.length >= 2) {
            this._consolidating = true;
            Promise.resolve()
                .then(() => this._maybeConsolidate())
                .catch((e) => { try { this.context.log('warn', '[记忆演化] 后台巩固异常: ' + (e && e.message || e)); } catch (e2) {} })
                .finally(() => { this._consolidating = false; });
        }
    }

    // ── 语义段级巩固触发（LycheeMemory 思路，向量来自 8090 本地嵌入，零 API 费）：──
    // 新句 vs 已攒批语义重心 cos 相似度 < 阈值 → 话题切了段，先巩固上一段；
    // 硬上限 _every*2 防「话题一直相近就永远不巩固」；嵌入不可用回落固定窗口（提示一次）。
    async _maybeConsolidate() {
        if (!this._pending.length) return;
        if (this._pending.length >= this._every * 2) return this._consolidate('上限');
        if (this._pending.length < 2) return;
        try {
            const last = this._pending[this._pending.length - 1];
            const vLast = await this._embedOne(last.text);
            const prevVecs = [];
            for (const p of this._pending.slice(0, -1)) prevVecs.push(await this._embedOne(p.text));
            const mean = new Array(vLast.length).fill(0);
            for (const v of prevVecs) for (let i = 0; i < mean.length; i++) mean[i] += v[i];
            for (let i = 0; i < mean.length; i++) mean[i] /= prevVecs.length;
            const sim = this._cos(vLast, mean);
            if (sim < this._segThreshold) {
                this.context.log('info', '[记忆演化] 语义切段（相似度 ' + sim.toFixed(2) + ' < ' + this._segThreshold + '）：先巩固上一段');
                return this._consolidate('切段');
            }
        } catch (e) {
            if (!this._embedWarned) {
                this._embedWarned = true;
                this.context.log('warn', '[记忆演化] 语义切段不可用（' + (e && e.message || e) + '），回落固定 ' + this._every + ' 轮窗口');
            }
            if (this._turns % this._every === 0) return this._consolidate('窗口');
        }
    }

    async _embedOne(text) {
        if (this._vecCache.has(text)) return this._vecCache.get(text);
        const vecs = await new Promise((resolve) => {
            try {
                const data = Buffer.from(JSON.stringify({ input: [String(text)], model: 'qwen3-embed' }), 'utf8');
                const req = require('http').request({
                    host: '127.0.0.1', port: 8090, path: '/v1/embeddings', method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 15000,
                }, (res) => {
                    let s = ''; res.on('data', (c) => { s += c; });
                    res.on('end', () => { try { const j = JSON.parse(s); resolve((j.data || []).map((d) => d.embedding)); } catch (e) { resolve(null); } });
                });
                req.on('error', () => resolve(null));
                req.setTimeout(15000, () => { try { req.destroy(); } catch (e) { try { __silentAudit.audit('index.js:185', e); } catch (e2) {} } resolve(null); });
                req.write(data); req.end();
            } catch (e) { resolve(null); }
        });
        const vec = vecs && vecs[0];
        if (!vec || !vec.length) throw new Error('8090 嵌入不可用');
        if (this._vecCache.size > 50) this._vecCache.delete(this._vecCache.keys().next().value);
        this._vecCache.set(text, vec);
        return vec;
    }

    _cos(a, b) {
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length && i < b.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 1;
    }

    // 长期巩固：去重后写库，并留整理日志
    async _consolidate(tag) {
        if (!this._pending.length) return;
        const batch = this._pending.splice(0, this._pending.length);

        // ① 先落盘队列 —— 写盘之后这批才算「安全」。后面任何一步失败都只是「还没写成」，
        //    不是「丢了」（原实现是 splice 完直接撞网络，失败只 warn → 整批消失）。
        this._queueAppend(batch);

        // ② MemOS 不在线：别一条一条撞 150s 超时。队列留着，等它回来重放。
        if (!(await this._memosReachable())) {
            this.context.log('warn', '[记忆演化] MemOS(8003) 不在线：' + batch.length + ' 条已进待写队列（不丢，回来自动补写）');
            return;
        }

        const kept = [], duped = [], skipped = [];
        for (const item of batch) {
            // 2026-11-22：写库前的最后一道出口。即使调用方漏了门控（或旧版本已入队），
            // 主动脚手架也不能以「(他说的，值得记住)…」的形式进 MemOS。
            if (this._isScaffoldText(item.text)) { skipped.push(item); continue; }
            let known = false;
            try {
                const r = await this._post('/search', {
                    query: item.text, top_k: 3, user_id: USER_ID, similarity_threshold: 0.3,
                });
                const hits = (r && (r.memories || r.results)) || [];
                // MemOS 返回两个分数：similarity（纯语义，0~1）和 final_score（混合，会 >1）。
                // 去重必须用 similarity —— 用 final_score 会把"同属工作"的旧记忆全判成重复。
                // 而且光看相似度还不够：「下个周五要面试」与「下个月换工作」相似度 0.83，
                // 但那是两件事。所以加一道「关键实体重合」校验，两个条件都满足才算重复。
                known = hits.some((m) => {
                    const sim = Number(m.similarity ?? m.vector_score ?? 0);
                    if (sim < this._dedupeEff) return false;
                    return this._keyOverlap(item.text, String(m.content || ''));
                });
            } catch (e) { try { __silentAudit.audit('index.js:223', e); } catch (e2) {} }
            if (known) { duped.push(item); continue; }
            const ok = await this._post('/add', {
                messages: [{ role: 'user', content: '(他说的，值得记住)' + item.text }],
                user_id: USER_ID,
                source: 'evolve',   // B2 来源标注：反思提炼出的结论
            });
            if (isAddOk(ok)) {
                kept.push(item);
                this._stats.addOk += 1;
            } else {
                this._stats.addFail += 1;
                this.context.log('warn', '[记忆演化] /add 未确认（留在队列里等重放）: ' + item.text.slice(0, 24)
                    + ' → ' + addErrorText(ok));
            }
        }

        // ③ 写成的（含判重跳过的）从队列删掉，没写成的继续留着
        const doneText = new Set([...kept, ...duped, ...skipped].map((x) => x.text));
        try {
            const remaining = this._queueLoad().filter((q) => !doneText.has(q.text));
            this._queueWrite(remaining);
        } catch (e) { try { __silentAudit.audit('index.js:236', e); } catch (e2) {} }

        if (skipped.length) this._stats.scaffoldSkipped += skipped.length;
        const rec = { at: this._localStamp(), kept, duped, skipped };
        this._log.push(rec);
        try { this._writeDigest(rec); } catch (e) { try { __silentAudit.audit('index.js:234', e); } catch (e2) {} }
        this.context.log('info', '[记忆演化] 巩固完成（' + (tag || '常规') + '）：新记 ' + kept.length + ' 条，重复跳过 '
            + duped.length + ' 条，脚手架剔除 ' + skipped.length + ' 条');
        try { await this._archiveSweep(); } catch (e) { this.context.log('warn', '[记忆演化] 归档清扫异常: ' + (e && e.message)); }
        // ④ 顺手把历史积压的队列冲一遍（在线时几乎零成本）
        try { await this._drainQueue(); } catch (e) { /* 冲队列失败不影响本轮结论 */ }
    }

    // ── 效用归档（CraniMem 思路，见 docs/研究-论文调研-记忆与主动性）：──────
    // 90 天没被召回（access_count=0）且重要度 <0.5 的冷记忆 → 移入 记忆归档.json（可恢复），
    // 再从 MemOS 删除。库只进不出会变垃圾场；情绪衰减已有生命周期，事实记忆补上这半边。
    // 现存记忆都太年轻（库里 31 条全是近几天的），机制先上线空转，等库龄到了自然生效。
    async _archiveSweep() {
        const RETENTION_DAYS = 90;
        const MAX_IMPORTANCE = 0.5;
        const list = await this._get('/list');
        const items = (list && (list.memories || list.items)) || [];
        const cutoff = Date.now() - RETENTION_DAYS * 86400000;
        const victims = items.filter((m) => {
            const acc = Number(m.access_count ?? 0);
            const imp = Number(m.importance ?? 1);
            const last = Date.parse(m.last_accessed_at || m.created_at || '') || 0;
            return acc === 0 && imp < MAX_IMPORTANCE && last > 0 && last < cutoff;
        });
        if (!victims.length) return { archived: 0 };
        const archivePath = this._dir
            ? path.join(this._dir, '..', '记忆归档.json')
            : path.join(os.tmpdir(), 'dafeiyu-记忆归档.json');
        let archive = [];
        try { archive = JSON.parse(fs.readFileSync(archivePath, 'utf8')); } catch (e) { try { __silentAudit.audit('index.js:260', e); } catch (e2) {} }
        for (const m of victims) {
            archive.push({ archivedAt: new Date().toISOString(), content: m.content || m.memory || '', raw: m });
            const r = await this._post('/delete_memory', { memory_id: m.id || m.memory_id, user_id: USER_ID });
            if (r && r.error) this.context.log('warn', '[记忆演化] 归档删除失败: ' + JSON.stringify(r).slice(0, 120));
        }
        fs.writeFileSync(archivePath, JSON.stringify(archive, null, 2), 'utf8');
        this.context.log('info', '[记忆演化] 效用归档：' + victims.length + ' 条冷记忆移入归档（' + path.basename(archivePath) + '，可恢复）');
        return { archived: victims.length };
    }

    // 本地时间戳「YYYY-MM-DD HH:MM」：toISOString 是 UTC，会把 18:16 写成 10:16，
    // 凌晨还会把摘要写进前一天的日期文件（2026-11-01 E2E bug5）。
    _localStamp() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    _writeDigest(rec) {
        if (!this._dir) return;
        const day = rec.at.slice(0, 10);
        const file = path.join(this._dir, day + '.md');
        const lines = [];
        if (!fs.existsSync(file)) lines.push('# ' + day + ' 记忆整理', '');
        lines.push('## ' + rec.at.slice(11, 16));
        if (rec.kept.length) {
            lines.push('**新记住：**');
            for (const k of rec.kept) lines.push('- (' + k.score + ') ' + k.text);
        }
        if (rec.duped.length) {
            lines.push('', '**已经记得，跳过：**');
            for (const d of rec.duped) lines.push('- ' + d.text);
        }
        lines.push('');
        fs.appendFileSync(file, lines.join('\n'), 'utf8');
    }

    // 关键实体重合：把两句里「有信息量的词」抽出来，看有没有共同项。
    // 中文没有空格，这里用 2-gram + 数字/时间词做粗粒度比对 —— 够用来挡住
    // "面试 vs 换工作" 这种语义相近但事实不同的误判。
    _keyOverlap(a, b) {
        const strip = (s) => String(s || '').replace(/[\s，。！？、,.!?：:；;"'''（）()「」]/g, '');
        const A = strip(a), B = strip(b);
        if (!A || !B) return false;
        const grams = (s) => {
            const out = new Set();
            for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
            const nums = s.match(/[0-9一二三四五六七八九十百千万]+/g) || [];
            nums.forEach((n) => out.add(n));
            return out;
        };
        const ga = grams(A), gb = grams(B);
        let hit = 0;
        for (const g of ga) if (gb.has(g)) hit++;
        const ratio = hit / Math.max(1, Math.min(ga.size, gb.size));
        return ratio >= 0.5;
    }

    // 给体检/调试用：只看打分，不写库
    inspect(text) {
        const s = String(text || '');
        return {
            text: s,
            score: +this._score(s).toFixed(2),
            gate: this._gate,
            reflect: {
                enabled: !!this._reflectEnabled,
                importance: scoreEvent(s),
                pending: !!this._reflectPending,
                remain: this._reflectTrigger ? this._reflectTrigger.remain : null,
                threshold: this._reflectThreshold,
                dailyCap: this._reflectCap,
                state: this._reflectState,
            },
        };
    }

    getTools() { return []; }
}

module.exports = MemoryEvolvePlugin;
