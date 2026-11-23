import type {
  ObservationWrite,
  ObservationDefinition,
  ObservationSample,
  ObservationFrame,
} from "@/contracts/conditions";
export type {
  ObservationWrite,
  ObservationDefinition,
  ObservationSample,
  ObservationFrame,
} from "@/contracts/conditions";
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}
/** Non-port evidence (poses, support and inventory) stays outside the device I/O table. */
export class ObservationRegistry {
  private definitions = new Map<string, ObservationDefinition>();
  private samples: Record<string, Readonly<ObservationSample>> =
    Object.create(null);
  private tick = 0;
  private cached?: Readonly<ObservationFrame>;
  constructor(
    readonly runId: string,
    definitions: readonly ObservationDefinition[],
  ) {
    for (const d of definitions) {
      if (
        this.definitions.has(d.key) ||
        !Number.isSafeInteger(d.maxAgeTicks) ||
        d.maxAgeTicks < 0
      )
        throw new Error("Invalid observation layout");
      this.definitions.set(d.key, d);
    }
  }
  publish(writes: readonly ObservationWrite[], tick: number) {
    if (!Number.isSafeInteger(tick) || tick < this.tick)
      throw new Error("Invalid observation tick");
    const keys = new Set<string>();
    const next: Record<string, Readonly<ObservationSample>> = Object.create(
      null,
    );
    for (const w of writes) {
      const d = this.definitions.get(w.key);
      if (
        !d ||
        w.provider !== d.provider ||
        w.runId !== this.runId ||
        keys.has(w.key)
      )
        throw new Error("Invalid observation ownership/identity");
      keys.add(w.key);
      const quality = w.quality ?? "good";
      if (quality === "good" ? !d.validate(w.value) : w.value !== null)
        throw new Error("Invalid observation value");
      next[w.key] = freeze({
        ...structuredClone(w),
        quality,
        sampledTick: tick,
      });
    }
    Object.assign(this.samples, next);
    this.tick = tick;
    this.cached = undefined;
  }
  snapshot(tick = this.tick): Readonly<ObservationFrame> {
    if (tick < this.tick) throw new Error("Observation tick moved backwards");
    if (this.cached?.tick === tick) return this.cached;
    const samples = Object.create(null) as Record<
      string,
      Readonly<ObservationSample>
    >;
    for (const [key, s] of Object.entries(this.samples))
      samples[key] =
        s.quality === "good" &&
        tick - s.sampledTick > this.definitions.get(key)!.maxAgeTicks
          ? Object.freeze({ ...s, quality: "stale" as const })
          : s;
    return (this.cached = Object.freeze({
      runId: this.runId,
      tick,
      samples: Object.freeze(samples),
    }));
  }
}
