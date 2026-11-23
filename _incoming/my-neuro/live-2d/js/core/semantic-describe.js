/**
 * js/core/semantic-describe.js —— 「把用户话改写成一句情绪描述」的唯一提示词与清洗规则
 * （2026-11-18 §69 B6）
 *
 * 为什么单独抽出来：这段提示词既被线上（main.js 的 ipc sense-intent-describe）用，
 * 也被离线评测（_probe/semantic-rewrite-llm-eval.mjs）用。写在 main.js 里就没法
 * 在探针里复用 —— 探针测的就不再是线上那一版（「探针与线上漂移」这类事故已经有过）。
 *
 * 背景数据（_probe/semantic-rewrite-eval.mjs，18 条语料，oracle 描述）：
 *   原句→intent：可用率 22%、情绪对上 6%、均值置信 0.36
 *   描述→intent：可用率 44%、情绪对上 39%、均值置信 0.50
 *   同一句塞两个槽：22%（无帮助）—— 起作用的是**描述**本身。
 */

'use strict';

const DESCRIBE_SYSTEM_PROMPT = [
  '你的任务：把用户这句话改写成一句中文情绪描述。',
  '要求：只写情绪和语气（例如「有点失望和委屈，不想再解释」），不超过 20 字。',
  '禁止：引号、解释、复述原句内容、写标点以外的格式。',
].join('\n');

/**
 * 把模型输出洗成「一句描述」：去引号/换行、合并空白、截断 40 字。
 * 空结果返回空串（调用方据此判定失败，不要退回一句废话）。
 * @param {unknown} content
 * @returns {string}
 */
function sanitizeDescription(content) {
  return String(content == null ? '' : content)
    .replace(/["'“”‘’\s]+/g, ' ')
    .replace(/^[：:、,，.。]+/, '')
    .trim()
    .slice(0, 40);
}

module.exports = { DESCRIBE_SYSTEM_PROMPT, sanitizeDescription };
