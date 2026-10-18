import * as THREE from 'three';
import { Module } from '../../core/Module.js';

const R = 3396.19;                 // km (1 scene unit = 1 km)
const RM = 3396190;                // metres
const D2R = Math.PI / 180;
const EYE_M = -70;                 // eye height above the ground
const START = { lon: 77.45, lat: 18.44 };   // near the Perseverance landing site (approximate)
const MAX_ERR_PX = 6, MAX_IN_FLIGHT = 8, CACHE_LIMIT = 200;
const TUCK_M = 150;                // global vertices under a sharper patch are lowered this much
const TILES = (import.meta.env.VITE_TILES_URL ?? `${import.meta.env.BASE_URL}tiles/`).replace(/\/?$/, '/');
const LAYERS = [                   // later entries are sharper and win where they have data
  { name: 'Global MOLA+HRSC', path: 'global' },
  { name: 'HiRISE DTM', path: 'hirise' },
];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ll2v = (lon, lat, r, out = new THREE.Vector3()) => {
  const la = lat * D2R, lo = lon * D2R;
  return out.set(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
};

function buildIndex(N, valid, cov) {
  const out = new Uint32Array(((N - 1) * (N - 1) + 4 * (N - 1)) * 6);
  let n = 0;
  const ok = (k) => !valid || valid[k] === 1;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    if (!(ok(a) && ok(b) && ok(c) && ok(d))) continue;
    if (cov && cov[a] && cov[b] && cov[c] && cov[d]) continue;     // hole under a sharper layer
    out[n++] = a; out[n++] = c; out[n++] = b; out[n++] = b; out[n++] = c; out[n++] = d;
  }
  const edge = [(k) => k, (k) => (N - 1) * N + k, (k) => k * N, (k) => k * N + N - 1];
  for (let e = 0; e < 4; e++) for (let k = 0; k < N - 1; k++) {
    const a = edge[e](k), b = edge[e](k + 1);
    if (!(ok(a) && ok(b))) continue;
    if (cov && cov[a] && cov[b]) continue;
    const sa = N * N + e * N + k, sb = sa + 1;
    out[n++] = a; out[n++] = sa; out[n++] = b; out[n++] = b; out[n++] = sa; out[n++] = sb;
  }
  return new THREE.BufferAttribute(n === out.length ? out : out.slice(0, n), 1);
}

export class WorldModule extends Module {
  static id = 'world';

  async init() {
    this.alive = true;
    this.layers = [];
    for (let i = 0; i < LAYERS.length; i++) {
      try { this.layers.push(await this.loadLayer(LAYERS[i], i)); }
      catch (e) {
        if (i === 0) throw new Error(`World tiles not found (${e.message}). Check VITE_TILES_URL and C:\\mars-tiles\\global`);
        console.warn(`[world] layer "${LAYERS[i].name}" skipped: ${e.message}`);
      }
    }
    const g = this.layers[0];
    this.V = g.V;
    this.minM = g.minM; this.span = Math.max(g.maxM - g.minM, 1);

    this.lut = new Float32Array(256 * 3);
    const stops = [0x1f2a44, 0x5a3a2a, 0x9a5a35, 0xc98d55, 0xe8d3b0, 0xffffff].map((h) => new THREE.Color(h));
    const c = new THREE.Color();
    for (let i = 0; i < 256; i++) {
      const t = (i / 255) * (stops.length - 1), k = Math.min(Math.floor(t), stops.length - 2);
      c.copy(stops[k]).lerp(stops[k + 1], t - k);
      this.lut.set([c.r, c.g, c.b], i * 3);
    }

    const N = this.V, idx = new Uint32Array(((N - 1) * (N - 1) + 4 * (N - 1)) * 6);
    let n = 0;
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, cc = a + N, d = cc + 1;
      idx[n++] = a; idx[n++] = cc; idx[n++] = b; idx[n++] = b; idx[n++] = cc; idx[n++] = d;
    }
    const edge = [(k) => k, (k) => (N - 1) * N + k, (k) => k * N, (k) => k * N + N - 1];
    this.edge = edge;
    for (let e = 0; e < 4; e++) for (let k = 0; k < N - 1; k++) {
      const a = edge[e](k), b = edge[e](k + 1), sa = N * N + e * N + k, sb = sa + 1;
      idx[n++] = a; idx[n++] = sa; idx[n++] = b; idx[n++] = b; idx[n++] = sa; idx[n++] = sb;
    }
    this.sharedIndex = new THREE.BufferAttribute(idx, 1);

