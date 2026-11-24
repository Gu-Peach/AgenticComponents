import { expect, it, vi } from "vitest";
import { Mesh, Object3D, Quaternion, Vector3 } from "three";
import { sceneFixture } from "./fixtures";
import { compileSceneRuntime } from "../../src/domain/runtime/compileSceneRuntime";
import { acquireModel } from "../../src/services/ModelRepository";
import { projectRepository } from "../../src/services/BrowserProjectRepository";
import { bindSceneVisuals } from "../../src/renderer/bindSceneVisuals";
import { RobotKinematics } from "../../src/runtime/kinematics/RobotKinematics";
import type { BodyPose } from "../../src/contracts/physics";
import type { SceneVisualSnapshot } from "../../src/runtime/engine/SceneRuntimeProgram";

it("moves the visible hand and rotor of the imported S11 GLB, keeps the base fixed and matches the real torch TCP", async () => {
  const { bundle, bytes, goal } = sceneFixture("S11");
  const c = compileSceneRuntime(bundle, bytes, goal, "validation"),
    cell = c.indexedProcessing!;
  vi.spyOn(projectRepository, "getAsset").mockResolvedValue(new Blob([bytes]));
  vi.stubGlobal("self", globalThis);
  // The headless runner only needs the dimensions of the embedded PNG textures.
  vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
    const d = new DataView(await blob.arrayBuffer());
    expect(d.getUint32(0)).toBe(0x89504e47);
    return { width: d.getUint32(16), height: d.getUint32(20), close() {} };
  });
  let model: Awaited<ReturnType<typeof acquireModel>> | undefined;
  try {
    model = await acquireModel("indexed-test-" + bundle.model_sha256);
    const root = model.root,
      nodes = new Map<number, Object3D>();
    root.traverse((o) => {
      if (Number.isInteger(o.userData.sceneNodeIndex))
        nodes.set(o.userData.sceneNodeIndex, o);
    });
    root.updateMatrixWorld(true);
    const index = (name: string) =>
      bundle.nodes.find((n) => n.name === name)!.index;
    const mesh = (index: number) => {
      let target: Mesh | undefined;
      nodes.get(index)!.traverseVisible((o) => {
        if (!target && o instanceof Mesh) target = o;
      });
      if (!target) throw new Error("No visible GLB mesh " + index);
      const materials = Array.isArray(target.material)
        ? target.material
        : [target.material];
      expect(materials.some((m) => m.visible && m.opacity > 0)).toBe(true);
      return target;
    };
    const visuals = c.visualBodies.find((b) => b.bodyId === cell.tableBody)!;
    const workSurface = mesh(index("Mesh [03dg]"));
    const base = mesh(
      c.devices
        .get(cell.table)!
        .node_binding.owned_mesh_indices.find(
          (i) => !visuals.meshes.includes(i),
        )!,
    );
    const visualHand = nodes.get(index("RWrist [00Wn]"))!;
    let handMesh: Mesh | undefined;
    visualHand.traverseVisible((o) => {
      if (!handMesh && o instanceof Mesh) handMesh = o;
    });
    if (!handMesh) throw new Error("GLB hand has no mesh");
    const humanMesh = mesh(
      c.visualBodies
        .find((b) => b.bodyId === cell.humanBody)!
        .meshes.find((i) => !visualHand.getObjectById(nodes.get(i)!.id))!,
    );
    const torch = nodes.get(index("Link2 [00In]"))!;
    const feature = (m: Mesh) => {
      m.geometry.computeBoundingBox();
      return m.localToWorld(m.geometry.boundingBox!.getCenter(new Vector3()));
    };
    const originals = [handMesh, humanMesh, base, workSurface, torch].map(
      (o) => ({ o, parent: o.parent, matrix: o.matrixWorld.clone() }),
    );
    const [hand0, human0, base0, work0] = [
      handMesh,
      humanMesh,
      base,
      workSurface,
    ].map(feature);
    const visualsDriver = bindSceneVisuals(root, c);
    const delta = new Vector3(0.45, 0, -0.13),
      turn = new Quaternion().setFromAxisAngle(
        new Vector3(...cell.axis),
        Math.PI,
      );
    const handDelta = delta.clone().add(new Vector3(0, 0.3, 0));
    const q = [0.11, -0.17, 0.08, -0.04, 0.15, 0.12],
      robot = c.robots.get(cell.robot)!;
    const allowed = new Map<string, BodyPose>([
      [
        cell.humanBody,
        {
          position: new Vector3(...c.bodyMap.get(cell.humanBody)!.position)
            .add(delta)
            .toArray(),
          rotation: [0, 0, 0, 1],
          velocity: [0, 0, 0],
        },
      ],
      [
        cell.handBody,
        {
          position: new Vector3(...cell.humanArm.palmHome)
            .add(handDelta)
            .toArray(),
          rotation: [0, 0, 0, 1],
          velocity: [0, 0, 0],
        },
      ],
      [
        cell.tableBody,
        { position: cell.pivot, rotation: turn.toArray(), velocity: [0, 0, 0] },
      ],
    ]);
    const bodies = Object.fromEntries(
      [...allowed].map(([k, pose]) => [k, { active: true, pose }]),
    );
    const runId = "S11-render",
      sample = (key: string, value: unknown) => ({
        key,
        value,
        runId,
        sampledTick: 1,
        quality: "good" as const,
        provider: "test",
      });
    const frame: SceneVisualSnapshot = {
      tick: 1,
      status: "running",
      runId,
      observations: {
        runId,
        tick: 1,
        samples: {
          "world/state": sample("world/state", { bodies }),
          [cell.robot + "/robot_state"]: sample(cell.robot + "/robot_state", {
            q,
          }),
        },
      },
    };
    visualsDriver.apply({ previous: frame, current: frame, alpha: 1 });
    root.updateMatrixWorld(true);
    const visible = new Set<Object3D>();
    root.traverseVisible((o) => visible.add(o));
    for (const o of [handMesh, humanMesh, workSurface, base, torch])
      expect(visible.has(o)).toBe(true);
    const pivot = new Vector3(...cell.pivot);
    expect(
      feature(workSurface).distanceTo(
        work0.sub(pivot).applyQuaternion(turn).add(pivot),
      ),
    ).toBeLessThan(1e-5);
    expect(feature(base).distanceTo(base0)).toBeLessThan(1e-6);
    expect(feature(handMesh).distanceTo(hand0.add(handDelta))).toBeLessThan(
      1e-5,
    );
    expect(feature(humanMesh).distanceTo(human0.add(delta))).toBeLessThan(1e-5);
    const fk = new RobotKinematics(robot).forward(q).tcp;
    expect(
      torch
        .localToWorld(
          new Vector3(...robot.model.tooling.tcp_local_frame.position),
        )
        .distanceTo(new Vector3(...fk.position)),
    ).toBeLessThan(1e-5);
    expect(
      torch
        .getWorldQuaternion(new Quaternion())
        .multiply(
          new Quaternion(
            ...robot.model.tooling.tcp_local_frame.rotation_quaternion,
          ),
        )
        .normalize()
        .angleTo(new Quaternion(...fk.rotation)),
    ).toBeLessThan(1e-5);
    visualsDriver.dispose();
    for (const { o, parent, matrix } of originals) {
      expect(o.parent).toBe(parent);
      matrix.elements.forEach((v, i) =>
        expect(o.matrixWorld.elements[i]).toBeCloseTo(v, 8),
      );
    }
  } finally {
    model?.release();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
