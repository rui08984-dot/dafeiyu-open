#!/usr/bin/env node
'use strict';

/**
 * _probe/test-rss-brief.cjs —— RSS 今日简报（世界感知 Phase 2 / §5.2）
 *
 * 钉住的东西：
 *   ① 解析：RSS 2.0 / Atom / CDATA / 实体 / 命名空间 / 坏 XML（失败返回 ok:false，不抛）
 *   ② 去重：同一 feed 两次抓取不产生重复 id；score 重算
 *   ③ 剪枝：>72h 丢弃、max_items 只留最新
 *   ④ 打分排序：recency / interest / novelty 各造一条；冷启动只按 0.6 recency + 0.4 interest
 *   ⑤ 推送窗口幂等：同一窗口只推一次；跨天重置每日计数
 *   ⑥ 抓取失败隔离：单个 feed 失败不影响其他，lastError 发声
 *   ⑦ 端到端：本地 Node http 起临时端口喂 RSS，真实 fetch 落出一行 rss-items
 *
 * 纯离线（除最后一条本地回环）；临时目录，不碰真实 data。
 * 用法：node _probe/test-rss-brief.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const PLUGIN_DIR = path.join(APP, 'plugins', 'community', 'rss-brief');
const RssBriefPlugin = require(path.join(PLUGIN_DIR, 'index.js'));
const { parseFeed } = require(path.join(PLUGIN_DIR, 'lib', 'rss-parse.js'));
const SCORE = require(path.join(PLUGIN_DIR, 'lib', 'score.js'));
const T = RssBriefPlugin.__test;

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}
function eq(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) { pass += 1; return; }
  fail += 1;
  console.error('  ✗ ' + name + ' —— got ' + a + ' want ' + b);
}
function near(name, got, want, eps) {
  if (Math.abs(Number(got) - Number(want)) <= (eps || 1e-6)) { pass += 1; return; }
  fail += 1;
  console.error('  ✗ ' + name + ' —— got ' + got + ' want ~' + want);
}

const temps = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-brief-'));
  temps.push(d);
  return d;
}
function cleanup() {
  for (const d of temps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
  }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
function readItems(dir) {
  const f = path.join(dir, 'rss-items.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
async function newPlugin(dir, cfg) {
  const logs = [];
  const ctx = {
    recordsDir: dir,
    logs,
    log(level, msg) { logs.push({ level, msg }); },
    getPluginFileConfig() { return cfg || {}; },
    getConfig() { return {}; },
  };
  const plugin = new RssBriefPlugin({ name: 'rss-brief' }, ctx);
  await plugin.onInit();
  plugin._running = true;
  plugin._cfg = plugin._readConfig();
  return { plugin, ctx };
}
function mockFetch(routes) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const key = String(url);
    calls.push(key);
    const v = routes[key];
    if (v instanceof Error) throw v;
    if (v === undefined) throw new Error('mock fetch: 未配置路由 ' + key);
    return { ok: true, status: 200, text: async () => v };
  };
  const restore = () => { globalThis.fetch = real; };
  // 防回归：让用例能断言「插件确实走了注入的 fetch」，而不是静默用了别的东西
  restore.calls = calls;
  return restore;
}
function sha1(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

/**
 * 防回归：fixture 的日期必须相对「现在」，不能写死。
 * 2026-11-24 故障：RSS_XML 里硬编码 2026-11-20，过了 72h 后被 _prune 全部剪掉，
 * 用例表现为「首次落盘 2 条 got 0」——不是插件 bug，是 fixture 过期（时间炸弹）。
 */
function rssDate(hoursAgo) {
  return new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
}
function rfc822(hoursAgo) {
  return new Date(Date.now() - hoursAgo * 3600 * 1000).toUTCString();
}

