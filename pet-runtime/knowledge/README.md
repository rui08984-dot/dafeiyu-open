# 知识库三层设计（2026-11-09 三十五轮）

## 为什么不用硬编码

之前把游戏攻略直接写在 `game-control.js` 的 `SEMANTIC_PROFILES_BUILTIN` 和 `pvz guide` 里：

- **改不了**：用户想加个游戏、改个键位，得动代码
- **会过期**：游戏更新了（新版本改键位、新英雄、新版本地图），攻略变成错的，而且**错了也没人知道**
- **占上下文**：52 个工具的 schema 已经不小，再塞攻略等于每轮都在烧 token
- **学不会**：她玩过一次发现「这个按钮点了没用」，下次还是照原样点

## 三层结构

```
pet-runtime/knowledge/
├── rules/            ① 稳定规则层 —— 半年不怎么会变的
│   ├── pvz.json
│   ├── minecraft.json
│   ├── genshin.json
│   └── generic-desktop.json
├── live/             ② 动态 RAG 层 —— 会过期、需要更新的（可覆盖 rules）
│   ├── <game>.json
│   └── README.md
└── experience/       ③ 经验层 —— 她自己玩出来的（只增不改，带时间戳和置信度）
    └── <game>.jsonl
```

### ① 稳定规则层 `rules/`

**放什么**：玩法骨架、UI 布局常识、安全的键位约定。
**判断标准**：这个知识如果下周就变了，那它不该在这里。

```json
{
  "game": "植物大战僵尸",
  "version": "1.x 通用",
  "updatedAt": "2026-11-09",
  "confidence": "high",
  "rules": [
    { "id": "grid-layout", "text": "草坪是 5 行 × 9 列的网格…", "kind": "layout" },
    { "id": "sun-economy", "text": "阳光是唯一货币，每 25 点一个向日葵周期…", "kind": "mechanic" }
  ],
  "keys": { "暂停": "space", "菜单": "esc" },
  "typicalActions": ["init", "slot 1", "plant 3,2", "click_at x,y"]
}
```

### ② 动态 RAG 层 `live/`

**放什么**：会过期的——新版本改键、新英雄数值、当前版本强势阵容、某个具体关卡的解法。
**怎么来**：用户手填 / 从网上抓 / LLM 生成。
**怎么用**：**覆盖** `rules/` 同名 `keys`/`rules`。

```json
{
  "game": "植物大战僵尸",
  "version": "杂交版 v0.31",
  "source": "用户实测",
  "updatedAt": "2026-11-09",
  "confidence": "medium",
  "overrides": {
    "keys": { "暂停": "p" }
  },
  "extra": [
    { "id": "hybrid-specific", "text": "杂交版多了融合植物，卡槽会超过 10 个…", "kind": "version-specific" }
  ]
}
```

**关键纪律**：`live/` 里的东西**必须带 `updatedAt` 和 `confidence`**。超过 90 天没更新，`confidence` 自动降级（`high→medium→low`），并在注入 prompt 时明确标「这条可能过时了」。

### ③ 经验层 `experience/`

**放什么**：她自己试出来的——「点这个坐标真的能种上」「先选卡槽再点格子，反了不行」。
**格式**：JSONL，一行一条，只增不改（append-only）。

```jsonl
{"ts":"2026-11-09T16:20:00+08:00","game":"植物大战僵尸","kind":"success","action":"pvz auto 1,3,2","verified":true,"evidence":"像素距离 18","note":"卡槽 1 是向日葵，第 3 行第 2 列安全"}
{"ts":"2026-11-09T16:31:00+08:00","game":"植物大战僵尸","kind":"failure","action":"click_at 750,278","verified":false,"evidence":"画面没变","note":"这个坐标是桌面空白，不是格子"}
```

**为什么 append-only**：经验的价值在「积累」，能删就能骗自己。如果发现某条经验是错的，**再写一条否定的**，而不是删掉旧的。

**置信度数学**（借 beijingwahw 的 Beta 后验）：
- 每条经验有 `kind: success|failure`
- 同一个 `action` 的成功率 = `(successCount + 1) / (total + 2)`（Beta(1,1) 先验）
- 样本 < 3 时，把置信度打折（`1.96 * sqrt(...)` 那套），不吹牛

## 怎么注入 prompt

**不要全注入**。按这个顺序取，总量控在 800 token 以内：

1. 当前前台窗口/游戏名 → 精确匹配 `rules/<game>.json` + `live/<game>.json`
2. 匹配不到 → `rules/generic-desktop.json`
3. 经验层：只取**最近 5 条** + **成功率最高的 3 个 action**
4. 拼成一段紧凑文本，附在 system prompt 的「当前环境」段

## 换游戏怎么工作

用户说「我要玩原神」→

1. `semantic` 自动按前台窗口标题识别 → `profileId = '原神'`
2. 知识库 `getKnowledge('原神')` → `rules/genshin.json`（骨架）+ `live/genshin.json`（当前版本，可能没有）
3. 拼成 prompt 给她

**游戏更新了怎么办**：用户自己改 `live/<game>.json`（或用 UI 填），或者她玩失败了写 `experience/`，下次看到「上次这条没成」。

**她能不能自己学**：能——`experience/` 就是她的学习记录。每完成一个**验证通过**的动作，写一条 success；验证失败写 failure。这是报告里说的「可靠度由世界盖章，不是自我报告」。

## 代码位置

`_incoming/my-neuro/live-2d/plugins/community/dispatch/knowledge-base.js`

API：
```js
getKnowledge(gameName)          // 三层合并，返回 { rules, keys, experience, promptText }
recordExperience(entry)          // 写经验层（append-only）
getActionReliability(game, act)  // 某个动作在某个游戏的成功率（Beta 后验）
buildPromptSection(gameName)     // 生成注入用的紧凑文本（≤800 token）
```
