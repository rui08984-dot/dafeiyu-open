// prompt-layout.js — prompt 前缀缓存的布局纪律（2026-11-16 六十二轮）
//
// 为什么要有这个文件（实测，不是推测）：
//   上游是**按字节前缀**复用缓存的。system 是消息数组第一条 → 它里面任何
//   每轮变化的字节，都会让它**后面**的整段历史重新计费。
//   _probe/cache-probe.cjs 实测：system 不动时命中 97.4%，system 结尾追加一行 → 83.8%；
//   system 开头改一个字节 → 命中归零。
//
// 所以纪律只有一条：
//   **稳定的东西留 system（身份/规则/核心记忆/画像），每轮易变的东西
//     统一拼到最后一条 user 消息的末尾。**
//
// 谁该算易变（本文件不管判定，只负责摆放）：
//   memory-recall 的召回片段 / memos 的记忆摘要 / watch-screen 的屏幕描述 /
//   dynamic-persona 的「此刻状态；N 分钟前」/ alive-state 的身体数值 / inner-state 的当下状态。
//   稳定的反例：核心记忆、用户画像、人格 slow 层、游戏规则、直播人格设定。
//
// 语义风险：塞进 user 消息会被模型当成「用户说的话」。
//   缓解 = 统一前缀「（系统补充，不必回应）」，只做背景信息，不下指令。
//
// 2026-11-24（ADR-014 漏一）：只把易变块放对位置还不够 —— 工具循环（最多 30 轮）里
//   每次请求都会重跑插件钩子、重拼尾巴，而钩子自己就在改写**同一段前缀**：
//     · watch-screen 把「最近 60 秒画面摘要」**插到**最后一条 user 的最前面；
//     · dawn-dusk 把时段行插到 user 最前面；
//     · user-profile 把画像追到 system 末尾。
//   这些字节一变，从那一字节往后（含尚未发出的 tool 往返）全部 miss：
//   实测 11-22 单轮 18 次请求，cached 冻在 9,984、命中 93.7% → 41%。
//   所以这里再加一层「轮内前缀冻结」：本轮**第一次请求渲染完的字节**冻成快照，
//   循环里后面的请求只允许在快照后面**追加**新消息，已发出过的字节一个都不许改。

'use strict';

// 放在 user 消息末尾的声明，防止模型把注入当成用户的话去回应
const VOLATILE_HEADER = '（系统补充，不必回应）';

// 一次最多拼多少字：防止某轮召回把 20 条旧事全塞进 user（历史里会永久留着）
const MAX_VOLATILE_CHARS = 4000;

/**
 * 取一条消息内容的「尾巴文本」：多模态时取最后一个 text part（图片 part 不算正文）。
 * 用来判断易变块是不是已经在这条消息末尾 —— 判重只针对**末尾**，不去翻中间。
 * @param {any} content
 * @returns {string}
 */
function _tailText(content) {
    if (Array.isArray(content)) {
        for (let i = content.length - 1; i >= 0; i -= 1) {
            const p = content[i];
            if (p && p.type === 'text') return String(p.text == null ? '' : p.text);
        }
        return '';
    }
    return String(content == null ? '' : content);
}

/**
 * 按 UTF-16 单元截断但**不切开代理对**（2026-11-25）。
 * 易变尾巴里可能有 emoji（她刚说的原话/弹幕），正好截在 emoji 中间会留下半个字
 * （lone surrogate）—— 上游看到的是坏字节，而且 JSON 里会变成 \ud83d 这种残片。
 * 只是「少取 1 个单元」，确定性不变（同一输入仍得到同一字节）。
 */
function _cutSafe(text, n) {
    const k = Math.max(0, Math.min(text.length, Math.floor(n)));
    if (k <= 0) return '';
    if (k >= text.length) return text;
    const hi = text.charCodeAt(k - 1);
    const lo = text.charCodeAt(k);
    if (hi >= 0xD800 && hi <= 0xDBFF && lo >= 0xDC00 && lo <= 0xDFFF) return text.slice(0, k - 1);
    return text.slice(0, k);
}

/**
 * 把若干段易变文本拼成「尾巴块」（纯函数，不碰消息数组）。
 * 顺序：整段去重 → 行级去重 → 总量截断 → 加「不必回应」声明。
 * @param {string[]} texts
 * @returns {{block:string, count:number, chars:number, truncated:boolean}}
 */
