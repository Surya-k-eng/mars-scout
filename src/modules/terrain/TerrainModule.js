import * as THREE from 'three';
import { Module } from '../../core/Module.js';
import { EVENTS } from '../../core/events.js';

// ---- knobs ----
const OVERVIEW = 'jezero';        // whole area, ~99 m cells (far terrain)
const CROP = 'jezero-crop';       // sharp 20 m cells (middle)
const ORIG_W = 4456, ORIG_H = 5067; // pixel size of the original CTX DEM
const EXAGGERATION = 2;           // visual height only; 1 = true scale
const SLOPE_DARK = 0.75, SLOPE_FULL = 0.6, NOISE_AMOUNT = 0.22, LOW_DARK = 0.35;
const BLEND_M = 600;              // meters over which the crop edge blends into the far terrain
// ---------------

const hash = (x, y) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const smooth = (t) => t * t * (3 - 2 * t);
const noise2 = (x, y) => {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = smooth(x - xi), ty = smooth(y - yi);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
};

const stops = [0x4a2818, 0x8a4a2a, 0xc2763f, 0xe3c39a].map((h) => new THREE.Color(h));
const rock = new THREE.Color(0x2e2420);

async function load(name) {
  const base = `${import.meta.env.BASE_URL}data/${name}/`;
  const meta = await (await fetch(base + 'meta.json')).json();
  const heights = new Float32Array(await (await fetch(base + 'heights.f32')).arrayBuffer());
  return { meta, heights };
}

