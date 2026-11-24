import type { SignalConnection } from "./semantic-ports";
import type { ProcessNode } from "./process-ir";
import type { Vec3, Quat } from "./physics";

export interface HandoffConfig {
  /** Each invoked instance/behavior selects exactly one declared request profile. */
  actionModes: ReadonlyMap<string, string>;
  /** Resolved producer/consumer instance, material, and endpoint for each finite job. */
  connections: ReadonlyMap<string, readonly SignalConnection[]>;
  jobs: { id: string; material: string; input: string; target: string }[];
  source: string;
  infeed: string;
  outfeed: string;
  giver: string;
  receiver: string;
  rendezvous: string;
  outfeedAxis: Vec3;
  maxTiltRad: number;
  materialFrames: Map<
    string,
    {
      rest: Quat;
      points: Record<string, { offset: Vec3; outward: Vec3 }>;
    }
  >;
  approachAxes: Map<string, Vec3>;
}

/** A compatible payload selects the grasp start/receiver without inferring ownership at runtime. */
export function handoffBehavior(
  device: string,
  behavior: string,
  binding: unknown,
) {
  if (behavior !== "pick_and_place") return behavior;
  for (const phase of ["pick_and_handoff", "place_held_material"])
    if (binding === device + "." + phase) return phase;
  throw new Error("交接中的 pick_and_place 需要显式绑定抓取交接或持件放置载荷");
}

export function handoffCallBehavior(
  node: Extract<ProcessNode, { kind: "invoke" }>,
) {
  if (node.device.kind !== "ref")
    throw new Error("Handoff requires a named device");
  const binding =
    node.payload?.kind === "payload" ? node.payload.args[0] : undefined;
  return handoffBehavior(
    node.device.name,
    node.behavior,
    binding?.kind === "literal" ? binding.value : undefined,
  );
}
