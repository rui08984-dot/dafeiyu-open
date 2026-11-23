#!/usr/bin/env node
/**
 * _probe/test-intent-queue.cjs —— 待发意图队列（D3，2026-11-22）
 *
 * 要防的回归：
 *   ① 拒绝后直接丢弃（用户睡一觉回来，她十分钟前想说的话永远没了）
 *   ② 补说停不下来（一次取一堆 / 过期了还说 / 换了应用还说）
 *   ③ 队列无界（被拒十次就攒十条，内存和尴尬都涨）
 *   ④ 计数不可查（doctor/探针看不到 deferred/dropped_stale）
 *   ⑤ 关闭开关后仍然偷偷排队
 *   ⑥ 接线断了：拒绝路径不 defer、空闲路径不 take（单测只测模块会漏这个）
 *
 * 数据隔离：PET_DATA_ROOT + mkdtemp；auto-chat 集成用假 voiceChat + 假 gate。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

const tmpRoot = iso.setUpTempDataRoot('pet-intent-');
const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const { recordFile } = require(path.join(APP, 'js', 'core', 'records-path.js'));
const Q = require(path.join(APP, 'js', 'core', 'intent-queue.js'));
const SC = require(path.join(APP, 'js', 'core', 'speech-coordinator.js'));
const { AutoChatModule } = require(path.join(APP, 'js', 'live', 'auto-chat.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const cfgFile = recordFile(Q.CONFIG_FILE);
fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
function setCfg(o) { fs.writeFileSync(cfgFile, JSON.stringify(o), 'utf8'); }
function mk(nowFn, extra) {
    return Q.createIntentQueue(Object.assign({
        now: nowFn,
        configFile: cfgFile,
        configCacheMs: 0,
        contextProvider: () => null,
    }, extra || {}));
}

const TTL = Q.HARD_TTL_MS;
const MAX = Q.HARD_MAX_ITEMS;

(async () => {
    const origRequest = SC.singleton.request;
    const origMark = SC.singleton.markSpoken;
    let auto = null;
    try {
        ok('配置落在临时记录室', iso.assertIsolated(cfgFile) === true, cfgFile);

        // ── ① 基本 defer/take ─────────────────────────────────────────
        setCfg({ enabled: true });
        {
            const q = mk(() => 1000);
            const r = q.defer({ text: '  补说一句  ', intent: 'test' });
            ok('defer 接受并归一空白', r.ok === true && q.stats().size === 1 && q.peek()[0].text === '补说一句',
                JSON.stringify({ r, peek: q.peek() }));
            const it = q.take();
            ok('take 返回文本并删除', !!it && it.text === '补说一句' && q.stats().size === 0 && q.stats().taken === 1,
                JSON.stringify({ it, stats: q.stats() }));
            ok('空文本不入队', q.defer({ text: '   ' }).ok === false && q.stats().size === 0);
        }

        // ── ② TTL 10 分钟 ─────────────────────────────────────────────
        {
            let t = 10000;
            const q = Q.createIntentQueue({ now: () => t, configFile: cfgFile, configCacheMs: 0, contextProvider: () => null });
            q.defer({ text: '十分钟前的意图' });
            t += TTL + 1;
            ok('过期后 take 为 null', q.take() === null);
            ok('过期计入 dropped_stale', q.stats().dropped_stale === 1, JSON.stringify(q.stats()));
        }

        // ── ②b 放回（发送失败）保留原始 at，TTL 不被重置 ─────────────
        {
            let t = 12000;
            const q = Q.createIntentQueue({ now: () => t, configFile: cfgFile, configCacheMs: 0, contextProvider: () => null });
            q.defer({ text: '放回项', at: t - 1000 });
            ok('defer 保留原始 at', q.peek()[0].at === t - 1000, String(q.peek()[0].at));
            const it = q.take();
            t = 13000;
            q.defer({ text: it.text, intent: it.intent, context: it.fp, at: it.at });
            ok('放回后 at 不重置（TTL 从第一次被拒算）', q.peek()[0].at === it.at, String(q.peek()[0].at));
            t = it.at + TTL + 1;
            ok('放回项到期后仍会过期', q.take() === null && q.stats().dropped_stale === 1, JSON.stringify(q.stats()));
            const stale = q.defer({ text: '太旧', at: t - TTL - 1 });
            ok('过旧的 at 直接拒绝', stale.ok === false && stale.reason === 'stale', JSON.stringify(stale));
        }

        // ── ②c 文本格式：保留换行，去重按归一空白 ─────────────────────
        {
            const q = mk(() => 14000);
            q.defer({ text: '第一段\n第二段', intent: 'fmt' });
            ok('保留文本内部换行（prompt 分段不被压平）', q.peek()[0].text === '第一段\n第二段', JSON.stringify(q.peek()[0].text));
            const dup = q.defer({ text: '第一段   第二段', intent: 'fmt' });
            ok('去重按归一空白（换行/多空格视为同一句）', dup.duplicate === true && q.stats().size === 1, JSON.stringify(dup));
        }

        // ── ②d take({now}) 可覆盖实例时钟 ────────────────────────────
        {
            const t = 15000;
            const q = mk(() => t);
            q.defer({ text: 'now 参数' });
            ok('take({now}) 覆盖实例时钟并判过期',
                q.take({ now: t + TTL + 1 }) === null && q.stats().dropped_stale === 1,
                JSON.stringify(q.stats()));
        }

        // ── ③ 容量 5 条，满了丢最旧 ───────────────────────────────────
        {
            const q = mk(() => 20000);
            for (let i = 0; i < MAX + 1; i += 1) q.defer({ text: '第' + i + '条' });
            const s = q.stats();
            ok('容量硬上限 5 条', s.size === MAX, JSON.stringify(s));
            ok('溢出丢最旧并计数', s.dropped_overflow === 1 && q.peek()[0].text === '第1条',
                JSON.stringify({ overflow: s.dropped_overflow, first: q.peek()[0] && q.peek()[0].text }));
        }

        // ── ④ 相同文本去重 ───────────────────────────────────────────
        {
            const q = mk(() => 30000);
            q.defer({ text: '同一句' });
            const dup = q.defer({ text: '同一句' });
            ok('重复文本不占新槽', dup.ok === true && dup.duplicate === true && q.stats().size === 1 && q.stats().deferred === 1,
                JSON.stringify({ dup, stats: q.stats() }));
        }

        // ── ⑤ 情境指纹：对不上不补说、也不丢 ─────────────────────────
        {
            const q = mk(() => 40000);
            q.defer({ text: '游戏里的吐槽', context: { activity: 'gaming', app: 'game.exe', title: 'Boss 战' } });
            ok('指纹记录了 activity/app/title',
                q.peek()[0].fp.activity === 'gaming' && q.peek()[0].fp.app === 'game.exe' && q.peek()[0].fp.title === 'Boss 战',
                JSON.stringify(q.peek()[0].fp));
            ok('换到工作情境取不出', q.take({ context: { activity: 'working', app: 'word.exe', title: '文档' } }) === null);
            ok('情境不符时不丢（留到 TTL）', q.stats().size === 1 && q.stats().dropped_stale === 0, JSON.stringify(q.stats()));
            const got = q.take({ context: { activity: 'gaming', app: 'game.exe', title: 'Boss 战' } });
            ok('同情境可以取出', !!got && got.text === '游戏里的吐槽');
            // 标题轻微变化但互相包含（页面跳转主题没变）也算同一情境
            const q2 = mk(() => 41000);
            q2.defer({ text: '标题软匹配', context: { activity: 'watching', app: 'browser.exe', title: '第 3 集' } });
            ok('标题包含关系算同一情境',
                !!q2.take({ context: { activity: 'watching', app: 'browser.exe', title: '第 3 集 1080p' } }));
        }

        // ── ⑥ 指纹直接读 __worldSenseState ────────────────────────────
        {
            let ws = { activity: { state: 'watching' }, world: { app: 'browser.exe', title: '视频' } };
            globalThis.__worldSenseState = () => ws;
            const q = Q.createIntentQueue({
                now: () => 50000, configFile: cfgFile, configCacheMs: 0, contextProvider: Q.readWorldContext,
            });
            q.defer({ text: '看视频时的评论' });
            ok('指纹来自 __worldSenseState', q.peek()[0].fp.activity === 'watching' && q.peek()[0].fp.app === 'browser.exe',
                JSON.stringify(q.peek()[0].fp));
            ws = { activity: { state: 'working' }, world: { app: 'word.exe', title: '文档' } };
            ok('世界状态变了取不出', q.take() === null);
            ws = { activity: { state: 'watching' }, world: { app: 'browser.exe', title: '视频' } };
            ok('世界状态回到原样可取出', !!q.take());
            globalThis.__worldSenseState = () => { throw new Error('boom'); };
            ok('世界状态读失败不炸（当未知）', Q.readWorldContext() === null);
            delete globalThis.__worldSenseState;
        }

        // ── ⑦ 开关：一键关 ───────────────────────────────────────────
        {
            setCfg({ enabled: false });
            const q = mk(() => 60000);
            const r = q.defer({ text: '不该排队' });
            ok('关闭后 defer 不排队', r.ok === false && r.reason === 'disabled' && q.stats().size === 0 && q.stats().enabled === false,
                JSON.stringify({ r, stats: q.stats() }));
            ok('关闭后 take 为 null', q.take() === null);
            setCfg({ enabled: true });
        }

        // ── ⑦b 坏配置：按默认继续，但 config_error 可查 ──────────────
        {
            fs.writeFileSync(cfgFile, '{ bad json', 'utf8');
            const q = mk(() => 62000);
            const s = q.stats();
            ok('坏配置按默认继续且 config_error 可查',
                s.enabled === true && !!s.config_error && q.defer({ text: '坏配置下仍能排队' }).ok === true,
                JSON.stringify(s));
            setCfg({ enabled: true });
        }

        // ── ⑧ 计数形状 + 一次只取 1 条 + peek 只读 ────────────────────
        {
            const q = mk(() => 70000);
            q.defer({ text: 'A' }); q.defer({ text: 'B' }); q.defer({ text: 'C' });
            const s = q.stats();
            ok('stats 四计数齐全',
                ['deferred', 'dropped_stale', 'dropped_overflow', 'taken'].every((k) => Object.prototype.hasOwnProperty.call(s, k)),
                JSON.stringify(s));
            q.take();
            ok('一次只取 1 条', q.stats().size === 2 && q.stats().taken === 1, JSON.stringify(q.stats()));
            const before = q.peek();
            ok('peek 只读（不减少队列）', before.length === 2 && q.stats().size === 2);
        }

        // ── ⑧b 撤回（U4）：直说成功后删除自己的待补说项 ────────────────
        {
            const q = mk(() => 75000);
            q.defer({ text: '（你正想主动开口，不是他问你。）饿了，想吃点东西', intent: 'alive-state:hungry' });
            q.defer({ text: '（你正想主动开口，不是他问你。）好困，想睡觉', intent: 'alive-state:sleepy' });
            q.defer({ text: '看屏评论：画面里有一辆车', intent: 'watch-screen' });
            const d1 = q.dropByPrefix('（你正想主动开口');
            ok('dropByPrefix 只删匹配前缀的条目（2 条 alive-state，剩 1 条看屏）',
                d1 === 2 && q.stats().size === 1 && q.peek()[0].text.startsWith('看屏评论'),
                JSON.stringify({ d1, size: q.stats().size, left: q.peek().map((x) => x.text) }));
            ok('撤回计入 dropped_withdrawn', q.stats().dropped_withdrawn === 2,
                JSON.stringify(q.stats()));
            const d2 = q.dropByText('看屏评论：画面里有一辆车');
            ok('dropByText 按完整文本删除', d2 === 1 && q.stats().size === 0,
                JSON.stringify({ d2, size: q.stats().size }));
            q.defer({ text: 'KEEP' });
            ok('空前缀不误清空队列', q.dropByPrefix('') === 0 && q.stats().size === 1,
                JSON.stringify(q.stats()));
            q.clear({ resetCounters: true });
            q.defer({ text: '（你正想主动开口，不是他问你。）吃过了', intent: 'alive-state:hungry' });
            q.dropByPrefix('（你正想主动开口');
            ok('撤回后空闲通道 take 不到（不会再被补说）', q.take() === null && q.stats().size === 0,
                JSON.stringify(q.stats()));
        }

        // alive-state 的接线是「直说成功后撤回」；只测模块会漏掉这一行接线。
        {
            const aliveSrc = fs.readFileSync(path.join(APP, 'plugins', 'community', 'alive-state', 'index.js'), 'utf8');
            ok('alive-state 直说成功后撤回同前缀待发项',
                /intentQueue\.dropByPrefix\s*\(\s*INTENT_TEXT_PREFIX/.test(aliveSrc)
                && /text:\s*INTENT_TEXT_PREFIX\s*\+/.test(aliveSrc),
                'dropByPrefix(INTENT_TEXT_PREFIX)');
        }

        // ── ⑨ 全局可观测入口 ─────────────────────────────────────────
        {
            setCfg({ enabled: true });
            const gq = Q.singleton();
            gq.clear({ resetCounters: true });
            gq.defer({ text: '全局探针' });
            ok('window/global __intentQueueStats 可读',
                typeof globalThis.__intentQueueStats === 'function' && globalThis.__intentQueueStats().deferred === 1,
                JSON.stringify(typeof globalThis.__intentQueueStats === 'function' ? globalThis.__intentQueueStats() : null));
            gq.clear({ resetCounters: true });
        }

        // ── ⑩ 接线：拒绝 → defer；空闲 → take 1 条 ────────────────────
        {
            const queue = Q.singleton();
            queue.clear({ resetCounters: true });
            setCfg({ enabled: true });
            global.voiceChat = { sendToLLM: async () => '好' };
            global.__petQuiet = false;
            delete global.__userActivity;
            delete globalThis.__worldSenseState;

            // 拒绝路径：gate 不放行 → 队列 +1，原有让路行为不变
            SC.singleton.request = () => ({ allowed: false, reason: '测试拒绝', budget: null });
            SC.singleton.markSpoken = () => {};
            auto = new AutoChatModule({ prompt: 'BASE', idle_time: 60 }, {}, null);
            auto.isRunning = true;
            await auto.executeChat();
            auto.stop();
            const sDenied = queue.stats();
            ok('拒绝路径写入待发意图', sDenied.deferred === 1 && sDenied.size === 1, JSON.stringify(sDenied));
            auto.isRunning = true;
            ok('被拒队列项文本含自动触发指令', queue.peek()[0].text.includes('[自动触发] BASE'), queue.peek()[0].text.slice(0, 40));

            // 放行路径：优先补说队列项，不生成新的一句
            SC.singleton.request = () => ({ allowed: true, reason: 'ok', attemptId: 't' });
            const captured = [];
            global.voiceChat = { sendToLLM: async (p) => { captured.push(p); return '好的'; } };
            auto.isRunning = true;
            await auto.executeChat();
            auto.stop();
            ok('空闲补说恰好 1 条', captured.length === 1 && captured[0].includes('[自动触发] BASE'), JSON.stringify(captured));
            ok('补说后队列清空且 taken=1', queue.stats().size === 0 && queue.stats().taken === 1, JSON.stringify(queue.stats()));

            // 发送失败：放回队列且保留原始 at（TTL 不被重置）
            queue.clear({ resetCounters: true });
            queue.defer({ text: '发送失败要放回', intent: 'failure-test' });
            const at0 = queue.peek()[0].at;
            global.voiceChat = { sendToLLM: async () => { throw new Error('boom'); } };
            auto.isRunning = true;
            // 这是故意制造的发送失败：吞掉预期内的 error 日志，保持测试输出可读
            const origError = console.error;
            let caughtErrors = 0;
            console.error = () => { caughtErrors += 1; };
            try { await auto.executeChat(); } finally { console.error = origError; }
            auto.stop();
            ok('发送失败放回队列且保留原始 at',
                queue.stats().size === 1 && queue.peek()[0].at === at0 && caughtErrors > 0,
                JSON.stringify({ size: queue.stats().size, at: queue.peek()[0] && queue.peek()[0].at, at0, caughtErrors }));

            // 情境不符：不补说旧话，但仍然正常新说一句（不浪费这次空闲）
            queue.clear({ resetCounters: true });
            queue.defer({
                text: '游戏里的吐槽（不应在写文档时补说）',
                intent: 'watch-screen',
                context: { activity: 'gaming', app: 'game.exe', title: 'Boss 战' },
            });
            globalThis.__worldSenseState = () => ({ activity: { state: 'working' }, world: { app: 'word.exe', title: '文档' } });
            const captured2 = [];
            global.voiceChat = { sendToLLM: async (p) => { captured2.push(p); return '好的'; } };
            auto.isRunning = true;
            await auto.executeChat();
            auto.stop();
            ok('情境不符不补说旧话', captured2.length === 1 && !captured2[0].includes('不应在写文档时补说'),
                JSON.stringify(captured2));
            ok('情境不符时队列项保留', queue.stats().size === 1 && queue.stats().taken === 0, JSON.stringify(queue.stats()));

            // 情境回到原样：下一次空闲补说它
            globalThis.__worldSenseState = () => ({ activity: { state: 'gaming' }, world: { app: 'game.exe', title: 'Boss 战' } });
            const captured3 = [];
            global.voiceChat = { sendToLLM: async (p) => { captured3.push(p); return '好的'; } };
            auto.isRunning = true;
            await auto.executeChat();
            auto.stop();
            ok('情境恢复后补说旧话', captured3.length === 1 && captured3[0].includes('不应在写文档时补说'),
                JSON.stringify(captured3).slice(0, 120));

            queue.clear({ resetCounters: true });
        }

        // ── ⑪ 静态接线守卫（防止后续重构把拒绝点/补说通道删掉）─────────
        {
            const autoSrc = fs.readFileSync(path.join(APP, 'js', 'live', 'auto-chat.js'), 'utf8');
            const aliveSrc = fs.readFileSync(path.join(APP, 'plugins', 'community', 'alive-state', 'index.js'), 'utf8');
            const watchSrc = fs.readFileSync(path.join(APP, 'plugins', 'community', 'watch-screen', 'index.js'), 'utf8');
            const wired = (src, marker) => {
                const i = src.indexOf(marker);
                if (i < 0) return false;
                const j = src.indexOf('intentQueue.defer', i);
                return j > i && (j - i) < 1200;
            };
            ok('auto-chat 闸门路径已修正（../core 而不是 ../../core）',
                autoSrc.includes("require('../core/speech-coordinator.js')")
                && !autoSrc.includes("require('../../core/speech-coordinator.js')"));
            ok('alive-state 拒绝点已接线到 intentQueue.defer', wired(aliveSrc, 'if (!gate.allowed)'));
            ok('watch-screen 拒绝点已接线到 intentQueue.defer', wired(watchSrc, 'if (!scGate.allowed)'));
        }
    } finally {
        SC.singleton.request = origRequest;
        SC.singleton.markSpoken = origMark;
        if (auto) { try { auto.stop(); } catch (e) { /* ignore */ } }
        delete global.voiceChat;
        delete global.__petQuiet;
        delete globalThis.__worldSenseState;
        iso.cleanup(tmpRoot);
    }

    console.log('\nPASS ' + pass + ' / FAIL ' + fail);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    console.log('\nPASS ' + pass + ' / FAIL ' + (fail + 1));
    process.exit(1);
});
