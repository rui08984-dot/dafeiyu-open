# 大肥鱼 · 桌面 AI 伴侣（公开代码树）

> 这是一份**可公开、可部署的完整代码树**，不是免配置一键包。
> 模型、Live2D Cubism SDK、MemOS 记忆后端与 API key 需要你自备（见下文）。

包含：Electron 宿主应用层（`_incoming/my-neuro/`）、桌宠运行时与表演引擎（`pet-runtime/`）、
Rust 内核（`pet-core/`）、语音/ASR/TTS/一起看服务、插件、门禁测试与安装自检。

## 前置条件

| 依赖 | 版本 | 用途 |
|---|---|---|
| Windows 10/11 x64 | — | Electron 宿主、UIA、WASAPI |
| Node.js | ≥ 20（推荐 24） | 宿主与 npm 依赖 |
| Python | 3.11+（推荐 3.13） | TTS / ASR / 一起看 / 可选记忆后端 |
| Git | 任意较新版本 | 获取代码 |
| Docker Desktop | 可选 | 8090 嵌入服务 / MemOS |

## 五步启动

### 0.（推荐）一键引导

```bat
安装.cmd
```

向导会依次：预检环境 → 选 provider → 从环境变量读 key → 原子写配置（先备份）→ 连通性测试
→ 检查自备资产 → 提示启动。想先看它做什么而不写任何文件：

```bat
node scripts\install-wizard.mjs --dry-run --json
```

### 1. 装依赖

```bat
cd _incoming\my-neuro\live-2d
npm install
cd ..\..\..
```

（可选）皮套构建工具：

```bat
cd pet-runtime
npm install
cd ..
```

### 2. 填 LLM key 与人设

```bat
copy _incoming\my-neuro\live-2d\config.example.json _incoming\my-neuro\live-2d\config.json
copy _incoming\my-neuro\live-2d\llm_providers.example.json _incoming\my-neuro\live-2d\llm_providers.json
```

- `llm_providers.json`：填每个 provider 的 `api_key`（任何 OpenAI 兼容服务均可，把 `api_url`/`model_id` 改成你的）。
- `config.json`：填 `llm.system_prompt`（她的人设）与 `llm.provider_id` / `llm.model_id`。
- 也可以用环境变量；**不要把真实 key 提交到 git**。
- 已用步骤 0 的向导时，本步会自动完成（向导只从环境变量读 key，不接收命令行明文）。

### 3. 体检

```bat
node scripts\bootstrap.mjs
```

只检查、不安装。会逐项告诉你缺什么：key、Python 依赖、模型、皮套资产、MemOS、8090 嵌入等。

### 4. 启动

```bat
大肥鱼 start
```

等价命令：`node pet-runtime/tools/launch-my-neuro.mjs`。
停止：`大肥鱼 stop`；体检：`大肥鱼 doctor`；状态：`大肥鱼 status`。

### 5. 改人格

- `config.json` 的 `llm.system_prompt` 是她的「人设 / 说话方式 / 脾气」。
- 插件与能力：`_incoming/my-neuro/live-2d/plugins/`；默认启停清单见 `plugins/enabled_plugins.json`。
- 记忆与日记：运行后写入 `_incoming/my-neuro/data/`（已 gitignore）。

## 自备资产（不随仓库分发）

| 资产 | 影响 | 怎么获取 |
|---|---|---|
| Live2D 模型（`.moc3` + 纹理 + `.model3.json`） | 皮套渲染不可用 | 用自己拥有权利的模型，放到 `_incoming/my-neuro/live-2d/assets/petbody/` |
| Live2D Cubism SDK for Web / Core | 皮套无法构建/渲染 | 从 Live2D 官网获取，按许可放到 `live-2d/libs/` 或 `pet-runtime/desktop/vendor/` |
| MemOS 记忆后端 | 无长期记忆（聊天/TTS/字幕照常） | 自行取得 MemOS，放到 `_incoming/my-neuro/plugins-dlc/memos/memos_system/` |
| 8090 嵌入服务 | MemOS 依赖；无则记忆嵌入降级 | `pwsh -File scripts/start-embed.ps1` 或 Docker（见 `docker-compose.embed.yml`） |
| SenseVoice / Silero / Ollama 模型 | 语音识别 / 本地视觉降级 | `node asr/check-models.mjs`、`node scripts/fetch-models.mjs` |

缺资产时 bootstrap 会给出 `warn` 和指引；聊天、TTS、字幕、基础人格仍可用。

## 目录结构

```
大肥鱼.cmd                  # Windows 单入口（start/stop/restart/status/doctor/logs）
pet-runtime/                # 启动器、服务编排、桌宠渲染、表演引擎、工具
pet-core/                   # Rust 内核（可选：cargo build --release）
_incoming/my-neuro/         # Electron 应用层（live-2d/）
scripts/                    # bootstrap / 配置模板 / 模型获取 / 导出脚本
_probe/                     # 门禁与回归测试（check-all / check-ci）
docs/                       # ADR、设计、调研（curated）
asr/ audio_common/ audio-loop/ edge-tts/ live-danmaku/ extensions/
_packaging/                 # 安装器 / MSIX 包身份参考
```

## 验证

```bat
node --check pet-runtime\tools\launch-my-neuro.mjs
node _probe\check-ci.mjs          # 语法 + 不依赖宿主运行时的单测
node scripts\bootstrap.mjs --json # 机器可读体检
```

## 相关仓库（可选拆分，便于单独复用）

- **本仓库**：完整合并树（宿主 + 运行时 + 全部插件）——想直接跑就用这个。
- 电脑操控层：<https://github.com/rui08984-dot/dafeiyu-control>（Rust 内核 + 派活 v2 + 能力注册表）
- Live2D 表演引擎：<https://github.com/rui08984-dot/dafeiyu-perform>
- 语音四态层：<https://github.com/rui08984-dot/dafeiyu-voice>（voice-intent / interrupt-event / heard-text）
- 记忆 OS：私有仓（上游 MemOS 子树授权链未闭合），本仓库只含记忆**客户端**代码。

## 许可与安全

- 自有代码：MIT（`LICENSE`）。第三方边界见 `NOTICE`。
- 密钥/上报：`SECURITY.md`。
- 本仓库**不含**真实 key、模型、Cubism SDK、MemOS 子树或 git 历史。
