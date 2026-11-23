# DSH pet profile 实测报告（2026-11-20）

> 任务：给 DSH 新建隔离的 `pet` profile，叠加 goal / plan / 审批 / ask_user 插件，真机实测，不动 headless/web/desktop/qqbot。
> 结论先说：**pet profile 已建成并可用；headless 零改动。** goal、todo、ask_user、approval 都有确定性实测证据。但“像人一样用”还差一个交互入口/应答器——headless 里这些能力大多是“装好了但没有嘴和耳朵”。

---

## 0. 一句话结论

| 问题 | 结论 |
|---|---|
| pet profile 建成了吗 | ✅ `<user-home>\.dsh\profiles\pet`，bundles = `dsh-base` + `dsh-headless` |
| 叠了哪些插件 | headless 已内置 goal / goal-round-driver / command-goal / plan-mode / commands / tool-goal / tool-todo / user-approval / permission-presets / user-questions；pet 只额外 `insert` 了 `tool-ask-user` |
| goal 实测 | `get_goal` 被调用并返回 `{"goal":null}` |
| todo 实测 | `todo_write` 被调用并返回 `Updated todo list: 1 pending, 0 in progress, 0 completed.` |
| ask_user 实测 | blocking：`Error: no user-questions answerer accepted the request`（NO_PROVIDER）；timed(5s)：返回 `{"pending":true,...}` |
| 审批实测 | `workspace-write + ask` 下升级到 `danger-full-access` 被拒：`requires approval, but no approval channel is available`；切到 `danger-full-access` 后同一无害命令执行成功 |
| permission 枚举 | `read-only` / `workspace-write` / `danger-full-access` 接受；`auto` / `bogus` 拒绝 |
| headless 零回归 | 三个关键文件哈希与备份完全一致，`diff -rq` 为空；`headless --help` 退出 0；`headless + mock` 成功跑完一个任务；`dsh-dispatch.mjs` 仍能建会话并到达 provider |
| 回滚 | `rm -rf "<user-home>/.dsh/profiles/pet"` |

---

## 1. 环境与起点

- DSH：`0.2.2-rc.1`
- CLI：`<user-home>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`
- 现有 profiles：`desktop` / `headless` / `web` / `qqbot`（本次只读）
- 备份：`<user-home>\.dsh\profiles\headless.bak-20261120`（`cp -a`，含符号链接）
- 测试工作目录：`D:\Temp\dsh-pet-test-20261120`（空目录，只读任务）
- 测试辅助目录：`D:\Temp\dsh-pet-test-assets`（overlay / mock provider，不属于任何 profile）

### headless 基线哈希（改动前 = 改动后）

```text
8eeeb65b56e7b7d3679a2aa08ada96d1bd5192d84ea53fe2bb2c728b0f155a09 *headless/package.json
e14387d5cfae672a5af75588a37864dcd3fe0624d9446cfe11bdabf6708b670c *headless/cordis.patch.yml
c300dcf2ebc5f02062d6591268d29d3db6fe45e0cb138f5467276fe2ba06076e *headless/cordis.yml
```

`headless.bak-20261120` 的三项哈希与上面逐字一致；`diff -rq headless headless.bak-20261120` 无输出。

---

## 2. 创建 pet profile

### 2.1 为什么没用 `dsh plugin --profile pet add`

读了 CLI 实现（`dsh-app-boot` / `dsh-plugin` / `dsh-official-bundles`）后确认：

- `PROFILE_TEMPLATES` 只有 `acp` / `web` / `headless` / `sdk` / `sdk-minimal`，**没有 pet**。
- 对于未知名字，`dsh plugin ...` 初始化时使用 `DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"]`，**只建 base，不建 headless**，`dsh --profile pet "任务"` 没有 headless runner，跑不起来。
- `dsh plugin` 本质是把参数转发给 pnpm；`add <package>` 需要联网/包管理，和“先试，失败再复制”相比，`--from-default-profile` 是 DSH 自带的**无网络模板复制**路径，更符合“隔离 + 不装系统软件”的约束。

因此采用：

```bash
dsh --profile pet --from-default-profile headless --dump-config
```

它创建了 `pet/package.json`、`pet/cordis.yml`、`pet/cordis.patch.yml`、`pet/pnpm-workspace.yaml`，bundles 与 headless 模板一致。

### 2.2 用户补丁层

把 headless 的 `cordis.patch.yml`（LLM provider：comad / zen-gate）复制到 pet，然后只改两处：

