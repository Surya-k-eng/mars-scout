// The ONLY place that decides which features are enabled.
// Add a module = import it + add it to the list. Broken before the demo? Remove its line.
import { WorldModule } from './modules/world/WorldModule.js';
// import { GlobeModule } from './modules/globe/GlobeModule.js';       // old planet-only view
// import { TerrainModule } from './modules/terrain/TerrainModule.js'; // old flat local view

export default [
  WorldModule,
];
