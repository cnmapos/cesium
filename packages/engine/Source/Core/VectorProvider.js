// @ts-check

import BufferPolygonCollection from "../Scene/BufferPolygonCollection.js";
import BufferPolylineCollection from "../Scene/BufferPolylineCollection.js";
import Rectangle from "./Rectangle.js";
import defined from "./defined.js";
import VectorPipeline from "./VectorPipeline.js";

/** @import BufferPrimitive from "../Scene/BufferPrimitive.js"; */
/** @import BufferPrimitiveCollection from "../Scene/BufferPrimitiveCollection.js"; */
/** @import Context from "../Renderer/Context.js"; */
/** @import Ellipsoid from "./Ellipsoid.js"; */
/** @import TilingScheme from "./TilingScheme.js"; */
/** @import { VectorCollectionData, VectorTileData } from "./VectorPipeline.js"; */

/** @ignore */
const scratchTileRectangle = new Rectangle();
const scratchCollectionRectangle = new Rectangle();
const scratchIntersectRectangle = new Rectangle();

/**
 * Extracts a collection's snapshot of projected positions and per-primitive
 * material properties.
 *
 * @callback PackCollectionData
 * @param {*} collection
 * @param {TilingScheme} tilingScheme
 * @param {VectorCollectionData} [result]
 * @returns {VectorCollectionData}
 * @private
 */

/**
 * Packs a collection's primitives into a tile's vector data.
 *
 * @callback PackTilePrimitives
 * @param {*} collection
 * @param {VectorCollectionData} collectionData
 * @param {Rectangle} rectangle
 * @param {VectorTileData} result
 * @returns {void}
 * @private
 */

/**
 * Packing functions for a collection type.
 *
 * @typedef {object} CollectionPacker
 * @property {PackCollectionData} packCollectionData Extracts the per-collection snapshot.
 * @property {PackTilePrimitives} packTilePrimitives Packs the collection's primitives into a tile.
 * @private
 */

/**
 * Per-type packing functions, keyed by collection class.
 * @type {Map<Function, CollectionPacker>}
 * @private
 */
const collectionPackers = new Map();
collectionPackers.set(BufferPolylineCollection, {
  packCollectionData: VectorPipeline.packPolylineCollectionData,
  packTilePrimitives: VectorPipeline.packPolylineSegments,
});
collectionPackers.set(BufferPolygonCollection, {
  packCollectionData: VectorPipeline.packPolygonCollectionData,
  packTilePrimitives: VectorPipeline.packPolygonRings,
});

/**
 * @typedef {object} VectorProviderConstructorOptions
 * @property {TilingScheme} tilingScheme
 * @private
 */

/**
 * @ignore
 */
class VectorProvider {
  /** @param {VectorProviderConstructorOptions} options */
  constructor(options) {
    /** @private */
    this._tilingScheme = options.tilingScheme;

    /**
     * @type {Set<BufferPrimitiveCollection<BufferPrimitive>>}
     * @private
     */
    this._collections = new Set();

    /**
     * Per-collection snapshot of projected positions and per-primitive
     * material properties, keyed by collection version.
     * @type {WeakMap<BufferPrimitiveCollection<BufferPrimitive>, VectorCollectionData>}
     * @private
     */
    this._collectionDataCache = new WeakMap();

    /**
     * Collections marked selected this frame (only these are baked).
     * @type {Set<BufferPrimitiveCollection<BufferPrimitive>>}
     * @private
     */
    this._selectedThisFrame = new Set();

    /**
     * Collections added via markSelected (not add); only these are pruned.
     * @type {Set<BufferPrimitiveCollection<BufferPrimitive>>}
     * @private
     */
    this._selectionDriven = new Set();

    /** @private */
    this._selectionFrameNumber = -1;

    /**
     * Cartographic regions changed since the last
     * {@link VectorProvider#makeClean}, so only overlapping terrain
     * tiles are re-baked.
     * @type {Rectangle[]}
     * @private
     */
    this._dirtyRectangles = [];

    /**
     * Membership version of {@link VectorProvider#_collections}. Incremented
     * at most once per frame after any add/remove changes the member set, so
     * cached tiles baked against an older member set are re-baked the next
     * time they are rendered instead of keeping stale geometry forever.
     * @type {number}
     * @private
     */
    this._version = 0;

    /**
     * Whether the member set changed since the version was last incremented.
     * @type {boolean}
     * @private
     */
    this._pendingVersionBump = false;
  }

