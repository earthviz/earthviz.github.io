import * as THREE from 'three';
import { setupUI } from './ui.js';
import { FALLBACK_INSET_KM, LIMITS, selectFrontier, takeNext, terrainSegments, shouldRefine } from './lod.js';
import {
  apparentAngularDiameter,
  calculateSolarEvents,
  catalogEquatorial,
  degrees,
  equatorialToHorizontal,
  greenwichMeanSiderealTime,
  moonEquatorial,
  starRgb,
  sunEquatorial,
  EQUATORIAL_TO_GALACTIC,
  precessionMatrix,
} from './astronomy.js';
import {
  daylightState,
  nextPhenomenon,
  phenomenaByName,
  timeToMinutes,
  usnoOneDayUrl,
} from './solar-flow.js';
import {
  GIBS_NATIVE_MAX_ZOOM,
  GIBS_START_DATE,
  HLS_L30_LAYER,
  HLS_NATIVE_MAX_ZOOM,
  HLS_S30_LAYER,
  clampDay,
  dayToIso,
  gibsAncestor,
  gibsTileUrl,
  hlsTileUrl,
  isoToDay,
  previousUtcDate,
} from './spacetime.js';

const R = 6371;
const S = 32; // Elevation sampling grid; rendered geometry is independently adaptive.
const T = 256;
const MAX_ZOOM = 15;
const D2R = Math.PI / 180;
const MAX_TILES = LIMITS.tiles;
const MAX_QUEUE = LIMITS.queued;
const MAX_CONCURRENT_LOADS = LIMITS.concurrent;
const TILE_REQUEST_TIMEOUT = 12000;
const BSC5_URL = new URL('../bsc5.json', import.meta.url);
const MILKY_WAY_URL = new URL('../milky_way.jpg', import.meta.url);
const $ = (id) => document.getElementById(id);
const clamp = THREE.MathUtils.clamp;
let mode = 'explore';
let spacetimeDate = previousUtcDate();
let nonSpacetimeObservationDay = '';
let imageryRevision = 0;
const DEM = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const IMAGE_SOURCES = {
  esri: {
    maxZoom: 15,
    fn: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    credit: 'Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
  eox: {
    maxZoom: 13,
    fn: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/g/${z}/${y}/${x}.jpg`,
    credit: 'Imagery: <a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless by EOX</a> (CC BY 4.0, contains modified Copernicus Sentinel data)',
  },
  gibs: {
    maxZoom: GIBS_NATIVE_MAX_ZOOM,
    fn: (z, x, y) => gibsTileUrl(spacetimeDate, z, x, y),
    credit: 'Daily imagery: <a href="https://www.earthdata.nasa.gov/about/esdis/eosdis/gibs" target="_blank" rel="noopener">NASA EOSDIS GIBS</a> · MODIS Terra Corrected Reflectance (True Color)',
  },
};
const sourceKey = () => (mode === 'spacetime' ? 'gibs' : $('src').value);

// Convert latitude/longitude in radians to a point on the globe.
// Y is the north pole; east is -Z at longitude 0.
const ll2v = (lat, lng, r = 1) => {
  const c = Math.cos(lat);
  return new THREE.Vector3(r * c * Math.cos(lng), r * Math.sin(lat), -r * c * Math.sin(lng));
};

/* ---------- renderer / scene ---------- */
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = new THREE.FogExp2(0x000000, 0);

// The camera stays at the origin while the world moves around it. This keeps float32 coordinates precise.
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1, 30000);
const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 0.35);
const sunL = new THREE.DirectionalLight(0xffffff, 3);
scene.add(hemi, sunL);

// Base sphere and polar caps hide gaps while tiles load. Web Mercator stops at ±85°.
const back = new THREE.Group();
back.add(new THREE.Mesh(
  new THREE.SphereGeometry(R - FALLBACK_INSET_KM, 96, 48),
  new THREE.MeshStandardMaterial({ color: 0x1b3a52, roughness: 1 }),
));
const capMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 1 });
const capN = new THREE.Mesh(
  new THREE.SphereGeometry(R - 0.5, 48, 6, 0, 2 * Math.PI, 0, 4.95 * D2R),
  capMat,
);
const capS = new THREE.Mesh(capN.geometry, capMat);
capS.rotation.x = Math.PI;
back.add(capN, capS);
scene.add(back);

const sunU = { value: new THREE.Vector3(1, 0, 0) };
const fadeU = { value: 1 };
const visU = { value: 1 };
const atm = new THREE.Mesh(
  new THREE.SphereGeometry(R + 100, 96, 48),
  new THREE.ShaderMaterial({
    uniforms: { uSun: sunU, uFade: fadeU },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    vertexShader: `
      varying vec3 vN, vW;
      void main() {
        vN = normalize(normalMatrix * normal);
        vW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uSun;
      uniform float uFade;
      varying vec3 vN, vW;
      void main() {
        float i = min(1.5, pow(max(0.0, 0.62 - dot(vN, vec3(0.0, 0.0, 1.0))), 3.0) * 2.2);
        float sd = dot(vW, uSun);
        float sun = clamp(sd * 1.6 + 0.45, 0.0, 1.0);
        vec3 c = mix(vec3(0.25, 0.5, 1.0), vec3(1.0, 0.55, 0.3),
          (1.0 - smoothstep(0.0, 0.35, abs(sd))) * 0.6);
        gl_FragColor = vec4(c * i * sun * uFade, 1.0);
      }
    `,
  }),
);
scene.add(atm);

let starCatalog = [];
let starEquatorial = [];
let selectedStar = -1;
let starStatus = 'Loading the Bright Star Catalogue…';
let starEpochDay = '';
const starGeometry = new THREE.BufferGeometry();
starGeometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
starGeometry.setAttribute('size', new THREE.Float32BufferAttribute([], 1));
starGeometry.setAttribute('color', new THREE.Float32BufferAttribute([], 3));
const stars = new THREE.Points(
  starGeometry,
  new THREE.ShaderMaterial({
    uniforms: { uVis: visU, uPixelRatio: { value: renderer.getPixelRatio() } },
    transparent: true,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float size;
      attribute vec3 color;
      uniform float uPixelRatio;
      varying vec3 vColor;
      void main() {
        vec4 p = projectionMatrix * vec4(mat3(modelViewMatrix) * position, 1.0);
        gl_Position = p.xyww;
        gl_PointSize = size * uPixelRatio;
        vColor = color;
      }
    `,
    fragmentShader: `
      uniform float uVis;
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.08, d);
        float core = smoothstep(0.18, 0.0, d);
        gl_FragColor = vec4(vColor * (0.82 + core * 0.35), a * uVis);
      }
    `,
  }),
);
stars.frustumCulled = false;
stars.renderOrder = -1;
scene.add(stars);

/* ---------- Milky Way (ESO/S. Brunier panorama) ----------
 * One unit sphere, drawn once, sampled per fragment in galactic coordinates.
 * The panorama is a full-sky equirectangular map with the galactic centre at
 * the image centre and longitude increasing to the left, so it must not be
 * wrapped around the sphere by UV. Instead each pixel's direction is rotated
 * star-frame -> J2000 equatorial (undo precession) -> galactic and looked up
 * once. That gives exactly one copy of the sky, locked to the catalog stars.
 */
const galacticU = { value: new THREE.Matrix3() };
const milkyWayU = { value: null };
const milkyWay = new THREE.Mesh(
  new THREE.SphereGeometry(1, 32, 16),
  new THREE.ShaderMaterial({
    uniforms: { uMap: milkyWayU, uGalactic: galacticU, uVis: visU, uReady: { value: 0 }, uOpacity: { value: 1 } },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * vec4(mat3(modelViewMatrix) * position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform mat3 uGalactic;
      uniform float uVis;
      uniform float uReady;
      uniform float uOpacity;
      varying vec3 vDir;
      const float PI = 3.14159265358979;
      void main() {
        vec3 g = normalize(uGalactic * normalize(vDir));
        float u = 0.5 - atan(g.y, g.x) / (2.0 * PI);
        float v = 0.5 + asin(clamp(g.z, -1.0, 1.0)) / PI;
        // atan() jumps at l = +-180 deg, which would make the mip selector pick
        // the smallest mip along a seam. Use the derivative of whichever wrap
        // of u is continuous at this pixel.
        float u2 = fract(u + 0.5) - 0.5;
        vec2 dx = abs(dFdx(u)) < abs(dFdx(u2)) ? vec2(dFdx(u), dFdx(v)) : vec2(dFdx(u2), dFdx(v));
        vec2 dy = abs(dFdy(u)) < abs(dFdy(u2)) ? vec2(dFdy(u), dFdy(v)) : vec2(dFdy(u2), dFdy(v));
        vec3 c = textureGrad(uMap, vec2(u, v), dx, dy).rgb;
        gl_FragColor = vec4(c * uVis * uReady * uOpacity, 1.0);
      }
    `,
  }),
);
milkyWay.frustumCulled = false;
milkyWay.renderOrder = -2;
scene.add(milkyWay);

// Opacity slider: 0 = catalog stars only, 1 = panorama + catalog stars.
const milkyWayOpacity = $('mw');
function applyMilkyWayOpacity() {
  const value = clamp(Number.parseFloat(milkyWayOpacity.value) || 0, 0, 1);
  milkyWay.material.uniforms.uOpacity.value = value;
  milkyWay.visible = value > 0; // skip the full-sky pass entirely at 0
  $('mw-value').textContent = `${Math.round(value * 100)}%`;
}
milkyWayOpacity.addEventListener('input', applyMilkyWayOpacity);
applyMilkyWayOpacity();

// Matrix applied in the shader: star-frame vector -> galactic vector.
// Star frame (see updateStarEpoch): x = cos(dec)cos(ra), y = sin(dec), z = -cos(dec)sin(ra),
// i.e. equatorial (X, Y, Z) = (x, -z, y).
const galacticScratch = {
  starToEquatorial: new THREE.Matrix3().set(1, 0, 0, 0, 0, -1, 0, 1, 0),
  precession: new THREE.Matrix3(),
  toGalactic: new THREE.Matrix3().set(...EQUATORIAL_TO_GALACTIC),
};
function updateMilkyWay(date) {
  // The stars are drawn at their equinox-of-date positions; the panorama is in
  // J2000, so undo precession (transpose of an orthonormal matrix = inverse).
  galacticScratch.precession.set(...precessionMatrix(date)).transpose();
  galacticU.value
    .copy(galacticScratch.toGalactic)
    .multiply(galacticScratch.precession)
    .multiply(galacticScratch.starToEquatorial);
}

function loadMilkyWay() {
  new THREE.TextureLoader().load(MILKY_WAY_URL.href, (texture) => {
    let map = texture;
    const limit = renderer.capabilities.maxTextureSize;
    const image = texture.image;
    if (image.width > limit) {
      // Small GPUs (many phones cap at 4096): downscale once instead of failing.
      const canvas = document.createElement('canvas');
      canvas.width = limit;
      canvas.height = Math.round(limit * image.height / image.width);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      texture.dispose();
      map = new THREE.CanvasTexture(canvas);
    }
    // Values are already display-encoded; the star shaders also write straight
    // to the framebuffer, so keep the texture unconverted.
    map.colorSpace = THREE.NoColorSpace;
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.ClampToEdgeWrapping;
    map.generateMipmaps = true;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.magFilter = THREE.LinearFilter;
    map.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    map.needsUpdate = true;
    milkyWayU.value = map;
    milkyWay.material.uniforms.uReady.value = 1;
  }, undefined, (error) => console.error('Could not load milky_way.jpg:', error));
}

const celestialGeometry = new THREE.SphereGeometry(1, 48, 32);
const sunBody = new THREE.Mesh(
  celestialGeometry,
  new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    vertexShader: `
      varying vec3 vViewNormal;
      void main() {
        vViewNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vViewNormal;
      void main() {
        float mu = clamp(vViewNormal.z, 0.0, 1.0);
        vec3 edge = vec3(1.0, 0.48, 0.12);
        vec3 center = vec3(1.0, 0.94, 0.68);
        vec3 color = mix(edge, center, pow(mu, 0.45));
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  }),
);
sunBody.name = 'Sun';
sunBody.frustumCulled = false;
sunBody.renderOrder = -0.6;
scene.add(sunBody);

const moonSunU = { value: new THREE.Vector3(1, 0, 0) };
const moonDirectionU = { value: new THREE.Vector3(1, 0, 0) };
const moonBody = new THREE.Mesh(
  celestialGeometry,
  new THREE.ShaderMaterial({
    uniforms: { uSun: moonSunU, uMoonDirection: moonDirectionU },
    transparent: true,
    depthWrite: false,
    fog: false,
    vertexShader: `
      varying vec3 vWorldNormal;
      varying vec3 vLocalNormal;
      void main() {
        vLocalNormal = normal;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uSun;
      uniform vec3 uMoonDirection;
      varying vec3 vWorldNormal;
      varying vec3 vLocalNormal;
      void main() {
        float sunlight = smoothstep(-0.012, 0.018, dot(normalize(vWorldNormal), normalize(uSun)));
        float towardViewer = clamp(dot(normalize(vWorldNormal), -normalize(uMoonDirection)), 0.0, 1.0);
        float limb = pow(towardViewer, 0.16);
        float maria = sin(vLocalNormal.x * 31.0 + vLocalNormal.y * 17.0)
          * sin(vLocalNormal.z * 43.0 - vLocalNormal.x * 11.0);
        vec3 stone = vec3(0.72, 0.73, 0.69) * (0.94 + 0.06 * maria);
        float earthshine = 0.018;
        gl_FragColor = vec4(stone * (earthshine + sunlight * 0.982) * limb, 1.0);
      }
    `,
  }),
);
moonBody.name = 'Moon';
moonBody.frustumCulled = false;
moonBody.renderOrder = -0.5;
scene.add(moonBody);

function commonStarName(star) {
  const names = star.Notes?.find(note => note.Category === 'Star names')?.Remark;
  if (names) return names.split(';')[0].trim().replace(/\.$/, '').toLowerCase()
    .replace(/(^|\s)\S/g, letter => letter.toUpperCase());
  return star.Name?.trim() || `HR ${star.HR}`;
}

function updateStarEpoch(date, force = false) {
  if (!starCatalog.length) return;
  const day = date.toISOString().slice(0, 10);
  if (!force && day === starEpochDay) return;
  starEpochDay = day;
  const positions = new Float32Array(starCatalog.length * 3);
  starEquatorial = new Array(starCatalog.length);
  for (let i = 0; i < starCatalog.length; i += 1) {
    const equatorial = catalogEquatorial(starCatalog[i], date);
    starEquatorial[i] = equatorial;
    const c = Math.cos(equatorial.dec);
    positions[3 * i] = c * Math.cos(equatorial.ra);
    positions[3 * i + 1] = Math.sin(equatorial.dec);
    positions[3 * i + 2] = -c * Math.sin(equatorial.ra);
  }
  stars.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  stars.geometry.computeBoundingSphere();
}

async function loadStarCatalog() {
  try {
    const response = await fetch(BSC5_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    starCatalog = await response.json();
    const sizes = new Float32Array(starCatalog.length);
    const colors = new Float32Array(starCatalog.length * 3);
    for (let i = 0; i < starCatalog.length; i += 1) {
      const magnitude = Number.parseFloat(starCatalog[i].Vmag);
      sizes[i] = clamp(1.15 + 2.7 * 10 ** (-0.2 * (Number.isFinite(magnitude) ? magnitude : 6)), 1.1, 8);
      colors.set(starRgb(starCatalog[i]), i * 3);
    }
    stars.geometry.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1));
    stars.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    updateStarEpoch(observationDate(), true);
    starStatus = `${starCatalog.length.toLocaleString()} catalog stars · click a star to identify it`;
  } catch (error) {
    console.error('Could not load bsc5.json:', error);
    starStatus = 'The Bright Star Catalogue could not be loaded';
  }
}

/* ---------- tiles ---------- */
const tiles = new Map();
const gibsImageCache = new Map();
// Keep tiny elevation bounds after releasing GPU assets, so evicted offscreen
// tiles don't return with a huge unknown-height bound and immediately reload.
const elevationBounds = new Map();
const queue = [];
const visible = [];
let generation = 0;
let frame = 0;
let active = 0;
const sampleCanvas = document.createElement('canvas');
sampleCanvas.width = sampleCanvas.height = T;
const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true });
const blackTile = document.createElement('canvas');
blackTile.width = blackTile.height = T;
const blackTileContext = blackTile.getContext('2d');
blackTileContext.fillStyle = '#000';
blackTileContext.fillRect(0, 0, T, T);
const commits = [];
const loadImage = (url, signal) => new Promise((resolve) => {
  const image = new Image();
  let timer;
  const finish = (result) => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    image.onload = null;
    image.onerror = null;
    resolve(result);
  };
  const abort = () => { image.src = ''; finish(null); };
  if (signal?.aborted) { resolve(null); return; }
  signal?.addEventListener('abort', abort, { once: true });
  image.crossOrigin = 'anonymous';
  image.onload = () => finish(image);
  image.onerror = () => finish(null);
  timer = setTimeout(() => {
    image.src = '';
    finish(null);
  }, TILE_REQUEST_TIMEOUT);
  image.src = url;
});

