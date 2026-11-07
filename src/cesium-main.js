import '@cesium/engine/Source/Widget/CesiumWidget.css';
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  HeadingPitchRange,
  JulianDate,
} from '@cesium/core';
import {
  BillboardCollection,
  CameraEventType,
  CesiumWidget,
  KeyboardEventModifier,
  PointPrimitiveCollection,
  SunLight,
} from '@cesium/engine';
import { setupUI } from './ui.js';
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
} from './astronomy.js';
import {
  daylightState,
  nextPhenomenon,
  phenomenaByName,
  timeToMinutes,
  usnoOneDayUrl,
} from './solar-flow.js';
import {
  GIBS_DAILY_SOURCES,
  GIBS_NATIVE_MAX_ZOOM,
  clampDay,
  dayToIso,
  isoToDay,
  previousUtcDate,
} from './spacetime.js';
import { apparentSolarAltitude, horizonDip, solarPhase } from './sky-model.js';
import { TerrariumTerrainProvider } from './cesium/terrarium-terrain-provider.js';
import { DEFAULT_EXPLORE_IMAGERY, EXPLORE_IMAGERY, ImageryController } from './cesium/imagery.js';
import { OpenFreeMapOverlayController } from './cesium/openfreemap-overlay.js';
import {
  installGlobeTilePriority,
  usesNearestPriority,
} from './cesium/tile-priority.js';
import { normalizePlace, privacyFetch, readJson } from './security.js';

const $ = id => document.getElementById(id);
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const wrapRadians = value => ((value + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
const DETAIL_ERRORS = [8, 5, 3.25, 2, 1.25, 0.75];
const INITIAL_VIEW = { lat: 20 * D2R, lng: 0, height: 10_000_000, heading: 0, pitch: -90 * D2R };
const LOCAL_HEIGHT = 16_000;
const GLOBE_CENTERING_HEIGHT = 2_500_000;
const STAR_RADIUS = 500_000_000;
const BSC5_URL = new URL('../bsc5.json', import.meta.url);

let mode = 'explore';
let spacetimeDate = previousUtcDate();
let nonSpacetimeObservationDay = '';
let focus = { lat: INITIAL_VIEW.lat, lng: INITIAL_VIEW.lng };
let pendingTiles = 0;
let frame = 0;
let lastFrameTime = performance.now();
let adaptiveNearestUntil = 0;
let adaptiveNearest = false;
const previousPriorityPosition = new Cartesian3();
const previousPriorityDirection = new Cartesian3();
let hasPreviousPriorityCamera = false;
let localSun = { trueAltitude: 0, apparentAltitude: 0, horizonDip: 0, observerAltitude: 0 };
let atmosphereReadout = '';
let skyAzimuth = 0;
let skyAltitude = 25 * D2R;
let skyFov = 60 * D2R;
let stargazeDrag = null;
let starCatalog = [];
let starEquatorial = [];
let starPoints = null;
let selectedStar = -1;
let starEpochDay = '';
let starStatus = 'Loading the Bright Star Catalogue…';
let lastLiveTimeSecond = -1;
let moonBillboard = null;
let moonTextureSignature = '';
const overlayLoading = { buildings: false, roads: false };

const globeContainer = document.createElement('div');
globeContainer.id = 'earthviz-globe';
globeContainer.setAttribute('aria-label', 'Interactive 3D globe');
document.body.prepend(globeContainer);

let terrainProvider = new TerrariumTerrainProvider({
  flattenSea: $('flat').checked,
  maximumLevel: +$('terrain-zoom').value,
  gridSize: +$('terrain-mesh').value,
});
const widget = new CesiumWidget(globeContainer, {
  baseLayer: false,
  terrainProvider,
  scene3DOnly: true,
  useDefaultRenderLoop: false,
  shouldAnimate: false,
  msaaSamples: 4,
});
const { scene, camera, canvas } = widget;
const globe = scene.globe;
const imagery = new ImageryController(globe);
const cityOverlay = new OpenFreeMapOverlayController({
  scene,
  globe,
  terrainProvider,
  onStatus: ({ layer, kind, text }) => {
    overlayLoading[layer] = kind === 'loading';
    $(`overlay-${layer}-status`).dataset.kind = kind;
    $(`overlay-${layer}-status`).textContent = text;
  },
});
const tilePriorityPolicy = () => ({ mode: $('tile-priority').value, adaptiveNearest });
installGlobeTilePriority(globe, tilePriorityPolicy);
const naturalSun = new SunLight({ intensity: 2.7 });
scene.light = naturalSun;
const centerPixel = new Cartesian2();
const centerCartographic = new Cartographic();
const localUp = new Cartesian3();
const centeredPosition = new Cartesian3();
const centeredDirection = new Cartesian3();
const centeredUp = new Cartesian3();
let previousCenteringHeight = INITIAL_VIEW.height;

// Cesium's physical Moon is easy to lose against a black, skybox-free
// stargazing background. A screen-sized phase disc keeps its real angular
// position and apparent diameter legible at ordinary fields of view.
const moonBillboards = scene.primitives.add(new BillboardCollection({ scene }));
moonBillboard = moonBillboards.add({
  position: Cartesian3.fromRadians(0, 0, STAR_RADIUS),
  show: false,
  id: { kind: 'moon' },
});

globe.maximumScreenSpaceError = DETAIL_ERRORS[+$('det').value - 1];
globe.tileCacheSize = 320;
globe.preloadAncestors = true;
globe.preloadSiblings = false;
globe.showSkirts = true;
globe.showWaterEffect = false;
globe.enableLighting = true;
globe.dynamicAtmosphereLighting = true;
globe.dynamicAtmosphereLightingFromSun = true;
globe.depthTestAgainstTerrain = true;
scene.verticalExaggeration = +$('ex').value;
scene.fog.enabled = true;
const cameraController = scene.screenSpaceCameraController;
cameraController.enableInputs = true;
cameraController.enableRotate = true;
cameraController.enableTranslate = true;
cameraController.enableZoom = true;
cameraController.enableTilt = true;
cameraController.enableLook = true;
cameraController.enableCollisionDetection = true;
cameraController.minimumZoomDistance = 2;
cameraController.maximumZoomDistance = 100_000_000;
cameraController.zoomFactor = 3;
cameraController.maximumMovementRatio = 0.2;
cameraController.inertiaSpin = 0.82;
cameraController.inertiaTranslate = 0.82;
cameraController.inertiaZoom = 0.72;
// Surface navigation and camera orientation have deliberately separate inputs:
// left pans the globe, right orbits the picked point, and middle/Shift looks.
cameraController.rotateEventTypes = CameraEventType.LEFT_DRAG;
cameraController.zoomEventTypes = [CameraEventType.WHEEL, CameraEventType.PINCH];
cameraController.tiltEventTypes = [
  CameraEventType.RIGHT_DRAG,
  CameraEventType.PINCH,
  { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.CTRL },
];
cameraController.lookEventTypes = [
  CameraEventType.MIDDLE_DRAG,
  { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.SHIFT },
];
canvas.addEventListener('contextmenu', event => event.preventDefault());

const pressedCameraKeys = new Set();
const cameraKeyCodes = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract',
  'ShiftLeft', 'ShiftRight',
]);

