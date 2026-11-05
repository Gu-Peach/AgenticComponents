# S01：三托盘分类拆垛

[process.py](process.py)使用ac-declarative/0.3，只有动作和协作控制结构，没有wait_for。源码由DSL前端解析，不能直接当Python脚本执行。

每拍先调用C1.move_by_distance，传入标定节距；契约确认实际到位并停稳后，两个工位并行。R1处理第一工位托盘的A类，R2处理第二工位托盘的B类。每件物料依次取放、机械臂退位、运输至绿色线出口、交给下游、停止出料线。全部分支完成才进入下一拍。

| 目的 | 契约行为 |
| --- | --- |
| 主线前进并停稳 | conveyor.move_by_distance |
| 机械臂取放 | robot_arm.pick_and_place |
| 机械臂退位 | robot_arm.move_to_pose |
| 输送至出口 | conveyor.transport_to_exit |
| 下游接收 | conveyor.release_material |
| 出料线停止 | conveyor.stop_conveying |

move_by_distance已补入docs/schema.md及传送带契约1.1.0，带有distance_m标量参数和target_distance信号。它是待实现的可选复合行为，不是把start_conveying直接当作有限动作。编码器行程、真实载荷位置、支承和停稳必须同时验证。

calibration(C1,"pitch_m")读取标定节距，目前为null，运行前必须标定。subject_id读取冻结身份表，给已有运输/交接契约传DINT编号。payload仅说明机器人单次动作对象及目标，具体模型编码仍待适配。

前置、持续、完成条件由契约自动导入，bindings.condition_bindings提供对应实例信号和观测来源。items_at自动检查快照有效性；未知库存不能当空集合。流程结束后自动按process_contract核对未改动的task-spec.json，最后一盘实际离开前不报告整批成功。

三盘十二件，共五拍：P01/A → P02/A与P01/B → P03/A与P02/B → P03/B → 最后一盘出线。第二、第三拍两台机械臂处理不同托盘。供盘、出口移走、空间互锁仍须真实观测，未从物理场景验证几何、节距与制动。

```powershell
python -B tools/compile_declarative.py processes/S01/process.py
python -B tools/check_flows.py
python -B -m unittest discover -s tests -p "test_*.py"
```

声明引用校验与运行分开。检查报告含automatic_obligations；模型载荷、条件提供者、标定及调度仍待实现，contract_binding_valid=false、executable=false。
