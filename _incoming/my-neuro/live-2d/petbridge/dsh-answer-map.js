// petbridge/dsh-answer-map.js —— DSH 人工回答 → 结构化答案的纯函数（CJS，可单测）
//
// 为什么单独抽出来（2026-11-20 审计 P0/P1）：
//   ① vts-server.mjs 是 ESM + 会起 ws 服务，单测直接 import 等于起服务；
//      这里只留纯逻辑，_probe/test-dsh-ask-chain.cjs 用 require 就能覆盖。
//   ② 否定句映射曾经把「不允许」映射成「允许」（双向包含 `vn.includes(rn)`）——
//      这是「用户说不要，系统当成要」的 P0。规则收口到这一处，禁止再散落。
//
// 否定优先（不可让步）：
//   用户原话命中否定词 → 只允许选「拒绝类」选项；没有拒绝类选项时返回 custom 原文，
//   **绝不猜正选项**。否定判断优先于任何精确/包含匹配。
'use strict';

// 中文否定词。注意几处刻意的取舍：
//   · 「别」排除「特别/个别/性别/告别/离别/差别」这些非否定词；
//   · 「没」排除「没问题/没事/没关系」这些常用肯定；
//   · 拒绝/取消/停止/终止本身就是拒绝语义，一并按否定处理（对是非题等价于「否」）。
const NEG_ZH_RE = /(不允许|不同意|不继续|不批准|不通过|不接受|不要|不用|不必|不可|不行|不好|不对|不准|不许|不需要|没必要|拒绝|取消|停止|终止|撤销|否决|驳回|不|没(?!问题|事|关系)|(?<![特个性告离差])别|勿)/;
// 英文否定词：整词匹配，避免 already / nothing 这类误伤。
const NEG_EN_RE = /\b(no|not|don'?t|doesn'?t|didn'?t|do not|does not|reject|deny|stop|cancel)\b/i;

// 「拒绝类」选项标签。分两档：强拒绝（任务指定词表）优先于弱拒绝（不同意/不允许），
// 这样「[不允许/拒绝]」这种选项集里会稳定选「拒绝」。
const DENY_STRONG_RE = /(拒绝|取消|停止|deny|reject|cancel|stop|skip)|(^|[\s（(【[])(否|no)($|[\s，,。.）)】\]])/i;
const DENY_SOFT_RE = /(不同意|不允许|不要)/i;
const DENY_LABEL_RE = new RegExp(DENY_STRONG_RE.source + '|' + DENY_SOFT_RE.source, 'i');

// 口语里常带的前缀垫词（「那就继续」→「继续」）。
const FILLER_PREFIX_RE = /^(那就|那|就|还是|好|嗯|行|我选|选择|选)\s*/;

// 选项里常带「(Recommended)」后缀；用户不会连它一起念，匹配时剥掉。
function labelVariants(label) {
  const l = String(label == null ? '' : label).trim();
  if (!l) return [];
  const base = l.replace(/[（(]\s*(推荐|建议|recommended|recommend)\s*[)）]\s*$/i, '').trim();
  return base && base !== l ? [l, base] : [l];
}

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 是否否定回答。命中任一否定词即 true；宁严勿松（安全方向 = 拒绝）。 */
function isNegation(text) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return false;
  return NEG_ZH_RE.test(t) || NEG_EN_RE.test(t);
}

/** 在选项标签里找「拒绝类」标签（返回原始 label 字符串）。找不到返回 null。 */
function pickDenyLabel(labels) {
  const list = Array.isArray(labels) ? labels : [];
  const find = (re) => {
    for (const label of list) {
      const raw = String(label == null ? '' : label);
      if (labelVariants(raw).some((v) => re.test(norm(v)))) return raw;
    }
    return null;
  };
  return find(DENY_STRONG_RE) || find(DENY_SOFT_RE) || null;
}

/** 单段文本 → 命中的选项标签（精确 → 包含 → 前缀兜底）。 */
function matchPiece(piece, labels, picked) {
  const pn = norm(piece);
  if (!pn) return;
  const before = picked.length;
  // ① 精确匹配（变体也算：剥掉 (Recommended)）
  for (const label of labels) {
    if (picked.includes(label)) continue;
    if (labelVariants(label).some((v) => norm(v) === pn)) picked.push(label);
  }
  if (picked.length > before) return;   // 本段已精确命中，不必再猜
  // ② 口语兜底：用户话里包含选项（「取消吧」→「取消」）；单字太容易误判，要求 ≥2 字。
  //    刻意不做 `选项.includes(用户话)` —— 「允许」是「不允许」的子串，反向包含
  //    正是 P0 反相的来源。短答只认「选项以用户话开头」，且拒绝类标签不参与猜。
  const rn = norm(pn.replace(FILLER_PREFIX_RE, ''));
  if (!rn) return;
  for (const label of labels) {
    if (picked.includes(label)) continue;
    const hit = labelVariants(label).some((v) => {
      const vn = norm(v);
      if (vn.length < 2) return false;
      if (pn.includes(vn)) return true;
      return rn.length >= 2 && vn.startsWith(rn)
        && !DENY_LABEL_RE.test(vn) && !isNegation(rn);
    });
    if (hit) picked.push(label);
  }
}

/**
 * 把用户原话映射成 DSH 的答案形状：命中选项 → selected；否则 → custom 原文。
 * 返回 [{ id, selected: string[], custom?: string }]。
 */
