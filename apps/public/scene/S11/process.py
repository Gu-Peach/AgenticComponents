# 单件占用转台；同一工装从人工侧到焊接侧，再沿正向返回人工侧。
with process('S11', version='ac-declarative/0.4', devices='./device', task=production(jobs=[
    {'id': 'J01', 'material': 'M01', 'prototype': 'Workpiece', 'input': 'F1.work', 'target': 'F1.work'},
    {'id': 'J02', 'material': 'M02', 'prototype': 'Workpiece', 'input': 'F1.work', 'target': 'F1.work'},
    {'id': 'J03', 'material': 'M03', 'prototype': 'Workpiece', 'input': 'F1.work', 'target': 'F1.work'},
    {'id': 'J04', 'material': 'M04', 'prototype': 'Workpiece', 'input': 'F1.work', 'target': 'F1.work'},
], pallets=[]), goal='./task-spec.json'):
    with repeat('workpieces', over=task.jobs, bind='job', limit=task.material_count):
        with seq('weld_one'):
            invoke('load_fixture', H1, 'carry_material',
                   payload=payload('H1.carry_material', material=job.material, source=job.input,
                                   target=T1.slot1, grasp='handle'))
            invoke('index_to_robot', T1, 'rotate_to_station', angleTag=quantity(180, '°'))
            invoke('weld_and_retreat', R1, 'process_material',
                   payload=payload('R1.process_material', material=job.material, station=T1.slot1,
                                   tool='torch', process='weld'))
            invoke('index_to_operator', T1, 'rotate_to_station', angleTag=quantity(0, '°'))
            invoke('unload_fixture', H1, 'carry_material',
                   payload=payload('H1.carry_material', material=job.material, source=T1.slot1,
                                   target=job.target, grasp='handle'))
