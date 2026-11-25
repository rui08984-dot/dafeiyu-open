#!/usr/bin/env node
/**
 * _probe/test-background-gates.cjs —— 后台花费闸统一（2026-11-24 第三轮 P1）
 *
 * 防的是「quiet ≠ 花钱许可」这条被忽略太久：
 *   `cost.quiet` 只拦「主动开口/看屏」；`dynamic-persona`（每 N 轮）、`mind-kernel`
 *   （计划生成）、`companion-health`、`live-dock`（回弹幕）过去压根没过后台闸 ——
 *   静默期/预算关照样花云 token（审计 §8.3 最后一条）。
 *
 * 现在四条路径都走 js/core/background-llm.js 的**唯一入口** ensureCanRun（内部仍走 canRun）：
 *   ① 闸 {ok:false}（disabled / quota_exhausted / backoff）→ 不发请求、**游标不动**；
 *   ② 闸放开 → 照常跑（且「恢复」只记一次日志，不刷屏）；
 *   ③ 语义：quiet=true 但 background_llm=true → 后台仍跑（quiet 不说话 ≠ 不花钱）；
 *   ④ 本地任务走 canRunLocal（云端配额暂停不拦本地；cost.local_memory 独立）。
 *
 * 全程离线：ctx.callLLM / sendMessage 都是计数器，global.fetch 只应答本地 /health。
 */
'use strict';

const path = require('path');
const iso = require('./lib/test-isolation.cjs');

// 先隔离数据根，再 require 业务模块（llm-health 会按 PET_DATA_ROOT 找状态文件）
const TMP = iso.setUpTempDataRoot('pet-bg-gates-');

const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const BL = require(path.join(LIVE, 'js', 'core', 'background-llm.js'));
const { llmHealth } = require(path.join(LIVE, 'js', 'core', 'llm-health.js'));
const localLLM = require(path.join(LIVE, 'js', 'core', 'local-llm.js'));
const SC = require(path.join(LIVE, 'js', 'core', 'speech-coordinator.js'));

