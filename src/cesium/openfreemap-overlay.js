import {
  ArcType,
  Cartesian3,
  Cartographic,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  PolygonGeometry,
  PolygonHierarchy,
  VerticalExaggeration,
} from '@cesium/core';
import {
  GroundPolylineGeometry,
  GroundPolylinePrimitive,
  PerInstanceColorAppearance,
  PolylineColorAppearance,
  Primitive,
  decodeMVT,
  sampleTerrain,
} from '@cesium/engine';
import {
  MIN_BUILDING_FOOTPRINT,
  OPENFREEMAP_TILE_ZOOM,
  OVERLAY_LAYERS,
  buildingHeightRange,
  groupPolygonRings,
  ringArea,
  roadRank,
  selectTop,
  tileDistanceToLocation,
  tilePointToRadians,
  tileWindow,
} from './openfreemap-geometry.js';
import { forEachSliced } from './time-slice.js';
import { privacyFetch, readArrayBuffer } from '../security.js';

const TILE_URL = 'https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf';
const MAX_CACHE_TILES = 36;
const MAX_FETCHES_PER_LAYER = 3;
const MAX_SHARED_FETCHES = 4;
const MAX_DECODED_TILES = 8;
const TERRAIN_SAMPLE_LEVEL = 13;
const REQUEST_TIMEOUT = 15_000;
const RETRY_DELAY = 20_000;
const MAX_TILE_BYTES = 2_000_000;
const BUILDING_BASE_OFFSET = 0.6;
// Opaque buildings are far cheaper to fill than blended ones. Flip this to
// bring the old 44% glass look back.
const BUILDING_TRANSLUCENT = false;
const BUILDING_COLOR = new Color(0.58, 0.61, 0.62, BUILDING_TRANSLUCENT ? 0.44 : 1);
const PENDING = ['queued', 'fetching', 'ready', 'building'];

function roadWidth(roadClass) {
  switch (roadClass) {
    case 'motorway': return 4;
    case 'trunk': return 3.5;
    case 'primary': return 3;
    case 'secondary': return 2.5;
    case 'tertiary': return 2;
    case 'minor': return 1.4;
    default: return 1;
  }
}

function roadColor(roadClass) {
  const major = ['motorway', 'trunk', 'primary'].includes(roadClass);
  return major
    ? new Color(0.86, 0.88, 0.87, 0.64)
    : new Color(0.72, 0.75, 0.74, 0.45);
}

function tileUrl(tile) {
  return TILE_URL
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
}

function samePoint(a, b) {
  return a.x === b.x && a.y === b.y;
}

function decodedLayer(decoded, name) {
  return decoded.layers.find(layer => layer.name === name);
}

function toRadiansRing(ring, tile, extent) {
  return ring.map(point => tilePointToRadians(point, tile.x, tile.y, tile.z, extent));
}

function frame() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

// Fetches and decodes each tile once, shared by the buildings and roads
// layers. Decoded tiles are kept in a small LRU so toggling a layer or
// panning back does not refetch. A queued request nobody wants is dropped.
class TileDataCache {
  constructor() {
    this.entries = new Map();
    this.waiting = [];
    this.active = 0;
    this.clock = 0;
  }

  acquire(tile) {
    let entry = this.entries.get(tile.key);
    if (!entry) {
      entry = { key: tile.key, tile, refs: 0, state: 'waiting', decoded: null, controller: null, lastUsed: 0 };
      entry.promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      entry.promise.catch(() => {});
      this.entries.set(tile.key, entry);
      this.waiting.push(entry);
    }
    entry.refs += 1;
    entry.lastUsed = ++this.clock;
    this._pump();
    let released = false;
    return {
      promise: entry.promise,
      release: () => {
        if (released) return;
        released = true;
        entry.refs -= 1;
        if (entry.refs === 0) this._unwanted(entry);
      },
    };
  }

  clear() {
    for (const entry of [...this.entries.values()]) {
      entry.controller?.abort();
      this.entries.delete(entry.key);
    }
    this.waiting.length = 0;
  }

  _unwanted(entry) {
    if (entry.state === 'waiting') {
      this.waiting = this.waiting.filter(candidate => candidate !== entry);
      this.entries.delete(entry.key);
      entry.reject(new Error('cancelled'));
    } else if (entry.state === 'loading') {
      entry.controller?.abort();
    } else if (entry.state === 'error') {
      this.entries.delete(entry.key);
    }
  }