function getTile(z, x, y, cache = true) {
  const key = `${z}/${x}/${y}`;
  let tile = tiles.get(key);
  if (tile) return tile;

  const n = 2 ** z;
  const mercatorLat = (yy) => Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n)));
  const lng0 = (x / n) * 2 * Math.PI - Math.PI;
  const lng1 = ((x + 1) / n) * 2 * Math.PI - Math.PI;
  const lngc = (lng0 + lng1) / 2;
  const latc = mercatorLat(y + 0.5);
  tile = {
    key,
    z,
    x,
    y,
    generation,
    ready: false,
    loading: false,
    queued: false,
    hasElevation: false,
    land: null,
    split: false,
    retryAt: 0,
    controller: null,
    segments: 8,
    dirty: false,
    minHeight: 0,
    maxHeight: 0,
    terrainRange: 0,
    imageryRevision: -1,
    imagerySource: null,
    used: 0,
    mesh: null,
    height: null,
    center: ll2v(latc, lngc, R),
    unitCenter: ll2v(latc, lngc),
  };

  let bound = 0;
  for (const [yy, lng] of [[y, lng0], [y, lng1], [y + 1, lng0], [y + 1, lng1], [y, lngc], [y + 1, lngc], [y + 0.5, lng0], [y + 0.5, lng1]]) {
    bound = Math.max(bound, ll2v(mercatorLat(yy), lng, R).distanceTo(tile.center));
  }
  tile.surfaceBound = bound;
  const knownBounds = elevationBounds.get(key);
  tile.bound = knownBounds
    ? bound + Math.max(Math.abs(knownBounds.min), Math.abs(knownBounds.max)) * (+$('ex').value / 1000) + bound * 1.2 * 0.02 + 0.05
    : bound + 9;
  tile.size = bound * 1.2;
  if (cache) tiles.set(key, tile);
  return tile;
}

