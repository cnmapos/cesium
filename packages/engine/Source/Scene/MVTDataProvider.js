// @ts-check

import Axis from "./Axis.js";
import Empty3DTileContent from "./Empty3DTileContent.js";
import RuntimeError from "../Core/RuntimeError.js";
import TaskProcessor from "../Core/TaskProcessor.js";
import destroyObject from "../Core/destroyObject.js";
import UrlTemplate3DTilesDataProvider from "./UrlTemplate3DTilesDataProvider.js";
import VectorGltf3DTileContent from "./VectorGltf3DTileContent.js";
import MvtLabelManager from "./MvtLabelManager.js";
import createMvtLabelCandidates, {
  getMvtLabelCandidatesByteLength,
} from "./MvtLabelCandidates.js";
import HeightReference from "./HeightReference.js";
import oneTimeWarning from "../Core/oneTimeWarning.js";
import defined from "../Core/defined.js";

/** @import Cesium3DTile from "./Cesium3DTile.js"; */
/** @import Cesium3DTileset from "./Cesium3DTileset.js"; */
/** @import FrameState from "./FrameState.js"; */
/** @import Rectangle from "../Core/Rectangle.js"; */
/** @import Resource from "../Core/Resource.js"; */
/** @import Scene from "./Scene.js"; */

/**
 * @typedef {object} MVTProviderOptions
 * @property {number} [minZoom]
 * @property {number} [maxZoom]
 * @property {Rectangle} [extent]
 * @property {string} [featureIdProperty]
 * @property {Array<*>} [labelStyles]
 * @property {HeightReference} [labelHeightReference]
 * @property {number} [labelTransitionDuration]
 * @property {number} [labelTransitionSteps]
 * @property {number} [maximumRetiringLabels]
 * @property {number} [maximumLabelsPerTile]
 * @property {number} [maximumCachedGlyphs]
 * @property {boolean} [renderGeometry]
 * @property {"mvt"|"geovis"} [format]
 * @property {number} [maximumScreenSpaceError]
 * @property {number} [maximumConcurrentRequests]
 * @property {number} [cacheBytes]
 * @property {number} [maximumCacheOverflowBytes]
 * @property {Scene} [scene]
 */

/**
 * @typedef {object} MVTWorkerResult
 * @property {ArrayBuffer} [glb]
 * @property {boolean} hasFeatures
 * @property {object} [decodedTile]
 */

const createMvtTileTaskProcessor = new TaskProcessor("createMvtTile", 4);
const labelOnlyCacheBytes = 64 * 1024 * 1024;
const labelOnlyMaximumCacheOverflowBytes = 16 * 1024 * 1024;

/**
 * A Mapbox Vector Tiles (MVT) data provider. Loads .mvt or .pbf tiles, converting tiles
 * dynamically (at runtime) into 3D Tiles.
 *
 * <div class="notice">
 * This object is normally not instantiated directly, use {@link MVTDataProvider.fromUrl}.
 * </div>
 *
 * @extends UrlTemplate3DTilesDataProvider
 * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy.
 */
class MVTDataProvider extends UrlTemplate3DTilesDataProvider {
  /** @param {Resource|string} urlTemplate @param {MVTProviderOptions} [options] */
  constructor(urlTemplate, options) {
    options = normalizeMvtOptions(options);
    super(urlTemplate, options);
    this._labelStyles = options.labelStyles ?? [];
    this._labelHeightReference =
      options.labelHeightReference ?? HeightReference.CLAMP_TO_GROUND;
    this._labelTransitionDuration = options.labelTransitionDuration ?? 0.2;
    this._labelTransitionSteps = options.labelTransitionSteps ?? 4;
    this._maximumRetiringLabels = options.maximumRetiringLabels ?? 512;
    this._renderGeometry = options.renderGeometry ?? true;
    this._maximumLabelsPerTile = Math.max(
      0,
      Math.floor(options.maximumLabelsPerTile ?? 4096),
    );
    this._maximumCachedGlyphs = Math.max(
      0,
      Math.floor(options.maximumCachedGlyphs ?? 2048),
    );
    this._cacheBytes =
      options.cacheBytes ??
      (this._renderGeometry ? undefined : labelOnlyCacheBytes);
    this._maximumCacheOverflowBytes =
      options.maximumCacheOverflowBytes ??
      (this._renderGeometry ? undefined : labelOnlyMaximumCacheOverflowBytes);
    this._format = options.format ?? "mvt";
    this._maximumScreenSpaceError = options.maximumScreenSpaceError;
    this._usesAdaptiveScreenSpaceError =
      this._format === "geovis" && !defined(this._maximumScreenSpaceError);
    this._maximumConcurrentRequests = options.maximumConcurrentRequests ?? 12;
    this._scene = options.scene;
    this._labelManager = undefined;
  }

