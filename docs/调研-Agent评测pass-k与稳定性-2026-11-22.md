# 调研：Agent 评测的 pass^k 与稳定性（flaky 归因/隔离）

> 对象：`<project-root>` 的门禁、真机评测 10 条、深度评测 15 条、场景评测 5 条 pass^3。
> 日期：2026-11-22。方法：论文（arXiv/DOI）+ 开源实现（仓库文件/行号）+ 本项目 `_probe/` 代码。
> 只写实际核到的内容；核不到的单列在文末。

## 结论先行

1. 「稳定通过」应定义成 **pass^k**：同一任务跑 n 次、其中 c 次成功，用无偏估计 `C(c,k)/C(n,k)` 估「k 次独立试验全成功」的概率；τ-bench 用 pass^8 暴露了「平均 61% 但 pass^8 <25%」的稳定性塌陷，我们的 5 场景 pass^3 至少要跑到 **n=8** 才有分辨率（n=5 时 pass^3 只能取 0.1/0.4/1.0 三个值）。
2. flaky 的正确用法是「分类与隔离」，不是「重跑直到过」：Google 把「同一份代码既通过又失败」定义为 flaky，全量 corpus 的 flake rate 约 **1.5%**；重跑只用于确认 flaky，高 flake 测试隔离并开 bug，绝不能让重跑把门禁的红变成绿。
3. 单机可行的稳定性工程 = **固定环境**（时钟/时区/DPI/窗口/数据目录）+ **外部 IO 录制回放**（StableToolBench 的 virtual API server 思路）+ **每用例 n 次** + **失败轨迹首分歧定位**；不需要分布式、不需要云沙箱。

## 证据

### 1. pass^k 的定义与业界数字

- τ-bench（2024）的定义（《τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains》arXiv:2406.12045，§3 / Pass^k metric）：
  - `pass^k = E_task[ C(c,k) / C(n,k) ]`，其中 c 是 n 次试验中的成功次数；这是「k 次独立试验全成功」的无偏估计。
  - 对照 `pass@k = 1 - E_task[ C(n-c,k) / C(n,k) ]`，后者是「至少一次成功」，会高估稳定性。
  - 论文原话：pass^k 衡量 agent 在 k 次 i.i.d. trials 上的一致性与鲁棒性。
- τ-bench 的实验设置：主结果（Table 2）**每任务至少 3 次**；agent temperature 0.0，user simulator temperature 1.0；可靠性曲线报 **pass^8**（因此该曲线至少 8 次）。结果：gpt-4o 函数调用在 τ-retail pass^1 = 61.2%、τ-airline = 35.2%，但 **pass^8 在 retail 降到 <25%**（Abstract / §5.1）。
- 这说明「平均成功率」和「每次都成」是两件事；我们的 5 场景如果只跑 3 次全过，只能说明「这 3 次没翻车」，不能说明 pass^3 的置信区间。
- **WebArena（2023，arXiv:2307.13854）与 AgentBench（2023，arXiv:2308.03688）**：本次未核到它们定义 pass^k 或 flaky 处理；可核到的是 WebArena 的任务顺序/rate limit 会污染结果（见下条 AI Agents That Matter 的复现），AgentBench 的贡献是统一多环境评测，而不是稳定性指标。本文不把它们当作 pass^k 的来源。

### 2. 评测方差、成本与顺序依赖

- **AI Agents That Matter（2024，arXiv:2407.01502）**：
  - 很多 agent 评测只报单次准确率、没有 error bar；作者复现时跑 **5 次**，发现「已发表的分数高于我们 5 次的最高值」或「基线低于我们 5 次的最低值」并不少见。
  - 他们用 **Student's t 分布** 给 5 次运行算 **95% 置信区间**，并同时报 accuracy 与 dollar cost，做 cost-controlled Pareto。
  - 他们还指出评测的**任务顺序**可能影响结果：WebArena 的 Reddit clone 对发帖有 rate limit，Reddit 相关任务连续跑会互相影响。→ 单机评测也要防「前一个用例污染后一个」。
- **OSWorld（2024，arXiv:2404.07972）**：
  - 每个任务从 **VM snapshot** 恢复完整状态（§2.2.1：Coordinator 用配置文件指定 snapshot，初始化任务状态）；这是「环境快照」的强证据。
  - 人类在同类任务上的成功率波动 **<5%**，而 agent 的方差显著更高（§5）。→ 稳定性差主要是 agent 侧，不是任务侧。
