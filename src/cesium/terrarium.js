export const TERRARIUM_TILE_SIZE = 256;

// Terrarium-encoded elevation tile sources. `nativeMaximumLevel` is the deepest
// zoom requested from the server; deeper levels are oversampled from an ancestor
// tile. `guaranteedLevel` is the deepest zoom that exists everywhere: tiles
// between it and `nativeMaximumLevel` may 404 and fall back to a parent.
export const TERRAIN_SOURCES = {
  aws: {
    label: 'Mapzen Terrarium (AWS) · static ~2016',
    url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    nativeMaximumLevel: 15,
    guaranteedLevel: 15,
    credit: 'Heights: Mapzen Terrarium (AWS)',
  },
  mapterhorn: {
    label: 'Mapterhorn · maintained',
    url: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
    // Global z0-z12 (Copernicus GLO-30); regional z13-z17 only where published.
    nativeMaximumLevel: 17,
    guaranteedLevel: 12,
    credit: 'Heights: © Mapterhorn',
    creditUrl: 'https://mapterhorn.com/attribution',
  },
};
export const DEFAULT_TERRAIN_SOURCE = 'aws';
export const TERRAIN_GRID_SIZE = 33;

export function decodeTerrariumHeight(red, green, blue) {
  return red * 256 + green + blue / 256 - 32768;
}

function heightAt(pixels, width, x, y) {
  const index = 4 * (y * width + x);
  return decodeTerrariumHeight(pixels[index], pixels[index + 1], pixels[index + 2]);
}

export function sampleTerrarium(pixels, width, height, options = {}) {
  const gridSize = options.gridSize ?? TERRAIN_GRID_SIZE;
  const flattenSea = options.flattenSea ?? true;
  const heights = new Float32Array(gridSize * gridSize);
  const waterMask = new Uint8Array(gridSize * gridSize);
  // Optional sub-window of the tile, as fractions in [0, 1], for oversampling.
  const region = options.region ?? { x: 0, y: 0, size: 1 };
  let minimumHeight = Infinity;
  let maximumHeight = -Infinity;
  let allWater = true;

  // Classification uses every source pixel so islands do not disappear merely
  // because the rendered height grid is intentionally sparse.
  const x0 = Math.floor(region.x * width);
  const x1 = Math.min(width, Math.ceil((region.x + region.size) * width));
  const y0 = Math.floor(region.y * height);
  const y1 = Math.min(height, Math.ceil((region.y + region.size) * height));
  for (let y = y0; y < y1 && allWater; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = 4 * (y * width + x);
      if (decodeTerrariumHeight(pixels[i], pixels[i + 1], pixels[i + 2]) >= 0) {
        allWater = false;
        break;
      }
    }
  }

  for (let row = 0; row < gridSize; row += 1) {
    const py = (region.y + row / (gridSize - 1) * region.size) * (height - 1);
    const iy0 = Math.floor(py);
    const iy1 = Math.min(height - 1, iy0 + 1);
    const fy = py - iy0;
    for (let column = 0; column < gridSize; column += 1) {
      const px = (region.x + column / (gridSize - 1) * region.size) * (width - 1);
      const ix0 = Math.floor(px);
      const ix1 = Math.min(width - 1, ix0 + 1);
      const fx = px - ix0;
      const north = heightAt(pixels, width, ix0, iy0) * (1 - fx)
        + heightAt(pixels, width, ix1, iy0) * fx;
      const south = heightAt(pixels, width, ix0, iy1) * (1 - fx)
        + heightAt(pixels, width, ix1, iy1) * fx;
      const sampled = north * (1 - fy) + south * fy;
      const index = row * gridSize + column;
      waterMask[index] = sampled < 0 ? 255 : 0;
      heights[index] = flattenSea && sampled < 0 ? 0 : sampled;
      minimumHeight = Math.min(minimumHeight, heights[index]);
      maximumHeight = Math.max(maximumHeight, heights[index]);
    }
  }

  return { heights, waterMask, allWater, minimumHeight, maximumHeight };
}

// Source zoom levels to try, deepest first, for a tile at `level`. Tiles whose
// ancestor is already known to be missing are skipped without a request.
export function planSourceLevels(level, x, y, { nativeMaximumLevel, guaranteedLevel }, isMissing = () => false) {
  let start = Math.min(level, nativeMaximumLevel);
  for (let l = guaranteedLevel + 1; l <= start; l += 1) {
    const shift = level - l;
    if (isMissing(l, Math.floor(x / 2 ** shift), Math.floor(y / 2 ** shift))) { start = l - 1; break; }
  }
  start = Math.max(start, Math.min(level, guaranteedLevel));
  const levels = [];
  for (let l = start; l >= Math.min(level, guaranteedLevel); l -= 1) levels.push(l);
  return levels;
}