function buildVolatileBlock(texts) {
    const list = (texts || [])
        .map((t) => String(t == null ? '' : t).trim())
        .filter(Boolean);

    // 去重：同一段文本可能同时从「补丁表」和「hook addVolatile」两条路进来
    const uniq = [];
    const seen = new Set();
    for (const t of list) {
        if (seen.has(t)) continue;
        seen.add(t);
        uniq.push(t);
    }

    // 行级去重（2026-11-24，P2-⑥）：memos 的 /search top3 与 memory-recall 的自动注入
    // 是两条独立的召回路径，同一件事可能各来一条。整段文本不同、但里面某一行完全相同 ——
    // 只做整段去重挡不住。这里按「去掉项目符号/序号后的归一化行」去重：
    //   · 只对 ≥8 字的行生效（短行如「1.」「- 」不参与，避免误删结构）
    //   · 后出现的重复行直接丢掉；整段都重复就整段丢掉
    // 目的不是省钱（每轮几百 token），而是别让同一件事在尾巴里出现两遍干扰模型。
    const seenLines = new Set();
    const deduped = [];
    for (const seg of uniq) {
        const kept = [];
        for (const line of String(seg).split('\n')) {
            const norm = String(line).trim().replace(/\s+/g, ' ')
                .replace(/^[-*•·]\s*|^\d+[.)、]\s*/, '');
            if (norm.length >= 8) {
                if (seenLines.has(norm)) continue;
                seenLines.add(norm);
            }
            kept.push(line);
        }
        const text = kept.join('\n').trim();
        if (text) deduped.push(text);
    }
    const finalList = deduped.length ? deduped : uniq;
    // 一段都没剩下（全空白/全被过滤）→ 返回真正的空块。
    // 旧实现仍会拼出「（系统补充，不必回应）」这一行空话：appendVolatile 因为 count=0 提前返回
    // 所以看不见，但任何直接用 .block 的调用方都会把一句无内容的声明塞进 prompt。
    if (!finalList.length) return { block: '', count: 0, chars: 0, truncated: false };

    let body = finalList.join('\n\n');
    let truncated = false;
    if (body.length > MAX_VOLATILE_CHARS) {
        body = _cutSafe(body, MAX_VOLATILE_CHARS);
        truncated = true;
    }
    const block = '\n\n' + VOLATILE_HEADER + '\n' + body + (truncated ? '\n（补充内容过长，已截断）' : '');
    return { block, count: finalList.length, chars: block.length, truncated };
}

/**
 * 把若干段易变文本拼到最后一条 user 消息末尾（不改动 system）。
 * 只做**纯追加**：既不重写消息前面的字节，也不会把同一块拼第二遍（幂等），
 * 因为轮内复用的前提是「已发出的字节一个都不许变」。
 * @param {Array<{role:string, content:any}>} messages
 * @param {string[]} texts
 * @returns {{ok:boolean, count:number, target:number, chars:number, reason?:string, truncated?:boolean}}
 */
function appendVolatile(messages, texts) {
    const built = buildVolatileBlock(texts);
    if (!built.count) return { ok: false, count: 0, target: -1, chars: 0, reason: 'empty' };
    if (!Array.isArray(messages) || !messages.length) {
        return { ok: false, count: 0, target: -1, chars: 0, reason: 'no-messages' };
    }
    const block = built.block;

    // 找最后一条 user；一条都没有就补一条（工具循环里可能出现全 tool 结尾）
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i] && messages[i].role === 'user') { idx = i; break; }
    }
    if (idx === -1) {
        messages.push({ role: 'user', content: block.trim() });
        return { ok: true, count: built.count, target: messages.length - 1, chars: block.length, reason: 'pushed' };
    }

    const m = messages[idx];
    // 幂等：同一条尾巴重复拼 = 字节翻倍（既是 token 浪费，也会让下一次请求的尾巴比缓存长）。
    // 走 `reason:'already'` 而不是静默 ok，排障时能看出「谁在同一条消息上拼了两遍」。
    if (_tailText(m.content).endsWith(block)) {
        return { ok: true, count: built.count, target: idx, chars: 0, reason: 'already', truncated: built.truncated };
    }

    if (Array.isArray(m.content)) {
        // 多模态：追加一个 text part。**必须追加在最后**，图片在前文字在后不影响理解，
        // 但如果把图片插到中间，某些上游会对 part 顺序挑刺。
        m.content.push({ type: 'text', text: block });
    } else {
        m.content = String(m.content == null ? '' : m.content) + block;
    }
    return { ok: true, count: built.count, target: idx, chars: block.length, truncated: built.truncated };
}

