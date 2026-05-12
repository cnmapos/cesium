import { createTaskProcessorWorker } from "@hztx/engine";

export default createTaskProcessorWorker(function returnWasmConfig(parameters) {
  const wasmConfig = parameters.webAssemblyConfig;
  return wasmConfig;
});
