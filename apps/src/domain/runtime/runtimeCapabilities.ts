export const runtimeCapabilities = {
  template: "conveyor.continuous-contact@1",
  material: "workpiece.rigid-body@1",
  horizontalOnly: true,
  unitScaleOnly: true,
  subjects: 1,
  plc: false,
  robot: {
    template: "robot.articulated@1",
    ik: "position_only",
    motion: "joint_ptp",
    grasp: "jolt_fixed_constraint",
    fullArmCollision: false,
  },
} as const;
