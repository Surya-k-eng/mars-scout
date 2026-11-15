import { Module } from '../../core/Module.js';   // same relative path MineralSearchModule uses; adjust if needed

// Universal UI layer.
//   Modules do NOT build their own DOM containers / <style> / z-index any more. They call:
//
//     const panel = this.ctx.ui.addPanel({
//       id: 'myPanel',                          // unique; re-adding the same id replaces the old panel
//       title: 'My panel',
//       dock: 'right',                          // 'left' (stacks upward from bottom-left) | 'right' (stacks downward from top-right)
//       visibleWhen: { searchMode: 'targets' }, // optional; shown only while every key matches (searchMode follows bus 'search:mode')
//       collapsed: false,                       // optional
//       build: (body, ui) => { ... },           // fill `body`; ui.el(tag, parent, text, cls) is the DOM helper
//     });
//     panel.show() / panel.hide() / panel.body      and      this.ctx.ui.removePanel('myPanel')
//
//   this.ctx.ui.tooltip()                      returns a styled, hidden, pointer-events:none <div> for cursor-following tips
//                                              (the module sets its innerHTML / left / top / display); removed with ui.dispose()
//   this.ctx.ui.viewFrame()                    returns { el, label }: a white frame + caption to lay over a viewport you render
//                                              yourself (you set el.style left/top/width/height each frame)
//   this.ctx.ui.canvasLayer()                  returns a click-through <canvas> for drawing labels over the 3D view (you size/position it)
//   this.ctx.ui.reserve('right', 'myKey', px)  keeps `px` of that dock's edge free (e.g. under a viewport you draw yourself);
//                                              px = 0 releases it. 'right' reserves from the top, 'left' from the bottom.
//
//   Shared classes for panel content: ui-row, ui-dim, ui-sw, ui-list, ui-item (+ 'sel').
//   Event isolation (keydown/pointerdown/wheel/mousedown) is done once here for every panel.
//
// Register FIRST in src/modules.config.js and list 'ui' in `static requires` of every module that uses it.

const CSS = `
.ui-dock{position:fixed;z-index:1003;display:flex;gap:8px;width:300px;pointer-events:none}
.ui-dock-right{right:12px;top:12px;flex-direction:column}
.ui-dock-left{left:12px;bottom:12px;flex-direction:column-reverse}
.ui-panel{pointer-events:auto;font:12px/1.4 system-ui,sans-serif;color:#eee;background:rgba(20,22,26,.92);
  border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:10px 12px}
.ui-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.ui-head h4{margin:0;font-size:13px}
.ui-head button{margin:0;padding:0 6px;line-height:1.2}
.ui-panel.collapsed .ui-head{margin-bottom:0}
.ui-panel.collapsed .ui-body{display:none}
.ui-panel button{font:inherit;margin:4px 4px 0 0;padding:3px 8px;cursor:pointer}
.ui-panel label{display:flex;align-items:center;gap:6px;margin:2px 0;cursor:pointer}
.ui-panel input[type=number],.ui-panel select{font:inherit;width:70px;background:#111;color:#eee;border:1px solid #444;border-radius:4px;padding:2px 4px}
.ui-row{display:flex;align-items:center;gap:8px;margin:6px 0}
.ui-sw{width:10px;height:10px;border-radius:50%;border:1px solid #000;display:inline-block}
.ui-dim{opacity:.7}
.ui-viewframe{position:fixed;pointer-events:none;box-sizing:border-box;border:2px solid #fff;box-shadow:0 0 14px rgba(0,0,0,.6);
  z-index:10;font:600 11px/1 system-ui,sans-serif;color:#fff}
.ui-viewframe .ui-viewlabel{position:absolute;left:6px;bottom:6px;text-shadow:0 0 4px #000}
.ui-layer{position:fixed;pointer-events:none;z-index:900}
.ui-tip{position:fixed;z-index:9999;display:none;pointer-events:none;padding:5px 9px;background:rgba(16,18,24,.88);color:#fff;
  font:12px/1.35 system-ui,sans-serif;border-radius:6px;border:1px solid rgba(255,255,255,.18);max-width:280px;
  white-space:normal;box-shadow:0 2px 8px rgba(0,0,0,.4)}
.ui-list{max-height:240px;overflow-y:auto;margin-top:6px;border-top:1px solid rgba(255,255,255,.12)}
.ui-item{display:flex;align-items:center;gap:6px;padding:4px 2px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.07)}
.ui-item:hover{background:rgba(255,255,255,.08)}
.ui-item.sel{background:rgba(255,213,74,.18)}
.ui-loading{position:fixed;inset:0;z-index:2000;display:none;align-items:center;justify-content:center;flex-direction:column;gap:14px;
  background:rgba(8,10,14,.72);color:#fff;font:600 15px system-ui,sans-serif;pointer-events:none}
.ui-loading.on{display:flex}
.ui-spin{width:38px;height:38px;border:4px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:ui-spin 1s linear infinite}
@keyframes ui-spin{to{transform:rotate(360deg)}}
`;

// DOM helper (no `this`, so modules can destructure it: const { el } = ctx.ui)
function el(tag, parent, text, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  parent?.appendChild(n);
  return n;
}

