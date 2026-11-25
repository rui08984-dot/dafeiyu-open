#!/usr/bin/env node
// check-config-template.mjs —— 配置模板门禁：结构 / 脱敏 / 漂移（2026-11-16）
//
// 背景：真实配置 `_incoming/my-neuro/live-2d/config.json` 与 `llm_providers.json`
// 含密钥，不入库；模板由 `scripts/gen-config-example.mjs` 自动脱敏生成。
// 两类事故都发生过：
//   1) 模板落后实盘 —— 实盘加了 `tts.muted` / `ui.petbody_choreo` / `ui.subtitle_position.dx|dy`，
//      模板没有，clone 的人照模板配出来就缺字段；
//   2) 模板把不该脱敏的脱了（`asr.ptt_key` 是键位名，不是秘密），或该脱敏的漏了。
// 这个门禁把两件事钉住：结构必须覆盖实盘，密钥必须一个都不出现。
//
// 检查项（纯离线，不碰网络）：
//   ① config.example 叶子键路径覆盖 config.json（忽略 `_deprecated.*`）→ 缺键 FAIL
//   ② config.example 里每个敏感字段都是占位符（含实盘为空串的字段）
//   ③ asr.ptt_key 原样保留（键位名，不是秘密）
//   ④ config.example 的 llm 段不含 api_key/api_url（凭据只在 llm_providers.json）
//   ⑤ llm_providers.example 与实盘的 provider id 集合一致（且无重复）
//   ⑥ 每个 provider 的 api_url 非空且未被改写
//   ⑦ 每个 provider 的 api_key 都是占位符
//   ⑧ 模板全文不含任何实盘密钥值（逐值比对；只报字段路径，绝不打印值）
//   ⑨ 模板里没有 sk- / JWT 形态的密钥串
//   ⑩ 模板里所有 http(s) URL 的 host 在白名单（example.com/127.0.0.1/localhost…）
//   ⑪ 已知实例键等于代码默认值（不是实盘快照：窗口坐标/点击穿透/语音四态/多屏延伸）
//   ⑫ 生成器 URL 兜底：键名不像 URL（proxy）但值是 URL 也会被中性化
//   ⑬ 生成器 URL 兜底：嵌套在 callback 等任意键下的 URL 同样会被中性化
//
// 为什么不用「长度>40 且高熵」的通用启发式：实盘里的
// `cloud.tts.voice` / `cloud.aliyun_tts.voice` 是语音 ID（本身就是长随机串），
// 通用熵阈值会把它们误判成密钥。真正的判据是「与实盘敏感字段值逐一相等」。
//
// 输出：`PASS n / FAIL m`，退出码 0/1；真实配置或模板不存在时记 SKIP（退出 0）。
// 用法：node _probe/check-config-template.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scrubInstanceUrls as scrubInstanceUrlsForTest,
  URL_PLACEHOLDER,
} from '../scripts/gen-config-example.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');

const FILES = {
  configReal: path.join(APP, 'config.json'),
  configTpl: path.join(APP, 'config.example.json'),
  provReal: path.join(APP, 'llm_providers.json'),
  provTpl: path.join(APP, 'llm_providers.example.json'),
};

const PLACEHOLDER_SECRET = '<填你的密钥>';
// 与 scripts/gen-config-example.mjs 保持一致
const SENSITIVE = /key|token|secret|password|credential/i;
const SENSITIVE_EXCEPTIONS = new Set(['ptt_key']);
const IGNORE_ROOT = '_deprecated';
const MIN_SECRET_LEN = 6;

// ── 实例值中性化（2026-11-24 P0）──────────────────────────────────────
// 模板可以公开，但**不能是「这台机器」的快照**：个人隧道地址、窗口坐标、
// 界面/语音开关都属于运行实例，clone 的人照抄只会莫名其妙。
// 门禁两条：⑩ 所有 http(s) URL 的 host 必须在白名单；⑪ 已知实例键必须等于代码默认。
// 与 scripts/gen-config-example.mjs 的 ALLOWED_URL_HOSTS / INSTANCE_DEFAULTS 同步。
// 2026-11-25 P2-11：生成器已改为「扫所有 string 值里的 http(s)」，不再依赖 URL 键名；
// ⑫⑬ 用合成样本直接断言 proxy/callback 这类键也会被替换。
const ALLOWED_URL_HOSTS = new Set(['example.com', '127.0.0.1', 'localhost', '::1', '0.0.0.0']);
const TUNNEL_RE = /natapp|ngrok|trycloudflare|localtunnel|serveo/i;
const INSTANCE_DEFAULTS = {
  'ui.pet_window.x': 0,
  'ui.pet_window.y': 0,
  'ui.click_through_default': false,
  'voice.duplex.backchannel_gate': false,
  'ui.screen_extend.extend': false,
  'ui.screen_extend.left': false,
  'ui.screen_extend.right': true,
};

