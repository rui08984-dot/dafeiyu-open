# v0.5.0 · 组件化安装（Windows）· 声纹 / 本地记忆 / 本地视觉

底座安装包与 v0.4.0 同构（118.3MiB 开箱可聊，含现人格与表演数据），组件从 5 个扩到 **8 个**：
新增 `voiceprint`（声纹）、`local-memory`（llama.cpp + MemOperator-4B 本地记忆模型）、
`ollama`（本地视觉/OCR）。**8 组件合计 5,539.3MB（约 5.5GB）**，全部在「设置 → 组件」里按需装，
可以只装需要的。

## 安装

1. 下载 `DaFeiyu-Setup-0.5.0.exe`，双击安装（默认 `%LOCALAPPDATA%\Programs\大肥鱼`，免管理员）。
2. 启动「大肥鱼」，第一次会自动打开「模型」页：填任何 OpenAI 兼容的 **API Key**，保存即用。
3. 想要完整能力：设置窗 → **组件** → 选装 / 「全部安装」（可断点续传，SHA256 校验）。
4. 组件装完**重启大肥鱼**，宿主 supervisor 才会把新服务拉起来。
5. 命令行等价入口：安装目录下 `安装组件.cmd status` / `install --id=voiceprint,local-memory` / `remove --id=...`。

## 底座已含（不随组件变化）

- Electron 28 + 应用层（live-2d）、皮套与模型、Cubism Core
- Rust 内核 `pet-core`（看屏 / 窗口操控快轨）
- edge-tts 语音（联网，无需 key）
- 完整表演数据：97 段 FACS 片段、112 个 sync 点、节目单
- **我们现在使用的人格**（system_prompt + 人格内核 persona-layers）
- **不含任何记忆/日记/对话历史/用户数据**（个人数据不随包）

## 8 个组件（自动下载，模型走国内镜像）

| 组件 | 体积 | 内容 | 下载来源 | 已知限制 |
|---|---:|---|---|---|
| `python` | 69.7MB | 独立 CPython 3.13 + numpy/scipy/pypinyin | 组件包（GitHub，ghproxy 备用） | 仅服务共用运行时，无独立功能 |
| `voice-asr` | 263.8MB | SenseVoice + Silero VAD（按住 V 说话，1000） | 组件包 + SenseVoice int8 228.2MB（hf-mirror） | 模型另下 228MB；CPU 推理 RTF≈0.055 |
| `cowatch` | 12.5MB | 一起看：系统声音回环（1001） | 组件包（GitHub） | 仅 Windows 回环，需要能捕获系统声音 |
| `memory` | 707.4MB | MemOS + 本地 Qdrant + 嵌入服务（llama.cpp CPU，8090/8003） | 组件包 + Qwen3-Embedding Q8 609.5MB（ModelScope / hf-mirror） | 嵌入走 CPU，首次建库较慢；依赖 `python` |
| `lumen` | 203.0MB | LumenAct 语义表演（8120） | 组件包 + selector.onnx 146.2MB（hf-mirror 固定 revision） | 固定 revision，换模型需同步改清单 |
| `voiceprint` | 263.5MB | 声纹嵌入（resemblyzer + **CPU torch**，256 维，8020） | GitHub 组件包（gh-proxy / ghproxy 备用） | **CPU 推理**，无 GPU 加速；短音频（<2s）区分度下降 |
| `local-memory` | 2381.6MB | MemOperator-4B Q4_K_M（复用 memory 组件的 llama.cpp，28K ctx，11435） | hf-mirror 主源 / HF 官方备用（mradermacher/MemOperator-4B-GGUF） | **CPU-only**（`-t 4`），decode 约 12 t/s 量级；依赖 `memory`；需 ~2.4GB 磁盘 + 内存 |
| `ollama` | 1637.8MB | 便携 Ollama v0.40.18（官方 portable zip 原样，11434） | GitHub 组件包 / 官方 Releases（字节相同） | 三个模型 ~9.3GB **不在包内**，安装时按需 pull；需 ≥12GB 空闲磁盘 |

