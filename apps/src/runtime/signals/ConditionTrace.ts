/** 保存各条件的最新判定和有限条状态变化记录，供诊断时追溯判定依据及对照结果。 */

import type {
  ConditionDecision,
  ConditionDiagnostics,
} from "@/contracts/condition-expression";
/** Bounded transition history plus latest sampled decisions. Numeric changes do not flood the event ring. */
export class ConditionTrace {
  private runId?: string;
  private latest = new Map<string, ConditionDecision>();
  private signatures = new Map<string, string>();
  private events: (ConditionDecision & { sequence: number })[] = [];
  private sequence = 0;
  private comparisons = 0;
  private mismatches = 0;
  constructor(
    readonly mode: ConditionDiagnostics["mode"] = "expression",
    private capacity = 512,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error("Invalid trace capacity");
  }
  record(decision: ConditionDecision) {
    if (
      !Object.isFrozen(decision) ||
      !Object.isFrozen(decision.nodes) ||
      decision.nodes.some((n) => !Object.isFrozen(n))
    )
      decision = Object.freeze({
        ...decision,
        nodes: Object.freeze(
          decision.nodes.map((n) => Object.freeze({ ...n })),
        ),
      });
    if (this.runId && this.runId !== decision.runId)
      throw new Error("Condition trace run mismatch");
    this.runId = decision.runId;
    const key =
      decision.nodeId + "/" + decision.phase + "/" + decision.conditionKey;
    if (this.latest.size >= 1024 && !this.latest.has(key)) {
      const old = this.latest.keys().next().value!;
      this.latest.delete(old);
      this.signatures.delete(old);
    }
    this.latest.set(key, decision);
    if ("legacyValue" in decision) {
      this.comparisons++;
      if (decision.legacyValue !== decision.value) this.mismatches++;
    }
    const signature = JSON.stringify([
      decision.activationId,
      decision.value,
      decision.quality,
      decision.legacyValue,
      decision.nodes.map((n) => [
        n.path,
        typeof n.value === "boolean" ? n.value : null,
        n.quality,
      ]),
    ]);
    if (this.signatures.get(key) !== signature) {
      this.signatures.set(key, signature);
      this.events.push(
        Object.freeze({ ...decision, sequence: ++this.sequence }),
      );
      if (this.events.length > this.capacity) this.events.shift();
    }
  }
  snapshot(): ConditionDiagnostics {
    return Object.freeze({
      mode: this.mode,
      latest: Object.freeze(Object.fromEntries(this.latest)),
      lastSequence: this.sequence,
      dropped: Math.max(0, this.sequence - this.events.length),
      events: Object.freeze([...this.events]),
      comparisons: this.comparisons,
      mismatches: this.mismatches,
    });
  }
}
