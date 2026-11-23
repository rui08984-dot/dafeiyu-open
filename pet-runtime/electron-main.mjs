import { app, BrowserWindow, ipcMain, screen, Menu } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { startVtsServer } from './vts-server.mjs';
import { buildModelInfo } from './model-info.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PET_W = Number(process.env.PET_W || 420), PET_H = Number(process.env.PET_H || 760);
const VTS_PORT = Number(process.env.PET_VTS_PORT || 8001);
const INNER_PORT = Number(process.env.PET_INNER_PORT || 8102);
const CONTROL_PORT = Number(process.env.PET_CONTROL_PORT || 8103);
const HEADLESS = process.env.PET_HEADLESS === '1';
const STATE_DIR = join(HERE, '.state');
const WINDOW_STATE = join(STATE_DIR, 'window.json');

let win = null;
let saveTimer = null;

function readWindowState() {
  try { return JSON.parse(readFileSync(WINDOW_STATE, 'utf8')); } catch { return null; }
}

function clampToDisplays(bounds) {
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  const inside = areas.some((a) =>
    bounds.x + bounds.width > a.x + 40 && bounds.x < a.x + a.width - 40 &&
    bounds.y + bounds.height > a.y + 40 && bounds.y < a.y + a.height - 40);
  if (inside) return bounds;
  const primary = screen.getPrimaryDisplay().workAreaSize;
  return { width: PET_W, height: PET_H, x: Math.max(0, primary.width - PET_W - 24), y: Math.max(0, primary.height - PET_H - 24) };
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(WINDOW_STATE, JSON.stringify(win.getBounds(), null, 2));
  } catch (error) { console.log('[pet] save window state failed:', String(error && error.message || error)); }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWindowState, 400);
}

function createWindow() {
  const saved = readWindowState();
  const primary = screen.getPrimaryDisplay().workAreaSize;
  const fallback = { width: PET_W, height: PET_H, x: Math.max(0, primary.width - PET_W - 24), y: Math.max(0, primary.height - PET_H - 24) };
  const bounds = clampToDisplays(saved && saved.width > 100 ? saved : fallback);
  win = new BrowserWindow({
    width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y,
    transparent: true, backgroundColor: '#00000000', frame: false, resizable: true, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: join(HERE, 'pet-preload.cjs') },
  });
  win.setBackgroundColor('#00000000');
  
  // ── 眼神跟随：每 100ms 把全局光标位置发给渲染层 ──────────────────
  // 桌宠窗口只有 420×760，鼠标绝大多数时间在窗口外，渲染层拿不到 mousemove。
  try {
    const { screen } = require('electron');
    const cursorTimer = setInterval(() => {
      try {
        if (!win || win.isDestroyed() || !win.isVisible()) return;
        const pt = screen.getCursorScreenPoint();
        win.webContents.send('pet:cursor', { x: pt.x, y: pt.y });
      } catch (e) {}
    }, 100);
    if (cursorTimer.unref) cursorTimer.unref();
    win.on('closed', () => clearInterval(cursorTimer));
  } catch (e) {}
win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(join(HERE, 'desktop', 'index.html'));
  // 右键菜单：桌宠没有任务栏入口，菜单是唯一稳定的退出/设置途径。
  win.webContents.on('context-menu', (_event, params) => {
    if (params && params.isEditable) return;
    buildMenu().popup({ window: win });
  });
  win.on('moved', scheduleSave);
  win.on('resized', scheduleSave);
  win.webContents.on('console-message', (_event, level, message) => {
    if (/error|失败|fail/i.test(String(message))) console.log('[renderer]', message);
  });
  win.webContents.on('did-finish-load', () => console.log('[pet] window loaded', JSON.stringify(win.getBounds())));
  return win;
}

// 右键菜单：不抢焦点也要能退出 / 置顶开关。
function buildMenu() {
  return Menu.buildFromTemplate([
    { label: '显示/隐藏字幕', click: () => win?.webContents.send('pet:menu', { type: 'toggle-caption' }) },
    { label: '控制面板', click: () => win?.webContents.send('pet:menu', { type: 'open-panel' }) },
    { type: 'separator' },
    { label: '保存位置', click: saveWindowState },
    { label: '退出', click: () => app.quit() },
  ]);
}

