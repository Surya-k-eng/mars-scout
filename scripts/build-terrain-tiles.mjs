#!/usr/bin/env node
// Builds the tile pyramid for TerrainModule from one full-area raw float32 heightmap.
//
// usage:
//   node build-terrain-tiles.mjs <heights.f32> <width> <height> <cellSizeM> <outDir> [id=jezero] [tileSamples=129]
//
// e.g. node build-terrain-tiles.mjs full_heights.f32 10501 10501 2 public/data/jezero
//
// Input: row-major little-endian float32 elevations in metres, width*height samples.
// Output: meta.json, coarse.f32, tiles/{level}/{tx}_{ty}.f32
// Note: the whole input (+ ~1/3 for mips) is held in RAM. If it is >~1.5 GB, downsample the source first.

import fs from 'node:fs';
import path from 'node:path';

const [, , inFile, wArg, hArg, cellArg, outDir, id = 'jezero', tArg = '129'] = process.argv;
if (!inFile || !wArg || !hArg || !cellArg || !outDir) {
  console.error('usage: node build-terrain-tiles.mjs <heights.f32> <width> <height> <cellSizeM> <outDir> [id] [tileSamples]');
  process.exit(1);
}
const W = +wArg, H = +hArg, cell = +cellArg, T = +tArg;

const raw = fs.readFileSync(inFile);
if (raw.byteLength !== W * H * 4) {
  console.error(`${inFile} is ${raw.byteLength} bytes, expected ${W * H * 4} for ${W}x${H} float32`);
  process.exit(1);
}
const ab = raw.byteOffset % 4 === 0
  ? raw.buffer
  : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const off = raw.byteOffset % 4 === 0 ? raw.byteOffset : 0;
const base = new Float32Array(ab, off, W * H);

// min/max over valid samples, patch nodata with min
let minE = Infinity, maxE = -Infinity;
for (let i = 0; i < base.length; i++) {
  const v = base[i];
  if (Number.isFinite(v) && v > -1e10) { if (v < minE) minE = v; if (v > maxE) maxE = v; }
}
for (let i = 0; i < base.length; i++) {
  const v = base[i];
  if (!Number.isFinite(v) || v <= -1e10) base[i] = minE;
}
console.log(`elevation ${minE.toFixed(2)} .. ${maxE.toFixed(2)} m`);

// mip chain, 1-2-1 tent filter aligned to even samples so level l sample i sits at fine index i*2^l
const topLevel = Math.max(0, Math.ceil(Math.log2(Math.max(W - 1, H - 1) / (T - 1))));
const levels = [{ w: W, h: H, d: base }];
for (let l = 1; l <= topLevel; l++) {
  const p = levels[l - 1];
  const w = Math.ceil((p.w - 1) / 2) + 1, h = Math.ceil((p.h - 1) / 2) + 1;
  const d = new Float32Array(w * h);
  const wt = [1, 2, 1];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = Math.min(Math.max(2 * j + dj, 0), p.h - 1);
        for (let di = -1; di <= 1; di++) {
          const ii = Math.min(Math.max(2 * i + di, 0), p.w - 1);
          s += p.d[jj * p.w + ii] * wt[di + 1] * wt[dj + 1];
        }
      }
      d[j * w + i] = s / 16;
    }
  }
  levels.push({ w, h, d });
  console.log(`level ${l}: ${w}x${h}`);
}

fs.mkdirSync(path.join(outDir, 'tiles'), { recursive: true });

// tiles (adjacent tiles share their edge row/column of samples)
let count = 0;
for (let l = 0; l <= topLevel; l++) {
  const lv = levels[l];
  const nx = Math.max(1, Math.ceil((W - 1) / ((T - 1) * 2 ** l)));
  const ny = Math.max(1, Math.ceil((H - 1) / ((T - 1) * 2 ** l)));
  const dir = path.join(outDir, 'tiles', String(l));
  fs.mkdirSync(dir, { recursive: true });
  const buf = new Float32Array(T * T);
  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      for (let j = 0; j < T; j++) {
        const iz = Math.min(ty * (T - 1) + j, lv.h - 1);
        for (let i = 0; i < T; i++) {
          const ix = Math.min(tx * (T - 1) + i, lv.w - 1);
          buf[j * T + i] = lv.d[iz * lv.w + ix];
        }
      }
      fs.writeFileSync(path.join(dir, `${tx}_${ty}.f32`), Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
      count++;
    }
  }
  console.log(`level ${l}: ${nx}x${ny} tiles`);
}

// coarse whole-area grid for planners: first level with max dimension <= 1100
let cl = topLevel;
for (let l = 0; l <= topLevel; l++) {
  if (Math.max(levels[l].w, levels[l].h) <= 1100) { cl = l; break; }
}
const c = levels[cl];
fs.writeFileSync(path.join(outDir, 'coarse.f32'), Buffer.from(c.d.buffer, c.d.byteOffset, c.d.byteLength));

const meta = {
  id, width: W, height: H, cellSize: cell,
  minElevationM: minE, maxElevationM: maxE,
  tileSamples: T, topLevel,
  coarse: { file: 'coarse.f32', level: cl, width: c.w, height: c.h },
};
fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
console.log(`done: ${count} tiles, coarse level ${cl} (${c.w}x${c.h}), meta.json written`);