服务端口：`voice-asr` 1000 / `cowatch` 1001 / `memory` 8090+8003 / `lumen` 8120 / `voiceprint` 8020 /
`local-memory` 11435 / `ollama` 11434；`python` 为共用运行时。

## 本版新增组件的行为

`voiceprint` 只落文件与 service 定义（无 setup），装完重启即监听 8020，`/embed` 返回 256 维向量。

`local-memory` 的 setup 会：写 `llm_providers.json` 的 `local-memory` provider（11435/v1 · MemOperator-4B）、
置 `config.cost.local_memory=true`、把 `memos_config.json` 的抽取 LLM 指到本地 11435。
重复安装幂等（内容没变不写盘，写前留 `.bak-local-memory-*`）。

`ollama` 的 setup 遵守三条硬规则：11434 已有 Ollama 就**复用、不杀、不重启**；空闲才用组件内
`ollama.exe serve` 起临时服务，拉完模型交还宿主 supervisor；拉之前先查 12GB 磁盘余量。
**不**打开 `vision.tiers.enabled`（看屏摘要仍走云端；OCR 直接打 11434，无需配置补丁）。

### `paddleocr-vl:latest` 是可选档（重要）

它**不在 Ollama 官方 registry**（本机这个 tag 是用本地 GGUF 通过 `ollama create` 建的，
Modelfile 的 `FROM` 指向本机 blob）。因此 `ollama` 组件把模型分成两档：

- 必需：`qwen3-vl:8b-instruct`（约 5.8GB）、`glm-ocr:latest`（约 2.5GB）——缺了组件判失败；
- 可选：`paddleocr-vl:latest`（约 1.0GB）——**pull 失败只记 warning，不影响组件安装结果**，
  因为默认 OCR 用 `glm-ocr`，只有显式 `PET_OCR_MODEL=paddleocr-vl` 才用它。

### Ollama 模型体积（不在组件包内）

三个模型合计约 **9.3GB**，由 setup 在装组件时按需 pull（已存在的模型自动跳过）。
组件包本身 1.64GB 只是 Ollama 二进制；磁盘至少留 12GB，慢网可重试（Ollama 分层续传）。

## 本版修复

- **`memory` 组件不再写 `cost.local_memory=false`**：它会在 `local-memory` 之后装时把开关翻回去。
  现由基础 config（默认 false）+ `local-memory` 组件（true）两处决定，安装顺序不再影响结果。
  `_packaging/build-component-packs.ps1` 与合并后的清单都已去掉该键。
- **`安装组件.cmd` 启动修复（v0.4.0 遗留）**：原文件是 UTF-8 无 BOM + 含中文 echo，cmd.exe 用 OEM
  代码页解析时多字节字符吃掉换行，报 `'RUN_AS_NODE'` / `'"DaFeiyu.exe"' 不是内部或外部命令`，
  `status/install/remove` 全部不可用。现改为 **纯 ASCII + CRLF**（中文提示由 Node CLI 自己输出）。

## 不包含

- 你的记忆/日记/对话历史（个人数据，不随包）
- Ollama 的三个模型权重（~9.3GB，由 setup 在装组件时按需拉取或复用已有 Ollama）
- `paddleocr-vl` 权重（非官方 registry；本机为本地 `ollama create`，组件内为可选档）

## 已知限制

- **安装包未代码签名**：SmartScreen 可能提示「未知发布者」→「仍要运行」。
- **组件装完需重启大肥鱼**：服务由宿主 supervisor 在启动时接管，热装不会立刻拉起。
- **卸载组件不撤销 setup 副作用**：卸载 `local-memory` 不会自动删 `llm_providers.json` 的
  `local-memory` provider，也不会把 `memos_config.json` 的 11435 指向改回；卸载后请到「模型」页确认。
- **`local-memory` 是 CPU-only**：复用 `memory` 组件的 CPU llama-server（`-t 4`），decode 约 12 t/s 量级；
  GPU 版 dev 实测 31–52 t/s 仅供参考，组件版不保证同速。
