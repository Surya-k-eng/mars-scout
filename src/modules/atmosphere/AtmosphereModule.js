import * as THREE from 'three';
import { Module } from '../../core/Module.js';

// Atmosphere: sky dome, stars, fog and sun/sky lighting, ported from the team's atmosphereTest.
// The sun is now driven by a real Mars solar position (calculation included below) at the map's site,
// and the look blends automatically from the sun's elevation.
// It only touches the scene (fog, lights, sky). It does not move the camera and does not draw terrain.
// World axes (same as WorldModule): +x east, +z south, +y up. Azimuth 0 = north, 90 = east.

// ======================= Mars sun calculation =======================
// After the Mars24 algorithm (Allison & McEwen 2000).
// marsSolarState(ms, latDeg, lonEastDeg) -> { ls, ltst, elev, azim, dec }
//   ls = season (areocentric solar longitude), ltst = local true solar time in hours,
//   elev = sun elevation (deg), azim = sun azimuth (deg from north, 90 = east), dec = declination (deg)
const mod = (x, n) => ((x % n) + n) % n;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const SOL_DAYS = 1.0274912517;               // one Mars solar day, in Earth days
const SOL_MS = SOL_DAYS * 86400000;
const MARS_HOUR_MS = SOL_MS / 24;            // 1/24 of a sol
const TT_MINUS_UTC_S = 69.184;                      // 37 leap seconds + 32.184 s

// Planetary perturbers: amplitude (deg), period (years), phase (deg)
const PBS = [
  [0.0071, 2.2353, 49.409], [0.0057, 2.7543, 168.173], [0.0039, 1.1177, 191.837],
  [0.0037, 15.7866, 21.736], [0.0021, 2.1354, 15.704], [0.0020, 2.4694, 95.528],
  [0.0018, 32.8493, 49.095],
];

function marsSolarState(ms, latDeg, lonEastDeg) {
  const jdTT = ms / 86400000 + 2440587.5 + TT_MINUS_UTC_S / 86400;
  const dt = jdTT - 2451545.0;                                    // days since J2000

  const M = mod(19.3871 + 0.52402073 * dt, 360);                  // mean anomaly
  const fms = 270.3863 + 0.52403840 * dt;                         // fictitious mean sun angle
  let pbs = 0;
  for (const [A, tau, phi] of PBS) pbs += A * Math.cos((0.985626 * dt / tau + phi) * D2R);
  const eqc = (10.691 + 3.0e-7 * dt) * Math.sin(M * D2R)          // equation of centre
    + 0.623 * Math.sin(2 * M * D2R) + 0.050 * Math.sin(3 * M * D2R)
    + 0.005 * Math.sin(4 * M * D2R) + 0.0005 * Math.sin(5 * M * D2R) + pbs;

  const ls = mod(fms + eqc, 360);
  const eot = 2.861 * Math.sin(2 * ls * D2R) - 0.071 * Math.sin(4 * ls * D2R)
    + 0.002 * Math.sin(6 * ls * D2R) - eqc;                       // equation of time, degrees

  const msd = (jdTT - 2405522.0028779) / SOL_DAYS;                // Mars sol date
  const mtc = mod(msd, 1) * 24;                                   // mean time at the prime meridian
  const lmst = mod(mtc + lonEastDeg / 15, 24);                    // local mean solar time
  const ltst = mod(lmst + eot / 15, 24);                          // local true solar time

  const sinLs = Math.sin(ls * D2R);
  const dec = Math.asin(0.42565 * sinLs) * R2D + 0.25 * sinLs;
  const H = (ltst - 12) * 15 * D2R;                               // hour angle
  const lat = latDeg * D2R, d = dec * D2R;

  const sinE = Math.sin(lat) * Math.sin(d) + Math.cos(lat) * Math.cos(d) * Math.cos(H);
  const elev = Math.asin(Math.max(-1, Math.min(1, sinE))) * R2D;
  const east = -Math.cos(d) * Math.sin(H);
  const north = Math.sin(d) * Math.cos(lat) - Math.cos(d) * Math.sin(lat) * Math.cos(H);
  const azim = mod(Math.atan2(east, north) * R2D, 360);

  return { ls, ltst, elev, azim, dec };
}
// ====================================================================

const DEFAULT_PRESET = 'noon';
const KEYS_ENABLED = true;      // keys 1-5 jump the clock (noon, day, sunset, dust toggle, night); space pauses; [ ] change speed
const FOG_SCALE = 0.001;         // team's densities were tuned for a ~100 m scene; the terrain here is tens of km
const SUN_DISTANCE = 100000;     // metres; the sun is a directional light, this only sets its direction
const STAR_RADIUS = 400000;      // must stay below the camera far plane (500000) and far outside the terrain
const EASE = 2.2;                // how fast the dust storm fades in and out

