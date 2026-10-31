import { z } from "zod";
const vector = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const target = { position: vector, frame: z.enum(["world", "robot_base"]) };
export const robotStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("move_joints"),
    q: z.array(z.number().finite()).length(6),
  }),
  z.object({
    kind: z.literal("move_to_pose"),
    ...target,
    subject: z.enum(["tcp", "held_material"]).optional(),
    support_clearance: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("grip"), materialId: z.string().min(1) }),
  z.object({ kind: z.literal("release"), materialId: z.string().min(1) }),
  z.object({
    kind: z.literal("wait_time"),
    seconds: z.number().finite().min(0).max(60),
  }),
  z.object({
    kind: z.literal("wait_signal"),
    portId: z.enum(["in1Tag", "in2Tag", "in3Tag", "in4Tag"]),
    value: z.boolean(),
    timeout: z.number().positive().max(60),
  }),
  z.object({
    kind: z.literal("set_output"),
    portId: z.enum(["out1Tag", "out2Tag", "out3Tag", "out4Tag"]),
    value: z.boolean(),
  }),
]);
export type RobotStep = z.infer<typeof robotStepSchema>;
export const robotCommandSchema = z
  .object({
    requestId: z.number().int().min(1).max(2147483647),
    instanceId: z.string().min(1),
    behaviorId: z.enum([
      "move_joints",
      "move_to_pose",
      "execute_job",
      "pick_and_place",
      "grip",
      "release",
    ]),
    steps: z.array(robotStepSchema).min(1).max(64),
  })
  .superRefine((c, ctx) => {
    const action = c.behaviorId;
    if (
      ["move_joints", "move_to_pose", "grip", "release"].includes(action) &&
      (c.steps.length !== 1 || c.steps[0].kind !== action)
    )
      ctx.addIssue({ code: "custom", message: "行为与单动作载荷不一致" });
    if (action === "pick_and_place") {
      const grips = c.steps.flatMap((s, i) => (s.kind === "grip" ? [i] : [])),
        releases = c.steps.flatMap((s, i) => (s.kind === "release" ? [i] : []));
      const g = c.steps[grips[0]],
        r = c.steps[releases[0]];
      if (
        grips.length !== 1 ||
        releases.length !== 1 ||
        grips[0] === 0 ||
        releases[0] <= grips[0] ||
        releases[0] === c.steps.length - 1 ||
        g?.kind !== "grip" ||
        r?.kind !== "release" ||
        g.materialId !== r.materialId
      )
        ctx.addIssue({
          code: "custom",
          message: "抓放任务必须包含有序的接近、同物料抓取、释放和退回",
        });
    }
    if (
      c.steps.some(
        (s) =>
          s.kind === "move_to_pose" &&
          s.support_clearance &&
          s.subject !== "held_material",
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "释放高度策略仅用于已持有物料中心目标",
      });
  });
export type RobotCommand = z.infer<typeof robotCommandSchema>;
