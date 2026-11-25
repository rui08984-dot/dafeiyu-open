#!/usr/bin/env node
/**
 * _probe/test-ui-config-wiring.cjs — 能力页 ↔ config ↔ 控制中心 三方接线守卫（2026-11-25）
 *
 * 为什么要有：昨天（11-24）刚把一批真键落盘（context.tool_result_max_chars / turn_… /
 * toolFilter.enabled / cost.* / diary.local_enabled，删掉 context.token_budget），并拆了
 * 能力页的 ctx.tool_result_cap。这类改动最容易留下「页面写了但读不到」「写回时 key 不匹配」
 * 的断链——上一轮就是这么坏的（能力页只读 config.json，运行时真值在 llm_providers.json）。
 *
 * 本测试**纯静态**（不启 Electron / 不碰网络 / 不跑宿主），断言：
 *   ① 每个 config 能力项的 key：要么在 config.example.json 存在，要么显式 soft（config 可缺省）
 *      且在 note 里写清「缺省=代码默认」。非 soft 的键必须同时存在于真实 config.json。
 *   ② 每个 config 能力键都有**生产代码消费者**（全仓 hybrid 检索：完整 key / 唯一叶子 /
 *      父段+叶子同文件；排除 capabilities.js、config*.json、*.test.js、_probe）。
 *   ③ 控制中心字段表（control-v2-renderer.js 的 `const fields`）每个路径都有落点：
 *      在模板里存在，或属于已知的「模型级/瞬时视图」白名单（且有消费者）。
 *   ④ 写回链路没有 id/key 混用：能力页 data-cap-key 与 applyCapabilityLive 里的键都必须是
 *      注册表声明过的 config **key**（不是 capability id）。
 *   ⑤ hot=true 的 config 能力必须有真实的下发面（applyCapabilityLive / 8103 / reload-config /
 *      关面板时读），不能只是徽章上写「即时」。
 *   ⑥ plugin 能力指向的插件目录真实存在；默认开启的插件在 enabled_plugins.json 里。
 *
 * 退出码：0 全过 / 1 有失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const read = (p) => fs.readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); }
    else { fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const { CAPABILITIES, getPath } = require(path.join(LIVE, 'js', 'core', 'capabilities.js'));
const example = readJson(path.join(LIVE, 'config.example.json'));
const real = readJson(path.join(LIVE, 'config.json'));
const enabledPlugins = (() => {
    try {
        const p = readJson(path.join(LIVE, 'plugins', 'enabled_plugins.json'));
        return Array.isArray(p.plugins) ? p.plugins : (Array.isArray(p.enabled) ? p.enabled : []);
    } catch (e) { return []; }
})();

const configCaps = CAPABILITIES.filter((c) => c.kind === 'config');
const activeConfigCaps = configCaps.filter((c) => !c.deprecated);

// ── 生产代码语料（一次性；排除注册表本身、配置/模板、单测与探针）──────────
function buildCorpus() {
    const files = [];
    const roots = [
        path.join(LIVE, 'js'),
        path.join(LIVE, 'plugins'),
        path.join(LIVE, 'webui'),
        path.join(LIVE, 'main.js'),
        path.join(ROOT, 'pet-runtime'),
    ];
    const JUNK = new Set(['node_modules', '.git', '.state', 'crash-dumps', 'dist', 'build']);
    const walk = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                if (!JUNK.has(ent.name)) walk(full);
                continue;
            }
            if (!/\.(js|mjs|cjs|py)$/.test(ent.name)) continue;
            if (/\.test\.js$/i.test(ent.name)) continue;
            if (/^capabilities\.js$/i.test(ent.name)) continue;
            let st = null;
            try { st = fs.statSync(full); } catch (e) { continue; }
            if (!st.isFile() || st.size > 3 * 1024 * 1024) continue;
            try { files.push({ file: full, text: fs.readFileSync(full, 'utf8') }); } catch (e) { /* 读不了就跳过 */ }
        }
    };
    for (const r of roots) {
        try {
            const st = fs.statSync(r);
            if (st.isFile()) files.push({ file: r, text: fs.readFileSync(r, 'utf8') });
            else walk(r);
        } catch (e) { /* 目录不存在：跳过 */ }
    }
    return files;
}
const CORPUS = buildCorpus();