const RSS_XML = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">\n'
  + '<channel><title>Mock Feed</title>\n'
  + '<description><![CDATA[<item>这不是真条目，只是频道描述里的假标签</item>]]></description>\n'
  + '<item>\n'
  + '  <title><![CDATA[Hello & <World>]]></title>\n'
  + '  <link>https://example.com/a?x=1&amp;y=2</link>\n'
  + '  <dc:date>2026-11-20T08:00:00Z</dc:date>\n'
  + '  <description><![CDATA[<p>Hello &amp; <b>world</b></p>]]></description>\n'
  + '  <content:encoded><![CDATA[<div>full html body</div>]]></content:encoded>\n'
  + '</item>\n'
  + '<item>\n'
  + '  <title>第二 条 &#8212; test</title>\n'
  + '  <link>https://example.com/b</link>\n'
  + '  <pubDate>Thu, 20 Nov 2026 09:00:00 GMT</pubDate>\n'
  + '  <description>A &amp; B &lt; C &quot;D&quot;</description>\n'
  + '</item>\n'
  + '</channel></rss>';

const ATOM_XML = '<?xml version="1.0" encoding="utf-8"?>\n'
  + '<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Mock</title>\n'
  + '<entry>\n'
  + '  <title>Atom 标题</title>\n'
  + '  <link rel="self" href="https://example.com/self"/>\n'
  + '  <link rel="alternate" type="text/html" href="https://example.com/e1"/>\n'
  + '  <published>2026-11-20T07:30:00.000Z</published>\n'
  + '  <summary type="html">&lt;p&gt;hi &amp;amp; bye&lt;/p&gt;</summary>\n'
  + '</entry></feed>';

const SINGLE_XML = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<rss version="2.0"><channel><title>Single</title>\n'
  + '<item>\n'
  + '  <title>单条端到端</title>\n'
  + '  <link>https://example.com/only</link>\n'
  + '  <pubDate>Thu, 20 Nov 2026 10:00:00 GMT</pubDate>\n'
  + '  <description>一条就够</description>\n'
  + '</item>\n'
  + '</channel></rss>';

/**
 * 把固定 XML 里的日期改写成「相对现在」的时间戳。
 * ① 解析用例继续用字面量（断言的就是已知字符串 → ISO 的确定性）；
 * ③⑥⑧ 走 _tick 的管道用例必须先过 _prune 的 72h 门槛，否则 fixture 一过期就假红。
 */
function freshXml(xml) {
  return xml
    .replace(/<dc:date>[^<]*<\/dc:date>/g, '<dc:date>' + rssDate(2) + '</dc:date>')
    .replace(/<pubDate>[^<]*<\/pubDate>/g, '<pubDate>' + rfc822(1) + '</pubDate>');
}
const RSS_XML_FRESH = () => freshXml(RSS_XML);
const SINGLE_XML_FRESH = () => freshXml(SINGLE_XML);

