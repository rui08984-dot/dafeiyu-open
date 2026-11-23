# 调研：Pi 与 OpenCode V2 的智能体框架设计（2026-11-20）

> 目的：给「大肥鱼」自建 `mind-kernel` / `dispatch` 提供可抄的机制与明确否掉的方案。
> 方法：`--depth 1` 克隆源码后逐文件阅读；**所有结论以源码行号为准，README 只作辅助**。
> 约束：未安装依赖、未运行两家 CLI/任务、未改动生产代码。

## 0. 两个仓库的身份

| 项 | OpenCode | Pi |
|---|---|---|
| 仓库 | https://github.com/anomalyco/opencode （旧地址 `sst/opencode` 301 到此） | https://github.com/earendil-works/pi （旧地址 `badlogic/pi-mono` 301 到此） |
| HEAD | `c98608c513c80558741bb7d56eb8ce14d4e58aa8` | `edfe6b2ef32283d31efc9e26db86fe48be19d3b2` |
| 提交时间 | 2026-11-20 02:57:26 +0000 | 2026-11-20 00:06:00 +0100 |
| License | MIT（`LICENSE`：Copyright (c) 2025 opencode） | MIT（`LICENSE`：Copyright (c) 2025 **Mario Zechner**，确认是 pi-mono 本体） |
| 语言栈 | TypeScript + Bun + Effect-TS（`packages/core/src/permission.ts:4` 引 `effect`） | TypeScript + Node（`packages/coding-agent/package.json:44-45` 依赖 `pi-agent-core`/`pi-ai`） |
| 版本 | `package.json` 2.3.0；最新 release **v2.3.2**（2026-11-18） | 各包 **1.5.2**（根 `package.json` 的 0.0.3 是私有根壳） |
| 是否 V2 | **是**。`CHANGELOG.md:3` 原文「Release notes for OpenCode V2」；`CHANGELOG.md:5` 起为 v2.x | 不是 V2 概念；主线是 1.x，另有实验包 `pi-durable` |

> 说明：两个旧地址的 301 是 GitHub 改名/转移后的正常重定向。Pi 的 `LICENSE` 署名与包名（`pi-ai`/`pi-agent-core`/`pi-coding-agent`/`pi-tui`）与 pi-mono 完全一致，不是同名仿仓。

## 1. 目标 / 计划：有没有 goal / todo / plan mode

### Pi：**没有**（核心明确不做）

- 全仓 `grep -rni "todo|plan mode|planMode" packages/agent/src packages/coding-agent/src` **零命中**；`grep -rni "goal"` 只命中压缩摘要模板里的 `## Goal` 文案（`packages/coding-agent/src/core/compaction/compaction.ts:511`、`:550`），不是状态机。
- 内置工具只有 8 个：`read`/`bash`/`powershell`/`edit`/`write`/`grep`/`find`/`ls`（`packages/coding-agent/src/core/tools/index.ts:95`），没有 todo 工具。
- 作者在 `README.md:19` 明说「skips features like sub-agents and plan mode」——这句只作辅助，主证据是上面的零命中。
- 但 Pi 在**循环层留了三个挂点**，允许扩展自己实现目标/计划，宿主不内置状态机：
  - `finishTurn`：每轮工具结果写完后调用，返回 `{action:"continue"}` 可强制再跑一轮（`packages/agent/src/types.ts:147`、`:264`；执行点 `packages/agent/src/agent-loop.ts:295-307`）。
  - `getSteeringMessages`：工具调用结束后、下一轮请求前取「纠偏消息」（`packages/agent/src/types.ts:293`）。
  - `getFollowUpMessages`：代理即将停止时取「追加任务」，有则继续（`packages/agent/src/types.ts:306`；执行点 `packages/agent/src/agent-loop.ts:311-317`）。

**结论**：Pi 把「目标/计划」当应用层的事，内核只提供 turn 调度与三个钩子。要 goal 得自己写扩展。

### OpenCode：**有，且是三种不同东西**

