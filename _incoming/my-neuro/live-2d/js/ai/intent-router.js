// intent-router.js —— 意图前置路由（Jev/System-One 思路的本地落地，拍板：本地小模型 0.5-3B）。
//
// 第一性原理：每轮请求都带 13.5k 字符的工具 schema，但纯闲聊轮根本用不上——
// 用本地 qwen3:0.6b（Ollama，热载 ~250-500ms）先分意图：
//   chat（高置信）→ 本轮不带工具（schema 省 13.5k/轮，模型注意力也更聚焦）
//   tool / memory / unknown → 带全套工具（能力不折损）
// 失败兜底：超时/Ollama 没跑 → unknown → 全量工具，**路由永远不能让能力变弱**。
//
// 配置（config.llm.intent_router）：
//   enabled 默认 true；min_confidence 默认 0.85；timeout_ms 默认 2500；
//   model 默认 'qwen3:0.6b'；ollama 默认 'http://127.0.0.1:11434'
//   llm_enabled 缺省 **true**（保持旧语义；产品 config.json 显式 false 停用 qwen3:0.6b）。
//     2026-11-22 离线 A/B（200 条真实 user 话术，规则+嵌入 vs 三条链）：
//       · 三分类一致率 78.5%（未过 90% 线，但差距 100% 是 unknown↔chat）
//       · tool→chat = 0、chat→tool = 0、label↔label 翻转 = 0（A 的标签是 B 的子集）
//       · unknown 25.5% vs 4.0%；unknown 走全量工具，且 omit_tools 默认 false，
//         所以 chat 标签当前根本不参与「带不带工具」——能力零收窄。
//     回滚：config.llm.intent_router.llm_enabled = true（或删掉该键，缺省即 true）。
//   LLM 关闭时仍走 嵌入快通道；两者都不判定 → unknown（与旧版 LLM 失败/超时同语义）。
'use strict';
const { logToTerminal } = require('../api-utils.js');

const FEWSHOT_PROMPT = `你是意图分类器。把用户输入分类为 chat（闲聊/情感陪伴/聊天）或 tool（操控电脑/游戏/截图/音量等要工具执行）或 memory（询问过去的事/记忆/回忆）。只输出 JSON {"intent":"...","confidence":0.0}。

例：
输入：今天好累啊 → {"intent":"chat","confidence":0.9}
输入：帮我把音量调小 → {"intent":"tool","confidence":0.9}
输入：还记得我的猫叫什么吗 → {"intent":"memory","confidence":0.9}
输入：帮我点一下屏幕上的确定按钮 → {"intent":"tool","confidence":0.9}
输入：你在想什么呢 → {"intent":"chat","confidence":0.9}

用户输入：`;

const state = { ollamaDownUntil: 0 };   // Ollama 失联退避：60s 内不再白打请求
const embedDownUntil = { t: 0, fails: 0, lastWarnAt: 0 };        // 8090 失联退避（指数）

// llm_enabled 缺省值：true = 旧版行为（配置没这个键时行为不变）。
// 停用靠 config.json 显式 llm_enabled:false；A/B 未过 90% 一致率线，故不把缺省改成 false。
const DEFAULT_LLM_ENABLED = true;

// 观测计数（只读出口，不改路由行为）。运维/探针看「小模型有没有被白白调用」：
//   calls        过了 enabled/空文本/超长守卫的 classifyIntent 次数
//   embedHits    嵌入快通道给出判定
//   llmCalls     真正发出的 Ollama 生成请求
//   llmHits      小模型给出 chat/tool/memory
//   llmSkipped   llm_enabled=false 被拦下（**不发请求**，这是停用后的主指标）
//   unknown      最终 unknown（各回落路径合计）
const stats = {
    calls: 0,
    embedHits: 0,
    llmCalls: 0,
    llmHits: 0,
    llmSkipped: 0,
    unknown: 0,
    errors: 0,
};

function resetStats() {
    for (const k of Object.keys(stats)) stats[k] = 0;
}