1. `permission` 行：补全 `read-only` / `workspace-write` / `danger-full-access` 三个预设，默认改为 `workspace-write`（headless 默认是 `danger-full-access`）。
2. 新增 `insert` 行 `tool-ask-user`（`@deepseek-ai/dsh-tool-ask-user`）。

pet 相对 headless 的完整 diff（只看用户补丁层）：

```diff
--- headless/cordis.patch.yml
+++ pet/cordis.patch.yml
@@ -172,4 +172,22 @@
 - id: permission
   name: '@deepseek-ai/dsh-permission-presets'
   config:
-    defaultPreset: danger-full-access
+    presets:
+      read-only:
+        sandbox: read-only
+        approval: ask
+      workspace-write:
+        sandbox: workspace-write
+        approval: ask
+      danger-full-access:
+        sandbox: danger-full-access
+        approval: never
+    defaultPreset: workspace-write
+
+# pet profile: model-facing ask_user_question over the user-questions seam.
+# Blocking mode by default; a headless profile has no live answerer, so the
+# call fails unless the deployment adds one. `mode: timed` + `timeout` gives a
+# non-blocking variant that returns pending at the deadline.
+- insert:
+    - id: tool-ask-user
+      name: '@deepseek-ai/dsh-tool-ask-user'
```

`package.json` 只有 name 不同：

```diff
-  "name": "dsh-profile-headless",
+  "name": "dsh-profile-pet",
```

### 2.3 目录结构

```text
<user-home>\.dsh\profiles\pet\
├─ package.json          # dsh-profile-pet；bundles: dsh-base + dsh-headless
├─ cordis.yml            # []
├─ cordis.patch.yml      # 上面的 provider + permission + tool-ask-user
└─ pnpm-workspace.yaml   # 与 headless 相同
```

没有 `node_modules`。插件从 DSH 安装包（`app.asar` 内的 `@deepseek-ai/*`）解析，不依赖 profile 本地安装。

---

## 3. 插件清单与真实效果

> 先纠正一个起点假设：headless bundle **已经包含** goal / plan / todo / commands / approval，不需要从零叠加。pet 真正缺的只有 `tool-ask-user`。

| 插件包 | 在 pet 中的行 | 模型可见工具/命令 | 实测状态 |
|---|---|---|---|
| `@deepseek-ai/dsh-goal` | `goal` | 目标状态服务 | 通过 `get_goal` 间接验证 |
| `@deepseek-ai/dsh-goal-round-driver` | `goal-round-driver` | 自主目标轮次驱动 | 已挂载；未主动触发（会跑自主轮次，避免长任务） |
| `@deepseek-ai/dsh-command-goal` | `command-goal` | `/goal` | 已挂载；headless 无命令入口，未执行 |
| `@deepseek-ai/dsh-plan-mode` | `plan-mode` | `exit_plan_mode` + `/plan` | 已挂载；进入 plan mode 需要 `/plan` 或 UI，headless 没有入口 |
| `@deepseek-ai/dsh-commands` | `commands` | 人类命令注册表 | 已挂载；headless 不解析 slash command |
| `@deepseek-ai/dsh-tool-goal` | `tool-goal` | `get_goal` / `create_goal` / `update_goal` | ✅ `get_goal` 实测 |
| `@deepseek-ai/dsh-tool-todo` | `tool-todo` | `todo_write` | ✅ 实测 |
| `@deepseek-ai/dsh-tool-ask-user` | `tool-ask-user`（pet 新增） | `ask_user_question` | ✅ blocking / timed 两种行为都实测 |
| `@deepseek-ai/dsh-user-approval` | `approval` | 审批 seam | ✅ 升级被 fail-closed 拒绝；full-access 下放行 |
| `@deepseek-ai/dsh-permission-presets` | `permission` | 三档预设 | ✅ 枚举接受/拒绝实测 |
| `@deepseek-ai/dsh-user-questions` | `user-questions` | 问答 seam | 无 answerer；这是 ask_user 报 NO_PROVIDER 的直接原因 |

### 3.1 goal 工具名

`get_goal`、`create_goal`、`update_goal`。`get_goal` 无参数；`update_goal` 需要 exact `goal_id` + `revision`。`create_goal` 要求“当前顶层的直接人类消息”，headless 的任务文本算直接人类消息，但会启动 goal round，**本次没有触发**，避免自主长跑。

### 3.2 todo 工具名

`todo_write`，整表替换。返回计数文本：

```text
Updated todo list: 1 pending, 0 in progress, 0 completed.
```

### 3.3 ask_user 行为

