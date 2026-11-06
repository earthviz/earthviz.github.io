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

Cesium's `Globe` now owns the screen-space quadtree, horizon/frustum culling,
request scheduling, parent fallback, tile cache, mesh generation, edge skirts,
and imagery reprojection. The Terrain detail slider maps directly to Cesium's
maximum screen-space error, while the cache retains up to 320 tiles for quick
zoom-out and revisits.

Earthviz still owns the elevation data. Its terrain provider decodes each 256 px
Mapzen Terrarium RGB tile into a 33×33 height grid in meters and a water mask, then
hands that data to Cesium as `HeightmapTerrainData`. Coastline classification
scans every source pixel so sparse mesh samples do not erase small islands;
tiles known to be entirely ocean stop requesting descendants from level 5.
Terrain and provider imagery are capped at their real native levels, and Cesium
stretches the best available parent image across finer terrain without visible
tile gaps. Web Mercator data ends near ±85°.

The production bundle imports the headless `@cesium/engine` widget and the core
math types instead of Cesium Viewer or its UI packages. Deployment copies only
the heightmap/picking workers and sky, celestial, water, and attribution assets
used by Earthviz; the 3D Tiles, generic geometry, Draco, KTX, and archive worker
or codec assets are not shipped.

Run `npm test` for queue and detail-policy regression tests, and `npm run build`
for production validation. In development, open `/?debug` and call
`earthvizStats()` in the browser console to inspect pending tiles, screen-space
error, cache size, imagery mode, camera state, and frame progress. Check repeated
zoom-in/out, panning during loads, switching imagery, coastlines, and mountain
views. Imagery quality remains limited by the selected provider's available
resolution.

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

Cesium renders the Sun, Moon, and starry sky from the same selected UTC clock
used by Earthviz's local astronomy. The BSC5 catalogue remains an Earthviz point
layer, with its proper-motion/precession and local-horizon calculations under
application control.

### Atmospheric sky

Cesium's globe atmosphere and dynamic Sun lighting now draw the sky and terrain.
Earthviz retains its local astronomical model for the twilight timeline,
near-horizon refraction, observer-height horizon dip, and daylight override.
The Lighting panel reports the current local solar altitude, phase, and horizon
dip without taking mesh or imagery control back from Cesium.

## Exploring the map

The full-width search opens suggested destinations on focus and offers city
suggestions as you type. Press **Explore** for a broader place/landmark search,
or enter `latitude, longitude`. Use **↑ / ↓** and **Enter** to choose a suggestion,
**Escape** to dismiss it, and **Ctrl/Cmd + K** to focus search.

Map and terrain settings live at the upper left; lighting controls live at the
upper right. Left-drag pans the globe, right-drag orbits around the picked
surface, middle-drag or Shift-drag free-looks, and the wheel zooms. WASD moves
the camera, Q/E moves vertically, arrow keys look, and Shift accelerates held
keys. The lower-right buttons zoom, face north, or return to the initial globe
view. Location and loading status appear at the lower left. On narrow screens,
only one settings panel opens at a time. Credits and interaction tips are
available in the footer. Source imagery is draped directly; Cesium's reflective
water material is disabled.
# earthviz
