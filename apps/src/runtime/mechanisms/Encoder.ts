export class Encoder {
  distance = 0;
  step(speed: number, dt: number) {
    this.distance += speed * dt;
    return this.distance;
  }
}
