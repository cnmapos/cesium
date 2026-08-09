// @ts-check
import RuntimeError from "../Core/RuntimeError.js";

// Mapbox Vector Tile specification:
// https://github.com/mapbox/vector-tile-spec/tree/master/2.1

/**
 * @typedef {object} MVTPoint
 * @property {number} x Tile-local x (0–extent)
 * @property {number} y Tile-local y (0–extent)
 * @ignore
 */

/**
 * @typedef {object} MVTFeature
 * @property {bigint|undefined} id Optional MVT feature ID.
 * @property {"Point"|"LineString"|"Polygon"|"Unknown"} type
 * @property {Array<MVTPoint>|Array<Array<MVTPoint>>} geometry
 * @property {Record<string, string|number|boolean|bigint>} properties
 * @ignore
 */

/**
 * @typedef {object} MVTLayer
 * @property {string} name
 * @property {number} extent
 * @property {MVTFeature[]} features
 * @ignore
 */

/**
 * @typedef {object} DecodedMVT
 * @property {MVTLayer[]} layers
 * @ignore
 */

/**
 * @typedef {(string|number|boolean|bigint)} MVTValue
 * @ignore
 */

/**
 * @typedef {object} ReadTagResult
 * @property {number} fieldNumber
 * @property {number} wireType
 * @property {number} newPos
 * @ignore
 */

/**
 * @typedef {object} ReadVarintResult
 * @property {number} value
 * @property {number} newPos
 * @ignore
 */

/**
 * @typedef {object} ReadBigVarintResult
 * @property {bigint} value
 * @property {number} newPos
 * @ignore
 */

const textDecoder = new TextDecoder();

// Geometry type enum from the MVT spec
const GeomType = {
  UNKNOWN: 0,
  POINT: 1,
  LINESTRING: 2,
  POLYGON: 3,
};

// Tile message field numbers (spec §4.1)
const TileField = {
  LAYERS: 3,
};

// Layer message field numbers (spec §4.1)
const LayerField = {
  NAME: 1,
  FEATURES: 2,
  KEYS: 3,
  VALUES: 4,
  EXTENT: 5,
};

// Feature message field numbers (spec §4.2)
const FeatureField = {
  ID: 1,
  TAGS: 2,
  TYPE: 3,
  GEOMETRY: 4,
};

// GeoVis compact vector-tile field numbers. GeoVis PBF is not standard MVT,
// but it retains MVT's value, tag, and delta-coordinate encoding.
const GeoVisLayerField = {
  VALUES: 1,
  FEATURES: 2,
  NAME: 3,
  KEYS: 4,
  EXTENT: 5,
};

const GeoVisFeatureField = {
  TYPE: 1,
  GEOMETRY: 2,
  TAGS: 3,
};

// Value message field numbers (spec §4.4)
const ValueField = {
  STRING: 1,
  FLOAT: 2,
  DOUBLE: 3,
  INT64: 4,
  UINT64: 5,
  SINT64: 6,
  BOOL: 7,
};

const geomTypeName = ["Unknown", "Point", "LineString", "Polygon"];

/**
 * Decode a Mapbox Vector Tile (MVT / .pbf) binary buffer into layers and
 * features. Geometry coordinates remain in tile-local integer space
 * (0 – layer.extent, typically 4096).
 *
 * @param {ArrayBuffer} arrayBuffer The raw .pbf tile binary
 * @param {"mvt"|"geovis"} [format="mvt"] PBF schema used by the tile service.
 * @returns {DecodedMVT}
 * @ignore
 */
function decodeMVT(arrayBuffer, format = "mvt") {
  const bytes = new Uint8Array(arrayBuffer);
  if (format === "geovis") {
    return decodeGeoVisMVT(bytes);
  }
  const layers = [];
  let pos = 0;

  while (pos < bytes.length) {
    const tag = readTag(bytes, pos, bytes.length);
    const fieldNumber = tag.fieldNumber;
    const wireType = tag.wireType;
    pos = tag.newPos;

    // Tile.layers = field 3, wire type 2 (length-delimited)
    if (fieldNumber === TileField.LAYERS && wireType === 2) {
      const layerLength = readVarintLength(bytes, pos, bytes.length);
      pos = layerLength.newPos;
      const layerEnd = advanceByLength(
        pos,
        layerLength.value,
        bytes.length,
        "layer",
      );
      layers.push(decodeLayer(bytes, pos, layerEnd));
      pos = layerEnd;
    } else {
      pos = skipField(bytes, pos, wireType, bytes.length);
    }
  }

  return { layers };
}