// 叶子名太泛（enabled/url…）：单靠叶子会误判给一切，必须完整 key 或「父段+叶子」同文件才算
const GENERIC_LEAVES = new Set(['enabled', 'disabled', 'quiet', 'muted', 'url', 'uri', 'endpoint', 'local_enabled']);
function consumerHits(key) {
    const parts = String(key).split('.');
    const leaf = parts[parts.length - 1];
    const parentLeaf = parts.length > 1 ? parts[parts.length - 2] : '';
    const hits = [];
    for (const { file, text } of CORPUS) {
        if (text.includes(key)) { hits.push({ file, how: 'full-key' }); continue; }
        if (!GENERIC_LEAVES.has(leaf) && leaf.length >= 6 && text.includes(leaf)) { hits.push({ file, how: 'leaf' }); continue; }
        if (parentLeaf && parentLeaf.length >= 3 && text.includes(parentLeaf) && text.includes(leaf)) {
            hits.push({ file, how: 'parent+leaf' });
        }
    }
    return hits;
}

console.log('== 能力注册表 ↔ config ↔ 控制中心 接线 ==');

// ── ① 模板/实盘覆盖 ─────────────────────────────────────────────────────
{
    ok('注册表规模合理（config 能力 ≥ 40）', configCaps.length >= 40, String(configCaps.length));
    const hardMissingExample = [];
    const hardMissingReal = [];
    for (const cap of activeConfigCaps) {
        const inExample = getPath(example, cap.key) !== undefined;
        const inReal = getPath(real, cap.key) !== undefined;
        if (!inExample && cap.soft !== true) hardMissingExample.push(cap.id + ' → ' + cap.key);
        if (!inReal && cap.soft !== true) hardMissingReal.push(cap.id + ' → ' + cap.key);
        if (cap.soft === true) {
            // soft 的语义 =「config.json 缺省合法」；必须带说明，告诉用户页面显示的是默认值
            ok('soft 键有说明（为什么 config 可缺省）：' + cap.id,
                typeof cap.note === 'string' && cap.note.length >= 10,
                cap.note ? String(cap.note).slice(0, 40) : '(无 note)');
        }
    }
    ok('非 soft 能力键全部存在于 config.example.json', hardMissingExample.length === 0,
        hardMissingExample.join('; ') || `${activeConfigCaps.filter((c) => c.soft !== true).length} 个键全在`);
    ok('非 soft 能力键全部存在于真实 config.json', hardMissingReal.length === 0,
        hardMissingReal.join('; ') || '全在');
    // 页面上数字/开关类型由 default 的 typeof 决定：default 不能缺
    ok('每个 config 能力都有 default（页面控件类型依赖它）',
        configCaps.every((c) => c.default !== undefined),
        configCaps.filter((c) => c.default === undefined).map((c) => c.id).join(',') || '全有');
    // 默认值类型与模板落盘类型一致（否则 number 会被渲染成文本/开关反向）
    const typeMismatch = [];
    for (const cap of activeConfigCaps) {
        const v = getPath(example, cap.key);
        if (v === undefined) continue;
        const t = typeof cap.default;
        if (t === 'number' && Number.isNaN(Number(v)) && typeof v !== 'number') typeMismatch.push(cap.key);
        else if (t === 'boolean' && typeof v !== 'boolean') typeMismatch.push(cap.key);
        else if (t === 'string' && typeof v !== 'string') typeMismatch.push(cap.key);
    }
    ok('模板值类型与 default 一致（控件不会反向）', typeMismatch.length === 0, typeMismatch.join(',') || '一致');
}

// ── ② 每个 config 能力有生产消费者 ──────────────────────────────────────
{
    const noConsumer = [];
    for (const cap of activeConfigCaps) {
        const hits = consumerHits(cap.key);
        if (!hits.length) noConsumer.push(cap.id + ' → ' + cap.key);
    }
    ok('每个 config 能力键都有生产代码消费者', noConsumer.length === 0,
        noConsumer.join('; ') || `${activeConfigCaps.length} 个键全部命中`);
}

// ── ③ 控制中心字段表：路径有落点 ────────────────────────────────────────
const renderer = read(path.join(LIVE, 'control-v2-renderer.js'));
const controlMain = read(path.join(LIVE, 'control-main.js'));
const preload = read(path.join(LIVE, 'control-preload.js'));

