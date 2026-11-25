const { app, BrowserWindow, ipcMain, shell, net, dialog } = require('electron');

// Electron 28 / Chromium 120 retains an IMM32 fallback for Windows IMEs.
// The failing session receives only keyUp events, with no keyDown or composition
// reaching webContents despite correct focus. Use the alternate native IME path.
// https://github.com/chromium/chromium/blob/120.0.6099.225/ui/base/ime/init/input_method_factory.cc
if (process.platform === 'win32' && process.versions.electron?.startsWith('28.')) {
  const disabledFeatures = new Set(app.commandLine.getSwitchValue('disable-features').split(',').filter(Boolean));
  disabledFeatures.add('TSFImeSupport');
  app.commandLine.appendSwitch('disable-features', [...disabledFeatures].join(','));
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const http = require('http');
const nodeNet = require('node:net');
const { scanLive2DModels, resolveLive2DModel, scanVRMModels, scanMMDModels } = require('./js/avatar/model-registry');
const { EMOTIONS: motionEmotions, mergeExpressionConfig, mergeActionConfig, isLive2DModelDir } = require('./js/avatar/model-defaults');
const { loadProvidersFromStore, saveProviders, normalizeProvidersData } = require('./js/core/llm-provider-store');
const { CAPABILITIES, getPath: getConfigPath, resolveCapabilityValue } = require('./js/core/capabilities');
// 2026-11-17 六十三轮：配置写盘/热重载/读回的唯一入口（详见模块头部注释）
const { saveAndApply, notifyHostReload, writeJsonVerified } = require('./js/core/config-persist');
// 插件配置凭据掩码/回填（与 webui/plugin_manager.py 同一套规则，唯一实现）
const { maskSecrets, restoreSecrets } = require('./js/core/secret-mask');
const aliyunVoiceClone = require('./js/voice/aliyun-voice-clone');

const configPath = path.join(__dirname, 'config.json');
const pluginsPath = path.join(__dirname, 'plugins');

// DLC 安装只允许从固定的 GitHub 主机下载（渲染层传入的 URL 不再被无条件信任）。
const DLC_ALLOWED_HOSTS = new Set(['github.com', 'raw.githubusercontent.com', 'codeload.github.com']);
// 下载过程中允许出现的目标主机（GitHub 会重定向到对象存储 CDN）。
const DLC_REDIRECT_ALLOWED_HOSTS = new Set([
  ...DLC_ALLOWED_HOSTS,
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'media.githubusercontent.com',
]);
const DLC_HASHES_PATH = path.join(__dirname, 'plugins-dlc', '.hashes.json');

function validateDlcUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl || '')); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (!DLC_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return parsed.toString();
}

