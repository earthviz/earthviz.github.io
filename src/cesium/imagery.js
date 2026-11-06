import { Color } from '@cesium/core';
import {
  ImageryLayer,
  UrlTemplateImageryProvider,
  WebMercatorTilingScheme,
} from '@cesium/engine';
import {
  GIBS_LAYER,
  GIBS_NATIVE_MAX_ZOOM,
  HLS_L30_LAYER,
  HLS_NATIVE_MAX_ZOOM,
  HLS_S30_LAYER,
} from '../spacetime.js';

export const EXPLORE_IMAGERY = {
  esri: {
    maximumLevel: 15,
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    // Interactive display only. Do not add offline persistence, tile export,
    // scraping, or bulk download without a separate licence from Esri.
    credit: 'Sources: Esri, Vantor, Earthstar Geographics, and the GIS User Community',
  },
  eox: {
    maximumLevel: 13,
    url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/g/{z}/{y}/{x}.jpg',
    credit: 'Sentinel-2 cloudless by EOX (CC BY 4.0, contains modified Copernicus Sentinel data)',
  },
};

function templateProvider({ url, maximumLevel, credit, hasAlphaChannel = false }) {
  return new UrlTemplateImageryProvider({
    url,
    maximumLevel,
    credit,
    hasAlphaChannel,
    enablePickFeatures: false,
    tilingScheme: new WebMercatorTilingScheme(),
  });
}

export function createExploreLayers(source) {
  const definition = EXPLORE_IMAGERY[source] ?? EXPLORE_IMAGERY.eox;
  return [new ImageryLayer(templateProvider(definition), { maximumAnisotropy: 8 })];
}

function gibsUrl(layer, date, matrix, extension) {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/${matrix}/{z}/{y}/{x}.${extension}`;
}

export function createSpacetimeLayers(date) {
  const credit = 'Daily imagery: NASA EOSDIS GIBS';
  const modis = new ImageryLayer(templateProvider({
    url: gibsUrl(GIBS_LAYER, date, 'GoogleMapsCompatible_Level9', 'jpg'),
    maximumLevel: GIBS_NATIVE_MAX_ZOOM,
    credit,
  }), {
    maximumTerrainLevel: GIBS_NATIVE_MAX_ZOOM,
    maximumAnisotropy: 8,
  });
  const hlsOptions = {
    maximumLevel: HLS_NATIVE_MAX_ZOOM,
    credit,
    hasAlphaChannel: true,
  };
  const landsat = new ImageryLayer(templateProvider({
    ...hlsOptions,
    url: gibsUrl(HLS_L30_LAYER, date, 'GoogleMapsCompatible_Level12', 'png'),
  }), {
    minimumTerrainLevel: GIBS_NATIVE_MAX_ZOOM + 1,
    maximumAnisotropy: 8,
  });
  const sentinel = new ImageryLayer(templateProvider({
    ...hlsOptions,
    url: gibsUrl(HLS_S30_LAYER, date, 'GoogleMapsCompatible_Level12', 'png'),
  }), {
    minimumTerrainLevel: GIBS_NATIVE_MAX_ZOOM + 1,
    maximumAnisotropy: 8,
  });
  return [modis, landsat, sentinel];
}

export class ImageryController {
  constructor(globe) {
    this.globe = globe;
    this.layers = [];
    this.globe.baseColor = Color.BLACK;
  }

  replace(layers) {
    this.globe.imageryLayers.removeAll(true);
    this.layers = layers;
    for (const layer of layers) this.globe.imageryLayers.add(layer);
  }

  showExplore(source) {
    this.replace(createExploreLayers(source));
  }

  showSpacetime(date) {
    // Removing first guarantees that neither Explore nor the previous date is
    // visible while the selected date starts loading.
    this.replace(createSpacetimeLayers(date));
  }
}
