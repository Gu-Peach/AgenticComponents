import { Euler, Quaternion, Vector3, Group } from "three";
import { findSnap, interfaceWorld } from "../../src/domain/spatial/snap";
import { withModelMount } from "../../src/domain/spatial/modelMount";
import { normalizeDeviceSpec } from "../../src/domain/normalizeDeviceSpec";
import { instantiate } from "../../src/domain/catalog";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { applyMountedNodeOffset } from "../../src/renderer/MountedAxisBridge";
import {
  sceneBundleSchema,
  type ScenePackageInstance,
} from "../../src/contracts/scene-package";
import { useWorkspace } from "../../src/stores/workspace";
import { projectRepository } from "../../src/services/BrowserProjectRepository";
import { extractMountedDevices } from "../../src/services/extractMountedDevices";
import {
  compileMountedWorkcell,
  mountedProcess,
} from "../../src/domain/runtime/compileMountedWorkcell";
import {
  assembleMountedWorkcell,
  type MountedReading,
} from "../../src/runtime/assembly/MountedWorkcell";
import { disposeWorkcellProgram } from "../../src/runtime/engine/TransferSession";
import { parseProject } from "../../src/validation/contracts";

it("extracts a saved pair of real S07 devices, runs absolute rail and lift commands and rejects detached or unreachable targets", async () => {
  const before = useWorkspace.getState(),
    files = new Map<string, Blob>();
  const readAsset = projectRepository.getAsset.bind(projectRepository);
  vi.spyOn(projectRepository, "getAsset").mockImplementation(
    async (id) => files.get(id) ?? readAsset(id),
  );
  const b = sceneBundleSchema.parse(
    JSON.parse(
      readFileSync("public/scene/S07/.generated/scene.bundle.json", "utf8"),
    ),
  );
  const scene: ScenePackageInstance = {
    id: "warehouse",
    assetId: "original",
    bundleHash: "0".repeat(64),
    bundle: b,
  };
  files.set(
    scene.assetId,
    new Blob([
      new Uint8Array(readFileSync("public" + decodeURIComponent(b.model_url))),
    ]),
  );
  try {
    before.initialize();
    useWorkspace.getState().updateProject((p) => ({
      ...p,
      scenePackages: [scene],
      assets: [
        ...p.assets,
        {
          id: "original",
          kind: "glb",
          name: "warehouse.glb",
          size: files.get("original")!.size,
        },
      ],
    }));
    const rail = await extractMountedDevices(
      useWorkspace.getState().project!.scenePackages![0],
      "T1",
    );
    const project = parseProject(
      JSON.parse(JSON.stringify(useWorkspace.getState().project)),
    );
    const lift = project.connections!.find((c) => c.a.instanceId === rail)!.b
      .instanceId;
    const assets = new Map<string, ArrayBuffer>();
    for (const i of project.instances.filter((i) =>
      [rail, lift].includes(i.instanceId),
    )) {
      const def = project.definitions.find((d) => d.specId === i.specId)!;
      assets.set(
        i.instanceId,
        await (await projectRepository.getAsset(
          def.asset.assetId!,
        ))!.arrayBuffer(),
      );
    }
    const ir = mountedProcess(-0.55, 1);
    const compiled = compileMountedWorkcell(project, rail, assets, ir);
    expect(() =>
      compileMountedWorkcell({ ...project, connections: [] }, rail, assets, ir),
    ).toThrow(/吸附/);
    expect(() =>
      compileMountedWorkcell(project, rail, assets, mountedProcess(-50, 1)),
    ).toThrow(/行程/);
    const program = await assembleMountedWorkcell(
      compiled,
      project.id,
      "self-assembled",
    );
    try {
      program.start();
      let s = program.snapshot();
      for (let i = 0; i < 3600 && program.needsStep(); i++)
        s = program.step(1 / 60);
      expect(
        s.status,
        JSON.stringify({ reason: s.error, activity: s.process.activations }),
      ).toBe("succeeded");
      const w = s.observations.samples["mount/state"].value as MountedReading;
      expect(w.positions[rail]).toBeCloseTo(-0.55, 2);
      expect(w.positions[lift]).toBeCloseTo(1, 2);
      expect(Math.hypot(...w.offsets[lift])).toBeCloseTo(0.55, 2);
      expect(w.offsets[lift][1]).toBeCloseTo(0, 4);
      expect(w.nodes[lift].offset[1]).toBeCloseTo(1 - compiled.axes[1].rest, 2);
    } finally {
      disposeWorkcellProgram(program);
    }

    // Mark an owned mesh on this independent rail as its visible slider.
    const railDef = project.definitions.find(
      (d) =>
        d.specId ===
        project.instances.find((i) => i.instanceId === rail)!.specId,
    )!;
    expect(railDef.typeSpecificContract.moving_node).toBeUndefined();
    const ownedRail = structuredClone(railDef);
    const withSlider = {
      ...project,
      definitions: project.definitions.map((d) =>
        d === railDef ? ownedRail : d,
      ),
    };
    ownedRail.typeSpecificContract.moving_node = "missing-owned-slider";
    expect(() => compileMountedWorkcell(withSlider, rail, assets, ir)).toThrow(
      /移动部件节点缺失/,
    );
    const sourceRail = b.devices.find((d) => d.instance_id === "T1")!;
    const firstMesh = (
      sourceRail.node_binding.owned_mesh_indices as number[]
    )[0];
    const sliderName = b.nodes[firstMesh].name!;
    ownedRail.typeSpecificContract.moving_node = sliderName;
    const sliderCell = compileMountedWorkcell(withSlider, rail, assets, ir);
    const fixedBody = rail + "/fixed",
      sliderBody = rail + "/carriage";
    expect(sliderCell.bodyAxes.get(fixedBody)).toEqual([]);
    expect(sliderCell.bodyAxes.get(sliderBody)).toEqual([rail]);
    expect(
      sliderCell.physics.bodies!.find((body) => body.id === sliderBody)?.sensor,
    ).toBeFalsy();
    const sliderRun = await assembleMountedWorkcell(
      sliderCell,
      project.id,
      "owned-slider",
    );
    try {
      sliderRun.start();
      let snapshot = sliderRun.snapshot();
      for (let i = 0; i < 3600 && sliderRun.needsStep(); i++)
        snapshot = sliderRun.step(1 / 60);
      expect(snapshot.status, snapshot.error).toBe("succeeded");
      const world = snapshot.observations.samples["mount/state"]
        .value as MountedReading;
      expect(world.offsets[rail]).toBeUndefined();
      expect(world.nodes[rail].name).toBe(sliderName);
      const fixed = new Group(),
        slider = new Group();
      fixed.position.set(4, 2, 7);
      fixed.rotation.set(0.2, Math.PI / 2, 0);
      fixed.add(slider);
      slider.position.set(1, 0.5, 3);
      const rest = slider.position.clone(),
        start = slider.getWorldPosition(new Vector3());
      applyMountedNodeOffset(slider, rest, world.nodes[rail].offset);
      const moved = slider.getWorldPosition(new Vector3()).sub(start);
      expect(
        moved.distanceTo(new Vector3(...world.offsets[lift])),
      ).toBeLessThan(1e-5);
      expect(fixed.position.toArray()).toEqual([4, 2, 7]);
      applyMountedNodeOffset(slider, rest);
      expect(slider.position.toArray()).toEqual(rest.toArray());
      for (let i = 0; i < 3; i++)
        expect(world.nodes[rail].offset[i]).toBeCloseTo(
          world.offsets[lift][i],
          5,
        );
    } finally {
      disposeWorkcellProgram(sliderRun);
    }

    // Swap the fixture for a real workpiece package, then move the same rail along world Z.
    const raw = readFileSync("public/modles/engine_block/engine_block.glb");
    const bytes = raw.buffer.slice(
      raw.byteOffset,
      raw.byteOffset + raw.byteLength,
    ) as ArrayBuffer;
    const part = withModelMount(
      normalizeDeviceSpec(
        JSON.parse(
          readFileSync("public/modles/engine_block/schema.json", "utf8"),
        ),
      ),
      bytes,
    );
    const mounted = instantiate(part, 0),
      track = project.instances.find((i) => i.instanceId === rail)!;
    const trackDef = project.definitions.find(
      (d) => d.specId === track.specId,
    )!;
    track.transform.rotation = [0, Math.PI / 2, 0];
    const doc = {
      ...project,
      instances: [track, mounted],
      definitions: [trackDef, part],
      connections: [],
    };
    const destination = interfaceWorld(track, trackDef, "carriage_mount")!;
    const source = interfaceWorld(mounted, part, "mount_base")!;
    // Place within the interaction cone so the production snap solver chooses this pair.
    const desired = destination.rotation
      .clone()
      .multiply(
        new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI),
      );
    const orient = desired.multiply(source.rotation.clone().invert());
    mounted.transform.rotation = new Euler()
      .setFromQuaternion(orient)
      .toArray()
      .slice(0, 3) as [number, number, number];
    const start = interfaceWorld(mounted, part, "mount_base")!;
    mounted.transform.position = new Vector3(...mounted.transform.position)
      .add(destination.position.clone().sub(start.position))
      .toArray();
    const snap = findSnap(doc, mounted);
    expect(snap?.targetInterface).toBe("carriage_mount");
    mounted.transform = snap!.transform;
    const isolated = {
      ...doc,
      connections: [
        {
          id: "attach",
          a: { instanceId: rail, interfaceId: "carriage_mount" },
          b: { instanceId: mounted.instanceId, interfaceId: "mount_base" },
        },
      ],
    };
    assets.set(mounted.instanceId, bytes);
    const massCell = compileMountedWorkcell(
      isolated,
      rail,
      assets,
      mountedProcess(-0.35),
    );
    const massRun = await assembleMountedWorkcell(
      massCell,
      project.id,
      "mounted-part",
    );
    try {
      massRun.start();
      let s = massRun.snapshot();
      for (let i = 0; i < 2400 && massRun.needsStep(); i++)
        s = massRun.step(1 / 60);
      expect(s.status, s.error).toBe("succeeded");
      const w = s.observations.samples["mount/state"].value as MountedReading;
      expect(Math.abs(w.offsets[mounted.instanceId][2])).toBeCloseTo(0.35, 2);
      expect(w.offsets[mounted.instanceId][0]).toBeCloseTo(0);
      expect(w.nodes).toEqual({});
    } finally {
      disposeWorkcellProgram(massRun);
    }

    const obstacle = structuredClone(mounted);
    obstacle.instanceId = "fixed-obstacle";
    obstacle.transform.position = new Vector3(...mounted.transform.position)
      .addScaledVector(new Vector3(...massCell.axes[0].direction), -1.2)
      .toArray();
    const obstructed = {
      ...isolated,
      instances: [...isolated.instances, obstacle],
    };
    expect(() =>
      compileMountedWorkcell(obstructed, rail, assets, mountedProcess(-2.5)),
    ).toThrow(/真实几何/);
    assets.set(obstacle.instanceId, bytes);
    const blockedCell = compileMountedWorkcell(
      obstructed,
      rail,
      assets,
      mountedProcess(-2.5),
    );
    const blocked = await assembleMountedWorkcell(
      blockedCell,
      project.id,
      "blocked-sweep",
    );
    try {
      blocked.start();
      let s = blocked.snapshot();
      for (let i = 0; i < 2400 && blocked.needsStep(); i++)
        s = blocked.step(1 / 60);
      expect(s.status).toBe("failed");
      const state = s.observations.samples["mount/state"]
        .value as MountedReading;
      expect(state.positions[rail]).toBeCloseTo(0, 5);
      expect(JSON.stringify(s)).toContain("fixed-obstacle");
    } finally {
      disposeWorkcellProgram(blocked);
    }
  } finally {
    vi.restoreAllMocks();
    useWorkspace.setState(before, true);
  }
}, 30000);

