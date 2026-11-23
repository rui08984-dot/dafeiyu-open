'use strict';
// actions-bridge.js —— my-neuro 的「情绪 / 动作意图」到我们 petbody 渲染器的桥。
//
// ── task-8 诊断结论（先看清楚再动手）──────────────────────────────────────────
// my-neuro 的 motion-director 产出的是**当前 Live2D 模型的参数关键帧**，而且它只能通过
// global.paramDirector.loadTimeline/appendTimelineFrames 落地；paramDirector 只在 my-neuro
// 自己的 live2d(pixi) 渲染栈里创建（js/avatar/live2d/runtime.js），宿主切到 petbody 后
// Live2DSetup.suspend() → runtime.detach() 会把它清空。所以：
//   1) petbody 激活时 global.paramDirector 不存在；
//   2) llm-handler.describeChoreographySkip() 直接返回 'no-param-director'，choreograph() 根本不会被调用；
//   3) 即使被调用，_choreographInternal 第一行就以 !global.paramDirector 返回 disabled。
// 结论：motion-director 在 petbody 下压根没写参数，不存在和我们 body-director 抢参数的问题。
// 它真正缺的是「语义层」：情绪标签（<开心>）和动作意图（（挥手）/[wave]）在 petbody 下没人接
// —— my-neuro 的 emotionMapper/expressionMapper 也是 live2d/vrm 栈里创建的。
//
// 所以这个桥只做语义层，不碰参数级编舞（参数名和骨架都不一样，硬搬只会把身体拧成麻花）：
//   <开心> → 我们的表情 preset（开心=＞＜ / 生气=黑脸 / 难过=流泪 / 惊讶=圈圈眼 / 害羞=脸红 / 俏皮=屑屑眼）
//   （挥手）/[nod head] → 我们的 motion-vocab 动作名，交给 driver.playMotion()
//
// 纯函数 + 回调，不 require electron，方便在 node 里单测。

// 六种情绪 → 我们 presets 里的 authored expression 名（pet.model3.json 的 Expressions）
// 句子→情绪推断（纯函数，无 electron 依赖，见 live2d/text-emotion.js 头部说明）
const { inferEmotion } = require('../live2d/text-emotion.js');

// 2026-11-15：同一个情绪给**多个**表情轮换（用户反馈「表情还是那几个切来切去」）。
// 模型里有 23 个 authored expression，真正能表达情绪的是这 8 个：
// ＞＜(眯眼笑) / 兔牙(可爱) / 爱心眼(喜欢) / 屑屑眼(得意) / 脸红(害羞) / 流泪(难过) / 黑脸(生气) / 圈圈眼(惊讶)
const EMOTION_EXPRESSIONS = Object.freeze({
    开心: ['＞＜', '兔牙', '爱心眼'],
    生气: ['黑脸'],
    难过: ['流泪'],
    惊讶: ['圈圈眼'],
    害羞: ['脸红', '爱心眼'],
    俏皮: ['屑屑眼', '兔牙'],
});
// 轮换游标：每种情绪记住上次用到第几个，避免连续两次同一个表情
const _exprCursor = Object.create(null);
function pickExpression(key) {
    const pool = EMOTION_EXPRESSIONS[key];
    if (!Array.isArray(pool) || !pool.length) return null;
    const i = (_exprCursor[key] || 0) % pool.length;
    _exprCursor[key] = i + 1;
    return pool[i];
}

// 情绪顺带播一下动作（没有对应动作的留空，避免"为了动而动"）
const EMOTION_ACTIONS = Object.freeze({
    开心: 'laugh',
    生气: 'angry',
    惊讶: null,
    难过: null,
    害羞: null,
    俏皮: 'tilt head right',
});

