// plugin-manager.js - 插件管理器（支持热加载）
const __silentAudit = require('./silent-audit.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PluginContext } = require('./plugin-context.js');
const { logToTerminal, logToolAction } = require('../api-utils.js');
const toolResult = require('./tool-result.js');
const policy = require('./policy.js');

/** 内容指纹：sha1 前 16 位。只回答「字节变没变」，不参与安全用途。 */
function hashContent(src) {
    return crypto.createHash('sha1').update(String(src), 'utf8').digest('hex').slice(0, 16);
}

/** 热重载的静默调试行：只进日志，不弹通知、不打扰对话。 */
function dbg(msg) {
    try { logToTerminal('debug', msg); } catch (e) { /* 日志失败不影响重载判断 */ }
}

class PluginManager {
    constructor(config) {
        this._config = config;
        /** @type {Map<string, {plugin: Plugin, metadata: object, pluginDir: string}>} */
        this._plugins = new Map();
        /** 动态注册的工具（由 context.registerTool 调用）*/
        this._dynamicTools = new Map(); // pluginName -> toolDef[]
        // 钩子调用统计：用来回答「这个插件到底在不在干活」。
        // 装了没生效的插件比没装更糟——占着白名单、拉长启动、还让人以为功能有了。
        this._hookStats = new Map();

        this._pluginsDir = path.join(__dirname, '..', '..', 'plugins');
        this._builtinDir = path.join(__dirname, '..', '..', 'plugins', 'built-in');
        this._communityDir = path.join(__dirname, '..', '..', 'plugins', 'community');

        /** 已启用的插件相对路径集合，null 表示尚未加载 */
        this._enabledPlugins = null;

        /** 文件监听器引用 */
        this._enabledListWatcher = null;
        this._sourceWatchers = [];
        this._syncDebounceTimer = null;
        this._reloadDebounceTimers = new Map();
        this._reloadSyntaxRetries = new Map();
        /**
         * 内容指纹表（2026-11-25）：absolutePath -> sha1 前 16 位。
         * 只在**成功加载/成功重载**后更新；fswatch 的「触碰」事件先比它，
         * 内容没变就跳过 —— 实测 132 次热重载里 75 次是编辑器保存/元数据变化造成的伪事件。
         * 只存内存：重启后由首轮 load() 重建基线。
         * @type {Map<string, string>}
         */
        this._fileHashes = new Map();
    }

    // ===== enabled_plugins.json 读取 =====

    /**
     * 从磁盘读取 enabled_plugins.json 并返回 Set
     * @param {boolean} [forceReload=false] - 是否强制从磁盘重新读取
     */
    _loadEnabledList(forceReload = false) {
        if (!forceReload && this._enabledPlugins !== null) return;

        const listPath = path.join(this._pluginsDir, 'enabled_plugins.json');
        if (!fs.existsSync(listPath)) {
            logToTerminal('warn', '⚠️ 未找到 enabled_plugins.json，所有插件将被禁用');
            this._enabledPlugins = new Set();
            return;
        }
        try {
            const data = JSON.parse(fs.readFileSync(listPath, 'utf8'));
            this._enabledPlugins = new Set(
                (data.plugins || []).map(p => p.replace(/\\/g, '/'))
            );
        } catch (e) {
            logToTerminal('warn', `⚠️ enabled_plugins.json 读取失败: ${e.message}`);
            this._enabledPlugins = new Set();
        }
    }

    /**
     * 该插件是否在 enabled_plugins.json 里 —— **插件总开关的唯一真相源**（2026-11-21）。
     *
     * 只读：不改加载状态、不触发加载/卸载，只回答「现在这份清单怎么写的」。
     * 由 PluginContext.isPluginEnabled() 暴露给插件；插件据此决定自己的总开关，
     * 不再各自读 plugin_config.enabled（那份已降级为兼容读取，只认显式 false）。
     *
     * @param {string} relPath - 插件相对路径，如 'community/world-extras'
     * @returns {boolean}
     */
    isPluginEnabled(relPath) {
        if (!relPath) return false;
        this._loadEnabledList();
        const key = String(relPath).replace(/\\/g, '/');
        return !!(this._enabledPlugins && this._enabledPlugins.has(key));
    }

    /**
     * 扫描插件目录，返回 { relPath -> pluginDir } 映射
     */
    _scanAllPluginDirs() {
        const result = new Map();
        for (const baseDir of [this._builtinDir, this._communityDir]) {
            if (!fs.existsSync(baseDir)) continue;
            let entries;
            try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch { continue; }
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const pluginDir = path.join(baseDir, entry.name);
                const metaPath = path.join(pluginDir, 'metadata.json');
                if (!fs.existsSync(metaPath)) continue;
                const relPath = path.relative(this._pluginsDir, pluginDir).replace(/\\/g, '/');
                result.set(relPath, pluginDir);
            }
        }
        return result;
    }

    // ===== 加载 =====

    async loadAll() {
        logToolAction('info', '🔌 开始加载插件...');
        await this._loadFromDir(this._builtinDir, 'built-in');
        await this._loadFromDir(this._communityDir, 'community');
        logToolAction('info', `🔌 插件加载完成，共 ${this._plugins.size} 个插件`);
    }

    async _loadFromDir(dir, type) {
        if (!fs.existsSync(dir)) return;

        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            logToTerminal('warn', `⚠️ 读取插件目录失败 (${dir}): ${e.message}`);
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const pluginDir = path.join(dir, entry.name);
            await this.load(pluginDir).catch(err => {
                logToolAction('error', `❌ 加载插件失败 (${entry.name}): ${err.message}`);
            });
        }
    }

    /**
     * 加载单个插件目录
     * @param {string} pluginDir - 插件目录绝对路径
     */
    async load(pluginDir) {
        const metaPath = path.join(pluginDir, 'metadata.json');
        if (!fs.existsSync(metaPath)) return;

        let metadata;
        try {
            metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        } catch (e) {
            throw new Error(`metadata.json 解析失败: ${e.message}`);
        }

        const { name, main = 'index.js', lang } = metadata;

        this._loadEnabledList();
        const relPath = path.relative(this._pluginsDir, pluginDir).replace(/\\/g, '/');
        if (!this._enabledPlugins.has(relPath)) {
            //logToTerminal('info', `⏭️ 插件未启用，跳过: ${name}`);
            return;
        }

        if (this._plugins.has(relPath)) {
            //logToTerminal('info', `⏭️ 插件已加载，跳过: ${name}`);
            return;
        }

        const isPython = lang === 'python';
        const resolvedMain = main !== 'index.js' ? main : (isPython ? 'index.py' : 'index.js');
        const mainPath = path.join(pluginDir, resolvedMain);

        if (!fs.existsSync(mainPath)) {
            throw new Error(`入口文件不存在: ${mainPath}`);
        }

        const context = new PluginContext(relPath, this._config, this, pluginDir);

        let plugin;
        if (isPython) {
            const { PythonPluginBridge } = require('./python-plugin-bridge.js');
            plugin = new PythonPluginBridge(metadata, context, mainPath);
        } else {
            let PluginClass;
            try {
                const mod = require(mainPath);
                // 2026-11-21 审计（P0）：原实现是 mod.default || mod[Object.keys(mod)[0]] || mod。
                // 插件类只要挂了静态属性（memory-recall 为了单测挂了 SRC_RANK 等），
                // Object.keys(mod)[0] 就是那个静态属性 → new 一个对象 →「PluginClass is not a constructor」。
                // 实测 memory-recall 从 19:34 起每次启动/热重载都失败，宿主一直只有 25 个插件。
                // 现在：模块本身是函数时优先用它（CommonJS 导出的类就是函数）；
                // 其次才是 default / 第一个函数型具名导出（兼容 module.exports = { PluginClass } 的写法）。
                const named = (mod && typeof mod === 'object')
                    ? Object.keys(mod).map((k) => mod[k]).find((v) => typeof v === 'function')
                    : null;
                PluginClass = (typeof mod === 'function') ? mod : (mod && mod.default) || named || mod;
            } catch (e) {
                throw new Error(`加载插件模块失败: ${e.message}`);
            }
            if (typeof PluginClass !== 'function') {
                throw new Error(`插件入口没有导出类（拿到 ${typeof PluginClass}）；请 module.exports = 类，或导出 default / 具名类`);
            }
            plugin = new PluginClass(metadata, context);
        }

        await plugin.onInit();

        this._plugins.set(relPath, { plugin, metadata, pluginDir });
        // 成功加载后建立指纹基线：fswatch 的首次「触碰」就能按内容判空转。
        try { this._recordPluginHashes(pluginDir); } catch (e) { /* 指纹失败不影响加载 */ }
        const displayName = metadata.displayName || name;
        logToolAction('info', `✅ 插件已加载: ${displayName} v${metadata.version || '?'}${isPython ? ' [Python]' : ''}`);
    }

    /**
     * 卸载插件
     * @param {string} name
     */
    async unload(name) {
        const entry = this._plugins.get(name);
        if (!entry) return;

        await entry.plugin.onStop().catch(() => {});
        await entry.plugin.onDestroy().catch(() => {});
        // B7：清掉本插件留在共享补丁表里的注入（没有 owner 时热重载会留下旧提示词）。
        try {
            const context = entry.plugin && entry.plugin.context;
            if (context && typeof context.releaseSystemPromptPatches === 'function') {
                const removed = context.releaseSystemPromptPatches();
                if (removed > 0) logToTerminal('info', `🧹 已清理插件提示注入: ${name} ×${removed}`);
            }
        } catch (error) {
            logToTerminal('warn', `[unload] 清理插件提示注入失败（${name}）：${error && error.message || error}`);
        }
        this._plugins.delete(name);
        this._dynamicTools.delete(name);
        logToTerminal('info', `🔌 插件已卸载: ${name}`);
    }

    /**
     * 热重载插件（兼容 JS 和 Python 插件）
     * @param {string} name
     */
    async reload(name) {
        const entry = this._plugins.get(name);
        if (!entry) throw new Error(`插件不存在: ${name}`);

        const { pluginDir, metadata } = entry;
        // 失败回滚用：指纹与动态工具都是「旧实例还活着」的证据，失败后原样放回。
        // 只快照**本插件目录**：并发重载另一个插件成功时，它的新指纹不能被这次的失败回滚掉。
        const dirPrefix = pluginDir + path.sep;
        const hashSnapshot = new Map(
            [...this._fileHashes.entries()].filter(([k]) => k.startsWith(dirPrefix))
        );
        const dynamicToolsSnapshot = this._dynamicTools.get(name);
        let newEntryForCleanup = null;

        // #24：先让出一拍，保证 /eval 探针能应答（否则 watchdog 可能把「忙」当「死」）
        await this._yieldToEventLoop();
        await this.unload(name);
        await this._yieldToEventLoop();

        try {
            if (metadata.lang !== 'python') {
                // ⚠ 2026-11-09 三十五轮修（踩过）：只删主文件的缓存不够 ——
                //   插件常常拆成多个模块（dispatch/index.js require ./game-control.js、
                //   ./verify-contract.js、./knowledge-base.js…）。删了 index.js 的缓存，
                //   重新 load 时 require('./game-control') 拿到的**还是旧模块**。
                //   表现为：改了代码、reload 返回「已热重载」、跑起来还是旧逻辑。
                //   修法：把插件目录下所有 .js 的缓存都删掉（用 realpath 归一化，防 Windows 大小写/软链差异）。
                const mainPath = path.join(pluginDir, metadata.main || 'index.js');
                try { delete require.cache[require.resolve(mainPath)]; } catch (e) { /* 未加载过，无需删 */ }
                let purged = 0;
                try {
                    const realDir = fs.realpathSync(pluginDir);
                    for (const key of Object.keys(require.cache)) {
                        try {
                            const kf = fs.realpathSync(key);
                            if (kf.startsWith(realDir + path.sep) && /\.(c?js|mjs)$/i.test(kf)) {
                                delete require.cache[key];
                                purged += 1;
                            }
                        } catch (e) { /* 单条失败不影响其它 */ }
                    }
                } catch (e) {
                    logToTerminal('warn', `[reload] 清子模块缓存部分失败（${name}）：${e && e.message || e}`);
                }
                if (purged > 1) logToTerminal('info', `[reload] ${name} 清了 ${purged} 个模块缓存`);
            }

            await this.load(pluginDir);
            await this._yieldToEventLoop();

            // ⚠ 2026-11-09 三十五轮修「假成功」：原实现不检查 load 是否成功就
            //   `newEntry.plugin.onStart()` 并打「已热重载」日志。
            //   实际 load 内部是 try/catch 吞掉异常的，失败时 _plugins 里根本没有这个条目 →
            //   newEntry 为 undefined，onStart 静默跳过，日志照样说「已热重载」。
            //   表现：插件有语法错误 → 用户看到「热重载成功」但插件实际没在工作。
            //   现在：拿不到新条目就明确报错，并说清「插件没加载成功」。
            const newEntry = this._plugins.get(name);
            if (!newEntry) {
                const msg = `插件「${name}」卸载成功但**没能重新加载**（语法错误 / 依赖缺失 / 主文件读不到），现在是停用状态`;
                logToTerminal('error', `❌ ${msg}`);
                throw new Error(msg);
            }
            newEntryForCleanup = newEntry;
            // onStart 也可能失败 —— 同样不能吞
            try {
                await newEntry.plugin.onStart();
            } catch (e) {
                const msg = `插件「${name}」加载成功但 onStart() 抛错：${e && e.message || e}。它可能只有部分功能可用`;
                logToTerminal('error', `❌ ${msg}`);
                throw new Error(msg);
            }
            // 到这里才算真的重载成功：以磁盘现状刷新指纹基线
            try { this._recordPluginHashes(pluginDir); } catch (e) { /* 指纹失败不影响重载 */ }
            logToTerminal('info', `🔄 插件已热重载: ${name}`);
            return { ok: true, name };
        } catch (e) {
            // 失败保留旧实例（best-effort）：unload 已经停过它，但对象还在内存里。
            // 重新挂回 _plugins 并重启 onStart，至少插件仍在列表、工具面不会突然消失；
            // 指纹只回滚**本插件目录**，避免把并发重载成功的别的插件指纹一起抹掉。
            if (newEntryForCleanup && newEntryForCleanup.plugin !== entry.plugin) {
                try { await newEntryForCleanup.plugin.onStop(); } catch (e3) { /* 半初始化实例，尽力收尾 */ }
                try { await newEntryForCleanup.plugin.onDestroy(); } catch (e3) { /* 同上 */ }
            }
            for (const key of [...this._fileHashes.keys()]) {
                if (key.startsWith(dirPrefix)) this._fileHashes.delete(key);
            }
            for (const [k, v] of hashSnapshot) this._fileHashes.set(k, v);
            if (dynamicToolsSnapshot) this._dynamicTools.set(name, dynamicToolsSnapshot);
            this._plugins.set(name, entry);
            try {
                await entry.plugin.onStart();
            } catch (e2) {
                logToTerminal('warn', `[reload] 旧实例 onStart 重启失败（${name}）：${e2 && e2.message || e2}`);
            }
            logToTerminal('error', `❌ [reload] 失败，保留旧实例 ${name}: ${e && e.message || e}`);
            throw e;
        }
    }

    /**
     * 重载所有已加载的插件
     */
    async reloadAll() {
        const names = Array.from(this._plugins.keys());
        for (const name of names) {
            try {
                await this.reload(name);
            } catch (e) {
                logToTerminal('error', `❌ 热重载失败 (${name}): ${e.message}`);
            }
        }
    }

    /**
     * 同步 enabled_plugins.json 的变更：加载新启用的、卸载被禁用的
     */
    async syncEnabledPlugins() {
        logToTerminal('info', '🔄 检测到插件启用列表变更，开始同步...');

        this._loadEnabledList(true);

        const allDirs = this._scanAllPluginDirs();
        const enabledRelPaths = this._enabledPlugins;

        const currentlyLoaded = new Map();
        for (const [name, entry] of this._plugins) {
            const relPath = path.relative(this._pluginsDir, entry.pluginDir).replace(/\\/g, '/');
            currentlyLoaded.set(relPath, name);
        }

        // 卸载被禁用的插件
        for (const [relPath, name] of currentlyLoaded) {
            if (!enabledRelPaths.has(relPath)) {
                try {
                    await this.unload(name);
                    logToTerminal('info', `🔌 插件已因禁用而卸载: ${name}`);
                } catch (e) {
                    logToTerminal('error', `❌ 卸载插件失败 (${name}): ${e.message}`);
                }
            }
        }

        // 加载新启用的插件
        for (const relPath of enabledRelPaths) {
            if (currentlyLoaded.has(relPath)) continue;
            const pluginDir = allDirs.get(relPath);
            if (!pluginDir) continue;
            try {
                await this.load(pluginDir);
                const metaPath = path.join(pluginDir, 'metadata.json');
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                const newEntry = this._plugins.get(relPath);
                if (newEntry) await newEntry.plugin.onStart();
                logToTerminal('info', `🔌 插件已因启用而加载: ${meta.name}`);
            } catch (e) {
                logToTerminal('error', `❌ 加载新启用插件失败 (${relPath}): ${e.message}`);
            }
        }

        logToTerminal('info', `🔌 插件同步完成，当前共 ${this._plugins.size} 个插件`);
    }

    /**
     * 获取所有插件信息列表（供 API 使用）
     */
    getPluginList() {
        const list = [];
        for (const [id, { metadata, pluginDir }] of this._plugins) {
            list.push({
                id,
                name: id,
                pluginName: metadata.name || path.basename(pluginDir),
                displayName: metadata.displayName || metadata.name || path.basename(pluginDir),
                version: metadata.version || '?',
                lang: metadata.lang || 'js',
                dir: pluginDir,
            });
        }
        return list;
    }

    // ===== 文件监听（热加载）=====

    startWatching() {
        this._watchEnabledList();
        this._watchSourceFiles();
        logToTerminal('info', '👁️ 插件热加载监听已启动');
    }

    stopWatching() {
        if (this._enabledListWatcher) {
            this._enabledListWatcher.close();
            this._enabledListWatcher = null;
        }
        for (const w of this._sourceWatchers) {
            w.close();
        }
        this._sourceWatchers = [];
        clearTimeout(this._syncDebounceTimer);
        for (const t of this._reloadDebounceTimers.values()) clearTimeout(t);
        this._reloadDebounceTimers.clear();
        logToTerminal('info', '👁️ 插件热加载监听已停止');
    }

    /**
     * 监听 enabled_plugins.json，肥牛.exe 修改后自动同步
     */
    _watchEnabledList() {
        const listPath = path.join(this._pluginsDir, 'enabled_plugins.json');
        if (!fs.existsSync(listPath)) return;

        try {
            this._enabledListWatcher = fs.watch(listPath, () => {
                clearTimeout(this._syncDebounceTimer);
                this._syncDebounceTimer = setTimeout(() => {
                    this.syncEnabledPlugins().catch(e => {
                        logToTerminal('error', `❌ 同步插件启用列表失败: ${e.message}`);
                    });
                }, 500);
            });
        } catch (e) {
            logToTerminal('warn', `⚠️ 无法监听 enabled_plugins.json: ${e.message}`);
        }
    }

    /**
     * 监听插件源码文件变更，自动重载对应插件
     */
    /** js 语法预检：vm.Script 只解析不执行，捕捉「写了一半」的中间态与真语法错误 */
    _jsSyntaxBad(fullPath, srcOverride) {
        try {
            if (srcOverride === undefined) {
                if (!fs.existsSync(fullPath)) return true;   // 还没写出来 = 未完成
                srcOverride = fs.readFileSync(fullPath, 'utf8');
            }
            if (typeof srcOverride !== 'string') return true;
            // eslint 全局 vm 未引入，这里局部 require
            const vm = require('vm');
            const src = srcOverride;
            // #24 卡死防护（2026-11-09）：reload 会同步跑在渲染层主线程，
            // 超大文件解析可能占住主线程几百 ms（甚至因半截文件触发异常）→ 表现为「热重载卡死」。
            // 超过 2MB 的插件源码基本不可能（真出现就是误放的构建产物），直接判「未就绪」不重载。
            if (src.length > 2 * 1024 * 1024) return true;
            new vm.Script(src, { filename: fullPath });
            return false;
        } catch (e) {
            return true;   // 解析失败（SyntaxError）或读不到（写一半）都当「未就绪」
        }
    }

    /**
     * 记一个文件的成功加载指纹（2026-11-25）。
     * 只在 load()/reload() 真正成功之后调用；失败时**不写**，保证下次变更还能重试。
     */
    _rememberFileHash(fullPath, hash) {
        if (!fullPath || !hash) return false;
        this._fileHashes.set(fullPath, hash);
        return true;
    }

    /**
     * 建立/刷新插件目录的指纹基线：递归收录 .js/.mjs/.cjs/.py。
     * 顺带清掉已被删除的文件，避免同名文件重建时被误判成「内容未变」。
     */
    _recordPluginHashes(pluginDir) {
        const seen = new Set();
        const walk = (dir) => {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
            for (const ent of entries) {
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) {
                    if (ent.name === 'node_modules' || ent.name === '.git') continue;
                    walk(full);
                    continue;
                }
                if (!/\.(c?js|mjs|py)$/i.test(ent.name)) continue;
                try {
                    this._fileHashes.set(full, hashContent(fs.readFileSync(full, 'utf8')));
                    seen.add(full);
                } catch (e) { /* 单个文件读不到不影响其它 */ }
            }
        };
        walk(pluginDir);
        const prefix = pluginDir + path.sep;
        for (const key of [...this._fileHashes.keys()]) {
            if (key.startsWith(prefix) && !seen.has(key)) this._fileHashes.delete(key);
        }
        return seen.size;
    }

    /**
     * fswatch 事件的内容闸：内容与上次成功加载一致 → 跳过（返回 true）。
     * 文件被 touch / 元数据变化 / 编辑器保存无改动都走这里，不重载、不重建工具面。
     */
    _isContentUnchanged(fullPath, src, displayName) {
        if (typeof src !== 'string') return false;      // 读不到 → 当作可能变更，交给语法预检/重载处理
        const hash = hashContent(src);
        const prev = this._fileHashes.get(fullPath);
        if (prev && prev === hash) {
            dbg(`[reload] 内容未变，跳过 ${displayName || fullPath}`);
            return true;
        }
        return false;
    }

    /**
     * #24 热重载让位（2026-11-09）：reload 是同步链，主线程被占住时 /eval 探针超时 →
     * watchdog 误判「僵死」并杀进程。这里在每次重载前后主动让出事件循环一拍，
     * 保证探针有机会被响应（治的是「假僵死」，不是功能）。
     */
    async _yieldToEventLoop() {
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    _watchSourceFiles() {
        for (const baseDir of [this._builtinDir, this._communityDir]) {
            if (!fs.existsSync(baseDir)) continue;
            try {
                const watcher = fs.watch(baseDir, { recursive: true }, (eventType, filename) => {
                    if (!filename) return;
                    const ext = path.extname(filename).toLowerCase();
                    if (ext !== '.js' && ext !== '.py') return;

                    const parts = filename.replace(/\\/g, '/').split('/');
                    if (parts.length < 1) return;
                    const pluginFolderName = parts[0];

                    const source = baseDir === this._builtinDir ? 'built-in' : 'community';
                    const targetName = `${source}/${pluginFolderName}`;
                    if (!this._plugins.has(targetName)) return;

                    clearTimeout(this._reloadDebounceTimers.get(targetName));
                    this._reloadDebounceTimers.set(targetName, setTimeout(() => {
                        this._reloadDebounceTimers.delete(targetName);
                        // 语法预检：大文件分多块落盘时，500ms 防抖可能仍读到中间态——
                        // 语法没过就再等 2s 重排（最多 3 次），别把半截文件 reload 进去报一片错。
                        const full = path.join(baseDir, filename);
                        // 读一次，语法预检与内容 hash 复用同一份内容（不再各读一遍）
                        let src = null;
                        try { if (fs.existsSync(full)) src = fs.readFileSync(full, 'utf8'); } catch (e) { src = null; }
                        if (ext === '.js' && this._jsSyntaxBad(full, src === null ? undefined : src)) {
                            const tries = (this._reloadSyntaxRetries.get(targetName) || 0) + 1;
                            this._reloadSyntaxRetries.set(targetName, tries);
                            if (tries <= 3) {
                                logToTerminal('warn', `⏳ ${filename} 语法预检未过（可能是写入中），2s 后重查（${tries}/3）`);
                                clearTimeout(this._reloadDebounceTimers.get(targetName));
                                this._reloadDebounceTimers.set(targetName, setTimeout(() => {
                                    this._reloadDebounceTimers.delete(targetName);
                                    let src2 = null;
                                    try { if (fs.existsSync(full)) src2 = fs.readFileSync(full, 'utf8'); } catch (e) { src2 = null; }
                                    if (this._jsSyntaxBad(full, src2 === null ? undefined : src2)) logToTerminal('error', `❌ ${filename} 语法错误，跳过热重载（保留旧版）`);
                                    else {
                                        this._reloadSyntaxRetries.delete(targetName);
                                        // 语法过关后仍要比内容：半截写入→补全回原内容、或编辑器只改了 mtime，都别重载
                                        if (this._isContentUnchanged(full, src2, targetName)) return;
                                        const hash2 = src2 === null ? null : hashContent(src2);
                                        this.reload(targetName)
                                            .then(() => { this._rememberFileHash(full, hash2); })
                                            .catch(e => logToTerminal('error', `❌ [reload] 失败，保留旧实例 ${targetName}: ${e.message}`));
                                    }
                                }, 2000));
                                return;
                            }
                            this._reloadSyntaxRetries.delete(targetName);
                            logToTerminal('error', `❌ ${filename} 连续语法预检失败，跳过热重载（保留旧版）`);
                            return;
                        }
                        this._reloadSyntaxRetries.delete(targetName);
                        // 内容闸：fswatch 的「触碰」不停重载。内容与上次成功加载一致 →
                        // 只留一行 dbg，不重载、不重建工具面（编辑器保存无改动也走这里）。
                        if (this._isContentUnchanged(full, src, targetName)) return;
                        const contentHash = src === null ? null : hashContent(src);
                        logToTerminal('info', `👁️ 检测到源码变更: ${filename}，重载插件 ${targetName}`);
                        this.reload(targetName)
                            .then(() => { this._rememberFileHash(full, contentHash); })
                            .catch(e => {
                                // reload 内部已回滚指纹并尽力保留旧实例；这里只负责把失败摆到台面
                                logToTerminal('error', `❌ [reload] 失败，保留旧实例 ${targetName}: ${e.message}`);
                            });
                    }, 500));
                });
                this._sourceWatchers.push(watcher);
            } catch (e) {
                logToTerminal('warn', `⚠️ 无法监听插件源码目录 (${baseDir}): ${e.message}`);
            }
        }
    }

    _findPluginDir(name) {
        const entry = this._plugins.get(name);
        if (entry) return entry.pluginDir;
        for (const loaded of this._plugins.values()) {
            if (loaded.metadata.name === name || path.basename(loaded.pluginDir) === name) {
                return loaded.pluginDir;
            }
        }
        for (const baseDir of [this._builtinDir, this._communityDir]) {
            const dir = path.join(baseDir, name);
            if (fs.existsSync(dir)) return dir;
        }
        return null;
    }

    // ===== 查询 =====

    getPlugin(name) {
        const exact = this._plugins.get(name);
        if (exact) return exact.plugin;
        for (const entry of this._plugins.values()) {
            if (entry.metadata.name === name || path.basename(entry.pluginDir) === name) {
                return entry.plugin;
            }
        }
        return null;
    }

    getAllPlugins() {
        return Array.from(this._plugins.values()).map(e => e.plugin);
    }

    // ===== 启动 / 停止所有插件 =====

    async startAll() {
        for (const [name, { plugin }] of this._plugins) {
            try {
                await plugin.onStart();
            } catch (e) {
                logToTerminal('error', `❌ 插件 onStart 失败 (${name}): ${e.message}`);
            }
        }
    }

    async stopAll() {
        for (const [name, { plugin }] of this._plugins) {
            try {
                await plugin.onStop();
            } catch (e) {
                logToTerminal('error', `❌ 插件 onStop 失败 (${name}): ${e.message}`);
            }
        }
    }

    // ===== 流水线 Hook 执行 =====

    /** 记录一次钩子调用（含耗时与异常），供 getHookStats() 诊断 */
    _traceHook(pluginName, hookName, ms, error) {
        if (!this._hookStats) this._hookStats = new Map();
        const key = pluginName + '#' + hookName;
        const row = this._hookStats.get(key) || { plugin: pluginName, hook: hookName, calls: 0, errors: 0, lastMs: 0, totalMs: 0, lastError: null };
        row.calls += 1;
        row.lastMs = Math.round(ms);
        row.totalMs += ms;
        if (error) { row.errors += 1; row.lastError = String(error && error.message || error).slice(0, 200); }
        this._hookStats.set(key, row);
    }

    /** 诊断出口：哪些插件的哪些钩子被调过多少次、有没有报错 */
    getHookStats() {
        const rows = [...(this._hookStats || new Map()).values()]
            .map((r) => ({ ...r, avgMs: r.calls ? +(r.totalMs / r.calls).toFixed(2) : 0 }))
            .sort((a, b) => b.calls - a.calls);
        // 完全没被调用过任何钩子的插件（可能在空转）
        const touched = new Set(rows.map((r) => r.plugin));
        const silent = [...this._plugins.keys()].filter((id) => !touched.has(id));
        // 策略门可观测（D7）：doctor/petctl 已经在读 getHookStats，把 fail-open 计数一并带出去，
        // 否则「决策抛错 → 静默放行」这条最危险的路径在诊断面完全看不见。
        let policyStats = null;
        try { policyStats = policy.stats(); } catch (e) { policyStats = null; }
        return { hooks: rows, silentPlugins: silent, policy: policyStats };
    }

    /**
     * 执行所有插件的 onUserInput 钩子
     * @param {MessageEvent} event
     */
    async runUserInputHooks(event) {
        // 主动性预算靠这两个全局判断「她开口后你有没有反应」（2026-11-15）。
        // ⚠ 放在这里而不是 InputRouter：遥控通道（/remote/say）直接调本方法、
        //   不经过 InputRouter —— 实测那次全局时间戳恒为 0，导致所有开口都被判 ignored。
        try {
            global.__lastUserInputAt = Date.now();
            global.__lastUserText = String((event && (event.text || event.content)) || '');
        } catch (e) { /* 全局写失败不影响对话 */ }
        for (const [name, { plugin }] of this._plugins) {
            if (event._stopped) break;
            const t0 = Date.now();
            let err = null;
            try {
                await plugin.onUserInput(event);
            } catch (e) {
                err = e;
                logToTerminal('error', `❌ onUserInput 插件错误 (${name}): ${e.message}`);
            }
            this._traceHook(name, 'onUserInput', Date.now() - t0, err);
        }
    }

    /**
     * 执行所有插件的 onLLMRequest 钩子
     * @param {object} request - { messages, tools }
     *
     * ⚡ 并行化（2026-11-09，§10.2#6）：原 for...of await 串行，总时长=sum(各插件)。
     * 7 个插件实现此钩子，其中 dynamic-persona 命中时发起一次完整 LLM 调用
     *（几百 ms 到数秒），其余是同步字符串注入（<1ms）——串行下后者白叠在前面。
     * 改 Promise.allSettled：总时长=max。写入位置互不冲突（sysMsg 尾部追加 /
     * userMsg 前缀注入 / 各插件私有字段），JS 单线程同步段无竞态，语义安全。
     */
    async runLLMRequestHooks(request) {
        const jobs = [];
        for (const [name, { plugin }] of this._plugins) {
            jobs.push((async () => {
                const t0 = Date.now();
                let err = null;
                try {
                    await plugin.onLLMRequest(request);
                } catch (e) {
                    err = e;
                    logToTerminal('error', `❌ onLLMRequest 插件错误 (${name}): ${e.message}`);
                }
                this._traceHook(name, 'onLLMRequest', Date.now() - t0, err);
            })());
        }
        await Promise.allSettled(jobs);
    }

    /**
     * 执行所有插件的 onLLMResponse 钩子
     * @param {object} response - { text }
     */
    async runLLMResponseHooks(response) {
        for (const [name, { plugin }] of this._plugins) {
            // 2026-11-13：这里原来**没有 _traceHook**，而它恰恰是「她说完话之后」所有
            //   插件（persona-guard 查人设 / memory-evolve 沉淀 / companion-health 移除
            //   提示）的主战场 —— 抛错只打一行 error 日志，日志一冲就没人知道。
            //   现在和 onUserInput / onLLMRequest 一样进统计，doctor 的「插件钩子」能看见。
            const t0 = Date.now();
            let err = null;
            try {
                await plugin.onLLMResponse(response);
            } catch (e) {
                err = e;
                logToTerminal('error', `❌ onLLMResponse 插件错误 (${name}): ${e.message}`);
            }
            this._traceHook(name, 'onLLMResponse', Date.now() - t0, err);
        }
    }

    /**
     * 执行所有插件的 onTTSText 钩子，允许插件修改送入 TTS 的文本
     * @param {string} text
     * @returns {Promise<string>} 最终文本
     */
    async runTTSTextHooks(text) {
        let result = text;
        for (const [name, { plugin }] of this._plugins) {
            // 2026-11-13：补埋点 —— 表情推断（text-emotion）就在这条链上，
            //   它抛错等于「她说话永远没表情」，而原来只打一行 error 日志。
            const t0 = Date.now();
            let err = null;
            try {
                const modified = await plugin.onTTSText(result);
                if (typeof modified === 'string') result = modified;
            } catch (e) {
                err = e;
                logToTerminal('error', `❌ onTTSText 插件错误 (${name}): ${e.message}`);
            }
            this._traceHook(name, 'onTTSText', Date.now() - t0, err);
        }
        return result;
    }

    /**
     * 执行所有插件的 onTTSStart 钩子
     * @param {string} text
     */
    async runTTSStartHooks(text) {
        for (const [name, { plugin }] of this._plugins) {
            try {
                await plugin.onTTSStart(text);
            } catch (e) {
                logToTerminal('error', `❌ onTTSStart 插件错误 (${name}): ${e.message}`);
            }
        }
    }

    /** 执行所有插件的 onTTSEnd 钩子 */
    async runTTSEndHooks() {
        for (const [name, { plugin }] of this._plugins) {
            try {
                await plugin.onTTSEnd();
            } catch (e) {
                logToTerminal('error', `❌ onTTSEnd 插件错误 (${name}): ${e.message}`);
            }
        }
    }

    // ===== 工具聚合 =====

    /**
     * 合并所有插件提供的工具列表
     * @returns {Array}
     */
    getAllTools() {
        // ⚠ 工具名必须全局唯一：模型端（火山/OpenAI 兼容层）会直接 400
        //   "Invalid request: tool names must be unique"。
        //
        // 实测冲突：built-in/note 与 built-in/rag-memory 都叫 search_memory，
        // 但参数不同（note=keyword 关键词匹配；rag-memory=query 语义检索）。
        // 直接把后者丢掉会损失能力，所以这里**重命名而不是丢弃**：
        //   search_memory       → built-in/note        （内置优先，保留原名）
        //   search_memory_rag   → built-in/rag-memory  （别名，路由到原插件）
        // 别名记在 _toolAliases 里，executeTool 会按别名找回原插件与原工具名。
        const tools = [];
        const usedNames = new Set();
        const conflicts = [];
        if (!this._toolAliases) this._toolAliases = new Map();

        const sanitize = (s) => String(s || 'x').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 18) || 'x';
        // 别名后缀：取插件目录名的末段，并去掉已经在工具名里出现过的词，
        // 免得出现 search_memory_rag_memory 这种。
        const suffixOf = (pluginId, toolName) => {
            const raw = sanitize(String(pluginId).split('/').pop());
            const nameTokens = new Set(sanitize(toolName).split('_'));
            const kept = raw.split('_').filter((tok) => tok && !nameTokens.has(tok));
            return (kept.join('_') || raw).slice(0, 18);
        };

        const add = (list, ownerId) => {
            for (const tool of list) {
                if (!tool) continue;
                const fn = tool.function || tool;
                const name = fn.name;
                if (!name) continue;
                if (!usedNames.has(name)) {
                    usedNames.add(name);
                    tools.push(tool);
                    continue;
                }
                // 冲突：给这一个起别名
                const sfx = suffixOf(ownerId, name);
                let alias = name + '_' + sfx;
                let n = 2;
                while (usedNames.has(alias)) { alias = name + '_' + sfx + n; n += 1; }
                const aliasFn = Object.assign({}, fn, { name: alias });
                const aliasTool = tool.function ? Object.assign({}, tool, { function: aliasFn }) : aliasFn;
                usedNames.add(alias);
                tools.push(aliasTool);
                this._toolAliases.set(alias, { pluginId: ownerId, originalName: name });
                conflicts.push(name + ' [' + ownerId + ' → ' + alias + ']');
            }
        };

        // 内置优先：先遍历 built-in/*，再遍历其它
        const entries = [...this._plugins.entries()];
        const rank = (id) => (String(id).startsWith('built-in/') ? 0 : 1);
        entries.sort((a, b) => rank(a[0]) - rank(b[0]));

        for (const [id, { plugin }] of entries) {
            try {
                const pluginTools = plugin.getTools();
                if (Array.isArray(pluginTools)) add(pluginTools, id);
            } catch (e) {
                // 忽略单个插件错误
            }
        }
        for (const [owner, toolList] of this._dynamicTools.entries()) {
            add(toolList, owner);
        }

        if (conflicts.length && !this.__toolConflictsLogged) {
            this.__toolConflictsLogged = true;
            logToTerminal('warn', '⚠️ 工具名冲突，已自动重命名: ' + conflicts.join(', '));
        }
        return this._compactToolSchema(tools);
    }

    /**
     * 工具 schema 压缩（token 审计 2026-11-08：48 工具 schema=15k 字符，占每轮请求 83%；
     * 结构框架 ~4.9k 是 function-calling 格式固有，可压的是描述层）。
     * 规则：工具描述取第一句；参数描述 >40 字符截断（关键词写在前面所以截尾安全）；enum/type/required 全保留。
     * 能力不变：模型选工具靠「工具名+第一句+参数 enum」，长例句是冗余。config.tools.compact_schema=false 可关。
     */
    _compactToolSchema(tools) {
        let compact = true;
        try { compact = !(this._config && this._config.tools && this._config.tools.compact_schema === false); } catch (e) { try { __silentAudit.audit('plugin-manager.js:669', e); } catch (e2) {} }
        if (!compact) return tools;
        for (const t of tools) {
            const f = t && t.function;
            if (!f) continue;
            if (typeof f.description === 'string') {
                // 2026-11-14 五十三轮（审计）：原来按第一个句号截断 ——
                // 「操作电脑。click=点击（target 可以是 #编号…）」被压成「操作电脑。」，
                // action 清单全丢，模型只能瞎猜。现在：
                //   ① 第一句太短（< 24 字，通常就是「工具名。」这种废话）→ 继续吃下一句
                //   ② 总长上限 140 字（仍比原描述短一个量级）
                // 写描述的正确姿势：**action 清单放第一句**（别再用「操作电脑。」开头）。
                const src = String(f.description);
                let out = '';
                let rest = src;
                while (rest) {
                    const m = rest.match(/[。！？\n]/);
                    out += m ? rest.slice(0, m.index + 1) : rest;
                    rest = m ? rest.slice(m.index + 1) : '';
                    if (out.length >= 140 || out.length >= 24) break;
                }
                if (out.length >= 8) f.description = out.slice(0, 140);
            }
            const props = f.parameters && f.parameters.properties;
            if (props) {
                for (const k of Object.keys(props)) {
                    const p = props[k];
                    if (p && typeof p.description === 'string' && p.description.length > 40) {
                        p.description = p.description.slice(0, 40) + '…';
                    }
                }
            }
        }
        return tools;
    }

    /**
     * 路由工具调用到对应插件
     * @param {string} name - 工具名
     * @param {object} params
     * @returns {Promise<string>}
     */
    async executeTool(name, params) {
        // D7 统一策略门（2026-11-22）：高危动作一处判定。
        // ask/deny 都落成「拒绝 + 教模型带 confirm_destructive 重试」（宿主没有人工审批 UI）；
        // 每次 deny/ask 都写 data/approvals.jsonl（参数只存 hash）。
        // 策略门自身异常 fail-open —— 代码 bug 不该让 30 个工具全不可用（lastError 可查）。
        try {
            const pol = policy.decide({ tool: name, action: params && params.action, params: params || {} });
            if (pol.decision !== 'allow') {
                const denial = JSON.stringify({
                    ok: false,
                    detail: pol.reason,
                    vetoCode: 'POLICY_' + pol.decision.toUpperCase(),
                    policySource: pol.source,
                    nextIfFailed: pol.needsConfirm ? '带 confirm_destructive:true 重试（先确认后果）' : '',
                });
                // 策略拒绝也是一份「工具回执」（模型确实看到了它）：和真实返回值走同一套
                // 形状审计，否则 checked/failures 计数里完全看不到被拦下的调用。
                try { toolResult.audit(name, denial); } catch (e) { /* 审计失败不影响拒绝 */ }
                return denial;
            }
        } catch (e) {
            // fail-open 保持不变（代码 bug 不该让 30 个工具全不可用），但必须留痕：
            // 原来这里只有一个空注释 —— 策略门一旦开始抛错，所有工具会**静默**绕过
            // 安全闸，而注释里承诺的「lastError 可查」根本没被赋值。
            try { policy.noteError(e); } catch (e2) { /* 连上报都失败就只剩日志 */ }
            if (!this.__policyFailOpenLogged) {
                this.__policyFailOpenLogged = true;
                try {
                    logToTerminal('warn', '⚠️ 策略门异常，已 fail-open（本次及后续同类异常继续放行）：'
                        + String((e && e.message) || e));
                } catch (e2) { /* 日志失败不影响工具 */ }
            }
        }
        // A3 统一回执（2026-11-21）：所有工具调用都从这一个出口过一遍审计。
        // **不改变返回值形状**（28 个工具的既有契约不动），只统计
        // 「形状违规 / 失败却没给原因」——验收要求 backfilled=0、violations=0。
        const value = await this._executeToolRaw(name, params);
        try { toolResult.audit(name, value); } catch (e) { /* 审计失败不影响工具 */ }
        return value;
    }

    async _executeToolRaw(name, params) {
        // 冲突别名 → 找回原插件与原工具名
        const alias = this._toolAliases && this._toolAliases.get(name);
        if (alias) {
            const entry = this._plugins.get(alias.pluginId);
            if (entry && entry.plugin && typeof entry.plugin.executeTool === 'function') {
                return await entry.plugin.executeTool(alias.originalName, params);
            }
        }
        for (const [, { plugin }] of this._plugins) {
            const tools = plugin.getTools ? plugin.getTools() : [];
            // 兼容两种格式：{ name } 和 { function: { name } }
            if (tools.some(t => t.name === name || t.function?.name === name)) {
                return await plugin.executeTool(name, params);
            }
            // 2026-11-14 五十三轮（审计）：**旧工具名的兼容层原来不可达** ——
            //   这里只认 getTools() 声明过的名字，而合并后的插件只声明新名
            //   （如 dispatch 只声明 see/act/app/game），所以 `game_control` 这类
            //   历史名字（技能库里存的、旧提示词里的）会在这一层就「找不到提供工具的插件」。
            //   现在给插件一个显式钩子：能处理的名字自己认领。
            if (typeof plugin.handlesToolName === 'function' && plugin.handlesToolName(name)) {
                return await plugin.executeTool(name, params);
            }
        }
        throw new Error(`找不到提供工具的插件: ${name}`);
    }

    /**
     * 动态注册工具（由 PluginContext 调用）
     * @param {string} pluginName
     * @param {object} toolDef
     */
    registerDynamicTool(pluginName, toolDef) {
        if (!this._dynamicTools.has(pluginName)) {
            this._dynamicTools.set(pluginName, []);
        }
        const list = this._dynamicTools.get(pluginName);
        // 去重
        if (!list.some(t => t.name === toolDef.name)) {
            list.push(toolDef);
        }
    }

    /**
     * 注销动态工具（2026-11-15 六十三轮，运行时动作注册配套）。
     * 为什么必须有：动作按 profile 注册，换 profile 时如果只增不减，
     * 工具面会越滚越大 —— 既污染模型的选择空间，也让 tools schema 一直变（缓存也跟着废）。
     */
    unregisterDynamicTool(pluginName, name) {
        const list = this._dynamicTools.get(pluginName);
        if (!list) return 0;
        const before = list.length;
        const kept = list.filter((t) => t && t.name !== name);
        this._dynamicTools.set(pluginName, kept);
        return before - kept.length;
    }
}

module.exports = { PluginManager, hashContent };
