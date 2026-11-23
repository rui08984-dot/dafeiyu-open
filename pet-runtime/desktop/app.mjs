/**
 * app.mjs — 渲染进程（官方 Cubism 5 内核，遮罩图集已按骨架规模自适应）
 * 数据来自 VTS 兼容协议层（ws://127.0.0.1:8102）。
 * 舞台层（字幕 / 拖动 / 悬停圆钮 / 控制面板）在 ui/stage.mjs，
 * 这里只负责启动渲染、驱动每帧视图、把协议消息分发给舞台。
 */

import { JellyfishRenderer } from './cubism-renderer.mjs';
import presetCatalog from './assets/jellyfish/presets.json';
import { createStage } from './ui/stage.mjs';
import { GazeFollow } from './ui/gaze.mjs';

const q = new URLSearchParams(location.search);
// 正式运行固定 8002；带 ?inner=端口 仅供无头验证/多实例调试。
const INNER_PORT = Number(q.get('inner') || 8102);
const statusEl = document.getElementById('status');
const canvas = document.getElementById('model');

const automaticIds = presetCatalog.items.filter((item) => item.availability === 'automatic').map((item) => item.id);
const expressionByName = new Map(presetCatalog.items.filter((item) => item.expressionName).map((item) => [item.expressionName, item]));

const state = { mouth: 0, lastMouthAt: 0, speaking: false, emotion: 'neutral', gesture: null };
let renderer = null;
let stage = null;
let gaze = null;
let currentView = null;
let innerSocket = null;
const stats = { fps: 0, idle: false, draws: 0 };

function dimStatus() {
  clearTimeout(dimStatus._t);
  dimStatus._t = setTimeout(() => statusEl.classList.add('dim'), 2600);
}
function setStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.remove('error');
  statusEl.classList.remove('dim');
  dimStatus();
}
function failStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.add('error');
  statusEl.classList.remove('dim');
}
function beginSpeak() { state.speaking = true; }
function endSpeak() { state.speaking = false; }

/**
 * 点击命中判断：只读一个像素的 alpha。
 * 指针事件发生在两帧之间，默认帧缓冲可能已被合成清空，所以先按当前视图再画一帧。
 * 透明背景返回 0，ui/pointer.mjs 据此把拖动/点击限制在角色本体上。
 */
function sampleAlpha(xCss, yCss) {
  if (!renderer || !renderer.ready) return 255; // 渲染未就绪时不要锁死拖动
  try {
    if (currentView) renderer.updateView(currentView, state.speaking ? 'speaking' : 'idle', false);
    const gl = renderer.gl;
    const target = renderer.canvas;
    const width = target.width, height = target.height;
    const px = Math.max(0, Math.min(width - 1, Math.round((xCss / (target.clientWidth || 1)) * width)));
    const py = Math.max(0, Math.min(height - 1, Math.round((1 - yCss / (target.clientHeight || 1)) * height)));
    const buffer = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
    return buffer[3];
  } catch (error) {
    console.warn('[pet] alpha 采样失败', error);
    return 255;
  }
}

async function boot() {
  const framing = q.get('framing') === 'full' ? 'full' : 'half';
  const hiddenParts = (q.get('hide') ?? '').split(',').filter(Boolean);
  renderer = new JellyfishRenderer(canvas, (event) => {
    if (!event || event.type !== 'error') return;
    console.error('[cubism]', event.message);
    failStatus('error: ' + event.message);
  }, {
    assetBase: 'assets/jellyfish/',
    hiddenParts,
    mouthGain: Number(q.get('mouthGain') || 1.25),
    halfZoom: Number(q.get('zoom') || 0) || undefined,
    halfShiftY: q.get('shift') === null ? undefined : Number(q.get('shift')),
  });
  await renderer.load();
  gaze = new GazeFollow(renderer);
  {
    const drawFrame = renderer.draw.bind(renderer);
    let gazeWarned = false;
    renderer.draw = (...args) => {
      try { gaze.apply(); } catch (error) {
        if (!gazeWarned) { gazeWarned = true; console.warn('[pet] 眼神跟随应用失败', error); }
      }
      return drawFrame(...args);
    };
  }
  renderer.setFraming(framing);
  renderer.setAutomaticPolicy({ modelId: presetCatalog.modelId, revision: 1, enabledIds: automaticIds });

  stage = createStage({
    renderer,
    gaze,
    sampleAlpha,
    bridge: window.petBridge,
    runtimeInfo: () => ({ fps: stats.fps, idle: stats.idle }),
    // 资产变化后把真实状态回传给协议层（HTTP GET /state 才能看到 cycle 档位）。
    onAssetApplied: ({ id, states }) => {
      try {
        if (innerSocket && innerSocket.readyState === 1) innerSocket.send(JSON.stringify({ type: 'asset-applied', id, states }));
      } catch (error) {
        console.warn('[pet] asset-applied 回传失败', error);
      }
    },
  });
  stage.setReady();
  window.__pet = { renderer, state, stage, stats, gaze };
  window.__stage = stage;

  setStatus('就绪');
  dimStatus();

  let last = performance.now();
  let frames = 0;
  let fpsWindow = performance.now();
  let failed = false;
  const tick = () => {
    requestAnimationFrame(tick);
    const now = performance.now();
    // 帧率分档（2026-11-08 用户反馈「皮套帧数很低」）：
    //   原实现死板两档：静止 10fps / 其它 30fps。10fps 下呼吸、眼神这类细微动作
    //   会明显一顿一顿；拖动时即使算"活跃"也只有 30fps，观感不够顺。
    //   第一性原理：帧率应跟「这一帧真的会变吗」走，而不是跟"忙碌程度"走。
    //     · 说话/有动作/嘴里有词 → 60fps（口腔与动作帧真的会被看到）
    //     · 其余（静止也在呼吸 + 眼神跟随） → 60fps（眼神跟手是唯一高频细节，
    //       掉到 10fps 会明显"瞪着眼不走"；实测 rAF 能跑 97fps，60 毫无压力）
    //   只有窗口不可见 / 拖出屏幕时才降到 15fps 省电（由 stage.isIdle 之外的
    //   document.hidden 判定，见下）。
    const active = state.speaking || state.mouth > 0 || (stage ? !stage.isIdle(now) : false);
    const hidden = (typeof document !== 'undefined') && document.hidden;
    // 可见时恒 60fps（实测 rAF 能跑 97fps，60 毫无压力）；窗口隐藏才降到 15fps 省电。
    // 不再按"忙/闲"分档：静止时她也在呼吸+眼神跟随，10fps 会明显顿。
    const interval = hidden ? 66 : 16;
    if (now - last < interval - 1) return;
    last = now;
    stats.idle = !active;
    if (state.mouth > 0 && now - state.lastMouthAt > 320) {
      state.mouth *= 0.5;
      if (state.mouth < 0.02) { state.mouth = 0; endSpeak(); }
    }
    currentView = {
      state: state.speaking ? 'speaking' : 'idle',
      expression: {
        emotion: state.emotion,
        intensity: state.emotion === 'neutral' ? 0 : 1,
        delivery: '',
        gesture: state.gesture,
      },
      mouth: state.mouth,
    };
    try {
      renderer.updateView(currentView, state.speaking ? 'speaking' : 'idle', false);
    } catch (error) {
      if (!failed) { failed = true; console.error('[render]', error); failStatus('render error: ' + String(error && error.message || error)); }
    }
    frames += 1;
    stats.draws += 1;
    if (now - fpsWindow >= 1000) {
      stats.fps = Math.round(frames * 1000 / Math.max(1, now - fpsWindow));
      frames = 0;
      fpsWindow = now;
    }
  };
  requestAnimationFrame(tick);
  connect();
}

