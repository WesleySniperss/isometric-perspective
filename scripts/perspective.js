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
const STEP_HOP = 0.5;          // standing art hops by this share of the walk bounce times its height (12% bounce: 6%)
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
const markerMatrix = new PIXI.Matrix();
const cameraListeners = [];
let cameraKey = "";
let floorComputations = 0;   // > 0 while Foundry code runs on the floor (region shapes, see perspective-shapes.js)
const sceneCameras = new Map();   // scene id -> { key, camera }, for scenes that are not on the canvas

export function isPerspectiveActive() {
  return state.active;
}

// "Grid and Map": the map, tiles and tokens follow the camera
export function isPerspectiveMapWarped() {
  return state.active && state.warpMap;
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
  if (state.active && scene?.dimensions) {
    state.current = buildCamera(scene, flags);
    state.previewing = isPerspectiveFlags(savedFlags) && (Object.keys(overrides).length > 0);
    state.saved = state.previewing ? buildCamera(scene, savedFlags) : state.current;
  }
  notifyCameraChange(scene);
  return state.active;
}

// Things placed on the floor (region shapes...) are computed with the saved camera: tell when it changed
export function onPerspectiveCameraChange(listener) {
  cameraListeners.push(listener);
}

function notifyCameraChange(scene) {
  const camera = (state.active && scene?.dimensions) ? state.saved.m.map(value => value.toPrecision(12)).join(",") : "none";
  const key = `${scene?.id}|${camera}`;
  if (key === cameraKey) return;
  cameraKey = key;
  for (const listener of cameraListeners) {
    try {
      listener(scene);
    } catch (error) {
      console.error("Isometric Perspective | perspective camera listener failed", error);
    }
  }
}

// Foundry code that is run on the floor (shapes computed in floor coordinates) measures and snaps on the floor itself
export function computeOnFloor(callback) {
  floorComputations++;
  try {
    return callback();
  } finally {
    floorComputations--;
  }
}

export function isComputingOnFloor() {
  return floorComputations > 0;
}

// The saved camera of a scene in perspective, or null. Also for scenes that are not on the canvas: region shapes of
// any scene lie on its floor, for whichever client computes them.
export function getSceneCamera(scene) {
  if (!scene) return null;
  if (scene === canvas.scene) return state.active ? state.saved : null;
  const flags = scene.flags?.[isometricModuleConfig.MODULE_ID] ?? {};
  if (!isPerspectiveFlags(flags) || !scene.dimensions) return null;
  const key = JSON.stringify([flags, scene.dimensions.sceneRect, scene.dimensions.size]);
  let entry = sceneCameras.get(scene.id);
  if (entry?.key !== key) sceneCameras.set(scene.id, entry = { key, camera: buildCamera(scene, flags) });
  return entry.camera;
}

// The floor point (scene px on the floor) under a picture point, and the picture point of a floor point
export function perspectiveFloorPoint(x, y, camera = state.saved) {
  return pictureToFloor(camera, x, y);
}

