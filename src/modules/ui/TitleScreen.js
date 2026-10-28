import * as THREE from 'three';
import { Module } from '../../core/Module.js';

/* =====================================================================
   TitleScreen.js
   Title page (MARS) -> "Choose your path" page -> existing Mars Scout map.
   The look (CSS + markup) is copied from the standalone HTML page.
   Sound controls are built in here, so SoundControls.js is no longer needed.

   Put these two files in  public/audio/ :   music.mp3   click.wav
   ===================================================================== */

const MUSIC_URL = '/audio/music.mp3';
const CLICK_URL = '/audio/click.wav';

/* ---------- real Mars sun / sol-time maths (Mars24, Allison & McEwen 2000) ---------- */

const SITE_LAT = 18.48807;   // degrees north
const SITE_LON = 77.40344;   // degrees east

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const mod = (x, n) => ((x % n) + n) % n;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const SOL_DAYS = 1.0274912517;
const PBS = [
  [0.0071, 2.2353, 49.409], [0.0057, 2.7543, 168.173], [0.0039, 1.1177, 191.837],
  [0.0037, 15.7866, 21.736], [0.0021, 2.1354, 15.704], [0.0020, 2.4694, 95.528],
  [0.0018, 32.8493, 49.095],
];

function marsSolarState(ms, latDeg, lonEastDeg) {
  const jdTT = ms / 86400000 + 2440587.5 + 69.184 / 86400;
  const dt = jdTT - 2451545.0;
  const M = mod(19.3871 + 0.52402073 * dt, 360);
  const fms = 270.3863 + 0.52403840 * dt;

  let pbs = 0;
  for (const [A, tau, phi] of PBS) pbs += A * Math.cos((0.985626 * dt / tau + phi) * D2R);

  const eqc =
    (10.691 + 3.0e-7 * dt) * Math.sin(M * D2R) +
    0.623 * Math.sin(2 * M * D2R) +
    0.050 * Math.sin(3 * M * D2R) +
    0.005 * Math.sin(4 * M * D2R) +
    0.0005 * Math.sin(5 * M * D2R) + pbs;

  const ls = mod(fms + eqc, 360);
  const eot = 2.861 * Math.sin(2 * ls * D2R) - 0.071 * Math.sin(4 * ls * D2R) +
    0.002 * Math.sin(6 * ls * D2R) - eqc;
  const msd = (jdTT - 2405522.0028779) / SOL_DAYS;
  const ltst = mod(mod(mod(msd, 1) * 24 + lonEastDeg / 15, 24) + eot / 15, 24);

  const sinLs = Math.sin(ls * D2R);
  const dec = Math.asin(0.42565 * sinLs) * R2D + 0.25 * sinLs;
  const H = (ltst - 12) * 15 * D2R;
  const lat = latDeg * D2R;
  const d = dec * D2R;
  const sinE = Math.sin(lat) * Math.sin(d) + Math.cos(lat) * Math.cos(d) * Math.cos(H);
  const elev = Math.asin(clamp(sinE, -1, 1)) * R2D;

  return { ls, ltst, elev };
}

const fmtHour = (h) => {
  const m = Math.floor(h * 60 + 1e-9) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
};

/* ---------- markup ---------- */

const ICON = {
  explore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
  about: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.5a3 3 0 010 5M18 14.5c1.8.7 3 2.5 3 5.5"/></svg>',
  refs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z"/><path d="M4 21V5M9 8h6M9 12h6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/><path d="M11 8.5v5M8.5 11h5"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
};

const TICKER_ITEMS = [
  'Olympus Mons · 21.9 km high · tallest volcano in the solar system',
  'Valles Marineris · about 4,000 km long',
  'One sol lasts 24 h 39 min',
  'Atmosphere is about 95% carbon dioxide',
  'Surface pressure is under 1% of Earth’s',
  'Two small moons · Phobos &amp; Deimos',
  'Martian sunsets glow blue',
  'A year lasts 687 Earth days',
];
const TICKER_HTML = TICKER_ITEMS.map((t) => '<span>' + t + '</span>').join('');

const TITLE_HTML = `
  <canvas id="mars-title-canvas"></canvas>

  <div class="ttl-root" id="mars-title">
    <header class="ttl-top">
      <div class="ttl-brand"><i></i>Mars Explorer</div>
      <div class="ttl-pills">
        <div class="ttl-pill"><i class="ttl-dot"></i>Live sol time <b id="mars-top-sol">--:--</b></div>
        <div class="ttl-pill">HiRISE terrain</div>
        <div class="ttl-pill">Dust &amp; haze</div>
      </div>
    </header>

    <div class="ttl-eyebrow">Interactive terrain</div>
    <h1 class="ttl-title">MARS</h1>
    <p class="ttl-sub">Explore the surface in HiRISE detail</p>
    <p class="ttl-blurb">A detailed Martian landscape with terrain, atmosphere haze and a slowly revolving camera. Drag to look around and scroll to zoom.</p>
    <div class="ttl-feats"><span>Orbit camera</span><span>Dust &amp; haze</span><span>Free camera</span></div>

    <div class="ttl-menu">
      <button class="ttl-card ttl-hero" id="mars-start">
        <span class="ttl-ico">${ICON.explore}</span>
        <span class="ttl-more">Launch <i>›</i></span>
        <span class="ttl-tx"><span class="ttl-ct">Explore</span><span class="ttl-cd">Fly over the surface and choose your path</span></span>
      </button>
      <button class="ttl-card" id="mars-settings">
        <span class="ttl-ico">${ICON.settings}</span>
        <span class="ttl-more">Tweak <i>›</i></span>
        <span class="ttl-tx"><span class="ttl-ct">Settings</span><span class="ttl-cd">Camera rotation and distance</span></span>
      </button>
      <button class="ttl-card" id="mars-about">
        <span class="ttl-ico">${ICON.about}</span>
        <span class="ttl-more">View more <i>›</i></span>
        <span class="ttl-tx"><span class="ttl-ct">About us</span><span class="ttl-cd">Meet Team Astral Odyssey</span></span>
      </button>
      <button class="ttl-card" id="mars-refs">
        <span class="ttl-ico">${ICON.refs}</span>
        <span class="ttl-more">View more <i>›</i></span>
        <span class="ttl-tx"><span class="ttl-ct">References</span><span class="ttl-cd">Data, papers and tools we relied on</span></span>
      </button>
    </div>

    <aside class="ttl-facts" aria-label="Mars fact file">
      <div class="ttl-eyebrow" style="margin:0">Fact file</div>
      <h2>The Red Planet</h2>
      <p>A cold desert world painted by iron-rich dust. Mars is home to Olympus Mons, the tallest volcano in the solar system, and Valles Marineris, a canyon system that stretches as wide as the continental US.</p>
      <div class="ttl-grid">
        <div class="ttl-stat"><b>Distance from Sun</b><span>227.9<small>million km</small></span></div>
        <div class="ttl-stat"><b>Radius</b><span>3,390<small>km</small></span></div>
        <div class="ttl-stat"><b>Length of day</b><span>24h 39m<small>1 sol</small></span></div>
        <div class="ttl-stat"><b>Length of year</b><span>687<small>Earth days</small></span></div>
        <div class="ttl-stat"><b>Gravity</b><span>3.72<small>m/s²</small></span></div>
        <div class="ttl-stat"><b>Avg. temperature</b><span>−63<small>°C</small></span></div>
      </div>
      <div class="ttl-live"><i class="ttl-dot"></i><span id="mars-live-txt">Site sol time --:--</span></div>
      <div class="ttl-moons"><span>Phobos</span><span>Deimos</span><span>CO₂ atmosphere</span></div>
    </aside>

    <div class="ttl-ticker"><div class="ttl-track">${TICKER_HTML}${TICKER_HTML}</div></div>
  </div>

  <!-- PAGE 2 -->
  <div class="pg-page ttl-hidden" id="mars-page2">
    <button class="pg-back" id="mars-back" aria-label="Back to title"><span class="pg-arr">${ICON.back}</span>Back</button>
    <div class="ttl-eyebrow">Step 2</div>
    <h2 class="pg-title">Choose your path</h2>
    <p class="pg-sub">Three experiences are on the way. Check back soon.</p>
    <div class="pg-grid">
      <button class="ttl-card" id="mars-coordinates">
        <span class="ttl-ico">${ICON.search}</span>
        <span class="ttl-more">Open <i>›</i></span>
        <span class="ttl-tx"><span class="ttl-ct">Search by coordinates</span><span class="ttl-cd">Enter a latitude and longitude on Mars</span></span>
      </button>
      <div class="ttl-card pg-empty" aria-hidden="true"></div>
      <div class="ttl-card pg-empty" aria-hidden="true"></div>
    </div>
  </div>

  <!-- DIALOGS (Settings / About / References) -->
  <div class="ttl-overlay" id="mars-overlay"><div class="ttl-panel" id="mars-panel"></div></div>
`;

