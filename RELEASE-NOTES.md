# RELEASE NOTES — 大肥鱼公开代码树

生成方式：`node scripts/export-public-tree.mjs`（源：主仓 + 应用仓的 tracked 文件）。
状态：**纯本地树**，未配置 remote、未 push。

## 包含

- 主仓白名单：`pet-runtime/ pet-core/ scripts/ _probe/ docs/(curated) asr/ audio_common/ audio-loop/ edge-tts/ live-danmaku/ extensions/ _packaging/ .github/` + 根入口/说明/架构/compose。
- 应用仓：`_incoming/my-neuro/` 下全部 tracked 代码（无 `.git`、无真实配置）。
- 首启向导：`scripts/install-wizard.mjs`（`--dry-run --json` 先看不写；默认不下载模型）。
- LumenAct FACS 片段（CC BY 4.0，带 NOTICE）、角花 SVG（CC0，带 CREDITS）。

## 排除

- 凭据/PII：`config.json`、`llm_providers.json`、`memos_config.json`、`.env*`、`.control-token`、`.qq-token.txt`、`data/`（原记录室目录）、`备份/`、`语音样本/`、`character_backups*.json`、`panel-bounds.json`、`song-library/`、`live-2d/fake_neuro_audio/`。
- 受限资产：所有 `*.moc3` 与纹理、公皮目录、`live-2d/vendor/cubism/`、`live-2d/libs/`、`pet-runtime/desktop/vendor*/`、Cubism SDK、MemOS 子树 `plugins-dlc/memos/`、上游召回模块（已移除）。
- 运行/构建产物：`node_modules/`、`venv-voice/`、`.state/`、`crash-dumps/`、`*.log*`、`_probe/out|recovery|shots*|_archive*`、`tmp-verify/`、`dashboard.html`、`pet-core/target/`、`pet-runtime/mc-mod/**/build/`。
- 大模型权重：`*.gguf *.onnx *.pt *.pth`。
- 文档收窄：只保留 `docs/adr|specs|plans` 与文件名含 `设计-|决策-|调研-|规范-|README` 的；排除 `progress.md`、交接/HANDOFF/提示词/复盘/审计/archive。

## 仍需自备

- LLM API key（`config.json` + `llm_providers.json` 或环境变量）。
- Live2D 模型（`.moc3`/纹理）与 Cubism SDK for Web/Core（皮套渲染）。
- MemOS 与 8090 嵌入服务（长期记忆；缺失时聊天/TTS/字幕照常）。
- SenseVoice/Silero/Ollama 模型（语音识别/本地视觉）。

## 如何验证

```bat
node scripts\install-wizard.mjs --dry-run --json
node scripts\bootstrap.mjs --json
cd _incoming\my-neuro\live-2d && npm install
cd ..\..\.. && node _probe\check-ci.mjs
```

期望：向导的「最低可用性」一行在填 key 后为可用；bootstrap 只有「用户自备」项非 ok；
无代码级红。

## 验证结果（2026-11-23 实测，E 副本）

### 导出规模

- 版本库文件：**1121** 个 / **19.57 MiB**（主仓白名单 + 应用仓 + 新交付件：向导/导出脚本/一键入口）。
- 本地 `npm install` 后 `node_modules` 未入版本库（`.gitignore` 已忽略）。
- `pet-core/target`（cargo 验证产物）未入版本库。

### 卫生扫描（排除 `node_modules`/`target`，1117 个文件）

| 项 | 结果 |
|---|---:|
| 真实 key 形态（sk-zk / sk-yg / sk- 长串 / AKIA / ghp_ / xox） | **0** |
| `*.moc3` | **0** |
| Cubism Core / `vendor/cubism` / `desktop/vendor*` | **0** |
| 原记录室目录名（字符串与目录） | **0**（统一改名 `data/`） |
| 旧用户名 / Windows 用户目录前缀 | **0 / 0** |
| 源项目绝对路径（正斜杠与反斜杠两种） | **0 / 0** |
| 上游参考项目名 / 其召回模块文件名（代码） | **0**；对应源文件不存在 |

