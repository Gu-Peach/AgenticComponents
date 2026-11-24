/** 按整场绑定中的网格归属生成独立 GLB 和设备实例，保留移动部件层级和安装接口。 */
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { z } from "zod";
import type {
  SceneBundle,
  ScenePackageInstance,
} from "@/contracts/scene-package";
import type { SpatialConnection } from "@/contracts/device";
import { instantiate } from "@/domain/catalog";
import { normalizeDeviceSpec } from "@/domain/normalizeDeviceSpec";
import { projectMountParents } from "@/domain/spatial/mounts";
import { sha256, validateGlb } from "@/domain/validateGlb";
import {
  readGlbTree,
  subtreeNodes,
} from "@/domain/runtime/compileMountedWorkcell";
import { useWorkspace } from "@/stores/workspace";
import { projectRepository } from "./BrowserProjectRepository";

const vec = z.tuple([z.number(), z.number(), z.number()]);
const bound = z.object({
  node_indices: z.array(z.number()).length(1),
  owned_mesh_indices: z.array(z.number()).min(1),
});
const geom = z.object({
  world_position: vec,
  world_rotation: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});
export function mountedPairs(bundle: SceneBundle) {
  const devices = new Map(bundle.devices.map((d) => [d.instance_id, d]));
  return (bundle.connections ?? []).flatMap((link) => {
    const candidates = [link.a, link.b];
    const rail = candidates.find(
      (e) =>
        devices.get(e.instanceId)?.contract.device_type === "linear_rail" &&
        (
          devices.get(e.instanceId)?.contract.interfaces as {
            interface_id: string;
            capabilities: { snap: { role: string } };
          }[]
        )?.some(
          (p) =>
            p.interface_id === e.interfaceId &&
            p.capabilities.snap.role === "carriage_mount",
        ),
    );
    return rail ? [{ rail, child: rail === link.a ? link.b : link.a }] : [];
  });
}
function extractGeometry(bytes: ArrayBuffer, root: number, meshes: number[]) {
  const tree = readGlbTree(bytes),
    owned = new Set(meshes),
    localRoots = subtreeNodes(tree.nodes, [root]),
    parents = new Map<number, number>();
  tree.nodes.forEach((n, i) => n.children?.forEach((j) => parents.set(j, i)));
  if (
    meshes.some((i) => !localRoots.has(i) || tree.nodes[i]?.mesh === undefined)
  )
    throw new Error("设备网格不在注册的模型根下");
  const keep = new Set<number>();
  for (const m of meshes) {
    let n: number | undefined = m;
    while (n !== undefined && !keep.has(n)) {
      keep.add(n);
      if (n === root) break;
      n = parents.get(n);
    }
  }
  // Keep the original vertex/accessor indices and embedded BIN; limit active scene membership to the owned mesh hierarchy.
  const path: number[] = [];
  for (let i: number | undefined = root; i !== undefined; i = parents.get(i))
    path.unshift(i);
  const rootMatrix = new Matrix4();
  for (const id of path) {
    const n = tree.nodes[id];
    rootMatrix.multiply(
      n.matrix
        ? new Matrix4().fromArray(n.matrix)
        : new Matrix4().compose(
            new Vector3().fromArray(n.translation ?? [0, 0, 0]),
            new Quaternion().fromArray(n.rotation ?? [0, 0, 0, 1]),
            new Vector3().fromArray(n.scale ?? [1, 1, 1]),
          ),
    );
  }
  const scale = new Vector3();
  rootMatrix.decompose(new Vector3(), new Quaternion(), scale);
  if (scale.toArray().some((v) => v <= 0))
    throw new Error("不支持镜像安装坐标");
  tree.nodes = tree.nodes.map((node, i) => {
    if (!keep.has(i)) return {};
    const n = { ...node, children: node.children?.filter((j) => keep.has(j)) };
    if (!owned.has(i)) delete n.mesh;
    if (i === root) {
      delete n.matrix;
      delete n.translation;
      delete n.rotation;
      n.scale = scale.toArray();
    }
    return n;
  });
  tree.scene = 0;
  tree.scenes = [{ nodes: [root] }];
  const json = new TextEncoder().encode(JSON.stringify(tree)),
    len = Math.ceil(json.length / 4) * 4;
  const raw = new DataView(bytes),
    bin = bytes.slice(20 + raw.getUint32(12, true));
  const buffer = new ArrayBuffer(20 + len + bin.byteLength),
    v = new DataView(buffer),
    data = new Uint8Array(buffer);
  data.set(new Uint8Array(bytes, 0, 20));
  v.setUint32(8, buffer.byteLength, true);
  v.setUint32(12, len, true);
  data.fill(32, 20, 20 + len);
  data.set(json, 20);
  data.set(new Uint8Array(bin), 20 + len);
  validateGlb(buffer);
  return buffer;
}
export async function extractMountedDevices(
  scene: ScenePackageInstance,
  railId: string,
) {
  const before = useWorkspace.getState(),
    project = before.project;
  if (
    !project ||
    before.documentLocked ||
    !project.scenePackages?.includes(scene)
  )
    throw new Error("请先停止运行并选择已导入的场景");
  const pair = mountedPairs(scene.bundle).find(
    (p) => p.rail.instanceId === railId,
  );
  if (!pair) throw new Error("滑轨没有已标定的挂载关系");
  const blob = await projectRepository.getAsset(scene.assetId);
  if (!blob) throw new Error("场景 GLB 缺失");
  const bytes = await blob.arrayBuffer();
  if ((await sha256(bytes)) !== scene.bundle.model_sha256)
    throw new Error("场景 GLB 与绑定不符");
  const extracted = await Promise.all(
    [pair.rail, pair.child].map(async (end, i) => {
      const raw = scene.bundle.devices.find(
        (d) => d.instance_id === end.instanceId,
      )!;
      const binding = bound.parse(raw.node_binding),
        g = geom.parse(raw.geometry);
      const source = structuredClone(raw.contract),
        sub = extractGeometry(
          bytes,
          binding.node_indices[0],
          binding.owned_mesh_indices,
        );
      const digest = await sha256(sub),
        assetId = "sha256-" + digest,
        spec =
          scene.bundle.id + "." + raw.instance_id + "." + digest.slice(0, 10);
      source.schema_id = source.device_spec_id = spec;
      source.display_name =
        String(source.display_name) + " · " + raw.instance_id;
      const q = new Quaternion(...g.world_rotation);
      const asset = source.asset as Record<string, unknown>;
      asset.model_key = raw.instance_id + ".glb";
      asset.sha256 = digest;
      asset.import_transform = {
        position: [0, 0, 0],
        rotation_euler: new Euler().setFromQuaternion(q).toArray().slice(0, 3),
        scale: [1, 1, 1],
      };
      const specific = source.type_specific_contract as Record<string, unknown>;
      if (
        source.device_type === "linear_rail" &&
        specific.moving_node !== undefined
      ) {
        const child = scene.bundle.devices.find(
          (d) => d.instance_id === pair.child.instanceId,
        )!;
        const childRoot = bound.parse(child.node_binding).node_indices[0];
        // S07 models the moving column as the independently owned child device.
        if (specific.moving_node === scene.bundle.nodes[childRoot]?.name)
          delete specific.moving_node;
      }
      delete specific.mounted_on;
      delete specific.mounted_device;
      if (source.device_type === "lift_table") {
        const sim = specific.simulation as Record<string, unknown>;
        const vertical = z
          .object({ axis: vec, axis_frame: z.literal("scene_world_m") })
          .parse(specific.lift_motion);
        sim.axis_local = new Vector3(...vertical.axis)
          .applyQuaternion(q.clone().invert())
          .normalize()
          .toArray();
      }
      const def = normalizeDeviceSpec(source);
      def.asset = { ...def.asset, assetId, sha256: digest };
      def.template = false;
      const instance = instantiate(def, project.instances.length + i);
      instance.paramOverrides = Object.fromEntries(
        Object.entries(
          (raw.parameters ?? {}) as Record<string, string | number | boolean>,
        ).filter(([k]) => k in def.paramsSchema),
      );
      const assetRecord = {
        id: assetId,
        name: raw.instance_id + ".glb",
        kind: "glb" as const,
        size: sub.byteLength,
      };
      return {
        def,
        instance,
        assetRecord,
        blob: new Blob([sub]),
        position: g.world_position,
      };
    }),
  );
  // Place the independent pair together, clear of the original scene's measured world bounds.
  const maxX = Math.max(
    ...scene.bundle.devices.map(
      (d) =>
        z.object({ bounds: z.object({ max: vec }) }).parse(d.geometry).bounds
          .max[0],
    ),
  );
  const minX = Math.min(
    ...[pair.rail, pair.child].map(
      (e) =>
        z
          .object({ bounds: z.object({ min: vec }) })
          .parse(
            scene.bundle.devices.find((d) => d.instance_id === e.instanceId)!
              .geometry,
          ).bounds.min[0],
    ),
  );
  const rightmost = Math.max(
    maxX,
    ...project.instances.map((i) => i.transform.position[0]),
  );
  for (const p of extracted)
    p.instance.transform.position = [
      p.position[0] + rightmost - minX + 1,
      p.position[1],
      p.position[2],
    ];
  const [rail, child] = extracted;
  const connection: SpatialConnection = {
    id: crypto.randomUUID(),
    a: { ...pair.rail, instanceId: rail.instance.instanceId },
    b: { ...pair.child, instanceId: child.instance.instanceId },
  };
  const definitions = [...project.definitions];
  for (const p of extracted) {
    const existing = definitions.find((d) => d.specId === p.def.specId);
    if (
      existing &&
      JSON.stringify(existing.source) !== JSON.stringify(p.def.source)
    )
      throw new Error("独立设备版本与项目冲突");
    if (!existing) definitions.push(p.def);
  }
  const next = {
    ...project,
    definitions,
    instances: [...project.instances, ...extracted.map((p) => p.instance)],
    connections: [...(project.connections ?? []), connection],
    assets: [
      ...project.assets,
      ...extracted
        .map((p) => p.assetRecord)
        .filter((a) => !project.assets.some((v) => v.id === a.id)),
    ],
  };
  projectMountParents(next);
  const current = useWorkspace.getState();
  if (current.project !== project || current.documentLocked)
    throw new Error("提取期间项目已改变");
  // No await between checking the original document and attaching both assets to its revision.
  projectRepository.stageAssets(
    extracted.map((p) => ({
      record: next.assets.find((a) => a.id === p.assetRecord.id)!,
      blob: p.blob,
    })),
  );
  current.updateProject(() => next);
  current.select(rail.instance.instanceId);
  current.log("已添加独立滑轨与挂载设备");
  return rail.instance.instanceId;
}