// 模型级/瞬时视图键：运行时物化（loadControlConfig/saveControlConfig 会搬运），模板里不落
const FIELD_OPTIONAL = new Map([
    ['llm.model', '运行时别名（loadControlConfig 用 llm.model_id 物化；保存时写回 model_id）'],
    ['llm.reasoning_enabled', '模型级参数（真值在 llm_providers.json 当前模型）'],
    ['llm.reasoning_effort', '模型级参数（真值在 llm_providers.json 当前模型）'],
    ['llm.temperature', '模型级参数（真值在 llm_providers.json 当前模型）'],
    ['llm.filler_delay_ms', '可选参数（缺省=代码默认 1500ms；用户填了才落盘）'],
    ['vision.vision_model.model', '运行时别名（loadControlConfig 用 vision.model_id 物化）'],
]);
{
    // 只读 UI 主进程注入的那段（renderer 同时是 Node 模块与页面脚本，这里只解析 fields 表）
    const block = (renderer.match(/const fields = \{([\s\S]*?)\n  \};/) || ['', ''])[1];
    const pairs = [...block.matchAll(/'([^']+)':\s*\['([^']+)',\s*'(checked|value|number)'\]/g)]
        .map((m) => ({ id: m[1], key: m[2], type: m[3] }));
    ok('控制中心字段表可解析（≥ 12 个字段）', pairs.length >= 12, String(pairs.length));
    const missing = [];
    for (const f of pairs) {
        if (getPath(example, f.key) !== undefined) continue;
        if (FIELD_OPTIONAL.has(f.key)) continue;
        missing.push(f.id + ' → ' + f.key);
    }
    ok('字段表路径在 config.example 存在（或列入模型级/可选白名单）', missing.length === 0,
        missing.join('; ') || `${pairs.length} 个字段全部有落点`);
    // 白名单不是免死金牌：每个白名单键也必须有生产消费者
    const optionalNoConsumer = [...FIELD_OPTIONAL.keys()].filter((k) => consumerHits(k).length === 0);
    ok('模型级/可选白名单键同样有消费者', optionalNoConsumer.length === 0,
        optionalNoConsumer.join(',') || `${FIELD_OPTIONAL.size} 个键全部命中`);

    // 经典断链：字段路径误把 capability id 当 config key（id 与 key 不同名时必炸）
    const idKeyMismatch = [];
    const byId = new Map(CAPABILITIES.map((c) => [c.id, c]));
    for (const f of pairs) {
        const cap = byId.get(f.key);
        if (cap && cap.kind === 'config' && cap.key !== f.key) idKeyMismatch.push(f.key + ' ≠ ' + cap.key);
    }
    ok('字段表没有把 capability id 当 config key', idKeyMismatch.length === 0,
        idKeyMismatch.join('; ') || '无混用');
}

