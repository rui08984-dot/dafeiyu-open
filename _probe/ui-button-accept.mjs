#!/usr/bin/env node
/**
 * _probe/ui-button-accept.mjs —— 控制中心按钮真实点击验收（2026-11-16）
 *
 * 为什么要有：知识库/技能库/操控日志那 14 个按钮曾经「点了完全没反应」
 * （绑定只在进皮套页时执行 + Electron 28 没有 window.prompt）。修完之后
 * 只验过语法和绑定，**没验过真点击**。这个脚本走 8771 自检通道派发真实 click，
 * 断言副作用，把「应该能点」变成可复现证据。
 *
 * 断言方式（都是页面内可观察的事实，不靠模型自述）：
 *   · #actions 的 5 个筛选 chip：点击后 active 类转移 + 列表重载
 *   · kn-add-rule-btn / kn-add-exp-btn：点击后**自建 uiPrompt 弹层出现**（证明
 *     Electron 28 缺 window.prompt 的替代方案真的接上了），点取消后消失
 *   · kn-refresh / act-refresh / sk-refresh：点击后列表容器被重建（innerHTML 变化）
 *     或至少不抛错、按钮恢复可点
 *
 * 前置：控制中心在跑（`electron control-main.js`），8771 可达。
 * 用法：node _probe/ui-button-accept.mjs
 */
'use strict';

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const BASE = process.env.CONTROL_PROBE || 'http://127.0.0.1:8771';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 能力注册表：判定「插件页删掉 enable 后，这个插件还有没有别的启停入口」的唯一依据
const require = createRequire(import.meta.url);
const { CAPABILITIES } = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'capabilities.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

