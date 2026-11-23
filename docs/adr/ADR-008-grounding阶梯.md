# ADR-008：grounding 策略 —— UIA 优先的四档阶梯，以及「什么时候该升档」

**Status:** Proposed（2026-11-18，待用户拍板）
**Date:** 2026-11-18
**Deciders:** 用户（产品方向）· 本轮调研（技术）
**相关:** ADR-001（`pet-core` 无状态）· ADR-004（视野/成本）· ADR-007（恢复阶梯）· 调研 §3.4

## Context

我们不是在"选择 grounding 路线"，而是**已经有一条能用的阶梯**，问题是它没有明文规则：

| 档 | 机制 | 现状 |
|---|---|---|
| A. UIA 直调 | `uia_action` / `perform_action` / `set_value`（Invoke/Value pattern） | 主力；不动真实鼠标 |
| B. UIA 编号点击 | `snapshot` → `click_element #编号`（编号由常驻 UIA 服务或 Rust 生成） | 主力；实测计算器 4 次点击各 ~0.7s |
| C. SoM 标注图 | `som_snapshot`（UIA+OCR 画框编号）→ `som_click #编号` | 已有；带世代号 `SOM_STATE.seq`、被压缩时画刻度尺 |
| D. 物理坐标 | `click_at x,y` / `post_keys` | 已有；真实鼠标归用户，overlay 画橙色虚拟光标 |

并且已经有**诚实诊断**：`snapshot` 会返回 `scanned`（扫到多少节点）、`shellOnly`（UIA 树是空壳）、
`chromiumWoke`，0 元素时建议 `som_snapshot`；服务失败时区分 `iconic/offscreen`（窗口状态问题，换通道没用）
与其它 error（可能是 PowerShell 的 COM 会话问题，**再试 Rust**）。

缺的是三样：
1. **升档判据**（什么时候放弃 A/B 换 C/D）——现在依赖模型读 `nextIfFailed` 的散文自行判断；
2. **坐标契约**（D 档是裸物理像素；跨 DPI/多显示器无归一化，而我们已经为游戏踩过 DPI 坑）；
3. **元素去重**（同一元素在树上出现两次、OCR 文本与图标框重复编号；`click_element` 的全屏 dHash 误报与此同源）。

外部两条可核验的做法：
- OmniParser `util/utils.py:241 remove_overlap_new`：IoU 用 `max(iou, 覆盖率1, 覆盖率2)`（**不是标准 IoU**），
  且 **OCR 文本落在 icon 框内时并入该 icon 的标签**，避免同一元素被编号两次；坐标支持 ratio 归一化（`get_som_labeled_img`）；
- UI-TARS-desktop `actionParser.ts:92`：坐标按 factor(1000) 归一化 + `scaleFactor` 还原物理像素（DPI 显式建模）。

## Decision

**四档阶梯保留，但把"什么时候升档"写成可执行的判据；坐标统一归一化；每个元素只允许一个编号。**

### 1. 升档判据（满足任一即升，且必须留 evidence）

| 从 → 到 | 触发条件 | 为什么 |
|---|---|---|
| A → B | 目标没有 `Invoke/Value/Toggle` pattern；或直调返回 `not_sent` | 直调不可用 ≠ 元素不可达 |
| B → C | `snapshot` 返回 `scanned = 0` / `shellOnly = true`；或 B 档连续 2 次 `suspected_noop` | 树是空壳（应用没启无障碍）时，编号点击是盲点 |
| C → D | SoM 无匹配元素（OCR 与图标都没抓到）；或 C 档连续 2 次 `suspected_noop` | 视觉语义也失败时只剩坐标 |
| 任意 → A'（回退） | 新窗口/新前台出现，且其 UIA 树 `scanned ≥ 1` | 换窗口后应回到最便宜档，不该"惯性用坐标" |

**反向规则（防止一路滑到 D）**：任何一次成功（`effect=confirmed`）之后，下一次动作必须回到 A/B 档重试——
只有连续失败才允许保持高档。依据：D 档最贵（真实鼠标/DPI 风险/无法验证），不能因为一次成功就"记住"它。

### 2. 坐标契约（消除 DPI 隐患）

