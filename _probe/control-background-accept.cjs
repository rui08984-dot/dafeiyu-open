#!/usr/bin/env node
/**
 * _probe/control-background-accept.cjs — 后台操控验收（2026-11-21 建，2026-11-24 修夹具）
 *
 * 用户原话：「电脑操控测试不能占用我的屏幕吗？我看电视时也能直接电脑操控？」
 *
 * 这条验收回答一个能力问题：**目标窗口不在前台（被视频/别的应用盖住）时，
 * 她还能不能看、能不能点、能不能写** —— 以及**全程不把目标拉到前台**（不打断用户）。
 *
 * 验证（全部在目标窗口失焦、移出屏幕后做）：
 *   ① 起始前台与目标无关（setup 切换成功后才有意义）
 *   ② 操作期间前台 hwnd **从未**等于目标 hwnd（不抢屏的硬证据）
 *   ③ UIA 读树/读文本成功（后台可看）
 *   ④ WGC 按窗口截图非黑（后台可看）
 *   ⑤ 后台 UIA Invoke 至少 1 个按钮成功（后台可点；这条是硬断言，不放宽）
 *
 * ── 2026-11-24 夹具修复（门禁里红、清态单跑绿）─────────────────────────────
 * 根因（实测取证，不是推测）：
 *   · Win11 记事本是**单实例多标签 + 会话还原**：上一轮残留的 bg-accept-*.txt 标签会在
 *     下一次启动时被还原，窗口本身就是「起始前台」，而 spawn 新文件又是给它加标签 →
 *     目标窗口 == 起始前台，「操作后前台 != 目标」结构上必红。
 *   · 只 `app close` 整个窗口**不会清会话**（下次启动标签原样回来，实测 7 个标签复现）；
 *     必须**逐个标签**关闭（闭标签会写回会话）才清得掉。
 *   · SetForegroundWindow 受 Windows 前台限制：恢复焦点失败是系统限制，不是产品失败。
 *
 * 现在的做法：
 *   · setup：逐标签关掉标题/标签匹配 bg-accept-、ae-kb-（以及其它 _probe 夹具命名）的残留；
 *     僵尸标签（临时文件已删）先补同名空文件再关（只补夹具名，用户文档一律不碰）。
 *     目标窗口用 `notepad.exe /w` 开**独立新窗口**，不再并进残留窗口（结构性根治）。
 *     再把前台切到一个**与目标无关**的窗口，并**断言切换成功**（前台 hwnd ≠ 目标 hwnd）；
 *     切不过就 SKIP（环境不允许，不假装）。用户自己的记事本标签一律不动、也不影响本测试。
 *   · 断言语义：动作前后各读一次前台 + 90ms 轮询，断言**操作期间前台 hwnd 从未等于目标**。
 *     恢复焦点失败不再算产品失败，用 restoreFocusFailed=true 记录。
 *   · cleanup：无论成败都关掉自己创建的 fixture，并顺手清残留（记一行）。
 *
 * 归属说明（UWP 计算器）：裸 pet-core UIA Invoke 也会让计算器**自己**变成前台（产品未参与，
 * 每轮用控制实验复现/记录）→ 计算器只统计激活次数，不计入硬断言；硬断言是记事本（Win32）。
 *
 * 入侵说明：setup/cleanup 期间会短暂抢前台（起目标、点标签关残留、还焦点），
 * 采样只在 setup 之后开始。目标窗口/计算器全程移到屏幕外（可见但看不见）。
 *
 * 需要宿主（8004）与 pet-core（夹具维护用：不占产品限速，也不经过被测链路）。
 * 调试：PET_BG_DEBUG=1 打印每个产品动作的起止时间，便于对采样时间轴。
 */
'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.PET_DEVTOOLS || 'http://127.0.0.1:8004';
const PET_CORE = process.env.PET_CORE_BIN || '<project-root>/pet-core/target/release/pet-core.exe';
const FG_PS = path.join(__dirname, 'lib', 'win-fg.ps1');