  /**
   * Creates an MVTDataProvider from the specified URL template and options.
   *
   * @param {Resource|string} url URL template, containing {z}, {x}, and {y} placeholders.
   * @param {object} [options] Provider options.
   * @param {number} [options.minZoom=0] Minimum zoom level represented in the generated tileset.
   * @param {number} [options.maxZoom] Maximum zoom level represented in the generated tileset. GeoVis defaults to 18 and is limited to 18 because its label API returns empty tiles above that level.
   * @param {Rectangle} [options.extent] Optional geographic extent in radians to constrain the generated tile tree.
   * @param {string} [options.featureIdProperty] MVT property name to use as feature ID.
   * @param {object[]} [options.labelStyles] Declarative MVT text-symbol rules.
   * @param {HeightReference} [options.labelHeightReference=HeightReference.CLAMP_TO_GROUND] Height reference for MVT labels. Ground clamping keeps labels fixed to terrain and 3D Tiles while the camera moves.
   * @param {number} [options.labelTransitionDuration=0.2] Seconds used to cross-fade labels when tile selection changes. Set to 0 to disable transitions.
   * @param {number} [options.labelTransitionSteps=4] Opacity steps in each label transition. A small value keeps rapid zoom and pan updates bounded.
   * @param {number} [options.maximumRetiringLabels=512] Maximum labels retained for fade-out after a tile switch. Excess labels are removed immediately to protect frame time during rapid navigation.
   * @param {number} [options.maximumLabelsPerTile=4096] Maximum label candidates retained from one tile. Higher-priority styles are kept first.
   * @param {number} [options.maximumCachedGlyphs=2048] Maximum distinct glyphs retained by the label atlas before it is rebuilt. Set to 0 to disable atlas recycling.
   * @param {boolean} [options.renderGeometry=true] Render point, line, and polygon geometry in addition to labels.
   * @param {"mvt"|"geovis"} [options.format="mvt"] PBF schema used by the tile service. Use `geovis` for GeoVis vector APIs.
   * @param {number} [options.maximumScreenSpaceError] Tile screen-space error. When omitted for GeoVis, it adapts from 16 at globe scale to 1 near street scale.
   * @param {number} [options.maximumConcurrentRequests=12] Maximum pending MVT tile network requests. Limits the initial global-tile burst without requiring an extent.
   * @param {number} [options.cacheBytes=67108864] Target tile cache size for labels-only providers. Geometry providers keep the Cesium3DTileset default unless configured.
   * @param {number} [options.maximumCacheOverflowBytes=16777216] Additional cache headroom for labels-only providers. Geometry providers keep the Cesium3DTileset default unless configured.
   * @param {Scene} [options.scene] Scene used for label decluttering and depth behavior.
   * @returns {Promise<MVTDataProvider>}
   */
  static async fromUrl(url, options) {
    return /** @type {Promise<MVTDataProvider>} */ (
      /** @type {Promise<MVTDataProvider>} */ (
        /** @type {unknown} */ (super.fromUrl(url, options))
      )
    );
  }

  /**
   * @returns {object}
   * @protected
   * @ignore
   */
  _createTilesetLoadOptions() {
    /** @type {*} */
    const options = {
      // Progressive traversal keeps an available lower-level label tile visible
      // while a sharper child tile is loading. Immediate LOD skipping can select
      // an empty GeoVis child tile and leave the screen without text.
      skipLevelOfDetail: false,
      maximumSimultaneousTileRequests: this._maximumConcurrentRequests,
      enablePick: true,
      featureIdLabel: "featureId_0",
      instanceFeatureIdLabel: "instanceFeatureId_0",
      scene: this._scene,
    };
    if (defined(this._cacheBytes)) {
      options.cacheBytes = this._cacheBytes;
    }
    if (defined(this._maximumCacheOverflowBytes)) {
      options.maximumCacheOverflowBytes = this._maximumCacheOverflowBytes;
    }
    return options;
  }

