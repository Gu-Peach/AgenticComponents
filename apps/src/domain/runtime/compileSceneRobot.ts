import { Matrix4, Quaternion, Vector3 } from "three";
import { z } from "zod";
import { robotModelSchema, type CompiledRobotScene } from "@/contracts/robot";
/** Scene rest translations are already metre-normalized by scene_devices.relative_pose. */
export function compileSceneRobot(
  raw: unknown,
  revision: number,
  options: { allowCandidate?: boolean } = {},
): CompiledRobotScene {
  const device = z
    .object({
      instance_id: z.string(),
      parameters: z.record(
        z.string(),
        z.union([z.number(), z.string(), z.boolean()]),
      ),
      contract: z.object({
        device_type: z.literal("robot_arm"),
        type_specific_contract: robotModelSchema,
      }),
      geometry: z.union([
        z.object({
          world_position: z.tuple([
            z.number().finite(),
            z.number().finite(),
            z.number().finite(),
          ]),
          world_rotation: z.tuple([
            z.number().finite(),
            z.number().finite(),
            z.number().finite(),
            z.number().finite(),
          ]),
        }),
        z.object({ world_matrix: z.array(z.number().finite()).length(16) }),
      ]),
      node_binding: z.object({
        status: z.literal("bound"),
        model_sha256: z.string(),
      }),
    })
    .parse(raw);
  const model = device.contract.type_specific_contract;
  if (model.calibration.asset_sha256 !== device.node_binding.model_sha256)
    throw new Error("Scene robot calibration hash mismatch");
  if (
    model.calibration.status !== "simulation_configured" &&
    !options.allowCandidate
  )
    throw new Error("Robot model remains a calibration candidate");
  const position = new Vector3(),
    rotation = new Quaternion(),
    scale = new Vector3(1, 1, 1);
  if ("world_matrix" in device.geometry)
    new Matrix4()
      .fromArray(device.geometry.world_matrix)
      .decompose(position, rotation, scale);
  else {
    position.fromArray(device.geometry.world_position);
    rotation.fromArray(device.geometry.world_rotation);
    if (Math.abs(rotation.length() - 1) > 1e-6)
      throw new Error("Invalid scene base quaternion");
  }
  if (
    scale.toArray().some((v) => v <= 0) ||
    Math.abs(scale.x - scale.y) > 1e-6 ||
    Math.abs(scale.x - scale.z) > 1e-6
  )
    throw new Error("Scene robot requires positive uniform import scale");
  const value = (key: string) => {
    const v = device.parameters[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
      throw new Error("Missing robot parameter: " + key);
    return v;
  };
  if (device.parameters[model.ik.mode_param] !== "position_only")
    throw new Error("Only position IK is implemented");
  for (let i = 0; i < model.urdf.joints.length; i++) {
    if (
      model.urdf.joints[i].parent_joint !==
      (i ? model.urdf.joints[i - 1].name : null)
    )
      throw new Error("Invalid robot joint chain");
  }
  return {
    kind: "robot_experiment",
    instanceId: device.instance_id,
    revision,
    templateId: "robot.articulated",
    model,
    base: { position: position.toArray(), rotation: rotation.toArray() },
    speed: model.urdf.joints.map((j) =>
      Math.min(
        value(j.velocity_limit_param),
        value(model.trajectoryConfig.joint_speed_param),
      ),
    ),
    acceleration: model.urdf.joints.map((j) =>
      Math.min(
        value(j.acceleration_limit_param),
        value(model.trajectoryConfig.joint_acceleration_param),
      ),
    ),
    tolerance: value(model.ik.position_tolerance_param),
    iterations: value(model.ik.max_iterations_param),
    settleSpeed: value("settle_speed_rad_s"),
    maxPayload: value("max_payload_kg"),
    liftHeight: value("lift_height"),
    toolBodyId: device.instance_id + "/tool",
    taskTimeout: 120,
  };
}
