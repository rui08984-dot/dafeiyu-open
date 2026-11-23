#!/usr/bin/env node
/**
 * _probe/test-memory-recall.cjs — 记忆召回索引回归（2026-11-15 五十八轮）
 *
 * 为什么需要：agent 盘点实测出四个「检索不可信」的硬证据，全都发生在**真实数据**上：
 *   · 记忆库.txt 1066 行里 691 行是 `交互N：` 空占位、12 条分隔线、12 条日期头被编进索引
 *   · 对话历史.jsonl 里的 `[历史压缩]` 系统标记被当成对话
 *   · `想玩` 查询返回 3 条一模一样的记忆（同一句话三份来源）
 *   · `recent_timeline` 返回 10-31 的旧笔记，而不是最近的对话（取的是合并数组尾部）
 *   · 年龄用合并下标折算 → 最新对话被当最老、旧笔记被当最新（衰减反了）
 *
 * 这个测试**不造假数据**：直接读她的真实记录室（只读），断言上面五条都修好了。
 * 判定：0 = 全过；非 0 = 有失败（check-all 认退出码）
 */
'use strict';

const path = require('path');
const P = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'memory-recall', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

(async () => {
    const p = new P();
    // ⚠ 必须 onInit：否则 _minScore/_minRel 等配置全是 undefined。
    //   旧闸是「fail-open」（undefined 比较恒 false → 全放行），改成 fail-closed 后
    //   这个测试立刻红了 —— 说明它之前一直靠未初始化状态在跑。
    p.context = {
        getPluginFileConfig: () => ({}),
        log: () => {},
        addSystemPromptPatch: () => {}, removeSystemPromptPatch: () => {},
        getMessages: () => [], callLLM: async () => 'ADD',
    };
    await p.onInit();
    p._maxDocs = 6000;      // 多装一点，别因为上限把问题样本裁掉
    // 测试关掉混合召回：否则 _rebuild 会在后台开始嵌 700+ 条向量，把门禁拖到超时
    p._hybrid = false;

    p._rebuild();

    const docs = p._docs || [];
    ok('索引非空（真数据在）', docs.length > 100, 'docs=' + docs.length + ' / ' + p._sourcesText());

    // ① 垃圾行不得进索引
    const placeholder = docs.filter((d) => /^交互\d+\s*[：:]\s*$/.test(d.text));
    ok('空占位 `交互N：` 不进索引', placeholder.length === 0, '命中 ' + placeholder.length + ' 条');
    const sep = docs.filter((d) => /^[-=_*]{3,}$/.test(String(d.text).trim()));
    ok('分隔线不进索引', sep.length === 0, '命中 ' + sep.length + ' 条');
    const dateHdr = docs.filter((d) => /^\[?\d{4}(?:[-/年])\d{1,2}(?:[-/月])\d{1,2}日?\]?$/.test(String(d.text).trim()));
    ok('日期头不进索引', dateHdr.length === 0, '命中 ' + dateHdr.length + ' 条');
    const archive = docs.filter((d) => /^\[(?:历史压缩|历史对话总结)\]/.test(String(d.text).trim()));
    ok('`[历史压缩]` 系统标记不进索引', archive.length === 0, '命中 ' + archive.length + ' 条');
    const prefixOnly = docs.filter((d) => /^【[^】]{1,20}】\s*[:：]?\s*$/.test(String(d.text).trim()));
    ok('只有说话人前缀没正文的行不进索引', prefixOnly.length === 0, '命中 ' + prefixOnly.length + ' 条');

    // ② 时间信息真的挂上了（没有时间戳的来源也要有 rank 兜底）
    const memDocs = docs.filter((d) => d.src === '记忆库');
    const withT = memDocs.filter((d) => Number(d.t) > 0);
    ok('记忆库条目带真实日期（来自 [YYYY年M月D日] 游标）', memDocs.length === 0 || withT.length > 0,
        withT.length + '/' + memDocs.length);
    const convDocs = docs.filter((d) => d.src === '对话');
    const ranked = convDocs.filter((d) => Number.isFinite(d.rank));
    ok('对话条目有 rank（append-only 顺序兜底年龄）', convDocs.length === 0 || ranked.length === convDocs.length,
        ranked.length + '/' + convDocs.length);

    // ③ 去重：同一个词不再返回三条一模一样
    const hits = p._search('想玩', 5, 0) || [];
    const texts = hits.map((h) => String(h.doc.text || '').replace(/\s+/g, ''));
    ok('搜索结果文本互不相同（去重生效）', new Set(texts).size === texts.length, '返回 ' + texts.length + ' 条 / 去重后 ' + new Set(texts).size);

    // ④ recent_timeline：优先最近对话，且第一条就是最后一条对话
    const raw = await p.executeTool('recent_timeline', { n: 3 });
    const j = JSON.parse(raw);
    const items = (j && j.items) || [];
    ok('recent_timeline 返回 3 条', items.length === 3, JSON.stringify(items.map((x) => x.src)));
    if (convDocs.length) {
        const lastConv = convDocs[convDocs.length - 1];
        ok('recent_timeline 第一条 = 最后一条对话（不是旧笔记）',
            items[0] && items[0].text === String(lastConv.text).slice(0, 120),
            'got「' + String(items[0] && items[0].text || '').slice(0, 40) + '」 want「' + String(lastConv.text).slice(0, 40) + '」');
    } else {
        console.log('  · 跳过「第一条=最后一条对话」（当前没有对话数据）');
    }

    // ⑤ 年龄不再反：最新的对话应比 10-31 的旧笔记「更新」（activity 更高）
    //    直接用内部公式复算一次（不依赖私有方法）
    const ageOf = (d) => {
        const t = Number(d.t) || 0;
        return t > 0 ? Math.max(0, (Date.now() - t) / 86400000) : Math.min(120, (Number(d.rank) || 0) * 3);
    };
    const newestConv = convDocs[convDocs.length - 1];
    const oldNote = memDocs.find((d) => Number(d.t) > 0 && Math.abs(Number(d.t) - new Date(2026, 9, 31).getTime()) < 86400000);
    if (newestConv && oldNote) {
        const a1 = ageOf(newestConv);
        const a2 = ageOf(oldNote);
        ok('最新对话比 10-31 的旧笔记更「新」（衰减方向正确）', a1 < a2, 'newestConv=' + a1.toFixed(1) + 'd vs oldNote=' + a2.toFixed(1) + 'd');
    } else {
        console.log('  · 跳过衰减方向断言（样本不足）');
    }

    // ⑤ 自动注入的三道闸（2026-11-15 二次校准）：短查询要能召回，空查询要挡住
    const gateOf = (raw) => {
        const text = String(raw)
            .replace(/你还记得|你记得|记得吗|记不记得|上次|上回|之前|以前|我说过|说过的|跟你说的/g, ' ')
            .replace(/那个|那个事|那件事|那个东西|什么来着|来着|吗|呢|吧/g, ' ').trim();
        const all = p._search(text, 7, 0) || [];
        return { cand: all.length, hit: p._gateHits(text, all, 3).length };
    };
    const gCat = gateOf('我养的猫叫什么');
    ok('短而准的查询能召回（「我养的猫叫什么」）', gCat.hit >= 1, '候选 ' + gCat.cand + ' / 注入 ' + gCat.hit);
    const gTrip = gateOf('我下周要去杭州出差');
    ok('「我下周要去杭州出差」能召回', gTrip.hit >= 1, '候选 ' + gTrip.cand + ' / 注入 ' + gTrip.hit);
    const gEmpty = gateOf('在吗');
    ok('空查询不注入（「在吗」）', gEmpty.hit === 0, '候选 ' + gEmpty.cand + ' / 注入 ' + gEmpty.hit);

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
