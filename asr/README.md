# 本地语音识别服务（SenseVoice + Silero VAD）—— 桌宠的「耳朵」

给 my-neuro 宿主提供 **离线中文/英文语音识别**：PTT 按住 V 说话，松手后把 WAV 上传到这里，返回文字给 LLM。
模型全部在本机，**不联网、不下载、音频不落盘**。

- 识别：**SenseVoice-Small int8 ONNX**（sherpa-onnx OfflineRecognizer.from_sense_voice）
- 端点检测：**Silero VAD**（sherpa-onnx VoiceActivityDetector）
- 契约：严格照 _incoming/my-neuro/live-2d/js/voice/asr-processor.js

~~~
asr/
├─ asr_server.py   # 服务本体（HTTP 上传 + VAD WebSocket）
├─ test_asr.py     # 自测：造音频 → 上传识别 → VAD 事件校验
└─ README.md       # 本文件
~~~

## 1. 模型与依赖（本机已就绪）

| 用途 | 路径 |
|---|---|
| SenseVoice 模型 | ~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx/model.int8.onnx |
| tokens | ~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx/tokens.txt |
| Silero VAD | ~/.dsh/speech-to-text/sensevoice/models/silero/silero_vad.onnx |

依赖：py -c "import sherpa_onnx, numpy, aiohttp, soundfile, scipy, requests" 全通过即可
（本机 Python 3.13.3 / sherpa-onnx 1.13.8 / onnxruntime 1.20.1 / aiohttp 3.14.3）。
一键安装：`py -m pip install -r asr/requirements.txt`（可选组见文件内注释）。
ffmpeg 只在测试脚本合成音频时需要。

### 1.1 新机器：模型从哪来

模型不入库（体积大 + 许可需单独确认），需要手动放到位。先检查缺什么：

```bash
node asr/check-models.mjs
node asr/check-models.mjs --json        # 机器可读
```

缺文件时脚本会打印可直接粘贴的 PowerShell 下载命令，来源是 k2-fsa/sherpa-onnx 的
`asr-models` release（Apache-2.0）：

