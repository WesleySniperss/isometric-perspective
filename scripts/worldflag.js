import { isometricModuleConfig } from './consts.js';

// Is the module switched on for this world (its main setting). It is asked at every refresh of every token, of its
// border and of its HUD, and a world setting is not a cheap read, so the answer is kept until the setting changes (it
// asks for a reload as well). A file of its own: a name new to an existing file breaks the whole module wherever a
// cache still serves that file's old copy.
let worldIsometric = null;

export function isWorldIsometric() {
  if (worldIsometric === null) worldIsometric = !!game.settings.get(isometricModuleConfig.MODULE_ID, "worldIsometricFlag");
  return worldIsometric;
}

const forgetWorldIsometric = (setting) => {
  if (setting?.key === `${isometricModuleConfig.MODULE_ID}.worldIsometricFlag`) worldIsometric = null;
};
Hooks.on("createSetting", forgetWorldIsometric);
Hooks.on("updateSetting", forgetWorldIsometric);
