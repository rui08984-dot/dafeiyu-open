#!/usr/bin/env node
/**
 * _probe/scenario-eval.cjs —— 场景评测（D9，2026-11-22）
 *
 * 提案原文：5 条脚本化会话（记忆 / 静默 / 抢话 / 预算 / 失败恢复），pass^3；
 * 先手动，稳定后进夜间门禁。
 *
 * 用法：
 *   node _probe/scenario-eval.cjs                 # 默认每条跑 3 次（pass^3）
 *   node _probe/scenario-eval.cjs --runs 5        # 每条跑 5 次
 *   node _probe/scenario-eval.cjs --only=memory,quiet
 *   node _probe/scenario-eval.cjs --json          # 只输出机器可读 JSON
 *
 * 判据：**每条场景 runs 次全过**才算过；全部场景通过才 exit 0。
 * 输出：每条耗时 + `PASS n / FAIL n` + 一行 `SCENARIO_EVAL_JSON={...}`（机器可读）。
 *
 * 不真调 LLM / TTS：
 *   · 记忆：临时目录注入一条独有 fact → memory-recall 的 recall 工具检索 →
 *           fake callLLM 把检索结果拼成回复（不调模型）
 *   · 静默：SpeechCoordinator(isQuiet=true) 拒 + fake TTS 计数 0 + 预算未起账
 *   · 抢话：真实 ASRProcessor.handleSpeech() + speech_activity 心跳 → 260ms 判定 → interrupt
 *   · 预算：SpeechBudget daily_limit=1（临时文件）→ 第二次拒且 used 仍为 1
 *   · 失败恢复：toolExecutor.executeToolCalls 里工具抛错 → 回合不崩、turn.end 收轮、
 *           下一轮正常返回
 *
 * 数据隔离：PET_DATA_ROOT / PET_JOURNAL_DIR / PET_TELEMETRY_DIR 全部指向 mkdtemp，
 * 不写真实 data、.runtime（A2 口径）。不启新进程/端口/依赖。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

// ── 参数（必须在 require 业务模块之前处理完 env）────────────────────────
const argv = process.argv.slice(2);
function argValue(name, def) {
    const i = argv.indexOf(name);
    if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(name + '='));
    return eq ? eq.slice(name.length + 1) : def;
}
const RUNS = Math.max(1, Number(argValue('--runs', 3)) || 3);
const ONLY_RAW = String(argValue('--only', '') || '').trim();
const ONLY = ONLY_RAW ? ONLY_RAW.split(',').map((s) => s.trim()).filter(Boolean) : null;
const JSON_ONLY = argv.includes('--json');

const tmpRoot = iso.setUpTempDataRoot('pet-scenario-');
process.env.PET_JOURNAL_DIR = path.join(tmpRoot, 'journal');
process.env.PET_TELEMETRY_DIR = path.join(tmpRoot, 'telemetry');
process.env.PET_RUNTIME_LOG = '0';

const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) { if (!JSON_ONLY) console.log(...args); }
function logErr(...args) { if (!JSON_ONLY) console.error(...args); }

function fail(msg, extra) {
    const e = new Error(msg);
    if (extra) e.extra = extra;
    return e;
}

// ── 场景 ① 记忆：独有 fact → 问 → 回复含关键片段 ─────────────────────────
async function scenarioMemory(ctx) {
    const { recordFile } = require(path.join(LIVE, 'js', 'core', 'records-path.js'));
    const factsFile = recordFile('用户事实.json');
    try { fs.unlinkSync(factsFile); } catch (e) { /* 首次运行没有文件 */ }

    const userFacts = require(path.join(LIVE, 'js', 'core', 'user-facts.js'));
    iso.assertIsolated(factsFile);   // 证明没有写到真实 data
    const token = 'zxq' + Math.random().toString(36).slice(2, 8);
    const fact = '我家的乌龟叫' + token;
    const added = userFacts.addFact({ text: fact, source: 'manual' });
    if (!added.ok) throw fail('注入事实失败：' + JSON.stringify(added));

    const MemoryRecall = require(path.join(LIVE, 'plugins', 'community', 'memory-recall', 'index.js'));
    const patches = new Map();
    const fakeContext = {
        getPluginFileConfig: () => ({
            hybrid_enabled: false,      // 不碰 8090 嵌入服务
            auto_inject: true,
            auto_inject_limit: 3,
            rebuild_seconds: 3600,
        }),
        addSystemPromptPatch: (id, text) => { patches.set(id, text); },
        removeSystemPromptPatch: (id) => { patches.delete(id); },
        log: () => {},
    };
    const plugin = new MemoryRecall({ name: 'memory-recall' }, fakeContext);
    await plugin.onInit();
    await plugin.onStart();
    try {
        const question = '你还记得我刚才说我家那只叫' + token + '的乌龟吗';

        // fake callLLM：把 recall 当工具用，再“生成”回复（不真调模型）
        const fakeCallLLM = async () => {
            const raw = await plugin.executeTool('recall', { action: 'search', query: question, limit: 5 });
            const parsed = JSON.parse(raw);
            const hit = (parsed.items || [])[0];
            if (!hit) return { text: '不记得了', found: 0 };
            return { text: '记得啊，你说过：' + hit.text, found: Number(parsed.found) || 0 };
        };

        const reply = await fakeCallLLM(question);
        const ok = reply.found >= 1
            && String(reply.text).includes(token)
            && String(reply.text).includes('乌龟');
        return {
            ok,
            detail: {
                question,
                fact,
                docs: plugin.debugState().docs,
                found: reply.found,
                reply: String(reply.text).slice(0, 80),
            },
        };
    } finally {
        try { await plugin.onStop(); } catch (e) { /* 清理失败不影响结论 */ }
    }
}

