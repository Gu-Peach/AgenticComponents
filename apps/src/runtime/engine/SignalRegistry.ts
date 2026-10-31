import type { RuntimeSignal, SignalValue } from "@/contracts/runtime-signals";
export interface SignalDefinition {
  id: string;
  direction: "input" | "output";
  type: "BOOL" | "INT" | "DINT" | "REAL";
  min?: number;
  max?: number;
}
const conveyor: SignalDefinition[] = [
  { id: "runTag", direction: "input", type: "BOOL" },
  { id: "speedTag", direction: "input", type: "REAL", min: 0, max: 2 },
  ...["actual_speed", "encoderTag"].map((id) => ({
    id,
    direction: "output" as const,
    type: "REAL" as const,
  })),
  ...[
    "runningTag",
    "device_ready",
    "subject_on_conveyor",
    "part_ready",
    "entry_region_clear",
    "capacity_available",
    "accepted",
    "done",
    "busy",
    "error",
  ].map((id) => ({ id, direction: "output" as const, type: "BOOL" as const })),
];
export class SignalRegistry {
  private values: Record<string, RuntimeSignal> = {};
  private pending = new Map<string, SignalValue>();
  private definitions: Map<string, SignalDefinition>;
  constructor(
    definitions: SignalDefinition[] = conveyor,
    readonly instanceId = "",
  ) {
    if (new Set(definitions.map((d) => d.id)).size !== definitions.length)
      throw new Error("端口重复");
    this.definitions = new Map(definitions.map((d) => [d.id, d]));
  }
  private check(id: string, value: SignalValue, direction: "input" | "output") {
    const d = this.definitions.get(id);
    if (!d || d.direction !== direction) throw new Error("当前端口不可写");
    if (d.type === "BOOL") {
      if (typeof value !== "boolean") throw new Error(`${id} 需要BOOL`);
      return;
    }
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`${id} 需要有限数值`);
    const lo =
        d.min ??
        (d.type === "INT"
          ? -32768
          : d.type === "DINT"
            ? -2147483648
            : -Infinity),
      hi =
        d.max ??
        (d.type === "INT" ? 32767 : d.type === "DINT" ? 2147483647 : Infinity);
    if (
      (d.type !== "REAL" && !Number.isInteger(value)) ||
      value < lo ||
      value > hi
    )
      throw new Error(`${id} 类型或范围无效`);
  }
  command(id: string, value: SignalValue) {
    this.check(id, value, "input");
    this.pending.set(id, value);
  }
  begin(tick: number) {
    for (const [id, value] of this.pending)
      this.values[id] = { value, valid: true, tick, writer: "manual" };
    this.pending.clear();
  }
  read(id: string) {
    const s = this.values[id];
    if (!s?.valid) throw new Error(`信号无效: ${id}`);
    return s.value;
  }
  peek(id: string) {
    return this.values[id]?.valid ? this.values[id].value : undefined;
  }
  nextInput(id: string) {
    return this.pending.has(id) ? this.pending.get(id) : this.peek(id);
  }
  publish(id: string, value: SignalValue, tick: number) {
    this.check(id, value, "output");
    this.values[id] = { value, valid: true, tick, writer: "engine" };
  }
  snapshot() {
    return structuredClone(this.values);
  }
}
