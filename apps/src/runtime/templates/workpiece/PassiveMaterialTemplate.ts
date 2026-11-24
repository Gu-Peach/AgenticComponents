/** 声明工件的被动刚体模板标识和版本，约定工件由物理引擎驱动，自身无需调度动作。 */

export const passiveMaterialDescriptor = {
  id: "workpiece.rigid-body",
  version: "1",
  movementOwner: "physics",
  autonomousCommands: false,
} as const;
