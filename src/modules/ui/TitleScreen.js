import * as THREE from 'three';
import { Module } from '../../core/Module.js';

/* =====================================================================
   TitleScreen.js
   Title page (MARS) -> "Choose your path" page -> existing Mars Scout map.
   The look (CSS + markup) is copied from the standalone HTML page.
   Sound controls are built in here, so SoundControls.js is no longer needed.

   Put these two files in  public/audio/ :   music.mp3   click.wav

   The title backdrop is a slowly spinning, realistic Mars globe built from the SAME global height tiles the
   map uses (public/tiles/global). Everything for it is in this file (see "GLOBE" below).
   ===================================================================== */

const MUSIC_URL = '/audio/music.mp3';
const CLICK_URL = '/audio/click.wav';
const TILES_URL = (import.meta.env.VITE_TILES_URL ?? `${import.meta.env.BASE_URL}tiles/`).replace(/\/?$/, '/');

/* =====================================================================
   GLOBE  (settings, tile loading, baking, shaders)
   ===================================================================== */

const GLOBE = {
  texWidth: 4096,                 // widest height grid to build (pixels). 2048 downloads ~4x less data but looks softer
  relief: 12,                     // hill-shading exaggeration (real Mars is very flat at planet scale)
  spin: 0.03,                     // radians per second
  sun: [1.0, 0.42, 0.55],         // direction of the sun in the scene
  ambient: 0.07,                  // light on the night side
  fov: 45,
  startElevation: 0.95,           // camera angle above the equator, radians (bigger = looking more down onto the pole)
  startRadius: 1.9,               // camera distance in globe radii (smaller = closer)
};

// ===== globe bake (pure, no three.js) BEGIN =====
const RM = 3396190;               // Mars radius, metres (same as WorldModule)
const D2R_G = Math.PI / 180;
const SMAX = 0.1;                 // slopes are stored in a byte covering +-SMAX (rise / run)

// choose a level of the tile pyramid
function planLevel(idx, wantW) {
  const f = Math.abs(idx.bbox[0]) > 400 || Math.abs(idx.bbox[3]) > 400 ? 1 / RM / D2R_G : 1;   // metres -> degrees
  const res = Math.abs(idx.pixelSize) * f;
  const first = idx.minLevel ?? 0;
  let L = idx.levels.length - 1;                                   // fall back to the coarsest level
  for (let i = first; i < idx.levels.length; i++) if (idx.levels[i].cols <= wantW) { L = i; break; }
  const lv = idx.levels[L];
  return {
    L, lv, S: idx.tileCells, V: idx.verts,
    lon0: idx.bbox[0] * f, lat0: idx.bbox[3] * f, dl: lv.step * res,
    cols: lv.cols, rows: lv.rows,
    tilesX: lv.tilesX ?? Math.ceil((lv.cols - 1) / idx.tileCells),
    tilesY: lv.tilesY ?? Math.ceil((lv.rows - 1) / idx.tileCells),
  };
}

// One .bin tile -> Float32Array of metres (NaN = no data), or null. Same format as WorldModule.fetchHeights.
async function fetchTile(base, L, x, y, V, fetchFn = fetch) {
  const res = await fetchFn(`${base}${L}/${x}_${y}.bin`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength !== 8 + V * V * 2) return null;               // e.g. the dev server answering with index.html
  const dv = new DataView(buf);
  const lo = dv.getFloat32(0, true), hi = dv.getFloat32(4, true);
  const q = new Uint16Array(buf, 8, V * V);
  const k = (hi - lo) / 65534;
  const h = new Float32Array(V * V);
  for (let i = 0; i < h.length; i++) { const v = q[i]; h[i] = v === 0 ? NaN : lo + (v - 1) * k; }
  return h;
}

async function loadHeights(base, idx, wantW, { fetchFn = fetch, onProgress, parallel = 8 } = {}) {
  const p = planLevel(idx, wantW);
  const { L, S, V, cols, rows, tilesX, tilesY } = p;
  const h = new Float32Array(cols * rows).fill(NaN);
  const jobs = [];
  for (let y = 0; y < tilesY; y++) for (let x = 0; x < tilesX; x++) jobs.push([x, y]);
  let done = 0, got = 0, next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [x, y] = jobs[next++];
      let t = null;
      try { t = await fetchTile(base, L, x, y, V, fetchFn); } catch (e) { /* leave this tile empty */ }
      if (t) {
        got++;
        for (let r = 0; r < V; r++) {
          const gr = y * S + r; if (gr >= rows) break;
          for (let c = 0; c < V; c++) {
            const gc = x * S + c; if (gc >= cols) break;
            h[gr * cols + gc] = t[r * V + c];
          }
        }
      }
      onProgress?.(++done / jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));
  if (!got) throw new Error(`no tiles found at ${base}${L}/ (checked ${jobs.length})`);
  return { ...p, h, tiles: jobs.length, got };
}

const RAMP = [            // metres, sRGB.  dark lowlands -> rust -> tan highlands -> pale volcano summits
  [-9000, [52, 30, 24]], [-4000, [84, 48, 34]], [0, [138, 80, 52]],
  [3000, [172, 112, 74]], [8000, [204, 158, 114]], [20000, [232, 212, 190]],
];
const E_MIN = -9000, E_MAX = 21000, LUT_N = 2048;
const RAMP_LUT = (() => {
  const lut = new Uint8Array(LUT_N * 3);
  for (let i = 0; i < LUT_N; i++) {
    const e = E_MIN + (i / (LUT_N - 1)) * (E_MAX - E_MIN);
    let k = 0; while (k < RAMP.length - 2 && e > RAMP[k + 1][0]) k++;
    const [e0, c0] = RAMP[k], [e1, c1] = RAMP[k + 1];
    const t = Math.max(0, Math.min(1, (e - e0) / (e1 - e0)));
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(c0[c] + (c1[c] - c0[c]) * t);
  }
  return lut;
})();

// geology.json legend -> class per unit index: 1 = ice cap, 2 = other polar deposits, 3 = polar dunes (dark)
function geoClasses(meta) {
  const cls = new Uint8Array(256);
  for (const e of meta?.legend ?? []) {
    const n = (e.name || '').toLowerCase();
    cls[e.index] = n.includes('polar cap') ? 1 : n.includes('polar dune') ? 3 : n.includes('polar') ? 2 : 0;
  }
  return cls;
}

const mixc = (a, b, t) => a + (b - a) * t;

// h: Float32Array (cols*rows) heights in metres. geo (optional): { w, h, data: Uint8Array unit indices, cls }
// Returns two RGBA images: albedo (colour from elevation + ice) and slope (east/north slope in R/G).
function bake({ h, cols, rows, lon0, lat0, dl, geo = null }) {
  const alb = new Uint8Array(cols * rows * 4), slp = new Uint8Array(cols * rows * 4);
  const wrap = cols * dl >= 359;                                   // the map goes all the way round
  const mPerDeg = D2R_G * RM, dy = dl * mPerDeg;
  let gcol = null;
  if (geo) {
    gcol = new Int32Array(cols);
    for (let i = 0; i < cols; i++) {
      let u = (((lon0 + i * dl) + 180) / 360) % 1; if (u < 0) u += 1;
      gcol[i] = Math.min(geo.w - 1, Math.floor(u * geo.w));
    }
  }
  for (let j = 0; j < rows; j++) {
    const lat = lat0 - j * dl;
    const dx = dl * mPerDeg * Math.max(0.2, Math.cos(lat * D2R_G));  // metres per pixel along the row (floored near the poles)
    const gy = geo ? Math.max(0, Math.min(geo.h - 1, Math.floor(((90 - lat) / 180) * geo.h))) : 0;
    const jn = Math.max(0, j - 1), js = Math.min(rows - 1, j + 1);
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i, o = k * 4;
      const hc = h[k];
      let sx = 0, sy = 0;
      if (hc === hc) {
        let ie = i + 1, iw = i - 1;
        if (wrap) { if (ie >= cols) ie = 0; if (iw < 0) iw = cols - 1; } else { ie = Math.min(cols - 1, ie); iw = Math.max(0, iw); }
        let he = h[j * cols + ie], hw = h[j * cols + iw], hn = h[jn * cols + i], hs = h[js * cols + i];
        if (he !== he) he = hc; if (hw !== hw) hw = hc; if (hn !== hn) hn = hc; if (hs !== hs) hs = hc;
        sx = (he - hw) / (2 * dx);
        sy = (hn - hs) / (2 * dy);
      }
      const e = hc === hc ? hc : 0;
      const li = Math.max(0, Math.min(LUT_N - 1, Math.round(((e - E_MIN) / (E_MAX - E_MIN)) * (LUT_N - 1)))) * 3;
      let r = RAMP_LUT[li], g = RAMP_LUT[li + 1], b = RAMP_LUT[li + 2];
      if (geo) {
        const c = geo.cls[geo.data[gy * geo.w + gcol[i]]];
        if (c === 1) { r = mixc(r, 246, 0.92); g = mixc(g, 243, 0.92); b = mixc(b, 238, 0.92); }          // ice cap
        else if (c === 2) { r = mixc(r, 214, 0.3); g = mixc(g, 190, 0.3); b = mixc(b, 168, 0.3); }         // layered polar deposits
        else if (c === 3) { r = mixc(r, 44, 0.55); g = mixc(g, 28, 0.55); b = mixc(b, 24, 0.55); }         // dark dunes ring
      }
      alb[o] = r; alb[o + 1] = g; alb[o + 2] = b; alb[o + 3] = 255;
      slp[o] = Math.round(Math.max(0, Math.min(1, 0.5 + sx / (2 * SMAX))) * 255);
      slp[o + 1] = Math.round(Math.max(0, Math.min(1, 0.5 + sy / (2 * SMAX))) * 255);
      slp[o + 2] = 128; slp[o + 3] = 255;
    }
  }
  return { albedo: alb, slope: slp, cols, rows, lon0, lat0, dl, wrap };
}
// ===== globe bake (pure, no three.js) END =====

