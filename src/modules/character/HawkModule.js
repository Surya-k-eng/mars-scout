import * as THREE from 'three';
import { Module } from '../../core/Module.js';
import { lodViews } from '../../core/lodViews.js';

// "Hawk": a flying camera. Put the mouse cursor on a place on the map and press H.
//   - that spot is marked (orange pin, visible in the main map view)
//   - Hawk's camera flies in and circles the spot cinematically, looking at it all the time
//   - press H again to stop: the marker is removed and the panel goes away
// Hawk's view lives in a UI panel (bottom-left dock). The panel's "–" / "+" button minimizes it
// (minimized = Hawk stops rendering, so it costs nothing).
//
// The marked point is stored as longitude/latitude, so it stays in the right place even if the world
// is recentered (MapPickModule.finish() does that).
//
// CINEMATIC: low close orbit with crane-up reveals, aim lag, speed drift, banking into the turn,
// handheld drift, lens change during the fly-in, 2.4:1 frame, vignette and a fading title card.
//
// Needs 'ui' in modules.config.js BEFORE this module.

const KEY = 'KeyH';
const FOV = 50;
const ORBIT_RADIUS = 250;      // metres, distance from the marked point (flat distance)
const ORBIT_HEIGHT = 190;       // metres above the marked ground (low = terrain fills the frame)
const ORBIT_SPEED = 0.32;      // rad/s base speed (varies, see SPEED_*)
const SPEED_MIN = 0.55;        // slowest speed as a fraction of ORBIT_SPEED
const SPEED_VAR = 0.55;        // extra speed on top of SPEED_MIN at the fastest moment
const LOOK_HEIGHT = 30;         // metres above the ground the camera aims at
const LOOK_LAG = 2.5;          // how quickly the aim catches up with the target (bigger = tighter)
const FLY_IN = 4;              // seconds: starts far and high, then glides in
const BREATHE_R = 0.12;        // radius slowly changes by +-12 %
const BREATHE_H = 0.2;         // height slowly changes by +-20 %
const CRANE_GAIN = 1.5;        // extra height multiplier at the top of a crane-up
const CRANE_RATE = 0.08;       // crane-up cycle speed (one crane about every 80 s)
const BANK = 1.2;              // roll into the turn: radians of roll per rad/s of orbit speed
const BANK_SMOOTH = 2;         // how quickly the roll follows
const SHAKE_POS = 0.5;         // handheld drift, metres
const SHAKE_ROT = 0.002;       // handheld drift, radians
const FOV_FLY = 15;            // degrees narrower at the start of the fly-in (long lens -> wide)
const FOV_BREATHE = 4;         // degrees the lens slowly breathes afterwards
const GROUND_CLEAR = 12;       // camera never lower than this above the ground below it, metres
const HEIGHT_SMOOTH = 3;       // how quickly the camera height follows hills (bigger = faster)
const RING_M = 600;            // full-detail terrain circle around Hawk's camera, metres
const VIEW_W = 800, VIEW_H = 333;   // Hawk's render size in REAL pixels (2.4:1). Smaller = faster.
const PANEL_W = 520;           // width of the Hawk panel in CSS pixels (the picture scales to fit)
const HAWK_FPS = 30;           // Hawk redraws at most this often
const MARK_LAYER = 2;          // marker is drawn for the main camera only (not in Hawk's own view)
const MARK_PX = 30;            // marker height on screen in pixels (constant at any zoom)
const MARK_UNIT_H = 7.6;
const MARK_COLOR = 0xff9f1c;
const TITLE_IN = 0.8, TITLE_HOLD = 4.8, TITLE_OUT = 6.0;   // seconds: title card fades in, holds, gone

const ease = (x) => x * x * x * (x * (x * 6 - 15) + 10);   // smootherstep
const clamp01 = (x) => Math.min(1, Math.max(0, x));

export class HawkModule extends Module {
  static id = 'hawk';
  static requires = ['world', 'ui'];

