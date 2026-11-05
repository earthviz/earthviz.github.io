const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const ARCSEC_TO_RAD = D2R / 3600;
const J2000 = 2451545;

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const wrapRadians = value => ((value % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

export function parseRightAscension(value) {
  const match = String(value).match(/(\d+)h\s*(\d+)m\s*([\d.]+)s/i);
  if (!match) return NaN;
  return (+match[1] + +match[2] / 60 + +match[3] / 3600) * 15 * D2R;
}

export function parseDeclination(value) {
  const match = String(value).match(/([+-])\s*(\d+)[°d]\s*(\d+)[′']\s*([\d.]+)[″"]/i);
  if (!match) return NaN;
  const degrees = +match[2] + +match[3] / 60 + +match[4] / 3600;
  return (match[1] === '-' ? -degrees : degrees) * D2R;
}

export function julianDate(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

export function greenwichMeanSiderealTime(date) {
  const jd = julianDate(date);
  const centuries = (jd - J2000) / 36525;
  const degrees = 280.46061837
    + 360.98564736629 * (jd - J2000)
    + 0.000387933 * centuries * centuries
    - centuries * centuries * centuries / 38710000;
  return wrapRadians(degrees * D2R);
}

// IAU 1976 precession is more precise than the BSC5 source coordinates at the
// dates this viewer supports. Inputs and outputs are equatorial radians.
export function precessJ2000(ra, dec, date) {
  const centuries = (julianDate(date) - J2000) / 36525;
  if (Math.abs(centuries) < 1e-12) return { ra: wrapRadians(ra), dec };
  const t2 = centuries * centuries;
  const t3 = t2 * centuries;
  const zeta = (2306.2181 * centuries + 0.30188 * t2 + 0.017998 * t3) * ARCSEC_TO_RAD;
  const z = (2306.2181 * centuries + 1.09468 * t2 + 0.018203 * t3) * ARCSEC_TO_RAD;
  const theta = (2004.3109 * centuries - 0.42665 * t2 - 0.041833 * t3) * ARCSEC_TO_RAD;
  const a = Math.cos(dec) * Math.sin(ra + zeta);
  const b = Math.cos(theta) * Math.cos(dec) * Math.cos(ra + zeta) - Math.sin(theta) * Math.sin(dec);
  const c = Math.sin(theta) * Math.cos(dec) * Math.cos(ra + zeta) + Math.cos(theta) * Math.sin(dec);
  return { ra: wrapRadians(Math.atan2(a, b) + z), dec: Math.asin(clamp(c, -1, 1)) };
}

// Row-major 3x3 matrix taking J2000 equatorial unit vectors (X toward RA 0,
// Z toward the pole) to the equinox of `date`. Same IAU 1976 angles as
// precessJ2000, so catalog stars and the Milky Way dome stay consistent.
export function precessionMatrix(date) {
  const centuries = (julianDate(date) - J2000) / 36525;
  const t2 = centuries * centuries;
  const t3 = t2 * centuries;
  const zeta = (2306.2181 * centuries + 0.30188 * t2 + 0.017998 * t3) * ARCSEC_TO_RAD;
  const z = (2306.2181 * centuries + 1.09468 * t2 + 0.018203 * t3) * ARCSEC_TO_RAD;
  const theta = (2004.3109 * centuries - 0.42665 * t2 - 0.041833 * t3) * ARCSEC_TO_RAD;
  const cz = Math.cos(zeta), sz = Math.sin(zeta);
  const cZ = Math.cos(z), sZ = Math.sin(z);
  const ct = Math.cos(theta), st = Math.sin(theta);
  // P = Rz(z) * Ry'(theta) * Rz(zeta)
  return [
    cZ * ct * cz - sZ * sz, -cZ * ct * sz - sZ * cz, -cZ * st,
    sZ * ct * cz + cZ * sz, -sZ * ct * sz + cZ * cz, -sZ * st,
    st * cz, -st * sz, ct,
  ];
}

// J2000 equatorial -> galactic (Hipparcos/ESA 1997 definition), row-major.
export const EQUATORIAL_TO_GALACTIC = [
  -0.0548755604162154, -0.8734370902348850, -0.4838350155487132,
  0.4941094278755837, -0.4448296299600112, 0.7469822444972189,
  -0.8676661490190047, -0.1980763734312015, 0.4559837761750669,
];

export function catalogEquatorial(star, date) {
  let ra = parseRightAscension(star.RA);
  let dec = parseDeclination(star.Dec);
  const years = (julianDate(date) - J2000) / 365.25;
  // BSC5 pmRA is seconds of time/year; pmDE is arcseconds/year.
  ra += (Number.parseFloat(star.pmRA) || 0) * years * 15 * ARCSEC_TO_RAD;
  dec += (Number.parseFloat(star.pmDE) || 0) * years * ARCSEC_TO_RAD;
  return precessJ2000(ra, dec, date);
}

export function equatorialToHorizontal(ra, dec, date, latitude, longitude) {
  const hourAngle = greenwichMeanSiderealTime(date) + longitude - ra;
  const sinAltitude = Math.sin(latitude) * Math.sin(dec)
    + Math.cos(latitude) * Math.cos(dec) * Math.cos(hourAngle);
  const altitude = Math.asin(clamp(sinAltitude, -1, 1));
  const east = -Math.cos(dec) * Math.sin(hourAngle);
  const north = Math.sin(dec) * Math.cos(latitude)
    - Math.cos(dec) * Math.cos(hourAngle) * Math.sin(latitude);
  return { altitude, azimuth: wrapRadians(Math.atan2(east, north)) };
}

export function sunEquatorial(date) {
  const centuries = (julianDate(date) - J2000) / 36525;
  const meanLongitude = (280.46646 + centuries * (36000.76983 + 0.0003032 * centuries)) * D2R;
  const meanAnomaly = (357.52911 + centuries * (35999.05029 - 0.0001537 * centuries)) * D2R;
  const equation = (
    (1.914602 - 0.004817 * centuries - 0.000014 * centuries * centuries) * Math.sin(meanAnomaly)
    + (0.019993 - 0.000101 * centuries) * Math.sin(2 * meanAnomaly)
    + 0.000289 * Math.sin(3 * meanAnomaly)
  ) * D2R;
  const omega = (125.04 - 1934.136 * centuries) * D2R;
  const longitude = meanLongitude + equation - 0.00569 * D2R - 0.00478 * D2R * Math.sin(omega);
  const seconds = 21.448 - centuries * (46.815 + centuries * (0.00059 - centuries * 0.001813));
  const obliquity = (23 + 26 / 60 + seconds / 3600 + 0.00256 * Math.cos(omega)) * D2R;
  const eccentricity = 0.016708634 - centuries * (0.000042037 + 0.0000001267 * centuries);
  const trueAnomaly = meanAnomaly + equation;
  return {
    ra: wrapRadians(Math.atan2(Math.cos(obliquity) * Math.sin(longitude), Math.cos(longitude))),
    dec: Math.asin(Math.sin(obliquity) * Math.sin(longitude)),
    distanceAu: 1.000001018 * (1 - eccentricity * eccentricity) / (1 + eccentricity * Math.cos(trueAnomaly)),
  };
}

export function moonEquatorial(date) {
  // Compact lunar theory with the principal evection, variation, annual
  // equation, latitude, and distance terms. It is intended for visual
  // topocentric placement rather than eclipse prediction.
  const days = julianDate(date) - 2451543.5;
  const node = wrapRadians((125.1228 - 0.0529538083 * days) * D2R);
  const inclination = 5.1454 * D2R;
  const periapsis = wrapRadians((318.0634 + 0.1643573223 * days) * D2R);
  const meanAnomaly = wrapRadians((115.3654 + 13.0649929509 * days) * D2R);
  const semiMajorAxis = 60.2666;
  const eccentricity = 0.0549;
  const eccentricAnomaly = meanAnomaly
    + eccentricity * Math.sin(meanAnomaly) * (1 + eccentricity * Math.cos(meanAnomaly));
  const orbitalX = semiMajorAxis * (Math.cos(eccentricAnomaly) - eccentricity);
  const orbitalY = semiMajorAxis * Math.sqrt(1 - eccentricity * eccentricity) * Math.sin(eccentricAnomaly);
  const trueAnomaly = Math.atan2(orbitalY, orbitalX);
  let distanceEarthRadii = Math.hypot(orbitalX, orbitalY);
  const eclipticX = distanceEarthRadii * (
    Math.cos(node) * Math.cos(trueAnomaly + periapsis)
    - Math.sin(node) * Math.sin(trueAnomaly + periapsis) * Math.cos(inclination)
  );
  const eclipticY = distanceEarthRadii * (
    Math.sin(node) * Math.cos(trueAnomaly + periapsis)
    + Math.cos(node) * Math.sin(trueAnomaly + periapsis) * Math.cos(inclination)
  );
  const eclipticZ = distanceEarthRadii * Math.sin(trueAnomaly + periapsis) * Math.sin(inclination);
  let longitude = Math.atan2(eclipticY, eclipticX);
  let latitude = Math.atan2(eclipticZ, Math.hypot(eclipticX, eclipticY));

  const solarPeriapsis = wrapRadians((282.9404 + 0.0000470935 * days) * D2R);
  const solarAnomaly = wrapRadians((356.0470 + 0.9856002585 * days) * D2R);
  const solarLongitude = wrapRadians(solarPeriapsis + solarAnomaly);
  const lunarLongitude = wrapRadians(node + periapsis + meanAnomaly);
  const elongation = wrapRadians(lunarLongitude - solarLongitude);
  const argumentLatitude = wrapRadians(lunarLongitude - node);
  longitude += D2R * (
    -1.274 * Math.sin(meanAnomaly - 2 * elongation)
    + 0.658 * Math.sin(2 * elongation)
    - 0.186 * Math.sin(solarAnomaly)
    - 0.059 * Math.sin(2 * meanAnomaly - 2 * elongation)
    - 0.057 * Math.sin(meanAnomaly - 2 * elongation + solarAnomaly)
    + 0.053 * Math.sin(meanAnomaly + 2 * elongation)
    + 0.046 * Math.sin(2 * elongation - solarAnomaly)
    + 0.041 * Math.sin(meanAnomaly - solarAnomaly)
    - 0.035 * Math.sin(elongation)
    - 0.031 * Math.sin(meanAnomaly + solarAnomaly)
    - 0.015 * Math.sin(2 * argumentLatitude - 2 * elongation)
    + 0.011 * Math.sin(meanAnomaly - 4 * elongation)
  );
  latitude += D2R * (
    -0.173 * Math.sin(argumentLatitude - 2 * elongation)
    - 0.055 * Math.sin(meanAnomaly - argumentLatitude - 2 * elongation)
    - 0.046 * Math.sin(meanAnomaly + argumentLatitude - 2 * elongation)
    + 0.033 * Math.sin(argumentLatitude + 2 * elongation)
    + 0.017 * Math.sin(2 * meanAnomaly + argumentLatitude)
  );
  distanceEarthRadii += -0.58 * Math.cos(meanAnomaly - 2 * elongation) - 0.46 * Math.cos(2 * elongation);

  const obliquity = (23.4393 - 0.0000003563 * days) * D2R;
  const x = Math.cos(longitude) * Math.cos(latitude);
  const y = Math.sin(longitude) * Math.cos(latitude);
  const z = Math.sin(latitude);
  const equatorialY = y * Math.cos(obliquity) - z * Math.sin(obliquity);
  const equatorialZ = y * Math.sin(obliquity) + z * Math.cos(obliquity);
  const ra = wrapRadians(Math.atan2(equatorialY, x));
  const dec = Math.atan2(equatorialZ, Math.hypot(x, equatorialY));
  const sun = sunEquatorial(date);
  const separationCosine = Math.sin(dec) * Math.sin(sun.dec)
    + Math.cos(dec) * Math.cos(sun.dec) * Math.cos(ra - sun.ra);
  return {
    ra,
    dec,
    distanceKm: distanceEarthRadii * 6378.137,
    illuminatedFraction: (1 - clamp(separationCosine, -1, 1)) / 2,
  };
}

function formatUtcMinutes(value) {
  const minutes = Math.round(value + 1440) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function solarAltitude(date, latitude, longitude) {
  const sun = sunEquatorial(date);
  return equatorialToHorizontal(sun.ra, sun.dec, date, latitude, longitude).altitude;
}

function solarCrossings(midnight, latitude, longitude, altitude) {
  const crossings = [];
  const sample = minute => solarAltitude(new Date(midnight.getTime() + minute * 60000), latitude, longitude) - altitude;
  let previousMinute = 0;
  let previous = sample(0);
  for (let minute = 10; minute <= 1440; minute += 10) {
    const current = sample(minute);
    if ((previous <= 0 && current > 0) || (previous >= 0 && current < 0)) {
      let low = previousMinute;
      let high = minute;
      for (let iteration = 0; iteration < 18; iteration += 1) {
        const middle = (low + high) / 2;
        if ((sample(middle) > 0) === (current > 0)) high = middle;
        else low = middle;
      }
      crossings.push({ minute: (low + high) / 2, rising: current > previous });
    }
    previousMinute = minute;
    previous = current;
  }
  return crossings;
}

// Offline fallback for the daily USNO request. The standard -0.833° apparent
// horizon and -6° civil-twilight limits include the conventional refraction
// and solar-radius allowances used by rise/set tables.
export function calculateSolarEvents(dateString, latitude, longitude) {
  const midnight = new Date(`${dateString}T00:00:00Z`);
  const horizon = solarCrossings(midnight, latitude, longitude, -0.833 * D2R);
  const civil = solarCrossings(midnight, latitude, longitude, -6 * D2R);
  let transitMinute = 0;
  let highest = -Infinity;
  for (let minute = 0; minute < 1440; minute += 5) {
    const altitude = solarAltitude(new Date(midnight.getTime() + minute * 60000), latitude, longitude);
    if (altitude > highest) {
      highest = altitude;
      transitMinute = minute;
    }
  }
  const rise = horizon.find(event => event.rising);
  const set = horizon.find(event => !event.rising);
  const dawn = civil.find(event => event.rising);
  const dusk = civil.find(event => !event.rising);
  return {
    sundata: [
      dawn && { phen: 'Begin Civil Twilight', time: formatUtcMinutes(dawn.minute) },
      rise && { phen: 'Rise', time: formatUtcMinutes(rise.minute) },
      { phen: 'Upper Transit', time: formatUtcMinutes(transitMinute) },
      set && { phen: 'Set', time: formatUtcMinutes(set.minute) },
      dusk && { phen: 'End Civil Twilight', time: formatUtcMinutes(dusk.minute) },
    ].filter(Boolean),
    polarState: horizon.length ? null : (highest > -0.833 * D2R ? 'alwaysUp' : 'alwaysDown'),
  };
}

export function bvToTemperature(value, fallback = 6500) {
  const bv = Number.parseFloat(value);
  if (!Number.isFinite(bv)) return fallback;
  const limited = clamp(bv, -0.4, 2);
  return 4600 * (1 / (0.92 * limited + 1.7) + 1 / (0.92 * limited + 0.62));
}

// Approximate black-body chromaticity in display sRGB. This intentionally
// preserves hue while point size carries most of the apparent brightness.
export function temperatureToRgb(kelvin) {
  const temperature = clamp(kelvin, 1000, 40000) / 100;
  let red;
  let green;
  let blue;
  if (temperature <= 66) {
    red = 255;
    green = 99.4708025861 * Math.log(temperature) - 161.1195681661;
    blue = temperature <= 19 ? 0 : 138.5177312231 * Math.log(temperature - 10) - 305.0447927307;
  } else {
    red = 329.698727446 * ((temperature - 60) ** -0.1332047592);
    green = 288.1221695283 * ((temperature - 60) ** -0.0755148492);
    blue = 255;
  }
  return [red, green, blue].map(channel => clamp(channel, 0, 255) / 255);
}

export function starRgb(star) {
  const catalogTemperature = Number.parseFloat(star.K);
  return temperatureToRgb(bvToTemperature(star['B-V'], catalogTemperature || 6500));
}

export function degrees(radians) {
  return radians * R2D;
}

export function apparentAngularDiameter(radius, distance) {
  return 2 * Math.asin(clamp(radius / distance, -1, 1));
}