  /** @type {TilingScheme} */
  get tilingScheme() {
    return this._tilingScheme;
  }

  set tilingScheme(value) {
    this._tilingScheme = value;
  }

  /** @type {Ellipsoid} */
  get ellipsoid() {
    return this._tilingScheme.ellipsoid;
  }

  /**
   * @param {BufferPrimitiveCollection<BufferPrimitive>} collection
   */
  add(collection) {
    const previousSize = this._collections.size;
    this._collections.add(collection);
    if (this._collections.size !== previousSize) {
      this._pendingVersionBump = true;
      this._markCollectionRegionDirty(collection);
    }
  }

  /**
   * @param {BufferPrimitiveCollection<BufferPrimitive>} collection
   */
  remove(collection) {
    this._selectedThisFrame.delete(collection);
    this._selectionDriven.delete(collection);
    if (this._collections.delete(collection)) {
      this._pendingVersionBump = true;
      this._markCollectionRegionDirty(collection);
    }
  }

  /**
   * Marks a collection as selected this frame so it is baked; collections not
   * marked are pruned next frame, keeping the baked set aligned with the
   * rendered LOD.
   *
   * @param {BufferPrimitiveCollection<BufferPrimitive>} collection
   * @param {number} frameNumber
   */
  markSelected(collection, frameNumber) {
    if (frameNumber !== this._selectionFrameNumber) {
      this._commitSelectedFrame();
      this._selectionFrameNumber = frameNumber;
    }
    this._selectedThisFrame.add(collection);
    this._selectionDriven.add(collection);
    const previousSize = this._collections.size;
    this._collections.add(collection);
    if (this._collections.size !== previousSize) {
      this._pendingVersionBump = true;
      this._markCollectionRegionDirty(collection);
    }
  }

  /**
   * Prunes selection-driven collections not marked in the frame that just ended.
   * @private
   */
  _commitSelectedFrame() {
    for (const collection of this._selectionDriven) {
      if (!this._selectedThisFrame.has(collection)) {
        this._selectionDriven.delete(collection);
        if (this._collections.delete(collection)) {
          this._pendingVersionBump = true;
          this._markCollectionRegionDirty(collection);
        }
      }
    }
    this._selectedThisFrame.clear();
  }

