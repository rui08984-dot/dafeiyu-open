'use strict';

/**
 * lib/rss-parse.js —— 零依赖 RSS 2.0 / Atom / RSS 1.0(RDF) 解析器（纯函数）
 *
 * 设计边界（别扩成通用 XML 库）：
 *   - 只认 feed 的骨架：<rss><channel><item>、<feed><entry>、<rdf:RDF><item>；
 *   - 支持 CDATA、常见命名实体与 &#NN;/&#xNN; 数字实体；
 *   - 命名空间前缀一律忽略本地名（<dc:date> 当 date，<content:encoded> 当 encoded）；
 *   - **绝不抛异常**：任何失败都返回 { ok:false, error }，调用方不需要 try/catch。
 *
 * 输出：{ ok:true, format:'rss'|'atom'|'rdf', items:[{title,link,published_at,summary}] }
 *       published_at 解析失败时为 null（由 index.js 用抓取时间兜底）。
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
};

const SUMMARY_MAX_CHARS = 200;

/** 实体解码：单次扫描，&amp;lt; 只会变成 &lt;，不会被二次解码成 < */
function decodeEntities(text) {
  if (typeof text !== 'string' || text.indexOf('&') < 0) return text || '';
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      // 代理区码点不能单独转字符，保留原文（比抛异常好）
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch (e) {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** 把字符串里的 A-Z 映射成 a-z（长度严格不变，便于用 lower 的下标切原文） */
function asciiLower(s) {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** 去掉注释、BOM 与控制字符之外的东西；CDATA 不在这里处理 */
function stripComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

/** 展开所有 CDATA 段（保留内容，去掉包裹） */
function unwrapCdata(text) {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (whole, inner) => inner);
}

/** 把 HTML/XML 标签拿掉，只留文本（用于 summary） */
function stripTags(text) {
  return text
    .replace(/<\s*br\s*\/?\s*>/gi, ' ')
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

/** 压缩空白（含全角空格），去掉首尾空白 */
function collapseWhitespace(text) {
  return text.replace(/[\s\u00a0\u3000]+/g, ' ').trim();
}

/**
 * 从一段 XML 里找 <tag ...>...</tag> 的内部文本（只看第一个匹配）。
 * tag 传本地名；命名空间前缀可选。
 */
function findTagInner(block, localName) {
  const name = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const close = '<\\s*\\/\\s*(?:[A-Za-z_][\\w.-]*:)?' + name + '\\s*>';
  // 先找不带前缀的原生标签（避免 <media:title> 抢在 <title> 前面）；
  // 找不到再接受任意命名空间前缀（<dc:date> 等）。
  const exact = new RegExp('<\\s*' + name + '\\b[^>]*>([\\s\\S]*?)' + close, 'i');
  const m = block.match(exact);
  if (m) return m[1];
  const prefixed = new RegExp('<\\s*(?:[A-Za-z_][\\w.-]*:)?' + name + '\\b[^>]*>([\\s\\S]*?)' + close, 'i');
  const pm = block.match(prefixed);
  return pm ? pm[1] : '';
}

/**
 * 取一个可读文本字段（title 等）。
 * 整段只有一个 CDATA 时按字面文本处理（不把 <World> 当标签吃掉）；
 * 混合内容则先展开 CDATA 再剥标签。
 */
function textField(block, localName) {
  const raw = findTagInner(block, localName);
  if (!raw) return '';
  const trimmed = raw.trim();
  let text;
  if (/^<!\[CDATA\[[\s\S]*\]\]>$/.test(trimmed)) {
    text = trimmed.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
  } else {
    text = stripTags(unwrapCdata(raw));
  }
  return collapseWhitespace(decodeEntities(text));
}

/** 取摘要：先展开 CDATA，再解码实体把转义 HTML 还原成标签、剥掉，最后再解码残留实体 */
function summaryField(block, localNames) {
  for (const name of localNames) {
    const raw = findTagInner(block, name);
    if (!raw) continue;
    const decoded = decodeEntities(unwrapCdata(raw));
    const text = collapseWhitespace(decodeEntities(stripTags(decoded)));
    if (text) return truncateChars(text, SUMMARY_MAX_CHARS);
  }
  return '';
}

/** 按 Unicode 码点截断（不是 UTF-16 单元），含省略号在内总长 ≤ max */
function truncateChars(text, max) {
  const arr = Array.from(String(text || ''));
  if (arr.length <= max) return arr.join('');
  if (max <= 1) return '…'.slice(0, max);
  return arr.slice(0, max - 1).join('') + '…';
}

/** 解析标签属性（只处理 name="v" / name='v'） */
function parseAttrs(attrText) {
  const attrs = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrText))) {
    const key = m[1].toLowerCase();
    const val = m[2] !== undefined ? m[2] : m[3];
    if (!(key in attrs)) attrs[key] = decodeEntities(val);
  }
  return attrs;
}

/**
 * 取链接：
 *   RSS:   <link>https://…</link>（或带命名空间的 atom:link）
 *   Atom:  <link rel="alternate" href="…"/>；rel=self 跳过
 *   兜底:  <guid isPermaLink="true">…</guid>
 */
