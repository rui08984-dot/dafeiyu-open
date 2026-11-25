#!/usr/bin/env node
/**
 * _probe/test-plugin-reload-hash.cjs —— 插件热重载「内容闸」（2026-11-25）
 *
 * 背景：实测 132 次热重载里 75 次是伪事件（编辑器保存无改动 / touch / 元数据变化）。
 * 现在 fswatch 事件先过语法预检，再比 sha1(内容) 前 16 位：
 *   · 与上次成功加载一致 → 只 dbg 一行，不重载、不重建工具面；
 *   · 真变更 → 重载；失败 → 保留旧实例 + 指纹回滚（下次还能重试）。
 *
 * 全程临时目录，不碰真实 plugins/，不启宿主。
 * 用法：node _probe/test-plugin-reload-hash.cjs
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const { PluginManager, hashContent } = require(path.join(LIVE, 'js', 'core', 'plugin-manager.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-plugin-hash-'));
const PLUGINS = path.join(TMP, 'plugins');
const BUILTIN = path.join(PLUGINS, 'built-in');
const COMMUNITY = path.join(PLUGINS, 'community');
const DEMO = path.join(BUILTIN, 'demo');
fs.mkdirSync(DEMO, { recursive: true });
fs.mkdirSync(COMMUNITY, { recursive: true });

const NAME = 'built-in/demo';
const MAIN = path.join(DEMO, 'index.js');
const EXTRA = path.join(DEMO, 'extra.js');

const VALID_V1 = `'use strict';
class Demo {
    constructor(metadata, context) { this.metadata = metadata; this.context = context; }
    async onInit() {}
    async onStart() {}
    async onStop() {}
    async onDestroy() {}
}
module.exports = Demo;
`;
const VALID_V2 = `'use strict';
// v2
class Demo {
    constructor(metadata, context) { this.metadata = metadata; this.context = context; }
    async onInit() {}
    async onStart() {}
    async onStop() {}
    async onDestroy() {}
}
module.exports = Demo;
`;
const BROKEN = `'use strict';
module.exports = {   // 半截文件：语法错误
`;

fs.writeFileSync(path.join(DEMO, 'metadata.json'), JSON.stringify({
    name: 'demo', displayName: 'Demo', version: '1.0.0', main: 'index.js', lang: 'js',
}, null, 2));
fs.writeFileSync(MAIN, VALID_V1);
fs.writeFileSync(EXTRA, 'module.exports = { helper: 1 };\n');
fs.writeFileSync(path.join(PLUGINS, 'enabled_plugins.json'), JSON.stringify({ plugins: [NAME] }));

function newManager() {
    const m = new PluginManager({ tools: {} });
    // 只改目录指针：不碰真实 plugins/
    m._pluginsDir = PLUGINS;
    m._builtinDir = BUILTIN;
    m._communityDir = COMMUNITY;
    return m;
}

(async () => {
    // ── 指纹原语 ──────────────────────────────────────────────────────────
    ok('hashContent 返回 16 位', /^[0-9a-f]{16}$/.test(hashContent('abc')), hashContent('abc'));
    ok('hashContent 对同内容稳定', hashContent('abc') === hashContent('abc'));
    ok('hashContent 对不同内容不同', hashContent('abc') !== hashContent('abd'));

    const mgr = newManager();
    await mgr.load(DEMO);

    // ── 首次加载：不受内容闸影响，且建立基线 ──────────────────────────────
    ok('首次加载成功', mgr._plugins.has(NAME));
    ok('首次加载建立 index.js 指纹', mgr._fileHashes.has(MAIN));
    ok('首次加载递归收录子模块 extra.js', mgr._fileHashes.has(EXTRA));
    const neverLoaded = path.join(DEMO, 'never-loaded.js');
    ok('空内容表不误判（无基线 → 视为变更）', mgr._isContentUnchanged(neverLoaded, 'module.exports=1', NAME) === false);
    ok('内容一致 → 跳过（同内容伪事件）', mgr._isContentUnchanged(MAIN, VALID_V1, NAME) === true);
    ok('内容变化 → 不跳过（真变更）', mgr._isContentUnchanged(MAIN, VALID_V2, NAME) === false);
    ok('读不到内容（null）→ 不跳过', mgr._isContentUnchanged(MAIN, null, NAME) === false);

    // ── touch / 元数据变化 / 保存无改动：内容相同都走跳过 ──────────────────
    fs.writeFileSync(MAIN, VALID_V1);           // 重写相同字节
    const now = new Date(Date.now() + 5000);
    fs.utimesSync(MAIN, now, now);              // 只改 mtime
    ok('touch/重写同内容 → 跳过', mgr._isContentUnchanged(MAIN, fs.readFileSync(MAIN, 'utf8'), NAME) === true);

    // ── 真实变更成功重载：指纹更新 ────────────────────────────────────────
    fs.writeFileSync(MAIN, VALID_V2);
    const oldEntry = mgr._plugins.get(NAME);
    const reloadRes = await mgr.reload(NAME);
    ok('真变更重载成功', reloadRes && reloadRes.ok === true);
    ok('重载后是新实例', mgr._plugins.get(NAME) !== oldEntry);
    ok('重载后指纹更新为新内容', mgr._fileHashes.get(MAIN) === hashContent(VALID_V2));

    // ── 重载失败：保留旧实例 + 指纹回滚 ──────────────────────────────────
    const keepEntry = mgr._plugins.get(NAME);
    const keepHash = mgr._fileHashes.get(MAIN);
    fs.writeFileSync(MAIN, BROKEN);
    const errs = [];
    const origErr = console.error;
    console.error = (...a) => { errs.push(a.join(' ')); };
    let threw = null;
    try { await mgr.reload(NAME); } catch (e) { threw = e; }
    console.error = origErr;
    ok('语法错误重载会抛错', !!threw);
    ok('失败后旧实例仍在（保留旧实例）', mgr._plugins.get(NAME) === keepEntry);
    ok('失败后指纹回滚到重载前', mgr._fileHashes.get(MAIN) === keepHash);
    ok('失败日志含 [reload] 失败，保留旧实例', errs.some((l) => l.includes('[reload] 失败，保留旧实例')), errs.join(' | ').slice(0, 120));
    ok('失败内容不会被记成「已加载」（下次仍可重试）', mgr._isContentUnchanged(MAIN, BROKEN, NAME) === false);
    ok('失败前的旧内容仍被认作已加载', mgr._isContentUnchanged(MAIN, VALID_V2, NAME) === true);

    // ── 删除的模块：基线清理，避免同名文件重现被误判未变 ────────────────
    const gone = path.join(DEMO, 'sub.js');
    fs.writeFileSync(gone, 'module.exports = 1;\n');
    mgr._recordPluginHashes(DEMO);
    ok('新增文件进入基线', mgr._fileHashes.has(gone));
    fs.unlinkSync(gone);
    mgr._recordPluginHashes(DEMO);
    ok('删除文件从基线移除', !mgr._fileHashes.has(gone));

    // ── Python 插件文件也参与指纹 ────────────────────────────────────────
    const py = path.join(DEMO, 'index.py');
    fs.writeFileSync(py, 'print("hi")\n');
    mgr._recordPluginHashes(DEMO);
    ok('python 文件进入基线', mgr._fileHashes.has(py));

    console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
    process.exitCode = fail ? 1 : 0;
})().catch((e) => {
    console.error('测试异常:', e && e.stack || e);
    process.exitCode = 1;
});
