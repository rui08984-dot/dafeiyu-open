// js/core/memory-scaffold.js —— 「程序对她说的话」vs「真正发生过的话」的唯一判定源。
//
// 背景（2026-11-22 记忆污染）：
//   watch-screen / auto-chat / alive-state / dawn-dusk / intent-queue 的主动开口
//   提示词会被 llm-handler 当作 role=user 推进 voiceChat.messages（js/ai/llm-handler.js:472），
//   随后 memory-evolve / built-in memos 的 onLLMResponse 从 getMessages() 里取
//   「最后一条 user 消息」发给 MemOS /add。Python 侧一律标成「【主人】」
//   （plugins-dlc/memos/memos_system/api/memos_api_server_v2.py:1857），于是
//   「（你正和用户一起看屏幕…）」被写成用户事实/偏好。
//
// 这里把 memory-recall 2026-11-21 质量轮已经验证过的 isScaffolding/isNoise
// 抽成共享契约：memory-recall 继续导出同名函数，memory-evolve / built-in memos
// 在**发给 MemOS 之前**复用同一套规则 —— 不允许再复制第二套正则。
//
// 判定边界（防误杀）：
//   · 只有 role=user 才可能是脚手架；assistant 说的内容是她自己的话，不在此列；
//   · 括号开头本身不是证据 ——「（笑）今天好热」是用户真实的动作描写，必须保留；
//   · 只认「程序提示词的稳定形状」：第二人称指令特征、[自动触发]、问候指令模板、
//     [需要截图] 控制标记等，不按语义猜。
'use strict';

// 第二人称指令特征（沿用 memory-recall 原规则，勿单独改动）
const SCAFFOLD_2P = /你(?:正|想|要|需要|必须|应该|自己|决定|打算|尽量)|系统|工具|以下是|提示词|不超过\s*\d+\s*个字|不要(?:重复|客套|复述|说)|别(?:客套|复述|硬找)|请(?:以|像|自然)/;