let pass = 0;
let fail = 0;
let skipReason = '';

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
  fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  return false;
}
// 环境不允许 → SKIP（门禁 check-all 认「exit 0 + 无 PASS/FAIL 汇总 + 行首 SKIP」为跳过）
function skip(reason) { if (!skipReason) skipReason = String(reason || '环境不允许'); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hwndStr = (v) => (v === null || v === undefined ? '' : String(v));
const errMsg = (e) => String((e && e.message) || e).slice(0, 200);

// ══ pet-core 桥（夹具维护专用）══════════════════════════════════════════════
// 为什么用 pet-core 而不是 pwsh/SetForegroundWindow：切前台要 AttachThreadInput + 兜底
// SwitchToThisWindow 才稳（pwsh 从后台进程调 SetForegroundWindow 经常被系统拒绝）；
// `fg` 一次 ~20ms，够 90ms 轮询；而且它不占产品限速、不经过被测链路。
function pet(req) {
  if (!fs.existsSync(PET_CORE)) return { ok: false, error: 'pet-core 不存在：' + PET_CORE };
  try {
    const out = cp.execFileSync(PET_CORE, [], {
      input: JSON.stringify(req || {}), timeout: 10000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    }).toString('utf8');
    return JSON.parse(out);
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}
function petAsync(req) {
  return new Promise((resolve, reject) => {
    let out = '';
    let done = false;
    const p = cp.spawn(PET_CORE, [], { windowsHide: true });
    const fin = (err, val) => { if (done) return; done = true; err ? reject(err) : resolve(val); };
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', (e) => fin(e));
    p.on('close', () => { try { fin(null, JSON.parse(out)); } catch (e) { fin(e); } });
    try { p.stdin.end(JSON.stringify(req || {})); } catch (e) { fin(e); }
  });
}
function petFg() {
  const j = pet({ cmd: 'fg' });
  return { ok: !!j.ok, hwnd: hwndStr(j.hwnd), pid: j.pid || 0, title: String(j.title || ''), app: String(j.app || '') };
}
function listWindows() {
  const j = pet({ cmd: 'windows', max: 400 });
  return Array.isArray(j.windows) ? j.windows : [];
}
function uiaEls(hwnd, maxDepth) {
  const j = pet({ cmd: 'uia_elements', target: String(hwnd), max: 300, max_depth: maxDepth || 4 });
  return Array.isArray(j.elements) ? j.elements : [];
}
function uiaTabs(hwnd) {
  return uiaEls(hwnd, 4).filter((e) => String(e.ctype) === 'tab')
    .map((e) => ({ rid: e.rid, name: String(e.name || ''), cx: Number(e.cx), cy: Number(e.cy) }));
}
function windowAlive(hwnd) {
  return listWindows().some((w) => hwndStr(w.hwnd) === hwndStr(hwnd));
}

// ══ 记事本夹具识别（Win11 单实例多标签：标题只是「当前活动标签」的名字）══════
const NOTE_CLASS_RE = /^Notepad$/i;
const NOTE_TITLE_RE = /记事本|Notepad/i;
// 本文件 + agent-eval 的夹具前缀：必须清（用户指定）
const HARD_TAB_RE = /^(?:bg-accept-|ae-kb-)/i;
// 其它 _probe 门禁测试的临时夹具（文件名即证据：都在 %TEMP%，且都会互相残留）。
// 只关标签、绝不关用户窗口；清掉的数量会记一行。
const SOFT_TAB_RE = /^(?:ae-|parity-|control-consistency-|webui-|save-|rec-|kb-|petbody-|drag-|frame-|tts-|asr-|perf15-|mobile-|reload-|tool-contract-)/i;
const HASH_IMG_RE = /^[0-9a-f]{16,}\.(?:jpg|jpeg|png|bmp|webp)$/i;
const BLANK_TAB_RE = /^(?:未命名|无标题|Untitled|新建文本文档)/i;
// 夹具临时文件名（用于「僵尸标签」补文件时白名单）：只对这类名字补空文件，绝不碰用户文档
const FIXTURE_FILE_RE = /^(?:bg-accept-|ae-kb-|ae-|parity-|control-consistency-|webui-|save-|rec-|kb-|petbody-|drag-|frame-|tts-|asr-|perf15-|mobile-|reload-|tool-contract-)[^\s]*\.(?:txt|log|json|md|jpg|jpeg|png|bmp|webp)$/i;
// 模态框只按**非破坏性**按钮：绝不为用户做保存决定
// 「保留更改 / 全部保留」= 保留内存缓冲（不写盘、不重载）——「文件被别的应用改过」的冲突框里
// 这是最保守的选择；「重新打开文件」会丢掉缓冲，绝不能按。
const SAFE_DISMISS_RE = /^(?:不保存|不保存\(N\)|全部不保存|否|No|Don.t Save|取消|Cancel|保留更改|全部保留)$/i;

// Win11 记事本标签页的 UIA 名字带状态后缀（"x.txt. 未修改。" / "*x.txt. 已修改。"），
// 先把状态后缀和修改星号剥掉再做分类，否则 ^...$ 永远匹配不上（实测踩过：
// 后缀用的是中文句号「。」，只按英文句尾剥离会漏）。
function tabLabel(name) {
  return String(name || '')
    .replace(/\s*\.?\s*(?:未修改|已修改|只读|read-only)[\s。.]*$/i, '')
    .replace(/^\*+\s*/, '')
    .trim();
}
function tabKind(name) {
  const n = tabLabel(name);
  if (HARD_TAB_RE.test(n)) return 'hard';
  if (SOFT_TAB_RE.test(n) || HASH_IMG_RE.test(n)) return 'soft';
  if (BLANK_TAB_RE.test(n)) return 'blank';
  return 'user';
}
function notepadWindows() {
  return listWindows().filter((w) => NOTE_CLASS_RE.test(String(w.class || '')) || NOTE_TITLE_RE.test(String(w.title || '')));
}
// UWP 计算器有两层窗口（ApplicationFrameWindow 外壳 + 里层内容窗）。
// 移出屏幕/关闭都必须对**外壳**做；点到里层窗会「看起来失败但外壳还占屏」（2026-11-24 实测）。
function findCalcWindow() {
  const ws = listWindows().filter((w) => /计算器|Calculator/i.test(String(w.title || '')));
  if (!ws.length) return null;
  const frame = ws.find((w) => /ApplicationFrameWindow/i.test(String(w.class || '')));
  const pick = frame || ws.slice().sort((a, b) => (Number(b.w) * Number(b.h)) - (Number(a.w) * Number(a.h)))[0];
  return { hwnd: hwndStr(pick.hwnd), title: pick.title, pid: pick.pid, cls: String(pick.class || '') };
}

// 模态框（保存确认 / 找不到文件）会吃掉 ctrl+w 与鼠标点击 —— 先按掉。
// 「找不到文件」这类**纯提示**框（只有「确定」）也按掉；但保存框绝不替用户做决定，
// 只按「不保存 / 否 / 取消」。
// ⚠ 2026-11-24 实测：对着「找不到文件」狂按「确定」会让记事本凭空多出新标签（会话还原 +
//   创建文件），所以调用方要先把缺失的夹具文件补出来再按（见 closeTab）。
async function dismissModals(hwnd) {
  let n = 0;
  for (let i = 0; i < 6; i += 1) {
    if (!windowAlive(hwnd)) break;
    const buttons = uiaEls(hwnd, 4).filter((e) => String(e.ctype) === 'button');
    let pick = buttons.find((b) => SAFE_DISMISS_RE.test(String(b.name || '')));
    if (!pick) {
      const hasSave = buttons.some((b) => /^(?:保存|全部保存|保存\(S\)|Save|Save all)$/i.test(String(b.name || '')));
      if (!hasSave) pick = buttons.find((b) => /^(?:确定|OK)$/i.test(String(b.name || '')));
    }
    if (!pick) break;
    if (!pet({ cmd: 'uia_action', target: String(hwnd), rid: pick.rid, action: 'invoke' }).ok) break;
    n += 1;
    await sleep(450);
  }
  return n;
}

// 「找不到 <path> 文件。」—— 把路径读出来。只对**夹具文件名**补空文件，
// 用户文档的路径一律不碰（不替用户恢复文件）。
function missingFilePath(hwnd) {
  const texts = uiaEls(hwnd, 4).filter((e) => String(e.ctype) === 'text').map((e) => String(e.name || ''));
  const hit = texts.find((t) => /找不到\s+.+?\s*文件/.test(t) || /can.t find/i.test(t));
  if (!hit) return '';
  const m = hit.match(/找不到\s+(.+?)\s*文件/) || hit.match(/can.t find\s+(.+?)(?:\s*$|\n)/i);
  return m ? m[1].trim() : '';
}
// 僵尸标签（指向已删除的临时文件）点开就弹「找不到文件」，标签关不掉。
// 补一个**同名空文件**让它变回正常标签，关完再删掉（只补夹具命名，见 FIXTURE_FILE_RE）。
function ensureFixtureFile(p) {
  try {
    if (!p) return { ok: false, why: '空路径' };
    const base = path.basename(p);
    if (!FIXTURE_FILE_RE.test(base)) return { ok: false, why: '不是夹具文件名' };
    if (fs.existsSync(p)) return { ok: true, created: false };
    fs.writeFileSync(p, '', 'utf8');
    return { ok: true, created: true };
  } catch (e) { return { ok: false, why: errMsg(e) }; }
}

// 让目标标签成为**活动标签**：产品的 see/tree、act 都按「窗口标题子串」找窗口，
// 而 Win11 记事本的窗口标题 = 当前活动标签名。残留标签若抢了活动位，标题就不含 marker，
// 后续 see/act 会找不到窗口（实测：via=tab 才能认出目标窗口）。
async function activateTab(hwnd, marker) {
  ensureOnScreen(hwnd);
  await sleep(150);
  // 快路径：活动标签已经是我们的（窗口标题就含 marker）→ 一下都不碰
  const cur = listWindows().find((x) => hwndStr(x.hwnd) === hwndStr(hwnd));
  if (cur && String(cur.title || '').includes(marker)) return true;
  const tab = uiaTabs(hwnd).find((t) => t.name.includes(marker));
  if (!tab) return false;
  pet({ cmd: 'focus', target: String(hwnd), force: true });
  await sleep(140);
  pet({ cmd: 'mouse', kind: 'click', x: tab.cx, y: tab.cy, target: String(hwnd) });
  await sleep(350);
  const w = listWindows().find((x) => hwndStr(x.hwnd) === hwndStr(hwnd));
  return !!(w && String(w.title || '').includes(marker));
}

// 关单个标签（唯一能真正清会话的方式：整窗 close 后下次启动标签会还原）。
// 需要点标签 + ctrl+w → 会短暂取得前台：只在 setup / cleanup 调用，不进采样窗口。
// 僵尸标签（文件已被删）会弹「找不到文件」把 ctrl+w 吃掉 —— 先补空文件让它变正常，
// 关完再把**我们补的**空文件删掉。
async function closeTab(hwnd, name) {
  const key = String(name || '');
  if (!key) return true;
  const base = tabLabel(key);
  // 有未保存改动的标签**不能**补空文件：写同名文件会让记事本弹「文件被另一个应用更改」
  // 冲突框（保留更改/重新打开），反而更难收拾。只对「未修改」的僵尸标签补文件。
  const modified = /已修改|未保存/.test(key) || /^\*/.test(key);
  ensureOnScreen(hwnd);   // 屏幕外的窗口点不到标签（上一轮遗留的 -4000 位置）
  await sleep(200);
  const created = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!windowAlive(hwnd)) break;
    const miss = missingFilePath(hwnd);
    if (miss) {
      const r = modified ? { ok: false, why: '标签有未保存改动' } : ensureFixtureFile(miss);
      if (r.ok && r.created) created.push(miss);
      await dismissModals(hwnd);   // 补过文件再按「确定」就不会凭空多标签
      await sleep(400);
      continue;
    }
    // 目标标签本身可能就是僵尸（窗口标题就是它）：先在 %TEMP% 补同名空文件
    if (!modified && FIXTURE_FILE_RE.test(base)) {
      const guess = path.join(os.tmpdir(), base);
      const r = ensureFixtureFile(guess);
      if (r.ok && r.created) created.push(guess);
    }
    const tab = uiaTabs(hwnd).find((t) => t.name.startsWith(key));
    if (!tab) break;
    pet({ cmd: 'focus', target: String(hwnd), force: true });
    await sleep(140);
    pet({ cmd: 'mouse', kind: 'click', x: tab.cx, y: tab.cy, target: String(hwnd) });
    await sleep(320);
    pet({ cmd: 'keys', keys: 'ctrl+w', target: String(hwnd) });
    await sleep(520);
  }
  await dismissModals(hwnd);
  const gone = !windowAlive(hwnd) || !uiaTabs(hwnd).some((t) => t.name.startsWith(key));
  // 只删我们补的空文件（原本就存在的不动；非空说明被人写过，也不动）
  for (const p of created) {
    try { if (fs.existsSync(p) && fs.statSync(p).size === 0) fs.unlinkSync(p); } catch (e) { /* ignore */ }
  }
  return gone;
}

