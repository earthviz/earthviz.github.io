import * as THREE from 'three';
import { setupUI } from './ui.js';
import { FALLBACK_INSET_KM, LIMITS, selectFrontier, takeNext, terrainSegments, shouldRefine } from './lod.js';

const R = 6371;
const S = 32; // Elevation sampling grid; rendered geometry is independently adaptive.
const T = 256;
const MAX_ZOOM = 15;
const D2R = Math.PI / 180;
const MAX_TILES = LIMITS.tiles;
const MAX_QUEUE = LIMITS.queued;
const MAX_CONCURRENT_LOADS = LIMITS.concurrent;
const TILE_REQUEST_TIMEOUT = 12000;
const $ = (id) => document.getElementById(id);
const clamp = THREE.MathUtils.clamp;
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
};

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

const starPositions = [];
const starSizes = [];
for (let i = 0; i < 2500; i += 1) {
  const v = new THREE.Vector3().randomDirection();
  starPositions.push(v.x, v.y, v.z);
  starSizes.push(1 + Math.random() * 2.2);
}
const starGeometry = new THREE.BufferGeometry();
starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
starGeometry.setAttribute('size', new THREE.Float32BufferAttribute(starSizes, 1));
const stars = new THREE.Points(
  starGeometry,
  new THREE.ShaderMaterial({
    uniforms: { uVis: visU },
    transparent: true,
    depthWrite: false,
    fog: false,
    vertexShader: `
      attribute float size;
      void main() {
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = p.xyww;
        gl_PointSize = size;
      }
    `,
    fragmentShader: `
      uniform float uVis;
      void main() {
        float a = smoothstep(0.5, 0.1, length(gl_PointCoord - 0.5));
        gl_FragColor = vec4(vec3(1.0), a * uVis);
      }
    `,
  }),
);
stars.frustumCulled = false;
stars.renderOrder = -1;
scene.add(stars);

/* ---------- tiles ---------- */
const tiles = new Map();
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

async function loadTile(tile) {
  tile.loading = true;
  tile.controller = new AbortController();
  const signal = tile.controller.signal;
  active += 1;
  const requestedGeneration = generation;
  const fetchElevation = needsElevation(tile);
  try {
    const [dem, image] = await Promise.all([
    fetchElevation ? loadImage(DEM(tile.z, tile.x, tile.y), signal) : null,
    tile.mesh?.material.map?.image || loadImage(IMAGE_SOURCES[$('src').value].fn(tile.z, tile.x, tile.y), signal),
    ]);
    if (requestedGeneration !== generation || signal.aborted) return;
    if (!image) { tile.retryAt = performance.now() + 15000; return; }
    // Decode/build at most one completed tile per animation frame.
    await new Promise((resolve) => commits.push({ tile, resolve }));
    if (requestedGeneration !== generation || signal.aborted) return;

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
    color: image ? 0xffffff : 0x5a6b5a,
  });
  if (image) {
    const texture = new THREE.Texture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
    texture.needsUpdate = true;
    material.map = texture;
  }
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
  if ((!tile.ready || (tile.demDeferred && needsElevation(tile))) && !tile.loading && !tile.queued && performance.now() >= tile.retryAt && queue.length < MAX_QUEUE) {
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
  camera.far = cameraPosition.length() + R + 200;
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
  const maxZoom = Math.min(MAX_ZOOM, IMAGE_SOURCES[$('src').value].maxZoom);
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
canvas.addEventListener('pointerdown', (event) => {
  drag = { x: event.clientX, y: event.clientY, rotate: event.button === 2 || event.shiftKey || event.ctrlKey };
  canvas.setPointerCapture(event.pointerId);
  cancelFlight();
});
canvas.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  drag.x = event.clientX;
  drag.y = event.clientY;
  if (drag.rotate) {
    view.heading += dx * 0.005;
    view.tilt = clamp(view.tilt + dy * 0.005, 0.02, 1.45);
  } else {
    pan(dx, dy);
  }
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('pointercancel', () => { drag = null; });
canvas.addEventListener('lostpointercapture', () => { drag = null; });
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  cancelFlight();
  view.range = clamp(view.range * Math.exp(event.deltaY * 0.0012), 0.6, 30000);
}, { passive: false });
canvas.addEventListener('dblclick', () => {
  cancelFlight();
  view.range = clamp(view.range * 0.5, 0.6, 30000);
});
addEventListener('keydown', (event) => {
  if (['INPUT', 'SELECT', 'BUTTON'].includes(document.activeElement?.tagName)) return;
  if (event.key === '+' || event.key === '=') {
    cancelFlight();
    view.range = clamp(view.range * 0.7, 0.6, 30000);
  } else if (event.key === '-' || event.key === '_') {
    cancelFlight();
    view.range = clamp(view.range / 0.7, 0.6, 30000);
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
});

/* ---------- sun, sky and atmosphere ---------- */
const sunDirection = new THREE.Vector3();
const background = new THREE.Color();
function updateSun() {
  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 864e5);
  const hour = +$('tod').value;
  const declination = 23.44 * D2R * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365);
  sunDirection.copy(ll2v(declination, -(hour - 12) * 15 * D2R));
  sunU.value.copy(sunDirection);
  sunL.position.copy(sunDirection).multiplyScalar(10);
  const minutes = Math.round(hour * 60) % 1440;
  $('tl').textContent = `Sun ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} UTC`;
}

