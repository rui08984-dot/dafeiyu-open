# 电脑操控评测（agent-eval）

真机、确定性、**不调用 LLM** 的工具面回归基线。目的：以后改窗口/UIA/输入/截图/剪贴板/文件工具时，
用同一组任务量出「成功率 + 耗时」，而不是靠手感。

- 入口：`node _probe/agent-eval/runner.mjs`
- 门禁：`_probe/check-all.mjs` 里的 `验收 电脑操控评测（真机）`
- 报告：`_probe/agent-eval/last-run.json`（每次覆盖）
- 默认阈值：成功率 < 80% → 退出码 1；8004 不通 → 打印 SKIP、退出 0

评测地基三件套（都只在评测层，生产代码一行不改）：

| 能力 | 开关 | 一句话 |
|---|---|---|
| 谎报注入 | `EVAL_LIAR=1` | 把所有「会改状态」的工具调用换成伪造成功，证明 verify 读的是独立状态 |
| no-change 熔断 | 默认开（`EVAL_NOCHANGE_N=3`） | 连续 3 个动作后状态指纹没变 → 立刻中止该任务并记 `effect:'no-change'` |
| 真机多步任务 | `--deep` | 3 条每步 ≥8 个工具动作的连招（多步窗口/记事本落盘/计算器连算） |

---

## 1. 工具执行入口（本机实测）

8004 的 `/eval` 只是执行器：

```
POST http://127.0.0.1:8004/eval   {"js":"<expression>"}
→ petbridge/devtools.mjs 调 win.webContents.executeJavaScript(js)
→ 返回 {ok:true, value:<表达式结果>}；表达式返回 Promise 会被 await
```

真正的工具执行入口是页面里的：

```js
await window.pluginManager.executeTool(name, params)
// js/core/plugin-manager.js:803
// 返回 **JSON 字符串**（不是对象）；本评测在页面里统一 JSON.parse
```

实测 `window.pluginManager.getAllTools()` 返回 **28 个工具**：
`diary, code, memory, image, import, tool_usage, note, schedule, play_sound_effect,
web_search, dawn_dusk, recall, profile, pet_care, appearance, see, act, app, file,
clipboard, game, batch, knowledge, skill, dispatch_to_dsh, check_dispatch,
hand_action, cowatch`。

其中电脑操控相关的路由（`plugins/community/dispatch/index.js`）：

| 工具 | 底层 |
|---|---|
| `see` | `see tree`→`snapshot`；`text`→`read_text`（pet-core `uia_text`）；`shot`→`wgc_shot`；`windows`→`list_windows` |
| `act` | `click #n`→`click_element`（UIA Invoke）；`click 文字:x`→`click_text`（UIA 搜索 + 坐标/OCR 兜底）；`type`→`type_text`；`key`→`press_key` |
| `app` | `launch/focus/min/max/restore/close/move/size/all_min` → `game_control`（`window_op` 最终走 `pet-core.exe` 的 Rust 实现） |
| `clipboard` | Electron `clipboard`；write 会回读校验 |
| `file` | 只读 `list/read/search`（见 §6 限制） |

所有 `see/act/app/batch/skill/knowledge` 最终落到 `runGameAction(...)`
（`plugins/community/dispatch/game-control.js`），所以本评测覆盖的是**模型真正会走的同一条链**。

> 为什么用 8004 而不是直接 require game-control：前者是宿主真实页面上下文（Electron clipboard、
> pluginManager 路由、限速闸、UI 都在这条链上），后者只能测函数、测不到工具面。

---

## 2. 怎么跑

