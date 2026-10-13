// The ONLY place that decides which features are enabled.
// Add a module = import it + add it to the list. Broken before the demo? Remove its line.
import { TerrainModule } from './modules/terrain/TerrainModule.js';

export default [
  TerrainModule,
];