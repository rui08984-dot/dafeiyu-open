# 表演数据来源与许可

本目录的 FACS 片段由 **LumenAct**（作者：B站 Lumen_流明_）公开的表演曲线转换而来。

- 原始项目：https://github.com/AaBb-coder/LumenAct
- 表演数据许可：**Creative Commons Attribution 4.0 International (CC BY 4.0)**
  https://creativecommons.org/licenses/by/4.0/
- 转换脚本：`pet-runtime/tools/import-lumenact.mjs`
- 我们做的修改：把 166 个 VRM/VRC blendshape 通道重映射到本项目的 FACS 语义通道、
  数值由 0–100 归一化到 FACS 单位、按 20fps 抽帧、去掉整段恒定的通道。

原始表演曲线的 166 通道定义、片段标签（label/emotion/subcategory/environment/pace）均来自 LumenAct。
本目录**不包含** LumenAct 的参考脸（其许可为 CC BY-NC 4.0），也不包含其语义模型权重（Apache-2.0）。

> 表演数据来源：LumenAct／流明表情工坊