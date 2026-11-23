#!/usr/bin/env node
/**
 * _probe/test-conversation-continuity.cjs —— 跨通道 / 跨回合「上下文接续」回归（2026-11-22）
 *
 * 事故（用户现场）：
 *   她主动评论屏幕 → 用户马上回一句 → memory-recall 判「久别重逢」→
 *   「你这一走就是四十分钟」（对话历史 1235→1236→1237）。
 *   根因：`data/上次见面.json` 只在**用户输入**时刷新；她主动开口不算「接触」。
 *   修法：四路主动说话真说出口后调 last-contact.noteContact()。
 *
 * 为什么已有测试没抓到（本文件的「对照面」）：
 *   · test-proactive-gates ②b 只断言 noteContact 写盘 / 读回同一个文件（模块级）；
 *   · test-memory-quality ④ 只测「>6h 跨会话接续」，从没断言 20 分钟重逢阈值；
 *   · scenario-eval 的 5 个场景没有「主动开口 → 用户紧接着回复」；
 *   · test-speech-budget/gates 只测预算/闸门，不测「说完之后下一轮怎么判」。
 *   即：文件契约和单插件形状都测了，**两个插件之间的时序缝**没人测。
 *
 * 本文件测的是**真实实现**（不是契约复刻）：
 *   · last-contact.noteContact / lastContactAt —— 真模块；
 *   · memory-recall 的 _readLastSeenAt / _checkReunion —— 真类原型方法；
 *   · watch-screen 的 _freshArc / _pollAudio —— 真类原型方法。
 *   没有为了测试改任何生产代码。
 *
 * 数据隔离（A2）：PET_DATA_ROOT 指向 os.tmpdir()/mkdtemp，且测试自己断言：
 *   ① 锚点路径在临时目录下；② 临时目录里也读到了测试标记；
 *   ③ 真实 data/上次见面.json 里没有测试标记（证明没写真实目录）。
 *
 * 判定：0 = 全过；非 0 = 有失败（check-all 认退出码）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

// ⚠ 必须在 require 任何业务模块之前设置：records-path.js 在加载时就把 RECORDS_DIR 算死。
const TMP = iso.setUpTempDataRoot('pet-continuity-');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const RP = require(path.join(LIVE, 'js', 'core', 'records-path.js'));
const LC = require(path.join(LIVE, 'js', 'core', 'last-contact.js'));
const MemoryRecall = require(path.join(LIVE, 'plugins', 'community', 'memory-recall', 'index.js'));
const WatchScreen = require(path.join(LIVE, 'plugins', 'community', 'watch-screen', 'index.js'));

// 与 memory-recall._checkReunion() 里的硬编码阈值保持一致（index.js:1177）。
const REUNION_MIN = 20;
const MIN_MS = 60 * 1000;

const CONTACT_FILE = RP.recordFile(LC.FILE);
const REAL_CONTACT_FILE = path.join(RP.APP_ROOT, 'data', LC.FILE);

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function makeRecall() {
    const p = new MemoryRecall({ name: 'memory-recall' }, {
        getPluginFileConfig: () => ({}),
        log: () => {},
        addSystemPromptPatch: () => {},
        removeSystemPromptPatch: () => {},
    });
    // 和 last-contact 指向同一个目录；不调 onInit（_checkReunion 不依赖配置）。
    p._recordsDir = path.dirname(CONTACT_FILE);
    return p;
}

function writeAnchor(at, via) {
    fs.mkdirSync(path.dirname(CONTACT_FILE), { recursive: true });
    fs.writeFileSync(CONTACT_FILE, JSON.stringify({ at, via: via || 'test' }), 'utf8');
}
function readAnchor() {
    try { return JSON.parse(fs.readFileSync(CONTACT_FILE, 'utf8')); } catch (e) { return null; }
}
function readRealAnchorText() {
    try { return fs.readFileSync(REAL_CONTACT_FILE, 'utf8'); } catch (e) { return ''; }
}

(async () => {
    try {
        // ── ⓪ 数据隔离自断言（先证明测试不会碰真实记录室）─────────────────
        ok('锚点路径在 PET_DATA_ROOT 下（不是真实 data）',
            iso.assertIsolated(CONTACT_FILE) === true && CONTACT_FILE.startsWith(TMP),
            CONTACT_FILE);
        ok('锚点目录 = <tmp>/data（与生产同名结构）',
            path.dirname(CONTACT_FILE) === path.join(TMP, 'data'),
            path.dirname(CONTACT_FILE));
        ok('生产路径与测试路径不是同一个文件',
            path.resolve(CONTACT_FILE) !== path.resolve(REAL_CONTACT_FILE),
            REAL_CONTACT_FILE);
        ok('mkdtemp 根在 os.tmpdir() 下', TMP.startsWith(os.tmpdir()), TMP);

        // ── ① 她主动说完 → 用户 30 秒后回复：不得判「久别重逢」────────────
        console.log('\n① 她主动开口后，用户紧接着回复');
        const p = makeRecall();

        // 事故前状态：用户上一次说话是 40 分钟前。此时她主动评论了屏幕。
        writeAnchor(Date.now() - 40 * MIN_MS, 'user');
        const baseline = p._readLastSeenAt();
        ok('基线：锚点是 40 分钟前（模拟她开口前的状态）',
            Math.abs(baseline - (Date.now() - 40 * MIN_MS)) < 2000,
            'age=' + Math.round((Date.now() - baseline) / MIN_MS) + 'min');

        // 对照：如果她的主动开口没有记接触，40 分钟后用户回复就会被判重逢
        // —— 这正是事故现场。先证明「旧状态会误判」，否则下面的绿灯没有意义。
        const control = p._checkReunion();
        ok('对照（未记接触）：40 分钟后回复会被判久别重逢',
            !!control && control.minutes >= 39,
            control ? ('离开 ' + control.human) : 'null');
        ok('对照的提示词里确实会说出「40 分钟」',
            !!control && control.human === '40 分钟',
            control && control.human);

        // 回到事故前状态，她主动说出口（四路之一的 watch-screen）
        writeAnchor(Date.now() - 40 * MIN_MS, 'user');
        const noteAt = Date.now();
        const noted = LC.noteContact('watch-screen');
        const saved = readAnchor();
        ok('她主动说出口后 noteContact 刷新同一份锚点',
            noted === true && !!saved && saved.via === 'watch-screen'
            && Math.abs(saved.at - noteAt) < 2000,
            JSON.stringify(saved));
        ok('memory-recall._readLastSeenAt 读到 noteContact 写的时间',
            Math.abs(p._readLastSeenAt() - saved.at) <= 1,
            p._readLastSeenAt() + ' vs ' + saved.at);

        // 模拟 30 秒过去：把锚点写成「30 秒前」（等价于不等待地推进时钟）。
        writeAnchor(saved.at - 30 * 1000, 'watch-screen');
        const after30s = p._checkReunion();
        ok('她开口后 30 秒用户回复：不得判久别重逢（核心回归）',
            after30s === null,
            after30s ? ('误判为离开 ' + after30s.human) : 'null');

        // ── ② 用户 3 小时没说话、她也没说话：应该判重逢 ────────────────────
        console.log('\n② 双方都静默 3 小时');
        writeAnchor(Date.now() - 3 * 60 * MIN_MS, 'user');
        const r3h = p._checkReunion();
        ok('3 小时无人说话 → 应该判久别重逢',
            !!r3h && r3h.minutes >= 179 && r3h.hours >= 2.9,
            r3h ? JSON.stringify({ minutes: r3h.minutes, hours: r3h.hours }) : 'null');
        ok('重逢时长说人话（三个多小时，不是 3.2 小时）',
            !!r3h && r3h.human === '三个多小时',
            r3h && r3h.human);

        // 用户这次开口本身也是接触：_checkReunion 会把锚点刷成 now。
        const afterUser = p._readLastSeenAt();
        ok('用户开口也刷新锚点（谁说话都算接触）',
            Math.abs(afterUser - Date.now()) < 2000,
            'at=' + afterUser);
        ok('紧接着第二句不再重复判重逢（提示不会每轮重复）',
            p._checkReunion() === null);

        // ── ③ 阈值边界：19:59 不判，20:01 判 ──────────────────────────────
        console.log('\n③ 20 分钟阈值边界');
        writeAnchor(Date.now() - (REUNION_MIN * MIN_MS - 1000), 'user');
        ok('19 分 59 秒：阈值内，不判久别重逢',
            p._checkReunion() === null);
        writeAnchor(Date.now() - (REUNION_MIN * MIN_MS + 1000), 'user');
        const rEdge = p._checkReunion();
        ok('20 分 01 秒：阈值外，判久别重逢',
            !!rEdge && rEdge.minutes === 20,
            rEdge ? ('离开 ' + rEdge.minutes + ' 分钟') : 'null');

        // ── ④ 「谁说话都算接触」：四路主动开口逐一验证 ────────────────────
        console.log('\n④ 四路主动开口都算接触');
        for (const via of ['auto-chat', 'watch-screen', 'alive-state', 'dawn-dusk']) {
            writeAnchor(Date.now() - 40 * MIN_MS, 'user');
            const wrote = LC.noteContact(via);
            const rec = readAnchor();
            writeAnchor(rec.at - 30 * 1000, via);   // 模拟又过了 30 秒
            ok(via + ' 真说出口 = 一次接触（30 秒后回复不判重逢）',
                wrote === true && !!rec && rec.via === via && p._checkReunion() === null,
                JSON.stringify(rec));
        }

        // 测试标记：写进临时锚点，再检查真实文件里没有它（不依赖 mtime，宿主并发写也不会误判）。
        const MARKER = 'continuity-test-' + process.pid + '-' + Date.now().toString(36);
        LC.noteContact(MARKER);
        ok('测试标记确实写进了临时锚点',
            readAnchor() && readAnchor().via === MARKER,
            JSON.stringify(readAnchor()));
        ok('真实 data/上次见面.json 里没有测试标记（没写真实目录）',
            !readRealAnchorText().includes(MARKER),
            REAL_CONTACT_FILE);

        // ── ⑤ _freshArc：弧线只代表「现在」，旧剧情必须过期 ────────────────
        console.log('\n⑤ 看屏情绪弧线的新鲜度（_freshArc）');
        const ws = new WatchScreen({ name: 'watch-screen' }, { log: () => {} });
        ws._audioArc = { digest: '声音还是那个黎曼猜想的纪录片', turns: [], state: 'curious', at: Date.now() };
        const freshNow = ws._freshArc();
        ok('弧线 at=now：有值',
            !!freshNow && String(freshNow.digest).includes('黎曼'),
            freshNow && freshNow.digest);

        ws._audioArc.at = Date.now() - 119 * 1000;
        ok('弧线 119 秒：仍在 120s TTL 内（有值）',
            !!ws._freshArc());

        ws._audioArc.at = Date.now() - 130 * 1000;
        ok('弧线 130 秒：过期返回 null（不能拿旧剧情当现在）',
            ws._freshArc() === null);

        ws._audioArc = { digest: '', turns: [], state: '', at: Date.now() };
        ok('声音停了（digest 为空）：返回 null',
            ws._freshArc() === null);

        ws._audioArc = null;
        ok('没有弧线：返回 null',
            ws._freshArc() === null);

        // 行为级：_pollAudio 收到「声音停了」的 /arc 时必须清空旧弧线（不是只靠 TTL 兜底）。
        const ws2 = new WatchScreen({ name: 'watch-screen' }, { log: () => {} });
        ws2._isTtsBusy = () => false;
        ws2._audioCursor = 0;
        ws2._appendCoWatchLog = () => {};
        ws2._refreshCoWatchPatch = () => {};
        ws2._mediaProbeAt = Date.now();
        ws2._probeMedia = async () => {};
        ws2._audioArc = { digest: '声音还是那个黎曼猜想', turns: [], state: 'curious', at: Date.now() - 10000 };

        ws2._fetchJson = async (url) => {
            if (url.includes('/segments')) {
                return { ok: true, items: [{ end: 101, text: '画面里换成了 GTA6', tone: 'excited' }], cursor: 101 };
            }
            if (url.includes('/arc')) return { ok: true, digest: '' };   // 声音停了
            return null;
        };
        await ws2._pollAudio();
        ok('声音停（/arc digest 空）：_pollAudio 清空旧弧线',
            ws2._audioArc === null,
            JSON.stringify(ws2._audioArc));

        ws2._fetchJson = async (url) => {
            if (url.includes('/segments')) {
                return { ok: true, items: [{ end: 102, text: 'GTA6 的任务开始了', tone: 'calm' }], cursor: 102 };
            }
            if (url.includes('/arc')) {
                return { ok: true, digest: '新剧情的情绪弧线：平静', turns: [], state: 'calm' };
            }
            return null;
        };
        await ws2._pollAudio();
        const freshNew = ws2._freshArc();
        ok('新对白 + 新弧线：立即可读且 at 是新刷的',
            !!freshNew && String(freshNew.digest).includes('新剧情')
            && Math.abs(freshNew.at - Date.now()) < 2000,
            freshNew && JSON.stringify({ digest: freshNew.digest, at: freshNew.at }));
    } finally {
        iso.cleanup(TMP);
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    try { iso.cleanup(TMP); } catch (e2) { /* ignore */ }
    process.exit(1);
});
