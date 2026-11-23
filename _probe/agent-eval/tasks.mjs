#!/usr/bin/env node
// tasks.mjs —— 电脑操控评测任务清单（真机、确定性、不调用 LLM）
//
// 每个任务六个字段：{ id, title, setup, run, verify, cleanup }
//   · setup / run / verify / cleanup 都是 **JS 表达式源码**，由 runner 通过 8004 /eval
//     注入到桌宠页面里执行；它们可以使用 runner 注入的公共助手：
//       call(name, params)   → await window.pluginManager.executeTool(...)，返回解析后的对象
//       sleep(ms)            → Promise
//       winList()            → see mode=windows 的窗口数组
//       openNotepad(file)    → 起记事本并等窗口出现（复用本机 Notepad）
//       closeNotepadTab(m)   → 聚焦含 m 标题的标签页 → ctrl+w → 若有保存框点「不保存」
//       assert(cond, msg)
//       S                    → 本次运行元数据（runId / tmpDir / marker / textMarker / fixture ...）
//       T                    → 本任务的暂存对象（跨 setup/run/verify/cleanup 保留）
//   · 表达式必须 return 一个对象；verify 返回 {ok:true} 才算过。
//   · 可选的 hostVerify / hostCleanup 是 Node 侧函数，用于「页面返回值之外」的独立取证
//     （BMP 像素、剪贴板系统真值、临时文件内容）。它们不是 8004 eval 的一部分。
//
// 约定：
//   · 本机 Notepad 是单实例多标签：runner 起一个共享夹具标签页，
//     win_alias_focus / window_move_size / uia_read_text / screenshot_nonblack /
//     list_windows_target 复用它，runner 全局收尾关掉。
//     keyboard_type_readback 不蹭共享夹具 —— 它自己开一个新标签页（新页天然带编辑焦点），
//     自己写完自己关；原因见 §6「窗口被抢过前台再 focus 回来会丢编辑焦点」。
//   · 关窗口只关「自己起的」：任务 5/10 只在 setup 时确认计算器不存在才启动，
//     cleanup 按 hwnd 关闭；预存在的计算器只清屏、不关。
//   · 任何任务失败也必须跑 cleanup；runner 还会做全局兜底（关夹具标签页/关自己起的计算器/
//     删临时目录/恢复前台窗口）。
//   · TASKS 是 10 条基线（默认跑）；DEEP_TASKS 是 6 条真机多步（--deep 才跑，因为会撞
//     生产严格闸 20 次/分钟；runner 撞闸会等，但全量会明显变慢）——前 3 条是多步链，
//     后 3 条是失败恢复（故障注入 + expectedRecovery + 预算）；
//     NOCHANGE_SELFTEST 是熔断自检（--stall-test），预期结果就是被熔断判红。

export const THRESHOLD = 0.8;
export const TASK_TIMEOUT_MS = 15000;

// 计算器按钮名（中英双语，避免系统语言不同就整条红）
const RE_SEVEN = '/^七$|^Seven$/i';
const RE_EIGHT = '/^八$|^Eight$/i';
const RE_TWO = '/^二$|^Two$/i';
const RE_FIVE = '/^五$|^Five$/i';
const RE_PLUS = '/^加$|^Plus$|^Add$/i';
// 乘/减的 UIA 名字在不同版本可能是「乘」「乘以」，用前缀匹配兜住
const RE_MUL = '/^乘|^Multiply|^×/i';
const RE_MINUS = '/^减|^Minus|^Subtract/i';
const RE_EQ = '/^等于$|^Equals$/i';

