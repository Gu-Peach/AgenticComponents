# 四件双机器人去毛刺闭环
# 共享进出料线的有界逐件循环，按订单返工标记显式分支；不把等待或额外工序隐含在脚本函数里。
# 声明式控制图：通过专用前端检查，不作为Python脚本执行。
with process('S05', version="ac-declarative/0.1"):
    with seq('batch_128'):
        with repeat('shared_return_lane_126', over=batch.jobs, bind='job', limit=batch.material_count):
            with seq('shared_return_lane_body_125'):
                wait_for('input_present_109', fact('input_present', material=job.material, location=job.input), timeout=seconds(30))
                invoke('c1_transport_to_exit_110', C1, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
                with seq('transfer_113'):
                    invoke('r1_transfer_material_111', R1, 'transfer_material', material=job.material, source=C1.exit, target=F1.work)
                    invoke('r1_move_to_location_112', R1, 'move_to_location', target=R1.home)
                with seq('transfer_116'):
                    invoke('r2_transfer_material_114', R2, 'transfer_material', material=job.material, source=F1.work, target=D1.work)
                    invoke('r2_move_to_location_115', R2, 'move_to_location', target=R2.home)
                invoke('d1_clamp_117', D1, 'clamp', material=job.material)
                invoke('d1_process_material_118', D1, 'process_material', material=job.material, recipe="deburr")
                with branch('planned_rework_108', mode="exclusive", timeout=seconds(30)):
                    with case(eq(job.rework_required, True)):
                        invoke('d1_process_material_106', D1, 'process_material', material=job.material, recipe="deburr")
                    with otherwise():
                        delay('no_rework_107', seconds(0))
                invoke('d1_unclamp_119', D1, 'unclamp', material=job.material)
                with seq('transfer_122'):
                    invoke('r2_transfer_material_120', R2, 'transfer_material', material=job.material, source=D1.work, target=C1.entry)
                    invoke('r2_move_to_location_121', R2, 'move_to_location', target=R2.home)
                invoke('c1_transport_to_exit_123', C1, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
                wait_for('output_departed_124', fact('output_departed', material=job.material, device=C1), timeout=seconds(30))
        wait_for('batch_goal_satisfied_127', fact('batch_goal_satisfied', specification="task-spec.json"), timeout=seconds(30))
