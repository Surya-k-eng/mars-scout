import { EVENTS } from './events.js';

// Only one phase is active at a time. Modules react to phase:enter / phase:exit.
export const PHASES = ['boot', 'menu', 'siteSelect', 'goalSelect', 'planning', 'flythrough', 'results'];

export class PhaseManager {
  constructor(bus) {
    this.bus = bus;
    this.current = null;
    bus.on(EVENTS.PHASE_GO, (name) => this.go(name));
  }

  go(next) {
    if (!PHASES.includes(next)) {
      console.warn(`[phase] unknown phase "${next}"`);
      return;
    }
    if (next === this.current) return;
    if (this.current) this.bus.emit(EVENTS.PHASE_EXIT, this.current);
    this.current = next;
    console.log(`[phase] -> ${next}`);
    this.bus.emit(EVENTS.PHASE_ENTER, next);
  }
}