#!/usr/bin/env node
/**
 * _probe/test-screen-timeline.cjs —— C2 屏幕时间线单测（2026-11-21）
 *
 * 要防的回归：
 *   ① 写进真实 data（宿主同时在写，测试必须 PET_DATA_ROOT + mkdtemp 隔离）
 *   ② 2fps 采样把文件打爆（同指纹 60 秒内必须去重）
 *   ③ 「我这一小时在干嘛」跨天查不到（recent 要自动读昨天文件）
 *   ④ 「这个报错第三次了」数不出来（search 的 count 必须是窗口内总命中数，不是 hits 长度）
 *   ⑤ 长摘要/图/base64 落盘（text 硬截 120 字；只落白名单字段）
 *   ⑥ 一行脏数据炸掉整条读链路（坏行跳过）
 *   ⑦ 7 天前的文件不清理（prune 只删自己的文件，不误删别的）
 *
 * 顺序纪律：先 setUpTempDataRoot，再 require 业务模块（records-path 在 require 时定目录）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

const tmpRoot = iso.setUpTempDataRoot('pet-timeline-');

const CORE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'js', 'core');
const { recordFile } = require(path.join(CORE, 'records-path.js'));
const { RECORDS_DIR } = require(path.join(CORE, 'records-path.js'));
const T = require(path.join(CORE, 'screen-timeline.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}

/** 直接往某天的文件写一行（伪造历史 / 坏行用） */
function writeLine(file, objOrString) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = typeof objOrString === 'string' ? objOrString : JSON.stringify(objOrString);
    fs.appendFileSync(file, line + '\n', 'utf8');
}

const now = Date.now();
const t1 = now - 5 * 60 * 1000;
const t2 = now - 4 * 60 * 1000;
const t3 = now - 3 * 60 * 1000;
const todayFile = () => recordFile('屏幕时间线-' + T.dayStamp(now) + '.jsonl');
const todayStart = new Date(now);
todayStart.setHours(0, 0, 0, 0);
const tStart = todayStart.getTime();