function isTypingTarget(target) {
  return target instanceof Element
    && (target.matches('input, textarea, select, button') || target.closest('[contenteditable="true"]'));
}

document.addEventListener('keydown', event => {
  if (!cameraKeyCodes.has(event.code) || event.ctrlKey || event.metaKey || isTypingTarget(event.target)) return;
  pressedCameraKeys.add(event.code);
  event.preventDefault();
});
document.addEventListener('keyup', event => pressedCameraKeys.delete(event.code));
window.addEventListener('blur', () => pressedCameraKeys.clear());

function updateKeyboardCamera(deltaSeconds) {
  if (!pressedCameraKeys.size) return;
  const accelerated = pressedCameraKeys.has('ShiftLeft') || pressedCameraKeys.has('ShiftRight');
  const speedMultiplier = accelerated ? 4 : 1;

  if (mode === 'stargaze') {
    const lookStep = deltaSeconds * 0.9 * speedMultiplier;
    const zoomStep = Math.exp(deltaSeconds * 1.5 * speedMultiplier);
    let changed = false;
    if (pressedCameraKeys.has('ArrowLeft') || pressedCameraKeys.has('KeyA')) { skyAzimuth += lookStep; changed = true; }
    if (pressedCameraKeys.has('ArrowRight') || pressedCameraKeys.has('KeyD')) { skyAzimuth -= lookStep; changed = true; }
    if (pressedCameraKeys.has('ArrowUp') || pressedCameraKeys.has('KeyW')) { skyAltitude += lookStep; changed = true; }
    if (pressedCameraKeys.has('ArrowDown') || pressedCameraKeys.has('KeyS')) { skyAltitude -= lookStep; changed = true; }
    if (pressedCameraKeys.has('Equal') || pressedCameraKeys.has('NumpadAdd')) { skyFov /= zoomStep; changed = true; }
    if (pressedCameraKeys.has('Minus') || pressedCameraKeys.has('NumpadSubtract')) { skyFov *= zoomStep; changed = true; }
    if (changed) {
      skyAzimuth = wrapRadians(skyAzimuth);
      skyAltitude = clamp(skyAltitude, -12 * D2R, 88 * D2R);
      skyFov = clamp(skyFov, 18 * D2R, 90 * D2R);
      setStargazeCamera();
    }
    return;
  }

  const movement = clamp(Math.max(cameraHeight(), 20) * 0.75, 8, 6_000_000)
    * deltaSeconds * speedMultiplier;
  const lookStep = deltaSeconds * 0.8 * speedMultiplier;
  const zoomStep = Math.max(4, cameraHeight() * deltaSeconds * 0.8 * speedMultiplier);
  if (pressedCameraKeys.has('KeyW')) camera.moveForward(movement);
  if (pressedCameraKeys.has('KeyS')) camera.moveBackward(movement);
  if (pressedCameraKeys.has('KeyA')) camera.moveLeft(movement);
  if (pressedCameraKeys.has('KeyD')) camera.moveRight(movement);
  if (pressedCameraKeys.has('KeyQ')) camera.moveDown(movement);
  if (pressedCameraKeys.has('KeyE')) camera.moveUp(movement);
  if (pressedCameraKeys.has('ArrowLeft')) camera.lookLeft(lookStep);
  if (pressedCameraKeys.has('ArrowRight')) camera.lookRight(lookStep);
  if (pressedCameraKeys.has('ArrowUp')) camera.lookUp(lookStep);
  if (pressedCameraKeys.has('ArrowDown')) camera.lookDown(lookStep);
  if (pressedCameraKeys.has('Equal') || pressedCameraKeys.has('NumpadAdd')) camera.zoomIn(zoomStep);
  if (pressedCameraKeys.has('Minus') || pressedCameraKeys.has('NumpadSubtract')) camera.zoomOut(zoomStep);
}
imagery.showExplore($('src').value);