const GLOBE_VERT = `
varying vec3 vP;
void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const GLOBE_FRAG = `
precision highp float;
uniform sampler2D uAlbedo, uSlope;
uniform float uLon0, uLat0, uDl, uRelief, uAmbient, uSmax;
uniform vec2 uSize;
uniform vec3 uSunObj;
varying vec3 vP;
const float PI = 3.14159265358979;
void main() {
  vec3 p = normalize(vP);
  float lat = asin(clamp(p.y, -1.0, 1.0));
  float lon = atan(-p.z, p.x);
  vec2 uv = vec2(((lon * 180.0 / PI - uLon0) / uDl + 0.5) / uSize.x,
                 ((uLat0 - lat * 180.0 / PI) / uDl + 0.5) / uSize.y);
  vec3 alb = pow(texture2D(uAlbedo, uv).rgb, vec3(2.2));
  vec2 s = (texture2D(uSlope, uv).rg - 0.5) * 2.0 * uSmax;
  float cl = cos(lat), sl = sin(lat), cn = cos(lon), sn = sin(lon);
  vec3 east = vec3(-sn, 0.0, -cn);
  vec3 north = vec3(-sl * cn, cl, sl * sn);
  vec3 n = normalize(p - uRelief * (s.x * east + s.y * north));
  float term = smoothstep(-0.08, 0.22, dot(p, uSunObj));          // day / night edge from the smooth sphere
  float diff = max(dot(n, uSunObj), 0.0);                          // relief shading from the bumped normal
  vec3 col = alb * (uAmbient + 1.25 * diff * term);
  gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
`;

const ATM_VERT = `
varying vec3 vN; varying vec3 vNW;
void main() {
  vN = normalize(normalMatrix * normal);
  vNW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const ATM_FRAG = `
uniform vec3 uSunW;
varying vec3 vN; varying vec3 vNW;
void main() {
  float rim = pow(max(0.0, 0.72 - dot(vN, vec3(0.0, 0.0, 1.0))), 3.0);
  float lit = 0.3 + 0.7 * clamp(dot(vNW, uSunW) * 0.5 + 0.55, 0.0, 1.0);
  gl_FragColor = vec4(vec3(0.95, 0.62, 0.42) * rim * lit, rim * lit);
}
`;

const dataTex = (data, w, h) => {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.wrapS = THREE.RepeatWrapping;               // longitude wraps round the planet
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
};
const flatTex = (r, g, b) => dataTex(new Uint8Array([r, g, b, 255]), 1, 1);

// A slowly spinning Mars of radius 1, lit by a real sun.
class GlobeBackdrop {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.sunW = new THREE.Vector3(...GLOBE.sun).normalize();
    this.yAxis = new THREE.Vector3(0, 1, 0);

    // until the tiles arrive: a plain rust-coloured ball (also what stays if loading fails)
    this.uniforms = {
      uAlbedo: { value: flatTex(150, 88, 56) }, uSlope: { value: flatTex(128, 128, 128) },
      uLon0: { value: -180 }, uLat0: { value: 90 }, uDl: { value: 1 }, uSize: { value: new THREE.Vector2(1, 1) },
      uSunObj: { value: this.sunW.clone() }, uRelief: { value: GLOBE.relief }, uAmbient: { value: GLOBE.ambient },
      uSmax: { value: SMAX },
    };
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 192, 128),
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: GLOBE_VERT, fragmentShader: GLOBE_FRAG }),
    );
    this.atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.05, 96, 64),
      new THREE.ShaderMaterial({
        uniforms: { uSunW: { value: this.sunW } }, vertexShader: ATM_VERT, fragmentShader: ATM_FRAG,
        side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
      }),
    );

    // stars
    const n = 1600, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2, y = Math.random() * 2 - 1, r = Math.sqrt(1 - y * y);
      pos.set([80 * r * Math.cos(th), 80 * y, 80 * r * Math.sin(th)], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({
      color: 0xe8ecff, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.85, depthWrite: false,
    }));
    this.stars.frustumCulled = false;

    scene.add(this.stars, this.mesh, this.atmosphere);
    this.disposed = false;
  }

  // Loads tiles/global/index.json, the height tiles and (optionally) overlays/geology.* , then swaps in the real ground.
  async load(tilesUrl) {
    const base = tilesUrl + 'global/';
    const res = await fetch(base + 'index.json');
    if (!res.ok) throw new Error(`${base}index.json -> HTTP ${res.status}`);
    const idx = await res.json();

    const wantW = Math.min(GLOBE.texWidth, this.renderer.capabilities.maxTextureSize || 4096);
    const t0 = performance.now();
    const g = await loadHeights(base, idx, wantW);
    if (this.disposed) return;
    const t1 = performance.now();

    let geo = null;
    try { geo = await this.loadGeology(tilesUrl); } catch (e) { console.info('[globe] no geology map, ice caps skipped:', e.message); }
    if (this.disposed) return;

    const b = bake({ ...g, geo });
    const albedo = dataTex(b.albedo, b.cols, b.rows), slope = dataTex(b.slope, b.cols, b.rows);
    if (!b.wrap) albedo.wrapS = slope.wrapS = THREE.ClampToEdgeWrapping;
    const old = [this.uniforms.uAlbedo.value, this.uniforms.uSlope.value];
    this.uniforms.uAlbedo.value = albedo;
    this.uniforms.uSlope.value = slope;
    this.uniforms.uLon0.value = b.lon0;
    this.uniforms.uLat0.value = b.lat0;
    this.uniforms.uDl.value = b.dl;
    this.uniforms.uSize.value.set(b.cols, b.rows);
    old.forEach((t) => t.dispose());
    console.log(`[globe] ready: level ${g.L}, ${b.cols}x${b.rows}, ${g.got}/${g.tiles} tiles, ` +
      `download ${Math.round(t1 - t0)} ms, bake ${Math.round(performance.now() - t1)} ms, geology ${geo ? 'yes' : 'no'}`);
  }

  async loadGeology(tilesUrl) {
    const m = await fetch(tilesUrl + 'overlays/geology.json');
    if (!m.ok) throw new Error('geology.json missing');
    const meta = await m.json();
    const p = await fetch(tilesUrl + 'overlays/geology.png');
    if (!p.ok) throw new Error('geology.png missing');
    const bmp = await createImageBitmap(await p.blob());
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const rgba = g.getImageData(0, 0, c.width, c.height).data;
    const data = new Uint8Array(c.width * c.height);
    for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4];
    return { w: c.width, h: c.height, data, cls: geoClasses(meta) };
  }

  update(dt, spin = true) {
    if (spin) this.mesh.rotation.y += GLOBE.spin * dt;
    // the sun in the globe's own frame, so the light stays put while the ground turns under it
    this.uniforms.uSunObj.value.copy(this.sunW).applyAxisAngle(this.yAxis, -this.mesh.rotation.y);
  }

  dispose() {
    this.disposed = true;
    this.scene.remove(this.mesh, this.atmosphere, this.stars);
    this.mesh.geometry.dispose(); this.mesh.material.dispose();
    this.atmosphere.geometry.dispose(); this.atmosphere.material.dispose();
    this.stars.geometry.dispose(); this.stars.material.dispose();
    this.uniforms.uAlbedo.value.dispose(); this.uniforms.uSlope.value.dispose();
  }
}

/* ---------- real Mars sun / sol-time maths (Mars24, Allison & McEwen 2000) ---------- */

const SITE_LAT = 18.48807;   // degrees north
const SITE_LON = 77.40344;   // degrees east

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const mod = (x, n) => ((x % n) + n) % n;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const SOL_DAYS = 1.0274912517;
const PBS = [
  [0.0071, 2.2353, 49.409], [0.0057, 2.7543, 168.173], [0.0039, 1.1177, 191.837],
  [0.0037, 15.7866, 21.736], [0.0021, 2.1354, 15.704], [0.0020, 2.4694, 95.528],
  [0.0018, 32.8493, 49.095],
];

