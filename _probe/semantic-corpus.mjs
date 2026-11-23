#!/usr/bin/env node
/**
 * _probe/semantic-corpus.mjs — B6 语义兜底评测语料（唯一一份）
 *
 * 为什么单独成文件：`semantic-rewrite-eval.mjs`（oracle 上限实验）与
 * `semantic-rewrite-llm-eval.mjs`（真 LLM 端到端）必须用同一批句子，
 * 否则两次数值不可比（「同一指标两次测不同语料」等于没测）。
 *
 * 字段：[原句, 期望情绪键, 人工情绪描述（oracle）]
 * 期望情绪的取值与 LumenAct 的 category→emotion 映射同口径：
 *   happy / sad / angry / surprised / shy / smug / playful / neutral
 * 语气反讽、视语气而定的句子（'你可真行'、'哼，不理你了'）按「用户真实心情」标。
 */

export const CASES = [
  ['算了，不说了', 'sad', '有点失望和委屈，不想再解释'],
  ['你忙你的吧', 'sad', '嘴上说没事，其实有点失落'],
  ['哈哈哈这也太搞笑了', 'happy', '被逗得很开心，笑出声'],
  ['烦死了，又崩了', 'angry', '很烦躁，忍不住抱怨'],
  ['你怎么又忘了', 'angry', '有点生气，在责怪对方'],
  ['我有点累', 'sad', '疲惫，没什么力气说话'],
  ['明天再说吧', 'neutral', '没兴趣继续，想结束话题'],
  ['真的假的？', 'surprised', '很惊讶，不敢相信'],
  ['谢谢你啊', 'happy', '真心感谢，语气温和'],
  ['我害怕明天的面试', 'sad', '紧张不安，有点害怕'],
  ['哼，不理你了', 'playful', '撒娇式的赌气，其实没有真生气'],
  ['你可真行', 'angry', '反讽，带着不满'],
  ['我升职了！', 'happy', '兴奋地分享好消息'],
  ['好无聊啊', 'neutral', '提不起兴趣，觉得没意思'],
  ['对不起，是我不好', 'shy', '内疚，低声下气地道歉'],
  ['随便你吧', 'sad', '失望到不想争了'],
  ['我快撑不住了', 'sad', '很累很无力，快要放弃'],
  ['这也太难了吧', 'sad', '有点泄气，觉得困难'],
];

/** category（LumenAct 27 类）→ 我们的情绪键（与服务端同口径的粗映射） */
export const CATEGORY_TO_EMOTION = Object.freeze({
  微笑: 'happy', 大眼微笑: 'happy', 微笑_闭眼: 'happy', 开心欢快: 'happy', 欣慰宽慰: 'happy',
  星星眼: 'playful', 爱心眼: 'playful', 挑眉逗趣: 'playful', 卖萌和蔼安详: 'playful',
  惊讶震惊: 'surprised', 小眼震惊: 'surprised', 震惊疑惑质问: 'surprised',
  生气愤怒: 'angry', 厌烦厌恶: 'angry',
  难过流泪: 'sad', 痛苦疼痛: 'sad', 担忧担心: 'sad',
  害羞: 'shy', 尴尬: 'shy', 道歉抱歉: 'shy',
  骄傲自豪: 'smug',
  自然放松: 'neutral', 思考专注: 'neutral', 感觉无聊无趣: 'neutral',
  睡眼朦胧敷衍: 'neutral', 头晕目眩: 'neutral', 意志坚定: 'neutral',
  进入陌生环境担忧左顾右盼: 'neutral',
});

export function emotionOfCategory(category) {
  return CATEGORY_TO_EMOTION[String(category == null ? '' : category).trim()] || 'neutral';
}
