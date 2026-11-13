import { Module } from '../../core/Module.js';   // same relative path TitleScreen.js uses; adjust if needed

// Mineral search panel.
//   - loads /data/hotspots.json  (list of { mineral, lon, lat, peak, mean, area_km2, score, region, rank, outline })
//       outline (optional) = [[lon,lat], [lon,lat], ...]  simplified polygon of the patch; drawn on the map when zoomed in
//   - lets you tick minerals, set a minimum area, choose how many results, and search
//   - emits  bus 'mineral:results'  { hotspots: [...] }   -> MineralPickModule draws the dots / outlines
//   - clicking a result dispatches window 'mineral:select'  { lon, lat, parts, region, area_km2, outline }  -> map zooms there
//   - double-click a result dispatches window 'mineral:pick' -> sets it as point A / B
//   - (panel is built through ctx.ui; UIModule must be registered first) only visible when the title screen chose "Search by scientific targets" (searchMode === 'targets')
//
// Put this file next to MineralPickModule.js and register it in src/modules.config.js.

const DATA_URL = `${import.meta.env?.BASE_URL ?? '/'}data/hotspots.json`;
const MINERALS = [
  ['olivine',  '#7CFC00'],
  ['pyroxene', '#FFA726'],
  ['hydrous',  '#4FC3F7'],
];

export class MineralSearchModule extends Module {
  static id = 'mineralSearch';
  static requires = ['ui'];

  async init() {
    this.all = [];
    this.results = [];
    this.selIndex = -1;
    this.buildPanel();
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

  // ---- UI WIRING: the only place this module creates DOM ----------------------------------------------------
  // Layout, styling, show/hide and event isolation come from UIModule (ctx.ui). Change search behaviour anywhere
  // else freely; just keep writing to this.checks, this.areaInput, this.limitSel (read), this.msg and this.list (write).
  buildPanel() {
    const ui = this.ctx.ui, el = ui.el;
    ui.addPanel({
      id: 'mineralSearch', title: 'Mineral search', dock: 'right',
      visibleWhen: { searchMode: 'targets' },      // UIModule shows/hides it from the title-screen mode
      build: (root) => {
        this.checks = {};
        for (const [name, color] of MINERALS) {
          const lab = el('label', root);
          const cb = el('input', lab); cb.type = 'checkbox'; cb.checked = true;
          const sw = el('span', lab, undefined, 'ui-sw'); sw.style.background = color;
          el('span', lab, name);
          this.checks[name] = cb;
        }

        const r1 = el('div', root, undefined, 'ui-row');
        el('span', r1, 'Min area km²');
        this.areaInput = el('input', r1); this.areaInput.type = 'number'; this.areaInput.min = '0'; this.areaInput.value = '0';

        const r2 = el('div', root, undefined, 'ui-row');
        el('span', r2, 'Show top');
        this.limitSel = el('select', r2);
        for (const n of [10, 25, 50]) { const o = el('option', this.limitSel, String(n)); o.value = String(n); }
        this.limitSel.value = '50';

        const b = el('button', root, 'Search');
        b.addEventListener('click', () => { this.search(); b.blur(); });

        this.msg = el('div', root, '', 'ui-dim');
        this.list = el('div', root, undefined, 'ui-list');
      },
    });
  }

  renderList() {
    this.list.textContent = '';
    this.results.forEach((h, i) => {
      const row = document.createElement('div');
      row.className = 'ui-item' + (i === this.selIndex ? ' sel' : '');
      const color = (MINERALS.find(([m]) => m === h.mineral) || [])[1] || '#fff';
      const sw = document.createElement('span'); sw.className = 'ui-sw'; sw.style.background = color;
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
    this.ctx.ui?.removePanel('mineralSearch');
    super.dispose();
  }
}