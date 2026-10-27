import * as THREE from 'three';
import { Module } from '../../core/Module.js';
import { lodViews } from '../../core/lodViews.js';

// "Astro": a ball with eyes, 1.7 m tall, walking on the terrain. His own camera is drawn in a small
// second screen in the top-right corner of the window. The main view is left untouched.
//
// Controls:  W A S D = walk   Shift = run   Arrow left/right = turn   Arrow up/down = look up/down
//            R = drop Astro under the main camera   C = switch Astro's controls on/off
//            After the two map points are picked, Astro starts on point A and walks the planned route to B by himself.
//            F = restart the route from A   P = pause / resume   W/A/S/D = take over manual control
//
// This module only reads the 'terrain' object that WorldModule publishes (heightAt / gridToWorld / worldToGrid).
// It does not touch lights, fog, background or the main camera's position.

const BODY_R = 0.85;            // ball radius, metres  (diameter 1.7 m = 170 cm tall)
const EYE_H = 1.5;              // camera height above the ground, metres
const FOV = 70;
const WALK = 6;                 // m/s
const RUN_MULT = 5;
const SPEED_STEPS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];   // speed multipliers the - / + buttons step through (1 = normal)
const TURN = 1.8;               // rad/s
const PITCH_MAX = 1.4;          // rad, how far up/down he can look
const SMOOTH = 40;              // how fast he settles DOWN onto the ground (going up he is never allowed below it)
const CAM_CLEAR = 0.9;          // the camera always stays at least this far above any ground around it, metres
const INSET_W = 560, INSET_H = 440, MARGIN = 16;   // second screen size in CSS pixels
const BEACON = true;            // thin cyan pillar so you can find him from the main view
const ROUTE_SPEED = 20;         // m/s while Astro walks the planned route (Shift = x RUN_MULT)
const LOOK_AHEAD = 40;          // metres ahead on the path that he turns to face (bigger = ignores small wiggles in the path)
const ROUTE_STRAIGHTEN = 60;     // metres: Astro cuts across small bends of the planned route instead of tracing every curve (0 = follow the path exactly)
const TURN_DEADZONE = 0.35;     // rad (~20 deg): while following the route the camera does NOT turn for bends smaller than this
const ROUTE_TURN_RATE = 2;      // how quickly the camera swings round when it does turn (was 6; smaller = calmer)
const BODY_LAYER = 1;
const RING_M = 350;             // full-detail circle around Astro, metres, in every direction           // body is only drawn for the main camera, never in his own view

export class CharacterModule extends Module {
  static id = 'character';

