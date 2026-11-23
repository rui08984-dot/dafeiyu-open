// media-file.js —— 本地视频直读：窗口标题 → 播放器/文件名 → ffprobe 字幕轨 → SRT 时间线。
//
// 为什么：一起看的「台词」现在全靠 ASR 听系统声音——人名/术语会听错，静音段没有词。
// 本地视频时文件就在磁盘上，字幕轨是**带精确时间戳的官方台词**，比任何截图/OCR 都准。
// 管线：窗口标题识别播放器 → 抽文件名 → 定位文件 → ffprobe 找文本字幕轨 → 抽 SRT → 解析。
// 播放位置不知道？用 ASR 最近一句台词去字幕里模糊匹配——匹配上就知道播到哪了。
//
// 全部本地、零 API。找不到文件/字幕就返回 null，调用方静默降级（原有截图+ASR 链路兜底）。

const __silentAudit = require('../../../js/core/silent-audit.js');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VIDEO_EXT = /\.(mkv|mp4|avi|rmvb|ts|flv|wmv|mov|webm|m2ts)$/i;
const TEXT_SUB_CODECS = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text']);
// 播放器标题模式：优先带播放器名的（最可靠），generic 兜底「标题里出现视频扩展名」
const PLAYER_PATTERNS = [
  { re: /(.+)\s+-\s+PotPlayer(?:\s*64-bit|\s*64bit)?\s*$/i, player: 'PotPlayer' },
  { re: /(.+)\s+-\s+(?:MPC-BE|Media Player Classic)\S*\s*$/i, player: 'MPC' },
  { re: /(?:mpv|VLC)\s*-\s*(.+)$/i, player: 'mpv/vlc' },
  { re: /(.+)\s+-\s+VLC media player\s*$/i, player: 'VLC' },
  { re: /(.+\.(?:mkv|mp4|avi|rmvb|ts|flv|wmv|mov|webm|m2ts))(?:\s*[-[(].*)?$/i, player: 'generic' },
];

// Chromium 的 desktopCapturer 会跳过最小化窗口——用户最小化看视频是常态，
// 所以窗口标题走 PowerShell EnumWindows（含最小化窗、纯后台 windowsHide 无闪窗）。
const PS_TITLES_SCRIPT = path.join(os.tmpdir(), 'dafeiyu-window-titles.ps1');
let _psTitlesCache = { at: 0, titles: [] };

function ensureTitlesPs() {
  if (!fs.existsSync(PS_TITLES_SCRIPT)) {
    const script = [
      '$ErrorActionPreference = "SilentlyContinue"',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -TypeDefinition @"',
      'using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;',
      'public class WT {',
      '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);',
      '  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);',
      '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
      '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
      '  public static List<string> Go() {',
      '    var r = new List<string>();',
      '    EnumWindows((h, l) => {',
      '      if (IsWindowVisible(h)) {',
      '        var sb = new StringBuilder(512); GetWindowText(h, sb, 512);',
      '        var t = sb.ToString(); if (t.Trim().Length > 0) r.Add(t);',
      '      }',
      '      return true;',
      '    }, IntPtr.Zero);',
      '    return r;',
      '  }',
      '}',
      '"@',
      '[WT]::Go() | ForEach-Object { $_ }',
    ].join('\n');
    // BOM：避免 pwsh5 把无 BOM 的 UTF-8 当 ANSI 读（机器纪律）
    fs.writeFileSync(PS_TITLES_SCRIPT, '﻿' + script, 'utf8');
  }
  return PS_TITLES_SCRIPT;
}

async function listAllWindowTitles() {
  // 5s 内有缓存直接用（探针 30s 一次，代价可忽略）
  if (Date.now() - _psTitlesCache.at < 5000) return _psTitlesCache.titles;
  const r = await exec('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ensureTitlesPs()], 20000);
  const titles = String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (titles.length) _psTitlesCache = { at: Date.now(), titles };
  return _psTitlesCache.titles;
}

function exec(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

/** 窗口标题 → { player, name } | null。name 是带扩展名的文件名。 */
function parsePlayerTitle(title) {
  const t = String(title || '').trim();
  if (!t || t.length < 5) return null;
  for (const p of PLAYER_PATTERNS) {
    const m = t.match(p.re);
    if (m && m[1] && VIDEO_EXT.test(m[1].trim())) {
      return { player: p.player, name: path.basename(m[1].trim()) };
    }
  }
  return null;
}

/** 在候选目录里找文件（浅层，不递归）。dirs 可从插件配置传。 */
function findFile(name, dirs) {
  const search = [path.join(process.env.USERPROFILE || os.homedir(), 'Downloads'),
    path.join(process.env.USERPROFILE || os.homedir(), 'Videos'),
    ...(Array.isArray(dirs) ? dirs : [])];
  for (const dir of search) {
    try {
      const p = path.join(dir, name);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (e) { try { __silentAudit.audit('media-file.js:102', e); } catch (e2) {} }
  }
  return null;
}

function srtTime(s) {
  const m = String(s || '').match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  // SRT 的最后一段本身就是毫秒（,120 = 120ms），不能再除以 1000
  return ((+m[1] * 3600) + (+m[2] * 60) + (+m[3])) * 1000 + (+m[4]);
}

function parseSrt(raw) {
  const out = [];
  for (const block of String(raw).replace(/\r/g, '').split('\n\n')) {
    const lines = block.split('\n').filter((x) => x.trim());
    if (lines.length < 2) continue;
    const t = lines.find((x) => x.includes('-->'));
    if (!t) continue;
    const [a, b] = t.split('-->');
    const text = lines.slice(lines.indexOf(t) + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (text) out.push({ start: srtTime(a), end: srtTime(b), text });
  }
  return out;
}

/** 探测文件的文本字幕轨并抽成时间线。非文本轨（PGS 等）返回 null。 */
async function probeSubtitles(filePath, tmpDir) {
  const info = await exec('ffprobe', ['-v', 'error', '-show_entries',
    'stream=index:stream_tags=language,title:stream=codec_name,codec_type',
    '-of', 'json', filePath], 15000);
  if (info.err || !info.stdout) return null;
  let streams = [];
  try { streams = (JSON.parse(info.stdout).streams || []); } catch (e) { return null; }
  const sub = streams.find((s) => s.codec_type === 'subtitle' && TEXT_SUB_CODECS.has(String(s.codec_name)));
  if (!sub) return null;
  const outSrt = path.join(tmpDir, 'dafeiyu-sub-' + Date.now() + '.srt');
  const ex = await exec('ffmpeg', ['-y', '-v', 'error', '-i', filePath, '-map', '0:' + sub.index, '-f', 'srt', outSrt], 30000);
  let raw = '';
  try {
    raw = fs.readFileSync(outSrt, 'utf8');
  } catch (e) { return null; }
  finally { try { fs.unlinkSync(outSrt); } catch (e) { try { __silentAudit.audit('media-file.js:144', e); } catch (e2) {} } }
  if (ex.err && !raw) return null;
  const lines = parseSrt(raw);
  return lines.length >= 3 ? lines : null;
}

/** 用 ASR 最近一句在字幕里找播放位置。ASR 会听错（说过→说了），
 *  所以不用精确包含，用字符集重合度打分（≥0.6 算命中，取最高分）。返回 {index, start} | null。 */
function locatePlayback(asrText, subLines) {
  const norm = (s) => String(s || '').replace(/[\s，。！？、,.!?~"「」（）()']/g, '');
  const q = norm(asrText).slice(0, 24);
  if (q.length < 4) return null;
  const qs = [...new Set(q)];
  let best = null;
  let bestScore = 0;
  for (let i = subLines.length - 1; i >= 0; i--) {
    const s = norm(subLines[i].text);
    if (s.length < 4) continue;
    const ss = new Set(s);
    let inter = 0;
    for (const ch of qs) if (ss.has(ch)) inter++;
    const score = inter / Math.min(qs.length, ss.size);
    if (score > bestScore) {
      bestScore = score;
      best = { index: i, start: subLines[i].start };
    }
  }
  return bestScore >= 0.6 ? best : null;
}

/** 播放位置附近的字幕片段（±radius 行），人话标注。 */
function around(subLines, pos, radius = 8) {
  if (!pos) return null;
  const a = Math.max(0, pos.index - radius);
  const b = Math.min(subLines.length, pos.index + radius + 1);
  const fmt = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  return subLines.slice(a, b).map((x) => `- [${fmt(x.start)}] ${x.text}`).join('\n');
}

module.exports = { parsePlayerTitle, findFile, probeSubtitles, parseSrt, locatePlayback, around, listAllWindowTitles, VIDEO_EXT };
