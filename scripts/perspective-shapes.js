import {
  getSceneCamera,
  isComputingOnFloor,
  computeOnFloor,
  perspectiveFloorPoint,
  perspectivePicturePoint,
  onPerspectiveCameraChange
} from './perspective.js';

// ----------------- Regions and drawings in perspective -----------------
//
// Region shapes (also the measured templates) lie on the floor, like the tokens walking through them. A shape stays
// where it was placed on the picture (its origin), but its sizes and directions are floor distances: a 20 ft circle
// covers four perspective cells around its center and a cone opens along the floor. Foundry computes each shape on
// the floor and its polygons are seen through the camera, so what is drawn, the area tokens are tested against
// (region behaviors, terrain) and the highlighted area all match. Shapes are drawn, dragged, resized and snapped on
// the floor as well. Polygons are traced on the picture and are left as they are.
//
// Drawings keep the box they were drawn in: their rectangles and ellipses become the floor rectangle (or ellipse)
// spanned by the corners of that box.
//
// Each shape uses the saved camera of its own scene, so it is the same on every client, whichever scene it views.

const FLOOR_SHAPES = ["rectangle", "circle", "ellipse", "cone", "ring", "line", "emanation"];
const BOX_SHAPES = ["rectangle", "ellipse"];
const CURVE_POINTS = 64;

// The first document a shape belongs to (a shape can be part of another shape)
function owningDocument(shape) {
  let parent = shape.parent;
  while (parent && !(parent instanceof foundry.abstract.Document)) parent = parent.parent;
  return parent ?? null;
}

// The camera of the scene of a region shape (also of the token shapes regions are made of, whose parent is the
// scene), or null when the shape is not on a perspective floor
function regionCamera(shape) {
  if (!FLOOR_SHAPES.includes(shape.type)) return null;
  const document = owningDocument(shape);
  if (document?.documentName === "Scene") return getSceneCamera(document);
  if (document?.documentName === "Region") return getSceneCamera(document.parent);
  return null;
}

// The camera to compute a region shape with, unless Foundry is already computing it on the floor
function floorCamera(shape) {
  return isComputingOnFloor() ? null : regionCamera(shape);
}

// Rectangles and ellipses of drawings, unless turned
function drawingCamera(shape) {
  if (isComputingOnFloor() || !BOX_SHAPES.includes(shape.type) || (shape.rotation % 360)) return null;
  const document = owningDocument(shape);
  return (document?.documentName === "Drawing") ? getSceneCamera(document.parent) : null;
}

function floorPoint(point, camera) {
  const floor = perspectiveFloorPoint(point.x, point.y, camera);
  return Number.isFinite(floor.x) ? { x: floor.x, y: floor.y } : { x: point.x, y: point.y };
}

function picturePoint(point, camera) {
  const picture = perspectivePicturePoint(point.x, point.y, camera);
  return { x: picture.x, y: picture.y };
}

// Shape data moved by an offset
function translateData(data, dx, dy) {
  switch (data.type) {
    case "emanation": return { ...data, base: translateData(data.base, dx, dy) };
    case "polygon": return {
      ...data,
      points: data.points.map((value, i) => value + ((i % 2) ? dy : dx)),
      origin: data.origin ? { x: data.origin.x + dx, y: data.origin.y + dy } : data.origin
    };
    default: return { ...data, x: data.x + dx, y: data.y + dy };
  }
}

// A copy of the shape moved from its origin on the picture to the floor point under it, or null off the floor.
// A new instance, so none of the computed (projected) geometry of the shape is carried over.
function floorCopy(shape, camera) {
  const origin = shape.origin;
  const floor = perspectiveFloorPoint(origin.x, origin.y, camera);
  if (!floor.valid) return null;
  const data = translateData(shape.toObject(), floor.x - origin.x, floor.y - origin.y);
  const copy = new shape.constructor(data, { parent: shape.parent });
  copy._index = shape._index;
  return copy;
}

// Run Foundry's own code for a shape on its floor copy, then put the shape where the copy is seen on the picture
function editOnFloor(shape, camera, edit) {
  const copy = floorCopy(shape, camera);
  if (!copy) return false;
  const origin = computeOnFloor(() => {
    edit(copy);
    return copy.origin;
  });
  const picture = picturePoint(origin, camera);
  shape.updateSource(translateData(copy.toObject(), picture.x - origin.x, picture.y - origin.y));
  return true;
}

