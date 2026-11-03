import { Module } from '../../core/Module.js';   // same relative path TitleScreen.js uses; adjust if needed

// Mineral search panel.
//   - loads /data/hotspots.json  (list of { mineral, lon, lat, peak, mean, area_km2, score, region, rank, outline })
//       outline (optional) = [[lon,lat], [lon,lat], ...]  simplified polygon of the patch; drawn on the map when zoomed in
//   - lets you tick minerals, set a minimum area, choose how many results, and search
//   - emits  bus 'mineral:results'  { hotspots: [...] }   -> MineralPickModule draws the dots / outlines
//   - clicking a result dispatches window 'mineral:select'  { lon, lat, parts, region, area_km2, outline }  -> map zooms there
//   - double-click a result dispatches window 'mineral:pick' -> sets it as point A / B
//   - panel is only visible when the title screen chose "Search by scientific targets" (searchMode === 'targets')
//
// Put this file next to MineralPickModule.js and register it in src/modules.config.js.

const DATA_URL = `${import.meta.env?.BASE_URL ?? '/'}data/hotspots.json`;
const MINERALS = [
  ['olivine',  '#7CFC00'],
  ['pyroxene', '#FFA726'],
  ['hydrous',  '#4FC3F7'],
];

const CSS = `
.ms-panel{position:fixed;right:12px;top:12px;z-index:1003;width:290px;
  font:12px/1.4 system-ui,sans-serif;color:#eee;background:rgba(20,22,26,.92);
  border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:10px 12px}
.ms-panel h4{margin:0 0 6px;font-size:13px}
.ms-panel label{display:flex;align-items:center;gap:6px;margin:2px 0;cursor:pointer}
.ms-panel .ms-sw{width:10px;height:10px;border-radius:50%;border:1px solid #000;display:inline-block}
.ms-panel input[type=number],.ms-panel select{font:inherit;width:70px;background:#111;color:#eee;border:1px solid #444;border-radius:4px;padding:2px 4px}
.ms-panel .ms-row{display:flex;align-items:center;gap:8px;margin:6px 0}
.ms-panel button{font:inherit;padding:3px 10px;cursor:pointer}
.ms-panel .ms-list{max-height:240px;overflow-y:auto;margin-top:6px;border-top:1px solid rgba(255,255,255,.12)}
.ms-panel .ms-item{display:flex;align-items:center;gap:6px;padding:4px 2px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.07)}
.ms-panel .ms-item:hover{background:rgba(255,255,255,.08)}
.ms-panel .ms-item.sel{background:rgba(255,213,74,.18)}
.ms-panel .ms-dim{opacity:.7}
`;

export class MineralSearchModule extends Module {
  static id = 'mineralSearch';
  static requires = [];

  async init() {
    this.all = [];
    this.results = [];
    this.selIndex = -1;
    this.buildPanel();

    // visibility follows the mode chosen on the title screen
    const apply = (m) => { if (this.panel) this.panel.style.display = m === 'targets' ? '' : 'none'; };
    apply(this.ctx.state?.get?.('searchMode'));
    const off = this.ctx.bus?.on?.('search:mode', apply);
    this._offMode = typeof off === 'function' ? off : null;

    await this.load();
  }

  async load() {
    this.setMsg('Loading hotspots...');
    try {
      const res = await fetch(DATA_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.hotspots || []);
      this.all = list.filter((h) => h && Number.isFinite(h.lon) && Number.isFinite(h.lat) && h.mineral);
      this.setMsg(`${this.all.length} hotspots loaded. Pick minerals and press Search.`);
    } catch (err) {
      console.error('[mineralSearch] could not load', DATA_URL, err);
      this.setMsg(`Could not load ${DATA_URL}. Is hotspots.json in public/data?`);
    }
  }

  // ---- search ------------------------------------------------------------------

