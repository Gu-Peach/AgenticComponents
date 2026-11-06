import {
  childrenOf,
  decodeProcessNode,
  type Expression,
  type ProcessNode,
} from "@/contracts/process-ir";
import type {
  ActionBinding,
  BoundProcess,
  ExpressionReader,
  SchedulerDeadlines,
} from "@/contracts/scheduler";
import type { ConditionProviders } from "@/runtime/signals/ConditionProviders";
import { immutable } from "@/runtime/scheduler/expressions";
export interface BindProcessOptions {
  scope: Record<string, unknown>;
  actions: readonly ActionBinding[];
  providers: ConditionProviders;
  readers?: Record<string, ExpressionReader>;
  finalization: readonly string[];
  iterationGates?: BoundProcess["iterationGates"];
  deadlines?: Partial<SchedulerDeadlines>;
}
export function bindProcess(
  raw: unknown,
  options: BindProcessOptions,
): BoundProcess {
  const root = decodeProcessNode(raw),
    actions = new Map<string, ActionBinding>();
  const deadlines = {
    preconditions: 1800,
    acceptance: 1800,
    execution: 7200,
    stop: 1800,
    collection: 1800,
    finalization: 1800,
    ...options.deadlines,
  };
  for (const n of Object.values(deadlines))
    if (!Number.isSafeInteger(n) || n < 1 || n > 5184000)
      throw new Error("Invalid lifecycle deadline");
  for (const b of options.actions) {
    const key = `${b.device}.${b.behavior}`;
    if (actions.has(key) || !b.stopped.length || !b.completion.length)
      throw new Error("Incomplete or duplicate action binding");
    options.providers.validate([
      ...b.preconditions,
      ...b.authorization,
      ...b.sustaining,
      ...b.completion,
      ...b.release,
      ...b.stopped,
    ]);
    actions.set(key, Object.freeze({ ...b }));
  }
  if (!options.finalization.length)
    throw new Error("Independent finalization is required");
  options.providers.validate(options.finalization);
  const readers = Object.freeze({ ...options.readers });
  const ids = new Set<string>();
  const expr = (e: Expression) => {
    if ("args" in e) {
      if (
        ["items_at", "fact", "calibration", "subject_id"].includes(e.kind) &&
        !readers[e.kind]
      )
        throw new Error("Missing expression reader: " + e.kind);
      const arity: Record<string, number> = {
        quantity: 2,
        seconds: 1,
        milliseconds: 1,
        subject_id: 1,
        calibration: 2,
        items_at: 1,
        payload: 1,
        fact: 1,
        select: 1,
        chunks: 1,
        eq: 2,
        ne: 2,
        lt: 2,
        le: 2,
        gt: 2,
        ge: 2,
        not_: 1,
      };
      if (
        (e.kind in arity && e.args.length !== arity[e.kind]) ||
        (["all_of", "any_of"].includes(e.kind) && !e.args.length)
      )
        throw new Error("Invalid expression arity");
      if (
        !["items_at", "fact", "payload", "select", "chunks"].includes(e.kind) &&
        Object.keys(e.kwargs).length
      )
        throw new Error("Unexpected expression keywords");
      if (
        e.kind === "chunks" &&
        (Object.keys(e.kwargs).length !== 1 || !e.kwargs.size)
      )
        throw new Error("Chunks requires size");
      if (
        e.kind === "items_at" &&
        Object.keys(e.kwargs).some((k) => k !== "category")
      )
        throw new Error("Invalid inventory selector");
      e.args.forEach(expr);
      Object.values(e.kwargs).forEach(expr);
    } else if (e.kind === "field") expr(e.base);
    else if (e.kind === "add" || e.kind === "sub") {
      expr(e.left);
      expr(e.right);
    } else if (e.kind === "map") Object.values(e.items).forEach(expr);
    else if (e.kind === "list") e.items.forEach(expr);
  };
  const visit = (n: ProcessNode) => {
    ids.add(n.id);
    if (n.kind === "invoke" || n.kind === "with-control") {
      if (n.device.kind !== "ref")
        throw new Error("Runtime requires a statically bound device");
      const key = `${n.device.name}.${n.kind === "invoke" ? n.behavior : n.control}`,
        b = actions.get(key);
      if (!b || Boolean(b.continuous) !== (n.kind === "with-control"))
        throw new Error("Unsupported action or continuous mode: " + key);
      if (n.kind === "invoke") {
        Object.values(n.arguments).forEach(expr);
        if (n.payload) expr(n.payload);
      } else expr(n.setpoints);
      if (n.kind === "with-control") {
        const device = n.device.name;
        const inspect = (child: ProcessNode) => {
          if (
            (child.kind === "invoke" || child.kind === "with-control") &&
            child.device.kind === "ref" &&
            child.device.name === device
          )
            throw new Error(
              "Continuous scope cannot implicitly delegate its device lease",
            );
          childrenOf(child).forEach(inspect);
        };
        inspect(n.body);
      }
    } else if (n.kind === "repeat") {
      if ("count" in n) expr(n.count);
      else {
        if (
          n.bind in options.scope ||
          ["arguments", "payload", "task", "batch"].includes(n.bind)
        )
          throw new Error("Loop binding shadows reserved/global symbol");
        expr(n.over);
        expr(n.limit);
      }
    } else if (n.kind === "branch") {
      expr(n.timeout);
      n.cases.forEach((c) => expr(c.condition));
    } else if (n.kind === "delay") expr(n.duration);
    childrenOf(n).forEach(visit);
  };
  visit(root);
  for (const [id, g] of Object.entries(options.iterationGates ?? {})) {
    if (!ids.has(id)) throw new Error("Orphan iteration contract");
    options.providers.validate([...g.entry, ...g.completion]);
  }
  return Object.freeze({
    root: immutable(root),
    scope: immutable(structuredClone(options.scope)),
    actions,
    providers: options.providers,
    readers,
    deadlines: Object.freeze(deadlines),
    finalization: [...options.finalization],
    iterationGates: structuredClone(options.iterationGates ?? {}),
  });
}
