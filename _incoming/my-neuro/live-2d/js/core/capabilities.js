// capabilities.js —— 功能注册表（2026-11-16）
//
// 为什么要有它（用户拍板「后端要一个规整范式，才能映射到前端」）：
//   现在设置项散在 config.json、插件 enabled_plugins.json、plugin_config.json、
//   环境变量和硬编码端口里，一共四五个源。结果出现了三类病：
//     · 死开关：配置写着 true，代码里根本没人读（如 tools.enabled / bert.enabled / rag.enabled）
//     · 野键：config.json 里有、但没有任何功能声明它（改了不起作用也没人发现）
//     · 假持久化：UI 能改、实际只改内存（如曾经的两处静默开关）
//   这张表把「一个功能 = 一行」固定下来：开关在哪、默认值、改完是否立即生效、谁实现的。
//   启动时自检拿它和真实 config/插件清单对账，把上面三类病直接打到日志里。
//
// 用法：
//   const { CAPABILITIES, auditCapabilities, renderCapabilityReport } = require('./core/capabilities.js');
//   const report = auditCapabilities({ config, enabledPlugins });
//   if (report.problems.length) logToTerminal('warn', renderCapabilityReport(report));
//
// 以后接前端：控制中心的设置项可以从这张表直接生成（一步只剩「渲染 + 写回」）。

'use strict';

/**
 * @typedef {object} Capability
 * @property {string} id        唯一 id（点分：域.功能）
 * @property {string} name      人话名字
 * @property {string} group     分组（语音/记忆/主动性/演出/模型/界面/服务）
 * @property {'config'|'plugin'|'port'} kind   开关类型
 * @property {string} [key]     config 路径 或 plugin 相对目录
 * @property {any}    [default] 缺省值
 * @property {boolean} [hot]    true=改了立即生效；false=要重启
 * @property {string} [impl]    实现文件（自检用：文件不存在就是「声明了没实现」）
 * @property {string} [plugin]  该功能的加载宿主插件（config 类用它把「配置总闸」和「插件加载」对齐，避免同一功能两行）
 * @property {number} [port]    端口（kind=port）
 * @property {string[]} [choices] 枚举值（kind=config 且是字符串枚举时，前端渲染成下拉）
 * @property {string} [note]    诚实边界：这个开关到底控制什么
 * @property {string} [deprecated] 废弃原因。声明保留（代码还在），但前端不再渲染、自检不再当活开关
 */