// 嵌入快通道的标注样例（Jev Noul 原语的同款思路：脏文本归枚举类）。
// GPU 被皮套占到 75% 时 0.6B 生成要 3.4s+，而 8090 嵌入只要 ~30ms——先走嵌入，
// 分不开（差距小）再交给小模型慢通道。
const EMBED_EXAMPLES = {
    chat: ['今天好累啊', '你在想什么呢', '陪我聊聊天吧', '哈哈笑死我了'],
    tool: ['帮我把音量调小一点', '帮我截个屏看看屏幕', '点一下屏幕上的确定按钮', '帮我打开记事本'],
    memory: ['还记得我的猫叫什么吗', '我们上次聊了什么来着', '之前你说过的那件事呢'],
};

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** 嵌入快通道：一次请求嵌入「样例+输入」，余弦三分类。返回 null = 不判定（走慢通道）。 */
async function embedClassify(text, cfg) {
    // ⚠ 2026-11-10 审计抓到：原来先 `.replace(/:\d+$/,'')` 剥端口、下一行又测 `/:\d+/` 有没有端口 ——
    //   配置里的端口永远被吃掉（且带尾斜杠会拼出 `//v1/embeddings`）。
    //   现在按意图重建：显式 embed_url 优先；否则取 ollama 配置的 **host** + 嵌入端口（默认 8090）。
    const explicit = String(cfg.embed_url || '').trim();
    let url;
    if (explicit) {
        url = explicit.replace(/\/+$/, '') + '/v1/embeddings';
    } else {
        const host = String(cfg.ollama || '')
            .replace(/^https?:\/\//i, '')
            .split('/')[0]
            .split(':')[0]
            || '127.0.0.1';
        const port = Number(cfg.embed_port) || 8090;
        url = 'http://' + host + ':' + port + '/v1/embeddings';
    }
    if (Date.now() < embedDownUntil.t) return null;
    const inputs = [...EMBED_EXAMPLES.chat, ...EMBED_EXAMPLES.tool, ...EMBED_EXAMPLES.memory, text];
    const nChat = EMBED_EXAMPLES.chat.length, nTool = EMBED_EXAMPLES.tool.length;
    try {
        const res = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: inputs }),
            signal: AbortSignal.timeout(1200),
        });
        if (!res.ok) throw new Error('status ' + res.status);
        const data = await res.json();
        const vecs = (data.data || []).map((d) => d.embedding);
        if (vecs.length !== inputs.length) throw new Error('嵌入数量不齐');
        const q = vecs[vecs.length - 1];
        const sims = { chat: [], tool: [], memory: [] };
        vecs.slice(0, -1).forEach((v, i) => {
            if (i < nChat) sims.chat.push(cosine(q, v));
            else if (i < nChat + nTool) sims.tool.push(cosine(q, v));
            else sims.memory.push(cosine(q, v));
        });
        const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
        const ranked = Object.entries(sims).map(([k, v]) => [k, avg(v)]).sort((a, b) => b[1] - a[1]);
        const [topK, topV] = ranked[0];
        const margin = topV - ranked[1][1];
        embedDownUntil.fails = 0;   // 成功一次就把退避计数清零
        // 差距太小=分不开，交给慢通道；阈值取保守值（宁可多走慢通道也别错路由）
        if (topV < 0.35 || margin < 0.02) return null;
        return { intent: topK, confidence: Math.min(0.95, +(0.55 + margin * 3).toFixed(2)), via: 'embed', margin: +margin.toFixed(3) };
    } catch (e) {
        // 指数退避 + 限频（2026-11-10 三十九轮）：原来固定 60s、且**每次失联都刷一条 warn**
        // （实测 32 次）；8090 短暂繁忙就会让日志看起来像在报故障。现在 60s→120→240→480 封顶
        // 10 分钟，且 2 分钟内只提示一次——功能上本来就有本地判定兜底，不需要每轮喊。
        embedDownUntil.fails = (embedDownUntil.fails || 0) + 1;
        const wait = Math.min(600000, 60000 * Math.pow(2, Math.min(3, embedDownUntil.fails - 1)));
        embedDownUntil.t = Date.now() + wait;
        if (Date.now() - (embedDownUntil.lastWarnAt || 0) > 120000) {
            embedDownUntil.lastWarnAt = Date.now();
            logToTerminal('warn', '[意图路由] 嵌入快通道失联，退避 ' + Math.round(wait / 1000) +
                's（连续 ' + embedDownUntil.fails + ' 次；期间走本地/小模型判定，功能不受影响）');
        }
        return null;
    }
}

/**
 * ⚡ 零延迟本地意图判定（2026-11-08 性能重做）。
 *
 * 为什么需要它：原 `classifyIntent` 走 8090 嵌入或 qwen3:0.6b，热载 250-2500ms，
 * 而它被 `await` 在主链上——用户每轮对话凭空多等这么久，听感就是「说话一顿顿」。
 *
 * 第一性原理：路由的收益是「chat 轮省 13.5k 工具 schema」，
 * 成本必须 ≪ 收益。纯关键词/正则判定是**微秒级、零网络、零 GPU**，
 * 只要覆盖「明显是闲聊」的那部分，就已经拿到大部分收益，且永不拖慢对话。
 *
 * 保守策略：**只在高置信闲聊时才返回 chat**（宁可多带工具，也不能因为误判让她说"我做不到"）。
 * 只要出现「电脑/屏幕/窗口/文件/音量/打开/搜索/点击/按键…」等操作词，一律 unknown（带全量工具）。
 */
