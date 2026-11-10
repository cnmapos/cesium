import MVTDataProvider from "../../Source/Scene/MVTDataProvider.js";
import Empty3DTileContent from "../../Source/Scene/Empty3DTileContent.js";

describe("Scene/MVTDataProvider", function () {
  it("uses standard MVT defaults for generic tile services", function () {
    const provider = new MVTDataProvider(
      "https://example.invalid/{z}/{x}/{y}",
      {},
    );

    expect(provider._format).toBe("mvt");
    expect(provider._maxZoom).toBe(14);
    expect(provider._maximumConcurrentRequests).toBe(12);
    expect(provider._createTilesetLoadOptions().projectTo2D).toBeUndefined();
    expect(provider._labelTransitionDuration).toBe(0.2);
    expect(provider._labelTransitionSteps).toBe(4);
    expect(provider._maximumRetiringLabels).toBe(512);
    expect(provider._maximumLabelsPerTile).toBe(4096);
    expect(provider._maximumCachedGlyphs).toBe(2048);
    expect(provider._minimumRebuildInterval).toBeUndefined();
    expect(provider._maximumVisibleLabels).toBeUndefined();
    expect(provider._usesAdaptiveScreenSpaceError).toBe(false);
    provider.destroy();
  });

  it("uses bounded cache defaults for labels-only providers", function () {
    const provider = new MVTDataProvider(
      "https://example.invalid/{z}/{x}/{y}",
      {
        renderGeometry: false,
      },
    );
    const options = provider._createTilesetLoadOptions();

    expect(options.cacheBytes).toBe(64 * 1024 * 1024);
    expect(options.maximumCacheOverflowBytes).toBe(16 * 1024 * 1024);
    provider.destroy();
  });

  it("passes explicit cache limits to the backing tileset", function () {
    const provider = new MVTDataProvider(
      "https://example.invalid/{z}/{x}/{y}",
      {
        cacheBytes: 1024,
        maximumCacheOverflowBytes: 256,
      },
    );
    const options = provider._createTilesetLoadOptions();

    expect(options.cacheBytes).toBe(1024);
    expect(options.maximumCacheOverflowBytes).toBe(256);
    provider.destroy();
  });

  it("inherits globe uniform-level mode each frame", function () {
    const uniformLevelMode = {
      enabled: true,
      reference: "center",
      maxDeviationLevels: 1,
      maxCoarsenLevels: 1,
    };
    const provider = new MVTDataProvider(
      "https://example.invalid/{z}/{x}/{y}",
      {
        inheritGlobeUniformLevelMode: true,
        scene: {
          globe: {
            uniformLevelMode,
          },
        },
      },
    );
    provider._tileset = {
      destroy: function () {
        return undefined;
      },
    };

    provider.update({ frameNumber: 1 });

    expect(provider._tileset.uniformLevelMode).toBe(uniformLevelMode);
    provider.destroy();
  });

  it("supports a generic MVT URL with an extension and query parameters", function () {
    expect(
      MVTDataProvider._parseTileCoordinates(
        "https://example.invalid/tiles/2/1/3.pbf?access_token=test",
      ),
    ).toEqual({
      tileZ: 2,
      tileX: 1,
      tileY: 3,
    });
  });

  it("preserves an explicitly configured maximum zoom for GeoVis", function () {
    const provider = new MVTDataProvider(
      "https://example.invalid/{z}/{x}/{y}",
      {
        format: "geovis",
        maxZoom: 29,
      },
    );

    expect(provider._maxZoom).toBe(29);
    provider.destroy();
  });

  it("passes glyph budget limits to the label manager", function () {
    const provider = new MVTDataProvider(
      "https://example.invalid/{z}/{x}/{y}",
      {
        labelStyles: [{ textField: "name" }],
        maximumCachedGlyphs: 512,
        minimumRebuildInterval: 30,
        glyphReclaimMargin: 64,
        maximumVisibleLabels: 250,
      },
    );
    provider._configureTileset({});
    const labelManager = provider._labelManager;

    expect(labelManager._maximumCachedGlyphs).toBe(512);
    expect(labelManager._minimumRebuildInterval).toBe(30);
    expect(labelManager._glyphReclaimMargin).toBe(64);
    expect(labelManager._maximumVisibleLabels).toBe(250);
    provider.destroy();
  });

  it("keeps labels-only tile content renderable", function () {
    const labelEntry = {};
    const labelManager = {
      addTile: jasmine.createSpy("addTile").and.returnValue(labelEntry),
      removeTile: jasmine.createSpy("removeTile"),
    };
    const tile = {};
    const tileCoordinates = { tileX: 22, tileY: 14, tileZ: 5 };
    const candidates = [{ text: "Beijing" }];
    const LabelContent = MVTDataProvider._MvtLabel3DTileContent;
    const content = new LabelContent(
      {},
      tile,
      {
        getUrlComponent: function () {
          return "5/22/14.pbf";
        },
      },
      labelManager,
      candidates,
      tileCoordinates,
    );

    expect(content instanceof Empty3DTileContent).toBe(false);
    expect(content.ready).toBe(true);
    expect(content.url).toBe("5/22/14.pbf");
    expect(content.geometryByteLength).toBe(0);
    expect(content.batchTableByteLength).toBeGreaterThan(0);
    expect(labelManager.addTile).toHaveBeenCalledWith(
      tile,
      tileCoordinates,
      candidates,
    );

    content.destroy();
    expect(labelManager.removeTile).toHaveBeenCalledWith(labelEntry);
  });
});