// 只允许一个桌宠进程：重复启动会抢 8001 端口，也容易叠出两只。
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  console.log('[pet] another instance is already running, exiting');
  app.quit();
} else {

// 光标与全屏状态：桌宠要「看见」你在动，所以主进程按 30Hz 采样光标位置，
// 归一化到窗口中心后经内网通道送给渲染进程；全屏状态每 2s 采样一次前台窗口矩形。
function startPointerFeed(server) {
  let inside = false;
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const c = screen.getCursorScreenPoint();
    const on = c.x >= b.x && c.x <= b.x + b.width && c.y >= b.y && c.y <= b.y + b.height;
    if (!on) {
      if (inside) { inside = false; try { server.sendPointer(null); } catch (e) {} }
      return;
    }
    inside = true;
    const x = ((c.x - b.x) / b.width) * 2 - 1;
    const y = ((c.y - b.y) / b.height) * 2 - 1;
    try { server.sendPointer({ x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) }); } catch (e) {}
  }, 33);

  const lines = [
    '$ErrorActionPreference = "SilentlyContinue"',
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public class PetWin {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    '}',
    '"@',
    'while ($true) {',
    '  $h = [PetWin]::GetForegroundWindow(); $r = New-Object PetWin+RECT; [void][PetWin]::GetWindowRect($h, [ref]$r)',
    '  Write-Output ("$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)")',
    '  Start-Sleep -Milliseconds 2000',
    '}',
  ];
  try {
    const script = join(HERE, 'tools', 'foreground-rect.ps1');
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
    console.log('[pet] fullscreen watcher started:', script);
    let buf = ''; let last = null; let parsed = 0;
    ps.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const parts = buf.split(/\r?\n/); buf = parts.pop() || '';
      for (const line of parts) {
        const m = line.trim().match(/^(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/);
        if (!m) continue;
        const nums = m.slice(1).map(Number);
        const W = nums[2] - nums[0], H = nums[3] - nums[1];
        // 只有「全屏窗口」和「桌宠」在同一块屏幕上才淡出，否则另一块屏放全屏视频会误伤。
        const petDisplay = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
        const area = petDisplay.bounds;
        const overlapsPet = nums[0] < area.x + area.width && nums[2] > area.x && nums[1] < area.y + area.height && nums[3] > area.y;
        const full = overlapsPet && W >= area.width - 4 && H >= area.height - 4;
        parsed += 1;
        if (parsed <= 2) console.log('[pet] foreground rect', nums.join(','), 'full=', full);
        if (full !== last) { last = full; try { server.sendFullscreen(full); console.log('[pet] fullscreen ->', full); } catch (e) {} }
      }
    });
    app.on('before-quit', () => { try { ps.kill(); } catch (e) {} });
  } catch (error) {
    console.log('[pet] fullscreen watcher unavailable:', String(error && error.message || error));
  }
}

app.whenReady().then(() => {
  const model = buildModelInfo();
  console.log('[pet] model:', model.name, '· params:', model.parameters.length, '· expressions:', model.expressions.length, '· hotkeys:', (model.hotkeys || []).length);
  const server = startVtsServer({ port: VTS_PORT, internalPort: INNER_PORT, controlPort: CONTROL_PORT, model });
  globalThis.__petServer = server;

  // 手动拖动：startDrag 记录抓取偏移，dragMove 用当前光标位置反推窗口位置。
  let dragOffset = null;
  ipcMain.on('pet:drag-start', () => {
    if (!win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    dragOffset = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
  });
  ipcMain.on('pet:drag-move', () => {
    if (!dragOffset || !win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    win.setPosition(Math.round(cursor.x - dragOffset.x), Math.round(cursor.y - dragOffset.y));
  });
  ipcMain.on('pet:drag-end', () => { dragOffset = null; saveWindowState(); });
  ipcMain.on('pet:move-by', (_event, dx, dy) => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    win.setPosition(Math.round(b.x + dx), Math.round(b.y + dy));
    scheduleSave();
  });
  ipcMain.on('pet:save-position', saveWindowState);
  ipcMain.on('pet:always-on-top', (_event, on) => { try { win?.setAlwaysOnTop(!!on, 'screen-saver'); } catch {} });
  ipcMain.on('pet:quit', () => app.quit());

  if (!HEADLESS) {
    const window = createWindow();
    try { startPointerFeed(server); } catch (error) { console.log('[pet] pointer feed failed:', String(error && error.message || error)); }
    window.on('closed', () => { win = null; });
  }
  app.on('before-quit', () => { saveWindowState(); try { server.close(); } catch {} });
  app.on('window-all-closed', () => { if (!HEADLESS) app.quit(); });
});
}

process.on('SIGINT', () => { saveWindowState(); app.quit(); });
process.on('SIGTERM', () => { saveWindowState(); app.quit(); });
