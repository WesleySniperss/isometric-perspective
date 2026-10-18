import { isometricModuleConfig } from './consts.js';

// ----------------- Vanishing Point Perspective -----------------
//
// A virtual camera looks at the floor of the scene. The floor uses the scene's own coordinates and
// square grid: it is turned (rotation), leaned away from the viewer (tilt) and projected through a
// perspective homography (field of view), then scaled and moved over the scene (scale, position).
//
// The grid is drawn in perspective over the map. Optionally the map image is warped the same way;
// otherwise the map is left untouched, for maps that are already painted in perspective.
// Tokens snap to the perspective cells, are sized to the cell they stand on, and movement is measured
// on the floor, so distances count perspective cells. Walls, lights, tiles and drawings are not warped.

export const PERSPECTIVE_PROJECTION = 'Perspective (Vanishing Point)';

export const PERSPECTIVE_DEFAULTS = Object.freeze({
  tilt: 45,
  rotation: 0,
  fov: 60,
  scale: 1,
  offsetX: 0,
  offsetY: 0
});

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const MIN_DEPTH = 0.15;        // nearest drawable depth, relative to the center of the grid
const MAP_SUBDIVISIONS = 48;   // the warped map is drawn as a mesh of this many quads per side
const NEIGHBOR_STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

const state = {
  active: false,
  warpMap: false,
  flatTokens: false,
  heightAdjust: false,
  column0: 0,       // floor grid extent, in cells of the scene grid
  row0: 0,
  columns: 1,
  rows: 1,
  m: IDENTITY,      // floor (scene px) -> picture (scene px), row-major 3x3
  inv: IDENTITY     // picture -> floor
};

let gridGraphics = null;
let warpedMaps = [];
let hiddenFoundryGrid = null;
const tokenMatrix = new PIXI.Matrix();
const meshMatrix = new PIXI.Matrix();

export function isPerspectiveActive() {
  return state.active;
}

export function isPerspectiveStanding() {
  return state.active && !state.flatTokens;
}

function isPerspectiveScene(flags) {
  return !!(game.settings.get(isometricModuleConfig.MODULE_ID, "worldIsometricFlag") && flags.isometricEnabled
    && (flags.projectionType === PERSPECTIVE_PROJECTION));
}