1. **Goal（真正的目标状态机，插件形态，默认加载）**
   - 状态：`active | paused | complete`；字段含 `objective`、`rounds`、`maxRounds`、`stalls`、`boot`、`updatedAt`（`packages/schema/src/goal.ts:6-25`）。
   - 默认常量：`MAX_OBJECTIVE=4000`、`MAX_ROUNDS=50`、`MAX_STALLS=3`、`WAIT_LIMIT=30min`（`packages/core/src/plugin/goal.ts:15-19`）。
   - **谁推进**：宿主。会话将要 idle 时触发 `experimental.idle` 钩子（`packages/core/src/plugin/goal.ts:209-220`），宿主另发一次**独立裁判请求**（`ctx.session.generate`，`:123`），裁判返回 JSON verdict `done|continue|blocked|paused|wait`（`:30-36`）。
   - 裁判请求**不写历史**：`SessionGenerate.generate` 的注释与实现明确「without mutating history」，只 `preview` 历史并把 prompt 追加在末尾（`packages/core/src/session/generate.ts:30-33`、`:48`、`:65`）。
   - 继续方式：宿主写一条 `synthetic` 消息（`source:"goal"`, `goalID`）当作下一轮输入（`packages/core/src/plugin/goal.ts:196-206`）。
   - 熔断：轮次上限暂停（`:158-159`）；连续 3 轮无进展（无工具调用或理由与上轮相同）暂停（`:188-191`）；服务端进程重启后 `boot` 不匹配 → 一律暂停、不自动续跑（`:63-69`、`:146-147`、`:322-341`）；等后台工作 30 分钟无活动 → 暂停（`:240-264`）。
   - 它就在默认加载的内置插件列表 `pre` 里：`packages/core/src/plugin/internal.ts:264`（`pre` 由 `resolve(pre)` 无条件装配，`:336`）。
2. **Plan mode（不是一个独立模式，而是一个受限 agent）**
   - `plan` agent 的权限规则：`question` 全允许、`edit:*` 全拒、只允许写 `~/.opencode/plan/*`（`packages/core/src/plugin/plan.ts:38-40`）。
   - 进入/退出靠注入 `<system-update>` 文本，上下文钩子每请求校正一次，防止压缩后提醒丢失（`packages/core/src/plugin/plan.ts:14-25`、`:57-73`）。
3. **Todo（有工具，但默认关闭）**
   - 工具名 `todowrite`，输入 `todos[{content,status}]`，状态 `pending|in_progress|completed|cancelled`（`packages/core/src/tool/plugin/todo.ts:12`、`:15-19`）。
   - 由 flag 门控：`if (!enabled()) return`（`packages/core/src/tool/plugin/todo.ts:52`、`:56`）；`todo` 是 `optInOnly`，**所有构建默认关**（`packages/schema/src/config/flag.ts:11`、`:30`）。
   - 它是「模型自维护的清单」，不是宿主状态机；关掉不影响 agent 运行。

**结论**：OpenCode 把「目标」交给宿主+裁判 LLM（可审计、可熔断），把「计划」降级为一个受限 agent，把「todo」降级为默认关闭的模型自助工具。三层职责分明，值得直接照搬。

## 2. 审批 / 权限

### Pi：**核心没有权限系统**

- `grep -rni "permission" packages/agent/src packages/coding-agent/src` 只命中：注释里提到「permission checks」、`auth-storage` 的 EPERM、`ansi.ts` 的 MIT 声明、以及扩展 UI 的对话框分类 `kind:"permission"`（`packages/coding-agent/src/modes/interactive/interactive-mode.ts:2911`）。**没有 permission mode 枚举、没有规则表、没有审批队列。**
- 真正的闸门只有一个：扩展的 `tool_call` 处理器可以返回 `{block:true, reason}`，内核把它变成错误工具结果（`packages/agent/src/types.ts:66-74`；`packages/agent/src/agent-loop.ts:754-764`；扩展侧 `packages/coding-agent/src/core/agent-session.ts:723-746`）。
- 无 UI 时（RPC 模式）：扩展的确认框通过 `extension_ui_request/response` 走 JSONL；`confirm` 的取消默认值是 **false**（`packages/coding-agent/src/modes/rpc/rpc-types.ts:253-254`；`packages/coding-agent/src/modes/rpc/rpc-mode.ts:147-151`）。也就是说「没人应答」时，**那一个扩展**会拿到 false；但核心工具不会被拦。
- 另有一个「项目信任」：只决定是否加载项目内扩展/配置，不是逐动作审批（`packages/coding-agent/src/core/project-trust.ts:25-35`）。

