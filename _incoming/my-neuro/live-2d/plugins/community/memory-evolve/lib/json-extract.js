// plugins/community/memory-evolve/lib/json-extract.js —— 「从模型输出里取第一个完整 JSON 对象」
//
// 为什么单独抽出来（2026-11-21 审计 P2）：
//   reflect.js 早在审计 P2 #11 就把贪婪正则换成了括号配平，但 episode-store.js 还在用
//   `match(/\{[\s\S]*\}/)` —— 模型输出「解释 + 对象 + 更多文字」时，贪婪匹配会从第一个 `{`
//   一路吃到最后一个 `}`（甚至跨过第二个对象），JSON.parse 必失败。失败后片段游标不前进，
//   于是每 5 分钟用同一批对话再烧一次 LLM。两处必须共用同一份实现，不能再各写一套。
//
// 规则：
//   · 先剥 ```json 围栏（模型常见包装）
//   · 从第一个 `{` 开始做**括号配平**扫描，正确跳过字符串里的花括号和转义
//   · 返回第一个完整对象；解析失败/不是对象 → null（调用方据此决定「不前进游标」）
'use strict';

/**
 * 从可能带围栏/解释文字的模型输出里取第一个完整 JSON 对象。
 * @param {*} raw 模型原始输出
 * @returns {object|null} 解析出的普通对象；取不到或不是对象返回 null
 */
function pickJsonObject(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fence && fence[1] ? fence[1].trim() : s;
    const first = body.indexOf('{');
    if (first < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = first; i < body.length; i++) {
        const ch = body[i];
        if (inStr) {
            if (esc) { esc = false; continue; }
            if (ch === '\\') { esc = true; continue; }
            if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                try {
                    const j = JSON.parse(body.slice(first, i + 1));
                    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
                } catch (e) { return null; }
            }
        }
    }
    return null;
}

module.exports = { pickJsonObject };
