import * as THREE from 'three';
import { Module } from '../../core/Module.js';

// Synthetic Mars ground beyond the real data. It is a single low-detail mesh shaped like a flat disc of rings:
// rings are close together near the real data and spread out with distance, so it stays cheap.
//
//  - Its height is a pure function of world position (hash noise, no Math.random), so it is identical on every load.
//  - Right at the edge of the real data it copies the real edge height, then fades into invented terrain
//    (broad hills + craters of many sizes) over BLEND_M metres, so there is no cliff or seam.
//  - Detail fades out with distance (features smaller than ~3 cells are dropped), so nothing shimmers.
//  - The part that lies over the real data is cut out in the shader, so it never overlaps the real tiles.
//  - It uses the same colour ramp as the real terrain. It does not touch lights, fog, background or cameras.
//
// IT IS FAKE GROUND: never feed it to path planning or any analysis. Real data = the real tiles only.

const RADIUS_M = 300000;      // how far the fake ground reaches from the centre of the real data
const ANGULAR = 768;          // vertices around each ring
const ASPECT = 1.3;           // ring spacing relative to sideways spacing (1 = square cells)
const BLEND_M = 12000;        // distance over which the real edge height fades into invented terrain
const EDGE_DROP = 3;          // display units the filler sits under the real edge (hides hairline cracks)
const BIG_RELIEF_M = 700;     // size of the broad hills, metres (before vertical exaggeration)
const CRATER_DEPTH = 0.11;    // crater depth as a fraction of its radius
const CRATER_SCALES = [48000, 17000, 6000, 2200, 800, 300];   // crater cell sizes, metres
const SEED = 1337;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
const fade5 = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function hash(ix, iy, s = 0) {                       // 0..1, deterministic
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul((s + SEED) | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x, y, s) {                           // value noise, 0..1
  const ix = Math.floor(x), iy = Math.floor(y), u = fade5(x - ix), v = fade5(y - iy);
  const a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Broad hills and ridges, metres. spacing = distance between vertices here (detail finer than this is dropped).
function relief(x, z, spacing) {
  let sum = 0, amp = 1, wave = 70000;
  for (let o = 0; o < 9; o++, wave *= 0.5, amp *= 0.5) {
    const f = clamp01((wave / spacing - 2) / 3);
    if (f <= 0) break;
    const n = vnoise(x / wave, z / wave, o) * 2 - 1;
    sum += amp * f * (0.65 * n + 0.35 * (1 - 2 * Math.abs(n)));   // mostly smooth, a little ridged
  }
  return BIG_RELIEF_M * sum * 0.6;
}

// Craters of several sizes on a jittered grid, metres. One lookup per cell, so it is fast and repeatable.
function craters(x, z, spacing) {
  let h = 0;
  for (let si = 0; si < CRATER_SCALES.length; si++) {
    const S = CRATER_SCALES[si];
    const f = clamp01((S / spacing - 3) / 4);
    if (f <= 0) break;
    const cx = Math.floor(x / S), cz = Math.floor(z / S);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = cx + di, j = cz + dj;
        if (hash(i, j, 100 + si) < 0.5) continue;                       // about half the cells hold a crater
        const px = (i + 0.2 + 0.6 * hash(i, j, 200 + si)) * S;
        const pz = (j + 0.2 + 0.6 * hash(i, j, 300 + si)) * S;
        const R = S * (0.14 + 0.3 * hash(i, j, 400 + si));
        const t = Math.hypot(x - px, z - pz) / R;
        if (t > 1.8) continue;
        const bowl = t < 1 ? -CRATER_DEPTH * R * (1 - t * t) : 0;
        const rim = 0.05 * R * Math.exp(-((t - 1) * (t - 1)) / 0.06);
        h += f * (bowl + rim);
      }
    }
  }
  return h;
}

export class FillerModule extends Module {
  static id = 'filler';

  async init() {
    this.alive = true;
    this.mesh = null;
    this.timer = setInterval(() => this.tryBuild(), 250);   // wait for WorldModule to publish the terrain
    this.tryBuild();
  }

  tryBuild() {
    if (this.mesh || !this.alive) return;
    const t = this.ctx.state.get('terrain');
    if (!t) return;
    clearInterval(this.timer);
    if (!t.regionRect || !t.sampleWorld || !t.ramp) {
      console.warn('[filler] terrain.regionRect / sampleWorld / ramp are missing: add the lines to WorldModule.js first');
      return;
    }
    this.build(t);
  }