/** @type {Capability[]} */
const CAPABILITIES = [
  // ── 语音 ──────────────────────────────────────────────────────────────
  { id: 'voice.tts', name: '语音合成', group: '语音', kind: 'config', key: 'tts.enabled', default: true, hot: false, impl: 'edge-tts/tts_server.py', port: 9883, note: '关闭后她不发声，只剩字幕', evidence: { doctor: '语音播放', tests: ['_probe/test-tts-threads.cjs', '_probe/test-tts-stream.cjs'] } },
  { id: 'voice.tts_muted', name: '静音（运行时）', group: '语音', kind: 'config', key: 'tts.muted', default: false, hot: true, note: '与「静默模式」不是一回事；托盘/能力页即时同源（能力页会直接下发 __ttsMuted + 打断当前播报）' },
  { id: 'voice.asr', name: '语音识别', group: '语音', kind: 'config', key: 'asr.enabled', default: true, hot: false, impl: 'asr/asr_server.py', port: 1000 },
  { id: 'voice.ptt', name: '按住说话', group: '语音', kind: 'config', key: 'asr.ptt_enabled', default: true, hot: false, note: 'ASRProcessor 启动时缓存，改完要重启' },
  { id: 'voice.barge_in', name: '说话时打断', group: '语音', kind: 'config', key: 'asr.voice_barge_in', default: false, hot: false },
  // B5（2026-11-23）：语音四态门。ASRProcessor 构造时读一次（js/voice/asr-processor.js:85
  // `this._backchannelGate = duplexCfg.backchannel_gate === true`），之后不重读 → 必须重启。
  { id: 'voice.backchannel_gate', name: '语音四态门（附和不打断）', group: '语音', kind: 'config', key: 'voice.duplex.backchannel_gate', default: false, hot: false, impl: 'js/voice/asr-processor.js', note: '开=她说话时你回「嗯/对」不再打断（短确认判为附和：不打断、不提交对话）；默认关；ASRProcessor 启动时读一次，改完需重启桌宠' },
  // 2026-11-23 审计更正：tts-request-handler 每次请求确实重读 voice_style，但它读的是
  // **自己构造时缓存的 this.config 对象**；app.js reloadConfig 换的是新的 config 对象，
  // 只有云 TTS 分支才会同步给处理器 → 普通情况下改了要重启（旧注释「改完立即生效」是错的）。
  { id: 'voice.style', name: '语气风格层', group: '语音', kind: 'config', key: 'voice_style.enabled', default: false, hot: false, impl: 'js/core/voice-style.js', note: '2026-11-23 更正：TTS 处理器持有启动时的配置快照，改完需重启；默认关（语义语气不改文本）' },
  { id: 'voice.api_gateway', name: 'ASR/TTS 走网关', group: '语音', kind: 'config', key: 'api_gateway.use_gateway', default: false, hot: false, impl: 'js/voice/asr-processor.js', note: '开着时语音请求发到 api_gateway 网关，而不是直连本地服务' },
  { id: 'voice.cloud_tts', name: '云端 TTS（OpenAI 兼容）', group: '语音', kind: 'config', key: 'cloud.tts.enabled', default: false, hot: false, impl: 'js/voice/tts-request-handler.js', note: '优先级高于本地 edge-tts；需要 url/model/voice' },
  { id: 'voice.volcengine_tts', name: '火山引擎声音克隆', group: '语音', kind: 'config', key: 'cloud.volcengine_tts.enabled', default: false, hot: false, impl: 'js/voice/tts-request-handler.js', note: '声音克隆 TTS；API Key 在同一个配置子树里' },
  { id: 'voice.aliyun_tts', name: '阿里云声音克隆', group: '语音', kind: 'config', key: 'cloud.aliyun_tts.enabled', default: false, hot: false, impl: 'js/voice/tts-request-handler.js', note: '声音克隆 TTS；采音文件与音色 ID 在同一子树里' },
  { id: 'voice.cloud_asr_baidu', name: '百度流式 ASR', group: '语音', kind: 'config', key: 'cloud.baidu_asr.enabled', default: false, hot: false, impl: 'js/ai/conversation/ASRController.js', note: '与本地 ASR 二选一' },
  { id: 'voice.cloud_asr_siliconflow', name: '硅基流动 ASR', group: '语音', kind: 'config', key: 'cloud.siliconflow_asr.enabled', default: false, hot: false, impl: 'js/ai/conversation/ASRController.js', note: '与本地 ASR 二选一' },
  { id: 'voice.screenshot_bert', name: '截图意图分类（BERT）', group: '语音', kind: 'config', key: 'bert.enabled', default: false, hot: false, impl: 'js/ai/ScreenshotManager.js', note: '6007 服务从未部署；关着只按关键词判定（2026-11-16 已真接线）' },
  { id: 'voice.resume_speech', name: '打断后接着说', group: '语音', kind: 'config', key: 'tts.resume_after_interrupt', default: true, hot: false, soft: true, impl: 'js/core/resume-speech.js', note: '默认开（config 缺省合法：代码默认 true）；只在用户显式说「接着说/继续刚才/接着说下去」时重播未播剩余段，TTL 1 轮，绝不自动续讲' },
  { id: 'voice.cowatch', name: '一起看耳朵（系统声音）', group: '语音', kind: 'port', port: 1001, impl: 'audio-loop/audio_loop_server.py', note: '没有配置开关：由 launcher / restart-pet 拉起；听不听由 watch-screen 插件决定' },
  { id: 'voice.voiceprint', name: '声纹嵌入', group: '语音', kind: 'port', port: 8020, impl: 'audio_common/voiceprint_server.py', note: '隔离 venv 运行；risky 装进系统 Python' },

  // ── 记忆 ──────────────────────────────────────────────────────────────
  { id: 'memory.memos', name: 'MemOS 长期记忆', group: '记忆', kind: 'plugin', key: 'built-in/memos', default: true, hot: true, port: 8003 },
  { id: 'memory.recall', name: '长期记忆检索注入', group: '记忆', kind: 'plugin', key: 'community/memory-recall', default: true, hot: true, evidence: { tests: ['_probe/test-memory-recall.cjs', '_probe/test-recall-insights.cjs', '_probe/test-memory-usage.cjs'] } },
  { id: 'memory.evolve', name: '记忆演化（巩固/去重）', group: '记忆', kind: 'plugin', key: 'community/memory-evolve', default: true, hot: true, evidence: { tests: ['_probe/test-memory-evolve-queue.cjs', '_probe/test-memory-integrity.cjs'] } },
  { id: 'memory.profile', name: '用户画像', group: '记忆', kind: 'plugin', key: 'community/user-profile', default: true, hot: true },
  // 2026-11-21 治理盘点：以下三个插件此前只存在于「插件页」，能力注册表里是黑户
  { id: 'memory.note', name: '用户记忆库（笔记）', group: '记忆', kind: 'plugin', key: 'built-in/note', default: true, hot: true, note: '工具 note；数据文件见 plugin_config.memory_file' },
  { id: 'memory.diary', name: 'AI 日记', group: '记忆', kind: 'plugin', key: 'built-in/diary', default: true, hot: true, note: '空闲时写日记；本身不提供工具' },
  { id: 'memory.ai_log', name: '思痕之册（每日/月度长文）', group: '记忆', kind: 'plugin', key: 'built-in/ai-log', default: true, hot: true, note: '提供工具 diary；与 built-in/diary 插件名字相近但不是同一个' },

  // 2026-11-16 插件收敛：community/core-memory-injector 已删除，memory.core_inject 声明同步移除

  // ── 主动性（总闸 + 各路）─────────────────────────────────────────────
  { id: 'proactive.quiet', name: '静默模式（总闸）', group: '主动性', kind: 'config', key: 'cost.quiet', default: true, hot: true, note: '只拦「主动开口」；用户说话仍会调模型。总览/设置/能力页/遥控3003/直播台3004 五个入口同源走 8103（托盘没有静默项，2026-11-21 更正）' },
  { id: 'proactive.auto_chat', name: '自动搭话', group: '主动性', kind: 'plugin', key: 'built-in/auto-chat', default: true, hot: true, note: '默认间隔 60s（2026-11-16 从 15s 上调）' },
  { id: 'proactive.dawn_dusk', name: '晨昏问候', group: '主动性', kind: 'plugin', key: 'community/dawn-dusk-line', default: true, hot: true },
  { id: 'proactive.alive_state', name: '活着感（饱食/精力/亲密）', group: '主动性', kind: 'plugin', key: 'community/alive-state', default: true, hot: true, evidence: { tests: ['_incoming/my-neuro/live-2d/plugins/community/alive-state/state-model.test.js'] } },
  { id: 'proactive.watch_screen', name: '看屏幕/看视频', group: '主动性', kind: 'plugin', key: 'community/watch-screen', default: true, hot: true, note: '与 vision.auto_screenshot 是两条独立路径；自动点击默认关（watch_screen.auto_click=false）：OCR 白名单命中只建议不点，true 才免问直点（仍过 rateGate 与破坏性守卫）' },
  { id: 'proactive.dispatch', name: '派活给执行器', group: '主动性', kind: 'plugin', key: 'community/dispatch', default: true, hot: true, evidence: { tests: ['_probe/test-dispatch-goal-bridge.cjs', '_probe/test-task-ledger.cjs'] } },
  // 2026-11-21 治理盘点：以下插件此前只有「插件页」一个入口，注册表未收编
  { id: 'proactive.inner_state', name: '内在状态注入', group: '主动性', kind: 'plugin', key: 'community/inner-state', default: true, hot: true, note: '给模型一句「她现在什么状态」' },
  { id: 'proactive.persona_guard', name: '人设漂移哨兵', group: '主动性', kind: 'plugin', key: 'community/persona-guard', default: true, hot: true, note: '检测 OOC 后注入纠正提示；doctor 的「人设漂移」读它' },
  { id: 'proactive.companion_health', name: '陪伴健康提示', group: '主动性', kind: 'plugin', key: 'community/companion-health', default: true, hot: true, note: '久坐/熬夜提醒；阈值在 plugin_config' },
  { id: 'proactive.rss_brief', name: 'RSS 今日简报', group: '主动性', kind: 'plugin', key: 'community/rss-brief', default: true, hot: true, note: '定时抓 RSS 并择机开口' },
  { id: 'proactive.mind_kernel', name: '认知内核（目标栈）', group: '主动性', kind: 'plugin', key: 'community/mind-kernel', default: true, hot: true, note: 'plugin_config.enabled 已废弃（仅兼容读取）；启停以本注册表为准' },
  { id: 'proactive.dynamic_persona', name: '动态人格（旧版）', group: '主动性', kind: 'plugin', key: 'community/dynamic-persona', default: false, hot: true, note: '默认不启用；职责与 user-profile/persona 层重叠，check-plugins 白名单保留' },

  // ── 演出（她自己动）─────────────────────────────────────────────────
  { id: 'perf.choreo_v1', name: '情绪微动作', group: '演出', kind: 'config', key: 'ui.petbody_choreo', default: false, hot: true, impl: 'pet-runtime/desktop/choreo-tracks.mjs', note: '2–4 秒，跟每句话的情绪；default 对齐代码（driver 用 === true，键缺失即关）。能力页/总览/托盘三个入口都会立即下发给皮套（2026-11-23 补下发）' },
  { id: 'perf.long_v2', name: '自动演长戏', group: '演出', kind: 'config', key: 'ui.petbody_perf_auto', default: true, hot: true, impl: 'pet-runtime/desktop/choreo-auto.mjs', note: '19–38 秒；四层节流（强度 0.45 / 全局 4 分钟 / 同段 15 分钟 / 单会话 6 段）。能力页/总览/托盘同源，立即生效' },
  { id: 'perf.game_actions', name: '游戏动作注册', group: '演出', kind: 'plugin', key: 'community/game-actions', default: true, hot: true, note: '按 profile 动态注册动作工具；工具名随 profile 变，不占固定工具面' },

  // ── 模型 ──────────────────────────────────────────────────────────────
  { id: 'llm.reasoning', name: '思考等级', group: '模型', kind: 'config', key: 'llm.reasoning_enabled', default: false, hot: false, soft: true, note: '真值在 llm_providers.json 的当前模型上；能力页开关直接写穿到模型条目（2026-11-21），config.json 仅作无通讯录时的回退值' },
  { id: 'llm.intent_router', name: '意图前缀路由', group: '模型', kind: 'config', key: 'llm.intent_router.enabled', default: false, hot: false, soft: true, deprecated: '2026-11-21 方案 A：未接线。只有单测调 classifyIntent，主链走零延迟 classifyIntentLocal（js/ai/llm-handler.js:478）；代码保留，设置页与能力页两处 UI 已移除', note: '已废弃：开关不生效（打开也不会改变路由）' },
  { id: 'llm.filler', name: '延迟垫场', group: '模型', kind: 'config', key: 'llm.filler_enabled', default: false, hot: true, soft: true, impl: 'js/voice/latency-filler.js', note: '默认关（词库已换成零语义「嗯…」）；config 缺省合法' },
  { id: 'llm.temperature', name: '采样温度开关', group: '模型', kind: 'config', key: 'llm.temperature_enabled', default: true, hot: false, soft: true, impl: 'js/ai/llm-handler.js', note: '真值在 llm_providers.json 的当前模型上；能力页开关直接写穿到模型条目（2026-11-21），config.json 仅作回退值' },

  // ── 工具（插件提供的 function calling 工具）─────────────────────────────
  { id: 'tool.web_search', name: '联网搜索', group: '工具', kind: 'plugin', key: 'built-in/web-search', default: true, hot: true, note: '工具 web_search；Tavily 或自建端点' },
  { id: 'tool.code_exec', name: '代码执行', group: '工具', kind: 'plugin', key: 'built-in/code-executor', default: true, hot: true, note: '工具 code；可跑 Python' },
  { id: 'tool.schedule', name: '日程管理', group: '工具', kind: 'plugin', key: 'built-in/schedule', default: true, hot: true, note: '工具 schedule' },
  { id: 'tool.sfx', name: '音效播放', group: '工具', kind: 'plugin', key: 'built-in/sfx', default: true, hot: true, note: '工具 play_sound_effect' },
  { id: 'tool.context_compress', name: '上下文压缩', group: '工具', kind: 'plugin', key: 'built-in/context-compressor', default: true, hot: true, note: '超阈值时压缩历史；阈值见 plugin_config' },
  { id: 'tool.translation', name: '同声传译', group: '工具', kind: 'plugin', key: 'built-in/translation', default: false, hot: true, note: '默认不启用（check-plugins 白名单保留）' },
  { id: 'tool.music', name: '音乐播放', group: '工具', kind: 'plugin', key: 'built-in/music', default: false, hot: true, note: '默认不启用；工具 music' },

  // ── 视觉 ──────────────────────────────────────────────────────────────
  { id: 'vision.enabled', name: '视觉感知', group: '视觉', kind: 'config', key: 'vision.enabled', default: true, hot: false },
  { id: 'vision.auto_shot', name: '聊天按需截图', group: '视觉', kind: 'config', key: 'vision.auto_screenshot', default: false, hot: false, note: '关它不影响「看屏幕」那条路径' },
  { id: 'vision.use_model', name: '视觉模型理解', group: '视觉', kind: 'config', key: 'vision.use_vision_model', default: false, hot: false, impl: 'js/ai/llm-handler.js', note: '开着才把截图发给多模态模型；关着只按关键词/OCR 判定' },
  // 2026-11-23 审计更正：world-sense 插件通过 context.getConfig() 读**启动时的配置快照**，
  // 宿主 /reload-config 不会更新插件上下文 → 这里不是热的（旧声明说「缺省全开」不等于热）。
  { id: 'vision.world_sense', name: '世界感知（前台/空闲/媒体/剪贴板）', group: '视觉', kind: 'config', key: 'world_sense.enabled', default: true, hot: false, impl: 'plugins/community/world-sense/index.js', plugin: 'community/world-sense', note: '2026-11-23 更正：插件持有启动时的配置快照，改完需重启（或重载插件）；sources.* 可单独关' },
  { id: 'vision.world_extras', name: '世界感知扩展（浏览器/RSS）', group: '视觉', kind: 'plugin', key: 'community/world-extras', default: true, hot: true, note: '浏览器标签/RSS 作为世界行来源' },

  // ── 界面 ──────────────────────────────────────────────────────────────
  { id: 'ui.framing', name: '取景（全身/半身）', group: '界面', kind: 'config', key: 'ui.petbody_framing', default: 'half', hot: true, choices: ['half', 'full'], note: 'half=半身（默认）；full=全身。能力页与托盘都会立即下发给皮套（2026-11-23 补下发）' },
  { id: 'ui.click_through', name: '默认鼠标穿透', group: '界面', kind: 'config', key: 'ui.click_through_default', default: false, hot: true, note: 'default 对齐代码（main.js 用 === true，键缺失即不穿透）；能力页与托盘都会立即生效，重启后沿用这个默认值' },
  { id: 'ui.hide_in_shot', name: '截屏时隐身', group: '界面', kind: 'config', key: 'ui.hide_from_screenshot', default: false, hot: false, note: 'default 对齐代码（main.js 主窗用 === true；字幕窗另用 !== false）' },
  { id: 'ui.subtitle_window', name: '独立字幕窗', group: '界面', kind: 'config', key: 'ui.subtitle_window', default: true, hot: false, soft: true, note: 'config 缺省合法（代码默认开）；首次在面板改动才落盘' },
  { id: 'ui.expression_solver', name: '表情求解器（AU 驱动）', group: '界面', kind: 'config', key: 'expression_solver.enabled', default: true, hot: false, impl: 'js/avatar/live2d/expression/au-driver.js', note: '关掉后表情只走旧的情绪映射' },
  { id: 'ui.vmc', name: 'VMC 动作转发', group: '界面', kind: 'config', key: 'vmc.enabled', default: true, hot: false, impl: 'js/model/vrm-model-setup.js', note: '仅 VRM/MMD 形态有效；Live2D 不受影响' },
  // 2026-11-21 治理盘点：设置页能改、代码在读，但注册表没登记 → 能力页看不到
  { id: 'ui.chat_box', name: '文字输入框', group: '界面', kind: 'config', key: 'ui.show_chat_box', default: true, hot: true, impl: 'js/ui/ui-controller.js', note: '右键「打字框」与能力页同一判据，改完立即显示/隐藏（2026-11-23 补下发）' },
  { id: 'ui.show_model', name: '启动时显示皮套', group: '界面', kind: 'config', key: 'ui.show_model', default: true, hot: false, impl: 'js/model/model-setup.js', note: '只影响启动时是否画模型；皮套（petbody）形态下不读这个键——运行中藏/显用托盘菜单或皮套右键「先藏起来」' },
  { id: 'ui.text_only', name: '纯文字模式', group: '界面', kind: 'config', key: 'ui.text_only_mode', default: false, hot: false, impl: 'js/ai/llm-handler.js', note: '关掉语音链路，只走文本/字幕' },
  { id: 'ui.remember_position', name: '记住窗口位置', group: '界面', kind: 'config', key: 'ui.model_position.remember_position', default: true, hot: false, impl: 'js/model/model-interaction.js' },
  { id: 'ui.subtitle_labels', name: '字幕显示', group: '界面', kind: 'config', key: 'subtitle_labels.enabled', default: true, hot: false, impl: 'js/ui/ui-controller.js' },

  // ── 集成（游戏/MCP/服务自管）──────────────────────────────────────────
  { id: 'integration.minecraft', name: 'Minecraft 集成', group: '集成', kind: 'config', key: 'game.Minecraft.enabled', default: false, hot: false, impl: 'js/ai/GameIntegration.js', note: '视觉游戏闭环与 Mod 通道是另外两条路径，不依赖它' },
  { id: 'integration.mcp', name: 'MCP 工具', group: '集成', kind: 'config', key: 'mcp.enabled', default: false, hot: false, impl: 'js/app-initializer.js', note: 'MCPManager 的启动开关' },

  // ── 上下文 ────────────────────────────────────────────────────────────
  { id: 'ctx.limit', name: '上下文条数上限', group: '上下文', kind: 'config', key: 'context.max_messages', default: 16, hot: false, note: '2026-11-16 从 24 降到 16（prefill 成本）；紧急裁剪在 96 条才触发，正常先走压缩' },
  // 2026-11-23 审计更正：context-compressor 插件用 context.getConfig() 读预算，
  // 而插件上下文持有启动时的配置快照 → 改完需重启才生效（旧声明 hot:true 是错的）。
  { id: 'ctx.token_budget', name: '上下文 token 预算', group: '上下文', kind: 'config', key: 'context.token_budget', default: 12000, hot: false, note: 'E8：达到 70% 且消息≥15 就触发压缩；2026-11-23 更正为需重启（压缩插件持有启动快照）；缺省 12000' },
  { id: 'ctx.persist', name: '持久化对话历史', group: '上下文', kind: 'config', key: 'context.persistent_history', default: true, hot: false },
  { id: 'ctx.enable_limit', name: '启用上下文条数上限', group: '上下文', kind: 'config', key: 'context.enable_limit', default: true, hot: false, impl: 'js/ai/conversation/ConversationCore.js', note: '关掉后 ctx.limit（max_messages）不生效' },

  // ── 服务（硬编码常驻，没有配置开关）────────────────────────────────────
  { id: 'svc.vts', name: 'VTS 兼容协议', group: '服务', kind: 'port', port: 8001, note: '环境变量 PET_VTS_PORT；无配置项' },
  { id: 'svc.inner', name: '渲染层内部通道', group: '服务', kind: 'port', port: 8102, note: '看门狗靠它判活，不能关' },
  { id: 'svc.control', name: 'HTTP 控制口', group: '服务', kind: 'port', port: 8103, note: '/say /quiet /dispatch' },
  { id: 'svc.devtools', name: '自检通道（主窗）', group: '服务', kind: 'port', port: 8004, note: '/eval /shot；PET_DEVTOOLS=0 可关' },
  { id: 'svc.remote', name: '手机遥控页', group: '服务', kind: 'port', port: 3003, note: '绑 0.0.0.0 + token 白名单（有意为之）' },
  { id: 'svc.live', name: '直播台', group: '服务', kind: 'port', port: 3004, note: '只绑 127.0.0.1' },
  { id: 'svc.auto_close', name: '关面板自动关服务', group: '服务', kind: 'config', key: 'auto_close_services.enabled', default: true, hot: true, impl: 'control-main.js', note: '消费者在控制中心主进程' },
  { id: 'svc.live_dock', name: '直播对接', group: '服务', kind: 'plugin', key: 'community/live-dock', default: true, hot: true, note: 'plugin_config.enabled 已废弃（仅兼容读取）；开播才开，启停以本注册表为准' },
];

