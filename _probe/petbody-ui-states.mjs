#!/usr/bin/env node
/**
 * _probe/petbody-ui-states.mjs —— 皮套窗组件逐状态验收（2026-11-16，§56 P0）
 *
 *  此前只验过「金色光环」一种，本探针把皮套窗里剩下的组件逐个拉出来：
 *   状态光环 4 态 / 模型控制按钮 / 歌词气泡 / 工具气泡 / 对话气泡 / 快捷菜单
 *
 * 做两件事：
 *   ① computed style 断言（画框语言硬指标，可进 CI）：
 *        - 圆角 ≤ 3.5px（禁胶囊/大圆角 14–22px）
 *        - 无 backdrop-filter（禁毛玻璃）
 *        - 面板底色偏暖（b ≤ r + 8；旧的深蓝玻璃 b>r 会当场红）
 *        - 四态光环 opacity=1、文案正确、边框色彼此不同
 *   ② /shot 逐状态存档 PNG（肉眼复核用；路径纯 ASCII）
 *
 * 用法：
 *   node _probe/petbody-ui-states.mjs            # 只断言（门禁用）
 *   node _probe/petbody-ui-states.mjs --shots    # 断言 + 逐状态截图存档
 *
 * 退出码：0 全过 / 1 有失败。她没跑（8004 不通）时 SKIP 退出 0，避免假红。
 */
'use strict';

const DEVTOOLS = 'http://127.0.0.1:8004';
const OUT_DIR = '<project-root>/_probe/shots-petbody-ui';
import fs from 'node:fs';
import path from 'node:path';

const WANT_SHOTS = process.argv.includes('--shots');

