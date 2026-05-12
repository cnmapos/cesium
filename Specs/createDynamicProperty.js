import { ConstantProperty } from "@hztx/engine";

function createDynamicProperty(value) {
  const property = new ConstantProperty(value);
  Object.defineProperties(property, {
    isConstant: {
      value: false,
    },
  });
  return property;
}
export default createDynamicProperty;
