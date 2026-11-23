/**
 * extensions/browser-tabs/popup.js — token 输入 + 启用开关 + 最近一次上报状态
 *
 * 状态来自 chrome.storage.local.lastStatus（background.js 每次上报后写）：
 *   { ok, status, reason?, skipped?, at }
 * reason: 'no-token' | 'network' | 'bad-token' | 'http'
 */
'use strict';

const $ = (id) => document.getElementById(id);

function timeText(at) {
  if (!at) return '';
  try { return new Date(at).toLocaleTimeString('zh-CN', { hour12: false }); } catch (e) { return ''; }
}

function renderStatus(s) {
  const el = $('status');
  el.className = '';
  if (!s) { el.textContent = '还没有上报记录（点保存后立即试一次）'; return; }
  if (s.ok) {
    el.classList.add('ok');
    el.textContent = '上报成功' + (s.skipped ? '（与上一条相同，未重复落盘）' : '') + ' · ' + timeText(s.at);
    return;
  }
  el.classList.add('err');
  if (s.reason === 'no-token') el.textContent = '未填令牌：不会上报，也不会有任何数据发出';
  else if (s.reason === 'network') el.textContent = '网络失败：宿主 8103 没起，或地址被拦';
  else if (s.reason === 'bad-token') el.textContent = '401：令牌不对（与 config.json 的 browser_ext_token 不一致）';
  else el.textContent = '上报失败：HTTP ' + (s.status || '?') + ' · ' + timeText(s.at);
}

async function load() {
  const got = await chrome.storage.local.get({ token: '', enabled: true, lastStatus: null });
  $('token').value = String(got.token || '');
  $('enabled').checked = got.enabled !== false;
  renderStatus(got.lastStatus);
}

async function save() {
  await chrome.storage.local.set({
    token: $('token').value.trim(),
    enabled: $('enabled').checked,
  });
  const btn = $('save');
  btn.textContent = '已保存，正在试报…';
  btn.disabled = true;
  try { await chrome.runtime.sendMessage({ type: 'report-now' }); } catch (e) { /* SW 睡着时消息可能丢，心跳会补 */ }
  setTimeout(async () => {
    btn.textContent = '保存';
    btn.disabled = false;
    const got = await chrome.storage.local.get({ lastStatus: null });
    renderStatus(got.lastStatus);
  }, 800);
}

$('save').addEventListener('click', save);
$('enabled').addEventListener('change', () => {
  chrome.storage.local.set({ enabled: $('enabled').checked });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.lastStatus) return;
  renderStatus(changes.lastStatus.newValue || null);
});

load().catch((e) => renderStatus({ ok: false, status: 0, reason: 'http', at: Date.now() }));
