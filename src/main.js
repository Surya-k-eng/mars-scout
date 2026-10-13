import './style.css';
import { App } from './core/App.js';
import { EVENTS } from './core/events.js';
import modules from './modules.config.js';

async function main() {
  const app = new App(document.body);
  if (import.meta.env.DEV) window.app = app; // handy in the browser console while developing

  await app.modules.registerAll(modules);
  app.start();
  app.bus.emit(EVENTS.PHASE_GO, 'menu');
}

main().catch((err) => console.error('Mars Scout failed to start', err));