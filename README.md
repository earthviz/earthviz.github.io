# Earthviz

An interactive 3D terrain globe with satellite imagery, elevation, sun controls, place search, and a time-aware NASA imagery mode.

## Run locally

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite. The production build is created with `npm run build` and can be previewed with `npm run preview`.

## Data sources

- Elevation: Mapzen Terrarium tiles hosted by AWS
- Imagery: Sentinel-2 cloudless by EOX, Esri World Imagery, or daily MODIS Terra true color from NASA EOSDIS GIBS
- Stars: Yale Bright Star Catalogue, 5th edition (`bsc5.json`)
- Sun and Moon daily events: U.S. Naval Observatory Astronomical Applications API, with an offline solar fallback
- Search: OpenStreetMap Nominatim, with Open-Meteo geocoding as a fallback

## Progressive detail

The globe uses a screen-space quadtree with hysteresis: imagery refines when
its projected size grows, while terrain grids independently range from 4×4 to
32×32 cells according to visible relief. Coarse DEM tiles classify land and
water; tiles classified as ocean stop refining at level 5 or deeper. Coastline classification scans every
DEM pixel, but islands smaller than the source data resolution may still be
missed. Unknown areas remain eligible for refinement.

Beyond the coarse classification levels, elevation requests wait until estimated
unresolved relief exceeds two pixels or the viewing range drops below 80 km.
Until then, children interpolate their parent's elevation. This is a heuristic,
not a guarantee of subpixel terrain accuracy. Parent imagery remains visible
until all visible children are ready; failed imagery retries after 15 seconds.

Refinement spends its budget on the largest projected detail gaps across the
whole view, rather than finishing one branch first. Only visible children count
against that budget, including children still loading. Loaded terrain uses its
actual height bounds for visibility instead of a fixed mountain-sized margin.

Work is bounded to 120 selected leaves, 320 cached tiles, 64 queued tiles and six
concurrent tile loads. Completed tiles are built one per animation frame;
geometry changes also rebuild at most one visible mesh per frame. Stale loads
are canceled, unused tiles are evicted, and zooming out immediately reuses
cached parents. Provider failures keep coarser imagery visible. Web Mercator
imagery ends at ±85°; polar caps remain a simple globe surface.

Run `npm test` for queue and detail-policy regression tests, and `npm run build`
for production validation. In development, open `/?debug` and call
`earthvizStats()` in the browser console to inspect tile budgets, mesh density,
and frame progress. Check repeated zoom-in/out, panning during loads, switching
imagery, coastlines, and mountain views. Imagery quality remains limited by the
selected provider's available resolution.

## Spacetime

Choose **Spacetime** in the header to browse daily NASA GIBS imagery from the
MODIS Terra record. Choose and explicitly load one date at a time; there is no
automatic playback. Native-resolution MODIS is used for global and regional
views. Local views switch to NASA's 30 m HLS Landsat-8/9 and Sentinel-2
reflectance layers through zoom 12; deeper terrain tiles crop their matching
maximum-resolution HLS parent. Only imagery acquired on the selected date is
shown, at every scale: empty MODIS orbital swaths and transparent HLS coverage
remain black, and neighbouring dates and Explore imagery are never blended in.
Changing dates does not discard elevation samples or rebuild terrain geometry;
terrain refinement remains identical to Explore.

Spacetime lighting follows the selected imagery date. The UTC time slider moves
through that date's night, civil twilight, sunrise, daylight, sunset, and evening
twilight using the Sun's astronomical position at the current coordinates.

## Stargazing

Choose **Stargaze** to stand at the selected latitude and longitude and look
around the local sky. The viewer renders all 9,096 BSC5 entries at their catalog
visual magnitudes and B−V/temperature colors. J2000 coordinates are advanced to
the observing date with catalog proper motions and precession, then rotated by
Greenwich mean sidereal time so the local horizon changes correctly with UTC,
latitude, and longitude. Choose an observing date and UTC time under **Lighting**,
or press **Now**. Drag or use the arrow keys to look around, scroll to change the
field of view, and click a star to see its name, HR number, magnitude, spectral
class, current altitude, and azimuth.

The **Lighting** panel shows the current location's USNO sunrise, sunset, civil
twilight, solar transit, Moon rise/set, phase, and illumination in UTC. Its daily
timeline handles locations whose daylight interval crosses UTC midnight. Sunrise
and sunset buttons jump directly to those events. In **Explore**, enable **Keep
terrain in daylight** to place clear daylight over the current view without
changing the selected astronomical date or time; Spacetime always uses its real
date and lighting flow.

The Sun and Moon are rendered as distant spheres at their physical apparent
angular diameters. Solar size follows Earth–Sun distance; lunar size follows the
topocentric camera–Moon distance, including observer parallax. The Moon shader is
illuminated from the astronomical Sun direction, so its visible terminator and
phase evolve continuously with the selected UTC date and time.

## Exploring the map

The full-width search opens suggested destinations on focus and offers city
suggestions as you type. Press **Explore** for a broader place/landmark search,
or enter `latitude, longitude`. Use **↑ / ↓** and **Enter** to choose a suggestion,
**Escape** to dismiss it, and **Ctrl/Cmd + K** to focus search.

Map and terrain settings live at the upper left; lighting controls live at the
upper right. The lower-right buttons zoom, face north, or return to the initial
globe view. Location and loading status appear at the lower left. On narrow
screens, only one settings panel opens at a time. Credits and interaction tips
are available in the footer.
# earthviz