#!/usr/bin/env node
/**
 * _probe/test-memory-integrity.cjs — 记忆链路完整性回归（2026-11-21 审计修复）
 *
 * 覆盖六条根因，每条都用一个**可观测的失败行为**断言，不看实现细节：
 *   ① 写入契约：单条 pending 会落盘；/add 的 status:failed / 200+added:0 不算成功
 *   ② 混合召回：_gateHits 的 cos 必须按候选在 all 里的位置取；单字查询能命中
 *   ③ 临时补丁：久别重逢 patch 在 onLLMResponse 后必须消失（不能靠下轮条件覆盖）
 *   ④ 忘掉：用户记忆/事实层两句一起删（MemOS 删除按响应体判成功）
 *   ⑤ 事实生命周期：episode 事实 STABLE=false；one_off 观察不晋升
 *   ⑥ JSON 抽取：带解释文字/多个对象的输出也能取到第一个完整对象
 *
 * 现场保护：**全部用临时目录**。records-path 在加载任何业务模块之前被重定向到
 * mkdtemp 目录；memory-evolve 的队列路径单独指向临时文件。绝不读写真实记录室。
 * 修复前的 forget 用例无法安全执行（旧代码把路径写死在 RECORDS）→ 明确记为 FAIL 并说明。
 *
 * 判定：PASS n / FAIL 0；有失败退出码 1（check-all 认退出码）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');

// ── 0) 先把「data」重定向到临时目录，再加载任何会 destructure recordFile 的模块 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-mem-int-'));
const REC = path.join(TMP, 'data');
fs.mkdirSync(REC, { recursive: true });

const rp = require(path.join(APP, 'js', 'core', 'records-path.js'));
rp.RECORDS_DIR = REC;
rp.recordFile = (name) => path.join(REC, name);

const UF = require(path.join(APP, 'js', 'core', 'user-facts.js'));
const ES = require(path.join(APP, 'js', 'core', 'episode-store.js'));
// ⚠ 2026-11-24 ADR-014：MemOS 后端改成本地（llama.cpp:11435）后，待写队列 flush/_drainQueue
// 先过 _writeGateOpen → localLLM.isAvailable()。单测不依赖真 server：只桩探活本身。
const localLLM = require(path.join(APP, 'js', 'core', 'local-llm.js'));
const origIsAvailable = localLLM.isAvailable;
localLLM.isAvailable = async () => true;
const RECALL_PATH = path.join(APP, 'plugins', 'community', 'memory-recall', 'index.js');
const EVOLVE_PATH = path.join(APP, 'plugins', 'community', 'memory-evolve', 'index.js');
const PROFILE_PATH = path.join(APP, 'plugins', 'community', 'user-profile', 'index.js');
const P = require(RECALL_PATH);
const E = require(EVOLVE_PATH);
const UP = require(PROFILE_PATH);

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function mkRecallCtx(state) {
    return {
        getPluginFileConfig: () => ({}),
        log: () => {},
        addSystemPromptPatch: (id, text) => { state.patches.set(id, String(text || '')); },
        removeSystemPromptPatch: (id) => { state.removed.push(id); state.patches.delete(id); },
        getMessages: () => state.messages || [],
        callLLM: async () => 'ADD',
    };
}

function readJsonFile(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

(async () => {
    console.log('[1] 写入契约：单条 pending / 失败判定');
    {
        const p = new E();
        p.context = { getPluginFileConfig: () => ({}), log: () => {}, getMessages: () => [], callLLM: async () => '' };
        await p.onInit();
        const q = path.join(TMP, 'queue-1.jsonl');
        p._queuePath = q;
        try { fs.unlinkSync(q); } catch (e) { /* 首次不存在 */ }

        // 单条过闸 → 立即持久化（30s 定时 flush 之前就不能丢）
        p.context.getMessages = () => [{ role: 'user', content: '我不吃香菜' }];
        await p.onLLMResponse({});
        const q1 = p._queueLoad ? p._queueLoad() : [];
        ok('单条过闸立即落盘（不等批量）', q1.length === 1 && q1[0].text === '我不吃香菜', '队列 ' + q1.length + ' 条');

        // 定时 flush：单条 pending 也必须进队列/被处理（假时钟用短间隔真 timer）
        try { fs.unlinkSync(q); } catch (e) { /* ignore */ }
        p._pending = [{ text: '我下周三出差', score: 1 }];
        p._memosReachable = async () => false;   // 不碰真实 8003
        if (typeof p._flushPending === 'function') {
            await p._flushPending('测试');
            const q2 = p._queueLoad();
            ok('单条 pending 经定时 flush 落盘', q2.some((x) => x.text === '我下周三出差'), '队列 ' + q2.length + ' 条');
        } else {
            ok('单条 pending 经定时 flush 落盘', false, '缺少 _flushPending（修复前）');
        }

        // /add 失败不被当作成功：status:failed
        try { fs.unlinkSync(q); } catch (e) { /* ignore */ }
        p._queueWrite([{ text: '这是失败样本', score: 1, at: Date.now() }]);
        p._memosReachable = async () => true;
        p._post = async (route) => (route === '/add' ? { status: 'failed', ok: false, added: 0, error: '模型全挂' } : null);
        await p._drainQueue();
        const q3 = p._queueLoad();
        ok('status:failed 不从待写队列删除', q3.some((x) => x.text === '这是失败样本'), '队列 ' + q3.length + ' 条');

        // 200 + 空 added 也不算成功
        try { fs.unlinkSync(q); } catch (e) { /* ignore */ }
        p._queueWrite([{ text: '这是空写入样本', score: 1, at: Date.now() }]);
        p._post = async (route) => (route === '/add' ? { status: 'success', added: 0, merged: 0 } : null);
        await p._drainQueue();
        ok('200+added:0 不从待写队列删除', p._queueLoad().length === 1, '队列 ' + p._queueLoad().length + ' 条');

        // 明确成功才删
        try { fs.unlinkSync(q); } catch (e) { /* ignore */ }
        p._queueWrite([{ text: '这是成功样本', score: 1, at: Date.now() }]);
        p._post = async (route) => (route === '/add' ? { status: 'success', ok: true, added: 1 } : null);
        await p._drainQueue();
        ok('ok:true+added:1 才从待写队列删除', p._queueLoad().length === 0, '队列 ' + p._queueLoad().length + ' 条');

        // _consolidate 同一条契约
        try { fs.unlinkSync(q); } catch (e) { /* ignore */ }
        p._pending = [{ text: '我不吃香菜', score: 1 }];
        p._post = async (route) => (route === '/search' ? { memories: [] } : { status: 'failed', ok: false, added: 0 });
        p._dir = null;
        p._archiveSweep = async () => ({ archived: 0 });
        p._drainQueue = async () => 0;
        await p._consolidate('测试');
        ok('_consolidate：失败条目仍在队列', p._queueLoad().some((x) => x.text === '我不吃香菜'), '队列 ' + p._queueLoad().length + ' 条');
        await p.onStop();
    }

    console.log('[2] 混合召回：cos 位置对齐 / 单字 df');
    {
        const state = { patches: new Map(), removed: [], messages: [] };
        const p = new P();
        p.context = mkRecallCtx(state);
        await p.onInit();
        p._hybrid = false;
        p._recordsDir = REC;

        const A = { src: '对话', role: 'user', text: '我买了猫粮配方', t: 0 };
        const B = { src: '对话', role: 'user', text: '量子猫粮配方在这里', t: 0 };
        p._installDocs([A, B]);
        const all1 = [
            { i: 0, doc: A, score: 1, cos: 0.9 },
            { i: 1, doc: B, score: 1, cos: 0.05 },
        ];
        const g1 = p._gateHits('量子猫粮配方', all1, 3, { cos: [0.9, 0.05] });
        const all2 = [
            { i: 1, doc: B, score: 1, cos: 0.05 },
            { i: 0, doc: A, score: 1, cos: 0.9 },
        ];
        const g2 = p._gateHits('量子猫粮配方', all2, 3, { cos: [0.05, 0.9] });
        const names1 = g1.map((h) => h.doc.text).sort();
        const names2 = g2.map((h) => h.doc.text).sort();
        ok('两条文档交换顺序后命中集合一致（cos 按候选位置取）',
            names1.length === 1 && JSON.stringify(names1) === JSON.stringify(names2),
            '正序=' + JSON.stringify(g1.map((h) => h.doc.text)) + ' 反序=' + JSON.stringify(g2.map((h) => h.doc.text)));

        // 单字：只有 2 条文档含「猫」，rare char 必须能过 related 与闸
        const docs = [];
        for (let i = 0; i < 8; i += 1) docs.push({ src: '对话', role: 'user', text: '无关的第' + i + '条闲聊内容', t: 0 });
        docs.push({ src: '对话', role: 'user', text: '猫在窗台上睡觉', t: 0 });
        docs.push({ src: '对话', role: 'user', text: '家里那只猫叫布丁', t: 0 });
        p._installDocs(docs);
        const lex = p._search('猫', 5, 0);
        ok('_search 单字查询能命中', lex.length > 0, '命中 ' + lex.length + ' 条');
        const gate = p._gateHits('猫', lex, 3);
        ok('_gateHits 单字查询能注入（charDf 独立表）', gate.length > 0, '过闸 ' + gate.length + ' 条');
    }

    console.log('[3] 临时补丁：onLLMResponse 统一清理');
    {
        const state = { patches: new Map(), removed: [], messages: [] };
        const p = new P();
        p.context = mkRecallCtx(state);
        await p.onInit();
        p._hybrid = false;
        p._recordsDir = REC;
        for (const id of ['memory-recall-context', 'memory-recall-remembered', 'memory-recall-forgotten', 'memory-recall-reunion']) {
            p.context.addSystemPromptPatch(id, '临时', { volatile: true });
        }
        await p.onLLMResponse();
        const left = [...state.patches.keys()];
        ok('reunion patch 在 onLLMResponse 后消失', !state.patches.has('memory-recall-reunion'), '残留=' + JSON.stringify(left));
        ok('其余本轮临时 patch 一并消失', left.length === 0, '残留=' + JSON.stringify(left));
    }

    console.log('[4] 忘掉：用户记忆 + 事实层 + MemOS 响应体');
    {
        fs.writeFileSync(path.join(REC, '用户记忆.json'), JSON.stringify([
            { id: 1, date: '2026年11月21日', content: '我家猫叫布丁', source: 'explicit' },
            { id: 2, date: '2026年11月20日', content: '我下周三出差', source: 'explicit' },
        ], null, 2), 'utf8');
        UF.addFact({ text: '我家猫叫布丁', source: 'explicit', confidence: 0.95 });
        UF.addFact({ text: '我下周三出差', source: 'explicit', confidence: 0.95 });

        const state = { patches: new Map(), removed: [], messages: [] };
        const p = new P();
        p.context = mkRecallCtx(state);
        await p.onInit();
        p._hybrid = false;
        p._recordsDir = REC;
        p._deleteFromMemos = async () => ({ ok: true, searched: 1, deleted: 1, failed: 0, errors: [] });
        if (typeof p._userMemoryFile !== 'function') {
            ok('忘掉后用户记忆与事实层同时删掉', false, '旧实现把路径写死为真实记录室，为保护真实数据跳过（修复后启用）');
        } else {
            const r = await p._forgetUserMemory({ mode: 'match', query: '猫叫布丁' });
            const um = readJsonFile(path.join(REC, '用户记忆.json'), []);
            const facts = UF.activeFacts().map((f) => String(f.fact));
            ok('忘掉后用户记忆条目消失', Array.isArray(um) && !um.some((x) => String(x.content).includes('猫叫布丁')), '剩 ' + (um || []).length + ' 条');
            ok('忘掉后事实层不再包含该句', !facts.some((t) => t.includes('猫叫布丁')), '有效事实 ' + facts.length + ' 条');
            ok('不影响其它事实', facts.some((t) => t.includes('下周三出差')), facts.join(' | ').slice(0, 60));
            ok('返回 factsRemoved 计数', r && Number(r.factsRemoved) >= 1, JSON.stringify({ ok: r && r.ok, factsRemoved: r && r.factsRemoved }));
        }

        // MemOS 删除必须看响应体：200 + status:failed 不算删掉
        const p2 = new P();
        p2.context = mkRecallCtx(state);
        await p2.onInit();
        if (typeof p2._memosBodyOk === 'function') {
            ok('删除响应体 status:failed 判失败', p2._memosBodyOk({ status: 'failed' }) === false, '');
            ok('删除响应体 status:success 判成功', p2._memosBodyOk({ status: 'success' }) === true, '');
        } else {
            ok('删除响应体 status:failed 判失败', false, '缺少响应体判定（修复前只看 HTTP 2xx）');
            ok('删除响应体 status:success 判成功', false, '缺少响应体判定（修复前只看 HTTP 2xx）');
        }
    }

    console.log('[5] 事实生命周期：episode 非 STABLE / one_off 不晋升 / 注入带日期');
    {
        fs.writeFileSync(path.join(REC, '用户事实.json'), JSON.stringify({ version: 1, facts: [] }), 'utf8');
        const old = Date.now() - 40 * 86400000;
        UF.addFact({ text: '昨天下午三点开了发布会', source: 'episode', confidence: 0.6, now: old });
        UF.addFact({ text: '我是程序员', source: 'explicit', confidence: 0.95, now: old });

        const state = { patches: new Map(), removed: [], messages: [] };
        const p = new P();
        p.context = mkRecallCtx(state);
        await p.onInit();
        p._hybrid = false;
        p._recordsDir = REC;
        p._rebuild({ dir: REC });
        const ep = p._docs.find((d) => d.text.includes('发布会'));
        const stable = p._docs.find((d) => d.text.includes('程序员'));
        ok('episode 事实带 stable=false', !!ep && ep.stable === false, JSON.stringify(ep && { src: ep.src, stable: ep.stable, t: ep.t }));
        ok('显式事实仍是 stable（不误伤）', !!stable && stable.stable !== false, JSON.stringify(stable && { src: stable.src, stable: stable.stable }));
        if (typeof p._isStableDoc === 'function') {
            ok('episode 事实不享受稳定免衰减', p._isStableDoc({ src: '事实', stable: false }) === false
                && p._isStableDoc({ src: '事实', stable: true }) === true, '');
        } else {
            ok('episode 事实不享受稳定免衰减', false, '缺少 _isStableDoc（修复前 STABLE_SRC 按来源一刀切）');
        }
        const line = p._formatInjectLine({ doc: { src: '事实', role: 'fact', text: '我是程序员', t: Date.parse('2026-11-01T09:00:00') } });
        ok('事实注入带日期', /2026-11-01/.test(line), line);

        // user-profile：一次性观察不得晋升为永久事实
        const up = new UP();
        up._cfg = {};
        up.context = { log: () => {} };
        const off = await up._shouldPromote({ status: 'candidate', category: 'fact', count: 1, first_seen: '2026-11-21', last_seen: '2026-11-21', one_off: true });
        ok('one_off 观察不晋升（count=1）', off === false, '返回 ' + off);
        const on = await up._shouldPromote({ status: 'candidate', category: 'fact', count: 1, first_seen: '2026-11-21', last_seen: '2026-11-21', one_off: false });
        ok('非 one_off 的事实仍按原规则晋升', on === true, '返回 ' + on);
        const repeat = await up._shouldPromote({ status: 'candidate', category: 'fact', count: 3, first_seen: '2026-11-10', last_seen: '2026-11-21', one_off: true });
        ok('跨天反复出现的 one_off 可被推翻（≥3 次且 ≥3 天）', repeat === true, '返回 ' + repeat);
    }

    console.log('[6] JSON 抽取：括号配平');
    {
        const noisy = '好的，这是卡片：\n{"title":"发布会","summary":"下午三点开了发布会讨论上线节奏","facts":["周五上线"]}\n备注：{} 表示没有内容';
        const card = ES.parseCard(noisy, { at: 1, turns: 2 });
        ok('parseCard 能解析「解释+对象+尾随文字」', !!card && card.summary.includes('发布会'), card ? card.title : 'null');

        const R = require(path.join(APP, 'plugins', 'community', 'memory-evolve', 'lib', 'reflect.js'));
        const j = R.pickJson(noisy);
        ok('reflect.pickJson 同一用例可解析', !!j && j.summary === '下午三点开了发布会讨论上线节奏', JSON.stringify(j));
        ok('两处共用同一实现（pickJsonObject 导出）', (() => {
            try {
                const JE = require(path.join(APP, 'plugins', 'community', 'memory-evolve', 'lib', 'json-extract.js'));
                return typeof JE.pickJsonObject === 'function';
            } catch (e) { return false; }
        })(), '');
    }

    console.log('');
    console.log((fail === 0 ? 'PASS ' : 'FAILED: ') + pass + ' / FAIL ' + fail);
    localLLM.isAvailable = origIsAvailable;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* Windows 句柄占用时留临时目录，可接受 */ }
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('测试自身异常: ' + ((e && e.stack) || e));
    localLLM.isAvailable = origIsAvailable;
    process.exit(1);
});
