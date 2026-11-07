import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTerrariumHeight, sampleTerrarium } from '../src/cesium/terrarium.js';

test('decodes Terrarium RGB samples in meters', () => {
  assert.equal(decodeTerrariumHeight(128, 0, 0), 0);
  assert.equal(decodeTerrariumHeight(128, 1, 128), 1.5);
  assert.equal(decodeTerrariumHeight(127, 255, 0), -1);
});

test('samples edge-inclusive grids and optionally flattens sea', () => {
  const pixels = new Uint8ClampedArray([
    127, 255, 0, 255, 128, 1, 0, 255,
    128, 2, 0, 255, 128, 3, 0, 255,
  ]);
  const flat = sampleTerrarium(pixels, 2, 2, { gridSize: 2, flattenSea: true });
  assert.deepEqual([...flat.heights], [0, 1, 2, 3]);
  assert.deepEqual([...flat.waterMask], [255, 0, 0, 0]);
  assert.equal(flat.allWater, false);
  const bathymetry = sampleTerrarium(pixels, 2, 2, { gridSize: 2, flattenSea: false });
  assert.deepEqual([...bathymetry.heights], [-1, 1, 2, 3]);
});

test('classification scans source pixels beyond the rendered grid', () => {
  const pixels = new Uint8ClampedArray(3 * 3 * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 127;
    pixels[i + 1] = 255;
    pixels[i + 3] = 255;
  }
  pixels[4 * 4] = 128;
  pixels[4 * 4 + 1] = 1;
  assert.equal(sampleTerrarium(pixels, 3, 3, { gridSize: 2 }).allWater, false);
});

test('region sampling reads a sub-window of the tile', () => {
  // 4x4 tile whose heights equal the column index (red=128 => 0 m, green=column).
  const size = 4;
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) pixels.set([128, x * 10, 0, 255], 4 * (y * size + x));
  const full = sampleTerrarium(pixels, size, size, { gridSize: 2 });
  assert.deepEqual([...full.heights], [0, 30, 0, 30]);
  const right = sampleTerrarium(pixels, size, size, { gridSize: 2, region: { x: 0.5, y: 0, size: 0.5 } });
  assert.deepEqual([...right.heights], [15, 30, 15, 30]);
});

import { planSourceLevels, TERRAIN_SOURCES } from '../src/cesium/terrarium.js';
test('plans source levels with parent fallback and missing-tile memory', () => {
  const mh = TERRAIN_SOURCES.mapterhorn;
  assert.deepEqual(planSourceLevels(10, 5, 5, mh), [10]);
  assert.deepEqual(planSourceLevels(14, 0, 0, mh), [14, 13, 12]);
  assert.deepEqual(planSourceLevels(20, 0, 0, mh), [17, 16, 15, 14, 13, 12]);
  // z13 ancestor of this z15 tile is known missing: go straight to z12.
  const missing = (l, x, y) => l === 13 && x === 2 && y === 2;
  assert.deepEqual(planSourceLevels(15, 9, 10, mh, missing), [12]);
  assert.deepEqual(planSourceLevels(15, 9, 10, TERRAIN_SOURCES.aws), [15]);
});
