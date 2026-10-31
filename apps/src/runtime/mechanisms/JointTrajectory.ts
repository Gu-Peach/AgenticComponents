// Quintic time scaling gives synchronized joints with zero endpoint velocity/acceleration.
export class JointTrajectory {
  private elapsed = 0;
  private duration: number;
  constructor(
    private from: number[],
    private to: number[],
    speed: number[],
    accel: number[],
  ) {
    if (
      from.length !== to.length ||
      from.some((n) => !Number.isFinite(n)) ||
      to.some((n) => !Number.isFinite(n)) ||
      speed.some((n) => !Number.isFinite(n) || n <= 0) ||
      accel.some((n) => !Number.isFinite(n) || n <= 0)
    )
      throw new Error("关节轨迹参数无效");
    this.duration = Math.max(
      1 / 60,
      ...from.map((v, i) =>
        Math.max(
          (1.875 * Math.abs(to[i] - v)) / speed[i],
          Math.sqrt((5.774 * Math.abs(to[i] - v)) / accel[i]),
        ),
      ),
    );
  }
  get done() {
    return this.elapsed >= this.duration;
  }
  step(dt: number) {
    this.elapsed = Math.min(this.duration, this.elapsed + dt);
    const u = this.elapsed / this.duration,
      s = 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5,
      ds = (30 * u * u - 60 * u ** 3 + 30 * u ** 4) / this.duration;
    return {
      q: this.from.map((v, i) => v + (this.to[i] - v) * s),
      qdot: this.from.map((v, i) => (this.to[i] - v) * ds),
    };
  }
}