/**
 * Decode GeoVis's compact PBF schema into the same normalized structure as MVT.
 * GeoVis keeps the tile envelope (Tile.layers = field 3), but moves layer values
 * to field 1, layer name to field 3, keys to field 4, and feature type/tags/
 * geometry to fields 1/3/2 respectively.
 *
 * @param {Uint8Array} bytes
 * @returns {DecodedMVT}
 * @ignore
 */
function decodeGeoVisMVT(bytes) {
  const layers = [];
  let pos = 0;

  while (pos < bytes.length) {
    const tag = readTag(bytes, pos, bytes.length);
    pos = tag.newPos;
    if (tag.fieldNumber !== TileField.LAYERS || tag.wireType !== 2) {
      pos = skipField(bytes, pos, tag.wireType, bytes.length);
      continue;
    }

    const layerLength = readVarintLength(bytes, pos, bytes.length);
    pos = layerLength.newPos;
    const layerEnd = advanceByLength(
      pos,
      layerLength.value,
      bytes.length,
      "GeoVis layer",
    );
    layers.push(decodeGeoVisLayer(bytes, pos, layerEnd));
    pos = layerEnd;
  }

  return { layers };
}

/**
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {MVTLayer}
 * @ignore
 */
function decodeGeoVisLayer(bytes, start, end) {
  let pos = start;
  let name = "";
  let extent = 4096;
  /** @type {string[]} */
  const keys = [];
  /** @type {Array.<string|number|boolean|bigint|undefined>} */
  const values = [];
  const rawFeatures = [];

  while (pos < end) {
    const tag = readTag(bytes, pos, end);
    pos = tag.newPos;

    if (tag.wireType === 2) {
      const length = readVarintLength(bytes, pos, end);
      pos = length.newPos;
      const fieldEnd = advanceByLength(
        pos,
        length.value,
        end,
        "GeoVis layer field",
      );

      if (tag.fieldNumber === GeoVisLayerField.VALUES) {
        values.push(decodeValue(bytes, pos, fieldEnd));
      } else if (tag.fieldNumber === GeoVisLayerField.FEATURES) {
        rawFeatures.push({ start: pos, end: fieldEnd });
      } else if (tag.fieldNumber === GeoVisLayerField.NAME) {
        name = readString(bytes, pos, fieldEnd - pos);
      } else if (tag.fieldNumber === GeoVisLayerField.KEYS) {
        keys.push(readString(bytes, pos, fieldEnd - pos));
      }
      pos = fieldEnd;
    } else if (
      tag.fieldNumber === GeoVisLayerField.EXTENT &&
      tag.wireType === 0
    ) {
      const value = readVarint32(bytes, pos, end);
      extent = value.value;
      pos = value.newPos;
    } else {
      pos = skipField(bytes, pos, tag.wireType, end);
    }
  }

  const features = rawFeatures.map(({ start: featureStart, end: featureEnd }) =>
    decodeGeoVisFeature(bytes, featureStart, featureEnd, keys, values),
  );
  return { name, extent, features };
}

/**
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @param {string[]} keys
 * @param {Array.<string|number|boolean|bigint|undefined>} values
 * @returns {MVTFeature}
 * @ignore
 */
