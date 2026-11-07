// NASA GIBS (Gaia mode): layer catalog from WMTS GetCapabilities + time stepping.
export const GIBS_CAPABILITIES_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&request=GetCapabilities';
const MAX_CAPABILITIES_BYTES = 40_000_000;
const PERIOD = /^(.+?)\/(.+?)\/P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

// "2012-05-08/2013-05-29/P1D" (comma-separated for several ranges) → periods.
export function parsePeriods(values) {
  const periods = [];
  for (const raw of values.flatMap(v => String(v).split(','))) {
    const m = PERIOD.exec(raw.trim());
    if (!m) continue;
    const start = Date.parse(m[1].length === 10 ? `${m[1]}T00:00:00Z` : m[1]);
    const end = Date.parse(m[2].length === 10 ? `${m[2]}T00:00:00Z` : m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const [y, mo, w, d, h, mi, s] = m.slice(3).map(n => +n || 0);
    const ms = ((w * 7 + d) * 86400 + h * 3600 + mi * 60 + s) * 1000;
    if (!y && !mo && !ms) continue;
    periods.push({ start, end, months: y * 12 + mo, ms, intraday: !!(h || mi || s) });
  }
  return periods.sort((a, b) => a.start - b.start);
}

function addStep(ms, p, n) {
  const d = new Date(ms);
  if (p.months) d.setUTCMonth(d.getUTCMonth() + p.months * n);
  return d.getTime() + p.ms * n;
}

// Nearest valid observation time at or before `ms` (or the first one).
export function snapTime(ms, periods) {
  if (!periods.length) return ms;
  let p = periods.find(q => ms >= q.start && ms <= q.end);
  if (!p) return ms < periods[0].start ? periods[0].start : snapTime(periods.at(-1).end, periods);
  if (!p.months) return Math.min(p.end, p.start + Math.floor((ms - p.start) / p.ms) * p.ms);
  let t = p.start;
  while (true) {
    const next = addStep(t, p, 1);
    if (next > ms || next > p.end) return t;
    t = next;
  }
}

export function stepTime(ms, periods, dir) {
  if (!periods.length) return ms;
  const t = snapTime(ms, periods);
  const i = periods.findIndex(q => t >= q.start && t <= q.end);
  const p = periods[i];
  const next = addStep(t, p, dir);
  if (next >= p.start && next <= p.end) return next;
  if (dir > 0) return periods[i + 1]?.start ?? t;
  return periods[i - 1]?.end ?? t;
}

export function formatGibsTime(ms, intraday) {
  const iso = new Date(ms).toISOString();
  return intraday ? `${iso.slice(0, 19)}Z` : iso.slice(0, 10);
}

export function gaiaTileUrl(layer, time) {
  const ext = layer.format === 'image/jpeg' ? 'jpeg' : 'png';
  const when = layer.periods.length ? `${formatGibsTime(time, layer.periods.some(p => p.intraday))}/` : '';
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer.id}/default/${when}${layer.tileMatrixSet}/{z}/{y}/{x}.${ext}`;
}

export const GIBS_CATEGORIES = [
  ['Clouds', /cloud/i],
  ['Vegetation', /ndvi|evi\b|vegetation|leaf_area|lai\b|fpar|canopy|greenness/i],
  ['Fires', /fire|thermal_anomal|firms/i],
  ['Air', /aerosol|optical_depth|aod|no2|so2|carbon|ozone|methane|dust|smoke|air_quality/i],
  ['Ocean', /sea_surface|sst|chlorophyll|ocean|bathymetry|salinity|sea_level|currents/i],
  ['Snow & ice', /snow|sea_ice|ice_|glacier|ice\b/i],
  ['Heat', /temperature|land_surface_temp|lst\b|heat/i],
  ['Rain', /precip|rain|imerg|flood|water_vapor|moisture/i],
  ['Night', /night|black_marble|lights/i],
];

export function matchesCategory(layer, name) {
  const entry = GIBS_CATEGORIES.find(([label]) => label === name);
  return !entry || entry[1].test(`${layer.id} ${layer.title}`);
}

const kids = (el, name) => [...el.getElementsByTagNameNS('*', name)];
const text = (el, name) => kids(el, name)[0]?.textContent.trim() ?? '';

export function parseCapabilities(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const layers = [];
  for (const el of kids(doc, 'Layer')) {
    const id = text(el, 'Identifier');
    const formats = kids(el, 'Format').map(f => f.textContent.trim());
    const format = formats.find(f => f === 'image/png') ?? formats.find(f => f === 'image/jpeg');
    const tms = kids(el, 'TileMatrixSet').map(t => t.textContent.trim()).find(t => /^GoogleMapsCompatible_Level\d+$/.test(t));
    if (!id || !format || !tms) continue; // skips vector tiles and non-3857 sets
    const dim = kids(el, 'Dimension').find(d => text(d, 'Identifier').toLowerCase() === 'time');
    const periods = dim ? parsePeriods(kids(dim, 'Value').map(v => v.textContent)) : [];
    const def = dim ? Date.parse(text(dim, 'Default').length === 10 ? `${text(dim, 'Default')}T00:00:00Z` : text(dim, 'Default')) : NaN;
    const [west, south] = text(el, 'LowerCorner').split(/\s+/).map(Number);
    const [east, north] = text(el, 'UpperCorner').split(/\s+/).map(Number);
    const bbox = [west, south, east, north].every(Number.isFinite) ? { west, south, east, north } : null;
    layers.push({
      id, format, tileMatrixSet: tms, bbox,
      title: kids(el, 'Title').find(t => t.parentNode === el)?.textContent.trim() || id,
      maxLevel: +tms.match(/\d+$/)[0],
      periods,
      defaultTime: periods.length ? snapTime(Number.isFinite(def) ? def : periods.at(-1).end, periods) : null,
    });
  }
  return layers.sort((a, b) => a.title.localeCompare(b.title));
}

export async function fetchGibsCatalog(fetchFn = fetch, signal) {
  const response = await fetchFn(GIBS_CAPABILITIES_URL, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error(`GIBS capabilities ${response.status}`);
  const body = await response.text();
  if (body.length > MAX_CAPABILITIES_BYTES) throw new Error('GIBS capabilities too large');
  return parseCapabilities(body);
}

// Hand-picked entry points for newcomers. Resolved against the live catalog by
// id, so anything GIBS renames or retires quietly drops out of the list.
export const GAIA_FEATURED = [
  { group: 'Live & weather', id: 'IMERG_Precipitation_Rate_30min', label: 'Rain, last 30 min', hint: 'Satellite rainfall, with history' },
  { group: 'Live & weather', id: 'GOES-East_ABI_GeoColor', label: 'Live Americas', hint: 'Geostationary true colour' },
  { group: 'Live & weather', id: 'Himawari_AHI_Band3_Red_Visible_1km', label: 'Live Asia–Pacific', hint: 'Himawari visible clouds' },
  { group: 'Live & weather', id: 'MODIS_Terra_Cloud_Top_Temp_Day', label: 'Storm tops', hint: 'Cloud-top temperature' },
  { group: 'Land & fire', id: 'MODIS_Terra_Thermal_Anomalies_All', label: 'Active fires', hint: 'Wildfire hotspots' },
  { group: 'Land & fire', id: 'MODIS_Terra_Land_Surface_Temp_Day', label: 'Land heat', hint: 'Daytime surface temperature' },
  { group: 'Land & fire', id: 'MODIS_Terra_NDVI_8Day', label: 'Vegetation health', hint: 'Greenness index' },
  { group: 'Land & fire', id: 'MODIS_Terra_NDSI_Snow_Cover', label: 'Snow cover', hint: 'Snow extent' },
  { group: 'Land & fire', id: 'ASTER_GDEM_Color_Index', label: 'Elevation colours', hint: 'Colour-coded terrain height' },
  { group: 'Ocean & ice', id: 'GHRSST_L4_MUR_Sea_Surface_Temperature', label: 'Ocean temperature', hint: 'Sea surface temperature' },
  { group: 'Ocean & ice', id: 'MODIS_Aqua_Chlorophyll_A', label: 'Ocean life', hint: 'Chlorophyll (plankton)' },
  { group: 'Ocean & ice', id: 'AMSR2_Sea_Ice_Concentration_12km', label: 'Sea ice', hint: 'Polar ice concentration' },
  { group: 'Ocean & ice', id: 'AVISO_Absolute_Dynamic_Topography', label: 'Sea level', hint: 'Sea surface height, currents' },
  { group: 'Air & climate', id: 'MODIS_Combined_Value_Added_AOD', label: 'Smoke & dust', hint: 'Aerosol optical depth' },
  { group: 'Air & climate', id: 'MERRA2_2m_Air_Temperature_Monthly', label: 'Air temperature', hint: 'Monthly climate reanalysis' },
  { group: 'Night & people', id: 'VIIRS_Black_Marble', label: 'Earth at night', hint: 'City lights' },
  { group: 'Night & people', id: 'VIIRS_SNPP_DayNightBand_ENCC', label: 'Night clouds & moonlight', hint: 'Low-light imagery' },
  { group: 'Night & people', id: 'GPW_Population_Density_2020', label: 'Population', hint: 'People per km²' },
];

export function featuredLayers(catalog, featured = GAIA_FEATURED) {
  const byId = new Map((catalog ?? []).map(layer => [layer.id, layer]));
  return featured.filter(f => byId.has(f.id)).map(f => ({ ...f, layer: byId.get(f.id) }));
}

// How often new observations appear (the layer's own time step), e.g. "Every 10 min".
export function cadenceLabel(periods) {
  const p = periods?.at(-1);
  if (!p) return 'Static';
  if (p.months) {
    if (p.months === 1) return 'Monthly';
    if (p.months === 12) return 'Yearly';
    return `Every ${p.months} months`;
  }
  const minutes = Math.round(p.ms / 60000);
  if (minutes < 60) return `Every ${minutes} min`;
  if (minutes < 1440) return `Every ${+(minutes / 60).toFixed(1)} h`;
  const days = Math.round(minutes / 1440);
  if (days === 1) return 'Daily';
  if (days === 7) return 'Weekly';
  return `Every ${days} days`;
}

// "Global" or "Regional", from the layer's declared bounding box, with known
// geostationary satellites named explicitly because they only see one disc.
export function coverageLabel(layer) {
  if (/^GOES-East/i.test(layer.id)) return 'Regional · Americas';
  if (/^GOES-West/i.test(layer.id)) return 'Regional · Pacific';
  if (/^Himawari/i.test(layer.id)) return 'Regional · Asia–Pacific';
  const b = layer.bbox;
  if (!b) return 'Coverage unknown';
  return b.east - b.west >= 350 && b.north - b.south >= 140 ? 'Global' : 'Regional';
}

export const layerMeta = layer => `${cadenceLabel(layer.periods)} · ${coverageLabel(layer)}`;
