'use strict';
// js/components/manager.js —— 组件管理器（2026-11-27 v0.4.0）
//
// 目标：底座安装包只带「她本人」（~120MB），长期记忆/ASR/一起看/LumenAct 等
// Python 侧器官做成**组件包**：安装器自动下载 → SHA256 校验 → 解压 → 写配置，
// 用户只点一次。模型从国内镜像（ModelScope/hf-mirror）拉，Python 运行时由我们发。
//
// 设计约束：
//   · 纯 Node（Node 18 兼容；跑在 Electron-as-Node 里也不能用 fetch/undici 的退出坑）；
//   · 不依赖 Electron、不依赖 app 运行中；控制中心/CMD/主进程都能 require；
//   · 所有写盘：tmp + rename；配置文件先备份再原子写；
//   · 失败必须发声（返回结构化 {ok:false, error}，CLI 非零退出）。
//
// 目录约定（安装版）：
//   <install>/components/            ← 本模块的根
//     manifest.json                  ← 组件清单（安装包随带，可远端更新）
//     state.json                     ← 已安装组件与文件哈希
//     services.json                  ← 物化后的服务启动清单（宿主 supervisor 读）
//     python/                        ← Python 运行时组件解压到这里
//     voice-asr/ memory/ lumen/ ...  ← 各组件
//     .cache/                        ← 下载中的 .part
//     logs/                          ← 服务日志

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// 2026-11-27 安装版实测：Electron-as-Node 里没跑主进程那段 DNS 设置，
// 而 ghproxy 的域名有 AAAA、本机 IPv6 不通 → 每个请求白等 30s 再失败。
// 组件下载器自己保证 IPv4 优先（与 main.js 的修复同源）。
try {
    const dns = require('dns');
    if (typeof dns.setDefaultResultOrder === 'function') dns.setDefaultResultOrder('ipv4first');
    const net = require('net');
    if (typeof net.setDefaultAutoSelectFamily === 'function') net.setDefaultAutoSelectFamily(true);
} catch (e) { /* 老运行时没有这些 API：保持默认 */ }

const SCHEMA = 1;

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }
function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function atomicWrite(file, text) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
}

/** 安装根：优先 PET_INSTALL_ROOT；否则按「exe 旁边有 resources/app」判定安装版；开发树回退仓库根。 */
function installRoot() {
    if (process.env.PET_INSTALL_ROOT) return path.resolve(process.env.PET_INSTALL_ROOT);
    const exeDir = path.dirname(process.execPath || '');
    if (exeDir && isFile(path.join(exeDir, 'resources', 'app', 'main.js'))) return exeDir;
    // 开发树：live-2d/js/components → 上五级 = 仓库根
    return path.resolve(__dirname, '..', '..', '..', '..', '..');
}
function componentsDir(root) { return path.join(root || installRoot(), 'components'); }

/** config.json：安装版在 resources/app；开发树回退 live-2d/config.json（便于本地测组件） */
function appConfigPath(root) {
    const packaged = path.join(root, 'resources', 'app', 'config.json');
    if (isFile(packaged)) return packaged;
    const dev = path.join(root, '_incoming', 'my-neuro', 'live-2d', 'config.json');
    if (isFile(dev)) return dev;
    return packaged;
}

/** 深度合并 config 补丁（点号键） */
function setPath(obj, dotted, value) {
    const parts = String(dotted).split('.').filter(Boolean);
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i += 1) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
}
function getPath(obj, dotted) {
    return String(dotted).split('.').filter(Boolean).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}
function deletePath(obj, dotted) {
    const parts = String(dotted).split('.').filter(Boolean);
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i += 1) { if (!cur || typeof cur !== 'object') return; cur = cur[parts[i]]; }
    if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
}

