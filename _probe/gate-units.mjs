/**
 * gate-units.mjs — 门禁测试清单（A1，2026-11-21）
 *
 * 为什么从 check-all.mjs 里搬出来：原来 64 条单测和「语法/体检/台账」的执行逻辑
 * 挤在一个文件里，想加一个「30 秒冒烟档」就必须改执行器；而分档的判断依据是
 * **每条测试本身的性质**（要不要宿主 / 能不能并发 / 大概多慢），属于数据不是逻辑。
 *
 * 三条档位（判据只看「能不能在没有宿主的机器上独立跑完」）：
 *   smoke —— 纯逻辑/静态：不需要 8004/8771/8103/3003，不碰真实数据，单条 <3s。
 *            这是「改完代码 30 秒内知道有没有把核心逻辑改坏」的那一档，可并发。
 *   core  —— 需要自起临时服务、真实数据目录、或中速（3–30s）。宿主没起时会 SKIP 的
 *            项也在这档（needsHost 非空）。默认串行：它们动真实文件，并发会 EPERM。
 *   full  —— 真机窗口/UI/操控评测：会抢前台、按键鼠、拉控制中心。只在「要发版/大改」时跑。
 *
 * 字段：
 *   label        台账键。**逐字保留**——改一个字，gate-history 里这条的历史就断了。
 *   file         相对项目根。
 *   tier         smoke | core | full
 *   needsHost    null | '8004' | '8771' | '8103' | '3003'：需要哪个常驻服务。
 *                非空且探测不到时，check-all 直接标 SKIP（理由写清楚），不去撞超时。
 *   parallelSafe 能否与同档其它项并发。只有 smoke 里的纯逻辑测试为 true。
 *                碰真实窗口/固定端口/真实数据的一律 false（并发会互相污染）。
 *   timeoutMs    可选覆盖（默认 120s；评测类在 check-all 里另有 240s 规则）。
 */

export const TIER_INFO = {
  smoke: { name: '冒烟', budgetMs: 30000, desc: '纯逻辑/静态，不依赖宿主与网络，可并发' },
  core: { name: '核心', budgetMs: 240000, desc: '自起服务/真实数据/中速；宿主项在服务没起时 SKIP' },
  full: { name: '全量', budgetMs: 900000, desc: '真机窗口/UI/操控评测（会抢前台、按键鼠）' },
};

