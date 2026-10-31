import { RequestLedger } from "./RequestLedger";
import type { RuntimeRequest } from "@/contracts/runtime";
export class ActionGateway {
  constructor(private subjectId: string) {}
  private ledger = new RequestLedger();
  get request(): RuntimeRequest | null {
    return this.ledger.request;
  }
  private acceptedTick = 0;
  submit(requestId: string, subjectId: string) {
    if (subjectId !== this.subjectId)
      throw new Error("请求主体不属于该物理世界");
    this.ledger.accept(requestId, subjectId);
    this.ledger.request!.status = "waiting";
    this.acceptedTick = 0;
  }
  observe(
    tick: number,
    support: boolean,
    exit: boolean,
    fallen: boolean,
    timeout: number,
  ) {
    const r = this.request;
    if (!r || !["waiting", "busy"].includes(r.status)) return;
    if (!this.acceptedTick) this.acceptedTick = tick;
    if (fallen) {
      r.status = "failed";
      r.reason = "物料离开支承并掉落";
    } else if (tick - this.acceptedTick > timeout * 60) {
      r.status = "failed";
      r.reason = "到达超时";
    } else if (support) {
      r.status = exit ? "succeeded" : "busy";
    }
  }
  cancel() {
    if (this.request && ["waiting", "busy"].includes(this.request.status))
      this.request.status = "cancelled";
  }
}