/** 按点分路径取 config 值 */

/** 已知死键（2026-11-16 审计实测：config 里有、但全仓没有消费者）。
 *  自检会把它们单独点名，而不是混在「未声明」里 —— 这样修一个划掉一个，不会忘记。 */
const KNOWN_DEAD = {
  'tools.enabled': '运行时插件管理器不读它；真正决定加载的是 enabled_plugins.json',
  'tools.auto_reload': '全仓只有配置文件和示例，没有代码读',
  'rag.enabled': '全仓无消费者（rag-memory 插件用自己的 rag_url）',
  'rag.url': '同上，运行时不读',
  'ui.auto_show_chat_on_text_mode': '无消费者',
  'motion_director.enabled': 'petbody 模式下 director 整段被 isPetBodyTakeover() 短路',
  'motion_director.wait_before_tts': '无消费者',
  'motion_director.first_frame_wait_ms': '无消费者',
  'motion_director.fallback_enabled': 'petbody 下 director 整段短路（fallback 分支也进不去）',
  'motion_director.body.enabled': 'petbody 下 director 整段短路（body 分支）',
  'motion_director.face.enabled': 'petbody 下 director 整段短路（face 分支）',
  'motion_director.vad.enabled': 'petbody 下 director 整段短路（vad 分支）',
};

