import { Quaternion, Vector3, type Object3D } from "three";
import type { IndexedProcessingConfig } from "@/contracts/indexed-processing";

/** Pose the two rigid arm segments at the measured suction point, preserving the palm orientation and grounded feet. */
export function bindCarryArm(
  model: Object3D,
  nodes: Map<number, Object3D>,
  arm: IndexedProcessingConfig["humanArm"],
) {
  const shoulder = nodes.get(arm.shoulder)!,
    elbow = nodes.get(arm.elbow)!,
    wrist = nodes.get(arm.wrist)!;
  if (!shoulder?.parent || !elbow?.parent || !wrist?.parent)
    throw new Error("Missing visible carry arm joint");
  const frame = shoulder.parent;
  const inFrame = (o: Object3D) =>
    frame.worldToLocal(o.getWorldPosition(new Vector3()));
  const s = inFrame(shoulder),
    e = inFrame(elbow),
    w = inFrame(wrist);
  const upper = s.distanceTo(e),
    lower = e.distanceTo(w);
  const palm = frame.worldToLocal(
    model.localToWorld(new Vector3(...arm.palmHome)),
  );
  const palmOffset = palm.clone().sub(w);
  const relativeWrist = frame
    .getWorldQuaternion(new Quaternion())
    .invert()
    .multiply(wrist.getWorldQuaternion(new Quaternion()));
  const joints = [shoulder, elbow, wrist].map((node) => ({
    node,
    rotation: node.quaternion.clone(),
  }));
  // The GLB zero pose has a straight arm. Select a stable bending plane towards
  // the elbow side of the torso when the loader brings the palm upward.
  const elbowSide = e
    .clone()
    .sub(s)
    .projectOnPlane(w.clone().sub(s).normalize());
  if (elbowSide.length() < upper * 1e-4) {
    const shoulderScene = model.worldToLocal(
      shoulder.getWorldPosition(new Vector3()),
    );
    elbowSide
      .copy(
        frame.worldToLocal(
          model.localToWorld(shoulderScene.add(new Vector3(1, 0, 0))),
        ),
      )
      .sub(s);
  }
  elbowSide.normalize();
  function reset() {
    for (const { node, rotation } of joints) {
      node.quaternion.copy(rotation);
      node.updateMatrix();
    }
  }
  function orient(node: Object3D, next: Object3D, target: Vector3) {
    const origin = node.getWorldPosition(new Vector3());
    const from = next.getWorldPosition(new Vector3()).sub(origin).normalize();
    const to = frame.localToWorld(target.clone()).sub(origin).normalize();
    const rotated = new Quaternion()
      .setFromUnitVectors(from, to)
      .multiply(node.getWorldQuaternion(new Quaternion()));
    node.quaternion
      .copy(node.parent!.getWorldQuaternion(new Quaternion()).invert())
      .multiply(rotated);
    node.updateMatrix();
  }
  const last = new Vector3(Infinity, Infinity, Infinity);
  function apply(sceneTarget: Vector3) {
    const target = frame
      .worldToLocal(model.localToWorld(sceneTarget.clone()))
      .sub(palmOffset);
    if (last.distanceToSquared(target) < 1e-16 * upper * upper) return;
    last.copy(target);
    reset();
    if (target.distanceTo(w) < 1e-6 * upper) return;
    const direction = target.clone().sub(s).normalize();
    const distance = Math.max(
      Math.abs(upper - lower) + 1e-9,
      Math.min(s.distanceTo(target), upper + lower),
    );
    const along =
      (upper * upper - lower * lower + distance * distance) / (2 * distance);
    const perpendicular = elbowSide
      .clone()
      .projectOnPlane(direction)
      .normalize();
    const bend = Math.sqrt(Math.max(0, upper * upper - along * along));
    const elbowTarget = s
      .clone()
      .addScaledVector(direction, along)
      .addScaledVector(perpendicular, bend);
    orient(shoulder, elbow, elbowTarget);
    orient(elbow, wrist, s.clone().addScaledVector(direction, distance));
    wrist.quaternion
      .copy(wrist.parent!.getWorldQuaternion(new Quaternion()).invert())
      .multiply(frame.getWorldQuaternion(new Quaternion()))
      .multiply(relativeWrist);
    wrist.updateMatrix();
  }
  return { apply, reset };
}
