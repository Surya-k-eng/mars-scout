import { fromFile } from 'geotiff';
import fs from 'node:fs';

const MAX = 1024; // longest side of output, in pixels
const tiff = await fromFile('data-prep/raw/M20_JezeroCrater_CTXDEM_20m.tif');
const img = await tiff.getImage();
const w = img.getWidth(), h = img.getHeight();
const [rx] = img.getResolution();
const nodata = img.getGDALNoData();

const scale = Math.min(1, MAX / Math.max(w, h));
const ow = Math.round(w * scale), oh = Math.round(h * scale);

const [band] = await img.readRasters({ width: ow, height: oh, resampleMethod: 'bilinear' });

const bad = (v) => v === nodata || !Number.isFinite(v) || v < -1e6;

let min = Infinity, max = -Infinity;
for (const v of band) {
  if (bad(v)) continue;
  if (v < min) min = v;
  if (v > max) max = v;
}

const out = new Float32Array(ow * oh);
for (let i = 0; i < out.length; i++) {
  out[i] = bad(band[i]) ? 0 : band[i] - min;
}

fs.mkdirSync('public/data/jezero', { recursive: true });
fs.writeFileSync('public/data/jezero/heights.f32', Buffer.from(out.buffer));
fs.writeFileSync('public/data/jezero/meta.json', JSON.stringify({
  id: 'jezero-ctx',
  width: ow,
  height: oh,
  cellSize: Math.abs(rx) / scale,
  minElevationM: min,
  maxElevationM: max,
  source: 'CTX DEM 20 m, downsampled',
}, null, 2));

console.log({ ow, oh, min, max, cellSize: Math.abs(rx) / scale });
