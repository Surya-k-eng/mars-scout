// The ONLY place that decides which features are enabled.
// Add a module = import it + add it to the list. Broken before the demo? Remove its line.
import { WorldModule } from './modules/world/WorldModule.js';
import { CharacterModule } from './modules/character/CharacterModule.js';
import { AtmosphereModule } from './modules/atmosphere/AtmosphereModule.js';


export default [
  WorldModule,
  CharacterModule,
  AtmosphereModule,
];