export function perspectivePicturePoint(x, y, camera = state.saved) {
  return floorToPicture(camera, x, y);
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
  notifyCameraChange(canvas.scene);
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
  if (!state.active || !state.warpMap || !previous || !scene || (previous === state.saved)) return;
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

// Tokens keep their cells when a scene enters or leaves "Grid and Map": outside of it token positions are floor
// (top-down) positions, inside they are picture positions. "Grid Only" leaves them on the picture, where they
// stand on the painted map. Run by the user who changed the scene.
export async function convertTokenPositions(scene, fromCamera, toCamera) {
  if (!scene?.dimensions || (!fromCamera && !toCamera)) return;
  const size = scene.dimensions.size;
  const updates = [];
  for (const token of scene.tokens) {
    const { x, y, width, height } = token._source;
    const halfX = width * size / 2;
    const halfY = height * size / 2;
    let point = { x: x + halfX, y: y + halfY, valid: true };
    if (fromCamera) point = pictureToFloor(fromCamera, point.x, point.y);
    if (point.valid && toCamera) point = floorToPicture(toCamera, point.x, point.y);
    if (!point.valid) continue;
    let nx = Math.round(point.x - halfX);
    let ny = Math.round(point.y - halfY);
    // Back on the top-down grid: undo the rounding of the projection so tokens sit exactly on their cells
    if (!toCamera) {
      const align = (value) => {
        const snapped = Math.round(value / (size / 2)) * (size / 2);
        return (Math.abs(snapped - value) <= 2) ? snapped : value;
      };
      nx = align(nx);
      ny = align(ny);
    }
    if ((nx !== x) || (ny !== y)) updates.push({ _id: token.id, x: nx, y: ny });
  }
  if (updates.length) await scene.updateEmbeddedDocuments("Token", updates, { animate: false });
}

// For other modules, e.g. movement animations that step from cell to cell:
// game.modules.get("isometric-perspective").api.perspective
export const perspectiveApi = {
  isActive: () => state.active,

  // Whether this module sets the size of the token mesh (perspective scenes, standing art), so a size larger
  // than the document would give is intended
  managesToken: (token) => state.active || !!token?.mesh?._isoOwnTexture,

  // Centers of the perspective cells a path of token centers (picture px) goes through, one point per step,
  // or null when the path leaves the floor
  expandPath(points, token) {
    if (!state.active || !Array.isArray(points) || (points.length < 2)) return null;
    const camera = state.saved;
    const size = canvas.grid.size;
    const width = token?.document?.width ?? 1;
    const height = token?.document?.height ?? 1;
    const toCell = (p) => {
      const floor = pictureToFloor(camera, p.x, p.y);
      if (!floor.valid) return null;
      return {
        u: snapAxis(floor.x / size, width, camera.column0, camera.columns),
        v: snapAxis(floor.y / size, height, camera.row0, camera.rows)
      };
    };
    const toPicture = ({ u, v }) => {
      const p = floorToPicture(camera, u * size, v * size);
      return { x: p.x, y: p.y };
    };
    const result = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = toCell(points[i]);
      const b = toCell(points[i + 1]);
      if (!a || !b) return null;
      if (i === 0) result.push(toPicture(a));
      let { u, v } = a;
      while ((Math.abs(b.u - u) > 1e-6) || (Math.abs(b.v - v) > 1e-6)) {
        u += Math.sign(b.u - u) * Math.min(1, Math.abs(b.u - u));
        v += Math.sign(b.v - v) * Math.min(1, Math.abs(b.v - v));
        result.push(toPicture({ u, v }));
      }
    }
    return (result.length >= 2) ? result : null;
  }
};

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
  if (!state.previewing || !state.warpMap) return { x, y };
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
// Distances are measured on the floor, but terrain (regions with movement costs) is where it is drawn on the
// picture: the grid offsets handed to cost functions are moved back onto the picture.
function toPictureOffset(grid, offset) {
  if (!offset || (offset.i === undefined)) return offset;
  const size = grid.size;
  const point = grid.isGridless
    ? floorToPicture(state.saved, offset.j, offset.i)
    : floorToPicture(state.saved, (offset.j + 0.5) * size, (offset.i + 0.5) * size);
  if (!point.valid) return offset;
  const picture = grid.getOffset({ x: point.x, y: point.y });
  return (offset.k !== undefined) ? { i: picture.i, j: picture.j, k: offset.k } : { i: picture.i, j: picture.j };
}

function onPictureCost(grid, cost) {
  if (typeof cost !== "function") return cost;
  return (from, to, distance, segment) => cost(toPictureOffset(grid, from), toPictureOffset(grid, to), distance, segment);
}

