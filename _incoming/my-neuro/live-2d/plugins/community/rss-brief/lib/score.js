'use strict';

const crypto = require('crypto');

/**
 * lib/score.js —— RSS 条目显著性打分（纯函数，零依赖；只用 Node 内置模块）
 *
 * 公式（调研 §Q2 / §5.2）：
 *   score = 0.40*recency + 0.25*interest + 0.20*source_trust + 0.15*novelty
 * 冷启动（pushedCount===0 且无点击数据）：
 *   score = 0.60*recency + 0.40*interest
 *
 * 判据：
 *   - recency = exp(-age_hours/18)；>72h 直接 dropped（不进候选）
 *   - interest = 命中词数 / min(5, 词表长度)，饱和到 1（命中 5 个不同词即满分）
 *   - novelty = 1 - max_jaccard(标题 tokens, 最近 7 天已推送标题)；
 *     Jaccard ≥ 0.7 视为重复：score=0 且 dup=true
 *   - 所有输入都做防御：坏日期按 0 小时、坏词表按空、缺字段不抛
 */

const DECAY_HOURS = 18;
const MAX_AGE_HOURS = 72;
const DUP_JACCARD = 0.7;
const CLUSTER_JACCARD = 0.7;
const MMR_LAMBDA = 0.7;
const INTEREST_SATURATION = 5;

// 常见跟踪参数（小写）。utm_* 按前缀剔除；这些按整名剔除。
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'gbraid', 'wbraid',
  'mc_cid', 'mc_eid', 'mkt_tok', '_hsenc', '_hsmi', 'hsctatracking',
  'igshid', 'spm', 'scm', 'ref_src', 'ref_url', '__twitter_impression',
  'vero_conv', 'vero_id', 'wt_mc', 'oly_anon_id', 'oly_enc_id',
  'trk', 'trkcampaign', 'sc_cid', 'cmpid', 'ocid',
]);

function clamp01(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : NaN;
  }
  return NaN;
}

/** 条目的时间基准：published_at → fetched_at → 视为「刚刚」（不因缺时间被误删） */
function itemTimeMs(item) {
  if (!item || typeof item !== 'object') return NaN;
  const published = toMs(item.published_at);
  if (Number.isFinite(published)) return published;
  const fetched = toMs(item.fetched_at);
  if (Number.isFinite(fetched)) return fetched;
  return NaN;
}

function ageHours(item, nowMs) {
  const t = itemTimeMs(item);
  if (!Number.isFinite(t)) return 0;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const hours = (now - t) / 3600000;
  return hours > 0 ? hours : 0;
}

