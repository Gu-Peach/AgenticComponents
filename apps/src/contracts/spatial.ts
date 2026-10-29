import { z } from "zod";
const vec = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const axis = vec.refine(
  (v) => Math.abs(Math.hypot(...v) - 1) < 1e-5,
  "方向必须为单位向量",
);
const frame = z
  .object({ position: vec, forward: axis, up: axis })
  .strict()
  .refine(
    (f) => Math.abs(f.forward.reduce((s, n, i) => s + n * f.up[i], 0)) < 1e-5,
    "forward/up 必须正交",
  );
const rule = z
  .object({
    origin_ref: z.string().min(1),
    offset_axis: axis,
    offset_param: z.string().min(1),
    offset_factor: z.number().finite(),
    height_param: z.string().min(1),
    forward: axis,
    up: axis,
  })
  .strict()
  .refine(
    (f) => Math.abs(f.forward.reduce((s, n, i) => s + n * f.up[i], 0)) < 1e-5,
    "forward/up 必须正交",
  );
export const spatialInterfaceSchema = z
  .object({
    interface_id: z.string().min(1),
    name: z.string().min(1),
    local_frame_pending: z.literal(true).optional(),
    local_frame: frame.optional(),
    local_frame_rule: rule.optional(),
    capabilities: z
      .object({
        snap: z
          .object({
            role: z.string().min(1),
            accepts: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (i) =>
      [i.local_frame, i.local_frame_rule, i.local_frame_pending].filter(Boolean)
        .length === 1,
    "接口必须且只能声明固定坐标、派生规则或待标定状态",
  );
export type SpatialInterface = z.infer<typeof spatialInterfaceSchema>;