**结论**：Pi 是「默认全放行 + 需要就装扩展」。它的安全模型是**可组合**而非**默认安全**。

### OpenCode：**完整的三态规则表**

- 枚举：`Effect = "allow" | "deny" | "ask"`（`packages/schema/src/permission.ts:56`）；规则 `{action, resource, effect}`（`packages/schema/src/permission.ts:60-66`），资源匹配走通配符（`packages/core/src/util/wildcard.ts:4`）。
- 求值：`evaluate` 取**最后一条匹配**（`findLast`）；一条都不匹配时默认 `{effect:"ask"}`（`packages/core/src/permission.ts:102-115`）。
- 组合：`agent.permissions` 在前、`session.permissions` 在后，后者覆盖前者；agent 没有规则时用 `[{action:"*",resource:"*",effect:"deny"}]`——**fail-closed**（`packages/core/src/permission.ts:20`、`:186-191`）。
- 聚合：多个资源中任一 `ask` 即整体 `ask`；任一 `deny` 直接拒绝（`packages/core/src/permission.ts:193-195`、`:212-217`）。
- 无 UI / 无人值守：`Unattended` 上下文给一组兜底规则；若仍不能全部 allow，则**转为 deny**，文案「Permission … needs approval, and nobody is present to give it」（`packages/core/src/permission.ts:63-65`、`:227-237`）。
- 审批请求协议：
  - 请求对象 `{id:"per_*", sessionID, action, resources[], save?, metadata?, source?, message?}`（`packages/schema/src/permission.ts:24-40`）。
  - 事件 `permission.asked` / `permission.replied`（`packages/schema/src/permission.ts:45-52`）。
  - 回复枚举 `"once" | "always" | "reject"`（`packages/schema/src/permission.ts:42`）。
  - `assert` 会 `Deferred.await` 阻塞工具执行直到有人回复（`packages/core/src/permission.ts:284-316`）；服务关闭时 pending 全部按 `reject` 失败（`:161-173`、`:262-265`）。
- `always` 的语义：把 `request.save` 里的资源写进项目级持久规则（`packages/core/src/permission.ts:369-375`；`packages/core/src/permission/saved.ts:43-58`），并唤醒同会话中因此变为 allow 的其他 pending（`:380-392`）。
- `reject` 的语义：**可带 feedback**，变成 `CorrectedError` 回灌给模型；同一 `messageID` 的并行请求一起被拒，反馈对整批生效（`packages/core/src/permission.ts:345-366`）。
- 拒绝不会被工具吞掉：`Permission.DeclinedError` 以 defect 隧道穿透，在 `SessionModelRequest.executeTool` 处才转成失败，避免模型把「用户说不」当成普通工具输出（`packages/core/src/session/model-request.ts:441-459`）。

**结论**：OpenCode 的权限模型可以直接当我们的「动作闸门」参考：三态+最后匹配+默认 ask+无人值守 deny+拒绝带反馈+always 落盘。

## 3. 会话 / 上下文

### Pi：**追加式 JSONL 树 + 压缩条目**

