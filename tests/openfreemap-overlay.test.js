import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildingHeightRange,
  groupPolygonRings,
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
