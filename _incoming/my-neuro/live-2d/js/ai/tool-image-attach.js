// js/ai/tool-image-attach.js —— 把工具回执里的截图从**文本**搬到**图片消息**（P0-1，2026-11-25）
//
// 为什么需要（审计 2026-11-25 P0-1）：
//   `see image`（som_snapshot）把标注图以 `image: "<base64>"` 塞进 tool 回执的 JSON 字符串里。
//   全仓没有任何消费者把 `imageIsBase64` 转成 `image_url` 消息 —— 模型收到的是一段 base64
//   文本（实测单条 180,753 字节），既看不见图，又吃满上下文，还会被 12k 上限切成非法 JSON。
//
// 做法（最小闭环）：
//   ① 工具结果进入消息前先过 `splitToolImageContent`：识别 `imageIsBase64:true` 或
//      `image` 字段 >2000 字 → 把 base64 **从文本里剥掉**，换成
//      `{"ok":true,"imageAttached":true,"note":"截图已作为图片消息附加","elements":[...]}`；
//      元素清单/尺寸/刻度尺等文本信息一个不丢。
//   ② `appendToolResults` 在**所有 tool 消息推完之后**再追加一条 user 图片消息
//      （顺序不能反：assistant.tool_calls 后面必须紧跟连续的 tool 消息，中间插 user 会让
//      sanitizeToolMessageSequence 判定「工具链不完整」而把整批回执丢掉）。
//   ③ 只保留最近 1 张：追加新图前把历史里的工具图片剥成文字。识别靠文本标记，
//      **不会误伤用户本轮截图**（那类消息用的是「当前电脑屏幕内容:」等文案）。
//
// 纪律：
//   · 纯函数/纯数组操作，不读磁盘、不碰 global、不需要 Electron（测试直接 require）。
//   · 任何异常都不许冒泡（空/损坏 base64、非 JSON 文本都按「没有图」处理）。
//   · 单张上限 8MB base64：超限只回元素清单并标 `imageTooLarge:true`。
'use strict';

// 工具图片消息的稳定标记：既给模型看（说明这条 user 消息是什么），也给剥图逻辑识别。
const TOOL_IMAGE_TEXT = '[工具 see 返回的屏幕截图]';
const IMAGE_ATTACH_NOTE = '截图已作为图片消息附加';
// 8MB base64 ≈ 6MB 原图；正常 SoM 标注图 ~180KB，远低于此。
const MAX_TOOL_IMAGE_BASE64 = 8 * 1024 * 1024;
// 「没有 imageIsBase64 标记时」判定 image 字段是不是图片的最小长度（防 URL/路径误判）。
const MIN_IMAGE_BASE64_CHARS = 2000;
// 太短的 base64 不可能是截图（空/损坏/占位符），按无效处理。
const MIN_VALID_BASE64_CHARS = 100;

const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,/i;

