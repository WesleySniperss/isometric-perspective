import { isometricModuleConfig } from './consts.js';
import { cartesianToIso } from './utils.js';
import { isPerspectiveActive, getPerspectivePathCells } from './perspective.js';

/**
 * Helper to apply isometric adjustments to label context.
 * extracted from TokenRulerIsometric for reuse.
 * @param {Object} ctx      The label context to adjust
 * @param {Token} [token]   The token to anchor visual offsets to (optional)
 * @returns {Object}        The adjusted context
 */
function applyIsometricLabelAdjustments(ctx, token) {
  if (!ctx?.position || !canvas.scene) return ctx;

  const isIsometric = canvas.scene.getFlag(isometricModuleConfig.MODULE_ID, "isometricEnabled");
  const worldIsoEnabled = game.settings.get(isometricModuleConfig.MODULE_ID, "worldIsometricFlag");
  if (!worldIsoEnabled || !isIsometric) return ctx;
  // Perspective scenes keep the stage top-down, so the default label position is already correct
  if (isPerspectiveActive()) return ctx;

  // 1. Start with the logical grid position
  let x = ctx.position.x;
  let y = ctx.position.y;

  // 2. Apply Token Offsets (Elevation/Art Offset) to match the mesh exactly
  // Only if a valid token is provided (e.g. from TokenRuler)
  if (token?.document) {
      const doc = token.document;
      const elevationAdjustment = game.settings.get(isometricModuleConfig.MODULE_ID, "enableHeightAdjustment");
      let ox = doc.getFlag(isometricModuleConfig.MODULE_ID, "offsetX") || 0;
      let oy = doc.getFlag(isometricModuleConfig.MODULE_ID, "offsetY") || 0;
        
      if (elevationAdjustment) {
          const elev = doc.elevation || 0;
          const gridSize = canvas.scene.grid.size;
          const gridDist = canvas.scene.grid.distance;
          // Formulas from transform.js to match visual height
          const factor = (gridSize / gridDist) * Math.sqrt(2);
          ox += (elev * factor) / (doc.width || 1);
      }

      if (ox !== 0 || oy !== 0) {
          // Apply projection for height/art offsets as used in transform.js
          const isoOffsets = cartesianToIso(ox, oy);
          x += isoOffsets.x * (doc.width || 1);
          y += isoOffsets.y * (doc.height || 1);
      }
  }

  // 3. Project to Screen Space using the Stage's exact transform
  // This automatically accounts for rotation, skew, and zoom.
  const projected = canvas.stage.toGlobal({x, y});
  
  // 4. Map screen coordinates back to HUD relative coordinates (accounting for zoom scale)
  const hud = document.getElementById("hud");
  if ( hud ) {
      const hudRect = hud.getBoundingClientRect();
      const zoom = canvas.stage.scale.x;

      ctx.position.x = (projected.x - hudRect.left) / zoom;
      ctx.position.y = (projected.y - hudRect.top) / zoom;
  }
  
  if ( !ctx.cssClass ) ctx.cssClass = "";
  const classes = new Set(ctx.cssClass.split(" ").filter(Boolean));
  classes.add("iso-ruler-label");
  ctx.cssClass = Array.from(classes).join(" ");

  return ctx;
}

/**
 * Patch the TokenRuler to correctly position labels in isometric scenes.
 */
