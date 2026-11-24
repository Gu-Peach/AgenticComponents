/** 逐步执行已绑定的工艺节点，检查动作条件、申请所需资源，并依据设备反馈决定后续节点和取消请求。 */

import type { ProcessNode, Expression } from "@/contracts/process-ir";
import type {
  BoundProcess,
  ActionBinding,
  ActionRequest,
  ActionEffect,
  SchedulerInput,
  SchedulerSnapshot,
} from "@/contracts/scheduler";
import type { ConditionContext } from "@/runtime/signals/ConditionProviders";
import { evaluate, UNKNOWN, durationTicks, immutable } from "./expressions";
import { ResourceArbiter } from "./ResourceArbiter";
import { RequestBook } from "./RequestBook";
import type { ConditionPhase } from "@/contracts/condition-expression";

interface Activation {
  id: string;
  node: ProcessNode;
  scope: Readonly<Record<string, unknown>>;
  state: string;
  since: number;
  index: number;
  children: Activation[];
  parentId?: string;
  // Map lexical repeat nodes to their active iteration body, including nested repeats.
  iterationBodies?: ReadonlyMap<string, string>;
  blockedBy: string[];
  values?: unknown[];
  request?: ActionRequest;
  submitted?: number;
  binding?: ActionBinding;
  stoppingSince?: number;
  normalExit?: boolean;
  gateSince?: number;
}
export class ProcessScheduler {
  private readonly resources = new ResourceArbiter();
  private readonly requests: RequestBook;
  private root: Activation;
  private activations: Activation[] = [];
  private readonly byId = new Map<string, Activation>();
  private nextId = 0;
  private requestId = 0;
  private tick = -1;
  private status: SchedulerSnapshot["status"] = "running";
  private error?: string;
  private stopSince = 0;
  private finalSince?: number;
  private cancelRequested = false;
  private input!: SchedulerInput;
  private effects: ActionEffect[] = [];
  constructor(
    readonly runId: string,
    private process: BoundProcess,
  ) {
    if (!runId) throw new Error("Missing run identity");
    this.requests = new RequestBook(runId);
    this.root = this.activate(process.root, process.scope, 0);
  }
  private activate(
    node: ProcessNode,
    scope: Readonly<Record<string, unknown>>,
    tick: number,
  ): Activation {
    if (this.activations.length >= 100000)
      throw new Error("Activation budget exceeded");
    const a: Activation = {
      id: `${this.runId}/${node.id}/${++this.nextId}`,
      node,
      scope,
      state: "pending",
      since: tick,
      index: 0,
      children: [],
      blockedBy: [],
    };
    this.activations.push(a);
    this.byId.set(a.id, a);
    return a;
  }
  private context(a: Activation): ConditionContext {
    const record = a.request
      ? this.requests.get(a.request.requestId)
      : undefined;
    return {
      nodeId: a.node.id,
      successfulPredecessor: (node) => this.successfulPredecessor(a.id, node),
      activationId: a.id,
      requestState: record
        ? {
            accepted: record.accepted,
            outcome: record.outcome,
            stopped: record.stopped,
          }
        : undefined,
      frame: this.input.frame,
      observations: this.input.observations,
      tick: this.tick,
      scope: a.scope,
      request: a.request,
      owns: (key) => this.resources.owns(a.id, key),
    };
  }
  private value(e: Expression, a: Activation) {
    return evaluate(e, this.context(a), this.process.readers);
  }
  private checks(
    ids: readonly string[],
    a: Activation,
    phase: ConditionPhase = "gate",
  ) {
    const values = ids.map((id) => {
      const value = this.process.providers.evaluate(id, {
        ...this.context(a),
        phase,
      });
      if (value !== true)
        a.blockedBy.push(`${id}: ${value === undefined ? "unknown" : "false"}`);
      return value;
    });
    return values.includes(false)
      ? false
      : values.includes(undefined)
        ? undefined
        : true;
  }
  private timed(a: Activation, limit: number, from = a.since) {
    if (this.tick - from >= limit)
      throw new Error(`Deadline exceeded: ${a.node.id} (${a.state})`);
  }
  private succeed(a: Activation) {
    a.state = "succeeded";
    this.resources.release(a.id);
  }
  private child(a: Activation, node: ProcessNode, scope = a.scope) {
    const c = this.activate(node, scope, this.tick);
    c.parentId = a.id;
    c.iterationBodies =
      a.node.kind === "repeat"
        ? new Map(a.iterationBodies).set(a.node.id, c.id)
        : a.iterationBodies;
    a.children.push(c);
    return c;
  }
  private cancelAction(a: Activation, normal = false) {
    if (!a.request || a.submitted === undefined) return;
    const r = this.requests.get(a.request.requestId)!;
    if (!r.cancelSent) {
      r.cancelSent = true;
      this.effects.push({ kind: "cancel", request: a.request });
    }
    a.state = "stopping";
    a.stoppingSince ??= this.tick;
    a.normalExit = normal;
  }
  private stopped(a: Activation) {
    if (!a.request) return false;
    const physical = this.checks(a.binding!.stopped, a, "stopped");
    return (
      this.requests.get(a.request.requestId)?.stopped === true &&
      physical === true
    );
  }
  private action(a: Activation) {
    const n = a.node;
    if (n.kind !== "invoke" && n.kind !== "with-control")
      throw new Error("Invalid action activation");
    if (!a.binding) {
      const device = (n.device as { name: string }).name;
      a.binding = this.process.actions.get(
        `${device}.${n.kind === "invoke" ? n.behavior : n.control}`,
      )!;
    }
    const b = a.binding;
    if (!a.request) {
      const rawArgs =
        n.kind === "invoke"
          ? Object.fromEntries(
              Object.entries(n.arguments).map(([k, v]) => [
                k,
                this.value(v, a),
              ]),
            )
          : this.value(n.setpoints, a);
      const payload =
        n.kind === "invoke" && n.payload ? this.value(n.payload, a) : undefined;
      if (rawArgs === UNKNOWN || payload === UNKNOWN) {
        a.state = "waiting_preconditions";
        this.timed(a, this.process.deadlines.preconditions);
        return;
      }
      if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs))
        throw new Error("Arguments require a record");
      const args = rawArgs as Record<string, unknown>;
      if (Object.values(args).includes(UNKNOWN)) {
        a.state = "waiting_preconditions";
        this.timed(a, this.process.deadlines.preconditions);
        return;
      }
      b.validateArguments(args, payload);
      if (++this.requestId > 2147483647)
        throw new Error("Request ID space exhausted");
      const fields = (
        payload as { fields?: Record<string, unknown> } | undefined
      )?.fields;
      const subject = args.material ?? args.subject_id ?? fields?.material;
      a.request = immutable({
        runId: this.runId,
        activationId: a.id,
        requestId: String(this.requestId),
        device: b.device,
        behavior: b.behavior,
        subjectId: subject === undefined ? undefined : String(subject),
        arguments: structuredClone(args),
        payload: structuredClone(payload),
      });
      a.scope = immutable({
        ...a.scope,
        arguments: a.request.arguments,
        payload: a.request.payload,
      });
    }
    if (a.submitted === undefined) {
      if (this.checks(b.preconditions, a, "precondition") !== true) {
        this.resources.release(a.id);
        a.state = "waiting_preconditions";
        this.timed(a, this.process.deadlines.preconditions);
        return;
      }
      const keys = [
        `device/${b.device}`,
        ...b.resources(this.context(a), a.request.arguments),
      ];
      if (!this.resources.acquire(a.id, keys)) {
        a.state = "waiting_resources";
        a.blockedBy.push(...this.resources.blockers(a.id, keys));
        this.timed(a, this.process.deadlines.preconditions);
        return;
      }
      if (this.checks(b.authorization, a, "authorization") !== true) {
        this.resources.release(a.id);
        a.state = "waiting_authorization";
        this.timed(a, this.process.deadlines.preconditions);
        return;
      }
      this.requests.submit(a.request);
      a.submitted = this.tick;
      a.state = "waiting_acceptance";
      this.effects.push({ kind: "submit", request: a.request });
      return;
    }
    const r = this.requests.get(a.request.requestId)!;
    if (a.state === "stopping") {
      if (this.stopped(a)) this.succeed(a);
      else this.timed(a, this.process.deadlines.stop, a.stoppingSince);
      return;
    }
    if (r.outcome === "failed")
      throw new Error(r.reason ?? "Device action failed");
    if (!r.accepted) {
      a.blockedBy.push("matching acceptance");
      this.timed(a, this.process.deadlines.acceptance, a.submitted);
      return;
    }
    if (this.checks(b.sustaining, a, "sustaining") !== true)
      throw new Error("Sustaining evidence lost: " + n.id);
    a.state = "running";
    if (n.kind === "with-control") {
      if (!a.children.length) {
        if (this.checks(b.completion, a, "completion") === true)
          this.child(a, n.body);
        else this.timed(a, this.process.deadlines.acceptance, a.submitted);
        return;
      }
      const child = a.children[0];
      this.visit(child);
      if (child.state === "succeeded") this.cancelAction(a, true);
      return;
    }
    if (r.outcome === "succeeded") {
      a.state = "verifying_completion";
      if (
        this.checks(b.completion, a, "completion") === true &&
        this.checks(b.release, a, "release") === true
      ) {
        this.succeed(a);
        return;
      }
    }
    this.timed(a, this.process.deadlines.execution, a.submitted);
  }
  private visit(a: Activation) {
    if (a.state === "succeeded" || this.status === "stopping") return;
    a.blockedBy = [];
    const n = a.node;
    if (n.kind === "invoke" || n.kind === "with-control") {
      this.action(a);
      return;
    }
    if (n.kind === "fail") throw new Error(n.code);
    if (n.kind === "delay") {
      if (this.tick - a.since >= durationTicks(this.value(n.duration, a), true))
        this.succeed(a);
      return;
    }
    if (n.kind === "seq") {
      if (!a.children.length) {
        this.child(a, n.children[0]);
        return;
      }
      const child = a.children[a.children.length - 1];
      this.visit(child);
      if (child.state === "succeeded") {
        if (++a.index === n.children.length) this.succeed(a);
        else this.child(a, n.children[a.index]);
      }
      return;
    }
    if (n.kind === "par") {
      if (!a.children.length) {
        n.children.forEach((c) => this.child(a, c));
        return;
      }
      for (const c of a.children) this.visit(c);
      if (a.children.every((c) => c.state === "succeeded")) this.succeed(a);
      return;
    }
    if (n.kind === "branch") {
      if (a.children.length) {
        this.visit(a.children[0]);
        if (a.children[0].state === "succeeded") this.succeed(a);
        return;
      }
      const results = n.cases.map((c) => this.value(c.condition, a));
      if (results.some((v) => v !== true && v !== false && v !== UNKNOWN))
        throw new Error("Branch requires Boolean conditions");
      let choice = -1;
      if (n.mode === "exclusive") {
        if (results.filter((v) => v === true).length > 1)
          throw new Error("Exclusive branch conflict");
        if (results.includes(UNKNOWN)) {
          this.timed(a, durationTicks(this.value(n.timeout, a)));
          return;
        }
        choice = results.indexOf(true);
      } else {
        for (let i = 0; i < results.length; i++) {
          if (results[i] === UNKNOWN) {
            this.timed(a, durationTicks(this.value(n.timeout, a)));
            return;
          }
          if (results[i] === true) {
            choice = i;
            break;
          }
        }
      }
      this.child(a, choice < 0 ? n.otherwise : n.cases[choice].body);
      return;
    }
    if (n.kind === "repeat") {
      if (!a.values) {
        if ("count" in n) {
          const count = this.value(n.count, a);
          if (
            !Number.isSafeInteger(count) ||
            (count as number) < 0 ||
            (count as number) > 10000
          )
            throw new Error("Invalid repeat count");
          a.values = Array(count as number).fill(null);
        } else {
          if (Object.hasOwn(a.scope, n.bind))
            throw new Error("Loop binding shadows existing scope");
          const values = this.value(n.over, a),
            limit = this.value(n.limit, a);
          if (
            !Number.isSafeInteger(limit) ||
            (limit as number) < 0 ||
            (limit as number) > 10000
          )
            throw new Error("Invalid collection bound");
          if (values === UNKNOWN) {
            this.timed(a, this.process.deadlines.collection);
            return;
          }
          if (!Array.isArray(values) || values.length > (limit as number))
            throw new Error("Invalid collection snapshot");
          a.values = immutable(structuredClone(values));
        }
      }
      if (a.index >= a.values.length) {
        this.succeed(a);
        return;
      }
      const scope =
        "bind" in n
          ? immutable({ ...a.scope, [n.bind]: a.values[a.index] })
          : a.scope;
      const gate = this.process.iterationGates[n.id];
      if (a.children.length === a.index) {
        const context = { ...this.context(a), scope };
        if (gate && this.process.providers.all(gate.entry, context) !== true) {
          this.timed(
            a,
            this.process.deadlines.collection,
            a.gateSince ?? a.since,
          );
          return;
        }
        this.child(a, n.body, scope);
        a.gateSince = undefined;
        return;
      }
      const child = a.children[a.index];
      this.visit(child);
      if (child.state === "succeeded") {
        a.gateSince ??= this.tick;
        if (
          gate &&
          this.process.providers.all(gate.completion, {
            ...this.context(a),
            scope,
          }) !== true
        ) {
          this.timed(a, this.process.deadlines.collection, a.gateSince);
          return;
        }
        a.index++;
        a.gateSince = this.tick;
      }
    }
  }
  cancel() {
    if (this.status === "running" || this.status === "finalizing")
      this.cancelRequested = true;
  }
  private abort(reason?: string) {
    this.error = reason;
    this.status = "stopping";
    this.stopSince = this.tick;
  }
  advance(input: SchedulerInput): readonly ActionEffect[] {
    if (input.frame.runId !== this.runId)
      throw new Error("Foreign scheduler frame");
    if (
      input.observations &&
      (input.observations.runId !== this.runId ||
        input.observations.tick !== input.frame.tick)
    )
      throw new Error("Inconsistent observation snapshot");
    if (input.frame.tick === this.tick) return [];
    if (input.frame.tick !== this.tick + 1)
      throw new Error("Scheduler requires consecutive logical ticks");
    this.tick = input.frame.tick;
    this.input = input;
    this.effects = [];
    if (
      ["succeeded", "failed", "cancelled", "attention_required"].includes(
        this.status,
      )
    )
      return [];
    try {
      this.requests.ingest(input.feedback);
      if (this.cancelRequested && this.status !== "stopping") this.abort();
      if (this.status === "running") {
        this.visit(this.root);
        if (this.root.state === "succeeded") {
          this.status = "finalizing";
          this.finalSince = this.tick;
        }
      }
      if (this.status === "finalizing") {
        if (
          this.process.providers.all(this.process.finalization, {
            ...this.context(this.root),
            phase: "finalization",
          }) === true
        )
          this.status = "succeeded";
        else if (
          this.tick - this.finalSince! >=
          this.process.deadlines.finalization
        )
          throw new Error("Independent finalization timed out");
      }
    } catch (e) {
      if (this.status !== "stopping")
        this.abort(e instanceof Error ? e.message : String(e));
      else this.error ??= String(e);
    }
    if (this.status === "stopping") {
      let allStopped = true;
      for (const a of this.activations) {
        if (a.state === "succeeded") continue;
        if (a.submitted !== undefined) {
          this.cancelAction(a);
          try {
            if (this.stopped(a)) {
              a.state = this.error ? "failed" : "cancelled";
              this.resources.release(a.id);
            } else allStopped = false;
          } catch {
            allStopped = false;
          }
        } else {
          a.state = this.error ? "failed" : "cancelled";
          this.resources.release(a.id);
        }
      }
      if (allStopped) this.status = this.error ? "failed" : "cancelled";
      else if (this.tick - this.stopSince >= this.process.deadlines.stop)
        this.status = "attention_required";
    }
    return Object.freeze([...this.effects]);
  }
  nodeForActivation(id: string) {
    return this.byId.get(id)?.node.id;
  }
  successfulPredecessor(consumerId: string, producerNode: string) {
    const consumer = this.byId.get(consumerId);
    if (!consumer) return undefined;
    for (let i = this.activations.length - 1; i >= 0; i--) {
      const a = this.activations[i];
      if (a.node.id !== producerNode || a.state !== "succeeded" || !a.request)
        continue;
      if (
        consumer.request &&
        Number(a.request.requestId) >= Number(consumer.request.requestId)
      )
        continue;
      const sameIteration = [...(a.iterationBodies ?? [])].every(
        ([loop, body]) => {
          const shared = consumer.iterationBodies?.get(loop);
          if (shared) return shared === body;
          const repeatId = this.byId.get(body)?.parentId;
          const repeat = repeatId && this.byId.get(repeatId);
          return (
            !!repeat &&
            repeat.state === "succeeded" &&
            repeat.children.at(-1)?.id === body
          );
        },
      );
      if (sameIteration)
        return { requestId: a.request.requestId, activationId: a.id };
    }
    return undefined;
  }
  get currentStatus() {
    return this.status;
  }
  snapshot(): Readonly<SchedulerSnapshot> {
    return immutable({
      runId: this.runId,
      tick: this.tick,
      status: this.status,
      error: this.error,
      activations: this.activations.map((a) => ({
        id: a.id,
        node: a.node.id,
        state: a.state,
        requestId: a.request?.requestId,
        subjectId: a.request?.subjectId,
        parentId: a.parentId,
        iteration:
          a.node.kind === "repeat" && a.values
            ? Math.min(a.index + 1, a.values.length)
            : undefined,
        totalIterations: a.values?.length,
        selectedChild:
          a.node.kind === "branch" ? a.children[0]?.node.id : undefined,
        blockedBy: [...a.blockedBy],
      })),
      resources: this.resources.snapshot(),
    });
  }
}
