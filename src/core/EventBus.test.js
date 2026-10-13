import { describe, it, expect } from 'vitest';
import { EventBus } from './EventBus.js';

describe('EventBus', () => {
  it('delivers data to listeners', () => {
    const bus = new EventBus();
    let got = null;
    bus.on('x', (d) => (got = d));
    bus.emit('x', 42);
    expect(got).toBe(42);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on('x', () => count++);
    bus.emit('x');
    off();
    bus.emit('x');
    expect(count).toBe(1);
  });

  it('keeps going if one listener throws', () => {
    const bus = new EventBus();
    let ok = false;
    bus.on('x', () => { throw new Error('boom'); });
    bus.on('x', () => (ok = true));
    bus.emit('x');
    expect(ok).toBe(true);
  });
});