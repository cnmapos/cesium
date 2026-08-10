// @ts-check

import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Color from "../Core/Color.js";
import getTimestamp from "../Core/getTimestamp.js";
import Matrix4 from "../Core/Matrix4.js";
import Rectangle from "../Core/Rectangle.js";
import WebMercatorTilingScheme from "../Core/WebMercatorTilingScheme.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import oneTimeWarning from "../Core/oneTimeWarning.js";
// @ts-expect-error rbush does not ship declarations in this workspace.
import RBush from "rbush";
import HorizontalOrigin from "./HorizontalOrigin.js";
import HeightReference from "./HeightReference.js";
import LabelCollection from "./LabelCollection.js";
import LabelStyle from "./LabelStyle.js";
import SceneTransforms from "./SceneTransforms.js";
import VerticalOrigin from "./VerticalOrigin.js";
import BillboardLoadState from "./BillboardLoadState.js";

const tilingScheme = new WebMercatorTilingScheme();
const earthCircumference = 2.0 * Math.PI * 6378137.0;
const webMercatorTileSize = 256.0;
const levelSwitchThreshold = 0.65;
const duplicateTextDistance = 64.0;
const scratchPosition = new Cartesian3();
const scratchWorldPosition = new Cartesian3();
const scratchWindowPosition = new Cartesian2();
const scratchTileRectangle = new Rectangle();
const scratchCollisionRectangle = {
  minX: 0,
  minY: 0,
  maxX: 0,
  maxY: 0,
};
const scratchFillColor = new Color();
const scratchOutlineColor = new Color();

/**
 * @typedef {object} MvtLabelManagerOptions
 * @property {*} scene
 * @property {Array<*>} styles
 * @property {HeightReference} [heightReference]
 * @property {number} [transitionDuration]
 * @property {number} [transitionSteps]
 * @property {number} [maximumRetiringLabels]
 * @property {number} [maximumCachedGlyphs]
 * @property {number} [minimumRebuildInterval]
 * @property {number} [glyphReclaimMargin]
 * @property {number} [maximumVisibleLabels]
 */

/**
 * Coordinates MVT text symbols across the visible tile set. Candidates remain
 * tile-local until traversal determines which tiles render in the current frame.
 * @private
 */
class MvtLabelManager {
  /**
   * @param {MvtLabelManagerOptions} options
   */
  constructor(options) {
    this._scene = options.scene;
    this._styles = normalizeStyles(options.styles);
    this._heightReference =
      options.heightReference ?? HeightReference.CLAMP_TO_GROUND;
    this._transitionDuration = Math.max(0, options.transitionDuration ?? 0.2);
    this._transitionSteps = Math.max(
      1,
      Math.floor(options.transitionSteps ?? 4),
    );
    this._maximumRetiringLabels = Math.max(
      0,
      Math.floor(options.maximumRetiringLabels ?? 512),
    );
    this._maximumCachedGlyphs = Math.max(
      0,
      Math.floor(options.maximumCachedGlyphs ?? 2048),
    );
    this._minimumRebuildInterval = Math.max(
      0,
      options.minimumRebuildInterval ?? 10,
    );
    this._glyphReclaimMargin = Math.max(
      0,
      Math.floor(
        options.glyphReclaimMargin ?? Math.floor(this._maximumCachedGlyphs / 4),
      ),
    );
    this._maximumVisibleLabels = Math.max(
      0,
      Math.floor(options.maximumVisibleLabels ?? 1000),
    );
    this._getTimestamp = getTimestamp;
    this._labelCollection = new LabelCollection({ scene: this._scene });
    /** @type {Set<*>} */
    this._tiles = new Set();
    /** @type {Array<*>} */
    this._frameCandidates = [];
    /** @type {Array<*>} */
    this._visibleCandidates = [];
    /** @type {Array<*>} */
    this._nextVisibleCandidates = [];
    /** @type {Set<*>} */
    this._nextVisibleSet = new Set();
    /** @type {Set<string>} */
    this._acceptedIds = new Set();
    /** @type {Map<string, Array<Cartesian2>>} */
    this._textPositions = new Map();
    /** @type {Array<*>} */
    this._retiringCandidates = [];
    this._collisionTree = new RBush();
    this._frameNumber = -1;
    this._frameTime = undefined;
    this._displayZoom = undefined;
    this._frameTileZoom = undefined;
    this._labelCollectionRebuilds = 0;
    this._lastRebuildTime = undefined;
  }