function getPath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

// ── 有效值解析（2026-11-21）───────────────────────────────────────────────
// 病根：llm.temperature_enabled / llm.reasoning_enabled 等采样键在保存时被
// control-main.js saveControlConfig 从 config.json 删掉、写到 llm_providers.json 的
// 模型条目上（MODEL_PARAM_KEYS），运行时再由 llm-provider.js _buildResolved 平铺回来。
// 能力页以前只读 config.json 原始值 → 这几项永远显示 default，用户看不到真实生效值。
//
// 解析优先级必须逐键对齐运行时的真实读法（同一优先级会造假值）：
//   · llm.temperature_enabled / llm.temperature：llm-handler.js applySampling 先读
//     config.llm 旧键（手工配置兼容），再读 resolved（llm_providers.json 当前模型）。
//   · llm.reasoning_enabled / reasoning_effort：LLMClient.fromProviderConfig 只把 resolved
//     平铺进客户端（js/ai/llm-client.js:45-58），config.llm 里的同名键只在「没有 provider
//     通讯录」的回退构造里生效 → 模型优先。
// `soft` 只表示「config.json 缺省合法」，不代表「没有真值」。
const MODEL_PARAM_CAPABILITY_KEYS = Object.freeze({
  'llm.temperature_enabled': { modelKey: 'temperature_enabled', prefer: 'config' },
  'llm.temperature': { modelKey: 'temperature', prefer: 'config' },
  'llm.reasoning_enabled': { modelKey: 'reasoning_enabled', prefer: 'model' },
  'llm.reasoning_effort': { modelKey: 'reasoning_effort', prefer: 'model' },
});