- 会话被明确设计为「append-only trees stored in JSONL files」（`packages/coding-agent/src/core/session-manager.ts:985`）；每条 entry 有 `id` 与 `parentId`，写盘就是 `appendFileSync(JSON.stringify(entry)+"\n")`（`:57-60`、`:1195`）。
- entry 类型：`message`、`thinking_level_change`、`model_change`、`usage`、`compaction`、`branch_summary`、`custom`、`label`、`session_info`、`custom_message`、`context_edit`（`packages/coding-agent/src/core/session-manager.ts:65-183`）。
- 压缩条目：`{summary, firstKeptEntryId, tokensBefore, details?, usage?}`（`packages/coding-agent/src/core/session-manager.ts:92-105`），并额外记录 `readFiles/modifiedFiles`（`packages/coding-agent/src/core/compaction/compaction.ts:50-53`）。
- 触发：按模型 `contextWindow` 的比例判断（`packages/coding-agent/src/core/agent-session.ts:831-849`）；压缩逻辑是纯函数，I/O 由 session manager 负责，压缩后重载会话（`packages/coding-agent/src/core/compaction/compaction.ts:1-6`）。
- Resume：CLI 支持 `--continue/-c`、`--resume/-r`、`--session <path|id>`、`--fork`（`packages/coding-agent/src/cli/args.ts:111-114`、`:308-314`）；树导航/分支由 `parentId` 支撑。
- 回滚：没有文件快照回滚；`branch_summary` 只做「换分支时的摘要」。

### OpenCode：**父子会话 + 快照回滚 + 崩溃续跑**

- 会话有 `parentID`（子会话即子代理）与 `fork` 边界（`packages/schema/src/session.ts:32-44`）。
- Resume：执行权用「claim」表示，落库字段 `time_suspended`、`resume_attempts`；进程重启后未完成的 turn 会被重新认领并续跑（`packages/core/src/session/store.ts:89-96`、`:258-297`；`packages/core/src/session/execution.ts:26`、`:79-96`）。
- 压缩：`{auto, buffer, keep, background}`；默认 `auto:true, keep:15000, background:true`（`packages/core/src/session/compaction.ts:44-48`、`:266`）；预留 `RESERVE_SHARE=0.15`、`RESERVE_MIN=16_000`（`:126`、`:132`、`:1151-1160`）。
- 压缩产物：`text` 摘要 + `metadata.keepID` 指向「逐字保留的最近一段」；另有 native 压缩的替换窗口（`packages/core/src/session/compaction.ts:84-92`、`:538-540`）。
- 回滚：`SessionRevert.stage` 先捕获当前快照，再按消息边界恢复文件，并计算 diff（`packages/core/src/session/revert.ts:22-64`）；快照是内容寻址的目录树，`capture()` 返回树 ID（`packages/core/src/snapshot.ts:40-49`）。
- 输入通道：`Delivery = "steer" | "queue"`，默认 `steer`（`packages/schema/src/session-inbox.ts:11`；`packages/core/src/session/prompt.ts:52`），支持 `user/synthetic/compaction/move` 四类 inbox item（`packages/schema/src/session-inbox.ts:50-64`）。

## 4. 工具执行契约

### Pi

- 工具定义：`AgentTool { name, label, description, parameters(JSON Schema/TypeBox), outputSchema?, prepareArguments?, execute(toolCallId, params, signal?, onUpdate?), replay?: "never"|"safe", executionMode?: "sequential"|"parallel" }`（`packages/agent/src/types.ts:478-511`）。
- 结果：`{ content: (Text|Image)[], details, structuredContent?, usage?, isError?, terminate? }`——**content 给模型、structuredContent 给程序、details 给 UI**（`packages/agent/src/types.ts:424-446`）。
- 取消：`AbortSignal` 贯穿 prepare/execute/finalize；一旦 aborted，后续调用一律返回错误结果，保证每个 call 都有结果（`packages/agent/src/agent-loop.ts:716-724`、`:623-631`）。
- 超时：内核不设默认超时；bash 工具的 `timeout` 是可选参数且明确「no default timeout」（`packages/coding-agent/src/core/tools/bash.ts:41`）。
- 并发：默认 parallel；任一工具声明 `executionMode:"sequential"` 或全局配置 sequential 时整批串行；并行时结果消息仍按 assistant 源顺序回传（`packages/agent/src/agent-loop.ts:524-532`、`:646-659`）。
- 错误分类：模型侧 `stopReason = pending|stop|length|toolUse|error|aborted|deferred`（`packages/ai/src/types.ts:497`）；工具错误用 `isError:true` 表达而不是抛异常（`packages/agent/src/types.ts:436-440`）。
- 截断保护：`stopReason==="length"` 时，整条消息里的所有工具调用**全部判失败**，不执行可能被截断的参数（`packages/agent/src/agent-loop.ts:272-279`、`:488-512`）。
- 工具互调也走同一管道：`runToolCall` 复用参数准备、校验、`beforeToolCall`、执行、`afterToolCall`，因此权限检查对嵌套调用同样生效（`packages/agent/src/agent-loop.ts:804-822`）。