  async init() {
    this.alive = true;
    this.enabled = true;
    this.keys = new Set();
    this.x = 0; this.z = 0; this.y = 0;      // world position; (0, 0) = centre of the HiRISE area
    this.yaw = 0; this.pitch = 0;
    this.snap = true;                         // next ground height is applied instantly
    this.busy = false;
    this.route = null; this.routeSrc = null;  // planned route from MapPickModule (state 'route')
    this.following = false; this.paused = false; this.routeS = 0;
    this.last = performance.now();

    // his eyes
    this.cam = new THREE.PerspectiveCamera(FOV, INSET_W / INSET_H, 0.5, 400000);
    this.cam.rotation.order = 'YXZ';

    // his body
    this.group = this.buildBody();
    this.ctx.scene.add(this.group);

    // second-screen frame (DOM overlay)
    this.frame = document.createElement('div');
    this.frame.style.cssText =
      'position:fixed;pointer-events:none;box-sizing:border-box;border:2px solid #fff;' +
      'box-shadow:0 0 14px rgba(0,0,0,.6);z-index:10;font:600 11px/1 system-ui,sans-serif;color:#fff;';
    this.label = document.createElement('div');
    this.label.style.cssText = 'position:absolute;left:6px;bottom:6px;text-shadow:0 0 4px #000;';
    this.frame.appendChild(this.label);
    document.body.appendChild(this.frame);
    // coordinates readout (toggle with the V key)
    this.coords = document.createElement('pre');
    this.coords.style.cssText =
      'position:fixed;pointer-events:none;z-index:10;margin:0;padding:8px;display:none;' +
      'font:12px monospace;color:#9f9;background:rgba(0,0,0,.75);border:1px solid #444;border-radius:4px;';
    document.body.appendChild(this.coords);

    // speed buttons under the Astro cam:  [ - ]  Speed x1  [ + ]
    this.speedIdx = SPEED_STEPS.indexOf(1);
    this.speedMul = 1;
    this.speedBar = document.createElement('div');
    this.speedBar.style.cssText =
      'position:fixed;z-index:1001;box-sizing:border-box;display:flex;align-items:center;gap:6px;padding:4px 6px;' +
      'background:rgba(0,0,0,.75);border:1px solid #444;border-radius:4px;font:600 12px system-ui,sans-serif;color:#fff;user-select:none;';
    const mk = (txt, title, fn) => {
      const b = document.createElement('button');
      b.textContent = txt; b.title = title;
      b.style.cssText = 'width:28px;height:24px;border-radius:4px;border:1px solid rgba(255,255,255,.35);background:#2d6cdf;color:#fff;font:700 15px/1 system-ui,sans-serif;cursor:pointer;padding:0;';
      b.addEventListener('click', (e) => { fn(); b.blur(); e.stopPropagation(); });
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      return b;
    };
    this.speedTxt = document.createElement('span');
    this.speedTxt.style.cssText = 'flex:1;text-align:center;cursor:pointer;white-space:nowrap;';
    this.speedTxt.title = 'click = back to normal speed';
    this.speedTxt.addEventListener('click', () => this.setSpeed(SPEED_STEPS.indexOf(1)));
    this.speedBar.append(mk('\u2212', 'Slower', () => this.setSpeed(this.speedIdx - 1)), this.speedTxt, mk('+', 'Faster', () => this.setSpeed(this.speedIdx + 1)));
    document.body.appendChild(this.speedBar);
    this.setSpeed(this.speedIdx);

    // keyboard
    this.onKey = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName || '')) return;
      const k = e.code;
      if (k.startsWith('Arrow')) e.preventDefault();
      if (e.type === 'keydown') {
        if (!e.repeat && k === 'KeyR') this.respawn();
        if (!e.repeat && k === 'KeyC') this.enabled = !this.enabled;
        if (!e.repeat && k === 'KeyF') this.startRoute();
        if (!e.repeat && k === 'KeyP' && this.following) this.paused = !this.paused;
        if (!e.repeat && k === 'KeyV') this.coords.style.display = this.coords.style.display === 'none' ? 'block' : 'none';
        this.keys.add(k);
      } else {
        this.keys.delete(k);
      }
    };
    this.onBlur = () => this.keys.clear();
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', this.onBlur);

    // draw after every main render: wrap renderer.render so no change to App.js is needed
    const r = this.ctx.renderer;
    this.prevRender = r.render;
    const prev = this.prevRender.bind(r);
    this.wrapper = (scene, camera) => {
      prev(scene, camera);
      if (this.busy || !this.alive || camera !== this.ctx.camera) return;
      this.busy = true;
      try {
        camera.layers.enable(BODY_LAYER);   // the main camera also sees Astro's body
        this.update();
        this.drawInset(prev, scene);
      } finally {
        this.busy = false;
      }
    };
    r.render = this.wrapper;
  }

  buildBody() {
    const g = new THREE.Group();
    const suit = new THREE.MeshStandardMaterial({ color: 0xece6dd, roughness: 0.6 });
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
    const black = new THREE.MeshStandardMaterial({ color: 0x0b0b0b, roughness: 0.2 });
    this.mats = [suit, white, black];

    const ball = new THREE.Mesh(new THREE.SphereGeometry(BODY_R, 32, 24), suit);
    ball.position.y = BODY_R;
    g.add(ball);

    const eyeGeo = new THREE.SphereGeometry(0.2, 16, 12);
    const pupilGeo = new THREE.SphereGeometry(0.1, 12, 10);
    this.geos = [ball.geometry, eyeGeo, pupilGeo];
    for (const s of [-1, 1]) {                 // he faces -z, like a camera with yaw 0
      const eye = new THREE.Mesh(eyeGeo, white);
      eye.position.set(s * 0.3, 1.15, -0.7);
      const pupil = new THREE.Mesh(pupilGeo, black);
      pupil.position.set(s * 0.3, 1.15, -0.87);
      g.add(eye, pupil);
    }

    if (BEACON) {
      const pillarGeo = new THREE.CylinderGeometry(1.5, 1.5, 300, 8);
      const markGeo = new THREE.SphereGeometry(1, 16, 12);
      const mat = new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.85, depthTest: false });
      const pillar = new THREE.Mesh(pillarGeo, mat);
      pillar.position.y = 150;
      this.marker = new THREE.Mesh(markGeo, mat);   // stays the same size on screen (scaled in update)
      this.marker.position.y = BODY_R;
      pillar.renderOrder = this.marker.renderOrder = 999;
      g.add(pillar, this.marker);
      this.geos.push(pillarGeo, markGeo); this.mats.push(mat);
    }

    g.traverse((o) => o.layers.set(BODY_LAYER));
    return g;
  }

  respawn() {
    const c = this.ctx.camera;
    if (!c) return;
    this.x = c.position.x;
    this.z = c.position.z;
    this.snap = true;
    this.following = false;
  }

  // Highest known ground height at world x/z: the drawn surface (grid) and the route/pick sampler,
  // whichever is higher, so he is never placed under either one. null = no data here.
  groundAt(t, x, z) {
    let h = null;
    const { gx, gz } = t.worldToGrid(x, z);
    if (!Number.isNaN(t.heightAt(gx, gz))) h = t.gridToWorld(gx, gz).y;
    const w = t.sampleWorld?.(x, z);
    if (w != null && Number.isFinite(w)) h = h == null ? w : Math.max(h, w);
    return h;
  }

  // ---- walking the planned route -------------------------------------------------------------
  loadRoute(points) {
    let p = points.map((v) => ({ x: v.x, z: v.z }));
    if (ROUTE_STRAIGHTEN > 0 && p.length > 2) p = this.straighten(p);
    const cum = [0];
    for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z));
    this.route = { p, cum, total: cum[cum.length - 1] };
  }

  // Smooth the path so small wiggles are cut straight; the start (A) and end (B) stay exactly where they are.
  straighten(p) {
    const cum = [0];
    for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z));
    const total = cum[cum.length - 1];
    if (total < 1) return p;
    const n = Math.max(2, Math.ceil(total / 2));                  // resample about every 2 m
    let q = [], j = 0;
    for (let i = 0; i <= n; i++) {
      const sd = (i / n) * total;
      while (j < cum.length - 2 && cum[j + 1] < sd) j++;
      const seg = cum[j + 1] - cum[j] || 1, f = Math.min(1, Math.max(0, (sd - cum[j]) / seg));
      q.push({ x: p[j].x + (p[j + 1].x - p[j].x) * f, z: p[j].z + (p[j + 1].z - p[j].z) * f });
    }
    const k = Math.max(1, Math.round(ROUTE_STRAIGHTEN / (total / n)));
    for (let pass = 0; pass < 3; pass++) {                        // moving average; window shrinks to 0 at the ends so A and B are pinned
      q = q.map((_, i) => {
        const w = Math.min(k, i, n - i);
        let sx = 0, sz = 0;
        for (let m = i - w; m <= i + w; m++) { sx += q[m].x; sz += q[m].z; }
        return { x: sx / (2 * w + 1), z: sz / (2 * w + 1) };
      });
    }
    return q;
  }

  // x/z on the route after walking s metres along it
  routePoint(s) {
    const { p, cum, total } = this.route;
    s = Math.max(0, Math.min(total, s));
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const seg = cum[hi] - cum[lo] || 1, t = (s - cum[lo]) / seg;
    return { x: p[lo].x + (p[hi].x - p[lo].x) * t, z: p[lo].z + (p[hi].z - p[lo].z) * t };
  }

  // put Astro on point A, facing along the path, and start walking
  startRoute() {
    if (!this.route || this.route.total <= 0) return;
    const a = this.routePoint(0), b = this.routePoint(LOOK_AHEAD);
    this.x = a.x; this.z = a.z;
    this.yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));   // forward = (-sin yaw, -cos yaw)
    this.routeS = 0;
    this.following = true; this.paused = false; this.enabled = true;
    this.snap = true;
  }

  update() {
    const t = this.ctx.state.get('terrain');
    if (!t) return;
        if (!this.registered) {
      this.cam.userData.ringRadius = RING_M;
      this.cam.userData.ringHeight = 1600;
      lodViews.push(this.cam);
      this.registered = true;
      console.log('[astro] camera registered with the terrain');
    }
    // a new route from the map module: jump to point A and start walking
    const route = this.ctx.state.get('route');
    if (route && route !== this.routeSrc && route.length > 1) {
      this.routeSrc = route;
      this.loadRoute(route);
      this.startRoute();
    }
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    const k = this.keys;

    if (this.enabled) {
      if (!this.following) {                      // the path decides where he faces while he follows it
        if (k.has('ArrowLeft')) this.yaw += TURN * dt;
        if (k.has('ArrowRight')) this.yaw -= TURN * dt;
      }
      if (k.has('ArrowUp')) this.pitch += TURN * dt;
      if (k.has('ArrowDown')) this.pitch -= TURN * dt;
      this.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, this.pitch));

      const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
      const s = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
      if (this.following && (f || s)) this.following = false;   // WASD = take over manually
      if (this.following) {
        if (!this.paused) {
          const run = k.has('ShiftLeft') || k.has('ShiftRight') ? RUN_MULT : 1;
          this.routeS += ROUTE_SPEED * this.speedMul * run * dt;
          const a = this.routePoint(this.routeS), b = this.routePoint(this.routeS + LOOK_AHEAD);
          this.x = a.x; this.z = a.z;
          if (Math.hypot(b.x - a.x, b.z - a.z) > 0.01) {
            let d = Math.atan2(-(b.x - a.x), -(b.z - a.z)) - this.yaw;
            d = Math.atan2(Math.sin(d), Math.cos(d));              // shortest turn
            // curvy but roughly straight stretch: keep looking straight ahead, only turn for the part beyond the dead zone
            d = Math.abs(d) <= TURN_DEADZONE ? 0 : d - Math.sign(d) * TURN_DEADZONE;
            this.yaw += d * (1 - Math.exp(-ROUTE_TURN_RATE * dt));
          }
          if (this.routeS >= this.route.total) this.following = false;   // arrived at B
        }
      } else if (f || s) {
        const run = k.has('ShiftLeft') || k.has('ShiftRight') ? RUN_MULT : 1;
        const sp = (WALK * this.speedMul * run * dt) / Math.hypot(f, s);
        const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
        this.x += (-sin * f + cos * s) * sp;      // forward = (-sin, -cos), right = (cos, -sin)
        this.z += (-cos * f - sin * s) * sp;
      }
    }

    // stay inside the terrain footprint
    const hx = ((t.width - 1) / 2) * t.cellSize, hz = ((t.height - 1) / 2) * t.cellSize;
    this.x = Math.max(-hx, Math.min(hx, this.x));
    this.z = Math.max(-hz, Math.min(hz, this.z));

    // stand on the surface that is actually drawn (follows hills, crater walls and mountains)
    const target = this.groundAt(t, this.x, this.z);
    if (target != null) {
      // going up (or first frame): sit exactly on the ground, never below it; going down: settle quickly
      if (this.snap || target > this.y) this.y = target;
      else this.y += (target - this.y) * (1 - Math.exp(-SMOOTH * dt));
      this.snap = false;
    }

    if (this.marker && this.ctx.camera) {
      const d = this.ctx.camera.position.distanceTo(this.group.position);
      this.marker.scale.setScalar(Math.max(BODY_R, d * 0.012));   // about 1% of the screen, never smaller than the ball
    }

    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.y = this.yaw;
    // camera: eye height, but pushed up if ANY ground around him (ahead, behind, sides) is higher,
    // so a slope or crater wall in front of him can never cut into the camera
    let camY = this.y + EYE_H;
    const sn = Math.sin(this.yaw), cs = Math.cos(this.yaw);
    const probes = [[0, 0], [-sn * 2, -cs * 2], [sn * 1.5, cs * 1.5], [cs * 1.5, -sn * 1.5], [-cs * 1.5, sn * 1.5]];
    for (const [dx, dz] of probes) {
      const h = this.groundAt(t, this.x + dx, this.z + dz);
      if (h != null) camY = Math.max(camY, h + CAM_CLEAR);
    }
    this.cam.position.set(this.x, camY, this.z);
    this.cam.rotation.set(this.pitch, this.yaw, 0);
  }

  drawInset(render, scene) {
    const r = this.ctx.renderer;
    const size = r.getSize(new THREE.Vector2());
    const w = Math.min(INSET_W, size.x * 0.4), h = Math.round((w * INSET_H) / INSET_W);
    const x = size.x - w - MARGIN, y = size.y - h - MARGIN;   // viewport origin is bottom-left

    const vp = r.getViewport(new THREE.Vector4());
    const sc = r.getScissor(new THREE.Vector4());
    const st = r.getScissorTest();
    const ac = r.autoClear;

    r.setScissorTest(true);
    r.setViewport(x, y, w, h);
    r.setScissor(x, y, w, h);
    r.autoClear = true;
    this.cam.aspect = w / h;
    this.cam.userData.viewHeight = h * r.getPixelRatio();   // true size of his screen, so far mountains aren't over-detailed
    this.cam.updateProjectionMatrix();
    render(scene, this.cam);

    r.setViewport(vp);
    r.setScissor(sc);
    r.setScissorTest(st);
    r.autoClear = ac;

    const rect = r.domElement.getBoundingClientRect();
    const s = this.frame.style;
    s.left = `${rect.right - w - MARGIN}px`;
    s.top = `${rect.top + MARGIN}px`;
    s.width = `${w}px`;
    s.height = `${h}px`;
    this.updateCoords();
    const c = this.coords.style;
    c.left = `${rect.right - w - MARGIN}px`;   // sits just under the Astro cam
    const sb = this.speedBar.style;                       // speed buttons sit right under the Astro cam
    sb.left = `${rect.right - w - MARGIN}px`;
    sb.top = `${rect.top + MARGIN + h + 6}px`;
    sb.width = `${w - 18}px`;
    c.top = `${rect.top + MARGIN + h + 6 + 36}px`;        // coordinates readout moves down below the buttons
    c.width = `${w - 18}px`;
    this.label.textContent = !this.enabled ? 'ASTRO CAM  paused (C = on)'
      : this.following ? `ASTRO CAM  on route ${Math.round((this.routeS / this.route.total) * 100)}%  (P = ${this.paused ? 'resume' : 'pause'}, WASD = manual)`
      : this.route ? 'ASTRO CAM  (F = walk route again, C = off)' : 'ASTRO CAM  (C = off)';
  }

  setSpeed(i) {
    this.speedIdx = Math.max(0, Math.min(SPEED_STEPS.length - 1, i));
    this.speedMul = SPEED_STEPS[this.speedIdx];
    this.speedTxt.textContent = `Speed \u00d7${this.speedMul}`;
  }

  updateCoords() {
    if (this.coords.style.display === 'none') return;
    const t = this.ctx.state.get('terrain');
    if (!t?.worldToLonLat) { this.coords.textContent = 'terrain not ready'; return; }
    const { lon, lat } = t.worldToLonLat(this.x, this.z);
    const real = t.sample(lon, lat);
    const r = t.hiriseRect;
    const inHi = this.x >= r.x0 && this.x <= r.x1 && this.z >= r.z0 && this.z <= r.z1;
    const f = (v, d = 1) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(d));
    this.coords.textContent = [
      'Astro',
      ' lat ' + lat.toFixed(5) + ' deg',
      ' lon ' + lon.toFixed(5) + ' deg',
      ' world x ' + f(this.x) + '  z ' + f(this.z),
      ' ground ' + f(real?.h) + ' m (' + (real?.layer ?? 'no data') + ')',
      ' in HiRISE area: ' + (inHi ? 'yes' : 'no'),
    ].join('\n');
  }

  dispose() {
    const i = lodViews.indexOf(this.cam); if (i >= 0) lodViews.splice(i, 1);
    super.dispose();
    this.alive = false;
    const r = this.ctx.renderer;
    if (r && r.render === this.wrapper) r.render = this.prevRender;
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
    this.frame?.remove();
    this.ctx.camera?.layers.disable(BODY_LAYER);
    if (this.group) this.ctx.scene.remove(this.group);
    for (const g of this.geos || []) g.dispose();
    for (const m of this.mats || []) m.dispose();
    this.coords?.remove();
    this.speedBar?.remove();
  }
}
