// text-emotion.js —— 从「正在说的这句话」推断表情
//
// 为什么需要它（2026-11-12 根因）：
//   表情通道原本只吃文本里的 <开心> 这类标签（prepareTextForTTS → parseEmotionTagsWithPosition），
//   而 system_prompt 明确写着「**不要**用 <开心> <生气> 这类标签，正常说话就行」——
//   于是标签永远是空的，脸只能跟着 1.5s 一次的心情快照走，和她当下这句话经常对不上。
//   这里把驱动源换成句子本身：每段 TTS 文本进来先推断一次，有明确倾向才切表情。
//
// 设计取舍：
//   · 宁可「不表态」也不乱切 —— 中性句子返回 null，保持当前表情，避免每句都抽一下。
//   · 只用确定性线索（语气词/标点/情绪词），不引模型：单次 <1ms，不占设备、不联网。
//   · 返回 score 0~1，调用方可以据此决定「立刻切」还是「只在当前情绪已经淡了才切」。

const CUE_TABLE = [
  { emotion: '生气', base: 0.55, cues: ['烦死了', '烦', '气死', '讨厌', '哼', '凭什么', '无语', '搞什么', '别闹', '滚', '火大', '忍不了', '过分', '离谱'] },
  { emotion: '难过', base: 0.5, cues: ['唉', '难过', '委屈', '伤心', '算了', '没意思', '想哭', '孤单', '难受', '失落', '可惜'] },
  { emotion: '开心', base: 0.55, cues: ['哈哈', '嘿嘿', '笑死', '太好了', '好耶', '开心', '喜欢', '真棒', '不错', '爽', '舒服', '有意思', '好玩'] },
  { emotion: '惊讶', base: 0.55, cues: ['真的假的', '居然', '没想到', '天啊', '哇', '咦', '啊？', '什么鬼', '不会吧'] },
  { emotion: '害羞', base: 0.5, cues: ['不好意思', '害羞', '脸红', '别说了', '唔', '那个', '讨厌啦', '才没有'] },
  { emotion: '俏皮', base: 0.45, cues: ['略略', '才不', '就不', '逗你', '哼哼', '偏不', '你猜', '嘻嘻'] },
];

// 强标点作为语气加权：连续问号/感叹号/省略号是「情绪浓度」的可靠代理
const PUNCT_BOOST = [
  { re: /[!！]{2,}/, add: 0.2 },
  { re: /[?？]{2,}/, add: 0.15 },
  { re: /…{2,}|\.{3,}/, add: 0.1 },
  { re: /[!！]/, add: 0.08 },
  { re: /[?？]/, add: 0.05 },
];

// 这些词会把「开心」拉向「俏皮」：逗弄语气本身就带着玩心
const TEASE_HINTS = ['你猜', '才不', '就不', '逗你', '略', '嘻嘻'];

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * 从句子里推断表情。
 * @param {string} text 单段待朗读文本（已去掉标签）
 * @returns {{emotion:string, score:number, hits:string[]}|null} 没有明确倾向时返回 null
 */
function inferEmotion(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  // 太长的一段里同时出现多种情绪线索时，取命中权重最高的；纯叙述不切表情
  const scores = [];
  for (const row of CUE_TABLE) {
    let score = 0;
    const hits = [];
    for (const cue of row.cues) {
      if (s.includes(cue)) {
        // 长词更可信：两字以上按 1 倍，单字（哼/哇/咦）减半，避免「啊」这种误触发
        const w = cue.length >= 2 ? 1 : 0.5;
        score += row.base * w;
        hits.push(cue);
      }
    }
    if (score > 0) scores.push({ emotion: row.emotion, score, hits });
  }
  if (!scores.length) return null;

  // 标点加权（对所有候选一致，不改变相对排序，只抬整体强度）
  let boost = 0;
  for (const p of PUNCT_BOOST) if (p.re.test(s)) boost += p.add;

  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  // 命中太少（例如只有单个「哼」）且没有强标点时，不表态
  if (top.score < 0.45 && boost < 0.1) return null;

  let emotion = top.emotion;
  // 逗弄型线索存在时，开心/生气 都更容易被读成俏皮
  if (emotion !== '害羞' && TEASE_HINTS.some((h) => s.includes(h)) && scores.some((x) => x.emotion === '俏皮')) {
    emotion = '俏皮';
  }
  const score = clamp01(top.score + boost);
  return { emotion, score, hits: top.hits };
}

module.exports = { inferEmotion };
