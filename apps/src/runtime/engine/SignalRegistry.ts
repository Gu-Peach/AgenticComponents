import type { RuntimeSignal, SignalValue } from "@/contracts/runtime-signals";
export class SignalRegistry {
  private values: Record<string, RuntimeSignal> = {};
  private pending = new Map<string, SignalValue>();
  command(id: string, value: SignalValue) {
    if (id === "runTag" && typeof value !== "boolean")
      throw new Error("runTag 需要 BOOL");
    if (
      id === "speedTag" &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 2)
    )
      throw new Error("速度范围为 0–2 m/s");
    if (!["runTag", "speedTag"].includes(id)) throw new Error("当前端口不可写");
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
  publish(id: string, value: SignalValue, tick: number) {
    const real = ["actual_speed", "encoderTag"];
    const bool = [
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
    ];
    if (
      real.includes(id)
        ? typeof value !== "number" || !Number.isFinite(value)
        : !bool.includes(id) || typeof value !== "boolean"
    )
      throw new Error("输出端口或类型不受支持");
    this.values[id] = { value, valid: true, tick, writer: "engine" };
  }
  snapshot() {
    return structuredClone(this.values);
  }
}
