import { z } from "zod";
import { spatialConnectionSchema } from "./spatial";

export function isSceneUrl(value: string) {
  try {
    return (
      /^\/scene\/S\d{2}\//.test(value) &&
      !/[?#\\]/.test(value) &&
      value.split("/").every((s) => {
        const decoded = decodeURIComponent(s);
        return decoded !== "." && decoded !== ".." && !/[\\/]/.test(decoded);
      })
    );
  } catch {
    return false;
  }
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sceneUrl = z.string().refine(isSceneUrl, "Invalid scene URL");
export const sortingStationSchema = z.object({
  id: z.string().min(1),
  frame: z.literal("scene_world_m"),
  position_m: z.tuple([
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
  ]),
  reference: z.literal("carrier_origin"),
  support_device: z.string().min(1),
  carrier_template: z.string().min(1),
  robots: z
    .array(z.string().min(1))
    .min(1)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Duplicate station robot",
    ),
  capacity: z.number().int().positive(),
  status: z.literal("candidate"),
});
export const sceneEntrySchema = z.object({
  id: z.string().regex(/^S\d{2}$/),
  name: z.string(),
  bundleUrl: sceneUrl,
  bundleSha256: hash,
  deviceCount: z.number().int().nonnegative(),
  nodeCount: z.number().int().nonnegative(),
  blockerCount: z.number().int().nonnegative(),
});
export const sceneIndexSchema = z
  .object({ version: z.literal(1), entries: z.array(sceneEntrySchema) })
  .refine(
    (v) => new Set(v.entries.map((e) => e.id)).size === v.entries.length,
    "Duplicate scene ID",
  );
export const sceneBundleSchema = z
  .object({
    schema_version: z.literal("scene-bundle/0.1"),
    id: z.string().regex(/^S\d{2}$/),
    name: z.string(),
    model_sha256: hash,
    model_url: sceneUrl,
    source_hashes: z.record(z.string(), hash),
    runtime_profile: z
      .enum([
        "warehouse.virtual-linear@1",
        "robot-handoff@1",
        "pallet-machining@1",
        "human-indexed-processing@1",
      ])
      .optional(),
    initial: z.record(z.string(), z.unknown()).optional(),
    drive_groups: z
      .record(
        z.string(),
        z.object({
          members: z.array(z.string()).min(1),
          mode: z.literal("coupled_motion"),
          status: z.string(),
        }),
      )
      .optional(),
    connections: z.array(spatialConnectionSchema).optional(),
    environment: z.array(z.record(z.string(), z.unknown())).optional(),
    coordinate_system: z
      .object({
        frame: z.literal("scene_world_m"),
        length_unit: z.literal("m"),
        up_axis: z.literal("Y"),
      })
      .optional(),
    sorting_station: sortingStationSchema.optional(),
    process: z
      .object({
        language: z.literal("ac-declarative/0.4"),
        scene_id: z.string(),
        body: z.record(z.string(), z.unknown()),
        task: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
    devices: z.array(
      z
        .object({
          instance_id: z.string(),
          contract: z.record(z.string(), z.unknown()),
          node_binding: z
            .object({
              status: z.enum(["unresolved", "bound", "prototype"]),
              model_sha256: hash,
              node_indices: z.array(z.number().int().nonnegative()),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
    calls: z.array(
      z.object({
        node: z.string(),
        device: z.string(),
        behavior: z.string(),
        experimental: z.boolean(),
      }),
    ),
    nodes: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        name: z.string(),
        children: z.array(z.number().int().nonnegative()),
        mesh: z.number().nullable(),
      }),
    ),
    blockers: z.array(
      z.object({
        code: z.string(),
        device: z.string().optional(),
        requirement: z.string().optional(),
      }),
    ),
    executable: z.literal(false),
  })
  .superRefine((v, c) => {
    const ids = new Set(v.devices.map((d) => d.instance_id));
    if (
      ids.size !== v.devices.length ||
      v.process.scene_id !== v.id ||
      !v.model_url.startsWith(`/scene/${v.id}/`)
    )
      c.addIssue({ code: "custom", message: "Scene identities differ" });
    for (const call of v.calls)
      if (!ids.has(call.device))
        c.addIssue({ code: "custom", message: "Unknown call device" });
    if (v.sorting_station) {
      const station = v.sorting_station;
      const support = v.devices.find(
        (d) => d.instance_id === station.support_device,
      );
      const carrier = v.devices.find(
        (d) => d.instance_id === station.carrier_template,
      );
      if (
        !v.coordinate_system ||
        !support ||
        !["conveyor", "lift_table", "rotary_table"].includes(
          String(support.contract.device_type),
        ) ||
        carrier?.asset_kind !== "carrier_prefab" ||
        station.robots.some(
          (id) =>
            v.devices.find((d) => d.instance_id === id)?.contract
              .device_type !== "robot_arm",
        )
      )
        c.addIssue({
          code: "custom",
          message: "Invalid sorting station device references",
        });
    }
  });
export const sceneInstanceSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  bundleHash: hash,
  bundle: sceneBundleSchema,
});
export type SceneEntry = z.infer<typeof sceneEntrySchema>;
export type SceneBundle = z.infer<typeof sceneBundleSchema>;
export type ScenePackageInstance = z.infer<typeof sceneInstanceSchema>;
