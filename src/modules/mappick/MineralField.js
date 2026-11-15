// CRISM mineral field: loads summary-parameter PNGs (public/tiles/overlays/crism/*.png), normalises each one,
// combines the chosen layers into ONE score (0..1) and lets you sample it by lon/lat.
//
// Sampling is by lon/lat (not world x/z) because MapPickModule recenters the world after the second pin.
//
// ASSUMPTIONS (change here if they are wrong):
//  * every PNG covers the SAME lon/lat box. The box comes from crism.json (see parseBounds); if crism.json has no
//    bounds that can be understood, the HiRISE rect of the terrain is used instead.
//  * the PNG is a greyscale-ish stretch: brighter = stronger band / index. Transparent pixels (alpha < 128) = no data.
//    If your PNGs are colour-mapped (rainbow etc.), brightness is NOT the value: tell me the colormap and replace
//    the `luma` line in layer().

export const CRISM_BASE = '/tiles/overlays/crism/';

// Preset groups of CRISM summary parameters (Viviano-Beck et al. 2014). Edit freely: names = PNG file names.
export const MINERAL_PRESETS = {
  hydrated:  { label: 'Hydrated minerals / sulfates', layers: ['BD1900_2', 'BD1900R2', 'BD2100_2', 'SINDEX2'] },
  clays:     { label: 'Clays (Fe/Mg and Al phyllosilicates)', layers: ['BD2290', 'D2300', 'BD2355', 'BD2210_2', 'BD2190'] },
  carbonate: { label: 'Carbonates', layers: ['CINDEX2', 'BD2500_2', 'MIN2295_2480', 'MIN2345_2537'] },
  mafic:     { label: 'Mafic (olivine / pyroxene)', layers: ['OLINDEX3', 'LCPINDEX2', 'HCPINDEX2'] },
  all:       { label: 'All of the above', layers: [] },   // filled below
};
MINERAL_PRESETS.all.layers = ['hydrated', 'clays', 'carbonate', 'mafic'].flatMap((k) => MINERAL_PRESETS[k].layers);

const MAX_SIDE = 1024;   // every layer is resampled to at most this many pixels on its longest side

function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`cannot load ${url}`));
    img.src = url;
  });
}

// Understands the usual ways a bounds box is written. Returns {lonMin, lonMax, latMin, latMax} or null.
function parseBounds(j) {
  const num = (o, keys) => { for (const k of keys) if (Number.isFinite(o?.[k])) return o[k]; return undefined; };
  const fromObj = (o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const w = num(o, ['west', 'lonMin', 'minLon', 'lon_min', 'left', 'xmin', 'minx', 'lon0']);
    const e = num(o, ['east', 'lonMax', 'maxLon', 'lon_max', 'right', 'xmax', 'maxx', 'lon1']);
    const s = num(o, ['south', 'latMin', 'minLat', 'lat_min', 'bottom', 'ymin', 'miny', 'lat0']);
    const n = num(o, ['north', 'latMax', 'maxLat', 'lat_max', 'top', 'ymax', 'maxy', 'lat1']);
    if (![w, e, s, n].every(Number.isFinite)) return null;
    return { lonMin: Math.min(w, e), lonMax: Math.max(w, e), latMin: Math.min(s, n), latMax: Math.max(s, n) };
  };
  const fromAny = (v) => {
    if (Array.isArray(v)) {
      if (v.length === 4 && v.every(Number.isFinite)) {            // GeoJSON-style bbox [west, south, east, north]
        return { lonMin: Math.min(v[0], v[2]), lonMax: Math.max(v[0], v[2]), latMin: Math.min(v[1], v[3]), latMax: Math.max(v[1], v[3]) };
      }
      if (v.length === 2 && Array.isArray(v[0]) && Array.isArray(v[1])) {   // Leaflet-style [[lat, lon], [lat, lon]]
        const [[la0, lo0], [la1, lo1]] = v;
        return { lonMin: Math.min(lo0, lo1), lonMax: Math.max(lo0, lo1), latMin: Math.min(la0, la1), latMax: Math.max(la0, la1) };
      }
      return null;
    }
    return fromObj(v);
  };
  if (!j || typeof j !== 'object') return null;
  let b = fromObj(j);
  if (b) return b;
  for (const k of ['bounds', 'extent', 'bbox', 'bound', 'region']) if ((b = fromAny(j[k]))) return b;
  for (const v of Object.values(j)) {                              // one level deeper
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ((b = fromObj(v))) return b;
      for (const k of ['bounds', 'extent', 'bbox']) if ((b = fromAny(v[k]))) return b;
    }
  }
  return null;
}

export class MineralField {
  constructor(terrain, { base = CRISM_BASE } = {}) {
    this.terrain = terrain;
    this.base = base;
    this.bounds = null;
    this.cache = new Map();     // layer name -> Float32Array (0..1)
    this.size = null;           // {w, h} shared by all layers
    this.grid = null;           // combined score, Float32Array(w*h)
    this.dom = null;            // index (into this.names) of the strongest layer, Uint8Array(w*h)
    this.names = [];
    this.missing = [];
    this.ready = false;
    this._tok = 0;
  }

