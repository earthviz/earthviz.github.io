
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const appBaseUrl = '/';
const cesiumBaseUrl = 'cesiumStatic';
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://server.arcgisonline.com https://tiles.maps.eox.at https://gibs.earthdata.nasa.gov https://s3.amazonaws.com",
  "connect-src 'self' https://server.arcgisonline.com https://tiles.maps.eox.at https://gibs.earthdata.nasa.gov https://s3.amazonaws.com https://tiles.openfreemap.org https://aa.usno.navy.mil https://nominatim.openstreetmap.org https://geocoding-api.open-meteo.com",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  'upgrade-insecure-requests',
  'block-all-mixed-content',
].join('; ');
const securityHeaders = {
  'Content-Security-Policy': contentSecurityPolicy,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
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
  server: { headers: securityHeaders },
  preview: { headers: securityHeaders },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        docs: 'docs/index.html',
        disclaimer: 'disclaimer/index.html',
      },
    },
  },
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
