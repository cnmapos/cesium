import MVTDataProvider from "../../Source/Scene/MVTDataProvider.js";
import Empty3DTileContent from "../../Source/Scene/Empty3DTileContent.js";

describe("Scene/MVTDataProvider", function () {
  it("uses the GeoVis label API's supported maximum zoom", function () {
    const provider = new MVTDataProvider(
      "https://example.invalid/{z}/{x}/{y}",
      {
        format: "geovis",
      },
    );

    expect(provider._maxZoom).toBe(18);
    expect(provider._maximumConcurrentRequests).toBe(12);
    expect(provider._labelTransitionDuration).toBe(0.2);
    expect(provider._labelTransitionSteps).toBe(4);
    expect(provider._maximumRetiringLabels).toBe(512);
    expect(provider._maximumLabelsPerTile).toBe(4096);
    expect(provider._maximumCachedGlyphs).toBe(2048);
    expect(provider._usesAdaptiveScreenSpaceError).toBe(true);
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

  it("clamps an unsupported GeoVis maximum zoom", function () {
    const provider = new MVTDataProvider(
      "https://example.invalid/{z}/{x}/{y}",
      {
        format: "geovis",
        maxZoom: 29,
      },
    );

    expect(provider._maxZoom).toBe(18);
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
