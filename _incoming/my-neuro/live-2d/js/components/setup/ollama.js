'use strict';
// js/components/setup/ollama.js —— Ollama 组件安装后配置（2026-11-27 v0.5.0）
//
// 装什么：便携 Ollama（components/ollama/ollama.exe + lib/ollama/，来自官方
//         ollama-windows-amd64.zip，见 _packaging/build-ollama-pack.ps1），
//         以及三个模型：qwen3-vl:8b-instruct / glm-ocr:latest / paddleocr-vl:latest。
//         模型名与 scripts/fetch-models.mjs 的 MODELS 清单逐字一致（单一事实源）。
//
// 为什么模型不在 zip 里：三个模型 ~9.3GB，Ollama registry 自己分块、校验、按层去重，
// 比我们重新分发 GGUF 省带宽也省维护。所以 setup 必须在安装时拉起服务并拉模型。
//
// 三条硬规则（2026-11-27 用户要求）：
//   ① 11434 上已有 Ollama（桌面版托盘常驻）→ **复用**：不重复起服务、不杀、不重启；
//   ② 只有 11434 空闲时才用组件内 ollama.exe 起服务；拉完模型后把它交还给宿主 supervisor
//      （components/services.json 里的 ollama 服务），不留孤儿进程；
//   ③ 拉之前先查磁盘（至少 12GB 空闲），失败必须返回 ok:false + 可操作原因。
//
// 刻意**不**打开 vision.tiers.enabled（重要，改动前先读这段）：
//   消费点唯一：plugins/community/watch-screen/index.js 的 `_visionTierCfg()`
//   —— 只有 `config.vision.tiers.enabled === true` 才把看屏摘要交给本地 qwen3-vl；
//   否则（当前生产配置）看屏摘要走云端 provider（deepseek-v4.1-flash）。
//   A/B 已定案不启用（docs/评估-视觉分档A-B-2026-11-23.md：本地 8B 细字/专名更弱、
//   装载后只剩 263MB 显存、高低档阈值抖动）。组件只保证 Ollama + 模型可用；
//   OCR（pet-runtime/tools/ocr_read.py）本来就直接打 http://127.0.0.1:11434/api/generate，
//   默认 glm-ocr:latest，不需要任何配置补丁。所以本组件 config 是空的。
//
// 返回约定（manager.install() 认这个）：
//   { ok:true,  server, version, models:[...], warnings:[], log }
//   { ok:false, error, hint, log, models? }
//
// ctx 可选字段（正式安装不传：manager 只给 root/components/dir/log/config）：
//   ctx.port    —— 换端口（仅测试隔离用；生产钉死 11434，因为 ocr_read.py 默认打 11434）
//   ctx.models  —— 只处理清单里的某几个（子集，防止模型名漂移），用于最小安装/隔离测试

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 11434;
const MIN_FREE_GIB = 12;          // 三个模型 ~9.3GiB + 解压/临时余量
const START_TIMEOUT_MS = 60000;   // 与 fragment 的 startTimeoutMs 对齐
const IDLE_TIMEOUT_MS = 120000;   // pull 流 120s 没数据才算断（不是总时长）
const USER_AGENT = 'DaFeiyu-Components/0.5.0';

// required=true：缺了组件就算没装好（看屏 / 默认 OCR）；
// required=false：可选第二档（PET_OCR_MODEL=paddleocr-vl 才用），失败只告警不判死。
const MODELS = [
    { name: 'qwen3-vl:8b-instruct', required: true, approxGib: 5.8, why: '本地看屏/视觉（tiers.enabled=false 时仅供离线/外部脚本使用）' },
    { name: 'glm-ocr:latest', required: true, approxGib: 2.5, why: '默认 OCR（pet-runtime/tools/ocr_read.py 的 MODEL_GLM）' },
    { name: 'paddleocr-vl:latest', required: false, approxGib: 1.0, why: '可选 OCR 第二档（PET_OCR_MODEL=paddleocr-vl）' },
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function normName(name) {
    const s = String(name || '').trim();
    return s.includes(':') ? s : s + ':latest';
}

function isFile(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }

function appendLog(file, line) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, line.endsWith('\n') ? line : line + '\n', 'utf8');
    } catch (e) { /* 日志写失败不影响主流程 */ }
}

