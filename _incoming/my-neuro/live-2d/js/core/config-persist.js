// js/core/config-persist.js —— 配置「写盘 → 热重载 → 读回」的唯一入口（2026-11-17 六十三轮）
//
// 为什么收敛：
//   项目里长期把「写盘成功」当成「已生效」，但宿主是常驻进程 —— 它只在启动时和收到
//   POST /reload-config 时才读 config.json。写盘成功而宿主没重载，用户看到「已保存」，
//   运行中的她还是旧 key/旧开关。2026-11-17 的「UI 换 API key 没用」就是这么发生的：
//   /reload-config 用 getAllWindows()[0] 打到没有 reloadConfig 的字幕窗，却仍返回
//   success:true —— 假成功比报错更坏，因为没人会去重启。
//
// 所以这里把三件事绑成一次调用，只有三步全过才 ok:true：
//   ① 原子写盘（备份 .bak → 同目录 .tmp → rename → parse 回读 + 顶层键数校验）
//   ② POST 127.0.0.1:3002/reload-config，要求响应 success === true
//   ③ 从磁盘读回，逐键比对本次真正写入的值（默认比对全部叶子键，也可只比 verifyKeys）
// 任何一步失败都返回 ok:false 并带原因；调用方不得再把「写盘成功」自行包装成成功。
//
// 仍不经过本模块的独立路径（有意保留，不要为了「统一」硬塞进来）：
//   · 8103 /quiet：静默开关的唯一真源在宿主进程（petbridge/vts-server.mjs），它自己
//     写 config 并立即改运行时状态。控制中心只是转发命令，不碰 config.json —— 否则
//     会出现「面板写盘、运行时不认」的双源。跨进程且语义是「命令」而不是「配置写入」，
//     收进来会强迫控制中心承担宿主内部状态的职责。
//   · 宿主自身启动时读配置、WebUI/手机遥控直接 POST 宿主端点：它们本来就在宿主进程内。
//   · 动作/表情映射（emotion_actions.json 等）是另一类文件，写入方各自带 reload 调用。
//
// 用法：
//   const { saveAndApply } = require('./js/core/config-persist');
//   const r = await saveAndApply(configPath, { tts: { enabled: false } }, { mode: 'merge' });
//   if (!r.ok) throw new Error(r.error);
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3002;
const DEFAULT_RELOAD_PATH = '/reload-config';
const DEFAULT_TIMEOUT_MS = 3000;

function errMsg(e) {
  return (e && e.message) || String(e);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// merge 模式用：对象逐层合并，数组/原始值整体替换。
// 不原地改 base/patch —— 调用方送进来的可能是渲染层对象，回写过程不该产生副作用。
function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch;
  const out = isPlainObject(base) ? Object.assign({}, base) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value)) out[key] = deepMerge(out[key], value);
    else out[key] = value;
  }
  return out;
}

