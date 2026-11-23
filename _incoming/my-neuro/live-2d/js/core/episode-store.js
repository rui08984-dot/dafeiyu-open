/**
 * episode-store.js —— 空闲巩固：把一段对话压成「片段卡片」（2026-11-15 六十轮）
 *
 * 为什么要有这一层（调研结论第三条）：原文永远在 对话历史.jsonl 里，但**没人能一次读 700 轮**。
 * 到了「上周/上个月发生了什么」这种问法，词法检索只能碰到零散句子，拼不出经过。
 * episode = 一段时间的叙事卡片（标题 + 摘要 + 关键事实），在**空闲时**用一次 LLM 调用生成。
 *
 * 四条纪律（都是踩过坑的）：
 *   · **游标不前进 = 数据没丢**：LLM 失败/输出坏 → 不写卡片、不动游标，下次空闲再试
 *   · **空闲才做**：用户正在说话时不抢 LLM、不插队（默认 30 分钟没输入）
 *   · **有界**：一次最多吃 60 条真实对话（脚手架/系统行不算；必要时向后多扫几行，
 *     防止脚手架占满窗口时游标永远不动）；太长的段落切段，不做「无限上下文摘要」
 *   · **不改写原记录**：卡片是**追加**出来的新文件，原文一行不动（MIRIX 那条原则）
 *
 * 文件：data/episodes.jsonl（一行一张卡）+ data/集卡游标.json（{lines:N}）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { recordFile } = require('./records-path.js');
// 2026-11-21 审计 P2：解析必须用括号配平，不能贪婪 match(/\{[\s\S]*\}/) ——
// 模型输出「解释 + 对象 + 尾随文字」时贪婪会吃到最后一个 `}`，JSON.parse 必失败，
// 失败又不推进游标 → 每 5 分钟重烧一次同样的 LLM 调用。reflect.js 已有实现，两处共用。
const { pickJsonObject } = require('../../plugins/community/memory-evolve/lib/json-extract.js');
// 2026-11-22 审计 P0-5：片段卡只该收「真正发生过的话」。
// 主动开口的提示词（[自动触发]/屏幕提示/摸头模板…）是以 role=user 进对话历史的，
// 原来的 readTurns 只按 role 过滤，把它们当用户话压进片段卡 → 事实污染。
// 唯一判定源在 memory-scaffold.js（与 MemOS 写入前过滤共用同一套规则）；
// require 失败 fail-open（宁可按旧行为收录，也不能因为过滤器坏了让巩固整条停摆）。
let memoryScaffold = null;
try { memoryScaffold = require('./memory-scaffold.js'); } catch (e) { memoryScaffold = null; }

const EPISODE_FILE = 'episodes.jsonl';
const CURSOR_FILE = '集卡游标.json';

function episodePath() { return recordFile(EPISODE_FILE); }
function cursorPath() { return recordFile(CURSOR_FILE); }

function loadCursor() {
    try {
        const j = JSON.parse(fs.readFileSync(cursorPath(), 'utf8'));
        const n = Number(j && j.lines);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch (e) { return 0; }
}

function saveCursor(lines) {
    try {
        const p = cursorPath();
        const tmp = p + '.tmp';
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify({ lines, updated_at: Date.now() }, null, 2), 'utf8');
        fs.renameSync(tmp, p);
        return true;
    } catch (e) { return false; }
}

/**
 * 从 jsonl 的第 fromLine 行开始读，返回 {turns, consumed, total}。
 *
 * 2026-11-22 P0-5（反卡死）：跳过脚手架后，窗口里「真实 turn」可能不足。下游
 * memory-evolve 在 turns < minTurns 时**不前进游标**，而窗口固定从游标开始 ——
 * 如果前 60 行几乎全是脚手架，就会永远重读同一批行、片段巩固永久停摆。
 * 因此这里按**真实 turn 条数**取满 maxLines 条，必要时向后多扫几行；
 * 下游 LLM 输入仍然有界（≤maxLines 条 turn）。consumed 如实返回实际扫过的行数，
 * 调用方据此前进游标，跨过这批脚手架。
 */
