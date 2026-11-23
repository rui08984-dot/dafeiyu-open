# 设计：状态事实表 + 多源仲裁（FactStore，2026-11-14）

> 范围：只设计状态层与安全闸的接线。**不改代码**，本文是可照着写实现的设计稿。
> 前置阅读：`_incoming/my-neuro/live-2d/js/core/game-loop.js`、
> `pet-runtime/tools/game_detector.py`、`pet-runtime/data/game-profiles/minecraft-1.21.1.json`、
> `docs/设计-纯视觉游戏操作框架-2026-11-14.md`。

---

## 0. 结论先行（五条）

1. **地基已经在跑，别重写，别改名。** `js/core/fact-store.js`（v0 仲裁）+ `_probe/test-fact-store.cjs`（**实测 PASS 23 / FAIL 0**）+ `js/core/mod-provider.js`（TCP 8123 接收端，真 socket 单测 20 条），而且 `game-loop.js` 已经建了一个模块级 `_facts`、`resolveHudGate` 已实现「mod/api 新鲜优先」。**本轮真正缺的不是新模块，是把已经散在 `state()` 里的事实写入收成一条通道、把手工判来源的 `resolveHudGate` 收成一次仲裁、加上验证与观测。**
2. **仲裁只做「打分选 top-1 + 冲突标记」，不做融合。** 不插值、不预测、不投票、不学权重。两个源吵架是**信息问题**，不是数学问题 —— 上层要做的是「知道它在吵」（`conflict` / `distrusted`）然后更保守，而不是把两个数平均成一个都没人信的数。
3. **`ttlMs` 归事实（profile 声明），不归来源。** 来源只能给 `ttlHintMs` 提示。现状是写入方自带 ttl（`player.hp` 写 500、`enemy.cx` 写 120）—— 数值现在是对的，但裁决权在写入方手里，一个源写 5000 就永不 stale。必须收口。
4. **老 profile 零改动靠「投影」：** facts → 与今天**逐字段相同**的扁平 `state`。规则表 `evalCond` / `decide` / **30 条安全闸断言**（任务里说的 20 条是基线；代码已推进到 30 条 = 14 闸 + 7 HUD 来源优先 + 6 规则 + 3 事实表回退）**一行不改**。
5. **视觉是唯一通用验证通道，也是闭环的必要条件。** 视觉挂 = 不发输入（mod 再健康也不行，因为没法验证动作）；视觉读不到 HUD 但 mod 有精确血量 = 可以动（这正是 `resolveHudGate` 已经做对的事）。验证不到就写 `unverifiable`，**绝不写 `verified:true`**。

---

## 1. 现状与差距

| 能力 | 现在有什么 | 缺什么（本轮设计） |
|---|---|---|
| 多源同事实 | `Map<fact, Map<source, rec>>`（fact-store v0） | —— |
| 仲裁 | `score = (conf×0.6 + fresh×0.4) × rank/100`，top-1；`resolveHudGate` 手工实现「精确来源优先」 | `mode:'rank'`、布尔聚合（any-true）、`distrusted`、绝对容差；把 `resolveHudGate` 收成一次 `get()` |
| 过期 | 写入方自带 `ttlMs`，`4×ttl` 剔除 | **事实级 ttl**（profile 说了算）；来源只能给 hint |
| 冲突 | 与次高分源比相对偏差；`loopStatus().factsConflicts` 已暴露 | 只跟「新鲜」对手比；`absTol` 防低值误报；`dangerTol` 触发不可信 |
| 读取 | `get` / `snapshot` / `dump` | `all()`（任务要求名）、`subscribe()`、`explain()` |
| 来源 | `mod-provider.js` 接收端（已跑） | `Provider` 接口、`capabilities()`、调度、健康、**写入越界拒绝** |
| profile | `state.sources.{mod,vision}` 已写进 MC profile | `state.facts`（ttl / 白名单 / 优先级 / safety）+ 老 profile 的默认合成 |
| 安全闸 | 三道闸 + `resolveHudGate`（7 条断言）+ `evalCond` 事实回退（3 条） | 读 facts 的**保守投影**；30 条断言一条不改 |
| 事实写入 | 散在 `state()` 里（`_facts.set` 七八处） | 收成 `vision-provider.publish()` 一个纯函数；每拍一次 `frame()` 冻结 |
| 决策/闸一致性 | 闸已按「精确来源优先」，但返回的 `bars.hp.valid` 仍只来自视觉 | **mod 新鲜时闸放行、hp 规则却失效** → 投影时 `bars[hud].valid` 必须由 `player.hp` 的仲裁结果决定 |
| 验证 | 无 | 动作后回写 `action.last.*` + 规则退避 |
| 观测 | `factsConflicts` 一个计数 | 每帧内存 ring + 1Hz 落盘 + 异常快照 + `explain()` |

**实测基线（本轮跑过）**：`test-fact-store.cjs` PASS 23；`test-game-safety-gate.cjs` **PASS 30**（不是 20）；`test-mod-provider.cjs` PASS 20。
数字会随并行改动增长（本文写作期间就从 20 → 27 → 30）；**不变量不是某个数字，而是「改前改后，同一个测试文件的同一组断言全部通过」**，最终以 `node _probe/check-all.mjs` 为准。

### 1.1 已经落地的实现（别重写，别改名）

| 已有 | 位置 | 形态 |
|---|---|---|
| 事实表 v0 | `js/core/fact-store.js` | `createFactStore({policy,now})` → `set/get/snapshot/dump/configure/reset` |
| 模块级事实表 | `game-loop.js` 第 243 行 | `const _facts = createFactStore()`；`configure({player.hp:500, player.hud:400, scene:400, enemy.cx/cy/frames:120})` |
| 事实写入 | `game-loop.js` `state()` 尾部 | `player.hud` / `player.hp` / `scene` / `enemy.cx/cy/frames`（source 都是 `vision`） |
| HUD 闸 | `game-loop.js` `resolveHudGate()` | mod/api 新鲜 → 放行；否则回视觉；都没配 → 老行为（**7 条断言**） |
| Mod 接收端 | `js/core/mod-provider.js` | `createModProvider({facts, port:8123})`；TCP 一行一 JSON；`source:'mod'`，`conf:0.99` |
| 懒启动 | `game-loop.js` `ensureModProvider()` | `profile.state.sources.mod.enabled` 才起，连不上不影响视觉 |
| 事实名 | 代码里已经用的 | `player.hp` / `player.hud` / `scene` / `enemy.cx` / `enemy.cy` / `enemy.frames` / `player.pos` / `player.food` / `world.dimension` / `enemy.count` / `enemy.nearest.dist` |
| 单测 | `_probe/` | 事实表 23、安全闸 30、Mod 20 |

**本设计对它们的约束是「只加不改」**，具体 delta 见 §1.2。**事实名一律用上表最后一行那套**（`player.hud` 不叫 `readable`，`scene` 不叫 `ui.scene`）—— 新加的事实沿用同一风格（`scene.blocking` / `panel.flat` / `win.fg`），不发明第二套命名。

### 1.2 现有实现需要补的最小 delta（八个小改动）

| # | 文件 | 改动 | 为什么 |
|---|---|---|---|
| D1 | `fact-store.js` | `set()` 的 `ttlMs` **只当 hint**：`effTtl = cfg.ttlMs ?? meta.ttlHintMs ?? meta.ttlMs ?? default` | mod-provider 与 `state()` 现在都在传 `ttlMs`；不改调用点，同时把裁决权收回 profile |
| D2 | `fact-store.js` | 加 `all()`（= `dump()` 别名）、`subscribe()`、`frame()`、`explain()`、`sourceHealth()` | 任务要求的接口；`dump()` 保留 |
| D3 | `fact-store.js` | 加 `mode/aggregate/distrusted/absTol`；白名单（`declare/bindSource`）**默认关闭**，由 `createGameFacts` 打开 | 默认关闭才不破坏 v0 与 mod-provider 的直接写入 |
| D4 | `fact-store.js` | `factCfg` 按 `now` 失效（`configure()` 后不必重建 store） | 换 profile 时不重启循环 |
| D5 | `mod-provider.js` | 加 `capabilities()` → `{mode:'push', facts:['player.*','world.*','enemy.*'], maxHz:20, latencyMs:20, costMs:0, risk:'low'}`；`player.pos` 额外写 `player.pos.x/y/z`；有 `hp` 时同时写 `player.hud = true` | 没有 capabilities 就没有越权拦截与需求抑制；对象事实进不了规则；`player.hud` 不写则诊断分不清「HUD 读不到」和「视觉通道没跑」 |
| D6 | `mod-provider.js` | 信封**可选**加 `instance:{hwnd,pid,world}` 与 `seq`，不匹配/乱序整包丢弃 | 双开/切窗防串局（§7.4） |
| D7 | `game-loop.js` | `state()` 里七八处 `_facts.set(...)` 抽成 `vision-provider.publish(st, store)` **纯函数**；同时补写现在缺的四条：`scene.blocking` / `panel.flat` / `win.fg` / `enemy.area`；`state()` 末尾改成 `publish → frame() → project()`，返回值仍逐字段相同 | 现在写入散在业务代码里，没法单测、没法保证「闸和 decide 看同一拍」；缺这四条，闸投影和验证的 expect 都没有数据源 |
| D8 | `game-loop.js` | `resolveHudGate()` 的**函数体**换成 `store.get('player.hp')` + policy（签名、返回字段、7 条断言全不变） | 手工实现的「精确来源优先」就是仲裁的特例；不换掉，两套规则迟早打架 |

---

## 2. 架构图（一页纸）