  _pump() {
    while (this.active < MAX_SHARED_FETCHES && this.waiting.length) {
      const entry = this.waiting.shift();
      this.active += 1;
      void this._fetch(entry);
    }
  }

  async _fetch(entry) {
    entry.state = 'loading';
    entry.controller = new AbortController();
    const timeout = setTimeout(() => entry.controller.abort(), REQUEST_TIMEOUT);
    try {
      const response = await privacyFetch(tileUrl(entry.tile), {
        signal: entry.controller.signal,
        headers: { Accept: 'application/vnd.mapbox-vector-tile, application/x-protobuf, application/octet-stream' },
      });
      const buffer = await readArrayBuffer(response, MAX_TILE_BYTES);
      entry.decoded = decodeMVT(buffer);
      entry.state = 'done';
      entry.resolve(entry.decoded);
    } catch (error) {
      entry.state = 'error';
      entry.reject(error);
      if (entry.refs === 0) this.entries.delete(entry.key);
    } finally {
      clearTimeout(timeout);
      entry.controller = null;
      this.active -= 1;
      this._evict();
      this._pump();
    }
  }

  _evict() {
    const idle = [...this.entries.values()]
      .filter(entry => entry.state === 'done' && entry.refs === 0)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    while (idle.length > MAX_DECODED_TILES) this.entries.delete(idle.shift().key);
  }
}

// One overlay layer (buildings or roads). Each has its own window, altitude
// limit, queue and build slot, so the cheap layer is never held up by the
// expensive one. Per tile the pipeline is: fetch -> build in time slices ->
// add one primitive per frame.
class OverlayLayer {
  constructor(host, kind) {
    this.host = host;
    this.kind = kind;
    this.config = OVERLAY_LAYERS[kind];
    this.enabled = false;
    this.inRange = false;
    this.tiles = new Map();
    this.desired = new Set();
    this.fetching = 0;
    this.building = false;
    this.clock = 0;
    this.revision = 0;
    this.lastStatus = '';
  }

  get active() {
    return this.enabled && !this.host.suspended && this.inRange;
  }

