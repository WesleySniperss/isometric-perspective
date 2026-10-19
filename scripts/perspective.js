import { isometricModuleConfig } from './consts.js';

// ----------------- Vanishing Point Perspective -----------------
//
// A virtual camera looks at the floor of the scene. The floor uses the scene's own coordinates and
// square grid: it is turned (rotation), leaned away from the viewer (tilt) and projected through a
// perspective homography (field of view), then scaled and moved over the scene (scale, position).
//
// The grid is drawn in perspective over the map. Optionally the map image and the tiles are warped the
// same way; otherwise they are left untouched, for maps that are already painted in perspective.
// Tokens snap to the perspective cells, are sized to the cell they stand on, follow their cell when
// the camera changes, and movement is measured on the floor, so distances count perspective cells.
//
// Two cameras are kept: the saved one (scene flags) places tokens and drives snapping and measurement,
// the current one (saved, or unsaved values from the scene configuration) is what is drawn.

// Two projection modes share the same camera: only the grid follows it, or the grid and the map (with tiles)
export const PERSPECTIVE_GRID_ONLY = 'Perspective: Grid Only';
export const PERSPECTIVE_GRID_AND_MAP = 'Perspective: Grid and Map';
// Earlier versions had a single projection with a "map too" checkbox (perspectiveWarpMap)
export const PERSPECTIVE_LEGACY = 'Perspective (Vanishing Point)';

export function isPerspectiveProjection(type) {
  return [PERSPECTIVE_GRID_ONLY, PERSPECTIVE_GRID_AND_MAP, PERSPECTIVE_LEGACY].includes(type);
}

// The mode an old scene saved with the legacy projection corresponds to
export function currentPerspectiveMode(flags) {
  if (flags?.projectionType !== PERSPECTIVE_LEGACY) return flags?.projectionType;
  return flags.perspectiveWarpMap ? PERSPECTIVE_GRID_AND_MAP : PERSPECTIVE_GRID_ONLY;
}

export const PERSPECTIVE_DEFAULTS = Object.freeze({
  tilt: 45,
  rotation: 0,
  fov: 60,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  gridColor: "#ffffff",
  gridAlpha: 0.5,
  gridThickness: 2
});

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const MIN_DEPTH = 0.15;        // nearest drawable depth, relative to the center of the grid
const MAP_SUBDIVISIONS = 48;   // warped images are drawn as a mesh of this many quads per side
const EDIT_COLOR = 0xFF9829;   // outline of the grid while the scene configuration is open
const NEIGHBOR_STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const NO_CAMERA = Object.freeze({ m: IDENTITY, inv: IDENTITY, column0: 0, row0: 0, columns: 1, rows: 1 });

const state = {
  active: false,
  warpMap: false,
  standingTokens: "all",   // which tokens stand by default: "all", "players" or "none"
  heightAdjust: false,
  editing: false,
  previewing: false,
  style: { color: 0xFFFFFF, alpha: PERSPECTIVE_DEFAULTS.gridAlpha, thickness: PERSPECTIVE_DEFAULTS.gridThickness },
  saved: NO_CAMERA,     // camera of the saved scene flags
  current: NO_CAMERA    // camera being drawn
};

let gridGraphics = null;
let warpedMaps = [];
const warpedTiles = new Map();
let hiddenFoundryGrid = null;
const tokenMatrix = new PIXI.Matrix();
const meshMatrix = new PIXI.Matrix();

export function isPerspectiveActive() {
  return state.active;
}

// A token can choose its own pose (token or prototype token configuration), otherwise the scene decides
export function isTokenStanding(token) {
  const pose = token.document?.getFlag(isometricModuleConfig.MODULE_ID, "perspectivePose");
  if (pose === "standing") return true;
  if (pose === "flat") return false;
  if (state.standingTokens === "players") return !!token.document?.hasPlayerOwner;
  return state.standingTokens !== "none";
}

// Older scenes only had the "Lay Tokens Flat" checkbox
export function readStandingTokens(flags) {
  const value = flags?.perspectiveStandingTokens;
  if (["all", "players", "none"].includes(value)) return value;
  return flags?.perspectiveFlatTokens ? "none" : "all";
}

function isPerspectiveFlags(flags) {
  return !!(game.settings.get(isometricModuleConfig.MODULE_ID, "worldIsometricFlag") && flags.isometricEnabled
    && isPerspectiveProjection(flags.projectionType));
}

// Is the perspective projection saved for this scene (unsaved values can only be previewed then)
export function isPerspectiveSaved(scene) {
  return isPerspectiveFlags(scene?.flags?.[isometricModuleConfig.MODULE_ID] ?? {});
}

// Read the perspective configuration of a scene (plus unsaved form values), without drawing anything.
// Called on canvasInit so placeables drawn for the new scene already know the mode.
export function configurePerspective(scene, overrides = {}) {
  const MODULE_ID = isometricModuleConfig.MODULE_ID;
  const savedFlags = scene?.flags?.[MODULE_ID] ?? {};
  const flags = { ...savedFlags, ...overrides };
  state.active = isPerspectiveFlags(flags);
  state.warpMap = currentPerspectiveMode(flags) === PERSPECTIVE_GRID_AND_MAP;
  state.standingTokens = readStandingTokens(flags);
  state.heightAdjust = game.settings.get(MODULE_ID, "enableHeightAdjustment");
  state.style = readStyle(flags);
  if (!state.active || !scene?.dimensions) return state.active;

  state.current = buildCamera(scene, flags);
  state.previewing = isPerspectiveFlags(savedFlags) && (Object.keys(overrides).length > 0);
  state.saved = state.previewing ? buildCamera(scene, savedFlags) : state.current;
  return state.active;
}

