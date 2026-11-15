import * as THREE from 'three';
import { Module } from '../core/Module.js';
import { lodViews } from '../core/lodViews.js';   // so the terrain streams sharp tiles around the fly camera (same list CharacterModule uses)   // this file lives in src/modules/ ; use '../../core/Module.js' if you put it one folder deeper

/* =====================================================================
   BuildPotentialModule.js  -  "Build potential"
   A separate module (like SitePickModule) for the 4th button on page 2.

   Flow
     1. Title page 2, 4th button  ->  ctx.bus.emit('build:open')
     2. A small form asks only for the BUILDING size and the steepest slope.
        There is NO area to choose: the area is always the HiRISE (1 m) coverage.
     3. The title screen listens for 'build:start' and opens the map.
     4. The camera frames the whole HiRISE rectangle, sharp tiles load, every cell is
        slope-tested, and cells that only have coarse (regional / global) data are ignored.
        Green = the building fits, amber = flat but too small, red = too steep.
        The 5 best spots are outlined, numbered and listed in a panel.

   It does not recentre the world and does not touch the route; it only paints an overlay
   (its own uniforms, so it can live next to the route painter and SitePickModule).
   ===================================================================== */

const DEF = { type: 'flat', fLen: 100, fBrd: 50, slope: 3, mineral: 'water', strength: 'medium', maxDist: 500, ti: 'any' };
const MAX_CELLS = 700;          // grid cells per side of the HiRISE area
const MIN_CELL = 2;             // never finer than this many metres
const MASK_PX = 2048;           // size of the painted overlay texture (longest side). Was 4096 = 64 MB of RAM + 64 MB of GPU memory; 2048 = 16 + 16
const SETTLE_POLL = 400;        // ms between checks that sharper terrain tiles have loaded
const SETTLE_MAX = 9000;        // give up waiting after this long
const RELIEF_K = 1;             // whole footprint height range <= tan(slope) x shorter side (lower = stricter)
const SITE_COUNT = 5;           // best spots to outline
const COARSE = /regional|global/i;   // terrain layer names that are NOT HiRISE
// ---- look of the painted overlay: change these ----
const ALPHA_OK = 0.19;       // green  = building fits   (0 = invisible, 1 = solid; was 0.62)
const ALPHA_FLAT = 0.22;     // amber  = flat but too small (was 0.34)
const ALPHA_STEEP = 0.22;    // red    = too steep (was 0.34)
const ALPHA_SOFT = 0.35;     // brown  = soft ground (was 0.5)
const ALPHA_MINERAL = 0.5;   // purple = mineral (was 0.7)
const NUM_SCALE = 0.3;       // site number size as a fraction of the box size (was 0.7; smaller = smaller number)
const NUM_MIN_PX = 12;       // smallest the number may get (was 22)
// ---- memory: raise these again if you have RAM to spare ----
const FLY_RING_R = 650;       // full-detail terrain circle around the fly camera, metres (was 900)
const FLY_RING_H = 2200;      // height up to which that circle is used, metres (was 3000)
const BOX_LINE = 0.05;       // white outline thickness as a fraction of the box size (was 0.12)
const RGB = { ok: [57, 255, 136], flat: [255, 200, 60], steep: [255, 70, 60], soft: [170, 130, 80] };

const TILES_URL = (import.meta.env.VITE_TILES_URL ?? `${import.meta.env.BASE_URL}tiles/`).replace(/\/?$/, '/');
const CRISM_BASE = TILES_URL + 'overlays/crism/';       // made by tools/crism_to_overlay.py
// CRISM summary parameters (band depths) that point to each target. A cell counts as "mineral" if ANY listed band is strong enough.
const MINERALS = {
  water:     { label: 'Hydrated minerals (water)', bands: ['BD1900_2', 'BD1900R2'] },
  sulfate:   { label: 'Hydrated sulfates',         bands: ['BD2100_2', 'SINDEX2'] },
  clay:      { label: 'Clays (Fe/Mg and Al)',      bands: ['D2300', 'BD2290', 'BD2190', 'BD2210_2'] },
  carbonate: { label: 'Carbonates',                bands: ['MIN2295_2480', 'MIN2345_2537', 'BD2500_2'] },
  gypsum:    { label: 'Gypsum / polyhydrated',     bands: ['BD1750_2'] },
  silica:    { label: 'Opal / hydrated silica',    bands: ['BD2250', 'MIN2250'] },
  olivine:   { label: 'Olivine',                   bands: ['OLINDEX3'] },
  pyroxene:  { label: 'Pyroxene (low + high Ca)',  bands: ['LCPINDEX2', 'HCPINDEX2'] },
  ferric:    { label: 'Iron oxides (ferric)',      bands: ['BD530_2', 'BD640_2', 'BD860_2', 'BD920_2'] },
  ice:       { label: 'Water ice',                 bands: ['BD1500_2', 'BD3100'] },
};
const STRENGTH = { strong: 'p95', medium: 'p90', weak: 'p80' };   // threshold = that percentile of the mosaic's detections
const MINERAL_RGB = [190, 110, 255];
// Thermal inertia (tiu = J m-2 K-1 s-1/2). Rough rules of thumb: <100 fine dust, 100-250 sand / mixed, 250-400 crusted or cemented, >400 rocky.
const TI_LEVELS = { any: 0, avoid: 150, firm: 250, rock: 400 };
const TI_BASE = TILES_URL + 'overlays/ti/';              // made by tools/ti_to_overlay.py

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtLat = (v) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? 'N' : 'S'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? 'E' : 'W'}`;
const fmtLen = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`);

/* Slope + fitting-footprint analysis (pure maths, no 3D). Copied in so this module has no dependency on SitePickModule. */
// min or max of h over every w x hh window (separable sliding window). Result index (i,j) = window whose top-left cell is (i,j).
function windowExtreme(h, cols, rows, w, hh, isMax) {
  const better = isMax ? (a, b) => a >= b : (a, b) => a <= b;
  const slide = (get, len, win) => {
    const out = new Float32Array(Math.max(0, len - win + 1)), dq = [];
    let head = 0;
    for (let k = 0; k < len; k++) {
      const v = get(k);
      while (dq.length > head && better(v, get(dq[dq.length - 1]))) dq.pop();
      dq.push(k);
      if (dq[head] <= k - win) head++;
      if (k >= win - 1) out[k - win + 1] = get(dq[head]);
    }
    return out;
  };
  const W = cols - w + 1, H = rows - hh + 1;
  if (W <= 0 || H <= 0) return { W: 0, H: 0, v: new Float32Array(0) };
  const tmp = new Float32Array(W * rows);
  for (let j = 0; j < rows; j++) tmp.set(slide((k) => { const x = h[j * cols + k]; return x === x ? x : 0; }, cols, w), j * W);
  const v = new Float32Array(W * H);
  for (let i = 0; i < W; i++) { const col = slide((k) => tmp[k * W + i], rows, hh); for (let j = 0; j < H; j++) v[j * W + i] = col[j]; }
  return { W, H, v };
}

// distance (metres) from every cell to the nearest mineral cell (two-pass chamfer)
function distToMask(mask, cols, rows, cell) {
  const d = new Float32Array(cols * rows), D = Math.SQRT2;
  for (let k = 0; k < d.length; k++) d[k] = mask[k] ? 0 : 1e9;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i; let v = d[k];
    if (i) v = Math.min(v, d[k - 1] + 1);
    if (j) { v = Math.min(v, d[k - cols] + 1); if (i) v = Math.min(v, d[k - cols - 1] + D); if (i < cols - 1) v = Math.min(v, d[k - cols + 1] + D); }
    d[k] = v;
  }
  for (let j = rows - 1; j >= 0; j--) for (let i = cols - 1; i >= 0; i--) {
    const k = j * cols + i; let v = d[k];
    if (i < cols - 1) v = Math.min(v, d[k + 1] + 1);
    if (j < rows - 1) { v = Math.min(v, d[k + cols] + 1); if (i < cols - 1) v = Math.min(v, d[k + cols + 1] + D); if (i) v = Math.min(v, d[k + cols - 1] + D); }
    d[k] = v;
  }
  for (let k = 0; k < d.length; k++) d[k] *= cell;
  return d;
}