  /**
   * @param {Cesium3DTileset} tileset
   * @protected
   * @ignore
   */
  _configureTileset(tileset) {
    tileset._modelUpAxis = Axis.Z;
    tileset._modelForwardAxis = Axis.X;
    if (defined(this._maximumScreenSpaceError)) {
      /** @type {*} */ (tileset).maximumScreenSpaceError =
        this._maximumScreenSpaceError;
    }
    if (this._labelStyles.length > 0) {
      this._labelManager = new MvtLabelManager({
        scene: this._scene,
        styles: this._labelStyles,
        heightReference: this._labelHeightReference,
        transitionDuration: this._labelTransitionDuration,
        transitionSteps: this._labelTransitionSteps,
        maximumRetiringLabels: this._maximumRetiringLabels,
        maximumCachedGlyphs: this._maximumCachedGlyphs,
      });
    }
  }

  /**
   * @returns {object}
   * @protected
   * @ignore
   */
  _createCodec() {
    const featureIdProperty = this._featureIdProperty;
    const labelManager = this._labelManager;
    const labelStyles = this._labelStyles;
    return {
      contentType: "mvt",
      missingTilePolicy: { statusCodes: [404, 204] },

      /**
       * @param {Cesium3DTileset} tileset
       * @param {Cesium3DTile} tile
       * @param {Resource} resource
       * @param {ArrayBuffer} arrayBuffer
       * @ignore
       */
      createContent: async (tileset, tile, resource, arrayBuffer) => {
        const tileCoordinates = parseTileCoordinates(
          resource.getUrlComponent(true),
        );
        const result = await scheduleMvtTileTask({
          arrayBuffer,
          tileCoordinates,
          featureIdProperty,
          format: this._format,
          includeDecodedTile: defined(labelManager),
          buildGeometry: this._renderGeometry,
        });
        const labelCandidates = defined(result.decodedTile)
          ? createMvtLabelCandidates(
              /** @type {{layers: Array<*>}} */ (result.decodedTile),
              tileCoordinates,
              labelStyles,
              this._maximumLabelsPerTile,
            )
          : undefined;
        if (!this._renderGeometry) {
          if (defined(labelManager) && defined(labelCandidates)) {
            return new MvtLabel3DTileContent(
              tileset,
              tile,
              resource,
              labelManager,
              labelCandidates,
              tileCoordinates,
            );
          }
          return new Empty3DTileContent(tileset, tile);
        }
        if (!defined(result.glb)) {
          if (!result.hasFeatures) {
            return new Empty3DTileContent(tileset, tile);
          }
          throw new RuntimeError(
            "Decoded MVT tile did not produce vector glTF content.",
          );
        }
        return VectorGltf3DTileContent.fromGltf(
          tileset,
          tile,
          resource,
          new Uint8Array(result.glb),
          labelManager,
          labelCandidates,
          tileCoordinates,
          this._renderGeometry,
        );
      },
    };
  }

  /**
   * @param {*} frameState
   * @protected
   */
  update(frameState) {
    if (this._usesAdaptiveScreenSpaceError && defined(this._tileset)) {
      /** @type {*} */ (this._tileset).maximumScreenSpaceError =
        getGeoVisScreenSpaceError(
          frameState.camera.positionCartographic?.height,
        );
    }
    this._labelManager?.beginFrame(frameState);
    super.update(frameState);
    this._labelManager?.submitSelectedTiles(frameState);
    this._labelManager?.endFrame(frameState);
  }

  destroy() {
    const labelManager = this._labelManager;
    this._labelManager = undefined;
    const result = super.destroy();
    labelManager?.destroy();
    return result;
  }
}

/**
 * Lightweight content ownership for labels-only tiles. It satisfies the 3D
 * Tiles content contract without constructing a glTF model or being classified
 * as empty content by traversal.
 * @private
 */
class MvtLabel3DTileContent {
  /**
   * @param {*} tileset
   * @param {*} tile
   * @param {*} resource
   * @param {*} labelManager
   * @param {Array<*>} labelCandidates
   * @param {{tileX:number,tileY:number,tileZ:number}} tileCoordinates
   */
  constructor(
    tileset,
    tile,
    resource,
    labelManager,
    labelCandidates,
    tileCoordinates,
  ) {
    this._tileset = tileset;
    this._tile = tile;
    this._resource = resource;
    this._labelManager = labelManager;
    this._labelTile = labelManager.addTile(
      tile,
      tileCoordinates,
      labelCandidates,
    );
    this._labelByteLength = getMvtLabelCandidatesByteLength(labelCandidates);
    /** @type {*} */
    this._metadata = undefined;
    /** @type {*} */
    this._group = undefined;
    this.featurePropertiesDirty = false;
  }

