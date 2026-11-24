/** 从独立添加的输送带、工件、支承与机械臂编译输送抓放工艺，共用场景 DSL 的控制树及 DeviceSpec。 */
import { Vector3 } from "three";
import { observeRegions } from "@/runtime/engine/RegionObserver";
import type { ProjectDocument, DeviceDefinition } from "@/contracts/device";
import type { ProcessNode, Expression } from "@/contracts/process-ir";
import { childrenOf, decodeProcessNode } from "@/contracts/process-ir";
import {
  bindFactRoles,
  compileSignalConnections,
  type StepFacts,
} from "./compileSignalConnections";
import { evaluate } from "@/runtime/scheduler/expressions";
import type { ConditionContext } from "@/contracts/conditions";
import { getDeviceModule, resolveDeviceAction } from "@/devices/registry";

export interface TransferSelection {
  conveyor: string;
  material: string;
  robot: string;
  support: string;
}
/** 此 DSL 工艺的变量在准备时绑定到真实实例，可使用包含连字符的工作台实例 ID。 */
export function transferProcess(): ProcessNode {
  const literal = (value: string | number): Expression => ({
    kind: "literal",
    value,
  });
  const ref = (name: string): Expression => ({ kind: "ref", name });
  const location = (device: string, field: string): Expression => ({
    kind: "field",
    base: ref(device),
    field,
  });
  return {
    kind: "seq",
    id: "transfer",
    children: [
      {
        kind: "invoke",
        id: "arrive",
        device: { kind: "ref", name: "belt" },
        behavior: "transport_to_exit",
        arguments: {
          subject_id: {
            kind: "subject_id",
            args: [ref("material")],
            kwargs: {},
          },
        },
      },
      {
        kind: "invoke",
        id: "place",
        device: { kind: "ref", name: "arm" },
        behavior: "pick_and_place",
        arguments: {},
        payload: {
          kind: "payload",
          args: [literal("arm.pick_and_place")],
          kwargs: {
            material: ref("material"),
            source: location("belt", "exit"),
            target: location("receiver", "center"),
          },
        },
      },
    ],
  };
}
export function compileTransferWorkcell(
  project: ProjectDocument,
  selection: TransferSelection,
  ir: unknown = transferProcess(),
) {
  const definition = (
    id: string,
    type: string,
    version: string,
  ): DeviceDefinition => {
    const i = project.instances.find((i) => i.instanceId === id),
      d = project.definitions.find(
        (d) => d.specId === i?.specId && d.revision === i.specRevision,
      );
    if (
      !i?.visible ||
      !d ||
      d.template ||
      d.deviceType !== type ||
      d.source?.contract_version !== version
    )
      throw new Error("设备角色未绑定到有效实例：" + id + " / " + type);
    return d;
  };
  const beltDefinition = definition(selection.conveyor, "conveyor", "1.3");
  const robotDefinition = definition(selection.robot, "robot_arm", "1.4");
  resolveDeviceAction(beltDefinition.source!, "transport_to_exit");
  resolveDeviceAction(robotDefinition.source!, "pick_and_place");
  definition(selection.support, "conveyor", "1.3");
  definition(selection.material, "workpiece", "1.3");
  const belt = getDeviceModule("conveyor").compileStandalone(
    project,
    selection.conveyor,
    selection.material,
  );
  const robot = getDeviceModule("robot_arm").compileStandalone(
    project,
    selection.robot,
    { materialId: selection.material, supportId: selection.support },
  );
  const support = robot.physics!.surfaces![0],
    source = belt.physics.surfaces![0];
  const sourceSurface = selection.conveyor + "/surface";
  const targetSurface =
    selection.support === selection.conveyor ? sourceSurface : support.id;
  robot.supportSurfaceId = targetSurface;
  const bodies = new Map(belt.physics.bodies!.map((b) => [b.id, b]));
  for (const b of robot.physics!.bodies!)
    if (!bodies.has(b.id)) bodies.set(b.id, b);
  const physics = {
    ...belt.physics,
    bodies: [...bodies.values()],
    surfaces: [
      { ...source, id: sourceSurface },
      ...(selection.support === selection.conveyor ? [] : [support]),
    ],
  };
  const materialBody = belt.physics.targetBodyId!;
  const location = selection.conveyor + ".exit",
    destination = selection.support + ".center";
  const exitPoint = new Vector3(...belt.origin).addScaledVector(
    new Vector3(...source.direction),
    (belt.exit[0] + belt.exit[1]) / 2,
  );
  const root = decodeProcessNode(ir);
  // The role bindings are derived from the actual invoke payload, not from model names.
  const scope = {
    belt: selection.conveyor,
    arm: selection.robot,
    material: selection.material,
    receiver: selection.support,
    [location]: location,
    [destination]: destination,
  };
  const readers = {
    subject_id: (args: readonly unknown[]) =>
      args[0] === selection.material ? 1 : undefined,
  };
  const ctx: ConditionContext = {
    scope,
    tick: 0,
    frame: { runId: "prepare", tick: 0, revision: 0, samples: {} },
    owns: () => false,
  };
  const beltPorts =
    getDeviceModule("conveyor").contract.runtime_execution_contract
      .semantic_ports.transport_to_exit;
  const robotPorts =
    getDeviceModule("robot_arm").contract.runtime_execution_contract
      .semantic_ports.pick_and_place;
  const steps = new Map<string, StepFacts>();
  const arrivals = new Set<string>(),
    placements = new Set<string>();
  function bindNode(node: ProcessNode) {
    if (node.kind === "with-control")
      throw new Error("组合工艺尚无持续控制驱动：" + node.id);
    if (node.kind !== "invoke") {
      childrenOf(node).forEach(bindNode);
      return;
    }
    const symbol = node.device.kind === "ref" && node.device.name;
    if (symbol === "belt" && node.behavior === "transport_to_exit") {
      const arg = node.arguments.subject_id;
      if (
        !arg ||
        evaluate(arg, ctx, readers) !== 1 ||
        Object.keys(node.arguments).length !== 1 ||
        node.payload
      )
        throw new Error("输送参数与登记的工件不匹配：" + node.id);
      arrivals.add(node.id);
      steps.set(
        node.id,
        bindFactRoles(beltPorts, {
          material: selection.material,
          self: selection.conveyor,
          exit: location,
        }),
      );
      return;
    }
    if (symbol !== "arm" || node.behavior !== "pick_and_place")
      throw new Error(
        "组合工艺尚未绑定执行器：" + node.id + " / " + node.behavior,
      );
    const payload =
      node.payload &&
      (evaluate(node.payload, ctx, readers) as {
        binding?: string;
        fields?: Record<string, unknown>;
      });
    const fields = payload?.fields;
    if (
      !payload ||
      !["arm.pick_and_place", selection.robot + ".pick_and_place"].includes(
        payload.binding ?? "",
      ) ||
      !fields ||
      Object.keys(node.arguments).length ||
      Object.keys(fields).length !== 3 ||
      typeof fields.material !== "string" ||
      typeof fields.source !== "string" ||
      fields.target !== destination
    )
      throw new Error("抓放请求与型号、物料或放料点不匹配：" + node.id);
    placements.add(node.id);
    steps.set(
      node.id,
      bindFactRoles(robotPorts, {
        material: fields.material,
        source: fields.source,
        target: fields.target,
      }),
    );
  }
  bindNode(root);
  if (!placements.size) throw new Error("组合工艺需要机械臂放置工步");
  // Static geometry makes the source a candidate; the live condition still needs actual support.
  const load = bodies.get(materialBody)!;
  const startsAtExit = observeRegions(
    belt,
    { position: load.position, rotation: load.rotation, velocity: [0, 0, 0] },
    true,
  ).atExit;
  const initial = startsAtExit
    ? bindFactRoles(beltPorts, {
        material: selection.material,
        self: selection.conveyor,
        exit: location,
      }).provides
    : [];
  const connections = compileSignalConnections(root, steps, initial);
  return {
    selection: { ...selection },
    scope,
    readers,
    root,
    belt,
    robot,
    beltDefinition,
    robotDefinition,
    physics,
    materialBody,
    sourceSurface,
    targetSurface,
    location,
    destination,
    exitPoint: exitPoint.toArray(),
    arrivals,
    placements,
    steps,
    connections,
  };
}
export type TransferWorkcell = ReturnType<typeof compileTransferWorkcell>;