/** 按 base64 magic 判 mime（SoM 默认 JPEG；PNG/WebP/GIF/BMP 也认）。 */
function detectMime(base64) {
    const s = String(base64 == null ? '' : base64);
    if (/^iVBORw0KGgo/.test(s)) return 'image/png';
    if (/^\/9j\//.test(s)) return 'image/jpeg';
    if (/^R0lGOD/.test(s)) return 'image/gif';
    if (/^UklGR/.test(s)) return 'image/webp';
    if (/^Qk/.test(s) && s.length > 100) return 'image/bmp';
    return 'image/jpeg';
}

/** 去掉 data URL 前缀和空白，得到裸 base64。 */
function normalizeBase64(value) {
    let s = String(value == null ? '' : value);
    const m = DATA_URL_RE.exec(s);
    if (m) s = s.slice(m[0].length);
    return s.replace(/\s+/g, '');
}

/** 宽松校验：只认 base64 字母表 + 足够长（不做解码，避免大图重复耗 CPU）。 */
function isLikelyBase64(s) {
    const v = String(s == null ? '' : s);
    if (v.length < MIN_VALID_BASE64_CHARS) return false;
    return /^[A-Za-z0-9+/=]+$/.test(v);
}

/**
 * 纯文本层面的「含图回执」判定（给 tool-result-cap 用，不做 JSON.parse/序列化）。
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeToolImageEnvelope(text) {
    const s = typeof text === 'string' ? text : '';
    if (s.length < MIN_IMAGE_BASE64_CHARS) return false;
    // 显式标记：唯一可靠形状
    if (/"imageIsBase64"\s*:\s*true/.test(s)) return true;
    // 没有标记：只认 `"image":"<>=2000 字的值"`（URL/路径通常远短于此）
    const m = /"image"\s*:\s*"/.exec(s);
    if (!m) return false;
    const start = m.index + m[0].length;
    const end = s.indexOf('"', start);
    return end >= 0 && (end - start) >= MIN_IMAGE_BASE64_CHARS;
}

function _noChange(content) {
    return { text: content, image: null, changed: false, imageTooLarge: false, invalid: false };
}

/**
 * 把「含 base64 图片的 tool 回执」拆成「可读文本 + 图片对象」。
 *
 * @param {string|object} content tool 消息 content（dispatch 返回的是 JSON 字符串）
 * @returns {{text:*, image:{mime:string,base64:string,chars:number}|null,
 *            changed:boolean, imageTooLarge:boolean, invalid:boolean}}
 *   text  —— 剥掉图片后的回执（无图时**原样返回**同一引用，不改变旧行为）
 *   image —— 有效图片（已被剥离）；无效/超限时为 null
 */
function splitToolImageContent(content) {
    let raw = null;
    if (typeof content === 'string') raw = content;
    else if (content && typeof content === 'object' && !Array.isArray(content)) {
        try { raw = JSON.stringify(content); } catch (e) { return _noChange(content); }
    } else {
        return _noChange(content);
    }

    const s = String(raw == null ? '' : raw).trim();
    if (!s || s[0] !== '{') return _noChange(content);
    let obj = null;
    try { obj = JSON.parse(s); } catch (e) { return _noChange(content); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return _noChange(content);

    const flagged = obj.imageIsBase64 === true;
    const rawImg = typeof obj.image === 'string' ? obj.image : '';
    // 判定：有标记就认；没标记必须「image 字段足够长」（普通 URL/文件名不会到 2000 字）
    if (!flagged && !(rawImg && rawImg.length > MIN_IMAGE_BASE64_CHARS)) return _noChange(content);

    const base64 = normalizeBase64(rawImg);
    // 保留其余字段（elements/snapshot_id/scale/ruler/…），只拿掉 image 与标记
    const rest = Object.assign({}, obj);
    delete rest.image;
    delete rest.imageIsBase64;
    const out = Object.assign({ ok: rest.ok === undefined ? true : rest.ok }, rest);

    if (!base64 || !isLikelyBase64(base64)) {
        out.imageAttached = false;
        out.note = '工具回执声明了截图，但图片数据为空或无效（已按元素清单继续）';
        return { text: JSON.stringify(out), image: null, changed: true, imageTooLarge: false, invalid: true };
    }
    if (base64.length > MAX_TOOL_IMAGE_BASE64) {
        out.imageAttached = false;
        out.imageTooLarge = true;
        out.note = '截图超过 8MB 上限，已省略图片；请按 elements 的编号/坐标继续操作';
        return { text: JSON.stringify(out), image: null, changed: true, imageTooLarge: true, invalid: false };
    }

    out.imageAttached = true;
    out.note = IMAGE_ATTACH_NOTE;
    return {
        text: JSON.stringify(out),
        image: { mime: detectMime(base64), base64, chars: base64.length },
        changed: true,
        imageTooLarge: false,
        invalid: false,
    };
}

/** 这条 user 消息是不是「工具附图」（靠稳定文本标记识别，不靠额外字段）。 */
/**
 * 工具附图只在「本轮工具循环」内保留（iteration>0）。iteration 0 是新回合第一次请求，
 * 历史里的工具图一律剥掉 —— 否则一次 see image 的 base64 会永久驻留每轮请求（审计 P1-1）。
 * 纯函数，便于单测。
 */
function keepToolImageForIteration(iteration) {
    return Number(iteration) > 0;
}

function isToolImageMessage(msg) {
    if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) return false;
    const hasImage = msg.content.some((p) => p && p.type === 'image_url');
    if (!hasImage) return false;
    return msg.content.some((p) => p && p.type === 'text'
        && String(p.text == null ? '' : p.text).indexOf(TOOL_IMAGE_TEXT) === 0);
}

/** 组装一条 user 图片消息（OpenAI 兼容多模态数组）。 */
function buildToolImageMessage(image) {
    const mime = (image && image.mime) || 'image/jpeg';
    const b64 = String((image && image.base64) || '');
    return {
        role: 'user',
        content: [
            { type: 'text', text: TOOL_IMAGE_TEXT },
            { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64 } },
        ],
    };
}