// 内部一律用「段数组」定位，不拼点分字符串：config 里存在字面量带点的键
// （例如 _deprecated."tools.enabled"），用 split('.') 会把它拆成两层而误报。
function getAtPath(obj, segments) {
  let cur = obj;
  for (const part of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// 「这个路径在对象里真的存在」和「读到的值是 undefined」是两件事：
// verifyKeys 点名要校验的键如果压根没写进去，必须报出来，不能拿 undefined === undefined 混过去。
function hasAtPath(obj, segments) {
  let cur = obj;
  for (const part of segments) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return false;
    cur = cur[part];
  }
  return true;
}

// 展示用：键名本身带点时加引号，避免和层级分隔符混淆
function formatPath(segments) {
  return segments.map((part) => /[.\s]/.test(part) ? JSON.stringify(part) : part).join('.');
}

// 默认校验范围 = 本次真正写进去的全部叶子键。
// 只比「关键字段」会漏掉写丢的普通字段；全量叶子键的比对成本就是一次 JSON.parse + 遍历。
function collectLeafPaths(obj, prefix, out) {
  const segments = prefix || [];
  const paths = out || [];
  if (!isPlainObject(obj)) {
    if (segments.length) paths.push(segments);
    return paths;
  }
  const keys = Object.keys(obj);
  // 空对象本身也是一个有意义的取值（例如 vision.vision_model = {}），丢了要能发现
  if (!keys.length) {
    if (segments.length) paths.push(segments);
    return paths;
  }
  for (const key of keys) collectLeafPaths(obj[key], segments.concat(key), paths);
  return paths;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

// 密钥类字段一律不把原值带回 IPC；裸 "key" 也按敏感处理（宁可误脱敏，不可漏）
const SENSITIVE_PATH = /(api[_-]?key|secret|token|password|passwd|credential|authorization|cookie|(?:^|[.\-_])key(?:$|[.\-_]))/i;

// mismatches 会经 IPC 回渲染层，绝不把密钥原值带出去；长文本也压成长度。
function describeValue(path, value) {
  if (SENSITIVE_PATH.test(String(path))) return '<已脱敏>';
  if (value === undefined) return '<缺失>';
  if (typeof value === 'string') return value.length > 80 ? `<字符串 ${value.length} 字符>` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (Array.isArray(value)) return `<数组 ${value.length} 项>`;
  if (isPlainObject(value)) return `<对象 ${Object.keys(value).length} 键>`;
  return `<${typeof value}>`;
}

/**
 * 写配置 + 回读校验（从 control-main.js 抽出的同一套策略，别在别处复制第二份）
 *
 * 做三件事：
 *   ① 备份原文件（.bak，滚动一次；备份失败不阻塞主流程）
 *   ② 原子写（先写同目录 .tmp 再 rename —— 同分区 rename 是原子替换，
 *      避免「写一半被 CRASH 留下半个 JSON」）
 *   ③ 回读校验（parse 一遍 + 比对顶层键数量；序列化丢 undefined 等会在这里暴露）
 *
 * 注意：这里只管「文件写对了」，不管宿主有没有读到 —— 后者是 saveAndApply 的职责。
 *
 * @returns {{ok:boolean, keys?:number, bytes?:number, error?:string}}
 */
function writeJsonVerified(filePath, obj) {
  // 唯一 tmp 名（2026-11-22）：旧实现固定 `.tmp`，主进程与控制中心/其它入口
  // 同时写同一份 config 时会在同一个临时文件上互相覆盖/rename 打架。
  // 单进程里 patchVerified 是同步的不会交错，但跨进程仍可能撞名。
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  let serialized;
  try {
    serialized = JSON.stringify(obj, null, 2) + '\n';
  } catch (e) {
    return { ok: false, error: '序列化失败：' + errMsg(e) };
  }
  try {
    try {
      if (fs.existsSync(filePath)) fs.copyFileSync(filePath, filePath + '.bak');
    } catch (e) { /* 备份失败不阻塞主流程 */ }
    fs.writeFileSync(tmp, serialized, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // rename 失败时 .tmp 会留在原地；清理掉，避免下次误把它当成半成品配置
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, error: errMsg(e) };
  }
  let readback;
  try {
    readback = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return { ok: false, error: '回读解析失败（文件可能损坏）：' + errMsg(e) };
  }
  const wantKeys = Object.keys(obj || {}).length;
  const gotKeys = Object.keys(readback || {}).length;
  if (gotKeys < wantKeys) {
    return { ok: false, error: `回读少了 ${wantKeys - gotKeys} 个顶层键（写入 ${wantKeys}，读回 ${gotKeys}）`, wantKeys, gotKeys };
  }
  return { ok: true, keys: gotKeys, bytes: serialized.length };
}

/**
 * 读最新配置 → 原地改目标键 → 原子写 + 回读校验（2026-11-18 §69 B1）
 *
 * 为什么要有它：宿主里到处是「读了 config → 改一个键 → 整份写回」。如果那份 config
 * 是几小时前读的快照（托盘就是这么干的），一次点击就会把别人这期间的改动整体抹掉。
 * 这个函数每次都从磁盘重新读，调用方只描述「要改什么」，不持有配置对象。
 *
 * 本模块保持无日志、无副作用声明：失败只用 stage 标出哪一步，发声由调用方决定。
 *
 * @param {string} filePath
 * @param {(cfg:object)=>void} mutate  在刚读到的配置上改键（原地）
 * @returns {{ok:boolean, stage?:'read'|'mutate'|'write', error?:string, keys?:number, bytes?:number}}
 */
function patchVerified(filePath, mutate) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return { ok: false, stage: 'read', error: '读不到当前配置：' + errMsg(e) };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, stage: 'read', error: '当前配置不是普通对象（可能被写坏了）' };
  }
  try {
    mutate(cfg);
  } catch (e) {
    return { ok: false, stage: 'mutate', error: '改配置时出错：' + errMsg(e) };
  }
  const wrote = writeJsonVerified(filePath, cfg);
  if (wrote.ok) return wrote;
  return { ok: false, stage: 'write', error: wrote.error, keys: wrote.keys };
}

