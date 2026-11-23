import { JellyfishRenderer } from './cubism-renderer.mjs';
const realFetch = window.fetch.bind(window);
function post(o){ try { realFetch('/__log', { method:'POST', body: JSON.stringify(o) }); } catch(e) {} }

window.__scan = async function () {
  const W = 320, H = 480;
  const canvas = document.getElementById('model');
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  canvas.width = W; canvas.height = H;
  const r = new JellyfishRenderer(canvas, () => {}, { assetBase: 'assets/jellyfish/' });
  await r.load();
  r.setFraming('half');
  const gl = canvas.getContext('webgl');
  const draw = () => r.updateView({ state:'idle', expression:{emotion:'neutral',intensity:0,delivery:'',gesture:null}, mouth:0 }, 'idle', false);
  const read = () => { const px = new Uint8Array(W*H*4); gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
  for (let i=0;i<4;i++) draw();
  const px = read();
  let white = null, brown = null;
  for (let y = Math.round(H*0.16); y < Math.round(H*0.48); y++) {
    for (let x = Math.round(W*0.40); x < Math.round(W*0.60); x++) {
      const o = (y*W+x)*4, R = px[o], G = px[o+1], B = px[o+2], A = px[o+3];
      if (A < 200) continue;
      if (!white && R > 246 && G > 246 && B > 244) white = { x, y };
      if (!brown && R > 90 && R < 200 && G > 55 && G < 150 && B > 40 && B < 130 && (R - B) > 25 && (R - G) > 15) brown = { x, y };
    }
  }
  post({ stage: 'targets', white, brown });
  const model = r._model.getModel();
  const dw = model.drawables;
  const sample = (coord) => { if (!coord) return null; const b = new Uint8Array(4); gl.readPixels(coord.x, H-1-coord.y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
  const baseW = sample(white), baseB = sample(brown);
  const diff = (a, b) => (a && b) ? Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) + Math.abs(a[2]-b[2]) : 0;
  const hitsW = [], hitsB = [];
  for (let i = 0; i < dw.count; i++) {
    const prev = dw.opacities[i];
    dw.opacities[i] = 0;
    draw();
    if (white) { const v = sample(white); const d = diff(baseW, v); if (d > 25) hitsW.push({ i, d, v, tex: dw.textureIndices[i], part: dw.parentPartIndices[i] }); }
    if (brown) { const v = sample(brown); const d = diff(baseB, v); if (d > 25) hitsB.push({ i, d, v, tex: dw.textureIndices[i], part: dw.parentPartIndices[i] }); }
    dw.opacities[i] = prev;
  }
  post({ stage: 'done', total: dw.count, baseW, baseB, whiteHits: hitsW.slice(0, 12), brownHits: hitsB.slice(0, 12) });
};
