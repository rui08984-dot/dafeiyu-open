/**
 * js/core/site-category.js — host → 站点类别（世界感知 Phase 3 · 缺口 3）
 *
 * 为什么需要它：浏览器扩展只上报 host（`browser-tabs.jsonl`），世界行里
 * 「前台=chrome；站点=bilibili.com」对模型几乎没有语义。类别把「在哪个网站」
 * 变成「在看视频 / 在刷社交 / 在查文档」，且不引入 path/query —— 那些字段
 * 可能带搜索词、视频 id、token，属于不该进世界状态的细粒度信息。
 *
 * 口径（刻意保守，宁可 other 也不猜）：
 *   ① 先按**域名后缀**匹配（`host === rule` 或 `host.endsWith('.' + rule)`）；
 *   ② 后缀表没命中时，只看 host 的**标签**（点号分隔）是否等于关键词；
 *      不做子串匹配 —— `postman.com` 不能因为含 'post' 就归新闻。
 *   ③ 都不命中 → `other`。未知就是未知，不猜。
 *
 * 纯函数、无 I/O、无第三方依赖，可在 node 里直接单测。
 */

'use strict';

const CATEGORIES = ['video', 'social', 'docs', 'code', 'shop', 'news', 'adult', 'other'];

/** 世界行用的中文短标签（`/world` 仍输出英文枚举 category） */
const CATEGORY_LABELS = {
  video: '视频',
  social: '社交',
  docs: '文档',
  code: '代码',
  shop: '购物',
  news: '新闻',
  adult: '成人',
  other: '其他',
};

// 顺序 = 匹配优先级。adult 放最前：避免某些站点同时命中 video 关键词。
const SUFFIX_RULES = [
  ['adult', [
    'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'onlyfans.com',
    'redtube.com', 'youporn.com', 'spankbang.com', 'chaturbate.com', 'missav.com',
  ]],
  ['video', [
    'bilibili.com', 'b23.tv', 'youtube.com', 'youtu.be', 'netflix.com',
    'iqiyi.com', 'v.qq.com', 'youku.com', 'douyin.com', 'tiktok.com',
    'twitch.tv', 'disneyplus.com', 'hulu.com', 'primevideo.com', 'vimeo.com',
    'dailymotion.com', 'nicovideo.jp', 'mgtv.com', 'acfun.cn', 'huya.com',
    'douyu.com', 'kuaishou.com', 'ixigua.com',
  ]],
  ['social', [
    'weibo.com', 'weibo.cn', 'zhihu.com', 'twitter.com', 'x.com',
    'facebook.com', 'instagram.com', 'reddit.com', 'discord.com',
    'tieba.baidu.com', 'douban.com', 'xiaohongshu.com', 'threads.net',
    'mastodon.social', 'telegram.org', 't.me', 'whatsapp.com', 'linkedin.com',
    'pinterest.com', 'tumblr.com', 'v2ex.com', 'nga.cn',
  ]],
  ['docs', [
    'docs.google.com', 'notion.so', 'notion.site', 'yuque.com', 'feishu.cn',
    'larksuite.com', 'confluence.atlassian.com', 'office.com', 'office365.com',
    'sharepoint.com', 'onenote.com', 'evernote.com', 'obsidian.md',
    'readthedocs.io', 'gitbook.io', 'zotero.org', 'overleaf.com',
    'developer.mozilla.org', 'docs.microsoft.com', 'learn.microsoft.com',
  ]],
  ['code', [
    'github.com', 'gitlab.com', 'gitee.com', 'bitbucket.org', 'stackoverflow.com',
    'stackexchange.com', 'superuser.com', 'serverfault.com', 'npmjs.com',
    'pypi.org', 'crates.io', 'rubygems.org', 'packagist.org', 'hub.docker.com',
    'vercel.com', 'netlify.com', 'railway.app', 'render.com', 'codepen.io',
    'codesandbox.io', 'replit.com', 'leetcode.com', 'hackerrank.com', 'kaggle.com',
    'sourceforge.net', 'coding.net', 'csdn.net', 'juejin.cn', 'segmentfault.com',
  ]],
  ['shop', [
    'taobao.com', 'tmall.com', 'jd.com', 'amazon.com', 'amazon.cn',
    'pinduoduo.com', 'ebay.com', 'etsy.com', 'aliexpress.com', '1688.com',
    'suning.com', 'vip.com', 'walmart.com', 'target.com', 'bestbuy.com',
    'store.steampowered.com', 'store.epicgames.com',
  ]],
  ['news', [
    'news.ycombinator.com', 'bbc.com', 'bbc.co.uk', 'cnn.com', 'reuters.com',
    'nytimes.com', 'theguardian.com', 'washingtonpost.com', 'bloomberg.com',
    'cnbc.com', 'forbes.com', 'techcrunch.com', 'theverge.com', 'wired.com',
    'arstechnica.com', '36kr.com', 'sspai.com', 'ifanr.com', 'thepaper.cn',
    'zaobao.com', 'sina.com.cn', 'sohu.com', '163.com', 'news.qq.com',
    'people.com.cn', 'xinhuanet.com', 'chinanews.com.cn', 'caixin.com',
    'jiemian.com', 'huxiu.com', 'leiphone.com', 'pingwest.com', 'ithome.com',
    'cnbeta.com', 'solidot.org', 'engadget.com', 'ft.com', 'economist.com',
    'apnews.com', 'npr.org', 'aljazeera.com', 'scmp.com', 'nikkei.com', 'asahi.com',
  ]],
];

