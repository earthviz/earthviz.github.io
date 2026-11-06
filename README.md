# Earthviz

An interactive 3D terrain globe with satellite imagery, elevation, optional 3D buildings and roads, sun controls, place search, a time-aware NASA imagery mode, and a stargazing view.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL Vite prints (the app is served from `/`). `npm run build` creates the production bundle in `dist/`; `npm run preview` serves it.

Pushes to `master` deploy to GitHub Pages through `.github/workflows/deploy.yml`.

## Modes

- **Explore**: terrain globe with Sentinel-2 cloudless (EOX) or Esri World Imagery.
- **Spacetime**: daily NASA GIBS imagery, one explicitly loaded date at a time.
- **Stargaze**: look at the local night sky from the selected latitude and longitude.

### Controls

The full-width search opens suggested destinations on focus and offers city suggestions as you type. Press **Explore** for a broader place/landmark search, or enter `latitude, longitude`. Use **↑ / ↓** and **Enter** to choose a suggestion, **Escape** to dismiss it, and **Ctrl/Cmd + K** to focus search.

Left-drag pans, right-drag orbits around the picked surface, middle-drag or Shift-drag free-looks, and the wheel zooms. WASD moves the camera, Q/E moves vertically, arrow keys look, and Shift accelerates held keys. The lower-right buttons zoom, face north, or return to the initial view.

Map and terrain settings are at the upper left; lighting controls at the upper right. Location and loading status appear at the lower left. On narrow screens only one settings panel opens at a time. Credits and tips are in the footer.

## 3D buildings and roads

Under **Map & terrain**, **3D buildings** and **Roads** are separate switches. Both read OpenFreeMap vector tiles (OpenMapTiles schema, zoom 14) and are off by default.

| Layer | Appears below | Tile window | Cap per tile |
| --- | --- | --- | --- |
| Buildings | 8 km altitude | 3×3 around the view | 700, largest footprints first |
| Roads | 25 km altitude | 5×5 around the view | 500, most important classes first |

Roads are drawn for motorway, trunk, primary, secondary, tertiary, minor and street classes; service roads are skipped. Footprints under roughly 10 m² are dropped.

The two layers have independent queues, so roads keep loading while buildings are still building. Each tile is fetched and decoded once and shared by both layers (the 8 most recent decoded tiles stay cached). Everything after the fetch is time-sliced to a few milliseconds per slice, each layer builds one tile at a time, and at most one new primitive is added per frame, so loading does not freeze the screen. Buildings sit on terrain sampled at each footprint's centre and are rebuilt when the elevation scale or terrain source changes; roads are ground-clamped and are not. Buildings are drawn opaque; set `BUILDING_TRANSLUCENT` in `src/cesium/openfreemap-overlay.js` to bring back the translucent look.

Both layers are hidden while stargazing.

## Terrain and imagery

Cesium's `Globe` owns the screen-space quadtree, culling, request scheduling, parent fallback, tile cache, mesh generation, skirts, and imagery reprojection. The **Terrain detail** slider maps to Cesium's maximum screen-space error, and the cache holds up to 320 tiles.

Earthviz supplies the elevation data. Its terrain provider decodes each 256 px Mapzen Terrarium RGB tile into a 33×33 height grid in meters plus a water mask and hands it to Cesium as `HeightmapTerrainData`. Coastline classification scans every source pixel so sparse mesh samples do not erase small islands, and tiles known to be entirely ocean stop requesting descendants from level 5. Terrain and imagery are capped at their native levels; Cesium stretches the best available parent image across finer terrain. Web Mercator data ends near ±85°.

Source imagery is draped directly and Cesium's reflective water material is disabled. Imagery sharpness is limited by the selected provider.

### Spacetime

Choose **Spacetime** to browse daily MODIS Terra imagery from NASA GIBS. There is no automatic playback. MODIS is used for global and regional views; local views switch to NASA's 30 m HLS Landsat-8/9 and Sentinel-2 layers through zoom 12, and deeper terrain tiles crop their matching HLS parent. Only imagery acquired on the selected date is shown: empty MODIS swaths and transparent HLS coverage stay black, and neighbouring dates or Explore imagery are never blended in. Changing dates keeps elevation samples and terrain geometry.

Lighting follows the selected imagery date. The UTC time slider moves through that date's night, civil twilight, sunrise, daylight, sunset, and evening twilight using the Sun's position at the current coordinates.

### Stargazing

**Stargaze** renders all 9,096 BSC5 entries at their catalog visual magnitudes and B−V/temperature colors. J2000 coordinates are advanced to the observing date using catalog proper motions and precession, then rotated by Greenwich mean sidereal time so the horizon changes correctly with UTC, latitude, and longitude. Set the date and UTC time under **Lighting**, or press **Now**. Drag or use the arrow keys to look around, scroll to change the field of view, and click a star for its name, HR number, magnitude, spectral class, altitude, and azimuth.

### Lighting

The **Lighting** panel shows the location's sunrise, sunset, civil twilight, solar transit, Moon rise/set, phase, and illumination in UTC, with a daily timeline that handles daylight crossing UTC midnight. Sunrise and sunset buttons jump to those events. In **Explore**, **Keep terrain in daylight** places clear daylight over the current view without changing the selected date or time; Spacetime always uses its real date and lighting.

Cesium draws the Sun, Moon, starry sky, atmosphere, and dynamic Sun lighting from the same UTC clock. Earthviz keeps its own astronomy for the twilight timeline, near-horizon refraction, observer-height horizon dip, daylight override, and the BSC5 star layer. The panel reports the local solar altitude, phase, and horizon dip.

## Data sources

- Elevation: Mapzen Terrarium tiles hosted by AWS
- Imagery: Sentinel-2 cloudless by EOX, Esri World Imagery, or daily MODIS Terra and HLS from NASA EOSDIS GIBS
- Buildings and roads: OpenFreeMap vector tiles, © OpenMapTiles, data © OpenStreetMap contributors
- Stars: Yale Bright Star Catalogue, 5th edition (`bsc5.json`)
- Sun and Moon daily events: U.S. Naval Observatory Astronomical Applications API, with an offline solar fallback
- Search: OpenStreetMap Nominatim, with Open-Meteo geocoding as a fallback

## Bundle

The app imports the headless `@cesium/engine` widget and the core math types rather than the Cesium Viewer or its UI packages. The build copies only the workers and assets Earthviz uses: heightmap and terrain-picking workers, the geometry, polygon, and ground-polyline workers used by buildings and roads, and the sky, celestial, and attribution assets. 3D Tiles, Draco, KTX, and archive workers and codecs are not shipped.

## Tests and debugging

```bash
npm test
```

Covers astronomy, spacetime, terrain decoding, LOD policy, overlay tile selection and ranking, and the time-slicing helper. `npm run build` validates the production bundle.

In development, open `/?debug` and call `earthvizStats()` in the console for pending tiles, screen-space error, cache size, imagery mode, camera state, frame progress, and per-layer building and road stats. Worth checking by hand: repeated zoom in/out, panning during loads, switching imagery, coastlines, mountain views, and toggling buildings and roads at a dense city.