function decodeGeoVisFeature(bytes, start, end, keys, values) {
  let pos = start;
  let geomType = GeomType.UNKNOWN;
  /** @type {number[]} */
  const tags = [];
  /** @type {number[]} */
  const geometryCommands = [];

  while (pos < end) {
    const tag = readTag(bytes, pos, end);
    pos = tag.newPos;

    if (tag.wireType === 0 && tag.fieldNumber === GeoVisFeatureField.TYPE) {
      const value = readVarint32(bytes, pos, end);
      // GeoVis shifts the MVT geometry type by one.
      geomType = value.value - 1;
      pos = value.newPos;
    } else if (tag.wireType === 2) {
      const length = readVarintLength(bytes, pos, end);
      pos = length.newPos;
      const fieldEnd = advanceByLength(
        pos,
        length.value,
        end,
        "GeoVis feature field",
      );
      const target =
        tag.fieldNumber === GeoVisFeatureField.GEOMETRY
          ? geometryCommands
          : tag.fieldNumber === GeoVisFeatureField.TAGS
            ? tags
            : undefined;
      if (target !== undefined) {
        while (pos < fieldEnd) {
          const value = readVarint32(bytes, pos, fieldEnd);
          target.push(value.value);
          pos = value.newPos;
        }
      }
      pos = fieldEnd;
    } else {
      pos = skipField(bytes, pos, tag.wireType, end);
    }
  }

  /** @type {Record<string, string|number|boolean|bigint>} */
  const properties = {};
  for (let i = 0; i < tags.length - 1; i += 2) {
    const key = keys[tags[i]];
    const value = values[tags[i + 1]];
    if (typeof key === "string" && value !== undefined) {
      properties[key] = value;
    }
  }

  return {
    id: undefined,
    type: /** @type {"Point"|"LineString"|"Polygon"|"Unknown"} */ (
      geomTypeName[geomType] ?? "Unknown"
    ),
    geometry: decodeGeometry(
      geomType,
      normalizeGeoVisGeometry(geometryCommands),
    ),
    properties,
  };
}

/**
 * GeoVis remaps MoveTo's command ID from 1 to 4 and LineTo's from 2 to 3.
 * Coordinates and command counts remain the standard MVT delta representation.
 *
 * @param {number[]} commands
 * @returns {number[]}
 * @ignore
 */
