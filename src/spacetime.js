export const GIBS_START_DATE = '2000-02-24';
export const GIBS_LAYER = 'MODIS_Terra_CorrectedReflectance_TrueColor';
export const GIBS_NATIVE_MAX_ZOOM = 9;
export const HLS_NATIVE_MAX_ZOOM = 12;
export const HLS_L30_LAYER = 'HLS_L30_Nadir_BRDF_Adjusted_Reflectance';
export const HLS_S30_LAYER = 'HLS_S30_Nadir_BRDF_Adjusted_Reflectance';
export const DAY_MS = 86400000;

export function isoToDay(value) {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / DAY_MS);
}

export function dayToIso(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function clampDay(day, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, day));
}

export function previousUtcDate(now = new Date()) {
  return dayToIso(Math.floor(now.getTime() / DAY_MS) - 1);
}

export function nearestGibsDate(date) {
  const day = isoToDay(date);
  const firstDay = isoToDay(GIBS_START_DATE);
  return dayToIso(day > firstDay ? day - 1 : day + 1);
}

export function isGibsNoData(red, green, blue, alpha = 255) {
  // This JPEG layer encodes empty orbital swaths as neutral, near-black pixels.
  // A brightness threshold alone also catches real water and terrain shadows,
  // producing the patchwork effect that we explicitly want to avoid.
  const darkest = Math.min(red, green, blue);
  const brightest = Math.max(red, green, blue);
  return alpha < 8 || (brightest <= 12 && brightest - darkest <= 3);
}

export function gibsAncestor(z, x, y, maxZoom = GIBS_NATIVE_MAX_ZOOM) {
  const ancestorZ = Math.min(z, maxZoom);
  const scale = 2 ** (z - ancestorZ);
  return {
    z: ancestorZ,
    x: Math.floor(x / scale),
    y: Math.floor(y / scale),
    scale,
    childX: x % scale,
    childY: y % scale,
  };
}

export function gibsTileUrl(date, z, x, y) {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${GIBS_LAYER}/default/${date}/GoogleMapsCompatible_Level9/${z}/${y}/${x}.jpg`;
}

export function hlsTileUrl(layer, date, z, x, y) {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/GoogleMapsCompatible_Level12/${z}/${y}/${x}.png`;
}
