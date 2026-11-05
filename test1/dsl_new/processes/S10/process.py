# 三托盘各四件的批次码垛与换盘
# 行为前后条件由契约自动处理；工艺只声明动作与协作关系。
with process('S10', version='ac-declarative/0.3'):
    with seq('batch_root'):
        with repeat('pallet_orders_257', over=batch.pallets, bind='pallet', limit=batch.pallet_count):
            with repeat('fill_slots_253', over=pallet.items, bind='item', limit=batch.max_items_per_pallet):
                with seq('fill_slots_body_252'):
                    invoke('c1_transport_to_exit_248', C1, 'transport_to_exit', subject_id=subject_id(item.material))
                    invoke('c1_transport_to_exit_248_stop', C1, 'stop_conveying')
                    invoke('r1_transfer_material_249', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=item.material, source=C1.exit, target=item.target))
                    invoke('r1_move_to_location_250', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
