import { JellyfishRenderer } from './cubism-renderer.mjs';

const realFetch = window.fetch.bind(window);
function post(o) { try { realFetch('/__log', { method: 'POST', body: JSON.stringify(o) }); } catch (e) {} }
const NEUTRAL = { state: 'idle', expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null }, mouth: 0 };
const BG = [16, 24, 38];
const safe = (fn) => { try { return fn(); } catch (e) { return 'ERR:' + String((e && e.message) || e); } };

window.__probe = async function () {
  const q = new URLSearchParams(location.search);
  const W = Number(q.get('w') || 420), H = Number(q.get('h') || 720);
  const mode = q.get('mode') || 'shot';
  const canvas = document.getElementById('model');
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  canvas.width = W; canvas.height = H;
  canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true });
  const sdkLogs = [];
  const r = new JellyfishRenderer(canvas, (e) => { if (!e) return; if (e.type === 'error') post({ stage: 'renderer-error', msg: e.message }); else if (e.type === 'sdk') { if (sdkLogs.length < 40 && !sdkLogs.includes(e.message)) sdkLogs.push(e.message); } },
    { assetBase: 'assets/jellyfish/', premultiplied: q.get('pm') !== '0', maskBufferCount: Number(q.get('mbc') || 1), maskBufferSize: Number(q.get('ms') || 0) || undefined });
  await r.load();
  r.setFraming(q.get('framing') || 'half');
  if (q.get('feather') === '0') r.feather = { apply: () => true, releaseTexture() {} };
  const renderer = r.getRenderer(), model = r._model, raw = model.getModel();
  if (q.get('hp') === '1') renderer.useHighPrecisionMask(true);
  r.setAutomaticPolicy({ modelId: 'jellyfish', revision: 1, enabledIds: [] });
  const draw = () => r.updateView(NEUTRAL, 'idle', false);
  for (let i = 0; i < 3; i++) draw();
  const gl = r.gl;
  const BW = gl.drawingBufferWidth, BH = gl.drawingBufferHeight;
  const sig = new Set();
  { const masks = model.getDrawableMasks(), counts = model.getDrawableMaskCounts();
    for (let i = 0; i < model.getDrawableCount(); i++) { const n = counts[i]; if (!n) continue; sig.add(Array.from(masks[i]).slice(0, n).join(',')); } }
  post({ stage: 'maskmap', groups: sig.size, bufferCount: safe(() => renderer.getRenderTextureCount()) });
  if (sdkLogs.length) post({ stage: 'sdk-logs', logs: sdkLogs });
  post({ stage: 'info', info: {
    drawables: model.getDrawableCount(), offscreens: model.getOffscreenCount(), params: model.getParameterCount(),
    masking: safe(() => model.isUsingMasking()), blend: safe(() => model.isBlendModeEnabled()),
    hp: safe(() => renderer.isUsingHighPrecisionMask()), maskBuf: safe(() => renderer.getClippingMaskBufferSize()),
    buffer: [BW, BH], framing: r.framing,
  } });

  const rx0 = Number(q.get('rx0') || 0.30), ry0 = Number(q.get('ry0') || 0.10), rx1 = Number(q.get('rx1') || 0.70), ry1 = Number(q.get('ry1') || 0.34);
  const x0 = Math.max(0, Math.round(rx0 * BW)), x1 = Math.min(BW, Math.round(rx1 * BW));
  const y0 = Math.max(0, Math.round(ry0 * BH)), y1 = Math.min(BH, Math.round(ry1 * BH));
  const rw = Math.max(1, x1 - x0), rh = Math.max(1, y1 - y0);
  const buf = new Uint8Array(rw * rh * 4);
  const readRoi = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(x0, BH - y1, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, buf); return buf; };
  const isWhite = (R, G, B, a) => a > 0.8 && R > 243 && G > 240 && B > 232 && Math.max(R, G, B) - Math.min(R, G, B) < 14;
  const isBrown = (R, G, B, a) => a > 0.8 && R > 90 && R < 215 && R - B > 28 && R - G > 14 && G - B > 4;
  function metrics() {
    readRoi();
    let white = 0, brown = 0, opaque = 0, sx = 0, sy = 0, lumSum = 0, satSum = 0;
    for (let row = 0; row < rh; row++) for (let col = 0; col < rw; col++) {
      const o = (row * rw + col) * 4, a = buf[o + 3] / 255;
      const R = buf[o] + BG[0] * (1 - a), G = buf[o + 1] + BG[1] * (1 - a), B = buf[o + 2] + BG[2] * (1 - a);
      if (a > 0.8) opaque++;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      lumSum += mx; satSum += mx - mn;
      if (isWhite(R, G, B, a)) { white++; sx += col; sy += row; }
      else if (isBrown(R, G, B, a)) brown++;
    }
    const ax = white ? +(x0 + sx / white).toFixed(1) : null;
    const ay = white ? +(y0 + (rh - sy / white)).toFixed(1) : null;
    return { white, brown, opaque, lum: +(lumSum / (rw * rh)).toFixed(2), sat: +(satSum / (rw * rh)).toFixed(2), ax, ay, cx: white ? +(sx / white / rw).toFixed(3) : null, cy: white ? +(sy / white / rh).toFixed(3) : null };
  }
  function ascii() {
    readRoi();
    const CW = 46, CH = 20; let out = '';
    for (let gy = 0; gy < CH; gy++) {
      let line = '';
      for (let gx = 0; gx < CW; gx++) {
        const c0 = Math.floor(gx * rw / CW), c1 = Math.max(c0 + 1, Math.floor((gx + 1) * rw / CW));
        const r0 = Math.floor((CH - 1 - gy) * rh / CH), r1 = Math.max(r0 + 1, Math.floor((CH - gy) * rh / CH));
        let ws = 0, bs = 0, n = 0, al = 0;
        for (let row = r0; row < r1; row++) for (let col = c0; col < c1; col++) {
          const o = (row * rw + col) * 4, a = buf[o + 3] / 255;
          const R = buf[o] + BG[0] * (1 - a), G = buf[o + 1] + BG[1] * (1 - a), B = buf[o + 2] + BG[2] * (1 - a);
          n++; al += a; if (isWhite(R, G, B, a)) ws++; else if (isBrown(R, G, B, a)) bs++;
        }
        const aw = ws / n, ab = bs / n, aa = al / n;
        line += aw > 0.5 ? '#' : aw > 0.18 ? '+' : ab > 0.45 ? 'B' : aa > 0.5 ? '.' : ' ';
      }
      out += line + '\n';
    }
    return out;
  }

  if (mode === 'shot') {
    post({ stage: 'metrics', m: metrics(), roi: [rx0, ry0, rx1, ry1], buffer: [BW, BH] });
    post({ stage: 'ascii', map: ascii() });
    try { post({ stage: 'png', data: canvas.toDataURL('image/png') }); } catch (e) { post({ stage: 'png-fail', msg: String(e) }); }
    post({ stage: 'probe-done', mode }); return;
  }

  if (mode === 'iso') {
    const dw = raw.drawables, base = Float32Array.from(raw.parameters.values), baseM = metrics();
    const origOp = Float32Array.from(dw.opacities);
    const hits = [];
    for (let i = 0; i < dw.count; i++) {
      raw.parameters.values.set(base); model.update();
      for (let j = 0; j < dw.count; j++) dw.opacities[j] = j === i ? origOp[j] : 0;
      r.draw();
      const m = metrics();
      if (m.white > 2 || m.brown > 2) hits.push({ i, white: m.white, brown: m.brown, tex: dw.textureIndices[i], part: dw.parentPartIndices[i] });
    }
    post({ stage: 'iso', base: baseM, hits }); post({ stage: 'probe-done', mode }); return;
  }

  if (mode === 'dsweep') {
    const dw = raw.drawables, base = Float32Array.from(raw.parameters.values), baseM = metrics();
    const hits = [];
    for (let i = 0; i < dw.count; i++) {
      const prev = dw.opacities[i];
      raw.parameters.values.set(base); model.update(); dw.opacities[i] = 0; r.draw();
      const m = metrics();
      const dw2 = m.white - baseM.white, db = m.brown - baseM.brown;
      const dl = +(m.lum - baseM.lum).toFixed(2), ds = +(m.sat - baseM.sat).toFixed(2);
      if (Math.abs(dw2) > 2 || Math.abs(db) > 2 || Math.abs(dl) > 1.2 || Math.abs(ds) > 1.2) hits.push({ i, white: m.white, brown: m.brown, dw: dw2, db, lum: m.lum, dl, sat: m.sat, ds, tex: dw.textureIndices[i], part: dw.parentPartIndices[i] });
      dw.opacities[i] = prev;
    }
    hits.sort((a, b) => Math.abs(b.dl) - Math.abs(a.dl));
    post({ stage: 'dsweep', base: baseM, hits: hits.slice(0, 40) }); post({ stage: 'probe-done', mode }); return;
  }

  if (mode === 'psweep') {
    const base = Float32Array.from(raw.parameters.values), baseM = metrics();
    const ids = raw.parameters.ids;
    const res = [];
    for (let i = 0; i < model.getParameterCount(); i++) {
      const lo = model.getParameterMinimumValue(i), hi = model.getParameterMaximumValue(i);
      if (!(hi > lo)) continue;
      for (const v of [lo, hi]) {
        if (Math.abs(v - base[i]) < 1e-6) continue;
        raw.parameters.values.set(base); raw.parameters.values[i] = v; model.update(); r.draw();
        const m = metrics();
        if (m.white !== baseM.white || m.brown !== baseM.brown) res.push({ i, id: ids[i], v, white: m.white, brown: m.brown, dw: m.white - baseM.white });
      }
    }
    res.sort((a, b) => a.white - b.white);
    post({ stage: 'psweep', base: baseM, best: res.slice(0, 30), worst: res.slice(-6), changed: res.length });
    post({ stage: 'probe-done', mode }); return;
  }


  if (mode === 'blends') {
    const dw = raw.drawables;
    const list = [];
    for (let i = 0; i < model.getDrawableCount(); i++) {
      const cb = safe(() => model.getDrawableColorBlend(i));
      const ab = safe(() => model.getDrawableAlphaBlend(i));
      const mc = safe(() => model.getDrawableMultiplyColor(i));
      const sc = safe(() => model.getDrawableScreenColor(i));
      const mcV = mc && mc.isExist === undefined ? mc : mc;
      const arr = (c) => c ? [c.r !== undefined ? +c.r.toFixed(2) : (c.R !== undefined ? +c.R.toFixed(2) : null), c.g !== undefined ? +c.g.toFixed(2) : (c.G !== undefined ? +c.G.toFixed(2) : null), c.b !== undefined ? +c.b.toFixed(2) : (c.B !== undefined ? +c.B.toFixed(2) : null), c.a !== undefined ? +c.a.toFixed(2) : (c.A !== undefined ? +c.A.toFixed(2) : null)] : null;
      const m = arr(mc), s = arr(sc);
      const nonDefaultMul = m && (m[0] !== 1 || m[1] !== 1 || m[2] !== 1 || m[3] !== 1);
      const nonDefaultScr = s && (s[0] !== 0 || s[1] !== 0 || s[2] !== 0 || s[3] !== 0);
      if ((cb && cb !== 0) || (ab && ab !== 0) || nonDefaultMul || nonDefaultScr) list.push({ i, cb, ab, mul: m, scr: s, part: model.getDrawableParentPartIndex(i), tex: model.getDrawableTextureIndex(i) });
    }
    post({ stage: 'blends', count: list.length, items: list.slice(0, 120) });
    post({ stage: 'probe-done', mode }); return;
  }

  if (mode === 'motion') {
    r.setAutomaticPolicy({ modelId: 'jellyfish', revision: 2, enabledIds: ['proc-head', 'proc-body', 'proc-blink'] });
    const step = () => { r.last = performance.now() - 33; r.updateView(NEUTRAL, 'idle', false); };
    for (let i = 0; i < 12; i++) step();
    const grab = () => { const px = new Uint8Array(BW * BH * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, BW, BH, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
    const a = grab();
    for (let i = 0; i < 60; i++) step();
    const b = grab();
    const keys = ['ParamBreath', 'ParamBodyAngleX', 'ParamBodyAngleZ', 'HipAngleZ', 'LeanInput', 'PositionY', 'AngleX', 'ParamAngleX'];
    const snap = {};
    for (const k of keys) snap[k] = +r.get(k).toFixed(3);
    const region = (name, y0, y1) => {
      let changed = 0, total = 0;
      for (let y = Math.round(y0 * BH); y < Math.round(y1 * BH); y += 2) for (let x = 0; x < BW; x += 2) {
        const o = (y * BW + x) * 4;
        const d = Math.abs(a[o]-b[o]) + Math.abs(a[o+1]-b[o+1]) + Math.abs(a[o+2]-b[o+2]);
        total++; if (d > 20) changed++;
      }
      return { name, changed, total, pct: +(100 * changed / Math.max(1, total)).toFixed(1) };
    };
    post({ stage: 'motion', snap, regions: [region('head', 0.0, 0.3), region('chest', 0.3, 0.5), region('waist', 0.5, 0.7), region('hair', 0.0, 0.7)] });
    post({ stage: 'probe-done', mode }); return;
  }

  if (mode === 'ranges') {
    const ids = raw.parameters.ids;
    const rows = [];
    for (let i = 0; i < model.getParameterCount(); i++) {
      rows.push({ i, id: ids[i], min: model.getParameterMinimumValue(i), max: model.getParameterMaximumValue(i), def: model.getParameterDefaultValue(i) });
    }
    post({ stage: 'ranges', count: rows.length, rows });
    post({ stage: 'probe-done', mode }); return;
  }

  if (mode === 'hpd') {
    const count = safe(() => renderer.getRenderTextureCount());
    const n = typeof count === 'number' ? count : 0;
    const bufs = [];
    for (let i = 0; i < n; i++) {
      const b = renderer.getDrawableMaskBuffer(i);
      bufs.push({ i, bw: b && b.getBufferWidth ? b.getBufferWidth() : null, bh: b && b.getBufferHeight ? b.getBufferHeight() : null, created: !!(b && b._renderTexture), oldFbo: b && b._oldFbo !== undefined ? String(b._oldFbo) : 'n/a' });
    }
    post({ stage: 'mask-buffers', count, bufs });
    const origClear = gl.clear.bind(gl);
    let leaks = 0, lastColor = null, maskClears = 0, fboClears = 0;
    gl.clear = (mask) => { const fbo = gl.getParameter(gl.FRAMEBUFFER_BINDING); const cc = gl.getParameter(gl.COLOR_CLEAR_VALUE); if (fbo === null) { leaks++; lastColor = [ +cc[0].toFixed(3), +cc[1].toFixed(3), +cc[2].toFixed(3), +cc[3].toFixed(3) ]; } else { fboClears++; } return origClear(mask); };
    for (let i = 0; i < 2; i++) draw();
    gl.clear = origClear;
    const corner = new Uint8Array(4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, corner);
    const center = new Uint8Array(4); gl.readPixels(Math.round(BW / 2), Math.round(BH * 0.1), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, center);
    post({ stage: 'hpd', hp: safe(() => renderer.isUsingHighPrecisionMask()), leaks, fboClears, lastColor, corner: Array.from(corner), center: Array.from(center), buffer: [BW, BH] });
    post({ stage: 'probe-done', mode }); return;
  }

  if (mode === 'cov' || mode === 'props') {
    const dw = raw.drawables, base = Float32Array.from(raw.parameters.values);
    raw.parameters.values.set(base); model.update(); r.draw();
    const m = metrics();
    const mvp = renderer.getMvpMatrix();
    const toPx = (vx, vy) => [ (mvp.transformX(vx) * 0.5 + 0.5) * BW, (1 - (mvp.transformY(vy) * 0.5 + 0.5)) * BH ];
    const cover = (px, py) => {
      const out = [];
      for (let i = 0; i < dw.count; i++) {
        const verts = model.getDrawableVertexPositions(i), ind = model.getDrawableVertexIndices(i);
        if (!verts || !ind || verts.length < 6 || ind.length < 3) continue;
        const pts = new Float32Array(verts.length);
        for (let v = 0; v < verts.length; v += 2) { const p = toPx(verts[v], verts[v + 1]); pts[v] = p[0]; pts[v + 1] = p[1]; }
        let hit = false;
        for (let k = 0; k + 2 < ind.length && !hit; k += 3) {
          const a = ind[k] * 2, b = ind[k + 1] * 2, c = ind[k + 2] * 2;
          const x1 = pts[a], y1 = pts[a + 1], x2 = pts[b], y2 = pts[b + 1], x3 = pts[c], y3 = pts[c + 1];
          const d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
          if (Math.abs(d) < 1e-9) continue;
          const l1 = ((y2 - y3) * (px - x3) + (x3 - x2) * (py - y3)) / d;
          const l2 = ((y3 - y1) * (px - x3) + (x1 - x3) * (py - y3)) / d;
          const l3 = 1 - l1 - l2;
          if (l1 >= 0 && l2 >= 0 && l3 >= 0) hit = true;
        }
        if (hit) out.push(i);
      }
      return out;
    };
    const describe = (i) => {
      const masks = model.getDrawableMasks ? model.getDrawableMasks() : null;
      const counts = model.getDrawableMaskCounts ? model.getDrawableMaskCounts() : null;
      const list = masks && counts ? Array.from(masks[i] || []).slice(0, counts[i]) : [];
      return {
        i, op: +model.getDrawableOpacity(i).toFixed(3), tex: model.getDrawableTextureIndex(i),
        part: model.getDrawableParentPartIndex(i), visible: model.getDrawableDynamicFlagIsVisible(i),
        inverted: safe(() => model.getDrawableInvertedMaskBit(i)),
        blend: safe(() => model.getDrawableBlendMode(i)),
        masks: list, alphaBlend: safe(() => model.getDrawableAlphaBlend(i)), colorBlend: safe(() => model.getDrawableColorBlend(i)),
        vcount: model.getDrawableVertexCount(i), id: safe(() => model.getDrawableId(i)),
      };
    };
    if (mode === 'props') {
      const ids = (q.get('ids') || '').split(',').map(Number).filter(n => Number.isFinite(n));
      post({ stage: 'props', items: ids.map(describe) });
      post({ stage: 'probe-done', mode }); return;
    }
    const whiteCov = m.ax != null ? cover(m.ax, m.ay) : [];
    const brownPt = (q.get('bx') && q.get('by')) ? [Number(q.get('bx')), Number(q.get('by'))] : null;
    post({ stage: 'cov', base: m, whiteAt: [m.ax, m.ay], whiteCover: whiteCov.map(describe) });
    if (brownPt) post({ stage: 'cov', point: brownPt, cover: cover(brownPt[0], brownPt[1]).map(describe) });
    post({ stage: 'probe-done', mode }); return;
  }

  post({ stage: 'probe-done', mode, note: 'unknown mode' });
};