(async () => {
  try {
    // ── ① 解析 ─────────────────────────────────────────────────────────
    {
      const r = parseFeed(RSS_XML);
      ok('RSS 解析成功', r.ok === true, r.error);
      eq('RSS 条目数', r.items.length, 2);
      eq('CDATA 标题保留字面 <', r.items[0].title, 'Hello & <World>');
      eq('link 实体解码', r.items[0].link, 'https://example.com/a?x=1&y=2');
      eq('dc:date 命名空间', r.items[0].published_at, '2026-11-20T08:00:00.000Z');
      eq('summary 剥 HTML + 解码实体', r.items[0].summary, 'Hello & world');
      eq('数字实体解码', r.items[1].title, '第二 条 — test');
      eq('pubDate 解析为 ISO', r.items[1].published_at, '2026-11-20T09:00:00.000Z');
      eq('description 常见实体', r.items[1].summary, 'A & B < C "D"');

      const a = parseFeed(ATOM_XML);
      ok('Atom 解析成功', a.ok === true, a.error);
      eq('Atom 跳过 rel=self 取 alternate', a.items[0].link, 'https://example.com/e1');
      eq('Atom published', a.items[0].published_at, '2026-11-20T07:30:00.000Z');
      eq('Atom 转义 HTML summary', a.items[0].summary, 'hi & bye');
      eq('Atom format', a.format, 'atom');

      const empty = parseFeed('<rss version="2.0"><channel><title>empty</title></channel></rss>');
      ok('空 feed 是合法文档', empty.ok === true && empty.items.length === 0);

      const bad1 = parseFeed('<html><body>not a feed</body></html>');
      ok('非 feed 文档返回 ok:false', bad1.ok === false && typeof bad1.error === 'string', JSON.stringify(bad1));
      const bad2 = parseFeed('<rss><channel><item><title>截断');
      ok('截断 XML 返回 ok:false（不抛）', bad2.ok === false, JSON.stringify(bad2));
      const bad3 = parseFeed('');
      ok('空字符串返回 ok:false', bad3.ok === false);
      const bad4 = parseFeed(null);
      ok('非字符串返回 ok:false', bad4.ok === false);

      const longText = '字'.repeat(500);
      const longFeed = '<rss><channel><item><title>长摘要</title><link>https://e/long</link>'
        + '<description>' + longText + '</description></item></channel></rss>';
      const lr = parseFeed(longFeed);
      ok('summary ≤200 字（含省略号）', Array.from(lr.items[0].summary).length <= 200,
        String(Array.from(lr.items[0].summary).length));
    }

    // ── ② 打分（纯函数）───────────────────────────────────────────────
    {
      const NOW = Date.parse('2026-11-20T12:00:00.000Z');
      const mk = (title, hours, summary) => ({
        title,
        summary: summary || '',
        published_at: new Date(NOW - hours * 3600 * 1000).toISOString(),
        fetched_at: NOW,
      });
      const interests = ['熬夜', '代码', 'rust'];

      const hit = SCORE.scoreItem(mk('熬夜写代码', 1), {
        now: NOW, interests, sourceTrust: 0.5, recentTitles: [], pushedCount: 1,
      });
      const miss = SCORE.scoreItem(mk('完全无关的体育新闻', 20), {
        now: NOW, interests, sourceTrust: 0.5, recentTitles: [], pushedCount: 1,
      });
      ok('命中兴趣的条目排序更高', hit.score > miss.score, hit.score + ' vs ' + miss.score);
      const freshSame = SCORE.scoreItem(mk('同一标题', 1), {
        now: NOW, interests, sourceTrust: 0.5, recentTitles: [], pushedCount: 1,
      });
      const oldSame = SCORE.scoreItem(mk('同一标题', 30), {
        now: NOW, interests, sourceTrust: 0.5, recentTitles: [], pushedCount: 1,
      });
      ok('recency：同内容更旧的分数更低', freshSame.score > oldSame.score,
        freshSame.score + ' vs ' + oldSame.score);
      eq('interest 命中 2/3 词', hit.interest, Number((2 / 3).toFixed(6)));
      near('recency = exp(-1/18)', hit.recency, Math.exp(-1 / 18), 1e-6);

      const dup = SCORE.scoreItem(mk('熬夜写代码 教程', 0), {
        now: NOW, interests, sourceTrust: 0.5, recentTitles: ['熬夜写代码 教程'], pushedCount: 1,
      });
      ok('Jaccard=1 标记 dup 且 score=0', dup.dup === true && dup.score === 0, JSON.stringify(dup));

      const partial = SCORE.scoreItem(mk('熬夜 写代码 教程', 0), {
        now: NOW, interests, sourceTrust: 0.5, recentTitles: ['熬夜 写代码 别的'], pushedCount: 1,
      });
      ok('部分相似 novelty = 1 - Jaccard', partial.dup === false && partial.novelty > 0 && partial.novelty < 1,
        JSON.stringify(partial));

      const expired = SCORE.scoreItem(mk('三天前', 73), {
        now: NOW, interests, sourceTrust: 0.5, recentTitles: [], pushedCount: 1,
      });
      ok('>72h 直接 dropped', expired.dropped === true && expired.score === 0, JSON.stringify(expired));

      const cold = SCORE.scoreItem(mk('无兴趣', 0), {
        now: NOW, interests: [], sourceTrust: 1, recentTitles: [], pushedCount: 0, clickCount: 0,
      });
      near('冷启动 = 0.6*recency + 0.4*interest', cold.score, 0.6, 1e-6);
      ok('冷启动标记', cold.coldStart === true);

      const full = SCORE.scoreItem(mk('x', 0), {
        now: NOW, interests: ['x'], sourceTrust: 0.5, recentTitles: [], pushedCount: 1, clickCount: 0,
      });
      near('完整公式 = .4*1 + .25*1 + .2*.5 + .15*1', full.score, 0.9, 1e-6);
      ok('冷启动与完整公式可区分', full.coldStart === false);

      const tokens = SCORE.textTokens('熬夜写代码 Rust 2026');
      ok('中文 2-gram 分词', tokens.has('熬夜') && tokens.has('代码'), Array.from(tokens).join(','));
      ok('英文词分词', tokens.has('rust'), Array.from(tokens).join(','));
    }

    // ── ③ 去重：同一 feed 两次抓取只有一行 ─────────────────────────────
    {
      const dir = tmpDir();
      writeJson(path.join(dir, 'feeds.json'), {
        feeds: [{ id: 'hn', url: 'https://mock/rss', name: 'HN', weight: 1, enabled: true }],
      });
      const restore = mockFetch({ 'https://mock/rss': RSS_XML_FRESH() });
      try {
        const { plugin } = await newPlugin(dir, { enabled: true, push_windows: [] });
        const r1 = await plugin._tick('test');
        ok('首次 tick 成功', r1.ok === true, JSON.stringify(r1));
        // 防回归：断言插件确实调用了注入的 fetch（否则 mock 没生效会伪装成「抓取 0 条」）
        eq('插件走了注入的 fetch', restore.calls, ['https://mock/rss']);
        const lines1 = readItems(dir);
        // 防回归：断言解析器对固定 XML 稳定返回 2 条（区分「解析回归」与「剪枝误杀」）
        eq('解析器对该 XML 返回 2 条', parseFeed(RSS_XML_FRESH()).items.length, 2);
        eq('首次落盘 2 条', lines1.length, 2);
        eq('id = sha1(feed_id+link)', lines1[0].id, sha1('hn' + lines1[0].link));
        ok('两条 id 都按契约生成', lines1.some((x) => x.id === sha1('hn' + 'https://example.com/a?x=1&y=2')));

        const r2 = await plugin._tick('test');
        ok('二次 tick 成功', r2.ok === true, JSON.stringify(r2));
        const lines2 = readItems(dir);
        eq('两次抓取不产生重复 id', lines2.length, 2);
        eq('同一 id 保留', lines2.map((x) => x.id).sort(), lines1.map((x) => x.id).sort());
        ok('score 被重算为数字', lines2.every((x) => typeof x.score === 'number' && x.score >= 0 && x.score <= 1));
        ok('push_windows=[] 时不会自行推送', lines2.every((x) => x.pushed === false));
        await plugin.onDestroy();
      } finally {
        restore();
      }
    }

    // ── ④ 剪枝：72h 与 max_items ──────────────────────────────────────
    {
      const dir = tmpDir();
      const now = Date.now();
      const mk = (id, hours) => ({
        id, feed_id: 'hn', feed_name: 'HN', title: 't-' + id, link: 'https://e/' + id,
        published_at: new Date(now - hours * 3600 * 1000).toISOString(), summary: '',
        fetched_at: now - hours * 3600 * 1000, score: 0, pushed: false,
      });
      fs.writeFileSync(path.join(dir, 'rss-items.jsonl'),
        [mk('old', 80), mk('fresh', 1)].map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
      writeJson(path.join(dir, 'feeds.json'), { feeds: [] });
      const { plugin } = await newPlugin(dir, { enabled: true, push_windows: [] });
      const r = await plugin._tick('test');
      ok('空源 tick 成功', r.ok === true, JSON.stringify(r));
      const lines = readItems(dir);
      eq('>72h 被剪掉', lines.map((x) => x.id), ['fresh']);

      // max_items：5 条新的只留最新 3 条
      const dir2 = tmpDir();
      fs.writeFileSync(path.join(dir2, 'rss-items.jsonl'),
        [1, 2, 3, 4, 5].map((i) => JSON.stringify(mk('m' + i, i))).join('\n') + '\n', 'utf8');
      writeJson(path.join(dir2, 'feeds.json'), { feeds: [] });
      const p2 = (await newPlugin(dir2, { enabled: true, push_windows: [], max_items: 3 })).plugin;
      await p2._tick('test');
      const kept = readItems(dir2);
      eq('max_items=3 只留 3 条', kept.length, 3);
      eq('留下的是最新 3 条', kept.map((x) => x.id).sort(), ['m1', 'm2', 'm3']);
      await plugin.onDestroy();
      await p2.onDestroy();
    }

    // ── ⑤ 推送窗口：±5 分钟、幂等、跨天重置 ───────────────────────────
    {
      const dir = tmpDir();
      const base = new Date(2026, 10, 20, 1, 0, 0, 0).getTime();
      const titles = ['alpha 新闻', 'beta 体育', 'gamma 科技', 'delta 财经'];
      const items = titles.map((title, i) => ({
        id: 'id' + i,
        feed_id: 'hn',
        feed_name: 'HN',
        title,
        link: 'https://e/' + i,
        published_at: new Date(base).toISOString(),
        summary: '',
        fetched_at: base,
        score: 0,
        pushed: false,
      }));
      fs.writeFileSync(path.join(dir, 'rss-items.jsonl'), items.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
      writeJson(path.join(dir, 'feeds.json'), { feeds: [] });

      const { plugin } = await newPlugin(dir, {
        enabled: true, push_windows: ['08:30'], max_push_per_day: 3, top_n: 2, max_items: 400,
      });

      const at0831 = new Date(2026, 10, 20, 8, 31, 0, 0).getTime();
      const r1 = await plugin._maybePush(at0831);
      eq('窗口内推 top_n=2', r1.pushed.length, 2);
      const last = JSON.parse(fs.readFileSync(path.join(dir, 'rss-brief-last.json'), 'utf8'));
      eq('last.json 字段', Object.keys(last).sort(), ['at', 'card', 'picked']);
      eq('last.picked 与返回值一致', last.picked, r1.pushed);
      eq('推送后 pushed=true 落盘', readItems(dir).filter((x) => x.pushed).length, 2);
      eq('当日计数 2', plugin._state.pushCount, 2);

      const r1b = await plugin._maybePush(at0831);
      eq('同一窗口二次调用不推', r1b.pushed.length, 0);
      eq('同一窗口幂等（仍 2 条）', readItems(dir).filter((x) => x.pushed).length, 2);
      eq('幂等原因', r1b.reason, 'window-already-fired');

      const outside = await plugin._maybePush(new Date(2026, 10, 20, 8, 45, 0, 0).getTime());
      eq('超出 ±5 分钟不触发', outside.reason, 'no-window');

      // 跨天：计数重置，剩余 2 条候选再推 2 条
      const nextDay = await plugin._maybePush(new Date(2026, 10, 21, 8, 31, 0, 0).getTime());
      eq('跨天计数重置后可再推', nextDay.pushed.length, 2);
      eq('累计 pushed=4', readItems(dir).filter((x) => x.pushed).length, 4);
      eq('新一天计数 2', plugin._state.pushCount, 2);

      // 纯函数窗口边界
      const t0834 = new Date(2026, 10, 20, 8, 34, 0, 0).getTime();
      const t0836 = new Date(2026, 10, 20, 8, 36, 0, 0).getTime();
      ok('±5 分钟边界内命中', !!T.windowAt(t0834, ['08:30'], 5 * 60000));
      ok('±5 分钟边界外不命中', T.windowAt(t0836, ['08:30'], 5 * 60000) === null);
      eq('push_windows 支持逗号字符串', T.normalizeWindows('08:30, 12:30'), ['08:30', '12:30']);
      eq('push_windows 支持数组', T.normalizeWindows(['8:30', '19:30']), ['08:30', '19:30']);
      eq('push_windows 空数组表示不推', T.normalizeWindows([]), []);
      await plugin.onDestroy();
    }

    // ── ⑥ 抓取失败隔离 + lastError 发声 ───────────────────────────────
    {
      const dir = tmpDir();
      writeJson(path.join(dir, 'feeds.json'), {
        feeds: [
          { id: 'good', url: 'https://mock/good', name: 'Good', weight: 1, enabled: true },
          { id: 'bad', url: 'https://mock/bad', name: 'Bad', weight: 0.5, enabled: true },
        ],
      });
      const restore = mockFetch({
        'https://mock/good': RSS_XML_FRESH(),
        'https://mock/bad': new Error('connect ECONNREFUSED (mock)'),
      });
      try {
        const { plugin } = await newPlugin(dir, { enabled: true, push_windows: [] });
        const r = await plugin._tick('test');
        ok('单源失败不炸整轮', r.ok === true, JSON.stringify(r));
        eq('两个源都被尝试过', restore.calls.slice().sort(), ['https://mock/bad', 'https://mock/good']);
        eq('好源仍落盘', readItems(dir).length, 2);
        ok('lastError 指向坏源', plugin._state.lastError && plugin._state.lastError.kind === 'fetch:bad',
          JSON.stringify(plugin._state.lastError));
        ok('lastError 有 message', typeof plugin._state.lastError.message === 'string'
          && plugin._state.lastError.message.length > 0);
        await plugin.onDestroy();
      } finally {
        restore();
      }
    }

    // ── ⑦ 兴趣词表：从用户事实 + 核心记忆抽词（≤80）─────────────────
    {
      const dir = tmpDir();
      writeJson(path.join(dir, '用户事实.json'), {
        version: 1,
        facts: [{ fact: '用户喜欢熬夜写代码，关注 Rust 与 AI 新闻' }],
      });
      fs.writeFileSync(path.join(dir, '核心用户记忆.txt'),
        '用户叫小C（user），程序员，习惯熬夜。常看 True Detective。', 'utf8');
      const { plugin } = await newPlugin(dir, { enabled: true, push_windows: [] });
      const words = plugin._loadInterests(Date.now());
      ok('词表非空且 ≤80', words.length > 0 && words.length <= 80, String(words.length));
      ok('抽到中文 2-gram「熬夜」', words.indexOf('熬夜') >= 0, words.slice(0, 20).join(','));
      ok('抽到英文词 true/detective', words.indexOf('true') >= 0 || words.indexOf('detective') >= 0,
        words.join(','));
      await plugin.onDestroy();
    }

    // ── ⑧ 端到端：本地 http 临时端口 → 真实 fetch → rss-items 一行 ────
    {
      const dir = tmpDir();
      const singleXml = SINGLE_XML_FRESH();
      const server = http.createServer((req, res) => {
        if (req.url !== '/feed') { res.writeHead(404); res.end('nope'); return; }
        res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
        res.end(singleXml);
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      try {
        const port = server.address().port;
        writeJson(path.join(dir, 'feeds.json'), {
          feeds: [{ id: 'hn', url: 'http://127.0.0.1:' + port + '/feed', name: 'HN', weight: 1, enabled: true }],
        });
        const { plugin } = await newPlugin(dir, { enabled: true, push_windows: [] });
        const r = await plugin._tick('e2e');
        ok('端到端 tick 成功', r.ok === true, JSON.stringify(r));
        const lines = readItems(dir);
        eq('端到端落盘 1 行 rss-items', lines.length, 1);
        const first = lines[0];
        eq('契约字段齐全且顺序固定', Object.keys(first), [
          'id', 'feed_id', 'feed_name', 'title', 'link', 'published_at',
          'summary', 'fetched_at', 'score', 'pushed',
        ]);
        eq('feed_id', first.feed_id, 'hn');
        eq('feed_name', first.feed_name, 'HN');
        eq('id = sha1(feed_id+link)', first.id, sha1('hn' + first.link));
        ok('published_at 是 ISO', /^\d{4}-\d{2}-\d{2}T/.test(String(first.published_at)));
        ok('summary ≤200 字', Array.from(String(first.summary)).length <= 200);
        ok('score 在 [0,1]', first.score >= 0 && first.score <= 1, String(first.score));
        eq('pushed 默认 false', first.pushed, false);
        console.log('  e2e 产出示例: ' + JSON.stringify(first));
        await plugin.onDestroy();
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }

    console.log('  ' + (fail === 0 ? '✅' : '❌') + ' RSS 今日简报：PASS ' + pass + ' / FAIL ' + fail);
    cleanup();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    cleanup();
    console.error('  ✗ 测试自身崩溃：' + (e && e.stack || e));
    console.log('  ❌ RSS 今日简报：PASS ' + pass + ' / FAIL ' + (fail + 1));
    process.exit(1);
  }
})();
