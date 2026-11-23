#!/usr/bin/env node
/**
 * _probe/test-secret-mask.cjs — 插件配置凭据掩码/回填纯函数回归（不启 Electron、不碰磁盘）
 *
 * 被测：_incoming/my-neuro/live-2d/js/core/secret-mask.js
 * 对照：_incoming/my-neuro/live-2d/webui/plugin_manager.py L96-L222（同一套规则）
 *
 * 用法：node _probe/test-secret-mask.cjs
 */

'use strict';

const path = require('node:path');
const {
  isSecretKey, maskSecrets, restoreSecrets, maskSecretText, isBlankOrMask,
} = require(path.resolve(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'secret-mask.js'));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { pass++; return; }
  fail++;
  failures.push(`${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`);
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

// ---------- 1. 敏感键判定（与 WebUI SECRET_KEY_RE 一致） ----------
for (const key of ['tavily_api_key', 'api_key', 'api-key', 'apikey', 'APIKEY', 'Api_Key',
  'client_secret', 'jwt_secret', 'access_token', 'refresh_token', 'password', 'user_passwd',
  'session_cookie', 'Authorization', 'aws_credential']) {
  check(`isSecretKey(${key}) === true`, isSecretKey(key) === true);
}
for (const key of ['ptt_key', 'max_tokens', 'secret_santa', 'key', 'api_url', 'tokenizer', 'passwordless_mode', '', null, undefined, 42]) {
  check(`isSecretKey(${JSON.stringify(key)}) === false`, isSecretKey(key) === false);
}
check('isSecretKey 大小写不敏感', isSecretKey('TAVILY_API_KEY') && isSecretKey('Tavily-Api-Key'));

// ---------- 2. 掩码格式 ----------
eq('长串掩码 = *** + 末 4 位', maskSecretText('tvly-dev-SYNTHETICTESTKEY0000000000000CU7J'), '***CU7J');
eq('9 位掩码 = *** + 末 4 位', maskSecretText('abcdefghi'), '***fghi');
eq('8 位只回 ***', maskSecretText('abcdefgh'), '***');
eq('3 位只回 ***', maskSecretText('abc'), '***');
eq('1 位只回 ***', maskSecretText('x'), '***');
eq('空串掩码仍为 ***', maskSecretText(''), '***');
eq('掩码前缀恒为 ***', maskSecretText('0123456789').slice(0, 3), '***');
check('isBlankOrMask(空串)', isBlankOrMask('') === true);
check('isBlankOrMask(空白)', isBlankOrMask('   ') === true);
check('isBlankOrMask(***abcd)', isBlankOrMask('***abcd') === true);
check('isBlankOrMask(****)', isBlankOrMask('****') === true);
check('isBlankOrMask(真值) === false', isBlankOrMask('sk-real-value') === false);
check('isBlankOrMask(非字符串) === false', isBlankOrMask(123) === false);

// ---------- 3. maskSecrets：扁平 / 例外键 ----------
const flat = {
  tavily_api_key: 'tvly-dev-SYNTHETICTESTKEY0000000000000CU7J',
  search_base_url: 'http://127.0.0.1:18080',
  ptt_key: 'CTRL+ALT+P',
  max_tokens: '4096',
  secret_santa: 'buddy',
};
const flatMasked = maskSecrets(flat);
eq('扁平：真实 key 被掩码', flatMasked.value.tavily_api_key, '***CU7J');
eq('扁平：非敏感值原样', flatMasked.value.search_base_url, 'http://127.0.0.1:18080');
eq('扁平：ptt_key 不掩', flatMasked.value.ptt_key, 'CTRL+ALT+P');
eq('扁平：max_tokens 不掩', flatMasked.value.max_tokens, '4096');
eq('扁平：secret_santa 不掩', flatMasked.value.secret_santa, 'buddy');
eq('扁平：maskedKeys', flatMasked.maskedKeys, ['tavily_api_key']);
eq('maskSecrets 不修改入参', flat.tavily_api_key, 'tvly-dev-SYNTHETICTESTKEY0000000000000CU7J');