function visibleChildren(tile) {
  const candidates = [[0, 0], [1, 0], [0, 1], [1, 1]]
    .map(([dx, dy]) => getTile(tile.z + 1, tile.x * 2 + dx, tile.y * 2 + dy, false));
  // Don't repeatedly allocate and evict siblings that never enter the view.
  const relevant = candidates.filter(tileInView);
  const missing = relevant.filter(child => !tiles.has(child.key));
  if (tiles.size + missing.length > MAX_TILES) return null;
  missing.forEach(child => tiles.set(child.key, child));
  return relevant;
}

function buildGeometry(tile) {
  const segments = tile.segments;
  const N = segments + 3;
  const mainIndices = [];
  const fullIndices = [];
  for (let b = 0; b < N - 1; b += 1) {
    for (let a = 0; a < N - 1; a += 1) {
      const i = a + b * N;
      const face = [i, i + N, i + 1, i + 1, i + N, i + N + 1];
      fullIndices.push(...face);
      if (a >= 1 && a < N - 2 && b >= 1 && b < N - 2) mainIndices.push(...face);
    }
  }
  const exaggeration = +$('ex').value / 1000;
  const flattenSea = $('flat').checked;
  const skirt = tile.size * 0.02 + 0.05;
  const lowest = flattenSea ? Math.max(0, tile.minHeight) : tile.minHeight;
  tile.bound = tile.surfaceBound + Math.max(Math.abs(lowest), Math.abs(tile.maxHeight)) * exaggeration + skirt;
  const n = 2 ** tile.z;
  const positions = new Float32Array(N * N * 3);
  const uvs = new Float32Array(N * N * 2);

  for (let b = 0; b < N; b += 1) {
    for (let a = 0; a < N; a += 1) {
      const i = clamp(a - 1, 0, segments);
      const j = clamp(b - 1, 0, segments);
      const ring = a === 0 || b === 0 || a === N - 1 || b === N - 1;
      let height = tile.height[Math.round(j / segments * S) * (S + 1) + Math.round(i / segments * S)];
      if (flattenSea && height < 0) height = 0;
      const lng = ((tile.x + i / segments) / n) * 2 * Math.PI - Math.PI;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + j / segments)) / n)));
      const radius = R + height * exaggeration - (ring ? skirt : 0);
      const c = Math.cos(lat);
      const index = b * N + a;
      positions[3 * index] = radius * c * Math.cos(lng) - tile.center.x;
      positions[3 * index + 1] = radius * Math.sin(lat) - tile.center.y;
      positions[3 * index + 2] = -radius * c * Math.sin(lng) - tile.center.z;
      uvs[2 * index] = (0.5 + (i / segments) * (T - 1)) / T;
      uvs[2 * index + 1] = 1 - (0.5 + (j / segments) * (T - 1)) / T;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(mainIndices);
  geometry.computeVertexNormals();

  // Use the interior normals for the skirt so its lighting matches the tile edge.
  const normals = geometry.attributes.normal.array;
  for (let b = 0; b < N; b += 1) {
    for (let a = 0; a < N; a += 1) {
      if (a === 0 || b === 0 || a === N - 1 || b === N - 1) {
        const source = clamp(b, 1, N - 2) * N + clamp(a, 1, N - 2);
        const destination = b * N + a;
        normals[3 * destination] = normals[3 * source];
        normals[3 * destination + 1] = normals[3 * source + 1];
        normals[3 * destination + 2] = normals[3 * source + 2];
      }
    }
  }
  geometry.setIndex(fullIndices);
  return geometry;
}

function parentOf(tile) {
  return tiles.get(`${tile.z - 1}/${Math.floor(tile.x / 2)}/${Math.floor(tile.y / 2)}`);
}

function needsElevation(tile) {
  if (tile.z <= 5) return true; // Coarse land/ocean classification.
  const parent = parentOf(tile);
  if (parent?.land === false) return false;
  const distance = Math.max(view.range * 0.4, tile.center.distanceTo(cameraPosition) - tile.surfaceBound);
  const unresolvedRelief = (parent?.terrainRange || 1000) / 4;
  return view.range < 80 || unresolvedRelief * (+$('ex').value / 1000) * pixelFactor / distance > 2;
}

function inheritElevation(tile) {
  const parent = parentOf(tile);
  if (!parent?.height) return;
  for (let j = 0; j <= S; j += 1) {
    for (let i = 0; i <= S; i += 1) {
      const x = (tile.x % 2 * S + i) / 2;
      const y = (tile.y % 2 * S + j) / 2;
      const a = Math.min(S - 1, Math.floor(x));
      const b = Math.min(S - 1, Math.floor(y));
      const fx = x - a;
      const fy = y - b;
      const h = parent.height;
      tile.height[j * (S + 1) + i] =
        (h[b * (S + 1) + a] * (1 - fx) + h[b * (S + 1) + a + 1] * fx) * (1 - fy)
        + (h[(b + 1) * (S + 1) + a] * (1 - fx) + h[(b + 1) * (S + 1) + a + 1] * fx) * fy;
    }
  }
  tile.minHeight = Math.min(...tile.height);
  tile.maxHeight = Math.max(...tile.height);
  tile.terrainRange = tile.maxHeight - tile.minHeight;
  // A parent containing land cannot classify each child as land or water.
  tile.land = parent.land === false ? false : null;
}

function textureFrom(image) {
  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
  texture.needsUpdate = true;
  return texture;
}

function replaceTileTexture(tile, image) {
  if (!tile.mesh) return;
  const oldTexture = tile.mesh.material.map;
  tile.mesh.material.map = textureFrom(image);
  tile.mesh.material.needsUpdate = true;
  oldTexture?.dispose();
}

function composeHlsImagery(landsat, sentinel) {
  if (!landsat && !sentinel) return blackTile;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = T;
  const context = canvas.getContext('2d');
  context.fillStyle = '#000';
  context.fillRect(0, 0, T, T);
  // Both HLS products carry transparent no-data pixels. Landsat provides the
  // base and Sentinel fills only where that day's Sentinel acquisition exists.
  if (landsat) context.drawImage(landsat, 0, 0, T, T);
  if (sentinel) context.drawImage(sentinel, 0, 0, T, T);
  return canvas;
}

function cachedGibsImage(url) {
  let request = gibsImageCache.get(url);
  if (!request) {
    request = loadImage(url).then((image) => {
      if (!image) gibsImageCache.delete(url);
      return image;
    });
    gibsImageCache.set(url, request);
  }
  return request;
}

function cropGibsAncestor(image, ancestor) {
  if (!image || ancestor.scale === 1) return image;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = T;
  const context = canvas.getContext('2d');
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const sourceWidth = width / ancestor.scale;
  const sourceHeight = height / ancestor.scale;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    image,
    ancestor.childX * sourceWidth,
    ancestor.childY * sourceHeight,
    sourceWidth,
    sourceHeight,
    0,
    0,
    T,
    T,
  );
  return canvas;
}

async function loadTileImagery(tile, requestedSource, signal) {
  if (requestedSource !== 'gibs') {
    return loadImage(IMAGE_SOURCES[requestedSource].fn(tile.z, tile.x, tile.y), signal);
  }

  if (tile.z <= GIBS_NATIVE_MAX_ZOOM) {
    // Only the selected day's acquisition is shown. Empty orbital swaths stay
    // black; no neighbouring date is ever blended in.
    const url = gibsTileUrl(spacetimeDate, tile.z, tile.x, tile.y);
    return (await cachedGibsImage(url)) || blackTile;
  }

  // Local views use NASA's 30 m HLS Landsat/Sentinel reflectance products.
  // Tiles deeper than z12 crop their matching maximum-resolution HLS parent.
  const ancestor = gibsAncestor(tile.z, tile.x, tile.y, HLS_NATIVE_MAX_ZOOM);
  const urls = [HLS_L30_LAYER, HLS_S30_LAYER]
    .map(layer => hlsTileUrl(layer, spacetimeDate, ancestor.z, ancestor.x, ancestor.y));
  const [landsat, sentinel] = await Promise.all(urls.map(url => cachedGibsImage(url)));
  return composeHlsImagery(
    cropGibsAncestor(landsat, ancestor),
    cropGibsAncestor(sentinel, ancestor),
  );
}