function extendTokenRuler() {
  const ParentRuler = CONFIG.Token.rulerClass;
  if (!ParentRuler) return;
  
  // Apply the TokenRuler override if not already applied
  if (!ParentRuler.prototype.hasOwnProperty("_isIsometricRuler")) {
      /**
       * Subclass the currently active TokenRuler to add isometric label positioning.
       */
      class TokenRulerIsometric extends ParentRuler {
        get _isIsometricRuler() { return true; }

        // Highlight of the perspective cells along the path (perspective scenes)
        #perspectiveLayer = null;
        #perspectiveLayerName = null;
        #preparedPaths = null;

        _getWaypointLabelContext(waypoint, state) {
          const ctx = super._getWaypointLabelContext(waypoint, state);
          return applyIsometricLabelAdjustments(ctx, this.sourceToken);
        }

        // The square grid spaces of the scene don't match the perspective cells, which are highlighted instead
        _getGridHighlightStyle(waypoint, offset) {
          if (isPerspectiveActive()) return {alpha: 0};
          return super._getGridHighlightStyle(waypoint, offset);
        }

        // Foundry builds every path it draws through here: keep them for the perspective highlight
        _preparePath(path) {
          super._preparePath(path);
          this.#preparedPaths?.push(path);
        }

        refresh(options) {
          this.#preparedPaths = [];
          try {
            super.refresh(options);
          } finally {
            const paths = this.#preparedPaths;
            this.#preparedPaths = null;
            try {
              this.#highlightPerspectiveCells(paths, options);
            } catch (error) {
              console.error("Isometric Perspective | highlighting the perspective cells of the ruler failed", error);
            }
          }
        }

        clear() {
          super.clear();
          this.#perspectiveLayer?.clear();
        }

        destroy() {
          super.destroy();
          if (this.#perspectiveLayerName) canvas.interface.grid.destroyHighlightLayer(this.#perspectiveLayerName);
          this.#perspectiveLayer = null;
        }

        _onVisibleChange() {
          super._onVisibleChange();
          if (this.#perspectiveLayer) this.#perspectiveLayer.visible = this.visible;
        }

        // Same paths and colors as Foundry's grid highlight: the moved path, then what other users plan (own path on
        // top), without the part of a planned path already walked. `paths` are the paths Foundry built, in that order.
        #highlightPerspectiveCells(paths, {plannedMovement = {}} = {}) {
          if (!isPerspectiveActive() || !paths?.length) {
            this.#perspectiveLayer?.clear();
            return;
          }
          if (!this.#perspectiveLayer) {
            this.#perspectiveLayerName = `TokenRuler.${this.token.document.id}${this.token.isPreview ? ".preview" : ""}.perspective`;
            this.#perspectiveLayer = canvas.interface.grid.addHighlightLayer(this.#perspectiveLayerName);
          }
          const layer = this.#perspectiveLayer;
          layer.clear();
          layer.visible = this.visible;
          const planned = Object.entries(plannedMovement);
          const self = planned.findIndex(([userId]) => userId === game.user.id);
          if (self >= 0) planned.push(...planned.splice(self, 1));
          const highlighted = paths.map((path, i) => (i > 0) ? path.slice(planned[i - 1]?.[1].history?.length ?? 0) : path);
          for (const path of highlighted) {
            for (const {waypoint, points, center} of getPerspectivePathCells(path)) {
              const {color = 0xFFFFFF, alpha = 0.5, texture = PIXI.Texture.WHITE, matrix = null} = this.#highlightStyle(waypoint, center);
              if (!(alpha > 0)) continue;
              layer.beginTextureFill({texture, color, alpha, matrix, smooth: true});
              layer.drawPolygon(points);
              layer.endFill();
            }
          }
        }

        // The style of the ruler (and of the systems extending it), or Foundry's default should it fail
        #highlightStyle(waypoint, center) {
          try {
            return ParentRuler.prototype._getGridHighlightStyle.call(this, waypoint, canvas.grid.getOffset(center));
          } catch (error) {
            return {color: game.users.get(waypoint.userId)?.color ?? 0x000000, alpha: 0.5};
          }
        }
      }

      CONFIG.Token.rulerClass = TokenRulerIsometric;
      if (isometricModuleConfig.DEBUG_PRINT) console.log("Isometric Perspective | Extended TokenRuler via subclassing.");
  }
}

/**
 * Patch the CanvasRuler (Measure tool) to correctly position labels in isometric scenes.
 */
function extendCanvasRuler() {
  const ParentRuler = CONFIG.Canvas.rulerClass;
  if (!ParentRuler) return;

  // Apply the CanvasRuler override if not already applied
  if (!ParentRuler.prototype.hasOwnProperty("_isIsometricCanvasRuler")) {
      /**
       * Subclass the currently active CanvasRuler to add isometric label positioning.
       */
      class CanvasRulerIsometric extends ParentRuler {
        get _isIsometricCanvasRuler() { return true; }

        _getWaypointLabelContext(waypoint, state) {
          const ctx = super._getWaypointLabelContext(waypoint, state);
          // For standard Measure Tool, we usually do not anchor to tokens.
          return applyIsometricLabelAdjustments(ctx, null);
        }
      }

      CONFIG.Canvas.rulerClass = CanvasRulerIsometric;
      if (isometricModuleConfig.DEBUG_PRINT) console.log("Isometric Perspective | Extended CanvasRuler via subclassing.");
  }
}

/**
 * Register all Ruler patches
 */
export function registerRuler() {
  extendTokenRuler();
  extendCanvasRuler();
}
