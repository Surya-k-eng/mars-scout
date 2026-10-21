import { fromFile } from 'geotiff';
import fs from 'node:fs';

const SRC = process.argv[2];
const MINLEVEL = Number(process.argv[3] ?? 3);
const OUT = process.argv[4] ?? 'public/tiles/global';
if (!SRC) throw new Error('usage: node data-prep/make-global-tiles.mjs <dem.tif> [minLevel=3] [outDir]');

const S = 256, V = S + 1, CHUNK = 256;
const img = await (await fromFile(SRC)).getImage();
const FW = img.getWidth(), H = img.getHeight();
const fbox = img.getBoundingBox(), px = Math.abs(img.getResolution()[0]);
const toU = (lon) => (Math.abs(fbox[0]) > 400 ? (lon * Math.PI / 180) * 3396190 : lon);
const LON0 = Number(process.argv[5] ?? -180), LON1 = Number(process.argv[6] ?? 180);
const XA = Math.max(0, Math.round((toU(LON0) - fbox[0]) / px));
const XB = Math.min(FW, Math.round((toU(LON1) - fbox[0]) / px));
const W = XB - XA;
const bbox = [fbox[0] + XA * px, fbox[1], fbox[0] + XB * px, fbox[3]];
const nodata = img.getGDALNoData();
const bad = (v) => v === nodata || !Number.isFinite(v) || v < -20000;
console.log({ W, H, nodata, bbox, XA, XB });

const levels = [];
for (let L = 0; ; L++) {
  const step = 2 ** L;
  const cols = Math.floor((W - 1) / step) + 1, rows = Math.floor((H - 1) / step) + 1;
  const tilesX = Math.ceil((cols - 1) / S), tilesY = Math.ceil((rows - 1) / S);
  levels.push({ level: L, step, cols, rows, tilesX, tilesY, built: L >= MINLEVEL, cur: -1, buf: null, written: 0 });
  if (L >= MINLEVEL) fs.mkdirSync(`${OUT}/${L}`, { recursive: true });
  if (tilesX === 1 && tilesY === 1) break;
}
if (MINLEVEL >= levels.length) throw new Error('MINLEVEL is above the top level (' + (levels.length - 1) + ')');
const active = levels.filter((l) => l.built);

function flush(lv) {
  if (lv.cur < 0 || lv.cur >= lv.tilesY) return;
  const rowsArr = [];
  for (let j = 0; j < V; j++) rowsArr[j] = lv.buf[j] ?? rowsArr[j - 1];
  for (let tx = 0; tx < lv.tilesX; tx++) {
    const vals = new Float32Array(V * V);
    let min = Infinity, max = -Infinity;
    for (let j = 0; j < V; j++) {
      const rr = rowsArr[j];
      for (let i = 0; i < V; i++) {
        const v = rr[Math.min(tx * S + i, lv.cols - 1)];
        vals[j * V + i] = v;
        if (!bad(v)) { if (v < min) min = v; if (v > max) max = v; }
      }
    }
    if (min === Infinity) continue;
    const range = max - min || 1;
    const q = new Uint16Array(V * V);
    for (let k = 0; k < q.length; k++) q[k] = bad(vals[k]) ? 0 : 1 + Math.round(((vals[k] - min) / range) * 65534);
    const head = Buffer.alloc(8);
    head.writeFloatLE(min, 0); head.writeFloatLE(max, 4);
    fs.writeFileSync(`${OUT}/${lv.level}/${tx}_${lv.cur}.bin`, Buffer.concat([head, Buffer.from(q.buffer)]));
    lv.written++;
  }
}
function addRow(lv, gr, samples) {
  const ty = Math.floor(gr / S);
  if (gr % S === 0 && gr > 0 && lv.cur === ty - 1) { lv.buf[S] = samples; flush(lv); }
  if (lv.cur !== ty) { lv.cur = ty; lv.buf = new Array(V).fill(null); }
  lv.buf[gr - ty * S] = samples;
}

let gmin = Infinity, gmax = -Infinity, lastPct = -1;
for (let y0 = 0; y0 < H; y0 += CHUNK) {
  const y1 = Math.min(y0 + CHUNK, H);
  const [band] = await img.readRasters({ window: [XA, y0, XB, y1] });
  for (let r = y0; r < y1; r++) {
    const row = band.subarray((r - y0) * W, (r - y0 + 1) * W);
    for (let i = 0; i < row.length; i++) { const v = row[i]; if (v >= -20000) { if (v < gmin) gmin = v; if (v > gmax) gmax = v; } }
    for (const lv of active) {
      if (r % lv.step) continue;
      const gr = r / lv.step;
      if (gr >= lv.rows) continue;
      const samples = new Float32Array(lv.cols);
      for (let gc = 0; gc < lv.cols; gc++) samples[gc] = row[gc * lv.step];
      addRow(lv, gr, samples);
    }
  }
  const pct = Math.floor((y1 / H) * 100);
  if (pct !== lastPct && pct % 2 === 0) { console.log(pct + '%'); lastPct = pct; }
}
for (const lv of active) flush(lv);

fs.writeFileSync(`${OUT}/index.json`, JSON.stringify({
  tileCells: S, verts: V, srcWidth: W, srcHeight: H,
  pixelSize: Math.abs(img.getResolution()[0]),
  bbox, nodata, geoKeys: img.getGeoKeys(),
  minLevel: MINLEVEL, minM: gmin, maxM: gmax,
  encoding: 'file = float32 min, float32 max, then uint16[257*257]; 0 = no data, 1..65535 maps min..max',
  levels: levels.map(({ level, step, cols, rows, tilesX, tilesY, built, written }) => ({ level, step, cols, rows, tilesX, tilesY, built, written })),
}, null, 2));
console.log('done. elevation range', gmin, 'to', gmax, '|', active.map((l) => `L${l.level}: ${l.written} tiles`).join(', '));
