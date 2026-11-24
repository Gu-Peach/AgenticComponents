import { handoffCallBehavior } from "@/contracts/robot-handoff";
import type { SceneBundle } from "@/contracts/scene-package";
import { decodeProcessNode, type ProcessNode } from "@/contracts/process-ir";
import type { SceneLadder, SceneLadderRung } from "@/contracts/scene-ladder";
import { compileConditions } from "./compileConditions";
/** A read-only projection of the control tree; no execution order is inferred from device names. */
export function compileSceneLadder(bundle: SceneBundle): SceneLadder {
  const rungs: SceneLadderRung[] = [],
    ids = new Set<string>();
  function visit(
    n: ProcessNode,
    depth: number,
    parentId?: string,
    predecessor?: string,
  ) {
    if (ids.has(n.id)) throw new Error("Duplicate ladder source node: " + n.id);
    ids.add(n.id);
    const children =
      n.kind === "seq" || n.kind === "par"
        ? n.children
        : n.kind === "repeat" || n.kind === "with-control"
          ? [n.body]
          : n.kind === "branch"
            ? [...n.cases.map((c) => c.body), n.otherwise]
            : [];
    const rung: SceneLadderRung = {
      id: n.id,
      kind: n.kind,
      label:
        n.kind === "par"
          ? "并行分发"
          : n.kind === "seq"
            ? "顺序组织"
            : n.kind === "repeat"
              ? "有限循环"
              : n.kind === "branch"
                ? `分支选择 · ${n.mode}`
                : n.kind === "delay"
                  ? "仿真延迟"
                  : n.kind === "with-control"
                    ? "持续控制作用域"
                    : n.kind === "fail"
                      ? "失败终止"
                      : "行为工步",
      depth,
      parentId,
      predecessor,
      children: children.map((c) => c.id),
      conditions: [],
      source: n.source,
    };
    if (n.kind === "invoke" || n.kind === "with-control") {
      if (n.device.kind !== "ref")
        throw new Error("Ladder requires a resolved device reference");
      rung.device = n.device.name;
      rung.behavior = n.kind === "invoke" ? n.behavior : n.control;
      const device = bundle.devices.find((d) => d.instance_id === rung.device);
      if (!device) throw new Error("Ladder device missing");
      rung.conditions = compileConditions(
        rung.device,
        device.contract,
        bundle.runtime_profile === "robot-handoff@1" && n.kind === "invoke"
          ? handoffCallBehavior(n)
          : rung.behavior,
      );
    }
    rungs.push(rung);
    children.forEach((c, i) =>
      visit(
        c,
        depth + 1,
        n.id,
        n.kind === "seq" && i > 0 ? children[i - 1].id : undefined,
      ),
    );
    if (n.kind === "par")
      rungs.push({
        ...rung,
        id: n.id + "/join",
        kind: "join",
        label: "AND 汇合 · 等待本轮全部分支",
        parentId: n.id,
      });
  }
  const root = decodeProcessNode(bundle.process.body);
  visit(root, 0);
  rungs.push({
    id: root.id + "/finalization",
    kind: "finalization",
    parentId: root.id,
    depth: 0,
    label: "独立批次验收",
    children: [],
    conditions: [],
  });
  return { schema: "scene-ladder/0.1", rungs };
}