// Turn the perspective view on (or update it) for the current scene.
export function applyPerspective(scene, overrides) {
  if (!configurePerspective(scene, overrides)) {
    removePerspective();
    return;
  }
  installTokenGuard();
  drawGrid();
  updateWarpedMaps();
  setFoundryGridHidden(true);
  for (const tile of canvas.tiles?.placeables ?? []) applyPerspectiveToPlaceable(tile);
  for (const token of getTokens()) applyPerspectiveToPlaceable(token);
  applyPerspectiveDepthSort();
}

// Show unsaved values from the scene configuration on the canvas.
export function previewPerspective(scene, overrides) {
  if (!canvas.ready || (scene !== canvas.scene) || !isPerspectiveSaved(scene)) return;
  applyPerspective(scene, isPerspectiveFlags(overrides) ? overrides : undefined);
}

// Highlight the outline of the grid while the scene configuration is open.
export function setPerspectiveEditing(editing) {
  if (state.editing === !!editing) return;
  state.editing = !!editing;
  if (state.active && canvas.ready) drawGrid();
}

// Turn the perspective view off.
export function removePerspective() {
  state.active = false;
  state.previewing = false;
  clearPerspectiveObjects();
}

// Destroy everything drawn for the perspective view (also used when the canvas is torn down).
export function clearPerspectiveObjects() {
  if (gridGraphics && !gridGraphics.destroyed) gridGraphics.destroy();
  gridGraphics = null;
  removeWarpedMaps();
  for (const id of [...warpedTiles.keys()]) removeWarpedTile(id);
  setFoundryGridHidden(false);
}

// The saved camera, to move tokens along when it changes
export function getSavedCamera() {
  return state.active ? state.saved : null;
}

// Keep every token on its floor cell after the saved camera changed (run by the user who saved).
export async function reprojectTokens(previous) {
  const scene = canvas.scene;
  if (!state.active || !previous || !scene || (previous === state.saved)) return;
  if (previous.m.every((value, i) => Math.abs(value - state.saved.m[i]) < 1e-12)) return;

  const size = canvas.grid.size;
  const updates = [];
  for (const token of scene.tokens) {
    const { x, y, width, height } = token._source;
    const halfX = width * size / 2;
    const halfY = height * size / 2;
    const floor = pictureToFloor(previous, x + halfX, y + halfY);
    if (!floor.valid) continue;
    const p = floorToPicture(state.saved, floor.x, floor.y);
    if (!p.valid) continue;
    const nx = Math.round(p.x - halfX);
    const ny = Math.round(p.y - halfY);
    if ((nx !== x) || (ny !== y)) updates.push({ _id: token.id, x: nx, y: ny });
  }
  if (updates.length) await scene.updateEmbeddedDocuments("Token", updates, { animate: false });
}

function readNumber(value, fallback) {
  if ((value === null) || (value === undefined) || (value === "")) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function readStyle(flags) {
  let color = Number(foundry.utils.Color.from(flags.perspectiveGridColor || PERSPECTIVE_DEFAULTS.gridColor));
  if (!Number.isFinite(color)) color = 0xFFFFFF;
  return {
    color,
    alpha: Math.clamp(readNumber(flags.perspectiveGridAlpha, PERSPECTIVE_DEFAULTS.gridAlpha), 0, 1),
    thickness: Math.clamp(readNumber(flags.perspectiveGridThickness, PERSPECTIVE_DEFAULTS.gridThickness), 0.25, 20)
  };
}

// ----------------- Camera -----------------

function multiply(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[(i * 3) + j] = (a[i * 3] * b[j]) + (a[(i * 3) + 1] * b[3 + j]) + (a[(i * 3) + 2] * b[6 + j]);
    }
  }
  return r;
}

function invert3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = (e * i) - (f * h);
  const B = -((d * i) - (f * g));
  const C = (d * h) - (e * g);
  const det = (a * A) + (b * B) + (c * C);
  if (!det) return IDENTITY;
  return [
    A / det, -((b * i) - (c * h)) / det, ((b * f) - (c * e)) / det,
    B / det, ((a * i) - (c * g)) / det, -((a * f) - (c * d)) / det,
    C / det, -((a * h) - (b * g)) / det, ((a * e) - (b * d)) / det
  ];
}

