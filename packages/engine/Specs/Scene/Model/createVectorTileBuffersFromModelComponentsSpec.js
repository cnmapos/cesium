import {
  BufferPoint,
  BufferPolygon,
  BufferPolyline,
  Cartesian3,
  IndexDatatype,
  Matrix4,
  ModelComponents,
  PrimitiveType,
  SceneMode,
  VertexAttributeSemantic,
  WebMercatorProjection,
  createVectorTileBuffersFromModelComponents,
} from "../../../index.js";

function createPositionAttribute(positions) {
  const attribute = new ModelComponents.Attribute();
  attribute.semantic = VertexAttributeSemantic.POSITION;
  attribute.count = positions.length / 3;
  attribute.typedArray = positions;
  return attribute;
}

function createFeatureIdAttribute(featureIds) {
  const attribute = new ModelComponents.Attribute();
  attribute.semantic = VertexAttributeSemantic.FEATURE_ID;
  attribute.setIndex = 0;
  attribute.count = featureIds.length;
  attribute.typedArray = featureIds;
  return attribute;
}

function createFeatureIdSet(featureCount) {
  const featureIdSet = new ModelComponents.FeatureIdAttribute();
  featureIdSet.featureCount = featureCount;
  featureIdSet.setIndex = 0;
  featureIdSet.positionalLabel = "featureId_0";
  return featureIdSet;
}

function createIndices(typedArray) {
  const indices = new ModelComponents.Indices();
  indices.count = typedArray.length;
  indices.typedArray = typedArray;

  if (typedArray instanceof Uint8Array) {
    indices.indexDatatype = IndexDatatype.UNSIGNED_BYTE;
  } else if (typedArray instanceof Uint16Array) {
    indices.indexDatatype = IndexDatatype.UNSIGNED_SHORT;
  } else {
    indices.indexDatatype = IndexDatatype.UNSIGNED_INT;
  }

  return indices;
}

function createPrimitive(options) {
  const primitive = new ModelComponents.Primitive();
  primitive.primitiveType = options.primitiveType;
  primitive.vector = options.vector;
  primitive.polygon = options.polygon;
  primitive.attributes.push(createPositionAttribute(options.positions));

  if (options.featureIds) {
    primitive.attributes.push(createFeatureIdAttribute(options.featureIds));
    primitive.featureIds.push(
      createFeatureIdSet(Math.max(...options.featureIds) + 1),
    );
  }

  if (options.indices) {
    primitive.indices = createIndices(options.indices);
  }

  return primitive;
}

function createComponents(rootNode) {
  const components = new ModelComponents.Components();
  components.scene = new ModelComponents.Scene();
  components.scene.nodes.push(rootNode);
  return components;
}

