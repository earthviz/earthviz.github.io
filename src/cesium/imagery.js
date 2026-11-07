import { Color, Rectangle } from '@cesium/core';
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
import { gaiaTileUrl } from '../gibs-catalog.js';
import { GLS_MAX_ZOOM, glsEpochForDate, glsTileUrl, titilerTileUrl } from '../sources.js';

export const EXPLORE_IMAGERY = {
  'sentinel2-live': {
    provider: 'Element 84 / EOX',
    maximumLevel: 14,
    url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg',
    credit: 'Sentinel-2 latest scenes by Element 84 Earth Search; EOX Sentinel-2 cloudless 2025 fallback (CC BY 4.0, contains modified Copernicus Sentinel data 2025)',
  },
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

const COMPOSITE_ORDER = ['modis-aqua', 'modis-terra', 'viirs-noaa21', 'viirs-noaa20', 'viirs-snpp'];
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
  if (daily.kind === 'gls') {
    const epoch = glsEpochForDate(date);
    return [
      ...createExploreLayers('nasa-blue-marble'),
      new ImageryLayer(templateProvider({
        url: glsTileUrl(epoch),
        maximumLevel: GLS_MAX_ZOOM,
        credit: `Landsat Global Land Survey ${epoch} · USGS/NASA via Esri Landsat service`,
        hasAlphaChannel: true,
      }), { maximumAnisotropy: 8 }),
    ];
  }
  const credit = `Daily imagery: NASA EOSDIS GIBS · ${daily.label}`;
  const dailyLayer = (definition, transparentGaps) => new ImageryLayer(templateProvider({
    url: gibsUrl(definition.layer, date, 'GoogleMapsCompatible_Level9', 'jpeg'),
    maximumLevel: GIBS_NATIVE_MAX_ZOOM,
    credit,
  }), {
    maximumTerrainLevel: GIBS_NATIVE_MAX_ZOOM,
    maximumAnisotropy: 8,
    // GIBS true-colour JPEGs have no alpha: orbit gaps are solid black.
    ...(transparentGaps ? { colorToAlpha: Color.BLACK, colorToAlphaThreshold: 0.04 } : {}),
  });
  // Several polar sensors pass at different times, so each fills the others'
  // swath gaps. Bottom layer stays opaque; those above punch out black gaps.
  const base = daily.kind === 'composite' || daily.kind === 'sentinel2'
    ? COMPOSITE_ORDER.map(key => GIBS_DAILY_SOURCES[key]).filter(d => d.startDate <= date)
        .map((d, i) => dailyLayer(d, i > 0))
    : [dailyLayer(daily, false)];
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
  return [...base, landsat, sentinel];
}

export function createSentinelLayers(scenes) {
  return scenes.map(scene => new ImageryLayer(new UrlTemplateImageryProvider({
    url: titilerTileUrl(scene.href),
    maximumLevel: 14,
    hasAlphaChannel: true,
    rectangle: Rectangle.fromDegrees(scene.rectangle.west, scene.rectangle.south, scene.rectangle.east, scene.rectangle.north),
    credit: `Sentinel-2 L2A ${scene.datetime.slice(0, 10)} · contains modified Copernicus Sentinel data · Element 84 Earth Search`,
    enablePickFeatures: false,
    tilingScheme: new WebMercatorTilingScheme(),
  }), { minimumTerrainLevel: 8, maximumAnisotropy: 8 }));
}

export function createGaiaLayers(layer, time) {
  // Blue Marble underneath so transparent overlays (clouds, aerosols) read well.
  const overlay = new ImageryLayer(templateProvider({
    url: gaiaTileUrl(layer, time),
    maximumLevel: layer.maxLevel,
    credit: `NASA EOSDIS GIBS · ${layer.title}`,
    hasAlphaChannel: layer.format === 'image/png',
  }), { maximumAnisotropy: 8 });
  return [...createExploreLayers('nasa-blue-marble'), overlay];
}

export class ImageryController {
  constructor(globe) {
    this.globe = globe;
    this.layers = [];
    this.globe.baseColor = Color.BLACK;
  }

  replace(layers) {
    this.globe.imageryLayers.removeAll(true);
    this.sentinel = [];
    this.layers = layers;
    for (const layer of layers) this.globe.imageryLayers.add(layer);
  }

  showExplore(source) {
    this.replace(createExploreLayers(source));
  }

  showGaia(layer, time, overlays = []) {
    this.replace([...(layer ? createGaiaLayers(layer, time) : createExploreLayers('nasa-blue-marble')), ...overlays]);
  }

  // Sentinel-2 scenes arrive asynchronously, after the base layers are shown.
  setSentinelScenes(scenes) {
    for (const layer of this.sentinel ?? []) this.globe.imageryLayers.remove(layer, true);
    this.sentinel = createSentinelLayers(scenes);
    for (const layer of this.sentinel) this.globe.imageryLayers.add(layer);
  }

  showSpacetime(date, source) {
    // Removing first guarantees that neither Explore nor the previous date is
    // visible while the selected date starts loading.
    this.replace(createSpacetimeLayers(date, source));
  }
}
