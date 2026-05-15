import { createTaskProcessorWorker } from "@hztxi/cesium-engine";

export default createTaskProcessorWorker(function (parameters) {
  return parameters.byteLength;
});