globe.tileLoadProgressEvent.addEventListener(length => {
  pendingTiles = length;
});

function cameraHeight() {
  return Math.max(0, camera.positionCartographic?.height || 0);
}

function keepGlobeCenteredWhileZoomingOut() {
  const height = cameraHeight();
  const zoomingOut = height > previousCenteringHeight * 1.0001;
  previousCenteringHeight = height;
  if (mode === 'stargaze' || !zoomingOut || height < GLOBE_CENTERING_HEIGHT) return;

  Cartesian3.clone(camera.positionWC, centeredPosition);
  Cartesian3.negate(centeredPosition, centeredDirection);
  Cartesian3.normalize(centeredDirection, centeredDirection);
  Cartesian3.cross(camera.rightWC, centeredDirection, centeredUp);
  if (Cartesian3.magnitudeSquared(centeredUp) < 1e-12) return;
  Cartesian3.normalize(centeredUp, centeredUp);
  camera.setView({
    destination: centeredPosition,
    orientation: { direction: centeredDirection, up: centeredUp },
  });
}

function updateAdaptiveTilePriority(now, deltaSeconds) {
  const position = camera.positionWC;
  const direction = camera.directionWC;
  if (hasPreviousPriorityCamera && deltaSeconds > 0) {
    const positionSpeed = Cartesian3.distance(position, previousPriorityPosition)
      / Math.max(cameraHeight(), 100) / deltaSeconds;
    const directionDot = clamp(Cartesian3.dot(direction, previousPriorityDirection), -1, 1);
    const angularSpeed = Math.acos(directionDot) / deltaSeconds;
    if (positionSpeed > 0.08 || angularSpeed > 0.12) adaptiveNearestUntil = now + 450;
  }
  Cartesian3.clone(position, previousPriorityPosition);
  Cartesian3.clone(direction, previousPriorityDirection);
  hasPreviousPriorityCamera = true;

  adaptiveNearest = now < adaptiveNearestUntil;
  cityOverlay.setNearestPriority(usesNearestPriority($('tile-priority').value, adaptiveNearest));
}

function setInitialCamera() {
  camera.setView({
    destination: Cartesian3.fromRadians(INITIAL_VIEW.lng, INITIAL_VIEW.lat, INITIAL_VIEW.height),
    orientation: {
      heading: INITIAL_VIEW.heading,
      pitch: INITIAL_VIEW.pitch,
      roll: 0,
    },
  });
}

function flyToCoordinates(lat, lng, height = LOCAL_HEIGHT) {
  focus = { lat, lng };
  const cartographic = Cartographic.fromRadians(lng, lat);
  const ground = globe.getHeight(cartographic) || 0;
  const target = Cartesian3.fromRadians(lng, lat, ground);
  const pitch = -48 * D2R;
  camera.flyToBoundingSphere(new BoundingSphere(target, 0), {
    offset: new HeadingPitchRange(0, pitch, height / -Math.sin(pitch)),
    duration: 2.2,
  });
}

function updateFocusFromView() {
  if (mode === 'stargaze' || canvas.clientWidth === 0 || canvas.clientHeight === 0) return;
  centerPixel.x = canvas.clientWidth / 2;
  centerPixel.y = canvas.clientHeight / 2;
  const ray = camera.getPickRay(centerPixel);
  const surface = ray && globe.pick(ray, scene);
  if (!surface) return;
  Cartographic.fromCartesian(surface, globe.ellipsoid, centerCartographic);
  focus.lat = centerCartographic.latitude;
  focus.lng = centerCartographic.longitude;
}

function setStargazeCamera() {
  const ground = globe.getHeight(Cartographic.fromRadians(focus.lng, focus.lat)) || 0;
  camera.setView({
    destination: Cartesian3.fromRadians(focus.lng, focus.lat, ground + 2),
    orientation: { heading: skyAzimuth, pitch: skyAltitude, roll: 0 },
  });
  if ('fov' in camera.frustum) camera.frustum.fov = skyFov;
  updateMoon(observationDate());
}

function replaceTerrain() {
  terrainProvider = new TerrariumTerrainProvider({
    flattenSea: $('flat').checked,
    maximumLevel: +$('terrain-zoom').value,
    gridSize: +$('terrain-mesh').value,
  });
  widget.terrainProvider = terrainProvider;
  cityOverlay.setTerrainProvider(terrainProvider);
}

function setCredit() {
  const key = $('src').value;
  const definition = EXPLORE_IMAGERY[key] ?? EXPLORE_IMAGERY[DEFAULT_EXPLORE_IMAGERY];
  const provider = mode === 'spacetime' ? 'NASA GIBS' : definition.provider;
  const showsOpenFreeMap = $('overlay-buildings').checked || $('overlay-roads').checked;
  $('credit-label').textContent = `© ${provider} · Mapzen · OSM${showsOpenFreeMap ? ' · OpenFreeMap' : ''} ↗`;
  const daily = GIBS_DAILY_SOURCES[$('spacetime-source').value] ?? GIBS_DAILY_SOURCES['modis-terra'];
  const imageryCredit = mode === 'spacetime'
    ? `NASA EOSDIS GIBS · ${daily.label} and HLS Landsat/Sentinel detail`
    : definition.credit;
  const credit = $('credit');
  const externalLink = (label, href) => {
    const link = document.createElement('a');
    link.textContent = label;
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  };
  credit.replaceChildren(document.createTextNode(`Heights: Mapzen Terrarium (AWS) · ${imageryCredit}`));
  if (showsOpenFreeMap) {
    credit.append(' · Vector detail: ', externalLink('OpenFreeMap', 'https://openfreemap.org/'), ' © OpenMapTiles · Data from © OpenStreetMap contributors');
  }
  credit.append(' · Sun/Moon events: ', externalLink('USNO Astronomical Applications', 'https://aa.usno.navy.mil/data/api'), ' · Stars: Yale Bright Star Catalogue (BSC5) · Search: © OpenStreetMap contributors');
  $('esri-attribution').hidden = mode !== 'explore' || key !== 'esri';
  $('esri-use-note').hidden = mode !== 'explore' || key !== 'esri';
}

