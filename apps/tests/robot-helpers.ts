import { readFileSync } from "node:fs";
import { normalizeDeviceSpec } from "../src/domain/normalizeDeviceSpec";
import { instantiate } from "../src/domain/catalog";
import { compileRobotArm } from "../src/domain/runtime/compileRobotArm";
import type { ProjectDocument } from "../src/contracts/device";
export const loadRobot = () =>
  normalizeDeviceSpec(
    JSON.parse(readFileSync("public/modles/robot_UR10/schema.json", "utf8")),
  );
export function robotSetup() {
  const def = loadRobot(),
    instance = instantiate(def, 0);
  instance.instanceId = "robot";
  instance.transform.position = [0, 0, 0];
  const project: ProjectDocument = {
    format: "agentic-workbench",
    version: 1,
    id: "robot-test",
    name: "robot-test",
    revision: 0,
    definitions: [def],
    instances: [instance],
    assets: [],
    plc: "",
  };
  return { def, instance, project, scene: compileRobotArm(def, instance, 0) };
}
