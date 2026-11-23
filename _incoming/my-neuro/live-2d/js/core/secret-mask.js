// js/core/secret-mask.js —— 插件配置凭据的掩码 / 回填（唯一实现）
//
// 为什么需要这一层：
//   live-2d/control-main.js 的 control:list-plugins 以前把整份 plugin_config.json 原样送进
//   渲染层（含 web-search 的真实 tavily_api_key），control:save-plugin-config 又是整份覆盖写。
//   WebUI 侧（webui/plugin_manager.py）早已做「GET 只回掩码 / 保存回填原值」，这里把同一套
//   规则抽成纯函数，Electron 链路直接复用，避免两处各写一遍后漂移。
//
// 与 WebUI 的规则逐条对齐（plugin_manager.py L96-L126 / L134-L222）：
//   · 敏感键：键名以 api_key / api-key / apikey / secret / token / password / passwd /
//     cookie / authorization / credential 结尾（大小写不敏感）；
//     ptt_key 只以 _key 结尾不含 api，不命中；max_tokens 是 tokens 不命中；secret_santa 不命中。
//   · 掩码格式：'***' + 末 4 位；长度 ≤ 8 只回 '***'（太短露末 4 位等于泄露大半）。
//   · 空串 / '***xxxx' / 全星号 = 客户端没提交新值 → 保留磁盘原值。
//   · 只在 plugin_config.json 这条链路生效；config.json / llm_providers.json 有各自机制。
//
// 本模块是纯函数（无 fs / 无 electron），供 control-main.js 与 _probe 测试直接 require。

'use strict';

const SECRET_KEY_RE = /(api[_-]?key|apikey|secret|token|password|passwd|cookie|authorization|credential)$/i;
const MASK_PREFIX = '***';
const MASK_MIN_LEN = 8; // ≤8 位只回 ***，否则「末 4 位」已经泄露大半

/** 键名是否属于凭据类（决定要不要掩码 / 回填）。 */
function isSecretKey(name) {
  return typeof name === 'string' && SECRET_KEY_RE.test(name);
}

/** 把凭据变成可展示串：***+末 4 位；太短则只回 ***。 */
function maskSecretText(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= MASK_MIN_LEN) return MASK_PREFIX;
  return MASK_PREFIX + text.slice(-4);
}

/** 空串 / ***xxxx / 全星号 都表示「客户端没提交新值」。 */
function isBlankOrMask(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return true;
  if (text.startsWith(MASK_PREFIX)) return true;
  return text.length >= 3 && /^\*+$/.test(text);
}

/** plugin_config.json 的 schema 节点：{title, type, default, value}。 */
function isSchemaNode(node) {
  return node !== null && typeof node === 'object' && !Array.isArray(node) &&
    Object.prototype.hasOwnProperty.call(node, 'value') &&
    (Object.prototype.hasOwnProperty.call(node, 'type') || Object.prototype.hasOwnProperty.call(node, 'title'));
}

function isPlainObject(node) {
  return node !== null && typeof node === 'object' && !Array.isArray(node);
}

// path 是键名/索引组成的数组；最终对外给的是点号连接的扁平路径（与 WebUI 的 masked_keys 同形）。
function maskWalk(node, key, path, maskedPaths) {
  if (Array.isArray(node)) {
    // 数组沿用父键名做敏感判定（与 WebUI 一致）；字符串数组逐项掩码，路径带索引。
    return node.map((item, index) => {
      const itemPath = path.concat(String(index));
      if (isSecretKey(key) && typeof item === 'string' && item) {
        maskedPaths.push(itemPath.join('.'));
        return maskSecretText(item);
      }
      return maskWalk(item, key, itemPath, maskedPaths);
    });
  }

  if (isPlainObject(node)) {
    // null 原型：配置里出现 "__proto__" 这类键时按普通键复制，不会改到原型链
    const result = Object.create(null);
    for (const [k, v] of Object.entries(node)) {
      if (k === 'fields' && isPlainObject(v)) {
        // 对象型配置组的子字段：字段名自己参与敏感判定
        const fields = Object.create(null);
        for (const [fk, fv] of Object.entries(v)) fields[fk] = maskWalk(fv, fk, path.concat(fk), maskedPaths);
        result[k] = fields;
      } else if (k === 'value' && isSchemaNode(node)) {
        // schema 节点的 value 属于同一个配置键，路径不再加一层 value
        result[k] = maskWalk(v, key, path, maskedPaths);
      } else {
        result[k] = maskWalk(v, k, path.concat(k), maskedPaths);
      }
    }
    if (isSchemaNode(node) && isSecretKey(key) && typeof node.value === 'string' && node.value) {
      maskedPaths.push((path.length ? path : [key]).join('.'));
    }
    return result;
  }

  if (typeof node === 'string' && isSecretKey(key) && node) {
    maskedPaths.push((path.length ? path : [key]).join('.'));
    return maskSecretText(node);
  }
  return node;
}