function refreshImagery() {
  if (mode === 'spacetime') imagery.showSpacetime(spacetimeDate, $('spacetime-source').value);
  else imagery.showExplore($('src').value);
  setCredit();
}

/* ---------- time, lighting, and daily events ---------- */
const riseSetCache = new Map();
let dailyEvents = null;
let riseSetContext = '';
let riseSetTimer = 0;
let riseSetController = null;

function observationDate() {
  const day = $('sky-date')?.value || new Date().toISOString().slice(0, 10);
  return new Date(Date.parse(`${day}T00:00:00Z`) + (+$('tod').value || 0) * 3_600_000);
}

function setObservationControls(date) {
  $('sky-date').value = date.toISOString().slice(0, 10);
  $('tod').value = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
}

function liveTimeEnabled() {
  return mode !== 'spacetime' && $('live-time').checked;
}

function syncTimeControlState() {
  const live = liveTimeEnabled();
  $('sky-date').disabled = mode === 'spacetime' || live;
  $('tod').disabled = live;
}

function syncToCurrentTime(force = false) {
  if (!liveTimeEnabled()) return;
  const now = new Date();
  const second = Math.floor(now.getTime() / 1000);
  if (!force && second === lastLiveTimeSecond) return;
  lastLiveTimeSecond = second;
  setObservationControls(now);
  updateSun();
}

function currentRiseSetContext() {
  return `${$('sky-date').value}:${(focus.lat * R2D).toFixed(3)}:${(focus.lng * R2D).toFixed(3)}`;
}

function sunTimelineGradient(sun, polarState) {
  if (polarState === 'alwaysUp') return '#83b6d3';
  if (polarState === 'alwaysDown') return '#070b16';
  const boundaries = [0, 1440, ...[
    sun['Begin Civil Twilight'], sun.Rise, sun.Set, sun['End Civil Twilight'],
  ].map(timeToMinutes).filter(Number.isFinite)].sort((a, b) => a - b);
  const colors = { Night: '#070b16', 'Morning twilight': '#7b4f5c', Daylight: '#83b6d3', 'Evening twilight': '#704655' };
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
  for (const [id, label, time] of [['jump-sunrise', 'Sunrise', sun.Rise], ['jump-sunset', 'Sunset', sun.Set]]) {
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
  const timeout = setTimeout(() => requestController.abort(), 10_000);
  try {
    const response = await privacyFetch(usnoOneDayUrl(date, latitude, longitude), {
      signal: requestController.signal,
      headers: { Accept: 'application/json' },
    });
    const result = await readJson(response, 128_000);
    if (result.error || !result.properties?.data) throw new Error(result.error || 'Invalid USNO response');
    const events = { ...result.properties.data, polarState: fallback.polarState, apiversion: result.apiversion, source: 'usno' };
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

function createMoonPhaseTexture(illuminatedFraction, waxing) {
  const size = 128;
  const canvasTexture = document.createElement('canvas');
  canvasTexture.width = size;
  canvasTexture.height = size;
  const context = canvasTexture.getContext('2d');
  const pixels = context.createImageData(size, size);
  const separation = Math.acos(clamp(1 - 2 * illuminatedFraction, -1, 1));
  const sunX = (waxing ? -1 : 1) * Math.sin(separation);
  const sunZ = -Math.cos(separation);
  const radius = size * 0.39;
  const center = size / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5 - center) / radius;
      const ny = (center - y - 0.5) / radius;
      const radialSquared = nx * nx + ny * ny;
      if (radialSquared > 1.04) continue;
      const edgeAlpha = clamp((1.04 - radialSquared) / 0.04, 0, 1);
      const nz = Math.sqrt(Math.max(0, 1 - radialSquared));
      const incidence = nx * sunX + nz * sunZ;
      const maria = 0.91 + 0.06 * Math.sin(nx * 17 + ny * 9) * Math.sin(ny * 21 - nx * 5);
      const brightness = incidence > 0 ? (0.38 + 0.62 * incidence) * maria : 0.025;
      const offset = (y * size + x) * 4;
      pixels.data[offset] = 226 * brightness;
      pixels.data[offset + 1] = 232 * brightness;
      pixels.data[offset + 2] = 225 * brightness;
      pixels.data[offset + 3] = 255 * edgeAlpha;
    }
  }
  context.putImageData(pixels, 0, 0);
  return canvasTexture;
}

