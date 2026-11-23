#!/usr/bin/env node
/**
 * _probe/memory-stale-leak.cjs — 记忆「证据分」双时钟 + stale_leak 离线评测（2026-11-22）
 *
 * 盯两件事，全部在临时记录室里跑，不碰真实 用户事实.json：
 *   ① stale_leak：同一 subject 的旧事实被新事实版本化压掉后，activeFacts() 不返回旧值；
 *      再把 activeFacts() 的文本喂给「检索注入」模拟函数，旧文本出现次数必须 = 0。
 *   ② 证据分：confirm/deny/ignore/newFact 的事件语义、tier 分档、protected 不衰减、
 *      双时钟（R 30 天 / D 180 天）在固定 now 下的数值符合公式。
 *
 * 金集说明：_probe 内**没有**现成的 36 题记忆金集 —— test-memory-quality.cjs 按根因列
 * 断言，test-memory-integrity.cjs 按链路列断言，memory-probe.cjs 是从真实记录临时出题
 * （需要生产数据，不适合当离线金集）。所以本测试自带 STALE_CASES 8 条，全部在临时目录
 * 里构造，不读生产数据。若以后出现 36 题金集，应改成复用其 subject/old/new 三列。
 *
 * 数据隔离：lib/test-isolation.cjs 在 require 业务模块**之前**设 PET_DATA_ROOT。
 *
 * 判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

// 顺序关键：先隔离，再 require（records-path 在模块加载时解析路径）
const tmpRoot = iso.setUpTempDataRoot('pet-mem-stale-');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const ME = require(path.join(APP, 'js', 'core', 'memory-evidence.js'));
const UF = require(path.join(APP, 'js', 'core', 'user-facts.js'));

const DAY = ME.DAY_MS;

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
function near(a, b, eps) { return Math.abs(Number(a) - Number(b)) <= (eps || 1e-9); }

/** 检索注入模拟：只取 activeFacts 的文本，模拟「把事实拼进提示词」 */
function simulateInjection(facts) {
    return (facts || []).map((f) => String((f && f.fact) || '')).join('\n');
}
function countOccurrences(hay, needle) {
    const h = String(hay || '');
    const n = String(needle || '');
    if (!h || !n) return 0;
    let count = 0;
    let i = 0;
    while ((i = h.indexOf(n, i)) !== -1) { count += 1; i += n.length; }
    return count;
}

/** 同一 subject 的「旧值 → 新值」用例（自带 8 条；见文件头金集说明） */
const STALE_CASES = [
    ['我家猫叫布丁', '我家猫叫咪咪'],
    ['我在杭州做后端', '我搬到上海了，在做前端'],
    ['我每天早上跑步', '我改成晚上游泳了'],
    ['我的手机是小米14', '我换了 iPhone 16'],
    ['我住在城西', '我搬到城东了'],
    ['我最喜欢的歌手是周杰伦', '我最喜欢的歌手换成陈奕迅了'],
    ['我养了一只金毛', '我的金毛送人了，现在养猫'],
    ['我在准备考研', '我不考研了，准备找工作'],
];

function resetFactsFile() {
    try { fs.unlinkSync(UF.file()); } catch (e) { /* 从空开始最好 */ }
    try { fs.unlinkSync(UF.file() + '.tmp'); } catch (e) { /* 无 tmp 是正常情况 */ }
}

function readRaw() {
    return JSON.parse(fs.readFileSync(UF.file(), 'utf8'));
}
function writeRaw(obj) {
    fs.writeFileSync(UF.file(), JSON.stringify(obj, null, 2), 'utf8');
}

