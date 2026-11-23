/**
 * js/core/world-adapters.js — 世界感知的 4 个便宜适配器（2026-11-17 六十二轮）
 *
 * 每个适配器只做「读一个源，翻译成统一形状」，不做任何判断。统一形状：
 *   { fg:{ok,title,app,fullscreen}, idleMs, media:{ok,status,title,app}, clip:{hash,chars}, us }
 *
 * 三个成本上的决定（都为了「常开也不心疼」）：
 *
 * 1. **前台/空闲/媒体合成一次 pet-core `world` 调用**。
 *    三个源分开问就是三次跨进程往返；合成一次实测 3.8–4.2ms（首个 18ms 是 WinRT 初始化）。
 *
 * 2. **剪贴板只留 hash + 长度，不留正文**。
 *    正文进世界状态 = 把用户复制的密码/私信塞进上下文。hash 足够判「变了没」。
 *
 * 3. **低功耗模式读 `world{media:false}`**：跳过 WinRT/SMTC 往返，实测 122µs。
 *
 * 纯模块（除了可注入的 pet-core 客户端与剪贴板读取器），可单测。
 */

'use strict';

const { getClient } = require('./pet-core-client.js');

/** FNV-1a 32 位：剪贴板正文不进世界状态，只留指纹。
 *  为什么不用 crypto：这是每秒一次的「变了没」，不是安全边界；FNV 更快且无依赖。 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

/** 默认剪贴板读取器（Electron）；拿不到就退化成 null（非 Electron 环境/单测） */
function defaultClipboardReader() {
  try {
    // eslint-disable-next-line global-require
    const { clipboard } = require('electron');
    if (!clipboard || typeof clipboard.readText !== 'function') return null;
    return () => String(clipboard.readText() || '');
  } catch (e) {
    return null;
  }
}

/**
 * opts:
 *   sources.foreground / idle / media / clipboard  单源开关（默认全开）
 *   lowPower       true = 只留前台+空闲（不读 SMTC、不读剪贴板）
 *   call          注入 pet-core 客户端 call()（测试用；默认 getClient().call）
 *   readClipboard 注入剪贴板读取器（测试用）
 *   maxClipChars  剪贴板最多看多少字符（默认 8192，避免复制大文本时每秒哈希几十 MB）
 */
function createWorldAdapters(opts) {
  const o = opts || {};
  const src = Object.assign({ foreground: true, idle: true, media: true, clipboard: true }, o.sources || {});
  if (o.lowPower) { src.media = false; src.clipboard = false; }
  const call = typeof o.call === 'function' ? o.call : ((req, t) => getClient().call(req, t));
  const readClipboard = o.readClipboard !== undefined ? o.readClipboard : defaultClipboardReader();
  const maxClipChars = Number(o.maxClipChars) || 8192;

  const stats = { samples: 0, errors: 0, lastErr: '', lastUs: 0, lastSystemUs: 0 };
  let lastClipHash = null;

  /** 只有一个源都不开时才真的不采样 —— 否则一次 world 调用就能覆盖前三个 */
  function anySystemSource() {
    return src.foreground || src.idle || src.media;
  }

  async function sample() {
    stats.samples += 1;
    const out = { fg: null, idleMs: null, media: null, clip: null, us: 0, errors: [] };

    if (anySystemSource()) {
      try {
        const r = await call({ cmd: 'world', media: src.media !== false }, 4000);
        if (r && r.ok) {
          if (src.foreground && r.fg) out.fg = r.fg;
          if (src.idle && Number.isFinite(Number(r.idle_ms))) out.idleMs = Number(r.idle_ms);
          if (src.media && r.media) out.media = r.media;
          out.us = Number(r.us) || 0;
        } else {
          stats.errors += 1;
          stats.lastErr = (r && (r.error || r.reason)) || 'world 调用失败';
          out.errors.push('system: ' + stats.lastErr);
        }
      } catch (e) {
        stats.errors += 1;
        stats.lastErr = String((e && e.message) || e);
        out.errors.push('system: ' + stats.lastErr);
      }
    }

    if (src.clipboard && typeof readClipboard === 'function') {
      try {
        const text = String(readClipboard() || '').slice(0, maxClipChars);
        if (text) {
          const h = fnv1a(text);
          if (h !== lastClipHash) {
            lastClipHash = h;
            out.clip = { hash: h, chars: text.length };
          }
        } else if (lastClipHash !== null) {
          lastClipHash = null;   // 清空了也算一次变化（上层会看到 chars=0）
          out.clip = { hash: 'empty', chars: 0 };
        }
      } catch (e) {
        stats.errors += 1;
        stats.lastErr = String((e && e.message) || e);
        out.errors.push('clipboard: ' + stats.lastErr);
      }
    }

    stats.lastUs = out.us;
    stats.lastSystemUs = out.us;
    return out;
  }

  return { sample, stats, sources: src, lowPower: !!o.lowPower, fnv1a };
}

module.exports = { createWorldAdapters, fnv1a, defaultClipboardReader };