```
                        ┌──────────────── L3 规划（LLM，秒级，异步）─────────────────┐
                        │  只读「事实摘要」+ 低频关键帧；输出 intent（不输出键鼠/坐标）│
                        └───────────────────────────┬───────────────────────────────┘
                                                    │ intent.* （也是事实，ttl 几秒）
┌──────────────────┬──────────────────┬─────────────▼─────────────────────────────────────┐
│ 源 Providers     │                  │        FactStore · 每 tick 冻结一次视图            │
│                  │  set(fact,v,{…}) │  ┌──────────────────────────────────────────────┐ │
│ vision  20 Hz    ├─────────────────►│  │ facts:                                        │ │
│  （像素，通用）  │                  │  │  player.hp          ← mod / rcon / vision   │ │
│ rcon     1.5 Hz  │                  │  │  player.hud         ← mod / vision           │ │
│  （服务端只读）  │                  │  │  enemy.cx/cy/frames ← vision                 │ │
│ mod       push   │                  │  │  scene / blocking   ← mod / vision           │ │
│ memory   禁用    │                  │  │  每条: [{value, at, conf, ttlHint, risk}]     │ │
│                  │                  │  └───────┬───────────────────┬──────────────────┘ │
└──────────────────┘                  │  frame()│                   │ subscribe()       │
                                      │  ┌──────▼──────────┐  ┌─────▼───────────────┐  │
                                      │  │ 决策投影 project │  │ 闸投影 gateView      │  │
                                      │  │ 扁平 st（键名不变）│ │ 保守（unknown=拦）   │  │
                                      │  └──────┬──────────┘  └─────┬───────────────┘  │
                                      └─────────┼───────────────────┼──────────────────┘
                                                │ decide(profile, st, cdMap, fails)
                                                ▼                   ▼
                                        ┌───────────────┐   ┌────────────────────┐
                                        │ 规则表 → act  │──►│ checkSafetyGate    │
                                        │  (L2, <1ms)   │   │ 抓帧/前台/场景/HUD/ │
                                        └───────┬───────┘   │ GUI（任一不过=不发）│
                                                │ execute() └─────────┬──────────┘
                                                ▼                     │ 不过
                                        ┌───────────────┐             ▼
                                        │ pet-core 注入 │     ┌──────────────────┐
                                        │ (L0, 1-3ms)   │     │ 不发任何输入，记原因│
                                        └───────┬───────┘     └──────────────────┘
                                                │ 后续 tick（非阻塞队列，settle ≥120ms）
                                                ▼
                                        ┌─────────────────────────────┐
                                        │ 验证 verifier（只用视觉/像素）│
                                        │ region_gray / 事实比较       │
                                        └──────────┬──────────────────┘
                                                   ▼
                                     action.last.verify / action.last.verifyMs
                                     rule.<i>.fails → 冷却指数退避
                                     帧记录 → 内存 ring → game-facts.jsonl
```

### 2.1 数据流（一拍 tick 的固定顺序）

| # | 步骤 | 谁做 | 成本 | 备注 |
|---|---|---|---|---|
| 1 | 处理到期的验证任务（`verifyQueue`） | game-loop | <0.1ms | 不阻塞，先做（上一拍动作的结果可能已经到了） |
| 2 | 抓帧 `game_frame` | pet-core | 1.8ms | 现状 |
| 3 | 检测 `detectorCall` | game_detector | 1–6ms | 现状；scene 仍 250ms 节流 |
| 4 | **写事实**：vision provider 把检测结果归一化后 `set()` | game-facts | <0.05ms | 只写 profile 声明过的事实，越界丢弃 |
| 5 | hub 调度附加源（rcon/mod）的 `poll()` | hub | 0（本拍无到期） | 需求抑制：高档源刚给过就不问 |
| 6 | `store.frame()` **冻结视图**（算仲裁 + diff + 发 subscribe） | FactStore | 0.02–0.05ms | 本拍所有消费者看到同一份结果 |
| 7 | 闸 → 决策 → 执行 | game-loop | <1ms | 顺序不能反：先闸后 decide |
| 8 | 记录帧（内存 ring）；1Hz 或异常时批量落盘 | game-log | 0（本拍不写盘） | **帧路径零 fs 调用**（单测会用 monkeypatch 断言） |

**为什么必须「每拍冻结一次」**：`get()` 是惰性的，如果闸和 decide 各自 `get()`，中间隔 2ms，
ttl 300ms 的事实可能「闸看到新鲜、decide 看到 stale」，或者两次选出不同来源。
冻结视图把「这一拍的真相」变成不可变对象，也顺便把 subscribe 通知从「每 set 一次」压成「每事实每拍最多一次」。

**顺序约束**：Provider 的异步 push 如果发生在第 6 步之后，一律算下一拍 —— 最坏多 50ms 延迟，
换来确定性。这不是妥协，是必须的（否则日志和决策对不上，无法复盘）。

---

## 3. 事实模型

### 3.1 事实模型：只把「需要仲裁的」变成事实（现状名，不改名）

**第一原则：不是所有字段都值得进事实表。** 单源、只给投影/诊断用的字段留在 raw 里，进事实表只会多付仲裁与日志成本。

| 事实 | 谁写 | 决策/闸怎么用（投影目标） |
|---|---|---|
| `player.hp`（0..1 比例） | mod / vision / rcon | 规则 `hp < 0.25` ← `bars[hud].value` |
| `player.hud`（bool：**视觉**能不能读到 HUD） | vision（mod 可选，有 hp 即 true） | 诊断用：解释视觉值为什么不可用；**不决定** `bars[hud].valid` |
| `enemy.cx` / `enemy.cy`（0..1） | vision（motion 主目标） | `act.attack` 的转向 ← `motion.<首个key>.cx/cy` |
| `enemy.frames`（int） | vision | 规则 `enemy.frames >= 2` ← `motion.<key>.frames` |
| `enemy.area`（ratio） | vision（**建议补写**；没写就投影时从 raw 取） | 规则 `enemy.area > 0.004` ← `motion.<key>.area` |
| `enemy.count`（int） | vision / mod | 诊断 + 「几只怪」类规则 |
| `scene`（enum） | vision（模板）/ mod（screen 名） | 闸 `scene` |
| `scene.blocking`（bool） | vision | 闸 `sceneBlocking` |
| `panel.flat`（bool） | vision（平坦度） | 闸 `guiFlat` |
| `win.fg`（bool） | vision | 闸 `fgMatch` |
| `player.pos`（obj）/ `.x/.y/.z` | mod / rcon | 诊断 + 新规则（用标量） |
| `player.food`（0..1） | mod | 新规则 |
| `world.dimension`（enum） | mod | 诊断 |
| `action.last.verify` / `.verifyMs` / `rule.<i>.fails` | verifier | 观测 + 冷却退避（§9） |

**raw 通道（不进事实表，随帧暂存）**：`bars`（除 hud 那条）、`gray`、`colors`、`motion.*.blobs`、`w/h`、`ms`、`frame.path`、`sceneMatched/score`。
理由：单源、变化快、只给投影和诊断用。投影时按现有键名还原（`colors.<key>` / `gray.<key>` / `motion.<key>.blobs` 一个都不改名），所以老 profile 的规则词汇完全不变。

**三条硬约束**：

1. **决策事实必须是标量**（number / string / boolean）。对象/数组事实允许存在（`player.pos`、`player.inventory` 就是），但用途限定为**日志、诊断、未来规划**：
   - 不写进规则条件（`evalCond` 只认数字）；
   - 冲突判定退化为「序列化后是否相等」，所以这类事实必须 `mode:'rank'` 或**单源**；
   - Provider 写对象时同时补对应标量（`player.pos.x/y/z`）。
2. **严格模式下 facts 必须被声明**（`createGameFacts` 打开 strict 时）。写未声明的事实 → `set()` 返回 `false` 并计数。
   理由：防止 Provider（尤其第三方 mod）即席造事实。**v0/mod-provider 直连 store 时不启用 strict**（向后兼容）。
3. **严格模式下，一个来源只能写自己 `capabilities().facts` 声明过的事实**（hub 调 `store.bindSource()` 绑定）。
   理由：一个出 bug 的 mod 不能去写 `win.fg` 或 `scene.blocking` 来骗过安全闸。这是权限边界，不是风格问题。

### 3.2 值域约定

- 比例类一律 0..1（`player.hp` 用**最大生命值的比例**，不是心数；mod 的 `getHealth()/getMaxHealth()`，vision 用 `_hp_baseline` 归一化后同口径）。
- 坐标一律**整帧比例** 0..1（`cx/cy`，与 `game_detector.py` 的 `detect_color_area/detect_motion` 一致，换分辨率不用改 profile）。
- 布尔安全谓词：`true = 拦`（`scene.blocking` / `panel.flat`），未知 → 见 `failClosed`。
- **禁止写 `null`**：读不到就是「没有这个候选」，不是「值是 null」。

### 3.3 默认 ttl 表（老 profile 合成用；数值对齐现状代码）

| 事实 | 默认 ttlMs | 依据 |
|---|---|---|
| `player.hp` | 500 | 现状 `_facts.configure` 就是 500；20Hz 下 = 10 帧 |
| `player.hud` | 400 | 现状 400；HUD 在不在比血量本身变得快（开背包就变） |
| `scene` / `scene.blocking` / `panel.flat` | 400 | 现状 `scene` 400；模板节流 250ms，留 1.6 倍余量 |
| `enemy.cx` / `enemy.cy` / `enemy.frames` / `enemy.area` | 120 | 现状 120（不是理论上的 50：`frames>=2` 的持久性判定要跨 2–3 帧） |
| `enemy.count` / `enemy.nearest.dist` | 400 | mod 侧现状 400（实体列表刷新比像素慢） |
| `player.pos` / `.x/.y/.z` | 400 | mod 现状 400 |
| `player.food` | 800 | mod 现状 800（饥饿值秒级变化） |
| `world.dimension` | 5000 | mod 现状 5000（换维度才变） |
| `win.fg` | 500 | 前台状态变化慢；比抓帧超时（1200ms）短 |
| `action.last.*` | 2000 | 验证结果留 2s 给人看 |

---

## 4. 接口签名（可直接照着写）

文件划分（**只加文件，不搬现有代码**）：

- `js/core/fact-store.js` —— v0 → v1：加 `all/subscribe/frame/explain/bindSource`、`mode/aggregate/distrusted`、事实级 ttl（见 §1.2 D1–D4）。
- `js/core/fact-provider.js`（新，~130 行）—— `createHub()`：注册、启动、`poll` 调度、健康、停止。
- `js/core/game-facts.js`（新，~180 行）—— `createGameFacts(profile)`：建 store + 注册 providers + `publish/project/gateView/verify/record`。
- `js/core/vision-provider.js`（新，~90 行）—— 把现有 `state()` 的检测结果写成事实（**不含抓帧/检测逻辑，那些留在 game-loop**）。
- `js/core/mod-provider.js`（**已存在**）—— TCP 8123 接收端，只补 `capabilities()` 与可选 instance 校验（§1.2 D5–D6）。
- `js/core/rcon-provider.js`（新，~70 行）—— 复用 `pet-runtime/tools/minecraft-rcon.cjs`（注意它的 200ms/120 条每分钟限速）。

