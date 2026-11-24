/** 为单设备运行程序记录当前动作请求及其结果，防止重复请求号和同时执行多个请求。 */

import type { RuntimeRequest } from "@/contracts/runtime";
export class RequestLedger {
  request: RuntimeRequest | null = null;
  private seen = new Set<string>();
  assertAvailable(id: string) {
    if (this.seen.has(id)) throw new Error("重复请求");
    if (this.request && ["waiting", "busy"].includes(this.request.status))
      throw new Error("已有执行任务");
  }
  accept(id: string, subject: string) {
    if (this.seen.has(id)) throw new Error("重复请求");
    if (this.request && ["waiting", "busy"].includes(this.request.status))
      throw new Error("已有执行任务");
    this.seen.add(id);
    this.request = { requestId: id, subjectId: subject, status: "busy" };
  }
  finish(reason?: string) {
    if (this.request) {
      this.request.status = reason ? "failed" : "succeeded";
      this.request.reason = reason;
    }
  }
  cancel() {
    if (this.request?.status === "busy") this.request.status = "cancelled";
  }
}
