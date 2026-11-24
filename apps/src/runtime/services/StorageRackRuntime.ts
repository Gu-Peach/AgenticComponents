/** 按请求号预留货架格位，在交接确认后更新格位占用并记录存取事件，取消时释放对应的预留。 */

export interface StorageEvent {
  kind: "stored" | "retrieved";
  material: string;
  slot: string;
  request: string;
  tick: number;
}
/** Passive inventory: only correlated, physically confirmed transfers commit. */
export class StorageRackRuntime {
  private occupancy = new Map<string, string>();
  private reservations = new Map<string, string>();
  private committed = new Set<string>();
  readonly events: StorageEvent[] = [];
  constructor(readonly slots: ReadonlySet<string>) {}
  available(slot: string, material?: string) {
    return (
      this.slots.has(slot) &&
      (!this.occupancy.has(slot) || this.occupancy.get(slot) === material) &&
      !this.reservations.has(slot)
    );
  }
  contains(slot: string, material: string) {
    return this.occupancy.get(slot) === material;
  }
  reserve(slot: string, request: string, material?: string) {
    if (!this.available(slot, material)) throw new Error("Slot unavailable");
    this.reservations.set(slot, request);
  }
  commit(
    kind: StorageEvent["kind"],
    slot: string,
    material: string,
    request: string,
    tick: number,
  ) {
    if (this.committed.has(request))
      throw new Error("Duplicate storage receipt");
    if (
      this.reservations.get(slot) !== request ||
      (kind === "stored"
        ? this.occupancy.has(slot)
        : !this.contains(slot, material))
    )
      throw new Error("Storage transaction identity differs");
    if (kind === "stored") this.occupancy.set(slot, material);
    else this.occupancy.delete(slot);
    this.reservations.delete(slot);
    this.committed.add(request);
    this.events.push({ kind, slot, material, request, tick });
  }
  cancel(slot: string, request: string) {
    if (this.reservations.get(slot) === request) this.reservations.delete(slot);
  }
  snapshot() {
    return {
      occupancy: Object.fromEntries(this.occupancy),
      reservations: Object.fromEntries(this.reservations),
      events: [...this.events],
    };
  }
}