/**
 * 通知宿主重读 config.json（POST /reload-config）
 *
 * 成功判据只有一条：响应体 JSON 的 success === true。
 * 连接被拒（宿主没起）、超时、非 JSON、success:false 一律算失败 —— 这正是
 * 「窗口打错却假绿」事故的反面。调用方可以据此决定是否提示重启。
 *
 * @param {{host?:string, port?:number, path?:string, timeoutMs?:number, payload?:object}} [opts]
 * @returns {Promise<{success:boolean, message:string, status?:number, code?:string}>}
 */
function notifyHostReload(opts) {
  const o = opts || {};
  const host = o.host || DEFAULT_HOST;
  const port = Number(o.port) > 0 ? Number(o.port) : DEFAULT_PORT;
  const pathname = o.path || DEFAULT_RELOAD_PATH;
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_TIMEOUT_MS;
  let body;
  try {
    body = JSON.stringify(o.payload || {});
  } catch (e) {
    return Promise.resolve({ success: false, message: '请求体序列化失败：' + errMsg(e) });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const request = http.request({
      hostname: host,
      port,
      path: pathname,
      method: 'POST',
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      // 宿主中途断开时 'end' 不会来；不兜这一下 saveAndApply 会一直挂着
      response.on('close', () => {
        if (!response.complete) finish({ success: false, message: '宿主在响应完成前断开连接' });
      });
      response.on('error', (e) => finish({ success: false, message: errMsg(e), code: e && e.code }));
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* 非 JSON 响应按失败处理 */ }
        const success = Boolean(parsed && parsed.success === true);
        let message;
        if (parsed && parsed.message !== undefined) message = String(parsed.message);
        else if (success) message = '配置已重新加载';
        else message = `宿主返回无法解析的响应（HTTP ${response.statusCode}）：` + String(text).slice(0, 120);
        finish({ success, message, status: response.statusCode });
      });
    });
    request.on('timeout', () => request.destroy(new Error(`热重载请求超时（${timeoutMs}ms）`)));
    request.on('error', (e) => finish({ success: false, message: errMsg(e), code: e && e.code }));
    request.end(body);
  });
}

/**
 * 保存配置并让它真正生效（写盘 → 热重载 → 读回校验）
 *
 * @param {string} configPath            config.json 绝对路径
 * @param {object} patchOrFullConfig     mode=merge 时只需送要改的键；mode=full 时送整份
 * @param {object} [opts]
 * @param {'merge'|'full'} [opts.mode]   merge（默认，深合并）| full（整份替换）
 * @param {string[]} [opts.verifyKeys]   只校验这些点分路径（默认校验本次写入的全部叶子键）
 * @param {{host?:string, port?:number, path?:string, timeoutMs?:number, payload?:object}} [opts.reload]
 *                                       宿主重载端点（默认 127.0.0.1:3002/reload-config）
 * @param {(filePath:string, written:object)=>void|Promise<void>} [opts.beforeReadback]
 *                                       测试注入点：在写盘+重载之后、读回之前动手脚，
 *                                       用于复现「写后文件被外部改掉」的读回不一致
 * @returns {Promise<{ok:boolean, wrote:boolean, reload:{success:boolean, message:string},
 *                    readback:{ok:boolean, mismatches:Array}, error?:string}>}
 */
