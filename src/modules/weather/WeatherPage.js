import { Module } from '../../core/Module.js';

/* =====================================================================
   WeatherPage.js
   A full-screen "Mars weather" page. Open it with:
       ctx.bus.emit('weather:open')                    // default place
       ctx.bus.emit('weather:open', { lat, lon })      // a chosen place
       ctx.bus.emit('weather:open', { route: true })   // the route planned in MapPickModule
   It listens to 'route:planned' (sent by MapPickModule) and shows the weather at the
   start, 25 %, middle, 75 % and end of that route.
   Numbers come from the Mars Climate Database (same '/mcd' Vite proxy that
   WeatherModule already uses). Climate model values, not live weather.
   ===================================================================== */

const MCD_ORIGIN = 'https://www-mars.lmd.jussieu.fr';
const MCD_PATH = '/mcd_python/cgi-bin/mcdcgi.py';
const PROXY = '/mcd';
const MIN_SPAN_DEG = 12;       // smallest map width/height requested
const GAP_MS = 1500;           // pause between MCD requests (be polite to the server)
const RANGE_SEP = ' ';

const VARIABLES = [
  { code: 't',    label: 'Temperature', icon: '🌡️' },
  { code: 'p',    label: 'Pressure',    icon: '⏱️' },
  { code: 'rho',  label: 'Density',     icon: '☁️' },
  { code: 'wind', label: 'Wind speed',  icon: '💨' },
];

const PLACES = [
  { name: 'Jezero crater',      lat: 18.44,  lon: 77.45 },
  { name: 'Gale crater',        lat: -5.4,   lon: 137.8 },
  { name: 'Olympus Mons',       lat: 18.65,  lon: -133.8 },
  { name: 'Valles Marineris',   lat: -13.9,  lon: -59.2 },
  { name: 'Hellas basin',       lat: -42.7,  lon: 70.0 },
  { name: 'Elysium Mons',       lat: 25.0,   lon: 147.2 },
];

const TIMES = [
  { label: 'Night', h: 0 }, { label: 'Dawn', h: 6 }, { label: 'Noon', h: 12 },
  { label: 'Afternoon', h: 14 }, { label: 'Dusk', h: 18 },
];

// Every field the MCD form sends (copied from the real requests WeatherModule makes).
const BASE = {
  var1: 't', var2: 'none', var3: 'none', var4: 'none',
  datekeyhtml: '1', ls: '', localtime: '',
  year: '2026', month: '11', day: '3', hours: '3', minutes: '40', seconds: '11',
  julian: '2461347.6529050926', martianyear: '39', sol: '33',
  latitude: '', longitude: '', altitude: '10.', zkey: '3', spacecraft: 'none',
  isfixedlt: 'off', dust: '1', hrkey: '1', averaging: 'off', animation: 'off', animframes: '12',
  dpi: '80', islog: 'off', colorm: 'jet', minval: '', maxval: '', proj: 'cyl',
  palt: '', plon: '', plat: '', trans: '', iswind: 'off', latpoint: '', lonpoint: '',
};

