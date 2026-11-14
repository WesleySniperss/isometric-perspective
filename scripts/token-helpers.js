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

// Where a token can be taken with the pointer when it has no cell to be taken by (outside the grid, between cells,
// outside the map, on a scene without a grid): its place on the floor (`floor`, in the token's own coordinates) and
// also its art, the whole picture of it. On a cell a token is taken by its cell only.
const grabPoint = new PIXI.Point();
export function floorOrArtHitArea(token, floor) {
  return {
    floor,
    contains(x, y) {
      if (floor?.contains(x, y)) return true;
      const mesh = token.mesh;
      if (!mesh || mesh.destroyed || !mesh.visible || !mesh.texture?.valid || (typeof mesh.containsPoint !== "function")) return false;
      return mesh.containsPoint(token.worldTransform.apply({ x, y }, grabPoint), 0);
    }
  };
}
