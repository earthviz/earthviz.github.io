import { Color } from '@cesium/core';
import {
  ImageryLayer,
  UrlTemplateImageryProvider,
  WebMercatorTilingScheme,
} from '@cesium/engine';
import {
  GIBS_DAILY_SOURCES,
  GIBS_NATIVE_MAX_ZOOM,
  HLS_L30_LAYER,
  HLS_NATIVE_MAX_ZOOM,
  HLS_S30_LAYER,
} from '../spacetime.js';

export const EXPLORE_IMAGERY = {
  esri: {
    provider: 'Esri',
    maximumLevel: 15,
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    // Interactive display only. Do not add offline persistence, tile export,
    // scraping, or bulk download without a separate licence from Esri.
    credit: 'Sources: Esri, Vantor, Earthstar Geographics, and the GIS User Community',
  },
  ...Object.fromEntries([2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018].map(year => [`eox-${year}`, {
    provider: 'EOX',
    maximumLevel: 14,
    url: `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${year}_3857/default/g/{z}/{y}/{x}.jpg`,
    credit: `Sentinel-2 cloudless ${year} by EOX (CC BY 4.0, contains modified Copernicus Sentinel data ${year})`,
  }])),
  'nasa-blue-marble': {
    provider: 'NASA GIBS',
    maximumLevel: 8,
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
    credit: 'NASA EOSDIS GIBS · Blue Marble shaded relief and bathymetry',
  },
  'nasa-black-marble': {
    provider: 'NASA GIBS',
    maximumLevel: 8,
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
    credit: 'NASA EOSDIS GIBS · VIIRS Black Marble annual composite (2016)',
  },
  'nasa-goes-east': {
    provider: 'NASA GIBS',
    maximumLevel: 7,
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_GeoColor/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png',
    credit: 'NASA EOSDIS GIBS · GOES-East ABI GeoColor · latest available observation',
    hasAlphaChannel: true,
  },
  'nasa-goes-west': {
    provider: 'NASA GIBS',
    maximumLevel: 7,
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-West_ABI_GeoColor/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png',
    credit: 'NASA EOSDIS GIBS · GOES-West ABI GeoColor · latest available observation',
    hasAlphaChannel: true,
  },
  'nasa-himawari': {
    provider: 'NASA GIBS',
    maximumLevel: 7,
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Himawari_AHI_Band3_Red_Visible_1km/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png',
    credit: 'NASA EOSDIS GIBS · Himawari AHI visible clouds · latest available observation',
    hasAlphaChannel: true,
  },
};

export const DEFAULT_EXPLORE_IMAGERY = 'eox-2025';

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
  const definition = EXPLORE_IMAGERY[source] ?? EXPLORE_IMAGERY[DEFAULT_EXPLORE_IMAGERY];
  return [new ImageryLayer(templateProvider(definition), { maximumAnisotropy: 8 })];
}

function gibsUrl(layer, date, matrix, extension) {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/${matrix}/{z}/{y}/{x}.${extension}`;
}

export function createSpacetimeLayers(date, source = 'modis-terra') {
  const daily = GIBS_DAILY_SOURCES[source] ?? GIBS_DAILY_SOURCES['modis-terra'];
  const credit = `Daily imagery: NASA EOSDIS GIBS · ${daily.label}`;
  const modis = new ImageryLayer(templateProvider({
    url: gibsUrl(daily.layer, date, 'GoogleMapsCompatible_Level9', 'jpeg'),
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

  showSpacetime(date, source) {
    // Removing first guarantees that neither Explore nor the previous date is
    // visible while the selected date starts loading.
    this.replace(createSpacetimeLayers(date, source));
  }
}