// ── 场景 ② 静默：quiet=true 时主动开口被拒且无 TTS ───────────────────────
async function scenarioQuiet() {
    const { recordFile } = require(path.join(LIVE, 'js', 'core', 'records-path.js'));
    const { SpeechCoordinator } = require(path.join(LIVE, 'js', 'core', 'speech-coordinator.js'));
    const budgetLog = recordFile('主动日志.json');
    try { fs.unlinkSync(budgetLog); } catch (e) { /* 首次运行没有 */ }

    const coordinator = new SpeechCoordinator({ isQuiet: () => true, isBusy: () => false });
    let ttsCalls = 0;
    const gate = coordinator.request('scenario-eval', { priority: 'proactive' });
    if (gate.allowed) ttsCalls += 1;   // fake TTS：只有放行才会“说”

    const per = coordinator.stats().perPlugin['scenario-eval'] || {};
    const budgetUntouched = !fs.existsSync(budgetLog);   // 静默闸在预算之前返回
    const ok = gate.allowed === false
        && /静默/.test(String(gate.reason || ''))
        && ttsCalls === 0
        && Number(per.denied) === 1
        && budgetUntouched;
    return {
        ok,
        detail: {
            allowed: gate.allowed,
            reason: String(gate.reason || ''),
            ttsCalls,
            denied: Number(per.denied) || 0,
            budgetUntouched,
        },
    };
}

