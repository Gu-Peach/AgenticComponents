import { z } from "zod";
import type { Vec3 } from "./device";
import type { BodyPose, PhysicsConfig, Quat } from "./physics";
const vec = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const quat = z
  .tuple([
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
  ])
  .refine((q) => Math.abs(Math.hypot(...q) - 1) < 1e-5, "四元数须归一化");
export const robotModelSchema = z.object({
  coordinate_system: z.object({
    length_unit: z.literal("m"),
    joint_angle_unit: z.literal("rad"),
    up_axis: z.literal("Y"),
  }),
  rootNodeName: z.string().min(1),
  calibration: z.object({
    asset_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["pending", "simulation_configured"]),
    source: z.string().min(1),
  }),
  urdf: z.object({
    format: z.literal("project_urdf_like"),
    structure_mode: z.literal("serial"),
    joints: z
      .array(
        z.object({
          name: z.string().min(1),
          nodeName: z.string().min(1),
          parent_joint: z.string().nullable(),
          type: z.literal("revolute"),
          axis: vec.refine(
            (a) => Math.abs(Math.hypot(...a) - 1) < 1e-5,
            "关节轴须归一化",
          ),
          axis_frame: z.literal("joint_local"),
          rest_position: vec,
          rest_quaternion: quat,
          render_rest_quaternion: quat,
          limit: z
            .object({ lower: z.number().finite(), upper: z.number().finite() })
            .refine(
              (v) => v.lower < v.upper && v.lower <= 0 && v.upper >= 0,
              "范围必须包含资产静止零点",
            ),
          velocity_limit_param: z.string(),
          acceleration_limit_param: z.string(),
        }),
      )
      .length(6),
  }),
  tooling: z.object({
    flange_node_name: z.string(),
    tcp_node_name: z.string(),
    tcp_local_frame: z.object({ position: vec, rotation_quaternion: quat }),
    rest_position: vec,
    rest_quaternion: quat,
    simulation_tool: z.literal(true),
  }),
  ik: z.object({
    solver: z.literal("ccd_position"),
    mode_param: z.string(),
    position_tolerance_param: z.string(),
    max_iterations_param: z.string(),
  }),
  trajectoryConfig: z.object({
    motion_mode: z.literal("joint_ptp"),
    joint_speed_param: z.string(),
    joint_acceleration_param: z.string(),
  }),
  gripper: z.object({
    type: z.literal("virtual_fixed_grasp"),
    capture_radius_m: z.number().positive().max(0.3),
    max_relative_speed_mps: z.number().positive(),
    max_payload_param: z.string(),
    tool_size_m: vec.refine((v) => v.every((n) => n > 0)),
    constraint_tolerance_m: z.number().positive(),
    orientation_policy: z.literal("spherical_virtual_capture"),
  }),
});
export type RobotModel = z.infer<typeof robotModelSchema>;
export interface CompiledRobotScene {
  kind: "robot_experiment";
  instanceId: string;
  revision: number;
  templateId: "robot.articulated";
  model: RobotModel;
  base: { position: Vec3; rotation: Quat };
  speed: number[];
  acceleration: number[];
  tolerance: number;
  settleSpeed: number;
  iterations: number;
  maxPayload: number;
  liftHeight: number;
  physics?: PhysicsConfig;
  materialInstanceId?: string;
  subjectId?: string;
  bodyLocalMatrix?: number[];
  materialBodyId?: string;
  materialSize?: Vec3;
  toolBodyId: string;
  supportSurfaceId?: string;
  materialMass?: number;
  placementCenter?: Vec3;
  placementRotation?: Quat;
  taskTimeout: number;
}
export interface RobotObservation {
  q: number[];
  qdot: number[];
  tcp: BodyPose;
  phase: string;
  errorM: number;
  ik: { converged: boolean; iterations: number; error: number } | null;
  holdingMaterialId: string | null;
  constraintErrorM: number;
  mode: "kinematic_preview" | "fixed_grasp";
  calibrationSource: string;
  observations: Record<string, boolean | number | null>;
  authorizations: Record<string, boolean | null>;
}