/* ---------- helpers ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normLon = (v) => ((((v + 180) % 360) + 360) % 360) - 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtLat = (v) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'N' : 'S'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'E' : 'W'}`;
const mod = (x, n) => ((x % n) + n) % n;

/* ---------- current Mars season (Ls) and local time (Mars24, Allison & McEwen 2000) ---------- */
const D2R = Math.PI / 180;
const PBS = [
  [0.0071, 2.2353, 49.409], [0.0057, 2.7543, 168.173], [0.0039, 1.1177, 191.837],
  [0.0037, 15.7866, 21.736], [0.0021, 2.1354, 15.704], [0.0020, 2.4694, 95.528], [0.0018, 32.8493, 49.095],
];
function marsNow(lonEast) {
  const jdTT = Date.now() / 86400000 + 2440587.5 + 69.184 / 86400;
  const dt = jdTT - 2451545.0;
  const M = mod(19.3871 + 0.52402073 * dt, 360);
  const fms = 270.3863 + 0.52403840 * dt;
  let pbs = 0;
  for (const [A, tau, phi] of PBS) pbs += A * Math.cos((0.985626 * dt / tau + phi) * D2R);
  const eqc = (10.691 + 3.0e-7 * dt) * Math.sin(M * D2R) + 0.623 * Math.sin(2 * M * D2R) +
    0.050 * Math.sin(3 * M * D2R) + 0.005 * Math.sin(4 * M * D2R) + 0.0005 * Math.sin(5 * M * D2R) + pbs;
  const ls = mod(fms + eqc, 360);
  const eot = 2.861 * Math.sin(2 * ls * D2R) - 0.071 * Math.sin(4 * ls * D2R) + 0.002 * Math.sin(6 * ls * D2R) - eqc;
  const msd = (jdTT - 2405522.0028779) / 1.0274912517;
  const ltst = mod(mod(mod(msd, 1) * 24 + lonEast / 15, 24) + eot / 15, 24);
  return { ls, ltst };
}
const seasonOf = (ls) => (ls < 90 ? 'Northern spring' : ls < 180 ? 'Northern summer' : ls < 270 ? 'Northern autumn' : 'Northern winter');

/* ---------- reading the MCD ASCII data file (same format WeatherModule reads) ---------- */
function parseGrid(text) {
  const nums = (s) => (s.match(/[-+]?\d+\.\d+e[-+]?\d+/gi) || []).map(Number);
  let unit = '', lats = null;
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#')) {
      const m = line.match(/Columns 2\+ are (.+?) \((.+?)\)/);
      if (m) unit = m[2];
      continue;
    }
    const k = line.indexOf('||');
    if (k < 0) continue;
    const label = line.slice(0, k).trim();
    const vals = nums(line.slice(k + 2));
    if (!vals.length) continue;
    if (/^-+$/.test(label)) lats = vals; else rows.push({ label: Number(label), vals });
  }
  return lats && rows.length ? { unit, lats, rows } : null;
}
function bracket(a, x) {
  const n = a.length;
  if (n === 1 || x <= a[0]) return [0, 0];
  if (x >= a[n - 1]) return [n - 2, 1];
  let i = 0;
  while (a[i + 1] < x) i++;
  return [i, (x - a[i]) / (a[i + 1] - a[i])];
}
function summarise(g, lat, lon, lonRange) {
  const nR = g.rows.length, nC = g.lats.length;
  const lons = g.rows.map((_, i) => (nR === 1 ? lonRange[0] : lonRange[0] + ((lonRange[1] - lonRange[0]) * i) / (nR - 1)));
  const [i, ti] = bracket(lons, lon), [j, tj] = bracket(g.lats, lat);
  const v = (a, b) => g.rows[Math.min(a, nR - 1)].vals[Math.min(b, nC - 1)];
  const centre = (1 - ti) * ((1 - tj) * v(i, j) + tj * v(i, j + 1)) + ti * ((1 - tj) * v(i + 1, j) + tj * v(i + 1, j + 1));
  let min = Infinity, max = -Infinity;
  for (const r of g.rows) for (const x of r.vals) { if (x < min) min = x; if (x > max) max = x; }
  return { centre, min, max, unit: g.unit };
}

