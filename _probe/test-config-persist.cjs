#!/usr/bin/env node
/**
 * _probe/test-config-persist.cjs — 配置「写盘 → 热重载 → 读回」单一入口回归（2026-11-17 六十三轮）
 *
 * 为什么必须有这条：2026-11-17 的真事故是 /reload-config 打到没有 reloadConfig 的
 * 字幕窗却返回 success:true —— 控制中心提示「已保存」，宿主还跑着旧 API key。
 * 只要「reload 失败时 ok 必须为 false」这条断言在，「写盘成功 = 已生效」就回不来。
 *
 * 全部用临时目录里的假 config，不碰真实 config.json / llm_providers.json，不打印任何密钥。
 *
 * 用法：node _probe/test-config-persist.cjs
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { saveAndApply, writeJsonVerified, saveHostConfig, patchVerified } = require(path.join(
  __dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'config-persist.js'
));
const { saveProviders, persistProviderStore } = require(path.join(
  __dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'llm-provider-store.js'
));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// 假宿主：正常情况返回 {success:true}；hits 用来证明「该发的请求发了、不该发的一次没发」
function startHost() {
  const state = { hits: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      state.hits.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: '配置已重新加载' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

// 拿一个「刚被释放、当前无人监听」的端口，保证连接一定被拒
async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'config-persist-'));
  let host = null;
  try {
    host = await startHost();
    const reloadOpts = { port: host.port, timeoutMs: 2000 };

    // ── ① merge：只改目标键，兄弟键/深层键必须原样保留 ───────────────────
    const f1 = path.join(root, 'merge.json');
    fs.writeFileSync(f1, JSON.stringify({
      tts: { enabled: true, voice: 'old' },
      ui: { model: 'm1', nested: { keep: 1 } },
      version: '1',
    }, null, 2), 'utf8');
    host.state.hits.length = 0;
    const r1 = await saveAndApply(f1, { tts: { voice: 'new' } }, { mode: 'merge', reload: reloadOpts });
    const d1 = readJson(f1);
    ok('merge：ok=true', r1.ok === true, JSON.stringify(r1.reload));
    ok('merge：wrote=true', r1.wrote === true);
    ok('merge：reload 成功', r1.reload.success === true, r1.reload.message);
    ok('merge：readback.ok 且无 mismatches',
      r1.readback.ok === true && r1.readback.mismatches.length === 0,
      JSON.stringify(r1.readback.mismatches));
    ok('merge：目标键已改', d1.tts.voice === 'new');
    ok('merge：兄弟键/深层键/顶层键都保留',
      d1.tts.enabled === true && d1.ui.model === 'm1' && d1.ui.nested.keep === 1 && d1.version === '1');
    ok('merge：真的 POST /reload-config',
      host.state.hits.length === 1 && host.state.hits[0].method === 'POST'
        && host.state.hits[0].url === '/reload-config',
      JSON.stringify(host.state.hits.map((h) => h.method + ' ' + h.url)));
    ok('merge：写前留了 .bak', fs.existsSync(f1 + '.bak'));

    // ── ② full：整份替换，旧键必须消失 ────────────────────────────────
    const f2 = path.join(root, 'full.json');
    fs.writeFileSync(f2, JSON.stringify({ old: true, tts: { enabled: true } }), 'utf8');
    const r2 = await saveAndApply(f2, { tts: { enabled: false }, ui: { model: 'm2' } }, { mode: 'full', reload: reloadOpts });
    const d2 = readJson(f2);
    ok('full：ok=true', r2.ok === true, JSON.stringify(r2.reload));
    ok('full：整份替换（旧键消失）', d2.old === undefined && d2.tts.enabled === false && d2.ui.model === 'm2');

    // ── ③ 写盘失败：目标位置被目录占住（Windows/Unix 都会让 rename 失败） ─
    const badDir = path.join(root, 'bad');
    fs.mkdirSync(badDir);
    const badTarget = path.join(badDir, 'config.json');
    fs.mkdirSync(badTarget);
    const hitsBefore = host.state.hits.length;
    const r3 = await saveAndApply(badTarget, { a: 1 }, { mode: 'full', reload: reloadOpts });
    ok('写盘失败：ok=false', r3.ok === false);
    ok('写盘失败：wrote=false', r3.wrote === false);
    ok('写盘失败：error 指明写盘原因', /写盘/.test(String(r3.error)), String(r3.error));
    ok('写盘失败：reload 未执行', r3.reload.success === false && /未执行/.test(r3.reload.message));
    ok('写盘失败：一次热重载请求都没发', host.state.hits.length === hitsBefore);
    ok('写盘失败：没有留下 .tmp 残骸', !fs.existsSync(badTarget + '.tmp'));
    ok('失败结果也带完整结构',
      r3.wrote === false && r3.reload && r3.readback && Array.isArray(r3.readback.mismatches));

    // ── ④ 热重载失败：端口无人监听 → ok 必须为 false（防假成功回归） ──────
    const f4 = path.join(root, 'reload-fail.json');
    fs.writeFileSync(f4, JSON.stringify({ a: 1 }), 'utf8');
    const dead = await closedPort();
    const r4 = await saveAndApply(f4, { b: 2 }, { mode: 'merge', reload: { port: dead, timeoutMs: 1500 } });
    ok('热重载失败：reload.success=false', r4.reload.success === false, r4.reload.message);
    ok('热重载失败：ok 必须为 false（这条就是防假成功）', r4.ok === false);
    ok('热重载失败：但写盘确实发生', r4.wrote === true && readJson(f4).b === 2);
    ok('热重载失败：error 指名宿主没重载', /热重载失败/.test(String(r4.error)), String(r4.error));

    // ── ⑤ 读回不一致：写盘+重载都成功，但文件随后被外部改掉 ─────────────
    const f5 = path.join(root, 'tamper.json');
    fs.writeFileSync(f5, JSON.stringify({ tts: { voice: 'before' } }), 'utf8');
    const r5 = await saveAndApply(f5, { tts: { voice: 'after' } }, {
      mode: 'merge',
      reload: reloadOpts,
      // 测试注入点：在写盘+重载之后、读回之前把文件改掉
      beforeReadback: (file) => {
        const data = readJson(file);
        data.tts.voice = 'tampered';
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
      },
    });
    ok('读回不一致：ok=false', r5.ok === false);
    ok('读回不一致：wrote=true（盘确实写过）', r5.wrote === true);
    ok('读回不一致：reload 本身是成功的', r5.reload.success === true);
    ok('读回不一致：定位到 tts.voice',
      r5.readback.ok === false && r5.readback.mismatches.some((m) => m.path === 'tts.voice'),
      JSON.stringify(r5.readback.mismatches));
    ok('读回不一致：error 指明读回校验', /读回校验失败/.test(String(r5.error)), String(r5.error));

    // ── ⑥ 密钥字段的 mismatch 不得把原值带出进程 ───────────────────────
    const f6 = path.join(root, 'secret.json');
    fs.writeFileSync(f6, JSON.stringify({ llm: { api_key: 'fake-key-before' } }), 'utf8');
    const r6 = await saveAndApply(f6, { llm: { api_key: 'fake-key-after' } }, {
      mode: 'merge',
      reload: reloadOpts,
      verifyKeys: ['llm.api_key'],
      beforeReadback: (file) => {
        const data = readJson(file);
        data.llm.api_key = 'fake-key-tampered';
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
      },
    });
    const dumped = JSON.stringify(r6);
    ok('密钥 mismatch：ok=false', r6.ok === false);
    ok('密钥 mismatch：结果里不出现密钥原值',
      !dumped.includes('fake-key-after') && !dumped.includes('fake-key-tampered'), dumped.slice(0, 160));
    ok('密钥 mismatch：值被标注为已脱敏',
      r6.readback.mismatches[0] && r6.readback.mismatches[0].expected === '<已脱敏>'
        && r6.readback.mismatches[0].actual === '<已脱敏>');

    // ── ⑦ 现有配置损坏时拒绝 merge（不能拿空基线覆盖用户数据） ───────────
    const f7 = path.join(root, 'broken.json');
    fs.writeFileSync(f7, '{ not json', 'utf8');
    const r7 = await saveAndApply(f7, { a: 1 }, { mode: 'merge', reload: reloadOpts });
    ok('坏配置 merge：ok=false', r7.ok === false);
    ok('坏配置 merge：wrote=false（不覆盖残缺文件）', r7.wrote === false);
    ok('坏配置 merge：原文件原样保留', fs.readFileSync(f7, 'utf8') === '{ not json');

    // ── ⑧ 抽出来的 writeJsonVerified 本身仍可独立使用 ─────────────────────
    const f8 = path.join(root, 'raw.json');
    const w8 = writeJsonVerified(f8, { x: 1, y: 2 });
    ok('共享 writeJsonVerified：ok=true 且文件可读', w8.ok === true && readJson(f8).y === 2);

    // ── ⑨ verifyKeys 点名了根本没写进去的键：不能靠 undefined===undefined 混过去 ─
    const f9 = path.join(root, 'missing-key.json');
    fs.writeFileSync(f9, JSON.stringify({ a: 1 }), 'utf8');
    const r9 = await saveAndApply(f9, { b: 2 }, { mode: 'merge', reload: reloadOpts, verifyKeys: ['not.written'] });
    ok('verifyKeys 指向未写入的键：ok=false 且原因明确',
      r9.ok === false && r9.readback.mismatches.some((m) => m.reason === 'missing-in-write'),
      JSON.stringify(r9.readback.mismatches));

    // ── ⑪ saveProviders（云端 url/key 落盘）：成功要能读回，失败要 ok:false 且无 .tmp ─
    // 这条防的是「UI 换了 key，llm_providers.json 却没写成，control:save-config 还报成功」。
    // 全部用假凭据，断言只比字段值不打印密钥。
    // 把失败日志出口换成内存记录器：既能断言「失败真的发声」，又不会往真实 runtime.log 写假错误。
    // 只改本进程的 require 缓存，不碰磁盘上的 api-utils.js。
    const apiUtilsPath = require.resolve(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'js', 'api-utils.js'));
    const logCalls = [];
    require.cache[apiUtilsPath] = {
      id: apiUtilsPath, filename: apiUtilsPath, loaded: true,
      exports: { logToTerminal: (level, message) => { logCalls.push({ level, message }); } },
    };

    const pOkDir = path.join(root, 'provider-ok');
    fs.mkdirSync(pOkDir);
    const fakeProviders = [{
      id: 'probe', name: '探针', api_key: 'fake-provider-key', api_url: 'https://example.invalid/v1',
      enabled: true,
      models: [{ model_id: 'probe-model', name: 'probe-model', enabled: true, temperature_enabled: true, temperature: 0.7 }],
    }];
    const sp1 = saveProviders(pOkDir, fakeProviders);
    ok('saveProviders 正常写：ok=true', sp1.ok === true, sp1.error);
    ok('saveProviders 正常写：wrote=true 且 file 指向 llm_providers.json',
      sp1.wrote === true && sp1.file === path.join(pOkDir, 'llm_providers.json'));
    const sp1Doc = readJson(path.join(pOkDir, 'llm_providers.json'));
    const sp1P = sp1Doc.providers && sp1Doc.providers[0] || {};
    const sp1M = sp1P.models && sp1P.models[0] || {};
    ok('saveProviders 读回逐字段一致（id/name/url/key/enabled/模型/温度）',
      sp1P.id === 'probe' && sp1P.name === '探针' && sp1P.api_url === 'https://example.invalid/v1'
        && sp1P.api_key === 'fake-provider-key' && sp1P.enabled === true
        && sp1M.model_id === 'probe-model' && sp1M.temperature_enabled === true && sp1M.temperature === 0.7);

    // 同名目录占住目标文件 → rename 必失败（EISDIR/EPERM），模拟写盘失败
    const pBadDir = path.join(root, 'provider-bad');
    fs.mkdirSync(pBadDir);
    const pBadTarget = path.join(pBadDir, 'llm_providers.json');
    fs.mkdirSync(pBadTarget);
    const sp2 = saveProviders(pBadDir, fakeProviders);
    ok('saveProviders 写失败：ok=false（结构返回，不抛异常）', sp2.ok === false);
    ok('saveProviders 写失败：wrote=false 且带原因',
      sp2.wrote === false && typeof sp2.error === 'string' && sp2.error.length > 0);
    ok('saveProviders 写失败：file 仍指向目标路径', sp2.file === pBadTarget);
    ok('saveProviders 写失败：没有留下 .tmp 残骸', !fs.existsSync(pBadTarget + '.tmp'));
    ok('saveProviders 写失败：走 logToTerminal(error) 发声，绝不静默',
      logCalls.some((c) => c.level === 'error' && /llm_providers\.json/.test(String(c.message))),
      JSON.stringify(logCalls.map((c) => c.level)));

    // ── ⑫ 字面量带点的键（_deprecated."tools.enabled"）不能被路径拆分误报 ─
    const f10 = path.join(root, 'dotted-key.json');
    fs.writeFileSync(f10, JSON.stringify({ _deprecated: { 'tools.enabled': true }, a: { b: 1 } }), 'utf8');
    const r10 = await saveAndApply(f10, { a: { b: 2 } }, { mode: 'merge', reload: reloadOpts });
    ok('字面量带点的键：ok=true 且不误报',
      r10.ok === true && r10.readback.mismatches.length === 0,
      JSON.stringify(r10.readback.mismatches));
    // ── ⑬ 宿主 save-config 纯辅助：正常 ok:true / provider 失败 ok:false / config 写失败 ok:false ─
    // 防的是 main.js 旧 handler 的假成功：通讯录写失败被吞、config 裸写无回读，还弹「已成功」。
    const hostDir = path.join(root, 'host-save');
    fs.mkdirSync(hostDir);
    const hostConfigPath = path.join(hostDir, 'config.json');
    fs.writeFileSync(hostConfigPath, JSON.stringify({ ui: { model_scale: 0.5 }, llm: { provider_id: 'p1' } }, null, 2), 'utf8');

    const persistCalls = [];
    const persistOk = (baseDir, cfgPath, cfg, options) => {
      persistCalls.push({ baseDir, cfgPath, options });
      cfg.llm_providers = [{ id: 'p1', api_key: 'fake-host-key' }]; // 模拟运行期注水键
      return { providers: cfg.llm_providers, storeChanged: true, storeWritable: true, migrated: false };
    };
    const hs1 = saveHostConfig({
      configPath: hostConfigPath,
      configBaseDir: hostDir,
      configData: { ui: { model_scale: 0.65 }, llm_providers: [{ id: 'p1' }] },
      persistProvider: persistOk,
    });
    const hs1Doc = readJson(hostConfigPath);
    ok('saveHostConfig 正常：ok=true 且读回内容一致（llm_providers 不落 config）',
      hs1.ok === true && hs1.wrote === true && hs1.readback && hs1.readback.ok === true
        && hs1Doc.ui.model_scale === 0.65 && hs1Doc.llm === undefined && hs1Doc.llm_providers === undefined,
      JSON.stringify(hs1));
    ok('saveHostConfig 正常：provider 收到 writeBack:false 且写前留了 .bak',
      persistCalls.length === 1 && persistCalls[0].options && persistCalls[0].options.writeBack === false
        && fs.existsSync(hostConfigPath + '.bak'),
      JSON.stringify(persistCalls.map((call) => call.options)));

    const beforeProviderFail = fs.readFileSync(hostConfigPath, 'utf8');
    const hs2 = saveHostConfig({
      configPath: hostConfigPath,
      configBaseDir: hostDir,
      configData: { ui: { model_scale: 0.9 } },
      persistProvider: () => ({ ok: false, wrote: false, error: '模拟通讯录写失败' }),
    });
    ok('saveHostConfig provider 失败：ok=false 且 stage=provider',
      hs2.ok === false && hs2.stage === 'provider' && /通讯录/.test(String(hs2.error)), JSON.stringify(hs2));
    ok('saveHostConfig provider 失败：config.json 一个字节没动（中止保存）',
      fs.readFileSync(hostConfigPath, 'utf8') === beforeProviderFail);

    const hostBadTarget = path.join(hostDir, 'config-as-dir.json');
    fs.mkdirSync(hostBadTarget); // 同名目录占住目标文件 → rename 必失败
    const hs3 = saveHostConfig({
      configPath: hostBadTarget,
      configBaseDir: hostDir,
      configData: { a: 1 },
      persistProvider: () => ({ storeWritable: true, storeChanged: false }),
    });
    ok('saveHostConfig config 写失败：ok=false 且 stage=config',
      hs3.ok === false && hs3.stage === 'config' && /写盘/.test(String(hs3.error)), JSON.stringify(hs3));

    const hs4 = saveHostConfig({
      configPath: hostConfigPath,
      configBaseDir: hostDir,
      configData: { a: 1 },
      persistProvider: () => { throw new Error('模拟 provider 抛异常'); },
    });
    ok('saveHostConfig provider 抛异常：ok=false 且原因透传',
      hs4.ok === false && hs4.stage === 'provider' && /模拟 provider 抛异常/.test(String(hs4.error)), JSON.stringify(hs4));

    // ── patchVerified（§69 B1：读最新 → 只改目标键 → 原子写）───────────────
    const fp1 = path.join(root, 'patch.json');
    fs.writeFileSync(fp1, JSON.stringify({ ui: { a: 1, keep: 'x' }, other: [1, 2] }, null, 2), 'utf8');
    const p1 = patchVerified(fp1, (cfg) => { cfg.ui = cfg.ui || {}; cfg.ui.a = 2; });
    const dp1 = readJson(fp1);
    ok('patch：ok=true 且只改目标键（兄弟键/数组原样）',
      p1.ok === true && dp1.ui.a === 2 && dp1.ui.keep === 'x' && JSON.stringify(dp1.other) === '[1,2]',
      JSON.stringify(p1));

    // 关键回归：调用方持有旧快照时（托盘就是这么干的），别人这期间写的新键必须保住
    fs.writeFileSync(fp1, JSON.stringify({ ui: { a: 2, keep: 'x' }, other: [1, 2], addedByOther: 'fresh' }, null, 2), 'utf8');
    const p2 = patchVerified(fp1, (cfg) => { cfg.ui.a = 3; });
    const dp2 = readJson(fp1);
    ok('patch：保留别人这期间写的新键（快照整份回写回归）',
      p2.ok === true && dp2.addedByOther === 'fresh' && dp2.ui.a === 3, JSON.stringify(dp2).slice(0, 200));

    const p3 = patchVerified(path.join(root, 'no-such-config.json'), () => {});
    ok('patch：读不到配置 → ok=false 且 stage=read', p3.ok === false && p3.stage === 'read', JSON.stringify(p3));

    const beforeMutateFail = fs.readFileSync(fp1, 'utf8');
    const p4 = patchVerified(fp1, () => { throw new Error('模拟改键抛异常'); });
    ok('patch：mutate 抛异常 → ok=false stage=mutate 且文件一个字节没动',
      p4.ok === false && p4.stage === 'mutate' && fs.readFileSync(fp1, 'utf8') === beforeMutateFail,
      JSON.stringify(p4));

    // 读得通但写不下去：让 mutate 塞进不可序列化结构（循环引用）。
    // ⚠ 不能再用「占住 <file>.tmp」的旧办法：临时文件名现在是唯一的
    // （<file>.tmp-<pid>-<ts>-<rand>，防跨进程撞名），固定 .tmp 已不是可预测路径。
    const fp2 = path.join(root, 'patch-write-fail.json');
    fs.writeFileSync(fp2, JSON.stringify({ a: 1 }, null, 2), 'utf8');
    const p5 = patchVerified(fp2, (cfg) => { cfg.self = cfg; });
    ok('patch：写盘阶段失败 → ok=false 且 stage=write', p5.ok === false && p5.stage === 'write', JSON.stringify(p5));
    ok('patch：写盘失败时原文件保持旧值', readJson(fp2).a === 1 && readJson(fp2).self === undefined);

    // ── ⑧ §70 P0：UI 随 config 送回的通讯录必须真正落盘（以前被静默丢弃）────────
    // 原实现 ensureProviderStore 只要 store 非空就无视 config.llm_providers：
    // 用户在「模型配置」页换 API key → 保存 → ok:true，磁盘还是旧 key，界面显示已保存。
    {
      const pDir = path.join(root, 'provider-merge');
      fs.mkdirSync(pDir);
      const pCfg = path.join(pDir, 'config.json');
      const storeFile = path.join(pDir, 'llm_providers.json');
      const seed = [{
        id: 'comad', name: 'comad', api_key: 'OLD_KEY_0000', api_url: 'https://example.invalid/v1',
        enabled: true, models: [{ model_id: 'm1', name: 'm1', enabled: true }],
      }, {
        id: 'spare', name: 'spare', api_key: 'SPARE_KEY', api_url: 'https://example.invalid/v2',
        enabled: false, models: [{ model_id: 'm2', name: 'm2', enabled: true }],
      }];
      fs.writeFileSync(storeFile, JSON.stringify({ providers: seed }, null, 2), 'utf8');
      fs.writeFileSync(pCfg, JSON.stringify({ llm: { provider_id: 'comad' }, ui: {} }, null, 2), 'utf8');
      const readKey = () => (readJson(storeFile).providers.find((p) => p.id === 'comad') || {}).api_key || '';

      // ① 新 key 必须落盘；快照里没带的 provider 不能被删
      const snap = readJson(storeFile).providers.map((p) => ({ ...p }));
      snap.find((p) => p.id === 'comad').api_key = 'NEW_KEY_1111';
      const m1 = saveHostConfig({
        configPath: pCfg, configBaseDir: pDir,
        configData: { llm: { provider_id: 'comad' }, ui: {}, llm_providers: snap.filter((p) => p.id === 'comad') },
        persistProvider: persistProviderStore,
      });
      ok('通讯录快照：写盘 ok=true 且 storeChanged=true',
        m1.ok === true && m1.provider && m1.provider.storeChanged === true, JSON.stringify(m1.provider));
      ok('通讯录快照：新 API key 真的到了磁盘（P0 回归）', readKey() === 'NEW_KEY_1111', readKey().slice(0, 8) + '…');
      ok('通讯录快照：快照里没带的 provider 没被删',
        readJson(storeFile).providers.map((p) => p.id).join(',') === 'comad,spare',
        readJson(storeFile).providers.map((p) => p.id).join(','));

      // ② 空 key / 脱敏占位不得抹掉真实值（2026-11-16 那次反向事故的护栏）
      for (const blank of ['', '   ', '<已脱敏>']) {
        const snap2 = readJson(storeFile).providers.map((p) => ({ ...p }));
        snap2.find((p) => p.id === 'comad').api_key = blank;
        saveHostConfig({
          configPath: pCfg, configBaseDir: pDir,
          configData: { llm: { provider_id: 'comad' }, ui: {}, llm_providers: snap2 },
          persistProvider: persistProviderStore,
        });
        ok(`通讯录快照：key=${JSON.stringify(blank)} 不覆盖真实值`, readKey() === 'NEW_KEY_1111', readKey().slice(0, 8) + '…');
      }

      // ③ 模型级参数改动也要落盘（换模型/温度同样走这条路）
      const snap3 = readJson(storeFile).providers.map((p) => ({ ...p }));
      snap3.find((p) => p.id === 'comad').models[0].temperature = 0.42;
      saveHostConfig({
        configPath: pCfg, configBaseDir: pDir,
        configData: { llm: { provider_id: 'comad' }, ui: {}, llm_providers: snap3 },
        persistProvider: persistProviderStore,
      });
      ok('通讯录快照：模型温度改动落盘',
        readJson(storeFile).providers.find((p) => p.id === 'comad').models[0].temperature === 0.42);
    }

  } finally {
    if (host) host.server.close();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不影响结论 */ }
  }

  console.log('');
  console.log(`  配置写盘→热重载→读回：PASS ${pass} / FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('  ✗ 测试中断：' + (e && e.stack || e));
  process.exit(1);
});