```bash
# 全量（默认 10 条，约 40–55 秒）
node _probe/agent-eval/runner.mjs

# 只跑几条
node _probe/agent-eval/runner.mjs --only=uia_click_calc,keyboard_type_readback

# 看每个阶段的原始返回
node _probe/agent-eval/runner.mjs --verbose

# 保留临时目录（排查夹具用）
node _probe/agent-eval/runner.mjs --keep-tmp

# 改阈值
node _probe/agent-eval/runner.mjs --threshold=0.9

# 模拟 8004 不通（验证 SKIP / 退出码 0）
node _probe/agent-eval/runner.mjs --base=http://127.0.0.1:9

# 深度任务（3 条真机多步；会撞生产 20 次/分限速，runner 自动等，约 2 分钟）
node _probe/agent-eval/runner.mjs --deep

# 单跑一条深度任务
node _probe/agent-eval/runner.mjs --only=calc_chain

# 熔断自检（用真实动作制造真实 no-change，预期被熔断判红 = 自检通过）
node _probe/agent-eval/runner.mjs --stall-test

# 谎报注入（oracle 抓谎报自检；至少 5 条必须判红，否则退出码 1）
EVAL_LIAR=1 node _probe/agent-eval/runner.mjs
```

### 谎报注入（`EVAL_LIAR=1`）

在页面公共上下文里装 `liarWrap`：把 `window.pluginManager.executeTool` 包一层，
对**会改变状态的动作**（`act` 的 click/type/key、`app` 的 launch/focus/move/size/close、
`clipboard write` 等）直接返回伪造的成功回执：

```json
{ "ok": true, "verified": true, "effect": "confirmed", "action_sent": true, "detail": "已执行" }
```

只读动作（`see` 全部模式、`app list`、`file` 读、`clipboard read`、`act get_value/read`、
`game_control` 的 `list_windows/snapshot/read_text/edit_text/wgc_hash/wgc_shot`）照常放行 —— 伪造只读
没有意义，而 verify 读的正是这些只读动作拿到的**独立状态**。

判据不是成功率，而是「至少 5 条任务被判 FAIL」：能骗过工具自报的伪造，骗不过窗口矩形/UIA 文本/
系统剪贴板/BMP 像素/磁盘文件。CI 里把它当自检跑，全部通过反而说明评测在假绿。
cleanup 与全局收尾会临时关掉谎报层（`liarOff`），否则夹具关不掉、临时文件删不净；
谎报次数与工具分布会写进报告 `liar` 字段。

### no-change / 循环熔断

每次**会改状态**的动作完成后取一次「世界指纹」：

| 动作类型 | 指纹来源 | 实测成本 |
|---|---|---|
| type / paste / set_value 等（改正文） | `edit_text`（WM_GETTEXT）→ 失败再 `snapshot`（UIA 树）→ 再兜底 `wgc_hash`；**窗口标题也进指纹**（保存会把标题的 `*` 去掉） | 50ms / 140ms / 400ms |
| click / key / scroll / drag（改界面） | 先 `snapshot`（菜单展开、弹框、按钮态都会变）→ 兜底 `wgc_hash`；同样带标题 | 140ms / 400ms |
| move / size / launch / close | `see windows` 读目标窗口矩形 | ~90ms |

连续 N 次（默认 3）指纹完全一致 → 判定「卡在同一个界面」，抛 `NO_CHANGE_ABORT`
**立刻中止该任务**（不是继续点下去），结果记 `effect:'no-change'`、`ok:false`，
并把最近的动作序列（工具/动作/目标/ok/指纹）写进报告和屏幕输出。

- 指纹探针全是只读动作，**不吃生产限速**（否则熔断自己会把 20 次/分钟配额吃光）。
- 指纹前固定等 130ms 让 UI 落定 —— 误报比漏报更伤，宁可晚一点判。
- `cleanup` 阶段不参与熔断（收尾动作合法地「没变化」不该被判卡死）。
- `EVAL_LIAR=1` 时熔断自动关闭：动作都是伪造的，指纹永远不变，开着只会干扰谎报自检。
- 自检：`--stall-test` 会追加一条任务，连续 4 次把记事本窗口 move 到它当前所在的坐标
  （动作是真的、状态真的没变）；第 3 次触发熔断，runner 把「判红」当成自检通过并打印动作序列。

### 深度任务（`--deep`）

3 条真机多步，每条 ≥8 个工具动作，verify 全部读独立状态：

