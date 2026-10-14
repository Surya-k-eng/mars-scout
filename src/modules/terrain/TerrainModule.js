import * as THREE from 'three';
import { Module } from '../../core/Module.js';
import { EVENTS } from '../../core/events.js';

const VERT_EXAG = 4;        // display only; heightAt() and sampleRegion() return real metres
const MAX_ERR_PX = 4;       // a cell may span at most this many screen pixels before a sharper tile is used
const MAX_IN_FLIGHT = 8;    // parallel tile downloads
const CACHE_LIMIT = 120;    // tiles kept in memory (about 2-3 MB each, CPU + GPU)

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Triangle indices for one 257x257 tile, plus "skirt" strips that hide cracks between detail levels.
// valid = Uint8Array of vertices that have data (or null if all do); quads touching no-data are skipped.
function buildIndex(N, valid) {
  const out = new Uint32Array(((N - 1) * (N - 1) + 4 * (N - 1)) * 6);
  let n = 0;
  const ok = (k) => !valid || valid[k] === 1;
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      if (!(ok(a) && ok(b) && ok(c) && ok(d))) continue;
      out[n++] = a; out[n++] = c; out[n++] = b;
      out[n++] = b; out[n++] = c; out[n++] = d;
    }
  }
  const edge = [(k) => k, (k) => (N - 1) * N + k, (k) => k * N, (k) => k * N + N - 1];
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < N - 1; k++) {
      const a = edge[e](k), b = edge[e](k + 1);
      if (!(ok(a) && ok(b))) continue;
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
    this.base = `${import.meta.env.BASE_URL}tiles/hirise/`;

    let idx;
    try {
      const res = await fetch(this.base + 'index.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      idx = await res.json();
    } catch (e) {
      throw new Error(
        `HiRISE tiles not found at ${this.base}index.json (${e.message}). ` +
        `Generate them with data-prep/make-hirise-tiles.mjs.`
      );
    }
    this.S = idx.tileCells;            // 256 cells per tile
    this.V = idx.verts;                // 257 vertices per tile side
    this.W = idx.srcWidth;
    this.H = idx.srcHeight;
    this.px = idx.pixelSize;           // metres per source pixel (1)
    this.levels = idx.levels;
    this.top = idx.levels.length - 1;
    const { S, V, W, H, px, top } = this;

    this.tiles = new Map();
    this.drawn = new Set();
    this.inFlight = 0;
    this.frame = 0;
    this.frustum = new THREE.Frustum();
    this.pv = new THREE.Matrix4();
    this.camPos = new THREE.Vector3();

    // The coarsest tile covers the whole map. Use it for the reference elevation range.
    const rootH = await this.fetchHeights(top, 0, 0);
    if (!rootH) throw new Error('root terrain tile is missing or empty');
    let minE = Infinity, maxE = -Infinity;
    for (const v of rootH) if (v === v) { if (v < minE) minE = v; if (v > maxE) maxE = v; }
    this.minE = minE;
    this.maxE = maxE;
    this.span = Math.max(maxE - minE, 1e-6);
    this.yLo = -200;
    this.yHi = (maxE - minE) * VERT_EXAG + 200;

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
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
    this.sharedIndex = buildIndex(V, null);

    const root = this.getTile(top, 0, 0);
    root.h = rootH;
    root.mesh = this.makeMesh(root);
    root.mesh.visible = true;
    this.group.add(root.mesh);
    root.state = 'ready';
    this.drawn = new Set([root]);

    // Height in real metres at a source-pixel position, from the sharpest tile currently loaded.
    // NaN = no data. NOTE: what is loaded depends on the camera, so use sampleRegion() for planning.
    const heightAt = (gx, gz) => {
      gx = Math.min(Math.max(gx, 0), W - 1);
      gz = Math.min(Math.max(gz, 0), H - 1);
      for (let L = 0; L <= top; L++) {
        const lv = this.levels[L], s = lv.step;
        const cx = gx / s, cz = gz / s;
        const tx = Math.min(Math.floor(cx / S), lv.tilesX - 1);
        const ty = Math.min(Math.floor(cz / S), lv.tilesY - 1);
        const t = this.tiles.get(`${L}/${tx}/${ty}`);
        if (!t) continue;
        if (t.state === 'empty') return NaN;
        if (t.state !== 'ready') continue;
        const fx = Math.min(cx - tx * S, V - 1), fz = Math.min(cz - ty * S, V - 1);
        const i0 = Math.floor(fx), j0 = Math.floor(fz);
        const i1 = Math.min(i0 + 1, V - 1), j1 = Math.min(j0 + 1, V - 1);
        const ax = fx - i0, az = fz - j0, h = t.h;
        return (h[j0 * V + i0] * (1 - ax) + h[j0 * V + i1] * ax) * (1 - az) +
               (h[j1 * V + i0] * (1 - ax) + h[j1 * V + i1] * ax) * az;
      }
      return NaN;
    };

    const terrain = {
      id: 'jezero-hirise',
      width: W,
      height: H,
      cellSize: px,
      heights: null,                     // the full grid is never in memory; use heightAt / sampleRegion
      minElevationM: minE,               // taken from the coarsest tile (index.json has no global range)
      maxElevationM: maxE,
      vertExag: VERT_EXAG,
      heightAt,
      sampleRegion: (...a) => this.sampleRegion(...a),
      gridToWorld: (gx, gz) => {
        const h = heightAt(gx, gz);
        return {
          x: (gx - (W - 1) / 2) * px,
          y: ((h === h ? h : minE) - minE) * VERT_EXAG,
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

  // ---- tiles -------------------------------------------------------------

  getTile(L, x, y) {
    const key = `${L}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (!t) {
      const lv = this.levels[L], { S, W, H, px } = this;
      const wx = (c) => (c * lv.step - (W - 1) / 2) * px;
      const wz = (r) => (r * lv.step - (H - 1) / 2) * px;
      const c1 = Math.min((x + 1) * S, lv.cols - 1), r1 = Math.min((y + 1) * S, lv.rows - 1);
      t = {
        key, L, x, y, state: 'idle', h: null, mesh: null, used: this.frame, retryAt: 0,
        box: new THREE.Box3(
          new THREE.Vector3(wx(x * S), this.yLo, wz(y * S)),
          new THREE.Vector3(wx(c1), this.yHi, wz(r1))
        ),
      };
      this.tiles.set(key, t);
    }
    return t;
  }

  // Returns Float32Array of real metres (NaN = no data), or null if the tile doesn't exist / is all no-data
  async fetchHeights(L, x, y) {
    const { V } = this;
    const res = await fetch(`${this.base}${L}/${x}_${y}.bin`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength !== 8 + V * V * 2) return null;   // e.g. dev server answering a missing file with index.html
    const dv = new DataView(buf);
    const lo = dv.getFloat32(0, true), hi = dv.getFloat32(4, true);
    const q = new Uint16Array(buf, 8, V * V);
    const k = (hi - lo) / 65534;
    const h = new Float32Array(V * V);
    for (let i = 0; i < h.length; i++) { const v = q[i]; h[i] = v === 0 ? NaN : lo + (v - 1) * k; }
    return h;
  }

  async load(t) {
    t.state = 'loading';
    this.inFlight++;
    try {
      const h = await this.fetchHeights(t.L, t.x, t.y);
      if (!this.alive) return;
      if (h === null) { t.state = 'empty'; return; }
      t.h = h;
      t.mesh = this.makeMesh(t);
      this.group.add(t.mesh);
      t.state = 'ready';
    } catch (e) {
      t.state = 'idle';
      t.retryAt = performance.now() + 3000;
      console.warn('terrain tile failed, will retry', t.key, e);
    } finally {
      this.inFlight--;
    }
  }

  makeMesh(t) {
    const { V, S, W, H, px, minE, span } = this;
    const lv = this.levels[t.L], step = lv.step, cw = step * px;
    const h = t.h;
    const nV = V * V + 4 * V;                               // grid + 4 skirt strips
    const pos = new Float32Array(nV * 3);
    const nor = new Float32Array(nV * 3);
    const col = new Uint16Array(nV * 3);
    const valid = new Uint8Array(V * V);
    let bad = 0;
    const val = (i, j, fb) => { const v = h[j * V + i]; return v === v ? v : fb; };

    for (let j = 0; j < V; j++) {
      const rj = Math.min(t.y * S + j, lv.rows - 1);        // padded rows collapse onto the data edge
      const z = (rj * step - (H - 1) / 2) * px;
      for (let i = 0; i < V; i++) {
        const k = j * V + i, v = h[k];
        const ci = Math.min(t.x * S + i, lv.cols - 1);
        pos[k * 3] = (ci * step - (W - 1) / 2) * px;
        pos[k * 3 + 2] = z;
        if (v !== v) { bad++; nor[k * 3 + 1] = 1; continue; }  // no data: skipped by the index buffer
        valid[k] = 1;
        pos[k * 3 + 1] = (v - minE) * VERT_EXAG;

        const i1 = Math.max(i - 1, 0), i2 = Math.min(i + 1, V - 1);
        const j1 = Math.max(j - 1, 0), j2 = Math.min(j + 1, V - 1);
        const dx = (val(i2, j, v) - val(i1, j, v)) / ((i2 - i1) * cw) * VERT_EXAG;
        const dz = (val(i, j2, v) - val(i, j1, v)) / ((j2 - j1) * cw) * VERT_EXAG;
        const il = 1 / Math.hypot(dx, 1, dz);
        nor[k * 3] = -dx * il; nor[k * 3 + 1] = il; nor[k * 3 + 2] = -dz * il;

        const r = Math.round(clamp01((v - minE) / span) * 255) * 3;
        col[k * 3] = this.ramp[r]; col[k * 3 + 1] = this.ramp[r + 1]; col[k * 3 + 2] = this.ramp[r + 2];
      }
    }

    const skirt = Math.max(8, cw * VERT_EXAG);
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
    geo.setIndex(bad === 0 ? this.sharedIndex : buildIndex(V, valid));
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = false;                             // refine() does the culling
    mesh.visible = false;
    return mesh;
  }

  // ---- level of detail ---------------------------------------------------

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
    const k = viewH / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov ?? 50) / 2));
    const next = new Set();
    const want = (t) => {
      if (t.state === 'idle' && this.inFlight < MAX_IN_FLIGHT && now >= t.retryAt) this.load(t);
    };

    const select = (L, x, y) => {
      const t = this.getTile(L, x, y);
      t.used = this.frame;
      if (t.state !== 'ready') return;                      // 'empty' = no data here, draw nothing
      if (!this.frustum.intersectsBox(t.box)) return;
      const dist = Math.max(t.box.distanceToPoint(this.camPos), 1);
      // screen pixels spanned by one cell of this tile; too big means we need the sharper level
      if (L > 0 && this.levels[L].step * this.px * k / dist > MAX_ERR_PX) {
        const cl = this.levels[L - 1];
        const kids = [];
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const cx = 2 * x + dx, cy = 2 * y + dy;
          if (cx >= cl.tilesX || cy >= cl.tilesY) continue;
          const kid = this.getTile(L - 1, cx, cy);
          if (!this.frustum.intersectsBox(kid.box)) continue;
          kid.used = this.frame;
          kids.push(kid);
          want(kid);
        }
        // keep showing this tile until every sharper tile has arrived, so there are no holes
        if (kids.every((kd) => kd.state === 'ready' || kd.state === 'empty')) {
          for (const kd of kids) select(kd.L, kd.x, kd.y);
          return;
        }
      }
      next.add(t);
    };
    select(this.top, 0, 0);

    for (const t of this.drawn) if (!next.has(t) && t.mesh) t.mesh.visible = false;
    for (const t of next) t.mesh.visible = true;
    this.drawn = next;
    this.evict();
  }

  evict() {
    const ready = [];
    for (const t of this.tiles.values()) if (t.state === 'ready') ready.push(t);
    let n = ready.length;
    if (n <= CACHE_LIMIT) return;
    const old = ready
      .filter((t) => t.L < this.top - 2 && !this.drawn.has(t) && this.frame - t.used > 20)
      .sort((a, b) => a.used - b.used);
    for (const t of old) {
      if (n-- <= CACHE_LIMIT) break;
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
      this.tiles.delete(t.key);
    }
  }

  // ---- exact data for planning -------------------------------------------

  // Real metres on a regular grid, independent of the camera.
  // Element (r, c) is the height at source pixel (gx0 + c * 2^level, gz0 + r * 2^level). NaN = no data.
  // level 0 = full 1 m detail.
  async sampleRegion(gx0, gz0, cols, rows, level = 0) {
    const lv = this.levels[level], { S, V } = this, s = lv.step;
    const c0 = Math.round(gx0 / s), r0 = Math.round(gz0 / s);
    const out = new Float32Array(cols * rows).fill(NaN);
    const cA = Math.max(c0, 0), rA = Math.max(r0, 0);
    const cB = Math.min(c0 + cols - 1, lv.cols - 1), rB = Math.min(r0 + rows - 1, lv.rows - 1);
    if (cB < cA || rB < rA) return out;

    const tIdx = (v, n) => Math.min(Math.floor(v / S), n - 1);
    const need = new Map();                                  // key -> Float32Array | null (empty) | undefined (not fetched)
    for (let ty = tIdx(rA, lv.tilesY); ty <= tIdx(rB, lv.tilesY); ty++) {
      for (let tx = tIdx(cA, lv.tilesX); tx <= tIdx(cB, lv.tilesX); tx++) {
        const key = `${level}/${tx}/${ty}`, ex = this.tiles.get(key);
        need.set(key, ex?.state === 'ready' ? ex.h : ex?.state === 'empty' ? null : undefined);
      }
    }
    const todo = [...need].filter(([, h]) => h === undefined).map(([key]) => key);
    for (let i = 0; i < todo.length; i += MAX_IN_FLIGHT) {
      await Promise.all(todo.slice(i, i + MAX_IN_FLIGHT).map(async (key) => {
        const [, x, y] = key.split('/').map(Number);
        need.set(key, await this.fetchHeights(level, x, y));
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
    for (const t of this.tiles.values()) if (t.mesh) t.mesh.geometry.dispose();
    this.material.dispose();
  }
}