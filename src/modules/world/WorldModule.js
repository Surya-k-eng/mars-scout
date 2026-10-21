import * as THREE from 'three';
import { Module } from '../../core/Module.js';
import { EVENTS } from '../../core/events.js';
import { lodViews } from '../../core/lodViews.js';

// Flat, simple terrain (like the old TerrainModule) fed by two blended layers (like WorldModule).
// No camera control, no HUD, no fog: it only builds the ground and exposes height lookups.

const VERT_EXAG = 3;        // display only; heightAt() / sampleRegion() return real metres
const MAX_ERR_PX = 1;       // a cell may span at most this many screen pixels before a sharper tile is used
const MAX_IN_FLIGHT = 12;    // parallel tile downloads
const CACHE_LIMIT = 400;    // tiles kept in memory across both layers (two viewpoints need more than one)
const LIFT = 18;            // each sharper layer is drawn this much higher (display units) so it wins over the one below
const TUCK = 100;
const MARGIN = 4;           // shrink the regional cut-out by this many HiRISE root cells so the border has no gap
const STEP_SLOPE = 1.2 * VERT_EXAG; 

const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// Baked occlusion per layer: radiusM = how far around a point to compare heights, strength = max darkening (0..1)
const AO = [
  { radiusM: 1200, strength: 0.45 },   // Regional: big basins and crater floors
  { radiusM: 25,   strength: 0.40 },   // HiRISE: small hollows and crater rims
];
const AO_MAX_PX = 10;                  // cap on blur radius in pixels (keeps tile building fast)

// Box blur of heights (ignores NaN), used to find hollows: a vertex lower than its blurred surroundings is "in a hole".
function blurHeights(h, V, r) {
  const tmp = new Float32Array(V * V), out = new Float32Array(V * V);
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
    let s = 0, n = 0;
    for (let d = -r; d <= r; d++) { const ii = i + d; if (ii < 0 || ii >= V) continue; const v = h[j * V + ii]; if (v === v) { s += v; n++; } }
    tmp[j * V + i] = n ? s / n : NaN;
  }
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
    let s = 0, n = 0;
    for (let d = -r; d <= r; d++) { const jj = j + d; if (jj < 0 || jj >= V) continue; const v = tmp[jj * V + i]; if (v === v) { s += v; n++; } }
    out[j * V + i] = n ? s / n : NaN;
  }
  return out;
}// if the slope changes by more than this between two neighbours, treat it as a seam step           // coarse vertices under a sharper layer are lowered this much (display units)

// Fine surface detail, drawn per pixel. It is a pure function of world position (hash based: no Math.random,
// no time), so it is identical every load and never shifts when tiles change detail level or get evicted.
// wave = size in metres of the biggest bumps, strength = how strongly they tilt the light, tint = brightness variation.
const DETAIL = [
  { wave: 240, strength: 0.15, tint: 0.05 },   // Regional 200 m: bumps from 240 m down to 15 m
  { wave: 6,   strength: 0.12, tint: 0.04 },   // HiRISE 1 m:     bumps from 6 m down to 0.4 m
];
const DETAIL_PARS = `
varying vec3 vDPos;
uniform float uWave;
uniform float uStrength;
uniform float uTint;
float dHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z) * 2.0 - 1.0;
}
vec3 dNoise(vec2 x) {                       // value noise: .x = value, .yz = slope per lattice unit
  vec2 i = floor(x), f = fract(x);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = dHash(i), b = dHash(i + vec2(1.0, 0.0)), c = dHash(i + vec2(0.0, 1.0)), d = dHash(i + vec2(1.0, 1.0));
  float k = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du * (vec2(b - a, c - a) + k * u.yx));
}
vec3 dFbm(vec2 w, float fw) {               // w = world xz / uWave, fw = metres per pixel
  float val = 0.0, amp = 1.0, freq = 1.0;
  vec2 g = vec2(0.0);
  mat2 m = mat2(1.0), r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int o = 0; o < 5; o++) {
    float fade = smoothstep(1.0, 4.0, (uWave / freq) / max(fw, 1e-4));   // drop bumps smaller than a pixel (no shimmer)
    vec3 n = dNoise(m * w * freq);
    val += amp * fade * n.x;
    g += amp * fade * (n.yz * m);
    amp *= 0.55; freq *= 2.0; m = r * m;
  }
  return vec3(val, g);
}
`;
const DETAIL_COLOR = `
vec3 dTer = dFbm(vDPos.xz / uWave, length(fwidth(vDPos.xz)));
diffuseColor.rgb *= 1.0 + uTint * dTer.x;
`;
const DETAIL_NORMAL = `
{
  normal *= faceDirection;   // undo three's back-face flip: terrain always uses its stored up-normal
  float dSlope = 1.0 - clamp(inverseTransformDirection(normal, viewMatrix).y, 0.0, 1.0);
  float dRough = mix(0.7, 1.4, smoothstep(0.02, 0.35, dSlope));          // steeper ground gets rougher
  vec3 dg = (viewMatrix * vec4(dTer.y, 0.0, dTer.z, 0.0)).xyz * (uStrength * dRough);
  dg -= dot(dg, normal) * normal;
  normal = normalize(normal - dg);
}
`;

