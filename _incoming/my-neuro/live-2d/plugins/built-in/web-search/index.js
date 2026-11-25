const { Plugin } = require('../../../js/core/plugin-base.js');
const axios = require('axios');

const TOOL_DEFINITION = {
    type: 'function',
    function: {
        name: 'web_search',
        description: '使用搜索网络引擎，并返回内容。结果多时按 offset/limit 分页，回执末尾给「续读：offset=N」。',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: '想要搜索的内容关键词'
                },
                offset: {
                    type: 'integer',
                    description: '（可续读）从第几条结果开始，默认 0；下次用回执里的 offset'
                },
                limit: {
                    type: 'integer',
                    description: '（可续读）本次最多返回几条，默认 5，上限 10'
                }
            },
            required: ['query']
        }
    }
};

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

function _pageParams(p) {
    const offset = Math.max(0, Math.floor(Number(p && p.offset) || 0));
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(p && p.limit) || DEFAULT_LIMIT)));
    return { offset, limit };
}

function _nextLine(offset, returned, total, limit) {
    const next = offset + returned;
    if (next >= total) return '';
    return '…（还有 ' + (total - next) + ' 条；续读传 offset=' + next + ' limit=' + limit + '）\n';
}

class WebSearchPlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();
        this._tavilyKey = cfg.tavily_api_key?.value || cfg.tavily_api_key || '';
        // 优先用本机 SearXNG：不要 key、不花钱、不出网（本机实例再自己去外网）。
        // 默认 18080（DSH 自带那个实例）。
        this._searx = (cfg.search_base_url && (cfg.search_base_url.value || cfg.search_base_url)) || 'http://127.0.0.1:18080';
        this._searx = String(this._searx).replace(/\/+$/, '');
    }

    getTools() {
        // 有本地 SearXNG 就不需要 key；只有两者都没有时才不注册
        return [TOOL_DEFINITION];
    }

    async executeTool(name, params) {
        if (name === 'web_search') return await this._webSearch(params);
        throw new Error(`[web-search] 不支持的工具: ${name}`);
    }

    async _webSearch({ query, offset: rawOffset, limit: rawLimit }) {
        const { offset, limit } = _pageParams({ offset: rawOffset, limit: rawLimit });
        // ① 先走本机 SearXNG
        try {
            const r = await axios.get(this._searx + '/search', {
                params: { q: query, format: 'json', language: 'zh-CN' },
                timeout: 9000,
            });
            const items = (r.data && r.data.results) || [];
            if (items.length) {
                this.context.log('info', '[web-search] SearXNG 命中 ' + items.length + ' 条: ' + query
                    + '（返回第 ' + offset + ' 起 ' + limit + ' 条）');
                const page = items.slice(offset, offset + limit);
                let out = '搜索结果（来自本机 SearXNG，共 ' + items.length + ' 条）：\n';
                page.forEach((it, i) => {
                    out += (offset + i + 1) + '. ' + String(it.title || '无标题').slice(0, 80) + '\n';
                    out += '   ' + String(it.content || '').replace(/\s+/g, ' ').slice(0, 220) + '\n';
                    out += '   ' + String(it.url || '') + '\n';
                });
                out += _nextLine(offset, page.length, items.length, limit);
                return out;
            }
            this.context.log('info', '[web-search] SearXNG 没结果，回落 Tavily');
        } catch (e) {
            this.context.log('warn', '[web-search] SearXNG 不可用（' + (e && e.message || e) + '），回落 Tavily');
        }

        if (!this._tavilyKey) return '搜索失败：本机 SearXNG 连不上，也没有配置 Tavily key。';
        try {
            this.context.log('info', `[web-search] 正在搜索: ${query}`);

            const response = await axios.post('https://api.tavily.com/search', {
                query,
                // 分页靠多取再切：Tavily 单次最多 20 条
                max_results: Math.min(20, offset + limit),
                include_answer: offset === 0,   // 摘要只在第一页有意义（省 token）
                search_depth: 'basic',
                api_key: this._tavilyKey
            });

            if (!response.data) return '错误：搜索没有返回任何结果';

            let fullContent = '';

            if (offset === 0) {
                const aiAnswer = response.data.answer || '无AI摘要';
                fullContent += `AI答案摘要：${aiAnswer}\n\n`;
            }

            const searchResults = response.data.results || [];
            const page = searchResults.slice(offset, offset + limit);
            if (page.length > 0) {
                fullContent += `详细搜索结果（共 ${searchResults.length} 条）：\n`;
                page.forEach((result, i) => {
                    const title = result.title || '无标题';
                    const content = result.content || '无内容';
                    const url = result.url || '无URL';
                    fullContent += `${offset + i + 1}. 标题：${title}\n`;
                    fullContent += `   内容：${content.substring(0, 1500)}...\n`;
                    fullContent += `   来源：${url}\n\n`;
                });
                fullContent += _nextLine(offset, page.length, searchResults.length, limit);
            } else {
                fullContent += '未找到相关搜索结果。\n';
            }

            return fullContent;

        } catch (error) {
            this.context.log('error', `[web-search] 搜索错误: ${error.message}`);
            if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
                return '错误：网络连接失败，请检查网络连接';
            }
            return `搜索过程中出现错误：${error.message}`;
        }
    }
}

module.exports = WebSearchPlugin;