// ---------- 4. maskSecrets：schema 节点 / 嵌套对象 / 数组 ----------
const schemaConfig = {
  tavily_api_key: { title: 'Tavily API Key', type: 'string', default: '', value: 'tvly-dev-SYNTHETICTESTKEY0000000000000CU7J' },
  search_base_url: { title: '本地地址', type: 'string', default: '', value: 'http://127.0.0.1:18080' },
  empty_key: { title: '空 key', type: 'string', default: '', value: '' },
};
const schemaMasked = maskSecrets(schemaConfig);
eq('schema：value 被掩码', schemaMasked.value.tavily_api_key.value, '***CU7J');
eq('schema：元数据保留', schemaMasked.value.tavily_api_key.title, 'Tavily API Key');
eq('schema：maskedKeys 是父键名而非 .value', schemaMasked.maskedKeys, ['tavily_api_key']);
eq('schema：空 value 不产生 maskedKeys', schemaMasked.value.empty_key.value, '');
eq('schema：普通字段原样', schemaMasked.value.search_base_url.value, 'http://127.0.0.1:18080');

const nested = { nested: { password: 'hunter2-long-enough', note: 'x' }, list: [{ api_key: 'abcdefghijk' }] };
const nestedMasked = maskSecrets(nested);
eq('嵌套对象：password 掩码', nestedMasked.value.nested.password, '***ough');
eq('嵌套对象：非敏感保持', nestedMasked.value.nested.note, 'x');
eq('嵌套数组对象：api_key 掩码', nestedMasked.value.list[0].api_key, '***hijk');
eq('嵌套：maskedKeys 点号路径', nestedMasked.maskedKeys, ['nested.password', 'list.0.api_key']);

const strArray = { token: ['abcdefgh12345', 'short'] };
const strArrayMasked = maskSecrets(strArray);
eq('字符串数组：长项掩码', strArrayMasked.value.token[0], '***2345');
eq('字符串数组：短项全掩', strArrayMasked.value.token[1], '***');
eq('字符串数组：索引路径', strArrayMasked.maskedKeys, ['token.0', 'token.1']);
check('字符串数组：tokens 复数不命中（与 WebUI token$ 一致）', maskSecrets({ tokens: ['abcdefgh12345'] }).value.tokens[0] === 'abcdefgh12345');

const fieldsConfig = { group: { type: 'object', fields: { access_token: { type: 'string', value: 'abcdefghijklmn' } } } };
const fieldsMasked = maskSecrets(fieldsConfig);
eq('fields 分组：access_token 掩码', fieldsMasked.value.group.fields.access_token.value, '***klmn');
eq('fields 分组：maskedKeys 路径', fieldsMasked.maskedKeys, ['group.access_token']);

// ---------- 5. restoreSecrets：保留 / 覆盖 / 补回 ----------
const disk = { ...flat };
const submitMasked = { ...flatMasked.value };
const restoredMasked = restoreSecrets(submitMasked, disk);
eq('回填：提交掩码 → 保留磁盘原值', restoredMasked.tavily_api_key, flat.tavily_api_key);
eq('回填：非敏感值正常写', restoredMasked.search_base_url, 'http://127.0.0.1:18080');

const restoredEmpty = restoreSecrets({ ...submitMasked, tavily_api_key: '' }, disk);
eq('回填：提交空串 → 保留原值', restoredEmpty.tavily_api_key, flat.tavily_api_key);
const restoredSpace = restoreSecrets({ ...submitMasked, tavily_api_key: '   ' }, disk);
eq('回填：提交空白 → 保留原值', restoredSpace.tavily_api_key, flat.tavily_api_key);
const restoredStars = restoreSecrets({ ...submitMasked, tavily_api_key: '****' }, disk);
eq('回填：提交全星号 → 保留原值', restoredStars.tavily_api_key, flat.tavily_api_key);
const restoredNew = restoreSecrets({ ...submitMasked, tavily_api_key: 'tvly-brand-new-key-9999' }, disk);
eq('回填：提交真新值 → 覆盖', restoredNew.tavily_api_key, 'tvly-brand-new-key-9999');
const restoredMissing = restoreSecrets({ search_base_url: 'http://x' }, disk);
eq('回填：缺失敏感键 → 从原值补回', restoredMissing.tavily_api_key, flat.tavily_api_key);
eq('回填：缺失非敏感键 → 也从原值补回', restoredMissing.ptt_key, 'CTRL+ALT+P');
const restoredNullSecret = restoreSecrets({ ...submitMasked, tavily_api_key: null }, disk);
eq('回填：null 敏感值 → 保留原值', restoredNullSecret.tavily_api_key, flat.tavily_api_key);