function toFloorWaypoint(grid, waypoint) {
  const camera = state.saved;
  const size = grid.size;
  if (typeof waypoint.cost === "function") waypoint = { ...waypoint, cost: onPictureCost(grid, waypoint.cost) };
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

// The perspective cells a token covers along a movement path, as picture polygons (and their centers), for the ruler
// to highlight. Waypoints are token positions (top-left, picture px, size in grid units); later waypoints win shared cells.
export function getPerspectivePathCells(waypoints) {
  if (!state.active || !waypoints?.length) return [];
  const camera = state.saved;
  const size = canvas.grid.size;
  const cells = new Map();
  const cover = (waypoint, u, v) => {
    const width = Math.max(Math.round(waypoint.width ?? 1), 1);
    const height = Math.max(Math.round(waypoint.height ?? 1), 1);
    const column = Math.round(u - (width / 2));
    const row = Math.round(v - (height / 2));
    for (let i = column; i < column + width; i++) {
      for (let j = row; j < row + height; j++) {
        const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([a, b]) => floorToPicture(camera, a * size, b * size));
        if (corners.some(p => !p.valid)) continue;
        const { x, y } = floorToPicture(camera, (i + 0.5) * size, (j + 0.5) * size);
        cells.set(`${i},${j}`, { waypoint, points: corners.flatMap(p => [p.x, p.y]), center: { x, y } });
      }
    }
  };
  let previous = null;
  for (const waypoint of waypoints) {
    const width = waypoint.width ?? 1;
    const height = waypoint.height ?? 1;
    const floor = pictureToFloor(camera, waypoint.x + (width * size / 2), waypoint.y + (height * size / 2));
    if (!floor.valid) {
      previous = null;
      continue;
    }
    const u = snapAxis(floor.x / size, width, camera.column0, camera.columns);
    const v = snapAxis(floor.y / size, height, camera.row0, camera.rows);
    if (previous) {
      // Step through the cells in between, diagonally first, as tokens walk
      let { u: pu, v: pv } = previous;
      while ((Math.abs(u - pu) > 1e-6) || (Math.abs(v - pv) > 1e-6)) {
        pu += Math.sign(u - pu) * Math.min(1, Math.abs(u - pu));
        pv += Math.sign(v - pv) * Math.min(1, Math.abs(v - pv));
        cover(waypoint, pu, pv);
      }
    }
    cover(waypoint, u, v);
    previous = { u, v };
  }
  return [...cells.values()];
}

// Wrap Foundry's snapping, keyboard movement and measurement (installed once, on init).
export function installPerspectivePatches() {
  const TokenDocument = foundry.documents.TokenDocument;
  const originalSnap = TokenDocument.prototype.getSnappedPosition;
  TokenDocument.prototype.getSnappedPosition = function (data = {}) {
    const snapped = originalSnap.call(this, data);
    if (!state.active || floorComputations || !this.parent || (this.parent !== canvas.scene)) return snapped;
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
    if (!state.active || floorComputations || !scene || ((this !== scene.grid) && (this !== scene.gridlessGrid))) {
      return originalMeasure.call(this, waypoints, options);
    }
    const floorOptions = (typeof options?.cost === "function") ? { ...options, cost: onPictureCost(this, options.cost) } : options;
    return originalMeasure.call(this, waypoints.map(waypoint => toFloorWaypoint(this, waypoint)), floorOptions);
  };

  Hooks.on("deleteTile", (document) => removeWarpedTile(document.id));

  const module = game.modules.get(isometricModuleConfig.MODULE_ID);
  if (module) module.api = { ...(module.api ?? {}), perspective: perspectiveApi };
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

  // Standing tokens can show their own full-height art
  const doc = object.document;
  const standingTexture = isTokenStanding(object) ? getStandingImage(object) : null;
  useStandingImage(object, standingTexture);

  // Reset the mesh to Foundry's own size/scale for the current document state
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
  if (standingTexture) {
    // As tall as set in the token (in cells), keeping the proportions of the image
    const scale = getStandingHeight(object) * canvas.grid.size * artScale / standingTexture.height;
    mesh._isoPerspectiveBase = {
      x: scale * Math.sign(doc.texture.scaleX || 1),
      y: scale * Math.sign(doc.texture.scaleY || 1)
    };
  }
  else mesh._isoPerspectiveBase = { x: mesh.scale.x * artScale, y: mesh.scale.y * artScale };
  placeToken(object, displayPoint(object.center.x, object.center.y));
}

// ----------------- Standing images -----------------

