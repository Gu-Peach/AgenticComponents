import { z } from "zod";
import type { ActionBinding } from "@/contracts/scheduler";
import type {
  ObservationDefinition,
  ConditionContext,
} from "@/contracts/conditions";
import { ConditionProviders } from "@/runtime/signals/ConditionProviders";
import type { PositionTransportConfig } from "@/devices/conveyor/behavior";
import { bindDeviceBehavior } from "./bindDeviceBehavior";
const vector = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const loads = z.array(
  z.object({
    id: z.number().int(),
    subject: z.string(),
    position: vector,
    velocity: vector,
    supported: z.boolean(),
  }),
);
const outcome = z.object({
  subject: z.string(),
  position: vector,
  target: z.string(),
  distance: z.number().finite(),
  supported: z.boolean(),
  stationary: z.boolean(),
});
export function bindPositionTransport(
  config: PositionTransportConfig,
  contract: unknown,
  providers: ConditionProviders,
  motionPermission: string,
): { binding: ActionBinding; observations: ObservationDefinition[] } {
  const id = config.leader,
    base = id + "/transport_to_position.";
  providers.validate([motionPermission]);
  const args = (c: ConditionContext) =>
    c.scope.arguments as Record<string, unknown>;
  const observed = (c: ConditionContext, key: string, correlated = false) => {
    const s = c.observations?.samples[key];
    if (
      !s ||
      s.quality !== "good" ||
      s.runId !== c.frame.runId ||
      (correlated &&
        (!c.request ||
          s.requestId !== c.request.requestId ||
          s.activationId !== c.request.activationId))
    )
      return undefined;
    return s.value;
  };
  providers.register(base + "ready", {
    evaluate(c) {
      const rows = loads.safeParse(observed(c, id + "/loads"));
      if (!rows.success) return undefined;
      const load = rows.data.find((l) => l.id === args(c).subject_id);
      if (!load) return undefined;
      return (
        load.supported && Math.hypot(...load.velocity) <= config.speedTolerance
      );
    },
  });
  providers.register(base + "motion_authorized", {
    dependencies: [motionPermission],
    evaluate(c, d) {
      return d[motionPermission] === undefined
        ? undefined
        : d[motionPermission] &&
            config.drives.every((d) => c.owns("device/" + d.device));
    },
  });
  providers.register(base + "sustaining", {
    dependencies: [motionPermission],
    evaluate: (_c, d) => d[motionPermission],
  });
  providers.register(base + "completion", {
    evaluate(c) {
      const result = outcome.safeParse(observed(c, id + "/transport", true));
      if (!result.success) return undefined;
      const subject = config.subjects.get(Number(args(c).subject_id));
      return (
        result.data.subject === subject?.id &&
        result.data.target === args(c).target &&
        result.data.distance <= config.positionTolerance &&
        result.data.supported &&
        result.data.stationary
      );
    },
  });
  providers.register(base + "stopped", {
    evaluate(c) {
      const result = outcome.safeParse(observed(c, id + "/transport", true));
      return result.success ? result.data.stationary : undefined;
    },
  });
  const version = z.object({ version: z.string() }).parse(contract).version;
  return {
    binding: bindDeviceBehavior(id, contract, "transport_to_position", {
      contractVersion: version,
      stopped: [base + "stopped"],
      resources: (c) => [
        ...config.drives.map((d) => "device/" + d.device),
        "subject/" + args(c).subject_id,
        "target/" + args(c).target,
      ],
      validatePayload: (p) => {
        if (p !== undefined)
          throw new Error(
            "Position transport uses scalar subject/target arguments",
          );
      },
    }),
    observations: [
      {
        key: id + "/loads",
        provider: "adapter:" + id,
        maxAgeTicks: 1,
        validate: (v) => loads.safeParse(v).success,
      },
      {
        key: id + "/transport",
        provider: "adapter:" + id,
        maxAgeTicks: 1,
        validate: (v) => outcome.safeParse(v).success,
      },
    ],
  };
}