function patchAppConfig(root, patches) {
    const cfgPath = appConfigPath(root);
    if (!isFile(cfgPath)) return { ok: false, error: '找不到安装版 config.json：' + cfgPath };
    const before = readJson(cfgPath, null);
    if (!before) return { ok: false, error: 'config.json 解析失败（拒绝覆盖）' };
    const cfg = JSON.parse(JSON.stringify(before));
    for (const [key, value] of Object.entries(patches || {})) {
        if (value === null) deletePath(cfg, key);
        else setPath(cfg, key, value);
    }
    if (JSON.stringify(cfg) === JSON.stringify(before)) return { ok: true, changed: false, path: cfgPath };
    const bak = cfgPath + '.bak-components-' + new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.copyFileSync(cfgPath, bak); } catch (e) { /* 备份失败不阻断，下面原子写仍安全 */ }
    atomicWrite(cfgPath, JSON.stringify(cfg, null, 2));
    const check = readJson(cfgPath, null);
    if (!check || JSON.stringify(check) !== JSON.stringify(cfg)) return { ok: false, error: 'config.json 回读不一致' };
    return { ok: true, changed: true, path: cfgPath, backup: isFile(bak) ? bak : '' };
}

function restoreConfig(root, before) {
    const cfgPath = appConfigPath(root);
    const cfg = readJson(cfgPath, null);
    if (!cfg || !before) return { ok: true, changed: false };
    let changed = false;
    for (const [key, rec] of Object.entries(before)) {
        if (!rec) continue;
        if (rec.exists) { setPath(cfg, key, rec.value); changed = true; }
        else { deletePath(cfg, key); changed = true; }
    }
    if (!changed) return { ok: true, changed: false };
    const bak = cfgPath + '.bak-components-' + new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.copyFileSync(cfgPath, bak); } catch (e) { /* ignore */ }
    atomicWrite(cfgPath, JSON.stringify(cfg, null, 2));
    return { ok: true, changed: true, backup: isFile(bak) ? bak : '' };
}

// ── 下载（重定向 / Range 续传 / 进度 / 超时换源） ─────────────────────────
function httpGet(url, opts = {}) {
    const mod = /^http:\/\//i.test(url) ? http : https;
    return mod.get(url, {
        timeout: opts.timeoutMs || 30000,
        // 不要复用全局 keep-alive agent：大文件下载+校验+解压可能超过服务端 5s 空闲超时，
        // 下一个请求复用半关闭 socket 会 ECONNRESET（2026-11-27 E2E 实测）。
        agent: false,
        headers: Object.assign({
            'User-Agent': 'DaFeiyu-Installer/0.4.0',
            'Accept': '*/*',
            'Accept-Encoding': 'identity',
        }, opts.headers || {}),
    }, (res) => {
        // 重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (opts.redirects || 0) < 6) {
            res.resume();
            const next = new URL(res.headers.location, url).toString();
            return httpGet(next, Object.assign({}, opts, { redirects: (opts.redirects || 0) + 1 }));
        }
        opts.onResponse && opts.onResponse(res);
    }).on('error', (e) => opts.onError && opts.onError(e))
      .on('timeout', function onT() { this.destroy(new Error('连接超时 ' + (opts.timeoutMs || 30000) + 'ms')); });
}

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const s = fs.createReadStream(file);
        s.on('data', (d) => h.update(d));
        s.on('error', reject);
        s.on('end', () => resolve(h.digest('hex')));
    });
}

function downloadOne(url, dest, opts = {}) {
    const part = dest + '.part';
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let existing = 0;
    try { existing = fs.statSync(part).size; } catch (e) { existing = 0; }
    return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        const headers = {};
        if (existing > 0) headers.Range = 'bytes=' + existing + '-';
        let req = null;
        const start = Date.now();
        let lastTick = 0;
        let lastBytes = existing;
        httpGet(url, {
            headers,
            timeoutMs: opts.timeoutMs || 30000,
            onResponse: (res) => {
                if (res.statusCode === 416) {
                    res.resume();
                    // 断点越界：多半是上次已下完但没改名。清掉重下一次（只重试一次）。
                    if (!opts._retry416) {
                        try { fs.unlinkSync(part); } catch (e) { /* ignore */ }
                        return downloadOne(url, dest, Object.assign({}, opts, { _retry416: true })).then(done);
                    }
                    return done({ ok: false, error: 'HTTP 416（Range 越界）' });
                }
                if (res.statusCode !== 200 && res.statusCode !== 206) {
                    res.resume();
                    return done({ ok: false, error: 'HTTP ' + res.statusCode + ' ' + url });
                }
                const append = res.statusCode === 206 && existing > 0;
                const total = append ? existing + Number(res.headers['content-length'] || 0) : Number(res.headers['content-length'] || 0);
                const ws = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
                let received = append ? existing : 0;
                res.on('data', (chunk) => {
                    received += chunk.length;
                    const now = Date.now();
                    if (opts.onProgress && now - lastTick > 400) {
                        lastTick = now;
                        const elapsed = Math.max(0.001, (now - start) / 1000);
                        opts.onProgress({ received, total, bps: Math.max(0, (received - lastBytes) / Math.max(0.1, (now - (lastTick - 400)) / 1000)), elapsed, url });
                        lastBytes = received;
                    }
                });
                res.pipe(ws);
                ws.on('finish', () => { try { ws.close(); } catch (e) { /* ignore */ } done({ ok: true, bytes: received, total }); });
                ws.on('error', (e) => done({ ok: false, error: '写盘失败: ' + e.message }));
                res.on('error', (e) => done({ ok: false, error: '下载中断: ' + e.message }));
            },
            onError: (e) => done({ ok: false, error: e.message }),
        });
    });
}