export const TASKS = [
  {
    id: 'win_alias_focus',
    title: '窗口：按进程名（app-alias）找窗口并 focus',
    // 本机记事本标题是英文 "xxx - Notepad"，focus_window 按标题找不到「记事本」，
    // 必须走 game-control 的应用名→exe→进程名兜底。这条就是测那条路。
    setup: `
      const f = S.fixture;
      if (!f) throw new Error('记事本夹具没起来（见 runner 全局 setup 日志）');
      T.fixture = f;
      return { ok: true, title: f.title, hwnd: f.hwnd, pid: f.pid };
    `,
    run: `
      const r = await call('app', { action: 'focus', name: '记事本' });
      T.focus = r;
      return { ok: !!(r && r.ok === true), via: r && r.via, detail: r && r.detail, error: r && r.error };
    `,
    verify: `
      const ws = await winList();
      const hit = ws.find(w => String(w.title || '').includes(S.marker));
      const via = String((T.focus && T.focus.via) || '');
      // 前台要**当场**验（focus 是异步的，等一小会儿）。不放到 hostVerify 去验 ——
      // 后者在所有阶段跑完后才执行，用户中途切窗口会把「focus 成功」误判成失败（2026-11-21 实测）。
      await sleep(300);
      const fg = pet({ cmd: 'fg' });
      const wantHwnd = String((T.fixture && T.fixture.hwnd) || '');
      const fgOk = !!fg && fg.ok !== false && String(fg.hwnd) === wantHwnd;
      const focusOk = !!(T.focus && T.focus.ok === true && via.startsWith('app-alias') && hit);
      if (!fgOk && focusOk) {
        // 用户正在用电脑时会把前台抢回去 —— 这不能记成产品失败。
        // idle_ms 来自 pet-core world（SMTC 已缓存，采样 ~1ms）。
        let idle = null;
        try { const w = pet({ cmd: 'world' }); idle = w && w.idle_ms; } catch (e) { idle = null; }
        if (Number.isFinite(Number(idle)) && Number(idle) < 3000) {
          return { ok: false, skip: true, reason: '用户正在操作（idle=' + idle + 'ms）；focus 已返回成功但前台被抢回', via, fg };
        }
      }
      return {
        ok: !!(focusOk && fgOk),
        via,
        fg: fg ? { hwnd: fg.hwnd, title: fg.title } : null,
        fixtureInList: hit ? { title: hit.title, hwnd: hit.hwnd, pid: hit.pid } : null,
      };
    `,
    hostVerify: async (task, ctx) => {
      // 只做参考：verify 已在 focus 后 300ms 内验过前台。
      // 这里若前台被切走，可能是用户正在操作 —— 不判失败（别把用户干扰记成产品 bug）。
      const fg = ctx.foreground();
      const f = (task.phases.setup.value) || {};
      const ok = !!fg && (String(fg.pid) === String(f.pid) || String(fg.title || '').includes(ctx.run.marker));
      return { ok: true, note: ok ? '前台=fixture' : '验证后前台被切换（可能是用户操作，不作为失败）', detail: { foreground: fg, fixturePid: f.pid } };
    },
    cleanup: `return { ok: true, note: '共享记事本夹具由 runner 全局收尾关闭' };`,
  },

  {
    id: 'keyboard_type_readback',
    title: '键盘：向新开标签页输入并 UIA 回读（SendInput 主链）',
    // 重打一次 + 新开标签页的额外开销，比原来的 15s 宽
    timeoutMs: 30000,
    // 为什么自己开一个标签页、不再蹭共享夹具：
    // 实测「窗口原本在前台」时 SendInput 能打进编辑区；一旦前台被别的窗口抢走，
    // 再 focus_window 回来，键盘焦点会落到窗口框架而不是 RichEdit —— 字母全部打空，
    // 而工具仍回「已发 N 字」。新开的标签页天然带编辑焦点，是唯一稳定的起点。
    // 不能用鼠标点正文把焦点点回来：桌面会自绘守卫会拒绝落在她自己窗口上的坐标点击。
    setup: `
      const f = await openNotepad(S.kbFile);
      if (!f) throw new Error('键盘夹具标签页没起来：' + S.kbFile);
      T.win = f;
      return { ok: true, title: f.title, hwnd: f.hwnd };
    `,
    run: `
      // 2026-11-21（门禁 flake）：token 原来是 ' AE_TYPED_xxx ' —— 下划线要按 Shift，
      // 输入法处于中文/全角或键盘状态异常时会被吞成 'AE _TYPED_xxx'（实测门禁里偶发），
      // 回读严格匹配就判红。改成**纯字母数字** token，回读做宽松匹配（忽略空格/标点）。
      const token = 'AETYPED' + String(S.runId || '');
      const norm = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '');
      const hwnd = (T.win && T.win.hwnd) || '';
      let r = null;
      let rd = null;
      let hits = 0;
      // 「打一次 → 回读确认」；没打进去就再打一次（窗口仍在前台，不用再 focus）。
      for (let attempt = 0; attempt < 2 && hits === 0; attempt += 1) {
        r = await call('act', { action: 'type', target: token, window: hwnd || S.kbMarker });
        await sleep(700);
        rd = await call('see', { mode: 'text', window: S.kbMarker });
        const text = String((rd && (rd.text || rd.detail)) || '');
        hits = norm(text).includes(norm(token)) ? 1 : 0;
      }
      T.token = token;
      T.type = r;
      T.read = rd;
      return { ok: !!(r && r.ok && hits >= 1), token, hits, via: r && r.via, chars: rd && rd.chars };
    `,
    verify: `
      // 与 run 同口径：归一化后包含即算命中（防空格/标点被输入法改写造成假红）。
      const norm = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '');
      const text = String((T.read && T.read.text) || '');
      const token = String(T.token || '');
      const hits = token && norm(text).includes(norm(token)) ? 1 : 0;
      return {
        ok: !!(T.type && T.type.ok === true && hits >= 1),
        token,
        hits,
        via: T.type && T.type.via,
        chars: T.read && T.read.chars,
        text: text.slice(0, 800),
      };
    `,
    hostVerify: async (task, ctx) => {
      const v = task.phases.verify.value || {};
      return { ok: Number(v.hits) >= 1 && !!v.token, detail: { token: v.token, hits: v.hits } };
    },
    // 自己开的标签页写脏了，自己关（有未保存改动时会弹保存框，点「不保存」）
    cleanup: `
      return await closeNotepadTab(S.kbMarker);
    `,
  },

  {
    id: 'window_move_size',
    title: '窗口：move/size 生效并恢复',
    setup: `
      // 夹具几何是**前置条件**不是被测动作：用 __raw 读，不占工具调用预算、不吃限速。
      const ws = ((await __raw('see', { mode: 'windows' })) || {}).windows || [];
      const w = ws.find(x => String(x.title || '').includes(S.marker));
      if (!w) throw new Error('窗口列表里找不到夹具窗口');
      T.orig = { x: w.x, y: w.y, w: w.w, h: w.h };
      return { ok: true, orig: T.orig };
    `,
    run: `
      const o = T.orig;
      const nx = o.x + 31, ny = o.y + 21;
      const nw = Math.max(500, o.w - 57), nh = Math.max(400, o.h - 43);
      T.target = { nx, ny, nw, nh };
      // 窗口操作是异步落定的：MoveWindow 返回后 DWM/应用可能还在过渡帧里，
      // 固定 sleep 350ms 会偶发读到旧矩形（实测踩到 900×800 读到 1003×954）。
      // 改成「轮询到预期值或超时」，读到的仍是真实矩形，只是给它落定的时间。
      const waitRect = async (pred, ms) => {
        const t0 = Date.now();
        let rect = null;
        do {
          // 轮询矩形是**观测**不是被测动作：必须走 __raw。
          // 走 call('see') 时 140ms 一轮会把「20 次/分钟」严格闸打爆，
          // 随后等配额（4×5s）吃光 15s 任务预算 → 实测 run abort（2026-11-21）。
          const ws = ((await __raw('see', { mode: 'windows' })) || {}).windows || [];
          const w = ws.find(x => String(x.title || '').includes(S.marker));
          rect = w ? { x: w.x, y: w.y, w: w.w, h: w.h } : null;
          if (rect && pred(rect)) return rect;
          await sleep(140);
        } while (Date.now() - t0 < ms);
        return rect;
      };
      const rm = await call('app', { action: 'move', name: S.marker, x: nx, y: ny });
      T.move = rm;
      T.afterMove = await waitRect(r => r.x === nx && r.y === ny, 2500);
      const rs = await call('app', { action: 'size', name: S.marker, w: nw, h: nh });
      T.size = rs;
      T.afterSize = await waitRect(r => r.w === nw && r.h === nh, 2500);
      return { ok: !!(rm && rm.ok && rs && rs.ok), afterMove: T.afterMove, afterSize: T.afterSize, target: T.target };
    `,
    verify: `
      const a = T.afterMove, b = T.afterSize, t = T.target;
      const ok = !!a && !!b && a.x === t.nx && a.y === t.ny && b.w === t.nw && b.h === t.nh;
      return { ok, afterMove: a, afterSize: b, target: t };
    `,
    // 独立于页面：直接问 pet-core 现在的窗口矩形（verify 阶段仍在 move+size 状态）
    hostVerify: async (task, ctx) => {
      const v = task.phases.verify.value || {};
      const t = v.target || {};
      const direct = ctx.petWindows(ctx.run.marker).find((w) => String(w.title || '').includes(ctx.run.marker));
      const ok = !!direct && direct.x === t.nx && direct.y === t.ny &&
        direct.w === t.nw && direct.h === t.nh;
      return { ok, detail: { direct: direct ? { x: direct.x, y: direct.y, w: direct.w, h: direct.h } : null, target: t } };
    },
    cleanup: `
      if (!T.orig) return { ok: true, note: 'setup 没拿到原始几何，跳过还原' };
      const rm = await call('app', { action: 'move', name: S.marker, x: T.orig.x, y: T.orig.y });
      await sleep(300);
      const rs = await call('app', { action: 'size', name: S.marker, w: T.orig.w, h: T.orig.h });
      await sleep(350);
      const ws = ((await __raw('see', { mode: 'windows' })) || {}).windows || [];
      const w = ws.find(x => String(x.title || '').includes(S.marker));
      const restored = w ? { x: w.x, y: w.y, w: w.w, h: w.h } : null;
      const ok = !!(rm && rm.ok && rs && rs.ok && w &&
        w.x === T.orig.x && w.y === T.orig.y && w.w === T.orig.w && w.h === T.orig.h);
      return { ok, restored, orig: T.orig };
    `,
  },

  {
    id: 'uia_read_text',
    title: 'UIA 读文本：记事本临时 txt 的 marker',
    run: `
      const r = await call('see', { mode: 'text', window: S.marker });
      T.read = r;
      const text = String((r && (r.text || r.detail)) || '');
      return { ok: !!(r && r.ok), via: r && r.via, chars: r && r.chars, text: text.slice(0, 600) };
    `,
    verify: `
      const text = String((T.read && T.read.text) || '');
      const hitsText = (text.match(new RegExp(S.textMarker, 'g')) || []).length;
      const hitsTitle = (text.match(new RegExp(S.marker, 'g')) || []).length;
      return {
        ok: !!(T.read && T.read.ok === true && T.read.via === 'uia-text' &&
          Number(T.read.chars) > 0 && text.includes(S.textMarker)),
        via: T.read && T.read.via,
        chars: T.read && T.read.chars,
        textHits: hitsText,
        titleHits: hitsTitle,
      };
    `,
    hostVerify: async (task, ctx) => {
      // 独立确认「源文件里确实有这个 marker」；页面侧只负责证明它真的从 UIA 读到了
      const fs = await import('node:fs');
      const src = fs.readFileSync(ctx.run.fixtureFile, 'utf8');
      const v = task.phases.verify.value || {};
      return {
        ok: src.includes(ctx.run.textMarker) && Number(v.textHits) >= 1,
        detail: { sourceHasMarker: src.includes(ctx.run.textMarker), textHits: v.textHits },
      };
    },
    cleanup: `return { ok: true };`,
  },

  {
    id: 'uia_click_calc',
    title: 'UIA 点击：计算器 7+8=15（点失败则本条红）',
    // 比原来的 15s 宽：现在每次点击后面要取一次状态指纹（快照/哈希），
    // 全部压在 15s 边上会让计算器冷启动慢的机器误红。
    timeoutMs: 25000,
    setup: `
      let ws = await winList();
      let calc = ws.find(w => String(w.title || '').includes('计算器'));
      T.launched = false;
      if (!calc) {
        const lr = await call('app', { action: 'launch', name: '计算器' });
        T.launch = lr;
        T.launched = true;
        for (let i = 0; i < 8 && !calc; i += 1) {
          if (i) await sleep(200);
          ws = await winList();
          calc = ws.find(w => String(w.title || '').includes('计算器'));
        }
      } else {
        T.launch = { ok: true, preexisting: true };
      }
      if (!calc) throw new Error('计算器窗口没起来（launch 也没成）');
      T.hwnd = calc.hwnd;
      T.pid = calc.pid;
      // 不占用户屏幕（2026-11-21）：计算器挪到屏幕外。UIA Invoke 不需要前台/可见性，
      // 实测移出屏幕后 4 个按钮照样点、照样算出 15（_probe/control-background-accept.cjs）。
      try {
        const mv = await call('app', { action: 'move', name: String(calc.title || calc.hwnd), x: -4000, y: 0 });
        T.movedOff = !!(mv && mv.ok);
      } catch (e) { T.movedOff = false; }
      if (T.launched) S.ownedCalc = { hwnd: calc.hwnd, pid: calc.pid, task: 'uia_click_calc' };
      return { ok: true, launched: T.launched, hwnd: calc.hwnd, preexisting: !T.launched, movedOff: T.movedOff };
    `,
    run: `
      // Esc 等价于 C（清屏），避免预存在计算器带着旧值；press_key 走游戏闸，不占严格配额
      await call('act', { action: 'key', target: 'esc', window: '计算器' });
      await sleep(120);
      const firstSnap = await call('see', { mode: 'tree', window: '计算器' });
      T.displayBefore = ((firstSnap.elements || []).map(e => String(e.name || ''))).find(n => /显示为|Display is/.test(n)) || '';
      // 每次点击前重新快照：UWP 计算器的 UIA 编号会随显示文本变化漂移（实测 0→7 之后
      // 原来的 #39 从「八」变成了「七」），拿旧编号连点会点到别的按钮还报 ok。
      const plan = [['7', ${RE_SEVEN}], ['+', ${RE_PLUS}], ['8', ${RE_EIGHT}], ['=', ${RE_EQ}]];
      const clicks = [];
      for (const [label, re] of plan) {
        const snap = await call('see', { mode: 'tree', window: '计算器' });
        const els = (snap.elements || []).map(e => String(e.name || ''));
        const i = els.findIndex(n => re.test(n)) + 1;
        if (!i) { clicks.push({ label, i, ok: false, error: '按钮没找到' }); continue; }
        // 带 window 不是为了聚焦（计算器本来就在前台），而是给熔断一个明确的指纹目标：
        // 不带窗口就只能退化成「所有窗口的矩形」，点按钮永远不改矩形 → 第 3 下必被误判成卡死。
        const r = await call('act', { action: 'click', target: '#' + i, window: '计算器' });
        clicks.push({ label, i, ok: !!(r && r.ok), detail: r && r.detail, effect: r && r.effect });
        await sleep(150);
      }
      T.clicks = clicks;
      return { ok: clicks.every(c => c.ok), clicks, displayBefore: T.displayBefore };
    `,
    verify: `
      // 2026-11-21（门禁 flake）：UWP 计算器把结果显示到 UIA 有延迟；门禁并发时
      // 「一次读不到」就判红（单跑 100% 过、门禁里偶发红）。这里轮询到出现或 3s 超时。
      // 注意：超时后仍会红 —— 真没算出 15 的情况不会被放过，只是不再被读取时序误杀。
      const waitDisplay = async (ms) => {
        const t0 = Date.now();
        let hit = '';
        do {
          const snap = await call('see', { mode: 'tree', window: '计算器' });
          const names = (snap.elements || []).map(e => String(e.name || ''));
          hit = names.find(n => /显示为\\s*15|Display is\\s*15/.test(n)) || '';
          if (hit) return hit;
          await sleep(200);
        } while (Date.now() - t0 < ms);
        // 超时：把「当前到底显示什么」读出来（report 里能区分「显示为 0」和「读不到」）
        const snap2 = await call('see', { mode: 'tree', window: '计算器' });
        const names2 = (snap2.elements || []).map(e => String(e.name || ''));
        return names2.find(n => /显示为|Display is/.test(n)) || '';
      };
      const display = await waitDisplay(3000);
      return {
        ok: !!(/显示为\\s*15|Display is\\s*15/.test(display) && (T.clicks || []).every(c => c.ok)),
        display,
        clicks: T.clicks,
      };
    `,
    cleanup: `
      if (T.launched) {
        let hwnd = T.hwnd;
        if (!hwnd) {
          const ws = await winList();
          const w = ws.find(x => String(x.title || '').includes('计算器'));
          hwnd = w && w.hwnd;
        }
        if (!hwnd) return { ok: true, note: '计算器自己没起来，无需关闭' };
        const r = await call('app', { action: 'close', name: String(hwnd) });
        await sleep(700);
        const ws2 = await winList();
        const gone = !ws2.some(w => String(w.hwnd) === String(hwnd));
        if (gone && S.ownedCalc && String(S.ownedCalc.hwnd) === String(hwnd)) S.ownedCalc = null;
        return { ok: !!(r && r.ok && gone), closed: !!(r && r.ok), gone };
      }
      // 预先存在的计算器：只清屏不关闭
      await call('act', { action: 'key', target: 'esc', window: '计算器' });
      return { ok: true, note: '计算器是预先存在的，已清屏未关闭' };
    `,
  },

  {
    id: 'clipboard_roundtrip',
    title: '剪贴板：写入→读回→恢复原内容',
    setup: `
      const r = await call('clipboard', { action: 'read' });
      T.orig = String((r && r.text) || '');
      T.origLen = Number((r && r.total_chars) || 0);
      return { ok: !!(r && r.ok), origLen: T.origLen };
    `,
    run: `
      const marker = 'AE_CLIP_' + S.runId;
      T.marker = marker;
      const w = await call('clipboard', { action: 'write', text: marker });
      const r = await call('clipboard', { action: 'read' });
      T.write = w;
      T.read = r;
      return {
        ok: !!(w && w.ok === true && w.verified === true && String((r && r.text) || '') === marker),
        writeVerified: w && w.verified,
        read: String((r && r.text) || ''),
      };
    `,
    verify: `
      const got = String((T.read && T.read.text) || '');
      return {
        ok: got === T.marker && Number(T.read && T.read.total_chars) === T.marker.length,
        expected: T.marker,
        got,
        len: Number(T.read && T.read.total_chars),
      };
    `,
    hostVerify: async (task, ctx) => {
      const got = ctx.pwshReadClipboard();
      return { ok: got === ctx.run.clipMarker, detail: { osClipboard: got, expected: ctx.run.clipMarker } };
    },
    cleanup: `
      if (T.origLen === undefined || T.origLen === null) {
        return { ok: true, note: '原始剪贴板长度未知，不做恢复也不清空' };
      }
      if (T.origLen > 0) {
        await call('clipboard', { action: 'write', text: T.orig });
        const r = await call('clipboard', { action: 'read' });
        return { ok: String((r && r.text) || '') === T.orig, restoredText: true };
      }
      return { ok: true, needHostClear: true };
    `,
    hostCleanup: async (task, ctx) => {
      if (ctx.run.clipOriginalLen === null || ctx.run.clipOriginalLen === undefined) {
        return { ok: true, detail: { note: '原始剪贴板长度未知，跳过清空' } };
      }
      const origLen = Number(ctx.run.clipOriginalLen) || 0;
      const got = ctx.pwshReadClipboard();
      if (origLen > 0) {
        // 原文由页面 cleanup 用 clipboard 工具写回；Node 侧只能确认「我们的 marker 不在了」
        return { ok: got !== ctx.run.clipMarker, detail: { got, note: '仅确认测试 marker 已清除' } };
      }
      ctx.pwshClearClipboard();
      const after = ctx.pwshReadClipboard();
      return { ok: after === '', detail: { got: after, cleared: true } };
    },
  },

  {
    id: 'screenshot_nonblack',
    title: '截图：see shot / WGC 出非黑帧且尺寸与窗口一致',
    setup: `
      const w = (await winList()).find(x => String(x.title || '').includes(S.marker));
      if (!w) throw new Error('截图前找不到夹具窗口');
      T.win = { w: w.w, h: w.h, hwnd: w.hwnd };
      return { ok: true, win: T.win };
    `,
    run: `
      const r = await call('see', { mode: 'shot', window: S.marker });
      T.shot = r;
      return {
        ok: !!(r && r.ok && r.path),
        path: r && r.path,
        width: r && r.width,
        height: r && r.height,
        bytes: r && r.bytes,
        hash: r && r.hash,
      };
    `,
    verify: `
      const w = (await winList()).find(x => String(x.title || '').includes(S.marker));
      return {
        ok: !!(T.shot && T.shot.ok === true && T.shot.path &&
          Number(T.shot.width) > 0 && Number(T.shot.height) > 0),
        path: T.shot && T.shot.path,
        width: T.shot && T.shot.width,
        height: T.shot && T.shot.height,
        bytes: T.shot && T.shot.bytes,
        window: w ? { w: w.w, h: w.h } : null,
        expected: T.win,
      };
    `,
    // 像素/尺寸校验放 Node 侧：页面只能自报，不能算证据
    hostVerify: async (task, ctx) => {
      const v = task.phases.verify.value || {};
      return ctx.checkBmp(v.path, { expectW: v.width, expectH: v.height, window: v.window });
    },
    hostCleanup: async (task, ctx) => {
      const v = (task.phases.verify && task.phases.verify.value) || (task.phases.run && task.phases.run.value) || {};
      return ctx.unlinkQuiet(v.path);
    },
    cleanup: `return { ok: true, note: '截图文件由 hostCleanup 删除' };`,
  },

  {
    id: 'list_windows_target',
    title: '窗口枚举：list_windows 包含目标且几何有效',
    run: `
      const r = await call('see', { mode: 'windows' });
      const ws = (r && r.windows) || [];
      const hit = ws.find(w => String(w.title || '').includes(S.marker));
      T.hit = hit || null;
      T.count = ws.length;
      return { ok: !!(r && r.ok && hit), count: ws.length, hit: hit || null };
    `,
    verify: `
      const f = S.fixture || {};
      const h = T.hit;
      return {
        ok: !!(h && String(h.pid) === String(f.pid) &&
          Number(h.hwnd) > 0 && Number(h.w) > 0 && Number(h.h) > 0 && h.iconic === false),
        count: T.count,
        hit: h,
        fixturePid: f.pid,
      };
    `,
    hostVerify: async (task, ctx) => {
      const v = task.phases.verify.value || {};
      const direct = ctx.petWindows(ctx.run.marker).find((w) => String(w.title || '').includes(ctx.run.marker));
      return {
        ok: !!direct && String(direct.hwnd) === String(v.hit && v.hit.hwnd) && Number(direct.w) > 0,
        detail: { direct: direct ? { title: direct.title, hwnd: direct.hwnd, pid: direct.pid, w: direct.w, h: direct.h } : null },
      };
    },
    cleanup: `return { ok: true };`,
  },


  {
    id: 'file_tool_read',
    title: 'file 工具：list / read / search 临时目录',
    // file 工具是只读原语：写入由 runner 的 Node fs 做（见 README「未覆盖什么」）
    run: `
      const r1 = await call('file', { action: 'list', path: S.fileDir });
      const r2 = await call('file', { action: 'read', path: S.filePath });
      const r3 = await call('file', { action: 'search', path: S.fileDir, keyword: 'marker' });
      T.list = r1; T.read = r2; T.search = r3;
      return {
        ok: !!(r1 && r1.ok && r2 && r2.ok && r3 && r3.ok),
        entries: r1 && r1.entries,
        total_chars: r2 && r2.total_chars,
        hits: r3 && r3.hits,
      };
    `,
    verify: `
      const names = ((T.list && T.list.entries) || []).map(e => String(e.name || ''));
      const base = String(S.filePath).split(/[\\\\/]/).pop();
      const detail = String((T.read && T.read.detail) || '');
      const hits = ((T.search && T.search.hits) || []).map(h => String(h.path || ''));
      const norm = (p) => String(p).replace(/\\\\/g, '/').toLowerCase();
      return {
        ok: names.includes(base) && detail.includes(S.textMarker) &&
          Number(T.read && T.read.total_chars) === Number(S.fileContentLen) &&
          hits.some(p => norm(p) === norm(S.filePath)),
        base,
        names,
        chars: T.read && T.read.total_chars,
        hits,
      };
    `,
    hostVerify: async (task, ctx) => {
      const fs = await import('node:fs');
      const content = fs.readFileSync(ctx.run.filePath, 'utf8');
      return {
        ok: content === ctx.run.fileContent,
        detail: { bytes: Buffer.byteLength(content), expectedBytes: Buffer.byteLength(ctx.run.fileContent) },
      };
    },
    cleanup: `return { ok: true, note: '临时目录由 runner 全局删除' };`,
  },

  {
    id: 'app_launch_calc',
    title: 'app 工具：启动计算器（0→1 个窗口）并关闭',
    // 2026-11-21：启动等待 + 8×200ms 轮询在机器忙时会超过默认 15s 预算
    // （实测门禁里 run 被 abort：launch 已发出，只是没等到窗口）。给启动类任务单列预算。
    // 2026-11-22 二次上调：门禁并发 + 性能测试同时跑时，UWP 计算器冷启动实测 25.6s 才出窗
    // （单跑 10.4s）——30s 预算会被负载误杀成假红。45s 仍保证「真起不来」会失败。
    timeoutMs: 45000,
    setup: `
      let ws = await winList();
      let calc = ws.find(w => String(w.title || '').includes('计算器'));
      // 给上一个任务（uia_click_calc）的 close 一点时间落定
      for (let i = 0; i < 6 && calc; i += 1) {
        await sleep(350);
        ws = await winList();
        calc = ws.find(w => String(w.title || '').includes('计算器'));
      }
      if (calc) return { ok: true, skip: true, reason: '计算器已在运行（可能是用户自己的），无法验证 launch 的 0→1' };
      T.before = ws.filter(w => String(w.title || '').includes('计算器')).length;
      return { ok: true, before: T.before };
    `,
    run: `
      const r = await call('app', { action: 'launch', name: '计算器' });
      T.launch = r;
      let hit = null;
      for (let i = 0; i < 8 && !hit; i += 1) {
        if (i) await sleep(200);
        const ws = await winList();
        hit = ws.find(w => String(w.title || '').includes('计算器')) || null;
      }
      T.win = hit;
      if (hit) S.ownedCalc = { hwnd: hit.hwnd, pid: hit.pid, task: 'app_launch_calc' };
      // 不占用户屏幕（2026-11-21）：新启动的计算器立刻挪出屏幕外
      let movedOff = false;
      if (hit) {
        try {
          const mv = await call('app', { action: 'move', name: String(hit.title || hit.hwnd), x: -4000, y: 0 });
          movedOff = !!(mv && mv.ok);
        } catch (e) { movedOff = false; }
      }
      return {
        ok: !!(r && r.ok && hit),
        launched: r && r.launched,
        appeared: r && r.appeared,
        focused: r && r.focused,
        costMs: r && r.costMs,
        movedOff,
        win: hit ? { title: hit.title, hwnd: hit.hwnd, pid: hit.pid } : null,
      };
    `,
    verify: `
      const r = T.launch, w = T.win;
      return {
        ok: !!(r && r.ok === true && r.appeared === true && w && Number(w.hwnd) > 0),
        launch: r ? { launched: r.launched, appeared: r.appeared, focused: r.focused, costMs: r.costMs } : null,
        win: w,
        before: T.before,
      };
    `,
    hostVerify: async (task, ctx) => {
      const v = task.phases.verify.value || {};
      const fg = ctx.foreground();
      return {
        ok: !!fg && String(fg.pid) === String(v.win && v.win.pid),
        detail: { foreground: fg, calcPid: v.win && v.win.pid },
      };
    },
    cleanup: `
      const w = T.win;
      if (!w || !w.hwnd) return { ok: true, note: '没有自己起的计算器可关' };
      const r = await call('app', { action: 'close', name: String(w.hwnd) });
      await sleep(700);
      const ws = await winList();
      const gone = !ws.some(x => String(x.hwnd) === String(w.hwnd));
      if (gone && S.ownedCalc && String(S.ownedCalc.hwnd) === String(w.hwnd)) S.ownedCalc = null;
      return { ok: !!(r && r.ok && gone), closed: !!(r && r.ok), gone };
    `,
  },
];

