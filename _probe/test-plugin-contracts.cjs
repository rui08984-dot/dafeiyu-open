#!/usr/bin/env node
/**
 * _probe/test-plugin-contracts.cjs —— 插件侧契约收口（2026-11-25）
 *
 * 锁住三条跨插件契约，防止「核心改了、插件没跟上」：
 *   ① `plugin-context.callLLM` 指定 provider 解析不到会抛 `PROVIDER_NOT_FOUND`（fail-closed）。
 *      插件不得写死可能不存在的 provider_id；本地记忆调用必须用 local-llm.resolve() 的
 *      同一真相源（与 canRunLocal 的闸一致），provider 被删/禁用时仍只在回环跑。
 *   ② 后台云端花费统一入口 `background-llm.ensureCanRun(context,{kind})`：
 *      `cost.background_llm=false` 时主动表示/主动问候/看屏评论/任务回执/日记/判官/
 *      画像/反思全部不发请求；quiet 只管「说不说」，不是花钱闸。
 *   ③ 易变内容只能走尾部：dawn-dusk 时间行 / watch-screen 屏幕摘要不允许前插最后一条
 *      user 的开头（会让 usage-ledger 的易变块剥离失效）。
 *   ④ 插件卸载/热重载补丁无残留：watch-screen 的陪玩补丁（PATCH_ID_GAME）必须在 onStop 摘掉。
 *
 * 全程离线、临时数据根；不碰真实 data、不连任何网络（global.fetch 是假实现）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

// 先隔离数据根，再 require 业务模块（records-path/llm-health 都按 PET_DATA_ROOT 落盘）
const TMP = iso.setUpTempDataRoot('pet-plugin-contracts-');

const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const BL = require(path.join(LIVE, 'js', 'core', 'background-llm.js'));
const { llmHealth } = require(path.join(LIVE, 'js', 'core', 'llm-health.js'));
const { llmProviderManager } = require(path.join(LIVE, 'js', 'core', 'llm-provider.js'));
const localLLM = require(path.join(LIVE, 'js', 'core', 'local-llm.js'));
const PC = require(path.join(LIVE, 'js', 'core', 'plugin-context.js'));

const MemoryEvolve = require(path.join(LIVE, 'plugins', 'community', 'memory-evolve', 'index.js'));
const AliveState = require(path.join(LIVE, 'plugins', 'community', 'alive-state', 'index.js'));
const DawnDusk = require(path.join(LIVE, 'plugins', 'community', 'dawn-dusk-line', 'index.js'));
const WatchScreen = require(path.join(LIVE, 'plugins', 'community', 'watch-screen', 'index.js'));
const Dispatch = require(path.join(LIVE, 'plugins', 'community', 'dispatch', 'index.js'));
const PersonaGuard = require(path.join(LIVE, 'plugins', 'community', 'persona-guard', 'index.js'));
const UserProfile = require(path.join(LIVE, 'plugins', 'community', 'user-profile', 'index.js'));
const MindKernel = require(path.join(LIVE, 'plugins', 'community', 'mind-kernel', 'index.js'));
const AiLog = require(path.join(LIVE, 'plugins', 'built-in', 'ai-log', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}

const HEALTH_PATH = path.join(TMP, 'LLM健康.json');
function healthOk() {
    llmHealth.resetForTests({ path: HEALTH_PATH });
    BL.__test.resetGateLog();
}

// ── 假网络：只应答本地 /health 与本地 chat/completions，其它一律报错 ──────────
const fetches = [];
global.fetch = async (url, init) => {
    const u = String(url);
    fetches.push({ url: u, init: init || {} });
    if (/127\.0\.0\.1:11435\/health/.test(u)) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ status: 'ok' }), text: async () => '' };
    }
    if (/127\.0\.0\.1:11435\/v1\/chat\/completions/.test(u)) {
        return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({ choices: [{ message: { content: '{"title":"周末爬山","summary":"他周末去爬山了，回来以后说腿很酸。","facts":["周末去爬山"]}' } }] }),
            text: async () => '',
        };
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
        callLLM: async () => { state.llmCalls += 1; return 'OK'; },
        sendMessage: async () => { state.sends += 1; return '好'; },
    }, extra || {});
    return ctx;
}

function findPluginFiles(dir, out) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) findPluginFiles(p, out);
        else if (ent.isFile() && p.endsWith('.js')) out.push(p);
    }
    return out;
}

(async () => {
    // ══ ① memory-evolve：片段卡不再写死 provider_id，provider 缺失也不回云 ══════
    {
        healthOk();
        localLLM.__test.reset();
        // 故意不配置 local-memory：只有云端 main。旧代码在这里会抛 PROVIDER_NOT_FOUND，
        // 或被 resolveProviderOrFallback 静默降级到云端。
        llmProviderManager.init({
            llm: { provider_id: 'main' },
            llm_providers: [{
                id: 'main', name: '云端主模型', enabled: true,
                api_url: 'https://cloud.example.com/v1', api_key: 'cloud-key',
                models: [{ model_id: 'main-model' }],
            }],
        });
        localLLM.__test.reset();   // 清掉 resolve 缓存（init 前可能已缓存）

        const ES = require(path.join(LIVE, 'js', 'core', 'episode-store.js'));
        const RP = require(path.join(LIVE, 'js', 'core', 'records-path.js'));
        const UF = require(path.join(LIVE, 'js', 'core', 'user-facts.js'));
        const orig = {
            loadCursor: ES.loadCursor, readTurns: ES.readTurns, saveCursor: ES.saveCursor,
            appendEpisode: ES.appendEpisode, recordFile: RP.recordFile, addFact: UF.addFact,
        };
        const turns = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '第' + i + '句测试内容' }));
        let cursor = 0;
        let written = 0;
        ES.loadCursor = () => cursor;
        ES.saveCursor = (n) => { cursor = n; return true; };
        ES.readTurns = () => ({ turns, consumed: turns.length, total: turns.length });
        ES.appendEpisode = () => { written += 1; return true; };
        ES.loadEpisodes = () => [];
        RP.recordFile = () => path.join(TMP, '对话历史.jsonl');
        UF.addFact = () => ({ ok: true, duplicate: false });

        try {
            const p = new MemoryEvolve();
            const realCtx = new PC.PluginContext('mem-episode-probe', {}, null);
            realCtx.log = () => {};
            p.context = realCtx;
            await p.onInit();
            p._episodeIdleMs = 0;
            p._localGate = async () => ({ ok: true, reason: null, retryAt: null });
            global.__lastUserInputAt = 0;
            fetches.length = 0;

            const card = await p._maybeBuildEpisode();
            ok('memory-evolve：provider 缺失时片段卡仍生成（没有 PROVIDER_NOT_FOUND 静默死路）',
                !!card && written === 1 && cursor === 8, JSON.stringify({ card: !!card, written, cursor }));

            const req = fetches.find((f) => /127\.0\.0\.1:11435\/v1\/chat\/completions/.test(f.url));
            ok('memory-evolve：片段卡请求打到 local-llm.resolve() 的回环地址', !!req, req && req.url);
            let body = {};
            try { body = JSON.parse((req && req.init && req.init.body) || '{}'); } catch (e) { body = {}; }
            ok('memory-evolve：请求体里没有写死的 provider_id',
                !Object.prototype.hasOwnProperty.call(body, 'provider_id'), JSON.stringify(body.provider_id));
            ok('memory-evolve：模型来自 local-llm（MemOperator-4B）', body.model === 'MemOperator-4B', String(body.model));
        } finally {
            ES.loadCursor = orig.loadCursor;
            ES.readTurns = orig.readTurns;
            ES.saveCursor = orig.saveCursor;
            ES.appendEpisode = orig.appendEpisode;
            ES.loadEpisodes = orig.loadEpisodes || ES.loadEpisodes;
            RP.recordFile = orig.recordFile;
            UF.addFact = orig.addFact;
        }
    }

    // ══ ①b memory-evolve：待写队列的闸也吃后台总开关 ═════════════════════════
    {
        healthOk();
        const p = new MemoryEvolve();
        p.context = mkCtx({ background_llm: false });
        p._memosBackendIsLocal = () => false;   // 云端 MemOS 后端
        ok('memory-evolve：云端待写队列在 background_llm=false 时不重放',
            (await p._writeGateOpen()) === false);
        p.context = mkCtx({ cost: { local_memory: false } }, { getConfig: () => ({ cost: { local_memory: false } }) });
        p._memosBackendIsLocal = () => true;    // 本地 MemOS 后端
        ok('memory-evolve：本地待写队列在 cost.local_memory=false 时不重放',
            (await p._writeGateOpen()) === false);
    }

    // ══ ② alive-state：主动表达过后台花费闸（且在 speech 令牌之前）═══════════
    {
        healthOk();
        const p = new AliveState();
        p.context = mkCtx({ background_llm: false });
        await p.onInit();
        p._state = {
            satiety: 70, energy: 5, intimacy: 20, lastPetAt: 0, lastFeedAt: 0,
            lastExpressAt: {}, updatedAt: Date.now() - 3600000,
        };
        const model = require(path.join(LIVE, 'plugins', 'community', 'alive-state', 'state-model.js'));
        const origPick = model.pickExpression;
        model.pickExpression = () => ({ kind: 'sleepy', directive: '困了' });
        let spoke = 0;
        p._speak = async () => { spoke += 1; };
        try {
            p._decayTick();
            ok('alive-state：background_llm=false → 不主动开口', spoke === 0, 'speak=' + spoke);
            ok('alive-state：闸关时不写冷却（lastExpressAt 不被烧）',
                !p._state.lastExpressAt || p._state.lastExpressAt.sleepy === undefined,
                JSON.stringify(p._state.lastExpressAt));

            healthOk();
            p.context = mkCtx({});
            p._state.lastExpressAt = {};
            p._decayTick();
            ok('alive-state：闸放开 → 主动开口 1 次', spoke === 1, 'speak=' + spoke);
        } finally {
            model.pickExpression = origPick;
        }
    }

    // ══ ② dawn-dusk-line：主动问候/重访/节目全部过后台花费闸 ═════════════════
    {
        healthOk();
        const p = new DawnDusk();
        p.context = mkCtx({ background_llm: false });
        p._timezone = 'Asia/Shanghai';
        p._firedHours = new Set();
        p._lastInteractionTime = 0;
        p._quietThreshold = 60000;
        p._activeThreshold = 1000;
        p._revisitIntervalH = 2;
        p._memosList = async () => [];
        p._showcaseEnabled = true;
        p._showRunning = false;
        p._showPlayedForIdle = false;
        p._showInterrupted = false;
        p._idleMinutes = 25;
        global.__petQuiet = false;
        delete global.proactiveArbiter;

        const blocked = mkCtx({ background_llm: false });
        let sends = 0;
        blocked.sendMessage = async () => { sends += 1; return '好'; };
        p.context = blocked;
        await p._sendDirectGreeting(8);
        ok('dawn-dusk：background_llm=false → 不主动问候', sends === 0, 'sends=' + sends);
        ok('dawn-dusk：问候被闸跳过时退回本小时标记（窗口内可补发）',
            !p._firedHours.has('2026-11-25-8') && p._firedHours.size === 0);

        p._lastInteractionTime = 0;
        await p._revisitSweep();
        ok('dawn-dusk：background_llm=false → 不话题重访', sends === 0, 'sends=' + sends);

        p._lastInteractionTime = Date.now() - 30 * 60000;
        p._maybeStartShow();
        ok('dawn-dusk：闸关时不消费本次空闲期（_showPlayedForIdle 仍 false）', p._showPlayedForIdle === false);
        ok('dawn-dusk：闸关时不启动节目', p._showRunning === false);

        const gateReason = p._showGate('开场');
        ok('dawn-dusk：节目段闸门返回后台暂停原因', !!gateReason && /后台 LLM 暂停/.test(gateReason), gateReason || '');

        healthOk();
        const open = mkCtx({});
        sends = 0;
        open.sendMessage = async () => { sends += 1; return '好'; };
        p.context = open;
        await p._sendDirectGreeting(8);
        ok('dawn-dusk：闸放开 → 主动问候 1 次', sends === 1, 'sends=' + sends);
        ok('dawn-dusk：闸放开时节目段放行', p._showGate('开场') === null);
    }

    // ══ ② dawn-dusk：时间行只走尾部（addVolatile / 末尾追加），禁止前插 ═══════
    {
        const p = new DawnDusk();
        p.context = mkCtx({});
        p._injectPerception = true;
        p._timezone = 'Asia/Shanghai';
        p._cnWorkday = null;
        p._buildPerceptionLine = () => '发送时间: 2026-11-25 10:00 | 工作日, 上午';

        const volatile = [];
        const msgs = [{ role: 'user', content: '今天好累' }];
        await p.onLLMRequest({ messages: msgs, addVolatile: (t) => volatile.push(String(t)) });
        ok('dawn-dusk：新宿主走 addVolatile（不直接改 messages）',
            volatile.length === 1 && msgs[0].content === '今天好累', JSON.stringify({ volatile, content: msgs[0].content }));

        const msgs2 = [{ role: 'user', content: '今天好累' }];
        await p.onLLMRequest({ messages: msgs2 });
        ok('dawn-dusk：旧宿主兜底也追加在末尾（不以时间行开头）',
            msgs2[0].content.startsWith('今天好累') && msgs2[0].content.includes('发送时间:'),
            msgs2[0].content);
        ok('dawn-dusk：旧宿主兜底不再前插', !msgs2[0].content.startsWith('[发送时间:'));

        const msgs3 = [{ role: 'user', content: [{ type: 'text', text: '今天好累' }] }];
        await p.onLLMRequest({ messages: msgs3 });
        ok('dawn-dusk：数组 content 也追加到末尾',
            msgs3[0].content[0].text.startsWith('今天好累')
            && msgs3[0].content[msgs3[0].content.length - 1].text.includes('发送时间:'),
            JSON.stringify(msgs3[0].content));
    }

    // ══ ② watch-screen：主动评论 / 主动观察过后台花费闸 ══════════════════════
    {
        healthOk();
        const p = new WatchScreen();
        p.context = mkCtx({ background_llm: false });
        p._audioText = () => '';
        p._audioLines = [];
        p._freshArc = () => null;
        global.__petQuiet = false;
        let sends = 0;
        p.context.sendMessage = async () => { sends += 1; return '嗯'; };

        const r1 = await p._commentOn({ text: '桌面' });
        ok('watch-screen：background_llm=false → 不主动评论', r1 === false && sends === 0, 'sends=' + sends);

        p._isReacting = false;
        const r2 = await p._tryReact([{ base64: 'x' }]);
        ok('watch-screen：background_llm=false → 不主动观察发图', r2 === false && sends === 0, 'sends=' + sends);
        ok('watch-screen：被闸拦下的主动观察不留下 _isReacting 卡死', p._isReacting === false);

        healthOk();
        p.context = mkCtx({});
        sends = 0;
        p.context.sendMessage = async () => { sends += 1; return '嗯'; };
        await p._tryReact([{ base64: 'x' }]);
        ok('watch-screen：闸放开 → 主动观察发 1 次', sends === 1, 'sends=' + sends);

        // 多模态摘要：本地档失败后才轮到云端 client，这一步也必须过闸
        const p2 = new WatchScreen();
        p2.context = mkCtx({ background_llm: false });
        p2._organConfig = { summaryMaxChars: 40, visionBudgetPerHour: 90 };
        p2._budgetHour = Math.floor(Date.now() / 3600000);
        p2._budgetUsed = 0;
        p2._visionTierCfg = () => null;
        p2._resolveVisionClient = () => ({ chatCompletion: async () => ({ content: '不该被调用' }) });
        p2._summarizeViaTier = async () => null;
        p2._buildContactSheet = async () => null;
        p2._shrinkFrame = async () => 'x';
        let sumErr = null;
        try { await p2._summarizeFrame({ base64: 'x' }); } catch (e) { sumErr = e; }
        ok('watch-screen：background_llm=false → 云端多模态摘要跳过',
            !!sumErr && /后台 LLM 已暂停/.test(sumErr.message), sumErr && sumErr.message);
    }

    // ══ ② watch-screen：onStop 摘掉陪玩补丁（热重载不残留）════════════════════
    {
        healthOk();
        const realCtx = new PC.PluginContext('watch-stop-probe', {}, null);
        realCtx.log = () => {};
        const p = new WatchScreen();
        p.context = realCtx;
        realCtx.addSystemPromptPatch('watch-screen-game', 'GAME-PATCH');
        realCtx.addSystemPromptPatch('watch-screen-cowatch', 'CW-PATCH');
        await p.onStop();
        ok('watch-screen：onStop 摘掉 watch-screen-game（旧代码漏删）',
            !realCtx._systemPromptPatches.get('watch-screen-game'));
        ok('watch-screen：onStop 同时摘掉 cowatch', !realCtx._systemPromptPatches.get('watch-screen-cowatch'));
    }

    // ══ ① watch-screen：视觉 provider 点名解析不到时不回退云端 ════════════════
    {
        healthOk();
        llmProviderManager.init({
            llm: { provider_id: 'main' },
            llm_providers: [{
                id: 'main', name: '云端主模型', enabled: true,
                api_url: 'https://cloud.example.com/v1', api_key: 'k',
                models: [{ model_id: 'main-model' }],
            }],
        });
        const p = new WatchScreen();
        const ctx = mkCtx({});
        ctx.getConfig = () => ({ vision: { provider_id: 'vision-missing' } });   // 只点名、不存在
        p.context = ctx;
        p._visionResolved = false;
        p._visionClient = null;
        const client = p._resolveVisionClient();
        ok('watch-screen：vision.provider_id 不存在 → 不生成云端 client', client === null, String(client));
        ok('watch-screen：不回退云端时有 warn 留痕',
            ctx.logs.some((l) => /不回退/.test(l)), ctx.logs.join(' | ').slice(0, 160));
    }

    // ══ ② dispatch：任务回执也吃后台花费闸 ═══════════════════════════════════
    {
        healthOk();
        const p = new Dispatch();
        p._autoReceipt = true;
        p._tasks = new Map([['t1', {
            id: 't1', state: 'done', outcome: 'done_verified',
            verify: { verdict: 'pass' }, text: '结果', tookMs: 1000, error: '',
        }]]);
        global.__petQuiet = false;
        let sends = 0;
        p.context = mkCtx({ background_llm: false });
        p.context.sendMessage = async () => { sends += 1; return '好'; };
        await p._receipt('t1');
        ok('dispatch：background_llm=false → 不发任务回执', sends === 0, 'sends=' + sends);

        healthOk();
        p.context = mkCtx({});
        p.context.sendMessage = async () => { sends += 1; return '好'; };
        await p._receipt('t1');
        ok('dispatch：闸放开 → 回执 1 次', sends === 1, 'sends=' + sends);
    }

    // ══ ② ai-log：日记调用走 ensureCanRun ════════════════════════════════════
    {
        healthOk();
        const p = new AiLog();
        p.context = mkCtx({ background_llm: false });
        let calls = 0;
        p.context.callLLM = async () => { calls += 1; return '日记'; };
        let err = null;
        try { await p._callAPI('系统', '内容'); } catch (e) { err = e; }
        ok('ai-log：background_llm=false → BG_LLM_PAUSED 且零请求',
            !!err && err.code === 'BG_LLM_PAUSED' && calls === 0, err && err.code);
    }

    // ══ ② persona-guard / user-profile：闸走 ensureCanRun，且不永久 fail-open ══
    {
        healthOk();
        const g = new PersonaGuard();
        g.context = mkCtx({ background_llm: false });
        ok('persona-guard：background_llm=false → 判官不跑', (await g._backgroundAllowed()) === false);
        g.context = mkCtx({});
        ok('persona-guard：闸放开 → 判官可跑', (await g._backgroundAllowed()) === true);

        const u = new UserProfile();
        u.context = mkCtx({ background_llm: false });
        ok('user-profile：background_llm=false → 画像不跑', (await u._backgroundAllowed()) === false);
        u.context = mkCtx({});
        ok('user-profile：闸放开 → 画像可跑', (await u._backgroundAllowed()) === true);
        // 单测注入缝仍然可用（老测试用它固定 reason），但生产路径已无 _bgGate
        u._bgGate = { canRun: () => ({ ok: false, reason: 'quota_exhausted', retryAt: 1 }) };
        ok('user-profile：注入的 {canRun} 注入缝仍按 ok:false 拒绝', (await u._backgroundAllowed()) === false);
    }

    // ══ ③ mind-kernel：闸放开后补生成计划有并发上限（防 429 突发）════════════
    {
        healthOk();
        const p = new MindKernel();
        p.context = mkCtx({});
        p._enabled = true;
        p._planGenerate = true;
        p._planBusy = new Set();
        p._goals = ['g1', 'g2', 'g3', 'g4', 'g5'].map((id) => ({ id, status: 'active', planPending: { attempts: 0 } }));
        const started = [];
        p.generatePlan = (id) => { started.push(id); return new Promise(() => {}); };
        const out = p._retryPendingPlans();
        ok('mind-kernel：一次最多补生成 2 个计划', started.length === 2 && out.length === 2,
            JSON.stringify(started));

        p._planBusy = new Set(['busy-a', 'busy-b']);
        const started2 = [];
        p.generatePlan = (id) => { started2.push(id); return new Promise(() => {}); };
        p._retryPendingPlans();
        ok('mind-kernel：已有 2 个在生成时不再发起新补生成', started2.length === 0, JSON.stringify(started2));
    }

    // ══ ④ 结构事实：插件侧不再自己调 canRun；kind 已铺开 ════════════════════
    {
        const files = findPluginFiles(path.join(LIVE, 'plugins'), []);
        const sources = files.map((f) => ({ file: f, src: fs.readFileSync(f, 'utf8') }));
        const directCanRun = sources.filter((x) => /\bbackgroundLLM\.canRun\s*\(/.test(x.src)
            || /require\([^)]*background-llm\.js[^)]*\)\.canRun\s*\(/.test(x.src));
        ok('插件侧云花费闸不再直接调用 canRun（本地闸 canRunLocal 除外）',
            directCanRun.length === 0, directCanRun.map((x) => path.basename(path.dirname(x.file))).join(', '));

        const kinds = new Set();
        for (const x of sources) {
            for (const m of x.src.matchAll(/ensureCanRun\([\s\S]{0,160}?kind:\s*'([^']+)'/g)) kinds.add(m[1]);
        }
        const required = ['dynamic-persona', 'mind-kernel', 'companion-health', 'live-dock',
            'ai-log', 'persona-guard', 'user-profile', 'memory-evolve-reflect',
            'alive-state', 'dawn-dusk-line', 'watch-screen', 'dispatch-receipt'];
        const missing = required.filter((k) => !kinds.has(k));
        ok('ensureCanRun 的 kind 覆盖所有后台云路径（≥7 且无缺项）',
            kinds.size >= 7 && missing.length === 0,
            'kinds=' + Array.from(kinds).sort().join(',') + (missing.length ? ' missing=' + missing.join(',') : ''));
    }

    iso.cleanup(TMP);
    console.log('\n  插件契约：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('探针自身异常：', e);
    try { iso.cleanup(TMP); } catch (e2) { /* ignore */ }
    process.exit(1);
});
