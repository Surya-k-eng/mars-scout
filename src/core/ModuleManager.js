export class ModuleManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.modules = new Map();
    this.disabled = new Set();
  }

  /** Sort by `requires`, then init each module in order. */
  async registerAll(moduleClasses) {
    for (const C of this.sortByDependencies(moduleClasses)) {
      try {
        const instance = new C(this.ctx);
        await instance.init();
        this.modules.set(C.id, instance);
        console.log(`[module] ${C.id} ready`);
      } catch (err) {
        console.error(`[module] ${C.id} failed to start, skipping it`, err);
      }
    }
  }

  sortByDependencies(classes) {
    const byId = new Map();
    for (const C of classes) {
      if (!C.id || C.id === 'unnamed') throw new Error('Every module needs a unique static id');
      if (byId.has(C.id)) throw new Error(`Duplicate module id "${C.id}"`);
      byId.set(C.id, C);
    }

    const sorted = [];
    const mark = new Map(); // id -> 'visiting' | 'done'

    const visit = (C, chain) => {
      if (mark.get(C.id) === 'done') return;
      if (mark.get(C.id) === 'visiting') {
        throw new Error(`Circular dependency: ${[...chain, C.id].join(' -> ')}`);
      }
      mark.set(C.id, 'visiting');
      for (const depId of C.requires ?? []) {
        const dep = byId.get(depId);
        if (!dep) throw new Error(`Module "${C.id}" requires "${depId}", which is not registered`);
        visit(dep, [...chain, C.id]);
      }
      mark.set(C.id, 'done');
      sorted.push(C);
    };

    classes.forEach((C) => visit(C, []));
    return sorted;
  }

  update(delta, time) {
    for (const [id, m] of this.modules) {
      if (this.disabled.has(id)) continue;
      try {
        m.update(delta, time);
      } catch (err) {
        console.error(`[module] ${id} crashed in update(), disabling it`, err);
        this.disabled.add(id);
      }
    }
  }

  get(id) {
    return this.modules.get(id);
  }

  dispose() {
    for (const m of this.modules.values()) m.dispose();
    this.modules.clear();
  }
}