export const deviceTypes = [
  "conveyor",
  "lift_table",
  "material_source_station",
  "robot_arm",
  "rotary_table",
  "storage_rack",
  "workpiece",
  "workpiece_carrier",
] as const;
export type DeviceType = (typeof deviceTypes)[number];
export type ParamValue = string | number | boolean;
export type Vec3 = [number, number, number];
export interface Transform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}
export interface ParameterSpec {
  type: "number" | "integer" | "boolean" | "string" | "enum";
  default?: ParamValue;
  required?: boolean;
  min?: number;
  max?: number;
  unit?: string;
  options?: ParamValue[];
  description?: string;
  required_when?: { parameter: string; equals: ParamValue };
  mutability?: "stopped_only" | "runtime_setpoint";
}
export interface SignalPort {
  id: string;
  direction: "input" | "output" | "inout";
  valueType: string;
  description: string;
}
export interface Condition {
  id: string;
  label: string;
  source: "parameter" | "observation" | "authorization";
  key: string;
  equals: ParamValue;
}
export interface BehaviorContract {
  id: string;
  label: string;
  kind: "action" | "service" | "passive" | "observer" | "internal";
  executorRef: string;
  arguments: Record<string, ParameterSpec>;
  requiredInterfaces: string[];
  preconditions: Condition[];
  completion: string;
  completionChecks: Condition[];
}
export interface DeviceDefinition {
  specId: string;
  revision: string;
  name: string;
  deviceType: DeviceType;
  description: string;
  template: boolean;
  asset: { assetId?: string; sourceKey?: string; rootNode?: string };
  paramsSchema: Record<string, ParameterSpec>;
  typeSpecificContract: Record<string, unknown>;
  interfaces: SignalPort[];
  behaviors: BehaviorContract[];
  source?: Record<string, unknown>;
  diagnostics: string[];
}
export interface DeviceInstance {
  instanceId: string;
  specId: string;
  specRevision: string;
  name: string;
  visible: boolean;
  transform: Transform;
  paramOverrides: Record<string, ParamValue>;
  bindings: Record<string, string>;
}
export interface AssetRecord {
  id: string;
  name: string;
  kind: "glb";
  size: number;
}
export interface ProjectDocument {
  format: "agentic-workbench";
  version: 1;
  id: string;
  name: string;
  revision: number;
  definitions: DeviceDefinition[];
  instances: DeviceInstance[];
  assets: AssetRecord[];
  plc: string;
}
export const typeLabels: Record<DeviceType, string> = {
  conveyor: "传送带",
  lift_table: "升降台",
  material_source_station: "出料口",
  robot_arm: "机械臂",
  rotary_table: "旋转台",
  storage_rack: "仓储柜",
  workpiece: "物料",
  workpiece_carrier: "物料托盘",
};
