#!/usr/bin/env node
/**
 * _probe/test-first-run.cjs —— 首启判定 / 随包语音定位（2026-11-26 安装包 A）
 *
 * 覆盖：
 *   · isPlaceholderKey：空 / <填你的密钥> / 打码示例 都算占位
 *   · isLocalEndpoint：127.* / localhost / 无点主机名 / 公网域名
 *   · inspectFirstRun：无 provider、空 key、占位 key、本地端点、ollama、有 key、
 *                      按 config.llm.provider_id 选中正确 provider
 *   · bundledTtsPath：resources/tts/dafeiyu-tts.exe 存在才返回
 *   · local-tts.portOpen：临时回环 server 端口 true / 关闭端口 false
 *
 * 判定：0 = 全过；非 0 = 有失败。全部离线，不碰真实数据目录。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const firstRun = require(path.join(LIVE, 'js', 'core', 'first-run.js'));
const localTts = require(path.join(LIVE, 'js', 'services', 'local-tts.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function provider(id, url, key, extra) {
    return Object.assign({ id, api_url: url, api_key: key, enabled: true, models: [] }, extra || {});
}
function doc(list) { return { providers: list }; }
function cfg(providerId) { return { llm: { provider_id: providerId, model_id: 'gpt-4o-mini' } }; }

(async () => {
    // ── isPlaceholderKey ────────────────────────────────────────────────
    ok('占位：空串', firstRun.isPlaceholderKey(''));
    ok('占位：undefined/null', firstRun.isPlaceholderKey(undefined) && firstRun.isPlaceholderKey(null));
    ok('占位：<填你的密钥>', firstRun.isPlaceholderKey('<填你的密钥>'));
    ok('占位：请填写 API Key', firstRun.isPlaceholderKey('请填写 API Key'));
    ok('占位：YOUR_API_KEY', firstRun.isPlaceholderKey('YOUR_API_KEY'));
    ok('占位：sk-xxxxx 打码示例', firstRun.isPlaceholderKey('sk-xxxxxx'));
    ok('非占位：真 key 形状', !firstRun.isPlaceholderKey('sk-abc123def456'));
    ok('非占位：ollama 占位 key', !firstRun.isPlaceholderKey('ollama'));

    // ── isLocalEndpoint ─────────────────────────────────────────────────
    ok('本地：127.0.0.1', firstRun.isLocalEndpoint('http://127.0.0.1:11434/v1'));
    ok('本地：localhost', firstRun.isLocalEndpoint('http://localhost:8000/v1'));
    ok('本地：无协议短名', firstRun.isLocalEndpoint('ollama:11434/v1'));
    ok('本地：0.0.0.0', firstRun.isLocalEndpoint('http://0.0.0.0:9883/tts'));
    ok('非本地：OpenAI', !firstRun.isLocalEndpoint('https://api.openai.com/v1'));
    ok('非本地：内网域名（带点）', !firstRun.isLocalEndpoint('https://llm.corp.example/v1'));

    // ── inspectFirstRun ─────────────────────────────────────────────────
    let r = firstRun.inspectFirstRun({}, null);
    ok('无 provider → 需要填 key', r.needsKey && r.reason === 'no-provider');

    r = firstRun.inspectFirstRun(cfg('cloud'), doc([provider('cloud', 'https://api.openai.com/v1', '')]));
    ok('空 key → 需要填 key', r.needsKey && r.reason === 'empty-key');

    r = firstRun.inspectFirstRun(cfg('cloud'), doc([provider('cloud', 'https://api.openai.com/v1', '<填你的密钥>')]));
    ok('占位 key → 需要填 key', r.needsKey && r.reason === 'empty-key');

    r = firstRun.inspectFirstRun(cfg('cloud'), doc([provider('cloud', 'https://api.openai.com/v1', 'sk-real-key')]));
    ok('有 key → 不需要', !r.needsKey && r.reason === 'key-present');

    r = firstRun.inspectFirstRun(cfg('cloud'), doc([provider('cloud', 'http://127.0.0.1:20128/v1', '')]));
    ok('本地端点空 key → 不需要', !r.needsKey && r.reason === 'local-endpoint');

    r = firstRun.inspectFirstRun(cfg('ollama'), doc([provider('ollama', 'https://api.openai.com/v1', '')]));
    ok('ollama → 不需要', !r.needsKey && r.reason === 'ollama');

    r = firstRun.inspectFirstRun(cfg('cloud'), doc([
        provider('other', 'https://api.openai.com/v1', 'sk-real-key'),
        provider('cloud', 'https://api.openai.com/v1', ''),
    ]));
    ok('按 provider_id 选择（不误用别的 provider 的 key）', r.needsKey && r.providerId === 'cloud');

    r = firstRun.inspectFirstRun(cfg('missing'), doc([
        provider('cloud', 'https://api.openai.com/v1', 'sk-real-key'),
    ]));
    ok('provider_id 失配 → 回退第一个启用项', !r.needsKey && r.providerId === 'cloud');

    // ── bundledTtsPath ──────────────────────────────────────────────────
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-first-run-'));
    ok('随包语音：目录不存在 → 空串', firstRun.bundledTtsPath(path.join(tmp, 'nope')) === '');
    const ttsDir = path.join(tmp, 'tts');
    fs.mkdirSync(ttsDir, { recursive: true });
    fs.writeFileSync(path.join(ttsDir, 'dafeiyu-tts.exe'), 'stub');
    const exe = firstRun.bundledTtsPath(tmp);
    ok('随包语音：exe 存在 → 返回路径', !!exe && exe.endsWith('dafeiyu-tts.exe'), exe);
    ok('随包语音：空 resourcesPath → 空串', firstRun.bundledTtsPath('') === '');

    // ── local-tts.portOpen（回环） ─────────────────────────────────────
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const openPort = server.address().port;
    ok('portOpen：在听 → true', await localTts.portOpen(openPort, '127.0.0.1', 500));
    await new Promise((resolve) => server.close(resolve));
    ok('portOpen：已关 → false', !(await localTts.portOpen(openPort, '127.0.0.1', 300)));

    // 清理
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'}：${pass} 过 / ${fail} 失败`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('测试自身异常：', e && e.stack || e);
    process.exit(1);
});