### 4.1 FactStore

```js
'use strict';
/**
 * @typedef {Object} FactResult
 * @property {*}            value        仲裁值；undefined = 没有可用候选
 * @property {string|null}  source       胜出来源
 * @property {number}       age          ms；Infinity = 没有候选
 * @property {number}       conf         0..1
 * @property {boolean}      stale        age > 事实级 ttl（消费侧说了算）
 * @property {boolean}      conflict     与最近的新鲜对手偏差 > conflictTol
 * @property {boolean}      distrusted   conflict 且 severity > dangerTol（仅 safety:'hard'）
 * @property {number}       severity     0..1，诊断用
 * @property {boolean}      aggregated   是否聚合值（any-true / all-true）
 * @property {Candidate[]}  candidates   存活候选（explain 时带淘汰原因）
 */

/**
 * @typedef {Object} Candidate
 * @property {string} source
 * @property {*} value
 * @property {number} age
 * @property {number} effTtlMs    事实级 ttl（不是来源自称的）
 * @property {boolean} fresh
 * @property {number} conf
 * @property {number} rank
 * @property {number} score
 * @property {string} risk
 * @property {string} [dropped]   explain 用：'disallowed'|'dead'|'lower-score'|'rival'
 */

/**
 * @param {Object} [opts]
 * @param {Object} [opts.policy]  见 4.4
 * @param {() => number} [opts.now]
 * @param {(level:string, msg:string) => void} [opts.log]
 */
function createFactStore(opts) { /* … */ }

// ── 写入 ───────────────────────────────────────────────────────────────
/**
 * @param {string} fact
 * @param {number|string|boolean|Object|Array} value  禁止 undefined / null；对象/数组仅限诊断类事实（§3.1）
 * @param {Object} meta
 * @param {string} meta.source                    来源名；strict 模式下必须在 bindSource 里注册过
 * @param {number} [meta.conf=0.5]                0..1
 * @param {number} [meta.ttlHintMs]               只是提示；实际 ttl 取 profile 的 facts[fact].ttlMs
 * @param {number} [meta.ttlMs]                   v0 旧名，等价于 ttlHintMs（mod-provider 现在就在用）
 * @param {string} [meta.risk='none']             'none'|'low'|'med'|'high'
 * @param {number} [meta.at]                      注入时间（回放/单测）
 * @returns {boolean}                             false = 未声明 / 越权 / 值非法 / 来源禁用
 */
store.set(fact, value, meta);

// ── 读取 ───────────────────────────────────────────────────────────────
store.get(fact);            // → FactResult（冻结视图内直接返回缓存，不重算）
store.getFrom(fact, 'vision'); // → FactResult（只在该来源的候选里仲裁；验证专用，见 §9.1）
store.all();                // → { [fact]: FactResult }（任务要求名；dump() 保留为别名）
store.snapshot();           // → { [fact]: value }（v0 保留，给老代码/日志）
store.explain(fact);        // → { fact, result, candidates:[{…, dropped, why}] } 逐候选解释

// ── 订阅 ───────────────────────────────────────────────────────────────
/**
 * 只在 frame() 发现 value/source/stale/conflict 变化时触发；每事实每拍最多 1 次。
 * @param {string} fact     事实名或 '*'
 * @param {(cur:FactResult, prev:FactResult|null, fact:string) => void} fn
 * @returns {() => void} 取消订阅
 */
const unsub = store.subscribe('player.hp', (cur, prev) => { /* … */ });

// ── 每拍一次 ───────────────────────────────────────────────────────────
/**
 * 计算仲裁、更新缓存、发订阅通知。幂等：同一 now 重复调不重复发通知。
 * @returns {{ at:number, changed:string[], conflicts:string[], stales:string[] }}
 */
store.frame();

// ── 配置与来源 ─────────────────────────────────────────────────────────
store.configure({ 'player.hp': { ttlMs: 500, allow: ['mod','rcon','vision'], conflictTol: 0.15, absTol: 0.02, safety: 'hard', onConflict: 'block' } });
store.bindSource('vision', ['player.*', 'color.*', 'motion.*', 'gray.*', 'ui.*', 'win.*']);
store.bindSource('mod', ['player.*', 'world.*', 'enemy.*']);
store.declare(['player.hp', 'player.hud', 'scene', 'scene.blocking']);      // strict 模式下未声明的事实 set() 一律拒绝
store.sourceHealth();  // → { vision: { ageMs, writes, hz, misses }, mod: {…} }
store.reset();
store.policy;          // 只读快照
```

### 4.2 Provider

```js
/**
 * @typedef {Object} Capabilities
 * @property {'external'|'poll'|'push'} mode  external = 由 loop 驱动（vision）；poll = hub 定时问；push = 她自己推
 * @property {string[]} facts                 能给哪些事实，支持 'player.*' 通配
 * @property {number} maxHz                   最高写入频率（硬上限，hub 不会超过）
 * @property {number} latencyMs               典型端到端延迟（诊断 + 调度余量）
 * @property {number} costMs                  单次采集成本（预算用）
 * @property {'none'|'low'|'med'|'high'} risk
 * @property {string[]} [requires]            依赖（缺 → start() 直接返回 disabled，不抛）
 */

/**
 * @typedef {Object} ProviderCtx
 * @property {Object} store
 * @property {Object} profile
 * @property {Object} cfg                     profile.state.sources[name]（含 token/端口等）
 * @property {() => number} now
 * @property {(level:string,msg:string)=>void} log
 * @property {(fact:string) => Object|null} factCfg
 */

/**
 * @typedef {Object} Provider
 * @property {string} name
 * @property {() => Capabilities} capabilities
 * @property {(ctx: ProviderCtx) => void|Promise<void>} start
 * @property {() => void|Promise<void>} stop
 * @property {() => ({ok:boolean, ageMs:number, hz:number, misses:number})} [health]
 * @property {(now:number, demand:Object<string,number>) => void|Promise<void>} [poll]  mode='poll' 必填
 */
```

**Provider 契约（写进注释，也写进单测）**：

1. 只能 `set()` 自己 `capabilities().facts` 声明过的事实。
2. **只能出事实，不能出动作**：Provider 拿不到 `execute`，物理上不能驱动鼠标键盘。
3. `start()` 失败只允许「记日志 + 返回」，禁止 `throw` 冒到循环（现状的检测器崩过一次就是教训）。
4. `stop()` 必须幂等（`stopLoop` 可能被调两次）。
5. 不写 `null`；对象/数组只用于诊断类事实（§3.1），决策事实必须是标量。

### 4.3 Hub（调度）

```js
/**
 * @param {Object} opts
 * @param {Object} opts.store
 * @param {Object} opts.profile
 * @param {Provider[]} opts.providers
 * @param {() => number} [opts.now]
 * @param {(l:string,m:string)=>void} [opts.log]
 */
function createHub(opts) { /* … */ }

hub.start();                  // 依次 start()，单个失败只标记 disabled
hub.stop();                   // 逆序 stop()，幂等
hub.tick(now);                // 每个 loop tick 调一次：只调度 mode='poll' 且到期的
hub.health();                 // → { [name]: {ok, ageMs, hz, misses, disabledWhy} }
hub.enabledSources();         // → ['vision','rcon']（给 log / status 用）
```

`tick()` 的调度规则（**只有一个公式，别再加层次**）：

```
对每个 mode='poll' 的 provider p：
  targets = p.capabilities().facts ∩ store.declared()
  if targets 为空 → 不跑（profile 没要求，就不花这个钱）
  interval = max(1000 / p.maxHz, min(effTtl(t) for t in targets) / 2)
  if now - p.lastPoll < interval → 跳过
  需求抑制：若每个 t 都已有「新鲜且 rank ≥ rank(p) + 20」的候选 → 跳过
  预算：若 p.costMs > 本拍剩余预算 → 推到下一拍
  p.poll(now, demand)      // demand 是 {fact: ttlMs}，provider 可据此只查最需要的
```

回答「hp 500ms 够、敌人 50ms、菜单 250ms 怎么调度」（实际落地值：hp 500 / 敌人 120 / 菜单 400）：

- **表达**在 `profile.state.facts[fact].ttlMs`（需求侧）；
- **供给**在 `capabilities().maxHz`（能力侧）；
- **交集**由上面一行公式算出来：`interval = clamp(1/maxHz, ttl/2)`；
- **vision 不走 hub 调度**（它是 `external`，loop 一拍全检一次，所有 vision 事实都拿 20Hz）；
  只有「附加源」走 hub —— 因为多抓一帧不会更贵，多开一个 RCON 会话会。

### 4.4 仲裁函数（纯函数，单测直接调）

```js
/**
 * @param {string} fact
 * @param {Array<{source:string,value:*,at:number,conf:number,ttlHintMs?:number,risk?:string}>} candidates
 * @param {Object} policy
 * @param {number} now
 * @returns {FactResult}
 */
function arbitrate(fact, candidates, policy, now) { /* 见 §5 伪代码 */ }
```

`policy`（全局）+ `factCfg`（每条事实覆盖）：