  /**
   * Records a changed collection's region(s) so the next re-bake only touches
   * overlapping tiles.
   * @param {BufferPrimitiveCollection<BufferPrimitive>} collection
   * @private
   */
  _markCollectionRegionDirty(collection) {
    // Prefer the exact source-tile rectangle stamped by the vector content;
    // low-level tiles have huge bounding spheres whose derived rectangle
    // covers (nearly) the whole world and would re-bake everything.
    const exactRectangle = collection._clampedVectorRectangle;
    const collectionRectangle = defined(exactRectangle)
      ? Rectangle.clone(exactRectangle, new Rectangle())
      : Rectangle.fromBoundingSphere(
          collection.boundingVolume,
          this._tilingScheme.ellipsoid,
          new Rectangle(),
        );
    this._dirtyRectangles.push(collectionRectangle);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} level
   * @param {Context} context
   * @returns {VectorTileData}
   */
  requestTileData(x, y, level, context) {
    const tilingScheme = this._tilingScheme;
    const tileRectangle = tilingScheme.tileXYToRectangle(x, y, level);

    /** @type {VectorTileData} */
    const result = { show: true };
    result.vectorProviderVersion = this._version;

    const collections = Array.from(this._collections);
    const collectionCount = collections.length;

    for (let i = 0; i < collectionCount; i++) {
      const collection = collections[i];
      const packer = collectionPackers.get(collection.constructor);
      if (!defined(packer)) {
        continue;
      }

      const exactRectangle = collection._clampedVectorRectangle;
      const collectionRectangle = defined(exactRectangle)
        ? exactRectangle
        : Rectangle.fromBoundingSphere(
            collection.boundingVolume,
            tilingScheme.ellipsoid,
            scratchCollectionRectangle,
          );

      const isIntersected = !!Rectangle.intersection(
        tileRectangle,
        collectionRectangle,
        scratchIntersectRectangle,
      );

      if (!isIntersected) {
        continue;
      }

      if (
        defined(exactRectangle) &&
        isSupersededByFinerCollection(collections, i, tileRectangle)
      ) {
        // A finer tile from the same source fully covers this surface tile;
        // skip the coarser ancestor so its geometry is not composited twice
        // (double alpha along partially refined tile borders).
        continue;
      }

      const collectionData = this._getCollectionDataCached(
        collection,
        packer.packCollectionData,
      );
      packer.packTilePrimitives(
        collection,
        collectionData,
        tileRectangle,
        result,
      );
    }

    const hasPolylines =
      defined(result.polylineSegments) && result.polylineSegments.length > 0;
    const hasPolygons =
      defined(result.polygonRings) && result.polygonRings.length > 0;

    if (!hasPolylines && !hasPolygons) {
      result.show = false;
      return result;
    }

    if (hasPolylines) {
      VectorPipeline.packPolylineGrid(result);
      VectorPipeline.packPolylineTextures(context, result);
    }

    if (hasPolygons) {
      VectorPipeline.packPolygonGrid(result);
      VectorPipeline.packPolygonTextures(context, result);
    }

    VectorPipeline.packPrimitiveTextures(context, result);

    return result;
  }

  /**
   * @param {VectorTileData} data
   */
  releaseTileData(data) {
    VectorPipeline.freeResources(data);
  }

  /**
   * Re-bakes a tile's vector data if the tile overlaps a region changed since
   * the last {@link VectorProvider#makeClean}, releasing the previous data.
   * Returns the current data unchanged when the tile is outside every changed
   * region.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} level
   * @param {Context} context
   * @param {VectorTileData|undefined} currentData
   * @returns {VectorTileData|undefined}
   */
  updateTileData(x, y, level, context, currentData) {
    const dirtyRectangles = this._dirtyRectangles;
    const tilingScheme = this._tilingScheme;
    // Re-bake tiles whose data was baked against a different member set,
    // even when no dirty region currently covers them (e.g. tiles that were
    // cached while not rendered).
    const membershipChanged =
      defined(currentData) &&
      currentData.vectorProviderVersion !== this._version;
    if (
      !membershipChanged &&
      !intersectRectangles(x, y, level, dirtyRectangles, tilingScheme)
    ) {
      return currentData;
    }

    if (defined(currentData)) {
      this.releaseTileData(currentData);
    }

    return this.requestTileData(x, y, level, context);
  }

  /**
   * Clears the regions recorded as changed. Call once after a re-bake pass has
   * updated the overlapping tiles via {@link VectorProvider#updateTileData}.
   */
  makeClean() {
    this._dirtyRectangles.length = 0;
  }

  /**
   * Records dirty regions for collections whose content has changed since
   * their last extraction, so overlapping tiles are re-baked. Call once per
   * frame, before {@link VectorProvider#updateTileData}.
   */
  update() {
    if (this._pendingVersionBump) {
      this._version++;
      this._pendingVersionBump = false;
    }
    for (const collection of this._collections) {
      const cache = this._collectionDataCache.get(collection);
      if (!defined(cache)) {
        // Never extracted; new tiles bake on request.
        continue;
      }
      const changed =
        collection._dirtyCount > 0 || cache.version !== collection._version;
      if (!changed) {
        continue;
      }
      // Re-bake both the previously baked region (content may have moved
      // away from it) and the collection's current region.
      if (defined(cache.rectangle)) {
        this._dirtyRectangles.push(Rectangle.clone(cache.rectangle));
      }
      this._markCollectionRegionDirty(collection);
    }
  }

