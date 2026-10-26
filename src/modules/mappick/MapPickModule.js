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
const MAX_HEIGHT_FACTOR = 1.0;  // farthest zoom, as a multiple of the "whole region fits" height (was 0.5 = only the middle half)
const ZOOM_SPEED = 1.4;         // zoom step per wheel notch (was 1.15)
const PAN_SPEED = 1.6;          // drag-pan multiplier (was 1)
const FLAT_ONLY = true;         // always a top-down 2D view (terrain still drawn in 3D); never restore the tilted 3D camera
// Named Mars features (IAU gazetteer: craters, mountains, valleys, ...). It already contains the
// mars_craters and mars_mountains files, so this one file is all that is needed. Put it in your Vite
// `public/` folder so it is served from the site root.
const FEATURES_URL = '/mars_features.geojson';
const FEATURE_COLORS = { crater: '#ffb347', mons: '#ff6b6b', other: '#6bd6ff' };
const FEATURE_CIRCLE = /^(Crater|Mons|Tholus|Patera|Cavus|Collis|Mensa|Labes|Chaos|Lingula)/;
const TIP_DELAY = 250;          // ms the cursor must rest before the coordinate box appears
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
  crossWeight: 25,      // extra cost for moving ACROSS a slope (sliding sideways along a hillside)
  crossRefDeg: 4,
  crossMaxFactor: 0.5,  // hard limit on sideways slope = this * current slope limit
  tpiRadiusM: 1500,     // 'what counts as a hill': ground is compared to the average of this radius
  ridgeWeight: 3,       // extra cost for cells higher than their surroundings (peaks, ridges, mountain shoulders)
  ridgeRef: 40,         // height above surroundings (display units) that doubles the cost, roughly
  elevWeight: 1.5,      // extra cost for being higher than BOTH pins (prefers going around, not over, mountains)
  elevRef: 100,         // display units
  profileWindow: 4,     // +- samples used to smooth the ground profile along the path (kills rollercoaster)
  hoverBand: 1.5,       // path may sit at most this far above / below the real ground (display units)
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
    this.loadFeatures();
    this.terrain = this.ctx.state.get('terrain');
    if (this.terrain) this.enter();
    else this.waitForTerrain();
  }

  // The world module may finish after this one; keep the controls off and start the flat view the
  // moment the terrain exists, instead of leaving the tilted 3D camera on screen.
  waitForTerrain() {
    const ctl = this.ctx.controls;
    this.waitTimer = setInterval(() => {
      if (ctl) ctl.enabled = false;
      const t = this.ctx.state.get('terrain');
      if (!t) return;
      clearInterval(this.waitTimer); this.waitTimer = null;
      this.terrain = t;
      this.enter();
    }, 50);
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
        cam.position.x = THREE.MathUtils.clamp(cam.position.x - dx * mpp * PAN_SPEED, this.rect.x0, this.rect.x1);
        cam.position.z = THREE.MathUtils.clamp(cam.position.z - dy * mpp * PAN_SPEED, this.rect.z0, this.rect.z1);
      } else if (this.active && this.picks.length === 1) {
        const g = this.groundPoint(e);
        if (g) this.setLine(this.picks[0].x, this.picks[0].z, g.x, g.z);
      }
    };
    this.onUp = (e) => {
      const wasClick = this.drag && this.drag.moved < 4;
      this.drag = null;
      if (wasClick && this.active) this.pick(e);
    };
    this.onWheel = (e) => {
      e.preventDefault();
      if (this.busy) return;
      const h0 = cam.position.y;
      const h1 = THREE.MathUtils.clamp(h0 * (e.deltaY > 0 ? ZOOM_SPEED : 1 / ZOOM_SPEED), MIN_HEIGHT, this.hMax);
      // zoom toward the mouse: the ground point under the cursor stays under the cursor
      const r = el.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = -((e.clientY - r.top) / r.height) * 2 + 1;
      const k = Math.tan(THREE.MathUtils.degToRad(cam.fov ?? 50) / 2);
      cam.position.x = THREE.MathUtils.clamp(cam.position.x + nx * k * cam.aspect * (h0 - h1), this.rect.x0, this.rect.x1);
      cam.position.z = THREE.MathUtils.clamp(cam.position.z + ny * k * (h1 - h0), this.rect.z0, this.rect.z1);
      cam.position.y = h1;
    };
    this.onKey = (e) => { if (!this.busy && e.key === 'Escape') this.exit(true); };

    // Capture on window and stop propagation for everything on the canvas: no other control
    // (orbit / tilt / right-drag rotate / ctrl-drag) can react while the map is being picked.
    this.onDownCap = (e) => {
      if (e.target !== el) return;
      e.stopPropagation();
      this.onDown(e);
    };
    this.onWheelCap = (e) => {
      if (e.target !== el) return;
      e.stopPropagation();
      this.onWheel(e);
    };
    this.onCtx = (e) => { if (e.target === el) { e.preventDefault(); e.stopPropagation(); } };
    this.prevTouchAction = el.style.touchAction;
    el.style.touchAction = 'none';
    window.addEventListener('pointerdown', this.onDownCap, true);
    window.addEventListener('wheel', this.onWheelCap, { passive: false, capture: true });
    window.addEventListener('contextmenu', this.onCtx, true);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('keydown', this.onKey);

    // Coordinate box: appears where the cursor rests, disappears as soon as it moves.
    this.tip = document.createElement('div');
    this.tip.style.cssText = 'position:fixed;z-index:9999;display:none;pointer-events:none;padding:5px 9px;' +
      'background:rgba(16,18,24,.88);color:#fff;font:12px/1.35 system-ui,sans-serif;border-radius:6px;' +
      'border:1px solid rgba(255,255,255,.18);max-width:280px;white-space:normal;box-shadow:0 2px 8px rgba(0,0,0,.4)';
    document.body.appendChild(this.tip);
    this.hideTip = () => {
      clearTimeout(this.tipTimer); this.tipTimer = null;
      if (this.tip) this.tip.style.display = 'none';
    };
    this.showTip = (cx, cy) => {
      const g = this.groundPoint({ clientX: cx, clientY: cy });
      if (!g) return;
      const { lon, lat } = this.terrain.worldToLonLat(g.x, g.z);
      const f = this.featureAt(cx, cy);
      this.tip.innerHTML = (f ? this.featureHtml(f) : '') + `${fmtLat(lat)}<br>${fmtLon(lon)}`;
      this.tip.style.display = 'block';
      const w = this.tip.offsetWidth, h = this.tip.offsetHeight;
      this.tip.style.left = `${Math.min(cx + 14, innerWidth - w - 4)}px`;
      this.tip.style.top = `${Math.min(cy + 16, innerHeight - h - 4)}px`;
    };
    this.onTipMove = (e) => {
      if (this.busy) { this.hideTip(); return; }
      if (this.drag) {                       // dragging: follow the cursor continuously
        clearTimeout(this.tipTimer); this.tipTimer = null;
        this.showTip(e.clientX, e.clientY);
        return;
      }
      this.hideTip();                        // plain hover: hide while moving, show once it rests
      if (e.target !== el) return;
      const cx = e.clientX, cy = e.clientY;
      this.tipTimer = setTimeout(() => this.showTip(cx, cy), TIP_DELAY);
    };
    this.onTipUp = () => this.hideTip();
    window.addEventListener('pointermove', this.onTipMove);
    window.addEventListener('wheel', this.hideTip, { passive: true });
    window.addEventListener('pointerup', this.onTipUp);
    el.addEventListener('pointerleave', this.hideTip);

    this.showFeat = true;
    this.makeFeatureUI();

    // Every frame: keep the camera looking straight down (no tilt, no rotation) and the controls off.
    const lock = () => {
      this.lockRaf = requestAnimationFrame(lock);
      if (!this.active && !this.flatView) return;
      if (ctl) {
        ctl.enabled = false;
        ctl.target?.set(cam.position.x, 0, cam.position.z);   // so a controls.update() can never tilt it
      }
      cam.up.set(0, 0, -1);
      cam.position.y = THREE.MathUtils.clamp(cam.position.y, MIN_HEIGHT, this.hMax);
      cam.lookAt(cam.position.x, 0, cam.position.z);
      this.drawFeatures();
    };
    this.lockRaf = requestAnimationFrame(lock);
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
    if (g) this.addPick(g);
  }

  // Add a pin at a world position (used by both mouse clicks and typed coordinates).
  addPick(g) {
    if (this.busy || this.picks.length >= 2) return;
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
    if (FLAT_ONLY) { this.ctx.camera.position.x -= dx; this.ctx.camera.position.z -= dz; }
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

  // ===================== Mars feature labels =====================

  async loadFeatures() {
    try {
      // try the usual places; Vite answers a missing file with index.html (not JSON), so check that too
      const base = import.meta.env?.BASE_URL || '/';
      const urls = [...new Set([FEATURES_URL, `${base}mars_features.geojson`, `${base}data/mars_features.geojson`, '/data/mars_features.geojson'])];
      let gj = null, why = '';
      for (const u of urls) {
        try {
          const res = await fetch(u);
          if (!res.ok) { why = `HTTP ${res.status} for ${u}`; continue; }
          const text = await res.text();
          if (text.trimStart().startsWith('<')) { why = `${u} returned a web page, not the file`; continue; }
          gj = JSON.parse(text);
          break;
        } catch (e) { why = `${u}: ${e.message}`; }
      }
      if (!gj) throw new Error(why);
      this.features = gj.features
        .filter((x) => x.geometry?.type === 'Point')
        .map((x) => {
          const p = x.properties, [lon, lat] = x.geometry.coordinates;
          const type = p.type || '';
          return {
            name: p.clean_name || p.name, type, lon, lat,
            diameter: Number(p.diameter) || 0,
            origin: p.origin || '', approval: p.approval || '',
            year: String(p.approvaldt || '').slice(0, 4),
            circle: FEATURE_CIRCLE.test(type),
            kind: /^Crater/.test(type) ? 'crater' : /^(Mons|Tholus)/.test(type) ? 'mons' : 'other',
          };
        })
        .sort((a, b) => b.diameter - a.diameter);        // big first: they win label space
      this.setFeatureStatus('');
    } catch (err) {
      console.warn(`[mappick] could not load ${FEATURES_URL}:`, err);
      this.features = null;
      this.setFeatureStatus(`Feature file not found. Put mars_features.geojson in the public/ folder and restart. (${String(err.message).slice(0, 80)})`);
    }
  }

  setFeatureStatus(text) { if (this.featMsg) this.featMsg.textContent = text; this.featStatus = text; }

  makeFeatureUI() {
    const cv = this.featCv = document.createElement('canvas');
    cv.style.cssText = 'position:fixed;pointer-events:none;z-index:900';
    document.body.appendChild(cv);

    const box = this.featBox = document.createElement('div');
    box.style.cssText = 'position:fixed;right:16px;top:16px;z-index:1001;padding:6px 10px;background:rgba(0,0,0,0.75);' +
      'color:#fff;font:12px/1.5 system-ui,sans-serif;border-radius:8px;border:1px solid rgba(255,255,255,0.3);';
    const dot = (c) => `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;border:2px solid ${c};margin:0 4px 0 8px;vertical-align:middle"></span>`;
    const btn = document.createElement('label');
    btn.style.cssText = 'cursor:pointer;user-select:none;display:block;font-weight:600';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = true; cb.style.marginRight = '6px';
    cb.onchange = () => { this.showFeat = cb.checked; this.hideTip?.(); };
    btn.append(cb, 'Map features');
    const legend = document.createElement('div');
    legend.innerHTML = `${dot(FEATURE_COLORS.crater).replace('margin:0 4px','margin:0 4px 0 0')}Crater${dot(FEATURE_COLORS.mons)}Mountain${dot(FEATURE_COLORS.other)}Other`;
    const cnt = this.featCnt = document.createElement('div');
    cnt.style.cssText = 'opacity:.75;font-size:11px';
    const msg = this.featMsg = document.createElement('div');
    msg.style.cssText = 'color:#ffb4b4;font-size:11px';
    msg.textContent = this.featStatus || '';
    box.append(btn, legend, cnt, msg);
    document.body.appendChild(box);
  }

  removeFeatureUI() {
    this.featCv?.remove(); this.featCv = null;
    this.featBox?.remove(); this.featBox = null; this.featMsg = null; this.featCnt = null; this.featCount = -1;
    this.featHits = [];
  }

  // The Astro Cam inset is created by another module, so find it in the page by its label / id / class.
  // Returns its on-screen rect (client coords) or null when it is not showing.
  astroCamRect() {
    const bad = (n) => !n || !n.isConnected || n === this.featCv || n === this.featBox || n === this.tip;
    if (bad(this._astroEl)) {
      this._astroEl = null;
      const now = performance.now();
      if (this._astroScan && now - this._astroScan < 500) return null;   // scan at most twice a second
      this._astroScan = now;
      let el = document.querySelector('[id*="astro" i], [class*="astro" i], [data-name*="astro" i]');
      if (!el) {
        const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = tw.nextNode(); n; n = tw.nextNode()) {
          if (/astro\s*cam/i.test(n.nodeValue) && n.parentElement && !bad(n.parentElement) && !this.featBox?.contains(n.parentElement)) { el = n.parentElement; break; }
        }
        // climb to the whole panel (the biggest ancestor that is still clearly smaller than the page)
        while (el && el.parentElement && el.parentElement !== document.body) {
          const pr = el.parentElement.getBoundingClientRect();
          if (pr.width >= innerWidth * 0.9 || pr.height >= innerHeight * 0.9) break;
          el = el.parentElement;
        }
      }
      this._astroEl = el || null;
    }
    const el = this._astroEl;
    if (!el) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    const r = el.getBoundingClientRect();
    return r.width > 20 && r.height > 20 ? r : null;
  }

  // Draw every feature inside the view on a 2D canvas over the map. Craters etc. are drawn at their
  // true size; labels are skipped where they would overlap (bigger features get priority).
  drawFeatures() {
    const cv = this.featCv, el = this.el;
    if (!cv || !el) return;
    const r = el.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(r.width), h = Math.round(r.height);
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    cv.style.left = `${r.left}px`; cv.style.top = `${r.top}px`;
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    this.featHits = [];
    this.featOrigin = { left: r.left, top: r.top };
    if (!this.showFeat || !this.features || !this.terrain) return;
    const ac = this.astroCamRect();
    g.save();
    if (ac) {                                                      // keep circles / labels off the Astro Cam inset
      g.beginPath();
      g.rect(0, 0, w, h);
      g.rect(ac.left - r.left, ac.top - r.top, ac.width, ac.height);
      g.clip('evenodd');
    }

    // whole loaded map area, read fresh every frame (it moves when the world recenters), plus a small margin
    const cam = this.ctx.camera, t = this.terrain;
    const A = t.regionRect, B = t.hiriseRect || A;
    if (!A) return;
    const mx = (Math.max(A.x1, B.x1) - Math.min(A.x0, B.x0)) * 0.02, mz = (Math.max(A.z1, B.z1) - Math.min(A.z0, B.z0)) * 0.02;
    const rc = {
      x0: Math.min(A.x0, B.x0) - mx, x1: Math.max(A.x1, B.x1) + mx,
      z0: Math.min(A.z0, B.z0) - mz, z1: Math.max(A.z1, B.z1) + mz,
    };
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov ?? 50) / 2);
    const v = this._fv || (this._fv = new THREE.Vector3());
    const lonC = t.lonC;
    const used = [];
    const rings = [];                                              // circles already drawn this frame
    if (this._sortedFor !== this.features) {                       // biggest first, so the big crater keeps its circle
      this.features.sort((a, b) => (b.diameter || 0) - (a.diameter || 0));
      this._sortedFor = this.features;
    }
    let labels = 0, inRegion = 0;
    g.font = '12px system-ui, sans-serif';
    g.textBaseline = 'middle'; g.textAlign = 'left';

    for (const f of this.features) {
      const lon = f.lon + 360 * Math.round((lonC - f.lon) / 360);   // same longitude convention as the map
      const p = t.lonLatToWorld(lon, f.lat);
      const rad = f.circle ? f.diameter * 500 : 0;                  // km -> metres of radius (world units are metres)
      if (p.x < rc.x0 - rad || p.x > rc.x1 + rad || p.z < rc.z0 - rad || p.z > rc.z1 + rad) continue;
      inRegion++;
      const y = t.sampleWorld(p.x, p.z) ?? this.lastY ?? 0;          // sit on the drawn surface
      this.lastY = y;
      const dist = cam.position.y - y;
      if (dist <= 1) continue;
      v.set(p.x, y, p.z).project(cam);
      const sx = (v.x + 1) / 2 * w, sy = (1 - v.y) / 2 * h;
      const rpx = rad * (h / 2) / (dist * tanH);
      if (rpx > Math.max(w, h) * 0.8) continue;                      // bigger than the screen: no use drawing
      if (sx < -rpx - 40 || sx > w + rpx + 40 || sy < -rpx - 40 || sy > h + rpx + 40) continue;

      const col = FEATURE_COLORS[f.kind];
      g.lineWidth = 1.5; g.strokeStyle = col; g.fillStyle = col;
      if (f.circle && rpx >= 4 && rings.some((q) => Math.hypot(q[0] - sx, q[1] - sy) < q[2] + rpx + 2)) {
        g.globalAlpha = 0.9;                                          // would overlap another circle: dot only
        g.beginPath(); g.arc(sx, sy, 3, 0, Math.PI * 2); g.fill();
      } else if (f.circle && rpx >= 4) {
        rings.push([sx, sy, rpx]);
        g.globalAlpha = 0.95;
        g.beginPath(); g.arc(sx, sy, rpx, 0, Math.PI * 2); g.stroke();
        if (rpx < 14) { g.beginPath(); g.arc(sx, sy, 1.8, 0, Math.PI * 2); g.fill(); }
      } else if (f.circle) {
        g.globalAlpha = 0.9;
        g.beginPath(); g.arc(sx, sy, 3, 0, Math.PI * 2); g.fill();
      } else {
        g.globalAlpha = 0.95;                                         // linear / area features: diamond at the centre
        g.beginPath(); g.moveTo(sx, sy - 5); g.lineTo(sx + 5, sy); g.lineTo(sx, sy + 5); g.lineTo(sx - 5, sy); g.closePath(); g.fill();
      }
      g.globalAlpha = 1;
      this.featHits.push({ f, sx, sy, r: Math.max(f.circle ? rpx : 0, 8) });

      if (labels < 250 && (!f.circle || rpx >= 8)) {
        const tw = g.measureText(f.name).width;
        const inside = f.circle && rpx > tw / 2 + 8;
        const lx = inside ? sx - tw / 2 : sx - tw / 2, ly = inside ? sy : sy + Math.max(rpx, 5) + 9;
        const box = [lx - 2, ly - 8, lx + tw + 2, ly + 8];
        if (box[2] < 0 || box[0] > w || box[3] < 0 || box[1] > h) continue;
        if (used.some((u) => box[0] < u[2] && box[2] > u[0] && box[1] < u[3] && box[3] > u[1])) continue;
        used.push(box); labels++;
        g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(f.name, lx, ly);
        g.fillStyle = '#fff'; g.fillText(f.name, lx, ly);
      }
    }
    g.restore();
    if (this.featCnt && this.featCount !== inRegion) {
      this.featCount = inRegion;
      this.featCnt.textContent = `${inRegion} features in this map area`;
    }
  }

  // Smallest drawn feature under a screen position (client coords), or null.
  featureAt(cx, cy) {
    if (!this.showFeat || !this.featHits?.length || !this.featOrigin) return null;
    const x = cx - this.featOrigin.left, y = cy - this.featOrigin.top;
    let best = null;
    for (const hit of this.featHits) {
      if (Math.hypot(hit.sx - x, hit.sy - y) <= hit.r && (!best || hit.f.diameter < best.diameter)) best = hit.f;
    }
    return best;
  }

  featureHtml(f) {
    const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const kind = f.type.split(',')[0];
    const dia = f.diameter >= 100 ? f.diameter.toFixed(0) : f.diameter.toFixed(1);
    return `<div style="font-weight:600;font-size:13px;color:${FEATURE_COLORS[f.kind]}">${esc(f.name)}</div>` +
      `<div>${esc(kind)} · ${dia} km</div>` +
      `<div>${fmtLat(f.lat)}, ${fmtLon(f.lon)}</div>` +
      (f.origin ? `<div style="opacity:.8;margin-top:2px">${esc(f.origin)}</div>` : '') +
      `<div style="opacity:.6;font-size:11px">${esc(f.approval)}${f.year ? ` · ${f.year}` : ''}</div>` +
      `<div style="border-top:1px solid rgba(255,255,255,.2);margin:4px 0 3px"></div>`;
  }

  removeTip() {
    if (!this.tip) return;
    this.hideTip();
    window.removeEventListener('pointermove', this.onTipMove);
    window.removeEventListener('wheel', this.hideTip);
    window.removeEventListener('pointerup', this.onTipUp);
    this.el?.removeEventListener('pointerleave', this.hideTip);
    this.tip.remove(); this.tip = null;
  }

  exit(clearMarkers = true, dispose = false) {
    if (this.waitTimer) { clearInterval(this.waitTimer); this.waitTimer = null; }
    if (!this.active && !(dispose && this.flatView)) return;
    const cam = this.ctx.camera, s = this.saved;

    if (FLAT_ONLY && !dispose) {
      // picking is over, but the view stays flat 2D: keep the lock, pan and zoom running
      this.flatView = true;
      this.rect = this.terrain.regionRect;
      if (clearMarkers) this.clearMarkers();
      this.removeHud();
      this.active = false;
      this.busy = false;
      this.ctx.state.set('mode', 'world');
      return;
    }
    this.flatView = false;

    if (this.lockRaf) cancelAnimationFrame(this.lockRaf);
    this.lockRaf = null;
    window.removeEventListener('pointerdown', this.onDownCap, true);
    window.removeEventListener('wheel', this.onWheelCap, { capture: true });
    window.removeEventListener('contextmenu', this.onCtx, true);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('keydown', this.onKey);
    this.removeTip();
    this.removeFeatureUI();
    this.el.style.touchAction = this.prevTouchAction ?? '';

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

    // gradient per cell (for sideways-slope checks)
    const GX = new Float32Array(W * H), GZ = new Float32Array(W * H);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(W - 1, i + 1);
        const j0 = Math.max(0, j - 1), j1 = Math.min(H - 1, j + 1);
        const a = hgt[j * W + i0], b = hgt[j * W + i1], c = hgt[j0 * W + i], d = hgt[j1 * W + i];
        if (isNaN(a) || isNaN(b) || isNaN(c) || isNaN(d)) continue;
        GX[j * W + i] = (b - a) / ((i1 - i0) * cs);
        GZ[j * W + i] = (d - c) / ((j1 - j0) * cs);
      }

    // height above the average of the surroundings (box mean via integral images). > 0 = hill / ridge / peak
    const R = Math.max(2, Math.round(PLAN.tpiRadiusM / cs));
    const SW = W + 1;
    const sumI = new Float64Array(SW * (H + 1)), cntI = new Float64Array(SW * (H + 1));
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const v = hgt[j * W + i], ok = v === v ? 1 : 0;
        const k = (j + 1) * SW + i + 1;
        sumI[k] = (ok ? v : 0) + sumI[k - 1] + sumI[k - SW] - sumI[k - SW - 1];
        cntI[k] = ok + cntI[k - 1] + cntI[k - SW] - cntI[k - SW - 1];
      }
    const tpi = new Float32Array(W * H);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const ia = Math.max(0, i - R), ib = Math.min(W, i + R + 1), ja = Math.max(0, j - R), jb = Math.min(H, j + R + 1);
        const S = sumI[jb * SW + ib] - sumI[ja * SW + ib] - sumI[jb * SW + ia] + sumI[ja * SW + ia];
        const C = cntI[jb * SW + ib] - cntI[ja * SW + ib] - cntI[jb * SW + ia] + cntI[ja * SW + ia];
        const v = hgt[j * W + i];
        tpi[j * W + i] = C > 0 && v === v ? v - S / C : 0;
      }
    const hCap = Math.max(hgt[si], hgt[gi]);   // going higher than both pins = going over a mountain

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
          // sideways slope: how steep is the ground perpendicular to the direction of travel
          const mx = dx / Math.hypot(dx, dz), mz = dz / Math.hypot(dx, dz);
          const ggx = (GX[cur] + GX[n]) / 2, ggz = (GZ[cur] + GZ[n]) / 2;
          const crossTheta = Math.atan(Math.abs(ggx * mz - ggz * mx)) * 180 / Math.PI;
          if (crossTheta > limit * PLAN.crossMaxFactor) continue;
          const ridge = Math.max(0, tpi[n]) / PLAN.ridgeRef;
          const high = Math.max(0, hgt[n] - hCap) / PLAN.elevRef;
          const t = g[cur] + d * (1
            + PLAN.slopeWeight * (theta / PLAN.slopeRefDeg) ** 2
            + PLAN.crossWeight * (crossTheta / PLAN.crossRefDeg) ** 2
            + PLAN.ridgeWeight * ridge * ridge
            + PLAN.elevWeight * high);
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
    const ground = this.pathHeights(pts);
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

  // Ground height at world x/z. ONE source only (the drawn-surface sampler). The old version took the max
  // of two samplers, which jumped whenever they disagreed (that was the rollercoaster).
  groundAt(x, z) {
    const t = this.terrain;
    const w = t.sampleWorld?.(x, z);
    if (w != null && Number.isFinite(w)) return w;
    try {
      if (t.worldToGrid && t.heightAt && t.gridToWorld) {
        const { gx, gz } = t.worldToGrid(x, z);
        if (!Number.isNaN(t.heightAt(gx, gz))) return t.gridToWorld(gx, gz).y;
      }
    } catch (e) { /* grid not ready */ }
    return null;
  }

  // Heights for a list of x/z: real ground, low-pass filtered along the path, then clamped to a thin band
  // around the real ground so it is smooth but never floats or sinks.
  pathHeights(xz) {
    const raw = [];
    let last = 0;
    for (const p of xz) { last = this.groundAt(p.x, p.z) ?? last; raw.push(last); }
    const sm = movingAvg(movingAvg(raw, PLAN.profileWindow), PLAN.profileWindow);
    return sm.map((y, i) => Math.min(raw[i] + PLAN.hoverBand, Math.max(raw[i] - PLAN.hoverBand, y)));
  }

  // Lay every ring of the route tube back onto the ground that is drawn right now.
  // The tube stores centre + normal (radius 1), so centre = position - normal.
  redrape() {
    const geo = this.routeGeo;
    if (!geo || !this.terrain) return;
    const pos = geo.attributes.position, nor = geo.attributes.normal;
    const per = 7;                                   // radial segments (6) + 1 seam vertex
    const rings = [];
    for (let i0 = 0; i0 + per <= pos.count; i0 += per)
      rings.push({ i0, x: pos.getX(i0) - nor.getX(i0), z: pos.getZ(i0) - nor.getZ(i0) });
    const ys = this.pathHeights(rings);
    rings.forEach((r, n) => {
      const cy = ys[n] + PLAN.groundLift;
      for (let k = 0; k < per; k++) pos.setY(r.i0 + k, cy + nor.getY(r.i0 + k));
    });
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
    this.makeCoordBox();
    this.updateHud();
  }

  // ---- pick by typing coordinates ----
  parseCoord(str, axis) {
    const m = String(str).trim().replace(/°/g, '').match(/^([+-]?\d+(?:\.\d+)?)\s*([NSEW])?$/i);
    if (!m) return null;
    let v = parseFloat(m[1]);
    const L = (m[2] || '').toUpperCase();
    if (L) {
      if (axis === 'lat' && L !== 'N' && L !== 'S') return null;
      if (axis === 'lon' && L !== 'E' && L !== 'W') return null;
      v = (L === 'S' || L === 'W') ? -Math.abs(v) : Math.abs(v);
    }
    if (axis === 'lat' && Math.abs(v) > 90) return null;
    if (axis === 'lon' && Math.abs(v) > 360) return null;
    return v;
  }

  makeCoordBox() {
    const box = this.coordBox = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed', left: '50%', bottom: '20px', transform: 'translateX(-50%)',
      padding: '8px 12px', background: 'rgba(0,0,0,0.75)', color: '#fff', borderRadius: '8px',
      font: '13px system-ui, sans-serif', zIndex: 1000, display: 'flex', gap: '8px',
      alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center', maxWidth: '96vw',
    });
    const field = (ph) => {
      const i = document.createElement('input');
      i.type = 'text'; i.placeholder = ph; i.autocomplete = 'off';
      Object.assign(i.style, {
        width: '120px', padding: '5px 8px', borderRadius: '5px', border: '1px solid rgba(255,255,255,0.35)',
        background: 'rgba(255,255,255,0.1)', color: '#fff', font: '13px system-ui, sans-serif', outline: 'none',
      });
      // typing must not trigger other shortcuts; Enter adds the point, Esc leaves the field
      i.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') add();
        else if (e.key === 'Escape') i.blur();
      });
      return i;
    };
    const lat = field('Latitude  e.g. 18.45'), lon = field('Longitude  e.g. 77.45');
    const btn = document.createElement('button');
    btn.textContent = 'Add point';
    Object.assign(btn.style, {
      padding: '5px 12px', borderRadius: '5px', border: '1px solid rgba(255,255,255,0.35)',
      background: '#2d6cdf', color: '#fff', font: '13px system-ui, sans-serif', cursor: 'pointer',
    });
    const msg = this.coordMsg = document.createElement('span');
    msg.style.cssText = 'flex-basis:100%;text-align:center;font-size:12px;min-height:14px;color:#ffb4b4';
    const add = () => {
      if (this.busy) return;
      msg.style.color = '#ffb4b4';
      // allow pasting "lat, lon" into the latitude field
      if (lat.value.includes(',') && !lon.value.trim()) {
        const [a, b] = lat.value.split(',');
        lat.value = a.trim(); lon.value = (b || '').trim();
      }
      const la = this.parseCoord(lat.value, 'lat'), lo = this.parseCoord(lon.value, 'lon');
      if (la == null || lo == null) { msg.textContent = 'Enter valid numbers, e.g. 18.45 and 77.45 (N/S/E/W allowed).'; return; }
      const w = this.terrain.lonLatToWorld(lo, la), r = this.rect;
      if (w.x < r.x0 || w.x > r.x1 || w.z < r.z0 || w.z > r.z1) { msg.textContent = 'That point is outside the loaded map area.'; return; }
      const y = this.terrain.sampleWorld(w.x, w.z);
      if (y == null || !Number.isFinite(y)) { msg.textContent = 'No terrain data at that location.'; return; }
      const cam = this.ctx.camera;                       // centre the map on the new point
      cam.position.x = THREE.MathUtils.clamp(w.x, r.x0, r.x1);
      cam.position.z = THREE.MathUtils.clamp(w.z, r.z0, r.z1);
      this.addPick({ x: w.x, y, z: w.z });
      lat.value = ''; lon.value = '';
      if (this.active && !this.busy) { msg.style.color = '#b6f0b6'; msg.textContent = `Point ${this.picks.length} added.`; }
      else msg.textContent = '';
    };
    btn.onclick = add;
    box.append(lat, lon, btn, msg);
    document.body.appendChild(box);
  }

  updateHud() {
    if (this.coordBox) this.coordBox.style.display = this.busy ? 'none' : 'flex';
    if (this.hud) this.hud.textContent = this.busy ? 'Planning route…' :
      `Map view: click point ${Math.min(this.picks.length + 1, 2)} of 2  (click the map or type coordinates below, Esc = skip)`;
  }

  removeHud() {
    this.hud?.remove(); this.hud = null;
    this.coordBox?.remove(); this.coordBox = null;
  }

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
    this.exit(true, true);
    this.removeFeatureUI();
    this.removeHud();
    this.removePanel();
    this.clearRoute();
    this.clearMarkers();
    this.ctx.scene.remove(this.markers);
    this.ctx.scene.remove(this.routeGroup);
  }
}
