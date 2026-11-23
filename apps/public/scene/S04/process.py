# C1 直立输送；R1 抓瓶头并交给抓瓶底的 R2；C2 倒置输送。
with process('S04', version='ac-declarative/0.4', devices='./device', task=production(jobs=[
    {'id': 'J01', 'material': 'M01', 'prototype': 'Bottle', 'input': 'C1.entry', 'target': 'C2.exit'},
    {'id': 'J02', 'material': 'M02', 'prototype': 'Bottle', 'input': 'C1.entry', 'target': 'C2.exit'},
    {'id': 'J03', 'material': 'M03', 'prototype': 'Bottle', 'input': 'C1.entry', 'target': 'C2.exit'},
    {'id': 'J04', 'material': 'M04', 'prototype': 'Bottle', 'input': 'C1.entry', 'target': 'C2.exit'},
], pallets=[]), goal='./task-spec.json'):
    with repeat('bottles', over=task.jobs, bind='job', limit=task.material_count):
        with seq('transport_bottle'):
            invoke('upright_transport', C1, 'transport_to_position',
                   subject_id=subject_id(job.material), target=C1.exit)
            invoke('stop_infeed', C1, 'stop_conveying')
            invoke('head_to_tail_handoff', R1, 'pick_and_handoff',
                   payload=payload('R1.pick_and_handoff', material=job.material,
                                   source=C1.exit, target=R1.handoff, receiver=R2,
                                   giver_grasp='head', receiver_grasp='tail'))
            invoke('giver_home', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
            invoke('place_head_down', R2, 'place_held_material',
                   payload=payload('R2.place_held_material', material=job.material,
                                   target=C2.entry, grasp='tail'))
            invoke('receiver_home', R2, 'move_to_pose', payload=payload('R2.move_to_pose', target=R2.home))
            invoke('inverted_transport', C2, 'transport_to_position',
                   subject_id=subject_id(job.material), target=C2.exit)
            invoke('deliver_bottle', C2, 'release_material', subject_id=subject_id(job.material))
            invoke('stop_outfeed', C2, 'stop_conveying')