let pass = 0;
let fail = 0;
let skip = 0;

const logPass = (label, note = '') => {
  pass += 1;
  console.log(`PASS  ${label}${note ? '  — ' + note : ''}`);
};
const logSkip = (label, note = '') => {
  skip += 1;
  console.log(`SKIP  ${label}${note ? '  — ' + note : ''}`);
};
function logFail(label, note = '', items = []) {
  fail += 1;
  console.log(`FAIL  ${label}${note ? '  — ' + note : ''}`);
  for (const item of items.slice(0, 40)) console.log(`        · ${item}`);
  if (items.length > 40) console.log(`        · …还有 ${items.length - 40} 条`);
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isSecretField = (key) => Boolean(key) && SENSITIVE.test(key) && !SENSITIVE_EXCEPTIONS.has(key);
const lastKey = (p) => String(p).split('.').pop().replace(/\[\d+\]$/, '');

/** 叶子键路径：对象递归；空对象算叶子；数组整体算叶子（配置里没有数组） */
function leafPaths(obj, prefix = '') {
  const out = [];
  const walk = (val, p) => {
    if (isPlainObject(val)) {
      const keys = Object.keys(val);
      if (!keys.length) {
        out.push(p);
        return;
      }
      for (const k of keys) walk(val[k], p ? `${p}.${k}` : k);
      return;
    }
    out.push(p);
  };
  for (const k of Object.keys(obj || {})) walk(obj[k], prefix ? `${prefix}.${k}` : k);
  return out;
}

function getPath(obj, dotted) {
  return String(dotted)
    .split('.')
    .reduce((acc, k) => (acc === null || acc === undefined ? undefined : acc[k]), obj);
}

/** 收集所有 http(s) 叶子值（路径 + host）；值本身不打印。 */
function collectHttpUrls(value, p = '', out = []) {
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) collectHttpUrls(v, p ? `${p}.${k}` : k, out);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectHttpUrls(v, `${p}[${i}]`, out));
    return out;
  }
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    let host = null;
    try {
      host = new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    } catch (err) {
      host = null;
    }
    out.push({ path: p, host });
  }
  return out;
}

function hostAllowed(host) {
  if (!host) return false;
  if (ALLOWED_URL_HOSTS.has(host)) return true;
  return /(^|\.)example\.(com|org|net)$/.test(host);
}

function loadJson(file) {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/** 收集实盘敏感叶子（路径 + 值），用于「模板里有没有漏出真 key」 */
function collectSecretLeaves(value, p = '', out = []) {
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) collectSecretLeaves(v, p ? `${p}.${k}` : k, out);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectSecretLeaves(v, `${p}[${i}]`, out));
    return out;
  }
  if (
    typeof value === 'string' &&
    value.length >= MIN_SECRET_LEN &&
    value !== PLACEHOLDER_SECRET &&
    isSecretField(lastKey(p))
  ) {
    out.push({ path: p, value });
  }
  return out;
}

/** 模板叶子值的形态扫描（只报路径，不报值） */
const SECRET_SHAPES = [
  ['sk- 前缀', /(^|[^A-Za-z0-9])sk-[A-Za-z0-9][A-Za-z0-9_-]{16,}/],
  ['JWT 形态', /(^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{6,}/],
];

function scanSecretShapes(value, p = '', hits = []) {
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) scanSecretShapes(v, p ? `${p}.${k}` : k, hits);
    return hits;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanSecretShapes(v, `${p}[${i}]`, hits));
    return hits;
  }
  if (typeof value === 'string') {
    for (const [name, re] of SECRET_SHAPES) {
      if (re.test(value)) hits.push(`${p} 疑似${name}`);
    }
  }
  return hits;
}

console.log('[check-config-template] 配置模板门禁（结构 / 脱敏 / 漂移）');

const have = Object.fromEntries(
  Object.entries(FILES).map(([k, file]) => [k, fs.existsSync(file)]),
);

// ── ①–④ config.json ↔ config.example.json ────────────────────────────
let configReal = null;
let configTpl = null;
let configTplText = '';