| 文件 | 发布包 / 下载 |
|---|---|
| `model.int8.onnx` + `tokens.txt` | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2`（解压后目录内的同名文件） |
| `silero_vad.onnx` | 同一 release 下的单文件 `silero_vad.onnx` |

目标结构必须是：

```
~/.dsh/speech-to-text/sensevoice/models/
├─ sensevoice-onnx/model.int8.onnx
├─ sensevoice-onnx/tokens.txt
└─ silero/silero_vad.onnx
```

放别处也行：`py asr/asr_server.py --model-dir <dir>` 或设 `ASR_MODEL_DIR`。
路径尽量用**纯英文**；kaldifst 读不了中文路径（历史踩坑）。

## 2. 启动

~~~bash
py <project-root>/asr/asr_server.py            # 默认 127.0.0.1:1000
py <project-root>/asr/asr_server.py --port 1000 --threads 2
py <project-root>/asr/asr_server.py --itn      # 打开标点/数字规整（默认关 = 纯文本）
py <project-root>/asr/asr_server.py --model-dir <dir>
~~~

启动成功的输出（launch-my-neuro.mjs 会把 stdout 收进 pet-runtime/.state/my-neuro.out.log）：

~~~
[asr] 模型目录：<user-home>\.dsh\speech-to-text\sensevoice\models
[asr] SenseVoice 已加载（int8，2 线程，itn=关，用时 1.3s）
[asr] Silero VAD 已就绪（window=512 @ 16000Hz）
[asr] 监听 http://127.0.0.1:1000  ·  POST /v1/upload_audio  ·  WS /v1/ws/vad  ·  GET /health
~~~

启动失败**不静默**：模型缺失 / 加载失败 / 端口被占都会打印 [asr][FATAL] ... 并以退出码 1 结束。

## 3. 契约（和 asr-processor.js 一一对应）

### 3.1 上传识别 POST /v1/upload_audio

- multipart/form-data，字段名 **file**，内容 WAV（16k 单声道 16bit 最佳；其它采样率/声道会自动转）
- 兼容直接 POST WAV 字节（Content-Type: audio/wav）

响应（客户端取 result.text，也兼容 {status:'success', text} 形式，两个都给）：

~~~json
{ "status": "success", "text": "你好我是大肥鱼现在在测试本地语音识别", "lang": "<|zh|>", "duration": 4.66, "elapsed": 0.19, "rtf": 0.04 }
~~~

失败：{"status":"error","text":"","error":"..."}，HTTP 400/500。

~~~bash
curl -s -X POST -F "file=@speech.wav" http://127.0.0.1:1000/v1/upload_audio
curl -s http://127.0.0.1:1000/health
~~~

### 3.2 VAD 流 WS /v1/ws/vad

- 客户端（asr-processor.js）把麦克风的 **Float32Array（每帧 512 采样，小端）以二进制帧**推上来；
- 服务端用 Silero VAD 判定，**只在状态变化时**回：

~~~json
{ "type": "vad", "is_speech": true }     // 开始说话
{ "type": "vad", "is_speech": false }    // 说完了（内置 250ms 静音滞回）
~~~

- 连接建立时先回一条 {"type":"vad-ready","is_speech":false,...} 让客户端校准状态；
- 文本帧可选：{"type":"reset"} 重置、{"type":"ping"} 回 pong；
- my-neuro 收到 true 开始录音；收到 false 起 500ms 静音计时后结束录音并走上传接口。
- **PTT 模式下客户端不读 VAD**（录音由按键划定），但连接照旧——本服务两种模式都支持。

> 说明：is_speech 语义是「当前是否有语音」，实现上是 Silero 的 hysteresis 判定：
> min_speech_duration=0.15s（至少说 150ms 才算开始）、min_silence_duration=0.25s（安静 250ms 才算结束）。

## 4. 实测性能

| 音频 | 时长 | 识别耗时 | RTF | 文本 |
|---|---|---|---|---|
| 中文短句（edge-tts，test_asr 实测） | 5.81s | 0.51s | **0.082** | 你好我是大肥鱼现在在测试本地语音识别听得清楚吗 |
| 英文短句（edge-tts） | 3.84s | 0.31s | **0.080** | hello this is a local speech recognition test |
| 长参考音（大肥鱼.wav） | 20.58s | 1.06~1.22s | **0.05~0.06** | 人家才不是随便点的呢… |

并发：两个上传同时打进来也能依次识别（服务端 decode 串行 + 事件循环不阻塞），实测 RTF 0.068 / 0.072。

目标「16k 3 秒音频 1.5 秒内出结果」→ 实测约 **0.15s**，余量很大。
--itn 开/关对比：你好，我是大肥鱼。现在我在测试语音识别。 ↔ 你好我是大肥鱼现在我在测试语音识别
（任务要求纯文本 → 默认 use_itn=False；要标点加 --itn）。

## 5. 自测

~~~bash
# 先起服务（或由 launcher 拉起），再：
py <project-root>/asr/test_asr.py
py <project-root>/asr/test_asr.py --skip-ws          # 只测上传
py <project-root>/asr/test_asr.py --audio some.wav   # 不合成，用现成音频
py <project-root>/asr/test_asr.py --fast             # VAD 阶段不按实时速度推
~~~

检查项：① edge-tts 合成中文 → 上传 → 文本非空；② RTF ≤ 0.5；③ 英文句能识别；④ VAD 能给出
「开始说话 → 说完了」两段事件。全过打印 ✓ 自测通过，退出码 0。

最近一次实测输出（可直接对照）：

~~~
== 2/4 POST http://127.0.0.1:1000/v1/upload_audio ==
  HTTP 200  耗时 0.51s  RTF=0.082
  识别文本：'你好我是大肥鱼现在在测试本地语音识别听得清楚吗'
== 3/4 英文 ==
  HTTP 200  识别文本：'hello this is a local speech recognition test'
== 4/4 VAD WebSocket ==
  事件：[(0.05, False), (0.46, True), (2.98, False), (3.26, True), (7.97, False)]
✓ 自测通过：上传识别 + VAD 事件都正常
~~~

## 6. 端口占用 / 排障

1000 被占时服务会明确报错：

~~~
[asr][FATAL] 端口 1000 已被占用（[WinError 10048] ...）。
  netstat -ano | findstr :1000      # 看 PID
  taskkill /PID <pid> /F            # 确认是自己的再杀
~~~

launch-my-neuro.mjs 已在启动前自动清理 1000/9883 上的遗留进程（killStale），
并在 asr 进程退出 3 秒后自动重启。

| 现象 | 排查 |
|---|---|
| 启动即退出、[asr][FATAL] 缺少模型文件 | 模型路径不对：用 --model-dir 指定，或确认 ~/.dsh/... 存在 |
| No module named sherpa_onnx | py -m pip install sherpa-onnx（本机已装，一般不会） |
| /health 返回 loaded:false | 模型还在加载或加载失败，看启动日志 |
| 识别返回空文本 | 音频太短（<0.1s）、几乎没有声音、或采样格式不对（必须 WAV） |
| RTF 变高（>0.5） | 提高 --threads（4/8），或确认没有多个服务实例抢 CPU |
| VAD 没事件 | 客户端要发**二进制 Float32**（不是文本/base64）；用 test_asr.py 对照 |

## 7. 与 my-neuro / 启动器集成

- config.json 已配好（无需改动）：

~~~json
"asr": {
  "enabled": true,
  "vad_url": "ws://127.0.0.1:1000/v1/ws/vad",
  "asr_url": "http://127.0.0.1:1000/v1/upload_audio",
  "voice_barge_in": true, "ptt_enabled": true, "ptt_key": "v"
}
~~~

- pet-runtime/tools/launch-my-neuro.mjs **已经接了**（第 64~75、79~92 行）：spawn py asr/asr_server.py --port 1000 →
  日志转发进 .state/my-neuro.out.log → 退出 3s 自动重启 → 启动前 killStale(1000) 清遗留。
  **本 README 的建议已落地，无需额外改动。**
- 建议的小改进（可选，按需做）：
  1. **健康门禁**：launcher 在拉起 my-neuro 前 GET /health 轮询 ≤5s，服务没就绪就只在日志里标 [asr] 未就绪，
     避免用户按住 V 却「没反应」的错觉；
  2. **开关**：加 --no-asr / 环境变量 PET_ASR=0，方便「只想打字不想开麦」的调试场景；
  3. **日志前缀**：launcher 已加 [asr] 前缀，保持即可——排查时 grep '\[asr\]' .state/my-neuro.out.log；
  4. **单实例**：killStale(1000) 只杀 LISTENING 的 PID；若上一个进程卡在「端口已释放但进程还在」，
     建议再按命令行匹配 asr_server.py 兜底（不要用 IMAGENAME 通配杀所有 python.exe）。

## 8. 隐私

- 全程本地推理，音频只在内存里过一遍，**不写文件、不发网络**；
- 服务只监听 127.0.0.1（默认），局域网其它机器连不上；
- 唯一联网点是 test_asr.py 里用 edge-tts 合成测试音频（可用 --audio 完全离线）。