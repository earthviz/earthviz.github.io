import test from 'node:test';
import assert from 'node:assert/strict';
import {
  glsEpochForDate, glsTileUrl, pickScenes, radarFrames, stacSearchBody, titilerTileUrl,
} from '../src/sources.js';

test('radar frames use host+path from the API and are time sorted', () => {
  const frames = radarFrames({ host: 'https://tilecache.rainviewer.com', radar: { past: [
    { time: 200, path: '/v2/radar/b' }, { time: 100, path: '/v2/radar/a' }, { time: 300, path: 'evil' },
  ] } });
  assert.deepEqual(frames.map(f => f.time), [100000, 200000]);
  assert.equal(frames[0].url, 'https://tilecache.rainviewer.com/v2/radar/a/256/{z}/{x}/{y}/2/1_1.png');
  assert.deepEqual(radarFrames({ host: 'http://x', radar: { past: [{ time: 1, path: '/a' }] } }), []);
});

test('GLS dates snap to the nearest epoch', () => {
  assert.equal(glsEpochForDate('1973-01-01'), 1975);
  assert.equal(glsEpochForDate('1984-06-01'), 1990);
  assert.equal(glsEpochForDate('1998-06-01'), 2000);
  assert.equal(glsEpochForDate('2026-01-01'), 2010);
  assert.match(glsTileUrl(1990), /\{westProjected\}.*time=\d+,\d+/);
});

test('STAC body covers a 10-day window ending on the chosen date', () => {
  const body = stacSearchBody({ west: 1, south: 2, east: 3, north: 4 }, '2026-11-07');
  assert.equal(body.datetime, '2026-10-28T00:00:00Z/2026-11-07T23:59:59Z');
  assert.deepEqual(body.bbox, [1, 2, 3, 4]);
  assert.deepEqual(body.collections, ['sentinel-2-l2a']);
});

test('pickScenes keeps one scene per grid cell, preferring clear ones, and drops bad geometry', () => {
  const f = (id, cell, dt, cloud, bbox = [0, 0, 1, 1], href = 'https://b/x.tif') => ({
    id, bbox, properties: { 'grid:code': cell, datetime: dt, 'eo:cloud_cover': cloud }, assets: { visual: { href } },
  });
  const scenes = pickScenes([
    f('new-cloudy', 'A', '2026-11-05', 90),
    f('old-clear', 'A', '2026-10-30', 5),
    f('b', 'B', '2026-11-01', 10),
    f('anti', 'C', '2026-11-06', 0, [179, 0, -179, 1]),
    f('nohref', 'D', '2026-11-06', 0, [0, 0, 1, 1], ''),
  ]);
  assert.deepEqual(scenes.map(s => s.id), ['b', 'old-clear']);
  assert.equal(pickScenes([f('s3', 'E', '2026-11-01', 1, [0, 0, 1, 1], 's3://sentinel-cogs/a/b.tif')])[0].href, 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/a/b.tif');
  assert.ok(titilerTileUrl('https://b/x.tif?y=1').includes('url=https%3A%2F%2Fb%2Fx.tif%3Fy%3D1'));
});