(async () => {
    const file = UF.file();
    ok('记录室已隔离到临时目录（不写真实数据）', iso.assertIsolated(file), tmpRoot);
    console.log('说明：_probe 内未找到现成 36 题金集（memory-quality/integrity 均非题库），'
        + '本测试自带 ' + STALE_CASES.length + ' 条 stale_leak 用例。');

    try {
        // ───────────────────────────────────────────────────────────────
        // A. 纯模块：半衰与双时钟
        // ───────────────────────────────────────────────────────────────
        console.log('\n[A] memory-evidence 纯函数');
        ok('halfLife(1, 30, 30) = 0.5', near(ME.halfLife(1, 30, 30), 0.5));
        ok('halfLife(1, 60, 30) = 0.25', near(ME.halfLife(1, 60, 30), 0.25));
        ok('halfLife(1, 180, 180) = 0.5', near(ME.halfLife(1, 180, 180), 0.5));
        ok('halfLife 负 age 当 0', near(ME.halfLife(1, -5, 30), 1));
        ok('halfLife 非法 value 归 0', ME.halfLife(NaN, 10, 30) === 0 && ME.halfLife(undefined, 10, 30) === 0);
        ok('halfLife 非法/非正半衰期归 0', ME.halfLife(1, 10, 0) === 0 && ME.halfLife(1, 10, -3) === 0);
        ok('halfLife 非法 age 当 0', near(ME.halfLife(2, NaN, 30), 2));

        const T = 1700000000000;   // 固定 now（epoch ms）
        ok('R 时钟 30 天 → 0.5', near(ME.score({ r: 1, rAt: T - 30 * DAY, d: 0, dAt: 0 }, T), 0.5));
        ok('R 时钟 60 天 → 0.25', near(ME.score({ r: 1, rAt: T - 60 * DAY, d: 0, dAt: 0 }, T), 0.25));
        ok('D 时钟 180 天 → -0.5', near(ME.score({ r: 0, rAt: 0, d: 1, dAt: T - 180 * DAY }, T), -0.5));
        ok('双时钟同时老化：30 天 R 与 180 天 D 抵消为 0',
            near(ME.score({ r: 1, rAt: T - 30 * DAY, d: 1, dAt: T - 180 * DAY }, T), 0));
        ok('rAt=0 当刚写入（不是无限老）', near(ME.score({ r: 1, rAt: 0, d: 0, dAt: 0 }, T), 1));
        ok('未来 rAt 当刚写入', near(ME.score({ r: 1, rAt: T + 5 * DAY, d: 0, dAt: 0 }, T), 1));
        ok('「天」单位时间戳同样成立（now=130 / rAt=100）',
            near(ME.score({ r: 1, rAt: 100, d: 0, dAt: 0 }, 130), 0.5));
        ok('protected=true → Infinity', ME.score({ r: 0, rAt: 0, d: 9, dAt: 0, protected: true }, T) === Infinity);
        ok('非法 r/d 归 0', near(ME.score({ r: NaN, rAt: 0, d: undefined, dAt: 0 }, T), 0));

        // 事件语义 + 不可变
        const before = { r: 0.5, rAt: 1, d: 0, dAt: 0, protected: false };
        const afterConfirm = ME.applyEvent(before, { type: 'confirm', at: 2 });
        ok('applyEvent 不原地改', before.r === 0.5 && before.rAt === 1 && before.d === 0);
        ok('applyEvent 返回新对象', afterConfirm !== before);
        ok('confirm → r+1, rAt=at', afterConfirm.r === 1.5 && afterConfirm.rAt === 2 && afterConfirm.d === 0);
        const afterDeny = ME.applyEvent(before, { type: 'deny', at: 3 });
        ok('deny → d+1, dAt=at', afterDeny.d === 1 && afterDeny.dAt === 3 && afterDeny.r === 0.5);
        const afterIgnore = ME.applyEvent(before, { type: 'ignore', at: 4 });
        ok('ignore → r-0.2, rAt=at', near(afterIgnore.r, 0.3) && afterIgnore.rAt === 4);
        const floor = ME.applyEvent({ r: 0.1, rAt: 1, d: 0, dAt: 0 }, { type: 'ignore', at: 5 });
        ok('ignore 不把 r 扣成负数', floor.r === 0);
        const afterNew = ME.applyEvent(before, { type: 'newFact', at: 6 });
        ok('newFact → r+0.5, rAt=at', afterNew.r === 1 && afterNew.rAt === 6);
        const unknown = ME.applyEvent(before, { type: 'whatever', at: 7 });
        ok('未知 type 内容原样返回（仍是新对象）', unknown.r === 0.5 && unknown.rAt === 1 && unknown !== before);

        // tier 边界
        ok('tier 边界：2 → promote', ME.tier(2) === 'promote');
        ok('tier 边界：1.999 → confirmed', ME.tier(1.999) === 'confirmed');
        ok('tier 边界：1 → confirmed', ME.tier(1) === 'confirmed');
        ok('tier 边界：0.999 → neutral', ME.tier(0.999) === 'neutral');
        ok('tier 边界：-1.999 → neutral', ME.tier(-1.999) === 'neutral');
        ok('tier 边界：-2 → archive_candidate', ME.tier(-2) === 'archive_candidate');
        ok('tier：Infinity → promote', ME.tier(Infinity) === 'promote');
        ok('tier：NaN → neutral', ME.tier(NaN) === 'neutral');

        // ───────────────────────────────────────────────────────────────
        // B. user-facts 接线（可选字段 / noteEvidence / evidenceScore）
        // ───────────────────────────────────────────────────────────────
        console.log('\n[B] user-facts 证据分接线');
        resetFactsFile();
        const NOW = Date.now();

        const r0 = UF.addFact({ text: '我每天早上七点起床', source: 'explicit', now: NOW });
        ok('新事实写入成功', r0.ok === true && !!r0.id);
        const raw0 = readRaw();
        const stored0 = raw0.facts.find((f) => f.id === r0.id);
        ok('新事实附 evidence 可选字段',
            stored0 && stored0.evidence && stored0.evidence.r === 0.5
            && stored0.evidence.rAt === NOW && stored0.evidence.d === 0
            && stored0.evidence.protected === false,
            JSON.stringify(stored0 && stored0.evidence));
        ok('版本化结构不变 { version:1, facts:[...] }',
            raw0.version === 1 && Array.isArray(raw0.facts));
        ok('原有字段齐全（id/fact/valid_from/valid_to/source/confidence）',
            ['id', 'fact', 'valid_from', 'valid_to', 'source', 'confidence'].every((k) => k in stored0));

        const e0 = UF.evidenceOf(stored0);
        ok('evidenceOf 返回规范化证据', e0.r === 0.5 && e0.rAt === NOW && e0.d === 0 && e0.protected === false);
        const eLegacy = UF.evidenceOf({ fact: '旧数据没有 evidence', valid_from: NOW - 9 * DAY });
        ok('evidenceOf 旧数据：r=0.5 且 rAt 取 valid_from',
            eLegacy.r === 0.5 && eLegacy.rAt === NOW - 9 * DAY && eLegacy.d === 0);

        const c1 = UF.noteEvidence(r0.id, 'confirm', { now: NOW });
        ok('按 id confirm → ok, r=1.5, tier=confirmed',
            c1.ok === true && c1.evidence.r === 1.5 && c1.tier === 'confirmed', JSON.stringify({ r: c1.evidence.r, tier: c1.tier }));
        const c2 = UF.noteEvidence('我每天早上七点起床', 'confirm', { now: NOW });
        ok('按 fact 文本精确匹配 confirm → r=2.5, tier=promote',
            c2.ok === true && c2.evidence.r === 2.5 && c2.tier === 'promote', JSON.stringify({ r: c2.evidence.r, tier: c2.tier }));
        const persisted = readRaw().facts.find((f) => f.id === r0.id);
        ok('事件已原子写回磁盘', persisted.evidence.r === 2.5 && persisted.evidence.rAt === NOW);

        const viaObj = UF.noteEvidence({ id: r0.id, fact: '我每天早上七点起床' }, 'newFact', { now: NOW + 1 });
        ok('传事实对象也按 id 命中', viaObj.ok === true && viaObj.evidence.r === 3 && viaObj.evidence.rAt === NOW + 1);

        const missing = UF.noteEvidence('这条事实不存在', 'confirm', { now: NOW });
        ok('找不到 → { ok:false, reason:"not_found" }',
            missing.ok === false && missing.reason === 'not_found');
        ok('not_found 不新建事实', readRaw().facts.length === 1);

        // ignore 扣到 0，不越界、不误判 archive
        const ig = UF.addFact({ text: '我很少喝咖啡', source: 'explicit', now: NOW });
        for (let i = 0; i < 5; i += 1) UF.noteEvidence(ig.id, 'ignore', { now: NOW + i });
        const igRaw = readRaw().facts.find((f) => f.id === ig.id);
        const igScore = ME.score(UF.evidenceOf(igRaw), NOW);
        ok('ignore ×5 → r 扣到 0（不越界）', igRaw.evidence.r === 0, 'r=' + igRaw.evidence.r);
        ok('ignore ×5 不误判 archive', ME.tier(igScore) !== 'archive_candidate', 'score=' + igScore);

        // deny 累积到 archive_candidate
        const dn = UF.addFact({ text: '我讨厌下雨天', source: 'explicit', now: NOW });
        for (let i = 0; i < 3; i += 1) UF.noteEvidence(dn.id, 'deny', { now: NOW });
        const dnRaw = readRaw().facts.find((f) => f.id === dn.id);
        const dnScore = ME.score(UF.evidenceOf(dnRaw), NOW);
        ok('deny ×3 → 分数 ≤ -2 且 tier=archive_candidate',
            dnScore <= -2 && ME.tier(dnScore) === 'archive_candidate', 'score=' + dnScore);

        // activeFacts 追加 evidenceScore，原字段不丢
        const activeB = UF.activeFacts();
        ok('activeFacts 仍只返回有效事实', activeB.every((f) => !f.valid_to));
        ok('activeFacts 原有字段不变',
            activeB.every((f) => typeof f.id === 'string' && typeof f.fact === 'string'
                && 'valid_from' in f && 'valid_to' in f && typeof f.source === 'string'));
        ok('activeFacts 追加只读 evidenceScore',
            activeB.every((f) => typeof f.evidenceScore === 'number'),
            activeB.map((f) => f.evidenceScore.toFixed(3)).join(','));
        const one = activeB.find((f) => f.id === r0.id);
        const expected = ME.score(UF.evidenceOf(readRaw().facts.find((f) => f.id === r0.id)), Date.now());
        ok('evidenceScore 与纯函数重算一致', near(one.evidenceScore, expected, 1e-6),
            one.evidenceScore + ' vs ' + expected);

        // protected（人格卡）不吃衰减
        const pr = UF.addFact({ text: '人格卡：我是飞鱼', source: 'persona', now: NOW });
        const prRaw = readRaw();
        prRaw.facts.find((f) => f.id === pr.id).evidence = { r: 0, rAt: 0, d: 99, dAt: NOW, protected: true };
        writeRaw(prRaw);
        const protectedAct = UF.activeFacts().find((f) => f.id === pr.id);
        ok('protected 事实 evidenceScore = Infinity', protectedAct.evidenceScore === Infinity);

        // 旧数据（无 evidence）也能算分
        resetFactsFile();
        writeRaw({
            version: 1,
            updated_at: NOW,
            facts: [{
                id: 'legacy1', fact: '我住在老城区', valid_from: NOW - 10 * DAY,
                valid_to: null, source: 'manual', confidence: 0.8,
            }],
        });
        const legacyAct = UF.activeFacts();
        ok('旧数据无 evidence 也能算分（不崩）',
            legacyAct.length === 1 && Number.isFinite(legacyAct[0].evidenceScore));
        ok('旧数据按 valid_from 正常衰老（10 天 ≈ 0.397）',
            near(legacyAct[0].evidenceScore, 0.5 * Math.pow(0.5, 10 / 30), 1e-3),
            'score=' + legacyAct[0].evidenceScore);

        // ───────────────────────────────────────────────────────────────
        // C. stale_leak：版本化压掉旧事实后，注入里旧文本 = 0
        // ───────────────────────────────────────────────────────────────
        console.log('\n[C] stale_leak（' + STALE_CASES.length + ' 条自带用例）');
        resetFactsFile();
        const BASE = Date.now();

        for (let i = 0; i < STALE_CASES.length; i += 1) {
            const [oldText, newText] = STALE_CASES[i];
            const oldR = UF.addFact({ text: oldText, source: 'explicit', now: BASE + i * 2000 });
            const newR = UF.addFact({
                text: newText, source: 'explicit',
                supersedeIds: [oldR.id], now: BASE + i * 2000 + 1000,
            });
            ok('版本化：旧值已压掉 [' + (i + 1) + '] ' + oldText,
                oldR.ok && newR.ok && (newR.superseded || []).includes(oldR.id),
                JSON.stringify(newR.superseded || []));
        }

        const activeC = UF.activeFacts();
        const injected = simulateInjection(activeC);
        let leaked = 0;
        for (const [oldText, newText] of STALE_CASES) {
            const oldCount = countOccurrences(injected, oldText);
            const newCount = countOccurrences(injected, newText);
            leaked += oldCount;
            ok('注入不含旧值：' + oldText, oldCount === 0, 'count=' + oldCount);
            ok('注入含新值：' + newText, newCount === 1, 'count=' + newCount);
            ok('activeFacts 不返回旧值：' + oldText,
                !activeC.some((f) => String(f.fact).trim() === oldText));
        }
        ok('stale_leak 总泄漏 = 0', leaked === 0, 'leaked=' + leaked + ' / cases=' + STALE_CASES.length);

        // 多代替换：A → B → C，A/B 都不得泄漏
        const g1 = UF.addFact({ text: '我的游戏ID是阿尔法', source: 'explicit', now: BASE + 90000 });
        const g2 = UF.addFact({
            text: '我的游戏ID是贝塔', source: 'explicit',
            supersedeIds: [g1.id], now: BASE + 91000,
        });
        const g3 = UF.addFact({
            text: '我的游戏ID是伽马', source: 'explicit',
            supersedeIds: [g2.id], now: BASE + 92000,
        });
        const injected2 = simulateInjection(UF.activeFacts());
        ok('多代替换：两代旧值都不泄漏',
            g3.ok && countOccurrences(injected2, '阿尔法') === 0 && countOccurrences(injected2, '贝塔') === 0,
            'alpha=' + countOccurrences(injected2, '阿尔法') + ' beta=' + countOccurrences(injected2, '贝塔'));
        ok('多代替换：最新值恰好出现一次', countOccurrences(injected2, '伽马') === 1);

        // 旧事实不删除，历史可查；默认检索不外露
        const hist = UF.searchFacts('游戏ID', { limit: 10, includeExpired: true });
        ok('旧值仍在历史里且标 expired',
            hist.some((h) => /阿尔法/.test(h.fact) && h.expired === true));
        const nowOnly = UF.searchFacts('游戏ID', { limit: 10 });
        ok('默认检索不含旧值', !nowOnly.some((h) => /阿尔法|贝塔/.test(h.fact)));

        // 新事实自带 evidence（stale 用例写入路径也覆盖）
        const newOne = readRaw().facts.find((f) => f.id === g3.id);
        ok('stale 用例里的新事实也带 evidence 初始字段',
            newOne.evidence && newOne.evidence.r === 0.5 && newOne.evidence.rAt === BASE + 92000);
    } finally {
        iso.cleanup(tmpRoot);
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + ((e && e.stack) || e));
    try { iso.cleanup(tmpRoot); } catch (e2) { /* 忽略清理异常 */ }
    process.exit(1);
});