const DynamicPersona = require(path.join(LIVE, 'plugins', 'community', 'dynamic-persona', 'index.js'));
const CompanionHealth = require(path.join(LIVE, 'plugins', 'community', 'companion-health', 'index.js'));
const LiveDock = require(path.join(LIVE, 'plugins', 'community', 'live-dock', 'index.js'));
const MindKernel = require(path.join(LIVE, 'plugins', 'community', 'mind-kernel', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const flush = () => new Promise((r) => setImmediate(r));
const HEALTH_PATH = path.join(TMP, 'LLM健康.json');

/** 云端恢复可用（空熔断态）。 */
function cloudOk() {
    llmHealth.resetForTests({ path: HEALTH_PATH });
    BL.__test.resetGateLog();
}
/** 云端踩 429（无重置时刻 → 退避），返回是否真的被拦。 */
function cloudBlocked() {
    cloudOk();
    llmHealth.noteFailure({ status: 429, body: '{"error":{"message":"rate limited"}}' }, Date.now());
    const v = BL.canRun({ getConfig: () => ({}) });
    return v.ok === false;
}

/** 本地 /health 假应答（只用于 canRunLocal 的独立性对照）。 */
global.fetch = async (url) => {
    const u = String(url);
    if (/11435/.test(u) && /\/health/.test(u)) {
        return { ok: true, status: 200, json: async () => ({ status: 'ok' }), text: async () => '' };
    }
    throw new Error('本测试不应访问网络：' + u);
};

function mkCtx(cost, extra) {
    const logs = [];
    const state = { llmCalls: 0, sends: 0, patches: [] };
    const ctx = Object.assign({
        logs,
        state,
        getConfig: () => ({ cost: cost || {} }),
        getPluginFileConfig: () => ({}),
        getPluginConfig: () => ({}),
        isPluginEnabled: () => true,
        log: (lv, msg) => { logs.push(String(lv) + ':' + String(msg)); },
        addSystemPromptPatch: (id, text, opts) => { state.patches.push({ id, text, opts }); },
        removeSystemPromptPatch: () => {},
        callLLM: async () => { state.llmCalls += 1; return '有点犯困但还在撑'; },
        sendMessage: async () => { state.sends += 1; return '在的在的'; },
    }, extra || {});
    return ctx;
}

function resetSpeech() {
    const sc = SC.get ? SC.get({}) : SC;
    if (sc) { sc._lastSpokenAt = 0; sc._lastPriority = 0; }
}

// ── ① dynamic-persona：每 N 轮的状态生成 ────────────────────────────────────
async function runDynamicPersona(cost) {
    const ctx = mkCtx(cost);
    const p = new DynamicPersona();
    p.context = ctx;
    await p.onInit();
    p.updateFreq = 1;               // 每轮都到更新点，便于断言
    p._updating = false;
    const mkReq = () => ({
        messages: [{ role: 'system', content: 'S' }, { role: 'user', content: '今天想吃点什么' }],
        addVolatile() {},
    });
    await p.onLLMRequest(mkReq());
    await flush();
    return { p, ctx };
}

// ── ② companion-health：互动超量的提示 ─────────────────────────────────────
async function runCompanionHealth(cost) {
    const ctx = mkCtx(cost);
    const p = new CompanionHealth();
    p.context = ctx;
    await p.onInit();
    p._enabled = true;
    p._threshold = 30;
    p._minutes = 999;
    p._lastPromptAt = 0;
    await p.onUserInput();
    return { p, ctx };
}

// ── ③ live-dock：回弹幕（sendMessage = 一次云调用）─────────────────────────
async function runLiveDock(cost) {
    const ctx = mkCtx(cost);
    const p = new LiveDock();
    p.context = ctx;
    await p.onInit();
    p._enabled = true;
    p._speakMax = 40;
    p._lastDanmakuAt = Date.now();
    p._buffer = [{ type: 'chat', user: '路人甲', text: '主播在吗' }];
    resetSpeech();
    p._select();
    await flush();
    return { p, ctx };
}

// ── ④ mind-kernel：计划生成（一次额外云调用）───────────────────────────────
async function runMindKernel(cost) {
    const ctx = mkCtx(cost);
    ctx.isPluginEnabled = () => true;
    const goalsFile = path.join(TMP, 'goals-' + Math.random().toString(36).slice(2) + '.json');
    const ledgerFile = goalsFile.replace(/\.json$/, '-ledger.jsonl');
    ctx.getPluginFileConfig = () => ({
        enabled: true,
        tick_ms: 600000,
        goals_file: goalsFile,
        ledger_file: ledgerFile,
        plan_generate: true,
        plan_max_steps: 8,
        plan_timeout_ms: 500,
    });
    ctx.callLLM = async () => {
        ctx.state.llmCalls += 1;
        return '{"steps":[{"title":"查明需求","t2":"对话里已有明确需求"},{"title":"给出结论","t2":"回复里给出结论"}]}';
    };
    const p = new MindKernel();
    p.context = ctx;
    await p.onInit();
    const gid = p.addGoalForTask({ title: '把桌面报告发给他', doneWhen: '邮件已发送且附件 2MB' });
    const before = p._store.get(gid);
    const plan = await p.generatePlan(gid);
    const after = p._store.get(gid);
    return { p, ctx, gid, plan, before, after };
}

(async () => {
    ok('ensureCanRun 是唯一入口且返回 {ok,reason,retryAt,kind}',
        typeof BL.ensureCanRun === 'function'
        && (() => {
            cloudOk();
            const r = BL.ensureCanRun({ getConfig: () => ({}) }, { kind: 'probe' });
            return r && r.ok === true && r.kind === 'probe' && 'reason' in r && 'retryAt' in r;
        })());

    // ══ background_llm=false：四条路径全部停、游标不动 ══════════════════════
    cloudOk();
    {
        const { p, ctx } = await runDynamicPersona({ background_llm: false });
        ok('dynamic-persona：disabled → 不发 LLM 请求', ctx.state.llmCalls === 0, 'calls=' + ctx.state.llmCalls);
        ok('dynamic-persona：disabled → 游标 msgCount 不动', p.msgCount === 0, 'msgCount=' + p.msgCount);
        ok('dynamic-persona：disabled → 状态没被半截结果覆盖', p.persona === '', JSON.stringify(p.persona));
    }
    cloudOk();
    {
        const { p, ctx } = await runCompanionHealth({ background_llm: false });
        ok('companion-health：disabled → 不注入提示补丁', ctx.state.patches.length === 0,
            'patches=' + ctx.state.patches.length);
        ok('companion-health：disabled → 不推进 lastPromptAt', p._lastPromptAt === 0, String(p._lastPromptAt));
        ok('companion-health：disabled → 互动时长仍照常累计（本地无花费）', p._minutes > 999, String(p._minutes));
    }
    cloudOk();
    {
        const { p, ctx } = await runLiveDock({ background_llm: false });
        ok('live-dock：disabled → 不调 sendMessage', ctx.state.sends === 0, 'sends=' + ctx.state.sends);
        ok('live-dock：disabled → 弹幕不进 splice（buffer 原样保留）', p._buffer.length === 1,
            'buffer=' + p._buffer.length);
    }
    cloudOk();
    {
        const { ctx, plan, before, after } = await runMindKernel({ background_llm: false });
        ok('mind-kernel：disabled → 不发 LLM 请求', ctx.state.llmCalls === 0, 'calls=' + ctx.state.llmCalls);
        ok('mind-kernel：disabled → generatePlan 返回 null', plan === null, String(plan));
        ok('mind-kernel：disabled → 计划游标不动 + 计划没被改写',
            after.plan.cursor === before.plan.cursor
            && after.plan.lines.length === before.plan.lines.length
            && after.plan.rev === before.plan.rev,
            JSON.stringify({ cursor: after.plan.cursor, lines: after.plan.lines.length, rev: after.plan.rev }));
    }

    // ══ 云端 429 退避：同样全部停（reason=backoff）═══════════════════════════
    const blocked = cloudBlocked();
    ok('429 后 canRun 真的被拦（前置条件）', blocked === true);
    ok('429 拦截原因来自 llm-health（不是 disabled）',
        BL.canRun({ getConfig: () => ({}) }).reason !== 'disabled',
        String(BL.canRun({ getConfig: () => ({}) }).reason));
    {
        const { p, ctx } = await runDynamicPersona({});
        ok('dynamic-persona：429 → 不发请求 / 游标不动',
            ctx.state.llmCalls === 0 && p.msgCount === 0,
            'calls=' + ctx.state.llmCalls + ' msgCount=' + p.msgCount);
    }
    {
        const { ctx, plan } = await runMindKernel({});
        ok('mind-kernel：429 → 不发请求 / 计划保持单步', ctx.state.llmCalls === 0 && plan === null,
            'calls=' + ctx.state.llmCalls);
    }

    // ══ 日志只打一次（状态迁移才喊，防每轮刷屏）═════════════════════════════
    {
        cloudOk();
        const { p, ctx } = await runDynamicPersona({ background_llm: false });
        for (let i = 0; i < 4; i++) { await p.onLLMRequest({
            messages: [{ role: 'system', content: 'S' }, { role: 'user', content: '再来一句' }],
            addVolatile() {},
        }); await flush(); }
        const gateLogs = ctx.logs.filter((l) => l.includes('[后台闸]') && l.includes('dynamic-persona'));
        ok('连续 5 次被拦只留 1 条闸日志', gateLogs.length === 1, gateLogs.length + ' 条');
        ok('闸日志说明「不推进游标、恢复后补跑」',
            gateLogs.length === 1 && gateLogs[0].includes('不推进游标'), gateLogs[0] || '');
        ok('ensureCanRun 计数与调用次数一致（对话可审计）', BL.__test.gateSeen('dynamic-persona') >= 5,
            String(BL.__test.gateSeen('dynamic-persona')));
    }

    // ══ 闸放开：四条路径恢复（且「恢复」也只记一次）═════════════════════════
    cloudOk();
    {
        const { p, ctx } = await runDynamicPersona({});
        ok('dynamic-persona：放开 → 发 1 次请求', ctx.state.llmCalls === 1, 'calls=' + ctx.state.llmCalls);
        ok('dynamic-persona：放开 → 游标正常推进', p.msgCount === 1, 'msgCount=' + p.msgCount);
        await flush();
        ok('dynamic-persona：放开 → 状态落定', p.persona.length > 0, JSON.stringify(p.persona));
    }
    cloudOk();
    {
        const { p, ctx } = await runCompanionHealth({});
        ok('companion-health：放开 → 注入 1 条提示', ctx.state.patches.length === 1,
            'patches=' + ctx.state.patches.length);
        ok('companion-health：放开 → 推进 lastPromptAt', p._lastPromptAt > 0, String(p._lastPromptAt));
    }
    cloudOk();
    {
        const { p, ctx } = await runLiveDock({});
        ok('live-dock：放开 → 调 sendMessage 1 次', ctx.state.sends === 1, 'sends=' + ctx.state.sends);
        ok('live-dock：放开 → 弹幕被取走', p._buffer.length === 0, 'buffer=' + p._buffer.length);
    }
    cloudOk();
    {
        const { ctx, plan, after } = await runMindKernel({});
        ok('mind-kernel：放开 → 发 1 次请求', ctx.state.llmCalls === 1, 'calls=' + ctx.state.llmCalls);
        ok('mind-kernel：放开 → 计划写成 2 步（游标仍 0）',
            !!plan && plan.lines.length === 2 && plan.cursor === 0,
            JSON.stringify(plan && { lines: plan.lines.length, cursor: plan.cursor }));
        ok('mind-kernel：放开 → 落盘一致', after.plan.lines.length === 2, String(after.plan.lines.length));
    }

    // ══ quiet 语义：只拦主动开口，不是花钱闸 ═════════════════════════════════
    {
        cloudOk();
        const { ctx } = await runDynamicPersona({ quiet: true });
        ok('quiet=true 且 background_llm=true → 后台任务仍跑（quiet 不说话 ≠ 不花钱）',
            ctx.state.llmCalls === 1, 'calls=' + ctx.state.llmCalls);
        const verdict = BL.ensureCanRun({ getConfig: () => ({ cost: { quiet: true } }) }, { kind: 'quiet-check' });
        ok('ensureCanRun 不看 cost.quiet', verdict.ok === true, JSON.stringify(verdict));
    }

    // ══ 结构事实：插件侧不再各写一份闸（2026-11-25 收口）══════════════════════
    // 「只有一个真相」不能只靠口头约定：审计要能扫出「谁又自己调了 canRun / 吞异常」。
    {
        const fs = require('fs');
        const files = [];
        (function walk(dir) {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, ent.name);
                if (ent.isDirectory()) walk(p);
                else if (ent.isFile() && p.endsWith('.js')) files.push(p);
            }
        })(path.join(LIVE, 'plugins'));
        const srcs = files.map((f) => fs.readFileSync(f, 'utf8'));
        ok('插件侧没有 backgroundLLM.canRun( 直接调用（本地闸 canRunLocal 除外）',
            !srcs.some((s) => /\bbackgroundLLM\.canRun\s*\(/.test(s)
                || /require\([^)]*background-llm\.js[^)]*\)\.canRun\s*\(/.test(s)));
        const kinds = new Set();
        for (const s of srcs) {
            for (const m of s.matchAll(/ensureCanRun\([\s\S]{0,160}?kind:\s*'([^']+)'/g)) kinds.add(m[1]);
        }
        ok('ensureCanRun kind 已覆盖后台云路径（≥7 个）', kinds.size >= 7,
            Array.from(kinds).sort().join(','));
        const required = ['dynamic-persona', 'mind-kernel', 'companion-health', 'live-dock',
            'ai-log', 'persona-guard', 'user-profile', 'memory-evolve-reflect'];
        const missing = required.filter((k) => !kinds.has(k));
        ok('已知后台云路径全部迁移到 ensureCanRun（无漏项）', missing.length === 0,
            missing.length ? 'missing=' + missing.join(',') : 'all-present');
    }

    // ══ 本地任务闸独立：云端暂停不拦本地；cost.local_memory 单独管 ═══════════
    {
        cloudOk();
        localLLM.__test.reset();
        const up = await BL.canRunLocal({ getConfig: () => ({}) });
        ok('canRunLocal：本地在线 → ok', up.ok === true, JSON.stringify(up));

        cloudBlocked();
        localLLM.__test.reset();
        const cloudOffLocalOn = await BL.canRunLocal({ getConfig: () => ({}) });
        ok('云端 429 期间 canRunLocal 仍放行（两套闸互不复用）', cloudOffLocalOn.ok === true,
            JSON.stringify(cloudOffLocalOn));

        localLLM.__test.reset();
        const localOff = await BL.canRunLocal({ getConfig: () => ({ cost: { local_memory: false } }) });
        ok('cost.local_memory=false → local_disabled（不回退云）',
            localOff.ok === false && localOff.reason === 'local_disabled', JSON.stringify(localOff));

        // ⚠ 语义现状（与既有契约一致，见 _probe/test-local-llm.cjs:303）：cost.background_llm
        //   是「后台总开关」，关掉时本地任务也停（reason=disabled）。本地只花 GPU 不花云钱，
        //   「只关云不关本地」需要改 canRunLocal 的语义 —— 那会推翻 test-local-llm 的断言，
        //   故本测试锁现状，不擅自改契约。
        const totalOff = await BL.canRunLocal({ getConfig: () => ({ cost: { background_llm: false } }) });
        ok('background_llm=false 是后台总开关（本地任务也停，reason=disabled，与既有契约一致）',
            totalOff.ok === false && totalOff.reason === 'disabled', JSON.stringify(totalOff));

        ok('云端/本地闸的理由词可区分（disabled vs local_down）',
            totalOff.reason === 'disabled' && up.reason === null, totalOff.reason + '/' + up.reason);
    }

    iso.cleanup(TMP);
    console.log('\n  后台花费闸：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('探针自身异常：', e);
    try { iso.cleanup(TMP); } catch (e2) { /* ignore */ }
    process.exit(1);
});
