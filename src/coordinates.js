// Parses coordinate strings typed into the search box.
// Supported: decimal degrees ("27.9881, 86.925", "27.9881 86.925", "(27.99;86.92)"),
// hemisphere letters ("27.9881 N, 86.925 E", "N27.9881 E86.925", "86.925E 27.9881N"),
// and degrees/minutes/seconds ("27°59'17\"N 86°55'30\"E", "27 59 17 N, 86 55 30 E").
// Returns { lat, lng } on success, { error } for coordinate-shaped but invalid input, else null.

const NUM = '\\d+(?:\\.\\d+)?';
const COMPONENT = new RegExp(
  `^([nsew])?\\s*([+-])?\\s*(${NUM})\\s*[°º˚]?\\s*(?:(${NUM})\\s*'?\\s*)?(?:(${NUM})\\s*"?\\s*)?([nsew])?$`,
  'i',
);
const DECIMAL_PAIR = new RegExp(`^([+-]?${NUM})\\s+([+-]?${NUM})$`);

function normalize(text) {
  return text
    .replace(/[−–—]/g, '-')
    .replace(/[′’‘]/g, "'")
    .replace(/[″”“]|''/g, '"')
    .replace(/[()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseComponent(text) {
  const match = text.trim().match(COMPONENT);
  if (!match) return null;
  const [, prefix, sign, deg, min, sec, suffix] = match;
  if (prefix && suffix) return null;
  if (min !== undefined && +min >= 60) return null;
  if (sec !== undefined && +sec >= 60) return null;
  const hemi = (prefix || suffix || '').toUpperCase();
  let value = +deg + (min ? +min / 60 : 0) + (sec ? +sec / 3600 : 0);
  if (sign === '-' || hemi === 'S' || hemi === 'W') value = -value;
  return { value, hemi };
}

function splitPair(text) {
  if (/[,;]/.test(text)) {
    const parts = text.split(/\s*[,;]\s*/).filter(Boolean);
    return parts.length === 2 ? parts : null;
  }
  if (/[nsew]/i.test(text)) {
    // "N27.9 E86.9" (letter first) splits before the second letter; "27.9N 86.9E" splits after the first.
    const parts = /^[nsew]/i.test(text)
      ? text.match(/^([nsew][^nsew]*)([nsew][^nsew]*)$/i)
      : text.match(/^([^nsew]*[nsew])([^nsew]*[nsew]?)$/i);
    return parts ? [parts[1], parts[2]] : null;
  }
  const pair = text.match(DECIMAL_PAIR);
  return pair ? [pair[1], pair[2]] : null;
}

export function parseCoordinates(input) {
  const text = normalize(String(input ?? ''));
  if (!text || !/\d/.test(text)) return null;
  const parts = splitPair(text);
  if (!parts) return null;
  const first = parseComponent(parts[0]);
  const second = parseComponent(parts[1]);
  if (!first || !second) return null;

  const axis = hemi => (hemi === 'N' || hemi === 'S' ? 'lat' : hemi === 'E' || hemi === 'W' ? 'lng' : null);
  let lat;
  let lng;
  const a = axis(first.hemi);
  const b = axis(second.hemi);
  if (a && b) {
    if (a === b) return null;
    [lat, lng] = a === 'lat' ? [first.value, second.value] : [second.value, first.value];
  } else if (a || b) {
    // Only one hemisphere letter given: it fixes its own axis, the other component takes the remaining one.
    const firstIsLat = a ? a === 'lat' : b === 'lng';
    [lat, lng] = firstIsLat ? [first.value, second.value] : [second.value, first.value];
  } else if (Math.abs(first.value) > 90 && Math.abs(second.value) <= 90) {
    // "86.925, 27.9881" can only be lng, lat.
    [lat, lng] = [second.value, first.value];
  } else {
    [lat, lng] = [first.value, second.value];
  }

  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { error: 'Latitude must be within ±90° and longitude within ±180°.' };
  }
  return { lat, lng };
}

export function formatCoordinates(lat, lng) {
  const part = (value, pos, neg) => `${Math.abs(value).toFixed(4)}° ${value < 0 ? neg : pos}`;
  return `${part(lat, 'N', 'S')}, ${part(lng, 'E', 'W')}`;
}
