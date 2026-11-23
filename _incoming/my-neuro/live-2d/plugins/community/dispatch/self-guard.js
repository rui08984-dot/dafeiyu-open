/**
 * self-guard.js —— 「别点到自己 / 别点坏东西」的动作前置守卫（2026-11-18 §71）
 *
 * 为什么要有（§69.5 复核成立 + §70.5 实测）：
 *   1. **她没有「排除自己」的能力**。全仓没有 getOwnPid/excludeSelf/isOwnWindow 之类逻辑；
 *      `click_at` 用真实鼠标点屏幕坐标。长任务里把字幕窗/皮套窗当成目标，就会点到自己身上。
 *   2. **直控会点模态对话框里的破坏性按钮**。实测日志（14:29/14:35）两次点了记事本
 *      「是否保存更改」里的**「不保存」**——那次是她自己 eval 的临时窗口所以无害，
 *      但换成用户的编辑器就是真丢数据。
 *
 * 本模块只做判断，不做 IO：窗口清单与坐标由调用方注入，因此可以纯函数单测。
 *
 * 两条策略（刻意保守，判据都是「错的路走不通，但给对的路」）：
 *   · 落点在自己的窗口矩形内 → **拒绝**，并提示改用 click_element / som_click（UIA 路径，
 *     不依赖屏幕坐标）。透明窗（皮套）也一律拒绝：她本来就不该点自己，换个落点即可。
 *   · 按钮名属于「放弃未保存更改」一族（不保存/放弃/丢弃/Discard/Don't Save）→ **默认拒绝**；
 *     只有调用方显式带 `confirm_destructive:true` 才放行（拒绝文案会教模型怎么带）。
 *     「删除/格式化/清空/卸载/覆盖」只**标注风险**不拦——它们是正常任务的一部分。
 */

'use strict';

/** 「放弃未保存更改」——这一类点下去就是数据丢失，且几乎从不是正经任务的一步 */
const DISCARD_RE = /(不保存|不儲存|不保存更改|放弃更改|放棄更改|放弃修改|丢弃更改|丟棄更改|放弃编辑|don'?t\s*save|discard\s+changes|discard)/i;
/** 有破坏性但可能是正常任务：只标注，不拦 */
const DESTRUCTIVE_RE = /(删除|刪除|delete|remove|格式化|format|清空|clear\s*all|卸载|uninstall|覆盖|overwrite|重置|reset)/i;
/** 确认/保存一族：正常操作，不标注 */
const CONFIRM_RE = /^(确定|確定|好|是|yes|ok|保存|save|覆盖|overwrite)$/i;

/**
 * @param {{x:number,y:number,w:number,h:number}} rect 物理屏幕像素
 * @returns {boolean}
 */
function rectContains(rect, x, y) {
  if (!rect) return false;
  const rx = Number(rect.x);
  const ry = Number(rect.y);
  const rw = Number(rect.w);
  const rh = Number(rect.h);
  if (![rx, ry, rw, rh].every(Number.isFinite)) return false;
  if (rw <= 0 || rh <= 0) return false;
  return x >= rx && x < rx + rw && y >= ry && y < ry + rh;
}

/**
 * 落点是否在自己窗口里。
 * @param {Array<{title?:string,rect:{x:number,y:number,w:number,h:number},transparent?:boolean}>} ownWindows
 * @param {number} x @param {number} y
 * @returns {{blocked:boolean, window?:object, reason?:string, hint?:string}}
 */
function checkPoint(ownWindows, x, y) {
  const px = Number(x);
  const py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    return { blocked: true, reason: '落点坐标不是数字（' + String(x) + ',' + String(y) + '）', hint: 'click_at 的 arg 要是 "x,y" 屏幕物理像素' };
  }
  const list = Array.isArray(ownWindows) ? ownWindows : [];
  const hit = list.find((w) => w && rectContains(w.rect, px, py));
  if (!hit) return { blocked: false };
  const label = String(hit.title || hit.id || '自己的窗口');
  return {
    blocked: true,
    window: hit,
    reason: `落点 (${Math.round(px)},${Math.round(py)}) 在她自己的窗口「${label}」里`
      + (hit.transparent ? '（透明窗，点下去会被自己吃掉）' : ''),
    hint: '换一个落点；要操作窗口里的控件请用 click_element / som_click / click_text（UIA 路径，不依赖屏幕坐标）',
  };
}

/**
 * 按钮名的风险等级。
 * @param {string} name
 * @returns {{level:'discard'|'destructive'|null, name:string}}
 */
function classifyButton(name) {
  const text = String(name == null ? '' : name).trim();
  if (!text) return { level: null, name: text };
  // 「保存」不算 discard：「不保存」里也含「保存」，所以先判 discard
  if (DISCARD_RE.test(text)) return { level: 'discard', name: text };
  if (CONFIRM_RE.test(text)) return { level: null, name: text };
  if (DESTRUCTIVE_RE.test(text)) return { level: 'destructive', name: text };
  return { level: null, name: text };
}

/**
 * 点击按钮/元素的前置策略。
 * @param {string} name 元素的可读名（click_element 的 name / click_text 的文本）
 * @param {{confirmDestructive?:boolean}} [opts]
 * @returns {{blocked:boolean, level:'discard'|'destructive'|null, reason?:string, hint?:string, warning?:string}}
 */
function checkButton(name, opts) {
  const { level, name: text } = classifyButton(name);
  const confirmed = !!(opts && opts.confirmDestructive);
  if (level === 'discard') {
    if (confirmed) return { blocked: false, level };
    return {
      blocked: true,
      level,
      reason: `“${text}”会丢弃未保存的更改（点下去 = 用户的数据没了）`,
      hint: '如果你确定要放弃的是她自己这轮改的东西，带 confirm_destructive:true 重试；否则改用「保存」或先问用户',
    };
  }
  if (level === 'destructive') {
    return { blocked: false, level, warning: `“${text}”是破坏性操作（已放行，但会记进结果）` };
  }
  return { blocked: false, level: null };
}

module.exports = { rectContains, checkPoint, classifyButton, checkButton, DISCARD_RE, DESTRUCTIVE_RE, CONFIRM_RE };