function readDlcHashes() {
  try {
    const data = JSON.parse(fs.readFileSync(DLC_HASHES_PATH, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

function writeDlcHashes(hashes) {
  fs.mkdirSync(path.dirname(DLC_HASHES_PATH), { recursive: true });
  const temp = `${DLC_HASHES_PATH}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(hashes, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, DLC_HASHES_PATH);
}

let live2dProcess = null;
const runtimeLogPath = path.join(__dirname, 'runtime.log');
let runtimeLogSender = null;
let runtimeLogLength = 0;
let runtimeLogRemainder = '';
let controlWindow = null;

// 🔥 单实例锁：反复双击 肥牛.exe 之前会一直开新窗口/新进程，
// 拿不到锁就直接退出，并把已有窗口拉到前台。
// page 附加数据：皮套右键「换装」带 PET_PANEL_PAGE 拉起面板时，如果面板已在跑，
// 新进程会被锁弹掉——必须把 page 经 additionalData 转发给已有窗口，
// 否则表现为「换装跳转没了」（2026-11-01 规整修复）。
// --control-isolated：QA/截图用隔离实例（独立 userData + 不参与单实例锁 + 关窗即退）。
const __isolated = process.argv.includes('--control-isolated');
if (__isolated) {
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'pet-control-qa-' + Date.now()));
}
if (!__isolated && !app.requestSingleInstanceLock({ page: process.env.PET_PANEL_PAGE || '' })) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', (_event, argv, workingDirectory, additionalData) => {
  if (!controlWindow || controlWindow.isDestroyed()) return;
  if (controlWindow.isMinimized()) controlWindow.restore();
  controlWindow.show();
  controlWindow.focus();
  const page = String((additionalData && additionalData.page) || '').replace(/[^a-z-]/gi, '');
  if (page) {
    controlWindow.webContents.executeJavaScript(
      "(()=>{ const b=document.querySelector('[data-page=\"" + page + "\"]'); if(b) b.click(); return !!b; })()"
    ).catch((error) => console.error('[control] 跳页失败:', error && error.message));
  }
});
let selectedVoiceModelPath = '';
let selectedVoiceAudioPath = '';
let selectedAliyunAudioPath = '';
let avatarLoadingWindow = null;
let avatarLoadingTimer = null;

function closeAvatarLoadingWindow() {
  clearTimeout(avatarLoadingTimer);
  avatarLoadingTimer = null;
  if (avatarLoadingWindow && !avatarLoadingWindow.isDestroyed()) avatarLoadingWindow.destroy();
  avatarLoadingWindow = null;
}

function showAvatarLoadingWindow() {
  closeAvatarLoadingWindow();
  const displays = require('electron').screen.getAllDisplays();
  const minX = Math.min(...displays.map(display => display.bounds.x));
  const minY = Math.min(...displays.map(display => display.bounds.y));
  const maxX = Math.max(...displays.map(display => display.bounds.x + display.bounds.width));
  const maxY = Math.max(...displays.map(display => display.bounds.y + display.bounds.height));
  const cached = readJson(path.join(__dirname, 'avatar-loading-position.json'), null);
  const config = readJson(configPath, {});
  const pos = config.ui?.model_position || {};
  const relX = Number.isFinite(cached?.x) ? cached.x : Math.max(0, Math.min(1, Number(pos.x) || 0.65));
  const relY = Number.isFinite(cached?.y) ? cached.y : Math.max(0, Math.min(1, Number(pos.y) || 0.38));
  const size = 72;
  avatarLoadingWindow = new BrowserWindow({
    x: Math.round(minX + (maxX - minX) * relX - size / 2),
    y: Math.round(minY + (maxY - minY) * relY - size / 2),
    width: size,
    height: size,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  avatarLoadingWindow.setIgnoreMouseEvents(true);
  avatarLoadingWindow.setAlwaysOnTop(true, 'screen-saver');
  avatarLoadingWindow.loadFile('avatar-loading.html');
  avatarLoadingWindow.once('ready-to-show', () => avatarLoadingWindow?.showInactive());
  avatarLoadingTimer = setTimeout(closeAvatarLoadingWindow, 30000);
}

function cleanToolLog(line) {
  return line
    .replace(/^(?:\[[^\]\r\n]+\]\s*)+/, '')
    .replace(/插件已加载[：:]\s*/u, '')
    .trim();
}

function cleanPetLog(line) {
  if (/\[Live2DStage\]\s*初始化完成|\[Live2DSetup\]\s*共发现|\[Live2DLoader\]\s*(?:开始加载模型|transform:|模型加载完成)|\[ParamDirector\]\s*已启用|\[Live2DRuntime\]\s*已安装|\[EmotionEngine\].*配置加载完成|\[AuDriver\]\s*(?:未找到模型 AU 配置|跳过不可映射 AU|已就绪|解算)|\[AvatarFacade\]\s*形态已激活/.test(line)) return null;
  if (/插件热加载监听已启动|\[Plugin:core_memory_injector\].*(?:不存在，跳过加载|插件已启动)|\[Plugin:dawn_dusk_line\].*已启动|\[Plugin:user_profile\].*(?:插件已启动|MemOS 不可用)|\[MotionDirector\]\s*(?:body|face)\s*失败，保留本地编舞|对话模型[：:].*提供商|配置文件加载成功|AI回复中/.test(line)) return null;
  if (/已将内容发送给AI/.test(line)) return null;
  const modelMatch = line.match(/已加载\s*\d+\s*个\s*LLM\s*提供商[^\n]*?当前模型[：:]\s*([^）)\s]+)/i);
  return modelMatch ? `当前使用模型：${modelMatch[1]}` : line.replace(/\[Plugin:[^\]\r\n]+\][ \t]*/g, '');
}

function pumpRuntimeLog(flush = false) {
  if (!runtimeLogSender || runtimeLogSender.isDestroyed() || !fs.existsSync(runtimeLogPath)) return;
  try {
    const content = fs.readFileSync(runtimeLogPath, 'utf8');
    if (content.length < runtimeLogLength) runtimeLogLength = 0;
    runtimeLogRemainder += content.slice(runtimeLogLength);
    runtimeLogLength = content.length;
    const lines = runtimeLogRemainder.split(/\r?\n/);
    runtimeLogRemainder = flush ? '' : lines.pop();
    if (flush && lines.length && !lines[lines.length - 1]) lines.pop();
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/\[AvatarFacade\]\s*形态已激活|\[Live2DLoader\]\s*模型加载完成/.test(line)) closeAvatarLoadingWindow();
      const channel = line.includes('[TOOL]') ? 'control:tool-log' : 'control:live2d-log';
      const cleaned = channel === 'control:tool-log' ? cleanToolLog(line) : cleanPetLog(line);
      if (cleaned) runtimeLogSender.send(channel, `${cleaned}\n`);
    }
  } catch (error) {
    if (!runtimeLogSender.isDestroyed()) runtimeLogSender.send('control:live2d-log', `读取日志文件出错：${error.message}\n`);
  }
}

function startRuntimeLog(sender) {
  fs.unwatchFile(runtimeLogPath);
  fs.writeFileSync(runtimeLogPath, '', 'utf8');
  runtimeLogSender = sender;
  runtimeLogLength = 0;
  runtimeLogRemainder = '';
  fs.watchFile(runtimeLogPath, { interval: 100 }, () => pumpRuntimeLog());
}

function stopRuntimeLog() {
  pumpRuntimeLog(true);
  fs.unwatchFile(runtimeLogPath);
  runtimeLogSender = null;
  runtimeLogLength = 0;
  runtimeLogRemainder = '';
}
const serviceProcesses = { tts: null, asr: null, bert: null };
const serviceDownloads = { tts: null, asr: null, bert: null };
const serviceDefinitions = {
  tts: { name: 'TTS 语音合成', port: 5000, bat: '2.TTS.bat', flag: '--tts', checks: [
    'tts-hub/GPT-SoVITS-Bundle/runtime', 'tts-hub/GPT-SoVITS-Bundle/GPT_SoVITS'
  ] },
  asr: { name: 'ASR 语音识别', port: 1000, bat: '1.ASR.bat', flag: '--asr', checks: [
    'asr-hub/model/torch_hub/snakers4_silero-vad_master',
    'asr-hub/model/asr/models/iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch/config.yaml',
    'asr-hub/model/asr/models/iic/punc_ct-transformer_cn-en-common-vocab471067-large/config.yaml',
    'asr-hub/model/asr/models/iic/punc_ct-transformer_cn-en-common-vocab471067-large/model.pt'
  ] },
  bert: { name: 'BERT 模型服务', port: 6007, bat: '3.bert.bat', flag: '--bert', checks: [
    'bert-hub/config.json', 'bert-hub/model.safetensors', 'bert-hub/vocab.txt'
  ] }
};
const projectRoot = path.resolve(__dirname, '..');
const hubRoot = path.join(projectRoot, 'full-hub');
const projectEnvPython = path.join(projectRoot, 'env', 'python.exe');
const projectEnvUrl = 'https://modelscope.cn/models/morelle/my-neuro-env/resolve/master/my-neuro-env.tar.gz';

async function ensureProjectPython(sender, service) {
  if (fs.existsSync(projectEnvPython)) return projectEnvPython;
  const tempDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'my-neuro-env-'));
  const archive = path.join(tempDir, 'my-neuro-env.tar.gz');
  const envDir = path.join(projectRoot, 'env');
  sendServiceLog(sender, service, '@@ENV_START\n');
  sendServiceLog(sender, service, '\u672a\u68c0\u6d4b\u5230\u9879\u76ee Python \u73af\u5883\uff0c\u5f00\u59cb\u4e0b\u8f7d morelle/my-neuro-env...\n');
  try {
    const response = await net.fetch(projectEnvUrl, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    let received = 0;
    let lastPercent = -1;
    const progressStream = new (require('node:stream').Transform)({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        const percent = total ? Math.min(100, Math.floor(received / total * 100)) : 0;
        if (percent !== lastPercent) {
          lastPercent = percent;
          sendServiceLog(sender, service, `@@ENV_PROGRESS:${percent}:${received}:${total}\n`);
        }
        callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body), progressStream, fs.createWriteStream(archive));
    fs.mkdirSync(envDir, { recursive: true });
    sendServiceLog(sender, service, '@@ENV_EXTRACT\n');
    sendServiceLog(sender, service, '\u9879\u76ee Python \u73af\u5883\u4e0b\u8f7d\u5b8c\u6210\uff0c\u6b63\u5728\u89e3\u538b...\n');
    await new Promise((resolve, reject) => {
      const child = spawn('tar.exe', ['-xzf', archive, '-C', envDir], { windowsHide: true });
      let errorText = '';
      child.stderr.on('data', chunk => { errorText += String(chunk); });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(errorText.trim() || `tar.exe ${code}`)));
    });
    if (!fs.existsSync(projectEnvPython)) throw new Error('\u89e3\u538b\u540e\u672a\u627e\u5230 env\\python.exe');
    sendServiceLog(sender, service, '@@ENV_DONE\n');
    sendServiceLog(sender, service, '\u9879\u76ee Python \u73af\u5883\u5b89\u88c5\u5b8c\u6210\u3002\n');
    return projectEnvPython;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function serviceLaunchDefinition(id) {
  const definition = serviceDefinitions[id];
  if (id !== 'asr' || !definition) return definition;
  const current = readJson(configPath, {});
  if (current.cloud?.baidu_asr?.enabled === true) {
    return { ...definition, name: '百度流式 ASR（仅 VAD）', bat: 'VAD.bat' };
  }
  if (current.cloud?.siliconflow_asr?.enabled === true) {
    return { ...definition, name: 'SiliconFlow ASR（本地 VAD）' };
  }
  return { ...definition, name: '本地 ASR' };
}

function serviceInstalled(definition) {
  return definition.checks.every(item => fs.existsSync(path.join(hubRoot, item)));
}

function portListening(port) {
  return new Promise(resolve => {
    const socket = nodeNet.createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
    socket.setTimeout(450);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function sendServiceLog(sender, service, text) {
  if (!sender.isDestroyed()) sender.send('control:service-log', { service, text: String(text) });
}

async function serviceStatus() {
  return Promise.all(Object.entries(serviceDefinitions).map(async ([id, definition]) => {
    const listening = await portListening(definition.port);
    const processActive = Boolean(serviceProcesses[id] && serviceProcesses[id].exitCode === null);
    return {
      id, name: definition.name, port: definition.port,
      installed: serviceInstalled(definition),
      downloading: Boolean(serviceDownloads[id]),
      running: listening || processActive,
      starting: processActive && !listening
    };
  }));
}

async function stopConfiguredServices() {
  for (const [id, definition] of Object.entries(serviceDefinitions)) {
    const pids = await listeningPids(definition.port);
    if (serviceProcesses[id]?.pid) pids.push(String(serviceProcesses[id].pid));
    for (const pid of new Set(pids)) {
      await runProcess('taskkill.exe', ['/pid', pid, '/t', '/f']).catch(() => {});
    }
    serviceProcesses[id] = null;
    if (serviceDownloads[id]?.pid) {
      await runProcess('taskkill.exe', ['/pid', String(serviceDownloads[id].pid), '/t', '/f']).catch(() => {});
      serviceDownloads[id] = null;
    }
  }
}

function listeningPids(port) {
  return new Promise(resolve => {
    const child = spawn('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.on('error', () => resolve([]));
    child.on('exit', () => {
      const pids = new Set();
      for (const line of output.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[1]?.endsWith(`:${port}`) && parts[3] === 'LISTENING') pids.add(parts[4]);
      }
      resolve([...pids]);
    });
  });
}

function readJson(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

// writeJsonVerified 已抽到 js/core/config-persist.js（2026-11-17 六十三轮）：
// 写盘策略（.bak → .tmp → rename → 回读键数校验）只保留一份，避免两处实现漂移。

// 思考等级合法档位；运行时经 js/ai/reasoning-request.js 写进请求体（thinking + reasoning_effort）
const REASONING_EFFORTS = ['low', 'medium', 'high'];

// 模型级参数：真值住在 llm_providers.json 的**当前模型条目**上。
//   读取链：config-loader → persistProviderStore 注水 config.llm_providers
//          → llmProviderManager.init → resolveProvider/_buildResolved 平铺
//          → LLMClient.fromProviderConfig（只认平铺后的 reasoning_enabled 等）。
// 能力页以前只写 config.json —— saveControlConfig 还会把这些同名键从 config 删掉，
// 所以运行时永远读不到，拨开关等于没拨（2026-11-21 实测：写 config 后有效值仍是模型里的 false）。
const MODEL_PARAM_KEYS = Object.freeze({
  'llm.reasoning_enabled': 'reasoning_enabled',
  'llm.reasoning_effort': 'reasoning_effort',
  'llm.temperature_enabled': 'temperature_enabled',
  'llm.temperature': 'temperature',
});

// 运行时「config 优先于模型」的两个键（js/ai/llm-handler.js applySampling 先读 config.llm）。
// 如果 config.json 里还留着旧键且值不同，只写模型不会生效 —— 必须改走 config 回退，
// 否则就会重现「写了个运行时没人读的键」这个病。
const CONFIG_PREFERRED_MODEL_PARAMS = new Set(['llm.temperature_enabled', 'llm.temperature']);

/** 模型参数的落盘形态（不做隐式类型转换，避免把 "false" 写成 true） */
function normalizeModelParamValue(key, value) {
  if (key === 'llm.reasoning_enabled' || key === 'llm.temperature_enabled') {
    return typeof value === 'boolean' ? value : undefined;
  }
  if (key === 'llm.temperature') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (key === 'llm.reasoning_effort') {
    const s = typeof value === 'string' ? value.trim() : '';
    return s && s.length <= 32 ? s : undefined;
  }
  return undefined;
}

function loadControlConfig() {
  const config = readJson(configPath, {});
  config.tts ||= {};
  config.asr ||= {};
  config.tts.enabled = true;
  config.asr.enabled = true;
  config.llm ||= {};
  const providers = loadProvidersFromStore(__dirname).providers;
  const provider = providers.find(item => item.id === config.llm.provider_id)
    || providers.find(item => item.enabled !== false)
    || providers[0];
  // An explicitly saved empty model is intentional; only legacy configs need a default.
  const hasModelSelection = Object.prototype.hasOwnProperty.call(config.llm, 'model_id');
  const model = hasModelSelection
    ? provider?.models?.find(item => item.model_id === config.llm.model_id)
    : provider?.models?.find(item => item.enabled !== false) || provider?.models?.[0];
  if (hasModelSelection) config.llm.model = config.llm.model_id || '';
  if (provider) {
    config.llm.provider_id = provider.id;
    config.llm.api_key = provider.api_key || '';
    config.llm.api_url = provider.api_url || '';
  }
  if (model) {
    config.llm.model_id = model.model_id;
    config.llm.model = model.model_id;
    if (model.temperature !== undefined) config.llm.temperature = model.temperature;
    if (model.temperature_enabled !== undefined) config.llm.temperature_enabled = model.temperature_enabled;
    // 思考等级是模型级参数（MODEL_PARAM_KEYS），这里物化出来给页面显示真实值
    if (model.reasoning_enabled !== undefined) config.llm.reasoning_enabled = model.reasoning_enabled === true;
    if (model.reasoning_effort !== undefined) config.llm.reasoning_effort = String(model.reasoning_effort);
  }
  // 新版「模型配置」页需要整份通讯录（含密钥，与旧版 llm.api_key 同一信任域）：
  // 以 __llm_providers 搭车回渲染层，保存时由 saveControlConfig 取走并从 config.json 剔除。
  config.__llm_providers = providers;
  config.vision ||= {};
  config.vision.vision_model ||= {};
  const visionProvider = providers.find(item => item.id === config.vision.provider_id);
  const hasVisionModelSelection = Object.prototype.hasOwnProperty.call(config.vision, 'model_id');
  const visionModel = hasVisionModelSelection
    ? visionProvider?.models?.find(item => item.model_id === config.vision.model_id)
    : visionProvider?.models?.find(item => item.enabled !== false) || visionProvider?.models?.[0];
  if (hasVisionModelSelection) config.vision.vision_model.model = config.vision.model_id || '';
  if (visionProvider) {
    config.vision.vision_model.api_key = visionProvider.api_key || '';
    config.vision.vision_model.api_url = visionProvider.api_url || '';
  }
  if (visionModel) config.vision.vision_model.model = visionModel.model_id;
  return config;
}

function saveControlConfig(config) {
  config.llm ||= {};
  // 新版模型页把整份 provider 通讯录随配置送回（__llm_providers = 渲染层工作副本）；
  // 没带回的旧调用方回落到磁盘上的 llm_providers.json，并保留旧三格（api_key/api_url/model）改写语义。
  const providerOverride = Array.isArray(config.__llm_providers) && config.__llm_providers.length
    ? normalizeProvidersData(config.__llm_providers)
    : null;
  delete config.__llm_providers;
  const providers = providerOverride || loadProvidersFromStore(__dirname).providers;
  let provider = providers.find(item => item.id === config.llm.provider_id)
    || providers.find(item => item.enabled !== false)
    || providers[0];
  if (!provider) {
    provider = { id: 'main', name: '主模型', api_key: '', api_url: '', enabled: true, models: [] };
    providers.push(provider);
  }
  // 通讯录模式下凭据的编辑已经发生在带回的 provider 对象上，这里绝不能再用视图三格覆盖它
  if (!providerOverride) {
    // ⚠ 2026-11-16 修 P0（能力开关把对话凭据清空）：
    // config.llm.api_key/api_url 是**迁移前的旧字段**，迁移后已从 config 删除。
    // 原来这里无条件用它们覆盖 provider → 任何不走通讯录的保存（如 control:set-config-value）
    // 都会把 provider 的 url/key 写成空串，LLM 直接 Failed to fetch。
    // 只有「legacy 字段真的有值」才允许覆盖；空值一律视为「没有意见」。
    const legacyKey = String(config.llm.api_key || '').trim();
    const legacyUrl = String(config.llm.api_url || '').trim();
    if (legacyKey) provider.api_key = legacyKey;
    if (legacyUrl) provider.api_url = legacyUrl;
    provider.enabled = true;
  }
  provider.models ||= [];
  const modelId = String(Object.prototype.hasOwnProperty.call(config.llm, 'model') ? config.llm.model : (config.llm.model_id || '')).trim();
  let model = provider.models.find(item => item.model_id === modelId);
  if (modelId && !model) {
    model = { model_id: modelId, name: modelId, enabled: true };
    provider.models.push(model);
  }
  if (model) {
    model.enabled = true;
    if (config.llm.temperature !== undefined) model.temperature = Number(config.llm.temperature);
    if (config.llm.temperature_enabled !== undefined) model.temperature_enabled = Boolean(config.llm.temperature_enabled);
    // 思考等级：页面四态（关/低/中/高）→ 模型级参数，运行时经 llmProvider._buildResolved 平铺进 LLMClient
    if (config.llm.reasoning_enabled !== undefined) model.reasoning_enabled = Boolean(config.llm.reasoning_enabled);
    if (REASONING_EFFORTS.includes(String(config.llm.reasoning_effort || ''))) {
      model.reasoning_effort = String(config.llm.reasoning_effort);
    }
  }
  config.llm.provider_id = provider.id;
  config.llm.model_id = modelId;
  config.vision ||= {};
  const visionView = config.vision.vision_model || {};
  const visionModelId = String(Object.prototype.hasOwnProperty.call(visionView, 'model') ? visionView.model : (config.vision.model_id || '')).trim();
  const visionProviderId = String(config.vision.provider_id || '').trim();
  const hasVisionConfig = Boolean(visionModelId || visionProviderId
    || (!providerOverride && (String(visionView.api_key || '').trim() || String(visionView.api_url || '').trim())));
  if (hasVisionConfig) {
    let visionProvider = providers.find(item => item.id === visionProviderId);
    if (!visionProvider && !providerOverride) {
      visionProvider = providers.find(item => item.api_key === String(visionView.api_key || '') && item.api_url === String(visionView.api_url || ''));
    }
    if (!visionProvider) {
      let id = 'vision';
      let suffix = 2;
      while (providers.some(item => item.id === id)) id = `vision-${suffix++}`;
      visionProvider = { id, name: '视觉模型', api_key: '', api_url: '', enabled: true, models: [] };
      providers.push(visionProvider);
    }
    if (!providerOverride) {
      visionProvider.api_key = String(visionView.api_key || '');
      visionProvider.api_url = String(visionView.api_url || '');
      visionProvider.enabled = true;
    }
    visionProvider.models ||= [];
    if (visionModelId && !visionProvider.models.some(item => item.model_id === visionModelId)) {
      visionProvider.models.push({ model_id: visionModelId, name: visionModelId, enabled: true });
    }
    config.vision.provider_id = visionProvider.id;
    config.vision.model_id = visionModelId;
  } else {
    config.vision.provider_id = '';
    config.vision.model_id = '';
  }
  config.vision.vision_model = {};
  delete config.llm.api_key;
  delete config.llm.api_url;
  delete config.llm.model;
  delete config.llm.temperature;
  delete config.llm.temperature_enabled;
  delete config.llm.reasoning_enabled;
  delete config.llm.reasoning_effort;
  // 2026-11-17 加固：provider 通讯录（云端 url/key）先落盘，并把结果带出去 ——
  // 写失败时 control:save-config 必须中止 config.json 写入并返回 ok:false，
  // 否则磁盘上会出现「config.json 选了新 provider，llm_providers.json 还是旧 key」的半套状态。
  const providersWrite = saveProviders(__dirname, providers);
  // 2026-11-17 六十三轮：这里不再自己写盘 —— 写盘/热重载/读回统一交给
  // config-persist.saveAndApply（control:save-config 调用）。本函数只负责把渲染层
  // 送来的整份配置规整成可落盘形状，并先落 provider 通讯录。
  return { config, providersWrite };
}

function listPlugins() {
  const enabled = new Set(readJson(path.join(pluginsPath, 'enabled_plugins.json'), { plugins: [] }).plugins || []);
  const result = { builtIn: [], community: [], market: [] };
  for (const [type, key] of [['built-in', 'builtIn'], ['community', 'community']]) {
    const base = path.join(pluginsPath, type);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      const metaPath = path.join(dir, 'metadata.json');
      if (!fs.existsSync(metaPath)) continue;
      const meta = readJson(metaPath, {});
      const configFile = path.join(dir, 'plugin_config.json');
      // 凭据类字段只回掩码（***末4位），maskedKeys 供界面显示「已设置」；
      // 明文绝不进渲染层，保存时由 control:save-plugin-config 回填磁盘原值。
      const maskedConfig = maskSecrets(readJson(configFile, {}));
      result[key].push({ type, name: entry.name, relPath: `${type}/${entry.name}`,
        displayName: meta.displayName || meta.name || entry.name, description: meta.description || '',
        author: meta.author || '', version: meta.version || '', enabled: enabled.has(`${type}/${entry.name}`),
        hasConfig: fs.existsSync(configFile), config: maskedConfig.value, maskedKeys: maskedConfig.maskedKeys,
        hasReadme: fs.existsSync(path.join(dir, 'README.md')), bat: meta.bat || '', downloadDlc: meta.download_dlc || '',
        dlcInstalled: !meta.download_dlc || fs.existsSync(path.join(__dirname, 'plugins-dlc', entry.name)) });
    }
    result[key].sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));
  }
  const market = readJson(path.join(pluginsPath, 'plugin-house', 'plugin_hub.json'), {});
  const marketDisplayNames = {
    'time-awareness': '时间感知',
    'my-neuro-plugin-hitokoto': '每日一言',
    'my-neuro-plugin-memos': 'MemOS 长期记忆',
    'loki-shadow': '洛基之影',
    'myneuro-plugin-skills': '技能管理',
    'core-memory-injector': '核心记忆注入',
    'astrbook-forum': 'AstrBook 论坛',
    'world-eye': '世界之眼',
    'ai-log': '思痕之册',
    'dawn-dusk-line': '晨昏之线',
    'mood-chat': '心情对话系统',
    'thinking-bubble': '思考气泡',
    'rebirth-feiniu-music': '网易云音乐',
    'bilibili-tools': 'B站工具',
    'multi-search': '多引擎搜索',
    'openrouter-image': 'OpenRouter 图像生成',
    'windows-app-launcher': 'Windows 应用启动',
    'mcp-filesystem': 'MCP 文件系统',
    'remote-sync': '远程同步',
    'exp3-model-processor': 'EXP3 表情整理器',
    'check-in': '定时问候',
    'txt-writer': '文本写入',
    'minimax-music': 'MiniMax 音乐生成',
    'feiniu-board-game': '大肥鱼棋盘游戏',
    'kimi-search': 'Kimi 联网搜索',
    'agent-dream': '梦境系统',
    'qq-connect': 'QQ 连接',
    'timed-tasks': '定时任务',
    'screen-narrator': '屏幕感知'
  };
  result.market = Object.entries(market).map(([id, item]) => {
    const installedPlugin = result.community.find(plugin => plugin.name === id);
    return {
      id,
      ...item,
      display_name: installedPlugin?.displayName || marketDisplayNames[id] || item.display_name || id,
      installed: Boolean(installedPlugin)
    };
  });
  return result;
}

const pluginMarketUrl = 'https://raw.githubusercontent.com/morettt/my-neuro/main/live-2d/plugins/plugin-house/plugin_hub.json';

async function refreshPluginMarket() {
  const response = await net.fetch(pluginMarketUrl, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`获取插件列表失败（HTTP ${response.status}）`);
  const market = await response.json();
  if (!market || Array.isArray(market) || typeof market !== 'object') throw new Error('插件列表格式无效');
  fs.writeFileSync(path.join(pluginsPath, 'plugin-house', 'plugin_hub.json'), `${JSON.stringify(market, null, 2)}\n`, 'utf8');
  return listPlugins();
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let output = '';
    const forward = chunk => { const text = chunk.toString(); output += text; options.onOutput?.(text); };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(output.trim() || `${command} 退出码 ${code}`)));
  });
}

async function downloadFileOnce(url, file, onProgress, options = {}) {
  let received = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const headers = received ? { Range: `bytes=${received}-` } : {};
  const response = await net.fetch(url, { headers, signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
  if (options.allowedFinalHosts && response.url) {
    let finalHost = '';
    try { finalHost = new URL(response.url).hostname.toLowerCase(); } catch { finalHost = ''; }
    if (!finalHost || !options.allowedFinalHosts.has(finalHost)) {
      throw new Error(`下载被重定向到未授权主机：${finalHost || response.url}`);
    }
  }
  if (received && response.status !== 206) { received = 0; fs.rmSync(file, { force: true }); }
  const total = received + (Number(response.headers.get('content-length')) || 0);
  const output = fs.createWriteStream(file, { flags: received ? 'a' : 'w' });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Download stream unavailable');
  try {
    while (true) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('download stalled for 30 seconds')), 30000))
      ]);
      if (done) break;
      received += value.byteLength;
      if (!output.write(Buffer.from(value))) await new Promise(resolve => output.once('drain', resolve));
      onProgress?.(received, total);
    }
  } finally { output.end(); }
}

async function downloadFile(url, file, onProgress, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      await downloadFileOnce(url, file, onProgress, options);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 8) await new Promise(resolve => setTimeout(resolve, Math.min(attempt * 2000, 10000)));
    }
  }
  throw lastError;
}

async function expandZip(zipFile, destination, onProgress) {
  fs.mkdirSync(destination, { recursive: true });
  await runProcess('7z.exe', ['x', zipFile, `-o${destination}`, '-y', '-bsp1'], {
    onOutput: text => { const match = text.match(/(\d+)%/); if (match) onProgress?.(match[1]); }
  });
  /* await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Expand-Archive -LiteralPath $env:MY_NEURO_PLUGIN_ZIP -DestinationPath $env:MY_NEURO_PLUGIN_DESTINATION -Force'], {
    env: {
      ...process.env,
      MY_NEURO_PLUGIN_ZIP: zipFile,
      MY_NEURO_PLUGIN_DESTINATION: destination
    }
  }); */
}

function flattenSingleDirectory(destination) {
  const entries = fs.readdirSync(destination, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) return;
  const nested = path.join(destination, entries[0].name);
  for (const entry of fs.readdirSync(nested)) {
    fs.renameSync(path.join(nested, entry), path.join(destination, entry));
  }
  fs.rmSync(nested, { recursive: true, force: true });
}

async function installModelScopeDlc(repoUrl, destination, onProgress) {
  const match = repoUrl.match(/^https:\/\/www\.modelscope\.cn\/(models|datasets)\/([\w.-]+)\/([\w.-]+)\/?$/i);
  if (!match) throw new Error('魔搭仓库地址无效');
  const repoId = `${match[2]}/${match[3]}`;
  const kind = match[1].toLowerCase() === 'datasets' ? '--dataset' : '--model';
  fs.mkdirSync(destination, { recursive: true });
  let lastError;
  for (const command of ['modelscope', 'python.exe']) {
    try {
      const args = command === 'modelscope'
        ? ['download', kind, repoId, '--revision', 'master', '--local_dir', destination]
        : ['-m', 'modelscope', 'download', kind, repoId, '--revision', 'master', '--local_dir', destination];
      await runProcess(command, args, { cwd: destination, onOutput: text => onProgress?.(text) });
      const required = ['web.py', 'weights/gpt.pth', 'weights/vq.pth', 'runtime/env/python.exe', '启动动作服务.bat'];
      const hasRequired = required.every(file => fs.existsSync(path.join(destination, file)));
      if (!hasRequired) throw new Error('魔搭下载不完整：缺少 BONES120 运行文件或权重');
      return;
    } catch (error) { lastError = error; }
  }
  throw new Error(`找不到可用的 ModelScope 下载命令：${lastError?.message || '请安装 modelscope CLI'}`);
}

async function installDependencies(pluginDir) {
  const messages = [];
  if (fs.existsSync(path.join(pluginDir, 'requirements.txt'))) {
    await runProcess('python.exe', ['-m', 'pip', 'install', '-r', path.join(pluginDir, 'requirements.txt')], { cwd: pluginDir });
    messages.push('Python 依赖已安装');
  }
  return messages;
}

async function installPluginArchive(id, repo) {
  if (!/^[\w.-]+$/.test(id) || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i.test(repo)) throw new Error('插件信息无效');
  const target = path.join(pluginsPath, 'community', id);
  if (fs.existsSync(target)) throw new Error('插件已经安装');
  const match = repo.replace(/\.git\/?$/i, '').match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  const temp = fs.mkdtempSync(path.join(app.getPath('temp'), 'my-neuro-plugin-'));
  const zipFile = path.join(temp, 'plugin.zip');
  const extractDir = path.join(temp, 'extract');
  try {
    let lastError;
    for (const branch of ['main', 'master']) {
      try { await downloadFile(`https://github.com/${match[1]}/${match[2]}/archive/refs/heads/${branch}.zip`, zipFile); lastError = null; break; }
      catch (error) { lastError = error; }
    }
    if (lastError) throw lastError;
    await expandZip(zipFile, extractDir);
    const roots = fs.readdirSync(extractDir, { withFileTypes: true }).filter(entry => entry.isDirectory());
    if (roots.length !== 1) throw new Error('插件压缩包结构无效');
    const source = path.join(extractDir, roots[0].name);
    if (!fs.existsSync(path.join(source, 'metadata.json'))) throw new Error('仓库根目录缺少 metadata.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
    const dependencyMessages = await installDependencies(target);
    return { ok: true, message: ['插件安装完成', ...dependencyMessages].join('，') };
  } catch (error) {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function postDesktop(route, payload, timeout = 2500) {
  return new Promise(resolve => {
    const body = JSON.stringify(payload);
    const request = http.request({ hostname: '127.0.0.1', port: 3002, path: route, method: 'POST', timeout,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(text)); } catch { resolve({ success: response.statusCode < 400, message: text }); } });
    });
    request.on('timeout', () => request.destroy(new Error('桌宠响应超时')));
    request.on('error', error => resolve({ success: false, message: error.message }));
    request.end(body);
  });
}

const motionFile = kind => path.join(__dirname, kind === 'actions' ? 'emotion_actions.json' : 'emotion_expressions.json');
const motionRootKey = kind => kind === 'actions' ? 'emotion_actions' : 'emotion_expressions';
const mergeMotionConfig = (kind, character, existing) => (kind === 'actions' ? mergeActionConfig : mergeExpressionConfig)(character, existing);
// WebUI 保存过的模型会有 per-model sidecar（2D/<模型>/emotion_mapping.json），桌宠优先读它而不是中央配置；
// 面板必须同样以它为准读写，否则这里的改动桌宠看不到。
const sidecarPath = character => path.join(__dirname, '2D', character, 'emotion_mapping.json');
const sidecarKeys = kind => kind === 'actions' ? { list: 'motions', named: 'actions' } : { list: 'expressions', named: 'expressions_named' };

function readMotionConfig(character, kind) {
  const sidecar = readJson(sidecarPath(character), null);
  if (!sidecar || typeof sidecar !== 'object') return readJson(motionFile(kind), {})[character]?.[motionRootKey(kind)];
  const { list, named } = sidecarKeys(kind);
  const config = {};
  for (const [emotion, entry] of Object.entries(sidecar.emotions || {})) if (Array.isArray(entry?.[list])) config[emotion] = entry[list];
  for (const [name, files] of Object.entries(sidecar[named] || {})) if (Array.isArray(files)) config[name] = files;
  return config;
}

function writeMotionConfig(character, kind, values) {
  const file = motionFile(kind);
  const all = readJson(file, {});
  all[character] ||= {};
  all[character][motionRootKey(kind)] = values;
  fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  const sidecar = readJson(sidecarPath(character), null);
  if (!sidecar || typeof sidecar !== 'object') return;
  const { list, named } = sidecarKeys(kind);
  sidecar.emotions ||= {};
  sidecar[named] = {};
  for (const [key, files] of Object.entries(values)) {
    if (motionEmotions.includes(key)) (sidecar.emotions[key] ||= {})[list] = files;
    else sidecar[named][key] = files;
  }
  fs.writeFileSync(sidecarPath(character), `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
}

// 桌宠运行中时让它重读表情/动作配置；未运行则静默忽略（下次启动自然生效）
// 2026-11-17 六十三轮：POST 实现收进 config-persist.notifyHostReload，这里只保留
// 动作配置调用点的旧签名（/reload-config 全项目只留一份请求实现）。
const notifyDesktopReload = () => notifyHostReload({ timeoutMs: 3000 });

// 面板展示的配置以模型目录为准：没有条目就按目录生成，有条目就补齐新增文件、剔除已删除的文件。
// 这样用户直接把模型丢进 2D/ 就能用，不再依赖手动运行 AI_set_live2d.py。
function syncedMotionConfig(character, kind) {
  const { config, changed } = mergeMotionConfig(kind, character, readMotionConfig(character, kind));
  if (changed) { writeMotionConfig(character, kind, config); notifyDesktopReload(); }
  return config;
}

function motionData(character) {
  const name = String(character || '');
  if (!name || name.startsWith('[VRM] ') || !isLive2DModelDir(name)) return { character: name, actions: {}, expressions: {} };
  return { character: name, actions: syncedMotionConfig(name, 'actions'), expressions: syncedMotionConfig(name, 'expressions') };
}

function environmentInfo() {
  const ttsHub = path.resolve(__dirname, '..', 'full-hub', 'tts-hub');
  let hasLocalTts = false;
  try { hasLocalTts = fs.statSync(ttsHub).isDirectory() && fs.readdirSync(ttsHub, { withFileTypes: true }).some(entry => entry.isDirectory()); } catch {}
  const currentConfig = readJson(configPath, {});
  return { edition: hasLocalTts ? 'local' : 'cloud', editionLabel: hasLocalTts ? '本地' : '云端', version: currentConfig.version || '' };
}

function listMcpTools() {
  const dir = path.join(__dirname, 'mcp', 'tools');
  const tools = [];
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (!/\.(js|txt)$/i.test(file) || file.toLowerCase() === 'index.js') continue;
      const fullPath = path.join(dir, file);
      if (!fs.statSync(fullPath).isFile()) continue;
      let description = '';
      try { description = fs.readFileSync(fullPath, 'utf8').slice(0, 500).match(/\/\*\*\s*\n?\s*\*?\s*([^\n*]+)/)?.[1]?.trim() || ''; } catch {}
      tools.push({ type: 'local', key: file, name: file.replace(/\.(js|txt)$/i, ''), enabled: file.endsWith('.js'), description });
    }
  }
  const mcpConfig = readJson(path.join(__dirname, 'mcp', 'mcp_config.json'), {});
  const localNames = new Set(tools.map(tool => tool.name));
  for (const [key, value] of Object.entries(mcpConfig)) {
    const name = key.endsWith('_disabled') ? key.slice(0, -9) : key;
    const isLocal = (value.args || []).some(arg => typeof arg === 'string' && arg.includes('./mcp/tools/'));
    if (!isLocal && !localNames.has(name)) tools.push({ type: 'external', key, name, enabled: !key.endsWith('_disabled'), description: `外部工具 · ${value.command || ''}` });
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

// ── 面板几何持久化（P1：面板可缩放可移动，但重启回默认 520×720 —— 现在记住）──
// 存 panel-bounds.json（与 config.json 同目录，仿 avatar-loading-position.json 的轻量状态文件），
// 不进 config.json：面板几何是窗口状态不是用户设置，走独立文件避免和整份写回互相踩。
// user_moved 只在用户真的拖过/缩放过才置 true；快照模式（PET_CONTROL_SNAPSHOT）永不存。
const PANEL_BOUNDS_FILE = path.join(__dirname, 'panel-bounds.json');
function loadPanelBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(PANEL_BOUNDS_FILE, 'utf8'));
    if (b && b.user_moved && [b.x, b.y, b.width, b.height].every(Number.isFinite)
        && b.width >= 420 && b.height >= 520) return b;
  } catch (e) { /* 无文件/损坏 → 无记忆 */ }
  return null;
}
function flushPanelBounds(win) {
  if (process.env.PET_CONTROL_SNAPSHOT) return;
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  try {
    const b = win.getBounds();
    fs.writeFileSync(PANEL_BOUNDS_FILE, JSON.stringify({
      x: b.x, y: b.y, width: b.width, height: b.height,
      user_moved: true, saved_at: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch (e) { console.error('[control] 保存面板位置失败:', e && e.message); }
}
let __panelBoundsTimer = null;
function schedulePanelBoundsSave(win) {
  // 移动/缩放高频触发，防抖 600ms 落盘；快照模式（QA 截图）绝不写
  if (process.env.PET_CONTROL_SNAPSHOT) return;
  clearTimeout(__panelBoundsTimer);
  __panelBoundsTimer = setTimeout(() => flushPanelBounds(win), 600);
}

// 8103 浏览器来源写令牌（2026-11-21 红队 P1）：
// 与 petbridge/vts-server.mjs 的 resolveControlToken 读同一个文件（data/.control-token）。
// 控制中心窗 contextIsolation=true，令牌经 additionalArguments 交给 preload，
// 再由 control-preload.js 用 contextBridge 暴露成 window.petControlToken。
function readOrCreatePetControlToken() {
  const file = path.join(path.dirname(configPath), '..', 'data', '.control-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch (e) { /* 首次启动：下面生成 */ }
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, token + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (e) { /* Windows 无 POSIX 权限语义 */ }
  } catch (e) {
    // 并发启动：另一个进程可能刚好写成功，优先用盘上那份，避免两边令牌不一致
    try {
      const raced = fs.readFileSync(file, 'utf8').trim();
      if (raced) return raced;
    } catch (e2) { /* 确实没有可读文件 */ }
    console.error('[control-auth] 写 .control-token 失败（面板内渲染层仍可用）:', e && e.message || e);
  }
  return token;
}

function createControlWindow() {
  // 从皮套窗口拉起时，主进程会把「皮套旁边的位置」通过环境变量传进来，
  // 布局算法在 Rust 内核（pet-core）里，和桌面宠物共用同一套。
  const px = Number(process.env.PET_PANEL_X);
  const py = Number(process.env.PET_PANEL_Y);
  const pw = Number(process.env.PET_PANEL_W) || 520;
  const ph = Number(process.env.PET_PANEL_H) || 720;
  const docked = Number.isFinite(px) && Number.isFinite(py);
  // 用户拖过面板 → 记住的位置优先（不限启动方式，clamp 回显示器并集防陈旧多屏坐标）；
  // 从没拖过 → 维持原行为（docked 用皮套旁位置，free 用大窗默认）
  const savedBounds = loadPanelBounds();
  let restored = null;
  if (savedBounds) {
    try {
      const displays = require('electron').screen.getAllDisplays();
      const minX = Math.min(...displays.map(d => d.bounds.x)) + 40;
      const minY = Math.min(...displays.map(d => d.bounds.y)) + 40;
      const maxX = Math.max(...displays.map(d => d.bounds.x + d.bounds.width)) - 80;
      const maxY = Math.max(...displays.map(d => d.bounds.y + d.bounds.height)) - 80;
      const minW = docked ? 420 : 860;
      const minH = docked ? 520 : 620;
      restored = {
        width: Math.round(Math.min(Math.max(savedBounds.width, minW), 2400)),
        height: Math.round(Math.min(Math.max(savedBounds.height, minH), 2000)),
        x: Math.round(Math.min(Math.max(savedBounds.x, minX), maxX)),
        y: Math.round(Math.min(Math.max(savedBounds.y, minY), maxY)),
      };
    } catch (e) { console.error('[control] 恢复面板位置失败:', e && e.message); restored = null; }
  }
  const win = controlWindow = new BrowserWindow({
    width: (restored && restored.width) || (docked ? pw : 1080),
    height: (restored && restored.height) || (docked ? ph : 760),
    ...(restored ? { x: restored.x, y: restored.y }
      : (docked ? { x: px, y: py } : {})),
    minWidth: docked ? 420 : 860,
    minHeight: docked ? 520 : 620,
    frame: false,
    show: false,
    opacity: 0,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'control-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 8103 写令牌：preload 从 process.argv 取，contextBridge 暴露给渲染层
      additionalArguments: ['--pet-control-token=' + readOrCreatePetControlToken()],
      // 全屏透明的桌宠窗口抢鼠标时，系统会误判面板被完全遮挡而停止绘制，日志收到了也不刷新
      backgroundThrottling: false
    }
  });
  // ── 自检通道（截图 / 量几何 / 注入 JS）──────────────────────────────
  // 面板是独立进程，主进程那边看不到它内部 DOM，UI 一旦"看着像好了其实坏了"就没法自证。
  // 这里挂一个只监听 127.0.0.1 的小服务，用来做 UI 回归。
  try {
    const http = require('http');
    const { execSync } = require('child_process');
    // 端口别用 8317 —— 那是 Docker 的（实测被 com.docker.backend 占用，绑不上）。
    const port = Number(process.env.PET_CONTROL_DEVTOOLS_PORT || 8771);
    if (!global.__controlProbe) {
      global.__controlProbe = http.createServer(async (req, res) => {
        const send = (code, obj) => { try { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(obj)); } catch (e) {} };
        const u = new URL(req.url, 'http://127.0.0.1');
        try {
          if (u.pathname === '/bounds') {
            return send(200, { bounds: win.getBounds(), visible: win.isVisible(), opacity: win.getOpacity() });
          }
          if (u.pathname === '/eval' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', async () => {
              try {
                const { js } = JSON.parse(body || '{}');
                const value = await win.webContents.executeJavaScript(String(js), true);
                send(200, { ok: true, value });
              } catch (e) { send(200, { ok: false, error: String(e && e.message || e) }); }
            });
            return;
          }
          if (u.pathname === '/shot') {
            const img = await win.webContents.capturePage();
            const buf = img.toPNG();
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
            return res.end(buf);
          }
          if (u.pathname === '/resize') {
            const w = Number(u.searchParams.get('w') || 0), hq = Number(u.searchParams.get('h') || 0);
            if (w > 0 && hq > 0) win.setSize(w, hq);
            return send(200, { bounds: win.getBounds() });
          }
          return send(404, { error: 'not found' });
        } catch (e) { send(500, { error: String(e && e.message || e) }); }
      });
      const tryListen = (p, attempt) => {
        global.__controlProbe.once('error', (e) => {
          if (attempt >= 5) { console.error('[control-probe] 全部端口被占用，放弃'); return; }
          const next = p + 1;
          if (!global.__controlProbe.listening) tryListen(next, attempt + 1);
        });
        global.__controlProbe.listen(p, '127.0.0.1', () => {
          console.log('[control-probe] 自检口 http://127.0.0.1:' + p);
        });
      };
      tryListen(port, 0);
    }
  } catch (e) { console.error('[control-probe] 挂载失败:', e && e.message); }

  const fadeWindow = (from, to, duration = 320) => new Promise(resolve => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (win.isDestroyed()) {
        clearInterval(timer);
        resolve();
        return;
      }
      const progress = Math.min(1, (Date.now() - startedAt) / duration);
      const eased = progress * progress * (3 - 2 * progress);
      win.setOpacity(from + (to - from) * eased);
      if (progress >= 1) {
        clearInterval(timer);
        resolve();
      }
    }, 16);
  });
  let closing = false;
  let configDirty = false;
  win.once('ready-to-show', () => {
    // 快照模式：窗口放到主屏左外侧 + showInactive（不抢焦点、用户不可见），
    // 合成器照常出帧——隐藏窗的 capturePage 会拿旧合成帧（DOM 已新、像素仍旧的假象）。
    if (process.env.PET_CONTROL_SNAPSHOT) {
      try { win.setPosition(-2600, 100); win.showInactive(); } catch (e) { win.show(); }
      return;
    }
    win.show();
    fadeWindow(0, 1);
  });
  win.on('close', event => {
    if (closing) return;
    event.preventDefault();
    if (configDirty) {
      win.webContents.send('control:close-requested');
      return;
    }
    closing = true;
    flushPanelBounds(win);   // 防抖未到就关窗：把最终位置补写进去
    const autoCloseServices = readJson(configPath, {}).auto_close_services?.enabled ?? true;
    Promise.all([fadeWindow(win.getOpacity(), 0, 260), stopLive2dProcess(),
      autoCloseServices ? stopConfiguredServices() : Promise.resolve()])
      .finally(() => { if (!win.isDestroyed()) win.destroy(); });
  });
  // 从皮套右键「换装」进来时，直接落到对应页面（大肥鱼页里有换装）
  const panelPage = process.env.PET_PANEL_PAGE || '';
  // 2026-11-10 用户拍板：v1 面板已删除，只保留 v2。
  //   原来这里还有 config.ui.control_v2 / --control-v1 两个回退分支 —— 双份维护的坑
  //   （改了 v1 以为生效、实际跑 v2）已经被踩过一次，不再留。
  const shellFile = 'control-v2.html';
  win.loadFile(path.join(__dirname, shellFile), {
    query: process.argv.includes('--voice-clone')
      ? { view: 'voice-clone' }
      : (process.env.PET_PANEL_PAGE ? { page: process.env.PET_PANEL_PAGE } : {})
  });
  // 用户拖动/缩放 → 防抖记录（几何持久化 P1）
  win.on('move', () => schedulePanelBoundsSave(win));
  win.on('resize', () => schedulePanelBoundsSave(win));

  // 自检钩子：PET_CONTROL_SNAPSHOT=<png路径> 时，加载后切到「大肥鱼」页并截图。
  // 用来验证新加的设置页真的渲染出来了（不用人肉开窗口）。
  if (process.env.PET_CONTROL_SNAPSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const page = process.env.PET_CONTROL_PAGE || 'petbody';
          await win.webContents.executeJavaScript(
            "(()=>{ const b=document.querySelector('[data-page=\"" + page + "\"]'); if(b) b.click(); return !!b; })()"
          );
          await new Promise((r) => setTimeout(r, 1200));
          // 顺手把「大肥鱼」页/「模型配置」页的字段实际值 dump 出来，方便排查绑定问题（密码字段打码）
          try {
            const dump = await win.webContents.executeJavaScript(
              "JSON.stringify(['petbody-width','petbody-height','petbody-click-through','petbody-framing-full','petbody-mouth-gain','petbody-emotion-gain','llm-provider-text','llm-url','llm-key','llm-model','vision-provider-text','vision-url','vision-key','vision-model'].map(id=>{const e=document.getElementById(id); if(!e) return [id,'MISSING']; if(e.type==='checkbox') return [id,e.checked]; if(e.type==='password') return [id,e.value?'***（已填）':'（空）']; return [id,(e.value!==undefined&&e.value!=='')?e.value:e.textContent];}))"
            );
            fs.writeFileSync(process.env.PET_CONTROL_SNAPSHOT + '.json', dump);
            console.log('[control-snapshot] fields', dump);
          } catch (e) { console.error('[control-snapshot] dump failed', e.message); }
          // 可选：截之前滚到某个元素（验证首屏以下的内容）
          if (process.env.PET_CONTROL_SCROLL) {
            try {
              await win.webContents.executeJavaScript(
                "(()=>{ const el=document.querySelector('" + process.env.PET_CONTROL_SCROLL + "'); if(el) el.scrollIntoView({block:'center'}); return !!el; })()"
              );
              await new Promise((r) => setTimeout(r, 700));
            } catch (e) { console.error('[control-snapshot] scroll failed', e.message); }
          }
          // 隐藏窗的 capturePage 会拿到旧合成帧（DOM 已新、像素仍旧的假象）：
          // stayHidden+stayAwake 强制对新状态出帧，先 invalidate 再截。
          win.webContents.invalidate();
          const image = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
          fs.writeFileSync(process.env.PET_CONTROL_SNAPSHOT, image.toPNG());
          // DOM 真值随拍随存：截图瞬间开关的 checked/文本，用来分辨「渲染竞态 vs 样式问题」
          try {
            const truth = await win.webContents.executeJavaScript(
              "JSON.stringify((() => { const inp = document.getElementById('quiet-switch'); const i = inp && inp.nextElementSibling; return { checked: !!inp?.checked, iTag: i && i.tagName, iBg: i ? getComputedStyle(i).backgroundColor : null, matches: i ? i.matches('.switch input:checked + i') : null, inpFont: inp ? getComputedStyle(inp).fontFamily.slice(0, 60) : null }; })())"
            );
            fs.writeFileSync(process.env.PET_CONTROL_SNAPSHOT + '.truth.json', String(truth), 'utf8');
          } catch (e) {}
          console.log('[control-snapshot] saved', process.env.PET_CONTROL_SNAPSHOT, image.getSize());
        } catch (error) {
          console.error('[control-snapshot] failed', error && error.message || error);
        }
      }, 2500);
    });
  }
  ipcMain.on('control:config-dirty', (event, dirty) => {
    if (event.sender === win.webContents) configDirty = Boolean(dirty);
  });
  let pluginWatcher = null;
  try {
    let refreshTimer = null;
    pluginWatcher = fs.watch(pluginsPath, { recursive: true }, () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.send('control:plugins-changed');
      }, 350);
    });
  } catch {}
  win.once('closed', () => pluginWatcher?.close());
}

async function stopLive2dProcess() {
  if (!live2dProcess || live2dProcess.exitCode !== null) {
    live2dProcess = null;
    return { ok: false, message: '桌宠未在运行' };
  }
  await postDesktop('/prepare-close', {}, 1800);
  const pid = live2dProcess.pid;
  return new Promise(resolve => {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
    killer.on('error', error => resolve({ ok: false, message: `关闭失败：${error.message}` }));
    killer.on('exit', code => {
      if (code === 0) {
        live2dProcess = null;
        resolve({ ok: true, message: '桌宠已关闭' });
      } else {
        resolve({ ok: false, message: `关闭失败（${code}）` });
      }
    });
  });
}

ipcMain.handle('control:window', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (action === 'minimize') win.minimize();
  if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  if (action === 'close') win.close();
});

ipcMain.handle('control:confirm-unsaved-config', async (event, title = '未保存配置') => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    title,
    message: '当前配置有未保存的修改，继续操作可能导致配置未生效。',
    detail: '是否保存当前配置？',
    buttons: ['保存', '放弃', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  });
  return ['save', 'discard', 'cancel'][result.response] || 'cancel';
});

ipcMain.handle('control:open-github', () => shell.openExternal('https://github.com/morettt/my-neuro'));
ipcMain.handle('control:reset-model-position', async () => {
  const current = readJson(configPath, {});
  current.ui ||= {};
  current.ui.model_position ||= {};
  Object.assign(current.ui.model_position, { x: 1.35, y: 0.8, remember_position: true });
  current.ui.model_scale = 0.65;
  // 2026-11-17 六十四轮：写盘结果必须看 —— 写失败还回「已保存」就是界面说成功、重启后回旧位置
  const wrote = writeJsonVerified(configPath, current);   // 原子写 + 回读校验
  const result = await postDesktop('/reset-model-position', {});
  if (!wrote.ok) {
    const error = '皮套位置保存失败（重启后会回到旧位置）：' + (wrote.error || '未知原因');
    console.error('[control] ' + error);
    return { ok: false, error, message: error, hotReloaded: Boolean(result.success) };
  }
  return result.success ? { ok: true, message: '皮套位置已立即复位' } : { ok: true, message: '皮套位置已保存，桌宠启动后生效' };
});
ipcMain.handle('control:adjust-subtitle-position', async () => {
  const result = await postDesktop('/adjust-subtitle-position', {});
  return result.success ? { ok: true, message: '已进入字幕调整模式' } : { ok: false, message: '请先启动桌宠再调整字幕位置' };
});
ipcMain.handle('control:select-voice-file', async (_event, kind) => {
  const isModel = kind === 'model';
  const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: isModel
    ? [{ name: 'PyTorch 模型', extensions: ['pth'] }]
    : [{ name: '音频文件', extensions: ['wav'] }] });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  const source = result.filePaths[0];
  const targetDir = path.join(__dirname, 'Voice_Model_Factory');
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, path.basename(source));
  fs.copyFileSync(source, target);
  if (isModel) selectedVoiceModelPath = target;
  else selectedVoiceAudioPath = target;
  return { ok: true, filename: path.basename(target) };
});
ipcMain.handle('control:select-aliyun-audio', async (_event, droppedPath) => {
  try {
    let source = typeof droppedPath === 'string' ? droppedPath : '';
    if (!source) {
      const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [
        { name: '参考音频', extensions: ['wav', 'mp3', 'm4a'] }
      ] });
      if (result.canceled || !result.filePaths[0]) return { canceled: true };
      source = result.filePaths[0];
    }
    const extension = path.extname(source).slice(1).toLowerCase();
    const mimes = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4' };
    if (!mimes[extension]) throw new Error('请选择 WAV、MP3 或 M4A 音频');
    const stat = await fs.promises.stat(source);
    if (!stat.isFile() || !stat.size || stat.size > 10 * 1024 * 1024) throw new Error('音频不能为空，且不能超过 10 MB');
    const bytes = await fs.promises.readFile(source);
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('音频不能为空，且不能超过 10 MB');
    selectedAliyunAudioPath = source;
    return { ok: true, filename: path.basename(source), size: bytes.length,
      preview: `data:${mimes[extension]};base64,${bytes.toString('base64')}` };
  } catch (error) { return { ok: false, message: error.message }; }
});
ipcMain.handle('control:upload-aliyun-audio', async () => {
  const defaults = readJson(path.join(__dirname, '.voice-upload-client.json'), {});
  try {
    if (!selectedAliyunAudioPath) throw new Error('请先选择参考音频');
    const uploaded = await aliyunVoiceClone.uploadAudio(selectedAliyunAudioPath, defaults, (...args) => net.fetch(...args));
    return { ok: true, ...uploaded };
  } catch (error) { return { ok: false, message: error.message }; }
});
ipcMain.handle('control:enroll-aliyun-voice', async (_event, options) => {
  try {
    return { ok: true, ...await aliyunVoiceClone.enrollVoice(options, (...args) => net.fetch(...args)) };
  } catch (error) { return { ok: false, message: error.message }; }
});
ipcMain.handle('control:query-aliyun-voice', async (_event, options) => {
  try {
    return { ok: true, ...await aliyunVoiceClone.queryVoice(options, (...args) => net.fetch(...args)) };
  } catch (error) { return { ok: false, message: error.message }; }
});
ipcMain.handle('control:generate-voice-bat', (_event, options) => {
  const character = String(options?.character || '').trim();
  const text = String(options?.text || '').trim();
  const language = ['zh', 'en', 'ja'].includes(options?.language) ? options.language : 'zh';
  if (!character || !text) return { ok: false, message: '请填写角色名称和参考文本' };
  if (!selectedVoiceModelPath || !fs.existsSync(selectedVoiceModelPath)) return { ok: false, message: '请先选择模型文件' };
  if (!selectedVoiceAudioPath || !fs.existsSync(selectedVoiceAudioPath)) return { ok: false, message: '请先选择参考音频' };
  const safeName = character.replace(/[<>:"/\\|?*]/g, '_');
  const escapedText = text.replace(/"/g, '""');
  const batPath = path.join(__dirname, 'Voice_Model_Factory', `${safeName}_TTS.bat`);
  const content = ['@echo off', 'set "PATH=%~dp0..\\..\\full-hub\\tts-hub\\GPT-SoVITS-Bundle\\runtime;%PATH%"',
    'cd /d "%~dp0..\\..\\full-hub\\tts-hub\\GPT-SoVITS-Bundle"',
    `python api.py -p 5000 -d cuda -s "${selectedVoiceModelPath}" -dr "${selectedVoiceAudioPath}" -dt "${escapedText}" -dl ${language}`, 'pause', ''].join('\r\n');
  fs.writeFileSync(batPath, content, 'utf8');
  return { ok: true, message: `已生成：${path.basename(batPath)}` };
});
ipcMain.handle('control:service-status', () => serviceStatus());

// ── 她的状态（2026-11-10 三十九轮）：用户问「怎么喂」，发现 UI 里根本没有入口 ──
//   「投喂」原来只有两个隐性入口：对她说话（LLM 调 pet_care feed）、皮套长按摸头。
//   这里把状态读出来 + 给一个投喂按钮，走的是她自己的自检通道（8004 /eval → alive-state.doFeed）。
const _petRecDir = () => path.join(projectRoot, 'data');
const _readJsonQuiet = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
ipcMain.handle('control:pet-state', () => {
  const out = { alive: null, mood: null, skills: null, history: null, memos: null };
  const a = _readJsonQuiet(path.join(_petRecDir(), '活着感.json'));
  if (a) {
    const age = a.updatedAt ? Math.round((Date.now() - new Date(a.updatedAt).getTime()) / 1000) : null;
    out.alive = { satiety: a.satiety, energy: a.energy, intimacy: a.intimacy, ageSeconds: age };
  }
  const m = _readJsonQuiet(path.join(_petRecDir(), '心情.json'));
  if (m) {
    out.mood = {
      score: m.score,
      wounds: Array.isArray(m.wounds) ? m.wounds.length : 0,
      lastWound: Array.isArray(m.wounds) && m.wounds.length ? String((m.wounds[m.wounds.length - 1] || {}).note || '').slice(0, 60) : '',
    };
  }
  // 技能库 / 执行历史在项目根（my-neuro 的上一级两级）
  const root = path.resolve(projectRoot, '..', '..');
  const sk = _readJsonQuiet(path.join(root, 'pet-runtime', 'knowledge', 'skills', 'skills.json'));
  if (sk && Array.isArray(sk.skills)) {
    const active = sk.skills.filter((s) => !s.deleted);
    out.skills = {
      total: sk.skills.length, active: active.length,
      names: active.slice(0, 8).map((s) => s.name),
    };
  }
  const histPath = path.join(root, 'pet-runtime', 'data', 'dispatch-history.jsonl');
  try {
    if (fs.existsSync(histPath)) {
      const lines = fs.readFileSync(histPath, 'utf8').split('\n').filter(Boolean);
      out.history = { total: lines.length };
    }
  } catch (e) { /* ignore */ }
  // 人设漂移（2026-11-10：用户要求「状态统一、覆盖到位」）
  const drift = _readJsonQuiet(path.join(_petRecDir(), '人设漂移.json'));
  if (drift && Array.isArray(drift.events)) {
    const since24 = Date.now() - 24 * 3600 * 1000;
    const recent = drift.events.filter((e) => Number(e.at) >= since24);
    const serious = recent.filter((e) => ['critical', 'parasocial', 'high', 'mid'].includes(String(e.severity)));
    out.drift = { total24h: recent.length, serious24h: serious.length, lastRule: recent.length ? String(recent[recent.length - 1].id || '') : '' };
  }
  // 知识库（rules 目录：文件数 + 条目数）
  try {
    const rulesDir = path.join(root, 'pet-runtime', 'knowledge', 'rules');
    if (fs.existsSync(rulesDir)) {
      let files = 0; let entries = 0;
      for (const f of fs.readdirSync(rulesDir)) {
        if (!f.endsWith('.json')) continue;
        files += 1;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(rulesDir, f), 'utf8'));
          const arr = Array.isArray(j) ? j : (j.entries || j.rules || []);
          entries += Array.isArray(arr) ? arr.length : 1;
        } catch (e) { /* ignore */ }
      }
      out.knowledge = { files, entries };
    }
  } catch (e) { /* ignore */ }
  return out;
});

ipcMain.handle('control:pet-feed', () => new Promise((resolve) => {  // 走 8004 自检通道调活着的 feed（不重复实现业务逻辑，复用同一份状态机）
  const js = 'String((()=>{ const e=window.pluginManager&&window.pluginManager._plugins.get("community/alive-state"); if(!e||!e.plugin) return JSON.stringify({ok:false,error:"活着感插件未加载"}); try { return e.plugin.doFeed(); } catch (err) { return JSON.stringify({ok:false,error:String(err&&err.message||err)}); } })())';
  const body = JSON.stringify({ js });
  try {
    const req = require('http').request({
      host: '127.0.0.1', port: 8004, path: '/eval', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 8000,
    }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        try {
          const r = JSON.parse(s);
          let parsed = null;
          try { parsed = JSON.parse(r.value); } catch (e) { parsed = null; }
          resolve(parsed || { ok: false, error: '返回不可解析：' + String(r.value).slice(0, 80) });
        } catch (e) { resolve({ ok: false, error: '自检通道返回异常' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: '自检通道连不上（8004）：' + e.message }));
    req.write(body); req.end();
  } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
}));

// ── 知识库检索 / 技能库管理 / 看屏时间线（2026-11-10 三十九轮：把「后端有、UI 没有」补齐）──
//   知识库：直接读 rules/*.json 做关键字匹配（测试用途，够轻；不调她那套 rateGate 的 LLM 工具）
ipcMain.handle('control:kb-search', (event, query) => {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: '输入要搜的词' };
  const root = path.resolve(projectRoot, '..', '..');
  const rulesDir = path.join(root, 'pet-runtime', 'knowledge', 'rules');
  const hits = [];
  try {
    for (const f of fs.readdirSync(rulesDir)) {
      if (!f.endsWith('.json')) continue;
      const gameName = f.replace(/\.json$/, '');
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(rulesDir, f), 'utf8')); } catch (e) { continue; }
      const arr = Array.isArray(j) ? j : (j.entries || j.rules || []);
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        const text = typeof item === 'string' ? item : JSON.stringify(item);
        if (text.toLowerCase().includes(q.toLowerCase())) {
          hits.push({ game: gameName, text: text.slice(0, 120) });
          if (hits.length >= 20) break;
        }
      }
      if (hits.length >= 20) break;
    }
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  return { ok: true, query: q, count: hits.length, hits };
});

//   技能库：**不重复注册** —— 文件后面（1965 起的 registry 区）已有完整的一套：
//   control:skills-list（带 reliability）、control:skills-run、control:skills-delete。
//   2026-11-10 踩坑记录：我先在这里加了一份简化版 skills-list，Electron 主进程启动时
//   直接抛「Attempted to register a second handler for 'control:skills-list'」崩掉。
//   教训：**加 IPC 前先 grep 整个 control-main.js**。

//   看屏时间线：走 8004 拿 organ 的最近摘要（内存里，只读）
ipcMain.handle('control:organ-timeline', () => new Promise((resolve) => {
  const js = 'String((()=>{ const e=window.pluginManager&&window.pluginManager._plugins.get("community/watch-screen"); if(!e||!e.plugin||!e.plugin._organ) return JSON.stringify({ok:false,error:"看屏器官未启动"}); try { const r=e.plugin._organ.recallLast(300); return JSON.stringify({ok:true,count:r.count,text:r.text}); } catch(err){ return JSON.stringify({ok:false,error:String(err&&err.message||err)}); } })())';
  const body = JSON.stringify({ js });
  try {
    const req = require('http').request({
      host: '127.0.0.1', port: 8004, path: '/eval', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 8000,
    }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; });
      res.on('end', () => { try { const r = JSON.parse(s); try { resolve(JSON.parse(r.value)); } catch (e) { resolve({ ok: false, error: '不可解析' }); } } catch (e) { resolve({ ok: false, error: '自检返回异常' }); } });
    });
    req.on('error', (e) => resolve({ ok: false, error: '8004 连不上：' + e.message }));
    req.write(body); req.end();
  } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
}));

ipcMain.handle('control:start-service', async (event, id) => {
  const definition = serviceLaunchDefinition(id);
  if (!definition) return { ok: false, message: '未知服务' };
  if (!serviceInstalled(definition)) return { ok: false, message: `${definition.name} 模块尚未安装` };
  if (await portListening(definition.port)) return { ok: false, message: `${definition.name} 已在运行` };
  const batPath = path.join(projectRoot, definition.bat);
  if (!fs.existsSync(batPath)) return { ok: false, message: `找不到 ${definition.bat}` };
  sendServiceLog(event.sender, id, `正在启动 ${definition.name}...\n`);
  const child = spawn('cmd.exe', ['/d', '/c', batPath], { cwd: projectRoot, windowsHide: true });
  serviceProcesses[id] = child;
  child.stdout.on('data', chunk => sendServiceLog(event.sender, id, chunk));
  child.stderr.on('data', chunk => sendServiceLog(event.sender, id, chunk));
  child.on('error', error => sendServiceLog(event.sender, id, `启动失败：${error.message}\n`));
  child.on('exit', code => {
    if (serviceProcesses[id] === child) serviceProcesses[id] = null;
    sendServiceLog(event.sender, id, `\n${definition.name} 进程已退出（${code ?? '未知'}）\n`);
    if (!event.sender.isDestroyed()) event.sender.send('control:service-state');
  });
  return { ok: true, message: `${definition.name} 正在启动` };
});
ipcMain.handle('control:stop-service', async (event, id) => {
  const definition = serviceDefinitions[id];
  if (!definition) return { ok: false, message: '未知服务' };
  const pids = await listeningPids(definition.port);
  const tracked = serviceProcesses[id];
  if (tracked?.pid) pids.push(String(tracked.pid));
  const uniquePids = [...new Set(pids)];
  if (!uniquePids.length) return { ok: false, message: `${definition.name} 未在运行` };
  sendServiceLog(event.sender, id, `正在停止 ${definition.name}...\n`);
  if (id === 'bert') {
    try {
      await net.fetch('http://127.0.0.1:6007/shutdown', {
        method: 'POST',
        signal: AbortSignal.timeout(1500)
      });
      await new Promise(resolve => setTimeout(resolve, 500));
      if (!(await portListening(definition.port))) {
        serviceProcesses[id] = null;
        sendServiceLog(event.sender, id, `${definition.name} 已停止\n`);
        return { ok: true, message: `${definition.name} 已停止` };
      }
    } catch (_) {
      // 旧版 BERT 服务没有退出接口时，继续使用进程结束兜底。
    }
  }
  const stopResults = await Promise.allSettled(uniquePids.map(pid =>
    runProcess('taskkill.exe', ['/pid', pid, '/t', '/f'])
  ));
  await new Promise(resolve => setTimeout(resolve, 300));
  let remainingPids = await listeningPids(definition.port);
  if (remainingPids.length) {
    await Promise.allSettled(remainingPids.map(pid =>
      runProcess('taskkill.exe', ['/pid', pid, '/f'])
    ));
    await new Promise(resolve => setTimeout(resolve, 500));
    remainingPids = await listeningPids(definition.port);
  }
  if (remainingPids.length) {
    const errors = stopResults
      .filter(result => result.status === 'rejected')
      .map(result => result.reason?.message)
      .filter(Boolean)
      .join('；');
    const message = `${definition.name} 停止失败，端口 ${definition.port} 仍被 PID ${remainingPids.join(', ')} 占用${errors ? `：${errors}` : ''}`;
    sendServiceLog(event.sender, id, `${message}\n`);
    return { ok: false, message };
  }
  serviceProcesses[id] = null;
  sendServiceLog(event.sender, id, `${definition.name} 已停止\n`);
  return { ok: true, message: `${definition.name} 已停止` };
});
ipcMain.handle('control:download-service', async (event, id) => {
  const definition = serviceDefinitions[id];
  if (!definition) return { ok: false, message: '未知服务' };
  if (serviceInstalled(definition)) return { ok: false, message: `${definition.name} 已安装` };
  if (serviceDownloads[id]) return { ok: false, message: `${definition.name} 正在下载` };
  const script = path.join(hubRoot, 'Batch_Download.py');
  if (!fs.existsSync(script)) return { ok: false, message: '找不到 Batch_Download.py' };
  sendServiceLog(event.sender, id, `开始下载 ${definition.name} 模块...\n`);
  serviceDownloads[id] = { exitCode: null };
  if (!event.sender.isDestroyed()) event.sender.send('control:service-state');
  let pythonExecutable;
  try {
    pythonExecutable = await ensureProjectPython(event.sender, id);
  } catch (error) {
    serviceDownloads[id] = null;
    sendServiceLog(event.sender, id, `\u9879\u76ee Python \u73af\u5883\u5b89\u88c5\u5931\u8d25\uff1a${error.message}\n`);
    if (!event.sender.isDestroyed()) event.sender.send('control:service-state');
    return { ok: false, message: `\u9879\u76ee Python \u73af\u5883\u5b89\u88c5\u5931\u8d25\uff1a${error.message}` };
  }
  const child = spawn(pythonExecutable, ['-u', script, definition.flag], {
    cwd: hubRoot,
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', MY_NEURO_FULL_HUB_DIR: hubRoot }
  });
  serviceDownloads[id] = child;
  child.stdout.on('data', chunk => sendServiceLog(event.sender, id, chunk));
  child.stderr.on('data', chunk => sendServiceLog(event.sender, id, chunk));
  child.on('error', error => sendServiceLog(event.sender, id, `下载启动失败：${error.message}\n`));
  child.on('exit', code => {
    serviceDownloads[id] = null;
    sendServiceLog(event.sender, id, `\n下载进程已结束（${code ?? '未知'}）\n`);
    if (!event.sender.isDestroyed()) event.sender.send('control:service-state');
  });
  return { ok: true, message: `开始下载 ${definition.name}` };
});
ipcMain.handle('control:open-external', (_event, url) => {
  if (!/^https?:\/\//i.test(url)) throw new Error('不支持的链接');
  return shell.openExternal(url);
});
ipcMain.handle('control:list-plugins', () => listPlugins());
ipcMain.handle('control:refresh-plugin-market', () => refreshPluginMarket());
ipcMain.handle('control:set-plugin-enabled', (_event, relPath, enabled) => {
  if (!/^(built-in|community)\/[\w.-]+$/.test(relPath)) throw new Error('插件路径无效');
  const file = path.join(pluginsPath, 'enabled_plugins.json');
  const current = new Set(readJson(file, { plugins: [] }).plugins || []);
  enabled ? current.add(relPath) : current.delete(relPath);
  fs.writeFileSync(file, `${JSON.stringify({ plugins: [...current] }, null, 2)}\n`, 'utf8');
  return { ok: true };
});
ipcMain.handle('control:save-plugin-config', (_event, type, name, pluginConfig) => {
  if (!/^(built-in|community)$/.test(type) || !/^[\w.-]+$/.test(name)) throw new Error('插件名称无效');
  if (!pluginConfig || typeof pluginConfig !== 'object' || Array.isArray(pluginConfig)) throw new Error('插件配置格式无效');
  const file = path.join(pluginsPath, type, name, 'plugin_config.json');
  if (!fs.existsSync(path.dirname(file))) throw new Error('插件不存在');
  // 渲染层拿到的是掩码配置：整份覆盖写会把 ***xxxx 写盘、把真实 key 冲掉。
  // 先读磁盘原值，再把「掩码/空串」回填成原值（规则见 js/core/secret-mask.js）。
  let existing = {};
  if (fs.existsSync(file)) {
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error('现有插件配置无法解析，已中止写入以免覆盖'); }
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('现有插件配置格式无效，已中止写入');
  }
  const merged = restoreSecrets(pluginConfig, existing);
  const wrote = writeJsonVerified(file, merged);   // 原子写（.bak → .tmp → rename）+ 回读校验
  if (!wrote.ok) throw new Error(`插件配置写入失败：${wrote.error}`);
  return { ok: true };
});
ipcMain.handle('control:read-plugin-readme', (_event, type, name) => {
  if (!/^(built-in|community)$/.test(type) || !/^[\w.-]+$/.test(name)) throw new Error('插件名称无效');
  const file = path.join(pluginsPath, type, name, 'README.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
});
ipcMain.handle('control:install-plugin', async (_event, id, repo) => {
  try { return await installPluginArchive(id, repo); }
  catch (error) { return { ok: false, message: `安装失败：${error.message}` }; }
});
ipcMain.handle('control:install-plugin-dlc', async (event, name, url) => {
  // 名字直接参与目录拼接：拒绝 . / .. 以及任何含 .. 的名字，并做 realpath 前缀校验
  if (typeof name !== 'string' || !/^[\w.-]+$/.test(name) || name === '.' || name === '..' || name.includes('..')) {
    return { ok: false, message: 'DLC 名称无效' };
  }
  const safeUrl = validateDlcUrl(url);
  if (!safeUrl) {
    return { ok: false, message: 'DLC 下载地址不在允许的白名单内（仅支持 GitHub https 地址）' };
  }
  const dlcRoot = path.join(__dirname, 'plugins-dlc');
  const target = path.resolve(dlcRoot, name);
  if (target === dlcRoot || !target.startsWith(`${dlcRoot}${path.sep}`)) {
    return { ok: false, message: 'DLC 目标目录越界' };
  }
  const temp = fs.mkdtempSync(path.join(app.getPath('temp'), 'my-neuro-dlc-'));
  const zipFile = path.join(temp, 'dlc.zip');
  try {
    await downloadFile(safeUrl, zipFile, (received, total) => {
      event.sender.send('control:dlc-progress', total ? `${Math.floor(received * 100 / total)}%` : '下载中');
    }, { allowedFinalHosts: DLC_REDIRECT_ALLOWED_HOSTS });

    // 记录下载包哈希：同一 DLC 的内容变化时给出告警而不是静默覆盖
    const digest = crypto.createHash('sha256').update(fs.readFileSync(zipFile)).digest('hex');
    const hashes = readDlcHashes();
    const previous = hashes[name];
    if (previous && previous !== digest) {
      console.warn(`[DLC] ${name} 安装包内容已变化：${previous} -> ${digest}`);
    }

    event.sender.send('control:dlc-progress', 'extracting');
    await expandZip(zipFile, target, percent => event.sender.send('control:dlc-progress', `${percent}%`));
    flattenSingleDirectory(target);
    if (!fs.existsSync(path.join(target, '启动动作服务.bat'))) throw new Error('DLC 文件结构无效：找不到启动动作服务.bat');
    hashes[name] = digest;
    writeDlcHashes(hashes);
    return { ok: true, message: 'DLC 安装完成' };
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: false, message: `DLC 安装失败：${error.message}` };
  }
  finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
ipcMain.handle('control:launch-plugin-bat', (_event, name, bat) => {
  if (typeof name !== 'string' || !/^[\w.-]+$/.test(name) || name === '.' || name === '..' || name.includes('..') || typeof bat !== 'string' || !bat) return { ok: false, message: '启动信息无效' };
  // 只允许批处理脚本：插件启动文件必须是 .bat / .cmd（大小写不敏感），其它类型一律拒绝
  const allowedBatExts = new Set(['.bat', '.cmd']);
  const batExt = path.extname(bat).toLowerCase();
  if (!allowedBatExts.has(batExt)) {
    return { ok: false, message: `只允许启动 .bat / .cmd 插件脚本，已拒绝该文件类型：${batExt || '无扩展名'}` };
  }
  // name 参与目录拼接：root 必须落在 plugins-dlc/ 内（防 name='..' 逃出后自证清白）
  const dlcRoot = path.resolve(__dirname, 'plugins-dlc');
  const root = path.resolve(dlcRoot, name);
  if (root === dlcRoot || !root.startsWith(`${dlcRoot}${path.sep}`)) {
    return { ok: false, message: '插件目录越界' };
  }
  const direct = path.resolve(root, bat);
  let file = direct;
  if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file)) {
    file = null;
    if (fs.existsSync(root)) {
      const pending = [root];
      while (pending.length && !file) {
        const current = pending.shift();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const candidate = path.join(current, entry.name);
          if (entry.isDirectory()) pending.push(candidate);
          else if (entry.name === bat) { file = candidate; break; }
        }
      }
    }
  }
  if (!file || !fs.existsSync(file)) return { ok: false, message: '找不到插件启动文件' };
  // 落地文件再校验一次扩展名（防 a/b.txt 这类路径里最后一段与输入扩展名不一致）
  if (!allowedBatExts.has(path.extname(file).toLowerCase())) {
    return { ok: false, message: '只允许启动 .bat / .cmd 插件脚本' };
  }
  spawn('cmd.exe', ['/d', '/c', 'start', '', file], { cwd: path.dirname(file), windowsHide: true, detached: true }).unref();
  return { ok: true, message: '插件已启动' };
});

ipcMain.handle('control:load-config', () => loadControlConfig());
ipcMain.handle('control:get-chat-history', () => {
  const file = path.join(projectRoot, 'data', '对话历史.jsonl');
  if (!fs.existsSync(file)) return { exists: false, file, messages: [], invalidLines: 0 };
  const messages = [];
  let invalidLines = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      message.history_images = (Array.isArray(message.attachments) ? message.attachments : [])
        .filter(item => item?.type === 'image' && typeof item.path === 'string')
        .map(item => {
          const imageRoot = path.join(projectRoot, 'data', '对话截图');
          const imagePath = path.resolve(path.join(projectRoot, 'data'), item.path);
          if (!imagePath.startsWith(`${imageRoot}${path.sep}`) || !fs.existsSync(imagePath)) return null;
          const mime = path.extname(imagePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
          return `data:${mime};base64,${fs.readFileSync(imagePath).toString('base64')}`;
        })
        .filter(Boolean);
      messages.push(message);
    } catch { invalidLines += 1; }
  }
  return { exists: true, file, messages, invalidLines };
});
ipcMain.handle('control:environment-info', () => environmentInfo());
ipcMain.handle('control:get-prompts', async () => {
  const response = await net.fetch('https://mynewbot.com/api/get-prompts');
  if (!response.ok) throw new Error(`提示词接口请求失败（${response.status}）`);
  const data = await response.json();
  if (!data.success) throw new Error(data.message || '获取提示词列表失败');
  return Array.isArray(data.prompts) ? data.prompts : [];
});
ipcMain.handle('control:fetch-llm-models', async (_event, apiUrl, apiKey) => {
  let endpoint = String(apiUrl || '').trim().replace(/\/+$/, '');
  if (!endpoint) throw new Error('请先填写 API 地址');
  for (const suffix of ['/chat/completions', '/completions', '/responses', '/models']) {
    if (endpoint.toLowerCase().endsWith(suffix)) { endpoint = endpoint.slice(0, -suffix.length).replace(/\/+$/, ''); break; }
  }
  endpoint += '/models';
  const headers = { Accept: 'application/json' };
  if (String(apiKey || '').trim()) headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  let response;
  try { response = await net.fetch(endpoint, { headers, signal: AbortSignal.timeout(28000) }); }
  catch (error) { throw new Error(`连接模型接口失败：${error.message}`); }
  let payload = {};
  try { payload = await response.json(); } catch { throw new Error(`模型接口返回的不是 JSON（HTTP ${response.status}）`); }
  if (!response.ok) throw new Error(payload?.error?.message ? `HTTP ${response.status}：${payload.error.message}` : `获取失败（HTTP ${response.status}）`);
  const items = Array.isArray(payload) ? payload : payload.data;
  if (!Array.isArray(items)) throw new Error('接口返回格式不受支持：未找到模型列表');
  const models = [...new Set(items.map(item => typeof item === 'object' ? (item.id || item.name) : item).filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  if (!models.length) throw new Error('接口返回成功，但模型列表为空');
  return models;
});
ipcMain.handle('control:test-llm-model', async (_event, apiUrl, apiKey, model) => {
  let endpoint = String(apiUrl || '').trim().replace(/\/+$/, '');
  if (!endpoint || !String(model || '').trim()) return { ok: false, message: '请先填写接口地址并选择模型' };
  for (const suffix of ['/chat/completions', '/completions', '/responses', '/models']) {
    if (endpoint.toLowerCase().endsWith(suffix)) { endpoint = endpoint.slice(0, -suffix.length).replace(/\/+$/, ''); break; }
  }
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (String(apiKey || '').trim()) headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  const started = performance.now();
  const signal = AbortSignal.timeout(30000);
  try {
    // 🔥 默认关闭思考模式，避免测出来的延迟被思考过程拉高
    const requestBody = {
      model: String(model).trim(),
      messages: [{ role: 'user', content: '请只回复 OK' }],
      stream: true,
      thinking: { type: 'disabled' }
    };
    const response = await net.fetch(`${endpoint}/chat/completions`, {
      method: 'POST', headers, signal,
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      let detail;
      try { detail = (await response.json())?.error?.message; } catch { /* 忽略非 JSON 错误体 */ }
      const message = String(detail || '模型请求失败').slice(0, 240);
      const key = String(apiKey || '').trim();
      return { ok: false, message: `HTTP ${response.status}：${key ? message.split(key).join('***') : message}` };
    }

    // 🔥 实际对话走的是流式响应，这里测的也应是首个正文 token 的到达时间（TTFT），
    // 而不是等完整回复——开了思考模式的模型完整回复耗时会被思考过程严重拉高，
    // 跟用户真实感知到的延迟对不上。
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let firstTokenMs = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]' || !trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5);
        let chunk;
        try { chunk = JSON.parse(jsonStr); } catch { continue; }
        if (chunk?.choices?.[0]?.delta?.content) {
          firstTokenMs = Math.round(performance.now() - started);
          break;
        }
      }
      if (firstTokenMs !== null) { try { await reader.cancel(); } catch { /* 已拿到结果，忽略取消失败 */ } break; }
    }

    if (firstTokenMs === null) return { ok: false, message: '接口未返回有效的文本回复' };
    return { ok: true, elapsedMs: firstTokenMs };
  } catch {
    return { ok: false, message: signal.aborted ? '测试超时（30秒），暂未确认可用' : '连接失败，请检查接口地址和网络' };
  }
});
ipcMain.handle('control:list-mcp-tools', () => listMcpTools());
ipcMain.handle('control:toggle-mcp-tool', (_event, type, key) => {
  if (type === 'local') {
    if (!/^[\w.-]+\.(js|txt)$/.test(key) || key.toLowerCase() === 'index.js') throw new Error('工具文件无效');
    const oldPath = path.join(__dirname, 'mcp', 'tools', key);
    if (!fs.existsSync(oldPath)) throw new Error('工具文件不存在');
    const newKey = key.endsWith('.js') ? `${key.slice(0, -3)}.txt` : `${key.slice(0, -4)}.js`;
    fs.renameSync(oldPath, path.join(__dirname, 'mcp', 'tools', newKey));
  } else if (type === 'external') {
    const file = path.join(__dirname, 'mcp', 'mcp_config.json');
    const data = readJson(file, {});
    if (!(key in data)) throw new Error('外部工具不存在');
    const newKey = key.endsWith('_disabled') ? key.slice(0, -9) : `${key}_disabled`;
    data[newKey] = data[key]; delete data[key];
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } else throw new Error('工具类型无效');
  return { ok: true };
});
// ── 工具市场（2026-11-21 红队 P1 #10）──────────────────────────────────────
// 原实现走明文 http://mynewbot.com，且下载的 .js 会被 mcp-manager 自动注册执行：
// 同一网络里的 MITM 返回恶意工具 = 远程执行。现在的口径：
//   · 默认只走 HTTPS；
//   · 只有 config.json 显式写 mcp.market_allow_http=true 才允许 HTTPS 连接失败时回落明文
//     （回落有醒目日志，返回值带 insecure:true 供界面提示）；
//   · 每次下载记录 sha256 到 mcp/tool-hashes.json，与上次不同就告警（可审计、可对账）。
const MARKET_HOST = 'mynewbot.com';
const TOOL_HASH_FILE = path.join(__dirname, 'mcp', 'tool-hashes.json');

function marketAllowHttp() {
  try {
    const c = readJson(configPath, {});
    return !!(c && c.mcp && c.mcp.market_allow_http === true);
  } catch (e) { return false; }
}

async function marketFetch(pathname) {
  const httpsUrl = 'https://' + MARKET_HOST + pathname;
  try {
    return { res: await net.fetch(httpsUrl), url: httpsUrl, insecure: false };
  } catch (e) {
    if (!marketAllowHttp()) {
      const err = new Error('工具市场 HTTPS 连接失败：' + (e && e.message ? e.message : String(e))
        + '。默认不允许回落到明文 HTTP（可能被中间人替换成任意 JS）。确需回落：在 config.json 设 mcp.market_allow_http=true');
      err.cause = e;
      throw err;
    }
    const httpUrl = 'http://' + MARKET_HOST + pathname;
    console.warn('[tool-market] HTTPS 失败，按配置回落明文 HTTP：' + httpUrl);
    return { res: await net.fetch(httpUrl), url: httpUrl, insecure: true };
  }
}

ipcMain.handle('control:get-tool-market', async () => {
  const { res, url, insecure } = await marketFetch('/api/get-tools');
  if (!res.ok) throw new Error(`工具接口请求失败（${res.status}）`);
  const data = await res.json();
  if (!data.success) throw new Error(data.message || '获取工具列表失败');
  const tools = Array.isArray(data.tools) ? data.tools : [];
  return { tools, insecure: !!insecure, source: url };
});
ipcMain.handle('control:download-tool', async (_event, tool) => {
  const id = String(tool?.id || '');
  const filename = path.basename(String(tool?.file_name || ''));
  if (!id || !filename || !/\.(js|txt)$/i.test(filename)) throw new Error('工具信息无效');
  const { res, url, insecure } = await marketFetch('/api/download-tool/' + encodeURIComponent(id));
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const dir = path.join(__dirname, 'mcp', 'tools');
  fs.mkdirSync(dir, { recursive: true });
  // 哈希对账：同一个工具 id 的内容变了要留痕（正常更新也记，异常替换同样记）
  let changed = false;
  let prev = null;
  try {
    const known = readJson(TOOL_HASH_FILE, {});
    prev = known && known[id] ? known[id] : null;
    if (prev && prev.sha256 && prev.sha256 !== sha256) {
      changed = true;
      console.warn('[tool-market] 工具内容变化 id=' + id + ' ' + String(prev.sha256).slice(0, 12) + ' → ' + sha256.slice(0, 12));
    }
    known[id] = { file: filename, sha256, bytes: buf.length, at: new Date().toISOString(), url, insecure: !!insecure };
    fs.writeFileSync(TOOL_HASH_FILE, JSON.stringify(known, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.warn('[tool-market] 哈希记录写失败（不影响本次下载）：' + (e && e.message));
  }
  fs.writeFileSync(path.join(dir, filename), buf);
  return { ok: true, filename, sha256, bytes: buf.length, changed, insecure: !!insecure };
});

ipcMain.handle('control:save-config', async (_event, config) => {
  // 静默兜底（2026-11-16）：面板打开期间真正的静默状态由 8103 /quiet 维护（手机遥控、
  // 直播台、外观页都可能改过），渲染层内存里的 config.cost.quiet 可能是打开面板时的旧值。
  // 整份 config 是原子写盘的，不兜这一下就会「保存别的设置把静默悄悄改回去」。
  try {
    config = config || {};
    config.cost = config.cost || {};
    const live = await __localJson(8103, '/state');
    if (live && typeof live.quiet === 'boolean') config.cost.quiet = live.quiet;
  } catch (e) { /* 8103 掉线：保持配置里的值，不阻断保存 */ }
  const normalized = saveControlConfig(config);
  // 2026-11-09：配置保存后统一通知宿主重读，而不是只在云 TTS 时通知。
  // 原先只有 aliyun/volcengine 分支 reload → 用户改「意图路由/垫场/静默」等开关
  // 得重启才生效（UI 已提示已保存 = 假承诺）。/reload-config 是既有热重载端点，代价很小。
  // 2026-11-17 六十二轮：把重载结果一起回给渲染层 —— 重载失败时 UI 必须说出来，
  // 不能「写盘成功 = 已保存」而宿主还跑着旧 provider key（用户报「换 key 没用」就是这条）。
  // 2026-11-17 六十三轮：写盘/重载/读回收进 saveAndApply，三步全过才 ok:true；
  // 宿主没重载时这里返回 ok:false + reload.success:false，渲染层据此提示重启。
  // 2026-11-17 加固：provider 凭据（llm_providers.json）写失败时必须中止本次保存 ——
  // 不写 config.json（避免半套状态），返回 ok:false + 原因；这是「凭据被清空」的同族风险。
  if (!normalized.providersWrite || normalized.providersWrite.ok !== true) {
    const providerError = (normalized.providersWrite && normalized.providersWrite.error) || '未知原因';
    const message = 'provider 凭据写盘失败，已中止保存（config.json 未改动）：' + providerError;
    console.error(message);
    return {
      ok: false,
      wrote: false,
      stage: 'providers',
      file: normalized.providersWrite && normalized.providersWrite.file,
      error: message,
      reload: { success: false, message },
      readback: { ok: false, mismatches: [], skipped: true, error: message },
    };
  }
  return saveAndApply(configPath, normalized.config, { mode: 'full' });
});

ipcMain.handle('control:list-live2d-models', () => [
  ...scanLive2DModels().map(model => model.name),
  ...scanVRMModels().map(model => `[VRM] ${model.name}`),
  ...scanMMDModels().map(model => `[PMX] ${model.name}`)
]);
ipcMain.handle('control:current-live2d-model', () => {
  const currentConfig = readJson(configPath, {});
  const type = currentConfig.ui?.model_type;
  if (type === 'vrm' || type === 'mmd') {
    const models = type === 'mmd' ? scanMMDModels() : scanVRMModels();
    const model = models.find(item => item.modelPath === currentConfig.ui?.[`${type}_model_path`])
      || models.find(item => item.name === currentConfig.ui?.[`${type}_model`]) || models[0];
    return model ? `[${type === 'mmd' ? 'PMX' : 'VRM'}] ${model.name}` : '';
  }
  return resolveLive2DModel(currentConfig.ui?.live2d_model).entry?.name || '';
});
ipcMain.handle('control:select-live2d-model', async (_event, name) => {
  const targetType = name.startsWith('[PMX] ') ? 'mmd' : name.startsWith('[VRM] ') ? 'vrm' : 'live2d';
  const modelName = targetType === 'live2d' ? name : name.slice(6);
  const models = targetType === 'mmd' ? scanMMDModels() : targetType === 'vrm' ? scanVRMModels() : scanLive2DModels();
  const entry = models.find(model => model.name === modelName);
  if (!entry) throw new Error('模型不存在');
  const currentConfig = readJson(configPath, {});
  const activeType = currentConfig.ui?.model_type || 'live2d';
  const modelResult = await postDesktop('/set-avatar-model', { type: targetType, model_name: modelName }, 20000);
  let switchResult = modelResult;
  if (modelResult.success && activeType !== targetType) {
    switchResult = await postDesktop('/switch-avatar-type', { type: targetType }, 30000);
  }
  currentConfig.ui ||= {};
  currentConfig.ui.model_type = targetType;
  if (targetType !== 'live2d') {
    currentConfig.ui[`${targetType}_model`] = entry.name;
    currentConfig.ui[`${targetType}_model_path`] = entry.modelPath;
  } else {
    currentConfig.ui.live2d_model = modelName;
    currentConfig.ui.vrm_model = '';
    currentConfig.ui.vrm_model_path = '';
  }
  // 2026-11-17 六十四轮：写盘失败时不能回「已切换」—— 热切换可能成功，但重启后会回到旧模型
  const wrote = writeJsonVerified(configPath, currentConfig);   // 原子写 + 回读校验
  if (!wrote.ok) {
    const error = '模型切换结果未能写入 config.json（重启后会回到旧模型）：' + (wrote.error || '未知原因');
    console.error('[control] ' + error);
    return { ok: false, error, message: error, hotReloaded: Boolean(switchResult.success) };
  }
  if (switchResult.success) return { ok: true, hotReloaded: true, message: `已切换到 ${name}` };
  return { ok: true, hotReloaded: false, message: `已选择 ${name}，桌宠未运行，将在下次启动时生效` };
});
ipcMain.handle('control:load-motion-data', (_event, character) => motionData(character));
ipcMain.handle('control:save-motion-data', async (_event, character, kind, values) => {
  if (!character || !['actions', 'expressions'].includes(kind)) throw new Error('动作配置无效');
  writeMotionConfig(character, kind, values);
  await notifyDesktopReload();
  return { ok: true };
});
ipcMain.handle('control:reset-motion-data', async (_event, character, kind) => {
  if (!['actions', 'expressions'].includes(kind) || !isLive2DModelDir(character)) return { ok: false, message: '当前模型没有可还原的配置' };
  // AI_set_live2d.py 写表情备份时用的键名是 original_config1，动作备份才是 original_config
  const backupFile = kind === 'actions' ? 'character_backups.json' : 'character_backups1.json';
  const backupKey = kind === 'actions' ? 'original_config' : 'original_config1';
  const original = readJson(path.join(__dirname, backupFile), {})[character]?.[backupKey]?.[motionRootKey(kind)];
  // 没有备份（例如手动放进来的新模型）时，直接按模型目录重新生成默认配置；有备份也过一遍合并，剔除已不存在的文件
  writeMotionConfig(character, kind, mergeMotionConfig(kind, character, original || {}).config);
  await notifyDesktopReload();
  return { ok: true, message: original ? '已还原原始配置' : '没有找到备份，已按模型文件重新生成默认配置' };
});
ipcMain.handle('control:trigger-motion', (_event, name) => postDesktop('/control-motion', { action: 'trigger_emotion', emotion_name: name }));
ipcMain.handle('control:trigger-expression', (_event, name) => postDesktop('/control-expression', { action: 'trigger_expression', expression_name: name }));
ipcMain.handle('control:apply-vmc', async (_event, host, port) => {
  const current = readJson(configPath, {}); current.vmc ||= {}; current.vmc.host = host || '127.0.0.1'; current.vmc.port = Number(port) || 39539;
  // 2026-11-17 六十四轮：写盘失败时不许说「已保存」。也不把未落盘的地址推给运行时，
  // 否则重启后地址回退、用户却以为已生效。
  const wrote = writeJsonVerified(configPath, current);   // 原子写 + 回读校验
  if (!wrote.ok) {
    const error = 'VMC 地址保存失败：' + (wrote.error || '未知原因');
    console.error('[control] ' + error);
    return { success: false, ok: false, error, message: error };
  }
  if (!live2dProcess || live2dProcess.exitCode !== null) return { success: true, message: 'VMC 地址已保存，桌宠启动后生效' };
  return postDesktop('/control-vmc', { host: current.vmc.host, port: current.vmc.port });
});

// ── v2 控制中心新增 IPC（总览 / 记忆）──────────────────────────────────
// 总览页唯一数据源：一次扇出全部真实健康状态，前端不许自己到处戳端口。
const __localJson = (port, p, timeoutMs = 1500) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: p, timeout: timeoutMs }, (res) => {
    let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(null); } });
  });
  req.on('error', () => resolve(null));
  req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
});
const __tcpUp = (port, timeoutMs = 1000) => new Promise((resolve) => {
  const net = require('net');
  const s = net.connect({ host: '127.0.0.1', port });
  s.setTimeout(timeoutMs);
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('timeout', () => { s.destroy(); resolve(false); });
  s.once('error', () => resolve(false));
});
// 「记忆图谱」数据源（v2 记忆页「图谱」小块）：
// 优先 MemOS 真图谱（实测 8003：/graph/stats → {status:'enabled',entity_count,relation_count}；
//   /graph/entities?limit=N → {entities:[{id,name,entity_type,properties:{description,source_memory_ids},...}]}；
//   /graph/relations?limit=N → {relations:[{source_id,target_id,relation_type,properties:{description},...}]}；
//   节点点击要弹的「记忆文本」用 POST /get_memory_by_ids {memory_ids:[...]} 批量回填，实测 75 ids ~135ms）。
// 图谱接口不可用则降级 /list，条目按 user_id 共现（同用户记忆流按时间相邻连边），mode='degraded' 由 UI 注明。
// 归一化成 {mode,nodes:[{id,label,type?,count?,text?}],edges:[{source,target,label?}],note}，节点上限 60 防炸。
const GRAPH_NODE_CAP = 60;
const __memosPost = (p, body, timeoutMs = 8000) => new Promise((resolve) => {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  const req = http.request({ host: '127.0.0.1', port: 8003, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: timeoutMs }, (res) => {
    let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(null); } });
  });
  req.on('error', () => resolve(null));
  req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  req.write(data); req.end();
});
const __memoryGraph = async () => {
  try {
    const stats = await __localJson(8003, '/graph/stats', 5000);
    if (stats && stats.status === 'enabled') {
      const [ents, rels] = await Promise.all([
        __localJson(8003, '/graph/entities?limit=500', 8000),
        __localJson(8003, '/graph/relations?limit=800', 8000),
      ]);
      const entities = (ents && Array.isArray(ents.entities)) ? ents.entities : [];
      const relations = (rels && Array.isArray(rels.relations)) ? rels.relations : [];
      if (entities.length) {
        // 选前 60 节点：连边度数×2 + 来源记忆条数打分，重要实体优先
        const degree = new Map();
        relations.forEach((r) => {
          degree.set(r.source_id, (degree.get(r.source_id) || 0) + 1);
          degree.set(r.target_id, (degree.get(r.target_id) || 0) + 1);
        });
        const srcIdsOf = (e) => (Array.isArray(e.source_memory_ids) && e.source_memory_ids.length)
          ? e.source_memory_ids : ((e.properties && e.properties.source_memory_ids) || []);
        const picked = entities
          .map((e) => ({ e, score: (degree.get(e.id) || 0) * 2 + srcIdsOf(e).length }))
          .sort((a, b) => b.score - a.score)
          .slice(0, GRAPH_NODE_CAP);
        const keep = new Set(picked.map((p) => p.e.id));
        // 回填节点可弹的记忆文本：收拢来源记忆 id 一次批量拉（超 120 条截断防炸）
        const memIds = [];
        picked.forEach(({ e }) => srcIdsOf(e).forEach((id) => { if (id && !memIds.includes(id)) memIds.push(id); }));
        const memText = new Map();
        if (memIds.length) {
          try {
            const got = await __memosPost('/get_memory_by_ids', { memory_ids: memIds.slice(0, 120) }, 8000);
            ((got && got.memories) || []).forEach((m) => { if (m && m.id) memText.set(m.id, String(m.content || '')); });
          } catch (e) { console.error('[control] 图谱来源记忆回填失败:', e && e.message); }
        }
        const nodes = picked.map(({ e }) => {
          const texts = srcIdsOf(e).map((id) => memText.get(id)).filter(Boolean);
          const desc = (e.properties && e.properties.description) || '';
          const text = [desc, ...texts].filter(Boolean).join('\n──────\n');
          return {
            id: e.id,
            label: e.name || String(e.id).slice(0, 8),
            type: e.entity_type || '',
            count: srcIdsOf(e).length,
            text: text.slice(0, 1500),
          };
        });
        const edges = [];
        const seenEdge = new Set();
        relations.forEach((r) => {
          if (!keep.has(r.source_id) || !keep.has(r.target_id) || r.source_id === r.target_id) return;
          const key = r.source_id + '>' + r.target_id;
          if (seenEdge.has(key)) return;
          seenEdge.add(key);
          edges.push({ source: r.source_id, target: r.target_id, label: r.relation_type || r.type || '' });
        });
        return { mode: 'graph', nodes, edges, note: '', stats };
      }
      return { mode: 'empty', nodes: [], edges: [], note: '' };
    }
  } catch (e) { console.error('[control] 图谱主链路失败，转降级:', e && e.message); }
  // 降级：/list 条目按 user_id 共现——同一用户记忆流里时间相邻的两条连边，避免两两全连成爆团
  try {
    const list = await __localJson(8003, '/list', 8000);
    const items = (list && (list.memories || list.items)) || [];
    if (!items.length) {
      // /list 都没应答 = 记忆服务不可达，按本仓「不拿暂无撒谎」的规矩报失败，而不是「图谱为空」
      if (!list) return { mode: 'error', nodes: [], edges: [], note: '' };
      return { mode: 'empty', nodes: [], edges: [], note: '' };
    }
    const byTime = items.slice().sort((a, b) => String(a.created_at || a.timestamp || '').localeCompare(String(b.created_at || b.timestamp || '')));
    const picked = byTime.slice(-GRAPH_NODE_CAP);
    const keep = new Set(picked.map((m) => m.id));
    const edges = [];
    for (let i = 1; i < byTime.length; i++) {
      const prev = byTime[i - 1], cur = byTime[i];
      if ((prev.user_id || 'default') !== (cur.user_id || 'default')) continue;
      if (!keep.has(prev.id) || !keep.has(cur.id)) continue;
      edges.push({ source: prev.id, target: cur.id, label: '共现' });
    }
    const nodes = picked.map((m) => ({
      id: m.id,
      label: String(m.content || m.text || '').slice(0, 16) || '记忆',
      type: m.memory_type || '',
      count: 1,
      text: String(m.content || m.text || '').slice(0, 1500),
    }));
    return { mode: 'degraded', nodes, edges, note: '图谱接口未就绪，已降级：按 user_id 共现（时间相邻记忆相连）' };
  } catch (e) { console.error('[control] 图谱降级链路失败:', e && e.message); return { mode: 'error', nodes: [], edges: [], note: '' }; }
};

ipcMain.handle('control:overview', async () => {
  const [memos, health, state, pet, sub, ttsUp, asrUp, earUp] = await Promise.all([
    __localJson(8003, '/stats', 8000), __localJson(8103, '/health'), __localJson(8103, '/state'),
    __localJson(8004, '/bounds'), __localJson(8005, '/bounds'),
    __tcpUp(9883), __tcpUp(1000), __tcpUp(1001),
  ]);
  const petBounds = pet && pet.bounds ? pet.bounds : null;
  const services = [
    { id: 'pet',    name: '皮套宿主',    port: 8004, up: !!petBounds, detail: petBounds ? (petBounds.width + '×' + petBounds.height + ' @' + petBounds.x + ', ' + petBounds.y) : '离线' },
    { id: 'memos',  name: 'MemOS 记忆',  port: 8003, up: !!memos, detail: memos ? (memos.total_count + ' 条 · 图谱' + (memos.graph_enabled ? '开' : '关')) : '离线' },
    { id: 'tts',    name: 'Edge TTS',    port: 9883, up: ttsUp, detail: ttsUp ? '在线' : '离线' },
    { id: 'asr',    name: 'SenseVoice ASR', port: 1000, up: asrUp, detail: asrUp ? '在线' : '离线' },
    { id: 'ear',    name: '一起看耳朵',  port: 1001, up: earUp, detail: earUp ? '在听' : '离线' },
  ];
  let cfgRoot = {};
  try { cfgRoot = readJson(configPath, {}) || {}; } catch (e) {}
  const cfgLlm = cfgRoot.llm || {};
  // 静默状态（2026-11-21 统一管辖）：优先 8103 /state 的 live 值；8103 掉线时退回盘上
  // cost.quiet（缺省=开，与 main.js 的 quietDefault 同位），绝不把「不知道」写成 false。
  // 以前这里 `!!(state && state.quiet)`：桌宠没开时总览显示「静默=关」，和盘上真值打架。
  const quietKnown = state && typeof state.quiet === 'boolean'
    ? state.quiet
    : cfgRoot.cost && cfgRoot.cost.quiet === false ? false : true;
  return {
    services,
    quiet: quietKnown,
    quietSource: state && typeof state.quiet === 'boolean' ? 'live' : 'config',
    uptime: (health && health.uptime) || 0,
    pet: petBounds,
    subtitle: (sub && sub.bounds) || null,
    model: { provider_id: cfgLlm.provider_id || '?', model_id: cfgLlm.model_id || '?' },
    memoryCount: (memos && memos.total_count) || 0,
    at: Date.now(),
  };
});

// 记忆页数据源：MemOS 列表 + 整理日志 + 核心记忆，一次取齐。
ipcMain.handle('control:memory', async () => {
  const graphPromise = __memoryGraph(); // 图谱与下面并行取，零额外等待；内部自捕获不外抛，失败不拖垮记忆页
  const [stats, list] = await Promise.all([
    __localJson(8003, '/stats', 8000), __localJson(8003, '/list', 8000),
  ]);
  const digestDir = path.join(projectRoot, 'data', '记忆整理');
  let digests = [];
  try {
    digests = fs.readdirSync(digestDir).filter((f) => f.endsWith('.md')).sort().reverse().slice(0, 10)
      .map((f) => {
        try { return { file: f, content: fs.readFileSync(path.join(digestDir, f), 'utf8').slice(0, 8000) }; }
        catch (e) { return null; }
      }).filter(Boolean);
  } catch (e) { /* 目录还没建 */
  }
  let core = '';
  try { core = fs.readFileSync(path.join(projectRoot, 'data', '核心用户记忆.txt'), 'utf8').slice(0, 4000); } catch (e) {}
  const items = (list && (list.memories || list.items)) || [];
  return { stats, items, digests, core, graph: await graphPromise };
});

// 「记忆图谱」具名通道：与 control:memory 返回里的 graph 字段同源（__memoryGraph）。
// control-preload.js 目前未透传该通道（不在本次可改文件清单内），面板实际走 control:memory.graph；
// preload 加上 memoryGraph 透传后本通道即可直用。
ipcMain.handle('control:memory-graph', () => __memoryGraph());

// ── 记忆体检（B3，2026-11-23）：只读一致性报告 ──────────────────────────────
// 跑 pet-runtime/tools/memos-consistency.mjs --json（**不带 --fix**，只读、不改数据），
// 把 summary / 向量 / 图谱 / BM25 计数回给面板。修复命令只作为一行文本给用户手动执行。
// 用 Electron 自身当 Node（ELECTRON_RUN_AS_NODE=1）：不依赖用户 PATH 里的 node，
// 也不会在打包环境里「找不到 node」。
const MEMOS_CONSISTENCY_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'pet-runtime', 'tools', 'memos-consistency.mjs');
ipcMain.handle('control:memory-consistency', async () => {
  if (!fs.existsSync(MEMOS_CONSISTENCY_SCRIPT)) {
    return { ok: false, error: '找不到体检脚本：' + MEMOS_CONSISTENCY_SCRIPT };
  }
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = spawn(process.execPath, [MEMOS_CONSISTENCY_SCRIPT, '--json'], {
        cwd: path.dirname(MEMOS_CONSISTENCY_SCRIPT),
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
    } catch (e) { return done({ ok: false, error: '启动体检失败：' + ((e && e.message) || e) }); }
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* 已退出 */ }
      done({ ok: false, error: '体检超时（120 秒）—— 8003 可能没响应' });
    }, 120000);
    child.stdout.on('data', (c) => {
      out += c;
      if (out.length > 4 * 1024 * 1024) {
        try { child.kill(); } catch (e) { /* 已退出 */ }
        done({ ok: false, error: '体检输出过大（>4MB）' });
      }
    });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, error: '启动体检失败：' + ((e && e.message) || e) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (settled) return;
      let report = null;
      try { report = JSON.parse(out); } catch (e) { /* 下面统一报原因 */ }
      if (!report) {
        return done({
          ok: false,
          error: '体检脚本退出码 ' + code + '，输出不是 JSON',
          detail: String(err || out).slice(0, 800),
        });
      }
      done({ ok: true, report });
    });
  });
});

// 静默模式开关（总览页用）：走 8103 /quiet，vts-server 会持久化 config.cost.quiet
// 皮套 API 代理：控制中心 v2 的「装扮与形态」区通过它调 window.petBody.*（资产/档位/预设）
ipcMain.handle('control:petbody-eval', async (_event, js) => {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify({ js: String(js || '') }), 'utf8');
    const req = http.request({ host: '127.0.0.1', port: 8004, path: '/eval', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 10000 }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve({ ok: false, error: 'bad response' }); } });
    });
    req.on('error', () => resolve({ ok: false, error: '桌宠不在线' }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(data); req.end();
  });
});

ipcMain.handle('control:toggle-quiet', async (_event, on) => {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify({ on: on !== false }), 'utf8');
    const req = http.request({ host: '127.0.0.1', port: 8103, path: '/quiet', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 3000 }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve({ ok: false }); } });
    });
    req.on('error', () => resolve({ ok: false, error: '桌宠不在线' }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(data); req.end();
  });
});

// ── 能力注册表接前端（2026-11-16 P1，2026-11-21 修「显示假值」）─────────
// 设置页的「能力」区由 js/core/capabilities.js 直接生成，不再手写行。
// 写回只允许注册表里声明过的 config 键（白名单，同 3003 的思路），
// 类型必须和 default 一致；写完原子写盘 + 回读 + /reload-config。
//
// 读的时候以前只读 config.json 原始值：llm.reasoning / llm.temperature 的真值在
// llm_providers.json 的当前模型上（saveControlConfig 会把 config.json 的同名键删掉），
// 结果能力页永远显示 default。现在走 resolveCapabilityValue（config > 当前模型 > default），
// 并把来源（静态 config.json / 运行时模型 / 代码默认）一起回给渲染层做可见标记。
ipcMain.handle('control:capabilities', () => {
  const cfg = readJson(configPath, {});
  const providers = loadProvidersFromStore(__dirname).providers || [];
  const providerId = (cfg.llm && cfg.llm.provider_id) || '';
  const modelId = (cfg.llm && (cfg.llm.model_id || cfg.llm.model)) || '';
  let plugins = [];
  try {
    const p = readJson(path.join(pluginsPath, 'enabled_plugins.json'), {});
    plugins = Array.isArray(p.plugins) ? p.plugins : (Array.isArray(p.enabled) ? p.enabled : []);
  } catch (e) { /* 插件清单缺失时插件类显示为关 */ }
  return CAPABILITIES.map((cap) => {
    const resolved = resolveCapabilityValue(cap, { config: cfg, providers, providerId, modelId });
    return {
      id: cap.id, name: cap.name, group: cap.group, kind: cap.kind,
      key: cap.key || '', default: cap.default, hot: cap.hot !== false,
      soft: !!cap.soft, port: cap.port || null, note: cap.note || '',
      choices: Array.isArray(cap.choices) ? cap.choices : null,
      deprecated: cap.deprecated || null,
      value: cap.kind === 'config' ? resolved.value : undefined,
      configured: cap.kind === 'config' ? resolved.configured : undefined,
      // 静态值 vs 运行时值：config=config.json 显式值；model=当前模型参数（运行时物化）；default=代码默认
      valueSource: cap.kind === 'config' ? resolved.source : undefined,
      pluginEnabled: cap.kind === 'plugin' ? plugins.includes(cap.key) : undefined,
    };
  });
});

// ── 模型级参数写穿（2026-11-21）────────────────────────────────────────────
// 能力页的「思考等级 / 采样温度」开关是唯一启停入口，但它以前只写 config.json；
// 运行时 LLMClient.fromProviderConfig 只从 llm_providers.json 的当前模型读 →
// 拨开关不生效、界面却显示「已保存」。这里把键写穿到当前模型条目上。
//
// 为什么保留 config.json 不动：config 里的同名键是「无通讯录时」的回退值
// （llm-provider-store.buildLegacyProviders 会把它迁进模型），本次只改模型，
// 不改写回退值、也不删除它 —— 测试断言 config.json 字节不变。
//
// 选择当前 provider/model 的规则与 loadControlConfig / LLMProviderManager 对齐：
//   config.llm.provider_id 存在则必须命中（不静默换 provider）；缺失则取第一个启用的。
//   config.llm.model_id 存在则必须命中且未禁用（不新建、不改别的模型）；缺失则取第一个启用的。
// 任何一步对不上都返回明确 code，调用方不得把它包装成成功。
//
// @param {{providersPath:string, configPath:string}} paths  只碰这两个文件（可测）
// @param {string} key   能力注册表键（llm.reasoning_enabled 等）
// @param {any} value
// @returns {{ok:boolean, wroteTo?:'model', providerId?:string, modelId?:string, modelKey?:string,
//            value?:any, previous?:any, wrote?:boolean, code?:string, error?:string, rolledBack?:boolean,
//            fallbackToConfig?:boolean}}
function applyModelParamWrite(paths, key, value) {
  const modelKey = MODEL_PARAM_KEYS[key];
  const fail = (code, error, extra) => Object.assign({ ok: false, code, error }, extra || {});
  if (!modelKey) return fail('not-model-param', `${key} 不是模型级参数`);
  const providersPath = paths && paths.providersPath;
  const cfgPath = paths && paths.configPath;
  if (!providersPath || !cfgPath) return fail('bad-input', 'providersPath / configPath 缺失');

  const normalized = normalizeModelParamValue(key, value);
  if (normalized === undefined) return fail('bad-value', `${key} 的值不合法：${JSON.stringify(value)}`);

  const baseDir = path.dirname(providersPath);
  const store = loadProvidersFromStore(baseDir);
  if (store.loadFailed) {
    return fail('store-unreadable', 'llm_providers.json 解析失败，已拒绝写入（避免覆盖用户数据）');
  }
  // 首次运行还没有通讯录：不能硬失败，交给调用方回退写 config.json 并标明来源。
  if (!store.providers.length) {
    return fail('no-providers', '还没有模型通讯录（llm_providers.json 为空），回退写 config.json', { fallbackToConfig: true });
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    return fail('config-unreadable', '读不到 config.json，无法确定当前模型：' + (e && e.message ? e.message : e));
  }
  const llm = (cfg && typeof cfg === 'object' && cfg.llm && typeof cfg.llm === 'object') ? cfg.llm : {};
  const providers = store.providers;

  const wantedProviderId = String(llm.provider_id || '').trim();
  let provider;
  if (wantedProviderId) {
    provider = providers.find((p) => p && p.id === wantedProviderId) || null;
    if (!provider) {
      return fail('provider-missing', `config.json 指向的提供商「${wantedProviderId}」不在 llm_providers.json 里（拒绝改到其它模型）`);
    }
  } else {
    provider = providers.find((p) => p && p.enabled !== false) || providers[0] || null;
  }
  if (!provider) return fail('provider-missing', '没有可用的提供商');
  if (provider.enabled === false) {
    return fail('provider-disabled', `提供商「${provider.id}」已被禁用，写它的模型不会生效`);
  }

  const models = Array.isArray(provider.models) ? provider.models : [];
  const wantedModelId = String(llm.model_id || llm.model || '').trim();
  let model;
  if (wantedModelId) {
    model = models.find((m) => m && m.model_id === wantedModelId) || null;
    if (!model) {
      return fail('model-missing', `当前模型「${wantedModelId}」不在提供商「${provider.id}」的模型列表里（拒绝新建或改到其它模型）`);
    }
    if (model.enabled === false) {
      return fail('model-disabled', `当前模型「${wantedModelId}」已被禁用，写它不会生效`);
    }
  } else {
    model = models.find((m) => m && m.enabled !== false) || models[0] || null;
    if (!model) return fail('model-missing', `提供商「${provider.id}」还没有配置任何模型`);
  }

  // config 优先键的「影子值」检查：config.json 里显式写着旧值且与新值不同时，
  // 写模型不会生效（applySampling 先读 config）。交回调用方改走 config 回退，
  // 而不是静默写一个运行时不读的模型值。
  if (CONFIG_PREFERRED_MODEL_PARAMS.has(key)) {
    const configKey = String(key).split('.').pop();
    if (Object.prototype.hasOwnProperty.call(llm, configKey)) {
      const current = llm[configKey];
      const same = typeof normalized === 'boolean'
        ? current === normalized
        : Number(current) === normalized;
      if (!same) {
        return fail('config-shadowed',
          `config.json 里显式写着 llm.${configKey}=${JSON.stringify(current)}，运行时会优先读它；本次改走 config.json 才能生效`,
          { configKey, configValue: current });
      }
    }
  }

  // 写前留原始字节：回读对不上时整文件还原，避免「写坏了却只能说抱歉」。
  let originalRaw = null;
  try { originalRaw = fs.readFileSync(providersPath, 'utf8'); } catch (e) { originalRaw = null; }

  const previous = model[modelKey];
  model[modelKey] = normalized;
  const saved = saveProviders(baseDir, providers);
  if (!saved.ok) {
    return fail('write-failed', '写 llm_providers.json 失败：' + (saved.error || '未知原因'));
  }

  // 回读：确认磁盘上真的是刚写的值（不是内存对象），而不是只信 writeJsonVerified 的键数校验。
  const after = loadProvidersFromStore(baseDir);
  const afterProvider = after.providers.find((p) => p.id === provider.id);
  const afterModel = afterProvider && (afterProvider.models || []).find((m) => m.model_id === model.model_id);
  if (!afterModel || afterModel[modelKey] !== normalized) {
    let rolledBack = false;
    if (originalRaw !== null) {
      try { fs.writeFileSync(providersPath, originalRaw, 'utf8'); rolledBack = true; } catch (e) { rolledBack = false; }
    }
    return fail('readback-mismatch',
      `回读校验失败：模型「${model.model_id}」的 ${modelKey} 不是刚写入的值` + (rolledBack ? '（已还原原文件）' : '（还原失败，请检查 llm_providers.json）'),
      { rolledBack });
  }

  return {
    ok: true, wroteTo: 'model', providerId: provider.id, modelId: model.model_id,
    modelKey, value: normalized, previous, wrote: true,
  };
}

/**
 * performance.* 的热下发（2026-11-25 P3）：控制中心/能力页写完 config 后，把整组
 * performance 配置推给运行中的皮套（window.petBody.setPerformanceConfig）。
 * 为什么需要：这些键标了 hot=true，但旧链路只写盘 + reload-config；皮套在渲染进程里，
 * 不重读 config，于是「显示已开、实际没变」。失败不阻塞保存 —— 返回 hotApplied:false，
 * 由 UI 提示「已写盘、重启生效」。
 */
function applyPerformanceConfigLive(configPath) {
  return new Promise((resolve) => {
    let perf = null;
    try { perf = (readJson(configPath, {}) || {}).performance || null; } catch (e) { resolve({ ok: false, error: '读配置失败' }); return; }
    const js = 'window.petBody && typeof window.petBody.setPerformanceConfig === "function"'
      + ' ? (window.petBody.setPerformanceConfig(' + JSON.stringify(perf || {}) + '), true) : false';
    const data = Buffer.from(JSON.stringify({ js }), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: 8004, path: '/eval', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 3000,
    }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; });
      res.on('end', () => {
        try { const j = JSON.parse(s); resolve({ ok: j.ok === true && j.value === true }); }
        catch (e) { resolve({ ok: false, error: '响应非 JSON' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(data); req.end();
  });
}

ipcMain.handle('control:set-config-value', async (_event, payload) => {
  const key = payload && payload.key;
  const value = payload && payload.value;
  const cap = CAPABILITIES.find((c) => c.kind === 'config' && c.key === key);
  if (!cap) throw new Error(`未声明的配置键：${key}`);
  const t = typeof cap.default;
  const okType = (t === 'boolean' && typeof value === 'boolean')
    || (t === 'number' && typeof value === 'number' && Number.isFinite(value))
    || (t === 'string' && typeof value === 'string');
  if (!okType) throw new Error(`类型不匹配：${key} 需要 ${t}`);

  // 静默模式有唯一真源（8103 /quiet，会持久化 cost.quiet）。
  // 直接写 config 会出现「面板写盘、运行时不认」的双源，所以这里转给 8103。
  if (key === 'cost.quiet') {
    const r = await new Promise((resolve) => {
      const data = Buffer.from(JSON.stringify({ on: value === true }), 'utf8');
      const req = http.request({ host: '127.0.0.1', port: 8103, path: '/quiet', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 3000 }, (res) => {
        let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve({ ok: false }); } });
      });
      req.on('error', () => resolve({ ok: false, error: '桌宠不在线' }));
      req.setTimeout(3000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      req.write(data); req.end();
    });
    if (!r || r.ok === false) throw new Error('静默切换失败：' + ((r && r.error) || '未知'));
    return { ok: true, key, value, hot: true, via: '8103' };
  }

  // 白名单键逐级建对象后作为 patch 写入（不做字符串拼接，键来自注册表常量）
  const parts = String(key).split('.');
  const patch = {};
  let obj = patch;
  for (let i = 0; i < parts.length - 1; i++) {
    obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  obj[parts[parts.length - 1]] = value;

  // 模型级参数写穿（2026-11-21）：思考等级 / 采样温度的运行时真值在
  // llm_providers.json 的当前模型条目上；只写 config.json 等于写了个没人读的键。
  // 必须写在 saveAndApply 之前：模型分支成功时**不能**再走 config 写盘（否则
  // 磁盘上出现「模型新值 + config 旧值」两套，而 temperature_enabled 运行时先读 config）。
  if (MODEL_PARAM_KEYS[key]) {
    const out = applyModelParamWrite(
      { providersPath: path.join(__dirname, 'llm_providers.json'), configPath },
      key, value
    );
    if (out.ok) {
      // 宿主收到 /reload-config 后才重读 llm_providers.json（config-loader 会重新
      // 注水 config.llm_providers 并 init provider 管理器）。重载失败如实返回，
      // 由渲染层的「已写盘、未重载」分支提示重启 —— 不伪装成功。
      const reload = await notifyHostReload({ timeoutMs: 3000 });
      const reloaded = reload.success === true;
      return {
        ok: reloaded, key, value: out.value, hot: cap.hot !== false,
        wroteTo: 'model', providerId: out.providerId, modelId: out.modelId,
        wrote: true,
        reload: { success: reloaded, message: String(reload.message || '') },
        readback: { ok: true },
        ...(reloaded ? {} : { error: '热重载失败（模型参数已写盘，宿主仍在使用旧配置）：' + (reload.message || '未知原因') }),
      };
    }
    // 两种合法回退：
    //   ① no-providers：首次运行还没有通讯录 → 写 config，宿主迁移时把它带进模型；
    //   ② config-shadowed：config.json 里显式留着运行时会优先读的旧键 → 写 config 才生效。
    if (out.code !== 'no-providers' && out.code !== 'config-shadowed') {
      throw new Error(out.error || `${key} 写入当前模型失败`);
    }
    const fallback = await saveAndApply(configPath, patch, { mode: 'merge', verifyKeys: [key] });
    return {
      ok: fallback.ok, key, value: getConfigPath(readJson(configPath, {}), key), hot: cap.hot !== false,
      wroteTo: 'config',
      fallback: out.code === 'no-providers',
      shadowed: out.code === 'config-shadowed',
      wrote: fallback.wrote, reload: fallback.reload, readback: fallback.readback,
      ...(fallback.error ? { error: fallback.error } : {}),
    };
  }

  // 能力开关只改一个 config 键：走 merge 模式，不经过 saveControlConfig。
  // 后者会顺带重写 llm_providers.json（通讯录/凭据），而这条路径没有通讯录数据 ——
  // 2026-11-16 就是它把 provider 的 api_url/api_key 覆盖成空、LLM 全线 Failed to fetch。
  // 2026-11-17 六十三轮：虽然只改一个键，写盘/热重载/读回也必须和整份保存同一条链；
  // 以前这里 writeJsonVerified 的返回值被丢掉、reload 结果也没人看，等于「写盘成功 = 生效」。
  const result = await saveAndApply(configPath, patch, { mode: 'merge', verifyKeys: [key] });
  // performance.* 写盘后热下发给皮套；失败不算保存失败（已写盘），但如实标记。
  const hotPerf = (String(key).startsWith('performance.') && result.ok)
    ? await applyPerformanceConfigLive(configPath)
    : null;
  return {
    ok: result.ok, key, value: getConfigPath(readJson(configPath, {}), key), hot: cap.hot !== false,
    wrote: result.wrote, reload: result.reload, readback: result.readback,
    ...(hotPerf ? { hotApplied: hotPerf.ok === true, ...(hotPerf.ok ? {} : { hotError: hotPerf.error || '热下发失败' }) } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
});

ipcMain.handle('control:start-live2d', async (event) => {
  // 「启动桌宠」唯一真链路 = pet-runtime/tools/launch-my-neuro.mjs（TTS/ASR/耳朵/MemOS 四服务 + 宿主）。
  // 旧实现 spawn go.bat：上游裸起，四个服务全没有；且查重只认自己生的进程，
  // 桌宠由 大肥鱼.cmd/开机自启拉起时这里会再起一套（2026-11-01 规整修正）。
  const net = require('net');
  const portUp = (port) => new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(1200);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
  if (await portUp(8103) || await portUp(8004)) {
    event.sender.send('control:tool-log', '桌宠已在运行（8103/8004 端口在线），无需重复启动。\n');
    return { ok: true, message: '桌宠已在运行' };
  }
  if (live2dProcess && live2dProcess.exitCode === null) return { ok: false, message: '正在启动中' };
  startRuntimeLog(event.sender);
  showAvatarLoadingWindow();
  const launcher = path.join(__dirname, '..', '..', '..', 'pet-runtime', 'tools', 'launch-my-neuro.mjs');
  live2dProcess = spawn(process.platform === 'win32' ? 'node' : 'node', [launcher], {
    cwd: __dirname,
    windowsHide: true
  });
  live2dProcess.stdout.on('data', () => {});
  live2dProcess.stderr.on('data', () => {});
  live2dProcess.on('exit', code => {
    closeAvatarLoadingWindow();
    stopRuntimeLog();
    if (!event.sender.isDestroyed()) {
      event.sender.send('control:tool-log', `桌宠进程已退出（${code ?? '未知'}）\n`);
      event.sender.send('control:live2d-state', false);
    }
    live2dProcess = null;
  });
  return { ok: true, message: '正在启动桌宠' };
});

ipcMain.handle('control:stop-live2d', async () => {
  return stopLive2dProcess();
});


// ── 知识库、技能库与操控执行日志 IPC（2026-11-09 前端可视化）────────────────────
const kbModule = (() => {
  try { return require('./plugins/community/dispatch/knowledge-base.js'); } catch (e) { return null; }
})();
const skModule = (() => {
  try { return require('./plugins/community/dispatch/skill-library.js'); } catch (e) { return null; }
})();
const gcModule = (() => {
  try { return require('./plugins/community/dispatch/game-control.js'); } catch (e) { return null; }
})();

ipcMain.handle('control:knowledge-list-games', async () => {
  if (!kbModule || !kbModule.ROOT) return ['植物大战僵尸', '原神', '我的世界', 'generic-desktop'];
  const games = new Set();
  ['rules', 'live', 'experience'].forEach(sub => {
    const dir = path.join(kbModule.ROOT, sub);
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).forEach(f => {
        if (f.endsWith('.json') || f.endsWith('.jsonl')) {
          games.add(f.replace(/\.jsonl?$/, ''));
        }
      });
    }
  });
  return Array.from(games);
});

ipcMain.handle('control:knowledge-get-game', async (_event, gameName) => {
  if (!kbModule) return { ok: false, error: '知识库模块不可用' };
  try {
    const data = await kbModule.loadLayers(gameName);
    const reliability = {};
    if (data.typicalActions && Array.isArray(data.typicalActions)) {
      for (const act of data.typicalActions) {
        const prefix = act.split(' ')[0];
        reliability[prefix] = kbModule.getActionReliability(gameName, prefix);
      }
    }
    return { ok: true, data, reliability };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('control:knowledge-save-rules', async (_event, gameName, ruleData) => {
  if (!kbModule || !kbModule.ROOT) return { ok: false, error: '知识库目录不存在' };
  try {
    const rulesDir = path.join(kbModule.ROOT, 'rules');
    if (!fs.existsSync(rulesDir)) fs.mkdirSync(rulesDir, { recursive: true });
    const target = path.join(rulesDir, `${gameName}.json`);
    fs.writeFileSync(target, JSON.stringify(ruleData, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('control:knowledge-save-live', async (_event, gameName, liveData) => {
  if (!kbModule || !kbModule.ROOT) return { ok: false, error: '知识库目录不存在' };
  try {
    const liveDir = path.join(kbModule.ROOT, 'live');
    if (!fs.existsSync(liveDir)) fs.mkdirSync(liveDir, { recursive: true });
    const target = path.join(liveDir, `${gameName}.json`);
    fs.writeFileSync(target, JSON.stringify(liveData, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('control:knowledge-add-experience', async (_event, expItem) => {
  if (!kbModule) return { ok: false, error: '知识库模块不可用' };
  try {
    const res = kbModule.recordExperience(expItem);
    return res;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('control:skills-list', async () => {
  if (!skModule) return { ok: false, skills: [] };
  try {
    const db = JSON.parse(fs.readFileSync(skModule.SKILL_FILE, 'utf8'));
    const skills = (db.skills || []).map(s => {
      const rel = skModule.reliabilityOf(s);
      return Object.assign({}, s, { reliability: rel });
    });
    return { ok: true, skills };
  } catch (err) {
    return { ok: false, skills: [] };
  }
});

ipcMain.handle('control:skills-run', async (_event, skillName) => {
  if (!skModule) return { ok: false, error: '技能库模块不可用' };
  try {
    const res = await skModule.runSkill(skillName, {
      runGameAction: gcModule ? gcModule.runGameAction : null,
    });
    return res;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('control:skills-delete', async (_event, skillName) => {
  if (!skModule) return { ok: false, error: '技能库模块不可用' };
  try {
    return skModule.forgetSkill(skillName);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('control:actions-get-history', async () => {
  const list = [];
  if (skModule) {
    const h = skModule.getHistory();
    if (Array.isArray(h)) list.push(...h);
  }
  if (kbModule && kbModule.ROOT) {
    try {
      const expDir = path.join(kbModule.ROOT, 'experience');
      if (fs.existsSync(expDir)) {
        fs.readdirSync(expDir).filter(f => f.endsWith('.jsonl')).forEach(f => {
          const c = fs.readFileSync(path.join(expDir, f), 'utf8');
          c.split('\n').filter(Boolean).forEach(line => {
            try {
              const item = JSON.parse(line);
              list.push({
                ts: item.ts,
                action: item.action,
                arg: item.game || '',
                ok: item.kind === 'success',
                verified: item.verified,
                effect: item.kind === 'success' ? 'confirmed' : 'suspected_noop',
                tier: item.verified ? 'L2' : 'L1',
                evidence: item.evidence || item.note || '',
                detail: item.note || '',
                costMs: 45
              });
            } catch (_) {}
          });
        });
      }
    } catch (_) {}
  }
  list.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
  return { ok: true, history: list };
});

// ── 后台任务（派活账本 P0 · 2026-11-23）──────────────────────────────────
// 只读区块：列表**直读** data/dispatch-tasks.jsonl（独立进程也能看，8103 掉线不影响列表）；
// 详情走 8103 GET /dispatch/tasks?id=（.control-token 作 X-Pet-Token）。
// P0 不提供取消/重试按钮 —— 取消端点是 501，UI 不出现假按钮。
const __dispatchJsonl = () => path.join(projectRoot, 'data', 'dispatch-tasks.jsonl');

function __replayDispatchEvents(text) {
  const byId = new Map();
  let badLines = 0;
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let ev = null;
    try { ev = JSON.parse(s); } catch (e) { badLines += 1; continue; }   // 坏行只跳过，不拖垮整表
    if (!ev || typeof ev !== 'object' || !ev.taskId) continue;
    const id = String(ev.taskId);
    const cur = byId.get(id) || { taskId: id };
    if (ev.taskPreview) cur.taskPreview = String(ev.taskPreview);
    if (ev.state) cur.state = String(ev.state);
    if (Object.prototype.hasOwnProperty.call(ev, 'outcome')) cur.outcome = ev.outcome;
    if (Object.prototype.hasOwnProperty.call(ev, 'stateReason')) cur.stateReason = ev.stateReason;
    if (ev.attempted !== undefined) cur.attempted = ev.attempted === true;
    if (ev.attemptCount !== undefined) cur.attemptCount = ev.attemptCount;
    if (ev.tookMs !== undefined) cur.tookMs = ev.tookMs;
    if (ev.requestId) cur.requestId = String(ev.requestId);
    if (ev.origin) cur.origin = String(ev.origin);
    if (ev.createdAt) cur.createdAt = ev.createdAt;
    else if (!cur.createdAt) cur.createdAt = ev.ts;
    if (ev.ts) cur.ts = ev.ts;
    byId.set(id, cur);
  }
  const tasks = [...byId.values()].sort((a, b) => (Number(b.createdAt) || Number(b.ts) || 0) - (Number(a.createdAt) || Number(a.ts) || 0));
  return { tasks, badLines };
}

ipcMain.handle('control:dispatch-tasks-list', () => {
  const file = __dispatchJsonl();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    return { ok: true, tasks: [], missing: true, badLines: 0, note: '还没有后台任务账本（或还没派过活）' };
  }
  const { tasks, badLines } = __replayDispatchEvents(text);
  return { ok: true, tasks: tasks.slice(0, 200), badLines, path: file };
});

ipcMain.handle('control:dispatch-task-detail', async (_event, id) => {
  const tid = String(id == null ? '' : id).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(tid)) return { ok: false, error: 'bad_id' };
  const token = readOrCreatePetControlToken();
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = http.request({
        host: '127.0.0.1', port: 8103,
        path: '/dispatch/tasks?id=' + encodeURIComponent(tid), method: 'GET',
        headers: token ? { 'X-Pet-Token': token } : {},
        timeout: 5000,
      }, (res) => {
        let s = '';
        res.on('data', (c) => { s += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(s); } catch (e) { json = null; }
          if (json && json.ok && json.task) return done({ ok: true, task: json.task });
          if (res.statusCode === 404) return done({ ok: false, error: '账本里没有这个任务', status: 404 });
          if (res.statusCode === 401 || res.statusCode === 403) return done({ ok: false, error: '详情被令牌拒绝（.control-token 不一致）', status: res.statusCode });
          done({ ok: false, error: '8103 返回异常：HTTP ' + res.statusCode + ' ' + s.slice(0, 160), status: res.statusCode });
        });
      });
      req.on('error', (e) => done({ ok: false, error: '桌宠没在运行（8103 连不上）：' + e.message }));
      req.setTimeout(5000, () => { try { req.destroy(); } catch (e) { /* 已断开 */ } done({ ok: false, error: '8103 详情超时' }); });
      req.end();
    } catch (e) { done({ ok: false, error: String((e && e.message) || e) }); }
  });
});

// 派活 v2 P1：取消（只对 running 有意义；8103 负责 taskkill /T，控制中心不自己杀进程）
ipcMain.handle('control:dispatch-cancel', async (_event, id) => {
  const tid = String(id == null ? '' : id).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(tid)) return { ok: false, error: 'bad_id' };
  const token = readOrCreatePetControlToken();
  const body = JSON.stringify({ taskId: tid });
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = http.request({
        host: '127.0.0.1', port: 8103,
        path: '/dispatch/cancel', method: 'POST',
        headers: Object.assign({
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        }, token ? { 'X-Pet-Token': token } : {}),
        timeout: 8000,
      }, (res) => {
        let s = '';
        res.on('data', (c) => { s += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(s); } catch (e) { json = null; }
          if (res.statusCode >= 200 && res.statusCode < 300 && json) return done({ ok: true, result: json, status: res.statusCode });
          const msg = (json && (json.error || json.message)) ? String(json.error || json.message) : ('HTTP ' + res.statusCode + ' ' + s.slice(0, 160));
          done({ ok: false, error: msg, status: res.statusCode, body: json });
        });
      });
      req.on('error', (e) => done({ ok: false, error: '桌宠没在运行（8103 连不上）：' + e.message }));
      req.setTimeout(8000, () => { try { req.destroy(); } catch (e) { /* 已断开 */ } done({ ok: false, error: '8103 取消失败超时' }); });
      req.write(body);
      req.end();
    } catch (e) { done({ ok: false, error: String((e && e.message) || e) }); }
  });
});

// 派活 v2 B9：重试。只有 failed + attempted=false（spawn 同步失败）才允许；
// /dispatch 的响应会一直挂到任务结束，所以这里只等 700ms 确认「已派出」，
// 连接继续留着（提前 destroy 会被服务端判 unknown）。
ipcMain.handle('control:dispatch-retry', async (_event, payload) => {
  const task = payload && payload.task;
  const P = require('./js/core/dispatch-retry-policy.js');
  if (!P.canRetry(task)) return { ok: false, error: P.retryBlockedReason(task) };
  const taskId = P.makeRetryTaskId();
  const body = JSON.stringify(P.buildRetryBody(task, { taskId, requestId: taskId }));
  const token = readOrCreatePetControlToken();
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = http.request({
        host: '127.0.0.1', port: 8103,
        path: '/dispatch', method: 'POST',
        headers: Object.assign({
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        }, token ? { 'X-Pet-Token': token } : {}),
      }, (res) => {
        let s = '';
        res.on('data', (c) => { s += c; });
        res.on('end', () => {
          // 任务已经跑完（很快失败/很快完成）— 把结果也带回去，UI 可立即刷新
          done({ ok: true, taskId, finished: true, status: res.statusCode, result: s.slice(0, 400) });
        });
      });
      req.on('error', (e) => done({ ok: false, error: '桌宠没在运行（8103 连不上）：' + e.message }));
      req.write(body);
      req.end();
      setTimeout(() => done({ ok: true, taskId, accepted: true }), 700);
    } catch (e) { done({ ok: false, error: String((e && e.message) || e) }); }
  });
});

// 派活续聊（2026-11-23）：父任务终态 + 有 sessionId 才能续；判定与按钮显隐同源
// （js/core/dispatch-followup-policy.js，渲染层也加载同一份）。
// /dispatch/followup 的响应会一直挂到子任务结束（和 /dispatch 一样），所以这里只等 8s：
//   · 8s 内拿到 4xx/5xx → 把原因交回 UI；
//   · 8s 内拿到 200 → 子任务已经结束，带回 sessionReused/sessionMismatch/fallback；
//   · 8s 没回 → 只回「已派出」，**不 destroy 连接**（提前断会被服务端判 unknown/disconnect）。
ipcMain.handle('control:dispatch-followup', async (_event, payload) => {
  const P = require('./js/core/dispatch-followup-policy.js');
  const parentId = String(payload && payload.taskId || '').trim();
  const task = String(payload && payload.task || '').trim();
  const parent = payload && payload.parent;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(parentId)) return { ok: false, error: 'bad_id' };
  const blocked = P.followupBlockedReason(Object.assign({}, parent, { taskId: parentId }));
  if (blocked) return { ok: false, error: blocked, blocked: true };
  const newTaskId = P.makeFollowupTaskId();
  const built = P.buildFollowupRequest(parentId, task, newTaskId);
  if (!built.ok) {
    const hint = built.error === 'empty_task' ? '先写一句要接着做什么' : '';
    return { ok: false, error: built.error, hint, blocked: true };
  }
  const body = JSON.stringify(built.body);
  const token = readOrCreatePetControlToken();
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = http.request({
        host: '127.0.0.1', port: 8103,
        path: '/dispatch/followup', method: 'POST',
        headers: Object.assign({
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        }, token ? { 'X-Pet-Token': token } : {}),
      }, (res) => {
        let s = '';
        res.on('data', (c) => { s += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(s); } catch (e) { json = null; }
          if (res.statusCode >= 200 && res.statusCode < 300 && json) {
            return done({
              ok: true, accepted: true, finished: true, status: res.statusCode,
              taskId: String(json.taskId || newTaskId), result: json,
            });
          }
          const msg = json && (json.detail || json.error)
            ? String(json.detail || json.error)
            : ('HTTP ' + res.statusCode + ' ' + s.slice(0, 160));
          done({ ok: false, error: msg, status: res.statusCode, body: json, taskId: newTaskId });
        });
      });
      req.on('error', (e) => done({ ok: false, error: '桌宠没在运行（8103 连不上）：' + e.message }));
      // 8s 窗口：只把「已派出」交回 UI，连接继续留着等子任务跑完（服务端要靠它判断线）
      setTimeout(() => done({ ok: true, accepted: true, pending: true, taskId: newTaskId }), 8000);
      req.write(body);
      req.end();
    } catch (e) { done({ ok: false, error: String((e && e.message) || e) }); }
  });
});

app.whenReady().then(createControlWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 仅测试/工具用途：Electron 主进程入口本身不使用导出（真实调用点是上面的 IPC）。
// _probe/test-model-capability-write.cjs 用 electron 桩加载本文件，直接调纯函数，
// 避免为了可测性再造一份写入实现（两份实现必然漂移）。
module.exports = { MODEL_PARAM_KEYS, normalizeModelParamValue, applyModelParamWrite };
