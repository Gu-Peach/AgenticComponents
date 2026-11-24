/** 控制单段或联动输送带的速度，根据指定物料与目标点的距离、支承和停稳状态确认到位，并处理配置好的出口交付。 */

export { PositionTransportAdapter } from "@/devices/conveyor/behavior";
export type { PositionTransportConfig, TransportTarget, TransportSubject, TransportDrive } from "@/devices/conveyor/behavior";