// ── ④ 能力页写回：data-cap-key / 即时下发面必须是注册表 key ──────────────
{
    const declaredKeys = new Set(configCaps.map((c) => c.key));
    const dataKeys = [...renderer.matchAll(/data-cap-key="\$\{escapeHtml\(([^)]+)\)\}"/g)].map((m) => m[1]);
    ok('能力页控件统一从 it.key 生成 data-cap-key',
        dataKeys.length >= 1 && dataKeys.every((x) => x === 'it.key'),
        dataKeys.join(',') || '未找到');
    ok('能力页不拿 id 当写回键',
        !/data-cap-key="\$\{escapeHtml\(it\.id\)\}"/.test(renderer)
        && !/setConfigValue\(it\.id/.test(renderer));

    // 显式写死的键（热更新下发映射 / 总览快捷开关）必须在注册表里
    const liveKeys = [...(renderer.match(/async function applyCapabilityLive[\s\S]*?\n  \}/) || [''])[0]
        .matchAll(/key === '([^']+)'/g)].map((m) => m[1]);
    ok('applyCapabilityLive 至少覆盖 5 个即时键', liveKeys.length >= 5, liveKeys.join(','));
    const undeclaredLive = liveKeys.filter((k) => !declaredKeys.has(k));
    ok('即时下发映射里的键全部是注册表 config key', undeclaredLive.length === 0, undeclaredLive.join(',') || '全对齐');

    const hardcoded = [...renderer.matchAll(/setConfigValue\('([^']+)'/g)].map((m) => m[1]);
    const undeclaredHard = hardcoded.filter((k) => !declaredKeys.has(k));
    ok('总览/快捷开关写回键全部在注册表', undeclaredHard.length === 0, undeclaredHard.join(',') || '全对齐');

    ok('主进程写回白名单按 key 查注册表（不是按 id）',
        /CAPABILITIES\.find\(\(c\) => c\.kind === 'config' && c\.key === key\)/.test(controlMain));
    ok('preload 把 setConfigValue 透传到 control:set-config-value',
        /setConfigValue:\s*\(key, value\)\s*=>\s*ipcRenderer\.invoke\('control:set-config-value'/.test(preload));
    ok('主进程暴露 capabilities IPC', /ipcMain\.handle\('control:capabilities'/.test(controlMain));
}

// ── ⑤ hot=true 必须有真实下发面（不能只是徽章）──────────────────────────
{
    // 每个热键要么在 applyCapabilityLive 里（8004 eval），要么是已核对过的其它实时通道。
    const HOT_RUNTIME = new Map([
        ['tts.muted', 'applyCapabilityLive → global.__ttsMuted + 打断播报'],
        ['cost.quiet', '能力页转 8103 /quiet（唯一真源）'],
        ['ui.petbody_choreo', 'applyCapabilityLive → petBody.setChoreography'],
        ['ui.petbody_perf_auto', 'applyCapabilityLive → petBody.setPerformanceAuto'],
        ['ui.petbody_framing', 'applyCapabilityLive → renderer.setFraming'],
        ['ui.click_through_default', 'applyCapabilityLive → pet:set-ignore-mouse'],
        ['ui.show_chat_box', 'applyCapabilityLive → global.__setChatBoxVisible'],
        ['llm.filler_enabled', '/reload-config → app.js 写 global.__latencyFillerCfg'],
        ['auto_close_services.enabled', 'control-main 关面板时 readJson(configPath) 现读'],
    ]);
    const hotCaps = activeConfigCaps.filter((c) => c.hot === true);
    const unbacked = hotCaps.filter((c) => !HOT_RUNTIME.has(c.key));
    ok('所有 hot=true 的 config 能力都有核过的下发面', unbacked.length === 0,
        unbacked.map((c) => c.id + ' → ' + c.key).join('; ') || `${hotCaps.length} 个热键全部有通道`);
    ok('hot 通道与注册表一一对应（没有陈旧映射）',
        [...HOT_RUNTIME.keys()].every((k) => hotCaps.some((c) => c.key === k)),
        [...HOT_RUNTIME.keys()].filter((k) => !hotCaps.some((c) => c.key === k)).join(',') || '无多余');
}

// ── ⑥ plugin 能力：插件目录真实存在 & 默认开启者在启用清单 ──────────────
{
    const pluginCaps = CAPABILITIES.filter((c) => c.kind === 'plugin' && !c.deprecated);
    const missingDirs = pluginCaps.filter((c) => {
        const dir = path.join(LIVE, 'plugins', c.key);
        return !fs.existsSync(path.join(dir, 'metadata.json')) && !fs.existsSync(path.join(dir, 'index.js'));
    });
    ok('plugin 能力的插件目录都存在', missingDirs.length === 0,
        missingDirs.map((c) => c.key).join(',') || `${pluginCaps.length} 个目录全在`);
    const defaultOn = pluginCaps.filter((c) => c.default === true);
    const notEnabled = defaultOn.filter((c) => !enabledPlugins.includes(c.key));
    ok('声明默认开启的插件都在 enabled_plugins.json', notEnabled.length === 0,
        notEnabled.map((c) => c.key).join(',') || `${defaultOn.length} 个全在`);
}

// ── ⑦ 旧键没复活：context.token_budget 必须不存在（11-24 已删）───────────
{
    ok('已删死键 context.token_budget 没有回到模板', getPath(example, 'context.token_budget') === undefined);
    ok('已删死键 context.token_budget 没有回到实盘', getPath(real, 'context.token_budget') === undefined);
    ok('注册表没有声明已删的 context.token_budget', !configCaps.some((c) => c.key === 'context.token_budget'));
}

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + '/' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
