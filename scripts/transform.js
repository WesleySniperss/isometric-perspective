import { isometricModuleConfig } from './consts.js';
import { 
  cartesianToIso,
  getTileGeometry
} from './utils.js';
import { ISOMETRIC_CONST } from './consts.js';
import {
  isPerspectiveActive,
  applyPerspective,
  removePerspective,
  applyPerspectiveToPlaceable,
  isTokenStanding,
  getStandingImage,
  getStandingScale,
  useStandingImage,
  layoutStandingEffects,
  restoreEffects,
  drawStandingShadow,
  shadowCircle,
  removeStandingShadow,
  SHADOW_RADIUS,
  drawDashedLine,
  recordIsometricPlacement
} from './perspective.js';


// Main function that changes the scene canvas.
export function applyIsometricPerspective(scene, isSceneIsometric) {
  const isometricWorldEnabled = game.settings.get(isometricModuleConfig.MODULE_ID, "worldIsometricFlag");

  // Vanishing point perspective: the stage stays top-down, the grid and tokens follow a camera (see perspective.js)
  if (isometricWorldEnabled && isSceneIsometric && ISOMETRIC_CONST.perspective) {
    canvas.app.stage.rotation = 0;
    canvas.app.stage.skew.set(0, 0);
    applyPerspective(scene);
    return;
  }
  removePerspective();

  if (isometricWorldEnabled && isSceneIsometric) {
    canvas.app.stage.rotation = ISOMETRIC_CONST.rotation;
    canvas.app.stage.skew.set(
      ISOMETRIC_CONST.skewX,
      ISOMETRIC_CONST.skewY
    );
  
  //previously was in an exported fuction but used within the same file once, no need to do that.  
  const tokensAndTiles = [...canvas.tokens.placeables, ...canvas.tiles.placeables];
  tokensAndTiles.forEach(obj => applyIsometricTransformation(obj, true));

  } else {
    canvas.app.stage.rotation = 0;
    canvas.app.stage.skew.set(0, 0);
  }
}

const canvasTile = foundry.canvas.placeables.Tile;
const canvasToken = foundry.canvas.placeables.Token;

