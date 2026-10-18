import * as THREE from 'three';
import { Module } from '../../core/Module.js';
import { EVENTS } from '../../core/events.js';

// Display-only vertical exaggeration. Slope math should use terrain.heights (raw metres).
const VERT_EXAG = 4;

export class TerrainModule extends Module {
  static id = 'terrain';

  async init() {
    const base = `${import.meta.env.BASE_URL}data/jezero/`;

    const metaRes = await fetch(base + 'meta.json');
    if (!metaRes.ok) throw new Error(`terrain meta.json not found (${metaRes.status})`);
    const meta = await metaRes.json();

    const binRes = await fetch(base + 'heights.f32');
    if (!binRes.ok) throw new Error(`terrain heights.f32 not found (${binRes.status})`);
    const buf = await binRes.arrayBuffer();

    const W = meta.width, H = meta.height, cell = meta.cellSize;
    if (buf.byteLength !== W * H * 4) {
      throw new Error(`heights.f32 is ${buf.byteLength} bytes, expected ${W * H * 4}`);
    }
    const heights = new Float32Array(buf);          // raw elevation in metres
    const minE = meta.minElevationM, maxE = meta.maxElevationM;
    const span = Math.max(maxE - minE, 1e-6);

    // Mesh: Y is shifted so the lowest point sits at 0, then exaggerated for display
    const geo = new THREE.PlaneGeometry((W - 1) * cell, (H - 1) * cell, W - 1, H - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const h = heights[i];
      pos.setY(i, (h - minE) * VERT_EXAG);
      // low = dark brown, high = light tan, so subtle relief is visible
      c.setHSL(0.06, 0.45, 0.22 + 0.35 * ((h - minE) / span));
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })
    );
    this.ctx.scene.add(this.mesh);

    const clamp = (v, max) => Math.min(Math.max(Math.round(v), 0), max);
    const terrain = {
      id: meta.id,
      width: W,
      height: H,
      cellSize: cell,
      heights,                       // raw metres, use this for slope and cost
      minElevationM: minE,
      maxElevationM: maxE,
      vertExag: VERT_EXAG,
      heightAt: (gx, gz) => heights[clamp(gz, H - 1) * W + clamp(gx, W - 1)],   // raw metres
      gridToWorld: (gx, gz) => ({
        x: (gx - (W - 1) / 2) * cell,
        y: (heights[clamp(gz, H - 1) * W + clamp(gx, W - 1)] - minE) * VERT_EXAG,
        z: (gz - (H - 1) / 2) * cell,
      }),
    };

    this.ctx.state.set('terrain', terrain);
    this.ctx.bus.emit(EVENTS.TERRAIN_READY, terrain);
  }

  dispose() {
    super.dispose();
    if (!this.mesh) { return; }
    this.ctx.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}