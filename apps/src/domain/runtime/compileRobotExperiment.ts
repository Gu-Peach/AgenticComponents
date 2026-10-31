import { Quaternion, Vector3 } from "three";
import type { ProjectDocument } from "@/contracts/device";
import type { CompiledRobotScene } from "@/contracts/robot";
import { compileRobotArm } from "./compileRobotArm";
import { compileRigidBody } from "./compileRigidBody";
import { RobotKinematics } from "@/runtime/kinematics/RobotKinematics";
export interface RobotExperimentOptions {
  materialId?: string;
  supportId?: string;
}
export function compileRobotExperiment(
  project: ProjectDocument,
  id: string,
  options: RobotExperimentOptions = {},
): CompiledRobotScene {
  const get = (id: string) => {
    const i = project.instances.find((i) => i.instanceId === id),
      d = project.definitions.find((d) => d.specId === i?.specId);
    if (!i || !d || !i.visible) throw new Error("设备不存在或不可见");
    return { i, d };
  };
  const { i, d } = get(id),
    scene = compileRobotArm(d, i, project.revision);
  if (!options.materialId && !options.supportId) return scene;
  if (!options.materialId || !options.supportId)
    throw new Error("物理抓放需同时选择物料和目标支承");
  const cargo = get(options.materialId),
    support = get(options.supportId);
  if (cargo.d.deviceType !== "workpiece" || support.d.deviceType !== "conveyor")
    throw new Error("物料或支承设备类型不匹配");
  const c = compileRigidBody(cargo.d, cargo.i),
    s = compileRigidBody(support.d, support.i);
  if (c.body.motionType !== "dynamic" || s.body.motionType !== "static")
    throw new Error("抓放需要动态物料与静态支承");
  if ((c.body.mass ?? Infinity) > scene.maxPayload)
    throw new Error("物料超过仿真允许载荷");
  const sq = new Quaternion(...s.body.rotation);
  if (new Vector3(0, 1, 0).applyQuaternion(sq).y < 0.99999)
    throw new Error("抓放目标暂只支持水平支承");
  if (c.body.size[0] > s.body.size[0] || c.body.size[2] > s.body.size[2])
    throw new Error("目标支承尺寸不足");
  const tcp = new RobotKinematics(scene).forward([0, 0, 0, 0, 0, 0]).tcp;
  const drop = new Vector3(...s.body.position).add(
    new Vector3(
      0,
      s.body.size[1] / 2 + c.body.size[1] / 2 + 0.002,
      0,
    ).applyQuaternion(sq),
  );
  return {
    ...scene,
    materialInstanceId: cargo.i.instanceId,
    subjectId: cargo.i.instanceId,
    bodyLocalMatrix: c.bodyLocal.toArray(),
    materialBodyId: c.body.id,
    materialSize: c.body.size,
    materialMass: c.body.mass,
    placementCenter: drop.toArray(),
    placementRotation: s.body.rotation,
    supportSurfaceId: `${support.i.instanceId}/support`,
    physics: {
      surfacePosition: s.body.position,
      surfaceSize: s.body.size,
      rotation: s.body.rotation,
      materialPosition: c.body.position,
      materialSize: c.body.size,
      mass: c.body.mass!,
      friction: c.body.friction,
      bodies: [
        s.body,
        c.body,
        {
          id: scene.toolBodyId,
          instanceId: id,
          motionType: "kinematic",
          role: "tool",
          position: tcp.position,
          rotation: tcp.rotation,
          size: scene.model.gripper.tool_size_m,
          friction: 0.6,
          restitution: 0,
        },
        {
          id: "world/ground",
          instanceId: "world",
          motionType: "static",
          role: "ground",
          position: [0, -0.05, 0],
          rotation: [0, 0, 0, 1],
          size: [20, 0.1, 20],
          friction: 0.6,
          restitution: 0,
        },
      ],
      surfaces: [
        {
          id: `${support.i.instanceId}/support`,
          bodyId: s.body.id,
          direction: new Vector3(1, 0, 0).applyQuaternion(sq).toArray(),
          normal: [0, 1, 0],
        },
      ],
      targetBodyId: c.body.id,
    },
  };
}