function updateMoon(date) {
  if (!moonBillboard) return;
  const moon = moonEquatorial(date);
  const sun = sunEquatorial(date);
  const sidereal = greenwichMeanSiderealTime(date);
  moonBillboard.position = Cartesian3.fromRadians(moon.ra - sidereal, moon.dec, STAR_RADIUS);

  const waxing = Math.sin(sun.ra - moon.ra) > 0;
  const signature = `${Math.round(moon.illuminatedFraction * 100)}:${waxing}`;
  if (signature !== moonTextureSignature) {
    moonTextureSignature = signature;
    moonBillboard.image = createMoonPhaseTexture(moon.illuminatedFraction, waxing);
  }

  const angularDiameter = apparentAngularDiameter(1737.4, moon.distanceKm);
  const verticalFov = camera.frustum.fovy || camera.frustum.fov || skyFov;
  const diameterPixels = clamp(angularDiameter / verticalFov * canvas.clientHeight, 14, 64);
  moonBillboard.width = diameterPixels;
  moonBillboard.height = diameterPixels;
  moonBillboard.show = mode === 'stargaze';
}

function updateStars(date) {
  if (!starCatalog.length || !starPoints) return;
  const day = date.toISOString().slice(0, 10);
  if (day !== starEpochDay) {
    starEpochDay = day;
    starEquatorial = starCatalog.map(star => catalogEquatorial(star, date));
  }
  const sidereal = greenwichMeanSiderealTime(date);
  for (let i = 0; i < starEquatorial.length; i += 1) {
    const star = starEquatorial[i];
    starPoints.get(i).position = Cartesian3.fromRadians(star.ra - sidereal, star.dec, STAR_RADIUS);
  }
}

function updateSun() {
  const date = observationDate();
  widget.clock.currentTime = JulianDate.fromDate(date);
  updateMoon(date);
  updateStars(date);
  renderDailyEvents();
  const minutes = Math.round((+$('tod').value || 0) * 60) % 1440;
  $('tl').textContent = `Sun ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} UTC`;
}

function updateEnvironment() {
  const date = observationDate();
  const sun = sunEquatorial(date);
  const sidereal = greenwichMeanSiderealTime(date);
  const sunDirection = Cartesian3.fromRadians(sun.ra - sidereal, sun.dec, 0, globe.ellipsoid, new Cartesian3());
  Cartesian3.normalize(sunDirection, sunDirection);
  const surface = Cartesian3.fromRadians(focus.lng, focus.lat, 0, globe.ellipsoid, localUp);
  globe.ellipsoid.geodeticSurfaceNormal(surface, localUp);
  const observerAltitudeKm = cameraHeight() / 1000;
  const density = Math.exp(-observerAltitudeKm / 8.5);
  const trueAltitude = Math.asin(clamp(Cartesian3.dot(localUp, sunDirection), -1, 1));
  const apparentAltitude = apparentSolarAltitude(trueAltitude, density);
  const dip = horizonDip(observerAltitudeKm);
  localSun = { trueAltitude, apparentAltitude, horizonDip: dip, observerAltitude: observerAltitudeKm };

  const relativeAltitude = apparentAltitude + dip;
  const eyeHeight = observerAltitudeKm < 1
    ? `${Math.round(observerAltitudeKm * 1000)} m`
    : `${observerAltitudeKm < 100 ? observerAltitudeKm.toFixed(1) : Math.round(observerAltitudeKm)} km`;
  const relation = `${Math.abs(degrees(relativeAltitude)).toFixed(1)}° ${relativeAltitude >= 0 ? 'above' : 'below'} local horizon`;
  const dipText = degrees(dip) >= 0.05 ? ` · horizon ${degrees(dip).toFixed(1)}° lower at ${eyeHeight}` : ` · eye height ${eyeHeight}`;
  const next = `Sun ${relation} · ${solarPhase(trueAltitude)}${dipText}`;
  if (next !== atmosphereReadout) {
    atmosphereReadout = next;
    $('atmosphere-readout').textContent = next;
  }
}

/* ---------- stars and stargazing ---------- */
function commonStarName(star) {
  const names = star.Notes?.find(note => note.Category === 'Star names')?.Remark;
  if (names) return names.split(';')[0].trim().replace(/\.$/, '').toLowerCase()
    .replace(/(^|\s)\S/g, letter => letter.toUpperCase());
  return star.Name?.trim() || `HR ${star.HR}`;
}

function limitingMagnitude() {
  return 6.5 - (+$('pollution').value / 100) * 4.5;
}

function pollutionDescription(value) {
  if (value < 15) return 'Dark sky';
  if (value < 35) return 'Rural sky';
  if (value < 60) return 'Suburban sky';
  if (value < 82) return 'Bright suburban';
  return 'City sky';
}

function updatePollutionFilter() {
  const limit = limitingMagnitude();
  const level = +$('pollution').value;
  $('pollution-value').textContent = `${pollutionDescription(level)} · m ≤ ${limit.toFixed(1)}`;
  if (!starPoints) return;
  let visible = 0;
  for (let i = 0; i < starCatalog.length; i += 1) {
    const magnitude = Number.parseFloat(starCatalog[i].Vmag);
    const show = Number.isFinite(magnitude) && magnitude <= limit;
    starPoints.get(i).show = show;
    if (show) visible += 1;
  }
  if (selectedStar >= 0 && !starPoints.get(selectedStar).show) {
    selectedStar = -1;
    $('sky-object').hidden = true;
  }
  starStatus = `${visible.toLocaleString()} visible catalog stars · click a star to identify it`;
}

