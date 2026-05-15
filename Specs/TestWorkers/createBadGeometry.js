import { createTaskProcessorWorker } from "@hztxi/cesium-engine";

export default createTaskProcessorWorker(function () {
  throw new Error("BadGeometry.createGeometry");
});