const SOUND_HTML = `
<div class="snd-grp" id="marsMusicGrp">
  <button id="marsSndBtn" type="button" aria-pressed="false" aria-label="Turn music on" title="Background music on/off">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path class="wave" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/><path class="mute" d="m16 9 5 6m0-6-5 6"/></svg>
    <span id="marsSndTxt" class="snd-sr">Music off</span>
  </button>
  <input id="marsMusicVol" class="snd-vol" type="range" min="0" max="100" step="1" value="50" aria-label="Music volume" title="Music volume">
  <span id="marsMusicCap" class="snd-cap">Music 50%</span>
</div>
<div class="snd-grp" id="marsClkGrp">
  <button id="marsClkBtn" class="on" type="button" aria-pressed="true" aria-label="Turn click sound off" title="Click sound on/off">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 8l12 4.5-5 1.8-1.8 5L8 8z"/><path class="wave" d="M8 3v2M3 8h2M4.6 4.6l1.4 1.4"/><path class="mute" d="M3 3l18 18"/></svg>
    <span id="marsClkTxt" class="snd-sr">Click sound on</span>
  </button>
  <input id="marsClkVol" class="snd-vol" type="range" min="0" max="100" step="1" value="84" aria-label="Click sound volume" title="Click sound volume">
  <span id="marsClkCap" class="snd-cap">Clicks 84%</span>
</div>
`;

export class TitleScreenModule extends Module {
  static id = 'titleScreen';
  static requires = [];

  async init() {
    this.active = true;
    this.started = false;
    this.page = 'title';
    this.autoRotate = true;
    this.lastSolText = '';

    this.createStyles();
    this.createUI();
    this.createSound();
    this.createMarsScene();

    // Coming back from the map: open on "Choose your path" instead of the first page.
    try {
      if (sessionStorage.getItem('marsScoutStartPage') === '2') {
        sessionStorage.removeItem('marsScoutStartPage');
        this.goPage(2);
      }
    } catch (e) { /* storage not available */ }

    document.body.classList.add('title-open');

    // Hide the existing Mars Scout map while the title screen is open.
    const appCanvas = this.ctx.renderer?.domElement;
    if (appCanvas) {
      appCanvas.dataset.marsScoutOriginalVisibility = appCanvas.style.visibility || '';
      appCanvas.style.visibility = 'hidden';
    }

    this.updateClock();
  }

  /* ============================================================
     STYLES (copied from the standalone HTML page)
     ============================================================ */

