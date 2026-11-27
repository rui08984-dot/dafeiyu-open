# RELEASE NOTES — 大肥鱼公开代码树

生成方式：`node scripts/export-public-tree.mjs`（源：主仓 + 应用仓的 tracked 文件）。
状态：**纯本地树**，未配置 remote、未 push。

## v0.4.0 组件化安装（2026-11-27）

- 底座：`DaFeiyu-Setup-0.4.0.exe`（约 120MB）——应用 + 皮套/模型 + Cubism Core + pet-core + edge-tts + 表演数据 + 我们现在的人格。
- 组件（设置 → 组件，一键安装，约 1.8GB）：`memory`（MemOS+Qdrant+嵌入 784MB/ModelScope）、`voice-asr`（SenseVoice 239MB/hf-mirror）、`cowatch`、`lumen`（153MB/hf-mirror）。
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
