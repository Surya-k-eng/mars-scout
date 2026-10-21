import * as THREE from 'three';
import { Module } from '../../core/Module.js';
import { EVENTS } from '../../core/events.js';

// Flat, simple terrain (like the old TerrainModule) fed by two blended layers (like WorldModule).
// No camera control, no HUD, no fog: it only builds the ground and exposes height lookups.

const VERT_EXAG = 4;        // display only; heightAt() / sampleRegion() return real metres
const MAX_ERR_PX = 4;       // a cell may span at most this many screen pixels before a sharper tile is used
const MAX_IN_FLIGHT = 8;    // parallel tile downloads
const CACHE_LIMIT = 160;    // tiles kept in memory across both layers
const LIFT = 20;            // each sharper layer is drawn this much higher (display units) so it wins over the one below
const TUCK = 100;           // coarse vertices under a sharper layer are lowered this much (display units)

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

export class TerrainModule extends Module {
  static id = 'terrain';

  async init() {
    this.alive = true;
    this.layers = [];
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
    this.yLo = -200;
    this.yHi = (maxE - minE) * VERT_EXAG + 200 + LIFT * this.layers.length;

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
  covered(lon, lat, order) {
    for (const l of this.layers) {
      if (l.order <= order || !l.rootH) continue;
      const lv = l.levels[l.top];
      const i = Math.round((lon - l.lon0) / (l.res * lv.step)), j = Math.round((l.lat0 - lat) / (l.res * lv.step));
      if (i < 0 || j < 0 || i > lv.cols - 1 || j > lv.rows - 1) continue;
      const v = l.rootH[j * l.V + i];
      if (v === v) return true;
    }
    return false;
  }

  overlapsHigher(layer, t) {
    return this.layers.some((l) => l.order > layer.order && l.rootH &&
      t.lonB >= l.fp.lonMin && t.lonA <= l.fp.lonMax && t.latA >= l.fp.latMin && t.latB <= l.fp.latMax);
  }

  matFor(order) {
    return this.mats[order] ??= new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, side: THREE.DoubleSide,
      polygonOffset: order > 0, polygonOffsetFactor: -4 * order, polygonOffsetUnits: -4 * order,
    });
  }

  makeMesh(layer, t) {
    const { V, S, res, lon0, lat0, order } = layer;
    const lv = layer.levels[t.L], step = lv.step, h = t.h;
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
        if (useCov && this.covered(lon, lat, order)) { cov ??= new Uint8Array(V * V); cov[k] = 1; }
      }
    }

    // normals from neighbouring positions (needs all positions first)
    const yy = (n, fb) => (valid[n] ? pos[n * 3 + 1] : fb);
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < V; i++) {
        const k = j * V + i;
        if (!valid[k]) continue;
        const a = j * V + Math.max(i - 1, 0), b = j * V + Math.min(i + 1, V - 1);
        const c = Math.max(j - 1, 0) * V + i, d = Math.min(j + 1, V - 1) * V + i;
        const y0 = pos[k * 3 + 1];
        const t1x = pos[b * 3] - pos[a * 3], t1y = yy(b, y0) - yy(a, y0), t1z = pos[b * 3 + 2] - pos[a * 3 + 2];
        const t2x = pos[d * 3] - pos[c * 3], t2y = yy(d, y0) - yy(c, y0), t2z = pos[d * 3 + 2] - pos[c * 3 + 2];
        let nx = t2y * t1z - t2z * t1y, ny = t2z * t1x - t2x * t1z, nz = t2x * t1y - t2y * t1x;
        if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const l = Math.hypot(nx, ny, nz);
        if (l < 1e-12) { nor[k * 3 + 1] = 1; continue; }
        nor[k * 3] = nx / l; nor[k * 3 + 1] = ny / l; nor[k * 3 + 2] = nz / l;
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
    if (!this.frustum.intersectsBox(t.box)) return;
    const lv = layer.levels[L];
    const dist = Math.max(t.box.distanceToPoint(this.camPos), 1);
    const cellM = lv.step * layer.res * M;
    const forced = L > Math.max(layer.minLevel, 2) && this.overlapsHigher(layer, t);   // keep holes accurate
    if (L > layer.minLevel && (forced || (cellM * this.k) / dist > MAX_ERR_PX)) {
      const cl = layer.levels[L - 1], kids = [];
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const cx = 2 * x + dx, cy = 2 * y + dy;
        if (cx >= cl.tilesX || cy >= cl.tilesY) continue;
        const kid = this.getTile(layer, L - 1, cx, cy);
        if (!this.frustum.intersectsBox(kid.box)) continue;
        kid.used = this.frame;
        kids.push(kid);
        if (kid.state === 'idle' && this.inFlight < MAX_IN_FLIGHT && now >= kid.retryAt) this.load(layer, kid);
      }
      // below globalLevel a missing tile means "not built", not "no data"
      const missingOk = (L - 1) >= layer.globalLevel;
      // keep showing this tile until every sharper tile has arrived, so there are no holes
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
    cam.updateMatrixWorld();
    this.pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    cam.getWorldPosition(this.camPos);

    const viewH = this.ctx.renderer?.domElement?.clientHeight || window.innerHeight;
    this.k = viewH / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov ?? 50) / 2));

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