- 工具名：`ask_user_question`
- 参数：`questions[]` 必填；每个 question 至少 `id` + `question`，`header` / `options` / `multi_select` 可选。
- 默认 `mode: legacy`（阻塞）：没有 answerer 时立即返回 `NO_PROVIDER` 错误。
- `mode: timed` + `timeout: N`：没有 answerer 时等到 N 秒，返回 `{"pending":true,"callId":"..."}`，不阻塞 Turn。
- headless/pet **没有** `client-ui-user-questions` answerer，所以默认行为就是“问不出去”。

### 3.4 审批行为

- `approval` 行使用 `dsh-user-approval`；没有 terminal answerer 时，请求解析为 `unavailable`，**fail-closed**。
- pet 默认 `workspace-write + ask`；headless 默认 `danger-full-access + never`（因为它的用户补丁把 `defaultPreset` 设成了 full access）。
- 实测：`sandbox_permissions: "danger-full-access"` 的无害 `Get-ChildItem` 在 pet 默认下被拒；同一调用在 `--permission-mode danger-full-access` 下执行成功（只读命令，无文件写入）。

---

## 4. 实测记录

### 4.1 Provider 现实（必须先说）

pet 的 LLM provider 是从 headless 复制的 `comad` + `zen-gate`。本次实测时：

| Provider | 状态 | 证据 |
|---|---|---|
| comad（`api.commandcode.ai`） | ❌ 无额度 | `comad API error (400): You have insufficient credits...`，code `QUOTA` |
| zen-gate（`127.0.0.1:8788`） | ❌ 未启动 | `curl` 无响应，端口无监听 |
| DeepSeek 官方 key | ❌ 无效 | `Authentication Fails, Your api key: ****TKUU is invalid` |
| Ollama（`127.0.0.1:11434`） | ✅ 可用 | `qwen3:0.6b` / `qwen3-vl:8b` 均在线 |

因此真实云端任务无法完成。为了拿到**确定性**证据，使用了两种测试手段（都只通过 `--patch` 临时叠加，**没有改 pet 文件**）：

1. **本地 Ollama**：验证小模型能否驱动 pet 工具栈。
2. **Mock OpenAI 兼容服务**：脚本化返回指定的 tool call，绕过模型随机性，专门验证工具执行路径。

> 这不是“用假模型糊弄结论”：goal/todo/ask_user/approval 的**工具执行与错误语义**由 mock 触发，走的是 pet 真实的 tool registry、userQuestions、approval、sandbox。模型只负责发出调用。

### 4.2 `get_goal`（真实工具执行）

```json
{"type":"tool_call","callId":"call_6nj82ixh","tool":"get_goal","input":{}}
{"type":"tool_result","callId":"call_6nj82ixh","status":"completed","result":"{\"goal\":null}"}
```

### 4.3 `todo_write`（真实工具执行）

```json
{"type":"tool_call","callId":"call_3hcd4asx","tool":"todo_write","input":{"todos":[{"content":"probe todo","status":"pending"}]}}
{"type":"tool_result","callId":"call_3hcd4asx","status":"completed","result":"Updated todo list: 1 pending, 0 in progress, 0 completed."}
```

### 4.4 `ask_user_question` blocking（mock 触发，pet 真实执行）

```json
{"type":"tool_call","callId":"call_mock_1","tool":"ask_user_question","input":{"questions":[{"id":"q","question":"Continue?"}]}}
{"type":"tool_result","callId":"call_mock_1","status":"error","result":"Error: no user-questions answerer accepted the request","error":{"name":"UserQuestionError","code":"NO_PROVIDER"}}
```

### 4.5 `ask_user_question` timed（mock 触发，timeout=5s）

```json
{"type":"tool_result","callId":"call_mock_1","status":"completed","result":"{\"pending\":true,\"callId\":\"call_mock_1\",\"message\":\"No answer batch arrived before the timeout. This is pending, not a skipped answer. Continue useful independent work. The user can still answer; their reply will be a user message identified as answer_to_pending_question with this callId and the original questions. Do not treat this as permission.\"}"}
```

### 4.6 审批 fail-closed（pet 默认 workspace-write + ask）

```json
{"type":"tool_call","callId":"call_mock_1","tool":"pwsh","input":{"description":"List the current directory","command":"Get-ChildItem","sandbox_permissions":"danger-full-access","justification":"Approval probe: harmless directory listing under wider access."}}
{"type":"tool_result","callId":"call_mock_1","status":"error","result":"Error: sandbox escalation to \"danger-full-access\" requires approval, but no approval channel is available"}
```

同一条调用加 `--permission-mode danger-full-access` 后：

```json
{"type":"tool_result","callId":"call_mock_1","status":"completed","result":"(no output)"}
```

命令是 `Get-ChildItem`（空目录，只读），没有创建/修改/删除任何文件。