async function loadTile(tile) {
  tile.loading = true;
  tile.controller = new AbortController();
  const signal = tile.controller.signal;
  active += 1;
  const requestedGeneration = generation;
  const requestedImageryRevision = imageryRevision;
  const requestedSource = sourceKey();
  const terrainNeeded = !tile.ready || (tile.demDeferred && needsElevation(tile));
  const fetchElevation = terrainNeeded && needsElevation(tile);
  const imageNeeded = !tile.mesh?.material.map?.image || tile.imageryRevision !== requestedImageryRevision;
  try {
    const [dem, image] = await Promise.all([
      fetchElevation ? loadImage(DEM(tile.z, tile.x, tile.y), signal) : null,
      imageNeeded
        ? loadTileImagery(tile, requestedSource, signal)
        : tile.mesh.material.map.image,
    ]);
    if (requestedGeneration !== generation || signal.aborted) return;
    if (imageNeeded && requestedImageryRevision !== imageryRevision) return;
    if (!image) { tile.retryAt = performance.now() + 15000; return; }
    // Texture swaps and geometry builds are committed progressively, one per frame.
    await new Promise((resolve) => commits.push({ tile, resolve }));
    if (requestedGeneration !== generation || signal.aborted) return;
    if (imageNeeded && requestedImageryRevision !== imageryRevision) return;

    // A time/source change only replaces the GPU texture. Elevation samples and
    // geometry remain untouched unless the view independently requests more DEM detail.
    if (!terrainNeeded && tile.mesh) {
      replaceTileTexture(tile, image);
      tile.imageryRevision = requestedImageryRevision;
      tile.imagerySource = requestedSource;
      tile.retryAt = 0;
      return;
    }

    tile.height = new Float32Array((S + 1) ** 2);
    inheritElevation(tile);
    tile.demDeferred = !dem;
    if (fetchElevation && !dem) tile.retryAt = performance.now() + 15000;
    if (dem) {
      sampleContext.drawImage(dem, 0, 0, T, T);
      const data = sampleContext.getImageData(0, 0, T, T).data;
      const heightAt = (x, y) => {
        const index = 4 * (y * T + x);
        return data[index] * 256 + data[index + 1] + data[index + 2] / 256 - 32768;
      };
      let minHeight = Infinity;
      let maxHeight = -Infinity;
      for (let j = 0; j <= S; j += 1) {
        for (let i = 0; i <= S; i += 1) {
          const px = (i / S) * (T - 1);
          const py = (j / S) * (T - 1);
          const x0 = px | 0;
          const y0 = py | 0;
          const x1 = Math.min(T - 1, x0 + 1);
          const y1 = Math.min(T - 1, y0 + 1);
          const fx = px - x0;
          const fy = py - y0;
          const sampledHeight = (
            (heightAt(x0, y0) * (1 - fx) + heightAt(x1, y0) * fx) * (1 - fy)
            + (heightAt(x0, y1) * (1 - fx) + heightAt(x1, y1) * fx) * fy
          );
          tile.height[j * (S + 1) + i] = sampledHeight;
          minHeight = Math.min(minHeight, sampledHeight);
          maxHeight = Math.max(maxHeight, sampledHeight);
        }
      }
      elevationBounds.delete(tile.key);
      elevationBounds.set(tile.key, { min: minHeight, max: maxHeight });
      if (elevationBounds.size > 1024) elevationBounds.delete(elevationBounds.keys().next().value);
      tile.hasElevation = true;
      tile.minHeight = minHeight;
      tile.maxHeight = maxHeight;
      tile.terrainRange = Math.max(0, maxHeight - minHeight);
      // Inspect every DEM pixel, not just mesh vertices: small islands and
      // coastlines must not disappear between sparse geometry samples.
      tile.land = false;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768 >= 0) {
          tile.land = true;
          break;
        }
      }
    }

    const material = new THREE.MeshStandardMaterial({
      roughness: 1,
      metalness: 0,
      color: 0xffffff,
      map: textureFrom(image),
    });
    if (tile.mesh) {
      scene.remove(tile.mesh);
      tile.mesh.geometry.dispose();
      tile.mesh.material.map?.dispose();
      tile.mesh.material.dispose();
    }
    tile.segments = desiredSegments(tile);
    tile.mesh = new THREE.Mesh(buildGeometry(tile), material);
    tile.mesh.visible = false;
    tile.mesh.frustumCulled = false;
    scene.add(tile.mesh);
    tile.imageryRevision = requestedImageryRevision;
    tile.imagerySource = requestedSource;
    tile.ready = true;
  } catch (error) {
    tile.retryAt = performance.now() + 15000;
    if (requestedGeneration === generation) console.warn(`Tile ${tile.key} failed:`, error);
  } finally {
    active -= 1;
    tile.controller = null;
    tile.loading = false;
  }
}

function requestTile(tile) {
  tile.used = frame;
  const needsWork = !tile.ready || tile.imageryRevision !== imageryRevision || (tile.demDeferred && needsElevation(tile));
  if (needsWork && !tile.loading && !tile.queued && performance.now() >= tile.retryAt && queue.length < MAX_QUEUE) {
    tile.queued = true;
    queue.push(tile);
  }
}

function pumpQueue() {
  while (active < MAX_CONCURRENT_LOADS) {
    const tile = takeNext(queue,
      (candidate) => candidate.generation === generation && candidate.used === frame,
      (candidate) => candidate.z * 1e8 + candidate.center.distanceToSquared(cameraPosition));
    if (!tile) break;
    loadTile(tile);
  }
  for (const tile of tiles.values()) {
    if (tile.loading && tile.used < frame - 2) tile.controller?.abort();
  }
  // Resolving schedules exactly one geometry build after this frame yields.
  const job = commits.shift();
  if (job) job.resolve();
}

function disposeTile(tile) {
  tile.controller?.abort();
  if (tile.mesh) {
    scene.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    tile.mesh.material.map?.dispose();
    tile.mesh.material.dispose();
  }
  tiles.delete(tile.key);
}