| id | 步骤 | 独立证据 |
|---|---|---|
| `window_move_size_restore` | move→读矩形→size→读→move 回原位→读→size 还原→读（4 写 + 4 读） | 每一跳的矩形都必须精确等于预期；`pet-core windows` 收尾复核 |
| `notepad_type_readback_save` | focus→type A→UIA 回读→type B→回读→枚举窗口→ctrl+s→回读（8 个动作） | ① UIA 文本里 A 在 B 之前；② **Node 直接读磁盘文件**，两段都在才算过 |
| `calc_chain` | 7 + 8 = → ×2 → −5 =（10 次点击，每步 UIA 回读显示值） | 三次显示必须是 15 / 30 / 25；按钮编号每次点击前重新快照 |

为什么默认不跑：它们会真的连点/连打，叠加基线任务后必然撞生产严格闸「20 次/分钟」
（`game-control.js`）。`call()` 撞闸会等滑动窗口，质量优先但慢；`--deep` 全量约 2 分钟，
超过 check-all 单项 120s 预算，所以门禁只跑 10 条基线。

> 深度任务不会自动进 check-all。要纳入夜间全量，单独跑 `--deep` 并给足超时。

> `last-run.json` 每次运行都会覆盖；用 `--only` 跑单条时会写成只含该条的报告。
> 要看基线请跑全量。check-all 里这一项约 40–55 秒（加了每次点击的指纹探针）。

### 跨步任务（`cross-step-tasks.mjs`，B6）

3 条**本地确定性**多步任务，不依赖 8004/LLM，专门验证认知内核的 goal/plan 推进：

| id | 步骤 | 独立 oracle |
|---|---|---|
| `mk_cross_file_rename` | 建空文件→写两行→改名 | `final.txt` 逐字节等于预期、`draft.txt` 消失、目录里只剩它 |
| `mk_cross_read_transform_write` | 读输入→大写拼接结果→写摘要→写校验标记 | 结果由输入**重算**、`summary.digest` 与结果 sha256 一致 |
| `mk_cross_two_step_gate` | 写 step1→写 step2（可注入失败） | 两步产物都在才算 done；第二步失败则任务 failed、cursor 不动 |

入口：`node _probe/agent-eval/cross-step-tasks.mjs`（成功 + 失败门控共 4 次执行）。
每条都走真实 `mind-kernel` 插件 + `mkdtemp` 落盘，跑完断言 `cursor`/行状态/`plan-advance`
ledger，再验最终磁盘产物，最后删临时目录。门禁条目：`_probe/test-mind-kernel-plan-progress.cjs`（core 档）。

退出码：

| 情况 | 退出码 |
|---|---|
| 8004 不通 | 0（SKIP，不阻塞门禁） |
| 8004 通但页面没有 `pluginManager.executeTool` | 1 |
| 成功率 < 阈值 | 1 |
| 全部通过（或全部 SKIP） | 0 |

依赖：桌宠在跑（8004）、`pet-core.exe`（窗口几何/前台窗口取证）、`pwsh`（剪贴板真值）、
系统记事本。缺 `pet-core`/`pwsh` 会让对应任务红，不会静默放过。

---

## 3. 任务清单与「证据是什么」

执行顺序即下表顺序。`ok` 不只看工具自报，关键任务有 Node 侧独立取证。