/**
 * 递归复制配置并掩码凭据（不修改入参）。
 *
 * @param {*} obj  插件配置（plugin_config.json 解析后的对象）
 * @returns {{ value: *, maskedKeys: string[] }} 掩码后的新结构 + 被掩码的点号路径（去重）
 */
function maskSecrets(obj) {
  const maskedPaths = [];
  const value = maskWalk(obj, null, [], maskedPaths);
  const maskedKeys = [...new Set(maskedPaths)];
  return { value, maskedKeys };
}

// 递归回填：incoming 是渲染层提交值，existing 是磁盘原值。
function restoreWalk(incoming, existing, key) {
  if (Array.isArray(incoming)) {
    const base = Array.isArray(existing) ? existing : [];
    return incoming.map((item, index) => restoreWalk(item, index < base.length ? base[index] : undefined, key));
  }

  if (isPlainObject(incoming)) {
    const base = isPlainObject(existing) ? existing : {};
    const baseFields = isPlainObject(base.fields) ? base.fields : {};
    const result = Object.create(null);
    for (const [k, v] of Object.entries(incoming)) {
      if (k === 'value' && isSchemaNode(incoming)) {
        result[k] = restoreWalk(v, base.value, key);
      } else if (k === 'fields' && isPlainObject(v)) {
        const fields = Object.create(null);
        for (const [fk, fv] of Object.entries(v)) fields[fk] = restoreWalk(fv, baseFields[fk], fk);
        result[k] = fields;
      } else {
        const next = restoreWalk(v, base[k], k);
        // 原配置里没有、提交的又是掩码/空串的敏感键：直接不落盘（绝不把 *** 写进文件）
        if (!(k in base) && isSecretKey(k) && typeof v === 'string' && isBlankOrMask(v)) continue;
        result[k] = next;
      }
    }
    // 提交里没出现的键从磁盘原值补回（老客户端只提交部分字段时也不丢配置）
    for (const [k, v] of Object.entries(base)) {
      if (!(k in result)) result[k] = v;
    }
    return result;
  }

  if (key !== null && key !== undefined && isSecretKey(key) && (incoming === null || incoming === undefined)) {
    return existing !== undefined && existing !== null ? existing : '';
  }

  if (isSecretKey(key) && typeof incoming === 'string') {
    if (!isBlankOrMask(incoming)) return incoming;
    // 掩码/空值：有原值就回填；没有原值可回填就落空串，绝不把掩码写盘
    return existing !== undefined && existing !== null ? existing : '';
  }
  return incoming;
}

/**
 * 用提交值覆盖磁盘原值，但敏感键的「掩码 / 空串」一律回填原值。
 *
 * @param {*} incoming 渲染层提交的配置
 * @param {*} existing 磁盘上的原始配置
 * @returns {*} 可安全落盘的新对象（深拷贝，不修改入参）
 */
function restoreSecrets(incoming, existing) {
  return restoreWalk(incoming, existing, null);
}

module.exports = {
  isSecretKey,
  maskSecrets,
  restoreSecrets,
  // 以下为内部复用/测试便利，不改变对外契约
  maskSecretText,
  isBlankOrMask,
  MASK_PREFIX,
  MASK_MIN_LEN,
};
