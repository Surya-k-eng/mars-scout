import * as THREE from 'three';
import { MapPickModule } from './MapPickModule.js';   // adjust the path if the two files are in different folders

// Mineral pick = MapPickModule + the mineral finder.
//
// It EXTENDS MapPickModule, so everything MapPick does still works exactly the same (flat top-down map,
// zoom, click or typed coordinates, landmarks, A/B pins, slope-aware route for Astro). On top of that:
//   - hotspots from MineralSearchModule are drawn on the map:
//       zoomed out  -> small dots
//       zoomed in   -> the dots fade away and each patch gets a thin OUTLINE (needs `outline` in hotspots.json)
//   - clicking a result in the search panel zooms the map onto that hotspot (selected one = thick yellow outline + label)
//   - "Use as next point" adds the selected hotspot as pick A, then as pick B (B starts the normal route planning)
//
// Register THIS module INSTEAD of MapPickModule (both active at once would fight over the camera):
//   registry: remove MapPickModule, add MineralPickModule (and MineralSearchModule)
// MineralPickModule.js is a new file; MapPickModule.js is not edited, only imported.

const FOCUS_HEIGHT = 15000;         // camera height (metres) when zooming onto a hotspot
const MIN_HEIGHT = 400;
const MAX_DOTS = 60;
const FADE_NEAR = 6000;             // camera height at/below which dots are fully gone (outline only)
const FADE_FAR = 30000;             // camera height at/above which dots are at full strength (no outline)
const COLORS = { olivine: '#7CFC00', pyroxene: '#FFA726', hydrous: '#4FC3F7', multi: '#FFFFFF' };

const CSS = `
.mpk-panel{position:fixed;left:12px;bottom:12px;z-index:1003;width:300px;
  font:12px/1.4 system-ui,sans-serif;color:#eee;background:rgba(20,22,26,.9);
  border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:10px 12px}
.mpk-panel h4{margin:0 0 6px;font-size:13px}
.mpk-panel button{font:inherit;margin:4px 4px 0 0;padding:3px 8px;cursor:pointer}
.mpk-dim{opacity:.7}
.ms-panel{z-index:1003 !important}   /* keep the Mineral search panel above the map overlay */
`;

export class MineralPickModule extends MapPickModule {
  static id = 'mineralPick';
  static requires = ['world'];

  async init() {
    this.sel = null;                // selected hotspot { lon, lat, label, parts, area_km2, outline }
    this.hotspots = [];             // latest search results
    await super.init();

    this.onSelect = (e) => this.select(e.detail);
    this.onPickEvt = (e) => { const d = e.detail; if (d && Number.isFinite(d.lon)) this.addHotspotPick({ lon: d.lon, lat: d.lat }); };
    window.addEventListener('mineral:select', this.onSelect);
    window.addEventListener('mineral:pick', this.onPickEvt);
    if (this.ctx.bus?.on) this._offResults = this.ctx.bus.on('mineral:results', (r) => { this.hotspots = r?.hotspots || (Array.isArray(r) ? r : []); });
    this.buildMineralPanel();
    const apply = (m) => { if (this.mpanel) this.mpanel.style.display = m === 'targets' ? '' : 'none'; };
    apply(this.ctx.state.get?.('searchMode'));
    this._offMode2 = this.ctx.bus?.on?.('search:mode', apply);   // own name: MapPickModule keeps its own _offMode
  }

  // MapPickModule.setMode() turns every mode except 'landmarks' into 'coordinates' and writes that to
  // ctx.state, which would wipe 'targets' and hide the Mineral search panel. Keep 'targets' intact.
  setMode(mode) {
    if (mode === 'targets') {
      this.mode = 'targets';
      this.ctx.state.set('searchMode', 'targets');
      this.removeLandmarkBox?.();
      return;
    }
    super.setMode(mode);
  }

  // ---- hotspot -> world --------------------------------------------------------

