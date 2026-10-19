import { applyIsometricPerspective, applyBackgroundTransformation } from './transform.js';
import { isometricModuleConfig, updateIsometricConstants, parseCustomProjection, updateCustomProjection, PROJECTION_TYPES, DEFAULT_PROJECTION, CUSTOM_PROJECTION } from './consts.js';
import { patchConfig, createAdjustableButton } from './utils.js';
import {
  PERSPECTIVE_LEGACY,
  PERSPECTIVE_DEFAULTS,
  isPerspectiveProjection,
  currentPerspectiveMode,
  readStandingTokens,
  configurePerspective,
  isPerspectiveActive,
  isPerspectiveSaved,
  applyPerspective,
  previewPerspective,
  setPerspectiveEditing,
  getSavedCamera,
  reprojectTokens,
  convertTokenPositions
} from './perspective.js';

export function createSceneIsometricTab(){
  
  const sceneTabConfig = {
    moduleConfig: isometricModuleConfig,
    label: game.i18n.localize("isometric-perspective.tab_isometric_name"),
    tabGroup : "sheet",
    tabId : "isometric",
    icon: "fas fa-cube",
    templatePath: 'modules/isometric-perspective/templates/scene-config.hbs'
  }

  // Scene config data
  const FoundrySceneConfig = foundry.applications.sheets.SceneConfig;
  const DefaultSceneConfig = Object.values(CONFIG.Scene.sheetClasses.base).find((d) => d.default)?.cls;
  const SceneConfig = DefaultSceneConfig?.prototype instanceof FoundrySceneConfig ? DefaultSceneConfig : FoundrySceneConfig;

  const projectionTypes = Object.keys(PROJECTION_TYPES).filter(type => type !== PERSPECTIVE_LEGACY);
  const currentProjection = SceneConfig.object?.getFlag(isometricModuleConfig.MODULE_ID, 'projectionType') ?? DEFAULT_PROJECTION;
  
  const extraSceneConfig = {
    perspectiveStandingChoices: {
      all: game.i18n.localize("isometric-perspective.scene_perspective_standing_all"),
      players: game.i18n.localize("isometric-perspective.scene_perspective_standing_players"),
      none: game.i18n.localize("isometric-perspective.scene_perspective_standing_none")
    },
    projectionTypes: projectionTypes,
    document: currentProjection
  }

  patchConfig(SceneConfig,sceneTabConfig, extraSceneConfig);

}

// disable the custom projection field when custom projection isnt selected.
export function initSceneForm (app, html, context, options){

  const currentScale = app.document.getFlag(isometricModuleConfig.MODULE_ID, 'isometricScale');
  const inputScale = html.querySelector('range-picker[name="flags.isometric-perspective.isometricScale"]');
  inputScale.value = currentScale ?? 1;

  const projectionSelect = html.querySelector('select[name="flags.isometric-perspective.projectionType"]');
  const customProjectionInput = html.querySelector('input[name="flags.isometric-perspective.customProjection"]');
  const customProjectionContainer = html.querySelector('.custom-projection-container');
  
  // perspective options are only shown for the two perspective modes
  const perspectiveContainer = html.querySelector('.perspective-container');
  // scenes saved with the old single perspective projection open on the matching mode
  const savedFlags = app.document.flags?.[isometricModuleConfig.MODULE_ID];
  if (savedFlags?.projectionType === PERSPECTIVE_LEGACY) projectionSelect.value = currentPerspectiveMode(savedFlags);
  const togglePerspectiveOptions = (projection) => {
    perspectiveContainer?.classList.toggle('hidden', !isPerspectiveProjection(projection));
    setPerspectiveEditing(isPerspectiveProjection(projection) && (app.document === canvas.scene));
  };
  togglePerspectiveOptions(projectionSelect.value);
  if (perspectiveContainer) initPerspectiveFields(app, html, perspectiveContainer, projectionSelect);

  projectionSelect.addEventListener('change', (event) => {
    if (event.target.value === "Custom Projection"){
      customProjectionInput.disabled = false;
      customProjectionContainer.classList.remove('hidden');
    } else {
      customProjectionInput.disabled = true;
      customProjectionContainer.classList.add('hidden');
    }
    togglePerspectiveOptions(event.target.value);
  });

}