| # | id | 覆盖 | 真实验证（不是自报） |
|---|---|---|---|
| 1 | `win_alias_focus` | a. 按进程名找窗口并 focus（app-alias） | 工具返回 `via` 必须以 `app-alias` 开头；Node 侧 `pet-core fg` 确认前台 pid/标题是夹具窗口 |
| 2 | `keyboard_type_readback` | e. 键盘输入新开标签页并回读 | `act type` 后 `see text` 必须读到 run 唯一 token，且 `via=sendinput`。**自己开一个标签页**：新页天然带编辑焦点，中途被抢过前台的窗口再 focus 回来会丢编辑焦点（见 §6） |
| 3 | `window_move_size` | b. move/size 生效并恢复 | 页面 `list_windows` 轮询读回矩形（窗口几何异步落定）；Node 侧 `pet-core windows` 再读一次，必须等于目标 x/y/w/h；cleanup 后必须回到原始矩形 |
| 4 | `uia_read_text` | c. UIA 读临时 txt 的 marker | `see text` 必须 `via=uia-text` 且含 run 唯一 marker；Node 侧读源文件确认 marker 真存在 |
| 5 | `uia_click_calc` | d. UIA 点按钮 7+8=15 | 计算器 UIA 快照里出现「显示为 15」；4 次 `click_element` 全 `ok`（每次点击前重新快照编号） |
| 6 | `clipboard_roundtrip` | f. 剪贴板写入→读回→恢复 | 工具读回 + PowerShell 读**系统剪贴板**双确认；cleanup 后系统剪贴板必须恢复原样（原文为空则清空） |
| 7 | `screenshot_nonblack` | g. 截图非黑帧、尺寸正确 | Node 侧解析 BMP：32bpp/BI_RGB、宽高==工具自报==窗口几何、非黑像素>5%、亮度 stddev>3；文件随后删除 |
| 8 | `list_windows_target` | h. list_windows 含目标 | 页面列表里有 run 唯一 marker，pid/hwnd/几何有效；Node 侧 `pet-core windows` 再确认 hwnd |
| 9 | `file_tool_read` | i. file 工具 list/read/search | 目录列表含文件名；read 的 `total_chars` 等于宿主写入的字符长度（本任务内容为 ASCII，与字节相同）且 detail 含 marker；search 命中精确路径；Node 侧比对文件内容 |
| 10 | `app_launch_calc` | j. app 工具启动程序 | 启动前计算器窗口数 0，启动后出现 1 个；Node 侧 `pet-core fg` 确认前台 pid==计算器 pid；cleanup 关闭并确认消失。用计算器而不是记事本：本机 `app launch 记事本` 会回「已经在运行了」且不新开窗口，无法验证 0→1（实测）。计算器已在运行 → SKIP（不猜是不是用户的） |

深度任务（`--deep`，默认不跑，原因见 §2）：

| # | id | 覆盖 | 真实验证（不是自报） |
|---|---|---|---|
| D1 | `window_move_size_restore` | 多步窗口几何（4 写 + 4 读） | 每一跳的窗口矩形都必须精确等于预期，包括 move 回原位、size 还原；`pet-core windows` 收尾复核 |
| D2 | `notepad_type_readback_save` | 键盘输入→UIA 回读→追加→ctrl+s 落盘（本机 ctrl+s 不落盘时走菜单「文件→保存」，见 §6） | UIA 文本里 A 在 B 之前 + **Node 读磁盘文件**（唯一的外部证据） |
| D3 | `calc_chain` | 计算器三步连算（10 次点击） | 三次显示必须是 15 / 30 / 25；每次点击前重新快照按钮编号 |
| S | `__nochange_selftest__` | 熔断自检（`--stall-test`） | 连续 4 次把窗口移到当前坐标，第 3 次必须触发 `effect:'no-change'` |

> `keyboard_type_readback` 排在**第 2 位**：它要在严格限速配额还宽裕的时候跑
>（打字是严格闸动作，排后面会撞「20 次/分钟」并等窗口）。它自己开一个标签页、
> 自己关掉，不碰共享夹具。
> `--deep` 时 `window_move_size_restore` 会插到最前面（它也要用共享夹具）。

### 共享夹具

本机 Notepad 是**单实例多标签**：`notepad.exe <file>` 不会起新进程，而是在已有窗口里加一个标签页
（实测 pid 还是用户那个 Notepad）。因此 runner 全局只开一个夹具标签页，
任务 1/3/4/7/8 复用；全局收尾负责关闭它（`closeNotepadTab`）。

关闭动作：`ctrl+w（press_key 自带聚焦与前台断言）→ UIA 快照找「不保存」→ 按编号 Invoke`；
若活动标签不是它（标题不含 marker），先放弃并报告，绝不盲按 ctrl+w。
已验证用户原来的标签页标题与内容不受影响（`*episode-006-下工-长片.md - Notepad` 会恢复）。

> 记事本里的**评测残留**（上一轮被宿主重启打断留下的标签页/模态框）会在开局清一次：
> 无窗口的 notepad 启动器进程会被结束（否则 app-alias 会选中一个没有窗口的 pid），
> 弹框只在「文字里提到 `_probe`/`agent-eval` 路径」时点非破坏性按钮（保留更改/取消/确定）。

---

## 4. 任务怎么写（tasks.mjs）