- 对外**交付坐标一律归一化**（0–1 或 0–1000，与截图同源），附带 `display_id`（多显示器）与 `scale`；
- 物理像素只在 `pet-core` 内部出现（它就是干这个的）；
- SoM 图被压缩时已有的 `scale` + 刻度尺保留，并升级为契约字段（`delivered/captured` 必填）；
- 依据：UI-TARS 的 `factor + scaleFactor`；我们自己 `som_snapshot` 注释里已记录"图上 1px ≠ 屏幕 1px"的实测踩坑。

### 3. 元素去重与唯一编号

- **同一元素只给一个编号**：OCR 文本框若 ≥80% 落在某个可交互框内，文本并入该框 `name`，不单独编号（OmniParser 规则）；
- **去重度量用 `max(IoU, 覆盖率)`**，因为嵌套框（图标里套文字、按钮里套图标）的标准 IoU 很低，用 IoU 去不掉；
- **编号带世代**：`SOM_STATE.seq` 已有（每次快照递增，旧编号作废）。补一条：新快照里标记"新增元素"（`*`），
  让模型知道界面变了、旧计划该重判（browser-use `bu.state()` 的做法）；
- **禁止跨世代使用编号**：`click_element #3` 必须校验快照世代，世代不符直接返回 `not_sent` + 要求重看。
  依据：`skill-library.js` 的 `REPLAYABLE` 白名单已经把 `click_element/som_click` 排除在技能之外——同一原因的运行时版本。

### 4. 视觉兜底的边界（明确不做的事）

- **不做"每步截图 + VLM 直接出坐标"**（UI-TARS/OSWorld 的端到端路线）：我们的 A 档是**语义调用**（Invoke 直调），
  比猜坐标稳定一个数量级；把它降级成"看图点像素"是能力倒退，且每步增加一次视觉推理成本（ADR-004）。
- **不做 code-as-action**（模型生成 pyautogui/Python 在本机执行，OSWorld 基线与 browser-use 1.0 走的路线）：
  ① **安全面**——那是本机任意代码执行，我们的授权边界是"用户本机、用户身份"，一旦模型写错一行就可能删库；
  OSWorld 敢这么做是因为它在一次性 VM 里跑，我们没有隔离层；
  ② **放弃语义**——裸坐标点击无 pattern、无回读，`verify-contract` 的 L2 直接失效；
  ③ **不可复用**——生成的脚本依赖具体分辨率与窗口位置，换个 DPI 就废（我们已为游戏踩过 DPI 坑）。
- **不做"引入 OmniParser 权重"**：许可分档不明（repo LICENSE 为 CC-BY-4.0、README 写 MIT、旧 Ultralytics 检测器 AGPL），
  且要占显存。只借鉴其合并/去重算法，用我们已有的 RapidOCR + UIA 自研轻量版。

## Options Considered

### Option A（选中）：四档阶梯 + 明文升档判据 + 归一化坐标
| 维度 | 评估 |
|---|---|
| 实现 | 中（判据是规则，不涉及新模型；坐标归一化要动 D 档入口） |
| 覆盖率 | 高（UIA 覆盖标准控件，SoM+OCR 覆盖自绘，坐标兜底） |
| 稳定性 | 高（A/B 档不碰真实鼠标） |
| 成本 | 低（A/B 8–40ms；C 一次截图+OCR；D 最贵但最少用） |

**Pros**：现有能力全部保留，只是把"隐性经验"写成规则；与 ADR-007 的恢复阶梯第 2 档天然对齐（升档=恢复手段之一）。
**Cons**：规则表需要随实测更新（哪个应用在哪个档），否则会变成"看起来有规则"。

### Option B：全线视觉（每步截图 → VLM 出坐标）
| 维度 | 评估 |
|---|---|
| 实现 | 低（一次调用一步） |
| 成本 | 高（每步一次视觉推理；云端按次、本地占显存） |
| 稳定性 | 中低（受主题/DPI/动画影响） |
| 语义 | 无（不知道按钮叫什么，只知道像素） |

**Pros**：一套代码通吃所有应用，最"通用"。
**Cons**：① 放弃 Invoke 直调的确定性；② 与 ADR-004 的视觉成本门控冲突；
③ 无法验证（点了像素，不知道点到了什么）。**否**（仅保留为 C 档的输入来源）。

### Option C：纯 UIA（不做视觉兜底）
| 维度 | 评估 |
|---|---|
| 实现 | 最低 |
| 覆盖率 | 低（自绘/游戏/部分 Electron、微信/QQ 类应用树是空壳） |