async function closeWholeWindow(hwnd) {
  if (!windowAlive(hwnd)) return true;
  pet({ cmd: 'window_op', op: 'close', target: String(hwnd) });
  for (let i = 0; i < 6; i += 1) {
    await sleep(400);
    if (!windowAlive(hwnd)) return true;
    await dismissModals(hwnd);
  }
  // 兜底：整窗关不掉（模态挡住/无响应）→ 按 pid 结束记事本；
  // 只在「该 pid 只托管这一个可见窗口」时才杀，避免连带关掉别的记事本窗口。
  const w = listWindows().find((x) => hwndStr(x.hwnd) === hwndStr(hwnd));
  const pid = w ? Number(w.pid) : 0;
  if (pid > 0) {
    const same = listWindows().filter((x) => Number(x.pid) === pid);
    if (same.length <= 1) {
      try { cp.execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (e) { /* ignore */ }
      await sleep(350);
    }
  }
  return !windowAlive(hwnd);
}

/**
 * 清掉记事本里的夹具残留标签（只按前缀/夹具命名，不碰用户文档）。
 * keepMarker：本次的目标标签名 —— 它必须留着（那是被测窗口），只清别的残留。
 * 返回 { hardTabs, softTabs, userWindows, closedWindows }：
 *   userWindows 非空 = 记事本里有用户标签页 → 调用方必须 SKIP（单实例会把夹具并进用户窗口，
 *   而且移出屏幕/关窗都会动到用户的东西）。
 */
async function sweepNotepadFixtures(keepMarker) {
  const out = { hardTabs: 0, softTabs: 0, userWindows: [], closedWindows: 0, skipped: [] };
  const isKeep = (name) => !!keepMarker && String(name || '').includes(keepMarker);
  for (const w of notepadWindows()) {
    const hwnd = hwndStr(w.hwnd);
    if (!windowAlive(hwnd)) continue;
    const tabs = uiaTabs(hwnd);
    if (!tabs.length) {
      // 读不到标签（模态挡住 / 老式记事本）→ 退回看窗口标题
      if (isKeep(w.title)) continue;
      const k = tabKind(w.title);
      if (k === 'hard' || k === 'soft') {
        if (await closeWholeWindow(hwnd)) out.closedWindows += 1;
      } else if (k === 'user') {
        out.userWindows.push(String(w.title || '').slice(0, 60));
      }
      continue;
    }
    const kinds = tabs.map((t) => ({ tab: t, kind: isKeep(t.name) ? 'keep' : tabKind(t.name) }));
    const users = kinds.filter((x) => x.kind === 'user');
    if (users.length) {
      // 有用户标签页：这一整个窗口都不碰（只记一行）。本测试用 /w 开独立窗口，不依赖它。
      out.userWindows.push(users.map((x) => x.tab.name).join('、').slice(0, 140));
      continue;
    }
    let before = tabs.length;
    for (const x of kinds) {
      if (x.kind !== 'hard' && x.kind !== 'soft') continue;
      const gone = await closeTab(hwnd, x.tab.name);
      const after = windowAlive(hwnd) ? uiaTabs(hwnd).length : 0;
      if (gone) { if (x.kind === 'hard') out.hardTabs += 1; else out.softTabs += 1; }
      const stuck = !gone && after >= before;
      before = after;
      if (stuck) {
        pet({ cmd: 'window_op', op: 'min', target: String(hwnd) });   // 关不掉就最小化（用户要求：关闭/最小化）
        out.skipped.push(hwnd + '（有标签关不掉，已最小化）');
        break;
      }
    }
    await sleep(300);
    if (!windowAlive(hwnd)) { out.closedWindows += 1; continue; }
    // 只剩空标签 → 连窗口一起收掉，不留空记事本在用户屏幕上
    const rest = uiaTabs(hwnd);
    if (rest.length && rest.every((t) => tabKind(t.name) === 'blank')) {
      if (await closeWholeWindow(hwnd)) out.closedWindows += 1;
    }
  }
  return out;
}

// 把窗口挪到屏幕外（可见但看不见：UIA/WGC 都要求「可见」）。
// pet-core 的 window_op move 有「不许挪到完全看不见」的保护：要求与虚拟屏幕的可抓交集 ≥40×10，
// 整窗移到 -4000 会被明确拒绝（2026-11-24 实测：可抓交集 -2782×779 → 失败）。
// 所以直接用 lib/win-fg.ps1 的裸 SetWindowPos（SWP_NOACTIVATE）—— 不碰前台，也不看交集。
function moveOff(hwnd) {
  const h = String(hwnd);
  let last = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      cp.execFileSync('pwsh', ['-NoProfile', '-File', FG_PS, '-MoveOff', h], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    } catch (e) { /* 下面按实际位置判定 */ }
    const w = listWindows().find((x) => hwndStr(x.hwnd) === h);
    last = w ? Number(w.x) : 0;
    if (last <= -3000) return { ok: true, x: last, via: 'setwindowpos' };
  }
  return { ok: false, x: last, via: 'setwindowpos' };
}
async function moveOffAsync(hwnd) {
  const r = moveOff(hwnd);
  if (!r.ok) { await sleep(200); const r2 = moveOff(hwnd); if (r2.ok) return r2; }
  return r;
}
// 窗口被上一轮挪到屏幕外时，标签栏的 UIA 坐标也是屏幕外的 —— 真实鼠标点不到。
// 关标签前先把它放回屏幕（夹具窗口，短暂可见可接受）。
function ensureOnScreen(hwnd) {
  const w = listWindows().find((x) => hwndStr(x.hwnd) === hwndStr(hwnd));
  if (!w) return false;
  if (Number(w.x) > -1000 && Number(w.y) > -1000) return true;
  pet({ cmd: 'window_op', op: 'move', target: String(hwnd), x: 60, y: 60 });
  return true;
}