// The grid covers the whole map unless a size is given, and is centered on it
function buildCamera(scene, flags) {
  const { size, sceneRect: rect } = scene.dimensions;
  const center = { x: rect.x + (rect.width / 2), y: rect.y + (rect.height / 2) };
  const columns = Math.clamp(Math.round(readNumber(flags.perspectiveColumns, rect.width / size)), 1, 500);
  const rows = Math.clamp(Math.round(readNumber(flags.perspectiveRows, rect.height / size)), 1, 500);
  const m = buildCameraHomography({
    pivot: center,
    target: {
      x: center.x + readNumber(flags.perspectiveOffsetX, PERSPECTIVE_DEFAULTS.offsetX),
      y: center.y + readNumber(flags.perspectiveOffsetY, PERSPECTIVE_DEFAULTS.offsetY)
    },
    tilt: Math.clamp(readNumber(flags.perspectiveTilt, PERSPECTIVE_DEFAULTS.tilt), 0, 85),
    rotation: readNumber(flags.perspectiveRotation, PERSPECTIVE_DEFAULTS.rotation),
    fov: Math.clamp(readNumber(flags.perspectiveFov, PERSPECTIVE_DEFAULTS.fov), 0, 150),
    scale: Math.clamp(readNumber(flags.perspectiveScale, PERSPECTIVE_DEFAULTS.scale), 0.05, 10),
    width: rect.width
  });
  return {
    m,
    inv: invert3x3(m),
    columns,
    rows,
    column0: Math.round((center.x / size) - (columns / 2)),
    row0: Math.round((center.y / size) - (rows / 2))
  };
}

// Floor point (relative to the pivot, turned by the rotation) seen by a pinhole camera whose view
// direction leans `tilt` degrees away from straight down. The camera distance is chosen so that the
// scene width spans the field of view at the pivot, so the strength of the perspective doesn't depend
// on the scale. A field of view of 0 gives a parallel projection (no vanishing point).
function buildCameraHomography({ pivot, target, tilt, rotation, fov, scale, width }) {
  const t = Math.toRadians(tilt);
  const r = Math.toRadians(rotation);
  const lambda = (fov > 0) ? (Math.sin(t) * 2 * scale * Math.tan(Math.toRadians(fov) / 2) / width) : 0;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const toPivot = [1, 0, -pivot.x, 0, 1, -pivot.y, 0, 0, 1];
  const turn = [cos, -sin, 0, sin, cos, 0, 0, 0, 1];
  const project = [scale, 0, 0, 0, scale * Math.cos(t), 0, 0, -lambda, 1];
  const toTarget = [1, 0, target.x, 0, 1, target.y, 0, 0, 1];
  return multiply(toTarget, multiply(project, multiply(turn, toPivot)));
}

// Depth of a floor point relative to the pivot (1 at the pivot, smaller is closer to the camera)
function depthAt(camera, x, y) {
  return (camera.m[6] * x) + (camera.m[7] * y) + camera.m[8];
}

function floorToPicture(camera, x, y) {
  const m = camera.m;
  const depth = depthAt(camera, x, y);
  const w = Math.max(depth, MIN_DEPTH);
  return {
    x: ((m[0] * x) + (m[1] * y) + m[2]) / w,
    y: ((m[3] * x) + (m[4] * y) + m[5]) / w,
    valid: depth >= MIN_DEPTH
  };
}

function pictureToFloor(camera, x, y) {
  const m = camera.inv;
  const w = (m[6] * x) + (m[7] * y) + m[8];
  // Since inv is the exact inverse, the depth of the floor point is 1 / w; w <= 0 is beyond the horizon
  if (!(w > 0)) return { x: NaN, y: NaN, valid: false };
  return {
    x: ((m[0] * x) + (m[1] * y) + m[2]) / w,
    y: ((m[3] * x) + (m[4] * y) + m[5]) / w,
    valid: (1 / w) >= MIN_DEPTH
  };
}

// 2x2 Jacobian of the floor -> picture map at a floor point (picture px per floor px)
function jacobian(camera, x, y) {
  const m = camera.m;
  const X = (m[0] * x) + (m[1] * y) + m[2];
  const Y = (m[3] * x) + (m[4] * y) + m[5];
  const w = Math.max(depthAt(camera, x, y), MIN_DEPTH);
  const w2 = w * w;
  return {
    xx: ((m[0] * w) - (X * m[6])) / w2,
    xy: ((m[1] * w) - (X * m[7])) / w2,
    yx: ((m[3] * w) - (Y * m[6])) / w2,
    yy: ((m[4] * w) - (Y * m[7])) / w2
  };
}

// Largest stretch of the Jacobian: the scale of the floor across the line of sight, which is the
// apparent size of an upright object standing there.
function stretch(J) {
  const sum = (J.xx * J.xx) + (J.xy * J.xy) + (J.yx * J.yx) + (J.yy * J.yy);
  const det = (J.xx * J.yy) - (J.xy * J.yx);
  return Math.sqrt((sum + Math.sqrt(Math.max((sum * sum) - (4 * det * det), 0))) / 2);
}

function gridRect(camera, size) {
  return {
    x0: camera.column0 * size,
    y0: camera.row0 * size,
    x1: (camera.column0 + camera.columns) * size,
    y1: (camera.row0 + camera.rows) * size
  };
}

