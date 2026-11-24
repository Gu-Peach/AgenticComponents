/** 为工艺节点一次性申请或释放所需的整组资源，优先处理较早等待同一资源的节点。 */

/** All-or-nothing leases. Persistent occupancy is represented separately by providers. */
export class ResourceArbiter {
  private owners = new Map<string, string>();
  private waiting = new Map<string, { keys: string[]; order: number }>();
  private order = 0;
  acquire(owner: string, keys: readonly string[]): boolean {
    const unique = [...new Set(keys)].sort();
    if (unique.some((k) => !k)) throw new Error("Invalid resource key");
    if (!this.waiting.has(owner))
      this.waiting.set(owner, { keys: unique, order: this.order++ });
    const request = this.waiting.get(owner)!;
    if (JSON.stringify(request.keys) !== JSON.stringify(unique))
      throw new Error("Resource footprint changed while waiting");
    if (unique.some((k) => this.owners.has(k) && this.owners.get(k) !== owner))
      return false;
    // Earlier conflicting candidates win even if a later node is visited first.
    if (
      [...this.waiting.entries()].some(
        ([id, w]) =>
          id !== owner &&
          w.order < request.order &&
          w.keys.some((k) => unique.includes(k)),
      )
    )
      return false;
    unique.forEach((k) => this.owners.set(k, owner));
    this.waiting.delete(owner);
    return true;
  }
  owns(owner: string, key: string) {
    return this.owners.get(key) === owner;
  }
  blockers(owner: string, keys: readonly string[]) {
    return keys.flatMap((key) => {
      const held = this.owners.get(key);
      return held && held !== owner ? [`${key} held by ${held}`] : [];
    });
  }
  release(owner: string) {
    for (const [key, id] of this.owners)
      if (id === owner) this.owners.delete(key);
    this.waiting.delete(owner);
  }
  snapshot() {
    return Object.fromEntries(this.owners);
  }
}