/** 选当前 provider / model（与 loadControlConfig、LLMProviderManager._resolveModelEntry 对齐） */
function pickActiveProviderModel(providers, providerId, modelId) {
  const list = Array.isArray(providers) ? providers : [];
  const provider = list.find((p) => p && p.id === providerId)
    || list.find((p) => p && p.enabled !== false)
    || list[0]
    || null;
  if (!provider) return null;
  const models = Array.isArray(provider.models) ? provider.models : [];
  const lookupEnabled = (id) => {
    if (!id) return null;
    const hit = models.find((m) => m && m.model_id === id);
    return hit && hit.enabled !== false ? hit : null;
  };
  return lookupEnabled(modelId)
    || models.find((m) => m && m.enabled !== false)
    || models[0]
    || null;
}

/**
 * 解析一条 config 能力在运行时真正生效的值。
 * @param {Capability} cap
 * @param {{config?:object, providers?:object[], providerId?:string, modelId?:string}} env
 * @returns {{value:any, source:'config'|'model'|'default', configured:boolean}}
 *   source 供 UI 标注「静态值（config.json）/ 运行时值（模型）/ 默认值」。
 */
function resolveCapabilityValue(cap, env = {}) {
  const fallback = { value: cap ? cap.default : undefined, source: 'default', configured: false };
  if (!cap || cap.kind !== 'config' || !cap.key) return fallback;
  const raw = getPath(env.config || {}, cap.key);
  const modelSpec = MODEL_PARAM_CAPABILITY_KEYS[cap.key];
  const model = modelSpec
    ? pickActiveProviderModel(env.providers, env.providerId, env.modelId)
    : null;
  const fromModel = () => {
    if (!model || model[modelSpec.modelKey] === undefined) return null;
    // 用 cap.default 的类型决定是否归一成 boolean：true/false 之外的值（温度数字）原样返回
    const value = typeof cap.default === 'boolean' ? model[modelSpec.modelKey] === true : model[modelSpec.modelKey];
    return { value, source: 'model', configured: true };
  };
  const fromConfig = () => (raw === undefined ? null : { value: raw, source: 'config', configured: true });
  const first = modelSpec && modelSpec.prefer === 'model' ? [fromModel, fromConfig] : [fromConfig, fromModel];
  return first[0]() || first[1]() || fallback;
}