  get enabled() {
    return this._styles.length > 0;
  }

  /** @param {*} frameState */
  beginFrame(frameState) {
    if (this._frameNumber === frameState.frameNumber) {
      return;
    }
    this._frameNumber = frameState.frameNumber;
    this._frameTime = this._getTimestamp();
    this._rebuildLabelCollectionIfNeeded();
    this._updateDisplayZoom(frameState);
    this._frameCandidates.length = 0;
    this._collisionTree.clear();
  }

  /** @param {*} tile @param {{tileX:number,tileY:number,tileZ:number}} tileCoordinates @param {Array<*>} candidates */
  addTile(tile, tileCoordinates, candidates) {
    const entry = { tile, tileCoordinates, candidates };
    this._tiles.add(entry);
    return entry;
  }

  /** @param {*} entry */
  removeTile(entry) {
    if (!defined(entry) || !this._tiles.delete(entry)) {
      return;
    }
    removeCandidates(this._frameCandidates, entry.candidates);
    removeCandidates(this._visibleCandidates, entry.candidates);
    for (const candidate of entry.candidates) {
      this._removeCandidate(candidate);
    }
  }

  /** @param {*} entry @param {*} transform */
  submitTile(entry, transform) {
    if (!this.enabled || !this._tiles.has(entry)) {
      return;
    }
    for (const candidate of entry.candidates) {
      candidate.transform = transform;
      this._frameCandidates.push(candidate);
    }
  }

  /** @param {*} frameState */
  submitSelectedTiles(frameState) {
    let maximumSelectedZoom = -1;
    for (const entry of this._tiles) {
      const tileZoom = entry.tileCoordinates.tileZ;
      if (entry.tile._selectedFrame !== frameState.frameNumber) {
        continue;
      }
      maximumSelectedZoom = Math.max(maximumSelectedZoom, tileZoom);
      this.submitTile(entry, entry.tile.computedTransform);
    }
    this._frameTileZoom =
      maximumSelectedZoom >= 0 ? maximumSelectedZoom : undefined;
  }

  /** @param {*} frameState */
  endFrame(frameState) {
    if (!this.enabled || this._frameNumber !== frameState.frameNumber) {
      return;
    }

    const scene = this._scene;
    const previousVisibleCandidates = this._visibleCandidates;
    const nextVisibleCandidates = this._nextVisibleCandidates;
    const acceptedIds = this._acceptedIds;
    const textPositions = this._textPositions;
    const nextVisibleSet = this._nextVisibleSet;
    nextVisibleCandidates.length = 0;
    acceptedIds.clear();
    textPositions.clear();
    nextVisibleSet.clear();
    this._frameCandidates.sort(compareCandidates);
    for (const candidate of this._frameCandidates) {
      // Candidates are priority-sorted, so the cap drops the least important
      // labels. It also keeps the live glyph set inside the atlas budget.
      if (nextVisibleCandidates.length >= this._maximumVisibleLabels) {
        break;
      }
      const style = this._styles[candidate.styleIndex];
      const styleZoom = this._displayZoom ?? candidate.tileZ;
      const dedupeKey = getCandidateDedupeKey(candidate);
      if (
        styleZoom < style.minZoom ||
        styleZoom > style.maxZoom ||
        (defined(dedupeKey) && acceptedIds.has(dedupeKey))
      ) {
        continue;
      }

      getWorldPosition(candidate, scratchWorldPosition);
      if (defined(scene)) {
        const windowPosition = SceneTransforms.worldToWindowCoordinates(
          scene,
          scratchWorldPosition,
          scratchWindowPosition,
        );
        if (!isInsideViewport(scene, windowPosition)) {
          continue;
        }
        const rectangle = makeCollisionRectangle(
          candidate,
          style,
          windowPosition,
          scratchCollisionRectangle,
        );
        if (this._collisionTree.collides(rectangle)) {
          continue;
        }
        if (isDuplicateText(textPositions, candidate.text, windowPosition)) {
          continue;
        }
        // The tree retains what it is given, so the scratch cannot be inserted.
        this._collisionTree.insert({ ...rectangle });
      }

      this._reuseMatchingLabel(candidate);
      getOrCreateLabel(
        this._labelCollection,
        candidate,
        style,
        scratchWorldPosition,
        this._heightReference,
      );
      this._activateCandidate(candidate, style, this._frameTime);
      nextVisibleCandidates.push(candidate);
      nextVisibleSet.add(candidate);
      if (defined(dedupeKey)) {
        acceptedIds.add(dedupeKey);
      }
    }

    // Swap before retiring so the retire path splices the new array, matching
    // the previous behavior where mutations to the old array were discarded.
    this._visibleCandidates = nextVisibleCandidates;
    for (const candidate of previousVisibleCandidates) {
      if (!nextVisibleSet.has(candidate)) {
        this._retireCandidate(candidate, this._frameTime);
      }
    }
    previousVisibleCandidates.length = 0;
    this._nextVisibleCandidates = previousVisibleCandidates;
    this._updateTransitions(this._frameTime);

    // update is an internal primitive method, but it is the same lifecycle
    // used by Vector3DTilePoints for batched labels.
    /** @type {*} */ (this._labelCollection).update(frameState);
    if (hasPendingGlyphLoads(this._labelCollection)) {
      if (defined(frameState.afterRender)) {
        frameState.afterRender.push(requestRenderAfterFrame);
      } else {
        scene?.requestRender();
      }
    }
  }

