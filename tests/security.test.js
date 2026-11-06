import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePlace, readArrayBuffer, readJson } from '../src/security.js';

test('readJson accepts bounded JSON responses', async () => {
  const response = new Response('{"ok":true}', {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
  assert.deepEqual(await readJson(response, 32), { ok: true });
});

test('readJson rejects executable content and oversized bodies', async () => {
  await assert.rejects(
    readJson(new Response('<script></script>', { headers: { 'content-type': 'text/html' } })),
    /Unexpected response type/,
  );
  await assert.rejects(
    readJson(new Response('{"value":"too large"}', { headers: { 'content-type': 'application/json' } }), 8),
    /exceeds 8 bytes/,
  );
});

test('readArrayBuffer enforces binary response limits', async () => {
  await assert.rejects(readArrayBuffer(new Response(new Uint8Array(9)), 8), /exceeds 8 bytes/);
});

test('normalizePlace permits only bounded geographic records', () => {
  assert.deepEqual(normalizePlace({ name: '  Bengaluru  ', lat: '12.9716', lng: '77.5946' }), {
    name: 'Bengaluru', lat: 12.9716, lng: 77.5946,
  });
  assert.equal(normalizePlace({ name: 'Invalid', lat: 91, lng: 0 }), null);
  assert.equal(normalizePlace({ name: '<img onerror=alert(1)>', lat: NaN, lng: 0 }), null);
});