const STYLE = `
#wx-page{position:fixed;inset:0;z-index:10050;overflow-y:auto;color:#f4e9e1;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  background:radial-gradient(1200px 700px at 80% -10%,rgba(224,135,90,.28),transparent 60%),
             linear-gradient(180deg,#1b0f0a 0%,#120b08 60%,#0c0706 100%);
  padding:22px clamp(20px,6vw,100px) 60px;box-sizing:border-box}
#wx-page.wx-hidden{display:none}
#wx-page *{box-sizing:border-box}
.wx-top{display:flex;align-items:center;gap:18px;margin-left:78px}
.wx-back{display:inline-flex;align-items:center;gap:10px;font:inherit;font-size:11px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;
  color:#f4e9e1;cursor:pointer;padding:9px 18px 9px 10px;border-radius:999px;border:1px solid rgba(240,164,122,.55);
  background:linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,.03));transition:background .25s,color .25s}
.wx-back i{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;color:#1a0e09;font-style:normal;font-size:16px;
  background:linear-gradient(135deg,#ffc9a3,#e0875a)}
.wx-back:hover{background:#f0a47a;color:#1a0e09}
.wx-eyebrow{letter-spacing:.35em;font-size:12px;text-transform:uppercase;color:#e0875a;margin:26px 0 8px}
.wx-title{font-size:clamp(34px,6vw,72px);font-weight:800;letter-spacing:.06em;line-height:1.05;margin:0}
.wx-sub{opacity:.8;margin:10px 0 24px;max-width:46em;font-size:14px;line-height:1.6}
.wx-layout{display:grid;grid-template-columns:minmax(280px,360px) 1fr;gap:20px;align-items:start}
@media (max-width:900px){.wx-layout{grid-template-columns:1fr}.wx-top{margin-left:0}}
.wx-card{border:1px solid rgba(255,255,255,.16);border-radius:18px;padding:18px;
  background:linear-gradient(180deg,rgba(255,255,255,.09),rgba(255,255,255,.02));backdrop-filter:blur(10px);
  box-shadow:0 10px 30px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.12)}
.wx-card h3{margin:0 0 10px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#e0875a}
.wx-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.wx-chip{font:inherit;font-size:12px;cursor:pointer;padding:5px 11px;color:#f4e9e1;background:transparent;
  border:1px solid rgba(255,255,255,.28);border-radius:999px;transition:background .2s,color .2s}
.wx-chip:hover{border-color:#f0a47a}
.wx-chip.on{background:#e0875a;border-color:#e0875a;color:#1a0e09;font-weight:700}
.wx-row{display:flex;gap:10px;align-items:center;margin-bottom:10px}
.wx-row label{font-size:12px;opacity:.75;min-width:78px}
.wx-in{flex:1;min-width:0;padding:7px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.28);
  background:rgba(255,255,255,.08);color:#fff;font:13px system-ui,sans-serif;outline:none}
.wx-in:focus{border-color:#f0a47a}
.wx-go{width:100%;margin-top:6px;font:inherit;font-size:12px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;cursor:pointer;
  padding:12px;border-radius:999px;border:0;color:#fff;background:linear-gradient(135deg,#e0875a,#b5482a 60%,#6b2a3f)}
.wx-go:disabled{opacity:.55;cursor:default}
.wx-small{font-size:11.5px;opacity:.6;line-height:1.5;margin-top:10px}
.wx-head{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:baseline;margin-bottom:14px}
.wx-place{font-size:22px;font-weight:700}
.wx-meta{font-size:12.5px;opacity:.75}
.wx-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.wx-stat{border-radius:16px;padding:14px 16px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1)}
.wx-stat b.k{display:block;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#f0a47a;margin-bottom:6px}
.wx-big{font-size:30px;font-weight:700;line-height:1.1}
.wx-big small{font-size:13px;font-weight:400;opacity:.7;margin-left:4px}
.wx-sec{font-size:12.5px;opacity:.75;margin-top:4px}
.wx-range{font-size:11.5px;opacity:.55;margin-top:6px}
.wx-wait{opacity:.5;font-size:13px}
.wx-msg{margin:12px 0;padding:10px 14px;border-radius:10px;font-size:13px}
.wx-err{color:#ffd0d0;background:rgba(160,40,40,.3);border:1px solid rgba(255,120,120,.4)}
.wx-info{background:rgba(224,135,90,.15);border:1px solid rgba(240,154,110,.4)}
.wx-img{width:100%;border-radius:10px;background:#fff;margin-top:10px;display:block}
.wx-links a{color:#f0a47a;font-size:12.5px}
.wx-tbl{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:6px}
.wx-tbl th{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#f0a47a;text-align:left;padding:6px 8px;font-weight:600}
.wx-tbl td{padding:7px 8px;border-top:1px solid rgba(255,255,255,.08)}
.wx-tbl tr.wx-r{cursor:pointer}
.wx-tbl tr.wx-r:hover td{background:rgba(255,255,255,.06)}
.wx-tbl tr.wx-r.on td{background:rgba(224,135,90,.22)}
.wx-spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.3);border-top-color:#f0a47a;border-radius:50%;
  animation:wx-r .8s linear infinite;vertical-align:-2px;margin-right:8px}
@keyframes wx-r{to{transform:rotate(360deg)}}
`;