// Jacobian used to size a token standing at a picture point. Points outside the grid use the
// nearest edge of the grid, points beyond the horizon use its farthest corner.
function jacobianAtPicture(camera, x, y) {
  const r = gridRect(camera, canvas.grid.size);
  let floor = pictureToFloor(camera, x, y);
  if (!floor.valid) {
    const corners = [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
    floor = corners.reduce((best, c) => (depthAt(camera, c.x, c.y) > depthAt(camera, best.x, best.y) ? c : best));
  }
  return jacobian(camera, Math.clamp(floor.x, r.x0, r.x1), Math.clamp(floor.y, r.y0, r.y1));
}

// Where a point placed with the saved camera is drawn by the current one (the same point unless previewing)
function displayPoint(x, y) {
  if (!state.previewing) return { x, y };
  const floor = pictureToFloor(state.saved, x, y);
  if (!floor.valid) return { x, y };
  const p = floorToPicture(state.current, floor.x, floor.y);
  return p.valid ? p : { x, y };
}

// ----------------- Snapping and measurement -----------------

// Center (in cells) of a token spanning `span` cells, kept inside the grid
function clampCenter(center, span, start, count) {
  const half = Math.max(span, 1) / 2;
  return Math.clamp(center, start + half, Math.max(start + count - half, start + half));
}

function snapAxis(value, span, start, count) {
  if (span <= 1) return clampCenter(Math.floor(value) + 0.5, span, start, count);
  return clampCenter(Math.round(value - (span / 2)) + (span / 2), span, start, count);
}

// Snapped top-left position of a token, or null when it is dropped away from the grid (free placement)
function snapTokenPosition(document, data) {
  const camera = state.saved;
  const size = canvas.grid.size;
  const width = readNumber(data.width, document.width) || 1;
  const height = readNumber(data.height, document.height) || 1;
  const x = readNumber(data.x, document.x);
  const y = readNumber(data.y, document.y);
  const floor = pictureToFloor(camera, x + (width * size / 2), y + (height * size / 2));
  if (!floor.valid) return null;

  const u = floor.x / size;
  const v = floor.y / size;
  const margin = 0.5;
  if ((u < camera.column0 - margin) || (u > camera.column0 + camera.columns + margin)
    || (v < camera.row0 - margin) || (v > camera.row0 + camera.rows + margin)) return null;

  const center = floorToPicture(camera,
    snapAxis(u, width, camera.column0, camera.columns) * size,
    snapAxis(v, height, camera.row0, camera.rows) * size
  );
  if (!center.valid) return null;
  return { x: center.x - (width * size / 2), y: center.y - (height * size / 2) };
}

// Keyboard movement: step to the neighbouring cell that moves the token closest to the pressed direction
// on screen (so the arrows still feel right when the grid is rotated). Null if the token is off the floor.
function shiftTokenPosition(token, dx, dy) {
  const camera = state.saved;
  const size = canvas.grid.size;
  const { x, y, width, height } = token.document._source;
  const floor = pictureToFloor(camera, x + (width * size / 2), y + (height * size / 2));
  if (!floor.valid) return null;

  const u = snapAxis(floor.x / size, width, camera.column0, camera.columns);
  const v = snapAxis(floor.y / size, height, camera.row0, camera.rows);
  const from = floorToPicture(camera, u * size, v * size);
  const length = Math.hypot(dx, dy);
  let best = { alignment: 0.5, to: from };
  for (const [du, dv] of NEIGHBOR_STEPS) {
    const nu = clampCenter(u + du, width, camera.column0, camera.columns);
    const nv = clampCenter(v + dv, height, camera.row0, camera.rows);
    if ((nu === u) && (nv === v)) continue;
    const to = floorToPicture(camera, nu * size, nv * size);
    if (!to.valid) continue;
    const mx = to.x - from.x;
    const my = to.y - from.y;
    const distance = Math.hypot(mx, my);
    if (!distance) continue;
    const alignment = ((mx * dx) + (my * dy)) / (distance * length);
    if (alignment > best.alignment + 1e-6) best = { alignment, to };
  }
  return {
    x: Math.round(best.to.x - (width * size / 2)),
    y: Math.round(best.to.y - (height * size / 2))
  };
}

// Measurement waypoint moved onto the floor. Token waypoints are top-left corners plus the grid anchor.
function toFloorWaypoint(grid, waypoint) {
  const camera = state.saved;
  const size = grid.size;
  if ((waypoint.width === undefined) || (waypoint.height === undefined)) {
    const floor = pictureToFloor(camera, waypoint.x, waypoint.y);
    return floor.valid ? { ...waypoint, x: floor.x, y: floor.y } : waypoint;
  }
  let anchorX = 0;
  let anchorY = 0;
  if (grid.isSquare) {
    const width = Math.max(Math.round(waypoint.width * 2) / 2, 0.5);
    const height = Math.max(Math.round(waypoint.height * 2) / 2, 0.5);
    anchorX = size * (Number.isInteger(width) ? 0.5 : 0.25);
    anchorY = size * (Number.isInteger(height) ? 0.5 : 0.25);
  }
  const halfX = waypoint.width * size / 2;
  const halfY = waypoint.height * size / 2;
  const floor = pictureToFloor(camera, waypoint.x - anchorX + halfX, waypoint.y - anchorY + halfY);
  if (!floor.valid) return waypoint;
  return { ...waypoint, x: floor.x - halfX + anchorX, y: floor.y - halfY + anchorY };
}

// Wrap Foundry's snapping, keyboard movement and measurement (installed once, on init).
export function installPerspectivePatches() {
  const TokenDocument = foundry.documents.TokenDocument;
  const originalSnap = TokenDocument.prototype.getSnappedPosition;
  TokenDocument.prototype.getSnappedPosition = function (data = {}) {
    const snapped = originalSnap.call(this, data);
    if (!state.active || !this.parent || (this.parent !== canvas.scene)) return snapped;
    const position = snapTokenPosition(this, data);
    if (position) return { ...snapped, ...position };
    return { ...snapped, x: data.x ?? this.x, y: data.y ?? this.y };
  };

  const Token = foundry.canvas.placeables.Token;
  const originalShift = Token.prototype._getShiftedPosition;
  if (typeof originalShift === "function") {
    Token.prototype._getShiftedPosition = function (dx, dy, dz) {
      const shifted = originalShift.call(this, dx, dy, dz);
      if (!state.active || (!dx && !dy) || (this.scene !== canvas.scene)) return shifted;
      const position = shiftTokenPosition(this, dx, dy);
      return position ? { ...shifted, ...position } : shifted;
    };
  }

  // Foundry never snaps while dragging on a gridless scene: snap to the perspective cells anyway (Shift to skip)
  const originalDragWaypoint = Token.prototype._getDragWaypointPosition;
  if (typeof originalDragWaypoint === "function") {
    Token.prototype._getDragWaypointPosition = function (current, changes, options = {}) {
      if (state.active && !options.snap && canvas.grid.isGridless && !game.keyboard?.isModifierActive?.("Shift")) {
        options = { ...options, snap: true };
      }
      return originalDragWaypoint.call(this, current, changes, options);
    };
  }

  // Distances are measured on the floor, so they count perspective cells
  const BaseGrid = foundry.grid.BaseGrid;
  const originalMeasure = BaseGrid.prototype.measurePath;
  BaseGrid.prototype.measurePath = function (waypoints, options) {
    const scene = canvas.scene;
    if (!state.active || !scene || ((this !== scene.grid) && (this !== scene.gridlessGrid))) {
      return originalMeasure.call(this, waypoints, options);
    }
    return originalMeasure.call(this, waypoints.map(waypoint => toFloorWaypoint(this, waypoint)), options);
  };

  Hooks.on("deleteTile", (document) => removeWarpedTile(document.id));
}

// ----------------- Drawing -----------------

// Same depth as the map, above it but below tiles and tokens
function placeOnFloor(object, reference) {
  const PrimaryCanvasGroup = foundry.canvas.groups.PrimaryCanvasGroup;
  object.elevation = reference?.elevation ?? canvas.primary.background?.elevation ?? 0;
  object.sortLayer = reference?.sortLayer ?? (PrimaryCanvasGroup.SORT_LAYERS.TILES - 1);
  object.sort = reference?.sort ?? 0;
  object.zIndex = reference?.zIndex ?? 0;
  if (object.parent !== canvas.primary) canvas.primary.addChild(object);
  canvas.primary.sortDirty = true;
}

// Black or white, whichever stands out against the color
function contrastColor(color) {
  const r = (color >> 16) & 0xFF;
  const g = (color >> 8) & 0xFF;
  const b = color & 0xFF;
  return (((0.299 * r) + (0.587 * g) + (0.114 * b)) > 140) ? 0x000000 : 0xFFFFFF;
}

function drawGrid() {
  if (!canvas.primary) return;
  if (!gridGraphics || gridGraphics.destroyed) {
    gridGraphics = new PIXI.smooth.SmoothGraphics();
    gridGraphics.name = "isometric-perspective-grid";
    gridGraphics.eventMode = "none";
  }
  // While editing, draw above tiles and tokens so the outline is never hidden
  const SORT_LAYERS = foundry.canvas.groups.PrimaryCanvasGroup.SORT_LAYERS;
  placeOnFloor(gridGraphics);
  if (state.editing) gridGraphics.sortLayer = SORT_LAYERS.WEATHER - 1;
  gridGraphics.clear();

  const camera = state.current;
  const size = canvas.grid.size;
  const { color, alpha, thickness } = state.style;
  const r = gridRect(camera, size);

  // One segment per cell edge, so lines get thinner with distance
  const segments = [];
  const edges = [];
  const addSegment = (x0, y0, x1, y1, edge) => {
    const a = floorToPicture(camera, x0, y0);
    const b = floorToPicture(camera, x1, y1);
    if (!a.valid || !b.valid) return;
    const segment = { a, b, s: Math.clamp(stretch(jacobian(camera, (x0 + x1) / 2, (y0 + y1) / 2)), 0.25, 4) };
    segments.push(segment);
    if (edge) edges.push(segment);
  };
  for (let i = 0; i <= camera.columns; i++) {
    const x = r.x0 + (i * size);
    const edge = (i === 0) || (i === camera.columns);
    for (let j = 0; j < camera.rows; j++) addSegment(x, r.y0 + (j * size), x, r.y0 + ((j + 1) * size), edge);
  }
  for (let j = 0; j <= camera.rows; j++) {
    const y = r.y0 + (j * size);
    const edge = (j === 0) || (j === camera.rows);
    for (let i = 0; i < camera.columns; i++) addSegment(r.x0 + (i * size), y, r.x0 + ((i + 1) * size), y, edge);
  }

  const stroke = (list, width, lineColor, lineAlpha) => {
    for (const { a, b, s } of list) {
      gridGraphics.lineStyle({ width: width(s), color: lineColor, alpha: lineAlpha });
      gridGraphics.moveTo(a.x, a.y);
      gridGraphics.lineTo(b.x, b.y);
    }
  };
  if (alpha > 0) {
    // A faint contrasting outline keeps the grid visible on light and dark maps alike
    stroke(segments, s => (thickness * s) + 2, contrastColor(color), alpha * 0.4);
    stroke(segments, s => thickness * s, color, alpha);
  }
  if (state.editing) stroke(edges, s => Math.max(3, size / 25) * s, EDIT_COLOR, 0.9);
}

// The scene's own grid is replaced by the perspective grid
function setFoundryGridHidden(hidden) {
  const mesh = canvas.interface?.grid?.mesh;
  if (hidden) {
    if (!mesh) return;
    if (hiddenFoundryGrid?.mesh !== mesh) hiddenFoundryGrid = { mesh, visible: mesh.visible };
    mesh.visible = false;
    return;
  }
  if (hiddenFoundryGrid && !hiddenFoundryGrid.mesh.destroyed) hiddenFoundryGrid.mesh.visible = hiddenFoundryGrid.visible;
  hiddenFoundryGrid = null;
}

function getMapMeshes() {
  const primary = canvas.primary;
  if (!primary) return [];
  if (primary.levelTextures?.length) return primary.levelTextures.filter(mesh => !mesh.destroyed);
  return [primary.background, primary.foreground].filter(mesh => mesh && !mesh.destroyed);
}

// Draw the map image(s) through the perspective as a finely subdivided mesh and hide the originals
function updateWarpedMaps() {
  if (!state.warpMap || !canvas.primary) {
    removeWarpedMaps();
    return;
  }
  for (const original of getMapMeshes()) {
    let entry = warpedMaps.find(e => e.original === original);
    if (!entry) {
      entry = { original, visible: original.visible, mesh: null };
      warpedMaps.push(entry);
    }
    if (!entry.visible || !original.texture?.valid) continue;
    original.visible = false;
    entry.mesh = buildWarpedMesh(original, entry.mesh);
  }
}

function destroyWarpedMesh(mesh) {
  if (!mesh || mesh.destroyed) return;
  const geometry = mesh.geometry;
  mesh.destroy();
  for (const buffer of geometry?.buffers ?? []) buffer.destroy();
  geometry?.destroy();
}

function removeWarpedMaps() {
  for (const { original, visible, mesh } of warpedMaps) {
    if (!original.destroyed) original.visible = visible;
    destroyWarpedMesh(mesh);
  }
  warpedMaps = [];
}

// Tiles are part of the map: warp them with it
function updateWarpedTile(tile) {
  const original = tile.mesh;
  let entry = warpedTiles.get(tile.id);
  if (entry && (entry.original !== original)) {
    removeWarpedTile(tile.id);
    entry = null;
  }
  if (!state.warpMap || !original || original.destroyed || !original.texture?.valid) {
    if (entry) removeWarpedTile(tile.id);
    return;
  }
  if (!entry) {
    entry = { original, mesh: null };
    warpedTiles.set(tile.id, entry);
  }
  original.visible = false;
  entry.mesh = buildWarpedMesh(original, entry.mesh);
  entry.mesh.visible = tile.visible;
}

function removeWarpedTile(id) {
  const entry = warpedTiles.get(id);
  if (!entry) return;
  warpedTiles.delete(id);
  if (!entry.original.destroyed) entry.original.visible = canvas.tiles?.get(id)?.visible ?? true;
  destroyWarpedMesh(entry.mesh);
}

function buildWarpedMesh(original, mesh) {
  const n = MAP_SUBDIVISIONS;
  const camera = state.current;
  const texture = original.texture;
  const { width: textureWidth, height: textureHeight } = texture;
  const { x: anchorX, y: anchorY } = original.anchor;
  const { x: scaleX, y: scaleY } = original.scale;
  const cos = Math.cos(original.rotation);
  const sin = Math.sin(original.rotation);
  const { x: px, y: py } = original.position;

  // Where the image is on the floor (as Foundry places it), then through the camera
  const vertices = new Float32Array((n + 1) * (n + 1) * 2);
  const uvs = new Float32Array((n + 1) * (n + 1) * 2);
  const valid = new Uint8Array((n + 1) * (n + 1));
  for (let j = 0, k = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++, k++) {
      const u = i / n;
      const v = j / n;
      const lx = (u - anchorX) * textureWidth * scaleX;
      const ly = (v - anchorY) * textureHeight * scaleY;
      const p = floorToPicture(camera, px + (cos * lx) - (sin * ly), py + (sin * lx) + (cos * ly));
      vertices[k * 2] = p.x;
      vertices[(k * 2) + 1] = p.y;
      uvs[k * 2] = u;
      uvs[(k * 2) + 1] = v;
      valid[k] = p.valid ? 1 : 0;
    }
  }

  // Drop the quads that would be behind the camera
  const indices = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = (j * (n + 1)) + i;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      if (valid[a] && valid[b] && valid[c] && valid[d]) indices.push(a, b, d, a, d, c);
    }
  }

  if (!mesh || mesh.destroyed) {
    mesh = new PIXI.Mesh(new PIXI.MeshGeometry(vertices, uvs, new Uint16Array(indices)), new PIXI.MeshMaterial(texture));
    mesh.name = `isometric-perspective-${original.name ?? "map"}`;
    mesh.eventMode = "none";
  } else {
    mesh.geometry.getBuffer("aVertexPosition").update(vertices);
    mesh.geometry.getIndex().update(new Uint16Array(indices));
  }
  mesh.texture = texture;
  mesh.tint = original.tint ?? 0xFFFFFF;
  mesh.alpha = original.alpha;
  placeOnFloor(mesh, original);
  return mesh;
}

