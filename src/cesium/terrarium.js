export const TERRARIUM_TILE_SIZE = 256;
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
  let minimumHeight = Infinity;
  let maximumHeight = -Infinity;
  let allWater = true;

  // Classification uses every source pixel so islands do not disappear merely
  // because the rendered height grid is intentionally sparse.
  for (let i = 0; i < pixels.length; i += 4) {
    if (decodeTerrariumHeight(pixels[i], pixels[i + 1], pixels[i + 2]) >= 0) {
      allWater = false;
      break;
    }
  }

  for (let row = 0; row < gridSize; row += 1) {
    const py = row / (gridSize - 1) * (height - 1);
    const y0 = Math.floor(py);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = py - y0;
    for (let column = 0; column < gridSize; column += 1) {
      const px = column / (gridSize - 1) * (width - 1);
      const x0 = Math.floor(px);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = px - x0;
      const north = heightAt(pixels, width, x0, y0) * (1 - fx)
        + heightAt(pixels, width, x1, y0) * fx;
      const south = heightAt(pixels, width, x0, y1) * (1 - fx)
        + heightAt(pixels, width, x1, y1) * fx;
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
