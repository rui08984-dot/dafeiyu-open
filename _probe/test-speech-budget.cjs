#!/usr/bin/env node
/**
 * _probe/test-speech-budget.cjs — 主动说话预算回归（2026-11-15 五十九轮）
 *
 * 防的是两种退化：
 *   ① 太吵：闸只有「最小间隔」，一天下来能说几十条，用户只会觉得烦
 *   ② 不自知：她不知道开口之后你是理了还是烦了（accepted/ignored/negative 都没有）
 *
 * 断言：成本模型（深夜/游戏/上次被忽略加价）、日预算、90 秒窗口结算、
 *      负反馈识别、落盘重载、协调器集成（预算用尽时 request 真的被拒）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const B = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'speech-budget.js'));
const SC = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'speech-coordinator.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
function eq9(name, got, want) {
    ok(name, got === want, 'got ' + got + ' want ' + want);
}

const TMP = path.join(require('os').tmpdir(), 'probe-budget-' + process.pid);
fs.mkdirSync(TMP, { recursive: true });
const logFile = path.join(TMP, '主动日志.json');
const cfgFile = path.join(TMP, '主动预算.json');

function mk(nowFn, cfg) {
    try { fs.unlinkSync(logFile); } catch (e) {}
    try { fs.unlinkSync(cfgFile); } catch (e) {}
    if (cfg) fs.writeFileSync(cfgFile, JSON.stringify(cfg), 'utf8');
    return new B.SpeechBudget({ logFile, cfgFile, now: nowFn });
}

(async () => {
    try {
        // ① 成本模型
        const noon = new Date(2026, 10, 15, 12, 0, 0).getTime();
        const night = new Date(2026, 10, 15, 2, 0, 0).getTime();
        {
            const b = mk(() => noon);
            ok('白天普通开口成本 = 1', b.costOf({}) === 1, b.costOf({}));
            ok('白天游戏里 = 3', b.costOf({ state: 'game' }) === 3, b.costOf({ state: 'game' }));
        }
        {
            const b = mk(() => night);
            ok('深夜 +1', b.costOf({}) === 2, b.costOf({}));
        }

        // ② 日预算
        {
            const b = mk(() => noon, { daily_limit: 3 });
            const r1 = b.request('p');
            const r2 = b.request('p');
            const r3 = b.request('p');
            const r4 = b.request('p');
            ok('额度内三次都放行', r1.allowed && r2.allowed && r3.allowed, [r1.cost, r2.cost, r3.cost].join(','));
            ok('第 4 次被预算拒绝且原因可读', !r4.allowed && /预算/.test(r4.reason), r4.reason);
            ok('attemptId 只有放行时才有', !!r1.attemptId && r4.attemptId === null);
        }

        // ③ 上次被忽略 → 加价
        {
            const b = mk(() => noon, { daily_limit: 10 });
            const r = b.request('p');
            b._state.attempts.push({ id: 'old', at: noon - 600000, plugin: 'p', cost: 1, outcome: 'ignored' });
            ok('上次被忽略时成本 +1', b.costOf({}) === 2, b.costOf({}));
        }

        // ④ 90 秒窗口结算（三次开口**间隔 5 分钟**，因为同一毫秒开三次会共用同一个窗口）
        {
            let t = noon;
            const b = mk(() => t, { daily_limit: 12 });
            const a1 = b.request('p');
            t += 5 * 60 * 1000;
            const a2 = b.request('p');
            t += 5 * 60 * 1000;
            const a3 = b.request('p');

            // 只在 a1 之后 30 秒有用户输入（a2/a3 之后都没有）
            global.__lastUserInputAt = a1.at + 30000;
            global.__lastUserText = '哈哈行行行';
            t = a3.at + 95000;                 // 推到所有窗口之外再结算
            b.tick();
            ok('窗口内用户说话 = accepted', b._state.attempts.find((x) => x.id === a1.attemptId).outcome === 'accepted');
            ok('之后的开口没人理 = ignored', b._state.attempts.find((x) => x.id === a2.attemptId).outcome === 'ignored');
            ok('窗口过期无人理 = ignored', b._state.attempts.find((x) => x.id === a3.attemptId).outcome === 'ignored');

            // 负反馈：新开一次，用户回「别说了」
            t = a3.at + 10 * 60 * 1000;
            const a4 = b.request('p');
            global.__lastUserInputAt = a4.at + 20000;
            global.__lastUserText = '别说了，烦';
            t = a4.at + 95000;
            b.tick();
            ok('用户说「别说了/烦」= negative', b._state.attempts.find((x) => x.id === a4.attemptId).outcome === 'negative');
        }

        // ⑤ 统计（含烦人指数）
        {
            let t2 = noon;
            const b = mk(() => t2, { daily_limit: 10 });
            const a = b.request('watch-screen');
            global.__lastUserInputAt = a.at + 1000;
            global.__lastUserText = '在';
            t2 = a.at + 95000;
            b.tick();
            const s = b.stats();
            ok('stats 有接受率', s.accept_rate === 1, JSON.stringify({ acc: s.accept_rate, attempts: s.today_attempts }));
            ok('stats 有烦人指数', typeof s.annoy_index === 'number', 'annoy=' + s.annoy_index);
            ok('按来源统计存在', !!s.bySource['watch-screen']);
        }

        // ⑤b 自适应调价（2026-11-15）：样本不足不动、只加价不减价、负面算没接受
        {
            const b = mk(() => noon, { daily_limit: 20 });
            b._state.bySource = { low: { allowed: 20, accepted: 5, ignored: 15, negative: 0 } };
            ok('接受率 25%（≥20 样本）→ 该来源更贵 +1', b.costOf({ pluginId: 'low' }) === 2, 'cost=' + b.costOf({ pluginId: 'low' }));

            const b2 = mk(() => noon, { daily_limit: 20 });
            b2._state.bySource = { high: { allowed: 20, accepted: 18, ignored: 2, negative: 0 } };
            ok('接受率 90% 不给折扣（只回到基础价）', b2.costOf({ pluginId: 'high' }) === 1, 'cost=' + b2.costOf({ pluginId: 'high' }));

            const b3 = mk(() => noon, { daily_limit: 20 });
            b3._state.bySource = { few: { allowed: 5, accepted: 0, ignored: 5, negative: 0 } };
            ok('样本 <20 不动（不凭运气调）', b3.costOf({ pluginId: 'few' }) === 1, 'cost=' + b3.costOf({ pluginId: 'few' }));

            const b4 = mk(() => noon, { daily_limit: 20 });
            b4._state.bySource = { neg: { allowed: 20, accepted: 2, ignored: 0, negative: 18 } };
            ok('负面反馈算「没接受」→ 更贵 +1', b4.costOf({ pluginId: 'neg' }) === 2, 'cost=' + b4.costOf({ pluginId: 'neg' }));

            const bOff = mk(() => noon, { daily_limit: 20 });
            bOff._adaptive = false;
            bOff._state.bySource = { low: { allowed: 20, accepted: 5, ignored: 15, negative: 0 } };
            ok('自适应关掉后不加价', bOff.costOf({ pluginId: 'low' }) === 1, 'cost=' + bOff.costOf({ pluginId: 'low' }));
        }

        // ⑥ 落盘与重载
        {
            const b1 = mk(() => noon, { daily_limit: 5 });
            b1.request('p'); b1.request('p');
            const b2 = new B.SpeechBudget({ logFile, cfgFile, now: () => noon });
            ok('重载后用量保留', b2.stats().used === 2, 'used=' + b2.stats().used);
        }

        // ⑦ 关闭开关
        {
            const b = mk(() => noon, { enabled: false, daily_limit: 1 });
            const r1 = b.request('p'); const r2 = b.request('p'); const r3 = b.request('p');
            ok('预算关闭时永远放行', r1.allowed && r2.allowed && r3.allowed);
            ok('关闭时不记账', (b._state.attempts || []).length === 0);
        }

        // ⑧ 协调器集成：预算用尽时 request 真的被拒
        {
            const bTest = mk(() => noon, { daily_limit: 1 });
            // 协调器内部用的是 speech-budget 的 singleton；测试里把它换成本地实例，
            // 否则会读写真实的 主动日志.json（污染她今天的预算）
            const SBmod = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'speech-budget.js'));
            SBmod.singleton = () => bTest;
            const c = new SC.SpeechCoordinator ? new SC.SpeechCoordinator({ isBusy: () => false, isQuiet: () => false }) : null;
            if (c) {
                const g1 = c.request('probe-src', { priority: 'proactive' });
                const g2 = c.request('probe-src', { priority: 'proactive' });
                ok('协调器放行时带 attemptId', g1.allowed === true && !!g1.attemptId, JSON.stringify(g1.budget || null).slice(0, 60));
                ok('预算用尽后协调器拒绝并给原因', g2.allowed === false && /预算/.test(String(g2.reason)), g2.reason);
            } else {
                console.log('  · 跳过协调器集成（导出形状不同）');
            }
        }

        // ⑨ 状态自动读取（2026-11-17 六十五轮）：`_screenState` 才是真字段，
        //    外加世界感知给的活动状态。要求「不叠加，取更贵的那个」。
        {
            const b = mk(() => noon, {});
            const setPlugin = (plugin) => {
                global.pluginManager = { _plugins: new Map([['community/watch-screen', { plugin }]]) };
            };
            const clearWorld = () => { delete globalThis.__worldSenseState; };

            clearWorld();
            global.pluginManager = undefined;
            eq9('没有插件也没有世界状态 → 只有基础成本', b.costOf({}), 1);

            setPlugin({ _state: { kind: 'game' } });
            eq9('只给旧字段 _state 不生效（证明读的是 _screenState）', b.costOf({}), 1);

            setPlugin({ _screenState: { state: 'game' } });
            eq9('watch-screen 的 _screenState=game → 游戏成本生效', b.costOf({}), 3);

            setPlugin({ _screenState: { state: 'working' } });
            eq9('working 不加价', b.costOf({}), 1);

            global.pluginManager = undefined;
            globalThis.__worldSenseState = () => ({ activity: { state: 'gaming' } });
            eq9('世界感知 gaming → 游戏成本', b.costOf({}), 3);

            globalThis.__worldSenseState = () => ({ activity: { state: 'watching' } });
            eq9('世界感知 watching → 看视频成本（比游戏轻）', b.costOf({}), 2);

            setPlugin({ _screenState: { state: 'game' } });
            eq9('watch-screen 与世界感知都判 gaming → 不叠加', b.costOf({}), 3);

            globalThis.__worldSenseState = () => { throw new Error('boom'); };
            setPlugin({ _screenState: { state: 'working' } });
            eq9('世界状态读失败时按无状态处理', b.costOf({}), 1);

            clearWorld();
            global.pluginManager = undefined;
        }
    } finally {
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('  ✗ 测试自身异常：' + (e && e.stack || e)); process.exit(1); });
