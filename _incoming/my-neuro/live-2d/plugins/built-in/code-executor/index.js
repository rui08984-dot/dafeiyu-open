const __silentAudit = require('../../../js/core/silent-audit.js');
const { Plugin } = require('../../../js/core/plugin-base.js');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
// ADR-014 轨道 1（2026-11-24）：stdout/stderr 超限时全文落 artifact，回执给预览 + 路径。
// 她可以再用 `file read`（支持 offset/limit）分段读全文，不靠「已截断」三个字。
const toolArtifact = require('../../../js/ai/tool-result-artifact.js');

// 与 js/ai/tool-result-cap.js 的单条上限对齐：不超过 12k 就不会被二次截断。
const MAX_OUTPUT_CHARS = 12000;
const PREVIEW_HEAD = Math.floor(MAX_OUTPUT_CHARS * 0.7);
const PREVIEW_TAIL = MAX_OUTPUT_CHARS - PREVIEW_HEAD;

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
                description: '执行 AI 生成的 Python 代码或装包：run 跑代码（数据处理/文件/网络/计算等），install 用配置的解释器装 Python 包——install 会改环境，只在用户明确要求时装。输出超过 12000 字符会落盘到 tool-artifacts 并返回「预览 + 完整路径」，需要细节用 file read 按 offset 分段读。',
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

    /**
     * 输出超限处理（ADR-014）：全文落 artifact，回执只留头 70% + 尾 30%。
     * 返回值本身仍是一段字符串（工具返回形状不变），路径写在截断标记里。
     */
    _capOutput(text) {
        const s = String(text == null ? '' : text);
        if (s.length <= MAX_OUTPUT_CHARS) return { text: s, artifactPath: null };
        const art = toolArtifact.writeArtifact('code', s, { turnId: '' });
        const target = art ? art.path : 'runtime.log';
        const rough = '[输出过长，已截断 ' + s.length + ' 字符；完整输出已落盘：' + target
            + '，可用 file read + offset 分段读]';
        // 预留标记 + '\n…' + '…\n' 共 4 个字符（多留 2 个余量，避免末尾被二次 slice 掉）
        const room = Math.max(0, MAX_OUTPUT_CHARS - rough.length - 6);
        const head = s.slice(0, Math.floor(room * 0.7));
        const tail = s.slice(-(room - Math.floor(room * 0.7)));
        const out = head + '\n…' + rough + '…\n' + tail;
        // 再兜一次：标记长度估算可能因多字节字符偏小，绝不超过单条上限（避免被二次截断）
        return { text: out.length > MAX_OUTPUT_CHARS ? out.slice(0, MAX_OUTPUT_CHARS) : out, artifactPath: art ? art.path : null };
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

            exec(command, { timeout: 60000, shell: isWindows ? 'cmd.exe' : '/bin/bash', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CONDA_DLL_SEARCH_MODIFICATION_ENABLE: '1' } }, (error, stdout, stderr) => {
                try { fs.unlinkSync(tempScriptPath); } catch (e) { try { __silentAudit.audit('index.js:74', e); } catch (e2) {} }
                if (error) return reject(new Error(`代码执行失败: ${error.message}`));
                try {
                    const result = JSON.parse(stdout);
                    if (result.success) {
                        let output = `✅ ${result.description}\n`;
                        if (result.stdout) output += `\n📄 输出内容:\n${result.stdout}`;
                        if (result.stderr) output += `\n⚠️ 警告信息:\n${result.stderr}`;
                        resolve(this._capOutput(output).text);
                    } else {
                        resolve(this._capOutput(`❌ 代码执行出错: ${result.error}\n\n🔍 错误详情:\n${result.traceback}`).text);
                    }
                } catch { resolve(this._capOutput(`✅ 代码执行完成\n\n📄 原始输出:\n${stdout}`).text); }
            });
        });
    }

    async _installPackages({ packages }) {
        if (!packages?.trim()) throw new Error('包名不能为空');

        return new Promise((resolve, reject) => {
            const isWindows = process.platform === 'win32';
            const py = String(this._python || 'py').trim();
            const command = py + ' -m pip install ' + packages;

            exec(command, { timeout: 300000, shell: isWindows ? 'cmd.exe' : '/bin/bash', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CONDA_DLL_SEARCH_MODIFICATION_ENABLE: '1' } }, (error, stdout, stderr) => {
                if (error) return reject(new Error(`安装包失败: ${error.message}`));
                resolve(this._capOutput(`✅ 成功安装包: ${packages}\n\n📄 安装日志:\n${stdout}${stderr}`).text);
            });
        });
    }
}

module.exports = CodeExecutorPlugin;