// opts (optional): { block: Uint8Array of cells that are NOT allowed (soft ground), dist: Float32Array metres to nearest mineral per cell, maxDist } -> the footprint centre must be within maxDist of mineral
function analyseSites(h, cols, rows, cell, fLen, fBrd, maxSlopeDeg, count = SITE_COUNT, opts = null) {
  const maxRelief = Math.tan(maxSlopeDeg * Math.PI / 180) * Math.min(fLen, fBrd) * RELIEF_K;   // whole footprint may not rise / fall more than this
  const n = cols * rows;
  const slope = new Float32Array(n).fill(NaN);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const m = h[j * cols + i];
      if (!(m === m)) continue;
      // steepest drop / rise to any of the 8 neighbours (stricter than a central difference, which smooths edges away)
      let best = 0, bad = false;
      for (let dj = -1; dj <= 1 && !bad; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue;
        const v = h[jj * cols + ii];
        if (!(v === v)) { bad = true; break; }
        const sl = Math.abs(v - m) / (cell * (di && dj ? Math.SQRT2 : 1));
        if (sl > best) best = sl;
      }
      if (!bad) slope[j * cols + i] = Math.atan(best) * 180 / Math.PI;
    }
  }
  const ok = new Uint8Array(n);
  let valid = 0, okCells = 0;
  for (let k = 0; k < n; k++) {
    if (slope[k] === slope[k]) { valid++; if (slope[k] <= maxSlopeDeg && !(opts && opts.block && opts.block[k])) { ok[k] = 1; okCells++; } }
  }

  // integral images: number of gentle cells, and sum of slope
  const SW = cols + 1;
  const okI = new Int32Array(SW * (rows + 1)), slI = new Float64Array(SW * (rows + 1));
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = (j + 1) * SW + i + 1, s = slope[j * cols + i];
      okI[k] = ok[j * cols + i] + okI[k - 1] + okI[k - SW] - okI[k - SW - 1];
      slI[k] = (s === s ? s : 0) + slI[k - 1] + slI[k - SW] - slI[k - SW - 1];
    }
  }
  const rect = (I, i, j, w, hh) => I[(j + hh) * SW + i + w] - I[j * SW + i + w] - I[(j + hh) * SW + i] + I[j * SW + i];

  const wc = Math.max(1, Math.ceil(fLen / cell - 1e-6)), hc = Math.max(1, Math.ceil(fBrd / cell - 1e-6));
  const orient = [[wc, hc]];
  if (wc !== hc) orient.push([hc, wc]);                         // the building may also be turned 90 degrees

  const diff = new Int32Array(SW * (rows + 1));                 // 2-D difference array: which cells are covered by a fitting footprint
  const cand = [];
  for (const [w, hh] of orient) {
    if (w > cols || hh > rows) continue;
    const mx = windowExtreme(h, cols, rows, w, hh, true), mn = windowExtreme(h, cols, rows, w, hh, false);
    // RAM: instead of one object for every fitting position (can be hundreds of thousands), keep only the best position of each
    // w x hh block. Positions inside one block all overlap each other and sites may not overlap, so the best sites stay the same.
    const BX = Math.ceil((cols - w + 1) / w), BY = Math.ceil((rows - hh + 1) / hh), NB = BX * BY;
    const bs = new Float32Array(NB).fill(Infinity), bi = new Int32Array(NB), bj = new Int32Array(NB), bsl = new Float32Array(NB), bd = new Float32Array(NB);
    for (let j = 0; j + hh <= rows; j++) {
      for (let i = 0; i + w <= cols; i++) {
        if (rect(okI, i, j, w, hh) !== w * hh) continue;
        if (mx.v[j * mx.W + i] - mn.v[j * mn.W + i] > maxRelief) continue;
        let dm = 0;
        if (opts && opts.dist) { dm = opts.dist[(j + (hh >> 1)) * cols + i + (w >> 1)]; if (!(dm <= opts.maxDist)) continue; }
        const ms = rect(slI, i, j, w, hh) / (w * hh);
        diff[j * SW + i]++; diff[j * SW + i + w]--; diff[(j + hh) * SW + i]--; diff[(j + hh) * SW + i + w]++;
        const sc = opts && opts.dist ? dm / opts.maxDist + ms / maxSlopeDeg : ms;
        const b = ((j / hh) | 0) * BX + ((i / w) | 0);
        if (sc < bs[b]) { bs[b] = sc; bi[b] = i; bj[b] = j; bsl[b] = ms; bd[b] = dm; }
      }
    }
    for (let b = 0; b < NB; b++) if (bs[b] < Infinity) cand.push({ i: bi[b], j: bj[b], w, h: hh, slope: bsl[b], dist: bd[b], score: bs[b] });
  }
  const covered = new Uint8Array(n);
  let coveredCells = 0;
  {
    const run = new Int32Array(SW * (rows + 1));
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const v = diff[j * SW + i] + (i ? run[j * SW + i - 1] : 0) + (j ? run[(j - 1) * SW + i] : 0) - (i && j ? run[(j - 1) * SW + i - 1] : 0);
        run[j * SW + i] = v;
        if (v > 0) { covered[j * cols + i] = 1; coveredCells++; }
      }
    }
  }

  // best spots: lowest mean slope first, not overlapping each other
  cand.sort((p, q) => p.score - q.score);
  const sites = [];
  for (const c of cand) {
    if (sites.length >= count) break;
    const m = Math.max(c.w, c.h) >> 1;
    if (sites.some((s) => c.i < s.i + s.w + m && c.i + c.w + m > s.i && c.j < s.j + s.h + m && c.j + c.h + m > s.j)) continue;
    let mx = 0, lo = Infinity, hi = -Infinity, sum = 0;
    for (let j = c.j; j < c.j + c.h; j++) for (let i = c.i; i < c.i + c.w; i++) {
      const k = j * cols + i, v = h[k];
      if (slope[k] > mx) mx = slope[k];
      if (v < lo) lo = v; if (v > hi) hi = v; sum += v;
    }
    sites.push({ ...c, meanSlope: c.slope, maxSlope: mx, relief: hi - lo, elev: sum / (c.w * c.h) });
  }
  return { slope, ok, covered, block: (opts && opts.block) || null, sites, valid, okCells, coveredCells, wc, hc, candidates: cand.length };
}

/* ---------------------------------------------------------------------
   Painting an overlay INTO the terrain (own uniforms / varying names: prefix "Hs").
   --------------------------------------------------------------------- */
const HS_PATCHED = new WeakSet();
const HS_U = {
  uHsMask: { value: null },
  uHsBox: { value: new THREE.Vector4() },
  uHsOn: { value: 0 },
};
function patchMaterial(m) {
  if (!m || HS_PATCHED.has(m) || m.isShaderMaterial) return;
  HS_PATCHED.add(m);
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer);
    if (!shader.fragmentShader.includes('#include <dithering_fragment>')) return;
    if (shader.vertexShader.includes('vHsXZ')) return;
    Object.assign(shader.uniforms, HS_U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vHsXZ;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vHsXZ = (modelMatrix * vec4(transformed, 1.0)).xz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vHsXZ;
        uniform sampler2D uHsMask;
        uniform vec4 uHsBox;
        uniform float uHsOn;`)
      .replace('#include <dithering_fragment>', `
        {
          vec2 huv = (vHsXZ - uHsBox.xy) / uHsBox.zw;
          if (uHsOn > 0.5 && huv.x >= 0.0 && huv.x <= 1.0 && huv.y >= 0.0 && huv.y <= 1.0) {
            vec4 hm = texture2D(uHsMask, huv);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, hm.rgb, hm.a);
          }
        }
        #include <dithering_fragment>`);
  };
  m.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + '|hirisePaint'; };
  m.needsUpdate = true;
}