```js
const DEFAULT_POLICY = {
  sourceRank: { mod: 100, api: 80, rcon: 80, memory: 60, vision: 50, replay: 20 },
  // 旧写法 mcmod 在实现里映射到 mod；profile 只写 mod
  dropAfterTtlRatio: 4,     // >4×ttl = 这个源死了，连兜底都不算
  staleFreshness: 0.15,     // 过期候选的新鲜度（现状硬编码；建议按 age/ttl 连续衰减）
  conflictTol: 0.12,        // 相对偏差
  absTol: 0,                // 绝对偏差（小值域必配，见 §5.2）
  dangerTol: 0.35,          // 超了 → distrusted（仅 safety:'hard'）
  defaultTtlMs: 1000,
  frameLog: true,
  reliability: false,       // P2，默认关（§12）
};

const FACT_CFG_KEYS = [
  'ttlMs',        // 事实级新鲜度需求（唯一有效来源）
  'allow',        // 允许来源白名单；缺省 = 全部已注册来源
  'sourceRank',   // 事实级优先级覆盖（缺省用全局表；写 {mod:100,vision:10} 就是「这条只信 mod」）
  'mode',         // 'score'（默认）| 'rank'
  'aggregate',    // 'top1'（默认）| 'any-true' | 'all-true'
  'conflictTol', 'absTol', 'dangerTol',
  'onConflict',   // 'warn'（默认）| 'prefer-conf' | 'prefer-priority' | 'block'
  'failClosed',   // 布尔聚合无新鲜候选时是否按「拦」算
  'safety',       // 'soft'（默认）| 'hard'（才允许 distrusted 生效）
  'unit',         // 'ratio'|'px'|'bool'|'enum'（低值域自动用 absTol）
];
```

---

## 5. 仲裁算法（伪代码）

### 5.1 主流程

```
function arbitrate(fact, candidates, policy, now):
    cfg        = policy.facts[fact] ?? {}
    effTtl(c)  = cfg.ttlMs ?? c.ttlHintMs ?? policy.defaultTtlMs      # ★ ttl 归事实
    rank(src)  = cfg.sourceRank?[src] ?? policy.sourceRank[src] ?? 40     # 事实级可覆盖全局
    relTol     = cfg.conflictTol ?? policy.conflictTol
    absTol     = cfg.absTol ?? policy.absTol
    dangerTol  = cfg.dangerTol ?? policy.dangerTol

    # ① 准入 + 存活过滤
    live = []
    for c in candidates:
        if cfg.allow and c.source not in cfg.allow:      drop(c,'disallowed'); continue
        if c.risk == 'high' and (cfg.allow is nil or c.source not in cfg.allow): drop(c,'disallowed'); continue
        age = max(0, now - c.at)
        ttl = effTtl(c)
        if age > ttl * policy.dropAfterTtlRatio:          drop(c,'dead');       continue
        live.push({ ...c, age, ttl, fresh: age <= ttl })

    if live is empty:
        return { value: undefined, source: null, age: INF, conf: 0,
                 stale: true, conflict: false, distrusted: false,
                 severity: 0, aggregated: false, candidates: [] }

    # ② 打分（对齐现状实现：conf × 新鲜度 × rank，不是 0.6/0.4 加权和）
    for x in live:
        x.freshness = (x.age > x.ttl)
            ? policy.staleFreshness          # 现状硬编码 0.15：过期但还留着做冲突比对
            : clamp01(1 - 0.4 * (x.age / x.ttl))
        x.rank      = rank(x.source)
        x.score     = x.conf * x.freshness * (x.rank / 100)

    # ③ 选 top-1
    if cfg.mode == 'rank':
        live.sort(by  fresh desc, rank desc, score desc, age asc)
    else:                                   # 'score'，v0 行为
        live.sort(by  score desc, age asc)
    best = live[0]

    # ④ 冲突：只跟「新鲜」的对手比（过期的对手没有发言权）
    rival = first x in live[1:] where x.source != best.source and x.fresh
    conflict = false; severity = 0
    if rival:
        conflict = isConflict(best.value, rival.value, relTol, absTol)
        severity = relDiff(best.value, rival.value)
        if conflict: mark(rival,'rival')

    # ⑤ 不可信（只有安全关键事实才允许升级为「不可用」）
    distrusted = conflict && severity > dangerTol && cfg.safety == 'hard'

    # ⑥ 聚合（只对布尔安全谓词；默认 top1）
    winner = best
    value = winner.value; aggregated = false
    if cfg.aggregate == 'any-true':
        fresh = [x for x in live if x.fresh]
        value = fresh.length ? any(x.value == true) : (cfg.failClosed ? true : false)
        aggregated = true
    elif cfg.aggregate == 'all-true':
        fresh = [x for x in live if x.fresh]
        value = fresh.length ? all(x.value == true) : true
        aggregated = true
    if cfg.onConflict == 'prefer-conf' and conflict:
        winner = maxBy(live, x => x.conf)
        value = winner.value
    if cfg.onConflict == 'prefer-priority' and conflict:
        winner = maxBy(live, x => x.rank)
        value = winner.value

    # ⑦ stale 按事实级 ttl 判（不是选中源自称的）
    stale = winner.age > winner.ttl

    return { value, source: winner.source, age: winner.age, conf: winner.conf,
             stale, conflict, distrusted, severity, aggregated, candidates: live }
```

### 5.2 冲突判定（`absTol` 为什么必须有）

```
relDiff(a, b) = |a-b| / max(|a|, |b|, 1e-6)

isConflict(a, b, relTol, absTol=0):
    if both numbers:
        return relDiff(a,b) > relTol AND |a-b| > absTol
    return String(a) != String(b)
```

真实反例（这是必须加的理由，不是洁癖）：

- hp = 0.01（残血）vs 0.03（快死了），相对偏差 67% → 报 conflict；
  但两者都意味着「濒死」，按 67% 去 block 会把「后退保命」这条最该做的动作拦掉。
  配 `absTol: 0.02` 后不报。
- hp 是比例（0..1）**必须配 absTol**；`enemy.area`（0.000x 量级）也要配（0.002）；
  计数类（`frames`、`count`）用 `absTol: 0`。

默认 `absTol = 0` —— **不改 v0 的 `isConflict(0.5, 0.52, 0.12) === false`**，v0 的 23 条断言全部照旧。

### 5.3 冲突怎么处理（按事实类型分流）

| 事实类型 | `onConflict` | 行为 | 为什么 |
|---|---|---|---|
| `player.hp`（`safety:'hard'`） | `block` | 仲裁值保留在 `value`，但 `distrusted:true` → 闸按「HUD 读不到」拦 | 两个源差 35% 以上时，**猜错的代价是她被打死**；停下比猜更安全 |
| `scene.blocking` / `panel.flat`（布尔安全谓词） | `warn` + `aggregate:'any-true'` | 任一源说拦就拦 | 安全谓词不选一个，求并集：宁拦错，不放错 |
| `enemy.*` | `warn` | 取仲裁值，`conflict:true` 进日志 | 打错一个怪是可接受的；停手不可接受（会被咬） |
| `scene`（诊断用名字） | `prefer-priority` | 高档源的名字，用来写「原因」 | 名字只影响提示文案，不影响拦不拦 |
| `player.pos.*` | `warn` | 取仲裁值 | 不影响安全 |

**一句话原则**：安全谓词求并集（any-true），诊断谓词选权威（rank），控制值选最新最可信（score）。

### 5.4 `aggregate` 的 stale 语义

布尔谓词没有「值过期」这回事，只有「没人说话」。规则：

```
fresh = [候选里 age <= ttl 的]
any-true : 有 fresh 候选 → OR；一个都没有 → failClosed ? true : false
all-true : 有 fresh 候选 → AND；一个都没有 → true（等于不提反对）
```

`scene.blocking` 配 `failClosed: true`；`panel.flat` 配 `false`（平坦度是粗闸，视觉死了由 `ok` 兜底，别双重拦）。

聚合结果的 `source` 字段是**最高分发言者**，不是「这个值的所有者」—— 看到 `aggregated:true` 时，别拿 `source` 去追责（比如「是 mod 说被拦的」），要看 `candidates`。

---

## 6. 降级矩阵（源挂了 / 变旧 / 吵架时，谁更保守）

| 情况 | 事实状态 | 决策层 | 安全闸 | 日志/状态里能看到 |
|---|---|---|---|---|
| mod 停了 200ms | `player.hp` 仍 fresh（ttl 500） | 用 mod 值 | 正常 | `src: mod, age: 200` |
| **视觉读不到 HUD，但 mod 新鲜**（F1/创造/状态效果/心形变色） | `player.hp` fresh from mod；`player.hud` 可能 false | 用 mod 值 | **放行**（现状 `resolveHudGate` 已这么做，hpSource='mod'） | `hpSource:'mod'` |
| mod 停了 1s | mod 候选 stale、vision fresh → score 自动回落 | 用 vision 值 | 正常（vision 能读 HUD） | `src: vision`，`cf:false` |
| mod 停了 4s | mod 候选被剔除（4×ttl） | 用 vision | 正常 | `dropped:'dead'`（explain 可见） |
| 两源 hp 差 > dangerTol | `distrusted:true` | 所有依赖 hp 的条件为 false（不按濒死乱动） | **拦**：`HUD 读不到（两源偏差过大：mod 0.90 / vision 0.30）` | `cf:true, distrusted:true` |
| vision 抓帧失败 | `win.fg` 过期 → `ok:false` | 不决策 | **拦：抓帧失败**（第 1 断言语义不变） | 错误计数 +1 |
| vision 挂了但 mod 健康 | 同上 | 不决策 | **拦** —— 视觉是唯一验证通道，没有它就没有闭环 | `src.vision.ok:false` |
| 所有源对 hp 都 stale | `value:undefined, stale:true` | 条件为 false | **拦：HUD 读不到** | `stale:true` |
| `scene.blocking` 任一源 true | `aggregate` 为 true | —— | **拦：场景不对** | 谁说的写在 candidates |
| 菜单状态两源冲突 | any-true → true | —— | 拦（保守） | `cf:true`，可以用来发现模板/模组有一方坏了 |
| 规则连续验证失败 3 次 | `rule.<i>.fails = 3` | 冷却 ×4，等于自动降频 | 不影响 | `game status` 的 `ruleFails` |

**关键设计**：降级不是异常分支，是**常态分支**。所以：

- 没有任何「源掉线 → 抛错 → 整个循环停」的路径（除了「视觉连续失败 30 次」，那是现状的自我保护）；
- 任何 `stale / conflict / distrusted / no-fresh` 都只会让**闸更严**，绝不会让闸更松；
- `checkSafetyGate` 里所有「未知」一律 fail-closed（继承里现有审计原则：没 HUD 就没闸）。

---

## 7. profile 形状

### 7.1 老 profile：**零改动**

`state` 块不存在时，`createGameFacts(profile)` 按 §3.3 的默认表**合成**事实声明（只合成「需要仲裁的那几条」，其余走 raw）：