  /** @param {*} candidate @param {*} style @param {*} time */
  _activateCandidate(candidate, style, time) {
    const isNewTransition = candidate.transitionTargetOpacity !== 1;
    const previousOpacity =
      candidate.opacity ??
      (isNewTransition && defined(this._scene) ? 1 / this._transitionSteps : 1);
    if (isNewTransition) {
      candidate.transitionStart = time;
      candidate.transitionStartOpacity = previousOpacity;
      candidate.transitionTargetOpacity = 1;
    }
    removeCandidates(this._retiringCandidates, [candidate]);
    this._applyCandidateOpacity(candidate, style, previousOpacity);
  }

  /** @param {*} candidate @param {*} time */
  _retireCandidate(candidate, time) {
    removeCandidates(this._visibleCandidates, [candidate]);
    if (!defined(candidate.label)) {
      return;
    }
    if (
      this._transitionDuration === 0 ||
      this._maximumRetiringLabels === 0 ||
      !defined(this._scene)
    ) {
      this._removeCandidate(candidate);
      return;
    }

    candidate.transitionStart = time;
    candidate.transitionStartOpacity = candidate.opacity ?? 1;
    candidate.transitionTargetOpacity = 0;
    this._retiringCandidates.push(candidate);

    while (this._retiringCandidates.length > this._maximumRetiringLabels) {
      this._removeCandidate(this._retiringCandidates[0]);
    }
  }

  /** @param {*} candidate */
  _reuseMatchingLabel(candidate) {
    const dedupeKey = getCandidateDedupeKey(candidate);
    if (defined(candidate.label) || !defined(dedupeKey)) {
      return;
    }
    const matchingCandidate =
      findCandidateByDedupeKey(this._visibleCandidates, dedupeKey) ??
      findCandidateByDedupeKey(this._retiringCandidates, dedupeKey);
    if (!defined(matchingCandidate) || !defined(matchingCandidate.label)) {
      return;
    }
    candidate.label = matchingCandidate.label;
    candidate.opacity = matchingCandidate.opacity;
    candidate.appliedOpacity = matchingCandidate.appliedOpacity;
    candidate.transitionStart = matchingCandidate.transitionStart;
    candidate.transitionStartOpacity = matchingCandidate.transitionStartOpacity;
    candidate.transitionTargetOpacity = 1;
    matchingCandidate.label = undefined;
    removeCandidates(this._retiringCandidates, [matchingCandidate]);
  }

