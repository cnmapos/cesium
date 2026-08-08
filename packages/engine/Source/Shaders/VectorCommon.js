//This file is automatically rebuilt by the Cesium build process.
export default "uniform highp sampler2D u_vectorSegmentTexture;\n\
uniform highp sampler2D u_vectorWidthTexture;\n\
uniform highp sampler2D u_vectorColorTexture;\n\
uniform highp sampler2D u_vectorSegmentPrimitiveIndicesTexture;\n\
uniform highp sampler2D u_vectorGridCellIndicesTexture;\n\
uniform highp sampler2D u_vectorPolygonEdgeTexture;\n\
uniform highp sampler2D u_vectorPolygonEdgePrimitiveIndicesTexture;\n\
uniform highp sampler2D u_vectorPolygonGridCellIndicesTexture;\n\
\n\
// UV-space offset from the closest point on the segment to p.\n\
vec2 vectorOffsetToLine(vec2 p, vec4 line)\n\
{\n\
    vec2 a = line.xy;\n\
    vec2 b = line.zw;\n\
    vec2 ab = b - a;\n\
    float abLengthSquared = dot(ab, ab);\n\
    if (abLengthSquared < 1.0e-8)\n\
    {\n\
        return p - a;\n\
    }\n\
    float t = clamp(dot(p - a, ab) / abLengthSquared, 0.0, 1.0);\n\
    return p - (a + t * ab);\n\
}\n\
\n\
ivec2 vectorIndexToUv(int index, ivec2 size)\n\
{\n\
    int v = index / size.x;\n\
    int u = index - v * size.x;\n\
    return ivec2(u, v);\n\
}\n\
\n\
// Drape clamped vector polylines onto the terrain surface. The fragment's\n\
// tile UV picks a grid cell, then only that cell's line segments (packed in\n\
// tile-local UV space) are tested for proximity. Within the line width, the\n\
// vector color is alpha-composited over the terrain (no discard).\n\
vec4 vectorPolylineRender(vec2 vectorUv, vec4 baseColor)\n\
{\n\
    // A tile without polylines binds a 1x1 placeholder; a real grid header\n\
    // [gridWidth, gridHeight, ...] is at least 3 texels.\n\
    ivec2 headerSize = textureSize(u_vectorGridCellIndicesTexture, 0);\n\
    if (headerSize.x * headerSize.y < 3)\n\
    {\n\
        return baseColor;\n\
    }\n\
\n\
    // Inverse UV-per-pixel Jacobian: measures line distance in screen pixels so\n\
    // width stays constant under anisotropic (oblique) foreshortening.\n\
    mat2 screenFromUv = inverse(mat2(dFdx(vectorUv), dFdy(vectorUv)));\n\
    int gridWidth = int(texelFetch(u_vectorGridCellIndicesTexture, vectorIndexToUv(0, headerSize), 0).r);\n\
    int gridHeight = int(texelFetch(u_vectorGridCellIndicesTexture, vectorIndexToUv(1, headerSize), 0).r);\n\
    int cellX = clamp(int(vectorUv.x * float(gridWidth)), 0, gridWidth - 1);\n\
    int cellY = clamp(int(vectorUv.y * float(gridHeight)), 0, gridHeight - 1);\n\
    int cellIndex = cellX + cellY * gridWidth;\n\
\n\
    // Cell end offsets follow the two gridWidth/gridHeight texels, so cell\n\
    // N's end is at texel N + 2. A cell's start is the previous cell's end\n\
    // (texel N + 1); cell 0's start is implicitly 0.\n\
    int indexEnd = int(texelFetch(u_vectorGridCellIndicesTexture, vectorIndexToUv(cellIndex + 2, headerSize), 0).r);\n\
    int indexStart = cellIndex == 0\n\
        ? 0\n\
        : int(texelFetch(u_vectorGridCellIndicesTexture, vectorIndexToUv(cellIndex + 1, headerSize), 0).r);\n\
\n\
    ivec2 segmentTextureSize = textureSize(u_vectorSegmentTexture, 0);\n\
    ivec2 primitiveTextureSize = textureSize(u_vectorWidthTexture, 0);\n\
\n\
    for (int i = indexStart; i < indexEnd; i++)\n\
    {\n\
        ivec2 segmentUv = vectorIndexToUv(i, segmentTextureSize);\n\
        vec4 segment = texelFetch(u_vectorSegmentTexture, segmentUv, 0);\n\
\n\
        int primitiveIndex = int(texelFetch(u_vectorSegmentPrimitiveIndicesTexture, segmentUv, 0).r);\n\
        ivec2 primitiveUv = vectorIndexToUv(primitiveIndex, primitiveTextureSize);\n\
\n\
        float lineWidth = texelFetch(u_vectorWidthTexture, primitiveUv, 0).r * 255.0;\n\
\n\
        vec2 offsetUv = vectorOffsetToLine(vectorUv, segment);\n\
        if (length(screenFromUv * offsetUv) < lineWidth)\n\
        {\n\
            // Alpha-composite vector over terrain.\n\
            vec4 vectorColor = texelFetch(u_vectorColorTexture, primitiveUv, 0);\n\
            baseColor = vectorColor * vec4(vectorColor.aaa, 1.0) + baseColor * (1.0 - vectorColor.a);\n\
            break;\n\
        }\n\
    }\n\
\n\
    return baseColor;\n\
}\n\
\n\
// Composites a polygon's fill over baseColor when the pixel is inside it. A\n\
// negative index (empty cell or first iteration) or an outside pixel is a\n\
// no-op.\n\
vec4 vectorCompositePolygonFill(vec4 baseColor, int primitiveIndex, bool inside, ivec2 primitiveTextureSize)\n\
{\n\
    if (!inside || primitiveIndex < 0)\n\
    {\n\
        return baseColor;\n\
    }\n\
\n\
    ivec2 primitiveUv = vectorIndexToUv(primitiveIndex, primitiveTextureSize);\n\
    vec4 fillColor = texelFetch(u_vectorColorTexture, primitiveUv, 0);\n\
    return fillColor * vec4(fillColor.aaa, 1.0) + baseColor * (1.0 - fillColor.a);\n\
}\n\
\n\
// True if a horizontal +x ray from p crosses the edge. The half-open interval\n\
// (> vs <=) counts a ray through a shared vertex exactly once.\n\
bool vectorEdgeCrossesRay(vec4 edge, vec2 p)\n\
{\n\
    if ((edge.y > p.y) == (edge.w > p.y))\n\
    {\n\
        return false;\n\
    }\n\
\n\
    float t = (p.y - edge.y) / (edge.w - edge.y);\n\
    float xIntersect = edge.x + t * (edge.z - edge.x);\n\
    return p.x < xIntersect;\n\
}\n\
\n\
// Drape clamped vector polygon fills onto the terrain surface. The fragment's\n\
// tile UV picks a grid cell whose edges were clipped to the cell on the CPU,\n\
// forming closed loops, so an even-odd horizontal ray cast within the cell\n\
// decides coverage. Edges arrive grouped by primitive; each covering\n\
// primitive's fill color is alpha-composited in primitive order (no discard).\n\
vec4 vectorPolygonRender(vec2 vectorUv, vec4 baseColor)\n\
{\n\
    // A tile without polygons binds a 1x1 placeholder; a real grid header\n\
    // [gridWidth, gridHeight, ...] is at least 3 texels.\n\
    ivec2 headerSize = textureSize(u_vectorPolygonGridCellIndicesTexture, 0);\n\
    if (headerSize.x * headerSize.y < 3)\n\
    {\n\
        return baseColor;\n\
    }\n\
\n\
    int gridWidth = int(texelFetch(u_vectorPolygonGridCellIndicesTexture, vectorIndexToUv(0, headerSize), 0).r);\n\
    int gridHeight = int(texelFetch(u_vectorPolygonGridCellIndicesTexture, vectorIndexToUv(1, headerSize), 0).r);\n\
    int cellX = clamp(int(vectorUv.x * float(gridWidth)), 0, gridWidth - 1);\n\
    int cellY = clamp(int(vectorUv.y * float(gridHeight)), 0, gridHeight - 1);\n\
    int cellIndex = cellX + cellY * gridWidth;\n\
\n\
    // Cell end offsets follow the two gridWidth/gridHeight texels, so cell\n\
    // N's end is at texel N + 2. A cell's start is the previous cell's end\n\
    // (texel N + 1); cell 0's start is implicitly 0.\n\
    int indexEnd = int(texelFetch(u_vectorPolygonGridCellIndicesTexture, vectorIndexToUv(cellIndex + 2, headerSize), 0).r);\n\
    int indexStart = cellIndex == 0\n\
        ? 0\n\
        : int(texelFetch(u_vectorPolygonGridCellIndicesTexture, vectorIndexToUv(cellIndex + 1, headerSize), 0).r);\n\
\n\
    ivec2 edgeTextureSize = textureSize(u_vectorPolygonEdgeTexture, 0);\n\
    ivec2 primitiveTextureSize = textureSize(u_vectorColorTexture, 0);\n\
\n\
    int currentPrimitive = -1;\n\
    bool inside = false;\n\
\n\
    for (int i = indexStart; i < indexEnd; i++)\n\
    {\n\
        ivec2 edgeUv = vectorIndexToUv(i, edgeTextureSize);\n\
        vec4 edge = texelFetch(u_vectorPolygonEdgeTexture, edgeUv, 0);\n\
        int primitiveIndex = int(texelFetch(u_vectorPolygonEdgePrimitiveIndicesTexture, edgeUv, 0).r);\n\
\n\
        // A new primitive means the previous group is complete: composite it,\n\
        // then start counting the new one fresh.\n\
        if (primitiveIndex != currentPrimitive)\n\
        {\n\
            baseColor = vectorCompositePolygonFill(baseColor, currentPrimitive, inside, primitiveTextureSize);\n\
            currentPrimitive = primitiveIndex;\n\
            inside = false;\n\
        }\n\
\n\
        if (vectorEdgeCrossesRay(edge, vectorUv))\n\
        {\n\
            inside = !inside;\n\
        }\n\
    }\n\
\n\
    // The last primitive group has no trailing edge to trigger its composite.\n\
    baseColor = vectorCompositePolygonFill(baseColor, currentPrimitive, inside, primitiveTextureSize);\n\
\n\
    return baseColor;\n\
}\n\
";