### OpenCode

- 工具定义：`Tool.Info { name, input(schema), output?, description, execute(input, ctx) => Effect<Result, Tool.Error> }`（`packages/schema/src/tool.ts:114-128`）。
- 上下文：`{sessionID, agent, messageID, id, progress(update), cancel?}`——`cancel` 是「用户要求停止」的 effect，工具可主动收尾（`packages/schema/src/tool.ts:26-40`）。
- 结果：`{ output?, content?, metadata? }`；`output` 走声明的 output schema，`content` 给模型，`metadata` 给 UI（`packages/schema/src/tool.ts:107-112`）。
- 执行：先按 schema 解码输入，再执行；**插件抛出的任何非 `Tool.Error` 都会在边界被强制包成 `Tool.Error`**，避免 call 永远不结算（`packages/core/src/tool/runtime.ts:40-76`）。
- 错误分类：`Tool.Error` 是声明契约，`ToolFailure extends Tool.Error` 会被转成 `type:"error"` 的 tool-result 让模型自纠；其它异常视为 defect 终止流（`packages/ai/src/schema/errors.ts:236-246`）。
- 超时：内核无统一超时，按工具自带（shell 超时后转后台、webfetch 有默认与上限）（`packages/core/src/tool/plugin/shell.ts:52-60`、`packages/core/src/tool/plugin/webfetch.ts:29-30`）。
- 权限：不是中央前置网关，而是**每个工具自己调 `permission.assert`**（如 todo：`packages/core/src/tool/plugin/todo.ts:64-70`；subagent：`packages/core/src/tool/plugin/subagent.ts:131-138`）。

## 5. 子代理 / 编排

### Pi：**coding-agent 没有；durable 包给了参考实现**

- `packages/coding-agent/package.json:44-45` 只依赖 `pi-agent-core` 与 `pi-ai`，**不依赖 `pi-durable`**；主 CLI 没有 subagent 工具。
- `pi-durable`（实验包）把子代理做成扩展模式，关键设计：
  - 会话可以被 task **拥有**：`ownership:{kind:"task", taskId}`；父任务被 abort/失败会连带子会话（`packages/durable/README.md:882-926`，辅助文档）。
  - 前台子代理：在 `api.commit()` 里创建/复用子会话（`scanConversations({ownerTaskId})`），提交输入后 `wait()`；`replay:"safe"` 保证崩溃重跑复用同一个 child 和 submission（同上）。
  - 后台子代理：子会话挂在 `{background:true}` 的锚点 task 下，父的 Esc/idle 不会波及；后台 reporter task 把答案作为 follow-up 投回父会话；`requestId` 保证重启不重复发送（同上 `:927`）。
  - 任务状态：`pending|running|waiting|sleeping|completing|terminal`（`packages/durable/src/types.ts:689-727`）。
  - 持久化：每次 phase 提交 checkpoint；`harness.resume()` 续跑；同 `requestId` 幂等（`packages/durable/README.md:115-124`，辅助）。
  - 等待：`sleepUntil` / `wait on tasks` / `signals`，等待期间**不占进程**（`packages/durable/src/types.ts:365`；`packages/durable/README.md:142-162`、`:394-420`）。
  - 崩溃熔断：`restartLimit` 默认 5，超过则任务以 `restart_limit` 结束（`packages/durable/README.md:265`，辅助）。

### OpenCode：**内置 subagent，后台优先**