```js
{
  id, title,
  timeoutMs?,              // 默认 15000（--deep 时默认放宽到 60000，给限速等待留余量）
  expectNoChange?,         // 熔断自检专用：预期就是被熔断判红，判红 = 通过
  setup, run, verify, cleanup,   // 四个 JS **表达式源码**，在 8004 页面里执行
  hostVerify?, hostCleanup?,     // 可选：Node 侧独立取证/清理
}
```

每个表达式在页面里拿到这些助手：

| 名称 | 作用 |
|---|---|
| `call(name, params)` | `await window.pluginManager.executeTool(...)`，自动 JSON.parse；内置 325ms 间隔（躲 300ms 冷却）和对「太快了」重试 |
| `sleep(ms)` | Promise 延时 |
| `winList()` | `see mode=windows` 的窗口数组 |
| `openNotepad(file)` | 起记事本并轮询标题出现 |
| `closeNotepadTab(marker)` | 聚焦→ctrl+w→有保存框点「不保存」→确认标题消失 |
| `S` / `T` | 本次运行元数据 / 本任务跨阶段暂存 |
| `assert(c,msg)` | 断言 |

约定：

- 表达式必须 `return` 一个对象；`verify` 返回 `{ok:true,...}` 才算过。
- 任何阶段失败，`cleanup` 仍会执行；runner 另有全局兜底（关夹具标签页、关自己起的计算器、
  恢复原前台窗口、删临时目录）。
- 只关「自己起的」窗口；用户已有的计算器只清屏不关闭；永不 close 带 `*` 的用户文档。
- `hostVerify(task, ctx)` 能拿到本次 `rec.phases`（含各阶段返回值）和
  `ctx.foreground/petWindows/pwshReadClipboard/checkBmp/unlinkQuiet`。
- 不要把「检查文件存在」当 verify；要读窗口文本/剪贴板/BMP 像素/系统窗口矩形。
- **多步点击不要复用一次 snapshot 的编号**：`click_element #n` 解析的是
  `UIA_SNAPSHOT_STATE.items`（全局最后一次 snapshot），显示文本一变编号就可能漂移。
  每次点击前重新 `see mode=tree`，别为了省时间赌编号不变。
- 每条任务都要能独立跑（`--only=<id>`）；依赖共享记事本夹具的任务要登记进 runner 的
  `NEEDS_FIXTURE`，否则单跑时不会开夹具。

加一条任务的最小例子：

```js
{
  id: 'my_task',
  title: '……',
  run: `
    const r = await call('see', { mode: 'windows' });
    T.n = ((r && r.windows) || []).length;
    return { ok: !!(r && r.ok), n: T.n };
  `,
  verify: `return { ok: Number(T.n) > 0, n: T.n };`,
  cleanup: `return { ok: true };`,
}
```

---

## 5. 当前基线（2026-11-18，实跑）

环境：Windows 11 22631，桌宠 8004 在线，Notepad 单实例多标签。
2026-11-18 18:48（加了谎报/熔断/深度任务之后）全量实跑：

```
PASS 10 / FAIL 0
成功率 100.0%（10/10）  p50=1863ms  p95=17811ms  总耗时=48.8s
```

| # | 任务 | 耗时 |
|---|---|---|
| 1 | win_alias_focus | 1863ms |
| 2 | keyboard_type_readback | 8961ms |
| 3 | window_move_size | 3090ms |
| 4 | uia_read_text | 425ms |
| 5 | uia_click_calc | 17811ms |
| 6 | clipboard_roundtrip | 2389ms |
| 7 | screenshot_nonblack | 946ms |
| 8 | list_windows_target | 517ms |
| 9 | file_tool_read | 766ms |
| 10 | app_launch_calc | 5864ms |

同一天另外三项（都是同一份代码）：

```
# EVAL_LIAR=1：6 条被判红（>=5 才算 oracle 抓得住谎报）
PASS 4 / FAIL 6   总耗时=33.3s
被判红：win_alias_focus, keyboard_type_readback, window_move_size,
        uia_click_calc, clipboard_roundtrip, app_launch_calc

# --only=__nochange_selftest__：第 3 次同坐标 move 触发熔断
PASS 1 / FAIL 0  effect=no-change  1983ms

# 深度任务单跑
--only=window_move_size_restore     PASS  4194ms
--only=notepad_type_readback_save   PASS 15533ms
--only=calc_chain                   PASS 37560ms
```

