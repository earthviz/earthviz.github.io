// Keyless, global data sources added on top of NASA GIBS.
// Pure helpers only (no Cesium imports) so they can be unit-tested in Node.

/* ---------- Gaia overlays ---------- */
export const RAINVIEWER_URL = 'https://api.rainviewer.com/public/weather-maps.json';
// Free tier: global radar mosaic, ~10 min frames for the past 2 h, max zoom 7.
export const RADAR_MAX_ZOOM = 7;

export function radarFrames(json) {
  const host = typeof json?.host === 'string' && json.host.startsWith('https://') ? json.host : '';
  const past = Array.isArray(json?.radar?.past) ? json.radar.past : [];
  if (!host) return [];
  return past
    .filter(f => Number.isFinite(f?.time) && typeof f?.path === 'string' && f.path.startsWith('/'))
    .map(f => ({ time: f.time * 1000, url: `${host}${f.path}/256/{z}/{x}/{y}/2/1_1.png` }))
    .sort((a, b) => a.time - b.time);
}

// Both are global WMS colour-ramped elevation products.
export const HYPSOMETRIC_SOURCES = {
  gebco: {
    label: 'GEBCO · land + ocean depth',
    url: 'https://wms.gebco.net/mapserv',
    layers: 'GEBCO_LATEST',
    credit: 'GEBCO Compilation Group · GEBCO_LATEST (land elevation + ocean bathymetry)',
  },
  topo: {
    label: 'TOPO-WMS · land elevation',
    url: 'https://ows.terrestris.de/osm/service',
    layers: 'TOPO-WMS',
    credit: 'TOPO-WMS by terrestris/mundialis (SRTM 30 m / 450 m)',
  },
};

/* ---------- Spacetime: Landsat Global Land Survey epochs ---------- */
export const GLS_EPOCHS = [1975, 1990, 2000, 2005, 2010];
export const GLS_START_DATE = '1972-07-25';
export const GLS_SERVICE = 'https://landsat.arcgis.com/arcgis/rest/services/LandsatGLS/MS/ImageServer/exportImage';
export const GLS_MAX_ZOOM = 12;
const GLS_WINDOWS = { 1975: ['1972-07-25', '1980-12-31'], 1990: ['1986-01-01', '1997-12-31'], 2000: ['1998-01-01', '2002-12-31'], 2005: ['2003-01-01', '2007-12-31'], 2010: ['2008-01-01', '2012-01-30'] };

export function glsEpochForDate(iso) {
  const year = new Date(`${iso}T00:00:00Z`).getUTCFullYear();
  return GLS_EPOCHS.reduce((best, e) => (Math.abs(e - year) < Math.abs(best - year) ? e : best), GLS_EPOCHS[0]);
}

export function glsTileUrl(epoch) {
  const [from, to] = GLS_WINDOWS[epoch] ?? GLS_WINDOWS[2000];
  const time = `${Date.parse(`${from}T00:00:00Z`)},${Date.parse(`${to}T23:59:59Z`)}`;
  const rule = encodeURIComponent(JSON.stringify({ rasterFunction: 'Natural Color with DRA' }));
  return `${GLS_SERVICE}?bbox={westProjected},{southProjected},{eastProjected},{northProjected}`
    + `&bboxSR=3857&imageSR=3857&size=256,256&format=jpgpng&f=image&time=${time}&renderingRule=${rule}`;
}

/* ---------- Spacetime: Sentinel-2 L2A via Element 84 Earth Search ---------- */
export const E84_SEARCH_URL = 'https://earth-search.aws.element84.com/v1/search';
export const TITILER_URL = 'https://titiler.xyz/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png';
export const S2_WINDOW_DAYS = 10; // Sentinel-2 revisits every ~5 days; look back two passes.
export const S2_MAX_VIEW_DEGREES = 4; // skip the search when zoomed further out than this.

export function stacSearchBody({ west, south, east, north }, isoDate, windowDays = S2_WINDOW_DAYS) {
  const end = Date.parse(`${isoDate}T23:59:59Z`);
  const start = new Date(end - windowDays * 86400000).toISOString().slice(0, 10);
  return {
    collections: ['sentinel-2-l2a'],
    bbox: [west, south, east, north],
    datetime: `${start}T00:00:00Z/${isoDate}T23:59:59Z`,
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    limit: 100,
  };
}

function cogUrl(href) {
  if (typeof href !== 'string') return '';
  if (href.startsWith('s3://')) {
    const [bucket, ...key] = href.slice(5).split('/');
    return `https://${bucket}.s3.us-west-2.amazonaws.com/${key.join('/')}`;
  }
  return href.startsWith('https://') ? href : '';
}

// Newest scene per MGRS grid cell, preferring ones under 40 % cloud.
export function pickScenes(features, max = 24) {
  const byCell = new Map();
  for (const f of features ?? []) {
    const href = cogUrl(f?.assets?.visual?.href);
    const [w, s, e, n] = f?.bbox ?? [];
    if (!href || ![w, s, e, n].every(Number.isFinite) || w > e) continue; // skips antimeridian splits
    const cell = f.properties?.['grid:code'] ?? f.id;
    const cloud = Number(f.properties?.['eo:cloud_cover'] ?? 100);
    const scene = { id: f.id, href, cloud, datetime: f.properties?.datetime ?? '', rectangle: { west: w, south: s, east: e, north: n } };
    const prev = byCell.get(cell);
    const better = !prev || (prev.cloud > 40 && scene.cloud <= 40)
      || (scene.cloud <= 40 === prev.cloud <= 40 && scene.datetime > prev.datetime);
    if (better) byCell.set(cell, scene);
  }
  return [...byCell.values()].sort((a, b) => b.datetime.localeCompare(a.datetime)).slice(0, max);
}

export function titilerTileUrl(href) {
  return `${TITILER_URL}?url=${encodeURIComponent(href)}`;
}