- 工具名 `subagent`，参数 `{agent, description, prompt, model?, sessionID?}`（`packages/core/src/tool/plugin/subagent.ts:30-44`）。
- 语义：**总是后台**——立即返回 `{sessionID, status:"running"}`；子会话每次 idle 会向父会话投一条 `<subagent>` 消息；明确要求父「不要 sleep/poll/重复工作」（`packages/core/src/tool/plugin/subagent.ts:19-28`、`:51-57`）。
- 上下文：新子会话**全新上下文**，需要自带全部背景；传 `sessionID` 可继续同一个子会话，运行中的 follow-up 会并入当前 run（`:51-57`、`:194-207`）。
- 父子关系：`sessions.create({parentID})`；续聊时校验 `existing.parentID === context.sessionID`（`:171-185`、`:151-154`）。
- 深度限制：`experimental.subagent_depth`，默认 **1**（`packages/core/src/session/subagent-depth.ts:14`）。
- 模型继承：`override > agent.model > parent.model`（`packages/core/src/tool/plugin/subagent.ts:171`）。
- 权限：`action:"subagent", resources:[agent.id]`（`:131-138`）。
- 结果回收：子会话的最后一个 assistant 消息文本作为报告，经 `SubagentReport` 投回父会话 inbox（`packages/core/src/session/execution/subagent-report.ts:66-82`）；后台 job 记录 `recovery` 以支持重启后续跑（`packages/core/src/session/subagent-job.ts:20-35`）。

## 6. 对照表（我们现状来自 ADR-011 与 mind-kernel 现有代码）

| 维度 | Pi | OpenCode V2 | 我们现状 | 要不要抄 |
|---|---|---|---|---|
| 目标/计划 | 无；只留 `finishTurn`/steering/follow-up 钩子 | goal 插件（active/paused/complete，独立裁判 LLM，50 轮/3 次停滞/30min 熔断）；plan=受限 agent；todo 默认关 | `mind-kernel` 已有 goal-store（6 态、1 active、重启→paused）+ plan-store（≤8 行、cursor）+ 纯规则 arbiter；**缺「下一步/是否完成」的 LLM 判定** | **抄 OpenCode 的 stop-hook judge**；不抄它的单一 rounds 预算 |
| 审批/权限 | 核心无；扩展 `tool_call` 可 block；RPC 确认默认 false | 三态规则表、最后匹配、默认 ask、无人值守 deny、`once/always/reject`、拒绝带 feedback、always 落盘 | dispatch 有刹车/黑名单，但没有统一 `{action,resource,effect}` 规则与审批队列 | **强抄**（做 mind-kernel 的统一动作闸门） |
| 会话/上下文 | 追加式 JSONL 树（id/parentId）、compaction entry、`--fork` | 父子会话、claim 续跑、压缩 keep 15k+后台预计算、快照 revert | 有 episode/记忆层，但没有「会话树 + 压缩条目 + 回滚边界」的统一结构 | 抄压缩条目与 keepID；快照 revert 只部分抄 |
| 工具契约 | `AgentTool` + 三层结果 + AbortSignal + 嵌套同管道 | `Tool.Info` + progress/cancel + `ToolFailure` 边界强制 | 28 个工具，契约不统一；错误多为字符串 | **抄三层结果与统一 before/after 钩子** |
| 子代理 | 主 CLI 无；durable 包给出 task-owned 模式 | 内置后台 subagent、深度 1、模型继承、完成回报 | DSH 委派是「进程级」，没有会话级子代理/回报协议 | 抄「后台+回报+深度」；durable 的 task-owned 作为长任务参考 |
| 持久化/恢复 | 会话 JSONL；durable 有 phase/checkpoint/sleep/wait/restartLimit | claim + job recovery + snapshot | goal-store 原子写 goals.json；重启 active→paused；无 phase checkpoint | **抄 durable 的 phase/checkpoint 与幂等 requestId** |
| 成本控制 | 由调用方 `convertToLlm`/`transformContext` 自行裁剪 | 压缩阈值+后台预计算；裁判另计 usage | 已有预算三项与熔断；裁判调用尚未有 | 抄「裁判单独计费、不写历史」，预算仍用我们的三项 |

