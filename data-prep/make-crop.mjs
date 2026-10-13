import { fromFile } from 'geotiff';
import fs from 'node:fs';

const S = 1000;
const img = await (await fromFile('data-prep/raw/M20_JezeroCrater_CTXDEM_20m.tif')).getImage();
const w = img.getWidth(), h = img.getHeight();
const X0 = Number(process.argv[2] ?? Math.round((w - S) / 2));
const Y0 = Number(process.argv[3] ?? Math.round((h - S) / 2));
const nodata = img.getGDALNoData();
const bad = (v) => v === nodata || !Number.isFinite(v) || v < -1e6;

const [band] = await img.readRasters({ window: [X0, Y0, X0 + S, Y0 + S] });

let min = Infinity, max = -Infinity;
for (const v of band) { if (bad(v)) continue; if (v < min) min = v; if (v > max) max = v; }
const out = new Float32Array(S * S);
for (let i = 0; i < out.length; i++) out[i] = bad(band[i]) ? 0 : band[i] - min;

fs.mkdirSync('public/data/jezero-crop', { recursive: true });
fs.writeFileSync('public/data/jezero-crop/heights.f32', Buffer.from(out.buffer));
fs.writeFileSync('public/data/jezero-crop/meta.json', JSON.stringify({
  id: 'jezero-crop-20m', width: S, height: S, cellSize: Math.abs(img.getResolution()[0]),
  minElevationM: min, maxElevationM: max, source: `CTX DEM 20 m, crop x=${X0} y=${Y0}`,
}, null, 2));
console.log({ X0, Y0, S, min, max });