export const STANDING_HEIGHT = 1.7;   // cells
const standingTextures = new Map();   // src -> PIXI.Texture once loaded, a Promise while loading, null if it failed

// Where the full-height art of a standing token comes from: its Standing Image, or else the actor portrait.
// Without either (no actor, or the default portrait) the token keeps its own image.
export function getStandingSource(token) {
  const image = token.document?.getFlag(isometricModuleConfig.MODULE_ID, "perspectiveStandingImage");
  if (image) return image;
  const portrait = token.actor?.img;
  const defaults = [CONST.DEFAULT_TOKEN, foundry.documents.BaseActor?.DEFAULT_ICON];
  return (portrait && !defaults.includes(portrait)) ? portrait : null;
}

// The full-height art of a token for when it stands, once loaded
export function getStandingImage(token) {
  const src = getStandingSource(token);
  if (!src) return null;
  const cached = standingTextures.get(src);
  if (cached instanceof PIXI.Texture) return cached.valid ? cached : null;
  if (cached === undefined) {
    const load = foundry.canvas.loadTexture ?? globalThis.loadTexture;
    const loading = Promise.resolve(load(src)).then(texture => {
      standingTextures.set(src, texture ?? null);
      for (const t of canvas.tokens?.placeables ?? []) {
        if (getStandingSource(t) === src) t.renderFlags.set({ refreshMesh: true, refreshSize: true });
      }
    }).catch(() => standingTextures.set(src, null));
    standingTextures.set(src, loading);
  }
  return null;
}

// Height of the standing art, in cells
export function getStandingHeight(token) {
  return Math.clamp(readNumber(token.document?.getFlag(isometricModuleConfig.MODULE_ID, "perspectiveStandingHeight"), STANDING_HEIGHT), 0.25, 4);
}

// Put the standing art on the token mesh, or give the mesh its own texture back. Dynamic rings are left out
// while the standing art is shown, the ring shader would clip it to the ring.
export function useStandingImage(token, texture) {
  const mesh = token.mesh;
  if (!mesh || mesh.destroyed) return;
  if (texture) {
    if (mesh.texture === texture) return;
    mesh._isoOwnTexture ??= mesh.texture;
    mesh.texture = texture;
    if (token.hasDynamicRing) mesh.setShaderClass(foundry.canvas.rendering.shaders.PrimaryBaseSamplerShader);
    return;
  }
  if (!mesh._isoOwnTexture) return;
  mesh.texture = mesh._isoOwnTexture;
  delete mesh._isoOwnTexture;
  token._refreshShader?.();
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
    removeElevationMarker(object);
    restoreEffects(object);
    drawFootprint(object, center, (q) => ({
      x: object.pivot.x + (((J.yy * (q.x - object.position.x)) - (J.xy * (q.y - object.position.y))) / det),
      y: object.pivot.y + (((J.xx * (q.y - object.position.y)) - (J.yx * (q.x - object.position.x))) / det)
    }));
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

  // The bounce of a walk animation lifts the art a little on each step instead of growing it, which would stretch
  // a full-height figure
  const hop = (bounce - 1) * STEP_HOP * Math.abs(base.y) * mesh.texture.height;
  const ratio = canvas.grid.size / 100;
  const right = (doc.getFlag(MODULE_ID, 'offsetY') ?? 0) * ratio;
  const lift = state.heightAdjust ? (doc.elevation ?? 0) * canvas.grid.size / canvas.grid.distance : 0;
  const up = ((doc.getFlag(MODULE_ID, 'offsetX') ?? 0) * ratio) + lift + hop;
  mesh.anchor.set(0.5, 1);
  meshMatrix.set(s * base.x, 0, 0, s * base.y, center.x + (s * right), center.y - (s * up));
  mesh.transform.setFromMatrix(meshMatrix);
  drawElevationMarker(object, J, s, s * base.x, s * base.y, { x: -s * right, y: s * up }, s * lift);

  // Let the standing art be clicked, not only its footprint (token-local, unscaled px)
  const artWidth = Math.abs(base.x) * mesh.texture.width;
  const artHeight = Math.abs(base.y) * mesh.texture.height;
  const artLeft = (width / 2) + right - (artWidth / 2);
  const artRight = artLeft + artWidth;
  const artTop = (height / 2) - up - artHeight;
  const left = Math.min(0, artLeft);
  const rightEdge = Math.max(width, artRight);
  const top = Math.min(0, artTop);
  object.hitArea = new PIXI.Rectangle(left, top, rightEdge - left, height - top);
  layoutStandingEffects(object, artLeft, artRight, artTop, artHeight);
  drawFootprint(object, center, (q) => ({
    x: object.pivot.x + ((q.x - object.position.x) / s),
    y: object.pivot.y + ((q.y - object.position.y) / s)
  }));
  recordPlacement(object, center);
}

