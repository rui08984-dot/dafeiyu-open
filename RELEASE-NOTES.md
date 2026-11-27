# RELEASE NOTES — 大肥鱼公开代码树

生成方式：`node scripts/export-public-tree.mjs`（源：主仓 + 应用仓的 tracked 文件）。
状态：**纯本地树**，未配置 remote、未 push。

## v0.5.0 组件化安装 · 完整能力（2026-11-27）

- 底座：`DaFeiyu-Setup-0.5.0.exe`（124,078,808B，约 120MB）——应用 + 皮套/模型 + Cubism Core + pet-core + edge-tts + 完整表演数据 + 我们现在的人格；不含记忆/日记/用户数据。
- 组件从 5 个扩到 **8 个**，合计 **5,539.3MB（约 5.5GB）**，设置 → 组件按需安装（可只装一部分），装完重启大肥鱼。
- 新增：`voiceprint` 263.5MB（声纹嵌入，resemblyzer + CPU torch，256 维，8020；GitHub 组件包 + gh-proxy 备用）；`local-memory` 2,381.6MB（MemOperator-4B Q4_K_M，复用 memory 组件的 CPU llama.cpp，28K ctx，11435；hf-mirror 主源 / HF 备用）；`ollama` 1,637.8MB（便携 Ollama v0.40.18 官方 portable zip 原样，11434；GitHub 组件包 / 官方源字节相同）。
- Ollama 三个模型（qwen3-vl:8b-instruct / glm-ocr / paddleocr-vl）约 **9.3GB**，不在包内，由 setup 装组件时按需拉取或复用已有 11434。`paddleocr-vl` **不在 Ollama 官方 registry**（本机为本地 `ollama create`），组件里降为可选档，失败只告警。
- 修复：`memory` 组件不再写 `cost.local_memory=false`（避免按安装顺序把 `local-memory` 的开关翻回去）；`安装组件.cmd` 改纯 ASCII + CRLF（修 v0.4.0 的 `RUN_AS_NODE` 启动失败）。
- 已知限制：`local-memory` 为 CPU-only（decode 约 12 t/s 量级）；`voiceprint` 为 CPU torch；组件装完需重启；卸载组件不撤销 setup 写入的 provider/MemOS 指向；安装包未签名（SmartScreen 提示未知发布者）。
- 校验：安装包 sha256 `ea19fd4f…b2310e32ac`；`voiceprint-0.5.0.zip` sha256 `1d68df60…deef78c7`；`ollama-0.5.0.zip` sha256 `ca97292a…b7cc4c16`；GGUF sha256 `255580fb…e9d44a6f`（详见 release notes）。

## v0.4.0 组件化安装（2026-11-27）

- 底座：`DaFeiyu-Setup-0.4.0.exe`（约 120MB）——应用 + 皮套/模型 + Cubism Core + pet-core + edge-tts + 表演数据 + 我们现在的人格。
- 组件（设置 → 组件，一键安装，约 1.3GB）：`memory`（MemOS+Qdrant+嵌入 784MB/ModelScope）、`voice-asr`（SenseVoice 239MB/hf-mirror）、`cowatch`、`lumen`（153MB/hf-mirror）。
- 组件包由 `_packaging/build-component-packs.ps1` 构建；清单 `components/manifest.json` 带 SHA256 与多源。
- 不含：本地 4B 记忆模型（自备 GGUF）、Ollama 本地视觉（走云）。

## v0.3.1 一键安装包（2026-11-26）

- 产物：`DaFeiyu-Setup-0.3.1.exe`（约 117MB，NSIS；装到 `%LOCALAPPDATA%\Programs\大肥鱼`，免管理员）。
- 随包：Electron 28 + live-2d 应用、皮套与模型（16.5MB moc3 + 纹理）、Cubism Core、`pet-core.exe`（Rust 快轨）、edge-tts 单文件 exe（语音，联网）。
- 首启：自动打开控制中心「模型」页；默认 provider=cloud（OpenAI 兼容）/ `gpt-4o-mini` / 空 key，填 key 保存即生效。
- 不含：本地 4B 记忆模型、ASR / MemOS / 一起看 / OCR 等 Python 服务（按 README「从源码运行」部署完整树）。
- 构建：`_packaging/build-installer.ps1 -Nsis`；语音 exe：`_packaging/build-tts.ps1`（PyInstaller，约 11MB）。
- 真机验收（2026-11-26）：干净目录静默安装 → 首启自动落「模型」页 → 注入真实 key → `POST 8103/chat` 得到回复；渲染层 ok、随包 TTS 合成 200、pet-core 截图走 Rust 快轨。

## 包含

- 主仓白名单：`pet-runtime/ pet-core/ scripts/ _probe/ docs/(curated) asr/ audio_common/ audio-loop/ edge-tts/ live-danmaku/ extensions/ _packaging/ .github/` + 根入口/说明/架构/compose。
- 应用仓：`_incoming/my-neuro/` 下全部 tracked 代码（无 `.git`、无真实配置）。
- Live2D Cubism Core/Framework（文件头注明 Redistributable Code，附 Framework LICENSE）。
- MemOS 记忆后端子树（Apache-2.0，附 `LICENSE` + `NOTICE` + 修改说明）。
- 角色模型 DeepSeek-chan（大肥鱼）：经作者授权随仓（原画/建模署名与使用边界见 `NOTICE`）。
- LumenAct FACS 片段（CC BY 4.0，带 NOTICE）、角花 SVG（CC0，带 CREDITS）。

## 排除

- 凭据/PII：`config.json`、`llm_providers.json`、`memos_config.json`、`.env*`、`.control-token`、`.qq-token.txt`、`data/`（原记录室目录）、`备份/`、`语音样本/`、`character_backups*.json`、`panel-bounds.json`、`song-library/`、`live-2d/fake_neuro_audio/`。
- 许可不明：Cubism 2 时代的 `live2d.min.js`（无许可头）。
- 上游召回模块（许可边界，已移除）。
- 运行/构建产物：`node_modules/`、`venv-voice/`、`.state/`、`crash-dumps/`、`*.log*`、`_probe/out|recovery|shots*|_archive*`、`tmp-verify/`、`dashboard.html`、`pet-core/target/`、`pet-runtime/mc-mod/**/build/`。
- 大模型权重：`*.gguf *.onnx *.pt *.pth`。
- 文档收窄：只保留 `docs/adr|specs|plans` 与文件名含 `设计-|决策-|调研-|规范-|README` 的；排除 `progress.md`、交接/HANDOFF/提示词/复盘/审计/archive。

## 仍需自备

- LLM API key（`config.json` + `llm_providers.json` 或环境变量）。
- 8090 嵌入服务（MemOS 依赖；缺失时记忆嵌入降级，聊天/TTS/字幕照常）。
- SenseVoice/Silero/Ollama 模型（语音识别/本地视觉）。

## 如何验证

```bat
node scripts\install-wizard.mjs --dry-run --json
node scripts\bootstrap.mjs --json
cd _incoming\my-neuro\live-2d && npm install
cd ..\..\.. && node _probe\check-ci.mjs
```

期望：向导的「最低可用性」在填 key 后为可用；bootstrap 只有「用户自备」项（key / 8090 / 模型服务）非 ok；无代码级红。

## 验证结果

（待执行后回填）