it("drops both generated assets when a different document opens during extraction", async () => {
  const before = useWorkspace.getState();
  const bundle = sceneBundleSchema.parse(
    JSON.parse(
      readFileSync("public/scene/S07/.generated/scene.bundle.json", "utf8"),
    ),
  );
  const scene: ScenePackageInstance = {
    id: "warehouse",
    assetId: "original",
    bundleHash: "0".repeat(64),
    bundle,
  };
  const original = new Blob([
    new Uint8Array(
      readFileSync("public" + decodeURIComponent(bundle.model_url)),
    ),
  ]);
  const stage = vi.spyOn(projectRepository, "stageAssets");
  const put = vi.spyOn(projectRepository, "putAsset");
  try {
    before.initialize();
    useWorkspace
      .getState()
      .updateProject((p) => ({ ...p, scenePackages: [scene] }));
    vi.spyOn(projectRepository, "getAsset").mockImplementationOnce(async () => {
      useWorkspace.getState().initialize();
      return original;
    });
    await expect(extractMountedDevices(scene, "T1")).rejects.toThrow(
      /项目已改变/,
    );
    expect(stage).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(
      useWorkspace
        .getState()
        .project?.assets.some((a) => a.id.startsWith("sha256-")),
    ).toBe(false);
  } finally {
    vi.restoreAllMocks();
    useWorkspace.setState(before, true);
  }
});
