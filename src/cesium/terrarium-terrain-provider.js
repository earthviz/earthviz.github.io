import { Ellipsoid, Event } from '@cesium/core';
import {
  Credit,
  HeightmapTerrainData,
  Request,
  Resource,
  TerrainProvider,
  WebMercatorTilingScheme,
} from '@cesium/engine';
import { DEFAULT_TERRAIN_SOURCE, planSourceLevels, sampleTerrarium, TERRAIN_GRID_SIZE, TERRAIN_SOURCES } from './terrarium.js';

function tileUrl(template, level, x, y) {
  return template
    .replace('{z}', String(level))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

// Tiles may be 256px (AWS) or 512px (Mapterhorn); use the decoded image size.
function imagePixels(image) {
  const size = image.width || 256;
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(size, size)
    : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.clearRect(0, 0, size, size);
  context.drawImage(image, 0, 0, size, size);
  return { pixels: context.getImageData(0, 0, size, size).data, size };
}

export class TerrariumTerrainProvider {
  constructor(options = {}) {
    const source = TERRAIN_SOURCES[DEFAULT_TERRAIN_SOURCE];
    this.url = options.url ?? source.url;
    this.maximumLevel = options.maximumLevel ?? 15;
    // Deepest zoom the server actually has; deeper levels are oversampled.
    this.nativeMaximumLevel = options.nativeMaximumLevel ?? source.nativeMaximumLevel;
    this.guaranteedLevel = options.guaranteedLevel ?? source.guaranteedLevel;
    // Source tiles that returned 404, so descendants skip straight to a parent.
    this.missing = new Set();
    this.creditText = options.credit ?? source.credit;
    this.creditUrl = options.creditUrl;
    this.flattenSea = options.flattenSea ?? true;
    // Samples per tile edge. Higher values preserve more steep, narrow relief.
    this.gridSize = options.gridSize ?? TERRAIN_GRID_SIZE;
    this.tilingScheme = new WebMercatorTilingScheme({ ellipsoid: Ellipsoid.WGS84 });
    this.errorEvent = new Event();
    this.credit = new Credit(this.creditText);
    // We classify ocean tiles for LOD, but deliberately do not expose a water
    // mask: Cesium otherwise replaces source pixels with its animated water
    // material instead of simply draping the selected imagery.
    this.hasWaterMask = false;
    this.hasVertexNormals = false;
    this.availability = undefined;
    this.levelZeroMaximumGeometricError =
      TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
        this.tilingScheme.ellipsoid,
        this.gridSize,
        this.tilingScheme.getNumberOfXTilesAtLevel(0),
      );
  }

  requestTileGeometry(x, y, level, request) {
    if (level > this.maximumLevel) return undefined;
    const levels = planSourceLevels(level, x, y, this, (l, tx, ty) => this.missing.has(`${l}/${tx}/${ty}`));
    return this.fetchLevel(levels, 0, x, y, level, request);
  }

  fetchLevel(levels, index, x, y, level, request) {
    const nativeLevel = levels[index];
    const scale = 2 ** (level - nativeLevel);
    const tx = Math.floor(x / scale);
    const ty = Math.floor(y / scale);
    const region = scale > 1
      ? { x: (x % scale) / scale, y: (y % scale) / scale, size: 1 / scale }
      : undefined;
    const isLast = index === levels.length - 1;
    const resource = new Resource({
      url: tileUrl(this.url, nativeLevel, tx, ty),
      request,
      retryAttempts: isLast ? 1 : 0,
      retryCallback: () => true,
    });
    const imagePromise = resource.fetchImage({
      preferBlob: true,
      preferImageBitmap: true,
      skipColorSpaceConversion: true,
    });
    if (!imagePromise) return undefined;
    return imagePromise.then((image) => {
      const { pixels, size } = imagePixels(image);
      const sampled = sampleTerrarium(pixels, size, size, {
        flattenSea: this.flattenSea,
        gridSize: this.gridSize,
        region,
      });
      image.close?.();
      const childTileMask = level >= this.maximumLevel || (level >= 5 && sampled.allWater) ? 0 : 15;
      return new HeightmapTerrainData({
        buffer: sampled.heights,
        width: this.gridSize,
        height: this.gridSize,
        childTileMask,
      });
    }, (error) => {
      if (isLast) throw error;
      // Regional tiles are missing elsewhere: remember it and use the parent.
      if (error?.statusCode === 404) {
        if (this.missing.size > 20000) this.missing.clear();
        this.missing.add(`${nativeLevel}/${tx}/${ty}`);
      }
      return this.fetchLevel(levels, index + 1, x, y, level, new Request({ throttle: false }));
    });
  }

  getLevelMaximumGeometricError(level) {
    return this.levelZeroMaximumGeometricError / (2 ** level);
  }

  getTileDataAvailable(_x, _y, level) {
    return level <= this.maximumLevel;
  }

  loadTileDataAvailability() {
    return undefined;
  }
}