async function downloadWithSources(file, dest, opts = {}) {
    // GitHub 直连在部分网络会被重置；对 github.com 源自动追加公共代理备用（仍做 SHA256 校验）。
    const raw = (file.sources || []).slice();
    const expanded = [];
    for (const s of raw) {
        expanded.push(s);
        if (/^https:\/\/github\.com\//i.test(String(s.url || ''))) {
            expanded.push({ url: 'https://gh-proxy.com/' + s.url, priority: (s.priority || 99) + 0.1 });
            expanded.push({ url: 'https://ghproxy.net/' + s.url, priority: (s.priority || 99) + 0.2 });
        }
    }
    const seen = new Set();
    const sources = expanded
        .filter((s) => s && s.url && !seen.has(s.url) && seen.add(s.url))
        .sort((a, b) => (a.priority || 99) - (b.priority || 99));
    if (!sources.length) return { ok: false, error: '没有下载源：' + (file.name || dest) };
    const errors = [];
    for (const src of sources) {
        try {
            if (opts.onStatus) opts.onStatus({ phase: 'download', url: src.url, name: file.name || path.basename(dest) });
            const r = await downloadOne(src.url, dest, opts);
            if (!r.ok) { errors.push(src.url + ' → ' + r.error); continue; }
            if (file.sha256) {
                const got = await sha256File(dest + '.part');
                if (got.toLowerCase() !== String(file.sha256).toLowerCase()) {
                    errors.push(src.url + ' → SHA256 不匹配（期望 ' + file.sha256.slice(0, 12) + '…，实得 ' + got.slice(0, 12) + '…）');
                    try { fs.unlinkSync(dest + '.part'); } catch (e) { /* 下次重下 */ }
                    continue;
                }
            }
            fs.renameSync(dest + '.part', dest);
            return { ok: true, source: src.url, bytes: r.bytes };
        } catch (e) {
            errors.push(src.url + ' → ' + (e && e.message || e));
        }
    }
    return { ok: false, error: '所有源都失败：\n  ' + errors.join('\n  ') };
}

// ── 解压（bsdtar；Windows 10+ 自带） ─────────────────────────────────────
function tarExe() {
    const p = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    return isFile(p) ? p : 'tar';
}
function extractZip(zip, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const r = spawnSync(tarExe(), ['-xf', zip, '-C', dest], { windowsHide: true, encoding: 'utf8', timeout: 30 * 60 * 1000 });
    if (r.status !== 0) return { ok: false, error: '解压失败（tar exit ' + r.status + '）：' + String(r.stderr || '').slice(0, 300) };
    return { ok: true };
}
function extract7z(zip, dest) { return extractZip(zip, dest); } // 7za 未随包前只支持 zip

