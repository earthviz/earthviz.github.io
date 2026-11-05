export const USNO_ONE_DAY = 'https://aa.usno.navy.mil/api/rstt/oneday';

export function usnoOneDayUrl(date, latitude, longitude) {
  const url = new URL(USNO_ONE_DAY);
  url.searchParams.set('date', date);
  url.searchParams.set('coords', `${latitude.toFixed(4)},${longitude.toFixed(4)}`);
  url.searchParams.set('tz', '0');
  url.searchParams.set('ID', 'Earthviz');
  return url.toString();
}

export function phenomenaByName(entries = []) {
  return Object.fromEntries(entries
    .filter(entry => entry?.phen)
    .map(entry => [entry.phen, entry.time || null]));
}

export function timeToMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(value || '')) return null;
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function daylightState(sun, minute) {
  const rise = timeToMinutes(sun.Rise);
  const set = timeToMinutes(sun.Set);
  const dawn = timeToMinutes(sun['Begin Civil Twilight']);
  const dusk = timeToMinutes(sun['End Civil Twilight']);
  const contains = (start, end) => start === null || end === null
    ? false
    : (start <= end ? minute >= start && minute < end : minute >= start || minute < end);
  if (contains(rise, set)) return 'Daylight';
  if (contains(dawn, rise)) return 'Morning twilight';
  if (contains(set, dusk)) return 'Evening twilight';
  return 'Night';
}

export function nextPhenomenon(sun, minute) {
  const names = ['Begin Civil Twilight', 'Rise', 'Upper Transit', 'Set', 'End Civil Twilight'];
  let next = null;
  for (const name of names) {
    const eventMinute = timeToMinutes(sun[name]);
    if (eventMinute === null) continue;
    const delta = (eventMinute - minute + 1440) % 1440;
    if (!next || delta < next.delta) next = { name, time: sun[name], delta };
  }
  return next;
}
