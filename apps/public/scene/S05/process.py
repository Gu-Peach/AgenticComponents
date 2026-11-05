# 四件双机器人去毛刺闭环
# 行为前后条件由契约自动处理；工艺只声明动作与协作关系。
with process('S05', version='ac-declarative/0.3'):
    with seq('batch_root'):
        with repeat('shared_return_lane_126', over=batch.jobs, bind='job', limit=batch.material_count):
            with seq('shared_return_lane_body_125'):
                invoke('c1_transport_to_exit_110', C1, 'transport_to_exit', subject_id=subject_id(job.material))
                invoke('c1_transport_to_exit_110_stop', C1, 'stop_conveying')
                invoke('r1_transfer_material_111', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=job.material, source=C1.exit, target=F1.work))
                invoke('r1_move_to_location_112', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                invoke('r2_transfer_material_114', R2, 'pick_and_place', payload=payload('R2.pick_and_place', material=job.material, source=F1.work, target=D1.work))
                invoke('r2_move_to_location_115', R2, 'move_to_pose', payload=payload('R2.move_to_pose', target=R2.home))
                invoke('d1_clamp_117', D1, 'clamp', material=job.material)
                invoke('d1_process_material_118', D1, 'process_material', material=job.material, recipe='deburr')
                with branch('planned_rework_108', mode='exclusive', timeout=seconds(30)):
                    with case(eq(job.rework_required, True)):
                        invoke('d1_process_material_106', D1, 'process_material', material=job.material, recipe='deburr')
                    with otherwise():
                        delay('no_rework_107', seconds(0))
                invoke('d1_unclamp_119', D1, 'unclamp', material=job.material)
                invoke('r2_transfer_material_120', R2, 'pick_and_place', payload=payload('R2.pick_and_place', material=job.material, source=D1.work, target=C1.entry))
                invoke('r2_move_to_location_121', R2, 'move_to_pose', payload=payload('R2.move_to_pose', target=R2.home))
                invoke('c1_transport_to_exit_123', C1, 'transport_to_exit', subject_id=subject_id(job.material))
                invoke('c1_transport_to_exit_123_stop', C1, 'stop_conveying')
                invoke('output_departed_124_release', C1, 'release_material', subject_id=subject_id(job.material))
                invoke('output_departed_124_stop', C1, 'stop_conveying')
