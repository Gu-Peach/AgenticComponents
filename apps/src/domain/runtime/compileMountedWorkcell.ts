/** 从项目安装接口、独立设备 GLB 和数值工艺编译滑轨/升降轴。 */
import { Box3, Quaternion, Vector3 } from "three";
import { z } from "zod";
import type { DeviceInstance, ProjectDocument, Vec3 } from "@/contracts/device";
import type { PhysicsConfig, RuntimeBody } from "@/contracts/physics";
import {
  childrenOf,
  decodeProcessNode,
  type ProcessNode,
} from "@/contracts/process-ir";
import { resolveParameters } from "@/validation/contracts";
import { resolveDeviceAction } from "@/devices/registry";
import { projectMountParents } from "@/domain/spatial/mounts";
import { interfaceWorld } from "@/domain/spatial/snap";
import { identityTransform, matrixOf } from "@/domain/spatial/transforms";
import { SceneGeometryReader } from "./SceneGeometryReader";

const vec = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const unit = vec.refine((v) => Math.abs(Math.hypot(...v) - 1) < 1e-5);
const limits = z
  .tuple([z.number().finite(), z.number().finite()])
  .refine(([lo, hi]) => lo <= 0 && hi >= 0 && lo < hi);
const deviceSimulation = z.object({ limits_m: limits, axis_local: unit });
const liftSimulation = deviceSimulation.extend({
  platform_node: z.string().min(1),
  anchor_local_m: vec,
});
type NodeInfo = {
  name?: string;
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
};
export interface GlbTree {
  nodes: NodeInfo[];
  scenes: { nodes: number[] }[];
  scene?: number;
}
export function readGlbTree(bytes: ArrayBuffer): GlbTree {
  const v = new DataView(bytes);
  return JSON.parse(
    new TextDecoder().decode(new Uint8Array(bytes, 20, v.getUint32(12, true))),
  );
}
export function subtreeNodes(nodes: NodeInfo[], roots: readonly number[]) {
  const seen = new Set<number>();
  function walk(i: number) {
    if (seen.has(i) || !nodes[i]) throw new Error("模型节点归属不明确");
    seen.add(i);
    nodes[i].children?.forEach(walk);
  }
  roots.forEach(walk);
  return seen;
}
export function mountedProcess(
  railTarget: number,
  liftHeight?: number,
): ProcessNode {
  const position = (
    id: string,
    role: string,
    behavior: string,
    key: string,
    value: number,
  ): ProcessNode => ({
    id,
    kind: "invoke",
    device: { kind: "ref", name: role },
    behavior,
    arguments: {
      [key]: {
        kind: "quantity",
        args: [
          { kind: "literal", value },
          { kind: "literal", value: "m" },
        ],
        kwargs: {},
      },
    },
  });
  return {
    id: "position_assembly",
    kind: "seq",
    children: [
      position(
        "rail_position",
        "rail",
        "move_to_position",
        "position_m",
        railTarget,
      ),
      ...(liftHeight === undefined
        ? []
        : [
            position(
              "platform_height",
              "lift",
              "lift_to_level",
              "move_to_level",
              liftHeight,
            ),
          ]),
    ],
  };
}
export interface WorkcellAxis {
  id: string;
  role: "rail" | "lift";
  direction: Vec3;
  limits: [number, number];
  rest: number;
  speed: number;
  acceleration: number;
  tolerance: number;
  settleSpeed: number;
  measuredBody: string;
  referenceBody?: string;
  spec: Record<string, unknown>;
  parameters: Record<string, unknown>;
}
export interface MountMember {
  id: string;
  body: string;
  node?: string;
}
export interface MountedWorkcell {
  axes: WorkcellAxis[];
  physics: PhysicsConfig;
  members: MountMember[];
  root: ProcessNode;
  bodyAxes: Map<string, string[]>;
  sweptParts: Map<string, { center: Vec3; size: Vec3 }[]>;
  obstacles: RuntimeBody[];
}
/** 无资产的模板仅在编辑器绘制示意图；已登记的实际型号必须提供几何。 */
export function visibleMountedWorldDevices(project: ProjectDocument) {
  return project.instances.filter((i) => {
    const d = project.definitions.find(
      (d) => d.specId === i.specId && d.revision === i.specRevision,
    );
    return i.visible && !(d?.template && !d.asset.assetId);
  });
}
export function compileMountedWorkcell(
  project: ProjectDocument,
  rail: string,
  assets: ReadonlyMap<string, ArrayBuffer>,
  ir: unknown,
): MountedWorkcell {
  const definition = (i: DeviceInstance) => {
    const def = project.definitions.find(
      (d) => d.specId === i.specId && d.revision === i.specRevision,
    );
    if (!def) throw new Error("设备版本缺失 " + i.instanceId);
    return def;
  };
  const byId = new Map(project.instances.map((i) => [i.instanceId, i]));
  const parentMap = projectMountParents(project);
  const rootDevice = byId.get(rail);
  if (
    !rootDevice?.visible ||
    definition(rootDevice).deviceType !== "linear_rail"
  )
    throw new Error("请选择滑轨");
  const children = project.instances.filter(
    (i) => parentMap.get(i.instanceId)?.instanceId === rail,
  );
  if (children.length !== 1)
    throw new Error("请先将一个设备底部接口吸附到滑座");
  const child = children[0];
  if ([...parentMap.values()].some((e) => e.instanceId === child.instanceId))
    throw new Error("请运行单层滑座挂载组合");
  const railPort = parentMap.get(child.instanceId)!;
  const carriage = interfaceWorld(
    rootDevice,
    definition(rootDevice),
    railPort.interfaceId,
  )!;
  const bodies: RuntimeBody[] = [],
    axes: WorkcellAxis[] = [],
    members: MountMember[] = [];
  const bodyAxes = new Map<string, string[]>();
  const obstacles: RuntimeBody[] = [];
  const sweptParts = new Map<string, { center: Vec3; size: Vec3 }[]>();
  for (const i of [
    rootDevice,
    child,
    ...visibleMountedWorldDevices(project).filter(
      (i) => i !== rootDevice && i !== child,
    ),
  ]) {
    const def = definition(i),
      bytes = assets.get(i.instanceId),
      key = i.instanceId;
    if (
      !i.visible ||
      ((i === rootDevice || i === child) && def.template) ||
      !bytes
    )
      throw new Error("可见设备缺少用于扫掠校验的真实几何：" + key);
    const imp = def.asset.importTransform ?? identityTransform;
    if ([...imp.scale, ...i.transform.scale].some((n) => n !== 1))
      throw new Error("轴运行需要米制单位缩放");
    const matrix = matrixOf(i.transform).multiply(matrixOf(imp));
    const raw = readGlbTree(bytes),
      geom = new SceneGeometryReader(bytes);
    const activeNodes = subtreeNodes(
      raw.nodes,
      raw.scenes[raw.scene ?? 0].nodes,
    );
    const all = [...activeNodes].filter((j) => raw.nodes[j].mesh !== undefined);
    const motionNode = (name: string) => {
      const matches = [...activeNodes].filter(
        (j) => raw.nodes[j].name === name,
      );
      if (matches.length !== 1)
        throw new Error("移动部件节点缺失或重名：" + key + "/" + name);
      return matches[0];
    };
    const boundsFor = (meshes: number[]) => {
      const parts = geom.convexParts(meshes, [0, 0, 0], 1);
      if (!meshes.length || parts.length !== meshes.length)
        throw new Error("设备几何不完整：" + key);
      return parts.map((points) =>
        new Box3().setFromPoints(
          points.map((v) => new Vector3(...v).applyMatrix4(matrix)),
        ),
      );
    };
    if (i !== rootDevice && i !== child) {
      for (const [n, box] of boundsFor(all).entries()) {
        const b: RuntimeBody = {
          id: key + "/obstacle/" + n,
          instanceId: key,
          role: "support",
          motionType: "static",
          position: box.getCenter(new Vector3()).toArray(),
          size: box
            .getSize(new Vector3())
            .max(new Vector3(0.001, 0.001, 0.001))
            .toArray(),
          rotation: [0, 0, 0, 1],
          friction: 0.5,
          restitution: 0,
        };
        obstacles.push(b);
        bodies.push(b);
      }
      continue;
    }
    const p = resolveParameters(def, i.paramOverrides);
    const param = (name: string) => {
      const n = p[name];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0)
        throw new Error(key + " 缺少轴参数 " + name);
      return n;
    };
    const body = (
      suffix: string,
      mesh: number[],
      drives: string[],
      node?: string,
    ) => {
      const boxes = boundsFor(mesh);
      const box = boxes.reduce((acc, b) => acc.union(b), new Box3());
      const center = box.getCenter(new Vector3()).toArray(),
        size = box
          .getSize(new Vector3())
          .max(new Vector3(0.001, 0.001, 0.001))
          .toArray();
      const id = key + "/" + suffix;
      if (drives.length)
        sweptParts.set(
          id,
          boxes.map((b) => ({
            center: b.getCenter(new Vector3()).toArray(),
            size: b.getSize(new Vector3()).toArray(),
          })),
        );
      bodies.push({
        id,
        instanceId: key,
        role: "support",
        motionType: drives.length ? "kinematic" : "static",
        size,
        position: center,
        rotation: [0, 0, 0, 1],
        friction: 0.5,
        restitution: 0,
      });
      bodyAxes.set(id, drives);
      if (drives.length) members.push({ id: key, body: id, node });
      return id;
    };
    if (key === rail) {
      const sim = deviceSimulation.parse(def.typeSpecificContract.simulation),
        spec = def.source!;
      resolveDeviceAction(spec, "move_to_position");
      const proxy = key + "/carriage";
      const named = def.typeSpecificContract.moving_node;
      if (named !== undefined) {
        const name = z.string().min(1).parse(named);
        const moving = subtreeNodes(raw.nodes, [motionNode(name)]);
        body(
          "fixed",
          all.filter((j) => !moving.has(j)),
          [],
        );
        body(
          "carriage",
          all.filter((j) => moving.has(j)),
          [key],
          name,
        );
      } else {
        body("fixed", all, []);
        bodies.push({
          id: proxy,
          instanceId: key,
          motionType: "kinematic",
          role: "support",
          sensor: true,
          size: [0.001, 0.001, 0.001],
          position: carriage.position.toArray(),
          rotation: [0, 0, 0, 1],
          friction: 0,
          restitution: 0,
        });
        bodyAxes.set(proxy, [key]);
      }
      axes.push({
        id: key,
        role: "rail",
        limits: sim.limits_m,
        direction: new Vector3(...sim.axis_local)
          .transformDirection(matrix)
          .toArray(),
        rest: 0,
        speed: param("travel_speed_mps"),
        acceleration: param("travel_accel_mps2"),
        tolerance: param("position_tolerance_m"),
        settleSpeed: param("settle_speed_mps"),
        measuredBody: proxy,
        spec,
        parameters: p,
      });
    } else if (def.deviceType === "lift_table") {
      const sim = liftSimulation.parse(def.typeSpecificContract.simulation),
        spec = def.source!;
      resolveDeviceAction(spec, "lift_to_level");
      const platformNode = motionNode(sim.platform_node);
      const moving = subtreeNodes(raw.nodes, [platformNode]);
      const base = body(
        "base",
        all.filter((j) => !moving.has(j)),
        [rail],
      );
      const platform = body(
        "platform",
        all.filter((j) => moving.has(j)),
        [rail, key],
        sim.platform_node,
      );
      const direction = new Vector3(...sim.axis_local).transformDirection(
        matrix,
      );
      const frame = geom.nodePose(platformNode);
      const point = new Vector3(...sim.anchor_local_m)
        .applyQuaternion(new Quaternion(...frame.rotation))
        .add(new Vector3(...frame.position))
        .applyMatrix4(matrix);
      const rest = point
        .sub(new Vector3().setFromMatrixPosition(matrix))
        .dot(direction);
      axes.push({
        id: key,
        role: "lift",
        direction: direction.toArray(),
        limits: sim.limits_m,
        rest,
        speed: param("lift_speed_mps"),
        acceleration: param("lift_accel_mps2"),
        tolerance: param("position_tolerance_m"),
        settleSpeed: param("settle_speed_mps"),
        measuredBody: platform,
        referenceBody: base,
        spec,
        parameters: p,
      });
    } else body("base", all, [rail]);
  }
  const root = decodeProcessNode(ir);
  let motions = 0;
  function validate(n: ProcessNode) {
    if (n.kind === "invoke") {
      motions++;
      const role = n.device.kind === "ref" && n.device.name,
        axis = axes.find((a) => a.role === role || a.id === role);
      if (!axis) throw new Error(n.id + "：未知轴实例");
      const isRail = axis.role === "rail",
        arg = isRail ? "position_m" : "move_to_level",
        e = n.arguments[arg];
      if (
        n.behavior !== (isRail ? "move_to_position" : "lift_to_level") ||
        n.payload ||
        Object.keys(n.arguments).length !== 1 ||
        e?.kind !== "quantity" ||
        e.args.length !== 2 ||
        e.args[0].kind !== "literal" ||
        typeof e.args[0].value !== "number" ||
        e.args[1].kind !== "literal" ||
        e.args[1].value !== "m"
      )
        throw new Error(n.id + "：需要已声明的数值定位行为及米制目标");
      const q = e.args[0].value - axis.rest;
      if (q < axis.limits[0] || q > axis.limits[1])
        throw new Error(n.id + "：目标超出轴行程");
    }
    childrenOf(n).forEach(validate);
  }
  validate(root);
  if (!motions) throw new Error("定位工艺没有调用任何轴行为");
  return {
    axes,
    root,
    members,
    bodyAxes,
    sweptParts,
    obstacles,
    physics: {
      bodies,
      surfaces: [],
      targetBodyId: axes[0].measuredBody,
      surfacePosition: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      surfaceSize: [1, 1, 1],
      materialPosition: [0, 0, 0],
      materialSize: [1, 1, 1],
      mass: 1,
      friction: 0.5,
    },
  };
}
