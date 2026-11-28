# v0.5.3 · 安装包卫生修复（请用本版替代 v0.5.2）

**v0.5.2 安装包有两处卫生问题，请勿再分发**：误带了测试期的 Chromium 用户数据目录
（`Tempcc-test/`，内含开发机绝对路径），以及未脱敏的火山/百度 appid、个人工作区和
PCL 启动器路径。本版修掉这些，并且把检查做成构建期硬断言，以后再犯会直接构建失败。

底座与 8 个组件能力不变（组件包沿用 v0.4.0 / v0.5.0 资产，SHA256 逐位一致）。

## 安装

1. 下载 `DaFeiyu-Setup-0.5.3.exe`（**123,165,776B / 约 117.5MB**，sha256 `90b8e861…aa0f6a47`），双击安装。
2. 首次启动会同时弹「模型」页和「把她的完整能力装上？」：8 个组件全部默认选中，点「全部安装」一次装好。
3. 装完重启大肥鱼。

## 本版修复

- **不再带测试目录**：`Tempcc-*` / Chromium `Local Storage` / `GPUCache` / `Cache_Data`
  一律排除；afterPack 整树断言，命中即构建失败。
- **安装版脱敏**：`cloud.volcengine_tts.appid` / `cloud.baidu_asr.appid` 置空；
  `dispatch.workspaces` / `defaultWorkspace` 清空；插件配置里的 `C:/Users/...`、`D:/...`
  绝对路径换成「（本机路径）」；afterPack 断言配置里没有个人 appid / 本机绝对路径。
- **清理 dev 杂物**：`go.bat`、`AI_set_live2d.py`、`启动 WebUI 控制面板.bat`、
  `一键扫描皮套动作.bat`、`fake_neuro_audio/`（含 `conda activate`）不再随包。
- **补游戏知识库**：`pet-runtime/knowledge/{rules,templates,grid-baseline}` 随包
  （原神/我的世界/植物大战僵尸规则、点击模板、网格基线）；`experience/` 与
  `knowledge/skills/skills.json` 是个人数据，不随包。
- **不再写开发机路径**：`main.js` 的 `main-boot.json` / `tray-selftest.log` 改写到
  `app.getPath('userData')`；游戏事件 OCR 不再写死 `D:/agent1super/scripts/ocr.py`，
  安装版没有本机 OCR 脚本时直接走 Ollama `glm-ocr`（有 ollama 组件即可用）。
- **组件页随装随刷**：批量装 8 个时，每进一个组件/写完配置就刷新列表，不用等整批结束。
- **文案**：`安装说明.txt` 的版本号改由 `-Version` 构建时注入（不再出现 v0.5.2 包里写 v0.5.1）；
  磁盘口径统一为「约 15.8GB，按 ≥16GB 空闲准备」。

## 验收（2026-11-28）

- 全量安装（子代理，v0.5.2 包）：干净目录 → 首启弹窗 8/8 已选 → 真实点「全部安装」→
  8 个组件全部成功（5,539MB，11 分 33 秒）→ 重启后 ASR/一起看/MemOS/声纹/语义/本地记忆
  6 个服务健康 → 真实 key 对话返回 `BANANA`（4.7s）→ 卸载/清理正常。
- v0.5.3 包：静默安装后无 `Tempcc-*`、无 dev 杂物、appid 已置空、插件配置 0 条本机路径、
  知识库在位、`main.js` 0 处 `<project-root>`；首启弹窗 8 行全选、磁盘/显存提示正确。
- 门禁：smoke **201/201**、core **234/234**。

## 已知限制

- 坐标级 OCR（`ocr_find.py`，按文字找坐标）仍依赖本机 Python + RapidOCR；组件的
  `python` 包没有带 Pillow/RapidOCR，所以安装版「读文字」可走 Ollama，「按文字点坐标」
  暂不可用。下一版组件处理。
- 安装包未代码签名；卸载不撤销组件 setup 写入的 provider/MemOS 指向（P1）。
- 本机测试机已有 dev 的 8090/11434 时，组件会按设计复用/跳过，不会重复下载 9.3GB 模型；
  干净机器上会启动组件自带实例。
