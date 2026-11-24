/** 设备侧离散请求的跨扫描锁存。记录已接受身份、启动撤销和终态结果，供独立场景驱动共享。 */
import type { ActionRequest, ActionFeedback } from "@/contracts/scheduler";
import type { SceneSignalFrame, SignalWrite } from "@/contracts/scene-signals";

export class DeviceRequestLatch {
  private readonly usedIds = new Set<number>();
  private active?: ActionRequest;
  private pending = false;
  private accepted = false;
  private result?: { request: ActionRequest; succeeded: boolean };

  get awaitingAcceptance() {
    return this.pending;
  }

  constructor(
    private scene: string,
    private run: string,
    private device: string,
    private trigger: string,
  ) {}

  check(request: ActionRequest, frame: Readonly<SceneSignalFrame>) {
    const id = Number(request.requestId);
    if (
      frame.runId !== this.run ||
      request.runId !== this.run ||
      request.device !== this.device ||
      !Number.isInteger(id) ||
      id <= 0 ||
      id > 2147483647 ||
      this.usedIds.has(id) ||
      this.accepted
    )
      throw new Error("Device request identity or command handshake invalid");
  }
  submit(frozen: ActionRequest) {
    this.usedIds.add(Number(frozen.requestId));
    this.active = frozen;
    this.pending = true;
  }
  accept(): ActionFeedback | undefined {
    if (!this.pending || !this.active) return;
    this.pending = false;
    this.accepted = true;
    this.result = undefined;
    return { ...this.active, status: "accepted" };
  }
  sample(frame: Readonly<SceneSignalFrame>) {
    if (frame.runId !== this.run)
      throw new Error("Foreign device signal frame");
    const command =
      frame.samples[this.scene + "/" + this.device + "/" + this.trigger];
    if (command?.quality === "good" && command.value === false)
      this.accepted = false;
  }
  matches(
    request: Pick<
      ActionFeedback,
      "device" | "runId" | "activationId" | "requestId"
    >,
  ) {
    return (
      !!this.active &&
      request.runId === this.run &&
      request.device === this.device &&
      request.activationId === this.active.activationId &&
      request.requestId === this.active.requestId
    );
  }
  acknowledge(
    feedback: ActionFeedback,
    frame: Readonly<SceneSignalFrame>,
  ): SignalWrite[] {
    if (frame.runId !== this.run)
      throw new Error("Foreign device signal frame");
    if (
      !this.accepted ||
      feedback.status !== "accepted" ||
      !this.matches(feedback)
    )
      return [];
    return [
      {
        key: this.scene + "/" + this.device + "/" + this.trigger,
        writer: "process",
        runId: this.run,
        value: false,
        activationId: feedback.activationId,
        requestId: feedback.requestId,
        subjectId: this.active!.subjectId,
      },
    ];
  }
  finish(succeeded: boolean) {
    if (this.active && !this.pending)
      this.result = { request: this.active, succeeded };
  }
  publish(): SignalWrite[] {
    const write = (
      port: string,
      value: boolean | number,
      identity?: ActionRequest,
    ): SignalWrite => ({
      key: this.scene + "/" + this.device + "/" + port,
      writer: "adapter:" + this.device,
      runId: this.run,
      value,
      activationId: identity?.activationId,
      requestId: identity?.requestId,
      subjectId: identity?.subjectId,
    });
    return [
      write("accepted", this.accepted, this.active),
      write("done", this.result?.succeeded ?? false, this.result?.request),
      write(
        "result_id",
        Number(this.result?.request.requestId ?? 0),
        this.result?.request,
      ),
    ];
  }
}
