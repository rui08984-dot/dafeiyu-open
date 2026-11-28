# RELEASE NOTES — 大肥鱼公开代码树

生成方式：`node scripts/export-public-tree.mjs`（源：主仓 + 应用仓的 tracked 文件）。
状态：公开仓 `main` 由 `node scripts/publish-public.mjs` 导出、自检并推送；本文件随每次发布更新。

## v0.5.3 安装包卫生修复（2026-11-28）

- 底座：`DaFeiyu-Setup-0.5.3.exe`（**123,165,776B**，约 117.5MB；sha256 `90b8e861cf961e5403045d4284aa52f4d93204eab95d028ff56ff884aa0f6a47`）——应用 + 皮套/模型 + Cubism Core + pet-core + edge-tts + 完整表演数据 + 我们现在的人格；不含记忆/日记/用户数据。
- **v0.5.2 安装包有卫生问题，请勿使用**：误带测试期 Chromium 用户数据目录（含开发机绝对路径）、未脱敏的火山/百度 appid、个人工作区和 PCL 路径。本版全部修掉，并做成构建期硬断言。
- 修复：Tempcc-*/Chromium profile 与 dev 杂物（go.bat、AI_set_live2d.py、WebUI/扫描 bat、fake_neuro_audio）不再随包；appid/workspaces/PCL 路径脱敏；补 `pet-runtime/knowledge/{rules,templates,grid-baseline}`（experience/skills 个人数据不随包）；游戏事件 OCR 安装版改走 Ollama；main.js 写 userData 不再写 D 盘；安装说明版本号改为构建注入。
- 验收：子代理全量安装 v0.5.2 包 8/8 组件成功（5,539MB / 11m33s），6 个服务健康、真实对话 `BANANA`、卸载正常；v0.5.3 包复核 0 Tempcc / 0 dev 杂物 / 0 appid / 0 本机路径 / 知识库在位 / 首启弹窗 8/8；smoke 201/201、core 234/234。
- 已知限制：坐标级 OCR（ocr_find.py）仍需本机 Python + RapidOCR；组件 python 未带 Pillow/RapidOCR，安装版「按文字点坐标」暂不可用（下一版组件处理）。

## v0.5.2 首启引导「全部安装」（2026-11-28）

- ⚠ 已撤回：本版安装包误带测试 Chromium 目录与未脱敏 appid/PCL 路径，请改用 v0.5.3。底座：`DaFeiyu-Setup-0.5.2.exe`（**125,168,708B**，约 119.4MB；sha256 `77ab5e4df10986b38d1792123f6e603de082b11e447deb216aae915f4ca8a438`）——应用 + 皮套/模型 + Cubism Core + pet-core + edge-tts + 完整表演数据 + 我们现在的人格；不含记忆/日记/用户数据。
- **8 个组件资产与 v0.5.0 / v0.5.1 完全一致**（文件 SHA256 逐位相同，合计 5,539.3MB）；本版没有重建组件包。
- 新增首启引导：第一次打开设置时弹窗「把她的完整能力装上？」，**8 个组件全部默认选中（全亮）**，点「全部安装」一次性一起下；显示合计 5,539MB、本地视觉三模型约 9.3GB、磁盘 ≥16GB、8GB 显存提示；只提示一次，可「稍后」，组件页随时可装。
- 修复：`world-extras` JSON 缓存只按 mtime 失效，同一毫秒内 `markDelivered` 重写后会读到旧 `picked`，导致 RSS 第三轮投递偶发 0 注入；改为 mtime+size 双键。
- 门禁：smoke **201/201**、core **234/234**；干净安装实测首启弹窗 8/8 已选、点全部安装跳组件页并开始下载、同 userData 二次启动不再弹。

## v0.5.1 安装卫生与公开树可重建（2026-11-28）

- 底座：`DaFeiyu-Setup-0.5.1.exe`（**123,964,365B**，约 118.2MB；sha256 `66e89db15fb0e9c9419c278628d51486e8d052ff5d9940994b9aede017f43b41`）——应用 + 皮套/模型 + Cubism Core + pet-core + edge-tts + 完整表演数据 + 我们现在的人格；不含记忆/日记/用户数据。
- **8 个组件资产与 v0.5.0 完全一致**（文件 SHA256 逐位相同，合计 5,539.3MB）；本版没有重建组件包。
- 修复（v0.5.0 终验 P0）：随包 `安装说明.txt` 换 v0.5.1 口径；安装包不再混入 dev 轮转日志（`*.jsonl.N` 整树断言）；公开树全新 clone 可重建（人格内核/Lumen 小配置内置、缺权重按清单源下载校 sha256、缺 fragments 非零退出、local-memory cache 优先、无 config 时占位人格并告警）；G1 记忆体检随包并按 `app.getAppPath()` 解析；G2 能力页识别 `components/` 下的语音器官；G3 `浏览器扩展/browser-tabs` 随包；G4 安装版不带 dev 维护脚本/`services.json`；控制中心读 `PET_USER_DATA`；README/RELEASE-NOTES 口径统一。
- 门禁：smoke **201/201**、core **234/234**；干净安装实测首启「模型」页、真实 key 对话 `BANANA`、8 组件页与 CLI status、安装目录 0 `*.jsonl*` / 0 key。

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
- 组件（设置 → 组件，一键安装，约 1.3GB）：`memory`（MemOS+Qdrant+嵌入，模型单文件 784MB/ModelScope）、`voice-asr`（SenseVoice 模型单文件 239MB/hf-mirror）、`cowatch`、`lumen`（selector 模型单文件 153MB/hf-mirror）。注：组件包 zip 合计为 707.4 / 263.8 / 12.5 / 203.0MB（含 Python 依赖），与模型单文件体积是两种口径。
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

## 验证结果（2026-11-28 · v0.5.3）

- 门禁：`node _probe/check-all.mjs --smoke` **201/201**（40.0s）；`--core` **234/234**（139.7s）。
- 全量安装（子代理）：干净安装 → 首启弹窗 8/8 已选 → 真实点「全部安装」→ 8 个组件全部成功（5,539MB，11 分 33 秒）→ 重启后 ASR/一起看/MemOS/声纹/语义/本地记忆 6 个服务健康 → 真实 key 对话返回 `BANANA`（4.7s）→ 卸载/清理正常。
- v0.5.3 包复核：0 个 `Tempcc-*`、0 个 dev 杂物（go.bat/conda 脚本）、appid 已置空、插件配置 0 条本机路径、知识库在位、`main.js` 0 处开发机绝对路径；首启弹窗 8 行全选。
- 对等审计：543 个同名应用文件哈希一致；人格 1393 字同文本、人格内核 605B 同哈希；13 项组件/权重哈希全部一致；隐私扫描 0 真实 key、0 运行日志实文件。

（v0.5.0 及更早的验证结果保留在各版 release notes。）