// The selection border follows the cells the token stands on, as drawn in perspective.
// `toLocal` turns a picture point into the token's own coordinates.
function drawFootprint(object, center, toLocal) {
  const border = object.border;
  if (!border || border.destroyed) return;
  const floor = pictureToFloor(state.current, center.x, center.y);
  if (!floor.valid) return;
  const { width, height } = object.document.getSize();
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const p = floorToPicture(state.current, floor.x + (sx * width / 2), floor.y + (sy * height / 2));
    return toLocal(p);
  });
  if (corners.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return;
  foundry.canvas.borders.drawBorder(border, new PIXI.Polygon(corners.flatMap(p => [p.x, p.y])),
    { alignment: 1, dashed: object.document.hidden });
}

// Tokens lifted by their elevation (Enable Height Adjustment): a faint shadow on their cell and a dashed line up to
// their feet, so it is clear where on the floor a flying token is (Enable Token Visuals). Drawn with the token art,
// so it is lit, hidden and sorted like it. `ground` is the cell center seen from the feet and `lift` the height of
// the feet above it, in picture px; `s` is the size of the floor there.
function drawElevationMarker(object, J, s, scaleX, scaleY, ground, lift) {
  const mesh = object.mesh;
  if (!(lift > 0) || !game.settings.get(isometricModuleConfig.MODULE_ID, "enableTokenVisuals")) {
    removeElevationMarker(object);
    return;
  }
  let marker = mesh._isoElevationMarker;
  if (!marker || marker.destroyed || (marker.parent !== mesh)) {
    marker = mesh._isoElevationMarker = mesh.addChild(new PIXI.Graphics());
    marker.name = "isometric-elevation-marker";
    marker.eventMode = "none";
  }
  // Undo the scale of the art, to draw in picture px
  marker.transform.setFromMatrix(markerMatrix.set(1 / scaleX, 0, 0, 1 / scaleY, 0, 0));
  marker.clear();

  // The shadow lies on the floor: a circle on the cell, seen through the camera
  const radius = 0.3 * canvas.grid.size * Math.min(object.document.width, object.document.height);
  const shadow = [];
  for (let i = 0; i < 32; i++) {
    const a = 2 * Math.PI * i / 32;
    const dx = radius * Math.cos(a);
    const dy = radius * Math.sin(a);
    shadow.push(ground.x + (J.xx * dx) + (J.xy * dy), ground.y + (J.yx * dx) + (J.yy * dy));
  }
  marker.beginFill(0x000000, 0.25).drawPolygon(shadow).endFill();

  const top = { x: ground.x, y: ground.y - lift };
  const size = canvas.grid.size * s;
  drawDashedLine(marker, ground, top, { width: Math.max(size * 0.04, 1) + 2, dash: size * 0.08, gap: size * 0.06, color: 0x000000, alpha: 0.3 });
  drawDashedLine(marker, ground, top, { width: Math.max(size * 0.04, 1), dash: size * 0.08, gap: size * 0.06, color: 0xFFFFFF, alpha: 0.65 });
}

function removeElevationMarker(object) {
  const mesh = object.mesh;
  const marker = mesh?._isoElevationMarker;
  if (!marker) return;
  if (!marker.destroyed) marker.destroy();
  delete mesh._isoElevationMarker;
}