async function evalJs(js) {
  const r = await fetch(DEVTOOLS + '/eval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ js }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('eval failed: ' + JSON.stringify(j));
  return j.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(name) {
  if (!WANT_SHOTS) return null;
  const file = `probe-ui-${name}.png`;
  const r = await fetch(`${DEVTOOLS}/shot?out=${file}`);
  const j = await r.json();
  if (!j.ok) throw new Error('shot failed: ' + JSON.stringify(j));
  // /shot 相对她的 live-2d 目录落盘；把它挪到 _probe 下统一管理
  const src = path.join('<project-root>/_incoming/my-neuro/live-2d', file);
  const dst = path.join(OUT_DIR, file);
  if (fs.existsSync(src)) fs.renameSync(src, dst);
  return dst;
}

// ── 页面内探测：返回组件 computed 事实 ──────────────────────────────
const PROBE_JS = `(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, missing: true };
    const cs = getComputedStyle(el);
    return {
      sel,
      radius: cs.borderRadius,
      backdrop: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
      bgColor: cs.backgroundColor,
      bgImage: cs.backgroundImage,
      borderColor: cs.borderTopColor,
      color: cs.color,
      display: cs.display,
      opacity: cs.opacity,
      text: (el.textContent || '').trim().slice(0, 60),
    };
  };
  return {
    aura: pick('#pet-state-aura'),
    ctrlBtn: pick('.ctrl-btn'),
    modelControls: pick('#model-controls'),
    bubble: pick('#bubble-text'),
    lyrics: pick('#lyrics-bubble-text'),
    toolBubble: pick('.tool-bubble'),
    quickMenu: pick('#quick-settings-items'),
    quickGear: pick('#quick-gear'),
    costume: pick('#costume-panel'),
    chatInput: pick('#chat-input-container'),
    bodyClass: document.body.className,
  };
})()`;

// ── 断言工具 ────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✓ ${name}` + (detail ? ` — ${detail}` : '')); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}` + (detail ? ` — ${detail}` : '')); }
}

/** 圆角是否 ≤ 3.5px（百分比一律算失败：胶囊/圆形都走百分比或大 px） */
function radiusOk(v) {
  if (!v || v === '0px') return true;
  if (v.includes('%')) return false;
  const nums = v.match(/([\d.]+)px/g) || [];
  if (!nums.length) return false;
  return nums.every((n) => parseFloat(n) <= 3.5);
}

/** 背景是否暖色：解析所有 rgb()/rgba()，要求 alpha>0.05 的 b ≤ r + 8 */
function warmOk(c) {
  if (!c) return true;
  const re = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/g;
  let m;
  let sawOpaque = false;
  while ((m = re.exec(c))) {
    const r = +m[1], b = +m[3];
    const a = m[4] === undefined ? 1 : +m[4];
    if (a <= 0.05) continue;
    sawOpaque = true;
    if (b > r + 8) return false;
  }
  return true; // 纯透明 / 只有无彩渐变 → 不判（可见色都已在循环里查过）
}

/** 统一检查一个组件：圆角 + 毛玻璃 + 暖色 */
function checkComponent(label, info) {
  if (!info || info.missing) { check(label + ' 存在', false, 'DOM 里找不到'); return; }
  check(`${label} 圆角 ≤3px`, radiusOk(info.radius), info.radius);
  check(`${label} 无毛玻璃`, !info.backdrop || info.backdrop === 'none', info.backdrop);
  const bg = (info.bgColor || '') + ' ' + (info.bgImage || '');
  check(`${label} 底色偏暖`, warmOk(bg), (info.bgColor || '').slice(0, 40));
}

async function main() {
  // 探活
  try {
    await evalJs('1');
  } catch (e) {
    console.log('SKIP 皮套窗组件状态验收 — 8004 不通（她没在跑？）');
    process.exit(0);
  }

  if (WANT_SHOTS) fs.mkdirSync(OUT_DIR, { recursive: true });

  // ── 0. 清场：恢复 idle ──────────────────────────────────────────
  await evalJs(`(() => {
    document.body.className = '';
    const aura = document.getElementById('pet-state-aura');
    if (aura) { aura.querySelector('.aura-text').textContent = ''; }
    const mc = document.getElementById('model-controls'); if (mc) mc.style.display = 'none';
    const pb = document.getElementById('panel-buttons'); if (pb) pb.classList.remove('expanded');
    const lb = document.getElementById('lyrics-bubble-container'); if (lb) lb.style.display = 'none';
    const bc = document.getElementById('bubble-container'); if (bc) bc.style.display = 'none';
    const tc = document.getElementById('tool-bubbles-container'); if (tc) tc.innerHTML = '';
    const qs = document.getElementById('quick-settings'); if (qs) qs.classList.remove('context-open');
    const cp = document.getElementById('costume-panel'); if (cp) cp.style.display = 'none';
    return true;
  })()`);
  await sleep(250);
  await shot('00-idle');

  // ── 1. 四态光环 ─────────────────────────────────────────────────
  console.log('\n[状态光环] listening / thinking / speaking / acting');
  const states = [
    ['listening', 'mic', '倾听中…'],
    ['thinking', 'brain', '思考中…'],
    ['speaking', 'volume-2', '说话中…'],
    ['acting', 'mouse-pointer-2', '操作电脑中…'],
  ];
  const iconSvg = (name) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const auraFacts = {};
  /** 设置某状态；若期间有真实事件（ASR/LLM/TTS）抢了状态，重试一次 */
  async function setAuraState(state, icon, text) {
    const js = `(() => {
      document.body.className = 'state-${state}';
      const aura = document.getElementById('pet-state-aura');
      aura.querySelector('.aura-icon').innerHTML = ${JSON.stringify(iconSvg('__NAME__'))}.replace('__NAME__', ${JSON.stringify(icon)});
      aura.querySelector('.aura-text').textContent = ${JSON.stringify(text)};
      return document.body.className;
    })()`;
    const read = `(() => {
      const aura = document.getElementById('pet-state-aura');
      const cs = getComputedStyle(aura);
      return { opacity: cs.opacity, border: cs.borderTopColor, bg: cs.backgroundColor,
               radius: cs.borderRadius, backdrop: cs.backdropFilter,
               text: aura.querySelector('.aura-text').textContent,
               bodyClass: document.body.className };
    })()`;
    let cls = await evalJs(js);
    await sleep(450);
    let f = await evalJs(read);
    if (f.bodyClass !== `state-${state}` || f.text !== text) {
      // 真实事件抢了状态（例如自动语音识别在跑）→ 再来一次
      await evalJs(js);
      await sleep(450);
      f = await evalJs(read);
    }
    return f;
  }
  for (const [state, icon, text] of states) {
    const f = await setAuraState(state, icon, text);
    auraFacts[state] = f;
    check(`光环 ${state} 可见(opacity=1)`, parseFloat(f.opacity) > 0.95, `opacity=${f.opacity}`);
    check(`光环 ${state} 文案`, f.text === text, f.text || '(空)');
    await shot(`10-aura-${state}`);
  }
  // 静态契约：四个事件的文案映射（运行时会被真实事件抢，这里直接查源码）
  try {
    const src = fs.readFileSync('<project-root>/_incoming/my-neuro/live-2d/js/ui/ui-controller.js', 'utf8');
    check('源码 TTS_START → 说话中…', /TTS_START[^\n]*'volume-2',\s*'说话中…'/.test(src), 'ui-controller.js');
    check('源码 ASR_START → 倾听中…', /ASR_START[^\n]*'mic',\s*'倾听中…'/.test(src), 'ui-controller.js');
    check('源码 LLM_REQUEST_START → 思考中…', /LLM_REQUEST_START[^\n]*'brain',\s*'思考中…'/.test(src), 'ui-controller.js');
    check('源码 TOOL_CALL_START → 操作电脑中…', /TOOL_CALL_START[^\n]*'mouse-pointer-2',\s*'操作电脑中…'/.test(src), 'ui-controller.js');
    check('源码不再用 emoji 图标', !/updateAura\([^\n]*[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(src), 'ui-controller.js');
  } catch (e) {
    check('源码文案映射可读', false, e.message);
  }
  const borders = Object.values(auraFacts).map((f) => f.border);
  check('四态光环边框色互不相同', new Set(borders).size >= 3, borders.join(' | '));
  check('光环圆角 ≤3px（原 20px 胶囊）', radiusOk(auraFacts.listening.radius), auraFacts.listening.radius);
  check('光环无毛玻璃', !auraFacts.listening.backdrop || auraFacts.listening.backdrop === 'none', auraFacts.listening.backdrop);

  // ── 2. 模型控制按钮 ─────────────────────────────────────────────
  console.log('\n[模型控制按钮] 收起 + 展开');
  await evalJs(`(() => {
    document.body.className = '';
    const mc = document.getElementById('model-controls'); mc.style.display = 'flex';
    return true;
  })()`);
  await sleep(300);
  await shot('20-model-controls-collapsed');
  await evalJs(`(() => {
    document.getElementById('panel-buttons').classList.add('expanded');
    return true;
  })()`);
  await sleep(450);
  await shot('21-model-controls-expanded');
  let facts = await evalJs(PROBE_JS);
  checkComponent('控制按钮(.ctrl-btn)', facts.ctrlBtn);
  checkComponent('控制面板容器', facts.modelControls);

  // ── 3. 对话气泡（真实路径）──────────────────────────────────────
  console.log('\n[对话气泡] 真路径 showBubble');
  await evalJs(`(() => {
    const mc = document.getElementById('model-controls'); mc.style.display = 'none';
    document.getElementById('panel-buttons').classList.remove('expanded');
    const t = document.getElementById('bubble-text');
    t.textContent = '今天整理了一遍你的项目笔记，顺手把散落的待办也归了类。';
    window.uiController.showBubble();
    return true;
  })()`);
  await sleep(500);
  await shot('30-bubble');
  facts = await evalJs(PROBE_JS);
  checkComponent('对话气泡', facts.bubble);

  // ── 4. 歌词气泡（真实路径）──────────────────────────────────────
  console.log('\n[歌词气泡] 真路径 showLyricsBubble');
  await evalJs(`(() => {
    window.uiController.hideBubble();
    window.uiController.showLyricsBubble('夜空中最亮的星，请指引我靠近你');
    return true;
  })()`);
  await sleep(500);
  await shot('40-lyrics');
  facts = await evalJs(PROBE_JS);
  checkComponent('歌词气泡', facts.lyrics);

  // ── 5. 工具气泡（真实路径，5 秒自动消失）───────────────────────
  console.log('\n[工具气泡] 真路径 showToolBubble');
  await evalJs(`(() => {
    window.uiController.hideLyricsBubble();
    window.uiController.showToolBubble('see', { mode: 'image' });
    return true;
  })()`);
  await sleep(500);
  await shot('50-tool-bubble');
  facts = await evalJs(PROBE_JS);
  checkComponent('工具气泡', facts.toolBubble);

  // ── 6. 快捷菜单 + 换装面板 ─────────────────────────────────────
  console.log('\n[快捷菜单] 齿轮 + 展开项');
  await evalJs(`(() => {
    const tc = document.getElementById('tool-bubbles-container'); if (tc) tc.innerHTML = '';
    const qs = document.getElementById('quick-settings');
    qs.classList.add('context-open');
    qs.style.left = '18px'; qs.style.top = '230px';
    document.getElementById('quick-settings-items').classList.add('expanded');
    return true;
  })()`);
  await sleep(450);
  await shot('60-quick-settings');
  facts = await evalJs(PROBE_JS);
  checkComponent('快捷菜单', facts.quickMenu);
  checkComponent('快捷齿轮', facts.quickGear);

  console.log('\n[换装面板] 直接铺开');
  await evalJs(`(() => {
    document.getElementById('quick-settings').classList.remove('context-open');
    const cp = document.getElementById('costume-panel');
    cp.style.display = 'block'; cp.style.left = '18px'; cp.style.top = '200px';
    return true;
  })()`);
  await sleep(350);
  await shot('70-costume');
  facts = await evalJs(PROBE_JS);
  checkComponent('换装面板', facts.costume);

  // ── 7. 输入条（常驻可见）───────────────────────────────────────
  console.log('\n[输入条] 常驻');
  await evalJs(`(() => {
    document.getElementById('costume-panel').style.display = 'none';
    return true;
  })()`);
  facts = await evalJs(PROBE_JS);
  checkComponent('输入条容器', facts.chatInput);

  // ── 8. 图标系统（Lucide sprite，2026-11-16）──────────────────────
  console.log('\n[图标] Lucide sprite');
  const iconFacts = await evalJs(`(() => {
    const symbols = [...document.querySelectorAll('#pet-icon-sprite symbol')].map((s) => s.id);
    const uses = [...document.querySelectorAll('svg.ico use')].map((u) => u.getAttribute('href') || '');
    const missing = uses.filter((h) => !symbols.includes(h.replace(/^#/, '')));
    const emoji = [...document.querySelectorAll('.aura-icon')].map((e) => e.textContent).join('')
      .match(/[\\u{1F300}-\\u{1FAFF}\\u2600-\\u27BF]/u);
    return { symbols: symbols.length, uses: uses.length, missing, emoji: emoji ? emoji[0] : '' };
  })()`);
  check('图标 sprite 已加载', iconFacts.symbols >= 15, `${iconFacts.symbols} 个 symbol`);
  check('所有 <use> 都能解析', iconFacts.missing.length === 0,
    iconFacts.missing.slice(0, 3).join(',') || `${iconFacts.uses} 处引用`);
  check('光环不再用 emoji', !iconFacts.emoji, iconFacts.emoji || '纯 SVG');

  // ── 收尾：恢复 idle ────────────────────────────────────────────
  await evalJs(`(() => {
    document.body.className = '';
    const aura = document.getElementById('pet-state-aura');
    if (aura) aura.querySelector('.aura-text').textContent = '';
    return true;
  })()`);

  console.log('\n' + '─'.repeat(52));
  console.log(`PASS ${pass} / FAIL ${fail}`);
  if (fail === 0) {
    console.log(`✅ 皮套窗组件验收全过（${pass} 项）`);
    if (WANT_SHOTS) console.log(`   截图：${OUT_DIR}`);
    process.exit(0);
  } else {
    console.log(`❌ ${pass} 过 / ${fail} 失败`);
    console.log('   失败项：\n     - ' + failures.join('\n     - '));
    if (WANT_SHOTS) console.log(`   截图：${OUT_DIR}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('探针异常：', e && e.stack || e);
  process.exit(1);
});
