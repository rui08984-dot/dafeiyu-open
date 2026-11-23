const { Plugin } = require('../../../js/core/plugin-base.js');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SUPPORTED_FORMATS = ['.mp3', '.wav', '.m4a', '.ogg'];

class MusicPlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();
        this._port = cfg.port?.value ?? cfg.port ?? 3001;
        this._musicFolder = path.join(__dirname, '../../../song-library/output');
    }

    // 工具面重塑（2026-11-14）：4 个工具 → 1 个。
    // 原来 play_random_music / stop_music / list_music_files / play_specific_music
    // 是同一个播放器的四个动作，模型要在四个名字里选 —— 现在一个 `music(action)`。
    getTools() {
        return [{
            type: 'function',
            function: {
                name: 'music',
                description: '唱歌（用你的真实声音）。play=唱一首（给 filename 就唱指定的，不给就随机）；stop=停下；list=看曲库有哪些歌。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['play', 'stop', 'list'], description: '要做什么' },
                        filename: { type: 'string', description: '（action=play 可选）指定歌曲文件名，不带路径和扩展名' },
                    },
                    required: ['action'],
                },
            },
        }];
    }

    async executeTool(name, params) {
        const p = params || {};
        if (name === 'music') {
            const a = String(p.action || 'play').toLowerCase();
            if (a === 'stop') return await this._stop();
            if (a === 'list') return this._list();
            if (a === 'play') {
                return p.filename ? await this._playSpecific(p.filename) : await this._playRandom();
            }
            throw new Error('music：action 只能是 play / stop / list（收到「' + a + '」）');
        }
        // 旧工具名保留（技能库/脚本可能直接调），新模型只看到 music
        switch (name) {
            case 'play_random_music':   return await this._playRandom();
            case 'stop_music':          return await this._stop();
            case 'list_music_files':    return this._list();
            case 'play_specific_music': return await this._playSpecific(p.filename);
            default: throw new Error(`[music] 不支持的工具: ${name}`);
        }
    }

    _getMusicFiles() {
        try {
            if (!fs.existsSync(this._musicFolder)) return [];
            return fs.readdirSync(this._musicFolder).filter(f => SUPPORTED_FORMATS.includes(path.extname(f).toLowerCase()));
        } catch { return []; }
    }

    async _request(action, filename = null) {
        return new Promise((resolve) => {
            const postData = JSON.stringify({ action, filename });
            const req = http.request({ hostname: 'localhost', port: this._port, path: '/control-music', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        resolve(result.success ? result.message : `操作失败: ${result.message}`);
                    } catch { resolve('操作完成'); }
                });
            });
            req.on('error', () => resolve('连接音乐控制服务失败，请确保应用已启动'));
            req.write(postData);
            req.end();
        });
    }

    _formatResponse(result) {
        if (typeof result === 'string') return result;
        const { message, metadata } = result;
        if (!metadata) return message;
        let response = `开始演唱：${metadata.title} - ${metadata.artist}。\n`;
        if (metadata.lyrics && metadata.lyrics !== '暂无歌词') {
            response += `歌词内容：\n${metadata.lyrics.split('\n').slice(0, 200).join('\n')}\n`;
        }
        return response;
    }

    async _playRandom() {
        if (this._getMusicFiles().length === 0) return '我的歌曲库中没有找到任何歌曲';
        return this._formatResponse(await this._request('play_random'));
    }

    async _stop() {
        const result = await this._request('stop');
        return result.replace('音乐已停止', '好的，我停止唱歌了');
    }

    _list() {
        const files = this._getMusicFiles();
        if (files.length === 0) return '我的歌曲库中没有找到任何歌曲';
        const names = new Set(files.map(f => f.replace(/\.(mp3|wav|m4a|ogg)$/i, '').replace(/-(Acc|Vocal)$/i, '')));
        const sorted = Array.from(names).sort();
        return `我会唱 ${sorted.length} 首歌:\n${sorted.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
    }

    async _playSpecific(filename) {
        const files = this._getMusicFiles();
        if (files.length === 0) return '我的歌曲库中没有找到任何歌曲';
        const matched = files.find(f => f.toLowerCase().includes(filename.toLowerCase()) || filename.toLowerCase().includes(f.toLowerCase().replace(/\.[^/.]+$/, '')));
        if (!matched) return `我不会唱这首歌: ${filename}`;
        return this._formatResponse(await this._request('play_specific', matched));
    }
}

module.exports = MusicPlugin;
