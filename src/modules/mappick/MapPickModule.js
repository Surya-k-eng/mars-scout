import * as THREE from 'three';
import { Module } from '../../core/Module.js';

// Map pick + route planning in ONE module.
// 1. Top-down map view at launch. Drag = pan, wheel = zoom, click two points (Esc = skip).
// 2. World recenters on the midpoint, 3D camera is restored, pins + a straight reference line stay.
// 3. A slope-aware A* route is planned between the pins, smoothed, draped on the surface
//    (blinking ghost where it is hidden behind terrain), and an info box shows lat/lon,
//    distances, max slope and a legend.

// ---- map picking ----------------------------------------------------------
const MIN_HEIGHT = 300;         // closest zoom (camera height above ground, metres)
const MAX_HEIGHT_FACTOR = 0.50; // farthest zoom, as a multiple of the "whole region fits" height
const LINE_STEPS = 64;
const LINE_LIFT = 3;            // straight line floats this far above the ground (display units)

// Pin size is constant ON SCREEN: it stays this many pixels tall at any zoom level,
// so it gets physically smaller in the world as the camera zooms in.
const PIN_PX = 26;        // pin height on screen, in pixels
const PIN_UNIT_H = 7.6;   // height of the pin geometry built in makePin()
const PIN_ORDER = 1100;   // drawn after the route (999 / 1000) so pins are always on top

// ---- route planning -------------------------------------------------------
const PLAN = {
  cellSize: 100,        // grid spacing in world units (auto-coarsened if grid gets too big)
  maxCells: 300,        // max cells per side
  padFactor: 0.5,       // search area = pin bounding box padded by this fraction of pin distance
  verticalScale: 1,     // set to 1/exaggeration if the terrain mesh is vertically exaggerated
  slopeWeight: 12,      // w_s: steep ground is very expensive, so the route takes long gentle ways round
  slopeRefDeg: 6,       // theta_ref
  maxSlopeDeg: 15,      // hard limit, checked on the step AND on the local ground slope (sideways slopes too)
  relaxLimits: [20, 25, 35], // only if NO route exists at maxSlopeDeg: retry with these, gentlest first
  groundLift: 0.4,      // metres the path centre sits above the ground (it is re-draped on the ground live)
  drapeEveryMs: 250,    // how often the path is re-laid on the surface that is currently drawn
  smoothIters: 4,       // Chaikin corner-cutting passes
  maxRoutePoints: 1500, // cap on points after resampling
  liftFactor: 0.03,     // base height above ground, as a fraction of cellSize (extra lift is added when zoomed out)
  lineWidthPx: 1.2,     // line radius on screen, in pixels (stays the same at any zoom)
  minRadius: 0.5,       // never thinner than this (world units)
  color: 0x39ff88,
};

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const { k, v } = this; let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1; if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p;
    }
  }
  pop() {
    const { k, v } = this; const top = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m;
      }
    }
    return top;
  }
}

const NB = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

function chaikin(pts, iters) {
  for (let it = 0; it < iters && pts.length > 2; it++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      out.push(
        { x: 0.75 * p.x + 0.25 * q.x, z: 0.75 * p.z + 0.25 * q.z },
        { x: 0.25 * p.x + 0.75 * q.x, z: 0.25 * p.z + 0.75 * q.z }
      );
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

function polyLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return L;
}

// moving average over +-w neighbours (ends use what is available)
function movingAvg(arr, w) {
  return arr.map((_, i) => {
    let s = 0, c = 0;
    for (let k = -w; k <= w; k++) {
      const j = i + k;
      if (j >= 0 && j < arr.length) { s += arr[j]; c++; }
    }
    return s / c;
  });
}

function resample(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L === 0) continue;
    let d = step - carry;
    while (d <= L) {
      const t = d / L;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      d += step;
    }
    carry = L - (d - step);
  }
  const last = pts[pts.length - 1], o = out[out.length - 1];
  if (Math.hypot(last.x - o.x, last.z - o.z) > 1e-6) out.push(last);
  return out;
}

const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`);
const fmtLat = (v) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? 'N' : 'S'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? 'E' : 'W'}`;

export class MapPickModule extends Module {
  static id = 'mappick';
  static requires = ['world'];