// ---- Mars site and clock ----
// HiRISE tile centre = world origin (from the Astro cam readout)
const SITE_LAT = 18.48807;       // degrees north
const SITE_LON = 77.40344;       // degrees east
const TIME_SCALE = 120;          // 1 = real time. 120 means one Mars day (24h 39m) takes about 12 real minutes
const START_AT_NOW = true;       // start from the real current Mars date/season; false = fixed date below
const FIXED_START = Date.UTC(2026, 0, 1);

// ---- on-screen panel (time, speed, key feedback) ----
const HUD_ENABLED = true;
const LOG_MS = 8000;             // how long a "what changed" line stays on screen
const HUD_KEYS = [['1', 'Noon'], ['2', 'Day'], ['3', 'Sunset'], ['4', 'Dust'], ['5', 'Night'],
  ['Space', 'Pause'], ['[', 'Slower'], [']', 'Faster']];
const HUD_CSS = `
.atm-hud{position:fixed;left:12px;bottom:12px;z-index:20;pointer-events:none;min-width:270px;
  font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;color:#9fe6a0;background:rgba(20,22,26,.78);
  border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:10px 12px}
.atm-time{font-size:16px;font-weight:700;color:#e8f7e8}
.atm-dim{opacity:.75}
.atm-speed{margin:4px 0 8px;color:#ffd98a}
.atm-keys{display:flex;flex-wrap:wrap;gap:4px}
.atm-key{display:flex;gap:5px;align-items:center;padding:2px 6px;border:1px solid rgba(255,255,255,.2);
  border-radius:5px;transition:background .25s,color .25s}
.atm-key b{color:#e8f7e8}
.atm-key.active{border-color:#9fe6a0}
.atm-key.on{background:#9fe6a0;color:#10151a;transition:none}
.atm-key.on b{color:#10151a}
.atm-log{margin-top:8px;border-top:1px solid rgba(255,255,255,.12);padding-top:6px;min-height:1em}
.atm-log div{opacity:.6}
.atm-log div.new{opacity:1;color:#e8f7e8}
`;
const fmtHour = (h) => {
  const m = Math.floor(h * 60 + 1e-9) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
};
const fmtSpeed = (x) => (x >= 10 ? String(Math.round(x)) : x.toFixed(1)) + '×';
const fmtDur = (sec) => sec >= 3600 ? `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`
  : sec >= 60 ? `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s` : `${sec.toFixed(1)}s`;
const fmtSun = (e) => e >= 0 ? `${e.toFixed(0)}° above horizon` : `${(-e).toFixed(0)}° below horizon`;

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
// elev / azim / lightElev come from the sun calculation, everything else is blended
const BLEND_NUM = NUM_KEYS.filter((k) => !['elev', 'azim', 'lightElev'].includes(k));

// Automatic blending: which preset look applies at which sun elevation (degrees).
// Below the first stop it is full night, above the last it is full noon.
const ELEV_STOPS = [
  { e: -8, p: 'night' },
  { e: 3, p: 'sunset' },
  { e: 30, p: 'day' },
  { e: 65, p: 'noon' },
];