export const UNITS = [
  // ── smoke：纯逻辑 / 静态 ────────────────────────────────────────────────
  { label: '单测 文本→表情', file: '_probe/test-text-emotion.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 语义语气层（voice_style 夹幅/TTL/失败无感）', file: '_probe/test-voice-style.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 首段流式播放（MSE 按序 append/首块即播/回退/打断）', file: '_probe/test-tts-stream.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 服务端 prosody_gain 夹幅（纯函数）', file: 'pet-runtime/tools/tts-prosody-gain-test.py', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 技能沉淀', file: '_probe/test-skill-sediment.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 活着感状态机', file: '_incoming/my-neuro/live-2d/plugins/community/alive-state/state-model.test.js', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 皮套 perf 引擎', file: 'pet-runtime/tools/perf-engine-test.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 轨道编译器', file: 'pet-runtime/tools/perf-compiler-test.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 情绪状态契约', file: 'pet-runtime/tools/emotion-state-test.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 皮套不抖（抖动探针）', file: 'pet-runtime/tools/perf-jitter-test.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 LumenAct 面部片段（导入/播放/引擎集成）', file: 'pet-runtime/tools/facs-clip-test.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 片段导演（六条拒绝理由/选择可复现）', file: 'pet-runtime/tools/facs-clip-director-test.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 表演决策日志（接话配对/失败不打断）', file: 'pet-runtime/tools/performance-log-test.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 决策日志分析（接话率/窗口/结论句）', file: '_probe/test-perf-log-analysis.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '验收 vts-server 单一实现（同一个函数+能启动）', file: '_probe/vts-server-single-source.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 两段提交（P1-6）', file: 'pet-runtime/tools/param-commit-test.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 虚拟光标坐标', file: '_probe/test-overlay-geometry.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 游戏安全闸', file: '_probe/test-game-safety-gate.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 JS↔pet-core 字段契约', file: '_probe/test-core-field-contract.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 操控层韧性（focus重试/pid前台/三级回落/snapshot/稳定/归一/verify）', file: '_probe/test-act-resilience.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 点击/聚焦验证通道（UIA 回读为准/元素像素/遮挡三分类，P0-3）', file: '_probe/test-control-verify.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 事实表仲裁', file: '_probe/test-fact-store.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 首启判定（空 key/本地端点/占位符）+ 随包语音定位', file: '_probe/test-first-run.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 组件管理器（下载/校验/解压/写配置/幂等/换源）', file: '_probe/test-components-manager.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 服务监管（启动/健康/占用跳过/停止）', file: '_probe/test-components-services.cjs', tier: 'smoke', needsHost: null, parallelSafe: false },
  { label: '单测 认知内核（goal/plan/arbiter 纯函数）', file: '_probe/test-mind-kernel.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 认知内核接线（重启/注入/节流）', file: '_probe/test-mind-kernel-plugin.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 认知内核计划生成（LLM 3–8 步/失败降级/截断）', file: '_probe/test-mind-kernel-plan.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 派活→目标桥（可选调用/参数形状/不炸派活）', file: '_probe/test-dispatch-goal-bridge.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 目标终态保护（终态不可迁出/finish 幂等）', file: '_probe/test-goal-terminal.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 世界感知扩展注入（浏览器/RSS）', file: '_probe/test-world-extras.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 不可信数据封装（前缀/收窄/幂等边界/四处改造）', file: '_probe/test-untrusted-data.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 凭据掩码/回填（WebUI 与控制中心同一套规则）', file: '_probe/test-secret-mask.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 上传前卫生（密钥/敏感文件/忽略规则）', file: '_probe/test-upload-hygiene.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 TTS 线程代数/播放契约/合成超时', file: '_probe/test-tts-threads.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 点击破坏性守卫（三条路径统一）', file: '_probe/test-click-guard.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 世界完整性（心跳/投递记账/空闲档/年龄）', file: '_probe/test-world-integrity.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 表演修复（gaze/事件名/speaking/物理提交/眨眼/微表情/清理）', file: '_probe/test-petbody-perf-fixes.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 世界 Phase3（通知/无痕/站点语义/简报卡）', file: '_probe/test-world-phase3.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 表演仲裁（单 claim/资产所有权/进度/gain）', file: '_probe/test-performance-arbitration.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 控制面板显示（进度占位/gain 可用性）', file: '_probe/test-control-v2-display.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 派活续聊（终态+sessionId/失配文案/IPC 接线）', file: '_probe/test-dispatch-followup-policy.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 老 WebUI 三开关同源（tools 死键/动作模式/字幕缺省）', file: '_probe/test-ui-gates-audit.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 能力覆盖（注册表↔实现↔工具名）', file: '_probe/test-capability-coverage.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 配置有效值（能力页来源/温度不被静默关闭）', file: '_probe/test-config-effective.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 插件启停单一源（10 插件兼容旧开关）', file: '_probe/test-plugin-enable-single-source.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 模型级能力写穿（provider/model/回滚）', file: '_probe/test-model-capability-write.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 旁路口径（game 双闸/看屏只建议）', file: '_probe/test-bypass-policy.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 DSH 应答链（否定映射/超时/busy/Origin）', file: '_probe/test-dsh-ask-chain.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 浏览器 tab 上报（字段/去重/轮转/令牌）', file: '_probe/test-browser-tabs.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 DSH 应答规则（写优先/破坏动词/整词匹配）', file: '_probe/test-answerer-rules.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 Mod 通道接收端', file: '_probe/test-mod-provider.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 渲染层存活判据', file: '_probe/test-render-liveness.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 记忆召回·结论接入（过滤/上限/混排）', file: '_probe/test-recall-insights.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 文件原语（只读边界）', file: '_probe/test-file-tool.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 人格 OOC 判官（自嘲放行/具体纠正）', file: '_probe/test-persona-ooc.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 主动性预算（成本/结算/反馈）', file: '_probe/test-speech-budget.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 前缀缓存布局（易变不进 system）', file: '_probe/test-cache-layout.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 轮内前缀冻结（工具循环逐字节复用/轮末清空/只增不改）', file: '_probe/test-volatile-freeze.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 世界感知（状态机/TTL/世界行预算）', file: '_probe/test-world-store.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 RSS 去重与两阶段投递（URL/合簇/MMR/delivered）', file: '_probe/test-rss-dedup.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 复读护栏+打断提示（易变尾巴）', file: '_probe/test-loop-guard.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 工具超时+说话让路闸', file: '_probe/test-speech-gates.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 主动开口闸门（活动窗/预算20/说出口/静默闸）', file: '_probe/test-proactive-gates.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 对话现场（TTL/来源/接触锚点/E8 元数据）', file: '_probe/test-conversation-scene.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 对话连续性（她说完→你回复不判重逢）', file: '_probe/test-conversation-continuity.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 记忆脚手架过滤（主动提示词不写进记忆）', file: '_probe/test-memory-scaffold-filter.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 LLM 健康熔断（配额重置/指数退避/停当天/跨实例）', file: '_probe/test-llm-health.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 遗忘墓碑（忘掉后重建不再注入）', file: '_probe/test-forget-tombstones.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 落盘历史不按内容去重（同句话隔天也保留）', file: '_probe/test-history-dedupe.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 看屏上下文新鲜度（摘要 90s/离开 video 摘补丁/不补旧剧情）', file: '_probe/test-watch-staleness.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 锚点新鲜度（活动 stale/预算唯一真源/本地日切）', file: '_probe/test-anchor-freshness.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 崩溃现场留证（code/url/堆栈落盘+退出码）', file: '_probe/test-crash-log.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 假打断（不在播不算打断/一次性消费）', file: '_probe/test-interrupt-event.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 人格内核损坏不覆盖（隔离+锁写回）', file: '_probe/test-persona-corruption.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 反思也吃墓碑（不再把忘掉的写回来）', file: '_probe/test-reflection-tombstones.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 反思去重合并（occurrences/证据并集/猫狗不合并）', file: '_probe/test-insight-merge.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 记忆证据分与过期泄漏（stale_leak=0）', file: '_probe/memory-stale-leak.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 只记真播出（历史/对话现场/heard_response）', file: '_probe/test-heard-text.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 一起看跟随默认输出设备', file: '_probe/test-audio-device-follow.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 意图路由停 LLM（零请求/规则不变/unknown 同形）', file: '_probe/test-intent-router-llm-off.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 记忆纠正写穿（墓碑+本地用户记忆/四 action）', file: '_probe/test-memory-correction.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 穿透守卫（假 global 删除/手动开关自愈/专用通道）', file: '_probe/test-passthrough-policy.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 皮套 UI 适配（窄窗/夹取/无 DPI 假设/无 toGlobal 兜底）', file: '_probe/test-petbody-ui-adapter.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 插件上下文快照（深拷贝/外部修改保留/owner 清理）', file: '_probe/test-plugin-context-snapshot.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 换装单写（schema 兼容/preset 保留/失败回滚）', file: '_probe/test-costume-store.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 patchGL（真实源码+假 GL/幂等/还原/失败不抛）', file: '_probe/test-patch-gl-audit.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 OCR 模型可切换（默认 glm / paddle 可选）', file: '_probe/test-ocr-model-switch.cjs', tier: 'core', needsHost: null, parallelSafe: true },
  // 2026-11-23 安装完整性审计：services 引用 / requirements / 配置模板脱敏 / bootstrap 零写入 / README 命令路径。
  { label: '回归 安装清单（services/requirements/模板脱敏/bootstrap 零写入/README 命令）', file: '_probe/test-install-manifest.cjs', tier: 'core', needsHost: null, parallelSafe: true },
  { label: '单测 派活账本 P0（unknown/attempted/幂等/令牌）', file: '_probe/test-dispatch-ledger.cjs', tier: 'core', needsHost: null, parallelSafe: true },
  { label: '单测 派活 v2 P1（取消/verify 四态/返工/workspace）', file: '_probe/test-dispatch-v2-p1.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  // 2026-11-23：续聊（--session-id 复用/失配回退/父任务终态/断线 unknown）+ partialWrites 时间窗。
  { label: '单测 派活 v2 续聊（会话复用/失配回退/终态校验/断线）', file: '_probe/test-dispatch-followup.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '单测 派活 UI 重试判定（只有 spawn 失败可重派）', file: '_probe/test-dispatch-ui-retry.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 视觉分档（显存阈值/回退链/模型存在）', file: '_probe/test-vision-tier.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 OCR 复读截断（B13：7 遍/围栏/页脚不误截）', file: '_probe/test-ocr-dedup.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 运行时动作注册（profile→工具）', file: '_probe/test-game-actions.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 托盘菜单接线（静音/表情/取景/穿透）', file: '_probe/test-tray-audit.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 托盘菜单不滞后（藏/显文案实时重建）', file: '_probe/test-tray-menu-freshness.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 UI 开关一致性（能力页即时真有下发/B5/B3/B9 文案）', file: '_probe/test-ui-switch-consistency.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 编舞轨道采样（纯函数）', file: '_probe/test-choreo-tracks.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 表演库 v2（离线产物+播放器）', file: '_probe/test-choreo-performer.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 表演自动触发（情绪映射+节流）', file: '_probe/test-choreo-auto.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 演出调度器（relax 抢占/收势/排队/原子/旧 API）', file: '_probe/test-perf-scheduler.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 同步点标注（15+97 覆盖/间距/幂等/降级）', file: '_probe/test-perf-sync.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 功能注册表（声明/死键/自检）', file: '_probe/test-capabilities.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 插件清单与工具名', file: '_probe/check-plugins.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 配置模板（结构/脱敏/漂移）', file: '_probe/check-config-template.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 参数所有权护栏（双写抓取/只告警一次）', file: '_probe/test-param-ownership.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 语义兜底改写链（提示词硬约束/清洗/语料）', file: '_probe/test-semantic-describe.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 自身窗口/破坏性按钮守卫（§71）', file: '_probe/test-self-guard.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 搭车情绪行（解析/流式过滤/relay）', file: '_probe/test-mood-line.mjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 门禁台账与陈旧度（写失败发声）', file: '_probe/test-gate-history.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 评测严格档（预算三态/observed 恢复/自报不可信）', file: '_probe/test-agent-eval-strict.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 轮次归因（turn_id/阶段打点/兜底开轮）', file: '_probe/test-turn-context.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 工具回执判据（形状/失败原因/审计计数）', file: '_probe/test-tool-result.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 工具注解（高风险齐全/字段合法/名字真实）', file: '_probe/test-tool-meta.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 回合日志（未闭合标记/幂等/无明文）', file: '_probe/test-turn-journal.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 世界可纠错（用户先验/TTL/away 优先）', file: '_probe/test-world-priors.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 屏幕时间线（去重/跨天/搜索/7 天）', file: '_probe/test-screen-timeline.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 任务账本三态（自述≠已证实/终态保护）', file: '_probe/test-task-ledger.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 上下文预算（分层/估算/增长源）', file: '_probe/test-context-budget.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 用量账本（真账基线/缓存miss/7天聚合/80%边界）', file: '_probe/test-usage-ledger.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 缓存感知压缩（8k持有/12k应用/tail作废/冷缓存）', file: '_probe/test-compressor-cache-aware.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 工具回执上限（单条12k/单轮32k/幂等/成对）', file: '_probe/test-tool-result-cap.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 工具续读（artifact/file offset/see 分页/code/web）', file: '_probe/test-tool-continuation.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 工具子集（会话稳定/模式切换/核心保底/默认关）', file: '_probe/test-tool-subset.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 画像渲染预算（10/字段/按需全文/看屏90）', file: '_probe/test-profile-render-budget.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 看屏预算（唯一数字源/配置优先/旧220归一）', file: '_probe/test-watch-screen-budget.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 doctor 判据（缓存样本/账本覆盖/本地模型/易变稳定/端点分级）', file: '_probe/test-doctor-judge.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 本地记忆模型（provider/probe/chat/episode本地反思云/写队列闸）', file: '_probe/test-local-llm.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 片段卡结构化输出（schema/严格校验/response_format 透传/400 降级）', file: '_probe/test-episode-schema.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  // 2026-11-24 第三轮（HANDOFF §8.3/§8.5）：云端调用收口到账本 + retry 真接线 + 单一压缩器。
  { label: '单测 LLM 账本覆盖（ai-log 走 callLLM/流式无 usage 估算/本地 source=local）', file: '_probe/test-llm-usage-coverage.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 LLM 重试（5xx 重试/429 不重试/流式中途不重放/退避/配置生效）', file: '_probe/test-llm-retry.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 发送前清理不截断工具回执（12k 原样/控制字符/配对/name 语义）', file: '_probe/test-llm-tool-passthrough.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 单一压缩器（rolling 已删/只有插件写历史总结/走 callLLM）', file: '_probe/test-single-compressor.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  // 2026-11-24 第三轮（HANDOFF §8.5）：闸/补丁/快照身份。
  { label: '单测 provider fail-closed（指定不存在→throw/不降级/非回环 warn）', file: '_probe/test-provider-fail-closed.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 后台花费闸（四插件不发请求/游标不动/quiet≠花钱）', file: '_probe/test-background-gates.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  // 2026-11-24 第四轮 P2：陪伴提示时间戳必须绕过节流立即落盘（重启后不重复提示）
  { label: '单测 陪伴提示落盘（节流窗口内立即写 lastPromptAt/重启读回）', file: '_probe/test-companion-prompt-persist.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 可见补丁 volatile（system 不变/可撤）', file: '_probe/test-visible-patches-volatile.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 快照身份（sid/hwnd 不一致拒绝/超龄/夹具重试）', file: '_probe/test-snapshot-identity.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  // ── D 系列体验（2026-11-22）──
  { label: '单测 每日成绩单（四源/≤120字/可撤销调整/无数据0token）', file: '_probe/test-daily-report.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 待发意图队列（容量/TTL/情境指纹/补说≤1）', file: '_probe/test-intent-queue.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 经验路由（按 app 成功率重排/3 连败回默认）', file: '_probe/test-route-experience.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 打断续讲（只按未播剩余/显式请求/TTL 1 轮）', file: '_probe/test-resume-speech.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 策略门（高危表/无人值守/覆盖/留痕无明文）', file: '_probe/test-policy.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 MCP 策略门下沉（拒绝回执/审计一次/无明文）', file: '_probe/test-mcp-policy.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  // ── D5–D9（2026-11-22，子代理交付）──
  { label: '单测 记忆兑现率（片段命中/实体共现/索引稳定）', file: '_probe/test-memory-usage.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 用户画像候选池归档（promoted 超龄/复活去重/闸）', file: '_probe/test-user-profile-archive.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  // ── F 系列本地模型质量收口（2026-11-24，HANDOFF §8.5）──
  { label: '单测 画像类别归一化（枚举串/大小写/复数/同义词/兜底可观测）', file: '_probe/test-profile-category.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 日记通道（默认云/local_enabled/闸/空输出/不跨通道回退）', file: '_probe/test-diary-provider.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 记忆库卫生（惰性交互头/空占位清理/判官闸）', file: '_probe/test-memory-hygiene.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 导演调参（倍率夹幅/样本门/降太多回退）', file: '_probe/test-choreo-tune.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 交互状态机 shadow（只记 mismatch/不写回）', file: '_probe/test-interaction-state.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  // ── E3/E5/E6/E7/E4（2026-11-22，子代理交付 + 延迟预算）──
  { label: '单测 备份 manifest（生成/verify/篡改 1 字节被抓）', file: '_probe/test-backup-manifest.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 技能生命周期（dormant/隔离/复活/不删）', file: '_probe/test-skill-health.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 key-policy（拆分/规则/三键返回）', file: '_probe/test-key-policy.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 geometry（矩形/DIP/包含/钳制）', file: '_probe/test-geometry.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 事件溯源投影（重放/差异/dry-run 不写盘）', file: '_probe/test-event-projection.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 延迟预算（基线/超 20% 黄/连 3 次红/回落清零）', file: '_probe/test-latency-budget.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 表情轮换（同情绪不连切同一张）', file: '_probe/test-expression-rotation.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 aim 数学段（不发输入/死区）', file: '_probe/aim-accept.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 aim 模拟闭环（真 provider+事实表）', file: '_probe/aim-sim-loop.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '回归 语义问答（注入覆盖 + 召回类）', file: '_probe/semantic-eval.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 自我身份清理（旧称/角色标签/迁移幂等/食物防误改）', file: '_probe/test-identity-clean.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  // ── 2026-11-25 第二轮审查 + 深测新增（此前未注册；实测均 <2s、离线）──
  { label: '单测 前缀冻结风暴面（30 次工具迭代真 runTurn/上游字节稳定/兜底）', file: '_probe/test-freeze-storm.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 重试纯度（请求体逐字节一致/不改调用方数组/不污染账本）', file: '_probe/test-retry-purity.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 账本归因（turn_id/双写/200 错误体/doctor 覆盖回退）', file: '_probe/test-usage-attribution.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 工具回执续读组合（12k 截断×artifact 通道/code/MCP）', file: '_probe/test-tool-result-continuation.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 上下文背压（关条数限制也按 token 裁/优先级/审计账）', file: '_probe/test-context-backpressure.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 易变尾巴边界（确定性截断/行级去重/代理对/幂等）', file: '_probe/test-volatile-edge.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 插件契约（provider 解析不到 fail-closed/本地走 resolve 真相源）', file: '_probe/test-plugin-contracts.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 模板 URL 白名单（泛域名/凭据绕过/实例值中性化）', file: '_probe/test-template-url-whitelist.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },

  // ── core：自起服务 / 真实数据 / 中速（默认串行）────────────────────────
  { label: '单测 UI 配置接线（能力页↔config↔控制中心/真盘键与模板一致）', file: '_probe/test-ui-config-wiring.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '回归 语义语气默认关闭（真实请求体无 prosody_gain）', file: '_probe/voice-style-inert.mjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '验收 LumenAct 语义服务端到端（自启+延迟+映射）', file: '_probe/lumen-semantic-e2e.mjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '单测 游戏检测（合成图）', file: '_probe/test-game-detector.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '单测 WebUI 安全（令牌/掩码/路径穿越/SSRF）', file: '_probe/test-webui-security.py', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '单测 控制口写令牌（浏览器来源 403 / 进程内放行）', file: '_probe/test-control-auth.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  // D9 场景评测（5 条 × pass^8）：走公开接口、不真调 LLM/TTS；放 core（要宿主里的模块可用）。
  // 2026-11-22 调研（τ-bench pass^k）：n=3 分辨率太低（pass^8 才有意义），门禁改跑 8 轮。
  { label: '验收 场景评测（记忆/静默/抢话/预算/失败恢复 pass^8）', file: '_probe/scenario-eval.cjs', tier: 'core', needsHost: null, parallelSafe: false, timeoutMs: 300000, args: ['--runs', '8'] },
  { label: '单测 启动器韧性/服务清单（锁/闸门/退避/清单）', file: '_probe/test-launcher-resilience.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '单测 记忆完整性（写入契约/检索/补丁清理/事实衰减）', file: '_probe/test-memory-integrity.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '单测 记忆质量（脚手架/强化时机/近义去重/接续）', file: '_probe/test-memory-quality.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '单测 reranker 配置陷阱（探活/停用/health 字段）', file: '_probe/test-reranker-guard.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '单测 删记忆清图谱 + 备份完整性（B3）', file: '_probe/test-memos-graph-sync.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  // B3 收尾（2026-11-23）：只读统计 + 安全清死引用；要 import FastAPI / 起 Python 子进程，放 core。
  { label: '单测 记忆一致性（向量/图谱/BM25 报告 + 死引用清理幂等）', file: '_probe/test-memos-consistency.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '单测 记忆来源标注（source/turn_id/confidence）', file: '_probe/test-memory-provenance.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '单测 语音四态分类（backchannel/noise/barge_in/turn_take）', file: '_probe/voice-intent.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 语音四态门接线（开关关闭零变化/附和不打断/兜底）', file: '_probe/voice-intent-wiring.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  // 2026-11-23 真机事故回归：静默模式(cost.quiet)不能掐掉零成本本地感知，
  // 否则用户问「你在看/听什么」她只能忠实转述「没拿到画面」。
  { label: '单测 静默不掐感知（本地关键帧/窗口标题兜底/按需豁免）', file: '_probe/test-quiet-perception.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  // 2026-11-24 穿透三次同族事故：自指死锁（穿透破坏自身所需输入）
  { label: '单测 穿透边界自愈（主进程轮询光标/进入即恢复/离开才穿透）', file: '_probe/test-passthrough-selfheal.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  // 2026-11-24 真机事故：拖动只能拖一小段就停（拖动中置穿透 → 收不到 pointermove）
  { label: '单测 拖动期间禁止穿透（标志/新鲜度/前后端双守卫）', file: '_probe/test-drag-passthrough-guard.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  // 2026-11-24 真机事故：drag_preview 开关读未定义变量恒为 true → 强制预览模式
  { label: '单测 拖动预览开关真实生效（默认开/显式关/不走过期缓存）', file: '_probe/test-drag-preview-switch.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 语音韧性（VAD 重连/附和/并发轮/自听/口型/失败状态）', file: '_probe/test-voice-resilience.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '单测 画像隔离（迁移/注入隔离/逐字节还原）', file: '_probe/test-profile-quarantine.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '回归 记忆召回（真数据）', file: '_probe/test-memory-recall.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '回归 动态人格（每轮注入/落盘/过期）', file: '_probe/test-dynamic-persona.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '回归 待写队列（MemOS 离线不丢）', file: '_probe/test-memory-evolve-queue.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '回归 反思落盘（importance/证据链/cursor/日上限）', file: '_probe/test-memory-reflect.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '单测 ASR fetch 超时解锁（本地假死服务）', file: '_probe/test-asr-timeout.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '回归 事实有效期（压旧+可查历史）', file: '_probe/test-user-facts.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '回归 空闲巩固/片段卡片（失败不丢）', file: '_probe/test-episode-store.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '回归 人格三层（跨天证据/冲突/配额）', file: '_probe/test-persona-layers.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '回归 RSS 今日简报（解析/打分/窗口幂等/端到端）', file: '_probe/test-rss-brief.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '回归 配置写盘→热重载→读回（单一入口）', file: '_probe/test-config-persist.cjs', tier: 'core', needsHost: null, parallelSafe: false },
  { label: '单测 WebUI 配置写盘读回校验（atomic/整文件 digest/HTTP 500）', file: '_probe/test-webui-config-io.py', tier: 'core', needsHost: null, parallelSafe: false },
  // B6（2026-11-23）：consume 回写 + 3 条跨步评测。纯逻辑 + mkdtemp，不碰宿主；
  // 放 core 而不是 smoke：要跑 4 次真实 goal-store 落盘 + 3 条多步任务，超过 3s 冒烟口径。
  { label: '单测 认知内核计划推进（consume 回写/钳制/幂等/跨步评测）', file: '_probe/test-mind-kernel-plan-progress.cjs', tier: 'core', needsHost: null, parallelSafe: true },

  // ── full：真机窗口 / UI / 操控评测 ──────────────────────────────────────
  { label: '回归 评测 run 超时取消页内脚本（8004）', file: '_probe/test-eval-abort.cjs', tier: 'full', needsHost: '8004', parallelSafe: false },
  { label: '单测 操控一致性（多屏/黑名单/回读/唯一解析）', file: '_probe/test-control-consistency.cjs', tier: 'full', needsHost: '8004', parallelSafe: false },
  { label: '验收 真实管线一致性（executeTool ↔ 直连，51 例）', file: '_probe/test-pipeline-parity.cjs', tier: 'full', needsHost: '8004', parallelSafe: false },
  { label: '验收 皮套窗组件画框语言（8004）', file: '_probe/petbody-ui-states.mjs', tier: 'full', needsHost: '8004', parallelSafe: false },
  { label: '验收 工具回执契约（真机 backfilled=0/违规 0）', file: '_probe/tool-contract-accept.cjs', tier: 'full', needsHost: '8004', parallelSafe: false },
  { label: '验收 拖动性能（冻结生效/fps≥100/松手恢复）', file: '_probe/drag-perf-accept.cjs', tier: 'full', needsHost: '8004', parallelSafe: false },
  { label: '验收 15 段长表演能启动（客观段，8004）', file: '_probe/perf15-accept.mjs', tier: 'full', needsHost: '8004', parallelSafe: false },
  { label: '验收 控制中心按钮真实点击（8771）', file: '_probe/ui-button-accept.mjs', tier: 'full', needsHost: '8771', parallelSafe: false },
  { label: '验收 能力注册表接前端（8771）', file: '_probe/capabilities-ui-accept.mjs', tier: 'full', needsHost: '8771', parallelSafe: false },
  { label: '验收 手机遥控 3003 端到端（令牌+白名单）', file: '_probe/mobile-3003-e2e.mjs', tier: 'full', needsHost: '3003', parallelSafe: false },
  { label: '验收 手机页面仿真（3003/3004 触摸+DPI）', file: '_probe/mobile-emulate.mjs', tier: 'full', needsHost: '3003', parallelSafe: false },
  { label: '验收 世界感知（真机 8103 /world）', file: '_probe/world-accept.cjs', tier: 'full', needsHost: '8103', parallelSafe: false },
  { label: '验收 控制中心→宿主热重载', file: '_probe/reload-config-accept.cjs', tier: 'full', needsHost: '8103', parallelSafe: false },
  { label: '回归 窗口生命周期（真机）', file: '_probe/test-window-ops.cjs', tier: 'full', needsHost: null, parallelSafe: false },
  { label: '验收 电脑操控评测（真机）', file: '_probe/agent-eval/runner.mjs', tier: 'full', needsHost: '8004', parallelSafe: false, timeoutMs: 240000,
    // 2026-11-21（用户要求）：门禁跑评测**不占屏幕** —— 夹具/计算器移出屏幕外，
    // 需要抢前台的三条记 SKIP（真机交互档手动跑 runner.mjs 不带 --quiet）。
    args: ['--quiet'] },
  { label: '验收 后台操控（不抢前台/移出屏幕仍可读可点）', file: '_probe/control-background-accept.cjs', tier: 'full', needsHost: '8004', parallelSafe: false },

  // ── 2026-11-25 ADR-015 / 审计修复新增（全部离线纯逻辑，入 smoke）──────────
  { label: '单测 表演所有权护栏（v2 写入集/exp3 pin/冲突计数）', file: '_probe/test-perf-ownership.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 演出导演（presence/预算/强度/被接率）', file: '_probe/test-perf-director.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 演出契约（配置键/能力/UI 入口/syncCoverage）', file: '_probe/test-perf-contract.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 Ambient 待机层（状态/停留/加权池/幅度）', file: '_probe/test-perf-ambient.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 Ambient 偏置落地（系数/钳位/speaking 减半）', file: '_probe/test-perf-ambient-apply.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 调度器接线（disabled 对拍/收势/账目）', file: '_probe/test-perf-scheduler-integration.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 节目单运行器（串接/最短段/中断/预算）', file: '_probe/test-program-runner.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 场景台词单一真源（12 键/两消费者）', file: '_probe/test-scene-lines.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 演出页契约（页面/入口去重/开关）', file: '_probe/test-perf-ui.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 按键路由（游戏 PostMessage/非游戏 SendInput）', file: '_probe/test-key-routing.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 窗口标题统一匹配（精确/前缀/唯一子串/歧义）', file: '_probe/test-window-match.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 focus 回读（前台不符 → 不 confirmed）', file: '_probe/test-focus-verified.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 MemOS 搜索失败可观测（1 静默/2 warn/成功清零）', file: '_probe/test-memos-failure.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 截断 JSON 假成功修复（parseError/telemetry）', file: '_probe/test-tool-result-truncated.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 插件热重载 hash（同内容跳过/失败保留旧实例）', file: '_probe/test-plugin-reload-hash.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 turn.end 真实 outcome（error/interrupted/blocked）', file: '_probe/test-turn-outcome.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 launcher 心跳/死因/陈旧锁', file: '_probe/test-launcher-heartbeat.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 see image 图片管线（剥 base64/附 image_url/分槽）', file: '_probe/test-see-image-pipeline.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 向量缓存 LRU/增量/原子写', file: '_probe/test-vector-cache-lru.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 画像 prompt 预算（6000 字符/截断重试）', file: '_probe/test-profile-prompt-budget.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
  { label: '单测 记忆待写队列/事实层（attempt/死信/event 过滤）', file: '_probe/test-memory-queue-facts.cjs', tier: 'smoke', needsHost: null, parallelSafe: true },
];

/** 取某档应跑的全部项：--core 含 smoke，--full 含全部。 */
export function unitsForTier(tier) {
  const t = String(tier || 'full');
  if (t === 'smoke') return UNITS.filter((u) => u.tier === 'smoke');
  if (t === 'core') return UNITS.filter((u) => u.tier === 'smoke' || u.tier === 'core');
  return UNITS.slice();
}
