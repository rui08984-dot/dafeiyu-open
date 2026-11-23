#!/usr/bin/env node
/**
 * _probe/tool-contract-accept.cjs — 工具回执契约真机验收（A3，2026-11-21）
 *
 * 纯逻辑单测（test-tool-result）只证明判据本身对；这里证明**真实工具面**遵守契约：
 *   ① 成功/失败的判定与工具返回一致（含故意失败的一条）
 *   ② 审计计数 backfilled=0 —— 没有「失败却不给原因」的工具
 *   ③ violations=0 —— 没有形状违规（undefined/function 之类）
 *   ④ 失败的那条 detail 非空（模型能看到为什么失败）
 *
 * 需要宿主（8004）。会真实调用 see/file/app 的只读或必然失败的动作，不改系统状态。
 */
'use strict';

const BASE = process.env.PET_DEVTOOLS || 'http://127.0.0.1:8004';
const ROOT = '<project-root>/_incoming/my-neuro/live-2d';

const JS = `(async () => {
  const path = ${JSON.stringify(ROOT)};
  const TR = require(path + '/js/core/tool-result.js');
  const pm = window.pluginManager;
  if (!pm) return { ok: false, error: '没有 pluginManager' };
  const cases = [
    ['see', { mode: 'windows' }],
    ['file', { action: 'list', path: '<project-root>/_probe' }],
    ['app', { action: 'focus', name: '不存在的窗口名-契约验收-zzz' }]
  ];
  const out = [];
  for (const c of cases) {
    const name = c[0], params = c[1];
    let v = null, thrown = '';
    try { v = await pm.executeTool(name, params); } catch (e) { thrown = String((e && e.message) || e); }
    const failure = TR.isFailure(v);
    out.push({ name, thrown, failure, detail: TR.detailOf(v), rawKind: v === null ? 'null' : typeof v });
  }
  return { ok: true, cases: out, snap: TR.snapshot() };
})()`;

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

(async () => {
  const res = await fetch(BASE + '/eval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ js: JS }),
  });
  const j = await res.json();
  if (!j.ok || !j.value || !j.value.ok) {
    ok('宿主可执行验收脚本', false, JSON.stringify(j).slice(0, 300));
    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exitCode = 1;
    return;
  }
  const { cases, snap } = j.value;
  ok('see 成功且判为成功', !!cases.find((c) => c.name === 'see' && !c.failure));
  ok('file 成功且判为成功', !!cases.find((c) => c.name === 'file' && !c.failure));
  const appCase = cases.find((c) => c.name === 'app');
  ok('app 找不到窗口时判为失败（不是假成功）', !!appCase && appCase.failure === true, appCase && appCase.rawKind);
  ok('失败那条 detail 非空', !!appCase && String(appCase.detail || '').length > 0, appCase && String(appCase.detail).slice(0, 60));
  ok('violations=0（没有形状违规）', snap.violations === 0, 'violations=' + snap.violations);
  ok('backfilled=0（没有失败却不给原因的工具）', snap.backfilled === 0, 'backfilled=' + snap.backfilled);
  ok('checked>0（审计真的跑了）', snap.checked > 0, 'checked=' + snap.checked);
  console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
  process.exitCode = fail === 0 ? 0 : 1;
})();
