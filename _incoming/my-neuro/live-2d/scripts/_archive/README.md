# 一次性补丁脚本（已归档 2026-11-12）

这些是开发期用来给 control-main.js 注入代码的临时脚本，**跑一次就会重复注册 IPC handler**
（`Attempted to register a second handler` → Electron 主进程直接退出）。
功能已全部并进 control-main.js，不再需要执行；留档只为追溯当时改了什么。