  search() {
    const chosen = MINERALS.map(([m]) => m).filter((m) => this.checks[m].checked);
    const minArea = Number(this.areaInput.value) || 0;
    const limit = Number(this.limitSel.value) || 50;

    const hits = this.all
      .filter((h) => chosen.includes(h.mineral) && (h.area_km2 ?? 0) >= minArea)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit)
      .map((h) => ({
        lon: h.lon, lat: h.lat, region: h.region || '',
        parts: { [h.mineral]: h.score },          // MineralPickModule colours the dot by the keys of `parts`
        mineral: h.mineral, score: h.score, area_km2: h.area_km2, rank: h.rank,
        outline: h.outline,                       // [[lon,lat],...] patch outline (optional)
      }));

    this.results = hits;
    this.selIndex = -1;
    this.renderList();
    this.ctx.bus?.emit?.('mineral:results', { hotspots: hits });
    this.setMsg(hits.length ? `${hits.length} hotspots. Click one to zoom, double-click to use as a point.` : 'No hotspots match.');
  }

  choose(i, pick) {
    const h = this.results[i];
    if (!h) return;
    this.selIndex = i;
    this.renderList();
    const detail = { lon: h.lon, lat: h.lat, parts: h.parts, region: h.region, area_km2: h.area_km2, outline: h.outline };
    window.dispatchEvent(new CustomEvent('mineral:select', { detail }));
    if (pick) window.dispatchEvent(new CustomEvent('mineral:pick', { detail }));
  }

  // ---- panel -------------------------------------------------------------------

  buildPanel() {
    const el = (tag, parent, text, cls) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      parent?.appendChild(n);
      return n;
    };
    this.style = el('style', document.head, CSS);
    const root = this.panel = el('div', document.body, undefined, 'ms-panel');
    root.style.display = 'none';
    el('h4', root, 'Mineral search');

    this.checks = {};
    for (const [name, color] of MINERALS) {
      const lab = el('label', root);
      const cb = el('input', lab); cb.type = 'checkbox'; cb.checked = true;
      const sw = el('span', lab, undefined, 'ms-sw'); sw.style.background = color;
      el('span', lab, name);
      this.checks[name] = cb;
    }

    const r1 = el('div', root, undefined, 'ms-row');
    el('span', r1, 'Min area km²');
    this.areaInput = el('input', r1); this.areaInput.type = 'number'; this.areaInput.min = '0'; this.areaInput.value = '0';

    const r2 = el('div', root, undefined, 'ms-row');
    el('span', r2, 'Show top');
    this.limitSel = el('select', r2);
    for (const n of [10, 25, 50]) { const o = el('option', this.limitSel, String(n)); o.value = String(n); }
    this.limitSel.value = '50';

    const b = el('button', root, 'Search');
    b.addEventListener('click', () => { this.search(); b.blur(); });

    this.msg = el('div', root, '', 'ms-dim');
    this.list = el('div', root, undefined, 'ms-list');

    for (const ev of ['keydown', 'pointerdown', 'wheel', 'mousedown']) root.addEventListener(ev, (e) => e.stopPropagation());
  }

  renderList() {
    this.list.textContent = '';
    this.results.forEach((h, i) => {
      const row = document.createElement('div');
      row.className = 'ms-item' + (i === this.selIndex ? ' sel' : '');
      const color = (MINERALS.find(([m]) => m === h.mineral) || [])[1] || '#fff';
      const sw = document.createElement('span'); sw.className = 'ms-sw'; sw.style.background = color;
      const t = document.createElement('span');
      t.textContent = `#${h.rank ?? i + 1} ${h.mineral}  ${h.lat.toFixed(1)}°, ${h.lon.toFixed(1)}°  score ${h.score}`;
      row.append(sw, t);
      row.addEventListener('click', () => this.choose(i, false));
      row.addEventListener('dblclick', () => this.choose(i, true));
      this.list.appendChild(row);
    });
  }

  setMsg(text) { if (this.msg) this.msg.textContent = text; }

  dispose() {
    try { this._offMode?.(); } catch { /* ignore */ }
    this.panel?.remove();
    this.style?.remove();
    super.dispose();
  }
}