// ── HTTP（纯 http，不用 fetch：Electron-as-Node 下 fetch/undici 有退出坑） ──
function httpJson(url, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        let req;
        try {
            req = http.get(url, { timeout: timeoutMs || 3000, headers: { 'User-Agent': USER_AGENT } }, (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (d) => {
                    body += d;
                    // /api/tags 正常只有几十 KB；异常大就直接放弃，避免把内存吃满
                    if (body.length > 8 * 1024 * 1024) {
                        try { res.destroy(); } catch (e) { /* ignore */ }
                        done({ ok: false, error: '返回过大（不是 Ollama？）' });
                    }
                });
                res.on('end', () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) return done({ ok: false, error: 'HTTP ' + res.statusCode });
                    try { done({ ok: true, json: JSON.parse(body) }); } catch (e) { done({ ok: false, error: '返回不是 JSON' }); }
                });
                res.on('error', (e) => done({ ok: false, error: e.message }));
            });
            req.on('error', (e) => done({ ok: false, error: e.message }));
            req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } done({ ok: false, error: '超时' }); });
        } catch (e) { done({ ok: false, error: e.message }); }
    });
}

function portOpen(port, host, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        let socket;
        try { socket = net.connect({ port, host: host || DEFAULT_HOST }); } catch (e) { return done(false); }
        socket.setTimeout(timeoutMs || 600);
        socket.once('connect', () => { try { socket.destroy(); } catch (e) { /* ignore */ } done(true); });
        socket.once('timeout', () => { try { socket.destroy(); } catch (e) { /* ignore */ } done(false); });
        socket.once('error', () => { try { socket.destroy(); } catch (e) { /* ignore */ } done(false); });
    });
}

/** 是否为 Ollama（不是「端口上随便什么东西」）。返回 {ok, names, version} */
async function probeOllama(base, timeoutMs) {
    const r = await httpJson(base + '/api/tags', timeoutMs || 3000);
    if (!r.ok) return { ok: false, error: r.error };
    const doc = r.json || {};
    if (!Array.isArray(doc.models)) return { ok: false, error: base + ' 上的服务不是 Ollama（/api/tags 无 models 数组）' };
    const names = doc.models.map((m) => normName(m && (m.name || m.model)));
    const v = await httpJson(base + '/api/version', 2000);
    return { ok: true, names, version: (v.ok && v.json && v.json.version) || '' };
}

/** 空闲空间（GiB）。statfs 不可用时返回 null（不阻断，只少一道闸）。 */
function freeGib(dir) {
    try {
        if (typeof fs.statfsSync === 'function') {
            const st = fs.statfsSync(dir);
            const avail = Number(st.bavail) * Number(st.bsize);
            if (isFinite(avail) && avail > 0) return avail / (1024 ** 3);
        }
    } catch (e) { /* 路径不存在/老 Node：跳过 */ }
    return null;
}

function parseVersion(v) {
    const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function versionLt(a, b) {
    for (let i = 0; i < 3; i += 1) {
        if ((a[i] || 0) < (b[i] || 0)) return true;
        if ((a[i] || 0) > (b[i] || 0)) return false;
    }
    return false;
}

function findExe(dir) {
    const candidates = [
        path.join(dir, 'ollama.exe'),
        path.join(dir, 'ollama', 'ollama.exe'),
        path.join(dir, 'bin', 'ollama.exe'),
    ];
    for (const p of candidates) if (isFile(p)) return p;
    // 兜底：一层子目录里找（上游布局万一变成 <dir>/<version>/ollama.exe）
    try {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!ent.isDirectory()) continue;
            const p = path.join(dir, ent.name, 'ollama.exe');
            if (isFile(p)) return p;
        }
    } catch (e) { /* ignore */ }
    return '';
}

function hintFor(text) {
    const t = String(text || '');
    if (/no space left|not enough space|disk full|ENOSPC/i.test(t)) return '磁盘空间不足：清出至少 12GB 后重试（三个模型约 9.3GB）';
    if (/requires a newer version|unsupported|too old/i.test(t)) return '本机 Ollama 版本太旧，不认识该模型：升级 Ollama，或卸载旧版改用组件自带的 v0.40.18';
    if (/connection refused|ECONNREFUSED|failed to connect|socket hang up/i.test(t)) return '连不上 127.0.0.1:11434：确认 Ollama 服务在运行（看 components/logs/ollama-pull.log 里的 serve 日志）';
    if (/file does not exist|manifest unknown|not found|404/i.test(t)) return 'registry 里没有这个模型名：检查网络/代理后重试；也可手动 ollama pull 看具体报错';
    if (/unauthorized|401|403|forbidden/i.test(t)) return 'registry 鉴权/网关拦截：检查系统代理或公司网关是否挡了 registry.ollama.ai';
    if (/timeout|timed out|deadline/i.test(t)) return '网络超时：重试即可（Ollama 已下完的分层会续传，不会从头再来）';
    return '重试：组件页再点一次「安装」；已存在的模型会自动跳过';
}

