/** 列出预留的单设备模板 ID，涵盖直线升降、转台分度、供料、仓储和带槽位的载具。 */

export const reservedTemplates = [
  "lift.linear-axis",
  "rotary.indexed",
  "source.buffered",
  "storage.passive-rack",
  "carrier.slotted",
] as const;