async function loadStarCatalog() {
  try {
    const response = await privacyFetch(BSC5_URL, { headers: { Accept: 'application/json' } });
    const catalog = await readJson(response, 5_000_000);
    if (!Array.isArray(catalog) || catalog.length > 10_000) throw new Error('Invalid star catalogue');
    starCatalog = catalog.filter(star => star && typeof star === 'object');
    starPoints = scene.primitives.add(new PointPrimitiveCollection());
    for (let i = 0; i < starCatalog.length; i += 1) {
      const magnitude = Number.parseFloat(starCatalog[i].Vmag);
      const [red, green, blue] = starRgb(starCatalog[i]);
      starPoints.add({
        position: Cartesian3.fromRadians(0, 0, STAR_RADIUS),
        pixelSize: clamp(1.15 + 2.7 * 10 ** (-0.2 * (Number.isFinite(magnitude) ? magnitude : 6)), 1.1, 8),
        color: new Color(red, green, blue, 1),
        id: { kind: 'star', index: i },
      });
    }
    starPoints.show = mode === 'stargaze';
    updateStars(observationDate());
    updatePollutionFilter();
  } catch (error) {
    console.error('Could not load bsc5.json:', error);
    starStatus = 'The Bright Star Catalogue could not be loaded';
  }
}

