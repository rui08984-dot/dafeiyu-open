// viseme.js —— 口型驱动（拍板：pypinyin 路线）。汉字→韵母→开口度。
//
// 第一性原理：嘴形跟的是**音节主元音**。韵母→主元音两级映射：
//   ① 缩写韵母先展开（拼音正字法把 iou/uei/uen 缩写成 iu/ui/un，主元音藏在中间——
//      iu 主元音是 o、ui/un 主元音是 e，直接扫会错）；
//   ② 剩余复合韵母按响度序 a > o > e > i > u > ü 取第一个命中的元音。
// 韵母来源：pet-runtime/tools/pinyin_mouth.py（pypinyin，异步预热进缓存）。
// 缓存没命中的字返回 null——调用方（TextMouthDriver）回落正弦振荡，永不卡壳。
'use strict';
const __silentAudit = require('../core/silent-audit.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolvePython } = require('../core/runtime-paths');

// 2026-11-27 安装包 A：原来写死 <user-home>/.../python.exe 与 <project-root>/...py，
// 换机器必失效（嘴形静默退回正弦）。现在按「项目根/pet-runtime/tools」找脚本，
// 解释器走 runtime-paths（PET_PYTHON → 配置 → PATH）。
function findProjectRoot(start) {
    let dir = path.resolve(start);
    for (let i = 0; i < 10; i += 1) {
        try { if (fs.existsSync(path.join(dir, 'pet-runtime', 'tools'))) return dir; } catch (e) { /* 继续向上 */ }
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return path.resolve(start);
}
const PY_SCRIPT = path.join(findProjectRoot(__dirname), 'pet-runtime', 'tools', 'pinyin_mouth.py');

// 缩写韵母的真实主元音 + 单元音开口度（a 最大，u 最小，ü 介于 i/u 之间）
const VOWEL_OPENNESS = { a: 1.0, o: 0.72, e: 0.5, i: 0.28, u: 0.16, v: 0.2 };
// 成音节鼻音（嗯/呣 这类字，韵母就是 n/m/ng）
const NASAL_OPENNESS = { n: 0.22, m: 0.18, ng: 0.26 };

function opennessForFinal(f) {
    let s = String(f || '').toLowerCase();
    if (!s) return 0.3;
    if (s === 'iu') s = 'iou';   // 缩写展开（主元音 o）
    else if (s === 'ui') s = 'uei';   // 主元音 e
    else if (s === 'un') s = 'uen';   // 主元音 e
    if (NASAL_OPENNESS[s] !== undefined) return NASAL_OPENNESS[s];
    for (const v of ['a', 'o', 'e', 'i', 'u', 'v']) {
        if (s.includes(v)) return VOWEL_OPENNESS[v];
    }
    return 0.3;   // 认不出的韵母给个中开口，别闭死
}

// ── 预热缓存（char → openness）────────────────────────────────────────
// 全局共享：TextMouthDriver 每次推整段文本时调 prefetch（一次 python 调用 ~300ms，
// pypinyin 导入占大头），之后逐字 push 就能命中缓存拿形状。
const cache = new Map();
const CACHE_CAP = 600;
let busy = false;
let pending = '';

function prefetch(text) {
    const s = String(text || '');
    if (!/[\u4e00-\u9fff]/.test(s)) return;   // 无汉字零成本跳过
    pending += s;
    if (busy) return;
    // 合并抖动：100ms 内的多次 push 攒成一次 python 调用
    setTimeout(flushPrefetch, 100);
}

function flushPrefetch() {
    const text = pending;
    pending = '';
    if (!text || busy) return;
    // 已全缓存的文本不重复跑
    const chars = [...new Set([...text].filter((c) => c >= '\u4e00' && c <= '\u9fff'))];
    if (chars.length && chars.every((c) => cache.has(c))) return;
    // 脚本/解释器缺失（薄装未装 python 组件）→ 静默退回正弦口型，不刷错误、不 spawn。
    let py = '';
    try { py = resolvePython(); } catch (e) { py = ''; }
    try { if (!fs.existsSync(PY_SCRIPT)) py = ''; } catch (e) { py = ''; }
    if (!py) return;
    busy = true;
    const child = spawn(py, [PY_SCRIPT, text], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', (err) => {
        busy = false;
        try { __silentAudit.audit('viseme.js:62', err); } catch (e2) {}
        console.warn('[viseme] Python 口型进程启动失败（回落正弦）：' + (err && err.message || err));
    });
    child.on('close', () => {
        busy = false;
        try {
            const arr = JSON.parse(out);
            for (const item of arr) {
                if (item && item.c) {
                    if (cache.size >= CACHE_CAP) cache.delete(cache.keys().next().value);   // LRU
                    cache.set(item.c, opennessForFinal(item.f));
                }
            }
        } catch (e) { try { __silentAudit.audit('viseme.js:72', e); } catch (e2) {} }
    });
    setTimeout(() => { try { child.kill(); } catch (e) { try { __silentAudit.audit('viseme.js:74', e); } catch (e2) {} } busy = false; }, 5000);
}

/** 字→开口度（0~1）；未预热返回 null（调用方回落）。 */
function shapeFor(char) {
    return cache.get(String(char && char[0])) ?? null;
}

module.exports = { opennessForFinal, prefetch, shapeFor, cacheSize: () => cache.size, VOWEL_OPENNESS, NASAL_OPENNESS };
