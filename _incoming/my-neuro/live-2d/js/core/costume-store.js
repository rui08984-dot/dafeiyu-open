// costume-store.js —— 换装存档的唯一兼容写入器（2026-11-23 B7）
//
// 背景（B7「换装双写」）：同一个 localStorage key `pet.assets.v1` 有两个写入者：
//   · pet-runtime/desktop/asset-toggles.mjs（打包进 build/petbody.js，window.petAssets）
//     记录形状 {version, updatedAt, preset, values}
//   · js/ui/ui-controller.js 的 saveAssetState
//     记录形状 {version, at, values} —— 没有 preset、字段名也不对
// 结果：走 ui-controller 的换装（快捷面板/驱动换装）会把 asset-toggles 写的 preset
// 覆盖掉，重启后 currentPresetName 变成「自定义」，预设高亮丢失。
//
// 修法：
//   1) ui-controller 优先调用打包模块自己的 saveAssetsState（唯一写入者）；
//   2) 拿不到时走本模块：读旧记录 → 补齐 preset（能算就算）→ 单次 setItem →
//      回读校验；任何一步失败就把旧原文写回（或删除），绝不留半截新记录。
// 纯逻辑，不 require Electron/DOM，可单测。

'use strict';

const ASSETS_STORAGE_KEY = 'pet.assets.v1';
const STORAGE_VERSION = 1;
const PRESET_TOLERANCE = 0.02;

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

/** 存档值规范化：只接受有限数值/布尔；其它键丢弃（和 asset-toggles 的 sanitize 同口径）。 */
function normalizeValues(values) {
    if (!isPlainObject(values)) return null;
    const out = {};
    for (const [key, raw] of Object.entries(values)) {
        let n;
        if (typeof raw === 'boolean') n = raw ? 1 : 0;
        else if (typeof raw === 'number' && Number.isFinite(raw)) n = raw;
        else continue;
        out[String(key)] = clamp01(n);
    }
    return Object.keys(out).length ? out : null;
}

/** 解析存档原文；坏 JSON/版本不符/没有 values 一律返回 null。 */
function parseRecord(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    let record;
    try { record = JSON.parse(raw); } catch (_) { return null; }
    if (!isPlainObject(record)) return null;
    if (record.version !== STORAGE_VERSION) return null;
    const values = normalizeValues(record.values);
    if (!values) return null;
    return {
        version: STORAGE_VERSION,
        updatedAt: Number(record.updatedAt) || 0,
        preset: typeof record.preset === 'string' ? record.preset : '',
        values,
    };
}

/** 预设覆盖项 → 参数值（cycle 用档位 id/中文名，toggle 用 on/off）。 */
function presetTargetValues(preset, assets) {
    const values = {};
    for (const asset of assets) values[asset.id] = clamp01(Number(asset.default) || 0);
    for (const [id, spec] of Object.entries((preset && preset.assets) || {})) {
        const asset = assets.find((entry) => entry.id === id
            || (entry.aliases || []).includes(id)
            || entry.label === id);
        if (!asset) continue;
        if (asset.kind === 'cycle') {
            const opts = asset.options || [];
            const hit = opts.find((o) => o.id === spec || o.label === spec);
            if (hit) values[asset.id] = clamp01(Number(hit.value) || 0);
        } else {
            values[asset.id] = spec ? 1 : 0;
        }
    }
    return values;
}

/**
 * 与 asset-toggles detectPreset 同口径：全部资产在容差内匹配某预设才返回该预设 id。
 * @returns {string} preset id，或 ''（自定义）
 */
function detectPresetId(values, presets, assets, tolerance = PRESET_TOLERANCE) {
    if (!isPlainObject(values) || !Array.isArray(presets) || !Array.isArray(assets) || !assets.length) return '';
    const tol = Math.max(0, Number(tolerance) || PRESET_TOLERANCE);
    for (const preset of presets) {
        let expected;
        try { expected = presetTargetValues(preset, assets); } catch (_) { continue; }
        let matched = true;
        for (const asset of assets) {
            const actual = Number.isFinite(values[asset.id]) ? values[asset.id] : (Number(asset.default) || 0);
            if (Math.abs(actual - expected[asset.id]) > tol) { matched = false; break; }
        }
        if (matched) return String(preset.id || '');
    }
    return '';
}

function safeGet(storage, key) {
    try { return storage.getItem(key); } catch (_) { return undefined; }
}

function restoreRaw(storage, key, raw) {
    try {
        if (raw === undefined) return safeGet(storage, key) === null || safeGet(storage, key) === undefined;
        if (raw === null) {
            if (typeof storage.removeItem === 'function') storage.removeItem(key);
        } else {
            storage.setItem(key, raw);
        }
    } catch (_) { /* 回滚写入失败 → 下面用回读判断是否已经原样 */ }
    const current = safeGet(storage, key);
    if (raw === undefined || raw === null) return current === null || current === undefined;
    return current === raw;
}

/**
 * 写一份换装存档。
 *
 * 校验顺序：storage 接口 → values 非空合法 → 读旧记录（失败不阻断，只当没有）→
 * 单次 setItem → 回读逐字比对。失败时把旧原文写回（或删除），返回 rolledBack。
 *
 * @param {object} storage    localStorage 兼容对象（getItem/setItem/removeItem）
 * @param {object} options
 * @param {object} options.values        当前资产值 {id:number|boolean}
 * @param {Array}  [options.presets]     预设表（给了才重算 preset）
 * @param {Array}  [options.assets]      资产表（给了才重算 preset）
 * @param {string} [options.preset]      显式 preset；undefined = 自动/沿用旧值
 * @param {number} [options.now]
 * @param {string} [options.key]
 * @returns {{saved: boolean, reason?: string, record?: object, rolledBack?: boolean, error?: string}}
 */
function writeAssetsState(storage, options = {}) {
    const key = options.key || ASSETS_STORAGE_KEY;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
        return { saved: false, reason: 'storage-unavailable' };
    }
    const values = normalizeValues(options.values);
    if (!values) return { saved: false, reason: 'invalid-values' };

    const previousRaw = safeGet(storage, key);
    const previous = parseRecord(previousRaw);

    let preset;
    if (typeof options.preset === 'string') preset = options.preset;
    else if (Array.isArray(options.presets) && Array.isArray(options.assets)) {
        preset = detectPresetId(values, options.presets, options.assets);
    } else {
        preset = previous ? previous.preset : '';
    }

    const record = {
        version: STORAGE_VERSION,
        updatedAt: Number(options.now) || Date.now(),
        preset,
        values,
    };
    const payload = JSON.stringify(record);

    try {
        storage.setItem(key, payload);
    } catch (error) {
        const rolledBack = restoreRaw(storage, key, previousRaw === undefined ? null : previousRaw);
        return { saved: false, reason: 'write-failed', error: String((error && error.message) || error), rolledBack };
    }

    const readBack = safeGet(storage, key);
    if (readBack !== payload) {
        const rolledBack = restoreRaw(storage, key, previousRaw === undefined ? null : previousRaw);
        return { saved: false, reason: 'verify-failed', rolledBack };
    }

    return { saved: true, record };
}

/** 读存档（规范化后）；没有/坏记录返回 null。 */
function readAssetsState(storage, key = ASSETS_STORAGE_KEY) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    const raw = safeGet(storage, key);
    return parseRecord(raw);
}

module.exports = {
    ASSETS_STORAGE_KEY,
    STORAGE_VERSION,
    PRESET_TOLERANCE,
    normalizeValues,
    parseRecord,
    presetTargetValues,
    detectPresetId,
    writeAssetsState,
    readAssetsState,
};