- **`voiceprint` 是 CPU torch**：只装 CPU wheel（`torch.version.cuda` 为空），无 CUDA 加速。
- **`ollama` 复用系统 11434**：若该端口已被非 Ollama 程序占用，组件会明确报错而不是抢占；
  老版本 Ollama（<0.30.0）不认识 qwen3-vl，会被版本闸拦下并提示升级。
- 组件需要联网下载；GitHub 组件包附带 gh-proxy / ghproxy 备用源，模型源为 hf-mirror / ModelScope。
- 安装版默认「静默模式：开」（只回应、不主动搭话），填好 key 后可在托盘关掉。

## 校验

```
DaFeiyu-Setup-0.5.0.exe  124,078,808 B  sha256 ea19fd4fce5f0429884af6089e7afa7ef892f5bc905168e66b9980b2310e32ac

python-0.4.0.zip          69.7 MiB  sha256 1db5a8a79112a45ddb7791372626f42e2839896d2c0c5d89f46a96ea280d52d7
voice-asr-0.4.0.zip       35.4 MiB  sha256 6eee5efb18e3e63a91ff98dc781ce9106955d1778c4e2192731912f817aa1011
cowatch-0.4.0.zip         12.5 MiB  sha256 45529c56958203845ffcca763b8be6cd384dc56ff951e9cec372e4ad49b08009
memory-0.4.0.zip          97.9 MiB  sha256 78c0b586d49b5b921ff191bd8a5f26fec11676426a3bc4319afcdc0f2082f650
lumen-0.4.0.zip           56.4 MiB  sha256 3dcdf270d2fdba9b9196029aafd1b58adbefe62585a4b4acd86568a8f3550e09
voiceprint-0.5.0.zip     263.5 MiB  sha256 1d68df6072281ef451ec437016e2f7cb724b9f05a6a2423df9044eb4deef78c7
ollama-0.5.0.zip        1637.8 MiB  sha256 ca97292ac1e9acc77fcf473bb2741fa6acd12e3798f261b419680068b7cc4c16

MemOperator-4B.Q4_K_M.gguf  2381.6 MiB  sha256 255580fb5c305ca296a1e21530a8efd727a42619352c4dba03944c54e9d44a6f
Qwen3-Embedding Q8_0.gguf    609.5 MiB  sha256 06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439
SenseVoice model.int8.onnx   228.2 MiB  sha256 c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51
LumenAct selector.onnx       146.2 MiB  sha256 b4d53610dc6b95e9f994a371dcc2cd8c24777e28ae56c3720d9d6eebeb1688f2
```

## 构建

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File _packaging\build-component-packs.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File _packaging\build-voiceprint-pack.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File _packaging\build-local-memory-pack.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File _packaging\build-ollama-pack.ps1
node _packaging\build-components-manifest.cjs --fragments _packaging\out\packs\manifest.fragments.json --out _packaging\out\components\manifest.json --version 0.5.0
powershell -NoProfile -ExecutionPolicy Bypass -File _packaging\build-installer.ps1 -Nsis -Version 0.5.0
```

## 真机验收（2026-11-27）

干净目录静默安装 `D:\Temp\dafeiyu-v050-test` → `安装组件.cmd status` 列出 8 个组件 → 组件页截图
`docs/assets/安装包A-组件页-2026-11-27-v050.png`（8 行、按钮不换行、标题不折行）。

本地源（127.0.0.1 临时 HTTP，不依赖 GitHub）实装 `voiceprint` + `local-memory`（依赖 `python`/`memory`）
+ `ollama`：`state.json`/`services.json` 路径正确；voiceprint `18020 /health` 200 + `/embed` 256 维；
local-memory `11436 /health` 200 + `/v1/models` = MemOperator-4B；ollama 复用本机 11434（v0.32.4，
三个模型已存在，未拉 9GB、未杀进程）。卸载 voiceprint/local-memory 后 `cost.local_memory` 还原为 false
（`llm_providers.json` 的 `local-memory` provider 与 `memos_config.json` 的 11435 指向**不会**自动移除，
属已知缺口，卸载后请到「模型」页确认 provider；见验收报告）。

门禁：`node _probe/check-all.mjs --smoke` 201/201 通过；`--core` 234/234 通过。
