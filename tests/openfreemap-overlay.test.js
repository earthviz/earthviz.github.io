import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERLAY_LAYERS,
  buildingHeightRange,
  groupPolygonRings,
  ringArea,
  roadRank,
  selectTop,
  tileDistanceToLocation,
  tilePointToRadians,
  tileWindow,
} from '../src/cesium/openfreemap-geometry.js';

test('groups MVT outer rings with their following holes', () => {
  const outer = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }];
  const hole = [{ x: 2, y: 2 }, { x: 2, y: 8 }, { x: 8, y: 8 }, { x: 8, y: 2 }, { x: 2, y: 2 }];
  const groups = groupPolygonRings([outer, hole]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].outerRing.length, 4);
  assert.equal(groups[0].holes.length, 1);
  assert.equal(groups[0].holes[0].length, 4);
});

test('converts tile-local coordinates through Web Mercator', () => {
  const center = tilePointToRadians({ x: 2048, y: 2048 }, 0, 0, 0, 4096);
  assert.ok(Math.abs(center.longitude) < 1e-12);
  assert.ok(Math.abs(center.latitude) < 1e-12);
});

test('uses source building heights and safe fallbacks', () => {
  assert.deepEqual(
    buildingHeightRange({ render_height: 42, render_min_height: 6 }),
    { height: 42, minimum: 6 },
  );
  assert.deepEqual(buildingHeightRange({ levels: 5 }), { height: 16, minimum: 0 });
  assert.deepEqual(buildingHeightRange({ render_height: 0 }), { height: 10, minimum: 0 });
  assert.deepEqual(buildingHeightRange({}), { height: 10, minimum: 0 });
});

test('creates a bounded tile window and wraps across the antimeridian', () => {
  const window = tileWindow(Math.PI - 1e-8, 0, { zoom: 3, radius: 1 });
  assert.equal(window.length, 9);
  assert.equal(window[0].distance, 0);
  assert.ok(window.some(tile => tile.x === 0));
  assert.ok(window.some(tile => tile.x === 7));
});

test('ranks overlay tiles by distance from the camera ground position', () => {
  const window = tileWindow(0, 0, { zoom: 3, radius: 1 });
  const center = window.find(tile => tile.distance === 0);
  const edge = window.find(tile => tile.distance === 1);
  const tiles = 2 ** center.z;
  const centerLongitude = ((center.x + 0.5) / tiles) * 2 * Math.PI - Math.PI;
  const centerLatitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (center.y + 0.5) / tiles)));
  assert.equal(tileDistanceToLocation(center, centerLongitude, centerLatitude), 0);
  assert.ok(tileDistanceToLocation(center, centerLongitude, centerLatitude)
    < tileDistanceToLocation(edge, centerLongitude, centerLatitude));

  const acrossDateline = { x: 0, y: center.y, z: 3 };
  assert.ok(tileDistanceToLocation(acrossDateline, Math.PI - 1e-8, 0) < 1);
});

test('buildings load in a tighter window than roads', () => {
  const buildings = tileWindow(0, 0, { zoom: 14, radius: OVERLAY_LAYERS.buildings.radius });
  const roads = tileWindow(0, 0, { zoom: 14, radius: OVERLAY_LAYERS.roads.radius });
  assert.equal(buildings.length, 9);
  assert.equal(roads.length, 25);
  assert.ok(OVERLAY_LAYERS.buildings.maxAltitude < OVERLAY_LAYERS.roads.maxAltitude);
});

test('ranks road classes and skips ones that are not drawn', () => {
  assert.ok(roadRank('motorway') < roadRank('primary'));
  assert.ok(roadRank('primary') < roadRank('minor'));
  assert.equal(roadRank('service'), undefined);
  assert.equal(roadRank('toString'), undefined);
});

test('selectTop keeps the largest footprints and is stable for ties', () => {
  const square = size => [{ x: 0, y: 0 }, { x: size, y: 0 }, { x: size, y: size }, { x: 0, y: size }];
  assert.equal(ringArea(square(10)), 100);
  const items = [{ id: 'a', area: 5 }, { id: 'b', area: 50 }, { id: 'c', area: 50 }, { id: 'd', area: 1 }];
  const kept = selectTop(items, 2, (x, y) => y.area - x.area);
  assert.deepEqual(kept.map(item => item.id), ['b', 'c']);
  assert.equal(selectTop(items, 10, () => 0), items);
});