// 英文/中文别名 → 我们的六种情绪
const EMOTION_ALIASES = Object.freeze({
    happy: '开心', joy: '开心', joyful: '开心', excited: '开心', glad: '开心', 高兴: '开心', 快乐: '开心', 兴奋: '开心',
    angry: '生气', anger: '生气', mad: '生气', annoyed: '生气', 愤怒: '生气', 恼火: '生气',
    sad: '难过', sadness: '难过', sorrow: '难过', down: '难过', 悲伤: '难过', 伤心: '难过', 委屈: '难过',
    surprised: '惊讶', surprise: '惊讶', shocked: '惊讶', 惊喜: '惊讶', 吃惊: '惊讶',
    shy: '害羞', embarrassed: '害羞', blush: '害羞', 脸红: '害羞', 羞涩: '害羞',
    playful: '俏皮', smug: '俏皮', tease: '俏皮', teasing: '俏皮', 调皮: '俏皮', 得意: '俏皮', 坏笑: '俏皮',
});

// 语义动作意图 → motion-vocab 的动作标签（长词在前，避免"点头"被"点"抢走）
const ACTION_PHRASES = Object.freeze([
    ['raise your hands', 'raise your hands'], ['raise your hand', 'raise your hands'], ['举起双手', 'raise your hands'],
    ['举双手', 'raise your hands'], ['举起手', 'raise your hands'], ['举手', 'raise your hands'],
    ['hands on chest', 'hands on chest'], ['hand on chest', 'hands on chest'],
    ['抚胸', 'hands on chest'], ['捂胸口', 'hands on chest'], ['捂胸', 'hands on chest'], ['手放胸口', 'hands on chest'],
    ['nod head', 'nod head'], ['nod', 'nod head'], ['点头', 'nod head'],
    ['shake head', 'shake head'], ['shake', 'shake head'], ['摇头', 'shake head'],
    ['tilt head', 'tilt head'], ['tilty', 'tilt head'], ['歪头', 'tilt head'], ['侧头', 'tilt head'],
    ['bow', 'bow'], ['鞠躬', 'bow'], ['弯腰', 'bow'],
    ['lean forward', 'lean forward'], ['前倾', 'lean forward'], ['凑近', 'lean forward'],
    ['point', 'point'], ['指向', 'point'], ['指着', 'point'], ['指一下', 'point'],
    ['shrug', 'shrug'], ['耸肩', 'shrug'],
    ['laugh', 'laugh'], ['giggle', 'laugh'], ['笑', 'laugh'], ['哈哈', 'laugh'], ['偷笑', 'laugh'],
    ['angry', 'angry'], ['生气', 'angry'], ['鼓脸', 'angry'], ['鼓腮', 'angry'],
    ['thinking', 'thinking'], ['think', 'thinking'], ['思考', 'thinking'], ['想想', 'thinking'], ['沉思', 'thinking'],
    ['stretch', 'stretch'], ['伸懒腰', 'stretch'], ['打哈欠', 'stretch'],
    ['clap', 'clap'], ['鼓掌', 'clap'], ['拍手', 'clap'],
    ['wave', 'wave'], ['挥手', 'wave'], ['招手', 'wave'], ['打招呼', 'wave'],
]);

const MOTION_INDEX_FALLBACK = ['wave', 'nod head', 'shake head', 'tilt head right', 'laugh', 'bow', 'clap', 'stretch'];

function normalize(value) {
    return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, '');
}

/** 文本里是否出现某个语义动作；返回我们的动作标签或 null */
function resolveActionPhrase(text) {
    const raw = String(text == null ? '' : text);
    if (!raw.trim()) return null;
    const normalized = normalize(raw);
    for (const [phrase, tag] of ACTION_PHRASES) {
        const key = normalize(phrase);
        if (!key) continue;
        // 英文按整词/子串都行（这里只处理括号里的短指令）；中文直接子串
        if (normalized.includes(key)) return tag;
    }
    return null;
}

/** 情绪名（中/英/别名）→ { key, expression, action } 或 null */
function resolveEmotion(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return null;
    if (Object.prototype.hasOwnProperty.call(EMOTION_EXPRESSIONS, raw)) {
        return { key: raw, expression: pickExpression(raw), action: EMOTION_ACTIONS[raw] || null };
    }
    const lower = raw.toLowerCase();
    const key = EMOTION_ALIASES[lower] || EMOTION_ALIASES[raw] || null;
    if (!key) return null;
    return { key, expression: pickExpression(key), action: EMOTION_ACTIONS[key] || null };
}

