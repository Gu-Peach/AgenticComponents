import { Encoder } from "@/runtime/mechanisms/Encoder";
export class ConveyorState {
  speed = 0;
  encoder = new Encoder();
}
