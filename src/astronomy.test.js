import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apparentAngularDiameter,
  bvToTemperature,
  calculateSolarEvents,
  equatorialToHorizontal,
  greenwichMeanSiderealTime,
  julianDate,
  moonEquatorial,
  parseDeclination,
  parseRightAscension,
  precessJ2000,
  precessionMatrix,
  EQUATORIAL_TO_GALACTIC,
  temperatureToRgb,
} from '../src/astronomy.js';
import {
  daylightState,
  nextPhenomenon,
  phenomenaByName,
  timeToMinutes,
  usnoOneDayUrl,
} from '../src/solar-flow.js';

const D2R = Math.PI / 180;

test('parses BSC5 right ascension and declination strings', () => {
  assert.ok(Math.abs(parseRightAscension('18h 36m 56.3s') / D2R - 279.2345833) < 1e-6);
  assert.ok(Math.abs(parseDeclination('-16° 42′ 58″') / D2R + 16.7161111) < 1e-6);
  assert.ok(Math.abs(parseDeclination('+89° 15′ 51″') / D2R - 89.2641667) < 1e-6);
});

test('Julian date and GMST match the J2000 reference epoch', () => {
  const epoch = new Date('2000-01-01T12:00:00Z');
  assert.equal(julianDate(epoch), 2451545);
  assert.ok(Math.abs(greenwichMeanSiderealTime(epoch) / D2R - 280.46061837) < 1e-8);
});

test('an object at the observer zenith converts to altitude 90 degrees', () => {
  const date = new Date('2026-11-05T18:00:00Z');
  const latitude = 28.6139 * D2R;
  const longitude = 77.209 * D2R;
  const localSiderealTime = greenwichMeanSiderealTime(date) + longitude;
  const horizontal = equatorialToHorizontal(localSiderealTime, latitude, date, latitude, longitude);
  assert.ok(Math.abs(horizontal.altitude / D2R - 90) < 1e-6);
});

test('precession is an identity at J2000', () => {
  const position = precessJ2000(2.1, -0.4, new Date('2000-01-01T12:00:00Z'));
  assert.ok(Math.abs(position.ra - 2.1) < 1e-14);
  assert.ok(Math.abs(position.dec + 0.4) < 1e-14);
});

test('B-V and black-body colors distinguish blue and red stars', () => {
  assert.ok(bvToTemperature(-0.2) > bvToTemperature(1.6));
  const blue = temperatureToRgb(12000);
  const red = temperatureToRgb(3200);
  assert.ok(blue[2] > blue[0]);
  assert.ok(red[0] > red[2]);
});

test('local solar fallback agrees with the USNO Delhi example', () => {
  const events = calculateSolarEvents('2026-11-01', 28.6139 * D2R, 77.209 * D2R);
  assert.deepEqual(phenomenaByName(events.sundata), {
    'Begin Civil Twilight': '00:39',
    Rise: '01:03',
    'Upper Transit': '06:35',
    Set: '12:06',
    'End Civil Twilight': '12:31',
  });
});

test('daily flow handles daylight intervals that cross UTC midnight', () => {
  const sun = { Rise: '18:00', Set: '06:00', 'Begin Civil Twilight': '17:30', 'End Civil Twilight': '06:30' };
  assert.equal(daylightState(sun, timeToMinutes('23:00')), 'Daylight');
  assert.equal(daylightState(sun, timeToMinutes('05:00')), 'Daylight');
  assert.equal(daylightState(sun, timeToMinutes('12:00')), 'Night');
  assert.deepEqual(nextPhenomenon(sun, timeToMinutes('17:45')), { name: 'Rise', time: '18:00', delta: 15 });
});

test('USNO request includes date, location, UTC, and application ID', () => {
  const url = new URL(usnoOneDayUrl('2026-11-01', 28.6139, 77.209));
  assert.equal(url.searchParams.get('date'), '2026-11-01');
  assert.equal(url.searchParams.get('coords'), '28.6139,77.2090');
  assert.equal(url.searchParams.get('tz'), '0');
  assert.equal(url.searchParams.get('ID'), 'Earthviz');
});

test('lunar phase and distance agree with the USNO one-day result', () => {
  const moon = moonEquatorial(new Date('2026-11-01T12:00:00Z'));
  assert.ok(Math.abs(moon.illuminatedFraction - 0.54) < 0.01);
  assert.ok(moon.distanceKm > 350000 && moon.distanceKm < 410000);
});

test('full Moon epoch is rendered fully illuminated', () => {
  const moon = moonEquatorial(new Date('2000-01-21T04:40:00Z'));
  assert.ok(moon.illuminatedFraction > 0.999);
});

test('physical radii produce realistic varying apparent diameters', () => {
  const sunDiameter = apparentAngularDiameter(695700, 149597870.7) / D2R;
  const nearMoon = apparentAngularDiameter(1737.4, 356500) / D2R;
  const farMoon = apparentAngularDiameter(1737.4, 406700) / D2R;
  assert.ok(Math.abs(sunDiameter - 0.533) < 0.01);
  assert.ok(nearMoon > farMoon);
  assert.ok(farMoon > 0.48 && nearMoon < 0.57);
});

const mulMV = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const transpose = m => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const eqVector = (ra, dec) => [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];

test('precessionMatrix agrees with precessJ2000', () => {
  const date = new Date('2026-11-06T00:00:00Z');
  for (const [raDeg, decDeg] of [[101.287, -16.716], [279.234, 38.783], [10, 80], [200, -60]]) {
    const ra = raDeg * D2R;
    const dec = decDeg * D2R;
    const expected = precessJ2000(ra, dec, date);
    const got = mulMV(precessionMatrix(date), eqVector(ra, dec));
    const want = eqVector(expected.ra, expected.dec);
    for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(got[i] - want[i]) < 1e-9);
  }
});

test('Milky Way dome chain maps a precessed catalog star back to its galactic coordinates', () => {
  // Sirius, J2000 RA 101.2875 deg, Dec -16.7161 deg -> l 227.23, b -8.89 (BSC5 GLON/GLAT).
  const date = new Date('2026-11-06T00:00:00Z');
  const now = precessJ2000(101.2875 * D2R, -16.7161 * D2R, date);
  // Star-frame vector exactly as main.js builds it for the point cloud.
  const star = [Math.cos(now.dec) * Math.cos(now.ra), Math.sin(now.dec), -Math.cos(now.dec) * Math.sin(now.ra)];
  const equatorial = [star[0], -star[2], star[1]];
  const j2000 = mulMV(transpose(precessionMatrix(date)), equatorial);
  const g = mulMV(EQUATORIAL_TO_GALACTIC, j2000);
  const l = ((Math.atan2(g[1], g[0]) / D2R) + 360) % 360;
  const b = Math.asin(g[2]) / D2R;
  assert.ok(Math.abs(l - 227.23) < 0.02, `l=${l}`);
  assert.ok(Math.abs(b + 8.89) < 0.02, `b=${b}`);
});