const STYLE = `
.hs-overlay{position:fixed;inset:0;z-index:10060;display:none;align-items:center;justify-content:center;padding:16px;
  background:rgba(8,5,4,.7);backdrop-filter:blur(4px);color:#f4e9e1;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.hs-overlay.hs-open{display:flex}
.hs-box{width:min(480px,100%);max-height:92vh;overflow:auto;background:#1b1210;border:1px solid rgba(255,255,255,.18);border-radius:16px;
  padding:22px 24px;box-shadow:0 20px 60px rgba(0,0,0,.55);box-sizing:border-box}
.hs-box h2{margin:0 0 6px;font-size:22px;letter-spacing:.08em;text-transform:uppercase}
.hs-box p{margin:0 0 14px;opacity:.75;font-size:13px;line-height:1.55}
.hs-box h3{margin:16px 0 8px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#e0875a}
.hs-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.hs-box label{display:block;font-size:12px;opacity:.8;margin-bottom:4px}
.hs-in{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.08);
  color:#fff;font:14px system-ui,sans-serif;outline:none}
.hs-in option{background:#1b1210;color:#fff}
.hs-in:focus{border-color:#f0a47a}
.hs-btns{display:flex;gap:10px;margin-top:18px}
.hs-btn{flex:1;font:inherit;font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;cursor:pointer;padding:12px;border-radius:999px;
  border:1px solid rgba(240,164,122,.55);color:#f4e9e1;background:transparent}
.hs-btn.go{border:0;color:#fff;background:linear-gradient(135deg,#e0875a,#b5482a 60%,#6b2a3f)}
.hs-err{color:#ffb4b4;font-size:12.5px;min-height:16px;margin-top:10px}
.hs-hud{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:1003;padding:8px 14px;background:rgba(0,0,0,.72);
  border-radius:8px;font:14px system-ui,sans-serif;color:#fff;max-width:92vw;text-align:center}
.hs-res{font:13px/1.5 system-ui,sans-serif;color:#fff}
.hs-res .hs-k{opacity:.6}
.hs-res .hs-sw{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-2px}
.hs-site{display:flex;gap:8px;align-items:flex-start;padding:6px;margin:3px 0;border-radius:6px;background:rgba(255,255,255,.07);cursor:pointer}
.hs-site:hover{background:rgba(255,255,255,.15)}
.hs-num{flex:none;width:20px;height:20px;border-radius:50%;background:#39ff88;color:#062;font-weight:700;display:grid;place-items:center;font-size:12px}
.hs-warn{margin-top:8px;padding:6px 8px;border-radius:6px;background:rgba(255,190,60,.18);border:1px solid rgba(255,190,60,.5);font-size:12px}
.hs-res button{margin:8px 6px 0 0;padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.1);color:#fff;font:12px system-ui,sans-serif;cursor:pointer}
`;

const NAV_STYLE = `
.hs-nav{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:10050;pointer-events:auto;display:flex;align-items:center;gap:8px;padding:8px 10px;
  background:rgba(0,0,0,.78);border:1px solid rgba(255,255,255,.28);border-radius:999px;color:#fff;font:13px system-ui,sans-serif;backdrop-filter:blur(4px)}
.hs-nav button{font:inherit;font-weight:700;cursor:pointer;padding:8px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.1);color:#fff}
.hs-nav button.hs-nx{border:0;background:linear-gradient(135deg,#e0875a,#b5482a 60%,#6b2a3f)}
.hs-nav .hs-lbl{min-width:120px;text-align:center}
.hs-nav .hs-keys{opacity:.55;font-size:11px;margin-left:4px;white-space:nowrap}
@media(max-width:700px){.hs-nav .hs-keys{display:none}}
`;
const FLY_CODES = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract'];
const FLY_FOV = 70, FLY_TURN = 1.8, FLY_PITCH0 = -1.0, BODY_LAYER = 1;   // same field of view / turn rate as Astro; BODY_LAYER = layer where Astro's body lives
const MINI_W = 560, MINI_H = 440, MINI_MARGIN = 16;                       // minimap box: identical to CharacterModule's

export class BuildPotentialModule extends Module {
  static id = 'buildpotential';
  static requires = ['world'];