## 7. 可抄清单（8 条）

| # | 机制 | 出处（repo/path:line） | 解决什么 | 我们怎么用 |
|---|---|---|---|---|
| 1 | 三态权限规则表 + 默认 ask + 无人值守 deny | `opencode/packages/core/src/permission.ts:102-115`、`:212-237`；`packages/schema/src/permission.ts:42`、`:56` | 现在闸门散落在 dispatch 各处的 if；统一成可配置、可解释、默认安全的规则 | `mind-kernel` 增加 `permissions: Rule[]`，`evaluate(action,resource)` 用最后匹配；无规则=ask；无人在场=deny。动作至少覆盖 `tool.*`、`dispatch.*`、`fs.write`、`shell` |
| 2 | 拒绝带 feedback + 批量拒绝 | `opencode/packages/core/src/permission.ts:345-366` | 用户说「不」时模型不知道原因，会反复试 | dispatch 的 reject 结果增加 `feedback` 字段，作为工具结果回灌；同一轮并行请求一起拒 |
| 3 | Plan 模式 = 受限 agent（edit 全拒，只允许 plan 目录） | `opencode/packages/core/src/plugin/plan.ts:14-25`、`:38-40`、`:57-73` | 我们不需要再造一个「计划状态机」，只要一个权限不同的档位 | 加 `plan` 档：只读工具 + 只写 `data/plans/*`；进入/退出用 system 消息提醒，压缩后由 context 钩子补回 |
| 4 | stop-hook 目标循环 + 独立裁判（verdict JSON，不写历史） | `opencode/packages/core/src/plugin/goal.ts:30-36`、`:104-136`、`:140-207`；`packages/core/src/session/generate.ts:30-33` | mind-kernel 只有规则 tick，无法判断「这一步做完没、下一步是什么」 | arbiter 在「无工具调用且无待办」时触发一次 judge（独立请求、只读历史、单独计费），返回 `done/continue/blocked/paused/wait`；宿主只信 verdict，不信模型自述 |
| 5 | 熔断三件套：rounds + stalls + boot 变更 | `opencode/packages/core/src/plugin/goal.ts:15-19`、`:146-147`、`:158-159`、`:188-191` | 我们的预算只有用量，没有「原地打转」检测 | goal 增加 `rounds/stalls/boot`：理由与上轮相同或本轮无工具调用 → stall+1；≥3 暂停；进程重启 → 全部 paused |
| 6 | 后台子代理 + `<subagent>` 完成回报 + 深度限制 | `opencode/packages/core/src/tool/plugin/subagent.ts:19-28`、`:51-57`、`:118-126`、`:171-217`；`packages/core/src/session/subagent-depth.ts:14` | dispatch 派长任务后无法「继续干别的、完成再收」 | 给 dispatch 增加 `spawn`：子会话带 `parentID`、立即返回 id、完成时向父会话投一条结构化消息；默认深度 1，模型继承 `override>agent>parent` |
| 7 | 工具统一管道 + 三层结果 | `pi/packages/agent/src/agent-loop.ts:804-822`；`pi/packages/agent/src/types.ts:424-446`、`:478-511` | 28 个工具返回值格式各异，UI/程序/模型混用 | 统一 `{content, structuredContent, details, isError}`；所有工具（含工具内部再调工具）都过 `before/after` 钩子，权限检查不可绕过 |
| 8 | 持久任务 phase/checkpoint + 幂等 requestId + park | `pi/packages/durable/src/types.ts:365`、`:689-727`；`pi/packages/durable/README.md:115-124`、`:142-162`、`:394-420`（辅助） | goal 重启只能 paused，长任务没有「做到哪」的真值 | goal 增加 `phase + checkpoint`；每个子任务提交一次 checkpoint；外部等待用 `sleep/wait` 不占 tick；派发带 `requestId` 防重复副作用；`restartLimit` 防崩溃循环 |

