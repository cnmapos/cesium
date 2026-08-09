import buildVectorGltfFromMVT from "../Scene/buildVectorGltfFromMVT.js";
import decodeMVT from "../Scene/decodeMVT.js";
import createTaskProcessorWorker from "./createTaskProcessorWorker.js";

function hasRenderableFeatures(decodedTile) {
  for (const layer of decodedTile.layers) {
    for (const feature of layer.features) {
      if (
        (feature.type === "Point" ||
          feature.type === "LineString" ||
          feature.type === "Polygon") &&
        feature.geometry.length > 0
      ) {
        return true;
      }
    }
  }
  return false;
}

function createMvtTile(parameters, transferableObjects) {
  const decodedTile = decodeMVT(parameters.arrayBuffer, parameters.format);
  const glb =
    parameters.buildGeometry !== false
      ? buildVectorGltfFromMVT(decodedTile, parameters.tileCoordinates, {
          featureIdProperty: parameters.featureIdProperty,
        })
      : undefined;
  if (glb !== undefined) {
    transferableObjects.push(glb.buffer);
  }
  return {
    glb: glb?.buffer,
    hasFeatures: hasRenderableFeatures(decodedTile),
    decodedTile: parameters.includeDecodedTile ? decodedTile : undefined,
  };
}

export default createTaskProcessorWorker(createMvtTile);