  setEnabled(enabled) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.clear();
    this.syncVisibility();
    this.emitStatus();
  }

  setSuspended() {
    if (this.host.suspended) this._cancelPending();
    this.syncVisibility();
    this.pump();
    this.emitStatus();
  }

  invalidate() {
    this.revision += 1;
    this.clear();
    this.emitStatus();
  }

  update(focus, altitude) {
    const inRange = altitude <= this.config.maxAltitude;
    if (this.inRange !== inRange) {
      this.inRange = inRange;
      if (!inRange) this._cancelPending();
    }
    if (!this.active) {
      this.syncVisibility();
      this.emitStatus();
      return;
    }

    const wanted = tileWindow(focus.lng, focus.lat, {
      zoom: OPENFREEMAP_TILE_ZOOM,
      radius: this.config.radius,
    });
    this.desired = new Set(wanted.map(tile => tile.key));
    for (const record of [...this.tiles.values()]) {
      record.desired = this.desired.has(record.key);
      if (record.desired) record.lastUsed = ++this.clock;
      if (!record.desired && PENDING.includes(record.state)) this._discard(record);
      else this._setRecordShow(record, record.desired);
    }
    for (const tile of wanted) {
      let record = this.tiles.get(tile.key);
      if (!record) {
        record = {
          ...tile,
          state: 'queued',
          desired: true,
          lastUsed: ++this.clock,
          primitive: null,
          count: 0,
          retryAt: 0,
          cancelled: false,
          lease: null,
          decoded: null,
        };
        this.tiles.set(record.key, record);
      } else {
        record.distance = tile.distance;
        if (record.state === 'error' && Date.now() >= record.retryAt) {
          record.state = 'queued';
          record.cancelled = false;
        }
      }
    }
    this._evictCache();
    this.syncVisibility();
    this.pump();
    this.emitStatus();
  }

  clear() {
    for (const record of [...this.tiles.values()]) this._discard(record);
    this.tiles.clear();
    this.desired.clear();
  }

  stats() {
    const visible = [...this.tiles.values()].filter(record => record.desired && record.state === 'loaded');
    return {
      enabled: this.enabled,
      inRange: this.inRange,
      cachedTiles: this.tiles.size,
      visibleTiles: visible.length,
      pendingTiles: [...this.tiles.values()].filter(record => record.desired && PENDING.includes(record.state)).length,
      features: visible.reduce((sum, record) => sum + record.count, 0),
    };
  }

  isCurrent(record, revision) {
    return this.tiles.get(record.key) === record
      && record.desired
      && !record.cancelled
      && this.active
      && this.revision === revision;
  }

  pump() {
    if (!this.active) return;
    const nearest = state => [...this.tiles.values()]
      .filter(record => record.state === state && record.desired)
      .sort((a, b) => this.host.tilePriority(a) - this.host.tilePriority(b));

    for (const record of nearest('queued')) {
      if (this.fetching >= MAX_FETCHES_PER_LAYER) break;
      this._startFetch(record);
    }
    if (!this.building) {
      const [next] = nearest('ready');
      if (next) void this._build(next);
    }
  }

  _startFetch(record) {
    this.fetching += 1;
    record.state = 'fetching';
    record.lease = this.host.cache.acquire(record);
    record.lease.promise.then(
      (decoded) => {
        this.fetching -= 1;
        if (record.cancelled || this.tiles.get(record.key) !== record) return;
        record.decoded = decoded;
        record.state = 'ready';
        this.pump();
        this.emitStatus();
      },
      (error) => {
        this.fetching -= 1;
        if (!record.cancelled && this.tiles.get(record.key) === record) {
          record.state = 'error';
          record.retryAt = Date.now() + RETRY_DELAY;
          console.warn(`OpenFreeMap ${this.kind} tile failed:`, error);
        }
        record.lease = null;
        this.pump();
        this.emitStatus();
      },
    );
  }

  async _build(record) {
    const revision = this.revision;
    const isActive = () => this.isCurrent(record, revision);
    this.building = true;
    record.state = 'building';
    try {
      const decoded = record.decoded;
      record.decoded = null;
      const result = this.kind === 'buildings'
        ? await this._buildBuildings(decoded, record, isActive)
        : await this._buildRoads(decoded, record, isActive);
      if (!result || !isActive()) return;
      // One primitive per frame: GPU upload of consecutive tiles never lands
      // in the same frame.
      await this.host.commitSlot();
      if (!isActive()) return;
      record.primitive = this._addPrimitive(result.instances);
      record.count = result.instances.length;
      record.state = 'loaded';
      this._setRecordShow(record, true);
    } catch (error) {
      if (record.cancelled || this.tiles.get(record.key) !== record) return;
      record.state = 'error';
      record.retryAt = Date.now() + RETRY_DELAY;
      console.warn(`OpenFreeMap ${this.kind} build failed:`, error);
    } finally {
      record.lease?.release();
      record.lease = null;
      this.building = false;
      this.pump();
      this.emitStatus();
    }
  }

  _addPrimitive(instances) {
    if (!instances.length) return null;
    const { scene } = this.host;
    if (this.kind === 'buildings') {
      return scene.primitives.add(new Primitive({
        geometryInstances: instances,
        appearance: new PerInstanceColorAppearance({
          translucent: BUILDING_TRANSLUCENT,
          closed: true,
          flat: false,
        }),
        asynchronous: true,
        allowPicking: false,
        releaseGeometryInstances: true,
      }));
    }
    return scene.groundPrimitives.add(new GroundPolylinePrimitive({
      geometryInstances: instances,
      appearance: new PolylineColorAppearance({ translucent: true }),
      asynchronous: true,
      allowPicking: false,
      releaseGeometryInstances: true,
    }));
  }

  async _buildBuildings(decoded, tile, isActive) {
    const layer = decodedLayer(decoded, 'building');
    if (!layer) return { instances: [] };

    // 1. Rank candidates in tile space (cheap) and keep only the largest.
    const candidates = [];
    if (!await forEachSliced(layer.features, (feature) => {
      if (feature.type !== 'Polygon') return;
      if ([true, 1, 'true'].includes(feature.properties?.hide_3d)) return;
      for (const group of groupPolygonRings(feature.geometry)) {
        const area = ringArea(group.outerRing);
        if (area >= MIN_BUILDING_FOOTPRINT) candidates.push({ group, area, properties: feature.properties || {} });
      }
    }, { isActive })) return null;
    const kept = selectTop(candidates, this.config.maxPerTile, (a, b) => b.area - a.area);

    // 2. Project only the kept buildings to radians.
    const specs = [];
    if (!await forEachSliced(kept, ({ group, properties }) => {
      const outer = toRadiansRing(group.outerRing, tile, layer.extent);
      if (outer.length < 3) return;
      const holes = group.holes
        .map(ring => toRadiansRing(ring, tile, layer.extent))
        .filter(ring => ring.length >= 3);
      const center = { longitude: 0, latitude: 0 };
      for (const point of outer) {
        center.longitude += point.longitude;
        center.latitude += point.latitude;
      }
      center.longitude /= outer.length;
      center.latitude /= outer.length;
      specs.push({ outer, holes, center, properties, baseHeight: 0 });
    }, { isActive })) return null;

    // 3. Terrain base heights, then geometry instances.
    if (!await this._sampleBases(specs, isActive)) return null;
    const { scene } = this.host;
    const exaggeration = scene.verticalExaggeration;
    const relativeHeight = scene.verticalExaggerationRelativeHeight;
    const instances = [];
    if (!await forEachSliced(specs, (spec) => {
      const range = buildingHeightRange(spec.properties);
      const terrainBase = VerticalExaggeration.getHeight(spec.baseHeight, exaggeration, relativeHeight);
      const hierarchy = new PolygonHierarchy(
        spec.outer.map(point => Cartesian3.fromRadians(point.longitude, point.latitude)),
        spec.holes.map(ring => new PolygonHierarchy(
          ring.map(point => Cartesian3.fromRadians(point.longitude, point.latitude)),
        )),
      );
      instances.push(new GeometryInstance({
        geometry: new PolygonGeometry({
          polygonHierarchy: hierarchy,
          height: terrainBase + range.height,
          extrudedHeight: terrainBase + range.minimum + BUILDING_BASE_OFFSET,
          closeTop: true,
          closeBottom: false,
          arcType: ArcType.RHUMB,
          vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(BUILDING_COLOR) },
      }));
    }, { isActive })) return null;
    return { instances };
  }

  async _sampleBases(specs, isActive) {
    const missing = [];
    const { globe, terrainProvider } = this.host;
    if (!await forEachSliced(specs, (spec) => {
      const cartographic = new Cartographic(spec.center.longitude, spec.center.latitude);
      const loadedHeight = globe.getHeight(cartographic);
      if (Number.isFinite(loadedHeight)) spec.baseHeight = loadedHeight;
      else {
        spec.cartographic = cartographic;
        missing.push(spec);
      }
    }, { isActive })) return false;
    if (!missing.length) return true;
    try {
      // A z14 tile sits inside one z13 terrain tile, so this is one request.
      await sampleTerrain(terrainProvider, TERRAIN_SAMPLE_LEVEL, missing.map(spec => spec.cartographic));
      for (const spec of missing) {
        if (Number.isFinite(spec.cartographic.height)) spec.baseHeight = spec.cartographic.height;
        delete spec.cartographic;
      }
    } catch (error) {
      console.warn('Building terrain sampling failed:', error);
    }
    return isActive();
  }

  async _buildRoads(decoded, tile, isActive) {
    const layer = decodedLayer(decoded, 'transportation');
    if (!layer) return { instances: [] };

    // Rank by road class so a busy tile keeps its arteries, not its alleys.
    const lines = [];
    if (!await forEachSliced(layer.features, (feature) => {
      if (feature.type !== 'LineString') return;
      const roadClass = feature.properties?.class;
      const rank = roadRank(roadClass);
      if (rank === undefined) return;
      for (const line of feature.geometry) {
        const points = line.filter((point, index) => index === 0 || !samePoint(point, line[index - 1]));
        if (points.length >= 2) lines.push({ points, rank, roadClass });
      }
    }, { isActive })) return null;
    const kept = selectTop(lines, this.config.maxPerTile, (a, b) => a.rank - b.rank);

    const instances = [];
    if (!await forEachSliced(kept, ({ points, roadClass }) => {
      const positions = points.map((point) => {
        const radians = tilePointToRadians(point, tile.x, tile.y, tile.z, layer.extent);
        return Cartesian3.fromRadians(radians.longitude, radians.latitude);
      });
      instances.push(new GeometryInstance({
        geometry: new GroundPolylineGeometry({
          positions,
          width: roadWidth(roadClass),
          arcType: ArcType.RHUMB,
        }),
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(roadColor(roadClass)) },
      }));
    }, { isActive })) return null;
    return { instances };
  }

  _setRecordShow(record, desired) {
    if (record.primitive) record.primitive.show = desired && this.active;
  }

  syncVisibility() {
    for (const record of this.tiles.values()) this._setRecordShow(record, record.desired);
  }

  _cancelPending() {
    for (const record of [...this.tiles.values()]) {
      if (PENDING.includes(record.state)) this._discard(record);
    }
  }

  _discard(record) {
    record.cancelled = true;
    record.lease?.release();
    record.lease = null;
    record.decoded = null;
    if (record.primitive) {
      (this.kind === 'buildings' ? this.host.scene.primitives : this.host.scene.groundPrimitives)
        .remove(record.primitive);
      record.primitive = null;
    }
    if (this.tiles.get(record.key) === record) this.tiles.delete(record.key);
  }

  _evictCache() {
    if (this.tiles.size <= MAX_CACHE_TILES) return;
    const candidates = [...this.tiles.values()]
      .filter(record => !record.desired && !['fetching', 'building'].includes(record.state))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.tiles.size > MAX_CACHE_TILES && candidates.length) this._discard(candidates.shift());
  }

  emitStatus() {
    const noun = this.kind;
    let status;
    if (!this.enabled) status = { kind: 'off', text: 'Off' };
    else if (this.host.suspended) status = { kind: 'idle', text: 'Hidden while stargazing' };
    else if (!this.inRange) {
      status = { kind: 'idle', text: `Zoom below ${this.config.maxAltitude / 1000} km to see ${noun}` };
    } else {
      const desired = [...this.tiles.values()].filter(record => record.desired);
      const pending = desired.filter(record => PENDING.includes(record.state)).length;
      const errors = desired.filter(record => record.state === 'error').length;
      const stats = this.stats();
      if (pending) status = { kind: 'loading', text: `Loading ${noun} · ${pending} tiles` };
      else if (errors && !stats.visibleTiles) status = { kind: 'error', text: `${noun} unavailable · retrying` };
      else status = { kind: errors ? 'warning' : 'ready', text: `${stats.features.toLocaleString()} ${noun}` };
    }
    const signature = `${status.kind}:${status.text}`;
    if (signature === this.lastStatus) return;
    this.lastStatus = signature;
    this.host.onStatus?.({ layer: this.kind, ...status });
  }
}

