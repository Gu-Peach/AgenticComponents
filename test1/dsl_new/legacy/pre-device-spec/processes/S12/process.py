# 四件双侧加工与转位交接流水
# 两侧加工、转位交接、进出料分支并行；同机器人及转台互锁由契约派生。
# 声明式控制图：通过专用前端检查，不作为Python脚本执行。
with process('S12', version="ac-declarative/0.1"):
    with seq('batch_324'):
        with par('two_sided_pipeline_322', join="all"):
            with repeat('infeed_316', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('infeed_body_315'):
                    wait_for('input_present_313', fact('input_present', material=job.material, location=job.input), timeout=seconds(30))
                    invoke('c1_transport_to_exit_314', C1, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
            with repeat('side_a_290', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('side_a_body_289'):
                    wait_for('material_at_281', fact('material_at', material=job.material, location=C1.exit), timeout=seconds(30))
                    with seq('transfer_284'):
                        invoke('r1_transfer_material_282', R1, 'transfer_material', material=job.material, source=C1.exit, target=PS1.work)
                        invoke('r1_move_to_location_283', R1, 'move_to_location', target=R1.home)
                    with seq('processing_288'):
                        invoke('ps1_clamp_285', PS1, 'clamp', material=job.material)
                        invoke('ps1_process_material_286', PS1, 'process_material', material=job.material, recipe='side_a')
                        invoke('ps1_unclamp_287', PS1, 'unclamp', material=job.material)
            with repeat('rotary_handoff_302', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('rotary_handoff_body_301'):
                    wait_for('operation_completed_291', fact('operation_completed', material=job.material, station=PS1, recipe="side_a"), timeout=seconds(30))
                    wait_for('subject_unclamped_292', fact('subject_unclamped', material=job.material, station=PS1), timeout=seconds(30))
                    with seq('transfer_295'):
                        invoke('r1_transfer_material_293', R1, 'transfer_material', material=job.material, source=PS1.work, target=T1.slot1)
                        invoke('r1_move_to_location_294', R1, 'move_to_location', target=R1.home)
                    invoke('t1_index_to_angle_296', T1, 'index_to_angle', angle=quantity(3.141592653589793, "rad"))
                    with seq('transfer_299'):
                        invoke('r2_transfer_material_297', R2, 'transfer_material', material=job.material, source=T1.slot1, target=PS2.work)
                        invoke('r2_move_to_location_298', R2, 'move_to_location', target=R2.home)
                    invoke('t1_index_to_angle_300', T1, 'index_to_angle', angle=quantity(0, "rad"))
            with repeat('side_b_312', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('side_b_body_311'):
                    wait_for('material_at_303', fact('material_at', material=job.material, location=PS2.work), timeout=seconds(30))
                    with seq('processing_307'):
                        invoke('ps2_clamp_304', PS2, 'clamp', material=job.material)
                        invoke('ps2_process_material_305', PS2, 'process_material', material=job.material, recipe='side_b')
                        invoke('ps2_unclamp_306', PS2, 'unclamp', material=job.material)
                    with seq('transfer_310'):
                        invoke('r2_transfer_material_308', R2, 'transfer_material', material=job.material, source=PS2.work, target=C2.entry)
                        invoke('r2_move_to_location_309', R2, 'move_to_location', target=R2.home)
            with repeat('outfeed_321', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('outfeed_body_320'):
                    wait_for('material_at_317', fact('material_at', material=job.material, location=C2.entry), timeout=seconds(30))
                    invoke('c2_transport_to_exit_318', C2, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
                    wait_for('output_departed_319', fact('output_departed', material=job.material, device=C2), timeout=seconds(30))
        wait_for('batch_goal_satisfied_323', fact('batch_goal_satisfied', specification="task-spec.json"), timeout=seconds(30))