  createStyles() {
    if (document.getElementById('mars-scout-title-styles')) return;

    const style = document.createElement('style');
    style.id = 'mars-scout-title-styles';
    style.textContent = `/* ---------- title screen ---------- */
.ttl-root{position:fixed;inset:0;z-index:50;display:flex;flex-direction:column;justify-content:center;
  padding:0 clamp(24px,8vw,120px);color:#f4e9e1;
  background:linear-gradient(90deg,rgba(14,8,6,.82) 0%,rgba(14,8,6,.55) 45%,rgba(14,8,6,0) 80%),
             linear-gradient(0deg,rgba(14,8,6,.6) 0%,rgba(14,8,6,0) 35%);
  transition:opacity .6s ease}
.ttl-root{overflow-y:auto;justify-content:safe center}
.ttl-root.ttl-hidden{opacity:0;pointer-events:none}
.ttl-eyebrow{letter-spacing:.35em;font-size:12px;text-transform:uppercase;color:#e0875a;margin-bottom:10px}
.ttl-title{font-size:clamp(56px,11vw,140px);font-weight:800;letter-spacing:.08em;line-height:1;margin:0}
.ttl-sub{font-size:clamp(14px,1.6vw,20px);opacity:.85;margin:14px 0 36px;max-width:30em}
/* ---------- button dock: one straight row of tiles along the bottom ---------- */
.ttl-menu{position:absolute;left:clamp(24px,8vw,120px);right:clamp(24px,6vw,100px);bottom:54px;z-index:2;
  display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr;gap:14px;counter-reset:ttl}
.ttl-card{position:relative;overflow:hidden;font:inherit;color:#f4e9e1;text-align:left;cursor:pointer;min-height:118px;
  display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto 1fr;gap:10px;align-items:start;padding:15px 16px 14px;
  border:1px solid rgba(255,255,255,.16);border-radius:16px;
  background:linear-gradient(180deg,rgba(255,255,255,.11),rgba(255,255,255,.02));
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  box-shadow:0 10px 30px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.14);
  transition:transform .3s cubic-bezier(.2,.8,.2,1),border-color .3s,box-shadow .3s,background .3s,filter .3s;
  animation:ttl-rise .7s cubic-bezier(.2,.8,.2,1) backwards}
.ttl-card:nth-child(2){animation-delay:.08s}.ttl-card:nth-child(3){animation-delay:.16s}.ttl-card:nth-child(4){animation-delay:.24s}
@keyframes ttl-rise{from{opacity:0;transform:translateY(28px)}}
/* glowing light-bar on the top edge that grows on hover */
.ttl-card::before{content:"";position:absolute;top:0;left:16px;width:34px;height:3px;border-radius:0 0 4px 4px;
  background:#f0a47a;box-shadow:0 0 14px 1px #e0875a;transition:width .45s cubic-bezier(.2,.8,.2,1)}
/* oversized outline number as a background mark */
.ttl-card::after{counter-increment:ttl;content:"0" counter(ttl);position:absolute;right:10px;bottom:-16px;pointer-events:none;
  font:800 78px/1 system-ui,sans-serif;color:transparent;-webkit-text-stroke:1px rgba(255,255,255,.14);transition:-webkit-text-stroke-color .3s,transform .4s}
.ttl-card>*{position:relative;z-index:1}
.ttl-card:hover,.ttl-card:focus-visible{outline:none;transform:translateY(-8px);border-color:rgba(240,164,122,.85);
  background:linear-gradient(180deg,rgba(224,135,90,.32),rgba(224,135,90,.06));
  box-shadow:0 20px 42px rgba(0,0,0,.5),0 0 32px rgba(224,135,90,.38),inset 0 1px 0 rgba(255,255,255,.2)}
.ttl-card:hover::before,.ttl-card:focus-visible::before{width:calc(100% - 32px)}
.ttl-card:hover::after,.ttl-card:focus-visible::after{-webkit-text-stroke-color:rgba(240,164,122,.5);transform:translateY(-6px)}
.ttl-card:active{transform:translateY(-3px)}
.ttl-ico{position:relative;width:38px;height:38px;border-radius:11px;display:grid;place-items:center;color:#1a0e09;
  background:linear-gradient(135deg,#ffc9a3,#e0875a);box-shadow:0 4px 14px rgba(224,135,90,.5);transition:transform .35s cubic-bezier(.2,.8,.2,1)}
.ttl-ico svg{width:20px;height:20px}
.ttl-card:hover .ttl-ico{transform:rotate(-8deg) scale(1.1)}
.ttl-more{justify-self:end;align-self:center;font-size:9.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#f0a47a;
  padding:6px 11px;border:1px solid rgba(240,164,122,.55);border-radius:999px;white-space:nowrap;transition:background .25s,color .25s}
.ttl-more i{font-style:normal;display:inline-block;transition:transform .25s}
.ttl-card:hover .ttl-more{background:#f0a47a;color:#1a0e09}
.ttl-card:hover .ttl-more i{transform:translateX(4px)}
.ttl-tx{grid-column:1/-1;align-self:start;display:block}
.ttl-ct{display:block;font-size:16px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
.ttl-cd{display:block;font-size:11.5px;line-height:1.4;opacity:.72;margin-top:4px;max-width:92%}
/* hero tile: Explore */
.ttl-card.ttl-hero{border-color:rgba(255,200,160,.65);
  background:linear-gradient(110deg,transparent 40%,rgba(255,255,255,.3) 50%,transparent 60%) 200% 0/250% 100% no-repeat,
             linear-gradient(135deg,#e0875a 0%,#b5482a 55%,#6b2a3f 100%);
  box-shadow:0 14px 40px rgba(224,135,90,.42),inset 0 1px 0 rgba(255,255,255,.35);animation:ttl-rise .7s cubic-bezier(.2,.8,.2,1) backwards,ttl-shine 3.8s 1s ease-in-out infinite}
@keyframes ttl-shine{0%,40%{background-position:200% 0,0 0}100%{background-position:-100% 0,0 0}}
.ttl-hero::before{background:#fff;box-shadow:0 0 16px 2px rgba(255,255,255,.8)}
.ttl-hero::after{-webkit-text-stroke-color:rgba(255,255,255,.28);font-size:92px}
.ttl-hero .ttl-ico{width:46px;height:46px;border-radius:50%;color:#fff;
  background:radial-gradient(circle at 34% 28%,#ffc9a3 0%,#d9693f 38%,#7a2a22 78%,#3a1216 100%);box-shadow:0 0 22px rgba(255,170,120,.75),inset -6px -8px 12px rgba(0,0,0,.4)}
.ttl-hero .ttl-ico::after{content:"";position:absolute;inset:-6px;border-radius:50%;border:1px solid rgba(255,255,255,.6);
  border-top-color:transparent;border-bottom-color:transparent;animation:ttl-spin 5s linear infinite}
@keyframes ttl-spin{to{transform:rotate(360deg)}}
.ttl-hero:hover .ttl-ico{transform:scale(1.1)}
.ttl-hero .ttl-ct{font-size:24px;font-weight:800;letter-spacing:.2em}
.ttl-hero .ttl-cd{font-size:12.5px;opacity:.95;color:#fff2e8}
.ttl-hero .ttl-more{background:#fff;color:#a8402a;border-color:#fff;font-weight:800;animation:ttl-glow 2s ease-in-out infinite}
@keyframes ttl-glow{50%{box-shadow:0 0 0 7px rgba(255,255,255,.18)}}
.ttl-card.ttl-hero:hover,.ttl-card.ttl-hero:focus-visible{filter:brightness(1.1);
  background:linear-gradient(110deg,transparent 40%,rgba(255,255,255,.3) 50%,transparent 60%) 200% 0/250% 100% no-repeat,linear-gradient(135deg,#e0875a 0%,#b5482a 55%,#6b2a3f 100%);
  box-shadow:0 22px 48px rgba(224,135,90,.55),inset 0 1px 0 rgba(255,255,255,.4)}
.ttl-hero:hover .ttl-more{background:#fff;color:#a8402a}
@media (prefers-reduced-motion:reduce){.ttl-card,.ttl-hero,.ttl-hero .ttl-more,.ttl-hero .ttl-ico::after{animation:none}}
.ttl-blurb{font-size:12.5px;line-height:1.6;opacity:.7;max-width:34em;margin:-18px 0 26px}
.ttl-warn{display:none;margin-top:22px;max-width:30em;padding:10px 14px;border-radius:6px;font-size:13px;
  color:#ffd9b0;background:rgba(160,60,20,.35);border:1px solid rgba(255,160,100,.5)}


/* ---------- right-hand fact panel ---------- */
.ttl-facts{position:absolute;right:clamp(24px,6vw,100px);top:50%;transform:translateY(-50%);width:min(400px,34vw);
  padding:22px;border-radius:22px;color:#f4e9e1;background:linear-gradient(160deg,rgba(30,14,10,.62),rgba(20,10,8,.42));
  border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  box-shadow:0 14px 44px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.12);animation:ttl-rise .8s .3s cubic-bezier(.2,.8,.2,1) both}
.ttl-facts h2{margin:4px 0 8px;font-size:clamp(22px,2.4vw,30px);letter-spacing:.06em}
.ttl-facts p{margin:0 0 16px;font-size:13px;line-height:1.6;opacity:.8}
.ttl-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ttl-stat{padding:11px 12px;border-radius:14px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.10)}
.ttl-stat b{display:block;font-size:10px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#f0a47a;margin-bottom:4px}
.ttl-stat span{font-size:17px;font-weight:600}
.ttl-stat small{font-size:11px;opacity:.65;font-weight:400;margin-left:3px}
.ttl-live{display:flex;align-items:center;gap:10px;margin-top:12px;padding:10px 12px;border-radius:14px;
  background:rgba(224,135,90,.18);border:1px solid rgba(240,154,110,.45);font:12px/1.4 ui-monospace,Menlo,Consolas,monospace}
.ttl-dot{width:8px;height:8px;border-radius:50%;background:#ff8a5c;box-shadow:0 0 0 0 rgba(255,138,92,.7);animation:ttl-ping 1.8s infinite;flex:none}
@keyframes ttl-ping{70%{box-shadow:0 0 0 10px rgba(255,138,92,0)}100%{box-shadow:0 0 0 0 rgba(255,138,92,0)}}
.ttl-moons{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.ttl-moons span{font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:5px 11px;border-radius:20px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.06)}
.ttl-tag{position:absolute;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#fff2e8;padding:6px 12px;border-radius:20px;
  background:rgba(20,10,8,.45);border:1px solid rgba(255,255,255,.25);backdrop-filter:blur(6px);animation:ttl-float 5s ease-in-out infinite}
.ttl-tag::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#ff8a5c;margin-right:8px;vertical-align:middle}
.ttl-tag.t1{right:clamp(24px,6vw,100px);top:11%}
.ttl-tag.t2{right:clamp(220px,26vw,520px);bottom:11%;animation-delay:-2.5s}
@keyframes ttl-float{50%{transform:translateY(-8px)}}
@media (max-width:1000px){.ttl-facts,.ttl-tag{display:none}}
@media (max-height:820px){
  .ttl-title{font-size:clamp(48px,min(11vw,15vh),120px)}
  .ttl-sub{margin:8px 0 20px}.ttl-blurb{display:none}
  .ttl-menu{gap:12px}.ttl-card{padding:8px 12px}.ttl-card.ttl-hero{padding:10px 14px}
  .ttl-cd{font-size:10px}.ttl-facts{padding:16px}.ttl-facts p{margin-bottom:12px}.ttl-tabs{display:none}}


/* keep the fact panel fully on screen on short windows */
.ttl-facts{max-height:calc(100vh - 48px);overflow-y:auto;scrollbar-width:thin}
@media (max-height:900px){
  .ttl-facts{width:min(440px,36vw);padding:14px 16px}
  .ttl-facts h2{font-size:22px;margin:2px 0 6px}
  .ttl-facts p{font-size:12px;line-height:1.5;margin-bottom:10px}
  .ttl-grid{grid-template-columns:repeat(3,1fr);gap:7px}
  .ttl-stat{padding:8px 9px;border-radius:11px}
  .ttl-stat b{font-size:8.5px;letter-spacing:.1em;margin-bottom:2px}
  .ttl-stat span{font-size:14px}.ttl-stat small{display:block;margin:1px 0 0;font-size:10px}
  .ttl-live{margin-top:8px;padding:7px 10px;font-size:11px}
  .ttl-moons{margin-top:8px;gap:6px}.ttl-moons span{font-size:10px;padding:4px 9px}
  .ttl-tag.t2{display:none}.ttl-tag.t1{top:6%}
}
@media (max-height:700px){.ttl-facts p{display:none}.ttl-moons{display:none}}


/* ---------- filled page: top bar, feature pills, ticker ---------- */
.ttl-root{padding-top:78px;padding-bottom:215px}
.ttl-top{position:absolute;top:0;left:0;right:0;height:66px;display:flex;align-items:center;justify-content:space-between;
  padding:0 clamp(24px,6vw,100px) 0 clamp(24px,8vw,120px);background:linear-gradient(180deg,rgba(14,8,6,.7),transparent)}
.ttl-brand{display:flex;align-items:center;gap:12px;font-size:12px;font-weight:700;letter-spacing:.32em;text-transform:uppercase}
.ttl-brand i{width:24px;height:24px;border-radius:50%;background:radial-gradient(circle at 34% 28%,#ffc9a3,#d9693f 40%,#5a1f1a);box-shadow:0 0 16px rgba(224,135,90,.8)}
.ttl-pills{display:flex;gap:10px}
.ttl-pill{display:flex;align-items:center;gap:8px;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;padding:7px 13px;border-radius:20px;
  background:rgba(20,10,8,.45);border:1px solid rgba(255,255,255,.2);backdrop-filter:blur(8px)}
.ttl-pill b{color:#f0a47a;font-weight:700;font-variant-numeric:tabular-nums}
.ttl-pill .ttl-dot{width:7px;height:7px}
.ttl-feats{display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 0;max-width:34em}
.ttl-feats span{font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:6px 12px;border-radius:20px;border:1px solid rgba(240,164,122,.4);background:rgba(224,135,90,.10)}
.ttl-blurb{margin:-18px 0 18px}
.ttl-facts{top:84px;transform:none;max-height:calc(100vh - 84px - 215px)}
.ttl-ticker{position:absolute;left:0;right:0;bottom:0;height:34px;overflow:hidden;display:flex;align-items:center;
  background:rgba(14,8,6,.78);border-top:1px solid rgba(255,255,255,.12)}
.ttl-track{display:flex;flex:none;white-space:nowrap;animation:ttl-scroll 70s linear infinite}
.ttl-track span{font-size:10.5px;letter-spacing:.22em;text-transform:uppercase;opacity:.8;padding-right:28px}
.ttl-track span::after{content:"✦";color:#e0875a;padding-left:28px}
@keyframes ttl-scroll{to{transform:translateX(-50%)}}
@media (max-height:820px){
  .ttl-root{padding-top:70px;padding-bottom:190px}
  .ttl-menu{bottom:48px}.ttl-card{min-height:98px;padding:12px 14px 11px}.ttl-cd{font-size:10.5px}
  .ttl-ico{width:32px;height:32px}.ttl-ico svg{width:17px;height:17px}.ttl-hero .ttl-ico{width:40px;height:40px}
  .ttl-ct{font-size:14px}.ttl-hero .ttl-ct{font-size:20px}.ttl-card::after{font-size:62px}
  .ttl-facts{top:74px;max-height:calc(100vh - 74px - 190px)}.ttl-feats{display:none}}
@media (max-width:1000px){.ttl-pill:not(:first-child){display:none}}
@media (max-width:900px){
  .ttl-root{padding-top:76px;padding-bottom:60px}
  .ttl-menu{position:static;grid-template-columns:1fr 1fr;margin-top:22px}
  .ttl-hero,.ttl-card:last-child{grid-column:1/-1}.ttl-card{min-height:104px}}

/* ---------- panels ---------- */
.ttl-overlay{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;
  background:rgba(8,5,4,.6);backdrop-filter:blur(3px);padding:16px;color:#f4e9e1}
.ttl-overlay.ttl-open{display:flex}
.ttl-panel{width:min(560px,100%);max-height:85vh;overflow:auto;background:#1b1210;
  border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:22px 24px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.ttl-panel h2{margin:0 0 14px;font-size:22px;letter-spacing:.08em;text-transform:uppercase}
.ttl-panel h3{margin:18px 0 6px;font-size:13px;letter-spacing:.2em;text-transform:uppercase;color:#e0875a}
.ttl-panel p{line-height:1.55;opacity:.9;margin:0 0 10px}
.ttl-panel.ttl-wide{width:min(740px,100%)}
.ttl-lead{opacity:.7;margin:-6px 0 8px}
.ttl-ref{padding:20px 0;border-bottom:1px solid rgba(255,255,255,.10)}
.ttl-ref:last-of-type{border-bottom:0}
.ttl-ref-kind{position:absolute;left:10px;top:10px;font-size:10px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#1a0e09;background:linear-gradient(135deg,#ffc9a3,#e0875a);padding:4px 10px;border-radius:20px}
.ttl-panel h4{margin:0 0 6px;font-size:16px;letter-spacing:.03em}
.ttl-ref p{margin:0 0 10px;font-size:13.5px;line-height:1.6;opacity:.85}
.ttl-ref-img{position:relative;aspect-ratio:16/8;border-radius:12px;overflow:hidden;margin-bottom:14px;border:1px solid rgba(255,255,255,.14);background:#120b09}
.ttl-ref-img svg,.ttl-ref-img img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.ttl-ref-img.ttl-photo{aspect-ratio:auto;background:#120b09}
.ttl-ref-img.ttl-photo img{position:static;height:auto;max-height:340px;object-fit:contain;margin:0 auto}
.ttl-cap{position:absolute;right:10px;bottom:8px;z-index:2;font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding:3px 9px;border-radius:20px;background:rgba(14,8,6,.65);color:#f4e9e1}
.ttl-panel h5{margin:14px 0 4px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#e0875a}
.ttl-ref h4{font-size:19px}
.ttl-ref-facts{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.ttl-ref-facts span{font-size:11px;padding:4px 10px;border-radius:20px;border:1px solid rgba(240,164,122,.4);background:rgba(224,135,90,.10)}
.ttl-ref-links{display:flex;flex-direction:column;gap:4px}
.ttl-ref-links a{font-size:13px;word-break:normal}
.ttl-panel .ttl-ref-cite{font-size:12px;opacity:.6;margin:8px 0 0;font-style:italic}
.ttl-panel a{color:#f0a47a;word-break:break-all}
.ttl-tagline{font-size:17px;font-weight:600;color:#f0a47a;opacity:1!important;margin:-4px 0 14px!important}
.ttl-panel .ttl-motto{margin:16px 0 4px;font-size:18px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#f0a47a;opacity:1}
.ttl-sign{margin-top:22px;padding-top:16px;border-top:1px solid rgba(255,255,255,.12)}
.ttl-sign b{display:block;font-size:16px;letter-spacing:.14em;text-transform:uppercase}
.ttl-sign em{display:block;margin-top:4px;opacity:.75}
.ttl-panel ul{padding-left:18px;margin:0}
.ttl-panel li{margin-bottom:10px;line-height:1.45}
.ttl-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.08)}
.ttl-row label{font-size:14px}
.ttl-sec{margin:20px 0 0;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#e0875a}
.ttl-row.ttl-snd{display:grid;grid-template-columns:150px 1fr 44px 20px;gap:14px}
.ttl-row.ttl-snd input[type=range]{max-width:none;width:100%}
.ttl-pct{min-width:40px;text-align:right;font-size:13px;opacity:.8;font-variant-numeric:tabular-nums}
.ttl-row input[type=range]{flex:1;max-width:240px;accent-color:#e0875a}
.ttl-row input[type=checkbox]{width:18px;height:18px;accent-color:#e0875a}
.ttl-chips{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.ttl-chip{font:inherit;font-size:13px;cursor:pointer;padding:5px 10px;color:#f4e9e1;background:transparent;
  border:1px solid rgba(255,255,255,.3);border-radius:5px}
.ttl-chip.ttl-active{background:#e0875a;border-color:#e0875a;color:#1a0e09;font-weight:700}
.ttl-note{font-size:12px;opacity:.65;margin-top:10px}
.ttl-close{margin-top:18px;min-width:0}

.snd-grp{position:fixed;top:14px;left:14px;z-index:9999;width:64px;display:flex;flex-direction:column;align-items:center;gap:5px}
#marsClkGrp{top:108px}
#marsSndBtn,#marsClkBtn{width:44px;height:44px;padding:0;display:grid;place-items:center;
  border-radius:50%;cursor:pointer;color:#f4e9e1;background:rgba(20,10,8,.55);border:1px solid rgba(255,255,255,.28);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  transition:background .2s,border-color .2s,color .2s,box-shadow .2s,transform .2s}
#marsSndBtn:hover,#marsClkBtn:hover{background:rgba(60,30,20,.75);border-color:#f0a47a;transform:scale(1.06)}
#marsSndBtn:focus-visible,#marsClkBtn:focus-visible{outline:2px solid #f0a47a;outline-offset:3px}
#marsSndBtn svg,#marsClkBtn svg{width:20px;height:20px;display:block}
#marsSndBtn.on,#marsClkBtn.on{color:#1a0e09;background:linear-gradient(135deg,#ffc9a3,#e0875a);border-color:#f0a47a;box-shadow:0 0 18px rgba(224,135,90,.55)}
#marsSndBtn .wave,#marsClkBtn .wave{display:none}#marsSndBtn.on .wave,#marsClkBtn.on .wave{display:inline}#marsSndBtn.on .mute,#marsClkBtn.on .mute{display:none}
#marsSndBtn.err,#marsClkBtn.err{opacity:.5}
.snd-vol{width:58px;height:16px;margin:0;padding:0;cursor:pointer;accent-color:#e0875a}
.snd-cap{font:11px/1 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.04em;color:#f4e9e1;
  text-shadow:0 1px 3px rgba(0,0,0,.75);white-space:nowrap;user-select:none}
.snd-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
/* ---------- extra pages (2 = mission select, 3 = map) ---------- */
.pg-page{position:fixed;inset:0;z-index:50;display:flex;flex-direction:column;justify-content:safe center;overflow-y:auto;
  padding:78px clamp(24px,8vw,120px) 48px;color:#f4e9e1;
  background:linear-gradient(90deg,rgba(14,8,6,.82) 0%,rgba(14,8,6,.55) 55%,rgba(14,8,6,.25) 100%),
             linear-gradient(0deg,rgba(14,8,6,.6) 0%,rgba(14,8,6,0) 35%);
  transition:opacity .6s ease,visibility 0s}
.pg-page.ttl-hidden{opacity:0;pointer-events:none;visibility:hidden;transition:opacity .6s ease,visibility 0s .6s}
.pg-title{font-size:clamp(34px,6vw,76px);font-weight:800;letter-spacing:.08em;line-height:1.05;margin:0 0 10px}
.pg-sub{font-size:clamp(14px,1.5vw,18px);opacity:.85;margin:0 0 30px;max-width:34em}
.pg-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;counter-reset:ttl;margin-bottom:26px}
.pg-grid .ttl-card{min-height:150px;cursor:default}
.pg-soon{opacity:.6}
.pg-back{position:absolute;top:18px;left:clamp(24px,8vw,120px);z-index:3;display:inline-flex;align-items:center;gap:10px;
  font:inherit;font-size:11px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#f4e9e1;cursor:pointer;
  padding:9px 18px 9px 10px;border-radius:999px;border:1px solid rgba(240,164,122,.55);
  background:linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,.03));
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  box-shadow:0 8px 22px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.14);
  transition:transform .3s cubic-bezier(.2,.8,.2,1),background .3s,color .3s,box-shadow .3s,border-color .3s}
.pg-back .pg-arr{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;color:#1a0e09;
  background:linear-gradient(135deg,#ffc9a3,#e0875a);box-shadow:0 3px 10px rgba(224,135,90,.5);transition:transform .3s}
.pg-back .pg-arr svg{width:14px;height:14px}
.pg-back:hover,.pg-back:focus-visible{outline:none;transform:translateX(-3px);color:#1a0e09;border-color:#f0a47a;background:#f0a47a;
  box-shadow:0 10px 26px rgba(224,135,90,.45)}
.pg-back:hover .pg-arr,.pg-back:focus-visible .pg-arr{transform:translateX(-3px);background:#fff;color:#a8402a}
.pg-back:active{transform:translateX(-1px)}
.pg-empty{border-style:dashed;opacity:.4;pointer-events:none;box-shadow:none;background:rgba(255,255,255,.02)}
.pg-empty::before,.pg-empty::after{display:none}
@media (max-width:800px){.pg-grid{grid-template-columns:1fr}}

/* ---------- module wrapper ---------- */
#mars-title-layer{position:fixed;inset:0;z-index:10000;overflow:hidden;background:#120b08;color:#f4e9e1;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
#mars-title-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.snd-grp{z-index:10001}
.mars-map-back{position:fixed;top:18px;left:92px;z-index:10002;background:rgba(20,10,8,.78)}
.mars-map-back:hover,.mars-map-back:focus-visible{background:#f0a47a}
@media (max-width:600px){.ttl-feats,.ttl-more{display:none}.ttl-pills{display:none}}
.mars-close-btn{font:inherit;font-size:12px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#f4e9e1;cursor:pointer;
  padding:9px 22px;border-radius:999px;border:1px solid rgba(240,164,122,.55);
  background:linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,.03));transition:background .25s,color .25s}
.mars-close-btn:hover,.mars-close-btn:focus-visible{outline:none;background:#f0a47a;color:#1a0e09}

#mars-title-layer,#mars-title-layer *,.snd-grp,.snd-grp *{box-sizing:content-box}
`;
    document.head.appendChild(style);
  }