**Pros**：最简单、最快、最可验证。
**Cons**：实测已经证明会卡死（`shellOnly` 场景），且我们已有 SoM 代码——删掉是浪费。**否**。

### Option D：引入 OmniParser 全套（YOLO + caption 模型）
| 维度 | 评估 |
|---|---|
| 实现 | 低（有现成 pipeline） |
| 成本 | 显存（YOLO+caption，与游戏抢）；启动慢 |
| 许可 | **不明**（见 Context） |
| 收益 | 图标语义命名（比 OCR 多认"图标是什么意思"） |

**Pros**：对纯图标按钮（无文字）的识别是它唯一不可替代的能力。
**Cons**：许可风险 + 显存成本 + 与 ADR-001「常驻服务只放慢启动模型」的边界冲突。
**暂否**；若将来"纯图标按钮"成为主要失败原因，再单独立项评估权重许可。

## Trade-off Analysis

核心权衡是**「确定性 vs 覆盖面」**。UIA 直调是确定的（有 pattern、有返回值、可回读），
但它只覆盖"愿意暴露无障碍信息的应用"；视觉覆盖面广，但把"点对了没有"变成了概率问题。

选 A 的理由：**我们已经有四档的全部零件**，缺的只是调度规则。而调度规则的价值在失败路径上——
成功路径上四档几乎等价（都能点中），失败路径上"该不该升档"决定了是 2 秒解决还是 30 秒瞎试。

第二个权衡是**坐标归一化要不要现在做**。它不产生新能力，但会在多显示器/高 DPI 下产生**静默错误**
（点在错误的位置，且看起来"发了动作"）。这属于"现在不做，以后要花十倍代价排查"的类型，故列为 Decision 而非 Action Item。

## Consequences

- ✅ 不动 A/B 档实现，只加判据与校验；风险低
- ✅ 坐标归一化让 D 档可跨 DPI 复用（游戏那条 DPI 修复经验可以收敛成一条契约）
- ✅ 元素去重直接缓解两类已知 bug：`click_element` 全屏 dHash 误报、同一元素重复编号
- ⚠️ **升档会变慢**：C 档要截图（~31ms）+ OCR（取决于区域）；连续升档可能让单步从 40ms 变成 300ms+
- ⚠️ **规则表需要维护**：每个新应用可能贡献一条例外。若例外超过 5 条，说明判据设计错了，应回到"用诊断字段驱动"而不是"按应用名硬编码"
- ⚠️ **禁止按应用名特化**（项目铁律）：判据只能读诊断字段（`scanned/shellOnly/pattern`），不能写 `if app == "微信"`
- 🔁 要复查：`region` 参数（历史上"从未生效"）是否随坐标归一化一并修复

## Action Items

1. [ ] 把四档升档判据写成一张表 + 一个纯函数 `decideTier(diagnostics, history)`，可单测
2. [ ] `snapshot`/`som_snapshot` 返回统一诊断字段（`scanned/shellOnly/patterns/elementCount/seq`）
3. [ ] 坐标归一化：D 档入口接受 `{x,y,unit:'normalized'|'physical', display_id}`，物理换算只在 `pet-core`
4. [ ] 元素去重：`max(IoU, coverage)` + OCR-in-box 合并，先做离线对比（同一屏标注结果人工抽查 20 例）
5. [ ] 编号世代校验：跨世代 `click_element` 直接 `not_sent` + 提示重看
6. [ ] 真机验收：3 个自绘/空壳应用（微信、QQ、任一 Electron）点击定位成功率 ≥ 基线 +20%
7. [ ] 规则表的例外计数入 doctor（超过 5 条即告警，触发判据复盘）

---

## 勘误（2026-11-18 · 反编造审计）

- 【更正】原「`SOM_STATE.seq` 已有（每次快照递增，**旧编号作废**）」→ 世代作废只在 `som_click` 落地（`game-control.js:2483-2486`，`stale_som_marks`）；`click_element` **不校验 seq**，只有 hwnd/pid 窗口身份守卫（`:2566-2583`），同一窗口重拍后旧编号仍会被消费。故「click_element 世代校验」确为待补项，与本 ADR Action Item 5 一致，但不应被读成"已经全部作废"。（证据：`_incoming/my-neuro/live-2d/plugins/community/dispatch/game-control.js:2360-2361,2445,2483-2486,2543-2583`）