function normalizeGeoVisGeometry(commands) {
  const normalized = [];
  let pos = 0;
  while (pos < commands.length) {
    const command = commands[pos++];
    const count = command >>> 3;
    const commandId = command & 0x7;
    let mvtCommandId;
    if (commandId === 4) {
      mvtCommandId = 1;
    } else if (commandId === 3) {
      mvtCommandId = 2;
    } else if (commandId === 7) {
      mvtCommandId = 7;
    } else {
      return [];
    }

    normalized.push((count << 3) | mvtCommandId);
    if (mvtCommandId === 7) {
      continue;
    }

    const coordinateCount = count * 2;
    if (pos + coordinateCount > commands.length) {
      return [];
    }
    for (let i = 0; i < coordinateCount; i++) {
      normalized.push(commands[pos++]);
    }
  }
  return normalized;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {MVTLayer}
 * @ignore
 */
function decodeLayer(bytes, start, end) {
  let pos = start;
  let name = "";
  let extent = 4096;
  /** @type {string[]} */
  const keys = [];
  /** @type {Array.<string|number|boolean|bigint|undefined>} */
  const values = [];
  const rawFeatures = [];

  while (pos < end) {
    const tag = readTag(bytes, pos, end);
    const fieldNumber = tag.fieldNumber;
    const wireType = tag.wireType;
    pos = tag.newPos;

    if (fieldNumber === LayerField.NAME && wireType === 2) {
      // name
      const length = readVarintLength(bytes, pos, end);
      pos = length.newPos;
      const stringEnd = advanceByLength(pos, length.value, end, "layer name");
      name = readString(bytes, pos, length.value);
      pos = stringEnd;
    } else if (fieldNumber === LayerField.FEATURES && wireType === 2) {
      // feature
      const length = readVarintLength(bytes, pos, end);
      pos = length.newPos;
      const featureEnd = advanceByLength(pos, length.value, end, "feature");
      rawFeatures.push({ start: pos, end: featureEnd });
      pos = featureEnd;
    } else if (fieldNumber === LayerField.KEYS && wireType === 2) {
      // key
      const length = readVarintLength(bytes, pos, end);
      pos = length.newPos;
      const stringEnd = advanceByLength(pos, length.value, end, "key");
      keys.push(readString(bytes, pos, length.value));
      pos = stringEnd;
    } else if (fieldNumber === LayerField.VALUES && wireType === 2) {
      // value
      const length = readVarintLength(bytes, pos, end);
      pos = length.newPos;
      const valueEnd = advanceByLength(pos, length.value, end, "value");
      const value = decodeValue(bytes, pos, valueEnd);
      values.push(value);
      pos = valueEnd;
    } else if (fieldNumber === LayerField.EXTENT && wireType === 0) {
      // extent
      const value = readVarint32(bytes, pos, end);
      extent = value.value;
      pos = value.newPos;
    } else {
      pos = skipField(bytes, pos, wireType, end);
    }
  }

  const features = rawFeatures.map(({ start: featureStart, end: featureEnd }) =>
    decodeFeature(bytes, featureStart, featureEnd, keys, values),
  );

  return { name, extent, features };
}

/**
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @param {string[]} keys
 * @param {Array.<string|number|boolean|bigint|undefined>} values
 * @returns {MVTFeature}
 * @ignore
 */
function decodeFeature(bytes, start, end, keys, values) {
  let pos = start;
  let id;
  let geomType = GeomType.UNKNOWN;
  const tags = [];
  const geometryCommands = [];

  while (pos < end) {
    const tag = readTag(bytes, pos, end);
    const fieldNumber = tag.fieldNumber;
    const wireType = tag.wireType;
    pos = tag.newPos;

    if (fieldNumber === FeatureField.ID && wireType === 0) {
      const value = readBigVarint(bytes, pos, end);
      id = value.value;
      pos = value.newPos;
    } else if (fieldNumber === FeatureField.TYPE && wireType === 0) {
      // geometry type
      const value = readVarint32(bytes, pos, end);
      geomType = value.value;
      pos = value.newPos;
    } else if (fieldNumber === FeatureField.TAGS && wireType === 2) {
      // tags (packed uint32)
      const length = readVarintLength(bytes, pos, end);
      pos = length.newPos;
      const tagEnd = advanceByLength(pos, length.value, end, "feature tags");
      while (pos < tagEnd) {
        const value = readVarint32(bytes, pos, tagEnd);
        tags.push(value.value);
        pos = value.newPos;
      }
    } else if (fieldNumber === FeatureField.GEOMETRY && wireType === 2) {
      // geometry (packed uint32 commands)
      const length = readVarintLength(bytes, pos, end);
      pos = length.newPos;
      const geometryEnd = advanceByLength(
        pos,
        length.value,
        end,
        "feature geometry",
      );
      while (pos < geometryEnd) {
        const value = readVarint32(bytes, pos, geometryEnd);
        geometryCommands.push(value.value);
        pos = value.newPos;
      }
    } else {
      pos = skipField(bytes, pos, wireType, end);
    }
  }

  // Build properties from tags
  /** @type {Record<string, string|number|boolean|bigint>} */
  const properties = {};
  for (let i = 0; i < tags.length - 1; i += 2) {
    const key = keys[tags[i]];
    const value = values[tags[i + 1]];
    if (typeof key !== "string" || value === undefined) {
      continue;
    }
    properties[key] = value;
  }

  const geometry = decodeGeometry(geomType, geometryCommands);

  return {
    id,
    type: /** @type {"Point"|"LineString"|"Polygon"|"Unknown"} */ (
      geomTypeName[geomType] ?? "Unknown"
    ),
    geometry,
    properties,
  };
}

/**
 * Decode MVT geometry commands into coordinate arrays.
 * @param {number} geomType
 * @param {number[]} cmds
 * @returns {*}
 * @ignore
 */
function decodeGeometry(geomType, cmds) {
  let i = 0;
  let x = 0;
  let y = 0;

  if (geomType === GeomType.POINT) {
    const points = [];
    while (i < cmds.length) {
      const cmd = cmds[i++];
      const cmdId = cmd & 0x7;
      const count = cmd >> 3;
      if (cmdId === 1) {
        // MoveTo
        for (let c = 0; c < count; c++) {
          x += zigzag(cmds[i++]);
          y += zigzag(cmds[i++]);
          points.push({ x, y });
        }
      }
    }
    return points;
  }

  if (geomType === GeomType.LINESTRING) {
    const lines = [];
    let current = null;
    while (i < cmds.length) {
      const cmd = cmds[i++];
      const cmdId = cmd & 0x7;
      const count = cmd >> 3;
      if (cmdId === 1) {
        // MoveTo - start new line
        if (current !== null) {
          lines.push(current);
        }
        current = [];
        x += zigzag(cmds[i++]);
        y += zigzag(cmds[i++]);
        current.push({ x, y });
      } else if (cmdId === 2) {
        // LineTo
        for (let c = 0; c < count; c++) {
          x += zigzag(cmds[i++]);
          y += zigzag(cmds[i++]);
          current.push({ x, y });
        }
      }
    }
    if (current !== null) {
      lines.push(current);
    }
    return lines;
  }

  if (geomType === GeomType.POLYGON) {
    const rings = [];
    let current = null;
    while (i < cmds.length) {
      const cmd = cmds[i++];
      const cmdId = cmd & 0x7;
      const count = cmd >> 3;
      if (cmdId === 1) {
        // MoveTo - start ring
        if (current !== null) {
          rings.push(current);
        }
        current = [];
        x += zigzag(cmds[i++]);
        y += zigzag(cmds[i++]);
        current.push({ x, y });
      } else if (cmdId === 2) {
        // LineTo
        for (let c = 0; c < count; c++) {
          x += zigzag(cmds[i++]);
          y += zigzag(cmds[i++]);
          current.push({ x, y });
        }
      } else if (cmdId === 7) {
        // ClosePath
        if (current !== null && current.length > 0) {
          current.push({ x: current[0].x, y: current[0].y });
          rings.push(current);
          current = null;
        }
      }
    }
    if (current !== null) {
      rings.push(current);
    }
    return rings;
  }

  return [];
}

/**
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {string|number|boolean|bigint|undefined}
 * @ignore
 */
function decodeValue(bytes, start, end) {
  let pos = start;
  while (pos < end) {
    const tag = readTag(bytes, pos, end);
    const fieldNumber = tag.fieldNumber;
    const wireType = tag.wireType;
    pos = tag.newPos;
    if (fieldNumber === ValueField.STRING && wireType === 2) {
      const length = readVarintLength(bytes, pos, end);
      pos = length.newPos;
      const stringEnd = advanceByLength(pos, length.value, end, "string value");
      return readString(bytes, pos, stringEnd - pos);
    } else if (fieldNumber === ValueField.FLOAT && wireType === 5) {
      // float
      advanceByLength(pos, 4, end, "float value");
      const v = new DataView(
        bytes.buffer,
        bytes.byteOffset + pos,
        4,
      ).getFloat32(0, true);
      return v;
    } else if (fieldNumber === ValueField.DOUBLE && wireType === 1) {
      // double
      advanceByLength(pos, 8, end, "double value");
      const v = new DataView(
        bytes.buffer,
        bytes.byteOffset + pos,
        8,
      ).getFloat64(0, true);
      return v;
    } else if (fieldNumber === ValueField.INT64 && wireType === 0) {
      const value = readBigVarint(bytes, pos, end);
      return toSafeNumber(value.value);
    } else if (fieldNumber === ValueField.UINT64 && wireType === 0) {
      const value = readBigVarint(bytes, pos, end);
      return toSafeNumber(value.value);
    } else if (fieldNumber === ValueField.SINT64 && wireType === 0) {
      const value = readBigVarint(bytes, pos, end);
      return toSafeNumber(zigzagBigInt(value.value));
    } else if (fieldNumber === ValueField.BOOL && wireType === 0) {
      const value = readVarint32(bytes, pos, end);
      return value.value !== 0;
    }
    pos = skipField(bytes, pos, wireType, end);
  }
  return undefined;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} pos
 * @param {number} limit
 * @returns {ReadTagResult}
 * @ignore
 */
function readTag(bytes, pos, limit) {
  const value = readVarint32(bytes, pos, limit);
  return {
    fieldNumber: value.value >>> 3,
    wireType: value.value & 0x7,
    newPos: value.newPos,
  };
}

/**
 * @param {Uint8Array} bytes
 * @param {number} pos
 * @param {number} limit
 * @returns {ReadVarintResult}
 * @ignore
 */
function readVarint32(bytes, pos, limit) {
  const value = readBigVarint(bytes, pos, limit, 5);
  if (value.value > 0xffffffffn) {
    throw new RuntimeError("Invalid MVT uint32 varint.");
  }
  return {
    value: Number(value.value),
    newPos: value.newPos,
  };
}

/**
 * @param {Uint8Array} bytes
 * @param {number} pos
 * @param {number} limit
 * @returns {ReadVarintResult}
 * @ignore
 */
function readVarintLength(bytes, pos, limit) {
  const value = readBigVarint(bytes, pos, limit);
  if (value.value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RuntimeError("Invalid MVT length varint.");
  }
  return {
    value: Number(value.value),
    newPos: value.newPos,
  };
}

/**
 * @param {Uint8Array} bytes
 * @param {number} pos
 * @param {number} limit
 * @param {number} [maxBytes=10]
 * @returns {ReadBigVarintResult}
 * @ignore
 */
function readBigVarint(bytes, pos, limit, maxBytes) {
  let result = 0n;
  let shift = 0n;
  let byteCount = 0;
  const byteLimit = maxBytes ?? 10;

  while (true) {
    if (pos >= limit || pos >= bytes.length) {
      throw new RuntimeError("Invalid MVT: truncated varint.");
    }
    const byte = bytes[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    byteCount++;
    if ((byte & 0x80) === 0) {
      break;
    }
    if (byteCount >= byteLimit) {
      throw new RuntimeError("Invalid MVT: varint is too long.");
    }
    shift += 7n;
  }

  return {
    value: result,
    newPos: pos,
  };
}

/**
 * @param {Uint8Array} bytes
 * @param {number} pos
 * @param {number} len
 * @returns {string}
 * @ignore
 */
function readString(bytes, pos, len) {
  const end = advanceByLength(pos, len, bytes.length, "string");
  return textDecoder.decode(bytes.subarray(pos, end));
}

/**
 * @param {number} pos
 * @param {number} length
 * @param {number} limit
 * @param {string} fieldName
 * @returns {number}
 * @ignore
 */
function advanceByLength(pos, length, limit, fieldName) {
  if (!Number.isFinite(length) || length < 0) {
    throw new RuntimeError(`Invalid MVT ${fieldName}: invalid length.`);
  }
  const end = pos + length;
  if (!Number.isFinite(end) || end < pos || end > limit) {
    throw new RuntimeError(
      `Invalid MVT ${fieldName}: length exceeds available bytes.`,
    );
  }
  return end;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} pos
 * @param {number} wireType
 * @param {number} limit
 * @returns {number} newPos
 * @ignore
 */
function skipField(bytes, pos, wireType, limit) {
  if (wireType === 0) {
    return readBigVarint(bytes, pos, limit).newPos;
  } else if (wireType === 1) {
    return advanceByLength(pos, 8, limit, "fixed64 field");
  } else if (wireType === 2) {
    const length = readVarintLength(bytes, pos, limit);
    return advanceByLength(
      length.newPos,
      length.value,
      limit,
      "length-delimited field",
    );
  } else if (wireType === 5) {
    return advanceByLength(pos, 4, limit, "fixed32 field");
  }
  throw new RuntimeError(`Unsupported protobuf wire type: ${wireType}`);
}

/**
 * Decode a zigzag-encoded signed integer.
 * @param {number} n
 * @returns {number}
 * @ignore
 */
function zigzag(n) {
  return (n >>> 1) ^ -(n & 1);
}

/**
 * @param {bigint} n
 * @returns {bigint}
 * @ignore
 */
function zigzagBigInt(n) {
  return (n >> 1n) ^ -(n & 1n);
}

/**
 * @param {bigint} value
 * @returns {number|bigint}
 * @ignore
 */
function toSafeNumber(value) {
  if (
    value <= BigInt(Number.MAX_SAFE_INTEGER) &&
    value >= BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return value;
}

export default decodeMVT;
