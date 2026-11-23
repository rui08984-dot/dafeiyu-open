const fs = require('fs');
const path = require('path');
const os = require('os');

class ConfigLoader {
    constructor() {
        this.config = null;
        this.configPath = process.env.MY_NEURO_CONFIG_PATH
            ? path.resolve(process.env.MY_NEURO_CONFIG_PATH)
            : path.join(__dirname, '..', '..', 'config.json');
        this.defaultConfigPath = path.join(__dirname, '..', '..', 'default_config.json');
    }

    // 修改后的加载配置文件方法，如果格式不对就直接报错
    load() {
        try {
            // 直接读取配置文件
            const configData = fs.readFileSync(this.configPath, 'utf8');
            
            try {
                // 尝试解析 JSON
                this.config = JSON.parse(configData);
            } catch (parseError) {
                // JSON 解析失败，说明格式不对
                throw new Error(`JSON格式错误: ${parseError.message}`);
            }
            
            console.log('配置文件加载成功');

            // 处理特殊路径，例如 ~ 表示用户主目录
            this.processSpecialPaths();

            // LLM 通讯录：加载/迁移/注入 config.llm_providers（仅内存），并初始化运行时管理器。
            // 传入真实 configPath 以便首次迁移时备份 config.json.pre-provider.bak。
            // writeBack:false：此处不把清洗后的 config 写回磁盘（写回由 main.js 的 save-config 统一负责）。
            // 注意：即便不写盘，内存中的旧三格仍会被清空，运行时依赖 llm_providers.json。
            try {
                const { persistProviderStore } = require('./llm-provider-store.js');
                const { llmProviderManager } = require('./llm-provider.js');
                const baseDir = path.dirname(this.configPath);
                persistProviderStore(baseDir, this.configPath, this.config, { writeBack: false });
                llmProviderManager.init(this.config);
            } catch (providerError) {
                // 通讯录初始化失败不应阻断启动。若本次尚未清空旧三格，桌宠仍可走旧三格；
                // 若通讯录已初始化成功、旧三格已被清空，则必须修复 llm_providers.json。
                console.warn('LLM 通讯录初始化失败:', providerError.message);
            }

            return this.config;
        } catch (error) {
            console.error('配置文件读取失败:', error);
            throw error; // 直接抛出错误，不提供默认配置
        }
    }
    
    // 处理特殊路径，比如将 ~ 展开为用户主目录
    processSpecialPaths() {
        if (this.config.vision && this.config.vision.screenshot_path) {
            this.config.vision.screenshot_path = this.config.vision.screenshot_path.replace(/^~/, os.homedir());
        }
    }

    // 保存配置
    save(config = null) {
        try {
            const configToSave = config || this.config;
            if (!configToSave) {
                throw new Error('没有可保存的配置');
            }

            // 创建配置文件备份
            if (fs.existsSync(this.configPath)) {
                const backupPath = `${this.configPath}.bak`;
                fs.copyFileSync(this.configPath, backupPath);
                console.log(`已创建配置文件备份: ${backupPath}`);
            }

            // 保存配置
            const serialized = JSON.stringify(configToSave, null, 2);
            fs.writeFileSync(this.configPath, serialized, 'utf8');

            // ⚠ 2026-11-09 三十五轮：原来 writeFileSync 不抛异常就 return true ——
            //   「写进去了」不等于「读得回来」。磁盘满、序列化丢字段、写一半断电，
            //   都可能出现「保存成功但下次启动配置变形」。
            //   现在写完做一次**回读校验**：重新 parse，比对顶层键数量。
            //   代价 <1ms（配置几十 KB），收益是「保存」这个词变成真的。
            let readback;
            try {
                readback = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            } catch (e) {
                const msg = '配置保存后回读失败（文件可能损坏）：' + (e && e.message || e);
                console.error(msg);
                return { ok: false, error: msg };
            }
            const wantKeys = Object.keys(configToSave).length;
            const gotKeys = Object.keys(readback || {}).length;
            if (gotKeys < wantKeys) {
                const msg = `配置回读少了 ${wantKeys - gotKeys} 个顶层键（写入 ${wantKeys}，读回 ${gotKeys}）—— 可能有字段无法序列化`;
                console.error(msg);
                return { ok: false, error: msg, wantKeys, gotKeys };
            }

            console.log('配置已保存（回读校验通过）');
            return { ok: true, keys: gotKeys, bytes: serialized.length };
        } catch (error) {
            console.error('保存配置失败:', error);
            return { ok: false, error: error && error.message || String(error) };
        }
    }
}

// 创建并导出单例
const configLoader = new ConfigLoader();
module.exports = { configLoader };