  get featuresLength() {
    return 0;
  }

  get pointsLength() {
    return 0;
  }

  get trianglesLength() {
    return 0;
  }

  get geometryByteLength() {
    return 0;
  }

  get texturesByteLength() {
    return 0;
  }

  get batchTableByteLength() {
    return this._labelByteLength;
  }

  /** @returns {undefined} */
  get innerContents() {
    return undefined;
  }

  get ready() {
    return true;
  }

  get tileset() {
    return this._tileset;
  }

  get tile() {
    return this._tile;
  }

  get url() {
    return this._resource.getUrlComponent(true);
  }

  /** @returns {*} */
  get metadata() {
    return this._metadata;
  }

  set metadata(value) {
    this._metadata = value;
  }

  /** @returns {undefined} */
  get batchTable() {
    return undefined;
  }

  /** @returns {*} */
  get group() {
    return this._group;
  }

  set group(value) {
    this._group = value;
  }

  /** @param {*} batchId @param {string} name @returns {boolean} */
  hasProperty(batchId, name) {
    return false;
  }

  /** @param {*} batchId @returns {undefined} */
  getFeature(batchId) {
    return undefined;
  }

  /** @param {boolean} enabled @param {*} color */
  applyDebugSettings(enabled, color) {}

  /** @param {*} style */
  applyStyle(style) {}

  /** @param {*} tileset @param {*} frameState */
  update(tileset, frameState) {}

  /** @param {*} ray @param {*} frameState @param {*} result @returns {undefined} */
  pick(ray, frameState, result) {
    return undefined;
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    this._labelManager?.removeTile(this._labelTile);
    this._labelManager = undefined;
    this._labelTile = undefined;
    this._labelByteLength = 0;
    return destroyObject(this);
  }
}

/** @param {number|undefined} height */
function getGeoVisScreenSpaceError(height) {
  if (!Number.isFinite(height) || height > 3000000.0) {
    return 16.0;
  }
  if (height > 1000000.0) {
    return 12.0;
  }
  if (height > 200000.0) {
    return 8.0;
  }
  if (height > 50000.0) {
    return 4.0;
  }
  return 1.0;
}

/** @param {MVTProviderOptions|undefined} options @returns {MVTProviderOptions} */
function normalizeMvtOptions(options) {
  const normalized = options ?? {};
  if (normalized.format !== "geovis") {
    return normalized;
  }
  return {
    ...normalized,
    maxZoom: Math.min(normalized.maxZoom ?? 18, 18),
  };
}

/** @param {*} parameters @returns {Promise<MVTWorkerResult>} */
async function scheduleMvtTileTask(parameters) {
  let promise;
  while (!defined(promise)) {
    promise = createMvtTileTaskProcessor.scheduleTask(parameters, [
      parameters.arrayBuffer,
    ]);
    if (!defined(promise)) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return /** @type {Promise<MVTWorkerResult>} */ (promise);
}

/**
 * @param {string} url
 * @returns {{tileZ:number, tileX:number, tileY:number}}
 * @ignore
 */
function parseTileCoordinates(url) {
  const match = url.match(/\/(\d+)\/(\d+)\/(\d+)(?:\.[^/?#]+)?(?:[?#]|$)/i);
  if (!match) {
    oneTimeWarning(
      "MVTDataProvider.parseTileCoordinates",
      `MVT tile URL did not match /{z}/{x}/{y} pattern. Falling back to z/x/y = 0/0/0. URL: ${url}`,
    );
    return { tileZ: 0, tileX: 0, tileY: 0 };
  }
  return {
    tileZ: parseInt(match[1], 10),
    tileX: parseInt(match[2], 10),
    tileY: parseInt(match[3], 10),
  };
}

MVTDataProvider._parseTileCoordinates = parseTileCoordinates;
MVTDataProvider._MvtLabel3DTileContent = MvtLabel3DTileContent;

export default MVTDataProvider;