  /** @param {*} time */
  _updateTransitions(time) {
    let needsAnotherFrame = false;
    for (const candidate of this._visibleCandidates) {
      const style = this._styles[candidate.styleIndex];
      needsAnotherFrame =
        this._updateCandidateTransition(candidate, style, time) ||
        needsAnotherFrame;
    }

    for (let i = this._retiringCandidates.length - 1; i >= 0; i--) {
      const candidate = this._retiringCandidates[i];
      const style = this._styles[candidate.styleIndex];
      if (this._updateCandidateTransition(candidate, style, time)) {
        needsAnotherFrame = true;
        continue;
      }
      if (candidate.opacity === 0 && defined(candidate.label)) {
        this._labelCollection.remove(candidate.label);
        candidate.label = undefined;
      }
      this._retiringCandidates.splice(i, 1);
    }

    if (needsAnotherFrame) {
      this._scene?.requestRender();
    }
  }

  /** @param {*} candidate @param {*} style @param {*} time */
  _updateCandidateTransition(candidate, style, time) {
    const targetOpacity = candidate.transitionTargetOpacity ?? 1;
    const startOpacity = candidate.transitionStartOpacity ?? targetOpacity;
    const elapsed = elapsedSeconds(time, candidate.transitionStart);
    const progress =
      this._transitionDuration === 0
        ? 1
        : Math.min(elapsed / this._transitionDuration, 1);
    const opacity = quantizeOpacity(
      startOpacity + (targetOpacity - startOpacity) * progress,
      this._transitionSteps,
    );
    this._applyCandidateOpacity(candidate, style, opacity);
    return progress < 1;
  }

  /** @param {*} candidate @param {*} style @param {number} opacity */
  _applyCandidateOpacity(candidate, style, opacity) {
    if (candidate.opacity === opacity && candidate.appliedOpacity === opacity) {
      return;
    }
    candidate.opacity = opacity;
    candidate.appliedOpacity = opacity;
    const label = candidate.label;
    if (!defined(label)) {
      return;
    }
    label.show = opacity > 0;
    label.fillColor = withAlpha(style.fillColor, opacity, scratchFillColor);
    label.outlineColor = withAlpha(
      style.outlineColor,
      opacity,
      scratchOutlineColor,
    );
  }

  /** @param {*} candidate */
  _removeCandidate(candidate) {
    removeCandidates(this._visibleCandidates, [candidate]);
    removeCandidates(this._retiringCandidates, [candidate]);
    if (defined(candidate.label)) {
      this._labelCollection.remove(candidate.label);
      candidate.label = undefined;
    }
  }

  /** @param {*} frameState */
  _updateDisplayZoom(frameState) {
    const viewZoom = getViewZoom(frameState);
    if (!defined(viewZoom)) {
      return;
    }
    if (!defined(this._displayZoom)) {
      this._displayZoom = Math.max(0, Math.floor(viewZoom));
      return;
    }
    while (viewZoom >= this._displayZoom + levelSwitchThreshold) {
      this._displayZoom++;
    }
    while (viewZoom <= this._displayZoom - levelSwitchThreshold) {
      this._displayZoom--;
    }
  }