/** 把所有叶子路径摊平（用于找「野键」） */
function flattenKeys(obj, prefix = '', out = []) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const p = prefix ? prefix + '.' + k : k;
    if (v != null && typeof v === 'object' && !Array.isArray(v)) flattenKeys(v, p, out);
    else out.push(p);
  }
  return out;
}

/**
 * 自检：拿注册表和真实配置/插件清单对账。
 * @param {{config?:object, enabledPlugins?:string[]}} env
 * @returns {{declared:number, problems:Array<{id:string,kind:string,detail:string}>, undeclared:string[]}}
 */
function auditCapabilities(env = {}) {
  const config = env.config || {};
  const plugins = Array.isArray(env.enabledPlugins) ? env.enabledPlugins : null;
  const problems = [];
  const declaredKeys = new Set();

  for (const cap of CAPABILITIES) {
    if (cap.kind === 'config' && cap.key) {
      declaredKeys.add(cap.key);
      const v = getPath(config, cap.key);
      if (v === undefined && cap.soft !== true) {
        problems.push({
          id: cap.id, kind: 'missing-key',
          detail: `config 里没有 ${cap.key}（默认 ${JSON.stringify(cap.default)}）—— 运行时走的是代码缺省值，UI 可能显示错`,
        });
      }
    }
    if (cap.kind === 'plugin' && cap.key && plugins) {
      // 只有「声明默认开启、却不在启用列表」才是问题；声明默认关的不在列表里是正常的
      if (cap.default === true && !plugins.includes(cap.key)) {
        problems.push({
          id: cap.id, kind: 'plugin-off',
          detail: `声明默认开启，但 enabled_plugins.json 里没有它 —— 永远不会加载`,
        });
      }
    }
    if (cap.impl) {
      try {
        const fs = require('fs');
        const path = require('path');
        // impl 路径以**仓库根**（D:i人格软件）为基准：edge-tts/ asr/ audio-loop/ pet-runtime/
        // 都在那一层；live-2d 在 _incoming/my-neuro/ 下，所以要往上 5 级。
        const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
        const cands = [path.join(repoRoot, cap.impl), path.join(__dirname, '..', '..', cap.impl)];
        if (!cands.some((p) => fs.existsSync(p))) {
          problems.push({ id: cap.id, kind: 'impl-missing', detail: `实现文件找不到：${cap.impl}` });
        }
      } catch (e) { /* 自检本身不该抛 */ }
    }
  }

  // 野键：config 里存在、注册表没声明、**且语义像开关**的键。
  // 只认开关语义（enabled/quiet/muted/auto/use_…）：*_url/_key/_ms/_path 这些是参数，
  // 全列出来会淹掉真正可疑的死键（审计时 91 个里只有十来个是可疑开关）。
  //
  // 2026-11-16 修两处自检误报：
  //   ① `_deprecated.*` 是标注区，不是开关（以前它自己会被当成 3 个野键）
  //   ② 已进 KNOWN_DEAD / _deprecated 的键归 dead 区报，不该再在野键里重复点名
  const allKeys = flattenKeys(config);
  const SWITCHISH = /(enabled|disabled|quiet|muted|^auto|_auto|use_gateway|use_vision|use_voice)/i;
  const annotatedKeys = Object.keys((config && config._deprecated && typeof config._deprecated === 'object') ? config._deprecated : {});
  const deadKeys = new Set([...Object.keys(KNOWN_DEAD), ...annotatedKeys]);
  const undeclared = allKeys.filter((k) => !declaredKeys.has(k) && SWITCHISH.test(k)
    && !/^_deprecated\./.test(k)
    && !deadKeys.has(k)
    && !/^subtitle_labels\./.test(k));

  // 死键：静态清单（KNOWN_DEAD）+ config 里自己声明的 _deprecated 两处合起来看。
  // 已写进 config._deprecated 的算「已标注废弃」——不再是待办，只是定期提醒。
  const annotatedMap = (config && config._deprecated && typeof config._deprecated === 'object') ? config._deprecated : {};
  const allDead = { ...KNOWN_DEAD, ...annotatedMap };
  const deadPresent = Object.keys(allDead).filter((k) => getPath(config, k) !== undefined);
  const deadAnnotated = deadPresent.filter((k) => !!annotatedMap[k]);
  const deadUnannotated = deadPresent.filter((k) => !annotatedMap[k]);
  return {
    declared: CAPABILITIES.length, problems, undeclared,
    deadPresent, knownDead: allDead, deadAnnotated, deadUnannotated,
  };
}

