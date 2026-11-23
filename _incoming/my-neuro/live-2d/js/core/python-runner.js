// js/core/python-runner.js —— 一次性 Python 脚本的统一执行器。
//
// 为什么需要：四个桌面插件各自「写一个固定名字的 temp.py → call conda activate my-neuro &&
//   python temp.py」。三个问题叠在一起：
//   ① 本机没有 conda，`call conda activate` 直接失败，&& 短路 → 能力等于不存在；
//   ② 固定文件名（temp_click_123.py / temp_typing.py）在并发调用时互相覆盖，点错键/打错字；
//   ③ 每个插件都自己拼 shell 命令，中文参数过 cmd 会被按 GBK 解码成乱码。
//   这里统一收口：解释器走 resolvePython（带缓存）、临时文件名带 pid+时间戳+随机数、
//   参数走 spawn 数组（不经 shell，不存在引号/编码层）、无论成败都删临时文件。
//
//   const { runPythonScript } = require('./python-runner');
//   const r = await runPythonScript(source, { args: ['a'], timeoutMs: 10000, label: 'keyboard' });
//   if (!r.ok) throw new Error(r.error);

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { resolvePython } = require('./runtime-paths.js');

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;   // 单流上限：防止脚本死循环刷屏把进程内存吃穿

/** 文件名安全化：label 里可能带路径/空格，只留字母数字和 -_。 */
function _safeLabel(label) {
    return String(label || 'script').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'script';
}

/**
 * 把一段 Python 源码写到临时文件、跑完、删掉，返回统一结果。
 *
 * @param {string} source  Python 源码（UTF-8）
 * @param {{args?: string[], stdin?: string, timeoutMs?: number, cwd?: string,
 *          label?: string, interpreter?: string, env?: object}} [options]
 *   interpreter —— 可选覆盖（比如必须用 conda 里装了 pyautogui 的解释器）；
 *                  不传就走 resolvePython()。
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: number|null, error: string}>}
 *   ok=true 仅当进程正常退出且 code=0；失败时 error 带 stderr 前 500 字（不静默）。
 */
function runPythonScript(source, options = {}) {
    const {
        args = [],
        stdin,
        timeoutMs = 30000,
        cwd,
        label = 'script',
        interpreter,
        env,
    } = options;

    return new Promise((resolve) => {
        const py = interpreter ? resolvePython({ explicit: interpreter }) : resolvePython();
        // 唯一文件名：并发两次点击也不会互相覆盖（老实现写死 temp_click_<ms>.py）
        const tmpPath = path.join(
            os.tmpdir(),
            `pet-${_safeLabel(label)}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.py`
        );

        let child = null;
        let done = false;
        let timer = null;
        let stdout = '';
        let stderr = '';

        const cleanup = () => {
            try { fs.unlinkSync(tmpPath); } catch (e) {
                // 文件可能被脚本自己删了/被 Windows 占用：记账即可，不能让它盖掉真正的失败
                try { require('./silent-audit.js').audit('python-runner.js:cleanup', e); } catch (e2) {}
            }
        };

        const finish = (result) => {
            if (done) return;
            done = true;
            if (timer) { try { clearTimeout(timer); } catch (e) {} timer = null; }
            cleanup();
            resolve(result);
        };

        const fail = (msg, code) => finish({
            ok: false,
            stdout,
            stderr,
            code: code === undefined ? null : code,
            error: String(msg || '未知错误').slice(0, 500),
        });

        try {
            fs.writeFileSync(tmpPath, String(source), 'utf8');
            child = spawn(py, [tmpPath, ...args.map((a) => String(a))], {
                cwd,
                windowsHide: true,   // 不弹黑框（生产环境是桌面宠物，弹窗会打断用户）
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(env || {}) },
            });
        } catch (e) {
            return fail('解释器起不来（' + py + '）：' + (e && e.message || e));
        }

        const collect = (which) => (chunk) => {
            if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) return;
            if (which === 'out') stdout += chunk.toString('utf8');
            else stderr += chunk.toString('utf8');
        };
        child.stdout.on('data', collect('out'));
        child.stderr.on('data', collect('err'));
        // 脚本不读 stdin 时写端提前关闭会 EPIPE：吞掉，否则未捕获的 stream error 会崩主进程
        if (child.stdin) child.stdin.on('error', () => {});

        child.on('error', (e) => {
            // ENOENT（解释器不存在）/ 权限不足都走这里；带出解释器名，别只报 ENOENT
            fail('执行失败（' + py + '）：' + (e && e.message || e));
        });

        child.on('close', (code) => {
            if (code === 0) {
                return finish({ ok: true, stdout, stderr, code: 0, error: '' });
            }
            // 失败原因优先 stderr（Python traceback），没有就带上退出码
            const why = String(stderr || '').trim() || ('退出码 ' + code);
            finish({
                ok: false,
                stdout,
                stderr,
                code: code === null ? null : code,
                error: why.slice(0, 500),
            });
        });

        try {
            if (stdin === undefined || stdin === null) child.stdin.end();
            else child.stdin.end(String(stdin));
        } catch (e) { /* 脚本不读 stdin 时提前关闭会 EPIPE，正常 */ }

        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                try { child.kill(); } catch (e) {}
                fail('超时 ' + timeoutMs + 'ms（已终止）');
            }, timeoutMs);
            if (timer.unref) timer.unref();
        }
    });
}

module.exports = { runPythonScript };
