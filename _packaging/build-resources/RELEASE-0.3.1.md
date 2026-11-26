# v0.3.1 · 一键安装包（Windows）

首个**双击安装即可用**的 Windows 安装包（NSIS，约 117MB）。此前只有「源码树 + `安装.cmd`（需要 Node 20）」。

## 安装

1. 下载 `DaFeiyu-Setup-0.3.1.exe`，双击安装（装到 `%LOCALAPPDATA%\Programs\大肥鱼`，不需要管理员）。
2. 启动「大肥鱼」。
3. 第一次启动会自动打开设置窗的「模型」页：填 **API Key**（支持任意 OpenAI 兼容网关），点「保存」立刻生效，不用重启。

## 包含

- Electron 28 + 应用层（live-2d）、皮套与模型、Cubism Core
- Rust 内核 `pet-core`（看屏 / 窗口操控快轨，缺失时才退回 PowerShell）
- edge-tts 语音（联网访问微软免费端点，无需 key）
- 默认 provider：`https://api.openai.com/v1` / `gpt-4o-mini`（接口地址与模型名都可改）

## 不包含（按需自装；完整源码树里有部署方式）

- 本地 4B 记忆模型（MemOperator-4B GGUF）
- ASR / MemOS / 一起看 / OCR 等 Python 服务（按住 V 说话、长期记忆、一起看不可用）

## 已知限制

- 安装包未代码签名 → Windows SmartScreen 可能提示「未知发布者」，选择「仍要运行」。
- 安装版默认「静默模式：开」（只回应、不主动搭话，避免没配 key 时刷报错）；填好 key 后可在托盘右键菜单关掉。
- 卸载不会删除安装目录里的配置与记忆。

## 校验

```
文件：DaFeiyu-Setup-0.3.1.exe
大小：122,343,554 字节（116.7 MiB）
SHA256：A2659EF56B1559888DB84FC2F37CFC8EBCB42B544116B69F2E4FB39C72A79CD9
```

## 构建

```bat
REM 语音单文件 exe（干净 venv + PyInstaller）
powershell -NoProfile -ExecutionPolicy Bypass -File _packaging\build-tts.ps1
REM 安装包
powershell -NoProfile -ExecutionPolicy Bypass -File _packaging\build-installer.ps1 -Nsis
```

真机验收（2026-11-26）：干净目录静默安装 → 首启自动落「模型」页 → 注入真实 key → `POST 127.0.0.1:8103/chat` 得到回复；渲染层 ok、随包 TTS 合成 200、pet-core 截图走 Rust。
