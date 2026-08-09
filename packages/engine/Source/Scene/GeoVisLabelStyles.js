// @ts-check

/**
 * Normalized text-symbol rules for GeoVis `vector-label` PBF tiles.
 * They cover every text-bearing source layer and zoom range from the official
 * GeoVis vector-label style, without requiring a Mapbox style runtime.
 *
 * @type {ReadonlyArray<object>}
 */
const GeoVisLabelStyles = Object.freeze([
  // Global geographic names from the GeoVis overview tile set.
  createRule("O", "{h}", 0, 10, 100, 14),
  // World and regional administrative names, including the z5 `t_world_sj` tile.
  createRule("t_world_sj", "{h}", 0, 12, 100, 14),

  // Provincial and regional administrative labels.
  createRule("ZE", "{h}", 4, 10, 90, 13),
  createRule("ZO", "{h}", 4, 4, 90, 13),
  createRule("ZP", "{h}", 5, 18, 90, 13),
  createRule("ZG", "{h}", 6, 13, 80, 13),

  // Hydrographic labels: lakes, rivers, canals, and other water features.
  createRule("ZC", "{o}", 7, 8, 80, 13),
  createRule("ZS", "{n}", 8, 18, 80, 13),
  createRule("ZU", "{h}", 10, 18, 70, 12),

  // City, district, township, and other settlement labels.
  createRule("ZH", "{h}", 7, 13, 80, 13),
  createRule("ZT", "{h}", 8, 18, 80, 13),
  createRule("ZI", "{h}", 9, 13, 70, 12),
  createRule("ZV", "{h}", 9, 18, 70, 12),
  createRule("ZD", "{o}", 9, 10, 70, 12),
  createRule("ZF", "{h}", 11, 18, 70, 12),

  // Point-of-interest names, including public facilities and transport stations.
  createRule("H", "{h}", 9, 18, 70, 12),

  // Road labels use `n` for a road name and `o` for supplementary road text.
  createRule("I", "{n}", 11, 18, 60, 12),
  createRule("I", "{o}", 11, 18, 55, 12),

  // Railway, subway, and transit line names.
  createRule("F", "{n}", 13, 18, 65, 12),

  // Administrative boundary labels from the GeoVis boundary layer.
  createRule("J", "{t}", 13, 18, 50, 12),
]);

/**
 * @param {string} sourceLayer
 * @param {string} textField
 * @param {number} minzoom
 * @param {number} maxzoom
 * @param {number} priority
 * @param {number} textSize
 * @returns {object}
 * @private
 */
function createRule(
  sourceLayer,
  textField,
  minzoom,
  maxzoom,
  priority,
  textSize,
) {
  return Object.freeze({
    sourceLayer,
    textField,
    minzoom,
    maxzoom,
    priority,
    textSize,
    fillColor: "#202124",
    outlineColor: "#ffffff",
    outlineWidth: 1,
    dedupeGroup: getDedupeGroup(sourceLayer),
    // Extra screen pixels reserved around each label to prevent dense text.
    collisionPadding: 6,
  });
}

/** @param {string} sourceLayer */
function getDedupeGroup(sourceLayer) {
  if (
    [
      "O",
      "t_world_sj",
      "ZE",
      "ZO",
      "ZP",
      "ZG",
      "ZH",
      "ZT",
      "ZI",
      "ZV",
      "ZD",
      "ZF",
    ].includes(sourceLayer)
  ) {
    return "place";
  }
  if (["ZC", "ZS", "ZU"].includes(sourceLayer)) {
    return "water";
  }
  if (sourceLayer === "I") {
    return "road";
  }
  if (sourceLayer === "F") {
    return "transit";
  }
  return sourceLayer;
}

export default GeoVisLabelStyles;
