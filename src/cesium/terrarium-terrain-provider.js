import { Ellipsoid, Event } from '@cesium/core';
import {
  Credit,
  HeightmapTerrainData,
  Resource,
  TerrainProvider,
  WebMercatorTilingScheme,
} from '@cesium/engine';
import { sampleTerrarium, TERRAIN_GRID_SIZE, TERRARIUM_TILE_SIZE } from './terrarium.js';

const DEFAULT_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

function tileUrl(template, level, x, y) {
  return template
    .replace('{z}', String(level))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

function imagePixels(image) {
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(TERRARIUM_TILE_SIZE, TERRARIUM_TILE_SIZE)
    : Object.assign(document.createElement('canvas'), {
      width: TERRARIUM_TILE_SIZE,
      height: TERRARIUM_TILE_SIZE,
    });
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.clearRect(0, 0, TERRARIUM_TILE_SIZE, TERRARIUM_TILE_SIZE);
  context.drawImage(image, 0, 0, TERRARIUM_TILE_SIZE, TERRARIUM_TILE_SIZE);
  return context.getImageData(0, 0, TERRARIUM_TILE_SIZE, TERRARIUM_TILE_SIZE).data;
}

export class TerrariumTerrainProvider {
  constructor(options = {}) {
    this.url = options.url ?? DEFAULT_URL;
    this.maximumLevel = options.maximumLevel ?? 15;
    this.flattenSea = options.flattenSea ?? true;
    this.tilingScheme = new WebMercatorTilingScheme({ ellipsoid: Ellipsoid.WGS84 });
    this.errorEvent = new Event();
    this.credit = new Credit('Elevation: Mapzen Terrarium (AWS)');
    // We classify ocean tiles for LOD, but deliberately do not expose a water
    // mask: Cesium otherwise replaces source pixels with its animated water
    // material instead of simply draping the selected imagery.
    this.hasWaterMask = false;
    this.hasVertexNormals = false;
    this.availability = undefined;
    this.levelZeroMaximumGeometricError =
      TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
        this.tilingScheme.ellipsoid,
        TERRAIN_GRID_SIZE,
        this.tilingScheme.getNumberOfXTilesAtLevel(0),
      );
  }

  requestTileGeometry(x, y, level, request) {
    if (level > this.maximumLevel) return undefined;
    const resource = new Resource({
      url: tileUrl(this.url, level, x, y),
      request,
      retryAttempts: 1,
      retryCallback: () => true,
    });
    const imagePromise = resource.fetchImage({
      preferBlob: true,
      preferImageBitmap: true,
      skipColorSpaceConversion: true,
    });
    if (!imagePromise) return undefined;
    return imagePromise.then((image) => {
      const sampled = sampleTerrarium(
        imagePixels(image),
        TERRARIUM_TILE_SIZE,
        TERRARIUM_TILE_SIZE,
        { flattenSea: this.flattenSea },
      );
      image.close?.();
      const childTileMask = level >= this.maximumLevel || (level >= 5 && sampled.allWater) ? 0 : 15;
      return new HeightmapTerrainData({
        buffer: sampled.heights,
        width: TERRAIN_GRID_SIZE,
        height: TERRAIN_GRID_SIZE,
        childTileMask,
      });
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