export class WeatherPageModule extends Module {
  static id = 'weatherPage';
  static requires = [];

  async init() {
    this.job = 0;
    this.cache = new Map();
    this.sel = 't';
    this.place = PLACES[0];
    this.mode = 'point';       // 'point' = one place, 'route' = the planned route
    this.route = null;         // { samples: [{label, lat, lon}], lengthM }
    this.samples = [];
    this.idx = 0;
    this.results = {};
    this.state = 'idle';       // idle | loading | done | error
    this.err = '';
    this.day = null; this.dayBusy = false; this.dayErr = '';
    this.ls = 0; this.loct = 14;

    this.build();
    this.onOpen = (p) => this.open(p);
    this.onRoute = (r) => this.setRoute(r);
    this._offs = [this.ctx.bus.on('weather:open', this.onOpen), this.ctx.bus.on('route:planned', this.onRoute)];
    this.onKey = (e) => { if (e.key === 'Escape' && this.isOpen()) this.close(); };
    window.addEventListener('keydown', this.onKey);
  }

  isOpen() { return !this.root.classList.contains('wx-hidden'); }

  // Turn the planned route into 5 sample places (start, 25 %, middle, 75 %, end) with real lat/lon.
  setRoute(r) {
    const pts = r?.points;
    const t = this.ctx.state.get('terrain');
    if (!pts || pts.length < 2 || !t?.worldToLonLat) return;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    const total = cum[cum.length - 1] || 1;
    const marks = [[0, 'Start (A)'], [0.25, '25 %'], [0.5, 'Middle'], [0.75, '75 %'], [1, 'End (B)']];
    const samples = marks.map(([f, label]) => {
      let k = 0;
      while (k < cum.length - 1 && cum[k] < f * total) k++;
      const ll = t.worldToLonLat(pts[k].x, pts[k].z);
      return { label, lat: ll.lat, lon: normLon(ll.lon) };
    });
    this.route = { samples, lengthM: r.length ?? total };
    this.mode = 'route';
    this.hasRun = false;                 // a new route: next opening fetches fresh numbers
    this.results = {}; this.state = 'idle'; this.here = null;
    this.renderPlaceChips();
    if (this.isOpen()) this.run();
  }

