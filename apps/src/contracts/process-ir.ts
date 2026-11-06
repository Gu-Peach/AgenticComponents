import { z } from "zod";
export type Expression =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "ref"; name: string }
  | { kind: "field"; base: Expression; field: string }
  | { kind: "add" | "sub"; left: Expression; right: Expression }
  | { kind: "list"; items: Expression[] }
  | { kind: "map"; items: Record<string, Expression> }
  | {
      kind:
        | "quantity"
        | "seconds"
        | "milliseconds"
        | "subject_id"
        | "calibration"
        | "items_at"
        | "payload"
        | "fact"
        | "select"
        | "chunks"
        | "eq"
        | "ne"
        | "lt"
        | "le"
        | "gt"
        | "ge"
        | "all_of"
        | "any_of"
        | "not_";
      args: Expression[];
      kwargs: Record<string, Expression>;
    };
type Base = {
  id: string;
  source?: { file: string; line: number; column: number };
};
export type ProcessNode = Base &
  (
    | { kind: "seq"; children: ProcessNode[] }
    | { kind: "par"; join: "all"; children: ProcessNode[] }
    | { kind: "repeat"; count: Expression; body: ProcessNode }
    | {
        kind: "repeat";
        over: Expression;
        bind: string;
        limit: Expression;
        body: ProcessNode;
      }
    | {
        kind: "branch";
        mode: "exclusive" | "ordered";
        timeout: Expression;
        cases: { condition: Expression; body: ProcessNode }[];
        otherwise: ProcessNode;
      }
    | {
        kind: "invoke";
        device: Expression;
        behavior: string;
        arguments: Record<string, Expression>;
        payload?: Expression;
      }
    | {
        kind: "with-control";
        device: Expression;
        control: string;
        setpoints: Expression;
        body: ProcessNode;
      }
    | { kind: "delay"; duration: Expression }
    | { kind: "fail"; code: string }
  );
export const expressionSchema: z.ZodType<Expression> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal("literal"),
      value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
    }),
    z.object({
      kind: z.literal("ref"),
      name: z.string().regex(/^[A-Za-z][\w]*$/),
    }),
    z.object({
      kind: z.literal("field"),
      base: expressionSchema,
      field: z.string().regex(/^[A-Za-z][\w]*$/),
    }),
    z.object({
      kind: z.enum(["add", "sub"]),
      left: expressionSchema,
      right: expressionSchema,
    }),
    z.object({ kind: z.literal("list"), items: z.array(expressionSchema) }),
    z.object({
      kind: z.literal("map"),
      items: z.record(z.string(), expressionSchema),
    }),
    z.object({
      kind: z.enum([
        "quantity",
        "seconds",
        "milliseconds",
        "subject_id",
        "calibration",
        "items_at",
        "payload",
        "fact",
        "select",
        "chunks",
        "eq",
        "ne",
        "lt",
        "le",
        "gt",
        "ge",
        "all_of",
        "any_of",
        "not_",
      ]),
      args: z.array(expressionSchema),
      kwargs: z.record(z.string(), expressionSchema),
    }),
  ]),
);
const base = {
  id: z.string().min(1),
  source: z
    .object({
      file: z.string(),
      line: z.number().int().positive(),
      column: z.number().int().positive(),
    })
    .optional(),
};
export const processNodeSchema: z.ZodType<ProcessNode> = z.lazy(() =>
  z.union([
    z
      .object({
        ...base,
        kind: z.literal("seq"),
        children: z.array(processNodeSchema).min(1),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("par"),
        join: z.literal("all"),
        children: z.array(processNodeSchema).min(2),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("repeat"),
        count: expressionSchema,
        body: processNodeSchema,
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("repeat"),
        over: expressionSchema,
        bind: z.string().regex(/^[A-Za-z][\w]*$/),
        limit: expressionSchema,
        body: processNodeSchema,
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("branch"),
        mode: z.enum(["exclusive", "ordered"]),
        timeout: expressionSchema,
        cases: z
          .array(
            z.object({ condition: expressionSchema, body: processNodeSchema }),
          )
          .min(1),
        otherwise: processNodeSchema,
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("invoke"),
        device: expressionSchema,
        behavior: z.string().min(1),
        arguments: z.record(z.string(), expressionSchema),
        payload: expressionSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("with-control"),
        device: expressionSchema,
        control: z.string().min(1),
        setpoints: expressionSchema,
        body: processNodeSchema,
      })
      .strict(),
    z
      .object({ ...base, kind: z.literal("delay"), duration: expressionSchema })
      .strict(),
    z
      .object({ ...base, kind: z.literal("fail"), code: z.string().min(1) })
      .strict(),
  ]),
);
export function decodeProcessNode(raw: unknown): ProcessNode {
  let count = 0;
  const active = new Set<object>();
  function inspect(v: unknown, depth: number) {
    if (depth > 128 || ++count > 100000) throw new Error("IR budget exceeded");
    if (v && typeof v === "object") {
      if (active.has(v)) throw new Error("Cyclic IR");
      active.add(v);
      Object.values(v).forEach((x) => inspect(x, depth + 1));
      active.delete(v);
    }
  }
  inspect(raw, 0);
  const node = processNodeSchema.parse(raw);
  const ids = new Set<string>();
  function visit(n: ProcessNode) {
    if (ids.has(n.id)) throw new Error("Duplicate node ID");
    ids.add(n.id);
    childrenOf(n).forEach(visit);
  }
  visit(node);
  return node;
}
export function childrenOf(n: ProcessNode): ProcessNode[] {
  if (n.kind === "seq" || n.kind === "par") return n.children;
  if (n.kind === "repeat" || n.kind === "with-control") return [n.body];
  if (n.kind === "branch") return [...n.cases.map((c) => c.body), n.otherwise];
  return [];
}
