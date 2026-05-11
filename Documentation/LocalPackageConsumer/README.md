# 将本地 CesiumJS 源码作为依赖使用（npm / pnpm / Vite）

本文说明：在本仓库完成安装与构建后，如何在**其它本地项目**中通过软链或本地路径使用这份 Cesium，行为与使用 npm 上的 `cesium` 包一致，并记录常见问题。

---

## 一、在本仓库（Cesium 源码根目录）

### 1. 安装依赖

若遇到 `onnxruntime-node` 安装脚本因 HTTP 302 失败，可跳过其原生下载：

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm install
```

若 `prepare` 里触发 `playwright install --with-deps` 与系统 **apt** 抢锁失败，可临时跳过 Playwright 安装（本地先装全依赖）：

```bash
CI=true ONNXRUNTIME_NODE_INSTALL=skip npm install
```

之后如需 E2E，在 apt 空闲时执行：

```bash
npx playwright install --with-deps
```

### 2. 构建发布用产物（含 `Build/Cesium`）

其它项目里常见写法为：

```js
import "cesium/Build/Cesium/Widgets/widgets.css";
```

该路径依赖 **`Build/Cesium`** 目录，需执行：

```bash
npm run build-release
```

说明：仅执行默认的 `npm run build` 时，通常主要生成 **`Build/CesiumUnminified`**；若你改用未压缩目录，请将 CSS 路径改为：

```js
import "cesium/Build/CesiumUnminified/Widgets/widgets.css";
```

构建完成后可自检：

```bash
ls Build/Cesium/Widgets/widgets.css
```

---

## 二、在其它项目中接入本地 Cesium

### 1. 推荐：`pnpm link`（在 Cesium 源码根目录登记，在业务项目里链接）

**在 Cesium 源码根目录：**

```bash
pnpm link
```

成功时可见类似：`cesium 1.x.x <- .../wanglei/codes/cesium`，表示全局可链接目录已指向当前源码。

**在业务 monorepo 根目录（或目标 workspace）：**

```bash
pnpm link cesium
```

若依赖在子包（例如 `@hztx/core`），建议对子包执行：

```bash
pnpm link cesium --filter @hztx/core
pnpm link cesium --filter @hztx/app
```

并在**真正 `import "cesium"` 的包**的 `package.json` 的 `dependencies` 中声明 `"cesium": "..."`（版本或与根一致），否则 pnpm 解析可能不符合预期。

### 2. 备选：`package.json` 中 `link:` / `file:` 直指源码根

避免把路径写死到 pnpm global 深层目录（例如 `.../global/5/node_modules/cesium`），该路径会随 pnpm 版本变化。

推荐相对路径指向 Cesium 源码根（与 `package.json` 同级须有本仓库的 `package.json`）：

```json
"dependencies": {
  "cesium": "link:../cesium"
}
```

或使用绝对路径（仅本机）：

```json
"dependencies": {
  "cesium": "file:/home/你的用户/wanglei/codes/cesium"
}
```

修改后删除旧安装并重装，例如：

```bash
rm -rf packages/app/node_modules/cesium packages/core/node_modules/cesium
pnpm install
```

### 3. 使用 `npm link`（非 pnpm 时）

在 Cesium 根目录：`npm link`  
在业务项目：`npm link cesium`  
注意：若之后在业务项目执行会重写 `node_modules` 的 `npm install`，可能冲掉 link，需再执行一次 `npm link cesium`，或改用 `file:`。

---

## 三、确认当前解析到的是哪一份 Cesium

在**安装了 `cesium` 的包目录**下（例如 `packages/app` 或 `packages/core`）：

```bash
ls -la node_modules/cesium
readlink -f node_modules/cesium
ls "$(readlink -f node_modules/cesium)/Build/Cesium/Widgets/widgets.css"
```

- 若 `readlink -f` 最终路径**不是**你的 Cesium 源码根目录，则 Vite/打包仍读的是另一份安装，不会出现你在本仓库 `build-release` 的文件。
- 第三行能列出 `widgets.css`，说明路径与构建产物正确。

---

## 四、Vite 项目补充

若 Cesium 目录在 monorepo 之外或通过软链引用，开发服务器可能拦截对外部目录的读取，可在**消费应用**的 `vite.config` 中增加（路径改为你的 Cesium 根目录）：

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

const cesiumRoot = "/home/你的用户/wanglei/codes/cesium";

export default {
  server: {
    fs: {
      allow: [fileURLToPath(new URL(".", import.meta.url)), cesiumRoot],
    },
  },
  resolve: {
    preserveSymlinks: true,
  },
};
```

应用代码示例（与官方 README 一致）：

```js
import { Viewer } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
```

---

## 五、问题对照

| 现象                                                   | 处理方向                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `onnxruntime-node` … HTTP 302                          | `ONNXRUNTIME_NODE_INSTALL=skip npm install`                                |
| `prepare` / Playwright / apt 锁                        | `CI=true` 安装；稍后手动 `playwright install --with-deps`                  |
| 找不到 `Build/Cesium/.../widgets.css`                  | 在 Cesium 仓库执行 `npm run build-release`                                 |
| `readlink -f` 仍指向业务仓库内的 `node_modules/cesium` | 未链到源码：检查子包是否声明依赖；用 `link:`/`file:` 或 `pnpm link cesium` |
| 链到 global 路径易碎                                   | 改用 `link:../cesium` 或 `file:/绝对路径` 指向源码根                       |

---

## 六、与官方 npm 包的关系

从 npm 安装的 `cesium` 已带预构建资源。使用**本地源码**时，必须由你在本仓库完成 **`npm run build-release`**（或至少生成与 import 路径一致的 `Build/...`），其它项目才能解析到 `Widgets/widgets.css` 与 Worker 等静态文件。