function initPerspectiveFields(app, html, container, projectionSelect) {
  const scene = app.document;
  const field = (name) => html.querySelector(`[name="flags.isometric-perspective.${name}"]`);

  // range pickers need an explicit value
  const defaults = {
    perspectiveTilt: 'tilt',
    perspectiveRotation: 'rotation',
    perspectiveFov: 'fov',
    perspectiveScale: 'scale',
    perspectiveGridColor: 'gridColor',
    perspectiveGridAlpha: 'gridAlpha',
    perspectiveGridThickness: 'gridThickness'
  };
  for (const [name, key] of Object.entries(defaults)) {
    const input = field(name);
    if (input) input.value = scene.getFlag(isometricModuleConfig.MODULE_ID, name) ?? PERSPECTIVE_DEFAULTS[key];
  }

  // scenes saved before the choice existed only had the "lay tokens flat" checkbox
  const standing = field('perspectiveStandingTokens');
  if (standing) standing.value = readStandingTokens(scene.flags?.[isometricModuleConfig.MODULE_ID]);

  // the canvas can only preview once the projection is saved
  container.querySelector('.perspective-save-notice')?.classList.toggle('hidden', isPerspectiveSaved(scene));

  // an empty grid size covers the whole map
  const dimensions = scene.dimensions;
  if (dimensions) {
    const columns = field('perspectiveColumns');
    const rows = field('perspectiveRows');
    if (columns) columns.placeholder = Math.round(dimensions.sceneRect.width / dimensions.size);
    if (rows) rows.placeholder = Math.round(dimensions.sceneRect.height / dimensions.size);
  }

  // hold and drag to move the grid by the same distance on screen
  createAdjustableButton({
    buttonElement: container.querySelector('.perspective-fine-adjust'),
    inputs: [field('perspectiveOffsetY'), field('perspectiveOffsetX')],
    adjustmentScale: () => {
      const scale = 1 / (canvas.stage?.scale.x || 1);
      return [-scale, scale];
    },
    roundingPrecision: 0
  });

  // live preview of the unsaved values
  const readForm = () => ({
    isometricEnabled: field('isometricEnabled')?.checked,
    projectionType: projectionSelect.value,
    perspectiveStandingTokens: field('perspectiveStandingTokens')?.value,
    perspectiveTilt: field('perspectiveTilt')?.value,
    perspectiveRotation: field('perspectiveRotation')?.value,
    perspectiveFov: field('perspectiveFov')?.value,
    perspectiveScale: field('perspectiveScale')?.value,
    perspectiveOffsetX: field('perspectiveOffsetX')?.value,
    perspectiveOffsetY: field('perspectiveOffsetY')?.value,
    perspectiveColumns: field('perspectiveColumns')?.value,
    perspectiveRows: field('perspectiveRows')?.value,
    perspectiveGridColor: field('perspectiveGridColor')?.value,
    perspectiveGridAlpha: field('perspectiveGridAlpha')?.value,
    perspectiveGridThickness: field('perspectiveGridThickness')?.value
  });
  const preview = () => previewPerspective(scene, readForm());
  container.addEventListener('input', preview);
  container.addEventListener('change', preview);
  // switching between grid only and grid and map
  projectionSelect.addEventListener('change', preview);
}

// closing the scene configuration without saving drops the preview
export function handleCloseSceneConfig(app) {
  const scene = app.document;
  if (!canvas.ready || (scene !== canvas.scene)) return;
  setPerspectiveEditing(false);
  if (isPerspectiveActive()) applyPerspective(scene);
}

