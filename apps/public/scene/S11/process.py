# 四件装夹焊接与转位下料
# 行为前后条件由契约自动处理；工艺只声明动作与协作关系。
with process('S11', version='ac-declarative/0.3'):
    with seq('batch_root'):
        with repeat('welding_batch_278', over=batch.jobs, bind='job', limit=batch.material_count):
            with seq('welding_batch_body_277'):
                invoke('r1_transfer_material_261', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=job.material, source=F1.work, target=W1.work))
                invoke('r1_move_to_location_262', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                invoke('w1_clamp_264', W1, 'clamp', material=job.material)
                invoke('w1_process_material_265', W1, 'process_material', material=job.material, recipe='welding')
                invoke('w1_unclamp_266', W1, 'unclamp', material=job.material)
                invoke('r1_transfer_material_268', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=job.material, source=W1.work, target=T1.slot1))
                invoke('r1_move_to_location_269', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                invoke('t1_index_to_angle_271', T1, 'rotate_to_station', angleTag=quantity(180.0, '°'))
                invoke('r1_transfer_material_272', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=job.material, source=T1.slot1, target=F1.work))
                invoke('r1_move_to_location_273', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                invoke('t1_index_to_angle_275', T1, 'rotate_to_station', angleTag=quantity(0.0, '°'))