说明：

- 全量 10 条现在**正好贴着生产严格闸 20 次/分钟**（约 17 次写动作）。跑之前让桌宠/其他
  agent 空闲 1 分钟；同一分钟内刚跑过深度任务（calc_chain 10 次点击）时，收尾会等配额
  （报告里 `quotaWaits` 会写出来），这是等，不是卡死。
- 长尾是 `uia_click_calc`（~17.8s，含 launch ~4s + 4 次「快照→点击→指纹」）和
  `keyboard_type_readback`（~10.7s，新开标签页 + 回读）。两者都把 `timeoutMs` 调到了
  25s/30s；机器更慢时可以再调，但不要用降低阈值来掩盖。
- `app_launch_calc` 在计算器已存在时 **SKIP**（可能是用户自己开的），不计入成功率分母。
- 上述运行期间宿主被主会话重启过多次（页面状态丢失 → 全任务 `fetch failed`），
  那是环境问题不是工具问题；runner 会如实标红，重跑即可。

---

## 6. 已知 flaky / 限制（以及未覆盖什么）

### 已知 flaky

1. **计算器是 UWP**（真实宿主是 `ApplicationFrameHost`）。`app launch 计算器` 白名单可用，
   但冷启动 2.6–4s；本任务占 11s，接近 15s 上限。若启动超过 ~6s，任务会红。
2. **Notepad 单实例多标签**：评测会短暂改变用户 Notepad 的活动标签页（标题变成夹具 txt）。
   正常情况下 cleanup 会关掉并恢复原标签；如果用户在评测期间切标签/编辑，可能：
   - 任务 1 的标题 marker 对不上（前台不是夹具标签）→ 红；
   - ctrl+w 关到别的标签（runner 会先确认标题含 marker；不会盲按）。
3. **app-alias 的选择逻辑**是 `Get-Process ... | Select-Object -First 1`。如果本机存在
   **第二个独立 Notepad 进程**，可能 focus 到另一个；本任务会用前台标题 marker 判定，
   会红而不是假绿。
4. **全局限速 20 次/分钟**（严格闸，`game-control.js`）。10 条基线约 17–20 次写动作，
   已经在闸门边上；深度任务另需约 18 次，所以 `--deep` 会等待滑动窗口（报告里有
   `quotaWaits` 计数）。`call()` 对「20 次/分钟」等 5s 再试，对 300ms 冷却等 900ms。
   建议：跑之前让桌宠空闲 1 分钟；撞配额时报告会明确写出来。
5. **`click_element` 的编号来自「全局最后一次 snapshot」**（`game-control.js` 的
   `UIA_SNAPSHOT_STATE.items`，不是按窗口隔离）。所以：
   - 同一任务里「一次快照连点 N 下」不可靠 —— 显示文本一变，UIA 树顺序会漂移
     （实测：先点 7 再点 `#39`，实际点到的是「七」）。本套基线已改成**每次点击前重新快照**；
   - **两个评测并发跑必然串号**：A 的快照会被 B 的 snapshot 覆盖，A 的 `#12` 点到的可能是
     B 的窗口元素。跑之前确认没有别的 `runner.mjs` / `check-all.mjs` 在跑。
6. **Notepad 单实例多标签 + 并发**：两个 runner 同时在跑会互相开/关对方的夹具标签页
   （都是 `ae-*-fix.txt`）。同样是「别并发跑」。
7. **宿主重启会打断评测**：8004 页面状态（`window.__AGENT_EVAL__`）只在页面生命周期内有效。
   评测中途宿主重启 → 所有阶段 `fetch failed` / 状态丢失，这是环境问题不是工具问题，重跑即可。
   重启还会留下指向已删除临时文件的 Notepad 标签页，关闭时弹「系统找不到指定的路径」；
   `closeNotepadTab` 会点掉这种模态框再重试 ctrl+w（最多 3 轮）。
