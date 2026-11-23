# S03：六件入环输送与双机械臂出环流水

当前场景使用 [居中版 PM Closed Conveyor Loop](<Closed Conveyor Loop/PM Closed Conveyor Loop.centered.glb>)。以四条主线围成的环线中心在地面上的投影为原点，相对 [PM 原始导出](<Closed Conveyor Loop/PM Closed Conveyor Loop.glb>) 的世界平移量为 `(−1.098242, 0, +13.852509) m`。该变换保留设备相对位置及输送面高度。后续标注弯道圆心和上下料点时，请以居中版模型的场景坐标为准。

三个常驻有限分支并行：上料、中央输送、下料；由物料到位和容量约束衔接。

[process.py](process.py)采用ac-declarative/0.3，不含wait_for。机器人使用pick_and_place/move_to_pose；输送到站、实际停稳与出口交接分开调用；升降、转位采用契约参数及单位。



批次清单与task-spec未修改。binding声明了自动条件、身份、标定与载荷来源；这些仍待运行实现，executable=false。声明引用正确不等于运动可行或完成了并行实验。