// ── 深度任务（真机多步，每条 ≥8 个工具动作）────────────────────────────────
// 为什么单独一组、默认不跑：
//   · 它们每条都要真的连点/连打字，会撞生产严格闸「20 次/分钟」（game-control.js），
//     call() 撞闸只能等滑动窗口过去 —— 和 10 条基线放一起跑会把 35s 拖到 1 分半；
//   · check-all 对单项是 120s 预算，硬塞进去迟早会在慢机器上红。
// 用法：`--deep`（或 EVAL_DEEP=1）跑全部，`--only=<id>` 单跑一条。
// 每条的 verify 都不看工具返回值本身，而是回读窗口文本/矩形，或由 Node 读落盘文件。
//
// 后 3 条（2026-11-20 新增）是失败恢复任务，设计见 docs/调研-长任务planner-2026-11-20.md §4.1：
//   · 故障注入只用评测层助手 pet()（按确定 hwnd 抢焦点/关窗）或在 executeTool 外包一层
//     「真实执行 + 伪造超时返回」，没有时序竞态、本机、无 LLM；
//   · 判定只用外部状态：hostVerify 读文件字节 / 窗口前台 / 窗口是否还在；
//     recover() 事件只用于「恢复档位是否正确」的第二条断言，不替代文件 oracle；
//   · 标记随机（runId + crypto 后缀），文件里 marker 出现次数必须恰好 1。
export const DEEP_TASKS = [
  {
    id: 'window_move_size_restore',
    title: '窗口多步：move→size→读矩形→移回原位→再读，四步全要生效',
    // 依赖共享记事本夹具（runner 按 NEEDS_FIXTURE 把它排在打字任务之前）
    timeoutMs: 60000,
    setup: `
      const w = (await winList()).find(x => String(x.title || '').includes(S.marker));
      if (!w) throw new Error('窗口列表里找不到夹具窗口');
      T.orig = { x: w.x, y: w.y, w: w.w, h: w.h };
      T.a = { x: w.x + 41, y: w.y + 33 };
      T.b = { w: Math.max(520, w.w - 89), h: Math.max(420, w.h - 71) };
      return { ok: true, orig: T.orig, a: T.a, b: T.b };
    `,
    // 关键：每一步之后都「读回矩形」，而不是相信 move/size 的返回值。
    // 而且中间态必须和初值不同 —— 如果整条任务以「回到原样」收尾，
    // 一个什么都不做的假工具也能让它绿（这是谎报最容易钻的空子）。
    run: `
      // 每一跳都轮询到预期矩形（或 2.5s 超时）再记录：窗口几何是异步落定的，
      // 固定 sleep 会偶发读到过渡帧，把「真的改了」误判成「没改」。
      const waitRect = async (tag, pred, ms) => {
        const t0 = Date.now();
        let rect = null;
        do {
          const w = (await winList()).find(x => String(x.title || '').includes(S.marker));
          rect = w ? { x: w.x, y: w.y, w: w.w, h: w.h } : null;
          if (rect && pred(rect)) break;
          await sleep(140);
        } while (Date.now() - t0 < ms);
        T.reads = T.reads || [];
        T.reads.push({ tag, rect });
        return rect;
      };
      const steps = [];
      let r = await call('app', { action: 'move', name: S.marker, x: T.a.x, y: T.a.y });
      steps.push({ step: 'move_a', ok: !!(r && r.ok) });
      const afterA = await waitRect('after_move_a', q => q.x === T.a.x && q.y === T.a.y, 2500);
      r = await call('app', { action: 'size', name: S.marker, w: T.b.w, h: T.b.h });
      steps.push({ step: 'size_b', ok: !!(r && r.ok) });
      const afterB = await waitRect('after_size_b', q => q.w === T.b.w && q.h === T.b.h, 2500);
      r = await call('app', { action: 'move', name: S.marker, x: T.orig.x, y: T.orig.y });
      steps.push({ step: 'move_back', ok: !!(r && r.ok) });
      const afterMoveBack = await waitRect('after_move_back', q => q.x === T.orig.x && q.y === T.orig.y, 2500);
      r = await call('app', { action: 'size', name: S.marker, w: T.orig.w, h: T.orig.h });
      steps.push({ step: 'size_back', ok: !!(r && r.ok) });
      const afterSizeBack = await waitRect('after_size_back', q => q.w === T.orig.w && q.h === T.orig.h, 2500);
      T.steps = steps;
      T.cp = { afterA, afterB, afterMoveBack, afterSizeBack };
      return { ok: steps.every(s => s.ok), steps, cp: T.cp };
    `,
    verify: `
      const o = T.orig || {}, a = T.a || {}, b = T.b || {}, cp = T.cp || {};
      const eq = (r, x, y, w, h) => !!r && r.x === x && r.y === y && r.w === w && r.h === h;
      // move 校验位置、size 校验宽高；不把 x/y 和 w/h 捆在一起——
      // 应用自己可能在 resize 时做居中/最小尺寸修正，那不是工具说谎。
      const okA = eq(cp.afterA, a.x, a.y, o.w, o.h);
      const okB = !!cp.afterB && cp.afterB.w === b.w && cp.afterB.h === b.h;
      const okMoveBack = eq(cp.afterMoveBack, o.x, o.y, b.w, b.h);
      const okSizeBack = !!cp.afterSizeBack && cp.afterSizeBack.w === o.w && cp.afterSizeBack.h === o.h;
      return {
        ok: !!(okA && okB && okMoveBack && okSizeBack && (T.steps || []).every(s => s.ok)),
        okA, okB, okMoveBack, okSizeBack, cp, orig: o,
      };
    `,
    hostVerify: async (task, ctx) => {
      const v = task.phases.verify.value || {};
      const o = v.orig || {};
      const direct = ctx.petWindows(ctx.run.marker).find((w) => String(w.title || '').includes(ctx.run.marker));
      const ok = !!direct && direct.x === o.x && direct.y === o.y && direct.w === o.w && direct.h === o.h;
      return { ok, detail: { direct: direct ? { x: direct.x, y: direct.y, w: direct.w, h: direct.h } : null, orig: o } };
    },
    // 失败也必须还原：中途失败时窗口可能停在 a/b 两种中间态
    cleanup: `
      if (!T.orig) return { ok: true, note: 'setup 没拿到原始几何，跳过还原' };
      const rm = await call('app', { action: 'move', name: S.marker, x: T.orig.x, y: T.orig.y });
      await sleep(300);
      const rs = await call('app', { action: 'size', name: S.marker, w: T.orig.w, h: T.orig.h });
      await sleep(340);
      const w = (await winList()).find(x => String(x.title || '').includes(S.marker));
      const restored = w ? { x: w.x, y: w.y, w: w.w, h: w.h } : null;
      const ok = !!(rm && rm.ok && rs && rs.ok && restored &&
        restored.x === T.orig.x && restored.y === T.orig.y &&
        restored.w === T.orig.w && restored.h === T.orig.h);
      return { ok, restored, orig: T.orig };
    `,
  },

  {
    id: 'notepad_type_readback_save',
    title: '记事本多步：输入→回读→追加→回读→ctrl+s→Node 读文件取证',
    timeoutMs: 90000,
    setup: `
      const f = await openNotepad(S.saveFile);
      if (!f) throw new Error('保存夹具没起来：' + S.saveFile);
      T.win = f;
      return { ok: true, title: f.title, hwnd: f.hwnd };
    `,
    // 工具动作：切回自己的标签页 / type A / 回读 / type B / 回读 / 枚举窗口 / ctrl+s / 回读。
    // 每段输入都「打完必回读」，没打进去就重打一次（回读是 0 命中时重打不会造成半截重复）。
    // ctrl+s 之后由 hostVerify 读磁盘 —— 那是页面自报之外的第二份证据，二者都对才算过。
    run: `
      // 不调用 app focus / 不点正文：新开的标签页天然带编辑焦点；
      // 中途换前台再切回来会把焦点丢到窗口框架，SendInput 就打空了（已实测）。
      const hwnd = (T.win && T.win.hwnd) || '';
      const typeOne = async (tok) => {
        let last = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          last = await call('act', { action: 'type', target: tok, window: hwnd || S.saveMarker });
          await sleep(600);
          const rd = await call('see', { mode: 'text', window: S.saveMarker });
          const text = String((rd && (rd.text || rd.detail)) || '');
          if (text.includes(tok.trim())) return { ok: true, type: last, read: rd, attempt };
          await sleep(250);
        }
        return { ok: false, type: last, read: null };
      };
      const a = await typeOne(' ' + S.saveA + ' ');
      const b = await typeOne(' ' + S.saveB + ' ');
      const ws = await winList();
      const alive = ws.some(w => String(w.title || '').includes(S.saveMarker));
      const titleNow = async () => {
        const xs = await winList();
        const x = xs.find(w => String(w.hwnd) === String(hwnd)) || xs.find(w => String(w.title || '').includes(S.saveMarker));
        return x ? String(x.title || '') : '';
      };
      const sv = await call('act', { action: 'key', target: 'ctrl+s', window: hwnd || S.saveMarker });
      await sleep(900);
      // 本机实测：Win11 记事本的 Ctrl+S 经 SendInput 不落盘（标题仍是 *）；
      // 但不许把这件事糊过去 —— 先如实按 ctrl+s，再用标题的 * 判断「到底保存没有」，
      // 没保存就走真实菜单「文件→保存」。两条都是真实用户会走的路，hostVerify 只认磁盘。
      let saveVia = 'ctrl+s';
      let titleAfterSave = await titleNow();
      if (String(titleAfterSave).startsWith('*')) {
        const s1 = await call('see', { mode: 'tree', window: S.saveMarker });
        const n1 = ((s1 && s1.elements) || []).map(e => String(e.name || ''));
        const fi = n1.indexOf('文件');
        if (fi >= 0) await call('act', { action: 'click', target: '#' + (fi + 1), window: S.saveMarker });
        await sleep(600);
        const s2 = await call('see', { mode: 'tree', window: S.saveMarker });
        const n2 = ((s2 && s2.elements) || []).map(e => String(e.name || ''));
        const si = n2.findIndex(n => /^保存$/.test(n));
        if (si >= 0) {
          await call('act', { action: 'click', target: '#' + (si + 1), window: S.saveMarker });
          saveVia = 'menu:文件→保存';
          await sleep(900);
          titleAfterSave = await titleNow();
        }
      }
      const r3 = await call('see', { mode: 'text', window: S.saveMarker });
      T.r1 = a.read; T.r2 = b.read; T.r3 = r3;
      T.type = { a: a.type, b: b.type, sv };
      T.saveVia = saveVia;
      T.titleAfterSave = titleAfterSave;
      const text2 = String((b.read && (b.read.text || b.read.detail)) || '');
      return {
        ok: !!(a.ok && b.ok && sv && sv.ok && alive),
        alive,
        saveVia,
        titleAfterSave,
        readbackHasA: text2.includes(S.saveA),
        readbackHasB: text2.includes(S.saveB),
        chars: r3 && r3.chars,
      };
    `,
    verify: `
      const r2 = T.r2 || {};
      const text = String(r2.text || r2.detail || '');
      const i1 = text.indexOf(S.saveA);
      const i2 = text.indexOf(S.saveB);
      return {
        ok: !!(r2.ok === true && i1 >= 0 && i2 > i1 && T.type && T.type.sv && T.type.sv.ok),
        hasA: i1 >= 0,
        hasB: i2 >= 0,
        order: i1 >= 0 && i2 > i1,
        chars: T.r3 && T.r3.chars,
      };
    `,
    // 这里是整条任务唯一真正的「外部证据」：Node 直接读磁盘上的文件。
    // 工具说「已保存」不算数，文件里没有这两段就等于没保存。
    // 加一点重试是因为 ctrl+s 落盘和 verify 之间只隔了 900ms，慢盘可能还没 flush。
    hostVerify: async (task, ctx) => {
      const fs = await import('node:fs');
      const p = ctx.run.saveFile;
      let content = '';
      for (let i = 0; i < 10; i += 1) {
        try { content = fs.readFileSync(p, 'utf8'); } catch (e) { content = ''; }
        if (content.includes(ctx.run.saveA) && content.includes(ctx.run.saveB)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const i1 = content.indexOf(ctx.run.saveA);
      const i2 = content.indexOf(ctx.run.saveB);
      return {
        ok: i1 >= 0 && i2 > i1,
        detail: { path: p, bytes: Buffer.byteLength(content), hasA: i1 >= 0, hasB: i2 >= 0, preview: content.slice(0, 300) },
      };
    },
    // 有未保存改动时 closeNotepadTab 会点「不保存」；已保存则直接关标签页
    cleanup: `
      return await closeNotepadTab(S.saveMarker);
    `,
  },

  {
    id: 'calc_chain',
    title: '计算器多步：7+8= → ×2 → −5 = 25（每步 UIA 回读）',
    timeoutMs: 90000,
    setup: `
      let ws = await winList();
      let calc = ws.find(w => String(w.title || '').includes('计算器'));
      T.launched = false;
      if (!calc) {
        const lr = await call('app', { action: 'launch', name: '计算器' });
        T.launch = lr;
        T.launched = true;
        for (let i = 0; i < 10 && !calc; i += 1) {
          if (i) await sleep(250);
          ws = await winList();
          calc = ws.find(w => String(w.title || '').includes('计算器'));
        }
      } else {
        T.launch = { ok: true, preexisting: true };
      }
      if (!calc) throw new Error('计算器窗口没起来（launch 也没成）');
      T.hwnd = calc.hwnd;
      if (T.launched) S.ownedCalc = { hwnd: calc.hwnd, pid: calc.pid, task: 'calc_chain' };
      return { ok: true, launched: T.launched, hwnd: calc.hwnd };
    `,
    // 三步连算，每步结束都回读显示文本，最后一步必须落在 25。
    // 每步重新快照一次：显示文本变了之后 UIA 树里的按钮编号理论上不变，
    // 但重取一次成本很低（热态 ~140ms），比踩版本差异的坑便宜。
    run: `
      await call('act', { action: 'key', target: 'esc', window: '计算器' });
      await sleep(180);
      const RE = {
        seven: ${RE_SEVEN}, eight: ${RE_EIGHT}, two: ${RE_TWO}, five: ${RE_FIVE},
        plus: ${RE_PLUS}, mul: ${RE_MUL}, minus: ${RE_MINUS}, eq: ${RE_EQ},
      };
      async function stage(steps) {
        const out = [];
        for (const [re, label] of steps) {
          // 每一步都重新快照：计算器的 UIA 编号会随显示文本漂移，
          // 拿一次快照连点 10 下等于赌编号不变（uia_click_calc 已实测踩到过）。
          const snap = await call('see', { mode: 'tree', window: '计算器' });
          const names = ((snap && snap.elements) || []).map(e => String(e.name || ''));
          const i = names.findIndex(n => re.test(n)) + 1;
          if (!i) { out.push({ label, ok: false, error: '按钮没找到' }); continue; }
          const r = await call('act', { action: 'click', target: '#' + i, window: '计算器' });
          out.push({ label, i, ok: !!(r && r.ok) });
          await sleep(170);
        }
        return out;
      }
      async function readDisplay() {
        const snap = await call('see', { mode: 'tree', window: '计算器' });
        const names = ((snap && snap.elements) || []).map(e => String(e.name || ''));
        return names.find(n => /显示为|Display is/.test(n)) || '';
      }
      const c1 = await stage([[RE.seven, '7'], [RE.plus, '+'], [RE.eight, '8'], [RE.eq, '=']]);
      const d1 = await readDisplay();
      const c2 = await stage([[RE.mul, '*'], [RE.two, '2'], [RE.eq, '=']]);
      const d2 = await readDisplay();
      const c3 = await stage([[RE.minus, '-'], [RE.five, '5'], [RE.eq, '=']]);
      const d3 = await readDisplay();
      T.clicks = [].concat(c1, c2, c3);
      T.d1 = d1; T.d2 = d2; T.d3 = d3;
      return { ok: T.clicks.every(c => c.ok), clicks: T.clicks.length, displays: [d1, d2, d3] };
    `,
    verify: `
      const d1 = String(T.d1 || '');
      const d2 = String(T.d2 || '');
      const d3 = String(T.d3 || '');
      const clicks = T.clicks || [];
      return {
        ok: clicks.length >= 8 && clicks.every(c => c.ok) &&
          /显示为\\s*15|Display is\\s*15/.test(d1) &&
          /显示为\\s*30|Display is\\s*30/.test(d2) &&
          /显示为\\s*25|Display is\\s*25/.test(d3),
        displays: [d1, d2, d3],
        clicks,
      };
    `,
    cleanup: `
      if (T.launched) {
        let hwnd = T.hwnd;
        if (!hwnd) {
          const ws = await winList();
          const w = ws.find(x => String(x.title || '').includes('计算器'));
          hwnd = w && w.hwnd;
        }
        if (!hwnd) return { ok: true, note: '计算器自己没起来，无需关闭' };
        const r = await call('app', { action: 'close', name: String(hwnd) });
        await sleep(700);
        const ws2 = await winList();
        const gone = !ws2.some(w => String(w.hwnd) === String(hwnd));
        if (gone && S.ownedCalc && String(S.ownedCalc.hwnd) === String(hwnd)) S.ownedCalc = null;
        return { ok: !!(r && r.ok && gone), closed: !!(r && r.ok), gone };
      }
      await call('act', { action: 'key', target: 'esc', window: '计算器' });
      return { ok: true, note: '计算器是预先存在的，已清屏未关闭' };
    `,
  },

  // ── 恢复任务 1/3：瞬时 grounding 失败 → 原地重试，不重规划 ────────────────
  // 目标：在记事本里输入唯一标记并保存；最终文件内容精确等于标记。
  // 注入：focus 目标后，用 pet-core 把「自己起的计算器」抢到前台（确定 hwnd），
  //       随后的第一次 type 不带 window → 打到计算器上，目标读回为空。
  // 期望：T1 读回为空 → transient_grounding；重新 focus → 重试一次；replan_count=0。
  // oracle：hostVerify 读文件（内容 === marker 且出现 1 次）+ 前台仍是目标窗口。
  // 预算：maxSteps=16（2026-11-20 审计 P2 #20，按最坏调用点逐项数：
  //   前置 focus/type/回读/focus = 4；typeOnce 最坏 6（type/读回/undo/读回/补打/读回）；
  //   菜单保存 4（see+click「文件」+see+click「保存」）；=14。
  //   另 2 次给 focus 失败后的生产兜底「min+restore」（被 UWP 抢前台时必需）。
  //   正常路径 10；多出的 6 次都是被测恢复路径的合法分支，不是任务乱调工具）、45s。
  {
    id: 'recover_focus_steal_retry',
    title: '恢复：前台被抢→第一次输入打空→原地重试（replan=0）',
    timeoutMs: 45000,
    maxWallMs: 45000,
    maxSteps: 16,
    expectedRecovery: 'retry_in_place',
    expectedReplanCount: 0,
    setup: `
      const f = await openNotepad(S.rec.a);
      if (!f) throw new Error('恢复 A 的记事本没起来：' + S.rec.a);
      T.win = f;
      // decoy：计算器。预存在就借用（不关），不存在才自己起、cleanup 关。
      let calc = (((pet({ cmd: 'windows', filter: '计算器', max: 10 }) || {}).windows) || [])[0] || null;
      T.calcPreexisting = !!calc;
      if (!calc) {
        const cp = require('child_process');
        const c = cp.spawn('C:/Windows/System32/calc.exe', [], { detached: true, stdio: 'ignore', windowsHide: false });
        try { c.unref(); } catch (e) { /* ignore */ }
        T.calcPid = c.pid;
        for (let i = 0; i < 20 && !calc; i += 1) {
          await sleep(250);
          calc = (((pet({ cmd: 'windows', filter: '计算器', max: 10 }) || {}).windows) || [])[0] || null;
        }
      }
      if (!calc) return { ok: true, skip: true, reason: 'decoy（计算器）没起来，无法注入前台抢占' };
      T.decoy = { hwnd: calc.hwnd, title: calc.title, owned: !T.calcPreexisting };
      // 能力自检：抢得走、还得回来。任何一步不成立都报 SKIP（环境跑不动，不是任务失败）。
      const inj = pet({ cmd: 'focus', target: String(calc.hwnd), force: true });
      const fg1 = pet({ cmd: 'fg' });
      let back = pet({ cmd: 'focus', target: String(f.hwnd), force: true });
      let fg2 = pet({ cmd: 'fg' });
      // 2026-11-21 实测：记事本由页面进程 spawn 时可能从未成为前台，
      // Windows 前台锁会拒绝从后台 SetForegroundWindow（force/SwitchToThisWindow 也无效）。
      // 「最小化 → 还原」天然取得前台资格；只动夹具窗口，不改变被测语义。
      if (String(fg2.hwnd) !== String(f.hwnd)) {
        pet({ cmd: 'window_op', op: 'min', target: String(f.hwnd) });
        await sleep(500);
        back = pet({ cmd: 'focus', target: String(f.hwnd), force: true });
        await sleep(250);
        fg2 = pet({ cmd: 'fg' });
      }
      if (!inj.ok || String(fg1.hwnd) !== String(calc.hwnd) || !back.ok || String(fg2.hwnd) !== String(f.hwnd)) {
        return { ok: true, skip: true, reason: '前台抢占自检失败：' + JSON.stringify({ inj, fg1, back, fg2 }).slice(0, 800) };
      }
      return { ok: true, target: { title: f.title, hwnd: f.hwnd }, decoy: T.decoy };
    `,
    run: `
      const hwnd = String(T.win.hwnd);
      const marker = S.recMarkers.a;
      const rdText = (r) => String((r && (r.text || r.detail)) || '');
      // 1) 正常路径：先 focus 目标（修复前的第一步）
      const f1 = await call('app', { action: 'focus', name: hwnd });
      await sleep(250);
      recover('attempt', { n: 1, phase: 'focus+type' });
      // 2) 故障注入：按确定的 hwnd 把 decoy 抢到前台
      const steal = pet({ cmd: 'focus', target: String(T.decoy.hwnd), force: true });
      await sleep(300);
      const fgSteal = pet({ cmd: 'fg' });
      const stealOk = !!steal.ok && String(fgSteal.hwnd) === String(T.decoy.hwnd);
      T.steal = { steal, fgSteal, ok: stealOk };
      if (!stealOk) {
        recover('error_class', { errorKind: 'injection_failed' });
        return { ok: false, errorKind: 'injection_failed', error: '前台抢占没生效：' + JSON.stringify({ steal, fgSteal }).slice(0, 240) };
      }
      // 3) 第一次输入不带 window（假设前台还是目标）→ 实际打到 decoy，目标读回为空
      const t1 = await call('act', { action: 'type', target: marker });
      await sleep(750);
      // 回读用 edit_text（WM_GETTEXT）：see text 会把标签页标题也拼进来，
      // 而标题里的文件名就含 marker —— 用它判断「打没打进去」会永远假阳性。
      const rd1 = await call('game_control', { action: 'edit_text', arg: S.recMarkers.a });
      const text1 = String((rd1 && rd1.text) || '');
      const miss = !text1.includes(marker);
      T.first = { t1, readback: text1.slice(0, 240), miss };
      recover('error_class', { errorKind: miss ? 'transient_grounding' : 'injection_no_effect' });
      if (!miss) {
        return { ok: false, errorKind: 'injection_no_effect', error: '第一次输入还是进了目标窗口，故障没注入成功（不能重试，重试会造成重复）' };
      }
      // 4) 恢复：重新 focus 目标 → 重试一次（带 window）。
      //    用 typeOnce：生产 type_text 偶发整段重发（Rust 超时后回落 8104），
      //    这里读回计数并撤回多余的份，避免工具抖动把「marker 恰好 1 次」的 oracle 打红。
      let f2 = await call('app', { action: 'focus', name: hwnd });
      await sleep(300);
      if (!f2 || !f2.ok) {
        // 2026-11-21 实测：被 UWP（计算器）抢走后，后台进程的 SetForegroundWindow 会被
        // Windows 前台锁拒绝。生产 app focus 失败时改走「最小化→还原」——还原天然取得前台，
        // 仍是生产工具，不是评测作弊；正常环境不会走到这里（预算里多留 2 次）。
        const mn = await call('app', { action: 'min', name: hwnd });
        await sleep(400);
        f2 = await call('app', { action: 'restore', name: hwnd });
        await sleep(400);
        T.focusFallback = { min: mn, restore: f2 };
      }
      const t2 = await typeOnce(marker, hwnd);
      recover('attempt', { n: 2, phase: 'refocus+retry' });
      recover('retry', { n: 2, action: 'focus+type', replanned: false });
      T.second = { f2, t2 };
      // 5) 保存：菜单「文件→保存」。本机 ctrl+s 经 SendInput 不落盘（实测），
      //    所以不用 ctrl+s，避免把「保存机制未落盘」误判成恢复失败。
      const sv = await saveNotepadViaMenu(S.recMarkers.a, hwnd);
      T.save = sv;
      return {
        ok: !!(f1 && f1.ok && f2 && f2.ok && t2 && t2.ok && sv && sv.ok),
        attempts: 2, replanCount: 0, errorKind: 'transient_grounding', save: sv, focusFallback: T.focusFallback || null,
      };
    `,
    verify: `
      const ev = recoverEvents();
      const attempts = ev.filter(e => e.kind === 'attempt').length;
      const replans = ev.filter(e => e.kind === 'replan').length;
      const errs = ev.filter(e => e.kind === 'error_class').map(e => String(e.errorKind || ''));
      return {
        ok: !!(T.first && T.first.miss && T.second && T.second.t2 && T.second.t2.ok &&
          T.save && T.save.ok && attempts === 2 && replans === 0 && errs.includes('transient_grounding')),
        attempts, replans, errs,
        firstMiss: !!(T.first && T.first.miss),
        save: T.save || null,
      };
    `,
    // 外部状态：磁盘文件的精确内容 + 最终前台是不是目标窗口（不看任务返回值）。
    hostVerify: async (task, ctx) => {
      const fs = await import('node:fs');
      const p = ctx.run.rec.a;
      const marker = ctx.run.recMarkers.a;
      let content = '';
      try { content = fs.readFileSync(p, 'utf8'); } catch (e) { /* 保持空串，下面判红 */ }
      const count = content.split(marker).length - 1;
      const fg = ctx.foreground();
      const setupV = (task.phases.setup && task.phases.setup.value) || {};
      const targetHwnd = String((setupV.target && setupV.target.hwnd) || '');
      const fgOk = !!fg && !!targetHwnd && String(fg.hwnd) === targetHwnd;
      return {
        ok: content === marker && count === 1 && fgOk,
        detail: {
          path: p, bytes: Buffer.byteLength(content), count, fgOk,
          foreground: fg ? { hwnd: fg.hwnd, title: fg.title } : null,
          targetHwnd, preview: content.slice(0, 120),
        },
      };
    },
    cleanup: `
      const out = {};
      const aliveA = (((pet({ cmd: 'windows', filter: S.recMarkers.a, max: 10 }) || {}).windows) || []).length;
      out.tab = aliveA ? await closeNotepadTab(S.recMarkers.a) : { ok: true, already: true };
      if (T.decoy && T.decoy.owned) {
        out.decoy = pet({ cmd: 'window_op', op: 'close', target: String(T.decoy.hwnd) });
      }
      return { ok: true, out };
    `,
  },

  // ── 恢复任务 2/3：结构性变化（窗口没了）→ 只补剩余，不重写已完成产物 ──────
  // 目标：part1 保存到 a.txt → 输入 part2 保存到 b.txt。
  // 注入：a.txt 保存成功后，用 ctrl+w + 保存框「保存」把承载 a 的标签页关掉
  //       （本机记事本是单窗口多标签，直接按 hwnd WM_CLOSE 会连用户其它标签一起关，
  //        这里关自己的标签页 = 任务窗口消失这同一个结构性变化）。
  // 期望：T2「窗口存在且标题含 a.txt」失败 → environment_drift；
  //       重规划 1 次、completed 含 a.txt、remaining 含 b.txt；只补 part2，a.txt 不被改写。
  // oracle：a.txt 内容仍是 markerA 且 mtime 与保存时一致；b.txt 精确等于 markerB。
  // 预算：maxSteps=18（2026-11-20 审计 P2 #20，按最坏调用点：
  //   正常 10 = typeOnce×2（type/读回）+ closeSave×2（ctrl+w/see/click）；
  //   两条 typeOnce 各自最坏 6（+4：undo/读回/补打/读回），10+4+4=18）、70s。
  {
    id: 'recover_window_closed_replan',
    title: '恢复：保存 a.txt 后窗口被关→重规划只补 b.txt（replan=1）',
    timeoutMs: 70000,
    maxWallMs: 70000,
    maxSteps: 18,
    expectedRecovery: 'replan',
    expectedReplanCount: 1,
    setup: `
      const f = await openNotepad(S.rec.b1);
      if (!f) throw new Error('恢复 B 的记事本没起来：' + S.rec.b1);
      T.win = f;
      return { ok: true, title: f.title, hwnd: f.hwnd };
    `,
    run: `
      const hwnd = String(T.win.hwnd);
      const A = S.recMarkers.b1;
      const B = S.recMarkers.b2;
      const rdText = (r) => String((r && (r.text || r.detail)) || '');
      const statA = () => { try { return require('fs').statSync(S.rec.b1).mtimeMs; } catch (e) { return null; } };
      // part1：输入 markerA → 读回计数（多打的撤回）→ 关闭标签页并在保存框点「保存」
      const t1 = await typeOnce(A, hwnd);
      recover('attempt', { n: 1, phase: 'part1+save a.txt' });
      if (!t1.ok) return { ok: false, errorKind: 'type_failed', error: 'part1 输入后读回计数=' + t1.finalCount + '（应为 1）' };
      const s1 = await closeSave(A, hwnd);
      T.aMtimeMs = statA();
      T.part1 = { typeOnce: t1, save: s1, aMtimeMs: T.aMtimeMs };
      if (!s1.ok) return { ok: false, errorKind: 'save_failed', error: 'a.txt 保存/关闭失败：' + JSON.stringify(s1).slice(0, 260) };
      // 世界变了：标题含 a.txt 的窗口已经不存在 → T2 断言失败，归类 environment_drift
      const aliveA = (((pet({ cmd: 'windows', filter: A, max: 10 }) || {}).windows) || []).length;
      recover('assert_fail', { tier: 'T2', assertion: 'window exists and title contains a.txt', errorKind: 'environment_drift' });
      recover('error_class', { errorKind: 'environment_drift' });
      // 重规划：只补剩余，不重跑已完成
      recover('replan', {
        reason: 'window closed after a.txt saved',
        completed: ['save a.txt'],
        remaining: ['type part2', 'save b.txt', 'verify'],
      });
      if (aliveA) return { ok: false, errorKind: 'injection_no_effect', error: 'a.txt 标签页还活着，窗口丢失故障没注入成功' };
      // 重规划后重新打开 b.txt（只补剩余；绝不重写 a.txt）
      const wb = await openNotepad(S.rec.b2, { quiet: true });
      if (!wb) return { ok: false, errorKind: 'reopen_failed', error: '重规划后 b.txt 窗口没起来' };
      T.winB = wb;
      const t2 = await typeOnce(B, String(wb.hwnd));
      recover('attempt', { n: 2, phase: 'part2+save b.txt' });
      if (!t2.ok) return { ok: false, errorKind: 'type_failed', error: 'part2 输入后读回计数=' + t2.finalCount + '（应为 1）' };
      const s2 = await closeSave(B, String(wb.hwnd));
      T.part2 = { typeOnce: t2, save: s2 };
      return {
        ok: !!(t1 && t1.ok && s1.ok && t2 && t2.ok && s2.ok),
        attempts: 2, replanCount: 1, errorKind: 'environment_drift',
        aMtimeMs: T.aMtimeMs, bOpen: wb.title,
      };
    `,
    verify: `
      const ev = recoverEvents();
      const attempts = ev.filter(e => e.kind === 'attempt').length;
      const replans = ev.filter(e => e.kind === 'replan');
      const rp = replans[0] || {};
      const completed = rp.completed || [];
      const remaining = rp.remaining || [];
      const hasCompletedA = completed.some(x => String(x).includes('a.txt'));
      const hasRemainingB = remaining.some(x => String(x).includes('b.txt'));
      return {
        ok: !!(replans.length === 1 && attempts >= 2 && hasCompletedA && hasRemainingB &&
          T.aMtimeMs && T.part1 && T.part1.typeOnce && T.part1.typeOnce.ok && T.part1.save && T.part1.save.ok &&
          T.part2 && T.part2.typeOnce && T.part2.typeOnce.ok && T.part2.save && T.part2.save.ok),
        attempts,
        replans: replans.length,
        completed, remaining,
        aMtimeMs: T.aMtimeMs || null,
        part1: T.part1 ? T.part1.save : null,
        part2: T.part2 ? T.part2.save : null,
      };
    `,
    // 外部状态：两个文件的字节 + a.txt 的 mtime（证明没被二次写入）+ 两个标签页都不在了。
    hostVerify: async (task, ctx) => {
      const fs = await import('node:fs');
      const A = ctx.run.recMarkers.b1;
      const B = ctx.run.recMarkers.b2;
      let a = '';
      let b = '';
      let aStat = null;
      try { a = fs.readFileSync(ctx.run.rec.b1, 'utf8'); aStat = fs.statSync(ctx.run.rec.b1); } catch (e) { /* 空 → 判红 */ }
      try { b = fs.readFileSync(ctx.run.rec.b2, 'utf8'); } catch (e) { /* 空 → 判红 */ }
      const v = (task.phases.verify && task.phases.verify.value) || {};
      const runV = (task.phases.run && task.phases.run.value) || {};
      const aSavedMs = Number(v.aMtimeMs || runV.aMtimeMs);
      const mtimeSame = !!aStat && Number.isFinite(aSavedMs) && Math.abs(aStat.mtimeMs - aSavedMs) < 0.001;
      const countA = a.split(A).length - 1;
      const countB = b.split(B).length - 1;
      const tabsA = ctx.petWindows(A).filter((w) => String(w.title || '').includes(A));
      const tabsB = ctx.petWindows(B).filter((w) => String(w.title || '').includes(B));
      return {
        ok: a === A && b === B && countA === 1 && countB === 1 &&
          !a.includes(B) && !b.includes(A) && mtimeSame && tabsA.length === 0 && tabsB.length === 0,
        detail: {
          a: { bytes: Buffer.byteLength(a), count: countA, mtimeMs: aStat ? aStat.mtimeMs : null, savedMs: Number.isFinite(aSavedMs) ? aSavedMs : null, mtimeSame },
          b: { bytes: Buffer.byteLength(b), count: countB },
          tabsLeft: { a: tabsA.length, b: tabsB.length },
          preview: { a: a.slice(0, 120), b: b.slice(0, 120) },
        },
      };
    },
    cleanup: `
      const out = {};
      for (const m of [S.recMarkers.b1, S.recMarkers.b2]) {
        const alive = (((pet({ cmd: 'windows', filter: m, max: 10 }) || {}).windows) || []).length;
        if (alive) out[m] = await closeNotepadTab(m);
      }
      return { ok: true, out };
    `,
  },

  // ── 恢复任务 3/3：不确定副作用（保存超时但实际成功）→ 先读确认，不重复输入 ──
  // 目标：在已有文件末尾追加一行唯一标记。
  // 注入：关闭保存框那次「保存」点击真实执行（文件真的落盘、标签页真的关闭），
  //       但 executeTool 的返回值被换成长相如 withTimeout 的超时错误
  //       （action_sent:true, verified:null）——「已发出、未确认」。
  // 期望：不原样重试；先用 file 工具只读确认；标记出现次数恰好 1。
  // oracle：文件逐字节等于「初始内容 + marker」；marker 恰好 1 次；初始内容完整保留。
  // 预算：maxSteps=11（2026-11-20 审计 P2 #20，按最坏调用点：
  //   正常 7 = ctrl+end 1 + typeOnce 2（type/读回）+ closeSave 3（ctrl+w/see/click）+ file read 1；
  //   typeOnce 最坏 6（+4：undo/读回/补打/读回），7+4=11）、45s。
  {
    id: 'recover_uncertain_side_effect',
    title: '恢复：保存返回超时但实际成功→先读确认不重试（marker=1）',
    timeoutMs: 45000,
    maxWallMs: 45000,
    maxSteps: 11,
    expectedRecovery: 'verify_before_retry',
    setup: `
      const f = await openNotepad(S.rec.c);
      if (!f) throw new Error('恢复 C 的记事本没起来：' + S.rec.c);
      T.win = f;
      try {
        T.init = require('fs').readFileSync(S.rec.c, 'utf8');
        T.initMtimeMs = require('fs').statSync(S.rec.c).mtimeMs;
      } catch (e) { throw new Error('读初始内容失败：' + String(e && e.message || e)); }
      return { ok: true, title: f.title, hwnd: f.hwnd, initLen: T.init.length };
    `,
    run: `
      const hwnd = String(T.win.hwnd);
      const marker = S.recMarkers.c;
      const rdText = (r) => String((r && (r.text || r.detail)) || '');
      // 1) 光标到末尾 → 追加标记（初始内容以 CRLF 结尾，marker 会落在新的一行）
      const k1 = await call('act', { action: 'key', target: 'ctrl+end', window: hwnd });
      await sleep(220);
      const t1 = await typeOnce(marker, hwnd);
      T.append = { k1, typeOnce: t1, readback: t1.readback, has: t1.ok };
      if (!t1.ok) return { ok: false, errorKind: 'type_failed', error: '追加输入后读回计数=' + t1.finalCount + '（应为 1）' };
      recover('attempt', { n: 1, phase: 'append+save', errorKind: 'uncertain_side_effect', actionSent: true, verified: null });
      // 2) 保存 + 伪造超时：真实点击会保存并关掉标签页，返回值却是「超时、未确认」
      const sv = await closeSave(marker, hwnd, { injectTimeout: true });
      T.inject = sv;
      if (!sv.injected) {
        recover('error_class', { errorKind: 'injection_failed' });
        return { ok: false, errorKind: 'injection_failed', error: '超时注入没生效：' + JSON.stringify(sv).slice(0, 260) };
      }
      recover('error_class', { errorKind: 'uncertain_side_effect' });
      // 3) 不确定副作用的正确恢复：先只读确认，绝不原样重试输入/保存
      const rd = await call('file', { action: 'read', path: S.rec.c });
      // file.read 的 detail = 一行头（含文件名，文件名里就有 marker）+ 换行 + 正文；
      // 只数正文，避免把路径里的 marker 也算进去（否则恒为 2）。
      const rawDetail = String((rd && rd.detail) || '');
      const nl = rawDetail.indexOf('\\n');
      const detail = nl >= 0 ? rawDetail.slice(nl + 1) : rawDetail;
      const cnt = (detail.match(new RegExp(marker, 'g')) || []).length;
      T.confirm = { read: rd, count: cnt };
      recover('verify_read', { tool: 'file.read', markerCount: cnt, beforeRetry: true });
      T.retries = 0;
      // 读到 0 说明保存确实没成；此时才允许补一次保存（仍不重新输入）。实测这条分支不该走到。
      let saved = sv.clickOk;
      if (cnt === 0) {
        const left = (((pet({ cmd: 'windows', filter: marker, max: 10 }) || {}).windows) || []).length;
        if (left) {
          const sv2 = await closeSave(marker, hwnd, { action: 'save' });
          recover('retry', { n: 2, action: 'save-only', reason: 'verify_read 未找到标记' });
          T.retries = 1;
          saved = !!(sv2 && sv2.ok);
        }
      }
      return {
        ok: !!(t1.ok && saved && cnt >= 1),
        attempts: 1, replanCount: 0, errorKind: 'uncertain_side_effect',
        markerCount: cnt, retries: T.retries, inject: sv,
      };
    `,
    verify: `
      const ev = recoverEvents();
      const attempts = ev.filter(e => e.kind === 'attempt').length;
      const reads = ev.filter(e => e.kind === 'verify_read').length;
      const retries = ev.filter(e => e.kind === 'retry').length;
      const cnt = T.confirm ? Number(T.confirm.count) : -1;
      return {
        ok: !!(T.append && T.append.typeOnce && T.append.typeOnce.ok &&
          T.inject && T.inject.injected && T.inject.timeoutReturned &&
          attempts === 1 && reads === 1 && retries === 0 && cnt === 1),
        attempts, reads, retries, markerCount: cnt,
        inject: T.inject || null,
      };
    `,
    // 外部状态：逐字节比对（初始内容 + marker）、marker 恰好 1 次、标签页已关闭。
    hostVerify: async (task, ctx) => {
      const fs = await import('node:fs');
      const p = ctx.run.rec.c;
      const marker = ctx.run.recMarkers.c;
      const initial = ctx.run.recCInitial;
      let content = '';
      try { content = fs.readFileSync(p, 'utf8'); } catch (e) { /* 空 → 判红 */ }
      const expected = initial + marker;
      const count = content.split(marker).length - 1;
      const tabs = ctx.petWindows(marker).filter((w) => String(w.title || '').includes(marker));
      return {
        ok: content === expected && count === 1 && content.startsWith(initial) && tabs.length === 0,
        detail: {
          path: p,
          bytes: Buffer.byteLength(content),
          expectedBytes: Buffer.byteLength(expected),
          count,
          prefixOk: content.startsWith(initial),
          tabsLeft: tabs.length,
          preview: content.slice(0, 240),
        },
      };
    },
    cleanup: `
      const alive = (((pet({ cmd: 'windows', filter: S.recMarkers.c, max: 10 }) || {}).windows) || []).length;
      if (!alive) return { ok: true, already: true };
      return await closeNotepadTab(S.recMarkers.c);
    `,
  },
];

// ── 熔断自检（--stall-test / EVAL_STALL_TEST=1）────────────────────────────
// 用真实工具制造真实的「无变化」：连续把窗口 move 到它当前所在的坐标。
// 动作真的发出去了、窗口真的没动 —— 这正是 planner 卡死时反复点同一个按钮的形态。
// 这条任务本来就该被判红（effect:'no-change'），runner 会把「判红」当成自检通过。
export const NOCHANGE_SELFTEST = {
  id: '__nochange_selftest__',
  title: '熔断自检：连续 4 次把窗口移到当前坐标（真实动作、真实无变化）',
  timeoutMs: 30000,
  expectNoChange: true,
  setup: `
    const w = (await winList()).find(x => String(x.title || '').includes(S.marker));
    if (!w) throw new Error('熔断自检需要记事本夹具窗口（它提供稳定的状态指纹）');
    T.rect = { x: w.x, y: w.y };
    return { ok: true, rect: T.rect };
  `,
  run: `
    const seq = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await call('app', { action: 'move', name: S.marker, x: T.rect.x, y: T.rect.y });
      seq.push({ i: i + 1, ok: !!(r && r.ok) });
      await sleep(150);
    }
    return { ok: true, seq };
  `,
  verify: `return { ok: true, note: '不该走到这里：熔断应当在 run 阶段就抛出' };`,
  cleanup: `return { ok: true, note: '窗口从未离开原位，无需还原' };`,
};
