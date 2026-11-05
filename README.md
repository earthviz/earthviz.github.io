# Earthviz

An interactive 3D terrain globe with satellite imagery, elevation, sun controls, and place search.

## Run locally

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite. The production build is created with `npm run build` and can be previewed with `npm run preview`.

## Data sources

- Elevation: Mapzen Terrarium tiles hosted by AWS
- Imagery: Sentinel-2 cloudless by EOX or Esri World Imagery
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