  /* ============================================================
     UI
     ============================================================ */

  createUI() {
    const layer = document.createElement('div');
    layer.id = 'mars-title-layer';
    layer.innerHTML = TITLE_HTML;
    document.body.appendChild(layer);

    this.layer = layer;
    this.titleEl = layer.querySelector('#mars-title');
    this.page2 = layer.querySelector('#mars-page2');
    this.overlay = layer.querySelector('#mars-overlay');
    this.panel = layer.querySelector('#mars-panel');

    const on = (id, fn) => layer.querySelector(id).addEventListener('click', fn);

    on('#mars-start', () => this.goPage(2));
    on('#mars-back', () => this.goPage(1));
    on('#mars-coordinates', () => this.enterMarsScout());
    on('#mars-settings', () => this.showSettings());
    on('#mars-about', () => this.showAbout());
    on('#mars-refs', () => this.showReferences());

    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.closeDialog();
    });

    this.escHandler = (event) => {
      if (event.key === 'Escape') this.closeDialog();
    };
    window.addEventListener('keydown', this.escHandler);
  }

  goPage(n) {
    this.closeDialog();
    this.page = n === 1 ? 'title' : 'page2';
    this.titleEl.classList.toggle('ttl-hidden', n !== 1);
    this.page2.classList.toggle('ttl-hidden', n !== 2);
  }

  /* ============================================================
     SOUND (music + click sound, top-left controls)
     ============================================================ */

  createSound() {
    // Remove leftovers of older sound markup so the controls never appear twice.
    ['musicGrp', 'clkGrp', 'mars-snd-wrap'].forEach((id) => document.getElementById(id)?.remove());

    const wrap = document.createElement('div');
    wrap.id = 'mars-snd-wrap';
    wrap.innerHTML = SOUND_HTML;
    document.body.appendChild(wrap);
    this.soundWrap = wrap;

    const $ = (id) => wrap.querySelector('#' + id);
    const btn = $('marsSndBtn'), txt = $('marsSndTxt');
    const cbtn = $('marsClkBtn'), ctxt = $('marsClkTxt');
    const mv = $('marsMusicVol'), cv = $('marsClkVol');
    const mcap = $('marsMusicCap'), ccap = $('marsClkCap');

    const vg = (v) => {
      v = Math.max(0, Math.min(100, +v || 0)) / 100;
      return v * v;                                   // slider % -> gain (perceptual curve)
    };

    let ctx = null, mGain = null, sGain = null;
    let music = null, click = null, src = null;
    let want = false, loadingM = false, loadedS = false, clicksOn = true;

    const showVol = () => {
      mcap.textContent = 'Music ' + mv.value + '%';
      ccap.textContent = 'Clicks ' + cv.value + '%';
    };
    const ui = (on) => {
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.setAttribute('aria-label', on ? 'Turn music off' : 'Turn music on');
      txt.textContent = on ? 'Music on' : 'Music off';
    };
    const cui = (on) => {
      cbtn.classList.toggle('on', on);
      cbtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      cbtn.setAttribute('aria-label', on ? 'Turn click sound off' : 'Turn click sound on');
      ctxt.textContent = on ? 'Click sound on' : 'Click sound off';
    };

    const decode = (url, ok, bad) => {
      fetch(url)
        .then((r) => { if (!r.ok) throw new Error(url); return r.arrayBuffer(); })
        .then((buf) => {
          let p = null;
          try { p = ctx.decodeAudioData(buf); } catch (e) { /* old callback API */ }
          if (p && p.then) p.then(ok, bad);
          else { try { ctx.decodeAudioData(buf, ok, bad); } catch (e) { bad(); } }
        })
        .catch(() => bad());
    };

    const ensureCtx = () => {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        ctx = new AC();
        mGain = ctx.createGain(); mGain.gain.value = vg(mv.value); mGain.connect(ctx.destination);
        sGain = ctx.createGain(); sGain.gain.value = vg(cv.value); sGain.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
      if (!loadedS) {
        loadedS = true;
        decode(CLICK_URL, (b) => { click = b; }, () => {});
      }
      return true;
    };

    const playClick = () => {
      if (!click || !clicksOn) return;
      const s = ctx.createBufferSource();
      s.buffer = click;
      s.connect(sGain);
      s.start(0);
    };

    const startMusic = () => {
      if (!want || !music) return;
      if (src) { try { src.stop(); } catch (e) { /* already stopped */ } }
      src = ctx.createBufferSource();
      src.buffer = music;
      src.loop = true;
      src.connect(mGain);
      src.start(0);
    };

    const turnOn = () => {
      if (!ensureCtx()) { btn.classList.add('err'); return; }
      want = true; ui(true);
      if (music) { startMusic(); return; }
      if (loadingM) return;
      loadingM = true;
      decode(
        MUSIC_URL,
        (b) => { loadingM = false; music = b; startMusic(); },
        () => {
          loadingM = false; want = false; ui(false);
          btn.classList.add('err');
          btn.title = 'Music could not be loaded';
        }
      );
    };

    const turnOff = () => {
      want = false; ui(false);
      if (src) { try { src.stop(); } catch (e) { /* already stopped */ } src = null; }
    };

    btn.addEventListener('click', () => (want ? turnOff() : turnOn()));
    mv.addEventListener('input', () => { if (mGain) mGain.gain.value = vg(mv.value); showVol(); });
    cv.addEventListener('input', () => { if (sGain) sGain.gain.value = vg(cv.value); showVol(); });
    cv.addEventListener('change', () => { if (clicksOn) { ensureCtx(); playClick(); } });
    cbtn.addEventListener('click', () => {
      clicksOn = !clicksOn; cui(clicksOn);
      if (clicksOn) { ensureCtx(); playClick(); }
    });

    // click sound on every button (when the click sound is on)
    const onDocClick = (e) => {
      const b = e.target.closest && e.target.closest('button');
      if (!b) return;
      ensureCtx();
      playClick();
    };
    const onPointer = () => ensureCtx();
    const onVisibility = () => {
      if (!ctx) return;
      if (document.hidden) ctx.suspend(); else ctx.resume();
    };

    document.addEventListener('click', onDocClick, true);
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('visibilitychange', onVisibility);

    ui(false); cui(true); showVol();
    ensureCtx();   // decode the click sound early so the first click is not silent

    this.soundCleanup = () => {
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('visibilitychange', onVisibility);
      if (src) { try { src.stop(); } catch (e) { /* already stopped */ } }
      if (ctx) ctx.close?.();
      wrap.remove();
    };
  }

  /* ============================================================
     3D MARS TERRAIN
     ============================================================ */

  createMarsScene() {
    const canvas = this.layer.querySelector('#mars-title-canvas');
    this.canvas = canvas;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x160b07, 1);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0xc68d6d, 0.00007);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(60, 1, 10, 500000);
    this.camera = camera;

    /* ---------------- Terrain ---------------- */

    const TERRAIN_SIZE = 14000;
    const SEGMENTS = 180;

    const hash = (x, z) => {
      let n = Math.imul(x, 374761393) + Math.imul(z, 668265263) + 7 * 1442695041;
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
    };

    const noise = (x, z) => {
      const ix = Math.floor(x);
      const iz = Math.floor(z);
      const fx = x - ix;
      const fz = z - iz;
      const u = fx * fx * (3 - 2 * fx);
      const v = fz * fz * (3 - 2 * fz);
      const a = hash(ix, iz);
      const b = hash(ix + 1, iz);
      const c = hash(ix, iz + 1);
      const d = hash(ix + 1, iz + 1);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    };

    const fbm = (x, z) => {
      let value = 0;
      let amplitude = 0.5;
      let frequency = 1;
      for (let i = 0; i < 6; i++) {
        value += amplitude * noise(x * frequency, z * frequency);
        amplitude *= 0.5;
        frequency *= 2;
      }
      return value;
    };

    const craters = [];
    let seed = 91;

    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let i = 0; i < 30; i++) {
      const r = 180 + Math.pow(random(), 2.2) * 1500;
      craters.push({
        x: (random() - 0.5) * TERRAIN_SIZE,
        z: (random() - 0.5) * TERRAIN_SIZE,
        r,
        depth: r * 0.13,
      });
    }

    const heightAt = (x, z) => {
      let y = 900 * (fbm(x / 5000 + 11.3, z / 5000 + 4.7) - 0.45);
      y += 60 * (noise(x / 120, z / 120) - 0.5);

      for (const crater of craters) {
        const d = Math.hypot(x - crater.x, z - crater.z) / crater.r;
        if (d < 2.2) {
          if (d < 1) y -= crater.depth * (1 - d * d);
          y += crater.depth * 0.32 * Math.exp(-Math.pow((d - 1) / 0.16, 2));
        }
      }
      return y;
    };

    const geometry = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, SEGMENTS, SEGMENTS);
    geometry.rotateX(-Math.PI / 2);

    const position = geometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      position.setY(i, heightAt(position.getX(i), position.getZ(i)));
    }
    geometry.computeVertexNormals();

    /* ---------------- Terrain colours ---------------- */

    const colors = new Float32Array(position.count * 3);
    const low = new THREE.Color(0x5e3324);
    const mid = new THREE.Color(0xa05a39);
    const high = new THREE.Color(0xc9976a);
    const temp = new THREE.Color();
    const normal = geometry.attributes.normal;

    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);

      let t = (y + 450) / 900;
      t = Math.max(0, Math.min(1, t));

      if (t < 0.5) temp.copy(low).lerp(mid, t * 2);
      else temp.copy(mid).lerp(high, (t - 0.5) * 2);

      const slope = 1 - normal.getY(i);
      const shade =
        (0.88 + 0.24 * noise(x / 70, z / 70)) *
        (1 - Math.min(slope * 0.9, 0.5));

      temp.multiplyScalar(shade);
      temp.convertSRGBToLinear();

      colors[i * 3] = temp.r;
      colors[i * 3 + 1] = temp.g;
      colors[i * 3 + 2] = temp.b;
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const terrain = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 1,
        metalness: 0,
      })
    );
    scene.add(terrain);
    this.terrain = terrain;

    /* ---------------- Sky ---------------- */

    const skyMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(0x9f7055) },
        horizon: { value: new THREE.Color(0xd8a47e) },
      },
      vertexShader: `
        varying vec3 vDirection;
        void main() {
          vDirection = normalize(position);
          gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
          gl_Position.z = gl_Position.w;
        }
      `,
      fragmentShader: `
        uniform vec3 top;
        uniform vec3 horizon;
        varying vec3 vDirection;
        void main() {
          vec3 d = normalize(vDirection);
          float h = clamp(d.y, 0.0, 1.0);
          vec3 color = mix(horizon, top, pow(h, .45));
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });

    const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), skyMaterial);
    sky.frustumCulled = false;
    scene.add(sky);
    this.sky = sky;

    /* ---------------- Stars ---------------- */

    const starCount = 1200;
    const starPositions = new Float32Array(starCount * 3);
    const starRadius = 400000;

    for (let i = 0; i < starCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random());
      starPositions[i * 3] = starRadius * Math.sin(phi) * Math.cos(theta);
      starPositions[i * 3 + 1] = starRadius * Math.cos(phi);
      starPositions[i * 3 + 2] = starRadius * Math.sin(phi) * Math.sin(theta);
    }

    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));

    const stars = new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({
        color: 0xe8ecff,
        size: 1.6,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      })
    );
    stars.frustumCulled = false;
    scene.add(stars);
    this.stars = stars;

    /* ---------------- Lights ---------------- */

    const hemisphere = new THREE.HemisphereLight(0xd9a27c, 0x6a3a2a, 0.55);
    const sun = new THREE.DirectionalLight(0xffd9b0, 1.5);
    sun.position.set(100000, 80000, 100000);
    scene.add(hemisphere, sun);

    this.hemisphere = hemisphere;
    this.sun = sun;

    /* ---------------- Camera ---------------- */

    this.cameraState = {
      theta: 0.6,
      elevation: 0.3,
      radius: 4300,
      target: new THREE.Vector3(0, 150, 0),
      dragging: false,
      lastX: 0,
      lastY: 0,
    };

    this.addCameraControls();

    this.resizeHandler = () => this.resize();
    window.addEventListener('resize', this.resizeHandler);
    this.resize();

    this.sceneReady = true;
  }




  /* ============================================================
     CAMERA (drag to look around, scroll to zoom)
     ============================================================ */

  addCameraControls() {
    const state = this.cameraState;
    const layer = this.layer;

    const free = (target) =>
      !target.closest('button, a, input, label, .ttl-facts, .ttl-panel, .ttl-overlay.ttl-open, .pg-back');

    layer.addEventListener('pointerdown', (event) => {
      if (this.page !== 'title' || !free(event.target)) return;
      state.dragging = true;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      layer.setPointerCapture(event.pointerId);
    });

    layer.addEventListener('pointermove', (event) => {
      if (!state.dragging) return;
      state.theta -= (event.clientX - state.lastX) * 0.005;
      state.elevation = Math.max(
        0.03,
        Math.min(1.2, state.elevation + (event.clientY - state.lastY) * 0.004)
      );
      state.lastX = event.clientX;
      state.lastY = event.clientY;
    });

    const stopDrag = () => { state.dragging = false; };
    layer.addEventListener('pointerup', stopDrag);
    layer.addEventListener('pointercancel', stopDrag);

    layer.addEventListener(
      'wheel',
      (event) => {
        if (this.page !== 'title') return;
        if (event.target.closest('.ttl-facts, .ttl-panel')) return;
        event.preventDefault();
        state.radius = Math.max(
          700,
          Math.min(9000, state.radius * Math.exp(event.deltaY * 0.001))
        );
      },
      { passive: false }
    );
  }

  /* ============================================================
     RESIZE
     ============================================================ */

  resize() {
    if (!this.renderer) return;

    const width = window.innerWidth;
    const height = window.innerHeight;

    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /* ============================================================
     UPDATE
     ============================================================ */

  update(delta) {
    if (!this.active || !this.sceneReady) return;

    const state = this.cameraState;

    if (!state.dragging && this.autoRotate) {
      state.theta += delta * 0.025;
    }

    const ce = Math.cos(state.elevation);

    const x = state.target.x + state.radius * ce * Math.sin(state.theta);
    const z = state.target.z + state.radius * ce * Math.cos(state.theta);
    const y = state.target.y + state.radius * Math.sin(state.elevation);

    this.camera.position.set(x, Math.max(y, 100), z);
    this.camera.lookAt(state.target);

    if (this.renderer) {
      this.renderer.render(this.scene, this.camera);
    }

    this.updateClock();
  }

  /* ============================================================
     LIVE SOL TIME (real Mars solar time at the site)
     ============================================================ */

  updateClock() {
    const sun = marsSolarState(Date.now(), SITE_LAT, SITE_LON);
    const hour = fmtHour(sun.ltst);
    const text =
      'Site sol time ' + hour +
      '  ·  Ls ' + sun.ls.toFixed(0) + '°' +
      '  ·  sun ' + sun.elev.toFixed(0) + '° ' + (sun.elev >= 0 ? 'up' : 'below horizon');

    if (text === this.lastSolText) return;
    this.lastSolText = text;

    const top = this.layer?.querySelector('#mars-top-sol');
    const live = this.layer?.querySelector('#mars-live-txt');
    if (top) top.textContent = hour;
    if (live) live.textContent = text;
  }

  /* ============================================================
     ENTER EXISTING MARS SCOUT MAP
     ============================================================ */

  enterMarsScout() {
    if (this.started) return;
    this.started = true;

    // Stop the title experience.
    this.active = false;

    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
    }
    window.removeEventListener('keydown', this.escHandler);

    // Restore the existing Mars Scout canvas.
    const appCanvas = this.ctx.renderer?.domElement;
    if (appCanvas) {
      appCanvas.style.visibility =
        appCanvas.dataset.marsScoutOriginalVisibility || 'visible';
      delete appCanvas.dataset.marsScoutOriginalVisibility;
    }

    // Remove our title scene and UI (the sound controls stay, so music keeps playing).
    this.disposeMarsScene();
    this.layer.remove();
    document.body.classList.remove('title-open');
    this.createMapBack();

    // Tell the rest of the application that the title screen has finished.
    this.ctx.state.set('mode', 'map');
    this.ctx.bus.emit('title:start');

    console.log('[title] Search by Coordinates selected. Mars Scout map is now active.');
  }

  /* ============================================================
     BACK BUTTON ON THE MAP PAGE
     ============================================================ */

  createMapBack() {
    document.getElementById('mars-map-back')?.remove();

    const btn = document.createElement('button');
    btn.id = 'mars-map-back';
    btn.className = 'pg-back mars-map-back';
    btn.setAttribute('aria-label', 'Back to Choose your path');
    btn.innerHTML = '<span class="pg-arr">' + ICON.back + '</span>Back';

    btn.addEventListener('click', () => {
      // Reloading resets the map completely, then the title opens on "Choose your path".
      try { sessionStorage.setItem('marsScoutStartPage', '2'); } catch (e) { /* ignore */ }
      window.location.reload();
    });

    document.body.appendChild(btn);
    this.mapBackBtn = btn;
  }

  /* ============================================================
     DIALOGS
     ============================================================ */

  openDialog() {
    this.overlay.classList.add('ttl-open');
  }

  closeDialog() {
    this.overlay?.classList.remove('ttl-open');
  }

  showSettings() {
    this.panel.className = 'ttl-panel';
    this.panel.innerHTML = `
      <h2>Settings</h2>
      <p class="ttl-lead">Adjust the title-screen camera. The map has its own controls.</p>
      <div class="ttl-row">
        <label for="mars-rot">Slowly rotate the view</label>
        <input id="mars-rot" type="checkbox" ${this.autoRotate ? 'checked' : ''}>
      </div>
      <div class="ttl-row">
        <label for="mars-dist">Camera distance</label>
        <input id="mars-dist" type="range" min="1200" max="7000" value="${Math.round(this.cameraState.radius)}">
      </div>
      <button class="mars-close-btn ttl-close" id="mars-close">Close</button>
    `;

    const rot = this.panel.querySelector('#mars-rot');
    rot.addEventListener('change', () => { this.autoRotate = rot.checked; });

    const dist = this.panel.querySelector('#mars-dist');
    dist.addEventListener('input', () => { this.cameraState.radius = Number(dist.value); });

    this.panel.querySelector('#mars-close').addEventListener('click', () => this.closeDialog());
    this.openDialog();
  }

  showAbout() {
    this.panel.className = 'ttl-panel';
    this.panel.innerHTML = `
      <h2>About us</h2>
      <p class="ttl-tagline">🚀 Team Astral Odyssey</p>
      <p>
        Astral Odyssey is a team passionate about space, technology and exploration.
        We created <strong>Mars Scout</strong> to make Mars exploration more interactive,
        informative and accessible.
      </p>
      <p>
        Our project brings together planetary information and terrain data to help users
        explore the Martian surface.
      </p>
      <h3>Our mission</h3>
      <p>
        Explore Mars, understand its terrain, investigate mineral information,
        identify potential hazards and plan routes through one interactive platform.
      </p>
      <h3>Our vision</h3>
      <p class="ttl-motto">Explore. Discover. Understand.</p>
      <div class="ttl-sign">
        <b>Team Astral Odyssey</b>
        <em>Creativity, engineering and technology, building Mars Scout.</em>
      </div>
      <button class="mars-close-btn ttl-close" id="mars-close">Close</button>
    `;

    this.panel.querySelector('#mars-close').addEventListener('click', () => this.closeDialog());
    this.openDialog();
  }

  showReferences() {
    this.panel.className = 'ttl-panel ttl-wide';
    this.panel.innerHTML = `
      <h2>References</h2>
      <p class="ttl-lead">Data, papers and tools we relied on.</p>

      <div class="ttl-ref">
        <h4>HiRISE</h4>
        <p>High Resolution Imaging Science Experiment provides extremely detailed images of Mars from the Mars Reconnaissance Orbiter.</p>
      </div>
      <div class="ttl-ref">
        <h4>CRISM</h4>
        <p>Compact Reconnaissance Imaging Spectrometer for Mars helps identify minerals from orbit.</p>
      </div>
      <div class="ttl-ref">
        <h4>MOLA</h4>
        <p>Mars Orbiter Laser Altimeter provides Mars elevation and topographic information.</p>
      </div>
      <div class="ttl-ref">
        <h4>USGS</h4>
        <p>Geological maps provide information about Martian surface units and geological history.</p>
      </div>
      <div class="ttl-ref">
        <h4>Three.js</h4>
        <p>Used to create the interactive 3D visualization in the browser.</p>
      </div>

      <button class="mars-close-btn ttl-close" id="mars-close">Close</button>
    `;

    this.panel.querySelector('#mars-close').addEventListener('click', () => this.closeDialog());
    this.openDialog();
  }

  /* ============================================================
     DISPOSE
     ============================================================ */

  disposeMarsScene() {
    if (this.renderer) this.renderer.dispose();

    if (this.terrain) {
      this.terrain.geometry?.dispose();
      this.terrain.material?.dispose();
    }

    if (this.sky) {
      this.sky.geometry?.dispose();
      this.sky.material?.dispose();
    }

    if (this.stars) {
      this.stars.geometry?.dispose();
      this.stars.material?.dispose();
    }

    this.sceneReady = false;
  }

  dispose() {
    this.active = false;

    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
    }
    window.removeEventListener('keydown', this.escHandler);

    this.disposeMarsScene();
    this.layer?.remove();
    this.soundCleanup?.();
    this.mapBackBtn?.remove();

    document.body.classList.remove('title-open');

    const appCanvas = this.ctx.renderer?.domElement;
    if (appCanvas) {
      appCanvas.style.visibility =
        appCanvas.dataset.marsScoutOriginalVisibility || 'visible';
    }

    super.dispose();
  }
}