// builds one terrain mesh; positions are in shared world space
function makeMesh({ heights, W, H, cell, ox, oz, dy, range, hole, material }) {
  const n = W * H;
  const P = new Float32Array(n * 3), C = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const x = i % W, z = (i / W) | 0;
    const wx = ox + (x - (W - 1) / 2) * cell, wz = oz + (z - (H - 1) / 2) * cell;
    const rel = heights[i] + dy; // height above the overview's lowest point
    P[i * 3] = wx; P[i * 3 + 1] = rel * EXAGGERATION; P[i * 3 + 2] = wz;

    const t01 = Math.min(Math.max(rel / range, 0), 1);
    const t = t01 * (stops.length - 1);
    const k = Math.min(Math.floor(t), stops.length - 2);
    c.copy(stops[k]).lerp(stops[k + 1], t - k);

    const dx = heights[z * W + Math.min(x + 1, W - 1)] - heights[z * W + Math.max(x - 1, 0)];
    const dz = heights[Math.min(z + 1, H - 1) * W + x] - heights[Math.max(z - 1, 0) * W + x];
    c.lerp(rock, Math.min(Math.hypot(dx, dz) / (2 * cell) / SLOPE_FULL, 1) * SLOPE_DARK);

    const nz = 0.65 * noise2(wx / 900, wz / 900) + 0.35 * noise2(wx / 120, wz / 120);
    c.multiplyScalar(1 - NOISE_AMOUNT / 2 + nz * NOISE_AMOUNT);
    c.multiplyScalar(1 - LOW_DARK * (1 - t01));
    C[i * 3] = c.r; C[i * 3 + 1] = c.g; C[i * 3 + 2] = c.b;
  }

  const I = new Uint32Array((W - 1) * (H - 1) * 6);
  let k = 0;
  for (let z = 0; z < H - 1; z++) {
    for (let x = 0; x < W - 1; x++) {
      if (hole) {
        const xa = ox + (x - (W - 1) / 2) * cell, za = oz + (z - (H - 1) / 2) * cell;
        if (xa >= hole.x0 && xa + cell <= hole.x1 && za >= hole.z0 && za + cell <= hole.z1) continue;
      }
      const a = z * W + x, b = a + W, cc = b + 1, d = a + 1;
      I[k++] = a; I[k++] = b; I[k++] = d; I[k++] = b; I[k++] = cc; I[k++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
  geo.setIndex(new THREE.BufferAttribute(I.subarray(0, k), 1));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

export class TerrainModule extends Module {
  static id = 'terrain';

  async init() {
    const [ov, cr] = await Promise.all([load(OVERVIEW), load(CROP)]);
    const Wo = ov.meta.width, Ho = ov.meta.height, co = ov.meta.cellSize;
    const Wc = cr.meta.width, Hc = cr.meta.height, cc = cr.meta.cellSize;
    const range = Math.max(ov.meta.maxElevationM - ov.meta.minElevationM, 1);

    // where the crop sits inside the overview (read from the crop's meta.source "crop x=.. y=..")
    const m = /x=(\d+)\s+y=(\d+)/.exec(cr.meta.source || '');
    const X0 = m ? +m[1] : Math.round((ORIG_W - Wc) / 2);
    const Y0 = m ? +m[2] : Math.round((ORIG_H - Hc) / 2);
    const ox = (X0 + (Wc - 1) / 2 - (ORIG_W - 1) / 2) * cc;
    const oz = (Y0 + (Hc - 1) / 2 - (ORIG_H - 1) / 2) * cc;
    const dy = cr.meta.minElevationM - ov.meta.minElevationM; // crop heights are relative to its own minimum

    // bilinear sample of the overview in world meters
    const sampleOv = (wx, wz) => {
      const fx = Math.min(Math.max(wx / co + (Wo - 1) / 2, 0), Wo - 1.001);
      const fz = Math.min(Math.max(wz / co + (Ho - 1) / 2, 0), Ho - 1.001);
      const x0 = Math.floor(fx), z0 = Math.floor(fz), tx = fx - x0, tz = fz - z0;
      const h = (xx, zz) => ov.heights[zz * Wo + xx];
      return (h(x0, z0) * (1 - tx) + h(x0 + 1, z0) * tx) * (1 - tz)
           + (h(x0, z0 + 1) * (1 - tx) + h(x0 + 1, z0 + 1) * tx) * tz;
    };

    // blend the crop's border into the overview so the two meshes meet without a crack
    for (let i = 0; i < cr.heights.length; i++) {
      const x = i % Wc, z = (i / Wc) | 0;
      const edge = Math.min(x, Wc - 1 - x, z, Hc - 1 - z) * cc;
      if (edge >= BLEND_M) continue;
      const w = smooth(edge / BLEND_M);
      const target = sampleOv(ox + (x - (Wc - 1) / 2) * cc, oz + (z - (Hc - 1) / 2) * cc);
      const cur = cr.heights[i] + dy;
      cr.heights[i] = target + (cur - target) * w - dy;
    }

    const hw = ((Wc - 1) * cc) / 2, hh = ((Hc - 1) * cc) / 2;
    const hole = { x0: ox - hw, x1: ox + hw, z0: oz - hh, z1: oz + hh };

    // far terrain: pushed back slightly in depth so the sharp crop always wins where they overlap
    const farMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1,
      polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
    });
    const nearMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });

    this.far = makeMesh({ heights: ov.heights, W: Wo, H: Ho, cell: co, ox: 0, oz: 0, dy: 0, range, hole, material: farMat });
    this.near = makeMesh({ heights: cr.heights, W: Wc, H: Hc, cell: cc, ox, oz, dy, range, hole: null, material: nearMat });
    this.ctx.scene.add(this.far, this.near);

    // gameplay terrain = the sharp crop (world coordinates now include the crop's offset)
    const clamp = (v, max) => Math.min(Math.max(Math.round(v), 0), max);
    const heights = cr.heights;
    const terrain = {
      id: cr.meta.id, width: Wc, height: Hc, cellSize: cc, heights,
      minElevationM: cr.meta.minElevationM, maxElevationM: cr.meta.maxElevationM,
      heightAt: (gx, gz) => heights[clamp(gz, Hc - 1) * Wc + clamp(gx, Wc - 1)],
      gridToWorld: (gx, gz) => ({
        x: ox + (gx - (Wc - 1) / 2) * cc,
        y: (heights[clamp(gz, Hc - 1) * Wc + clamp(gx, Wc - 1)] + dy) * EXAGGERATION,
        z: oz + (gz - (Hc - 1) / 2) * cc,
      }),
    };
    this.ctx.state.set('terrain', terrain);
    this.ctx.bus.emit(EVENTS.TERRAIN_READY, terrain);
  }

  dispose() {
    super.dispose();
    for (const m of [this.far, this.near]) {
      if (!m) continue;
      this.ctx.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
  }
}