/** 渲染成一段能直接进日志的报告 */
function renderCapabilityReport(report) {
  const lines = [];
  lines.push(`[能力自检] 声明 ${report.declared} 项 · 问题 ${report.problems.length} 条`);
  const byKind = {};
  for (const p of report.problems) (byKind[p.kind] = byKind[p.kind] || []).push(p);
  for (const kind of Object.keys(byKind)) {
    for (const p of byKind[kind]) lines.push(`  · [${kind}] ${p.id}: ${p.detail}`);
  }
  if (report.deadUnannotated && report.deadUnannotated.length) {
    lines.push(`  未标注的死键 ${report.deadUnannotated.length} 个（改了没用，请标注或删除）：`);
    for (const k of report.deadUnannotated) lines.push(`    - ${k}：${report.knownDead[k] || '无消费者'}`);
  }
  if (report.deadAnnotated && report.deadAnnotated.length) {
    lines.push(`  已标注废弃 ${report.deadAnnotated.length} 个（见 config._deprecated，不再算问题）：`);
    for (const k of report.deadAnnotated) lines.push(`    · ${k}`);
  }
  if (report.undeclared.length) {
    lines.push(`  未声明的配置键 ${report.undeclared.length} 个（可能是死键，也可能只是没登记）：`);
    for (const k of report.undeclared.slice(0, 20)) lines.push(`    - ${k}`);
    if (report.undeclared.length > 20) lines.push(`    …还有 ${report.undeclared.length - 20} 个`);
  }
  return lines.join('\n');
}

module.exports = {
  CAPABILITIES, auditCapabilities, renderCapabilityReport, getPath, flattenKeys,
  MODEL_PARAM_CAPABILITY_KEYS, pickActiveProviderModel, resolveCapabilityValue,
};
