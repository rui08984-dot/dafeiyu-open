const axios = require('axios');
const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// B2 来源标注：写入口传的是稳定代码，展示给人/模型时换成人话
const SOURCE_LABEL = {
    remember: '用户让记',
    explicit: '明确记住',
    note: '随手记',
    'watch-screen': '一起看总结',
    evolve: '反思',
    correction: '纠正',
};

// ==================== 工具定义 ====================

const TOOL_DEFINITIONS = [
    // 工具面重塑（2026-11-14）：12 个工具 → 4 个。
    // ⚠ 拆分标准（用户提醒过的一个坑）：**同一个工具里的 action 必须能用一句话概括**。
    //   第一版把 12 个合成 2 个（memory + media），但 media 的 8 个 action 混了
    //   「传图/搜图/存截图/存文件图」和「记工具用法」四类事 —— 模型调用会含糊。
    //   现在按族拆开，每个工具 ≤4 个 action。
    {
        name: 'memory',
        description: '长期记忆（关于用户的事）。search=搜记忆（问「你还记得」「之前说过」时必须用，query 要完整句子）；add=记住一件事；correct=纠正/补充/删除记忆（要 correct_action，先用 search 找 memory_id）；preferences=看用户偏好。',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['search', 'add', 'correct', 'preferences'], description: '要做什么' },
                query: { type: 'string', description: '（search）完整自然语言句子，如「用户喜欢吃什么」' },
                top_k: { type: 'integer', description: '（search）返回条数，默认 5' },
                content: { type: 'string', description: '（add）要记住的内容' },
                memory_id: { type: 'string', description: '（correct）目标记忆 id' },
                correct_action: { type: 'string', enum: ['correct', 'supplement', 'delete', 'archive', 'merge'], description: '（correct）具体怎么改：纠正/补充/删除/归档/合并（值要跟后端一致，不是 add/update）' },
                new_content: { type: 'string', description: '（correct）新内容' },
                target_memory_id: { type: 'string', description: '（correct_action=merge）要合并进哪条记忆的 id（先 search 找）' },
                reason: { type: 'string', description: '（correct）为什么改' },
                category: { type: 'string', description: '（preferences）偏好类别' },
                include_details: { type: 'boolean', description: '（preferences）是否给详细列表' },
            },
            required: ['action'],
        },
    },
    {
        name: 'image',
        description: '图片记忆。upload=传一张图（给 base64）；search=搜图（query）；save_screenshot=存当前屏幕截图；save=存本机的图片文件（file_path）。',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['upload', 'search', 'save_screenshot', 'save'], description: '要做什么' },
                image_base64: { type: 'string', description: '（upload）base64 图片' },
                description: { type: 'string', description: '（upload/save*）图片描述' },
                image_type: { type: 'string', description: 'png / jpg' },
                tags: { type: 'array', items: { type: 'string' }, description: '标签，方便以后搜' },
                query: { type: 'string', description: '（search）查询' },
                top_k: { type: 'integer', description: '（search）返回条数' },
                file_path: { type: 'string', description: '（save）本机图片路径' },
            },
            required: ['action'],
        },
    },
    {
        name: 'import',
        description: '把外部内容导入记忆（文本类）。url=导入网页（url）；document=导入本机文档（file_path，txt/pdf/md）。',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['url', 'document'], description: '要导入网页还是文档' },
                url: { type: 'string', description: '（url）网址' },
                file_path: { type: 'string', description: '（document）文档路径' },
                tags: { type: 'array', items: { type: 'string' }, description: '标签' },
            },
            required: ['action'],
        },
    },
    {
        name: 'tool_usage',
        description: '工具使用记录。record=记一次工具调用（tool_name + result_summary，重要的调用后记）；search=查以前的用法（keyword）。',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['record', 'search'], description: '要做什么' },
                tool_name: { type: 'string', description: '（record）工具名' },
                parameters: { type: 'object', description: '（record）这次调用的参数' },
                result_summary: { type: 'string', description: '（record）结果摘要' },
                category: { type: 'string', description: '（record）分类' },
                keyword: { type: 'string', description: '（search）关键词' },
                limit: { type: 'integer', description: '（search）返回条数' },
            },
            required: ['action'],
        },
    },
];

// ==================== 工具执行 ====================

class MemosTools {
    constructor(apiUrl, options = {}) {
        this.apiUrl = apiUrl;
        this.similarityThreshold = options.similarityThreshold ?? 0.6;
    }