```
detect.bars.<hud>          → player.hp（值）+ player.hud（视觉可读性）      ttl 500 / 400
detect.motion.<name>       → enemy.cx / enemy.cy / enemy.frames               ttl 120
detect.scenes              → scene / scene.blocking                           ttl 400
detect.gui                 → panel.flat                                       ttl 400
（每帧恒有）                → win.fg                                           ttl 500
—— 以下不进事实表，随帧 raw 暂存 ——
detect.colors.<name>.*     → raw.colors（规则仍按 colors 解析，顺序不变）
detect.gray.<name>.*       → raw.gray
detect.motion.<name>.blobs / bbox → raw.motion（只给 execute/诊断）
```

所有事实 `allow: ['vision']`，行为与今天逐字段一致（§11 步骤 1 用 golden 测试证明）。

**已知限制（不在本轮修）**：现状代码把血条事实名硬编码成 `player.hp`，即使 profile 的 `safety.hud` 叫 `stamina` 也一样。
多 HUD 游戏（血/蓝/体力三条）要改成 `player.<hudName>` —— 那是 P2，当前 `['hp']` 足够。
写在这里是为了避免「以为已经支持多 HUD」。

**投影的键名口径（防止语义漂移）**：`enemy.*` 事实只还原到 `motion.<该 profile 的第一个 motion 键>`；`colors.*` 永远从 raw 还原，不被 facts 覆盖。这样「`enemy.area` 在规则里优先解析 colors、其次 motion」的现有顺序**保持不变**，即使两个块用了同名 key。

**投影的边界（关键）**：投影**只还原 legacy 键**（`bars/motion/colors/gray/scene/hpValid/...`），**不把新事实塞进 `st`**。
因为 `evalCond` 现在的取值顺序是「`st` 里的键优先，没有才查 `_facts`」—— 把 `player.food` 这类新事实塞进 `st`，
反而会让规则读到投影值而不是仲裁值（等于绕过仲裁）。新事实就让规则直接写 `player.food < 0.3`。

**投影的 valid 口径（修一个现状坑）**：`bars[hud].valid` 必须由 `player.hp` 的**仲裁结果**决定（有新鲜候选且 `!distrusted`），不能再用视觉的 `player.hud`。
现状代码里 `hpValid`（闸）已经走 `resolveHudGate`（mod 新鲜就放行），但返回的 `bars.hp.valid` 仍是视觉结果 ——
于是「mod 有精确血量、视觉读不到 HUD」时，**闸放行、规则却全部失效**（`evalCond` 拿不到 hp）。
这是多源接入后第一个必须一并修掉的一致性问题（步骤 1 的 golden 测试要专门覆盖这个 case）。

### 7.2 MC 版：hp 走 mod + 视觉兜底，敌人位置走视觉，菜单走模板

```json
{
  "game": "minecraft-1.21.1",
  "window": "Minecraft 1.21.1",
  "fps": 20,
  "keys": { "forward": "w", "back": "s", "attack": "mouse_left", "inventory": "e" },

  "detect": {
    "bars":   { "hp": { "roi": [0.3218, 0.8584, 0.1522, 0.0198], "color": "heart" } },
    "motion": { "enemy": { "roi": [0.06, 0.12, 0.88, 0.62], "threshold": 20, "min_area": 0.0012 } },
    "scenes": { "inventory": { "templates": ["scenes/inventory.png"], "roi": [0.28,0.18,0.44,0.7], "match": 0.8 },
                "death":     { "templates": ["scenes/death.png"],     "roi": [0.3,0.22,0.4,0.22],  "match": 0.85 } }
  },

  "state": {
    "sources": {
      "vision": { "provider": "vision", "enabled": true, "conf": 0.70 },
      "mod":    { "provider": "mod",    "enabled": true,
                  "port": 8123, "host": "127.0.0.1",
                  "staleAfterMs": 3000, "instanceMatch": true },
      "rcon":   { "provider": "rcon",   "enabled": false,
                  "host": "127.0.0.1", "port": 25575,
                  "passwordEnv": "MC_RCON_PASSWORD",
                  "player": "Steve" }
    },

    "facts": {
      "player.hp": {
        "ttlMs": 500, "unit": "ratio", "safety": "hard",
        "allow": ["mod", "rcon", "vision"],
        "mode": "score", "onConflict": "block",
        "conflictTol": 0.15, "absTol": 0.02, "dangerTol": 0.35
      },
      "player.hud": {
        "ttlMs": 400, "unit": "bool",
        "allow": ["mod", "vision"], "mode": "rank"
      },
      "enemy.area":   { "ttlMs": 120, "unit": "ratio", "allow": ["vision"], "absTol": 0.002 },
      "enemy.frames": { "ttlMs": 120, "allow": ["vision"], "absTol": 0 },
      "enemy.cx":     { "ttlMs": 120, "unit": "ratio", "allow": ["vision"], "mode": "rank" },
      "scene":              { "ttlMs": 400, "unit": "enum",
                              "allow": ["mod", "vision"], "onConflict": "prefer-priority" },
      "scene.blocking":     { "ttlMs": 400, "unit": "bool", "safety": "hard",
                              "allow": ["mod", "vision"], "aggregate": "any-true", "failClosed": true },
      "panel.flat":         { "ttlMs": 400, "unit": "bool", "allow": ["vision"],
                              "aggregate": "any-true", "failClosed": false },
      "win.fg":             { "ttlMs": 500, "unit": "bool", "allow": ["vision"] },
      "player.pos.x":       { "ttlMs": 1500, "allow": ["mod", "rcon"], "absTol": 0.5 },
      "player.food":        { "ttlMs": 1000, "allow": ["mod"], "unit": "ratio" }
    },

    "budget": { "frameLog": true, "logHz": 1, "reliability": false }
  },

  "rules": [
    { "if": "hp < 0.25", "act": { "kind": "hold", "key": "s", "ms": 700 },
      "why": "濒死：后退拉开距离", "cooldown": 1400,
      "expect": [ { "fact": "player.hp", "op": ">=", "value": 0.25, "withinMs": 2500, "soft": true } ] },

    { "if": "enemy.area > 0.004 && enemy.frames >= 2", "act": { "kind": "attack", "from": "enemy" },
      "why": "画面里有东西在动且连续两帧都在：转向并攻击", "cooldown": 200,
      "expect": [ { "fact": "enemy.area", "op": "<", "value": 0.004, "withinMs": 700, "soft": true } ] },

    { "if": "hp < 0.5", "act": { "kind": "key", "key": "inventory" },
      "why": "血量过半：开背包换食物", "cooldown": 4000,
      "expect": [ { "fact": "panel.flat", "op": "==", "value": true, "withinMs": 500 } ] },

    { "if": "always", "act": { "kind": "none" }, "why": "待命" }
  ]
}
```

**注**：

- **优先级只有一处**：全局 `policy.sourceRank`。`allow` 只管「谁能进来」，不管「谁赢」—— 避免两份优先级打架。
  某条事实要特殊（例如 `scene` 只信 mod）时，在 fact 上写 `sourceRank:{mod:100, vision:10}` 覆盖，而不是改数组顺序。
- **RCON 只对「自有专服 / 开了 rcon 的 LAN 世界」成立**：单机集成服默认没有 RCON 入口。再加它 200ms/条 + 120 条/分钟（`minecraft-rcon.cjs` 的 `rateGate`）≈ **≤1.5Hz**，所以 `rcon` 只做兜底，`ttl 500ms` 由 vision 满足。想让 rcon 主供 hp 必须把 ttl 提到 ≥ 800ms —— 那就不是「hp 500ms 够」了。**能力决定不了需求，需求也不会因为有个慢源就变慢。**
- `instanceMatch: true`：mod 的 push 信封必须带 `hwnd`/`pid`/`world`，与当前 profile 目标窗口不一致就丢弃（防切窗/双开时事实串局）。

### 7.3 规则里的 `expect`（验证约定）

```json
"expect": [
  { "fact": "player.hp", "op": ">=", "value": 0.25, "withinMs": 2500, "soft": true },
  { "region": [0.4, 0.4, 0.2, 0.2], "minChange": 0.04, "withinMs": 400 },
  { "absent": "enemy.area", "withinMs": 700 }
]
```

- `fact`：用 `getFrom(fact,'vision')` 读**视觉侧**的值做比较（不是跨源仲裁值）；`op` 支持 `> >= < <= == !=`。
- `region`：调 pet-core 的 `region_gray`（12×10 灰度，GDI 局部 BitBlt，10ms 级），比较动作前后的 `mean/std` 变化 —— 这是现有 `game-control.js` 的 `actAndVerify` 已经在用的路子。
- `absent`：事实变成「没有新鲜候选」。
- `soft: true`：没达成只记 `failed`，不惩罚规则（环境噪声大）。
- **一条 expect 都没有 → `verified` 记为 `'unverifiable'`，不是 `true`。**

### 7.4 mod 通道协议（接收端已实现，协议以代码为准）

**现状**：`js/core/mod-provider.js` 已经在跑，**TCP 127.0.0.1:8123 + 一行一个 JSON**（不是 WebSocket）。
mod 侧（Java）还没写，所以协议现在只有接收端这一半是真的。字段（见该文件头注释）：

```json
{ "t": 1731600000000,
  "hp": 18.0, "maxHp": 20,
  "food": 17,
  "x": 12.3, "y": 64.0, "z": -8.1,
  "dim": "minecraft:overworld",
  "entities": [{ "type": "minecraft:zombie", "dist": 3.2 }],
  "inventory": [{ "slot": 0, "id": "minecraft:bread", "count": 3 }] }
```

接收端翻译成：`player.hp`（hp/maxHp 归一化）、`player.maxHp`、`player.food`（/20）、`player.pos`（对象）、
`world.dimension`、`enemy.count`、`enemy.nearest.dist`、`enemy.nearest.type`、`player.inventory`（数组），
一律 `source:'mod'`、`conf:0.99`。

**只提三个「补强」建议（都向后兼容，不影响已跑的字段）**：