- **SWE-bench（2023，arXiv:2310.06770）**：
  - 每个任务有 `FAIL_TO_PASS` 与 `PASS_TO_PASS` 两组测试；判定是「两组里的所有测试都必须 pass」，任何一个 missing 或 non-pass 都算 fail（Appendix A.4）。
  - 它把测试结果缓存成 `FAIL_TO_FAIL / FAIL_TO_PASS / PASS_TO_FAIL / PASS_TO_PASS`，避免评测时重复跑（Appendix A.3）。→ 这是「结果快照」而非「重跑」的思路。
- **StableToolBench（2024，arXiv:2403.07714）**：
  - 真实 API 不稳定会让评测不可复现；它提出 **virtual API server**：缓存 + API simulator 互补，配合 stable evaluation system（solvable pass / win rates）。
  - 这是「录制回放」在 agent 工具评测里的直接先例：把外部依赖冻结成可重放的响应，而不是每次真打。
- **AgentBoard（2024，arXiv:2401.13178）**：
  - 只报最终成功率「reveals few insights during the process」；它提出 **progress rate**，给多轮任务的部分进展打分。
  - 用途：失败时能定位「卡在第几步」，而不是只有一个 0/1。→ 这是 flaky 归因的现成指标形态。

### 3. flaky 的定义、根因与治理

- **定义（Google，2016）**：flaky = 「同一份代码既产生 passing 又产生 failing 的结果」；Google 全量 corpus 的 flake rate 约 **1.5%**。他们的做法：
  - 重跑机制**只用于被标记为 flaky 的测试**，或用户显式请求；
  - 高 flake 测试自动 **quarantine**（移出关键路径 + 开 bug），但文章也警告 quarantine 可能掩盖真实 race condition；
  - 1.5% 的 flake rate 在大型发布里仍意味着「15 个测试可能失败」，需要 build cop 调查。
  - 来源：`https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html`。
- **UI flaky 的根因分类（Romano et al., ICSE 2021，arXiv:2103.02669 / DOI 10.1109/ICSE43902.2021.00141）**：分析了 62 个项目、235 个 flaky UI 测试样本，根因包括：
  - Async Wait：Network Resource Loading、Resource Rendering、**Animation Timing Issue**；
  - Environment：Platform Issue、Layout Difference；
  - Test Runner API Issue：Incorrect Test Runner Interaction、DOM Selector Issue；
  - Test Script Logic：Incorrect Resource Load Order、**Time**、**Test Order Dependency**、**Randomness**。
  - 修复策略包括：Add/Increase Delay、**Fix Waiting Mechanism**、Fix Incorrect API Access、Change Library Version、Refactor Test Checks、**Disable Features During Testing（Disable Animations）**、Remove/Mark/Blacklist Tests。
  - 这几乎逐条对应我们的 Electron + Live2D 评测：动画、布局/DPI、等待时机、用例顺序、时间。
- **经典 flaky 分类**：Luo et al., FSE 2014，DOI `10.1145/2635868.2635920`。本文只把它作为「flaky 是系统性工程问题、不是单次运气」的经典出处；未逐条核对其类别表，因此不复述具体类别。
- **LLM 本身不是确定性的**：Thinking Machines Lab（2025-09-10，`https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/`）指出，即使 temperature=0，推理也**不是 batch-invariant**：同一个请求的输出会随 batch size 变化（RMSNorm / matmul / attention 的归约顺序不同）。所以「固定 seed + temperature 0」不足以保证 bitwise 复现；要稳定，只能录制回放或接受分布并跑 n 次。
- **Inspect AI 已经把 pass^k 做成 reducer**：`UKGovernmentBEIS/inspect_ai` 的 `src/inspect_ai/scorer/_reducer/reducer.py` 第 215–250 行 `pass_k(k, ...)`，实现就是 `math.comb(correct, k) / math.comb(total, k)`；`src/inspect_ai/_eval/task/epochs.py` 用 `epochs` 重复样本、用 reducer 聚合。可以直接借这个口径，不需要自己推公式。
- **pytest-rerunfailures 的定位**：PyPI 16.7 的 summary 是「re-run tests to eliminate flaky failures」。它能减少红色，但也会把 flaky 藏起来；适合本地排查，不适合作为门禁的「通过」依据。

### 4. 本项目现状（代码级）

