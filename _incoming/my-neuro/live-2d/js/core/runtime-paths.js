// js/core/runtime-paths.js —— Python 解释器解析的唯一真源。
//
// 为什么需要：本机 PATH 里的 `python` 是 Microsoft Store 占位符（一跑就 exit 49，
//   还会弹商店），于是各插件纷纷写死 `<user-home>/.../Python313/python.exe`——
//   换机器、换目录、换用户就永久失效，而且 9 处各写一份，改一处漏八处。
//   这里按「环境变量 → 配置 → 官方安装目录 → py 启动器」逐级解析，
//   并且**排除 WindowsApps 占位符 + 实跑一次 `-c pass`**，确保返回的解释器真能执行。
//
//   const { resolvePython } = require('./runtime-paths');
//   spawn(resolvePython(), [script], { windowsHide: true });

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const WIN = process.platform === 'win32';
// Store 版 python.exe 的实现在 WindowsApps 目录里：existsSync 为 true，但一执行就跳商店。
const STORE_STUB_RE = /[\\/]WindowsApps[\\/]/i;

let _cached = null;

/** 是不是 Microsoft Store 的 App Execution Alias（必须排除，否则会弹商店而不是报错）。 */
function isStoreStub(exe) {
    return STORE_STUB_RE.test(String(exe || ''));
}