// Read the perspective configuration of a scene (plus unsaved form values), without drawing anything.
// Called on canvasInit so placeables drawn for the new scene already know the mode.
export function configurePerspective(scene, overrides = {}) {
  const MODULE_ID = isometricModuleConfig.MODULE_ID;
  const flags = { ...(scene?.flags?.[MODULE_ID] ?? {}), ...overrides };
  state.active = isPerspectiveScene(flags);
  state.warpMap = !!flags.perspectiveWarpMap;
  state.flatTokens = !!flags.perspectiveFlatTokens;
  state.heightAdjust = game.settings.get(MODULE_ID, "enableHeightAdjustment");
  if (!state.active || !scene?.dimensions) return state.active;

  // The grid covers the whole map unless a size is given, and is centered on it
  const { size, sceneRect: rect } = scene.dimensions;
  const center = { x: rect.x + (rect.width / 2), y: rect.y + (rect.height / 2) };
  state.columns = Math.clamp(Math.round(readNumber(flags.perspectiveColumns, rect.width / size)), 1, 500);
  state.rows = Math.clamp(Math.round(readNumber(flags.perspectiveRows, rect.height / size)), 1, 500);
  state.column0 = Math.round((center.x / size) - (state.columns / 2));
  state.row0 = Math.round((center.y / size) - (state.rows / 2));

  state.m = buildCameraHomography({
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
  state.inv = invert3x3(state.m);
  return state.active;
}

// Turn the perspective view on (or update it) for the current scene.
export function applyPerspective(scene, overrides) {
  if (!configurePerspective(scene, overrides)) {
    removePerspective();
    return;
  }
  drawGrid();
  updateWarpedMaps();
  setFoundryGridHidden(true);
  for (const token of getTokens()) applyPerspectiveToPlaceable(token);
  applyPerspectiveDepthSort();
}

// Show unsaved values from the scene configuration on the canvas.
export function previewPerspective(scene, overrides) {
  if (!canvas.ready || (scene !== canvas.scene)) return;
  // Switching to or from the perspective projection redraws the canvas, so it can only be previewed once saved
  if (!isPerspectiveScene(scene.flags?.[isometricModuleConfig.MODULE_ID] ?? {})) return;
  applyPerspective(scene, isPerspectiveScene(overrides) ? overrides : undefined);
}

// Turn the perspective view off.
export function removePerspective() {
  state.active = false;
  clearPerspectiveObjects();
}

// Destroy everything drawn for the perspective view (also used when the canvas is torn down).
export function clearPerspectiveObjects() {
  if (gridGraphics && !gridGraphics.destroyed) gridGraphics.destroy();
  gridGraphics = null;
  removeWarpedMaps();
  setFoundryGridHidden(false);
}

function readNumber(value, fallback) {
  if ((value === null) || (value === undefined) || (value === "")) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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
function depthAt(x, y) {
  return (state.m[6] * x) + (state.m[7] * y) + state.m[8];
}

function floorToPicture(x, y) {
  const m = state.m;
  const depth = depthAt(x, y);
  const w = Math.max(depth, MIN_DEPTH);
  return {
    x: ((m[0] * x) + (m[1] * y) + m[2]) / w,
    y: ((m[3] * x) + (m[4] * y) + m[5]) / w,
    valid: depth >= MIN_DEPTH
  };
}

function pictureToFloor(x, y) {
  const m = state.inv;
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
function jacobian(x, y) {
  const m = state.m;
  const X = (m[0] * x) + (m[1] * y) + m[2];
  const Y = (m[3] * x) + (m[4] * y) + m[5];
  const w = Math.max(depthAt(x, y), MIN_DEPTH);
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

function gridRect(size) {
  return {
    x0: state.column0 * size,
    y0: state.row0 * size,
    x1: (state.column0 + state.columns) * size,
    y1: (state.row0 + state.rows) * size
  };
}

// Jacobian used to size a token standing at a picture point. Points outside the grid use the
// nearest edge of the grid, points beyond the horizon use its farthest corner.
function jacobianAtPicture(x, y) {
  const r = gridRect(canvas.grid.size);
  let floor = pictureToFloor(x, y);
  if (!floor.valid) {
    const corners = [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
    floor = corners.reduce((best, c) => (depthAt(c.x, c.y) > depthAt(best.x, best.y) ? c : best));
  }
  return jacobian(Math.clamp(floor.x, r.x0, r.x1), Math.clamp(floor.y, r.y0, r.y1));
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
  const size = canvas.grid.size;
  const width = readNumber(data.width, document.width) || 1;
  const height = readNumber(data.height, document.height) || 1;
  const x = readNumber(data.x, document.x);
  const y = readNumber(data.y, document.y);
  const floor = pictureToFloor(x + (width * size / 2), y + (height * size / 2));
  if (!floor.valid) return null;

  const u = floor.x / size;
  const v = floor.y / size;
  const margin = 0.5;
  if ((u < state.column0 - margin) || (u > state.column0 + state.columns + margin)
    || (v < state.row0 - margin) || (v > state.row0 + state.rows + margin)) return null;

  const center = floorToPicture(
    snapAxis(u, width, state.column0, state.columns) * size,
    snapAxis(v, height, state.row0, state.rows) * size
  );
  if (!center.valid) return null;
  return { x: center.x - (width * size / 2), y: center.y - (height * size / 2) };
}

// Keyboard movement: step to the neighbouring cell that moves the token closest to the pressed direction
// on screen (so the arrows still feel right when the grid is rotated). Null if the token is off the floor.
function shiftTokenPosition(token, dx, dy) {
  const size = canvas.grid.size;
  const { x, y, width, height } = token.document._source;
  const floor = pictureToFloor(x + (width * size / 2), y + (height * size / 2));
  if (!floor.valid) return null;

  const u = snapAxis(floor.x / size, width, state.column0, state.columns);
  const v = snapAxis(floor.y / size, height, state.row0, state.rows);
  const from = floorToPicture(u * size, v * size);
  const length = Math.hypot(dx, dy);
  let best = { alignment: 0.5, to: from };
  for (const [du, dv] of NEIGHBOR_STEPS) {
    const nu = clampCenter(u + du, width, state.column0, state.columns);
    const nv = clampCenter(v + dv, height, state.row0, state.rows);
    if ((nu === u) && (nv === v)) continue;
    const to = floorToPicture(nu * size, nv * size);
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
  const size = grid.size;
  if ((waypoint.width === undefined) || (waypoint.height === undefined)) {
    const floor = pictureToFloor(waypoint.x, waypoint.y);
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
  const floor = pictureToFloor(waypoint.x - anchorX + halfX, waypoint.y - anchorY + halfY);
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

function drawGrid() {
  if (!canvas.primary) return;
  if (!gridGraphics || gridGraphics.destroyed) {
    gridGraphics = new PIXI.smooth.SmoothGraphics();
    gridGraphics.name = "isometric-perspective-grid";
    gridGraphics.eventMode = "none";
  }
  placeOnFloor(gridGraphics);
  gridGraphics.clear();

  // Color, opacity and thickness come from the scene's Grid settings
  const grid = canvas.grid;
  if (!(grid.alpha > 0)) return;
  const size = grid.size;
  const thickness = Math.max(Number(grid.thickness) || 1, 0.5);
  const color = Number(grid.color ?? 0);
  const segment = (x0, y0, x1, y1) => {
    const a = floorToPicture(x0, y0);
    const b = floorToPicture(x1, y1);
    if (!a.valid || !b.valid) return;
    const s = stretch(jacobian((x0 + x1) / 2, (y0 + y1) / 2));
    gridGraphics.lineStyle({ width: thickness * Math.clamp(s, 0.25, 4), color, alpha: grid.alpha });
    gridGraphics.moveTo(a.x, a.y);
    gridGraphics.lineTo(b.x, b.y);
  };

  // One segment per cell edge, so lines get thinner with distance
  const r = gridRect(size);
  for (let i = 0; i <= state.columns; i++) {
    const x = r.x0 + (i * size);
    for (let j = 0; j < state.rows; j++) segment(x, r.y0 + (j * size), x, r.y0 + ((j + 1) * size));
  }
  for (let j = 0; j <= state.rows; j++) {
    const y = r.y0 + (j * size);
    for (let i = 0; i < state.columns; i++) segment(r.x0 + (i * size), y, r.x0 + ((i + 1) * size), y);
  }
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

function removeWarpedMaps() {
  for (const { original, visible, mesh } of warpedMaps) {
    if (!original.destroyed) original.visible = visible;
    if (mesh && !mesh.destroyed) {
      const geometry = mesh.geometry;
      mesh.destroy();
      for (const buffer of geometry?.buffers ?? []) buffer.destroy();
      geometry?.destroy();
    }
  }
  warpedMaps = [];
}

function buildWarpedMesh(original, mesh) {
  const n = MAP_SUBDIVISIONS;
  const texture = original.texture;
  const { width: textureWidth, height: textureHeight } = texture;
  const { x: anchorX, y: anchorY } = original.anchor;
  const { x: scaleX, y: scaleY } = original.scale;
  const cos = Math.cos(original.rotation);
  const sin = Math.sin(original.rotation);
  const { x: px, y: py } = original.position;

  // Where the map is on the floor (as Foundry places it), then through the camera
  const vertices = new Float32Array((n + 1) * (n + 1) * 2);
  const uvs = new Float32Array((n + 1) * (n + 1) * 2);
  const valid = new Uint8Array((n + 1) * (n + 1));
  for (let j = 0, k = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++, k++) {
      const u = i / n;
      const v = j / n;
      const lx = (u - anchorX) * textureWidth * scaleX;
      const ly = (v - anchorY) * textureHeight * scaleY;
      const p = floorToPicture(px + (cos * lx) - (sin * ly), py + (sin * lx) + (cos * ly));
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

// Called from the token/tile refresh. Tiles keep Foundry's default rendering.
export function applyPerspectiveToPlaceable(object) {
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

  const MODULE_ID = isometricModuleConfig.MODULE_ID;
  const { width, height } = doc.getSize();
  const center = object.center;
  const J = jacobianAtPicture(center.x, center.y);
  const artScale = doc.getFlag(MODULE_ID, 'scale') ?? 1;
  const baseX = mesh.scale.x * artScale;
  const baseY = mesh.scale.y * artScale;

  // Flat: the token lies on the floor and follows the shape of its cell
  if (state.flatTokens) {
    tokenMatrix.set(J.xx, J.yx, J.xy, J.yy,
      center.x - ((J.xx * width / 2) + (J.xy * height / 2)),
      center.y - ((J.yx * width / 2) + (J.yy * height / 2)));
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
    return;
  }

  // Standing: upright on the center of its cell, as big as the cell it stands on
  const s = stretch(J);
  object.rotation = 0;
  object.skew.set(0, 0);
  object.scale.set(s, s);
  object.position.set(center.x - (s * width / 2), center.y - (s * height / 2));

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
  const left = Math.min(0, (width / 2) + right - (artWidth / 2));
  const rightEdge = Math.max(width, (width / 2) + right + (artWidth / 2));
  const top = Math.min(0, (height / 2) - up - artHeight);
  object.hitArea = new PIXI.Rectangle(left, top, rightEdge - left, height - top);
}

// Draw standing tokens closer to the camera (lower in the picture) above the ones further away.
export function applyPerspectiveDepthSort() {
  if (!isPerspectiveStanding() || !canvas.primary) return;
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
