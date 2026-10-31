import { Quaternion, Vector3 } from "three";
import { robotModelSchema, type CompiledRobotScene } from "@/contracts/robot";
import type { DeviceDefinition, DeviceInstance } from "@/contracts/device";
import { resolveParameters, semanticIssues } from "@/validation/contracts";
import { matrixOf, identityTransform } from "@/domain/spatial/transforms";
export function compileRobotArm(
  def: DeviceDefinition,
  instance: DeviceInstance,
  revision: number,
): CompiledRobotScene {
  if (def.deviceType !== "robot_arm" || def.source?.contract_version !== "1.4")
    throw new Error("请选择契约1.4的真实机械臂");
  const issues = semanticIssues(def, instance.paramOverrides);
  if (issues.length) throw new Error(issues.join("；"));
  const model = robotModelSchema.parse(def.typeSpecificContract);
  if (model.calibration.status !== "simulation_configured")
    throw new Error("机械臂尚未配置运动学校准");
  if (def.asset.sha256 && def.asset.sha256 !== model.calibration.asset_sha256)
    throw new Error("机械臂资产哈希与校准不匹配");
  const imported = def.asset.importTransform ?? identityTransform;
  if ([...imported.scale, ...instance.transform.scale].some((n) => n !== 1))
    throw new Error("机械臂运行仅支持外层单位缩放");
  const ids = new Set<string>(),
    nodes = new Set<string>();
  model.urdf.joints.forEach((j, i) => {
    if (
      ids.has(j.name) ||
      nodes.has(j.nodeName) ||
      j.parent_joint !== (i ? model.urdf.joints[i - 1].name : null)
    )
      throw new Error("关节链不连通或节点重复");
    ids.add(j.name);
    nodes.add(j.nodeName);
  });
  const p = resolveParameters(def, instance.paramOverrides),
    num = (key: string) => {
      const v = p[key];
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
        throw new Error(`机器人参数无效: ${key}`);
      return v;
    };
  if (p[model.ik.mode_param] !== "position_only")
    throw new Error("当前仅支持位置IK，不支持姿态求解");
  const transform = matrixOf(instance.transform).multiply(matrixOf(imported)),
    pos = new Vector3(),
    rotation = new Quaternion();
  transform.decompose(pos, rotation, new Vector3());
  return {
    kind: "robot_experiment",
    instanceId: instance.instanceId,
    revision,
    templateId: "robot.articulated",
    model,
    base: { position: pos.toArray(), rotation: rotation.toArray() },
    speed: model.urdf.joints.map((j) =>
      Math.min(
        num(j.velocity_limit_param),
        num(model.trajectoryConfig.joint_speed_param),
      ),
    ),
    acceleration: model.urdf.joints.map((j) =>
      Math.min(
        num(j.acceleration_limit_param),
        num(model.trajectoryConfig.joint_acceleration_param),
      ),
    ),
    tolerance: num(model.ik.position_tolerance_param),
    iterations: num(model.ik.max_iterations_param),
    settleSpeed: num("settle_speed_rad_s"),
    maxPayload: num(model.gripper.max_payload_param),
    liftHeight: num("lift_height"),
    toolBodyId: `${instance.instanceId}/tool`,
    taskTimeout: 120,
  };
}