> 说明：6 份 curated 研究/设计文档以「上游项目名」引用了该参考项目（非代码，仅调研对照）；
> `NOTICE` 已明确「不包含其任何代码」。如需绝对零提及，可删这 6 份文档或再做一次词替换。

### 语法

- `node --check`：**634 / 634 通过，0 失败**（E 内全部 .js/.cjs/.mjs，含导出脚本与向导）。

### 回归测试（E 内实跑，不依赖宿主）

- 累计 **310 通过 / 0 失败 / 12 跳过**：
  dispatch-followup 47 · install-manifest 47 · voice-intent 58 · wiring 46 ·
  interrupt-event 21 · heard-text 51 · latency-budget 19 · upload-hygiene 21。
- 12 项 SKIP 均为「公开树不含 MemOS 子树 / 本地运行文件」的合理跳过；
  测试通过根目录 `.public-tree` 标记区分公开树与开发树（不削弱 D 盘完整树的检查）。

### bootstrap（24 项）

- E 树：`ok=false`（仅因缺用户 key）/ 15 ok / **2 missing = `config.json`、`llm_providers.json`**（用户自备）/ 2 warn = `assets.selfsupply`、`petbody`（自备 moc3/Cubism）/ 5 skip = MemOS 配置 2、`venv-voice`、`pet-core`、LumenAct。
- `requiredMissing` 只有 `config`、`providers`；**无代码级红**。
- 项数从 23 → 24：按方案 §4.5 新增 `assets.selfsupply`。

### 路径无关

- 整树复制到 `%TEMP%\dfy-portable-<rand>` 后重跑 `bootstrap --json`：
  24 项状态与 E **逐项一致**（`requiredMissing` 同为 `config`、`providers`）。

### 构建

- `cd _incoming/my-neuro/live-2d && npm install --omit=dev --no-audit --no-fund`：成功（277 包，electron 运行时与 prebuild 就位）。
- `cd pet-core && cargo check`：**通过**（14.6s）。

### 已知偏差

1. bootstrap 现在是 24 项（新增 `assets.selfsupply`），不是旧文档的 23 项。
2. `plugin_config.json` 实际 26 份（任务文本写 30 份），全部做了 value→default 归零；dispatch 的 PCL 路径已清空。
3. 应用仓 `README.md` 原文指向私有仓 clone 地址，已替换为合并树说明（安装步骤统一看根 README）。
4. jingyu 15 段表演数据许可仍未核实，`NOTICE` 已标注「保留署名 + 可移除」。
5. npm 11 的 allow-scripts 会提示 electron/uiohook 的 postinstall；本次安装后产物已在位，若新机器被拦，执行 `npm approve-scripts --allow-scripts-pending` 或允许对应脚本。

## 发布仓库（2026-11-23）

| 仓库 | 可见性 | 内容 |
|---|---|---|
| [dafeiyu-open](https://github.com/rui08984-dot/dafeiyu-open) | public | 本仓：完整合并树（宿主 + 运行时 + 全部插件 + 安装向导） |
| [dafeiyu-control](https://github.com/rui08984-dot/dafeiyu-control) | public | 操控层 + 派活 v2 + capabilities（`d978d90`） |
| [dafeiyu-perform](https://github.com/rui08984-dot/dafeiyu-perform) | public | Live2D 表演引擎（`bac7fca`） |
| [dafeiyu-voice](https://github.com/rui08984-dot/dafeiyu-voice) | public | 语音四态层（`9418a60`） |
| `dafeiyu` / `dafeiyu-app` / `dafeiyu-memory` | private | 完整历史 / 应用仓 / 记忆 OS（MemOS 授权链未闭合） |

推送说明：本机 git over HTTPS 被 reset、SSH 账号未授权 key，采用**每仓独立 deploy key**
（`gh api repos/<owner>/<repo>/keys` 添加；同一把 key 不能跨仓复用）。克隆端不受影响，正常 `git clone` 即可。