// 强操作词：本身就是动词/明确的动作指令，出现即大概率真要动手
const TOOL_HINTS_STRONG = /(打开|关闭|关掉|启动|运行|点击|点一下|按一下|按下|打字|截个屏|截屏|截图|保存|删除|复制|粘贴|静音|播放|暂停|切换|搜索|查一下|查询|帮我找|下载|安装|卸载|调小|调大|调到|按键|键盘|鼠标|报错|编译|几点了|今天几号|天气|翻译|计算|算一下|列表|列出|有哪些|开着哪些|执行)/;
// 泛指名词（§10.2#19）：**单独出现不算工具意图**。
// 实测（2026-11-09）：8 条含泛指名词的闲聊里 6 条被误判成 tool；
// 更严重的是带 52 工具时模型会真的误调——「这个电影的声音好好听」→ 调 cowatch_now，
// 「我电脑屏幕好亮」→ 调 execute_code。这不是多花 230ms 的问题，是她会真去执行动作。
// 所以这些词必须**配合操作动词**才算工具意图（见 classifyIntentLocal 的组合判定）。
const GENERIC_NOUNS = /(屏幕|窗口|桌面|文件|文件夹|目录|音量|声音|设置|游戏|代码|输入)/;
// 复合场景词：这类词本身偏操作语义，保留在强表里由 TOOL_HINTS_STRONG 覆盖不到的场合
const TOOL_HINTS = TOOL_HINTS_STRONG;   // 兼容旧引用
const MEMORY_HINTS = /(还记得|记不记得|上次|之前聊过|以前说过|我们聊过|你记得|回忆|曾经)/;
const CHAT_HINTS = /(好累|无聊|开心|难过|心情|陪我|聊聊|在吗|在干嘛|想你|喜欢你|晚安|早安|抱抱|摸摸|撒娇|亲亲|哈哈|笑死|好看|可爱|厉害|谢谢|对不起|辛苦|怎么样|你呢)/;
// 否定式兜底（§10.2#8）：委托/指令句式哪怕混着情感词也大概率是要她动手——
// 「在吗？把灯关一下」「谢谢，把这首歌收藏了」「你呢？明早提醒我带伞」
// 含 CHAT_HINTS 但无 TOOL_HINTS，误判 chat 会让她说「我做不到」。
// 命中此表一律 unknown（带全量工具）：能力不折损是硬口径。
const DELEGATION_HINTS = /(帮我|给我|替我|帮我个忙|把.{0,12}(关|开|删|存|收|发|改|调|设)|记得.{0,12}(提醒|关|存|发)|提醒我|待会儿|待会|帮我查|帮我搜|帮我打开|帮我关)/;
// 泛指名词 + 这些动词共现 → 视为真操作意图（§10.2#19 上下文权重）
const GENERIC_ACTION_VERBS = /(打开|关闭|关掉|启动|运行|点|按|输入|打字|调|调小|调大|静音|播放|暂停|切换|搜|查|看一?下|截|保存|删除|复制|粘贴|安装|卸载|放大|缩小|新建|创建|移动|重命名|整理|清理)/;

function classifyIntentLocal(promptText) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const text = String(promptText || '').trim();
    let out = { intent: 'unknown', confidence: 0, ms: 0, via: 'local' };
    if (!text || text.length > 500) return out;

    // ① 强操作词直达（§10.2#19：泛指名词已从强表移除，不会单独命中）
    const hasStrong = TOOL_HINTS_STRONG.test(text);
    // ② 泛指名词 + 操作动词共现 → 才算真操作意图
    const hasGenericWithVerb = GENERIC_NOUNS.test(text) && GENERIC_ACTION_VERBS.test(text);

    if (hasStrong || hasGenericWithVerb) {
        out = { intent: 'tool', confidence: hasStrong ? 0.95 : 0.8, ms: 0, via: hasStrong ? 'local' : 'local-generic+verb' };
    } else if (DELEGATION_HINTS.test(text)) {
        // 委托句式兜底：宁可错带工具（多 13.5k prefill），不可漏带（她说做不到）
        out = { intent: 'tool', confidence: 0.85, ms: 0, via: 'local-delegation' };
    } else if (MEMORY_HINTS.test(text)) {
        out = { intent: 'memory', confidence: 0.9, ms: 0, via: 'local' };  // 回忆类 → 带全量工具
    } else if (CHAT_HINTS.test(text) && text.length <= 60) {
        // 明显闲聊（有情感词、且不长）→ 省工具；长文本可能是复杂任务，保守起见带工具
        out = { intent: 'chat', confidence: 0.9, ms: 0, via: 'local' };
    }
    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    out.ms = Math.round((t1 - t0) * 1000) / 1000;   // 通常 0.01-0.1ms
    return out;
}