if (!have.configReal || !have.configTpl) {
  logSkip('config 结构/脱敏/漂移', !have.configReal ? 'config.json 不存在' : 'config.example.json 不存在');
} else {
  const a = loadJson(FILES.configReal);
  const b = loadJson(FILES.configTpl);
  if (!a.ok) logFail('config.json 可解析', a.error);
  if (!b.ok) logFail('config.example.json 可解析', b.error);
  if (a.ok && b.ok) {
    configReal = a.data;
    configTpl = b.data;
    configTplText = fs.readFileSync(FILES.configTpl, 'utf8');

    // ① 叶子键路径：实盘有而模板缺 → FAIL（_deprecated.* 是有意保留的注记，不参与）
    const realPaths = leafPaths(configReal).filter(
      (p) => p !== IGNORE_ROOT && !p.startsWith(IGNORE_ROOT + '.'),
    );
    const tplPaths = new Set(leafPaths(configTpl));
    // 实盘值为 null 表示「未设置 / 用默认」（例如 ui.subtitle_position=null 是
    // main.js 重置字幕位置后的合法状态）。此时模板里只要以该路径为前缀给出了分支
    // 形态（ui.subtitle_position.dx|dy）就算覆盖 —— 否则 clone 的人反而不会配。
    const nullParents = [];
    const missing = realPaths.filter((p) => {
      if (tplPaths.has(p)) return false;
      if (getPath(configReal, p) === null) {
        const prefix = p + '.';
        if ([...tplPaths].some((t) => t.startsWith(prefix))) {
          nullParents.push(p);
          return false;
        }
      }
      return true;
    });
    const extras = [...tplPaths].filter(
      (p) => p !== IGNORE_ROOT && !p.startsWith(IGNORE_ROOT + '.') && !realPaths.includes(p),
    );
    if (missing.length) {
      logFail('config 叶子键路径覆盖实盘', `实盘 ${realPaths.length} / 模板 ${tplPaths.size}，缺 ${missing.length}`, missing.map((p) => `缺 ${p}`));
    } else {
      logPass('config 叶子键路径覆盖实盘', `实盘 ${realPaths.length} / 模板 ${tplPaths.size}，缺 0`);
      if (nullParents.length) console.log(`      提示：实盘为 null（未设置）但模板给了形态 ${nullParents.length} 个：${nullParents.join(', ')}`);
      if (extras.length) console.log(`      提示：模板多出 ${extras.length} 个实盘没有的键（不算失败）：${extras.join(', ')}`);
    }

    // ② 敏感字段一律占位符（含实盘为空串的字段）
    const sensitivePaths = realPaths.filter(
      (p) => isSecretField(lastKey(p)) && typeof getPath(configReal, p) === 'string',
    );
    const notPlaceholder = sensitivePaths.filter((p) => {
      if (!tplPaths.has(p)) return false; // 缺键由 ① 报，不重复
      return getPath(configTpl, p) !== PLACEHOLDER_SECRET;
    });
    if (notPlaceholder.length) {
      logFail('config 敏感字段均为占位符', `${notPlaceholder.length}/${sensitivePaths.length} 个未脱敏`, notPlaceholder.map((p) => `${p} 不是占位符`));
    } else {
      logPass('config 敏感字段均为占位符', `${sensitivePaths.length} 个字段`);
    }

    // ③ asr.ptt_key 原样保留（键位名，不是秘密）
    const realPtt = getPath(configReal, 'asr.ptt_key');
    const tplPtt = getPath(configTpl, 'asr.ptt_key');
    if (typeof realPtt !== 'string') {
      logSkip('asr.ptt_key 原样保留', '实盘没有 asr.ptt_key');
    } else if (tplPtt === PLACEHOLDER_SECRET) {
      logFail('asr.ptt_key 原样保留', '模板把它当密钥脱敏了（照抄的人按键全废）');
    } else if (tplPtt !== realPtt) {
      logFail('asr.ptt_key 原样保留', '模板值与实盘不一致（键位名不会被改写）');
    } else {
      logPass('asr.ptt_key 原样保留', '键位名未被脱敏');
    }

    // ④ llm 段故意不含凭据（凭据已迁到 llm_providers.json，加回会被迁移逻辑当真）
    const llm = isPlainObject(configTpl.llm) ? configTpl.llm : null;
    const leftover = llm ? ['api_key', 'api_url', 'apiKey', 'apiUrl', 'key'].filter((k) => Object.prototype.hasOwnProperty.call(llm, k)) : [];
    if (leftover.length) {
      logFail('config 的 llm 段不含凭据字段', '出现 ' + leftover.join('/') + '（凭据只在 llm_providers.json）');
    } else {
      logPass('config 的 llm 段不含凭据字段', '只保留 provider_id/model_id，符合迁移后结构');
    }
  } else {
    logSkip('config 结构/脱敏/漂移', '文件解析失败，见上面的 FAIL');
  }
}

