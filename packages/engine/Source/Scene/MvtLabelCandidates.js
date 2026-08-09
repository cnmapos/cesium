// @ts-check

import defined from "../Core/defined.js";

const semanticDedupeZoom = 8;
const candidateObjectByteLength = 256;

/**
 * Extract tile-local MVT label candidates without constructing render state.
 * @param {{layers:Array<*>}} decoded
 * @param {{tileX:number,tileY:number,tileZ:number}} tileCoordinates
 * @param {Array<*>} styles
 * @returns {object[]}
 * @private
 */
function createMvtLabelCandidates(
  decoded,
  tileCoordinates,
  styles,
  maximumCandidates = Number.POSITIVE_INFINITY,
) {
  const rules = normalizeRules(styles);
  const candidates = [];
  for (const layer of decoded.layers) {
    for (const rule of rules) {
      if (defined(rule.sourceLayer) && rule.sourceLayer !== layer.name) {
        continue;
      }
      for (
        let featureIndex = 0;
        featureIndex < layer.features.length;
        featureIndex++
      ) {
        const feature = layer.features[featureIndex];
        if (!matchesFilter(rule.filter, feature.properties)) {
          continue;
        }
        const text = resolveText(rule.textField, feature.properties);
        if (text.length === 0) {
          continue;
        }
        const anchor = getAnchor(feature);
        if (!defined(anchor)) {
          continue;
        }
        const stableFeatureId = defined(feature.id)
          ? String(feature.id)
          : undefined;
        const dedupeId = defined(rule.dedupeGroup)
          ? createSemanticDedupeId(
              rule.dedupeGroup,
              text,
              tileCoordinates,
              anchor,
              layer.extent,
            )
          : defined(stableFeatureId)
            ? `${layer.name}/${rule.index}/${stableFeatureId}`
            : undefined;
        const semanticDedupeId = createSemanticDedupeId(
          rule.dedupeGroup ?? "label",
          text,
          tileCoordinates,
          anchor,
          layer.extent,
        );
        candidates.push({
          x: anchor.x / layer.extent,
          y: anchor.y / layer.extent,
          text,
          styleIndex: rule.index,
          stylePriority: rule.priority,
          tileX: tileCoordinates.tileX,
          tileY: tileCoordinates.tileY,
          tileZ: tileCoordinates.tileZ,
          dedupeId,
          semanticDedupeId,
          sortKey:
            dedupeId ??
            `${tileCoordinates.tileZ}/${tileCoordinates.tileX}/${tileCoordinates.tileY}/${layer.name}/${featureIndex}/${rule.index}`,
          label: undefined,
          transform: undefined,
        });
      }
    }
  }
  if (candidates.length > maximumCandidates) {
    candidates.sort(compareCandidatePriority);
    candidates.length = maximumCandidates;
  }
  return candidates;
}

/**
 * Conservatively estimates retained CPU memory so label-only tile content
 * participates in the 3D Tiles LRU cache.
 * @param {Array<*>} candidates
 * @returns {number}
 * @private
 */
function getMvtLabelCandidatesByteLength(candidates) {
  let byteLength = 0;
  for (const candidate of candidates) {
    byteLength +=
      candidateObjectByteLength +
      getStringByteLength(candidate.text) +
      getStringByteLength(candidate.dedupeId) +
      getStringByteLength(candidate.semanticDedupeId) +
      getStringByteLength(candidate.sortKey);
  }
  return byteLength;
}

/** @param {*} left @param {*} right */
function compareCandidatePriority(left, right) {
  if (left.stylePriority !== right.stylePriority) {
    return right.stylePriority - left.stylePriority;
  }
  return left.sortKey < right.sortKey
    ? -1
    : left.sortKey > right.sortKey
      ? 1
      : 0;
}

/** @param {*} value */
function getStringByteLength(value) {
  return typeof value === "string" ? value.length * 2 : 0;
}

/** @param {Array<*>} styles */
function normalizeRules(styles) {
  if (!Array.isArray(styles)) {
    return [];
  }
  return styles.map((style, index) => ({
    index,
    sourceLayer: style.sourceLayer ?? style["source-layer"],
    textField: style.textField ?? style["text-field"] ?? "name",
    priority: style.priority ?? style["symbol-sort-key"] ?? 0,
    dedupeGroup: style.dedupeGroup ?? style["dedupe-group"],
    filter: style.filter,
  }));
}

