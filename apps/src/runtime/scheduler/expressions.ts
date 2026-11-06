import type { Expression } from "@/contracts/process-ir";
import type { ConditionContext } from "@/runtime/signals/ConditionProviders";
import type { ExpressionReader } from "@/contracts/scheduler";
export const UNKNOWN = Symbol("unknown expression");
export function evaluate(
  e: Expression,
  c: ConditionContext,
  readers: Readonly<Record<string, ExpressionReader>>,
): unknown {
  const run = (x: Expression) => evaluate(x, c, readers);
  switch (e.kind) {
    case "literal":
      return e.value;
    case "ref":
      if (!Object.hasOwn(c.scope, e.name))
        throw new Error("Unbound symbol: " + e.name);
      return c.scope[e.name];
    case "field": {
      const base = run(e.base);
      if (base === UNKNOWN) return UNKNOWN;
      if (typeof base === "string") {
        const key = `${base}.${e.field}`;
        if (!Object.hasOwn(c.scope, key))
          throw new Error("Unbound location: " + key);
        return c.scope[key];
      }
      if (!base || typeof base !== "object" || !Object.hasOwn(base, e.field))
        throw new Error("Invalid field: " + e.field);
      return (base as Record<string, unknown>)[e.field];
    }
    case "list":
      return e.items.map(run);
    case "map":
      return Object.fromEntries(
        Object.entries(e.items).map(([k, v]) => [k, run(v)]),
      );
    case "add":
    case "sub": {
      const a = run(e.left),
        b = run(e.right);
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b))
        throw new Error("Expected integer count");
      return e.kind === "add"
        ? (a as number) + (b as number)
        : (a as number) - (b as number);
    }
  }
  const args = e.args.map(run),
    kw = Object.fromEntries(
      Object.entries(e.kwargs).map(([k, v]) => [k, run(v)]),
    );
  if (["all_of", "any_of", "not_"].includes(e.kind)) {
    if (args.some((v) => v !== UNKNOWN && typeof v !== "boolean"))
      throw new Error("Expected Boolean");
    if (e.kind === "all_of")
      return args.includes(false)
        ? false
        : args.includes(UNKNOWN)
          ? UNKNOWN
          : true;
    if (e.kind === "any_of")
      return args.includes(true)
        ? true
        : args.includes(UNKNOWN)
          ? UNKNOWN
          : false;
    return args[0] === UNKNOWN ? UNKNOWN : !args[0];
  }
  if (args.includes(UNKNOWN) || Object.values(kw).includes(UNKNOWN))
    return UNKNOWN;
  switch (e.kind) {
    case "quantity":
    case "seconds":
    case "milliseconds": {
      const v = args[0];
      if (typeof v !== "number" || !Number.isFinite(v))
        throw new Error("Invalid quantity");
      return {
        value: v,
        unit:
          e.kind === "quantity" ? args[1] : e.kind === "seconds" ? "s" : "ms",
      };
    }
    case "eq":
      return args[0] === args[1];
    case "ne":
      return args[0] !== args[1];
    case "lt":
    case "le":
    case "gt":
    case "ge": {
      if (args.some((v) => typeof v !== "number" || !Number.isFinite(v)))
        throw new Error("Expected numeric comparison");
      const [a, b] = args as number[];
      return e.kind === "lt"
        ? a < b
        : e.kind === "le"
          ? a <= b
          : e.kind === "gt"
            ? a > b
            : a >= b;
    }
    case "payload":
      return { binding: args[0], fields: kw };
    case "select": {
      if (!Array.isArray(args[0]))
        throw new Error("Select requires collection");
      return args[0].filter((row) => {
        if (
          !row ||
          typeof row !== "object" ||
          Object.keys(kw).some((k) => !Object.hasOwn(row, k))
        )
          throw new Error("Unknown selector field");
        return Object.entries(kw).every(([k, v]) => row[k] === v);
      });
    }
    case "chunks": {
      const size = kw.size;
      if (
        !Array.isArray(args[0]) ||
        !Number.isInteger(size) ||
        (size as number) < 1 ||
        (size as number) > 10000
      )
        throw new Error("Invalid chunks");
      const groups = [];
      for (let i = 0; i < args[0].length; i += size as number)
        groups.push(args[0].slice(i, i + (size as number)));
      return groups;
    }
    default: {
      const reader = readers[e.kind];
      if (!reader) throw new Error("Missing expression reader: " + e.kind);
      const value = reader(args, kw, c);
      return value === undefined ? UNKNOWN : value;
    }
  }
}
export function durationTicks(value: unknown, allowZero = false) {
  const q = value as { value: number; unit: string };
  if (
    !q ||
    typeof q.value !== "number" ||
    !Number.isFinite(q.value) ||
    !["s", "ms"].includes(q.unit) ||
    q.value < (allowZero ? 0 : Number.MIN_VALUE) ||
    q.value / (q.unit === "ms" ? 1000 : 1) > 86400
  )
    throw new Error("Invalid logical duration");
  return Math.ceil(q.value * (q.unit === "ms" ? 0.06 : 60));
}
export function immutable<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    Object.values(v).forEach(immutable);
  }
  return v;
}
