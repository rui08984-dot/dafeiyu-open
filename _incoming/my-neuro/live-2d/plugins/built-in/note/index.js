const __silentAudit = require('../../../js/core/silent-audit.js');
const { Plugin } = require('../../../js/core/plugin-base.js');
const jsonStore = require('../../../js/core/json-store.js');
const path = require('path');

class NotePlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();
        const fileName = cfg.memory_file?.value || cfg.memory_file || '用户记忆.json';
        // 记忆文件统一放 data（原来是 process.cwd() = live-2d 根，散落在应用根目录）。
        // 唯一真源见 js/core/records-path.js。
        const { RECORDS_DIR } = require('../../../js/core/records-path.js');
        this._memoryFile = path.isAbsolute(fileName) ? fileName : path.join(RECORDS_DIR, fileName);
    }

    // 工具面重塑（2026-11-14）：4 个工具 → 1 个。
    getTools() {
        return [{
            type: 'function',
            function: {
                name: 'note',
                description: '用户记忆：record 记录核心记忆（个人信息、经历、偏好、日程等，需 content）；read 读取带ID的记忆列表（count=最近N条，不传或0=全部）；search 按关键词搜索记忆（需 keyword）；delete 按ID删除记录（需 id）。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['record', 'read', 'search', 'delete'], description: '要做什么' },
                        content: { type: 'string', description: '要记录的内容' },
                        count: { type: 'number', description: '读取最近的N条记录，不传或传0则读取全部' },
                        keyword: { type: 'string', description: '搜索关键词' },
                        id: { type: 'number', description: '要删除的记录ID' },
                    },
                    required: ['action'],
                },
            },
        }];
    }

    async executeTool(name, params) {
        const p = params || {};
        if (name === 'note') {
            const a = String(p.action || '').toLowerCase();
            switch (a) {
                case 'record': return await this._recordMemory(p);
                case 'read':   return await this._readMemory(p);
                case 'search': return await this._searchMemory(p);
                case 'delete': return await this._deleteMemory(p);
                default: throw new Error('note：action 只能是 record / read / search / delete（收到「' + a + '」）');
            }
        }
        // 旧工具名保留（技能库/脚本可能直接调；新模型只看得到合并后的名字）
        switch (name) {
            case 'record_memory': return await this._recordMemory(p);
            case 'read_memory':   return await this._readMemory(p);
            case 'delete_memory': return await this._deleteMemory(p);
            case 'search_memory': return await this._searchMemory(p);
            default: throw new Error(`[note] 不支持的工具: ${name}`);
        }
    }

    _load() {
        // 统一走 json-store：解析失败会把坏文件改名隔离并返回 []（有 console.warn），
        // 而不是像原来那样 catch 掉、下一次 _save 拿空数组把整库覆盖。
        return jsonStore.readJson(this._memoryFile, []);
    }

    _save(memories) {
        // 文件坏过（本进程已隔离）就别写回：否则等于用空数据把仅剩的残骸盖掉
        if (jsonStore.isQuarantined(this._memoryFile)) {
            console.warn('[note] 记忆文件已隔离，本次不写回：' + this._memoryFile);
            return false;
        }
        jsonStore.writeJson(this._memoryFile, memories);
        return true;
    }

    _date() {
        const d = new Date();
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    }

    async _recordMemory({ content }) {
        if (!content?.trim()) return '⚠️ 记录内容不能为空';
        // 脚手架/噪音不落任何一层（2026-11-22 补漏）：note 是显式写记忆的另一条入口，
        // 本地存档 + MemOS 同步都要挡，否则「记了但记住的是程序提示词」。
        try {
            const ms = require('../../../js/core/memory-scaffold.js');
            if (ms.isScaffolding(String(content), 'user') || ms.isNoise(String(content), 'user')) {
                return '⚠️ 这条内容像程序提示词/回执，不是关于用户的事实，已跳过';
            }
        } catch (e) { /* 过滤不可用时按原样记录 */ }
        const memories = this._load();
        const newId = memories.length > 0 ? Math.max(...memories.map(m => m.id)) + 1 : 1;
        memories.push({ id: newId, date: this._date(), content });
        const saved = this._save(memories);
        // 同步进 MemOS —— 那才是长期记忆的**唯一真源**（向量 + 图谱 + 演化都在它那儿）。
        // 本地 用户记忆.json 只是人可读的存档；两边不同步会出现「记了但想不起来」。
        this._syncToMemos(content);
        if (!saved) {
            return `⚠️ 本地记忆文件损坏已隔离（${jsonStore.quarantinedPath(this._memoryFile) || '改名失败'}），` +
                `本次只同步进了 MemOS，没有写回本地存档`;
        }
        return `✅ 已记录 (ID: ${newId})`;
    }

    /** 把记忆写进 MemOS(8003)；失败不影响本地记录 */
    _syncToMemos(content) {
        try {
            const http = require('http');
            const body = Buffer.from(JSON.stringify({
                messages: [{ role: 'user', content: String(content) }],
                user_id: 'feiniu_default',
                source: 'note',   // B2 来源标注：note 插件记下的
            }), 'utf8');
            const req = http.request({
                host: '127.0.0.1', port: 8003, path: '/add', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
            }, (res) => { res.resume(); });
            req.on('error', () => {});
            req.setTimeout(15000, () => { try { req.destroy(); } catch (e) { try { __silentAudit.audit('index.js:77', e); } catch (e2) {} } });
            req.write(body); req.end();
        } catch (e) { try { __silentAudit.audit('index.js:79', e); } catch (e2) {} }
    }

    async _readMemory({ count = 0 }) {
        const memories = this._load();
        if (memories.length === 0) return '⚠️ 还没有任何记录';
        const result = count > 0 && count < memories.length ? memories.slice(-count) : memories;
        return `📝 用户记忆（共 ${memories.length} 条）：\n\n${result.map(m => `${m.id}. [${m.date}] ${m.content}`).join('\n\n')}`;
    }

    async _deleteMemory({ id }) {
        const memories = this._load();
        const index = memories.findIndex(m => m.id === id);
        if (index === -1) return `⚠️ 找不到 ID 为 ${id} 的记录`;
        const deleted = memories.splice(index, 1)[0];
        this._save(memories);
        return `✅ 已删除记录 (ID: ${id})：\n[${deleted.date}] ${deleted.content}`;
    }

    async _searchMemory({ keyword }) {
        if (!keyword?.trim()) return '⚠️ 关键词不能为空';
        const memories = this._load();
        const results = memories.filter(m => m.content.includes(keyword) || m.date.includes(keyword));
        if (results.length === 0) return `⚠️ 没有找到包含 "${keyword}" 的记录`;
        return `🔍 搜索结果（共找到 ${results.length} 条）：\n\n${results.map(m => `${m.id}. [${m.date}] ${m.content}`).join('\n\n')}`;
    }
}

module.exports = NotePlugin;