const smooth = (x) => x * x * (3 - 2 * x);

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

    // ---- Mars sun clock ----
    this.site = { lat: SITE_LAT, lon: SITE_LON };
    this.simMs = START_AT_NOW ? Date.now() : FIXED_START;     // simulated Earth-UTC time
    this.timeScale = TIME_SCALE;
    this.paused = false;
    this.dustMix = 0;
    this.dustTarget = 0;
    this.sun = marsSolarState(this.simMs, this.site.lat, this.site.lon);

    const self = this;
    this.api = {
      presets: PRESETS,
      get current() { return self.name; },
      get paused() { return self.paused; },
      get sun() { return self.sun; },                          // { ls, ltst, elev, azim, dec }
      setPreset: (name, snap = false) => this.setPreset(name, snap),
      setLocalHour: (h) => this.jumpToLocalHour(h),            // 0..24 local true solar time
      setSpeed: (x) => { this.timeScale = x; },                // 1 = real time
      setSite: (lat, lon) => { this.site = { lat, lon }; },    // lat N, lon E, degrees
      setDate: (ms) => { this.simMs = ms; },                   // Unix ms
      pause: () => { this.paused = true; },
      resume: () => { this.paused = false; },
      setDustStorm: (on) => { this.dustTarget = on ? 1 : 0; },
    };
    this.ctx.state?.set('atmosphere', this.api);

    this.setPreset(DEFAULT_PRESET, true);

    if (HUD_ENABLED) { this.buildHud(); this.updateHud(); }

    if (KEYS_ENABLED) {
      this.onKey = (e) => this.handleKey(e);
      window.addEventListener('keydown', this.onKey);
    }

    // ---- animation loop ----
    this.last = performance.now();
    const tick = (now) => {
      if (!this.alive) return;
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min((now - this.last) / 1000, 0.05);
      this.last = now;
      if (!this.paused) this.simMs += dt * 1000 * this.timeScale;
      this.dustMix += (this.dustTarget - this.dustMix) * (1 - Math.exp(-dt * EASE));
      this.sample();
      this.apply();
      this.updateHud();
    };
    this.raf = requestAnimationFrame(tick);
  }

  // keys 1-5 / api: move the clock to a preset's moment (dust toggles the storm overlay)
  setPreset(name, snap = false) {
    if (!PRESETS[name]) { console.warn('[atmosphere] unknown preset', name); return; }
    this.name = name;
    if (name === 'dust') {
      this.dustTarget = this.dustTarget ? 0 : 1;
      if (snap) this.dustMix = this.dustTarget;
    } else {
      if (name === 'noon') this.jumpToLocalHour(12);
      else if (name === 'night') this.jumpToLocalHour(0);
      else if (name === 'day') this.jumpToElevation(PRESETS.day.elev, true) || this.jumpToLocalHour(10);
      else if (name === 'sunset') this.jumpToElevation(PRESETS.sunset.elev, false) || this.jumpToLocalHour(17.5);
      this.dustTarget = 0;
      if (snap) this.dustMix = 0;
    }
    if (snap) { this.sample(); this.apply(); }
  }

  // advance the clock to the next time the local true solar time equals h
  jumpToLocalHour(h) {
    const cur = marsSolarState(this.simMs, this.site.lat, this.site.lon).ltst;
    this.simMs += mod(h - cur, 24) * MARS_HOUR_MS;
  }

  // advance the clock to the next time the sun crosses `target` degrees (rising or setting).
  // returns false if it never does at this site/season (e.g. polar night)
  jumpToElevation(target, rising) {
    const step = MARS_HOUR_MS * 0.05;
    const { lat, lon } = this.site;
    let prev = marsSolarState(this.simMs, lat, lon).elev;
    for (let i = 1; i <= 480; i++) {                      // scan one sol
      const ms = this.simMs + i * step;
      const e = marsSolarState(ms, lat, lon).elev;
      if (rising ? (prev < target && e >= target) : (prev > target && e <= target)) {
        this.simMs = ms;
        return true;
      }
      prev = e;
    }
    return false;
  }

  // fill this.live from the sun: angles from the Mars calculation, look blended by elevation, dust overlaid
  sample() {
    const s = this.live;
    const sun = this.sun = marsSolarState(this.simMs, this.site.lat, this.site.lon);

    // automatic blend between presets by sun elevation
    const stops = ELEV_STOPS;
    let a, b, k;
    if (sun.elev <= stops[0].e) { a = b = stops[0]; k = 0; }
    else if (sun.elev >= stops[stops.length - 1].e) { a = b = stops[stops.length - 1]; k = 0; }
    else {
      let i = 0;
      while (sun.elev > stops[i + 1].e) i++;
      a = stops[i]; b = stops[i + 1];
      k = smooth((sun.elev - a.e) / (b.e - a.e));
    }
    const pa = PRESETS[a.p], pb = PRESETS[b.p], dust = PRESETS.dust;

    for (const key of COLOR_KEYS) {
      s[key].copy(pa[key]).lerp(pb[key], k).lerp(dust[key], this.dustMix);
    }
    for (const key of BLEND_NUM) {
      const v = pa[key] + (pb[key] - pa[key]) * k;
      s[key] = v + (dust[key] - v) * this.dustMix;
    }

    s.elev = sun.elev;
    s.azim = sun.azim;
    // the light stays just above the horizon at dusk, then hands over to the faint night light
    const night = smooth(THREE.MathUtils.clamp(-sun.elev / 10, 0, 1));
    s.lightElev = THREE.MathUtils.lerp(Math.max(sun.elev, 3), PRESETS.night.lightElev, night);
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

  // ---- keyboard ----
  handleKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    const { lat, lon } = this.site;
    const order = ['noon', 'day', 'sunset', 'dust', 'night'];
    const preset = order[Number(e.key) - 1];
    const keyName = e.key === ' ' ? 'Space' : e.key;

    if (preset) {
      const before = marsSolarState(this.simMs, lat, lon).ltst;
      const dustBefore = this.dustTarget;
      this.setPreset(preset);
      this.flashKey(keyName);
      if (preset === 'dust') {
        this.note(`4  Dust storm: ${dustBefore ? 'ON' : 'OFF'} → ${this.dustTarget ? 'ON' : 'OFF'}`);
      } else {
        const after = marsSolarState(this.simMs, lat, lon);
        const label = preset[0].toUpperCase() + preset.slice(1);
        this.note(`${keyName}  ${label}: time ${fmtHour(before)} → ${fmtHour(after.ltst)}, sun ${fmtSun(after.elev)}`
          + (dustBefore ? ', dust off' : ''));
      }
    } else if (e.key === ' ') {
      this.paused = !this.paused;
      this.flashKey('Space');
      this.note(`Space  Time: ${this.paused ? 'running → PAUSED' : 'paused → RUNNING'}`);
    } else if (e.key === '[' || e.key === ']') {
      const before = this.timeScale;
      this.timeScale = e.key === '[' ? Math.max(1, before / 2) : Math.min(100000, before * 2);
      this.flashKey(e.key);
      this.note(this.timeScale === before
        ? `${e.key}  Speed already at ${e.key === '[' ? 'minimum' : 'maximum'} (${fmtSpeed(before)})`
        : `${e.key}  Speed: ${fmtSpeed(before)} → ${fmtSpeed(this.timeScale)}`);
    }
  }

  // ---- on-screen panel ----
  buildHud() {
    const el = (tag, cls, parent, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      if (parent) parent.appendChild(n);
      return n;
    };
    this.hudStyle = el('style', '', document.head, HUD_CSS);
    const root = this.hud = el('div', 'atm-hud', document.body);
    this.hudTime = el('div', 'atm-time', root);
    this.hudSun = el('div', 'atm-dim', root);
    this.hudSpeed = el('div', 'atm-speed', root);
    const keys = el('div', 'atm-keys', root);
    this.hudKeys = {};
    for (const [k, label] of HUD_KEYS) {
      const chip = el('div', 'atm-key', keys);
      el('b', '', chip, k);
      el('span', '', chip, label);
      this.hudKeys[k] = chip;
    }
    this.hudLog = el('div', 'atm-log', root);
    this.hudCache = {};
    this.hudTimers = {};
    this.logs = [];
  }

  note(text) {
    if (!this.hud) return;
    this.logs.push({ text, t: performance.now() });
    if (this.logs.length > 5) this.logs.shift();
  }

  flashKey(name) {
    const chip = this.hudKeys?.[name];
    if (!chip) return;
    chip.classList.add('on');
    clearTimeout(this.hudTimers[name]);
    this.hudTimers[name] = setTimeout(() => chip.classList.remove('on'), 350);
  }

  updateHud() {
    if (!this.hud) return;
    const s = this.sun, c = this.hudCache;
    const set = (node, key, v) => { if (c[key] !== v) { c[key] = v; node.textContent = v; } };
    const phase = s.elev < -8 ? 'night' : s.elev < 3 ? 'twilight' : 'day';

    set(this.hudTime, 'time', `Sol time ${fmtHour(s.ltst)}  (${phase})`);
    set(this.hudSun, 'sun', `Sun ${s.elev.toFixed(0)}° up · Az ${s.azim.toFixed(0)}° · Ls ${s.ls.toFixed(0)}°`);
    set(this.hudSpeed, 'speed', (this.paused ? '⏸ PAUSED   ' : '▶ ')
      + `speed ${fmtSpeed(this.timeScale)} · 1 sol = ${fmtDur(SOL_MS / 1000 / this.timeScale)}`);

    this.hudKeys['Space'].classList.toggle('active', this.paused);
    this.hudKeys['4'].classList.toggle('active', this.dustTarget > 0);

    const now = performance.now();
    this.logs = this.logs.filter((l) => now - l.t < LOG_MS);
    const html = this.logs.map((l, i) => `<div${i === this.logs.length - 1 ? ' class="new"' : ''}>${l.text}</div>`).join('');
    if (c.log !== html) { c.log = html; this.hudLog.innerHTML = html; }
  }

  dispose() {
    super.dispose();
    this.alive = false;
    cancelAnimationFrame(this.raf);
    if (this.onKey) window.removeEventListener('keydown', this.onKey);
    if (this.hudTimers) Object.values(this.hudTimers).forEach(clearTimeout);
    this.hud?.remove();
    this.hudStyle?.remove();
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
