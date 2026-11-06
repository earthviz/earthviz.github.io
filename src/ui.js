const $ = id => document.getElementById(id);
const destinations = [
  { name: 'Mount Everest, Himalayas', lat: 27.9881, lng: 86.925 },
  { name: 'Grand Canyon, Arizona, United States', lat: 36.1069, lng: -112.1129 },
  { name: 'Reykjavík, Iceland', lat: 64.1466, lng: -21.9426 },
  { name: 'Mount Fuji, Japan', lat: 35.3606, lng: 138.7274 },
  { name: 'Cape Town, South Africa', lat: -33.9249, lng: 18.4241 },
];

export function setupUI({ search, flyTo, zoom, home, north }) {
  let results = [];
  let selected = -1;
  let revision = 0;
  let timer;
  let controller;
  const input = $('q');
  const box = $('suggestions');
  const list = $('hits');
  function stop() {
    revision++;
    clearTimeout(timer);
    controller?.abort();
    $('sb').disabled = false;
    input.removeAttribute('aria-busy');
  }
  function close() {
    stop();
    box.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    selected = -1;
  }
  function choose(hit) {
    close();
    input.value = hit.name;
    $('clear-search').hidden = false;
    flyTo(hit);
    input.blur();
  }
  function highlight(index) {
    selected = index;
    [...list.children].forEach((el, i) => el.setAttribute('aria-selected', String(i === selected)));
    if (selected >= 0) {
      input.setAttribute('aria-activedescendant', `place-option-${selected}`);
      list.children[selected]?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function show(hits, message) {
    results = hits;
    selected = -1;
    input.removeAttribute('aria-activedescendant');
    $('search-message').textContent = message;
    list.replaceChildren(...hits.map((hit, i) => {
      const row = document.createElement('div');
      row.className = 'suggestion';
      row.id = `place-option-${i}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      const icon = document.createElement('span');
      icon.className = 'suggestion-icon';
      icon.textContent = '⌖';
      icon.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span');
      copy.className = 'suggestion-copy';
      const title = document.createElement('strong');
      const subtitle = document.createElement('small');
      const [name, ...rest] = hit.name.split(',');
      title.textContent = name;
      subtitle.textContent = rest.join(',').trim() || `${hit.lat.toFixed(3)}°, ${hit.lng.toFixed(3)}°`;
      copy.append(title, subtitle);
      const arrow = document.createElement('span');
      arrow.className = 'suggestion-arrow';
      arrow.textContent = '↗';
      arrow.setAttribute('aria-hidden', 'true');
      row.append(icon, copy, arrow);
      row.onmousedown = event => event.preventDefault();
      row.onclick = () => choose(hit);
      return row;
    }));
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  function coordinates(query) {
    const match = query.match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
    return match && Math.abs(+match[1]) <= 90 && Math.abs(+match[2]) <= 180
      ? { name: query, lat: +match[1], lng: +match[2] } : null;
  }
  async function suggest(query, current) {
    controller = new AbortController();
    const requestController = controller;
    const timeout = setTimeout(() => requestController.abort(), 8000);
    input.setAttribute('aria-busy', 'true');
    try {
      // Nominatim is only used for explicit submissions, never autocomplete.
      const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&format=json&name=${encodeURIComponent(query)}`, { signal: requestController.signal });
      if (!response.ok) throw new Error('Search unavailable');
      const data = await response.json();
      if (current !== revision) return;
      const hits = (data.results || []).map(hit => ({
        name: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', '),
        lat: hit.latitude, lng: hit.longitude,
      }));
      const local = destinations.filter(hit => hit.name.toLowerCase().includes(query.toLowerCase()));
      const all = [...local, ...hits].slice(0, 6);
      show(all, all.length ? 'Places to explore' : 'No suggestions. Press Explore to search landmarks.');
    } catch {
      if (current === revision) show(destinations.filter(hit => hit.name.toLowerCase().includes(query.toLowerCase())), 'Suggestions unavailable. Press Explore to search.');
    } finally {
      clearTimeout(timeout);
      if (current === revision) input.removeAttribute('aria-busy');
    }
  }
  function onInput() {
    stop();
    const query = input.value.trim();
    $('clear-search').hidden = !query;
    const coordinate = coordinates(query);
    if (coordinate) { show([coordinate], 'Jump to coordinates'); return; }
    if (query.length < 3) { show(destinations.filter(hit => hit.name.toLowerCase().includes(query.toLowerCase())), query ? 'Keep typing to search places' : 'A little inspiration'); return; }
    show(destinations.filter(hit => hit.name.toLowerCase().includes(query.toLowerCase())), 'Finding places…');
    const current = revision;
    timer = setTimeout(() => suggest(query, current), 450);
  }
  input.addEventListener('input', event => { if (!event.isComposing) onInput(); });
  input.addEventListener('compositionend', onInput);
  input.addEventListener('focus', onInput);
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      if (box.hidden) onInput();
      if (results.length) highlight((selected + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
    }
    if (event.key === 'Enter' && selected >= 0 && !box.hidden) {
      event.preventDefault(); choose(results[selected]);
    }
  });
  $('sf').onsubmit = async event => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) { input.focus(); onInput(); return; }
    const coordinate = coordinates(query);
    if (coordinate) { choose(coordinate); return; }
    stop();
    const current = revision;
    show([], 'Searching places and landmarks…');
    $('sb').disabled = true;
    input.setAttribute('aria-busy', 'true');
    try {
      const hits = await search(query);
      if (current !== revision) return;
      show(hits, hits.length ? 'Choose a place to explore' : 'No places found. Try a nearby city or coordinates.');
    } catch {
      if (current === revision) show([], 'Search unavailable. Please try again.');
    } finally {
      if (current === revision) { $('sb').disabled = false; input.removeAttribute('aria-busy'); }
    }
  };
  $('clear-search').onclick = () => { input.value = ''; input.focus(); onInput(); };
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.search-shell')) close(); });
  document.addEventListener('focusin', event => { if (!event.target.closest('.search-shell')) close(); });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); input.focus(); input.select(); }
    if (event.key === 'Escape') {
      close();
      document.querySelectorAll('details[open]').forEach(el => { el.open = false; });
    }
  });
  $('zoom-in').onclick = () => zoom(0.7);
  $('zoom-out').onclick = () => zoom(1 / 0.7);
  $('home').onclick = () => { close(); home(); };
  $('north').onclick = north;
  const toggleUi = () => {
    const minimal = document.body.classList.toggle('ui-minimal');
    $('ui-toggle').setAttribute('aria-pressed', String(minimal));
    $('ui-toggle').textContent = minimal ? 'Show UI' : 'Focus';
    $('ui-toggle').title = minimal ? 'Show interface' : 'Focus on the world';
  };
  $('ui-toggle').onclick = toggleUi;
  const labels = ['Minimal', 'Light', 'Moderate', 'Balanced', 'High', 'Maximum'];
  $('det').addEventListener('input', () => { $('detail-value').textContent = labels[+$('det').value - 1]; });
  $('terrain-zoom').addEventListener('input', () => { $('terrain-zoom-value').textContent = `z${$('terrain-zoom').value}`; });
  $('ex').addEventListener('input', () => { $('ex-value').textContent = `${(+$('ex').value).toFixed(1)}×`; });
}