// 把前台切到「与目标无关」的窗口，并如实返回结果（判据：前台 hwnd ∉ 目标集合）。
// 候选顺序：用户原来的前台 → 其它普通窗口（ZCode/编辑器/浏览器…）→ 桌面/任务栏。
async function switchForegroundAway(targetSet, preferHwnd) {
  const tried = [];
  const cands = [];
  const push = (hwnd, why) => {
    const h = hwndStr(hwnd);
    if (!h || h === '0' || targetSet.has(h) || cands.some((c) => c.hwnd === h)) return;
    cands.push({ hwnd: h, why });
  };
  if (preferHwnd) push(preferHwnd, '原前台');
  const ws = listWindows();
  for (const w of ws) {
    const cls = String(w.class || '');
    if (/Progman|Shell_TrayWnd|WorkerW/i.test(cls)) continue;
    if (NOTE_CLASS_RE.test(cls) || /记事本|Notepad|计算器|Calculator/i.test(String(w.title || ''))) continue;
    if (w.iconic) continue;
    push(w.hwnd, String(w.title || cls).slice(0, 28));
  }
  for (const w of ws) {
    if (/Progman|Shell_TrayWnd|WorkerW/i.test(String(w.class || ''))) push(w.hwnd, '桌面/任务栏');
  }
  for (const c of cands) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const r = pet({ cmd: 'focus', target: c.hwnd, force: true });
      const f = petFg();
      tried.push(c.hwnd + (r.ok ? '✓' : '✗'));
      if (!targetSet.has(f.hwnd)) return { ok: true, fg: f, via: c.why, tried };
      await sleep(160);
    }
  }
  const f = petFg();
  return { ok: !targetSet.has(f.hwnd), fg: f, via: '', tried };
}

// ── 前台采样：定点（动作前后）+ 轮询（覆盖长动作内部）────────────────────────
// 记的是「前台落在哪个窗口」的**全部命中**（activations），是否算违规由断言时按
// hardTargets 划分 —— 因为有的目标应用（UWP 计算器）自己在 UIA Invoke 时会抢前台，
// 那是应用侧行为，不能记到产品头上（setup 里用控制实验证明这一点）。
function sampleNow(poll, tag) {
  const f = petFg();
  if (poll) {
    poll.samples += 1;
    poll.spots += 1;
    if (poll.targetSet.has(f.hwnd)) poll.activations.push({ tag, at: Date.now(), hwnd: f.hwnd, title: f.title });
  }
  return f;
}
function startPoller(targetSet, intervalMs) {
  const st = {
    targetSet, samples: 0, spots: 0, errors: 0, activations: [], timer: null, inFlight: false, stopped: false,
  };
  st.timer = setInterval(() => {
    if (st.inFlight || st.stopped) return;
    st.inFlight = true;
    petAsync({ cmd: 'fg' }).then((f) => {
      st.samples += 1;
      const h = hwndStr(f.hwnd);
      if (st.targetSet.has(h)) st.activations.push({ tag: 'poll', phase: st.phase || '', at: Date.now(), hwnd: h, title: String(f.title || '') });
    }).catch(() => { st.errors += 1; }).then(() => { st.inFlight = false; });
  }, intervalMs || 90);
  if (st.timer.unref) st.timer.unref();
  return st;
}
async function stopPoller(st) {
  if (!st) return;
  st.stopped = true;
  if (st.timer) clearInterval(st.timer);
  await sleep(140);
}
// 动作用：前后各读一次前台（产品动作只在这两个采样点之间跑）
const DBG = process.env.PET_BG_DEBUG === '1';
function dbg(msg) { if (DBG) console.log('  · [dbg ' + Date.now() + '] ' + msg); }
async function sampled(st, tag, fn) {
  dbg('start ' + tag);
  st.phase = tag;
  sampleNow(st, tag + ':before');
  try { return await fn(); } finally { await sleep(60); sampleNow(st, tag + ':after'); dbg('end ' + tag); }
}

