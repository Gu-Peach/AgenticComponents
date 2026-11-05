# 四件装夹焊接与转位下料
# 共用装卸台和回转单元，按有限订单串行完成焊接、转位和下料。
# 声明式控制图：通过专用前端检查，不作为Python脚本执行。
with process('S11', version="ac-declarative/0.1"):
    with seq('batch_280'):
        with repeat('welding_batch_278', over=batch.jobs, bind='job', limit=batch.material_count):
            with seq('welding_batch_body_277'):
                wait_for('input_present_260', fact('input_present', material=job.material, location=job.input), timeout=seconds(30))
                with seq('transfer_263'):
                    invoke('r1_transfer_material_261', R1, 'transfer_material', material=job.material, source=F1.work, target=W1.work)
                    invoke('r1_move_to_location_262', R1, 'move_to_location', target=R1.home)
                with seq('processing_267'):
                    invoke('w1_clamp_264', W1, 'clamp', material=job.material)
                    invoke('w1_process_material_265', W1, 'process_material', material=job.material, recipe='welding')
                    invoke('w1_unclamp_266', W1, 'unclamp', material=job.material)
                with seq('transfer_270'):
                    invoke('r1_transfer_material_268', R1, 'transfer_material', material=job.material, source=W1.work, target=T1.slot1)
                    invoke('r1_move_to_location_269', R1, 'move_to_location', target=R1.home)
                invoke('t1_index_to_angle_271', T1, 'index_to_angle', angle=quantity(3.141592653589793, "rad"))
                with seq('transfer_274'):
                    invoke('r1_transfer_material_272', R1, 'transfer_material', material=job.material, source=T1.slot1, target=F1.work)
                    invoke('r1_move_to_location_273', R1, 'move_to_location', target=R1.home)
                invoke('t1_index_to_angle_275', T1, 'index_to_angle', angle=quantity(0, "rad"))
                wait_for('output_departed_276', fact('output_departed', material=job.material, device=F1), timeout=seconds(30))
        wait_for('batch_goal_satisfied_279', fact('batch_goal_satisfied', specification="task-spec.json"), timeout=seconds(30))