const RM = 3396190;                 // Mars radius, metres
const D2R = Math.PI / 180;
const M = RM * D2R;                 // metres per degree (same scale in x and z, so source pixels stay square)

const TILES = (import.meta.env.VITE_TILES_URL ?? `${import.meta.env.BASE_URL}tiles/`).replace(/\/?$/, '/');
const LAYERS = [                    // later entries are sharper and win where they have data
  { name: 'Regional 200 m', path: 'regional' },
  { name: 'HiRISE DTM', path: 'hirise' },
];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Triangle indices for one tile plus "skirt" strips that hide cracks between detail levels.
// valid = vertices that have data (or null); cov = vertices lying under a sharper layer (or null).
function buildIndex(N, valid, cov) {
  const out = new Uint32Array(((N - 1) * (N - 1) + 4 * (N - 1)) * 6);
  let n = 0;
  const ok = (k) => !valid || valid[k] === 1;
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      if (!(ok(a) && ok(b) && ok(c) && ok(d))) continue;
      if (cov && cov[a] && cov[b] && cov[c] && cov[d]) continue;       // hole under a sharper layer
      out[n++] = a; out[n++] = c; out[n++] = b;
      out[n++] = b; out[n++] = c; out[n++] = d;
    }
  }
  const edge = [(k) => k, (k) => (N - 1) * N + k, (k) => k * N, (k) => k * N + N - 1];
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < N - 1; k++) {
      const a = edge[e](k), b = edge[e](k + 1);
      if (!(ok(a) && ok(b))) continue;
      if (cov && cov[a] && cov[b]) continue;
      const sa = N * N + e * N + k, sb = sa + 1;
      out[n++] = a; out[n++] = sa; out[n++] = b;
      out[n++] = b; out[n++] = sa; out[n++] = sb;
    }
  }
  return new THREE.BufferAttribute(n === out.length ? out : out.slice(0, n), 1);
}

export class WorldModule extends Module {
  static id = 'world';