  _rebuildLabelCollectionIfNeeded() {
    const cachedGlyphs = getCachedGlyphCount(this._labelCollection);
    if (
      this._maximumCachedGlyphs === 0 ||
      cachedGlyphs <= this._maximumCachedGlyphs
    ) {
      return;
    }

    if (
      defined(this._lastRebuildTime) &&
      elapsedSeconds(this._frameTime, this._lastRebuildTime) <
        this._minimumRebuildInterval
    ) {
      return;
    }

    // Only glyphs that no live label references can be reclaimed. Rebuilding
    // when the live set already fills the budget would discard and immediately
    // re-rasterize the whole atlas, so leave it alone and report it instead.
    const liveGlyphs = countLiveGlyphs(this._labelCollection);
    if (cachedGlyphs - liveGlyphs < this._glyphReclaimMargin) {
      oneTimeWarning(
        "MvtLabelManager.glyphBudget",
        `MVT labels reference ${liveGlyphs} distinct glyphs, at or above the ${this._maximumCachedGlyphs} glyph budget, so the glyph atlas cannot be shrunk. Lower maximumVisibleLabels or raise maximumCachedGlyphs.`,
      );
      return;
    }

    this._labelCollection = this._labelCollection.destroy();
    this._labelCollection = new LabelCollection({ scene: this._scene });
    for (const entry of this._tiles) {
      for (const candidate of entry.candidates) {
        resetCandidateLabel(candidate);
      }
    }
    for (const candidate of this._retiringCandidates) {
      resetCandidateLabel(candidate);
    }
    this._retiringCandidates.length = 0;
    this._visibleCandidates.length = 0;
    this._labelCollectionRebuilds++;
    this._lastRebuildTime = this._frameTime;
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    for (const entry of this._tiles) {
      for (const candidate of entry.candidates) {
        if (defined(candidate.label)) {
          this._labelCollection.remove(candidate.label);
          candidate.label = undefined;
        }
      }
    }
    for (const candidate of this._retiringCandidates) {
      if (defined(candidate.label)) {
        this._labelCollection.remove(candidate.label);
        candidate.label = undefined;
      }
    }
    this._tiles.clear();
    this._retiringCandidates.length = 0;
    this._labelCollection = this._labelCollection.destroy();
    return destroyObject(this);
  }
}

function requestRenderAfterFrame() {
  return true;
}

/** @param {*} labelCollection */
function getCachedGlyphCount(labelCollection) {
  return (
    labelCollection?._glyphBillboardCollection?.billboardTextureCache?.size ?? 0
  );
}

/**
 * Counts the distinct glyphs still referenced by labels in the collection. The
 * difference against the glyph cache size is how much a rebuild would reclaim.
 * @param {*} labelCollection
 * @returns {number}
 */
function countLiveGlyphs(labelCollection) {
  const labels = labelCollection?._labels;
  if (!Array.isArray(labels)) {
    return 0;
  }
  const liveIds = new Set();
  for (const label of labels) {
    for (const glyph of label._glyphs ?? []) {
      const id = glyph.billboardTexture?.id;
      if (defined(id)) {
        liveIds.add(id);
      }
    }
  }
  return liveIds.size;
}

/** @param {*} labelCollection */
function hasPendingGlyphLoads(labelCollection) {
  const cache =
    labelCollection?._glyphBillboardCollection?.billboardTextureCache;
  if (!defined(cache)) {
    return false;
  }
  for (const texture of cache.values()) {
    if (texture.loadState === BillboardLoadState.LOADING) {
      return true;
    }
  }
  return false;
}

/** @param {*} candidate */
function resetCandidateLabel(candidate) {
  candidate.label = undefined;
  candidate.appliedOpacity = undefined;
  candidate.transitionStart = undefined;
  candidate.transitionStartOpacity = undefined;
  candidate.transitionTargetOpacity = undefined;
}

/** @param {*} time @param {*} startTime */
function elapsedSeconds(time, startTime) {
  return defined(time) && defined(startTime)
    ? Math.max(time - startTime, 0) / 1000
    : 0;
}

/** @param {*} frameState */
function getViewZoom(frameState) {
  const camera = frameState.camera;
  const height = camera?.positionCartographic?.height;
  const drawingBufferHeight = frameState.context?.drawingBufferHeight;
  const verticalFov = getVerticalFov(camera?.frustum);
  if (
    !Number.isFinite(height) ||
    !Number.isFinite(drawingBufferHeight) ||
    !Number.isFinite(verticalFov) ||
    height <= 0 ||
    drawingBufferHeight <= 0
  ) {
    return undefined;
  }
  const metersPerPixel =
    (2.0 * height * Math.tan(verticalFov * 0.5)) / drawingBufferHeight;
  const zoom = Math.log2(
    earthCircumference / (webMercatorTileSize * metersPerPixel),
  );
  return Math.max(0, zoom);
}

