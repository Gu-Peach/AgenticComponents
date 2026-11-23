# 已装九件毛坯的托盘到达工位后，机械臂逐件送入机床并将成品放回原槽。
with process('S06', version='ac-declarative/0.4', devices='./device', task=production(carrier_template='Pallet', count=1), goal='./task-spec.json'):
    with seq('production_batch'):
        with repeat('pallets', over=task.pallets, bind='pallet', limit=task.pallet_count):
            with seq('machine_pallet'):
                invoke('index_to_station', C3, 'transport_to_position', subject_id=subject_id(pallet.id), target='C3.station')
                with repeat('workpieces', over=pallet.items, bind='item', limit=task.max_items_per_pallet):
                    with seq('machine_one'):
                        invoke('load_machine', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=item.material, source=item.source, target=MC1.work))
                        invoke('clear_machine', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                        invoke('machine_workpiece', MC1, 'machine_material', subject_id=subject_id(item.material))
                        invoke('return_to_slot', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=item.material, source=MC1.work, target=item.source))
                        invoke('return_home', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                invoke('index_to_exit', C3, 'transport_to_position', subject_id=subject_id(pallet.id), target='C3.exit')
                invoke('release_finished_pallet', C3, 'release_material', subject_id=subject_id(pallet.id))
                invoke('stop_mainline', C3, 'stop_conveying')
