import { DeviceTemplateRegistry } from "./DeviceTemplateRegistry";
import { ConveyorTemplate } from "./conveyor/ConveyorTemplate";
export function registerTemplates() {
  const registry = new DeviceTemplateRegistry();
  registry.register(ConveyorTemplate);
  return registry;
}
