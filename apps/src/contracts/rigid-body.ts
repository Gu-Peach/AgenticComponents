import { z } from "zod";
const vec = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
export const rigidBodySchema = z
  .object({
    body_id: z.string().min(1),
    motion_type: z.enum(["static", "dynamic", "kinematic"]),
    role: z.enum(["conveying_support", "material", "ground"]),
    coordinate_space: z.literal("device_local"),
    local_pose: z
      .object({
        position: vec,
        rotation_quaternion: z
          .tuple([z.number(), z.number(), z.number(), z.number()])
          .refine((q) => Math.abs(Math.hypot(...q) - 1) < 1e-5),
        surface_height_param: z.string().optional(),
        thickness_param: z.string().optional(),
      })
      .strict(),
    collider: z
      .object({
        kind: z.literal("box"),
        length_param: z.string(),
        height_param: z.string(),
        width_param: z.string(),
        approximation: z.boolean().optional(),
      })
      .strict(),
    mass_param: z.string().optional(),
    contact_material_ref: z.string(),
    inertia: z.literal("uniform_box").optional(),
  })
  .strict();
export const rigidPhysicsSchema = z
  .object({
    bodies: z.array(rigidBodySchema).min(1),
    contact_materials: z.record(
      z.string(),
      z
        .object({ friction_param: z.string(), restitution_param: z.string() })
        .strict(),
    ),
  })
  .strict()
  .superRefine((p, c) => {
    if (new Set(p.bodies.map((b) => b.body_id)).size !== p.bodies.length)
      c.addIssue({ code: "custom", message: "刚体 ID 重复" });
    for (const b of p.bodies) {
      if (!p.contact_materials[b.contact_material_ref])
        c.addIssue({ code: "custom", message: "接触材料引用不存在" });
      if (
        b.motion_type === "dynamic" &&
        (!b.mass_param || b.inertia !== "uniform_box")
      )
        c.addIssue({ code: "custom", message: "动态刚体缺少质量/惯性策略" });
    }
  });