  async init() {
    let b = null;
    try {
      const res = await fetch(`${this.base}crism.json`);
      if (res.ok) {
        const txt = await res.text();
        if (!txt.trimStart().startsWith('<')) {
          this.meta = JSON.parse(txt);
          b = parseBounds(this.meta);
        }
      }
    } catch (e) { console.warn('[minerals] crism.json not usable:', e.message); }
    if (!b) {
      // fall back to the HiRISE rect, read NOW (before the world is recentered) and stored as lon/lat
      const t = this.terrain, r = t.hiriseRect || t.regionRect;
      const c = [[r.x0, r.z0], [r.x1, r.z0], [r.x0, r.z1], [r.x1, r.z1]].map(([x, z]) => t.worldToLonLat(x, z));
      const lons = c.map((p) => p.lon), lats = c.map((p) => p.lat);
      b = { lonMin: Math.min(...lons), lonMax: Math.max(...lons), latMin: Math.min(...lats), latMax: Math.max(...lats) };
      console.warn('[minerals] no bounds in crism.json, using the HiRISE rect as the overlay extent', b);
    } else {
      console.log('[minerals] overlay bounds from crism.json', b);
    }
    this.bounds = b;
  }

  // Load one PNG -> normalised 0..1 Float32Array (2nd..98th percentile stretch of the valid pixels).
  async layer(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    const img = await loadImage(`${this.base}${name}.png`);
    if (!this.size) {
      const s = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      this.size = { w: Math.max(2, Math.round(img.width * s)), h: Math.max(2, Math.round(img.height * s)) };
    }
    const { w, h } = this.size;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const v = new Float32Array(w * h), hist = new Uint32Array(256);
    for (let i = 0; i < w * h; i++) {
      if (d[4 * i + 3] < 128) continue;                                    // transparent = no data
      const luma = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
      if (luma <= 0) continue;                                             // black = no data
      v[i] = luma; hist[Math.min(255, luma | 0)]++;
    }
    let total = 0;
    for (let k = 0; k < 256; k++) total += hist[k];
    let lo = 0, hi = 255, acc = 0;
    for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= total * 0.02) { lo = k; break; } }
    acc = 0;
    for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= total * 0.98) { hi = k; break; } }
    if (hi <= lo) hi = lo + 1;
    for (let i = 0; i < v.length; i++) if (v[i] > 0) v[i] = Math.min(1, Math.max(0, (v[i] - lo) / (hi - lo)));
    this.cache.set(name, v);
    return v;
  }

  // Choose the layers; the score of a pixel is the STRONGEST of them (a hotspot = any chosen mineral is strong).
  async setLayers(names) {
    const tok = ++this._tok;
    this.ready = false;
    const got = [];
    this.missing = [];
    for (const n of names) {
      try { got.push({ name: n, data: await this.layer(n) }); }
      catch (e) { this.missing.push(n); console.warn(`[minerals] skipped ${n}:`, e.message); }
    }
    if (tok !== this._tok) return;                                         // a newer setLayers() call replaced this one
    if (!got.length) { this.grid = null; this.names = []; throw new Error('none of the CRISM layers could be loaded'); }
    const { w, h } = this.size;
    const grid = new Float32Array(w * h), dom = new Uint8Array(w * h);
    for (let k = 0; k < got.length; k++) {
      const a = got[k].data;
      for (let i = 0; i < grid.length; i++) if (a[i] > grid[i]) { grid[i] = a[i]; dom[i] = k; }
    }
    this.grid = grid; this.dom = dom; this.names = got.map((x) => x.name);
    this.ready = true;
  }

  _uv(lon, lat) {
    const b = this.bounds, { w, h } = this.size;
    const L = lon + 360 * Math.round(((b.lonMin + b.lonMax) / 2 - lon) / 360);   // same lon convention as the map
    const u = ((L - b.lonMin) / (b.lonMax - b.lonMin)) * (w - 1);
    const v = ((b.latMax - lat) / (b.latMax - b.latMin)) * (h - 1);            // row 0 = north
    return (u < 0 || v < 0 || u > w - 1 || v > h - 1) ? null : [u, v];
  }

  // Mineral score 0..1 at lon/lat (bilinear). 0 outside the overlay or where there is no data.
  sample(lon, lat) {
    if (!this.ready) return 0;
    const uv = this._uv(lon, lat);
    if (!uv) return 0;
    const { w, h } = this.size, g = this.grid;
    const [u, v] = uv, x0 = Math.floor(u), y0 = Math.floor(v), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = u - x0, fy = v - y0;
    return (g[y0 * w + x0] * (1 - fx) + g[y0 * w + x1] * fx) * (1 - fy) + (g[y1 * w + x0] * (1 - fx) + g[y1 * w + x1] * fx) * fy;
  }

  // Which layer is strongest here (index into this.names), -1 outside the overlay.
  layerAt(lon, lat) {
    if (!this.ready) return -1;
    const uv = this._uv(lon, lat);
    return uv ? this.dom[Math.round(uv[1]) * this.size.w + Math.round(uv[0])] : -1;
  }
}