// ----------------- Tokens -----------------

function getTokens() {
  if (!canvas.tokens) return [];
  return [...canvas.tokens.placeables, ...(canvas.tokens.preview?.children ?? [])];
}

// Called from the token/tile refresh.
export function applyPerspectiveToPlaceable(object) {
  if (object instanceof foundry.canvas.placeables.Tile) {
    updateWarpedTile(object);
    return;
  }
  if (!(object instanceof foundry.canvas.placeables.Token)) return;
  const mesh = object.mesh;
  if (!mesh || mesh.destroyed || !mesh.texture) return;

  // Reset the mesh to Foundry's own size/scale for the current document state
  const doc = object.document;
  try {
    if (typeof object._refreshMeshSizeAndScale === 'function') object._refreshMeshSizeAndScale();
    else {
      const { width, height } = doc.getSize();
      const { fit, scaleX, scaleY } = doc.texture;
      mesh.resize(width, height, { fit, scaleX, scaleY });
    }
  } catch (error) {
    if (isometricModuleConfig.DEBUG_PRINT) console.warn("Perspective: unable to size token mesh", error);
    return;
  }

  const artScale = doc.getFlag(isometricModuleConfig.MODULE_ID, 'scale') ?? 1;
  mesh._isoPerspectiveBase = { x: mesh.scale.x * artScale, y: mesh.scale.y * artScale };
  placeToken(object, displayPoint(object.center.x, object.center.y));
}