/**
 * 把历史里的「工具附图」剥成文字（保留标记，不删消息、不动用户本轮截图）。
 * @returns {number} 被剥掉的条数
 */
function stripToolImages(messages) {
    if (!Array.isArray(messages)) return 0;
    let stripped = 0;
    for (const msg of messages) {
        if (!isToolImageMessage(msg)) continue;
        const textItems = msg.content.filter((p) => p && p.type === 'text');
        msg.content = textItems.length > 0
            ? textItems.map((p) => String(p.text == null ? '' : p.text)).join(' ')
            : '[工具截图已移除]';
        stripped += 1;
    }
    return stripped;
}

/**
 * 批量追加工具回执：先 push 全部 tool 消息（保证 tool_calls 后连续），再附图。
 * 同一批里有多张图时只保留**最后一张**（只保留最近 1 张的策略）。
 *
 * @param {Array} messages 宿主消息数组（原地改）
 * @param {Array<{tool_call_id:string,name?:string,content:*}>} toolMessages
 * @param {{attachImages?:boolean}} [opts]
 *   attachImages=false：模型已确认不支持图片（本轮剥图重试）→ 仍然把 base64 从文本里剥掉
 *   （绝不把 180KB 塞回上下文），但不追加图片消息，只留元素清单。
 * @returns {{attached:boolean, images:number, imageTooLarge:boolean, invalid:boolean, suppressed:boolean}}
 */
function appendToolResults(messages, toolMessages, opts) {
    const out = { attached: false, images: 0, imageTooLarge: false, invalid: false, suppressed: false };
    if (!Array.isArray(messages) || !Array.isArray(toolMessages)) return out;
    const attachImages = !(opts && opts.attachImages === false);
    let lastImage = null;
    for (const tm of toolMessages) {
        if (!tm) continue;
        const r = splitToolImageContent(tm.content);
        messages.push(Object.assign({}, tm, { content: r.text }));
        if (r.imageTooLarge) out.imageTooLarge = true;
        if (r.invalid) out.invalid = true;
        if (r.image) { lastImage = r.image; out.images += 1; }
    }
    if (lastImage) {
        if (!attachImages) { out.suppressed = true; return out; }   // 剥了图，但不发图
        stripToolImages(messages);            // 只留最近 1 张：先清历史工具图，再 push 新图
        messages.push(buildToolImageMessage(lastImage));
        out.attached = true;
    }
    return out;
}

module.exports = {
    keepToolImageForIteration,
    TOOL_IMAGE_TEXT,
    IMAGE_ATTACH_NOTE,
    MAX_TOOL_IMAGE_BASE64,
    MIN_IMAGE_BASE64_CHARS,
    detectMime,
    normalizeBase64,
    isLikelyBase64,
    looksLikeToolImageEnvelope,
    splitToolImageContent,
    isToolImageMessage,
    buildToolImageMessage,
    stripToolImages,
    appendToolResults,
};
