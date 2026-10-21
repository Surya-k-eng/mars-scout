import * as THREE from 'three';
import { Module } from '../../core/Module.js';

// Atmosphere: sky dome, stars, fog and sun/sky lighting, ported from the team's atmosphereTest.
// It only touches the scene (fog, lights, sky). It does not move the camera and does not draw terrain.
// World axes (same as WorldModule): +x east, +z south, +y up. Azimuth 0 = north, 90 = east.

const DEFAULT_PRESET = 'noon';
const KEYS_ENABLED = true;      // true: keys 1-5 switch presets (noon, day, sunset, dust, night) for testing
const FOG_SCALE = 0.001;         // team's densities were tuned for a ~100 m scene; the terrain here is tens of km
const SUN_DISTANCE = 100000;     // metres; the sun is a directional light, this only sets its direction
const STAR_RADIUS = 400000;      // must stay below the camera far plane (500000) and far outside the terrain
const EASE = 2.2;                // how fast the atmosphere eases between presets

const C = (hex) => new THREE.Color(hex);

const DAY = {
  zenith: C(0xb5805d), horizon: C(0xdcae88), glow: C(0xffe2bd), glowStrength: 0.8,
  fog: C(0xd0a07a), fogDensity: 0.011,
  sun: C(0xffe6c8), sunLight: C(0xffd9b0), sunIntensity: 2.8,
  hemiSky: C(0xd9a27c), hemiGround: C(0x6a3a2a), hemiIntensity: 0.9,
  elev: 30, azim: -35, lightElev: 30,
  dust: 0.1, stars: 0, exposure: 1.0,
  text: 'Day: butterscotch sky, pale haze at the horizon and a small, bright sun with a soft halo.',
};

export const PRESETS = {
  // noon = the team's day look with the sun high overhead
  noon: { ...DAY, elev: 65, lightElev: 65, text: 'Noon: the day sky with the sun high overhead.' },
  day: DAY,
  sunset: {
    zenith: C(0x4a3a47), horizon: C(0x8f7366), glow: C(0x7db3ff), glowStrength: 1.9,
    fog: C(0x7a6a72), fogDensity: 0.014,
    sun: C(0xcfe2ff), sunLight: C(0xffa878), sunIntensity: 2.2,
    hemiSky: C(0x6f86b0), hemiGround: C(0x3a2a2a), hemiIntensity: 0.6,
    elev: 3, azim: -30, lightElev: 3,
    dust: 0.15, stars: 0.08, exposure: 1.0,
    text: 'Sunset: the signature Martian blue glow around the sun, with long shadows and a dusky brown sky.',
  },
  dust: {
    zenith: C(0x9a7a62), horizon: C(0xb9987e), glow: C(0xe3c8aa), glowStrength: 0.5,
    fog: C(0xb8957a), fogDensity: 0.035,
    sun: C(0xe8d0b6), sunLight: C(0xd9b99c), sunIntensity: 1.1,
    hemiSky: C(0xc9a68a), hemiGround: C(0x7d5844), hemiIntensity: 1.35,
    elev: 24, azim: -35, lightElev: 24,
    dust: 1.0, stars: 0, exposure: 0.95,
    text: 'Dust storm: heavy haze, a barely visible sun and flat light.',
  },
  night: {
    zenith: C(0x04060f), horizon: C(0x1b1b2a), glow: C(0x4a5a8a), glowStrength: 0.25,
    fog: C(0x13141f), fogDensity: 0.014,
    sun: C(0x8995b5), sunLight: C(0x8f9fd0), sunIntensity: 0.35,
    hemiSky: C(0x2a3358), hemiGround: C(0x15121a), hemiIntensity: 0.35,
    elev: -14, azim: -35, lightElev: 38,
    dust: 0.05, stars: 1, exposure: 1.1,
    text: 'Night: a thin atmosphere lets the stars through. The terrain is lit only by faint bluish light.',
  },
};