async function saveAndApply(configPath, patchOrFullConfig, opts) {
  const o = opts || {};
  const result = {
    ok: false,
    wrote: false,
    reload: { success: false, message: '未执行' },
    readback: { ok: false, mismatches: [] },
  };
  const fail = (error, extra) => {
    result.error = error;
    if (extra) Object.assign(result, extra);
    return result;
  };

  if (!configPath || typeof configPath !== 'string') return fail('configPath 缺失或不是字符串');
  if (!isPlainObject(patchOrFullConfig)) return fail('要写入的配置必须是普通对象');

  const mode = o.mode === 'full' ? 'full' : 'merge';
  let target;
  if (mode === 'merge') {
    let base = {};
    if (fs.existsSync(configPath)) {
      try {
        base = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (e) {
        // 不能拿「读不出来」当空白基线去合并：那等于用一份残缺配置覆盖用户现有配置
        return fail('现有配置无法解析，拒绝 merge（避免用残缺基线覆盖）：' + errMsg(e));
      }
      if (!isPlainObject(base)) return fail('现有配置不是 JSON 对象，拒绝 merge');
    }
    target = deepMerge(base, patchOrFullConfig);
  } else {
    target = patchOrFullConfig;
  }

  // ① 原子写盘
  const write = writeJsonVerified(configPath, target);
  if (!write.ok) {
    result.reload = { success: false, message: '未执行（写盘失败）' };
    result.readback = { ok: false, mismatches: [], skipped: true, error: '未执行（写盘失败）' };
    return fail('写盘失败：' + (write.error || '未知原因'));
  }
  result.wrote = true;

  // 校验基线用「序列化后的意图」而不是内存对象：undefined/NaN/Date 在 JSON 里的真实形态
  // 才是磁盘上应该出现的东西，否则会拿内存里的 undefined 跟磁盘上的缺失做无意义比对。
  let expectedDoc;
  try {
    expectedDoc = JSON.parse(JSON.stringify(target));
  } catch (e) {
    return fail('写入内容的序列化结果无法解析：' + errMsg(e));
  }

  // ② 通知宿主热重载（写盘后立刻做；宿主没重载等于没生效）
  const reload = await notifyHostReload(o.reload || {});
  result.reload = { success: reload.success === true, message: String(reload.message || '') };
  if (reload.status !== undefined) result.reload.status = reload.status;
  if (reload.code !== undefined) result.reload.code = reload.code;

  // 测试注入点：在写盘+重载之后、读回之前动手脚（生产调用方不传）
  if (typeof o.beforeReadback === 'function') {
    try {
      await o.beforeReadback(configPath, target);
    } catch (e) {
      result.hookError = errMsg(e);
    }
  }

  // ③ 从磁盘读回，逐键比对本次写入的值
  let readbackDoc;
  try {
    readbackDoc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    result.readback = { ok: false, mismatches: [{ path: '<file>', reason: '回读解析失败' }], error: errMsg(e) };
    return fail('写盘后回读解析失败：' + errMsg(e));
  }
  // 显式 verifyKeys 是注册表里的点分路径；默认全量叶子键用段数组，避免字面量带点的键被拆错
  const verifyTargets = Array.isArray(o.verifyKeys) && o.verifyKeys.length
    ? o.verifyKeys.map(String).map((key) => ({ segments: key.split('.'), label: key }))
    : collectLeafPaths(expectedDoc).map((segments) => ({ segments, label: formatPath(segments) }));
  const mismatches = [];
  for (const check of verifyTargets) {
    const expected = getAtPath(expectedDoc, check.segments);
    const actual = getAtPath(readbackDoc, check.segments);
    if (expected === undefined && !hasAtPath(expectedDoc, check.segments)) {
      // 点名要校验的键根本没写进去（调用方列错/上游把值丢了）：不能当通过
      mismatches.push({ path: check.label, reason: 'missing-in-write', expected: '<缺失>', actual: describeValue(check.label, actual) });
      continue;
    }
    if (deepEqual(expected, actual)) continue;
    mismatches.push({
      path: check.label,
      reason: actual === undefined ? 'missing' : 'value',
      expected: describeValue(check.label, expected),
      actual: describeValue(check.label, actual),
    });
  }
  result.readback = { ok: mismatches.length === 0, mismatches };
  if (!result.readback.ok) {
    return fail(`读回校验失败：${mismatches.length} 处与写入值不一致`);
  }

  // 三步全过才算生效 —— 写盘成功、但宿主没重载/没读对，都不允许 ok:true
  if (!result.reload.success) {
    return fail('热重载失败（配置已写盘，宿主仍在使用旧配置）：' + (result.reload.message || '未知原因'));
  }
  result.ok = true;
  return result;
}

// ── 宿主主进程的整份配置保存（main.js `ipcMain.handle('save-config')`）──────────
//
// 为什么单独抽出来：旧 handler 里「写通讯录 + 写 config」是一段不可单测的胶水 ——
// persistProviderStore 的返回值被忽略、config 裸写无回读，最后无条件弹「配置已成功保存」。
// 通讯录写失败时用户以为新 key 已生效，重启后还是旧 key（同族假成功）。
//
// 本函数只做三件事，任何一步失败都 ok:false：
//   ① 写前备份 config.json → .bak（旧 handler 的既有行为，保留；失败不阻塞）
//   ② 先落通讯录（persistProvider 注入，默认调用方传 persistProviderStore）——
//      它返回 storeSaveError / storeWritable:false / ok:false 都算失败，**不写 config**，
//      避免出现「config 记了新 provider、llm_providers.json 还是旧 key」的半套状态
//   ③ writeJsonVerified 原子写 config（.bak → .tmp → rename → 回读解析/键数校验），
//      再整份回读比对一次（值级一致，防「写进去但内容被外部改掉」）
//
// 注入 persistProvider 而不是直接 require llm-provider-store：后者反过来依赖本模块的
// writeJsonVerified，顶部互相 require 会形成环形依赖；注入也让它可单测（无需真实凭据文件）。
//
// persistProvider(baseDir, configPath, config, { writeBack: false }) 的返回约定：
//   · { ok: true, ... }                                   —— 明确成功
//   · { ok: false, error }                                —— 明确失败
//   · { storeSaveError: string }                          —— persistProviderStore 的写盘失败
//   · { storeWritable: false }                            —— 通讯录文件损坏，已拒绝写入
//   · 其他对象（无上述失败信号）                          —— 视为成功（例如没改动、没写盘）
//   · 非对象 / undefined                                  —— 无法确认是否落盘，按失败处理
function describeProviderFailure(providerResult) {
  if (!providerResult || typeof providerResult !== 'object') {
    return '通讯录处理未返回结果，无法确认凭据是否落盘';
  }
  if (providerResult.ok === false) return String(providerResult.error || '通讯录写盘失败');
  if (providerResult.storeSaveError) return String(providerResult.storeSaveError);
  if (providerResult.storeWritable === false) return '通讯录文件损坏，已拒绝写入（避免覆盖用户数据）';
  return '';
}

/**
 * 宿主主进程整份配置保存（写通讯录 + 写 config + 回读校验），不弹任何对话框。
 *
 * @param {object} opts
 * @param {string} opts.configPath       config.json 绝对路径
 * @param {string} [opts.configBaseDir]  llm_providers.json 所在目录（默认 configPath 的目录）
 * @param {object} opts.configData       渲染层送来的整份配置（不会被原地修改）
 * @param {(baseDir:string, cfgPath:string, config:object, options:{writeBack:boolean})=>object} opts.persistProvider
 *        通讯录写入函数（main.js 传 llm-provider-store.persistProviderStore）
 * @returns {{ok:boolean, wrote:boolean, stage:string, file?:string, keys?:number, bytes?:number,
 *            error?:string, backup:{ok:boolean, path:string, error?:string, missing?:boolean},
 *            provider:{ok:boolean, error?:string}, readback?:{ok:boolean}}}
 */
function saveHostConfig(opts) {
  const o = opts || {};
  const configPath = o.configPath;
  const persistProvider = o.persistProvider;
  const result = {
    ok: false,
    wrote: false,
    stage: 'input',
    file: typeof configPath === 'string' ? configPath : null,
    backup: { ok: false, path: typeof configPath === 'string' ? configPath + '.bak' : '' },
    provider: { ok: false },
  };
  const fail = (stage, error) => {
    result.stage = stage;
    result.error = error;
    return result;
  };

  if (!configPath || typeof configPath !== 'string') return fail('input', 'configPath 缺失或不是字符串');
  if (!isPlainObject(o.configData)) return fail('input', '要保存的配置必须是普通对象');
  if (typeof persistProvider !== 'function') return fail('input', 'persistProvider 必须是函数');
  const configBaseDir = o.configBaseDir || path.dirname(configPath);

  // ① 写前备份（旧 handler 的 .bak 逻辑原样保留；失败不阻塞主流程）
  try {
    if (fs.existsSync(configPath)) {
      fs.copyFileSync(configPath, result.backup.path);
      result.backup.ok = true;
    } else {
      // 首次创建：没有旧文件可备份，不算失败
      result.backup.ok = true;
      result.backup.missing = true;
    }
  } catch (e) {
    result.backup.error = errMsg(e);
  }

  // 克隆：persistProviderStore 会原地注入/清洗字段，不能污染渲染层送来的对象
  let prepared;
  try {
    prepared = JSON.parse(JSON.stringify(o.configData));
  } catch (e) {
    return fail('input', '配置无法序列化（可能含循环引用）：' + errMsg(e));
  }
  if (!isPlainObject(prepared)) return fail('input', '配置序列化后不是普通对象');

  // ② 通讯录先落盘：失败即中止，config.json 一个字节都不动
  let providerResult;
  try {
    providerResult = persistProvider(configBaseDir, configPath, prepared, { writeBack: false });
  } catch (e) {
    const error = '通讯录处理异常，已中止保存（config.json 未改动）：' + errMsg(e);
    result.provider = { ok: false, error: errMsg(e) };
    return fail('provider', error);
  }
  const providerError = describeProviderFailure(providerResult);
  if (providerError) {
    result.provider = { ok: false, error: providerError };
    return fail('provider', '通讯录写盘失败，已中止保存（config.json 未改动）：' + providerError);
  }
  result.provider = {
    ok: true,
    migrated: Boolean(providerResult.migrated),
    storeChanged: Boolean(providerResult.storeChanged),
  };
  // llm_providers 是运行期注水键，不落 config.json（与旧 handler 一致）
  try { delete prepared.llm_providers; } catch (e) { /* 不是普通对象时上面已拦，这里兜底 */ }

  // ③ 原子写 + 回读解析/顶层键数校验
  const write = writeJsonVerified(configPath, prepared);
  if (!write.ok) {
    return fail('config', '配置写盘失败：' + (write.error || '未知原因'));
  }
  result.keys = write.keys;
  result.bytes = write.bytes;

  // ④ 整份值级回读：writeJsonVerified 只比顶层键数，这里再确认内容没有被外部改掉
  let readbackDoc;
  try {
    readbackDoc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return fail('readback', '配置写盘后回读解析失败：' + errMsg(e));
  }
  const expectedDoc = JSON.parse(JSON.stringify(prepared));
  if (!deepEqual(expectedDoc, readbackDoc)) {
    return fail('readback', '配置回读内容与写入值不一致（磁盘可能被外部改动）');
  }

  result.ok = true;
  result.wrote = true;
  result.stage = 'done';
  result.readback = { ok: true };
  return result;
}

module.exports = {
  saveAndApply,
  saveHostConfig,
  notifyHostReload,
  writeJsonVerified,
  patchVerified,
};