function resetTiles() {
  generation += 1;
  for (const tile of [...tiles.values()]) disposeTile(tile);
  queue.length = 0;
  visible.length = 0;
  roots.length = 0;
  roots.push(...[[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => getTile(1, x, y)));
}

function rebuildAll() {
  for (const tile of tiles.values()) tile.dirty = true;
}

function desiredSegments(tile) {
  const distance = Math.max(view.range * 0.4, tile.center.distanceTo(cameraPosition) - tile.surfaceBound);
  const relief = tile.land === false ? 0 : tile.terrainRange * (+$('ex').value / 1000) * pixelFactor / distance;
  return terrainSegments(tile.z, relief);
}

function updateGeometry() {
  // A slider or camera move must never synchronously rebuild the entire cache.
  for (const tile of visible) {
    const segments = desiredSegments(tile);
    if (tile.dirty || segments !== tile.segments) {
      tile.segments = segments;
      tile.mesh.geometry.dispose();
      tile.mesh.geometry = buildGeometry(tile);
      tile.dirty = false;
      break;
    }
  }
}

function evictTiles() {
  if (tiles.size < MAX_TILES - 4) return;
  const oldTiles = [...tiles.values()]
    .filter((tile) => tile.z > 1 && tile.used < frame - 1 && !tile.loading && !tile.queued)
    .sort((a, b) => a.used - b.used);
  for (const tile of oldTiles) {
    if (tiles.size <= MAX_TILES * 0.8) break;
    disposeTile(tile);
  }
}

const roots = [];

/* ---------- view state, camera and controls ---------- */
const INITIAL_VIEW = { lat: 20 * D2R, lng: 0, range: 10000, heading: 0, tilt: 0.35 };
const LOCAL_VIEW_RANGE = 16;
const view = { ...INITIAL_VIEW };
const skyView = { azimuth: 0, altitude: 25 * D2R, fov: 60 };
let flight = null;
let groundHeight = 0;
const TERRAIN_SAFETY_MARGIN = 0.12;
const cameraPosition = new THREE.Vector3();
const target = new THREE.Vector3();
const cameraUnit = new THREE.Vector3();
const frustum = new THREE.Frustum();
const sphere = new THREE.Sphere();
let pixelFactor = 1;

function frameCamera() {
  const unit = ll2v(view.lat, view.lng);
  const east = new THREE.Vector3(-Math.sin(view.lng), 0, -Math.cos(view.lng));
  const north = new THREE.Vector3(
    -Math.sin(view.lat) * Math.cos(view.lng),
    Math.cos(view.lat),
    Math.sin(view.lat) * Math.sin(view.lng),
  );
  if (mode === 'stargaze') {
    const horizontal = north.clone().multiplyScalar(Math.cos(skyView.azimuth))
      .addScaledVector(east, Math.sin(skyView.azimuth));
    const look = horizontal.multiplyScalar(Math.cos(skyView.altitude))
      .addScaledVector(unit, Math.sin(skyView.altitude)).normalize();
    const vertical = unit.clone().addScaledVector(look, -unit.dot(look)).normalize();
    cameraPosition.copy(unit).multiplyScalar(R + groundHeight + 0.003);
    cameraUnit.copy(unit);
    camera.near = 0.001;
    camera.far = 2 * R + 300;
    camera.fov = skyView.fov;
    camera.updateProjectionMatrix();
    camera.position.set(0, 0, 0);
    camera.up.copy(vertical);
    camera.lookAt(look);
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    pixelFactor = innerHeight / (2 * Math.tan(camera.fov * D2R / 2));
    return;
  }
  const direction = north.multiplyScalar(Math.cos(view.heading)).addScaledVector(east, Math.sin(view.heading));
  target.copy(unit).multiplyScalar(R + groundHeight);
  // Keep a small clearance above the sampled focus point.
  const terrainSafety = groundHeight + TERRAIN_SAFETY_MARGIN;
  const radialClearance = Math.max(view.range * Math.cos(view.tilt), terrainSafety - groundHeight);
  cameraPosition
    .copy(target)
    .addScaledVector(unit, radialClearance)
    .addScaledVector(direction, -view.range * Math.sin(view.tilt));
  // Check the camera's own footprint too, since an oblique view places it
  // away from the focus point. Retain conservative clearance if data is absent.
  const cameraLat = Math.asin(cameraPosition.y / cameraPosition.length());
  const cameraLng = Math.atan2(-cameraPosition.z, cameraPosition.x);
  // The camera footprint is usually behind an oblique view. Use cached
  // ancestors there, not just rendered tiles, to avoid alternating between
  // local clearance and the unknown-terrain fallback as the frustum changes.
  const cameraGround = groundAt(cameraLat, cameraLng, tiles.values());
  const clearance = cameraGround ?? 9 * (+$('ex').value);
  if (cameraPosition.length() < R + clearance + TERRAIN_SAFETY_MARGIN) {
    cameraPosition.setLength(R + clearance + TERRAIN_SAFETY_MARGIN);
  }
  cameraUnit.copy(cameraPosition).normalize();
  camera.near = clamp(view.range * 0.02, 0.002, 800);
  camera.far = cameraPosition.length() + R + 1000;
  camera.fov = 50;
  camera.updateProjectionMatrix();
  camera.position.set(0, 0, 0);
  camera.up.copy(unit);
  camera.lookAt(target.clone().sub(cameraPosition));
  camera.updateMatrixWorld();
  frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  pixelFactor = innerHeight / (2 * Math.tan(camera.fov * D2R / 2));
}

function tileInView(tile) {
  const angle = Math.acos(clamp(tile.unitCenter.dot(cameraUnit), -1, 1));
  if (angle > Math.acos(Math.min(1, R / cameraPosition.length())) + 0.003 + tile.bound / R) return false;
  sphere.center.copy(tile.center).sub(cameraPosition);
  sphere.radius = tile.bound;
  return frustum.intersectsSphere(sphere);
}

function selectTiles() {
  const threshold = [0, 900, 750, 620, 520, 440, 360][+$('det').value];
  // Terrain detail always follows the selected Explore provider. Spacetime
  // reuses the highest-resolution GIBS parent without changing terrain LOD.
  const detailSource = mode === 'spacetime' ? $('src').value : sourceKey();
  const maxZoom = Math.min(MAX_ZOOM, IMAGE_SOURCES[detailSource].maxZoom);
  const selected = selectFrontier({
    roots,
    inView: tileInView,
    request: requestTile, // Pin ancestors for fallback and immediate zoom-out.
    score: tile => {
      const distance = Math.max(view.range * 0.4, tile.center.distanceTo(cameraPosition) - tile.surfaceBound);
      const pixels = tile.size * pixelFactor / distance;
      tile.split = tile.ready && shouldRefine({
        z: tile.z, land: tile.land, pixels, threshold, wasSplit: tile.split, maxZoom,
      });
      return tile.split ? pixels / threshold : 0;
    },
    children: visibleChildren,
  });
  visible.length = 0;
  visible.push(...selected);
}

function groundAt(lat, lng, candidates = visible) {
  const x = (lng + Math.PI) / (2 * Math.PI);
  const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI);
  let best = null;
  for (const tile of candidates) {
    if (!tile.ready || !tile.height) continue;
    const scale = 2 ** tile.z;
    if (x * scale >= tile.x && x * scale < tile.x + 1 && y * scale >= tile.y && y * scale < tile.y + 1 && (!best || tile.z > best.z)) best = tile;
  }
  if (!best) return null;
  const scale = 2 ** best.z;
  const fx = (x * scale - best.x) * S;
  const fy = (y * scale - best.y) * S;
  const i = Math.min(S - 1, fx | 0);
  const j = Math.min(S - 1, fy | 0);
  const a = fx - i;
  const b = fy - j;
  const width = S + 1;
  const height = best.height;
  const interpolated = (
    (height[j * width + i] * (1 - a) + height[j * width + i + 1] * a) * (1 - b)
    + (height[(j + 1) * width + i] * (1 - a) + height[(j + 1) * width + i + 1] * a) * b
  );
  return (($('flat').checked && interpolated < 0) ? 0 : interpolated) * (+$('ex').value / 1000);
}