// Draw a token at a picture point (its feet). `bounce` scales the art, for walk animations of other modules.
// The token container stays at the document position (other modules check it), its pivot centers it instead.
function placeToken(object, center, bounce = 1) {
  const mesh = object.mesh;
  const base = mesh?._isoPerspectiveBase;
  if (!base || mesh.destroyed || !mesh.texture) return;

  const MODULE_ID = isometricModuleConfig.MODULE_ID;
  const doc = object.document;
  const { width, height } = doc.getSize();
  const J = jacobianAtPicture(state.current, center.x, center.y);
  const baseX = base.x * bounce;
  const baseY = base.y * bounce;
  const halfX = width / 2;
  const halfY = height / 2;
  const offsetX = object.position.x - center.x;
  const offsetY = object.position.y - center.y;

  // Flat: the token lies on the floor and follows the shape of its cell
  if (!isTokenStanding(object)) {
    const det = (J.xx * J.yy) - (J.xy * J.yx);
    if (!det) return;
    object.pivot.set(
      halfX + (((J.yy * offsetX) - (J.xy * offsetY)) / det),
      halfY + (((J.xx * offsetY) - (J.yx * offsetX)) / det)
    );
    tokenMatrix.set(J.xx, J.yx, J.xy, J.yy,
      center.x - ((J.xx * halfX) + (J.xy * halfY)),
      center.y - ((J.yx * halfX) + (J.yy * halfY)));
    object.transform.setFromMatrix(tokenMatrix);
    object.hitArea = object.shape;

    const angle = Math.toRadians(doc.lockRotation ? 0 : doc.rotation);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    meshMatrix.set(
      ((J.xx * cos) + (J.xy * sin)) * baseX, ((J.yx * cos) + (J.yy * sin)) * baseX,
      ((J.xy * cos) - (J.xx * sin)) * baseY, ((J.yy * cos) - (J.yx * sin)) * baseY,
      center.x, center.y
    );
    mesh.anchor.set(doc.texture.anchorX, doc.texture.anchorY);
    mesh.transform.setFromMatrix(meshMatrix);
    restoreEffects(object);
    recordPlacement(object, center);
    return;
  }

  // Standing: upright on the center of its cell, as big as the cell it stands on
  const s = stretch(J);
  if (!s) return;
  object.rotation = 0;
  object.skew.set(0, 0);
  object.scale.set(s, s);
  object.pivot.set(halfX + (offsetX / s), halfY + (offsetY / s));

  const ratio = canvas.grid.size / 100;
  const right = (doc.getFlag(MODULE_ID, 'offsetY') ?? 0) * ratio;
  let up = (doc.getFlag(MODULE_ID, 'offsetX') ?? 0) * ratio;
  if (state.heightAdjust) up += (doc.elevation ?? 0) * canvas.grid.size / canvas.grid.distance;
  mesh.anchor.set(0.5, 1);
  meshMatrix.set(s * baseX, 0, 0, s * baseY, center.x + (s * right), center.y - (s * up));
  mesh.transform.setFromMatrix(meshMatrix);

  // Let the standing art be clicked, not only its footprint (token-local, unscaled px)
  const artWidth = Math.abs(baseX) * mesh.texture.width;
  const artHeight = Math.abs(baseY) * mesh.texture.height;
  const artLeft = (width / 2) + right - (artWidth / 2);
  const artRight = artLeft + artWidth;
  const artTop = (height / 2) - up - artHeight;
  const left = Math.min(0, artLeft);
  const rightEdge = Math.max(width, artRight);
  const top = Math.min(0, artTop);
  object.hitArea = new PIXI.Rectangle(left, top, rightEdge - left, height - top);
  layoutStandingEffects(object, artLeft, artRight, artTop, artHeight);
  recordPlacement(object, center);
}

