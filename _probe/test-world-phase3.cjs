#!/usr/bin/env node
'use strict';

/**
 * _probe/test-world-phase3.cjs —— 世界感知 Phase 3 四缺口验收
 *
 * 钉住：
 *   ① 通知采集：批量读 → (AUMID, creationTime, title) 去重 → 保留最近 200 条；
 *      title 默认不落盘；include_title=true 时截 60 字；坏行/缺文件不崩且计数。
 *   ② 无痕启发式：扩展最后一条 incognito=true 且 5 分钟内 → 世界行屏蔽
 *      前台标题/媒体标题，只留 app + 「浏览中（隐私）」；过期或恢复普通即恢复。
 *   ③ site-category：常见 host 分类正确、未知 → other、URL 的 path/query 被剥掉。
 *   ④ RSS 简报卡：rss-brief-last.json 的 card 形状正确且最多 5 条。
 *
 * 全部用 os.tmpdir() 临时目录；通知采集走 PowerShell 的 -FromFile 离线模式，
 * 不读真实通知、不写真实 data、不弹授权框。
 *
 * 用法：node _probe/test-world-phase3.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const PROBE = path.join(ROOT, 'pet-runtime', 'tools', 'notification-probe.ps1');
const LAUNCHER = path.join(ROOT, 'pet-runtime', 'tools', 'launch-my-neuro.mjs');
const PS = process.env.PET_POWERSHELL || 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

const Site = require(path.join(APP, 'js', 'core', 'site-category.js'));
const WS = require(path.join(APP, 'js', 'core', 'world-store.js'));
const WorldSense = require(path.join(APP, 'plugins', 'community', 'world-sense', 'index.js'));
const WorldExtras = require(path.join(APP, 'plugins', 'community', 'world-extras', 'index.js'));
const RssBrief = require(path.join(APP, 'plugins', 'community', 'rss-brief', 'index.js'));
const T3 = WorldSense.__test;

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(name + (detail ? '：' + detail : ''));
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(name, a === b, '期望 ' + b + '，实际 ' + a);
}

const temps = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'world-phase3-'));
  temps.push(d);
  return d;
}
function cleanup() {
  for (const d of temps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
  }
}
function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

/** 调通知采集的离线模式；返回 {status, json, stdout, stderr} */
function runCollect(opts) {
  const o = opts || {};
  if (!fs.existsSync(PS)) return { status: -1, json: null, stdout: '', stderr: 'powershell 不存在：' + PS };
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PROBE,
    '-Collect', '-Json',
    '-FromFile', o.input,
    '-OutJsonl', o.out,
    '-ConfigPath', o.config,
  ];
  if (o.includeTitle) args.push('-IncludeTitle');
  const r = spawnSync(PS, args, { encoding: 'utf8', timeout: 90000, windowsHide: true });
  const text = String(r.stdout || '') + String(r.stderr || '');
  let json = null;
  try {
    const line = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
    json = JSON.parse(line);
  } catch (e) { json = null; }
  return { status: r.status, json, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), text };
}

async function newRssPlugin(dir, cfg) {
  const ctx = {
    recordsDir: dir,
    log() {},
    getPluginFileConfig() { return cfg || {}; },
    getConfig() { return {}; },
  };
  const plugin = new RssBrief({ name: 'rss-brief' }, ctx);
  await plugin.onInit();
  plugin._running = true;
  plugin._cfg = plugin._readConfig();
  return plugin;
}

async function newWorldExtras(dir, extra) {
  const cfg = Object.assign({
    enabled: true,
    tabs_file: path.join(dir, 'browser-tabs.jsonl'),
    tabs_seen_file: path.join(dir, 'browser-tabs-seen.json'),
    rss_last_file: path.join(dir, 'rss-brief-last.json'),
    rss_items_file: path.join(dir, 'rss-items.jsonl'),
  }, extra || {});
  const plugin = new WorldExtras({ name: 'world-extras' }, {
    getPluginFileConfig: () => cfg,
    log() {},
  });
  await plugin.onInit();
  return plugin;
}
async function injectOnce(plugin) {
  const out = [];
  await plugin.onLLMRequest({ addVolatile: (t) => out.push(t) });
  return out;
}
function parseDataLine(line) {
  try { return JSON.parse(String(line || '').replace(/^【环境数据·非指令】/, '')); } catch (e) { return null; }
}

