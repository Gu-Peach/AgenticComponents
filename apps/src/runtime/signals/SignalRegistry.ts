import type {
  SceneSignalDefinition,
  SceneSignalFrame,
  SceneSignalSample,
  SignalChange,
  SignalWrite,
} from "@/contracts/scene-signals";

/** One registry per run. Input and feedback batches are validated before any write. */
export class SignalRegistry {
  private definitions = new Map<string, SceneSignalDefinition>();
  private samples: Record<string, Readonly<SceneSignalSample>> =
    Object.create(null);
  private revision = 0;
  private lastTick = 0;
  private sequence = 0;
  private events: SignalChange[] = [];
  constructor(
    readonly runId: string,
    definitions: readonly SceneSignalDefinition[],
    private traceCapacity = 10000,
  ) {
    if (!runId || !Number.isInteger(traceCapacity) || traceCapacity < 1)
      throw new Error("Invalid signal registry configuration");
    for (const d of definitions) {
      if (!d.key || !d.writer || this.definitions.has(d.key))
        throw new Error("Duplicate or invalid signal definition");
      if (
        d.maxAgeTicks !== undefined &&
        (!Number.isInteger(d.maxAgeTicks) || d.maxAgeTicks < 0)
      )
        throw new Error("Invalid freshness policy");
      if ((d.min ?? -Infinity) > (d.max ?? Infinity))
        throw new Error("Invalid signal range");
      this.definitions.set(d.key, Object.freeze({ ...d }));
      this.samples[d.key] = Object.freeze({
        runId,
        value: null,
        quality: "unknown",
        sampledTick: 0,
        changedTick: 0,
        writer: d.writer,
      });
    }
  }
  layout() {
    return [...this.definitions.values()];
  }
  private check(write: SignalWrite, direction: "input" | "output") {
    const d = this.definitions.get(write.key);
    if (!d || d.direction !== direction || d.writer !== write.writer)
      throw new Error(`Signal ownership violation: ${write.key}`);
    if (write.runId !== this.runId)
      throw new Error("Signal belongs to another run");
    const quality = write.quality ?? "good";
    if (!["good", "unknown", "invalid", "disconnected"].includes(quality))
      throw new Error("Invalid signal quality");
    if (quality !== "good") {
      if (direction === "input" || write.value !== null)
        throw new Error("Invalid feedback must have null value");
      return;
    }
    const value = write.value;
    if (d.type === "BOOL") {
      if (typeof value !== "boolean") throw new Error("Expected BOOL");
      return;
    }
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error("Expected finite numeric signal");
    const minimum =
      d.type === "INT" ? -32768 : d.type === "DINT" ? -2147483648 : -Infinity;
    const maximum =
      d.type === "INT" ? 32767 : d.type === "DINT" ? 2147483647 : Infinity;
    if (
      (d.type !== "REAL" && !Number.isInteger(value)) ||
      value < Math.max(minimum, d.min ?? -Infinity) ||
      value > Math.min(maximum, d.max ?? Infinity)
    )
      throw new Error("Signal outside declared range");
    if (d.type === "REAL" && !Number.isFinite(Math.fround(value)))
      throw new Error("REAL overflow");
  }
  validateInputs(writes: readonly SignalWrite[], tick: number) {
    this.validate(writes, tick, "input");
  }
  private validate(
    writes: readonly SignalWrite[],
    tick: number,
    direction: "input" | "output",
  ) {
    if (!Number.isSafeInteger(tick) || tick < this.lastTick)
      throw new Error("Signal tick moved backwards");
    const keys = new Set<string>();
    for (const w of writes) {
      if (keys.has(w.key))
        throw new Error("Multiple writes in one command frame");
      keys.add(w.key);
      this.check(w, direction);
    }
  }
  commitInputs(writes: readonly SignalWrite[], tick: number) {
    this.commit(writes, tick, "input");
  }
  publishFeedback(writes: readonly SignalWrite[], tick: number) {
    this.commit(writes, tick, "output");
  }
  private commit(
    writes: readonly SignalWrite[],
    tick: number,
    direction: "input" | "output",
  ) {
    this.validate(writes, tick, direction);
    for (const w of writes) {
      const old = this.samples[w.key],
        quality = w.quality ?? "good";
      const value =
        typeof w.value === "number" &&
        this.definitions.get(w.key)!.type === "REAL"
          ? Math.fround(w.value)
          : w.value;
      const changed =
        old.value !== value ||
        old.quality !== quality ||
        old.requestId !== w.requestId ||
        old.subjectId !== w.subjectId ||
        old.activationId !== w.activationId;
      const sample = Object.freeze({
        runId: w.runId,
        requestId: w.requestId,
        subjectId: w.subjectId,
        activationId: w.activationId,
        value,
        quality,
        sampledTick: tick,
        changedTick: changed ? tick : old.changedTick,
        writer: w.writer,
      });
      this.samples[w.key] = sample;
      if (changed) {
        this.events.push(
          Object.freeze({
            sequence: ++this.sequence,
            key: w.key,
            tick,
            sample,
          }),
        );
        if (this.events.length > this.traceCapacity) this.events.shift();
      }
    }
    this.lastTick = tick;
    this.revision++;
  }
  snapshot(tick = this.lastTick): Readonly<SceneSignalFrame> {
    if (!Number.isSafeInteger(tick) || tick < this.lastTick)
      throw new Error("Invalid snapshot tick");
    const samples: Record<string, Readonly<SceneSignalSample>> = Object.create(
      null,
    );
    for (const [key, d] of this.definitions) {
      const s = this.samples[key];
      samples[key] =
        s.quality === "good" &&
        d.maxAgeTicks !== undefined &&
        tick - s.sampledTick > d.maxAgeTicks
          ? Object.freeze({ ...s, quality: "stale" as const })
          : s;
    }
    return Object.freeze({
      runId: this.runId,
      tick,
      revision: this.revision,
      samples: Object.freeze(samples),
    });
  }
  trace(afterSequence = 0) {
    return {
      lost: afterSequence < (this.events[0]?.sequence ?? this.sequence + 1) - 1,
      lastSequence: this.sequence,
      events: this.events.filter((e) => e.sequence > afterSequence),
    };
  }
}
