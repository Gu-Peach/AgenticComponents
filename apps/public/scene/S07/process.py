# Named-target DSL; warehouse.virtual-linear@1 is an explicit candidate simulation profile.
with process('S07', version='ac-declarative/0.4', devices='./device', task=production(jobs=[{'id': 'J01', 'material': 'M01', 'prototype': 'Workpiece', 'input': 'C1.entry', 'slot': 'STORE.slot1', 'target': 'C2.exit'}, {'id': 'J02', 'material': 'M02', 'prototype': 'Workpiece', 'input': 'C1.entry', 'slot': 'STORE.slot2', 'target': 'C2.exit'}, {'id': 'J03', 'material': 'M03', 'prototype': 'Workpiece', 'input': 'C1.entry', 'slot': 'STORE.slot3', 'target': 'C2.exit'}, {'id': 'J04', 'material': 'M04', 'prototype': 'Workpiece', 'input': 'C1.entry', 'slot': 'STORE.slot4', 'target': 'C2.exit'}], pallets=[]), goal='./task-spec.json'):
    with seq('warehouse'):
        with repeat('store_orders', over=task.jobs, bind='job', limit=task.material_count):
            with seq('store_one'):
                invoke('infeed_to_exit', C1, 'transport_to_exit', subject_id=subject_id(job.material))
                invoke('infeed_stop', C1, 'stop_conveying')
                invoke('inbound_rail_to_dock', T1, 'move_to_location', target=C1.exit)
                invoke('inbound_lift_to_dock', L1, 'lift_to_location', target=C1.exit)
                invoke('load_inbound_lift', L1, 'accept_material', payload=payload('L1.accept_material', material=job.material, source=C1.exit))
                invoke('inbound_rail_to_slot', T1, 'move_to_location', target=job.slot)
                invoke('inbound_lift_to_slot', L1, 'lift_to_location', target=job.slot)
                invoke('store_material', L1, 'release_material', payload=payload('L1.release_material', material=job.material, target=job.slot))
        with repeat('retrieve_orders', over=task.jobs, bind='job', limit=task.material_count):
            with seq('retrieve_one'):
                invoke('outbound_rail_to_slot', T2, 'move_to_location', target=job.slot)
                invoke('outbound_lift_to_slot', L2, 'lift_to_location', target=job.slot)
                invoke('retrieve_material', L2, 'accept_material', payload=payload('L2.accept_material', material=job.material, source=job.slot))
                invoke('outbound_rail_to_dock', T2, 'move_to_location', target=C2.entry)
                invoke('outbound_lift_to_dock', L2, 'lift_to_location', target=C2.entry)
                invoke('unload_outbound_lift', L2, 'release_material', payload=payload('L2.release_material', material=job.material, target=C2.entry))
                invoke('outfeed_to_exit', C2, 'transport_to_exit', subject_id=subject_id(job.material))
                invoke('outfeed_release', C2, 'release_material', subject_id=subject_id(job.material))
                invoke('outfeed_stop', C2, 'stop_conveying')