function marsSolarState(ms, latDeg, lonEastDeg) {
  const jdTT = ms / 86400000 + 2440587.5 + 69.184 / 86400;
  const dt = jdTT - 2451545.0;
  const M = mod(19.3871 + 0.52402073 * dt, 360);
  const fms = 270.3863 + 0.52403840 * dt;

  let pbs = 0;
  for (const [A, tau, phi] of PBS) pbs += A * Math.cos((0.985626 * dt / tau + phi) * D2R);

  const eqc =
    (10.691 + 3.0e-7 * dt) * Math.sin(M * D2R) +
    0.623 * Math.sin(2 * M * D2R) +
    0.050 * Math.sin(3 * M * D2R) +
    0.005 * Math.sin(4 * M * D2R) +
    0.0005 * Math.sin(5 * M * D2R) + pbs;

  const ls = mod(fms + eqc, 360);
  const eot = 2.861 * Math.sin(2 * ls * D2R) - 0.071 * Math.sin(4 * ls * D2R) +
    0.002 * Math.sin(6 * ls * D2R) - eqc;
  const msd = (jdTT - 2405522.0028779) / SOL_DAYS;
  const ltst = mod(mod(mod(msd, 1) * 24 + lonEastDeg / 15, 24) + eot / 15, 24);

  const sinLs = Math.sin(ls * D2R);
  const dec = Math.asin(0.42565 * sinLs) * R2D + 0.25 * sinLs;
  const H = (ltst - 12) * 15 * D2R;
  const lat = latDeg * D2R;
  const d = dec * D2R;
  const sinE = Math.sin(lat) * Math.sin(d) + Math.cos(lat) * Math.cos(d) * Math.cos(H);
  const elev = Math.asin(clamp(sinE, -1, 1)) * R2D;

  return { ls, ltst, elev };
}

const fmtHour = (h) => {
  const m = Math.floor(h * 60 + 1e-9) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
};

/* ---------- markup ---------- */

const ICON = {
  explore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
  about: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.5a3 3 0 010 5M18 14.5c1.8.7 3 2.5 3 5.5"/></svg>',
  refs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z"/><path d="M4 21V5M9 8h6M9 12h6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/><path d="M11 8.5v5M8.5 11h5"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
};

const TICKER_ITEMS = [
  'Olympus Mons · 21.9 km high · tallest volcano in the solar system',
  'Valles Marineris · about 4,000 km long',
  'One sol lasts 24 h 39 min',
  'Atmosphere is about 95% carbon dioxide',
  'Surface pressure is under 1% of Earth’s',
  'Two small moons · Phobos &amp; Deimos',
  'Martian sunsets glow blue',
  'A year lasts 687 Earth days',
];
const TICKER_HTML = TICKER_ITEMS.map((t) => '<span>' + t + '</span>').join('');

const TITLE_HTML = `
  <canvas id="mars-title-canvas"></canvas>

  <div class="ttl-root" id="mars-title">
    <header class="ttl-top">
      <div class="ttl-brand"><i></i>Mars Explorer</div>
      <div class="ttl-pills">
        <div class="ttl-pill"><i class="ttl-dot"></i>Live sol time <b id="mars-top-sol">--:--</b></div>
        <div class="ttl-pill">Global relief</div>
        <div class="ttl-pill">Dust &amp; haze</div>
      </div>
    </header>

    <div class="ttl-eyebrow">Interactive terrain</div>
    <h1 class="ttl-title">MARS</h1>
    <p class="ttl-sub">Explore the surface in HiRISE detail</p>
    <p class="ttl-blurb">A slowly turning relief globe of Mars, built from real elevation data. Drag to look around and scroll to zoom.</p>
    <div class="ttl-feats"><span>Orbit camera</span><span>Dust &amp; haze</span><span>Free camera</span></div>

    <div class="ttl-menu">
      <button class="ttl-card ttl-hero" id="mars-start">
        <span class="ttl-ico">${ICON.explore}</span>
        <span class="ttl-more">Launch <i>›</i></span>
        <span class="ttl-tx"><span class="ttl-ct">Explore</span><span class="ttl-cd">Fly over the surface and choose your path</span></span>
      </button>
      <button class="ttl-card" id="mars-settings">
        <span class="ttl-ico">${ICON.settings}</span>
        <span class="ttl-more">Tweak <i>›</i></span>
        <span class="ttl-tx"><span class="ttl-ct">Settings</span><span class="ttl-cd">Camera rotation and distance</span></span>
      </button>
      <button class="ttl-card" id="mars-about">
        <span class="ttl-ico">${ICON.about}</span>
        <span class="ttl-more">View more <i>›</i></span>
        <span class="ttl-tx"><span class="ttl-ct">About us</span><span class="ttl-cd">Meet Team Astral Odyssey</span></span>
      </button>
      <button class="ttl-card" id="mars-refs">
        <span class="ttl-ico">${ICON.refs}</span>
        <span class="ttl-more">View more <i>›</i></span>
        <span class="ttl-tx"><span class="ttl-ct">References</span><span class="ttl-cd">Data, papers and tools we relied on</span></span>
      </button>
    </div>

    <aside class="ttl-facts" aria-label="Mars fact file">
      <div class="ttl-eyebrow" style="margin:0">Fact file</div>
      <h2>The Red Planet</h2>
      <p>A cold desert world painted by iron-rich dust. Mars is home to Olympus Mons, the tallest volcano in the solar system, and Valles Marineris, a canyon system that stretches as wide as the continental US.</p>
      <div class="ttl-grid">
        <div class="ttl-stat"><b>Distance from Sun</b><span>227.9<small>million km</small></span></div>
        <div class="ttl-stat"><b>Radius</b><span>3,390<small>km</small></span></div>
        <div class="ttl-stat"><b>Length of day</b><span>24h 39m<small>1 sol</small></span></div>
        <div class="ttl-stat"><b>Length of year</b><span>687<small>Earth days</small></span></div>
        <div class="ttl-stat"><b>Gravity</b><span>3.72<small>m/s²</small></span></div>
        <div class="ttl-stat"><b>Avg. temperature</b><span>−63<small>°C</small></span></div>
      </div>
      <div class="ttl-live"><i class="ttl-dot"></i><span id="mars-live-txt">Site sol time --:--</span></div>
      <div class="ttl-moons"><span>Phobos</span><span>Deimos</span><span>CO₂ atmosphere</span></div>
    </aside>

    <div class="ttl-ticker"><div class="ttl-track">${TICKER_HTML}${TICKER_HTML}</div></div>
  </div>

  <!-- PAGE 2 -->
<div class="pg-page ttl-hidden" id="mars-page2">
  <button class="pg-back" id="mars-back" aria-label="Back to title"><span class="pg-arr">${ICON.back}</span>Back</button>
  <div class="ttl-eyebrow">Step 2</div>
  <h2 class="pg-title">Choose your path</h2>
  <p class="pg-sub">Pick how you want to explore Mars.</p>
  <div class="pg-grid">
    <button class="ttl-card" id="mars-coordinates">
      <span class="ttl-ico">${ICON.search}</span>
      <span class="ttl-tx"><span class="ttl-ct">Search by coordinates</span><span class="ttl-cd">Enter a latitude and longitude on Mars</span></span>
      <span class="ttl-more">Open <i>›</i></span>
      <img class="ttl-bg" src="/ui/search_by_mineral.jpeg" alt="" loading="lazy" draggable="false">
    </button>
    <button class="ttl-card" id="mars-landmarks">
      <span class="ttl-ico">${ICON.pin}</span>
      <span class="ttl-tx"><span class="ttl-ct">Search by landmarks</span><span class="ttl-cd">Jump to named craters, volcanoes and canyons</span></span>
      <span class="ttl-more">Open <i>›</i></span>
      <img class="ttl-bg" src="/ui/search_by_landmark.jpeg" alt="" loading="lazy" draggable="false">
    </button>
    <button class="ttl-card" id="mars-targets">
      <span class="ttl-ico">${ICON.target}</span>
      <span class="ttl-tx"><span class="ttl-ct">Search by scientific targets</span><span class="ttl-cd">Explore minerals and sites of scientific interest</span></span>
      <span class="ttl-more">Open <i>›</i></span>
      <img class="ttl-bg" src="/ui/search_by_coordinates.jpeg" alt="" loading="lazy" draggable="false">
    </button>
  </div>
</div>

  <!-- DIALOGS (Settings / About / References) -->
  <div class="ttl-overlay" id="mars-overlay"><div class="ttl-panel" id="mars-panel"></div></div>
`;

const SOUND_HTML = `
<div class="snd-grp" id="marsMusicGrp">
  <button id="marsSndBtn" type="button" aria-pressed="false" aria-label="Turn music on" title="Background music on/off">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path class="wave" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/><path class="mute" d="m16 9 5 6m0-6-5 6"/></svg>
    <span id="marsSndTxt" class="snd-sr">Music off</span>
  </button>
  <input id="marsMusicVol" class="snd-vol" type="range" min="0" max="100" step="1" value="50" aria-label="Music volume" title="Music volume">
  <span id="marsMusicCap" class="snd-cap">Music 50%</span>
</div>
<div class="snd-grp" id="marsClkGrp">
  <button id="marsClkBtn" class="on" type="button" aria-pressed="true" aria-label="Turn click sound off" title="Click sound on/off">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 8l12 4.5-5 1.8-1.8 5L8 8z"/><path class="wave" d="M8 3v2M3 8h2M4.6 4.6l1.4 1.4"/><path class="mute" d="M3 3l18 18"/></svg>
    <span id="marsClkTxt" class="snd-sr">Click sound on</span>
  </button>
  <input id="marsClkVol" class="snd-vol" type="range" min="0" max="100" step="1" value="84" aria-label="Click sound volume" title="Click sound volume">
  <span id="marsClkCap" class="snd-cap">Clicks 84%</span>
</div>
`;