/**
 * 从一段文本里抽出情绪/动作标签并清洗掉（TTS 不该把标签念出来）。
 * 支持：<开心>（my-neuro 的情绪标签）、（挥手）[wave]【点头】。
 * 只清洗能识别的标签，普通括号内容原样保留。
 */
function extractTags(text) {
    const source = String(text == null ? '' : text);
    const markers = [];
    let cleaned = '';
    let index = 0;
    let pattern = /<([^<>]{1,24})>|[（(【\[]([^（）()\[\]【】<>]{1,24})[）)】\]]/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
        const inner = String(match[1] || match[2] || '').trim();
        const emotion = resolveEmotion(inner);
        const action = emotion ? null : resolveActionPhrase(inner);
        if (!emotion && !action) continue;                      // 不认识的括号内容不动
        cleaned += source.slice(index, match.index);
        index = match.index + match[0].length;
        markers.push({
            position: cleaned.length,                            // 清洗后文本里的位置
            emotion: emotion ? emotion.key : null,
            expression: emotion ? emotion.expression : null,
            action: action || (emotion ? emotion.action : null),
            raw: match[0],
        });
    }
    cleaned += source.slice(index);
    return { text: cleaned, markers };
}

/**
 * 造一个 my-neuro 形状的 emotionMapper（EmotionMotionMapper / EmotionExpressionMapper 的最小实现）。
 * api: { setExpression(name), clearExpression(name), playAction(tag), log(line), characterName }
 */
