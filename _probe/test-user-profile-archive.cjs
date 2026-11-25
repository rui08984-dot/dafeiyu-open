#!/usr/bin/env node
/**
 * _probe/test-user-profile-archive.cjs —— 用户画像候选池归档 + 停止全量重写（2026-11-24）
 *
 * 背景（审计 §9.3-⑨）：
 *   · 「用户画像_候选.json 4211 行」其实是 pretty-print 行数，真实条目 138 条
 *     （110 promoted + 28 candidate）；但 promoted 一旦晋升就永远留在候选池，只增不减。
 *   · 每次画像分析（_distill）只要有一条观察命中，就会 _saveCandidates() →
 *     _compactCandidateStore() 把所有条目（含 110 条 promoted 的 evidence）整份重新序列化写盘。
 *
 * 本测验收：
 *   ① 老 promoted（> archive_after_days）→ archived，且只留最小字段；
 *   ② 近期 promoted 原样保留（text/count/evidence 不丢）；
 *   ③ archived 受 archive_max 限制，超了丢最旧；
 *   ④ 幂等：反复调用不会重复归档 / 重复写盘；
 *   ⑤ 无实质变化时不写盘（画像变更不连带重写候选池；同日重复观察不重复追加证据）。
 *
 * 全部离线：temp dir + 固定 now（实例上覆盖 _today），不碰真实 data。
 * 判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

// ⚠ 顺序：先隔离数据根，再 require 业务模块（插件内 json-store/records-path 在加载时定路径）
const TMP = iso.setUpTempDataRoot('pet-profile-archive-');
const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const Plugin = require(path.join(LIVE, 'plugins', 'community', 'user-profile', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const NOW = '2026-11-24';

function mk(cfg = {}, store = {}) {
    const dir = fs.mkdtempSync(path.join(TMP, 'case-'));
    const p = new Plugin();
    p._cfg = Object.assign({ archive_after_days: 30, archive_max: 500 }, cfg);
    p._profilePath = path.join(dir, '用户画像.json');
    p._candidatePath = path.join(dir, '用户画像_候选.json');
    iso.assertIsolated(p._candidatePath);
    const logs = [];
    p.context = {
        log: (lv, m) => logs.push(lv + ':' + m),
        getPluginFileConfig: () => p._cfg,
        getMessages: () => [],
        callLLM: async () => '{}',
        on: () => {},
        off: () => {},
    };
    p._profile = p._normalizeProfile({ traits: ['说话直接'], facts: ['住在城西'] });
    p._candidateStore = p._normalizeCandidates(Object.assign({ candidates: [], archived: [] }, store));
    p._today = () => NOW;          // 固定 now：归档天数计算完全确定
    p._renderedProfile = '';
    return { p, dir, logs };
}

function promoted(over = {}) {
    return Object.assign({
        id: 'fact:old000000001',
        category: 'fact',
        text: '早上七点半起床',
        count: 4,
        first_seen: '2026-08-01',
        last_seen: '2026-09-01',
        last_counted_day: '2026-09-01',
        self_declared: false,
        status: 'promoted',
        evidence: [{ date: '2026-08-01', text: '用户说自己七点半起床' }, { date: '2026-09-01', text: 'again' }],
        promoted_at: '2026-08-15',
        one_off: false,
    }, over);
}

function readStore(p) {
    return JSON.parse(fs.readFileSync(p._candidatePath, 'utf8'));
}

function bytes(p) {
    return fs.readFileSync(p._candidatePath, 'utf8');
}

(async () => {
    // ── ① 老 promoted → archived；近期 promoted 保留 ──────────────────────
    {
        const oldOne = promoted();
        const freshOne = promoted({
            id: 'habit:fresh0000001', category: 'habit', text: '睡前要喝一口水',
            first_seen: '2026-11-01', last_seen: '2026-11-20', promoted_at: '2026-09-01',
            evidence: [{ date: '2026-11-20', text: '又提到睡前喝水' }],
        });
        const { p } = mk({}, { candidates: [oldOne, freshOne] });

        const changed = p._decayCandidates();
        ok('归档发生（_decayCandidates 返回 true）', changed === true);
        const saved = readStore(p);
        const ids = saved.candidates.map((c) => c.id);
        ok('老 promoted 已移出候选池', !ids.includes(oldOne.id), ids.join(','));
        ok('近期 promoted 仍在候选池', ids.includes(freshOne.id), ids.join(','));
        const arch = (saved.archived || []).find((a) => a.id === oldOne.id);
        ok('老 promoted 进了 archived', Boolean(arch), JSON.stringify(arch || null));
        ok('archived 只留最小字段（无 evidence/count/first_seen）',
            arch && arch.text === oldOne.text && arch.category === 'fact'
            && arch.status === 'archived' && arch.promoted_at === oldOne.promoted_at
            && arch.last_seen === oldOne.last_seen
            && !('evidence' in arch) && !('count' in arch) && !('first_seen' in arch),
            JSON.stringify(arch || null));
        const kept = saved.candidates.find((c) => c.id === freshOne.id);
        ok('近期 promoted 内容不丢（count/evidence 原样）',
            kept && kept.status === 'promoted' && kept.count === freshOne.count
            && JSON.stringify(kept.evidence) === JSON.stringify(freshOne.evidence),
            JSON.stringify(kept || null));

        // ── ④ 幂等 ────────────────────────────────────────────────────────
        const before = bytes(p);
        const again = p._decayCandidates();
        ok('幂等：第二次调用无改动、不写盘', again === false && bytes(p) === before,
            'changed=' + again);
        const saved2 = readStore(p);
        ok('幂等：archived 不重复', (saved2.archived || []).filter((a) => a.id === oldOne.id).length === 1,
            'archived=' + (saved2.archived || []).length);
        ok('原子写：目录里没有残留 tmp 文件',
            fs.readdirSync(path.dirname(p._candidatePath)).every((f) => !/\.tmp-/.test(f)),
            fs.readdirSync(path.dirname(p._candidatePath)).join(','));
    }

    // ── ② archived 上限 archive_max，超了丢最旧 ──────────────────────────
    {
        const archivedOld = [
            { id: 'a:1', category: 'fact', text: '最旧的归档', status: 'archived', promoted_at: '2025-01-01', last_seen: '2025-01-01' },
            { id: 'a:2', category: 'fact', text: '第二旧', status: 'archived', promoted_at: '2025-06-01', last_seen: '2025-06-01' },
            { id: 'a:3', category: 'fact', text: '第三旧', status: 'archived', promoted_at: '2025-09-01', last_seen: '2025-09-01' },
        ];
        const { p } = mk({ archive_max: 3 }, { candidates: [promoted()], archived: archivedOld });
        p._decayCandidates();
        const saved = readStore(p);
        ok('archived 数量不超过 archive_max=3', (saved.archived || []).length === 3,
            'archived=' + (saved.archived || []).length);
        ok('超限时丢最旧（保留新鲜条目）',
            !(saved.archived || []).some((a) => a.id === 'a:1')
            && (saved.archived || []).some((a) => a.id === 'a:2')
            && (saved.archived || []).some((a) => a.id === 'fact:old000000001'),
            (saved.archived || []).map((a) => a.id).join(','));
        ok('新的归档排在最前（按 last_seen 新鲜度）',
            saved.archived[0].id === 'fact:old000000001', saved.archived[0].id);
    }

    // ── ③ 未到期的不归档（边界：正好 30 天保留，31 天才归档）────────────
    {
        const exactly30 = promoted({ id: 'fact:edge30', last_seen: '2026-10-25', promoted_at: '2026-08-01' }); // 30 天
        const day31 = promoted({ id: 'fact:edge31', last_seen: '2026-10-24', promoted_at: '2026-08-01' });    // 31 天
        const { p } = mk({}, { candidates: [exactly30, day31] });
        p._decayCandidates();
        const saved = readStore(p);
        const keptIds = saved.candidates.map((c) => c.id);
        ok('边界：正好 30 天不归档', keptIds.includes('fact:edge30'), keptIds.join(','));
        ok('边界：31 天归档', !keptIds.includes('fact:edge31'), keptIds.join(','));
    }

    // ── ⑤ 停止全量重写：无实质变化不标脏 ────────────────────────────────
    {
        const profItem = '住在城西';
        const { p } = mk({}, { candidates: [promoted({
            id: 'habit:live1', category: 'habit', text: '睡前要喝一口水',
            last_seen: NOW, last_counted_day: NOW, promoted_at: '2026-09-01',
            evidence: [{ date: NOW, text: '睡前喝水' }],
        })] });
        // 观察命中已有画像项 → 只算画像变更，不碰候选池
        const r1 = await p._updateCandidatePool([{ category: 'fact', text: profItem, evidence: '用户说自己住在城西' }]);
        ok('命中已有画像项：只标画像，不标候选池', r1.profileChanged === true && r1.changed === false,
            JSON.stringify({ changed: r1.changed, profileChanged: r1.profileChanged }));

        // 已晋升条目 + 同日完全相同的观察 → 不算变更（不追加重复 evidence）
        const c = p._candidateStore.candidates[0];
        const evBefore = JSON.stringify(c.evidence);
        const r2 = await p._updateCandidatePool([{ category: 'habit', text: '睡前要喝一口水', evidence: '睡前喝水' }]);
        ok('已晋升条目同日同证据：不标脏、不重复追加', r2.changed === false
            && JSON.stringify(c.evidence) === evBefore, JSON.stringify({ changed: r2.changed, ev: c.evidence }));

        // 新证据 → 才算变更，并刷新 last_seen
        const r3 = await p._updateCandidatePool([{ category: 'habit', text: '睡前要喝一口水', evidence: '今晚又提了一次睡前喝水' }]);
        ok('新证据：标脏并追加证据', r3.changed === true && c.evidence.length === 2,
            JSON.stringify({ changed: r3.changed, ev: c.evidence.length }));

        // 新观察（池里没有）→ 照常新增（回归：别把真实观察静默丢掉）
        const r4 = await p._updateCandidatePool([{ category: 'like', text: '喜欢喝无糖乌龙茶', evidence: '用户说在喝乌龙茶' }]);
        const added = p._candidateStore.candidates.find((x) => x.text === '喜欢喝无糖乌龙茶');
        ok('新观察照常进候选池', r4.changed === true && Boolean(added) && added.status === 'candidate',
            JSON.stringify(added || null));
    }

    // ── ⑥ 老文件兼容 + 配置覆盖 ──────────────────────────────────────────
    {
        const { p } = mk({ archive_after_days: 7 }, {
            candidates: [promoted({ last_seen: '2026-11-01', promoted_at: '2026-10-01' })],  // 23 天前
        });
        p._decayCandidates();
        ok('archive_after_days 可配置（7 天 → 23 天前已归档）',
            readStore(p).candidates.length === 0, 'candidates=' + readStore(p).candidates.length);

        const legacy = mk({}, {
            candidates: [{ id: 'x:1', category: 'fact', text: '老条目没有 one_off 字段', count: 2, status: 'candidate', first_seen: '2026-11-01', last_seen: '2026-11-20' }],
        });
        ok('老候选条目（无 one_off/archived 字段）能正常加载',
            legacy.p._candidateStore.candidates.length === 1
            && legacy.p._candidateStore.candidates[0].one_off === false
            && Array.isArray(legacy.p._candidateStore.archived),
            JSON.stringify(legacy.p._candidateStore.candidates[0]));

        const withOneOff = mk({}, { candidates: [promoted({ one_off: true, last_seen: '2026-11-20' })] });
        ok('one_off 标签加载后不丢（原来 normalize 会丢掉）',
            withOneOff.p._candidateStore.candidates[0].one_off === true,
            String(withOneOff.p._candidateStore.candidates[0].one_off));
    }

    // ── ⑦ 归档不等于遗忘：archived 必须参与去重（否则重复晋升）────────────
    {
        const archivedFact = {
            id: 'fact:coffee00001', category: 'fact', text: '对咖啡机蒸汽过敏',
            status: 'archived', promoted_at: '2026-06-01', last_seen: '2026-09-01',
            archived_at: '2026-11-01', archived_reason: 'promoted_stale',
        };
        const { p } = mk({}, { candidates: [], archived: [archivedFact] });
        // 画像本体里已经没有这条（比如被 profile_stale 降级过）→ 会走到候选池逻辑
        const r1 = await p._updateCandidatePool([
            { category: 'fact', text: '对咖啡机蒸汽过敏', evidence: '又说了一次咖啡机蒸汽过敏' },
        ]);
        const sameText = p._candidateStore.candidates.filter((c) => c.text === '对咖啡机蒸汽过敏');
        ok('archived 里的文本再次出现：复活旧条目，不新建同名候选',
            r1.changed === true && sameText.length === 1 && sameText[0].id === archivedFact.id,
            JSON.stringify(sameText.map((c) => c.id)));
        ok('复活后从 archived 移出（不会两边各留一份）',
            !(p._candidateStore.archived || []).some((a) => a.id === archivedFact.id),
            'archived=' + (p._candidateStore.archived || []).length);
        ok('复活保留原 id 与 promoted_at（证据链不丢）',
            sameText.length === 1 && sameText[0].promoted_at === archivedFact.promoted_at,
            sameText.length ? String(sameText[0].promoted_at) : '(none)');

        // 再观察一次：仍然只有一条候选（去重仍然生效）
        await p._updateCandidatePool([{ category: 'fact', text: '对咖啡机蒸汽过敏', evidence: '第三次提到' }]);
        ok('复活后重复观察不产生第二条同名候选',
            p._candidateStore.candidates.filter((c) => c.text === '对咖啡机蒸汽过敏').length === 1,
            p._candidateStore.candidates.filter((c) => c.text === '对咖啡机蒸汽过敏').length + ' 条');

        // 画像本体里仍有的情况：走「命中已有画像项」分支，既不新建候选也不动 archived
        const { p: p2 } = mk({}, { candidates: [], archived: [archivedFact] });
        p2._profile = p2._normalizeProfile({ facts: ['对咖啡机蒸汽过敏'] });
        const r2 = await p2._updateCandidatePool([{ category: 'fact', text: '对咖啡机蒸汽过敏', evidence: 'x' }]);
        ok('画像里仍有该条时：不新建候选、不动 archived',
            r2.changed === false && r2.profileChanged === true
            && p2._candidateStore.candidates.length === 0
            && (p2._candidateStore.archived || []).length === 1,
            JSON.stringify({ changed: r2.changed, profileChanged: r2.profileChanged }));
    }

    // ── ⑧ 后台闸：配额暂停时不调 LLM、不标记已分析，恢复后补跑 ──────────────
    {
        const { p, logs } = mk({}, {});
        const msgs = [
            { role: 'user', content: '我最近早上都七点起' },
            { role: 'assistant', content: '那你挺自律' },
            { role: 'user', content: '睡前想喝口水' },
            { role: 'assistant', content: '好习惯' },
            { role: 'user', content: '我住城西' },
            { role: 'assistant', content: '记下了' },
        ];
        let llmCalls = 0;
        p.context.getMessages = () => msgs;
        p.context.callLLM = async () => { llmCalls += 1; return '{"observations":[]}'; };

        // 真实 background-llm.canRun + 用户关掉后台 LLM → {ok:false, reason:'disabled'}
        const { canRun } = require(path.join(LIVE, 'js', 'core', 'background-llm.js'));
        ok('background-llm.canRun 契约是 {ok}', typeof canRun({ getConfig: () => ({}) }).ok === 'boolean',
            JSON.stringify(canRun({ getConfig: () => ({}) })));
        p.context.getConfig = () => ({ cost: { background_llm: false } });
        p._dirty = true;
        p._lastProcessedMessageCount = 0;
        await p._distill('gate-blocked');
        ok('配额/开关暂停时：不调 LLM', llmCalls === 0, 'calls=' + llmCalls);
        ok('暂停时不标记已分析（_dirty 保持、游标不前进）',
            p._dirty === true && p._lastProcessedMessageCount === 0,
            JSON.stringify({ dirty: p._dirty, cursor: p._lastProcessedMessageCount }));
        await p._distill('gate-blocked-again');
        ok('暂停只记一次日志（不每轮刷）', logs.filter((l) => l.includes('画像后台分析暂停')).length === 1,
            logs.filter((l) => l.includes('画像后台分析暂停')).length + ' 条');

        // 配额耗尽 reason 直传（真实返回值形状）也必须挡
        p._bgGateReady = true;
        p._bgGate = { canRun: () => ({ ok: false, reason: 'quota_exhausted', retryAt: Date.now() + 60000 }) };
        await p._distill('quota');
        ok('{ok:false, reason:quota_exhausted} → 仍不调 LLM', llmCalls === 0, 'calls=' + llmCalls);

        // 恢复：真实闸 ok:true → 同批消息被补跑并推进游标
        p._bgGate = { canRun: () => ({ ok: true, reason: null, retryAt: null }) };
        await p._distill('recovered');
        ok('恢复后补跑：调一次 LLM 并标记已分析',
            llmCalls === 1 && p._dirty === false && p._lastProcessedMessageCount === msgs.length,
            JSON.stringify({ calls: llmCalls, dirty: p._dirty, cursor: p._lastProcessedMessageCount }));
    }

    iso.cleanup(TMP);
    console.log('\n  用户画像归档：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('测试异常：', e && e.stack || e);
    iso.cleanup(TMP);
    process.exit(2);
});
