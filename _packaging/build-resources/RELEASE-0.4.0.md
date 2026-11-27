# v0.4.0 · 组件化安装（Windows）

底座安装包 + 按需组件：**底座 118MB 开箱可聊，完整能力（长期记忆 / 按住说话 / 一起看 / 语义表演）在「设置 → 组件」里一键安装（约 1.3GB）**。

## 安装

1. 下载 `DaFeiyu-Setup-0.4.0.exe`（118.3MB），双击安装（装到 `%LOCALAPPDATA%\Programs\大肥鱼`，免管理员）。
2. 启动「大肥鱼」，第一次会自动打开「模型」页：填任何 OpenAI 兼容的 **API Key**，保存即用。
3. 想要完整能力：设置窗 → **组件** → 「全部安装」（可断点续传，SHA256 校验，装完重启大肥鱼）。

## 底座已含

- Electron 28 + 应用层（live-2d）、皮套与模型、Cubism Core
- Rust 内核 `pet-core`（看屏 / 窗口操控快轨）
- edge-tts 语音（联网，无需 key）
- 完整表演数据：97 段 FACS 片段、112 个 sync 点、节目单
- **我们现在使用的人格**（system_prompt + 人格内核 persona-layers）；不含任何记忆/日记/用户数据

## 组件（自动下载，模型走国内镜像）

| 组件 | 体积 | 内容 | 模型来源 |
|---|---:|---|---|
| `python` | 69.7MB | 独立 CPython 3.13 + numpy/scipy/pypinyin | 随组件包 |
| `voice-asr` | 264MB | SenseVoice + Silero VAD（按住 V 说话） | hf-mirror |
| `cowatch` | 12.5MB | 一起看：系统声音回环 | 随组件包 |
| `memory` | 707MB | MemOS + 本地 Qdrant + 嵌入服务（llama.cpp CPU） | ModelScope / hf-mirror |
| `lumen` | 203MB | LumenAct 语义表演（8120） | hf-mirror（固定 revision） |

组件管理器：下载（Range 续传）→ SHA256 校验 → 多源回退 → 解压到 `<安装目录>\components\` → 写 `config.json` / `services.json`。宿主随启停托管服务（嵌入→MemOS→ASR→一起看→LumenAct），装完**重启大肥鱼**生效。

## 不包含

- 你的记忆/日记/对话历史（个人数据，不随包）
- 本地 4B 记忆模型（MemOperator-4B，可自备 GGUF）
- Ollama 本地视觉/OCR（看屏走云端视觉）

## 已知限制

- 安装包未代码签名，SmartScreen 可能提示「未知发布者」→「仍要运行」。
- 组件需要联网下载；模型源为 ModelScope / hf-mirror，GitHub 组件包附带 gh-proxy 备用源。
- 安装版默认「静默模式：开」（只回应、不主动搭话），填好 key 后可在托盘关掉。

## 校验

```
DaFeiyu-Setup-0.4.0.exe  124,001,107 B  sha256 1a6b5b91acf5172df396e6fe26c2767569603116836a841d65ed38d2c171e561

python-0.4.0.zip          69.7 MiB  sha256 1db5a8a79112a45ddb7791372626f42e2839896d2c0c5d89f46a96ea280d52d7
voice-asr-0.4.0.zip       35.4 MiB  sha256 6eee5efb18e3e63a91ff98dc781ce9106955d1778c4e2192731912f817aa1011
cowatch-0.4.0.zip         12.5 MiB  sha256 45529c56958203845ffcca763b8be6cd384dc56ff951e9cec372e4ad49b08009
memory-0.4.0.zip          97.9 MiB  sha256 78c0b586d49b5b921ff191bd8a5f26fec11676426a3bc4319afcdc0f2082f650
lumen-0.4.0.zip           56.4 MiB  sha256 3dcdf270d2fdba9b9196029aafd1b58adbefe62585a4b4acd86568a8f3550e09

SenseVoice model.int8.onnx 228.2 MiB  sha256 c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51
Qwen3-Embedding Q8_0.gguf  609.5 MiB  sha256 06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439
LumenAct selector.onnx     146.2 MiB  sha256 b4d53610dc6b95e9f994a371dcc2cd8c24777e28ae56c3720d9d6eebeb1688f2
```

## 构建

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File _packaging\build-component-packs.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File _packaging\build-tts.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File _packaging\build-installer.ps1 -Nsis
```

真机验收（2026-11-27）：干净目录静默安装 → 首启「模型」页 → 真实 key → `POST 8103/chat` 回复（人格为当前人设）；组件本地/远端安装 → 嵌入 1024 维、ASR ready、LumenAct 害羞/awkward 12.3ms；卸载组件还原配置。