function linkField(block) {
  const re = /<\s*(?:[A-Za-z_][\w.-]*:)?link\b([^>]*)>([\s\S]*?)<\s*\/\s*(?:[A-Za-z_][\w.-]*:)?link\s*>|<\s*(?:[A-Za-z_][\w.-]*:)?link\b([^>]*)\/\s*>/gi;
  let m;
  let fallback = '';
  while ((m = re.exec(block))) {
    const attrs = parseAttrs(m[1] !== undefined ? m[1] : m[3] || '');
    const rel = String(attrs.rel || '').toLowerCase();
    if (rel === 'self') continue;
    const href = String(attrs.href || '').trim();
    const text = collapseWhitespace(decodeEntities(stripTags(unwrapCdata(m[2] || ''))));
    const candidate = href || text;
    if (!candidate) continue;
    if (!rel || rel === 'alternate') return candidate;
    if (!fallback) fallback = candidate;
  }
  if (fallback) return fallback;
  const guid = findTagInner(block, 'guid');
  if (guid) {
    const text = collapseWhitespace(decodeEntities(stripTags(unwrapCdata(guid))));
    if (/^https?:\/\//i.test(text)) return text;
  }
  return '';
}

/** 解析日期 → ISO；无法解析返回 null */
function parseDate(text) {
  const s = collapseWhitespace(decodeEntities(String(text || '')));
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch (e) {
    return null;
  }
}

/** 在 lower 里从 from 开始找 </tag>，跳过 CDATA/注释；返回 {start,endAfter} 或 null */
function findCloseTag(lower, from, tag) {
  const closePrefix = '</' + tag;
  let i = from;
  while (i < lower.length) {
    const lt = lower.indexOf('<', i);
    if (lt < 0) return null;
    if (lower.startsWith('<![cdata[', lt)) {
      const end = lower.indexOf(']]>', lt + 9);
      if (end < 0) return null;
      i = end + 3;
      continue;
    }
    if (lower.startsWith('<!--', lt)) {
      const end = lower.indexOf('-->', lt + 4);
      if (end < 0) return null;
      i = end + 3;
      continue;
    }
    if (lower.startsWith(closePrefix, lt)) {
      const after = lower[lt + closePrefix.length];
      if (after === undefined || /[\s>]/.test(after)) {
        const gt = lower.indexOf('>', lt);
        if (gt < 0) return null;
        return { start: lt, endAfter: gt + 1 };
      }
    }
    i = lt + 1;
  }
  return null;
}

/** 抽出所有 <tag>…</tag> 的内部 XML（跳过注释/CDATA 里的假标签与假闭合） */
function extractBlocks(xml, tag) {
  const lower = asciiLower(xml);
  const blocks = [];
  const openPrefix = '<' + tag;
  let i = 0;
  while (i < lower.length) {
    const lt = lower.indexOf('<', i);
    if (lt < 0) break;
    if (lower.startsWith('<![cdata[', lt)) {
      const end = lower.indexOf(']]>', lt + 9);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (lower.startsWith('<!--', lt)) {
      const end = lower.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (lower.startsWith(openPrefix, lt)) {
      const after = lower[lt + openPrefix.length];
      if (after === undefined || /[\s/>]/.test(after)) {
        // 跳过属性（属性值里可能有 '>'）
        let j = lt + openPrefix.length;
        let quote = null;
        for (; j < lower.length; j += 1) {
          const ch = lower[j];
          if (quote) {
            if (ch === quote) quote = null;
            continue;
          }
          if (ch === '"' || ch === "'") { quote = ch; continue; }
          if (ch === '>') break;
        }
        if (j >= lower.length) break;
        if (lower[j - 1] === '/') {
          i = j + 1;
          continue;
        }
        const close = findCloseTag(lower, j + 1, tag);
        if (!close) {
          // 文档被截断：把剩下的内容当成一个条目，能救多少救多少（不抛）
          blocks.push(xml.slice(j + 1));
          break;
        }
        blocks.push(xml.slice(j + 1, close.start));
        i = close.endAfter;
        continue;
      }
    }
    i = lt + 1;
  }
  return blocks;
}

/**
 * 主函数：解析一个 feed 文档。
 * @param {string} xml
 * @returns {{ok:true,format:string,items:Array}|{ok:false,error:string}}
 */
function parseFeed(xml) {
  try {
    if (typeof xml !== 'string') return { ok: false, error: '输入不是字符串' };
    const doc = stripComments(xml);
    if (!doc.trim()) return { ok: false, error: '空文档' };

    const lower = asciiLower(doc);
    let format = '';
    let tag = '';
    if (/<\s*rss\b/.test(lower)) { format = 'rss'; tag = 'item'; }
    else if (/<\s*feed\b/.test(lower)) { format = 'atom'; tag = 'entry'; }
    else if (/<\s*rdf:rdf\b/.test(lower)) { format = 'rdf'; tag = 'item'; }
    else return { ok: false, error: '不是 RSS/Atom/RDF feed（找不到 rss/feed/rdf:RDF 根）' };

    const blocks = extractBlocks(doc, tag);
    const items = [];
    let invalid = 0;

    for (const block of blocks) {
      const title = textField(block, 'title');
      const link = linkField(block);
      if (!title && !link) {
        invalid += 1;
        continue;
      }
      const dateText = findTagInner(block, 'pubDate')
        || findTagInner(block, 'published')
        || findTagInner(block, 'updated')
        || findTagInner(block, 'date')
        || findTagInner(block, 'created');
      const published = parseDate(dateText);
      const summary = summaryField(block, ['description', 'summary', 'encoded', 'content']);
      items.push({
        title: title || '(无标题)',
        link,
        published_at: published,
        summary,
      });
    }

    if (blocks.length > 0 && items.length === 0) {
      return { ok: false, error: '发现 ' + blocks.length + ' 个 <' + tag + '> 但全部缺少 title/link' };
    }

    return { ok: true, format, items, invalid };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

module.exports = {
  parseFeed,
  // 以下导出仅供单测/诊断，不属于稳定接口
  __internal: {
    decodeEntities,
    textField,
    linkField,
    parseDate,
    extractBlocks,
    stripTags,
    truncateChars,
    SUMMARY_MAX_CHARS,
  },
};
