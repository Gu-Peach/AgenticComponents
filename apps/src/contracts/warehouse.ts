import type { Vec3, SceneDevice } from "./scene-execution";
export interface WarehouseLocation {
  id: string;
  owner: string;
  position: Vec3;
  support: string;
  size: Vec3;
  kind: "slot" | "conveyor" | "platform";
}
export interface WarehouseAssembly {
  rail: string;
  lift: string;
  axis: Vec3;
  vertical: Vec3;
  anchor: Vec3;
  platform: string;
  mast: string;
  tool: string;
  railLimits: [number, number];
  liftLimits: [number, number];
  railSpeed: number;
  railAccel: number;
  liftSpeed: number;
  liftAccel: number;
  transferSpeed: number;
  transferAccel: number;
  maxTransfer: number;
  restHeight: number;
  routes: { sources: string[]; targets: string[] }[];
}
export interface WarehouseConfig {
  jobs: {
    id: string;
    material: string;
    input: string;
    slot: string;
    target: string;
  }[];
  locations: Map<string, WarehouseLocation>;
  assemblies: WarehouseAssembly[];
  conveyors: Map<
    string,
    { entry: string; exit: string; flow: Vec3; speed: number }
  >;
  materials: Map<string, { body: string; size: Vec3 }>;
  source: string;
}
export type WarehouseDevice = SceneDevice & {
  transfer_routes?: WarehouseAssembly["routes"];
};