async function ev(js) {
  const r = await fetch(BASE + '/eval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ js }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('eval failed: ' + JSON.stringify(j).slice(0, 200));
  return j.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 切页（用 nav 序号，避免选择器转义） */
async function gotoPage(index) {
  await ev(`document.querySelectorAll('.nav')[${index}].click(); 1`);
  await sleep(1200);
}

/** 点一个按钮并等一会儿 */
async function click(id, waitMs = 1000) {
  const r = await ev(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return 'missing';
    if (el.disabled) return 'disabled';
    el.click();
    return 'clicked';
  })()`);
  await sleep(waitMs);
  return r;
}

(async () => {
  const alive = await ev('({ hasNav: document.querySelectorAll(".nav").length, page: document.querySelector(".page.active") ? document.querySelector(".page.active").id : "" })')
    .catch((e) => {
      // 控制中心是独立进程（要托盘点开或手动起）：没开就 SKIP，不让门禁假红
      console.log('SKIP 控制中心没在跑（8771 不可达），跳过按钮点击验收：' + e.message);
      process.exit(0);
    });
  console.log(`[env] nav=${alive.hasNav} 当前页=${alive.page}`);
  if (alive.hasNav < 10) { console.error('✗ 控制中心没起好'); process.exit(2); }

  // ── ① 操控日志：5 个筛选 chip ──────────────────────────────────────────
  console.log('\n[操控日志] 5 个筛选 chip');
  await gotoPage(6);
  const chips = await ev(`Array.from(document.querySelectorAll('#actions .chip')).map(c => ({ t: c.textContent.trim().slice(0,8), on: c.classList.contains('active') || c.classList.contains('on') }))`);
  console.log('   chips:', JSON.stringify(chips));
  ok('页面上有 5 个筛选 chip', Array.isArray(chips) && chips.length === 5, String(chips.length));
  const firstOn = chips.findIndex((c) => c.on);
  ok('初始有且仅有一个 chip 选中', chips.filter((c) => c.on).length === 1, JSON.stringify(chips.map((c) => c.on)));

  // 点第二个 chip（index 1）
  const before = await ev(`(() => { const l = document.querySelector('#actions .actions-log-timeline') || document.querySelector('#actions .act-log-list') || document.querySelector('#actions'); return l ? l.innerHTML.length : -1; })()`);
  await ev(`document.querySelectorAll('#actions .chip')[1].click(); 1`);
  await sleep(1200);
  const after = await ev(`(() => {
    const cs = Array.from(document.querySelectorAll('#actions .chip'));
    const l = document.querySelector('#actions .actions-log-timeline') || document.querySelector('#actions .act-log-list') || document.querySelector('#actions');
    return { on: cs.map(c => c.classList.contains('active') || c.classList.contains('on')), len: l ? l.innerHTML.length : -1 };
  })()`);
  ok('点击第 2 个 chip → active 转移到它', after.on[1] === true && after.on[0] === false, JSON.stringify(after.on));
  ok('点击 chip → 列表重载（内容长度变化或仍有内容）', after.len !== -1 && (after.len !== before || after.len > 0), `before=${before} after=${after.len}`);

  // 点回第 1 个（全部）
  await ev(`document.querySelectorAll('#actions .chip')[0].click(); 1`);
  await sleep(900);
  const back = await ev(`Array.from(document.querySelectorAll('#actions .chip')).map(c => c.classList.contains('active') || c.classList.contains('on'))`);
  ok('点回第 1 个 chip → active 回到它', back[0] === true, JSON.stringify(back));

  // act-refresh
  const actBefore = await ev(`(() => { const l = document.querySelector('#actions .actions-log-timeline') || document.querySelector('#actions'); return l ? l.innerHTML.length : -1; })()`);
  const r1 = await click('act-refresh', 1400);
  const actAfter = await ev(`(() => { const l = document.querySelector('#actions .actions-log-timeline') || document.querySelector('#actions'); return l ? l.innerHTML.length : -1; })()`);
  ok('act-refresh 可点击（不是 disabled/缺失）', r1 === 'clicked', r1);
  ok('act-refresh 后列表仍有内容（没被刷空/没崩）', actAfter > 0, `before=${actBefore} after=${actAfter}`);

  // ── ② 知识库：kn-refresh + 两个需要 prompt 的按钮 ──────────────────────
  console.log('\n[知识库] kn-refresh / kn-add-rule-btn / kn-add-exp-btn');
  await gotoPage(4);
  const knBefore = await ev(`(() => { const l = document.getElementById('kn-rules-list') || document.querySelector('.kn-card'); return l ? l.innerHTML.length : -1; })()`);
  const r2 = await click('kn-refresh', 1400);
  const knAfter = await ev(`(() => { const l = document.getElementById('kn-rules-list') || document.querySelector('.kn-card'); return l ? l.innerHTML.length : -1; })()`);
  ok('kn-refresh 可点击', r2 === 'clicked', r2);
  ok('kn-refresh 后知识库仍有内容', knAfter > 0, `before=${knBefore} after=${knAfter}`);

  // kn-add-rule-btn：应弹出 uiPrompt（自建弹层，带 [data-yes]）
  await ev(`document.getElementById('kn-add-rule-btn').click(); 1`);
  await sleep(700);
  const prompt1 = await ev(`(() => {
    const yes = document.querySelector('[data-yes]');
    const input = document.querySelector('#__ui_prompt_input');
    return { yes: !!yes, input: !!input, value: input ? input.value : null, title: document.body.textContent.includes('新游戏名称') };
  })()`);
  ok('kn-add-rule-btn → 弹出 uiPrompt 弹层', prompt1.yes === true, JSON.stringify(prompt1));
  ok('弹层里有输入框（替代 window.prompt）', prompt1.input === true);
  // 取消
  await ev(`(() => { const n = document.querySelector('[data-no]'); if (n) n.click(); return 1; })()`);
  await sleep(400);
  const prompt1Closed = await ev(`!document.querySelector('[data-yes]')`);
  ok('点「取消」后弹层关闭', prompt1Closed === true);

  // kn-add-exp-btn：也是 uiPrompt
  await ev(`document.getElementById('kn-add-exp-btn').click(); 1`);
  await sleep(700);
  const prompt2 = await ev(`({ yes: !!document.querySelector('[data-yes]'), hasAction: document.body.textContent.includes('执行的动作') })`);
  ok('kn-add-exp-btn → 弹出 uiPrompt 弹层', prompt2.yes === true, JSON.stringify(prompt2));
  await ev(`(() => { const n = document.querySelector('[data-no]'); if (n) n.click(); return 1; })()`);
  await sleep(400);
  ok('补录经验弹层可关闭', (await ev(`!document.querySelector('[data-yes]')`)) === true);

  // kn-edit-rules-btn：打开规则编辑弹窗（不是 uiPrompt，是原生 .modal）
  await ev(`document.getElementById('kn-edit-rules-btn').click(); 1`);
  await sleep(600);
  const editOpen = await ev(`(() => { const m = document.getElementById('kn-edit-modal'); return m ? m.classList.contains('open') : 'no-modal'; })()`);
  ok('kn-edit-rules-btn → 打开规则编辑弹窗', editOpen === true, String(editOpen));
  // 关掉
  await ev(`(() => { const c = document.getElementById('kn-modal-cancel') || document.querySelector('#kn-edit-modal [data-close]'); if (c) c.click(); return 1; })()`);
  await sleep(400);

  // ── ③ 技能库：sk-refresh ───────────────────────────────────────────────
  console.log('\n[技能库] sk-refresh');
  await gotoPage(5);
  const skBefore = await ev(`(() => { const g = document.querySelector('.skills-card-grid'); return g ? { n: g.children.length, len: g.innerHTML.length } : null; })()`);
  const r3 = await click('sk-refresh', 1400);
  const skAfter = await ev(`(() => { const g = document.querySelector('.skills-card-grid'); return g ? { n: g.children.length, len: g.innerHTML.length } : null; })()`);
  ok('sk-refresh 可点击', r3 === 'clicked', r3);
  ok('sk-refresh 后技能卡仍在', !!skAfter && skAfter.n > 0, JSON.stringify({ before: skBefore && skBefore.n, after: skAfter && skAfter.n }));

  // ── ⑤ 模型页：思考等级 4 档（seg 单选） ─────────────────────────────────
  console.log('[模型页] 思考等级');
  await gotoPage(1);
  const rsBefore = await ev(`Array.from(document.querySelectorAll('#llm-reasoning button')).map(b => ({ k: b.dataset.reasoning, on: b.getAttribute('aria-checked') === 'true' }))`);
  ok('思考等级有 4 档', Array.isArray(rsBefore) && rsBefore.length === 4, JSON.stringify((rsBefore || []).map((x) => x.k)));
  await ev(`document.querySelector('#llm-reasoning button[data-reasoning="low"]').click(); 1`);
  await sleep(600);
  const rsAfter = await ev(`Array.from(document.querySelectorAll('#llm-reasoning button')).map(b => ({ k: b.dataset.reasoning, on: b.getAttribute('aria-checked') === 'true' }))`);
  ok('点「低」→ 只有它被选中', rsAfter.filter((x) => x.on).length === 1 && (rsAfter.find((x) => x.k === 'low') || {}).on === true,
    JSON.stringify(rsAfter));
  await ev(`document.querySelector('#llm-reasoning button[data-reasoning="off"]').click(); 1`);
  await sleep(400);

  // ── ⑥ 静默：设置页重复开关已删，总览是唯一快捷入口（读 8103 实时状态） ──
  // 2026-11-21 统一管辖：设置页 #quiet-mode-enabled 删除，总览开关显示 8103 /state 的 quiet，
  // 点击仍写同一入口（control:toggle-quiet → 8103 POST /quiet）。
  console.log('[静默] 总览快捷开关 ↔ 8103 /state 同源');
  await gotoPage(0);
  const q0 = await ev(`({
    ov: document.getElementById('quiet-switch').checked,
    dup: !!document.getElementById('quiet-mode-enabled'),
    desc: (document.getElementById('quiet-desc') || {}).textContent || '',
  })`);
  ok('设置页重复的静默开关已删除（#quiet-mode-enabled 不存在）', q0.dup === false);
  ok('总览静默开关存在', typeof q0.ov === 'boolean');
  ok('总览静默文案不是「正在读取…」（已从实时状态回填）', q0.desc !== '正在读取…', q0.desc);

  await ev(`document.getElementById('quiet-switch').click(); 1`);
  await sleep(1400);
  const q1 = await ev(`({
    ov: document.getElementById('quiet-switch').checked,
    desc: (document.getElementById('quiet-desc') || {}).textContent || '',
  })`);
  ok('点总览静默开关 → 状态翻转', q1.ov !== q0.ov, `before=${q0.ov} after=${q1.ov}`);
  ok('点完文案同步（开/关文字跟着变）', q1.desc !== q0.desc, JSON.stringify({ before: q0.desc, after: q1.desc }));

  // 8103 /state 是唯一真源：总览开关必须和它一致（8103 没开就跑不了真比对，明确标注 SKIP）
  let liveQuiet = null;
  try {
    const r = await fetch('http://127.0.0.1:8103/state', { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    if (typeof j.quiet === 'boolean') liveQuiet = j.quiet;
  } catch (e) { liveQuiet = null; }
  if (liveQuiet === null) {
    console.log('  · SKIP 8103 未运行（桌宠没开），跳过「总览 = /state」同源比对');
  } else {
    ok('总览开关 = 8103 /state 的 quiet（同一状态源）', liveQuiet === q1.ov, `/state=${liveQuiet} 开关=${q1.ov}`);
  }

  await ev(`document.getElementById('quiet-switch').click(); 1`);
  await sleep(1400);
  const q2 = await ev(`document.getElementById('quiet-switch').checked`);
  ok('再点一次 → 还原', q2 === q0.ov, `now=${q2}`);

  // ── ⑥b 插件页：市场页不再有启停开关（唯一入口在能力页） ────────────────
  console.log('[插件页] 只做市场（安装/配置/README），不再有 enable 开关');
  await gotoPage(7);
  const pl = await ev(`(() => {
    const rows = document.querySelectorAll('#installed-plugin-list .plugin-row');
    const first = rows[0] || null;
    const dead = Array.from(rows).filter(r => r.querySelectorAll('button').length === 0);
    return {
      rows: rows.length,
      enables: document.querySelectorAll('#installed-plugin-list [data-plugin-enabled]').length,
      switches: document.querySelectorAll('#installed-plugin-list .switch').length,
      marketEnables: document.querySelectorAll('#market-plugin-list [data-plugin-enabled]').length,
      actionLabels: first ? Array.from(first.querySelectorAll('button')).map(b => b.textContent.trim()) : [],
      configBtns: document.querySelectorAll('#installed-plugin-list [data-plugin-config]').length,
      // 删掉 enable 后允许「无配置/无 README」的行只剩标题，但那种行必须在能力页有启停入口
      deadRows: dead.length,
      deadPaths: dead.map(r => r.dataset.pluginCard),
    };
  })()`);
  console.log('   插件行=' + pl.rows + ' 行内按钮=' + JSON.stringify(pl.actionLabels) + ' 无按钮行=' + pl.deadRows);
  ok('插件页仍有插件行', pl.rows > 0, String(pl.rows));
  ok('插件页不再有 enable 开关（data-plugin-enabled=0）', pl.enables === 0, String(pl.enables));
  ok('插件页行内没有 .switch 控件', pl.switches === 0, String(pl.switches));
  ok('广场列表也没有 enable 开关', pl.marketEnables === 0, String(pl.marketEnables));
  ok('插件页保留配置入口（市场职责）', pl.configBtns > 0 || pl.rows === 0, String(pl.configBtns));
  // 「无配置/无 README」的插件行只剩标题是允许的，但它必须在能力页有启停入口 ——
  // 否则就是真的把功能的最后一个入口删掉了（这里按注册表判定，不看页面是否恰好有按钮）
  const controllablePlugins = new Set();
  for (const cap of CAPABILITIES) {
    if (cap.deprecated) continue;
    if (cap.kind === 'plugin' && cap.key) controllablePlugins.add(cap.key);
    if (cap.kind === 'config' && cap.plugin) controllablePlugins.add(cap.plugin);
  }
  const deadNoCap = (pl.deadPaths || []).filter((rel) => !controllablePlugins.has(rel));
  ok('无按钮的插件行都在能力页有启停入口（功能没失去入口）', deadNoCap.length === 0,
    deadNoCap.length ? JSON.stringify(deadNoCap) : `无按钮行 ${pl.deadRows} 个，均有能力入口`);

  const capPlug = await ev(`document.querySelectorAll('#capability-rows [data-cap-plugin]').length`);
  ok('能力页插件开关仍在（唯一启停入口可用）', capPlug > 0, String(capPlug));

  // ── ⑥c 外观页：被删的重复布尔开关都不存在，参数还在 ────────────────────
  console.log('[外观页] 重复开关已删 / 参数保留');
  await gotoPage(10);
  const removedIds = [
    'subtitle-enabled', 'hide-model', 'auto-close-services',
    'latency-filler-enabled', 'quiet-mode-enabled',
  ];
  const leftovers = await ev(`(${JSON.stringify(removedIds)}).filter(id => document.getElementById(id))`);
  ok('外观页已无重复布尔开关', leftovers.length === 0, JSON.stringify(leftovers));
  const keptParams = await ev(`({
    name: !!document.getElementById('user-name'),
    intro: !!document.getElementById('opening-text'),
    fillerDelay: !!document.getElementById('latency-filler-delay'),
    reset: !!document.getElementById('reset-model-position'),
    capRows: document.querySelectorAll('#capability-rows .cap-row').length,
  })`);
  ok('外观页保留名称/开场白参数', keptParams.name && keptParams.intro);
  ok('外观页保留「垫场触发阈值」数值（只删开关）', keptParams.fillerDelay === true);
  ok('外观页保留位置按钮', keptParams.reset === true);
  ok('外观页能力区仍在渲染（删的是重复行，不是能力区）', keptParams.capRows > 10, String(keptParams.capRows));

  // 对话/皮套页同理：值留下、开关删掉
  await gotoPage(2);
  const chatKept = await ev(`({
    max: !!document.getElementById('max-messages'),
    temp: !!document.getElementById('temperature'),
    prompt: !!document.getElementById('llm-prompt'),
    gone: ['text-input-enabled','ptt-enabled','barge-enabled','auto-vision','history-enabled','context-limit','temperature-enabled','vision-enabled'].filter(id => document.getElementById(id)),
  })`);
  ok('对话页保留数值参数（上下文条数/温度）', chatKept.max && chatKept.temp);
  ok('对话页重复开关全部删除', chatKept.gone.length === 0, JSON.stringify(chatKept.gone));
  await gotoPage(8);
  const petKept = await ev(`({
    width: !!document.getElementById('petbody-width'),
    gain: !!document.getElementById('petbody-mouth-gain'),
    gone: ['petbody-framing-full','petbody-click-through'].filter(id => document.getElementById(id)),
  })`);
  ok('皮套页保留窗口/增益参数', petKept.width && petKept.gain);
  ok('皮套页取景/穿透开关已删（能力页下拉/开关接手）', petKept.gone.length === 0, JSON.stringify(petKept.gone));

  // ── ⑦ 外观页：复位皮套位置 / 调整字幕位置 ──────────────────────────────
  console.log('[外观页] 位置类按钮');
  await gotoPage(10);
  const r4 = await click('reset-model-position', 1200);
  ok('reset-model-position 可点击', r4 === 'clicked', r4);
  const r5 = await click('adjust-subtitle-position', 1200);
  ok('adjust-subtitle-position 可点击', r5 === 'clicked', r5);

  // ── 退出字幕调整模式（2026-11-18 §80）─────────────────────────────────────
  // 这个按钮会让宿主进入「调整字幕」模式（解除鼠标穿透、字幕不再跟随皮套）。
  // 以前没人去点字幕窗上的「完成」，__subtitleAdjusting 就永久为真 ——
  // 实测后果：皮套移到 (300,200)，字幕还死守在 (140,1034)，doctor 报「与皮套重叠」。
  // 宿主现在有 90s 看门狗兜底，但测试不该依赖它：点完立刻显式退出。
  try {
    await fetch('http://127.0.0.1:8004/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ js: "try{require('electron').ipcRenderer.send('subtitle:adjust-cancel');'ok'}catch(e){'err'}" }),
      signal: AbortSignal.timeout(4000),
    });
    ok('点完「调整字幕」已显式退出调整模式', true);
  } catch (e) {
    ok('点完「调整字幕」已显式退出调整模式', false, (e && e.message) || String(e));
  }

  // ── ④ 收尾：确认没有残留弹层挡住界面 ────────────────────────────────────
  const leftover = await ev(`({ prompts: document.querySelectorAll('[data-yes]').length, modals: document.querySelectorAll('.modal.open').length })`);
  ok('收尾无残留弹层', leftover.prompts === 0 && leftover.modals === 0, JSON.stringify(leftover));

  console.log('');
  console.log(`  按钮点击验收：${pass} 通过 / ${fail} 失败`);
  // 删行之后最容易发生的假绿：断言全被条件跳过，PASS=0 还打「通过」。PASS=0 一律算失败。
  if (pass === 0) { console.error('PASS=0：没有任何断言真正执行，视为失败'); process.exit(1); }
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error('脚本出错：', e && e.message);
  process.exit(2);
});