  async init() {
    this.alive = true;
    this.layers = [];  // TEMP: red = see-through holes 
    for (let i = 0; i < LAYERS.length; i++) {
      try { this.layers.push(await this.loadLayer(LAYERS[i], i)); }
      catch (e) {
        if (i === 0) throw new Error(`Terrain tiles not found (${e.message}). Check VITE_TILES_URL / the tiles folder.`);
        console.warn(`[terrain] layer "${LAYERS[i].name}" skipped: ${e.message}`);
      }
    }

    // The sharpest layer defines the grid (gx, gz) and the world origin; the others are placed by lon/lat.
    const ref = this.ref = this.layers[this.layers.length - 1];
    this.lonC = (ref.fp.lonMin + ref.fp.lonMax) / 2;
    this.latC = (ref.fp.latMin + ref.fp.latMax) / 2;
    this.W = ref.srcW;
    this.H = ref.srcH;
    this.px = ref.res * M;                       // metres per source pixel of the sharpest layer
    const { W, H, px } = this;

    this.drawn = new Set();
    this.inFlight = 0;
    this.frame = 0;
    this.frustum = new THREE.Frustum();
    this.pv = new THREE.Matrix4();
    this.camPos = new THREE.Vector3();
    this.mats = [];

    // Every layer's coarsest tile first (the holes need the sharper layers' roots).
    for (const l of this.layers) {
      l.rootH = await this.fetchHeights(l, l.top, 0, 0);
      if (!l.rootH) throw new Error(`root terrain tile is missing or empty for ${l.name}`);
      this.getTile(l, l.top, 0, 0).h = l.rootH;
    }

    // Reference elevation range comes from the coarsest layer (covers the whole area).
    let minE = Infinity, maxE = -Infinity;
    for (const v of this.layers[0].rootH) if (v === v) { if (v < minE) minE = v; if (v > maxE) maxE = v; }
    this.minE = minE;
    this.maxE = maxE;
    this.span = Math.max(maxE - minE, 1e-6);
    // Vertical range of the tile boxes: must cover every layer's real heights, or a viewpoint near the ground
    // (Astro) ends up "outside" the boxes and its distance to a tile is measured wrongly.
    let zLo = minE, zHi = maxE;
    for (const l of this.layers) {
      if (Number.isFinite(l.minM)) zLo = Math.min(zLo, l.minM);
      if (Number.isFinite(l.maxM)) zHi = Math.max(zHi, l.maxM);
    }
    this.yLo = Math.min(-200, (zLo - minE) * VERT_EXAG - 100);
    this.yHi = (zHi - minE) * VERT_EXAG + 200 + LIFT * this.layers.length;
    // The coarsest tiles were created before yLo / yHi existed, so their boxes are flat (y = 0). Give them the full height.
    for (const l of this.layers) for (const tl of l.tiles.values()) { tl.box.min.y = this.yLo; tl.box.max.y = this.yHi; }

    // 256-step colour ramp (16-bit, so dark tones don't band)
    this.ramp = new Uint16Array(256 * 3);
    const c = new THREE.Color();
    for (let i = 0; i < 256; i++) {
      c.setHSL(0.06, 0.45, 0.22 + 0.35 * (i / 255));
      this.ramp[i * 3] = Math.round(c.r * 65535);
      this.ramp[i * 3 + 1] = Math.round(c.g * 65535);
      this.ramp[i * 3 + 2] = Math.round(c.b * 65535);
    }

    this.group = new THREE.Group();
    this.ctx.scene.add(this.group);

    for (const l of this.layers) {
      const root = this.getTile(l, l.top, 0, 0);
      root.mesh = this.makeMesh(l, root);
      root.state = 'ready';
      this.group.add(root.mesh);
    }

    const gridToLonLat = (gx, gz) => ({ lon: ref.lon0 + gx * ref.res, lat: ref.lat0 - gz * ref.res });

    // Height in real metres at a sharpest-layer pixel, from the sharpest tile currently loaded. NaN = no data.
    // What is loaded depends on the camera, so use sampleRegion() for planning.
    const heightAt = (gx, gz) => {
      gx = Math.min(Math.max(gx, 0), W - 1);
      gz = Math.min(Math.max(gz, 0), H - 1);
      const { lon, lat } = gridToLonLat(gx, gz);
      return this.sample(lon, lat)?.h ?? NaN;
    };

    const terrain = {
      id: 'jezero-dual',
      width: W,
      height: H,
      cellSize: px,
      heights: null,                      // the full grid is never in memory; use heightAt / sampleRegion
      minElevationM: minE,
      maxElevationM: maxE,
      vertExag: VERT_EXAG,
      layers: this.layers.map((l) => l.name),
      heightAt,
      sample: (lon, lat) => this.sample(lon, lat),
      sampleRegion: (...a) => this.sampleRegion(...a),
      gridToWorld: (gx, gz) => {
        const { lon, lat } = gridToLonLat(gx, gz);
        const s = this.sample(lon, lat);
        return {
          x: (gx - (W - 1) / 2) * px,
          y: s ? (s.h - minE) * VERT_EXAG + s.order * LIFT : 0,   // sits on the surface that is actually drawn
          z: (gz - (H - 1) / 2) * px,
        };
      },
      worldToGrid: (x, z) => ({ gx: x / px + (W - 1) / 2, gz: z / px + (H - 1) / 2 }),
    };
    this.ctx.state.set('terrain', terrain);
        terrain.ramp = this.ramp;                                 // same colours as the real ground
    {
      const f = this.layers[0].fp;                            // footprint of the regional layer, in world metres
      terrain.regionRect = {
        x0: (f.lonMin - this.lonC) * M, x1: (f.lonMax - this.lonC) * M,
        z0: (this.latC - f.latMax) * M, z1: (this.latC - f.latMin) * M,
      };
      terrain.lonC = this.lonC;
      terrain.latC = this.latC;
      terrain.worldToLonLat = (x, z) => ({ lon: this.lonC + x / M, lat: this.latC - z / M });
      terrain.lonLatToWorld = (lon, lat) => ({ x: (lon - this.lonC) * M, z: (this.latC - lat) * M });
      terrain.hiriseRect = {                      // HiRISE footprint in world metres
        x0: (ref.fp.lonMin - this.lonC) * M, x1: (ref.fp.lonMax - this.lonC) * M,
        z0:(this.latC - ref.fp.latMax) * M, z1: (this.latC - ref.fp.latMin) * M,
      };
    }
    terrain.sampleWorld = (x, z) => {                         // drawn height at a world x/z, or null if no data
      const s = this.sample(this.lonC + x / M, this.latC - z / M);
      return s ? (s.h - minE) * VERT_EXAG + s.order * LIFT : null;
    };
    this.ctx.bus.emit(EVENTS.TERRAIN_READY, terrain);

    this.refine();
    this.timer = setInterval(() => this.refine(), 100);
  }

