import { fromFile } from 'geotiff';
import fs from 'node:fs';
import path from 'node:path';

// usage: node make-heights.mjs <tif> <outDir> <x0> <y0> <widthPx> <heightPx> <factor> [id]
const [src, outDir, x0, y0, w, h, f, id] = process.argv.slice(2);
const X0 = +x0, Y0 = +y0, F = +f;
const NW = Math.floor(+w / F), NH = Math.floor(+h / F);

const img = await (await fromFile(src)).getImage();
const [rx, ry] = img.getResolution().map(Math.abs);
const bb = img.getBoundingBox();
if (X0 + NW * F > img.getWidth() || Y0 + NH * F > img.getHeight()) {
  throw new Error('window falls outside the image');
}

const out = new Float32Array(NW * NH);
const bandRows = Math.ceil(512 / F);
const bw = NW * F;
for (let r0 = 0; r0 < NH; r0 += bandRows) {
  const r1 = Math.min(NH, r0 + bandRows);
  const [data] = await img.readRasters({
    window: [X0, Y0 + r0 * F, X0 + bw, Y0 + r1 * F],
    samples: [0],
  });
  for (let r = r0; r < r1; r++) {
    for (let c = 0; c < NW; c++) {
      let s = 0, n = 0;
      for (let dy = 0; dy < F; dy++) {
        const base = ((r - r0) * F + dy) * bw + c * F;
        for (let dx = 0; dx < F; dx++) {
          const v = data[base + dx];
          if (v > -1e30) { s += v; n++; }
        }
      }
      out[r * NW + c] = n ? s / n : NaN;
    }
  }
}

let min = Infinity, max = -Infinity, missing = 0;
for (const v of out) if (!Number.isNaN(v)) { if (v < min) min = v; if (v > max) max = v; }
for (let i = 0; i < out.length; i++) if (Number.isNaN(out[i])) { out[i] = min; missing++; }

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'heights.f32'), Buffer.from(out.buffer));
const minX = bb[0] + X0 * rx, maxY = bb[3] - Y0 * ry;
fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({
  id: id ?? 'jezero', width: NW, height: NH, cellSize: rx * F,
  minElevationM: min, maxElevationM: max,
  sourceBBoxM: [minX, maxY - NH * F * ry, minX + NW * F * rx, maxY],
}, null, 2));
console.log(`${NW} x ${NH} cells at ${rx * F} m, elevation ${min.toFixed(1)} to ${max.toFixed(1)} m, filled ${missing} empty cells`);
