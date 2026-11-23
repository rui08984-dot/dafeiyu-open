// python-plugin-bridge.js
// 将 Python 插件进程包装成标准 Plugin 接口
// 通过 stdin/stdout JSON 通信

const { spawn } = require('child_process');
const path = require('path');
const { Plugin } = require('./plugin-base.js');
const { logToTerminal } = require('../api-utils.js');
const { resolvePython } = require('./runtime-paths.js');

// 解释器不再写死 'python'：本机 PATH 里的 python 是 Microsoft Store 占位符（exit 49），
// 一走就是「插件启动失败」。resolvePython 会跳过占位符、探测官方安装路径或 py 启动器。

// plugin_sdk.py 所在目录（plugins/）
const SDK_DIR = path.join(__dirname, '..', '..', 'plugins');

class PythonPluginBridge extends Plugin {
    constructor(metadata, context, scriptPath) {
        super(metadata, context);
        this._scriptPath = scriptPath;
        this._process = null;
        this._pending = new Map();
        this._reqId = 0;
        this._buffer = '';
        this._tools = [];
        this._timeout = 10000;
    }

    // ===== 启动子进程 =====

    async _spawn() {
        return new Promise((resolve, reject) => {
            this._process = spawn(resolvePython(), [this._scriptPath], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                env: {
                    ...process.env,
                    PYTHONIOENCODING: 'utf-8',
                    PYTHONPATH: SDK_DIR
                }
            });

            this._process.stdout.on('data', (data) => {
                this._buffer += data.toString('utf8');
                let idx;
                while ((idx = this._buffer.indexOf('\n')) !== -1) {
                    const line = this._buffer.slice(0, idx).trim();
                    this._buffer = this._buffer.slice(idx + 1);
                    if (line) this._handleLine(line);
                }
            });

            this._process.stderr.on('data', (data) => {
                logToTerminal('warn', `[Python:${this.metadata.name}] ${data.toString().trim()}`);
            });

            this._process.on('error', (err) => {
                logToTerminal('error', `[Python:${this.metadata.name}] 启动失败: ${err.message}`);
                reject(err);
            });

            this._process.on('exit', (code) => {
                for (const [, { reject }] of this._pending) {
                    reject(new Error('Python 进程已退出'));
                }
                this._pending.clear();
            });

            // 等进程启动
            setTimeout(resolve, 300);
        });
    }

    _handleLine(line) {
        try {
            const msg = JSON.parse(line);

            // 日志
            if (msg.type === 'log') {
                logToTerminal(msg.level || 'info', `[Python:${this.metadata.name}] ${msg.message}`);
                return;
            }
            // Python 主动让 AI 说话
            if (msg.type === 'sendMessage') {
                // 2026-11-15 六十三轮：Python 插件也是「主动发起者」，必须过同一张闸门表
                // （静默 / 预算 / userActive / 最小间隔）。此前 check-in 这类插件完全绕开协调器。
                const src = 'python:' + ((this.metadata && this.metadata.name) || 'plugin');
                let gate = null;
                try { gate = require('./speech-coordinator.js').singleton.request(src, { priority: 'proactive' }); } catch (e) { gate = null; }
                if (gate && !gate.allowed) {
                    logToTerminal('info', `[Python:${(this.metadata && this.metadata.name) || 'plugin'}] 让路：${gate.reason}`);
                    return;
                }
                Promise.resolve(this.context?.sendMessage(msg.text))
                    .then(() => { try { require('./speech-coordinator.js').singleton.markSpoken(src); } catch (e) { /* 记账失败不影响说话 */ } })
                    .catch(() => { try { require('./speech-coordinator.js').singleton.release(src, '发送失败'); } catch (e) { /* ignore */ } });
                return;
            }
            // Python 请求 JS 执行某个操作（get_messages / call_llm）
            if (msg.type === 'request') {
                this._handlePythonRequest(msg).catch(() => {});
                return;
            }
            // fire-and-forget：UI / 系统提示词 / 工具注册
            if (msg.type === 'showSubtitle') {
                this.context?.showSubtitle(msg.text, msg.duration);
                return;
            }
            if (msg.type === 'triggerEmotion') {
                this.context?.triggerEmotion(msg.emotion);
                return;
            }
            if (msg.type === 'addSystemPromptPatch') {
                this.context?.addSystemPromptPatch(msg.id, msg.text);
                return;
            }
            if (msg.type === 'removeSystemPromptPatch') {
                this.context?.removeSystemPromptPatch(msg.id);
                return;
            }
            if (msg.type === 'registerTool') {
                this.context?.registerTool(msg.toolDef);
                return;
            }
            // JS→Python 钩子调用的响应
            const pending = this._pending.get(msg.id);
            if (pending) {
                this._pending.delete(msg.id);
                msg.error ? pending.reject(new Error(msg.error)) : pending.resolve(msg);
            }
        } catch (e) {
            logToTerminal('warn', `[Python:${this.metadata.name}] 无效响应: ${line}`);
        }
    }

    _write(msg) {
        if (this._process?.stdin?.writable) {
            this._process.stdin.write(JSON.stringify(msg) + '\n');
        }
    }

    async _call(event, data) {
        if (!this._process || this._process.exitCode !== null) return null;

        return new Promise((resolve, reject) => {
            const id = ++this._reqId;
            this._pending.set(id, { resolve, reject });
            this._write({ id, event, data });

            setTimeout(() => {
                if (this._pending.has(id)) {
                    this._pending.delete(id);
                    reject(new Error(`超时: ${event}`));
                }
            }, this._timeout);
        });
    }

    async _handlePythonRequest(msg) {
        const { reqId, method, data } = msg;
        try {
            let result;
            if (method === 'getMessages') {
                result = this.context?.getMessages() || [];
            } else if (method === 'callLLM') {
                result = await this.context?.callLLM(data.prompt, data.options);
            } else {
                throw new Error(`未知方法: ${method}`);
            }
            this._write({ type: 'response', reqId, result });
        } catch (e) {
            this._write({ type: 'response', reqId, error: e.message });
        }
    }

    // ===== 生命周期 =====

    async onInit() {
        await this._spawn();
        const config = this.context?.getConfig() || {};
        const pluginFileConfig = this.context?.getPluginFileConfig() || {};
        await this._call('onInit', { config, pluginFileConfig });
        // 预加载工具列表（同步接口，需要提前缓存）
        const res = await this._call('getTools', {}).catch(() => null);
        this._tools = res?.tools || [];
    }

    async onStart() {
        await this._call('onStart', {}).catch(() => {});
    }

    async onStop() {
        await this._call('onStop', {}).catch(() => {});
        this._process?.stdin.end();
    }

    async onDestroy() {
        await this._call('onDestroy', {}).catch(() => {});
        if (this._process?.exitCode === null) this._process.kill();
    }

    // ===== 钩子 =====

    async onUserInput(event) {
        const res = await this._call('onUserInput', {
            text: event.text,
            source: event.source
        }).catch(() => null);

        for (const action of res?.actions || []) {
            if (action.type === 'addContext')     event.addContext(action.text);
            if (action.type === 'setText')        event.setText(action.text);
            if (action.type === 'preventDefault') event.preventDefault();
            if (action.type === 'stopPropagation') event.stopPropagation();
        }
    }

    async onLLMRequest(request) {
        const res = await this._call('onLLMRequest', {
            messages: request.messages
        }).catch(() => null);

        if (res?.messages) {
            request.messages.length = 0;
            request.messages.push(...res.messages);
        }
    }

    async onLLMResponse(response) {
        const res = await this._call('onLLMResponse', {
            text: response.text
        }).catch(() => null);

        if (typeof res?.text === 'string') response.text = res.text;
    }

    async onTTSText(text) {
        const res = await this._call('onTTSText', { text }).catch(() => null);
        return typeof res?.result === 'string' ? res.result : text;
    }

    async onTTSStart(text) {
        await this._call('onTTSStart', { text }).catch(() => {});
    }

    async onTTSEnd() {
        await this._call('onTTSEnd', {}).catch(() => {});
    }

    // ===== 工具 =====

    getTools() {
        return this._tools;
    }

    async executeTool(name, params) {
        const res = await this._call('executeTool', { name, params }).catch(() => null);
        if (res && res.result !== undefined && res.result !== null) return res.result;
        // 失败必须成形（A3，2026-11-22 审计）：原来返回纯文本「工具执行失败」，
        // tool-result.isFailure 按形状判成败 → 桥接超时/进程退出被记成成功。
        return JSON.stringify({
            ok: false,
            detail: String((res && res.error) || '工具执行失败（Python 插件无返回结果）'),
        });
    }
}

module.exports = { PythonPluginBridge };