// Function that applies isometric transformation to a token or tile.
export function applyIsometricTransformation(object, isSceneIsometric) {
  // Don't make any transformation if the isometric module isn't active
  const isometricWorldEnabled = game.settings.get(isometricModuleConfig.MODULE_ID, "worldIsometricFlag");
  if (!isometricWorldEnabled) return

  // Don't make any transformation if there isn't any mesh
  if (!object.mesh) {
    if (isometricModuleConfig.DEBUG_PRINT) {console.warn("Mesh not found:", object)}
    return;
  }
  
  // Disable isometric token projection, if the flag is active
  let isoTileDisabled = object.document.getFlag(isometricModuleConfig.MODULE_ID, 'isoTileDisabled') ?? 0;
  let isoTokenDisabled = object.document.getFlag(isometricModuleConfig.MODULE_ID, 'isoTokenDisabled') ?? 0;
  if (isoTileDisabled || isoTokenDisabled) {
    object.mesh.anchor.set(0.5, 0.5);  // This is set to make isometric anchor don't mess with non-iso scenes
    if (object instanceof canvasToken) leaveIsometric(object);
    return
  }

  // Don't make transformation on the token or tile if the scene isn't isometric
  if (!isSceneIsometric) {
    object.mesh.anchor.set(0.5, 0.5);  // This is set to make isometric anchor don't mess with non-iso scenes
    if (object instanceof canvasToken) leaveIsometric(object);
    return;
  }

  // Perspective scenes: tokens stand upright and shrink with depth, tiles warp with the map when it is in perspective
  if (isPerspectiveActive()) {
    if (object instanceof canvasToken) removeTokenVisuals(object);
    applyPerspectiveToPlaceable(object);
    return;
  }

  // Tokens lying flat (their pose, or the Standing Tokens of the scene) keep Foundry's drawing, on the isometric floor
  if ((object instanceof canvasToken) && !isTokenStanding(object)) {
    layTokenFlat(object);
    return;
  }

  // It undoes rotation and deformation
  object.mesh.rotation = ISOMETRIC_CONST.reverseRotation;
  object.mesh.skew.set(ISOMETRIC_CONST.reverseSkewX, ISOMETRIC_CONST.reverseSkewY);
    
  // recovers the object characteristics of the object (token/tile)
  let texture = object.texture;
  let originalWidth = texture.width;   // art width
  let originalHeight = texture.height; // art height
  let scaleX = object.document.width;  // scale for 2x2, 3x3 tokens
  let scaleY = object.document.height; // scale for 2x2, 3x3 tokens
  
  // if Disable Auto-Scale checkbox is set, don't auto-scale tokens
  let isoScaleDisabled = object.document.getFlag(isometricModuleConfig.MODULE_ID, "isoScaleDisabled");
  if (isoScaleDisabled) scaleX = scaleY = 1;

  // elevation info
  let elevation = object.document.elevation;      // elevation from tokens and tiles
  let gridDistance = canvas.scene.grid.distance;  // size of one unit of the grid
  let gridSize = canvas.scene.grid.size;
  let isoScale = object.document.getFlag(isometricModuleConfig.MODULE_ID, 'scale') ?? 1;  // dynamic scale
  let offsetX = object.document.getFlag(isometricModuleConfig.MODULE_ID, 'offsetX') ?? 0; // art offset of object
  let offsetY = object.document.getFlag(isometricModuleConfig.MODULE_ID, 'offsetY') ?? 0; // art offset of object
  
  // if module settings flag is not set, don't move art token
  let ElevationAdjustment = game.settings.get(isometricModuleConfig.MODULE_ID, "enableHeightAdjustment");
  if (!ElevationAdjustment) elevation = 0;
  if (object instanceof canvasToken) {
    // Standing art: the Standing Image of the token, or else the actor portrait
    const standingTexture = getStandingImage(object);
    useStandingImage(object, standingTexture);
    let sx = 1; // standard x
    let sy = 1; // standard y
    //We should only use the token art ratio if the ring is disabled
    //Otherwise it scales the dynamic ring subject based on the token art dimensions
    if (!object.document.ring?.enabled) {
      let objTxtRatio_W = object.texture.width / canvas.scene.grid.size;
      let objTxtRatio_H = object.texture.height / canvas.scene.grid.size;
      
      switch ( object.document.texture.fit ) {
        case "fill":
          sx = 1;
          sy = 1;
          break;
        case "contain":
          if (Math.max(objTxtRatio_W, objTxtRatio_H) ==  objTxtRatio_W){
            sx = 1
            sy = (objTxtRatio_H) / (objTxtRatio_W)
          }
          else{
            sx = (objTxtRatio_W) / (objTxtRatio_H)
            sy = 1
          }
          break;
        case "cover":
          if (Math.min(objTxtRatio_W, objTxtRatio_H) == objTxtRatio_W){
            sx = 1
            sy = (objTxtRatio_H) / (objTxtRatio_W)
          }
          else{
            sx = (objTxtRatio_W) / (objTxtRatio_H)
            sy = 1
          }
          break;
        case "width":
          sx = 1
          sy = (objTxtRatio_H) / (objTxtRatio_W)
          break;
        case "height":
          sx = (objTxtRatio_W) / (objTxtRatio_H)
          sy = 1
          break;
        default:
          // V11 Compatibility change
          if (isometricModuleConfig.FOUNDRY_VERSION === 11) {
            sx = (objTxtRatio_W) / (objTxtRatio_H);
            sy = 1;
            break;
          }
          //throw new Error(`Invalid fill type passed to ${this.constructor.name}#resize (fit=${fit}).`);
          console.warn("Invalid fill type passed to: ", object);
          sx = 1;
          sy = 1;
      }
      object.mesh.width  = Math.abs(sx * scaleX * gridSize * isoScale * Math.sqrt(2))
      object.mesh.height = Math.abs(sy * scaleY * gridSize * isoScale * Math.sqrt(2) * ISOMETRIC_CONST.ratio)
    } else {
      //Make the token square if using dynamic ring.
      object.mesh.width = Math.abs(sx * scaleX * gridSize * isoScale * Math.sqrt(2))
      object.mesh.height = Math.abs(sy * scaleX * gridSize * isoScale * Math.sqrt(2) * ISOMETRIC_CONST.ratio)
    }
    // Standing art: as tall as set in the token (in cells, a cell being as long as its edge on screen), keeping its
    // proportions, feet on the cell
    let standingSize = null;
    if (standingTexture) {
      const scale = getStandingScale(object, standingTexture);
      const upright = uprightArtScale();
      standingSize = { width: Math.abs(scale.x) * standingTexture.width, height: Math.abs(scale.y) * standingTexture.height };
      object.mesh.width = standingSize.width / upright.x;
      object.mesh.height = standingSize.height / upright.y;
      object.mesh.anchor.set(0.5, 1);
      object.mesh._isoStandingAnchor = true;
    } else if (object.mesh._isoStandingAnchor) {
      object.mesh.anchor.set(object.document.texture.anchorX, object.document.texture.anchorY);
      delete object.mesh._isoStandingAnchor;
    }

    // Elevation math
    offsetX += elevation * (1/gridDistance) * 100 * Math.sqrt(2) * (1/scaleX);
    offsetX *= gridSize / 100;   // grid ratio in comparison with default 100
    offsetY *= gridSize / 100;   // grid ratio in comparison with default 100
    
    // transformed distances
    const isoOffsets = cartesianToIso(offsetX, offsetY);
    
    // Create shadow and line graphics elements
    updateTokenVisuals(object, elevation, gridSize, gridDistance);

    // Position the token
    object.mesh.position.set(
      object.document.x + (scaleX * gridSize/2) + (scaleX * isoOffsets.x),
      object.document.y + (scaleX * gridSize/2) + (scaleX * isoOffsets.y)
    );
    // Status effects in a column beside the standing art, upright like it, and a shadow under its feet
    if (standingSize) layoutIsometricEffects(object, standingSize);
    else restoreEffects(object, inverseStage(), stagePoint(object.w / 2, object.h / 2));
    const radius = SHADOW_RADIUS * Math.min(object.w, object.h);
    object._isoShadowRadius = radius;
    drawStandingShadow(object, shadowCircle(object.center.x, object.center.y, radius));
    // remembered so movement animations of other modules (Smooth Move) can't tilt or resize it
    recordIsometricPlacement(object);
  }

  // If the object is a tile
  else if (object instanceof canvasTile) {

    // Apply the scale by maintaining the proportion of the original art
    let finalMeshScaleX, finalMeshScaleY;
    if (object.document.getFlag(isometricModuleConfig.MODULE_ID, "isoDecoupleArtScale")) {
      finalMeshScaleX = isoScale;
      finalMeshScaleY = isoScale * ISOMETRIC_CONST.ratio;
    } else {
      finalMeshScaleX = (scaleX / originalWidth) * isoScale;
      finalMeshScaleY = (scaleY / originalHeight) * isoScale * ISOMETRIC_CONST.ratio;
    }
    object.mesh.scale.set(finalMeshScaleX, finalMeshScaleY);
    
    // Flip token horizontally, if the flag is active
    let scaleFlip = object.document.getFlag(isometricModuleConfig.MODULE_ID, 'tileFlipped') ?? 0;
    if (scaleFlip) {
      let meshScaleX = object.mesh.scale.x;
      let meshScaleY = object.mesh.scale.y;
      object.mesh.scale.set(-meshScaleX, meshScaleY);
    }

    // Defines the manual offset to center the tile
    let isoOffsets = cartesianToIso(offsetX, offsetY);

    // Set tile's position - with v13 compatibility
    const geometry = getTileGeometry(object.document);
    object.mesh.anchor.set(geometry.anchor.x, geometry.anchor.y);
    object.mesh.position.set(geometry.anchorPoint.x + isoOffsets.x,geometry.anchorPoint.y + isoOffsets.y);
  }
}

