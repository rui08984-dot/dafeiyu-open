#!/usr/bin/env node
/**
 * _probe/test-memory-queue-facts.cjs —— 记忆链修复回归（2026-11-25）
 *
 * 覆盖 docs/research/记忆链-功能审计-2026-11-25.md 的三条 P0 + 两条顺手项：
 *   ① P0-1 待写队列 attempts 上限 / 死信落盘 / 满 3 次不再重投 / 失败一行日志
 *   ② P0-1 `ok:true + added=0` 不算写成功（计入 attempts，不写整理日志/图谱抽取）
 *   ③ P0-2 队列读失败 → 三态 ok:false，两个写回点都不覆盖文件；原子写不残留 .tmp
 *   ④ P0-3 事实 kind（trait/preference/event）+ event 的 valid_to + recall facts 过滤
 *   ⑤ P0-3 迁移脚本幂等（只加字段、不改文本）
 *   ⑥ 补充：/add 超时按后端区分（本地 40s / 云端 150s），超时日志带 backend:'local'
 *
 * 数据隔离：PET_DATA_ROOT 临时目录（records-path 在加载时解析路径，必须先设）。
 * 判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const iso = require('./lib/test-isolation.cjs');

// ⚠ 顺序：先隔离数据根，再 require 业务模块。
const TMP = iso.setUpTempDataRoot('pet-queue-facts-');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const P = require(path.join(LIVE, 'plugins', 'community', 'memory-evolve', 'index.js'));
const R = require(path.join(LIVE, 'plugins', 'community', 'memory-recall', 'index.js'));
const UF = require(path.join(LIVE, 'js', 'core', 'user-facts.js'));
const MU = require(path.join(LIVE, 'js', 'core', 'memory-usage.js'));
const { recordFile } = require(path.join(LIVE, 'js', 'core', 'records-path.js'));
const MIG = require(path.join(__dirname, 'migrate-user-facts-kind-20261125.cjs'));

const DAY = 24 * 60 * 60 * 1000;
let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
const readJsonl = (p) => {
    try {
        return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch (e) { return []; }
};

function mkCtx() {
    const logs = [];
    return {
        logs,
        getPluginFileConfig: () => ({ enabled: true, gate_threshold: 0.6, dedupe_threshold: 1 }),
        getConfig: () => ({}),
        getMessages: () => [],
        log: (lv, m) => { logs.push(String(m)); },
        addSystemPromptPatch: () => {},
        removeSystemPromptPatch: () => {},
    };
}

async function mkEvolve() {
    const p = new P();
    p.context = mkCtx();
    await p.onInit();
    if (p._bootQueueTimer) clearTimeout(p._bootQueueTimer);   // 别让 8s 补写定时器在用例中途插一脚
    p._writeGateOpen = async () => true;
    p._memosReachable = async () => true;
    return p;
}

(async () => {
    const qPath = recordFile('记忆待写队列.jsonl');
    const deadPath = path.join(path.dirname(qPath), '记忆待写死信.jsonl');
    ok('记录室已隔离到临时目录（不写真实数据）', iso.assertIsolated(qPath) && iso.assertIsolated(deadPath), TMP);

    // ── ① P0-1：attempts 上限 / 死信 / 不再重投 ─────────────────────────────
    console.log('[1] P0-1 待写队列 attempts 上限 + 死信');
    {
        const p = await mkEvolve();
        p._queueWrite([]);
        try { fs.unlinkSync(deadPath); } catch (e) { /* 首次不存在 */ }
        p._queueWrite([{ text: '快骂我你骂我是杂鱼不学一学平那一点', score: 0.97, at: Date.now() }]);

        let calls = 0;
        let lastBody = null;
        p._post = async (route, body) => {
            calls += 1;
            lastBody = body;
            return { status: 'failed', ok: false, added: 0, merged: 0, error: 'LLM 未提取到可写入的记忆（added=0）' };
        };

        await p._drainQueue();
        let q = p._queueLoad();
        ok('第 1 次失败：条目保留且 attempts=1', q.length === 1 && q[0].attempts === 1, JSON.stringify(q));
        ok('失败原因落盘（lastReason）', !!q[0] && /未提取到/.test(q[0].lastReason || ''), q[0] && q[0].lastReason);
        ok('每次失败只打一行 attempts 日志', p.context.logs.filter((l) => /待写失败 attempts=1\/3/.test(l)).length === 1,
            p.context.logs.filter((l) => /待写失败/.test(l)).join(' | '));
        ok('日志带稳定 key', p.context.logs.some((l) => /key=[a-z0-9]+:快骂我你骂我/.test(l)),
            p.context.logs.filter((l) => /待写失败/.test(l))[0] || '(none)');
        ok('首次重放不关实体提取（老后端口径不变）', !('extract_entities' in (lastBody || {})));

        await p._drainQueue();
        q = p._queueLoad();
        ok('第 2 次失败：attempts=2', q.length === 1 && q[0].attempts === 2, JSON.stringify(q));
        ok('第 2 次起关掉实体提取（0 条不再反复写图谱）', lastBody && lastBody.extract_entities === false,
            JSON.stringify(lastBody && lastBody.extract_entities));

        await p._drainQueue();
        ok('满 3 次从主队列移除', p._queueLoad().length === 0, '剩 ' + p._queueLoad().length + ' 条');
        const dead = readJsonl(deadPath);
        ok('死信落盘 1 条', dead.length === 1, 'dead=' + dead.length);
        ok('死信与原条目同结构（text/score/at/attempts）',
            dead[0] && dead[0].text === '快骂我你骂我是杂鱼不学一学平那一点' && dead[0].attempts === 3 && !!dead[0].at,
            JSON.stringify(dead[0] || null));
        ok('死信带 deadReason', dead[0] && /未提取到/.test(dead[0].deadReason || ''), dead[0] && dead[0].deadReason);
        ok('死信日志只喊一次', p.context.logs.filter((l) => /移入死信 1 条/.test(l)).length === 1);
        const callsBefore = calls;
        await p._drainQueue();
        ok('死信后不再调用 /add（不会无限重投）', calls === callsBefore, 'calls=' + calls);
    }

    // ── ② 死信文件上限 200 行（超出丢最旧）─────────────────────────────────
    console.log('[2] 死信上限 200 行');
    {
        const p = await mkEvolve();
        const dir = path.join(TMP, 'dlq');
        fs.mkdirSync(dir, { recursive: true });
        p._queuePath = path.join(dir, 'q.jsonl');
        const dp = p._deadLetterPath();
        for (let i = 0; i < 205; i += 1) p._appendDeadLetter({ text: '死信样本' + i, attempts: 3, deadReason: 'x' });
        const lines = readJsonl(dp);
        ok('死信保留 200 行', lines.length === 200, 'lines=' + lines.length);
        ok('超出时丢最旧（首行是 #5）', lines[0] && lines[0].text === '死信样本5', lines[0] && lines[0].text);
        ok('保留最新（末行是 #204）', lines[199] && lines[199].text === '死信样本204', lines[199] && lines[199].text);
    }

    // ── ③ P0-2：读失败不覆盖 / 原子写 ───────────────────────────────────────
    console.log('[3] P0-2 队列读失败不覆盖 + 原子写');
    {
        const atomicDir = path.join(TMP, 'atomic');
        fs.mkdirSync(atomicDir, { recursive: true });
        const p0 = await mkEvolve();
        p0._queuePath = path.join(atomicDir, 'q.jsonl');
        p0._queueAtomicWrite([{ text: '甲' }, { text: '乙' }]);
        ok('原子写内容正确', p0._queueLoad().length === 2, 'q=' + p0._queueLoad().length);
        const files = fs.readdirSync(atomicDir);
        ok('原子写不残留 .tmp', files.length === 1 && files[0] === 'q.jsonl', files.join(','));
        ok('_queueLoad 兼容旧调用（返回数组且 ok=true）',
            Array.isArray(p0._queueLoad()) && p0._queueLoad().ok === true);

        const p = await mkEvolve();
        const qp = p._queuePath;
        p._queueWrite([{ text: '原有积压A', score: 1, at: Date.now() }, { text: '原有积压B', score: 1, at: Date.now() }]);
        const before = fs.readFileSync(qp, 'utf8');
        const origRead = fs.readFileSync;
        const denyFor = (file) => {
            let denied = false;
            fs.readFileSync = function (target, ...rest) {
                if (denied && String(target) === String(file)) {
                    const e = new Error('EPERM: operation not permitted, open ' + file);
                    e.code = 'EPERM';
                    throw e;
                }
                return origRead.call(fs, target, ...rest);
            };
            return {
                on() { denied = true; },
                off() { fs.readFileSync = origRead; },
            };
        };
        const gate = denyFor(qp);
        gate.on();
        const st = p._queueLoadState();
        ok('读失败返回 ok:false（不是空队列）', st.ok === false && /EPERM/.test(st.error || ''), JSON.stringify(st));
        const appended = p._queueAppend([{ text: '读失败时的新条目' }]);
        ok('读失败时 _queueAppend 不写盘', appended.length === 0, 'ret=' + appended.length);
        gate.off();
        ok('队列文件未被覆盖', origRead.call(fs, qp, 'utf8') === before, 'bytes=' + origRead.call(fs, qp, 'utf8').length);

        // _consolidate：读失败时不 splice _pending、也不写回空队列
        const p2 = await mkEvolve();
        const qp2 = p2._queuePath;
        p2._queueWrite([{ text: '巩固前积压', score: 1, at: Date.now() }]);
        const before2 = fs.readFileSync(qp2, 'utf8');
        p2._pending = [{ text: '内存里的一条', score: 1 }];
        p2._post = async () => ({ ok: true, added: 1 });
        p2._archiveSweep = async () => ({ archived: 0 });
        p2._dir = null;
        const gate2 = denyFor(qp2);
        gate2.on();
        await p2._consolidate('测试-读失败');
        gate2.off();
        ok('_consolidate 读失败时不丢 _pending', p2._pending.length === 1 && p2._pending[0].text === '内存里的一条',
            JSON.stringify(p2._pending));
        ok('_consolidate 读失败时不覆盖队列文件', origRead.call(fs, qp2, 'utf8') === before2);
        ok('_consolidate 读失败有 warn 日志', p2.context.logs.some((l) => /队列读失败/.test(l)),
            p2.context.logs.filter((l) => /队列读失败/.test(l)).join(' | '));
    }

    // ── ④ P0-1：ok:true + added=0 不算写成功 ────────────────────────────────
    console.log('[4] ok:true + added=0 不算写成功');
    {
        const p = await mkEvolve();
        p._queueWrite([{ text: '零条样本', score: 1, at: Date.now() }]);
        const okBefore = p._stats.addOk;
        p._post = async (route) => (route === '/add' ? { status: 'success', ok: true, added: 0, merged: 0 } : null);
        const written = await p._drainQueue();
        const q = p._queueLoad();
        ok('added=0 不计入补写成功', written === 0, 'written=' + written);
        ok('added=0 条目留在队列并 attempts=1', q.length === 1 && q[0].attempts === 1, JSON.stringify(q));
        ok('added=0 不算 addOk（不写整理日志）', p._stats.addOk === okBefore, 'addOk=' + p._stats.addOk);

        // _consolidate 同口径
        const p2 = await mkEvolve();
        p2._queueWrite([]);
        p2._pending = [{ text: '零条巩固样本', score: 1 }];
        p2._post = async (route) => (route === '/search'
            ? { memories: [] }
            : { status: 'success', ok: true, added: 0, merged: 0 });
        p2._archiveSweep = async () => ({ archived: 0 });
        p2._dir = null;
        p2._drainQueue = async () => 0;
        await p2._consolidate('测试-零条');
        ok('_consolidate：added=0 不算 new（addOk 不变）', p2._stats.addOk === 0, 'addOk=' + p2._stats.addOk);
        ok('_consolidate：added=0 有「未确认」日志', p2.context.logs.some((l) => /\/add 未确认/.test(l)),
            p2.context.logs.filter((l) => /\/add 未确认/.test(l))[0] || '(none)');
        ok('_consolidate：added=0 条目回到队列（不丢）', p2._queueLoad().some((x) => x.text === '零条巩固样本'),
            '队列 ' + p2._queueLoad().length + ' 条');
    }

    // ── ⑤ P0-3：kind / valid_to / recall facts 过滤 ─────────────────────────
    console.log('[5] P0-3 事实 kind + 一次性事件过滤');
    {
        ok('classify：一次性事件', UF.classifyFact('下午三点开会', 'episode') === 'event');
        ok('classify：长期配置不是事件', UF.classifyFact('PCL在D:\\mc\\pcl.exe，PID 65700', 'episode') === 'trait');
        ok('classify：偏好', UF.classifyFact('喜欢吃香菜、下雨天睡得香', 'episode') === 'preference');
        ok('classify：explicit 不当事件（保守）', UF.classifyFact('明天要买牛奶', 'explicit') === 'trait');
        ok('classify：「一点点」不误判成点钟', UF.classifyFact('差一点点就完成', 'episode') === 'trait');
        const absBase = new Date(2026, 10, 1, 12, 0, 0).getTime();   // 2026-11-01 本地
        const absV = UF.eventValidTo('机场流量 11月15到期', absBase);
        ok('绝对日期 → 事件日 + 1 天', absV === new Date(2026, 10, 16, 0, 0, 0, 0).getTime(),
            new Date(absV).toISOString());
        const noDate = UF.eventValidTo('随手记了一件小事', absBase);
        ok('解析不出日期 → +7 天', noDate === absBase + 7 * DAY, new Date(noDate).toISOString());

        try { fs.unlinkSync(UF.file()); } catch (e) { /* 从空开始 */ }
        const now = Date.now();
        const ev = UF.addFact({ text: '下午三点开会', source: 'episode', now, expireEvents: true });
        ok('event 写入即带 valid_to', ev.ok && !!UF.load().find((f) => f.id === ev.id).valid_to,
            JSON.stringify(UF.load().find((f) => f.id === ev.id)));
        ok('event kind 落盘', UF.load().find((f) => f.id === ev.id).kind === 'event');
        const tr = UF.addFact({ text: '我家猫叫布丁', source: 'explicit', now });
        const trRow = UF.load().find((f) => f.id === tr.id);
        ok('trait 没有 valid_to', trRow.kind === 'trait' && trRow.valid_to === null, JSON.stringify(trRow));
        ok('searchFacts 行带 kind 字段', UF.searchFacts('开会', { limit: 5 }).some((r) => r.kind === 'event'));
        ok('event 仍在 activeFacts 里（未到期）', UF.activeFacts().some((f) => /开会/.test(f.fact)),
            'active=' + UF.activeFacts().length);

        const rp = new R();
        rp.context = mkCtx();
        const out = JSON.parse(await rp.executeTool('facts', {}));
        ok('recall facts 默认过滤一次性事件', out.count === 1 && out.items.every((r) => r.kind !== 'event'),
            JSON.stringify(out.items.map((r) => r.fact)));
        ok('hidden_events 给出被过滤条数', out.hidden_events === 1, 'hidden=' + out.hidden_events);
        const out2 = JSON.parse(await rp.executeTool('facts', { include_events: true }));
        ok('include_events:true 能看到一次性事件', out2.count === 2 && out2.items.some((r) => r.kind === 'event'),
            JSON.stringify(out2.items.map((r) => r.fact)));
        const out3 = JSON.parse(await rp.executeTool('facts', { include_expired: true }));
        ok('include_expired 仍不解除事件过滤', out3.items.every((r) => r.kind !== 'event'),
            JSON.stringify(out3.items.map((r) => r.fact)));

        // 兼容：没有显式声明 expireEvents 的旧调用方行为不变（不给 valid_to）
        const plain = UF.addFact({ text: '昨天下午三点开会', source: 'episode', now });
        const plainRow = UF.load().find((f) => f.id === plain.id);
        ok('旧调用不自动加 valid_to（兼容，语义变更需调用方声明）',
            plainRow.kind === 'event' && plainRow.valid_to === null, JSON.stringify(plainRow));
    }

    // ── ⑥ P0-3：迁移幂等（只加字段、不改文本）──────────────────────────────
    console.log('[6] P0-3 迁移幂等');
    {
        const T0 = new Date(2026, 10, 20, 9, 0, 0).getTime();
        const doc = {
            version: 1,
            updated_at: T0,
            facts: [
                { id: 'a', fact: '下午三点开会', valid_from: T0, valid_to: null, source: 'episode' },
                { id: 'b', fact: 'PCL在D:\\mc\\pcl.exe，PID 65700', valid_from: T0, valid_to: null, source: 'episode' },
                { id: 'c', fact: '喜欢吃香菜', valid_from: T0, valid_to: null, source: 'episode' },
                { id: 'd', fact: '明天要买牛奶', valid_from: T0, valid_to: null, source: 'explicit' },
            ],
        };
        const textsBefore = doc.facts.map((f) => f.fact).join('|');
        const m1 = MIG.migrateFacts(doc, { now: T0 });
        ok('迁移给 4 条都补了 kind', m1.changed === 4 && doc.facts.every((f) => f.kind), JSON.stringify(doc.facts.map((f) => f.kind)));
        ok('只有一条判成 event', m1.events === 1 && doc.facts[0].kind === 'event', 'events=' + m1.events);
        ok('event 得到 valid_to（事件日+1天）', doc.facts[0].valid_to === new Date(2026, 10, 21, 0, 0, 0, 0).getTime(),
            new Date(doc.facts[0].valid_to).toISOString());
        ok('配置类保持 trait', doc.facts[1].kind === 'trait');
        ok('偏好判 preference', doc.facts[2].kind === 'preference');
        ok('explicit 保持 trait', doc.facts[3].kind === 'trait');
        const m2 = MIG.migrateFacts(doc, { now: T0 + 1 });
        ok('迁移幂等（第二次改 0 条）', m2.changed === 0 && m2.events === 0);
        ok('迁移不改事实文本', doc.facts.map((f) => f.fact).join('|') === textsBefore);
        ok('迁移不覆盖已有 valid_to', doc.facts[0].valid_to === new Date(2026, 10, 21, 0, 0, 0, 0).getTime());
    }

    // ── ⑦ 补充：/add 超时按后端区分 + backend 日志 ──────────────────────────
    console.log('[7] /add 超时 本地 40s / 云端 150s');
    {
        const p = await mkEvolve();
        p._memosBackendIsLocal = () => true;
        ok('本地后端 → 40s', p._postTimeoutMs() === 40000, String(p._postTimeoutMs()));
        p._memosBackendIsLocal = () => false;
        ok('云端后端 → 150s', p._postTimeoutMs() === 150000, String(p._postTimeoutMs()));

        const origRequest = http.request;
        let seenTimeout = null;
        const fakeRequest = () => (options, cb) => {
            seenTimeout = options.timeout;
            const fake = {
                on() {}, write() {}, end() {}, destroy() {},
                setTimeout(ms, fn) { this._fn = fn; },
            };
            setImmediate(() => { try { fake._fn && fake._fn(); } catch (e) { /* noop */ } });
            return fake;
        };
        p._memosBackendIsLocal = () => true;
        http.request = fakeRequest();
        p.context.logs.length = 0;
        const res = await p._post('/add', { messages: [] });
        ok('_post 对本地后端使用 40s 超时', seenTimeout === 40000, 'timeout=' + seenTimeout);
        ok('超时按失败处理（resolve null）', res === null);
        ok('超时日志带 backend:\'local\'', p.context.logs.some((l) => /backend:'local'/.test(l)),
            p.context.logs.join(' | ') || '(none)');
        ok('超时日志带 route 与秒数', p.context.logs.some((l) => /\/add/.test(l) && /40s/.test(l)));

        p.context.logs.length = 0;
        seenTimeout = null;
        await p._post('/add', { messages: [] });
        ok('60s 内同一 route 不重复刷超时日志', p.context.logs.length === 0,
            p.context.logs.join(' | ') || '(none)');

        p._memosBackendIsLocal = () => false;
        p.context.logs.length = 0;
        await p._post('/search', {});
        ok('云端后端仍用 150s', seenTimeout === 150000, 'timeout=' + seenTimeout);
        http.request = origRequest;
    }

    // ── ⑧ P1-2：兑现 entity 通道排除自引与查询词 ────────────────────────────
    console.log('[8] P1-2 兑现 entity 口径');
    {
        const self = MU.judgeUsage('行吧，我看看……能看屏幕能听声音', '我看你屏幕挺清楚的', null, { role: 'assistant' });
        ok('assistant 自引不计 entity', self.used === false && self.reason === 'assistant-self-reference',
            JSON.stringify(self));
        const fragText = '行吧，我看看……能看屏幕能听声音';
        const frag = MU.judgeUsage(fragText, fragText, MU.extractFragments(fragText), { role: 'assistant' });
        ok('assistant 的原样片段仍是强证据（fragment 口径不变）',
            frag.used === true && frag.method === 'fragment', JSON.stringify(frag));

        const a = MU.judgeUsage('青岚湖畔捡到一只三花猫', '就是你说的青岚湖畔吧');
        ok('无 query 时旧口径仍算 used', a.used === true, JSON.stringify(a));
        const b = MU.judgeUsage('青岚湖畔捡到一只三花猫', '就是你说的青岚湖畔吧', null, { query: '青岚湖畔在哪' });
        ok('查询词里本来就有的实体不算兑现', b.used === false && b.reason === 'no-entity-overlap', JSON.stringify(b));
        const c = MU.judgeUsage('我对香菜过敏', '你上次说吃香菜会难受', null, { query: '你问过我吗' });
        ok('查询词之外的实体仍可命中（过滤不过度）', c.used === true && c.method === 'entity', JSON.stringify(c));

        const usageFile = path.join(path.dirname(qPath), '记忆兑现-queuefacts.json');
        iso.assertIsolated(usageFile);
        const u = MU.createMemoryUsage({ file: usageFile });
        const now = Date.now();
        u.noteInjected({
            entries: [{ id: 'self1', source: '记忆库', role: 'assistant', text: '行吧，我看看能看屏幕能听声音' }],
            at: now, query: '你能看屏幕吗',
        });
        const ru = u.noteUsed({ text: '我看你屏幕挺清楚的', at: now + 1000 });
        ok('实例：assistant 自引不记 used', ru.used === 0, JSON.stringify(ru));

        u.noteInjected({
            entries: [{ id: 'q1', source: '对话', role: 'user', text: '青岚湖畔捡到一只三花猫' }],
            at: now + 2000, query: '青岚湖畔在哪',
        });
        const rq = u.noteUsed({ text: '就是你说的青岚湖畔吧', at: now + 3000 });
        ok('实例：pending 记下的 query 参与过滤', rq.used === 0, JSON.stringify(rq));
    }

    // ── ⑨ P0-2：习惯/周期性表述不得判成一次性事件 ─────────────────────────
    console.log('[9] P0-2 习惯句 → trait（不再次日失效）');
    {
        const habits = [
            '我每天吃了晚饭就散步',
            '我一般晚上八点跑步',
            '我早上喝咖啡',
            '我平时周末去爬山',
            '我经常熬夜写代码',
            '我每晚都会看会儿书',
        ];
        for (const t of habits) {
            const k = UF.classifyFact(t, 'episode');
            ok('习惯句判 trait：' + t, k === 'trait', 'kind=' + k);
        }
        ok('习惯判据直接可见（isHabitFact）', UF.isHabitFact('我每天早上八点跑步') === true);
        ok('「每天 + 点钟」优先 trait（不是 event）',
            UF.classifyFact('我每天七点半出门跑步', 'episode') === 'trait',
            UF.classifyFact('我每天七点半出门跑步', 'episode'));
        ok('一次性「今天下午三点开会」仍是 event',
            UF.classifyFact('今天下午三点开会', 'episode') === 'event',
            UF.classifyFact('今天下午三点开会', 'episode'));
        ok('一次性「昨天去杭州」仍是 event',
            UF.classifyFact('昨天去杭州', 'episode') === 'event',
            UF.classifyFact('昨天去杭州', 'episode'));
        ok('一次性「刚才九点关电脑」仍是 event',
            UF.classifyFact('刚才九点关电脑', 'episode') === 'event',
            UF.classifyFact('刚才九点关电脑', 'episode'));
        ok('原有一次性事件口径未变（下午三点开会）',
            UF.classifyFact('下午三点开会', 'episode') === 'event');

        // 迁移：把已误判成 event 的习惯句改回 trait 并清 valid_to；重跑幂等
        const T0 = new Date(2026, 10, 20, 9, 0, 0).getTime();
        const doc = {
            version: 1,
            updated_at: T0,
            facts: [
                { id: 'h1', fact: '我每天吃了晚饭就散步', kind: 'event', valid_from: T0, valid_to: T0 + DAY, source: 'episode' },
                { id: 'h2', fact: '下午三点开会', kind: 'event', valid_from: T0, valid_to: T0 + DAY, source: 'episode' },
                { id: 'h3', fact: '我早上喝咖啡', valid_from: T0, valid_to: null, source: 'episode' },
            ],
        };
        const textsBefore = doc.facts.map((f) => f.fact).join('|');
        const r1 = MIG.migrateFacts(doc, { now: T0 });
        ok('迁移把习惯 event 改回 trait', doc.facts[0].kind === 'trait', doc.facts[0].kind);
        ok('迁移清掉习惯条目的误设 valid_to', doc.facts[0].valid_to === null, JSON.stringify(doc.facts[0].valid_to));
        ok('迁移计数包含习惯回改', r1.habits === 1, 'habits=' + r1.habits);
        ok('真一次性事件不受影响', doc.facts[1].kind === 'event' && doc.facts[1].valid_to === T0 + DAY);
        ok('未定 kind 的习惯句直接判 trait', doc.facts[2].kind === 'trait');
        const r2 = MIG.migrateFacts(doc, { now: T0 + 1 });
        ok('迁移对习惯句幂等（第二次改 0 条）', r2.changed === 0 && r2.habits === 0,
            JSON.stringify({ changed: r2.changed, habits: r2.habits }));
        ok('迁移仍不改文本', doc.facts.map((f) => f.fact).join('|') === textsBefore);
    }

    // ── ⑩ P1-2：重复文本 + supersedeIds 也要写回指 ─────────────────────────
    console.log('[10] P1-2 duplicate + supersedeIds → superseded_by');
    {
        try { fs.unlinkSync(UF.file()); } catch (e) { /* 从空开始 */ }
        const keep = UF.addFact({ text: '我不吃香菜', source: 'explicit' });
        const oldOne = UF.addFact({ text: '我家猫叫布丁', source: 'explicit' });
        const r = UF.addFact({ text: '我不吃香菜', source: 'explicit', supersedeIds: [oldOne.id] });
        ok('重复文本 + supersedeIds 仍返回 duplicate', r.ok === true && r.duplicate === true, JSON.stringify(r));
        ok('返回 id 指向同文本的现行事实（不再 id:null）', r.id === keep.id, 'id=' + r.id);
        ok('superseded 列表包含被显式压掉的旧事实', (r.superseded || []).includes(oldOne.id),
            JSON.stringify(r.superseded));
        const rows = UF.load();
        const oldRow = rows.find((f) => f.id === oldOne.id);
        ok('旧事实 superseded_by 非空且指向现行 id', !!oldRow && oldRow.superseded_by === keep.id,
            JSON.stringify(oldRow && { superseded_by: oldRow.superseded_by, valid_to: oldRow.valid_to }));
        ok('旧事实 valid_to 已设（失效）', !!oldRow && Number(oldRow.valid_to) > 0);
        ok('activeFacts 不含被压掉的旧事实', !UF.activeFacts().some((f) => f.id === oldOne.id));
        const hist = UF.searchFacts('布丁', { limit: 5, includeExpired: true });
        ok('历史查询仍能查到旧事实且带 superseded_by',
            hist.some((h) => h.id === oldOne.id && h.expired === true && h.superseded_by === keep.id),
            JSON.stringify(hist.map((h) => ({ id: h.id, expired: h.expired, by: h.superseded_by }))));
        ok('默认查询不含被压掉的旧事实', !UF.searchFacts('布丁', { limit: 5 }).some((h) => h.id === oldOne.id));
    }

    // ── ⑪ P1-4：drain 期间并发入队不被整份覆盖 ──────────────────────────────
    console.log('[11] P1-4 drain 期间 append 的新条目不丢');
    {
        const p = await mkEvolve();
        p._queueWrite([{ text: '第一条待写', score: 1, at: Date.now() }]);
        let appended = 0;
        p._post = async (route) => {
            if (!appended) {
                appended += 1;
                // 模拟 drain 正卡在 /add 上时，另一条路径 _queueAppend 写入新条目
                p._queueAppend([{ text: 'drain 期间新入队', score: 1 }]);
            }
            return { status: 'success', ok: true, added: 1, merged: 0 };
        };
        const w = await p._drainQueue();
        const q = p._queueLoad();
        ok('处理成功的条目已从队列移除', !q.some((x) => x.text === '第一条待写'), JSON.stringify(q));
        ok('drain 期间 append 的新条目仍在', q.some((x) => x.text === 'drain 期间新入队'), JSON.stringify(q));
        ok('补写计数正确（1 条）', w === 1, 'written=' + w);
        ok('队列只剩并发写入的那 1 条', q.length === 1, 'q=' + q.length);

        // 失败路径同样保留新条目（attempts 更新不被新快照覆盖）
        const p2 = await mkEvolve();
        p2._queueWrite([{ text: '失败待写A', score: 1, at: Date.now() }]);
        let added2 = 0;
        p2._post = async () => {
            if (!added2) { added2 += 1; p2._queueAppend([{ text: '失败期间新入队', score: 1 }]); }
            return { status: 'failed', ok: false, added: 0, merged: 0, error: 'boom' };
        };
        await p2._drainQueue();
        const q2 = p2._queueLoad();
        ok('失败条目保留且 attempts=1', q2.some((x) => x.text === '失败待写A' && x.attempts === 1),
            JSON.stringify(q2));
        ok('失败 drain 期间的新条目也保留', q2.some((x) => x.text === '失败期间新入队'), JSON.stringify(q2));

        // 单飞：重叠的两次 drain 不会重复调用 /add
        const p3 = await mkEvolve();
        p3._queueWrite([{ text: '单飞样本', score: 1, at: Date.now() }]);
        let calls3 = 0;
        p3._post = async () => {
            calls3 += 1;
            await new Promise((r) => setTimeout(r, 10));
            return { status: 'success', ok: true, added: 1, merged: 0 };
        };
        const [w1, w2] = await Promise.all([p3._drainQueue(), p3._drainQueue()]);
        ok('重叠 drain 只调用一次 /add（单飞）', calls3 === 1, 'calls=' + calls3);
        ok('重叠的那一次直接返回 0', (w1 === 0 && w2 === 1) || (w1 === 1 && w2 === 0), w1 + ',' + w2);
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    iso.cleanup(TMP);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    iso.cleanup(TMP);
    process.exit(2);
});
