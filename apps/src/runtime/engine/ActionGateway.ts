import type { RuntimeRequest } from "@/contracts/runtime";
export class ActionGateway {
  constructor(private subjectId: string) {}
  request: RuntimeRequest | null = null;
  private seen = new Set<string>();
  private acceptedTick = 0;
  submit(requestId: string, subjectId: string) {
    if (subjectId !== this.subjectId)
      throw new Error("请求主体不属于该物理世界");
    if (this.seen.has(requestId)) throw new Error("重复请求");
    if (this.request && ["waiting", "busy"].includes(this.request.status))
      throw new Error("已有运输观察任务");
    this.seen.add(requestId);
    this.request = { requestId, subjectId, status: "waiting" };
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