// 标签级关键词：只有 host 的某个 label **完全等于**关键词才命中。
// 刻意不做子串：`postman.com` 不该因为含 post 变新闻，`store.example.com`
// 也不该因为含 store 变购物 —— 那正是「猜」。
const LABEL_RULES = [
  ['adult', ['porn', 'porno', 'sex', 'xxx', 'adult', 'hentai']],
  ['video', ['video', 'videos', 'movie', 'movies', 'tv', 'anime']],
  ['social', ['social', 'chat', 'forum', 'bbs', 'tieba']],
  ['docs', ['docs', 'doc', 'wiki']],
  ['code', ['git', 'code', 'dev']],
  ['shop', ['shop', 'store', 'mall', 'buy']],
  ['news', ['news', 'daily', 'press']],
];

const SUFFIX_MAP = (() => {
  const map = new Map();
  for (const [category, hosts] of SUFFIX_RULES) {
    for (const host of hosts) if (!map.has(host)) map.set(host, category);
  }
  return map;
})();

/**
 * 把「host 或 URL」收敛成小写 hostname，并剥掉 path/query/port。
 * 非法/空输入返回 ''（调用方据此归 other，而不是猜一个类别）。
 */
function normalizeHost(input) {
  let s = String(input == null ? '' : input).trim().toLowerCase();
  if (!s) return '';
  // 带协议：交给 URL 解析（它也会处理 IPv6/端口）
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      const u = new URL(s);
      s = String(u.hostname || '');
    } catch (e) {
      return '';
    }
  } else {
    // 没协议也可能带 path/query（扩展理论上只给 host，这里兜一层）
    s = s.split('/')[0].split('?')[0].split('#')[0];
    s = s.replace(/:\d+$/, '');
  }
  s = s.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!s || s.length > 253) return '';
  // 只接受域名形态：字母数字/点/连字符；允许 punycode；拒绝空白与斜杠
  if (!/^[a-z0-9.-]+$/.test(s)) return '';
  if (s.indexOf('.') < 0) return '';
  return s;
}

/**
 * host → 类别（video / social / docs / code / shop / news / adult / other）。
 * 永不抛异常；未知一律 other。
 */
function categoryOf(input) {
  const host = normalizeHost(input);
  if (!host) return 'other';

  // ① 后缀表（含自身）
  for (const [suffix, category] of SUFFIX_MAP) {
    if (host === suffix || host.endsWith('.' + suffix)) return category;
  }

  // ② 标签关键词（精确等于某个 label）
  const labels = host.split('.');
  for (const [category, words] of LABEL_RULES) {
    for (const label of labels) {
      if (words.indexOf(label) >= 0) return category;
    }
  }
  return 'other';
}

module.exports = {
  CATEGORIES,
  CATEGORY_LABELS,
  SUFFIX_RULES,
  LABEL_RULES,
  normalizeHost,
  categoryOf,
};