  worldOf(p) {
    const t = this.terrain;
    if (!t?.lonLatToWorld) return null;
    const lon = p.lon + 360 * Math.round((t.lonMid - p.lon) / 360);       // same longitude convention as the map
    const { x, z } = t.lonLatToWorld(lon, p.lat);
    const r = t.regionRect;
    if (r && (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1)) return null;  // outside the loaded map
    return { x, z, y: t.sampleWorld(x, z) ?? 0 };
  }

  // ---- select (zoom) -----------------------------------------------------------

  select(h) {
    if (!h || !Number.isFinite(h.lon) || !Number.isFinite(h.lat)) return;
    const names = h.parts ? Object.keys(h.parts).join(' + ') : 'hotspot';
    this.sel = {
      lon: h.lon, lat: h.lat, parts: h.parts,
      area_km2: h.area_km2, outline: h.outline,
      label: `${names}${h.region ? ', ' + h.region : ''}`,
    };
    const w = this.worldOf(this.sel);
    if (!w) { this.say('Hotspot is outside the loaded map area.'); this.refresh(); return; }
    if (this.active && !this.busy) {
      const cam = this.ctx.camera;
      cam.position.x = w.x; cam.position.z = w.z;
      cam.position.y = THREE.MathUtils.clamp(FOCUS_HEIGHT, MIN_HEIGHT, this.hMax || FOCUS_HEIGHT);
    }
    this.say('Zoomed to hotspot.');
    this.refresh();
  }

  // ---- pick (A, then B) --------------------------------------------------------

  addHotspotPick(p) {
    if (!this.active || this.busy) { this.say('Map pick is not active (route already planned or still planning).'); return; }
    if (this.picks.length >= 2) return;
    const w = this.worldOf(p);
    if (!w) { this.say('Hotspot is outside the loaded map area.'); return; }
    const cam = this.ctx.camera;
    cam.position.x = w.x; cam.position.z = w.z;
    this.addPick({ x: w.x, y: w.y, z: w.z });                // exactly what a map click does
    this.say(this.picks.length === 1 ? 'Point A set. Select another hotspot (or click the map) for B.' : 'Point B set. Planning route...');
    this.refresh();
  }

  clearPicks() {
    if (!this.active || this.busy) return;
    this.picks = [];
    this.markers?.clear();
    if (this.line) this.line.visible = false;
    this.updateHud?.();
    this.say('Picks cleared.');
    this.refresh();
  }

  // ---- drawing hotspots on the map ---------------------------------------------

  drawFeatures() {
    super.drawFeatures();
    const cv = this.featCv, t = this.terrain, cam = this.ctx.camera;
    if (!cv || !t || !this.active) return;
    const w = parseFloat(cv.style.width), h = parseFloat(cv.style.height);
    if (!w || !h) return;
    const g = cv.getContext('2d');
    const dpr = cv.width / w;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const v = this._mv || (this._mv = new THREE.Vector3());

    // cull = false lets outline vertices go off-screen so a big patch is still drawn whole
    const project = (p, cull = true) => {
      const wd = this.worldOf(p);
      if (!wd) return null;
      v.set(wd.x, wd.y, wd.z).project(cam);
      const sx = (v.x + 1) / 2 * w, sy = (1 - v.y) / 2 * h;
      if (cull && (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20)) return null;
      return [sx, sy];
    };
    const colorOf = (hs) => {
      const k = Object.keys(hs.parts || {});
      return k.length === 1 ? COLORS[k[0]] || '#fff' : COLORS.multi;
    };
    const hasOutline = (hs) => Array.isArray(hs.outline) && hs.outline.length >= 3;

    // builds the closed outline path on the canvas (lon/lat vertices -> screen); false if nothing drawable
    const traceOutline = (hs) => {
      if (!hasOutline(hs)) return false;
      g.beginPath();
      let started = false;
      for (const [lo, la] of hs.outline) {
        const s = project({ lon: lo, lat: la }, false);
        if (!s) continue;
        if (started) g.lineTo(s[0], s[1]); else g.moveTo(s[0], s[1]);
        started = true;
      }
      if (!started) return false;
      g.closePath();
      return true;
    };

    // 1 = zoomed out (dots only), 0 = zoomed in (outlines only)
    const fade = THREE.MathUtils.clamp((cam.position.y - FADE_NEAR) / (FADE_FAR - FADE_NEAR), 0, 1);

    g.lineJoin = 'round';
    let n = 0;
    for (const hs of this.hotspots) {
      if (n++ >= MAX_DOTS) break;
      const outlined = hasOutline(hs);
      const dotAlpha = outlined ? 0.9 * fade : 0.9;          // no outline data -> keep the dot at any zoom

      if (dotAlpha > 0.02) {
        const s = project(hs);
        if (s) {
          g.globalAlpha = dotAlpha;
          g.beginPath(); g.arc(s[0], s[1], 4, 0, Math.PI * 2);
          g.fillStyle = colorOf(hs); g.fill();
          g.lineWidth = 1; g.strokeStyle = '#000'; g.stroke();
        }
      }
      if (outlined && fade < 0.98 && traceOutline(hs)) {
        g.globalAlpha = 1 - fade;
        g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.7)'; g.stroke();   // dark halo so it reads on any terrain
        g.lineWidth = 1.5; g.strokeStyle = colorOf(hs); g.stroke();
      }
    }
    g.globalAlpha = 1;