/**
 * GeoVis changes source layers and omits feature IDs between overview and
 * detailed tiles. A text key in a shared Web Mercator cell identifies the
 * same named feature across those parent and child tiles.
 * @param {string} group
 * @param {string} text
 * @param {{tileX:number,tileY:number,tileZ:number}} tileCoordinates
 * @param {{x:number,y:number}} anchor
 * @param {number} extent
 */
function createSemanticDedupeId(group, text, tileCoordinates, anchor, extent) {
  const scale = 2 ** (semanticDedupeZoom - tileCoordinates.tileZ);
  const x = Math.floor((tileCoordinates.tileX + anchor.x / extent) * scale);
  const y = Math.floor((tileCoordinates.tileY + anchor.y / extent) * scale);
  return `${group}/${text}/${x}/${y}`;
}

/** @param {*} filter @param {Record<string, *>} properties @returns {boolean} */
function matchesFilter(filter, properties) {
  if (!defined(filter)) {
    return true;
  }
  if (typeof filter === "function") {
    return filter(properties);
  }
  if (typeof filter !== "object") {
    return false;
  }
  if (Array.isArray(filter)) {
    const operator = filter[0];
    if (operator === "all") {
      return filter.slice(1).every((item) => matchesFilter(item, properties));
    }
    if (operator === "any") {
      return filter.slice(1).some((item) => matchesFilter(item, properties));
    }
    if (operator === "!") {
      return !matchesFilter(filter[1], properties);
    }
    const left = resolveExpression(filter[1], properties);
    const right = resolveExpression(filter[2], properties);
    if (operator === "==") {
      return left === right;
    }
    if (operator === "!=") {
      return left !== right;
    }
    if (operator === "in") {
      return filter
        .slice(2)
        .some((value) => resolveExpression(value, properties) === left);
    }
    if (operator === "has") {
      return Object.hasOwn(properties, filter[1]);
    }
    if (operator === "<") {
      return left < right;
    }
    if (operator === ">") {
      return left > right;
    }
    if (operator === "<=") {
      return left <= right;
    }
    if (operator === ">=") {
      return left >= right;
    }
    return false;
  }
  const value = properties[filter.property];
  if (Array.isArray(filter.in)) {
    return filter.in.includes(value);
  }
  return value === filter.equals;
}

/** @param {*} textField @param {Record<string, *>} properties @returns {string} */
function resolveText(textField, properties) {
  if (Array.isArray(textField)) {
    if (textField[0] === "get") {
      const value = properties[textField[1]];
      return defined(value) ? String(value) : "";
    }
    if (textField[0] === "concat") {
      return textField
        .slice(1)
        .map((part) => resolveText(part, properties))
        .join("");
    }
    if (textField[0] === "coalesce") {
      for (const part of textField.slice(1)) {
        const value = resolveText(part, properties);
        if (value.length > 0) {
          return value;
        }
      }
    }
    return "";
  }
  if (typeof textField !== "string") {
    return "";
  }
  if (Object.hasOwn(properties, textField)) {
    return String(properties[textField]);
  }
  return textField.replace(/\{([^}]+)\}/g, (_match, property) => {
    const value = properties[property];
    return defined(value) ? String(value) : "";
  });
}

/** @param {*} expression @param {Record<string, *>} properties @returns {*} */
function resolveExpression(expression, properties) {
  if (Array.isArray(expression) && expression[0] === "get") {
    return properties[expression[1]];
  }
  return expression;
}

/** @param {*} feature @returns {{x:number,y:number}|undefined} */
function getAnchor(feature) {
  if (feature.type === "Point") {
    return feature.geometry[0];
  }
  if (feature.type === "LineString") {
    const line = feature.geometry[0];
    return defined(line) ? line[Math.floor(line.length / 2)] : undefined;
  }
  if (feature.type === "Polygon") {
    const ring = feature.geometry[0];
    if (!defined(ring) || ring.length === 0) {
      return undefined;
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const point of ring) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    return { x: (minX + maxX) * 0.5, y: (minY + maxY) * 0.5 };
  }
  return undefined;
}

export default createMvtLabelCandidates;
export { getMvtLabelCandidatesByteLength };
