# 主线由C2的组协调行为同时控制C1/C2；位置来自scene.sorting和C2.exit，不再手填行程。
with process('S01', version='ac-declarative/0.4', devices='./device', task=production(carrier_template='Pallet', count=3), goal='./task-spec.json'):
    with seq('batch'):
        with repeat('pallet_cycles', over=task.pallets, bind='pallet', limit=task.pallet_count):
            with seq('pallet_cycle'):
                invoke('mainline_to_work', C2, 'transport_to_position', subject_id=subject_id(pallet.id), target='scene.sorting')
                with par('sort_pallet', join='all'):
                    with repeat('gray_items', over=select(pallet.items, category='A'), bind='gray', limit=task.max_items_per_pallet):
                        with seq('gray_item'):
                            invoke('R1_pick_place', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=gray.material, source=gray.source, target=C4.entry))
                            invoke('R1_retreat', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                            invoke('C4_transport', C4, 'transport_to_exit', subject_id=subject_id(gray.material))
                            invoke('C4_release', C4, 'release_material', subject_id=subject_id(gray.material))
                            invoke('C4_stop', C4, 'stop_conveying')
                    with repeat('brown_items', over=select(pallet.items, category='B'), bind='brown', limit=task.max_items_per_pallet):
                        with seq('brown_item'):
                            invoke('R2_pick_place', R2, 'pick_and_place', payload=payload('R2.pick_and_place', material=brown.material, source=brown.source, target=C3.entry))
                            invoke('R2_retreat', R2, 'move_to_pose', payload=payload('R2.move_to_pose', target=R2.home))
                            invoke('C3_transport', C3, 'transport_to_exit', subject_id=subject_id(brown.material))
                            invoke('C3_release', C3, 'release_material', subject_id=subject_id(brown.material))
                            invoke('C3_stop', C3, 'stop_conveying')
                invoke('mainline_to_exit', C2, 'transport_to_position', subject_id=subject_id(pallet.id), target='C2.exit')
