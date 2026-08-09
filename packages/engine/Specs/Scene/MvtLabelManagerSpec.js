import createMvtLabelCandidates, {
  getMvtLabelCandidatesByteLength,
} from "../../Source/Scene/MvtLabelCandidates.js";
import HeightReference from "../../Source/Scene/HeightReference.js";
import Matrix4 from "../../Source/Core/Matrix4.js";
import MvtLabelManager from "../../Source/Scene/MvtLabelManager.js";
import BillboardLoadState from "../../Source/Scene/BillboardLoadState.js";

describe("Scene/MvtLabelManager", function () {
  const tileCoordinates = { tileX: 3, tileY: 2, tileZ: 4 };

  it("extracts stable candidates from text rules", function () {
    const decoded = {
      layers: [
        {
          name: "places",
          extent: 4096,
          features: [
            {
              id: 19n,
              type: "Point",
              geometry: [{ x: 1024, y: 2048 }],
              properties: { name: "Harbor", rank: 1 },
            },
          ],
        },
      ],
    };

    const candidates = createMvtLabelCandidates(decoded, tileCoordinates, [
      {
        sourceLayer: "places",
        textField: "{name}",
        priority: 5,
        filter: { property: "rank", equals: 1 },
      },
    ]);

    expect(candidates.length).toBe(1);
    expect(candidates[0].text).toBe("Harbor");
    expect(candidates[0].x).toBe(0.25);
    expect(candidates[0].y).toBe(0.5);
    expect(candidates[0].dedupeId).toBe("places/0/19");
    expect(candidates[0].stylePriority).toBe(5);
  });

  it("uses a polygon extent center and rejects unmatched styles", function () {
    const decoded = {
      layers: [
        {
          name: "landuse",
          extent: 100,
          features: [
            {
              type: "Polygon",
              geometry: [
                [
                  { x: 10, y: 20 },
                  { x: 50, y: 20 },
                  { x: 50, y: 60 },
                  { x: 10, y: 60 },
                ],
              ],
              properties: { label: "Park" },
            },
          ],
        },
      ],
    };

    const candidates = createMvtLabelCandidates(decoded, tileCoordinates, [
      { sourceLayer: "other", textField: "label" },
      { sourceLayer: "landuse", textField: "label" },
    ]);

    expect(candidates.length).toBe(1);
    expect(candidates[0].x).toBe(0.3);
    expect(candidates[0].y).toBe(0.4);
  });

  it("keeps the highest-priority candidates within a per-tile limit", function () {
    const decoded = {
      layers: [
        {
          name: "places",
          extent: 4096,
          features: [
            {
              type: "Point",
              geometry: [{ x: 1024, y: 1024 }],
              properties: { name: "Low" },
            },
          ],
        },
        {
          name: "cities",
          extent: 4096,
          features: [
            {
              type: "Point",
              geometry: [{ x: 2048, y: 2048 }],
              properties: { name: "High" },
            },
          ],
        },
      ],
    };
    const candidates = createMvtLabelCandidates(
      decoded,
      tileCoordinates,
      [
        { sourceLayer: "places", textField: "name", priority: 1 },
        { sourceLayer: "cities", textField: "name", priority: 10 },
      ],
      1,
    );

    expect(candidates.length).toBe(1);
    expect(candidates[0].text).toBe("High");
    expect(getMvtLabelCandidatesByteLength(candidates)).toBeGreaterThan(256);
  });

  it("deduplicates the same GeoVis place name across parent and child layers", function () {
    const styles = [
      { sourceLayer: "O", textField: "{h}", dedupeGroup: "place" },
      { sourceLayer: "ZH", textField: "{h}", dedupeGroup: "place" },
    ];
    const parent = createMvtLabelCandidates(
      {
        layers: [
          {
            name: "O",
            extent: 4096,
            features: [
              {
                type: "Point",
                geometry: [{ x: 2048, y: 2048 }],
                properties: { h: "Tianjin" },
              },
            ],
          },
        ],
      },
      tileCoordinates,
      styles,
    );
    const child = createMvtLabelCandidates(
      {
        layers: [
          {
            name: "ZH",
            extent: 4096,
            features: [
              {
                type: "Point",
                geometry: [{ x: 0, y: 0 }],
                properties: { h: "Tianjin" },
              },
            ],
          },
        ],
      },
      { tileX: 7, tileY: 5, tileZ: 5 },
      styles,
    );

    expect(parent[0].dedupeId).toBe("place/Tianjin/56/40");
    expect(child[0].dedupeId).toBe(parent[0].dedupeId);
  });

  it("does not render a cached detailed tile at globe scale", function () {
    const manager = new MvtLabelManager({
      scene: undefined,
      styles: [{ textField: "name" }],
      transitionDuration: 0,
    });
    let addedLabels = 0;
    manager._labelCollection = {
      add: function () {
        addedLabels++;
        return {};
      },
      remove: function () {},
      update: function () {},
      destroy: function () {},
    };
    const tile = { _selectedFrame: 0, computedTransform: Matrix4.IDENTITY };
    const candidate = createTestCandidate("city", undefined);
    candidate.tileZ = 12;
    manager.addTile(tile, tileCoordinates, [candidate]);

    const frameState = {
      frameNumber: 1,
      camera: {
        positionCartographic: { height: 4000000.0 },
        frustum: { fovy: 1.0 },
      },
      context: { drawingBufferHeight: 1000 },
    };
    manager.beginFrame(frameState);
    manager.submitSelectedTiles(frameState);
    manager.endFrame(frameState);

    expect(addedLabels).toBe(0);
    manager.destroy();
  });

  it("removes a detailed generation when it is no longer selected", function () {
    const manager = new MvtLabelManager({
      scene: undefined,
      styles: [{ textField: "name" }],
    });
    let removedLabels = 0;
    manager._labelCollection = {
      remove: function () {
        removedLabels++;
      },
      update: function () {},
      destroy: function () {},
    };
    const candidate = createTestCandidate("city", undefined);
    candidate.tileZ = 12;
    candidate.label = {};
    manager._visibleCandidates.push(candidate);

    manager.beginFrame({ frameNumber: 1 });
    manager.endFrame({ frameNumber: 1 });

    expect(removedLabels).toBe(1);
    expect(manager._visibleCandidates.length).toBe(0);
    manager.destroy();
  });

  it("evaluates label style zoom from the camera display level", function () {
    const manager = new MvtLabelManager({
      scene: undefined,
      styles: [{ textField: "name", minZoom: 5 }],
      transitionDuration: 0,
    });
    let addedLabels = 0;
    manager._labelCollection = {
      add: function () {
        addedLabels++;
        return {};
      },
      remove: function () {},
      update: function () {},
      destroy: function () {},
    };
    const tile = {
      _selectedFrame: 1,
      computedTransform: Matrix4.IDENTITY,
    };
    const candidate = createTestCandidate("city", undefined);
    candidate.tileX = 6;
    candidate.tileY = 4;
    candidate.tileZ = 5;
    manager.addTile(tile, { tileX: 6, tileY: 4, tileZ: 5 }, [candidate]);

    manager.beginFrame({ frameNumber: 1 });
    manager._displayZoom = 4;
    manager.submitSelectedTiles({ frameNumber: 1 });
    manager.endFrame({ frameNumber: 1 });

    expect(addedLabels).toBe(0);
    manager.destroy();
  });

  it("submits selected tiles instead of a higher cached level", function () {
    const manager = new MvtLabelManager({
      scene: undefined,
      styles: [{ textField: "name" }],
    });
    const selectedTile = { _selectedFrame: 7, computedTransform: {} };
    const unselectedTile = { _selectedFrame: 6, computedTransform: {} };
    const selectedCandidate = {};
    const unselectedCandidate = {};
    manager.addTile(selectedTile, tileCoordinates, [selectedCandidate]);
    manager.addTile(unselectedTile, { tileX: 6, tileY: 4, tileZ: 5 }, [
      unselectedCandidate,
    ]);

    manager.beginFrame({ frameNumber: 7 });
    manager._displayZoom = 5;
    manager.submitSelectedTiles({ frameNumber: 7 });

    expect(manager._frameCandidates).toEqual([selectedCandidate]);
    manager.destroy();
  });

  it("keeps a parent label while the next zoom generation is partial", function () {
    const manager = new MvtLabelManager({
      scene: undefined,
      styles: [{ textField: "name" }],
      transitionDuration: 0,
    });
    manager._labelCollection = {
      add: function () {
        return {};
      },
      remove: function () {},
      update: function () {},
      destroy: function () {},
    };
    const parentCandidate = createTestCandidate("beijing", "parent/beijing");
    const childCandidate = createTestCandidate("tianjin", "child/tianjin");
    childCandidate.text = "Tianjin";
    childCandidate.tileX = 6;
    childCandidate.tileY = 4;
    childCandidate.tileZ = 5;
    const parentTile = {
      _selectedFrame: 1,
      computedTransform: Matrix4.IDENTITY,
    };
    const childTile = {
      _selectedFrame: 0,
      computedTransform: Matrix4.IDENTITY,
    };
    manager.addTile(parentTile, tileCoordinates, [parentCandidate]);
    manager.addTile(childTile, { tileX: 6, tileY: 4, tileZ: 5 }, [
      childCandidate,
    ]);

    manager.beginFrame({ frameNumber: 1 });
    manager._displayZoom = 3;
    manager.submitSelectedTiles({ frameNumber: 1 });
    manager.endFrame({ frameNumber: 1 });
    expect(manager._visibleCandidates).toEqual([parentCandidate]);

    parentTile._selectedFrame = 2;
    childTile._selectedFrame = 2;
    manager.beginFrame({ frameNumber: 2 });
    manager._displayZoom = 4;
    manager.submitSelectedTiles({ frameNumber: 2 });
    manager.endFrame({ frameNumber: 2 });
    expect(manager._visibleCandidates).toContain(parentCandidate);
    expect(manager._visibleCandidates).toContain(childCandidate);
    manager.destroy();
  });

  it("prefers a selected child over its selected parent duplicate", function () {
    const manager = new MvtLabelManager({
      scene: undefined,
      styles: [{ textField: "name" }],
      transitionDuration: 0,
    });
    manager._labelCollection = {
      add: function () {
        return {};
      },
      remove: function () {},
      update: function () {},
      destroy: function () {},
    };
    const parentCandidate = createTestCandidate("parent", "place/beijing");
    const childCandidate = createTestCandidate("child", "place/beijing");
    childCandidate.tileX = 6;
    childCandidate.tileY = 4;
    childCandidate.tileZ = 5;
    manager.addTile(
      { _selectedFrame: 1, computedTransform: Matrix4.IDENTITY },
      tileCoordinates,
      [parentCandidate],
    );
    manager.addTile(
      { _selectedFrame: 1, computedTransform: Matrix4.IDENTITY },
      { tileX: 6, tileY: 4, tileZ: 5 },
      [childCandidate],
    );

    manager.beginFrame({ frameNumber: 1 });
    manager._displayZoom = 5;
    manager.submitSelectedTiles({ frameNumber: 1 });
    manager.endFrame({ frameNumber: 1 });

    expect(manager._visibleCandidates).toEqual([childCandidate]);
    manager.destroy();
  });

  it("removes evicted candidates from active label lists", function () {
    const manager = new MvtLabelManager({ scene: undefined, styles: [] });
    const candidate = { label: undefined };
    const entry = manager.addTile({}, tileCoordinates, [candidate]);
    manager._frameCandidates.push(candidate);
    manager._visibleCandidates.push(candidate);

    manager.removeTile(entry);
    manager.beginFrame({ frameNumber: 1 });

    expect(manager._frameCandidates.length).toBe(0);
    expect(manager._visibleCandidates.length).toBe(0);
    manager.destroy();
  });

  it("rebuilds an oversized glyph cache and resets label handles", function () {
    const manager = new MvtLabelManager({
      scene: undefined,
      styles: [{ textField: "name" }],
      maximumCachedGlyphs: 1,
    });
    const candidate = createTestCandidate("city", "place/city");
    candidate.label = {};
    candidate.appliedOpacity = 1;
    manager.addTile({}, tileCoordinates, [candidate]);
    manager._labelCollection = {
      _glyphBillboardCollection: {
        billboardTextureCache: new Map([
          ["A", {}],
          ["B", {}],
        ]),
      },
      destroy: function () {
        return undefined;
      },
    };

    manager.beginFrame({ frameNumber: 1 });

    expect(candidate.label).toBeUndefined();
    expect(candidate.appliedOpacity).toBeUndefined();
    expect(manager._labelCollectionRebuilds).toBe(1);
    manager.destroy();
  });

  it("uses padded collisions and clamps labels to ground by default", function () {
    const manager = new MvtLabelManager({
      scene: undefined,
      styles: [{ textField: "name" }],
    });

    expect(manager._styles[0].collisionPadding.x).toBe(6);
    expect(manager._styles[0].collisionPadding.y).toBe(6);
    expect(manager._heightReference).toBe(HeightReference.CLAMP_TO_GROUND);
    manager.destroy();
  });

  it("shows loaded labels immediately without a scene", function () {
    const manager = new MvtLabelManager({
      scene: undefined,
      styles: [{ textField: "name" }],
      transitionDuration: 0.2,
      transitionSteps: 4,
    });
    let timestamp = 0;
    manager._getTimestamp = function () {
      return timestamp;
    };
    const label = {};
    let removedLabels = 0;
    manager._labelCollection = {
      add: function () {
        return label;
      },
      remove: function () {
        removedLabels++;
      },
      update: function () {},
      destroy: function () {},
    };
    const tile = { _selectedFrame: 1, computedTransform: Matrix4.IDENTITY };
    const candidate = {
      x: 0.5,
      y: 0.5,
      text: "Beijing",
      styleIndex: 0,
      stylePriority: 0,
      tileX: 3,
      tileY: 2,
      tileZ: 4,
      sortKey: "beijing",
    };
    manager.addTile(tile, tileCoordinates, [candidate]);

    manager.beginFrame({ frameNumber: 1 });
    manager.submitSelectedTiles({ frameNumber: 1 });
    manager.endFrame({ frameNumber: 1 });
    expect(label.show).toBe(true);
    expect(label.fillColor.alpha).toBe(1);

    tile._selectedFrame = 2;
    timestamp = 200;
    manager.beginFrame({ frameNumber: 2 });
    manager.submitSelectedTiles({ frameNumber: 2 });
    manager.endFrame({ frameNumber: 2 });
    expect(label.show).toBe(true);
    expect(label.fillColor.alpha).toBe(1);

    timestamp = 300;
    manager.beginFrame({ frameNumber: 3 });
    manager.endFrame({ frameNumber: 3 });
    expect(removedLabels).toBe(1);
    manager.destroy();
  });

  it("requests another frame while initial glyphs are loading", function () {
    const manager = new MvtLabelManager({
      scene: undefined,
      styles: [{ textField: "name" }],
    });
    manager._labelCollection = {
      _glyphBillboardCollection: {
        billboardTextureCache: new Map([
          ["Beijing", { loadState: BillboardLoadState.LOADING }],
        ]),
      },
      update: function () {},
      destroy: function () {
        return undefined;
      },
    };
    const frameState = { frameNumber: 1, afterRender: [] };

    manager.beginFrame(frameState);
    manager.endFrame(frameState);

    expect(frameState.afterRender.length).toBe(1);
    expect(frameState.afterRender[0]()).toBe(true);
    manager.destroy();
  });

  it("keeps an outgoing label visible during its fade", function () {
    const manager = new MvtLabelManager({
      scene: { requestRender: function () {} },
      styles: [{ textField: "name" }],
      transitionDuration: 0.2,
      transitionSteps: 4,
    });
    let removedLabels = 0;
    manager._labelCollection = {
      remove: function () {
        removedLabels++;
      },
      destroy: function () {},
    };
    const candidate = createTestCandidate("old", "place/old");
    candidate.label = {};
    candidate.opacity = 1;
    candidate.appliedOpacity = 1;
    candidate.transitionTargetOpacity = 1;
    manager._visibleCandidates.push(candidate);

    manager._retireCandidate(candidate, 0);
    expect(candidate.label).toBeDefined();
    expect(manager._retiringCandidates).toEqual([candidate]);

    manager._updateTransitions(100);
    expect(candidate.label.show).toBe(true);
    expect(candidate.opacity).toBe(0.5);

    manager._updateTransitions(200);
    expect(removedLabels).toBe(1);
    expect(candidate.label).toBeUndefined();
    manager.destroy();
  });

  it("never creates a fully transparent incoming label", function () {
    const manager = new MvtLabelManager({
      scene: { requestRender: function () {} },
      styles: [{ textField: "name" }],
      transitionDuration: 0.2,
      transitionSteps: 4,
    });
    manager._labelCollection = {
      destroy: function () {},
    };
    const candidate = createTestCandidate("new", "place/new");
    candidate.label = {};

    manager._activateCandidate(candidate, manager._styles[0], 0);

    expect(candidate.label.show).toBe(true);
    expect(candidate.opacity).toBe(0.25);
    manager.destroy();
  });

  it("reuses a stable label across adjacent zoom tiles", function () {
    const manager = new MvtLabelManager({
      scene: undefined,
      styles: [{ textField: "name" }],
      transitionDuration: 0,
    });
    let timestamp = 0;
    manager._getTimestamp = function () {
      return timestamp;
    };
    const label = {};
    let addedLabels = 0;
    manager._labelCollection = {
      add: function () {
        addedLabels++;
        return label;
      },
      remove: function () {},
      update: function () {},
      destroy: function () {},
    };
    const parentTile = {
      _selectedFrame: 1,
      computedTransform: Matrix4.IDENTITY,
    };
    const childTile = {
      _selectedFrame: 0,
      computedTransform: Matrix4.IDENTITY,
    };
    const parentCandidate = createTestCandidate("parent", "places/0/19");
    const childCandidate = createTestCandidate("child", "places/0/19");
    childCandidate.tileX = 6;
    childCandidate.tileY = 4;
    childCandidate.tileZ = 5;
    manager.addTile(parentTile, tileCoordinates, [parentCandidate]);
    manager.addTile(
      childTile,
      { tileX: childCandidate.tileX, tileY: childCandidate.tileY, tileZ: 5 },
      [childCandidate],
    );

    manager.beginFrame({ frameNumber: 1 });
    manager._displayZoom = 3;
    manager.submitSelectedTiles({ frameNumber: 1 });
    manager.endFrame({ frameNumber: 1 });

    parentTile._selectedFrame = 1;
    childTile._selectedFrame = 2;
    timestamp = 100;
    manager.beginFrame({ frameNumber: 2 });
    manager._displayZoom = 4;
    manager.submitSelectedTiles({ frameNumber: 2 });
    manager.endFrame({ frameNumber: 2 });

    expect(addedLabels).toBe(1);
    expect(parentCandidate.label).toBeUndefined();
    expect(childCandidate.label).toBe(label);
    manager.destroy();
  });

  function createTestCandidate(sortKey, dedupeId) {
    return {
      x: 0.5,
      y: 0.5,
      text: "Beijing",
      styleIndex: 0,
      stylePriority: 0,
      tileX: 3,
      tileY: 2,
      tileZ: 4,
      dedupeId,
      sortKey,
    };
  }
});