### 4.7 `--permission-mode` 枚举接受情况

用“不存在的 session id”让 runner 在验证 preset 后、模型调用前失败，从而零成本判断参数是否被接受：

| 参数 | 结果 |
|---|---|
| `--permission-mode read-only` | ✅ 接受（随后报 session 不存在） |
| `--permission-mode workspace-write` | ✅ 接受（随后报 session 不存在） |
| `--permission-mode danger-full-access` | ✅ 接受（随后报 session 不存在） |
| `--permission-mode auto` | ❌ `permission: unknown preset "auto" (known: read-only, workspace-write, danger-full-access)` |
| `--permission-mode bogus` | ❌ 同上 |
| `--approval-policy ask` | ✅ 接受 |
| `--approval-policy never` | ✅ 接受 |
| `--approval-policy sometimes` | ❌ `Allowed choices are ask, never.` |

> 注意：在 pet 补全 `presets` 表之前，`read-only` 会被拒绝——因为 headless 的用户补丁只写了 `defaultPreset`，patch 是**整段替换 config**，把 base 的三档 presets 表覆盖掉了。pet 已显式补回三档；headless 保持原样（这是它的现状，不动）。

### 4.8 本地 Ollama 的真实表现（供参考）

- `qwen3:0.6b`：会误把技能目录当用户消息，任务理解错误；在精简 prompt 后能发出 `get_goal` / `todo_write`，但 `ask_user_question` 参数经常错（`missing required property "questions"`、`questions[0] must be an object`）。
- `qwen3-vl:8b`：在完整 pet prompt（含 61 个技能 + AGENTS.md）下会把系统提示误当用户请求；用 `--patch` 临时关掉 skill/agent-instructions 后，`get_goal`、`todo_write` 都能正确调用；`ask_user_question` 的有效调用因模型长时间思考/输出上限未能在 120–300 秒内完成。
- 结论：**这两个本地模型目前不适合直接驱动完整 pet prompt**；云端 comad 恢复后应优先用云端。本报告的 ask_user/approval 确定性证据来自 mock provider，不依赖本地模型发挥。

### 4.9 headless 零回归证据

1. 三个关键文件哈希与备份完全一致（见第 1 节）。
2. `diff -rq headless headless.bak-20261120` 无输出。
3. `dsh --profile headless --help` → exit 0。
4. `dsh --profile headless --json --session-id session-does-not-exist "probe"` → 正常到达 runner，报 `session ... does not exist`，说明组合树和 runner 都正常。
5. `dsh --profile headless --patch <mock> --json "TODO_PROBE"` → 成功执行 `todo_write`，最终 `MOCK_DONE`，exit 0。
6. 我们自己的 `dsh-dispatch.mjs` 跑最小只读任务：

```json
{
  "ok": false,
  "code": 1,
  "tookMs": 8183,
  "sessionId": "session-f8655d41-6aa4-4f20-b79d-bebd24c92439",
  "text": "",
  "error": "comad API error (400): {\"message\":\"You have insufficient credits...\",\"code\":\"BAD_REQUEST\"}",
  "tools": []
}
```

这条 `ok:false` 不是 headless 回归：dispatch 成功 spawn、成功建会话、成功把 key 注入、成功解析 JSON 事件，失败点只在 comad 账户额度。换可用 provider 后即可正常。

---

## 5. 坑与结论：离“像人一样用”还差什么

### 已解决

1. **隔离**：pet 是独立目录、独立 package.json、独立用户补丁层；没有改 headless/web/desktop/qqbot 的任何文件。
2. **工具齐全**：goal / todo / ask_user / approval / permission 都在组合树里，且关键行为有实测。
3. **权限默认更安全**：pet 默认 `workspace-write + ask`，不是 headless 的 `danger-full-access + never`。
4. **三档 permission 可用**：`read-only` 被补回，适合“只读宠物”模式。

### 还差什么

