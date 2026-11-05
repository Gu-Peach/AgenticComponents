# 契约负责执行前检查、持续互锁和完成确认；DSL只描述动作及协作关系。
with process("S01", version="ac-declarative/0.3"):
    with seq("batch_001"):
        with repeat("line_cycles_002", count=batch.pallet_count + 2):
            with seq("line_cycle_003"):
                invoke("line_advance_005", C1, "move_by_distance",
                       distance_m=calibration(C1, "pitch_m"))

                with par("station_work_008", join="all"):
                    with repeat("items_A_011", over=items_at(C1.station1, category="A"), bind="a", limit=batch.max_items_per_pallet):
                        with seq("item_A_012"):
                            invoke("pick_place_A_013", R1, "pick_and_place",
                                   payload=payload("R1.pick_and_place", material=a.material, source=a.source, target=C2.entry))
                            invoke("retreat_A_014", R1, "move_to_pose",
                                   payload=payload("R1.move_to_pose", target=R1.home))
                            invoke("outfeed_A_015", C2, "transport_to_exit", subject_id=subject_id(a.material))
                            invoke("handoff_A_018", C2, "release_material", subject_id=subject_id(a.material))
                            invoke("stop_A_019", C2, "stop_conveying")

                    with repeat("items_B_021", over=items_at(C1.station2, category="B"), bind="b", limit=batch.max_items_per_pallet):
                        with seq("item_B_022"):
                            invoke("pick_place_B_023", R2, "pick_and_place",
                                   payload=payload("R2.pick_and_place", material=b.material, source=b.source, target=C3.entry))
                            invoke("retreat_B_024", R2, "move_to_pose",
                                   payload=payload("R2.move_to_pose", target=R2.home))
                            invoke("outfeed_B_025", C3, "transport_to_exit", subject_id=subject_id(b.material))
                            invoke("handoff_B_028", C3, "release_material", subject_id=subject_id(b.material))
                            invoke("stop_B_029", C3, "stop_conveying")
