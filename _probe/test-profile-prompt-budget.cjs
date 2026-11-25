#!/usr/bin/env node
/**
 * _probe/test-profile-prompt-budget.cjs —— 画像后台分析 prompt 预算（2026-11-25 P1）
 *
 * 现场（审计 §记忆链）：
 *   `_buildCandidatePrompt` 把整份缩进版画像 JSON（35KB）灌进 prompt，
 *   实测 15.6K tokens ×2（空回复重试同一份），max_tokens=4000 仍被 finish_reason=length
 *   截断，随后按「LLM 返回为空」每 3 分钟失败一次。
 *
 * 本测试只断言「预算契约」，不碰真实记录室、不调真 LLM：
 *   ① prompt 总字符 ≤6000；② 紧凑画像按类别 topN + 单条 80 字；
 *   ③ 超预算按 fact→trait→preference→habit 丢；④ max_tokens=1200；
 *   ⑤ 请求带 response_format(json_schema)；⑥ 服务端拒绝时降级一次；
 *   ⑦ finish_reason=length/空正文 → topN 减半重试一次；⑧ 两次都失败记 skip、不写空候选。
 *
 * 判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

const TMP = iso.setUpTempDataRoot('pet-profile-prompt-');
const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const Plugin = require(path.join(LIVE, 'plugins', 'community', 'user-profile', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function mk(opts = {}) {
    const dir = fs.mkdtempSync(path.join(TMP, 'case-'));
    const p = new Plugin();
    p._cfg = {};
    p._profilePath = path.join(dir, '用户画像.json');
    p._candidatePath = path.join(dir, '用户画像_候选.json');
    iso.assertIsolated(p._profilePath);
    p._today = () => '2026-11-25';
    p._renderedProfile = '';
    p._lastPromptStats = null;
    p._schemaWarned = false;
    const calls = [];
    p.context = {
        log: (lv, m) => calls.push({ lv, m: String(m) }),
        getPluginFileConfig: () => p._cfg,
        getMessages: () => [],
        callLLM: opts.callLLM || (async () => '{}'),
        on: () => {},
        off: () => {},
        addSystemPromptPatch: () => {},
        removeSystemPromptPatch: () => {},
    };
    return { p, dir, calls };
}

function bigProfile(len = 160) {
    const mkList = (n, prefix) => Array.from({ length: n }, (_, i) => prefix + i + '：' + '很长的画像描述'.repeat(Math.ceil(len / 7)));
    return {
        name: '主人',
        nickname: '阿主',
        habits: mkList(40, '习惯'),
        traits: mkList(30, '特质'),
        preferences: {
            likes: mkList(25, '喜欢'),
            dislikes: mkList(25, '讨厌'),
        },
        facts: mkList(30, '事实'),
        relationships: mkList(10, '关系'),
        _meta: { items: {} },
    };
}

/** 现实尺寸画像：条目短（≈25 字），全部装进 6000 预算还有富余 */
function realisticProfile() {
    const mkList = (n, prefix) => Array.from({ length: n }, (_, i) => prefix + i + '：睡前要喝一口温水');
    return {
        name: '主人',
        nickname: '阿主',
        habits: mkList(30, '习惯'),
        traits: mkList(20, '特质'),
        preferences: { likes: mkList(20, '喜欢'), dislikes: mkList(20, '讨厌') },
        facts: mkList(15, '事实'),
        relationships: ['和主人关系亲密'],
        _meta: { items: {} },
    };
}

function hugeMessages(n = 40, len = 600) {
    return Array.from({ length: n }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: '第' + i + '条：' + '对话内容'.repeat(Math.ceil(len / 4)),
    }));
}

function shortMessages(n = 40, len = 40) {
    return Array.from({ length: n }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: '第' + i + '条：' + '今天聊了点小事'.repeat(Math.ceil(len / 7)),
    }));
}

