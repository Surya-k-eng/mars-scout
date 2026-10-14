import { fromFile } from 'geotiff';
import fs from 'node:fs';

const SRC = process.argv[2];
const OUT = process.argv[3] ?? 'public/tiles/hirise';
if (!SRC) throw new Error('usage: node data-prep/make-hirise-tiles.mjs <dtm.tif> [outDir]');

const S = 256, V = S + 1, CHUNK = 256;   // 256 cells per tile, 257 vertices (edges shared with neighbours)
const img = await (await fromFile(SRC)).getImage();
const W = img.getWidth(), H = img.getHeight();
const nodata = img.getGDALNoData();
const bad = (v) => v === nodata || !Number.isFinite(v) || v < -1e5;

// level 0 = every pixel (1 m), level 1 = every 2nd, ... until one tile covers everything
const levels = [];
for (let L = 0; ; L++) {
  const step = 2 ** L;
  const cols = Math.floor((W - 1) / step) + 1;
  const rows = Math.floor((H - 1) / step) + 1;
  const tilesX = Math.ceil((cols - 1) / S), tilesY = Math.ceil((rows - 1) / S);
  levels.push({ level: L, step, cols, rows, tilesX, tilesY, cur: -1, buf: null, written: 0 });
  fs.mkdirSync(`${OUT}/${L}`, { recursive: true });
  if (tilesX === 1 && tilesY === 1) break;
}

function flush(lv) {
  if (lv.cur < 0 || lv.cur >= lv.tilesY) return;
  const rowsArr = [];
  for (let j = 0; j < V; j++) rowsArr[j] = lv.buf[j] ?? rowsArr[j - 1];   // pad partial edge tiles
  for (let tx = 0; tx < lv.tilesX; tx++) {
    const vals = new Float32Array(V * V);
    let min = Infinity, max = -Infinity;
    for (let j = 0; j < V; j++) {
      const rr = rowsArr[j];
      for (let i = 0; i < V; i++) {
        const v = rr[Math.min(tx * S + i, lv.cols - 1)];
        vals[j * V + i] = v;
        if (!bad(v) && v < min) min = v;
        if (!bad(v) && v > max) max = v;
      }
    }
    if (min === Infinity) continue;                    // tile is all "no data": skip it
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
  if (gr % S === 0 && gr > 0 && lv.cur === ty - 1) { lv.buf[S] = samples; flush(lv); } // shared edge row
  if (lv.cur !== ty) { lv.cur = ty; lv.buf = new Array(V).fill(null); }
  lv.buf[gr - ty * S] = samples;
}

for (let y0 = 0; y0 < H; y0 += CHUNK) {
  const y1 = Math.min(y0 + CHUNK, H);
  const [band] = await img.readRasters({ window: [0, y0, W, y1] });
  for (let r = y0; r < y1; r++) {
    const row = band.subarray((r - y0) * W, (r - y0 + 1) * W);
    for (const lv of levels) {
      if (r % lv.step) continue;
      const gr = r / lv.step;
      if (gr >= lv.rows) continue;
      const samples = new Float32Array(lv.cols);
      for (let gc = 0; gc < lv.cols; gc++) samples[gc] = row[gc * lv.step];
      addRow(lv, gr, samples);
    }
  }
  console.log(`rows ${y1} / ${H}`);
}
for (const lv of levels) flush(lv);

fs.writeFileSync(`${OUT}/index.json`, JSON.stringify({
  tileCells: S, verts: V, srcWidth: W, srcHeight: H,
  pixelSize: Math.abs(img.getResolution()[0]),
  bbox: img.getBoundingBox(), nodata,
  encoding: 'file = float32 min, float32 max, then uint16[257*257]; 0 = no data, 1..65535 maps min..max',
  levels: levels.map(({ level, step, cols, rows, tilesX, tilesY, written }) => ({ level, step, cols, rows, tilesX, tilesY, written })),
}, null, 2));
console.log('done', levels.map((l) => `L${l.level}: ${l.written} tiles`).join(', '));