// A token lying flat on the isometric floor: Foundry's own drawing of it, rotated and skewed with the stage
function layTokenFlat(token) {
  const mesh = token.mesh;
  const { texture, rotation, lockRotation, elevation } = token.document;
  useStandingImage(token, null);
  token._refreshMeshSizeAndScale?.();
  mesh.anchor.set(texture.anchorX, texture.anchorY);
  mesh.angle = lockRotation ? 0 : rotation;
  mesh.skew.set(0, 0);
  delete mesh._isoStandingAnchor;

  // A flying token is lifted by its elevation like upright ones (Enable Height Adjustment), with its dashed line down
  // to the floor and a shadow there
  const heightAdjust = game.settings.get(isometricModuleConfig.MODULE_ID, "enableHeightAdjustment");
  const height = heightAdjust ? Math.max(elevation ?? 0, 0) : 0;
  const lift = cartesianToIso(height * (canvas.grid.size / canvas.grid.distance) * Math.SQRT2, 0);
  mesh.position.set(token.center.x + lift.x, token.center.y + lift.y);
  // its status icons stay upright, not skewed with the floor, and fly with it
  const frame = inverseStage();
  frame.tx = lift.x;
  frame.ty = lift.y;
  restoreEffects(token, frame, stagePoint(token.w / 2, token.h / 2));
  if (height > 0) {
    updateTokenVisuals(token, height, canvas.grid.size, canvas.grid.distance);
    token._isoShadowRadius = SHADOW_RADIUS * Math.min(token.w, token.h);
    drawStandingShadow(token, shadowCircle(token.center.x, token.center.y, token._isoShadowRadius));
    recordIsometricPlacement(token);   // walk animations keep it in the air
  } else {
    removeTokenVisuals(token);
    removeStandingShadow(token);
    delete mesh._isoPlacement;
  }
}