/**
 * 一条宿主消息的「前缀指纹归一化」。
 *
 * 为什么不能直接比消息对象：冻结快照是**请求体**（钩子改写 + 易变块 + attachments 已删），
 * 宿主里没有这些，但可能带 attachments —— 两侧天然不同形，直接比必然不等。
 * 所以「宿主有没有被改写」只在**同一侧**比：冻结时取一份宿主前缀指纹，之后每次
 * 用同样的归一化再取一次。归一化只留两侧都有的语义字段，并丢掉 attachments
 * （它不是请求体的一部分，截图回合的宿主会带它）。
 * @param {any} m
 * @returns {any}
 */
function _normMessage(m) {
    if (!m || typeof m !== 'object') return m;
    const out = { role: m.role };
    if (m.content !== undefined) out.content = m.content;
    if (m.tool_calls !== undefined) out.tool_calls = m.tool_calls;
    if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
    if (m.name !== undefined) out.name = m.name;
    return out;
}

/**
 * 逐条指纹（宿主侧）。数组本身留一份，能在断裂时直接指出「第几条被改写」。
 * @param {Array} list
 * @param {number} count
 * @returns {string[]}
 */
/**
 * 逐条指纹（宿主侧）。数组本身留一份，能在断裂时直接指出「第几条被改写」。
 *
 * P2-13（2026-11-25 风暴压测）：不能对每条消息都全量 JSON.stringify 再 hash ——
 * 截图轮里前缀中挂着 1.4MB 的 base64 图，30 次工具请求 = 30 次全量序列化（实测 +130ms，
 * 而且每次都在主线程）。这里对「大消息」改用**轻量指纹**：长度 + 头尾各 64 字符。
 * 为什么够用：轮内会改写已发出字节的只有两条路径 ——
 *   · tool-result-cap：整条替换（截断/省略），长度和头尾必变；
 *   · 剥历史图：content 从数组变字符串，长度必变；
 *   · 人工/外部模块改写历史：头尾大概率在变（中间悄悄改属于理论情况，代价可接受）。
 * 小消息仍走全量 JSON，判据不变。
 */
const CHEAP_SIG_MIN_CHARS = 4096;
const _sigStats = { full: 0, cheap: 0 };

function _cheapContentSig(content) {
    if (typeof content === 'string') {
        const s = content;
        return { total: s.length, sig: hashText('S' + s.length + ':' + s.slice(0, 64) + '\u0000' + s.slice(-64)) };
    }
    if (Array.isArray(content)) {
        let total = 0;
        const bits = [];
        for (const p of content) {
            const type = String((p && p.type) || '');
            if (p && typeof p === 'object' && typeof p.text === 'string') {
                const t = p.text;
                total += t.length + type.length;
                bits.push(type + t.length + ':' + t.slice(0, 32) + '\u0000' + t.slice(-32));
            } else if (p && typeof p === 'object' && (p.type === 'image_url' || p.image_url)) {
                const u = String((p.image_url && p.image_url.url) || '');
                total += u.length + type.length;
                bits.push(type + u.length + ':' + u.slice(0, 64) + '\u0000' + u.slice(-64));
            } else {
                let j = '';
                try { j = JSON.stringify(p); } catch (e) { j = '?'; }
                total += j.length;
                bits.push(String(type) + j.length + ':' + j.slice(0, 64));
            }
        }
        return { total, sig: hashText('A' + content.length + ':' + total + ':' + bits.join('|')) };
    }
    return null;
}

function _msgSig(m) {
    // 先看 size（不序列化大字符串/图片）
    const cheap = _cheapContentSig(m && m.content);
    if (cheap && cheap.total > CHEAP_SIG_MIN_CHARS) {
        _sigStats.cheap += 1;
        let tc = '';
        if (m && m.tool_calls) {
            let j = '';
            try { j = JSON.stringify(m.tool_calls); } catch (e) { j = '?'; }
            tc = '\u0003' + j.length + ':' + j.slice(0, 64) + '\u0000' + j.slice(-64);
        }
        return hashText(String((m && m.role) || '') + '\u0001' + cheap.sig + tc
            + (m && m.tool_call_id ? '\u0004' + String(m.tool_call_id) : ''));
    }
    let s = '';
    try { s = JSON.stringify(_normMessage(m)); } catch (e) { s = '\u0001'; }
    _sigStats.full += 1;
    return hashText(s);
}

