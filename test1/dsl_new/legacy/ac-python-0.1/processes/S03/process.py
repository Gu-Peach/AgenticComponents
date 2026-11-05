# 六件入环输送与双机械臂出环流水
# 最多2件在途，入口、环线和出口分别互锁；环线单次沿允许方向到交接点。
# 受限工艺DSL：用 tools/check_flows.py 检查，不直接执行此文件。

async def handle_job_1(job):
    await wait.input_present(job.material, job.input, timeout=ticks(1800))
    async with resources(IN):
        await IN.transport_to_exit(material=job.material, speed_mps=quantity(0.2, 'm/s'))
    await wait.target_available(LOOP.entry, timeout=ticks(1800))
    async with resources(R1, IN, LOOP):
        await R1.transfer_material(material=job.material, source=IN.exit, target=LOOP.entry)
        await R1.move_to_location(target=R1.home)
    async with resources(LOOP):
        await LOOP.transport_to_exit(material=job.material, speed_mps=quantity(0.2, 'm/s'))
    await wait.target_available(OUT.entry, timeout=ticks(1800))
    async with resources(R2, LOOP, OUT):
        await R2.transfer_material(material=job.material, source=LOOP.exit, target=OUT.entry)
        await R2.move_to_location(target=R2.home)
    async with resources(OUT):
        await OUT.transport_to_exit(material=job.material, speed_mps=quantity(0.2, 'm/s'))
    await wait.output_departed(job.material, OUT, timeout=ticks(1800))


@process(version="ac-python/0.1", scene="S03")
async def main():
    await parallel_for(batch.jobs, handle_job_1, max_active=2)
    await verify('batch_goal')