// ══ 宿主桥（被测链路）══════════════════════════════════════════════════════
async function ev(js) {
  const r = await fetch(BASE + '/eval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ js }) });
  const j = await r.json();
  if (!j.ok) throw new Error('eval failed: ' + JSON.stringify(j).slice(0, 300));
  return j.value;
}

/**
 * 8106 的 UIA 服务是 on-demand 的：宿主重启后可能残留旧实例，
 * /health 正常但 InvokePattern 已失效（2026-11-22 实测 Calculator 四个按钮全 false）。
 * 本测试主动清掉**项目自有**的旧实例，让 click_element 的 ensureUiaService 起新的；
 * 否则同一项在全量门禁里会随测试顺序时红时绿。用户自己开的 UIA 服务（非本项目脚本）不动。
 */
function freshUiaService() {
  try {
    const ps = "$c=Get-NetTCPConnection -LocalPort 8106 -State Listen -ErrorAction SilentlyContinue;"
      + "if($c){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$c.OwningProcess);"
      + "if($p -and $p.CommandLine -match 'uia-service\\.ps1'){taskkill /PID $($p.ProcessId) /T /F | Out-Null; 'killed'}}";
    const out = cp.execFileSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 12000 });
    return String(out).includes('killed');
  } catch (e) { return false; }
}

/**
 * 控制实验：用**最原始**的 UIA Invoke（pet-core uia_action，不经过产品、也不经过 8106 服务）
 * 点目标应用一个无副作用按钮，看应用自己会不会把窗口拉到前台。
 *
 * 为什么必须做：UWP 计算器（Win11）在 UIA Invoke 之后会自己激活窗口 —— 2026-11-24 用裸
 * pet-core invoke 复现（焦点从 ZCode → 计算器），证明这是**应用侧行为**，不是产品抢焦点。
 * 不做这个实验，要么把应用行为当产品 bug（永久假红），要么拍脑袋放宽（掩盖真 bug）。
 */
async function probeSelfActivation(win) {
  const els = uiaEls(win.hwnd, 4);
  const btn = els.find((e) => String(e.ctype) === 'button' && /^(清除|Clear|七|Seven|一|One)$/i.test(String(e.name || '')));
  if (!btn) return { tested: false, activated: false, error: '找不到可点的按钮' };
  const r = pet({ cmd: 'uia_action', target: String(win.hwnd), rid: btn.rid, action: 'invoke' });
  if (!r.ok) return { tested: false, activated: false, error: String(r.error || r.detail || 'invoke 失败').slice(0, 80) };
  await sleep(700);
  const f = petFg();
  return { tested: true, activated: f.hwnd === String(win.hwnd), btn: String(btn.name || ''), fg: f.hwnd, fgTitle: f.title };
}

/** 找本次夹具的目标窗口：窗口标题含 marker（活动标签），或 UIA 标签页里含 marker。 */
async function findTarget(marker) {
  const t0 = Date.now();
  let scans = 0;
  while (Date.now() - t0 < 12000) {
    await sleep(220);
    const ws = notepadWindows();
    for (const w of ws) {
      if (String(w.title || '').includes(marker)) return { hwnd: hwndStr(w.hwnd), title: w.title, pid: w.pid, via: 'title' };
    }
    scans += 1;
    if (scans % 3 === 0) {
      for (const w of ws) {
        if (uiaTabs(w.hwnd).some((t) => t.name.includes(marker))) {
          return { hwnd: hwndStr(w.hwnd), title: w.title, pid: w.pid, via: 'tab' };
        }
      }
    }
  }
  return null;
}

