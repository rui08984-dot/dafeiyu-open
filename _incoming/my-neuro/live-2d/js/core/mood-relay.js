/**
 * mood-relay.js — 「主模型刚写的情绪」在两处之间传一句话（2026-11-18 §72）
 *
 * 为什么要单独一个模块：写的一方在 `js/ai/llm-handler.js`（主对话链），读的一方在
 * `main.js` 的 `ipc 'sense-intent-describe'`（语义兜底）。两边同进程，但不该互相 require
 * （llm-handler ← main.js 已经是一条重的依赖链）。一个只有 3 个函数的单例最省事，
 * 也让它可被单测直接驱动（不碰 Electron）。
 *
 * 语义：**只保留最新一条**。读的时候带新鲜度上限 —— 宁可拿不到，也不要拿上一句话的情绪
 * 去喂这一句（喂错情绪比没有情绪更糟，这是 §71.2 的结论）。
 */

'use strict';

const DEFAULT_MAX_AGE_MS = 20000;

const state = { at: 0, mood: '', text: '', from: '' };

/**
 * 主模型刚写完一句 → 把 mood 记下来。
 * @param {string} mood  情绪描述（≤40 字）
 * @param {{text?:string, from?:string, now?:number}} [meta]
 */
function setMood(mood, meta) {
  const value = String(mood == null ? '' : mood).trim().slice(0, 40);
  if (!value) return false;
  const m = meta || {};
  state.at = Number.isFinite(m.now) ? m.now : Date.now();
  state.mood = value;
  state.text = String(m.text || '').slice(0, 200);
  state.from = String(m.from || 'llm');
  return true;
}

/**
 * 取最新一条情绪（超时返回 null）。
 * @param {{maxAgeMs?:number, now?:number}} [opts]
 * @returns {{mood:string, text:string, from:string, ageMs:number}|null}
 */
function takeMood(opts) {
  const o = opts || {};
  const maxAge = Number.isFinite(o.maxAgeMs) ? o.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  if (!state.mood) return null;
  const age = now - state.at;
  if (!(age >= 0) || age > maxAge) return null;
  return { mood: state.mood, text: state.text, from: state.from, ageMs: age };
}

/** 清空（换会话/重置时用） */
function clear() { state.at = 0; state.mood = ''; state.text = ''; state.from = ''; }

module.exports = { setMood, takeMood, clear, DEFAULT_MAX_AGE_MS };
