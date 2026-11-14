// Small drawing and pointer helpers shared by the isometric and the perspective token code. A file of its own: a name
// new to an existing file breaks the whole module wherever a cache still serves that file's old copy.

// The line from a flying token down to its cell: fine dots that fade out on the way up, light with a faint dark rim,
// so it shows on any map without hiding it. The dot on the floor is a little larger, it marks the cell.
// `from` is the floor, `to` the token, `size` the size of a cell there, all in the px of `graphics`.
export function drawElevationLine(graphics, from, to, size) {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (!(length > 0) || !(size > 0)) return;
  const radius = Math.max(size * 0.011, 0.7);
  const rim = Math.max(size * 0.009, 0.6);
  const step = Math.max(size * 0.075, radius * 5);
  const ux = (to.x - from.x) / length;
  const uy = (to.y - from.y) / length;
  for (let d = 0; d <= length; d += step) {
    const fade = 1 - (0.7 * (d / length));       // 1 on the floor, 0.3 at the token
    const r = (d === 0) ? radius * 1.6 : radius;
    const x = from.x + (ux * d);
    const y = from.y + (uy * d);
    graphics.beginFill(0x000000, 0.16 * fade);
    graphics.drawCircle(x, y, r + rim);
    graphics.beginFill(0xFFFFFF, 0.55 * fade);
    graphics.drawCircle(x, y, r);
    graphics.endFill();
  }
}

// Where a token can be taken with the pointer when it can also be taken by its art (a token of one's own, or one with
// no cell to be taken by): its place on the floor (`floor`, in the token's own coordinates) and its art, the whole
// picture of it. The floor comes first: the art only answers where the pointer is on no token's floor, so a click on
// a cell always takes the token standing there, even under the art of another one.
const grabPoint = new PIXI.Point();
export function floorOrArtHitArea(token, floor) {
  return {
    floor,
    contains(x, y) {
      if (floor?.contains(x, y)) return true;
      const mesh = token.mesh;
      if (!mesh || mesh.destroyed || !mesh.visible || !mesh.texture?.valid || (typeof mesh.containsPoint !== "function")) return false;
      const point = token.worldTransform.apply({ x, y }, grabPoint);
      if (!mesh.containsPoint(point, 0)) return false;
      return !floorUnder(point.x, point.y);
    }
  };
}

// Is a point of the screen on the floor of some token (its cell, where it is taken). All tokens test the same point
// while the pointer is hit-tested, so the answer is kept for that point and frame.
const floorProbe = { x: NaN, y: NaN, frame: NaN, found: false };
const probePoint = new PIXI.Point();
function floorUnder(x, y) {
  const frame = canvas.app?.ticker?.lastTime;
  if ((floorProbe.x === x) && (floorProbe.y === y) && (floorProbe.frame === frame)) return floorProbe.found;
  let found = false;
  for (const token of canvas.tokens?.placeables ?? []) {
    if (!token.visible || token.destroyed) continue;
    const area = token.hitArea;
    const floor = (area && ("floor" in area)) ? area.floor : area;
    if (!floor?.contains) continue;
    const local = token.worldTransform.applyInverse({ x, y }, probePoint);
    if (floor.contains(local.x, local.y)) {
      found = true;
      break;
    }
  }
  Object.assign(floorProbe, { x, y, frame, found });
  return found;
}
