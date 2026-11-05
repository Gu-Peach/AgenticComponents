# 六件入环输送与双机械臂出环流水
# 三个常驻有限分支并行：上料、中央输送、下料；由物料到位和容量约束衔接。
# 声明式控制图：通过专用前端检查，不作为Python脚本执行。
with process('S03', version="ac-declarative/0.1"):
    with seq('batch_084'):
        with par('pipeline_082', join="all"):
            with repeat('load_069', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('load_body_068'):
                    wait_for('input_present_063', fact('input_present', material=job.material, location=job.input), timeout=seconds(30))
                    invoke('in_transport_to_exit_064', IN, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
                    with seq('transfer_067'):
                        invoke('r1_transfer_material_065', R1, 'transfer_material', material=job.material, source=IN.exit, target=LOOP.entry)
                        invoke('r1_move_to_location_066', R1, 'move_to_location', target=R1.home)
            with repeat('middle_transport_073', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('middle_transport_body_072'):
                    wait_for('material_at_070', fact('material_at', material=job.material, location=LOOP.entry), timeout=seconds(30))
                    invoke('loop_transport_to_exit_071', LOOP, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
            with repeat('unload_081', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('unload_body_080'):
                    wait_for('material_at_074', fact('material_at', material=job.material, location=LOOP.exit), timeout=seconds(30))
                    with seq('transfer_077'):
                        invoke('r2_transfer_material_075', R2, 'transfer_material', material=job.material, source=LOOP.exit, target=OUT.entry)
                        invoke('r2_move_to_location_076', R2, 'move_to_location', target=R2.home)
                    invoke('out_transport_to_exit_078', OUT, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
                    wait_for('output_departed_079', fact('output_departed', material=job.material, device=OUT), timeout=seconds(30))
        wait_for('batch_goal_satisfied_083', fact('batch_goal_satisfied', specification="task-spec.json"), timeout=seconds(30))
