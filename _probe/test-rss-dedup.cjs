#!/usr/bin/env node
'use strict';

/**
 * _probe/test-rss-dedup.cjs —— RSS 去重（C1）+ 两阶段投递（C3）单测
 *
 * 钉住：
 *   ① URL 归一化：utm_ 前缀 / fbclid / gclid、fragment、尾斜杠、host 大小写、query 顺序
 *   ② 跨源合簇：同事件 3 条不同源 → 1 簇 / clusterSize=3 / 代表=最高分
 *   ③ 同窗口 MMR：同一事件不会占满 top3；跨簇但标题 Jaccard≥0.7 也不同时入选
 *   ④ 两阶段：selected(delivered:false) ≠ delivered；未投递下轮可选；markDelivered 幂等
 *   ⑤ 旧格式：picked 字符串数组按未投递处理（宁重发一次，不静默丢）
 *   ⑥ 落盘：多源簇写 cluster_key/cluster_size；单条保持旧 10 字段
 *
 * 纯离线，临时目录；不碰真实 data。
 * 用法：node _probe/test-rss-dedup.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const RSS_DIR = path.join(APP, 'plugins', 'community', 'rss-brief');
const RssBrief = require(path.join(RSS_DIR, 'index.js'));
const WorldExtras = require(path.join(APP, 'plugins', 'community', 'world-extras', 'index.js'));
const S = require(path.join(RSS_DIR, 'lib', 'score.js'));

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

const temps = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-dedup-'));
  temps.push(d);
  return d;
}
function cleanup() {
  for (const d of temps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
  }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function readItems(dir) {
  const f = path.join(dir, 'rss-items.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
function sha1(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

const createdPlugins = [];
async function newRss(dir, cfg) {
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
  createdPlugins.push(plugin);
  return plugin;
}
async function newWorldExtras(dir) {
  const plugin = new WorldExtras({ name: 'world-extras' }, {
    getPluginFileConfig() {
      return {
        enabled: true,
        tabs_file: path.join(dir, 'browser-tabs.jsonl'),
        rss_last_file: path.join(dir, 'rss-brief-last.json'),
        rss_items_file: path.join(dir, 'rss-items.jsonl'),
      };
    },
    log() {},
  });
  await plugin.onInit();
  return plugin;
}

// 2026-11-21 修：原来写死 2026-11-20T12:00Z，跑过 12 小时后 ⑥ 的 world-extras
// 12h 新鲜度判断必然过期（测试自己变成时间炸弹）。改为相对当前时间。
const NOW = Date.now();
function mk(id, feed, title, link, score, hours) {
  const h = Number.isFinite(hours) ? hours : 1;
  return {
    id,
    feed_id: feed,
    feed_name: feed,
    title,
    link,
    published_at: new Date(NOW - h * 3600 * 1000).toISOString(),
    summary: '',
    fetched_at: NOW,
    score: Number.isFinite(score) ? score : 0.5,
    pushed: false,
  };
}

// 同一事件：3 个源、标题措辞略不同（token Jaccard ≥0.7）
const EVENT = [
  mk('a', 's1', 'OpenAI 发布 GPT-6 模型，性能大幅提升', 'https://a.example/x?utm_source=1', 0.9),
  mk('b', 's2', 'OpenAI 发布 GPT-6 模型 性能大幅提升', 'https://b.example/y', 0.8),
  mk('c', 's3', 'OpenAI 正式发布 GPT-6 模型：性能大幅提升', 'https://c.example/z', 0.7),
];
const OTHER = [
  mk('d', 's1', '某地天气预报：明日有雨', 'https://d.example/weather', 0.6),
  mk('e', 's2', '央行宣布降息 25 个基点', 'https://e.example/finance', 0.65),
];

function withClusterKeys(items) {
  const clusters = S.clusterItems(items);
  for (const c of clusters) {
    for (const it of c.items) {
      it.cluster_key = c.key;
      it.cluster_size = c.size;
    }
  }
  return clusters;
}

(async () => {
  try {
    // ── ① URL 归一化 ─────────────────────────────────────────────────
    {
      eq('去 utm/fbclid/gclid + fragment + 尾斜杠 + host 小写',
        S.normalizeUrl('HTTPS://Example.COM/Path/?utm_source=x&utm_medium=y&fbclid=z&gclid=1&id=7#frag'),
        'https://example.com/Path?id=7');
      eq('不同跟踪参数/大小写/尾斜杠归一化后相同',
        S.normalizeUrl('https://EXAMPLE.com/a/?utm_campaign=q#top'),
        S.normalizeUrl('https://example.com/a'));
      eq('query 参数顺序不影响身份',
        S.normalizeUrl('https://e.example/x?b=2&a=1'),
        S.normalizeUrl('https://e.example/x?a=1&b=2'));
      eq('空串安全', S.normalizeUrl(''), '');
      ok('非法 URL 不抛', typeof S.normalizeUrl('not a url #x') === 'string',
        S.normalizeUrl('not a url #x'));
    }

    // ── ② 跨源合簇 ───────────────────────────────────────────────────
    {
      const clusters = S.clusterItems(EVENT.concat(OTHER));
      eq('同事件 3 条 + 2 条独立 → 3 簇', clusters.length, 3);
      const big = clusters.find((c) => c.items.some((it) => it.id === 'a'));
      ok('找到同事件簇', !!big);
      eq('簇内 3 条', big.items.length, 3);
      eq('clusterSize=3 个源', big.size, 3);
      eq('代表=最高分 a', big.representative.id, 'a');
      eq('其余 2 条各自成簇', clusters.filter((c) => c.items.length === 1).length, 2);

      // 归一化 URL 相同 → 合簇（标题完全不同也认）
      const u1 = mk('u1', 's1', '标题甲', 'https://Example.com/x/?utm_source=1#f', 0.5);
      const u2 = mk('u2', 's2', '完全不同的标题乙', 'https://example.com/x', 0.4);
      const uc = S.clusterItems([u1, u2]);
      eq('归一化 URL 相同 → 1 簇', uc.length, 1);
      eq('同 URL clusterSize=2', uc[0].size, 2);
    }

    // ── ③ 同窗口 MMR ─────────────────────────────────────────────────
    {
      const items = EVENT.concat(OTHER).map((it) => Object.assign({}, it));
      withClusterKeys(items);
      const top3 = S.selectDiverse(items, 3);
      eq('top3 选满 3 条', top3.length, 3);
      const eventPicked = top3.filter((it) => ['a', 'b', 'c'].indexOf(it.id) >= 0);
      eq('同一事件只占 1 条', eventPicked.length, 1);
      let pairMax = 0;
      for (let i = 0; i < top3.length; i += 1) {
        for (let j = i + 1; j < top3.length; j += 1) {
          pairMax = Math.max(pairMax, S.jaccard(S.textTokens(top3[i].title), S.textTokens(top3[j].title)));
        }
      }
      ok('top3 两两标题 Jaccard <0.7', pairMax < 0.7, String(pairMax));

      // 人为把同事件拆成两个不同 cluster_key：MMR 仍不能同时选
      const x1 = mk('x1', 's1', 'OpenAI 发布 GPT-6 模型 性能大幅提升', 'https://x1.example', 0.9);
      const x2 = mk('x2', 's2', 'OpenAI 发布 GPT-6 模型：性能大幅提升', 'https://x2.example', 0.8);
      x1.cluster_key = 'c1'; x2.cluster_key = 'c2';
      const y1 = mk('y1', 's3', '某地天气预报：明日有雨', 'https://y1.example', 0.7);
      const y2 = mk('y2', 's4', '央行宣布降息 25 个基点', 'https://y2.example', 0.6);
      y1.cluster_key = 'c3'; y2.cluster_key = 'c4';
      const picked2 = S.selectDiverse([x1, x2, y1, y2], 3);
      ok('跨簇但标题几乎相同也不同时入选',
        !(picked2.indexOf(x1) >= 0 && picked2.indexOf(x2) >= 0),
        picked2.map((it) => it.id).join(','));
      eq('MMR 仍能选满 3 条', picked2.length, 3);
    }

    // ── ④ 两阶段投递（真实插件，临时目录）────────────────────────────
    let p = null;
    {
      const dir = tmpDir();
      const base = new Date(2026, 10, 20, 1, 0, 0, 0).getTime();
      const rows = ['a2', 'b2', 'c2'].map((id, i) => ({
        id,
        feed_id: 'hn',
        feed_name: 'HN',
        title: '独立新闻 ' + id,
        link: 'https://e.example/' + id,
        published_at: new Date(base).toISOString(),
        summary: '',
        fetched_at: base,
        score: 0,
        pushed: false,
        // i 只为顺序，保证三个标题 token 不同
      }));
      writeJsonl(path.join(dir, 'rss-items.jsonl'), rows);
      writeJson(path.join(dir, 'feeds.json'), { feeds: [] });

      p = await newRss(dir, {
        enabled: true,
        push_windows: ['08:30', '12:30'],
        max_push_per_day: 3,
        top_n: 2,
        max_items: 400,
      });

      const at1 = new Date(2026, 10, 20, 8, 31, 0, 0).getTime();
      const r1 = await p._maybePush(at1);
      eq('窗口内选中 top_n=2', r1.pushed.length, 2);
      ok('返回值是 {id,delivered:false}', r1.pushed.every((e) => e && e.id && e.delivered === false),
        JSON.stringify(r1.pushed));
      const last1 = readJson(path.join(dir, 'rss-brief-last.json'));
      eq('last.picked 与返回值一致', last1.picked, r1.pushed);
      ok('last 条目全部未投递', last1.picked.every((e) => e.delivered === false));
      eq('pending 记 2 条', p._state.pending.length, 2);
      eq('deliveredCount 仍为 0（选中≠送达）', p._state.deliveredCount, 0);
      eq('旧字段 pushed 仍落盘（兼容）', readItems(dir).filter((x) => x.pushed).length, 2);

      const firstId = r1.picked[0];
      const secondId = r1.picked[1];
      const md1 = p.markDelivered([firstId]);
      eq('markDelivered 计 1 条', md1.delivered, 1);
      eq('pending 剩 1 条', p._state.pending.length, 1);
      eq('deliveredCount=1', p._state.deliveredCount, 1);
      const last2 = readJson(path.join(dir, 'rss-brief-last.json'));
      ok('last 对应条目 delivered=true',
        last2.picked.find((e) => e.id === firstId).delivered === true);
      const md2 = p.markDelivered([firstId]);
      eq('markDelivered 幂等（第二次 0）', md2.delivered, 0);
      eq('幂等不重复计数', p._state.deliveredCount, 1);

      // 下一窗口：fresh c2 + 未投递重试 b2 → 两条都要
      const at2 = new Date(2026, 10, 20, 12, 31, 0, 0).getTime();
      const r2 = await p._maybePush(at2);
      eq('下一窗口选 2 条', r2.picked.length, 2);
      ok('未投递的 b2 被重试', r2.picked.indexOf(secondId) >= 0, r2.picked.join(','));
      ok('新条目 c2 同时入选', r2.picked.indexOf('c2') >= 0, r2.picked.join(','));
      eq('同窗口幂等（第三窗尚未到）',
        (await p._maybePush(at2)).reason, 'window-already-fired');
    }

    // ── ⑤ 旧格式兼容：picked 字符串数组按未投递处理 ─────────────────
    {
      const dir = tmpDir();
      const base = Date.now();
      writeJsonl(path.join(dir, 'rss-items.jsonl'), [
        { id: 'old1', feed_id: 'hn', feed_name: 'HN', title: '旧简报一', link: 'https://e/old1', published_at: new Date(base - 3600e3).toISOString(), summary: '', fetched_at: base, score: 0.5, pushed: true },
        { id: 'old2', feed_id: 'hn', feed_name: 'HN', title: '旧简报二', link: 'https://e/old2', published_at: new Date(base - 7200e3).toISOString(), summary: '', fetched_at: base, score: 0.5, pushed: true },
      ]);
      writeJson(path.join(dir, 'feeds.json'), { feeds: [] });
      writeJson(path.join(dir, 'rss-brief-last.json'), { at: new Date(base).toISOString(), picked: ['old1', 'old2'] });

      const pl = await newRss(dir, { enabled: true, push_windows: ['08:30'] });
      pl._items = pl._readItems();
      pl._loadState();
      pl._syncPendingFromLast();
      eq('旧字符串数组 → pending 两条', pl._state.pending.slice().sort(), ['old1', 'old2']);
      const entries = pl._readLastEntries();
      eq('旧字符串按 delivered:false 读', entries, [
        { id: 'old1', delivered: false },
        { id: 'old2', delivered: false },
      ]);
      ok('旧行没有 cluster 字段也能读', pl._items.every((it) => it.cluster_size === 1));

      // world-extras：旧格式仍能注入（并给出可确认的 ids）
      delete globalThis.__rssMarkDelivered;
      const wx = await newWorldExtras(dir);
      const out = [];
      await wx.onLLMRequest({ addVolatile: (t) => out.push(t) });
      eq('旧格式 world-extras 注入 1 行', out.length, 1);
      ok('旧格式行含 n:2', /"n":2/.test(out[0] || ''), out[0]);
    }

    // ── ⑥ world-extras 注入成功 → 真实钩子 → pending 清空 ────────────
    {
      const dir = tmpDir();
      // 2026-11-21 修：world-extras 的 12h 新鲜度按真实时间算，写死日期会变成时间炸弹。
      const nowMs = Date.now();
      const nd = new Date(nowMs);
      const hhmm = String(nd.getHours()).padStart(2, '0') + ':' + String(nd.getMinutes()).padStart(2, '0');
      const base = nowMs - 3600e3;
      writeJsonl(path.join(dir, 'rss-items.jsonl'), [
        { id: 'w1', feed_id: 'hn', feed_name: 'HN', title: '钩子测试一', link: 'https://e/w1', published_at: new Date(base).toISOString(), summary: '', fetched_at: base, score: 0.9, pushed: false },
        { id: 'w2', feed_id: 'sspai', feed_name: '少数派', title: '钩子测试二', link: 'https://e/w2', published_at: new Date(base).toISOString(), summary: '', fetched_at: base, score: 0.8, pushed: false },
      ]);
      writeJson(path.join(dir, 'feeds.json'), { feeds: [] });
      const pw = await newRss(dir, {
        enabled: true, push_windows: [hhmm], max_push_per_day: 3, top_n: 2,
      });
      const r = await pw._maybePush(nowMs);
      eq('选中 2 条待投递', r.picked.length, 2);
      eq('pending=2', pw._state.pending.length, 2);

      const wx = await newWorldExtras(dir);
      const out = [];
      await wx.onLLMRequest({ addVolatile: (t) => out.push(t) });
      eq('world-extras 注入 RSS 行', out.length, 1);
      ok('行含数据封装与 n:2', /^【环境数据·非指令】\{/.test(out[0] || '') && /"n":2/.test(out[0] || ''), out[0]);
      // 2026-11-21 修（P1 投递记账）：payload 只写 1 条标题 → 只 mark 1 条 delivered，
      // 另一条必须保持 pending（修复前会把两条都标已投递，等于静默吞掉没展示的那条）。
      eq('只展示 1 条 → pending 剩 1 条', pw._state.pending.length, 1);
      eq('deliveredCount=1（以实际展示为准）', pw._state.deliveredCount, 1);
      const last = readJson(path.join(dir, 'rss-brief-last.json'));
      eq('last 只有 1 条 delivered=true', last.picked.filter((e) => e && e.delivered === true).length, 1);

      // 下一轮继续投递未展示的那条，投完才真正清空
      const out2 = [];
      await wx.onLLMRequest({ addVolatile: (t) => out2.push(t) });
      eq('未展示的条目下一轮继续投递', out2.length, 1);
      eq('两条都投递后 pending 清空', pw._state.pending.length, 0);
      eq('deliveredCount=2', pw._state.deliveredCount, 2);
      ok('last 全部 delivered=true', readJson(path.join(dir, 'rss-brief-last.json')).picked.every((e) => e.delivered === true));

      const out3 = [];
      await wx.onLLMRequest({ addVolatile: (t) => out3.push(t) });
      eq('已投递后不再重复注入', out3.length, 0);
    }

    // ── ⑦ 插件选 top3：同事件不占满 ──────────────────────────────────
    {
      const dir = tmpDir();
      const base = new Date(2026, 10, 20, 1, 0, 0, 0).getTime();
      const rows = EVENT.concat(OTHER).map((it) => ({
        id: it.id,
        feed_id: it.feed_id,
        feed_name: it.feed_name,
        title: it.title,
        link: it.link,
        published_at: new Date(base).toISOString(),
        summary: '',
        fetched_at: base,
        score: 0,
        pushed: false,
      }));
      writeJsonl(path.join(dir, 'rss-items.jsonl'), rows);
      writeJson(path.join(dir, 'feeds.json'), { feeds: [] });
      const pc = await newRss(dir, {
        enabled: true, push_windows: ['08:30'], max_push_per_day: 5, top_n: 3,
      });
      const r = await pc._maybePush(new Date(2026, 10, 20, 8, 31, 0, 0).getTime());
      eq('top3 选满', r.picked.length, 3);
      const eventPicked = r.picked.filter((id) => ['a', 'b', 'c'].indexOf(id) >= 0);
      eq('同事件 3 条只出 1 条', eventPicked.length, 1);
      ok('另外两条来自独立事件', r.picked.indexOf('d') >= 0 && r.picked.indexOf('e') >= 0,
        r.picked.join(','));

      // 落盘：3 条同源簇写 cluster 字段；独立条保持旧 10 字段
      const saved = readItems(dir);
      const rowsA = saved.filter((x) => ['a', 'b', 'c'].indexOf(x.id) >= 0);
      eq('簇内 3 条都写 cluster_size=3',
        rowsA.map((x) => x.cluster_size), [3, 3, 3]);
      ok('簇内 cluster_key 一致', new Set(rowsA.map((x) => x.cluster_key)).size === 1);
      const rowD = saved.find((x) => x.id === 'd');
      eq('单条保持旧 10 字段', Object.keys(rowD), [
        'id', 'feed_id', 'feed_name', 'title', 'link', 'published_at',
        'summary', 'fetched_at', 'score', 'pushed',
      ]);
    }

    // ── ⑧ 同一 feed 内 utm 变体只入一条 ─────────────────────────────
    {
      const dir = tmpDir();
      writeJson(path.join(dir, 'feeds.json'), { feeds: [] });
      const pi = await newRss(dir, { enabled: true, push_windows: [] });
      pi._items = [];
      pi._byId = new Map();
      pi._normKey = new Map();
      pi._ingest({ id: 'f1', name: 'F1' }, {
        items: [
          { title: '同文一', link: 'https://e.example/same?utm_source=x' },
          { title: '同文一', link: 'https://e.example/same#frag' },
          { title: '不同文', link: 'https://e.example/other' },
        ],
      }, Date.now());
      eq('同 feed 归一化 URL 只入 1 条', pi._items.length, 2);
      eq('id 用归一化 link', pi._items[0].id, sha1('f1' + 'https://e.example/same'));
    }

    console.log('  ' + (fail === 0 ? '✅' : '❌') + ' RSS 去重/两阶段：PASS ' + pass + ' / FAIL ' + fail);
  } catch (e) {
    fail += 1;
    console.error('  ✗ 测试自身崩溃：' + ((e && e.stack) || e));
    console.log('  ❌ RSS 去重/两阶段：PASS ' + pass + ' / FAIL ' + fail);
  } finally {
    for (const plugin of createdPlugins) {
      try { await plugin.onDestroy(); } catch (e) { /* ignore */ }
    }
    if (globalThis.__rssMarkDelivered && createdPlugins.indexOf(globalThis.__rssMarkDelivered.__owner) < 0) {
      delete globalThis.__rssMarkDelivered;
    }
    cleanup();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
