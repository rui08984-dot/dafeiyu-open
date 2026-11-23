# NOTICE — MemOS 子树（`plugins-dlc/memos/`）

本目录是「大肥鱼」集成的 MemOS 记忆后端代码，来源与许可以下：

- 上游项目：**MemTensor / MemOS** — <https://github.com/MemTensor/MemOS>
- 上游许可：**Apache License 2.0**（完整文本见同目录 `LICENSE`）
- 本地版本：`memos_system` 为面向桌宠的集成改编版（FastAPI 服务 + Qdrant 向量库 + 知识图谱 + 多用户/MemCube），
  与上游文件存在修改、增删与合并。

## 修改说明（Apache-2.0 §4(b)）

- 增加桌宠侧的 HTTP API（`memos_api_server_v2.py` / `_full.py`）与配置模板；
- 接入本地 Qdrant 嵌入服务（8090）与可选的图存储；
- 增加/调整日志、错误处理与启动脚本（`MEMOS-API.bat` / `MEMOS-WebUI.bat`）；
- 删除上游与本项目无关的示例与部署文件。

## 免责

本目录按 Apache-2.0 以「现状」提供，不附带任何明示或默示担保。运行所需的 Python 依赖、
Qdrant/嵌入模型由使用者自行安装；本仓库不包含真实记忆数据与密钥。
