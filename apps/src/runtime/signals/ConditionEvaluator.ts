import type { ConditionContext, Truth } from "@/contracts/conditions";
import type {
  BindingReading,
  CompiledCondition,
  ConditionBinding,
  ConditionDecision,
  ConditionExpr,
  ConditionNodeTrace,
} from "@/contracts/condition-expression";
export type ConditionBindingReader = (
  binding: ConditionBinding,
  context: ConditionContext,
) => BindingReading;
export function evaluateCondition(
  compiled: CompiledCondition,
  context: ConditionContext,
  read: ConditionBindingReader,
  opaque?: () => Truth,
): ConditionDecision {
  const nodes: ConditionNodeTrace[] = [];
  function visit(e: ConditionExpr, path: string): BindingReading {
    let r: BindingReading;
    let unit = "1";
    const good = (
      value: BindingReading["value"],
      samples: BindingReading[] = [],
    ) => ({
      value,
      quality: "good" as const,
      sampledTick: samples.length
        ? Math.min(...samples.map((s) => s.sampledTick))
        : context.frame.tick,
      source: "expression",
    });
    const unknown = (samples: BindingReading[] = []) =>
      ({
        ...good(null, samples),
        quality:
          samples.find((s) => s.quality !== "good")?.quality ?? "unknown",
        reason:
          samples.find((s) => s.quality !== "good")?.reason ??
          "missing evidence",
      }) as BindingReading;
    if (e.op === "literal") {
      r = good(e.value);
      unit = e.unit;
    } else if (e.op === "opaque") {
      const value = opaque?.();
      r =
        value === undefined
          ? unknown()
          : { ...good(value), source: "native:" + e.key };
    } else if (e.op === "ref") {
      const b = compiled.bindings[e.binding];
      unit = b.unit;
      try {
        r = read(b, context);
      } catch (error) {
        r = {
          ...unknown(),
          quality: "invalid",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      const v = r.value,
        valid =
          b.value_type === "number"
            ? typeof v === "number" && Number.isFinite(v)
            : b.value_type === "integer"
              ? typeof v === "number" && Number.isSafeInteger(v)
              : typeof v === b.value_type;
      if (r.quality === "good" && !valid)
        r = {
          ...r,
          value: null,
          quality: "invalid",
          reason: "binding result type mismatch",
        };
      if (r.quality !== "good") r = { ...r, value: null };
    } else if (e.op === "not") {
      const a = visit(e.arg, path + "/arg");
      r = a.value === null ? unknown([a]) : good(!a.value, [a]);
    } else if (e.op === "all" || e.op === "any") {
      // Read all leaves once: false/unknown siblings still need diagnostics.
      const args = e.args.map((x, i) => visit(x, path + "/args/" + i));
      const decisive = e.op === "all" ? false : true;
      r = args.some((a) => a.value === decisive)
        ? good(decisive, args)
        : args.some((a) => a.value === null)
          ? unknown(args)
          : good(!decisive, args);
    } else if (e.op === "compare") {
      const a = visit(e.left, path + "/left"),
        b = visit(e.right, path + "/right");
      r =
        a.value === null || b.value === null
          ? unknown([a, b])
          : good(
              e.operator === "eq"
                ? a.value === b.value
                : e.operator === "ne"
                  ? a.value !== b.value
                  : e.operator === "lt"
                    ? (a.value as number) < (b.value as number)
                    : e.operator === "le"
                      ? (a.value as number) <= (b.value as number)
                      : e.operator === "gt"
                        ? (a.value as number) > (b.value as number)
                        : (a.value as number) >= (b.value as number),
              [a, b],
            );
    } else throw new Error("Unsupported condition expression");
    nodes.push(
      Object.freeze({
        ...r,
        path,
        op: e.op,
        unit,
        ...(e.op === "ref" ? { binding: e.binding } : {}),
      }),
    );
    return r;
  }
  const cache = new Map<ConditionBinding, BindingReading>(),
    reader = read;
  read = (b, c) => {
    let r = cache.get(b);
    if (!r) {
      r = reader(b, c);
      cache.set(b, r);
    }
    return r;
  };
  const root = visit(compiled.expr, "");
  return Object.freeze({
    runId: context.frame.runId,
    nodeId: context.nodeId ?? compiled.key,
    activationId: context.activationId ?? context.request?.activationId ?? "",
    requestId: context.request?.requestId,
    subjectId: context.request?.subjectId,
    conditionKey: compiled.key,
    phase: context.phase ?? compiled.phase,
    evaluatedTick: context.tick,
    inputSampleTick: context.frame.tick,
    value: root.value === null ? null : root.value === compiled.expected,
    quality: root.quality,
    nodes: Object.freeze(nodes),
  });
}
