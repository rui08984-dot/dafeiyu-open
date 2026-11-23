# 大肥鱼 · 桌宠运行时

一只住在桌面右下角的 Live2D 陪伴体：会说话、会听、会看屏幕、会和你一起看剧、记得你以前说过什么。

- 皮套：Cubism 5（自研渲染器，49 组遮罩 + 131 组物理全开）
- 宿主：my-neuro（fork 薄改，渲染层换成我们的身体）
- 大脑：可插拔 OpenAI 兼容模型

---

## 快速开始

~~~bash
cd pet-runtime
node tools/launch-my-neuro.mjs      # 起全套
~~~

会依次拉起：语音合成 9883、语音识别 1000、一起看·耳朵 1001、宿主窗口，
以及 VTS 协议 8001、控制口 8103、自检通道 8004。

全清：

~~~bash
powershell -File tools/kill-all-pet.ps1
~~~

---

## 出问题先跑这个

~~~bash
node tools/doctor.mjs
~~~

把「她能不能说话」拆成 10 项逐个验，坏在哪一环直接告诉你、给出修法：

~~~
✓ 桌面窗口       420×760 @2356,816
✓ 模型端点       comad · deepseek/deepseek-v4.1-flash
✓ 语音合成 TTS   9883 在线
✓ 语音识别 ASR   引擎 sensevoice+silero 已加载
✓ 一起看·耳朵     耳机 (CX31993 HIFI AUDIO) · 已收 12 句
✓ 控制口 8103    uptime 301s
✓ 插件           14 个插件 / 29 个工具
✓ 皮套           Cubism5 已加载
✓ 记忆目录       核心记忆 5 条
✓ 开机自启       已安装
~~~

---

## 日常命令（petctl）

~~~bash
node tools/petctl.mjs status     # 整体状态一屏看完
node tools/petctl.mjs emotion    # 现在什么表情、因为什么
node tools/petctl.mjs say "在吗"  # 只发声 + 字幕
node tools/petctl.mjs chat "在吗" # 真对话（LLM → TTS → 口型 → 字幕）
node tools/petctl.mjs plugins    # 插件 + 工具 + 重名别名
node tools/petctl.mjs cowatch    # 一起看：声轨对白 + 画面摘要
node tools/petctl.mjs shot       # 截她的窗口
node tools/petctl.mjs logs 60    # 日志尾巴
~~~

---

## 她怎么看你、怎么听你

| 能力 | 实现 | 端口 |
|---|---|---|
| 说话 | Edge 神经音色，口型由音量驱动 | 9883 |
| 听你 | SenseVoice + Silero VAD，按住 V 说话 | 1000 |
| 一起看 | WASAPI 回环录系统声音 → VAD 切句 → 识别成对白 | 1001 |
| 看屏幕 | 2fps 采样 → 变化检测 → 关键帧 → 一句话语义摘要 | 内部 |
| 记住你 | 中文 bigram + IDF + 时间衰减 + 来源权重，本地检索 | 内部 |

**她说话时不会听自己**：嘴一动就暂停声轨采集，静音 900ms 后恢复。

---

## 交互

| 操作 | 效果 |
|---|---|
| 左键拖拽 | 移动整个窗口（位置会记住） |
| 左键点 | 摸头 / 拍一下，有反应 |
| **右键** | 快捷菜单：打字框 / V键录音 / 换个动作 / 她现在什么表情 / 打开设置 / 先藏起来 |
| 按住 V | 说话（松开识别） |
| Alt | 开关打字框（Alt+数字 换 6 种样式） |
| Ctrl+M | 开关气泡 |
| Ctrl+G | 打断她说话 |
| Ctrl+T | 置顶 |
| Ctrl+Q | 退出 |
| 托盘 | 隐藏 / 置顶 / 静音 / 打开设置 / 开机自启 / 退出 |

---

## 设置在哪

托盘菜单 →「打开设置…」，或直接 `live-2d/control-main.js`。

里面有一页 **🐟 大肥鱼**：窗口尺寸、默认鼠标穿透、看全身、嘴型幅度、表情强度，
以及一个「自查当前状态」按钮（列出窗口位置、穿透状态、当前情绪）。

---

## 她会主动开口

- 空闲 **240 秒**没动静，她会自己说一句
- 深夜 1:00–7:00 几乎不主动（间隔 ×4）
- 优先接她刚看到/听到的内容，不说「在吗」这类客服话
- 你一动她（点击、说话、拖拽）计时器就重置

---

## 目录

~~~
pet-runtime/
  tools/
    launch-my-neuro.mjs  启动器（清残留 → 注入密钥 → 体检端点 → 起 sidecar → 起宿主）
    petctl.mjs           控制台（status/chat/say/shot/emotion/plugins/cowatch/probe/doctor/logs）
    doctor.mjs           体检（10 项，带修法）
    sync-credentials.mjs 从 DSH 凭证库注入模型密钥
    shot.mjs             CDP 截图（独立舞台页用）
    autostart.mjs        开机自启安装/卸载
  desktop/               我们的身体：渲染器 / 身体导演 / 互动 / 动作词典 / 情绪引擎
  build-petbody.mjs      打包出宿主可用的 petbody.js

audio-loop/            一起看·耳朵（WASAPI 回环 + VAD + ASR）
asr/                   语音识别服务
edge-tts/              语音合成服务
_incoming/my-neuro/    宿主（含 data：对话历史 / 日记 / 记忆 / 心情）
~~~

---

## 已知限制

- 只录**默认播放设备**；播放器单独输出到别的设备时，一起看听不到
- 独占模式（ASIO / WASAPI exclusive）播放时回环可能拿不到数据
- 视频画面只做「一句话摘要」，没有镜头/人物级理解
- 皮套有授权限制：**仅本人使用，不要分发模型文件**