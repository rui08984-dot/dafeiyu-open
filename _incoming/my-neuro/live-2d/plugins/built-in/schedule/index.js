const { Plugin } = require('../../../js/core/plugin-base.js');
const jsonStore = require('../../../js/core/json-store.js');
const fs = require('fs');
const path = require('path');

class SchedulePlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();
        const fileName = cfg.schedule_file?.value || cfg.schedule_file || '日程表.json';
        // 日程文件统一放 data（原来用 process.cwd() = live-2d 根，和「记忆」不在一处）。
        // 唯一真源见 js/core/records-path.js。
        const { RECORDS_DIR } = require('../../../js/core/records-path.js');
        this._scheduleFile = path.isAbsolute(fileName) ? fileName : path.join(RECORDS_DIR, fileName);
        const dir = path.dirname(this._scheduleFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        this._migrateFromCwd(fileName);
    }

    /** 一次性迁移：老版本把日程写在 process.cwd()，换目录后不能让它「凭空消失」 */
    _migrateFromCwd(fileName) {
        try {
            const oldPath = path.resolve(process.cwd(), fileName);
            if (oldPath === path.resolve(this._scheduleFile)) return;   // 配置本来就是 ../data
            if (fs.existsSync(this._scheduleFile) || !fs.existsSync(oldPath)) return;
            fs.renameSync(oldPath, this._scheduleFile);
            console.warn('[schedule] 已把旧日程从 ' + oldPath + ' 迁到 ' + this._scheduleFile);
        } catch (e) {
            console.warn('[schedule] 旧日程迁移失败（' + (e && e.message) + '）；新数据仍写 data');
        }
    }

    // 工具面重塑（2026-11-14）：6 个工具 → 1 个。
    // add/list/complete/delete/search/edit 是同一个 CRUD，模型原来要在 6 个名字里选。
    getTools() {
        return [{
            type: 'function',
            function: {
                name: 'schedule',
                description: '日程管理。add=加一条（title+time 必填）；list=看列表（filter: all/pending/done，默认 pending）；complete=标记完成（id）；delete=删（id）；search=找（keyword）；edit=改（id + 要改的字段）。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['add', 'list', 'complete', 'delete', 'search', 'edit'], description: '要做什么' },
                        title: { type: 'string', description: '（add/edit）标题，简短' },
                        time: { type: 'string', description: '（add/edit）时间，如「明天下午3点」「2026-04-05 14:00」「待定」' },
                        note: { type: 'string', description: '（add/edit，可选）备注' },
                        id: { type: 'integer', description: '（complete/delete/edit）日程 ID（数字），从 list 里看' },
                        filter: { type: 'string', enum: ['all', 'pending', 'done'], description: '（list）过滤，默认 pending' },
                        keyword: { type: 'string', description: '（search）关键词' },
                    },
                    required: ['action'],
                },
            },
        }];
    }

    async executeTool(name, params) {
        const p = params || {};
        if (name === 'schedule') {
            const a = String(p.action || '').toLowerCase();
            switch (a) {
                case 'add': return await this._add(p);
                case 'list': return await this._list(p);
                case 'complete': return await this._complete(p);
                case 'delete': return await this._delete(p);
                case 'search': return await this._search(p);
                case 'edit': return await this._edit(p);
                default: throw new Error('schedule：action 只能是 add / list / complete / delete / search / edit（收到「' + a + '」）');
            }
        }
        // 旧工具名保留（技能库/脚本可能直接调）
        switch (name) {
            case 'add_schedule':      return await this._add(p);
            case 'list_schedule':     return await this._list(p);
            case 'complete_schedule': return await this._complete(p);
            case 'delete_schedule':   return await this._delete(p);
            case 'search_schedule':   return await this._search(p);
            case 'edit_schedule':     return await this._edit(p);
            default: throw new Error(`[schedule] 不支持的工具: ${name}`);
        }
    }

    _load() {
        // 统一走 json-store：解析失败会把坏文件改名隔离并返回 []（有 console.warn），
        // 而不是像原来那样 catch 掉、下一次 _save 拿空数组把整库覆盖。
        return jsonStore.readJson(this._scheduleFile, []);
    }

    _save(list) {
        // 文件坏过（本进程已隔离）就别写回：否则等于用空数据把仅剩的残骸盖掉
        if (jsonStore.isQuarantined(this._scheduleFile)) {
            console.warn('[schedule] 日程文件已隔离，本次不写回：' + this._scheduleFile);
            return false;
        }
        jsonStore.writeJson(this._scheduleFile, list);
        return true;
    }

    _today() {
        const d = new Date();
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    }

    _nextId(list) {
        return list.length > 0 ? Math.max(...list.map(s => s.id)) + 1 : 1;
    }

    _fmt(item) {
        const status = item.done ? '✅' : '⏳';
        const note = item.note ? `  备注：${item.note}` : '';
        return `${status} [ID:${item.id}] ${item.title}  🕐 ${item.time}${note}`;
    }

    async _add({ title, time, note }) {
        if (!title?.trim()) return '⚠️ 日程标题不能为空';
        const list = this._load();
        const item = {
            id: this._nextId(list),
            title: title.trim(),
            time: time?.trim() || '待定',
            note: note?.trim() || '',
            done: false,
            created_at: this._today()
        };
        list.push(item);
        if (!this._save(list)) {
            return `⚠️ 日程文件损坏已隔离（${jsonStore.quarantinedPath(this._scheduleFile) || '改名失败'}），` +
                `本条日程没有写回磁盘`;
        }
        return `✅ 日程已记录 (ID: ${item.id})\n${this._fmt(item)}`;
    }

    async _list({ filter = 'pending' } = {}) {
        const list = this._load();
        if (list.length === 0) return '⚠️ 还没有任何日程';

        let filtered;
        if (filter === 'done')    filtered = list.filter(s => s.done);
        else if (filter === 'all') filtered = list;
        else                       filtered = list.filter(s => !s.done);

        if (filtered.length === 0) {
            const label = filter === 'done' ? '已完成' : '未完成';
            return `⚠️ 没有${label}的日程`;
        }

        const label = filter === 'done' ? '已完成' : filter === 'all' ? '全部' : '未完成';
        return `📅 日程列表（${label}，共 ${filtered.length} 条）：\n\n${filtered.map(s => this._fmt(s)).join('\n')}`;
    }

    async _complete({ id }) {
        const list = this._load();
        const item = list.find(s => s.id === id);
        if (!item) return `⚠️ 找不到 ID 为 ${id} 的日程`;
        if (item.done) return `⚠️ ID ${id} 的日程已经是完成状态了`;
        item.done = true;
        item.done_at = this._today();
        this._save(list);
        return `✅ 已完成：${item.title}（ID: ${id}）`;
    }

    async _delete({ id }) {
        const list = this._load();
        const index = list.findIndex(s => s.id === id);
        if (index === -1) return `⚠️ 找不到 ID 为 ${id} 的日程`;
        const deleted = list.splice(index, 1)[0];
        this._save(list);
        return `🗑️ 已删除：${deleted.title}（ID: ${id}）`;
    }

    async _search({ keyword }) {
        if (!keyword?.trim()) return '⚠️ 关键词不能为空';
        const list = this._load();
        const results = list.filter(s =>
            s.title.includes(keyword) ||
            s.time.includes(keyword) ||
            (s.note && s.note.includes(keyword))
        );
        if (results.length === 0) return `⚠️ 没有找到包含"${keyword}"的日程`;
        return `🔍 搜索结果（共 ${results.length} 条）：\n\n${results.map(s => this._fmt(s)).join('\n')}`;
    }

    async _edit({ id, title, time, note }) {
        const list = this._load();
        const item = list.find(s => s.id === id);
        if (!item) return `⚠️ 找不到 ID 为 ${id} 的日程`;
        if (title !== undefined) item.title = title.trim();
        if (time  !== undefined) item.time  = time.trim();
        if (note  !== undefined) item.note  = note.trim();
        this._save(list);
        return `✏️ 已更新（ID: ${id}）\n${this._fmt(item)}`;
    }
}

module.exports = SchedulePlugin;