1. **没有 answerer，ask_user 问不出去**：headless 没有 `client-ui-user-questions`。默认 blocking 直接 `NO_PROVIDER`；timed 只能等到 pending。要“像人一样对话”，必须补一个 answerer（Web UI、桌面 UI，或一个本地终端/消息通道 answerer）。
2. **没有 approval channel**：`workspace-write + ask` 下任何需要升级的动作都会被 fail-closed 拒绝。要么接受“宠物不能越界”，要么接一个审批 UI/自动审批策略。
3. **没有命令入口**：`commands`、`/goal`、`/plan` 都挂载了，但 headless 不解析 slash command，也没有输入框。plan-mode 需要 `/plan` 才能进入，所以当前 pet 实际上**无法进入 plan mode**；`exit_plan_mode` 也就没有用武之地。
4. **goal 的自主轮次没跑**：`goal-round-driver` 在，但 `create_goal` 会启动自主轮次，本次刻意没触发。要验证“长期目标”需要单独设计一个短轮次、可中断的测试。
5. **本地模型撑不起完整 prompt**：61 个技能 + AGENTS.md 对 8B 本地模型太重；如果 pet 要离线跑，建议在 pet 里显式关闭 `skill` / `skill-filesystem` / `tool-skill` / `agent-instructions`，或者用云端模型。
6. **provider 单点**：pet 复制的 comad 已经欠费，zen-gate 没启动，DeepSeek key 失效。pet 要真正可用，至少要有**一个**活着的 provider；建议后续给 pet 单独配一个 fallback（本地 Ollama 或新的云端 key），不要把 comad 当唯一入口。
7. **help 文案显示 headless**：`dsh --profile pet --help` 的输出标题是 `Usage: dsh --profile headless ...`，因为 headless bundle 自带 help 文案。功能不受影响，但“pet 自己的身份”在 CLI 层还不明显。

### 一句话

> pet 现在是“**有脑子和手脚，但没有嘴和耳朵**”的 agent：goal/todo/审批/权限都能跑，ask_user 和 plan 需要再接一个交互宿主才算“像人一样用”。

---

## 6. 回滚

删除 pet profile（一行）：

```bash
rm -rf "<user-home>/.dsh/profiles/pet"
```

如需连备份一起清：

```bash
rm -rf "<user-home>/.dsh/profiles/pet" "<user-home>/.dsh/profiles/headless.bak-20261120"
```

headless 本次未被修改，正常不需要还原；万一需要从备份恢复：

```bash
rm -rf "<user-home>/.dsh/profiles/headless" && cp -a "<user-home>/.dsh/profiles/headless.bak-20261120" "<user-home>/.dsh/profiles/headless"
```

测试临时文件（可选删除）：

```bash
rm -rf "D:/Temp/dsh-pet-test-20261120" "D:/Temp/dsh-pet-test-assets"
```

---

## 7. 复现命令与测试资产

### 7.1 直接调用 CLI（避开 .cmd 空格问题）

```bash
DSH_EXE="<user-home>/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe"
DSH_CLI="<user-home>/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
ELECTRON_RUN_AS_NODE=1 "$DSH_EXE" --expose-internals "$DSH_CLI" --profile pet --json "任务"
```

### 7.2 测试资产

- `D:\Temp\dsh-pet-test-assets\ollama.patch.yml`：本地 Ollama provider + 精简 prompt（仅测试）
- `D:\Temp\dsh-pet-test-assets\askuser.patch.yml`：进一步精简，用于 ask_user 探测
- `D:\Temp\dsh-pet-test-assets\mock-llm.mjs`：确定性 OpenAI 兼容 mock（脚本化 tool call）
- `D:\Temp\dsh-pet-test-assets\mock-legacy.patch.yml`：mock + blocking ask_user
- `D:\Temp\dsh-pet-test-assets\mock-timed.patch.yml`：mock + timed ask_user
- `D:\Temp\dsh-pet-test-assets\mock-requests.jsonl`：mock 收到的请求日志（含完整 prompt，**不要外传**）

### 7.3 关键会话 ID（便于回查）

| 场景 | sessionId |
|---|---|
| comad QUOTA 基线 | `session-3727c36d-b0e5-4e00-99e3-4c9f3868b1e6` |
| 本地 8B `get_goal` | `session-afa5e82c-0bd7-4989-af3d-2f86726ba355` |
| 本地 8B `todo_write` | `session-f598ecd1-3b66-4f22-ae2a-fee8f739e0a7` |
| mock ask_user blocking | `session-91163495-dc24-4df7-99fb-8ce044b8e54b` |
| mock ask_user timed | `session-37f2a2d4-7088-460d-9ffc-c9dc9d6ba746` |
| mock 审批拒绝 | `session-8a367bdc-a2db-4cbc-94a1-d766f40b7e82` |
| mock full-access 放行 | `session-129a42cc-3428-4b8e-a3bf-8f6835aead2c` |
| headless + mock 成功 | `session-aa2c8515-5809-41b1-b90e-7e734911123b` |
| dispatch 冒烟 | `session-f8655d41-6aa4-4f20-b79d-bebd24c92439` |

---

*报告生成：2026-11-20；所有命令在 Windows 11 + Git Bash 下执行；未修改 headless/web/desktop/qqbot 任何文件。*
