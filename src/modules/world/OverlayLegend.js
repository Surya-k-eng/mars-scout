// OverlayLegend.js: a small "layers" icon that opens a panel to switch data layers on and off.
//
//  - Lives in its own Shadow DOM, so the app's CSS cannot change it and it cannot change the app's CSS.
//  - Starts as a 40 px round icon. It picks a spot on the screen edge that does not overlap any other button,
//    toolbar or fixed panel, and moves again if something appears there later.
//  - Drag the icon anywhere to pin it; the position is remembered.
//  - Each row: checkbox, colour swatch (a dot for points, the real colour ramp for map layers), name.
//
// The host (WorldModule) must provide:
//   await host.legendData()                  -> [{ title, note, exclusive?, opacity?, items: [{ kind, id, label, gradient?, color?, count?, on }] }]
//   await host.setLegendItem(kind, id, on)   -> true if applied
//   host.setOverlayOpacity(0..1)
//
// A section is "exclusive" by default: ticking one map layer unticks the others in that section (the shader draws
// one map at a time). Give a section `exclusive: false` if the host can really draw several at once.
//
// Usage: const legend = new OverlayLegend(host);  legend.show(false) hides it;  legend.refresh() re-reads the host
// (call it after the host changes a layer by itself, e.g. the O key);  legend.dispose() removes it.

const ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/></svg>`;

const CSS = `
:host { all: initial; }
.wrap { position: relative; width: 100%; height: 100%; box-sizing: border-box; color: #e9edf3;
  font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.icon { width: 100%; height: 100%; padding: 0; border-radius: 50%; display: grid; place-items: center; cursor: grab;
  color: #fff; background: rgba(16,20,28,.84); border: 1px solid rgba(255,255,255,.28);
  box-shadow: 0 2px 10px rgba(0,0,0,.45); backdrop-filter: blur(6px); touch-action: none; user-select: none; }
.icon:hover { background: rgba(34,44,62,.94); }
.icon.open { background: #2a6df4; border-color: #7fa8ff; }
.badge { position: absolute; top: -4px; right: -4px; min-width: 17px; height: 17px; padding: 0 4px; box-sizing: border-box;
  border-radius: 9px; background: #2a6df4; color: #fff; font-size: 10px; line-height: 17px; text-align: center;
  pointer-events: none; display: none; }
.badge.on { display: block; }
.panel { position: absolute; display: none; width: 268px; max-width: calc(100vw - 24px); overflow: auto; box-sizing: border-box;
  padding: 10px 12px 12px; border-radius: 12px; background: rgba(16,20,28,.95); border: 1px solid rgba(255,255,255,.15);
  box-shadow: 0 8px 28px rgba(0,0,0,.55); backdrop-filter: blur(8px); }
.panel.show { display: block; }
.panel.up { bottom: calc(100% + 8px); } .panel.down { top: calc(100% + 8px); }
.panel.l { left: 0; } .panel.r { right: 0; }
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.head b { font-size: 14px; }
.link { background: none; border: 0; padding: 2px 4px; color: #8db4ff; font: inherit; cursor: pointer; border-radius: 4px; }
.link:hover { background: rgba(255,255,255,.08); }
.sec { margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.1); }
.head + .sec { border-top: 0; margin-top: 4px; padding-top: 0; }
.sec h4 { margin: 0 0 2px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #aab4c4; font-weight: 600; }
.note { margin: 0 0 4px; font-size: 11px; color: #8a95a8; }
.row { display: flex; align-items: center; gap: 8px; padding: 4px 2px; border-radius: 6px; cursor: pointer; }
.row:hover { background: rgba(255,255,255,.06); }
.row input { margin: 0; width: 15px; height: 15px; accent-color: #4da3ff; cursor: pointer; flex: none; }
.sw { flex: none; width: 44px; height: 10px; border-radius: 5px; border: 1px solid rgba(255,255,255,.3); }
.sw.dot { width: 12px; height: 12px; border-radius: 50%; margin: 0 16px 0 16px; border-color: rgba(0,0,0,.8); }
.lab { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cnt { flex: none; color: #8a95a8; font-size: 11px; }
.opac { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.1);
  font-size: 11px; color: #aab4c4; }
.opac input { flex: 1; accent-color: #4da3ff; }
[hidden] { display: none !important; }
.det { margin: 2px 0 8px 23px; padding: 7px 9px; border-radius: 8px; background: rgba(255,255,255,.05); font-size: 11.5px; color: #c9d1de; }
.det p { margin: 0 0 6px; }
.det .cov { color: #8a95a8; font-style: italic; }
.bar { height: 10px; border-radius: 5px; border: 1px solid rgba(255,255,255,.3); }
.scale { display: flex; justify-content: space-between; margin-top: 2px; font-size: 10.5px; color: #8a95a8; }
.ents { max-height: 200px; overflow: auto; margin-top: 4px; padding-right: 2px; }
.grp { margin: 7px 0 2px; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: #aab4c4; font-weight: 600; }
.ent { display: flex; align-items: flex-start; gap: 6px; padding: 1px 0; font-size: 11px; line-height: 1.3; }
.ent i { flex: none; width: 10px; height: 10px; margin-top: 2px; border-radius: 2px; border: 1px solid rgba(255,255,255,.35); }
`;

// Choose where the icon goes: walk the screen edges (right edge, left edge, bottom, top) and take the first spot
// that overlaps none of the obstacle rectangles. Pure function so it can be tested without a browser.
export function pickSlot(obstacles, vw, vh, size = 40, margin = 12, pad = 8) {
  const xr = Math.max(margin, vw - size - margin), yb = Math.max(margin, vh - size - margin);
  const free = (x, y) => !obstacles.some((r) =>
    x < r.right + pad && x + size > r.left - pad && y < r.bottom + pad && y + size > r.top - pad);
  const step = 12, walks = [];
  const down = (a, b) => { const o = []; for (let v = a; v >= b; v -= step) o.push(v); return o; };
  walks.push(down(yb, margin).map((y) => [xr, y]));          // right edge, bottom to top
  walks.push(down(yb, margin).map((y) => [margin, y]));      // left edge, bottom to top
  walks.push(down(xr, margin).map((x) => [x, yb]));          // bottom edge, right to left
  walks.push(down(xr, margin).map((x) => [x, margin]));      // top edge, right to left
  for (const w of walks) for (const [x, y] of w) if (free(x, y)) return { x, y, clash: false };
  return { x: xr, y: yb, clash: true };                      // nothing free: bottom-right; the user can drag it
}

export class OverlayLegend {
  constructor(host, opts = {}) {
    this.host = host;
    this.o = { size: 40, margin: 12, z: 30, storageKey: 'overlayLegend', restore: true, ...opts };
    this.sections = [];
    this.rows = new Map();                 // "kind:id" -> { item, input, sec }
    this.isOpen = false;
    this.hidden = false;
    this.x = 0; this.y = 0;
    this.mt = null;                        // pending "step aside" check (throttle, never reset while waiting)
    const st = this.read();
    this.pinned = st.pinned || null;
    this.saved = st.on || {};
    this.opacity = typeof st.opacity === 'number' ? st.opacity : 1;
    this.build();
    this.refresh();
  }

  // ---- saved state (best effort: storage may be blocked) --------------------------------------------------------
  read() { try { return JSON.parse(localStorage.getItem(this.o.storageKey) || '{}'); } catch { return {}; } }
  write() {
    const on = {};
    for (const [k, r] of this.rows) if (r.item.on) on[k] = true;
    try { localStorage.setItem(this.o.storageKey, JSON.stringify({ pinned: this.pinned, on, opacity: this.opacity })); } catch { /* ignore */ }
  }

  // ---- DOM --------------------------------------------------------------------------------------------------------
  build() {
    const { size, z } = this.o;
    this.el = document.createElement('div');
    this.el.setAttribute('data-overlay-legend', '');
    Object.assign(this.el.style, { position: 'fixed', left: '0px', top: '0px', width: `${size}px`, height: `${size}px`,
      zIndex: String(z), display: 'none' });
    const root = this.el.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><div class="wrap">
      <button class="icon" type="button" aria-label="Map layers" title="Map layers (drag to move)">${ICON}</button>
      <span class="badge"></span>
      <div class="panel up r" role="dialog" aria-label="Map layers"></div></div>`;
    this.icon = root.querySelector('.icon');
    this.badge = root.querySelector('.badge');
    this.panel = root.querySelector('.panel');

    // keep clicks, wheel and keys inside the legend from reaching the 3D scene or the app's hotkeys
    for (const t of ['pointerdown', 'pointerup', 'click', 'dblclick', 'wheel', 'contextmenu', 'keyup']) {
      this.el.addEventListener(t, (e) => e.stopPropagation());
    }
    this.el.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); e.stopPropagation(); });

    let drag = null;
    this.icon.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.icon.setPointerCapture(e.pointerId);
      drag = { sx: e.clientX, sy: e.clientY, x0: this.x, y0: this.y, moved: false };
    });
    this.icon.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      this.moveTo(drag.x0 + dx, drag.y0 + dy);
    });
    this.icon.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      try { this.icon.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (d.moved) { this.pinned = { x: this.x, y: this.y }; this.write(); } else this.toggle();
    });
    this.icon.addEventListener('pointercancel', () => { drag = null; });

    this.onDocDown = () => { if (this.isOpen) this.close(); };      // events from inside never reach the document
    this.onDocKey = (e) => { if (e.key === 'Escape' && this.isOpen) this.close(); };
    this.onResize = () => { clearTimeout(this.rt); this.rt = setTimeout(() => this.place(), 150); };
    document.addEventListener('pointerdown', this.onDocDown);
    document.addEventListener('keydown', this.onDocKey);
    window.addEventListener('resize', this.onResize);

    // When other UI appears or moves later, step aside only if we are now covering something.
    // Throttled: the first change starts one timer; further changes while it waits do NOT restart it,
    // so an app that touches its HUD every frame cannot starve the check.
    this.mo = new MutationObserver((recs) => {
      if (this.pinned || this.hidden || this.mt) return;
      if (recs.every((r) => r.target === this.el || this.el.contains(r.target))) return;
      this.mt = setTimeout(() => { this.mt = null; this.recheck(); }, 1200);
    });
    this.mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });

    document.body.appendChild(this.el);
    this.moveTo(this.o.margin, this.o.margin);
    this.t1 = setTimeout(() => this.place(), 800);                 // let the app's own buttons mount first
    this.t2 = setTimeout(() => this.place(), 3000);
  }

  // ---- placement ---------------------------------------------------------------------------------------------------
  obstacles() {
    const vw = window.innerWidth, vh = window.innerHeight, out = [];
    const skip = new Set(['CANVAS', 'SCRIPT', 'STYLE', 'LINK', 'META', 'HTML', 'BODY', 'HEAD', 'NOSCRIPT']);
    const hit = 'button, a[href], input, select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])';
    for (const el of document.body.querySelectorAll('*')) {
      if (skip.has(el.tagName) || el === this.el || this.el.contains(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      const floating = cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky';
      if (!floating && !el.matches(hit)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;
      if (r.width * r.height > 0.35 * vw * vh) continue;           // full-screen layers are backdrops, not buttons
      out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
    return out;
  }

  moveTo(x, y) {
    const { size } = this.o;
    this.x = Math.min(Math.max(x, 4), Math.max(4, window.innerWidth - size - 4));
    this.y = Math.min(Math.max(y, 4), Math.max(4, window.innerHeight - size - 4));
    this.el.style.left = `${Math.round(this.x)}px`;
    this.el.style.top = `${Math.round(this.y)}px`;
    this.orient();
  }

  place() {
    if (this.hidden) return;
    if (this.pinned) { this.moveTo(this.pinned.x, this.pinned.y); return; }
    const { size, margin } = this.o;
    const s = pickSlot(this.obstacles(), window.innerWidth, window.innerHeight, size, margin);
    this.moveTo(s.x, s.y);
  }

  recheck() {
    const { size } = this.o, pad = 8;
    const clash = this.obstacles().some((r) => this.x < r.right + pad && this.x + size > r.left - pad &&
      this.y < r.bottom + pad && this.y + size > r.top - pad);
    if (clash) this.place();
  }

  // open the panel toward the middle of the screen so it never runs off an edge
  orient() {
    const { size, margin } = this.o;
    const up = this.y > window.innerHeight / 2, right = this.x > window.innerWidth / 2;
    this.panel.classList.toggle('up', up); this.panel.classList.toggle('down', !up);
    this.panel.classList.toggle('r', right); this.panel.classList.toggle('l', !right);
    const avail = up ? this.y - margin - 8 : window.innerHeight - (this.y + size) - margin - 8;
    this.panel.style.maxHeight = `${Math.max(160, Math.floor(avail))}px`;
  }

  // ---- open / close ------------------------------------------------------------------------------------------------
  open() { this.isOpen = true; this.orient(); this.panel.classList.add('show'); this.icon.classList.add('open'); }
  close() { this.isOpen = false; this.panel.classList.remove('show'); this.icon.classList.remove('open'); }
  toggle() { this.isOpen ? this.close() : this.open(); }
  show(on = true) {
    this.hidden = !on;
    this.el.style.display = on && this.sections.length ? '' : 'none';
    if (!on) this.close(); else this.place();
  }

  // ---- content -----------------------------------------------------------------------------------------------------
  // Re-read the host and redraw. Safe to call any time (e.g. after the O key changes the overlay): saved
  // selections are only re-applied the first time.
  async refresh() {
    try { this.sections = (await this.host.legendData()) || []; }
    catch (e) { console.warn('[legend] could not read the layers:', e); this.sections = []; }
    this.render();
    this.el.style.display = this.sections.length && !this.hidden ? '' : 'none';
    if (!this.sections.length) { console.info('[legend] no layer files found in the tiles overlays folder; icon hidden'); return; }
    if (this.o.restore && !this.restored) {
      this.restored = true;
      const todo = [];
      for (const sec of this.sections) {
        const want = [...this.rows.values()].filter((r) => r.sec === sec && this.saved[`${r.item.kind}:${r.item.id}`] && !r.item.on);
        if (sec.exclusive === false) todo.push(...want);
        else if (want.length) todo.push(want[0]);               // exclusive group: restore one, not a race between several
      }
      await Promise.all(todo.map((r) => this.setItem(r, true)));
      this.host.setOverlayOpacity?.(this.opacity);
      const slider = this.panel.querySelector('.opac input'); if (slider) slider.value = String(this.opacity);
    }
    this.place();
  }

  render() {
    this.panel.textContent = '';
    this.rows.clear();
    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

    const head = mk('div', 'head');
    head.append(mk('b', '', 'Layers'));
    const clear = mk('button', 'link', 'Clear all'); clear.type = 'button';
    clear.addEventListener('click', () => { for (const r of this.rows.values()) if (r.item.on) this.setItem(r, false); });
    head.append(clear);
    this.panel.append(head);

    let anyRaster = false;
    for (const sec of this.sections) {
      const box = mk('div', 'sec');
      box.append(mk('h4', '', sec.title));
      if (sec.note) box.append(mk('p', 'note', sec.note));
      for (const item of sec.items) {
        const row = mk('label', 'row');
        const input = mk('input'); input.type = 'checkbox'; input.checked = !!item.on;
        const sw = mk('span', item.kind === 'point' ? 'sw dot' : 'sw');
        if (item.kind === 'point') sw.style.background = item.color; else sw.style.background = item.gradient;
        row.append(input, sw, mk('span', 'lab', item.label));
        if (item.count != null) row.append(mk('span', 'cnt', String(item.count)));
        const rec = { item, input, sec, det: null };
        this.rows.set(`${item.kind}:${item.id}`, rec);
        input.addEventListener('change', () => this.setItem(rec, input.checked));
        box.append(row);
        if (item.info) { rec.det = this.details(item.info, mk); rec.det.hidden = !item.on; box.append(rec.det); }   // explanation, shown while ticked
        if (item.kind === 'raster') anyRaster = true;
      }
      this.panel.append(box);
    }
    if (anyRaster) {
      const op = mk('div', 'opac');
      const s = mk('input'); s.type = 'range'; s.min = '0.2'; s.max = '1'; s.step = '0.05'; s.value = String(this.opacity);
      s.addEventListener('input', () => { this.opacity = Number(s.value); this.host.setOverlayOpacity?.(this.opacity); this.write(); });
      op.append(mk('span', '', 'Map strength'), s);
      this.panel.append(op);
    }
    this.updateBadge();
  }

  // The explanation block under a ticked layer: what it is, where it covers, what the colours mean.
  // info: { what, coverage, gradient + scale: [low, high], entries: [{ color, label, group? }] }
  details(info, mk) {
    const d = mk('div', 'det');
    if (info.what) d.append(mk('p', '', info.what));
    if (info.coverage) d.append(mk('p', 'cov', info.coverage));
    if (info.gradient && info.scale) {
      const bar = mk('div', 'bar'); bar.style.background = info.gradient;
      const sc = mk('div', 'scale'); sc.append(mk('span', '', info.scale[0]), mk('span', '', info.scale[1]));
      d.append(bar, sc);
    }
    if (info.entries?.length) {
      const list = mk('div', 'ents');
      let g = null;
      for (const e of info.entries) {
        if (e.group && e.group !== g) { g = e.group; list.append(mk('div', 'grp', g)); }
        const r = mk('div', 'ent'), chip = mk('i');
        chip.style.background = e.color;
        r.append(chip, mk('span', '', e.label));
        list.append(r);
      }
      d.append(list);
    }
    return d;
  }

  syncDetails() { for (const r of this.rows.values()) if (r.det) r.det.hidden = !r.item.on; }

  async setItem(rec, on) {
    let ok = false;
    try { ok = await this.host.setLegendItem(rec.item.kind, rec.item.id, on); }
    catch (e) { console.warn(`[legend] ${rec.item.id}:`, e); }
    rec.item.on = ok ? on : false;
    rec.input.checked = rec.item.on;
    // exclusive group (default): turning one map on turns the others in that section off
    if (rec.item.on && rec.sec.exclusive !== false) {
      for (const r of this.rows.values()) {
        if (r !== rec && r.sec === rec.sec && r.item.on) { r.item.on = false; r.input.checked = false; }
      }
    }
    this.syncDetails();
    this.updateBadge();
    this.write();
  }

  updateBadge() {
    let n = 0;
    for (const r of this.rows.values()) if (r.item.on) n++;
    this.badge.textContent = String(n);
    this.badge.classList.toggle('on', n > 0);
  }

  dispose() {
    clearTimeout(this.rt); clearTimeout(this.mt); clearTimeout(this.t1); clearTimeout(this.t2);
    this.mt = null;
    this.mo?.disconnect();
    document.removeEventListener('pointerdown', this.onDocDown);
    document.removeEventListener('keydown', this.onDocKey);
    window.removeEventListener('resize', this.onResize);
    this.el?.remove();
  }
}