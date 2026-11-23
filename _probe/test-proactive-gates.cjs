#!/usr/bin/env node
/**
 * _probe/test-proactive-gates.cjs — 「她会不会主动开口」的闸门回归（2026-11-22）
 *
 * 结论修正（用户 2026-11-22 现场补充）：静默模式（cost.quiet）开着时她完全不主动开口，
 * **这是静默模式按设计工作**，不是链路的 bug。所以本测试**不再**断言「缺省必须不静默」，
 * 只锁住「静默关掉之后，链路本身是通的、有账可查、不会一天说爆」：
 *
 *   ① 活动窗判据：idle/未知放行；active 短间隔复采（原来 4 分钟采样太稀）；away 不说
 *   ② auto-chat 每次 tick 的去向有计数（静默/在忙/离开/让路/真说出口）
 *   ③ 日预算默认 20（2026-11-22 拍板），且「申请」与「真说出口」可区分（noteSpoken）
 *   ④ 协调器的静默闸真的会拒（防 isQuiet 永远没人注入 → 静默形同虚设）
 *
 * 数据隔离（A2）：预算用 mkdtemp 下的临时文件，绝不碰 data。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');

// ⚠ PET_DATA_ROOT 必须在**任何 require 之前**设：records-path.js 在加载时就算好
// RECORDS_DIR（speech-budget / last-contact 都会在 require 时带它进来）。
// 否则 last-contact.noteContact() 会写真实「上次见面.json」——违反「测试不碰真实数据」。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-proactive-'));
process.env.PET_DATA_ROOT = TMP;

const B = require(path.join(LIVE, 'js', 'core', 'speech-budget.js'));
const SC = require(path.join(LIVE, 'js', 'core', 'speech-coordinator.js'));
const AC = require(path.join(LIVE, 'js', 'live', 'auto-chat.js'));
const LC = require(path.join(LIVE, 'js', 'core', 'last-contact.js'));
const RP = require(path.join(LIVE, 'js', 'core', 'records-path.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const logFile = path.join(TMP, '主动日志.json');
const cfgFile = path.join(TMP, '主动预算.json');
function mkBudget(nowFn, cfg) {
    try { fs.unlinkSync(logFile); } catch (e) {}
    try { fs.unlinkSync(cfgFile); } catch (e) {}
    if (cfg) fs.writeFileSync(cfgFile, JSON.stringify(cfg), 'utf8');
    return new B.SpeechBudget({ logFile, cfgFile, now: nowFn || (() => Date.now()) });
}

try {
    // ── ⓪ 产品缺省没被改动（静默缺省=开，是省钱设计，不是 bug）────────────
    const exampleCfg = JSON.parse(fs.readFileSync(path.join(LIVE, 'config.example.json'), 'utf8'));
    ok('模板 config.example.json 保持「静默缺省开」', exampleCfg.cost && exampleCfg.cost.quiet === true,
        JSON.stringify(exampleCfg.cost));
    const capsSrc = fs.readFileSync(path.join(LIVE, 'js', 'core', 'capabilities.js'), 'utf8');
    ok('能力注册表的静默项 default=true（省钱缺省不变）',
        /id: 'proactive\.quiet'[^\n]*default: true/.test(capsSrc));

    // ── ① 活动窗判据 ────────────────────────────────────────────────────
    ok('idle → 放行', AC.decideActivityGate({ state: 'idle' }).ok === true);
    ok('unknown → 放行（感知缺失不拦）', AC.decideActivityGate({ state: 'unknown' }).ok === true);
    ok('没有传感器 → 放行', AC.decideActivityGate(undefined).ok === true);
    const ga = AC.decideActivityGate({ state: 'active' });
    ok('active → 不说，但短间隔复采', ga.ok === false && ga.reason === 'active'
        && ga.retryMs > 0 && ga.retryMs <= 60000, JSON.stringify(ga));
    const gw = AC.decideActivityGate({ state: 'away' });
    ok('away → 不说，且不短间隔重试（没人听）', gw.ok === false && gw.reason === 'away' && gw.retryMs === 0,
        JSON.stringify(gw));

    // 模块实例计数（改坏计数 = 以后又只能靠猜）
    const mod = new AC.AutoChatModule({}, { vision: {} }, null);
    ok('stats() 有去向计数', typeof mod.stats === 'function'
        && mod.stats().ticks === 0 && mod.stats().skippedQuiet === 0 && mod.stats().skippedActive === 0);
    mod._stat('skippedActive');
    mod._stat('skippedActive');
    ok('计数会累加', mod.stats().skippedActive === 2);
    ok('默认间隔来自插件配置（240s）', (() => {
        const m2 = new AC.AutoChatModule({ idle_time: 240 }, { vision: {} }, null);
        return m2.idleTimeThreshold === 240000;
    })());

    // ── ② 预算默认 20 + 申请/说出口可区分 ───────────────────────────────
    {
        const b = mkBudget(null);
        ok('日预算默认 20（2026-11-22 拍板）', b._dailyLimit === 20, String(b._dailyLimit));
        const r = b.request('auto-chat', { priority: 'proactive' });
        ok('预算放行并给 attemptId', r.allowed === true && !!r.attemptId);
        const saved = JSON.parse(fs.readFileSync(logFile, 'utf8'));
        const a0 = saved.attempts[saved.attempts.length - 1];
        ok('新申请默认 spoke=false（申请≠说出口）', a0.spoke === false);
        const noted = b.noteSpoken('auto-chat', r.attemptId, 12);
        const saved2 = JSON.parse(fs.readFileSync(logFile, 'utf8'));
        const a1 = saved2.attempts.find((x) => x.id === r.attemptId);
        ok('noteSpoken 落盘 spoke=true 且只存长度', noted === true && a1.spoke === true
            && a1.said_len === 12 && !('text' in a1));
        ok('stats 里能看到今天真说出口数', b.stats().spoken_today === 1, JSON.stringify(b.stats().spoken_today));
        // 只按来源找最近一条（调用方没拿 attemptId 时）
        const r2 = b.request('watch-screen');
        b.noteSpoken('watch-screen', null, 3);
        const saved3 = JSON.parse(fs.readFileSync(logFile, 'utf8'));
        const a2 = saved3.attempts.find((x) => x.id === r2.attemptId);
        ok('没传 attemptId 时按来源兜底记账', a2.spoke === true);
        // 中央 markSpoken 会补记一次：不能回溯把更早的失败 attempt 误标成说出口
        const before4 = b._state.attempts.filter((x) => x.spoke === true).length;
        b.noteSpoken('watch-screen', null, null);
        const after4 = b._state.attempts.filter((x) => x.spoke === true).length;
        ok('已经标过的最近一条不会被二次记账/回溯旧记录', after4 === before4, before4 + ' → ' + after4);
        b._timer.unref && b._timer.unref();
    }
    {
        // 20 次/天 × 成本 1：第 21 次必须被拒（不可无限说）
        const b = mkBudget(null, { daily_limit: 20 });
        let last = null;
        for (let i = 0; i < 21; i += 1) last = b.request('auto-chat');
        ok('20 次之后第 21 次被预算拒绝', last.allowed === false && /预算/.test(last.reason), last.reason);
        b._timer.unref && b._timer.unref();
    }

    // ── ②b 她主动说出口 = 一次真实接触（久别重逢锚点，2026-11-22）────────
    {
        // 事故：她主动评论 → 用户马上回一句 → 她说「你这一走就是四十分钟」。
        // 锚点必须任一方说话都刷新，否则用户回复会被误判成「用户刚回来」。
        const file = RP.recordFile('上次见面.json');
        ok('接触锚点写在隔离目录（不碰真实记录室）', file.startsWith(TMP), file);
        const before = LC.lastContactAt();
        const wrote = LC.noteContact('auto-chat');
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        ok('noteContact 写盘成功且带来源', wrote === true && saved.via === 'auto-chat'
            && Math.abs(saved.at - Date.now()) < 5000, JSON.stringify(saved));
        ok('lastContactAt 读回同一个时间', LC.lastContactAt() === saved.at && LC.lastContactAt() >= before);
        ok('memory-recall 读的是同一个文件', file === path.join(TMP, 'data', '上次见面.json'));
    }

    // ── ②c 看屏弧线不能把旧剧情当「现在」（上下文接不上的另一层）──────────
    {
        const ws = fs.readFileSync(path.join(LIVE, 'plugins', 'community', 'watch-screen', 'index.js'), 'utf8');
        const direct = (ws.match(/this\._audioArc\.digest/g) || []).length;
        ok('弧线读取统一走 _freshArc（没有直接读旧 digest）', direct === 0, 'direct=' + direct);
        ok('_freshArc 带 TTL（默认 120s）', /_freshArc\(maxAgeMs = 120000\)/.test(ws));
        ok('声音停了会清空旧弧线', /this\._audioArc = null/.test(ws));
    }

    // ── ③ 协调器静默闸真的会拒 ─────────────────────────────────────────
    {
        const c = new SC.SpeechCoordinator();
        c.isBusy = () => false;
        c.isQuiet = () => false;
        const r0 = c.request('auto-chat', { priority: 'proactive' });
        ok('静默关时协调器放行', r0.allowed === true, r0.reason);
        c.isQuiet = () => true;
        const r1 = c.request('auto-chat', { priority: 'proactive' });
        ok('静默开时协调器拒绝且原因可读', r1.allowed === false && /静默/.test(r1.reason), r1.reason);
        ok('拒绝会计入 perPlugin 统计', c.stats().perPlugin['auto-chat'].denied >= 1);
    }

    console.log('────────────────────────────────────────────────────');
    console.log((fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `（PASS ${pass} / FAIL ${fail}）`);
} finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败不判红 */ }
}

process.exit(fail === 0 ? 0 : 1);