// 程序直接拼出来的「主动开口」入口。它们不一定以括号开头，但形状是固定的：
//   · auto-chat:            [自动触发] …（intent-queue 补说也沿用这一句）
//   · auto-chat 截图标记:    … [需要截图]
//   · watch-screen 多模态:  （屏幕截图）
//   · alive-state 摸头:     （他刚才摸了摸你的头。）
//   · dawn-dusk 主动问候:   （现在是早上8点，…跟对方说早安吧）
// 注意：这里只做「程序提示词」识别，不把普通用户说到时间/摸头的话算进来：
//   「现在是8点，我去上班了」「（他刚才摸了我的头）」都不会命中。
const PROGRAM_PROMPT_RULES = [
    /^\[自动触发\]/,
    /^\[需要截图\]\s*$/,
    /^[（(]屏幕截图[）)]$/,
    // 「他刚才…你」：要求第二人称，且中间最多 4 字（摸了摸你的头 / 戳了戳你）
    /^[（(]?他刚才(?:摸|拍|戳|抱|亲)[^。！？\n]{0,4}你/,
    // 晨昏问候模板：时间起头 + 明确的「对她说」指令动词。
    // 兼容「12点，」「12点了，」两种写法；只认程序用语，不把「现在是8点，我去上班了」算进来。
    /^[（(]?现在是[^\d，,。]{0,6}\d{1,2}点(?:了)?[，,][\s\S]{0,200}(?:如果你接下来要回复|请自然地?|不要生硬地报时|跟对方说|问问对方|提醒(?:对方|他|她|早点)|关心(?:一下)?对方|打个招呼)/,
    // ── 2026-11-22 补漏：直播事件 / 派活回执 / 自我状态注入 ─────────────────
    // 这一族都是「程序以 user 身份对她说的话」，形状稳定；都是**前缀锚定**，
    // 不按语义猜，也不影响普通用户写的括号动作（「（笑）今天好热」照旧保留）。
    // 直播：live-dock 的四类事件 + 弹幕（全部以「（你在直播」开头）
    /^[（(]你在直播[。，]/,
    // 派活回执：dispatch 的「（后台任务 t-xxx 干完了/失败/回报完成了…）」
    /^[（(]后台任务\s/,
    // 自我状态注入：inner-state / dynamic-persona / alive-state 的状态行
    /^[（(]你现在的状态[：:]/,
    /^[（(]你的身体状态[：:]/,
    // 重试/打断提示：只认程序固定续写，不误杀「（你上一句说得对）」这种用户回话
    /^[（(]你上一句(?:被截断|还没说完)/,
    /^[（(]你上一条(?:里有句)/,
    /^[（(]你最近几轮/,
    // 看屏环境头（vision-organ）：程序采集的描述，不是用户说的话
    /^[（(]你旁边的屏幕/,
];

/** role=user 且文本像「程序拼给她的提示词」→ true。失败/空文本一律 false（不误杀）。 */
function isScaffolding(text, role) {
    if (role !== 'user') return false;
    const t = String(text == null ? '' : text).trim();
    if (!t) return false;
    if (t.startsWith('```')) return true;              // 代码围栏整段
    if (/^[\[{]/.test(t)) {
        if (/"(?:ok|error|tool|steps|action)"\s*:/.test(t)) return true;   // 工具回执
        try { JSON.parse(t); return true; } catch (e) { /* 不是完整 JSON，按普通文本走 */ }
    }
    for (const re of PROGRAM_PROMPT_RULES) {
        if (re.test(t)) return true;
    }
    if (!/^[（(]/.test(t)) return false;
    return SCAFFOLD_2P.test(t);
}

// 这些不是「发生过的事」，是系统注入的脚手架或工具回执，
// 把它们编进索引会让检索命中一堆「[自动触发] 一句话 20 字以内…」垃圾。
// （规则整体沿用 memory-recall 2026-11-21 质量轮；新增脚手架请只改 isScaffolding。）
function isNoise(text, role) {
    if (!text) return true;
    if (isScaffolding(text, role)) return true;
    if (/^[\[（(]/.test(text) && /(自动触发|你正在旁边看|需要截图|系统)/.test(text)) return true;
    if (/硬性要求|本次角度|不要重复你最近说过的话/.test(text)) return true;
    // 主动说话提示词的分行残片（"3) 如果确实没什么可说的，就说一句带刺的吐槽…"）
    if (/^\s*\d+[)）.、]/.test(text) && /(不要|别|优先|如果)/.test(text)) return true;
    if (/别硬找话题|不要开场白|说一句带刺|口语，不要|用户没有说话/.test(text)) return true;
    if (text.startsWith('✅') || text.startsWith('⚠')) return true;
    if (text.startsWith('<') && text.length < 4) return true;
    // ── 2026-11-15 五十八轮实测补的五条 ────────────────────────────────────
    // 记忆库.txt 1066 行里：691 行是 `交互N：` 空占位、12 条分隔线、12 条日期头，
    // 全都被编进了索引 —— 检索会命中一堆空壳。日期头也不该当内容，只该当年份游标。
    if (/^交互\d+\s*[：:]\s*$/.test(text)) return true;
    if (/^[-=_*]{3,}$/.test(text)) return true;
    if (/^\[?\d{4}(?:[-/年])\d{1,2}(?:[-/月])\d{1,2}日?\]?$/.test(text)) return true;
    // 上下文压缩留下的系统标记：不是「发生过的事」，留着还会被当成最近对话
    if (/^\[(?:历史压缩|历史对话总结)\]/.test(text)) return true;
    // 2026-11-24 P0-2：工具回执限流的占位符（整条只有标记、没有内容）——
    // 工具结果被省略后，这条消息不该再被当成「对话」编进记忆索引。
    if (/^\[本轮工具输出累计超过 \d+ 字符/.test(text)) return true;
    // 2026-11-24 ADR-014：工具回执的「截断/续读/artifact 指针」也不是发生过的事。
    // 这些指针会随大输出频繁出现在 tool 消息里，编进索引会毒化召回（且路径本身无意义）。
    if (/^\[工具输出过长，已截断 \d+ 字符/.test(text)) return true;
    if (/tool-artifacts[\\/]/.test(text)) return true;
    if (/完整(?:输出|结果|内容)已落盘[：:]/.test(text)) return true;
    if (/(?:可用 offset\/limit|续读传 offset=|用 offset\/limit 或 next 续读)/.test(text)) return true;
    // 只有说话人前缀、没有正文的行（实测命中过：`【大肥鱼】` 单独占一条，检索还排到前面）
    if (/^【[^】]{1,20}】\s*[:：]?\s*$/.test(text)) return true;
    // 工具调用的 JSON 回执（2026-11-15 探针抓到）：对话历史里混着
    // `{"ok":true,"id":"task1-..."` 这种 payload，被当成人话索引了 ——
    // 探针里它们直接霸占了 top3（三行一模一样）。工具回执不是「发生过的事」。
    if (/^[\[{]/.test(text) && /"(?:ok|error|tool|steps|action)"\s*:/.test(text)) return true;
    return false;
}

/** 多模态 content 里只取文本部分（图片不算文本，空文本 → 空串，不判脚手架）。 */
function contentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('\n');
    }
    return '';
}

/** 一条消息是不是程序脚手架（只看 role=user；非文本消息保留）。 */
function isScaffoldMessage(msg) {
    if (!msg || msg.role !== 'user') return false;
    return isScaffolding(contentText(msg.content), 'user');
}

/**
 * 发给 MemOS 前的统一过滤：只剔除脚手架 user 消息，assistant/真实 user 原样保留。
 * 永远不会 throw（顶层兜底），调用方即使拿到空数组也应自行决定是否跳过 /add。
 * @returns {{messages: Array, dropped: string[]}}
 */
function filterMemoryMessages(messages) {
    try {
        const src = Array.isArray(messages) ? messages : [];
        const out = [];
        const dropped = [];
        for (const msg of src) {
            if (isScaffoldMessage(msg)) { dropped.push(contentText(msg.content)); continue; }
            out.push(msg);
        }
        return { messages: out, dropped };
    } catch (e) {
        // 过滤失败 = 放行（宁可多写一条，也不能因为过滤器坏了把记忆全丢）
        return { messages: Array.isArray(messages) ? messages.slice() : [], dropped: [] };
    }
}

module.exports = {
    SCAFFOLD_2P,
    PROGRAM_PROMPT_RULES,
    isScaffolding,
    isNoise,
    contentText,
    isScaffoldMessage,
    filterMemoryMessages,
};