/** 实跑一次 `-c pass`：返回 false 说明这个 exe 起不来（损坏/占位符/缺 DLL）。 */
function _probe(exe, args) {
    try {
        execFileSync(exe, args, { timeout: 4000, windowsHide: true, stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

/** `where python`（Windows）/ `which python3`（其他平台）的结果，用来把裸命令换成真实路径。 */
function _which(cmd) {
    try {
        const out = execFileSync(WIN ? 'where' : 'which', [cmd], {
            timeout: 2000, windowsHide: true, encoding: 'utf8',
        });
        return String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch (e) {
        return [];
    }
}

/**
 * 校验一个候选：能跑就返回可用的解释器路径，否则返回 ''。
 * 绝对路径直接验；裸命令先 where/which 找真身再验——**绝不直接 spawn 裸 `python`**，
 * 否则商店占位符会被拉起来弹商店。
 */
function _validate(raw) {
    const exe = String(raw || '').trim();
    if (!exe || isStoreStub(exe)) return '';

    if (path.isAbsolute(exe) || /[\\/]/.test(exe)) {
        try { if (!fs.statSync(exe).isFile()) return ''; } catch (e) { return ''; }
        return _probe(exe, ['-c', 'pass']) ? exe : '';
    }

    // py 启动器：`py -3` 才会挑到一个真实解释器（`py -c pass` 在无默认版本时不可靠）
    if (WIN && /^py(\.exe)?$/i.test(exe)) {
        return _probe('py', ['-3', '-c', 'pass']) ? 'py' : '';
    }

    for (const cand of _which(exe)) {
        if (isStoreStub(cand)) continue;
        try { if (!fs.statSync(cand).isFile()) continue; } catch (e) { continue; }
        if (_probe(cand, ['-c', 'pass'])) return cand;
    }
    return '';
}

/** 官方安装目录里的候选：Python313 优先于 Python312（按版本号倒序，新的先试）。 */
function _officialCandidates() {
    if (!WIN) return [];
    const base = path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'Programs', 'Python'
    );
    let names = [];
    try { names = fs.readdirSync(base); } catch (e) { return []; }
    return names
        .filter((n) => /^Python3\d{1,2}$/i.test(n))
        .sort((a, b) => parseInt(b.replace(/\D/g, ''), 10) - parseInt(a.replace(/\D/g, ''), 10))
        .map((n) => path.join(base, n, 'python.exe'));
}

/** 从 config.json 读显式路径：支持 python_path / python.path / tools.python_path 几种写法。 */
function _configCandidates() {
    const cfgPath = process.env.MY_NEURO_CONFIG_PATH
        ? path.resolve(process.env.MY_NEURO_CONFIG_PATH)
        : path.join(__dirname, '..', '..', 'config.json');
    try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const pick = (v) => (v && typeof v === 'object' ? (v.value || v.default) : v);
        const pyNode = cfg.python;   // 既可能是路径字符串，也可能是 { path } 对象
        const raw = [
            cfg.python_path,
            cfg.pythonPath,
            typeof pyNode === 'string' ? pyNode : (pyNode && (pyNode.path || pyNode.executable || pyNode.cmd)),
            cfg.tools && cfg.tools.python_path,
        ];
        return raw.map(pick).filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
    } catch (e) {
        return [];
    }
}

/** 插件自己的 plugin_config.json（getPluginFileConfig 已扁平化，这里兼容 {value} 包装）。 */
function _pluginCandidates(config) {
    if (!config || typeof config !== 'object') return [];
    const pick = (v) => (v && typeof v === 'object' ? (v.value || v.default) : v);
    return ['python_path', 'pythonPath', 'python_cmd', 'python']
        .map((k) => pick(config[k]))
        .filter((v) => typeof v === 'string' && v.trim())
        .map((v) => v.trim());
}

/**
 * 解析一个可用的 Python 解释器。进程内只解析一次（探测要起子进程，别每次工具调用都付这个成本）。
 * @param {{config?: object, explicit?: string}} [options]
 *   config   —— 插件的 plugin_config.json（可选，显式路径优先级仅次于 PET_PYTHON）
 *   explicit —— 调用方硬指定（跳过缓存；runPythonScript 的 interpreter 参数走这里）
 * @returns {string} 解释器路径或裸命令（最后兜底 'python'/'python3'）
 */
function resolvePython(options = {}) {
    // 调用方硬指定：不走缓存；**不可用也不偷偷换掉**——否则「我明明指定了 conda 解释器」
    // 却跑在系统 Python 上，报出来的是缺包，真正的原因（路径写错）被埋掉。
    if (options.explicit) {
        const ok = _validate(options.explicit);
        if (ok) return ok;
        console.warn('[runtime-paths] 指定的解释器不可用（将原样返回，让调用方看到真实失败）：' + options.explicit);
        return String(options.explicit);
    }
    if (_cached) return _cached;

    // ① 环境变量 PET_PYTHON（用户临时覆盖，最高优先级）
    const envPy = process.env.PET_PYTHON;
    if (envPy) {
        const ok = _validate(envPy);
        if (ok) { _cached = ok; return ok; }
        console.warn('[runtime-paths] PET_PYTHON 不可用，已跳过：' + envPy);
    }

    // ② 插件配置 → config.json 的显式路径
    for (const cand of [..._pluginCandidates(options.config), ..._configCandidates()]) {
        const ok = _validate(cand);
        if (ok) { _cached = ok; return ok; }
    }

    // ③ 官方安装目录（本机 Python313 在这里）
    for (const cand of _officialCandidates()) {
        const ok = _validate(cand);
        if (ok) { _cached = ok; return ok; }
    }

    // ④ py 启动器（存在且能起 3.x 才用）
    if (WIN && _probe('py', ['-3', '-c', 'pass'])) {
        _cached = 'py';
        return _cached;
    }

    // ⑤ 最后才回落裸命令：where 找到非商店的真身就用真身，否则原样返回
    for (const cand of _which(WIN ? 'python' : 'python3')) {
        const ok = _validate(cand);
        if (ok) { _cached = ok; return ok; }
    }

    _cached = WIN ? 'python' : 'python3';
    console.warn('[runtime-paths] 没探测到可用 Python，回落 ' + _cached + '（很可能是商店占位符）');
    return _cached;
}

/** 清缓存（测试用：改了 PET_PYTHON 或装了新解释器后重新解析）。 */
function resetPythonCache() {
    _cached = null;
}

module.exports = { resolvePython, resetPythonCache };