    this.drawn = new Set(); this.inFlight = 0; this.frame = 0;
    this.frustum = new THREE.Frustum(); this.pv = new THREE.Matrix4(); this.camPos = new THREE.Vector3();
    this.keys = new Set(); this.groundM = null; this.eye = EYE_M;
    this.group = new THREE.Group();
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
    const { scene, camera } = this.ctx;
    scene.add(this.group);

    this.extras = [];
    let hasLight = false;
    scene.traverse((o) => { if (o.isLight) hasLight = true; });
    if (!hasLight) {
      this.sun = new THREE.DirectionalLight(0xfff0dd, 3);
      const amb = new THREE.AmbientLight(0x606070, 0.9);
      scene.add(this.sun, amb); this.extras.push(this.sun, amb);
    }

    // every layer's coarsest tile first (the holes need the sharper layers' roots)
    for (const l of this.layers) {
      const root = this.getTile(l, l.top, 0, 0);
      l.rootH = await this.fetchHeights(l, l.top, 0, 0);
      if (!l.rootH) throw new Error(`root tile missing for ${l.name}`);
      root.h = l.rootH;
    }
    for (const l of this.layers) {
      const root = this.getTile(l, l.top, 0, 0);
      root.mesh = this.makeMesh(l, root); root.state = 'ready';
      this.group.add(root.mesh);
    }

    this.walk = { lon: START.lon, lat: START.lat, heading: 0, pitch: 0 };
    this.orbit = { lon: 77.403, lat: 18.488, alt: 30, tilt: 0, heading: 0 };
    this.mode = 'orbit';
    this.applyMode();

    this.ctx.state.set('world', {
      sample: (lon, lat) => this.sample(lon, lat),
      heightAtLonLat: (lon, lat) => this.sample(lon, lat)?.h ?? NaN,
      lonLatToVec3: (lon, lat, elevM = 0) => ll2v(lon, lat, R + elevM / 1000),
      layers: this.layers.map((l) => l.name),
    });
    if (import.meta.env.DEV) window.world = this;

