// _probe/test-browser-tabs.cjs —— 浏览器 tab 上报单测（世界感知 Phase 2 · 2026-11-20）
//
// 只测纯函数与落盘 sink，不起 HTTP、不碰真宿主：
//   ① sanitizeBrowserTab：字段收敛 / 标题 80 字截断 / 非法 host 拒绝 / 时钟兜底
//   ② incognito 隐私：host 与 title 必须为空，audible 必须 false
//   ③ createBrowserTabSink：连续相同 (host,title,audible,incognito) 不重复写；
//      变化才写；>2MB 轮转成 .1（新文件从 1 行开始）
//   ④ checkBrowserToken：空配置拒绝 / 错 token 拒绝 / 正确放行 / 非 ASCII 等长比较
//
// 用法：node _probe/test-browser-tabs.cjs
// 输出：PASS n / FAIL m（check-all 靠这个汇总）
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const MOD = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'petbridge', 'vts-server.mjs');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(name + (detail ? '：' + detail : ''));
}
function eq(name, actual, expected) {
  ok(name, actual === expected, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}

function tempConfigDir(token) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bft-'));
  const app = path.join(root, 'live-2d');
  fs.mkdirSync(app, { recursive: true });
  const cfgPath = path.join(app, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ browser_ext_token: token === undefined ? '' : token }), 'utf8');
  return { root, app, cfgPath, record: path.join(root, 'data', 'browser-tabs.jsonl') };
}
function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); }
  catch (e) { return []; }
}
function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* Windows 偶发占用，忽略 */ }
}