function updateSelectedStar() {
  if (selectedStar < 0 || !starEquatorial[selectedStar]) return;
  const star = starCatalog[selectedStar];
  const horizontal = equatorialToHorizontal(
    starEquatorial[selectedStar].ra,
    starEquatorial[selectedStar].dec,
    observationDate(),
    focus.lat,
    focus.lng,
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

function pickStar(event) {
  const rect = canvas.getBoundingClientRect();
  const picked = scene.pick(new Cartesian2(event.clientX - rect.left, event.clientY - rect.top));
  selectedStar = picked?.id?.kind === 'star' ? picked.id.index : -1;
  $('sky-object').hidden = selectedStar < 0;
  updateSelectedStar();
}

canvas.addEventListener('pointerdown', event => {
  if (mode !== 'stargaze') return;
  stargazeDrag = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
  if (mode !== 'stargaze' || !stargazeDrag) return;
  skyAzimuth = wrapRadians(skyAzimuth - (event.clientX - stargazeDrag.x) * 0.004);
  skyAltitude = clamp(skyAltitude + (stargazeDrag.y - event.clientY) * 0.004, -12 * D2R, 88 * D2R);
  stargazeDrag.x = event.clientX;
  stargazeDrag.y = event.clientY;
  setStargazeCamera();
});
canvas.addEventListener('pointerup', event => {
  if (mode === 'stargaze' && stargazeDrag && Math.hypot(event.clientX - stargazeDrag.startX, event.clientY - stargazeDrag.startY) < 6) pickStar(event);
  stargazeDrag = null;
});
canvas.addEventListener('wheel', event => {
  if (mode !== 'stargaze') return;
  event.preventDefault();
  skyFov = clamp(skyFov * Math.exp(event.deltaY * 0.001), 18 * D2R, 90 * D2R);
  setStargazeCamera();
}, { passive: false });

/* ---------- modes and controls ---------- */
const lastGibsDay = isoToDay(previousUtcDate());

function firstGibsDay() {
  const source = GIBS_DAILY_SOURCES[$('spacetime-source').value] ?? GIBS_DAILY_SOURCES['modis-terra'];
  return isoToDay(source.startDate);
}

function formatSpacetimeDate(value) {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function syncSpacetimeDate() {
  $('spacetime-date').value = spacetimeDate;
  $('spacetime-label').textContent = formatSpacetimeDate(spacetimeDate);
  renderSpacetimeDays();
}

function renderSpacetimeDays() {
  const selectedDay = isoToDay(spacetimeDate);
  const days = [];
  $('spacetime-days').replaceChildren();
  for (let offset = -15; offset <= 15; offset++) {
    const day = clampDay(selectedDay + offset, firstGibsDay(), lastGibsDay);
    if (days.includes(day)) continue;
    days.push(day);
    const iso = dayToIso(day);
    const date = new Date(`${iso}T12:00:00Z`);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'spacetime-day';
    button.dataset.date = iso;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(day === selectedDay));
    const weekday = document.createElement('small');
    const dayOfMonth = document.createElement('strong');
    const month = document.createElement('span');
    weekday.textContent = date.toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short' });
    dayOfMonth.textContent = String(date.getUTCDate());
    month.textContent = date.toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short' });
    button.append(weekday, dayOfMonth, month);
    button.onclick = () => setSpacetimeDate(iso);
    $('spacetime-days').append(button);
  }
  const active = $('spacetime-days').querySelector('[aria-selected="true"]');
  requestAnimationFrame(() => active?.scrollIntoView({ inline: 'center', block: 'nearest' }));
}

function setSpacetimeDate(value) {
  const day = clampDay(isoToDay(value), firstGibsDay(), lastGibsDay);
  if (!Number.isFinite(day)) return;
  const next = dayToIso(day);
  const changed = next !== spacetimeDate;
  spacetimeDate = next;
  syncSpacetimeDate();
  if (mode === 'spacetime') {
    $('sky-date').value = spacetimeDate;
    updateSun();
    scheduleDailyEvents(true);
    if (changed) refreshImagery();
  }
}

function setMode(nextMode) {
  if (mode === nextMode) return;
  const previousMode = mode;
  if (nextMode === 'spacetime') nonSpacetimeObservationDay = $('sky-date').value;
  if (previousMode === 'stargaze') scene.screenSpaceCameraController.enableInputs = true;
  mode = nextMode;
  const isSpacetime = mode === 'spacetime';
  const isStargazing = mode === 'stargaze';
  if (isSpacetime) {
    $('sky-date').value = spacetimeDate;
    updateSun();
  } else if (previousMode === 'spacetime' && nonSpacetimeObservationDay) {
    $('sky-date').value = nonSpacetimeObservationDay;
    updateSun();
  }
  if (isStargazing) {
    skyAzimuth = camera.heading;
    skyAltitude = 25 * D2R;
    scene.screenSpaceCameraController.enableInputs = false;
    setStargazeCamera();
  } else if (previousMode === 'stargaze') {
    flyToCoordinates(focus.lat, focus.lng);
  }
  if (starPoints) starPoints.show = isStargazing;
  moonBillboard.show = isStargazing;
  if (scene.moon) scene.moon.show = !isStargazing;
  if (scene.skyBox) scene.skyBox.show = !isStargazing;
  cityOverlay.setSuspended(isStargazing);
  syncTimeControlState();
  $('sky-now').disabled = isSpacetime;
  document.body.classList.toggle('spacetime-mode', isSpacetime);
  document.body.classList.toggle('stargaze-mode', isStargazing);
  document.body.classList.toggle('explore-mode', mode === 'explore');
  $('spacetime').hidden = !isSpacetime;
  for (const candidate of ['explore', 'spacetime', 'stargaze']) {
    const active = mode === candidate;
    $(`mode-${candidate}`).classList.toggle('active', active);
    $(`mode-${candidate}`).setAttribute('aria-pressed', String(active));
  }
  if (!isStargazing) {
    selectedStar = -1;
    $('sky-object').hidden = true;
  }
  refreshImagery();
  scheduleDailyEvents(true);
}

$('src').addEventListener('change', () => { if (mode !== 'spacetime') refreshImagery(); });
$('spacetime-source').addEventListener('change', () => {
  const minimum = GIBS_DAILY_SOURCES[$('spacetime-source').value].startDate;
  $('spacetime-date').min = minimum;
  const previousDate = spacetimeDate;
  setSpacetimeDate(spacetimeDate);
  if (mode === 'spacetime' && previousDate === spacetimeDate) refreshImagery();
});
for (const layer of ['buildings', 'roads']) {
  $(`overlay-${layer}`).addEventListener('change', () => {
    cityOverlay.setLayerEnabled(layer, $(`overlay-${layer}`).checked);
    cityOverlay.setSuspended(mode === 'stargaze');
    cityOverlay.update(focus, cameraHeight());
    setCredit();
  });
}
$('det').addEventListener('input', () => { globe.maximumScreenSpaceError = DETAIL_ERRORS[+$('det').value - 1]; });
$('tile-priority').addEventListener('change', () => {
  adaptiveNearestUntil = performance.now() + 450;
  updateAdaptiveTilePriority(performance.now(), 0);
});
$('terrain-zoom').addEventListener('change', replaceTerrain);
$('ex').addEventListener('input', () => { scene.verticalExaggeration = +$('ex').value; });
$('ex').addEventListener('change', () => cityOverlay.invalidateTerrain());
$('flat').addEventListener('change', replaceTerrain);
$('terrain-mesh').addEventListener('change', replaceTerrain);
$('tod').addEventListener('input', updateSun);
$('sky-date').addEventListener('change', () => { updateSun(); scheduleDailyEvents(true); });
$('pollution').addEventListener('input', updatePollutionFilter);
$('live-time').addEventListener('change', () => {
  if ($('live-time').checked) $('cyc').checked = false;
  syncTimeControlState();
  syncToCurrentTime(true);
  scheduleDailyEvents(true);
});
$('cyc').addEventListener('change', () => {
  if ($('cyc').checked) $('live-time').checked = false;
  syncTimeControlState();
});
$('sky-now').addEventListener('click', () => {
  $('live-time').checked = true;
  $('cyc').checked = false;
  syncTimeControlState();
  syncToCurrentTime(true);
  scheduleDailyEvents(true);
});
for (const id of ['jump-sunrise', 'jump-sunset']) $(id).addEventListener('click', event => {
  const minutes = timeToMinutes(event.currentTarget.dataset.time);
  if (minutes === null) return;
  $('live-time').checked = false;
  syncTimeControlState();
  $('tod').value = minutes / 60;
  updateSun();
});
$('mode-explore').onclick = () => setMode('explore');
$('mode-spacetime').onclick = () => setMode('spacetime');
$('mode-stargaze').onclick = () => setMode('stargaze');
$('spacetime-date').min = GIBS_DAILY_SOURCES[$('spacetime-source').value].startDate;
$('spacetime-date').max = dayToIso(lastGibsDay);
$('spacetime-form').onsubmit = event => { event.preventDefault(); setSpacetimeDate($('spacetime-date').value); };
$('spacetime-prev').onclick = () => setSpacetimeDate(dayToIso(isoToDay(spacetimeDate) - 1));
$('spacetime-next').onclick = () => setSpacetimeDate(dayToIso(isoToDay(spacetimeDate) + 1));
$('spacetime-minimize').onclick = () => {
  const minimized = $('spacetime').classList.toggle('minimized');
  $('spacetime-minimize').setAttribute('aria-expanded', String(!minimized));
  $('spacetime-minimize').setAttribute('aria-label', minimized ? 'Expand timeline' : 'Minimize timeline');
  $('spacetime-minimize').title = minimized ? 'Expand timeline' : 'Minimize timeline';
};

const geocodeCache = new Map();
let lastGeocodeRequest = 0;
async function geocode(query) {
  const safeQuery = query.trim().slice(0, 160);
  const key = safeQuery.toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  const wait = lastGeocodeRequest + 1100 - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastGeocodeRequest = Date.now();
  let results = [];
  try {
    const response = await privacyFetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(safeQuery)}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json' },
    });
    const data = await readJson(response);
    results = (Array.isArray(data) ? data : [])
      .map(hit => normalizePlace({ name: hit.display_name, lat: hit.lat, lng: hit.lon }))
      .filter(Boolean)
      .slice(0, 6);
  } catch (error) {
    console.warn('Nominatim failed:', error);
  }
  if (!results.length) {
    try {
      const response = await privacyFetch(`https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&format=json&name=${encodeURIComponent(safeQuery)}`, {
        signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/json' },
      });
      const data = await readJson(response);
      results = (Array.isArray(data.results) ? data.results : []).map(hit => normalizePlace({
        name: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', '),
        lat: hit.latitude,
        lng: hit.longitude,
      })).filter(Boolean).slice(0, 6);
    } catch (error) {
      console.warn('Open-Meteo geocoding failed:', error);
    }
  }
  if (results.length) geocodeCache.set(key, results);
  return results;
}

