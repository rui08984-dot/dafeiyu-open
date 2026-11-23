# 大肥鱼 · 应用层（live-2d）

本目录是「大肥鱼」的 Electron 应用层（渲染、语音、记忆、插件）。
公开版已经把宿主运行时与应用层合并成一棵树，**不需要再单独 clone 私有仓库**。

安装、配置、启动、自备资产：请看仓库根目录的 `README.md`。

## 常用命令（在仓库根目录执行）

```bat
cd _incoming\my-neuro\live-2d && npm install
node scripts\bootstrap.mjs --json
node _probe\check-ci.mjs
```

体检：在仓库根目录跑 `node scripts/bootstrap.mjs`。
