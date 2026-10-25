import BoundingSphere from "../Core/BoundingSphere.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import Cartographic from "../Core/Cartographic.js";
import defined from "../Core/defined.js";
import IntersectionTests from "../Core/IntersectionTests.js";
import Matrix4 from "../Core/Matrix4.js";
import Rectangle from "../Core/Rectangle.js";

/**
 * Shared helpers for Columbus View repeat worlds: when
 * {@link Scene#columbusRepeatWorlds} is enabled, the map surface repeats
 * horizontally in whole-world copies (each 360° of longitude wide), so
 * positions and camera destinations must be placed on the copy nearest the
 * camera instead of the primary [-180°, 180°] world.
 *
 * @namespace ColumbusWorlds
 */

const ColumbusWorlds = {};

const worldWidthCartographic = new Cartographic();
const worldWidthCartesian = new Cartesian3();
const worldWidthCache = {
  projection: undefined,
  width: 0.0,
};

/**
 * The projected width of one full world (360° of longitude) for the given
 * map projection. Cached per projection instance.
 *
 * @param {object} projection The map projection.
 * @returns {number} The world width in projected units (meters).
 *
 * @private
 */
ColumbusWorlds.getWorldWidth = function (projection) {
  if (worldWidthCache.projection !== projection) {
    const northeast = projection.project(
      Rectangle.northeast(Rectangle.MAX_VALUE, worldWidthCartographic),
      worldWidthCartesian,
    );
    worldWidthCache.projection = projection;
    worldWidthCache.width = Math.abs(northeast.x) * 2.0;
  }
  return worldWidthCache.width;
};

/**
 * Places a projected map-u coordinate on the world copy nearest the camera.
 * ECEF positions normalize longitude to the primary world, so a position
 * intended for a translated copy (e.g. edited at 185° while its ECEF form
 * reads as -175°) would otherwise land a full world away from the camera
 * with no way to tell which copy was meant. The nearest-copy rule resolves
 * that ambiguity; positions hop worlds only when the camera moves more than
 * half a world away, at which point they are far off screen.
 *
 * @param {number} cameraU The camera's projected map-u coordinate.
 * @param {number} u The projected map-u coordinate to place.
 * @param {object} projection The map projection.
 * @returns {number} The map-u coordinate shifted to the nearest world copy.
 *
 * @private
 */
ColumbusWorlds.nearestWorldU = function (cameraU, u, projection) {
  const worldWidth = ColumbusWorlds.getWorldWidth(projection);
  return u + Math.round((cameraU - u) / worldWidth) * worldWidth;
};

const cameraOffsetDelta = new Cartesian3();
const cameraOffsetTranslation = new Matrix4();

/**
 * Shifts a camera so the scene draws world copy `worldOffset` instead of the
 * primary world, without duplicating any geometry. Rendering copy k at
 * `p + worldOffset` is equivalent to viewing the unshifted scene from a camera
 * moved by `-worldOffset`: `view' = view * translate(worldOffset)` and
 * `eye' = eye - worldOffset` (map-u is the y axis of Columbus view world
 * coordinates). The camera's direction, up and right are unchanged, so
 * screen-space sizes and depth ordering are preserved.
 *
 * The camera's derived members are mutated directly (not `_position`) so
 * `updateMembers` does not recompute them from the primary camera frame; the
 * caller is responsible for restoring them when done.
 *
 * @param {Camera} camera The camera to offset.
 * @param {number} worldOffset The world copy offset along map-u, in meters.
 *
 * @private
 */
ColumbusWorlds.applyCameraWorldOffset = function (camera, worldOffset) {
  Cartesian3.fromElements(0.0, worldOffset, 0.0, cameraOffsetDelta);
  Matrix4.fromTranslation(cameraOffsetDelta, cameraOffsetTranslation);
  Matrix4.multiply(
    camera._viewMatrix,
    cameraOffsetTranslation,
    camera._viewMatrix,
  );
  Matrix4.inverseTransformation(camera._viewMatrix, camera._invViewMatrix);
  camera._positionWC.y -= worldOffset;
};

/**
 * Returns a culling volume translated the same way as the camera by
 * {@link ColumbusWorlds.applyCameraWorldOffset}: the supplied volume is the
 * primary-world frustum, the result is the frustum of the shifted camera.
 * Planes are `n · p + w = 0`; translating a volume by `t` yields
 * `w' = w - n · t`, and the camera offset is `t = (0, -worldOffset, 0)`.
 *
 * @param {CullingVolume} cullingVolume The primary-world culling volume.
 * @param {number} worldOffset The world copy offset along map-u, in meters.
 * @param {CullingVolume} result The culling volume to write into.
 * @returns {CullingVolume} The modified result parameter.
 *
 * @private
 */
ColumbusWorlds.translateCullingVolume = function (
  cullingVolume,
  worldOffset,
  result,
) {
  const planes = cullingVolume.planes;
  const resultPlanes = result.planes;
  for (let i = 0; i < planes.length; ++i) {
    const plane = planes[i];
    let resultPlane = resultPlanes[i];
    if (!defined(resultPlane)) {
      resultPlane = resultPlanes[i] = new Cartesian4();
    }
    resultPlane.x = plane.x;
    resultPlane.y = plane.y;
    resultPlane.z = plane.z;
    resultPlane.w = plane.w + plane.y * worldOffset;
  }
  return result;
};

const worldStripSphere = new BoundingSphere();

/**
 * Collects the non-primary world copy indices worth rendering for the given
 * camera. The globe surface provider uses the same camera-centered window, so
 * both the basemap and the data copies cover the same worlds. A conservative
 * strip sphere keeps copies that are entirely off screen (for instance when
 * zoomed far in) from costing an extra visible-set build and pass.
 *
 * @param {number} cameraU The camera's projected map-u coordinate.
 * @param {number} worldWidth The projected world width, in meters.
 * @param {CullingVolume} cullingVolume The primary-world culling volume.
 * @param {number} maxExtraWorlds The number of copies to try on each side.
 * @param {number[]} result The array to write the world indices into.
 * @returns {number[]} The modified result parameter.
 *
 * @private
 */
ColumbusWorlds.getVisibleWorldIndices = function (
  cameraU,
  worldWidth,
  cullingVolume,
  maxExtraWorlds,
  result,
) {
  result.length = 0;
  if (!(worldWidth > 0.0) || !Number.isFinite(cameraU)) {
    return result;
  }

  const sphere = worldStripSphere;
  sphere.center.x = 0.0;
  sphere.center.z = 0.0;
  sphere.radius = worldWidth * 0.75;

  const centerWorld = Math.round(cameraU / worldWidth);
  for (let i = -maxExtraWorlds; i <= maxExtraWorlds; ++i) {
    const worldIndex = centerWorld + i;
    if (worldIndex === 0) {
      // The primary world is rendered by the regular passes.
      continue;
    }
    sphere.center.y = worldIndex * worldWidth;
    if (cullingVolume.computeVisibility(sphere) === IntersectionTests.OUTSIDE) {
      continue;
    }
    result.push(worldIndex);
  }
  return result;
};

export default ColumbusWorlds;