/** POST /api/pull 流式拉取；不依赖 CLI，避免版本/路径问题。 */
function pullModel(base, name, logFile) {
    const target = new URL(base);
    return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        // 同时带 model / name：新版只认 model，老服务（<=0.1.x）读 name；多带一个字段无副作用
        const body = JSON.stringify({ model: name, name: name, stream: true });
        let buf = '';
        let lastWrite = 0;
        let lastStatus = '';
        let errorText = '';
        let bytesDone = 0;
        let bytesTotal = 0;
        let req;
        try {
            req = http.request({
                host: target.hostname, port: target.port || 80, path: '/api/pull', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': USER_AGENT },
            }, (res) => {
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    buf += chunk;
                    let idx;
                    while ((idx = buf.indexOf('\n')) >= 0) {
                        const line = buf.slice(0, idx).trim();
                        buf = buf.slice(idx + 1);
                        if (!line) continue;
                        let d;
                        try { d = JSON.parse(line); } catch (e) { continue; }
                        if (d.error) { errorText = String(d.error); continue; }
                        if (d.status) lastStatus = String(d.status);
                        if (typeof d.completed === 'number') bytesDone = d.completed;
                        if (typeof d.total === 'number') bytesTotal = d.total;
                        const now = Date.now();
                        if (now - lastWrite > 2000) {
                            lastWrite = now;
                            const pct = bytesTotal ? ' ' + Math.floor((bytesDone / bytesTotal) * 100) + '%' : '';
                            const mb = bytesTotal ? ' (' + (bytesDone / 1048576).toFixed(0) + '/' + (bytesTotal / 1048576).toFixed(0) + 'MB)' : '';
                            appendLog(logFile, '[pull ' + name + '] ' + lastStatus + pct + mb);
                        }
                    }
                });
                res.on('end', () => {
                    if (res.statusCode !== 200) return done({ ok: false, error: errorText || ('HTTP ' + res.statusCode) });
                    if (errorText) return done({ ok: false, error: errorText });
                    appendLog(logFile, '[pull ' + name + '] ✓ 完成');
                    done({ ok: true });
                });
                res.on('error', (e) => done({ ok: false, error: '下载中断: ' + e.message }));
            });
            // 空闲超时（不是总时长）：9GB 慢网也不会被掐
            req.setTimeout(IDLE_TIMEOUT_MS, () => { try { req.destroy(new Error('120s 无数据')); } catch (e) { /* ignore */ } });
            req.on('error', (e) => done({ ok: false, error: e.message }));
            req.write(body);
            req.end();
        } catch (e) { done({ ok: false, error: e.message }); }
    });
}

