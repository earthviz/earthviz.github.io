import test from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_INSET_KM, takeNext, terrainSegments, shouldRefine, LIMITS } from '../src/lod.js';

test('stale entries below the best entry cannot invalidate the queue index', () => {
  const queue = [
    { current: false, priority: 0, queued: true },
    { current: true, priority: 20, queued: true },
    { current: true, priority: 1, queued: true },
  ];
  assert.equal(takeNext(queue, t => t.current, t => t.priority).priority, 1);
  assert.equal(takeNext(queue, t => t.current, t => t.priority).priority, 20);
  assert.equal(takeNext(queue, t => t.current, t => t.priority), null);
});

test('arbitrary stale queues always drain in bounded iterations', () => {
  for (let seed = 0; seed < 100; seed++) {
    const queue = Array.from({ length: LIMITS.queued }, (_, i) => ({
      current: (i + seed) % 3 !== 0, priority: (i * 17 + seed) % 31, queued: true,
    }));
    let count = 0;
    while (takeNext(queue, t => t.current, t => t.priority)) {
      assert.ok(++count <= LIMITS.queued);
    }
    assert.equal(queue.length, 0);
  }
});

test('deep ocean stops at coarse classification; unknown coastlines can refine', () => {
  const input = { z: 5, pixels: 5000, threshold: 500, wasSplit: false, maxZoom: 15 };
  assert.equal(shouldRefine({ ...input, land: false }), false);
  assert.equal(shouldRefine({ ...input, land: null }), true);
  assert.equal(shouldRefine({ ...input, land: true, z: 15 }), false);
});

test('hysteresis prevents zoom threshold oscillation', () => {
  const input = { z: 6, land: true, pixels: 500, threshold: 500, maxZoom: 15 };
  assert.equal(shouldRefine({ ...input, wasSplit: false }), false);
  assert.equal(shouldRefine({ ...input, wasSplit: true }), true);
});

test('mesh density follows visible relief and retains global curvature', () => {
  assert.equal(terrainSegments(1, 0), 32);
  assert.equal(terrainSegments(8, 0.5), 4);
  assert.equal(terrainSegments(8, 8), 16);
  assert.equal(terrainSegments(8, 30), 32);
});


test('fallback sphere stays beneath coarse tile faces, including exaggerated seabed', async () => {
  const { Vector3, Triangle } = await import('three');
  const radius = 6371;
  const origin = new Vector3();
  const closest = new Vector3();
  const face = new Triangle();
  // Longitude is rotationally symmetric. Cover every latitude band and all
  // coarse levels, using the sparsest allowed mesh and deepest supported sea.
  for (let z = 1; z <= 6; z++) {
    const n = 2 ** z;
    const segments = terrainSegments(z, 0);
    const point = (x, y) => {
      const lng = x / n * 2 * Math.PI;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
      const r = radius - 12 * 6;
      return new Vector3(r * Math.cos(lat) * Math.cos(lng), r * Math.sin(lat), -r * Math.cos(lat) * Math.sin(lng));
    };
    for (let row = 0; row < n * segments; row++) {
      const y = row / segments;
      const a = point(0, y);
      const b = point(0, y + 1 / segments);
      const c = point(1 / segments, y);
      const d = point(1 / segments, y + 1 / segments);
      for (const vertices of [[a, b, c], [c, b, d]]) {
        face.set(...vertices).closestPointToPoint(origin, closest);
        assert.ok(closest.length() > radius - FALLBACK_INSET_KM,
          `fallback intersects terrain at zoom ${z}, row ${row}`);
      }
    }
  }
});

test('refinement budget is shared across the view instead of consumed by the first branch', async () => {
  const { selectFrontier } = await import('../src/lod.js');
  const make = (key, error, kids = []) => ({ key, error, kids, ready: true });
  const a = make('a', 50, [make('a1', 1), make('a2', 1)]);
  const b = make('b', 100, [make('b1', 1), make('b2', 1)]);
  const options = { roots: [a, b], inView: () => true, request: () => {}, score: t => t.error, children: t => t.kids, maxLeaves: 3 };
  assert.deepEqual(selectFrontier(options).map(t => t.key).sort(), ['a', 'b1', 'b2']);
  assert.deepEqual(selectFrontier({ ...options, roots: [b, a] }).map(t => t.key).sort(), ['a', 'b1', 'b2']);
});

test('offscreen children do not consume leaf budget and incomplete children retain the parent', async () => {
  const { selectFrontier } = await import('../src/lod.js');
  const leaf = { key: 'leaf', ready: true, children: [] };
  const hidden = { key: 'hidden', ready: true, hidden: true };
  const middle = { key: 'middle', ready: true, children: [leaf, hidden] };
  const root = { key: 'root', ready: true, children: [middle, hidden] };
  const selected = [];
  const options = { roots: [root], inView: t => !t.hidden, request: t => selected.push(t.key), score: () => 1, children: t => t.children, maxLeaves: 1 };
  assert.deepEqual(selectFrontier(options), [leaf]);
  assert.ok(!selected.includes('hidden'));
  leaf.ready = false;
  assert.deepEqual(selectFrontier(options), [middle]);
});

test('pending refinements reserve budget before lower-priority regions request children', async () => {
  const { selectFrontier } = await import('../src/lod.js');
  const requested = new Set();
  const a = { key: 'a', ready: true, priority: 100, kids: [{ key: 'a1', ready: false }, { key: 'a2', ready: false }] };
  const b = { key: 'b', ready: true, priority: 10, kids: [{ key: 'b1', ready: false }, { key: 'b2', ready: false }] };
  const result = selectFrontier({
    roots: [a, b], inView: () => true, request: t => requested.add(t.key),
    score: t => t.priority || 0, children: t => t.kids, maxLeaves: 3,
  });
  assert.deepEqual(result, [a, b]);
  assert.ok(requested.has('a1') && requested.has('a2'));
  assert.ok(!requested.has('b1') && !requested.has('b2'));
});