function readTurns(jsonlPath, fromLine, maxLines) {
    let raw = '';
    try { raw = fs.readFileSync(jsonlPath, 'utf8'); } catch (e) { return { turns: [], consumed: 0, total: 0 }; }
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    const start = Math.max(0, Number(fromLine) || 0);
    const maxTurns = Math.max(1, Number(maxLines) || 60);
    const turns = [];
    let consumed = 0;
    for (let i = start; i < lines.length && turns.length < maxTurns; i += 1) {
        consumed += 1;
        let o;
        try { o = JSON.parse(lines[i]); } catch (e) { continue; }
        let text = '';
        if (typeof o.content === 'string') text = o.content;
        else if (Array.isArray(o.content)) text = o.content.map((c) => (c && c.text) || '').join(' ');
        text = String(text || '').trim();
        if (!text) continue;
        if (o.role !== 'user' && o.role !== 'assistant') continue;   // system/tool 不进卡片
        // 2026-11-22 P0-5：跳过程序脚手架 user 消息（判定见 memory-scaffold.js）。
        // assistant 的话是她自己说的，永远保留；「（笑）今天好热」这类真实动作描写也保留。
        if (o.role === 'user' && memoryScaffold && memoryScaffold.isScaffolding(text, 'user')) continue;
        turns.push({ role: o.role, text: text.slice(0, 400) });
    }
    return { turns, consumed, total: lines.length };
}

/** 追加一张卡片（原子追加：先写 tmp 再 rename 整文件，避免半行） */
function appendEpisode(ep) {
    try {
        const p = episodePath();
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const prev = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, prev + JSON.stringify(ep) + '\n', 'utf8');
        fs.renameSync(tmp, p);
        return true;
    } catch (e) { return false; }
}

function loadEpisodes() {
    try {
        const raw = fs.readFileSync(episodePath(), 'utf8');
        const out = [];
        for (const line of raw.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try { const o = JSON.parse(line); if (o && o.summary) out.push(o); } catch (e) { /* 坏行跳过 */ }
        }
        return out;
    } catch (e) { return []; }
}

/** 卡片 → 召回索引里的一条 doc（memory-recall 用） */
function episodeToDoc(ep) {
    const title = String((ep && ep.title) || '').slice(0, 40);
    const summary = String((ep && ep.summary) || '').slice(0, 300);
    const facts = Array.isArray(ep && ep.facts) ? ep.facts.filter(Boolean).slice(0, 3) : [];
    const text = (title ? '【片段】' + title + '：' : '【片段】') + summary + (facts.length ? '（' + facts.join('；') + '）' : '');
    return { src: '片段', role: 'episode', text, t: Number(ep && ep.at) || 0 };
}

/** 把 LLM 的输出解析成卡片字段；解析不出来返回 null（调用方据此**不动游标**） */
function parseCard(raw, meta) {
    const s = String(raw || '');
    const j = pickJsonObject(s);
    if (!j) return null;
    if (!j || !j.summary) return null;
    const summary = String(j.summary).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (summary.length < 6) return null;
    return {
        at: (meta && meta.at) || Date.now(),
        title: String(j.title || '').replace(/\s+/g, ' ').trim().slice(0, 24) || summary.slice(0, 12),
        summary,
        facts: Array.isArray(j.facts) ? j.facts.map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 3) : [],
        turns: Number(meta && meta.turns) || 0,
        span: (meta && meta.span) || null,
    };
}

module.exports = {
    episodePath, cursorPath, loadCursor, saveCursor,
    readTurns, appendEpisode, loadEpisodes, episodeToDoc, parseCard,
    EPISODE_FILE, CURSOR_FILE,
};