- **场景评测是「全过门禁」，不是 pass^k 指标。** `_probe/scenario-eval.cjs`：
  - `RUNS = Math.max(1, Number(argValue('--runs', 3)) || 3)`（第 44 行），默认每条场景跑 3 次；
  - 判据是「每条场景 runs 次全过才算过；全部场景通过才 exit 0」（文件头第 14 行）；
  - 结果只输出每条 `runs / passed / failed / avg_ms / max_ms`（第 445–460 行），没有 pass^1 / pass^3 / 置信区间；
  - 5 条场景（memory / quiet / interrupt / budget / failure）× 3 次 = 15 次，全部通过即 `15/15`（`docs/HANDOFF-2026-11-21.md:80`）。
  - 它**不真调 LLM/TTS**（文件头第 18–27 行）：记忆场景用 fake callLLM，静默/抢话/预算/失败恢复都是脚本化。→ 它测的是「编排逻辑稳定」，不是「模型行为稳定」。
  - 数据隔离已经做了：`PET_DATA_ROOT` / `PET_JOURNAL_DIR` / `PET_TELEMETRY_DIR` 指向 `mkdtemp`（文件头第 25–27 行），不写真实记录室。
- **真机评测已经有 flake 案例。** `docs/HANDOFF-2026-11-21.md:22`：深度评测严格档 10 PASS / 0 FAIL、p95 约 24s；`window_move_size flake 已修`。`docs/审计-系统性回归-2026-11-21.md` 记录了 `window_move_size` 修前 FAIL、修后 PASS（窗口最大化/贴边时 `ok:true` 但矩形不动）。
- **门禁里已经挂了场景评测**：`_probe/gate-units.mjs:139-140`，`tier: 'core'`，`timeoutMs: 180000`，`parallelSafe: false`。→ 单机串行，跑 40 次也不会并发打架；成本主要是墙钟时间。
- **缺口**：没有 flaky registry、没有每用例 n 次的分解、没有失败轨迹的首分歧、没有「重跑只分类」的策略。当前 `15/15` 是一个门禁结论，不能回答「哪条场景在 8 次里会翻几次」。

## 我们能落地的

| 改动 | 收益 | 代价 / 风险 | 优先级 |
|---|---|---|---|
| 场景评测改为 `--runs 8`，输出每条场景的 `pass^1`、`pass^3`、`pass^8` 与 95% CI；「8 次全过」仍作为门禁，但不再把 `15/15` 叫 pass^3 | 真正能量出稳定性；n=8 时 pass^3 例如 6/7/8 次成功分别为 0.357/0.625/1.0，而 n=5 只有 0.1/0.4/1.0 三档 | 5 场景 × 8 = 40 次；场景是脚本化、不调 LLM，墙钟成本低（当前 15 次在 180s 超时内）；CI 计算要写几行 | P0 |
| 定义 flaky：同一用例在 n 次里 `0 < c < n`；单独记 `flake_rate = flaky_cases / total_cases` | 把「不稳定」从「失败」里拆出来；门禁红/绿不再被重跑掩盖 | 需要每个用例的 n 次结果，不能只看汇总 | P0 |
| 门禁只跑 n=1（快速反馈），夜间跑 n=8（稳定性）；门禁失败时**不自动重跑**，只提示「请跑夜间 pass^k」 | 门禁快、夜间准；避免「重跑直到过」 | 需要夜间任务与结果看板；单机要排队 | P0 |
| 外部 IO 录制回放：LLM 响应、工具结果、网络请求；时间/随机数用固定种子或 fake clock；门禁用 cassette 回放，夜间真跑 | 消除模型/网络抖动；失败可复现；对应 StableToolBench 的 virtual API server | 一次性工程：cassette 格式、命中率、脱敏、过期策略；录制文件可能很大 | P0 |
| 固定环境：临时 `PET_DATA_ROOT`（已有）+ Electron `app.setPath('userData', temp)` + 固定 TZ/locale + `--force-device-scale-factor=1` + 固定窗口尺寸/位置 + 启动前杀残留进程 | 消除「上一个用例污染下一个」、DPI/时区/窗口布局差异；对应 OSWorld 的 snapshot 思路 | 需要改启动参数；`--force-device-scale-factor=1` 会改变真实 DPI 场景，需单独跑一组「真实 DPI」 | P1 |
| 每次运行落 JSONL 轨迹：step、prompt hash、tool 名/参数/结果、截图、耗时、异常；失败时与最近一次 PASS 轨迹做**首分歧** diff | flaky 归因从「猜」变成「看」；能区分模型随机、工具超时、UI 等待、状态泄漏 | 存储与脱敏；建议只保留最近 N 次；截图体积大 | P1 |
| 每个场景定义 3–5 个里程碑，按 AgentBoard 的 progress rate 记「走到第几步」 | 失败定位更细；能区分「能力不足」与「偶发卡住」 | 需要按场景写检查点；会增加断言维护 | P1 |
| UI 类用例：测试时禁用动画/毛玻璃，等待条件而不是 `sleep`；对应 UI flaky 论文的「Disable Animations」「Fix Waiting Mechanism」 | 直接消灭动画时序、渲染时序类 flaky | 需要测试模式开关；可能掩盖真实动画 bug，需另设一组「开动画」的冒烟 | P1 |
| 夜间跑一次随机顺序（或 `pytest-randomly` 风格 shuffle），门禁保持固定顺序 | 暴露 test order dependency；对应 UI flaky 的「Test Order Dependency」 | 随机顺序失败不阻塞门禁，只进 flaky registry | P1 |
| 重跑只用于分类：`pytest-rerunfailures` / 自定义 rerun 不计入通过率；重跑结果写 `flaky.json` | 保留诊断价值，不污染 pass^k | 需要改 runner 的计数口径 | P1 |
| 记录模型版本、provider、temperature、seed、system prompt hash | 模型升级导致的「行为漂移」可归因；否则 flaky 无法复现 | 低；只要在每次 run 的元数据里加字段 | P1 |
| 每提交跑 canary（3 条 × 5 次），夜间跑全量（10/15/5 × 8 次） | 单机也能兼顾反馈速度与统计置信 | 需要一套调度；夜间约 30–60 分钟（按 p95 24s/条估算） | P2 |
| 设 flake budget（参考 Google 1.5%），超阈值自动开 issue/隔离 | 防止 flaky 慢慢腐蚀门禁可信度 | 需要看板与 owner；阈值要按我们的用例数调 | P2 |

