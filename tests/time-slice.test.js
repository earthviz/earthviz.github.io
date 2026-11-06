import test from 'node:test';
import assert from 'node:assert/strict';
import { forEachSliced } from '../src/cesium/time-slice.js';

test('yields once the slice budget is spent', async () => {
  let clock = 0;
  let yields = 0;
  const seen = [];
  const done = await forEachSliced([1, 2, 3, 4, 5, 6], (item) => {
    seen.push(item);
    clock += 2;
  }, { budgetMs: 4, now: () => clock, yieldFn: async () => { yields += 1; } });
  assert.equal(done, true);
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
  assert.equal(yields, 3);
});

test('stops as soon as work is no longer active after a yield', async () => {
  let clock = 0;
  let active = true;
  const seen = [];
  const done = await forEachSliced([1, 2, 3, 4, 5, 6], (item) => {
    seen.push(item);
    clock += 2;
  }, {
    budgetMs: 4,
    now: () => clock,
    yieldFn: async () => { active = false; },
    isActive: () => active,
  });
  assert.equal(done, false);
  assert.deepEqual(seen, [1, 2]);
});

test('never yields for work that fits in one slice', async () => {
  let yields = 0;
  await forEachSliced([1, 2, 3], () => {}, { budgetMs: 1000, yieldFn: async () => { yields += 1; } });
  assert.equal(yields, 0);
});
