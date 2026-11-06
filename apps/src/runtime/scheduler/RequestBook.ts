import type { ActionFeedback, ActionRequest } from "@/contracts/scheduler";
export interface RequestRecord {
  request: ActionRequest;
  accepted: boolean;
  outcome?: "succeeded" | "failed";
  stopped: boolean;
  cancelSent: boolean;
  reason?: string;
}
export class RequestBook {
  private records = new Map<string, RequestRecord>();
  constructor(readonly runId: string) {}
  submit(request: ActionRequest) {
    if (request.runId !== this.runId || this.records.has(request.requestId))
      throw new Error("Duplicate or foreign request");
    this.records.set(request.requestId, {
      request,
      accepted: false,
      stopped: false,
      cancelSent: false,
    });
  }
  ingest(feedback: readonly ActionFeedback[]) {
    for (const f of feedback) {
      if (f.runId !== this.runId) continue;
      const r = this.records.get(f.requestId);
      if (!r) continue;
      if (
        f.device !== r.request.device ||
        f.activationId !== r.request.activationId
      )
        throw new Error("Request identity mismatch");
      if (f.status === "accepted") {
        if (!r.outcome && !r.stopped) r.accepted = true;
      } else if (f.status === "stopped") r.stopped = true;
      else {
        if (f.status === "succeeded" && !r.accepted)
          throw new Error("Completion before acceptance");
        if (r.outcome && r.outcome !== f.status)
          throw new Error("Contradictory request result");
        r.outcome = f.status;
        r.reason = f.reason;
      }
    }
  }
  get(id: string) {
    return this.records.get(id);
  }
}
