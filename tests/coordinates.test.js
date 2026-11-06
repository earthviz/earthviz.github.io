import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCoordinates, formatCoordinates } from '../src/coordinates.js';

const near = (got, lat, lng) => {
  assert.ok(got && !got.error, `expected coordinates, got ${JSON.stringify(got)}`);
  assert.ok(Math.abs(got.lat - lat) < 1e-4, `lat ${got.lat} != ${lat}`);
  assert.ok(Math.abs(got.lng - lng) < 1e-4, `lng ${got.lng} != ${lng}`);
};

test('decimal pairs with comma, semicolon, space and brackets', () => {
  near(parseCoordinates('27.9881, 86.925'), 27.9881, 86.925);
  near(parseCoordinates('27.9881,86.925'), 27.9881, 86.925);
  near(parseCoordinates('27.9881 86.925'), 27.9881, 86.925);
  near(parseCoordinates('27.9881;86.925'), 27.9881, 86.925);
  near(parseCoordinates('(33.7, 78.9)'), 33.7, 78.9);
  near(parseCoordinates('-33.9249, 18.4241'), -33.9249, 18.4241);
  near(parseCoordinates('−33.9249, 18.4241'), -33.9249, 18.4241);
});

test('hemisphere letters in any position and order', () => {
  near(parseCoordinates('27.9881 N, 86.925 E'), 27.9881, 86.925);
  near(parseCoordinates('27.9881°N 86.925°E'), 27.9881, 86.925);
  near(parseCoordinates('N27.9881 E86.925'), 27.9881, 86.925);
  near(parseCoordinates('86.925E 27.9881N'), 27.9881, 86.925);
  near(parseCoordinates('33.9249 S, 18.4241 E'), -33.9249, 18.4241);
  near(parseCoordinates('40.7 N 74.0 W'), 40.7, -74);
});

test('degrees, minutes, seconds', () => {
  near(parseCoordinates('27°59\'17"N 86°55\'30"E'), 27 + 59 / 60 + 17 / 3600, 86 + 55 / 60 + 30 / 3600);
  near(parseCoordinates('27 59 17 N, 86 55 30 E'), 27 + 59 / 60 + 17 / 3600, 86 + 55 / 60 + 30 / 3600);
  near(parseCoordinates('33°55′S, 18°25′E'), -(33 + 55 / 60), 18 + 25 / 60);
  near(parseCoordinates('27°59.5\' N, 86°55.5\' E'), 27 + 59.5 / 60, 86 + 55.5 / 60);
});

test('lng, lat order is recognised when latitude would be out of range', () => {
  near(parseCoordinates('121.5654, 25.033'), 25.033, 121.5654);
  // First value within ±90 stays latitude.
  near(parseCoordinates('86.925, 27.9881'), 86.925, 27.9881);
});

test('out-of-range values report an error', () => {
  assert.ok(parseCoordinates('95, 200').error);
  assert.ok(parseCoordinates('91, 100').error);
  assert.ok(parseCoordinates('10, 181').error);
});

test('place names and malformed input are not coordinates', () => {
  for (const text of ['', 'pangong lake', 'diskit gompa', 'route 66', '12 main street', 'N N', '27.9 N, 86.9 N',
    '27 60 0 N, 86 0 0 E', '1, 2, 3', '42', 'K2', '10 Downing Street, London']) {
    assert.equal(parseCoordinates(text), null, text);
  }
});

test('formatCoordinates', () => {
  assert.equal(formatCoordinates(27.9881, 86.925), '27.9881° N, 86.9250° E');
  assert.equal(formatCoordinates(-33.9249, -18.4241), '33.9249° S, 18.4241° W');
});