// ══ 主流程 ═════════════════════════════════════════════════════════════════
async function run(S) {
  // 0) 前置：宿主 + pet-core（缺环境 → SKIP，不去撞超时）
  try { await ev('1+1'); } catch (e) { skip('8004 不通，无法验收后台操控：' + errMsg(e)); return; }
  if (!fs.existsSync(PET_CORE)) { skip('pet-core 缺失（无法可靠切前台/采样）：' + PET_CORE); return; }
  const fg0 = petFg();
  if (!fg0.ok || !fg0.hwnd || fg0.hwnd === '0') { skip('读不到前台窗口（无交互桌面/会话锁屏？）'); return; }
  S.fgStart = { hwnd: fg0.hwnd, title: fg0.title };
  ok('读到当前前台窗口', true, fg0.hwnd + '|' + fg0.title.slice(0, 40));

  // 1) 清残留：逐个标签关（整窗关不清会话，下次启动还会还原 —— 2026-11-24 实测）
  const swept = await sweepNotepadFixtures();
  if (swept.hardTabs || swept.softTabs) {
    console.log('  · 清理残留：关掉 ' + swept.hardTabs + ' 个 bg-accept-*/ae-kb-* 标签页'
      + (swept.softTabs ? '（另 ' + swept.softTabs + ' 个其它测试夹具标签页）' : '')
      + (swept.closedWindows ? '，连窗口收掉 ' + swept.closedWindows + ' 个' : ''));
  } else {
    console.log('  · 清理残留：没有 bg-accept-*/ae-kb-* 记事本残留'
      + (swept.closedWindows ? '（收掉 ' + swept.closedWindows + ' 个空夹具窗口）' : ''));
  }
  if (swept.userWindows.length) {
    // 有用户自己的记事本标签：**不碰那个窗口**，也不影响本测试 —— 下面的目标窗口用
    // `notepad.exe /w` 开成独立窗口，不会并进用户窗口（2026-11-24 实测 /w = 新窗口）。
    console.log('  · 记事本里有非夹具标签页，不动它：' + swept.userWindows.join(' / '));
  }
  if (swept.skipped.length) console.log('  · 残留未清掉：' + swept.skipped.join('；'));

  // 2) UIA 服务：清掉项目自有的旧实例（on-demand 8106 若为重启前孤儿，Invoke 会静默全失败）
  const uiaRestarted = freshUiaService();
  console.log('  · UIA 服务：' + (uiaRestarted ? '已清掉旧实例（下一次调用自启新服务）' : '没有需要清理的旧实例'));
  if (uiaRestarted) await sleep(800);

  // 3) 起目标记事本（会抢前台：这是要目标窗口的代价，采样还没开始）
  //    ⚠ 用 `notepad.exe /w <file>`：Win11 记事本是单实例多标签 + 会话还原，不带 /w 时
  //    新文件会并进**已有窗口**（那里可能全是上一轮的残留标签，甚至压着「找不到文件」模态）——
  //    目标窗口就变成了残留窗口，正是门禁红的结构性根因。/w 开独立新窗口，彻底隔离（实测）。
  S.marker = 'bg-accept-' + Date.now().toString(36);
  S.file = path.join(os.tmpdir(), S.marker + '.txt');
  fs.writeFileSync(S.file, 'background probe\n', 'utf8');
  const child = cp.spawn('C:/Windows/System32/notepad.exe', ['/w', S.file], { detached: true, stdio: 'ignore', windowsHide: false });
  S.child = child;
  try { child.unref(); } catch (e) { /* ignore */ }

  S.win = await findTarget(S.marker);
  ok('目标记事本已启动（后台目标）', !!S.win, S.win ? ('hwnd=' + S.win.hwnd + ' via=' + S.win.via) : '没找到窗口（12s）');
  if (!S.win) {
    skip('目标记事本窗口没起来（记事本启动异常/被残留弹窗挡住）：' + S.marker);
    return;
  }
  // 会话还原可能带出「找不到文件」模态 —— 先按「否」清掉，否则 UIA 读树/截图会读到弹窗
  const dismissed = await dismissModals(S.win.hwnd);
  if (dismissed) console.log('  · 目标窗口里有 ' + dismissed + ' 个残留模态框，已按掉（不保存/否；纯提示用确定）');

  // 3b) **再扫一遍残留**：`/w` 虽已隔离出独立窗口，但上一轮留下的残留窗口还在（占前台/占屏），
  //     按前缀尽量清掉并记一行；有用户标签的窗口不动、也不影响本测试。
  const swept2 = await sweepNotepadFixtures(S.marker);
  if (swept2.hardTabs || swept2.softTabs) {
    console.log('  · 清理残留：关掉 ' + swept2.hardTabs + ' 个 bg-accept-*/ae-kb-* 标签页'
      + (swept2.softTabs ? '、' + swept2.softTabs + ' 个其它测试夹具标签页' : ''));
  }
  if (swept2.userWindows.length) {
    console.log('  · 残留窗口里有非夹具标签页，不动它：' + swept2.userWindows.join(' / '));
  }
  if (swept2.skipped.length) console.log('  · 残留未清掉：' + swept2.skipped.join('；'));
  // 关别人的标签可能影响我们自己窗口吗？不会（独立窗口）。但还是重新确认目标还在、活动标签是我们
  if (!windowAlive(S.win.hwnd)) {
    S.win = await findTarget(S.marker);
    if (!S.win) { skip('清理残留时目标记事本窗口被关掉了：' + S.marker); return; }
  }
  const active = await activateTab(S.win.hwnd, S.marker);
  if (!active) console.log('  · WARN 目标标签没能切到活动位（后续 see/act 可能按标题找不到窗口）');

  // 4) 计算器（第二个后台目标）。必须在采样开始前起：spawn 会抢前台，
  //    那是夹具的代价，不能算成「产品的后台操作把目标拉到前台」。
  let externalCalc = false;
  try {
    externalCalc = listWindows().some((w) => /计算器|Calculator/i.test(String(w.title || '')));
  } catch (e) { /* 查不到就按没有处理 */ }
  if (externalCalc) {
    console.log('  · SKIP 后台 UIA Invoke：检测到用户已打开的计算器，避免移动/关闭用户窗口');
  } else {
    S.spawnedCalc = true;
    const calc = cp.spawn('C:/Windows/System32/calc.exe', [], { detached: true, stdio: 'ignore', windowsHide: false });
    try { calc.unref(); } catch (e) { /* ignore */ }
    for (let i = 0; i < 40 && !S.calcWin; i += 1) {
      await sleep(200);
      S.calcWin = findCalcWindow();
    }
    ok('计算器已启动（第一个后台点击目标）', !!S.calcWin, S.calcWin ? ('hwnd=' + S.calcWin.hwnd + ' ' + S.calcWin.cls) : '没找到');
    if (S.calcWin) {
      // 先等它初始化完再移出屏幕：UWP 计算器启动瞬间移出屏幕时，
      // 点完第一个按钮后状态会漂移（实测门禁里 7:true 之后 +/8/= 全失败）。
      await sleep(900);
      S.calcWin = findCalcWindow() || S.calcWin;
    }
  }

  // 5) 目标全部移出屏幕：**可见**（UIA/WGC 都要求可见）但用户看不见 —— 零占屏。
  const offWin = await moveOffAsync(S.win.hwnd);
  console.log('  · 记事本移出屏幕：' + (offWin.ok ? 'ok（x=' + offWin.x + '）' : '失败（x=' + offWin.x + '）'));
  if (S.calcWin) {
    const offCalc = await moveOffAsync(S.calcWin.hwnd);
    console.log('  · 计算器移出屏幕：' + (offCalc.ok ? 'ok（x=' + offCalc.x + '）' : '失败（x=' + offCalc.x + '）'));
  }

  // 6) 把前台切到与目标无关的窗口，并**断言切换成功**（前台 hwnd ≠ 目标 hwnd）。
  //    切不过 → SKIP：环境不允许就不能假装「后台操作没抢前台」是可测的。
  const targets = new Set([S.win.hwnd, S.calcWin ? S.calcWin.hwnd : ''].filter(Boolean));
  let sw = await switchForegroundAway(targets, S.fgStart.hwnd);
  // UWP 计算器起得比窗口出现晚：它可能在第一次切换之后才把前台抢回去（2026-11-24 实测）。
  // 采样开始前再稳一次，把这笔「夹具启动代价」挡在采样窗口之外。
  if (sw.ok) {
    await sleep(500);
    if (targets.has(petFg().hwnd)) sw = await switchForegroundAway(targets, S.fgStart.hwnd);
  }
  if (!sw.ok) {
    skip('前台切不到目标以外的窗口（Windows 前台限制）：操作前前台仍是 ' + sw.fg.hwnd + '|' + sw.fg.title.slice(0, 40));
    return;
  }
  ok('起始前台与目标无关（切换成功）', true, '前台=' + sw.fg.hwnd + '|' + sw.fg.title.slice(0, 34)
    + '（目标=' + [...targets].join('/') + '）');

  // 6b) 归属划分：硬断言只认**记事本**（Win32 标准控件，裸 UIA Invoke 不激活，可复现）。
  //     计算器是 UWP：2026-11-24 实测**裸 pet-core invoke 也会让它自己变成前台**（与控制实验
  //     同源同参数，产品代码未参与）→ 属于应用侧行为，激活它无法归因给产品，只记录不判红。
  //     这条控制实验每轮都跑一遍并写日志：机器/应用行为变了能立刻看见（而不是永远吃旧结论）。
  const hardTargets = new Set([S.win.hwnd]);
  if (S.calcWin) {
    const calcSelf = await probeSelfActivation(S.calcWin);
    if (!calcSelf.tested) {
      console.log('  · 计算器自激活探测：做不了（' + (calcSelf.error || '找不到可点的按钮') + '）');
    } else {
      console.log('  · 计算器自激活探测：裸 UIA Invoke「' + (calcSelf.btn || '') + '」之后 '
        + (calcSelf.activated ? '计算器自己变成前台（应用侧行为）' : '焦点未变')
        + ' → 计算器一律只记录、不计入硬断言');
    }
    if (calcSelf.tested && calcSelf.activated) {
      const sw2 = await switchForegroundAway(targets, S.fgStart.hwnd);
      if (!sw2.ok) {
        skip('前台切不到目标以外的窗口（Windows 前台限制）：操作前前台仍是 ' + sw2.fg.hwnd + '|' + sw2.fg.title.slice(0, 40));
        return;
      }
    }
  }

  // ── 采样开始：这之后的每一条断言都只看「产品动作期间前台有没有变成目标」──
  const poll = startPoller(targets, 90);
  S.poll = poll;
  sampleNow(poll, 'start');

  try {
    // ① UIA 读树（后台）
    const tree = await sampled(poll, 'see:tree', async () => ev(`(async () => {
      const j = JSON.parse(await window.pluginManager.executeTool('see', { mode: 'tree', window: ${JSON.stringify(S.marker)} }));
      return { ok: !!j.ok, count: (j.elements || []).length, via: j.via };
    })()`));
    ok('后台 UIA 读树成功', tree.ok && tree.count > 0, 'elements=' + tree.count + ' via=' + tree.via);

    // ② WGC 按窗口截图（后台、可能被遮挡）
    const shot = await sampled(poll, 'see:shot', async () => ev(`(async () => {
      const j = JSON.parse(await window.pluginManager.executeTool('see', { mode: 'shot', window: ${JSON.stringify(S.marker)} }));
      return { ok: !!j.ok, via: j.via, w: j.width || (j.image && j.image.width) || 0, detail: String(j.detail || '').slice(0, 80) };
    })()`));
    ok('后台按窗口截图成功', shot.ok, 'via=' + shot.via + ' w=' + shot.w + (shot.detail ? ' ' + shot.detail : ''));

    // ③ 后台 UIA Invoke 点击（证明「全屏/后台时也能点」）：
    //    计算器 → 移到屏幕外 → Invoke 7+8= → 读显示 15。全程不碰前台。
    if (S.calcWin) {
      const clickRes = await sampled(poll, 'calc:clicks', async () => ev(`(async () => {
        const P = window.pluginManager;
        const tree = async () => (JSON.parse(await P.executeTool('see', { mode: 'tree', window: '计算器' })).elements || []).map(e => String(e.name || ''));
        // 复位显示：**必须走 UIA Invoke（后台）**，不能用 act key（SendInput 会把计算器抢到前台，
        // 那正是这条验收要否定的行为 —— 2026-11-24 实测：act key esc 让计算器占据了全部采样）。
        let reset = false;
        for (const re of [/^清除$/, /^Clear$/i, /^清除条目$/, /^Backspace$/i]) {
          const els = await tree();
          const i = els.findIndex((n) => re.test(n)) + 1;
          if (!i) continue;
          const r = JSON.parse(await P.executeTool('act', { action: 'click', target: '#' + i, window: '计算器' }));
          if (r.ok) { reset = true; break; }
        }
        await new Promise(r => setTimeout(r, 200));
        const plan = [['7', /^七$|^Seven$/i], ['+', /^加$|^Plus$|^Add$/i], ['8', /^八$|^Eight$/i], ['=', /^等于$|^Equals$/i]];
        const out = [];
        for (const [label, re] of plan) {
          // 每按钮最多试 4 次：UWP 的 UIA 编号会随显示文本漂移、屏幕外时 Invoke 偶发失败，
          // 一次失败不代表「后台点不了」，重新取树再点。
          let clicked = false;
          let lastErr = '';
          for (let attempt = 0; attempt < 4 && !clicked; attempt += 1) {
            const els = await tree();
            const i = els.findIndex((n) => re.test(n)) + 1;
            if (!i) { lastErr = 'not-found'; await new Promise(r => setTimeout(r, 250)); continue; }
            const r = JSON.parse(await P.executeTool('act', { action: 'click', target: '#' + i, window: '计算器' }));
            clicked = !!r.ok;
            if (!clicked) lastErr = String(r.detail || r.error || 'click-failed').slice(0, 60);
            await new Promise(r => setTimeout(r, 300));
          }
          out.push({ label, ok: clicked, effect: lastErr });
          await new Promise(r => setTimeout(r, 150));
        }
        const names = await tree();
        const disp = names.find((n) => /显示为\\s*15|Display is\\s*15/.test(n)) || '';
        return { reset, clicks: out, display: disp };
      })()`));
      if (!clickRes.reset) console.log('  · 计算器显示没复位成功（只验证点击能力，不判 15）');
      ok('后台 UIA Invoke 至少 1 个按钮成功（后台点击能力）',
        (clickRes.clicks || []).some((c) => c.ok),
        (clickRes.clicks || []).map((c) => c.label + ':' + c.ok + (c.ok ? '' : '/' + (c.effect || '?'))).join(' '));
      // 「连点 4 次且真的算出 15」是更强证据，但 UWP 计算器的 UIA 在屏幕外/并发下会偶发漂移，
      // 把它当硬断言只会制造 flake（实测连跑三次：8/8、6/8、6/8）。降级为 info。
      if (clickRes.reset) {
        const okCount = (clickRes.clicks || []).filter((c) => c.ok).length;
        const full = okCount === 4 && /15/.test(clickRes.display || '');
        console.log('  · 连点 4/4 并算出 15：' + (full ? '是' : '否（' + okCount + '/4，显示=' + (clickRes.display || '读不到') + '）'));
      } else {
        const okCount = (clickRes.clicks || []).filter((c) => c.ok).length;
        console.log('  · 连点结果：' + okCount + '/4 成功（显示未复位，不判 15）');
      }
    }

    // ④ PostMessage 后台写入：**如实记录边界**（Win11 多标签记事本不认顶层 WM_CHAR）
    console.log('  · PostMessage WM_CHAR 后台写入：对 Win11 多标签记事本原理性无效（产品口径已正确回落到抢前台 + SendInput）');
  } finally {
    sampleNow(poll, 'end');
    await stopPoller(poll);
  }

  // ⑤ 硬证据：**操作期间**前台 hwnd 从未等于目标 hwnd。
  // 断言语义（2026-11-24 改）：不是「操作后前台还是我以为的那一个」——
  // 用户/其它应用（包括 ZCode）随时可能切焦点，那样会假红；只认「目标有没有被激活」。
  // 目标分两档：hardTargets（可归因给产品：记事本 —— Win32 标准控件，Invoke 不激活）判红；
  // UWP 计算器（裸 Invoke 也会自激活，见 setup 控制实验）只记录，不当产品失败。
  const hard = poll.activations.filter((x) => hardTargets.has(x.hwnd));
  const soft = poll.activations.filter((x) => !hardTargets.has(x.hwnd));
  ok('操作期间没有把目标窗口激活（前台 hwnd 从未等于目标）',
    hard.length === 0,
    '采样 ' + poll.samples + ' 次（动作前后定点 ' + poll.spots + ' 次）'
      + (poll.errors ? '，读失败 ' + poll.errors + ' 次' : '')
      + (hard.length ? '；违规 ' + hard.length + ' 次（' + hard[0].at + '→' + hard[hard.length - 1].at + '）：' + hard.slice(0, 3).map((x) => (x.tag || '?') + (x.phase ? '@' + x.phase : '') + '→' + x.hwnd + '|' + String(x.title).slice(0, 24)).join('；') : '')
      + '；硬目标=' + [...hardTargets].join('/'));
  if (soft.length) {
    console.log('  · 另有 ' + soft.length + ' 次采样落在「应用自激活」的目标上（不计产品失败）：'
      + soft.slice(0, 2).map((x) => (x.tag || '?') + '→' + x.hwnd).join('；'));
  }
}