    getDefinitions() {
        return TOOL_DEFINITIONS.map(def => ({
            type: 'function',
            function: {
                name: def.name,
                description: def.description,
                parameters: def.parameters
            }
        }));
    }

    async execute(name, params) {
        const p = params || {};
        // 工具面重塑（2026-11-14）：memory / media → 旧名字，落到下面的 _handlers。
        if (name === 'memory' || name === 'image' || name === 'import' || name === 'tool_usage') {
            const a = String(p.action || '').toLowerCase();
            // 按工具分开映射：image 的 search 和 tool_usage 的 search 指向不同的旧工具
            const MAP = {
                memory: { search: 'memos_search_memory', add: 'memos_add_memory', correct: 'memos_correct_memory', preferences: 'memos_get_preferences' },
                image: { upload: 'memos_upload_image', search: 'memos_search_images', save_screenshot: 'memos_save_screenshot', save: 'memos_save_image_from_file' },
                import: { url: 'memos_import_url', document: 'memos_import_document' },
                tool_usage: { record: 'memos_record_tool_usage', search: 'memos_search_tool_usage' },
            };
            const table = MAP[name] || {};
            const old = table[a];
            if (!old) {
                return { ok: false, error: name + '：不认识的 action「' + a + '」', available: Object.keys(table) };
            }
            const inner = Object.assign({}, p);
            if (a === 'correct') {
                // 旧 correct_memory 自己也有个 action（add/update/delete）→ 合并后必须改名
                // 否则外层 action='correct' 会把内层覆盖掉
                if (!p.correct_action) {
                    // 2026-11-14 五十三轮（审计）：提示原来写 add/update/delete ——
                    // 后端只认 correct/supplement/delete/archive/merge，照提示写必然 400。
                    return { ok: false, error: 'memory：action=correct 时要给 correct_action（correct/supplement/delete/archive/merge）', available: ['correct', 'supplement', 'delete', 'archive', 'merge'] };
                }
                inner.action = p.correct_action;
            }
            return this.execute(old, inner);
        }
        const handler = this._handlers[name];
        if (!handler) throw new Error(`[MemOS] 不支持此功能: ${name}`);
        return handler.call(this, params);
    }

    get _handlers() {
        return {
            memos_search_memory: this._searchMemory,
            memos_add_memory: this._addMemory,
            memos_upload_image: this._uploadImage,
            memos_search_images: this._searchImages,
            memos_save_screenshot: this._saveScreenshot,
            memos_save_image_from_file: this._saveImageFromFile,
            memos_record_tool_usage: this._recordToolUsage,
            memos_search_tool_usage: this._searchToolUsage,
            memos_import_url: this._importUrl,
            memos_import_document: this._importDocument,
            memos_correct_memory: this._correctMemory,
            memos_get_preferences: this._getPreferences,
        };
    }

    // ---------- helpers ----------

