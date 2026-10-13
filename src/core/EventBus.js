// Modules talk to each other ONLY through this bus (and shared state).
export class EventBus {
  constructor() {
    this.handlers = new Map();
  }

  /** Subscribe. Returns an unsubscribe function. */
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this.handlers.get(event)?.delete(fn);
  }

  emit(event, data) {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(data);
      } catch (err) {
        // one broken listener must not break the others
        console.error(`[bus] handler for "${event}" failed`, err);
      }
    }
  }
}