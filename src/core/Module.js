// The contract every feature follows.
//
//   static id        unique name, e.g. 'terrain'
//   static requires  ids of modules that must load first, e.g. ['terrain']
//
// this.ctx = { scene, camera, renderer, controls, bus, state, services, lights, config }
export class Module {
  static id = 'unnamed';
  static requires = [];

  constructor(ctx) {
    this.ctx = ctx;
    this._unsubs = [];
  }

  /** Subscribe to the bus; cleaned up automatically in dispose(). */
  on(event, fn) {
    this._unsubs.push(this.ctx.bus.on(event, fn));
  }

  /** Load assets, add objects to the scene, subscribe to events. */
  async init() {}

  /** Called every frame. delta = seconds since last frame. */
  update(delta, time) {}

  /** Remove your objects from the scene and free GPU memory. */
  dispose() {
    this._unsubs.forEach((off) => off());
    this._unsubs = [];
  }
}