function _msgSigs(list, count) {
    const src = Array.isArray(list) ? list : [];
    const n = Math.max(0, Math.min(Number(count) || 0, src.length));
    const out = [];
    for (let i = 0; i < n; i += 1) out.push(_msgSig(src[i]));
    return out;
}

/**
 * 冻结「本轮第一次请求」的完整前缀（ADR-014 漏一，2026-11-24 第三轮）。
 *
 * 冻的是**渲染完的字节**（messages），不是「易变文本列表」：
 * 因为钩子自己也会改写 user 开头 / system 末尾，只冻易变块等于没冻（见文件头注释）。
 * 同时留一份**宿主前缀指纹**（hostSig）：宿主是「工具结果落盘」的那一侧，
 * 它被 `tool-result-cap` 之类的路径在轮内改写时，快照里的旧字节就不能再发出去。
 *
 * @param {Array} messages      本轮第一次请求的 messagesForAPI（已跑完钩子、已拼易变尾巴）
 * @param {Array} hostMessages  宿主 voiceChat.messages（只取前 hostLength 条做指纹）
 * @param {object} [meta]       只用于观测/排障（易变段数、字数…），不参与任何判断
 * @returns {{messages:Array, hostLength:number, chars:number, snapSig:string,
 *            hostSig:string, hostMsgSigs:string[], at:number, meta:object}|null}
 */
function freezeTurnPrefix(messages, hostMessages, meta) {
    if (!Array.isArray(messages) || !messages.length) return null;
    const host = Array.isArray(hostMessages) ? hostMessages : [];
    let snapshot;
    let json = '';
    try {
        snapshot = JSON.parse(JSON.stringify(messages));
        json = JSON.stringify(snapshot);
    } catch (e) {
        return null;
    }
    const hostMsgSigs = _msgSigs(host, host.length);
    return {
        messages: snapshot,
        hostLength: host.length,
        chars: json.length,
        // 快照自身指纹：只防「快照对象被外部改过」，不是「宿主有没有变」的判据
        snapSig: json ? hashText(json) : '',
        // 宿主前缀指纹：轮内宿主被改写（工具回执限流/剥图/裁剪）就靠它抓
        hostSig: hostMsgSigs.length ? hashText(hostMsgSigs.join(',')) : '',
        hostMsgSigs,
        at: Date.now(),
        meta: (meta && typeof meta === 'object') ? meta : {},
    };
}

/**
 * 用冻结前缀重组本轮第 N 次请求：冻结的字节原样 + 宿主在冻结点之后新增的消息。
 *
 * 返回的 messages 是新深拷贝（每次请求独立），所以调用方后面怎么改都不会污染快照。
 * 两条判据分开命名、分开报：
 *   · `hostOk/host-rewritten`：宿主前缀被改写 → **必须作废冻结**（否则截断/剥图被静默绕过）；
 *   · `snapOk`：快照对象自身被外部改过 → 缓存同样会断，只观测。
 *
 * @param {object|null} frozen     freezeTurnPrefix 的返回值
 * @param {Array} hostMessages     voiceChat.messages（宿主数组）
 * @returns {{ok:true, messages:Array, prefixMsgs:number, prefixChars:number, tailMsgs:number,
 *            hostOk:boolean, snapOk:boolean}
 *          |{ok:false, reason:string, index?:number}}
 */