const wrapLongitude = (value) => ((value + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;

function cancelFlight() {
  flight = null;
}

function beginFlight(lat, lng, range = LOCAL_VIEW_RANGE) {
  groundHeight = 0;
  const from = ll2v(view.lat, view.lng);
  const to = ll2v(lat, lng);
  const angle = Math.acos(clamp(from.dot(to), -1, 1));
  flight = {
    elapsed: 0,
    duration: clamp(1.4 + angle * R / 3500, 1.4, 3.4),
    distance: angle * R,
    fromRange: view.range,
    fromHeading: view.heading,
    fromTilt: view.tilt,
    fromVector: from,
    toVector: to,
    toLat: lat,
    toLng: lng,
    toRange: range,
    toHeading: 0,
    toTilt: 1.08,
  };
}

function updateNavigation(deltaTime) {
  if (!flight) return;
  flight.elapsed += deltaTime;
  const linear = clamp(flight.elapsed / flight.duration, 0, 1);
  const eased = linear * linear * (3 - 2 * linear);
  const arc = Math.sin(Math.PI * eased);
  const angle = Math.acos(clamp(flight.fromVector.dot(flight.toVector), -1, 1));

  // Move along the surface of the globe instead of linearly through longitude.
  if (angle < 1e-5) {
    view.lat = flight.toLat;
    view.lng = flight.toLng;
  } else {
    const sinAngle = Math.sin(angle);
    const point = flight.fromVector.clone().multiplyScalar(Math.sin((1 - eased) * angle) / sinAngle)
      .addScaledVector(flight.toVector, Math.sin(eased * angle) / sinAngle)
      .normalize();
    view.lat = Math.asin(clamp(point.y, -1, 1));
    view.lng = Math.atan2(-point.z, point.x);
  }

  // Briefly pull back on long flights, then arrive at a useful local view.
  const baseRange = Math.exp(THREE.MathUtils.lerp(Math.log(flight.fromRange), Math.log(flight.toRange), eased));
  const peakRange = Math.max(flight.fromRange, flight.toRange, flight.distance * 0.75);
  view.range = clamp(baseRange * Math.max(1, peakRange / Math.max(baseRange, 0.6)) ** arc, 0.6, 30000);
  view.heading = THREE.MathUtils.lerp(flight.fromHeading, flight.toHeading, eased);
  view.tilt = THREE.MathUtils.lerp(flight.fromTilt, flight.toTilt, eased);

  if (linear >= 1) {
    view.lat = flight.toLat;
    view.lng = flight.toLng;
    view.range = flight.toRange;
    view.heading = flight.toHeading;
    view.tilt = flight.toTilt;
    cancelFlight();
  }
}

function pan(dx, dy) {
  const metersPerPixel = 2 * view.range * Math.tan(camera.fov * D2R / 2) / innerHeight;
  const cosHeading = Math.cos(view.heading);
  const sinHeading = Math.sin(view.heading);
  const right = -dx * metersPerPixel;
  const forward = (dy * metersPerPixel) / Math.max(Math.cos(view.tilt), 0.25);
  view.lat = clamp(view.lat + (-right * sinHeading + forward * cosHeading) / R, -85 * D2R, 85 * D2R);
  view.lng += (right * cosHeading + forward * sinHeading) / (R * Math.cos(view.lat));
  view.lng = ((view.lng + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
}

const canvas = renderer.domElement;
let drag = null;
const touchPoints = new Map();
let touchGesture = null;
const touchDistance = (points) => Math.hypot(points[1].clientX - points[0].clientX, points[1].clientY - points[0].clientY);
const touchAngle = (points) => Math.atan2(points[1].clientY - points[0].clientY, points[1].clientX - points[0].clientX);
const touchMidpoint = (points) => ({
  x: (points[0].clientX + points[1].clientX) / 2,
  y: (points[0].clientY + points[1].clientY) / 2,
});
const angleDelta = (current, previous) => Math.atan2(Math.sin(current - previous), Math.cos(current - previous));

canvas.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'touch') {
    touchPoints.set(event.pointerId, event);
    if (touchPoints.size === 2) {
      const points = [...touchPoints.values()];
      touchGesture = { distance: touchDistance(points), angle: touchAngle(points), midpoint: touchMidpoint(points) };
      drag = null;
    } else {
      drag = {
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        rotate: false,
      };
    }
    canvas.setPointerCapture(event.pointerId);
    cancelFlight();
    return;
  }
  drag = {
    x: event.clientX,
    y: event.clientY,
    startX: event.clientX,
    startY: event.clientY,
    rotate: mode === 'stargaze' || event.button === 2 || event.shiftKey || event.ctrlKey,
  };
  canvas.setPointerCapture(event.pointerId);
  cancelFlight();
});
canvas.addEventListener('pointermove', (event) => {
  if (event.pointerType === 'touch') {
    if (!touchPoints.has(event.pointerId)) return;
    touchPoints.set(event.pointerId, event);
    if (touchPoints.size === 2) {
      const points = [...touchPoints.values()];
      const distance = touchDistance(points);
      const angle = touchAngle(points);
      const midpoint = touchMidpoint(points);
      if (touchGesture) {
        if (mode === 'stargaze') {
          skyView.fov = clamp(skyView.fov * touchGesture.distance / Math.max(distance, 1), 18, 90);
          skyView.azimuth = wrapLongitude(skyView.azimuth + angleDelta(angle, touchGesture.angle));
          skyView.altitude = clamp(skyView.altitude + (midpoint.y - touchGesture.midpoint.y) * 0.004, -12 * D2R, 88 * D2R);
        } else {
          view.range = clamp(view.range * touchGesture.distance / Math.max(distance, 1), 0.6, 30000);
          pan(touchGesture.midpoint.x - midpoint.x, touchGesture.midpoint.y - midpoint.y);
          view.heading += angleDelta(angle, touchGesture.angle);
        }
      }
      touchGesture = { distance, angle, midpoint };
      return;
    }
    if (touchPoints.size !== 1) return;
    if (!drag) {
      drag = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, rotate: false };
    }
  }
  if (!drag) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  drag.x = event.clientX;
  drag.y = event.clientY;
  if (mode === 'stargaze') {
    skyView.azimuth = wrapLongitude(skyView.azimuth + dx * 0.004);
    skyView.altitude = clamp(skyView.altitude + dy * 0.004, -12 * D2R, 88 * D2R);
  } else if (drag.rotate) {
    view.heading += dx * 0.005;
    view.tilt = clamp(view.tilt + dy * 0.005, 0.02, 1.45);
  } else {
    pan(dx, dy);
  }
});
canvas.addEventListener('pointerup', (event) => {
  if (event.pointerType === 'touch') {
    touchPoints.delete(event.pointerId);
    if (mode === 'stargaze' && drag && touchPoints.size === 0 && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) {
      pickStar(event.clientX, event.clientY);
    }
    if (touchPoints.size < 2) touchGesture = null;
    if (touchPoints.size === 1) {
      const remaining = [...touchPoints.values()][0];
      drag = { x: remaining.clientX, y: remaining.clientY, startX: remaining.clientX, startY: remaining.clientY, rotate: false };
    } else {
      drag = null;
    }
    return;
  }
  if (mode === 'stargaze' && drag && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) {
    pickStar(event.clientX, event.clientY);
  }
  drag = null;
});
canvas.addEventListener('pointercancel', (event) => {
  if (event.pointerType === 'touch') touchPoints.delete(event.pointerId);
  drag = null;
  touchGesture = null;
});
canvas.addEventListener('lostpointercapture', (event) => {
  if (event.pointerType === 'touch') touchPoints.delete(event.pointerId);
  drag = null;
  touchGesture = null;
});
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  cancelFlight();
  if (mode === 'stargaze') skyView.fov = clamp(skyView.fov * Math.exp(event.deltaY * 0.001), 18, 90);
  else view.range = clamp(view.range * Math.exp(event.deltaY * 0.0012), 0.6, 30000);
}, { passive: false });
canvas.addEventListener('dblclick', () => {
  cancelFlight();
  if (mode === 'stargaze') skyView.fov = clamp(skyView.fov * 0.65, 18, 90);
  else view.range = clamp(view.range * 0.5, 0.6, 30000);
});
addEventListener('keydown', (event) => {
  if (['INPUT', 'SELECT', 'BUTTON'].includes(document.activeElement?.tagName)) return;
  if (mode === 'stargaze' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    if (event.key === 'ArrowLeft') skyView.azimuth -= 5 * D2R;
    if (event.key === 'ArrowRight') skyView.azimuth += 5 * D2R;
    if (event.key === 'ArrowUp') skyView.altitude = clamp(skyView.altitude + 5 * D2R, -12 * D2R, 88 * D2R);
    if (event.key === 'ArrowDown') skyView.altitude = clamp(skyView.altitude - 5 * D2R, -12 * D2R, 88 * D2R);
    event.preventDefault();
    return;
  }
  if (event.key === '+' || event.key === '=') {
    cancelFlight();
    if (mode === 'stargaze') skyView.fov = clamp(skyView.fov * 0.7, 18, 90);
    else view.range = clamp(view.range * 0.7, 0.6, 30000);
  } else if (event.key === '-' || event.key === '_') {
    cancelFlight();
    if (mode === 'stargaze') skyView.fov = clamp(skyView.fov / 0.7, 18, 90);
    else view.range = clamp(view.range / 0.7, 0.6, 30000);
  } else if (event.key === 'ArrowLeft') {
    cancelFlight();
    pan(-innerWidth * 0.08, 0);
  } else if (event.key === 'ArrowRight') {
    cancelFlight();
    pan(innerWidth * 0.08, 0);
  } else if (event.key === 'ArrowUp') {
    cancelFlight();
    pan(0, -innerHeight * 0.08);
  } else if (event.key === 'ArrowDown') {
    cancelFlight();
    pan(0, innerHeight * 0.08);
  } else {
    return;
  }
  event.preventDefault();
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  stars.material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
});

/* ---------- sun, sky and atmosphere ---------- */
const sunDirection = new THREE.Vector3();
const moonGeocentric = new THREE.Vector3();
const moonTopocentric = new THREE.Vector3();
const background = new THREE.Color();
const projectionScratch = new THREE.Vector3();
const AU_KM = 149597870.7;
const SUN_RADIUS_KM = 695700;
const MOON_RADIUS_KM = 1737.4;
let sunEphemeris = null;
let moonEphemeris = null;
let astronomySidereal = 0;
const riseSetCache = new Map();
let dailyEvents = null;
let riseSetContext = '';
let riseSetTimer = 0;
let riseSetController = null;

function currentRiseSetContext() {
  return `${$('sky-date').value}:${(view.lat / D2R).toFixed(3)}:${(view.lng / D2R).toFixed(3)}`;
}

function sunTimelineGradient(sun, polarState) {
  if (polarState === 'alwaysUp') return '#83b6d3';
  if (polarState === 'alwaysDown') return '#070b16';
  const boundaries = [0, 1440, ...[
    sun['Begin Civil Twilight'], sun.Rise, sun.Set, sun['End Civil Twilight'],
  ].map(timeToMinutes).filter(Number.isFinite)].sort((a, b) => a - b);
  const colors = {
    Night: '#070b16',
    'Morning twilight': '#7b4f5c',
    Daylight: '#83b6d3',
    'Evening twilight': '#704655',
  };
  const stops = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const color = colors[daylightState(sun, (start + end) / 2)];
    stops.push(`${color} ${(start / 14.4).toFixed(2)}%`, `${color} ${(end / 14.4).toFixed(2)}%`);
  }
  return `linear-gradient(to right, ${stops.join(',')})`;
}

function renderDailyEvents() {
  const minute = ((+$('tod').value * 60) % 1440 + 1440) % 1440;
  $('sun-track').style.setProperty('--now', `${minute / 14.4}%`);
  if (!dailyEvents) return;
  const sun = phenomenaByName(dailyEvents.sundata);
  const moon = phenomenaByName(dailyEvents.moondata);
  const state = dailyEvents.polarState === 'alwaysUp'
    ? 'Polar daylight'
    : (dailyEvents.polarState === 'alwaysDown' ? 'Polar night' : daylightState(sun, minute));
  const next = nextPhenomenon(sun, minute);
  $('sun-state').textContent = state;
  $('sun-next').textContent = next ? `Next: ${next.name.replace('Begin Civil Twilight', 'Dawn').replace('End Civil Twilight', 'Dusk')} ${next.time}` : 'No horizon crossing';
  $('sun-track').style.background = sunTimelineGradient(sun, dailyEvents.polarState);
  $('sun-track').setAttribute('aria-label', `${state}. Sunrise ${sun.Rise || 'none'}, sunset ${sun.Set || 'none'}, UTC.`);
  for (const [id, label, time] of [
    ['jump-sunrise', 'Sunrise', sun.Rise],
    ['jump-sunset', 'Sunset', sun.Set],
  ]) {
    const button = $(id);
    button.disabled = !time;
    button.dataset.time = time || '';
    button.querySelector('span').textContent = `${label} ${time || '—'}`;
  }
  const moonBits = [dailyEvents.curphase, dailyEvents.fracillum, moon.Rise && `↑ ${moon.Rise}`, moon.Set && `↓ ${moon.Set}`].filter(Boolean);
  $('moon-events').textContent = moonBits.length ? `Moon · ${moonBits.join(' · ')} UTC` : 'Moon schedule unavailable offline';
  $('sun-source').textContent = dailyEvents.source === 'usno'
    ? `USNO Astronomical Applications API ${dailyEvents.apiversion || ''} · UTC`
    : 'Local solar fallback · USNO unavailable';
}

