/**
 * mood-line.js — 「让主模型顺带给一句情绪描述」的解析与流式过滤（2026-11-18 §72）
 *
 * 为什么要搭车（§71.2 拍板）：
 *   语义兜底原来靠「另开一次 LLM 把用户话改写成情绪描述」，实测 4.6–7.6s、而且把
 *   「你可真行」「哼，不理你了」判成「困惑无奈」——因为它**看不到她怎么回的**。
 *   搭车 = 让主模型在回复末尾附一行 `#mood: …`：
 *     · 零额外调用（同一次 completion，多 ~20 token）；
 *     · 情绪与**她自己那句话**一致（比只看用户话准）；
 *     · 解析到之后回填给语义兜底，慢改写彻底不用跑。
 *
 * 为什么需要流式过滤（这是本模块存在的真正原因）：
 *   回复是**边生成边喂 TTS** 的（ttsProcessor.addStreamingText 逐块）。如果 `#mood:` 直接
 *   流到 TTS，她就会把那行**念出来**。不能用「整段生成完再剥」——那时已经念了。
 *   所以这里做**最小 holdback**：只扣住「可能是标记前缀」的尾巴（`\n`、`\n#`、`\n#m`…），
 *   最多几十毫秒，听不出来；一旦确认不是标记就立刻放出去。
 *
 * 标记格式（刻意用 `#mood:` 而不是 <标签>）：
 *   提示词里明确禁止 <开心> 这类标签（会被念出来/污染台词），历史教训在
 *   dafeiyu-expression-pipeline。`#` 开头 + 行首，最不容易与正常台词撞车。
 */

'use strict';

/** 追加到系统提示词末尾的指令（静态字符串：不破坏前缀缓存） */
const MOOD_INSTRUCTION = [
  '',
  '---',
  '输出格式（最后一条，优先于上面的「别用列点」）：',
  '在回复的**最后另起一行**，写 `#mood: <一句不超过 20 字的情绪描述>`，描述你说这句话时的真实情绪与语气。',
  '这一行是给系统看的：不要加粗、不要加引号、不要翻译成英文、不要说「我是AI」，也不要把它写进正文中间。',
  '整条回复只有这一行允许出现 `#`。',
].join('\n');

// 尾巴版（每轮随请求发一次，~30 token）：实测 28 个工具在场时，系统提示词里的格式要求会被
// 模型忽略（同一提示词**不带工具**时 2/2 照做），贴在最后一条 user 消息附近服从度高得多。
const MOOD_TAIL_HINT = '回复最后另起一行写：#mood: <你这句话的真实情绪，不超过20字>。只有这一行带 #，不要写成正文。';

const MARKER = '#mood:';
/** holdback 最多扣住的字符数（标记前缀最长也就 "\n#mood:" 8 个字符 + 少量缓冲） */
const MAX_HOLD = 16;

/** 是否是「标记的可能前缀」：整段 tail 都必须能作为 `\n#mood:` 的前缀 */
function isMarkerPrefix(tail) {
  const t = String(tail);
  if (!t) return true;
  const full = '\n' + MARKER;
  // 允许模型写成行首 `#mood:`（前面没有换行，例如刚好是首块）
  if (full.startsWith(t) || MARKER.startsWith(t)) return true;
  // 行首可能带空白/全角空格
  const trimmed = t.replace(/^[\s\u3000]+/, '');
  if (!trimmed) return true;
  return full.startsWith(trimmed) || MARKER.startsWith(trimmed);
}

/**
 * 从一整段文本里取出并剥离 mood 行（非流式路径用）。
 * @param {string} text
 * @returns {{text:string, mood:string}} mood 为空串表示没写
 */
