import { rollMode } from './rollMode.js';
import { liarsDice } from './liarsDice.js';
import { mixedMode } from './mixedMode.js';
import { russianRoulette } from './russianRoulette.js';

export const MODES = {
  [rollMode.id]: rollMode,
  [liarsDice.id]: liarsDice,
  [mixedMode.id]: mixedMode,
  [russianRoulette.id]: russianRoulette,
};

// 給前端選單用的模式清單(available:false 會在 UI 變灰且後端拒絕)
export const MODE_LIST = [
  { id: rollMode.id, name: rollMode.name, available: true },
  { id: liarsDice.id, name: liarsDice.name, available: true },
  { id: mixedMode.id, name: mixedMode.name, available: true },
  { id: russianRoulette.id, name: russianRoulette.name, available: true },
];