// The token is no longer isometric: nothing of it stays upright
function leaveIsometric(token) {
  removeStandingShadow(token);
  restoreEffects(token);
}

// The linear part of the isometric stage transform, without the zoom (as PIXI builds it from rotation and skew)
function stageMatrix() {
  const { rotation, skewX, skewY } = ISOMETRIC_CONST;
  return { a: Math.cos(rotation + skewY), b: Math.sin(rotation + skewY), c: -Math.sin(rotation - skewX), d: Math.cos(rotation - skewX) };
}

// Undoes the stage: what is drawn in it is upright on screen, at the size of the scene
function inverseStage() {
  const { a, b, c, d } = stageMatrix();
  const det = (a * d) - (b * c);
  return new PIXI.Matrix(d / det, -b / det, -c / det, a / det, 0, 0);
}

// Where a point of the token is on screen (relative to its origin), in the coordinates of inverseStage
function stagePoint(x, y) {
  const { a, b, c, d } = stageMatrix();
  return { x: (a * x) + (c * y), y: (b * x) + (d * y) };
}

// How much the stage stretches upright art (turned back by the reverse rotation) across and down
function uprightArtScale() {
  const { a, b, c, d } = stageMatrix();
  const cos = Math.cos(ISOMETRIC_CONST.reverseRotation);
  const sin = Math.sin(ISOMETRIC_CONST.reverseRotation);
  return {
    x: Math.hypot((a * cos) + (c * sin), (b * cos) + (d * sin)),
    y: Math.hypot((c * cos) - (a * sin), (d * cos) - (b * sin))
  };
}

// The effects container of a standing token is upright on screen, at its feet (`size`: the art on screen, unzoomed)
function layoutIsometricEffects(token, size) {
  const mesh = token.mesh;
  const frame = inverseStage();
  frame.tx = mesh.position.x - token.position.x;
  frame.ty = mesh.position.y - token.position.y;
  layoutStandingEffects(token, -size.width / 2, size.width / 2, -size.height, size.height, frame);
}

// Function to transform the scene background.
export function applyBackgroundTransformation(scene, isSceneIsometric, shouldTransform) {
  if (!canvas?.primary?.background) {
    if (isometricModuleConfig.DEBUG_PRINT) console.warn("Background not found.");
    return;
  }

  const background = canvas.environment.primary.background;
  const isometricWorldEnabled = game.settings.get(isometricModuleConfig.MODULE_ID, "worldIsometricFlag");
  const scale = scene.getFlag(isometricModuleConfig.MODULE_ID, "isometricScale") ?? 1;
  
  if (isometricWorldEnabled && isSceneIsometric && shouldTransform && !ISOMETRIC_CONST.perspective) {
    // Applies isometric rotation
    background.rotation = ISOMETRIC_CONST.reverseRotation;
    background.skew.set(
      ISOMETRIC_CONST.reverseSkewX,
      ISOMETRIC_CONST.reverseSkewY
    );
    background.anchor.set(0.5, 0.5);
    background.transform.scale.set(
      scale,
      scale * ISOMETRIC_CONST.ratio // Math.sqrt(3)
    );

    const dimensions = scene.dimensions;
    const offsetX = scene.background.offsetX ?? 0;
    const offsetY = scene.background.offsetY ?? 0;
    background.position.set((dimensions.width / 2) + offsetX,(dimensions.height / 2) + offsetY);

  } else {
    // Reset transformations
    background.rotation = 0;
    background.skew.set(0, 0);
    
    if (isometricModuleConfig.DEBUG_PRINT) console.log("applyBackgroundTransformation RESET")
  }
}

