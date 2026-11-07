import { Cesium3DTile, Matrix4, SceneMode } from "../../index.js";
import createScene from "../../../../Specs/createScene.js";

describe("Scene/Cesium3DTile uniformLevelMode", function () {
  const header = {
    geometricError: 1,
    refine: "REPLACE",
    children: [],
    boundingVolume: {
      sphere: [0.0, 0.0, 0.0, 5.0],
    },
  };

  let scene;

  beforeEach(function () {
    scene = createScene();
  });

  afterEach(function () {
    scene.destroyForSpecs();
  });

  it("evaluates near and far tiles at the shared reference distance", function () {
    const tileset = {
      modelMatrix: Matrix4.IDENTITY,
      _scaledGeometricError: 1,
      dynamicScreenSpaceError: false,
      _uniformLevelState: {
        active: true,
        engage: 1.0,
        referenceDistance: 1000.0,
        deviationFactor: 1024.0,
        coarsenFactor: 1.0,
      },
    };
    const near = new Cesium3DTile(tileset, "/near", header, undefined);
    const far = new Cesium3DTile(tileset, "/far", header, undefined);
    near._distanceToCamera = 500.0;
    far._distanceToCamera = 4000.0;

    scene.frameState.mode = SceneMode.SCENE3D;
    const nearError = near.getScreenSpaceError(scene.frameState, false);
    const farError = far.getScreenSpaceError(scene.frameState, false);

    expect(nearError).toBeCloseTo(farError, 12);
  });
});