  /**
   * Returns the collection's {@link VectorCollectionData} snapshot,
   * re-extracted when the collection has changed. The collection is marked
   * clean only after everything has been read back.
   *
   * @param {BufferPrimitiveCollection<BufferPrimitive>} collection
   * @param {PackCollectionData} packCollectionData
   * @returns {VectorCollectionData}
   * @private
   */
  _getCollectionDataCached(collection, packCollectionData) {
    const cache = this._collectionDataCache.get(collection);
    const dirty = collection._dirtyCount > 0;
    const outdated = cache?.version !== collection._version;

    if (defined(cache) && !dirty && !outdated) {
      return cache;
    }

    const data = packCollectionData(collection, this._tilingScheme, cache);

    // If dirty, the version increments +1 when marked clean below.
    data.version = collection._version + (dirty ? 1 : 0);
    data.rectangle = Rectangle.fromBoundingSphere(
      collection.boundingVolume,
      this.ellipsoid,
      data.rectangle,
    );
    this._collectionDataCache.set(collection, data);

    collection._makeClean();

    return data;
  }
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} level
 * @param {Rectangle[]} rectangles
 * @param {TilingScheme} tilingScheme
 * @returns {boolean}
 * @private
 */
function intersectRectangles(x, y, level, rectangles, tilingScheme) {
  // No dirty regions recorded — nothing to re-bake. A caller needing a full
  // re-bake should record Rectangle.MAX_VALUE instead.
  if (rectangles.length === 0) {
    return false;
  }

  const tileRectangle = tilingScheme.tileXYToRectangle(
    x,
    y,
    level,
    scratchTileRectangle,
  );

  for (let i = 0; i < rectangles.length; i++) {
    const isIntersected = Rectangle.intersection(
      tileRectangle,
      rectangles[i],
      scratchIntersectRectangle,
    );

    if (isIntersected) {
      return true;
    }
  }

  return false;
}

/**
 * Returns whether the collection at index {@link index} is a coarser tile of
 * the same source that is fully superseded, for this surface tile, by a
 * finer collection whose exact tile rectangle contains the surface tile.
 *
 * @param {Array<BufferPrimitiveCollection<BufferPrimitive>>} collections
 * @param {number} index
 * @param {Rectangle} tileRectangle
 * @returns {boolean}
 * @private
 */
function isSupersededByFinerCollection(collections, index, tileRectangle) {
  const coarse = collections[index];
  const coarseRectangle = coarse._clampedVectorRectangle;
  const sourceGroup = coarse._vectorSourceGroup;
  if (!defined(coarseRectangle) || !defined(sourceGroup)) {
    return false;
  }
  const coarseArea =
    (coarseRectangle.east - coarseRectangle.west) *
    (coarseRectangle.north - coarseRectangle.south);

  for (let i = 0; i < collections.length; i++) {
    if (i === index) {
      continue;
    }
    const fine = collections[i];
    if (fine._vectorSourceGroup !== sourceGroup) {
      continue;
    }
    const fineRectangle = fine._clampedVectorRectangle;
    if (!defined(fineRectangle)) {
      continue;
    }
    const fineArea =
      (fineRectangle.east - fineRectangle.west) *
      (fineRectangle.north - fineRectangle.south);
    if (fineArea >= coarseArea) {
      continue;
    }
    if (
      fineRectangle.west <= tileRectangle.west &&
      fineRectangle.east >= tileRectangle.east &&
      fineRectangle.south <= tileRectangle.south &&
      fineRectangle.north >= tileRectangle.north
    ) {
      return true;
    }
  }

  return false;
}

export default VectorProvider;