function updateEnvironment() {
  const altitude = Math.max(0, cameraPosition.length() - R - groundHeight);
  const atmosphere = Math.exp(-altitude / 40);
  const day = THREE.MathUtils.smoothstep(cameraUnit.dot(sunDirection), -0.12, 0.25);
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
  $('credit-label').textContent = `© ${$('src').value === 'eox' ? 'EOX' : 'Esri'} · Mapzen · OSM ↗`;
  $('credit').innerHTML = `Heights: Mapzen Terrarium (AWS) · ${IMAGE_SOURCES[$('src').value].credit} · Search: © OpenStreetMap contributors`;
};
setCredit();
$('src').onchange = () => {
  setCredit();
  resetTiles();
};
$('ex').oninput = () => rebuildAll();
$('flat').onchange = () => rebuildAll();
$('tod').oninput = updateSun;

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
  if (!$('cyc').checked) {
    $('tod').value = (((14 - hit.lng / 15) % 24) + 24) % 24;
    updateSun();
  }
}

setupUI({
  search: geocode,
  flyTo,
  zoom: factor => { cancelFlight(); view.range = clamp(view.range * factor, 0.6, 30000); },
  north: () => { cancelFlight(); view.heading = 0; },
  home: () => {
    cancelFlight();
    Object.assign(view, INITIAL_VIEW);
    groundHeight = 0;
    $('place').textContent = 'A world to discover';
  },
});

/* ---------- main loop ---------- */
resetTiles();
updateSun();
$('place').textContent = 'A world to discover';
const clock = new THREE.Clock();
if (import.meta.env.DEV && new URLSearchParams(location.search).has('debug')) {
  window.earthvizStats = () => ({
    frame, cached: tiles.size, visible: visible.length, active, queued: queue.length,
    triangles: renderer.info.render.triangles,
    deferredElevation: visible.filter(tile => tile.demDeferred).length,
    maxZoom: Math.max(0, ...visible.map(tile => tile.z)),
    maxGrid: Math.max(0, ...visible.map(tile => tile.segments)),
    view: { ...view },
    tiles: visible.map(tile => ({ key: tile.key, land: tile.land, grid: tile.segments })),
  });
}
renderer.setAnimationLoop(() => {
  const deltaTime = Math.min(clock.getDelta(), 0.1);
  frame += 1;
  if ($('cyc').checked) {
    $('tod').value = (+$('tod').value + deltaTime * 0.8) % 24;
    updateSun();
  }
  updateNavigation(deltaTime);
  frameCamera();
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
    $('compass-needle').style.transform = `rotate(${-view.heading}rad)`;
    const loadingMessage = active + queue.length ? 'Refining your view…' : 'Ready to explore';
    if ($('loading-state').textContent !== loadingMessage) $('loading-state').textContent = loadingMessage;
    const altitude = cameraPosition.length() - R - groundHeight;
    $('hud').textContent = `${(view.lat / D2R).toFixed(3)}°, ${(view.lng / D2R).toFixed(3)}° · ${altitude > 2 ? `${Math.round(altitude)} km` : `${Math.round(altitude * 1000)} m`} above the surface`;
  }
});
