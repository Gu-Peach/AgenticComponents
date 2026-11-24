/** 将物料声明的抓取接口从模型局部系转换到刚体局部系，用实测位姿求世界抓取点。 */
import { Matrix4, Quaternion, Vector3 } from "three";
import { z } from "zod";
import type { SceneDevice } from "@/contracts/scene-execution";
import type { MaterialGraspFrames } from "@/contracts/material-frames";
import type { BodyPose } from "@/contracts/physics";

const vec = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const declaration = z.object({
  frame_source: z.literal("material_local_m"),
  preferred_grasp: z.string().optional(),
  frames: z.record(
    z.string().min(1),
    z.object({
      position_m: vec,
      approach_axis: vec.refine((v) => Math.abs(Math.hypot(...v) - 1) < 1e-6),
    }),
  ),
});

export function compileGraspFrames(
  raw: unknown,
  modelToBody: Matrix4,
): MaterialGraspFrames {
  const definition = declaration.parse(raw);
  const rest = new Quaternion().setFromRotationMatrix(modelToBody);
  const points = Object.fromEntries(
    Object.entries(definition.frames).map(([name, frame]) => [
      name,
      {
        offset: new Vector3(...frame.position_m)
          .applyMatrix4(modelToBody)
          .toArray(),
        outward: new Vector3(...frame.approach_axis)
          .negate()
          .applyQuaternion(rest)
          .toArray(),
      },
    ]),
  );
  if (
    !Object.keys(points).length ||
    (definition.preferred_grasp &&
      !Object.hasOwn(points, definition.preferred_grasp))
  )
    throw new Error("物料缺少有效的抓取接口");
  return {
    points,
    rest: rest.toArray(),
    preferred: definition.preferred_grasp,
  };
}

export function sceneGraspFrames(device: SceneDevice): MaterialGraspFrames {
  const { geometry: g } = device;
  const center = new Vector3(...g.bounds.min).lerp(
    new Vector3(...g.bounds.max),
    0.5,
  );
  const transform = new Matrix4().compose(
    new Vector3(...g.world_position).sub(center),
    new Quaternion(...g.world_rotation),
    new Vector3(1, 1, 1),
  );
  return compileGraspFrames(
    (device.contract.type_specific_contract as { grasping?: unknown })
      ?.grasping,
    transform,
  );
}

export function selectGraspFrame(
  frames: MaterialGraspFrames,
  selected?: string,
) {
  const names = Object.keys(frames.points);
  const name =
    selected ?? frames.preferred ?? (names.length === 1 ? names[0] : undefined);
  if (!name || !Object.hasOwn(frames.points, name))
    throw new Error("需要有效的物料抓取接口: " + String(name));
  return frames.points[name];
}

export function worldGraspFrame(
  frames: MaterialGraspFrames,
  name: string | undefined,
  pose: BodyPose,
  clearance: number,
) {
  const frame = selectGraspFrame(frames, name),
    q = new Quaternion(...pose.rotation);
  const outward = new Vector3(...frame.outward).applyQuaternion(q);
  const contact = new Vector3(...frame.offset)
    .applyQuaternion(q)
    .add(new Vector3(...pose.position));
  return {
    contact,
    outward,
    tcp: contact.clone().addScaledVector(outward, clearance),
  };
}

/** Legacy top-surface models may omit authored frames. A requested frame must always resolve. */
export function pickGraspForDevice(device: SceneDevice, name?: string) {
  const grasp = (
    device.contract.type_specific_contract as {
      grasping?: { frames?: unknown };
    }
  )?.grasping;
  if (!grasp?.frames && name === undefined) return undefined;
  const frames = sceneGraspFrames(device);
  selectGraspFrame(frames, name);
  return { frames, name };
}
