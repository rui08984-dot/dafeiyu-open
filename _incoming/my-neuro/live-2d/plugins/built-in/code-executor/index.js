const __silentAudit = require('../../../js/core/silent-audit.js');
const { Plugin } = require('../../../js/core/plugin-base.js');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

class CodeExecutorPlugin extends Plugin {

    async onInit() {
        // 解释器可配置：py / python / 绝对路径。
        // 原代码写死 `conda activate my-neuro`，这台机器没有 conda，一调用就报
        // 「'conda' 不是内部或外部命令」——能力等于不存在。默认改成 Windows 的 py 启动器。
        try {
            const cfg = this.context.getPluginFileConfig();
            const raw = cfg && cfg.python_cmd;
            const val = (raw && typeof raw === 'object' && 'value' in raw) ? raw.value : raw;
            this._python = String(val || 'py').trim() || 'py';
        } catch (e) { this._python = 'py'; }
        console.log('[code-executor] Python 解释器 =', this._python);
    }

    // 工具面重塑（2026-11-14）：2 个工具 → 1 个。
    getTools() {
        return [{
            type: 'function',
            function: {
                name: 'code',
                description: '执行 AI 生成的 Python 代码或装包：run 跑代码（数据处理/文件/网络/计算等），install 用配置的解释器装 Python 包——install 会改环境，只在用户明确要求时装。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['run', 'install'], description: '要做什么' },
                        code: { type: 'string', description: '要执行的Python代码' },
                        description: { type: 'string', description: '代码功能描述（可选）' },
                        packages: { type: 'string', description: "要安装的包名，多个包用空格分隔，如: 'requests pandas numpy'" },
                    },
                    required: ['action'],
                },
            },
        }];
    }

    async executeTool(name, params) {
        const p = params || {};
        if (name === 'code') {
            const a = String(p.action || '').toLowerCase();
            switch (a) {
                case 'run': return await this._executeCode(p);
                case 'install': return await this._installPackages(p);
                default: throw new Error('code：action 只能是 run / install（收到「' + a + '」）');
            }
        }
        // 旧工具名保留（技能库/脚本可能直接调）
        switch (name) {
            case 'execute_code': return await this._executeCode(p);
            case 'install_packages': return await this._installPackages(p);
            default: throw new Error(`[code-executor] 不支持的工具: ${name}`);
        }
    }

    async _executeCode({ code, description = '执行AI生成的代码' }) {
        if (!code?.trim()) throw new Error('代码内容不能为空');

        return new Promise((resolve, reject) => {
            const timestamp = Date.now();
            const tempScriptPath = path.join(__dirname, `temp_ai_code_${timestamp}.py`);

            const wrappedCode = `# -*- coding: utf-8 -*-
import sys, json, traceback, io, subprocess, os
from contextlib import redirect_stdout, redirect_stderr

def start_detached(command):
    if os.name == 'nt':
        subprocess.Popen(command, shell=True, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
    else:
        subprocess.Popen(command, shell=True, start_new_session=True)
    print(f"已启动程序: {command}")

def main():
${code.split('\n').map(line => `    ${line}`).join('\n')}

if __name__ == '__main__':
    try:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            main()
        print(json.dumps({"success": True, "stdout": out.getvalue(), "stderr": err.getvalue(), "description": "${description}"}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e), "traceback": traceback.format_exc(), "description": "${description}"}, ensure_ascii=False))
`;
            fs.writeFileSync(tempScriptPath, wrappedCode);

            const isWindows = process.platform === 'win32';
            // ⚠ 原来写死 conda activate my-neuro —— 这台机器没装 conda，
            // 执行器一调就报「'conda' 不是内部或外部命令」，等于没有这个能力。
            // 改成可配置解释器（默认 Windows 的 py 启动器）。
            const py = String(this._python || 'py').trim();
            const command = py + ' "' + tempScriptPath + '"';

            exec(command, { timeout: 60000, shell: isWindows ? 'cmd.exe' : '/bin/bash', env: { ...process.env, CONDA_DLL_SEARCH_MODIFICATION_ENABLE: '1' } }, (error, stdout, stderr) => {
                try { fs.unlinkSync(tempScriptPath); } catch (e) { try { __silentAudit.audit('index.js:74', e); } catch (e2) {} }
                if (error) return reject(new Error(`代码执行失败: ${error.message}`));
                try {
                    const result = JSON.parse(stdout);
                    if (result.success) {
                        let output = `✅ ${result.description}\n`;
                        if (result.stdout) output += `\n📄 输出内容:\n${result.stdout}`;
                        if (result.stderr) output += `\n⚠️ 警告信息:\n${result.stderr}`;
                        resolve(output);
                    } else {
                        resolve(`❌ 代码执行出错: ${result.error}\n\n🔍 错误详情:\n${result.traceback}`);
                    }
                } catch { resolve(`✅ 代码执行完成\n\n📄 原始输出:\n${stdout}`); }
            });
        });
    }

    async _installPackages({ packages }) {
        if (!packages?.trim()) throw new Error('包名不能为空');

        return new Promise((resolve, reject) => {
            const isWindows = process.platform === 'win32';
            const py = String(this._python || 'py').trim();
            const command = py + ' -m pip install ' + packages;

            exec(command, { timeout: 300000, shell: isWindows ? 'cmd.exe' : '/bin/bash', env: { ...process.env, CONDA_DLL_SEARCH_MODIFICATION_ENABLE: '1' } }, (error, stdout, stderr) => {
                if (error) return reject(new Error(`安装包失败: ${error.message}`));
                resolve(`✅ 成功安装包: ${packages}\n\n📄 安装日志:\n${stdout}${stderr}`);
            });
        });
    }
}

module.exports = CodeExecutorPlugin;
