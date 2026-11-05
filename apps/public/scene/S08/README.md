# S08：四件L形加工工位流水

入口输送、单机上下料加工、出口输送三个分支并行；单机工步内部顺序执行。

[process.py](process.py)采用ac-declarative/0.3，不含wait_for。机器人使用pick_and_place/move_to_pose；输送到站、实际停稳与出口交接分开调用；升降、转位采用契约参数及单位。

加工行为引用processing_station现有实验定义，仍明确拒绝按标准DeviceSpec执行。

批次清单与task-spec未修改。binding声明了自动条件、身份、标定与载荷来源；这些仍待运行实现，executable=false。声明引用正确不等于运动可行或完成了并行实验。