// ── 组件安装 ────────────────────────────────────────────────────────────
function loadManifest(root) {
    const cdir = componentsDir(root);
    const candidates = [
        path.join(cdir, 'manifest.json'),
        path.join(root, 'resources', 'app', 'components.manifest.json'),
        path.join(root, 'resources', 'components', 'manifest.json'),
    ];
    for (const p of candidates) {
        const doc = readJson(p, null);
        if (doc && Array.isArray(doc.components)) return { ok: true, doc, path: p };
    }
    return { ok: false, error: '找不到组件清单 components/manifest.json（安装包不完整？）' };
}
function loadState(root) {
    return readJson(path.join(componentsDir(root), 'state.json'), { schema: SCHEMA, installed: {} });
}
function saveState(root, state) {
    state.schema = SCHEMA;
    state.updatedAt = new Date().toISOString();
    atomicWrite(path.join(componentsDir(root), 'state.json'), JSON.stringify(state, null, 2));
}
function resolveIds(manifest, wanted) {
    const byId = new Map(manifest.components.map((c) => [c.id, c]));
    const out = [];
    const visit = (id, stack) => {
        const c = byId.get(id);
        if (!c) throw new Error('未知组件：' + id);
        if (out.includes(id)) return;
        if (stack.includes(id)) throw new Error('组件依赖成环：' + stack.concat(id).join(' → '));
        for (const dep of (c.requires || [])) visit(dep, stack.concat(id));
        out.push(id);
    };
    for (const id of wanted) visit(id, []);
    return out;
}

function materializeService(svc, ctx) {
    const replace = (s) => String(s)
        .replace(/\{root\}/g, ctx.root)
        .replace(/\{components\}/g, ctx.components)
        .replace(/\{python\}/g, ctx.python)
        .replace(/\{pythonDir\}/g, path.dirname(ctx.python))
        .replace(/\{dir\}/g, ctx.dir)
        .replace(/\{site\}/g, ctx.site)
        .replace(/\{models\}/g, path.join(ctx.components, 'models'));
    const out = JSON.parse(JSON.stringify(svc));
    out.cmd = (out.cmd || []).map(replace);
    out.cwd = out.cwd ? replace(out.cwd) : ctx.dir;
    out.env = Object.fromEntries(Object.entries(out.env || {}).map(([k, v]) => [k, replace(v)]));
    out.component = ctx.id;
    return out;
}

