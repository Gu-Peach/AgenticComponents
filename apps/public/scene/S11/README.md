# S11：四件装夹焊接与转位下料

共用装卸台和回转单元，按有限订单串行完成焊接、转位和下料。

[process.py](process.py)采用ac-declarative/0.3，不含wait_for。机器人使用pick_and_place/move_to_pose；输送到站、实际停稳与出口交接分开调用；升降、转位采用契约参数及单位。

加工行为引用processing_station现有实验定义，仍明确拒绝按标准DeviceSpec执行。

载具换盘/批组或共用进出料位置的外部交接，登记为循环自动准入与收尾义务；提供者未实现时阻塞，不跳过。

F1.work作为外部供料/接料位置使用，不调用物料源行为冒充末端移除服务。

批次清单与task-spec未修改。binding声明了自动条件、身份、标定与载荷来源；这些仍待运行实现，executable=false。声明引用正确不等于运动可行或完成了并行实验。