export class UIModule extends Module {
  static id = 'ui';
  static requires = [];

  async init() {
    this.el = el;
    this.panels = new Map();
    this.reserved = { left: {}, right: {} };
    this.reservedPx = { left: 12, right: 12 };
    this.mode = this.ctx.state?.get?.('searchMode');
    this.style = el('style', document.head, CSS);
    this.docks = {
      left: el('div', document.body, undefined, 'ui-dock ui-dock-left'),
      right: el('div', document.body, undefined, 'ui-dock ui-dock-right'),
    };
    const off = this.ctx.bus?.on?.('search:mode', (m) => { this.mode = m; this.applyVisibility(); });
    this._offMode = typeof off === 'function' ? off : null;
    // 'mode:change' is emitted by whoever sets state 'mode' (map -> world); panels using visibleWhen: { mode: ... } re-check
    const offM = this.ctx.bus?.on?.('mode:change', () => this.applyVisibility());
    this._offMode2 = typeof offM === 'function' ? offM : null;
    this.ctx.ui = this;
  }

  addPanel({ id, title = '', dock = 'right', visibleWhen = null, collapsed = false, build } = {}) {
    if (!id) throw new Error('[ui] addPanel needs an id');
    this.removePanel(id);

    const root = el('div', this.docks[dock] || this.docks.right, undefined, 'ui-panel');
    const head = el('div', root, undefined, 'ui-head');
    el('h4', head, title);
    const toggle = el('button', head, collapsed ? '+' : '–');
    const body = el('div', root, undefined, 'ui-body');
    const setCollapsed = (c) => { root.classList.toggle('collapsed', c); toggle.textContent = c ? '+' : '–'; };
    setCollapsed(collapsed);
    toggle.addEventListener('click', () => { setCollapsed(!root.classList.contains('collapsed')); toggle.blur(); });

    for (const ev of ['keydown', 'pointerdown', 'wheel', 'mousedown']) root.addEventListener(ev, (e) => e.stopPropagation());

    const panel = {
      id, root, body, visibleWhen, forced: null,
      show: () => { panel.forced = true; this.applyVisibility(); },
      hide: () => { panel.forced = false; this.applyVisibility(); },
    };
    this.panels.set(id, panel);
    build?.(body, this);
    this.applyVisibility();
    return panel;
  }

  reserve(dock, key, px = 0) {
    const r = this.reserved[dock];
    if (!r) return;
    if (px > 0) r[key] = Math.round(px); else delete r[key];
    const off = Math.max(12, ...Object.values(r));
    if (off === this.reservedPx[dock]) return;                    // called every frame by some modules: do nothing if unchanged
    this.reservedPx[dock] = off;
    this.docks[dock].style[dock === 'right' ? 'top' : 'bottom'] = `${off}px`;
  }

  viewFrame() {
    const f = el('div', document.body, undefined, 'ui-viewframe');
    const label = el('div', f, undefined, 'ui-viewlabel');
    (this.tips ||= new Set()).add(f);
    return { el: f, label };
  }

  canvasLayer() {
    const c = el('canvas', document.body, undefined, 'ui-layer');
    (this.tips ||= new Set()).add(c);
    return c;
  }

  // Full-screen "working..." overlay. ui.loading('text') shows it, ui.loading(null) hides it.
  // Safety net: it hides itself after 20 s so a failed step can never leave the screen covered.
  loading(text) {
    if (!this._load) {
      const d = el('div', document.body, undefined, 'ui-loading');
      el('div', d, undefined, 'ui-spin');
      this._loadTxt = el('div', d);
      (this.tips ||= new Set()).add(d);
      this._load = d;
    }
    clearTimeout(this._loadTimer);
    if (text == null) { this._load.classList.remove('on'); return; }
    this._loadTxt.textContent = text;
    this._load.classList.add('on');
    this._loadTimer = setTimeout(() => this._load?.classList.remove('on'), 20000);
  }

  tooltip() {
    const t = el('div', document.body, undefined, 'ui-tip');
    (this.tips ||= new Set()).add(t);
    return t;
  }

  removePanel(id) {
    const p = this.panels.get(id);
    if (!p) return;
    p.root.remove();
    this.panels.delete(id);
  }

  matches(vw) {
    if (!vw) return true;
    if (typeof vw === 'function') return !!vw(this.ctx);
    return Object.entries(vw).every(([k, v]) => (k === 'searchMode' ? this.mode : this.ctx.state?.get?.(k)) === v);
  }

  applyVisibility() {
    for (const p of this.panels.values()) {
      const visible = p.forced ?? this.matches(p.visibleWhen);
      p.root.style.display = visible ? '' : 'none';
    }
  }

  dispose() {
    try { this._offMode?.(); } catch { /* ignore */ }
    try { this._offMode2?.(); } catch { /* ignore */ }
    clearTimeout(this._loadTimer);
    for (const id of [...this.panels.keys()]) this.removePanel(id);
    this.tips?.forEach((t) => t.remove());
    this.docks?.left.remove();
    this.docks?.right.remove();
    this.style?.remove();
    if (this.ctx.ui === this) delete this.ctx.ui;
    super.dispose();
  }
}