function composeTurnPrefix(frozen, hostMessages) {
    if (!frozen || !Array.isArray(frozen.messages) || !frozen.messages.length) {
        return { ok: false, reason: 'no-freeze' };
    }
    if (!Array.isArray(hostMessages)) return { ok: false, reason: 'no-host' };
    // 宿主变短 = 冻结点之后的消息被 trim/pop 掉了，快照与宿主已经对不上（继续拼会丢消息）
    if (hostMessages.length < frozen.hostLength) {
        return { ok: false, reason: 'host-shrank' };
    }
    // ① 宿主前缀还是冻结时那一份吗？（tool-result-cap 的「单轮累计省略」会改写更早的 tool 消息）
    if (frozen.hostSig) {
        const nowSigs = _msgSigs(hostMessages, frozen.hostLength);
        if (hashText(nowSigs.join(',')) !== frozen.hostSig) {
            let idx = -1;
            for (let i = 0; i < frozen.hostLength; i += 1) {
                if (nowSigs[i] !== (frozen.hostMsgSigs || [])[i]) { idx = i; break; }
            }
            return { ok: false, reason: 'host-rewritten', index: idx };
        }
    }
    let prefix;
    let tail;
    try {
        prefix = JSON.parse(JSON.stringify(frozen.messages));
        tail = JSON.parse(JSON.stringify(hostMessages.slice(frozen.hostLength)));
    } catch (e) {
        return { ok: false, reason: 'clone-failed' };
    }
    // 与首次请求同口径：附件字段不进请求体
    for (const m of tail) delete m.attachments;
    const messages = prefix.concat(tail);
    let snapOk = true;
    if (frozen.snapSig) {
        try {
            snapOk = hashText(JSON.stringify(messages.slice(0, prefix.length))) === frozen.snapSig;
        } catch (e) {
            snapOk = false;
        }
    }
    return {
        ok: true,
        messages,
        prefixMsgs: prefix.length,
        prefixChars: frozen.chars,
        tailMsgs: tail.length,
        hostOk: true,
        snapOk,
    };
}

/**
 * 取 system 消息的文本（兼容 content 是数组的形态）。
 * @param {Array} messages
 * @returns {string}
 */
function systemText(messages) {
    if (!Array.isArray(messages)) return '';
    for (const m of messages) {
        if (m && m.role === 'system') {
            if (Array.isArray(m.content)) {
                return m.content.map((p) => (p && p.type === 'text' ? p.text : '')).join('');
            }
            return String(m.content == null ? '' : m.content);
        }
    }
    return '';
}

/**
 * system 指纹：用来判断「这一轮 system 字节有没有变」。
 * 变了就等于宣告「历史那段的缓存全废」——所以它必须是可观测的数字，不能靠猜。
 * FNV-1a 32 位（不需要密码学强度，只要稳定且区分度够）。
 * @param {string} text
 * @returns {string} 8 位十六进制
 */
function hashText(text) {
    let h = 0x811c9dc5;
    const s = String(text == null ? '' : text);
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
}

/**
 * 从上游 usage 里取「命中/未命中缓存」的数字（ADR-014 轨道 1）。
 * 不同家字段名不一样，全都试一遍；没有就返回 null（**不要**把未知当 0）。
 *
 * miss 的口径（按可信度降序）：
 *   ① 上游显式给 `prompt_cache_miss_tokens`（DeepSeek 原生）；
 *   ② 有 prompt 且有 cached → prompt - cached（网关只回 cached 时的推算）；
 *   ③ 都没有 → null（不可观测，不要编 0）。
 * @param {object} usage
 * @returns {{prompt:number|null, cached:number|null, miss:number|null, rate:number|null, fields:string[]}}
 */
function cacheRate(usage) {
    if (!usage || typeof usage !== 'object') {
        return { prompt: null, cached: null, miss: null, rate: null, fields: [] };
    }
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? NaN);
    const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
    const pick = (v) => v != null && Number.isFinite(Number(v));
    const cachedCand = [
        details.cached_tokens,
        usage.prompt_cache_hit_tokens,
        usage.cached_tokens,
        usage.cache_read_input_tokens,
    ].find(pick);
    const cached = cachedCand == null ? null : Number(cachedCand);
    const p = Number.isFinite(prompt) ? prompt : null;

    let miss = null;
    if (pick(usage.prompt_cache_miss_tokens)) {
        miss = Number(usage.prompt_cache_miss_tokens);
    } else if (p != null && cached != null) {
        miss = Math.max(0, p - cached);
    }

    return {
        prompt: p,
        cached,
        miss,
        rate: (p != null && cached != null && p > 0) ? +(cached / p * 100).toFixed(1) : null,
        fields: Object.keys(usage),
    };
}

module.exports = {
    VOLATILE_HEADER,
    MAX_VOLATILE_CHARS,
    buildVolatileBlock,
    appendVolatile,
    freezeTurnPrefix,
    composeTurnPrefix,
    systemText,
    hashText,
    cacheRate,
    // P2-13：指纹开销可观测（测试用它断言「大图不再每请求全量 hash」）
    _sigStats,
};
