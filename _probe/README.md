# _probe/ —— 本轮验收脚本（2026-11-09 三十五轮）

这些不是测试框架，是**手工验收脚本**。每个都对应一个具体的「怎么证明它真的在工作」的问题。

留着的原因：以后改动这些模块时，跑一遍就知道有没有退化。

## 清单

| 文件 | 验什么 | 怎么跑 |
|---|---|---|
| `e2e-contract.js` | 结果契约六态 + list_windows / list_game_profiles / volume / focus_window | `node _probe/e2e-contract.js` |
| `e2e-click.js` | snapshot + click_element（第一个元素，多半是 pane，会失败——**这是预期的**）| `node _probe/e2e-click.js` |
| `e2e-click2.js` | snapshot + 点真实按钮（挑「搜索」这类无副作用的）| `node _probe/e2e-click2.js` |
| `e2e-knowledge.js` | 知识库三层 + Rust 检索 + 模糊匹配 + 经验写入 + 可靠度 | `node _probe/e2e-knowledge.js` |
| `e2e-skill.js` | 技能库全流程：攒历史 → 存 → 列 → 跑 → 删 | `node _probe/e2e-skill.js` |
| `t1.ps1` / `t2.ps1` / `t3.ps1` | UIA 诊断：CacheRequest.Pop 是否污染输出 / RuntimeId 能否缓存 / 只对入选元素取 rid 的代价 | `pwsh -File _probe/t1.ps1` |

## 依赖

- Rust 内核先编译：`cd pet-core && cargo build --release`
- UIA 服务在跑：`pwsh -File pet-runtime/tools/uia-service.ps1 -Serve -Port 8106`
- 嵌入服务在跑：8090（知识库向量通道用；挂了会退化成纯 BM25，不报错）

## 已知的「预期失败」

- `e2e-click.js` 点 #1（pane 容器）会返回 `not_sent / 元素点不到` —— 这是**正确行为**，pane 本来就不能点。
- 空壳窗口（如 WorkBuddy，Electron 但没启无障碍）会返回 `shellOnly: true` —— 也是正确行为。

## 不要做的事

- **不要在这些脚本里构造假数据**（比如手写 entryHash / successCount）。
  三十五轮踩过：`PVZ 经济位向日葵` 那条技能的 `entryHash: a1b2c3d4e5f60718` 和
  `successCount: 4` 全是编的，违反了「可靠度由世界盖章」的纪律，已删。

---

# 追加（2026-11-10 三十九轮）

## 每轮必跑

| 脚本 | 作用 |
|---|---|
| `check-all.mjs` | **统一门禁**（§27）：语法 13 个 JS + 2 个 py、回归、三个单测、spawn 扫描、doctor 摘要。任何红非零退出。`--fast` 跳过 doctor |

| 脚本 | 作用 |
|---|---|
| `regress-fake-success.cjs` | 契约回归 **14 用例**（含同键连点 region 守卫）。**任何改动后必跑** |
| `remote-say.py` | 拟真发送器（Python + stdin，避 Windows 命令行 GBK）。`echo 消息 \| python _probe/remote-say.py` |
| `test-guard-and-drag.cjs` | 护栏：WindowFromPoint / UAC 正常桌面 / 4px 急停判据 / drag 30 段（5 断言） |
| `test-rust-mouse.cjs` | pet-core `mouse` 快轨：真点中临时窗口 / drag steps=30 / 遮挡否决 / `via=rust`（8 断言） |
| `scan-spawn-hide.cjs` | 扫所有子进程调用，列出缺 `windowsHide` 的（Windows 上会闪黑窗）；退出码 1 = 有遗漏 |

## 四十一轮新增（2026-11-12）

| 脚本 | 验证什么 |
|---|---|
| `scan-spawn-hide.cjs` | 见上；本轮据此修掉 6 处：main.js 三处 `execFileSync`（panel/subtitle/screen_shot）、game-control 五处 pet-core 调用、python-plugin-bridge、mcp-stdio-transport。`pet-runtime/.state/`、`tools/_archive/` 与 dev CLI（petctl/build）保持原样 |

## 四十轮新增（可重复跑）

| 脚本 | 验证什么 |
|---|---|
| `test-skill-sediment.cjs` | 技能自动沉淀纯逻辑：重复命中 / 单次不提示 / 失败断链 / 单步噪声（4/4） |
| `test-guard-and-drag.cjs` | 见上（每一步都有 PASS/FAIL） |
| `test-rust-mouse.cjs` | 见上；含「28ms vs pwsh 773ms」的基准口径 |

## 三十九轮新增（可重复跑）

| 脚本 | 验证什么 |
|---|---|
| `test-mouse-keyboard.cjs` | 双击 / 拖拽 / ctrl+a,c / 中文输入 / 整屏截图 / focus 传 hwnd |
| `test-homing-auto.cjs` | 窗口移动后旧坐标自动补偿（`homed.applied=true`） |
| `test-14-wmsettext.cjs` + `wm-settext-test.ps1` | WM_SETTEXT 填值 + WM_GETTEXT 回读（RichEditD2DPT） |
| `test-xml-fallback.cjs` | XML 伪工具调用兜底（标准 / DSML 双竖线 / JSON 回归） |
| `diag-memos-400.py` | MemOS 400/br 诊断（UA 拦截 + gzip/br 差异） |
| `diag-dhash-quality.py` / `diag-jitter.py` / `diag-shash.py` | 验证通道诊断 |

## 一次性探针（历史保留，多数已过时）

`calc-test` / `controlled-notepad` / `notepad-test` / `np-*` / `hwnd-locked-test` / `hover-click` / `more-mode` / `fk-scan` / `pvz-*` / `test-game-*` / `wait-and-verify-input` / `verify-input-*` / `fix-screenshot-chain`

> 保留只为「当时怎么验证的」可追溯。**不要照抄当回归用**（多数硬编码了当时的窗口标题/坐标）。

## 约定

1. 命名：可重复跑 → `test-<主题>.cjs`；一次性诊断 → `diag-<主题>.py`
2. 输出统一写 `_probe/out/`，**截图/BMP 跑完自己删**（一张全屏 BMP 16MB）
3. 不硬编码窗口标题：用唯一文件名（Win11 记事本单实例多标签，hwnd 差集会失效）
4. 删旧脚本前先 grep，确认没有别的脚本/文档引用
