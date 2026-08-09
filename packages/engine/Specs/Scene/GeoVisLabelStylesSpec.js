import GeoVisLabelStyles from "../../Source/Scene/GeoVisLabelStyles.js";

describe("Scene/GeoVisLabelStyles", function () {
  it("covers GeoVis text layers from global to street zooms", function () {
    expect(GeoVisLabelStyles.length).toBeGreaterThan(0);
    expect(
      GeoVisLabelStyles.some(
        (style) =>
          style.sourceLayer === "O" &&
          style.textField === "{h}" &&
          style.minzoom === 0,
      ),
    ).toBe(true);
    expect(
      GeoVisLabelStyles.some(
        (style) =>
          style.sourceLayer === "H" &&
          style.textField === "{h}" &&
          style.maxzoom === 18,
      ),
    ).toBe(true);
    expect(
      GeoVisLabelStyles.some(
        (style) =>
          style.sourceLayer === "t_world_sj" && style.textField === "{h}",
      ),
    ).toBe(true);
    expect(
      GeoVisLabelStyles.every((style) => style.collisionPadding === 6),
    ).toBe(true);
    expect(
      GeoVisLabelStyles.filter((style) =>
        ["O", "ZP", "ZH"].includes(style.sourceLayer),
      ).every((style) => style.dedupeGroup === "place"),
    ).toBe(true);
  });
});
