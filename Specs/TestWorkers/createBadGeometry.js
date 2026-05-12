import { createTaskProcessorWorker } from "@hztx/engine";

export default createTaskProcessorWorker(function () {
  throw new Error("BadGeometry.createGeometry");
});
