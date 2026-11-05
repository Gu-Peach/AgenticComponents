# 四件分层入库后按订单出库
# 行为前后条件由契约自动处理；工艺只声明动作与协作关系。
with process('S07', version='ac-declarative/0.3'):
    with seq('warehouse_182'):
        with repeat('store_orders_164', over=batch.jobs, bind='job', limit=batch.material_count):
            with seq('store_orders_body_163'):
                invoke('c1_transport_to_exit_153', C1, 'transport_to_exit', subject_id=subject_id(job.material))
                invoke('c1_transport_to_exit_153_stop', C1, 'stop_conveying')
                invoke('l1_move_to_height_154', L1, 'lift_to_level', move_to_level=quantity(0, 'm'))
                invoke('x1_transfer_material_155', X1, 'pick_and_place', payload=payload('X1.pick_and_place', material=job.material, source=C1.exit, target=L1.work))
                invoke('x1_move_to_location_156', X1, 'move_to_pose', payload=payload('X1.move_to_pose', target=X1.home))
                invoke('l1_move_to_height_158', L1, 'lift_to_level', move_to_level=quantity(job.height, 'm'))
                invoke('x1_transfer_material_159', X1, 'pick_and_place', payload=payload('X1.pick_and_place', material=job.material, source=L1.work, target=job.slot))
                invoke('x1_move_to_location_160', X1, 'move_to_pose', payload=payload('X1.move_to_pose', target=X1.home))
                invoke('l1_move_to_height_162', L1, 'lift_to_level', move_to_level=quantity(0, 'm'))
        with par('retrieve_and_outfeed_181', join='all'):
            with repeat('retrieve_orders_174', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('retrieve_orders_body_173'):
                    invoke('l2_move_to_height_165', L2, 'lift_to_level', move_to_level=quantity(job.height, 'm'))
                    invoke('x1_transfer_material_166', X1, 'pick_and_place', payload=payload('X1.pick_and_place', material=job.material, source=job.slot, target=L2.work))
                    invoke('x1_move_to_location_167', X1, 'move_to_pose', payload=payload('X1.move_to_pose', target=X1.home))
                    invoke('l2_move_to_height_169', L2, 'lift_to_level', move_to_level=quantity(0, 'm'))
                    invoke('x1_transfer_material_170', X1, 'pick_and_place', payload=payload('X1.pick_and_place', material=job.material, source=L2.work, target=C2.entry))
                    invoke('x1_move_to_location_171', X1, 'move_to_pose', payload=payload('X1.move_to_pose', target=X1.home))
            with repeat('outfeed_180', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('outfeed_body_179'):
                    invoke('c2_transport_to_exit_177', C2, 'transport_to_exit', subject_id=subject_id(job.material))
                    invoke('c2_transport_to_exit_177_stop', C2, 'stop_conveying')
                    invoke('output_departed_178_release', C2, 'release_material', subject_id=subject_id(job.material))
                    invoke('output_departed_178_stop', C2, 'stop_conveying')
