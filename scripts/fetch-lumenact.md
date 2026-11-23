# LumenAct 语义选择器（可选）—— 获取与放置

> 可选能力：只影响 8120「LumenAct 语义选择器」（按句选表情/语气）。缺它时该服务如实报错，
> 宿主其余功能不受影响。**本仓库不自动下载 146MB 权重**，也不会在 bootstrap 里判红，
> 只提示「可选未安装」。

## 用在哪

| 组件 | 作用 | 缺失时 |
|---|---|---|
| `pet-runtime/tools/lumen-semantic-server.py`（8120） | RBT3-Lumen-38M-v6 ONNX 常驻推理：情绪描述 + 台词 → 表情类别 / 语气类别 | 服务启动报「缺模型权重」；渲染层按规则兜底 |
| `pet-runtime/data/facs-clips/` | 97 段 LumenAct 表演曲线（已转成 FACS 片段，**已入库**） | 不需要额外下载 |

## 来源与许可

- 源码仓库：<https://github.com/AaBb-coder/LumenAct>
- 资源仓库：<https://huggingface.co/AaBbcoder/LumenAct>
- 固定 revision（发布清单锁定）：`df8126a2a854735227ec81b7f12ab62d49a6d989`
- 权重许可：**Apache-2.0**（RBT3-Lumen-38M-v6）
- 表演曲线许可：**CC BY 4.0**（已在 `NOTICE.md` 署名「LumenAct／流明表情工坊」）
- 参考脸 `lumen-reference-face.blend` 是 **CC BY-NC 4.0**：本项目**不使用**，也不要下载进产品目录。

## 目标路径

```
_research/lumenact/
├─ models/
│  ├─ selector.onnx          # 语义模型权重（约 146MB）
│  └─ tokenizer.json         # 分词器（服务直接读这个路径）
└─ assets/
   └─ semantic-config.json   # 类别表/voice 表/max_length（服务必需）
```

说明：`_research/` 是 gitignored 的本地参考区（各自带 `.git` 的克隆也放这里），
所以模型永远不会进产品仓库。上面的路径是 `lumen-semantic-server.py` 写死的：

```python
MODELS = <repo>/_research/lumenact/models
CFG    = <repo>/_research/lumenact/assets/semantic-config.json
```

## 获取步骤（手动，一次性）

1. 克隆 LumenAct 源码到 `_research/`（如果还没有）：

   ```bash
   git clone https://github.com/AaBb-coder/LumenAct _research/lumenact-src
   ```

2. 用官方下载器取资源（只用 Python 标准库，会校验大小与 SHA-256）：

   ```bash
   cd _research/lumenact-src
   py download_assets.py --repo AaBbcoder/LumenAct --revision df8126a2a854735227ec81b7f12ab62d49a6d989
   ```

   也可以直接用 Hugging Face CLI：

   ```bash
   huggingface-cli download AaBbcoder/LumenAct --revision df8126a2a854735227ec81b7f12ab62d49a6d989 --local-dir _research/lumenact-hf
   ```

3. 按「目标路径」复制**最小集**：

   | 下载物 | 复制到 |
   |---|---|
   | `models/semantic/selector.onnx` | `_research/lumenact/models/selector.onnx` |
   | `models/semantic/tokenizer/tokenizer.json` | `_research/lumenact/models/tokenizer.json` |
   | `models/semantic/config.json` | `_research/lumenact/assets/semantic-config.json` |

   > 注意最后一条：服务读的是 `assets/semantic-config.json`，不是 `models/semantic/config.json`。
   > 两者内容同源（类别标签 / speech_styles / max_length），改名放置即可。

4. 验证：

   ```bash
   py pet-runtime/tools/lumen-semantic-server.py --check
   ```

   退出码 0 = 加载 + 跑通一条；1 = 缺文件/缺依赖（`onnxruntime`、`transformers`）。
   常驻启动：

   ```bash
   py pet-runtime/tools/lumen-semantic-server.py --port 8120
   ```

## 依赖

```bash
py -m pip install onnxruntime transformers
```

（`numpy` 已在其它 requirements 里；CPU 推理即可，约 7.5–8.5ms/次。）

## 不做什么

- 不下载参考脸（CC BY-NC，不可商用）。
- 不把权重提交进仓库（`_research/` 已被 ignore）。
- 不在 bootstrap 里自动拉取；只在 `--json`/文本报告里标「可选：未安装」。