(async () => {
  const mod = await import(pathToFileURL(MOD).href);
  const { sanitizeBrowserTab, createBrowserTabSink, checkBrowserToken, browserTabRecordPath, sanitizeDispatchHttpBody } = mod;
  ok('导出 sanitizeBrowserTab', typeof sanitizeBrowserTab === 'function');
  ok('导出 createBrowserTabSink', typeof createBrowserTabSink === 'function');
  ok('导出 checkBrowserToken', typeof checkBrowserToken === 'function');
  ok('导出 browserTabRecordPath', typeof browserTabRecordPath === 'function');
  ok('导出 sanitizeDispatchHttpBody', typeof sanitizeDispatchHttpBody === 'function');

  // ── ⓪ /dispatch 入参：HTTP 不能指定 cwd（红队 P1 #4）─────────────────
  {
    const d = sanitizeDispatchHttpBody({ task: 'ls', cwd: 'C:/Windows/System32', sessionId: 's1', timeoutMs: 1000 });
    eq('/dispatch 保留 task', d.task, 'ls');
    eq('/dispatch 丢弃 cwd', Object.prototype.hasOwnProperty.call(d.opts, 'cwd'), false);
    ok('/dispatch 记录被忽略的 cwd', d.ignoredCwd === 'C:/Windows/System32', JSON.stringify(d));
    eq('/dispatch 保留 sessionId', d.opts.sessionId, 's1');
    eq('/dispatch 保留 timeoutMs', d.opts.timeoutMs, 1000);
    const fallback = sanitizeDispatchHttpBody({ text: 'hi' });
    eq('/dispatch 兼容 text 字段', fallback.task, 'hi');
    const bad = sanitizeDispatchHttpBody(null);
    eq('/dispatch 空 body 不崩', bad.task, undefined);
    eq('/dispatch 空 body 无 cwd', bad.ignoredCwd, '');
  }

  // ── ① sanitize ───────────────────────────────────────────────────────
  {
    const r = sanitizeBrowserTab({ host: 'Example.COM', title: '  标题   多个空格  ', audible: true, tabCount: 7.2, ts: Date.now() });
    ok('正常 payload ok', r.ok === true, r.error);
    eq('host 归一化小写', r.record.host, 'example.com');
    eq('title 压缩空白', r.record.title, '标题 多个空格');
    eq('audible 保留', r.record.audible, true);
    eq('tabCount 取整', r.record.tabCount, 7);
    eq('source 恒 ext', r.record.source, 'ext');
    ok('ts 使用客户端值（24h 内）', Math.abs(r.record.ts - Date.now()) < 5000);
  }
  {
    const long = '字'.repeat(90);
    const r = sanitizeBrowserTab({ host: 'a.cn', title: long, tabCount: 1 });
    eq('标题按字截断到 80', Array.from(r.record.title).length, 80);
  }
  {
    const emoji = '😀'.repeat(100);
    const r = sanitizeBrowserTab({ host: 'a.cn', title: emoji, tabCount: 1 });
    eq('emoji 不被劈半（80 码点）', Array.from(r.record.title).length, 80);
    eq('emoji 原样保留', r.record.title, '😀'.repeat(80));
  }
  {
    eq('空 host 拒绝', sanitizeBrowserTab({ host: '', title: 'x' }).ok, false);
    eq('带斜杠 host 拒绝', sanitizeBrowserTab({ host: 'a.com/x', title: 'x' }).ok, false);
    eq('带空格 host 拒绝', sanitizeBrowserTab({ host: 'a b.com', title: 'x' }).ok, false);
    eq('超长 host 拒绝', sanitizeBrowserTab({ host: 'a'.repeat(254), title: 'x' }).ok, false);
    eq('非对象拒绝', sanitizeBrowserTab(null).ok, false);
    eq('数组拒绝', sanitizeBrowserTab([]).ok, false);
  }
  {
    const stale = Date.now() - 48 * 60 * 60 * 1000;
    const r = sanitizeBrowserTab({ host: 'a.cn', title: 'x', ts: stale });
    ok('超过 24h 的客户端 ts 被本地时钟替换', r.record.ts > stale + 24 * 60 * 60 * 1000);
  }

  // ── ② incognito 隐私 ─────────────────────────────────────────────────
  {
    const r = sanitizeBrowserTab({ host: 'secret.example.com', title: '不该落盘', audible: true, incognito: true, tabCount: 9 });
    ok('incognito ok', r.ok === true);
    eq('incognito host 清空', r.record.host, '');
    eq('incognito title 清空', r.record.title, '');
    eq('incognito audible 置 false', r.record.audible, false);
    eq('incognito 标记保留', r.record.incognito, true);
    eq('incognito tabCount 保留', r.record.tabCount, 9);
    ok('incognito 记录不含 secret 子串', !JSON.stringify(r.record).includes('secret'));
  }

  // ── ③ sink 去重 / 轮转 ───────────────────────────────────────────────
  {
    const t = tempConfigDir('secret-token-123');
    try {
      eq('记录文件推导到 data', browserTabRecordPath(t.cfgPath), t.record);
      const sink = createBrowserTabSink({ configPath: t.cfgPath });
      const base = sanitizeBrowserTab({ host: 'example.com', title: 'A', audible: false, tabCount: 3 }).record;
      let r = sink.append(base);
      ok('首次写盘 ok', r.ok === true && r.skipped === false, r.error);
      eq('文件 1 行', readLines(t.record).length, 1);

      r = sink.append(Object.assign({}, base));
      ok('连续相同 → skipped', r.ok === true && r.skipped === true);
      eq('重复不写盘（仍 1 行）', readLines(t.record).length, 1);

      r = sink.append(Object.assign({}, base, { title: 'B' }));
      ok('title 变化 → 写', r.ok === true && r.skipped === false);
      eq('文件 2 行', readLines(t.record).length, 2);

      r = sink.append(Object.assign({}, base, { title: 'B', audible: true }));
      ok('audible 变化 → 写', r.ok === true && r.skipped === false);
      eq('文件 3 行', readLines(t.record).length, 3);

      const inc = sanitizeBrowserTab({ incognito: true, host: '', title: '', tabCount: 5 }).record;
      r = sink.append(inc);
      ok('incognito 首写', r.ok === true && r.skipped === false);
      r = sink.append(Object.assign({}, inc));
      ok('incognito 重复 → skipped', r.skipped === true);
      eq('incognito 只落 1 行（共 4 行）', readLines(t.record).length, 4);

      const lines = readLines(t.record).map((l) => JSON.parse(l));
      const last = lines[lines.length - 1];
      eq('落盘字段完整', ['ts', 'host', 'title', 'audible', 'incognito', 'tabCount', 'source'].every((k) => k in last), true);
      eq('落盘 incognito host 为空', last.host, '');
    } finally { cleanup(t.root); }
  }
  {
    const t = tempConfigDir('secret-token-123');
    try {
      fs.mkdirSync(path.dirname(t.record), { recursive: true });
      fs.writeFileSync(t.record, 'x'.repeat(2 * 1024 * 1024 + 10), 'utf8');
      const sink = createBrowserTabSink({ configPath: t.cfgPath });
      const rec = sanitizeBrowserTab({ host: 'new.example', title: '轮转', tabCount: 1 }).record;
      const r = sink.append(rec);
      ok('超 2MB 后仍能写', r.ok === true, r.error);
      ok('.1 备份存在', fs.existsSync(t.record + '.1'));
      ok('.1 大小 >= 2MB', fs.statSync(t.record + '.1').size >= 2 * 1024 * 1024);
      eq('轮转后新文件 1 行', readLines(t.record).length, 1);
    } finally { cleanup(t.root); }
  }
  {
    const sink = createBrowserTabSink({ configPath: null });
    const r = sink.append({ host: 'a.cn', title: 'x', audible: false, incognito: false });
    eq('无 configPath → 明确失败', r.ok, false);
    eq('无 configPath 错误原因', r.error, 'no_config_path');
  }

  // ── ④ token ─────────────────────────────────────────────────────────
  {
    const t = tempConfigDir('secret-token-123');
    try {
      eq('正确 token 放行', checkBrowserToken(t.cfgPath, 'secret-token-123').ok, true);
      eq('前后空白被容忍', checkBrowserToken(t.cfgPath, '  secret-token-123  ').ok, true);
      const bad = checkBrowserToken(t.cfgPath, 'wrong-token');
      eq('错 token 拒绝', bad.ok, false);
      eq('错 token 原因', bad.reason, 'bad-token');
      eq('缺 token 拒绝', checkBrowserToken(t.cfgPath, undefined).reason, 'bad-token');
      eq('空 token 拒绝', checkBrowserToken(t.cfgPath, '').reason, 'bad-token');
    } finally { cleanup(t.root); }
  }
  {
    const t = tempConfigDir('');
    try {
      const r = checkBrowserToken(t.cfgPath, 'anything');
      eq('配置为空 → 拒绝（不默认放行）', r.ok, false);
      eq('配置为空原因', r.reason, 'not-configured');
    } finally { cleanup(t.root); }
  }
  {
    const t = tempConfigDir('密钥-中文-token');
    try {
      eq('非 ASCII token 正确放行', checkBrowserToken(t.cfgPath, '密钥-中文-token').ok, true);
      eq('非 ASCII token 错值拒绝', checkBrowserToken(t.cfgPath, '密钥-中文-toke').ok, false);
    } finally { cleanup(t.root); }
  }
  {
    const t = tempConfigDir('x');
    fs.writeFileSync(t.cfgPath, '{ 坏 JSON', 'utf8');
    try {
      eq('配置不可读 → 拒绝', checkBrowserToken(t.cfgPath, 'x').ok, false);
      eq('配置不可读原因', checkBrowserToken(t.cfgPath, 'x').reason, 'config-unreadable');
    } finally { cleanup(t.root); }
  }

  console.log('PASS ' + pass + ' / FAIL ' + fail);
  if (fail) {
    for (const f of failures) console.error('   - ' + f);
    process.exit(1);
  }
})().catch((e) => {
  console.error('PASS ' + pass + ' / FAIL ' + (fail + 1));
  console.error('   - 测试异常：' + ((e && e.stack) || e));
  process.exit(1);
});
