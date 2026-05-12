import { createTaskProcessorWorker } from "@hztx/engine";

export default createTaskProcessorWorker(function () {
  return function () {
    //functions are not cloneable
  };
});