    _formatTime(ts) {
        if (!ts) return '';
        try {
            const d = new Date(ts);
            if (isNaN(d.getTime())) return typeof ts === 'string' ? ts : String(ts);
            return d.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            });
        } catch (_) {
            return typeof ts === 'string' ? ts : String(ts);
        }
    }

    _connRefused(error) {
        return error.code === 'ECONNREFUSED' ? '记忆系统服务未启动。' : null;
    }

    // ---------- 基础记忆 ----------

    /** 四层反向仲裁（2026-11-10）：MemOS 是「关于用户」的记忆，查不到时回落到
     *  知识库「关于世界」的规则/经验。
     *   ⚠ 不能只查 generic-desktop（那是桌面键位兜底，会把「钻石镐怎么合成」糊弄过去）：
     *   这里遍历 rules/ 下所有游戏，查询里点名的优先，再按 BM25 分合并取前 5。
     *   知识库不可用就返回空串，不影响主流程。 */
    async _knowledgeFallback(query) {
        try {
            const KB = require('../../community/dispatch/knowledge-base.js');
            const ROOT = KB.ROOT;
            if (!ROOT) return '';
            const fs = require('fs');
            const path = require('path');
            let games = [];
            try {
                games = fs.readdirSync(path.join(ROOT, 'rules'))
                    .filter((f) => /\.json$/i.test(f))
                    .map((f) => f.replace(/\.json$/i, ''));
            } catch (e) { games = []; }
            if (!games.length) return '';
            const q = String(query || '');
            // 查询里点了名的游戏排前面（只是省几毫秒，结果仍按分数合并）
            games.sort((a, b) => Number(q.includes(b)) - Number(q.includes(a)));
            const hits = [];
            for (const g of games.slice(0, 8)) {
                try {
                    const kn = await KB.getKnowledge(g, { query: q, topK: 3, withPrompt: false });
                    const got = ((kn && kn.retrieved) || []).filter((h) => h && h.text);
                    if (got.length) hits.push({ game: g, best: Number(got[0].score) || 0, list: got });
                } catch (e) { /* 单个游戏读失败不影响其它 */ }
            }
            if (!hits.length) return '';
            // 不同游戏的 BM25 分不能直接混排（实测四个游戏分差只有 0.003，混排会把
            // 「向日葵」和「木锹合成」拼在一起）。只取匹配最好的那一个游戏，再按分数截断。
            hits.sort((a, b) => b.best - a.best);
            const top = hits[0];
            const picked = top.list
                .filter((h) => (Number(h.score) || 0) >= top.best * 0.75)
                .slice(0, 4);
            if (!picked.length) return '';
            const lines = picked.map((h, i) => `${i + 1}. ${String(h.text).slice(0, 140)}`).join('\n');
            return `\n\n记忆里没有，但**知识库《${top.game}》**里有 ${picked.length} 条相关（世界知识/攻略，不是用户记忆）：\n${lines}`;
        } catch (e) { return ''; }
    }

    async _searchMemory({ query, top_k = 5 }) {
        if (!query) return '错误：未提供搜索查询 (query)。';
        try {
            const { data } = await axios.post(`${this.apiUrl}/search`, {
                query, top_k, user_id: 'feiniu_default',
                similarity_threshold: this.similarityThreshold
            }, { timeout: 5000 });
            const memories = data.memories || [];
            if (memories.length === 0) {
                return `在记忆中没有找到关于"${query}"的相关信息。` + await this._knowledgeFallback(query);
            }

            const lines = memories.map((mem, i) => {
                const content = typeof mem === 'string' ? mem : mem.content;
                const pl = mem && typeof mem.payload === 'object' && mem.payload ? mem.payload : null;
                const rawCreated = mem.created_at || mem.timestamp || (pl && (pl.created_at || pl.timestamp));
                const rawUpdated = mem.updated_at || (pl && pl.updated_at);
                const timeStr = this._formatTime(rawCreated);
                const updateMark = (rawUpdated && rawUpdated !== rawCreated) ? '（已更新）' : '';
                const idTag = mem.id ? ` [ID: ${mem.id}]` : '';
                // B2 来源标注：让模型知道这条是用户让记的、随手记的，还是反思/一起看总结的
                const sourceCode = mem.source || (pl && pl.source) || '';
                const sourceLabel = sourceCode ? (SOURCE_LABEL[sourceCode] || String(sourceCode).slice(0, 12)) : '';
                const srcTag = sourceLabel ? `【来源:${sourceLabel}】` : '';
                const head = timeStr ? `${i + 1}. ${content} 【${timeStr}】${updateMark}${srcTag}${idTag}` : `${i + 1}. ${content}${srcTag}${idTag}`;
                return head;
            });
            return `找到 ${memories.length} 条相关记忆：\n${lines.join('\n')}`;
        } catch (error) {
            const base = this._connRefused(error) || `搜索记忆时出错: ${error.message}`;
            return base + await this._knowledgeFallback(query);
        }
    }

    async _addMemory({ content }) {
        if (!content) return '错误：未提供要记住的内容 (content)。';
        // 脚手架/噪音不进长期记忆（2026-11-22 补漏）：显式 memory add 也是 /add 的一条入口，
        // 模型可能把对话里的程序提示词原样搬进来。判定沿用唯一真源，失败放行（不丢真内容）。
        try {
            const ms = require('../../../js/core/memory-scaffold.js');
            if (ms.isScaffolding(String(content), 'user') || ms.isNoise(String(content), 'user')) {
                return '这条内容像程序提示词/回执，不是关于用户的事实，已跳过（未写入长期记忆）。';
            }
        } catch (e) { /* 过滤不可用时按原样写入 */ }
        try {
            await axios.post(`${this.apiUrl}/add`, {
                messages: [{ role: 'user', content }],
                user_id: 'feiniu_default',
                source: 'explicit',
            }, { timeout: 60000 });
            return `已成功记住: ${content}`;
        } catch (error) {
            return this._connRefused(error) || `添加记忆时出错: ${error.message}`;
        }
    }

    // ---------- 图片记忆 ----------

    async _uploadImage({ image_base64, description, image_type = 'other', tags = [] }) {
        if (!image_base64) return '错误：未提供图片数据 (image_base64)。';
        if (!description) return '错误：未提供图片描述 (description)。';
        try {
            const { data } = await axios.post(`${this.apiUrl}/images/upload`, { image_base64, description, image_type, tags, user_id: 'feiniu_default' }, { timeout: 30000 });
            return `已成功保存图片「${description}」，图片ID: ${data.image_id || '已生成'}`;
        } catch (error) {
            return this._connRefused(error) || `保存图片时出错: ${error.message}`;
        }
    }

    async _searchImages({ query, image_type, top_k = 5 }) {
        if (!query) return '错误：未提供搜索查询 (query)。';
        try {
            const reqData = { query, top_k, user_id: 'feiniu_default' };
            if (image_type) reqData.image_type = image_type;
            const { data } = await axios.post(`${this.apiUrl}/images/search`, reqData, { timeout: 10000 });
            const images = data.images || [];
            if (images.length === 0) return `没有找到关于「${query}」的图片记忆。`;

            const lines = images.map((img, i) => {
                const desc = img.description || '无描述';
                const type = img.image_type || 'unknown';
                const time = img.created_at ? new Date(img.created_at).toLocaleDateString('zh-CN') : '';
                const t = img.tags?.length > 0 ? `[${img.tags.join(', ')}]` : '';
                return `${i + 1}. 【${type}】${desc} ${t}${time ? ` (${time})` : ''}`;
            });
            return `找到 ${images.length} 张相关图片：\n${lines.join('\n')}`;
        } catch (error) {
            return this._connRefused(error) || `搜索图片时出错: ${error.message}`;
        }
    }

    async _saveScreenshot({ description, tags = [] }) {
        if (!description) return '错误：未提供截图描述 (description)。';
        try {
            const base64Image = await ipcRenderer.invoke('take-screenshot');
            if (!base64Image) return '错误：截图失败，未能获取屏幕图像。';

            const { data } = await axios.post(`${this.apiUrl}/images/upload`, {
                image_base64: base64Image, description, image_type: 'screenshot', tags, user_id: 'feiniu_default'
            }, { timeout: 30000 });
            return `已成功截取屏幕并保存到记忆！\n描述：${description}\n图片ID：${data.image_id || '已生成'}`;
        } catch (error) {
            if (error.message?.includes('invoke')) return '截图功能不可用，可能是 Electron 环境问题。';
            return this._connRefused(error) || `保存截图时出错: ${error.message}`;
        }
    }

    async _saveImageFromFile({ file_path, description, image_type = 'photo', tags = [] }) {
        if (!file_path) return '错误：未提供图片文件路径 (file_path)。';
        if (!description) return '错误：未提供图片描述 (description)。';
        try {
            if (!fs.existsSync(file_path)) return `错误：文件不存在: ${file_path}`;
            const ext = path.extname(file_path).toLowerCase();
            const supported = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
            if (!supported.includes(ext)) return `错误：不支持的图片格式 (${ext})。支持：${supported.join(', ')}`;

            const imageBuffer = fs.readFileSync(file_path);
            const base64Image = imageBuffer.toString('base64');
            const filename = path.basename(file_path);

            const { data } = await axios.post(`${this.apiUrl}/images/upload`, {
                image_base64: base64Image, filename, description, image_type, tags, user_id: 'feiniu_default'
            }, { timeout: 30000 });
            return `已成功保存图片到记忆！\n文件：${filename}\n描述：${description}\n图片ID：${data.image_id || '已生成'}`;
        } catch (error) {
            if (error.code === 'ENOENT') return `错误：无法读取文件: ${file_path}`;
            return this._connRefused(error) || `保存图片时出错: ${error.message}`;
        }
    }

    // ---------- 工具使用记录 ----------

    async _recordToolUsage({ tool_name, parameters: toolParams = {}, result_summary, category = 'other' }) {
        if (!tool_name) return '错误：未提供工具名称 (tool_name)。';
        if (!result_summary) return '错误：未提供结果摘要 (result_summary)。';
        try {
            await axios.post(`${this.apiUrl}/tools/record`, { tool_name, parameters: toolParams, result_summary, category, user_id: 'feiniu_default' }, { timeout: 5000 });
            return `已记录工具「${tool_name}」的使用`;
        } catch (error) {
            return this._connRefused(error) || `记录工具使用时出错: ${error.message}`;
        }
    }

    async _searchToolUsage({ tool_name, keyword, limit = 10 }) {
        try {
            const { data } = await axios.get(`${this.apiUrl}/tools/recent`, { params: { tool_name: tool_name || undefined, limit }, timeout: 5000 });
            let records = data.records || [];
            if (keyword && records.length > 0) {
                const kw = keyword.toLowerCase();
                records = records.filter(r =>
                    r.tool_name?.toLowerCase().includes(kw) ||
                    r.result_summary?.toLowerCase().includes(kw) ||
                    (r.parameters && JSON.stringify(r.parameters).toLowerCase().includes(kw))
                );
            }
            if (records.length === 0) {
                const hints = [tool_name && `工具「${tool_name}」`, keyword && `关键词「${keyword}」`].filter(Boolean);
                return hints.length > 0 ? `没有找到匹配 ${hints.join('、')} 的工具使用记录。` : '没有找到工具使用记录。';
            }

            const lines = records.map((r, i) => {
                const name = r.tool_name || 'unknown';
                const summary = r.result_summary || '无摘要';
                const time = r.timestamp ? new Date(r.timestamp).toLocaleString('zh-CN') : '';
                let p = '';
                if (r.parameters) {
                    const paramStr = JSON.stringify(r.parameters);
                    p = paramStr.length > 50 ? ` (参数: ${paramStr.substring(0, 50)}...)` : ` (参数: ${paramStr})`;
                }
                return `${i + 1}. 【${name}】${summary}${p}${time ? ` - ${time}` : ''}`;
            });
            return `找到 ${records.length} 条工具使用记录：\n${lines.join('\n')}`;
        } catch (error) {
            return this._connRefused(error) || `搜索工具记录时出错: ${error.message}`;
        }
    }

    // ---------- 知识库导入 ----------

    async _importUrl({ url, tags = [] }) {
        if (!url) return '错误：未提供网页 URL。';
        if (!url.startsWith('http://') && !url.startsWith('https://')) return '错误：URL 必须以 http:// 或 https:// 开头。';
        try {
            const { data } = await axios.post(`${this.apiUrl}/kb/import`, { source: url, tags: ['web', ...tags], user_id: 'feiniu_default' }, { timeout: 60000 });
            if (data.status === 'success') return `已成功导入网页内容！\n- URL: ${url}\n- 分块数: ${data.chunks_count || 0}\n- 导入记忆: ${data.imported_count || 0} 条`;
            return `导入失败: ${data.message || '未知错误'}`;
        } catch (error) {
            if (error.response?.status === 503) return '文档加载器未初始化，无法导入网页。';
            return this._connRefused(error) || `导入网页时出错: ${error.message}`;
        }
    }

    async _importDocument({ file_path, tags = [] }) {
        if (!file_path) return '错误：未提供文档路径。';
        try {
            if (!file_path.startsWith('http://') && !file_path.startsWith('https://')) {
                if (!fs.existsSync(file_path)) return `错误：文件不存在: ${file_path}`;
                const ext = path.extname(file_path).toLowerCase();
                const supported = ['.txt', '.pdf', '.md'];
                if (!supported.includes(ext)) return `错误：不支持的文档格式 (${ext})。支持：${supported.join(', ')}`;
            }
            const { data } = await axios.post(`${this.apiUrl}/kb/import`, { source: file_path, tags: ['document', ...tags], user_id: 'feiniu_default' }, { timeout: 120000 });
            if (data.status === 'success') return `已成功导入文档！\n- 路径: ${file_path}\n- 分块数: ${data.chunks_count || 0}\n- 导入记忆: ${data.imported_count || 0} 条`;
            return `导入失败: ${data.message || '未知错误'}`;
        } catch (error) {
            if (error.response?.status === 503) return '文档加载器未初始化，无法导入文档。';
            return this._connRefused(error) || `导入文档时出错: ${error.message}`;
        }
    }

    // ---------- 记忆修正 ----------

    _warnLocal(msg) {
        try { console.warn('[memos] 本地记忆同步：' + msg); } catch (e) { /* console 不可用也不抛 */ }
    }

    /**
     * B1 记忆纠正写穿（2026-11-22）：MemOS 纠正成功后，同步本地「data/用户记忆.json」。
     *
     * 为什么必须做：memory-recall 的注入读本地 用户记忆.json / 事实层，只改 MemOS 不够 ——
     * 用户说「不对，是…」之后，旧说法还会从本地存档继续被注入。
     *
     * 按 correct_action：
     *   correct    旧正文进墓碑；本地匹配条目改成 new_content（找不到就追加一条）
     *   supplement 不墓碑旧值；追加 new_content（已存在则跳过）
     *   delete / archive 旧正文进墓碑；本地匹配条目删除
     *   merge      旧正文进墓碑；本地匹配条目改成目标正文（响应 target_content；
     *              拿不到就跳过并 warn —— 不拿 merged_content 硬拆，避免猜）
     * 响应没有 old_content（旧后端）：不猜、不墓碑，只做能做的（supplement 追加），
     * 并在返回文案里说明「旧文未知」。
     *
     * 匹配规则与遗忘墓碑同一套归一化；包含匹配要求两边都 ≥6 字（短串只做精确匹配，
     * 否则纠正一个「猫」会把整库含「猫」的条目全改掉）。
     *
     * 写盘走 json-store（原子写、坏文件隔离后拒绝写回）；任何失败只 warn，
     * 不 throw、不阻断 MemOS 已成功的纠正。
     */
    _syncLocalCorrection(info) {
        const i = info || {};
        const action = String(i.action || '');
        const pick = (v) => (typeof v === 'string' ? v.trim() : '');
        const oldText = pick(i.old_content);
        const newText = pick(i.new_content);
        const targetText = pick(i.target_content);

        const fail = (reason) => {
            const msg = String(reason || '未知错误');
            this._warnLocal(msg);
            return { ok: false, status: 'failed', tombstoned: 0, changed: 0, line: '\n- 本地同步失败（' + msg + '）' };
        };
        const oldUnknownNote = '；旧文未知（响应未带 old_content），未墓碑旧说法';
        const unknown = () => ({
            ok: true, status: 'unknown', tombstoned: 0, changed: 0,
            line: '\n- 本地未同步' + oldUnknownNote,
        });

        let T, jsonStore, file;
        try {
            T = require('../../../js/core/forget-tombstones.js');
            jsonStore = require('../../../js/core/json-store.js');
            file = require('../../../js/core/records-path.js').recordFile('用户记忆.json');
        } catch (e) {
            return fail('加载本地存储模块失败：' + ((e && e.message) || e));
        }

        // 墓碑先写：即使本地用户记忆文件坏了，旧说法也不再被注入。
        // supplement 是「补充」不是否定 —— 旧值仍然成立，不能墓碑（否则补充会把自己隐藏掉）。
        let tombstoned = 0;
        if (oldText && action !== 'supplement') {
            try { tombstoned = T.add([oldText], { source: 'correction' }); }
            catch (e) { this._warnLocal('写遗忘墓碑失败：' + ((e && e.message) || e)); }
        }
        const tombLine = tombstoned > 0 ? '，墓碑 +' + tombstoned : (oldText && action !== 'supplement' ? '，旧说法已在墓碑中' : '');

        // 没旧文就不知道改/删哪条 —— 不猜（supplement 不依赖旧文，继续走追加）。
        if (!oldText && action !== 'supplement') return unknown();

        if (action === 'merge' && !targetText) {
            this._warnLocal('merge 响应没有 target_content（目标记忆正文），本地条目未改写');
            return {
                ok: true, status: 'partial', tombstoned, changed: 0,
                line: '\n- 本地部分同步：旧说法' + (tombstoned > 0 ? '已进墓碑' : '已在墓碑中') +
                    '，但响应缺少目标正文（target_content），本地条目未改写',
            };
        }
        if (action === 'supplement' && !newText) return fail('补充内容为空，无法追加到本地用户记忆');

        // 读本地存档：坏文件由 json-store 改名隔离（readJson 返回 null），绝不拿空表覆盖。
        let arr;
        try {
            const loaded = jsonStore.readJson(file, null);
            if (jsonStore.isQuarantined(file)) {
                return fail('本地用户记忆文件损坏，已隔离为 ' +
                    (jsonStore.quarantinedPath(file) || '（改名失败）') + '，本次未写回');
            }
            if (loaded === null) arr = [];
            else if (Array.isArray(loaded)) arr = loaded;
            else return fail('本地用户记忆不是数组（格式异常），未写回');
        } catch (e) {
            return fail('读本地用户记忆失败：' + ((e && e.message) || e));
        }

        const norm = (v) => T.normalize(v);
        const oldNorm = norm(oldText);
        const MIN_CONTAINS = 6;
        const isMatch = (entry) => {
            const c = norm(entry && entry.content);
            if (!c || !oldNorm) return false;
            if (c === oldNorm) return true;
            if (c.length >= MIN_CONTAINS && oldNorm.length >= MIN_CONTAINS) {
                return c.includes(oldNorm) || oldNorm.includes(c);
            }
            return false;
        };

        const today = () => {
            const d = new Date();
            return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
        };
        const nextId = () => {
            let max = 0;
            for (const it of arr) {
                const n = Number(it && it.id);
                if (Number.isFinite(n) && n > max) max = n;
            }
            return max + 1;
        };
        const hasSame = (text) => {
            const n = norm(text);
            if (!n) return false;
            return arr.some((it) => norm(it && it.content) === n);
        };
        const write = () => {
            try { jsonStore.writeJson(file, arr); }
            catch (e) { return fail('写回本地用户记忆失败：' + ((e && e.message) || e)); }
            return null;
        };
        const done = (detail) => ({
            ok: true, status: 'synced', tombstoned,
            changed: Number((detail && detail.changed) || 0),
            line: '\n- 本地已同步（' + detail.text + tombLine + (oldText ? '' : oldUnknownNote) + '）',
        });

        let changed = 0;
        let removed = 0;

        if (action === 'correct') {
            for (const it of arr) {
                if (!it || typeof it !== 'object' || !isMatch(it)) continue;
                it.content = newText;
                changed += 1;
            }
            if (!changed) {
                // 本地没这条（MemOS 里可能是自动提炼的）→ 追加新说法，保证本地也有正确版本
                arr.push({ id: nextId(), date: today(), content: newText, source: 'correction' });
                changed = 1;
                const bad = write();
                if (bad) return bad;
                return done({ changed, text: '本地未匹配到旧说法，已追加新内容' });
            }
        } else if (action === 'supplement') {
            if (hasSame(newText)) return done({ changed: 0, text: '新内容本地已存在，无需重复追加' });
            arr.push({ id: nextId(), date: today(), content: newText, source: 'correction' });
            changed = 1;
        } else if (action === 'delete' || action === 'archive') {
            const kept = [];
            for (const it of arr) {
                if (it && typeof it === 'object' && isMatch(it)) { removed += 1; continue; }
                kept.push(it);
            }
            if (removed) { arr = kept; changed = removed; }
        } else if (action === 'merge') {
            for (const it of arr) {
                if (!it || typeof it !== 'object' || !isMatch(it)) continue;
                it.content = targetText;
                changed += 1;
            }
        } else {
            return fail('未知的 correct_action「' + action + '」，本地未同步');
        }

        if (changed) {
            const bad = write();
            if (bad) return bad;
        }

        if (action === 'delete' || action === 'archive') {
            return {
                ok: true, status: 'synced', tombstoned, changed,
                line: '\n- 本地已同步（' + (removed ? '删除本地条目 ' + removed + ' 条' : '本地无匹配条目') + tombLine + '）',
            };
        }
        return done({ changed, text: changed ? ('用户记忆更新 ' + changed + ' 条') : '本地无匹配条目' });
    }

    async _correctMemory({ memory_id, action, new_content, reason, target_memory_id }) {
        if (!memory_id) return '错误：未提供记忆 ID。请先调用 memory 工具的 search 动作搜索并获取记忆 ID。';
        if (!action) return '错误：未指定操作类型。可选：correct、supplement、delete、archive、merge';
        if ((action === 'correct' || action === 'supplement') && !new_content) {
            return `错误：${action === 'correct' ? '修正' : '补充'}操作需要提供 new_content。`;
        }
        if (action === 'merge' && !target_memory_id) {
            // 2026-11-14 五十三轮（审计）：merge 的后端字段是 correction（= 目标记忆 ID），
            // 原来永远不带 → 必然失败，而错误只说「请指定目标记忆 ID」，不说从哪来。
            return '错误：merge 需要 target_memory_id（要合并进哪条记忆的 ID）。先用 search 找到目标记忆的 ID。';
        }
        try {
            const reqData = { memory_id, feedback_type: action, reason: reason || '', user_id: 'feiniu_default' };
            if (action === 'correct' || action === 'supplement') reqData.correction = new_content;
            if (action === 'merge') reqData.correction = target_memory_id;

            const { data } = await axios.post(`${this.apiUrl}/memory/feedback`, reqData, { timeout: 10000 });
            if (data.status === 'success') {
                const actionName = { correct: '修正', supplement: '补充', delete: '删除', archive: '归档', merge: '合并' }[action] || action;
                // B1（2026-11-22）：MemOS 改成功后再同步本地存档（失败只 warn，不影响已成功的纠正）。
                const local = this._syncLocalCorrection({
                    action,
                    memory_id,
                    new_content,
                    target_memory_id,
                    old_content: data.old_content,
                    target_content: data.target_content,
                });
                const localLine = (local && local.line) || '';
                if (action === 'delete') return `已成功删除记忆 (ID: ${memory_id})` + localLine;
                if (action === 'archive') return `已成功归档记忆 (ID: ${memory_id})` + localLine;
                return `已成功${actionName}记忆！\n- ID: ${memory_id}\n- 新内容: ${data.new_content || new_content}` + localLine;
            }
            return `操作失败: ${data.message || '未知错误'}`;
        } catch (error) {
            if (error.response?.status === 404) return `记忆 ID「${memory_id}」不存在，请确认 ID 是否正确。`;
            return this._connRefused(error) || `修正记忆时出错: ${error.message}`;
        }
    }

    // ---------- 偏好查询 ----------

    async _getPreferences({ category, include_details = true }) {
        try {
            const summaryParams = { user_id: 'feiniu_default' };
            if (category) summaryParams.category = category;
            const { data: summaryData } = await axios.get(`${this.apiUrl}/preferences/summary`, { params: summaryParams, timeout: 5000 });
            const summary = summaryData.summary || {};

            let preferences = [];
            if (include_details) {
                const listParams = { user_id: 'feiniu_default' };
                if (category) listParams.category = category;
                const { data: listData } = await axios.get(`${this.apiUrl}/preferences`, { params: listParams, timeout: 5000 });
                preferences = listData.preferences || [];
            }

            const totalCount = summary.total_count || 0;
            if (totalCount === 0) return '目前没有记录用户的偏好信息。';

            const result = [`用户偏好摘要：共 ${totalCount} 个偏好，涉及 ${summary.category_count || 0} 个类别`];

            const categories = summary.categories || {};
            if (Object.keys(categories).length > 0) {
                const catLabels = { food: '食物', music: '音乐', game: '游戏', movie: '电影', hobby: '爱好', style: '风格', schedule: '日程', general: '一般' };
                result.push('类别分布: ' + Object.entries(categories).map(([c, n]) => `${catLabels[c] || c}: ${n}`).join(', '));
            }

            if (include_details && preferences.length > 0) {
                result.push('\n偏好详情:');
                const likes = preferences.filter(p => (p.preference_type || p.type) === 'like');
                const dislikes = preferences.filter(p => (p.preference_type || p.type) === 'dislike');

                if (likes.length > 0) {
                    result.push('喜欢:');
                    likes.slice(0, 10).forEach((p, i) => {
                        const conf = ((p.confidence || p.strength || 0.8) * 100).toFixed(0);
                        result.push(`  ${i + 1}. ${p.item || p.name || '未知'} [${p.category || 'general'}] (置信度: ${conf}%)`);
                    });
                    if (likes.length > 10) result.push(`  ... 还有 ${likes.length - 10} 个`);
                }
                if (dislikes.length > 0) {
                    result.push('不喜欢:');
                    dislikes.slice(0, 10).forEach((p, i) => {
                        const conf = ((p.confidence || p.strength || 0.8) * 100).toFixed(0);
                        result.push(`  ${i + 1}. ${p.item || p.name || '未知'} [${p.category || 'general'}] (置信度: ${conf}%)`);
                    });
                    if (dislikes.length > 10) result.push(`  ... 还有 ${dislikes.length - 10} 个`);
                }
            }

            return result.join('\n');
        } catch (error) {
            return this._connRefused(error) || `获取偏好时出错: ${error.message}`;
        }
    }
}

module.exports = { MemosTools };