/** @param {Set<*>} entries @param {number} maximumTileZoom */
/** @param {Map<string, Array<Cartesian2>>} textPositions @param {string} text @param {Cartesian2} position */
function isDuplicateText(textPositions, text, position) {
  let positions = textPositions.get(text);
  if (defined(positions)) {
    for (const previousPosition of positions) {
      const dx = position.x - previousPosition.x;
      const dy = position.y - previousPosition.y;
      if (dx * dx + dy * dy < duplicateTextDistance ** 2) {
        return true;
      }
    }
  } else {
    positions = [];
    textPositions.set(text, positions);
  }
  positions.push(Cartesian2.clone(position));
  return false;
}

/** @param {*} frustum */
function getVerticalFov(frustum) {
  if (Number.isFinite(frustum?.fovy)) {
    return frustum.fovy;
  }
  const offCenterFrustum = frustum?.offCenterFrustum;
  if (!defined(offCenterFrustum) || offCenterFrustum.near <= 0) {
    return undefined;
  }
  return (
    Math.atan2(offCenterFrustum.top, offCenterFrustum.near) -
    Math.atan2(offCenterFrustum.bottom, offCenterFrustum.near)
  );
}

/** @param {number} opacity @param {number} steps */
function quantizeOpacity(opacity, steps) {
  return Math.round(Math.min(Math.max(opacity, 0), 1) * steps) / steps;
}

/** @param {Color} color @param {number} opacity @param {Color} result */
function withAlpha(color, opacity, result) {
  Color.clone(color, result);
  result.alpha *= opacity;
  return result;
}

/** @param {*} scene @param {*} windowPosition */
function isInsideViewport(scene, windowPosition) {
  return (
    defined(windowPosition) &&
    windowPosition.x >= 0 &&
    windowPosition.x <= scene.drawingBufferWidth &&
    windowPosition.y >= 0 &&
    windowPosition.y <= scene.drawingBufferHeight
  );
}

/** @param {Array<*>} target @param {Array<*>} candidates */
function removeCandidates(target, candidates) {
  if (candidates.length === 1) {
    const index = target.indexOf(candidates[0]);
    if (index >= 0) {
      target.splice(index, 1);
    }
    return;
  }
  const removed = new Set(candidates);
  for (let i = target.length - 1; i >= 0; i--) {
    if (removed.has(target[i])) {
      target.splice(i, 1);
    }
  }
}

/** @param {*} candidate */
function getCandidateDedupeKey(candidate) {
  return candidate.semanticDedupeId ?? candidate.dedupeId;
}

/** @param {Array<*>} candidates @param {string} dedupeKey */
function findCandidateByDedupeKey(candidates, dedupeKey) {
  return candidates.find(
    (candidate) =>
      getCandidateDedupeKey(candidate) === dedupeKey &&
      defined(candidate.label),
  );
}

/** @param {Array<*>} styles */
function normalizeStyles(styles) {
  if (!Array.isArray(styles)) {
    return [];
  }
  return styles.map((style, index) => {
    const textSize = style.textSize ?? style["text-size"] ?? 16;
    const font = style.font ?? `${textSize}px sans-serif`;
    return {
      index,
      sourceLayer: style.sourceLayer ?? style["source-layer"],
      textField: style.textField ?? style["text-field"] ?? "name",
      minZoom: style.minZoom ?? style["minzoom"] ?? 0,
      maxZoom: style.maxZoom ?? style["maxzoom"] ?? Number.POSITIVE_INFINITY,
      priority: style.priority ?? style["symbol-sort-key"] ?? 0,
      font,
      fillColor: toColor(style.fillColor ?? style["text-color"], Color.WHITE),
      outlineColor: toColor(
        style.outlineColor ?? style["text-halo-color"],
        Color.BLACK,
      ),
      outlineWidth: style.outlineWidth ?? style["text-halo-width"] ?? 1,
      collisionPadding: getCollisionPadding(style),
      pixelOffset: new Cartesian2(
        style.pixelOffset?.x ?? style["text-offset"]?.[0] ?? 0,
        style.pixelOffset?.y ?? style["text-offset"]?.[1] ?? 0,
      ),
      filter: style.filter,
    };
  });
}

/** @param {*} value @param {Color} fallback @returns {Color} */
function toColor(value, fallback) {
  if (value instanceof Color) {
    return Color.clone(value);
  }
  if (typeof value === "string") {
    return Color.fromCssColorString(value) ?? Color.clone(fallback);
  }
  return Color.clone(fallback);
}