function startServer(exe, dir, logFile, host, port) {
    const modelsDir = path.join(dir, 'models');
    try { fs.mkdirSync(modelsDir, { recursive: true }); } catch (e) { /* ignore */ }
    // 只叠加组件需要的两个变量：OLLAMA_MODELS 把模型锁在组件目录（卸载即清），
    // OLLAMA_HOST 钉死 127.0.0.1:11434（不对外监听）。
    const env = Object.assign({}, process.env, {
        OLLAMA_MODELS: modelsDir,
        OLLAMA_HOST: host + ':' + port,
    });
    const child = spawn(exe, ['serve'], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const fwd = (d) => appendLog(logFile, d.toString('utf8'));
    if (child.stdout) child.stdout.on('data', fwd);
    if (child.stderr) child.stderr.on('data', fwd);
    return child;
}

function stopServer(child) {
    return new Promise((resolve) => {
        if (!child || child.exitCode !== null) return resolve();
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        killer.on('exit', () => resolve());
        killer.on('error', () => resolve());
    });
}

async function waitServer(base, deadline) {
    while (Date.now() < deadline) {
        const p = await probeOllama(base, 1500);
        if (p.ok) return p;
        await sleep(1000);
    }
    return null;
}

async function run(ctx = {}) {
    const dir = ctx.dir;
    const componentsDir = ctx.components || (dir ? path.dirname(dir) : '');
    const log = typeof ctx.log === 'function' ? ctx.log : () => {};
    if (!dir) return { ok: false, error: '缺少 ctx.dir（组件目录）' };
    const host = ctx.host || DEFAULT_HOST;
    const port = Number(ctx.port) || DEFAULT_PORT;
    const base = 'http://' + host + ':' + port;
    // 只允许在清单内取子集（正式安装 = 全部）：保证模型名仍以 MODELS 为唯一事实源
    const wanted = (Array.isArray(ctx.models) && ctx.models.length)
        ? MODELS.filter((m) => ctx.models.map(normName).includes(normName(m.name)))
        : MODELS;

    const logFile = path.join(componentsDir || dir, 'logs', 'ollama-pull.log');
    appendLog(logFile, '\n=== ' + new Date().toISOString() + ' ollama setup（组件 ' + dir + '，端点 ' + base + '） ===');

    // ── ① 磁盘闸（拉之前就说清楚，别拉到 8GB 才报 ENOSPC）──
    const modelsDrive = dir;
    const free = freeGib(modelsDrive);
    if (free !== null) {
        appendLog(logFile, '[disk] ' + path.parse(modelsDrive).root + ' 空闲 ' + free.toFixed(1) + ' GiB');
        if (free < MIN_FREE_GIB) {
            return {
                ok: false,
                error: '磁盘空间不足：' + path.parse(modelsDrive).root + ' 只剩 ' + free.toFixed(1) + ' GiB，需要至少 ' + MIN_FREE_GIB + ' GiB（三个模型约 9.3GB）',
                hint: '清理磁盘后到组件页再点一次「安装」（已下完的分层会续传）',
                log: logFile,
            };
        }
    } else {
        appendLog(logFile, '[disk] 无法读取空闲空间（fs.statfs 不可用），跳过磁盘闸');
        log('[ollama] 无法读取磁盘空闲空间，跳过 12GB 检查');
    }

    // ── ② 服务：已有就用，没有才起（绝不杀别人的 Ollama）──
    let reused = false;
    let startedChild = null;
    let exe = findExe(dir);
    let probe = await probeOllama(base, 3000);
    let serverVersion = '';

    if (probe.ok) {
        reused = true;
        serverVersion = probe.version || '';
        appendLog(logFile, '[server] 复用已在运行的 Ollama @' + base + (serverVersion ? ' v' + serverVersion : ''));
        log('[ollama] ' + port + ' 已有 Ollama（' + (serverVersion || '版本未知') + '），复用，不重复启动');
    } else {
        if (await portOpen(port)) {
            // 端口被占但不是 Ollama：不能抢，也不能杀
            return {
                ok: false,
                error: '端口 ' + port + ' 被其他程序占用（/api/tags 返回的不是 Ollama）',
                hint: '关掉占用 ' + port + ' 的程序（换端口需要同时改 OCR 的 PET_OCR_ENDPOINT），或在 ollama 组件里点「安装」重试',
                log: logFile,
            };
        }
        if (!exe) {
            return {
                ok: false,
                error: '组件里找不到 ollama.exe：' + path.join(dir, 'ollama.exe'),
                hint: '组件包没有正确解压（检查 components/ollama/ollama.exe 是否存在），到组件页重新安装',
                log: logFile,
            };
        }
        appendLog(logFile, '[server] 启动 ' + exe + ' serve（OLLAMA_MODELS=' + path.join(dir, 'models') + '）');
        log('[ollama] ' + port + ' 空闲，用组件内 ollama 起服务（models → ' + path.join(dir, 'models') + '）');
        try {
            startedChild = startServer(exe, dir, logFile, host, port);
        } catch (e) {
            return { ok: false, error: '启动 ollama serve 失败：' + (e && e.message || e), hint: hintFor(e && e.message), log: logFile };
        }
        // 进程早退（缺 DLL / 端口竞争）要立刻说，而不是干等 60s
        let exited = null;
        startedChild.on('exit', (code) => { exited = code; });
        probe = await waitServer(base, Date.now() + START_TIMEOUT_MS);
        if (!probe || !probe.ok) {
            const code = exited !== null ? '（进程已退出 code=' + exited + '）' : '（进程仍在但没响应）';
            await stopServer(startedChild);
            return {
                ok: false,
                error: 'ollama serve 在 ' + (START_TIMEOUT_MS / 1000) + 's 内没有就绪 ' + code,
                hint: '看 components/logs/ollama-pull.log 末尾的 serve 日志；常见原因：缺 VC++ 运行库、被安全软件拦、lib/ollama 被删',
                log: logFile,
            };
        }
        serverVersion = probe.version || '';
        appendLog(logFile, '[server] 就绪 v' + serverVersion);
    }

    // 版本闸：qwen3-vl 模型卡要求 Ollama >= 0.30.0（老服务会 pull 成功但跑不起来/直接拒绝）
    const need = [0, 30, 0];
    const have = parseVersion(serverVersion);
    if (have && versionLt(have, need)) {
        if (startedChild) await stopServer(startedChild);
        return {
            ok: false,
            error: 'Ollama 版本太旧：' + serverVersion + '（qwen3-vl 需要 >= 0.30.0）',
            hint: '升级/退出旧版 Ollama 后重试；组件自带的是 v0.40.18，卸载旧版即可让组件服务接管 11434',
            log: logFile,
        };
    }

    // ── ③ 拉模型（已存在跳过；逐个成功/失败都记账）──
    const haveSet = new Set(probe.names || []);
    const results = [];
    for (const m of wanted) {
        const name = normName(m.name);
        const present = haveSet.has(name);
        if (present) {
            appendLog(logFile, '[model] ' + m.name + ' 已存在，跳过');
            log('[ollama] ' + m.name + ' 已存在，跳过');
            results.push({ name: m.name, present: true, pulled: false, required: m.required });
            continue;
        }
        const approx = m.approxGib ? '（约 ' + m.approxGib + 'GB）' : '';
        appendLog(logFile, '[model] pull ' + m.name + approx);
        log('[ollama] 拉取 ' + m.name + approx + ' …');
        const r = await pullModel(base, m.name, logFile);
        if (r.ok) {
            haveSet.add(name);
            results.push({ name: m.name, present: true, pulled: true, required: m.required });
            log('[ollama] ✓ ' + m.name);
        } else {
            results.push({ name: m.name, present: false, pulled: false, required: m.required, error: r.error });
            appendLog(logFile, '[model] ✗ ' + m.name + '：' + r.error);
            log('[ollama] ✗ ' + m.name + '：' + r.error);
        }
    }

    // 复核：pull 返回成功也可能因为磁盘满/被安全软件删而没落盘（fetch-models.mjs 同样的教训）
    const after = await probeOllama(base, 3000);
    const afterSet = new Set(after.ok ? after.names : []);
    const missingRequired = [];
    const warnings = [];
    for (const m of wanted) {
        const name = normName(m.name);
        const okNow = afterSet.has(name);
        const rec = results.find((x) => x.name === m.name);
        if (rec) rec.present = okNow;
        if (okNow) continue;
        if (m.required) missingRequired.push(m.name);
        else warnings.push('可选模型 ' + m.name + ' 未就绪（不影响默认 OCR；' + m.why + '）');
    }

    // ── ④ 交还服务：我们临时起的那个停掉，由宿主 supervisor（services.json）接管 ──
    // 不这么做的话，app 退出时 services.js 的 stopAll 收不到它 → 孤儿进程一直占 11434。
    if (startedChild) {
        await stopServer(startedChild);
        for (let i = 0; i < 20; i += 1) {
            if (!(await portOpen(port))) break;
            await sleep(250);
        }
        const still = await portOpen(port);
        appendLog(logFile, '[server] 已停止临时服务（端口' + (still ? '仍被占用，请检查' : '已释放') + '），交给宿主 supervisor 拉起');
        if (still) warnings.push('临时 Ollama 已停但端口 ' + port + ' 仍被占用：检查是否有残留进程');
    }

    if (missingRequired.length) {
        const firstErr = (results.find((x) => !x.present && x.required) || {}).error || '';
        return {
            ok: false,
            error: '必需模型没装上：' + missingRequired.join(', ') + (firstErr ? '（' + firstErr + '）' : ''),
            hint: hintFor(firstErr),
            models: results,
            warnings,
            log: logFile,
        };
    }

    // 给用户一句人话：服务现在归谁管
    const pulledAny = results.some((r) => r.pulled);
    const serverNote = reused
        ? '复用系统已有 Ollama（未重启、未改它的配置）；模型进了它自己的模型库'
        : (pulledAny
            ? '模型已拉取到 ' + path.join(dir, 'models') + '，服务交给宿主 supervisor 启动'
            : '没有新模型需要下载；服务交给宿主 supervisor 启动');
    appendLog(logFile, '[done] ' + serverNote + (warnings.length ? '；warnings=' + warnings.length : ''));

    return {
        ok: true,
        server: reused ? 'reused' : 'component',
        version: serverVersion,
        models: results,
        warnings,
        log: logFile,
        note: serverNote,
    };
}

module.exports = { run, MODELS };
