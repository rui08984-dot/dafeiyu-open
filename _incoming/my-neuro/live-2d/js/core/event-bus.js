// event-bus.js - 全局事件总线
// 用于解耦模块间通信，替代直接调用和global变量
//
// 日志门控（2026-11-08 日志治理）：每次 emit 都打一行会把日志淹掉——一轮对话里有
// tts:segment:start/text:progress ×N + interaction:updated 等十几条。默认静默，
// 排查时设 PET_EVENTBUS_DEBUG=1 才打全量；事件处理器错误永远打（那是真问题）。

const DEBUG = (() => { try { return process.env.PET_EVENTBUS_DEBUG === '1'; } catch (e) { return false; } })();

class EventBus {
    constructor() {
        this.events = new Map();
    }

    // 监听事件
    on(eventName, callback) {
        if (!this.events.has(eventName)) {
            this.events.set(eventName, []);
        }
        this.events.get(eventName).push(callback);
        if (DEBUG) console.log(`[EventBus] 注册监听器: ${eventName}`);
    }

    // 移除监听
    // 2026-11-22 内存采样：补上「不传 callback = 移除该事件全部监听器」。
    // 原来 `off(name)` 走 indexOf(undefined) = -1，静默 no-op —— 插件/模块热重载时
    // 以为清理了、实际每次重载叠一层。已有调用点都改成传 callback 了，但 API 本身
    // 仍留着这个坑；这里让「不传」的语义成立（clear() 的按事件版本）。
    off(eventName, callback) {
        if (!this.events.has(eventName)) return;

        if (typeof callback !== 'function') {
            this.events.delete(eventName);
            if (DEBUG) console.log(`[EventBus] 移除监听器(全部): ${eventName}`);
            return;
        }
        const callbacks = this.events.get(eventName);
        const index = callbacks.indexOf(callback);
        if (index > -1) {
            callbacks.splice(index, 1);
            if (DEBUG) console.log(`[EventBus] 移除监听器: ${eventName}`);
        }
    }

    // 触发事件
    emit(eventName, data) {
        if (DEBUG) console.log(`[EventBus] 触发事件: ${eventName}`, data);

        if (!this.events.has(eventName)) return;

        const callbacks = this.events.get(eventName);
        callbacks.forEach(callback => {
            try {
                callback(data);
            } catch (error) {
                console.error(`[EventBus] 事件处理器错误 (${eventName}):`, error);
            }
        });
    }

    // 一次性监听
    once(eventName, callback) {
        const onceWrapper = (data) => {
            callback(data);
            this.off(eventName, onceWrapper);
        };
        this.on(eventName, onceWrapper);
    }

    // 清空所有监听器
    clear() {
        this.events.clear();
        console.log('[EventBus] 已清空所有监听器');
    }
}

// 导出单例
const eventBus = new EventBus();
module.exports = { eventBus };
