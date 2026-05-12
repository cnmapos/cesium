# @hztx/engine

[![Build Status][build-status-badge]][build-status-link]
[![npm][npm-badge]][npm-link]
[![Docs][docs-badge]][docs-link]

![Cesium][cesium-logo]

[CesiumJS](../../README.md) is a JavaScript library for creating 3D globes and 2D
maps in a web browser without a plugin. It uses WebGL for hardware-accelerated graphics,
and is cross-platform, cross-browser, and tuned for dynamic-data visualization.

`@hztx/engine` includes cesiumJS's core, rendering, and data APIs. Here you'll find
terrain and imagery engines, support for 3D Tiles and 3D models, geometries, and
vector data.

---

[**Examples**](https://sandcastle.cesium.com/) :earth_asia:
[**Docs**](https://cesium.com/learn/cesiumjs-learn/) :earth_americas:
[**Website**](https://cesium.com/cesiumjs) :earth_africa:
[**Forum**](https://community.cesium.com/) :earth_asia:
[**User Stories**](https://cesium.com/user-stories/)

---

## Install

`@hztx/engine` is published as ES modules with full typing support.

Install with npm:

```sh
npm install @hztx/engine --save
```

Or, install with yarn:

```sh
yarn add @hztx/engine
```

## Usage

Import individual modules to benefit from tree shaking optimizations through most
build tools:

```js
import { CesiumWidget } from "@hztx/engine";
import "@hztx/engine/Source/Widget/CesiumWidget.css";

const cesiumWidget = new CesiumWidget("cesiumContainer");
```

See our [Quickstart Guide](https://cesium.com/learn/cesiumjs-learn/cesiumjs-quickstart/)
for more information on getting a CesiumJS app up and running.

## Community

Have questions? Ask them on the [community forum](https://community.cesium.com/).

Interested in contributing? See [CONTRIBUTING.md](../../CONTRIBUTING.md). :heart:

## License

[Apache 2.0](http://www.apache.org/licenses/LICENSE-2.0.html).

CesiumJS is free for both commercial and non-commercial use.

[build-status-badge]: https://github.com/CesiumGS/cesium/actions/workflows/dev.yml/badge.svg
[build-status-link]: https://github.com/CesiumGS/cesium/actions/workflows/dev.yml
[npm-badge]: https://img.shields.io/npm/v/@hztx/engine
[npm-link]: https://www.npmjs.com/package/@hztx/engine
[docs-badge]: https://img.shields.io/badge/docs-online-orange.svg
[docs-link]: https://cesium.com/learn/
[cesium-logo]: https://github.com/CesiumGS/cesium/wiki/logos/Cesium_Logo_Color.jpg
