
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const appBaseUrl = '/earthviz/';
const cesiumBaseUrl = 'cesiumStatic';
const cesiumWorkers = [
  'node_modules/@cesium/engine/Build/Workers/combineGeometry.js',
  'node_modules/@cesium/engine/Build/Workers/createGeometry.js',
  'node_modules/@cesium/engine/Build/Workers/createGroundPolylineGeometry.js',
  'node_modules/@cesium/engine/Build/Workers/createPolygonGeometry.js',
  'node_modules/@cesium/engine/Build/Workers/createVerticesFromHeightmap.js',
  'node_modules/@cesium/engine/Build/Workers/incrementallyBuildTerrainPicker.js',
  'node_modules/@cesium/engine/Build/Workers/transferTypedArrayTest.js',
  'node_modules/@cesium/engine/Build/Workers/chunk-4GX4QAU2.js',
  'node_modules/@cesium/engine/Build/Workers/chunk-ACC5TYIT.js',
  'node_modules/@cesium/engine/Build/Workers/chunk-B3UD5E5N.js',
  'node_modules/@cesium/engine/Build/Workers/chunk-C4BI3UED.js',
  'node_modules/@cesium/engine/Build/Workers/chunk-N4AX4H36.js',
];
const cesiumAssets = [
  'node_modules/@cesium/engine/Source/Assets/approximateTerrainHeights.json',
  'node_modules/@cesium/engine/Source/Assets/IAU2006_XYS/*.json',
  'node_modules/@cesium/engine/Source/Assets/Images/ion-credit.png',
  'node_modules/@cesium/engine/Source/Assets/Textures/SkyBox/*.jpg',
  'node_modules/@cesium/engine/Source/Assets/Textures/moonSmall.jpg',
];

export default defineConfig({
  base: appBaseUrl,
  define: {
    CESIUM_BASE_URL: JSON.stringify(`${appBaseUrl}${cesiumBaseUrl}/`),
  },
  plugins: [
    viteStaticCopy({
      targets: [
        {
          // Keep the deployed worker set narrow: terrain/picking plus the
          // polygon and ground-polyline workers used by OpenFreeMap detail.
          src: cesiumWorkers,
          dest: cesiumBaseUrl,
          rename: { stripBase: 4 },
        },
        {
          src: cesiumAssets,
          dest: cesiumBaseUrl,
          rename: { stripBase: 4 },
        },
      ],
    }),
  ],
});
