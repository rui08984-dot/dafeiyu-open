#!/usr/bin/env node
/**
 * _probe/test-anchor-freshness.cjs —— 世界锚点保鲜（P0-4 / P1-8 / P1-9，2026-11-22）
 *
 * 要钉住的三个回归：
 *   ① world-sense 暂停/隐私后 activity **永久冻结**：world-store 必须按
 *      activityAt + 采样周期把过期活动降级成 unknown/stale，消费方不得再把
 *      冻结的 gaming/watching 当当前情境。
 *   ② daily-report 自带第二份 8/12 常量，会把用户拍板的 20 砍成 10：
 *      当前额度必须来自运行中的 speech-budget 单例，调整上下限不得低于当前值一半。
 *   ③ companion-health 用 UTC 切天（北京时间 0–8 点会算到昨天），且文案把
 *      「只统计用户输入」说成「陪伴」：必须本地日切 + 口径写明。
 *
 * 纯离线：PET_DATA_ROOT + mkdtemp，不启动宿主、不碰网络、不写真实数据。
 * 用法：node _probe/test-anchor-freshness.cjs
 */

'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

// 顺序：先隔离数据根，再 require 业务模块（records-path 在 require 时读 PET_DATA_ROOT）
const tmpRoot = iso.setUpTempDataRoot('pet-anchor-');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const { recordFile } = require(path.join(APP, 'js', 'core', 'records-path.js'));
const WS = require(path.join(APP, 'js', 'core', 'world-store.js'));
const SB = require(path.join(APP, 'js', 'core', 'speech-budget.js'));
const Q = require(path.join(APP, 'js', 'core', 'intent-queue.js'));
const DR = require(path.join(APP, 'js', 'core', 'daily-report.js'));
const CH = require(path.join(APP, 'plugins', 'community', 'companion-health', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}
function eq(name, got, want) {
    const a = JSON.stringify(got);
    const b = JSON.stringify(want);
    ok(name, a === b, 'got ' + a + ' want ' + b);
}

const cleanups = [];
try {
    // ── ① world-store：activityAt + 两倍采样周期降级 ────────────────────
    {
        let T = 100000;
        const store = WS.createWorldStore({ now: () => T, priors: null, sampleIntervalMs: 1000 });

        store.apply({
            fg: { ok: true, app: 'code', title: 'world-store.js', fullscreen: false },
            idleMs: 1000,
        }, { source: 'system' });

        let s = store.snapshot();
        eq('新鲜活动照常返回（working）', s.activity, 'working');
        eq('activityAt 记录本拍时刻', s.activityAt, T);
        eq('新鲜活动不带 stale', s.activityStale, false);
        ok('stale.activity 也是 false', s.stale && s.stale.activity === false, JSON.stringify(s.stale));

        // 1s 采样：正好 2 个周期内仍然新鲜
        T += 2000;
        s = store.snapshot();
        eq('恰好两个采样周期内仍算新鲜', s.activity, 'working');

        // 超过 2× 采样周期没有更新 → 降级 unknown/stale，但保留原值供诊断
        T += 1;
        s = store.snapshot();
        eq('超过 2× 采样周期 → activity=unknown', s.activity, 'unknown');
        eq('超过 2× 采样周期 → activityStale=true', s.activityStale, true);
        eq('原值保存在 activityLast', s.activityLast, 'working');
        ok('stale.activity 同步为 true', s.stale && s.stale.activity === true, JSON.stringify(s.stale));

        // 恢复采样 → 立刻回到新鲜状态
        store.apply({
            fg: { ok: true, app: 'code', title: 'world-store.js', fullscreen: false },
            idleMs: 1000,
        }, { source: 'system' });
        s = store.snapshot();
        eq('恢复采样后活动重新新鲜', s.activity, 'working');
        eq('恢复采样后 activityStale=false', s.activityStale, false);
        eq('恢复采样后 activityAt 跟着更新', s.activityAt, T);
    }

    // 不传采样间隔 → 兜底 30s（老调用方/单测不传也不能立刻判 stale）
    {
        let T = 200000;
        const store = WS.createWorldStore({ now: () => T, priors: null });
        store.apply({ fg: { ok: true, app: 'code', title: 'x', fullscreen: false }, idleMs: 1000 }, { source: 'system' });
        T += 29000;
        eq('缺省采样周期下 29s 仍新鲜', store.snapshot().activity, 'working');
        T += 2000;
        eq('缺省采样周期下 31s 变 unknown', store.snapshot().activity, 'unknown');
        eq('缺省采样周期下 31s 带 stale', store.snapshot().activityStale, true);
    }

    // 边界：注入时钟从 0 开始时，activityAt=0 是合法时刻，不能当「从未采样」
    {
        let T = 0;
        const store = WS.createWorldStore({ now: () => T, priors: null, sampleIntervalMs: 1000 });
        store.apply({ fg: { ok: true, app: 'code', title: 'x', fullscreen: false }, idleMs: 1000 }, { source: 'system' });
        eq('时钟从 0 开始也能判定新鲜', store.snapshot().activity, 'working');
        eq('activityAt=0 不被误判为从未采样', store.snapshot().activityStale, false);
    }

    // ── ② speech-budget：stale activity 不得再当 gaming/watching ────────
    {
        const noon = new Date(2026, 10, 22, 12, 0, 0).getTime();
        const budgetDir = path.join(tmpRoot, 'budget');
        fs.mkdirSync(budgetDir, { recursive: true });
        const budget = new SB.SpeechBudget({
            logFile: path.join(budgetDir, '主动日志.json'),
            cfgFile: path.join(budgetDir, '主动预算.json'),
            now: () => noon,
        });
        cleanups.push(() => { try { clearInterval(budget._timer); } catch (e) { /* ignore */ } });

        globalThis.__worldSenseState = () => ({ ok: true, activity: { state: 'gaming', stale: false } });
        eq('新鲜 gaming → 游戏成本 +2', budget.costOf({}), 3);

        globalThis.__worldSenseState = () => ({ ok: true, activity: { state: 'gaming', stale: true } });
        eq('stale gaming 不再加价（当无状态）', budget.costOf({}), 1);

        globalThis.__worldSenseState = () => ({ ok: false, activity: { state: 'gaming' } });
        eq('ok=false 时同样当无状态', budget.costOf({}), 1);

        globalThis.__worldSenseState = () => ({ ok: true, activity: { state: 'watching', stale: true } });
        eq('stale watching 也不加价', budget.costOf({}), 1);

        delete globalThis.__worldSenseState;
    }

    // ── ③ intent-queue：stale 指纹不参与匹配 ────────────────────────────
    {
        const cfgFile = recordFile(Q.CONFIG_FILE);
        fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
        fs.writeFileSync(cfgFile, JSON.stringify({ enabled: true }), 'utf8');

        let world = { ok: true, activity: { state: 'working', stale: false }, world: { app: 'code', title: 'doc' } };
        globalThis.__worldSenseState = () => world;
        const q = Q.createIntentQueue({
            now: () => 300000,
            configFile: cfgFile,
            configCacheMs: 0,
            contextProvider: Q.readWorldContext,
        });
        q.defer({ text: '写文档时的补说' });
        ok('新鲜情境指纹写入', q.peek()[0].fp.key === 'working|code|doc', JSON.stringify(q.peek()[0].fp));

        world = { ok: true, activity: { state: 'gaming', stale: true }, world: { app: 'game.exe', title: 'Boss' } };
        ok('readWorldContext 遇 stale → null', Q.readWorldContext() === null, JSON.stringify(Q.readWorldContext()));
        eq('stale 快照的指纹为空（不参与拦截）',
            Q.fingerprintOf(world).key, '');
        ok('stale 时不按冻结指纹判「情境不符」（补说仍可取出）',
            !!q.take(), JSON.stringify(q.stats()));

        world = { ok: false, activity: { state: 'gaming' }, world: { app: 'game.exe', title: 'Boss' } };
        ok('ok=false 也当无状态（readWorldContext=null）', Q.readWorldContext() === null);
        eq('ok=false 的原始快照指纹也为空', Q.fingerprintOf(world).key, '');

        delete globalThis.__worldSenseState;
    }

    // ── ④ daily-report：额度唯一真源 + 调整不腰斩 ──────────────────────
    {
        const NOW = new Date(2026, 10, 22, 15, 0, 0).getTime();
        const START = new Date(2026, 10, 22, 0, 0, 0).getTime();
        const day = DR.dayKey(NOW);
        fs.mkdirSync(path.dirname(recordFile('主动日志.json')), { recursive: true });

        // 日志里有 5 条今日判定、全 ignored（触发降额度建议）
        const attempts = [0, 1, 2, 3, 4].map((i) => ({
            id: 'i' + i, at: START + 3600000 * (i + 1), plugin: 'probe', cost: 1, outcome: 'ignored',
        }));
        fs.writeFileSync(recordFile('主动日志.json'),
            JSON.stringify({ day, used: 0, attempts }), 'utf8');
        // 故意在盘上写 8：运行中的 speech-budget 单例（默认 20）才是当前值。
        // 旧实现会读这个 8 并把 20 砍到 10——正是本任务要防的。
        fs.writeFileSync(recordFile('主动预算.json'),
            JSON.stringify({ daily_limit: 8 }), 'utf8');

        // 先造运行中的单例（没有配置文件 → 默认 20）
        const runningCfg = path.join(tmpRoot, 'running-budget.json');
        const runningLog = path.join(tmpRoot, 'running-log.json');
        const running = SB.singleton({ logFile: runningLog, cfgFile: runningCfg, now: () => NOW });
        cleanups.push(() => { try { clearInterval(running._timer); } catch (e) { /* ignore */ } });
        eq('运行中单例的额度是 20（默认）', running.stats().limit, 20);

        const r = DR.build({
            now: NOW,
            runtimeRoot: path.join(tmpRoot, 'no-runtime'),
        });
        ok('成绩单展示当前运行额度 20（不是盘上的 8）',
            /预算 0\/20/.test(r.text), r.text);
        eq('speech_limit 来源值 = 20', r.sources.speech_limit.value, 20);

        const adj = (r.adjustments || [])[0] || {};
        eq('给出降额度建议', adj.key, 'speech.daily_limit');
        ok('建议目标值不低于当前额度的一半（20 → ≥10）',
            adj.to >= Math.ceil(20 / 2), JSON.stringify(adj));
        eq('20 的建议只降一档（18），不会被旧上限 12 砍成 10', adj.to, 18);
        eq('建议的 from 是当前运行值 20', adj.from, 20);
    }

    // ── ⑤ companion-health：本地日切 + 口径 ────────────────────────────
    {
        const ch = Object.create(CH.prototype);
        // 固定本地时间：2025-03-04 00:30（UTC+8 下 UTC 还是 03-03；旧实现按 UTC 会切错）
        const early = new Date(2025, 2, 4, 0, 30, 0).getTime();
        eq('本地日切：00:30 仍算 2025-03-04', ch._today(early), '2025-03-04');
        const late = new Date(2025, 2, 4, 23, 30, 0).getTime();
        eq('本地日切：23:30 仍算 2025-03-04', ch._today(late), '2025-03-04');
        const padded = new Date(2026, 0, 5, 12, 0, 0).getTime();
        eq('本地日切：月/日补零（2026-01-05）', ch._today(padded), '2026-01-05');

        const src = fs.readFileSync(
            path.join(APP, 'plugins', 'community', 'companion-health', 'index.js'), 'utf8');
        ok('文案写明只统计用户输入（不再笼统说「陪了他」）',
            /用户输入/.test(src) && !/陪了他/.test(src), 'grep 用户输入 / 陪了他');
    }

    // ── ⑥ 生产端接线：world-sense 必须把 stale 暴露给消费方 ──────────────
    {
        const wsSrc = fs.readFileSync(
            path.join(APP, 'plugins', 'community', 'world-sense', 'index.js'), 'utf8');
        ok('world-sense 把 activityStale/暂停态映射成 activity.stale',
            /stale:\s*snap\.activityStale === true \|\| !(?:this\._active\(\)|active)/.test(wsSrc),
            'state().activity.stale');
        ok('world-sense 把采样周期交给 store（2× 保鲜）',
            /sampleIntervalMs:\s*SAMPLE_INTERVAL_MS/.test(wsSrc),
            'createWorldStore({ sampleIntervalMs })');

        // 行为面：隐私模式必须「立即」stale，不等 2s 保鲜期（!ok 子句）
        // 先确保 speech-budget 单例存在且指向临时目录（state().proactive 会读它，
        // 不能在探测里凭空拉一个读真实 data 的单例）。
        if (!SB.peekSingleton()) {
            const dir = path.join(tmpRoot, 'ws-budget');
            fs.mkdirSync(dir, { recursive: true });
            const inst = SB.singleton({
                logFile: path.join(dir, '主动日志.json'),
                cfgFile: path.join(dir, '主动预算.json'),
                now: () => 500000,
            });
            cleanups.push(() => { try { clearInterval(inst._timer); } catch (e) { /* ignore */ } });
        }
        const WSP = require(path.join(APP, 'plugins', 'community', 'world-sense', 'index.js'));
        const fixedT = 500000;
        const plugin = Object.create(WSP.prototype);
        let privacy = true;
        plugin.context = {
            getConfig: () => ({ world_sense: { enabled: true, privacy } }),
            log: () => {},
        };
        plugin._store = WS.createWorldStore({ now: () => fixedT, priors: null, sampleIntervalMs: 1000 });
        plugin._store.apply({
            fg: { ok: true, app: 'game.exe', title: 'Boss', fullscreen: false },
            idleMs: 1000,
            hints: { gaming: true },
        }, { source: 'system' });
        plugin._adapters = { stats: { lastUs: 0 } };
        plugin._stats = {
            turns: 0, injected: 0, lastTokens: 0, lastLine: '', lastFields: [],
            tokensMax: 0, truncatedTurns: 0, lastCacheRate: null, lastPromptTokens: null, cachedTokens: null,
        };
        plugin._sensorStats = {};
        plugin._notificationsFile = '';
        plugin._notifyReader = { stats: {} };
        plugin._browserReader = { stats: {} };
        delete globalThis.__worldSenseConfig;

        const stPrivacy = plugin.state();
        eq('隐私模式立即 ok=false', stPrivacy.ok, false);
        eq('隐私模式立即 activity.stale=true（不等保鲜期）', stPrivacy.activity.stale, true);
        eq('冻结前的值仍在 last 供诊断', stPrivacy.activity.last, 'gaming');

        privacy = false;
        const stActive = plugin.state();
        eq('恢复后 ok=true', stActive.ok, true);
        eq('恢复后 activity.stale=false', stActive.activity.stale, false);
        eq('恢复后活动值回到 gaming', stActive.activity.state, 'gaming');
    }
    // ── ⑦ 下游消费方：memory-evolve / mind-kernel / 屏幕时间线 接 activity.stale ──
    {
        const ME = require(path.join(APP, 'plugins', 'community', 'memory-evolve', 'index.js'));
        const MK = require(path.join(APP, 'plugins', 'community', 'mind-kernel', 'index.js'));
        const WATCH = require(path.join(APP, 'plugins', 'community', 'watch-screen', 'index.js'));
        const me = Object.create(ME.prototype);
        const mk = Object.create(MK.prototype);

        globalThis.__worldSenseState = () => ({ ok: true, activity: { state: 'gaming', stale: false } });
        eq('memory-evolve：新鲜 gaming 照旧', me._worldActivity(), 'gaming');
        eq('mind-kernel：新鲜 gaming 照旧', mk._world().activity, 'gaming');

        globalThis.__worldSenseState = () => ({ ok: true, activity: { state: 'gaming', stale: true } });
        eq('memory-evolve：stale → unknown（不拦反思）', me._worldActivity(), 'unknown');
        eq('mind-kernel：stale → unknown（不拦编排）', mk._world().activity, 'unknown');

        globalThis.__worldSenseState = () => ({ ok: false, activity: { state: 'watching' } });
        eq('memory-evolve：暂停但没显式 stale 也当 unknown', me._worldActivity(), 'unknown');

        // 屏幕时间线：stale 的 activity/app/title 不能落成 7 天的「永久事实」
        const TL = require(path.join(APP, 'js', 'core', 'screen-timeline.js'));
        const fakeWatch = { _logOnce: () => {} };
        globalThis.__worldSenseState = () => ({
            ok: true,
            activity: { state: 'gaming', stale: true },
            world: { app: 'game.exe', title: 'Boss', stale: { app: true, title: true } },
        });
        WATCH.prototype._recordTimeline.call(fakeWatch, { t: Date.now(), text: 'stale 世界下的摘要' });
        let rows = TL.recent({ minutes: 5, limit: 5 });
        let row = rows.find((x) => x.text === 'stale 世界下的摘要');
        ok('屏幕时间线：stale 的 activity/app/title 写空串', !!row &&
            row.activity === '' && row.app === '' && row.title === '', JSON.stringify(row));

        globalThis.__worldSenseState = () => ({
            ok: true,
            activity: { state: 'working', stale: false },
            world: { app: 'code.exe', title: 'x.js', stale: { app: false, title: false } },
        });
        WATCH.prototype._recordTimeline.call(fakeWatch, { t: Date.now(), text: '新鲜世界下的摘要' });
        rows = TL.recent({ minutes: 5, limit: 5 });
        row = rows.find((x) => x.text === '新鲜世界下的摘要');
        ok('屏幕时间线：新鲜世界照旧落 activity/app/title', !!row &&
            row.activity === 'working' && row.app === 'code.exe' && row.title === 'x.js', JSON.stringify(row));

        delete globalThis.__worldSenseState;
    }
} finally {
    delete globalThis.__worldSenseState;
    for (const fn of cleanups) { try { fn(); } catch (e) { /* ignore */ } }
    iso.cleanup(tmpRoot);
}

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
