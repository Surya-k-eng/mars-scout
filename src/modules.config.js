// The ONLY place that decides which features are enabled.
// Add a module = import it + add it to the list. Broken before the demo? Remove its line.
import { WorldModule } from './modules/world/WorldModule.js';
import { CharacterModule } from './modules/character/CharacterModule.js';
import { AtmosphereModule } from './modules/atmosphere/AtmosphereModule.js';
import { MapPickModule } from './modules/mappick/MapPickModule.js';
import { TitleScreenModule } from './modules/ui/TitleScreen.js';
import { MineralPickModule } from './modules/mappick/MineralPickModule.js';
import { MineralSearchModule } from './modules/mappick/MineralSearchModule.js';
import { UIModule } from './modules/ui/uimodule.js';
import { HawkModule } from './modules/character/HawkModule.js';
import { WeatherPageModule } from './modules/weather/WeatherPage.js';
import { BuildPotentialModule } from './modules/BuildPotentialModule.js';


export default [
  WorldModule,
  CharacterModule,
  AtmosphereModule,
  MapPickModule,
  TitleScreenModule,
  MineralPickModule,
  MineralSearchModule,
  UIModule,
  WeatherPageModule,
  HawkModule,
  BuildPotentialModule,
  
];