const COLOR_KEYS = ['zenith', 'horizon', 'glow', 'fog', 'sun', 'sunLight', 'hemiSky', 'hemiGround'];
const NUM_KEYS = ['glowStrength', 'fogDensity', 'sunIntensity', 'hemiIntensity',
  'elev', 'azim', 'lightElev', 'dust', 'stars', 'exposure'];

const dirFromAngles = (elevDeg, azimDeg, out) => {
  const e = THREE.MathUtils.degToRad(elevDeg);
  const a = THREE.MathUtils.degToRad(azimDeg);
  return out.set(Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a));
};

export class AtmosphereModule extends Module {
  static id = 'atmosphere';

  async init() {
    const { scene, renderer } = this.ctx;
    this.alive = true;

    // remember what we change so dispose() can put it back
    this.prev = { fog: scene.fog, background: scene.background, exposure: renderer?.toneMappingExposure };
    scene.background = null;                                 // the sky dome is the background
    scene.fog = new THREE.FogExp2(0xd0a07a, 0.011 * FOG_SCALE);

    this.group = new THREE.Group();

    // ---- sky dome ----
    // The vertex shader uses only the camera's rotation, so the dome never needs to follow the camera,
    // and z = w pins it to the far plane (terrain always draws in front of it).
    this.skyUniforms = {
      uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() }, uSun: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uGlowStrength: { value: 1 }, uDust: { value: 0 },
    };
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 24),
      new THREE.ShaderMaterial({
        uniforms: this.skyUniforms,
        side: THREE.BackSide, depthWrite: false, fog: false,
        vertexShader: /* glsl */`
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
            gl_Position.z = gl_Position.w;
          }
        `,
        fragmentShader: /* glsl */`
          uniform vec3 uZenith, uHorizon, uGlow, uSun, uSunDir;
          uniform float uGlowStrength, uDust;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            float h = clamp(d.y, 0.0, 1.0);
            vec3 col = mix(uHorizon, uZenith, pow(h, 0.45));

            // Mars' fine dust scatters light forward: a wide soft halo plus a tight bright core
            float s = max(dot(d, normalize(uSunDir)), 0.0);
            float glow = pow(s, 6.0) * 0.35 + pow(s, 40.0) * 0.9 + pow(s, 400.0) * 2.0;
            col += uGlow * glow * uGlowStrength * (1.0 - 0.5 * uDust);

            // Sun disc (Mars' sun looks about 2/3 the size of Earth's)
            float disc = smoothstep(0.99988, 0.99994, s);
            col += uSun * disc * 3.0 * (1.0 - uDust * 0.85);

            // Suspended dust flattens everything toward the horizon colour
            col = mix(col, uHorizon, exp(-h * 14.0) * 0.55);
            col = mix(col, uHorizon, uDust * 0.7);

            gl_FragColor = vec4(col, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
      })
    );
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    this.group.add(this.sky);

    // ---- stars (fade in at night) ----
    // Placed very far away so the terrain, which is much closer, hides them below the horizon.
    const N = 1800, sp = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const theta = Math.random() * Math.PI * 2, phi = Math.acos(Math.random() * 0.98 + 0.02);
      sp[i * 3] = STAR_RADIUS * Math.sin(phi) * Math.cos(theta);
      sp[i * 3 + 1] = STAR_RADIUS * Math.cos(phi);
      sp[i * 3 + 2] = STAR_RADIUS * Math.sin(phi) * Math.sin(theta);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({
      color: 0xdfe6ff, size: 1.6, sizeAttenuation: false,
      transparent: true, opacity: 0, depthWrite: false, fog: false,
    }));
    this.stars.frustumCulled = false;
    this.stars.onBeforeRender = (r, s, cam) => { this.stars.position.copy(cam.position); this.stars.updateMatrixWorld(); };
    this.group.add(this.stars);

    // ---- lights ----
    this.hemi = new THREE.HemisphereLight(0xd9a27c, 0x6a3a2a, 0.9);
    this.sunLight = new THREE.DirectionalLight(0xffd9b0, 2.8);
    this.sunLight.target.position.set(0, 0, 0);               // world origin = HiRISE centre
    this.group.add(this.hemi, this.sunLight, this.sunLight.target);

    scene.add(this.group);

    // ---- state ----
    this.live = {};
    for (const k of COLOR_KEYS) this.live[k] = new THREE.Color();
    for (const k of NUM_KEYS) this.live[k] = 0;
    this.sunDir = new THREE.Vector3();
    this.lightDir = new THREE.Vector3();

    this.api = {
      presets: PRESETS,
      get current() { return api_current(); },
      setPreset: (name, snap = false) => this.setPreset(name, snap),
    };
    const api_current = () => this.name;
    this.ctx.state?.set('atmosphere', this.api);

    this.setPreset(DEFAULT_PRESET, true);

    if (KEYS_ENABLED) {
      const order = ['noon', 'day', 'sunset', 'dust', 'night'];
      this.onKey = (e) => { const n = order[Number(e.key) - 1]; if (n) this.setPreset(n); };
      window.addEventListener('keydown', this.onKey);
    }

    this.last = performance.now();
    const tick = (now) => {
      if (!this.alive) return;
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min((now - this.last) / 1000, 0.05);
      this.last = now;
      this.ease(1 - Math.exp(-dt * EASE));
      this.apply();
    };
    this.raf = requestAnimationFrame(tick);
  }

  setPreset(name, snap = false) {
    if (!PRESETS[name]) { console.warn('[atmosphere] unknown preset', name); return; }
    this.name = name;
    this.target = PRESETS[name];
    if (snap) { this.ease(1); this.apply(); }
  }

  ease(k) {
    for (const key of COLOR_KEYS) this.live[key].lerp(this.target[key], k);
    for (const key of NUM_KEYS) this.live[key] += (this.target[key] - this.live[key]) * k;
  }

  apply() {
    const s = this.live, u = this.skyUniforms, scene = this.ctx.scene;
    dirFromAngles(s.elev, s.azim, this.sunDir);
    dirFromAngles(s.lightElev, s.azim, this.lightDir);

    u.uZenith.value.copy(s.zenith); u.uHorizon.value.copy(s.horizon);
    u.uGlow.value.copy(s.glow); u.uSun.value.copy(s.sun);
    u.uSunDir.value.copy(this.sunDir);
    u.uGlowStrength.value = s.glowStrength; u.uDust.value = s.dust;

    if (scene.fog) { scene.fog.color.copy(s.fog); scene.fog.density = s.fogDensity * FOG_SCALE; }

    this.sunLight.color.copy(s.sunLight);
    this.sunLight.intensity = s.sunIntensity;
    this.sunLight.position.copy(this.sunLight.target.position).addScaledVector(this.lightDir, SUN_DISTANCE);

    this.hemi.color.copy(s.hemiSky); this.hemi.groundColor.copy(s.hemiGround);
    this.hemi.intensity = s.hemiIntensity;

    this.stars.material.opacity = s.stars;
    this.stars.visible = s.stars > 0.01;

    if (this.ctx.renderer) this.ctx.renderer.toneMappingExposure = s.exposure;
  }

  dispose() {
    super.dispose();
    this.alive = false;
    cancelAnimationFrame(this.raf);
    if (this.onKey) window.removeEventListener('keydown', this.onKey);
    const { scene, renderer } = this.ctx;
    if (this.group) {
      scene.remove(this.group);
      this.sky.geometry.dispose(); this.sky.material.dispose();
      this.stars.geometry.dispose(); this.stars.material.dispose();
    }
    if (this.prev) {
      scene.fog = this.prev.fog;
      scene.background = this.prev.background;
      if (renderer && this.prev.exposure !== undefined) renderer.toneMappingExposure = this.prev.exposure;
    }
  }
}
