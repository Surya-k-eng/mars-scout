import { Module } from '../../core/Module.js';
import { EVENTS } from '../../core/events.js';

// 1. Copy this file into src/modules/<yourfeature>/ and rename it.
// 2. Change `id` and `requires`.
// 3. Ask the backbone owner to add your class to src/modules.config.js.
export class ExampleModule extends Module {
  static id = 'example';
  static requires = ['terrain'];

  async init() {
    // this.on(...) is cleaned up automatically
    this.on(EVENTS.TERRAIN_READY, (terrain) => {
      console.log('example module got terrain', terrain.width, 'x', terrain.height);
    });
  }

  update(delta, time) {
    // per-frame work (keep it light)
  }
}