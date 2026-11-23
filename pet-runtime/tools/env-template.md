# 大肥鱼 · 运行环境

> 这个目录是**便携版**：依赖不打包，需要先装好环境才能跑。依赖只需装一次。

## 必需

| 项 | 本机实测版本 | 作用 |
|---|---|---|
| Node.js | v24.19.0 | 宿主进程 + 所有服务编排 |
| Python | 3.13.3（用 `py` 启动器） | ASR / TTS / 音频服务 |

## Python 包

```bat
py -m pip install fastapi uvicorn numpy==2.3.5 sherpa-onnx==1.13.8
py -m pip install resemblyzer   :: 声纹 8020（可选，装在 venv-voice 里）
```

> ⚠️ `numpy` **必须是官方版 2.3.5**。MINGW 实验版会让 MemOS 与音频服务段错误（0xC0000005），
> 这个坑踩过，重装一次要十几分钟。

## 模型（**必须放纯英文路径**）

kaldifst 读不了含中文的路径，会报 `Error opening input stream ...phone.fst`。

| 模型 | 用在哪 |
|---|---|
| SenseVoice `model.int8.onnx` | ASR 1000 |
| Qwen3-Embedding-0.6B-Q8_0.gguf | 嵌入 8090（**共享服务，绝对不要杀**） |
| Cubism5 皮套资产 | 已打包在 `pet-runtime/desktop/assets/jellyfish/` |

## 可选

- Rust 工具链：只在你需要重新编译 `pet-core` 时才要。便携版已带编译好的 `pet-core.exe`。
  编译需注意本机无 MSVC 链接器，用 GNU target（`~/.cargo/config.toml` 里设 `[build] target`）。

## 自检

```bat
大肥鱼.cmd doctor     :: 27 项体检
大肥鱼.cmd verify     :: 9 项总验收
大肥鱼.cmd status     :: 端口与服务状态
```

全部通过才算环境就绪。

## 端口占用

| 端口 | 服务 |
|---|---|
| 8003 | MemOS 记忆 |
| 8004 / 8005 | 皮套 / 字幕 自检通道 |
| 8020 | 声纹 |
| 8090 | **嵌入服务（共享，绝对不要杀）** |
| 8103 | HTTP 控制口 |
| 9883 | Edge TTS |
| 1000 / 1001 | ASR / 系统声音 |

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 只有字幕没声音 | TTS 线程静默死掉 | 看门狗已在；`doctor` 查「语音播放」 |
| 皮套不显示 | `ui.model_type` 被改成非 petbody | 改回 `petbody` |
| 识别出乱码/韩文 | **麦克风采到全静音** | `doctor` 查不到这项；看日志有没有「这段录音几乎是静音」。换设备或开麦克风权限 |
| MemOS/音频段错误 0xC0000005 | numpy 是 MINGW 实验版 | 重装官方 2.3.5 |
