# 四件L形加工工位流水
# 入口输送、单机上下料加工、出口输送三个分支并行；单机工步内部顺序执行。
# 声明式控制图：通过专用前端检查，不作为Python脚本执行。
with process('S08', version="ac-declarative/0.1"):
    with seq('batch_209'):
        with par('machining_pipeline_207', join="all"):
            with repeat('infeed_188', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('infeed_body_187'):
                    wait_for('input_present_185', fact('input_present', material=job.material, location=job.input), timeout=seconds(30))
                    invoke('c1_transport_to_exit_186', C1, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
            with repeat('machine_cell_201', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('machine_cell_body_200'):
                    wait_for('material_at_189', fact('material_at', material=job.material, location=C1.exit), timeout=seconds(30))
                    with seq('transfer_192'):
                        invoke('r1_transfer_material_190', R1, 'transfer_material', material=job.material, source=C1.exit, target=MC1.work)
                        invoke('r1_move_to_location_191', R1, 'move_to_location', target=R1.home)
                    with seq('processing_196'):
                        invoke('mc1_clamp_193', MC1, 'clamp', material=job.material)
                        invoke('mc1_process_material_194', MC1, 'process_material', material=job.material, recipe='machining')
                        invoke('mc1_unclamp_195', MC1, 'unclamp', material=job.material)
                    with seq('transfer_199'):
                        invoke('r1_transfer_material_197', R1, 'transfer_material', material=job.material, source=MC1.work, target=C2.entry)
                        invoke('r1_move_to_location_198', R1, 'move_to_location', target=R1.home)
            with repeat('outfeed_206', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('outfeed_body_205'):
                    wait_for('material_at_202', fact('material_at', material=job.material, location=C2.entry), timeout=seconds(30))
                    invoke('c2_transport_to_exit_203', C2, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
                    wait_for('output_departed_204', fact('output_departed', material=job.material, device=C2), timeout=seconds(30))
        wait_for('batch_goal_satisfied_208', fact('batch_goal_satisfied', specification="task-spec.json"), timeout=seconds(30))
