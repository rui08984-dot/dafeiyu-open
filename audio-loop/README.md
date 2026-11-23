# audio-loop —— 大肥鱼的「一起看」耳朵

抓取电脑正在播放的声音，切成句子，识别成文字，供桌宠「和你同频道一起看」。

## 为什么这么干

让她「一起看剧」，瓶颈不是画面而是**对白**。画面 2fps 采样一句话摘要就够了，
但剧情全靠台词推进——听不见台词，她就只能泛泛地说「你在看视频啊」。

Windows 上录系统声音有几种做法：

| 方案 | 问题 |
|---|---|
| 装 VB-Cable 等虚拟声卡 | 要用户手动装驱动、改默认设备，破坏体验 |
| 录「立体声混音」 | 很多机器没启用；默认输出是 USB DAC 时录不到（本机就是这种情况） |
| **WASAPI loopback** | 系统原生支持，跟随默认输出设备，零配置 —— **本项目用这个** |

`sounddevice` 的 `WasapiSettings(loopback=True)` 在 0.5.6 还不支持，所以用 `soundcard` 库，
它直接暴露「默认扬声器对应的回环设备」。

## 数据流

```
默认扬声器 ──WASAPI loopback──▶ 16k 单声道 PCM
        │
        ▼  能量 VAD（起说 0.006 / 停说 0.0035，滞回）
   切句：静音 700ms 或满 15s
        │
        ▼  POST 1000/v1/upload_audio
   SenseVoice 识别
        │
        ▼
   带时间戳的滚动字幕（默认留 10 分钟）
```

## 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 是否在录、设备名、是否暂停、已收句数、识别失败数 |
| GET | `/segments?since=ms` | 取某个时间点之后的句子 |
| GET | `/now?seconds=40` | 最近 N 秒拼成一段文本（给模型直接读） |
| POST | `/pause` `{"on":true}` | 暂停收录 |
| POST | `/clear` | 清空缓冲 |

## 关键设计：不能听见自己

她在说话时 TTS 会走同一条输出通道，回环会把她的声音也录进去，
识别成「用户在说话」→ 自己跟自己对话，自激。

处理办法在宿主侧：`js/avatar/petbody/driver.js` 里的 `listenGate` ——
嘴一动（`onMouth > 0.02`）就 `POST /pause {on:true}`，静音 900ms 后才恢复。
副作用正好是对的：**她说话的时候本来就不该「听」**。

## 自测

```bash
cd audio-loop
py selftest.py
```

会做三件事：起服务 → 用 Edge TTS 生成一段中文 → 播放并回环录取 → 打印识别结果。

预期输出：

```
health: {"ok": true, "recording": true, "device": "耳机 (CX31993 HIFI AUDIO)", ...}
now: {"ok": true, "text": "这集我要开始认真看了", "count": 1}
```

## 依赖

- Python 3.13
- `soundcard`（WASAPI loopback）
- `numpy`
- 本项目的 SenseVoice ASR 服务在 1000 端口

## 已知限制

- **只录默认输出设备**。如果用户把播放器单独输出到别的设备，录不到。
  （可以扩成「同时录所有回环设备」，但需要处理多路混合，暂时不做）
- 纯音乐/无对白的段落会被 VAD 当噪声丢掉，这是想要的行为。
- 识别质量受音量和背景音影响；片头音乐大的时候前几句可能丢。
- 独占模式（ASIO / WASAPI exclusive）播放时回环可能拿不到数据。