function extractMoodLine(text) {
  const raw = String(text == null ? '' : text);
  const lines = raw.split('\n');
  let mood = '';
  const kept = [];
  for (const line of lines) {
    const m = String(line).match(/^\s*#\s*mood\s*[:：]\s*(.*)$/i);
    if (m && !mood) { mood = String(m[1] || '').trim(); continue; }   // 只取第一处
    kept.push(line);
  }
  // 去掉结尾因剥离产生的空行
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  return { text: kept.join('\n'), mood };
}

/**
 * 流式过滤器：push(chunk) 返回「现在可以安全放给 TTS 的文本」，标记行被吃掉。
 *
 * @returns {{push:(chunk:string)=>{emit:string,mood:string}, flush:()=>{emit:string,mood:string}, mood:string}}
 */
function createMoodStreamFilter() {
  let carry = '';        // 可能属于标记前缀的尾巴
  let inMarker = false;  // 已确认进入标记行：丢弃直到换行
  let markerBuf = '';
  let mood = '';

  function consumeMarkerLine(text) {
    // ⚠ 这里最容易写错：触发进入标记状态的**那个换行**属于分隔符，不是标记行的行尾。
    //   原实现直接 indexOf('\n') 会在 0 处命中 → 立刻当作「标记行结束、mood 为空」，
    //   剩下的 `#mood: …` 又流回正文（实测：整段/大步长喂的时候标记就被念出来了）。
    //   所以先跳过行首的换行与空白，再从真正的标记文本里找行尾。
    let i = 0;
    while (i < text.length && (text[i] === '\n' || text[i] === '\r' || text[i] === ' ' || text[i] === '\t' || text[i] === '\u3000')) i += 1;
    const body = text.slice(i);
    const nl = body.indexOf('\n');
    if (nl < 0) { markerBuf += body; return { emit: '', done: false, rest: '' }; }
    markerBuf += body.slice(0, nl);
    const rest = body.slice(nl + 1);
    const parsed = markerBuf.replace(/^\s*#\s*mood\s*[:：]\s*/i, '').trim();
    if (!mood && parsed) mood = parsed;
    inMarker = false;
    markerBuf = '';
    return { emit: '', done: true, rest };
  }

  function push(chunk) {
    let text = carry + String(chunk == null ? '' : chunk);
    carry = '';
    let emit = '';

    if (inMarker) {
      const r = consumeMarkerLine(text);
      emit += r.emit;
      if (!r.done) return { emit, mood };
      text = r.rest;
    }

    // 扫描：遇到行首 `#mood:` 就切进去
    const idx = text.search(/\n\s*#\s*mood\s*[:：]/i);
    const atStart = /^\s*#\s*mood\s*[:：]/i.test(text);
    if (atStart) {
      inMarker = true;
      const r = consumeMarkerLine(text);
      emit += r.emit;
      text = r.rest || '';
      if (!r.done) return { emit, mood };
    } else if (idx >= 0) {
      emit += text.slice(0, idx);           // 标记前的正文照常放出去
      inMarker = true;
      const r = consumeMarkerLine(text.slice(idx));
      emit += r.emit;
      text = r.rest || '';
      if (!r.done) return { emit, mood };
    }

    // 关键：扣住「可能是标记前缀」的尾巴
    let cut = text.length;
    for (let i = Math.max(0, text.length - MAX_HOLD); i < text.length; i += 1) {
      const tail = text.slice(i);
      if (isMarkerPrefix(tail)) { cut = i; break; }
    }
    emit += text.slice(0, cut);
    carry = text.slice(cut);
    return { emit, mood };
  }

  return {
    push,
    flush() {
      // 收尾：carry 里如果真是标记（没有换行收尾），也吃掉
      const leftover = carry;
      carry = '';
      if (inMarker) {
        const parsed = markerBuf.replace(/^\s*#\s*mood\s*[:：]\s*/i, '').trim();
        if (!mood && parsed) mood = parsed;
        inMarker = false;
        markerBuf = '';
        return { emit: '', mood };
      }
      const { text, mood: m } = extractMoodLine(leftover);
      if (!mood && m) mood = m;
      return { emit: text, mood };
    },
    get mood() { return mood; },
  };
}

module.exports = { MOOD_INSTRUCTION, MOOD_TAIL_HINT, MARKER, extractMoodLine, createMoodStreamFilter, isMarkerPrefix };