  // ---- layers and tiles --------------------------------------------------

  async loadLayer(def, order) {
    const base = TILES + def.path + '/';
    const res = await fetch(base + 'index.json');
    if (!res.ok) throw new Error(`${base}index.json -> HTTP ${res.status}`);
    const idx = await res.json();
    const f = Math.abs(idx.bbox[0]) > 400 || Math.abs(idx.bbox[3]) > 400 ? 1 / RM / D2R : 1;   // metres -> degrees
    const L = {
      name: def.name, order, base, S: idx.tileCells, V: idx.verts,
      res: Math.abs(idx.pixelSize) * f, lon0: idx.bbox[0] * f, lat0: idx.bbox[3] * f,
      srcW: idx.srcWidth, srcH: idx.srcHeight,
      levels: idx.levels, minLevel: idx.minLevel ?? 0, top: idx.levels.length - 1,
      globalLevel: idx.region ? idx.globalLevel : 0,
      tiles: new Map(), rootH: null, sharedIndex: null,
      minM: idx.minM, maxM: idx.maxM,
    };
    L.fp = {
      lonMin: L.lon0, lonMax: L.lon0 + (idx.srcWidth - 1) * L.res,
      latMax: L.lat0, latMin: L.lat0 - (idx.srcHeight - 1) * L.res,
    };
    return L;
  }

  getTile(layer, L, x, y) {
    const key = `${L}/${x}/${y}`;
    let t = layer.tiles.get(key);
    if (t) return t;
    const lv = layer.levels[L], { S, res, lon0, lat0 } = layer;
    const c1 = Math.min((x + 1) * S, lv.cols - 1), r1 = Math.min((y + 1) * S, lv.rows - 1);
    const lonA = lon0 + x * S * lv.step * res, lonB = lon0 + c1 * lv.step * res;
    const latA = lat0 - y * S * lv.step * res, latB = lat0 - r1 * lv.step * res;   // latA > latB
    t = {
      key, L, x, y, state: 'idle', h: null, mesh: null, used: this.frame, retryAt: 0,
      lonA, lonB, latA, latB,
      box: new THREE.Box3(
        new THREE.Vector3((lonA - this.lonC) * M, this.yLo, (this.latC - latA) * M),
        new THREE.Vector3((lonB - this.lonC) * M, this.yHi, (this.latC - latB) * M)
      ),
    };
    layer.tiles.set(key, t);
    return t;
  }

  // Float32Array of real metres (NaN = no data), or null if the tile doesn't exist / is all no-data
  async fetchHeights(layer, L, x, y) {
    const { V } = layer;
    const res = await fetch(`${layer.base}${L}/${x}_${y}.bin`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength !== 8 + V * V * 2) return null;     // e.g. dev server answering a missing file with index.html
    const dv = new DataView(buf);
    const lo = dv.getFloat32(0, true), hi = dv.getFloat32(4, true);
    const q = new Uint16Array(buf, 8, V * V);
    const k = (hi - lo) / 65534;
    const h = new Float32Array(V * V);
    for (let i = 0; i < h.length; i++) { const v = q[i]; h[i] = v === 0 ? NaN : lo + (v - 1) * k; }
    return h;
  }

  async load(layer, t) {
    t.state = 'loading';
    this.inFlight++;
    try {
      const h = await this.fetchHeights(layer, t.L, t.x, t.y);
      if (!this.alive) return;
      if (h === null) { t.state = 'empty'; return; }
      t.h = h;
      t.mesh = this.makeMesh(layer, t);
      this.group.add(t.mesh);
      t.state = 'ready';
    } catch (e) {
      t.state = 'idle';
      t.retryAt = performance.now() + 3000;
      console.warn('terrain tile failed, will retry', layer.name, t.key, e);
    } finally {
      this.inFlight--;
    }
  }