function createEmotionBridge(api = {}) {
    const log = typeof api.log === 'function' ? api.log : () => {};
    const setExpression = typeof api.setExpression === 'function' ? api.setExpression : () => {};
    const clearExpression = typeof api.clearExpression === 'function' ? api.clearExpression : () => {};
    const playAction = typeof api.playAction === 'function' ? api.playAction : () => false;
    // 情绪记账回调（C-1b）：桥不碰存储，只把「这次是什么情绪」告诉宿主，由它决定写不写盘
    const onEmotion = typeof api.onEmotion === 'function' ? api.onEmotion : () => {};
    let activeExpression = '';
    let activeEmotion = '';
    let lastAction = '';

    function applyEmotion(rawEmotion) {
        const resolved = resolveEmotion(rawEmotion);
        if (!resolved) { log('[bridge] 未知情绪: ' + String(rawEmotion)); return null; }
        // 静音表情（托盘开关）：情绪照常记账，但不切脸。
        // petbody 的「表情强度」只在这个桥上有意义 —— 别去改渲染参数（那会和物理/呼吸打架）。
        const gain = Number(global.__petEmotionGain);
        const faceMuted = Number.isFinite(gain) && gain <= 0;
        if (resolved.expression && !faceMuted) {
            if (activeExpression && activeExpression !== resolved.expression) clearExpression(activeExpression);
            setExpression(resolved.expression);
            activeExpression = resolved.expression;
        }
        if (resolved.action) { playAction(resolved.action); lastAction = resolved.action; }
        activeEmotion = resolved.key;
        try { onEmotion(resolved.key, 1); } catch (e) { /* 记账失败不影响表演 */ }
        log('[bridge] emotion ' + String(rawEmotion) + ' -> ' + resolved.key +
            (resolved.expression ? ' / ' + resolved.expression + (faceMuted ? '（静音表情：不切脸）' : '') : '') +
            (resolved.action ? ' / ' + resolved.action : ''));
        return resolved;
    }

    function fireAction(tag) {
        if (!tag) return false;
        lastAction = tag;
        const ok = playAction(tag);
        log('[bridge] action ' + tag + ' -> ' + (ok ? 'ok' : 'miss'));
        return ok;
    }

    const bridge = {
        getCurrentCharacterName() { return api.characterName || '大肥鱼'; },
        getActiveEmotion() { return activeEmotion; },
        getActiveExpression() { return activeExpression; },
        getLastAction() { return lastAction; },
        // my-neuro 的三个入口名都接上，谁调都行
        playConfiguredEmotion(emotion) { return applyEmotion(emotion); },
        triggerExpressionByEmotion(emotion) { return applyEmotion(emotion); },
        triggerEmotionByTextPosition(position, textLength, markers) {
            if (!Array.isArray(markers) || markers.length === 0) return;
            for (let i = markers.length - 1; i >= 0; i--) {
                const marker = markers[i];
                if (position >= marker.position && position <= marker.position + 2) {
                    if (marker.emotion) applyEmotion(marker.emotion);
                    if (marker.action) fireAction(marker.action);
                    markers.splice(i, 1);
                    break;
                }
            }
            if (position >= textLength - 1 && markers.length > 0) {
                for (const marker of markers) {
                    if (marker.emotion) applyEmotion(marker.emotion);
                    if (marker.action) fireAction(marker.action);
                }
                markers.length = 0;
            }
        },
        // TTS 前的文本清洗：去掉 <开心>/（挥手），返回情绪标记（带位置）
        prepareTextForTTS(text) {
            const extracted = extractTags(text);
            // 没有标签时，从这句话本身推断表情（2026-11-12 根因）：
            // system_prompt 明确禁止她写 <开心> 这类标签，所以 extractTags 长期恒空，
            // 脸只能跟 1.5s 一次的心情快照走 —— 用户看到的就是「说的话和表情对不上」。
            // 粒度 = 一段 TTS 文本（通常一句）；中性句返回 null，保持原表情不乱切。
            if (!extracted.markers.length && extracted.text && extracted.text.trim()) {
                const guess = inferEmotion(extracted.text);
                if (guess) {
                    const emo = resolveEmotion(guess.emotion);
                    if (emo) {
                        extracted.markers.push({
                            position: 0,
                            emotion: emo.key,
                            expression: emo.expression,
                            action: emo.action,
                            inferred: guess.score,
                        });
                        log('[bridge] 文本推断表情 ' + emo.key + ' (' + guess.score.toFixed(2) + ') ← ' +
                            String(extracted.text).trim().slice(0, 18));
                    }
                }
            }
            return { text: extracted.text, emotionMarkers: extracted.markers };
        },
        /**
         * 只按文本推一次表情并立刻应用（不涉及 TTS / 播放）。
         * 为什么需要（2026-11-13）：表情推断原来只挂在**播放引擎**上
         * （tts-playback-engine 里 prepareTextForTTS → 逐字推进到标记位置才切），
         * 所以 TTS 一降级（被静音 / 网络连续失败 / 冷却期），她整段话都面无表情。
         * 实测：静音模式下发「哈哈笑死我」，对话正常、字幕正常、**零表情日志**。
         * 中性句返回 null，保持原表情不乱切（与原逻辑一致）。
         */
        applyTextEmotion(text) {
            try {
                const guess = inferEmotion(String(text || ''));
                if (!guess) return null;
                const emo = resolveEmotion(guess.emotion);
                if (!emo) return null;
                applyEmotion(emo.key);
                log('[bridge] 文本表情 ' + emo.key + ' (' + guess.score.toFixed(2) + ') ← ' + String(text).trim().slice(0, 18));
                return emo.key;
            } catch (e) { return null; }
        },
        // 索引/名字都收：名字走语义表，数字走固定回退表（my-neuro 的音乐/热键会传索引）
        playMotion(indexOrName) {
            if (typeof indexOrName === 'string') {
                const tag = resolveActionPhrase(indexOrName) || resolveActionPhrase('（' + indexOrName + '）') || indexOrName;
                return fireAction(tag);
            }
            const idx = Number(indexOrName);
            if (!Number.isFinite(idx) || idx < 0) return false;
            return fireAction(MOTION_INDEX_FALLBACK[Math.floor(idx) % MOTION_INDEX_FALLBACK.length]);
        },
        playDefaultMotion() { reset(); },
        // 清掉当前表情，回到中性
        reset() {
            if (activeExpression) { clearExpression(activeExpression); activeExpression = ''; }
            activeEmotion = '';
        },
    };
    return bridge;
}

module.exports = {
    EMOTION_EXPRESSIONS,
    EMOTION_ACTIONS,
    EMOTION_ALIASES,
    ACTION_PHRASES,
    MOTION_INDEX_FALLBACK,
    pickExpression,
    resolveEmotion,
    resolveActionPhrase,
    extractTags,
    createEmotionBridge,
};
