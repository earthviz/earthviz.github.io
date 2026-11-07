import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLIGHT_LIMITS,
  advance,
  aboveGround,
  compassLabel,
  createFlight,
  fromLogPosition,
  lookAheadPoints,
  maxDefined,
  metersPerRadian,
  stepFlight,
  teleportFlight,
  toLogPosition,
} from '../src/flight.js';

const D2R = Math.PI / 180;
const run = (flight, input, seconds, terrain = () => ({ here: 0 }), dt = 1 / 60) => {
  for (let t = 0; t < seconds; t += dt) stepFlight(flight, input, dt, terrain(flight));
  return flight;
};

test('advance heads north, east and wraps the antimeridian', () => {
  const north = advance(0, 0, 0, 0, 111_000);
  assert.ok(Math.abs(north.lat / D2R - 1) < 0.01);
  assert.ok(Math.abs(north.lng) < 1e-9);
  const east = advance(0, 0, 0, Math.PI / 2, 111_320);
  assert.ok(Math.abs(east.lng / D2R - 1) < 0.01);
  const wrap = advance(0, 179.9 * D2R, 0, Math.PI / 2, 50_000);
  assert.ok(wrap.lng < 0, 'longitude wrapped past +180');
});

test('longitude steps grow toward the poles and latitude is clamped', () => {
  assert.ok(metersPerRadian(80 * D2R).lng < metersPerRadian(0).lng * 0.2);
  const pole = advance(84 * D2R, 0, 0, 0, 5_000_000);
  assert.ok(pole.lat <= FLIGHT_LIMITS.maxLatitude + 1e-12);
});

test('speed eases toward the target and pause brakes to a stop', () => {
  const flight = createFlight({ targetSpeed: 200, ground: 0, height: 900 });
  run(flight, {}, 5);
  assert.ok(Math.abs(flight.speed - 200) < 2);
  flight.paused = true;
  run(flight, {}, 5);
  assert.equal(flight.speed, 0);
});

test('throttle scales cruise speed and respects limits', () => {
  const flight = createFlight({ targetSpeed: 100, ground: 0 });
  run(flight, { throttle: 1 }, 60);
  assert.equal(flight.targetSpeed, FLIGHT_LIMITS.maxSpeed);
  run(flight, { throttle: -1 }, 120);
  assert.equal(flight.targetSpeed, FLIGHT_LIMITS.minSpeed);
});

test('boost raises the effective speed without changing the cruise target', () => {
  const flight = createFlight({ targetSpeed: 100, ground: 0 });
  run(flight, { boost: true }, 6);
  assert.ok(flight.speed > 280);
  assert.equal(flight.targetSpeed, 100);
});

test('turning changes heading and banks right for a right turn', () => {
  const flight = createFlight({ speed: 100, targetSpeed: 100, ground: 0 });
  run(flight, { turn: 1 }, 1);
  assert.ok(flight.heading > 0.4 && flight.heading < 0.7);
  assert.ok(flight.roll > 0.1, 'right turn banks right (positive roll)');
  run(flight, {}, 3);
  assert.ok(Math.abs(flight.roll) < 0.02, 'roll relaxes to level');
});

test('mouse look moves heading and clamps pitch', () => {
  const flight = createFlight({ ground: 0 });
  stepFlight(flight, { lookX: 0.2, lookY: 5 }, 1 / 60, { here: 0 });
  assert.ok(Math.abs(flight.heading - 0.2) < 1e-9);
  assert.ok(flight.pitch <= FLIGHT_LIMITS.maxPitch + 1e-12);
});

test('terrain follow holds AGL over flat ground', () => {
  const flight = createFlight({ lat: 0.2, lng: 0.2, height: 900, agl: 900, speed: 100, targetSpeed: 100, pitch: -0.5 });
  run(flight, {}, 10, () => ({ here: 200 }));
  assert.ok(Math.abs(aboveGround(flight) - 900) < 5);
  assert.ok(Math.abs(flight.height - 1100) < 5);
});

test('terrain follow climbs ahead of a ridge using look-ahead', () => {
  const flight = createFlight({ lat: 0, lng: 0, height: 1_000, agl: 500, speed: 200, targetSpeed: 200, ground: 0 });
  // Ground is flat until 600 m ahead, then a 2 km wall.
  stepFlight(flight, {}, 1 / 60, { here: 0, ahead: [0, 0, 2_000] });
  assert.ok(flight.height > 1_000, 'starts climbing before the ridge is underneath');
});

test('never descends into terrain, even in free flight pointing down', () => {
  const flight = createFlight({ follow: false, height: 400, speed: 300, targetSpeed: 300, pitch: -1.2, ground: 100 });
  run(flight, {}, 10, () => ({ here: 100 }));
  assert.ok(flight.height >= 100 + FLIGHT_LIMITS.clearance - 1e-9);
});

test('free flight climbs where you look and Q/E-style climb works', () => {
  const flight = createFlight({ follow: false, height: 1_000, speed: 100, targetSpeed: 100, pitch: 0.3, ground: 0 });
  run(flight, {}, 2);
  assert.ok(flight.height > 1_050);
  const before = flight.height;
  run(flight, { climb: -1 }, 1);
  assert.ok(flight.height < before + 40);
});

test('terrain-follow altitude control scales AGL within limits', () => {
  const flight = createFlight({ agl: 900, ground: 0, height: 900 });
  run(flight, { climb: 1 }, 30);
  assert.equal(flight.agl, FLIGHT_LIMITS.maxAgl);
  run(flight, { climb: -1 }, 60);
  assert.equal(flight.agl, FLIGHT_LIMITS.minAgl);
});

test('unknown terrain never snaps the aircraft to sea level', () => {
  const flight = createFlight({ height: 3_000, agl: 500, speed: 100, targetSpeed: 100 });
  run(flight, {}, 3, () => ({ here: undefined, ahead: [undefined, undefined] }));
  assert.equal(flight.height, 3_000);
});

test('ceiling is enforced', () => {
  const flight = createFlight({ follow: false, height: FLIGHT_LIMITS.maxHeight - 10, speed: 1_000, targetSpeed: 1_000, pitch: 1.2, ground: 0 });
  run(flight, {}, 5);
  assert.equal(flight.height, FLIGHT_LIMITS.maxHeight);
});

test('look-ahead points lie along the heading and are empty when stopped', () => {
  assert.deepEqual(lookAheadPoints(createFlight({ speed: 0 })), []);
  const points = lookAheadPoints(createFlight({ speed: 500, heading: Math.PI / 2 }));
  assert.equal(points.length, 3);
  assert.ok(points[0].lng < points[2].lng && Math.abs(points[2].lat) < 1e-9);
});

test('teleport clears terrain knowledge and starts high', () => {
  const flight = createFlight({ height: 500, ground: 20 });
  teleportFlight(flight, 27.99 * D2R, 86.92 * D2R);
  assert.equal(flight.ground, undefined);
  assert.ok(flight.height >= 9_000);
});

test('log sliders round-trip', () => {
  for (const value of [10, 100, 900, 3000]) {
    assert.ok(Math.abs(fromLogPosition(toLogPosition(value, 10, 3000), 10, 3000) - value) < 1e-6);
  }
});

test('helpers', () => {
  assert.equal(maxDefined([undefined, 5, NaN, 9, 2]), 9);
  assert.equal(maxDefined([undefined]), undefined);
  assert.equal(compassLabel(0), 'N');
  assert.equal(compassLabel(Math.PI / 2), 'E');
  assert.equal(compassLabel(-Math.PI / 2), 'W');
});