async function install(root, ids, opts = {}) {
    const man = loadManifest(root);
    if (!man.ok) return man;
    const manifest = man.doc;
    const cdir = componentsDir(root);
    const state = loadState(root);
    let order;
    try { order = resolveIds(manifest, ids); } catch (e) { return { ok: false, error: e.message }; }
    const byId = new Map(manifest.components.map((c) => [c.id, c]));
    const log = opts.onStatus || (() => {});
    const installed = [];

    for (const id of order) {
        const c = byId.get(id);
        const dir = path.join(cdir, c.extractTo || id);
        log({ phase: 'component', id, name: c.name, version: c.version });
        const prev = (state.installed[id] && Array.isArray(state.installed[id].files)) ? state.installed[id].files : [];
        const installedFiles = [];
        // 1) 文件/归档
        for (const f of (c.files || [])) {
            const dest = path.join(cdir, f.dest || path.join(c.extractTo || id, f.name || ''));
            const archive = /\.zip$/i.test(dest);
            const extractTo = f.extractTo || c.extractTo || id;
            const extractDir = path.join(cdir, extractTo);
            // 幂等：同一份文件哈希已经装过（归档看解压目录是否还在；单文件看目标是否存在）
            const already = !!(f.sha256 && prev.includes(f.sha256)
                && (archive ? isDir(extractDir) : isFile(dest)));
            if (already) {
                installedFiles.push(f.sha256);
                log({ phase: 'file', id, dest, skipped: true });
                continue;
            }
            const dl = await downloadWithSources(f, dest, {
                onProgress: opts.onProgress,
                onStatus: log,
            });
            if (!dl.ok) return { ok: false, error: '组件 ' + id + ' 下载失败：' + dl.error };
            if (archive) {
                const ex = extractZip(dest, extractDir);
                if (!ex.ok) return { ok: false, error: '组件 ' + id + ' ' + ex.error };
                if (f.removeArchive !== false) { try { fs.unlinkSync(dest); } catch (e) { /* ignore */ } }
            }
            if (f.sha256) installedFiles.push(f.sha256);
            log({ phase: 'file', id, dest, done: true });
        }
        // 2) 配置补丁（先记下原值，卸载时还原）
        let configBefore = {};
        if (c.config && Object.keys(c.config).length) {
            const cfgNow = readJson(appConfigPath(root), {}) || {};
            for (const key of Object.keys(c.config)) {
                const v = getPath(cfgNow, key);
                configBefore[key] = { exists: v !== undefined, value: v };
            }
            const pr = patchAppConfig(root, c.config);
            if (!pr.ok) return { ok: false, error: '组件 ' + id + ' 写配置失败：' + pr.error };
            log({ phase: 'config', id, changed: pr.changed, backup: pr.backup || '' });
        }
        // 2.5) 组件自带的安装后配置（例如 memory 要把用户的云 key 写进 memos_config）
        if (c.setup) {
            try {
                const setupPath = path.isAbsolute(c.setup) ? c.setup : path.join(__dirname, '..', '..', c.setup);
                // eslint-disable-next-line global-require, import/no-dynamic-require
                const mod = require(setupPath);
                if (!mod || typeof mod.run !== 'function') throw new Error('setup 模块没有 run()');
                const sr = await mod.run({
                    root, components: cdir, dir,
                    log,
                    config: readJson(appConfigPath(root), {}) || {},
                });
                if (sr && sr.ok === false) return { ok: false, error: '组件 ' + id + ' setup 失败：' + sr.error };
                log({ phase: 'setup', id, done: true });
            } catch (e) {
                return { ok: false, error: '组件 ' + id + ' setup 异常：' + (e && e.message || e) };
            }
        }
        state.installed[id] = { version: c.version, installedAt: new Date().toISOString(), files: installedFiles, configBefore };
        saveState(root, state);
        installed.push(id);
    }

    // 3) 物化 services.json（只列已安装组件的服务）
    const services = [];
    for (const [id, rec] of Object.entries(state.installed)) {
        const c = byId.get(id);
        if (!c || !Array.isArray(c.services)) continue;
        const ctx = {
            root,
            components: cdir,
            python: path.join(cdir, 'python', 'python.exe'),
            dir: path.join(cdir, c.extractTo || id),
            site: (c.siteDirs || []).map((d) => path.join(cdir, c.extractTo || id, d)).join(';'),
            id,
        };
        for (const svc of c.services) services.push(materializeService(svc, ctx));
    }
    atomicWrite(path.join(cdir, 'services.json'), JSON.stringify({ schema: SCHEMA, services }, null, 2));
    log({ phase: 'done', installed, services: services.length });
    return { ok: true, installed, services: services.length };
}

function status(root) {
    const man = loadManifest(root);
    const state = loadState(root);
    if (!man.ok) return { ok: false, error: man.error, installed: state.installed };
    return {
        ok: true,
        manifestPath: man.path,
        components: man.doc.components.map((c) => ({
            id: c.id,
            name: c.name,
            version: c.version,
            sizeBytes: c.sizeBytes || (c.files || []).reduce((s, f) => s + (f.sizeBytes || 0), 0),
            requires: c.requires || [],
            installedVersion: (state.installed[c.id] || {}).version || '',
            installed: !!state.installed[c.id],
        })),
        installed: state.installed,
    };
}

function remove(root, ids) {
    const state = loadState(root);
    const cdir = componentsDir(root);
    for (const id of ids) {
        const rec = state.installed[id];
        if (!rec) continue;
        if (rec.configBefore) {
            const rr = restoreConfig(root, rec.configBefore);
            if (!rr.ok) return { ok: false, error: '卸载 ' + id + ' 还原配置失败：' + rr.error };
        }
        delete state.installed[id];
        const dir = path.join(cdir, id);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
    saveState(root, state);
    // 重建 services.json
    const man = loadManifest(root);
    if (man.ok) return install(root, [], { onStatus: () => {} }).then(() => ({ ok: true, removed: ids }));
    return Promise.resolve({ ok: true, removed: ids });
}

module.exports = {
    SCHEMA,
    installRoot,
    componentsDir,
    appConfigPath,
    loadManifest,
    loadState,
    install,
    status,
    remove,
    patchAppConfig,
    downloadWithSources,
    extractZip,
    sha256File,
    getPath,
    setPath,
    materializeService,
};