// ── 场景 ③ 抢话：她在说，用户开口 → 260ms 判定 → interrupt ────────────────
async function scenarioInterrupt() {
    const { ASRProcessor } = require(path.join(LIVE, 'js', 'voice', 'asr-processor.js'));
    const { eventBus } = require(path.join(LIVE, 'js', 'core', 'event-bus.js'));
    const { Events } = require(path.join(LIVE, 'js', 'core', 'events.js'));

    const prevWindow = Object.prototype.hasOwnProperty.call(global, 'window') ? global.window : undefined;
    global.window = { __voiceLat: {} };

    let interrupts = 0;
    const proc = Object.create(ASRProcessor.prototype);
    Object.assign(proc, {
        config: {},
        voiceBargeInEnabled: true,
        pttModeEnabled: false,
        isRecording: false,
        _speechSessionId: 0,
        _bargeCheckActive: false,
        _bargeCandidate: false,
        _bargeTimer: null,
        _suppressUtterance: false,
        _suppressedAffirmations: 0,
        hasInterruptedThisSession: false,
        asrLocked: false,
        continuousBuffer: [],
        recordingStartIndex: 0,
        lastSpeechTime: Date.now(),
        _lastVoicedAt: Date.now(),
        _vadSpeechEndedAt: null,
        silenceTimeout: null,
        onVadSpeechStart: null,
        ttsProcessor: { interrupt: () => { interrupts += 1; } },
    });

    try {
        // 抢话路径自己会打「检测到用户语音 / 执行打断」——评测输出要干净（--json 尤其）。
        const origLog = console.log;
        const origErr = console.error;
        console.log = () => {};
        console.error = () => {};
        try {
            eventBus.emit(Events.TTS_START);   // 她正在说话（走现有公开事件，appState 自己置位）
            proc.handleSpeech();               // VAD is_speech:true → 进入 260ms 抢话判定
            // speech_activity 心跳（真实 ws.onmessage 每 200ms 一次）：持续刷新「最后一帧人声」，
            // 直到 260ms 判定到点。循环而不是固定 sleep，避免机器负载高时误判成「附和」。
            let waited = 0;
            while (interrupts === 0 && waited < 1200) {
                proc.lastSpeechTime = Date.now();
                proc._lastVoicedAt = Date.now();
                await sleep(80);
                waited += 80;
            }
        } finally {
            console.log = origLog;
            console.error = origErr;
        }

        const voiceLat = global.window.__voiceLat || {};
        const ok = interrupts > 0
            && Number(voiceLat.interrupts) > 0
            && proc.hasInterruptedThisSession === true
            && proc._suppressedAffirmations === 0;
        return {
            ok,
            detail: {
                interrupts,
                voiceLatInterrupts: Number(voiceLat.interrupts) || 0,
                hasInterruptedThisSession: proc.hasInterruptedThisSession === true,
                suppressedAffirmations: proc._suppressedAffirmations,
            },
        };
    } finally {
        if (proc._bargeTimer) { clearTimeout(proc._bargeTimer); proc._bargeTimer = null; }
        eventBus.emit(Events.TTS_END);     // 还原 appState，避免污染后续场景
        if (prevWindow === undefined) delete global.window;
        else global.window = prevWindow;
    }
}