// 嵌套 / 数组回填
const diskNested = { nested: { password: 'disk-password-1', note: 'old' }, list: [{ api_key: 'disk-api-key-abcdefg' }] };
const submitNested = { nested: { password: '***-1', note: 'new' }, list: [{ api_key: '***efg' }] };
const restoredNested = restoreSecrets(submitNested, diskNested);
eq('回填嵌套：掩码密码保留原值', restoredNested.nested.password, 'disk-password-1');
eq('回填嵌套：普通值覆盖', restoredNested.nested.note, 'new');
eq('回填数组：掩码 api_key 保留原值', restoredNested.list[0].api_key, 'disk-api-key-abcdefg');

// schema 节点回填
const diskSchema = { tavily_api_key: { title: 'T', type: 'string', value: 'disk-real-key-123456' } };
const submitSchema = { tavily_api_key: { title: 'T', type: 'string', value: '***3456' } };
const restoredSchema = restoreSecrets(submitSchema, diskSchema);
eq('回填 schema：掩码 value 保留原值', restoredSchema.tavily_api_key.value, 'disk-real-key-123456');
const submitSchemaNew = { tavily_api_key: { title: 'T', type: 'string', value: 'new-real-key-abcdef' } };
eq('回填 schema：真新值覆盖', restoreSecrets(submitSchemaNew, diskSchema).tavily_api_key.value, 'new-real-key-abcdef');

// 没有原值可回填的掩码/空串 → 不落盘
const restoredNoBase = restoreSecrets({ brand_new_api_key: '***abcd', another_token: '' }, {});
check('回填：无原值的掩码敏感键被丢弃', !('brand_new_api_key' in restoredNoBase), restoredNoBase);
check('回填：无原值的空串敏感键被丢弃', !('another_token' in restoredNoBase), restoredNoBase);

// 完整往返：GET 掩码 → 界面原样提交 → 磁盘不变
const submitRoundTrip = maskSecrets(disk).value;
eq('往返：掩码配置回填后等于磁盘原值', restoreSecrets(submitRoundTrip, disk), disk);

// ---------- 6. 绝不把 *** 写盘（对最终输出做全局扫描） ----------
function collectSecretStrings(node, key, out) {
  if (Array.isArray(node)) { node.forEach(item => collectSecretStrings(item, key, out)); return out; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const ctx = (k === 'value' && (('type' in node) || ('title' in node))) ? key : k;
      collectSecretStrings(v, ctx, out);
    }
    return out;
  }
  if (typeof node === 'string' && isSecretKey(key)) out.push(node);
  return out;
}
const cases = [
  ['扁平掩码', restoreSecrets({ ...flatMasked.value }, disk), disk],
  ['空串', restoreSecrets({ ...submitMasked, tavily_api_key: '' }, disk), disk],
  ['全星号', restoreSecrets({ ...submitMasked, tavily_api_key: '****' }, disk), disk],
  ['嵌套', restoreSecrets(submitNested, diskNested), diskNested],
  ['schema', restoreSecrets(submitSchema, diskSchema), diskSchema],
  ['无原值', restoreSecrets({ brand_new_api_key: '***abcd' }, {}), {}],
  ['往返', restoreSecrets(submitRoundTrip, disk), disk],
];
for (const [label, output, base] of cases) {
  const baseValues = new Set(collectSecretStrings(base, null, []));
  const leaked = collectSecretStrings(output, null, []).filter(value => value.startsWith('***') && !baseValues.has(value));
  eq(`无 *** 新写入（${label}）`, leaked, []);
}
check('输出里不存在把旧掩码再掩一次的情况', !JSON.stringify(restoreSecrets(submitRoundTrip, disk)).includes('****'));

// ---------- 汇总 ----------
console.log(`\nPASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const item of failures) console.log('  FAIL: ' + item);
  process.exitCode = 1;
}