try {
    // ① 隔离自证：任何写入之前先断言路径在 PET_DATA_ROOT 下
    try {
        iso.assertIsolated(recordFile('屏幕时间线-20260101.jsonl'));
        ok('PET_DATA_ROOT 隔离生效（不会写真实 data）', true, recordFile('屏幕时间线-20260101.jsonl'));
    } catch (e) {
        ok('PET_DATA_ROOT 隔离生效（不会写真实 data）', false, e && e.message);
    }

    // ①b A2 收口（2026-11-21 拍板）：一起看目录也必须走记录室唯一真源。
    // _coWatchDir 挂在插件原型上、不依赖 context，可以直接用原型对象调用（不初始化插件）。
    let wsPlugin = null;
    try {
        const WatchScreenPlugin = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'watch-screen', 'index.js'));
        wsPlugin = Object.create(WatchScreenPlugin.prototype);
    } catch (e) { /* 下面按失败报，不中断整个测试 */ }
    if (!wsPlugin) {
        ok('watch-screen 可加载（_coWatchDir 断言前提）', false);
    } else {
        const coDir = wsPlugin._coWatchDir();
        let coIsolated = false;
        try { coIsolated = iso.assertIsolated(coDir) === true; } catch (e) { coIsolated = false; }
        ok('_coWatchDir 跟随 PET_DATA_ROOT（落在临时目录）', coIsolated === true, coDir);
        ok('_coWatchDir = RECORDS_DIR/一起看（与记录室同源）', coDir === path.join(RECORDS_DIR, '一起看'), coDir);
        ok('事件卡目录同源（_cardPath 也在临时目录）',
            path.dirname(wsPlugin._cardPath()) === coDir, wsPlugin._cardPath());

        // 生产等价：不设 PET_DATA_ROOT 时，旧的硬拼路径和新的 RECORDS_DIR 必须解析到同一目录。
        // 这里用路径代数证明（records-path 的 APP_ROOT = core 往上 3 层，旧代码 = 插件往上 4 层，
        // 两者都落在 my-neuro/），不依赖当前进程有没有设 env。
        const pluginDir = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'watch-screen');
        const oldProd = path.resolve(pluginDir, '..', '..', '..', '..', 'data', '一起看');
        const newProd = path.resolve(CORE, '..', '..', '..', 'data', '一起看');
        ok('不设 PET_DATA_ROOT 时新旧路径完全一致（生产零变化）', oldProd === newProd, oldProd + ' vs ' + newProd);
    }

    // ② append + recent 顺序 / 字段
    const a1 = T.append({ t: t1, activity: 'working', app: 'VS Code', title: 'a.js — 项目', text: '编辑 a.js，看报错栈' });
    const a2 = T.append({ t: t2, activity: 'video', app: 'Chrome', title: 'B站', text: '视频里两人在厨房争论' });
    const a3 = T.append({ t: t3, activity: 'working', app: 'VS Code', title: 'a.js — 项目', text: '运行测试，2 个失败' });
    ok('append 第 1 条成功且未去重', a1.ok === true && a1.deduped === false);
    ok('append 第 2 条成功', a2.ok === true);
    ok('append 第 3 条成功', a3.ok === true);

    const r1 = T.recent({ minutes: 60, limit: 20 });
    ok('recent 返回 3 条', r1.length === 3, 'len=' + r1.length);
    ok('recent 按时间倒序（最新在前）', r1[0].t === t3 && r1[1].t === t2 && r1[2].t === t1,
        r1.map((x) => x.t - t1).join(','));
    ok('recent 字段完整（activity/app/title/text）',
        r1[0].activity === 'working' && r1[0].app === 'VS Code'
        && r1[0].title.indexOf('a.js') >= 0 && r1[0].text.indexOf('2 个失败') >= 0);

    // ③ 同指纹 60 秒去重；不同指纹正常追加
    const d1 = T.append({ t: t3 + 30000, activity: 'working', app: 'VS Code', title: 'a.js — 项目', text: '运行测试，2 个失败' });
    ok('同指纹 60s 内重复 → 不追加（deduped）', d1.ok === true && d1.deduped === true);
    ok('去重后仍只有 3 条（2fps 采样没打爆文件）', T.recent({ minutes: 60, limit: 100 }).length === 3);

    const d2 = T.append({ t: t3 + 40000, activity: 'working', app: 'VS Code', title: 'a.js — 项目', text: '运行测试，全部通过' });
    ok('不同指纹（同一时刻窗口内）不去重', d2.ok === true && d2.deduped === false);

    // 指纹只取 text 前 40 字：句尾不同仍算同一条
    const prefix40 = 'A'.repeat(40);
    const p1 = T.append({ t: t3 + 50000, activity: 'x', app: 'y', title: 'z', text: prefix40 + '第一次尾巴' });
    const p2 = T.append({ t: t3 + 55000, activity: 'x', app: 'y', title: 'z', text: prefix40 + '第二次尾巴' });
    ok('指纹只看前 40 字（后文不同也去重）',
        p1.ok === true && p1.deduped === false && p2.ok === true && p2.deduped === true);

    // ④ text 硬截 120 字（短的不动）
    const longT = t3 + 60000;
    const shortT = t3 + 61000;
    T.append({ t: longT, activity: 'working', app: 'VS Code', title: 'a.js', text: '长'.repeat(200) });
    T.append({ t: shortT, activity: 'working', app: 'VS Code', title: 'b.js', text: '短'.repeat(119) });
    const all = T.recent({ minutes: 60, limit: 200 });
    const longRow = all.find((x) => x.t === longT);
    const shortRow = all.find((x) => x.t === shortT);
    ok('200 字摘要被硬截到 120 字', !!longRow && longRow.text.length === 120, 'len=' + (longRow && longRow.text.length));
    ok('119 字摘要原样保留（没被多截）', !!shortRow && shortRow.text.length === 119, 'len=' + (shortRow && shortRow.text.length));

    // ⑤ search 命中计数（「这个报错第三次了」）
    const key = 'NullPointerException';
    T.append({ t: t3 + 70000, activity: 'working', app: 'VS Code', title: 'a.js', text: '报错：' + key + ' 在 a.js' });
    T.append({ t: t3 + 80000, activity: 'working', app: 'VS Code', title: 'b.js', text: '又报错：' + key + ' 在 b.js' });
    T.append({ t: t3 + 90000, activity: 'working', app: 'VS Code', title: 'a.js', text: '第三次报错：' + key });
    const s1 = T.search({ text: key, minutes: 120, limit: 20 });
    ok('search 返回总命中次数 3', s1.ok === true && s1.count === 3, 'count=' + s1.count);
    ok('search 命中条目带完整字段', s1.hits.length === 3 && s1.hits[0].text.indexOf(key) >= 0
        && typeof s1.hits[0].t === 'number');
    const s2 = T.search({ text: key, minutes: 120, limit: 2 });
    ok('search limit 只截 hits，不截 count', s2.hits.length === 2 && s2.count === 3,
        'hits=' + s2.hits.length + ' count=' + s2.count);
    const s3 = T.search({ text: key.toLowerCase(), minutes: 120, limit: 20 });
    ok('search 英文大小写不敏感', s3.count === 3, 'count=' + s3.count);
    const s4 = T.search({ text: key, minutes: 120, limit: 20 });
    ok('search 结果按时间倒序（最新在前）', s4.hits[0].t === t3 + 90000);

    // ⑥ 损坏行跳过不炸
    const beforeBad = T.recent({ minutes: 24 * 60, limit: 200 }).length;
    fs.appendFileSync(todayFile(), '{这不是合法 JSON\n');
    let afterBad = null;
    let threw = false;
    try { afterBad = T.recent({ minutes: 24 * 60, limit: 200 }).length; } catch (e) { threw = true; }
    ok('损坏行不炸 recent', threw === false);
    ok('损坏行被跳过（合法条数不变）', afterBad === beforeBad, beforeBad + ' vs ' + afterBad);

    // ⑦ 跨天：recent 自动读昨天文件，且仍按时间倒序
    const yStart = tStart - 86400000;
    const yFile = recordFile('屏幕时间线-' + T.dayStamp(yStart) + '.jsonl');
    const yT1 = yStart + 22 * 3600000;
    const yT2 = yStart + 23 * 3600000;
    writeLine(yFile, { t: yT1, activity: 'game', app: 'Steam', title: '某游戏', text: '昨晚在打游戏，战斗界面' });
    writeLine(yFile, { t: yT2, activity: 'working', app: 'Cursor', title: 'main.py', text: '昨晚在改 main.py' });
    const cross = T.recent({ minutes: 30 * 60, limit: 200 });
    ok('跨天：recent 自动读到昨天文件（两条都在）',
        cross.some((x) => x.t === yT1) && cross.some((x) => x.t === yT2));
    ok('跨天：整体仍按时间倒序（最旧的就是昨晚 22 点那条）',
        cross[0].t > yT2 && cross[cross.length - 1].t === yT1,
        'first=' + cross[0].t + ' last=' + cross[cross.length - 1].t);

    // ⑧ 7 天 prune：只删自己的旧文件，保留最近的
    const oldStamp = T.dayStamp(now - 10 * 86400000);
    const oldFile = recordFile('屏幕时间线-' + oldStamp + '.jsonl');
    writeLine(oldFile, { t: now - 10 * 86400000, activity: '', app: '', title: '', text: '十天前的旧记录' });
    const keepStamp = T.dayStamp(now - 2 * 86400000);
    const keepFile = recordFile('屏幕时间线-' + keepStamp + '.jsonl');
    writeLine(keepFile, { t: now - 2 * 86400000, activity: '', app: '', title: '', text: '两天前的记录' });

    const pr = T.prune(7);
    ok('prune(7) 删掉 10 天前的文件', pr.ok === true && fs.existsSync(oldFile) === false);
    ok('prune(7) 保留 2 天前的文件', fs.existsSync(keepFile) === true);
    ok('prune 只删了 1 个文件', pr.removed === 1 && pr.removedFiles.length === 1, 'removed=' + pr.removed);

    // ⑨ stats：天数/条数/体积
    const st = T.stats();
    ok('stats.days = 3（今天 / 昨天 / 2 天前）', st.days === 3, 'days=' + st.days);
    ok('stats.entries 至少等于今天文件里的合法条数',
        st.entries >= beforeBad && Number.isFinite(st.entries), 'entries=' + st.entries + ' beforeBad=' + beforeBad);
    ok('stats.bytes 大于 0', st.bytes > 0, 'bytes=' + st.bytes);

    // ⑩ 绝不存图：调用方多传的 image/base64 字段一律丢弃
    const bT = t3 + 95000;
    const b = T.append({
        t: bT, activity: 'working', app: 'VS Code', title: 'a.js', text: '带图字段的条目',
        image: 'data:image/jpeg;base64,AAAA', base64: 'AAAA',
    });
    const bRaw = fs.readFileSync(recordFile('屏幕时间线-' + T.dayStamp(bT) + '.jsonl'), 'utf8');
    ok('只落白名单字段（文件里没有 image/base64）',
        b.ok === true && bRaw.indexOf('base64') < 0 && bRaw.indexOf('image') < 0);

    // ⑪ append 软失败：不 throw，带 detail
    let soft = null;
    let threwSoft = false;
    try { soft = T.append({}); } catch (e) { threwSoft = true; }
    ok('append 空摘要不抛，返回 {ok:false, detail}',
        threwSoft === false && !!soft && soft.ok === false && typeof soft.detail === 'string' && soft.detail.length > 0,
        soft && soft.detail);
} finally {
    iso.cleanup(tmpRoot);
}

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
