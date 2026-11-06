// Small, deterministic pieces of the atmosphere model. Keeping these outside
// the renderer makes the astronomical thresholds testable and keeps the WebGL
// shader focused on drawing the sky.
export const EARTH_RADIUS_KM = 6371;

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

/**
 * Angular depression of the geometric horizon for an observer above a sphere.
 * At sea level it is 0; at 10 km it is about 3.2 degrees.
 */
export function horizonDip(altitudeKm, radiusKm = EARTH_RADIUS_KM) {
  const height = Math.max(0, altitudeKm);
  return Math.acos(clamp(radiusKm / (radiusKm + height), -1, 1));
}

/**
 * Bennett's atmospheric-refraction approximation in radians. It is used only
 * near the horizon, where refraction changes the apparent sunrise/set time.
 * `density` accounts for the much thinner air at an elevated observer.
 */
export function solarRefraction(trueAltitude, density = 1) {
  const degrees = trueAltitude * 180 / Math.PI;
  if (degrees < -1 || degrees > 15) return 0;
  const minutes = 1.02 / Math.tan((degrees + 10.3 / (degrees + 5.11)) * Math.PI / 180);
  return clamp(minutes / 60, 0, 1) * density * Math.PI / 180;
}

export function apparentSolarAltitude(trueAltitude, density = 1) {
  return trueAltitude + solarRefraction(trueAltitude, density);
}

/**
 * Kasten & Young relative optical air mass. The value is deliberately capped:
 * below the horizon the direct beam is extinguished rather than becoming
 * numerically unstable.
 */
export function relativeAirMass(altitude) {
  const degrees = altitude * 180 / Math.PI;
  if (degrees <= -5) return 40;
  const denominator = Math.sin(altitude) + 0.50572 * (degrees + 6.07995) ** -1.6364;
  return clamp(1 / Math.max(denominator, 0.025), 1, 40);
}

/**
 * A compact RGB Beer-Lambert approximation for the direct solar beam. Blue is
 * removed first along a long, low-Sun path, producing the familiar warm sun.
 */
export function solarTransmission(altitude, density = 1) {
  const opticalDepth = relativeAirMass(altitude) * clamp(density, 0, 1);
  return [0.045, 0.12, 0.32].map(coefficient => Math.exp(-coefficient * opticalDepth));
}

export function solarPhase(altitude) {
  const degrees = altitude * 180 / Math.PI;
  if (degrees >= 6) return 'Daylight';
  if (degrees >= -0.833) return 'Golden hour';
  if (degrees >= -6) return 'Civil twilight';
  if (degrees >= -12) return 'Nautical twilight';
  if (degrees >= -18) return 'Astronomical twilight';
  return 'Night';
}