## 8. 明确否掉（6 条）

| # | 方案 | 为什么不抄 |
|---|---|---|
| 1 | Pi 的「核心无权限，靠扩展」 | 默认全放行，安全取决于装了哪个扩展。我们的桌面代理会动键鼠/文件，必须默认 fail-closed；只能借它的 `beforeToolCall` 钩子形态，不借它的策略缺省 |
| 2 | OpenCode 的 Effect-TS 运行时（Context.Service/Layer/Deferred/Fiber） | 类型与运行时绑定极重，我们的插件是纯 JS + 现有事件循环；照搬会把 30s tick 的简单路径变成 Effect 依赖图。只抄它的**语义**（三态、Deferred 式等待、defect 隧道），不抄实现 |
| 3 | Code Mode（把工具折叠成一段 TS 程序执行） | 需要沙箱、类型生成、错误映射，调试成本高；我们的 28 工具是 UI 动作，天然适合逐个调用。OpenCode 自己也只是把它当可选路径 |
| 4 | 用 `todowrite` 这种「模型自维护 todo」当主状态 | OpenCode 自己把它设为 `optInOnly`、所有构建默认关（`flag.ts:11`、`:30`），说明价值不稳定。我们的主状态必须是宿主持有的 goal/plan，todo 最多是展示层 |
| 5 | 单一 `maxRounds=50` 的轮次预算 | 轮次不等于成本，也不等于墙钟；长任务会被 50 轮硬切，短任务又浪费额度。我们继续用 `maxSteps/maxWallMs/maxLlmCalls` 三项真值，rounds 只做停滞辅助 |
| 6 | 用文件快照 revert 当「安全点」 | OpenCode 的快照只覆盖文件；我们的副作用包括 UIA 点击、键鼠、外部应用状态，这些不可回滚。安全点仍用「无未决写 + cursor 边界」，快照只用于文件类任务 |

## 9. 未解 / 需实测

1. **裁判成本与模型档位**：OpenCode 的 judge 用当前 session 的 agent/model（`goal.ts:123` + `generate.ts:46-47`）。我们若每轮都调，成本可能超过执行本身；需实测「只在未推进时调」与「用小模型」两种策略的延迟/命中率。
2. **审批 pending 的超时语义**：`Permission.assert` 是无限等待的 `Deferred`，只有服务关闭才批量 reject（`permission.ts:161-173`）。HTTP 客户端断开/网络超时是否触发关闭，未实测；我们需要显式的 `askTimeoutMs`。
3. **native compaction 协议**：OpenCode 有 `compactNatively` 分支（`compaction.ts:328`），走 provider 侧压缩；具体请求格式未读，暂不抄。
4. **durable 的崩溃循环**：`restartLimit` 的计数与 `task_orphaned` 行为只有文档与类型，未跑过真实崩溃；接入前需在 `_probe` 做一次 kill -9 实验。
5. **Pi 的 session 树与我们的记忆映射**：`parentId` 分支适合「换方案重试」，但我们的 episode 是线性叙事；是否需要把 branch 映射成 `attempt` 字段，需产品确认。
6. **我们 30s tick 与 judge 的节拍叠加**：现有 arbiter 是纯函数、0 LLM；加 judge 后必须保证「无 goal 时 0 调用、有 goal 时每轮最多 1 次」，需在 `mind-kernel/index.js` 加计数器并实测。

## 10. 核查记录

- 克隆：`git clone --depth 1 --single-branch`（经本机代理 `127.0.0.1:2080`，仅本次命令使用，未改全局配置）。
- HEAD 与许可见第 0 节；`LICENSE` 首行均已读。
- 所有 `path:line` 在落笔前用 `sed -n 'Np'` 逐条复核；`grep` 结论附了命令范围。
- 未安装任何依赖；未执行 `opencode` / `pi` 的 CLI 或测试。
- 代码位置：`_research/agent-frameworks/opencode`、`_research/agent-frameworks/pi`（`_research/` 已在 `.gitignore`）。
