// Toggleable on-screen readout of where the camera is on Mars.
export class CameraDebug {
  constructor(camera, controls, getTerrain) {
    this.camera = camera;
    this.controls = controls;
    this.getTerrain = getTerrain;

    this.btn = document.createElement('button');
    this.btn.textContent = 'Coords';
    Object.assign(this.btn.style, {
      position: 'fixed', top: '10px', right: '10px', zIndex: 1000,
      padding: '6px 12px', font: '12px monospace', cursor: 'pointer',
      background: '#222', color: '#fff', border: '1px solid #666', borderRadius: '4px',
    });

    this.panel = document.createElement('pre');
    Object.assign(this.panel.style, {
      position: 'fixed', top: '44px', right: '10px', zIndex: 1000, margin: 0,
      padding: '10px', font: '12px monospace', color: '#9f9', background: 'rgba(0,0,0,0.75)',
      border: '1px solid #444', borderRadius: '4px', display: 'none', pointerEvents: 'none',
    });

    document.body.append(this.btn, this.panel);
    this.btn.addEventListener('click', () => this.toggle());
  }

  toggle() {
    const on = this.panel.style.display === 'none';
    this.panel.style.display = on ? 'block' : 'none';
    clearInterval(this.timer);
    if (on) { this.update(); this.timer = setInterval(() => this.update(), 100); }
  }

  update() {
    const t = this.getTerrain?.();
    const p = this.camera.position;
    if (!t || !t.worldToLonLat) { this.panel.textContent = 'terrain not ready'; return; }

    const { lon, lat } = t.worldToLonLat(p.x, p.z);
    const drawn = t.sampleWorld(p.x, p.z);              // display height of ground, or null
    const real = t.sample(lon, lat);                    // { h, layer } or null
    const r = t.hiriseRect;
    const inHi = p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1;
    const agl = drawn != null ? (p.y - drawn) / t.vertExag : null;   // real metres above ground

    const f = (v, d = 1) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(d));
    let s =
`Camera
 lat   ${lat.toFixed(5)} deg
 lon   ${lon.toFixed(5)} deg
 world x ${f(p.x)}  z ${f(p.z)}  y ${f(p.y)}
 ground  ${f(real?.h)} m (${real?.layer ?? 'no data'})
 above ground ${f(agl)} m
 in HiRISE area: ${inHi ? 'yes' : 'no'}`;

    if (this.controls?.target) {
      const q = this.controls.target;
      const L = t.worldToLonLat(q.x, q.z);
      s += `\nLooking at\n lat ${L.lat.toFixed(5)}  lon ${L.lon.toFixed(5)}`;
    }
    this.panel.textContent = s;
  }

  dispose() {
    clearInterval(this.timer);
    this.btn.remove();
    this.panel.remove();
  }
}