/** 标题/文本分词：中文连续段取 2-gram（单字段保留单字）+ 英文/数字词 */
function textTokens(text) {
  const out = new Set();
  const s = String(text || '').toLowerCase();
  if (!s) return out;
  const latinRe = /[a-z][a-z0-9_+#.-]*/g;
  let m;
  while ((m = latinRe.exec(s))) {
    if (m[0].length >= 2) out.add(m[0]);
  }
  const cjkRe = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
  while ((m = cjkRe.exec(s))) {
    const run = m[0];
    const chars = Array.from(run);
    if (chars.length === 1) {
      out.add(chars[0]);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i += 1) {
      out.add(chars[i] + chars[i + 1]);
    }
  }
  return out;
}

function jaccard(a, b) {
  const sa = a instanceof Set ? a : new Set(a || []);
  const sb = b instanceof Set ? b : new Set(b || []);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union > 0 ? inter / union : 0;
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * interest：词表由调用方传入（通常是中国 2-gram + 英文词）。
 * 中文词按子串命中；英文词按词边界命中（避免 "art" 命中 "start"）。
 * 命中数饱和到 INTEREST_SATURATION（5）个，返回 0..1。
 */
function computeInterest(item, interests) {
  if (!Array.isArray(interests) || interests.length === 0) return 0;
  const haystack = String((item && item.title) || '') + ' ' + String((item && item.summary) || '');
  if (!haystack.trim()) return 0;
  const text = haystack.toLowerCase();
  const seen = new Set();
  let matched = 0;
  for (const raw of interests) {
    if (typeof raw !== 'string') continue;
    const term = raw.trim().toLowerCase();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    let hit = false;
    if (CJK_RE.test(term)) {
      hit = text.indexOf(term) >= 0;
    } else {
      const re = new RegExp('(^|[^a-z0-9])' + escapeRegExp(term) + '([^a-z0-9]|$)', 'i');
      hit = re.test(text);
    }
    if (hit) matched += 1;
  }
  if (matched === 0) return 0;
  const cap = Math.min(INTEREST_SATURATION, Math.max(1, seen.size));
  return clamp01(matched / cap, 0);
}

/** 最近已推送标题里的最大 Jaccard 相似度 */
function maxJaccard(title, recentTitles) {
  const tokens = textTokens(title);
  let max = 0;
  let best = '';
  if (!Array.isArray(recentTitles) || tokens.size === 0) return { max, tokens, best };
  for (const t of recentTitles) {
    if (typeof t !== 'string' || !t.trim()) continue;
    const j = jaccard(tokens, textTokens(t));
    if (j > max) { max = j; best = t; }
  }
  return { max, tokens, best };
}

/**
 * @param {object} item - {title, summary, published_at, fetched_at}
 * @param {object} opts - {now, interests, sourceTrust, recentTitles, pushedCount, clickCount, coldStart}
 * @returns {{score:number, recency:number, interest:number, sourceTrust:number,
 *            novelty:number, dup:boolean, dropped:boolean, ageHours:number,
 *            reason?:string, matchedTitle?:string}}
 */
function scoreItem(item, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const nowMs = toMs(o.now);
  const effectiveNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const age = ageHours(item, effectiveNow);
  const recency = age <= 0 ? 1 : Math.exp(-age / DECAY_HOURS);

  if (age > MAX_AGE_HOURS) {
    return {
      score: 0,
      recency: Number(recency.toFixed(6)),
      interest: 0,
      sourceTrust: clamp01(o.sourceTrust, 0.5),
      novelty: 0,
      dup: false,
      dropped: true,
      ageHours: Number(age.toFixed(3)),
      reason: 'expired',
    };
  }

  const interest = computeInterest(item, o.interests);
  const sourceTrust = clamp01(o.sourceTrust, 0.5);
  const near = maxJaccard(item && item.title, o.recentTitles);

  if (near.max >= DUP_JACCARD) {
    return {
      score: 0,
      recency: Number(recency.toFixed(6)),
      interest: Number(interest.toFixed(6)),
      sourceTrust,
      novelty: 0,
      dup: true,
      dropped: false,
      ageHours: Number(age.toFixed(3)),
      reason: 'duplicate',
      matchedTitle: near.best,
    };
  }

  const novelty = clamp01(1 - near.max, 0);

  // 冷启动：pushedCount 显式传 0 且没有点击数据。未传 pushedCount 时默认走完整公式。
  const hasPushedCount = Object.prototype.hasOwnProperty.call(o, 'pushedCount');
  const clickCount = Number(o.clickCount);
  const coldStart = o.coldStart === true
    || (hasPushedCount && Number(o.pushedCount) === 0 && !(Number.isFinite(clickCount) && clickCount > 0));

  let score;
  if (coldStart) {
    score = 0.6 * recency + 0.4 * interest;
  } else {
    score = 0.4 * recency + 0.25 * interest + 0.2 * sourceTrust + 0.15 * novelty;
  }

  return {
    score: Number(clamp01(score, 0).toFixed(6)),
    recency: Number(recency.toFixed(6)),
    interest: Number(interest.toFixed(6)),
    sourceTrust,
    novelty: Number(novelty.toFixed(6)),
    dup: false,
    dropped: false,
    ageHours: Number(age.toFixed(3)),
    coldStart,
  };
}

// ── URL 归一化 / 跨源合簇 / 同窗口 MMR（2026-11-21 C1）───────────────────

/**
 * URL 归一化：小写 host、去 fragment、去跟踪参数、去尾斜杠、query 排序。
 * 非法 URL 不抛：退化为去 fragment + 去尾斜杠的字符串（至少能当键用）。
 */
function normalizeUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  let u = null;
  try {
    u = new URL(s);
  } catch (e) {
    // 协议相对 URL（//example.com/a）补一个 scheme 再试
    if (s.indexOf('//') === 0) {
      try { u = new URL('https:' + s); } catch (e2) { u = null; }
    }
  }
  if (!u) return s.replace(/#.*$/, '').replace(/\/+$/, '');
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return s.replace(/#.*$/, '').replace(/\/+$/, '');
  }
  u.hash = '';
  try { u.hostname = u.hostname.toLowerCase(); } catch (e) { /* URL 已小写，忽略 */ }
  const kept = [];
  for (const [key, value] of u.searchParams) {
    const lower = String(key).toLowerCase();
    if (lower.indexOf('utm_') === 0 || TRACKING_PARAMS.has(lower)) continue;
    kept.push([key, value]);
  }
  // 参数排序：同一资源不同参数顺序也算同一条（跟踪参数已剔除，剩余多是无序的）
  kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const qs = new URLSearchParams();
  for (const [key, value] of kept) qs.append(key, value);
  u.search = qs.toString();
  const trimmed = u.pathname.replace(/\/+$/, '');
  u.pathname = trimmed || '/';
  return u.toString();
}

function itemScore(item) {
  const n = Number(item && item.score);
  return Number.isFinite(n) ? n : 0;
}

function itemTime(item) {
  const t = toMs(item && item.published_at);
  if (Number.isFinite(t)) return t;
  const f = Number(item && item.fetched_at);
  return Number.isFinite(f) ? f : 0;
}

/** 代表条：分数最高 → 最新 → id 字典序（全确定性） */
function betterRepresentative(a, b) {
  const sa = itemScore(a);
  const sb = itemScore(b);
  if (sa !== sb) return sa > sb;
  const ta = itemTime(a);
  const tb = itemTime(b);
  if (ta !== tb) return ta > tb;
  return String(a && a.id || '').localeCompare(String(b && b.id || '')) < 0;
}

function clusterKeyOf(item) {
  if (item && item.cluster_key) return 'c:' + item.cluster_key;
  if (item && item.id) return 'i:' + item.id;
  return item;
}

function stableClusterKey(members, tokensList, links) {
  const uniqueLinks = Array.from(new Set(links.filter(Boolean))).sort();
  let basis;
  if (uniqueLinks.length) {
    basis = uniqueLinks.join('\n');
  } else {
    const titles = Array.from(new Set(members.map((m) => String(m && m.title || '')))).sort();
    // 2026-11-21 压力测试：纯 emoji/标点标题 + 空 link 会让 titles 退化成同一个空串，
    // 不同事件撞同一个 cluster_key → selectDiverse 把它们当重复丢掉。加 id 兜底。
    const ids = Array.from(new Set(members.map((m) => String((m && m.id) || '')))).sort();
    const usableTitles = titles.filter((t) => t.trim());
    basis = usableTitles.length
      ? 'title:' + usableTitles.join('\n') + '\nid:' + ids.join('\n')
      : 'id:' + ids.join('\n');
  }
  const digest = crypto.createHash('sha1').update(basis, 'utf8').digest('hex');
  return 'cl_' + digest.slice(0, 16);
}

/**
 * 跨源合簇：归一化 URL 相同或标题 token Jaccard ≥ threshold → 同一簇。
 * 返回 [{key, size, representative, items}]；size = 簇内不同 feed_id 数（几个源报道）。
 * 不修改入参；调用方自行把 key/size 写回 item。
 */
function clusterItems(items, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const threshold = Number.isFinite(Number(o.jaccardThreshold))
    ? Math.max(0, Math.min(1, Number(o.jaccardThreshold))) : CLUSTER_JACCARD;
  const list = Array.isArray(items) ? items.filter((it) => it && typeof it === 'object') : [];
  const n = list.length;
  if (n === 0) return [];
  const tokens = new Array(n);
  const links = new Array(n);
  for (let i = 0; i < n; i += 1) {
    tokens[i] = textTokens(list[i].title);
    links[i] = normalizeUrl(list[i].link);
  }
  const parent = new Array(n);
  for (let i = 0; i < n; i += 1) parent[i] = i;
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) {
      parent[r] = parent[parent[r]];
      r = parent[r];
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (links[i] && links[i] === links[j]) { union(i, j); continue; }
      if (threshold <= 0) continue;
      if (jaccard(tokens[i], tokens[j]) >= threshold) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  const clusters = [];
  for (const idxs of groups.values()) {
    const members = idxs.map((i) => list[i]);
    const feeds = new Set();
    idxs.forEach((i, pos) => {
      const m = list[i];
      feeds.add(String(m.feed_id || m.feed_name || m.id || ('#' + pos)));
    });
    let representative = members[0];
    for (let i = 1; i < members.length; i += 1) {
      if (betterRepresentative(members[i], representative)) representative = members[i];
    }
    clusters.push({
      key: stableClusterKey(members, idxs.map((i) => tokens[i]), idxs.map((i) => links[i])),
      size: Math.max(1, feeds.size),
      representative,
      items: members,
    });
  }
  clusters.sort((a, b) => a.key.localeCompare(b.key));
  return clusters;
}

/**
 * 同窗口 MMR：按 0.7*相关度 + 0.3*(1-最大标题相似度) 迭代选，且
 * ① 同一 cluster_key 只选一条；② 与已选标题 Jaccard ≥ threshold 的直接跳过。
 * opts.selected 可传入已选条目，用来跨「新条目 / 重试条目」两批选择时保持互斥。
 */
function selectDiverse(items, count, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const limit = Math.max(0, Math.floor(Number(count) || 0));
  const lambda = Number.isFinite(Number(o.lambda)) ? clamp01(o.lambda, MMR_LAMBDA) : MMR_LAMBDA;
  const threshold = Number.isFinite(Number(o.jaccardThreshold))
    ? Math.max(0, Math.min(1, Number(o.jaccardThreshold))) : CLUSTER_JACCARD;
  const seeded = Array.isArray(o.selected) ? o.selected.filter(Boolean) : [];
  const remaining = (Array.isArray(items) ? items : []).filter(Boolean);
  const picked = [];
  const selectedTokens = seeded.map((it) => textTokens(it.title));
  const usedClusters = new Set(seeded.map(clusterKeyOf));
  while (picked.length < limit && remaining.length) {
    let bestIdx = -1;
    let bestMmr = -Infinity;
    let bestSim = 1;
    let bestTokens = null;
    for (let i = 0; i < remaining.length; i += 1) {
      const it = remaining[i];
      const key = clusterKeyOf(it);
      if (usedClusters.has(key)) continue;
      const tk = textTokens(it.title);
      let maxSim = 0;
      for (const st of selectedTokens) {
        const j = jaccard(tk, st);
        if (j > maxSim) maxSim = j;
        if (maxSim >= 1) break;
      }
      if (maxSim >= threshold) continue; // 同一事件（标题几乎一样）不再选
      const rel = clamp01(it.score, 0);
      const mmr = lambda * rel + (1 - lambda) * (1 - maxSim);
      if (bestIdx < 0) {
        bestIdx = i; bestMmr = mmr; bestSim = maxSim; bestTokens = tk;
        continue;
      }
      const best = remaining[bestIdx];
      if (mmr > bestMmr + 1e-9
        || (Math.abs(mmr - bestMmr) <= 1e-9
          && (betterRepresentative(it, best)
            || (itemScore(it) === itemScore(best) && itemTime(it) === itemTime(best)
              && String(it.id || '').localeCompare(String(best.id || '')) < 0)))) {
        bestIdx = i; bestMmr = mmr; bestSim = maxSim; bestTokens = tk;
      }
    }
    if (bestIdx < 0) break;
    const chosen = remaining[bestIdx];
    picked.push(chosen);
    selectedTokens.push(bestTokens);
    usedClusters.add(clusterKeyOf(chosen));
    remaining.splice(bestIdx, 1);
  }
  return picked;
}

module.exports = {
  scoreItem,
  computeInterest,
  maxJaccard,
  jaccard,
  textTokens,
  ageHours,
  toMs,
  normalizeUrl,
  clusterItems,
  selectDiverse,
  itemScore,
  itemTime,
  constants: {
    DECAY_HOURS, MAX_AGE_HOURS, DUP_JACCARD, INTEREST_SATURATION,
    CLUSTER_JACCARD, MMR_LAMBDA,
  },
};
