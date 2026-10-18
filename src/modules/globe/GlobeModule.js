import * as THREE from 'three';
import { Module } from '../../core/Module.js';

const R = 3396.19;          // km, Mars 2000 sphere (same as the data)
const EXAG = 10;            // display only
const MAX_ERR_PX = 4;       // a cell may span this many screen pixels before a sharper tile is used
const MAX_IN_FLIGHT = 8;
const CACHE_LIMIT = 100;
const D2R = Math.PI / 180;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// lon/lat (deg, east positive) -> scene position. +y = north pole, east is not mirrored.
const ll2v = (lon, lat, r, out = new THREE.Vector3()) => {
  const la = lat * D2R, lo = lon * D2R;
  return out.set(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
};

export class GlobeModule extends Module {
  static id = 'globe';

  async init() {
    this.alive = true;
    this.base = `${import.meta.env.BASE_URL}tiles/global/`;
    let idx;
    try {
      const res = await fetch(this.base + 'index.json');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      idx = await res.json();
    } catch (e) {
      throw new Error(`Global tiles not found at ${this.base}index.json (${e.message}). Run data-prep/make-global-tiles.mjs`);
    }
    this.S = idx.tileCells; this.V = idx.verts; this.res = idx.pixelSize;
    this.lon0 = idx.bbox[0]; this.lat0 = idx.bbox[3];
    this.levels = idx.levels; this.minLevel = idx.minLevel; this.top = idx.levels.length - 1;
    this.minM = idx.minM; this.maxM = idx.maxM; this.span = Math.max(idx.maxM - idx.minM, 1);
    const { V, top } = this;

    // elevation colour ramp
    const stops = [0x1f2a44, 0x5a3a2a, 0x9a5a35, 0xc98d55, 0xe8d3b0, 0xffffff].map((h) => new THREE.Color(h));
    this.lut = new Float32Array(256 * 3);
    const c = new THREE.Color();
    for (let i = 0; i < 256; i++) {
      const t = (i / 255) * (stops.length - 1), k = Math.min(Math.floor(t), stops.length - 2);
      c.copy(stops[k]).lerp(stops[k + 1], t - k);
      this.lut.set([c.r, c.g, c.b], i * 3);
    }

    // shared triangle list for a 257x257 tile, plus skirt strips
    const N = V;
    const ix = new Uint32Array(((N - 1) * (N - 1) + 4 * (N - 1)) * 6);
    let n = 0;
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, cc = a + N, d = cc + 1;
      ix[n++] = a; ix[n++] = cc; ix[n++] = b; ix[n++] = b; ix[n++] = cc; ix[n++] = d;
    }
    const edge = [(k) => k, (k) => (N - 1) * N + k, (k) => k * N, (k) => k * N + N - 1];
    this.edge = edge;
    for (let e = 0; e < 4; e++) for (let k = 0; k < N - 1; k++) {
      const a = edge[e](k), b = edge[e](k + 1), sa = N * N + e * N + k, sb = sa + 1;
      ix[n++] = a; ix[n++] = sa; ix[n++] = b; ix[n++] = b; ix[n++] = sa; ix[n++] = sb;
    }
    this.sharedIndex = new THREE.BufferAttribute(ix, 1);

    this.tiles = new Map(); this.drawn = new Set(); this.inFlight = 0; this.frame = 0;
    this.frustum = new THREE.Frustum(); this.pv = new THREE.Matrix4(); this.camPos = new THREE.Vector3();
    this.group = new THREE.Group();
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });

    const { scene, camera } = this.ctx;
    scene.add(this.group);
    scene.background = new THREE.Color(0x03040a);
    scene.fog = null;
    this.extras = [];
    let hasLight = false;
    scene.traverse((o) => { if (o.isLight) hasLight = true; });
    if (!hasLight) {
      const sun = new THREE.DirectionalLight(0xfff0dd, 3); sun.position.set(1, 0.3, 0.6).multiplyScalar(30000);
      const amb = new THREE.AmbientLight(0x404050, 0.6);
      scene.add(sun, amb); this.extras.push(sun, amb);
    }

    const root = this.getTile(top, 0, 0);
    const rh = await this.fetchHeights(top, 0, 0);
    if (!rh) throw new Error('root tile missing');
    root.h = rh; root.mesh = this.makeMesh(root); root.mesh.visible = true;
    this.group.add(root.mesh); root.state = 'ready'; this.drawn = new Set([root]);

    this.ctx.state.set('globe', {
      radiusKm: R, exaggeration: EXAG, minElevationM: this.minM, maxElevationM: this.maxM,
      heightAtLonLat: (lon, lat) => this.heightAtLonLat(lon, lat),
      lonLatToVec3: (lon, lat, elevM = 0) => ll2v(lon, lat, R + (elevM / 1000) * EXAG),
    });

    // ---- camera: orbit around the planet ----
    this.cam = { lon: 77.6, lat: 18.4, alt: 600, tilt: 65, heading: 0 };
    camera.up.set(0, 1, 0);
    const poseCamera = () => {
      const p = this.cam;
      p.lat = Math.max(-85, Math.min(85, p.lat));
      p.alt = Math.max(25, Math.min(40000, p.alt));
      p.tilt = Math.max(0, Math.min(85, p.tilt));
      const T = ll2v(p.lon, p.lat, R);
      const up = T.clone().normalize();
      const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
      const east = new THREE.Vector3().crossVectors(north, up);
      const h = p.heading * D2R, t = p.tilt * D2R;
      const fwd = north.clone().multiplyScalar(Math.cos(h)).addScaledVector(east, Math.sin(h));
      camera.position.copy(T).addScaledVector(up, p.alt * Math.cos(t)).addScaledVector(fwd, -p.alt * Math.sin(t));
      camera.near = Math.max(0.02, p.alt * 0.01);
      camera.far = R * 4 + p.alt;
      camera.up.copy(p.tilt < 2 ? fwd : up);
      camera.lookAt(T);
      camera.updateProjectionMatrix();
    };
    let drag = null;
    this._down = (e) => { if (e.target.tagName === 'CANVAS') drag = [e.clientX, e.clientY]; };
    this._up = () => { drag = null; };
    this._move = (e) => {
      if (!drag) return; if (e.shiftKey) { this.cam.heading += (e.clientX - drag[0]) * 0.3; this.cam.tilt += (e.clientY - drag[1]) * 0.3; drag = [e.clientX, e.clientY]; return; }
      const k = 0.15 * Math.min(1, this.cam.alt / R) + 0.003;
      this.cam.lon -= (e.clientX - drag[0]) * k;
      this.cam.lat += (e.clientY - drag[1]) * k;
      drag = [e.clientX, e.clientY];
    };
    this._wheel = (e) => { if (e.target.tagName === 'CANVAS') { this.cam.alt *= Math.exp(e.deltaY * 0.001); e.preventDefault(); } };
    window.addEventListener('pointerdown', this._down);
    window.addEventListener('pointerup', this._up);
    window.addEventListener('pointermove', this._move);
    window.addEventListener('wheel', this._wheel, { passive: false });
    const loop = () => { if (!this.alive) return; poseCamera(); this._raf = requestAnimationFrame(loop); };
    loop();

    this.refine();
    this.timer = setInterval(() => this.refine(), 100);
  }

  getTile(L, x, y) {
    const key = `${L}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (t) return t;
    const lv = this.levels[L], { S, res, lon0, lat0 } = this;
    const c0 = x * S, c1 = Math.min((x + 1) * S, lv.cols - 1), r0 = y * S, r1 = Math.min((y + 1) * S, lv.rows - 1);
    const lonOf = (c) => lon0 + c * lv.step * res, latOf = (r) => lat0 - r * lv.step * res;
    const center = ll2v(lonOf((c0 + c1) / 2), latOf((r0 + r1) / 2), R);
    let rad = 0;
    for (const [c, r] of [[c0, r0], [c1, r0], [c0, r1], [c1, r1]]) rad = Math.max(rad, ll2v(lonOf(c), latOf(r), R).distanceTo(center));
    t = {
      key, L, x, y, state: 'idle', h: null, mesh: null, used: this.frame, retryAt: 0,
      dir: center.clone().normalize(), sphere: new THREE.Sphere(center, rad + 60),
    };
    this.tiles.set(key, t);
    return t;
  }

  async fetchHeights(L, x, y) {
    const { V } = this;
    const res = await fetch(`${this.base}${L}/${x}_${y}.bin`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    if (buf.byteLength !== 8 + V * V * 2) return null;
    const dv = new DataView(buf), lo = dv.getFloat32(0, true), hi = dv.getFloat32(4, true);
    const q = new Uint16Array(buf, 8, V * V), k = (hi - lo) / 65534, h = new Float32Array(V * V);
    for (let i = 0; i < h.length; i++) { const v = q[i]; h[i] = v === 0 ? NaN : lo + (v - 1) * k; }
    return h;
  }

  async load(t) {
    t.state = 'loading'; this.inFlight++;
    try {
      const h = await this.fetchHeights(t.L, t.x, t.y);
      if (!this.alive) return;
      if (h === null) { t.state = 'empty'; return; }
      t.h = h; t.mesh = this.makeMesh(t); this.group.add(t.mesh); t.state = 'ready';
    } catch (e) {
      t.state = 'idle'; t.retryAt = performance.now() + 3000; console.warn('globe tile failed, retrying', t.key, e);
    } finally { this.inFlight--; }
  }

  makeMesh(t) {
    const { V, S, res, lon0, lat0, minM, span, lut } = this;
    const lv = this.levels[t.L], step = lv.step, h = t.h;
    const nV = V * V + 4 * V;
    const pos = new Float32Array(nV * 3), nor = new Float32Array(nV * 3), col = new Float32Array(nV * 3);
    const v = new THREE.Vector3();
    for (let j = 0; j < V; j++) {
      const lat = lat0 - Math.min(t.y * S + j, lv.rows - 1) * step * res;
      for (let i = 0; i < V; i++) {
        const k = j * V + i;
        const lon = lon0 + Math.min(t.x * S + i, lv.cols - 1) * step * res;
        let e = h[k]; if (e !== e) e = minM;
        ll2v(lon, lat, R + (e / 1000) * EXAG, v);
        pos[k * 3] = v.x; pos[k * 3 + 1] = v.y; pos[k * 3 + 2] = v.z;
        const q = Math.round(clamp01((e - minM) / span) * 255) * 3;
        col[k * 3] = lut[q]; col[k * 3 + 1] = lut[q + 1]; col[k * 3 + 2] = lut[q + 2];
      }
    }
    for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
      const k = j * V + i, a = j * V + Math.max(i - 1, 0), b = j * V + Math.min(i + 1, V - 1);
      const c = Math.max(j - 1, 0) * V + i, d = Math.min(j + 1, V - 1) * V + i;
      const t1x = pos[b * 3] - pos[a * 3], t1y = pos[b * 3 + 1] - pos[a * 3 + 1], t1z = pos[b * 3 + 2] - pos[a * 3 + 2];
      const t2x = pos[d * 3] - pos[c * 3], t2y = pos[d * 3 + 1] - pos[c * 3 + 1], t2z = pos[d * 3 + 2] - pos[c * 3 + 2];
      let nx = t2y * t1z - t2z * t1y, ny = t2z * t1x - t2x * t1z, nz = t2x * t1y - t2y * t1x;
      let l = Math.hypot(nx, ny, nz);
      const px = pos[k * 3], py = pos[k * 3 + 1], pz = pos[k * 3 + 2];
      if (l < 1e-9 || nx * px + ny * py + nz * pz < 0) {
        const pl = Math.hypot(px, py, pz) || 1;
        if (l < 1e-9) { nx = px; ny = py; nz = pz; l = pl; } else { nx = -nx; ny = -ny; nz = -nz; }
      }
      nor[k * 3] = nx / l; nor[k * 3 + 1] = ny / l; nor[k * 3 + 2] = nz / l;
    }
    const cellKm = step * res * R * D2R, depth = Math.max(5, cellKm * 3);
    for (let e = 0; e < 4; e++) for (let k = 0; k < V; k++) {
      const g = this.edge[e](k), s = V * V + e * V + k;
      const len = Math.hypot(pos[g * 3], pos[g * 3 + 1], pos[g * 3 + 2]) || 1, f = (len - depth) / len;
      pos[s * 3] = pos[g * 3] * f; pos[s * 3 + 1] = pos[g * 3 + 1] * f; pos[s * 3 + 2] = pos[g * 3 + 2] * f;
      nor[s * 3] = nor[g * 3]; nor[s * 3 + 1] = nor[g * 3 + 1]; nor[s * 3 + 2] = nor[g * 3 + 2];
      col[s * 3] = col[g * 3]; col[s * 3 + 1] = col[g * 3 + 1]; col[s * 3 + 2] = col[g * 3 + 2];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(this.sharedIndex);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = false; mesh.visible = false;
    return mesh;
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
    const d = this.camPos.length();
    const horizon = Math.acos(Math.min(1, R / d)) + 0.03;
    const viewH = this.ctx.renderer?.domElement?.clientHeight || window.innerHeight;
    const k = viewH / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov ?? 50) / 2));

    const visible = (t) => {
      if (!this.frustum.intersectsSphere(t.sphere)) return false;
      const a = Math.acos(Math.max(-1, Math.min(1, this.camPos.dot(t.dir) / d)));
      return a < horizon + Math.asin(Math.min(1, t.sphere.radius / R));
    };
    const want = (t) => { if (t.state === 'idle' && this.inFlight < MAX_IN_FLIGHT && now >= t.retryAt) this.load(t); };
    const next = new Set();

    const select = (L, x, y) => {
      const t = this.getTile(L, x, y);
      t.used = this.frame;
      if (t.state !== 'ready' || !visible(t)) return;
      const dist = Math.max(this.camPos.distanceTo(t.sphere.center) - t.sphere.radius, 0.5);
      const cellKm = this.levels[L].step * this.res * R * D2R;
      if (L > this.minLevel && (cellKm * k) / dist > MAX_ERR_PX) {
        const cl = this.levels[L - 1], kids = [];
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const cx = 2 * x + dx, cy = 2 * y + dy;
          if (cx >= cl.tilesX || cy >= cl.tilesY) continue;
          const kid = this.getTile(L - 1, cx, cy);
          if (!visible(kid)) continue;
          kid.used = this.frame; kids.push(kid); want(kid);
        }
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

    const ready = [...this.tiles.values()].filter((t) => t.state === 'ready');
    let cnt = ready.length;
    if (cnt > CACHE_LIMIT) {
      const old = ready.filter((t) => t.L < this.top - 2 && !this.drawn.has(t) && this.frame - t.used > 20).sort((a, b) => a.used - b.used);
      for (const t of old) {
        if (cnt-- <= CACHE_LIMIT) break;
        this.group.remove(t.mesh); t.mesh.geometry.dispose(); this.tiles.delete(t.key);
      }
    }
  }

  // real metres from the sharpest loaded tile; NaN if nothing is loaded there
  heightAtLonLat(lon, lat) {
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    const { S, V, res } = this;
    for (let L = this.minLevel; L <= this.top; L++) {
      const lv = this.levels[L], c = (lon - this.lon0) / (res * lv.step), r = (this.lat0 - lat) / (res * lv.step);
      if (c < 0 || r < 0 || c > lv.cols - 1 || r > lv.rows - 1) return NaN;
      const tx = Math.min(Math.floor(c / S), lv.tilesX - 1), ty = Math.min(Math.floor(r / S), lv.tilesY - 1);
      const t = this.tiles.get(`${L}/${tx}/${ty}`);
      if (!t || t.state !== 'ready') continue;
      const fx = Math.min(c - tx * S, V - 1.001), fz = Math.min(r - ty * S, V - 1.001);
      const i0 = Math.floor(fx), j0 = Math.floor(fz), ax = fx - i0, az = fz - j0, h = t.h;
      return (h[j0 * V + i0] * (1 - ax) + h[j0 * V + i0 + 1] * ax) * (1 - az) + (h[(j0 + 1) * V + i0] * (1 - ax) + h[(j0 + 1) * V + i0 + 1] * ax) * az;
    }
    return NaN;
  }

  dispose() {
    super.dispose();
    this.alive = false;
    clearInterval(this.timer); cancelAnimationFrame(this._raf);
    window.removeEventListener('pointerdown', this._down); window.removeEventListener('pointerup', this._up);
    window.removeEventListener('pointermove', this._move); window.removeEventListener('wheel', this._wheel);
    if (!this.group) return;
    this.ctx.scene.remove(this.group, ...this.extras);
    for (const t of this.tiles.values()) if (t.mesh) t.mesh.geometry.dispose();
    this.material.dispose();
  }
}