export class TitleScreenModule extends Module {
  static id = 'titleScreen';
  static requires = [];

  async init() {
    this.active = true;
    this.started = false;
    this.page = 'title';
    this.autoRotate = true;
    this.lastSolText = '';

    this.createStyles();
    this.createUI();
    this.createSound();
    this.createMarsScene();

    // Coming back from the map: open on "Choose your path" instead of the first page.
    try {
      if (sessionStorage.getItem('marsScoutStartPage') === '2') {
        sessionStorage.removeItem('marsScoutStartPage');
        this.goPage(2);
      }
    } catch (e) { /* storage not available */ }

    document.body.classList.add('title-open');

    // Hide the existing Mars Scout map while the title screen is open.
    const appCanvas = this.ctx.renderer?.domElement;
    if (appCanvas) {
      appCanvas.dataset.marsScoutOriginalVisibility = appCanvas.style.visibility || '';
      appCanvas.style.visibility = 'hidden';
    }

    this.updateClock();
  }

  /* ============================================================
     STYLES (copied from the standalone HTML page)
     ============================================================ */

  createStyles() {
    if (document.getElementById('mars-scout-title-styles')) return;

    const style = document.createElement('style');
    style.id = 'mars-scout-title-styles';
    style.textContent = `/* ---------- title screen ---------- */
.ttl-root{position:fixed;inset:0;z-index:50;display:flex;flex-direction:column;justify-content:center;
  padding:0 clamp(24px,8vw,120px);color:#f4e9e1;
  background:linear-gradient(90deg,rgba(14,8,6,.82) 0%,rgba(14,8,6,.55) 45%,rgba(14,8,6,0) 80%),
             linear-gradient(0deg,rgba(14,8,6,.6) 0%,rgba(14,8,6,0) 35%);
  transition:opacity .6s ease}
.ttl-root{overflow-y:auto;justify-content:safe center}
.ttl-root.ttl-hidden{opacity:0;pointer-events:none}
.ttl-eyebrow{letter-spacing:.35em;font-size:12px;text-transform:uppercase;color:#e0875a;margin-bottom:10px}
.ttl-title{font-size:clamp(56px,11vw,140px);font-weight:800;letter-spacing:.08em;line-height:1;margin:0}
.ttl-sub{font-size:clamp(14px,1.6vw,20px);opacity:.85;margin:14px 0 36px;max-width:30em}
/* ---------- button dock: one straight row of tiles along the bottom ---------- */
.ttl-menu{position:absolute;left:clamp(24px,8vw,120px);right:clamp(24px,6vw,100px);bottom:54px;z-index:2;
  display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr;gap:14px;counter-reset:ttl}
.ttl-card{position:relative;overflow:hidden;font:inherit;color:#f4e9e1;text-align:left;cursor:pointer;min-height:118px;
  display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto 1fr;gap:10px;align-items:start;padding:15px 16px 14px;
  border:1px solid rgba(255,255,255,.16);border-radius:16px;
  background:linear-gradient(180deg,rgba(255,255,255,.11),rgba(255,255,255,.02));
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  box-shadow:0 10px 30px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.14);
  transition:transform .3s cubic-bezier(.2,.8,.2,1),border-color .3s,box-shadow .3s,background .3s,filter .3s;
  animation:ttl-rise .7s cubic-bezier(.2,.8,.2,1) backwards}
.ttl-card:nth-child(2){animation-delay:.08s}.ttl-card:nth-child(3){animation-delay:.16s}.ttl-card:nth-child(4){animation-delay:.24s}
@keyframes ttl-rise{from{opacity:0;transform:translateY(28px)}}
/* glowing light-bar on the top edge that grows on hover */
.ttl-card::before{content:"";position:absolute;top:0;left:16px;width:34px;height:3px;border-radius:0 0 4px 4px;
  background:#f0a47a;box-shadow:0 0 14px 1px #e0875a;transition:width .45s cubic-bezier(.2,.8,.2,1)}
/* oversized outline number as a background mark */
.ttl-card::after{counter-increment:ttl;content:"0" counter(ttl);position:absolute;right:10px;bottom:-16px;pointer-events:none;
  font:800 78px/1 system-ui,sans-serif;color:transparent;-webkit-text-stroke:1px rgba(255,255,255,.14);transition:-webkit-text-stroke-color .3s,transform .4s}
.ttl-card>*{position:relative;z-index:1}
.ttl-card:hover,.ttl-card:focus-visible{outline:none;transform:translateY(-8px);border-color:rgba(240,164,122,.85);
  background:linear-gradient(180deg,rgba(224,135,90,.32),rgba(224,135,90,.06));
  box-shadow:0 20px 42px rgba(0,0,0,.5),0 0 32px rgba(224,135,90,.38),inset 0 1px 0 rgba(255,255,255,.2)}
.ttl-card:hover::before,.ttl-card:focus-visible::before{width:calc(100% - 32px)}
.ttl-card:hover::after,.ttl-card:focus-visible::after{-webkit-text-stroke-color:rgba(240,164,122,.5);transform:translateY(-6px)}
.ttl-card:active{transform:translateY(-3px)}
.ttl-ico{position:relative;width:38px;height:38px;border-radius:11px;display:grid;place-items:center;color:#1a0e09;
  background:linear-gradient(135deg,#ffc9a3,#e0875a);box-shadow:0 4px 14px rgba(224,135,90,.5);transition:transform .35s cubic-bezier(.2,.8,.2,1)}
.ttl-ico svg{width:20px;height:20px}
.ttl-card:hover .ttl-ico{transform:rotate(-8deg) scale(1.1)}
.ttl-more{justify-self:end;align-self:center;font-size:9.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#f0a47a;
  padding:6px 11px;border:1px solid rgba(240,164,122,.55);border-radius:999px;white-space:nowrap;transition:background .25s,color .25s}
.ttl-more i{font-style:normal;display:inline-block;transition:transform .25s}
.ttl-card:hover .ttl-more{background:#f0a47a;color:#1a0e09}
.ttl-card:hover .ttl-more i{transform:translateX(4px)}
.ttl-tx{grid-column:1/-1;align-self:start;display:block}
.ttl-ct{display:block;font-size:16px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
.ttl-cd{display:block;font-size:11.5px;line-height:1.4;opacity:.72;margin-top:4px;max-width:92%}
/* hero tile: Explore */
.ttl-card.ttl-hero{border-color:rgba(255,200,160,.65);
  background:linear-gradient(110deg,transparent 40%,rgba(255,255,255,.3) 50%,transparent 60%) 200% 0/250% 100% no-repeat,
             linear-gradient(135deg,#e0875a 0%,#b5482a 55%,#6b2a3f 100%);
  box-shadow:0 14px 40px rgba(224,135,90,.42),inset 0 1px 0 rgba(255,255,255,.35);animation:ttl-rise .7s cubic-bezier(.2,.8,.2,1) backwards,ttl-shine 3.8s 1s ease-in-out infinite}
@keyframes ttl-shine{0%,40%{background-position:200% 0,0 0}100%{background-position:-100% 0,0 0}}
.ttl-hero::before{background:#fff;box-shadow:0 0 16px 2px rgba(255,255,255,.8)}
.ttl-hero::after{-webkit-text-stroke-color:rgba(255,255,255,.28);font-size:92px}
.ttl-hero .ttl-ico{width:46px;height:46px;border-radius:50%;color:#fff;
  background:radial-gradient(circle at 34% 28%,#ffc9a3 0%,#d9693f 38%,#7a2a22 78%,#3a1216 100%);box-shadow:0 0 22px rgba(255,170,120,.75),inset -6px -8px 12px rgba(0,0,0,.4)}
.ttl-hero .ttl-ico::after{content:"";position:absolute;inset:-6px;border-radius:50%;border:1px solid rgba(255,255,255,.6);
  border-top-color:transparent;border-bottom-color:transparent;animation:ttl-spin 5s linear infinite}
@keyframes ttl-spin{to{transform:rotate(360deg)}}
.ttl-hero:hover .ttl-ico{transform:scale(1.1)}
.ttl-hero .ttl-ct{font-size:24px;font-weight:800;letter-spacing:.2em}
.ttl-hero .ttl-cd{font-size:12.5px;opacity:.95;color:#fff2e8}
.ttl-hero .ttl-more{background:#fff;color:#a8402a;border-color:#fff;font-weight:800;animation:ttl-glow 2s ease-in-out infinite}
@keyframes ttl-glow{50%{box-shadow:0 0 0 7px rgba(255,255,255,.18)}}
.ttl-card.ttl-hero:hover,.ttl-card.ttl-hero:focus-visible{filter:brightness(1.1);
  background:linear-gradient(110deg,transparent 40%,rgba(255,255,255,.3) 50%,transparent 60%) 200% 0/250% 100% no-repeat,linear-gradient(135deg,#e0875a 0%,#b5482a 55%,#6b2a3f 100%);
  box-shadow:0 22px 48px rgba(224,135,90,.55),inset 0 1px 0 rgba(255,255,255,.4)}
.ttl-hero:hover .ttl-more{background:#fff;color:#a8402a}
@media (prefers-reduced-motion:reduce){.ttl-card,.ttl-hero,.ttl-hero .ttl-more,.ttl-hero .ttl-ico::after{animation:none}}
.ttl-blurb{font-size:12.5px;line-height:1.6;opacity:.7;max-width:34em;margin:-18px 0 26px}
.ttl-warn{display:none;margin-top:22px;max-width:30em;padding:10px 14px;border-radius:6px;font-size:13px;
  color:#ffd9b0;background:rgba(160,60,20,.35);border:1px solid rgba(255,160,100,.5)}


/* ---------- right-hand fact panel ---------- */
.ttl-facts{position:absolute;right:clamp(24px,6vw,100px);top:50%;transform:translateY(-50%);width:min(400px,34vw);
  padding:22px;border-radius:22px;color:#f4e9e1;background:linear-gradient(160deg,rgba(30,14,10,.62),rgba(20,10,8,.42));
  border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  box-shadow:0 14px 44px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.12);animation:ttl-rise .8s .3s cubic-bezier(.2,.8,.2,1) both}
.ttl-facts h2{margin:4px 0 8px;font-size:clamp(22px,2.4vw,30px);letter-spacing:.06em}
.ttl-facts p{margin:0 0 16px;font-size:13px;line-height:1.6;opacity:.8}
.ttl-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ttl-stat{padding:11px 12px;border-radius:14px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.10)}
.ttl-stat b{display:block;font-size:10px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#f0a47a;margin-bottom:4px}
.ttl-stat span{font-size:17px;font-weight:600}
.ttl-stat small{font-size:11px;opacity:.65;font-weight:400;margin-left:3px}
.ttl-live{display:flex;align-items:center;gap:10px;margin-top:12px;padding:10px 12px;border-radius:14px;
  background:rgba(224,135,90,.18);border:1px solid rgba(240,154,110,.45);font:12px/1.4 ui-monospace,Menlo,Consolas,monospace}
.ttl-dot{width:8px;height:8px;border-radius:50%;background:#ff8a5c;box-shadow:0 0 0 0 rgba(255,138,92,.7);animation:ttl-ping 1.8s infinite;flex:none}
@keyframes ttl-ping{70%{box-shadow:0 0 0 10px rgba(255,138,92,0)}100%{box-shadow:0 0 0 0 rgba(255,138,92,0)}}
.ttl-moons{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.ttl-moons span{font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:5px 11px;border-radius:20px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.06)}
.ttl-tag{position:absolute;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#fff2e8;padding:6px 12px;border-radius:20px;
  background:rgba(20,10,8,.45);border:1px solid rgba(255,255,255,.25);backdrop-filter:blur(6px);animation:ttl-float 5s ease-in-out infinite}
.ttl-tag::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#ff8a5c;margin-right:8px;vertical-align:middle}
.ttl-tag.t1{right:clamp(24px,6vw,100px);top:11%}
.ttl-tag.t2{right:clamp(220px,26vw,520px);bottom:11%;animation-delay:-2.5s}
@keyframes ttl-float{50%{transform:translateY(-8px)}}
@media (max-width:1000px){.ttl-facts,.ttl-tag{display:none}}
@media (max-height:820px){
  .ttl-title{font-size:clamp(48px,min(11vw,15vh),120px)}
  .ttl-sub{margin:8px 0 20px}.ttl-blurb{display:none}
  .ttl-menu{gap:12px}.ttl-card{padding:8px 12px}.ttl-card.ttl-hero{padding:10px 14px}
  .ttl-cd{font-size:10px}.ttl-facts{padding:16px}.ttl-facts p{margin-bottom:12px}.ttl-tabs{display:none}}


/* keep the fact panel fully on screen on short windows */
.ttl-facts{max-height:calc(100vh - 48px);overflow-y:auto;scrollbar-width:thin}
@media (max-height:900px){
  .ttl-facts{width:min(440px,36vw);padding:14px 16px}
  .ttl-facts h2{font-size:22px;margin:2px 0 6px}
  .ttl-facts p{font-size:12px;line-height:1.5;margin-bottom:10px}
  .ttl-grid{grid-template-columns:repeat(3,1fr);gap:7px}
  .ttl-stat{padding:8px 9px;border-radius:11px}
  .ttl-stat b{font-size:8.5px;letter-spacing:.1em;margin-bottom:2px}
  .ttl-stat span{font-size:14px}.ttl-stat small{display:block;margin:1px 0 0;font-size:10px}
  .ttl-live{margin-top:8px;padding:7px 10px;font-size:11px}
  .ttl-moons{margin-top:8px;gap:6px}.ttl-moons span{font-size:10px;padding:4px 9px}
  .ttl-tag.t2{display:none}.ttl-tag.t1{top:6%}
}
@media (max-height:700px){.ttl-facts p{display:none}.ttl-moons{display:none}}


/* ---------- filled page: top bar, feature pills, ticker ---------- */
.ttl-root{padding-top:78px;padding-bottom:215px}
.ttl-top{position:absolute;top:0;left:0;right:0;height:66px;display:flex;align-items:center;justify-content:space-between;
  padding:0 clamp(24px,6vw,100px) 0 clamp(24px,8vw,120px);background:linear-gradient(180deg,rgba(14,8,6,.7),transparent)}
.ttl-brand{display:flex;align-items:center;gap:12px;font-size:12px;font-weight:700;letter-spacing:.32em;text-transform:uppercase}
.ttl-brand i{width:24px;height:24px;border-radius:50%;background:radial-gradient(circle at 34% 28%,#ffc9a3,#d9693f 40%,#5a1f1a);box-shadow:0 0 16px rgba(224,135,90,.8)}
.ttl-pills{display:flex;gap:10px}
.ttl-pill{display:flex;align-items:center;gap:8px;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;padding:7px 13px;border-radius:20px;
  background:rgba(20,10,8,.45);border:1px solid rgba(255,255,255,.2);backdrop-filter:blur(8px)}
.ttl-pill b{color:#f0a47a;font-weight:700;font-variant-numeric:tabular-nums}
.ttl-pill .ttl-dot{width:7px;height:7px}
.ttl-feats{display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 0;max-width:34em}
.ttl-feats span{font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:6px 12px;border-radius:20px;border:1px solid rgba(240,164,122,.4);background:rgba(224,135,90,.10)}
.ttl-blurb{margin:-18px 0 18px}
.ttl-facts{top:84px;transform:none;max-height:calc(100vh - 84px - 215px)}
.ttl-ticker{position:absolute;left:0;right:0;bottom:0;height:34px;overflow:hidden;display:flex;align-items:center;
  background:rgba(14,8,6,.78);border-top:1px solid rgba(255,255,255,.12)}
.ttl-track{display:flex;flex:none;white-space:nowrap;animation:ttl-scroll 70s linear infinite}
.ttl-track span{font-size:10.5px;letter-spacing:.22em;text-transform:uppercase;opacity:.8;padding-right:28px}
.ttl-track span::after{content:"✦";color:#e0875a;padding-left:28px}
@keyframes ttl-scroll{to{transform:translateX(-50%)}}
@media (max-height:820px){
  .ttl-root{padding-top:70px;padding-bottom:190px}
  .ttl-menu{bottom:48px}.ttl-card{min-height:98px;padding:12px 14px 11px}.ttl-cd{font-size:10.5px}
  .ttl-ico{width:32px;height:32px}.ttl-ico svg{width:17px;height:17px}.ttl-hero .ttl-ico{width:40px;height:40px}
  .ttl-ct{font-size:14px}.ttl-hero .ttl-ct{font-size:20px}.ttl-card::after{font-size:62px}
  .ttl-facts{top:74px;max-height:calc(100vh - 74px - 190px)}.ttl-feats{display:none}}
@media (max-width:1000px){.ttl-pill:not(:first-child){display:none}}
@media (max-width:900px){
  .ttl-root{padding-top:76px;padding-bottom:60px}
  .ttl-menu{position:static;grid-template-columns:1fr 1fr;margin-top:22px}
  .ttl-hero,.ttl-card:last-child{grid-column:1/-1}.ttl-card{min-height:104px}}

/* ---------- panels ---------- */
.ttl-overlay{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;
  background:rgba(8,5,4,.6);backdrop-filter:blur(3px);padding:16px;color:#f4e9e1}
.ttl-overlay.ttl-open{display:flex}
.ttl-panel{width:min(560px,100%);max-height:85vh;overflow:auto;background:#1b1210;
  border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:22px 24px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.ttl-panel h2{margin:0 0 14px;font-size:22px;letter-spacing:.08em;text-transform:uppercase}
.ttl-panel h3{margin:18px 0 6px;font-size:13px;letter-spacing:.2em;text-transform:uppercase;color:#e0875a}
.ttl-panel p{line-height:1.55;opacity:.9;margin:0 0 10px}
.ttl-panel.ttl-wide{width:min(740px,100%)}
.ttl-lead{opacity:.7;margin:-6px 0 8px}
.ttl-ref{padding:20px 0;border-bottom:1px solid rgba(255,255,255,.10)}
.ttl-ref:last-of-type{border-bottom:0}
.ttl-ref-kind{position:absolute;left:10px;top:10px;font-size:10px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#1a0e09;background:linear-gradient(135deg,#ffc9a3,#e0875a);padding:4px 10px;border-radius:20px}
.ttl-panel h4{margin:0 0 6px;font-size:16px;letter-spacing:.03em}
.ttl-ref p{margin:0 0 10px;font-size:13.5px;line-height:1.6;opacity:.85}
.ttl-ref-img{position:relative;aspect-ratio:16/8;border-radius:12px;overflow:hidden;margin-bottom:14px;border:1px solid rgba(255,255,255,.14);background:#120b09}
.ttl-ref-img svg,.ttl-ref-img img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.ttl-ref-img.ttl-photo{aspect-ratio:auto;background:#120b09}
.ttl-ref-img.ttl-photo img{position:static;height:auto;max-height:340px;object-fit:contain;margin:0 auto}
.ttl-cap{position:absolute;right:10px;bottom:8px;z-index:2;font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding:3px 9px;border-radius:20px;background:rgba(14,8,6,.65);color:#f4e9e1}
.ttl-panel h5{margin:14px 0 4px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#e0875a}
.ttl-ref h4{font-size:19px}
.ttl-ref-facts{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.ttl-ref-facts span{font-size:11px;padding:4px 10px;border-radius:20px;border:1px solid rgba(240,164,122,.4);background:rgba(224,135,90,.10)}
.ttl-ref-links{display:flex;flex-direction:column;gap:4px}
.ttl-ref-links a{font-size:13px;word-break:normal}
.ttl-panel .ttl-ref-cite{font-size:12px;opacity:.6;margin:8px 0 0;font-style:italic}
.ttl-panel a{color:#f0a47a;word-break:break-all}
.ttl-tagline{font-size:17px;font-weight:600;color:#f0a47a;opacity:1!important;margin:-4px 0 14px!important}
.ttl-panel .ttl-motto{margin:16px 0 4px;font-size:18px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#f0a47a;opacity:1}
.ttl-sign{margin-top:22px;padding-top:16px;border-top:1px solid rgba(255,255,255,.12)}
.ttl-sign b{display:block;font-size:16px;letter-spacing:.14em;text-transform:uppercase}
.ttl-sign em{display:block;margin-top:4px;opacity:.75}
.ttl-panel ul{padding-left:18px;margin:0}
.ttl-panel li{margin-bottom:10px;line-height:1.45}
.ttl-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.08)}
.ttl-row label{font-size:14px}
.ttl-sec{margin:20px 0 0;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#e0875a}
.ttl-row.ttl-snd{display:grid;grid-template-columns:150px 1fr 44px 20px;gap:14px}
.ttl-row.ttl-snd input[type=range]{max-width:none;width:100%}
.ttl-pct{min-width:40px;text-align:right;font-size:13px;opacity:.8;font-variant-numeric:tabular-nums}
.ttl-row input[type=range]{flex:1;max-width:240px;accent-color:#e0875a}
.ttl-row input[type=checkbox]{width:18px;height:18px;accent-color:#e0875a}
.ttl-chips{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.ttl-chip{font:inherit;font-size:13px;cursor:pointer;padding:5px 10px;color:#f4e9e1;background:transparent;
  border:1px solid rgba(255,255,255,.3);border-radius:5px}
.ttl-chip.ttl-active{background:#e0875a;border-color:#e0875a;color:#1a0e09;font-weight:700}
.ttl-note{font-size:12px;opacity:.65;margin-top:10px}
.ttl-close{margin-top:18px;min-width:0}

.snd-grp{position:fixed;top:14px;left:14px;z-index:9999;width:64px;display:flex;flex-direction:column;align-items:center;gap:5px}
#marsClkGrp{top:108px}
#marsSndBtn,#marsClkBtn{width:44px;height:44px;padding:0;display:grid;place-items:center;
  border-radius:50%;cursor:pointer;color:#f4e9e1;background:rgba(20,10,8,.55);border:1px solid rgba(255,255,255,.28);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  transition:background .2s,border-color .2s,color .2s,box-shadow .2s,transform .2s}
#marsSndBtn:hover,#marsClkBtn:hover{background:rgba(60,30,20,.75);border-color:#f0a47a;transform:scale(1.06)}
#marsSndBtn:focus-visible,#marsClkBtn:focus-visible{outline:2px solid #f0a47a;outline-offset:3px}
#marsSndBtn svg,#marsClkBtn svg{width:20px;height:20px;display:block}
#marsSndBtn.on,#marsClkBtn.on{color:#1a0e09;background:linear-gradient(135deg,#ffc9a3,#e0875a);border-color:#f0a47a;box-shadow:0 0 18px rgba(224,135,90,.55)}
#marsSndBtn .wave,#marsClkBtn .wave{display:none}#marsSndBtn.on .wave,#marsClkBtn.on .wave{display:inline}#marsSndBtn.on .mute,#marsClkBtn.on .mute{display:none}
#marsSndBtn.err,#marsClkBtn.err{opacity:.5}
.snd-vol{width:58px;height:16px;margin:0;padding:0;cursor:pointer;accent-color:#e0875a}
.snd-cap{font:11px/1 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.04em;color:#f4e9e1;
  text-shadow:0 1px 3px rgba(0,0,0,.75);white-space:nowrap;user-select:none}
.snd-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
/* ---------- extra pages (2 = mission select, 3 = map) ---------- */
.pg-page{position:fixed;inset:0;z-index:50;display:flex;flex-direction:column;justify-content:safe center;overflow-y:auto;
  padding:78px clamp(24px,8vw,120px) 48px;color:#f4e9e1;
  background:linear-gradient(90deg,rgba(14,8,6,.82) 0%,rgba(14,8,6,.55) 55%,rgba(14,8,6,.25) 100%),
             linear-gradient(0deg,rgba(14,8,6,.6) 0%,rgba(14,8,6,0) 35%);
  transition:opacity .6s ease,visibility 0s}
.pg-page.ttl-hidden{opacity:0;pointer-events:none;visibility:hidden;transition:opacity .6s ease,visibility 0s .6s}
.pg-title{font-size:clamp(34px,6vw,76px);font-weight:800;letter-spacing:.08em;line-height:1.05;margin:0 0 10px}
.pg-sub{font-size:clamp(14px,1.5vw,18px);opacity:.85;margin:0 0 30px;max-width:34em}
.pg-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;counter-reset:ttl;margin-bottom:26px}
.pg-grid .ttl-card{min-height:150px;cursor:default}
.pg-soon{opacity:.6}
.pg-back{position:absolute;top:18px;left:clamp(24px,8vw,120px);z-index:3;display:inline-flex;align-items:center;gap:10px;
  font:inherit;font-size:11px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#f4e9e1;cursor:pointer;
  padding:9px 18px 9px 10px;border-radius:999px;border:1px solid rgba(240,164,122,.55);
  background:linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,.03));
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  box-shadow:0 8px 22px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.14);
  transition:transform .3s cubic-bezier(.2,.8,.2,1),background .3s,color .3s,box-shadow .3s,border-color .3s}
.pg-back .pg-arr{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;color:#1a0e09;
  background:linear-gradient(135deg,#ffc9a3,#e0875a);box-shadow:0 3px 10px rgba(224,135,90,.5);transition:transform .3s}
.pg-back .pg-arr svg{width:14px;height:14px}
.pg-back:hover,.pg-back:focus-visible{outline:none;transform:translateX(-3px);color:#1a0e09;border-color:#f0a47a;background:#f0a47a;
  box-shadow:0 10px 26px rgba(224,135,90,.45)}
.pg-back:hover .pg-arr,.pg-back:focus-visible .pg-arr{transform:translateX(-3px);background:#fff;color:#a8402a}
.pg-back:active{transform:translateX(-1px)}
.pg-empty{border-style:dashed;opacity:.4;pointer-events:none;box-shadow:none;background:rgba(255,255,255,.02)}
.pg-empty::before,.pg-empty::after{display:none}
@media (max-width:800px){.pg-grid{grid-template-columns:1fr}}

/* ---------- module wrapper ---------- */
#mars-title-layer{position:fixed;inset:0;z-index:10000;overflow:hidden;background:#120b08;color:#f4e9e1;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
#mars-title-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.snd-grp{z-index:10001}
.mars-map-back{position:fixed;top:18px;left:92px;z-index:10002;background:rgba(20,10,8,.78)}
.mars-map-back:hover,.mars-map-back:focus-visible{background:#f0a47a}
@media (max-width:600px){.ttl-feats,.ttl-more{display:none}.ttl-pills{display:none}}
.mars-close-btn{font:inherit;font-size:12px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#f4e9e1;cursor:pointer;
  padding:9px 22px;border-radius:999px;border:1px solid rgba(240,164,122,.55);
  background:linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,.03));transition:background .25s,color .25s}
.mars-close-btn:hover,.mars-close-btn:focus-visible{outline:none;background:#f0a47a;color:#1a0e09}

#mars-title-layer,#mars-title-layer *,.snd-grp,.snd-grp *{box-sizing:content-box}
`;
    document.head.appendChild(style);
  }

