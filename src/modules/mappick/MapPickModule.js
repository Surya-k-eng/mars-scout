import * as THREE from 'three';
import { Module } from '../../core/Module.js';

// Top-down map view at launch. Drag = pan, wheel = zoom, click two points.
// Then: the world origin moves to the midpoint of the two points, the 3D camera is restored
// (shifted to match), and a pin at each point plus a line between them stay in the scene.
// Esc = skip without picking.

const MIN_HEIGHT = 300;        // closest zoom (camera height above ground, metres)
const MAX_HEIGHT_FACTOR = 0.50; // farthest zoom, as a multiple of the "whole region fits" height (1 = start view)
const LINE_STEPS = 64;
const LINE_LIFT = 30;          // line floats this far above the ground (display units)

export class MapPickModule extends Module {
  static id = 'mappick';
  static requires = ['world'];

  async init() {
    this.active = false;
    this.picks = [];
    this.markers = new THREE.Group();
    this.ctx.scene.add(this.markers);
    this.terrain = this.ctx.state.get('terrain');
    if (this.terrain) this.enter();
    else console.warn('[mappick] terrain not found in state; map view not started');
  }

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
    this.onDown = (e) => { if (e.button === 0) this.drag = { x: e.clientX, y: e.clientY, moved: 0 }; };
    this.onMove = (e) => {
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
      const y = cam.position.y * (e.deltaY > 0 ? 1.15 : 1 / 1.15);
      cam.position.y = THREE.MathUtils.clamp(y, MIN_HEIGHT, this.hMax);
    };
    this.onKey = (e) => { if (e.key === 'Escape') this.exit(true); };

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

  // Line draped over the terrain between two world x/z points.
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

  // Pin: a thin pole with a cone on top and a ring on the ground (size scales with current zoom).
  makePin(x, y, z) {
    const s = this.ctx.camera.position.y * 0.01;
    const mat = new THREE.MeshBasicMaterial({ color: 0xff3030 });
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.12, s * 0.12, s * 6, 8), mat);
    pole.position.y = s * 3;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(s * 0.7, s * 1.6, 12), mat);
    tip.position.y = s * 6.8;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(s * 0.9, s * 1.2, 24),
      new THREE.MeshBasicMaterial({ color: 0xff3030, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = s * 0.1;
    g.add(pole, tip, ring);
    g.position.set(x, y + LINE_LIFT, z);
    return g;
  }

  pick(e) {
    const g = this.groundPoint(e);
    if (!g) return;
    const { lon, lat } = this.terrain.worldToLonLat(g.x, g.z);
    this.picks.push({ lon, lat, x: g.x, z: g.z });
    this.markers.add(this.makePin(g.x, g.y, g.z));
    this.updateHud();
    if (this.picks.length === 2) {
      this.setLine(this.picks[0].x, this.picks[0].z, g.x, g.z);
      this.finish();
    }
  }

  finish() {
    const [a, b] = this.picks;
    const midLon = (a.lon + b.lon) / 2, midLat = (a.lat + b.lat) / 2;

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
    this.ctx.state.set('mode', 'world');
  }

  clearMarkers() {
    for (const c of [...this.markers.children]) {
      this.markers.remove(c);
      c.traverse?.((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    }
    this.markers.position.set(0, 0, 0);
  }

  // ---- hint bar ----------------------------------------------------------

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
    if (this.hud) this.hud.textContent =
      `Map view: click point ${Math.min(this.picks.length + 1, 2)} of 2  (drag = pan, wheel = zoom, Esc = skip)`;
  }

  removeHud() { this.hud?.remove(); this.hud = null; }

  dispose() {
    super.dispose();
    this.exit(true);
    this.removeHud();
    this.clearMarkers();
    this.ctx.scene.remove(this.markers);
  }
}