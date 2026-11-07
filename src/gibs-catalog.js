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
    layers.push({
      id, format, tileMatrixSet: tms,
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