  async init() {
    this.p = { ...DEF };
    this.state = 'idle';          // idle | form | working | done
    this.runId = 0;               // bumped to cancel a scan that is still waiting for tiles
    this.group = new THREE.Group();
    this.ctx.scene.add(this.group);
    this.buildForm();

    this.onOpen = () => this.openForm();
    this.onRecenter = () => this.clearOverlay();
    this.navKeys = new Set(); this.siteIdx = -1;
    this.fly = { on: false, x: 0, y: 500, z: 0, yaw: 0, pitch: FLY_PITCH0 };
    this.flyCam = new THREE.PerspectiveCamera(FLY_FOV, 1.6, 0.5, 400000);
    this.flyCam.rotation.order = 'YXZ';
    this.flyCam.layers.enable(BODY_LAYER);
    this.mapCam = new THREE.PerspectiveCamera();
    this.look = null;
    const cv = this.ctx.renderer?.domElement;
    this.onLookDown = (e) => {
      if (e.button !== 0 || !this.flyLive()) return;
      const m = this.ctx.miniRect;
      if (m && e.clientX >= m.left && e.clientX <= m.left + m.width && e.clientY >= m.top && e.clientY <= m.top + m.height) return;   // minimap belongs to MapPick
      this.look = { x: e.clientX, y: e.clientY };
    };
    this.onLookMove = (e) => {
      if (!this.look) return;
      this.fly.yaw -= (e.clientX - this.look.x) * 0.004;
      this.fly.pitch = clamp(this.fly.pitch - (e.clientY - this.look.y) * 0.004, -1.5, 1.5);
      this.look = { x: e.clientX, y: e.clientY };
    };
    this.onLookUp = () => { this.look = null; };
    cv?.addEventListener('pointerdown', this.onLookDown);
    window.addEventListener('pointermove', this.onLookMove);
    window.addEventListener('pointerup', this.onLookUp);
    this.onKeyDown = (e) => this.navKey(e, true);
    this.onKeyUp = (e) => this.navKey(e, false);
    this.onBlur = () => this.navKeys.clear();
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onBlur);
    this._offs = [
      this.ctx.bus.on('build:open', this.onOpen),
      this.ctx.bus.on('world:recentered', this.onRecenter),
    ];
  }

  /* ===================== form (building size only) ===================== */

  buildForm() {
    if (!document.getElementById('hs-style')) {
      const st = document.createElement('style');
      st.id = 'hs-style'; st.textContent = STYLE + NAV_STYLE;
      document.head.appendChild(st);
    }
    const ov = this.overlay = document.createElement('div');
    ov.className = 'hs-overlay';
    ov.innerHTML = `
      <div class="hs-box">
        <h2>Build potential</h2>
        <p>The HiRISE (1 m) area is checked automatically for places where a building can be built. Tell me how big the building is and how steep the ground may be, and I will highlight where it fits.</p>
        <h3>Build type</h3>
        <div class="hs-row"><div><label>What to build</label>
          <select class="hs-in" id="hs-type"><option value="flat">Flat ground (any building)</option><option value="mine">Mineral extraction site</option></select></div></div>
        <div id="hs-mine" style="display:none">
          <div class="hs-row" style="margin-top:10px">
            <div><label>Mineral target (CRISM)</label><select class="hs-in" id="hs-mineral">${Object.entries(MINERALS).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join('')}</select></div>
            <div><label>Detection strength</label><select class="hs-in" id="hs-strength"><option value="strong">Strong (top 5%)</option><option value="medium">Medium (top 10%)</option><option value="weak">Weak (top 20%)</option></select></div>
          </div>
          <div class="hs-row" style="margin-top:10px"><div><label>Max distance from mineral (m)</label><input class="hs-in" id="hs-dist" type="text"></div></div>
        </div>
        <h3>Building footprint</h3>
        <div class="hs-row">
          <div><label>Length (m)</label><input class="hs-in" id="hs-flen" type="text"></div>
          <div><label>Breadth (m)</label><input class="hs-in" id="hs-fbrd" type="text"></div>
        </div>
        <h3>Ground</h3>
        <div class="hs-row">
          <div><label>Steepest slope allowed (°)</label><input class="hs-in" id="hs-slope" type="text"></div>
          <div><label>Ground firmness (thermal inertia)</label><select class="hs-in" id="hs-ti"><option value="any">Any ground</option><option value="avoid">Avoid dust (≥ 150)</option><option value="firm">Firm ground (≥ 250)</option><option value="rock">Rocky ground (≥ 400)</option></select></div>
        </div>
        <div class="hs-err" id="hs-err"></div>
        <div class="hs-btns"><button class="hs-btn" id="hs-cancel">Cancel</button><button class="hs-btn go" id="hs-go">Check build potential</button></div>
      </div>`;
    document.body.appendChild(ov);
    const $ = (id) => ov.querySelector(id);
    this.f = { flen: $('#hs-flen'), fbrd: $('#hs-fbrd'), slope: $('#hs-slope'), type: $('#hs-type'), mineral: $('#hs-mineral'), strength: $('#hs-strength'), dist: $('#hs-dist'), mine: $('#hs-mine'), ti: $('#hs-ti') };
    this.f.type.onchange = () => { this.f.mine.style.display = this.f.type.value === 'mine' ? 'block' : 'none'; };
    this.formErr = $('#hs-err');
    ov.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.submitForm(); if (e.key === 'Escape') this.closeForm(); });
    $('#hs-go').onclick = () => this.submitForm();
    $('#hs-cancel').onclick = () => this.closeForm();
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) this.closeForm(); });
  }

  openForm() {
    this.state = 'form';
    const p = this.p;
    this.f.flen.value = p.fLen; this.f.fbrd.value = p.fBrd; this.f.slope.value = p.slope;
    this.f.ti.value = p.ti; this.f.type.value = p.type; this.f.mineral.value = p.mineral; this.f.strength.value = p.strength; this.f.dist.value = p.maxDist;
    this.f.mine.style.display = p.type === 'mine' ? 'block' : 'none';
    this.formErr.textContent = '';
    this.overlay.classList.add('hs-open');
    setTimeout(() => this.f.flen.focus(), 50);
  }

  closeForm() {
    this.overlay.classList.remove('hs-open');
    if (this.state === 'form') this.state = this.hasResult ? 'done' : 'idle';
  }

  submitForm() {
    const v = (el) => parseFloat(String(el.value).replace(',', '.'));
    const p = { fLen: v(this.f.flen), fBrd: v(this.f.fbrd), slope: v(this.f.slope), type: this.f.type.value, mineral: this.f.mineral.value, strength: this.f.strength.value, maxDist: v(this.f.dist), ti: this.f.ti.value };
    const bad = (x, a, b) => !(x >= a && x <= b);
    let msg = '';
    if (bad(p.fLen, 5, 3000) || bad(p.fBrd, 5, 3000)) msg = 'Building length and breadth must be between 5 and 3000 m.';
    else if (bad(p.slope, 0.5, 30)) msg = 'Slope limit must be between 0.5° and 30°.';
    else if (p.type === 'mine' && bad(p.maxDist, 20, 20000)) msg = 'Distance from the mineral must be between 20 and 20000 m.';
    if (msg) { this.formErr.textContent = msg; return; }
    this.p = p;
    this.overlay.classList.remove('hs-open');
    this.clearOverlay();

    if (document.body.classList.contains('title-open')) {
      this.ctx.bus.emit('build:start');                   // the title screen listens to this and opens the map
      setTimeout(() => {
        if (document.body.classList.contains('title-open')) {
          console.warn("[buildpotential] the title screen is still open. Add this to TitleScreen createUI():  this.ctx.bus.on('build:start', () => this.enterMarsScout('build'));");
          this.openForm();
          this.formErr.textContent = 'The title screen did not open the map. Add the build:start listener to TitleScreen (see the console).';
          return;
        }
        this.scan();
      }, 700);
    } else this.scan();
  }

  /* ===================== scan the HiRISE rectangle ===================== */

  async scan() {
    const id = ++this.runId;
    this.state = 'working';
    for (let k = 0; k < 100 && !this.ctx.state.get('terrain'); k++) await new Promise((r) => setTimeout(r, 100));
    const t = this.terrain = this.ctx.state.get('terrain');
    if (!t) { console.warn('[buildpotential] terrain not ready'); this.state = 'idle'; return; }

    // leave MapPick's two-pin mode (it treats Esc as "skip") so it only pans / zooms and ignores clicks
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    const r = t.hiriseRect;
    if (!r) {
      this.setHud('This terrain has no HiRISE coverage area (terrain.hiriseRect is missing).');
      setTimeout(() => this.removeHud(), 5000);
      this.state = 'idle';
      return;
    }
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    const cosLat = Math.max(0.05, Math.cos(THREE.MathUtils.degToRad(t.worldToLonLat(cx, cz).lat)));
    const ww = r.x1 - r.x0, wh = r.z1 - r.z0;                // world x is stretched by 1/cos(lat), see WorldModule

    this.setHud('Zooming to the HiRISE area and loading sharp terrain tiles…');
    const cam = this.ctx.camera, tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov ?? 50) / 2);
    const need = Math.max(wh / (2 * tanH), ww / (2 * tanH * (cam.aspect || 1.6))) * 1.1;
    cam.position.x = cx; cam.position.z = cz; cam.position.y = Math.max(need, 400);
    this.addFrame(r);

    const probe = () => {
      let s = 0;
      for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) s += (t.sampleWorld(r.x0 + (ww * (a + 0.5)) / 6, r.z0 + (wh * (b + 0.5)) / 6) ?? 0);
      return s;
    };
    let prev = NaN, same = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < SETTLE_MAX) {
      await new Promise((rs) => setTimeout(rs, SETTLE_POLL));
      if (id !== this.runId) return;
      const v = probe();
      same = v === prev ? same + 1 : 0; prev = v;
      if (same >= 2) break;
    }
    this.setHud('Analysing the HiRISE terrain…');
    await new Promise((rs) => setTimeout(rs, 30));
    if (id !== this.runId) return;
    try { await this.analyse(r, cosLat); } catch (e) {
      console.warn('[buildpotential]', e);
      this.setHud(esc(e.message || e));
      setTimeout(() => this.removeHud(), 8000);
      this.state = 'idle';
    }
  }

  /* ===================== thermal inertia layer ===================== */

  // ti.json + ti.png (byte 0 = no data, 1..255 = 0..vmax tiu)
  async loadTI() {
    if (this.tiData) return this.tiData;
    const res = await fetch(TI_BASE + 'ti.json');
    if (!res.ok) throw new Error('Thermal inertia overlay not found. Run tools/ti_to_overlay.py first (it writes public/tiles/overlays/ti/).');
    const meta = await res.json();
    const pr = await fetch(TI_BASE + 'ti.png');
    if (!pr.ok) throw new Error('ti.png is missing in public/tiles/overlays/ti/.');
    const bmp = await createImageBitmap(await pr.blob());
    const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const W = cv.width, H = cv.height, rgba = g.getImageData(0, 0, W, H).data;
    const data = new Uint8Array(W * H);
    for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4];
    bmp.close?.(); cv.width = cv.height = 0;                    // free the temporary canvas + bitmap
    return (this.tiData = { meta, w: W, h: H, data });
  }

  /* ===================== CRISM mineral layer ===================== */

  // Loads crism.json + the PNG of every band of this mineral (cached). Byte 0 = no data, 1..255 = 0..vmax.
  async loadCrism(key) {
    this.crism = this.crism || { meta: null, bands: {} };
    const c = this.crism;
    if (!c.meta) {
      const res = await fetch(CRISM_BASE + 'crism.json');
      if (!res.ok) throw new Error('CRISM overlay not found. Run tools/crism_to_overlay.py first (it writes public/tiles/overlays/crism/).');
      c.meta = await res.json();
    }
    for (const b of MINERALS[key].bands) {
      if (c.bands[b] || !c.meta.bands?.[b]) continue;
      const res = await fetch(`${CRISM_BASE}${b}.png`);
      if (!res.ok) continue;
      const bmp = await createImageBitmap(await res.blob());
      const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      const W = cv.width, H = cv.height, rgba = g.getImageData(0, 0, W, H).data;
      const data = new Uint8Array(W * H);
      for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4];
      bmp.close?.(); cv.width = cv.height = 0;                  // free the temporary canvas + bitmap
      c.bands[b] = { w: W, h: H, data };
    }
    const have = MINERALS[key].bands.filter((b) => c.bands[b]);
    if (!have.length) throw new Error(`None of the CRISM bands for "${MINERALS[key].label}" were found in the overlay folder.`);
    return { meta: c.meta, have };
  }

  async analyse(r, cosLat) {
    const t = this.terrain, p = this.p;
    const L = (r.x1 - r.x0) * cosLat, B = r.z1 - r.z0;        // real metres
    const cell = Math.max(MIN_CELL, Math.min(p.fLen, p.fBrd) / 4, Math.max(L, B) / MAX_CELLS);
    const cols = Math.max(2, Math.ceil(L / cell)), rows = Math.max(2, Math.ceil(B / cell));
    const dx = cell / cosLat, dz = cell;                      // world size of one cell
    const x0 = r.x0, z0 = r.z0;

    const mine = p.type === 'mine';
    let cr = null, minMask = null, crismSeen = 0, mineralCells = 0;
    if (mine) {
      this.setHud('Loading the CRISM mineral layer…');
      cr = await this.loadCrism(p.mineral);
      minMask = new Uint8Array(cols * rows);
    }
    const bb = cr?.meta.bbox, span = bb ? ((bb[2] - bb[0]) % 360 + 360) % 360 || 360 : 0;
    const thr = cr ? cr.have.map((b) => {
      const m = cr.meta.bands[b], v = m[STRENGTH[p.strength]];
      return { b, d: this.crism.bands[b], byte: Math.floor((v / m.vmax) * 254 + 1) };
    }) : [];
    const tiMin = TI_LEVELS[p.ti] || 0;
    let ti = null, tiBlock = null, tiVal = null, tiSeen = 0;
    if (tiMin) {
      this.setHud('Loading thermal inertia…');
      ti = await this.loadTI();
      tiBlock = new Uint8Array(cols * rows);
      tiVal = new Float32Array(cols * rows).fill(NaN);
    }
    const tb = ti?.meta.bbox, tspan = tb ? ((((tb[2] - tb[0]) % 360) + 360) % 360 || 360) : 0;
    const h = new Float32Array(cols * rows);
    const layers = {};
    let hirise = 0;
    const run = this.runId;
    for (let j = 0; j < rows; j++) {
      if (j % 20 === 0) {                                     // let the page (and the garbage collector) breathe, show progress
        this.setHud(`Analysing the terrain… ${Math.round((100 * j) / rows)}%`);
        await new Promise((rs) => setTimeout(rs, 0));
        if (run !== this.runId) return;                       // cancelled (Clear / Rescan)
      }
      for (let i = 0; i < cols; i++) {
        const ll = t.worldToLonLat(x0 + (i + 0.5) * dx, z0 + (j + 0.5) * dz);
        const s = t.sample(ll.lon, ll.lat);
        if (cr) {
          const u = (((ll.lon - bb[0]) % 360) + 360) % 360 / span, vv = (bb[3] - ll.lat) / (bb[3] - bb[1]);
          if (u >= 0 && u < 1 && vv >= 0 && vv < 1) {
            let seen = false, hit = false;
            for (const T of thr) {
              const val = T.d.data[Math.floor(vv * T.d.h) * T.d.w + Math.floor(u * T.d.w)];
              if (val) { seen = true; if (val >= T.byte) hit = true; }
            }
            if (seen) crismSeen++;
            if (hit) { minMask[j * cols + i] = 1; mineralCells++; }
          }
        }
        if (ti) {
          const u = (((ll.lon - tb[0]) % 360) + 360) % 360 / tspan, vv = (tb[3] - ll.lat) / (tb[3] - tb[1]);
          if (u >= 0 && u < 1 && vv >= 0 && vv < 1) {
            const byte = ti.data[Math.floor(vv * ti.h) * ti.w + Math.floor(u * ti.w)];
            if (byte) {                                       // unknown (0) is never blocked: we cannot judge it
              const val = ((byte - 1) / 254) * ti.meta.vmax;
              tiVal[j * cols + i] = val; tiSeen++;
              if (val < tiMin) tiBlock[j * cols + i] = 1;
            }
          }
        }
        if (s && !COARSE.test(s.layer)) { h[j * cols + i] = s.h; hirise++; }
        else h[j * cols + i] = NaN;                           // coarse data or none: not part of the HiRISE scan
        if (s) layers[s.layer] = (layers[s.layer] || 0) + 1;
      }
    }
    const dist = mine && mineralCells ? distToMask(minMask, cols, rows, cell) : null;
    const res = analyseSites(h, cols, rows, cell, p.fLen, p.fBrd, p.slope, SITE_COUNT, (mine || tiBlock) ? { dist: mine ? (dist || new Float32Array(cols * rows).fill(1e9)) : null, maxDist: p.maxDist, block: tiBlock } : null);
    res.mineral = minMask;
    this.last = {
      cols, rows, cell, dx, dz, x0, z0, res, layers, center: t.worldToLonLat((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2),
      L, B, hiriseShare: hirise / (cols * rows), mine, mineralCells, crismShare: crismSeen / (cols * rows), tiMin, tiShare: tiSeen / (cols * rows),
      sites: res.sites.map((s) => {
        const wx = x0 + (s.i + s.w / 2) * dx, wz = z0 + (s.j + s.h / 2) * dz, ll = t.worldToLonLat(wx, wz);
        return { ...s, ti: tiVal ? tiVal[Math.floor(s.j + s.h / 2) * cols + Math.floor(s.i + s.w / 2)] : NaN, wx, wz, lat: ll.lat, lon: ll.lon, lenM: s.w * cell, brdM: s.h * cell };
      }),
    };
    this.hasResult = true;
    this.paintOverlay(this.last);
    res.slope = res.ok = res.covered = res.block = res.mineral = null;   // only the painter needed these (about 10 MB)
    tiVal = null;
    this.state = 'done';
    this.removeHud();
    this.showPanel(this.last);
    this.siteIdx = -1; this.showNav(this.last);
    this.startFly();
    this.ctx.bus.emit('build:found', { params: this.p, sites: this.last.sites });
    console.log(`[buildpotential] ${cols}x${rows} cells of ${cell.toFixed(1)} m, ${(100 * this.last.hiriseShare).toFixed(0)}% HiRISE, ${res.sites.length} best sites`, layers);
  }

  /* ===================== HUD + frame ===================== */

  setHud(html) {
    if (!this.hud) { this.hud = document.createElement('div'); this.hud.className = 'hs-hud'; document.body.appendChild(this.hud); }
    this.hud.innerHTML = html;
  }
  removeHud() { this.hud?.remove(); this.hud = null; }

  addFrame(r) {
    this.removeFrame();
    const t = this.terrain, pts = [[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1], [r.x0, r.z0]];
    const g = new THREE.BufferGeometry();
    const a = new Float32Array(pts.length * 3);
    pts.forEach(([x, z], i) => a.set([x, (t.sampleWorld(x, z) ?? 0) + 3, z], i * 3));
    g.setAttribute('position', new THREE.BufferAttribute(a, 3));
    this.frame = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
    this.frame.frustumCulled = false; this.frame.renderOrder = 996;
    this.group.add(this.frame);
  }
  removeFrame() {
    if (!this.frame) return;
    this.group.remove(this.frame); this.frame.geometry.dispose(); this.frame.material.dispose(); this.frame = null;
  }

  /* ===================== overlay painted into the terrain ===================== */

  paintOverlay(d) {
    this.disposeTex();
    const { cols, rows, dx, dz, x0, z0, res } = d;
    const W = cols * dx, H = rows * dz, sc = MASK_PX / Math.max(W, H);
    const cw = Math.max(2, Math.ceil(W * sc)), ch = Math.max(2, Math.ceil(H * sc));
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d');
    const px = (W * sc) / cols, py = (H * sc) / rows;
    const col = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
    const C_OK = col(RGB.ok, ALPHA_OK), C_FLAT = col(RGB.flat, ALPHA_FLAT), C_SOFT = col(RGB.soft, ALPHA_SOFT), C_STEEP = col(RGB.steep, ALPHA_STEEP);
    let cur = '';
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i, s = res.slope[k];
        if (!(s === s)) continue;
        const c = res.covered[k] ? C_OK : res.ok[k] ? C_FLAT : (res.block && res.block[k] && s <= this.p.slope) ? C_SOFT : C_STEEP;
        if (c !== cur) g.fillStyle = cur = c;                 // no new string / style parse for every one of the ~490 000 cells
        g.fillRect(i * px, j * py, px + 0.6, py + 0.6);
      }
    }
    if (res.mineral) {                                        // CRISM mineral cells on top of the slope colours
      g.fillStyle = col(MINERAL_RGB, ALPHA_MINERAL);
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) if (res.mineral[j * cols + i]) g.fillRect(i * px, j * py, px + 0.6, py + 0.6);
    }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    d.sites.forEach((s, n) => {
      const rx = s.i * px, ry = s.j * py, rw = s.w * px, rh = s.h * py, m = Math.min(rw, rh);
      g.lineWidth = Math.max(2, m * BOX_LINE); g.strokeStyle = '#ffffff';
      g.strokeRect(rx, ry, rw, rh);
      const fs = Math.max(NUM_MIN_PX, m * NUM_SCALE);
      g.font = `700 ${fs}px system-ui, sans-serif`;
      g.lineWidth = fs * 0.18; g.strokeStyle = 'rgba(0,0,0,.85)';
      g.strokeText(String(n + 1), rx + rw / 2, ry + rh / 2);
      g.fillStyle = '#fff'; g.fillText(String(n + 1), rx + rw / 2, ry + rh / 2);
    });
    const tex = new THREE.CanvasTexture(cv);
    tex.flipY = false;                                        // canvas row 0 = z0 (north)
    tex.generateMipmaps = false;
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    if (THREE.NoColorSpace !== undefined) tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    this.tex = tex;
    // the GPU now keeps its own copy: let go of the 2-D canvas, otherwise its pixels also stay in RAM
    try { const rr = this.ctx.renderer; if (typeof rr?.initTexture === 'function') { rr.initTexture(tex); cv.width = cv.height = 1; } } catch (e) { /* keep the canvas */ }
    HS_U.uHsMask.value = tex;
    HS_U.uHsBox.value.set(x0, z0, W, H);
    HS_U.uHsOn.value = 1;

    this.patchAll();
    clearInterval(this.patchTimer);
    this.patchTimer = setInterval(() => this.patchAll(), 500);   // the terrain makes new tiles while you zoom: patch them too
  }

  patchAll() {
    this.ctx.scene.traverse((o) => {
      if (o === this.group || !o.isMesh || !(o.geometry?.attributes?.position?.count > 1000)) return;
      for (const m of [].concat(o.material)) patchMaterial(m);
    });
  }

  disposeTex() { this.tex?.dispose(); this.tex = null; }

  clearOverlay() {
    this.runId++;                                              // cancels a scan that is still waiting
    clearInterval(this.patchTimer); this.patchTimer = null;
    HS_U.uHsOn.value = 0;
    if (this.tex && HS_U.uHsMask.value === this.tex) HS_U.uHsMask.value = null;
    this.disposeTex();
    this.removeFrame(); this.removeHud(); this.removePanel(); this.removeNav(); this.removeMark();
    this.navKeys?.clear(); this.siteIdx = -1; this.stopFly?.();
    this.hasResult = false; this.last = null;
    if (this.state === 'working' || this.state === 'done') this.state = 'idle';
  }

  /* ===================== result panel ===================== */

  showPanel(d) {
    this.removePanel();
    const p = this.p, r = d.res;
    const ha = (cells) => (cells * d.cell * d.cell) / 1e4;
    const pct = r.valid ? (100 * r.coveredCells) / r.valid : 0;
    const sw = (c, a) => `<span class="hs-sw" style="background:rgba(${c[0]},${c[1]},${c[2]},${a})"></span>`;
    let html = `<div class="hs-res">
      <div><span class="hs-k">Area</span> ${fmtLen(d.L)} × ${fmtLen(d.B)} · centre ${fmtLat(d.center.lat)}, ${fmtLon(d.center.lon)}</div>
      <div><span class="hs-k">Building</span> ${p.fLen} × ${p.fBrd} m · slope ≤ ${p.slope}°</div>
      <div><span class="hs-k">Scan</span> cells of ${d.cell.toFixed(1)} m · ${(100 * d.hiriseShare).toFixed(0)}% of the rectangle has HiRISE data</div>`;
    if (d.mine) {
      const mt = MINERALS[p.mineral].label;
      html += `<div><span class="hs-k">Target</span> ${esc(mt)} · ${p.strength} · within ${fmtLen(p.maxDist)}</div>`;
      if (d.crismShare < 0.02) html += '<div class="hs-warn">The CRISM mosaic barely covers this area, so no mineral could be judged. Check that crism.json has the right bbox.</div>';
      else if (!d.mineralCells) html += `<div class="hs-warn">No ${esc(mt.toLowerCase())} detected at this strength inside the area. Try a weaker strength or another mineral.</div>`;
    }
    if (d.tiMin) {
      html += `<div><span class="hs-k">Ground</span> thermal inertia ≥ ${d.tiMin}</div>`;
      if (d.tiShare < 0.02) html += '<div class="hs-warn">The thermal inertia map barely covers this area, so firmness was not checked. Check the bbox in ti.json.</div>';
    }
    if (!r.valid) {
      html += '<div class="hs-warn">No HiRISE terrain data was found. The sharp tiles may not have loaded yet: press Rescan.</div>';
    } else if (!d.sites.length) {
      html += `<div class="hs-warn"><b>No place fits.</b> Nowhere in the HiRISE area can a ${p.fLen} × ${p.fBrd} m building sit on ground gentler than ${p.slope}°. Try a smaller building or a higher slope limit.</div>`;
    } else {
      html += `<div style="margin-top:6px"><b>${pct.toFixed(1)}%</b> of the HiRISE area is suitable (${ha(r.coveredCells).toFixed(1)} ha). Best spots:</div>`;
      d.sites.forEach((s, n) => {
        html += `<div class="hs-site" data-n="${n}"><span class="hs-num">${n + 1}</span><span>${fmtLat(s.lat)}, ${fmtLon(s.lon)}<br>` +
          `<span class="hs-k">${d.mine ? `${fmtLen(s.dist)} from mineral · ` : ''}${Number.isFinite(s.ti) ? `thermal inertia ${s.ti.toFixed(0)} · ` : ''}mean slope ${s.meanSlope.toFixed(1)}° · max ${s.maxSlope.toFixed(1)}° · height range ${s.relief.toFixed(1)} m · elevation ${s.elev.toFixed(0)} m</span></span></div>`;
      });
    }
    html += `<div style="margin-top:8px">${sw(RGB.ok, 0.8)}Building fits here${d.mine ? ' (and is close to the mineral)' : ''}<br>${sw(RGB.flat, 0.6)}Flat, but too small for the building<br>${sw(RGB.steep, 0.6)}Too steep${d.tiMin ? `<br>${sw(RGB.soft, 0.7)}Gentle, but ground too soft / dusty` : ''}${d.mine ? `<br>${sw(MINERAL_RGB, 0.8)}CRISM mineral detected` : ''}</div>`;
    if (d.hiriseShare < 0.5) html += '<div class="hs-warn">Less than half of the rectangle has loaded HiRISE data, so the result covers only part of it. Press Rescan to give the tiles more time.</div>';
    if (d.cell > Math.min(p.fLen, p.fBrd) / 2) html += '<div class="hs-warn">The HiRISE area is large compared with the building, so the scan uses coarse cells.</div>';
    html += '<button id="hs-next">Next site ▶</button><button id="hs-redo">Rescan</button><button id="hs-size">Change size</button><button id="hs-clear">Clear</button></div>';

    const wire = (root) => {
      root.querySelectorAll('.hs-site').forEach((el) => { el.onclick = () => this.focusSite(d.sites[Number(el.dataset.n)]); });
      root.querySelector('#hs-redo').onclick = () => { this.clearOverlay(); this.scan(); };
      root.querySelector('#hs-size').onclick = () => this.openForm();
      root.querySelector('#hs-clear').onclick = () => this.clearOverlay();
      root.querySelector('#hs-next').onclick = () => this.stepSite(1);
    };
    const ui = this.ctx.ui;
    if (ui?.addPanel) {
      this.panelObj = ui.addPanel({ id: 'buildPotential', title: 'Build potential', dock: 'left', build: (body) => { body.innerHTML = html; wire(body); } });
    } else {
      const box = this.panelEl = document.createElement('div');
      box.style.cssText = 'position:fixed;left:16px;top:130px;width:340px;max-height:75vh;overflow:auto;padding:10px 12px;background:rgba(0,0,0,.82);border:1px solid rgba(255,255,255,.3);border-radius:8px;z-index:1000';
      box.innerHTML = '<div style="font-weight:600;color:#fff;margin-bottom:4px">Build potential</div>' + html;
      document.body.appendChild(box); wire(box);
    }
  }

  removePanel() {
    if (this.panelObj) { this.ctx.ui?.removePanel?.('buildPotential'); this.panelObj = null; }
    this.panelEl?.remove(); this.panelEl = null;
  }

  groundAt(x, z) { return this.terrain?.sampleWorld?.(x, z) ?? 0; }

  /* ===================== FLY MODE (own camera, creative-mode flying) =====================
     CharacterModule (Astro) keeps its own job. While fly mode is on, THIS module draws the full-screen
     view from its own camera and puts the map camera in the corner (same box as Astro's minimap).
     Press G (or the button) to switch back to Astro's view. MapPickModule is not touched. */

  flyLive() {
    return this.fly.on && this.state === 'done' && !!this.last && this.ctx.state.get('mode') === 'world';
  }

  installRender() {
    if (this.wrap) return;
    const r = this.ctx.renderer, prev = r.render;
    this.prevRender = prev;
    this.wrap = (scene, camera) => {
      if (this._in || camera !== this.ctx.camera || !this.flyLive()) return prev.call(r, scene, camera);
      this._in = true;
      try { this.drawFly((sc, cm) => prev.call(r, sc, cm), scene, camera); } finally { this._in = false; }
    };
    r.render = this.wrap;
  }
  removeRender() {
    const r = this.ctx.renderer;
    if (this.wrap && r && r.render === this.wrap) r.render = this.prevRender;
    this.wrap = null;                                           // if someone wrapped on top of us, the wrapper just passes through
  }

  startFly() {
    if (!this.last) return;
    this.installRender();
    this.fly.on = true;
    if (!this.flyCam.userData.lodOn) {
      this.flyCam.userData.ringRadius = FLY_RING_R;                    // full-detail circle around the fly camera, metres
      this.flyCam.userData.ringHeight = FLY_RING_H;
      lodViews.push(this.flyCam); this.flyCam.userData.lodOn = true;
    }
    this._last = performance.now();
    if (this.last.sites.length) this.focusSite(this.last.sites[Math.max(0, this.siteIdx)]);
    else {
      const c = this.last, f = this.fly, x = c.x0 + (c.cols * c.dx) / 2, z = c.z0 + (c.rows * c.dz) / 2;
      f.x = x; f.z = z + 500; f.y = this.groundAt(x, z) + 500; f.pitch = FLY_PITCH0;
    }
    this.updateNav();
  }
  stopFly() {
    this.fly.on = false;
    this.look = null;
    if (this.flyCam?.userData.lodOn) {
      const k = lodViews.indexOf(this.flyCam);
      if (k >= 0) lodViews.splice(k, 1);
      this.flyCam.userData.lodOn = false;
    }
    this.updateNav();
  }
  toggleFly() { if (this.fly.on) this.stopFly(); else this.startFly(); }

  // keys -> flyCam (called once per frame from the render wrapper)
  updateFly() {
    const f = this.fly, k = this.navKeys, c = this.flyCam;
    const now = performance.now(), dt = Math.min(0.1, (now - (this._last || now)) / 1000);
    this._last = now;
    const any = (...n) => n.some((x) => k.has(x));
    if (k.has('ArrowLeft')) f.yaw += FLY_TURN * dt;
    if (k.has('ArrowRight')) f.yaw -= FLY_TURN * dt;
    if (k.has('ArrowUp')) f.pitch += FLY_TURN * dt;
    if (k.has('ArrowDown')) f.pitch -= FLY_TURN * dt;
    f.pitch = clamp(f.pitch, -1.5, 1.5);
    const fw = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const sd = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const up = (any('Space', 'Equal', 'NumpadAdd') ? 1 : 0) - (any('ShiftLeft', 'ShiftRight', 'Minus', 'NumpadSubtract') ? 1 : 0);
    const h = Math.max(15, f.y - this.groundAt(f.x, f.z));
    if (fw || sd) {
      const sp = (clamp(h * 0.8, 12, 3000) * dt) / Math.hypot(fw, sd), sin = Math.sin(f.yaw), cos = Math.cos(f.yaw);
      f.x += (-sin * fw + cos * sd) * sp;                       // forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw): level flight, like creative mode
      f.z += (-cos * fw - sin * sd) * sp;
    }
    if (up) f.y += up * clamp(h * 0.8, 12, 2000) * dt;
    const g = this.groundAt(f.x, f.z);
    if (f.y < g + 4) f.y = g + 4;                                // never inside the ground
    c.position.set(f.x, f.y, f.z);
    c.rotation.set(f.pitch, f.yaw, 0);
  }

  drawFly(render, scene, mapCam) {
    const r = this.ctx.renderer, size = r.getSize(this._v2 || (this._v2 = new THREE.Vector2()));
    this.updateFly();
    const c = this.flyCam;
    c.aspect = size.x / size.y;
    c.userData.viewHeight = size.y * r.getPixelRatio();
    c.updateProjectionMatrix();
    const fog = scene.fog, dens = fog?.density;
    if (fog) fog.density = 0;                                    // clear air for planning (same as the map view)
    try {
      render(scene, c);                                          // 1) full-screen fly view
      // 2) the map in the corner (a copy of the map camera, so Astro's wrapper does not take it over)
      const w = Math.min(MINI_W, size.x * 0.4), h = Math.round((w * MINI_H) / MINI_W);
      const x = size.x - w - MINI_MARGIN, y = size.y - h - MINI_MARGIN;
      const m = this.mapCam;
      m.copy(mapCam, false); m.aspect = w / h; m.updateProjectionMatrix();
      const vp = r.getViewport(this._vp || (this._vp = new THREE.Vector4())), sc = r.getScissor(this._sc || (this._sc = new THREE.Vector4())), st = r.getScissorTest(), ac = r.autoClear;
      r.setScissorTest(true); r.setViewport(x, y, w, h); r.setScissor(x, y, w, h); r.autoClear = true;
      render(scene, m);
      r.setViewport(vp); r.setScissor(sc); r.setScissorTest(st); r.autoClear = ac;
      const rect = r.domElement.getBoundingClientRect();
      this.ctx.miniRect = { left: rect.right - w - MINI_MARGIN, top: rect.top + MINI_MARGIN, width: w, height: h };
    } finally { if (fog) fog.density = dens; }
  }

  /* ===================== next site ===================== */

  focusSite(s) {
    const f = this.fly;
    const gy = this.groundAt(s.wx, s.wz);
    const H0 = clamp(Math.max(s.lenM, s.brdM) * 1.4, 80, 1200);     // hover a bit above the site: it fills about a third of the view
    const Hc = f.y - this.groundAt(f.x, f.z);
    const H = f.on && this.siteIdx >= 0 && Hc > 10 ? Hc : H0;       // after the first jump keep the height you chose
    if (!f.on || f.pitch > -0.35) f.pitch = FLY_PITCH0;
    const off = H / Math.tan(-f.pitch);                             // stand back so the site is in the middle of the screen
    f.x = s.wx + Math.sin(f.yaw) * off; f.z = s.wz + Math.cos(f.yaw) * off; f.y = gy + H;
    if (!f.on) { f.on = true; this.installRender(); }
    this.siteIdx = this.last ? this.last.sites.indexOf(s) : -1;
    this.markSite(s);
    this.updateNav();
  }

  stepSite(dir) {
    const sites = this.last?.sites;
    if (!sites?.length) return;
    const n = sites.length;
    const k = this.siteIdx < 0 ? (dir > 0 ? 0 : n - 1) : (this.siteIdx + dir + n) % n;
    if (!this.fly.on) this.startFly();
    this.focusSite(sites[k]);
  }

  showNav(d) {
    this.removeNav();
    if (!d?.sites.length) return;
    const el = this.navEl = document.createElement('div');
    el.className = 'hs-nav';
    el.innerHTML = `<button class="hs-pv" title="Previous site (P)">◀</button><span class="hs-lbl"></span>` +
      `<button class="hs-nx" title="Next best site (N)">Next site ▶</button>` +
      `<button class="hs-fl" title="Switch between fly view and Astro view (G)"></button>` +
      `<span class="hs-keys">WASD fly · Space up · Shift down · arrows / drag look · G view</span>`;
    const hook = (b, fn) => {
      let t = 0;
      const act = (e) => { e.stopPropagation(); e.preventDefault(); if (performance.now() - t < 350) return; t = performance.now(); fn(); };
      b.addEventListener('pointerdown', act);                    // the map controls may swallow the click, so act on press
      b.addEventListener('click', act);
      for (const ev of ['pointerup', 'mousedown', 'mouseup', 'touchstart', 'wheel']) b.addEventListener(ev, (e) => e.stopPropagation());
    };
    hook(el.querySelector('.hs-pv'), () => this.stepSite(-1));
    hook(el.querySelector('.hs-nx'), () => this.stepSite(1));
    hook(el.querySelector('.hs-fl'), () => this.toggleFly());
    for (const ev of ['pointerdown', 'wheel', 'mousedown']) el.addEventListener(ev, (e) => e.stopPropagation());
    document.body.appendChild(el);
    this.updateNav();
  }
  updateNav() {
    const l = this.navEl?.querySelector('.hs-lbl');
    if (l && this.last) l.textContent = this.siteIdx < 0 ? `${this.last.sites.length} best sites` : `Site ${this.siteIdx + 1} of ${this.last.sites.length}`;
    const b = this.navEl?.querySelector('.hs-fl');
    if (b) b.textContent = this.fly.on ? '🚶 Astro view' : '✈ Fly view';
  }
  removeNav() { this.navEl?.remove(); this.navEl = null; }

  // outline of the selected site, drawn on the terrain so the patch is easy to spot
  markSite(s) {
    this.removeMark();
    const t = this.terrain, d = this.last;
    if (!t || !d) return;
    const hx = (s.w * d.dx) / 2, hz = (s.h * d.dz) / 2;
    const pts = [[s.wx - hx, s.wz - hz], [s.wx + hx, s.wz - hz], [s.wx + hx, s.wz + hz], [s.wx - hx, s.wz + hz], [s.wx - hx, s.wz - hz]];
    const a = new Float32Array(pts.length * 3);
    pts.forEach(([x, z], i) => a.set([x, (t.sampleWorld(x, z) ?? 0) + 3, z], i * 3));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(a, 3));
    this.mark = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffe14a, depthTest: false }));
    this.mark.frustumCulled = false; this.mark.renderOrder = 997;
    this.group.add(this.mark);
  }
  removeMark() {
    if (!this.mark) return;
    this.group.remove(this.mark); this.mark.geometry.dispose(); this.mark.material.dispose(); this.mark = null;
  }

  navKey(e, down) {
    const code = e.code;
    if (!down) {
      if (this.navKeys.delete(code) && this.flyLive()) e.stopPropagation();     // Astro never saw the key go down, so it must not see it go up
      return;
    }
    if (this.state !== 'done' || !this.last || this.overlay?.classList.contains('hs-open')) return;
    const tg = e.target, tag = tg?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tg?.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (code === 'KeyN' || code === 'KeyP' || code === 'KeyG') {
      e.stopPropagation();
      if (!e.repeat) { if (code === 'KeyG') this.toggleFly(); else this.stepSite(code === 'KeyN' ? 1 : -1); }
      return;
    }
    if (!this.flyLive() || !FLY_CODES.includes(code)) return;
    e.preventDefault(); e.stopPropagation();                      // keep Astro (WASD / arrows / Shift) from also walking
    this.navKeys.add(code);
  }

  dispose() {
    (this._offs || []).forEach((f) => typeof f === 'function' && f());
    this.ctx.bus.off?.('build:open', this.onOpen);
    this.ctx.bus.off?.('world:recentered', this.onRecenter);
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onBlur);
    this.stopFly();
    this.removeRender();
    this.ctx.renderer?.domElement?.removeEventListener('pointerdown', this.onLookDown);
    window.removeEventListener('pointermove', this.onLookMove);
    window.removeEventListener('pointerup', this.onLookUp);
    this.clearOverlay();
    this.overlay?.remove();
    document.getElementById('hs-style')?.remove();
    this.ctx.scene.remove(this.group);
    super.dispose();
  }
}
