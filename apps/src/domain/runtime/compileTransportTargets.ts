import { z } from "zod";
import type { TransportTarget } from "@/runtime/adapters/scene/PositionTransportAdapter";
const vector = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
/** Coordinates stay in the authored scene; adapter IDs and target indices are derived. */
export function compileTransportTargets(
  manifest: unknown,
  leader: string,
  locations: unknown,
): TransportTarget[] {
  const scene = z
    .object({
      coordinate_system: z.object({
        frame: z.literal("scene_world_m"),
        length_unit: z.literal("m"),
        up_axis: z.literal("Y"),
      }),
      sorting_station: z
        .object({
          id: z.string(),
          frame: z.literal("scene_world_m"),
          position_m: vector,
          reference: z.literal("carrier_origin"),
          support_device: z.string(),
        })
        .optional(),
    })
    .parse(manifest);
  const points = z
    .record(
      z.string(),
      z.object({ frame: z.literal("scene_world_m"), position: vector }),
    )
    .parse(locations);
  const targets: Omit<TransportTarget, "index">[] = Object.entries(points).map(
    ([id, p]) => ({
      id,
      position: p.position,
      supportIds: [`${leader}/surface`],
    }),
  );
  if (scene.sorting_station?.support_device === leader)
    targets.push({
      id: `scene.${scene.sorting_station.id}`,
      position: scene.sorting_station.position_m,
      supportIds: [`${leader}/surface`],
    });
  if (new Set(targets.map((t) => t.id)).size !== targets.length)
    throw new Error("Duplicate scene target");
  return targets
    .sort((a, b) => a.id.localeCompare(b.id, "en"))
    .map((t, i) => ({ ...t, index: i + 1 }));
}
