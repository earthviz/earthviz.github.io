// First-person "bird's-eye" flight model. Pure maths: no Cesium, no DOM, so it
// can be unit tested. The caller samples terrain and applies the result to the
// camera (see cesium-main.js).
//
// Conventions match Cesium's camera: heading 0 = north, increasing clockwise
// (east = +90°); pitch > 0 looks up; roll > 0 banks to the right.

const D2R = Math.PI / 180;
const WGS84_A = 6_378_137;
const WGS84_E2 = 0.006_694_379_990_14;

export const FLIGHT_LIMITS = Object.freeze({
  minSpeed: 10,            // m/s
  maxSpeed: 3_000,         // m/s
  minAgl: 20,              // m above ground, terrain-follow target
  maxAgl: 20_000,
  maxHeight: 1_500_000,    // hard ceiling above the ellipsoid
  clearance: 6,            // never closer than this to the terrain
  maxLatitude: 84.5 * D2R, // terrain data ends near ±85°
  maxPitch: 85 * D2R,
  minFov: 35 * D2R,
  maxFov: 110 * D2R,
});

export const FLIGHT_DEFAULTS = Object.freeze({
  speed: 100,
  agl: 900,
  pitch: -10 * D2R,
  fov: 70 * D2R,
});

const BOOST = 3;
const TURN_RATE = 0.55;          // rad/s with a held turn key
const PITCH_RATE = 0.7;          // rad/s with a held pitch key
const THROTTLE_RATE = 0.9;       // e-folds per second of speed change
const MAX_BANK = 0.5;            // rad of cosmetic roll
const LOOKAHEAD_SECONDS = [0.6, 1.4, 2.6];
const LOOKAHEAD_MAX_METERS = 6_000;

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const wrapPi = value => ((value + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;

// Log-scale sliders: positions are 0..1 so ranges stay usable across 2–3 decades.
export const toLogPosition = (value, lo, hi) => clamp(Math.log(value / lo) / Math.log(hi / lo), 0, 1);
export const fromLogPosition = (position, lo, hi) => lo * (hi / lo) ** clamp(position, 0, 1);

export function createFlight(overrides = {}) {
  return {
    lat: 0,
    lng: 0,
    height: 1_000,            // above the ellipsoid, metres
    heading: 0,
    pitch: FLIGHT_DEFAULTS.pitch,
    roll: 0,
    speed: 0,                 // current ground-relative speed, m/s
    targetSpeed: FLIGHT_DEFAULTS.speed,
    agl: FLIGHT_DEFAULTS.agl, // terrain-follow target clearance
    follow: true,             // true: hold AGL; false: fly where you look
    paused: false,
    ground: undefined,        // last terrain height seen under the aircraft
    ...overrides,
  };
}

/** Metres per radian of latitude / longitude at a latitude and height. */
export function metersPerRadian(lat, height = 0) {
  const s = Math.sin(lat);
  const w = 1 - WGS84_E2 * s * s;
  const meridional = WGS84_A * (1 - WGS84_E2) / w ** 1.5;
  const primeVertical = WGS84_A / Math.sqrt(w);
  const h = Math.max(0, height);
  return { lat: meridional + h, lng: (primeVertical + h) * Math.max(Math.cos(lat), 1e-6) };
}

/** Move along a constant heading (rhumb line) by `distance` metres. */
export function advance(lat, lng, height, heading, distance) {
  const m = metersPerRadian(lat, height);
  const nextLat = clamp(lat + (distance * Math.cos(heading)) / m.lat, -FLIGHT_LIMITS.maxLatitude, FLIGHT_LIMITS.maxLatitude);
  const nextLng = wrapPi(lng + (distance * Math.sin(heading)) / m.lng);
  return { lat: nextLat, lng: nextLng };
}

/** Points ahead of the aircraft whose terrain height should be sampled. */
export function lookAheadPoints(flight) {
  if (flight.speed < 1) return [];
  return LOOKAHEAD_SECONDS.map(seconds => {
    const distance = Math.min(flight.speed * seconds, LOOKAHEAD_MAX_METERS);
    return advance(flight.lat, flight.lng, flight.height, flight.heading, distance);
  });
}

/** The highest of the defined terrain samples, or undefined if none are. */
export function maxDefined(values) {
  let best;
  for (const value of values) if (Number.isFinite(value) && (best === undefined || value > best)) best = value;
  return best;
}

/**
 * Advance the flight by `dt` seconds.
 * input: { throttle, turn, climb, pitch: -1..1, boost, lookX, lookY (radians this frame) }
 * terrain: { here, ahead } terrain heights in metres (either may be undefined).
 */
export function stepFlight(flight, input, dt, terrain = {}) {
  const L = FLIGHT_LIMITS;
  const {
    throttle = 0, turn = 0, climb = 0, pitch: pitchKey = 0, boost = false, lookX = 0, lookY = 0,
  } = input;

  // Speed: keys scale the cruise speed exponentially; boost and pause shape the effective target.
  if (throttle) flight.targetSpeed = clamp(flight.targetSpeed * Math.exp(throttle * THROTTLE_RATE * dt), L.minSpeed, L.maxSpeed);
  const wanted = flight.paused ? 0 : Math.min(flight.targetSpeed * (boost ? BOOST : 1), L.maxSpeed * BOOST);
  flight.speed += (wanted - flight.speed) * (1 - Math.exp(-dt / (wanted > flight.speed ? 0.8 : 0.45)));
  if (flight.speed < 0.05) flight.speed = 0;

  // Heading and pitch.
  const headingDelta = turn * TURN_RATE * dt + lookX;
  flight.heading = wrapPi(flight.heading + headingDelta);
  flight.pitch = clamp(flight.pitch + pitchKey * PITCH_RATE * dt + lookY, -L.maxPitch, L.maxPitch);

  // Bank into turns for feel; the roll relaxes back to level.
  const turnRate = dt > 0 ? headingDelta / dt : 0;
  const bank = clamp(turnRate * 0.9, -MAX_BANK, MAX_BANK);
  flight.roll += (bank - flight.roll) * (1 - Math.exp(-dt / 0.25));

  // Horizontal motion.
  const groundSpeed = flight.follow ? flight.speed : flight.speed * Math.cos(flight.pitch);
  const moved = advance(flight.lat, flight.lng, flight.height, flight.heading, groundSpeed * dt);
  flight.lat = moved.lat;
  flight.lng = moved.lng;

  // Terrain bookkeeping: never trust a missing sample to mean "ground is at 0".
  const here = Number.isFinite(terrain.here) ? terrain.here : undefined;
  const ahead = maxDefined([terrain.here, ...(Array.isArray(terrain.ahead) ? terrain.ahead : [terrain.ahead])]);
  if (here !== undefined) flight.ground = here;
  const groundKnown = ahead !== undefined || flight.ground !== undefined;
  const ground = ahead ?? flight.ground;

  // Vertical motion.
  if (flight.follow) {
    if (climb) flight.agl = clamp(flight.agl * Math.exp(climb * 0.9 * dt), L.minAgl, L.maxAgl);
    if (groundKnown) {
      const target = ground + flight.agl;
      // Rise fast over ridges, descend gently into valleys.
      const tau = target > flight.height ? 0.4 : 1.4;
      flight.height += (target - flight.height) * (1 - Math.exp(-dt / tau));
    }
  } else {
    const climbRate = 0.35 * Math.max(flight.speed, 60);
    flight.height += Math.sin(flight.pitch) * flight.speed * dt + climb * climbRate * dt;
  }

  // Hard limits: ceiling, and keep clear of the terrain directly below.
  flight.height = Math.min(flight.height, L.maxHeight);
  if (flight.ground !== undefined) flight.height = Math.max(flight.height, flight.ground + L.clearance);
  if (!flight.follow && flight.ground !== undefined) flight.agl = clamp(flight.height - flight.ground, L.minAgl, L.maxAgl);

  return flight;
}

/** Height above the terrain last seen under the aircraft. */
export function aboveGround(flight) {
  return flight.ground === undefined ? undefined : Math.max(0, flight.height - flight.ground);
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function compassLabel(heading) {
  const degrees = ((heading / D2R) % 360 + 360) % 360;
  return COMPASS[Math.round(degrees / 45) % 8];
}

export function formatDistance(meters) {
  const value = Math.abs(meters);
  if (value < 1_000) return `${Math.round(meters).toLocaleString('en-US')} m`;
  return `${(meters / 1_000).toFixed(value < 10_000 ? 2 : 1)} km`;
}

export const metersPerSecondToKmh = value => value * 3.6;

/** Jump somewhere new. Terrain there is unknown, so start high and settle once it loads. */
export function teleportFlight(flight, lat, lng) {
  flight.lat = clamp(lat, -FLIGHT_LIMITS.maxLatitude, FLIGHT_LIMITS.maxLatitude);
  flight.lng = wrapPi(lng);
  flight.ground = undefined;
  flight.height = Math.max(flight.height, 9_000);
  return flight;
}
