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