// Status effects of a standing token: a column beside the art, from its top down (token-local, unscaled px).
// Same icon size and background as Foundry, which lays them out over the footprint instead.
function layoutStandingEffects(object, artLeft, artRight, artTop, artHeight) {
  const effects = object.effects;
  if (!effects || effects.destroyed) return;
  const s = canvas.dimensions.uiScale;
  const size = 20 * s;
  const rows = Math.max(1, Math.floor((artHeight / size) + 1e-6));
  const bg = effects.bg;
  bg?.clear().beginFill(0x000000, 0.40).lineStyle(s, 0x000000);
  let i = 0;
  for (const effect of effects.children) {
    if (effect === bg) continue;
    if (effect === effects.overlay) {
      effect.width = effect.height = Math.min(artRight - artLeft, artHeight) * 0.6;
      effect.anchor?.set(0.5, 0.5);
      effect.position.set((artLeft + artRight) / 2, artTop + (artHeight / 2));
      continue;
    }
    effect.width = effect.height = size;
    effect.position.set(artRight + s + (Math.floor(i / rows) * size), artTop + ((i % rows) * size));
    bg?.drawRoundedRect(effect.x + s, effect.y + s, size - (2 * s), size - (2 * s), 2 * s);
    i++;
  }
  effects._isoPerspectiveColumn = true;
}

