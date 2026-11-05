# 四件分度台批次与前后段流水
# 输入输送、转位单元和输出输送并行；转位单元内部按工步串行并确认退位。
# 声明式控制图：通过专用前端检查，不作为Python脚本执行。
with process('S06', version="ac-declarative/0.1"):
    with seq('batch_151'):
        with par('table_pipeline_149', join="all"):
            with repeat('infeed_143', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('infeed_body_142'):
                    wait_for('input_present_140', fact('input_present', material=job.material, location=job.input), timeout=seconds(30))
                    invoke('c1_transport_to_exit_141', C1, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
            with repeat('table_cell_139', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('table_cell_body_138'):
                    wait_for('material_at_129', fact('material_at', material=job.material, location=C1.exit), timeout=seconds(30))
                    with seq('transfer_132'):
                        invoke('r1_transfer_material_130', R1, 'transfer_material', material=job.material, source=C1.exit, target=T1.slot1)
                        invoke('r1_move_to_location_131', R1, 'move_to_location', target=R1.home)
                    invoke('t1_index_to_angle_133', T1, 'index_to_angle', angle=quantity(3.141592653589793, "rad"))
                    with seq('transfer_136'):
                        invoke('r2_transfer_material_134', R2, 'transfer_material', material=job.material, source=T1.slot1, target=C3.entry)
                        invoke('r2_move_to_location_135', R2, 'move_to_location', target=R2.home)
                    invoke('t1_index_to_angle_137', T1, 'index_to_angle', angle=quantity(0, "rad"))
            with repeat('output_148', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('output_body_147'):
                    wait_for('material_at_144', fact('material_at', material=job.material, location=C3.entry), timeout=seconds(30))
                    invoke('c3_transport_to_exit_145', C3, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
                    wait_for('output_departed_146', fact('output_departed', material=job.material, device=C3), timeout=seconds(30))
        wait_for('batch_goal_satisfied_150', fact('batch_goal_satisfied', specification="task-spec.json"), timeout=seconds(30))