| 建议 | 字段 | 理由 |
|---|---|---|
| 实例校验 | `instance:{hwnd,pid,world}`（可选） | 双开/切窗时防止事实串局；缺失则不校验（现状行为） |
| 重放/串包 | `seq`（可选，单调递增） | 跳变/回绕 → 整包丢弃并计 `miss`；缺失则不校验 |
| 规则可读的标量 | 在 `ingest` 里同时写 `player.pos.x/y/z` | 对象进不了 `evalCond`（§3.1 约束 1） |

**明确不做**：mod 端实现、加密握手、双向 RPC、让 mod 触发动作（mod 只能出事实）。
绑定只许 `127.0.0.1`；不引入 token 是因为本机回环 + 端口随机可改，加 token 的收益小于让 mod 作者多写十行的成本 —— 这条如果将来要上远程，再单独立项。

---

## 8. 安全闸改造（30 条断言为什么还全过）

### 8.1 现状：闸已经有两个入口的雏形

```js
// 现状（已提交）
checkSafetyGate(st)                       // 扁平状态 → 五道判据
resolveHudGate({hpConfigured, requireHp,   // HUD 闸的「精确来源优先」：手工版仲裁
                hpValidFinal, modHp})       // → {hpValid, hpSource}
```

`state()` 现在就是 `... hpValid: _hudGate.hpValid`，并额外返回 `hpSource` 与 `factsConflicts`。

**v1 只做两件事，都不改签名**：

```js
// ① resolveHudGate 的函数体换成一次仲裁（签名、返回字段、7 条断言全不变）
function resolveHudGate(opts) {
  const o = opts || {};
  // o.modHp 保留为单测注入缝（7 条断言就是靠它喂候选）；生产调用点不再传，走 store
  const r = o.modHp || _facts.get('player.hp');
  if (r && !r.stale && !r.distrusted && typeof r.value === 'number') {
    return { hpValid: true, hpSource: r.source };
  }
  if (o.hpConfigured === true) return { hpValid: o.hpValidFinal === true, hpSource: 'vision' };
  return { hpValid: o.requireHp === false, hpSource: 'none' };
}

// ② checkSafetyGate 加一个入口：事实门面优先，扁平对象直通
function checkSafetyGate(input) {
  const st = (input && typeof input.gateView === 'function') ? input.gateView() : input;
  if (!st || !st.ok) return '抓帧失败';
  if (st.fgMatch === false) return '目标窗口不在前台（SendInput 会打进别的应用）';
  if (st.sceneBlocking) { /* …原文不动… */ }
  if (st.hpConfigured === false && st.requireHp !== false) { /* …原文不动… */ }
  if (st.hpValid === false) return 'HUD 读不到' + (st.hpWhy ? '（' + st.hpWhy + '）' : '');
  if (st.guiFlat) return '检测到 GUI 面板（背包/箱子/菜单）';
  return null;
}
```

`gateView()` 输出与今天的 `state()` **同名同义**字段：

| gateView 字段 | 来源（facts） | 未知/过期时 |
|---|---|---|
| `ok` | `win.fg` 有新鲜候选 | 无 → `false`（= 抓帧失败，fail-closed） |
| `fgMatch` | `win.fg` | 无 → `false` |
| `scene` / `sceneMatched` | `scene` + raw 的 score | `scene` stale → `'unknown'` + `score:0` |
| `sceneBlocking` | `scene.blocking`（any-true） | 无新鲜 → `failClosed` → `true` |
| `hpConfigured` | profile 的 `detect.bars[hud]` 或任一启用的 provider 声明 `player.hp` | 计算一次，不逐帧 |
| `requireHp` | `safety.requireHp !== false` | 同上 |
| `hpValid` | `resolveHudGate`（内部走 `player.hp`：`!stale && !distrusted`） | 无新鲜候选 → `false` |
| `hpWhy` | `distrusted` 的偏差描述 / `stale` 的源名 | 无 |
| `guiFlat` | `panel.flat`（any-true） | 无 → `false` |

### 8.2 30 条断言逐组对照（`_probe/test-game-safety-gate.cjs` **一行不改**）

| 断言组 | 条数 | 为什么还过 |
|---|---|---|
| 抓帧失败 / 空状态 | 2 | 传 `null` / `{ok:false}`，不是门面 → 走原分支，判断完全没变 |
| 前台 / 旧形状 | 3 | 扁平对象直通；`st.fgMatch === false` 判据原文未动 |
| HUD 三道（没配/放弃/读不到） | 3 | `hpConfigured`/`requireHp`/`hpValid` 三字段名与语义保持；`hpWhy` 只在存在时**追加**在括号里，旧的 `includes('HUD 读不到')` 仍命中 |
| 全绿放行 | 1 | 字段齐全，六道判据全过 |
| GUI 面板 | 1 | `guiFlat` 字段不变 |
| 场景四条（含「场景优先于 HUD」） | 4 | `scene`/`sceneBlocking` 与判据顺序不变（场景闸仍在 HUD 闸之前） |
| **HUD 来源优先（`resolveHudGate`）** | **7** | 函数签名与返回字段不变，只是函数体从「手写 if」换成「`get()` + policy」；7 条断言的输入/输出契约完全相同 |
| `evalCond` 六条 | 6 | 决策投影保持 `bars/motion/colors` 的键名与形状（投影后 `motion.enemy.frames` 仍是数字），`evalCond` 的取值顺序不变 |
| **`evalCond` 事实表回退** | **3** | 现状已经实现「st 里没有的键 → `_facts.get(lhs)`」；投影保持「st 优先」，这 3 条不受影响 |
| 合计 | **30** | 实测现状 PASS 30 / FAIL 0；改后必须仍然 30/0 |

**新增**（不替代，只增补）：`_probe/test-gate-from-facts.cjs`，把上面 30 条用**事实门面**重写一遍，再加 8 条
（`win.fg` 缺失→`抓帧失败`、`scene.blocking=true`→`场景不对`、`player.hp` 无新鲜候选→`HUD 读不到`、
`player.hp` 两源偏差 > dangerTol→`HUD 读不到（两源偏差过大…）`、`player.hp` 全部 stale→`HUD 读不到`、
`panel.flat` stale→不拦、`scene` stale→`场景不对（unknown）`、空 store→`抓帧失败`）。
这样两条路径的行为等价是被断言钉住的，而不是靠口头保证。

---

## 9. 动作验证与回写

### 9.1 为什么视觉是唯一验证通道

- mod 报的 hp 是**同源**的：mod 说「血回到 0.8」，不能证明我们的按键让角色吃了东西（可能是自然回复/队友治疗）。
- 只有像素是「我们发出的动作 → 世界真的变了」的独立证据。
- 所以：**verifier 只读 vision 侧事实 + `region_gray`，永不读 mod 自报。**
  注意读法：用 `store.getFrom(fact, 'vision')` 而**不是** `store.get(fact)` —— 后者返回的是跨源仲裁值
  （可能来自 mod），拿它做验证就是同源自证。

### 9.2 非阻塞验证队列

```
execute(act) 返回后：
    task = { id, ruleIndex, actKind, at: now,
             settleAt: now + settleMs,          // 默认 120ms（20fps 下 ≥2 帧）
             checks: rule.expect ?? [],
             before: 快照（expect 涉及的 fact 当前值） }
    verifyQueue.push(task)                      // 不 await

每个 tick 开头（步骤 1）：
    for task in verifyQueue where now >= task.settleAt:
        处理：逐条 check 在当前**视觉**事实里求值
          - fact 比较：getFrom(fact,'vision') fresh ? 比较 : 'pending'
          - region：coreCall region_gray → |mean-before| / |std-before| >= minChange
          - absent：无新鲜候选
        若全部 'pending' 且 now < task.at + maxWithinMs → 保留，下一拍再看
        否则定案：
          confirmed    : 所有非 soft 的 check 命中
          failed       : 任一非 soft check 明确未命中
          unverifiable : checks 为空 / 全是 soft 且未命中
        写事实（source:'verifier', conf:1）：
          action.last.verify     = 'confirmed'|'failed'|'unverifiable'   ttl 2000
          action.last.verifyMs   = 耗时                                   ttl 2000
          action.last.verifyWhy  = 'hp 0.25→0.38' 之类                    ttl 2000
          rule.<i>.fails         = 连续失败计数（成功清零）                ttl 30000
```

**为什么不能同步等**：现有 `hold` 已经吃过一次教训（`core` 里 sleep 700ms → 闭环从 20fps 掉到 1.4Hz）。
验证必须和决策解耦。

### 9.3 回写怎么影响行为（三处，都很小）

1. **闸**：`action.last.verify === 'failed'` 本身不拦（动作已经发出去了，拦没意义），但进 `game status` 与日志，让人能看见「她在瞎按」。
2. **规则退避**：`decide(profile, st, cdMap, ruleFails)`，新增第 4 参数（可选，缺省 `{}`）：
   `cdEff = cooldown * min(4, 1 + fails)`。连续验证失败 3 次的规则自动降频 4 倍，**不自动删除**（删了没人知道为什么她不打了）。
3. **可选（P2，默认关）**：`policy.reliability` 打开后，按 `(source, factClass)` 维护 `EWMA(0.9w + 0.1·outcome)`，乘进 score。默认关的理由见 §12。

### 9.4 与 `dispatch-history.jsonl` 的语义对齐

| 字段 | 取值 | 含义 |
|---|---|---|
| `verified` | `true` / `false` / `null` | 只有真的观察到预期变化才写 `true` |
| `effect` | `confirmed` / `not_sent` / `unverifiable` | 与现有派活日志同一套词汇 |

**禁止**：动作返回 `ok:true` 就把 `verified` 写成 `true` —— 那是「收到回执」不是「世界变了」，本项目已经为此栽过一次（`复盘-真假成功与系统性治理`）。

---

## 10. 可观测性（每帧记录 + 能复盘）

### 10.1 两级：内存环形缓冲（每帧）+ 落盘（1Hz / 异常）

**每帧都落盘是错的**：20fps × 十几条事实 × JSON ≈ 15KB/s 的同步 fs 调用，会把 6ms 的帧预算吃掉。
正确做法是**每帧进内存 ring（零 IO），异常时连同前 300 帧一起倒出来**。

