export const GIBS_START_DATE = '2000-02-24';
export const GIBS_LAYER = 'MODIS_Terra_CorrectedReflectance_TrueColor';
export const GIBS_NATIVE_MAX_ZOOM = 9;
export const GIBS_DAILY_SOURCES = {
  'modis-terra': {
    layer: GIBS_LAYER,
    label: 'MODIS Terra · True color',
    startDate: GIBS_START_DATE,
  },
  'modis-aqua': {
    layer: 'MODIS_Aqua_CorrectedReflectance_TrueColor',
    label: 'MODIS Aqua · True color',
    startDate: '2002-07-03',
  },
  'viirs-snpp': {
    layer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
    label: 'VIIRS Suomi NPP · True color',
    startDate: '2015-11-24',
  },
  'viirs-noaa20': {
    layer: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
    label: 'VIIRS NOAA-20 · True color',
    startDate: '2018-01-05',
  },
};
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

export function gibsTileUrl(date, z, x, y, source = 'modis-terra') {
  const definition = GIBS_DAILY_SOURCES[source] ?? GIBS_DAILY_SOURCES['modis-terra'];
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${definition.layer}/default/${date}/GoogleMapsCompatible_Level9/${z}/${y}/${x}.jpeg`;
}

export function hlsTileUrl(layer, date, z, x, y) {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/GoogleMapsCompatible_Level12/${z}/${y}/${x}.png`;
}
