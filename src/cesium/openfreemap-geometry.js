const MAX_MERCATOR_LATITUDE = 85.05112878 * Math.PI / 180;

export const OPENFREEMAP_TILE_ZOOM = 14;

// Buildings are the expensive layer (extruded, lit, per-building terrain
// sampling), so they load in a tight window at low altitude. Roads are
// ground-clamped lines and can cover a wider area from higher up.
export const OVERLAY_LAYERS = {
  buildings: { radius: 1, maxAltitude: 8_000, maxPerTile: 700 },
  roads: { radius: 2, maxAltitude: 25_000, maxPerTile: 500 },
};

// Footprints below this (tile units², roughly 10 m² at z14) are never built.
export const MIN_BUILDING_FOOTPRINT = 30;

const ROAD_RANK = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, minor: 5, street: 5,
};

// Lower is more important; undefined means the class is not drawn.
export function roadRank(roadClass) {
  return Object.hasOwn(ROAD_RANK, roadClass) ? ROAD_RANK[roadClass] : undefined;
}

export function ringArea(ring) {
  return Math.abs(ringSignedArea(ring));
}

// Keeps the best `limit` items by comparator order. Stable for equal items.
export function selectTop(items, limit, compare) {
  if (items.length <= limit) return items;
  return items.slice().sort(compare).slice(0, limit);
}

export function stripClosingVertex(ring) {
  if (
    ring.length > 1
    && ring[0].x === ring[ring.length - 1].x
    && ring[0].y === ring[ring.length - 1].y
  ) return ring.slice(0, -1);
  return ring;
}

export function ringSignedArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  }
  return area / 2;
}

// MVT polygon rings arrive with outer rings first and their holes immediately
// after them. Tile coordinates run downward, hence the outer-ring sign here.
export function groupPolygonRings(rawRings) {
  const groups = [];
  for (const rawRing of rawRings) {
    const ring = stripClosingVertex(rawRing);
    if (ring.length < 3) continue;
    if (ringSignedArea(ring) <= 0) groups.push({ outerRing: ring, holes: [] });
    else if (groups.length) groups[groups.length - 1].holes.push(ring);
  }
  return groups;
}

export function tilePointToRadians(point, tileX, tileY, zoom, extent) {
  const tiles = 2 ** zoom;
  const u = (tileX + point.x / extent) / tiles;
  const v = (tileY + point.y / extent) / tiles;
  return {
    longitude: u * 2 * Math.PI - Math.PI,
    latitude: Math.atan(Math.sinh(Math.PI * (1 - 2 * v))),
  };
}

export function buildingHeightRange(properties = {}) {
  const number = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const minimum = Math.max(0, number(properties.render_min_height) ?? 0);
  const levels = number(properties.levels) ?? number(properties.building_levels);
  const estimated = levels === undefined ? 10 : Math.max(3, levels * 3.2);
  const sourceHeight = number(properties.render_height);
  const rendered = sourceHeight !== undefined && sourceHeight > 0 ? sourceHeight : estimated;
  return {
    minimum: Math.min(minimum, 995),
    height: Math.min(1000, Math.max(minimum + 3, rendered)),
  };
}

export function tileWindow(longitude, latitude, options = {}) {
  const zoom = options.zoom ?? OPENFREEMAP_TILE_ZOOM;
  const radius = options.radius ?? 2;
  const tiles = 2 ** zoom;
  const lon = ((longitude + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  const lat = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
  const centerX = Math.floor(((lon + Math.PI) / (2 * Math.PI)) * tiles);
  const centerY = Math.floor((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) * 0.5 * tiles);
  const result = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    const y = centerY + dy;
    if (y < 0 || y >= tiles) continue;
    for (let dx = -radius; dx <= radius; dx += 1) {
      const x = ((centerX + dx) % tiles + tiles) % tiles;
      result.push({
        x,
        y,
        z: zoom,
        key: `${zoom}/${x}/${y}`,
        distance: Math.abs(dx) + Math.abs(dy),
      });
    }
  }
  return result.sort((a, b) => a.distance - b.distance);
}

export function tileDistanceToLocation(tile, longitude, latitude) {
  const tiles = 2 ** tile.z;
  const tileLongitude = ((tile.x + 0.5) / tiles) * 2 * Math.PI - Math.PI;
  const tileLatitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tile.y + 0.5) / tiles)));
  const longitudeDelta = ((tileLongitude - longitude + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  const latitudeDelta = tileLatitude - latitude;
  const eastWest = longitudeDelta * Math.cos((tileLatitude + latitude) * 0.5);
  return eastWest * eastWest + latitudeDelta * latitudeDelta;
}
