export function ramp(
  current: number,
  target: number,
  dt: number,
  reference: number,
  accel: number,
  decel: number,
) {
  const time = target > current ? accel : decel;
  if (time === 0) return target;
  const delta = (reference / time) * dt;
  return (
    current +
    Math.sign(target - current) * Math.min(Math.abs(target - current), delta)
  );
}
