import {
  ImageryLayer,
  UrlTemplateImageryProvider,
  WebMapServiceImageryProvider,
  WebMercatorTilingScheme,
} from '@cesium/engine';
import { HYPSOMETRIC_SOURCES, RADAR_MAX_ZOOM, RAINVIEWER_URL, radarFrames } from '../sources.js';
import { privacyFetch, readJson } from '../security.js';

const RADAR_REFRESH_MS = 5 * 60 * 1000;
const RADAR_FRAME_MS = 600;

// State for the Gaia overlays. `layers()` is called by ImageryController every
// time it rebuilds the globe's imagery stack.
export class OverlayController {
  constructor({ onChange, onStatus = () => {}, onFrame = () => {} }) {
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.onFrame = onFrame;
    this.hypso = 'off';
    this.hypsoAlpha = 0.6;
    this.radar = false;
    this.animate = true;
    this.frames = [];
    this.radarLayers = [];
    this.frameIndex = 0;
    this.refreshTimer = 0;
    this.frameTimer = 0;
  }

  get credits() {
    const out = [];
    if (this.hypso !== 'off') out.push(HYPSOMETRIC_SOURCES[this.hypso].credit);
    if (this.radar) out.push('Radar: Weather data by RainViewer');
    return out;
  }

  layers() {
    const out = [];
    this.radarLayers = [];
    this.hypsoLayer = null;
    if (this.hypso !== 'off') {
      const s = HYPSOMETRIC_SOURCES[this.hypso];
      const provider = new WebMapServiceImageryProvider({
        url: s.url,
        layers: s.layers,
        parameters: { format: 'image/png', transparent: true },
        credit: s.credit,
        maximumLevel: 12,
        enablePickFeatures: false,
      });
      this.hypsoLayer = new ImageryLayer(provider, { alpha: this.hypsoAlpha });
      out.push(this.hypsoLayer);
    }
    if (this.radar && this.frames.length) {
      this.radarLayers = this.frames.map(frame => new ImageryLayer(new UrlTemplateImageryProvider({
        url: frame.url,
        maximumLevel: RADAR_MAX_ZOOM,
        hasAlphaChannel: true,
        credit: 'Weather data by RainViewer',
        enablePickFeatures: false,
        tilingScheme: new WebMercatorTilingScheme(),
      }), { alpha: 0.75, show: false }));
      this.frameIndex = this.radarLayers.length - 1;
      this.#showFrame();
      out.push(...this.radarLayers);
    }
    return out;
  }

  setHypso(value) { this.hypso = value in HYPSOMETRIC_SOURCES ? value : 'off'; this.onChange(); }

  setHypsoAlpha(alpha) {
    this.hypsoAlpha = alpha;
    if (this.hypsoLayer) this.hypsoLayer.alpha = alpha;
  }

  async setRadar(on) {
    this.radar = on;
    clearInterval(this.refreshTimer);
    if (on) {
      await this.#loadFrames();
      this.refreshTimer = setInterval(() => this.#loadFrames(true), RADAR_REFRESH_MS);
    }
    this.#restartAnimation();
    this.onChange();
  }

  setAnimate(on) { this.animate = on; this.#restartAnimation(); }

  // Pause on a specific radar frame.
  scrub(index) {
    if (!this.radarLayers.length) return;
    this.animate = false;
    clearInterval(this.frameTimer);
    this.frameIndex = Math.max(0, Math.min(this.radarLayers.length - 1, index));
    this.#showFrame();
  }

  async #loadFrames(rebuild = false) {
    try {
      const response = await privacyFetch(RAINVIEWER_URL);
      const frames = radarFrames(await readJson(response));
      if (!frames.length) throw new Error('No radar frames');
      const changed = frames.at(-1)?.time !== this.frames.at(-1)?.time;
      this.frames = frames;
      this.onStatus(`Radar · latest ${new Date(frames.at(-1).time).toISOString().slice(11, 16)} UTC`);
      if (rebuild && changed && this.radar) this.onChange();
    } catch {
      this.onStatus('Radar unavailable right now');
      if (!rebuild) { this.radar = false; }
    }
  }

  #showFrame() {
    this.radarLayers.forEach((layer, i) => { layer.show = i === this.frameIndex; });
    this.onFrame(this.frameIndex, this.frames);
  }

  #restartAnimation() {
    clearInterval(this.frameTimer);
    if (!(this.radar && this.animate)) { this.frameIndex = this.radarLayers.length - 1; this.#showFrame(); return; }
    this.frameTimer = setInterval(() => {
      if (this.radarLayers.length < 2) return;
      this.frameIndex = (this.frameIndex + 1) % this.radarLayers.length;
      this.#showFrame();
    }, RADAR_FRAME_MS);
  }

  stop() { clearInterval(this.refreshTimer); clearInterval(this.frameTimer); }
}

