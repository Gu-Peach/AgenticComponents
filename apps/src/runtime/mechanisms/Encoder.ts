/** 按每个仿真步的速度与时长累计带面位移，提供输送带编码器的读数。 */

export class Encoder {
  distance = 0;
  step(speed: number, dt: number) {
    this.distance += speed * dt;
    return this.distance;
  }
}