export class OpenFreeMapOverlayController {
  constructor({ scene, globe, terrainProvider, onStatus }) {
    this.scene = scene;
    this.globe = globe;
    this.terrainProvider = terrainProvider;
    this.onStatus = onStatus;
    this.suspended = false;
    this.cache = new TileDataCache();
    this.commitChain = Promise.resolve();
    this.nearestPriority = false;
    this.layers = {
      buildings: new OverlayLayer(this, 'buildings'),
      roads: new OverlayLayer(this, 'roads'),
    };
  }

  // Resolves on a distinct animation frame for each caller, in order.
  commitSlot() {
    const next = this.commitChain.then(frame);
    this.commitChain = next.catch(() => {});
    return next;
  }

  setLayerEnabled(kind, enabled) {
    this.layers[kind].setEnabled(enabled);
  }

  setSuspended(suspended) {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    for (const layer of Object.values(this.layers)) layer.setSuspended();
  }

  setTerrainProvider(terrainProvider) {
    this.terrainProvider = terrainProvider;
    this.invalidateTerrain();
  }

  setNearestPriority(nearestPriority) {
    if (this.nearestPriority === nearestPriority) return;
    this.nearestPriority = nearestPriority;
    for (const layer of Object.values(this.layers)) layer.pump();
  }

  tilePriority(tile) {
    if (!this.nearestPriority) return tile.distance;
    const cameraPosition = this.scene.camera.positionCartographic;
    return cameraPosition
      ? tileDistanceToLocation(tile, cameraPosition.longitude, cameraPosition.latitude)
      : tile.distance;
  }

  // Only buildings depend on terrain heights; ground-clamped roads follow the
  // terrain on their own and stay put.
  invalidateTerrain() {
    this.layers.buildings.invalidate();
  }

  update(focus, altitude) {
    const position = { lng: focus.lng, lat: focus.lat };
    for (const layer of Object.values(this.layers)) layer.update(position, altitude);
  }

  destroy() {
    for (const layer of Object.values(this.layers)) {
      layer.enabled = false;
      layer.clear();
    }
    this.cache.clear();
  }

  stats() {
    return {
      suspended: this.suspended,
      buildings: this.layers.buildings.stats(),
      roads: this.layers.roads.stats(),
    };
  }
}