async function loadDailyEvents(context) {
  const [date, latText, lngText] = context.split(':');
  const latitude = +latText;
  const longitude = +lngText;
  const fallback = calculateSolarEvents(date, latitude * D2R, longitude * D2R);
  dailyEvents = { ...fallback, moondata: [], source: 'fallback' };
  renderDailyEvents();
  if (riseSetCache.has(context)) {
    dailyEvents = riseSetCache.get(context);
    renderDailyEvents();
    return;
  }
  riseSetController?.abort();
  riseSetController = new AbortController();
  const requestController = riseSetController;
  const timeout = setTimeout(() => requestController.abort(), 10000);
  try {
    const response = await fetch(usnoOneDayUrl(date, latitude, longitude), {
      signal: requestController.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (result.error || !result.properties?.data) throw new Error(result.error || 'Invalid USNO response');
    const events = {
      ...result.properties.data,
      polarState: fallback.polarState,
      apiversion: result.apiversion,
      source: 'usno',
    };
    riseSetCache.set(context, events);
    if (context === riseSetContext) {
      dailyEvents = events;
      renderDailyEvents();
    }
  } catch (error) {
    if (error.name !== 'AbortError') console.warn('USNO Sun/Moon schedule unavailable:', error);
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleDailyEvents(force = false) {
  const context = currentRiseSetContext();
  if (!force && context === riseSetContext) return;
  riseSetContext = context;
  clearTimeout(riseSetTimer);
  riseSetTimer = setTimeout(() => loadDailyEvents(context), force ? 0 : 350);
}

function observationDate() {
  const day = $('sky-date')?.value || new Date().toISOString().slice(0, 10);
  const midnight = Date.parse(`${day}T00:00:00Z`);
  return new Date(midnight + (+$('tod').value || 0) * 3600000);
}

function setObservationControls(date) {
  $('sky-date').value = date.toISOString().slice(0, 10);
  $('tod').value = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
}

function updateSun() {
  const date = observationDate();
  const sun = sunEquatorial(date);
  const moon = moonEquatorial(date);
  const sidereal = greenwichMeanSiderealTime(date);
  sunEphemeris = sun;
  moonEphemeris = moon;
  astronomySidereal = sidereal;
  sunDirection.copy(ll2v(sun.dec, sun.ra - sidereal));
  moonGeocentric.copy(ll2v(moon.dec, moon.ra - sidereal, moon.distanceKm));
  sunU.value.copy(sunDirection);
  sunL.position.copy(sunDirection).multiplyScalar(10);
  stars.rotation.y = -sidereal;
  stars.updateMatrixWorld();
  milkyWay.rotation.y = -sidereal;
  milkyWay.updateMatrixWorld();
  updateMilkyWay(date);
  updateStarEpoch(date);
  updateSelectedStar();
  renderDailyEvents();
  const hour = +$('tod').value;
  const minutes = Math.round(hour * 60) % 1440;
  $('tl').textContent = `Sun ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} UTC`;
}

function updateCelestialBodies() {
  if (!sunEphemeris || !moonEphemeris) return;
  const renderDistance = camera.far * 0.994;
  const sunAngularRadius = apparentAngularDiameter(SUN_RADIUS_KM, sunEphemeris.distanceAu * AU_KM) / 2;
  sunBody.position.copy(sunDirection).multiplyScalar(renderDistance);
  sunBody.scale.setScalar(Math.tan(sunAngularRadius) * renderDistance);

  // The Moon's parallax is large enough to matter. Subtract the actual virtual
  // camera position from its geocentric ECEF position before projecting it.
  moonGeocentric.copy(ll2v(
    moonEphemeris.dec,
    moonEphemeris.ra - astronomySidereal,
    moonEphemeris.distanceKm,
  ));
  moonTopocentric.copy(moonGeocentric).sub(cameraPosition);
  const moonDistance = moonTopocentric.length();
  const moonDirection = moonTopocentric.normalize();
  const moonAngularRadius = apparentAngularDiameter(MOON_RADIUS_KM, moonDistance) / 2;
  moonBody.position.copy(moonDirection).multiplyScalar(renderDistance);
  moonBody.scale.setScalar(Math.tan(moonAngularRadius) * renderDistance);
  moonSunU.value.copy(sunDirection);
  moonDirectionU.value.copy(moonDirection);
}

function updateSelectedStar() {
  if (selectedStar < 0 || !starEquatorial[selectedStar]) return;
  const star = starCatalog[selectedStar];
  const horizontal = equatorialToHorizontal(
    starEquatorial[selectedStar].ra,
    starEquatorial[selectedStar].dec,
    observationDate(),
    view.lat,
    view.lng,
  );
  $('sky-object-name').textContent = `${commonStarName(star)} · HR ${star.HR}`;
  $('sky-object-details').textContent = [
    `m ${Number.parseFloat(star.Vmag).toFixed(2)}`,
    star.SpectralCls ? `spectral ${star.SpectralCls}` : null,
    `alt ${degrees(horizontal.altitude).toFixed(1)}°`,
    `az ${degrees(horizontal.azimuth).toFixed(1)}°`,
  ].filter(Boolean).join(' · ');
  $('sky-object').hidden = false;
}

function pickStar(clientX, clientY) {
  if (!starCatalog.length) return;
  const positions = stars.geometry.getAttribute('position');
  const rect = canvas.getBoundingClientRect();
  let closest = -1;
  let closestDistance = 18 * 18;
  for (let i = 0; i < positions.count; i += 1) {
    projectionScratch.fromBufferAttribute(positions, i).applyMatrix4(stars.matrixWorld).project(camera);
    if (projectionScratch.z < -1 || projectionScratch.z > 1) continue;
    const x = rect.left + (projectionScratch.x + 1) * rect.width / 2;
    const y = rect.top + (1 - projectionScratch.y) * rect.height / 2;
    const distance = (x - clientX) ** 2 + (y - clientY) ** 2;
    if (distance < closestDistance) {
      closest = i;
      closestDistance = distance;
    }
  }
  selectedStar = closest;
  $('sky-object').hidden = closest < 0;
  updateSelectedStar();
}

function updateEnvironment() {
  const altitude = Math.max(0, cameraPosition.length() - R - groundHeight);
  const atmosphere = Math.exp(-altitude / 40);
  const daylightOverride = mode === 'explore' && $('daylight').checked;
  const lightingSun = daylightOverride ? cameraUnit : sunDirection;
  sunU.value.copy(lightingSun);
  sunL.position.copy(lightingSun).multiplyScalar(10);
  const day = daylightOverride ? 1 : THREE.MathUtils.smoothstep(cameraUnit.dot(sunDirection), -0.12, 0.25);
  background.setRGB(0.36, 0.58, 0.9).multiplyScalar(atmosphere * day);
  scene.background.copy(background);
  scene.fog.color.copy(background);
  scene.fog.density = atmosphere * day * 0.003;
  fadeU.value = THREE.MathUtils.smoothstep(altitude, 20, 600);
  visU.value = 1 - atmosphere * day;
  hemi.intensity = 0.25 + 0.15 * day;
}

/* ---------- UI ---------- */
const setCredit = () => {
  const key = sourceKey();
  const provider = key === 'gibs' ? 'NASA GIBS' : (key === 'eox' ? 'EOX' : 'Esri');
  $('credit-label').textContent = `© ${provider} · Mapzen · OSM ↗`;
  $('credit').innerHTML = `Heights: Mapzen Terrarium (AWS) · ${IMAGE_SOURCES[key].credit} · Sun/Moon events: <a href="https://aa.usno.navy.mil/data/api" target="_blank" rel="noopener">USNO Astronomical Applications</a> · Stars: Yale Bright Star Catalogue (BSC5) · Milky Way: ESO/S. Brunier · Search: © OpenStreetMap contributors`;
};

function refreshImagery() {
  imageryRevision += 1;
  gibsImageCache.clear();
  for (const tile of tiles.values()) {
    tile.retryAt = 0;
    tile.controller?.abort();
  }
  setCredit();
}

setCredit();
$('src').onchange = refreshImagery;
$('ex').oninput = () => rebuildAll();
$('flat').onchange = () => rebuildAll();
$('tod').oninput = updateSun;
$('sky-date').onchange = () => {
  updateSun();
  scheduleDailyEvents(true);
};
$('sky-now').onclick = () => {
  setObservationControls(new Date());
  updateSun();
  scheduleDailyEvents(true);
};
for (const id of ['jump-sunrise', 'jump-sunset']) $(id).onclick = event => {
  const minutes = timeToMinutes(event.currentTarget.dataset.time);
  if (minutes === null) return;
  $('tod').value = minutes / 60;
  updateSun();
};

const firstGibsDay = isoToDay(GIBS_START_DATE);
const lastGibsDay = isoToDay(previousUtcDate());

function formatSpacetimeDate(value) {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function syncSpacetimeDate() {
  $('spacetime-date').value = spacetimeDate;
  $('spacetime-label').textContent = formatSpacetimeDate(spacetimeDate);
}

function setSpacetimeDate(value) {
  const day = clampDay(isoToDay(value), firstGibsDay, lastGibsDay);
  if (!Number.isFinite(day)) return;
  const next = dayToIso(day);
  const changed = next !== spacetimeDate;
  spacetimeDate = next;
  syncSpacetimeDate();
  if (mode === 'spacetime') {
    $('sky-date').value = spacetimeDate;
    updateSun();
    scheduleDailyEvents(true);
  }
  if (changed && mode === 'spacetime') {
    for (const tile of tiles.values()) replaceTileTexture(tile, blackTile);
    refreshImagery();
  }
}

function setMode(nextMode) {
  if (mode === nextMode) return;
  const previousMode = mode;
  if (nextMode === 'spacetime') nonSpacetimeObservationDay = $('sky-date').value;
  mode = nextMode;
  const isSpacetime = mode === 'spacetime';
  const isStargazing = mode === 'stargaze';
  if (isSpacetime) {
    // Never leave Explore imagery visible while the dated NASA tiles load.
    for (const tile of tiles.values()) replaceTileTexture(tile, blackTile);
    $('sky-date').value = spacetimeDate;
    updateSun();
  } else if (previousMode === 'spacetime' && nonSpacetimeObservationDay) {
    $('sky-date').value = nonSpacetimeObservationDay;
    updateSun();
  }
  $('sky-date').disabled = isSpacetime;
  $('sky-now').disabled = isSpacetime;
  document.body.classList.toggle('spacetime-mode', isSpacetime);
  document.body.classList.toggle('stargaze-mode', isStargazing);
  $('spacetime').hidden = !isSpacetime;
  $('mode-explore').classList.toggle('active', mode === 'explore');
  $('mode-spacetime').classList.toggle('active', isSpacetime);
  $('mode-stargaze').classList.toggle('active', isStargazing);
  $('mode-explore').setAttribute('aria-pressed', String(mode === 'explore'));
  $('mode-spacetime').setAttribute('aria-pressed', String(isSpacetime));
  $('mode-stargaze').setAttribute('aria-pressed', String(isStargazing));
  $('view-mode-label').textContent = isStargazing
    ? 'STARGAZING FROM HERE'
    : (isSpacetime ? 'EXPLORING SPACETIME' : 'EXPLORING EARTH');
  if (!isStargazing) {
    selectedStar = -1;
    $('sky-object').hidden = true;
  }
  scheduleDailyEvents(true);
  refreshImagery();
}

$('mode-explore').onclick = () => setMode('explore');
$('mode-spacetime').onclick = () => setMode('spacetime');
$('mode-stargaze').onclick = () => {
  skyView.azimuth = view.heading;
  skyView.altitude = 25 * D2R;
  setMode('stargaze');
};
$('spacetime-date').min = GIBS_START_DATE;
$('spacetime-date').max = dayToIso(lastGibsDay);
$('spacetime-form').onsubmit = event => {
  event.preventDefault();
  setSpacetimeDate($('spacetime-date').value);
};
syncSpacetimeDate();

const geocodeCache = new Map();
let lastGeocodeRequest = 0;
async function geocode(query) {
  const key = query.toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  const wait = lastGeocodeRequest + 1100 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastGeocodeRequest = Date.now();
  let results = [];
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    results = (await response.json()).map((hit) => ({ name: hit.display_name, lat: +hit.lat, lng: +hit.lon }));
  } catch (error) {
    console.warn('Nominatim failed:', error);
  }
  if (!results.length) {
    try {
      const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&format=json&name=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      results = (data.results || []).map((hit) => ({
        name: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', '),
        lat: hit.latitude,
        lng: hit.longitude,
      }));
    } catch (error) {
      console.warn('Open-Meteo geocoding failed:', error);
    }
  }
  if (results.length) geocodeCache.set(key, results);
  return results;
}

function flyTo(hit) {
  beginFlight(clamp(hit.lat, -84, 84) * D2R, wrapLongitude(hit.lng * D2R), LOCAL_VIEW_RANGE);
  $('place').textContent = hit.name.split(',').slice(0, 2).join(',').trim();
  if (mode !== 'stargaze' && !$('cyc').checked) {
    $('tod').value = (((14 - hit.lng / 15) % 24) + 24) % 24;
    updateSun();
  }
}

setupUI({
  search: geocode,
  flyTo,
  zoom: factor => {
    cancelFlight();
    if (mode === 'stargaze') skyView.fov = clamp(skyView.fov * factor, 18, 90);
    else view.range = clamp(view.range * factor, 0.6, 30000);
  },
  north: () => {
    cancelFlight();
    if (mode === 'stargaze') skyView.azimuth = 0;
    else view.heading = 0;
  },
  home: () => {
    cancelFlight();
    setMode('explore');
    Object.assign(view, INITIAL_VIEW);
    groundHeight = 0;
    $('place').textContent = 'A world to discover';
  },
});

/* ---------- main loop ---------- */
resetTiles();
setObservationControls(new Date());
updateSun();
scheduleDailyEvents(true);
loadStarCatalog();
loadMilkyWay();
$('place').textContent = 'A world to discover';
const clock = new THREE.Clock();
if (import.meta.env.DEV && new URLSearchParams(location.search).has('debug')) {
  window.earthvizStats = () => ({
    frame, cached: tiles.size, visible: visible.length, active, queued: queue.length,
    triangles: renderer.info.render.triangles,
    deferredElevation: visible.filter(tile => tile.demDeferred).length,
    maxZoom: Math.max(0, ...visible.map(tile => tile.z)),
    maxGrid: Math.max(0, ...visible.map(tile => tile.segments)),
    imagery: { mode, source: sourceKey(), date: mode === 'spacetime' ? spacetimeDate : null, revision: imageryRevision },
    celestial: {
      sunDistanceAu: sunEphemeris?.distanceAu,
      moonDistanceKm: moonEphemeris ? moonGeocentric.distanceTo(cameraPosition) : null,
      moonIlluminated: moonEphemeris?.illuminatedFraction,
      sunDiameterDegrees: sunEphemeris ? degrees(apparentAngularDiameter(SUN_RADIUS_KM, sunEphemeris.distanceAu * AU_KM)) : null,
      moonDiameterDegrees: moonEphemeris ? degrees(apparentAngularDiameter(MOON_RADIUS_KM, moonGeocentric.distanceTo(cameraPosition))) : null,
    },
    view: { ...view },
    tiles: visible.map(tile => ({ key: tile.key, land: tile.land, grid: tile.segments })),
  });
}
renderer.setAnimationLoop(() => {
  const deltaTime = Math.min(clock.getDelta(), 0.1);
  frame += 1;
  if ($('cyc').checked) {
    const next = new Date(observationDate().getTime() + deltaTime * 0.8 * 3600000);
    if (mode === 'spacetime') {
      $('tod').value = (next.getUTCHours() + next.getUTCMinutes() / 60 + next.getUTCSeconds() / 3600) % 24;
    } else setObservationControls(next);
    updateSun();
  }
  updateNavigation(deltaTime);
  frameCamera();
  updateCelestialBodies();
  selectTiles();
  updateGeometry();
  pumpQueue();
  evictTiles();
  const ground = groundAt(view.lat, view.lng);
  if (ground !== null) groundHeight += (ground - groundHeight) * 0.15;
  for (const tile of tiles.values()) if (tile.mesh) tile.mesh.visible = false;
  for (const tile of visible) {
    tile.mesh.visible = true;
    tile.mesh.position.copy(tile.center).sub(cameraPosition);
  }
  back.position.copy(cameraPosition).negate();
  atm.position.copy(cameraPosition).negate();
  updateEnvironment();
  renderer.render(scene, camera);
  if (frame % 8 === 0) {
    scheduleDailyEvents();
    if (mode === 'stargaze' && selectedStar >= 0) updateSelectedStar();
    $('compass-needle').style.transform = `rotate(${-(mode === 'stargaze' ? skyView.azimuth : view.heading)}rad)`;
    const imageryPending = visible.some(tile => tile.imageryRevision !== imageryRevision);
    const maxVisibleZoom = Math.max(0, ...visible.map(tile => tile.z));
    const spacetimeReady = maxVisibleZoom <= GIBS_NATIVE_MAX_ZOOM
      ? 'Dated MODIS imagery ready'
      : 'Dated 30 m HLS imagery ready';
    const loadingMessage = mode === 'stargaze'
      ? starStatus
      : mode === 'spacetime' && imageryPending
      ? `Loading ${formatSpacetimeDate(spacetimeDate)}…`
      : (active + queue.length ? 'Refining your view…' : (mode === 'spacetime' ? spacetimeReady : 'Ready to explore'));
    if ($('loading-state').textContent !== loadingMessage) $('loading-state').textContent = loadingMessage;
    const altitude = cameraPosition.length() - R - groundHeight;
    $('hud').textContent = mode === 'stargaze'
      ? `${(view.lat / D2R).toFixed(3)}°, ${(view.lng / D2R).toFixed(3)}° · az ${degrees(skyView.azimuth < 0 ? skyView.azimuth + 2 * Math.PI : skyView.azimuth).toFixed(1)}° · alt ${degrees(skyView.altitude).toFixed(1)}° · ${observationDate().toISOString().slice(0, 16).replace('T', ' ')} UTC`
      : `${(view.lat / D2R).toFixed(3)}°, ${(view.lng / D2R).toFixed(3)}° · ${altitude > 2 ? `${Math.round(altitude)} km` : `${Math.round(altitude * 1000)} m`} above the surface`;
  }
});