async function classifyIntent(promptText, config) {
    const cfg = (config && config.llm && config.llm.intent_router) || {};
    if (cfg.enabled === false) return { intent: 'unknown', confidence: 0, ms: 0, skip: 'disabled' };
    const text = String(promptText || '').trim();
    if (!text || text.length > 500) return { intent: 'unknown', confidence: 0, ms: 0, skip: 'no-text' };

    const t0 = Date.now();
    stats.calls += 1;
    // ① 嵌入快通道（~30ms）：判定果断就直接用，GPU 再忙也不受影响
    const fast = await embedClassify(text, cfg).catch(() => null);
    if (fast) {
        stats.embedHits += 1;
        return { intent: fast.intent, confidence: fast.confidence, ms: Date.now() - t0, via: fast.via };
    }

    // ①.5 llm_enabled=false（config.json 显式停用时）：嵌入分不开就停在这里，**绝不发 Ollama 请求**。
    // 返回形状与旧版「LLM 失败/超时」完全一致（intent=unknown、confidence=0），
    // 调用方（shouldOmitTools / llm-handler）看到 unknown 一律带全量工具，能力不变窄。
    const llmEnabled = cfg.llm_enabled === undefined ? DEFAULT_LLM_ENABLED : cfg.llm_enabled !== false;
    if (!llmEnabled) {
        stats.llmSkipped += 1;
        stats.unknown += 1;
        return { intent: 'unknown', confidence: 0, ms: Date.now() - t0, skip: 'llm-disabled' };
    }

    // ② 小模型慢通道（GPU 空闲时 250-500ms，忙时可能超时回落）
    if (Date.now() < state.ollamaDownUntil) {
        stats.unknown += 1;
        return { intent: 'unknown', confidence: 0, ms: 0, skip: 'backoff' };
    }

    const base = String(cfg.ollama || 'http://127.0.0.1:11434');
    const model = String(cfg.model || 'qwen3:0.6b');
    // 2500ms：模型闲置 10 分钟会被 Ollama 卸载，冷载 0.6B 要 2-4s——超时太紧=每轮都撞冷载回落
    const timeoutMs = Math.max(800, Number(cfg.timeout_ms) || 2500);

    try {
        const body = JSON.stringify({
            model,
            prompt: FEWSHOT_PROMPT + text,
            stream: false,
            format: 'json',
            think: false,
            keep_alive: '30m',   // 冷载是延迟杀手：保 30 分钟热，VRAM 代价 ~0.5GB 值得
            options: { num_predict: 40, temperature: 0 },
        });
        stats.llmCalls += 1;
        const res = await fetch(base + '/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error('status ' + res.status);
        const data = await res.json();
        const parsed = JSON.parse(String(data.response || '{}'));
        const intent = ['chat', 'tool', 'memory'].includes(parsed.intent) ? parsed.intent : 'unknown';
        const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
        if (intent === 'unknown') stats.unknown += 1; else stats.llmHits += 1;
        return { intent, confidence, ms: Date.now() - t0 };
    } catch (e) {
        state.ollamaDownUntil = Date.now() + 60000;   // 失联退避 60s
        stats.errors += 1;
        stats.unknown += 1;
        logToTerminal('warn', '[意图路由] 失联退避 60s（' + String((e && e.message) || e).slice(0, 60) + '）——期间全量工具不受影响');
        return { intent: 'unknown', confidence: 0, ms: Date.now() - t0, skip: 'error: ' + String(e && e.message || e).slice(0, 60) };
    }
}

/** 本轮要不要带工具：chat 且置信过线才省（保守——误判的代价是她说「做不到」，比卡顿贵）。 */
function shouldOmitTools(intentResult, config) {
    const cfg = (config && config.llm && config.llm.intent_router) || {};
    // ⚠ 2026-11-15 六十二轮：默认**不再省 schema**。
    // 实测原因：tools 在/不在会让 prompt 前缀在两种形态间来回切换
    //（带 tools ≈9k token / 不带 ≈3.3k token），每切一次 = 整段历史缓存作废
    //（切到无工具那轮 cached 直接 0%）。省下的 13.5k 字符在稳定前缀下本来就是
    // 缓存命中的（≈0 成本），所以得不偿失。
    // 想恢复旧行为：config.llm.intent_router.omit_tools = true。
    if (cfg.omit_tools !== true) return false;
    const minConf = Number(cfg.min_confidence) || 0.85;
    return intentResult.intent === 'chat' && intentResult.confidence >= minConf;
}

module.exports = { classifyIntent, classifyIntentLocal, shouldOmitTools, FEWSHOT_PROMPT, stats, resetStats, DEFAULT_LLM_ENABLED };