    if (this.sel) {
      const s = project(this.sel);
      if (traceOutline(this.sel)) {
        g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,.8)'; g.stroke();
        g.lineWidth = 2.5; g.strokeStyle = '#ffd54a'; g.stroke();
      } else if (s) {                                         // fallback when the hotspot has no outline
        g.lineWidth = 2.5; g.strokeStyle = '#ffd54a';
        g.beginPath(); g.arc(s[0], s[1], 11, 0, Math.PI * 2); g.stroke();
      }
      if (s) {
        g.font = '12px system-ui, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left';
        const txt = this.sel.label;
        g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.8)'; g.strokeText(txt, s[0] + 16, s[1]);
        g.fillStyle = '#ffd54a'; g.fillText(txt, s[0] + 16, s[1]);
      }
    }
  }

  // ---- panel -------------------------------------------------------------------

  buildMineralPanel() {
    const el = (tag, parent, text, cls) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      parent?.appendChild(n);
      return n;
    };
    this.mstyle = el('style', document.head, CSS);
    const root = this.mpanel = el('div', document.body, undefined, 'mpk-panel');
    el('h4', root, 'Mineral pick');
    this.minfo = el('div', root);
    const btn = (text, fn) => { const b = el('button', root, text); b.addEventListener('click', () => { fn(); b.blur(); }); return b; };
    btn('Zoom to it', () => this.sel && this.select(this.sel));
    btn('Use as next point (A, then B)', () => {
      if (!this.sel) { this.say('Click a result in the Mineral search panel first.'); return; }
      this.addHotspotPick(this.sel);
    });
    btn('Clear picks', () => this.clearPicks());
    this.mmsg = el('div', root, '', 'mpk-dim');
    for (const ev of ['keydown', 'pointerdown', 'wheel', 'mousedown']) root.addEventListener(ev, (e) => e.stopPropagation());
    this.refresh();
  }

  say(text) { if (this.mmsg) this.mmsg.textContent = text; }

  refresh() {
    if (!this.minfo) return;
    const f = (p) => `${p.lat.toFixed(2)}°N, ${p.lon.toFixed(2)}°E`;
    this.minfo.textContent = '';
    const line = (s) => { const d = document.createElement('div'); d.textContent = s; this.minfo.appendChild(d); };
    line(`Selected: ${this.sel ? f(this.sel) + '  (' + this.sel.label + ')' : '-'}`);
    line(`Next pick: ${this.picks.length === 0 ? 'A' : this.picks.length === 1 ? 'B' : 'done'}`);
  }

  dispose() {
    this._offMode2?.();         // MapPickModule's own _offMode is released by super.dispose()
    window.removeEventListener('mineral:select', this.onSelect);
    window.removeEventListener('mineral:pick', this.onPickEvt);
    try { this._offResults?.(); } catch { /* ignore */ }
    this.mpanel?.remove();
    this.mstyle?.remove();
    super.dispose();
  }
}