// Give a token that lies flat (again) Foundry's own status layout
function restoreEffects(object) {
  if (!object.effects?._isoPerspectiveColumn) return;
  object.effects._isoPerspectiveColumn = false;
  object._refreshEffects?.();
}

// Remember exactly what was set, to notice when something else changes it
function recordPlacement(object, center) {
  const mesh = object.mesh;
  mesh._isoPerspective = {
    center: { x: center.x, y: center.y },
    mx: mesh.position.x, my: mesh.position.y, msx: mesh.scale.x, msy: mesh.scale.y,
    mr: mesh.rotation, mkx: mesh.skew.x, mky: mesh.skew.y,
    px: object.position.x, py: object.position.y, sx: object.scale.x, sy: object.scale.y,
    vx: object.pivot.x, vy: object.pivot.y, r: object.rotation
  };
}

let tokenGuardInstalled = false;

// Movement animations of other modules (Smooth Move...) write the token mesh every frame, turning and
// resizing it. Right before each render, put changed tokens back on their perspective footing: keep the
// position the animation chose and its bounce, restore the size of the cell and the upright pose.
function installTokenGuard() {
  if (tokenGuardInstalled || !canvas.app?.ticker) return;
  tokenGuardInstalled = true;
  canvas.app.ticker.add(guardTokens, null, PIXI.UPDATE_PRIORITY.LOW + 0.5);
}

function guardTokens() {
  if (!state.active || !canvas.ready) return;
  for (const token of getTokens()) {
    const mesh = token.mesh;
    const placed = mesh?._isoPerspective;
    if (!placed || mesh.destroyed || token.destroyed) continue;
    const moved = (mesh.position.x !== placed.mx) || (mesh.position.y !== placed.my);
    const changed = moved
      || (mesh.scale.x !== placed.msx) || (mesh.scale.y !== placed.msy) || (mesh.rotation !== placed.mr)
      || (mesh.skew.x !== placed.mkx) || (mesh.skew.y !== placed.mky)
      || (token.position.x !== placed.px) || (token.position.y !== placed.py)
      || (token.scale.x !== placed.sx) || (token.scale.y !== placed.sy)
      || (token.pivot.x !== placed.vx) || (token.pivot.y !== placed.vy) || (token.rotation !== placed.r);
    if (!changed) continue;

    // Animations move the mesh to the token center along their path
    const center = moved ? displayPoint(mesh.position.x, mesh.position.y) : placed.center;
    const animationBase = token._smActive ? token._smBaseScale?.x : null;
    let bounce = animationBase ? Math.abs(mesh.scale.x / animationBase) : 1;
    if (!Number.isFinite(bounce)) bounce = 1;
    placeToken(token, center, Math.clamp(bounce, 0.5, 2));
  }
}

// Draw tokens closer to the camera (lower in the picture) above the ones further away.
export function applyPerspectiveDepthSort() {
  if (!state.active || !canvas.primary) return;
  const TOKENS = foundry.canvas.groups.PrimaryCanvasGroup.SORT_LAYERS.TOKENS;
  const depth = (mesh) => {
    const object = mesh.object;
    if (object instanceof foundry.canvas.placeables.Token) return object.center.y;
    return object.bounds?.bottom ?? (object.document.y + object.document.height);
  };

  const meshes = canvas.primary.children.filter(mesh => (mesh.sortLayer === TOKENS) && mesh.object?.document);
  meshes.sort((a, b) => (depth(a) - depth(b)) || ((a.object.center?.x ?? 0) - (b.object.center?.x ?? 0)));
  meshes.forEach((mesh, index) => mesh.sort = index);
  canvas.primary.sortDirty = true;
}
