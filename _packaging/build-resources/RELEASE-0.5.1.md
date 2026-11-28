# v0.5.1 · 安装卫生与公开树可重建（Windows）

**这是 v0.5.0 的修复版**：底座与 8 个组件的能力不变（组件包沿用 v0.4.0 / v0.5.0 资产，
安装后下载的模型 SHA256 与 v0.5.0 完全一致），只修安装包卫生、安装版功能接线与公开树复现。

## 安装

1. 下载 `DaFeiyu-Setup-0.5.1.exe`（**123,964,365B / 约 118.2MB**，sha256 `66e89db1…17f43b41`），双击安装（默认 `%LOCALAPPDATA%\Programs\大肥鱼`，免管理员）。
2. 启动「大肥鱼」，第一次会自动打开「模型」页：填任何 OpenAI 兼容的 **API Key**，保存即用。
3. 完整能力：设置窗 → **组件** → 选装 / 「全部安装」（8 组件合计 5,539.3MB；可断点续传，SHA256 校验）。
4. 组件装完**重启大肥鱼**。

## 本版修了什么（对应 v0.5.0 终验 P0）

| # | 问题 | 修法 |
|---|---|---|
| 1 | 随包 `安装说明.txt` 还是 v0.4.0 口径（1.8GB / 4 组件 / 本地 4B 需自备） | 重写为 v0.5.1：8 组件 5.5GB、local-memory 组件、浏览器扩展加载、CPU 限制 |
| 2 | 2MB dev 轮转日志 `performance-log.jsonl.1` 误随包 | 安装器排除 `performance-log.jsonl*`；afterPack **整树断言**任何 `*.log.N`/`*.jsonl.N` 即构建失败 |
| 3 | 公开树无法 1:1 重建 | 人格内核 / LumenAct `semantic-config.json` 放入 `_packaging/build-resources/`；组件构建缺权重时按清单源下载并校验 sha256（`-CheckModelsOnly` 可单验）；清单缺 fragments 改为非零退出（`--allow-empty` 才放行）；local-memory 默认路径改 cache 优先；全新 clone 无 `config.json` 时用占位人格并告警（发布构建仍强制 ≥200 字符现人格） |
| 4 | G1 安装版「记忆体检」找不到脚本 | `memos-consistency.mjs` 随包（`resources/app/pet-runtime/tools/`），控制入口按 `app.getAppPath()` 解析 |
| 5 | G2 能力页对 TTS/ASR/一起看/声纹误报缺失 | `capabilities.js` 增加安装版候选：`resources/tts/dafeiyu-tts.exe`、`components/<id>/<impl>`；dev 路径行为不变 |
| 6 | G3 浏览器标签扩展只在源码树 | `extensions/browser-tabs` 随包到安装目录 `浏览器扩展/browser-tabs`（扩展管理里手动「加载已解压的扩展程序」） |
| 7 | G4 `pet-runtime/tools/services.json` 是 dev 相对路径 | 安装版不再随 dev 维护入口（services.json / doctor / kill-all / restart / launch）；`cost.weekly_budget` 标记 devOnly，安装版能力页跳过实现自检 |
| 8 | 控制中心不读 `PET_USER_DATA` | `control-main.js` 启动即读，早于 `control-center` 子目录（测试隔离实测生效） |
| 9 | README / RELEASE-NOTES 文案矛盾 | 公开树 README 补齐 python 组件、`已随仓` 与 `不含` 口径统一、安装包构建说明；RELEASE-NOTES 状态行与 v0.4 体积口径标注 |

另修一条跨天变红的门禁：`test-daily-report.cjs` 的 `runDaily`/`dayKey` 现在钉住夹具时间 `NOW`（原实现用真实时间，跨天后必红）。

## 验收（2026-11-28）

- 门禁：smoke **201/201**（43.8s）、core **234/234**（170.1s）。
- 干净安装到空目录 → 首启自动落「模型」页（`visible=[model]`）→ 注入真实 key → 真实 LLM 回复 `BANANA`。
- 组件页 8 项齐全（python / voice-asr / cowatch / memory / lumen / voiceprint / local-memory / ollama），`安装组件.cmd status` 同样 8 行。
- 安装目录核验：`resources/app` 下 **0 个 `*.jsonl*`**、默认配置 **0 key**、`pet-runtime/data` 只有表演/游戏数据；`memos-consistency.mjs` 与 `浏览器扩展/browser-tabs` 在位；`services.json` / `doctor.mjs` 不在。
- G1：控制面板 IPC `memoryConsistency()` 返回 `{ok:true, report:{...}}`（8003 未装时按实报 ECONNREFUSED，不假绿）。
- G2：组件不在位时只报 asr/cowatch/voiceprint 三项（正确）；模拟组件目录后能力审计 **0 问题**。
- 组件资产未重建：`components/manifest.json` 版本 0.5.1，8 个组件的文件哈希与 v0.5.0 清单逐位一致。

## 已知限制（与 v0.5.0 相同）

- 安装包未代码签名，SmartScreen 会提示「未知发布者」。
- `local-memory` / `ollama` 为 CPU 推理；`ollama` 三个模型约 9.3GB 装时按需拉取。
- 卸载不撤销组件 setup 写入的 provider/MemOS 指向（P1，未在本版处理）。
- 安装版不提供 dev 维护脚本（doctor / kill-all / restart / launch-my-neuro）与舞台调试页。
