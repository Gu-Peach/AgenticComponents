import { z } from "zod";
const axis = z
  .tuple([z.number().finite(), z.number().finite(), z.number().finite()])
  .refine((v) => Math.abs(Math.hypot(...v) - 1) < 1e-5, "方向必须为单位向量");
export const signalManagementSchema = z
  .object({
    owner: z.literal("simulation_engine"),
    status: z.literal("pending_engine"),
    namespace: z.literal("instance_id/port_id"),
    definition_source: z.literal("signal_ports"),
    spatial_binding: z.literal(false),
    write_policy: z.literal("single_writer_per_input"),
    plc_mapping: z.literal("instance_bindings"),
    sampling: z.literal("simulation_step_snapshot"),
    unknown_policy: z.literal("invalid_until_provider_ready"),
  })
  .strict();
export const conveyorModelSchema = z
  .object({
    conveying_surface: z
      .object({
        surface_id: z.string().min(1),
        node_binding_role: z.string().min(1),
        coordinate_space: z.literal("device_local"),
        flow_axis: axis,
        normal: axis,
        geometry: z
          .object({
            length_param: z.string(),
            width_param: z.string(),
            height_param: z.string(),
            calibration_status: z.literal("pending"),
            collision_shape: z.literal("box"),
          })
          .strict(),
        contact: z
          .object({
            model: z.literal("moving_surface_contact"),
            friction_status: z.literal("pending"),
            material_body_requirement: z.literal("dynamic_rigid_body"),
            contact_requirement: z.literal("valid_support_contact"),
            collision_response: z.literal("physics_solver"),
          })
          .strict(),
        drive: z
          .object({
            run_signal: z.string(),
            speed_signal: z.string(),
            actual_speed_signal: z.string(),
            speed_param: z.string(),
            accel_time_param: z.string(),
            decel_time_param: z.string(),
          })
          .strict(),
        material_motion: z.literal("physics_contact_only"),
        implementation_status: z.literal("pending_engine"),
      })
      .strict()
      .refine(
        (s) =>
          Math.abs(s.flow_axis.reduce((v, n, i) => v + n * s.normal[i], 0)) <
          1e-5,
        "输送方向与表面法向必须正交",
      ),
    observation_regions: z
      .array(
        z
          .object({
            region_id: z.string().min(1),
            surface_ref: z.string().min(1),
            purpose: z.enum([
              "entry_availability",
              "exit_arrival",
              "surface_occupancy",
            ]),
            geometry_status: z.literal("pending"),
            observation_keys: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .passthrough();

/** The draft contact model cannot run until a later calibrated contract is supported. */
export function hasPendingContactModel(
  typeSpecificContract: Record<string, unknown>,
): boolean {
  const surface = typeSpecificContract.conveying_surface;
  return Boolean(
    surface &&
    typeof surface === "object" &&
    "implementation_status" in surface &&
    surface.implementation_status === "pending_engine",
  );
}
