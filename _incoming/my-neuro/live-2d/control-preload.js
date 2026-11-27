const { contextBridge, ipcRenderer } = require('electron');

// 8103 浏览器来源写令牌（2026-11-21 红队 P1）：主进程用 webPreferences.additionalArguments
// 把 --pet-control-token=... 传进来（沙箱 preload 里 process.argv 可用）。
// 控制中心页是 file:// 源，POST /perform 等写接口必须带 X-Pet-Token，否则 8103 回 403。
const PET_CONTROL_TOKEN = (() => {
  try {
    const hit = (process.argv || []).find(
      arg => typeof arg === 'string' && arg.startsWith('--pet-control-token=')
    );
    return hit ? hit.slice('--pet-control-token='.length) : '';
  } catch (e) { return ''; }
})();
contextBridge.exposeInMainWorld('petControlToken', PET_CONTROL_TOKEN);

contextBridge.exposeInMainWorld('controlApi', {
  windowAction: action => ipcRenderer.invoke('control:window', action),
  confirmUnsavedConfig: title => ipcRenderer.invoke('control:confirm-unsaved-config', title),
  setConfigDirty: dirty => ipcRenderer.send('control:config-dirty', Boolean(dirty)),
  onCloseRequested: callback => ipcRenderer.on('control:close-requested', () => callback()),
  openGithub: () => ipcRenderer.invoke('control:open-github'),
  resetModelPosition: () => ipcRenderer.invoke('control:reset-model-position'),
  adjustSubtitlePosition: () => ipcRenderer.invoke('control:adjust-subtitle-position'),
  selectVoiceFile: kind => ipcRenderer.invoke('control:select-voice-file', kind),
  uploadAliyunAudio: options => ipcRenderer.invoke('control:upload-aliyun-audio', options),
  selectAliyunAudio: filePath => ipcRenderer.invoke('control:select-aliyun-audio', filePath),
  enrollAliyunVoice: options => ipcRenderer.invoke('control:enroll-aliyun-voice', options),
  queryAliyunVoice: options => ipcRenderer.invoke('control:query-aliyun-voice', options),
  generateVoiceBat: options => ipcRenderer.invoke('control:generate-voice-bat', options),
  serviceStatus: () => ipcRenderer.invoke('control:service-status'),
  // 2026-11-10 三十九轮：她的状态 + 投喂（原来 UI 里没有任何入口）
  petState: () => ipcRenderer.invoke('control:pet-state'),
  petFeed: () => ipcRenderer.invoke('control:pet-feed'),
  kbSearch: q => ipcRenderer.invoke('control:kb-search', q),
  skillsList: () => ipcRenderer.invoke('control:skills-list'),
  skillsRemove: name => ipcRenderer.invoke('control:skills-delete', name),
  organTimeline: () => ipcRenderer.invoke('control:organ-timeline'),
  startService: id => ipcRenderer.invoke('control:start-service', id),
  stopService: id => ipcRenderer.invoke('control:stop-service', id),
  downloadService: id => ipcRenderer.invoke('control:download-service', id),
  // v0.4.0 组件（记忆/ASR/一起看/LumenAct）：下载/校验/解压/写配置
  componentsStatus: () => ipcRenderer.invoke('control:components-status'),
  componentsInstall: ids => ipcRenderer.invoke('control:components-install', ids),
  componentsRemove: ids => ipcRenderer.invoke('control:components-remove', ids),
  componentsOpenDir: () => ipcRenderer.invoke('control:components-open-dir'),
  onComponentsProgress: callback => ipcRenderer.on('components:progress', (_event, payload) => callback(payload)),
  onServiceLog: callback => ipcRenderer.on('control:service-log', (_event, payload) => callback(payload)),
  onServiceState: callback => ipcRenderer.on('control:service-state', () => callback()),
  openExternal: url => ipcRenderer.invoke('control:open-external', url),
  listPlugins: () => ipcRenderer.invoke('control:list-plugins'),
  refreshPluginMarket: () => ipcRenderer.invoke('control:refresh-plugin-market'),
  setPluginEnabled: (relPath, enabled) => ipcRenderer.invoke('control:set-plugin-enabled', relPath, enabled),
  savePluginConfig: (type, name, config) => ipcRenderer.invoke('control:save-plugin-config', type, name, config),
  readPluginReadme: (type, name) => ipcRenderer.invoke('control:read-plugin-readme', type, name),
  installPlugin: (id, repo) => ipcRenderer.invoke('control:install-plugin', id, repo),
  installPluginDlc: (name, url) => ipcRenderer.invoke('control:install-plugin-dlc', name, url),
  onDlcProgress: callback => ipcRenderer.on('control:dlc-progress', (_event, text) => callback(text)),
  launchPluginBat: (name, bat) => ipcRenderer.invoke('control:launch-plugin-bat', name, bat),
  onPluginsChanged: callback => ipcRenderer.on('control:plugins-changed', () => callback()),
  loadConfig: () => ipcRenderer.invoke('control:load-config'),
  getChatHistory: () => ipcRenderer.invoke('control:get-chat-history'),
  environmentInfo: () => ipcRenderer.invoke('control:environment-info'),
  getPrompts: () => ipcRenderer.invoke('control:get-prompts'),
  fetchLlmModels: (apiUrl, apiKey) => ipcRenderer.invoke('control:fetch-llm-models', apiUrl, apiKey),
  testLlmModel: (apiUrl, apiKey, model) => ipcRenderer.invoke('control:test-llm-model', apiUrl, apiKey, model),
  listMcpTools: () => ipcRenderer.invoke('control:list-mcp-tools'),
  toggleMcpTool: (type, key) => ipcRenderer.invoke('control:toggle-mcp-tool', type, key),
  getToolMarket: () => ipcRenderer.invoke('control:get-tool-market'),
  downloadTool: tool => ipcRenderer.invoke('control:download-tool', tool),
  saveConfig: config => ipcRenderer.invoke('control:save-config', config),
  listLive2dModels: () => ipcRenderer.invoke('control:list-live2d-models'),
  currentLive2dModel: () => ipcRenderer.invoke('control:current-live2d-model'),
  selectLive2dModel: name => ipcRenderer.invoke('control:select-live2d-model', name),
  loadMotionData: character => ipcRenderer.invoke('control:load-motion-data', character),
  saveMotionData: (character, kind, values) => ipcRenderer.invoke('control:save-motion-data', character, kind, values),
  resetMotionData: (character, kind) => ipcRenderer.invoke('control:reset-motion-data', character, kind),
  triggerMotion: name => ipcRenderer.invoke('control:trigger-motion', name),
  triggerExpression: name => ipcRenderer.invoke('control:trigger-expression', name),
  applyVmc: (host, port) => ipcRenderer.invoke('control:apply-vmc', host, port),
  startLive2d: () => ipcRenderer.invoke('control:start-live2d'),
  stopLive2d: () => ipcRenderer.invoke('control:stop-live2d'),
  onLive2dLog: callback => ipcRenderer.on('control:live2d-log', (_event, text) => callback(text)),
  onToolLog: callback => ipcRenderer.on('control:tool-log', (_event, text) => callback(text)),
  onLive2dState: callback => ipcRenderer.on('control:live2d-state', (_event, running) => callback(running)),
  overview: () => ipcRenderer.invoke('control:overview'),
  memory: () => ipcRenderer.invoke('control:memory'),
  // B3 记忆体检（2026-11-23）：只读跑 pet-runtime/tools/memos-consistency.mjs --json
  memoryConsistency: () => ipcRenderer.invoke('control:memory-consistency'),
  toggleQuiet: on => ipcRenderer.invoke('control:toggle-quiet', on),
  petbodyEval: js => ipcRenderer.invoke('control:petbody-eval', js),
  // 能力注册表（2026-11-16）：设置项由 js/core/capabilities.js 生成
  capabilities: () => ipcRenderer.invoke('control:capabilities'),
  setConfigValue: (key, value) => ipcRenderer.invoke('control:set-config-value', { key, value }),

  // ── 知识库、技能库与操控日志（新增）──
  knowledgeListGames: () => ipcRenderer.invoke('control:knowledge-list-games'),
  knowledgeGetGame: game => ipcRenderer.invoke('control:knowledge-get-game', game),
  knowledgeSaveRules: (game, data) => ipcRenderer.invoke('control:knowledge-save-rules', game, data),
  knowledgeSaveLive: (game, data) => ipcRenderer.invoke('control:knowledge-save-live', game, data),
  knowledgeAddExperience: exp => ipcRenderer.invoke('control:knowledge-add-experience', exp),
  skillsList: () => ipcRenderer.invoke('control:skills-list'),
  skillsRun: name => ipcRenderer.invoke('control:skills-run', name),
  skillsDelete: name => ipcRenderer.invoke('control:skills-delete', name),
  actionsGetHistory: () => ipcRenderer.invoke('control:actions-get-history'),

  // ── 后台任务（派活账本 P0 列表/详情 + P1 取消 + 续聊）──
  // 列表直读 data/dispatch-tasks.jsonl；详情/取消/续聊走 8103 + .control-token。
  dispatchTasksList: () => ipcRenderer.invoke('control:dispatch-tasks-list'),
  dispatchTaskDetail: id => ipcRenderer.invoke('control:dispatch-task-detail', id),
  dispatchCancel: id => ipcRenderer.invoke('control:dispatch-cancel', id),
  dispatchRetry: task => ipcRenderer.invoke('control:dispatch-retry', { task }),
  // parent = 详情快照（state/sessionId）；主进程用同一份策略再闸一次
  dispatchFollowup: (taskId, task, parent) => ipcRenderer.invoke('control:dispatch-followup', { taskId, task, parent })
});