  build(t) {
    const { x0, x1, z0, z1 } = t.regionRect;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, hw = (x1 - x0) / 2, hh = (z1 - z0) / 2;
    const EXAG = t.vertExag, span = Math.max(t.maxElevationM - t.minElevationM, 1e-6), ramp = t.ramp;

    // Heights of the real data on a coarse grid over its footprint (used for the edge and as the average level).
    const G = 96, grid = new Float32Array(G * G);
    let sum = 0, cnt = 0;
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const x = x0 + 0.5 + ((x1 - x0 - 1) * i) / (G - 1), z = z0 + 0.5 + ((z1 - z0 - 1) * j) / (G - 1);
        const y = t.sampleWorld(x, z);
        grid[j * G + i] = y === null ? NaN : y;
        if (y !== null && y === y) { sum += y; cnt++; }
      }
    }
    const mean = cnt ? sum / cnt : 0;
    for (let k = 0; k < grid.length; k++) if (grid[k] !== grid[k]) grid[k] = mean;

    const edgeY = (x, z) => {                        // real height at the nearest point of the footprint
      const fx = clamp01((x - x0) / (x1 - x0)) * (G - 1), fz = clamp01((z - z0) / (z1 - z0)) * (G - 1);
      const i = Math.min(Math.floor(fx), G - 2), j = Math.min(Math.floor(fz), G - 2), a = fx - i, b = fz - j;
      return (grid[j * G + i] * (1 - a) + grid[j * G + i + 1] * a) * (1 - b) +
             (grid[(j + 1) * G + i] * (1 - a) + grid[(j + 1) * G + i + 1] * a) * b;
    };

    // Rings: start just inside the real footprint (hidden by the cut-out), spacing grows with radius.
    const N = ANGULAR;
    const r0 = Math.max(0.9 * Math.min(hw, hh), 500);
    const g = 1 + (ASPECT * 2 * Math.PI) / N;
    const radii = [];
    for (let r = r0; r < RADIUS_M; r *= g) radii.push(r);
    const R = radii.length, nV = R * N;

    const pos = new Float32Array(nV * 3), col = new Float32Array(nV * 3);
    for (let i = 0; i < R; i++) {
      const r = radii[i], spacing = (r * 2 * Math.PI) / N;
      for (let j = 0; j < N; j++) {
        const a = (j / N) * 2 * Math.PI;
        const x = cx + r * Math.cos(a), z = cz + r * Math.sin(a);
        const d = Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1));   // 0 inside the footprint
        const w = smooth(d / BLEND_M);
        const far = mean + EXAG * (relief(x, z, spacing) + craters(x, z, spacing));
        const y = (edgeY(x, z) - EDGE_DROP) * (1 - w) + far * w;
        const k = (i * N + j) * 3;
        pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;

        const ri = Math.round(clamp01(y / (EXAG * span)) * 255) * 3;
        const dust = 0.92 + 0.16 * vnoise(x / 4000, z / 4000, 50);          // soft patches of lighter / darker ground
        col[k] = (ramp[ri] / 65535) * dust;
        col[k + 1] = (ramp[ri + 1] / 65535) * dust;
        col[k + 2] = (ramp[ri + 2] / 65535) * dust;
      }
    }

    const idx = new Uint32Array((R - 1) * N * 6);
    let n = 0;
    for (let i = 0; i < R - 1; i++) {
      for (let j = 0; j < N; j++) {
        const a = i * N + j, b = (i + 1) * N + j, c = i * N + ((j + 1) % N), d = (i + 1) * N + ((j + 1) % N);
        idx[n++] = a; idx[n++] = c; idx[n++] = b;
        idx[n++] = b; idx[n++] = c; idx[n++] = d;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    // darken steep ground like the real terrain does
    const nor = geo.attributes.normal.array;
    for (let v = 0; v < nV; v++) {
      const s = smooth((1 - nor[v * 3 + 1] - 0.03) / (0.22 - 0.03)), f = 1 - 0.5 * s;
      col[v * 3] *= f; col[v * 3 + 1] *= f * 0.95; col[v * 3 + 2] *= f * 0.9;
    }

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uRect = { value: new THREE.Vector4(x0 + 2, x1 - 2, z0 + 2, z1 - 2) };   // real data lives here
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vXZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvXZ = transformed.xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vXZ;\nuniform vec4 uRect;')
        .replace('#include <clipping_planes_fragment>',
          '#include <clipping_planes_fragment>\nif (vXZ.x > uRect.x && vXZ.x < uRect.y && vXZ.y > uRect.z && vXZ.y < uRect.w) discard;');
    };

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.ctx.scene.add(this.mesh);
    console.log(`[filler] built ${nV} vertices, ${R} rings, reaching ${(RADIUS_M / 1000).toFixed(0)} km`);
  }

  dispose() {
    super.dispose();
    this.alive = false;
    clearInterval(this.timer);
    if (!this.mesh) return;
    this.ctx.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
