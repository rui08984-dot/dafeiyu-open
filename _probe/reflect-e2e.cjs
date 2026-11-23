// _probe/reflect-e2e.cjs —— 记忆反思的真 provider 端到端（只读、只打印，不落盘）
//
// 目的：验证 mock 之外的真实行为——JSON 合规率、token 成本、insight 质量。
// 不写 data/insights.jsonl（避免污染），只输出到 stdout。
//
// 用法：node _probe/reflect-e2e.cjs [--entries 3]
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const RECORDS = path.join(ROOT, '_incoming', 'my-neuro', 'data');
const { reflect } = require(path.join(LIVE, 'plugins', 'community', 'memory-evolve', 'lib', 'reflect.js'));

function readJsonl(p, n) {
    try {
        const rows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
        const out = [];
        for (const line of rows) {
            try { out.push(JSON.parse(line)); } catch (e) { /* 坏行跳过 */ }
            if (out.length >= n) break;
        }
        return out;
    } catch (e) { return []; }
}

function cfg() {
    const p = JSON.parse(fs.readFileSync(path.join(LIVE, 'llm_providers.json'), 'utf8'));
    const prov = (p.providers || []).find((x) => x.enabled !== false) || (p.providers || [])[0];
    const c = JSON.parse(fs.readFileSync(path.join(LIVE, 'config.json'), 'utf8'));
    const model = (c.llm && c.llm.model_id) || ((prov.models || [])[0] || {}).model_id;
    return { url: String(prov.api_url).replace(/\/$/, '') + '/chat/completions', key: prov.api_key, model };
}

async function callLLM(prompt, usageOut) {
    const { url, key, model } = cfg();
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'User-Agent': 'node' },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            stream: false,
        }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + text.slice(0, 300));
    const j = JSON.parse(text);
    if (usageOut) usageOut.push(j.usage || null);
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}

(async () => {
    const n = Number(process.argv.includes('--entries') ? process.argv[process.argv.indexOf('--entries') + 1] : 3) || 3;
    // 优先用真实 episode 卡片；没有就用对话历史里最后几条 user/assistant 拼
    let entries = readJsonl(path.join(RECORDS, 'episodes.jsonl'), 50)
        .map((e, i) => ({ id: 'ep:' + i, text: String(e.summary || e.text || e.title || '').slice(0, 300) }))
        .filter((e) => e.text);

    if (!entries.length) {
        const hist = readJsonl(path.join(RECORDS, '对话历史.jsonl'), 1000).slice(-40);
        entries = hist
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .map((m, i) => ({ id: 'h:' + i, text: (m.role === 'user' ? '用户：' : '她：') + m.content.slice(0, 200) }));
    }
    entries = entries.slice(0, n);

    if (entries.length < 2) {
        console.log('SKIP  没有足够的条目（<2），无法做反思端到端');
        process.exit(0);
    }

    console.log('输入条目 ' + entries.length + ' 条：');
    for (const e of entries) console.log('  [' + e.id + '] ' + e.text.slice(0, 60));

    const usage = [];
    const t0 = Date.now();
    const r = await callLLMTest(entries, usage);
    const took = Date.now() - t0;

    if (!r.ok) {
        console.log('\nFAIL  ' + r.error);
        console.log('raw: ' + String(r.raw || '').slice(0, 500));
        process.exit(1);
    }
    console.log('\nOK  insights=' + r.insights.length + ' dropped=' + r.dropped + ' 耗时=' + took + 'ms');
    for (const ins of r.insights) {
        console.log('  · ' + ins.text);
        console.log('    evidence=' + JSON.stringify(ins.evidence_ids) + ' depth=' + ins.depth + ' imp=' + ins.importance + ' conf=' + ins.confidence);
    }
    const u = usage[0];
    if (u) {
        const pt = u.prompt_tokens || u.input_tokens || 0;
        const ct = u.completion_tokens || u.output_tokens || 0;
        const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || u.cached_tokens || 0;
        console.log('\nusage: prompt=' + pt + ' completion=' + ct + ' cached=' + cached + ' total=' + (u.total_tokens || pt + ct));
    } else {
        console.log('\nusage: 拿不到（响应无 usage）');
    }

    async function callLLMTest(entriesIn, usageOut) {
        return reflect({
            entries: entriesIn,
            existingInsights: [],
            callLLM: (prompt) => callLLM(prompt, usageOut),
            maxEntries: 30,
            maxInsights: 3,
            maxTextChars: 200,
        });
    }
})();