// ── 场景 ④ 预算：daily_limit=1 → 第二次拒且计数正确 ──────────────────────
async function scenarioBudget(ctx) {
    const { SpeechBudget } = require(path.join(LIVE, 'js', 'core', 'speech-budget.js'));
    fs.mkdirSync(ctx.runDir, { recursive: true });
    const cfgFile = path.join(ctx.runDir, 'budget-cfg.json');
    const logFile = path.join(ctx.runDir, 'budget-log.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ enabled: true, daily_limit: 1 }), 'utf8');

    const noon = new Date(2026, 0, 1, 12, 0, 0).getTime();   // 白天：成本固定为 1
    const budget = new SpeechBudget({
        logFile,
        cfgFile,
        now: () => noon,
        adaptive: false,                                      // 不让历史数据改价
    });
    try {
        const first = budget.request('scenario', { state: '' });
        const second = budget.request('scenario', { state: '' });
        const stats = budget.stats();
        const ok = first.allowed === true
            && Number(first.used) === 1
            && second.allowed === false
            && Number(second.used) === 1
            && Number(second.limit) === 1
            && Number(stats.used) === 1
            && /预算/.test(String(second.reason || ''));
        return {
            ok,
            detail: {
                firstAllowed: first.allowed,
                firstUsed: first.used,
                secondAllowed: second.allowed,
                secondUsed: second.used,
                limit: second.limit,
                reason: String(second.reason || ''),
                statsUsed: stats.used,
            },
        };
    } finally {
        try { clearInterval(budget._timer); } catch (e) { /* ignore */ }
    }
}

// ── 场景 ⑤ 失败恢复：工具抛错 → 回合不崩、turn.end、下一轮正常 ───────────
async function scenarioFailure(ctx) {
    const { toolExecutor } = require(path.join(LIVE, 'js', 'ai', 'tool-executor.js'));
    const turnCtx = require(path.join(LIVE, 'js', 'core', 'turn-context.js'));
    const telemetryFile = path.join(process.env.PET_TELEMETRY_DIR || '', 'telemetry.jsonl');

    // 清掉可能残留的轮次（只在本进程内，且不会写真实数据）
    try { if (turnCtx.currentTurnId()) turnCtx.endTurn('scenario-reset'); } catch (e) { /* ignore */ }

    const prevPM = global.pluginManager;
    const prevMCP = global.mcpManager;
    const origEndTurn = turnCtx.endTurn;
    const outcomes = [];
    turnCtx.endTurn = function (outcome) {
        outcomes.push(String(outcome || ''));
        return origEndTurn.call(turnCtx, outcome);
    };

    const call = (name) => ({ id: 'c-' + name, type: 'function', function: { name, arguments: '{}' } });
    const origLog = console.log;
    const origErr = console.error;
    let firstErr = null;
    let firstResult;
    let secondErr = null;
    let secondResult;

    try {
        // 第一轮：工具必炸
        global.mcpManager = { isEnabled: false };
        global.pluginManager = {
            executeTool: async () => { throw new Error('scenario-fake-tool-boom'); },
        };
        console.log = () => {};
        console.error = () => {};
        try {
            firstResult = await toolExecutor.executeToolCalls([call('scenario_throw')]);
        } catch (e) {
            firstErr = e;
        }

        // 第二轮：同一个执行器、换一个正常工具，必须还能跑
        global.pluginManager = {
            executeTool: async (name) => (name === 'scenario_ok' ? 'ok' : Promise.reject(new Error('unexpected tool ' + name))),
        };
        try {
            secondResult = await toolExecutor.executeToolCalls([call('scenario_ok')]);
        } catch (e) {
            secondErr = e;
        }
    } finally {
        console.log = origLog;
        console.error = origErr;
        turnCtx.endTurn = origEndTurn;
        if (prevPM === undefined) delete global.pluginManager; else global.pluginManager = prevPM;
        if (prevMCP === undefined) delete global.mcpManager; else global.mcpManager = prevMCP;
    }

    let turnEnds = 0;
    let toolErrors = 0;
    const turnEndOutcomes = [];
    try {
        const raw = fs.readFileSync(telemetryFile, 'utf8');
        for (const line of raw.split('\n')) {
            if (!line) continue;
            try {
                const e = JSON.parse(line);
                if (e && e.type === 'turn.end') {
                    turnEnds += 1;
                    turnEndOutcomes.push(String(e.outcome || ''));
                }
                if (e && e.type === 'tool.error') toolErrors += 1;
            } catch (e) { /* 坏行跳过 */ }
        }
    } catch (e) { /* 没有文件 = 0 */ }

    const ok = firstErr === null
        && firstResult === null
        && outcomes[0] === 'tool-batch'
        && turnEnds >= 1
        && turnEndOutcomes.includes('tool-batch')
        && toolErrors >= 1
        && secondErr === null
        && secondResult === 'ok'
        && outcomes.length >= 2
        && turnCtx.currentTurnId() === '';
    return {
        ok,
        detail: {
            firstThrew: !!firstErr,
            firstResult,
            firstOutcome: outcomes[0] || '',
            turnEnds,
            turnEndOutcomes,
            toolErrors,
            secondThrew: !!secondErr,
            secondResult,
            outcomes,
            currentTurn: turnCtx.currentTurnId(),
        },
    };
}

const SCENARIOS = [
    { id: 'memory', name: '记忆', fn: scenarioMemory },
    { id: 'quiet', name: '静默', fn: scenarioQuiet },
    { id: 'interrupt', name: '抢话', fn: scenarioInterrupt },
    { id: 'budget', name: '预算', fn: scenarioBudget },
    { id: 'failure', name: '失败恢复', fn: scenarioFailure },
];

function selectedScenarios() {
    if (!ONLY) return SCENARIOS;
    const known = new Set(SCENARIOS.map((s) => s.id));
    const bad = ONLY.filter((id) => !known.has(id));
    if (bad.length) {
        logErr('未知场景：' + bad.join(',') + '（可选：' + Array.from(known).join(',') + '）');
        process.exit(2);
    }
    return SCENARIOS.filter((s) => ONLY.includes(s.id));
}

/** pass^k（τ-bench 口径，2026-11-22 调研）：从 n 次里任选 k 次全部通过的概率 = C(c,k)/C(n,k)。
 *  为什么单看 PASS/FAIL 不够：40/40 与 39/40 在 pass^1 上差不多，但 pass^8 会差出一个量级 ——
 *  「偶尔过一次」和「每次都过」是两种能力。组合数逐个乘除，避免阶乘溢出。 */
function passAtK(passed, total, k) {
    const c = Math.max(0, Math.min(Number(passed) || 0, Number(total) || 0));
    const n = Number(total) || 0;
    if (k <= 0) return 1;
    if (k > n || c < k) return 0;
    const comb = (a, r) => { let v = 1; for (let i = 1; i <= r; i += 1) v = (v * (a - r + i)) / i; return v; };
    const denom = comb(n, k);
    return denom ? comb(c, k) / denom : 0;
}

async function main() {
    const list = selectedScenarios();
    log('场景评测（D9 · 先手动）  runs per scenario = ' + RUNS);
    log('数据根：' + tmpRoot);
    log('');

    const results = [];
    let totalPass = 0;
    let totalFail = 0;

    for (const sc of list) {
        const times = [];
        const failures = [];
        let lastDetail = null;
        for (let i = 1; i <= RUNS; i += 1) {
            const runDir = path.join(tmpRoot, 'runs', sc.id + '-' + i);
            const t0 = Date.now();
            let ok = false;
            let detail = null;
            try {
                const r = await sc.fn({ runDir, runIndex: i });
                ok = !!(r && r.ok);
                detail = r && r.detail ? r.detail : null;
            } catch (e) {
                ok = false;
                detail = {
                    error: String((e && e.message) || e),
                    stack: String((e && e.stack) || '').split('\n')[1] || '',
                };
            }
            const ms = Date.now() - t0;
            times.push(ms);
            lastDetail = detail;
            if (ok) totalPass += 1;
            else {
                totalFail += 1;
                failures.push({ run: i, detail });
            }
            log('  ' + (sc.id + '        ').slice(0, 10) + ' run ' + i + '/' + RUNS + ' ' + (ok ? 'PASS' : 'FAIL') + ' ' + ms + 'ms'
                + (ok ? '' : '  ' + JSON.stringify(detail)));
        }
        const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
        results.push({
            id: sc.id,
            name: sc.name,
            runs: RUNS,
            passed: RUNS - failures.length,
            failed: failures.length,
            avg_ms: avg,
            max_ms: Math.max(...times),
            timings: times,
            detail: lastDetail,
            failures,
        });
    }

    log('');
    log('场景             runs  pass  fail  avg_ms  max_ms   pass^1 pass^3 pass^n');
    for (const r of results) {
        const k1 = passAtK(r.passed, r.runs, 1);
        const k3 = passAtK(r.passed, r.runs, Math.min(3, r.runs));
        const kn = passAtK(r.passed, r.runs, r.runs);
        log('  ' + (r.name + '            ').slice(0, 14) + ' ' + String(r.runs).padStart(4)
            + '  ' + String(r.passed).padStart(4) + '  ' + String(r.failed).padStart(4)
            + '  ' + String(r.avg_ms).padStart(6) + '  ' + String(r.max_ms).padStart(6)
            + '   ' + k1.toFixed(2) + '   ' + k3.toFixed(2) + '   ' + kn.toFixed(2));
    }
    log('');
    log('PASS ' + totalPass + ' / FAIL ' + totalFail);

    // pass^k（τ-bench 口径，2026-11-22 调研）：从 n 次里任选 k 次全部通过的概率 = C(c,k)/C(n,k)。
    // 单看「PASS 40/40」会把「偶尔过一次」和「每次都过」混为一谈；pass^n 才是稳定性。
    const kOverall = {};
    for (const k of [1, Math.min(3, RUNS), RUNS]) {
        const per = results.map((r) => passAtK(r.passed, r.runs, k));
        kOverall['pass^' + k] = per.length ? Math.min(...per) : 0;
    }
    log('稳定性（取各场景最差）：' + Object.entries(kOverall).map(([k2, v]) => k2 + '=' + v.toFixed(2)).join('  '));
    if (RUNS < 8) log('  （提示：pass^8 需要 --runs 8；当前 n=' + RUNS + '，pass^n 即 pass^' + RUNS + '）');

    const ok = totalFail === 0 && totalPass > 0;
    const summary = {
        ok,
        runs_per_scenario: RUNS,
        total_runs: totalPass + totalFail,
        passed: totalPass,
        failed: totalFail,
        pass_at_k: kOverall,
        scenarios: results,
        data_root: tmpRoot,
        at: new Date().toISOString(),
    };
    // 机器可读：单独一行，方便 check-all/夜间门禁 grep 或 JSON.parse
    console.log('SCENARIO_EVAL_JSON=' + JSON.stringify(summary));

    iso.cleanup(tmpRoot);
    process.exit(ok ? 0 : 1);
}

main().catch((e) => {
    logErr('场景评测异常：' + ((e && e.stack) || e));
    console.log('SCENARIO_EVAL_JSON=' + JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    iso.cleanup(tmpRoot);
    process.exit(1);
});