function extractProfileJson(prompt) {
    const marker = '单条 ≤80 字）：\n';
    const start = prompt.indexOf(marker);
    const end = prompt.indexOf('\n\n已有候选池摘要：');
    if (start < 0 || end < 0) return null;
    try { return JSON.parse(prompt.slice(start + marker.length, end)); } catch (e) { return null; }
}

(async () => {
    // ── ① 紧凑画像：topN + 单条 80 字 + 总量 ≤6000 ─────────────────────────
    {
        const { p } = mk();
        p._profile = p._normalizeProfile(realisticProfile());
        p._candidateStore = p._normalizeCandidates({ candidates: [], archived: [] });
        const prompt = p._buildCandidatePrompt(shortMessages());
        const stats = p._lastPromptStats;
        const prof = extractProfileJson(prompt);

        ok('prompt 总字符 ≤6000', prompt.length <= 6000, 'chars=' + prompt.length);
        ok('stats.chars 与实际一致', stats && stats.chars === prompt.length, JSON.stringify(stats));
        ok('stats.tokensEst 有值且 >0', stats && stats.tokensEst > 0, String(stats && stats.tokensEst));
        ok('画像段落是单行 JSON（不再缩进）', Boolean(prof) && !JSON.stringify(prof).includes('\n'));
        ok('紧凑画像可解析', Boolean(prof), prompt.slice(0, 80));
        ok('habit 截到 20 条', prof && prof.habits && prof.habits.length === 20, String(prof && prof.habits && prof.habits.length));
        ok('preference 合计 15 条（likes+dislikes）',
            prof && prof.preferences && (prof.preferences.likes.length + prof.preferences.dislikes.length) === 15,
            JSON.stringify(prof && prof.preferences && {
                likes: prof.preferences.likes.length, dislikes: prof.preferences.dislikes.length,
            }));
        ok('trait 截到 10 条', prof && prof.traits && prof.traits.length === 10, String(prof && prof.traits && prof.traits.length));
        ok('fact 截到 10 条', prof && prof.facts && prof.facts.length === 10, String(prof && prof.facts && prof.facts.length));
        ok('正常预算下不丢类别', stats && stats.dropped.length === 0, JSON.stringify(stats && stats.dropped));
        const all = [].concat(prof.habits || [], prof.traits || [], prof.facts || [],
            (prof.preferences && prof.preferences.likes) || [], (prof.preferences && prof.preferences.dislikes) || []);
        ok('单条画像 ≤80 字（含省略号）', all.every((t) => String(t).length <= 80), 'max=' + Math.max(...all.map((t) => String(t).length)));
        ok('画像段落体积远小于旧 35KB', stats && stats.profileChars < 5000, 'profileChars=' + (stats && stats.profileChars));
        ok('超长单条画像被截到 80 字',
            (() => {
                const q = mk().p;
                q._profile = q._normalizeProfile({ habits: ['超长条目：' + '啊'.repeat(300)] });
                q._candidateStore = q._normalizeCandidates({ candidates: [], archived: [] });
                const pp = q._buildCandidatePrompt([]);
                const pq = extractProfileJson(pp);
                return pq && pq.habits && pq.habits[0].length <= 80 && pq.habits[0].endsWith('…');
            })());
    }

    // ── ② 超预算裁剪顺序：fact → trait → preference → habit ────────────────
    {
        const { p } = mk();
        p._profile = p._normalizeProfile(bigProfile());
        p._candidateStore = p._normalizeCandidates({
            candidates: Array.from({ length: 80 }, (_, i) => ({
                id: 'c' + i, category: 'habit', text: '候选' + i, count: 1, first_seen: '2026-11-01', last_seen: '2026-11-20', status: 'candidate',
            })), archived: [],
        });
        // 故意放宽 caps 逼出预算闸（正常 caps 已能装下）
        const prompt = p._buildCandidatePrompt(hugeMessages(40, 900), {
            caps: { habit: 100, preference: 100, trait: 100, fact: 100 }, messageLimit: 40,
        });
        const stats = p._lastPromptStats;
        const prof = extractProfileJson(prompt);
        ok('超预算时 prompt 仍 ≤6000', prompt.length <= 6000, 'chars=' + prompt.length);
        ok('首个被丢的是候选摘要（辅助信息）', stats && stats.dropped[0] === 'candidates', JSON.stringify(stats && stats.dropped));
        const order = (stats && stats.dropped) || [];
        const idxCand = order.indexOf('candidates');
        const idxMsg = order.indexOf('messages');
        const idxFact = order.indexOf('fact');
        const idxTrait = order.indexOf('trait');
        const idxPref = order.indexOf('preference');
        const idxHabit = order.indexOf('habit');
        ok('裁剪顺序 candidates < messages < fact < trait < preference（habit 仅在仍超时才丢）',
            idxCand >= 0 && idxMsg >= 0 && idxFact >= 0 && idxTrait >= 0 && idxPref >= 0
            && idxCand < idxMsg && idxMsg < idxFact && idxFact < idxTrait && idxTrait < idxPref
            && (idxHabit < 0 || idxHabit > idxPref),
            JSON.stringify(order));
        ok('丢 fact 后画像是没有 facts', prof && !prof.facts, JSON.stringify(prof && Object.keys(prof)));
        ok('habit 最后才丢（若已丢则前面三类都丢了）',
            idxHabit < 0 || (idxFact >= 0 && idxTrait >= 0 && idxPref >= 0), JSON.stringify(order));
    }

    // ── ③ max_tokens=1200 + response_format ────────────────────────────────
    {
        const seen = [];
        const { p } = mk({ callLLM: async (prompt, opts) => { seen.push({ prompt, opts }); return '{"observations":[]}'; } });
        p._profile = p._normalizeProfile(bigProfile());
        p._candidateStore = p._normalizeCandidates({ candidates: [], archived: [] });
        await p._runCandidatePrompt(hugeMessages(2, 50), undefined, 40);
        const opts = seen[0] && seen[0].opts || {};
        ok('max_tokens 从 4000 降到 1200', opts.max_tokens === 1200, JSON.stringify(opts));
        ok('请求带 response_format(json_schema)', opts.response_format
            && opts.response_format.type === 'json_schema'
            && opts.response_format.json_schema
            && opts.response_format.json_schema.name === 'profile_observations',
            JSON.stringify(opts.response_format || null));
        ok('schema 里 observations 为数组', opts.response_format
            && opts.response_format.json_schema.schema.properties.observations.type === 'array');
    }

    // ── ④ 服务端拒绝 schema → 降级一次（不带 response_format）──────────────
    {
        const seen = [];
        const err = new Error('400 response_format is not supported');
        err.status = 400;
        const { p, calls } = mk({
            callLLM: async (prompt, opts) => {
                seen.push(opts);
                if (opts.response_format) throw err;
                return '{"observations":[]}';
            },
        });
        p._profile = p._normalizeProfile(bigProfile());
        p._candidateStore = p._normalizeCandidates({ candidates: [], archived: [] });
        const out = await p._callProfileLLM('x', { withMeta: true, schema: 'observations', max_tokens: 1200 });
        ok('拒绝后第二次调用不带 response_format', seen.length === 2 && !seen[1].response_format, 'calls=' + seen.length);
        ok('降级后仍拿到正文', out && out.text === '{"observations":[]}', JSON.stringify(out));
        ok('降级只 warn 一次', calls.filter((c) => /不支持 response_format/.test(c.m)).length === 1);
    }

    // ── ⑤ finish_reason=length → topN 减半重试；仍不行记 skip、不写候选 ──────
    {
        const prompts = [];
        const { p, calls } = mk({
            callLLM: async (prompt) => {
                prompts.push(prompt);
                // 第一次模拟被 max_tokens 截断（花括号不闭合），第二次给合法 JSON
                if (prompts.length === 1) return '{"observations":[{"match_id":null,"category":"habit","text":"半截';
                return '{"observations":[]}';
            },
        });
        p._profile = p._normalizeProfile(realisticProfile());
        p._candidateStore = p._normalizeCandidates({ candidates: [], archived: [] });
        const out = await p._extractCandidates(shortMessages(40, 60));
        ok('截断后重试了一次（共 2 次调用）', prompts.length === 2, 'calls=' + prompts.length);
        ok('重试 prompt 更紧凑（字符更少）', prompts[1].length < prompts[0].length,
            prompts[0].length + ' → ' + prompts[1].length);
        const first = extractProfileJson(prompts[0]);
        const second = extractProfileJson(prompts[1]);
        ok('重试画像 topN 减半（habit 20→10）',
            first.habits.length === 20 && second.habits.length === 10,
            (first.habits.length + ' → ' + second.habits.length));
        ok('重试日志带 promptChars/tokensEst/maxTokens/finishReason',
            calls.some((c) => /promptChars=/.test(c.m) && /tokensEst=/.test(c.m) && /maxTokens=1200/.test(c.m) && /finishReason=/.test(c.m)),
            calls.map((c) => c.m).filter((m) => /降级重试/.test(m)).join(' | '));
        ok('第二次成功 → 不 skip', !calls.some((c) => /profile\.analysis\.skip/.test(c.m)));
        ok('返回空观察数组（沿用合法空结果）', Array.isArray(out) && out.length === 0, JSON.stringify(out));

        // 两次都空 / 都截断 → skip 且不写候选
        const prompts2 = [];
        const { p: p2, calls: calls2 } = mk({
            callLLM: async (prompt) => { prompts2.push(prompt); return ''; },
        });
        p2._profile = p2._normalizeProfile(bigProfile());
        p2._candidateStore = p2._normalizeCandidates({ candidates: [], archived: [] });
        const before = JSON.stringify(p2._candidateStore);
        const out2 = await p2._extractCandidates(hugeMessages(40, 300));
        ok('两次空正文 → 调用两次', prompts2.length === 2, 'calls=' + prompts2.length);
        ok('两次空正文 → 返回空、不抛错', Array.isArray(out2) && out2.length === 0);
        ok('两次空正文 → 记 profile.analysis.skip reason:too_long',
            calls2.some((c) => /profile\.analysis\.skip/.test(c.m) && /too_long/.test(c.m)),
            calls2.map((c) => c.m).join(' | '));
        ok('skip 时不写空候选池', JSON.stringify(p2._candidateStore) === before);
    }

    // ── ⑥ 画像排序：最近出现的排前面（meta.last_seen）─────────────────────
    {
        const { p } = mk();
        const prof = p._normalizeProfile({
            habits: ['旧习惯', '新习惯', '没时间戳的习惯'],
            _meta: { items: {} },
        });
        p._profile = prof;
        p._touchProfileItem('habits', '旧习惯', '2026-01-01');
        p._touchProfileItem('habits', '新习惯', '2026-11-24');
        const prompt = p._buildCandidatePrompt([], { caps: { habit: 3, preference: 0, trait: 0, fact: 0 } });
        const parsed = extractProfileJson(prompt);
        ok('最近出现的行为排在前面', parsed && parsed.habits[0] === '新习惯', JSON.stringify(parsed && parsed.habits));
        ok('无时间戳的条目仍保留（排最后）', parsed && parsed.habits.includes('没时间戳的习惯'));
    }

    iso.cleanup(TMP);
    console.log(`\nPASS ${pass} / FAIL ${fail}`);
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('测试异常：' + (e && e.stack || e));
    try { iso.cleanup(TMP); } catch (e2) { /* ignore */ }
    process.exit(1);
});