  async init() {
    this.active = false;
    this.picks = [];
    this.markers = new THREE.Group();
    this.ctx.scene.add(this.markers);
    this.routeGroup = new THREE.Group();
    this.ctx.scene.add(this.routeGroup);
    this.busy = false;
    this.startPinLoop();
    this.terrain = this.ctx.state.get('terrain');
    if (this.terrain) this.enter();
    else console.warn('[mappick] terrain not found in state; map view not started');
  }

  // ===================== map picking =====================

  enter() {
    const cam = this.ctx.camera;
    const r = this.terrain.regionRect;
    const el = this.el = this.ctx.renderer.domElement;

    this.saved = {
      pos: cam.position.clone(), quat: cam.quaternion.clone(), up: cam.up.clone(),
      near: cam.near, far: cam.far,
    };
    const ctl = this.ctx.controls;
    if (ctl) {
      this.savedTarget = ctl.target ? ctl.target.clone() : null;
      ctl.enabled = false;
    }

    this.rect = r;
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    const half = Math.max(r.x1 - r.x0, r.z1 - r.z0) / 2;
    const h0 = half / Math.tan(THREE.MathUtils.degToRad(cam.fov ?? 50) / 2);
    this.hMax = h0 * MAX_HEIGHT_FACTOR;
    cam.near = 10;
    cam.far = h0 * 4;
    cam.up.set(0, 0, -1);
    cam.position.set(cx, this.hMax, cz);
    cam.lookAt(cx, 0, cz);
    cam.updateProjectionMatrix();

    this.active = true;
    this.picks = [];
    this.ctx.state.set('mode', 'map');
    this.makeHud();

    // preview line (follows the cursor after the first click)
    this.lineGeo = new THREE.BufferGeometry();
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LINE_STEPS * 3), 3));
    this.line = new THREE.Line(this.lineGeo, new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false }));
    this.line.frustumCulled = false;
    this.line.renderOrder = 998;
    this.line.visible = false;
    this.markers.add(this.line);

    this.drag = null;
    this.onDown = (e) => { if (!this.busy && e.button === 0) this.drag = { x: e.clientX, y: e.clientY, moved: 0 }; };
    this.onMove = (e) => {
      if (this.busy) return;
      if (this.drag) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        this.drag.x = e.clientX; this.drag.y = e.clientY;
        this.drag.moved += Math.abs(dx) + Math.abs(dy);
        const mpp = (2 * cam.position.y * Math.tan(THREE.MathUtils.degToRad(cam.fov ?? 50) / 2)) / el.clientHeight;
        cam.position.x = THREE.MathUtils.clamp(cam.position.x - dx * mpp, this.rect.x0, this.rect.x1);
        cam.position.z = THREE.MathUtils.clamp(cam.position.z - dy * mpp, this.rect.z0, this.rect.z1);
      } else if (this.picks.length === 1) {
        const g = this.groundPoint(e);
        if (g) this.setLine(this.picks[0].x, this.picks[0].z, g.x, g.z);
      }
    };
    this.onUp = (e) => {
      const wasClick = this.drag && this.drag.moved < 4;
      this.drag = null;
      if (wasClick) this.pick(e);
    };
    this.onWheel = (e) => {
      e.preventDefault();
      if (this.busy) return;
      const y = cam.position.y * (e.deltaY > 0 ? 1.15 : 1 / 1.15);
      cam.position.y = THREE.MathUtils.clamp(y, MIN_HEIGHT, this.hMax);
    };
    this.onKey = (e) => { if (!this.busy && e.key === 'Escape') this.exit(true); };

    el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKey);
  }

  // World x/z/y under the mouse, refined against the drawn terrain height.
  groundPoint(e) {
    const rect = this.el.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.ctx.camera);
    const hit = new THREE.Vector3();
    let y = 0;
    for (let i = 0; i < 3; i++) {
      if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), hit)) return null;
      y = this.terrain.sampleWorld(hit.x, hit.z) ?? y;
    }
    return { x: hit.x, y, z: hit.z };
  }

  // Straight line draped over the terrain between two world x/z points.
  setLine(ax, az, bx, bz) {
    const p = this.lineGeo.attributes.position;
    let last = 0;
    for (let i = 0; i < LINE_STEPS; i++) {
      const t = i / (LINE_STEPS - 1);
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      last = this.terrain.sampleWorld(x, z) ?? last;
      p.setXYZ(i, x, last + LINE_LIFT, z);
    }
    p.needsUpdate = true;
    this.line.visible = true;
  }

  // Pin built at unit size (pole 6 tall, cone on top, ring on the ground); scaled by the caller.
  makePin(x, y, z) {
    // depthTest off + high renderOrder = the pin is drawn over the route and the terrain
    const onTop = { color: 0xff3030, transparent: true, depthTest: false, depthWrite: false };
    const mat = new THREE.MeshBasicMaterial(onTop);
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6, 8), mat);
    pole.position.y = 3;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.6, 12), mat);
    tip.position.y = 6.8;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.2, 24),
      new THREE.MeshBasicMaterial({ ...onTop, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.1;
    g.add(pole, tip, ring);
    g.traverse((o) => { o.renderOrder = PIN_ORDER; o.frustumCulled = false; });
    g.position.set(x, y, z);
    g.userData.isPin = true;
    return g;
  }

  pick(e) {
    const g = this.groundPoint(e);
    if (!g) return;
    const { lon, lat } = this.terrain.worldToLonLat(g.x, g.z);
    this.picks.push({ lon, lat, x: g.x, z: g.z });
    const pin = this.makePin(g.x, g.y, g.z);
    this.markers.add(pin);
    if (this.picks.length === 2) {
      this.setLine(this.picks[0].x, this.picks[0].z, g.x, g.z);
      // Show the second pin FIRST. Route planning blocks the main thread, so wait for a couple of
      // rendered frames before starting it; otherwise the pin only appears once everything is done.
      this.busy = true;
      this.updateHud();
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
        if (this.active) this.finish();
      }, 0)));
    } else {
      this.updateHud();
    }
  }

  finish() {
    const [a, b] = this.picks;
    const midLon = (a.lon + b.lon) / 2, midLat = (a.lat + b.lat) / 2;

    // the thin preview line is replaced by a visible straight reference line drawn after the route
    this.line.visible = false;

    // move the world origin to the midpoint; everything already placed is shifted to match
    const { dx, dz } = this.terrain.recenter(midLon, midLat);
    this.markers.position.x -= dx;
    this.markers.position.z -= dz;
    this.saved.pos.x -= dx; this.saved.pos.z -= dz;
    if (this.savedTarget) { this.savedTarget.x -= dx; this.savedTarget.z -= dz; }

    const area = {
      a: { lon: a.lon, lat: a.lat, x: a.x - dx, z: a.z - dz },
      b: { lon: b.lon, lat: b.lat, x: b.x - dx, z: b.z - dz },
      center: { lon: midLon, lat: midLat },
      lonMin: Math.min(a.lon, b.lon), lonMax: Math.max(a.lon, b.lon),
      latMin: Math.min(a.lat, b.lat), latMax: Math.max(a.lat, b.lat),
    };
    this.ctx.state.set('selectedArea', area);
    this.ctx.bus.emit('area:selected', area);
    console.log('[mappick] area saved, world recentered', area);

    this.planRoute(area);   // route planning runs right here, no separate module
    this.drawStraight(area.a, area.b);
    this.exit(false);
  }

  exit(clearMarkers = true) {
    if (!this.active) return;
    const cam = this.ctx.camera, s = this.saved;

    this.el.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKey);

    cam.position.copy(s.pos);
    cam.quaternion.copy(s.quat);
    cam.up.copy(s.up);
    cam.near = s.near;
    cam.far = s.far;
    cam.updateProjectionMatrix();

    const ctl = this.ctx.controls;
    if (ctl) {
      if (this.savedTarget && ctl.target) ctl.target.copy(this.savedTarget);
      ctl.enabled = true;
      ctl.update?.();
    }

    if (clearMarkers) this.clearMarkers();
    this.removeHud();
    this.active = false;
    this.busy = false;
    this.ctx.state.set('mode', 'world');
  }

  clearMarkers() {
    for (const c of [...this.markers.children]) {
      this.markers.remove(c);
      c.traverse?.((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    }
    this.markers.position.set(0, 0, 0);
  }

  // Keeps every pin the same size on screen: world scale = distance to camera * pixel size.
  // Zoom in -> the pin shrinks in the world, zoom out -> it grows, on-screen size never changes.
  startPinLoop() {
    const v = new THREE.Vector3();
    const loop = () => {
      this.pinRaf = requestAnimationFrame(loop);
      const cam = this.ctx.camera;
      const hpx = Math.max(1, this.ctx.renderer.domElement.clientHeight);
      const perPx = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov ?? 50) / 2) / hpx;
      for (const c of this.markers.children) {
        if (!c.userData.isPin) continue;
        c.getWorldPosition(v);
        c.scale.setScalar(Math.max(1e-3, v.distanceTo(cam.position) * perPx * PIN_PX / PIN_UNIT_H));
      }
    };
    this.pinRaf = requestAnimationFrame(loop);
  }

  // Yellow straight reference line between the two pins (world is already recentered here).
  drawStraight(a, b) {
    const pts = [];
    let last = 0;
    for (let i = 0; i < LINE_STEPS; i++) {
      const t = i / (LINE_STEPS - 1);
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      last = this.terrain.sampleWorld(x, z) ?? last;
      pts.push(new THREE.Vector3(x, last + LINE_LIFT, z));
    }
    const ln = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false })
    );
    ln.frustumCulled = false;
    ln.renderOrder = 997;
    this.routeGroup.add(ln);
  }

  // ===================== route planning =====================

  planRoute(area) {
    const terrain = this.terrain;
    const A = area.a, B = area.b;
    const straight = Math.hypot(B.x - A.x, B.z - A.z);

    // search window
    const pad = straight * PLAN.padFactor;
    const x0 = Math.min(A.x, B.x) - pad, x1 = Math.max(A.x, B.x) + pad;
    const z0 = Math.min(A.z, B.z) - pad, z1 = Math.max(A.z, B.z) + pad;
    const cs = Math.max(PLAN.cellSize, Math.max(x1 - x0, z1 - z0) / PLAN.maxCells);
    const W = Math.ceil((x1 - x0) / cs) + 1, H = Math.ceil((z1 - z0) / cs) + 1;

    // sample heights (null = no data -> impassable)
    const hgt = new Float32Array(W * H);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const y = terrain.sampleWorld(x0 + i * cs, z0 + j * cs);
        hgt[j * W + i] = y == null ? NaN : y * PLAN.verticalScale;
      }

    const toCell = (p) => [
      Math.min(W - 1, Math.max(0, Math.round((p.x - x0) / cs))),
      Math.min(H - 1, Math.max(0, Math.round((p.z - z0) / cs))),
    ];
    const [sx, sz] = toCell(A), [gx, gz] = toCell(B);
    const si = sz * W + sx, gi = gz * W + gx;
    if (isNaN(hgt[si]) || isNaN(hgt[gi])) return console.warn('[mappick] pin outside terrain data');

    // local ground slope of every cell (steepest direction), so a path that runs ALONG a steep
    // hillside is judged by the hillside, not only by its own tiny up/down step
    const sl = new Float32Array(W * H);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(W - 1, i + 1);
        const j0 = Math.max(0, j - 1), j1 = Math.min(H - 1, j + 1);
        const hx0 = hgt[j * W + i0], hx1 = hgt[j * W + i1], hz0 = hgt[j0 * W + i], hz1 = hgt[j1 * W + i];
        if (isNaN(hx0) || isNaN(hx1) || isNaN(hz0) || isNaN(hz1)) continue;
        const gxs = (hx1 - hx0) / ((i1 - i0) * cs), gzs = (hz1 - hz0) / ((j1 - j0) * cs);
        sl[j * W + i] = Math.atan(Math.hypot(gxs, gzs)) * 180 / Math.PI;
      }

    // A*: try the gentle limit first; only if no route exists, relax it step by step
    let g, parent, closed, usedLimit = null;
    const limits = [PLAN.maxSlopeDeg, ...PLAN.relaxLimits.filter((l) => l > PLAN.maxSlopeDeg)];
    for (const limit of limits) {
      g = new Float64Array(W * H).fill(Infinity);
      parent = new Int32Array(W * H).fill(-1);
      closed = new Uint8Array(W * H);
      const h = (i, j) => Math.hypot(i - gx, j - gz) * cs;
      const open = new MinHeap();
      g[si] = 0; open.push(h(sx, sz), si);

      while (open.size) {
        const cur = open.pop();
        if (closed[cur]) continue;
        closed[cur] = 1;
        if (cur === gi) break;
        const ci = cur % W, cj = (cur / W) | 0;
        for (const [dx, dz] of NB) {
          const ni = ci + dx, nj = cj + dz;
          if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
          const n = nj * W + ni;
          if (closed[n] || isNaN(hgt[n])) continue;
          const d = Math.hypot(dx, dz) * cs;
          const thetaMove = Math.atan(Math.abs(hgt[n] - hgt[cur]) / d) * 180 / Math.PI;
          const theta = Math.max(thetaMove, sl[n]);
          if (theta > limit) continue;
          const t = g[cur] + d * (1 + PLAN.slopeWeight * (theta / PLAN.slopeRefDeg) ** 2);
          if (t < g[n]) { g[n] = t; parent[n] = cur; open.push(t + h(ni, nj), n); }
        }
      }
      if (closed[gi]) { usedLimit = limit; break; }
    }

    if (usedLimit == null) return console.warn('[mappick] no route under any slope limit');
    if (usedLimit > PLAN.maxSlopeDeg) console.warn(`[mappick] no route at ${PLAN.maxSlopeDeg} deg, used ${usedLimit} deg`);

    // raw grid path (and its max slope)
    const idxs = [];
    for (let i = gi; i !== -1; i = parent[i]) idxs.push(i);
    idxs.reverse();
    let maxSlope = 0;
    for (let k = 1; k < idxs.length; k++) {
      const a = idxs[k - 1], b = idxs[k];
      const d = Math.hypot((b % W) - (a % W), ((b / W) | 0) - ((a / W) | 0)) * cs;
      maxSlope = Math.max(maxSlope, Math.atan(Math.abs(hgt[b] - hgt[a]) / d) * 180 / Math.PI);
    }

    // smooth in x/z, pin the ends exactly on the pins, then resample densely
    let pts = idxs.map((i) => ({ x: x0 + (i % W) * cs, z: z0 + ((i / W) | 0) * cs }));
    pts[0] = { x: A.x, z: A.z };
    pts[pts.length - 1] = { x: B.x, z: B.z };
    pts = chaikin(pts, PLAN.smoothIters);
    const step = Math.max(cs / 5, 2, polyLength(pts) / PLAN.maxRoutePoints);
    pts = resample(pts, step);

    // drape on the real surface
    // (the old code averaged the heights and kept the maximum, which made the line bridge over every
    // valley and sit tens of metres above ridges. Now it uses the real ground height; drawRoute()
    // then keeps re-laying it on the drawn surface while the camera moves.)
    const ground = [];
    let lastY = 0;
    for (const p of pts) {
      lastY = this.groundAt(p.x, p.z) ?? lastY;
      ground.push(lastY);
    }
    const lifted = pts.map((p, i) => new THREE.Vector3(p.x, ground[i] + PLAN.groundLift, p.z));

    // true surface length (3D)
    let routeLen = 0;
    for (let i = 1; i < pts.length; i++) {
      routeLen += Math.hypot(pts[i].x - pts[i - 1].x, (ground[i] - ground[i - 1]) * PLAN.verticalScale, pts[i].z - pts[i - 1].z);
    }

    this.drawRoute(lifted);
    this.showPanel({ a: area.a, b: area.b, straight, routeLen, maxSlope, limit: usedLimit });
    this.ctx.state.set('route', lifted);
    this.ctx.bus.emit('route:planned', { points: lifted, length: routeLen, cost: g[gi] });
    console.log(`[mappick] route: ${lifted.length} points, ${routeLen.toFixed(0)} m, cell ${cs.toFixed(0)}`);
  }

  // Ground height at world x/z: the DRAWN surface (grid) and the pick sampler, whichever is higher,
  // so the path is never buried. Same rule Astro uses to stand on the ground.
  groundAt(x, z) {
    const t = this.terrain;
    let h = null;
    try {
      if (t.worldToGrid && t.heightAt && t.gridToWorld) {
        const { gx, gz } = t.worldToGrid(x, z);
        if (!Number.isNaN(t.heightAt(gx, gz))) h = t.gridToWorld(gx, gz).y;
      }
    } catch (e) { /* grid not ready: fall back to the sampler */ }
    const w = t.sampleWorld?.(x, z);
    if (w != null && Number.isFinite(w)) h = h == null ? w : Math.max(h, w);
    return h;
  }

  // Lay every ring of the route tube back onto the ground that is drawn right now.
  // The tube stores centre + normal (radius 1), so centre = position - normal.
  redrape() {
    const geo = this.routeGeo;
    if (!geo || !this.terrain) return;
    const pos = geo.attributes.position, nor = geo.attributes.normal;
    const per = 7;                                   // radial segments (6) + 1 seam vertex
    let last = null;
    for (let i0 = 0; i0 + per <= pos.count; i0 += per) {
      const cx = pos.getX(i0) - nor.getX(i0), cz = pos.getZ(i0) - nor.getZ(i0);
      let y = this.groundAt(cx, cz);
      if (y == null) y = last;
      if (y == null) continue;
      last = y;
      const cy = y + PLAN.groundLift;
      for (let k = 0; k < per; k++) pos.setY(i0 + k, cy + nor.getY(i0 + k));
    }
    pos.needsUpdate = true;
  }

  // Solid where visible; blinking ghost where the route is hidden behind terrain/objects.
  drawRoute(points) {
    this.clearRoute();
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    // unit-radius tube; the vertex shader below sets the real thickness from the camera distance,
    // so the line keeps the same on-screen width (and clears the surface) at any zoom level.
    this.routeGeo = new THREE.TubeGeometry(curve, points.length, 1, 6, false);
    this.drapeAt = 0;
    this.redrape();

    this.uK = { value: 0.003 };
    this.uMinR = { value: PLAN.minRadius };
    const mk = (opts) => {
      const m = new THREE.MeshBasicMaterial(opts);
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uK = this.uK;
        shader.uniforms.uMinR = this.uMinR;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uK;\nuniform float uMinR;')
          .replace('#include <begin_vertex>', `
            vec3 rc = position - normal;                       // tube centre line
            float rd = distance(cameraPosition, rc);
            float rr = max(rd * uK, uMinR);                    // radius from distance
            vec3 transformed = rc + normal * rr + vec3(0.0, rr, 0.0);          // tube rests ON the ground (lift = its own radius)
          `);
      };
      m.customProgramCacheKey = () => 'routeTube';
      return m;
    };

    // visible parts: solid
    const solid = new THREE.Mesh(this.routeGeo, mk({ color: PLAN.color }));
    solid.renderOrder = 999;
    solid.frustumCulled = false;

    // hidden parts only (drawn where the terrain is in front): blinking ghost
    this.ghost = new THREE.Mesh(this.routeGeo, mk({
      color: PLAN.color, transparent: true, opacity: 0.5,
      depthFunc: THREE.GreaterDepth, depthWrite: false,
    }));
    this.ghost.renderOrder = 1000;
    this.ghost.frustumCulled = false;

    this.routeGroup.add(solid, this.ghost);

    const tick = (t) => {
      this.raf = requestAnimationFrame(tick);
      const cam = this.ctx.camera;
      const hpx = Math.max(1, this.ctx.renderer.domElement.clientHeight);
      this.uK.value = PLAN.lineWidthPx * 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov ?? 50) / 2) / hpx;
      this.ghost.material.opacity = 0.2 + 0.7 * (0.5 + 0.5 * Math.sin(t * 0.006));
      // the drawn terrain changes detail as the camera moves: lay the path on it again
      if (t - this.drapeAt > PLAN.drapeEveryMs) { this.drapeAt = t; this.redrape(); }
    };
    this.raf = requestAnimationFrame(tick);
  }

  clearRoute() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    for (const c of [...this.routeGroup.children]) {
      this.routeGroup.remove(c); c.material?.dispose?.(); if (c.geometry !== this.routeGeo) c.geometry?.dispose?.();
    }
    this.routeGeo?.dispose();
    this.routeGeo = null;
    this.ghost = null;
  }

  // ===================== HUD / info box =====================

  makeHud() {
    const d = this.hud = document.createElement('div');
    Object.assign(d.style, {
      position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
      padding: '8px 14px', background: 'rgba(0,0,0,0.65)', color: '#fff',
      font: '14px system-ui, sans-serif', borderRadius: '6px', zIndex: 1000, pointerEvents: 'none',
    });
    document.body.appendChild(d);
    this.updateHud();
  }

  updateHud() {
    if (this.hud) this.hud.textContent = this.busy ? 'Planning route…' :
      `Map view: click point ${Math.min(this.picks.length + 1, 2)} of 2  (drag = pan, wheel = zoom, Esc = skip)`;
  }

  removeHud() { this.hud?.remove(); this.hud = null; }

  showPanel({ a, b, straight, routeLen, maxSlope, limit }) {
    this.removePanel();
    const d = this.panel = document.createElement('div');
    Object.assign(d.style, {
      position: 'fixed', left: '16px', top: '54px', minWidth: '250px', display: 'none',
      padding: '10px 14px', background: 'rgba(0,0,0,0.78)', color: '#fff',
      font: '13px/1.5 system-ui, sans-serif', borderRadius: '8px', zIndex: 1000, pointerEvents: 'none',
    });
    // toggle button (top-left): hidden by default, click to open / close the info box
    const btn = this.panelBtn = document.createElement('button');
    btn.textContent = 'Route info ▸';
    Object.assign(btn.style, {
      position: 'fixed', left: '16px', top: '16px', padding: '6px 12px',
      background: 'rgba(0,0,0,0.78)', color: '#fff', border: '1px solid rgba(255,255,255,0.35)',
      borderRadius: '6px', font: '13px system-ui, sans-serif', cursor: 'pointer', zIndex: 1001,
    });
    btn.onclick = () => {
      const open = d.style.display === 'none';
      d.style.display = open ? 'block' : 'none';
      btn.textContent = open ? 'Route info ▾' : 'Route info ▸';
    };
    const dot = (c) => `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${c};margin-right:8px"></span>`;
    const bar = (c, extra = '') => `<span style="display:inline-block;width:22px;height:4px;background:${c};margin-right:8px;vertical-align:middle;${extra}"></span>`;
    d.innerHTML = `
      <div style="font-weight:600;margin-bottom:4px">Route info</div>
      <div>${dot('#ff3030')}<b>A</b> ${fmtLat(a.lat)}, ${fmtLon(a.lon)}</div>
      <div>${dot('#ff3030')}<b>B</b> ${fmtLat(b.lat)}, ${fmtLon(b.lon)}</div>
      <div style="margin-top:6px">Straight distance: <b>${fmtDist(straight)}</b></div>
      <div>Route length: <b>${fmtDist(routeLen)}</b></div>
      <div>Max slope on route: <b>${maxSlope.toFixed(1)}°</b> <span style="opacity:.7">(limit ${limit}°${limit > PLAN.maxSlopeDeg ? ', relaxed: no gentler way exists' : ''})</span></div>
      <div style="font-weight:600;margin:8px 0 2px">Legend</div>
      <div>${dot('#ff3030')}Selected points</div>
      <div>${bar('#39ff88')}Planned route (visible)</div>
      <div>${bar('#39ff88', 'opacity:0.4')}Route hidden behind terrain (blinks)</div>
      <div>${bar('#ffd23f')}Straight line (reference)</div>`;
    document.body.append(btn, d);
  }

  removePanel() {
    this.panel?.remove(); this.panel = null;
    this.panelBtn?.remove(); this.panelBtn = null;
  }

  dispose() {
    super.dispose();
    if (this.pinRaf) cancelAnimationFrame(this.pinRaf);
    this.pinRaf = null;
    this.exit(true);
    this.removeHud();
    this.removePanel();
    this.clearRoute();
    this.clearMarkers();
    this.ctx.scene.remove(this.markers);
    this.ctx.scene.remove(this.routeGroup);
  }
}