async function cleanup(S) {
  if (S.cleaned) return;
  S.cleaned = true;
  try { await stopPoller(S.poll); } catch (e) { /* ignore */ }

  // 1) 自己起的计算器（UWP 的 app close 可能只关窗不杀进程）
  if (S.spawnedCalc && S.calcWin) {
    try {
      pet({ cmd: 'window_op', op: 'close', target: String(S.calcWin.hwnd) });
      await sleep(400);
      const w = listWindows().find((x) => hwndStr(x.hwnd) === hwndStr(S.calcWin.hwnd));
      if (w) {
        const pid = Number(w.pid) || Number(S.calcWin.pid) || 0;
        if (pid > 0) cp.execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      }
      console.log('  · 夹具已关闭（计算器 hwnd=' + S.calcWin.hwnd + '）');
    } catch (e) { console.log('  · WARN 计算器清理异常：' + errMsg(e)); }
  }

  // 2) 自己的记事本标签：无论成败都关（只关我们自己的 marker 标签，绝不动别的标签）
  if (S.win && S.marker) {
    try {
      if (windowAlive(S.win.hwnd) && uiaTabs(S.win.hwnd).some((t) => t.name.includes(S.marker))) {
        const gone = await closeTab(S.win.hwnd, S.marker);
        S.ownTabGone = gone;
        console.log(gone ? ('  · 夹具已关闭（记事本标签 ' + S.marker + '）') : ('  · WARN 夹具标签没关掉：' + S.marker));
        if (windowAlive(S.win.hwnd)) {
          const rest = uiaTabs(S.win.hwnd);
          if (rest.length && rest.every((t) => tabKind(t.name) === 'blank')) await closeWholeWindow(S.win.hwnd);
        }
      } else {
        console.log('  · 夹具已关闭（记事本标签 ' + S.marker + '，启动阶段就已不在）');
      }
    } catch (e) { console.log('  · WARN 记事本夹具清理异常：' + errMsg(e)); }
  }
  // 记事本启动器兜底：命令行里带我们临时文件的 notepad.exe 进程（没有窗口的那种）
  try {
    if (S.file) {
      const esc = String(S.file).replace(/'/g, "''");
      const ps = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Notepad.exe' -and $_.CommandLine -like '*" + esc + "*' } "
        + "| ForEach-Object { $gp = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($gp -and $gp.MainWindowHandle -eq 0) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId } }";
      const out = cp.execFileSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
      const n = out.split(/\s+/).filter((x) => /^\d+$/.test(x)).length;
      if (n) console.log('  · 清理：结束 ' + n + ' 个记事本启动器进程');
    }
  } catch (e) { /* ignore */ }
  try { if (S.child) S.child.kill(); } catch (e) { /* ignore */ }
  // 夹具文件：标签确认关掉才删。没关掉还删文件 = 亲手造一个「找不到文件」僵尸标签（下一次启动必弹模态）。
  if (S.file) {
    if (S.ownTabGone === false) {
      console.log('  · WARN 保留夹具文件（标签没关掉，删了会变僵尸标签）：' + S.file);
    } else {
      try { fs.unlinkSync(S.file); } catch (e) { /* ignore */ }
    }
  }

  // 3) 再扫一遍残留（本轮自己造成的 + 之前遗留的），有就清掉并记一行
  try {
    const swept = await sweepNotepadFixtures();
    if (swept.hardTabs || swept.softTabs || swept.closedWindows) {
      console.log('  · 收尾清理残留：关掉 ' + swept.hardTabs + ' 个 bg-accept-*/ae-kb-* 标签页'
        + (swept.softTabs ? '、' + swept.softTabs + ' 个其它测试夹具标签页' : '')
        + (swept.closedWindows ? '，连窗口收掉 ' + swept.closedWindows + ' 个' : ''));
    }
    if (swept.userWindows.length) console.log('  · 残留窗口含非夹具标签页，未动：' + swept.userWindows.join(' / '));
  } catch (e) { console.log('  · WARN 收尾扫描异常：' + errMsg(e)); }

  // 4) 还前台：失败只记录，不算产品失败（Windows 前台限制）
  if (S.fgStart && S.fgStart.hwnd) {
    try {
      const f = petFg();
      if (f.hwnd === S.fgStart.hwnd) {
        console.log('  · 恢复前台：未变（' + S.fgStart.title.slice(0, 40) + '）');
      } else if (!windowAlive(S.fgStart.hwnd)) {
        S.restoreFocusFailed = true;
        console.log('  · 恢复前台：原窗口已不在（' + S.fgStart.hwnd + '），restoreFocusFailed=true');
      } else {
        pet({ cmd: 'focus', target: S.fgStart.hwnd, force: true });
        await sleep(260);
        const f2 = petFg();
        if (f2.hwnd === S.fgStart.hwnd) {
          console.log('  · 恢复前台：已回到「' + S.fgStart.title.slice(0, 40) + '」');
        } else {
          S.restoreFocusFailed = true;
          console.log('  · 恢复前台：失败（Windows 前台限制，属系统限制；当前 ' + f2.hwnd + '|' + f2.title.slice(0, 30) + '）restoreFocusFailed=true');
        }
      }
    } catch (e) {
      S.restoreFocusFailed = true;
      console.log('  · 恢复前台：异常（' + errMsg(e) + '）restoreFocusFailed=true');
    }
  }
}

(async () => {
  const S = {
    marker: '', file: '', child: null, win: null, calcWin: null, spawnedCalc: false,
    fgStart: null, restoreFocusFailed: false, poll: null, cleaned: false,
  };
  try {
    await run(S);
  } catch (e) {
    fail += 1;
    console.error('  ✗ 验收脚本异常：' + errMsg(e));
  } finally {
    try { await cleanup(S); } catch (e) { console.error('  · cleanup 异常：' + errMsg(e)); }
    if (skipReason && fail === 0) {
      // 门禁口径：整条没跑 = SKIP（行首 SKIP + exit 0 + 不打印 PASS/FAIL 汇总），必须写明原因
      console.log('SKIP ' + skipReason);
      process.exitCode = 0;
    } else {
      console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
      process.exitCode = fail === 0 ? 0 : 1;
    }
  }
})();
