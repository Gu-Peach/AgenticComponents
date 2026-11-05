# 六件双机加工与单机器人互斥服务
# 双机加工并行，输入/输出分支并行，R1由契约资源仲裁互斥服务。
# 声明式控制图：通过专用前端检查，不作为Python脚本执行。
with process('S09', version="ac-declarative/0.1"):
    with seq('batch_246'):
        with par('dual_machine_244', join="all"):
            with repeat('infeed_213', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('infeed_body_212'):
                    wait_for('input_present_210', fact('input_present', material=job.material, location=job.input), timeout=seconds(30))
                    invoke('c1_transport_to_exit_211', C1, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
            with repeat('MC1_jobs_228', over=select(batch.jobs, machine=MC1), bind='job', limit=batch.material_count):
                with seq('MC1_jobs_body_227'):
                    wait_for('material_at_214', fact('material_at', material=job.material, location=C1.exit), timeout=seconds(30))
                    with seq('transfer_217'):
                        invoke('r1_transfer_material_215', R1, 'transfer_material', material=job.material, source=C1.exit, target=MC1.work)
                        invoke('r1_move_to_location_216', R1, 'move_to_location', target=R1.home)
                    with seq('processing_221'):
                        invoke('mc1_clamp_218', MC1, 'clamp', material=job.material)
                        invoke('mc1_process_material_219', MC1, 'process_material', material=job.material, recipe='machining_a')
                        invoke('mc1_unclamp_220', MC1, 'unclamp', material=job.material)
                    with seq('transfer_224'):
                        invoke('r1_transfer_material_222', R1, 'transfer_material', material=job.material, source=MC1.work, target=C2.entry)
                        invoke('r1_move_to_location_223', R1, 'move_to_location', target=R1.home)
                    invoke('c2_transport_to_exit_225', C2, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
                    wait_for('output_departed_226', fact('output_departed', material=job.material, device=C2), timeout=seconds(30))
            with repeat('MC2_jobs_243', over=select(batch.jobs, machine=MC2), bind='job', limit=batch.material_count):
                with seq('MC2_jobs_body_242'):
                    wait_for('material_at_229', fact('material_at', material=job.material, location=C1.exit), timeout=seconds(30))
                    with seq('transfer_232'):
                        invoke('r1_transfer_material_230', R1, 'transfer_material', material=job.material, source=C1.exit, target=MC2.work)
                        invoke('r1_move_to_location_231', R1, 'move_to_location', target=R1.home)
                    with seq('processing_236'):
                        invoke('mc2_clamp_233', MC2, 'clamp', material=job.material)
                        invoke('mc2_process_material_234', MC2, 'process_material', material=job.material, recipe='machining_b')
                        invoke('mc2_unclamp_235', MC2, 'unclamp', material=job.material)
                    with seq('transfer_239'):
                        invoke('r1_transfer_material_237', R1, 'transfer_material', material=job.material, source=MC2.work, target=C2.entry)
                        invoke('r1_move_to_location_238', R1, 'move_to_location', target=R1.home)
                    invoke('c2_transport_to_exit_240', C2, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
                    wait_for('output_departed_241', fact('output_departed', material=job.material, device=C2), timeout=seconds(30))
        wait_for('batch_goal_satisfied_245', fact('batch_goal_satisfied', specification="task-spec.json"), timeout=seconds(30))