  async init() {
    this.alive = true;
    this.active = false;
    this.busy = false;
    this.target = null;               // { lon, lat }
    this.time = 0; this.theta = 0; this.camY = null; this.lastPy = 0;
    this.look = new THREE.Vector3(); this.lookInit = false;
    this.roll = 0;
    this.last = performance.now();
    this.lastDraw = 0;
    this.mx = 0; this.my = 0; this.overCanvas = false;
    this.marker = null;
    this.registered = false;

    this.cam = new THREE.PerspectiveCamera(FOV, VIEW_W / VIEW_H, 0.5, 400000);

    // ---- UI panel (bottom-left dock) with Hawk's picture. The panel's own "-" button minimizes it. ----
    this.panel = this.ctx.ui.addPanel({
      id: 'hawk',
      title: 'Hawk cam  (H = stop)',
      dock: 'left',
      build: (body, ui) => {
        this.wrap = ui.el('div', body);
        this.wrap.style.cssText =
          'position:relative;width:100%;aspect-ratio:2.4/1;background:#000;border-radius:4px;overflow:hidden;';
        this.view = ui.el('canvas', this.wrap);
        this.view.width = VIEW_W; this.view.height = VIEW_H;
        this.view.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
        this.viewG = this.view.getContext('2d');
        const vig = ui.el('div', this.wrap);
        vig.style.cssText = 'position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 46px rgba(0,0,0,.55);';
        this.title = ui.el('div', this.wrap);
        this.title.style.cssText =
          'position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);text-align:center;color:#fff;' +
          'font:300 14px/1.2 system-ui,sans-serif;letter-spacing:.32em;text-transform:uppercase;' +
          'text-shadow:0 0 8px #000,0 0 2px #000;opacity:0;white-space:nowrap;pointer-events:none;';
      },
    });
    this.panel.root.style.boxSizing = 'border-box';
    this.panel.root.style.width = `${PANEL_W}px`;
    this.panel.root.style.maxWidth = 'calc(100vw - 24px)';
    this.panel.hide();

    this.toastEl = document.createElement('div');
    this.toastEl.style.cssText =
      'position:fixed;left:50%;top:60px;transform:translateX(-50%);z-index:1002;display:none;pointer-events:none;' +
      'padding:7px 14px;background:rgba(0,0,0,.8);color:#fff;border:1px solid rgba(255,255,255,.3);' +
      'border-radius:6px;font:13px system-ui,sans-serif;';
    document.body.appendChild(this.toastEl);

    // ---- input ----
    this.onMove = (e) => {
      this.mx = e.clientX; this.my = e.clientY;
      this.overCanvas = e.target === this.ctx.renderer.domElement;
    };
    this.onKey = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName || '')) return;
      if (e.code !== KEY || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      this.toggle();
    };
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('keydown', this.onKey);

    // ---- draw Hawk just BEFORE every main render; the main view then paints over that corner ----
    const r = this.ctx.renderer;
    this.prevRender = r.render;
    const prev = this.prevRender.bind(r);
    this.wrapper = (scene, camera) => {
      if (this.busy || !this.alive || camera !== this.ctx.camera) { prev(scene, camera); return; }
      this.busy = true;
      try {
        camera.layers.enable(MARK_LAYER);     // the main camera sees the marker
        this.update();
        if (this.active && this.shouldDraw()) this.drawHawk(prev, scene);
        prev(scene, camera);
      } finally {
        this.busy = false;
      }
    };
    r.render = this.wrapper;
  }

  // ===================== start / stop =====================

  toggle() {
    if (this.active) { this.stop(); return; }
    const t = this.ctx.state.get('terrain');
    if (!t) { this.toast('Terrain is not ready yet'); return; }
    const g = this.groundUnderCursor(t);
    if (!g) { this.toast('Move the cursor over the map, then press H'); return; }
    this.start(t, g);
  }

  start(t, g) {
    const { lon, lat } = t.worldToLonLat(g.x, g.z);
    this.target = { lon, lat };
    this.time = 0;
    this.camY = null;
    this.lookInit = false;
    this.roll = 0;
    this.lastPy = g.y;
    // begin the circle on the side where the main camera currently is
    const c = this.ctx.camera.position;
    const dx = c.x - g.x, dz = c.z - g.z;
    this.theta = Math.hypot(dx, dz) > 1 ? Math.atan2(dz, dx) : 0;

    this.title.textContent = this.formatTitle(lon, lat);
    this.title.style.opacity = '0';
    this.viewG.fillStyle = '#000';
    this.viewG.fillRect(0, 0, VIEW_W, VIEW_H);

    this.marker = this.makeMarker();
    this.marker.position.set(g.x, g.y, g.z);
    this.ctx.scene.add(this.marker);

    // let the terrain load detail around Hawk's camera
    this.cam.userData.ringRadius = RING_M;
    this.cam.userData.ringHeight = 1600;
    if (!this.registered) { lodViews.push(this.cam); this.registered = true; }

    this.active = true;
    this.panel.show();
    console.log('[hawk] orbiting', lon.toFixed(5), lat.toFixed(5));
  }

  stop() {
    this.active = false;
    this.target = null;
    this.camY = null;
    this.lookInit = false;
    this.panel?.hide();
    this.removeMarker();
    if (this.registered) {
      const i = lodViews.indexOf(this.cam);
      if (i >= 0) lodViews.splice(i, 1);
      this.registered = false;
    }
  }

  // ===================== helpers =====================

  // minimized panel (or hidden) = do not render Hawk at all
  shouldDraw() {
    if (this.panel.root.classList.contains('collapsed')) return false;
    return performance.now() - this.lastDraw >= 1000 / HAWK_FPS;
  }

  formatTitle(lon, lat) {
    const l = ((lon + 180) % 360 + 360) % 360 - 180;       // -180..180
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = l >= 0 ? 'E' : 'W';
    return `MARS · ${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(l).toFixed(2)}°${ew}`;
  }

  // World x/y/z of the ground under the mouse (refined against the drawn terrain height).
  groundUnderCursor(t) {
    if (!this.overCanvas) return null;
    const el = this.ctx.renderer.domElement;
    const rect = el.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((this.mx - rect.left) / rect.width) * 2 - 1,
      -((this.my - rect.top) / rect.height) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.ctx.camera);
    const hit = new THREE.Vector3();
    let y = 0;
    for (let i = 0; i < 3; i++) {
      if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), hit)) return null;
      y = t.sampleWorld(hit.x, hit.z) ?? y;
    }
    const h = t.sampleWorld(hit.x, hit.z);
    if (h == null || !Number.isFinite(h)) return null;      // no terrain data here
    return { x: hit.x, y: h, z: hit.z };
  }

  // Highest known ground height at world x/z (drawn surface vs. sampler), so the camera never goes under it.
  groundAt(t, x, z) {
    let h = null;
    const { gx, gz } = t.worldToGrid(x, z);
    if (!Number.isNaN(t.heightAt(gx, gz))) h = t.gridToWorld(gx, gz).y;
    const w = t.sampleWorld?.(x, z);
    if (w != null && Number.isFinite(w)) h = h == null ? w : Math.max(h, w);
    return h;
  }

  makeMarker() {
    const mat = new THREE.MeshBasicMaterial({ color: MARK_COLOR, transparent: true, depthTest: false, depthWrite: false });
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 5.6, 8), mat);
    pole.position.y = 2.8;
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.9), mat);
    gem.position.y = 6.5;
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.4, 1.8, 32), new THREE.MeshBasicMaterial({
      color: MARK_COLOR, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.1;
    g.add(pole, gem, ring);
    g.traverse((o) => { o.layers.set(MARK_LAYER); o.renderOrder = 1200; o.frustumCulled = false; });
    return g;
  }

  removeMarker() {
    if (!this.marker) return;
    this.ctx.scene.remove(this.marker);
    this.marker.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    this.marker = null;
  }

  toast(text) {
    this.toastEl.textContent = text;
    this.toastEl.style.display = 'block';
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toastEl.style.display = 'none'; }, 2200);
  }

  // ===================== every frame =====================

  update() {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    if (!this.active || !this.target) return;
    const t = this.ctx.state.get('terrain');
    if (!t) return;

    // marked point in the CURRENT world coordinates (survives recentering)
    let lon = this.target.lon;
    if (Number.isFinite(t.lonC)) lon += 360 * Math.round((t.lonC - lon) / 360);
    const p = t.lonLatToWorld(lon, this.target.lat);
    const py = this.groundAt(t, p.x, p.z) ?? this.lastPy;
    this.lastPy = py;

    this.time += dt;
    const T = this.time;
    const fly = 1 - ease(clamp01(T / FLY_IN));       // 1 at the start, 0 when settled

    // orbit speed: drifts slowly, and eases up during the fly-in
    const speedK = SPEED_MIN + SPEED_VAR * Math.sin(T * 0.11) ** 2;
    const spd = ORBIT_SPEED * speedK * (0.3 + 0.7 * (1 - fly));
    this.theta += spd * dt;

    // slow crane-up: a low sweep, then a rising reveal of the landscape
    const crane = 1 + CRANE_GAIN * Math.max(0, Math.sin(T * CRANE_RATE)) ** 4 * (1 - fly);

    const r = ORBIT_RADIUS * (1 + BREATHE_R * Math.sin(T * 0.23)) * (1 + fly * 2);
    const h = ORBIT_HEIGHT * (1 + BREATHE_H * Math.sin(T * 0.17 + 1)) * (1 + fly * 2.5) * crane;
    const cx = p.x + Math.cos(this.theta) * r;
    const cz = p.z + Math.sin(this.theta) * r;

    // height: follow the wanted height smoothly, but never end up inside the ground
    const gnd = this.groundAt(t, cx, cz) ?? py;
    const want = Math.max(py + h, gnd + GROUND_CLEAR);
    this.camY = this.camY == null ? want : this.camY + (want - this.camY) * (1 - Math.exp(-HEIGHT_SMOOTH * dt));
    this.camY = Math.max(this.camY, gnd + GROUND_CLEAR);

    // handheld drift (two slow sines multiplied = non-repeating wander)
    const n = (a, b) => Math.sin(T * a) * Math.sin(T * b);
    this.cam.position.set(
      cx + n(0.9, 1.7) * SHAKE_POS,
      this.camY + n(1.3, 0.7) * SHAKE_POS * 0.7,
      cz + n(1.1, 0.6) * SHAKE_POS
    );

    // aim: trails the target a little, like an operator following a subject
    const tgt = new THREE.Vector3(p.x, py + LOOK_HEIGHT, p.z);
    if (!this.lookInit) { this.look.copy(tgt); this.lookInit = true; }
    this.look.lerp(tgt, 1 - Math.exp(-LOOK_LAG * dt));
    this.cam.up.set(0, 1, 0);
    this.cam.lookAt(this.look);

    // bank into the turn (smoothed), then tiny handheld rotation
    this.roll += (-spd * BANK - this.roll) * (1 - Math.exp(-BANK_SMOOTH * dt));
    this.cam.rotateZ(this.roll);
    this.cam.rotateX(n(0.8, 2.1) * SHAKE_ROT);
    this.cam.rotateY(n(1.1, 1.9) * SHAKE_ROT);

    // lens: long lens at the start that opens up as the camera glides in, then a slow breath
    this.cam.fov = FOV - FOV_FLY * fly + FOV_BREATHE * Math.sin(T * 0.13);

    // marker: stays at the point, constant size on screen in the main view
    if (this.marker) {
      this.marker.position.set(p.x, py, p.z);
      const mc = this.ctx.camera;
      const hpx = Math.max(1, this.ctx.renderer.domElement.clientHeight);
      const perPx = 2 * Math.tan(THREE.MathUtils.degToRad(mc.fov ?? 50) / 2) / hpx;
      const d = mc.position.distanceTo(this.marker.position);
      this.marker.scale.setScalar(Math.max(1e-3, d * perPx * MARK_PX / MARK_UNIT_H));
    }
  }

  // Render Hawk into the bottom-left corner of the main canvas (VIEW_W x VIEW_H real pixels),
  // copy it into the panel's canvas, and let the main render paint over the corner afterwards.
  drawHawk(render, scene) {
    const r = this.ctx.renderer;
    const pr = r.getPixelRatio();
    const size = r.getSize(new THREE.Vector2());
    if (size.x * pr < VIEW_W || size.y * pr < VIEW_H) return;      // window too small for Hawk's picture
    const w = VIEW_W / pr, h = VIEW_H / pr;                        // CSS pixels that equal VIEW_W x VIEW_H real pixels

    const vp = r.getViewport(new THREE.Vector4());
    const sc = r.getScissor(new THREE.Vector4());
    const st = r.getScissorTest();
    const ac = r.autoClear;

    r.setScissorTest(true);
    r.setViewport(0, 0, w, h);
    r.setScissor(0, 0, w, h);
    r.autoClear = true;
    this.cam.aspect = VIEW_W / VIEW_H;
    this.cam.userData.viewHeight = VIEW_H;
    this.cam.updateProjectionMatrix();
    render(scene, this.cam);

    // copy right after the render (the corner is bottom-left; canvas y runs top-down)
    const sy = Math.round(size.y * pr) - VIEW_H;
    try { this.viewG.drawImage(r.domElement, 0, sy, VIEW_W, VIEW_H, 0, 0, VIEW_W, VIEW_H); } catch (err) { /* ignore */ }

    r.setViewport(vp);
    r.setScissor(sc);
    r.setScissorTest(st);
    r.autoClear = ac;
    this.lastDraw = performance.now();

    // title card: fade in, hold, fade out
    const T = this.time;
    const a = Math.min(clamp01((T - 0.4) / (TITLE_IN - 0.4)), 1 - clamp01((T - TITLE_HOLD) / (TITLE_OUT - TITLE_HOLD)));
    this.title.style.opacity = String(a);
  }

  dispose() {
    this.alive = false;
    this.stop();
    super.dispose();
    const r = this.ctx.renderer;
    if (r && r.render === this.wrapper) r.render = this.prevRender;
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('keydown', this.onKey);
    this.ctx.camera?.layers.disable(MARK_LAYER);
    clearTimeout(this.toastTimer);
    this.ctx.ui?.removePanel('hawk');
    this.toastEl?.remove();
  }
}