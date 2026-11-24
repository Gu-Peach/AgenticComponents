/** 在行程、速度和加速度限制内逐步推进单轴位置，支持从当前速度制动并判断是否停稳。 */

/** Signed scalar axis, bounded acceleration, braking from the current velocity. */
export class LinearAxisTrajectory {
  velocity = 0;
  target: number;
  stopping = false;
  constructor(
    public position: number,
    readonly speed: number,
    readonly acceleration: number,
    readonly limits: readonly [number, number],
  ) {
    if (
      ![position, speed, acceleration, ...limits].every(Number.isFinite) ||
      speed <= 0 ||
      acceleration <= 0 ||
      limits[0] > position ||
      limits[1] < position ||
      limits[0] >= limits[1]
    )
      throw new Error("Invalid linear axis configuration");
    this.target = position;
  }
  command(target: number) {
    if (
      !Number.isFinite(target) ||
      target < this.limits[0] ||
      target > this.limits[1]
    )
      throw new Error("Axis target outside limits");
    if (Math.abs(this.velocity) > 1e-6)
      throw new Error("Axis must settle before a new target");
    this.target = target;
    this.stopping = false;
  }
  stop() {
    this.stopping = true;
  }
  step(dt: number) {
    if (!Number.isFinite(dt) || dt <= 0 || dt > 0.1)
      throw new Error("Invalid axis step");
    const error = this.target - this.position;
    const demand = this.stopping
      ? 0
      : Math.sign(error) *
        Math.min(
          this.speed,
          Math.abs(error) * 3,
          Math.sqrt(2 * this.acceleration * Math.abs(error)),
        );
    const previous = this.velocity;
    this.velocity +=
      Math.sign(demand - this.velocity) *
      Math.min(Math.abs(demand - this.velocity), this.acceleration * dt);
    this.position += (previous + this.velocity) * 0.5 * dt;
    if (
      this.position < this.limits[0] - 1e-6 ||
      this.position > this.limits[1] + 1e-6
    )
      throw new Error("Axis exceeded travel limits");
    return this.position;
  }
  get settled() {
    return (
      Math.abs(this.velocity) < 0.001 &&
      (this.stopping || Math.abs(this.target - this.position) < 0.001)
    );
  }
}