// ── ⑤–⑦ llm_providers.json ↔ llm_providers.example.json ─────────────
let provReal = null;
let provTpl = null;

if (!have.provReal || !have.provTpl) {
  logSkip('providers 结构/脱敏', !have.provReal ? 'llm_providers.json 不存在' : 'llm_providers.example.json 不存在');
} else {
  const a = loadJson(FILES.provReal);
  const b = loadJson(FILES.provTpl);
  if (!a.ok) logFail('llm_providers.json 可解析', a.error);
  if (!b.ok) logFail('llm_providers.example.json 可解析', b.error);
  if (a.ok && b.ok) {
    const realProvs = Array.isArray(a.data.providers) ? a.data.providers : null;
    const tplProvs = Array.isArray(b.data.providers) ? b.data.providers : null;

    if (!realProvs || !tplProvs) {
      logFail('providers 数组存在', !realProvs ? '实盘缺少 providers 数组' : '模板缺少 providers 数组');
    } else {
      provReal = realProvs;
      provTpl = tplProvs;

      // ⑤ provider id 集合一致（双向），且模板内无重复
      const realIds = realProvs.map((p) => String(p && p.id));
      const tplIds = tplProvs.map((p) => String(p && p.id));
      const dup = tplIds.filter((id, i) => tplIds.indexOf(id) !== i);
      const missingIds = realIds.filter((id) => !tplIds.includes(id));
      const extraIds = tplIds.filter((id) => !realIds.includes(id));
      const idProblems = [
        ...new Set(dup).values(),
      ].map((id) => `模板里 provider id 重复：${id}`).concat(
        missingIds.map((id) => `模板缺 provider：${id}`),
        extraIds.map((id) => `模板多出 provider：${id}`),
      );
      if (idProblems.length) {
        logFail('providers id 集合一致', `实盘 ${realIds.length} / 模板 ${tplIds.length}`, idProblems);
      } else {
        logPass('providers id 集合一致', `${realIds.length} 个 provider：${realIds.join(', ')}`);
      }

      // ⑥ api_url 非空，且没被改写（comad 的云端地址必须原样保留）
      const urlProblems = [];
      for (const p of tplProvs) {
        const id = String(p && p.id);
        const url = p && p.api_url;
        if (typeof url !== 'string' || !url.trim()) {
          urlProblems.push(`${id}: api_url 为空`);
          continue;
        }
        const real = realProvs.find((r) => String(r && r.id) === id);
        if (real && typeof real.api_url === 'string' && real.api_url.trim() && url !== real.api_url) {
          urlProblems.push(`${id}: api_url 与实盘不一致`);
        }
      }
      if (urlProblems.length) {
        logFail('providers api_url 非空且未改写', `${urlProblems.length} 个问题`, urlProblems);
      } else {
        logPass('providers api_url 非空且未改写', `${tplProvs.length} 个 provider 均保留实盘地址`);
      }

      // ⑦ api_key 全为占位符（含实盘为空/为真的情况，模板都必须是占位符）
      const keyProblems = tplProvs
        .filter((p) => !p || p.api_key !== PLACEHOLDER_SECRET)
        .map((p) => `${p && p.id ? p.id : '(无 id)'}: api_key 不是占位符`);
      if (keyProblems.length) {
        logFail('providers api_key 均为占位符', `${keyProblems.length} 个未脱敏`, keyProblems);
      } else {
        logPass('providers api_key 均为占位符', `${tplProvs.length} 个 provider`);
      }
    }
  } else {
    logSkip('providers 结构/脱敏', '文件解析失败，见上面的 FAIL');
  }
}

