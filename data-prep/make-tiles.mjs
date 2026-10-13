import { fromFile } from 'geotiff';
import fs from 'node:fs';
import path from 'node:path';

// usage: node make-tiles.mjs <tif> <outDir>
const [src, outDir] = process.argv.slice(2);
if (!src || !outDir) throw new Error('usage: node make-tiles.mjs <tif> <outDir>');
const T = 256, N = T + 1;               // 256 cells per tile, 257 vertices

const img = await (await fromFile(src)).getImage();
const W = img.getWidth(), H = img.getHeight();
const rx = Math.abs(img.getResolution()[0]);
fs.mkdirSync(outDir, { recursive: true });

// Stage A: dump the whole raster to one flat float32 file (temporary), no-data -> NaN
const rawPath = path.join(outDir, 'full.raw');
const wfd = fs.openSync(rawPath, 'w');
let min = Infinity, max = -Infinity;
for (let y = 0; y < H; y += 256) {
  const y1 = Math.min(H, y + 256);
  const [d] = await img.readRasters({ window: [0, y, W, y1], samples: [0] });
  const f = d instanceof Float32Array ? d : Float32Array.from(d);
  for (let i = 0; i < f.length; i++) {
    const v = f[i];
    if (v > -1e30 && v === v) { if (v < min) min = v; if (v > max) max = v; }
    else f[i] = NaN;
  }
  fs.writeSync(wfd, new Uint8Array(f.buffer, f.byteOffset, f.byteLength), 0, f.byteLength, y * W * 4);
  if ((y / 256) % 10 === 0) console.log(`reading rows ${y} / ${H}`);
}
fs.closeSync(wfd);

// Stage B: build the tile pyramid. Level 0 = 1 m, level 1 = 2 m, level 2 = 4 m, ...
const rfd = fs.openSync(rawPath, 'r');
const row = new Float32Array(W);
const rowBytes = new Uint8Array(row.buffer);
const cellsX = W - 1, cellsY = H - 1;
let top = 0;
while (T * 2 ** top < Math.max(cellsX, cellsY)) top++;
const tilesPerLevel = [];

for (let L = 0; L <= top; L++) {
  const s = 2 ** L;
  const nx = Math.ceil(cellsX / (T * s)), ny = Math.ceil(cellsY / (T * s));
  tilesPerLevel.push({ nx, ny });
  fs.mkdirSync(path.join(outDir, String(L)), { recursive: true });
  for (let ty = 0; ty < ny; ty++) {
    const outs = Array.from({ length: nx }, () => new Float32Array(N * N));
    for (let j = 0; j < N; j++) {
      const y = (ty * T + j) * s;
      if (y > H - 1) { for (const o of outs) o.fill(NaN, j * N, (j + 1) * N); continue; }
      fs.readSync(rfd, rowBytes, 0, W * 4, y * W * 4);
      for (let tx = 0; tx < nx; tx++) {
        const o = outs[tx];
        for (let i = 0; i < N; i++) {
          const x = (tx * T + i) * s;
          o[j * N + i] = x > W - 1 ? NaN : row[x];
        }
      }
    }
    for (let tx = 0; tx < nx; tx++) {
      fs.writeFileSync(path.join(outDir, String(L), `${tx}_${ty}.f32`), new Uint8Array(outs[tx].buffer));
    }
  }
  console.log(`level ${L}: ${nx} x ${ny} tiles, ${rx * s} m per cell`);
}
fs.closeSync(rfd);
fs.rmSync(rawPath);

fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({
  tileSize: T, levels: top, width: W, height: H, cellSize: rx,
  minElevationM: min, maxElevationM: max, tilesPerLevel,
}, null, 2));
console.log('done');