// ----------------- Elevation -----------------

// Manter registro de todos os tokens com visuais (para controle se necessário, embora atrelado ao token facilite)
const tokensWithVisuals = new Set();

// Função para limpar todos os visuais
export function clearAllVisuals() {
  // Se estivermos atrelando ao token, basta iterar tokens existentes
  if (canvas.tokens?.placeables) {
    for (const token of canvas.tokens.placeables) {
        removeTokenVisuals(token);
    }
  }
}

// Função para verificar se um token existe na cena atual
function isTokenInCurrentScene(tokenId) {
  return canvas.tokens.placeables.some(t => t.id === tokenId);
}

export function updateTokenVisuals(token, elevacao, gridSize, gridDistance) {
  // Primeiro, remova qualquer representação visual existente
  removeTokenVisuals(token);

  // Se não há elevação ou a variável global está desativada, não cria visuais
  const tokenVisuals = game.settings.get(isometricModuleConfig.MODULE_ID, "enableTokenVisuals");
  if (elevacao <= 0 || !tokenVisuals) return;

  // Cria um novo container
  const container = new PIXI.Container();
  container.name = "isometric-elevation-visuals";
  container.interactive = false;
  container.interactiveChildren = false;
  
  // Registrar o token
  tokensWithVisuals.add(token.id);

  // Center X/Y relativo ao token
  // O código original usava token.h / 2. Vamos manter a lógica ou usar w/2, h/2?
  // Original: token.x + token.h / 2.
  // Vamos usar token.w / 2 e token.h / 2 para ser mais generico, ou manter token.h?
  // Se o token não for quadrado, center seria w/2, h/2.
  const centerX = token.w ? token.w / 2 : token.h / 2;
  const centerY = token.h / 2;

  // The shadow on the floor is drawn for every standing token (drawStandingShadow)
  // A faint dashed line from the floor up to the token
  // Offset da elevação
  const offset = elevacao * (gridSize/gridDistance);

  const line = new PIXI.Graphics();
  const from = { x: centerX, y: centerY };
  const to = { x: centerX + offset, y: centerY - offset };
  const dash = { dash: gridSize * 0.1, gap: gridSize * 0.07 };
  drawDashedLine(line, from, to, { ...dash, width: Math.max(gridSize * 0.03, 1) + 2, color: 0x000000, alpha: 0.3 });
  drawDashedLine(line, from, to, { ...dash, width: Math.max(gridSize * 0.03, 1), color: 0xFFFFFF, alpha: 0.65 });
  container.addChild(line);

  // Adicionar o container ao TOKEN, não ao stage.
  // addChildAt(0) tenta colocar atrás do artwork principal se possível.
  token.addChildAt(container, 0);
}

export function removeTokenVisuals(token) {
  const container = token.getChildByName("isometric-elevation-visuals");
  if (container) {
    token.removeChild(container);
    container.destroy({children: true}); // Limpar memoria PIXI
  }
  tokensWithVisuals.delete(token.id);
}

Hooks.on('canvasReady', () => { 
  clearAllVisuals();
});

Hooks.on('deleteToken', (token) => {
  // O child é destruído automaticamente com o token, mas removemos do set por sanidade
  tokensWithVisuals.delete(token.id);
});


// HOOK SETUP FOR COMPATIBILITY WITH FOUNDRY V11
Hooks.once('ready', () => {
  setupCompatibilityHooks();
});

function setupCompatibilityHooks() {
  if (isometricModuleConfig.FOUNDRY_VERSION === 11) {
    Hooks.on('dropCanvasData', (canvas, object) => {
      const globalPoint = {
        x: event.clientX,
        y: event.clientY
      };
  
      // Converts to local coordinates of the stage
      const localPos = canvas.stage.toLocal(globalPoint);
      object.x = Math.round(localPos.x);
      object.y = Math.round(localPos.y);
    });
    // Hooks.on('dropCanvasData', (canvas, object) => {
    //   let {x, y} = canvas.stage.worldTransform.applyInverse({x: event.clientX, y: event.clientY})

    //   object.x = x;
    //   object.y = y;
    // });
  }
}