export function handleUpdateScene(scene, changes, options, userId) {
  if (scene.id !== canvas.scene?.id) return;

  if (
    changes.img ||
    changes.background?.offsetX !== undefined ||
    changes.background?.offsetY !== undefined ||
    changes.flags?.[isometricModuleConfig.MODULE_ID]?.isometricEnabled !== undefined ||
    changes.flags?.[isometricModuleConfig.MODULE_ID]?.isometricBackground !== undefined ||
    changes.flags?.[isometricModuleConfig.MODULE_ID]?.projectionType !== undefined ||
    Object.keys(changes.flags?.[isometricModuleConfig.MODULE_ID] ?? {}).some(key => key.includes('perspective')) ||
    changes.grid !== undefined ||
    changes.gridType !== undefined ||
    changes.gridSize !== undefined
  ) {
    const isIsometric = scene.getFlag(isometricModuleConfig.MODULE_ID, "isometricEnabled");
    const shouldTransformBackground = scene.getFlag(isometricModuleConfig.MODULE_ID, "isometricBackground") ?? false;
    const projectionType = scene.getFlag(isometricModuleConfig.MODULE_ID, "projectionType") ?? DEFAULT_PROJECTION;

    // logic for custom projection
    if (projectionType === 'Custom Projection') {
      const customProjectionValue = scene.getFlag(isometricModuleConfig.MODULE_ID, "customProjection");
      if (customProjectionValue) {
        try {
          const parsedCustom = parseCustomProjection(customProjectionValue);
          updateCustomProjection(parsedCustom);
        } catch (error) {
          console.error("Error parsing custom projection:", error);
        }
      }
    }

    // Switching in or out of the perspective view changes how every mesh is built,
    // so redraw the canvas instead of patching the existing meshes.
    const wasPerspective = isPerspectiveActive();
    const previousCamera = getSavedCamera();
    const isPerspective = configurePerspective(scene);
    if (wasPerspective !== isPerspective) {
      // tokens keep their cells: floor positions outside of the perspective view, picture positions inside
      const moved = (userId === game.user.id)
        ? convertTokenPositions(scene, wasPerspective ? previousCamera : null, isPerspective ? getSavedCamera() : null)
        : Promise.resolve();
      moved.catch(error => console.error("Isometric Perspective | moving tokens for the new projection failed", error))
        .finally(() => canvas.draw());
      return;
    }

    requestAnimationFrame(() => {
      updateIsometricConstants(projectionType);
      applyIsometricPerspective(scene, isIsometric);
      applyBackgroundTransformation(scene, isIsometric, shouldTransformBackground);
      // tokens stay on their cell when the camera changes (moved once, by whoever saved)
      if (userId === game.user.id) reprojectTokens(previousCamera);
    });
  }
}

// Set the projection before placeables are drawn, so they are built for the right mode from the start
export function handleCanvasInit(canvas) {
  const scene = canvas.scene;
  if (!scene) return;

  const projectionType = scene.getFlag(isometricModuleConfig.MODULE_ID, "projectionType") ?? DEFAULT_PROJECTION;
  if (projectionType === 'Custom Projection') {
    const customProjectionValue = scene.getFlag(isometricModuleConfig.MODULE_ID, "customProjection");
    if (customProjectionValue) {
      try {
        updateCustomProjection(parseCustomProjection(customProjectionValue));
      } catch (error) {
        console.error("Error parsing custom projection:", error);
      }
    }
  }

  updateIsometricConstants(projectionType);
  configurePerspective(scene);
}

export async function handleCanvasReady(canvas) {
  const scene = canvas.scene;
  if (!scene) return;

  const isSceneIsometric = scene.getFlag(isometricModuleConfig.MODULE_ID, "isometricEnabled");
  const shouldTransformBackground = scene.getFlag(isometricModuleConfig.MODULE_ID, "isometricBackground") ?? false;
  let projectionType = scene.getFlag(isometricModuleConfig.MODULE_ID, "projectionType");
  
  // If no projection type is set, set the default
  if (!projectionType) {
    projectionType = DEFAULT_PROJECTION;
    await scene.setFlag(isometricModuleConfig.MODULE_ID, "projectionType", projectionType);
  }

  // logic to load and apply custom projection
  if (projectionType === 'Custom Projection') {
    const customProjectionValue = scene.getFlag(isometricModuleConfig.MODULE_ID, "customProjection");
    if (customProjectionValue) {
      try {
        const parsedCustom = parseCustomProjection(customProjectionValue);
        updateCustomProjection(parsedCustom);
      } catch (error) {
        console.error("Error parsing custom projection:", error);
      }
    }
  }
  
  updateIsometricConstants(projectionType);
  applyIsometricPerspective(scene, isSceneIsometric);
  applyBackgroundTransformation(scene, isSceneIsometric, shouldTransformBackground);
  
  // Force a camera update to synchronize the HUD layer transformations with the now-isometrically-transformed stage.
  // This ensures the #hud container correctly aligns with the stage immediately upon scene load.
  if (isSceneIsometric) {
    // We use a small delay to allow the PIXI stage transformations to settle before forcing the HTML sync.
    setTimeout(() => {
        if (!canvas.ready) return;
        
        // Trigger a dummy pan to force Foundry's internal camera-to-interface synchronization.
        // We use the current pivot and scale to ensure the camera does not actually move.
        canvas.pan({
            x: canvas.stage.pivot.x,
            y: canvas.stage.pivot.y,
            scale: canvas.stage.scale.x
        });
        
        if (isometricModuleConfig.DEBUG_PRINT) console.log("Forced HUD synchronization completed.");
    }, 250);
  }
  
  // debug print
  if (isometricModuleConfig.DEBUG_PRINT) console.log("handleCanvasReady");
}

