# ADR-002：表情表征用 FACS 语义中间层，而不是直接写 Cubism 参数

**Status:** Accepted（2026-11-12 落地，2026-11-17 用 LumenAct 数据验证后确认）
**Date:** 2026-11-17（复核）
**Deciders:** 主会话（技术）· 用户（观感验收）

## Context

Live2D 模型有 **509 个参数**，名字是 `ParamBrowLY` / `ParamMouthForm` / `key7` 这类
**模型私有**命名。表情需求会从三条不同来源到达：

1. 情绪（文本/语音/事件）—— 连续的、要叠加的；
2. 语音重音（说话时的眉/眼）—— 只碰眉眼，绝不碰嘴；
3. 一次性表演（编舞 / LumenAct 面部片段）—— 有开始/结束、要淡入淡出。

如果每个来源都直接写参数：换模型全废；两层同时写会互相覆盖；缺参数时静默不生效；
也无法把「眉毛在动」和「嘴角在动」分开叠加。

## Decision

三层表征，**任何新来源都必须先进 FACS**：

```
情绪/VAD/片段  →  FACS 语义通道（30 个，模型无关）  →  profile（模型画像）  →  Cubism 参数
```

- `facs.mjs`：30 个语义通道（browInnerUp/browUpL/eyeOpen/eyeSmile/mouthSmile/tear/blush/headX…），
  约定 `eyeOpen` 是**绝对值**（1=正常），其余多为 0..1 强度量、头/视线是 −1..1 方向量。
- `mixer.mjs`：五层（idle/emotion/speech/reaction/manual），每通道按语义定规则：
  **additive**（头/身/呼吸/眨眼）、**max**（笑容/脸红/泪，防叠加溢出）、**set**（手动覆盖）。
- `profile.mjs`：FACS → 具体参数（带 scale/absolute/range），缺参数自动降级并出报告；
  `EXTERNALLY_OWNED` 声明谁拥有哪些通道（口型/视线/头身/眨眼）。

## Options Considered

### Option A：直接写 Cubism 参数（现状之前）
| 维度 | 评估 |
|---|---|
| 复杂度 | 低 |
| 换模型 | ❌ 全废 |
| 叠加 | ❌ 互相覆盖 |
| 可测 | 中（要起渲染器） |

### Option B：表情资源槽（Live2D 的 Exp 文件）
| 维度 | 评估 |
|---|---|
| 复杂度 | 低 |
| 换模型 | 中（exp3.json 可替换） |
| 叠加 | ❌ 单槽，两个情绪只能二选一 |
| 可测 | 低 |

### Option C（选中）：FACS 中间层 + 模型画像
| 维度 | 评估 |
|---|---|
| 复杂度 | 中（多两层 + 每模型一份画像） |
| 换模型 | ✅ 只写新画像 |
| 叠加 | ✅ 语义化混合（add/max/set） |
| 可测 | ✅ 纯函数，node 可跑 |

## Trade-off Analysis

FACS 的代价是**每个新模型要写一份 profile**（jellyfish 画像约 60 行），
收益是「所有上层逻辑与模型解耦」。2026-11-17 的 LumenAct 接入是决定性验证：
97 段别人家模型（VRM blendshape）的表演，**只写了一张 166→19 的通道映射表就接进来了**，
没改引擎、没改渲染器、没动任何 Cubism 参数名。

另一个代价：**所有权要显式维护**。FACS 层里 `mouthOpen/gazeX/gazeY/headX/headY/headZ/eyeBlink*`
归别的层，profile 直接丢弃它们 —— 这意味着「片段里让嘴张开」不会生效。
这不是 bug，是 ADR 的必然结果；要改就得先改所有权（见 ADR-003 的 Action Item）。

## Consequences

- ✅ 换皮套/加片段不动上层（LumenAct 实测）
- ✅ 60fps 下纯函数采样（0.0089ms/帧）
- ✅ 缺参数降级可报告（`describeCoverage`）
- ⚠️ **fade 必须朝中性淡，不能朝 0**：`eyeOpen` 中性是 1，朝 0 淡出会「闭眼」（实测踩到）
- ⚠️ **所有权没有运行期护栏**（架构总览 风险 3）
- 🔁 要复查：新增通道时先问「归谁」，再决定进 FACS 还是进别的层

## Action Items

1. [x] FACS/mixer/profile 三层落地 + 单测（perf-engine-test 87 断言）
2. [x] `EXTERNALLY_OWNED` 显式化 + LumenAct 片段测试断言「头/视线/眨眼/张嘴被正确丢弃」
3. [ ] 加**运行期所有权冲突探针**（按帧统计谁写了哪个参数）
4. [ ] 产品决定：不说话时是否允许片段驱动 `mouthOpen`（需改 `EXTERNALLY_OWNED` 语义）