function flyTo(hit) {
  const lat = clamp(hit.lat, -84, 84) * D2R;
  const lng = wrapRadians(hit.lng * D2R);
  if (mode === 'stargaze') setMode('explore');
  flyToCoordinates(lat, lng);
  if (!$('cyc').checked) {
    $('tod').value = (((14 - hit.lng / 15) % 24) + 24) % 24;
    updateSun();
  }
}

setupUI({
  search: geocode,
  flyTo,
  zoom: factor => {
    if (mode === 'stargaze') {
      skyFov = clamp(skyFov * factor, 18 * D2R, 90 * D2R);
      setStargazeCamera();
      return;
    }
    const amount = Math.max(100, cameraHeight() * Math.abs(1 - factor));
    if (factor < 1) camera.zoomIn(amount);
    else camera.zoomOut(amount);
  },
  north: () => {
    if (mode === 'stargaze') {
      skyAzimuth = 0;
      setStargazeCamera();
    } else camera.setView({ orientation: { heading: 0, pitch: camera.pitch, roll: 0 } });
  },
  home: () => {
    setMode('explore');
    focus = { lat: INITIAL_VIEW.lat, lng: INITIAL_VIEW.lng };
    setInitialCamera();
  },
});

function updateHud() {
  $('spacetime-loading').hidden = mode !== 'spacetime' || pendingTiles === 0;
  $('spacetime-loading').textContent = pendingTiles > 0 ? 'Loading NASA GIBS tiles…' : '';
  $('compass-needle').style.transform = `rotate(${-camera.heading}rad)`;
}

if (import.meta.env.DEV && new URLSearchParams(location.search).has('debug')) {
  window.earthvizStats = () => ({
    renderer: 'cesium',
    frame,
    pendingTiles,
    tilesLoaded: globe.tilesLoaded,
    maximumScreenSpaceError: globe.maximumScreenSpaceError,
    tileLoadingPriority: {
      selected: $('tile-priority').value,
      effective: usesNearestPriority($('tile-priority').value, adaptiveNearest) ? 'nearest' : 'view-center',
    },
    tileCacheSize: globe.tileCacheSize,
    verticalExaggeration: scene.verticalExaggeration,
    waterEffect: globe.showWaterEffect,
    terrainWaterMask: terrainProvider.hasWaterMask,
    controls: {
      minimumZoomDistance: cameraController.minimumZoomDistance,
      maximumZoomDistance: cameraController.maximumZoomDistance,
      collisionDetection: cameraController.enableCollisionDetection,
    },
    imagery: { mode, source: mode === 'spacetime' ? $('spacetime-source').value : $('src').value, date: mode === 'spacetime' ? spacetimeDate : null },
    cityOverlay: cityOverlay.stats(),
    camera: { height: cameraHeight(), heading: camera.heading, pitch: camera.pitch },
    focus: { latitude: focus.lat * R2D, longitude: focus.lng * R2D },
  });
}

function animate(now) {
  const deltaSeconds = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;
  frame += 1;
  updateKeyboardCamera(deltaSeconds);
  keepGlobeCenteredWhileZoomingOut();
  updateAdaptiveTilePriority(now, deltaSeconds);
  if (liveTimeEnabled()) syncToCurrentTime();
  else if ($('cyc').checked) {
    const next = new Date(observationDate().getTime() + deltaSeconds * 0.8 * 3_600_000);
    if (mode === 'spacetime') $('tod').value = (next.getUTCHours() + next.getUTCMinutes() / 60 + next.getUTCSeconds() / 3600) % 24;
    else setObservationControls(next);
    updateSun();
  }
  widget.resize();
  if (frame % 8 === 0) {
    updateFocusFromView();
    cityOverlay.update(focus, cameraHeight());
    updateEnvironment();
    updateSelectedStar();
    scheduleDailyEvents();
    updateHud();
  }
  widget.render();
  requestAnimationFrame(animate);
}

setInitialCamera();
setCredit();
syncSpacetimeDate();
setObservationControls(new Date());
syncTimeControlState();
updateSun();
updateEnvironment();
scheduleDailyEvents(true);
loadStarCatalog();
requestAnimationFrame(animate);
