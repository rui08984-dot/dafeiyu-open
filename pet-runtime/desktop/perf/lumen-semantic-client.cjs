/**
 * lumen-semantic-client.cjs —— LumenAct 语义选择器的 Node 客户端（2026-11-17 六十五轮）
 *
 * **这是唯一实现**：宿主侧 `js/core/lumen-semantic.js` 只是 re-export 本文件
 * （与 vts-server 同样的收敛原则：不留第二份）。
 *
 * 它做什么：把一句中文（情绪描述 + 台词）发给常驻服务，拿回
 *   `category`（27 类情绪外观）与 `voice`（14 类语音风格）。
 *
 * 为什么要服务化（ADR-004）：模型 146MB / 冷启动 ~11s / 单次 7–8.5ms。
 *   渲染层绝不能自己去加载模型（244ms~11s + 146MB），也不能在帧循环里调。
 *   常驻服务只加载一次，这里每次只做一次 HTTP。
 *
 * 服务：`pet-runtime/tools/lumen-semantic-server.py`（默认 127.0.0.1:8120）
 * 资产：`_research/lumenact/models/`（gitignored，缺失时服务 503、这里如实返回失败）
 *
 * 设计取舍：
 * - **用 node:http 不用 fetch**：Node 24 的 fetch/undici 有 keep-alive 句柄导致的退出断言
 *   （退出码 127 / `!(handle->flags & UV_HANDLE_CLOSING)`），探针与 CLI 里会假失败。
 *   `agent: false` + 显式 close 最稳。
 * - **失败一律返回 {ok:false}，不抛错**：调用方是情绪链路，模型服务挂了不能拖垮她说话。
 * - **超时默认 1.2s**：正常 8ms；超时说明服务卡了，当作没有这个能力。
 */

'use strict';

const http = require('node:http');

const DEFAULT_URL = 'http://127.0.0.1:8120';
const DEFAULT_TIMEOUT = 1200;

/** LumenAct 的 27 个 category → 我们的情绪键（与 facs-clip-director 的 label 表对应） */
const CATEGORY_TO_EMOTION = Object.freeze({
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

/** 14 类语音风格 → 我们语气链路的增益提示（1 = 不变；>1 更外放，<1 更收） */
const VOICE_TO_PROSODY = Object.freeze({
  neutral: { rate: 1.0, pitch: 1.0, energy: 1.0 },
  warm: { rate: 0.97, pitch: 1.02, energy: 1.0 },
  joyful: { rate: 1.06, pitch: 1.08, energy: 1.08 },
  playful: { rate: 1.05, pitch: 1.06, energy: 1.05 },
  curious: { rate: 1.02, pitch: 1.04, energy: 1.0 },
  firm: { rate: 0.98, pitch: 0.98, energy: 1.05 },
  urgent: { rate: 1.12, pitch: 1.04, energy: 1.1 },
  sad: { rate: 0.92, pitch: 0.94, energy: 0.92 },
  vulnerable: { rate: 0.9, pitch: 0.95, energy: 0.9 },
  fearful: { rate: 1.08, pitch: 1.06, energy: 0.95 },
  angry: { rate: 1.04, pitch: 1.02, energy: 1.12 },
  awkward: { rate: 0.96, pitch: 1.0, energy: 0.95 },
  apologetic: { rate: 0.94, pitch: 0.97, energy: 0.94 },
  guarded: { rate: 0.96, pitch: 0.98, energy: 0.96 },
});

function postJson(url, pathname, body, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let u;
    try { u = new URL(url + pathname); } catch (e) { return done({ ok: false, error: 'bad-url' }); }
    const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      method: 'POST',
      agent: false,               // 见文件头：避免 undici keep-alive 的退出断言
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 下面返回错误 */ }
        if (!json) return done({ ok: false, error: '非 JSON 响应', status: res.statusCode, raw: text.slice(0, 120) });
        done(Object.assign({ status: res.statusCode }, json));
      });
    });
    req.on('timeout', () => { req.destroy(); done({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => done({ ok: false, error: String(e && e.message || e) }));
    req.end(payload);
  });
}

function getJson(url, pathname, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url + pathname); } catch (e) { return resolve({ ok: false, error: 'bad-url' }); }
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'GET', agent: false, timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(Object.assign({ status: res.statusCode }, JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
        catch (e) { resolve({ ok: false, error: '非 JSON 响应', status: res.statusCode }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: String(e && e.message || e) }));
    req.end();
  });
}

/** category（LumenAct 的 27 类）→ 我们的情绪键；不认识就 neutral */
function emotionOf(category) {
  const c = String(category == null ? '' : category).trim();
  return CATEGORY_TO_EMOTION[c] || 'neutral';
}

/**
 * 语义分类。
 * @param {{intent?:string, text?:string, url?:string, timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, category?:string, confidence?:number, voice?:string,
 *                    emotion?:string, prosody?:object, elapsedMs?:number, error?:string}>}
 */
async function classify(opts = {}) {
  const intent = String(opts.intent || '').trim();
  const text = String(opts.text || '').trim();
  if (!intent && !text) return { ok: false, error: 'empty-input' };
  const res = await postJson(opts.url || DEFAULT_URL, '/semantic', { intent, text },
    Number(opts.timeoutMs) || DEFAULT_TIMEOUT);
  if (!res || res.ok !== true) {
    return { ok: false, error: (res && (res.error || res.detail)) || 'unavailable', status: res && res.status };
  }
  const emotion = emotionOf(res.category);
  return {
    ok: true,
    category: res.category,
    confidence: Number(res.confidence) || 0,
    voice: res.voice,
    voiceConfidence: Number(res.voiceConfidence) || 0,
    emotion,
    prosody: VOICE_TO_PROSODY[res.voice] || VOICE_TO_PROSODY.neutral,
    elapsedMs: Number(res.elapsedMs) || null,
  };
}

/** 服务健康（缺模型时返回 ok:false + 原因，不假装可用） */
async function health(opts = {}) {
  return getJson(opts.url || DEFAULT_URL, '/health', Number(opts.timeoutMs) || 800);
}

module.exports = { classify, health, emotionOf, CATEGORY_TO_EMOTION, VOICE_TO_PROSODY, DEFAULT_URL };
