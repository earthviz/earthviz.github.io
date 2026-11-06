import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseTileLoadPriority,
  TILE_PRIORITY,
  usesNearestPriority,
} from '../src/cesium/tile-priority.js';

test('view-center and nearest modes choose their respective scores', () => {
  const scores = { centerPriority: 3, distance: 12 };
  assert.equal(chooseTileLoadPriority({ mode: TILE_PRIORITY.VIEW_CENTER, ...scores }), 3);
  assert.equal(chooseTileLoadPriority({ mode: TILE_PRIORITY.NEAREST, ...scores }), 12);
});

test('adaptive priority follows the current motion state', () => {
  assert.equal(usesNearestPriority(TILE_PRIORITY.ADAPTIVE, false), false);
  assert.equal(usesNearestPriority(TILE_PRIORITY.ADAPTIVE, true), true);
  assert.equal(chooseTileLoadPriority({
    mode: TILE_PRIORITY.ADAPTIVE,
    adaptiveNearest: true,
    centerPriority: 2,
    distance: 9,
  }), 9);
});

test('nearest priority falls back when Cesium has not computed distance', () => {
  assert.equal(chooseTileLoadPriority({
    mode: TILE_PRIORITY.NEAREST,
    centerPriority: 4,
    distance: undefined,
  }), 4);
});
