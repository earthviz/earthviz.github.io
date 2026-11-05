// Pure selection/scheduling policies, shared with the regression tests.
// Coarse spherical triangles bow inward between their vertices. Allow for
// their chord depth (~16 km) plus exaggerated bathymetry (12 km × 6).
// This is a hidden loading fallback, not the visible surface of loaded tiles.
export const FALLBACK_INSET_KM = 100;

export const LIMITS = { tiles: 320, leaves: 120, queued: 64, concurrent: 6 };

export function takeNext(queue, isCurrent, priority) {
  // Prune first: mutating the array during index selection can invalidate the
  // winning index and make a caller's draining loop run forever.
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (!isCurrent(queue[i])) {
      queue[i].queued = false;
      queue.splice(i, 1);
    }
  }
  if (!queue.length) return null;
  let best = 0;
  for (let i = 1; i < queue.length; i += 1) {
    if (priority(queue[i]) < priority(queue[best])) best = i;
  }
  const [next] = queue.splice(best, 1);
  next.queued = false;
  return next;
}

export function terrainSegments(z, reliefPixels) {
  // Curvature needs a grid at global scale; local relief only needs a dense
  // mesh once it occupies several screen pixels.
  const curvature = Math.max(4, 32 >> Math.min(z - 1, 3));
  return Math.max(curvature, reliefPixels > 24 ? 32 : reliefPixels > 6 ? 16 : reliefPixels > 2 ? 8 : 4);
}

export function shouldRefine({ z, land, pixels, threshold, wasSplit, maxZoom }) {
  if (z >= maxZoom || (land === false && z >= 5)) return false;
  return pixels > threshold * (wasSplit ? 0.8 : 1.15);
}

// Spend the leaf budget on the largest remaining screen error across the
// whole view. Depth-first traversal can exhaust it on one half of the screen.
export function selectFrontier({ roots, inView, request, score, children, maxLeaves = LIMITS.leaves }) {
  const frontier = new Set();
  const candidates = [];
  const add = tile => {
    request(tile);
    frontier.add(tile);
    const priority = score(tile);
    if (priority > 0) candidates.push({ tile, priority });
  };
  roots.forEach(tile => { request(tile); if (inView(tile)) add(tile); });
  let plannedLeaves = frontier.size;
  let steps = 0;
  while (candidates.length && steps++ < maxLeaves * 8) {
    candidates.sort((a, b) => b.priority - a.priority);
    const { tile } = candidates.shift();
    const next = children(tile)?.filter(inView);
    if (!next?.length || plannedLeaves + next.length - 1 > maxLeaves) continue;
    // Reserve capacity for in-flight siblings as well, so queued refinements
    // cannot fill the cache with more leaves than we can ever display.
    plannedLeaves += next.length - 1;
    next.forEach(request);
    // Keep complete parent coverage while a sibling is still loading.
    if (!next.every(child => child.ready)) continue;
    frontier.delete(tile);
    next.forEach(add);
  }
  return [...frontier].filter(tile => tile.ready);
}
