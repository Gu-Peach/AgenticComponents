# 四件双机械臂双输送带流水交接
# 三个常驻有限分支并行：上料、中央输送、下料；由物料到位和容量约束衔接。
# 声明式控制图：通过专用前端检查，不作为Python脚本执行。
with process('S04', version="ac-declarative/0.1"):
    with seq('batch_105'):
        with par('pipeline_103', join="all"):
            with repeat('load_090', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('load_body_089'):
                    wait_for('input_present_085', fact('input_present', material=job.material, location=job.input), timeout=seconds(30))
                    with seq('transfer_088'):
                        invoke('r1_transfer_material_086', R1, 'transfer_material', material=job.material, source=job.input, target=C1.entry)
                        invoke('r1_move_to_location_087', R1, 'move_to_location', target=R1.home)
            with repeat('middle_transport_094', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('middle_transport_body_093'):
                    wait_for('material_at_091', fact('material_at', material=job.material, location=C1.entry), timeout=seconds(30))
                    invoke('c1_transport_to_exit_092', C1, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
            with repeat('unload_102', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('unload_body_101'):
                    wait_for('material_at_095', fact('material_at', material=job.material, location=C1.exit), timeout=seconds(30))
                    with seq('transfer_098'):
                        invoke('r2_transfer_material_096', R2, 'transfer_material', material=job.material, source=C1.exit, target=C2.entry)
                        invoke('r2_move_to_location_097', R2, 'move_to_location', target=R2.home)
                    invoke('c2_transport_to_exit_099', C2, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
                    wait_for('output_departed_100', fact('output_departed', material=job.material, device=C2), timeout=seconds(30))
        wait_for('batch_goal_satisfied_104', fact('batch_goal_satisfied', specification="task-spec.json"), timeout=seconds(30))
