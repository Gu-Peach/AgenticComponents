/** 从 DSL 控制流及设备声明的语义端口生成绑定，并在调用时重检本轮回执与当前物理事实。 */
import { z } from "zod";
import type { ConditionContext } from "@/contracts/conditions";
import type { ProcessNode } from "@/contracts/process-ir";
import type {
  SemanticFact,
  SignalConnection,
} from "@/contracts/semantic-ports";
export type {
  SemanticFact,
  SignalConnection,
} from "@/contracts/semantic-ports";

const portSchema = z
  .object({
    semantic: z.enum([
      "at",
      "supported_at",
      "stopped",
      "held_by",
      "retained_at",
      "processed",
    ]),
    subject: z.string().min(1),
    endpoint: z.string().min(1),
    value_type: z.literal("boolean").optional(),
    unit: z.literal("1").optional(),
  })
  .strict();
const declarations = z
  .object({ requires: z.array(portSchema), provides: z.array(portSchema) })
  .strict();
export interface StepFacts {
  requires: SemanticFact[];
  provides: SemanticFact[];
}
export function bindFactRoles(
  declaration: unknown,
  roles: Readonly<Record<string, string>>,
): StepFacts {
  const ports = declarations.parse(declaration);
  const role = (name: string) => {
    if (!Object.hasOwn(roles, name) || !roles[name])
      throw new Error("未绑定事实角色 " + name);
    return roles[name];
  };
  const bind = (port: SemanticFact): SemanticFact => ({
    semantic: port.semantic,
    subject: role(port.subject),
    endpoint: role(port.endpoint),
  });
  const resolve = (list: SemanticFact[]) => {
    const result = list.map(bind);
    if (new Set(result.map(factKey)).size !== result.length)
      throw new Error("动作语义接口重复");
    return result;
  };
  return {
    requires: resolve(ports.requires),
    provides: resolve(ports.provides),
  };
}
export function factKey(fact: SemanticFact) {
  return JSON.stringify([fact.semantic, fact.subject, fact.endpoint]);
}
interface Origin {
  // One writer or alternatives on mutually exclusive paths.
  producers: (string | null)[];
  ambiguous: boolean;
}
type FlowState = Map<string, Origin>;

function join(
  branches: FlowState[],
  incoming: FlowState,
  parallel: boolean,
): FlowState {
  const result = new Map(incoming);
  for (const key of new Set(branches.flatMap((branch) => [...branch.keys()]))) {
    const origins = branches.map((branch) => branch.get(key));
    if (!parallel && origins.some((origin) => !origin)) {
      result.delete(key);
      continue;
    }
    if (origins.every((origin) => origin === incoming.get(key))) continue;
    const writes = origins.filter(
      (origin): origin is Origin =>
        !!origin && (!parallel || origin !== incoming.get(key)),
    );
    if (!writes.length) continue;
    result.set(key, {
      producers: [...new Set(writes.flatMap((w) => w.producers))],
      ambiguous:
        writes.some((w) => w.ambiguous) || (parallel && writes.length > 1),
    });
  }
  return result;
}
/** 顺序节点逐步传递输出，并行兄弟仅在汇合之后可见，分支只消费实际成功的路径。 */
export function compileSignalConnections(
  root: ProcessNode,
  steps: ReadonlyMap<string, StepFacts>,
  initial: readonly SemanticFact[] = [],
): SignalConnection[] {
  const connections: SignalConnection[] = [];
  const visited = new Set<string>();
  function visit(node: ProcessNode, incoming: FlowState): FlowState {
    if (visited.has(node.id)) throw new Error("重复工步 " + node.id);
    visited.add(node.id);
    if (node.kind === "seq")
      return node.children.reduce(
        (state, child) => visit(child, state),
        incoming,
      );
    if (node.kind === "par")
      return join(
        node.children.map((child) => visit(child, incoming)),
        incoming,
        true,
      );
    if (node.kind === "branch")
      return join(
        [...node.cases.map((c) => c.body), node.otherwise].map((child) =>
          visit(child, incoming),
        ),
        incoming,
        false,
      );
    if (node.kind === "repeat") {
      const once = visit(node.body, incoming);
      return "count" in node &&
        node.count.kind === "literal" &&
        typeof node.count.value === "number" &&
        node.count.value >= 1
        ? once
        : incoming;
    }
    if (node.kind === "with-control") return visit(node.body, incoming);
    if (node.kind !== "invoke") return incoming;
    const declaration = steps.get(node.id);
    if (!declaration) throw new Error("工步缺少事实接口 " + node.id);
    const result = new Map(incoming);
    for (const fact of declaration.requires) {
      const origin = incoming.get(factKey(fact));
      const label =
        node.id +
        " / " +
        fact.semantic +
        "(" +
        fact.subject +
        ", " +
        fact.endpoint +
        ")";
      if (!origin) throw new Error(label + "：缺少可达的生产者或初始观测");
      if (origin.ambiguous)
        throw new Error(
          label + "：有多个生产者 " + origin.producers.join(", "),
        );
      connections.push({
        ...fact,
        consumer: node.id,
        producer: origin.producers[0],
        alternatives: origin.producers.slice(1),
      });
    }
    for (const fact of declaration.provides)
      result.set(factKey(fact), { producers: [node.id], ambiguous: false });
    return result;
  }
  visit(
    root,
    new Map(
      initial.map((f) => [factKey(f), { producers: [null], ambiguous: false }]),
    ),
  );
  return connections;
}
export interface FactReceipt {
  producer: string;
  runId: string;
  requestId: string;
  activationId: string;
  fact: SemanticFact;
}
/** 调用者从调度器选择本次激活的前驱；新请求号与生产者的请求号可以不同。 */
export function connectedFactsHold(
  connections: readonly SignalConnection[],
  consumer: string,
  c: ConditionContext,
  receipts: readonly FactReceipt[],
  current: (fact: SemanticFact) => boolean | undefined,
  successfulRequest: (
    producer: string,
  ) => { requestId: string; activationId: string } | undefined,
): boolean | undefined {
  let known = true;
  for (const edge of connections) {
    if (edge.consumer !== consumer) continue;
    const live = current(edge);
    if (live === false) return false;
    if (live === undefined) known = false;
    const sources = [edge.producer, ...edge.alternatives];
    const active = sources.flatMap((producer) => {
      if (producer === null) return [];
      const owner = successfulRequest(producer);
      return owner ? [{ producer, ...owner }] : [];
    });
    if (!active.length && sources.includes(null)) continue;
    if (!active.length) return false;
    // Parallel writers were rejected by the compiler. An exclusive branch
    // may preserve an incoming fact or replace it with a newer successful request.
    const owner = active.reduce((latest, candidate) =>
      Number(candidate.requestId) > Number(latest.requestId)
        ? candidate
        : latest,
    );

    if (
      !receipts.some(
        (r) =>
          r.producer === owner.producer &&
          r.runId === c.frame.runId &&
          r.requestId === owner.requestId &&
          r.activationId === owner.activationId &&
          factKey(r.fact) === factKey(edge),
      )
    )
      return false;
  }
  return known ? true : undefined;
}
