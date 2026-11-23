#!/usr/bin/env node
/**
 * _probe/test-user-facts.cjs — 事实有效期回归（2026-11-15 五十九轮）
 *
 * 防的是「两条矛盾事实同时被注入」：换猫名后如果「布丁」和「咪咪」都在索引里，
 * 她只能二选一瞎猜。
 *
 * 分工（实测定的，不要改回去）：
 *   · 纯规则只管「几乎一字不差」（jaccard ≥0.75 / 前缀 ≥70%）
 *   · 其余交给一次小 LLM 裁决（_adjudicateFact）：因为「猫换名」与「两件不相干的偏好」
 *     在字符层面无法区分（前者 jaccard 0.43，后者前缀 6 字）
 *   · 裁决失败/离线 → 保守不压（宁可并存也不误删）
 *
 * 数据隔离（2026-11-21 A2）：写临时记录室（PET_DATA_ROOT + mkdtemp），
 * 不再备份-还原真实 用户事实.json（宿主并发写会偶发 EPERM）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const iso = require('./lib/test-isolation.cjs');

// 必须在 require 之前设置：records-path / user-facts 在模块加载时解析记录室路径。
const tmpRoot = iso.setUpTempDataRoot('pet-facts-');

const UF = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'user-facts.js'));
const P = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'memory-recall', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function mkPlugin(reply) {
    const p = new P();
    p.context = {
        getPluginFileConfig: () => ({}),
        log: () => {},
        addSystemPromptPatch: () => {},
        removeSystemPromptPatch: () => {},
        getMessages: () => [],
        callLLM: async () => reply,
    };
    return p;
}

(async () => {
    const file = UF.file();
    ok('记录室已隔离到临时目录（不写真实数据）', iso.assertIsolated(file), tmpRoot);
    try {
        try { fs.unlinkSync(file); } catch (e) { /* 从空开始最好 */ }

        // ① 纯规则的边界
        ok('一字不差 = 同一件事', UF._shouldSupersede('我家猫叫咪咪', '我家猫叫咪咪') === true);
        // ⚠ 刻意不做的边界：**插入修饰词**（「我家那只猫叫咪咪」）不由纯规则判等价。
        //   想用「子序列包含」去覆盖它会让「我今天去了公司 / 我今天没去公司」也判成同一件事
        //   （插一个「没」就反义了）。所以这一类交给 LLM 裁决，纯规则只管几乎一模一样。
        ok('插入修饰词属于候选（送 LLM），不由纯规则判等价',
            UF._shouldSupersede('我家猫叫咪咪', '我家那只猫叫咪咪') === false
            && UF._shouldConsider('我家猫叫咪咪', '我家那只猫叫咪咪') === true);
        ok('几乎一字不差 = 同一件事（尾部语气词）', UF._shouldSupersede('我家猫叫咪咪', '我家猫叫咪咪啊') === true);
        ok('换名字**不**由纯规则判定（交给 LLM 裁决）', UF._shouldSupersede('我家猫叫咪咪', '我家猫叫布丁') === false);
        ok('但换名字会被判为「候选」（值得送裁决）', UF._shouldConsider('我家猫叫咪咪', '我家猫叫布丁') === true);
        ok('两件不相干的偏好也会判为候选', UF._shouldConsider('我不吃香菜', '我不吃辣') === true);
        ok('完全无关的不送裁决', UF._shouldConsider('我不吃香菜', '我在杭州做后端') === false);

        // ② LLM 裁决 UPDATE → 旧的失效
        const p1 = mkPlugin('UPDATE 1');
        const adj = await p1._adjudicateFact('我家猫叫咪咪');   // 当前没有事实 → 无候选
        ok('没有候选时不调用 LLM', (adj.supersedeIds || []).length === 0 && adj.why === 'no-candidate', adj.why);

        UF.addFact({ text: '我家猫叫布丁', source: 'explicit' });
        const adj2 = await p1._adjudicateFact('我家猫叫咪咪');
        ok('有候选且 LLM 说 UPDATE → 给出要压掉的 id', (adj2.supersedeIds || []).length === 1, adj2.why);
        const r2 = UF.addFact({ text: '我家猫叫咪咪', source: 'explicit', supersedeIds: adj2.supersedeIds });
        ok('新事实写入并压掉旧事实', r2.ok && (r2.superseded || []).length === 1, JSON.stringify(r2.superseded));
        const act = UF.activeFacts();
        ok('有效事实只剩新名字', act.length === 1 && /咪咪/.test(act[0].fact), act.map((f) => f.fact).join(' / '));

        // ③ 历史可查（带有效期标记），默认查询不外露
        const all = UF.load();
        const oldOne = all.find((f) => /布丁/.test(f.fact));
        ok('旧事实没被删（可回滚/可查）', !!oldOne && !!oldOne.valid_to, oldOne ? ('valid_to=' + oldOne.valid_to) : 'missing');
        ok('旧事实记录了 superseded_by', !!oldOne && !!oldOne.superseded_by, oldOne && oldOne.superseded_by);
        const hist = UF.searchFacts('猫', { limit: 5, includeExpired: true });
        ok('include_expired 能查到旧值且标 expired', hist.some((h) => /布丁/.test(h.fact) && h.expired === true));
        const nowOnly = UF.searchFacts('猫', { limit: 5 });
        ok('默认查询不含失效事实', !nowOnly.some((h) => /布丁/.test(h.fact)));

        // ④ LLM 说 ADD → 两件事并存（绝不能误删）
        const p2 = mkPlugin('ADD');
        UF.addFact({ text: '我不吃香菜', source: 'explicit' });
        const adj3 = await p2._adjudicateFact('我不吃辣');
        ok('LLM 说 ADD → 不压任何旧事实', (adj3.supersedeIds || []).length === 0, adj3.why);
        UF.addFact({ text: '我不吃辣', source: 'explicit', supersedeIds: adj3.supersedeIds });
        ok('两件偏好并存（没被误删）', UF.activeFacts().filter((f) => /不吃/.test(f.fact)).length === 2,
            UF.activeFacts().map((f) => f.fact).join(' / '));

        // ⑤ LLM 失败 → 保守并存
        const p3 = mkPlugin(null);
        p3.context.callLLM = async () => { throw new Error('boom'); };
        const adj4 = await p3._adjudicateFact('我家猫叫大黄');
        ok('裁决失败时保守不压（why=llm-error）', (adj4.supersedeIds || []).length === 0 && adj4.why === 'llm-error', adj4.why);

        // ⑥ 索引集成：失效事实不得进注入索引
        const p4 = mkPlugin('ADD');
        await p4.onInit();
        p4._hybrid = false;   // 测试不建向量（否则后台嵌 700+ 条，门禁超时）

        p4._rebuild();
        const factDocs = (p4._docs || []).filter((d) => d.src === '事实');
        ok('索引里有事实条目', factDocs.length >= 2, 'facts=' + factDocs.length);
        ok('索引里只有新事实（旧的不进注入）',
            factDocs.some((d) => /咪咪/.test(d.text)) && !factDocs.some((d) => /布丁/.test(d.text)),
            factDocs.map((d) => d.text).join(' / '));
    } finally {
        // 临时记录室整目录删掉（不再写/还原真实文件）
        iso.cleanup(tmpRoot);
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