    const hud = this.hud = document.createElement('div');
    hud.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:10;font:12px/1.5 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.55);padding:8px 10px;border-radius:6px;pointer-events:none;white-space:pre';
    document.body.appendChild(hud);

    const box = this.goto = document.createElement('input');
    box.placeholder = 'lat, lon [, alt km]   e.g. 18.44, 77.45, 2';
    box.style.cssText = 'position:fixed;left:12px;top:12px;z-index:10;width:300px;padding:6px 8px;font:13px system-ui,sans-serif;border-radius:6px;border:1px solid #888;background:rgba(0,0,0,.6);color:#fff';
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      const n = box.value.match(/-?\d+(\.\d+)?/g)?.map(Number);
      if (!n || n.length < 2 || Math.abs(n[0]) > 90) { box.style.borderColor = 'red'; return; }
      box.style.borderColor = '#888';
      this.flyTo(n[0], n[1], n[2]);
      box.blur();
    });
    box.addEventListener('keyup', (e) => e.stopPropagation());
    document.body.appendChild(box);

    let drag = null;
    this._down = (e) => { if (e.target.tagName === 'CANVAS') drag = [e.clientX, e.clientY]; };
    this._up = () => { drag = null; };
    this._move = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag[0], dy = e.clientY - drag[1];
      drag = [e.clientX, e.clientY];
      if (this.mode === 'walk') {
        this.walk.heading += dx * 0.2;
        this.walk.pitch = Math.max(-85, Math.min(85, this.walk.pitch - dy * 0.2));
      } else if (e.shiftKey) { this.orbit.heading += dx * 0.3; this.orbit.tilt += dy * 0.3; }
      else {
        const k = 0.15 * Math.min(1, this.orbit.alt / R) + 0.003;
        this.orbit.lon -= dx * k; this.orbit.lat += dy * k;
      }
    };
    this._wheel = (e) => {
      if (e.target.tagName !== 'CANVAS') return;
      if (this.mode === 'orbit') this.orbit.alt *= Math.exp(e.deltaY * 0.001);
      else this.eye = Math.max(EYE_M, Math.min(50000, this.eye * Math.exp(e.deltaY * 0.001)));
      e.preventDefault();
    };
    this._kd = (e) => {
      if (/INPUT|TEXTAREA/.test(e.target.tagName)) return;
      const key = e.key.toLowerCase();
      if (key === 'v' && !e.repeat) this.setMode(this.mode === 'walk' ? 'orbit' : 'walk');
      this.keys.add(key);
    };
    this._ku = (e) => this.keys.delete(e.key.toLowerCase());
    this._blur = () => this.keys.clear();
    window.addEventListener('pointerdown', this._down); window.addEventListener('pointerup', this._up);
    window.addEventListener('pointermove', this._move); window.addEventListener('wheel', this._wheel, { passive: false });
    window.addEventListener('keydown', this._kd); window.addEventListener('keyup', this._ku); window.addEventListener('blur', this._blur);

    let last = performance.now(), hudN = 0;
    const loop = (now) => {
      if (!this.alive) return;
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (this.mode === 'walk') this.updateWalk(dt, camera); else this.poseOrbit(camera);
      this.updateSun(camera);
      if (hudN++ % 10 === 0) this.updateHud();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);

    this.refine();
    this.timer = setInterval(() => this.refine(), 100);
  }

  // ---------- layers and tiles ----------
  async loadLayer(def, order) {
    const base = TILES + def.path + '/';
    const res = await fetch(base + 'index.json');
    if (!res.ok) throw new Error(`${base}index.json -> HTTP ${res.status}`);
    const idx = await res.json();
    const f = Math.abs(idx.bbox[0]) > 400 || Math.abs(idx.bbox[3]) > 400 ? 1 / RM / D2R : 1;   // metres -> degrees
    const L = {
      name: def.name, order, base, S: idx.tileCells, V: idx.verts,
      res: Math.abs(idx.pixelSize) * f, lon0: idx.bbox[0] * f, lat0: idx.bbox[3] * f,
      levels: idx.levels, minLevel: idx.minLevel ?? 0, top: idx.levels.length - 1,
      globalLevel: idx.region ? idx.globalLevel : 0, minM: idx.minM, maxM: idx.maxM,
      tiles: new Map(), rootH: null,
    };
    L.fp = { lonMin: L.lon0, lonMax: L.lon0 + (idx.srcWidth - 1) * L.res, latMax: L.lat0, latMin: L.lat0 - (idx.srcHeight - 1) * L.res };
    return L;
  }

  getTile(layer, L, x, y) {
    const key = `${L}/${x}/${y}`;
    let t = layer.tiles.get(key);
    if (t) return t;
    const lv = layer.levels[L], { S, res, lon0, lat0 } = layer;
    const c0 = x * S, c1 = Math.min((x + 1) * S, lv.cols - 1), r0 = y * S, r1 = Math.min((y + 1) * S, lv.rows - 1);
    const lonOf = (c) => lon0 + c * lv.step * res, latOf = (r) => lat0 - r * lv.step * res;
    const origin = ll2v(lonOf((c0 + c1) / 2), latOf((r0 + r1) / 2), R);
    let rad = 0;
    for (const [c, r] of [[c0, r0], [c1, r0], [c0, r1], [c1, r1]]) rad = Math.max(rad, ll2v(lonOf(c), latOf(r), R).distanceTo(origin));
    t = {
      key, L, x, y, state: 'idle', h: null, mesh: null, used: this.frame, retryAt: 0,
      origin, dir: origin.clone().normalize(), sphere: new THREE.Sphere(origin.clone(), rad + 40),
      lonA: lonOf(c0), lonB: lonOf(c1), latA: latOf(r0), latB: latOf(r1),
    };
    layer.tiles.set(key, t);
    return t;
  }

  async fetchHeights(layer, L, x, y) {
    const { V } = layer;
    const res = await fetch(`${layer.base}${L}/${x}_${y}.bin`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    if (buf.byteLength !== 8 + V * V * 2) return null;
    const dv = new DataView(buf), lo = dv.getFloat32(0, true), hi = dv.getFloat32(4, true);
    const q = new Uint16Array(buf, 8, V * V), k = (hi - lo) / 65534, h = new Float32Array(V * V);
    for (let i = 0; i < h.length; i++) { const v = q[i]; h[i] = v === 0 ? NaN : lo + (v - 1) * k; }
    return h;
  }

  async load(layer, t) {
    t.state = 'loading'; this.inFlight++;
    try {
      const h = await this.fetchHeights(layer, t.L, t.x, t.y);
      if (!this.alive) return;
      if (h === null) { t.state = 'empty'; return; }
      t.h = h; t.mesh = this.makeMesh(layer, t); this.group.add(t.mesh); t.state = 'ready';
    } catch (e) {
      t.state = 'idle'; t.retryAt = performance.now() + 3000; console.warn('world tile failed, retrying', layer.name, t.key, e);
    } finally { this.inFlight--; }
  }

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

  makeMesh(layer, t) {
    const { V, S, res, lon0, lat0 } = layer;
    const lv = layer.levels[t.L], step = lv.step, h = t.h, o = t.origin, { minM, span, lut } = this;
    const nV = V * V + 4 * V;
    const pos = new Float32Array(nV * 3), nor = new Float32Array(nV * 3), col = new Float32Array(nV * 3);
    const valid = new Uint8Array(V * V);
    const useCov = this.overlapsHigher(layer, t);
    let cov = null, bad = 0;
    const v = new THREE.Vector3();
    for (let j = 0; j < V; j++) {
      const lat = lat0 - Math.min(t.y * S + j, lv.rows - 1) * step * res;
      for (let i = 0; i < V; i++) {
        const k = j * V + i, lon = lon0 + Math.min(t.x * S + i, lv.cols - 1) * step * res;
        let e = h[k];
        if (e !== e) { bad++; e = 0; } else valid[k] = 1;
        ll2v(lon, lat, R + e / 1000, v);
        pos[k * 3] = v.x - o.x; pos[k * 3 + 1] = v.y - o.y; pos[k * 3 + 2] = v.z - o.z;
        const q = Math.round(clamp01((e - minM) / span) * 255) * 3;
        col[k * 3] = lut[q]; col[k * 3 + 1] = lut[q + 1]; col[k * 3 + 2] = lut[q + 2];
        if (useCov && valid[k] && this.covered(lon, lat, layer.order)) { if (!cov) cov = new Uint8Array(V * V); cov[k] = 1; }
      }
    }
    for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
      const k = j * V + i, a = j * V + Math.max(i - 1, 0), b = j * V + Math.min(i + 1, V - 1);
      const c = Math.max(j - 1, 0) * V + i, d = Math.min(j + 1, V - 1) * V + i;
      const t1x = pos[b * 3] - pos[a * 3], t1y = pos[b * 3 + 1] - pos[a * 3 + 1], t1z = pos[b * 3 + 2] - pos[a * 3 + 2];
      const t2x = pos[d * 3] - pos[c * 3], t2y = pos[d * 3 + 1] - pos[c * 3 + 1], t2z = pos[d * 3 + 2] - pos[c * 3 + 2];
      let nx = t2y * t1z - t2z * t1y, ny = t2z * t1x - t2x * t1z, nz = t2x * t1y - t2y * t1x;
      let l = Math.hypot(nx, ny, nz);
      const ax = pos[k * 3] + o.x, ay = pos[k * 3 + 1] + o.y, az = pos[k * 3 + 2] + o.z;
      if (l < 1e-12) { nx = ax; ny = ay; nz = az; l = Math.hypot(ax, ay, az) || 1; }
      else if (nx * ax + ny * ay + nz * az < 0) { nx = -nx; ny = -ny; nz = -nz; }
      nor[k * 3] = nx / l; nor[k * 3 + 1] = ny / l; nor[k * 3 + 2] = nz / l;
    }
    if (cov) {                                  // tuck covered vertices under the sharper layer
      for (let k = 0; k < V * V; k++) {
        if (!cov[k]) continue;
        const ax = pos[k * 3] + o.x, ay = pos[k * 3 + 1] + o.y, az = pos[k * 3 + 2] + o.z, len = Math.hypot(ax, ay, az) || 1, f = TUCK_M / 1000 / len;
        pos[k * 3] -= ax * f; pos[k * 3 + 1] -= ay * f; pos[k * 3 + 2] -= az * f;
      }
    }
    const cellKm = step * res * R * D2R, depth = Math.max(0.02, cellKm * 3);
    for (let e = 0; e < 4; e++) for (let k = 0; k < V; k++) {
      const g = this.edge[e](k), s = V * V + e * V + k;
      const ax = pos[g * 3] + o.x, ay = pos[g * 3 + 1] + o.y, az = pos[g * 3 + 2] + o.z, len = Math.hypot(ax, ay, az) || 1, f = depth / len;
      pos[s * 3] = pos[g * 3] - ax * f; pos[s * 3 + 1] = pos[g * 3 + 1] - ay * f; pos[s * 3 + 2] = pos[g * 3 + 2] - az * f;
      nor[s * 3] = nor[g * 3]; nor[s * 3 + 1] = nor[g * 3 + 1]; nor[s * 3 + 2] = nor[g * 3 + 2];
      col[s * 3] = col[g * 3]; col[s * 3 + 1] = col[g * 3 + 1]; col[s * 3 + 2] = col[g * 3 + 2];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(bad === 0 && !cov ? this.sharedIndex : buildIndex(V, valid, cov));
    geo.computeBoundingSphere();
    t.sphere = new THREE.Sphere(geo.boundingSphere.center.clone().add(o), geo.boundingSphere.radius);
    t.dir = t.sphere.center.clone().normalize();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.copy(o);                      // 64-bit placement; vertices are tile-local
    mesh.frustumCulled = false; mesh.visible = false;
    return mesh;
  }

  // ---------- level of detail ----------
  visible(t) {
    if (!this.frustum.intersectsSphere(t.sphere)) return false;
    const a = Math.acos(Math.max(-1, Math.min(1, this.camPos.dot(t.dir) / this.d)));
    return a < this.horizon + Math.asin(Math.min(1, t.sphere.radius / R));
  }

  select(layer, L, x, y, next, now) {
    const t = this.getTile(layer, L, x, y);
    t.used = this.frame;
    if (t.state !== 'ready' || !this.visible(t)) return;
    const lv = layer.levels[L];
    const dist = Math.max(this.camPos.distanceTo(t.sphere.center) - t.sphere.radius, 0.0005);
    const cellKm = lv.step * layer.res * R * D2R;
    const forced = L > Math.max(layer.minLevel, 2) && this.overlapsHigher(layer, t);   // keep holes accurate
    if (L > layer.minLevel && (forced || (cellKm * this.k) / dist > MAX_ERR_PX)) {
      const cl = layer.levels[L - 1], kids = [];
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const cx = 2 * x + dx, cy = 2 * y + dy;
        if (cx >= cl.tilesX || cy >= cl.tilesY) continue;
        const kid = this.getTile(layer, L - 1, cx, cy);
        if (!this.visible(kid)) continue;
        kid.used = this.frame; kids.push(kid);
        if (kid.state === 'idle' && this.inFlight < MAX_IN_FLIGHT && now >= kid.retryAt) this.load(layer, kid);
      }
      const missingOk = (L - 1) >= layer.globalLevel;       // below that level a missing tile means "not built", not "no data"
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
    this.d = this.camPos.length();
    this.horizon = Math.acos(Math.min(1, R / this.d)) + 0.03;
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
    for (const l of this.layers) for (const t of l.tiles.values()) {
      if (t.state !== 'ready') continue;
      total++;
      if (t.L < l.top - 2 && !this.drawn.has(t) && this.frame - t.used > 20) old.push([l, t]);
    }
    if (total <= CACHE_LIMIT) return;
    old.sort((a, b) => a[1].used - b[1].used);
    for (const [l, t] of old) {
      if (total-- <= CACHE_LIMIT) break;
      this.group.remove(t.mesh); t.mesh.geometry.dispose(); l.tiles.delete(t.key);
    }
  }

  // ---------- height lookup (real metres, sharpest loaded tile, sharpest layer first) ----------
  layerSample(l, lon, lat) {
    const { S, V } = l;
    for (let L = l.minLevel; L <= l.top; L++) {
      const lv = l.levels[L], c = (lon - l.lon0) / (l.res * lv.step), r = (l.lat0 - lat) / (l.res * lv.step);
      if (c < 0 || r < 0 || c > lv.cols - 1 || r > lv.rows - 1) return null;
      const tx = Math.min(Math.floor(c / S), lv.tilesX - 1), ty = Math.min(Math.floor(r / S), lv.tilesY - 1);
      const t = l.tiles.get(`${L}/${tx}/${ty}`);
      if (!t || t.state !== 'ready') continue;
      const fx = Math.min(c - tx * S, V - 1.001), fz = Math.min(r - ty * S, V - 1.001);
      const i0 = Math.floor(fx), j0 = Math.floor(fz), ax = fx - i0, az = fz - j0, h = t.h;
      const val = (h[j0 * V + i0] * (1 - ax) + h[j0 * V + i0 + 1] * ax) * (1 - az) + (h[(j0 + 1) * V + i0] * (1 - ax) + h[(j0 + 1) * V + i0 + 1] * ax) * az;
      return val === val ? { h: val, layer: l.name, cellM: lv.step * l.res * RM * D2R } : null;
    }
    return null;
  }

  sample(lon, lat) {
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    for (let i = this.layers.length - 1; i >= 0; i--) { const r = this.layerSample(this.layers[i], lon, lat); if (r) return r; }
    return null;
  }

  compare(lon, lat) { return this.layers.map((l) => ({ layer: l.name, ...this.layerSample(l, lon, lat) })); }   // console check of seam heights

  // fly the orbit camera to lat/lon (degrees, east positive) at altitude in km
  flyTo(lat, lon, alt = 2) {
    if (this.mode !== 'orbit') this.setMode('orbit');
    const o = this.orbit, from = { lon: o.lon, lat: o.lat, alt: o.alt };
    const to = { lat: Math.max(-85, Math.min(85, lat)), lon, alt: Math.max(1, alt) };
    let dLon = to.lon - from.lon; dLon = ((dLon + 180) % 360 + 360) % 360 - 180;
    o.tilt = 0;
    const t0 = performance.now(), dur = 2500;
    cancelAnimationFrame(this._fly);
    const step = (now) => {
      if (!this.alive) return;
      const u = Math.min(1, (now - t0) / dur), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      o.lon = from.lon + dLon * e;
      o.lat = from.lat + (to.lat - from.lat) * e;
      o.alt = Math.exp(Math.log(from.alt) + (Math.log(to.alt) - Math.log(from.alt)) * e);
      if (u < 1) this._fly = requestAnimationFrame(step);
    };
    this._fly = requestAnimationFrame(step);
  }

  // ---------- camera ----------
  updateWalk(dt, camera) {
    const w = this.walk, K = this.keys;
    const run = K.has('shift') ? 10 : K.has('f') ? 100 : 1;
    const fwd = (K.has('w') || K.has('arrowup') ? 1 : 0) - (K.has('s') || K.has('arrowdown') ? 1 : 0);
    const side = (K.has('d') ? 1 : 0) - (K.has('a') ? 1 : 0);
    if (K.has('arrowleft')) w.heading -= 60 * dt;
    if (K.has('arrowright')) w.heading += 60 * dt;
    if (fwd || side) {
      const hd = w.heading * D2R, v = 2 * run * dt * Math.max(1, this.eye / 2);                 // 2 m/s walking pace
      w.lat = Math.max(-89, Math.min(89, w.lat + ((fwd * Math.cos(hd) - side * Math.sin(hd)) * v) / RM / D2R));
      w.lon += ((fwd * Math.sin(hd) + side * Math.cos(hd)) * v) / (RM * Math.cos(w.lat * D2R)) / D2R;
    }
    const s = this.sample(w.lon, w.lat);
    if (s) this.groundM = this.groundM === null || Math.abs(s.h - this.groundM) > 30 ? s.h : this.groundM + (s.h - this.groundM) * Math.min(1, dt * 8);
    const climb = (K.has('e') ? 1 : 0) - (K.has('q') ? 1 : 0);
    if (climb) this.eye = Math.max(EYE_M, Math.min(50000, this.eye * Math.exp(climb * 1.2 * dt)));
    const fog = this.ctx.scene.fog;
    if (fog) fog.density = Math.max(0.0003, 0.02 / (1 + this.eye / 50));
    const T = ll2v(w.lon, w.lat, R + ((this.groundM ?? 0) + this.eye) / 1000);
    const up = T.clone().normalize();
    const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
    const east = new THREE.Vector3().crossVectors(north, up);
    const hd = w.heading * D2R, pt = w.pitch * D2R;
    const fv = north.clone().multiplyScalar(Math.cos(hd)).addScaledVector(east, Math.sin(hd));
    const look = fv.multiplyScalar(Math.cos(pt)).addScaledVector(up, Math.sin(pt));
    camera.position.copy(T);
    camera.up.copy(up);
    camera.near = 0.0003; camera.far = 400;
    camera.lookAt(T.clone().add(look));
    camera.updateProjectionMatrix();
  }

  poseOrbit(camera) {
    const p = this.orbit;
    p.lat = Math.max(-85, Math.min(85, p.lat));
    p.alt = Math.max(1, Math.min(40000, p.alt));
    p.tilt = Math.max(0, Math.min(85, p.tilt));
    const T = ll2v(p.lon, p.lat, R), up = T.clone().normalize();
    const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
    const east = new THREE.Vector3().crossVectors(north, up);
    const h = p.heading * D2R, t = p.tilt * D2R;
    const fv = north.clone().multiplyScalar(Math.cos(h)).addScaledVector(east, Math.sin(h));
    camera.position.copy(T).addScaledVector(up, p.alt * Math.cos(t)).addScaledVector(fv, -p.alt * Math.sin(t));
    camera.near = Math.max(0.005, p.alt * 0.01); camera.far = R * 4 + p.alt;
    camera.up.copy(p.tilt < 2 ? fv : up);
    camera.lookAt(T);
    camera.updateProjectionMatrix();
  }

  setMode(m) {
    if (m === this.mode) return;
    if (m === 'orbit') Object.assign(this.orbit, { lon: this.walk.lon, lat: this.walk.lat, heading: this.walk.heading, alt: 80, tilt: 70 });
    else Object.assign(this.walk, { lon: this.orbit.lon, lat: this.orbit.lat, heading: this.orbit.heading, pitch: 0 });
    this.mode = m;
    this.applyMode();
  }

  applyMode() {
    const sc = this.ctx.scene;
    if (this.mode === 'walk') { sc.background = new THREE.Color(0xb98d62); sc.fog = new THREE.FogExp2(0xb98d62, 0.02); }
    else { sc.background = new THREE.Color(0x03040a); sc.fog = null; }
  }

  updateSun(camera) {
    if (!this.sun) return;
    const p = camera.position, up = p.clone().normalize();
    if (this.mode === 'walk') {                  // low sun from the west, about 30 degrees up
      const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
      const east = new THREE.Vector3().crossVectors(north, up);
      this.sun.position.copy(up).multiplyScalar(0.5).addScaledVector(east, -0.87).multiplyScalar(30000);
    } else {
      const l = p.length() || 1;
      this.sun.position.set(p.x + p.z * 0.6, p.y + l * 0.3, p.z - p.x * 0.6).multiplyScalar(1.5);
    }
  }

  updateHud() {
    const w = this.mode === 'walk' ? this.walk : this.orbit;
    const s = this.sample(w.lon, w.lat);
    const ns = w.lat >= 0 ? 'N' : 'S';
    this.hud.textContent =
      `${this.mode.toUpperCase()}   ${Math.abs(w.lat).toFixed(5)}Ã‚Â°${ns}  ${w.lon.toFixed(5)}Ã‚Â°E\n` +
      (s ? `ground ${s.h.toFixed(1)} m  |  ${s.layer}, ${s.cellM.toFixed(s.cellM < 10 ? 1 : 0)} m cells\n` : 'ground: loading...\n') +
      `W/A/S/D walk  Shift x10  F x100  drag = look  V = orbit/walk`;
  }

  dispose() {
    super.dispose();
    this.alive = false;
    clearInterval(this.timer); cancelAnimationFrame(this._raf);
    for (const [ev, fn] of [['pointerdown', this._down], ['pointerup', this._up], ['pointermove', this._move], ['wheel', this._wheel], ['keydown', this._kd], ['keyup', this._ku], ['blur', this._blur]]) window.removeEventListener(ev, fn);
    this.hud?.remove(); this.goto?.remove(); cancelAnimationFrame(this._fly);
    if (!this.group) return;
    this.ctx.scene.remove(this.group, ...this.extras);
    for (const l of this.layers) for (const t of l.tiles.values()) if (t.mesh) t.mesh.geometry.dispose();
    this.material.dispose();
  }
}