// A Clipper polygon tree on the floor, seen through the camera
function projectTree(tree, camera) {
  const scale = CONST.CLIPPER_SCALING_FACTOR;
  const paths = ClipperLib.Clipper.PolyTreeToPaths(tree).map(path => path.map(point => {
    const p = perspectivePicturePoint(point.X / scale, point.Y / scale, camera);
    return new ClipperLib.IntPoint(Math.round(p.x * scale), Math.round(p.y * scale));
  }));
  const projected = new ClipperLib.PolyTree();
  if (!paths.length) return projected;
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  clipper.Execute(ClipperLib.ClipType.ctUnion, projected, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return projected;
}

// The floor rectangle (or ellipse) spanned by the corners of a box on the picture, seen through the camera
function boxOutline(type, { left, top, right, bottom }, camera) {
  const a = perspectiveFloorPoint(left, top, camera);
  const c = perspectiveFloorPoint(right, bottom, camera);
  if (!a.valid || !c.valid) return null;
  let floor;
  if (type === "ellipse") {
    const cx = (a.x + c.x) / 2;
    const cy = (a.y + c.y) / 2;
    const rx = Math.abs(c.x - a.x) / 2;
    const ry = Math.abs(c.y - a.y) / 2;
    floor = Array.from({ length: CURVE_POINTS }, (_, i) => {
      const t = 2 * Math.PI * i / CURVE_POINTS;
      return { x: cx + (rx * Math.cos(t)), y: cy + (ry * Math.sin(t)) };
    });
  }
  else floor = [{ x: a.x, y: a.y }, { x: c.x, y: a.y }, { x: c.x, y: c.y }, { x: a.x, y: c.y }];
  return floor.map(p => picturePoint(p, camera));
}

// The box of a drawing shape on the picture
function shapeBox(shape) {
  if (shape.type === "ellipse") {
    return { left: shape.x - shape.radiusX, top: shape.y - shape.radiusY, right: shape.x + shape.radiusX, bottom: shape.y + shape.radiusY };
  }
  const left = shape.x - (shape.anchorX * shape.width);
  const top = shape.y - (shape.anchorY * shape.height);
  return { left, top, right: left + shape.width, bottom: top + shape.height };
}

function wrap(Class, name, wrapper) {
  const original = Class?.prototype?.[name];
  if (typeof original !== "function") return;
  Class.prototype[name] = function (...args) {
    return wrapper.call(this, original, ...args);
  };
}

function installFloorShape(Class) {
  wrap(Class, "_createClipperPolyTree", function (original) {
    const boxCamera = drawingCamera(this);
    if (boxCamera) {
      const outline = boxOutline(this.type, shapeBox(this), boxCamera);
      if (!outline) return original.call(this);
      const scale = CONST.CLIPPER_SCALING_FACTOR;
      const path = outline.map(p => new ClipperLib.IntPoint(Math.round(p.x * scale), Math.round(p.y * scale)));
      if (!ClipperLib.Clipper.Orientation(path)) path.reverse();
      return path;
    }
    const camera = floorCamera(this);
    const copy = camera ? floorCopy(this, camera) : null;
    if (!copy) return original.call(this);
    return projectTree(computeOnFloor(() => copy.clipperPolyTree), camera);
  });

  // Outlines (shape controls) follow the polygons
  wrap(Class, "drawShape", function (original, graphics) {
    if (!floorCamera(this) && !drawingCamera(this)) return original.call(this, graphics);
    this.polygonTree.drawShape(graphics);
  });

  // The circle through the middle of a ring lies on the floor too
  wrap(Class, "drawReferenceLines", function (original, graphics) {
    const camera = (this.type === "ring") ? floorCamera(this) : null;
    if (!camera) return original.call(this, graphics);
    if ((this.radius === 0) || (this.innerWidth === 0) || (this.outerWidth === 0)) return;
    const center = floorPoint(this.origin, camera);
    const points = [];
    for (let i = 0; i < CURVE_POINTS; i++) {
      const a = 2 * Math.PI * i / CURVE_POINTS;
      const p = picturePoint({ x: center.x + (this.radius * Math.cos(a)), y: center.y + (this.radius * Math.sin(a)) }, camera);
      points.push(p.x, p.y);
    }
    graphics.drawPolygon(points);
  });

  // Handles, measurements and the center are where they are on the floor
  wrap(Class, "_createControlHandles", function (original) {
    const camera = floorCamera(this);
    const copy = camera ? floorCopy(this, camera) : null;
    if (!copy) return original.call(this);
    const handles = { ...computeOnFloor(() => copy._createControlHandles()) };
    for (const [name, handle] of Object.entries(handles)) {
      const { position, rotation } = handle;
      const p = picturePoint(position, camera);
      const q = picturePoint({ x: position.x + Math.cos(rotation), y: position.y + Math.sin(rotation) }, camera);
      handles[name] = { ...handle, position: p, rotation: Math.atan2(q.y - p.y, q.x - p.x) };
    }
    return handles;
  });

  wrap(Class, "_createMeasuredSegments", function (original) {
    const camera = floorCamera(this);
    const copy = camera ? floorCopy(this, camera) : null;
    if (!copy) return original.call(this);
    const Ray = foundry.canvas.geometry.Ray;
    return computeOnFloor(() => copy._createMeasuredSegments()).map(segment => ({
      ...segment,
      ray: new Ray(picturePoint(segment.ray.A, camera), picturePoint(segment.ray.B, camera))
    }));
  });

  wrap(Class, "_createCenter", function (original) {
    const camera = floorCamera(this);
    const copy = camera ? floorCopy(this, camera) : null;
    if (!copy) return original.call(this);
    return picturePoint(computeOnFloor(() => copy._createCenter()), camera);
  });

  for (const name of ["sampleInterior", "sampleBoundary"]) {
    wrap(Class, name, function (original, out) {
      if ((!floorCamera(this) && !drawingCamera(this)) || this.isEmpty) return original.call(this, out);
      return this.polygonTree[name](out);
    });
  }

  // Moving, turning, resizing and drag-drawing happen on the floor
  wrap(Class, "move", function (original, origin, options) {
    const camera = floorCamera(this);
    if (camera && editOnFloor(this, camera, copy => original.call(copy, floorPoint(origin, camera), options))) return;
    return original.call(this, origin, options);
  });

  wrap(Class, "rotate", function (original, angle, options = {}) {
    const camera = floorCamera(this);
    const floorOptions = (camera && options.pivot) ? { ...options, pivot: floorPoint(options.pivot, camera) } : options;
    if (camera && editOnFloor(this, camera, copy => original.call(copy, angle, floorOptions))) return;
    return original.call(this, angle, options);
  });

  wrap(Class, "moveControlHandle", function (original, name, destination, options) {
    const camera = floorCamera(this);
    if (camera && editOnFloor(this, camera, copy => original.call(copy, name, floorPoint(destination, camera), options))) return;
    return original.call(this, name, destination, options);
  });

  wrap(Class, "_onDragMove", function (original, event) {
    const interaction = event.interactionData;
    const camera = interaction ? floorCamera(this) : null;
    if (!camera) return original.call(this, event);
    const { origin, destination } = interaction;
    const moved = editOnFloor(this, camera, copy => {
      interaction.origin = floorPoint(origin, camera);
      interaction.destination = floorPoint(destination, camera);
      try {
        original.call(copy, event);
      } finally {
        interaction.origin = origin;
        interaction.destination = destination;
      }
    });
    if (!moved) return original.call(this, event);
  });

  // Gridless scenes snap shapes to the perspective cells (centers, corners, edge midpoints), as gridded scenes do
  wrap(Class, "_getSnappedPoint", function (original, point) {
    if (isComputingOnFloor() && this.grid.isGridless && regionCamera(this)) {
      const step = this.grid.size / 2;
      return { x: Math.round(point.x / step) * step, y: Math.round(point.y / step) * step };
    }
    return original.call(this, point);
  });
}

// Drawings: the outline of a rectangle or ellipse in perspective (picture px), or null when drawn as it is
function drawingOutline(document) {
  const camera = getSceneCamera(document.parent);
  if (!camera || (document.rotation % 360)) return null;
  const { type, width, height } = document.shape;
  if (!["r", "e"].includes(type) || !width || !height) return null;
  return boxOutline((type === "e") ? "ellipse" : "rectangle",
    { left: document.x, top: document.y, right: document.x + width, bottom: document.y + height }, camera);
}

function drawDrawingOutline(drawing) {
  const outline = drawingOutline(drawing.document);
  const graphics = drawing.shape;
  if (!outline || !graphics || graphics.destroyed) return;
  const { x, y } = drawing.document;
  graphics.clear();
  graphics.lineStyle(drawing._getLineStyle());
  graphics.beginTextureFill(drawing._getFillStyle());
  graphics.drawPolygon(outline.flatMap(p => [p.x - x, p.y - y]));
  graphics.endFill();
  graphics.line?.reset?.();
}

// The camera of a scene changed (or its perspective was turned on or off): every shape on its floor is computed again
function refreshFloorShapes(scene) {
  if (!scene) return;
  for (const shape of scene._dependentShapes ?? []) shape._onShapeChange?.();
  for (const region of scene.regions) {
    for (const shape of region.shapes) shape._onShapeChange?.();
    region._clearPolygonTree?.();
  }
  for (const drawing of scene.drawings) drawing._shape?._onShapeChange?.();
  if (!canvas.ready || (canvas.scene !== scene)) return;
  for (const region of canvas.regions?.placeables ?? []) region.renderFlags.set({ refreshShapes: true });
  for (const drawing of canvas.drawings?.placeables ?? []) drawing.renderFlags.set({ refreshShape: true });
  if (game.user.isActiveGM) {
    updateRegionConstraints(scene).then(() => updateTokenRegions(scene))
      .catch(error => console.error("Isometric Perspective | updating regions for the camera failed", error));
  }
}

// Regions restricted by walls cut their shapes with what can be seen from their origin, up to the shape bounds
async function updateRegionConstraints(scene) {
  for (const region of scene.regions) {
    if (region.restriction?.enabled && region.shapes.length) await region.updateShapeConstraints({ save: true });
  }
}

// Which regions each token is in, as Foundry keeps it (run by the active GM)
export async function updateTokenRegions(scene) {
  if (!scene?.regions.size) return;
  const updates = [];
  for (const token of scene.tokens) {
    const current = [...(token._source._regions ?? [])].sort();
    const inside = scene.regions.filter(region => token.testInsideRegion(region)).map(region => region.id).sort();
    if (inside.equals(current)) continue;
    updates.push({ _id: token.id, _regions: inside });
  }
  if (updates.length) await scene.updateEmbeddedDocuments("Token", updates, { diff: false, noHook: true });
}

// Installed once, on init
export function installPerspectiveShapes() {
  const data = foundry.data;
  for (const Class of [data.RectangleShapeData, data.CircleShapeData, data.EllipseShapeData, data.ConeShapeData,
    data.RingShapeData, data.LineShapeData, data.EmanationShapeData]) {
    installFloorShape(Class);
  }

  // The highlight of the grid spaces a region covers: the spaces are perspective cells, the shape already follows them
  wrap(foundry.canvas.placeables.Region, "_getCoveredGridSpaceOffsets", function (original) {
    if (getSceneCamera(this.document.parent)) return [];
    return original.call(this);
  });

  // Drawn rectangles and ellipses lie on the floor
  const Drawing = foundry.canvas.placeables.Drawing;
  wrap(Drawing, "_refreshShape", function (original) {
    original.call(this);
    drawDrawingOutline(this);
  });
  wrap(Drawing, "_refreshPosition", function (original) {
    original.call(this);
    if (drawingOutline(this.document)) drawDrawingOutline(this);
  });

  // The scene on the canvas tells when its camera changes, other scenes when they are saved
  onPerspectiveCameraChange(refreshFloorShapes);
  Hooks.on("updateScene", (scene, changes) => {
    if (scene === canvas.scene) return;
    const flags = changes.flags?.["isometric-perspective"] ?? {};
    const perspectiveChanged = Object.keys(flags).some(key => key.includes("perspective") || ["projectionType", "isometricEnabled"].includes(key));
    if (perspectiveChanged || ("grid" in changes) || ("width" in changes) || ("height" in changes) || ("padding" in changes)) {
      refreshFloorShapes(scene);
    }
  });

  // Tokens of scenes saved before regions followed the perspective
  Hooks.on("canvasReady", () => {
    if (getSceneCamera(canvas.scene) && game.user.isActiveGM) {
      updateTokenRegions(canvas.scene).catch(error => console.error("Isometric Perspective | updating token regions failed", error));
    }
  });
}