  /* ============================================================
     UI
     ============================================================ */

  createUI() {
    const layer = document.createElement('div');
    layer.id = 'mars-title-layer';
    layer.innerHTML = TITLE_HTML;
    document.body.appendChild(layer);

    this.layer = layer;
    this.titleEl = layer.querySelector('#mars-title');
    this.page2 = layer.querySelector('#mars-page2');
    this.overlay = layer.querySelector('#mars-overlay');
    this.panel = layer.querySelector('#mars-panel');

    const on = (id, fn) => layer.querySelector(id).addEventListener('click', fn);

    on('#mars-start', () => this.goPage(2));
    on('#mars-back', () => this.goPage(1));
    on('#mars-coordinates', () => this.enterMarsScout());
    on('#mars-settings', () => this.showSettings());
    on('#mars-about', () => this.showAbout());
    on('#mars-refs', () => this.showReferences());
    on('#mars-coordinates', () => this.enterMarsScout('coordinates'));
    on('#mars-landmarks',   () => this.enterMarsScout('landmarks'));

    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.closeDialog();
    });

    this.escHandler = (event) => {
      if (event.key === 'Escape') this.closeDialog();
    };
    window.addEventListener('keydown', this.escHandler);
  }

  goPage(n) {
    this.closeDialog();
    this.page = n === 1 ? 'title' : 'page2';
    this.titleEl.classList.toggle('ttl-hidden', n !== 1);
    this.page2.classList.toggle('ttl-hidden', n !== 2);
  }

  /* ============================================================
     SOUND (music + click sound, top-left controls)
     ============================================================ */

  createSound() {
    // Remove leftovers of older sound markup so the controls never appear twice.
    ['musicGrp', 'clkGrp', 'mars-snd-wrap'].forEach((id) => document.getElementById(id)?.remove());

    const wrap = document.createElement('div');
    wrap.id = 'mars-snd-wrap';
    wrap.innerHTML = SOUND_HTML;
    document.body.appendChild(wrap);
    this.soundWrap = wrap;

    const $ = (id) => wrap.querySelector('#' + id);
    const btn = $('marsSndBtn'), txt = $('marsSndTxt');
    const cbtn = $('marsClkBtn'), ctxt = $('marsClkTxt');
    const mv = $('marsMusicVol'), cv = $('marsClkVol');
    const mcap = $('marsMusicCap'), ccap = $('marsClkCap');

    const vg = (v) => {
      v = Math.max(0, Math.min(100, +v || 0)) / 100;
      return v * v;                                   // slider % -> gain (perceptual curve)
    };

    let ctx = null, mGain = null, sGain = null;
    let music = null, click = null, src = null;
    let want = false, loadingM = false, loadedS = false, clicksOn = true;

    const showVol = () => {
      mcap.textContent = 'Music ' + mv.value + '%';
      ccap.textContent = 'Clicks ' + cv.value + '%';
    };
    const ui = (on) => {
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.setAttribute('aria-label', on ? 'Turn music off' : 'Turn music on');
      txt.textContent = on ? 'Music on' : 'Music off';
    };
    const cui = (on) => {
      cbtn.classList.toggle('on', on);
      cbtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      cbtn.setAttribute('aria-label', on ? 'Turn click sound off' : 'Turn click sound on');
      ctxt.textContent = on ? 'Click sound on' : 'Click sound off';
    };

    const decode = (url, ok, bad) => {
      fetch(url)
        .then((r) => { if (!r.ok) throw new Error(url); return r.arrayBuffer(); })
        .then((buf) => {
          let p = null;
          try { p = ctx.decodeAudioData(buf); } catch (e) { /* old callback API */ }
          if (p && p.then) p.then(ok, bad);
          else { try { ctx.decodeAudioData(buf, ok, bad); } catch (e) { bad(); } }
        })
        .catch(() => bad());
    };

    const ensureCtx = () => {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        ctx = new AC();
        mGain = ctx.createGain(); mGain.gain.value = vg(mv.value); mGain.connect(ctx.destination);
        sGain = ctx.createGain(); sGain.gain.value = vg(cv.value); sGain.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
      if (!loadedS) {
        loadedS = true;
        decode(CLICK_URL, (b) => { click = b; }, () => {});
      }
      return true;
    };

    const playClick = () => {
      if (!click || !clicksOn) return;
      const s = ctx.createBufferSource();
      s.buffer = click;
      s.connect(sGain);
      s.start(0);
    };

    const startMusic = () => {
      if (!want || !music) return;
      if (src) { try { src.stop(); } catch (e) { /* already stopped */ } }
      src = ctx.createBufferSource();
      src.buffer = music;
      src.loop = true;
      src.connect(mGain);
      src.start(0);
    };

    const turnOn = () => {
      if (!ensureCtx()) { btn.classList.add('err'); return; }
      want = true; ui(true);
      if (music) { startMusic(); return; }
      if (loadingM) return;
      loadingM = true;
      decode(
        MUSIC_URL,
        (b) => { loadingM = false; music = b; startMusic(); },
        () => {
          loadingM = false; want = false; ui(false);
          btn.classList.add('err');
          btn.title = 'Music could not be loaded';
        }
      );
    };

    const turnOff = () => {
      want = false; ui(false);
      if (src) { try { src.stop(); } catch (e) { /* already stopped */ } src = null; }
    };

    btn.addEventListener('click', () => (want ? turnOff() : turnOn()));
    mv.addEventListener('input', () => { if (mGain) mGain.gain.value = vg(mv.value); showVol(); });
    cv.addEventListener('input', () => { if (sGain) sGain.gain.value = vg(cv.value); showVol(); });
    cv.addEventListener('change', () => { if (clicksOn) { ensureCtx(); playClick(); } });
    cbtn.addEventListener('click', () => {
      clicksOn = !clicksOn; cui(clicksOn);
      if (clicksOn) { ensureCtx(); playClick(); }
    });

    // click sound on every button (when the click sound is on)
    const onDocClick = (e) => {
      const b = e.target.closest && e.target.closest('button');
      if (!b) return;
      ensureCtx();
      playClick();
    };
    const onPointer = () => ensureCtx();
    const onVisibility = () => {
      if (!ctx) return;
      if (document.hidden) ctx.suspend(); else ctx.resume();
    };

    document.addEventListener('click', onDocClick, true);
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('visibilitychange', onVisibility);

    ui(false); cui(true); showVol();
    ensureCtx();   // decode the click sound early so the first click is not silent

    this.soundCleanup = () => {
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('visibilitychange', onVisibility);
      if (src) { try { src.stop(); } catch (e) { /* already stopped */ } }
      if (ctx) ctx.close?.();
      wrap.remove();
    };
  }

  /* ============================================================
     3D MARS GLOBE (real elevation tiles, see GLOBE at the top of the file)
     ============================================================ */

  createMarsScene() {
    const canvas = this.layer.querySelector('#mars-title-canvas');
    this.canvas = canvas;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x05030a, 1);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(GLOBE.fov, 1, 0.01, 200);

    this.globe = new GlobeBackdrop(this.scene, renderer);
    this.globe.load(TILES_URL).catch((e) => console.warn('[globe] showing the plain ball instead:', e.message));

    // radius is in globe radii (1 = the surface). elevation = camera angle above the equator.
    this.cameraState = {
      theta: 0.6,
      elevation: GLOBE.startElevation,
      radius: GLOBE.startRadius,
      target: new THREE.Vector3(0, 0, 0),
      dragging: false,
      lastX: 0,
      lastY: 0,
    };

    this.addCameraControls();

    this.resizeHandler = () => this.resize();
    window.addEventListener('resize', this.resizeHandler);
    this.resize();

    this.sceneReady = true;
  }




  /* ============================================================
     CAMERA (drag to look around, scroll to zoom)
     ============================================================ */

  addCameraControls() {
    const state = this.cameraState;
    const layer = this.layer;

    const free = (target) =>
      !target.closest('button, a, input, label, .ttl-facts, .ttl-panel, .ttl-overlay.ttl-open, .pg-back');

    layer.addEventListener('pointerdown', (event) => {
      if (this.page !== 'title' || !free(event.target)) return;
      state.dragging = true;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      layer.setPointerCapture(event.pointerId);
    });

    layer.addEventListener('pointermove', (event) => {
      if (!state.dragging) return;
      state.theta -= (event.clientX - state.lastX) * 0.005;
      state.elevation = Math.max(
        0.03,
        Math.min(1.5, state.elevation + (event.clientY - state.lastY) * 0.004)
      );
      state.lastX = event.clientX;
      state.lastY = event.clientY;
    });

    const stopDrag = () => { state.dragging = false; };
    layer.addEventListener('pointerup', stopDrag);
    layer.addEventListener('pointercancel', stopDrag);

    layer.addEventListener(
      'wheel',
      (event) => {
        if (this.page !== 'title') return;
        if (event.target.closest('.ttl-facts, .ttl-panel')) return;
        event.preventDefault();
        state.radius = Math.max(
          1.15,
          Math.min(4, state.radius * Math.exp(event.deltaY * 0.001))
        );
      },
      { passive: false }
    );
  }

  /* ============================================================
     RESIZE
     ============================================================ */

  resize() {
    if (!this.renderer) return;

    const width = window.innerWidth;
    const height = window.innerHeight;

    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /* ============================================================
     UPDATE
     ============================================================ */

  update(delta) {
    if (!this.active || !this.sceneReady) return;

    const state = this.cameraState;

    const ce = Math.cos(state.elevation);

    const x = state.target.x + state.radius * ce * Math.sin(state.theta);
    const z = state.target.z + state.radius * ce * Math.cos(state.theta);
    const y = state.target.y + state.radius * Math.sin(state.elevation);

    this.camera.position.set(x, y, z);
    this.camera.lookAt(state.target);

    this.globe?.update(delta, this.autoRotate);      // the globe turns itself; "Slowly rotate" in Settings switches it off

    if (this.renderer) {
      this.renderer.render(this.scene, this.camera);
    }

    this.updateClock();
  }

  /* ============================================================
     LIVE SOL TIME (real Mars solar time at the site)
     ============================================================ */

  updateClock() {
    const sun = marsSolarState(Date.now(), SITE_LAT, SITE_LON);
    const hour = fmtHour(sun.ltst);
    const text =
      'Site sol time ' + hour +
      '  ·  Ls ' + sun.ls.toFixed(0) + '°' +
      '  ·  sun ' + sun.elev.toFixed(0) + '° ' + (sun.elev >= 0 ? 'up' : 'below horizon');

    if (text === this.lastSolText) return;
    this.lastSolText = text;

    const top = this.layer?.querySelector('#mars-top-sol');
    const live = this.layer?.querySelector('#mars-live-txt');
    if (top) top.textContent = hour;
    if (live) live.textContent = text;
  }

  /* ============================================================
     ENTER EXISTING MARS SCOUT MAP
     ============================================================ */

    enterMarsScout(mode = 'coordinates') {
    if (this.started) return;
    this.started = true;

    // Stop the title experience.
    this.active = false;

    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
    }
    window.removeEventListener('keydown', this.escHandler);

    // Restore the existing Mars Scout canvas.
    const appCanvas = this.ctx.renderer?.domElement;
    if (appCanvas) {
      appCanvas.style.visibility =
        appCanvas.dataset.marsScoutOriginalVisibility || 'visible';
      delete appCanvas.dataset.marsScoutOriginalVisibility;
    }

    // Remove the title scene and UI.
    this.disposeMarsScene();
    document.querySelectorAll('#mars-title-layer, #mars-title-canvas').forEach((n) => n.remove());   // <- the changed line
    document.body.classList.remove('title-open');
    this.createMapBack();

    // Tell MapPickModule which mode was chosen.
    this.ctx.state.set('searchMode', mode);
    this.ctx.bus.emit('search:mode', mode);

    // Tell the rest of the app the title screen has finished.
    this.ctx.state.set('mode', 'map');
    this.ctx.bus.emit('title:start');

    console.log('[title] Mars Scout map is now active. Mode:', mode);
  }

  /* ============================================================
     BACK BUTTON ON THE MAP PAGE
     ============================================================ */

  createMapBack() {
    document.getElementById('mars-map-back')?.remove();

    const btn = document.createElement('button');
    btn.id = 'mars-map-back';
    btn.className = 'pg-back mars-map-back';
    btn.setAttribute('aria-label', 'Back to Choose your path');
    btn.innerHTML = '<span class="pg-arr">' + ICON.back + '</span>Back';

    btn.addEventListener('click', () => {
      // Reloading resets the map completely, then the title opens on "Choose your path".
      try { sessionStorage.setItem('marsScoutStartPage', '2'); } catch (e) { /* ignore */ }
      window.location.reload();
    });

    document.body.appendChild(btn);
    this.mapBackBtn = btn;
  }

  /* ============================================================
     DIALOGS
     ============================================================ */

  openDialog() {
    this.overlay.classList.add('ttl-open');
  }

  closeDialog() {
    this.overlay?.classList.remove('ttl-open');
  }

  showSettings() {
    this.panel.className = 'ttl-panel';
    this.panel.innerHTML = `
      <h2>Settings</h2>
      <p class="ttl-lead">Adjust the title-screen camera. The map has its own controls.</p>
      <div class="ttl-row">
        <label for="mars-rot">Slowly rotate the planet</label>
        <input id="mars-rot" type="checkbox" ${this.autoRotate ? 'checked' : ''}>
      </div>
      <div class="ttl-row">
        <label for="mars-dist">Camera distance</label>
        <input id="mars-dist" type="range" min="1.15" max="4" step="0.05" value="${this.cameraState.radius}">
      </div>
      <button class="mars-close-btn ttl-close" id="mars-close">Close</button>
    `;

    const rot = this.panel.querySelector('#mars-rot');
    rot.addEventListener('change', () => { this.autoRotate = rot.checked; });

    const dist = this.panel.querySelector('#mars-dist');
    dist.addEventListener('input', () => { this.cameraState.radius = Number(dist.value); });

    this.panel.querySelector('#mars-close').addEventListener('click', () => this.closeDialog());
    this.openDialog();
  }

  showAbout() {
    this.panel.className = 'ttl-panel';
    this.panel.innerHTML = `
      <h2>About us</h2>
      <p class="ttl-tagline">🚀 Team Astral Odyssey</p>
      <p>
        Astral Odyssey is a team passionate about space, technology and exploration.
        We created <strong>Mars Scout</strong> to make Mars exploration more interactive,
        informative and accessible.
      </p>
      <p>
        Our project brings together planetary information and terrain data to help users
        explore the Martian surface.
      </p>
      <h3>Our mission</h3>
      <p>
        Explore Mars, understand its terrain, investigate mineral information,
        identify potential hazards and plan routes through one interactive platform.
      </p>
      <h3>Our vision</h3>
      <p class="ttl-motto">Explore. Discover. Understand.</p>
      <div class="ttl-sign">
        <b>Team Astral Odyssey</b>
        <em>Creativity, engineering and technology, building Mars Scout.</em>
      </div>
      <button class="mars-close-btn ttl-close" id="mars-close">Close</button>
    `;

    this.panel.querySelector('#mars-close').addEventListener('click', () => this.closeDialog());
    this.openDialog();
  }

  showReferences() {
    this.panel.className = 'ttl-panel ttl-wide';
    this.panel.innerHTML = `
      <h2>References</h2>
      <p class="ttl-lead">Data, papers and tools we relied on.</p>

      <div class="ttl-ref">
        <h4>HiRISE</h4>
        <p>High Resolution Imaging Science Experiment provides extremely detailed images of Mars from the Mars Reconnaissance Orbiter.</p>
      </div>
      <div class="ttl-ref">
        <h4>CRISM</h4>
        <p>Compact Reconnaissance Imaging Spectrometer for Mars helps identify minerals from orbit.</p>
      </div>
      <div class="ttl-ref">
        <h4>MOLA</h4>
        <p>Mars Orbiter Laser Altimeter provides Mars elevation and topographic information.</p>
      </div>
      <div class="ttl-ref">
        <h4>USGS</h4>
        <p>Geological maps provide information about Martian surface units and geological history.</p>
      </div>
      <div class="ttl-ref">
        <h4>Three.js</h4>
        <p>Used to create the interactive 3D visualization in the browser.</p>
      </div>

      <button class="mars-close-btn ttl-close" id="mars-close">Close</button>
    `;

    this.panel.querySelector('#mars-close').addEventListener('click', () => this.closeDialog());
    this.openDialog();
  }

  /* ============================================================
     DISPOSE
     ============================================================ */

  disposeMarsScene() {
    if (this.renderer) this.renderer.dispose();
    this.globe?.dispose();
    this.globe = null;
    this.sceneReady = false;
  }

  dispose() {
    this.active = false;

    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
    }
    window.removeEventListener('keydown', this.escHandler);

    this.disposeMarsScene();
    this.layer?.remove();
    this.soundCleanup?.();
    this.mapBackBtn?.remove();

    document.body.classList.remove('title-open');

    const appCanvas = this.ctx.renderer?.domElement;
    if (appCanvas) {
      appCanvas.style.visibility =
        appCanvas.dataset.marsScoutOriginalVisibility || 'visible';
    }

    super.dispose();
  }
}