describe("Scene/Model/createVectorTileBuffersFromModelComponents", function () {
  const mockTileContent = {
    tileset: { featureIdLabel: "featureId_0" },
    _tile: { computedTransform: Matrix4.IDENTITY },
    _modelMatrix: Matrix4.IDENTITY,
  };
  const mockFrameState = {
    mode: SceneMode.SCENE3D,
    mapProjection: new WebMercatorProjection(),
  };

  function createBuffers(components, frameState = mockFrameState) {
    return createVectorTileBuffersFromModelComponents(
      mockTileContent,
      components,
      frameState,
    );
  }

  it("creates one point collection per mesh primitive and preserves local transforms", function () {
    const firstPrimitive = createPrimitive({
      primitiveType: PrimitiveType.POINTS,
      positions: new Float32Array([1.0, 2.0, 3.0]),
      indices: new Uint16Array([0]),
      vector: {
        vector: true,
        count: 1,
      },
      featureIds: new Uint16Array([7]),
    });

    const secondPrimitive = createPrimitive({
      primitiveType: PrimitiveType.POINTS,
      positions: new Float32Array([4.0, 5.0, 6.0]),
      indices: new Uint16Array([0]),
      vector: {
        vector: true,
        count: 1,
      },
      featureIds: new Uint16Array([9]),
    });

    const node = new ModelComponents.Node();
    node.translation = new Cartesian3(10.0, 20.0, 30.0);
    node.primitives.push(firstPrimitive, secondPrimitive);

    const { collections, collectionLocalMatrices } = createBuffers(
      createComponents(node),
    );

    expect(collections.length).toBe(2);

    expect(collections[0].primitiveCount).toBe(1);
    expect(collections[1].primitiveCount).toBe(1);

    const expectedTransform = Matrix4.fromTranslation(
      node.translation,
      new Matrix4(),
    );

    expect(collectionLocalMatrices[0]).toEqual(expectedTransform);
    expect(collectionLocalMatrices[1]).toEqual(expectedTransform);

    const point = new BufferPoint();
    collections[0].get(0, point);
    expect(point.getPosition(new Cartesian3())).toEqual(
      new Cartesian3(1.0, 2.0, 3.0),
    );
    expect(point.featureId).toBe(7);

    collections[1].get(0, point);
    expect(point.getPosition(new Cartesian3())).toEqual(
      new Cartesian3(4.0, 5.0, 6.0),
    );
    expect(point.featureId).toBe(9);
  });

  it("splits line strips using primitive restart values", function () {
    const primitive = createPrimitive({
      primitiveType: PrimitiveType.LINE_STRIP,
      positions: new Float32Array([
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0, 3.0, 0.0, 0.0, 4.0, 0.0,
        0.0,
      ]),
      indices: new Uint32Array([0, 1, 2, 0xffffffff, 2, 3, 4]),
      vector: {
        vector: true,
        count: 2,
      },
      featureIds: new Uint16Array([10, 11, 12, 13, 14]),
    });

    const node = new ModelComponents.Node();
    node.translation = new Cartesian3(5.0, 6.0, 7.0);
    node.primitives.push(primitive);

    const { collections, collectionLocalMatrices } = createBuffers(
      createComponents(node),
    );

    expect(collections.length).toBe(1);

    const collection = collections[0];
    expect(collection.primitiveCount).toBe(2);
    expect(collectionLocalMatrices[0]).toEqual(
      Matrix4.fromTranslation(node.translation, new Matrix4()),
    );

    const polyline = new BufferPolyline();
    collection.get(0, polyline);
    expect(Array.from(polyline.getPositions())).toEqual([
      0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0,
    ]);
    expect(polyline.featureId).toBe(10);

    collection.get(1, polyline);
    expect(Array.from(polyline.getPositions())).toEqual([
      2.0, 0.0, 0.0, 3.0, 0.0, 0.0, 4.0, 0.0, 0.0,
    ]);
    expect(polyline.featureId).toBe(12);
  });

  it("creates polygon collections from CESIUM_mesh_vector", function () {
    const primitive = createPrimitive({
      primitiveType: PrimitiveType.TRIANGLES,
      positions: new Float32Array([
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 2.0, 0.0, 0.0, 3.0, 0.0,
        0.0, 2.0, 1.0, 0.0,
      ]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      vector: {
        vector: true,
        count: 2,
        polygonAttributeOffsets: new Uint32Array([0, 3]),
        polygonIndicesOffsets: new Uint32Array([0, 3]),
      },
      featureIds: new Uint16Array([100, 100, 100, 200, 200, 200]),
    });

    const node = new ModelComponents.Node();
    node.primitives.push(primitive);

    const { collections } = createBuffers(createComponents(node));

    expect(collections.length).toBe(1);

    const collection = collections[0];
    expect(collection.primitiveCount).toBe(2);
    expect(collection.triangleCount).toBe(2);
    expect(collection.holeCount).toBe(0);

    const polygon = new BufferPolygon();
    collection.get(0, polygon);
    expect(Array.from(polygon.getPositions())).toEqual([
      0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0,
    ]);
    expect(Array.from(polygon.getTriangles())).toEqual([0, 1, 2]);
    expect(polygon.featureId).toBe(100);

    collection.get(1, polygon);
    expect(Array.from(polygon.getPositions())).toEqual([
      2.0, 0.0, 0.0, 3.0, 0.0, 0.0, 2.0, 1.0, 0.0,
    ]);
    expect(Array.from(polygon.getTriangles())).toEqual([0, 1, 2]);
    expect(polygon.featureId).toBe(200);
  });

  it("creates polygon collections from EXT_mesh_polygon", function () {
    // prettier-ignore
    const loopIndices = new Uint32Array([
      0, 1, 2, 3,
      0xffffffff,
      4, 5, 6, 7
    ]);
    const primitive = createPrimitive({
      primitiveType: PrimitiveType.LINE_LOOP,
      // prettier-ignore
      positions: new Float32Array([
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        1.0, 1.0, 0.0,

        0.0, 1.0, 0.0,
        1.0, 1.0, 0.0,
        0.0, 2.0, 0.0,
        1.0, 2.0, 0.0,
      ]),
      indices: loopIndices,
      polygon: {
        count: 2,
        loopIndices,
        loopIndicesOffsets: new Uint32Array([0, 5]),
        // prettier-ignore
        triangleIndices: new Uint32Array([
          0, 1, 2,
          2, 1, 3,

          4, 5, 6,
          6, 5, 7
        ]),
        triangleIndicesOffsets: new Uint32Array([0, 6]),
      },
      featureIds: new Uint16Array([100, 100, 100, 100, 200, 200, 200, 200]),
    });

    const node = new ModelComponents.Node();
    node.primitives.push(primitive);

    const { collections } = createBuffers(createComponents(node));

    expect(collections.length).toBe(1);

    const collection = collections[0];
    expect(collection.primitiveCount).toBe(2);
    expect(collection.triangleCount).toBe(4);
    expect(collection.holeCount).toBe(0);

    const polygon = new BufferPolygon();
    collection.get(0, polygon);
    // prettier-ignore
    expect(Array.from(polygon.getPositions())).toEqual([
      0.0, 0.0, 0.0,
      1.0, 0.0, 0.0,
      0.0, 1.0, 0.0,
      1.0, 1.0, 0.0,
    ]);
    expect(Array.from(polygon.getTriangles())).toEqual([0, 1, 2, 2, 1, 3]);
    expect(polygon.featureId).toBe(100);

    collection.get(1, polygon);
    // prettier-ignore
    expect(Array.from(polygon.getPositions())).toEqual([
      0.0, 1.0, 0.0,
      1.0, 1.0, 0.0,
      0.0, 2.0, 0.0,
      1.0, 2.0, 0.0,
    ]);
    // indices in BufferPolygon are relative to the current polygon's positions.
    expect(Array.from(polygon.getTriangles())).toEqual([0, 1, 2, 2, 1, 3]);
    expect(polygon.featureId).toBe(200);
  });

  it("creates polygon collections with holes from CESIUM_mesh_vector", function () {
    const primitive = createPrimitive({
      primitiveType: PrimitiveType.TRIANGLES,
      positions: new Float32Array([
        0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 4.0, 4.0, 0.0, 0.0, 4.0, 0.0, 1.0, 1.0,
        0.0, 2.0, 1.0, 0.0, 1.0, 2.0, 0.0,
      ]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      vector: {
        vector: true,
        count: 1,
        polygonAttributeOffsets: new Uint32Array([0]),
        polygonIndicesOffsets: new Uint32Array([0]),
        polygonHoleCounts: new Uint32Array([1]),
        polygonHoleOffsets: new Uint32Array([4]),
      },
      featureIds: new Uint16Array([5, 5, 5, 5, 5, 5, 5]),
    });

    const node = new ModelComponents.Node();
    node.primitives.push(primitive);

    const { collections } = createBuffers(createComponents(node));

    expect(collections.length).toBe(1);

    const collection = collections[0];

    expect(collection.primitiveCount).toBe(1);
    expect(collection.holeCount).toBe(1);
    expect(collection.triangleCount).toBe(2);

    const polygon = new BufferPolygon();
    collection.get(0, polygon);
    expect(polygon.holeCount).toBe(1);
    expect(Array.from(polygon.getHoles())).toEqual([4]);
    expect(Array.from(polygon.getTriangles())).toEqual([0, 1, 2, 0, 2, 3]);
    expect(polygon.featureId).toBe(5);
  });

  it("creates polygon collections with holes from EXT_mesh_polygon", function () {
    // prettier-ignore
    const loopIndices = new Uint32Array([
      0, 1, 2, 3,
      0xffffffff,
      4, 5, 6, 7
    ]);

    const primitive = createPrimitive({
      primitiveType: PrimitiveType.LINE_LOOP,
      // prettier-ignore
      positions: new Float32Array([
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        1.0, 1.0, 0.0,

        0.25, .25, 0.0,
        0.75, 0.25, 0.0,
        0.25, 0.75, 0.0,
        0.75, 0.75, 0.0,
      ]),
      indices: loopIndices,
      polygon: {
        count: 1,
        loopIndices,
        loopIndicesOffsets: new Uint32Array([0]),
        // prettier-ignore
        triangleIndices: new Uint32Array([
          0, 1, 5,
          0, 5, 4,
          0, 4, 2,
          1, 3, 5,
          2, 4, 6,
          2, 6, 3,
          3, 6, 7,
          3, 7, 5
        ]),
        triangleIndicesOffsets: new Uint32Array([0]),
      },
      featureIds: new Uint16Array([5, 5, 5, 5, 5, 5, 5, 5]),
    });

    const node = new ModelComponents.Node();
    node.primitives.push(primitive);

    const { collections } = createBuffers(createComponents(node));

    expect(collections.length).toBe(1);

    const collection = collections[0];

    expect(collection.primitiveCount).toBe(1);
    expect(collection.holeCount).toBe(1);
    expect(collection.triangleCount).toBe(8);

    const polygon = new BufferPolygon();
    collection.get(0, polygon);
    expect(polygon.holeCount).toBe(1);
    expect(Array.from(polygon.getHoles())).toEqual([4]);
    expect(polygon.getTriangles().length).toEqual(8 * 3);
    expect(polygon.featureId).toBe(5);
  });

  it("reads per-polygon hole ranges from CESIUM_mesh_vector", function () {
    const primitive = createPrimitive({
      primitiveType: PrimitiveType.TRIANGLES,
      positions: new Float32Array([
        0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 4.0, 4.0, 0.0, 0.0, 4.0, 0.0, 1.0, 1.0,
        0.0, 2.0, 1.0, 0.0, 1.0, 2.0, 0.0, 2.5, 2.5, 0.0, 3.0, 2.5, 0.0, 2.5,
        3.0, 0.0, 10.0, 0.0, 0.0, 14.0, 0.0, 0.0, 14.0, 4.0, 0.0, 10.0, 4.0,
        0.0, 11.0, 1.0, 0.0, 12.0, 1.0, 0.0, 11.0, 2.0, 0.0,
      ]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 10, 11, 12, 10, 12, 13]),
      vector: {
        vector: true,
        count: 2,
        polygonAttributeOffsets: new Uint32Array([0, 10]),
        polygonIndicesOffsets: new Uint32Array([0, 6]),
        polygonHoleCounts: new Uint32Array([2, 1]),
        polygonHoleOffsets: new Uint32Array([4, 7, 14]),
      },
      featureIds: new Uint16Array([
        5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6,
      ]),
    });

    const node = new ModelComponents.Node();
    node.primitives.push(primitive);

    const { collections } = createBuffers(createComponents(node));
    const collection = collections[0];
    const polygon = new BufferPolygon();

    collection.get(0, polygon);
    expect(Array.from(polygon.getHoles())).toEqual([4, 7]);

    collection.get(1, polygon);
    expect(Array.from(polygon.getHoles())).toEqual([4]);
  });

  it("computes EXT_mesh_polygon hole offsets after removing restart indices", function () {
    // prettier-ignore
    const loopIndices = new Uint32Array([
      0, 1, 2, 3,
      0xffffffff,
      4, 5, 6, 7,
      0xffffffff,
      8, 9, 10, 11,
    ]);

    const primitive = createPrimitive({
      primitiveType: PrimitiveType.LINE_LOOP,
      // prettier-ignore
      positions: new Float32Array([
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        1.0, 1.0, 0.0,
        0.25, 0.25, 0.0,
        0.75, 0.25, 0.0,
        0.25, 0.75, 0.0,
        0.75, 0.75, 0.0,
        0.4, 0.4, 0.0,
        0.6, 0.4, 0.0,
        0.4, 0.6, 0.0,
        0.6, 0.6, 0.0,
      ]),
      indices: loopIndices,
      polygon: {
        count: 1,
        loopIndices,
        loopIndicesOffsets: new Uint32Array([0]),
        triangleIndices: new Uint32Array([0, 1, 2]),
        triangleIndicesOffsets: new Uint32Array([0]),
      },
      featureIds: new Uint16Array([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]),
    });

    const node = new ModelComponents.Node();
    node.primitives.push(primitive);

    const { collections } = createBuffers(createComponents(node));
    const polygon = new BufferPolygon();
    collections[0].get(0, polygon);

    expect(Array.from(polygon.getHoles())).toEqual([4, 8]);
  });

  it("unwraps antimeridian positions when projecting to 2D", function () {
    const origin = Cartesian3.fromRadians(
      -Math.PI * 0.75,
      0.5804376954844022,
      0.0,
    );
    const boundary = Cartesian3.fromRadians(
      -Math.PI,
      (65.035 * Math.PI) / 180.0,
      0.0,
    );
    const west = Cartesian3.fromRadians(
      (-170.925 * Math.PI) / 180.0,
      (66.513 * Math.PI) / 180.0,
      0.0,
    );
    const fartherWest = Cartesian3.fromRadians(
      (-174.463 * Math.PI) / 180.0,
      (66.513 * Math.PI) / 180.0,
      0.0,
    );

    function toLocalPosition(position) {
      const local = Cartesian3.subtract(position, origin, new Cartesian3());
      return [local.x, local.y, local.z];
    }

    const positions = new Float32Array([
      ...toLocalPosition(boundary),
      ...toLocalPosition(west),
      ...toLocalPosition(fartherWest),
    ]);
    const primitive = createPrimitive({
      primitiveType: PrimitiveType.POINTS,
      positions: positions,
      indices: new Uint16Array([0, 1, 2]),
      vector: {
        vector: true,
        count: 3,
      },
      featureIds: new Uint16Array([1, 1, 1]),
    });

    const node = new ModelComponents.Node();
    node.translation = origin;
    node.primitives.push(primitive);

    const { collections, collectionLocalMatrices } = createBuffers(
      createComponents(node),
      {
        mode: SceneMode.COLUMBUS_VIEW,
        mapProjection: new WebMercatorProjection(),
      },
    );

    const collection = collections[0];
    const referenceEasting = collectionLocalMatrices[0][13];
    const point = new BufferPoint();
    const eastings = [];
    for (let i = 0; i < collection.primitiveCount; i++) {
      collection.get(i, point);
      eastings.push(point.getPosition(new Cartesian3()).y + referenceEasting);
    }

    expect(Math.max(...eastings) - Math.min(...eastings)).toBeLessThan(
      2000000.0,
    );
  });

  it("keeps east antimeridian positions in the same world copy in 2D", function () {
    const origin = Cartesian3.fromRadians(0.0, 0.0, 0.0);
    const latitude = (66.513 * Math.PI) / 180.0;
    const boundary = Cartesian3.fromRadians(Math.PI, latitude, 0.0);
    const east = Cartesian3.fromRadians(
      (170.0 * Math.PI) / 180.0,
      latitude,
      0.0,
    );
    const fartherEast = Cartesian3.fromRadians(
      (175.0 * Math.PI) / 180.0,
      latitude,
      0.0,
    );

    function toLocalPosition(position) {
      const local = Cartesian3.subtract(position, origin, new Cartesian3());
      return [local.x, local.y, local.z];
    }

    const positions = new Float32Array([
      ...toLocalPosition(boundary),
      ...toLocalPosition(east),
      ...toLocalPosition(fartherEast),
    ]);
    const primitive = createPrimitive({
      primitiveType: PrimitiveType.POINTS,
      positions: positions,
      indices: new Uint16Array([0, 1, 2]),
      vector: {
        vector: true,
        count: 3,
      },
      featureIds: new Uint16Array([1, 1, 1]),
    });

    const node = new ModelComponents.Node();
    node.translation = origin;
    node.primitives.push(primitive);

    const { collections, collectionLocalMatrices } = createBuffers(
      createComponents(node),
      {
        mode: SceneMode.SCENE2D,
        mapProjection: new WebMercatorProjection(),
      },
    );

    const collection = collections[0];
    const referenceEasting = collectionLocalMatrices[0][13];
    const point = new BufferPoint();
    const eastings = [];
    for (let i = 0; i < collection.primitiveCount; i++) {
      collection.get(i, point);
      eastings.push(point.getPosition(new Cartesian3()).y + referenceEasting);
    }

    expect(Math.max(...eastings) - Math.min(...eastings)).toBeLessThan(
      2000000.0,
    );
  });

  it("returns empty result when the model contains no vector primitives", function () {
    const node = new ModelComponents.Node();

    const { collections, collectionLocalMatrices } = createBuffers(
      createComponents(node),
    );

    expect(collections).toEqual([]);
    expect(collectionLocalMatrices).toEqual([]);
  });
});