// A dashed line, as PIXI only draws solid ones
export function drawDashedLine(graphics, from, to, { width, dash, gap, color, alpha }) {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (!(length > 0) || !(dash > 0)) return;
  const ux = (to.x - from.x) / length;
  const uy = (to.y - from.y) / length;
  graphics.lineStyle({ width, color, alpha, cap: PIXI.LINE_CAP.ROUND });
  for (let d = 0; d < length; d += dash + gap) {
    const e = Math.min(d + dash, length);
    graphics.moveTo(from.x + (ux * d), from.y + (uy * d));
    graphics.lineTo(from.x + (ux * e), from.y + (uy * e));
  }
  graphics.lineStyle(0);
}

// Status effects of a standing token: a column beside the art, from its top down (token-local, unscaled px).
// Same icon size and background as Foundry, which lays them out over the footprint instead.
// `frame` places the effects container (isometric scenes turn it upright), otherwise it sits on the token.
export function layoutStandingEffects(object, artLeft, artRight, artTop, artHeight, frame = null) {
  const effects = object.effects;
  if (!effects || effects.destroyed) return;
  setEffectsFrame(effects, frame);
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

function setEffectsFrame(effects, frame) {
  effects.position.set(frame?.x ?? 0, frame?.y ?? 0);
  effects.rotation = frame?.rotation ?? 0;
  effects.skew.set(frame?.skewX ?? 0, frame?.skewY ?? 0);
  effects.scale.set(frame?.scaleX ?? 1, frame?.scaleY ?? 1);
}

// Give a token that lies flat (again) Foundry's own status layout
export function restoreEffects(object) {
  if (!object.effects?._isoPerspectiveColumn) return;
  object.effects._isoPerspectiveColumn = false;
  setEffectsFrame(object.effects, null);
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
export function installTokenGuard() {
  if (tokenGuardInstalled || !canvas.app?.ticker) return;
  tokenGuardInstalled = true;
  canvas.app.ticker.add(guardTokens, null, PIXI.UPDATE_PRIORITY.LOW + 0.5);
}

function guardTokens() {
  if (!canvas.ready) return;
  for (const token of getTokens()) {
    const mesh = token.mesh;
    if (!mesh || mesh.destroyed || token.destroyed) continue;
    if (state.active) guardPerspectiveToken(token);
    else if (mesh._isoPlacement) guardIsometricToken(token);
  }
}

// Only step in for movement animations (Smooth Move owns the mesh while _smActive is set and its last frame, and
// moves it around drags and commits), or when the size was reset from the document outside of a refresh.
// Other effects on the mesh are left alone.
function shouldRestore(token) {
  const animating = !!(token._smActive || token._smCommitting || token._smStartPx);
  const justAnimated = !!token._isoWasAnimating;
  token._isoWasAnimating = animating;
  return animating || justAnimated || matchesDocumentScale(token);
}

// The scale Foundry gives the mesh from the document (Token#_refreshMeshSizeAndScale), for the current texture
function matchesDocumentScale(token) {
  const mesh = token.mesh;
  const texture = mesh.texture;
  if (!texture || (texture.width <= 1) || (texture.height <= 1)) return false;
  const { width, height } = token.document.getSize();
  let { fit = "fill", scaleX = 1, scaleY = 1 } = token.document.texture ?? {};
  if (token.hasDynamicRing && CONFIG.Token.ring?.isGridFitMode) {
    const adjustment = token.ring?.subjectScaleAdjustment ?? 1;
    scaleX *= adjustment;
    scaleY *= adjustment;
  }
  const fx = width / texture.width;
  const fy = height / texture.height;
  let sx;
  let sy;
  switch (fit) {
    case "cover": sx = sy = Math.max(fx, fy); break;
    case "contain": sx = sy = Math.min(fx, fy); break;
    case "width": sx = sy = fx; break;
    case "height": sx = sy = fy; break;
    default: sx = fx; sy = fy;
  }
  const close = (a, b) => Math.abs(Math.abs(a) - Math.abs(b)) <= (Math.abs(b) * 1e-4);
  return close(mesh.scale.x, sx * scaleX) && close(mesh.scale.y, sy * scaleY);
}

function animationBounce(token, axis) {
  const base = token._smActive ? token._smBaseScale?.[axis] : null;
  const bounce = base ? Math.abs(token.mesh.scale[axis] / base) : 1;
  return Number.isFinite(bounce) ? Math.clamp(bounce, 0.5, 2) : 1;
}

function guardPerspectiveToken(token) {
  const mesh = token.mesh;
  const placed = mesh._isoPerspective;
  if (!placed) return;
  const moved = (mesh.position.x !== placed.mx) || (mesh.position.y !== placed.my);
  const changed = moved
    || (mesh.scale.x !== placed.msx) || (mesh.scale.y !== placed.msy) || (mesh.rotation !== placed.mr)
    || (mesh.skew.x !== placed.mkx) || (mesh.skew.y !== placed.mky)
    || (token.position.x !== placed.px) || (token.position.y !== placed.py)
    || (token.scale.x !== placed.sx) || (token.scale.y !== placed.sy)
    || (token.pivot.x !== placed.vx) || (token.pivot.y !== placed.vy) || (token.rotation !== placed.r);
  if (!changed || !shouldRestore(token)) return;

  // Animations move the mesh to the token center along their path
  const center = moved ? displayPoint(mesh.position.x, mesh.position.y) : placed.center;
  placeToken(token, center, animationBounce(token, "x"));
}

// Isometric scenes: keep the upright pose and the isometric size while an animation moves the token
function guardIsometricToken(token) {
  const mesh = token.mesh;
  const p = mesh._isoPlacement;
  const moved = (mesh.position.x !== p.x) || (mesh.position.y !== p.y);
  const changed = moved || (mesh.rotation !== p.rotation) || (mesh.skew.x !== p.skewX) || (mesh.skew.y !== p.skewY)
    || (mesh.scale.x !== p.appliedX) || (mesh.scale.y !== p.appliedY);
  if (!changed || !shouldRestore(token)) return;

  const center = moved ? { x: mesh.position.x, y: mesh.position.y } : { x: p.cx ?? (p.x - p.offsetX), y: p.cy ?? (p.y - p.offsetY) };
  const bounce = animationBounce(token, "y");
  mesh.rotation = p.rotation;
  mesh.skew.set(p.skewX, p.skewY);
  mesh.anchor.set(p.anchorX, p.anchorY);
  if (mesh._isoStandingAnchor) {
    // Standing art steps up along its own height instead of growing (see placeToken)
    const hop = (bounce - 1) * STEP_HOP * Math.abs(p.scaleY) * mesh.texture.height;
    mesh.scale.set(p.scaleX, p.scaleY);
    mesh.position.set(center.x + p.offsetX + (Math.sin(p.rotation) * hop), center.y + p.offsetY - (Math.cos(p.rotation) * hop));
  } else {
    mesh.scale.set(p.scaleX * bounce, p.scaleY * bounce);
    mesh.position.set(center.x + p.offsetX, center.y + p.offsetY);
  }
  Object.assign(p, { x: mesh.position.x, y: mesh.position.y, cx: center.x, cy: center.y, appliedX: mesh.scale.x, appliedY: mesh.scale.y });
}

// Called by the isometric transformation once a token mesh is in place
export function recordIsometricPlacement(token) {
  const mesh = token.mesh;
  if (!mesh || mesh.destroyed) return;
  const center = token.center;
  mesh._isoPlacement = {
    rotation: mesh.rotation, skewX: mesh.skew.x, skewY: mesh.skew.y,
    scaleX: mesh.scale.x, scaleY: mesh.scale.y, appliedX: mesh.scale.x, appliedY: mesh.scale.y,
    anchorX: mesh.anchor.x, anchorY: mesh.anchor.y,
    offsetX: mesh.position.x - center.x, offsetY: mesh.position.y - center.y,
    x: mesh.position.x, y: mesh.position.y
  };
  installTokenGuard();
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
