export const TILE_PRIORITY = Object.freeze({
  VIEW_CENTER: 'view-center',
  NEAREST: 'nearest',
  ADAPTIVE: 'adaptive',
});

export function usesNearestPriority(mode, adaptiveNearest = false) {
  return mode === TILE_PRIORITY.NEAREST
    || (mode === TILE_PRIORITY.ADAPTIVE && adaptiveNearest);
}

export function chooseTileLoadPriority({ mode, adaptiveNearest, centerPriority, distance }) {
  return usesNearestPriority(mode, adaptiveNearest) && Number.isFinite(distance)
    ? distance
    : centerPriority;
}

// Cesium does not expose its globe tile-load comparator as public API. Keep
// this small adapter isolated so an engine upgrade has one compatibility
// point, and fall back harmlessly if its internal surface changes.
export function installGlobeTilePriority(globe, getPolicy) {
  const tileProvider = globe?._surface?.tileProvider;
  if (!tileProvider?.computeTileLoadPriority) return false;

  const centerPriority = tileProvider.computeTileLoadPriority.bind(tileProvider);
  tileProvider.computeTileLoadPriority = (tile, frameState) => {
    const policy = getPolicy();
    return chooseTileLoadPriority({
      ...policy,
      centerPriority: centerPriority(tile, frameState),
      distance: tile._distance,
    });
  };
  return true;
}