function answersFromText(text, questions) {
  const raw = String(text == null ? '' : text).trim().slice(0, 2000);
  const negated = isNegation(raw);
  const answers = [];
  for (const q of (Array.isArray(questions) ? questions : [])) {
    const labels = (q.options || []).map((o) => o.label);
    const picked = [];

    if (q.multiSelect) {
      // 多选逐段判定：不能拿整句做否定检测 —— 「允许、拒绝」里含「拒绝」，
      // 整句判否定会只剩一个「拒绝」，把用户明确选的「允许」吞掉。
      for (const piece of raw.split(/[、,，;；\s]+/).filter(Boolean)) {
        if (isNegation(piece)) {
          const deny = pickDenyLabel(labels);
          if (deny && !picked.includes(deny)) picked.push(deny);
          continue;
        }
        matchPiece(piece, labels, picked);
      }
    } else if (negated) {
      // ① 否定优先：只选拒绝类；没有拒绝类 → custom 原文（不猜正选项）。
      const deny = pickDenyLabel(labels);
      if (deny) picked.push(deny);
    } else {
      matchPiece(raw, labels, picked);
    }

    const item = { id: q.id, selected: picked };
    if (!picked.length) item.custom = raw || '（用户没有给出明确回答）';
    answers.push(item);
  }
  return answers;
}

// ── 挂起等待器（纯逻辑，无 HTTP）────────────────────────────────────────────
// vts-server 的 /dsh/ask 语义：同时只挂一个问题；超时/请求方断开/人工回答
// 都走一次 settle 且只 settle 一次。抽出来才能单测「超时返回」「busy 返回」。
function createAskBroker(opts) {
  const o = opts || {};
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 60000;
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const map = typeof o.answersFromText === 'function' ? o.answersFromText : answersFromText;
  const onEvent = typeof o.onEvent === 'function' ? o.onEvent : () => {};
  let pending = null;
  let seq = 0;

  function settle(payload) {
    const p = pending;
    if (!p) return false;
    pending = null;
    if (p.timer) { try { clearTimeout(p.timer); } catch (e) { /* 已触发 */ } }
    try { p.resolve(payload); } catch (e) { /* 响应已断开 */ }
    return true;
  }

  /** 开始一次等待。返回 { id, promise }；已有挂起时 id=0 且 promise 立即 busy。 */
  function ask(questions) {
    if (pending) {
      onEvent('busy', { id: pending.id });
      return { id: 0, promise: Promise.resolve({ answers: [], timedOut: true, busy: true }) };
    }
    seq += 1;
    const id = seq;
    const promise = new Promise((resolve) => {
      const p = { id, at: now(), questions, resolve, timer: null };
      p.timer = setTimeout(() => {
        if (pending !== p) return;
        pending = null;
        onEvent('timeout', { id, timeoutMs });
        resolve({ answers: [], timedOut: true });
      }, timeoutMs);
      if (p.timer.unref) p.timer.unref();
      pending = p;
    });
    return { id, promise };
  }

  /** 人工回答：映射成 answers 后 settle；没有挂起时 consumed:false。 */
  function reply(text) {
    if (!pending) return { ok: true, consumed: false };
    const id = pending.id;
    const answers = map(text, pending.questions);
    settle({ answers, timedOut: false });
    onEvent('reply', { id, answers });
    return { ok: true, consumed: true, answers };
  }

  /** 请求方断开：只取消指定的那次等待（避免误杀后续新问题）。 */
  function cancel(id) {
    if (!pending) return false;
    if (id !== undefined && pending.id !== id) return false;
    const pid = pending.id;
    const ok = settle({ answers: [], timedOut: true, clientClosed: true });
    if (ok) onEvent('cancel', { id: pid });
    return ok;
  }

  function current() {
    return pending
      ? { at: pending.at, questions: pending.questions.map((q) => ({ id: q.id, question: q.question })) }
      : null;
  }
  function busy() { return pending !== null; }

  return { ask, reply, cancel, current, busy };
}

// ── 8103 CORS / Origin（2026-11-20 审计 P1）────────────────────────────────
// 规则：没有 Origin 的客户端（curl / Node / Electron file:// 渲染层实测不带 Origin）
// 放行；带 Origin 的浏览器请求只认本机回环与 file://；`null` 不放行。
// 这样本机任意网页无法再靠 `Access-Control-Allow-Origin: *` 读写 8103。
function originAllowed(origin) {
  if (origin === undefined || origin === null) return true;
  const o = String(origin).trim();
  if (!o) return true;
  if (o === 'null') return false;             // sandbox iframe / data: 等不透明源
  if (/^file:\/\//i.test(o)) return true;
  let u;
  try { u = new URL(o); } catch (e) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** 返回 { allowed, headers }。ACAO 只回显白名单 origin，绝不再发 `*`。 */
function corsFor(origin) {
  const allowed = originAllowed(origin);
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
  const o = origin == null ? '' : String(origin).trim();
  if (o && allowed) headers['Access-Control-Allow-Origin'] = o;
  return { allowed, headers };
}

module.exports = {
  norm,
  labelVariants,
  isNegation,
  pickDenyLabel,
  answersFromText,
  createAskBroker,
  originAllowed,
  corsFor,
  DENY_LABEL_RE,
};
