# S06：四件分度台批次与前后段流水

输入输送、转位单元和输出输送并行；转位单元内部按工步串行并确认退位。

[process.py](process.py)采用ac-declarative/0.3，不含wait_for。机器人使用pick_and_place/move_to_pose；输送到站、实际停稳与出口交接分开调用；升降、转位采用契约参数及单位。



批次清单与task-spec未修改。binding声明了自动条件、身份、标定与载荷来源；这些仍待运行实现，executable=false。声明引用正确不等于运动可行或完成了并行实验。