function connect() {
  const ws = new WebSocket('ws://127.0.0.1:' + INNER_PORT);
  innerSocket = ws;
  ws.onopen = () => { setStatus('VTS 兼容层已连接'); dimStatus(); };
  ws.onclose = () => {
    if (innerSocket === ws) innerSocket = null;
    failStatus('桥接断开，重连中…');
    setTimeout(connect, 1200);
  };
  ws.onerror = () => {};
  ws.onmessage = (event) => {
    let msg; try { msg = JSON.parse(String(event.data)); } catch { return; }
    const now = performance.now();
    switch (msg.type) {
      case 'params': {
        if (!msg.values) return;
        const value = msg.values.ParamMouthOpenY;
        if (typeof value === 'number') {
          state.mouth = Math.max(0, Math.min(1, value));
          state.lastMouthAt = now;
          if (state.mouth > 0.02) { beginSpeak(); stage?.markActivity(); }
        }
        return;
      }
      case 'expression': {
        stage?.markActivity();
        const name = String(msg.name || '');
        const active = !!msg.active;
        const pinned = renderer ? renderer.setNamedExpression(name, active) : false;
        if (pinned) {
          if (active) stage?.toast('表情 · ' + name);
        } else {
          const item = expressionByName.get(name);
          if (item?.emotions?.length) state.emotion = active ? item.emotions[0] : 'neutral';
          if (active) stage?.toast('表情 · ' + name);
        }
        stage?.syncExpression(name, active);
        return;
      }
      case 'motion': {
        stage?.markActivity();
        if (renderer) renderer.playMotion(String(msg.group || 'Idle'), Number(msg.index || 0));
        return;
      }
      case 'action': {
        stage?.markActivity();
        stage?.handleAction(String(msg.name || ''));
        return;
      }
      case 'asset': {
        stage?.handleAssetMessage(msg);
        return;
      }
      case 'hotkey': {
        stage?.handleHotkey(String(msg.name || ''));
        return;
      }
      case 'say': {
        // 只对英文方括号动作标签（[wave right hand]）做保守剥离，中文/普通方括号原样保留。
        stage?.markActivity();
        const text = String(msg.text || '').replace(/\[([A-Za-z][A-Za-z '\-]{0,48})\]/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
        if (text) stage?.caption.show(text);
        return;
      }
      case 'pointer': {
        // 主进程 30Hz：x/y 归一化到窗口中心；鼠标离开窗口时 x/y 为 null。
        const valid = gaze ? gaze.setPointer(msg.x, msg.y) : false;
        if (valid) stage?.markActivity();
        return;
      }
      case 'fullscreen': {
        stage?.setFullscreenDim(!!msg.on);
        return;
      }
      case 'work-state': {
        const workState = String(msg.state || '');
        if (!workState) return;
        try { renderer?.setWorkState?.(workState); } catch (error) { console.warn('[pet] setWorkState 失败', error); }
        stage?.markActivity();
        return;
      }
      case 'hello': {
        // 后端就绪握手；舞台不需要额外处理。
        return;
      }
      default:
        return;
    }
  };
}

boot().catch((error) => {
  failStatus('启动失败：' + String(error && error.message || error));
  console.error(error);
});