export function handleCanvasResize(canvas) {
  const scene = canvas.scene;
  if (!scene) return;
  
  const isSceneIsometric = scene.getFlag(isometricModuleConfig.MODULE_ID, "isometricEnabled");
  const shouldTransformBackground = scene.getFlag(isometricModuleConfig.MODULE_ID, "isometricBackground") ?? false;
  const projectionType = scene.getFlag(isometricModuleConfig.MODULE_ID, "projectionType") ?? DEFAULT_PROJECTION;

  updateIsometricConstants(projectionType);
  
  if (isSceneIsometric && shouldTransformBackground) {
    applyBackgroundTransformation(scene, isSceneIsometric, shouldTransformBackground);
  }
  
  // debug print
  if (isometricModuleConfig.DEBUG_PRINT) console.log("handleCanvasResize");
}


/*
Hooks.on("renderGridConfig", (app, html, data) => {
  const scene = app.object;
  if (!scene) return;
  
  const isIsometric = scene.getFlag(isometricModuleConfig.MODULE_ID, "isometricEnabled");
  const shouldTransformBackground = scene.getFlag(isometricModuleConfig.MODULE_ID, "isometricBackground") ?? false;
  
  // Re-apply transformations when grid config is rendered
  if (isIsometric) {
    requestAnimationFrame(() => {
      applyIsometricPerspective(scene, isIsometric);
      applyBackgroundTransformation(scene, isIsometric, shouldTransformBackground);
    });
  }
  
  // Add listener for when grid config tool is being used
  html.querySelector('.grid-config').on('change', () => {
    if (isIsometric) {
      requestAnimationFrame(() => {
        applyIsometricPerspective(scene, isIsometric);
        applyBackgroundTransformation(scene, isIsometric, shouldTransformBackground);
      });
    }
  });
});


// Aplica a perspectiva isométrica quando a cena termina de ser renderizada
Hooks.on("gridConfigUpdate", (event) => {
  const scene = canvas.scene;
  if (!scene) return;
  
  const isIsometric = scene.getFlag(isometricModuleConfig.MODULE_ID, "isometricEnabled");
  const shouldTransformBackground = scene.getFlag(isometricModuleConfig.MODULE_ID, "isometricBackground") ?? false;
  
  // Re-apply isometric transformations after grid update
  if (isIsometric) {
    requestAnimationFrame(() => {
      applyIsometricPerspective(scene, isIsometric);
      applyBackgroundTransformation(scene, isIsometric, shouldTransformBackground);
    });
  }
});

Hooks.on("closeGridConfig", (app) => {
  const scene = app.object;
  if (!scene) return;
  
  const isIsometric = scene.getFlag(isometricModuleConfig.MODULE_ID, "isometricEnabled");
  const isometricWorldEnabled = game.settings.get(isometricModuleConfig.MODULE_ID, "worldIsometricFlag");
  const shouldTransformBackground = scene.getFlag(isometricModuleConfig.MODULE_ID, "isometricBackground") ?? false;
  
  if (isometricWorldEnabled && isIsometric) {
    requestAnimationFrame(() => {
      applyIsometricPerspective(scene, isIsometric);
      applyBackgroundTransformation(scene, isIsometric, shouldTransformBackground);
    });
  }
});
*/