  // Does a sharper layer have data at this lon/lat? (checked on its coarsest tile)
    // Does a sharper layer have data here, and also in the m cells around it? (checked on its coarsest tile)
  covered(lon, lat, order, m = 0) {
    for (const l of this.layers) {
      if (l.order <= order || !l.rootH) continue;
      const lv = l.levels[l.top];
      const i0 = Math.round((lon - l.lon0) / (l.res * lv.step)), j0 = Math.round((l.lat0 - lat) / (l.res * lv.step));
      let ok = true;
      for (let dj = -m; dj <= m && ok; dj++) {
        for (let di = -m; di <= m; di++) {
          const i = i0 + di, j = j0 + dj;
          if (i < 0 || j < 0 || i > lv.cols - 1 || j > lv.rows - 1) { ok = false; break; }
          const v = l.rootH[j * l.V + i];
          if (!(v === v)) { ok = false; break; }
        }
      }
      if (ok) return true;
    }
    return false;
  }

  overlapsHigher(layer, t) {
    return this.layers.some((l) => l.order > layer.order && l.rootH &&
      t.lonB >= l.fp.lonMin && t.lonA <= l.fp.lonMax && t.latA >= l.fp.latMin && t.latB <= l.fp.latMax);
  }
  // Fill no-data gaps in a copy of the tile so the surface is continuous and smooth (strip seams, small voids).
// Gaps up to maxGap pixels wide, with data on both sides, are interpolated across; the filled pixels are then
// softened by repeated neighbour averaging so they blend into the ground around them. Outer data edges are left alone.
fillGaps(h, V, maxGap = 24, smooth = 6) {
  const hole = new Uint8Array(V * V);
  let any = false;
  for (let k = 0; k < V * V; k++) if (h[k] !== h[k]) { hole[k] = 1; any = true; }
  if (!any) return h;
  const src = h.slice();
  const acc = new Float32Array(V * V), cnt = new Uint8Array(V * V);
  const run = (start, stride) => {
    let k = 0;
    while (k < V) {
      if (!hole[start + k * stride]) { k++; continue; }
      let e = k;
      while (e < V && hole[start + e * stride]) e++;
      if (k > 0 && e < V && e - k <= maxGap) {
        const a = src[start + (k - 1) * stride], b = src[start + e * stride];
        for (let m = k; m < e; m++) {
          const p = start + m * stride;
          acc[p] += a + (b - a) * (m - k + 1) / (e - k + 1);
          cnt[p]++;
        }
      }
      k = e;
    }
  };
  for (let r = 0; r < V; r++) run(r * V, 1);          // across rows
  for (let c = 0; c < V; c++) run(c, V);              // across columns
  const filled = [];
  for (let k = 0; k < V * V; k++) if (cnt[k]) { h[k] = acc[k] / cnt[k]; filled.push(k); }
  for (let p = 0; p < smooth && filled.length; p++) {  // soften only the filled pixels
    const prev = h.slice();
    for (const k of filled) {
      const i = k % V, j = (k / V) | 0;
      let s = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= V || jj >= V) continue;
        const v = prev[jj * V + ii];
        if (v === v) { s += v; n++; }
      }
      h[k] = s / n;
    }
  }
  return h;
}


  matFor(order) {
    if (this.mats[order]) return this.mats[order];
    const d = DETAIL[Math.min(order, DETAIL.length - 1)];
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, side: THREE.DoubleSide,
      polygonOffset: order > 0, polygonOffsetFactor: -4 * order, polygonOffsetUnits: -4 * order,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uWave = { value: d.wave };
      shader.uniforms.uStrength = { value: d.strength };
      shader.uniforms.uTint = { value: d.tint };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vDPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDPos = transformed;');   // meshes sit at the origin, so this is world space
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + DETAIL_PARS)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + DETAIL_COLOR)
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + DETAIL_NORMAL);
    };
    return (this.mats[order] = mat);
  }

  makeMesh(layer, t) {
    const { V, S, res, lon0, lat0, order } = layer;
    const lv = layer.levels[t.L], step = lv.step, h = this.fillGaps(t.h.slice(), V);
    const { minE, span, ramp, lonC, latC } = this;
    const nV = V * V + 4 * V;                               // grid + 4 skirt strips
    const pos = new Float32Array(nV * 3);
    const nor = new Float32Array(nV * 3);
    const col = new Uint16Array(nV * 3);
    const valid = new Uint8Array(V * V);
    const useCov = this.overlapsHigher(layer, t);
    const lift = order * LIFT;
    let cov = null, bad = 0;

    for (let j = 0; j < V; j++) {
      const lat = lat0 - Math.min(t.y * S + j, lv.rows - 1) * step * res;   // padded rows collapse onto the data edge
      const z = (latC - lat) * M;
      for (let i = 0; i < V; i++) {
        const k = j * V + i, v = h[k];
        const lon = lon0 + Math.min(t.x * S + i, lv.cols - 1) * step * res;
        pos[k * 3] = (lon - lonC) * M;
        pos[k * 3 + 2] = z;
        if (v !== v) { bad++; nor[k * 3 + 1] = 1; continue; }   // no data: skipped by the index buffer
        valid[k] = 1;
        pos[k * 3 + 1] = (v - minE) * VERT_EXAG + lift;
        const r = Math.round(clamp01((v - minE) / span) * 255) * 3;
        col[k * 3] = ramp[r]; col[k * 3 + 1] = ramp[r + 1]; col[k * 3 + 2] = ramp[r + 2];
        if (useCov && this.covered(lon, lat, order, MARGIN)) { cov ??= new Uint8Array(V * V); cov[k] = 1; }
      }
    }

    // normals from neighbouring positions (needs all positions first)
        // normals: average slope, but across a sudden step (strip seam) use the gentler side so it doesn't shade black
    const yy = (n, fb) => (valid[n] ? pos[n * 3 + 1] : fb);
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < V; i++) {
        const k = j * V + i;
        if (!valid[k]) continue;
        const L = j * V + Math.max(i - 1, 0), R = j * V + Math.min(i + 1, V - 1);
        const U = Math.max(j - 1, 0) * V + i, D = Math.min(j + 1, V - 1) * V + i;
        const y0 = pos[k * 3 + 1];
        const dxB = pos[k * 3] - pos[L * 3], dxF = pos[R * 3] - pos[k * 3];
        const dzB = pos[k * 3 + 2] - pos[U * 3 + 2], dzF = pos[D * 3 + 2] - pos[k * 3 + 2];
        let xB = dxB ? (y0 - yy(L, y0)) / dxB : NaN, xF = dxF ? (yy(R, y0) - y0) / dxF : NaN;
        let zB = dzB ? (y0 - yy(U, y0)) / dzB : NaN, zF = dzF ? (yy(D, y0) - y0) / dzF : NaN;
        if (xB !== xB) xB = xF; if (xF !== xF) xF = xB;       // tile border: use the one side we have
        if (zB !== zB) zB = zF; if (zF !== zF) zF = zB;
        const sx = Math.abs(xF - xB) > STEP_SLOPE ? (Math.abs(xF) < Math.abs(xB) ? xF : xB) : (xF + xB) / 2;
        const sz = Math.abs(zF - zB) > STEP_SLOPE ? (Math.abs(zF) < Math.abs(zB) ? zF : zB) : (zF + zB) / 2;
        const il = 1 / Math.hypot(sx, 1, sz);
        nor[k * 3] = -sx * il; nor[k * 3 + 1] = il; nor[k * 3 + 2] = -sz * il;
        const steep = sstep(0.03, 0.22, 1 - il);          // 0 = flat dust, 1 = steep rock (tune the two numbers)
        const f = 1 - 0.5 * steep;
        col[k * 3]     = col[k * 3] * f;
        col[k * 3 + 1] = col[k * 3 + 1] * f * 0.95;       // rock is a little darker and less orange
        col[k * 3 + 2] = col[k * 3 + 2] * f * 0.90;
      }
    }
    {
  const ao = AO[Math.min(order, AO.length - 1)];
  const cellM = step * res * M;
  const r = Math.min(AO_MAX_PX, Math.max(1, Math.round(ao.radiusM / cellM)));
  const blur = blurHeights(h, V, r);
  const depth = ao.radiusM * 0.08;                // a hollow this deep (metres) gets the full darkening
  for (let k = 0; k < V * V; k++) {
    if (!valid[k]) continue;
    const occ = clamp01((blur[k] - h[k]) / depth);   // > 0 only where the point is below its surroundings
    const a = 1 - ao.strength * occ;
    col[k * 3] *= a; col[k * 3 + 1] *= a; col[k * 3 + 2] *= a;
  }
}

    if (cov) {                                              // tuck covered vertices under the sharper layer
      for (let k = 0; k < V * V; k++) if (cov[k]) pos[k * 3 + 1] -= TUCK;
    }

    const skirt = Math.max(8, step * res * M * VERT_EXAG);
    const edge = [(k) => k, (k) => (V - 1) * V + k, (k) => k * V, (k) => k * V + V - 1];
    for (let e = 0; e < 4; e++) {
      for (let k = 0; k < V; k++) {
        const g = edge[e](k), s = V * V + e * V + k;
        pos[s * 3] = pos[g * 3]; pos[s * 3 + 1] = pos[g * 3 + 1] - skirt; pos[s * 3 + 2] = pos[g * 3 + 2];
        nor[s * 3 + 1] = 1;
        col[s * 3] = col[g * 3]; col[s * 3 + 1] = col[g * 3 + 1]; col[s * 3 + 2] = col[g * 3 + 2];
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    if (bad === 0 && !cov) geo.setIndex(layer.sharedIndex ??= buildIndex(V, null, null));
    else geo.setIndex(buildIndex(V, valid, cov));
    const mesh = new THREE.Mesh(geo, this.matFor(order));
    mesh.frustumCulled = false;                             // refine() does the culling
    mesh.visible = false;
    return mesh;
  }

  // ---- level of detail ---------------------------------------------------

      select(layer, L, x, y, next, now) {
    const t = this.getTile(layer, L, x, y);
    t.used = this.frame;
    if (t.state !== 'ready') return;                        // 'empty' = no data here, draw nothing
    // a viewpoint "sees" a tile if the tile is in its frustum, or (for a ring view) within its radius
    const seen = (box) => this.views.filter((v) =>
      v.frustum ? v.frustum.intersectsBox(box) : box.distanceToPoint(v.pos) < v.radius);
    const vis = seen(t.box);
    if (!vis.length) return;
    const lv = layer.levels[L];
    const cellM = lv.step * layer.res * M;
    const forced = L > Math.max(layer.minLevel, 2) && this.overlapsHigher(layer, t);   // keep holes accurate
    const tooCoarse = vis.some((v) => (cellM * v.k) / Math.max(t.box.distanceToPoint(v.pos), 1) > MAX_ERR_PX);
    if (L > layer.minLevel && (forced || tooCoarse)) {
      const cl = layer.levels[L - 1], kids = [];
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const cx = 2 * x + dx, cy = 2 * y + dy;
        if (cx >= cl.tilesX || cy >= cl.tilesY) continue;
        const kid = this.getTile(layer, L - 1, cx, cy);
        if (!seen(kid.box).length) continue;
        kid.used = this.frame;
        kids.push(kid);
        if (kid.state === 'idle' && this.inFlight < MAX_IN_FLIGHT && now >= kid.retryAt) this.load(layer, kid);
      }
      const missingOk = (L - 1) >= layer.globalLevel;
      if (kids.length && kids.every((kd) => kd.state === 'ready' || (missingOk && kd.state === 'empty'))) {
        for (const kd of kids) if (kd.state === 'ready') this.select(layer, kd.L, kd.x, kd.y, next, now);
        return;
      }
    }
    next.add(t);
  }

  refine() {
    const cam = this.ctx.camera;
    if (!cam || !this.alive) return;
    this.frame++;
    const now = performance.now();
    const full = this.ctx.renderer?.domElement?.clientHeight || window.innerHeight;
    const kOf = (c, px) => px / (2 * Math.tan(THREE.MathUtils.degToRad(c.fov ?? 50) / 2));
    const view = (c, px) => {
      c.updateMatrixWorld();
      const pv = new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
      return { frustum: new THREE.Frustum().setFromProjectionMatrix(pv), pos: c.getWorldPosition(new THREE.Vector3()), k: kOf(c, px), radius: 0 };
    };

    this.views = [view(cam, full)];
    const extra = lodViews;
    if (this._nExtra !== extra.length) { console.log('[terrain] extra views:', extra.length); this._nExtra = extra.length; }
    const flat = (c) => { const p = c.getWorldPosition(new THREE.Vector3()); p.y = THREE.MathUtils.clamp(p.y, this.yLo, this.yHi); return p; };   // distance counts sideways only
    for (const c of extra) {
      this.views.push({ ...view(c, c.userData.viewHeight || full), pos: flat(c) });   // what the camera really sees
      const ring = c.userData.ringRadius;                                              // full detail all around it, any direction
      if (ring > 0) this.views.push({ frustum: null, pos: flat(c), k: kOf(c, c.userData.ringHeight || 1600), radius: ring });
    }

    const next = new Set();
    for (const l of this.layers) this.select(l, l.top, 0, 0, next, now);

    for (const t of this.drawn) if (!next.has(t) && t.mesh) t.mesh.visible = false;
    for (const t of next) t.mesh.visible = true;
    this.drawn = next;
    this.evict();
  }

  evict() {
    let total = 0;
    const old = [];
    for (const l of this.layers) {
      for (const t of l.tiles.values()) {
        if (t.state !== 'ready') continue;
        total++;
        if (t.L < l.top - 2 && !this.drawn.has(t) && this.frame - t.used > 20) old.push([l, t]);
      }
    }
    if (total <= CACHE_LIMIT) return;
    old.sort((a, b) => a[1].used - b[1].used);
    for (const [l, t] of old) {
      if (total-- <= CACHE_LIMIT) break;
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
      l.tiles.delete(t.key);
    }
  }

  // ---- height lookup (real metres) ---------------------------------------

  // Sharpest loaded tile of one layer at lon/lat, or null.
  layerSample(l, lon, lat) {
    const { S, V } = l;
    for (let L = l.minLevel; L <= l.top; L++) {
      const lv = l.levels[L];
      const c = (lon - l.lon0) / (l.res * lv.step), r = (l.lat0 - lat) / (l.res * lv.step);
      if (c < 0 || r < 0 || c > lv.cols - 1 || r > lv.rows - 1) return null;
      const tx = Math.min(Math.floor(c / S), lv.tilesX - 1), ty = Math.min(Math.floor(r / S), lv.tilesY - 1);
      const t = l.tiles.get(`${L}/${tx}/${ty}`);
      if (!t || t.state !== 'ready') continue;
      const fx = Math.min(c - tx * S, V - 1.001), fz = Math.min(r - ty * S, V - 1.001);
      const i0 = Math.floor(fx), j0 = Math.floor(fz), ax = fx - i0, az = fz - j0, h = t.h;
      const val = (h[j0 * V + i0] * (1 - ax) + h[j0 * V + i0 + 1] * ax) * (1 - az) +
                  (h[(j0 + 1) * V + i0] * (1 - ax) + h[(j0 + 1) * V + i0 + 1] * ax) * az;
      return val === val ? { h: val, layer: l.name, order: l.order } : null;
    }
    return null;
  }

  // Sharpest layer first, falling back to the coarser one where the sharp layer has no data.
  sample(lon, lat) {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const r = this.layerSample(this.layers[i], lon, lat);
      if (r) return r;
    }
    return null;
  }

  // ---- exact data for planning -------------------------------------------

  // Real metres on a regular grid of the SHARPEST layer, independent of the camera.
  // Element (r, c) is the height at source pixel (gx0 + c * 2^level, gz0 + r * 2^level). NaN = no data.
  // level 0 = full detail. Does not fall back to the regional layer.
  async sampleRegion(gx0, gz0, cols, rows, level = 0) {
    const ref = this.ref, lv = ref.levels[level], { S, V } = ref, s = lv.step;
    const c0 = Math.round(gx0 / s), r0 = Math.round(gz0 / s);
    const out = new Float32Array(cols * rows).fill(NaN);
    const cA = Math.max(c0, 0), rA = Math.max(r0, 0);
    const cB = Math.min(c0 + cols - 1, lv.cols - 1), rB = Math.min(r0 + rows - 1, lv.rows - 1);
    if (cB < cA || rB < rA) return out;

    const tIdx = (v, n) => Math.min(Math.floor(v / S), n - 1);
    const need = new Map();                                 // key -> Float32Array | null (empty) | undefined (not fetched)
    for (let ty = tIdx(rA, lv.tilesY); ty <= tIdx(rB, lv.tilesY); ty++) {
      for (let tx = tIdx(cA, lv.tilesX); tx <= tIdx(cB, lv.tilesX); tx++) {
        const key = `${level}/${tx}/${ty}`, ex = ref.tiles.get(key);
        need.set(key, ex?.state === 'ready' ? ex.h : ex?.state === 'empty' ? null : undefined);
      }
    }
    const todo = [...need].filter(([, h]) => h === undefined).map(([key]) => key);
    for (let i = 0; i < todo.length; i += MAX_IN_FLIGHT) {
      await Promise.all(todo.slice(i, i + MAX_IN_FLIGHT).map(async (key) => {
        const [, x, y] = key.split('/').map(Number);
        need.set(key, await this.fetchHeights(ref, level, x, y));
      }));
    }
    for (let r = 0; r < rows; r++) {
      const rj = r0 + r;
      if (rj < 0 || rj >= lv.rows) continue;
      const ty = tIdx(rj, lv.tilesY);
      for (let c = 0; c < cols; c++) {
        const ci = c0 + c;
        if (ci < 0 || ci >= lv.cols) continue;
        const tx = tIdx(ci, lv.tilesX);
        const h = need.get(`${level}/${tx}/${ty}`);
        if (h) out[r * cols + c] = h[(rj - ty * S) * V + (ci - tx * S)];
      }
    }
    return out;
  }

  dispose() {
    super.dispose();
    this.alive = false;
    clearInterval(this.timer);
    if (!this.group) return;
    this.ctx.scene.remove(this.group);
    for (const l of this.layers) for (const t of l.tiles.values()) if (t.mesh) t.mesh.geometry.dispose();
    for (const m of this.mats) m?.dispose();
  }
}