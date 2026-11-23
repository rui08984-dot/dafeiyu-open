# 大肥鱼 · 浏览器 tab 上报（MV3）

世界感知 Phase 2 第一条。扩展只做一件事：把**当前活动标签页**的
`host + title + audible + tabCount` 串行 POST 到本机 `127.0.0.1:8103/browser-tab`，
宿主追加写 `data/browser-tabs.jsonl`。不采集 path/query/fragment，不读页面内容。

## 加载（开发者模式，三步）

1. 打开 `chrome://extensions`（Edge 用 `edge://extensions`），右上角打开 **开发者模式**。
2. 点 **加载已解压的扩展程序**，选本目录 `extensions/browser-tabs`。
3. 点扩展图标打开 popup：填 `config.json` 里的 `browser_ext_token`（同一个随机串），
   勾选「启用上报」，点保存。状态行显示「上报成功」即通。

> 想让它也看见无痕窗口：在扩展详情里打开「在无痕模式下启用」。
> 即使打开，扩展也只上报 `incognito`，域名与标题不会离开浏览器。

## 权限与隐私

- 权限只有 `tabs` / `alarms` / `storage`；`host_permissions` 只有 `http://127.0.0.1:8103/*`。
  没有 `<all_urls>`，读不到网页内容（`tabs` 只给 url/title）。
- 只报活动 tab；后台 tab 的标题/地址变化被扩展丢弃。
- `chrome://`、`about:` 等非 http(s) 页面不上报；URL 解析失败丢弃该条。
- 无痕 tab：只发 `{incognito:true, host:"", title:"", tabCount:n}`。
- 暂停：popup 取消「启用上报」→ 零采集、零请求。

## 落盘与去重

宿主追加 `_incoming/my-neuro/data/browser-tabs.jsonl`，一行一条。连续相同的
`(host,title,audible,incognito)` 不重复写（宿主内存记上一条）。单文件超过 **2MB**
时轮转为 `browser-tabs.jsonl.1`（只保留一份备份，新文件从 1 行开始）。

## 令牌

`browser_ext_token` 在 `_incoming/my-neuro/live-2d/config.json`（模板见 `config.example.json`）。
为空时宿主对 `/browser-tab` 一律 401（不会默认放行）。换 token 后扩展 popup 里同步改。

## 排障

- popup 显示「网络失败」：宿主没起或 8103 不通（先 `curl http://127.0.0.1:8103/health`）。
- popup 显示「401」：token 不一致；看宿主日志 `[browser-tab] 拒绝（bad-token）`。
- 宿主日志 `[browser-tab] host=…` 只在真的落盘时出现；重复 payload 返回 `skipped:true` 不写盘。
