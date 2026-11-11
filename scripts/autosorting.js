import { 
  isometricModuleConfig,
  OCCLUSION_ELEVATION_OFFSET
} from "./consts.js";
import { isWorldIsometric } from "./worldflag.js";
import {
  sortPlaceableByPosition,
  // debugCanvasLayer,
  toggleAnchorAxis,
} from "./utils.js";
import { isPerspectiveActive, applyPerspectiveDepthSort } from "./perspective.js";

export function isoDepthSortTileMixin(Base) {
  return class DepthSortTile extends Base {
    _refreshState() {
      super._refreshState();
      if (!this.mesh) return;      
      const isTileSortable = this.document.flags[isometricModuleConfig.MODULE_ID]?.isoTileAutoSortingEnabled || false;

      if (isTileSortable) {
        applyDepthSort();
        this.mesh.sortLayer = foundry.canvas.groups.PrimaryCanvasGroup.SORT_LAYERS.TOKENS;
        // this.mesh.elevation = this.mesh.occlusionMode !== 0? this.document.elevation + OCCLUSION_ELEVATION_OFFSET: this.document.elevation;

      } else {
        if(this.mesh){
          this.mesh.sortLayer = foundry.canvas.groups.PrimaryCanvasGroup.SORT_LAYERS.TILES;
          // this.mesh.elevation = this.document.elevation;
        }
      }
    }
    _onUpdate(changed, options, userId) {
      super._onUpdate(changed, options, userId);
      const isTileSortable = this.document.getFlag(
        isometricModuleConfig.MODULE_ID,
        "isoTileAutoSortingEnabled",
      );
      if (isTileSortable) {
        applyDepthSort();
      }
    }
  };
}

export function isoDepthSortTokenMixin(Base) {
  return class DepthSortPlaceable extends Base {
    _refreshState() {
      super._refreshState();
      if (isDepthSortScene()) applyDepthSort();
    }

    _onAnimationUpdate(changed, context) {
      super._onAnimationUpdate(changed, context);
      if ((changed.x || changed.y) && isDepthSortScene()) {
        applyDepthSort();
      }
    }

  };
}

// The depth sort is for isometric scenes, perspective ones among them. It runs at every refresh of any token's state
// (a hover, a target, a click, the turn border at each change of turn) and on every frame of a token's movement, and
// it copies and re-sorts every token on the scene each time. On a flat scene it did all of that for nothing, and wrote
// an isometric order over Foundry's own: measured in a fight on a flat scene (13 tokens, 12 turns), 245 ms of the 353
// this module spent. The scene's flag is read first, straight off the document: on a flat scene this is asked many
// times a turn.
function isDepthSortScene() {
  if (isPerspectiveActive()) return true;
  if (!canvas.scene?.flags?.[isometricModuleConfig.MODULE_ID]?.isometricEnabled) return false;
  return isWorldIsometric();
}

export function applyDepthSort() {
  if (!canvas.primary) return;
  if (isPerspectiveActive()) {
    applyPerspectiveDepthSort();
    return;
  }
  const sortList = sortPlaceableByPosition(); //.map(({sprite}) => sprite);
  sortList.reverse();

  const anyTokenControlled = canvas.tokens.controlled.length > 0;

  for (let i = 0; i < sortList.length; i++) {
    const currentSprite = sortList[i].object;
    currentSprite.mesh.sort = i; // if this is commented, tokens render above all tiles
    currentSprite.document.sort = i; // if this is commented, tokens render above SW tiles but under se tiles
    if (currentSprite.document.documentName === "Tile" && currentSprite.mesh){
      // this tricks the tile mesh to act as if it was a bit higher then the t
      currentSprite.mesh.elevation = currentSprite.mesh.occlusionMode !== 0? currentSprite.document.elevation + OCCLUSION_ELEVATION_OFFSET: currentSprite.document.elevation;
    }
    // fix the texture elevation bump when a token is controlled , keeping tile sort order uniform so occlusion can trigger without causing visual glitches.
    currentSprite.mesh.elevation = anyTokenControlled? currentSprite.document.elevation + OCCLUSION_ELEVATION_OFFSET: currentSprite.document.elevation;
  }

  canvas.primary.sortDirty = true;
}

export function wrapTileTestOcclusion() {
  const PrimarySpriteMesh = foundry.canvas.primary.PrimarySpriteMesh;
  const originalTestOcclusion = PrimarySpriteMesh.prototype.testOcclusion;

  PrimarySpriteMesh.prototype.testOcclusion = function (token, options) {
    const tileDocument = this.object?.document;
    const isSortableTile =
    tileDocument instanceof CONFIG.Tile.documentClass &&
    this.occlusionMode !== 0 &&
    tileDocument.getFlag(
      isometricModuleConfig.MODULE_ID,
      "isoTileAutoSortingEnabled",
    );

    if (!isSortableTile) {
      return originalTestOcclusion.call(this, token, options);
    }
    // add extra trigger conditions to tiles with occlusion modes when a token is currently selected is sorted "behind the tile"
    if (!token.controlled || !token.mesh) return false;
    if (token.mesh.sort >= this.sort) return false;
    return originalTestOcclusion.call(this, token, options);
  };
}