```js
// 内存 ring：cap 300（≈15 秒历史 @20fps），~700B/帧 ≈ 210KB
ring.push({
  ts, tick, ms,                      // ms = 本拍耗时
  facts: {                           // 只记「参与过决策或闸」的事实，十几条以内
    'player.hp':          { v: 0.62, src: 'rcon',   age: 180, conf: 0.95, stale: false, cf: false },
    'scene.blocking':     { v: false, src: 'vision', age: 12, conf: 0.80 },
    'enemy.area':         { v: 0.008, src: 'vision', age: 12, conf: 0.70 },
  },
  gate:   { ok: true, why: null },                  // ok=false 时 why 必填
  decide: { rule: 1, why: '画面里有东西在动且连续两帧都在' },
  act:    { kind: 'attack', ok: true, held: null },
  verify: { state: 'unverifiable', ms: 0, why: 'no-expect' },
  src:    { vision: { age: 12, hz: 19.8, miss: 0 }, rcon: { age: 180, hz: 1.4, miss: 0 } },
});
```

**落盘策略**（照抄 `skill-library.js` 的 `_flushHistory` 模式，别发明新轮子）：

- 批量 append，**1Hz 心跳**写一行（不是每帧）；
- 一旦出现 `gate.ok === false` 持续 >1s、`cf:true`、`distrusted:true`、`verify:'failed'` → **立即把整个 ring（300 帧）倒进文件一次**，带 `"dump":"anomaly"` 标记；
- 每 50 次写做一次滚动压缩到最近 **5000 行**（约 1.2MB ≈ 83 分钟）；用 `json-store.js` 的 `writeJsonl`；
- 路径 `pet-runtime/data/game-facts.jsonl`（和 `dispatch-history.jsonl` 同级），UTF-8，一行一 JSON；
- 进程退出时 `flush()`（挂在 `process.once('exit')`，和 `closeDetector` 同一个位置）。

### 10.2 三条诊断出口

```js
store.explain('player.hp')
// → { result:{value:0.62,source:'rcon',…},
//     candidates:[
//       {source:'mod', value:0.62, age:4200, ttl:500, fresh:false, dropped:'dead'},
//       {source:'rcon',  value:0.62, age:180,  ttl:500, fresh:true,  score:0.76, why:'winner'},
//       {source:'vision',value:0.60, age:300,  ttl:500, fresh:true,  score:0.42, why:'lower-score'} ] }

hub.health()
// → { vision:{ok:true, ageMs:12, hz:19.8, misses:0},
//     rcon:{ok:false, ageMs:4200, hz:0, misses:3, disabledWhy:'RCON 密码错误'} }

gameLoopStatus().facts
// → { conflicts5m: 2, distrusted5m: 0, lastGateWhy: '…', lastVerify: 'confirmed', ruleFails:{2:1} }
```

`game` 工具的 `action=status` 增加上述三个字段（**只加字段，不改现有字段**），模型问「她为什么不动」时能直接看到原因。

---

## 11. 迁移步骤（4 步，每步独立可验证、可回滚）

### 步骤 1｜把散写的 facts 收成一条通道 + 投影往返（单源时零行为变化）

**现状问题**：`state()` 里已经有 7 处 `_facts.set(...)`，和返回对象混在一起 —— 没法单测、没法保证「闸和 decide 看同一拍」。
**做什么**：抽成 `vision-provider.publish(st, store)`（纯函数，只 `set`）与 `projectState(store, raw)`；
`state()` 变成 `publish → frame() → project`；`_probe` 加 `test-state-projection.cjs`：
12 份录制的 `state()` 输出（覆盖 hp 有效/无效/缺基线、scene 三态、motion 多 blob、colors 缺失）走
`publish → frame → project`，**视觉单源时深比较必须逐字节相等**；另加 2 条 mod 场景：
`player.hp` 新鲜但视觉读不到 HUD 时，投影出的 `bars.hp.valid` 必须为 true（修 §7.1 那个一致性坑）。

**验收**：

```bash
node _probe/test-fact-store.cjs        # PASS 23 / FAIL 0（不许变）
node _probe/test-game-safety-gate.cjs  # PASS 30 / FAIL 0（不许变）
node _probe/test-mod-provider.cjs      # PASS 20 / FAIL 0（不许变）
node _probe/test-state-projection.cjs  # 新增，PASS ≥ 24 / FAIL 0
node _probe/check-all.mjs
```

**回滚**：`state()` 改回内联 `set`（diff 很小）。

### 步骤 2｜安全闸读事实（判据不动，只换 `resolveHudGate` 的实现）

**做什么**：`resolveHudGate` 函数体换成 `store.get('player.hp')` + policy（`modHp` 保留为注入缝，§8.1）；
`checkSafetyGate` 加 `gateView` 入口；`tick()` 把 `facts` 门面传进去；
新增 `_probe/test-gate-from-facts.cjs` 镜像 30 条 + 8 条冲突/过期。

**验收**：老测试 30/0、新测试 38/0、`game see` 返回值与步骤 1 完全相同（golden）。

**回滚**：`resolveHudGate` 恢复手写 if；`checkSafetyGate` 头部一行三元表达式改回直通。

### 步骤 3｜把已有的 mod 通道接进闭环（再加 RCON 兜底）

**做什么**：
1. `mod-provider.js` 补 `capabilities()`（D5）与可选 instance 校验（D6），由 `createGameFacts(profile)` 注册；
   `stopLoop`/`closeDetector` 里 `hub.stop()`（和检测器同一个退出点，别留孤儿 socket）。
2. `rcon-provider.js`（复用 `minecraft-rcon.cjs`，`mode:'poll'`, `maxHz:1.5`,
   `facts:['player.hp','player.hud','player.pos.x']`），**默认关闭**；只在专服/开了 rcon 的 LAN 世界才启用（单机集成服没有 rcon 入口）。
3. MC profile 的 `state.sources.mod.enabled` **现在已经是 `true`**（端口 8123）—— 本步的验收重点是
   「**没连上 mod 时零影响**」，而不是把它关掉。

**验收**（真机，三次）：
1. 全关 → `game status` 里 `src.vision` 有值、`src.mod/rcon` 为 `disabled`，行为与今天无差异；
2. 开 mod（本地起一个 `nc 127.0.0.1 8123` 喂一行 `{"hp":18,"maxHp":20}`）→ `player.hp` 的 `src` 变 `mod`；
   停喂 3s → 自动回落 `vision`，`mod.silent:true`，循环**不中断**；
3. 开 rcon → `player.hp` 的 `src` 变 `rcon`；改错密码 → 回落 `vision`，`rcon.disabledWhy` 写明原因。

**回滚**：profile 开关改回 `false`。

### 步骤 4｜验证回写 + 帧记录落盘

**做什么**：`verifyQueue`（§9.2）、`rule.<i>.fails` 退避（`decide` 加第 4 参数）、
`game-facts.jsonl`（1Hz + 异常快照）、`game status` 三个新字段。

**验收**：
1. 跑 3 分钟，`game-facts.jsonl` 行数 ≈ 180（1Hz），无单行 >2KB；
2. 故意把 `player.hp` 的 `expect` 写成永远不成立 → 该规则 3 次后 `cooldown` 实际 ×4（日志可测）；
3. monkeypatch `fs.appendFileSync` 断言**帧路径调用次数为 0**；
4. `node _probe/test-mod-provider.cjs` 与 `check-all.mjs` 全绿。

**回滚**：`budget.frameLog:false` 关日志；`expect` 不写就是 `unverifiable`，不影响决策。

---

## 12. 不做清单（明确现在不做）

| 不做 | 为什么 |
|---|---|
| Kalman / 插值 / 位置预测 | 敌人位置 50ms 一帧，外推 1 帧的收益 < 引入的抖动与调参成本；打错一个怪的代价也低 |
| 多源投票 / 贝叶斯融合 / 加权平均 | 两个源平均出来的值**谁都不信**；吵架时正确动作是「知道在吵 + 更保守」，不是造一个中间值 |
| 内存读取源（`memory`） | 反作弊红线（读进程内存=外挂特征）+ MC 是 Java 堆，成本极高收益极低。rank 表里留着名字，但不实现 |
| 事实跨会话持久化 | 事实是「现在世界什么样」，存下来就是错的（下次开游戏 hp 还是 0.62？） |
| 通用 ECS / schema 版本迁移 | 十几条事实、一个 profile，不需要注册表 |
| 自适应采样率学习 | `ttl/2` + `maxHz` 一条公式够了；学习的收益无法验证 |
| 视觉失明下的「盲打模式」 | 没有视觉就没有验证，盲打＝把按键打进用户的应用（安全闸存在的唯一理由） |
| 主观置信度自学习（`reliability`） | 默认关。验证本身会错，学出来的权重会把错误固化；先收集 2 周 `verify` 分布再谈 |
| mod 的 Java 端实现 | 接收端（`mod-provider.js`，TCP 8123）已经跑起来且有真 socket 单测；缺的是游戏里的那半边。本机 1.21.1 还是原版启动器，没装 Fabric，所以它是独立一条线，不是本设计的阻塞项 |
| mod 的加密 / 双向 RPC / 远程绑定 | 只绑回环；mod 只能出事实，不能触发动作。上远程是另一个安全模型，单独立项 |
| 每事实独立线程 / worker | 十几条事实的仲裁是 50µs 级，开线程的调度成本更高 |
| 3 源以上的调优 | 冲突只跟「最高分的那个对手」比；3 源时其余候选只做诊断记录 |
| 场景模板抖动去抖 / 迟滞 | 现有代码就是这个行为，本次不改；要改单独一轮（会动 `_scene` 语义） |
| 给 LLM 的自然语言事实摘要 | P3。先让结构化事实稳定，摘要层是另一个问题 |
| WebUI / 可视化面板 | 用现成的 `gen_dashboard.mjs`，不在这条链上加前端 |

---

## 13. 风险与对策