// ── ⑧ 模板全文不含实盘密钥值（逐值比对，只报路径）────────────────────
{
  const secrets = [];
  if (configReal) secrets.push(...collectSecretLeaves(configReal));
  if (provReal) secrets.push(...collectSecretLeaves(provReal, 'providers'));
  // 兜底：实盘 provider api_key 即使短于 MIN_SECRET_LEN 也要比（例如本地网关占位 key）
  if (provReal) {
    for (let i = 0; i < provReal.length; i += 1) {
      const v = provReal[i] && provReal[i].api_key;
      if (typeof v === 'string' && v.length >= 3 && v !== PLACEHOLDER_SECRET) {
        secrets.push({ path: `providers[${i}].api_key`, value: v });
      }
    }
  }
  // 同一个值可能被上面两条路径收两次：按值去重（只保留第一个路径）
  const uniqueSecrets = [...new Map(secrets.map((s) => [s.value, s])).values()];

  const texts = [];
  if (have.configTpl) texts.push(fs.readFileSync(FILES.configTpl, 'utf8'));
  if (have.provTpl) texts.push(fs.readFileSync(FILES.provTpl, 'utf8'));

  if (!uniqueSecrets.length || !texts.length) {
    logSkip('模板不含真实密钥值', !uniqueSecrets.length ? '实盘没有可比的敏感值' : '模板文件不存在');
  } else {
    const corpus = texts.join('\n');
    const leaked = uniqueSecrets
      .filter((s) => corpus.includes(s.value))
      .map((s) => `实盘 ${s.path} 的值出现在模板中`);
    if (leaked.length) {
      logFail('模板不含真实密钥值', `${leaked.length} 处泄漏（值不打印）`, leaked);
    } else {
      logPass('模板不含真实密钥值', `比对 ${uniqueSecrets.length} 个实盘敏感值，命中 0`);
    }
  }
}

// ── ⑨ 模板里没有 sk-/JWT 形态的密钥串 ────────────────────────────────
{
  const hits = [];
  if (configTpl) hits.push(...scanSecretShapes(configTpl, 'config.example'));
  if (have.provTpl) {
    const t = loadJson(FILES.provTpl);
    if (t.ok) hits.push(...scanSecretShapes(t.data, 'llm_providers.example'));
  }
  if (!configTpl && !have.provTpl) {
    logSkip('模板无 sk-/JWT 形态密钥', '模板文件不存在');
  } else if (hits.length) {
    logFail('模板无 sk-/JWT 形态密钥', `${hits.length} 处（值不打印）`, hits);
  } else {
    logPass('模板无 sk-/JWT 形态密钥', '未发现 sk- 前缀或 JWT 形态字符串');
  }
}

// ── ⑩ 模板 URL 的 host 在允许集（不含个人隧道/私有域名）──────────────────
{
  if (!configTpl) {
    logSkip('模板 URL host 在允许集', 'config.example.json 不存在或解析失败');
  } else {
    const urls = collectHttpUrls(configTpl, 'config.example');
    const bad = urls.filter((u) => !hostAllowed(u.host));
    if (bad.length) {
      const items = bad.map((u) => {
        const tunnel = u.host && TUNNEL_RE.test(u.host) ? '（个人隧道）' : '';
        return `${u.path} 的 host=${u.host || '(无法解析)'}${tunnel} 不在允许集`;
      });
      logFail('模板 URL host 在允许集', `${bad.length}/${urls.length} 个 URL 需中性化`, items);
    } else {
      logPass('模板 URL host 在允许集', `${urls.length} 个 URL 均指向 example.com/本机`);
    }
  }
}

// ── ⑪ 已知实例键等于代码默认值（不是实盘快照）────────────────────────────
{
  if (!configTpl) {
    logSkip('实例键为代码默认值', 'config.example.json 不存在或解析失败');
  } else {
    const bad = Object.entries(INSTANCE_DEFAULTS).filter(([p, want]) => {
      const got = getPath(configTpl, p);
      return JSON.stringify(got) !== JSON.stringify(want);
    });
    if (bad.length) {
      logFail(
        '实例键为代码默认值',
        `${bad.length}/${Object.keys(INSTANCE_DEFAULTS).length} 个实例键仍是个人值`,
        bad.map(([p, want]) => `${p} 期望 ${JSON.stringify(want)}，模板不是该值`),
      );
    } else {
      logPass('实例键为代码默认值', `${Object.keys(INSTANCE_DEFAULTS).length} 个键均为中性默认`);
    }
  }
}

// ── ⑫–⑬ URL 兜底：键名不匹配也必须中性化（与 ⑩ 扫所有 URL 对称）──────────
{
  const cases = [
    ['proxy', { proxy: 'http://ominifn.natapp1.cc/api' }, (o) => o.proxy],
    ['callback', { callback: { notify: 'https://api.internal-corp.cn/hook' } }, (o) => o.callback.notify],
  ];
  for (const [label, sample, pick] of cases) {
    const got = pick(scrubInstanceUrlsForTest(sample));
    if (got === URL_PLACEHOLDER) {
      logPass(`URL 兜底：${label} 键的值被中性化`, '键名不在 URL 白名单也会替换');
    } else {
      logFail(`URL 兜底：${label} 键的值被中性化`, '仍保留个人/私有 URL（生成器漏扫）');
    }
  }
}

console.log('');
console.log(`PASS ${pass} / FAIL ${fail}${skip ? ` / SKIP ${skip}` : ''}`);
process.exit(fail ? 1 : 0);