/** @param {*} left @param {*} right */
function compareCandidates(left, right) {
  const leftStyle = left.stylePriority;
  const rightStyle = right.stylePriority;
  if (leftStyle !== rightStyle) {
    return rightStyle - leftStyle;
  }
  if (left.tileZ !== right.tileZ) {
    return right.tileZ - left.tileZ;
  }
  return left.sortKey < right.sortKey
    ? -1
    : left.sortKey > right.sortKey
      ? 1
      : 0;
}

/** @param {*} candidate @param {Cartesian3} result @returns {Cartesian3} */
function getWorldPosition(candidate, result) {
  const rectangle = tilingScheme.tileXYToRectangle(
    candidate.tileX,
    candidate.tileY,
    candidate.tileZ,
    scratchTileRectangle,
  );
  const longitude =
    rectangle.west + (rectangle.east - rectangle.west) * candidate.x;
  const latitude =
    rectangle.north + (rectangle.south - rectangle.north) * candidate.y;
  Cartesian3.fromRadians(longitude, latitude, 0, undefined, scratchPosition);
  return Matrix4.multiplyByPoint(candidate.transform, scratchPosition, result);
}

/** @param {*} candidate @param {*} style @param {Cartesian2} position @param {*} result */
function makeCollisionRectangle(candidate, style, position, result) {
  const fontSize = parseFontSize(style.font);
  const width = Math.max(fontSize, estimateTextWidth(candidate.text, fontSize));
  const padding = style.collisionPadding;
  result.minX = position.x + style.pixelOffset.x - width * 0.5 - padding.x;
  result.minY = position.y + style.pixelOffset.y - fontSize * 0.5 - padding.y;
  result.maxX = position.x + style.pixelOffset.x + width * 0.5 + padding.x;
  result.maxY = position.y + style.pixelOffset.y + fontSize * 0.5 + padding.y;
  return result;
}

/** @param {*} style @returns {Cartesian2} */
function getCollisionPadding(style) {
  const padding = style.collisionPadding ?? style["text-padding"] ?? 6;
  if (typeof padding === "number") {
    const value = Math.max(0, padding);
    return new Cartesian2(value, value);
  }
  return new Cartesian2(
    Math.max(0, padding?.x ?? padding?.[0] ?? 6),
    Math.max(0, padding?.y ?? padding?.[1] ?? 6),
  );
}

/** @param {string} text @param {number} fontSize */
function estimateTextWidth(text, fontSize) {
  let width = 0;
  for (const character of text) {
    // CJK glyphs generally occupy the full em width, unlike Latin glyphs.
    width += isWideCharacter(character) ? fontSize : fontSize * 0.62;
  }
  return width;
}

/** @param {string} character */
function isWideCharacter(character) {
  const codePoint = character.codePointAt(0);
  return (
    defined(codePoint) &&
    ((codePoint >= 0x1100 && codePoint <= 0x115f) ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff01 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6))
  );
}

/** @param {string} font */
function parseFontSize(font) {
  const match = /(?:^|\s)(\d+(?:\.\d+)?)px(?:\s|$)/.exec(font);
  return defined(match) ? Number(match[1]) : 16;
}

/** @param {*} collection @param {*} candidate @param {*} style @param {Cartesian3} position @param {HeightReference} heightReference */
function getOrCreateLabel(
  collection,
  candidate,
  style,
  position,
  heightReference,
) {
  let label = candidate.label;
  if (!defined(label)) {
    label = candidate.label = collection.add({
      text: candidate.text,
      font: style.font,
      fillColor: style.fillColor,
      outlineColor: style.outlineColor,
      outlineWidth: style.outlineWidth,
      style: LabelStyle.FILL_AND_OUTLINE,
      horizontalOrigin: HorizontalOrigin.CENTER,
      verticalOrigin: VerticalOrigin.CENTER,
      pixelOffset: style.pixelOffset,
      heightReference: heightReference,
      id: getCandidateDedupeKey(candidate) ?? candidate.sortKey,
      show: false,
    });
  }
  label.position = position;
  return label;
}

export default MvtLabelManager;
