#!/usr/bin/env node
/**
 * _probe/test-recall-insights.cjs — 反思结论接入记忆召回（2026-11-21）
 *
 * 背景：docs/调研-三功能对标-2026-11-21.md §2.3「消费」行 ——
 *   insights.jsonl 写了没人读，是记忆反思最大的闭环缺口。
 * 这个测试盯住接入后的四条硬约束：
 *   ① 只索引 active / importance>=4 / confidence>=0.6 / superseded_by==null；
 *   ② 每轮自动注入最多 1 条结论，单条 ≤60 字（超长截断）；
 *   ③ insights.jsonl 不存在 / 空文件 / 坏行 → 静默跳过，不崩、不阻塞召回；
 *   ④ 与事实/对话同分混排时，结论排在事实之后、对话之前（SRC_RANK）。
 *
 * 判定：0 = 全过；非 0 = 有失败（check-all 认退出码）。
 * 用法：node _probe/test-recall-insights.cjs [--e2e]
 *   --e2e  额外跑真实记录室端到端（临时写入 1 合格 + 1 低重要度，跑完删除；
 *          若 insights.jsonl 已存在则跳过，绝不覆盖真实数据）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d',
    'plugins', 'community', 'memory-recall', 'index.js');
const P = require(PLUGIN);

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function tmpDir(tag) {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-insights-' + tag + '-'));
}

function rmrf(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }
}

async function makePlugin() {
    const p = new P();
    p.context = {
        getPluginFileConfig: () => ({}),
        log: () => {},
        addSystemPromptPatch: () => {},
        removeSystemPromptPatch: () => {},
        getMessages: () => [],
        callLLM: async () => 'ADD',
    };
    await p.onInit();
    p._hybrid = false;          // 单测不嵌向量，也别碰真实向量缓存
    p._maxDocs = 6000;
    p._reinforce = {};          // 不读真实强化表
    p._reinforceDocs = () => {}; // 不写真实强化表（mock 文本不该落盘）
    return p;
}

function writeLines(file, rows) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n', 'utf8');
}

(async () => {
    // ── ① 过滤：只索引够重、够可信、还活着、没被取代的结论 ────────────────
    const d1 = tmpDir('filter');
    try {
        const good = {
            id: 'ins_good_1', created_at: Date.now() - 3600000,
            text: '他最近总在深夜写代码，白天补觉，作息明显在往后挪。',
            keywords: ['熬夜', '作息', '写代码'],
            evidence_ids: ['ep:1:111', 'ep:2:222'],
            importance: 5, confidence: 0.8, status: 'active', superseded_by: null,
        };
        const good2 = {
            id: 'ins_good_2', created_at: Date.now() - 7200000,
            text: '他更喜欢有人陪着一起看番，而不是自己一个人刷完。',
            importance: 4, confidence: 0.6, status: 'active', superseded_by: null,
        };
        writeLines(path.join(d1, 'insights.jsonl'), [
            good,
            { id: 'ins_low_imp', text: '低重要度结论', importance: 3, confidence: 0.9, status: 'active', superseded_by: null },
            { id: 'ins_low_conf', text: '低置信度结论', importance: 5, confidence: 0.5, status: 'active', superseded_by: null },
            { id: 'ins_stale', text: '已过期结论', importance: 5, confidence: 0.9, status: 'superseded', superseded_by: null },
            { id: 'ins_old', text: '被取代结论', importance: 5, confidence: 0.9, status: 'active', superseded_by: 'ins_new' },
            '{坏行 not json',
            good2,
        ]);

        const p = await makePlugin();
        p._rebuild({ dir: d1, skipExternal: true });
        const docs = p._docs || [];
        ok('只索引 2 条合格结论（低重要度/低置信度/superseded/被取代/坏行全跳过）',
            docs.length === 2, 'docs=' + docs.length + ' [' + docs.map((x) => x.id).join(',') + ']');
        ok('索引来源标记为「结论」', docs.every((x) => x.src === '结论' && x.role === 'insight'));
        const byId = new Map(docs.map((x) => [x.id, x]));
        const g1 = byId.get('ins_good_1');
        ok('结论带 evidence_ids 供引用', !!g1 && Array.isArray(g1.evidence_ids) && g1.evidence_ids.length === 2,
            g1 ? JSON.stringify(g1.evidence_ids) : 'missing');
        ok('keywords 不拼进展示文本', !!g1 && !g1.text.includes('熬夜'), g1 && g1.text.slice(0, 24));
        const kwHits = p._search('熬夜', 5, 0) || [];
        ok('keywords 参与检索（查「熬夜」命中该结论）',
            kwHits.some((h) => h.doc.id === 'ins_good_1'), '返回 ' + kwHits.length + ' 条');
        ok('_sourcesText 显示结论条数', /结论 2/.test(p._sourcesText()), p._sourcesText());

        // ── ② 每轮最多 1 条、单条 ≤60 字 ─────────────────────────────────
        const longText = '这是一条很长的反思结论'.repeat(10);   // 80 字
        const hits = [
            { doc: { src: '结论', role: 'insight', text: '结论甲' }, score: 9 },
            { doc: { src: '结论', role: 'insight', text: '结论乙' }, score: 8 },
            { doc: { src: '对话', role: 'user', text: '原话丙' }, score: 7 },
            { doc: { src: '对话', role: 'user', text: '原话丁' }, score: 6 },
        ];
        const picked = p._pickInjectHits(hits, 3);
        ok('每轮最多注入 1 条结论（4 条候选只留 1 条结论）',
            picked.filter((h) => h.doc.src === '结论').length === 1,
            JSON.stringify(picked.map((h) => h.doc.text)));
        ok('结论不挤掉原话名额（3 条里 1 结论 + 2 原话）', picked.length === 3);

        const longLine = p._formatInjectLine({ doc: { src: '结论', role: 'insight', text: longText } });
        const marker = '（她自己的总结）';
        const body = longLine.slice(longLine.indexOf(marker) + marker.length);
        ok('超长结论截断到 ≤60 字', body.length <= 60, 'body=' + body.length);
        ok('截断有省略号', body.endsWith('…'));
        ok('结论明确标成「她自己的总结」（不是用户原话）',
            longLine.startsWith('· [结论/insight] ' + marker));
        const shortLine = p._formatInjectLine({ doc: { src: '结论', role: 'insight', text: '短结论' } });
        ok('短结论不截断', shortLine.endsWith('短结论'));
        const convLine = p._formatInjectLine({ doc: { src: '对话', role: 'user', text: '普通原话' } });
        ok('原话格式与旧版一致（无「总结」前缀）',
            convLine === '· [对话/user] 普通原话', convLine);

        // ── ③ 排序：事实 > 结论 > 对话（同分时按 SRC_RANK）─────────────────
        ok('SRC_RANK：事实 > 结论 > 对话',
            P.SRC_RANK['事实'] > P.SRC_RANK['结论'] && P.SRC_RANK['结论'] > P.SRC_RANK['对话'],
            JSON.stringify({ 事实: P.SRC_RANK['事实'], 结论: P.SRC_RANK['结论'], 对话: P.SRC_RANK['对话'] }));
        // 三条长度/词形/时间完全一致，只靠来源权重分先后
        p._installDocs([
            { src: '对话', role: 'user', text: '猫丙', t: 0 },
            { src: '结论', role: 'insight', text: '猫乙', t: 0 },
            { src: '事实', role: 'fact', text: '猫甲', t: 0 },
        ]);
        const mixed = (p._search('猫', 5, 0) || []).map((h) => h.doc.src);
        ok('同分混排顺序 = 事实 → 结论 → 对话', mixed.join('>') === '事实>结论>对话', mixed.join('>'));
    } finally { rmrf(d1); }

    // ── ③ 鲁棒：文件不存在 / 空文件 不崩 ───────────────────────────────
    const d2 = tmpDir('robust');
    try {
        const p = await makePlugin();
        let threw = null;
        try { p._rebuild({ dir: d2, skipExternal: true }); } catch (e) { threw = e; }
        ok('insights.jsonl 不存在 → 静默跳过，不抛错', !threw, threw && String(threw.message));
        ok('文件不存在时索引为空但不崩', Array.isArray(p._docs) && p._docs.length === 0);

        fs.writeFileSync(path.join(d2, 'insights.jsonl'), '', 'utf8');
        threw = null;
        try { p._rebuild({ dir: d2, skipExternal: true }); } catch (e) { threw = e; }
        ok('空文件 → 不崩', !threw && p._docs.length === 0);

        const arr = [];
        P.toDocsFromInsights(path.join(d2, '不存在.jsonl'), arr);
        ok('toDocsFromInsights 对缺失文件返回空', arr.length === 0);
    } finally { rmrf(d2); }

    // ── ④ 真实记录室端到端（可选）─────────────────────────────────────
    if (process.argv.includes('--e2e')) {
        const RECORDS = path.join(__dirname, '..', '_incoming', 'my-neuro', 'data');
        const target = path.join(RECORDS, 'insights.jsonl');
        if (fs.existsSync(target)) {
            console.log('  · SKIP 端到端：真实 insights.jsonl 已存在，不覆盖');
        } else {
            const validText = '他反复研究量子猫粮配方，说明真的打算养猫，不是随口说说。';
            const invalidText = '量子猫粮配方已经买到了。';
            try {
                writeLines(target, [
                    {
                        id: 'ins_e2e_ok', created_at: Date.now(), text: validText,
                        keywords: ['量子猫粮', '养猫'], evidence_ids: ['ep:1:1', 'ep:2:2'],
                        importance: 5, confidence: 0.8, status: 'active', superseded_by: null,
                    },
                    {
                        id: 'ins_e2e_low', created_at: Date.now(), text: invalidText,
                        keywords: ['量子猫粮'], evidence_ids: ['ep:3:3', 'ep:4:4'],
                        importance: 3, confidence: 0.9, status: 'active', superseded_by: null,
                    },
                ]);
                const p = await makePlugin();
                p._rebuild();   // 真实记录室
                const all = p._search('量子猫粮配方', 8, 0) || [];
                const texts = all.map((h) => String(h.doc.text));
                ok('E2E 合格结论进入召回', texts.some((t) => t.includes('真的打算养猫')), '返回 ' + all.length + ' 条');
                ok('E2E importance=3 的结论不进召回', !texts.some((t) => t.includes('已经买到了')));
                const gated = p._gateHits('量子猫粮配方', all, 3);
                const picked = p._pickInjectHits(gated, 3);
                const lines = picked.map((h) => p._formatInjectLine(h));
                ok('E2E 注入行 ≤1 条结论且带「她自己的总结」',
                    lines.filter((s) => s.includes('（她自己的总结）')).length <= 1
                    && lines.some((s) => s.includes('（她自己的总结）') && s.includes('真的打算养猫')),
                    JSON.stringify(lines));
                const body = (lines.find((s) => s.includes('（她自己的总结）')) || '')
                    .split('（她自己的总结）')[1] || '';
                ok('E2E 注入结论 ≤60 字', body.length > 0 && body.length <= 60, 'body=' + body.length);
            } finally {
                try { fs.unlinkSync(target); } catch (e) { /* 已删/没写成 */ }
                console.log('  · E2E 临时 insights.jsonl 已清理');
            }
        }
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
