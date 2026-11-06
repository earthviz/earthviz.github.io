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
  OPENFREEMAP_TILE_ZOOM,
  buildingHeightRange,
  groupPolygonRings,
  tilePointToRadians,
  tileWindow,
} from './openfreemap-geometry.js';

const TILE_URL = 'https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf';
const MAX_ALTITUDE = 25_000;
const TILE_RADIUS = 2;
const MAX_CACHE_TILES = 36;
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_BUILDINGS_PER_TILE = 1_600;
const MAX_ROADS_PER_TILE = 800;
const TERRAIN_SAMPLE_LEVEL = 13;
const REQUEST_TIMEOUT = 15_000;
const RETRY_DELAY = 20_000;
const BUILDING_BASE_OFFSET = 0.6;
const BUILDING_COLOR = new Color(0.58, 0.61, 0.62, 0.44);

const ROAD_CLASSES = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'street',
]);

function roadWidth(properties = {}) {
  switch (properties.class) {
    case 'motorway': return 4;
    case 'trunk': return 3.5;
    case 'primary': return 3;
    case 'secondary': return 2.5;
    case 'tertiary': return 2;
    case 'minor': return 1.4;
    default: return 1;
  }
}

function roadColor(properties = {}) {
  const major = ['motorway', 'trunk', 'primary'].includes(properties.class);
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

function buildingSpecs(decoded, tile) {
  const layer = decodedLayer(decoded, 'building');
  if (!layer) return [];
  const result = [];
  for (const feature of layer.features) {
    if (feature.type !== 'Polygon') continue;
    if ([true, 1, 'true'].includes(feature.properties?.hide_3d)) continue;
    for (const group of groupPolygonRings(feature.geometry)) {
      const outer = toRadiansRing(group.outerRing, tile, layer.extent);
      if (outer.length < 3) continue;
      const holes = group.holes
        .map(ring => toRadiansRing(ring, tile, layer.extent))
        .filter(ring => ring.length >= 3);
      const center = outer.reduce((sum, point) => ({
        longitude: sum.longitude + point.longitude,
        latitude: sum.latitude + point.latitude,
      }), { longitude: 0, latitude: 0 });
      center.longitude /= outer.length;
      center.latitude /= outer.length;
      result.push({ outer, holes, center, properties: feature.properties || {}, baseHeight: 0 });
      if (result.length >= MAX_BUILDINGS_PER_TILE) return result;
    }
  }
  return result;
}

function roadInstances(decoded, tile) {
  const layer = decodedLayer(decoded, 'transportation');
  if (!layer) return [];
  const instances = [];
  for (const feature of layer.features) {
    if (feature.type !== 'LineString' || !ROAD_CLASSES.has(feature.properties?.class)) continue;
    for (const line of feature.geometry) {
      const points = line.filter((point, index) => index === 0 || !samePoint(point, line[index - 1]));
      if (points.length < 2) continue;
      const positions = points.map((point) => {
        const radians = tilePointToRadians(point, tile.x, tile.y, tile.z, layer.extent);
        return Cartesian3.fromRadians(radians.longitude, radians.latitude);
      });
      instances.push(new GeometryInstance({
        geometry: new GroundPolylineGeometry({
          positions,
          width: roadWidth(feature.properties),
          arcType: ArcType.RHUMB,
        }),
        attributes: {
          color: ColorGeometryInstanceAttribute.fromColor(roadColor(feature.properties)),
        },
      }));
      if (instances.length >= MAX_ROADS_PER_TILE) return instances;
    }
  }
  return instances;
}

function buildingHierarchy(spec) {
  const positions = spec.outer.map(point => Cartesian3.fromRadians(point.longitude, point.latitude));
  const holes = spec.holes.map(ring => new PolygonHierarchy(
    ring.map(point => Cartesian3.fromRadians(point.longitude, point.latitude)),
  ));
  return new PolygonHierarchy(positions, holes);
}

function buildingInstances(specs, scene) {
  const exaggeration = scene.verticalExaggeration;
  const relativeHeight = scene.verticalExaggerationRelativeHeight;
  return specs.map((spec) => {
    const range = buildingHeightRange(spec.properties);
    const terrainBase = VerticalExaggeration.getHeight(spec.baseHeight, exaggeration, relativeHeight);
    return new GeometryInstance({
      geometry: new PolygonGeometry({
        polygonHierarchy: buildingHierarchy(spec),
        height: terrainBase + range.height,
        extrudedHeight: terrainBase + range.minimum + BUILDING_BASE_OFFSET,
        closeTop: true,
        closeBottom: false,
        arcType: ArcType.RHUMB,
        vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
      }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(BUILDING_COLOR),
      },
    });
  });
}

export class OpenFreeMapOverlayController {
  constructor({ scene, globe, terrainProvider, onStatus }) {
    this.scene = scene;
    this.globe = globe;
    this.terrainProvider = terrainProvider;
    this.onStatus = onStatus;
    this.enabled = false;
    this.suspended = false;
    this.inRange = false;
    this.tiles = new Map();
    this.desired = new Set();
    this.queue = [];
    this.activeRequests = 0;
    this.clock = 0;
    this.focus = null;
    this.lastStatus = '';
    this.terrainRevision = 0;
  }

  setEnabled(enabled) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.clear();
    this._syncVisibility();
    this._emitStatus();
  }

  setSuspended(suspended) {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    if (suspended) this._cancelUnloaded();
    this._syncVisibility();
    this._pump();
    this._emitStatus();
  }

  setTerrainProvider(terrainProvider) {
    this.terrainProvider = terrainProvider;
    this.invalidateTerrain();
  }

  invalidateTerrain() {
    this.terrainRevision += 1;
    this.clear();
    this._emitStatus();
  }

  update(focus, altitude) {
    this.focus = { longitude: focus.lng, latitude: focus.lat, altitude };
    const inRange = altitude <= MAX_ALTITUDE;
    if (this.inRange !== inRange) {
      this.inRange = inRange;
      if (!inRange) this._cancelUnloaded();
    }
    if (!this.enabled || this.suspended || !this.inRange) {
      this._syncVisibility();
      this._emitStatus();
      return;
    }

    const wanted = tileWindow(focus.lng, focus.lat, {
      zoom: OPENFREEMAP_TILE_ZOOM,
      radius: TILE_RADIUS,
    });
    this.desired = new Set(wanted.map(tile => tile.key));
    for (const record of [...this.tiles.values()]) {
      record.desired = this.desired.has(record.key);
      if (record.desired) record.lastUsed = ++this.clock;
      if (!record.desired && ['queued', 'loading', 'sampling'].includes(record.state)) {
        this._discard(record);
      } else this._setRecordShow(record, record.desired);
    }
    for (const tile of wanted) {
      let record = this.tiles.get(tile.key);
      if (!record) {
        record = {
          ...tile,
          state: 'queued',
          desired: true,
          lastUsed: ++this.clock,
          buildings: null,
          roads: null,
          buildingCount: 0,
          roadCount: 0,
          retryAt: 0,
          cancelled: false,
        };
        this.tiles.set(record.key, record);
        this.queue.push(record);
      } else if (record.state === 'error' && Date.now() >= record.retryAt) {
        record.state = 'queued';
        record.cancelled = false;
        this.queue.push(record);
      }
    }
    this._evictCache();
    this._syncVisibility();
    this._pump();
    this._emitStatus();
  }

  clear() {
    for (const record of [...this.tiles.values()]) this._discard(record);
    this.tiles.clear();
    this.desired.clear();
    this.queue.length = 0;
  }

  destroy() {
    this.enabled = false;
    this.clear();
  }

  stats() {
    const visible = [...this.tiles.values()].filter(record => record.desired && record.state === 'loaded');
    return {
      enabled: this.enabled,
      suspended: this.suspended,
      inRange: this.inRange,
      activeRequests: this.activeRequests,
      cachedTiles: this.tiles.size,
      visibleTiles: visible.length,
      buildings: visible.reduce((sum, record) => sum + record.buildingCount, 0),
      roads: visible.reduce((sum, record) => sum + record.roadCount, 0),
    };
  }

  _isCurrent(record, terrainRevision) {
    return this.tiles.get(record.key) === record
      && record.desired
      && !record.cancelled
      && this.enabled
      && !this.suspended
      && this.inRange
      && this.terrainRevision === terrainRevision;
  }

  async _load(record) {
    const terrainRevision = this.terrainRevision;
    record.state = 'loading';
    record.controller = new AbortController();
    const timeout = setTimeout(() => record.controller.abort(), REQUEST_TIMEOUT);
    try {
      const response = await fetch(tileUrl(record), { signal: record.controller.signal });
      if (!response.ok) throw new Error(`OpenFreeMap tile ${record.key}: HTTP ${response.status}`);
      const decoded = decodeMVT(await response.arrayBuffer());
      if (!this._isCurrent(record, terrainRevision)) return;

      const specs = buildingSpecs(decoded, record);
      const roads = roadInstances(decoded, record);
      record.state = 'sampling';
      await this._sampleBuildingBases(specs);
      if (!this._isCurrent(record, terrainRevision)) return;

      const buildings = buildingInstances(specs, this.scene);
      if (buildings.length) {
        record.buildings = this.scene.primitives.add(new Primitive({
          geometryInstances: buildings,
          appearance: new PerInstanceColorAppearance({
            translucent: true,
            closed: true,
            flat: false,
          }),
          asynchronous: true,
          allowPicking: false,
          releaseGeometryInstances: true,
        }));
      }
      if (roads.length) {
        record.roads = this.scene.groundPrimitives.add(new GroundPolylinePrimitive({
          geometryInstances: roads,
          appearance: new PolylineColorAppearance({ translucent: true }),
          asynchronous: true,
          allowPicking: false,
          releaseGeometryInstances: true,
        }));
      }
      record.buildingCount = buildings.length;
      record.roadCount = roads.length;
      record.state = 'loaded';
      this._setRecordShow(record, true);
    } catch (error) {
      if (record.cancelled || this.tiles.get(record.key) !== record) return;
      record.state = 'error';
      record.retryAt = Date.now() + RETRY_DELAY;
      console.warn('OpenFreeMap overlay tile failed:', error);
    } finally {
      clearTimeout(timeout);
      record.controller = null;
      this.activeRequests -= 1;
      this._pump();
      this._emitStatus();
    }
  }

  async _sampleBuildingBases(specs) {
    const missing = [];
    for (const spec of specs) {
      const cartographic = new Cartographic(spec.center.longitude, spec.center.latitude);
      const loadedHeight = this.globe.getHeight(cartographic);
      if (Number.isFinite(loadedHeight)) spec.baseHeight = loadedHeight;
      else {
        spec.cartographic = cartographic;
        missing.push(spec);
      }
    }
    if (!missing.length) return;
    try {
      await sampleTerrain(
        this.terrainProvider,
        TERRAIN_SAMPLE_LEVEL,
        missing.map(spec => spec.cartographic),
      );
      for (const spec of missing) {
        if (Number.isFinite(spec.cartographic.height)) spec.baseHeight = spec.cartographic.height;
        delete spec.cartographic;
      }
    } catch (error) {
      console.warn('Building terrain sampling failed:', error);
    }
  }

  _pump() {
    if (!this.enabled || this.suspended || !this.inRange) return;
    while (this.activeRequests < MAX_CONCURRENT_REQUESTS && this.queue.length) {
      const record = this.queue.shift();
      if (this.tiles.get(record.key) !== record || !record.desired || record.state !== 'queued') continue;
      this.activeRequests += 1;
      void this._load(record);
    }
  }

  _setRecordShow(record, desired) {
    const show = desired && this.enabled && !this.suspended && this.inRange;
    if (record.buildings) record.buildings.show = show;
    if (record.roads) record.roads.show = show;
  }

  _syncVisibility() {
    for (const record of this.tiles.values()) this._setRecordShow(record, record.desired);
  }

  _cancelUnloaded() {
    for (const record of [...this.tiles.values()]) {
      if (['queued', 'loading', 'sampling'].includes(record.state)) this._discard(record);
    }
    this.queue = this.queue.filter(record => this.tiles.get(record.key) === record);
  }

  _discard(record) {
    record.cancelled = true;
    record.controller?.abort();
    if (record.buildings) this.scene.primitives.remove(record.buildings);
    if (record.roads) this.scene.groundPrimitives.remove(record.roads);
    if (this.tiles.get(record.key) === record) this.tiles.delete(record.key);
  }

  _evictCache() {
    if (this.tiles.size <= MAX_CACHE_TILES) return;
    const candidates = [...this.tiles.values()]
      .filter(record => !record.desired && !['loading', 'sampling'].includes(record.state))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.tiles.size > MAX_CACHE_TILES && candidates.length) this._discard(candidates.shift());
  }

  _emitStatus() {
    if (!this.onStatus) return;
    const stats = this.stats();
    let status;
    if (!this.enabled) status = { kind: 'off', text: 'Off' };
    else if (this.suspended) status = { kind: 'idle', text: 'Hidden while stargazing' };
    else if (!this.inRange) status = { kind: 'idle', text: 'Zoom closer to see city detail' };
    else {
      const visible = [...this.tiles.values()].filter(record => record.desired);
      const pending = visible.filter(record => ['queued', 'loading', 'sampling'].includes(record.state)).length;
      const errors = visible.filter(record => record.state === 'error').length;
      if (pending) status = { kind: 'loading', text: `Loading 3D city detail · ${pending} tiles` };
      else if (errors && !stats.visibleTiles) status = { kind: 'error', text: 'City detail unavailable · retrying' };
      else status = {
        kind: errors ? 'warning' : 'ready',
        text: `${stats.buildings.toLocaleString()} buildings · ${stats.roads.toLocaleString()} roads`,
      };
    }
    const signature = `${status.kind}:${status.text}`;
    if (signature === this.lastStatus) return;
    this.lastStatus = signature;
    this.onStatus(status);
  }
}