### 成本估算（单机）

- 场景评测：5 条 × 8 次 = 40 次；当前脚本不调 LLM/TTS，单次通常秒级，40 次在几分钟内；`timeoutMs: 180000` 是单条上限，不是总时长。
- 真机 10 条 × 8 次：按 p95 24s/条，约 32 分钟；深度 15 条 × 8 次约 48 分钟。夜间串行可接受；不要与用户使用时段重叠。
- 如果只做 pass^3 而不做 pass^8，n=8 仍然必要；因为 n=5 的 pass^3 估计太粗（0.1/0.4/1.0）。

### 统计口径建议

- `pass^1`：所有用例的成功率，按用例平均；给 Wilson 95% 区间。
- `pass^k`：按 τ-bench 的 `C(c,k)/C(n,k)`，先按用例算，再对用例取平均；区间用 bootstrap（对用例重采样）。
- `flake_rate`：`0 < c < n` 的用例数 / 总用例数；与 pass^k 分开报，避免「稳定但低能力」和「高能力但不稳定」混在一起。
- 不要报「重跑后通过率」；要报「原始 n 次」和「其中重跑分类结果」。

## 明确不适用（以及为什么）

- **OSWorld 式每任务云 VM 快照。** 我们是单机桌面应用，起 VM 的成本和复杂度不划算；用「临时 userData + 数据目录 + 固定环境变量」做轻量快照即可。
- **分布式并行评测。** 单机、单用户、UI 独占；并行会引入窗口焦点/DPI/端口的互相污染。保持串行，用夜间时间换吞吐。
- **失败重跑 3 次，只要有一次过就算过。** 这正是 Google 警告的「把 flaky 藏起来」；会把 pass^1 虚高，也会掩盖真实 race condition。
- **只固定 temperature=0 和 seed。** Thinking Machines 已证明 LLM 推理不是 batch-invariant；同一请求的输出会随 batch size 变。要可复现就录制回放，要统计就跑 n 次。
- **把 pass@k 当稳定性。** pass@k 是「至少一次成功」，k 越大越乐观；稳定性必须用 pass^k。
- **n=100 的大规模重复。** 单机成本过高；n=8 已能估 pass^3，n=8 也是 τ-bench 报 pass^8 的量级。先用 n=8，等有明确需要再扩。
- **把场景评测的 `15/15` 当作模型稳定性证据。** 它不调 LLM/TTS，测的是编排逻辑；模型稳定性要靠真机 10/15 条与真实 LLM 的 n 次运行。

## 未核实 / 失败项

- τ-bench 论文主表写「至少 3 次」，pass^8 曲线需要至少 8 次；论文没有在正文明确写「每条任务 8 次」的同一句，本文按「pass^8 至少 8 次」推断，未把它写成论文原话。
- Inspect AI 的 `pass_k` reducer 已核到源码；但其 `epochs` 与 `reducer` 的完整组合行为未逐行跑通，只作为口径参考。
- `pytest-randomly` 的 PyPI 元数据抓取时遇到编码问题，未核到版本号；本文只把它当「顺序随机化」的工具名，不作为版本依赖。
- 本项目「门禁 141 项」来自任务描述；`docs/审计-为什么性能问题没暴露-2026-11-21.md` 当时写的是 121 项，`docs/审计-系统性回归-2026-11-21.md` 写的是 91/91。数量随轮次变化，本文不把 141 当固定事实。