  open(p) {
    if (p?.route && this.route) {
      this.mode = 'route';
    } else if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
      this.mode = 'point';
      this.place = { name: p.name || 'Chosen place', lat: p.lat, lon: p.lon };
    } else if (!this.hasRun && this.mode !== 'route') {
      const area = this.ctx.state.get?.('selectedArea');
      if (area?.center) this.place = { name: 'Picked map area', lat: area.center.lat, lon: normLon(area.center.lon) };
    }
    this.syncInputs(true);
    this.root.classList.remove('wx-hidden');
    this.root.scrollTop = 0;
    if (!this.hasRun) this.run();
  }

  close() { this.job++; this.root.classList.add('wx-hidden'); this.ctx.bus.emit('weather:close'); }

  /* ---------------- data ---------------- */

  async request(over) {
    const q = new URLSearchParams({ ...BASE, ...over });
    const res = await fetch(`${PROXY}${MCD_PATH}?${q}`);
    const html = await res.text();
    if (!res.ok) throw new Error(`MCD site answered HTTP ${res.status}`);
    const base = MCD_ORIGIN + MCD_PATH;
    const imgs = [...new Set(
      [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1])
        .filter((s) => /\.(png|jpe?g|gif)(\?|$)/i.test(s) && !/logo|icon|banner|button/i.test(s)),
    )];
    const data = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]).find((s) => /\.(txt|dat|csv)(\?|$)/i.test(s));
    if (!imgs.length && !data) {
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      throw new Error(`Nothing usable in the MCD response: ${text || '(empty)'}`);
    }
    return { imgs: imgs.map((s) => new URL(s, base).href), data: data ? new URL(data, base).href : null };
  }

  // One map request for the whole area; the parsed grid is kept so every sample place can be read from it.
  async fetchVar(code, ext, c) {
    const r = await this.request({
      var1: code,
      latitude: ext.lat.map((x) => x.toFixed(2)).join(RANGE_SEP),
      longitude: ext.lon.map((x) => x.toFixed(2)).join(RANGE_SEP),
      ls: this.ls, localtime: this.loct, isfixedlt: 'on',
      latpoint: c.lat.toFixed(3), lonpoint: c.lon.toFixed(3),
    });
    let grid = null;
    if (r.data) {
      try {
        const res = await fetch(r.data.replace(MCD_ORIGIN, PROXY));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        grid = parseGrid(await res.text());
      } catch (e) { console.warn('[weatherPage] data file failed for', code, e.message); }
    }
    const at = this.samples.map((p) => (grid ? summarise(grid, p.lat, p.lon, ext.lon) : null));
    return { ...r, at };
  }

  async run() {
    const ls = parseFloat(this.lsIn.value), loct = parseFloat(this.locIn.value);
    if (!(ls >= 0 && ls <= 360) || !(loct >= 0 && loct <= 24)) { this.state = 'error'; this.err = 'Ls must be 0-360 and local time 0-24.'; return this.render(); }

    let samples;
    if (this.mode === 'route' && this.route) {
      samples = this.route.samples;
    } else {
      this.mode = 'point';
      const lat = clamp(parseFloat(this.latIn.value), -90, 90), lon = normLon(parseFloat(this.lonIn.value));
      if (![lat, lon].every(Number.isFinite)) { this.state = 'error'; this.err = 'Enter a latitude and a longitude.'; return this.render(); }
      samples = [{ label: this.place.name, lat, lon }];
    }
    this.hasRun = true;
    this.ls = ls; this.loct = loct;
    this.samples = samples;
    this.idx = samples.length > 1 ? Math.floor(samples.length / 2) : 0;

    // area to ask for: covers every sample, never smaller than MIN_SPAN_DEG
    const lats = samples.map((p) => p.lat), lons = samples.map((p) => p.lon);
    const c = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lon: (Math.min(...lons) + Math.max(...lons)) / 2 };
    const latSpan = Math.max((Math.max(...lats) - Math.min(...lats)) * 1.5, MIN_SPAN_DEG);
    const lonSpan = Math.max((Math.max(...lons) - Math.min(...lons)) * 1.5, MIN_SPAN_DEG);
    const ext = {
      lat: [clamp(c.lat - latSpan / 2, -90, 90), clamp(c.lat + latSpan / 2, -90, 90)],
      lon: [clamp(c.lon - lonSpan / 2, -180, 180), clamp(c.lon + lonSpan / 2, -180, 180)],
    };
    const key = [samples.map((p) => p.lat.toFixed(2) + ',' + p.lon.toFixed(2)).join(';'), ls, loct].join('|');
    const job = ++this.job;
    this.day = null; this.dayErr = ''; this.err = '';

    if (this.cache.has(key)) { this.results = this.cache.get(key); this.state = 'done'; return this.render(); }

    this.results = {}; this.state = 'loading'; this.render();
    const order = [this.sel, ...VARIABLES.map((v) => v.code).filter((x) => x !== this.sel)];
    try {
      for (let i = 0; i < order.length; i++) {
        const r = await this.fetchVar(order[i], ext, c);
        if (job !== this.job) return;
        this.results[order[i]] = r;
        this.render();
        if (i < order.length - 1) await sleep(GAP_MS);
        if (job !== this.job) return;
      }
      this.cache.set(key, this.results);
      this.state = 'done';
    } catch (e) {
      if (job !== this.job) return;
      this.state = 'error'; this.err = String(e.message);
    }
    this.render();
  }

  cur() { return this.samples[this.idx] || null; }

  async loadDay() {
    const here = this.cur();
    if (!here || this.dayBusy) return;
    const job = this.job;
    this.dayBusy = true; this.dayErr = ''; this.day = null; this.render();
    try {
      const d = await this.request({
        var1: 't', latitude: here.lat.toFixed(3), longitude: here.lon.toFixed(3), ls: this.ls, localtime: 'all',
      });
      if (job === this.job) this.day = d;
    } catch (e) { if (job === this.job) this.dayErr = String(e.message); }
    this.dayBusy = false;
    this.render();
  }

  /* ---------------- page ---------------- */

  build() {
    if (!document.getElementById('wx-style')) {
      const st = document.createElement('style');
      st.id = 'wx-style'; st.textContent = STYLE;
      document.head.appendChild(st);
    }
    const root = this.root = document.createElement('div');
    root.id = 'wx-page';
    root.className = 'wx-hidden';
    root.innerHTML = `
      <div class="wx-top"><button class="wx-back" id="wx-back" aria-label="Back"><i>‹</i>Back</button></div>
      <div class="wx-eyebrow">Atmosphere</div>
      <h1 class="wx-title">Mars weather</h1>
      <p class="wx-sub">Temperature, pressure, air density and wind for any place on Mars, from the Mars Climate Database (LMD / ESA / CNES / Open University). These are climate-model values for a chosen season and time of day, not live weather.</p>
      <div class="wx-layout">
        <div class="wx-card">
          <h3>Place</h3>
          <div class="wx-chips" id="wx-places"></div>
          <div class="wx-row"><label>Latitude</label><input class="wx-in" id="wx-lat" type="text" placeholder="e.g. 18.44"></div>
          <div class="wx-row"><label>Longitude</label><input class="wx-in" id="wx-lon" type="text" placeholder="e.g. 77.45 (east)"></div>
          <h3 style="margin-top:16px">Season and time</h3>
          <div class="wx-row"><label>Ls (0–360)</label><input class="wx-in" id="wx-ls" type="text"><button class="wx-chip" id="wx-now">Now</button></div>
          <div class="wx-row"><label>Local time (h)</label><input class="wx-in" id="wx-loc" type="text"></div>
          <div class="wx-chips" id="wx-times"></div>
          <button class="wx-go" id="wx-run">Get weather</button>
          <div class="wx-small">Each request goes to the MCD one variable at a time, so a full set takes about 10 seconds. Results are remembered for repeat visits.</div>
        </div>
        <div class="wx-card" id="wx-out"></div>
      </div>`;
    document.body.appendChild(root);

    const $ = (id) => root.querySelector(id);
    this.latIn = $('#wx-lat'); this.lonIn = $('#wx-lon'); this.lsIn = $('#wx-ls'); this.locIn = $('#wx-loc');
    this.out = $('#wx-out'); this.runBtn = $('#wx-run');

    $('#wx-back').onclick = () => this.close();
    this.runBtn.onclick = () => this.run();
    $('#wx-now').onclick = () => {
      const n = marsNow(parseFloat(this.lonIn.value) || 0);
      this.lsIn.value = n.ls.toFixed(1); this.locIn.value = n.ltst.toFixed(1);
      this.markTimes();
    };

    for (const inp of [this.latIn, this.lonIn, this.lsIn, this.locIn]) {
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.run(); });
    }
    root.addEventListener('keydown', (e) => e.stopPropagation());   // map hotkeys must not fire from this page
    root.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

    this.placesEl = $('#wx-places');
    this.renderPlaceChips();
    const times = $('#wx-times');
    TIMES.forEach((t) => {
      const b = document.createElement('button');
      b.className = 'wx-chip'; b.textContent = `${t.label} ${t.h}h`; b.dataset.h = t.h;
      b.onclick = () => { this.locIn.value = t.h; this.markTimes(); this.run(); };
      times.appendChild(b);
    });
    this.locIn.addEventListener('input', () => this.markTimes());
    for (const inp of [this.latIn, this.lonIn]) inp.addEventListener('input', () => { this.mode = 'point'; this.renderPlaceChips(); });

    const n = marsNow(PLACES[0].lon);
    this.lsIn.value = n.ls.toFixed(1);
    this.locIn.value = '14';
    this.syncInputs(true);
  }

  renderPlaceChips() {
    if (!this.placesEl) return;
    this.placesEl.innerHTML = '';
    const add = (text, on, fn) => {
      const b = document.createElement('button');
      b.className = 'wx-chip' + (on ? ' on' : ''); b.textContent = text; b.onclick = fn;
      this.placesEl.appendChild(b);
    };
    if (this.route) add('🛰️ Planned route', this.mode === 'route', () => { this.mode = 'route'; this.syncInputs(true); this.run(); });
    for (const p of PLACES) {
      const on = this.mode === 'point' && Math.abs(p.lat - (parseFloat(this.latIn?.value) || 999)) < 0.011 && Math.abs(p.lon - (parseFloat(this.lonIn?.value) || 999)) < 0.011;
      add(p.name, on, () => { this.mode = 'point'; this.place = p; this.syncInputs(true); this.run(); });
    }
  }

  syncInputs() {
    if (this.mode === 'route' && this.route) {
      const s = this.route.samples, mid = s[Math.floor(s.length / 2)];
      this.latIn.value = mid.lat.toFixed(2); this.lonIn.value = mid.lon.toFixed(2);
    } else {
      this.latIn.value = this.place.lat.toFixed(2); this.lonIn.value = this.place.lon.toFixed(2);
    }
    this.renderPlaceChips();
    this.markTimes();
  }

  markTimes() {
    this.root.querySelectorAll('#wx-times .wx-chip').forEach((b) => b.classList.toggle('on', parseFloat(this.locIn.value) === Number(b.dataset.h)));
  }

  fmtVal(code, x) {
    return code === 't' ? `${(x - 273.15).toFixed(1)} °C` : code === 'p' ? `${x.toFixed(0)} Pa` : code === 'rho' ? `${x.toPrecision(3)} kg/m³` : `${x.toFixed(1)} m/s`;
  }

  stat(v) {
    const r = this.results[v.code];
    const head = `<b class="k">${v.icon} ${v.label}</b>`;
    if (!r) return `<div class="wx-stat">${head}<div class="wx-wait">${this.state === 'loading' ? '<span class="wx-spin"></span>waiting…' : '–'}</div></div>`;
    const s = r.at?.[this.idx];
    if (!s) return `<div class="wx-stat">${head}<div class="wx-wait">no numbers (picture only)</div></div>`;
    const c = s.centre;
    let big, sec;
    if (v.code === 't') { big = `${(c - 273.15).toFixed(1)}<small>°C</small>`; sec = `${c.toFixed(1)} K`; }
    else if (v.code === 'p') { big = `${c.toFixed(0)}<small>Pa</small>`; sec = `${(c / 101325 * 100).toFixed(2)}% of Earth’s sea-level pressure`; }
    else if (v.code === 'rho') { big = `${c.toPrecision(3)}<small>kg/m³</small>`; sec = `${(c / 1.225 * 100).toFixed(2)}% of Earth’s sea-level air`; }
    else { big = `${c.toFixed(1)}<small>m/s</small>`; sec = `${(c * 3.6).toFixed(0)} km/h`; }
    const f = (x) => (v.code === 't' ? (x - 273.15).toFixed(1) : v.code === 'p' ? x.toFixed(0) : v.code === 'rho' ? x.toPrecision(3) : x.toFixed(1));
    return `<div class="wx-stat">${head}<div class="wx-big">${big}</div><div class="wx-sec">${sec}</div>` +
      `<div class="wx-range">Whole area: ${f(s.min)} to ${f(s.max)}</div></div>`;
  }

  routeTable() {
    let h = '<h3 style="margin:20px 0 8px">Weather along the route</h3>' +
      '<table class="wx-tbl"><tr><th>Where</th><th>Lat, Lon</th><th>Temp</th><th>Pressure</th><th>Density</th><th>Wind</th></tr>';
    this.samples.forEach((p, i) => {
      h += `<tr class="wx-r${i === this.idx ? ' on' : ''}" data-idx="${i}"><td><b>${esc(p.label)}</b></td><td>${fmtLat(p.lat)}, ${fmtLon(p.lon)}</td>`;
      for (const v of VARIABLES) {
        const s = this.results[v.code]?.at?.[i];
        h += `<td>${s ? this.fmtVal(v.code, s.centre) : '<span class="wx-wait">…</span>'}</td>`;
      }
      h += '</tr>';
    });
    return h + '</table><div class="wx-small">Click a row to show it in the big cards above. The climate database works on a coarse grid (several degrees across, hundreds of km), so points along a short route give similar numbers; differences show mostly on longer routes.</div>';
  }

  render() {
    const here = this.cur();
    const routeMode = this.mode === 'route' && this.samples.length > 1;
    let h = '';
    if (here) {
      const title = routeMode ? `Planned route${this.route?.lengthM ? ` · ${(this.route.lengthM / 1000).toFixed(2)} km` : ''}` : here.label;
      h += `<div class="wx-head"><span class="wx-place">${esc(title)}</span>` +
        `<span class="wx-meta">${routeMode ? `showing: ${esc(here.label)} · ` : ''}${fmtLat(here.lat)}, ${fmtLon(here.lon)} · Ls ${this.ls} (${seasonOf(this.ls)}) · ${this.loct} h local time · 10 m above the ground</span></div>`;
    }
    if (this.state === 'idle') h += '<div class="wx-msg wx-info">Pick a place (or the planned route) and press “Get weather”.</div>';
    if (this.state === 'loading') h += '<div class="wx-msg wx-info"><span class="wx-spin"></span>Asking the Mars Climate Database, one variable at a time…</div>';
    if (this.state === 'error') h += `<div class="wx-msg wx-err">${esc(this.err)}</div>`;
    if (here) h += `<div class="wx-stats">${VARIABLES.map((v) => this.stat(v)).join('')}</div>`;
    if (here && routeMode) h += this.routeTable();

    const r = this.results[this.sel];
    if (here) {
      h += '<h3 style="margin:20px 0 8px">Map of the area</h3><div class="wx-chips">' +
        VARIABLES.map((v) => `<button class="wx-chip${v.code === this.sel ? ' on' : ''}" data-var="${v.code}">${v.label}</button>`).join('') + '</div>';
      if (r) {
        h += r.imgs.map((s) => `<a href="${esc(s)}" target="_blank" rel="noopener"><img class="wx-img" src="${esc(s)}" alt="map"></a>`).join('');
        if (r.data) h += `<div class="wx-links"><a href="${esc(r.data)}" target="_blank" rel="noopener">data file</a></div>`;
      } else if (this.state === 'loading') h += '<div class="wx-wait">picture on its way…</div>';

      h += `<h3 style="margin:20px 0 8px">Temperature through the day${routeMode ? ` · ${esc(here.label)}` : ''}</h3>` +
        `<button class="wx-chip" id="wx-day"${this.dayBusy ? ' disabled' : ''}>${this.dayBusy ? 'Asking…' : 'Show day curve'}</button>`;
      if (this.dayErr) h += `<div class="wx-msg wx-err">Day curve failed: ${esc(this.dayErr)}</div>`;
      if (this.day) h += this.day.imgs.map((s) => `<a href="${esc(s)}" target="_blank" rel="noopener"><img class="wx-img" src="${esc(s)}" alt="day curve"></a>`).join('');
    }
    this.out.innerHTML = h;
    this.out.querySelectorAll('[data-var]').forEach((b) => { b.onclick = () => { this.sel = b.dataset.var; this.render(); }; });
    this.out.querySelectorAll('tr.wx-r').forEach((tr) => { tr.onclick = () => { this.idx = Number(tr.dataset.idx); this.day = null; this.dayErr = ''; this.render(); }; });
    const d = this.out.querySelector('#wx-day');
    if (d) d.onclick = () => this.loadDay();
    this.runBtn.disabled = this.state === 'loading';
    this.runBtn.textContent = this.state === 'loading' ? 'Loading…' : 'Get weather';
  }

  dispose() {
    this.job++;
    (this._offs || []).forEach((f) => typeof f === 'function' && f());
    this.ctx.bus.off?.('weather:open', this.onOpen);
    this.ctx.bus.off?.('route:planned', this.onRoute);
    window.removeEventListener('keydown', this.onKey);
    this.root?.remove();
    document.getElementById('wx-style')?.remove();
    super.dispose();
  }
}