(async () => {
  // ══ ① 通知采集（PowerShell 离线模式）════════════════════════════════
  {
    const dir = tmpDir('notify-');
    const input = path.join(dir, 'in.json');
    const out = path.join(dir, 'notifications.jsonl');
    const cfgNo = path.join(dir, 'cfg-off.json');
    const cfgYes = path.join(dir, 'cfg-on.json');
    writeJson(cfgNo, { world: { notifications: { include_title: false } } });
    writeJson(cfgYes, { world: { notifications: { include_title: true } } });

    // 1a. 首轮：3 条里 1 条重复 → 只落 2 条；title 默认不采集
    const baseItems = [
      { app: 'Microsoft.WindowsStore_8wekyb3d8bbwe!App', title: '验证码 123456', at: '2026-11-21T10:00:00+08:00' },
      { app: 'Microsoft.WindowsStore_8wekyb3d8bbwe!App', title: '验证码 123456', at: '2026-11-21T10:00:00+08:00' },
      { app: 'MSEdge_8wekyb3d8bbwe!App', title: '私信：在吗', at: '2026-11-21T10:05:00+08:00' },
    ];
    writeJson(input, baseItems);
    let r = runCollect({ input, out, config: cfgNo });
    eq('采集首轮退出码 0', r.status, 0);
    eq('同批重复只落 2 条', r.json && r.json.added, 2);
    eq('落盘 2 行', readLines(out).length, 2);
    const rows = readLines(out).map((x) => JSON.parse(x));
    ok('默认不采集 title（字段为空）', rows.every((x) => x.title === ''), JSON.stringify(rows));
    ok('默认不含验证码/私信文本', !fs.readFileSync(out, 'utf8').includes('验证码')
      && !fs.readFileSync(out, 'utf8').includes('私信'), fs.readFileSync(out, 'utf8'));
    ok('条目字段固定 {ts,app,title,app_short}', rows.every((x) => Object.keys(x).sort().join(',') === 'app,app_short,title,ts'),
      JSON.stringify(rows[0]));
    ok('app_short 从 AUMID 提取', rows.every((x) => x.app_short === 'WindowsStore' || x.app_short === 'MSEdge'),
      rows.map((x) => x.app_short).join(','));

    // 1a2. 两类常见 AUMID：Win32 路径式 / 域形式（不能都退化成 exe/app）
    const outShort = path.join(dir, 'notifications-short.jsonl');
    writeJson(input, [
      { app: '{6D809377-6AF0-444B-8957-A3773F02200E}/Sony/INZONE Hub/INZONEHub.exe', title: '', at: '2026-11-21T10:00:00+08:00' },
      { app: 'dev.zcode.app', title: '', at: '2026-11-21T10:01:00+08:00' },
    ]);
    r = runCollect({ input, out: outShort, config: cfgNo });
    const shorts = readLines(outShort).map((x) => JSON.parse(x));
    eq('路径式 AUMID 取文件名', shorts[0] && shorts[0].app_short, 'INZONEHub');
    eq('域形式 AUMID 取有效标签', shorts[1] && shorts[1].app_short, 'zcode');

    // 1b. 再跑一次：按 (AUMID, creationTime, title) 去重 → added=0
    writeJson(input, baseItems);
    const linesBefore = readLines(out).length;
    r = runCollect({ input, out, config: cfgNo });
    eq('重复采集 added=0', r.json && r.json.added, 0);
    eq('重复采集 duplicates=3', r.json && r.json.duplicates, 3);
    eq('行数不增长', readLines(out).length, linesBefore);

    // 1c. include_title=true：标题记录且截 60 字
    const out2 = path.join(dir, 'notifications-title.jsonl');
    writeJson(input, [
      { app: 'A.B!App', title: 'x'.repeat(100), at: '2026-11-21T10:00:00+08:00' },
    ]);
    r = runCollect({ input, out: out2, config: cfgYes });
    eq('开标题后退出码 0', r.status, 0);
    const one = readLines(out2).map((x) => JSON.parse(x))[0];
    ok('开标题后 title 被记录', !!one && one.title.length === 60, one ? String(one.title.length) : 'missing');
    eq('开标题后 includeTitle=true', r.json && r.json.includeTitle, true);

    // 1d. 轮转 200 + 坏行计数
    const out3 = path.join(dir, 'notifications-rotate.jsonl');
    fs.writeFileSync(out3, '{bad json}\n' + JSON.stringify({ ts: '2000-01-01T00:00:00.0000000Z', app: 'OLD', title: '', app_short: 'OLD' }) + '\n', 'utf8');
    const burst = [];
    for (let i = 0; i < 205; i += 1) {
      burst.push({
        app: 'App' + (i % 3) + '!App',
        title: '',
        at: new Date(Date.UTC(2026, 10, 21, 0, 0, 0) + i * 1000).toISOString(),
      });
    }
    writeJson(input, burst);
    r = runCollect({ input, out: out3, config: cfgNo });
    eq('轮转场景退出码 0', r.status, 0);
    eq('保留最近 200 条', readLines(out3).length, 200);
    eq('report total=200', r.json && r.json.total, 200);
    ok('report rotated>0', !!(r.json && r.json.rotated > 0), JSON.stringify(r.json));
    ok('report 统计坏行', !!(r.json && r.json.invalid >= 1), JSON.stringify(r.json));
    const kept = readLines(out3).map((x) => JSON.parse(x));
    ok('最旧条目被轮转掉', kept.every((x) => x.ts > '2026-11-21T00:00:04'), kept[0] && kept[0].ts);
    ok('保留的是最新 200 条', kept[kept.length - 1].ts >= '2026-11-21T00:03:24',
      kept[kept.length - 1] && kept[kept.length - 1].ts);
  }

  // ══ ② 无痕启发式 ═══════════════════════════════════════════════════
  {
    let T = 1_700_000_000_000;
    const store = WS.createWorldStore({ now: () => T });
    const fg = { ok: true, app: 'chrome', title: '秘密页面 - Google', fullscreen: false };
    const media = { ok: true, status: 'playing', title: '秘密视频标题', app: 'chrome' };

    store.apply({
      fg, idleMs: 1000, media,
      browser: { ok: true, host: '', incognito: true, at: T },
    }, { source: 'system' });

    let snap = store.snapshot();
    eq('无痕：前台标题被屏蔽', snap.title, '');
    eq('无痕：媒体标题被屏蔽', snap.mediaTitle, '');
    eq('无痕：媒体段不含标题', snap.media, '');
    eq('无痕：app 名保留', snap.app, 'chrome');
    eq('无痕：privacy 标记', snap.privacy, '浏览中（隐私）');
    eq('无痕：不输出站点类别', snap.category, '');
    let f = WS.worldFields(snap);
    eq('世界字段 title 空', f.title, '');
    ok('世界字段含「浏览中（隐私）」', f.privacy === '浏览中（隐私）', JSON.stringify(f));
    ok('世界字段 media 空', f.media === '', JSON.stringify(f));
    const line = WS.renderWorldLine(null, snap);
    ok('世界行含「浏览中（隐私）」', /浏览中（隐私）/.test(line.text), line.text);

    // 2a. 4 分钟内的持续上报仍屏蔽
    T += 4 * 60 * 1000;
    store.apply({ fg, idleMs: 2000, media, browser: { ok: true, host: '', incognito: true, at: T } }, { source: 'system' });
    snap = store.snapshot();
    eq('5 分钟内仍屏蔽标题', snap.title, '');
    eq('5 分钟内仍标记隐私', snap.privacy, '浏览中（隐私）');

    // 2b. 扩展恢复普通 → 立刻恢复标题
    T += 60 * 1000;   // 距上次无痕 1 分钟，但最后一条是普通页面
    store.apply({
      fg, idleMs: 2000, media,
      browser: { ok: true, host: 'example.com', incognito: false, at: T },
    }, { source: 'system' });
    snap = store.snapshot();
    eq('恢复普通：前台标题回来', snap.title, '秘密页面 - Google');
    eq('恢复普通：媒体标题回来', snap.mediaTitle, '秘密视频标题');
    eq('恢复普通：privacy 清空', snap.privacy, '');
    eq('恢复普通：未知站点归 other', snap.category, 'other');
    eq('未知站点在世界行写「站点=其他」', WS.worldFields(snap).site, '站点=其他');

    // 2c. 无痕上报过期（>5 分钟没再上报）→ 不再屏蔽，回到启发式的边界
    T = 1_700_000_000_000;
    const store2 = WS.createWorldStore({ now: () => T });
    store2.apply({
      fg, idleMs: 1000, media,
      browser: { ok: true, host: '', incognito: true, at: T },
    }, { source: 'system' });
    T += 6 * 60 * 1000;
    store2.apply({ fg, idleMs: 2000, media }, { source: 'system' });   // 不再有浏览器上报
    snap = store2.snapshot();
    eq('无痕上报过期后不再屏蔽标题', snap.title, '秘密页面 - Google');
    eq('无痕上报过期后 privacy 清空', snap.privacy, '');

    // 2d. 已知站点类别进入世界行（不含 path/query）
    T += 1000;
    store2.apply({
      fg: { ok: true, app: 'chrome', title: '某个视频', fullscreen: false },
      idleMs: 1000,
      browser: { ok: true, host: 'www.bilibili.com', incognito: false, at: T },
    }, { source: 'system' });
    snap = store2.snapshot();
    eq('已知站点类别 = video', snap.category, 'video');
    f = WS.worldFields(snap);
    ok('世界字段带「站点=视频」', f.site === '站点=视频', JSON.stringify(f));
  }

  // ══ ③ site-category 纯函数 ═════════════════════════════════════════
  {
    const cases = [
      ['www.bilibili.com', 'video'],
      ['youtube.com', 'video'],
      ['youtu.be', 'video'],
      ['weibo.com', 'social'],
      ['x.com', 'social'],
      ['docs.google.com', 'docs'],
      ['github.com', 'code'],
      ['stackoverflow.com', 'code'],
      ['taobao.com', 'shop'],
      ['jd.com', 'shop'],
      ['news.ycombinator.com', 'news'],
      ['sspai.com', 'news'],
      ['pornhub.com', 'adult'],
      ['example.com', 'other'],
    ];
    for (const [host, want] of cases) {
      eq('分类 ' + host, Site.categoryOf(host), want);
    }
    // 未知域名：不在后缀表、也不含整标签关键词 → other
    eq('未知域名 → other', Site.categoryOf('some-random-host.example'), 'other');
    eq('空 host → other', Site.categoryOf(''), 'other');
    eq('null → other', Site.categoryOf(null), 'other');

    eq('URL 的 path/query 被剥掉', Site.normalizeHost('https://www.bilibili.com/video/BV1?p=2#t=1'), 'www.bilibili.com');
    eq('分类按 host 而非 path', Site.categoryOf('https://www.bilibili.com/video/BV1?p=2'), 'video');
    eq('大写 host 归一', Site.categoryOf('WWW.GITHUB.COM'), 'code');
    eq('端口被剥掉', Site.normalizeHost('example.com:8080'), 'example.com');
    eq('无协议 URL 的 path 被剥掉', Site.normalizeHost('github.com/a/b?x=1'), 'github.com');
    ok('类别枚举完整', Site.CATEGORIES.join(',') === 'video,social,docs,code,shop,news,adult,other',
      Site.CATEGORIES.join(','));
    ok('未知 host 不返回空（必须 other）', Site.categoryOf('nope.invalid') === 'other');
  }

  // ══ ④ RSS 简报卡 + world-extras 注入口径 ═══════════════════════════
  {
    const dir = tmpDir('rss-card-');
    const nowMs = Date.now();
    const hhmm = String(new Date(nowMs).getHours()).padStart(2, '0') + ':'
      + String(new Date(nowMs).getMinutes()).padStart(2, '0');
    const items = [];
    const titles = ['量子计算突破', '足球联赛战报', '新款手机评测', '央行利率决议',
      '深海生物发现', '开源模型发布', '城市地铁规划', '独立游戏推荐'];
    for (let i = 0; i < 8; i += 1) {
      items.push({
        id: 'c' + i,
        feed_id: 'hn',
        feed_name: i % 2 ? 'HN' : '少数派',
        title: titles[i],
        link: 'https://e/' + i,
        published_at: new Date(nowMs - i * 600e3).toISOString(),
        summary: '',
        fetched_at: nowMs,
        score: 0,
        pushed: false,
      });
    }
    writeJsonl(path.join(dir, 'rss-items.jsonl'), items);
    writeJson(path.join(dir, 'feeds.json'), { feeds: [] });

    const rss = await newRssPlugin(dir, {
      enabled: true, push_windows: [hhmm], max_push_per_day: 8, top_n: 8,
    });
    const res = await rss._maybePush(nowMs);
    eq('窗口选中 8 条', res.pushed.length, 8);

    const lastFile = path.join(dir, 'rss-brief-last.json');
    const last = JSON.parse(fs.readFileSync(lastFile, 'utf8'));
    ok('last 里有 card', !!last.card && typeof last.card === 'object', JSON.stringify(Object.keys(last)));
    eq('card.at 与 last.at 一致', last.card && last.card.at, last.at);
    ok('card.items 最多 5 条', Array.isArray(last.card.items) && last.card.items.length === 5,
      JSON.stringify(last.card && last.card.items.length));
    const shape = (last.card.items[0] && Object.keys(last.card.items[0]).sort().join(','));
    eq('card item 形状 {at,feed,score,title}', shape, 'at,feed,score,title');
    ok('card.delivered 初始为空', Array.isArray(last.card.delivered) && last.card.delivered.length === 0,
      JSON.stringify(last.card.delivered));
    ok('card 条目带分数', last.card.items.every((x) => typeof x.score === 'number'), JSON.stringify(last.card.items));

    // 投递确认由 world-extras 注入成功后回调；先注入，再看 card.delivered 是否回填。
    writeJsonl(path.join(dir, 'browser-tabs.jsonl'), [
      { ts: Date.now(), host: 'www.bilibili.com', title: '一个视频', audible: false, incognito: false, tabCount: 1, source: 'ext' },
    ]);
    const wx = await newWorldExtras(dir);
    let out = await injectOnce(wx);
    eq('world-extras 注入 1 行', out.length, 1);
    let parsed = parseDataLine(out[0]);
    ok('注入行 JSON 可解析', !!parsed, out[0]);
    eq('rss.n = 8', parsed && parsed.rss && parsed.rss.n, 8);
    const topItem = items.find((x) => x.id === res.pushed[0].id) || items[0];
    eq('rss.top1 标题', parsed && parsed.rss && parsed.rss.title, topItem.title);
    ok('rss 带年龄', !!(parsed && parsed.rss && Number.isFinite(parsed.rss.age_min)),
      JSON.stringify(parsed && parsed.rss));
    eq('web.category = video', parsed && parsed.web && parsed.web.category, 'video');
    ok('web 不含 path/query', !!(parsed && parsed.web && !/[?/]/.test(parsed.web.host || '')),
      JSON.stringify(parsed && parsed.web));

    const shownId = res.pushed[0].id;
    eq('注入成功后只认账 1 条', rss._state.deliveredCount, 1);
    const last2 = JSON.parse(fs.readFileSync(lastFile, 'utf8'));
    ok('card.delivered 回填展示过的 id', last2.card.delivered.indexOf(shownId) >= 0,
      JSON.stringify(last2.card.delivered));
    eq('1 条投递后剩余 7 条仍可注入', (await injectOnce(wx)).length, 1);
    const parsed2 = parseDataLine((await injectOnce(wx))[0] || '');
    ok('下一轮继续投递（不是一次性吞掉）', !!parsed2 && parsed2.rss && parsed2.rss.n === 6,
      JSON.stringify(parsed2 && parsed2.rss));
  }

  // ══ ⑤ 读取器失败路径（缺文件/坏行不崩，且有计数）═══════════════════
  {
    const dir = tmpDir('readers-');
    const missing = path.join(dir, 'nope.jsonl');

    const miss = T3.readNotificationsFile(missing, Date.now(), { windowMs: T3.NOTIFY_WINDOW_MS });
    ok('缺文件：missing=true', miss.ok === true && miss.missing === true, JSON.stringify(miss));
    eq('缺文件：count=0', miss.count, 0);
    eq('缺文件：invalid=0', miss.invalid, 0);

    const badFile = path.join(dir, 'bad.jsonl');
    const now = Date.now();
    fs.writeFileSync(badFile,
      '{bad json}\n'
      + JSON.stringify({ ts: new Date(now - 60e3).toISOString(), app: 'A', app_short: 'A', title: '' }) + '\n'
      + JSON.stringify({ ts: 'not-a-time', app: 'B', app_short: 'B', title: '' }) + '\n', 'utf8');
    const bad = T3.readNotificationsFile(badFile, now, { windowMs: T3.NOTIFY_WINDOW_MS });
    eq('坏行文件：仍能读到好行', bad.count, 1);
    eq('坏行文件：坏行计数 2', bad.invalid, 2);
    ok('坏行文件：不抛且 entries 计数', bad.entries === 1, JSON.stringify(bad));

    // 纯函数窗口：11 分钟前的不算；apps 按新旧去重
    const sum = T3.summarizeNotifications([
      { ts: new Date(now - 30e3).toISOString(), app: 'NEW', app_short: '微信', title: '' },
      { ts: new Date(now - 4 * 60e3).toISOString(), app: 'OLD', app_short: 'QQ', title: '' },
      { ts: new Date(now - 4 * 60e3).toISOString(), app: 'OLD2', app_short: '微信', title: '' },
      { ts: new Date(now - 11 * 60e3).toISOString(), app: 'GONE', app_short: 'X', title: '' },
      { ts: 'bad', app: 'BAD', app_short: 'BAD', title: '' },
    ], now, T3.NOTIFY_WINDOW_MS);
    eq('窗口内 count=3', sum.count, 3);
    eq('apps 去重且按新旧', sum.apps.join(','), '微信,QQ');
    eq('窗口外仍计入 entries', sum.entries, 4);
    eq('纯函数坏行计数', sum.invalid, 1);

    const sum2 = T3.summarizeNotifications([
      { ts: new Date(now - 10e3).toISOString(), app: 'X', app_short: '微信', title: '最新标题' },
      { ts: new Date(now - 20e3).toISOString(), app: 'Y', app_short: 'QQ', title: '旧标题' },
    ], now, T3.NOTIFY_WINDOW_MS);
    eq('latest_title 取最新一条带标题的记录', sum2.latest_title, '最新标题');

    // 世界状态库的通知形状（snake_case 与规格一致）
    const nStore = WS.createWorldStore({ now: () => now });
    nStore.apply({
      fg: { ok: true, app: 'chrome', title: 't', fullscreen: false },
      idleMs: 1000,
      notifications: { count: 2, apps: ['微信', 'QQ'], latest_title: '最新通知' },
    }, { source: 'system' });
    const nSnap = nStore.snapshot();
    eq('snapshot 通知 count', nSnap.notifications.count, 2);
    eq('snapshot 通知 apps', nSnap.notifications.apps.join(','), '微信,QQ');
    eq('snapshot 通知 latest_title', nSnap.notifications.latest_title, '最新通知');
    ok('世界字段渲染通知', /通知=2条\(微信,QQ\)《最新通知》/.test(WS.worldFields(nSnap).notify),
      JSON.stringify(WS.worldFields(nSnap)));

    // 通知读取器：mtime 缓存按当前时间滑窗
    const nfile = path.join(dir, 'notifications.jsonl');
    writeJsonl(nfile, [{ ts: new Date(now - 30e3).toISOString(), app: 'A', app_short: 'A', title: '' }]);
    const reader = T3.createNotificationReader({ file: nfile, windowMs: T3.NOTIFY_WINDOW_MS, now: () => now });
    eq('读取器首读 count=1', reader.read(now).count, 1);
    eq('读取器 11 分钟后 count=0（滑窗）', reader.read(now + 11 * 60e3).count, 0);
    ok('读取器有 reads 计数', reader.stats.reads >= 2, JSON.stringify(reader.stats));

    // 浏览器读取器：缺文件 → null；坏行跳过；心跳续命；过期 → null
    const tabs = path.join(dir, 'tabs.jsonl');
    const seen = path.join(dir, 'seen.json');
    const br = T3.createBrowserSignalReader({ tabsFile: tabs, seenFile: seen, freshMs: T3.BROWSER_FRESH_MS });
    eq('浏览器缺文件 → null', br.read(now), null);
    ok('浏览器缺文件有 missing 标记', br.stats.missing === true, JSON.stringify(br.stats));

    const t0 = 1_700_000_000_000;
    fs.writeFileSync(tabs, '{bad}\n' + JSON.stringify({
      ts: t0, host: 'example.com', title: 'x', audible: false, incognito: false, tabCount: 1, source: 'ext',
    }) + '\n', 'utf8');
    let sig = br.read(t0 + 1000);
    ok('坏行后仍读到上一条好行', !!sig && sig.host === 'example.com', JSON.stringify(sig));
    ok('坏行被计数', br.stats.invalid === 1, JSON.stringify(br.stats));

    // 心跳续命：行是 6 分钟前，但 seen_ts 刚刷新 → 仍新鲜
    writeJson(seen, { seen_ts: t0 + 6 * 60e3, host: 'example.com', incognito: false });
    sig = br.read(t0 + 6 * 60e3 + 1000);
    ok('心跳续命：6 分钟后仍新鲜', !!sig && sig.host === 'example.com', JSON.stringify(sig));

    // 无痕标记随心跳保留
    writeJsonl(tabs, [{ ts: t0, host: '', title: '', audible: false, incognito: true, tabCount: 1, source: 'ext' }]);
    writeJson(seen, { seen_ts: t0 + 60e3, host: '', incognito: true });
    sig = br.read(t0 + 60e3 + 1000);
    ok('无痕标记可读出', !!sig && sig.incognito === true, JSON.stringify(sig));

    // 见/行不一致时不采用 seen（防陈旧标记续命别的页面）
    writeJson(seen, { seen_ts: t0 + 5 * 60e3, host: 'other.com', incognito: false });
    sig = br.read(t0 + 5 * 60e3 + 1000);
    ok('seen 与最后一行不一致 → 不续命', sig === null, JSON.stringify(sig));

    // 世界状态库对缺字段/坏字段不崩
    const store = WS.createWorldStore({ now: () => now });
    store.apply({ fg: { ok: true, app: 'x', title: 't', fullscreen: false }, idleMs: 1000, browser: {}, notifications: {} }, { source: 'system' });
    store.apply({ browser: null, notifications: null }, { source: 'system' });
    const s = store.snapshot();
    eq('坏 browser/notifications 不崩：count=0', s.notifications.count, 0);
    eq('坏 browser/notifications 不崩：category 空', s.category, '');
  }

  // ══ ⑥ launcher 接线（静态守卫）════════════════════════════════════
  {
    const src = fs.readFileSync(LAUNCHER, 'utf8');
    ok('launcher 定义通知采集定时器', /function startNotificationCollector\s*\(/.test(src));
    ok('launcher boot 里调用', /startNotificationCollector\s*\(\s*\)\s*;/.test(src));
    ok('采集间隔是 10 分钟', /NOTIFY_COLLECT_INTERVAL_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/.test(src));
    ok('采集调用 -Collect -Json', /'-Collect',\s*'-Json'/.test(src));
    ok('不依赖计划任务', !/schtasks/i.test(src));
  }

  cleanup();

  if (failures.length) {
    console.error('❌ world-phase3：FAIL ' + fail + ' / PASS ' + pass);
    for (const f of failures) console.error('   - ' + f);
    process.exit(1);
  }
  console.log('  ✅ world-phase3：PASS ' + pass + ' / FAIL 0');
})().catch((e) => {
  cleanup();
  console.error('❌ world-phase3：未捕获异常 ' + ((e && e.stack) || e));
  process.exit(1);
});