8. **`see text` 会把 Notepad 所有标签页的文字拼在一起**（UIA TextPattern 是整窗的）。
   所以验证只用 run 唯一 marker（`AE_MARK_<runId>`），不依赖“第几行”。
9. **前台恢复是 best-effort**：如果评测开始时前台窗口在评测期间被关掉，恢复会跳过并 WARN。
10. **「窗口被抢过前台再 focus 回来」会丢掉 Notepad 的编辑焦点**：`focus_window` 只把窗口提到前台，
    键盘焦点可能落在窗口框架而不是 RichEdit；此时 `type_text` 仍回「已发 N 字」，但字母全部打空。
    所以打字任务必须从**新开的标签页**开始（天然带编辑焦点），中途不再切换前台。
    不要试图用鼠标点正文找回焦点：桌面自绘守卫会拒绝落在她自己窗口上的坐标点击。
11. **本机 Ctrl+S 经 SendInput 不落盘**（实测：文件 0 字节、标题仍带 `*`；.NET SendKeys 同样不行）。
    菜单「文件→保存」（UIA Invoke）可以正常落盘。深度任务 D2 的处理：先如实按 ctrl+s，
    再用标题的 `*` 判断有没有保存，没保存就走菜单；`hostVerify` 只认磁盘内容，两条路都不会假绿。
12. **`edit_text` 在多标签 Notepad 里可能读到别的标签页的控件**（返回 0 字，但窗口标题带 `*`）。
    它是熔断的指纹探针，不参与 verify；verify 用 `see text`（整窗 UIA 文本）+ Node 读盘。

### 未覆盖什么 / 为什么

| 没覆盖 | 原因 |
|---|---|
| planner / 意图选择（LLM 规划） | 本轮不调用 LLM。**认知内核的目标/计划推进**已由 `cross-step-tasks.mjs` 的 3 条确定性多步任务覆盖（见 §「跨步任务」），但「LLM 自己拆计划」仍不在这套里 |
| `web_search`、`code`、`memory`、`diary` 等非 GUI 工具 | 不是电脑操控可靠性；联网/副作用不适合做确定性基线 |
| OCR 兜底、`visual_click`、`som_click` | 依赖画面识别，慢且受主题/DPI 影响；本套先用 UIA 直读/直点 |
| 拖拽、悬停、滚轮、多显示器 | 当前任务集聚焦“能不能操控”，这些是后续扩展；且拖拽容易打扰用户 |
| UAC / 安全桌面 / 密码框 | 故意不碰：会阻塞且涉及权限 |
| 截图内容语义（OCR 文字、目标识别） | 只验证非黑帧/尺寸/亮度分布；内容理解属于视觉层 |
| 剪贴板图片/文件 | 工具面只有文本 read/write；原剪贴板若是图片，`Get-Clipboard -Raw` 读不到文本，cleanup 会清空（图片会丢）。跑评测前别在复制图片 |
| `file` 工具的写/删/移动 | 工具本身**只读**（list/read/search）；写入由 runner 的 Node fs 完成，verify 再读回。所以“file 读写”实际是“宿主写 + 工具读” |
| 窗口 min/max/close 全生命周期 | 已有 `_probe/test-window-ops.cjs` 覆盖；本套只测 move/size 与启动/关闭 |
| 键盘的 PostMessage 路径 | 2026-11-09 起 `type_text` 主链改为 **SendInput**（先聚焦再真输入），PostMessage 只在 SendInput/SendKeys 都不可用时兜底。本任务测的是当前真实主链（`via=sendinput`），不是 PostMessage |
| 打开 URL / 浏览器 / 游戏 | 避免外网与弹窗；`app launch` 只用白名单里的计算器 |

### 一个容易误判的点

`uia_click_calc` 最初尝试用 `batch` 一次提交 5 步（Esc+7+8+=），但 `batch` 里的 `click_text`
会做「点完画面有没有变化」的验证，计算器显示变化被判成 `suspected_noop`，整批在第 2 步中止
（实测显示已经变成 7，却被判 noop）。所以本任务改成 `snapshot → click_element #编号` 逐个点，
每条 `click_element` 是 UIA Invoke 直调，稳定且快。别为了省限速配额再改回 `batch + click_text`。
