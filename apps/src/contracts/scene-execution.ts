import type { SceneBundle } from "./scene-package";
import type { PhysicsConfig, BodyPose, RuntimeBody } from "./physics";
import type { CompiledRobotScene } from "./robot";
import type { ProcessNode } from "./process-ir";
export type Vec3 = [number, number, number];
export interface SceneDevice {
  instance_id: string;
  asset_kind?: string;
  creation_policy?: string;
  subject_id?: number;
  initial_supply?: string;
  prototype_ref?: string;
  contract: Record<string, unknown>;
  parameters: Record<string, number | string | boolean>;
  locations: Record<
    string,
    {
      position: Vec3;
      frame: string;
      owner?: string;
      reference?: string;
      rotation_quaternion?: [number, number, number, number];
      support_device?: string;
      support_layer?: string;
      material_pose?: {
        orientation_quaternion: [number, number, number, number];
        contact_frame?: string;
        reference?: string;
      };
    }
  >;
  node_binding: {
    status: string;
    owned_mesh_indices: number[];
    model_sha256: string;
  };
  geometry: {
    world_position: Vec3;
    world_rotation: [number, number, number, number];
    bounds: { min: Vec3; max: Vec3; size: Vec3 };
  };
}
export interface SceneLoad {
  id: string;
  items: ({ material: string; category?: string } & (
    { source: string } | { target: string }
  ))[];
}
export interface LoadingConfig {
  pallets: {
    id: string;
    items: { material: string; category: string; target: string }[];
  }[];
  supplies: {
    device: string;
    materialTemplate: string;
    entry: string;
    entryDevice: string;
    leader: string;
    materials: string[];
  }[];
  exchange: { entry: string; exit: string; leader: string };
  materialSupply: Map<string, string>;
  targets: Map<
    string,
    { position: Vec3; reference: string; supportDevice: string }
  >;
}
export interface VisualBodyBinding {
  bodyId: string;
  instanceId: string;
  meshes: number[];
  initial: BodyPose;
  future: boolean;
}
export interface SceneReadiness {
  mode: "run" | "validation";
  warnings: string[];
  blockers: string[];
}
export interface CompiledSceneRuntime {
  handoff?: import("./robot-handoff").HandoffConfig;
  loading?: LoadingConfig;
  warehouse?: import("./warehouse").WarehouseConfig;
  bundle: SceneBundle;
  root: ProcessNode;
  task: { pallets: SceneLoad[]; [key: string]: unknown };
  devices: Map<string, SceneDevice>;
  physics: PhysicsConfig;
  bodyMap: Map<string, RuntimeBody>;
  visualBodies: VisualBodyBinding[];
  robots: Map<string, CompiledRobotScene>;
  robotNodes: Map<string, number[]>;
  subjectIds: Map<string, number>;
  sourceDevice: string;
  entryDevice: string;
  exitDevice: string;
  outfeeds: string[];
  leaders: Map<string, string[]>;
  goals: {
    material_ids: string[];
    pallet_ids: string[];
    deliveries: { material: string; target: string; handler: string }[];
  };
  readiness: SceneReadiness;
}
