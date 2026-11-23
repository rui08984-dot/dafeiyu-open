/**
 * extensions/browser-tabs/background.js — 大肥鱼世界感知 Phase 2 · 浏览器 tab 上报
 *
 * 三个触发源（照 aw-watcher-web 的形状，机制自写）：
 *   ① tabs.onActivated  切 tab 立即报
 *   ② tabs.onUpdated    url/title/audible 变化立即报（只处理当前活动 tab）
 *   ③ alarms 60s        心跳，防止长时间停留时没有事件
 *
 * 只上报活动 tab；只取 host（new URL().hostname，失败丢弃）+ title（≤80 字）+
 * audible + tabCount —— path/query/fragment 一律不取、不传。
 * incognito=true 时只发 {incognito, host:'', title:'', tabCount}，不碰域名与标题。
 * 同一时刻只允许一个在途请求（queue 串行），避免乱序；同一 payload 3s 内不重发。
 */
'use strict';

const ENDPOINT = 'http://127.0.0.1:8103/browser-tab';
const ALARM_NAME = 'browser-tab-heartbeat';
const TITLE_MAX = 80;
const SAME_PAYLOAD_COOLDOWN_MS = 3000;

let queue = Promise.resolve();
let lastSig = '';
let lastSigAt = 0;

function enqueue(task) {
  queue = queue.then(task).catch(() => {});
  return queue;
}

async function readSettings() {
  try {
    const got = await chrome.storage.local.get({ token: '', enabled: true });
    return { token: String(got.token || '').trim(), enabled: got.enabled !== false };
  } catch (e) {
    return { token: '', enabled: false };
  }
}

async function setStatus(status) {
  try { await chrome.storage.local.set({ lastStatus: status }); } catch (e) { /* 状态写不进不影响上报 */ }
}

/** 活动 tab：先当前聚焦窗口，空了退回任意窗口（多窗口场景）。 */
async function activeTab() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); } catch (e) { tabs = []; }
  if (!tabs.length) {
    try { tabs = await chrome.tabs.query({ active: true }); } catch (e) { tabs = []; }
  }
  return tabs[0] || null;
}

/** 只接受 http/https 的页面；chrome://、about:blank、扩展页不是“在浏览网页”。 */
function pageHost(tab) {
  const raw = tab && tab.url ? String(tab.url) : '';
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = String(u.hostname || '').trim().toLowerCase();
  return host || null;
}

function clipTitle(value) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, TITLE_MAX).join('');
}

async function buildPayload(tab) {
  if (!tab) return null;
  let tabCount = 0;
  try { tabCount = (await chrome.tabs.query({})).length; } catch (e) { tabCount = 0; }
  if (tab.incognito === true) {
    return { incognito: true, host: '', title: '', tabCount };
  }
  const host = pageHost(tab);
  if (!host) return null;
  return {
    incognito: false,
    host,
    title: clipTitle(tab.title),
    audible: tab.audible === true,
    tabCount,
  };
}

/** 核心：读设置 → 组 payload → POST。调用方负责串行（enqueue）。 */
async function attempt(tabHint) {
  const settings = await readSettings();
  if (!settings.enabled) return;
  // 2026-11-21：token 改为可选。宿主对 chrome-extension:// 的 Origin 有白名单鉴权，
  // 空 token 也能上报（只是不带 X-Pet-Token 头）。popup 仍可填 token 作为第二因子。
  const tab = tabHint || (await activeTab());
  const payload = await buildPayload(tab);
  if (!payload) return; // 非网页/URL 解析失败：丢弃该条，不制造噪音

  const sig = JSON.stringify(payload);
  const now = Date.now();
  if (sig === lastSig && now - lastSigAt < SAME_PAYLOAD_COOLDOWN_MS) return;
  lastSig = sig;
  lastSigAt = now;

  let res = null;
  let text = '';
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (settings.token) headers['X-Pet-Token'] = settings.token;
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(Object.assign({ v: 1, ts: now }, payload)),
    });
    try { text = await res.text(); } catch (e) { text = ''; }
  } catch (e) {
    await setStatus({ ok: false, status: 0, reason: 'network', at: Date.now() });
    return;
  }

  if (res.ok) {
    let skipped = false;
    try { skipped = JSON.parse(text || '{}').skipped === true; } catch (e) { skipped = false; }
    await setStatus({ ok: true, status: res.status, skipped, at: Date.now() });
  } else {
    await setStatus({
      ok: false,
      status: res.status,
      reason: res.status === 401 ? 'bad-token' : 'http',
      at: Date.now(),
    });
  }
}

function report(tabHint) {
  return enqueue(() => attempt(tabHint));
}

/** 60s 心跳：已存在就不重设，避免每次 SW 唤醒都把周期往后推。 */
async function ensureAlarm() {
  try {
    const a = await chrome.alarms.get(ALARM_NAME);
    if (!a) chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  } catch (e) {
    try { chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 }); } catch (e2) { /* 真起不来就靠 tab 事件 */ }
  }
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); report(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); report(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === ALARM_NAME) report();
});

// ① 切 tab
chrome.tabs.onActivated.addListener(() => { report(); });

// ② url/title/audible 变化：只处理“当前活动 tab”，后台 tab 的变化不产生噪音
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo) return;
  if (changeInfo.url === undefined && changeInfo.title === undefined && changeInfo.audible === undefined) return;
  enqueue(async () => {
    const tab = await activeTab();
    if (!tab || tab.id !== tabId) return;
    await attempt(tab);
  });
});

// popup 保存后立刻试一次（不等下一个 60s 心跳）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'report-now') {
    report().then(() => sendResponse({ ok: true }));
    return true; // 异步响应
  }
  return false;
});

ensureAlarm();