| # | 风险 | 概率/影响 | 对策 |
|---|---|---|---|
| 1 | **视觉归一化基准漂移**（`_hp_baseline: 0.8855` 换分辨率后失效）→ 与 mod 长期偏差 → 误 `distrusted` → 循环一直暂停 | 中 / 高 | `absTol 0.02` + `conflictTol 0.15` 双阈值；启动时用 3 帧中位数重测 baseline，与 profile 差 >10% 就 `warn` 并重写内存值（不写盘） |
| 2 | **RCON 频率上限**（120 条/分钟）导致 hp 主源不成立 | 高 / 中 | ttl 500ms 由 vision 满足；rcon 只做兜底与 `player.pos`；`maxHz:1.5` 硬限；hub 需求抑制避免抢配额 |
| 3 | **mod 端没落地**（接收端在，但游戏里没东西推） | 高 / 低 | 接收端已有单测（真 socket）；MC profile 里 `enabled:true` 但没数据推 = 监听空转、零影响（步骤 3 专门验这条）；rcon 这条零模组路线可独立跑通 |
| 4 | **双开/切窗导致事实串局** | 中 / 高 | 可选 `instance:{hwnd,pid,world}` + `instanceMatch`；`win.fg` 每帧单独判；不匹配丢弃并计 `miss` |
| 5 | **subscribe 通知爆炸/泄漏** | 中 / 中 | 只在 `frame()` 的 diff 上发；每事实每拍 ≤1 次；`unsubscribe` 必须被单测覆盖；回调异常 `try/catch` 后计数，不冒泡 |
| 6 | **事实数量膨胀**（provider 想写啥写啥） | 中 / 中 | `createGameFacts` 打开 strict 后 `declare()` + `bindSource()` 双白名单，越界 `set()` 返回 `false` 并计入 `rejected`；`game status` 暴露 rejected；v0/mod-provider 直连时不启用 strict |
| 7 | **日志拖慢循环** | 中 / 高 | 帧路径零 fs；ring + 批量 flush；单测 monkeypatch `fs` 断言 0 次调用 |
| 8 | **源静默死亡**（进程活着但不推） | 中 / 中 | `4×ttl` 剔除 + `hub.health().misses`；连续 3 次 poll 超时 → `disabledWhy` 写明；循环不中断 |
| 9 | **安全闸回归** | 低 / 致命 | 30 条老断言 + 38 条新断言双轨；两条路径同语义；`check-all` 把关 |
| 10 | **两个源同时错**（都读错，且一致） | 低 / 高 | 无法在状态层解决。只能靠期望验证 + 人工看 `game-facts.jsonl` 复盘；**明确不承诺**能发现这种错误 |
| 11 | 规则数值依赖「旧归一化」 | 中 / 低 | 投影保证 `bars.hp` 的语义与今天一致（0..1 比例、valid 语义），规则表零改动 |
| 12 | 验证引入额外抓帧，抬高 CPU | 低 / 低 | 复用下一拍的正常抓帧（不额外抓）；只有 `region` 类期望调一次 `region_gray`（10ms 级，且低频） |

---

## 14. 验收清单（实现完成后逐条打勾）

- [ ] `test-fact-store.cjs` PASS 23 / FAIL 0（v1 的 `set/get` 语义向后兼容）
- [ ] `test-game-safety-gate.cjs` PASS 30 / FAIL 0（**文件一行未改**）
- [ ] `test-mod-provider.cjs` 全过（接收端补 capabilities 后仍全过）
- [ ] `test-gate-from-facts.cjs` PASS ≥ 38 / FAIL 0（事实路径与扁平路径等价）
- [ ] `test-state-projection.cjs` PASS ≥ 26 / FAIL 0（视觉单源往返逐字段相等 + 2 条 mod 一致性）
- [ ] `check-all.mjs` 全绿
- [ ] 帧路径 `fs` 调用数 = 0（monkeypatch 断言）
- [ ] 真机：`mod` 喂数据→停喂 3s→回落 `vision`，`mod.silent:true`，循环不中断
- [ ] 真机：`rcon` 开→关→密码错，`player.hp.source` 依次为 `rcon → vision → vision`，循环不中断
- [ ] 真机：两源人为造冲突（改 baseline）→ 闸报 `HUD 读不到（两源偏差过大…）`，不是静默取一个值
- [ ] `game-facts.jsonl` 1Hz 一行，异常时出现 300 帧 dump
- [ ] `game status` 能看到 `facts/sources/conflicts5m/lastVerify/ruleFails`
- [ ] 关掉所有附加源（老 profile）时，`loopStatus().lastState` 与改造前字段一致

---

## 15. 评审：已落地三块代码里会出事的地方（2026-11-14 现状快照）

> 这一节是对**现有实现**（不是本文建议版）的挑错。级别按「会不会把按键送错地方」排。

### 15.1 `fact-store.js`

| 级别 | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| **致命** | **ttl 由写入方决定**：`ttlMs: m.ttlMs ?? cfg.ttlMs`，写入方传的值优先于 profile | 一个源写 5000 就永不 stale；mod 写 400 会让 profile 的 500 失效。**需求在消费侧，裁决权却在生产侧** | `effTtl = cfg.ttlMs ?? m.ttlHintMs`；写入方的值只做参考 |
| **致命** | **来源与事实无绑定**：`allowSources` 是全局单列表 | 本机任何进程（含被投毒的 mod）都能写 `player.hp`；将来有 `scene.blocking` 时可直接开闸 | `bindSource(name, patterns)` + strict 模式；越界 `set()` 返回 false 并计数 |
| **高** | **rank 是乘性因子**（`× rank/100`）：rank 差 2 倍会压过 conf 差 1.4 倍 | `conf` 形同虚设；`onConflict:'prefer-conf'` 这类策略**根本表达不出来** | rank 改为 tie-break 或加性 bonus（`conf×fresh + rank/1000`） |
| **高** | 过期 freshness 固定 0.15，且 `stale` 仍按 `best.ttlMs` | 过期 1ms 与 3.9×ttl 同分；慢源永远"差一点" | 连续衰减（如 `0.15^ (age/ttl)`）+ 事实级 ttl |
| 中 | 冲突只跟「次高分且新鲜」的**一个**对手比，`break` 掉其余 | 三源时漏报（A 与 C 差很多，但 B 居中就发现不了） | 与所有 fresh 候选比，取最大 severity |
| 中 | `set()` 只拒 `undefined`：`null` / `NaN` / `Infinity` 可入库 | `NaN` 让所有比较为 false、score 变 NaN，排序结果不可预测 | `Number.isFinite` + 拒 `null` |
| 中 | 无容量上限、无淘汰 | 未知 fact 永久驻留；长跑内存只增 | 按 profile 声明淘汰，或 LRU 上限 |

### 15.2 `mod-provider.js`

| 级别 | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| **致命** | 无任何身份/来源校验 | 见 15.1 第二条：本机任意进程可伪造状态，安全闸的输入不可信 | 端口只绑回环 + `instance` 校验 + 来源-事实白名单（双保险） |
| **高** | 新连接**直接 destroy 旧连接**，不报错 | 双开 MC 时事实静默切到另一局（血条/场景全错，且没人知道） | 拒绝第二个连接并计 `rejected`，或按 `instanceMatch` 选 |
| **高** | `buf` 无上限：客户端不发换行就无限增长 | 内存被一条坏连接拖爆 | 未换行累计 >64KB 丢弃并重置 + 计数 |
| **高** | `msg.t` 直接采信游戏侧时钟 | 未来时间戳 → `age` 恒 0 → **永不 stale** | `at = min(t, now + 2000)`；超偏移记 `clockSkew` |
| 中 | 无频率上限（`capabilities.maxHz` 未实现） | 1000 行/秒可把 `get()` 排序与日志拖垮 | 滑动窗口限速 + 丢弃计数 |
| 中 | `player.pos` 写对象，冲突判定退化为字符串相等 | 浮点抖动每帧都被判 conflict，日志/状态噪声 | 同时写 `player.pos.x/y/z` 标量 |
| 中 | `start()` 失败后 `_mod` 仍被赋值，`ensureModProvider` 里 `if (_mod) return _mod` | **本局永远不会重试**：端口占用/权限错误后，即使恢复也没有 mod 通道 | 失败时 `_mod = null`，或按 `health().listening` 每 30s 重试 |

### 15.3 `resolveHudGate`

| 级别 | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| **致命** | **不看 `conflict` / `distrusted`** | mod 与视觉差 60%（mod 读错/视觉基准漂移）时仍 `hpValid:true` —— 把安全判断交给单一、可伪造的来源 | `!r.conflict || r.severity < dangerTol` 才放行 |
| **高** | `typeof value === 'number'` 放行 `NaN` | `hp=NaN` 时闸放行，所有 hp 规则失效（NaN 比较全 false） | `Number.isFinite` |
| **高** | 硬编码 `source === 'mod' || 'api'` | 新增 rcon/ws 源必须改闸的代码，与 store 的 rank 表两套规则 | 改成读 store 的仲裁结果 + policy |
| 中 | `hpConfigured === false` 时 mod 一在就放行 | 测试 4 是有意的，但它意味着「mod 是信任边界」—— 必须在文档和 UI 里写明 | 保留行为，但要求 mod 通道至少 `instance` 校验 |
| 低 | 与 store 两套仲裁并存 | 长期必然漂移（今天就已经不一致：闸放行、规则失效） | 即本文 D8 |

### 15.4 迁移步骤里漏掉的风险

| 风险 | 为什么会漏 | 补法 |
|---|---|---|
| **没有回滚开关** | 只想着往前走 | profile 加 `state.enabled:false`（或环境变量），一键回纯视觉，不改代码 |
| **没有双跑对账** | 直接替换，无法证明等价 | 新旧路径并行算，差异只打日志不改行为；一致跑满 10 分钟再切 |
| **换 profile 时 ttl 残留** | `configure()` 是 merge，`stopLoop` 的 `reset()` 只在停时发生 | `configure(facts,{replace:true})` 或按 profile 重建 store |
| **stop→start 立刻重启会 EADDRINUSE** | `server.close()` 异步 + `_mod` 不重试 | 延迟 300ms 重试 / 复用实例 / 把失败状态暴露给 status |
| **没有性能基线** | 只看功能 | `ms.total` p95 不回归（建议 ≤8ms），加一条断言 |
| **没有负向安全测试** | 只测正常路径 | 伪造 mod 写 `scene.blocking`、NaN、超长行、未来时间戳，各一条 |
| **没有长跑** | 单测都是秒级 | 至少 30 分钟：内存、provider 重连、日志滚动、facts 数量 |
| **没有「谁在写」的可见性** | `game status` 只有 conflicts | 加 `rejected` / `disallowed` / `silent` 三个计数 |
